"""Движок раскладки: HTML + CSS → абсолютные прямоугольники на слайде 1920×1080.

Реализует то подмножество CSS, которым реально пользуется шаблон презентаций:

  * `position: absolute` — от padding-box ближайшего позиционированного предка,
    включая пары left/right и top/bottom и `transform: translate(...)`;
  * `display: flex` — строка и колонка, `flex-grow`, `gap`, `align-items`,
    `justify-content`, сжатие при переполнении;
  * `display: grid` — `repeat(N, 1fr)`, дробные и px-треки, `grid-column` /
    `grid-row` с `span`, автораскладка, раздельные gap по осям;
  * обычный блочный поток с margin'ами;
  * `padding` при `box-sizing: border-box` (в шаблоне он глобальный),
    `max-width`, `min-width`.

Благодаря этому все 19 типов шаблонных слайдов раскладываются одним кодом —
отдельные рендереры под каждый тип не нужны.
"""
import json
import logging
import re

from . import values as V
from . import chartgeom
from .chartgeom import ChartData, Series
from .formula import MATH_LINE_DESCENT_EM, MathRun, math_metrics
from .textmeasure import (DEFAULT_FAMILY, Run, baseline_offset,
                          line_height_px, measure_runs, normalize_weight,
                          wrap_runs)

log = logging.getLogger(__name__)

SLIDE_W = 1920.0
SLIDE_H = 1080.0

# Теги, которые считаются строчным оформлением внутри текстового блока.
INLINE_TAGS = {'strong', 'b', 'em', 'i', 'u', 's', 'span', 'br', 'a', 'sup', 'sub'}
# Теги, которые сами по себе не рисуются.
SKIP_TAGS = {'script', 'style', 'defs', 'title', 'meta', 'link'}


class GridPlacementError(ValueError):
    """A grid placement cannot be represented by the engine."""


class GridAxisError(GridPlacementError):
    """A grid axis is malformed or outside the supported syntax subset."""


class Box:
    """Узел дерева раскладки с посчитанным абсолютным прямоугольником."""

    def __init__(self, el, style, kind):
        self.el = el
        self.style = style
        self.kind = kind              # 'container' | 'text' | 'image' | 'chart'
        self.children = []
        self.x = self.y = 0.0
        self.w = self.h = 0.0
        self.lines = []               # для kind == 'text': список списков Run
        self.line_height = 0.0         # nominal CSS line height
        self.line_heights = []        # measured height for each wrapped line
        self.line_baselines = []      # baseline from each line's top
        self.line_widths = []         # width of each wrapped line, no trailing space
        self.font_size = 0.0
        self.src = None               # для kind == 'image': путь или разметка svg
        self.is_svg = False
        self.chart = None             # для kind == 'chart': chartgeom.ChartBox
        self.z_index = 0
        self.order = 0                # порядок в документе, для стабильной сортировки

    @property
    def tag(self):
        return str(self.el.tag) if self.el is not None else '?'

    def classes(self):
        return set((self.el.get('class') or '').split()) if self.el is not None else set()

    def walk(self):
        yield self
        for child in self.children:
            for node in child.walk():
                yield node

    def __repr__(self):
        return '<Box %s %s %.0f,%.0f %.0fx%.0f>' % (
            self.tag, self.kind, self.x, self.y, self.w, self.h)


# ------------------------------------------------------------------ текст

# HTML collapses ASCII whitespace only. `\s` would also match U+00A0 and turn
# every non-breaking space `typeset.py` wrote back into a break point.
_WS_RE = re.compile(r'[ \t\n\f\r]+')


def extract_segments(el, base_weight=400):
    """Достать текст элемента как сегменты, разделённые <br>.

    Каждый сегмент — список Run (кусок текста + вес начертания). <strong>/<b>
    дают вес 700. Пробелы схлопываются по правилам HTML.
    """
    segments = [[]]

    def push(text, weight):
        if not text:
            return
        segments[-1].append(Run(text, weight))

    def visit(node, weight):
        if node.text:
            push(_WS_RE.sub(' ', node.text), weight)
        for child in node:
            tag = str(child.tag).lower() if isinstance(child.tag, str) else ''
            classes = set((child.get('class') or '').split())
            if tag == 'br':
                segments.append([])
            elif tag == 'span' and 'math' in classes and child.get('data-latex'):
                segments[-1].append(MathRun(child.get('data-latex'),
                                            child.get('data-mathtext') or '',
                                            weight))
            elif tag in ('strong', 'b'):
                visit(child, 700)
            elif tag in SKIP_TAGS:
                pass
            else:
                visit(child, weight)
            if child.tail:
                push(_WS_RE.sub(' ', child.tail), weight)

    visit(el, base_weight)

    # Collapse prose whitespace at segment edges without converting MathRun back
    # into a plain Run (which would expose its LaTeX source in the deck).
    cleaned = []
    for seg in segments:
        runs = [r if isinstance(r, MathRun) else Run(r.text, r.weight)
                for r in seg if isinstance(r, MathRun) or r.text]
        if runs and not isinstance(runs[0], MathRun):
            runs[0] = Run(runs[0].text.lstrip(), runs[0].weight)
        if runs and not isinstance(runs[-1], MathRun):
            runs[-1] = Run(runs[-1].text.rstrip(), runs[-1].weight)
        runs = [r for r in runs if isinstance(r, MathRun) or r.text]
        cleaned.append(runs)
    while cleaned and not cleaned[-1]:
        cleaned.pop()
    return cleaned or [[]]


