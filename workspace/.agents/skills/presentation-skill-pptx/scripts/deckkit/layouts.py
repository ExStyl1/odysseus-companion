# -*- coding: utf-8 -*-
"""What a layout is, in one place.

Until 1.5 a layout was eight facts in eight files: the fields a spec may carry
and the branch that dispatched them (`spec.py`), the count rule and the choice
of physical variant (`deck.py`), the fragment file (`fragments.py`), the filler
(`slides.py`), the type tier (`assets/typography.json`), the order and the
description (`assets/layouts/layouts.json`) and the prose the calling agent
reads (`references/layouts.md`). Adding the three v1.4 families touched all of
them in lockstep, and the pair of counts in `AGENTS.md` still said "10 public,
17 physical" when the code held 13 and 28 — nothing could catch that, because no
single place knew the answer.

This module owns the first six. The type ladder, the registry descriptions and
the prose stay where they are: they are read by other things — the size search,
the template splitter and the calling agent — and each has its own gate.

Two tables:

* `physical(skill_dir)` — one record per fragment, **derived** from
  `layouts.json`. The file is `NN-slug.html`, where NN is the position in that
  registry, which is already the order `sync_layouts.py` cuts `template.html`
  into. Derived rather than restated, so the builder cannot know a layout the
  template does not have.
* `PUBLIC` — one record per name a spec may use: the fields, the countable
  element, the count → variant table, the filler, and which element kind each
  list field holds (`elements.py`) — from which the icons, the formula paths
  and the normalised shape all follow.

The sentence a user reads when the count is wrong is generated from the variant
table (`_count_phrase`), so the message and the rule cannot drift apart.
"""
import collections
import json
import os

from . import elements as E
from .html2pptx import chartgeom as G
from .elements import ITEMS_MAX                                # noqa: F401

_REGISTRY_CACHE = {}


# --------------------------------------------------------------- physical

class Physical(object):
    """A layout as it exists on disk: one fragment cut from the template."""

    __slots__ = ('slug', 'index', 'file', 'name', 'structure', 'when')

    def __init__(self, slug, index, name, structure, when):
        self.slug = slug
        self.index = index
        self.file = '%02d-%s.html' % (index, slug)
        self.name = name
        self.structure = structure
        self.when = when

    def __repr__(self):
        return 'Physical(%s)' % self.slug


def registry_path(skill_dir):
    return os.path.join(skill_dir, 'assets', 'layouts', 'layouts.json')


def physical(skill_dir):
    """Ordered slug → Physical for one skill directory.

    Cached by absolute path: a scratch copy of the skill (which is how the blast
    radius of an engine change gets measured) keeps its own table rather than
    inheriting the installed one.
    """
    key = os.path.abspath(skill_dir)
    table = _REGISTRY_CACHE.get(key)
    if table is None:
        with open(registry_path(skill_dir), 'r', encoding='utf-8') as handle:
            entries = json.load(handle)['layouts']
        table = collections.OrderedDict()
        for index, entry in enumerate(entries, 1):
            slug = entry['slug']
            table[slug] = Physical(slug, index, entry.get('name', slug),
                                   entry.get('structure', ''),
                                   entry.get('when', ''))
        _REGISTRY_CACHE[key] = table
    return table


def fragment_file(skill_dir, slug):
    table = physical(skill_dir)
    if slug not in table:
        raise KeyError('unknown layout: %s' % slug)
    return table[slug].file


# ----------------------------------------------------------------- public

def _count_phrase(counts):
    """Render a set of legal counts as English: 1 to 4, 4 or 5, exactly 5,
    4, 6 or 8. Generated so the sentence cannot disagree with the table."""
    counts = sorted(counts)
    if len(counts) == 1:
        return 'exactly %d' % counts[0]
    contiguous = counts == list(range(counts[0], counts[-1] + 1))
    if contiguous and len(counts) == 2:
        return '%d or %d' % (counts[0], counts[1])
    if contiguous:
        return '%d to %d' % (counts[0], counts[-1])
    return '%s or %d' % (', '.join(str(c) for c in counts[:-1]), counts[-1])


