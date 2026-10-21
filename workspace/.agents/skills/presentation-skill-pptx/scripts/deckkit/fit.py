# -*- coding: utf-8 -*-
"""Whether text fits its place: the judgement the size search stands on.

Two questions, one per path of the type ladder. `cards_fit` asks it of the
card-like boxes (`FIT_CLASSES`): does every text stay above the icon's band
and inside its box, in height and in width. `headline_fits` asks it of a
slide's headline: does it stay off the slide edge, inside its fit-box, and
clear of what it must not touch (`typography.json` `slide_layouts.clear`).

`autofit` walks the ladder with these predicates. `validate` reads the same
boxes afterwards, with its own, looser thresholds — a report fires on a real
defect (8 px), the search refuses a step on half a pixel and keeps a margin —
and takes `FIT_CLASSES` and `widest_line` from here so that the two agree on
which boxes are measured and how wide a line is. Until 2.1 all of this lived
inside `autofit` and `validate` imported it from there: the report depended on
the search.
"""
from .typeset import HEADLINE_CONNECTORS, typeset


def headline_orphans(box):
    """Connector-only lines detached from the following phrase.

    Read the actual wrapped lines, retaining line numbers for the warning.
    Short connectors reuse the existing nonbreaking-space policy; longer
    prepositions are recognized without changing the author's text.
    """
    out = []
    for index, line in enumerate((box.lines or ())[:-1], 1):
        label = ''.join(getattr(run, 'text', '') for run in line).strip()
        words = label.split()
        if len(words) != 1:
            continue
        word = words[0].strip('.,:;!?«»“”"()').lower()
        sample = word + ' following'
        if word in HEADLINE_CONNECTORS or typeset(sample) != sample:
            out.append((index, label))
    return out


# What counts as a box the text has to fit inside. Until v1.4 this was the card
# and nothing else, so the whole ladder was unreachable for a layout without
# cards. The v1.4 column components mark their text column `.fit-box` instead:
# same contract - a box with a known height that its text may not leave - with
# none of the card's background, radius or icon corner. validate.py keys its
# overflow check on the same pair, so a column that overflows is now reported
# rather than silently shipped.
FIT_CLASSES = frozenset(('card', 'fit-box'))

# Margin for float accumulation error in the layout. Less than a pixel is
# invisible to the eye, but without the allowance the search sometimes
# rejects a step that lands exactly on the edge.
EPSILON = 0.5


def _text_boxes(box):
    """The measured text of a box. Not what is inside the icon's holder: a
    numbered card's digit sits there (2.4.0), and held to the band reserved
    for its own holder it would never fit."""
    out = []

    def walk(node):
        if node is not box and 'icon-container' in node.classes():
            return
        if node.kind == 'text' and node.lines:
            out.append(node)
        for child in node.children:
            walk(child)

    walk(box)
    return out


def _enclosing(root, target, name):
    """The nearest box classed `name` that contains `target`, or None."""
    found = []

    def walk(box, holder):
        if box is target:
            found.append(holder)
            return True
        if name in box.classes():
            holder = box
        return any(walk(child, holder) for child in box.children)

    walk(root, None)
    return found[0] if found else None


def _first_with_class(box, name):
    for node in box.walk():
        if name in node.classes():
            return node
    return None


def _limit(card, tier):
    """The lower bound the card's text is allowed to reach.

    The icon is mandatory on every card and pinned to the bottom-right
    corner. In the designers' layout it's an ordinary column element under
    the text, i.e. it takes up vertical space; so its band is reserved
    outright, rather than checked for overlap after the fact. That way text
    running into the icon becomes impossible by construction, instead of
    being caught by the validator.
    """
    icon = _first_with_class(card, 'icon-container')
    if icon is not None:
        return icon.y - tier.icon_gap
    return card.y + card.h - tier.padding_box[2]


def widest_line(box):
    """The widest laid-out line of a text box, in px.

    Read off the box: the layout records each line's width when it wraps it.
    Until 2.1 this measured again and stripped the trailing space of every
    run - and since the wrapper makes each word its own run, it dropped every
    space between words, reading a line up to ~100 px narrower than it was.
    """
    return max(box.line_widths) if box.line_widths else 0.0


