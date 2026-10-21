# -*- coding: utf-8 -*-
"""Renderer: Box tree with computed geometry → PPTX slides.

Principles:
  * everything possible is drawn with NATIVE PPTX means (fills, gradients,
    rounding, shadows, text) — the file remains editable, not an image;
  * raster is used only where nothing else works: SVG background patterns
    and PNG icons;
  * drawing order repeats HTML z-index.
"""
import logging

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Pt

from . import chartstyle
from . import formula
from . import tableml
from . import values as V
from .grouping import apply_groups, parent_map
from .layout import SLIDE_H, SLIDE_W
from .paint import (PaintError, PaintTarget, background_source, paint_slide,
                    picture_placement, picture_source)
from .formula import MathRun

log = logging.getLogger(__name__)

ALIGN_MAP = {
    'left': PP_ALIGN.LEFT,
    'center': PP_ALIGN.CENTER,
    'right': PP_ALIGN.RIGHT,
    'justify': PP_ALIGN.JUSTIFY,
}

class _Shapes(PaintTarget):
    """The PPTX side of the paint interface.

    Native wherever PowerPoint has a native means — fills, gradients, rounded
    corners, text — so the file stays editable rather than a picture. Raster
    only where nothing else works: the shadow rings and the SVG backgrounds,
    both of which arrive as PNG paths from the asset cache.
    """

    def __init__(self, renderer, slide, index):
        self.renderer = renderer
        self.slide = slide
        self.index = index
        self.painted = []               # (box, shape) in drawing order
        self._solid = {}                # box -> its rect, when the fill is opaque

    def _made(self, box, shape):
        """One paint call produces at most one shape — record which.

        Every method below returns 0 or 1, and `grouping` relies on that: it
        is what lets a group be assembled from the boxes without a second walk
        of the tree. Passing the shape rather than reading `shapes[-1]` keeps
        the two in step when a primitive declines to draw (a zero-width rect,
        a missing asset) instead of quietly grouping its neighbour.
        """
        if shape is None:
            return 0
        self.painted.append((box, shape))
        return 1

    def background(self, rgba):
        """The slide's own colour: a rectangle the full size of the slide."""
        self.renderer._add_rect(self.slide, 0, 0, SLIDE_W, SLIDE_H,
                                fill=rgba, radius=0)

    def background_image(self, box, url, opacity):
        path = background_source(box, self.renderer.assets, url, opacity)
        if not path:
            return 0
        return self._made(box, self.renderer._add_picture(
            self.slide, path, box.x, box.y, box.w, box.h))

    def outer_shadow(self, box, radius, shadows):
        # An image under the shape, not native `a:outerShdw`: PPTX draws the
        # full blurred silhouette of the shape behind it and it shows through a
        # translucent fill. In CSS the shadow is clipped at the box edge, so we
        # place a pre-cut ring (see boxdeco).
        path, pad = self.renderer.assets.outer_shadow(box.w, box.h, radius,
                                                      shadows)
        if not path:
            return 0
        return self._made(box, self.renderer._add_picture(
            self.slide, path, box.x - pad, box.y - pad,
            box.w + 2 * pad, box.h + 2 * pad))

    def rect(self, box, radius, fill=None, gradient=None, outline=None):
        shape = self.renderer._add_rect(
            self.slide, box.x, box.y, box.w, box.h,
            fill=fill, gradient=gradient, radius=radius, outline=outline)
        if shape is not None and _opaque(fill, gradient):
            self._solid[box] = shape
        return self._made(box, shape)

    def inset_shadow(self, box, radius, shadows, outline=None):
        # On an opaque fill one centred inner shadow is native `a:innerShdw`
        # (2.4.0, the cards' glow): it follows the shape when the card is
        # resized in PowerPoint. boxdeco's objection — DrawingML derives the
        # shadow from the fill's alpha — only bites a translucent fill, so the
        # glass panel and anything else keeps the image, on top of the fill
        # and under the content, where CSS has it in drawing order.
        shape = self._solid.get(box)
        inset = [s for s in shadows if s.inset and s.rgba[3] > 0]
        if shape is not None and len(inset) == 1 and _centred(inset[0]):
            _inner_shadow(shape, inset[0])
            return 0
        path = self.renderer.assets.inset_shadow(box.w, box.h, radius, shadows,
                                                 outline=outline)
        if not path:
            return 0
        return self._made(box, self.renderer._add_picture(
            self.slide, path, box.x, box.y, box.w, box.h))

    def picture(self, box, radius=0.0, outline=None):
        if box.w <= 0 or box.h <= 0:
            return 0
        path = picture_source(box, self.renderer.assets)
        if not path:
            return 0
        visible_height, radius, outline, crop, contained = picture_placement(
            box, path, radius, outline)
        if visible_height <= 0:
            return 0
        if contained is not None and contained[3] <= 0:
            return 0
        shape = self.renderer._add_picture(self.slide, path, box.x, box.y,
                                           box.w, visible_height)
        if shape is not None and crop is not None and (
                any(crop) or box.style.get('object-fit') == 'cover'):
            left, top, right, bottom = crop
            shape.crop_left, shape.crop_top = left, top
            shape.crop_right, shape.crop_bottom = right, bottom
        if shape is not None and contained is not None:
            left, top, width, height = contained
            # DrawingML's fillRect is a target inset, unlike srcRect crop.
            # Keep the full viewport shape so its rounded/custom mask clips
            # the contained image, retaining transparent source pixels.
            fill = shape._element.blipFill.find(qn('a:stretch')).find(
                qn('a:fillRect'))
            insets = {key: round(fraction * 100000) for key, fraction in (
                    ('l', left / box.w), ('r', (box.w - left - width) / box.w),
                    ('t', top / visible_height),
                    ('b', (visible_height - top - height) / visible_height))}
            # Equal-aspect assets need no target insets; preserve their XML.
            if any(insets.values()):
                for key, amount in insets.items():
                    fill.set(key, str(amount))
        if shape is not None:
            if outline is not None:
                _custom_geometry(shape, outline, box.w, visible_height)
            elif radius > 0:
                # Clip the original embedded picture, preserving crop/editability.
                geom = shape._element.spPr.find(qn('a:prstGeom'))
                geom.set('prst', 'roundRect')
                adjustments = geom.find(qn('a:avLst'))
                amount = min(0.5, radius / max(1.0, min(box.w, box.h)))
                adjustments.append(adjustments.makeelement(qn('a:gd'), {
                    'name': 'adj', 'fmla': 'val %d' % round(amount * 100000)}))
        return self._made(box, shape)

    def connector(self, box, geometry):
        if box.w <= 0 or box.h <= 0:
            return 0
        # Arc is a shape preset, not a connector preset. Writing it inside
        # p:cxnSp makes desktop PowerPoint repair the presentation; the
        # designer's editable arrows use p:sp with this same geometry.
        shape = self.slide.shapes.add_shape(
            MSO_SHAPE.ARC, Emu(V.px_to_emu(box.x)),
            Emu(V.px_to_emu(box.y)), Emu(V.px_to_emu(box.w)),
            Emu(V.px_to_emu(box.h)))
        shape.fill.background()
        shape.shadow.inherit = False
        _clear_text(shape)
        properties = shape._element.spPr
        preset = properties.find(qn('a:prstGeom'))
        preset.set('prst', 'arc')
        adjustments = preset.find(qn('a:avLst'))
        adjustments.clear()
        for name, angle in (('adj1', geometry.start), ('adj2', geometry.end)):
            adjustments.append(adjustments.makeelement(qn('a:gd'), {
                'name': name, 'fmla': 'val %d' % round(angle * 60000)}))
        transform = properties.find(qn('a:xfrm'))
        for name, enabled in (('flipH', geometry.flip_h),
                              ('flipV', geometry.flip_v)):
            if enabled:
                transform.set(name, '1')
        shape.line.width = Emu(V.px_to_emu(geometry.width))
        shape.line.color.rgb = RGBColor(*geometry.rgba[:3])
        line = properties.find(qn('a:ln'))
        if geometry.rgba[3] < 1:
            _set_alpha(line.find(qn('a:solidFill')), geometry.rgba[3])
        # A real native line end follows the arc when edited in PowerPoint.
        line.append(line.makeelement(qn('a:tailEnd'), {
            'type': geometry.head, 'w': geometry.head_width,
            'len': geometry.head_length}))
        return self._made(box, shape)

    def chart(self, box, chart):
        return self._made(box, self.renderer._add_chart(self.slide, box, chart))

    def table(self, box, table):
        return self._made(box, tableml.add_table(self.renderer, self.slide,
                                                 table))

    def text(self, box, style):
        return self._made(box, self.renderer._add_text(self.slide, box, style))

    def failed(self, box, exc):
        log.error('[ERROR] slide %02d, <%s class="%s">: %s',
                  self.index, box.tag, ' '.join(sorted(box.classes())), exc)


