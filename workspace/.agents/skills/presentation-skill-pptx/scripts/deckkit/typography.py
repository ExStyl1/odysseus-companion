# -*- coding: utf-8 -*-
"""Size scale: data from assets/typography.json and enumeration of legal pairs.

The numbers don't live here — this file only reads the JSON and exposes it in
a convenient shape. The only logic that lives here is which pairs (title
size, description size) are legal for a layout at all: both ladders are
capped by the tier's ceiling, and the gap between them is bounded by the
window from the export. Picking the actual pair happens in autofit.py — it
needs a layout, not a table.
"""
import json
import os

from . import layouts as L

_FILENAME = os.path.join('assets', 'typography.json')

# Parsing JSON isn't free, and the deck reads the scale on every slide.
_CACHE = {}


def default_path(skill_dir):
    return os.path.join(skill_dir, _FILENAME)


class TypographyError(Exception):
    """`typography.json` does not account for the skill's layouts.

    A configuration mistake, not a deck mistake, so it is not an `Issue`: the
    file is wrong for every deck, and the message names what to fix in it.
    """


def load(skill_dir):
    """The skill's scale. Parsed once per process, keyed by file path.

    Refuses a file that does not account for every physical layout: a layout
    it misses would be built with no size search, silently.
    """
    path = default_path(skill_dir)
    scale = _CACHE.get(path)
    if scale is None:
        with open(path, 'rb') as f:
            data = json.loads(f.read().decode('utf-8'))
        scale = Scale(data)
        problems = scale.check_layouts(L.physical(skill_dir))
        if problems:
            raise TypographyError('%s: %s' % (path, '; '.join(problems)))
        _CACHE[path] = scale
    return scale


class Tier(object):
    """Card box geometry: padding, gaps, icon.

    There is no ladder ceiling here, on purpose. The tier is the card's
    height, while the ceiling tracks its width: in an eight-card frame the
    cell is the same height as in a six-card one, but a 44px title no longer
    fits it. Ceilings live in the layouts section.
    """

    __slots__ = ('name', 'padding', 'item_gap', 'icon', 'icon_gap',
                 'icon_offset')

    def __init__(self, name, data):
        self.name = name
        self.padding = data['padding']
        self.item_gap = data['item_gap']
        self.icon = data['icon']
        self.icon_gap = data['icon_gap']
        self.icon_offset = data['icon_offset']

    @property
    def padding_box(self):
        """Card padding as (top, right, bottom, left), in pixels.

        In the JSON it's written as a CSS shorthand, because that's how it
        lands in the markup too; we expand it by CSS rules rather than
        keeping a second set of numbers that would drift from the first.
        """
        parts = [float(chunk.replace('px', ''))
                 for chunk in self.padding.split()]
        if len(parts) == 1:
            parts *= 4
        elif len(parts) == 2:
            parts = [parts[0], parts[1], parts[0], parts[1]]
        elif len(parts) == 3:
            parts = [parts[0], parts[1], parts[2], parts[1]]
        return tuple(parts)

    def __repr__(self):
        return '<Tier %s>' % self.name


