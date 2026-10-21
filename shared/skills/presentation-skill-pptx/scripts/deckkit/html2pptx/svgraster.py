"""Minimal SVG rasterizer on Pillow/numpy/lxml.

Replaces cairosvg where it is not available and cannot be installed.
Supports the subset of SVG that actually appears in presentation assets:
rect/circle/ellipse/path (with holes by nonzero/evenodd rule),
linear gradients, embedded base64 images, pattern fill with images,
groups with clipPath/opacity, simple blur (feGaussianBlur/feOffset),
and basic transforms.

Public API:
    rasterize(svg_source, out_width=None, out_height=None, scale=1.0) -> PIL.Image (RGBA)
    rasterize_to_file(svg_source, out_path, out_width=None, out_height=None, scale=1.0) -> str

Unsupported SVG features are logged. Drawing/embedded-image decode failures
propagate: callers must not cache or publish partial pixels as a valid image.
"""
import base64
import io
import logging
import math
import os
import re

import numpy as np
from lxml import etree
from PIL import Image, ImageFilter

from . import values as V

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 3x3 Matrices (affine transforms). Point is a column vector (x, y, 1).
# ---------------------------------------------------------------------------

IDENTITY = np.eye(3, dtype=np.float64)


def mat_translate(tx, ty):
    m = np.eye(3)
    m[0, 2] = tx
    m[1, 2] = ty
    return m


def mat_scale(sx, sy):
    m = np.eye(3)
    m[0, 0] = sx
    m[1, 1] = sy
    return m


def mat_rotate(deg, cx=0.0, cy=0.0):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    m = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
    if cx or cy:
        return mat_translate(cx, cy) @ m @ mat_translate(-cx, -cy)
    return m


def mat_skew_x(deg):
    m = np.eye(3)
    m[0, 1] = math.tan(math.radians(deg))
    return m


def mat_skew_y(deg):
    m = np.eye(3)
    m[1, 0] = math.tan(math.radians(deg))
    return m


_TRANSFORM_RE = re.compile(r'(\w+)\s*\(([^)]*)\)')
_NUM_RE = re.compile(r'[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?')


def _nums(s):
    return [float(x) for x in _NUM_RE.findall(s)]


def parse_transform(s):
    """Parse transform attribute into a single 3x3 matrix (multiplication in order)."""
    m = IDENTITY
    if not s:
        return m
    for name, args in _TRANSFORM_RE.findall(s):
        vals = _nums(args)
        name = name.strip().lower()
        try:
            if name == 'translate':
                tx = vals[0] if vals else 0.0
                ty = vals[1] if len(vals) > 1 else 0.0
                m = m @ mat_translate(tx, ty)
            elif name == 'scale':
                sx = vals[0] if vals else 1.0
                sy = vals[1] if len(vals) > 1 else sx
                m = m @ mat_scale(sx, sy)
            elif name == 'rotate':
                if len(vals) >= 3:
                    m = m @ mat_rotate(vals[0], vals[1], vals[2])
                elif vals:
                    m = m @ mat_rotate(vals[0])
            elif name == 'skewx':
                m = m @ mat_skew_x(vals[0])
            elif name == 'skewy':
                m = m @ mat_skew_y(vals[0])
            elif name == 'matrix' and len(vals) >= 6:
                a, b, c, d, e, f = vals[:6]
                m = m @ np.array([[a, c, e], [b, d, f], [0.0, 0.0, 1.0]])
            else:
                logger.warning('[WARN] unsupported: transform %s(...)', name)
        except (IndexError, ValueError):
            logger.warning('[WARN] failed to parse transform: %s(%s)', name, args)
    return m


def apply_matrix(m, points):
    """points: numpy (N,2) -> (N,2) in new coordinates."""
    if len(points) == 0:
        return points
    pts = np.asarray(points, dtype=np.float64)
    ones = np.ones((pts.shape[0], 1))
    homo = np.hstack([pts, ones])
    out = homo @ m.T
    return out[:, :2]


# ---------------------------------------------------------------------------
# Number/color/style parsing
# ---------------------------------------------------------------------------

def parse_length(s, default=0.0):
    if s is None:
        return default
    if isinstance(s, (int, float)):
        return float(s)
    s = str(s).strip()
    m = re.match(r'^([-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?)', s)
    if not m:
        return default
    return float(m.group(1))


def parse_color(s):
    """Returns (r,g,b,a) 0..255, or None if fill="none"/not specified.

    An adapter over `values.color`, the engine's one colour parser: SVG wants
    alpha in bytes, `none` and `url(...)` as "no solid fill", and an
    unreadable colour drawn black with a warning, as a browser would.
    """
    if s is None:
        return None
    s = s.strip()
    if s == '' or s.lower() == 'none' or s.startswith('url('):
        return None
    rgba = V.color(s)
    if rgba is None:
        logger.warning('[WARN] unsupported color: %s', s)
        return (0, 0, 0, 255)
    return (rgba[0], rgba[1], rgba[2], int(round(rgba[3] * 255)))


def parse_style_attr(s):
    """style="fill:#fff; opacity:0.5" -> dict."""
    out = {}
    if not s:
        return out
    for chunk in s.split(';'):
        if ':' not in chunk:
            continue
        k, v = chunk.split(':', 1)
        out[k.strip().lower()] = v.strip()
    return out


def local_name(elem_or_tag):
    tag = elem_or_tag if isinstance(elem_or_tag, str) else elem_or_tag.tag
    if tag is None:
        return ''
    if isinstance(tag, str) and '}' in tag:
        return tag.split('}', 1)[1]
    return tag


def get_attr(elem, name, default=None):
    """Get attribute, considering style="" (priority) and presentation attribute."""
    style = parse_style_attr(elem.get('style'))
    if name in style:
        return style[name]
    if elem.get(name) is not None:
        return elem.get(name)
    # namespaced attribute (xlink:href, etc.)
    for k, v in elem.attrib.items():
        if k.endswith('}' + name) or k == name:
            return v
    return default


# ---------------------------------------------------------------------------
# Path parsing <path d="...">
# ---------------------------------------------------------------------------

_PARAM_COUNT = {'M': 2, 'L': 2, 'T': 2, 'H': 1, 'V': 1, 'C': 6, 'S': 4, 'Q': 4, 'A': 7, 'Z': 0}


