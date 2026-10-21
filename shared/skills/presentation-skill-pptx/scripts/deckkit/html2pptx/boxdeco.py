# -*- coding: utf-8 -*-
"""Box shadows (`box-shadow`) as images: both sides, inner and outer.

Native PPTX means fall short exactly where the fill is translucent — and the
glass panel has exactly that, `rgba(248, 231, 141, 0.2)`:

* `a:innerShdw` corresponds to inner shadow, but in DrawingML it is computed
  from the shape's alpha channel and would fade with the 20% fill, differently
  in PowerPoint, Keynote and Google Slides (that's why Figma's export has
  `feColorMatrix` with a huge matrix: it "solidifies" alpha before compositing).
  In CSS the inner shadow does not depend on background transparency at all;
* `a:outerShdw` corresponds to outer shadow, but PPTX draws a blurred silhouette
  of the entire shape behind it, and the silhouette shows through the
  translucent fill — the panel gets 30% orange tint. In CSS the outer shadow is
  clipped at the box edge and never gets inside.

So both shadows are drawn here with Pillow and placed as images: outer under
the shape, inner on top. The same layer goes to both PPTX and preview — they
cannot diverge.
"""
import math

from PIL import Image, ImageChops, ImageDraw, ImageFilter

# A ring tens of pixels wide at the rounding edge: at 1× the corners break
# into steps because the roundRect clipping mask is not anti-aliased. Compute
# at double resolution and downscale — the image also goes to PPTX with margin.
SUPERSAMPLE = 2


def rounded_mask(width, height, radius, outline=None, scale=1):
    """Rounded rectangle mask: 255 inside, 0 outside.

    With an `outline` (`clip-path: path()`, in px of the box) the mask is that
    shape instead, drawn at `scale` — the caller supersamples, Pillow's
    polygon has no anti-aliasing of its own.
    """
    width, height = max(1, int(width)), max(1, int(height))
    mask = Image.new('L', (width, height), 0)
    if outline is not None:
        _fill_outline(ImageDraw.Draw(mask), outline, scale, 0, 0, 255)
        return mask
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, width - 1, height - 1], radius=max(0, int(radius)), fill=255)
    return mask


def _fill_outline(draw, outline, scale, dx, dy, fill):
    for polygon in outline.polygons(scale, dx, dy):
        draw.polygon(polygon, fill=fill)


def inset_shadow_layer(width, height, radius, shadows, scale=SUPERSAMPLE,
                       outline=None):
    """RGBA layer with the box's inner shadows. None if there are none."""
    inset = [s for s in shadows if s.inset and s.rgba[3] > 0]
    if not inset:
        return None
    w, h = max(1, int(round(width))), max(1, int(round(height)))
    big = (w * scale, h * scale)
    clip = rounded_mask(big[0], big[1], radius * scale, outline, scale)
    layer = Image.new('RGBA', big, (0, 0, 0, 0))

    # In CSS the first shadow in the list is painted on top — composite in reverse.
    for shadow in reversed(inset):
        alpha = _inset_alpha(big[0], big[1], radius * scale, shadow, scale,
                             outline)
        alpha = ImageChops.multiply(alpha, clip)
        tint = Image.new('RGBA', big, (int(shadow.rgba[0]), int(shadow.rgba[1]),
                                       int(shadow.rgba[2]), 255))
        tint.putalpha(alpha)
        layer.alpha_composite(tint)

    if scale != 1:
        layer = layer.resize((w, h), Image.LANCZOS)
    return layer


def outer_shadow_layer(width, height, radius, shadows, scale=SUPERSAMPLE):
    """RGBA layer with the box's outer shadows and margin in pixels on each edge.

    Returns `(layer, pad)`: the layer is wider than the box by `pad` on each side
    because the shadow extends beyond its edges. None if there are no outer shadows.
    """
    outer = [s for s in shadows if not s.inset and s.rgba[3] > 0]
    if not outer:
        return None
    w, h = max(1, int(round(width))), max(1, int(round(height)))
    pad = outer_pad(shadows)
    big = ((w + 2 * pad) * scale, (h + 2 * pad) * scale)
    # Outer shadow in CSS is clipped at the box edge: "the shadow is not painted
    # inside the border box". Without this it shows through the translucent fill —
    # exactly how PPTX native shadow muddies the glass.
    hole = ImageChops.invert(_shape_mask(big, pad * scale, radius * scale, w * scale,
                                        h * scale))
    layer = Image.new('RGBA', big, (0, 0, 0, 0))

    for shadow in reversed(outer):
        alpha = _outer_alpha(big, pad * scale, radius * scale, w * scale,
                             h * scale, shadow, scale)
        alpha = ImageChops.multiply(alpha, hole)
        tint = Image.new('RGBA', big, (int(shadow.rgba[0]), int(shadow.rgba[1]),
                                       int(shadow.rgba[2]), 255))
        tint.putalpha(alpha)
        layer.alpha_composite(tint)

    if scale != 1:
        layer = layer.resize((w + 2 * pad, h + 2 * pad), Image.LANCZOS)
    return layer, pad


