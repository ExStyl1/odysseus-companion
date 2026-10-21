# -*- coding: utf-8 -*-
"""Fill layouts with content.

Each function receives template markup and data, returns a ready slide.
Functions fill and trim markup; they do not invent nodes, which would break
alignment with the reference layout. One exception is a row whose count
is the data's - legend entries, chart points, a chart card's head - which is
cloned from the template's own prototype, so it keeps the reference styling.
The other is a numbered card (2.4.0): its icon holder turns into the number
badge, whose look is base.css's.
"""
import copy
import json

from .html2pptx import chartgeom as G
from . import fragments as F
from . import layouts as L
from .typeset import glue_headline


def _card_font_size(description):
    """Card description font size — inline, depends on card size."""
    if description is None:
        return None
    for declaration in (description.get('style') or '').split(';'):
        name, _, value = declaration.partition(':')
        if name.strip() == 'font-size':
            return value.strip()
    return None


def _fill_card_items(library, node, items, prefix):
    """Bulleted list inside a card.

    Block borrowed from the 'bullets' reference fragment, the one list the
    template draws. Font size follows this card's description:
    denser grid means smaller text, list must follow.
    """
    description = F.first(node, 'card-description')
    size = _card_font_size(description)

    holder = F.borrow(library, 'bullets', 'bullet-list')
    F.retarget_assets(holder, prefix)
    rows = F.keep_first(F.by_class(holder, 'bullet-item'), len(items))
    for text, row in zip(items, rows):
        line = F.first(row, 'bullet-text')
        F.set_text_formula(line, text)
        if size is not None and line is not None:
            line.set('style', ((line.get('style') or '').rstrip('; ')
                               + ';font-size:%s' % size).lstrip(';'))

    if description is not None and not (description.text or '').strip():
        # Description empty — list takes its place, not hangs below.
        parent = description.getparent()
        parent.replace(description, holder)
    else:
        anchor = description if description is not None \
            else F.first(node, 'card-subtitle')
        anchor.addnext(holder)


def _fill_cards(library, slide, cards, icons, prefix):
    """Common part for all card layouts."""
    nodes = F.by_class(slide, 'card')
    for card, node in zip(cards, nodes):
        head = F.first(node, 'card-subtitle')
        if card.value:
            # Reuse the chart-card figure role at the existing head position.
            # Its size rides the same pair search as every other card text.
            head.set('class', ' '.join(
                'chart-card-value' if c == 'card-subtitle' else c
                for c in head.get('class', '').split()))
        F.set_text(head, card.value or card.title)
        F.set_text_formula(F.first(node, 'card-description'), card.text)
        if card.items:
            _fill_card_items(library, node, card.items, prefix)
        if card.icon:
            F.set_icon(F.first(node, 'icon'), icons.resolve(card.icon), prefix)
        elif F.first(node, 'card-number') is None:
            F.drop_icon(node)
    return nodes


def title(library, slide, data, icons, prefix):
    # The headline is `text`, not `title`: this was the one layout whose spec
    # field and slide-data key had different names, which is what forced the
    # spec to translate every layout by hand instead of passing it through.
    F.set_text(F.first(slide, 'title-large'), data['text'])
    F.set_text(F.first(slide, 'subtitle-large'), data.get('subtitle', ''))
    author = F.first(slide, 'text-author')
    if data.get('author'):
        F.set_text(author, data['author'])
    elif author is not None and author.getparent() is not None:
        author.getparent().remove(author)
        # Centred on the slide, the block balances the logo above against
        # the author line below; with no author it reads as sitting high
        # (2.3.0, the designers). It moves to the centre of the room under
        # the logo instead.
        block = F.first(slide, 'title-large').getparent()
        block.set('style', block.get('style').replace(
            'top: 50%;', 'top: %dpx;' % _TITLE_CENTRE_NO_AUTHOR))
        # The logo follows it part of the way, or it hangs alone at the top
        # over a block that went down (the author, 2026-10-03).
        logo = F.first(slide, 'logo')
        logo.set('style', logo.get('style').replace(
            'top: 146px;', 'top: %dpx;' % _TITLE_LOGO_NO_AUTHOR))
    return slide