def _parse_path_ops(d):
    """Returns list of (command letter, [numbers]), with implicit repetitions expanded."""
    n = len(d)
    i = 0

    def skip_ws(i):
        while i < n and d[i] in ' \t\r\n,':
            i += 1
        return i

    def read_number(i):
        i = skip_ws(i)
        start = i
        if i < n and d[i] in '+-':
            i += 1
        int_start = i
        while i < n and d[i].isdigit():
            i += 1
        has_int = i > int_start
        has_frac = False
        if i < n and d[i] == '.':
            i += 1
            frac_start = i
            while i < n and d[i].isdigit():
                i += 1
            has_frac = i > frac_start
        if not has_int and not has_frac:
            return None, start
        if i < n and d[i] in 'eE':
            j = i + 1
            if j < n and d[j] in '+-':
                j += 1
            k = j
            while k < n and d[k].isdigit():
                k += 1
            if k > j:
                i = k
        return float(d[start:i]), i

    def read_flag(i):
        i = skip_ws(i)
        if i < n and d[i] in '01':
            return float(d[i]), i + 1
        return None, i

    ops = []
    cur_cmd = None
    while True:
        i = skip_ws(i)
        if i >= n:
            break
        ch = d[i]
        if ch.isalpha():
            cur_cmd = ch
            i += 1
            base = ch.upper()
            if base == 'Z':
                ops.append((cur_cmd, []))
                cur_cmd = None
                continue
        else:
            if cur_cmd is None:
                logger.warning('[WARN] malformed path d, stopping: %r', d[max(0, i - 10):i + 10])
                break
            base = cur_cmd.upper()
        cnt = _PARAM_COUNT.get(base, 0)
        params = []
        ok = True
        for k in range(cnt):
            if base == 'A' and k in (3, 4):
                val, i = read_flag(i)
            else:
                val, i = read_number(i)
            if val is None:
                ok = False
                break
            params.append(val)
        if not ok:
            logger.warning('[WARN] missing parameters for command %s in path', cur_cmd)
            break
        ops.append((cur_cmd, params))
        if cur_cmd in ('M', 'm'):
            # Subsequent implicit pairs after M/m are L/l
            cur_cmd = 'L' if cur_cmd == 'M' else 'l'
    return ops


def _flatten_cubic(p0, p1, p2, p3, n=24):
    pts = []
    for k in range(1, n + 1):
        t = k / n
        mt = 1 - t
        x = (mt ** 3) * p0[0] + 3 * (mt ** 2) * t * p1[0] + 3 * mt * (t ** 2) * p2[0] + (t ** 3) * p3[0]
        y = (mt ** 3) * p0[1] + 3 * (mt ** 2) * t * p1[1] + 3 * mt * (t ** 2) * p2[1] + (t ** 3) * p3[1]
        pts.append((x, y))
    return pts


def _flatten_quad(p0, p1, p2, n=16):
    pts = []
    for k in range(1, n + 1):
        t = k / n
        mt = 1 - t
        x = (mt ** 2) * p0[0] + 2 * mt * t * p1[0] + (t ** 2) * p2[0]
        y = (mt ** 2) * p0[1] + 2 * mt * t * p1[1] + (t ** 2) * p2[1]
        pts.append((x, y))
    return pts


def _angle_between(u, v):
    dot = u[0] * v[0] + u[1] * v[1]
    lu = math.hypot(*u)
    lv = math.hypot(*v)
    if lu == 0 or lv == 0:
        return 0.0
    cosv = max(-1.0, min(1.0, dot / (lu * lv)))
    ang = math.acos(cosv)
    cross = u[0] * v[1] - u[1] * v[0]
    return -ang if cross < 0 else ang


def _flatten_arc(x1, y1, rx, ry, phi_deg, large_arc, sweep, x2, y2):
    """Elliptical arc (endpoint parametrization) -> list of points (excluding start)."""
    if rx == 0 or ry == 0 or (x1 == x2 and y1 == y2):
        return [(x2, y2)]
    rx, ry = abs(rx), abs(ry)
    phi = math.radians(phi_deg)
    cos_phi, sin_phi = math.cos(phi), math.sin(phi)
    dx2, dy2 = (x1 - x2) / 2.0, (y1 - y2) / 2.0
    x1p = cos_phi * dx2 + sin_phi * dy2
    y1p = -sin_phi * dx2 + cos_phi * dy2
    lam = (x1p ** 2) / (rx ** 2) + (y1p ** 2) / (ry ** 2)
    if lam > 1:
        s = math.sqrt(lam)
        rx, ry = rx * s, ry * s
    sign = -1.0 if large_arc == sweep else 1.0
    num = rx ** 2 * ry ** 2 - rx ** 2 * y1p ** 2 - ry ** 2 * x1p ** 2
    den = rx ** 2 * y1p ** 2 + ry ** 2 * x1p ** 2
    co = sign * math.sqrt(max(0.0, num / den)) if den != 0 else 0.0
    cxp = co * rx * y1p / ry
    cyp = -co * ry * x1p / rx
    cx = cos_phi * cxp - sin_phi * cyp + (x1 + x2) / 2.0
    cy = sin_phi * cxp + cos_phi * cyp + (y1 + y2) / 2.0
    theta1 = _angle_between((1, 0), ((x1p - cxp) / rx, (y1p - cyp) / ry))
    dtheta = _angle_between(((x1p - cxp) / rx, (y1p - cyp) / ry), ((-x1p - cxp) / rx, (-y1p - cyp) / ry))
    if not sweep and dtheta > 0:
        dtheta -= 2 * math.pi
    if sweep and dtheta < 0:
        dtheta += 2 * math.pi
    n_seg = max(8, min(96, int(abs(dtheta) / (math.pi / 24)) + 4))
    pts = []
    for k in range(1, n_seg + 1):
        t = k / n_seg
        theta = theta1 + t * dtheta
        ex = cx + rx * math.cos(theta) * cos_phi - ry * math.sin(theta) * sin_phi
        ey = cy + rx * math.cos(theta) * sin_phi + ry * math.sin(theta) * cos_phi
        pts.append((ex, ey))
    return pts