class Renderer:
    def __init__(self, assets, fontbook, prs=None, group_roots=()):
        self.assets = assets            # AssetResolver
        self.fonts = fontbook
        self.group_roots = frozenset(group_roots)   # see grouping.py
        self.diagnostics = []
        self.prs = prs or self._new_presentation()
        self.blank = self.prs.slide_layouts[6]

    @staticmethod
    def _new_presentation():
        prs = Presentation()
        prs.slide_width = Emu(V.px_to_emu(SLIDE_W))
        prs.slide_height = Emu(V.px_to_emu(SLIDE_H))
        return prs

    # ------------------------------------------------------------ slide

    def render_slide(self, root, index):
        slide = self.prs.slides.add_slide(self.blank)
        target = _Shapes(self, slide, index)
        try:
            drawn = paint_slide(root, target, index=index)
        except PaintError as exc:
            self.diagnostics.extend(exc.diagnostics)
            raise
        # After the whole slide, not during: a group has to know all of its
        # members, and moving shapes into one mid-walk would renumber the tree
        # the rest of the walk is appending to.
        apply_groups(slide, target.painted, parent_map(root), index,
                     self.group_roots)
        return drawn

    # ------------------------------------------------------------ primitives

    def _add_rect(self, slide, x, y, w, h, fill=None, gradient=None, radius=0.0,
                  outline=None):
        """Rectangle, rounded if needed, with fill or gradient — or, with an
        `outline` (`clip-path: path()`), that shape as a:custGeom.

        Shadows are drawn not here: outer ones as images around the shape (see
        boxdeco), an inner one on an opaque fill as the shape's a:innerShdw.
        """
        if w <= 0 or h <= 0:
            return None
        shape_type = MSO_SHAPE.ROUNDED_RECTANGLE if radius > 0 else MSO_SHAPE.RECTANGLE
        shape = slide.shapes.add_shape(
            shape_type, Emu(V.px_to_emu(x)), Emu(V.px_to_emu(y)),
            Emu(V.px_to_emu(w)), Emu(V.px_to_emu(h)))
        shape.shadow.inherit = False

        if outline is not None:
            _custom_geometry(shape, outline, w, h)
        elif radius > 0:
            # For roundRect the corner radius = adj × min(width, height).
            adj = max(0.0, min(0.5, radius / max(1.0, min(w, h))))
            shape.adjustments[0] = adj

        if gradient is not None:
            self._apply_gradient(shape, gradient, w, h)
        elif fill is not None:
            shape.fill.solid()
            shape.fill.fore_color.rgb = RGBColor.from_string(V.to_hex(fill))
            if fill[3] < 1.0:
                _set_alpha(shape.fill.fore_color._xFill, fill[3])
        else:
            shape.fill.background()

        shape.line.fill.background()
        _clear_text(shape)
        return shape

    def _apply_gradient(self, shape, gradient, width=0, height=0):
        """CSS linear gradient → native PPTX gradient fill.

        The box size is needed because a corner keyword resolves to a different
        angle on every aspect ratio — see Gradient.angle_for.
        """
        fill = shape.fill
        fill.gradient()
        stops = fill.gradient_stops
        css_stops = gradient.stops

        first, last = css_stops[0], css_stops[-1]
        stops[0].position = max(0.0, min(1.0, first[0]))
        stops[0].color.rgb = RGBColor.from_string(V.to_hex(first[1]))
        stops[1].position = max(0.0, min(1.0, last[0]))
        stops[1].color.rgb = RGBColor.from_string(V.to_hex(last[1]))
        # Straight into a:lin, never `fill.gradient_angle`: python-pptx takes
        # that angle counter-clockwise and writes 360 - value, while
        # pptx_angle is already clockwise, as a:lin/@ang is. Until 2.4.0 every
        # shape gradient was mirrored top to bottom - the yellow card dark at
        # the top right instead of the bottom right - and only PowerPoint
        # showed it; the preview reads the CSS angle itself.
        _set_gradient_angle_xml(fill, gradient.pptx_angle(width, height))

        # python-pptx hands out exactly two stops and offers no way to add a
        # third, so anything between the edges goes in as XML. Taking only the
        # edges made the dark column background — #121212 → #333333 → #1C1C1C —
        # a flat slab, because a gradient whose two ends are nearly the same
        # colour carries all of its shape in the middle stop.
        _insert_middle_stops(fill, css_stops)

        # Per-stop transparency, last so that nothing downstream rebuilds the
        # colour element. PPTX carries it, python-pptx does not expose it, and
        # without it a stop like rgba(255, 255, 255, 0) lands fully opaque: the
        # timeline connector shipped as a solid white bar instead of a ramp.
        # The PNG preview lost the same alpha for an unrelated reason, so
        # neither side could be used as evidence about the other.
        _set_stop_alpha(fill, 0, first[1][3])
        _set_stop_alpha(fill, -1, last[1][3])

    def _add_picture(self, slide, path, x, y, w, h):
        if w <= 0 or h <= 0:
            return None
        return slide.shapes.add_picture(
            path, Emu(V.px_to_emu(x)), Emu(V.px_to_emu(y)),
            Emu(V.px_to_emu(w)), Emu(V.px_to_emu(h)))

    def _add_chart(self, slide, box, chart):
        """Native `c:chart` — editable in PowerPoint, styled to the design.

        The layout pass has already placed the chart (`chartgeom.place`):
        every position and colour is decided. `chartstyle` only writes them
        into the chart part, and `preview.py`'s `Preview.chart` draws the
        same geometry, so the two media agree about a chart the way they
        agree about everything else.
        """
        return chartstyle.add_chart(slide, chart.geometry, chart.data,
                                    chart.colors, chart.palette, self.fonts)

    # ------------------------------------------------------------ text

    def _add_text(self, slide, box, style):
        """Text block: one paragraph per already-computed line.

        Line wraps are computed by us from TTF metrics, so PowerPoint wrapping
        is disabled — otherwise lines would diverge from HTML. `style` is the
        `paint.TextStyle` the traversal already read; this method must not go
        back to the CSS for any of it.
        """
        size_px = style.size
        lh_px = style.line_height
        family = style.family
        weight = style.weight
        rgba = style.rgba
        align = style.align

        # No baseline correction. There used to be one here, on the assumption
        # that PowerPoint puts the first baseline at `line-height` from the top
        # of the block while CSS puts it at half-leading + ascent. Measured off
        # a screenshot of a delivered deck, that assumption is wrong: with exact
        # line spacing (`a:lnSpc/a:spcPts`, set below) PowerPoint centres the
        # font's line box inside the spacing exactly as CSS does, so the
        # correction was compensating for something that does not happen and
        # pushed every text block up by its own size:
        #
        #   36px / lh 43.2   correction -11.1   text landed 12.7px high
        #   48px / lh 52.8   correction -12.4   text landed 13.2px high
        #  144px / lh 129.6  correction -21.8   text landed 20.6px high
        #
        # The error equals the correction at every size, which is what makes it
        # a misdiagnosis rather than a miscalibration. It was invisible for
        # years because the PNG preview does not go through this path and
        # because a block of running text looks fine 13px high — it shows up
        # only where text is centred inside something, which is why the v1.4
        # numeral-in-a-circle is what finally exposed it.
        left = box.x + style.pad_left
        top = box.y + style.pad_top
        width = max(1.0, style.content_width(box))
        height = max(1.0, sum(style.line_heights) + 2)
        if style.anchor_bottom:
            # The 2 px of slack go above the text, so its last line stays
            # where the layout put it.
            top -= 2

        tb = slide.shapes.add_textbox(
            Emu(V.px_to_emu(left)), Emu(V.px_to_emu(top)),
            Emu(V.px_to_emu(width)), Emu(V.px_to_emu(height)))
        tf = tb.text_frame
        tf.word_wrap = False
        tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
        tf.vertical_anchor = (MSO_ANCHOR.BOTTOM if style.anchor_bottom
                              else MSO_ANCHOR.TOP)
        _disable_autofit(tf)

        for i, line in enumerate(box.lines):
            para = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            para.alignment = ALIGN_MAP.get(align, PP_ALIGN.LEFT)
            line_height = style.line_heights[i] if i < len(style.line_heights) else lh_px
            para.line_spacing = Pt(V.px_to_pt(line_height))
            para.space_before = Pt(0)
            para.space_after = Pt(0)
            if not line:
                run = para.add_run()
                run.text = ' '
                face_name, is_bold = self.fonts.face(family, weight)
                _style_run(run, face_name, size_px, is_bold, rgba)
                continue
            for piece in line:
                if isinstance(piece, MathRun):
                    face_name, is_bold = self.fonts.face(family, piece.weight)
                    para._p.append(formula.omml(piece.latex, face_name,
                                                size_px, is_bold, rgba))
                    continue
                run = para.add_run()
                run.text = piece.text
                face_name, is_bold = self.fonts.face(family, piece.weight)
                _style_run(run, face_name, size_px, is_bold, rgba)
                if style.gradient is not None:
                    _gradient_run(run, style.gradient_for_line(i), width, height)
        return tb

    # ------------------------------------------------------------ saving

    def save(self, path):
        if self.diagnostics:
            raise PaintError(self.diagnostics)
        self.prs.save(path)
        return path


