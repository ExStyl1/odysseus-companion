"""CSS value parsing: lengths, colors, gradients, transforms, shadows.

All geometric values in the converter are in CSS pixels (slide 1920×1080)
and converted to EMU only at PPTX write time.
"""
import logging
import math
import re

log = logging.getLogger(__name__)

EMU_PER_PX = 9525          # 914400 EMU/inch ÷ 96 px/inch
PT_PER_PX = 0.75           # 72 pt/inch ÷ 96 px/inch

# The names both readers of a colour accept - the stylesheet and the SVG
# rasteriser. `none` and `transparent` are not colours and `color` answers
# them before it gets here.
NAMED_COLORS = {
    'black': (0, 0, 0), 'white': (255, 255, 255), 'red': (255, 0, 0),
    'green': (0, 128, 0), 'blue': (0, 0, 255), 'gray': (128, 128, 128),
    'grey': (128, 128, 128), 'yellow': (255, 255, 0), 'orange': (255, 165, 0),
    'purple': (128, 0, 128), 'silver': (192, 192, 192), 'maroon': (128, 0, 0),
    'navy': (0, 0, 128), 'teal': (0, 128, 128), 'olive': (128, 128, 0),
    'lime': (0, 255, 0), 'aqua': (0, 255, 255), 'fuchsia': (255, 0, 255),
    'pink': (255, 192, 203), 'brown': (165, 42, 42), 'gold': (255, 215, 0),
}

_NUM = r'[-+]?\d*\.?\d+'


def px_to_emu(px):
    return int(round(float(px) * EMU_PER_PX))


def px_to_pt(px):
    return float(px) * PT_PER_PX


def length(value, percent_of=None, default=None):
    """CSS length → number in px. `percent_of` is the base for percentages."""
    if value is None:
        return default
    value = str(value).strip().lower()
    if value in ('auto', 'normal', ''):
        return default
    m = re.match(r'^(%s)\s*(px|pt|%%|em|rem)?$' % _NUM, value)
    if not m:
        return default
    num = float(m.group(1))
    unit = m.group(2)
    if unit == '%':
        if percent_of is None:
            return default
        return num * percent_of / 100.0
    if unit == 'pt':
        return num / PT_PER_PX
    return num          # px and unitless treated as px


def is_percent(value):
    return isinstance(value, str) and value.strip().endswith('%')


def color(value, default=None):
    """CSS/SVG color → (r, g, b, a) where a is 0.0..1.0. None if no color.

    The one reading of a colour in the engine. `svgraster.parse_color` is an
    adapter over it (alpha in bytes, its own answer for `none` and `url(`).
    Until 2.1 the two had separate parsers that disagreed: this one read
    `rgb(50%, ...)` as 50 and did not know `#rgba`, the SVG one split
    `rgb()` on commas only and knew eleven fewer names.
    """
    if value is None:
        return default
    value = str(value).strip().lower()
    if not value or value in ('none', 'transparent'):
        return (0, 0, 0, 0.0) if value == 'transparent' else default

    if value.startswith('#'):
        h = value[1:]
        if len(h) in (3, 4):
            h = ''.join(c * 2 for c in h)
        if len(h) == 8:
            try:
                return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16),
                        int(h[6:8], 16) / 255.0)
            except ValueError:
                return default
        if len(h) != 6:
            return default
        try:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 1.0)
        except ValueError:
            return default

    m = re.match(r'^rgba?\(([^)]*)\)$', value)
    if m:
        parts = [p.strip() for p in re.split(r'[,\s/]+', m.group(1)) if p.strip()]
        try:
            r, g, b = (_channel(p) for p in parts[:3])
            a = 1.0
            if len(parts) > 3:
                a = float(parts[3].rstrip('%'))
                if parts[3].endswith('%'):
                    a /= 100.0
        except (ValueError, IndexError):
            return default
        return (r, g, b, a)

    if value in NAMED_COLORS:
        named = NAMED_COLORS[value]
        return (named[0], named[1], named[2], 1.0)

    return default


def _channel(text):
    """One rgb() channel: 0..255, or a percentage of 255."""
    if text.endswith('%'):
        return int(round(float(text[:-1]) * 255 / 100.0))
    return int(round(float(text)))