def _decode_chart(raw):
    """`data-chart` JSON attribute → `chartgeom.ChartBox`, not yet placed.

    The round trip through `build.py`'s serialize-to-disk and back cannot
    carry a Python object, so `slides.py`'s `chart` filler encodes the
    `ChartData` its data already produced as JSON on the marker element, and
    this is the other end of that trip.
    """
    payload = json.loads(raw)
    series = [Series(s['name'], s['values']) for s in payload.get('series', [])]
    return chartgeom.ChartBox(payload.get('type'),
                              ChartData(payload.get('categories', []), series,
                                        payload.get('number_format'),
                                        payload.get('center')),
                              payload.get('colors'), payload.get('mode'),
                              payload.get('value_labels'),
                              payload.get('fill'),
                              bool(payload.get('dense')))


def has_text(el):
    """Whether an element has prose or an explicit inline-math marker."""
    text = ''.join(el.itertext())
    if text.strip():
        return True
    return bool(el.xpath(
        './/span[contains(concat(" ", normalize-space(@class), " "), '
        '" math ") and string-length(@data-latex) > 0]'))


def classify(el, style=None):
    """Определить, чем является элемент: текстом, картинкой или контейнером.

    Важная тонкость: `<span>` — строчный тег, и внутри абзаца он часть текста
    (`<span class="bullet-text"><strong>...</strong> ...</span>`). Но если
    родитель — flex или grid, те же `<span>` становятся отдельными элементами
    раскладки (`.agenda-number` + `.agenda-description`). Поэтому у flex/grid
    контейнера дети всегда самостоятельные боксы.
    """
    tag = str(el.tag).lower()
    if tag == 'img':
        return 'image'
    # The chart marker carries its data as a JSON attribute, not children —
    # see `_decode_chart` and the `chart` filler in slides.py.
    if 'chart-canvas' in (el.get('class') or '').split():
        return 'chart'

    if style is not None and _display(style) in ('flex', 'grid', 'inline-flex',
                                                 'inline-grid'):
        element_children = [c for c in el if isinstance(c.tag, str)
                            and str(c.tag).lower() not in SKIP_TAGS]
        if element_children and {str(c.tag).lower() for c in element_children} != {'svg'}:
            return 'container'

    element_children = [c for c in el
                        if isinstance(c.tag, str) and str(c.tag).lower() not in SKIP_TAGS]
    tags = {str(c.tag).lower() for c in element_children}

    # Элемент, внутри которого только <svg>, — это картинка.
    if tags and tags <= {'svg'}:
        return 'image'
    if tag == 'svg':
        return 'image'

    # Только строчное оформление внутри → цельный текстовый блок.
    if has_text(el) and tags <= INLINE_TAGS:
        # <span> может быть и flex-элементом-контейнером, но если в нём только
        # текст и оформление — это текст.
        return 'text'
    if not element_children and has_text(el):
        return 'text'
    return 'container'


# ------------------------------------------------------------------ хелперы стиля

def _len(style, prop, percent_of=None, default=None):
    return V.length(style.get(prop), percent_of=percent_of, default=default)


def _padding(style, cb_w):
    return (
        _len(style, 'padding-top', cb_w, 0.0) or 0.0,
        _len(style, 'padding-right', cb_w, 0.0) or 0.0,
        _len(style, 'padding-bottom', cb_w, 0.0) or 0.0,
        _len(style, 'padding-left', cb_w, 0.0) or 0.0,
    )


def _margin(style, cb_w):
    return (
        _len(style, 'margin-top', cb_w, 0.0) or 0.0,
        _len(style, 'margin-right', cb_w, 0.0) or 0.0,
        _len(style, 'margin-bottom', cb_w, 0.0) or 0.0,
        _len(style, 'margin-left', cb_w, 0.0) or 0.0,
    )