# ---------------------------------------------------------------- XML utilities

def _style_run(run, family, size_px, is_bold, rgba):
    """Style a run. `is_bold` is already a boolean flag, not a numeric weight.

    Weight 500 (Medium) is conveyed in PPTX by the typeface NAME ("T-Sans Medium"),
    not a bold flag — there is no numeric weight in the format.
    """
    font = run.font
    font.name = family
    font.size = Pt(V.px_to_pt(size_px))
    font.bold = bool(is_bold)
    font.color.rgb = RGBColor.from_string(V.to_hex(rgba))
    # Same font for Cyrillic and Latin: otherwise PowerPoint may substitute
    # a different typeface for ea/cs and widths will drift.
    rPr = run._r.get_or_add_rPr()
    for tag in ('a:latin', 'a:ea', 'a:cs'):
        existing = rPr.find(qn(tag))
        if existing is None:
            existing = rPr.makeelement(qn(tag), {})
            rPr.append(existing)
        existing.set('typeface', family)


def _gradient_run(run, gradient, width, height):
    """Swap a styled run's solid colour for a linear gradient, in place.

    PowerPoint spreads a run's gradient over the text box, and the box is the
    CSS one (same left, width and line heights), so the angle is resolved
    for that size. Schema order inside `a:gradFill`: `a:gsLst` before
    `a:lin` — the other way round PowerPoint refuses the file.
    """
    rPr = run._r.get_or_add_rPr()
    solid = rPr.find(qn('a:solidFill'))
    grad = rPr.makeelement(qn('a:gradFill'), {'rotWithShape': '1'})
    gsLst = grad.makeelement(qn('a:gsLst'), {})
    grad.append(gsLst)
    for pos, rgba in gradient.stops:
        gs = gsLst.makeelement(
            qn('a:gs'),
            {'pos': str(int(round(max(0.0, min(1.0, pos)) * 100000)))})
        clr = gs.makeelement(qn('a:srgbClr'), {'val': V.to_hex(rgba)})
        if rgba[3] is not None and rgba[3] < 1.0:
            clr.append(clr.makeelement(
                qn('a:alpha'), {'val': str(int(round(rgba[3] * 100000)))}))
        gs.append(clr)
        gsLst.append(gs)
    angle = gradient.pptx_angle(width, height)
    grad.append(grad.makeelement(
        qn('a:lin'), {'ang': str(int(round(angle * 60000)) % 21600000),
                      'scaled': '0'}))
    if solid is not None:
        solid.addprevious(grad)
        rPr.remove(solid)
    else:
        rPr.insert(0, grad)