# The centre of the title block when there is no author line: midway between
# the logo's bottom (262) and the glass panel's (1040). 598, the logo's own
# margin mirrored at the bottom, still read high on the preview.
_TITLE_CENTRE_NO_AUTHOR = 651
# The logo's top then: 146 with an author.
_TITLE_LOGO_NO_AUTHOR = 200


def self_intro(library, slide, data, icons, prefix):
    """Introduce a requested speaker using the shared picture and triangle list."""
    F.set_text(F.first(slide, 'title-person'), data['name'])
    F.set_text(F.first(slide, 'intro-role'), data['role'])
    F.first(slide, 'intro-photo').set('src', data['src'])
    holder = F.borrow(library, 'bullets', 'bullet-list')
    F.retarget_assets(holder, prefix)
    rows = F.keep_first(F.by_class(holder, 'bullet-item'), len(data['items']))
    for text, row in zip(data['items'], rows):
        line = F.first(row, 'bullet-text')
        line.set('class', line.get('class') + ' intro-bullet-text')
        F.set_text(line, text)
    F.first(slide, 'intro-list-region').append(holder)
    return slide


def circle(library, slide, data, icons, prefix):
    """Editable orbit diagram and exactly two icon cards."""
    F.set_text(F.first(slide, 'title-chart-large'), data['title'])
    for node, item in zip(F.by_class(slide, 'circle-point'), data['points']):
        F.set_text(F.first(node, 'card-description'), item['text'])
        F.set_icon(F.first(node, 'icon'), icons.resolve(item['icon']), prefix)
    _fill_cards(library, F.first(slide, 'circle-right'), data['cards'], icons, prefix)
    return slide


def illustration_points(library, slide, data, icons, prefix):
    """The supplied hero scene and a measured list of titled icon points."""
    F.set_text(F.first(slide, 'title-chart-large'), data['title'])
    holder = F.first(slide, 'illustration-list')
    _add_class(holder, 'count-%d' % len(data['points']))
    rows = F.keep_first(F.by_class(holder, 'illustration-point'), len(data['points']))
    for item, row in zip(data['points'], rows):
        F.set_text(F.first(row, 'card-subtitle'), item['title'])
        F.set_text(F.first(row, 'card-description'), item['text'])
        F.set_icon(F.first(row, 'icon'), icons.resolve(item['icon']), prefix)
    return slide


def agenda(library, slide, data, icons, prefix):
    F.set_text(F.first(slide, 'title-agenda'), data['title'])
    rows = F.by_class(slide, 'agenda-number')
    items = data['items']
    # Agenda item is the common parent of number and description.
    parents = [node.getparent() for node in rows]
    F.keep_first(parents, len(items))
    for index, (text, parent) in enumerate(zip(items, parents), 1):
        F.set_text(F.first(parent, 'agenda-number'), '%02d' % index)
        F.set_text(F.first(parent, 'agenda-description'), text)
    return slide


def cards(library, slide, data, icons, prefix):
    F.set_text(F.first(slide, 'slide-title'), data['title'])
    if data.get('numbered'):
        _number_cards(F.by_class(slide, 'card'))
    _fill_cards(library, slide, data['cards'], icons, prefix)
    return slide


def _add_class(node, name):
    node.set('class', ' '.join(node.get('class', '').split() + [name]))


def _number_cards(nodes):
    """`"numbered": true` (2.4.0, the designers' numberd_cards): every card
    grey — a yellow one would melt into the yellow number — and the icon's
    corner holds the number instead. The icon holder itself becomes the
    badge, so it keeps the place and the class autofit reserves a band for;
    the outline with the notch around it is `.card.numbered` in base.css."""
    for number, node in enumerate(nodes, 1):
        classes = [c for c in node.get('class', '').split() if c != 'yellow']
        if 'gray' not in classes:
            classes.append('gray')
        node.set('class', ' '.join(classes + ['numbered']))
        holder = F.first(node, 'icon-container')
        for child in list(holder):
            holder.remove(child)
        holder.set('class', 'icon-container card-number')
        holder.attrib.pop('style', None)
        circle = holder.makeelement('div', {'class': 'card-number-circle'})
        digit = circle.makeelement('p', {})
        digit.text = str(number)
        circle.append(digit)
        holder.append(circle)


