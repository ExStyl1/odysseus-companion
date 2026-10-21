# -*- coding: utf-8 -*-
"""Fitting the size to the text, not the text to the size.

The card's size used to be a constant in the markup: 48 for the title and 24
for the description, the same whether it's one card filling the whole slide
or eight in a grid. Designers don't work that way — they have a ladder of
steps, and the slide lands on whichever step the text still fits at.

That's what happens here. Pairs (title, description) are tried from largest
to smallest, each one measured by the REAL layout engine — the same one that
later computes line wraps for the PPTX — and the first one where nothing
overflows is kept. Picking by line length would be cheaper but wrong: two
lines of the same length take up different widths, and the engine already
knows how to measure by font metrics.

The size is one per slide, not per card: across all 25 frames of the export,
cards on the same slide share it, and a mismatch between neighboring cards
reads as a defect.
"""
import json
import logging

from . import fit as FT
from . import typography as T
from .fragments import by_class
from .html2pptx.textmeasure import DEFAULT_FAMILY, baseline_offset
from .html2pptx.values import length

log = logging.getLogger(__name__)

# The bullet list marker. Both numbers are in assets/typography.json; what
# lives here is only how they turn into pixels. The marker is placed against
# the *baseline* of the first line, computed exactly as preview.py and the PPTX
# writer compute it — half-leading plus the ascent — so it cannot drift from
# the text at any ladder step. Its predecessor was a single fitted pixel value
# (5px at 28px) multiplied by the leading, which left the marker sitting on the
# cap top rather than in the middle of the line: 11px too high at 34px.
_MARKER_FAMILY = DEFAULT_FAMILY
_MARKER_WEIGHT = 400


class Sizes(object):
    """What the size search chose for one slide.

    Carried out of the build in `BuildResult.sizes` instead of being thrown
    away. It used to be: the build measured every slide, picked a step, wrote
    it into the HTML and forgot it, so the only way to find out what shipped
    was to run the search again over the already-fitted file — which is what
    the self-test did, and which meant it asserted on a recomputation rather
    than on the deck.

    `headline` is the size of a `.title-large`/`.title-xlarge` heading, `pair`
    the (title, body) step of the card ladder. A layout can sit on both paths,
    on one, or on neither, so either may be None.
    """

    __slots__ = ('index', 'layout', 'headline', 'headline_fits', 'pair',
                 'pair_fits')

    def __init__(self, index, layout, headline, headline_fits, pair, pair_fits):
        self.index = index
        self.layout = layout
        self.headline = headline
        self.headline_fits = headline_fits
        self.pair = pair
        self.pair_fits = pair_fits

    @property
    def fits(self):
        """Whether everything this slide was measured for actually fit."""
        return self.headline_fits and self.pair_fits

    def __repr__(self):
        return 'Sizes(%d, %s, headline=%s, pair=%s%s)' % (
            self.index, self.layout, self.headline, self.pair,
            '' if self.fits else ', does not fit')


def _apply_pair(document, element, scale, pair, title_size, body_size,
                figure=None):
    """Set the sizes of the pair's classes (and the figure's) on one slide.

    Which classes carry which role is read from the ladder data, not listed
    here: v1.4 added a second pair of ladders with its own classes, and a
    hardcoded list is exactly the kind of second source of truth that this
    file exists to avoid.
    """
    for role, size in ((pair['title'], title_size), (pair['body'], body_size)):
        for name in scale.classes(role):
            for node in by_class(element, name):
                document.set_style(node, 'font-size', '%dpx' % size)
    if figure:
        size = int(round(title_size * figure['per_title']))
        for name in figure['classes']:
            for node in by_class(element, name):
                document.set_style(node, 'font-size', '%dpx' % size)
    _apply_marker(document, element, scale, pair, body_size)


def _apply_marker(document, element, scale, pair, body_size):
    """Size and place the bullet marker for the body size just chosen.

    Both the size and the offset scale with the text: a marker fixed in
    pixels is right at one step of the ladder and wrong at all the others.
    The ascent comes from the same font object the renderer draws with, so
    the marker lands on the line the reader actually sees.
    """
    marker = scale.bullet_marker
    nodes = by_class(element, 'bullet')
    if not nodes or not marker:
        return

    baseline = _marker_baseline(scale, document, pair, body_size)
    size = int(round(marker['size_em'] * body_size))
    top = int(round(baseline
                    - marker['centre_above_baseline_em'] * body_size
                    - size / 2.0))
    for node in nodes:
        document.set_style(node, 'width', '%dpx' % size)
        document.set_style(node, 'height', '%dpx' % size)
        document.set_style(node, 'margin-top', '%dpx' % top)