def path_to_subpaths(d):
    """Parse d into list of subpaths: list[list[(x,y)]] (in local coordinates)."""
    ops = _parse_path_ops(d)
    subpaths = []
    cur = []
    cx = cy = 0.0
    first_cubic_ctrl = None  # for S/s
    first_quad_ctrl = None  # for T/t
    prev_quad_ctrl = None  # for T/t
    for cmd, params in ops:
        upper = cmd.upper()
        is_rel = cmd.islower()
        if upper == 'M':
            if cur:
                subpaths.append(cur)
            x, y = params
            if is_rel and subpaths == [] and not cur:
                pass
            if is_rel:
                x += cx
                y += cy
            cx, cy = x, y
            start_x, start_y = cx, cy
            cur = [(cx, cy)]
            prev_cubic_ctrl = prev_quad_ctrl = None
        elif upper == 'L':
            x, y = params
            if is_rel:
                x += cx
                y += cy
            cur.append((x, y))
            cx, cy = x, y
            prev_cubic_ctrl = prev_quad_ctrl = None
        elif upper == 'H':
            x = params[0]
            if is_rel:
                x += cx
            cur.append((x, cy))
            cx = x
            prev_cubic_ctrl = prev_quad_ctrl = None
        elif upper == 'V':
            y = params[0]
            if is_rel:
                y += cy
            cur.append((cx, y))
            cy = y
            prev_cubic_ctrl = prev_quad_ctrl = None
        elif upper == 'C':
            x1, y1, x2, y2, x, y = params
            if is_rel:
                x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy
            pts = _flatten_cubic((cx, cy), (x1, y1), (x2, y2), (x, y))
            cur.extend(pts)
            prev_cubic_ctrl = (x2, y2)
            prev_quad_ctrl = None
            cx, cy = x, y
        elif upper == 'S':
            x2, y2, x, y = params
            if is_rel:
                x2 += cx; y2 += cy; x += cx; y += cy
            if prev_cubic_ctrl is not None:
                x1, y1 = 2 * cx - prev_cubic_ctrl[0], 2 * cy - prev_cubic_ctrl[1]
            else:
                x1, y1 = cx, cy
            pts = _flatten_cubic((cx, cy), (x1, y1), (x2, y2), (x, y))
            cur.extend(pts)
            prev_cubic_ctrl = (x2, y2)
            prev_quad_ctrl = None
            cx, cy = x, y
        elif upper == 'Q':
            x1, y1, x, y = params
            if is_rel:
                x1 += cx; y1 += cy; x += cx; y += cy
            pts = _flatten_quad((cx, cy), (x1, y1), (x, y))
            cur.extend(pts)
            prev_quad_ctrl = (x1, y1)
            prev_cubic_ctrl = None
            cx, cy = x, y
        elif upper == 'T':
            x, y = params
            if is_rel:
                x += cx; y += cy
            if prev_quad_ctrl is not None:
                x1, y1 = 2 * cx - prev_quad_ctrl[0], 2 * cy - prev_quad_ctrl[1]
            else:
                x1, y1 = cx, cy
            pts = _flatten_quad((cx, cy), (x1, y1), (x, y))
            cur.extend(pts)
            prev_quad_ctrl = (x1, y1)
            prev_cubic_ctrl = None
            cx, cy = x, y
        elif upper == 'A':
            rx, ry, rot, laf, sweep, x, y = params
            if is_rel:
                x += cx
                y += cy
            pts = _flatten_arc(cx, cy, rx, ry, rot, bool(laf), bool(sweep), x, y)
            cur.extend(pts)
            cx, cy = x, y
            prev_cubic_ctrl = prev_quad_ctrl = None
        elif upper == 'Z':
            if cur:
                cur.append((start_x, start_y))
                subpaths.append(cur)
            cur = []
            cx, cy = start_x, start_y
            prev_cubic_ctrl = prev_quad_ctrl = None
        else:
            logger.warning('[WARN] unsupported: path command %s', cmd)
    if cur:
        subpaths.append(cur)
    return subpaths


# ---------------------------------------------------------------------------
# Shape geometry (rect/circle/ellipse) in local coordinates
# ---------------------------------------------------------------------------

def _arc_points(cx, cy, rx, ry, a0, a1, n=12):
    pts = []
    for k in range(n + 1):
        t = a0 + (a1 - a0) * k / n
        r = math.radians(t)
        pts.append((cx + rx * math.cos(r), cy + ry * math.sin(r)))
    return pts


def rect_to_polygon(x, y, w, h, rx, ry):
    if w <= 0 or h <= 0:
        return []
    rx = max(0.0, min(rx, w / 2.0))
    ry = max(0.0, min(ry, h / 2.0))
    if rx <= 0 or ry <= 0:
        return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    pts = []
    pts += _arc_points(x + w - rx, y + ry, rx, ry, -90, 0)
    pts += _arc_points(x + w - rx, y + h - ry, rx, ry, 0, 90)
    pts += _arc_points(x + rx, y + h - ry, rx, ry, 90, 180)
    pts += _arc_points(x + rx, y + ry, rx, ry, 180, 270)
    return pts


def ellipse_to_polygon(cx, cy, rx, ry, n=96):
    return _arc_points(cx, cy, rx, ry, 0, 360, n)[:-1]


# ---------------------------------------------------------------------------
# Polygon rasterization (scanline, nonzero/evenodd) with supersampling
# ---------------------------------------------------------------------------