def text_slide(library, slide, data, icons, prefix):
    F.set_text(F.first(slide, 'title-large'), data['text'])
    return slide


def long_text(library, slide, data, icons, prefix):
    F.set_text(F.first(slide, 'title-large'), data['title'])
    F.set_text(F.first(slide, 'text-body'), data['text'])
    return slide


def versus(library, slide, data, icons, prefix):
    """Two sides, yellow on the left: title, subtitle if any, text."""
    for node, side in zip(F.by_class(slide, 'versus-card'), data['sides']):
        F.set_text(F.first(node, 'versus-title'), side['title'])
        F.set_text(F.first(node, 'card-description'), side['text'])
        if side.get('subtitle'):
            F.set_text(F.first(node, 'card-subtitle'), side['subtitle'])
        else:
            _drop(F.first(node, 'card-subtitle'))
    return slide


def _any_of(root, names):
    """First found element from the list of classes. Metrics in different layouts
    have different classes: large values vs six-card grid."""
    for name in names:
        found = F.first(root, name)
        if found is not None:
            return found
    return None


_VALUE_CLASSES = ('metric-value-large', 'metric-value-medium')
_NOTE_CLASSES = ('metric-description', 'metric-description-small')


def metrics(library, slide, data, icons, prefix):
    F.set_text(F.first(slide, 'title-slide'), data['title'])
    F.set_text(_any_of(slide, ('subtitle-medium', 'subtitle-small')),
               data.get('subtitle', ''))

    values = (F.by_class(slide, 'metric-value-large')
              or F.by_class(slide, 'metric-value-medium'))
    columns = [node.getparent() for node in values]
    F.keep_first(columns, len(data['metrics']))

    for metric, column in zip(data['metrics'], columns):
        F.set_text(_any_of(column, _VALUE_CLASSES), metric.value,
                   typeset=False)
        F.set_text_formula(_any_of(column, _NOTE_CLASSES), metric.text)
    return slide


def final(library, slide, data, icons, prefix):
    F.set_text(F.first(slide, 'title-xlarge'), data.get('text', 'Спасибо\nза внимание'))
    return slide


# -------------------- v1.4 column components

def _drop(element):
    """Remove node along with the space it occupied in the flex column."""
    if element is not None and element.getparent() is not None:
        element.getparent().remove(element)


def timeline(library, slide, data, icons, prefix):
    """Numbered stages on a horizontal line: 3, 4 or 5 points.

    Point subtitle is 'all or nothing' on a slide. Inconsistency within one
    row shifts baselines of descriptions relative to each other, and the slide
    reads as broken; this is checked in schema.py, here it is only enforced.

    Headline here is `.title-large` (144px), not `.slide-title`: in the export
    this layout has a large headline, and it moves on its own ladder against
    the row of points.
    """
    F.set_text(F.first(slide, 'title-large'), data['title'])

    points = F.keep_first(F.by_class(slide, 'timeline-point'),
                          len(data['points']))
    for index, (point, node) in enumerate(zip(data['points'], points), 1):
        F.set_text(F.first(node, 'timeline-number'), str(index))
        title = F.first(node, 'point-title')
        if point.get('title'):
            F.set_text(title, point['title'])
        else:
            _drop(title)
        F.set_text_formula(F.first(node, 'point-text'), point['text'])
    return slide


def flow(library, slide, data, icons, prefix):
    """Icons on a line inside a white panel: 4 or 5 steps, plus summary.

    Summary is not a removable node but a separate layout (`flow-N-summary`).
    With and without it the caption box has different height — 130 vs 258, —
    and only this way both layouts sit on the same coordinates as in the export.
    One fragment does not do this: a box growing under text would reproduce the
    layout, but there would be nothing to pick the size from.
    """
    F.set_text(F.first(slide, 'slide-title'), data['title'])

    steps = F.keep_first(F.by_class(slide, 'flow-step'), len(data['steps']))
    for step, node in zip(data['steps'], steps):
        F.set_icon(F.first(node, 'icon'), icons.resolve(step['icon']), prefix)
        F.set_text_formula(F.first(node, 'point-text'), step['text'])
    if data.get('highlight_last'):
        # 2.4.0, the designers' series: the last step in yellow, the line
        # into it running from the grey into that yellow (base.css).
        _add_class(steps[-1], 'focus')
        _add_class(steps[-2], 'into-focus')

    summary = F.first(slide, 'flow-summary')
    if summary is not None and data.get('summary'):
        F.set_text(F.first(summary, 'point-title'), data['summary']['title'])
        F.set_text(F.first(summary, 'point-text'), data['summary']['text'])
    return slide