def _marker_baseline(scale, document, pair, body_size):
    """The first-line baseline the marker is placed against by default."""
    leading = float(scale.line_height(pair['body']).rstrip('%')) / 100.0
    font = document.fonts.get(_MARKER_FAMILY, _MARKER_WEIGHT, body_size)
    ascent, descent = font.getmetrics()
    return baseline_offset(leading * body_size, descent)


def _index_boxes(box, out):
    """Boxes by their element. Keyed by the element, never by ``id()``."""
    if getattr(box, 'el', None) is not None:
        out[box.el] = box
    for child in getattr(box, 'children', None) or ():
        _index_boxes(child, out)
    return out


def _place_markers(document, element, scale, pair, body_size):
    """Put each bullet marker on the line its own text actually got.

    `_apply_marker` runs inside the size search, before any per-line geometry
    exists, so it can only use the ladder's nominal line box and the prose
    font's metrics. That is right for prose and wrong for a bullet whose
    first line carries a tall formula: the line grows to fit the formula, the
    text baseline moves down with it, and the marker stays where a plain line
    would have put it — visibly high, which is what the v1.8 PowerPoint
    export showed on the uplift-metrics slide.

    This is the second pass, run once the size is settled: it reads the
    baseline the layout engine actually recorded for the first line and
    shifts the marker to it. Formula-free bullets are left untouched, so
    every pre-existing deck keeps the geometry it had.
    """
    marker = scale.bullet_marker
    nodes = by_class(element, 'bullet')
    if not nodes or not marker:
        return
    nominal = _marker_baseline(scale, document, pair, body_size)
    boxes = _index_boxes(document.measure(element), {})
    size = int(round(marker['size_em'] * body_size))
    for node in nodes:
        parent = node.getparent()
        if parent is None:
            continue
        texts = by_class(parent, 'bullet-text')
        box = boxes.get(texts[0]) if texts else None
        baselines = getattr(box, 'line_baselines', None) if box else None
        if not baselines:
            continue
        if abs(baselines[0] - nominal) < 0.5:
            continue
        top = int(round(baselines[0]
                        - marker['centre_above_baseline_em'] * body_size
                        - size / 2.0))
        document.set_style(node, 'margin-top', '%dpx' % top)


def _apply_size(document, element, css_class, size):
    for node in by_class(element, css_class):
        document.set_style(node, 'font-size', '%dpx' % size)


def _try_short_headline(document, element, role, short, fit_args):
    """Try the cover-only pair; length admits a candidate, geometry decides.

    Typesetting replaces spaces with NBSP one-for-one, so counting the
    rendered text preserves the input's Unicode length. Explicit breaks
    use the standard ladder even when their words are short.
    """
    heads = by_class(element, role)
    if len(heads) != 1:
        return False
    head = heads[0]
    text = ''.join(head.itertext())
    if (not text.strip() or len(text) > short['max_chars']
            or head.xpath('.//br')
            or any(char in text for char in '\r\n\u2028\u2029')):
        return False
    # Keep the subtitle's actual template size, without a second copy of
    # its CSS default in Python. Empty subtitles have no measured type.
    before = document.measure(element)
    subtitles = [(box.el, box.font_size) for box in before.walk()
                 if box.kind == 'text' and short['subtitle_class'] in box.classes()]
    _apply_size(document, element, role, short['size'])
    for node, size in subtitles:
        document.set_style(node, 'font-size', '%dpx' % short['subtitle_size'])
    if FT.headline_fits(document.measure(element), *fit_args):
        return True
    for node, size in subtitles:
        document.set_style(node, 'font-size', '%gpx' % size)
    return False


