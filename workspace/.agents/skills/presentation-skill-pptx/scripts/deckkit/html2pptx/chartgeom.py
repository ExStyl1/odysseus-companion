# -*- coding: utf-8 -*-
"""Chart geometry and colour: what goes where, computed once, drawn twice.

Two things read this module and nothing else about a chart:

  * `html2pptx/chartstyle.py`, which turns the result into a native chart —
    the plot rectangle becomes `c:manualLayout`, the scale becomes the value
    axis' min/max/unit, the colours become per-series or per-point fills;
  * `preview.py`, which draws the same rectangles, points and sectors with
    Pillow.

Before v2.0 the preview drew a matplotlib approximation that AGENTS.md
explicitly allowed to disagree with the PPTX. That licence is withdrawn: the
preview now draws what we *asked PowerPoint for*. Where PowerPoint still does
its own thing — where it sets the tick labels outside the pinned plot
rectangle, how it kerns them — the preview approximates, and stage 4's
desktop calibration measures the difference once.

The same shape as `formula.py`: one parser, two emitters. It sits in the
engine since 2.1 with the data types it reads (`ChartData`, `Series`,
`ChartDataError`), because the layout places a chart in the same pass as its
text; `deckkit` reaches it downwards, and the engine imports nothing of
`deckkit`'s. Nothing here knows
about OOXML or Pillow, and no colour or size lives here — they are read from
`assets/chart-palette.json`, the repository's rule for design values.
"""
import copy
import decimal
import json
import math
import os
import re

from .textmeasure import DEFAULT_FAMILY

# The public chart types. `grouped` is the name an author reaches for when a
# bar chart has several series; it is the same chart.
CHART_TYPES = ('line', 'bar', 'grouped', 'stacked', 'bar_h', 'doughnut')
ALIASES = {'grouped': 'bar'}

# Palette modes over the column chart: `value` paints each bar by its sign.
MODES = ('value',)

_FILENAME = os.path.join('assets', 'chart-palette.json')
_CACHE = {}

# The module lives in scripts/deckkit/html2pptx/, so the skill is three levels
# up — the same directory `fragments.find_skill_dir` gives. The palette belongs
# to the skill's code, not to the document being drawn.
_SKILL_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__),
                                          '..', '..', '..'))


class ChartDataError(Exception):
    """Chart source data does not read: missing file, bad column, non-numeric
    value. Raised, never silently downgraded to a partial chart.
    """
    pass


class Series(object):
    """One numeric series of a chart: name and values, same length as categories."""

    __slots__ = ('name', 'values')

    def __init__(self, name, values):
        self.name = name
        self.values = list(values)

    def __repr__(self):
        return 'Series(%r)' % (self.name,)


class ChartData(object):
    """Categories and one or more series, already validated: same length,
    values already numeric. What both the native chart adapter (render.py)
    and the preview approximation (preview.py) draw from, so the two can
    never disagree about what the data *is* — only about how to draw it.
    """

    __slots__ = ('categories', 'series', 'number_format', 'center')

    def __init__(self, categories, series, number_format=None, center=None):
        self.categories = list(categories)
        self.series = list(series)
        # The Excel format code of the source cells (`0%`, `#,##0.0`), or
        # None: the chart then writes the values with the decimals they carry.
        self.number_format = number_format
        # A doughnut's centre figure as the spec wrote it, or None. It lives
        # in a workbook cell and the chart title shows that cell (2.3.0).
        self.center = center

    def __repr__(self):
        return 'ChartData(%d categories, %d series)' % (
            len(self.categories), len(self.series))


def canonical(chart_type):
    return ALIASES.get(chart_type, chart_type)


# ------------------------------------------------------------------ palette


# The text a chart sets: one size for all of it (2.3.0, `chart_text`), and
# one dense size the whole chart steps down to together.
CHART_TEXT_ROLES = ('axis_tick', 'data_label', 'legend')


def _chart_text(typography):
    """`typography` with each chart-text role given its size.

    The roles carry weight and colour only; the size is `chart_text` for a
    role and `chart_text_dense` for its `_dense` twin, so no role can drift
    off the one size. Those two are given in PowerPoint points (`size_pt`,
    0.75 pt to the px): 22 pt is 29.33 px, and the file gets sz 2200.
    """
    out = dict(typography)
    for name in ('chart_text', 'chart_text_dense'):
        style = dict(typography[name])
        style['size'] = float(style['size_pt']) / 0.75
        out[name] = style
    typography = out
    out = dict(typography)
    for role in CHART_TEXT_ROLES:
        for name, size in ((role, 'chart_text'),
                           (role + '_dense', 'chart_text_dense')):
            style = dict(typography[name])
            if 'size' in style:
                raise ValueError('chart-palette.json typography.%s sets its '
                                 'own size; chart text takes %s' % (name, size))
            style['size'] = typography[size]['size']
            out[name] = style
    return out


def text_roles(dense):
    """(tick role, value-label role) of a chart drawn dense or not."""
    if dense:
        return 'axis_tick_dense', 'data_label_dense'
    return 'axis_tick', 'data_label'


class Palette(object):
    """`assets/chart-palette.json`, checked once and exposed in usable shape.

    Checked here rather than where a colour is used: a malformed hex reaches
    PowerPoint as a corrupt chart part, with no hint which table it came from.
    """

    def __init__(self, data, source='<palette>'):
        self.data = data
        self.source = source
        self.master = [c.upper() for c in data['master']['order']]
        self.tables = {}
        for kind in ('stacked', 'categorical', 'bar_h'):
            rows = {}
            for key, row in data[kind]['by_count'].items():
                colors = [c.upper() for c in row['colors']]
                if len(colors) != int(key):
                    raise ChartDataError('%s: %s[%s] has %d colours'
                                         % (source, kind, key, len(colors)))
                rows[int(key)] = colors
            self.tables[kind] = rows
        for hex_ in self._all_colors():
            if len(hex_) != 6 or any(c not in '0123456789ABCDEF' for c in hex_):
                raise ChartDataError('%s: %r is not RRGGBB' % (source, hex_))
        self.doughnut_max = int(data['doughnut']['max_categories'])
        self.hole_percent = int(data['doughnut']['hole_percent'])
        self.value_colors = (data['value']['positive'].upper(),
                             data['value']['negative'].upper())
        self.must_carry = data['must_carry'].upper()
        text = data['text']
        self.text_on_light = text['on_light'].upper()
        self.text_on_dark = text['on_dark'].upper()
        self.dark_fills = set(c.upper() for c in text['dark_fills'])
        self.type = _chart_text(data['typography'])
        self.axes = data['axes']
        # A series line, in slide px: the palette gives PowerPoint points
        # (2.3.0, 4 pt; 0.75 pt to the px).
        self.line_px = float(data['line']['stroke_pt']) / 0.75
        self.features = data.get('features', {})
        self.gradients = data.get('gradient', {})

    def gradient(self, kind, hex_):
        """The gradient a `hex_` fill takes on a `kind` chart, as
        `([(fraction, 'RRGGBB'), ...], degrees)` - the angle OOXML's a:lin
        reads, clockwise from left to right - or None for a solid fill."""
        conf = self.gradients
        if not conf or hex_.upper() != conf['color'].upper():
            return None
        key = 'doughnut' if kind == 'doughnut' else 'bar'
        if kind not in ('bar', 'stacked', 'bar_h', 'doughnut'):
            return None
        stops = [(pos / 100.0, color.upper())
                 for pos, color in conf[key]['stops']]
        if kind == 'doughnut':
            return stops, float(conf[key]['angle'])
        # From the column's end to the axis: down an upright column, right
        # to left along a bar_h one.
        return stops, 180.0 if kind == 'bar_h' else 90.0

    def _all_colors(self):
        for c in self.master:
            yield c
        for rows in self.tables.values():
            for colors in rows.values():
                for c in colors:
                    yield c

    def limit(self, kind):
        return max(self.tables[kind])

    def table(self, kind, count):
        """The colours for `count` items of a `kind` table, in order."""
        rows = self.tables[kind]
        if count not in rows:
            raise ChartDataError(
                'the chart palette has no %s colours for %d items (it covers '
                '1 to %d)' % (kind, count, self.limit(kind)))
        return list(rows[count])

    def label_color(self, fill):
        """Text colour readable on `fill`."""
        return (self.text_on_dark if fill.upper() in self.dark_fills
                else self.text_on_light)

    def series_colors(self, kind, count):
        """Resolve series colours, including the count-specific bar_h override."""
        if kind == 'bar_h' and count in self.tables['bar_h']:
            return self.table('bar_h', count)
        return self.table('categorical' if kind == 'line' else 'stacked', count)