def columns(library, slide, data, icons, prefix):
    """Dark slide: yellow header with title and 3-6 columns on a white panel."""
    F.set_text(F.first(slide, 'slide-title'), data['title'])

    nodes = F.keep_first(F.by_class(slide, 'columns-col'),
                         len(data['columns']))
    for column, node in zip(data['columns'], nodes):
        F.set_text(F.first(node, 'point-title'), column['title'])
        F.set_text_formula(F.first(node, 'point-text'), column['text'])
    return slide


# -------------------- v1.6: image and chart slides

def _media_common(slide, data, icons, prefix):
    """Title, optional note (icon + text) and caption of the image slide."""
    F.set_text(F.first(slide, 'title-large'), data['title'])
    if data.get('note_icon'):
        F.set_icon(F.first(slide, 'icon'), icons.resolve(data['note_icon']), prefix)
    else:
        _drop(F.first(slide, 'media-note-icon'))
    F.set_text(F.first(slide, 'media-note-text'), data.get('note', ''))
    F.set_text(F.first(slide, 'media-caption'), data.get('caption', ''))


def image(library, slide, data, icons, prefix):
    _media_common(slide, data, icons, prefix)
    img = F.first(slide, 'media-image')
    if img is not None:
        img.set('src', data['src'])
    return slide


def _fill_icon_holder(holder, icon_name, prefix):
    """Set the icon inside a `.chart-*-icon` holder, or drop the holder.

    Chart icons sit in their own holders (`.chart-point-icon`,
    `.chart-note-icon` in the note row), not in the `.icon-container` that
    `drop_icon` removes, so they get their own branch here.
    """
    if holder is None:
        return
    if icon_name:
        F.set_icon(F.first(holder, 'icon'), icon_name, prefix)
    else:
        _drop(holder)


def _legend_entries(data):
    """(labels, colours) for the legend, in the order the reader sees them.

    The designer's stack legend mirrors the column: the top entry is the top
    segment, which is the *last* series — PowerPoint stacks series 1 at the
    bottom, so a stacked legend reads reversed. A doughnut's legend is its
    clockwise slice order; bar/line legends are the series order. A single
    series has no legend (slide 65): the chart title already names it, and in
    `mode: value` its colours are the data.
    """
    colors = data.get('colors') or {}
    kind = G.canonical(data['chart_type'])
    if kind == 'doughnut':
        return list(data['data'].categories), list(colors.get('points') or [])
    if 'series' not in colors or len(data['data'].series) < 2:
        return [], []
    labels = [s.name for s in data['data'].series]
    order = list(colors.get('series') or [])
    if kind == 'stacked':
        labels.reverse()
        order.reverse()
    return labels, order


def _legend_dense(data):
    """True when a chart's legend crosses the dense threshold.

    Past the threshold the design ships a denser legend (I4) and places it as
    a column (I7): a 10-entry head row of 48 px gaps has no room. The count is
    the legend's own entry count, so a doughnut (categories, not series) is
    counted the same way as a multi-series bar.
    """
    labels, _ = _legend_entries(data)
    threshold = G.load_palette().type.get('data_label_dense_threshold', 10)
    return len(labels) >= threshold


def _legend_placement(data):
    """Which legend block a chart carries: the head row or the right column.

    The templates carry both as prototypes; the filler keeps one. Line and
    grouped bars read as a top legend (slides 64/69); a stack and a doughnut
    as a right column, in the order of the segments (67/68). Past
    `legend_row_max` entries a line or bar legend is a column too: the row
    never wraps (base.css), and eight short names ran 680 px off the slide
    (v2.1.0 stress test).
    """
    kind = G.canonical(data['chart_type'])
    labels, _ = _legend_entries(data)
    row_max = G.load_palette().type.get('legend_row_max', 4)
    if kind in ('line', 'bar') and len(labels) <= row_max:
        return 'row'
    return 'column'