def _opaque(fill, gradient):
    """True when nothing of the fill lets the slide through."""
    if gradient is not None:
        return all(len(stop[1]) < 4 or stop[1][3] >= 1.0 for stop in gradient.stops)
    return fill is not None and fill[3] >= 1.0


def _centred(shadow):
    """An inner shadow `a:innerShdw` can say: no offset, no spread."""
    return not shadow.dx and not shadow.dy and not shadow.spread


def _custom_geometry(shape, outline, width, height):
    """Swap the shape's a:prstGeom for an a:custGeom drawing `outline`.

    The path is in EMU of the box, its w/h the box itself, so PowerPoint
    stretches it with the shape and Edit Points shows the outline's own
    nodes — the curves stay curves, not a polyline.
    """
    spPr = shape._element.spPr
    preset = spPr.find(qn('a:prstGeom'))
    geom = spPr.makeelement(qn('a:custGeom'), {})
    for name in ('a:avLst', 'a:gdLst', 'a:ahLst', 'a:cxnLst'):
        geom.append(geom.makeelement(qn(name), {}))
    geom.append(geom.makeelement(qn('a:rect'),
                                 {'l': 'l', 't': 't', 'r': 'r', 'b': 'b'}))
    paths = geom.makeelement(qn('a:pathLst'), {})
    geom.append(paths)
    path = paths.makeelement(qn('a:path'), {
        'w': str(V.px_to_emu(width)), 'h': str(V.px_to_emu(height))})
    paths.append(path)
    tags = {'M': 'a:moveTo', 'L': 'a:lnTo', 'C': 'a:cubicBezTo', 'Z': 'a:close'}
    for op, points in outline.segments:
        node = path.makeelement(qn(tags[op]), {})
        for px, py in points:
            node.append(node.makeelement(qn('a:pt'), {
                'x': str(V.px_to_emu(px)), 'y': str(V.px_to_emu(py))}))
        path.append(node)
    preset.addprevious(geom)
    spPr.remove(preset)


