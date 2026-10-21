# -*- coding: utf-8 -*-
"""What a slide element is, in one place.

A layout holds elements - cards, metrics, timeline points, flow steps,
columns, a flow's summary, the charts of `chart-two`. Until 2.1 each of them
was known in four modules at once: its fields in `spec.py`, its normalised
shape and its icons in `deck.py`, its icons again in `validate.py` and its
markup in `slides.py`. The copies drifted. `validate` counted repeated icons
on cards only, so a flow deck or a chart deck with one icon on every slide
built clean; the chart checks lived twice, in `spec` and in `deck`, against
two names for the same constant.

This module owns everything about an element except its markup: the fields a
spec may give it, the rules across those fields, which fields carry an icon,
where a formula may go, and the shape a filler receives. `layouts.Layout`
maps a slide field to a `Kind`; `spec`, `deck` and `validate` ask the kind.

Messages are part of the interface: agents and the eval suite match on them,
so a message moved here keeps its wording.
"""
import os
import re

from . import chartdata as CD
from .html2pptx import chartgeom as G
from .model import Card, Metric
from . import media

# Bullet rows one card holds. The `bullets` reference fragment has five, and the
# `items` list inside a card is bounded by it — the list markup is borrowed
# from that fragment.
ITEMS_MAX = 5


def offered(allowed):
    """The fields an unknown-field error lists: `fill` is accepted only to be
    refused while features.line_fill is off, so it is not offered (an agent
    read it in the list and tried it, 2026-10-04)."""
    if G.load_palette().features.get('line_fill'):
        return ', '.join(allowed)
    return ', '.join(k for k in allowed if k != 'fill')


def check_str_list(value, key, where, problems):
    if not isinstance(value, list):
        problems.append('%s: the "%s" field must be a list of strings' % (where, key))
        return
    for position, item in enumerate(value, 1):
        if not isinstance(item, str) or not item.strip():
            problems.append('%s: item %d in "%s" must be a non-empty string'
                            % (where, position, key))


def check_image_fit(value, where, problems):
    if value not in ('contain', 'cover'):
        problems.append('%s: "fit" is "contain" or "cover", not %r'
                        % (where, value))