def load_palette(skill_dir=None):
    path = os.path.join(skill_dir or _SKILL_DIR, _FILENAME)
    palette = _CACHE.get(path)
    if palette is None:
        try:
            with open(path, 'rb') as handle:
                data = json.loads(handle.read().decode('utf-8'))
        except (IOError, OSError, ValueError) as exc:
            raise ChartDataError('cannot read %s: %s' % (path, exc))
        palette = Palette(data, path)
        _CACHE[path] = palette
    return palette


def assign_colors(palette, chart_type, data, mode=None):
    """Colours for one chart, as `{'series': [...]}` or `{'points': [...]}`.

    Which table and what it colours depends on the chart, not on taste:

      * bar kinds colour series from the stacked table, with the accepted
        bar_h override for 2–4 horizontal series; a stack from the bottom up,
        grouped bars in series order; a single-series bar in `value` mode
        paints each bar by its sign;
      * `doughnut` colours slices (points of its one series) clockwise, from
        the categorical table (yellow, then greys);
      * `line` colours series from the categorical table too.

    Raises when the data needs more colours than the designers gave.
    """
    kind = canonical(chart_type)
    series_count = len(data.series)
    if kind == 'doughnut':
        if series_count != 1:
            raise ChartDataError('a doughnut has exactly one series, got %d'
                                 % series_count)
        count = len(data.categories)
        if count > palette.doughnut_max:
            raise ChartDataError(
                'a doughnut takes at most %d categories, got %d — use a '
                'single-column "stacked" chart instead (the designers\' '
                'replacement for a crowded doughnut)'
                % (palette.doughnut_max, count))
        return {'points': palette.table('categorical', count)}
    if mode == 'value':
        if kind not in ('bar', 'bar_h') or series_count != 1:
            raise ChartDataError('"value" mode colours a single-series bar '
                                 'chart by sign')
        positive, negative = palette.value_colors
        return {'points': [positive if v >= 0 else negative
                           for v in data.series[0].values]}
    # Side-by-side bars keep the categorical table's ceiling they had before
    # 2.3.0 took their colours from the stacked table: 14 bars to a group
    # would not read.
    if kind in ('bar', 'bar_h') and series_count > palette.limit('categorical'):
        raise ChartDataError(
            'the chart palette has no %s colours for %d series (it covers '
            '1 to %d)' % (kind, series_count, palette.limit('categorical')))
    return {'series': palette.series_colors(kind, series_count)}


# -------------------------------------------------------------------- scale


class Scale(object):
    """A value axis: minimum, maximum and the step between gridlines."""

    __slots__ = ('minimum', 'maximum', 'step')

    def __init__(self, minimum, maximum, step):
        self.minimum = minimum
        self.maximum = maximum
        self.step = step

    def ticks(self):
        count = int(round((self.maximum - self.minimum) / self.step))
        return [self.minimum + i * self.step for i in range(count + 1)]

    def fraction(self, value):
        """0 at the minimum, 1 at the maximum."""
        span = self.maximum - self.minimum
        return (value - self.minimum) / span if span else 0.0

    def __repr__(self):
        return 'Scale(%g, %g, %g)' % (self.minimum, self.maximum, self.step)


_NICE = (1.0, 2.0, 2.5, 5.0, 10.0)


def value_extent(chart_type, data):
    """The lowest and highest value the axis must show, zero always included.

    Stacked columns stack positive and negative values separately, as
    PowerPoint does, so the extent is per-category sums, not the raw values.
    """
    kind = canonical(chart_type)
    if kind == 'stacked':
        lows, highs = [], []
        for index in range(len(data.categories)):
            column = [s.values[index] for s in data.series]
            highs.append(sum(v for v in column if v > 0))
            lows.append(sum(v for v in column if v < 0))
        return min([0.0] + lows), max([0.0] + highs)
    values = [v for s in data.series for v in s.values]
    return min([0.0] + values), max([0.0] + values)


def nice_scale(low, high, intervals=4, resolution=None):
    """An axis from zero (or below it, for negatives) with round steps.

    The design builds every value axis from zero — `CHART_NOT_FROM_ZERO` in
    the validator is the other half of that rule — so zero is always a tick.
    The step is the smallest 1/2/2.5/5 x 10^k that covers the range in at most
    `intervals` gridline gaps on the larger side, and a whole multiple of
    `resolution` — the smallest step the number format prints (0.01 for
    `0%`): a 2.5 % step under `0%` would read "0% 3% 5% 8%".
    """
    low, high = min(low, 0.0), max(high, 0.0)
    span = high - low
    if span <= 0:
        return Scale(0.0, 1.0, 1.0 / intervals)
    raw = span / float(intervals)
    power = 10.0 ** math.floor(math.log10(raw))
    step = next(n * power for n in _NICE if n * power >= raw - 1e-12
                and _whole(n * power, resolution))
    minimum = -step * math.ceil(-low / step - 1e-9) if low < 0 else 0.0
    maximum = step * math.ceil(high / step - 1e-9) if high > 0 else 0.0
    if maximum == minimum:
        maximum = minimum + step
    return Scale(minimum, maximum, step)


def _whole(step, resolution):
    if not resolution:
        return True
    ratio = step / resolution
    return ratio >= 1 - 1e-9 and abs(ratio - round(ratio)) < 1e-6


def decimals(data, limit=2):
    """How many decimal places the data carries, capped at `limit`."""
    most = 0
    for series in data.series:
        for value in series.values:
            text = ('%.*f' % (limit, value)).rstrip('0')
            if '.' in text:
                most = max(most, len(text.split('.')[1]))
    return most