def rasterize_mask(subpaths, width, height, fill_rule='nonzero'):
    """subpaths: list[list[(x,y)]] in pixel coordinates (already transformed).
    Returns bool mask (height, width)."""
    edges_y0, edges_y1, edges_x0, edges_x1, edges_w = [], [], [], [], []
    min_y, max_y = height, 0
    for pts in subpaths:
        n = len(pts)
        if n < 2:
            continue
        for i in range(n):
            x0, y0 = pts[i]
            x1, y1 = pts[(i + 1) % n]
            if y0 == y1:
                continue
            w = 1
            if y0 > y1:
                x0, y0, x1, y1 = x1, y1, x0, y0
                w = -1
            edges_y0.append(y0); edges_y1.append(y1)
            edges_x0.append(x0); edges_x1.append(x1)
            edges_w.append(w)
            min_y = min(min_y, y0)
            max_y = max(max_y, y1)
    mask = np.zeros((height, width), dtype=bool)
    if not edges_y0:
        return mask
    y0s = np.array(edges_y0); y1s = np.array(edges_y1)
    x0s = np.array(edges_x0); x1s = np.array(edges_x1)
    ws = np.array(edges_w)
    row_start = max(0, int(math.floor(min_y)))
    row_end = min(height, int(math.ceil(max_y)) + 1)
    for row in range(row_start, row_end):
        yc = row + 0.5
        active = (y0s <= yc) & (yc < y1s)
        if not np.any(active):
            continue
        xs = x0s[active] + (yc - y0s[active]) * (x1s[active] - x0s[active]) / (y1s[active] - y0s[active])
        wd = ws[active]
        order = np.argsort(xs)
        xs = xs[order]
        wd = wd[order]
        if fill_rule == 'evenodd':
            inside = (np.arange(1, len(xs) + 1) % 2) == 1
        else:
            inside = np.cumsum(wd) != 0
        for i in range(len(xs) - 1):
            if inside[i]:
                xa = xs[i]
                xb = xs[i + 1]
                xa_i = max(0, int(math.ceil(xa - 0.5)))
                xb_i = min(width, int(math.ceil(xb - 0.5)))
                if xb_i > xa_i:
                    mask[row, xa_i:xb_i] = True
    return mask


# ---------------------------------------------------------------------------
# Compositing (straight alpha, "over")
# ---------------------------------------------------------------------------

def composite_over(canvas, x0, y0, src_rgb, src_a):
    """canvas: float64 (H,W,4) in 0..1. src_rgb: (h,w,3) 0..1 or (3,) constant.
    src_a: (h,w) 0..1. Modifies canvas in place in region [y0:y0+h, x0:x0+w]."""
    h, w = src_a.shape
    if h == 0 or w == 0:
        return
    y1, x1 = y0 + h, x0 + w
    cy0, cx0 = max(0, y0), max(0, x0)
    cy1, cx1 = min(canvas.shape[0], y1), min(canvas.shape[1], x1)
    if cy1 <= cy0 or cx1 <= cx0:
        return
    sy0, sx0 = cy0 - y0, cx0 - x0
    sy1, sx1 = sy0 + (cy1 - cy0), sx0 + (cx1 - cx0)
    a = src_a[sy0:sy1, sx0:sx1]
    if np.ndim(src_rgb) == 1:
        rgb = np.broadcast_to(src_rgb, a.shape + (3,))
    else:
        rgb = src_rgb[sy0:sy1, sx0:sx1]
    dst = canvas[cy0:cy1, cx0:cx1]
    dst_rgb = dst[..., :3]
    dst_a = dst[..., 3]
    out_a = a + dst_a * (1 - a)
    with np.errstate(invalid='ignore', divide='ignore'):
        out_rgb = np.where(
            out_a[..., None] > 1e-8,
            (rgb * a[..., None] + dst_rgb * dst_a[..., None] * (1 - a[..., None])) / np.maximum(out_a[..., None], 1e-8),
            dst_rgb,
        )
    dst[..., :3] = out_rgb
    dst[..., 3] = out_a


_SEPARABLE_BLENDS = {
    'multiply': lambda cb, cs: cb * cs,
    'screen': lambda cb, cs: cb + cs - cb * cs,
    'lighten': np.maximum,
    'darken': np.minimum,
    'difference': lambda cb, cs: np.abs(cb - cs),
}


def composite_blend(canvas, src_rgb, src_a, mode):
    """Blend layer onto canvas in specified blend mode.

    `plus-lighter` — additive mode from Compositing spec: premultiplied
    colors and alphas are added with clipping to 1.0. Needed for highlights
    in black-pattern.svg: two blurred ellipses over dark background ADD to
    it, whereas normal compositing would barely show them and the image
    would look flat black.

    Other modes use the formula "first blend color with backdrop, then
    composite with regular source-over".
    """
    if mode in (None, 'normal'):
        composite_over(canvas, 0, 0, src_rgb, src_a)
        return

    dst_rgb = canvas[..., :3]
    dst_a = canvas[..., 3]
    a = src_a[..., None]
    da = dst_a[..., None]

    if mode in ('plus-lighter', 'plus-lighten', 'lighter'):
        out_pm = np.clip(src_rgb * a + dst_rgb * da, 0.0, 1.0)
        out_a = np.clip(src_a + dst_a, 0.0, 1.0)
        with np.errstate(invalid='ignore', divide='ignore'):
            canvas[..., :3] = np.where(out_a[..., None] > 1e-8,
                                       out_pm / np.maximum(out_a[..., None], 1e-8),
                                       dst_rgb)
        canvas[..., 3] = out_a
        return

    func = _SEPARABLE_BLENDS.get(mode)
    if func is None:
        logger.warning('[WARN] unsupported: mix-blend-mode:%s, using normal compositing', mode)
        composite_over(canvas, 0, 0, src_rgb, src_a)
        return

    blended = (1.0 - da) * src_rgb + da * func(dst_rgb, src_rgb)
    composite_over(canvas, 0, 0, np.clip(blended, 0.0, 1.0), src_a)


def blend_mode_of(elem):
    """Read mix-blend-mode from style attribute or same-named attribute."""
    style_attr = get_attr(elem, 'style')
    if style_attr:
        declarations = parse_style_attr(style_attr)
        value = declarations.get('mix-blend-mode')
        if value:
            return value.strip().lower()
    value = get_attr(elem, 'mix-blend-mode')
    return value.strip().lower() if value else None


# ---------------------------------------------------------------------------
# Main renderer
# ---------------------------------------------------------------------------

class _Ctx:
    """Render context for one document."""

    def __init__(self, width, height, ss, id_map):
        self.width = width
        self.height = height
        self.ss = ss  # supersample factor
        self.id_map = id_map


def _collect_ids(root):
    id_map = {}
    for el in root.iter():
        eid = el.get('id')
        if eid:
            id_map[eid] = el
    return id_map


def _resolve_url(value):
    if not value:
        return None
    m = re.match(r'url\(\s*[\'"]?#([^\'")]+)[\'"]?\s*\)', value.strip())
    return m.group(1) if m else None