def _fill_legend(container, data):
    """Clone the legend's prototype item once per entry, coloured and named.

    The templates carry a single `legend-item` prototype per container;
    `keep_first` truncates and would leave one row, so any extra rows are
    deep-copied from the prototype before writing. Cloning in the filler beats
    N prototypes because the row count is data-driven and unbounded. `chart_two`
    runs this once per plate, so both its legends get the same treatment.
    """
    if container is None:
        return
    labels, colors = _legend_entries(data)
    items = F.by_class(container, 'legend-item')
    if not items:
        return
    if len(items) < len(labels):
        proto = items[0]
        parent = proto.getparent()
        for _ in range(len(labels) - len(items)):
            clone = copy.deepcopy(proto)
            parent.append(clone)
            items.append(clone)
    # I4: a dense legend is drawn at the compact size (21 px gaps, 34 px
    # swatch, 16.5 pt label) by marking the container `compact`; the template
    # values for that size are already in base.css.
    if _legend_dense(data):
        cur = container.get('class') or ''
        if 'compact' not in cur.split():
            container.set('class', (cur + ' compact').strip())
    kind = G.canonical(data['chart_type'])
    fill = data.get('fill')
    for item, label, color in zip(items, labels, colors):
        swatch = F.first(item, 'legend-swatch')
        if swatch is not None:
            swatch.set('style', 'background: #%s;' % color)
            # I9: the swatch shape follows the chart type — a line chart's
            # swatch is a thin pill, not a square. The chart-cards template
            # already marks its line swatch; the filler must set the same
            # class for line charts on the other layouts. A `fill` chart's
            # series are patches of colour, and keep the square.
            swatch_classes = (swatch.get('class') or '').split()
            if kind == 'line' and not fill:
                if 'line' not in swatch_classes:
                    swatch.set('class', ' '.join(swatch_classes + ['line']))
            elif 'line' in swatch_classes:
                swatch_classes.remove('line')
                swatch.set('class', ' '.join(swatch_classes))
        F.set_text(F.first(item, 'legend-label'), label)


def _native_center(data):
    """Whether a doughnut's `center` goes into the chart (title linked to a
    workbook cell) rather than into the layout's `chart-center` box."""
    return bool(data.get('chart_type') == 'doughnut' and data.get('center')
                and G.load_palette().features.get('native_center', True))


def _fill_chart_plate(plate, data, prefix):
    """Fill one chart plate: canvas marker, chart title, legends, centre.

    `plate` is a slide or a `.chart-plate` element; `data` is a chart dict
    (`chart_type`, `mode`, `colors`, `data` as a ChartData, `chart_title`,
    `center`). Shared by all four chart layouts.
    """
    marker = F.first(plate, 'chart-canvas')
    if marker is not None:
        payload = {
            'type': data['chart_type'],
            'mode': data.get('mode'),
            'colors': data.get('colors'),
            'categories': data['data'].categories,
            'series': [{'name': s.name, 'values': s.values}
                       for s in data['data'].series],
        }
        # A line chart's options, only when set: a chart without them keeps
        # the markup it had before they existed.
        for key in ('value_labels', 'fill'):
            if data.get(key):
                payload[key] = data[key]
        if data['data'].number_format:
            payload['number_format'] = data['data'].number_format
        if _native_center(data):
            payload['center'] = data['center']
        marker.set('data-chart', json.dumps(payload))
    if data.get('chart_title'):
        F.set_text(F.first(plate, 'chart-title'), data['chart_title'])
    else:
        _drop(F.first(plate, 'chart-title'))

    # The centre figure is a doughnut-only box; anything else would overprint
    # the plot. `center` is the value string, so the caption is dropped too.
    # Since 2.3.0 the chart draws it (the title, linked to a workbook cell)
    # and the box goes, unless features.native_center turns that off.
    centre = F.first(plate, 'chart-center')
    if data.get('chart_type') == 'doughnut' and data.get('center') \
            and not _native_center(data):
        F.set_text(F.first(plate, 'chart-center-value'), data['center'])
        _drop(F.first(plate, 'chart-center-text'))
    else:
        _drop(centre)

    labels, _ = _legend_entries(data)
    row = F.first(plate, 'legend-row')
    column = F.first(plate, 'legend-column')
    if not labels:
        # No series-based legend — a single series painted by sign. Both
        # blocks are dropped; a stale prototype item would mislead.
        _drop(row)
        _drop(column)
    elif _legend_placement(data) == 'row':
        _fill_legend(row, data)
        _drop(column)
    else:
        _fill_legend(column, data)
        _drop(row)
    # A head left with neither a chart title nor a legend row would still
    # hold its margin over the chart; the chart takes the room instead.
    head = F.first(plate, 'chart-head')
    if head is not None and not len(head):
        _drop(head)