class Kind(object):
    """One kind of element a layout field holds.

    `required`/`optional` are the element's own fields. `icon_fields` name the
    ones whose value is an icon query, resolved to a file by `normalise`.
    `formula_fields` are where inline LaTeX is allowed (`items[]` is a list).
    `single` marks a field that holds one object rather than a list (the
    flow's summary). `rule` is a cross-field check over the whole list, run
    after every element passed its own.
    """

    __slots__ = ('name', 'noun', 'required', 'optional', 'icon_fields',
                 'formula_fields', 'single', 'rule', 'shape', 'refused',
                 'objects')

    def __init__(self, name, required, optional=(), noun=None, icon_fields=(),
                 formula_fields=(), single=False, rule=None, shape=None,
                 refused=None, objects=None):
        self.name = name
        self.noun = noun or name
        self.required = tuple(required)
        self.optional = tuple(optional)
        self.icon_fields = tuple(icon_fields)
        self.formula_fields = tuple(formula_fields)
        self.single = single
        self.rule = rule
        self.shape = shape
        # field -> why this kind has no such field, where the generic
        # 'unknown field' would leave the author guessing (a numbered card's
        # icon).
        self.refused = dict(refused or ())
        # (class, view): the Python API's convenience object for this kind
        # (Card, Metric) and how to write one in the spec's own form, so the
        # API is checked by the same rules as a spec (P22.03). None where the
        # API takes the spec's dicts only.
        self.objects = objects

    @property
    def allowed(self):
        return self.required + self.optional

    def adapt(self, value):
        """API value → (value for `normalise`, its spec form for the checks).

        A tuple becomes the object once, here, so an `items` iterator inside
        it is read once and the normaliser receives the same object the
        checks saw. Dicts pass through; anything else is left for the checks
        to refuse.
        """
        if self.objects is None or self.single \
                or not isinstance(value, (list, tuple)):
            return value, value
        cls, view = self.objects
        kept, seen = [], []
        for item in value:
            if isinstance(item, (tuple, list)):
                item = cls(*item)
            kept.append(item)
            seen.append(view(item) if isinstance(item, cls) else item)
        return kept, seen

    # -- spec

    def check(self, value, where, problems):
        """Validate the field as the spec wrote it, collecting every problem."""
        items = [value] if self.single else value
        if not isinstance(items, list):
            problems.append('%s: the field must be a list of objects' % where)
            return
        allowed = self.allowed
        for position, item in enumerate(items, 1):
            label = '%s: %s %d' % (where, self.noun, position)
            if not isinstance(item, dict):
                problems.append('%s: must be an object with fields %s'
                                % (label, ', '.join(allowed)))
                continue
            for key in item:
                if key in self.refused:
                    problems.append('%s: %s' % (label, self.refused[key]))
                elif key not in allowed:
                    problems.append('%s: unknown field "%s"; allowed: %s'
                                    % (label, key, ', '.join(allowed)))
            for key in self.required:
                value = item.get(key)
                if not value or (isinstance(value, str) and not value.strip()):
                    problems.append('%s: the "%s" field is required' % (label, key))
            for key in allowed:
                if key not in item:
                    continue
                if key == 'items':
                    check_str_list(item[key], key, label, problems)
                elif not isinstance(item[key], str):
                    problems.append('%s: the "%s" field must be a string'
                                    % (label, key))
        if self.rule is not None and not self.single:
            self.rule(items, where, problems)

    def formula_paths(self, field):
        """Spec paths inside `field` where a formula is allowed."""
        return set('%s[].%s' % (field, name) for name in self.formula_fields)

    # -- deck

    def normalise(self, value, allocator):
        """The spec's (or the API's) value → the shape the filler reads.

        Icons are resolved here, before anything is written: a missing one
        surfaces with its slide number. The caller has begun the slide on the
        allocator, so icons are unique within it.
        """
        if self.single:
            return self._one(value, allocator)
        if self.rule is not None:
            # Keep cross-element rules on the API path too, before icons are
            # allocated. A focus-card limit applies to the whole slide.
            problems = []
            self.rule(value, self.noun, problems)
            if problems:
                raise ValueError('\n'.join(problems))
        return [self._one(item, allocator) for item in value]

    def _one(self, item, allocator):
        if self.shape is not None:
            return self.shape(item, allocator)
        return item

    # -- validate

    def icons_of(self, value):
        """Icon files of an already-normalised field value."""
        items = [value] if self.single else (value or ())
        out = []
        for item in items:
            for name in self.icon_fields:
                icon = (item.get(name) if isinstance(item, dict)
                        else getattr(item, name, None))
                if icon:
                    out.append(icon)
        return out

    def __repr__(self):
        return 'Kind(%s)' % self.name


# ------------------------------------------------------------------ shapes

def _image_item(item, allocator):
    """Gallery item: original picture and a mandatory allocated badge icon."""
    if not isinstance(item, dict):
        raise ValueError('an image item must be an object')
    problems = []
    IMAGE_ITEM.check([item], 'gallery', problems)
    if problems:
        raise ValueError('\n'.join(problems))
    result = dict(item)
    media.resolve_image(result['src'])
    result['src'] = os.path.abspath(result['src'])
    result['icon'] = allocator.allocate(result['icon'])
    return result


IMAGE_ITEM = Kind('image', ('src', 'title', 'text', 'icon'),
                  icon_fields=('icon',), shape=_image_item)


def _screenshot_item(item, allocator):
    """One original screen image and its optional annotation."""
    result = dict(item)
    media.resolve_image(result['src'])
    result['src'] = os.path.abspath(result['src'])
    return result


def _screenshot_captions(items, where, problems):
    for number, item in enumerate(items, 1):
        if isinstance(item, dict) and 'caption' in item:
            caption = item['caption']
            if isinstance(caption, str) and not caption.strip():
                problems.append('%s: screen %d: the "caption" field must be a '
                                'non-empty string; omit it for no annotation'
                                % (where, number))


SCREENSHOT_ITEM = Kind('screen', ('src',), ('caption',),
                       rule=_screenshot_captions, shape=_screenshot_item)