def _fit_headline(document, scale, element, layout):
    """Title size for a slide without cards. (size, fits) or (None, True)."""
    conf = scale.slide_layouts.get(layout)
    if conf is None:
        return None, True

    role = conf['role']
    clear = set(conf['clear'])
    margin = scale.slide_fit['edge_margin']
    clearance = conf.get('clearance', scale.slide_fit['clearance'])

    scope = conf.get('scope')
    fit_args = (clear, margin, clearance, scope, conf.get('max_lines'),
                conf.get('max_lines_scope'))
    short = conf.get('short_title')
    if short and _try_short_headline(document, element, role, short, fit_args):
        return short['size'], True
    sizes = scale.slide_sizes(role)
    picked = sizes[-1]
    first_fit = None
    for size in sizes:
        _apply_size(document, element, role, size)
        root = document.measure(element)
        if FT.headline_fits(root, *fit_args):
            # Screenshots can trade one legal headline step for a connected
            # phrase. Keep a geometric fit if no step rescues the orphan;
            # validation still reports the typography warning afterwards.
            if role == 'title-screenshot' and any(
                    FT.headline_orphans(box) for box in root.walk()
                    if role in box.classes()):
                if first_fit is None:
                    first_fit = size
                continue
            return size, True
    if first_fit is not None:
        _apply_size(document, element, role, first_fit)
        return first_fit, True
    _apply_size(document, element, role, picked)
    return picked, False


def _place_text_arrow(document, element, conf):
    """Follow the measured last heading line, with room above the prose.

    A wide last line moves the arrow below the heading,
    at its right edge, so neither line nor image needs to overlap the other.
    """
    root = document.measure(element)
    heading = next(b for b in root.walk()
                   if b.kind == 'text' and 'title-large' in b.classes())
    arrow = next(b for b in root.walk() if 'text-arrow' in b.classes())
    last_width = heading.line_widths[-1] if heading.line_widths else 0
    left = heading.x + last_width + conf['gap_x']
    top = heading.y + heading.h - conf['overlap_y']
    if left + arrow.w > heading.x + heading.w:
        left = heading.x + heading.w - arrow.w
        top = heading.y + heading.h + conf['gap_y']
    document.set_style(arrow.el, 'left', '%gpx' % left)
    document.set_style(arrow.el, 'top', '%gpx' % top)


def _size_text_region(document, element, conf):
    """Use available space before shrinking the bottom-anchored prose.

    The upper edge clears the measured heading. An arrow inside the body's
    horizontal span reserves extra height; one in the right-hand gutter
    does not. The resulting explicit pixel bounds are shared by the fit
    search and validation, while the lower edge remains where CSS put it.
    """
    root = document.measure(element)
    heading = next(b for b in root.walk()
                   if b.kind == 'text' and 'title-large' in b.classes())
    arrow = next(b for b in root.walk() if 'text-arrow' in b.classes())
    region = next(b for b in root.walk() if 'text-body-region' in b.classes())
    bottom = region.y + region.h
    top = heading.y + heading.h + conf['heading_gap']
    if (arrow.x < region.x + region.w + conf['side_gap']
            and arrow.x + arrow.w > region.x - conf['side_gap']):
        top = max(top, arrow.y + arrow.h + conf['arrow_gap'])
    top = min(top, bottom)
    document.set_style(region.el, 'top', '%gpx' % (top - root.y))
    document.set_style(region.el, 'height', '%gpx' % (bottom - top))


_LEGENDS = ('legend-row', 'legend-column')


def _legend_overflows(box, parent):
    """Whether a legend runs out of the box it sits in. It never gives way
    (base.css), so a row of long names pushes past the plate's edge. Its
    items are measured too: under the title (a stacked head) the row's own
    box is held to the head's width while the items run on."""
    left = min([box.x] + [c.x for c in box.children])
    right = max([box.x + box.w] + [c.x + c.w for c in box.children])
    return left < parent.x - 0.5 or right > parent.x + parent.w + 0.5


def _legend_text_dense(box):
    """A tall column of long names should not dominate the chart plate.

    Measure ink against the actual label column, not string length: five
    short names stay large, while several nearly full-width names use the
    same dense step as crowded chart labels. The 3-row budget comes from the
    P08 gate's long five-entry legend (four full rows of measured text).
    """
    if 'legend-column' not in box.classes() or 'compact' in box.classes():
        return False
    labels = [child for item in box.children
              for child in item.walk() if 'legend-label' in child.classes()]
    if len(labels) < 5:
        return False
    available = box.x + box.w - min(label.x for label in labels)
    return available > 0 and sum(label.w for label in labels) > 3 * available