class Scale(object):
    def __init__(self, data):
        self._data = data
        self.ladders = dict((name, body) for name, body in data['ladders'].items()
                            if not name.startswith('_'))
        self.pairs = dict((name, body) for name, body in data['pairs'].items()
                          if not name.startswith('_'))
        self.grid_gap = data['grid_gap']
        # Underscore-prefixed keys are comments inside the JSON: the format
        # has no native support for them, and the numbers need their
        # explanation right where the numbers are.
        self.tiers = dict((name, Tier(name, body))
                          for name, body in data['tiers'].items()
                          if not name.startswith('_'))
        self.layouts = dict((name, body)
                            for name, body in data['layouts'].items()
                            if not name.startswith('_'))
        self.slide_ladders = data.get('slide_ladders', {})
        self.slide_layouts = dict((name, body)
                                  for name, body in data.get('slide_layouts', {}).items()
                                  if not name.startswith('_'))
        self.unfitted = dict((name, why)
                             for name, why in data.get('unfitted', {}).items()
                             if not name.startswith('_'))
        self.slide_fit = data.get('slide_fit', {})
        self.bullet_marker = data.get('bullet_marker', {})
        self.table_fit = data.get('table_fit', {})

    def check_layouts(self, physical):
        """What is wrong with this scale's account of `physical` layouts.

        Every physical layout sits in exactly one of `layouts` (a card
        ladder), `slide_layouts` (a headline ladder), both - the timeline -
        or `unfitted` (no ladder, for a stated reason); every key names a
        real layout. Returns messages; empty when the file is right.
        """
        physical = set(physical)
        fitted = set(self.layouts) | set(self.slide_layouts)
        named = fitted | set(self.unfitted)
        problems = []
        missing = sorted(physical - named)
        if missing:
            problems.append(
                'no entry for %s - add each to `layouts`, `slide_layouts` or '
                '`unfitted` (with the reason it has no ladder)'
                % ', '.join(missing))
        unknown = sorted(named - physical)
        if unknown:
            problems.append('entries for layouts that do not exist: %s'
                            % ', '.join(unknown))
        both = sorted(fitted & set(self.unfitted))
        if both:
            problems.append('%s both ride a ladder and are listed as '
                            '`unfitted`' % ', '.join(both))
        return problems

    # -------------------------------------------------------------- ladders

    def sizes(self, role):
        """Ladder steps for the role, largest first."""
        return list(self.ladders[role]['sizes'])

    def line_height(self, role):
        return self.ladders[role]['line_height']

    def classes(self, role):
        """CSS classes the build rewrites when this role changes size."""
        return list(self.ladders[role].get('classes', ()))

    def slide_sizes(self, role):
        return list(self.slide_ladders[role]['sizes'])

    # -------------------------------------------------------------- layouts

    def tier_of(self, layout):
        """The layout's tier, or None if it isn't card-based and ignores the scale."""
        entry = self.layouts.get(layout)
        return self.tiers[entry['tier']] if entry else None

    def pair_of(self, layout):
        """The two ladders the layout rides, and their gap window.

        Everything from v1.3 omits `pair` and gets `card`, so the default is
        what keeps those seventeen layouts stepping exactly as they did.
        """
        entry = self.layouts.get(layout)
        if entry is None:
            return None
        return self.pairs[entry.get('pair', 'card')]

    def ceiling_of(self, layout):
        """The largest step of each ladder for this layout."""
        entry = self.layouts.get(layout)
        return entry['ceiling'] if entry else None

    def figure_of(self, layout):
        """The big-figure role that follows the title step, or None.

        {"classes": [...], "per_title": ratio} - the figure is sized as the
        chosen title size times the ratio, so it steps with the title.
        """
        entry = self.layouts.get(layout)
        if entry is None:
            return None
        return entry.get('figure', self.pair_of(layout).get('figure'))

    def candidates(self, layout):
        """Layout steps: (title size, description size) pairs, largest first.

        This is a chain, not a Cartesian product of the two ladders, and the
        difference is essential. A product sorted by description gives a
        non-monotonic sequence: on the 2x3 grid it went 40/26 → 36/26 → 40/24,
        i.e. the title first shrank and then grew again as the text got
        longer. On neighboring slides that reads as a layout bug.

        So the steps are built greedily and both coordinates only ever
        decrease: the description shrinks first — it takes up almost the
        whole card and decides whether things fit — and the title is only
        touched once the gap window won't allow the description to drop
        another step.
        """
        ceiling = self.ceiling_of(layout)
        if ceiling is None:
            return []
        pair = self.pair_of(layout)
        low, high = pair['min_gap'], pair['max_gap']
        titles = [s for s in self.sizes(pair['title'])
                  if s <= ceiling[pair['title']]]
        bodies = [s for s in self.sizes(pair['body'])
                  if s <= ceiling[pair['body']]]
        if not titles or not bodies:
            return []

        def below(sizes, value):
            for size in sizes:
                if size < value:
                    return size
            return None

        title, body = titles[0], bodies[0]
        chain, seen = [], set()
        while (title, body) not in seen:
            seen.add((title, body))
            chain.append((title, body))

            smaller = below(bodies, body)
            if smaller is not None and low <= title - smaller <= high:
                body = smaller
                continue

            # The description can't drop any further without breaking the
            # window — so it's the title's turn. The description may still
            # be forced down along with it, so the gap doesn't fall below
            # the minimum.
            next_title = below(titles, title)
            if next_title is None:
                break
            smaller = body
            while smaller is not None and next_title - smaller < low:
                smaller = below(bodies, smaller)
            if smaller is None or next_title - smaller > high:
                break
            title, body = next_title, smaller
        return chain

    def floor(self, layout):
        """The smallest legal pair for the layout - where the search gives up."""
        pairs = self.candidates(layout)
        return pairs[-1] if pairs else None