def to_hex(rgba):
    """(r, g, b, a) → 'RRGGBB' for python-pptx."""
    return '%02X%02X%02X' % (max(0, min(255, int(rgba[0]))),
                             max(0, min(255, int(rgba[1]))),
                             max(0, min(255, int(rgba[2]))))


# ---------------------------------------------------------------- gradients

class Gradient:
    """Linear gradient: angle in CSS degrees + list of stops.

    A corner keyword (`to bottom right`) does not name a fixed angle. CSS
    defines it as the gradient line whose perpendicular passes through the other
    two corners, which is 135 degrees only on a square: on 1920x1080 it is
    150.64. So a keyword is kept as `corner` and resolved once the box is known;
    `angle_deg` stays as the square-box value for callers with no size to hand.
    """

    def __init__(self, angle_deg, stops, corner=None):
        self.angle_deg = angle_deg
        self.stops = stops          # [(position 0..1, (r,g,b,a)), ...]
        self.corner = corner        # (x_sign, y_sign) for a keyword, else None

    def angle_for(self, width=0, height=0):
        """The CSS angle this gradient runs at inside a box of this size."""
        if not self.corner or width <= 0 or height <= 0:
            return self.angle_deg
        x_sign, y_sign = self.corner
        # Perpendicular to the diagonal joining the two corners we do not point
        # at; with y growing downwards a CSS angle A has direction
        # (sin A, -cos A), hence atan2(dx, -dy).
        return math.degrees(math.atan2(x_sign * height, -y_sign * width)) % 360.0

    def pptx_angle(self, width=0, height=0):
        """CSS angle → PPTX angle.

        In CSS 0deg = "up", clockwise. In PPTX (`a:lin/@ang`) 0 = right
        along X axis, clockwise. So offset by 90 degrees.
        """
        return (self.angle_for(width, height) - 90.0) % 360.0


def gradient(value):
    """`linear-gradient(154.85deg, #EDEDED 15.98%, #E2E1E1 95.33%)` → Gradient."""
    if not value or 'linear-gradient' not in value:
        return None
    m = re.search(r'linear-gradient\((.*)\)\s*$', value.strip(), re.S)
    if not m:
        return None

    # Split arguments by top-level commas (rgba() has its own commas inside).
    args, depth, cur = [], 0, ''
    for ch in m.group(1):
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            args.append(cur.strip())
            cur = ''
        else:
            cur += ch
    if cur.strip():
        args.append(cur.strip())
    if not args:
        return None

    angle = 180.0        # CSS default: top to bottom
    corner = None
    first = args[0].lower()
    m_ang = re.match(r'^(%s)deg$' % _NUM, first)
    if m_ang:
        angle = float(m_ang.group(1))
        args = args[1:]
    elif first.startswith('to '):
        # Side keywords are fixed angles. Corner keywords are not — the value
        # here is only the square-box case, and Gradient.angle_for() replaces it
        # once the box size is known.
        sides = {'to top': 0.0, 'to right': 90.0,
                 'to bottom': 180.0, 'to left': 270.0}
        corners = {
            'to top right': ((1, -1), 45.0), 'to right top': ((1, -1), 45.0),
            'to bottom right': ((1, 1), 135.0), 'to right bottom': ((1, 1), 135.0),
            'to bottom left': ((-1, 1), 225.0), 'to left bottom': ((-1, 1), 225.0),
            'to top left': ((-1, -1), 315.0), 'to left top': ((-1, -1), 315.0),
        }
        if first in corners:
            corner, angle = corners[first]
        else:
            angle = sides.get(first, 180.0)
        args = args[1:]

    stops = []
    for i, arg in enumerate(args):
        parts = arg.rsplit(None, 1)
        pos = None
        col_text = arg
        if len(parts) == 2 and parts[1].endswith('%'):
            col_text = parts[0]
            pos = float(parts[1].rstrip('%')) / 100.0
        rgba = color(col_text)
        if rgba is None:
            continue
        stops.append([pos, rgba])

    if not stops:
        return None

    # Fill missing positions evenly (CSS rule).
    if stops[0][0] is None:
        stops[0][0] = 0.0
    if stops[-1][0] is None:
        stops[-1][0] = 1.0
    for i, s in enumerate(stops):
        if s[0] is None:
            prev_i = max(j for j in range(i) if stops[j][0] is not None)
            next_i = min(j for j in range(i + 1, len(stops)) if stops[j][0] is not None)
            span = (stops[next_i][0] - stops[prev_i][0]) / (next_i - prev_i)
            s[0] = stops[prev_i][0] + span * (i - prev_i)

    return Gradient(angle, [(s[0], s[1]) for s in stops], corner)


