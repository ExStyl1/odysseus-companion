# -*- coding: utf-8 -*-
"""One walk over the box tree, two media.

The traversal, the drawing order and the reading of CSS into paint operations
live here exactly once. What differs between a `.pptx` and a PNG — a native
gradient fill against an interpolated bitmap, PowerPoint's text engine against
a pixel cursor — lives in the two targets, `html2pptx/render.py` and
`preview.py`.

Before v1.5 both media walked the tree themselves, and the two walks had
drifted in two places that no check could see:

  * the background image was painted **before** the outer shadow in the PPTX
    writer and **after** it in the preview, so a box with both showed its
    shadow over the image in one medium and under it in the other;
  * a box carrying both `background-image` and `background-color` got both in
    the PPTX and only the colour in the preview.

Neither is in the template today, which is exactly why they survived: a
divergence nothing renders is a divergence nothing reports. The order below is
the PPTX writer's, because that is the one that shipped.

A target implements the paint primitives. Each painting one returns the number of
shapes it produced, so `paint_slide` can report what a slide cost.
"""
import logging
import math
import os
import tempfile

from . import values as V
from . import connectors
from . import tables
from .assets import image_size, picture_fit
from .textmeasure import primary_family

log = logging.getLogger(__name__)


class PaintDiagnostic(object):
    """Engine-owned failure with a stable code and markup location."""

    __slots__ = ('code', 'slide', 'tag', 'classes', 'message')

    def __init__(self, code, slide, box, message):
        self.code = code
        self.slide = slide
        self.tag = box.tag
        self.classes = tuple(sorted(box.classes()))
        self.message = message

    def __str__(self):
        return 'slide %d, <%s class="%s">: %s: %s' % (
            self.slide, self.tag, ' '.join(self.classes), self.code, self.message)


class PaintError(Exception):
    """The walk continued, but its incomplete output must not be published."""

    def __init__(self, diagnostics):
        self.diagnostics = list(diagnostics)
        Exception.__init__(self, '\n'.join(str(d) for d in self.diagnostics))


class _AssetUnavailable(Exception):
    pass


def picture_source(box, assets):
    """Resolve a required visible picture; empty geometry needs no resource."""
    if box.w <= 0 or box.h <= 0 or picture_viewport(box)[0] <= 0:
        return None
    path = assets.for_box(box)
    if not path:
        source = '<inline svg>' if box.is_svg else box.src
        raise _AssetUnavailable('picture asset unavailable: %r' % (source,))
    return path


def background_source(box, assets, url, opacity):
    """Resolve an explicit background URL without relying on missing logs."""
    if box.w <= 0 or box.h <= 0:
        return None
    path = assets.image(url, box.w, box.h, opacity=opacity)
    if not path:
        raise _AssetUnavailable('background asset unavailable: %r' % (url,))
    return path