def _inner_shadow(shape, shadow):
    """CSS `inset 0 0 <blur> <colour>` as the shape's own `a:innerShdw`.

    blurRad takes the CSS blur length as is. The designers' cards carry
    571500 EMU on a 19799300-EMU slide, 55px of 1920; base.css says 56px.
    """
    spPr = shape._element.spPr
    effects = spPr.find(qn('a:effectLst'))
    if effects is None:
        effects = spPr.makeelement(qn('a:effectLst'), {})
        ln = spPr.find(qn('a:ln'))
        if ln is not None:
            ln.addnext(effects)
        else:
            spPr.append(effects)
    node = effects.makeelement(qn('a:innerShdw'), {
        'blurRad': str(int(V.px_to_emu(shadow.blur))), 'dist': '0', 'dir': '0'})
    colour = node.makeelement(qn('a:srgbClr'), {'val': V.to_hex(shadow.rgba)})
    node.append(colour)
    effects.append(node)
    if shadow.rgba[3] < 1.0:
        _set_alpha(node, shadow.rgba[3])


def _set_alpha(parent, alpha):
    """Add transparency to the a:srgbClr under `parent` (python-pptx cannot).

    `parent` is a fill element for a solid fill, or a single a:gs for one stop
    of a gradient — in both the colour sits one level down.
    """
    srgbClr = parent.find(qn('a:srgbClr'))
    if srgbClr is None:
        return
    for old in srgbClr.findall(qn('a:alpha')):
        srgbClr.remove(old)
    node = srgbClr.makeelement(qn('a:alpha'), {'val': str(int(round(alpha * 100000)))})
    srgbClr.append(node)