def background_url(value):
    """Extract path from `url('...')`."""
    if not value:
        return None
    m = re.search(r'url\(\s*[\'"]?([^\'")]+)[\'"]?\s*\)', value)
    return m.group(1) if m else None


# ---------------------------------------------------------------- transform

def transform_offset(value, width, height):
    """`transform` → offset (dx, dy) in px.

    The template uses only translate/translateX/translateY, including
    percentages of the element's own size — this is the centering trick
    `left: 50%; transform: translateX(-50%)`.
    """
    if not value:
        return (0.0, 0.0)
    dx = dy = 0.0
    for name, args in re.findall(r'(translateX|translateY|translate)\(([^)]*)\)', value):
        parts = [p.strip() for p in args.split(',') if p.strip()]
        if not parts:
            continue
        if name == 'translateX':
            dx += length(parts[0], percent_of=width, default=0.0)
        elif name == 'translateY':
            dy += length(parts[0], percent_of=height, default=0.0)
        else:
            dx += length(parts[0], percent_of=width, default=0.0)
            if len(parts) > 1:
                dy += length(parts[1], percent_of=height, default=0.0)
    return (dx, dy)


# ---------------------------------------------------------------- box-shadow

class Shadow:
    def __init__(self, dx, dy, blur, rgba, inset, spread=0.0):
        self.dx, self.dy, self.blur, self.rgba, self.inset = dx, dy, blur, rgba, inset
        self.spread = spread


def box_shadows(value):
    """Parse `box-shadow` (list of shadows via top-level comma)."""
    if not value:
        return []
    items, depth, cur = [], 0, ''
    for ch in value:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ',' and depth == 0:
            items.append(cur.strip())
            cur = ''
        else:
            cur += ch
    if cur.strip():
        items.append(cur.strip())

    out = []
    for item in items:
        inset = 'inset' in item
        item = item.replace('inset', '').strip()
        rgba = None
        m = re.search(r'(rgba?\([^)]*\)|#[0-9A-Fa-f]{3,8})', item)
        if m:
            rgba = color(m.group(1))
            item = item.replace(m.group(1), ' ')
        nums = [length(p, default=None) for p in _split_ws(item)]
        nums = [n for n in nums if n is not None]
        if len(nums) < 2:
            continue
        dx, dy = nums[0], nums[1]
        blur = nums[2] if len(nums) > 2 else 0.0
        spread = nums[3] if len(nums) > 3 else 0.0
        out.append(Shadow(dx, dy, blur, rgba or (0, 0, 0, 0.3), inset, spread))
    return out


def _split_ws(text):
    return [p for p in re.split(r'\s+', text.strip()) if p]


# ---------------------------------------------------------------- clip-path

class Outline:
    """`clip-path: path("…")` — the box's own shape instead of a rectangle.

    `segments` are absolute, in px of the box: ('M', [p]), ('L', [p]),
    ('C', [c1, c2, p]) and ('Z', []). The PPTX writer hands them over as
    a:custGeom, so the shape stays a shape PowerPoint can edit; the preview
    and the shadow images fill `polygons()` instead. `key` fingerprints it for
    the image cache.
    """

    def __init__(self, segments, key):
        self.segments, self.key = segments, key

    def polygons(self, scale=1.0, dx=0.0, dy=0.0, steps=24):
        """Each subpath flattened to points, scaled and shifted."""
        out, cur, last = [], [], (0.0, 0.0)
        for op, pts in self.segments:
            if op == 'M':
                if len(cur) > 2:
                    out.append(cur)
                cur = [pts[0]]
            elif op == 'L':
                cur.append(pts[0])
            elif op == 'C':
                (x0, y0), (x1, y1), (x2, y2), (x3, y3) = (last,) + tuple(pts)
                for i in range(1, steps + 1):
                    t = i / float(steps)
                    u = 1 - t
                    cur.append((u * u * u * x0 + 3 * u * u * t * x1
                                + 3 * u * t * t * x2 + t * t * t * x3,
                                u * u * u * y0 + 3 * u * u * t * y1
                                + 3 * u * t * t * y2 + t * t * t * y3))
            if pts:
                last = pts[-1]
            elif cur:
                last = cur[0]
        if len(cur) > 2:
            out.append(cur)
        return [[(x * scale + dx, y * scale + dy) for x, y in poly]
                for poly in out]