def float_or(value, default):
    """A CSS number, or the default when it is missing or malformed."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


font_family = primary_family


def _split_curve(points, amount):
    """De Casteljau split, retaining native cubic control points."""
    levels = [list(points)]
    while len(levels[-1]) > 1:
        levels.append([tuple(a * (1 - amount) + b * amount
                             for a, b in zip(first, second))
                       for first, second in zip(levels[-1], levels[-1][1:])])
    return ([level[0] for level in levels],
            [level[-1] for level in reversed(levels)])


def _curve_slice(points, start, end):
    selected = _split_curve(points, end)[0] if end < 1 else points
    return _split_curve(selected, start / end)[1] if start else selected


def _curve_crossings(points, bottom):
    """All cubic/line intersections with a horizontal boundary."""
    if len(points) == 2:
        first, last = points[0][1], points[-1][1]
        amount = (bottom - first) / (last - first) if last != first else -1
        return [amount] if 0 < amount < 1 else []
    y0, y1, y2, y3 = [point[1] for point in points]
    a, b, c = -y0 + 3*y1 - 3*y2 + y3, 3*y0 - 6*y1 + 3*y2, -3*y0 + 3*y1
    critical = []
    if abs(a) < 1e-12:
        if abs(b) > 1e-12:
            critical = [-c / (2*b)]
    else:
        discriminant = 4*b*b - 12*a*c
        if discriminant >= 0:
            root = math.sqrt(discriminant)
            critical = [(-2*b-root)/(6*a), (-2*b+root)/(6*a)]
    limits = [0] + sorted(t for t in critical if 0 < t < 1) + [1]
    def value(t):
        return ((a*t+b)*t+c)*t+y0-bottom
    crossings = []
    for left, right in zip(limits, limits[1:]):
        vleft, vright = value(left), value(right)
        if abs(vleft) < 1e-9 and 0 < left < 1:
            crossings.append(left)
        if vleft * vright < 0:
            for _ in range(45):
                middle = (left+right)/2
                if value(left) * value(middle) <= 0:
                    right = middle
                else:
                    left = middle
            crossings.append((left+right)/2)
    return sorted(set(crossings))


def _clip_outline_bottom(outline, bottom):
    """Intersect a closed outline with a bottom boundary without flattening."""
    clipped, output = [], []
    current = first = None
    def finish():
        if output:
            clipped.extend(output)
            clipped.append(('Z', []))
            output[:] = []
    for operation, points in outline.segments:
        if operation == 'M':
            finish()
            current = first = points[0]
            continue
        end = first if operation == 'Z' else points[-1]
        controls = [current] + (list(points) if operation == 'C' else [end])
        limits = [0] + _curve_crossings(controls, bottom) + [1]
        for start, stop in zip(limits, limits[1:]):
            middle = _split_curve(controls, (start+stop)/2)[0][-1]
            if middle[1] > bottom + 1e-8:
                continue
            selected = _curve_slice(controls, start, stop)
            point = selected[0]
            if not output:
                output.append(('M', [point]))
            elif output[-1][1][-1] != point:
                output.append(('L', [point]))
            output.append(('C' if operation == 'C' else 'L', selected[1:]))
        current = end
        if operation == 'Z':
            finish()
    finish()
    return V.Outline(clipped, '%s-bottom-%g' % (outline.key, bottom))


def picture_viewport(box, radius=0, outline=None):
    """Visible height and mask for an explicit absolute bottom boundary.

    The original box remains authoritative for image fitting. Only the drawn
    viewport is intersected, so native objects can stop at the slide edge.
    """
    boundary = box.el.get('data-clip-bottom') if box.el is not None else None
    if boundary is None:
        return box.h, radius, outline
    bottom = float(boundary)
    if not math.isfinite(bottom):
        raise ValueError('picture bottom boundary must be finite')
    visible = max(0, min(box.h, bottom - box.y))
    if visible == box.h or visible == 0:
        return visible, radius, outline
    if outline is None:
        width, height = box.w, box.h
        r = min(radius, width/2, height/2)
        k = 0.5522847498307936
        segments = [('M', [(r, 0)]), ('L', [(width-r, 0)]),
                    ('C', [(width-r+k*r, 0), (width, r-k*r), (width, r)]),
                    ('L', [(width, height-r)]),
                    ('C', [(width, height-r+k*r), (width-r+k*r, height), (width-r, height)]),
                    ('L', [(r, height)]),
                    ('C', [(r-k*r, height), (0, height-r+k*r), (0, height-r)]),
                    ('L', [(0, r)]), ('C', [(0, r-k*r), (r-k*r, 0), (r, 0)]),
                    ('Z', [])]
        outline = V.Outline(segments, 'rounded-%g-%g-%g' % (width, height, r))
    return visible, 0, _clip_outline_bottom(outline, visible)


def picture_placement(box, path, radius=0, outline=None):
    """Shared fitted source/target geometry for preview, PPTX and warnings."""
    visible, radius, outline = picture_viewport(box, radius, outline)
    safe = box.el is not None and box.el.get('data-contain-safe') == 'true'
    crop, contained = picture_fit(
        path, box.w, box.h, visible, box.style.get('object-fit'),
        box.style.get('object-position'), safe, radius, outline)
    return visible, radius, outline, crop, contained


def paint_order(root):
    """Flat list of boxes in drawing order.

    Depth-first traversal gives the natural order "parent before child".
    Then stable sort by effective z-index: if an element's z-index is not
    explicitly set, it inherits the parent's value — otherwise text would
    slide under its own card.
    """
    flat = []

    def visit(box, inherited_z):
        declared = box.style.get('z-index')
        z = inherited_z
        if declared is not None:
            try:
                z = int(float(declared))
            except (TypeError, ValueError):
                z = inherited_z
        flat.append((z, len(flat), box))
        for child in box.children:
            visit(child, z)

    visit(root, 0)
    flat.sort(key=lambda item: (item[0], item[1]))
    return [item[2] for item in flat]


class TextStyle(object):
    """Everything a text box needs, read from CSS once.

    Both media want the same answers — which face at which size, what colour,
    which alignment, how much padding — and only differ in what they do with
    them. `line_height` and `size` come off the box rather than the style
    because the size search writes them there.
    """

    __slots__ = ('family', 'weight', 'rgba', 'align', 'size', 'line_height',
                 'line_heights', 'line_baselines', 'line_widths', 'pad_top',
                 'pad_right',
                 'pad_bottom', 'pad_left', 'anchor_bottom', 'gradient',
                 'gradient_light_origin')

    def __init__(self, box):
        style = box.style
        self.family = font_family(style.get('font-family'))
        self.weight = style.get('font-weight', 400)
        self.rgba = V.color(style.get('color')) or (51, 51, 51, 1.0)
        self.align = (style.get('text-align') or 'left').strip().lower()
        self.size = box.font_size
        self.line_height = box.line_height
        self.line_heights = list(box.line_heights)
        self.line_baselines = list(box.line_baselines)
        self.line_widths = list(box.line_widths)
        self.pad_top = V.length(style.get('padding-top'), default=0.0) or 0.0
        self.pad_right = V.length(style.get('padding-right'), default=0.0) or 0.0
        self.pad_bottom = V.length(style.get('padding-bottom'), default=0.0) or 0.0
        self.pad_left = V.length(style.get('padding-left'), default=0.0) or 0.0
        # A text box placed by its `bottom` alone grows upward (the closing
        # slide): PowerPoint is told so, or a line typed there runs down.
        self.anchor_bottom = (style.get('position') == 'absolute'
                              and style.get('bottom') is not None
                              and style.get('top') is None)
        # Letters painted with a gradient (2.4.0, the closing slide): CSS
        # says so with `background-clip: text` over a linear-gradient, and
        # `rgba` stays as the colour of anything the gradient cannot reach.
        self.gradient = text_gradient(style)
        self.gradient_light_origin = (
            style.get('--text-gradient-light-origin') == 'bottom-right')

    def gradient_for_line(self, index):
        """Keep the bottom line's fill; reduce light on shorter, higher lines.

        The same measured widths and line index feed both native text runs and
        the PNG mask. This opt-in does not alter ordinary text gradients.
        """
        if self.gradient is None or not self.gradient_light_origin:
            return self.gradient
        last = len(self.line_widths) - 1
        if last <= 0 or index >= last:
            return self.gradient
        widest = max(self.line_widths) or 1.0
        width_share = min(1.0, max(0.0, self.line_widths[index] / widest))
        height_share = 1.0 - 0.45 * ((last - index) / float(last))
        exposure = width_share * height_share
        dark = self.gradient.stops[0][1]
        stops = []
        for position, rgba in self.gradient.stops:
            blended = tuple(int(round(dark[channel] + exposure *
                                      (rgba[channel] - dark[channel])))
                            for channel in range(3))
            alpha = dark[3] + exposure * (rgba[3] - dark[3])
            stops.append((position, blended + (alpha,)))
        return V.Gradient(self.gradient.angle_deg, stops,
                          corner=self.gradient.corner)

    def content_width(self, box):
        return box.w - self.pad_left - self.pad_right

    def line_start(self, box, index):
        """Left edge of line `index` once alignment is applied. The width is
        the one the layout measured when it wrapped the line."""
        left = box.x + self.pad_left
        if self.align not in ('center', 'right'):
            return left
        width = self.line_widths[index] if index < len(self.line_widths) else 0.0
        room = self.content_width(box) - width
        return left + (room / 2.0 if self.align == 'center' else room)


class PaintTarget(object):
    """The interface a medium implements. Every method is optional to override
    only in the sense that not overriding one means that medium draws nothing
    for it; there is no default drawing.
    """

    def background(self, rgba):
        """The slide's own background colour."""

    def background_image(self, box, url, opacity):
        return 0

    def outer_shadow(self, box, radius, shadows):
        return 0

    def rect(self, box, radius, fill=None, gradient=None, outline=None):
        return 0

    def inset_shadow(self, box, radius, shadows, outline=None):
        return 0

    def picture(self, box, radius=0.0, outline=None):
        return 0

    def connector(self, box, geometry):
        return 0

    def chart(self, box, data):
        return 0

    def table(self, box, table):
        """One native table for a `data-table` root (tables.py). Its
        descendants are not walked: the table stands for all of them."""
        return 0

    def text(self, box, style):
        return 0

    def failed(self, box, exc):
        log.warning('paint: %s %s — %s', box.tag, box.classes(), exc)