def _head_crowded(head):
    """Whether a chart head's legend row leaves its title no room: the title
    wraps or runs past its box beside the row, or the row runs out of the
    head. Then the row goes under the title (`.chart-head.stacked`)."""
    titles = [b for b in head.children if 'chart-title' in b.classes()]
    rows = [b for b in head.children if 'legend-row' in b.classes()]
    if not titles or not rows:
        return False
    title = titles[0]
    return (len(title.lines) > 1
            or FT.widest_line(title) > title.w + FT.EPSILON
            or _legend_overflows(rows[0], head))


def _chart_owner(element, marker):
    """The plate a chart marker sits on, or the slide: what holds its
    legend."""
    node = marker.getparent()
    while node is not None and node is not element:
        if 'chart-plate' in (node.get('class') or '').split():
            return node
        node = node.getparent()
    return element


def _fit_charts(document, element):
    """Step all charts and legends on a crowded slide down together.

    Every text of a chart is one size (2.3.0, `chart_text`). The chart's
    layout steps its own texts down when its value labels do not fit; the
    legend is HTML around it and steps here, when a chart came out dense
    or a legend needs the smaller step. One dense chart takes the others on
    the slide with it, so a chart-two pair reads at one size. One more pass
    settles it: a dense legend leaves the chart more room, never less.

    Before any of that, a legend row that crowds its chart title goes under
    the title, at full size: only a row too long for the plate even there
    steps down.
    """
    for _ in range(3):
        root = document.measure(element)
        parents = {}
        for box in root.walk():
            for child in box.children:
                parents[child] = box
        changed = False
        for head in root.walk():
            if head.el is None or 'chart-head' not in head.classes() \
                    or 'stacked' in head.classes() or not _head_crowded(head):
                continue
            document.set_attribute(head.el, 'class',
                                   head.el.get('class') + ' stacked')
            changed = True
        if changed:
            continue
        chart_rows = []
        for box in root.walk():
            chart = box.chart if box.kind == 'chart' else None
            if chart is None or chart.geometry is None:
                continue
            owner = _chart_owner(element, box.el)
            legends = [b for b in root.walk()
                       if b.el is not None and b.classes() & set(_LEGENDS)
                       and _chart_owner(element, b.el) is owner]
            dense = chart.geometry.dense or any(
                _legend_overflows(b, parents[b]) or _legend_text_dense(b)
                for b in legends
                if b in parents)
            chart_rows.append((box, legends, dense))
        slide_dense = any(dense and box.chart.chart_type != 'doughnut'
                          for box, _, dense in chart_rows)
        for box, legends, dense in chart_rows:
            if box.chart.chart_type == 'doughnut':
                continue  # P10: fixed ring text and 22 pt legend, even on mixed slides.
            if not (dense or slide_dense):
                continue
            for legend in legends:
                classes = (legend.el.get('class') or '').split()
                if 'compact' not in classes:
                    document.set_attribute(legend.el, 'class',
                                           ' '.join(classes + ['compact']))
                    changed = True
            payload = json.loads(box.el.get('data-chart'))
            if not payload.get('dense'):
                payload['dense'] = True
                document.set_attribute(box.el, 'data-chart',
                                       json.dumps(payload))
                changed = True
        if not changed:
            return


def _center_illustration_points(document, element):
    """Center the visible two-point group using the approved compact/long rows."""
    holders = by_class(element, 'illustration-list')
    if not holders or 'count-2' not in holders[0].get('class', '').split():
        return
    holder = holders[0]
    classes = [name for name in holder.get('class', '').split() if name != 'compact']
    document.set_attribute(holder, 'class', ' '.join(classes + ['compact']))
    root = document.measure(element)
    region = next(box for box in root.walk() if box.el is holder)
    clearance = length(region.style.get('row-gap'), default=0)
    rows = [box for box in root.walk() if 'illustration-point' in box.classes()]
    for row in rows:
        boundary = next(box for box in row.walk() if 'fit-box' in box.classes())
        text = [box for box in boundary.walk()
                if {'card-subtitle', 'card-description'} & box.classes()]
        if max(box.y + box.h for box in text) > boundary.y + boundary.h - clearance:
            document.set_attribute(holder, 'class', ' '.join(classes))
            break
    root = document.measure(element)
    region = next(box for box in root.walk() if box.el is holder)
    card = next(box for box in root.walk() if 'illustration-right-card' in box.classes())
    visible = [box for box in region.walk() if
               {'card-subtitle', 'card-description', 'illustration-point-icon'} & box.classes()]
    top = min(box.y for box in visible)
    bottom = max(box.y + box.h for box in visible)
    reserved = max(box.y + box.h for box in region.walk() if 'fit-box' in box.classes()) - region.y
    target = region.y + card.y + card.h / 2 - (top + bottom) / 2
    target = max(card.y, min(target, card.y + card.h - reserved))
    document.set_style(holder, 'top', '%gpx' % (target - root.y))
    document.set_style(holder, 'height', '%gpx' % reserved)