class Layout(object):
    """One name a spec may use, and everything the build needs to honour it.

    `variants` maps the number of elements to the physical layout that holds
    them; `summary_variants` is the second table `flow` needs, because there the
    variant depends on whether the optional summary block is present as well as
    on the count. `also` lists physical layouts that share this filler but are
    not selectable — `bullets`, kept because removing a frame from the
    template is a design decision rather than skill work.

    `kinds` maps a list field to the `elements.Kind` it holds. `slide_icons`
    names slide-level fields whose value is an icon query (`note_icon`).
    `chart` says where a chart's fields sit: `'slide'` on the slide itself,
    or the name of the field that lists chart objects. Icons, formula paths
    and the normalised shape all follow from these three. `chart_types`, when
    set, is the chart types the layout draws, and `refusal` why the others
    are not (chart-wide: a doughnut's ring is as tall as it is wide).
    """

    __slots__ = ('name', 'required', 'optional', 'element', 'variants',
                 'summary_variants', 'also', 'filler', 'kinds', 'slide_icons',
                 'chart', 'chart_types', 'refusal', 'subject', 'noun',
                 'fewer', 'status', 'looks', 'numbered', 'table')

    def __init__(self, name, required, optional=(), element=None,
                 variants=None, summary_variants=None, also=(),
                 filler=None, kinds=None, slide_icons=(), chart=None,
                 chart_types=None, refusal=None,
                 subject=None, noun=None, fewer='cards',
                 status='production', looks=None, numbered=(), table=None):
        self.name = name
        self.required = tuple(required)
        self.optional = tuple(optional)
        self.element = element
        self.variants = dict(variants or {0: name})
        self.summary_variants = dict(summary_variants or {})
        self.also = tuple(also)
        self.filler = filler or name
        self.kinds = collections.OrderedDict(kinds or ())
        self.slide_icons = tuple(slide_icons)
        self.chart = chart
        self.chart_types = tuple(chart_types) if chart_types else None
        self.refusal = refusal
        self.subject = subject or 'a %s slide' % name
        self.noun = noun or element or ''
        # What the OVERFLOW advice offers instead when the text does not fit
        # at the smallest step: "take a layout with fewer <fewer>". None where
        # the type is fixed and there is no smaller layout to take (metrics).
        # Until 2.1 `validate` read it off the slug's prefix.
        self.fewer = fewer
        # 'production' (default) or 'draft': a draft is built, wired end to
        # end and covered by selftest.py, but the spec schema keeps it out of a
        # content-authoring agent's reach - see DRAFT below and AGENTS.md's
        # "Images and charts (v1.6)" section for the one existing example.
        self.status = status
        # `look` -> fragment, count -> fragment, or None (the base tables).
        # The first look is the default. A look is the author's choice;
        # the count chooses a fragment only within that look.
        self.looks = collections.OrderedDict(looks or ())
        # The card counts that may carry "numbered": true (2.4.0): the same
        # fragments, every card grey with its number in a notched corner
        # instead of an icon. Empty where the slide cannot be numbered.
        self.numbered = tuple(numbered)
        # Where a native table's fields sit (2.4.0): 'slide' - header and
        # rows on the slide itself - or 'tables', the field listing the two
        # small ones of table-compare. None on every other layout.
        self.table = table

    # -- counts

    def counts(self):
        """Every element count this layout accepts."""
        return sorted(set(self.variants) | set(self.summary_variants))

    def count_of(self, data):
        if not self.element:
            return 0
        return len(data.get(self.element) or ())

    def check_count(self, data):
        """Raise ValueError with a sentence generated from the variant table."""
        if not self.element:
            return
        found = self.count_of(data)
        if found in self.variants or found in self.summary_variants:
            return
        raise ValueError('%s takes %s %s, got %d'
                         % (self.subject, _count_phrase(self.counts()),
                            self.noun, found))

    def variant(self, data):
        """The physical layout that holds this slide's content."""
        found = self.count_of(data)
        if self.looks:
            look = data.get('look')
            if look is None:
                look = next(iter(self.looks))
            if not isinstance(look, str) or look not in self.looks:
                raise ValueError('"look" is one of %s, not %r'
                                 % (', '.join('"%s"' % name
                                              for name in self.looks), look))
            table = self.looks[look]
            if isinstance(table, str):
                return table
            # A look with its own fragment per count (2.4.0: the yellow
            # timeline, the zigzag flow); `None` keeps the count tables.
            if table is not None:
                if found not in table:
                    raise ValueError(
                        '%s with "look": "%s" takes %s %s, got %d'
                        % (self.subject, look,
                           _count_phrase(sorted(table)), self.noun,
                           found))
                if self.summary_variants and data.get('summary'):
                    raise ValueError(
                        '%s with "look": "%s" takes no summary - omit '
                        '"summary" or use "look": "%s"'
                        % (self.subject, look, next(iter(self.looks))))
                return table[found]
        if self.summary_variants and data.get('summary'):
            table = self.summary_variants
        else:
            table = self.variants
        if found not in table:
            self.check_count(data)
            # The count is legal but only in the other table: a flow with a
            # summary and a count the summary variants do not cover.
            raise ValueError('%s takes %s %s with a summary, got %d'
                             % (self.subject,
                                _count_phrase(sorted(self.summary_variants)),
                                self.noun, found))
        return table[found]

    # -- elements

    def check_chart_type(self, chart_type):
        """The sentence refusing a chart type this layout does not draw, or
        None. The spec reports it with the other problems; `normalise`
        raises it for a slide built through the `Deck` API."""
        if self.chart_types is None or chart_type is None \
                or chart_type not in G.CHART_TYPES \
                or chart_type in self.chart_types:
            return None
        return '"%s" draws %s, not "%s" - %s' % (
            self.name, ', '.join('"%s"' % t for t in self.chart_types),
            chart_type, self.refusal)

    def kinds_of(self, data):
        """The kinds for this slide: a numbered one holds numbered cards."""
        if self.numbered and isinstance(data, dict) and data.get('numbered'):
            return collections.OrderedDict(
                (field, E.NUMBERED_CARD if kind is E.CARD else kind)
                for field, kind in self.kinds.items())
        return self.kinds

    def has_icons(self):
        return bool(self.slide_icons) or any(
            kind.icon_fields for kind in self.kinds.values())

    def normalise(self, data, allocator, skill_dir):
        """Turn the slide's data into what the filler reads, in place.

        Icons are resolved and charts loaded now, not at render time, so a
        missing icon or a malformed CSV surfaces with its slide number before
        anything is written. `begin_slide` scopes icon uniqueness to the
        slide: repeats across slides stay possible and are only warned about.
        """
        if self.has_icons():
            allocator.begin_slide()
        for field, kind in self.kinds_of(data).items():
            if data.get(field) is not None:
                data[field] = kind.normalise(data[field], allocator)
        for field in self.slide_icons:
            data[field] = (allocator.allocate(data[field])
                           if data.get(field) else None)
        if self.chart == 'slide':
            refused = self.check_chart_type(data.get('chart_type'))
            if refused:
                raise ValueError(refused)
            E.CHART.resolve(data, skill_dir)
        elif self.chart:
            # A caller may reuse one chart dict; each occurrence resolves its
            # own data/colors fields even when the owned input retains aliases.
            data[self.chart] = [dict(chart) for chart in data[self.chart]]
            for number, chart in enumerate(data[self.chart], 1):
                if not chart.get('chart_title'):
                    raise ValueError(E.CHART.UNTITLED % number)
                E.CHART.resolve(chart, skill_dir)
        if self.table:
            E.TABLE.normalise(data, self.table)
        return data

    def icons_of(self, data):
        """Every icon file on a normalised slide, elements and slide alike."""
        icons = []
        for field, kind in self.kinds.items():
            icons.extend(kind.icons_of(data.get(field)))
        for field in self.slide_icons:
            if data.get(field):
                icons.append(data[field])
        return icons

    def formula_paths(self):
        """Spec paths where this layout accepts inline formulas."""
        paths = set()
        for field, kind in self.kinds.items():
            paths.update(kind.formula_paths(field))
        return paths

    def slugs(self):
        """Every physical layout this record is responsible for."""
        looks = set()
        for table in self.looks.values():
            if isinstance(table, dict):
                looks.update(table.values())
            elif table is not None:
                looks.add(table)
        return sorted(set(self.variants.values())
                      | set(self.summary_variants.values())
                      | looks
                      | set(self.also))

    def __repr__(self):
        return 'Layout(%s)' % self.name