def _card(item, allocator):
    """A card: a `Card` object, icon resolved, bullet list bounded."""
    if isinstance(item, Card):
        # Deepcopy preserves aliases: each occurrence still needs its own card
        # so allocating the second icon cannot overwrite the first occurrence.
        card = Card(item.title, item.text, item.icon, item.items, item.value)
    elif isinstance(item, dict):
        card = Card(item.get('title', ''), item.get('text', ''),
                    item.get('icon'), item.get('items'), item.get('value'))
    elif isinstance(item, (tuple, list)):
        card = Card(*item)
    else:
        raise TypeError('a card must be a Card, a dict or a tuple')
    problems = []
    _one_of_title_value([card], 'card', problems)
    if problems:
        raise ValueError(problems[0])
    if card.value is not None and not isinstance(card.value, str):
        raise ValueError('a card "value" must be a string')
    if card.icon:
        card.icon = allocator.allocate(card.icon)
    # Bullet block in template fits 5 lines max — cannot add more.
    if len(card.items) > ITEMS_MAX:
        raise ValueError('a card takes up to %d bullet items, got %d'
                         % (ITEMS_MAX, len(card.items)))
    return card


def _chart_card(item, allocator):
    """A chart card stays a dict and has no icon."""
    if not isinstance(item, dict):
        raise ValueError('a chart card must be an object with "title" '
                         'and "text", got %r' % (item,))
    return {'title': item.get('title', ''), 'text': item.get('text', ''),
            'value': item.get('value')}


def _metric(item, allocator):
    if isinstance(item, Metric):
        return item
    if isinstance(item, dict):
        return Metric(item.get('value', ''), item.get('text', ''))
    if isinstance(item, (tuple, list)):
        return Metric(*item)
    raise TypeError('a metric must be a Metric, a dict or a tuple')


def _step(item, allocator):
    return {'icon': allocator.allocate(item['icon']), 'text': item['text']}


def _chart_point(item, allocator):
    # The spec requires the icon (I1), but the guard stays defensive: a
    # hand-built point via the programmatic API could still omit it, and the
    # template drops its icon holder.
    return {'icon': (allocator.allocate(item.get('icon'))
                     if item.get('icon') else None),
            'text': item.get('text', '')}


def _illustration_point(item, allocator):
    return {'title': item['title'], 'text': item['text'],
            'icon': allocator.allocate(item['icon'])}


# ------------------------------------------------------------------- rules

def _one_of_title_value(items, where, problems):
    values = 0
    for number, card in enumerate(items, 1):
        if isinstance(card, (tuple, list)):
            # Inspect heads without constructing Card: construction consumes
            # an items iterator that must remain available to the normaliser.
            title = card[0] if card else ''
            value = card[4] if len(card) > 4 else None
        elif isinstance(card, dict):
            title, value = card.get('title'), card.get('value')
        elif isinstance(card, Card):
            title, value = card.title, card.value
        else:
            continue
        for key, head in (('title', title), ('value', value)):
            # Card/tuple defaults use an empty title when value is supplied.
            # An explicit dictionary field must be non-empty; whitespace is
            # never a valid head on either input path.
            if isinstance(head, str) and not head.strip() and (
                    bool(head) or isinstance(card, dict) and key in card):
                problems.append('%s: card %d: the "%s" field must be a '
                                'non-empty string' % (where, number, key))
        has_title = bool(title.strip()) if isinstance(title, str) else bool(title)
        has_value = bool(value.strip()) if isinstance(value, str) else bool(value)
        if has_value:
            values += 1
        if has_title == has_value:
            problems.append(
                '%s: card %d needs a "title" or a "value" (a big '
                'figure), exactly one of them' % (where, number))
    if values > 1:
        problems.append(
            '%s: at most one card per slide may have a "value" (a big '
            'figure), got %d - keep the focus value on one card and use '
            '"title" for the others' % (where, values))


def _titled_all_or_none(items, where, problems):
    # All the points carry a subtitle or none does. A row where only some do
    # sets the descriptions of those points one line lower than the rest, and
    # the whole row reads as broken.
    titled = [bool(p.get('title')) for p in items if isinstance(p, dict)]
    if titled and any(titled) and not all(titled):
        problems.append(
            '%s: either every point has a "title" or none does - '
            '%d of %d have one' % (where, sum(titled), len(titled)))