def _fit_table(document, element, scale):
    """Keep a white table inside its fixed card, preserving one body size."""
    conf = scale.table_fit
    sizes = [size for size in scale.sizes(conf['body_role'])
             if size <= conf['body_ceiling']]
    rows = by_class(element, 'table-row')
    for size in sizes:
        for padding in conf['row_paddings']:
            for row in rows:
                head = 'table-head' in row.get('class', '').split()
                for text in by_class(row, 'table-text'):
                    document.set_style(text, 'font-size', '%dpx' % (
                        conf['header_size'] if head else size))
                if not head:
                    for cell in by_class(row, 'table-cell'):
                        for side in ('top', 'bottom'):
                            document.set_style(cell, 'padding-' + side,
                                               '%dpx' % padding)
            if FT.table_fits(document.measure(element)):
                return (conf['header_size'], size), True
    return (conf['header_size'], sizes[-1]), False


def fit(document, skill_dir, layouts):
    """Pick the type size for every slide of an open document.

    The sizes are written into the document's inline styles; writing the file
    back is the caller's job (`Document.save`), and the build does it right
    away — the HTML on disk has to carry the same sizes as the PPTX.

    `layouts` is the physical layout slug per slide, in document order.
    Returns one `Sizes` per slide.
    """
    scale = T.load(skill_dir)

    chosen = []
    for index, (element, layout) in enumerate(zip(document.elements, layouts), 1):
        for holder in by_class(element, 'illustration-list'):
            classes = holder.get('class', '').split()
            if 'compact' in classes:
                document.set_attribute(holder, 'class', ' '.join(
                    name for name in classes if name != 'compact'))
        # The headline first, because it is measured against obstacles that
        # the column search does not move. A layout may sit on both paths -
        # the timeline does - so this is no longer an either/or.
        head, head_ok = _fit_headline(document, scale, element, layout)
        arrow = scale.slide_layouts.get(layout, {}).get('arrow')
        if arrow:
            _place_text_arrow(document, element, arrow)
        body_region = scale.slide_layouts.get(layout, {}).get('body_region')
        if body_region:
            _size_text_region(document, element, body_region)
        _fit_charts(document, element)
        if head is not None:
            log.info('slide %d (%s): headline %d px%s', index, layout, head,
                     '' if head_ok else ' - still does not fit')

        if layout == 'table':
            picked, ok = _fit_table(document, element, scale)
            chosen.append(Sizes(index, layout, head, head_ok, picked, ok))
            continue

        tier = scale.tier_of(layout)
        if tier is None:
            chosen.append(Sizes(index, layout, head, head_ok, None, True))
            continue

        pair = scale.pair_of(layout)
        figure = scale.figure_of(layout)
        headline = scale.slide_layouts.get(layout, {}).get('role')
        pairs = scale.candidates(layout)
        picked, ok = pairs[-1], False
        for title_size, body_size in pairs:
            _apply_pair(document, element, scale, pair, title_size, body_size,
                        figure)
            if FT.cards_fit(document.measure(element), tier, headline):
                picked, ok = (title_size, body_size), True
                break
        if not ok:
            # No step fit. We keep the smallest one: at that size the text
            # overflow is minimal, and the validator can report exactly how
            # much longer the text is than allowed.
            _apply_pair(document, element, scale, pair, picked[0], picked[1],
                        figure)
            log.info('slide %d (%s): text does not fit even at %d/%d px',
                     index, layout, picked[0], picked[1])
        else:
            log.info('slide %d (%s): %d/%d px', index, layout, picked[0], picked[1])
        # Only now, with the size settled, does the per-line geometry exist.
        _place_markers(document, element, scale, pair, picked[1])
        if ok:
            _center_illustration_points(document, element)
        chosen.append(Sizes(index, layout, head, head_ok, picked, ok))

    # Every size was set through `Document.set_style`, which drops the kept box
    # trees, so the validator reads the slides at the sizes that were kept.
    return chosen