def _gradient_stop_elements(fill):
    """The a:gs elements of a gradient fill, in document order."""
    gradFill = fill._xPr.find(qn('a:gradFill'))
    if gradFill is None:
        return []
    gsLst = gradFill.find(qn('a:gsLst'))
    if gsLst is None:
        return []
    return gsLst.findall(qn('a:gs'))


def _insert_middle_stops(fill, css_stops):
    """Add every stop between the first and the last as raw XML."""
    if len(css_stops) <= 2:
        return
    elements = _gradient_stop_elements(fill)
    if not elements:
        return
    gsLst = elements[0].getparent()
    for offset, (pos, rgba) in enumerate(css_stops[1:-1]):
        gs = gsLst.makeelement(
            qn('a:gs'),
            {'pos': str(int(round(max(0.0, min(1.0, pos)) * 100000)))})
        clr = gs.makeelement(qn('a:srgbClr'), {'val': V.to_hex(rgba)})
        gs.append(clr)
        if rgba[3] is not None and rgba[3] < 1.0:
            clr.append(clr.makeelement(
                qn('a:alpha'), {'val': str(int(round(rgba[3] * 100000)))}))
        gsLst.insert(1 + offset, gs)


def _set_stop_alpha(fill, index, alpha):
    """Transparency on one stop of a gradient fill. No-op for an opaque stop."""
    if alpha is None or alpha >= 1.0:
        return
    stops = _gradient_stop_elements(fill)
    if -len(stops) <= index < len(stops):
        _set_alpha(stops[index], alpha)


def _set_gradient_angle_xml(fill, angle_deg):
    """Fallback path to set gradient angle directly in XML."""
    gradFill = fill._xPr.find(qn('a:gradFill'))
    if gradFill is None:
        return
    lin = gradFill.find(qn('a:lin'))
    if lin is None:
        lin = gradFill.makeelement(qn('a:lin'), {})
        gradFill.append(lin)
    lin.set('ang', str(int(round(angle_deg * 60000)) % 21600000))
    lin.set('scaled', '0')


def _clear_text(shape):
    """Remove the empty text frame from an auto shape so it does not affect appearance."""
    try:
        shape.text_frame.text = ''
    except Exception:                                      # noqa: BLE001
        pass


def _disable_autofit(text_frame):
    bodyPr = text_frame._txBody.bodyPr
    for tag in ('a:normAutofit', 'a:spAutoFit'):
        for node in bodyPr.findall(qn(tag)):
            bodyPr.remove(node)
    bodyPr.append(bodyPr.makeelement(qn('a:noAutofit'), {}))
    bodyPr.set('wrap', 'none')