def _subtitled_both_or_neither(items, where, problems):
    # The versus sides stand on the bottom of their cards: one subtitle alone
    # sets that side's text a heading lower and the pair stops reading as a
    # pair (2.4.0, the author).
    subtitled = [bool(s.get('subtitle')) for s in items if isinstance(s, dict)]
    if subtitled and any(subtitled) and not all(subtitled):
        problems.append(
            '%s: either both sides have a "subtitle" or neither does'
            % where)


# ------------------------------------------------------------------- kinds

def _card_view(card):
    """A Card as the spec writes it: the fields it sets, nothing defaulted.
    An unset icon is absent, so the spec's "icon is required" applies."""
    view = {}
    for key in ('title', 'value', 'text', 'icon'):
        value = getattr(card, key)
        if value not in (None, ''):
            view[key] = value
    if card.items:
        view['items'] = list(card.items)
    return view


def _metric_view(metric):
    view = {'value': metric.value}
    if metric.text not in (None, ''):
        view['text'] = metric.text
    return view


CARD = Kind('card', ('icon',), ('title', 'value', 'text', 'items'),
            icon_fields=('icon',), formula_fields=('text', 'items[]'),
            rule=_one_of_title_value, shape=_card,
            objects=(Card, _card_view))


ILLUSTRATION_POINT = Kind('illustration point', ('title', 'text', 'icon'),
                          icon_fields=('icon',), shape=_illustration_point)
# A chart card (slide 64) has no icon: a subtitle or a figure (`value`) over
# a description. Exactly one of title/value.
CHART_CARD = Kind('chart card', ('text',), ('title', 'value'), noun='card',
                  rule=_one_of_title_value, shape=_chart_card)

def _circle_cards(items, where, problems):
    _one_of_title_value(items, where, problems)
    if len(items) != 2:
        problems.append('%s: circle takes exactly 2 cards, got %d' % (where, len(items)))


CIRCLE_CARD = Kind('card', ('icon',), ('title', 'value', 'text', 'items'),
                   icon_fields=('icon',), formula_fields=('text', 'items[]'),
                   rule=_circle_cards, shape=_card,
                   objects=(Card, _card_view))

METRIC = Kind('metric', ('value',), ('text',), formula_fields=('text',),
              shape=_metric, objects=(Metric, _metric_view))
POINT = Kind('point', ('text',), ('title',), formula_fields=('text',),
             rule=_titled_all_or_none)
# v2.0: a single chart's points carry a selectable icon and text; the designer
# forbids an icon-less point («points без icon должны быть запрещены»), I1.
CHART_POINT = Kind('chart point', ('text', 'icon'), noun='point',
                   icon_fields=('icon',), shape=_chart_point)
STEP = Kind('step', ('icon', 'text'), icon_fields=('icon',),
            formula_fields=('text',), shape=_step)
COLUMN = Kind('column', ('title', 'text'), formula_fields=('text',))
# 2.4.0, the designers' contrast slide: a large title over a subtitle and the
# text, no icon. The line limits are layout checks (validate.py).
# A numbered card (2.4.0, numberd_cards): a card of a row or grid slide with
# "numbered": true. Its number sits where the icon would, so it has none.
NUMBERED_CARD = Kind('card', (), ('title', 'value', 'text', 'items'),
                     formula_fields=('text', 'items[]'), shape=_card,
                     rule=_one_of_title_value,
                     objects=(Card, _card_view),
                     refused={'icon': 'a numbered card carries its number '
                              'where the icon would be - drop "icon", or '
                              'drop "numbered" from the slide'})
VERSUS_SIDE = Kind('side', ('title', 'text'), ('subtitle',),
                   rule=_subtitled_both_or_neither)
# The flow layout's optional footer: one object, not a list.
SUMMARY = Kind('summary', ('title', 'text'), single=True)


# ------------------------------------------------------------------- chart

def _series_count(raw):
    """How many series a raw chart object gives, None when its `data` is
    malformed - that is reported where `data` is checked."""
    return _data_shape(raw)[0]


def _data_shape(raw):
    """(series, categories) of a chart object's `data` - inline, or already
    read into `ChartData` (a CSV is counted only then); None for either when
    it is not known yet."""
    data = raw.get('data')
    if isinstance(data, dict):
        series, categories = data.get('series'), data.get('categories')
    else:
        series = getattr(data, 'series', None)
        categories = getattr(data, 'categories', None)
    return (len(series) if isinstance(series, list) else None,
            len(categories) if isinstance(categories, list) else None)