def outer_pad(shadows):
    """Margin around the edges for outer shadows: computed from the shadows themselves, without rendering."""
    outer = [s for s in shadows if not s.inset and s.rgba[3] > 0]
    return max([_reach(s) for s in outer]) if outer else 0


def _reach(shadow):
    """How far the shadow extends beyond the box edges."""
    return int(math.ceil(3 * (shadow.blur / 2.0) + abs(shadow.dx) + abs(shadow.dy)
                         + abs(shadow.spread))) + 2


def _shape_mask(size, pad, radius, width, height):
    """Mask of the box itself on the canvas with margin."""
    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [round(pad), round(pad), round(pad + width - 1), round(pad + height - 1)],
        radius=max(0, int(round(radius))), fill=255)
    return mask


def _outer_alpha(size, pad, radius, width, height, shadow, scale):
    """Alpha for one outer shadow: the box silhouette, shifted, spread, and blurred."""
    sigma = max(0.0, shadow.blur * scale / 2.0)
    dx, dy = shadow.dx * scale, shadow.dy * scale
    spread = shadow.spread * scale

    mask = Image.new('L', size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [round(pad + dx - spread), round(pad + dy - spread),
         round(pad + width - 1 + dx + spread), round(pad + height - 1 + dy + spread)],
        radius=max(0, int(round(radius + spread))), fill=255)
    if sigma > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(sigma))
    if shadow.rgba[3] < 1.0:
        alpha = shadow.rgba[3]
        mask = mask.point(lambda v: int(v * alpha))
    return mask


def _inset_alpha(width, height, radius, shadow, scale, outline=None):
    """Alpha for one inner shadow: the shadow fills everything outside the shifted shape.

    The ring is then blurred and clipped to the shape itself — same as CSS specifies.
    CSS radius blur is a Gaussian with sigma = r/2.
    """
    sigma = max(0.0, shadow.blur * scale / 2.0)
    dx, dy = shadow.dx * scale, shadow.dy * scale
    spread = shadow.spread * scale

    # Margin around edges: otherwise blur would see the edge pixel repeated beyond
    # the canvas (zero inside the shape) and the ring would not appear at straight edges.
    pad = int(math.ceil(3 * sigma + abs(dx) + abs(dy) + abs(spread))) + 2
    mask = Image.new('L', (width + 2 * pad, height + 2 * pad), 255)

    left, top = pad + dx + spread, pad + dy + spread
    right, bottom = pad + width - 1 + dx - spread, pad + height - 1 + dy - spread
    if outline is not None:
        # A path is shifted but not spread: growing a curve inward is not a
        # translation, and the one outline that exists has no spread.
        _fill_outline(ImageDraw.Draw(mask), outline, scale, pad + dx, pad + dy, 0)
    elif right > left and bottom > top:
        ImageDraw.Draw(mask).rounded_rectangle(
            [round(left), round(top), round(right), round(bottom)],
            radius=max(0, int(round(radius - spread))), fill=0)

    if sigma > 0:
        mask = mask.filter(ImageFilter.GaussianBlur(sigma))
    mask = mask.crop((pad, pad, pad + width, pad + height))
    if shadow.rgba[3] < 1.0:
        alpha = shadow.rgba[3]
        mask = mask.point(lambda v: int(v * alpha))
    return mask


def cache_key(shadows, inset):
    """String fingerprint of shadows on one side for the image cache key."""
    return ';'.join(
        '%.2f,%.2f,%.2f,%.2f,%d,%d,%d,%.3f' % (
            s.dx, s.dy, s.blur, s.spread,
            int(s.rgba[0]), int(s.rgba[1]), int(s.rgba[2]), s.rgba[3])
        for s in shadows if bool(s.inset) is inset and s.rgba[3] > 0)
