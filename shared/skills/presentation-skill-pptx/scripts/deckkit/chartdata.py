# -*- coding: utf-8 -*-
"""Chart data from CSV or from the spec itself: categories and series.

No drawing here — `chartgeom` computes one geometry from the `ChartData` and
both media draw it. `CHART_TYPES` lives in `chartgeom` and is re-exported
here for the build-time check in `deck.py`.

Handles one real trap: Excel in a Russian locale exports "Save as CSV"
with ';' as the field separator and ',' as the decimal separator — a plain
`float()` on "12,5" raises, and a plain `csv.reader` would see one column
where there are several. Delimiter is sniffed from the header record; decimal
comma is normalized to a dot before parsing.

Anything that does not fit raises `ChartDataError` — a chart never gets
built from partial or guessed data.
"""
import csv
import io
import math

from .html2pptx.chartgeom import CHART_TYPES, MODES         # noqa: F401
from .model import ChartData, ChartDataError, Series


def load_csv(path, x, y):
    """Read `path` and return a `ChartData`.

    `x` is the header of the category column. `y` is the header of the
    value column, or a list of headers for more than one series.
    """
    try:
        with io.open(path, 'r', encoding='utf-8-sig', newline='') as f:
            text = f.read()
    except (IOError, OSError) as exc:
        raise ChartDataError('cannot read %r: %s' % (path, exc))
    return parse_csv(text, x, y, source=path)


def parse_csv(text, x, y, source='<csv>'):
    """Same as `load_csv`, from already-read text. Split out for tests."""
    y_columns = [y] if isinstance(y, str) else list(y)
    if not y_columns:
        raise ChartDataError('%s: no value column given' % (source,))

    delimiter = _sniff_delimiter(text, [x] + y_columns)
    rows = [row for row in csv.reader(io.StringIO(text), delimiter=delimiter)
            if any(cell.strip() for cell in row)]
    if not rows:
        raise ChartDataError('%s: empty file' % (source,))

    header, body = rows[0], rows[1:]
    if not body:
        raise ChartDataError('%s: header only, no data rows' % (source,))

    index = {}
    for name in [x] + y_columns:
        if name not in header:
            raise ChartDataError(
                '%s: column %r not found — header is %r' % (source, name, header))
        index[name] = header.index(name)

    categories = []
    values = dict((name, []) for name in y_columns)
    for row_number, row in enumerate(body, start=2):
        if len(row) != len(header):
            raise ChartDataError(
                '%s: row %d has %d columns, header has %d'
                % (source, row_number, len(row), len(header)))
        categories.append(row[index[x]].strip())
        for name in y_columns:
            values[name].append(
                _parse_number(row[index[name]], source, row_number, name))

    series = [Series(name, values[name]) for name in y_columns]
    return ChartData(categories, series)


def _sniff_delimiter(text, columns=()):
    """Choose comma, semicolon or tab from the first nonblank header record.

    `csv.Sniffer` is not used: on a two-column file it is as likely to guess
    wrong as right. Parse each candidate with the same reader used below,
    including quoted fields, doubled quotes and multiline headers. Prefer
    matches to the requested column names, then unquoted header separators.
    Ties prefer comma, then semicolon. Column matches disambiguate literal
    quotes and punctuation in unquoted names without inspecting data rows.
    """
    counts = _header_delimiters(text)

    def score(delimiter):
        try:
            reader = csv.reader(io.StringIO(text), delimiter=delimiter)
            header = next((row for row in reader if any(cell.strip() for cell in row)), [])
        except csv.Error:
            # A rejected candidate must not block a readable alternative.
            return (-1, 0)
        return (sum(name in header for name in columns), counts[delimiter])

    return max((',', ';', '\t'), key=score)