_PATH_TOKEN = re.compile(r'[MLHVCQZmlhvcqz]|' + _NUM + r'(?:[eE][-+]?\d+)?')
_PATH_ARGS = {'M': 2, 'L': 2, 'H': 1, 'V': 1, 'C': 6, 'Q': 4, 'Z': 0}


def outline(value, width=None, height=None):
    """`path("…")` or `shape(…)` → Outline, None for anything else.

    path() is in fixed px: the commands a card outline needs, M L H V C Q Z,
    absolute or relative. shape() is the same outline with coordinates that
    may be percentages or calc(100% - Npx) of the box, `width` × `height` —
    a notch tied to a corner of a card whose size the layout decides (2.4.0,
    the numbered cards). An arc or a smooth curve raises in both: PPTX has
    no segment that matches them one to one, and approximating silently
    would bend the card.
    """
    if not value:
        return None
    if re.match(r'\s*shape\(', value):
        return _shape(value, width, height)
    m = re.match(r'\s*path\(\s*(?:(?:nonzero|evenodd)\s*,\s*)?[\'"]([^\'"]*)[\'"]\s*\)\s*$',
                 value)
    if not m:
        return None
    d = m.group(1)
    stray = re.sub(_PATH_TOKEN, '', d).replace(',', '').strip()
    if stray:
        raise ValueError('clip-path: path() takes M L H V C Q Z only, got %r'
                         % stray[:20])
    tokens = _PATH_TOKEN.findall(d)
    segments, cur, start, i, cmd = [], (0.0, 0.0), (0.0, 0.0), 0, None
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]
            i += 1
        elif cmd is None:
            raise ValueError('clip-path: path() must start with a command')
        upper = cmd.upper()
        count = _PATH_ARGS[upper]
        nums = [float(t) for t in tokens[i:i + count]]
        if len(nums) < count:
            raise ValueError('clip-path: %s needs %d numbers' % (cmd, count))
        i += count
        ox, oy = cur if cmd.islower() else (0.0, 0.0)
        if upper == 'Z':
            segments.append(('Z', []))
            cur = start
            cmd = None
            continue
        if upper == 'H':
            pts = [(nums[0] + ox, cur[1])]
        elif upper == 'V':
            pts = [(cur[0], nums[0] + oy)]
        else:
            pts = [(nums[k] + ox, nums[k + 1] + oy) for k in range(0, count, 2)]
        if upper == 'Q':        # a quadratic is a cubic with 2/3 handles
            (qx, qy), (px, py) = pts
            pts = [(cur[0] + 2 / 3.0 * (qx - cur[0]), cur[1] + 2 / 3.0 * (qy - cur[1])),
                   (px + 2 / 3.0 * (qx - px), py + 2 / 3.0 * (qy - py)), (px, py)]
        op = {'M': 'M', 'C': 'C', 'Q': 'C'}.get(upper, 'L')
        segments.append((op, pts))
        cur = pts[-1]
        if upper == 'M':
            start = cur
            cmd = 'l' if cmd == 'm' else 'L'    # extra pairs after M are lines
    if not segments or segments[0][0] != 'M':
        raise ValueError('clip-path: path() must start with M')
    return Outline(segments, ' '.join(tokens))


_SHAPE_TOKEN = re.compile(r'calc\([^()]*\)|[^\s/]+|/')
_CALC_TERM = re.compile(r'([-+]?)\s*(' + _NUM + r')(px|%)?')