def format_number(value, places=0, trim=False):
    """`2.4` → `2,4`: slide content is Russian, and so is its decimal mark.

    The PPTX gets a format code instead (`0.0`) and PowerPoint picks the mark
    from the reader's locale — the known locale risk in PROGRESS/AGENTS. The
    preview has no locale and draws the Russian one.
    """
    text = _half_up(value, places)
    if trim and '.' in text:
        # A data label shows the value as written: "2" beside "2,4" (slide
        # 67), not "2,0". The PPTX gets the `General` format for the same
        # effect; axis ticks keep one fixed format.
        text = text.rstrip('0').rstrip('.')
    if text.startswith('-'):
        text = '−' + text[1:]
    return text.replace('.', ',')


def _half_up(value, places):
    """`value` at `places` decimals, a half rounded away from zero.

    PowerPoint rounds a label that way (12.5 % -> 13 %), where Python's
    `round` and `%f` round a half to even and on the binary value (2.675 ->
    2.67). Excel reads a double to 15 significant digits first; so does
    this. A result of zero has no sign.
    """
    exact = decimal.Decimal('%.15g' % value)
    # Quantize needs room for all integer digits, fractional places and a
    # rounding carry. Keep both precision and flags local to this operation.
    precision = max(28, exact.adjusted() + places + 2)
    with decimal.localcontext(decimal.Context(prec=precision)):
        text = format(exact.quantize(decimal.Decimal(1).scaleb(-places),
                                     rounding=decimal.ROUND_HALF_UP), 'f')
    if text.startswith('-') and not text.strip('-0.'):
        text = text[1:]
    return text


def _places_code(places):
    """`0` / `0.00`: the code for `places` decimals.

    Always written with a dot: the code is locale-neutral and PowerPoint
    shows the reader's own decimal mark. On a ru-RU machine that is the comma
    the preview draws; on en-US it is a dot — the locale risk PROGRESS lists,
    and the reason this is not `0,0`, which en-US would read as a thousands
    separator.
    """
    return '0' if not places else '0.' + '0' * places


# The number part of a format code: `0`, `#,##0` with a thousands separator,
# decimals, and trailing commas that divide by a thousand each (`0.0,,`).
_NUMBER = re.compile(r'^(#,##)?0(\.0+)?(,*)$')
# Characters Excel prints as they are without quotes.
_BARE = set(' -+()$/:\u20bd\u20ac\u00a0')


class NumberFormat(object):
    """An Excel number-format code, the subset a chart label needs.

    `0`, `0.0…`, `#,##0`, `%`, trailing `,` (thousands), and literal text in
    quotes or after a backslash: `0%`, `#,##0`, `0.0" млн"`, `#,##0,"K"`.
    The code is written as the .xlsx stores it — a dot for decimals, a comma
    for thousands — which is how a library reads it from the source cell;
    Russian Excel shows the same code as `# ##0,0`.

    Anything else (sections, colours, dates, scientific) raises
    `ChartDataError`: the label would differ from what PowerPoint prints.
    """

    def __init__(self, code):
        self.code = code
        # ('text', s), ('number', None) once, ('percent', '%'): a quoted "%"
        # is text, a bare one scales the value by a hundred.
        self.parts = []
        self.percent = False
        number = None
        i = 0
        while i < len(code):
            char = code[i]
            if char == '"':
                end = code.find('"', i + 1)
                if end < 0:
                    raise self._error('a quote is not closed')
                self.parts.append(('text', code[i + 1:end]))
                i = end + 1
            elif char == '\\' and i + 1 < len(code):
                self.parts.append(('text', code[i + 1]))
                i += 2
            elif char in '0#.,':
                if number is not None:
                    raise self._error('a second number part ("# ##0" is how Russian '
                                       'Excel shows #,##0)')
                start = i
                while i < len(code) and code[i] in '0#.,':
                    i += 1
                number = code[start:i]
                self.parts.append(('number', None))
            elif char == '%':
                self.parts.append(('percent', '%'))
                self.percent = True
                i += 1
            elif char in _BARE:
                self.parts.append(('text', char))
                i += 1
            elif char == ';':
                raise self._error('sections (";") are not supported')
            elif char == '[':
                raise self._error('[colours] and [locales] are not supported')
            else:
                raise self._error('"%s" outside quotes' % char)
        match = _NUMBER.match(number or '')
        if not match:
            raise self._error('the number part %r is not supported'
                              % (number or '',))
        self.grouped = bool(match.group(1))
        self.places = len(match.group(2) or '.') - 1
        self.thousands = len(match.group(3))

    def _error(self, what):
        return ChartDataError(
            'number_format %r: %s. Supported: 0, 0.0, #,##0, 0%%, 0.0%%, '
            'text in quotes - 0.0" млн" - and a trailing comma per thousand - '
            '#,##0,"K"; write the code as the .xlsx stores it, with a dot for '
            'decimals and a comma for thousands' % (self.code, what))

    def scaled(self, value):
        """The value the code prints: x100 for `%`, /1000 per comma."""
        return value * (100 if self.percent else 1) / 1000.0 ** self.thousands

    @property
    def resolution(self):
        """The smallest step between two values the code prints apart."""
        return (10.0 ** -self.places * 1000.0 ** self.thousands
                / (100 if self.percent else 1))

    def render(self, value, places=None):
        """`value` as PowerPoint prints it, with the Russian marks.

        Half up (`_half_up`), a comma for decimals, a no-break space between
        thousands, `−` for a minus at the front of the whole label.
        """
        places = self.places if places is None else places
        text = _half_up(self.scaled(value), places)
        negative = text.startswith('-')
        whole, _, fraction = text.lstrip('-').partition('.')
        if self.grouped:
            groups = []
            while len(whole) > 3:
                groups.insert(0, whole[-3:])
                whole = whole[:-3]
            whole = '\u00a0'.join([whole] + groups)
        number = whole + (',' + fraction if fraction else '')
        out = ''.join(number if kind == 'number' else text
                      for kind, text in self.parts)
        return ('−' if negative else '') + out

    def with_places(self, places):
        """The same code at `places` decimals (an axis drops the zeros its
        ticks all share)."""
        out = []
        for kind, text in self.parts:
            if kind == 'number':
                out.append(('#,##' if self.grouped else '') + _places_code(
                    places) + ',' * self.thousands)
            elif kind == 'percent':
                out.append(text)
            else:
                out.append('\\"' if text == '"' else '"%s"' % text)
        return ''.join(out)


def parse_number_format(code):
    """`code` -> NumberFormat, or None for no code or `General`."""
    if code is None or code == 'General':
        return None
    if not isinstance(code, str) or not code.strip():
        raise ChartDataError('number_format must be an Excel format code '
                             'string such as "0%%" or "#,##0", not %r'
                             % (code,))
    return NumberFormat(code)


class ValueFormat(object):
    """How one chart writes its numbers, the same in both media.

    With a `number_format` the cells, the labels (`sourceLinked`, so an edit
    in Excel keeps it) and the axis take the code. Without one the chart
    writes each value as it is written, "2" beside "2,4", and the cells and
    axis the decimals the data carries — the behaviour before 2.3.0.
    """

    def __init__(self, data):
        self.format = parse_number_format(data.number_format)
        self.places = decimals(data)

    @property
    def cells(self):
        """The code of the workbook's cells (and of a linked label)."""
        return self.format.code if self.format else _places_code(self.places)

    @property
    def linked(self):
        return self.format is not None

    @property
    def resolution(self):
        return self.format.resolution if self.format else None

    def label(self, value):
        if self.format:
            return self.format.render(value)
        return format_number(value, self.places, True)

    def ticks(self, scale):
        """(tick texts, axis code). The axis prints the decimals its step
        needs: zeros every tick shares are dropped, `10,0%` reads `10%`."""
        values = scale.ticks()
        if self.format:
            places = self.format.places
            while places and all(
                    _half_up(self.format.scaled(v), places).endswith('0')
                    for v in values):
                places -= 1
            return ([self.format.render(v, places) for v in values],
                    self.format.with_places(places))
        places = self.places if scale.step % 1 else 0
        if scale.step % 1:
            places = max(places, decimals_of(scale.step))
        return ([format_number(v, places) for v in values],
                _places_code(places))