def _is_absolute(style):
    return style.get('position') in ('absolute', 'fixed')


def _display(style):
    return (style.get('display') or 'block').strip().lower()


def _font_size(style):
    return V.length(style.get('font-size'), default=16.0) or 16.0


def _clamp_width(style, width, cb_w):
    max_w = _len(style, 'max-width', cb_w, None)
    if max_w is not None:
        width = min(width, max_w)
    min_w = _len(style, 'min-width', cb_w, None)
    if min_w is not None:
        width = max(width, min_w)
    return width


# ------------------------------------------------------------------ движок

class LayoutEngine:
    def __init__(self, stylesheet, fontbook):
        self.css = stylesheet
        self.fonts = fontbook
        self._counter = 0

    # ---------------------------------------------------------- построение дерева

    def build(self, el, parent_style=None):
        """Построить дерево Box из DOM, посчитав стили."""
        style = self.css.computed(el, parent_style)
        kind = classify(el, style)
        box = Box(el, style, kind)
        box.order = self._counter
        self._counter += 1
        try:
            box.z_index = int(float(style.get('z-index', 0)))
        except (TypeError, ValueError):
            box.z_index = 0

        if kind == 'image':
            tag = str(el.tag).lower()
            if tag == 'img':
                box.src = el.get('src')
            else:
                svg = el if tag == 'svg' else el.find('.//svg')
                if svg is None:
                    svg = el.find('svg')
                if svg is not None:
                    box.is_svg = True
                    box.src = svg
        elif kind == 'chart':
            raw = el.get('data-chart')
            if raw:
                box.chart = _decode_chart(raw)
        elif kind == 'container':
            for child in el:
                if not isinstance(child.tag, str):
                    continue
                if str(child.tag).lower() in SKIP_TAGS:
                    continue
                box.children.append(self.build(child, style))
        return box

    # ---------------------------------------------------------- измерение

    def text_metrics(self, box, avail_w):
        """Посчитать строки текста и вернуть (ширина_контента, высота)."""
        style = box.style
        size = _font_size(style)
        family = style.get('font-family', DEFAULT_FAMILY)
        weight = style.get('font-weight', 400)
        lh = line_height_px(style.get('line-height'), size)

        segments = extract_segments(box.el, normalize_weight(weight))
        lines = []
        for seg in segments:
            if not seg:
                lines.append([])
                continue
            lines.extend(wrap_runs(seg, avail_w, self.fonts, family, size))

        box.lines = lines
        box.line_height = lh
        box.font_size = size
        box.line_heights = []
        box.line_baselines = []
        # Every reader of a line's width - the fit checks, the alignment of a
        # centred line - takes it from here rather than measuring again.
        box.line_widths = [measure_runs(line, self.fonts, family, size)
                           for line in lines]
        widest = max(box.line_widths) if box.line_widths else 0.0
        for line in lines:
            formulas = [run for run in line if isinstance(run, MathRun)]
            if not formulas:
                # Preserve the existing formula-free geometry exactly. Preview
                # derives its plain-text baseline from this same nominal box.
                font = self.fonts.get(family, normalize_weight(weight), size)
                ascent, descent = font.getmetrics()
                box.line_heights.append(lh)
                box.line_baselines.append(baseline_offset(lh, descent))
                continue

            font = self.fonts.get(family, normalize_weight(weight), size)
            prose_ascent, prose_descent = font.getmetrics()
            ascents = [float(prose_ascent)]
            descents = [float(prose_descent)]
            # The raw descents are tracked separately from the reserved ones,
            # because the two answer different questions — see below.
            #
            # The line starts at the deeper of the two faces on it. A math
            # object brings Cambria Math with it, whose line descent is deeper
            # than T-Sans's, so a formula sets a floor under the line even when
            # its own ink stops well above the baseline — measured on a desktop
            # export, see MATH_LINE_DESCENT_EM.
            raw_descents = [float(prose_descent),
                            MATH_LINE_DESCENT_EM * float(size)]
            for run in line:
                if isinstance(run, MathRun):
                    # The reserved pair, not the raw one: this is what sizes the
                    # line box, and it is the only place the reserve enters
                    # the geometry. Everything downstream reads line_heights.
                    metrics = math_metrics(run.mathtext, size, run.weight)
                    ascent, descent = metrics.ascent, metrics.descent
                    raw_descents.append(float(metrics.raw_descent))
                else:
                    run_font = self.fonts.get(family, run.weight, size)
                    ascent, descent = run_font.getmetrics()
                    raw_descents.append(float(descent))
                ascents.append(float(ascent))
                descents.append(float(descent))
            ascent = max(ascents)
            descent = max(descents)
            line_height = max(lh, ascent + descent)
            box.line_heights.append(line_height)
            # The reserved pair sizes the box; the RAW descent places the
            # baseline inside it. Mixing the two is what put the bullet marker
            # off its line — the 1.16 reserve exists to keep a formula inside
            # its box, and feeding it to `baseline_offset` moved the text
            # instead of padding it, by exactly 0.16*raw_descent.
            box.line_baselines.append(
                baseline_offset(line_height, max(raw_descents)))

        if not lines:
            box.line_heights = [lh]
            font = self.fonts.get(family, normalize_weight(weight), size)
            ascent, descent = font.getmetrics()
            box.line_baselines = [baseline_offset(lh, descent)]
        return widest, sum(box.line_heights)

    def max_content_width(self, box):
        """Естественная ширина без переносов — для flex-элементов без flex-grow.

        Явная ширина в px — это и есть естественная ширина, как у CSS. Без
        этого вложенный бокс с `width` (квадратик легенды 40px внутри пункта)
        считался нулевым, и строка легенды съедала свой `gap`.
        """
        explicit = _len(box.style, 'width', None, None)
        if explicit is not None and box.kind != 'text':
            return _clamp_width(box.style, explicit, None)
        return _clamp_width(box.style, self._max_content_raw(box), None)

    def _max_content_raw(self, box):
        if box.kind == 'text':
            style = box.style
            size = _font_size(style)
            family = style.get('font-family', DEFAULT_FAMILY)
            segments = extract_segments(box.el, normalize_weight(style.get('font-weight', 400)))
            widest = 0.0
            for seg in segments:
                widest = max(widest, measure_runs(seg, self.fonts, family, size))
            pl = _len(box.style, 'padding-left', None, 0.0) or 0.0
            pr = _len(box.style, 'padding-right', None, 0.0) or 0.0
            return widest + pl + pr
        if box.kind == 'image':
            return _len(box.style, 'width', None, 0.0) or 0.0
        flow = [c for c in box.children if not _is_absolute(c.style)]
        display = _display(box.style)
        direction = (box.style.get('flex-direction') or 'row').strip().lower()

        if display == 'flex' and not direction.startswith('column'):
            # Строка: естественная ширина — сумма детей плюс промежутки.
            gap = V.length(box.style.get('column-gap'), default=0.0) or 0.0
            total = sum(self.max_content_width(c) for c in flow)
            total += gap * max(0, len(flow) - 1)
        else:
            total = max([self.max_content_width(c) for c in flow] or [0.0])

        pl = _len(box.style, 'padding-left', None, 0.0) or 0.0
        pr = _len(box.style, 'padding-right', None, 0.0) or 0.0
        return total + pl + pr

    # ---------------------------------------------------------- раскладка

    def layout_slide(self, box):
        """Корневая раскладка слайда."""
        box.x, box.y, box.w, box.h = 0.0, 0.0, SLIDE_W, SLIDE_H
        self.layout_children(box, SLIDE_W, SLIDE_H)
        self.layout_positioned(box)
        # A chart's inside - plot area, bars, tick and value labels - is laid
        # out here, once its box has its final rectangle, so it belongs to the
        # same single pass as the text around it.
        doughnut_count = sum(1 for node in box.walk()
                             if node.kind == 'chart' and node.chart is not None
                             and node.chart.chart_type == 'doughnut')
        for node in box.walk():
            if node.kind == 'chart' and node.chart is not None:
                chartgeom.place(node.chart,
                                chartgeom.Rect(node.x, node.y, node.w, node.h),
                                self.fonts, doughnut_count=doughnut_count)

    def layout_box(self, box, x, y, width, height, cb):
        """Разместить бокс в заданном прямоугольнике и разложить его содержимое.

        `height` = None означает «высота по содержимому».
        `cb` — containing block (x, y, w, h) для абсолютных потомков.
        """
        box.x, box.y = x, y
        box.w = width

        pt, pr, pb, pl = _padding(box.style, cb[2])
        content_w = max(0.0, width - pl - pr)

        if box.kind == 'text':
            _, text_h = self.text_metrics(box, content_w)
            box.h = height if height is not None else text_h + pt + pb
            return box.h

        if box.kind == 'image':
            box.h = height if height is not None else (
                _len(box.style, 'height', None, 0.0) or 0.0)
            return box.h

        content_h = None if height is None else max(0.0, height - pt - pb)
        used_h = self.layout_children(box, content_w, content_h,
                                      origin=(x + pl, y + pt))
        box.h = height if height is not None else used_h + pt + pb

        # Абсолютные потомки раскладываются ТОЛЬКО после того, как известна
        # итоговая высота бокса: иначе привязка к `bottom` считается от нуля
        # и элемент (например иконка в углу карточки) улетает за её пределы.
        self.layout_positioned(box)
        return box.h

    def layout_children(self, box, content_w=None, content_h=None, origin=None):
        """Разложить потомков согласно display родителя. Вернуть занятую высоту."""
        if content_w is None:
            content_w = box.w
        if origin is None:
            origin = (box.x, box.y)

        flow = [c for c in box.children if not _is_absolute(c.style)]

        display = _display(box.style)
        if display == 'flex':
            used = self.layout_flex(box, flow, origin, content_w, content_h)
        elif display == 'grid':
            used = self.layout_grid(box, flow, origin, content_w, content_h)
        else:
            used = self.layout_block(box, flow, origin, content_w, content_h)

        return used

    def layout_positioned(self, box):
        """Разложить абсолютно позиционированных потомков бокса."""
        cb = self._containing_block(box)
        for child in box.children:
            if _is_absolute(child.style):
                self.layout_absolute(child, cb)

    def _containing_block(self, box):
        """Padding-box для абсолютных потомков.

        Всегда бокс родителя, а не ближайшего позиционированного предка, как в
        CSS: шаблону этого хватает. До 2.1 здесь стояла проверка `position`,
        обе ветки которой возвращали одно и то же.
        """
        return (box.x, box.y, box.w, box.h)

    # -------------------------------------------------- блочный поток

    def layout_block(self, box, children, origin, content_w, content_h=None):
        x0, y0 = origin
        cursor = y0
        for child in children:
            mt, mr, mb, ml = _margin(child.style, content_w)
            cursor += max(mt, 0.0)
            width = _len(child.style, 'width', content_w, None)
            if width is None:
                width = content_w - ml - mr
            width = _clamp_width(child.style, width, content_w)
            # Проценты высоты считаются от высоты контента родителя — так
            # `.icon { height: 100% }` внутри 58-пиксельного контейнера
            # получает свои 58px, а не ноль.
            height = _len(child.style, 'height', content_h, None)
            cb = self._containing_block(box)
            used = self.layout_box(child, x0 + ml, cursor, width, height, cb)
            cursor += used + mb
            prev_margin = mb
        return max(0.0, cursor - y0)

    # -------------------------------------------------- flex

    def layout_flex(self, box, children, origin, content_w, content_h):
        style = box.style
        direction = (style.get('flex-direction') or 'row').strip().lower()
        column = direction.startswith('column')
        gap_main = V.length(style.get('column-gap' if not column else 'row-gap'),
                            default=0.0) or 0.0
        align = (style.get('align-items') or 'stretch').strip().lower()
        justify = (style.get('justify-content') or 'flex-start').strip().lower()
        x0, y0 = origin

        if not children:
            return 0.0

        cb = self._containing_block(box)

        if column:
            # Колонка: ширина элементов — по поперечной оси.
            total = 0.0
            grows = []
            for child in children:
                try:
                    grows.append(float(child.style.get('flex-grow', 0) or 0))
                except ValueError:
                    grows.append(0.0)

            # Сначала разложим по естественной высоте.
            heights = []
            for child in children:
                mt, mr, mb, ml = _margin(child.style, content_w)
                width = _len(child.style, 'width', content_w, None)
                if width is None:
                    width = (self.max_content_width(child)
                             if align in ('flex-start', 'start', 'center', 'flex-end', 'end')
                             else content_w - ml - mr)
                width = _clamp_width(child.style, min(width, content_w - ml - mr), content_w)
                height = _len(child.style, 'height', None, None)
                used = self.layout_box(child, x0 + ml, y0, width, height, cb)
                heights.append(used + mt + mb)
            total = sum(heights) + gap_main * (len(children) - 1)

            # Распределить свободное место между элементами с flex-grow.
            free = 0.0 if content_h is None else max(0.0, content_h - total)
            grow_sum = sum(grows)
            extra = [free * g / grow_sum if grow_sum > 0 else 0.0 for g in grows]

            cursor = y0
            if content_h is not None and grow_sum == 0:
                cursor += _justify_offset(justify, content_h - total)
            for i, child in enumerate(children):
                mt, mr, mb, ml = _margin(child.style, content_w)
                cursor += mt
                width = child.w
                height = heights[i] - mt - mb + extra[i]
                cx = x0 + ml + _align_offset(align, content_w - ml - mr - width)
                self.layout_box(child, cx, cursor, width, height, cb)
                cursor += height + mb
                if i < len(children) - 1:
                    cursor += gap_main + (_justify_gap(justify, content_h, total,
                                                       len(children))
                                          if content_h is not None and grow_sum == 0 else 0.0)
            return max(0.0, cursor - y0)

        # ---- строка
        gaps_total = gap_main * (len(children) - 1)
        avail = content_w - gaps_total

        grows, bases, fixed = [], [], []
        for child in children:
            try:
                grow = float(child.style.get('flex-grow', 0) or 0)
            except ValueError:
                grow = 0.0
            grows.append(grow)
            explicit = _len(child.style, 'width', content_w, None)
            if explicit is None:
                explicit = _len(child.style, 'flex-basis', content_w, None)
            if explicit is not None:
                base = explicit
            elif grow > 0:
                base = 0.0
            else:
                base = self.max_content_width(child)
            base = _clamp_width(child.style, base, content_w)
            bases.append(base)
            fixed.append(explicit is not None)

        grow_sum = sum(grows)
        used_base = sum(bases)
        free = avail - used_base

        widths = list(bases)
        if grow_sum > 0 and free > 0:
            for i, g in enumerate(grows):
                widths[i] += free * g / grow_sum
        elif free < 0:
            # Переполнение: ужимаем те элементы, которым это разрешено.
            shrinkable = []
            for i, child in enumerate(children):
                try:
                    shrink = float(child.style.get('flex-shrink', 1) or 0)
                except ValueError:
                    shrink = 1.0
                if fixed[i]:
                    shrink = 0.0
                shrinkable.append(shrink)
            weight = sum(s * b for s, b in zip(shrinkable, bases))
            if weight > 0:
                for i in range(len(widths)):
                    widths[i] += free * shrinkable[i] * bases[i] / weight
                    widths[i] = max(0.0, widths[i])

        # Разложить и посчитать высоты.
        heights = []
        for i, child in enumerate(children):
            width = _clamp_width(child.style, widths[i], content_w)
            widths[i] = width
            height = _len(child.style, 'height', None, None)
            if height is None and content_h is not None and align == 'stretch':
                height = content_h
            used = self.layout_box(child, x0, y0, width, height, cb)
            heights.append(used)

        row_h = max(heights) if heights else 0.0
        total_w = sum(widths) + gaps_total
        cursor = x0 + (_justify_offset(justify, content_w - total_w)
                       if grow_sum == 0 else 0.0)
        spread = 0.0
        if grow_sum == 0 and justify == 'space-between' and len(children) > 1:
            spread = max(0.0, content_w - total_w) / (len(children) - 1)

        for i, child in enumerate(children):
            mt = _len(child.style, 'margin-top', content_w, 0.0) or 0.0
            box_h = heights[i]
            cross_free = (content_h if content_h is not None else row_h) - box_h
            cy = y0 + mt + _align_offset(align, max(0.0, cross_free))
            height = _len(child.style, 'height', None, None)
            if height is None and content_h is not None and align == 'stretch':
                height = content_h
                cy = y0
            self.layout_box(child, cursor, cy, widths[i], height, cb)
            cursor += widths[i] + gap_main + spread
        return row_h

    # -------------------------------------------------- grid

    def layout_grid(self, box, children, origin, content_w, content_h):
        style = box.style
        col_gap = V.length(style.get('column-gap'), default=0.0) or 0.0
        row_gap = V.length(style.get('row-gap'), default=0.0) or 0.0
        x0, y0 = origin
        cb = self._containing_block(box)

        col_tracks = _parse_tracks(style.get('grid-template-columns'), 1)
        placements = [_parse_placement(c.style.get('grid-column'),
                                       c.style.get('grid-row')) for c in children]

        n_cols = max(1, len(col_tracks))
        # Columns stay explicit; moving to another row cannot fix this range.
        # Check fully positioned items too, before they bypass auto placement.
        for child, (cs, cspan, _, _) in zip(children, placements):
            if cspan > n_cols or (cs is not None and cs + cspan - 1 > n_cols):
                raise GridPlacementError(
                    'grid-column %r exceeds %d explicit columns (start=%s, span=%d); '
                    'implicit columns are not supported' %
                    (child.style.get('grid-column'), n_cols,
                     cs if cs is not None else 'auto', cspan))
        row_tracks = _parse_tracks(style.get('grid-template-rows'), 0)

        # Автораскладка: заполняем занятость, потом расставляем безымянные.
        n_rows_needed = len(row_tracks)
        occupied = set()
        resolved = []
        for (cs, cspan, rs, rspan) in placements:
            resolved.append([cs, cspan, rs, rspan])
        for item in resolved:
            if item[0] is not None and item[2] is not None:
                for r in range(item[2], item[2] + item[3]):
                    for c in range(item[0], item[0] + item[1]):
                        occupied.add((r, c))
                n_rows_needed = max(n_rows_needed, item[2] + item[3] - 1)

        cursor_r, cursor_c = 1, 1
        for item in resolved:
            if item[0] is not None and item[2] is not None:
                continue
            span_c = item[1]
            span_r = item[3]
            col = item[0]
            while True:
                c = col if col is not None else cursor_c
                if c + span_c - 1 > n_cols:
                    cursor_r += 1
                    cursor_c = 1
                    continue
                free = all((cursor_r + dr, c + dc) not in occupied
                           for dr in range(span_r) for dc in range(span_c))
                if free:
                    item[0], item[2] = c, cursor_r
                    for dr in range(span_r):
                        for dc in range(span_c):
                            occupied.add((cursor_r + dr, c + dc))
                    n_rows_needed = max(n_rows_needed, cursor_r + span_r - 1)
                    cursor_c = c + span_c
                    if cursor_c > n_cols:
                        cursor_c = 1
                        cursor_r += 1
                    break
                cursor_c += 1
                if cursor_c > n_cols:
                    cursor_c = 1
                    cursor_r += 1

        n_rows = max(1, n_rows_needed)
        col_sizes = _resolve_tracks(col_tracks, n_cols, content_w, col_gap)

        # Высоты строк: из шаблона, иначе — по содержимому.
        if row_tracks and content_h is not None:
            row_sizes = _resolve_tracks(row_tracks, n_rows, content_h, row_gap)
        elif row_tracks:
            row_sizes = _resolve_tracks(row_tracks, n_rows, None, row_gap)
        else:
            row_sizes = [None] * n_rows

        if any(s is None for s in row_sizes):
            # Предварительный проход: измерить содержимое для авто-строк.
            natural = [0.0] * n_rows
            for child, item in zip(children, resolved):
                c, cspan, r, rspan = item
                width = sum(col_sizes[c - 1:c - 1 + cspan]) + col_gap * (cspan - 1)
                used = self.layout_box(child, x0, y0, width, None, cb)
                if rspan == 1:
                    natural[r - 1] = max(natural[r - 1], used)
            row_sizes = [natural[i] if row_sizes[i] is None else row_sizes[i]
                         for i in range(n_rows)]

        col_offsets = []
        acc = x0
        for size in col_sizes:
            col_offsets.append(acc)
            acc += size + col_gap
        row_offsets = []
        acc = y0
        for size in row_sizes:
            row_offsets.append(acc)
            acc += size + row_gap

        for child, item in zip(children, resolved):
            c, cspan, r, rspan = item
            c = max(1, min(c, n_cols))
            r = max(1, min(r, n_rows))
            width = sum(col_sizes[c - 1:c - 1 + cspan]) + col_gap * (cspan - 1)
            height = sum(row_sizes[r - 1:r - 1 + rspan]) + row_gap * (rspan - 1)
            self.layout_box(child, col_offsets[c - 1], row_offsets[r - 1],
                            width, height, cb)

        total_h = sum(row_sizes) + row_gap * (n_rows - 1) if row_sizes else 0.0
        return total_h

    # -------------------------------------------------- absolute

    def layout_absolute(self, box, cb):
        cb_x, cb_y, cb_w, cb_h = cb
        style = box.style

        left = _len(style, 'left', cb_w, None)
        right = _len(style, 'right', cb_w, None)
        top = _len(style, 'top', cb_h, None)
        bottom = _len(style, 'bottom', cb_h, None)
        width = _len(style, 'width', cb_w, None)
        height = _len(style, 'height', cb_h, None)

        if width is None and left is not None and right is not None:
            width = max(0.0, cb_w - left - right)
        if width is None:
            # CSS shrink-to-fit: ширина по содержимому, но не шире доступного
            # места. Без этого элемент, привязанный только к `right` (номер
            # слайда), получил бы ширину во весь слайд и уехал за левый край.
            avail = max(0.0, cb_w - (left or 0.0) - (right or 0.0))
            natural = self.max_content_width(box)
            width = min(natural, avail) if natural else avail
        width = _clamp_width(style, width, cb_w)

        if height is None and top is not None and bottom is not None:
            height = max(0.0, cb_h - top - bottom)

        x = cb_x + (left if left is not None else
                    (cb_w - right - width if right is not None else 0.0))

        # Высоту, если она не задана, считаем по содержимому — она нужна для
        # привязки к нижнему краю (`bottom`).
        probe_y = cb_y + (top if top is not None else 0.0)
        used_h = self.layout_box(box, x, probe_y, width, height, cb)

        if top is not None:
            y = cb_y + top
        elif bottom is not None:
            y = cb_y + cb_h - bottom - used_h
        else:
            y = cb_y

        dx, dy = V.transform_offset(style.get('transform'), width, used_h)
        if (x, y) != (box.x, box.y) or dx or dy:
            self.layout_box(box, x + dx, y + dy, width,
                            height if height is not None else used_h, cb)
        return box