def _header_delimiters(text):
    """Count separators outside quoted fields in the first nonblank record.

    Candidate boundaries suffice for ordinary quoted fields; requested header
    names in `_sniff_delimiter` resolve literal quotes after other punctuation.
    """
    counts = dict.fromkeys((',', ';', '\t'), 0)
    quoted, field_start, content = False, True, False
    index = 0
    while index < len(text):
        char = text[index]
        if quoted:
            if char == '"':
                if index + 1 < len(text) and text[index + 1] == '"':
                    index += 1
                    content = True
                else:
                    quoted = False
            elif char.strip():
                content = True
        elif char == '"' and field_start:
            quoted, field_start = True, False
        elif char in '\r\n':
            if content:
                break
            counts = dict.fromkeys(counts, 0)
            field_start = True
        elif char in counts:
            counts[char] += 1
            field_start = True
        else:
            field_start = False
            if char.strip():
                content = True
        index += 1
    return counts


def _parse_number(raw, source, row_number, column):
    text = raw
    if isinstance(raw, str):
        text = raw.strip().replace('\xa0', ' ').replace(' ', '')
        if not text:
            raise ChartDataError(
                '%s: row %d, column %r is empty' % (source, row_number, column))
        if ',' in text and '.' in text:
            if text.rfind(',') > text.rfind('.'):
                # '1.234,5' — dot is a thousands separator, comma is decimal.
                text = text.replace('.', '').replace(',', '.')
            else:
                # '1,234.5' — comma is a thousands separator, dot is decimal.
                text = text.replace(',', '')
        elif ',' in text:
            # '12,5' — the Russian-locale Excel export, comma as decimal point.
            text = text.replace(',', '.')
    nonfinite = '%s: row %d, column %r is not finite: %r' % (
        source, row_number, column, raw)
    try:
        value = float(text)
    except ValueError:
        raise ChartDataError(
            '%s: row %d, column %r is not a number: %r'
            % (source, row_number, column, raw))
    except OverflowError:
        raise ChartDataError(nonfinite)
    if not math.isfinite(value):
        raise ChartDataError(nonfinite)
    return value


def from_inline(obj, source='data'):
    """`{"categories": [...], "series": [{"name": ..., "values": [...]}]}`
    written straight into the spec → `ChartData`.

    Same discipline as the CSV path: every problem is an error that names
    the place, nothing is padded or guessed. Values may be numbers or
    strings in either decimal convention, as in a CSV cell.
    """
    if not isinstance(obj, dict):
        raise ChartDataError('%s: expected an object with "categories" and '
                             '"series"' % source)
    unknown = set(obj) - set(('categories', 'series'))
    if unknown:
        raise ChartDataError('%s: unknown key(s) %s; allowed: categories, '
                             'series' % (source, ', '.join(sorted(unknown))))
    categories = obj.get('categories')
    if (not isinstance(categories, list) or not categories
            or not all(isinstance(c, str) and c.strip() for c in categories)):
        raise ChartDataError('%s: "categories" must be a non-empty list of '
                             'non-empty strings' % source)
    raw_series = obj.get('series')
    if not isinstance(raw_series, list) or not raw_series:
        raise ChartDataError('%s: "series" must be a non-empty list' % source)
    series = []
    for number, item in enumerate(raw_series, start=1):
        where = '%s.series[%d]' % (source, number)
        if not isinstance(item, dict) or set(item) - set(('name', 'values')):
            raise ChartDataError('%s: expected {"name": ..., "values": [...]}'
                                 % where)
        name = item.get('name')
        if not isinstance(name, str) or not name.strip():
            raise ChartDataError('%s: "name" must be a non-empty string'
                                 % where)
        values = item.get('values')
        if not isinstance(values, list) or len(values) != len(categories):
            raise ChartDataError(
                '%s: "values" must be a list of %d numbers, one per category'
                % (where, len(categories)))
        parsed = []
        for index, value in enumerate(values):
            if isinstance(value, bool):
                raise ChartDataError('%s: value %d is a boolean'
                                     % (where, index + 1))
            if isinstance(value, (int, float, str)):
                parsed.append(_parse_number(value, where, index + 1, name))
            else:
                raise ChartDataError('%s: value %d is not a number: %r'
                                     % (where, index + 1, value))
        series.append(Series(name.strip(), parsed))
    return ChartData([c.strip() for c in categories], series)
