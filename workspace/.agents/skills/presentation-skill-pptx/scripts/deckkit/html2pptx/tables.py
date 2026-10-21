# -*- coding: utf-8 -*-
"""A native table read off boxes the CSS engine has already laid out.

The engine markup is an ordinary flex tree with ``data-table`` on its root:

    <div data-table>                    one table
      <div class="...">                 a row: its children are the cells
        <div class="...">               a cell: its text boxes are paragraphs
          <p>...</p>

Nothing is measured here. Column widths are the widths of the first row's
cells, row heights the heights of the rows, and every paragraph is a text box
whose lines, size, face and colour the layout engine has decided - so the
PPTX writer (one ``a:tbl``) and the preview (pixels) draw one geometry, the
way they do for a chart.

CSS read here and nowhere else in the engine: ``border-top`` and
``border-bottom`` on a row or a cell (a row's applies to all its cells, a
cell's wins), as ``<width> solid <colour>``. They are table rules: the engine
draws no borders anywhere else, and they take no room in the layout.

A cell holds text only: one paragraph per text box, no list markers. Lists
in cells were prototyped three ways (picture bullet, overlaid picture, none)
and the author kept none (2026-10-09); an image inside a table is an error.
"""
import math

from . import values as V
from .formula import MathRun


class Border(object):
    __slots__ = ('width', 'rgba')

    def __init__(self, width, rgba):
        self.width = width
        self.rgba = rgba

    def __eq__(self, other):
        return isinstance(other, Border) and (self.width, self.rgba) == (
            other.width, other.rgba)

    def __repr__(self):
        return 'Border(%g, %s)' % (self.width, V.to_hex(self.rgba))


def border(value):
    """``3px solid #333`` → Border, ``none``/missing → None."""
    if not value:
        return None
    text = value.strip()
    if text.lower() in ('none', '0', '0px'):
        return None
    width, rgba = None, None
    for token in _tokens(text):
        low = token.lower()
        if low in ('solid', 'none', 'hidden'):
            if low != 'solid':
                return None
            continue
        if width is None:
            size = V.length(token, default=None)
            if size is not None:
                width = size
                continue
        found = V.color(token)
        if found is not None:
            rgba = found
            continue
        raise ValueError('unsupported table border %r' % value)
    if width is None or rgba is None:
        raise ValueError('a table border is "<width> solid <colour>", not %r'
                         % value)
    if not math.isfinite(width) or width <= 0:
        return None
    return Border(width, rgba)


def _tokens(text):
    out, depth, cur = [], 0, ''
    for ch in text:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch.isspace() and depth == 0:
            if cur:
                out.append(cur)
            cur = ''
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


class Paragraph(object):
    """One text box of a cell and the room above it."""

    __slots__ = ('box', 'space_before')

    def __init__(self, box, space_before):
        self.box = box
        self.space_before = space_before


class Cell(object):
    __slots__ = ('box', 'paragraphs', 'anchor', 'margins', 'top', 'bottom')

    def __init__(self, box, paragraphs, anchor, margins, top, bottom):
        self.box = box
        self.paragraphs = paragraphs
        self.anchor = anchor            # 't', 'ctr' or 'b'
        self.margins = margins          # left, top, right, bottom in px
        self.top = top                  # Border or None
        self.bottom = bottom


class Table(object):
    __slots__ = ('box', 'x', 'y', 'columns', 'rows', 'cells')

    def __init__(self, box, x, y, columns, rows, cells):
        self.box = box
        self.x = x
        self.y = y
        self.columns = columns          # widths, px
        self.rows = rows                # heights, px
        self.cells = cells              # [row][column] -> Cell

    @property
    def width(self):
        return sum(self.columns)

    @property
    def height(self):
        return sum(self.rows)

    def boxes(self):
        """Every box the table stands for, itself excluded."""
        found = []
        for child in self.box.children:
            found.extend(child.walk())
        return found


def is_table(box):
    return box.el is not None and box.el.get('data-table') is not None