def _align_offset(align, free):
    """Смещение по поперечной оси flex-контейнера."""
    if align in ('center',):
        return free / 2.0
    if align in ('flex-end', 'end'):
        return free
    return 0.0


def _justify_offset(justify, free):
    if free <= 0:
        return 0.0
    if justify == 'center':
        return free / 2.0
    if justify in ('flex-end', 'end'):
        return free
    return 0.0


def _justify_gap(justify, content, total, count):
    if justify == 'space-between' and count > 1 and content is not None:
        return max(0.0, content - total) / (count - 1)
    return 0.0


# ------------------------------------------------------------------ grid utils

_REPEAT_RE = re.compile(r'repeat\(\s*(\d+)\s*,\s*([^)]+)\)')


def _parse_tracks(value, default_count):
    """`repeat(3, 1fr)` / `1.4fr 1fr` / `200px 1fr` → список описаний треков."""
    if not value:
        return ['1fr'] * default_count if default_count else []
    value = value.strip()

    def expand(text):
        out = []
        for m in _REPEAT_RE.finditer(text):
            pass
        # Разворачиваем repeat(...) слева направо.
        pos = 0
        result = ''
        for m in _REPEAT_RE.finditer(text):
            result += text[pos:m.start()]
            count = int(m.group(1))
            inner = m.group(2).strip()
            result += ' '.join([inner] * count)
            pos = m.end()
        result += text[pos:]
        out.extend(result.split())
        return out

    return expand(value)