def decimals_of(value, limit=4):
    text = ('%.*f' % (limit, value)).rstrip('0')
    return len(text.split('.')[1]) if '.' in text else 0


# ----------------------------------------------------------------- geometry


class Rect(object):
    __slots__ = ('x', 'y', 'w', 'h')

    def __init__(self, x, y, w, h):
        self.x, self.y, self.w, self.h = x, y, w, h

    @property
    def right(self):
        return self.x + self.w

    @property
    def bottom(self):
        return self.y + self.h

    def __repr__(self):
        return 'Rect(%.1f, %.1f, %.1f, %.1f)' % (self.x, self.y, self.w, self.h)


class Label(object):
    """A piece of text the chart itself sets: a tick, a category, a value.

    `anchor` is where (`x`, `y`) sits on the text box: two letters, horizontal
    `l`/`c`/`r` then vertical `t`/`m`/`b` — Pillow's convention, minus the
    baseline variants.
    """

    __slots__ = ('text', 'x', 'y', 'role', 'color', 'anchor', 'index',
                 'inside')

    def __init__(self, text, x, y, role, color, anchor, index=None,
                 inside=None):
        self.text, self.x, self.y = text, x, y
        self.role, self.color, self.anchor = role, color, anchor
        # Data labels only: which (series, category) point the label is, and
        # whether it sits inside its bar — the writer turns that into a
        # per-point `c:dLblPos` where it differs from the series default.
        self.index = index
        self.inside = inside

    def __repr__(self):
        return 'Label(%r @ %.1f,%.1f %s)' % (self.text, self.x, self.y,
                                             self.anchor)


class Geometry(object):
    """Everything drawn for one chart, in slide pixels.

    `plot` is the inner plot rectangle — the one `c:manualLayout` pins with
    `layoutTarget inner`. `frame` is the whole graphic frame. `plot_fraction`
    is `plot` in the frame's own 0..1 coordinates, which is the unit
    `manualLayout` wants.
    """

    def __init__(self, chart_type, frame, plot):
        self.chart_type = chart_type
        self.frame = frame
        self.plot = plot
        self.scale = None
        self.gridlines = []       # (y, is_baseline) for columns and lines
        # bar_h's zero line runs down the plot: its x, or None. A column
        # chart's is the baseline entry of `gridlines`.
        self.zero_x = None
        # c:gapWidth of a column chart (`gap_width`), a whole percentage.
        self.gap_width = None
        # c:overlap where the layout departs from the palette's (a crowded
        # bar_h, whose bars touch), else None.
        self.overlap = None
        self.bars = []            # (series_index, category_index, Rect, color)
        self.lines = []           # (series_index, [(x, y), ...], color)
        self.sectors = []         # (start_deg, end_deg, color); 0 = 12 o'clock
        self.ring = None          # (cx, cy, outer_r, inner_r)
        self.labels = []
        # A doughnut's centre figure: a Label at the ring's centre, or None,
        # and its (width, height) in px - the writer places the title by it.
        self.center = None
        self.center_size = None
        # Line charts with LineOptions: filled series as polygons down to the
        # zero line, in drawing order; which points carry a marker; the thin
        # verticals from each point to the axis; points on the plot's edges
        # (`c:crossBetween midCat`) rather than mid-column.
        self.areas = []           # (series_index, [(x, y), ...], color)
        self.markers = {}         # series_index -> [category_index, ...]
        self.drop_lines = False
        self.edge = False
        self.value_axis = False
        self.places = 0
        # How the numbers are written (ValueFormat) and the value axis' code.
        self.values = None
        self.tick_code = '0'
        # What the chart could not seat: text that would run into its
        # neighbours in PowerPoint. The layout does not refuse — it draws the
        # closest thing — and `validate.py` turns each line into an error.
        self.problems = []
        # What it drew less of than asked, without refusing: a doughnut slice
        # too narrow for its percentage even at the dense size. `validate.py`
        # turns each line into a warning.
        self.warnings = []
        # Every text of the chart at chart_text_dense (`layout`), and the
        # role its axis names carry either way.
        self.dense = False
        self.tick_role = 'axis_tick'

    @property
    def plot_fraction(self):
        f, p = self.frame, self.plot
        return ((p.x - f.x) / f.w, (p.y - f.y) / f.h, p.w / f.w, p.h / f.h)


class ChartBox(object):
    """A chart as the layout engine carries it on its `Box`.

    `chart_type`, `data`, `colors` and `mode` are what the markup said (the
    `data-chart` attribute the filler wrote). `geometry` and `palette` are
    filled in by `place`, which the engine calls once the box has its
    rectangle — so a chart is laid out in the same single pass as the text
    around it, and every reader (the PPTX writer, the preview) gets the same
    finished geometry instead of computing its own.
    """

    __slots__ = ('chart_type', 'data', 'colors', 'mode', 'value_labels',
                 'fill', 'dense', 'geometry', 'palette')

    def __init__(self, chart_type, data, colors=None, mode=None,
                 value_labels=None, fill=None, dense=False):
        self.chart_type = chart_type
        self.data = data
        self.colors = colors
        self.mode = mode
        # Line charts only: the spec fields of the same names (LineOptions).
        self.value_labels = value_labels
        self.fill = fill
        # Drawn at chart_text_dense from the start: autofit sets it when the
        # chart's legend does not fit at chart_text (the whole chart steps
        # down together).
        self.dense = dense
        self.geometry = None
        self.palette = None

    def __repr__(self):
        return 'ChartBox(%s%s)' % (self.chart_type,
                                   ', placed' if self.geometry else '')


# `value_labels` strings that labelled one point: withdrawn in 2.3.0 (the
# designers' review). A line is labelled at every point or at none.
WITHDRAWN_LABEL_MODES = ('max', 'last')
# A labelled line chart: at most this many lines and points (2.3.0, the
# designers' review and the author's "8 on every layout").
LABELLED_LINES_MAX = 2
LABELLED_POINTS_MAX = 8


class LineOptions(object):
    """What a line chart draws beyond its lines, from the linear-graphs guide
    (tmp_files/plots_new/linear/7. Linear graphs.png).

    `labels` is None or 'all' (2.3.0 withdrew 'max' and 'last'); a labelled
    point carries a dot in a halo. Of two labelled lines, the higher point
    of each category is labelled above, the lower below. `filled` lists the series drawn as areas, in drawing order
    (`area_order`): all of them or none, and never with labels. A line over
    an area and dots on unlabelled points were withdrawn at the PowerPoint
    gate (2026-09-30); the geometry still handles a partial `filled`.
    """

    __slots__ = ('labels', 'filled')

    def __init__(self, labels=None, filled=()):
        self.labels = labels
        self.filled = list(filled)