def _bbox_of_points(pts_list):
    xs = []
    ys = []
    for pts in pts_list:
        for x, y in pts:
            xs.append(x)
            ys.append(y)
    if not xs:
        return 0.0, 0.0, 0.0, 0.0
    return min(xs), min(ys), max(xs), max(ys)


def _get_shape_local_subpaths(elem, tag, warnings):
    """Returns list of subpaths in element's local coordinates (before its transform)."""
    if tag == 'rect':
        x = parse_length(get_attr(elem, 'x', '0'))
        y = parse_length(get_attr(elem, 'y', '0'))
        w = parse_length(get_attr(elem, 'width', '0'))
        h = parse_length(get_attr(elem, 'height', '0'))
        rx_s = get_attr(elem, 'rx')
        ry_s = get_attr(elem, 'ry')
        rx = parse_length(rx_s) if rx_s is not None else None
        ry = parse_length(ry_s) if ry_s is not None else None
        if rx is None and ry is None:
            rx = ry = 0.0
        elif rx is None:
            rx = ry
        elif ry is None:
            ry = rx
        poly = rect_to_polygon(x, y, w, h, rx, ry)
        return [poly] if poly else []
    if tag == 'circle':
        cx = parse_length(get_attr(elem, 'cx', '0'))
        cy = parse_length(get_attr(elem, 'cy', '0'))
        r = parse_length(get_attr(elem, 'r', '0'))
        return [ellipse_to_polygon(cx, cy, r, r)]
    if tag == 'ellipse':
        cx = parse_length(get_attr(elem, 'cx', '0'))
        cy = parse_length(get_attr(elem, 'cy', '0'))
        rx = parse_length(get_attr(elem, 'rx', '0'))
        ry = parse_length(get_attr(elem, 'ry', '0'))
        return [ellipse_to_polygon(cx, cy, rx, ry)]
    if tag == 'path':
        d = get_attr(elem, 'd', '')
        return path_to_subpaths(d)
    if tag in ('polygon', 'polyline'):
        pts_s = get_attr(elem, 'points', '')
        nums = _nums(pts_s)
        pts = list(zip(nums[0::2], nums[1::2]))
        return [pts] if pts else []
    if tag == 'line':
        x1 = parse_length(get_attr(elem, 'x1', '0'))
        y1 = parse_length(get_attr(elem, 'y1', '0'))
        x2 = parse_length(get_attr(elem, 'x2', '0'))
        y2 = parse_length(get_attr(elem, 'y2', '0'))
        return [[(x1, y1), (x2, y2)]]
    return None


def _decode_data_uri_image(href):
    m = re.match(r'data:image/[^;]+;base64,(.*)', href, re.S)
    if not m:
        return None
    raw = base64.b64decode(m.group(1))
    return Image.open(io.BytesIO(raw)).convert('RGBA')


def _find_pattern_image(pattern_elem, id_map):
    """Search for <image> inside pattern or via <use xlink:href> chain."""
    for child in pattern_elem.iter():
        if local_name(child) == 'image':
            return child
        if local_name(child) == 'use':
            href = _resolve_url('url(#%s)' % get_attr(child, 'href', '').lstrip('#')) or get_attr(child, 'href')
            ref_id = href.lstrip('#') if href else None
            if ref_id and ref_id in id_map and local_name(id_map[ref_id]) == 'image':
                return id_map[ref_id]
    return None


def _gradient_stops(grad_elem, id_map, seen=None):
    seen = seen or set()
    gid = grad_elem.get('id')
    if gid in seen:
        return []
    seen.add(gid)
    stops = []
    for child in grad_elem:
        if local_name(child) == 'stop':
            offset_s = get_attr(child, 'offset', '0')
            if offset_s.endswith('%'):
                offset = parse_length(offset_s[:-1]) / 100.0
            else:
                offset = parse_length(offset_s)
            color = get_attr(child, 'stop-color', '#000000')
            opacity_s = get_attr(child, 'stop-opacity', '1')
            opacity = parse_length(opacity_s, 1.0)
            rgba = parse_color(color) or (0, 0, 0, 255)
            a = rgba[3] / 255.0 * max(0.0, min(1.0, opacity))
            stops.append((max(0.0, min(1.0, offset)), rgba[0], rgba[1], rgba[2], a))
    if not stops:
        href = get_attr(grad_elem, 'href')
        ref_id = href.lstrip('#') if href else None
        if ref_id and ref_id in id_map:
            return _gradient_stops(id_map[ref_id], id_map, seen)
    stops.sort(key=lambda s: s[0])
    return stops


def _sample_gradient(stops, t):
    """t: numpy array 0..1 -> (r,g,b,a) arrays 0..1."""
    if not stops:
        z = np.zeros_like(t)
        return z, z, z, z
    offsets = np.array([s[0] for s in stops])
    r = np.array([s[1] for s in stops]) / 255.0
    g = np.array([s[2] for s in stops]) / 255.0
    b = np.array([s[3] for s in stops]) / 255.0
    a = np.array([s[4] for s in stops])
    tc = np.clip(t, 0.0, 1.0)
    return (np.interp(tc, offsets, r), np.interp(tc, offsets, g),
            np.interp(tc, offsets, b), np.interp(tc, offsets, a))