class Chart(object):
    """A chart: the fields that describe one, and turning them into data.

    A `chart` and a `chart-cards` slide carry these fields on the slide
    itself; `chart-two` carries two chart objects in `charts`. Both go
    through here, so a rule is written once for all three.
    """

    FIELDS = ('data', 'chart_type', 'chart_title', 'x', 'y', 'mode', 'center',
              'value_labels', 'fill', 'number_format')
    # Line-chart fields that are not strings; `check_source` checks them.
    LINE_FIELDS = ('value_labels', 'fill')
    # chart-two (2.3.0, the designers' review): two charts side by side are
    # told apart by their titles, so each carries one.
    UNTITLED = ('chart %d has no "chart_title" - two charts side by side are '
                'told apart by their titles; take it from the source, even '
                'if it repeats the slide title')

    # -- spec

    def check_source(self, raw, where, problems):
        """`x`/`y` belong to a CSV and to nothing else; `center` to a
        doughnut; `mode` to its fixed set.

        With a path `x`/`y` are required - they name the columns. With inline
        data they are meaningless, and accepting them silently would let an
        author believe a column was being picked.
        """
        data = raw.get('data')
        has_columns = raw.get('x') is not None or raw.get('y') is not None
        if isinstance(data, str) and data:
            for key in ('x', 'y'):
                if raw.get(key) in (None, '', []):
                    problems.append('%s: "data" is a CSV path, so "%s" is '
                                    'required' % (where, key))
        elif isinstance(data, dict) and has_columns:
            problems.append('%s: "x"/"y" name CSV columns - drop them when '
                            '"data" is written inline' % where)
        # The centre figure sits in a doughnut's hole; on any other chart it
        # would print over the plot, so the filler drops it - say so instead.
        if raw.get('center') and raw.get('chart_type') != 'doughnut':
            problems.append('%s: "center" is the figure inside a doughnut - '
                            'drop it or use chart_type "doughnut"' % where)
        # `mode` has a fixed set (N3): a wrong-typed or invented value would
        # only surface later in chartgeom.assign_colors, so catch it here.
        mode = raw.get('mode')
        if mode is not None and mode not in G.MODES:
            problems.append('%s: unknown "mode" %r; known: %s'
                            % (where, mode, ', '.join(G.MODES)))
        # The Excel code of the source cells (2.3.0): a code the labels
        # cannot print as PowerPoint does is refused here, by name.
        try:
            G.parse_number_format(raw.get('number_format'))
        except G.ChartDataError as exc:
            problems.append('%s: %s' % (where, exc))
        self.check_line(raw, where, problems)

    def check_line(self, raw, where, problems):
        """`value_labels` and `fill`: their values, that they sit on a line
        chart, and not together - labels go on lines, and a filled chart has
        none. A line over an area and dots on unlabelled points were tried and
        withdrawn at the PowerPoint gate (2026-09-30, AGENTS.md).

        2.3.0 (the designers' review): labels go on every point or none, on
        at most two lines of at most eight points; `fill` is switched off
        by `features.line_fill` in chart-palette.json."""
        given = [k for k in self.LINE_FIELDS if raw.get(k) not in (None, False)]
        if given and raw.get('chart_type') != 'line':
            problems.append('%s: "%s" belongs to a line chart - drop it or '
                            'use chart_type "line"' % (where, given[0]))
        labels = raw.get('value_labels')
        if labels in G.WITHDRAWN_LABEL_MODES:
            problems.append('%s: "value_labels": %r was withdrawn in 2.3.0 - a '
                            'line is labelled at every point (true) or not at '
                            'all; say the one figure in the slide text'
                            % (where, labels))
        elif labels is not None and labels is not True and labels is not False:
            problems.append('%s: "value_labels" is true (every point) or '
                            'false, not %r' % (where, labels))
        elif labels is True and raw.get('chart_type') == 'line':
            series, points = _data_shape(raw)
            if series is not None and series > G.LABELLED_LINES_MAX:
                problems.append(
                    '%s: "value_labels" go on at most %d lines, this chart '
                    'has %d - drop "value_labels" (the value axis reads '
                    'them) or chart fewer series'
                    % (where, G.LABELLED_LINES_MAX, series))
            if points is not None and points > G.LABELLED_POINTS_MAX:
                problems.append(
                    '%s: "value_labels" go on at most %d points, this chart '
                    'has %d - drop "value_labels" (the value axis reads '
                    'them) or chart fewer categories'
                    % (where, G.LABELLED_POINTS_MAX, points))
        fill = raw.get('fill')
        if fill and not G.load_palette().features.get('line_fill'):
            problems.append('%s: "fill" is switched off (2.3.0, '
                            'features.line_fill in chart-palette.json) - drop '
                            'it; the series are drawn as lines' % where)
        elif fill is not None and not isinstance(fill, bool):
            problems.append('%s: "fill" is true - every series drawn as an '
                            'area - not %r' % (where, fill))
        elif fill and labels:
            problems.append('%s: "value_labels" go on lines and a "fill" chart '
                            'has none - drop one of them' % where)
        elif fill and _series_count(raw) == 1:
            # One area is a wedge of colour: the guide layers nested series
            # (v2.2.0 stress test, slides 29 and 30).
            problems.append('%s: "fill" layers two or more nested series; one '
                            'series is a line - drop "fill" (and label it with '
                            '"value_labels" if the numbers matter)' % where)

    def check_list(self, value, where, problems):
        """The `charts` field of `chart-two`: chart objects, each with the
        fields of a single chart."""
        if not isinstance(value, list) or not value:
            problems.append('%s: "charts" must be a non-empty list of chart '
                            'objects' % where)
            return
        allowed = self.FIELDS
        for number, item in enumerate(value, 1):
            label = '%s: chart %d' % (where, number)
            if not isinstance(item, dict):
                problems.append('%s: must be an object with fields %s'
                                % (label, ', '.join(allowed)))
                continue
            for key in item:
                if key not in allowed:
                    problems.append('%s: unknown field "%s"; allowed: %s'
                                    % (label, key, offered(allowed)))
            if not item.get('data'):
                problems.append('%s: the "data" field is required' % label)
            if not item.get('chart_type'):
                problems.append('%s: the "chart_type" field is required' % label)
            if not item.get('chart_title'):
                problems.append('%s: %s' % (where, self.UNTITLED % number))
            self.check_source(item, label, problems)
            if item.get('center') is not None \
                    and not isinstance(item.get('center'), str):
                problems.append('%s: the "center" field must be a string' % label)

    # -- deck

    def resolve(self, chart, skill_dir):
        """Validate and load one chart in place: type, mode, data, colours.

        A bad type, a malformed CSV or a palette overflow surfaces here, before
        anything is written to disk. The spec has already checked what it can;
        this is the whole check for a chart built through the `Deck` API.
        """
        if chart['chart_type'] not in G.CHART_TYPES:
            raise ValueError(
                'chart_type must be one of %s, got %r'
                % (', '.join(repr(t) for t in G.CHART_TYPES),
                   chart['chart_type']))
        if chart.get('mode') not in (None,) + G.MODES:
            raise ValueError('mode must be one of %s, got %r'
                             % (', '.join(repr(m) for m in G.MODES),
                                chart.get('mode')))
        if isinstance(chart['data'], dict):
            chart['data'] = CD.from_inline(chart['data'])
        else:
            if not chart.get('x') or not chart.get('y'):
                raise ValueError('a CSV chart needs "x" and "y" - the '
                                 'category and value column headers')
            chart['data'] = CD.load_csv(chart['data'], chart['x'], chart['y'])
        self._number_format(chart)
        # Colours now, not at paint time: a doughnut of nine slices or a stack
        # past the palette fails with its slide number, before anything is
        # written.
        chart['colors'] = G.assign_colors(
            G.load_palette(skill_dir), chart['chart_type'],
            chart['data'], chart.get('mode'))
        # The same for a line's fields: two filled series that cross fail
        # here, with the slide number.
        problems = []
        self.check_line(chart, 'chart', problems)
        if problems:
            raise ValueError(problems[0][len('chart: '):])
        G.line_options(chart.get('value_labels'), chart.get('fill'),
                       chart['data'])
        return chart


    # A `%` code over values past this is a percentage written in points: 27
    # for 27 %, which `0%` prints as 2700%.
    PERCENT_MAX = 10

    def _number_format(self, chart):
        """The chart's format code onto its data, which both media read."""
        code = chart.get('number_format')
        number_format = G.parse_number_format(code)
        data = chart['data']
        data.number_format = number_format.code if number_format else None
        if number_format is not None and number_format.percent:
            top = max(abs(v) for s in data.series for v in s.values)
            if top > self.PERCENT_MAX:
                raise ValueError(
                    'number_format %r prints %s as %s - a percentage is a '
                    'fraction, as in Excel: 0.27 for 27%%. Give the values as '
                    'the cells hold them, or the code the cells show them with '
                    '(0"%%" for 27 shown as 27%%)'
                    % (code, G.format_number(top, 0, True),
                       number_format.render(top)))