def line_options(value_labels, fill, data):
    """The spec's two fields → `LineOptions`, or None when neither is set —
    then the line chart is laid out exactly as before they existed."""
    if not value_labels and not fill:
        return None
    wanted = list(range(len(data.series))) if fill else []
    labels = 'all' if value_labels is True else None
    return LineOptions(labels, area_order(data, wanted))


def area_order(data, filled):
    """The filled series in drawing order, the largest first.

    Areas overlap (`c:grouping standard`): the one drawn later covers the
    one behind it. Largest first keeps every area in sight as long as no two
    of them cross; where they do, the front one hides part of the other and
    the chart lies about it, so that is refused.
    """
    def size(index):
        return sum(abs(v) for v in data.series[index].values)

    order = sorted(filled, key=lambda i: (-size(i), i))
    for position, back in enumerate(order):
        for front in order[position + 1:]:
            pairs = zip(data.series[back].values, data.series[front].values)
            for c_index, (b, f) in enumerate(pairs):
                if b * f >= 0 and abs(f) > abs(b) + 1e-9:
                    raise ChartDataError(
                        'the filled series "%s" and "%s" cross at "%s": the '
                        'area in front hides the one behind - fill only one '
                        'of them, or leave both as lines'
                        % (data.series[back].name, data.series[front].name,
                           data.categories[c_index]))
    return order


def place(chart, frame, fonts, doughnut_count=1):
    """Lay `chart` out inside `frame` (a `Rect`), in place. Returns `chart`.

    Leaves `geometry` None when there is nothing to draw: an empty frame or
    no series. Colours normally arrive resolved (`Layout.normalise` picks
    them at build time, so a doughnut of nine slices fails before anything is
    written); a hand-written fragment without them gets them here. Tick
    labels are measured with the document's own font book, so the room
    reserved for them is the width they will actually have. `doughnut_count`
    counts only doughnuts on this slide, independently of other chart types.
    """
    data = chart.data
    chart.geometry = None
    if frame.w <= 0 or frame.h <= 0 or data is None or not data.series:
        return chart
    palette = load_palette()
    chart_type = canonical(chart.chart_type or 'bar')
    if chart_type == 'doughnut' and doughnut_count > 1:
        # Isolate per-slide typography from the shared cached palette. The
        # ordinary role names keep measurement, preview and native output in sync.
        palette = copy.copy(palette)
        palette.type = dict(palette.type)
        for role in ('doughnut_percent', 'doughnut_center'):
            palette.type[role] = palette.type[role + '_multiple']
    if not chart.colors:
        chart.colors = assign_colors(palette, chart_type, data, chart.mode)

    def measure(text, size, weight):
        return fonts.get(DEFAULT_FAMILY, weight, size).getlength(text)

    line = None
    if chart_type == 'line':
        line = line_options(chart.value_labels, chart.fill, data)
    chart.palette = palette
    chart.geometry = layout(chart_type, data, chart.colors, frame, palette,
                            measure, line, chart.dense)
    return chart


def _style(palette, role):
    return palette.type[role]


def _steps(dense):
    """The sizes a chart may be tried at - chart_text, then the dense one -
    each a step for every text of the chart at once, as the card ladder is
    one size per slide. A chart already dense has the one step."""
    return (True,) if dense else (False, True)


def wrap_words(text, width, style, measure):
    """`text` broken at spaces into lines no wider than `width`.

    What PowerPoint does with a category name once its rotation is pinned to
    0 (`chartstyle._style_axes`). Returns (lines, overhang): `overhang` is how
    far the widest single word runs past `width` — a word is never split, so
    anything above zero prints into the neighbouring category.
    """
    size, weight = style['size'], style['weight']
    lines, overhang = [], 0.0
    for word in text.split():
        overhang = max(overhang, measure(word, size, weight) - width)
        joined = lines[-1] + ' ' + word if lines else word
        if lines and measure(joined, size, weight) <= width:
            lines[-1] = joined
        else:
            lines.append(word)
    return lines or [''], overhang


def layout(chart_type, data, colors, frame, palette, measure, line=None,
           dense=False):
    """Compute the geometry of one chart inside `frame` (a `Rect`).

    `measure(text, size, weight)` returns a text width in pixels — the caller
    passes the document's own font book, so the reserve for tick labels is
    the width the labels will actually have. `line` is a line chart's
    `LineOptions`, or None. `dense` draws every text of the chart at
    `chart_text_dense` from the start; so does a chart of
    `data_label_dense_threshold` series or more. Otherwise a chart steps
    down to it only where its value labels do not fit at `chart_text`, and
    then as a whole: `Geometry.dense` says which size it came out at.
    """
    kind = canonical(chart_type)
    if kind == 'doughnut':
        return _layout_doughnut(data, colors, frame, palette, measure)
    dense = dense or len(data.series) >= palette.type.get(
        'data_label_dense_threshold', 10)
    if kind == 'bar_h':
        return _layout_bar_h(data, colors, frame, palette, measure, dense)
    return _layout_columns(kind, data, colors, frame, palette, measure,
                           line if kind == 'line' else None, dense)


def _series_color(colors, series_index, category_index):
    if 'points' in colors:
        return colors['points'][category_index]
    return colors['series'][series_index]


def _layout_columns(kind, data, colors, frame, palette, measure, line=None,
                    dense=False):
    """Vertical columns and lines; value labels step down once.

    A bar chart — or a line chart with value labels — is laid out at the full
    label size, then at the dense one if two labels run into each other
    (slide 76 of the v2.1.0 stress test: «30003050» over twelve columns);
    still clashing, it is reported. Labels are compared where they actually
    sit, so bars of different heights keep their large labels however narrow
    they are.
    """
    steps = _steps(dense)
    if kind != 'bar' and not (line is not None and line.labels):
        return _columns_at(kind, data, colors, frame, palette, measure,
                           steps[0], line)
    for step in steps:
        geometry = _columns_at(kind, data, colors, frame, palette, measure,
                               step, line)
        role = text_roles(step)[1]
        clash = _label_clash(geometry, _style(palette, role), measure)
        if clash is None:
            return geometry
    advice = ('drop "value_labels" (the value axis comes back), use '
              'fewer categories, or the full-width chart layout'
              if kind == 'line' else
              'use fewer categories or series, the full-width chart layout, '
              'or a line chart')
    geometry.problems.append(
        'the value labels "%s" and "%s" run into each other even at %dpx - %s'
        % (clash + (_style(palette, role)['size'], advice)))
    return geometry


def _label_clash(geometry, style, measure):
    """The first two value labels whose boxes overlap, or None.

    A label's box is its measured width by one em of height, placed by its
    anchor. Every pair is compared, in reading order: on a line chart the
    labels of several series share one x.
    """
    boxes = []
    for label in geometry.labels:
        if label.index is None:
            continue
        w = measure(label.text, style['size'], style['weight'])
        h = style['size']
        x0 = label.x - w / 2.0
        y0 = {'t': label.y, 'm': label.y - h / 2.0}.get(label.anchor[1],
                                                        label.y - h)
        boxes.append((x0, y0, w, h, label.text))
    boxes.sort()
    for position, a in enumerate(boxes):
        for b in boxes[position + 1:]:
            if (min(a[0] + a[2], b[0] + b[2]) > max(a[0], b[0]) + 0.5
                    and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]):
                return a[4], b[4]
    return None