def cards_fit(root, tier, skip=None):
    """Whether every measured box holds its text — in both directions.

    Width matters as much as height and used not to be checked at all. The
    wrapper breaks between words, so a line can exceed its box only when one
    word does not fit; that word then prints across the neighbouring column.
    Checking it here means the ladder gets a chance to solve it — a word too
    wide at 36px may well fit at 28 — and the validator only has to report the
    case where even the floor is not enough.
    """
    for card in root.walk():
        if not (card.classes() & FIT_CLASSES):
            continue
        texts = _text_boxes(card)
        if skip and any(skip in text.classes() for text in texts):
            # The headline's own fit-box (chart-cards): it rides the slide
            # ladder and is measured there, against its box with no padding.
            # Measured here it would be held to the card tier's padding, fail
            # at every step and drop the cards to the floor.
            continue
        limit = _limit(card, tier)
        for text in texts:
            # Bottom-anchored prose grows out of the top of its bounded box.
            if text.y < card.y + tier.padding_box[0] - EPSILON:
                return False
            if text.y + text.h > limit + EPSILON:
                return False
            if widest_line(text) > text.w + EPSILON:
                return False
    return True


# ------------------------------------------------------------- headlines

def _apart(a, b, pad):
    """Whether the rectangles clear each other once one is padded by `pad`."""
    return (a.x + a.w <= b.x - pad or b.x + b.w <= a.x - pad
            or a.y + a.h <= b.y - pad or b.y + b.h <= a.y - pad)


def headline_fits(root, clear, margin, clearance, scope=None,
                  max_lines=None, max_lines_scope=None):
    """Whether the text of a title, closing or text slide fits.

    Here what gets in the way isn't a card but the logo and the author line.
    The title block is centered on the slide (`top: 50%` plus
    `translate(-50%, -50%)`), i.e. it grows in both directions: four lines at
    144px push its top up to ~230px, while the logo occupies 146-262. The
    title lands right on top of it, and the validator never saw this — it
    only checked overlaps against cards.

    `scope` narrows the check to the text inside one element. A slide that is
    only a headline wants every text box measured; the timeline does not — its
    numerals and column text live *inside* the row the headline has to clear,
    so measuring them against it would reject every step down to the floor.

    `max_lines` caps each measured text unless `max_lines_scope` selects a
    class for the line cap only. Geometry still checks all texts in `scope`:
    an opening headline's cap must not discard its subtitle's fit checks.
    """
    obstacles = [box for box in root.walk() if box.classes() & clear]
    top, bottom = root.y + margin, root.y + root.h - margin
    if scope is not None:
        holder = _first_with_class(root, scope)
        if holder is None:
            return True
        texts = _text_boxes(holder)
    else:
        texts = _text_boxes(root)
    for text in texts:
        if text.y < top - EPSILON or text.y + text.h > bottom + EPSILON:
            return False
        # A word wider than its line prints past the edge, in a fit-box or
        # not. Until 2.3.0 only a fit-box was checked here, so the closing
        # slide kept 168px for «за внимание!» glued into one word (2.3.0
        # glues the short words everywhere) and left the validator an
        # OVERFLOW that one step down would have fitted.
        if widest_line(text) > text.w + EPSILON:
            return False
        capped = max_lines_scope is None or max_lines_scope in text.classes()
        if capped and max_lines is not None and len(text.lines) > max_lines:
            return False
        # A headline held in a .fit-box (the chart titles) has to stay inside
        # it in height too: that box is the room the design gives the title,
        # and without this the ladder would stop at 72px and hand the
        # validator a title spilling out of it - a fourth line - when 64px
        # would have fitted.
        holder = _enclosing(root, text, 'fit-box')
        if holder is not None:
            if text.y + text.h > holder.y + holder.h + EPSILON:
                return False
        for other in obstacles:
            if other is text:
                continue
            if not _apart(text, other, clearance):
                return False
    return True


def table_fits(root):
    """Measure the full white table including row padding, and its cells."""
    region = _first_with_class(root, 'table-region')
    if region is None:
        return True
    grid = _first_with_class(region, 'table-grid')
    if grid.y + grid.h > region.y + region.h + EPSILON:
        return False
    for row in grid.children:
        head = 'table-head' in row.classes()
        for cell in row.children:
            for text in _text_boxes(cell):
                if widest_line(text) > text.w + EPSILON:
                    return False
                if text.y < row.y - EPSILON or text.y + text.h > row.y + row.h + EPSILON:
                    return False
                if not head and 'num' in cell.classes() and len(text.lines) > 1:
                    return False
    return True