_RECORDS = (
    Layout('title', ('text',), ('subtitle', 'author')),
    Layout('agenda', ('title', 'items'), element='items',
           variants={n: 'agenda' for n in range(2, 7)},
           subject='an agenda'),
    Layout('self-intro', ('name', 'role', 'src', 'items'), element='items',
           variants={n: 'self-intro' for n in (2, 3, 4)},
           filler='self_intro', subject='a self-introduction', fewer='items'),
    # A list as the whole slide is one card with `items` (v2.0). The yellow
    # `bullets` frame was the same slide in another colour under its own field
    # names, so the spec lost it; the fragment stays, since every card's list
    # markup is borrowed from it.
    Layout('cards', ('title', 'cards'), ('numbered',), element='cards',
           filler='cards', kinds={'cards': E.CARD},
           variants={1: 'cards-1', 2: 'cards-2', 3: 'cards-3', 4: 'cards-4'},
           also=('bullets',), subject='a row', numbered=(2, 3, 4)),
    Layout('grid', ('title', 'cards'), ('numbered',), element='cards',
           filler='cards', kinds={'cards': E.CARD},
           variants={4: 'grid-2x2', 6: 'grid-2x3', 8: 'grid-2x4'},
           subject='a grid', numbered=(4, 6, 8)),
    Layout('complex', ('title', 'cards'), element='cards', filler='cards',
           kinds={'cards': E.CARD}, variants={5: 'complex'},
           subject='the complex layout'),
    Layout('pyramid', ('title', 'cards'), element='cards', filler='cards',
           kinds={'cards': E.CARD}, variants={5: 'pyramid'},
           subject='the pyramid layout'),
    Layout('circle', ('title', 'points', 'cards'), element='points',
           variants={n: 'circle-%d' % n for n in (3, 4, 5, 6)},
           kinds={'points': E.CHART_POINT, 'cards': E.CIRCLE_CARD},
           filler='circle', fewer='points'),
    Layout('illustration-points', ('title', 'points'), element='points',
           variants={n: 'illustration-points' for n in (2, 3, 4)},
           kinds={'points': E.ILLUSTRATION_POINT}, filler='illustration_points',
           subject='an illustrated list', fewer='points'),
    # Two looks of one statement (2.4.0), the designers': the glass panel
    # (default) and the slanted glass cards. Which one is the author's call -
    # `look` - since the content is the same. The yellow-pattern statement and
    # its fixed-120px twin were retired in 2.4.0 (the author preferred the
    # new two); `look: "pattern"` is refused with the replacement.
    Layout('statement', ('text',), ('look',), filler='text_slide',
           variants={0: 'statement-glass'},
           looks=[('glass', 'statement-glass'),
                  ('cards', 'statement-cards')]),
    # Gate A prototype: dense prose in a yellow panel, kept out of ordinary
    # specs until the designer comparison has been accepted.
    Layout('text-slide', ('title', 'text'), filler='long_text',
           status='draft', fewer=None),
    # 2.4.0, the designers' contrast slide: two cards over the whole slide
    # and a VS badge in a notch between them. The yellow side is the left
    # one, there is no slide title and no icon. Fixed type; how much text a
    # side holds, and how far the two may differ, are validate.py's
    # VERSUS_* checks.
    Layout('versus', ('sides',), element='sides', filler='versus',
           kinds={'sides': E.VERSUS_SIDE}, variants={2: 'versus'},
           subject='a versus slide', noun='sides', fewer=None),
    Layout('metrics', ('title', 'metrics'), ('subtitle',), element='metrics',
           kinds={'metrics': E.METRIC},
           variants={2: 'metrics-3col', 3: 'metrics-3col',
                     4: 'metrics-6cards', 5: 'metrics-6cards',
                     6: 'metrics-6cards'},
           noun='entries', fewer=None),
    Layout('final', (), ('text',)),
    # 2.4.0, the designers' series: a look of its own per count, `None` the
    # default keeping the count tables. Yellow takes 4 or 5 points only -
    # three are drawn on their own picture of discs; zigzag takes no summary.
    Layout('timeline', ('title', 'points'), ('look',), element='points',
           kinds={'points': E.POINT},
           variants={3: 'timeline-3', 4: 'timeline-4', 5: 'timeline-5'},
           looks=[('grey', None),
                  ('yellow', {4: 'timeline-4-yellow', 5: 'timeline-5-yellow'})],
           subject='a timeline', fewer='columns'),
    Layout('flow', ('title', 'steps'), ('summary', 'look', 'highlight_last'),
           element='steps',
           kinds=[('steps', E.STEP), ('summary', E.SUMMARY)],
           variants={4: 'flow-4', 5: 'flow-5'},
           summary_variants={4: 'flow-4-summary', 5: 'flow-5-summary'},
           looks=[('line', None),
                  ('zigzag', {4: 'flow-4-zigzag', 5: 'flow-5-zigzag'})],
           subject='a flow', fewer='columns'),
    Layout('columns', ('title', 'columns'), element='columns',
           kinds={'columns': E.COLUMN},
           variants={3: 'columns-3', 4: 'columns-4',
                     5: 'columns-5', 6: 'columns-6'},
           fewer='columns'),
    # No designer-approved template exists yet for the image slide -
    # implemented and tested end to end (see AGENTS.md "Images and charts
    # (v1.6)"), but `status='draft'` keeps it out of a content-authoring
    # spec's reach until a real template lands. The chart slide left draft in
    # v2.0, when the designers' chart system arrived.
    Layout('image', ('title', 'src'), ('note_icon', 'note', 'caption'),
           slide_icons=('note_icon',), status='draft'),
    # Accepted image frames: one picture with takeaways, or a captioned gallery.
    # Legacy image and the parked full-width prototype retain their draft APIs.
    Layout('image-points', ('title', 'src', 'points'), ('look', 'fit'),
           element='points', kinds={'points': E.CHART_POINT},
           variants={n: 'image-points-plates' for n in range(1, 6)},
           looks=[(look, 'image-points-' + look)
                  for look in ('plates', 'plate')],
           filler='image_points', subject='an image slide', fewer='points'),
    Layout('image-wide', ('title', 'src'), ('note_icon', 'note', 'look'),
           slide_icons=('note_icon',), filler='image_wide', status='draft',
           variants={0: 'image-wide-plate'},
           looks=[('plate', 'image-wide-plate'), ('plates', 'image-wide-plates')]),
    Layout('image-gallery', ('title', 'images'), element='images',
           kinds={'images': E.IMAGE_ITEM}, filler='image_gallery',
           variants={2: 'image-gallery-2', 3: 'image-gallery-3'},
           subject='an image gallery', noun='images', fewer='images'),
    # Separate payloads for app screens and desktop points.
    Layout('screenshot-phone', ('title', 'text', 'images'), ('fit',),
           element='images', kinds={'images': E.SCREENSHOT_ITEM},
           filler='screenshot_phone',
           variants={n: 'screenshot-phone-%d' % n for n in (1, 2, 3)},
           subject='a phone screenshot slide', noun='images', fewer='images'),
    Layout('screenshot-monitor', ('title', 'src', 'points'), ('fit',),
           element='points', kinds={'points': E.CHART_POINT},
           filler='screenshot_monitor',
           variants={n: 'screenshot-monitor' for n in (1, 2, 3, 4)},
           subject='a monitor screenshot slide', fewer='points'),
    # v2.0 charts. `data` is a CSV path (then `x` and `y` name its columns)
    # or the data itself, inline; schema.py enforces which fields go with which.
    # One chart and 1-5 points: the single-chart layout always carries a
    # points list (selectable icons, bottom-left) — there is no note-only
    # variant (author decision 2026-09-25). Points are required, ≥ 1.
    Layout('chart', ('title', 'data', 'chart_type', 'points'),
           ('chart_title', 'x', 'y', 'mode', 'center', 'value_labels',
            'fill', 'number_format', 'look'),
           element='points', kinds={'points': E.CHART_POINT}, chart='slide',
           variants={1: 'chart-points', 2: 'chart-points',
                     3: 'chart-points', 4: 'chart-points',
                     5: 'chart-points'},
           # 2.4.0, the designers' charts_new: the chart on a stack of
           # plates, a smaller plate than the default single one.
           looks=[('plate', 'chart-points'),
                  ('plates', 'chart-points-plates')],
           subject='a chart slide'),
    Layout('chart-cards', ('title', 'data', 'chart_type', 'cards'),
           ('x', 'y', 'mode', 'center', 'value_labels', 'fill',
            'number_format'),
           element='cards', filler='chart_cards', variants={3: 'chart-cards'},
           kinds={'cards': E.CHART_CARD}, chart='slide',
           subject='a chart with cards'),
    # `charts` is two chart objects, each with the fields of a single chart.
    Layout('chart-two', ('title', 'charts'), ('note_icon', 'note'),
           element='charts', filler='chart_two', slide_icons=('note_icon',),
           chart='charts',
           variants={2: 'chart-two'}, subject='the two-chart layout'),
    # 2.3.0, the designers' review and long slide: one chart across the
    # slide for a long series, under a large title and the note of chart-two.
    # validate.py points a chart of many categories here and a short one
    # back to `chart`.
    # The approved designers' tables use editable native a:tbl objects.
    # `table` is one white card on the grey: a header row and up to eight
    # rows of 2-6 cells. `table-compare` is two cards side by side, yellow
    # and grey, each a title over 2-6 label/value rows. Type is fixed (the
    # designers' 30/24 pt); how much a cell holds is validate.py's TABLE_*.
    Layout('table', ('title', 'header', 'rows'),
           ('label_column', 'total_column'), filler='table', table='slide',
           subject='a table', fewer=None),
    Layout('table-compare', ('title', 'tables'), filler='table_compare',
           table='tables', subject='a table comparison',
           fewer=None),
    Layout('chart-wide', ('title', 'data', 'chart_type'),
           ('note_icon', 'note', 'chart_title', 'x', 'y', 'mode',
            'value_labels', 'fill', 'number_format'),
           filler='chart_wide', chart='slide', slide_icons=('note_icon',),
           chart_types=('bar', 'grouped', 'stacked', 'bar_h', 'line'),
           refusal='a ring is as tall as it is wide and would leave the '
                   'plate empty on both sides; take "chart"',
           subject='the wide chart layout'),
)