def _columns_at(kind, data, colors, frame, palette, measure, dense,
                line=None):
    """Vertical columns (`bar`, `stacked`) and `line`, every text at
    `chart_text`, or at `chart_text_dense` if `dense`.

    Only the line chart keeps a value axis and gridlines (slide 64). Column
    charts label their exact values and drop the axis — the guide's "no axis
    when exact values are already labelled": stacked columns print each
    segment's value inside it and have no line at all (slide 67, «Работа с
    графиками»); grouped bars print the value above the bar and keep only the
    baseline (slide 69). A line chart labelled at every point follows the
    same rule, with a thin vertical from each point to the axis instead
    (chart 2 of the linear-graphs guide).
    """
    tick_role, label_role = text_roles(dense)
    tick = _style(palette, tick_role)
    # A label carries its role, so the writer and the preview both draw what
    # the height check of a stack's segment below used.
    segment_role = label_role
    segment = _style(palette, segment_role)
    axes = palette.axes
    values = ValueFormat(data)
    places = values.places
    filled = set(line.filled) if line is not None else set()
    labelled_all = line is not None and line.labels == 'all' and not filled
    value_axis = kind == 'line' and not labelled_all
    # Areas run edge to edge (chart 3 of the guide), and a line sharing the
    # plot with them has to use the same category positions.
    edge = bool(filled) and len(data.categories) > 1
    halo_r = 0.0
    if line is not None and line.labels:
        halo_r = palette.data['line']['halo_px'] / 2.0
    problems = []

    scale = nice_scale(*value_extent(kind, data),
                       resolution=values.resolution)
    tick_texts, tick_code = values.ticks(scale)
    left = frame.x
    if value_axis:
        widest = max(measure(t, tick['size'], tick['weight'])
                     for t in tick_texts)
        left += widest + axes['tick_label_gap']
    right = frame.right

    # Category names are set horizontally and wrapped at spaces to their
    # column (slide 43: left to PowerPoint, they turned 45° and cut to «Д…»).
    # The plot gives up a line of height per line of the longest name; a
    # single word wider than its column cannot be helped by wrapping.
    count = len(data.categories)
    # Words are joined up to the column less the spacing; a lone word is
    # refused only once it is wider than the whole column - short names on
    # twelve months («Фев», «Мар») may use the spacing, as PowerPoint does.
    spacing = axes['category_label_spacing']
    if edge:
        # The first and last names are centred on the plot's edges, so half
        # of each hangs outside it: the plot gives that much back, measured at
        # the pitch it will have. Narrowing it only wraps names tighter, so a
        # second pass leaves the reserve sufficient.
        inner_left = left
        for _ in range(2):
            pitch = (right - left) / float(count - 1)
            halves = []
            for name in (data.categories[0], data.categories[-1]):
                lines, _ = wrap_words(name, pitch - spacing, tick, measure)
                halves.append(max(measure(t, tick['size'], tick['weight'])
                                  for t in lines) / 2.0)
            left = max(inner_left, frame.x + halves[0], frame.x + halo_r)
            right = frame.right - max(halves[1], halo_r)
        band = (right - left) / float(count - 1)
    else:
        band = (frame.right - left) / float(count)
    wrapped = []
    for name in data.categories:
        lines, overhang = wrap_words(name, band - spacing, tick, measure)
        overhang -= spacing
        wrapped.append(lines)
        if overhang > 0.5:
            word = max(name.split(), key=lambda w: measure(
                w, tick['size'], tick['weight']))
            problems.append(
                'category "%s" is %d px too wide for its column at %dpx - '
                'shorten it, use fewer categories, or a bar_h chart, which '
                'gives names a whole row' % (word, round(overhang),
                                             tick['size']))
    rows = max(len(lines) for lines in wrapped)

    label = _style(palette, label_role)

    top = frame.y
    if value_axis:
        # Half a label above the top gridline, or its label is clipped.
        top += tick['size'] * 0.6
    elif kind == 'bar':
        # Room for the value printed above the tallest bar.
        top += label['size'] * 1.2 + axes['value_label_gap']
    if line is not None and line.labels:
        # A point at the top of the scale carries its label above its halo.
        top = max(top, frame.y + halo_r + label['size'] * 1.2)
    elif halo_r:
        top = max(top, frame.y + halo_r)
    bottom = (frame.bottom - tick['size'] * 1.2 * rows
              - axes['category_label_gap'])
    plot = Rect(left, top, right - left, bottom - top)
    if line is not None and line.labels and len(data.series) == 2:
        # The lower line's labels hang under its points. PowerPoint sets the
        # category names right under the plot, so room for a label under a
        # point at the bottom of the scale is made inside the plot: the
        # hidden value axis starts that much lower.
        hanging = halo_r + label['size'] * 1.2
        if plot.h > hanging:
            span = scale.maximum - scale.minimum
            scale = Scale(scale.minimum - hanging * span / (plot.h - hanging),
                          scale.maximum, scale.step)

    geometry = Geometry(kind, frame, plot)
    geometry.scale = scale
    geometry.value_axis = value_axis
    geometry.places = places
    geometry.values = values
    geometry.tick_code = tick_code
    geometry.problems = problems
    geometry.dense = dense
    geometry.tick_role = tick_role
    geometry.edge = edge
    # A thin vertical from each point to the axis, under one labelled line
    # only: of two, the upper line's verticals would cross the lower line's
    # labels hanging under its points.
    geometry.drop_lines = labelled_all and len(data.series) == 1

    def y_of(value):
        return plot.bottom - scale.fraction(value) * plot.h

    def x_of(index):
        if edge:
            return plot.x + band * index
        return plot.x + band * (index + 0.5)

    if value_axis:
        for value, text in zip(scale.ticks(), tick_texts):
            geometry.gridlines.append((y_of(value), value == 0))
            geometry.labels.append(Label(
                text, plot.x - axes['tick_label_gap'], y_of(value),
                tick_role, tick.get('color', '333333'), 'rm'))
    elif kind in ('bar', 'line') or _negative(data):
        # Grouped bars keep the baseline (slide 69); any column chart with a
        # value below zero shows where zero is (2.3.0: none under slide
        # 40's negative stacks).
        geometry.gridlines.append((y_of(0.0), True))

    # One label per line: the preview draws what PowerPoint wraps.
    for index, lines in enumerate(wrapped):
        for row, text in enumerate(lines):
            geometry.labels.append(Label(
                text, x_of(index),
                plot.bottom + axes['category_label_gap']
                + row * tick['size'] * 1.2, tick_role,
                tick.get('color', '333333'), 'ct'))

    if kind == 'line':
        for s_index in (line.filled if line is not None else ()):
            values = data.series[s_index].values
            points = [(x_of(i), y_of(v)) for i, v in enumerate(values)]
            points += [(points[-1][0], y_of(0.0)), (points[0][0], y_of(0.0))]
            geometry.areas.append((s_index, points,
                                   colors['series'][s_index]))
        for s_index, series in enumerate(data.series):
            if s_index in filled:
                continue
            points = [(x_of(i), y_of(v))
                      for i, v in enumerate(series.values)]
            geometry.lines.append((s_index, points,
                                   colors['series'][s_index]))
            if line is None:
                continue
            labelled = _labelled(series.values, line.labels)
            if labelled:
                geometry.markers[s_index] = list(labelled)
            for c_index in labelled:
                x, y = points[c_index]
                below = _below(data, s_index, c_index)
                geometry.labels.append(Label(
                    values.label(series.values[c_index]),
                    x, y + halo_r if below else y - halo_r, label_role,
                    palette.text_on_light, 'ct' if below else 'cb',
                    (s_index, c_index), False))
        return geometry

    # OOXML's units: the gap between clusters is a percentage of one bar's
    # width, and a negative overlap is a gap inside the cluster in the same
    # unit. A cluster of n bars is n widths plus (n - 1) inner gaps.
    variant = bar_variant(kind, data)
    geometry.gap_width = gap_width(kind, data, band, palette)
    gap = geometry.gap_width / 100.0
    inner = -axes.get('overlap', {}).get(variant, 0) / 100.0
    inside = variant in axes['labels_inside']
    per_band = 1 if kind == 'stacked' else len(data.series)
    bar_w = band / (per_band + (per_band - 1) * inner + gap)
    for c_index in range(count):
        start = plot.x + band * c_index + bar_w * gap / 2.0
        positive = negative = 0.0
        for s_index, series in enumerate(data.series):
            value = series.values[c_index]
            color = _series_color(colors, s_index, c_index)
            if kind == 'stacked':
                base = positive if value >= 0 else negative
                end = base + value
                if value >= 0:
                    positive = end
                else:
                    negative = end
                x = start
            else:
                base, end = 0.0, value
                x = start + s_index * bar_w * (1.0 + inner)
            y0, y1 = sorted((y_of(base), y_of(end)))
            rect = Rect(x, y0, bar_w, y1 - y0)
            geometry.bars.append((s_index, c_index, rect, color))
            if kind == 'stacked':
                if value and rect.h >= segment['size']:
                    geometry.labels.append(Label(
                        values.label(value), x + bar_w / 2.0,
                        y0 + rect.h / 2.0, segment_role,
                        palette.label_color(color), 'cm',
                        (s_index, c_index), True))
            else:
                text = values.label(value)
                geometry.labels.append(_end_label(
                    text, x + bar_w / 2.0, y0, y1, value >= 0,
                    inside and measure(text, label['size'],
                                       label['weight']) <= bar_w,
                    label_role, label, color, palette, (s_index, c_index)))
    return geometry