def chart(library, slide, data, icons, prefix):
    """Single chart slide: title, 1-5 points (selectable icons) bottom-left,
    one plate on the right. There is no note-only variant.

    The chart marker gets its data as a `data-chart` JSON attribute. Nothing
    on the box tree survives the serialize-to-disk-and-reparse round trip in
    build.py/document.py except what lives in the HTML text itself — see
    `layout.py`'s `_decode_chart`, the other end of this trip. The single
    chart always fills the points list (chart-points); rows are cloned to the
    count.
    """
    F.set_text(F.first(slide, 'title-chart'), data['title'])
    _fill_chart_plate(slide, data, prefix)
    _fill_points(slide, data, prefix)
    return slide


def _fill_points(slide, data, prefix):
    """The shared bottom-aligned takeaway list for images and charts."""

    # The single-chart layout always carries a points list (1-5 rows,
    # selectable icons, anchored bottom-left); there is no note variant. Rows
    # are cloned from the single prototype to the count; a point without an
    # icon drops its icon holder.
    rows = data.get('points') or []
    points = F.by_class(slide, 'chart-point')
    if len(points) < len(rows):
        proto = points[0]
        parent = proto.getparent()
        for _ in range(len(rows) - len(points)):
            parent.append(copy.deepcopy(proto))
    elif len(points) > len(rows):
        F.keep_first(points, len(rows))
    for point, row in zip(F.by_class(slide, 'chart-point'), rows):
        _fill_icon_holder(F.first(point, 'chart-point-icon'),
                          row.get('icon'), prefix)
        F.set_text(F.first(point, 'chart-point-text'), row.get('text', ''))


def _fill_picture(node, src, fit):
    node.set('src', src)
    # Omission and explicit cover retain the accepted template byte-for-byte.
    if fit == 'contain':
        node.set('style', (node.get('style') or '') + '; object-fit: contain;')
        node.set('data-contain-safe', 'true')


def image_points(library, slide, data, icons, prefix):
    F.set_text(F.first(slide, 'title-chart'), data['title'])
    _fill_picture(F.first(slide, 'media-image'), data['src'], data.get('fit'))
    _fill_points(slide, data, prefix)
    return slide


def image_wide(library, slide, data, icons, prefix):
    F.set_text(F.first(slide, 'title-chart-large'), data['title'])
    F.first(slide, 'media-image').set('src', data['src'])
    _fill_note(slide, data, prefix)
    return slide


def image_gallery(library, slide, data, icons, prefix):
    F.set_text(F.first(slide, 'title-chart-large'), data['title'])
    for node, item in zip(F.by_class(slide, 'gallery-item'), data['images']):
        F.first(node, 'media-image').set('src', item['src'])
        F.set_icon(F.first(node, 'icon'), item['icon'], prefix)
        F.set_text(F.first(node, 'card-subtitle'), item['title'])
        F.set_text(F.first(node, 'card-description'), item['text'])
    return slide


def _fill_screen(node, src, fit):
    node.set('src', src)
    node.set('style', 'object-fit: %s;' % (fit or 'cover'))


def screenshot_phone(library, slide, data, icons, prefix):
    """Fill supplied screen originals, retaining the template's devices."""
    F.set_text(F.first(slide, 'title-screenshot'), glue_headline(data['title']))
    F.set_text(F.first(slide, 'screenshot-description'), data['text'])
    for node, item in zip(F.by_class(slide, 'screenshot-item'), data['images']):
        _fill_screen(F.first(node, 'screenshot-screen'), item['src'], data.get('fit'))
        if item.get('caption', '').strip():
            F.set_text(F.first(node, 'screenshot-caption'), item['caption'])
        else:
            _drop(F.first(node, 'screenshot-annotation'))
    return slide