CHART = Chart()


# ------------------------------------------------------------------- table

class Table(object):
    """A native table's fields (2.4.0, the designers' tables).

    Two layouts hold one: `table` carries it on the slide itself - a header
    and rows of cells - and `table-compare` carries two small ones in
    `tables`, each a title over rows of a label and a value. A cell is a
    string or `{"text": ..., "tone": "positive" | "negative"}`: the red and
    green of a value are the one place the skill paints a figure by its
    meaning outside a chart, so `tone` exists on table cells and nowhere
    else (the author, 2026-10-09). Lists in cells were tried and dropped.
    """

    TONES = ('positive', 'negative')
    COLUMNS = (2, 6)
    ROWS = (1, 8)
    COMPARE_ROWS = (2, 6)
    # A column whose filled cells all read as figures is set to the right,
    # as the designers set every number column; a dash marks a gap. A figure
    # is a signed number with an optional unit after it ("25 000", "−1 600",
    # "48 %", "3,5 млн", "120 ₽", "x2"): the unit is at most a short word.
    _NUMBER = re.compile(u'^[x×]?[+\\-−±]?\\d[\\d\\s  .,]*'
                         u'(\\s*[^\\d\\s]{1,4}\\.?){0,2}$', re.U)
    _DASHES = (u'—', u'–', '-', u'−')

    # -- spec

    def _cell(self, value, label, problems):
        if isinstance(value, str):
            return
        if not isinstance(value, dict):
            problems.append('%s: a cell is a string or an object {"text": '
                            '..., "tone": "positive" | "negative"}' % label)
            return
        for key in value:
            if key not in ('text', 'tone'):
                problems.append('%s: unknown field "%s"; allowed: text, tone'
                                % (label, key))
        if not isinstance(value.get('text'), str):
            problems.append('%s: the "text" field must be a string' % label)
        tone = value.get('tone')
        if tone is not None and tone not in self.TONES:
            problems.append('%s: "tone" is "positive" (green) or "negative" '
                            '(red), not %r' % (label, tone))

    def check(self, raw, holder, where, problems):
        """The table fields of one slide, every problem collected."""
        if holder == 'tables':
            self._check_compare(raw.get('tables'), where, problems)
            return
        header, rows = raw.get('header'), raw.get('rows')
        width = None
        low, high = self.COLUMNS
        if header is not None:
            if not isinstance(header, list) or not all(
                    isinstance(h, str) for h in header):
                problems.append('%s: "header" is a list of column headings '
                                '(strings)' % where)
            elif not low <= len(header) <= high:
                problems.append('%s: a table has %d to %d columns, the header '
                                'names %d - split a wider table across two '
                                'slides' % (where, low, high, len(header)))
            else:
                width = len(header)
        for key in ('label_column', 'total_column'):
            if raw.get(key) is not None and not isinstance(raw[key], bool):
                problems.append('%s: "%s" is true or false, not %r'
                                % (where, key, raw[key]))
        if rows is None:
            return
        low, high = self.ROWS
        if not isinstance(rows, list) or not rows:
            problems.append('%s: "rows" is a list of rows, each a list of '
                            'cells' % where)
            return
        if len(rows) > high:
            problems.append('%s: a table holds %d rows at most, got %d - '
                            'keep the rows that carry the point, or split the '
                            'table' % (where, high, len(rows)))
        for number, row in enumerate(rows, 1):
            label = '%s: row %d' % (where, number)
            if not isinstance(row, list):
                problems.append('%s: must be a list of cells' % label)
                continue
            if width is not None and len(row) != width:
                problems.append('%s: has %d cells, the header has %d - every '
                                'row has a cell per column ("" for an empty '
                                'one)' % (label, len(row), width))
            for column, cell in enumerate(row, 1):
                self._cell(cell, '%s, cell %d' % (label, column), problems)

    def _check_compare(self, tables, where, problems):
        if not isinstance(tables, list) or len(tables) != 2:
            problems.append('%s: "tables" is exactly two objects {"title": '
                            '..., "rows": [{"label": ..., "value": ...}]}'
                            % where)
            return
        low, high = self.COMPARE_ROWS
        for number, table in enumerate(tables, 1):
            label = '%s: table %d' % (where, number)
            if not isinstance(table, dict):
                problems.append('%s: must be an object with fields title, '
                                'rows' % label)
                continue
            for key in table:
                if key not in ('title', 'rows'):
                    problems.append('%s: unknown field "%s"; allowed: title, '
                                    'rows' % (label, key))
            if not isinstance(table.get('title'), str) \
                    or not table['title'].strip():
                problems.append('%s: the "title" field is required' % label)
            rows = table.get('rows')
            if not isinstance(rows, list):
                problems.append('%s: "rows" is a list of {"label": ..., '
                                '"value": ...}' % label)
                continue
            if not low <= len(rows) <= high:
                problems.append('%s: takes %d to %d rows, got %d'
                                % (label, low, high, len(rows)))
            for position, row in enumerate(rows, 1):
                here = '%s, row %d' % (label, position)
                if not isinstance(row, dict):
                    problems.append('%s: must be an object {"label": ..., '
                                    '"value": ..., "tone": ...}' % here)
                    continue
                for key in row:
                    if key not in ('label', 'value', 'tone'):
                        problems.append('%s: unknown field "%s"; allowed: '
                                        'label, value, tone' % (here, key))
                for key in ('label', 'value'):
                    if not isinstance(row.get(key), str) \
                            or not row[key].strip():
                        problems.append('%s: the "%s" field is required'
                                        % (here, key))
                if row.get('tone') is not None \
                        and row['tone'] not in self.TONES:
                    problems.append('%s: "tone" is "positive" (green) or '
                                    '"negative" (red), not %r'
                                    % (here, row['tone']))

    # -- deck

    def numeric(self, text):
        text = (text or '').strip()
        return bool(text) and (text in self._DASHES
                               or bool(self._NUMBER.match(text)))

    def normalise(self, data, holder):
        """Check, then turn the fields into what the filler reads.

        `table`: `rows` become lists of {"text", "tone"} and two lists are
        added - `numeric` (the column is set to the right) and `strong`
        (Medium: the label and the total column).
        """
        problems = []
        self.check(data, holder, 'table', problems)
        if holder == 'slide':
            if not data.get('header'):
                problems.append('table: the "header" field is required')
            if not data.get('rows'):
                problems.append('table: the "rows" field is required')
        if problems:
            raise ValueError('\n'.join(p[len('table: '):]
                                       if p.startswith('table: ') else p
                                       for p in problems))
        if holder == 'tables':
            data['tables'] = [
                {'title': t['title'],
                 'rows': [{'label': r['label'], 'value': r['value'],
                           'tone': r.get('tone')} for r in t['rows']]}
                for t in data['tables']]
            return data
        rows = [[{'text': c, 'tone': None} if isinstance(c, str)
                 else {'text': c.get('text', ''), 'tone': c.get('tone')}
                 for c in row] for row in data['rows']]
        width = len(data['header'])
        numeric = []
        for column in range(width):
            texts = [row[column]['text'].strip() for row in rows
                     if row[column]['text'].strip()]
            numeric.append(bool(texts) and all(self.numeric(t) for t in texts)
                           and any(t not in self._DASHES for t in texts))
        strong = [False] * width
        if data.get('label_column'):
            strong[0] = True
        if data.get('total_column'):
            strong[-1] = True
        data['rows'] = rows
        data['numeric'] = numeric
        data['strong'] = strong
        return data


TABLE = Table()