class _ResourceCheck(PaintTarget):
    """Preflight resources through the shared walk, without drawing shapes."""

    def __init__(self, assets):
        self.assets = assets

    def picture(self, box, radius=0.0, outline=None):
        path = picture_source(box, self.assets)
        if path:
            image_size(path)
        return 0

    def background_image(self, box, url, opacity):
        path = background_source(box, self.assets, url, opacity)
        if path:
            image_size(path)
        return 0


def check_resources(document):
    """All visible image failures, using the same resolver and walk as output."""
    assets = document.assets(os.path.join(tempfile.gettempdir(), 'html2pptx-cache'))
    diagnostics = []
    for index, root in enumerate(document.boxes(), 1):
        try:
            paint_slide(root, _ResourceCheck(assets), index=index)
        except PaintError as exc:
            diagnostics.extend(exc.diagnostics)
    return diagnostics


def text_gradient(style):
    """The gradient a text box paints its letters with, or None.

    Only `background-clip: text` makes a background-image a text fill; without
    it the same gradient is the box's own background.
    """
    clip = (style.get('background-clip')
            or style.get('-webkit-background-clip') or '').strip().lower()
    if clip != 'text':
        return None
    return V.gradient(style.get('background-image'))


def paint_box(box, target):
    """Read one box's CSS and emit its paint operations, in drawing order."""
    connector = connectors.read(box)
    if connector is not None:
        return target.connector(box, connector)
    style = box.style
    bg_image = style.get('background-image')
    if bg_image and box.kind == 'text' and text_gradient(style):
        bg_image = None     # the letters' fill, painted by target.text
    gradient = V.gradient(bg_image) if bg_image else None
    bg_color = V.color(style.get('background-color'))
    radius = V.length(style.get('border-radius'), default=0.0) or 0.0
    opacity = float_or(style.get('opacity'), 1.0)
    shadows = V.box_shadows(style.get('box-shadow'))
    # A `clip-path: path()` is the shape of the fill and of its inner shadow
    # (2.4.0, the versus cards' notch); the radius is then the path's business.
    outline = V.outline(style.get('clip-path'), box.w, box.h)
    drawn = 0

    if bg_image and not gradient:
        url = V.background_url(bg_image)
        if url:
            drawn += target.background_image(box, url, opacity)

    # The outer shadow goes under the fill and over a background image, which
    # is where the PPTX writer has always put it. See the module docstring.
    if any(not s.inset for s in shadows):
        drawn += target.outer_shadow(box, radius, shadows)

    if gradient:
        drawn += target.rect(box, radius, gradient=gradient, outline=outline)
    elif bg_color and bg_color[3] > 0:
        rgba = bg_color if opacity >= 1.0 else (
            bg_color[0], bg_color[1], bg_color[2], bg_color[3] * opacity)
        drawn += target.rect(box, radius, fill=rgba, outline=outline)

    # The inset shadow sits on top of the fill and under the content — where
    # CSS puts it.
    if any(s.inset for s in shadows):
        drawn += target.inset_shadow(box, radius, shadows, outline=outline)

    if box.kind == 'image':
        drawn += target.picture(box, radius=radius, outline=outline)
    elif box.kind == 'chart' and box.chart is not None \
            and box.chart.geometry is not None:
        drawn += target.chart(box, box.chart)
    elif box.kind == 'text' and box.lines:
        drawn += target.text(box, TextStyle(box))
    return drawn