def _labelled(values, mode):
    """The indices of a line's points that `mode` (LineOptions.labels)
    labels: all of them, or none."""
    if mode == 'all':
        return list(range(len(values)))
    return []


def _below(data, s_index, c_index):
    """Whether a labelled line point takes its label under it: the lower
    of two lines at that category (on a tie, the second series). Labels
    above both points ran into each other where the lines come close."""
    if len(data.series) != 2:
        return False
    mine = data.series[s_index].values[c_index]
    other = data.series[1 - s_index].values[c_index]
    return mine < other or (mine == other and s_index == 1)


def _negative(data):
    return any(v < 0 for series in data.series for v in series.values)


def gap_width(kind, data, band, palette, clusters=True):
    """c:gapWidth that leaves `axes.bar_gap_px` between columns (clusters)
    whose category band is `band` px - the same gap on every chart, the
    columns taking the rest (2.3.0, the designers' review).

    OOXML's unit is a percentage of one bar's width; a band is n bars, the
    gaps inside a cluster (`c:overlap`, a percentage too) and the gap. It is
    a whole number in the file, so the layout draws with the rounded value,
    as PowerPoint does. Never more than half a band, nor past OOXML's 500.
    """
    axes = palette.axes
    inner = -axes.get('overlap', {}).get(bar_variant(kind, data), 0) / 100.0
    count = 1 if kind == 'stacked' else len(data.series)
    if clusters and count > 1 and axes.get('cluster_gap_width') is not None:
        # Clusters (2.4.0, charts_new): the designers' percentage itself, so
        # the gap grows with the bars and the groups stay apart.
        return int(axes['cluster_gap_width'])
    gap_px = min(axes['bar_gap_px'], band / 2.0)
    bar = (band - gap_px) / (count + (count - 1) * inner)
    return int(round(min(500.0, 100.0 * gap_px / bar)))


def bar_variant(kind, data):
    """Which gap/label row of the palette a column chart reads."""
    if kind == 'bar' and len(data.series) == 1:
        return 'bar_single'
    return kind


def _end_label(text, x, y0, y1, positive, inside, role, style, fill, palette,
               index):
    """A column's value label at its far end — inside the bar or beyond it.

    Inside needs the bar to hold the label with a gap on both sides, and to
    be at least as wide as the label (the caller's `inside`); a short or
    narrow bar gets it outside, in the page's text colour, rather than a
    label overhanging its own bar — white on a grey bar's edge is lost on the
    white plate.
    """
    gap = palette.axes['value_label_gap']
    fits = (y1 - y0) >= style['size'] * 1.2 + 2 * gap
    if inside and fits:
        if positive:
            return Label(text, x, y0 + gap, role,
                         palette.label_color(fill), 'ct', index, True)
        return Label(text, x, y1 - gap, role,
                     palette.label_color(fill), 'cb', index, True)
    if positive:
        return Label(text, x, y0 - gap, role, palette.text_on_light,
                     'cb', index, False)
    return Label(text, x, y1 + gap, role, palette.text_on_light, 'ct',
                 index, False)