def screenshot_monitor(library, slide, data, icons, prefix):
    F.set_text(F.first(slide, 'title-screenshot'), glue_headline(data['title']))
    _fill_screen(F.first(slide, 'screenshot-screen'), data['src'], data.get('fit'))
    _fill_points(slide, data, prefix)
    return slide


def chart_cards(library, slide, data, icons, prefix):
    """Chart with three commentary cards beside it (slide 64, dark slide).

    The plate carries the slide title, the legend and the chart; the cards
    ride the card ladder. A card is a subtitle and a description, or a figure
    (`value`) and a description.
    """
    F.set_text(F.first(slide, 'title-chart'), data['title'])
    _fill_chart_plate(slide, data, prefix)

    # The template carries both card heads: a subtitle on the first two
    # cards, a figure on the third. Each card gets the head its data asks for,
    # cloned from those prototypes, so a figure can stand in any position.
    cards = F.by_class(slide, 'chart-card')
    subtitle = copy.deepcopy(F.first(cards[0], 'card-subtitle'))
    figure = copy.deepcopy(F.first(cards[-1], 'chart-card-value'))
    for card, item in zip(cards, data['cards']):
        head = F.first(card, 'card-subtitle')
        if head is None:
            head = F.first(card, 'chart-card-value')
        value = item.get('value')
        fresh = copy.deepcopy(figure if value else subtitle)
        head.addprevious(fresh)
        _drop(head)
        F.set_text(fresh, value or item.get('title', ''))
        F.set_text(F.first(card, 'card-description'), item.get('text', ''))
    return slide


def chart_two(library, slide, data, icons, prefix):
    """Two half plates side by side, each with its own chart (slides 65/«Работа»).

    `data['charts']` is two chart dicts. `F.keep_first` and the single-canvas
    `F.first` are no use here — each plate carries its own marker — so the
    plates are walked and filled one by one.
    """
    F.set_text(F.first(slide, 'title-chart-large'), data['title'])
    _fill_note(slide, data, prefix)

    plates = F.by_class(slide, 'chart-plate')
    for plate, chart in zip(plates, data['charts']):
        _fill_chart_plate(plate, chart, prefix)
    return slide


def chart_wide(library, slide, data, icons, prefix):
    """One chart across the slide (2.3.0, the designers' long slide): a
    large title and the note of chart-two over one wide plate."""
    F.set_text(F.first(slide, 'title-chart-large'), data['title'])
    _fill_note(slide, data, prefix)
    _fill_chart_plate(slide, data, prefix)
    return slide


# -------------------- 2.4.0: native tables

_TONES = {'positive': 'tone-positive', 'negative': 'tone-negative'}


def _set_classes(node, keep, extra):
    """`node`'s classes: those of `keep` it has, then `extra`, in order."""
    classes = [c for c in (node.get('class') or '').split() if c in keep]
    node.set('class', ' '.join(classes + [c for c in extra if c]))


def _table_cell(proto, text, numeric, strong, tone):
    """A copy of the prototype cell holding `text`, styled by the flags."""
    cell = copy.deepcopy(proto)
    _set_classes(cell, ('table-cell',),
                 ['num' if numeric else '', 'strong' if strong else ''])
    line = F.first(cell, 'table-text')
    _set_classes(line, ('table-text',), [_TONES.get(tone, '')])
    F.set_text(line, text)
    return cell


def _table_row(proto, cells, last):
    """A copy of the prototype row with `cells` in place of its own."""
    row = copy.deepcopy(proto)
    for old in list(row):
        row.remove(old)
    for cell in cells:
        row.append(cell)
    if cells:
        cells[-1].set('class', cells[-1].get('class', '') + ' last-col')
    _set_classes(row, ('table-row', 'table-head'), ['last' if last else ''])
    return row


def _rebuild_grid(grid, rows):
    for old in list(grid):
        grid.remove(old)
    for row in rows:
        grid.append(row)


