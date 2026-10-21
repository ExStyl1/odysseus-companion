# -*- coding: utf-8 -*-
"""Layout preview to PNG — visual check without PowerPoint or browser.

Draws with Pillow the same box tree that goes into PPTX: backgrounds, gradients,
rounded corners, images and text with the same fonts at the same coordinates.

Check boundary: preview confirms that layout and render are consistent and that
everything on the slide is in place. It does not compare the result with a
browser — no layout engine is at hand, and it is not needed: this layout is
what goes into the PPTX.
"""
import logging
import math
import os
import re
import shutil
import tempfile

import numpy as np
from PIL import Image, ImageChops, ImageDraw

from .html2pptx.boxdeco import (inset_shadow_layer, outer_shadow_layer,
                                rounded_mask)
from .html2pptx.document import Document
from .html2pptx.layout import SLIDE_H, SLIDE_W
from .html2pptx import values as V
from .html2pptx.paint import (PaintError, PaintTarget, TextStyle, background_source,
                              paint_slide, picture_placement, picture_source)
from .html2pptx.formula import MathRun, math_metrics
from .html2pptx.textmeasure import DEFAULT_FAMILY

log = logging.getLogger(__name__)


def gradient_image(width, height, grad):
    """Linear CSS gradient as RGBA array."""
    width, height = max(1, int(width)), max(1, int(height))
    angle = np.deg2rad(grad.angle_for(width, height))
    # In CSS 0deg is bottom to top, axis grows clockwise.
    dx, dy = np.sin(angle), -np.cos(angle)
    xs = (np.arange(width) - width / 2.0)[None, :]
    ys = (np.arange(height) - height / 2.0)[:, None]
    proj = xs * dx + ys * dy
    span = abs(width * dx) + abs(height * dy)
    t = np.clip((proj + span / 2.0) / max(span, 1e-6), 0.0, 1.0)

    stops = grad.stops
    out = np.zeros((height, width, 4), dtype=np.float64)
    positions = [s[0] for s in stops]
    for channel in range(3):
        out[:, :, channel] = np.interp(t, positions, [s[1][channel] for s in stops])
    out[:, :, 3] = np.interp(t, positions, [s[1][3] * 255 for s in stops])
    return Image.fromarray(out.astype(np.uint8), 'RGBA')


# Supersampling factor for chart shapes; see `Preview.chart`.
_CHART_SS = 3

_SUPERSCRIPT_DIGITS = dict(zip('⁰¹²³⁴⁵⁶⁷⁸⁹', '0123456789'))
_SUPERSCRIPT_RE = re.compile('[⁰¹²³⁴⁵⁶⁷⁸⁹]')


def _draw_prose(draw, xy, text, font, fill):
    """Raster fallback for missing superscript digits, within measured slots.

    The shipped face has native 1/2/3 only. Reuse its own ordinary digits in
    the native superscript ink band; leave layout and the editable PPTX alone.
    """
    missing = []
    if (font.adv is not None and font.adv.ok
            and ord('³') in font.adv.widths):
        missing = [match for match in _SUPERSCRIPT_RE.finditer(text)
                   if ord(match.group()) not in font.adv.widths
                   and ord(_SUPERSCRIPT_DIGITS[match.group()]) in font.adv.widths]
    if not missing:
        draw.text(xy, text, font=font.pil, fill=fill, anchor='ls')
        return
    x, baseline = xy
    # Rasterize above tiny text sizes so a superscript still has an ink band.
    large = font.pil.font_variant(size=max(32, font.pil.size * 3))
    scale = font.pil.size / large.size
    native = font.pil.getmask('³', mode='L')
    band = native.getbbox()
    if band is not None:
        height = band[3] - band[1]
        top = baseline + font.pil.getbbox('³', anchor='ls')[1] + band[1]
    else:
        band = large.getmask('³', mode='L').getbbox()
        height = max(1, round((band[3] - band[1]) * scale))
        top = baseline + round((large.getbbox('³', anchor='ls')[1] + band[1]) * scale)
    start = 0
    for match in missing:
        if start < match.start():
            draw.text((x + font.getlength(text[:start]), baseline),
                      text[start:match.start()], font=font.pil,
                      fill=fill, anchor='ls')
        char = match.group()
        glyph = large.getmask(_SUPERSCRIPT_DIGITS[char], mode='L')
        ink = Image.frombytes('L', glyph.size, bytes(glyph)).crop(glyph.getbbox())
        advance = font.getlength(char)
        width = max(1, min(int(round(advance)),
                           int(round(ink.width * height / ink.height))))
        ink = ink.resize((width, height), Image.LANCZOS)
        left = x + font.getlength(text[:match.start()]) + (advance - width) / 2
        draw.bitmap((round(left), round(top)), ink, fill=fill)
        start = match.end()
    if start < len(text):
        draw.text((x + font.getlength(text[:start]), baseline), text[start:],
                  font=font.pil, fill=fill, anchor='ls')