PUBLIC = collections.OrderedDict((record.name, record) for record in _RECORDS)

# Derived, not restated: a layout becomes a draft by passing `status='draft'`
# to its `Layout(...)` record above, nothing else. `PUBLIC` deliberately still
# includes drafts - `Deck.image()`/`Deck.chart()`, `slides.py`'s
# fragment-coverage walk and `selftest.py`'s ladder-coverage check all key off
# it and must keep seeing the full set. `schema.py` rejects draft names on
# the JSON authoring path unless internal callers explicitly allow them. Re-enabling a
# layout later is deleting its `status='draft'` kwarg above - nothing else
# treats it as an authoring gate; internal image APIs allow drafts explicitly.
DRAFT = frozenset(record.name for record in _RECORDS if record.status == 'draft')


# Classes of the template whose box is one design object the engine draws as
# several shapes - handed to `write_pptx`, which groups them back into one
# (html2pptx/grouping.py). The nearest ancestor carrying one, or the box
# itself, defines the group. Lived in the engine until 2.1.
GROUP_ROOTS = frozenset([
    'card-number-circle',  # numbered card's disc + editable digit, not the card
    'circle-badge',     # orbit disc + its glyph, without the label
    'gallery-badge',    # circle + replaceable icon (image gallery)
    'glass-panel',      # outer shadow + panel + inner shadow  (title)
    'flow-icon',        # badge circle + the glyph inside it    (flow)
    'timeline-circle',  # circle + its number                   (timeline)
    'columns-dot',      # disc + the hole that makes it a ring  (columns)
    'bullet-item',      # marker + the line it belongs to       (bullets, cards)
    'agenda-item',      # the number + the line it belongs to   (agenda)
    'legend-item',      # the swatch + the label it belongs to  (charts)
    'chart-point',      # the icon + the text of one point      (chart)
    'chart-note-row',   # the icon + the note beside the title  (chart-two/-wide)
])


def public_of(slug):
    """The public record that owns a physical layout, or None."""
    for record in _RECORDS:
        if slug in record.slugs():
            return record
    return None


def known_slugs():
    """Every physical layout the builder can fill."""
    found = set()
    for record in _RECORDS:
        found.update(record.slugs())
    return found