def table(library, slide, data, icons, prefix):
    """One native table on a white card (the designers' tables, slide 3).

    The template's grid is a prototype - the header row and the first body
    row give a header cell and a body cell; the filler rebuilds the grid to
    the data's shape from them, as `_fill_legend` clones its legend row.
    Which columns are figures and which are Medium was decided by
    `elements.Table.normalise`; here it only becomes classes.
    """
    F.set_text(F.first(slide, 'title-chart-large'), data['title'])
    grid = F.first(slide, 'table-grid')
    head_proto = F.first(grid, 'table-head')
    body_proto = [r for r in F.by_class(grid, 'table-row')
                  if 'table-head' not in r.get('class', '').split()][0]
    head_cell = F.first(head_proto, 'table-cell')
    body_cell = F.first(body_proto, 'table-cell')
    numeric, strong = data['numeric'], data['strong']
    rows = [_table_row(head_proto, [
        _table_cell(head_cell, text, numeric[i], False, None)
        for i, text in enumerate(data['header'])], last=False)]
    for number, line in enumerate(data['rows'], 1):
        rows.append(_table_row(body_proto, [
            _table_cell(body_cell, cell['text'], numeric[i], strong[i],
                        cell['tone'])
            for i, cell in enumerate(line)],
            last=number == len(data['rows'])))
    _rebuild_grid(grid, rows)
    return slide


def table_compare(library, slide, data, icons, prefix):
    """Two small tables, yellow and grey (the designers' tables, slide 1):
    a title over label/value rows, the value on the right in Medium."""
    F.set_text(F.first(slide, 'title-chart-large'), data['title'])
    for card, content in zip(F.by_class(slide, 'compare-card'),
                             data['tables']):
        F.set_text(F.first(card, 'card-subtitle'), content['title'])
        if len(content['rows']) == 6:
            card.set('class', card.get('class', '') + ' compare-six')
        grid = F.first(card, 'table-grid')
        proto = F.first(grid, 'table-row')
        cells = F.by_class(proto, 'table-cell')
        label, value = cells[0], cells[-1]
        rows = []
        for number, row in enumerate(content['rows'], 1):
            rows.append(_table_row(proto, [
                _table_cell(label, row['label'], False, False, None),
                _table_cell(value, row['value'], True, False, row['tone'])],
                last=number == len(content['rows'])))
        _rebuild_grid(grid, rows)
    return slide


def _fill_note(slide, data, prefix):
    """The note beside the title of chart-two and chart-wide: its icon and
    text, or neither (schema.py keeps `note` and `note_icon` a pair)."""
    if data.get('note'):
        F.set_text(F.first(slide, 'chart-note-text'), data['note'])
        _fill_icon_holder(F.first(slide, 'chart-note-icon'),
                          data.get('note_icon'), prefix)
    else:
        _drop(F.first(slide, 'chart-note-row'))


# One filler per public layout. All variants of a layout share it — six of the
# twenty-eight physical layouts are cards under different geometry — so the
# mapping is spelled out once here and expanded from the registry below, rather
# than repeated for every variant.
BY_NAME = {
    'circle': circle,
    'illustration_points': illustration_points,
    'self_intro': self_intro,
    "long_text": long_text,
    'title': title,
    'agenda': agenda,
    'cards': cards,
    'text_slide': text_slide,
    'metrics': metrics,
    'final': final,
    'timeline': timeline,
    'flow': flow,
    'columns': columns,
    'image': image,
    'chart': chart,
    'chart_cards': chart_cards,
    'chart_two': chart_two,
    'chart_wide': chart_wide,
    'image_points': image_points,
    'image_wide': image_wide,
    'image_gallery': image_gallery,
    'screenshot_phone': screenshot_phone,
    'screenshot_monitor': screenshot_monitor,
    'versus': versus,
    'table': table,
    'table_compare': table_compare,
}

# Which filler handles which physical layout.
FILLERS = {}
for _record in L.PUBLIC.values():
    for _slug in _record.slugs():
        FILLERS[_slug] = BY_NAME[_record.filler]
del _record, _slug


def render(library, layout, data, icons, prefix):
    """Layout markup + data → ready slide element.

    Paths fixed BEFORE filling. Otherwise retarget_assets sees an icon whose
    path the filler already wrote in final form and prepends prefix again.
    Error is silent: output to a directory with long ../ chains, excess
    segments cancel out and path stays working; output to sibling directory
    breaks.
    """
    slide = library.load(layout)
    F.retarget_assets(slide, prefix)
    FILLERS[layout](library, slide, data, icons, prefix)
    return slide