def _resolve_tracks(tracks, count, available, gap):
    """Треки → конкретные размеры в px. `available` = None → только фиксированные."""
    tracks = list(tracks)
    if len(tracks) < count:
        tracks += ['1fr'] * (count - len(tracks))
    tracks = tracks[:count]

    fixed_total = 0.0
    fr_total = 0.0
    parsed = []
    for track in tracks:
        t = track.strip().lower()
        if t.endswith('fr'):
            try:
                fr = float(t[:-2] or 1)
            except ValueError:
                fr = 1.0
            parsed.append(('fr', fr))
            fr_total += fr
        else:
            size = V.length(t, percent_of=available, default=None)
            if size is None:
                parsed.append(('fr', 1.0))
                fr_total += 1.0
            else:
                parsed.append(('px', size))
                fixed_total += size

    if available is None:
        return [size if kind == 'px' else None for kind, size in parsed]

    free = max(0.0, available - fixed_total - gap * (count - 1))
    out = []
    for kind, size in parsed:
        if kind == 'px':
            out.append(size)
        else:
            out.append(free * size / fr_total if fr_total > 0 else 0.0)
    return out


def _parse_placement(col_value, row_value):
    """`grid-column`/`grid-row` → (старт_колонки, span, старт_строки, span)."""
    cs, cspan = _parse_axis(col_value, 'grid-column')
    rs, rspan = _parse_axis(row_value, 'grid-row')
    return (cs, cspan, rs, rspan)