def read(box):
    """The table this box roots, or None."""
    if not is_table(box):
        return None
    rows = list(box.children)
    if not rows:
        raise ValueError('a table needs at least one row')
    first = [cell for cell in rows[0].children]
    if not first:
        raise ValueError('a table row needs at least one cell')
    columns = [cell.w for cell in first]
    if any(not math.isfinite(width) or width <= 0 for width in columns):
        raise ValueError('table columns need finite positive widths')
    edges = [round(cell.x, 2) for cell in first]
    cells, heights = [], []
    previous_bottom = None
    next_y = rows[0].y
    for number, row in enumerate(rows, 1):
        if not math.isfinite(row.h) or row.h <= 0 \
                or abs(row.y - next_y) > 0.05:
            raise ValueError('table rows must be contiguous and have positive heights')
        next_y = row.y + row.h
        found = list(row.children)
        if [round(cell.x, 2) for cell in found] != edges \
                or [round(cell.w, 2) for cell in found] \
                != [round(w, 2) for w in columns]:
            raise ValueError('table row %d does not line up with the first '
                             'row: every row needs the same columns' % number)
        row_top = border(row.style.get('border-top'))
        row_bottom = border(row.style.get('border-bottom'))
        line = []
        next_x = first[0].x
        for cell in found:
            if abs(cell.x - next_x) > 0.05 \
                    or abs(cell.y - row.y) > 0.05 \
                    or abs(cell.h - row.h) > 0.05:
                raise ValueError('table cells must tile their row without gaps')
            next_x = cell.x + cell.w
            top = border(cell.style.get('border-top')) or row_top
            bottom = border(cell.style.get('border-bottom')) or row_bottom
            line.append(_cell(cell, row, top, bottom))
        # One edge, one line: PowerPoint draws a cell's top and the bottom of
        # the cell above on the same edge, and two different answers there
        # come out as whichever it paints last.
        if previous_bottom is not None:
            for above, below in zip(previous_bottom, line):
                if below.top is None:
                    below.top = above.bottom
                elif above.bottom is None:
                    above.bottom = below.top
                elif above.bottom != below.top:
                    raise ValueError('adjacent table cells disagree on their shared border')
        previous_bottom = line
        cells.append(line)
        heights.append(row.h)
    return Table(box, first[0].x, rows[0].y, columns, heights, cells)


_ANCHORS = {'center': 'ctr', 'flex-end': 'b', 'end': 'b'}


def _cell(cell, row, top, bottom):
    style = cell.style
    margins = tuple(V.length(style.get('padding-' + side), default=0.0) or 0.0
                    for side in ('left', 'top', 'right', 'bottom'))
    if (style.get('display') or '').strip() == 'flex' \
            and (style.get('flex-direction') or '').startswith('column'):
        anchor = _ANCHORS.get((style.get('justify-content') or '').strip(), 't')
    else:
        anchor = 't'
    paragraphs = []
    bottom_of_last = None
    for text in _paragraphs(cell):
        space = 0.0 if bottom_of_last is None else max(
            0.0, text.y - bottom_of_last)
        paragraphs.append(Paragraph(text, space))
        bottom_of_last = text.y + sum(text.line_heights)
    return Cell(cell, paragraphs, anchor, margins, top, bottom)


def _paragraphs(cell):
    """The cell's text boxes in document order; nothing else may be there."""
    out = []

    def append_text(box):
        if any(isinstance(run, MathRun) for line in box.lines for run in line):
            raise ValueError('formulas are not supported in table cells')
        if box.lines:
            out.append(box)

    if cell.tag in ('ul', 'ol', 'li'):
        raise ValueError('lists are not supported in table cells')
    if cell.kind == 'text':
        append_text(cell)
        return out

    def visit(box):
        for child in box.children:
            if child.kind == 'text':
                append_text(child)
            elif child.kind == 'container':
                if is_table(child) or child.tag in ('ul', 'ol', 'li'):
                    raise ValueError('nested tables and lists are not supported in table cells')
                visit(child)
            else:
                raise ValueError('a table cell holds text only, not %s '
                                 '(lists and pictures in cells are not '
                                 'supported)' % child.kind)
    visit(cell)
    return out


def text_of(box):
    """Measured runs with None between lines, emitted as native hard breaks.

    Never guess a space between lines: the break can be explicit or inside
    a long word, and its position is already decided by the shared layout.
    """
    runs = []
    for index, line in enumerate(box.lines):
        if index:
            runs.append(None)
        runs.extend(line)
    return runs