class Renderer:
    def __init__(self, width, height, ss, id_map):
        self.width = width
        self.height = height
        self.ss = ss
        self.id_map = id_map
        self.warned = set()

    def warn_once(self, key, msg, *args):
        if key not in self.warned:
            self.warned.add(key)
            logger.warning(msg, *args)

    def new_layer(self):
        return np.zeros((self.height, self.width, 4), dtype=np.float64)

    # -- fill/gradient/pattern ------------------------------------------------

    def _fill_gradient(self, canvas, mask, bbox_local, ctm, grad_elem, alpha_mult):
        gunits = get_attr(grad_elem, 'gradientUnits', 'objectBoundingBox')
        gtransform = parse_transform(get_attr(grad_elem, 'gradientTransform'))
        x1_s = get_attr(grad_elem, 'x1', '0%')
        y1_s = get_attr(grad_elem, 'y1', '0%')
        x2_s = get_attr(grad_elem, 'x2', '100%')
        y2_s = get_attr(grad_elem, 'y2', '0%')

        def frac_or_abs(s, base_size, base_min):
            s = s.strip()
            if s.endswith('%'):
                return parse_length(s[:-1]) / 100.0
            return parse_length(s)

        bxmin, bymin, bxmax, bymax = bbox_local
        bw = max(bxmax - bxmin, 1e-9)
        bh = max(bymax - bymin, 1e-9)
        if gunits == 'userSpaceOnUse':
            gx1, gy1 = parse_length(x1_s), parse_length(y1_s)
            gx2, gy2 = parse_length(x2_s), parse_length(y2_s)
        else:
            fx1 = frac_or_abs(x1_s, bw, bxmin)
            fy1 = frac_or_abs(y1_s, bh, bymin)
            fx2 = frac_or_abs(x2_s, bw, bxmin)
            fy2 = frac_or_abs(y2_s, bh, bymin)
            gx1, gy1 = bxmin + fx1 * bw, bymin + fy1 * bh
            gx2, gy2 = bxmin + fx2 * bw, bymin + fy2 * bh
        p1, p2 = apply_matrix(gtransform, np.array([[gx1, gy1], [gx2, gy2]]))
        pp1, pp2 = apply_matrix(ctm, np.array([p1, p2]))
        px1, py1 = pp1
        px2, py2 = pp2
        ys, xs = np.nonzero(mask)
        if len(xs) == 0:
            return
        y0, y1b, x0, x1b = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        yy, xx = np.mgrid[y0:y1b, x0:x1b]
        dxv, dyv = (px2 - px1), (py2 - py1)
        len_sq = dxv * dxv + dyv * dyv
        if len_sq < 1e-9:
            t = np.zeros_like(xx, dtype=np.float64)
        else:
            t = ((xx - px1) * dxv + (yy - py1) * dyv) / len_sq
        stops = _gradient_stops(grad_elem, self.id_map)
        r, g, b, a = _sample_gradient(stops, t)
        sub_mask = mask[y0:y1b, x0:x1b]
        src_a = a * sub_mask * alpha_mult
        src_rgb = np.dstack([r, g, b])
        composite_over(canvas, x0, y0, src_rgb, src_a)

    def _fill_pattern(self, canvas, mask, bbox_local, ctm, pattern_elem, alpha_mult):
        """Fill with image from <pattern>.

        The image is stretched to the shape's bounds in ITS coordinate system,
        then transferred to the canvas by the shape's matrix. Previously it
        was stretched directly to the mask bounds and rotation was lost: the
        template's yellow pattern is rotated 90°, so it appeared mirrored on
        the slide.
        """
        img_elem = _find_pattern_image(pattern_elem, self.id_map)
        if img_elem is None:
            self.warn_once('pattern-no-image', '[WARN] unsupported: pattern without nested image')
            return False
        href = get_attr(img_elem, 'href')
        if not href:
            return False
        img = _decode_data_uri_image(href)
        if img is None:
            return False
        if not mask.any():
            return True

        bx0, by0, bx1, by1 = bbox_local
        bw, bh = bx1 - bx0, by1 - by0
        iw, ih = img.size
        if bw <= 0 or bh <= 0 or iw <= 0 or ih <= 0:
            return True

        # Image pixel → shape coordinate system → canvas.
        to_local = np.array([[bw / float(iw), 0.0, bx0],
                             [0.0, bh / float(ih), by0],
                             [0.0, 0.0, 1.0]])
        to_canvas = ctm @ to_local
        try:
            inverse = np.linalg.inv(to_canvas)
        except np.linalg.LinAlgError:
            return True

        # PIL requests inverse mapping coefficients: canvas point → pixel.
        coeffs = (inverse[0, 0], inverse[0, 1], inverse[0, 2],
                  inverse[1, 0], inverse[1, 1], inverse[1, 2])
        warped = img.convert('RGBA').transform(
            (self.width, self.height), Image.AFFINE, coeffs, resample=Image.BICUBIC)

        arr = np.asarray(warped).astype(np.float64) / 255.0
        rgb = arr[..., :3]
        a = arr[..., 3] * mask * alpha_mult
        composite_over(canvas, 0, 0, rgb, a)
        return True

    def _fill_solid(self, canvas, mask, color, alpha_mult):
        r, g, b, a = color
        ys, xs = np.nonzero(mask)
        if len(xs) == 0:
            return
        y0, y1b, x0, x1b = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        sub_mask = mask[y0:y1b, x0:x1b]
        src_a = sub_mask * (a / 255.0) * alpha_mult
        src_rgb = np.array([r / 255.0, g / 255.0, b / 255.0])
        composite_over(canvas, x0, y0, src_rgb, src_a)

    def fill_shape(self, canvas, subpaths_local, ctm, fill_value, fill_rule, alpha_mult):
        if not subpaths_local:
            return
        pixel_subpaths = [apply_matrix(ctm, pts) for pts in subpaths_local]
        mask = rasterize_mask(pixel_subpaths, self.width, self.height, fill_rule)
        if not mask.any():
            return
        url_id = _resolve_url(fill_value) if fill_value else None
        if url_id:
            ref = self.id_map.get(url_id)
            if ref is None:
                self.warn_once('missing-ref-%s' % url_id, '[WARN] unsupported: reference to #%s not found', url_id)
                return
            rtag = local_name(ref)
            if rtag == 'linearGradient':
                bbox_local = _bbox_of_points(subpaths_local)
                self._fill_gradient(canvas, mask, bbox_local, ctm, ref, alpha_mult)
            elif rtag == 'radialGradient':
                self.warn_once('radial', '[WARN] approximated: radialGradient as average color of stops')
                stops = _gradient_stops(ref, self.id_map)
                if stops:
                    mid = stops[len(stops) // 2]
                    self._fill_solid(canvas, mask, (mid[1], mid[2], mid[3], int(mid[4] * 255)), alpha_mult)
            elif rtag == 'pattern':
                self._fill_pattern(canvas, mask, _bbox_of_points(subpaths_local),
                                   ctm, ref, alpha_mult)
            else:
                self.warn_once('unknown-ref-%s' % rtag, '[WARN] unsupported: fill references <%s>', rtag)
            return
        color = parse_color(fill_value) if fill_value else (0, 0, 0, 255)
        if color is None:
            return
        self._fill_solid(canvas, mask, color, alpha_mult)

    # -- filters ------------------------------------------------------------------

    def apply_filter(self, layer, filter_elem, ctm_scale):
        """Apply feGaussianBlur/feOffset to layer (numpy H,W,4 float 0..1) in place.

        Filters are computed on PREMULTIPLIED color, and this is not a detail:
        the layer stores color separately from alpha, and outside the shape RGB
        is zero, i.e. black. Blurring channels independently, PIL drags this
        black into the translucent halo — the light grey ellipse in
        black-pattern.svg turned into a dark smear, `plus-lighter` added almost
        nothing to the background, and the background looked flat black instead
        of grey spots.

        uint8 precision is enough: the quantization error of premultiplied
        color (±0.5/255) grows on inverse division, but during compositing it
        is multiplied by the same alpha and returns to the original half-level.
        """
        alpha = np.clip(layer[..., 3:4], 0.0, 1.0)
        premultiplied = np.concatenate(
            [np.clip(layer[..., :3], 0.0, 1.0) * alpha, alpha], axis=2)
        img = Image.fromarray(
            np.clip(premultiplied * 255.0 + 0.5, 0, 255).astype(np.uint8), mode='RGBA')
        for child in filter_elem:
            cname = local_name(child)
            if cname == 'feGaussianBlur':
                std = _nums(get_attr(child, 'stdDeviation', '0'))
                if not std:
                    continue
                sd = std[0]
                radius = sd * ctm_scale
                if radius > 0.05:
                    img = img.filter(ImageFilter.GaussianBlur(radius=radius))
            elif cname == 'feOffset':
                dx = parse_length(get_attr(child, 'dx', '0')) * ctm_scale
                dy = parse_length(get_attr(child, 'dy', '0')) * ctm_scale
                if dx or dy:
                    shifted = Image.new('RGBA', img.size, (0, 0, 0, 0))
                    shifted.paste(img, (int(round(dx)), int(round(dy))))
                    img = shifted
            elif cname in ('feFlood', 'feBlend', 'feComposite', 'feColorMatrix', 'feMerge', 'feMergeNode', 'feDropShadow'):
                self.warn_once('filter-%s' % cname, '[WARN] approximated/ignored: %s', cname)
            else:
                self.warn_once('filter-%s' % cname, '[WARN] unsupported: filter primitive %s', cname)
        arr = np.asarray(img).astype(np.float64) / 255.0
        out_a = arr[..., 3:4]
        layer[..., :3] = np.where(out_a > 1e-6,
                                  arr[..., :3] / np.maximum(out_a, 1e-6), 0.0)
        layer[..., 3] = arr[..., 3]

    # -- tree traversal ---------------------------------------------------------------

    def render(self, elem, ctm, style, canvas):
        tag = local_name(elem)
        if tag in ('defs', 'clipPath', 'linearGradient', 'radialGradient', 'pattern',
                   'filter', 'symbol', 'title', 'desc', 'metadata', 'style'):
            return  # not rendered directly

        local_tf = parse_transform(get_attr(elem, 'transform'))
        full_ctm = ctm @ local_tf

        # style accumulation
        fill = get_attr(elem, 'fill')
        if fill is None:
            fill = style.get('fill', '#000000')
        fill_opacity = parse_length(get_attr(elem, 'fill-opacity', '1'), 1.0)
        opacity = parse_length(get_attr(elem, 'opacity', '1'), 1.0)
        fill_rule = get_attr(elem, 'fill-rule', style.get('fill_rule', 'nonzero'))
        stroke = get_attr(elem, 'stroke')
        if stroke and stroke.lower() != 'none':
            self.warn_once('stroke', '[WARN] unsupported: stroke attribute ignored')

        new_style = dict(style)
        new_style['fill'] = fill
        new_style['fill_rule'] = fill_rule
        new_style['alpha'] = style.get('alpha', 1.0) * fill_opacity * opacity

        clip_id = _resolve_url(get_attr(elem, 'clip-path'))
        filter_id = _resolve_url(get_attr(elem, 'filter'))
        blend = blend_mode_of(elem)
        if blend in ('normal', ''):
            blend = None
        # Blending applies to the group as a whole, so it needs its own layer.
        needs_layer = bool(clip_id) or bool(filter_id) or bool(blend)

        target = canvas
        if needs_layer:
            target = self.new_layer()

        if tag == 'g' or tag == 'svg' or tag == 'a':
            for child in elem:
                self.render(child, full_ctm, new_style, target)
        elif tag == 'use':
            href = get_attr(elem, 'href')
            ref_id = href.lstrip('#') if href else None
            ref = self.id_map.get(ref_id) if ref_id else None
            if ref is None:
                self.warn_once('use-%s' % ref_id, '[WARN] unsupported: <use> without valid reference #%s', ref_id)
            else:
                ux = parse_length(get_attr(elem, 'x', '0'))
                uy = parse_length(get_attr(elem, 'y', '0'))
                use_ctm = full_ctm @ mat_translate(ux, uy)
                self.render(ref, use_ctm, new_style, target)
        elif tag == 'image':
            self._render_image(elem, full_ctm, new_style, target)
        elif tag in ('rect', 'circle', 'ellipse', 'path', 'polygon', 'polyline', 'line'):
            subpaths = _get_shape_local_subpaths(elem, tag, self.warned)
            if subpaths:
                self.fill_shape(target, subpaths, full_ctm, new_style['fill'], fill_rule, new_style['alpha'])
        else:
            self.warn_once('tag-%s' % tag, '[WARN] unsupported: tag <%s>, trying to render content', tag)
            for child in elem:
                self.render(child, full_ctm, new_style, target)

        if needs_layer:
            if clip_id:
                clip_elem = self.id_map.get(clip_id)
                if clip_elem is not None:
                    clip_mask = self._render_clip_mask(clip_elem, ctm)
                    target[..., 3] *= clip_mask
                else:
                    self.warn_once('clip-%s' % clip_id, '[WARN] unsupported: clipPath #%s not found', clip_id)
            if filter_id:
                filt_elem = self.id_map.get(filter_id)
                if filt_elem is not None:
                    scale = math.sqrt(abs(np.linalg.det(full_ctm[:2, :2]))) if full_ctm.shape == (3, 3) else 1.0
                    self.apply_filter(target, filt_elem, scale)
                else:
                    self.warn_once('filter-%s' % filter_id, '[WARN] unsupported: filter #%s not found', filter_id)
            composite_blend(canvas, target[..., :3], target[..., 3], blend)

    def _render_clip_mask(self, clip_elem, ctm):
        """Rectangular (or arbitrary by shapes) clipPath -> 0..1 mask."""
        mask_total = np.zeros((self.height, self.width), dtype=bool)
        any_shape = False
        for child in clip_elem:
            ctag = local_name(child)
            subpaths = _get_shape_local_subpaths(child, ctag, self.warned)
            if subpaths is None:
                continue
            any_shape = True
            local_tf = parse_transform(get_attr(child, 'transform'))
            pixel_subpaths = [apply_matrix(ctm @ local_tf, pts) for pts in subpaths]
            m = rasterize_mask(pixel_subpaths, self.width, self.height, 'nonzero')
            mask_total |= m
        if not any_shape:
            return np.ones((self.height, self.width), dtype=np.float64)
        return mask_total.astype(np.float64)

    def _render_image(self, elem, ctm, style, canvas):
        href = get_attr(elem, 'href')
        if not href:
            return
        img = _decode_data_uri_image(href)
        if img is None:
            self.warn_once('image-decode', '[WARN] unsupported: <image> without embedded base64 (external links not read)')
            return
        x = parse_length(get_attr(elem, 'x', '0'))
        y = parse_length(get_attr(elem, 'y', '0'))
        w = parse_length(get_attr(elem, 'width', str(img.width)))
        h = parse_length(get_attr(elem, 'height', str(img.height)))
        corners = apply_matrix(ctm, np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]))
        xmin, ymin = corners.min(axis=0)
        xmax, ymax = corners.max(axis=0)
        px0, py0 = int(round(xmin)), int(round(ymin))
        pw, ph = int(round(xmax - xmin)), int(round(ymax - ymin))
        if pw <= 0 or ph <= 0:
            return
        resized = img.resize((pw, ph), Image.LANCZOS)
        arr = np.asarray(resized).astype(np.float64) / 255.0
        alpha_mult = style.get('alpha', 1.0)
        composite_over(canvas, px0, py0, arr[..., :3], arr[..., 3] * alpha_mult)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def _load_root(svg_source):
    if isinstance(svg_source, str) and '<svg' in svg_source:
        data = svg_source.encode('utf-8')
        src_path = None
    else:
        src_path = svg_source
        with open(svg_source, 'rb') as f:
            data = f.read()
    parser = etree.XMLParser(recover=True, resolve_entities=False, huge_tree=True)
    root = etree.fromstring(data, parser=parser)
    return root, src_path