def _coordinate(token, extent):
    """A shape() coordinate: Npx, N%, 0 or calc() of px and % terms."""
    body = token[5:-1] if token.startswith('calc(') else token
    total, pos = 0.0, 0
    body = body.strip()
    while pos < len(body):
        m = _CALC_TERM.match(body, pos)
        if not m or (pos and not m.group(1)):
            raise ValueError('clip-path: shape() coordinate %r' % token)
        number = float(m.group(2)) * (-1 if m.group(1) == '-' else 1)
        if m.group(3) == '%':
            if extent is None:
                raise ValueError('clip-path: shape() %% needs the box size')
            number *= extent / 100.0
        elif m.group(3) is None and number != 0:
            raise ValueError('clip-path: shape() coordinate %r needs px or %%'
                             % token)
        total += number
        pos = m.end()
        while pos < len(body) and body[pos] == ' ':
            pos += 1
    return total


def _shape(value, width, height):
    """`shape([rule,] from x y, line to x y, hline to x, vline to y,
    curve to x y with cx cy [/ cx cy], close)`; `by` for relative moves."""
    m = re.match(r'\s*shape\((.*)\)\s*$', value, re.S)
    if not m:
        raise ValueError('clip-path: malformed shape()')
    parts = [p.strip() for p in re.split(r',(?![^()]*\))', m.group(1))]
    if parts and parts[0] in ('nonzero', 'evenodd'):
        parts = parts[1:]
    segments, cur, start = [], (0.0, 0.0), (0.0, 0.0)

    def point(tokens, relative):
        x = _coordinate(tokens[0], width)
        y = _coordinate(tokens[1], height)
        return (cur[0] + x, cur[1] + y) if relative else (x, y)

    for index, part in enumerate(parts):
        tokens = _SHAPE_TOKEN.findall(part)
        if not tokens:
            raise ValueError('clip-path: empty shape() command')
        word = tokens[0]
        if index == 0:
            if word != 'from' or len(tokens) != 3:
                raise ValueError('clip-path: shape() must start with "from x y"')
            cur = start = point(tokens[1:], False)
            segments.append(('M', [cur]))
            continue
        if word == 'close' and len(tokens) == 1:
            segments.append(('Z', []))
            cur = start
            continue
        if word not in ('line', 'hline', 'vline', 'curve') or len(tokens) < 3 \
                or tokens[1] not in ('to', 'by'):
            raise ValueError('clip-path: shape() takes line, hline, vline, '
                             'curve and close only, got %r' % part[:30])
        relative = tokens[1] == 'by'
        args = tokens[2:]
        if word == 'line' and len(args) == 2:
            pts = [point(args, relative)]
        elif word == 'hline' and len(args) == 1:
            x = _coordinate(args[0], width)
            pts = [((cur[0] if relative else 0.0) + x, cur[1])]
        elif word == 'vline' and len(args) == 1:
            y = _coordinate(args[0], height)
            pts = [(cur[0], (cur[1] if relative else 0.0) + y)]
        elif word == 'curve' and len(args) in (5, 8) and args[2] == 'with' \
                and (len(args) == 5 or args[5] == '/'):
            end = point(args[0:2], relative)
            c1 = point(args[3:5], relative)
            if len(args) == 8:
                pts = [c1, point(args[6:8], relative), end]
            else:   # one control point: a quadratic, as a cubic
                pts = [(cur[0] + 2 / 3.0 * (c1[0] - cur[0]),
                        cur[1] + 2 / 3.0 * (c1[1] - cur[1])),
                       (end[0] + 2 / 3.0 * (c1[0] - end[0]),
                        end[1] + 2 / 3.0 * (c1[1] - end[1])), end]
        else:
            raise ValueError('clip-path: malformed shape() command %r'
                             % part[:30])
        segments.append(('C' if word == 'curve' else 'L', pts))
        cur = pts[-1]
    key = 'shape ' + ' '.join('%s%s' % (op, ['%.2f,%.2f' % p for p in pts])
                              for op, pts in segments)
    return Outline(segments, key)