def _rgba(hex_, alpha=1.0):
    """`RRGGBB` (+ alpha 0..1) → a Pillow RGBA tuple."""
    value = hex_.lstrip('#')
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16),
            int(round(alpha * 255)))


def _gradient_into(layer, mask, box, gradient):
    """Paint a chart fill's `Palette.gradient` into `layer` where `mask` is
    set: stops along `degrees` clockwise from left to right across `box`
    (x0, y0, x1, y1), as a:lin with scaled="0" reads them."""
    stops, degrees = gradient
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    w, h = max(1, x1 - x0), max(1, y1 - y0)
    angle = np.deg2rad(degrees)
    dx, dy = np.cos(angle), np.sin(angle)
    xs = (np.arange(w) - w / 2.0)[None, :]
    ys = (np.arange(h) - h / 2.0)[:, None]
    span = abs(w * dx) + abs(h * dy)
    t = np.clip((xs * dx + ys * dy + span / 2.0) / max(span, 1e-6), 0.0, 1.0)
    out = np.zeros((h, w, 4), dtype=np.float64)
    positions = [p for p, _ in stops]
    for channel in range(3):
        out[:, :, channel] = np.interp(
            t, positions, [int(c[2 * channel:2 * channel + 2], 16)
                           for _, c in stops])
    out[:, :, 3] = 255
    fill = Image.new('RGBA', layer.size, (0, 0, 0, 0))
    fill.paste(Image.fromarray(out.astype(np.uint8), 'RGBA'), (x0, y0))
    fill.putalpha(ImageChops.multiply(fill.getchannel('A'), mask))
    layer.alpha_composite(fill)


def _rect_of(box):
    """Box geometry rounded to whole pixels, or None if it has no area."""
    w, h = int(round(box.w)), int(round(box.h))
    if w <= 0 or h <= 0:
        return None
    return int(round(box.x)), int(round(box.y)), w, h


def _outline_mask(w, h, outline, ss=4):
    """A `clip-path: path()` as an anti-aliased mask the size of the box."""
    return rounded_mask(w * ss, h * ss, 0, outline, ss).resize((w, h), Image.LANCZOS)