def paint_slide(root, target, index=0):
    """Walk one slide in drawing order. Returns the number of shapes drawn.

    Continue failed boxes to collect diagnostics, then raise PaintError. The
    integer return is reserved for complete output; logs are not the contract.
    """
    diagnostics = []

    def failed(box, exc):
        code = 'ASSET_UNAVAILABLE' if isinstance(exc, _AssetUnavailable) else 'PAINT_FAILED'
        message = str(exc) if code == 'ASSET_UNAVAILABLE' else '%s: %s' % (
            type(exc).__name__, exc)
        diagnostics.append(PaintDiagnostic(code, index, box, message))
        target.failed(box, exc)

    try:
        bg = V.color(root.style.get('background-color'))
        if bg and bg[3] > 0:
            target.background(bg)
    except MemoryError:
        raise
    except Exception as exc:                                # noqa: BLE001
        failed(root, exc)

    # A table stands for its whole subtree: the cells and their text are its
    # contents, not shapes of their own (tables.py).
    found, absorbed = {}, set()
    for box in root.walk():
        if box is not root and tables.is_table(box) and box not in absorbed:
            # A malformed replaced table must stop both adapters rather than
            # disappear behind their best-effort drawing error handlers.
            found[box] = tables.read(box)
            absorbed.update(b for child in box.children for b in child.walk())

    drawn = 0
    for box in paint_order(root):
        if box is root or box in absorbed:
            continue
        try:
            drawn += paint_box(box, target)
            if box in found:
                drawn += target.table(box, found[box])
        except MemoryError:
            # Not one unpaintable element: the process itself is in trouble,
            # and carrying on to the next forty boxes would only hide where.
            raise
        except Exception as exc:                            # noqa: BLE001
            failed(box, exc)
    if diagnostics:
        raise PaintError(diagnostics)
    return drawn