def _svg_intrinsic_size(root):
    vb = get_attr(root, 'viewBox')
    width_attr = parse_length(get_attr(root, 'width'), None) if get_attr(root, 'width') else None
    height_attr = parse_length(get_attr(root, 'height'), None) if get_attr(root, 'height') else None
    if vb:
        nums = _nums(vb)
        if len(nums) == 4:
            vb_x, vb_y, vb_w, vb_h = nums
        else:
            vb_x = vb_y = 0.0
            vb_w = width_attr or 300.0
            vb_h = height_attr or 150.0
    else:
        vb_x = vb_y = 0.0
        vb_w = width_attr or 300.0
        vb_h = height_attr or 150.0
    if width_attr is None:
        width_attr = vb_w
    if height_attr is None:
        height_attr = vb_h
    return vb_x, vb_y, vb_w, vb_h, width_attr, height_attr


def _choose_supersample(out_w, out_h):
    area = out_w * out_h
    if area <= 200 * 200:
        return 4
    if area <= 800 * 800:
        return 3
    return 2


def rasterize(svg_source, out_width=None, out_height=None, scale=1.0):
    """Rasterize SVG (file path or markup string) to PIL.Image RGBA."""
    root, _ = _load_root(svg_source)
    vb_x, vb_y, vb_w, vb_h, intrinsic_w, intrinsic_h = _svg_intrinsic_size(root)
    if vb_w <= 0 or vb_h <= 0:
        logger.warning('[WARN] invalid viewBox/SVG size, using 1x1')
        vb_w = vb_w or 1.0
        vb_h = vb_h or 1.0

    if out_width is not None or out_height is not None:
        final_w = int(round(out_width if out_width is not None else intrinsic_w * (out_height / intrinsic_h)))
        final_h = int(round(out_height if out_height is not None else intrinsic_h * (out_width / intrinsic_w)))
    else:
        final_w = max(1, int(round(intrinsic_w * scale)))
        final_h = max(1, int(round(intrinsic_h * scale)))
    final_w = max(1, final_w)
    final_h = max(1, final_h)

    ss = _choose_supersample(final_w, final_h)
    while final_w * ss * final_h * ss > 60_000_000 and ss > 1:
        ss -= 1

    canvas_w, canvas_h = final_w * ss, final_h * ss
    scale_x = canvas_w / vb_w
    scale_y = canvas_h / vb_h
    root_ctm = mat_scale(scale_x, scale_y) @ mat_translate(-vb_x, -vb_y)

    id_map = _collect_ids(root)
    renderer = Renderer(canvas_w, canvas_h, ss, id_map)
    canvas = renderer.new_layer()
    style0 = {'fill': '#000000', 'fill_rule': 'nonzero', 'alpha': 1.0}
    for child in root:
        renderer.render(child, root_ctm, style0, canvas)

    arr = np.clip(canvas * 255.0, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr, mode='RGBA')
    if ss != 1:
        resample = getattr(Image, 'Resampling', Image).BOX
        img = img.resize((final_w, final_h), resample)
    return img


def rasterize_to_file(svg_source, out_path, out_width=None, out_height=None, scale=1.0):
    """Rasterize and save PNG. Caches by mtime if svg_source is an existing file."""
    src_is_file = isinstance(svg_source, str) and not svg_source.lstrip().startswith('<') and os.path.isfile(svg_source)
    if src_is_file and os.path.isfile(out_path):
        try:
            if os.path.getmtime(out_path) >= os.path.getmtime(svg_source):
                return out_path
        except OSError:
            pass
    img = rasterize(svg_source, out_width=out_width, out_height=out_height, scale=scale)
    out_dir = os.path.dirname(out_path)
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)
    img.save(out_path, 'PNG')
    return out_path