def _layout_bar_h(data, colors, frame, palette, measure, dense=False):
    """Horizontal bars: categories down the left, values at the bar ends.

    Slide 65: no value axis, bars almost touching, each value inside its bar
    at the far end. The category names take the reserve the tick labels take
    on a column chart. Room for a label past the bar end is still reserved on
    the right, for the short bars whose label does not fit inside.
    """
    axes = palette.axes
    values = ValueFormat(data)
    problems = []
    # Labels of adjacent bars sit one above the other: a label taller than
    # its bar prints into the next one's (slide 88: 8 series x 4 quarters,
    # 25 px bars under 32 px labels). The bar's thickness depends on the
    # frame's height only, so it is known before anything else.
    count = len(data.categories)
    per_band = len(data.series)
    smallest = _style(palette, text_roles(True)[1])['size']
    for clusters in (True, False):
        # The clusters' gaps, inside (as on upright columns; 2.4.0, bar_h
        # had none) and between. A crowded chart gives them up before its
        # labels: past the dense label size, the bars touch and the
        # clusters are the one column gap apart, as in 2.3.0.
        inner = (-axes.get('overlap', {}).get('bar_h', 0) / 100.0
                 if clusters else 0.0)
        width = gap_width('bar_h', data, frame.h / float(count), palette,
                          clusters)
        gap = width / 100.0
        slots = per_band + (per_band - 1) * inner + gap
        thickness = frame.h / float(count) / slots
        if thickness >= smallest:
            break
    for dense in _steps(dense):
        tick_role, label_role = text_roles(dense)
        if _style(palette, label_role)['size'] <= thickness:
            break
    else:
        problems.append(
            'the value labels do not fit even at %dpx: the bars are %d px '
            'thick - use fewer series or categories, or split the chart'
            % (_style(palette, label_role)['size'], round(thickness)))
    tick = _style(palette, tick_role)
    label = _style(palette, label_role)
    widest = max(measure(name, tick['size'], tick['weight'])
                 for name in data.categories)
    # PowerPoint gives the names no more than this, whatever room the plot
    # leaves, and cuts a longer one with «…» (v2.2.0 stress test, slide 61).
    room = frame.w * axes['bar_h_name_share']
    for name in data.categories:
        over = measure(name, tick['size'], tick['weight']) - room
        if over > 0.5:
            problems.append(
                'category "%s" is %d px wider than PowerPoint prints a bar_h '
                'name at %dpx (%d px) - it would be cut with «…»; shorten it'
                % (name, round(over), tick['size'], round(room)))
    value_room = max(measure(values.label(v), label['size'],
                             label['weight'])
                     for s in data.series for v in s.values)
    left = frame.x + widest + axes['tick_label_gap']
    right = frame.right - value_room - axes['value_label_gap']
    plot = Rect(left, frame.y, right - left, frame.h)
    scale = nice_scale(*value_extent('bar_h', data),
                       resolution=values.resolution)

    geometry = Geometry('bar_h', frame, plot)
    geometry.scale = scale
    geometry.places = values.places
    geometry.values = values
    geometry.problems = problems
    geometry.dense = dense
    geometry.tick_role = tick_role
    geometry.gap_width = width
    if not clusters:
        geometry.overlap = 0
    if _negative(data):
        geometry.zero_x = plot.x + scale.fraction(0.0) * plot.w
    band = plot.h / float(count)
    inside = 'bar_h' in axes['labels_inside']
    bar_h = band / slots

    def x_of(value):
        return plot.x + scale.fraction(value) * plot.w

    # PowerPoint draws the first category at the bottom of a bar chart; the
    # writer reverses the category axis (`c:orientation maxMin`) so the first
    # one reads at the top, and this follows the order the reader sees.
    for c_index, name in enumerate(data.categories):
        top = plot.y + band * c_index
        geometry.labels.append(Label(
            name, plot.x - axes['tick_label_gap'], top + band / 2.0,
            tick_role, tick.get('color', '333333'), 'rm'))
        for s_index, series in enumerate(data.series):
            value = series.values[c_index]
            color = _series_color(colors, s_index, c_index)
            x0, x1 = sorted((x_of(0.0), x_of(value)))
            y = top + bar_h * gap / 2.0 + s_index * bar_h * (1.0 + inner)
            geometry.bars.append((s_index, c_index,
                                  Rect(x0, y, x1 - x0, bar_h), color))
            text = values.label(value)
            room = measure(text, label['size'], label['weight'])
            gap_px = axes['value_label_gap']
            if inside and (x1 - x0) >= room + 2 * gap_px:
                geometry.labels.append(Label(
                    text, x1 - gap_px, y + bar_h / 2.0, label_role,
                    palette.label_color(color), 'rm', (s_index, c_index),
                    True))
            else:
                geometry.labels.append(Label(
                    text, x1 + gap_px, y + bar_h / 2.0, label_role,
                    palette.text_on_light, 'lm', (s_index, c_index), False))
    return geometry


def _layout_doughnut(data, colors, frame, palette, measure):
    """The ring fills the frame's inscribed circle; slices run clockwise from
    12 o'clock (`firstSliceAng` 0), each labelled with its percentage midway
    through the ring. The legend is a layout box, not a chart part, so it is
    not here. The centre figure is a chart part since 2.3.0: the chart title,
    linked to a workbook cell, so an edit in Excel reaches it as it reaches
    the slices. It is one line at `doughnut_center` and has to fit the hole.
    """
    side = min(frame.w, frame.h)
    plot = Rect(frame.x + (frame.w - side) / 2.0,
                frame.y + (frame.h - side) / 2.0, side, side)
    geometry = Geometry('doughnut', frame, plot)
    cx, cy = plot.x + side / 2.0, plot.y + side / 2.0
    outer = side / 2.0
    inner = outer * palette.hole_percent / 100.0
    geometry.ring = (cx, cy, outer, inner)

    values = data.series[0].values
    if any(v < 0 for v in values):
        raise ChartDataError('a doughnut cannot show negative values')
    total = float(sum(values))
    if total <= 0:
        raise ChartDataError('a doughnut needs a positive total')
    middle = (outer + inner) / 2.0
    angle = 0.0
    for index, value in enumerate(values):
        sweep = 360.0 * value / total
        geometry.sectors.append((angle, angle + sweep,
                                 colors['points'][index]))
        angle += sweep
    # P10: fixed size per slide; omit percentages that do not fit the arc.
    geometry.labels = _ring_labels(geometry, values, total, colors, palette,
                                   measure, 'doughnut_percent')
    seated = set(label.index[1] for label in geometry.labels)
    for index, value in enumerate(values):
        if value and index not in seated:
            geometry.warnings.append(
                'the slice "%s" (%s) is too narrow for its percentage at '
                '%g pt; the percentage is hidden, but the slice and legend '
                'remain - use a wider chart or bar_h to show every value'
                % (data.categories[index], _percent(value, total),
                   _style(palette, 'doughnut_percent')['size'] * .75))
    if data.center:
        style = _style(palette, 'doughnut_center')
        geometry.center = Label(data.center, cx, cy, 'doughnut_center',
                                palette.text_on_light, 'cm')
        width = measure(data.center, style['size'], style['weight'])
        geometry.center_size = (width, style['size'] * CENTER_LINE)
        room = 2.0 * inner * CENTER_ROOM
        if width > room:
            geometry.problems.append(
                'the centre figure "%s" is %dpx wide and the hole holds %dpx '
                '- keep "center" to the number and its unit (about %d '
                'characters), and put the words into the chart title'
                % (data.center, width, room,
                   max(1, int(len(data.center) * room / width))))
    return geometry


# The share of the hole's diameter the centre figure may take: the rest is
# air between the figure and the ring. Its line is 1.2 type sizes tall.
CENTER_ROOM = 0.85
CENTER_LINE = 1.2


def _percent(value, total):
    # PowerPoint's `0%` of the slice's share, half up: 12.5 % reads 13 %.
    return _half_up(100.0 * value / total, 0) + '%'


def _ring_labels(geometry, values, total, colors, palette, measure, role):
    """The percentage labels of a ring at `role`, of the slices they fit.

    A slice too narrow for its percentage goes unlabelled, as a thin stacked
    segment does, rather than printing into its neighbours' labels: the arc
    through the middle of the ring has to hold the text with a quarter of
    the type size to spare.
    """
    cx, cy, outer, inner = geometry.ring
    middle = (outer + inner) / 2.0
    style = _style(palette, role)
    labels = []
    for index, (start, end, color) in enumerate(geometry.sectors):
        text = _percent(values[index], total)
        room = middle * math.radians(end - start)
        need = measure(text, style['size'], style['weight']) \
            + style['size'] * 0.25
        if values[index] and room >= need:
            mid = math.radians((start + end) / 2.0)
            labels.append(Label(
                text,
                cx + middle * math.sin(mid), cy - middle * math.cos(mid),
                role, palette.label_color(color), 'cm', (0, index), True))
    return labels