class Preview(PaintTarget):
    """The Pillow side of the paint interface.

    Everything is a bitmap here, so the medium-specific work is the opposite of
    the PPTX writer's: gradients are interpolated pixel by pixel instead of
    being handed over as stops, and text is drawn from a baseline against a
    pixel cursor because Pillow has no paragraph engine.
    """

    def __init__(self, assets, fonts):
        self.assets = assets
        self.fonts = fonts
        self.canvas = None
        self.diagnostics = []

    def render(self, root, index=0):
        self.diagnostics = []
        self.canvas = Image.new('RGBA', (int(SLIDE_W), int(SLIDE_H)),
                                (255, 255, 255, 255))
        try:
            paint_slide(root, self, index=index)
        except PaintError as exc:
            self.diagnostics.extend(exc.diagnostics)
            raise
        return self.canvas.convert('RGB')

    # ------------------------------------------------------- paint target

    def background(self, rgba):
        self.canvas.alpha_composite(Image.new(
            'RGBA', self.canvas.size,
            (int(rgba[0]), int(rgba[1]), int(rgba[2]), int(rgba[3] * 255))))

    def background_image(self, box, url, opacity):
        rect = _rect_of(box)
        if rect is None:
            return 0
        path = background_source(box, self.assets, url, opacity)
        if not path:
            return 0
        self._blit(path, *rect)
        return 1

    def outer_shadow(self, box, radius, shadows):
        rect = _rect_of(box)
        if rect is None:
            return 0
        x, y, w, h = rect
        made = outer_shadow_layer(w, h, radius, shadows)
        if not made:
            return 0
        self._composite(made[0], x - made[1], y - made[1])
        return 1

    def rect(self, box, radius, fill=None, gradient=None, outline=None):
        found = _rect_of(box)
        if found is None:
            return 0
        x, y, w, h = found
        if outline is not None:
            if gradient is not None:
                layer = gradient_image(w, h, gradient)
            else:
                layer = Image.new('RGBA', (w, h), (
                    int(fill[0]), int(fill[1]), int(fill[2]),
                    int(round(fill[3] * 255))))
            layer.putalpha(ImageChops.multiply(
                layer.getchannel('A'), _outline_mask(w, h, outline)))
        elif gradient is not None:
            layer = gradient_image(w, h, gradient)
            if radius > 0:
                # Multiply the corner mask into the gradient's own alpha, never
                # replace it. A stop such as rgba(255, 255, 255, 0) carries the
                # shape of the fill in that channel, and replacing it makes the
                # fill opaque everywhere: the timeline connector's
                # transparent-to-white ramp came out as a solid white bar. The
                # solid-colour branch below already multiplies — this one was
                # the odd one out.
                layer.putalpha(ImageChops.multiply(
                    layer.getchannel('A'), rounded_mask(w, h, radius)))
        else:
            alpha = int(round(fill[3] * 255))
            layer = Image.new('RGBA', (w, h), (int(fill[0]), int(fill[1]),
                                               int(fill[2]), alpha))
            if radius > 0:
                mask = rounded_mask(w, h, radius)
                layer.putalpha(mask.point(lambda v: v * alpha // 255))
        self.canvas.alpha_composite(layer, (x, y))
        return 1

    def inset_shadow(self, box, radius, shadows, outline=None):
        rect = _rect_of(box)
        if rect is None:
            return 0
        x, y, w, h = rect
        layer = inset_shadow_layer(w, h, radius, shadows, outline=outline)
        if layer is None:
            return 0
        self._composite(layer, x, y)
        return 1

    def picture(self, box, radius=0.0, outline=None):
        rect = _rect_of(box)
        if rect is None:
            return 0
        path = picture_source(box, self.assets)
        if not path:
            return 0
        visible_height, radius, outline, crop, contained = picture_placement(
            box, path, radius, outline)
        if visible_height <= 0:
            return 0
        if visible_height < box.h:
            rect = (rect[0], rect[1], rect[2], max(1, round(visible_height)))
        mask = None
        if outline is not None:
            mask = _outline_mask(rect[2], rect[3], outline)
        elif radius > 0:
            mask = rounded_mask(rect[2] * 4, rect[3] * 4, radius * 4).resize(
                (rect[2], rect[3]), Image.Resampling.LANCZOS)
        self._blit(path, *rect, crop=crop, mask=mask, contained=contained)
        return 1

    def connector(self, box, geometry):
        if box.w <= 0 or box.h <= 0:
            return 0
        ss = 4
        head_width, head_length = geometry.head_dimensions()
        padding = int(math.ceil(max(head_width, head_length, geometry.width))) + 2
        width, height = int(math.ceil(box.w)) + padding * 2, \
            int(math.ceil(box.h)) + padding * 2
        layer = Image.new('RGBA', (width * ss, height * ss), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        points = geometry.points(box.w, box.h)

        def xy(point):
            return ((point[0] + padding) * ss, (point[1] + padding) * ss)

        color = tuple(geometry.rgba[:3]) + (round(geometry.rgba[3] * 255),)
        pen = max(1, round(geometry.width * ss))
        draw.line([xy(point) for point in points], fill=color, width=pen,
                  joint='curve')
        if geometry.head != 'none':
            end, previous = points[-1], points[-2]
            dx, dy = end[0] - previous[0], end[1] - previous[1]
            distance = math.hypot(dx, dy)
            if distance:
                ux, uy = dx / distance, dy / distance
                left = (end[0] - ux * head_length - uy * head_width / 2,
                        end[1] - uy * head_length + ux * head_width / 2)
                right = (end[0] - ux * head_length + uy * head_width / 2,
                         end[1] - uy * head_length - ux * head_width / 2)
                if geometry.head == 'triangle':
                    draw.polygon([xy(left), xy(end), xy(right)], fill=color)
                else:
                    draw.line([xy(left), xy(end), xy(right)], fill=color,
                              width=pen, joint='curve')
        layer = layer.resize((width, height), Image.Resampling.LANCZOS)
        self.canvas.alpha_composite(layer, (round(box.x) - padding,
                                            round(box.y) - padding))
        return 1

    def chart(self, box, chart):
        """The geometry `chartstyle` hands PowerPoint, drawn with Pillow.

        Until v2.0 this was a matplotlib approximation allowed to differ from
        the PPTX. It now reads the geometry the layout pass placed, as the writer does, so
        the bars, sectors and lines here are the ones we asked PowerPoint
        for. What stays approximate is what PowerPoint does on its own inside
        that frame — the exact offset and kerning of its tick labels.

        Shapes are drawn at `_CHART_SS` times the size and scaled down: Pillow
        does not anti-alias polygons, and a doughnut drawn at 1x has visibly
        stepped edges.
        """
        geometry, palette = chart.geometry, chart.palette
        self._chart_shapes(geometry, palette)
        self._chart_labels(geometry, palette)
        return 1

    def _chart_shapes(self, geometry, palette):
        frame = geometry.frame
        left, top = int(frame.x), int(frame.y)
        width = int(round(frame.right)) - left + 1
        height = int(round(frame.bottom)) - top + 1
        ss = _CHART_SS
        layer = Image.new('RGBA', (width * ss, height * ss), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)

        def xy(x, y):
            return ((x - left) * ss, (y - top) * ss)

        axes = palette.axes
        plot = geometry.plot
        grid_w = max(1, int(round(axes['grid_weight_px'] * ss)))
        for y, is_base in geometry.gridlines:
            alpha = axes['baseline_alpha'] if is_base else axes['grid_alpha']
            color = _rgba(axes['grid_color'], alpha)
            draw.line([xy(plot.x, y), xy(plot.right, y)], fill=color,
                      width=grid_w)
        if geometry.zero_x is not None:
            draw.line([xy(geometry.zero_x, plot.y),
                       xy(geometry.zero_x, plot.bottom)],
                      fill=_rgba(axes['grid_color'], axes['baseline_alpha']),
                      width=grid_w)
        # Areas over the grid, as PowerPoint draws its series, and under the
        # lines, as the c:areaChart comes first; no outline (the guide:
        # «Обводка не используется»).
        for _, points, hex_ in geometry.areas:
            draw.polygon([xy(x, y) for x, y in points], fill=_rgba(hex_))
        kind = geometry.chart_type
        for _, _, rect, hex_ in geometry.bars:
            if rect.w <= 0 or rect.h <= 0:
                continue
            box = [xy(rect.x, rect.y), xy(rect.right, rect.bottom)]
            gradient = palette.gradient(kind, hex_)
            if gradient is None:
                draw.rectangle(box, fill=_rgba(hex_))
            else:
                mask = Image.new('L', layer.size, 0)
                ImageDraw.Draw(mask).rectangle(box, fill=255)
                _gradient_into(layer, mask, box[0] + box[1], gradient)
        if geometry.drop_lines:
            color = _rgba(axes['grid_color'], axes['grid_alpha'])
            base = [y for y, is_base in geometry.gridlines if is_base][0]
            for _, points, _ in geometry.lines:
                for x, y in points:
                    draw.line([xy(x, y), xy(x, base)], fill=color,
                              width=grid_w)
        style = palette.data['line']
        points_of = dict((s, (p, hex_)) for s, p, hex_ in geometry.lines)

        def discs(target, key, alpha):
            radius = style[key] / 2.0 * ss
            pen = ImageDraw.Draw(target)
            for s_index, indices in sorted(geometry.markers.items()):
                points, hex_ = points_of[s_index]
                for index in indices:
                    px, py = xy(*points[index])
                    pen.ellipse([px - radius, py - radius, px + radius,
                                 py + radius], fill=_rgba(hex_, alpha))

        if geometry.markers:
            # The halo is the native chart's shadow series, drawn before the
            # lines: a translucent disc blended over what is under it.
            halos = Image.new('RGBA', layer.size, (0, 0, 0, 0))
            discs(halos, 'halo_px', style['halo_alpha'])
            layer.alpha_composite(halos)
            draw = ImageDraw.Draw(layer)
        line_w = palette.line_px * ss
        for _, points, hex_ in geometry.lines:
            scaled = [xy(x, y) for x, y in points]
            draw.line(scaled, fill=_rgba(hex_), width=int(round(line_w)),
                      joint='curve')
            radius = line_w / 2.0
            for px, py in (scaled[0], scaled[-1]):          # round caps
                draw.ellipse([px - radius, py - radius, px + radius,
                              py + radius], fill=_rgba(hex_))
        if geometry.markers:
            discs(layer, 'marker_px', 1.0)
        if geometry.ring is not None:
            cx, cy, outer, inner = geometry.ring
            box = [xy(cx - outer, cy - outer), xy(cx + outer, cy + outer)]
            box = [box[0][0], box[0][1], box[1][0], box[1][1]]
            for start, end, hex_ in geometry.sectors:
                if end <= start:
                    continue
                # Pillow measures from 3 o'clock; ours from 12.
                gradient = palette.gradient('doughnut', hex_)
                if gradient is None:
                    draw.pieslice(box, start - 90.0, end - 90.0,
                                  fill=_rgba(hex_))
                    continue
                mask = Image.new('L', layer.size, 0)
                ImageDraw.Draw(mask).pieslice(box, start - 90.0, end - 90.0,
                                              fill=255)
                bounds = mask.getbbox()
                # A positive but subpixel sweep can also leave no pixels.
                if bounds is None:
                    continue
                _gradient_into(layer, mask, bounds, gradient)
            hole = [xy(cx - inner, cy - inner), xy(cx + inner, cy + inner)]
            draw.ellipse([hole[0][0], hole[0][1], hole[1][0], hole[1][1]],
                         fill=(0, 0, 0, 0))
        layer = layer.resize((width, height), Image.LANCZOS)
        self._composite(layer, left, top)

    def _chart_labels(self, geometry, palette):
        draw = ImageDraw.Draw(self.canvas)
        # A doughnut's centre figure is a chart part too (the linked title).
        centre = [geometry.center] if geometry.center is not None else []
        for label in geometry.labels + centre:
            style = palette.type[label.role]
            font = self.fonts.get(DEFAULT_FAMILY, style['weight'], style['size'])
            anchor = ({'c': 'm'}.get(label.anchor[0], label.anchor[0])
                      + label.anchor[1])
            draw.text((label.x, label.y), label.text, font=font.pil,
                      fill=_rgba(label.color), anchor=anchor)

    def table(self, box, table):
        """The same geometry the `a:tbl` gets: edges centred on the row
        boundaries, then the paragraphs the layout wrapped."""
        draw = ImageDraw.Draw(self.canvas)
        top = table.y
        for height, line in zip(table.rows, table.cells):
            for cell in line:
                for edge, y in ((cell.top, top), (cell.bottom, top + height)):
                    if edge is None:
                        continue
                    half = edge.width / 2.0
                    draw.rectangle(
                        (int(round(cell.box.x)), int(round(y - half)),
                         int(round(cell.box.x + cell.box.w)) - 1,
                         max(int(round(y - half)),
                             int(round(y + half)) - 1)),
                        fill=_rgba(V.to_hex(edge.rgba), edge.rgba[3]))
                for paragraph in cell.paragraphs:
                    self._text(paragraph.box, TextStyle(paragraph.box))
            top += height
        return 1

    def text(self, box, style):
        if _rect_of(box) is None:
            return 0
        self._text(box, style)
        return 1

    def failed(self, box, exc):
        log.warning('preview: %s %s — %s', box.tag, box.classes(), exc)

    # ------------------------------------------------------------ pillow

    def _composite(self, layer, x, y):
        """Composite layer, cropped to canvas: outer shadow goes off edge."""
        canvas = self.canvas
        left, top = max(0, -x), max(0, -y)
        right = min(layer.width, canvas.width - x)
        bottom = min(layer.height, canvas.height - y)
        if right <= left or bottom <= top:
            return
        if (left, top, right, bottom) != (0, 0, layer.width, layer.height):
            layer = layer.crop((left, top, right, bottom))
        canvas.alpha_composite(layer, (x + left, y + top))

    def _blit(self, path, x, y, w, h, crop=None, mask=None, contained=None):
        img = Image.open(path).convert('RGBA')
        if crop:
            left, top, right, bottom = crop
            nw, nh = img.size
            box = (int(round(left * nw)), int(round(top * nh)),
                  nw - int(round(right * nw)), nh - int(round(bottom * nh)))
            if box[2] > box[0] and box[3] > box[1]:
                img = img.crop(box)
        if contained is not None:
            left, top, width, height = contained
            fitted = img.resize((max(1, round(width)), max(1, round(height))))
            img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
            img.alpha_composite(fitted, (round(left), round(top)))
        else:
            img = img.resize((max(1, w), max(1, h)))
        if mask is not None:
            img.putalpha(ImageChops.multiply(img.getchannel('A'), mask))
        self.canvas.alpha_composite(img, (x, y))

    def _text(self, box, style):
        """Draw the already-wrapped lines from their baselines.

        Pillow has no paragraph engine, so this is the medium-specific half:
        a pixel cursor per run and an explicit baseline. Which face, which
        size, which colour and where the line starts are `style`'s answers,
        shared with the PPTX writer.
        """
        draw = ImageDraw.Draw(self.canvas)
        fill = (int(style.rgba[0]), int(style.rgba[1]), int(style.rgba[2]),
                int(style.rgba[3] * 255))
        # Gradient letters: the glyphs go into a mask first, and the gradient,
        # laid over the same box the PPTX text box gets, shows through it.
        mask = None
        if style.gradient is not None:
            mask = Image.new('L', self.canvas.size, 0)
            words = ImageDraw.Draw(mask)
        adaptive = bool(mask is not None and style.gradient_light_origin)
        line_top = box.y
        for index, line in enumerate(box.lines):
            if adaptive:
                mask = Image.new('L', self.canvas.size, 0)
                words = ImageDraw.Draw(mask)
            line_height = (style.line_heights[index]
                           if index < len(style.line_heights)
                           else style.line_height)
            baseline_offset = (style.line_baselines[index]
                               if index < len(style.line_baselines)
                               else line_height)
            baseline = line_top + baseline_offset
            line_top += line_height
            if not line:
                continue
            cursor = style.line_start(box, index)
            for run in line:
                if isinstance(run, MathRun):
                    metrics = math_metrics(run.mathtext, style.size,
                                           run.weight)
                    alpha = metrics.alpha
                    raster_w = alpha.shape[1]
                    raster_h = alpha.shape[0]
                    advance = metrics.advance
                    offset_x = max(0.0, (advance - raster_w) / 2.0)
                    formula_mask = Image.fromarray(alpha.astype(np.uint8), 'L')
                    layer = Image.new('RGBA', (raster_w, raster_h), fill)
                    layer.putalpha(formula_mask)
                    x = int(round(cursor + offset_x))
                    # The RAW ascent, not the reserved one. The reserve is
                    # padding around the glyph; adding it here would lift the
                    # ink off the line's shared baseline instead, exactly as
                    # centring inside the reserved advance avoids doing on the
                    # other axis.
                    y = int(round(baseline - metrics.raw_ascent))
                    self._composite(layer, x, y)
                    cursor += advance
                    continue
                font = self.fonts.get(style.family, run.weight, style.size)
                if mask is not None:
                    _draw_prose(words, (cursor, baseline), run.text, font, 255)
                else:
                    _draw_prose(draw, (cursor, baseline), run.text, font, fill)
                cursor += font.getlength(run.text)
            if adaptive:
                self._gradient_letters(box, style, mask,
                                       style.gradient_for_line(index))
        if mask is not None and not adaptive:
            self._gradient_letters(box, style, mask, style.gradient)

    def _gradient_letters(self, box, style, mask, gradient):
        x = int(round(box.x + style.pad_left))
        y = int(round(box.y + style.pad_top))
        w = int(round(style.content_width(box)))
        h = int(round(sum(style.line_heights)))
        if w <= 0 or h <= 0:
            return
        # At 90 % line height the descenders of the last line and the accents
        # of the first stand outside the box; the gradient's end colours
        # carry on over them, as they do in PowerPoint.
        m = int(math.ceil(style.size * 0.5))
        ramp = np.asarray(gradient_image(w, h, gradient))
        layer = Image.fromarray(
            np.pad(ramp, ((m, m), (m, m), (0, 0)), mode='edge'), 'RGBA')
        layer.putalpha(ImageChops.multiply(
            layer.getchannel('A'),
            mask.crop((x - m, y - m, x + w + m, y + h + m))))
        self._composite(layer, x - m, y - m)


def render_file(html_path, out_dir, skill_dir, wanted=None, scale=1.0, stem=None):
    """Open an HTML file and render its slides to PNG. Returns image paths."""
    cache_dir = tempfile.mkdtemp(prefix='deckcache-')
    try:
        document = Document.open(html_path, extra_dirs=[skill_dir])
        return render_document(
            document, out_dir, cache_dir, wanted=wanted, scale=scale,
            stem=stem or os.path.splitext(os.path.basename(html_path))[0])
    finally:
        shutil.rmtree(cache_dir, ignore_errors=True)


def render_document(document, out_dir, cache_dir, wanted=None, scale=1.0,
                    stem='slide'):
    """Render the slides of an open document to PNG. Returns image paths.

    Only the wanted slides are laid out: `Document.box` measures one slide at
    a time, and asking for two of twenty should not cost the other eighteen.
    """
    if not os.path.isdir(out_dir):
        os.makedirs(out_dir)

    preview = Preview(document.assets(cache_dir), document.fonts)

    out, diagnostics = [], []
    with tempfile.TemporaryDirectory(prefix='.deck-preview-', dir=out_dir) as work:
        for index in range(1, len(document.elements) + 1):
            if wanted and index not in wanted:
                continue
            try:
                image = preview.render(document.box(index), index=index)
            except PaintError as exc:
                diagnostics.extend(exc.diagnostics)
                continue
            if scale != 1.0:
                image = image.resize((int(SLIDE_W * scale), int(SLIDE_H * scale)))
            name = '%s-%02d.png' % (stem, index)
            image.save(os.path.join(work, name))
            out.append(os.path.join(out_dir, name))
        if diagnostics:
            raise PaintError(diagnostics)
        for path in out:
            os.replace(os.path.join(work, os.path.basename(path)), path)
    return out