def _parse_axis(value, axis='grid-axis'):
    """Parse positive lines, auto and spans without coercing CSS numbers."""
    def reject(reason):
        raise GridAxisError('%s %r is not supported: %s' % (axis, value, reason))

    if value is None:
        return (None, 1)
    if not isinstance(value, str):
        reject('expected a CSS string')
    text = value.strip().lower()
    if not text:
        return (None, 1)

    def endpoint(token):
        token = token.strip()
        if token == 'auto':
            return ('auto', None)
        match = re.fullmatch(r'(span\s+)?(\+?[0-9]+)', token)
        if match:
            number = int(match.group(2))
            if number > 0:
                return ('span' if match.group(1) else 'line', number)
        reject('expected auto, a positive integer line, or span N')

    parts = text.split('/')
    if len(parts) > 2 or any(not part.strip() for part in parts):
        reject('expected one or two non-empty endpoints separated by /')
    start_kind, start = endpoint(parts[0])
    if len(parts) == 1:
        return (start, 1) if start_kind == 'line' else (None, start or 1)
    end_kind, end = endpoint(parts[1])
    if start_kind == end_kind == 'span':
        reject('two span endpoints are not supported')
    if end_kind == 'line':
        if start_kind == 'line':
            if end <= start:
                reject('end line must be greater than start line')
            return (start, end - start)
        span = start if start_kind == 'span' else 1
        if end <= span:
            reject('end line must exceed the span')
        return (end - span, span)
    if start_kind == 'line':
        return (start, end if end_kind == 'span' else 1)
    return (None, start if start_kind == 'span' else end or 1)
