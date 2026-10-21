# -*- coding: utf-8 -*-
"""Deck validation before the file goes to the customer.

The main concern here is overflow. Text that does not fit in a card simply
overflows the rounded corner in HTML, and in PPTX it overlaps the icon; you
can only spot this by eye on the finished slide. Therefore layout is computed
in advance by the same engine used in conversion, and the result is checked
against card boundaries.

"The same engine" is now literally the same object: `check` takes the open
`Document` the build already measured to pick type sizes, and reads its box
trees. Until v1.5 it opened the file and built its own stylesheet, font book
and layout engine — a second measurement that was only ever expected to agree
with the first.
"""
import collections
import re


from . import layouts as L
from . import typography as T
from .fit import FIT_CLASSES, headline_orphans, widest_line
from .html2pptx import chartgeom as G
from .html2pptx import formula
from .html2pptx.assets import contain_rect, image_size, picture_mask_area
from .html2pptx.paint import check_resources, picture_placement
from .html2pptx import values as PV
from .model import FormulaError, Issue

# How far an image's native aspect ratio may differ from its panel's before
# the crop `object-fit: cover` applies is worth flagging. Some crop is normal
# and not worth a warning; this is for a mismatch severe enough that it is
# probably cutting off something the author meant to show.
_ASPECT_WARN = 0.25

# Emoji ranges, plus the separator dots · • ∙ ⋅. Corporate style allows none
# of them in slide text — emoji read as noise, and a middle dot is how a
# fake bullet or an inline separator gets past a layout that has a real place
# for both.
_EMOJI = re.compile(
    '[\U0001F000-\U0001FAFF☀-➿⬀-⯿️←-⇿·•∙⋅]')

# How many pixels content can overflow before it becomes an error.
_OVERFLOW_WARN = 1.0
_OVERFLOW_ERROR = 8.0

# Elements fixed in place on the slide: text must not touch them.
_OBSTACLES = frozenset(('logo', 'text-author'))

# The notes pane is the only text field with no measured limit, and it is the
# natural place to park content that would not fit on a slide — a failure that
# reads as a good deck right up until someone opens presenter mode and finds an
# essay. This number is not measured and cannot be: notes have no box. It is
# roughly six times the house style (the two notes in assets/example-deck.json
# are 99 and 108 characters), so it fires only on something that has plainly
# stopped being a speaker's prompt. A warning, never an error — the deck is
# fine, the writing is not, and that is the author's call.
_NOTES_LONG = 600

# A layout this many slides in a row reads as one slide repeated. Three is
# not enough: on ten 40-slide agent decks (tmp_files/layout-repeat-research)
# a run of three turned up in nearly every one, and a warning on every deck
# teaches the agent to shuffle layouts for their own sake. Four fired 18
# times in 6 of the 10, each a stretch a reader would call monotonous.
_LAYOUT_RUN = 4

# Advisory candidates calibrated separately from the consecutive-run rule.
# Framing slides must not dilute the content distribution. Short decks have
# too little evidence for either concentration check; no layout quotas apply.
_LAYOUT_MIX_MIN = 10
_LAYOUT_WINDOW = 10
_LAYOUT_WINDOW_MAX = 6
_LAYOUT_FRAMING = frozenset(('title', 'agenda', 'final'))

# A metric value must leave this share of its type size clear before the next
# metric's column. The row's gap is 20 px, and at 192 px that is nothing: the
# v2.1.0 stress test's «3100 ₽» (534 px in a 553 px column) read as «₽1,9 %»,
# the currency opening the next figure. A quarter of the size is 48 px at
# 192 — «6 мин» (489 px) keeps 64 and reads apart. A judgement, measured on
# that one slide; the value's own one-line rule is `METRIC_WRAP` above it.
_METRIC_CLEARANCE_EM = 0.25

# A `statement` is one thought set large. Three lines is about 52 characters
# of prose at 144 px; the v2.1.0 stress test parked 290-character paragraphs
# there (slides 4 and 106) and the ladder quietly set them at 112 px, nine
# lines of wall. The designers' own statements (tmp_files/statement_new_
# feedback, Sep 2026) run 19-45 characters on one or two lines; the longest
# they did not object to for length, 49 characters, sets on three.
#
# The two looks from the designers (2.4.0) differ in room: the glass panel
# is as wide as the retired yellow-pattern text and keeps three; the cards look sets its
# text inside one card, 1187 px wide, which the designers fill with two.
# The characters are what the advice quotes, measured at 144 px.
_STATEMENT_LINES = {'statement-glass': (3, 50), 'statement-cards': (2, 25)}

# A versus side (2.4.0) stands on the bottom of its card, so its text is what
# fills the card: at one or two lines the slide reads empty, past six the
# text climbs into the title. Two sides more than a line apart stop reading
# as a pair - the subtitles and the text starts no longer line up (the
# author, on the gate deck). Lines at the fixed 30px, about 42 characters each.
_VERSUS_TEXT = (3, 6)
_VERSUS_SKEW = 1
_VERSUS_TITLE = 3
_VERSUS_SUBTITLE = 2


def check(deck, document, sizes=()):
    """All deck checks. Returns list of issues.

    `document` is the open, already-fitted `html2pptx.document.Document` —
    the same one the PPTX is written from. `sizes` is what `autofit.fit`
    chose for it, one `Sizes` per slide: where the headline ladder ran out,
    that verdict is the report (see `_check_headlines`).
    """
    layouts = [s.layout for s in deck.slides]
    issues = check_deck(deck)
    issues.extend(paint_issues(check_resources(document)))
    issues.extend(_check_overflow(document, layouts))
    issues.extend(_check_formula_width(document, deck.skill_dir, layouts))
    issues.extend(_check_media(document))
    issues.extend(_check_headlines(document, sizes, deck.skill_dir))
    issues.extend(_check_headline_density(document, sizes, deck.skill_dir))
    issues.extend(_check_headline_orphans(document, layouts, deck.skill_dir))
    issues.extend(_check_charts(document))
    issues.extend(_check_leads(document))
    issues.extend(_check_statements(document, layouts))
    issues.extend(_check_versus(document, layouts))
    issues.extend(_check_tables(document, layouts))
    return issues


def paint_issues(diagnostics):
    """Map engine diagnostics without importing deckkit into the engine."""
    return [Issue('error', d.code, d.slide, '<%s class="%s">: %s' % (
            d.tag, ' '.join(d.classes), d.message)) for d in diagnostics]


def check_deck(deck):
    """The checks that read the deck alone - text, icons, order, runs.

    No layout is needed for any of them, so they are testable on a deck built
    from a spec without writing or measuring anything.
    """
    return (_check_content(deck) + _check_structure(deck)
            + _check_chart_width(deck))


# ------------------------------------------------------------------ content

# String fields that are not slide text: icon queries, a file path, CSV column
# names (a line's "fill" too), enumerations and the colours resolved for a
# chart.
_NOT_TEXT = frozenset(('icon', 'note_icon', 'src', 'x', 'y', 'chart_type',
                       'mode', 'colors', 'value_labels', 'fill', 'tone',
                       'look', 'fit'))

# Deliberately narrow hints, not an equation classifier. Plain arithmetic,
# currency, percentages and units have no signal here. Mask code and resource
# tokens first so identifiers and URLs do not become authoring advice.
_MATH_LITERAL = re.compile(r'`[^`]*`|https?://\S+|\S*[/\\][\w.-]+\.[A-Za-z0-9]+')
_UNTAGGED_MATH = re.compile(
    r'\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|oint|mathbb|mathrm|'
    r'alpha|beta|theta|sigma|mu|rho|hat|bar|lim)\b'
    r'|[∑∏∫∮√]'
    r'|(?<![\w/\\])[A-Za-zα-ωΑ-Ω](?:_\{[^{}\n]+\}|\^\{[^{}\n]+\}'
    r'|_[A-Za-z0-9]|\^[0-9]+)(?![\w/])'
    r'|\b(?:Cov|Var|E)\s*[\[(][^\])\n]+[\])]\s*=')


def _untagged_math(text):
    """One suspect excerpt in prose outside explicit inline math, or None."""
    # Fillers parse each line separately too. Do not join prose across a math
    # run: doing so can fabricate an expression absent from the source.
    for line in text.split('\n'):
        try:
            pieces = formula.parse_inline(line)
        except FormulaError:
            continue  # the formula error has its own blocking diagnostic
        for kind, value in pieces:
            if kind != 'text':
                continue
            match = _UNTAGGED_MATH.search(_MATH_LITERAL.sub(' ', value))
            if match:
                return match.group(0)
    return None


def _texts_of(slide):
    """Every text of a slide as (where, text), found by walking its data.

    A walk and not a list of keys: the list this replaced was written for the
    card layouts and never learned `flow`'s steps and summary, `columns` or a
    timeline point's title, so an emoji there built clean. The walk reads
    dicts, lists, and the slotted model objects (`Card`, `Metric`,
    `ChartData`, `Series`) alike, and a new layout is covered the day it
    lands. Only `_NOT_TEXT` has to be kept, and it names what is not text.
    """
    out = []

    def walk(value, where):
        if isinstance(value, str):
            if value:
                out.append((where, value))
        elif isinstance(value, dict):
            for key, item in value.items():
                if key in _NOT_TEXT or (key == 'data' and isinstance(item, str)):
                    continue  # a chart's `data` string is a CSV path
                walk(item, '%s.%s' % (where, key) if where else key)
        elif isinstance(value, (list, tuple)):
            for index, item in enumerate(value, 1):
                walk(item, '%s %d' % (where, index))
        elif hasattr(value, '__slots__'):
            for key in value.__slots__:
                if key not in _NOT_TEXT:
                    walk(getattr(value, key), '%s.%s' % (where, key))

    walk(slide.data, '')
    return out


def _check_content(deck):
    issues = []
    for index, slide in enumerate(deck.slides, 1):
        for where, text in _texts_of(slide):
            found = _EMOJI.findall(text or '')
            if found:
                issues.append(Issue(
                    'error', 'EMOJI', index,
                    'emoji %s in the text (%s) - the corporate style excludes them'
                    % (' '.join(found), where)))
            suspect = _untagged_math(text)
            if suspect:
                record = L.public_of(slide.layout)
                allowed = sorted(record.formula_paths()) if record else []
                remedy = ('use \\(...\\) in %s if mathematical typesetting is '
                          'intended' % ', '.join(allowed)) if allowed else (
                              'if typesetting is intended, choose a layout '
                              'with formula-enabled body text')
                issues.append(Issue(
                    'warning', 'UNTAGGED_MATH', index,
                    'possible untagged math %r in %s; %s. Review the context '
                    'and keep intentional plain text; no automatic rewrite'
                    % (suspect, where, remedy)))
        if slide.notes and len(slide.notes) > _NOTES_LONG:
            issues.append(Issue(
                'warning', 'NOTES_TOO_LONG', index,
                'notes are %d characters - that reads as an essay, not as a '
                'speaker prompt. Keep them to 2-4 sentences; anything the '
                'audience is meant to get belongs on the slide' % len(slide.notes)))
    return issues


def _check_structure(deck):
    issues = []
    layouts = [s.layout for s in deck.slides]

    if 'title' not in layouts:
        issues.append(Issue('warning', 'NO_TITLE', 1,
                            'no title slide'))
    elif layouts[0] != 'title':
        issues.append(Issue('warning', 'TITLE_NOT_FIRST', layouts.index('title') + 1,
                            'the title slide is not first'))

    if 'final' not in layouts:
        issues.append(Issue('warning', 'NO_FINAL', len(layouts),
                            'no closing slide'))
    elif layouts[-1] != 'final':
        issues.append(Issue('warning', 'FINAL_NOT_LAST', layouts.index('final') + 1,
                            'the closing slide is not last'))

    # Icons. Duplicate within a slide — error: two cards (steps, points) with
    # the same icon read as incomplete. IconAllocator already prevents this, so the
    # check is a safety net — for a spec assembled bypassing the allocator,
    # or when a concept runs out of options.
    counts = {}
    first_slide = {}
    for index, slide in enumerate(deck.slides, 1):
        seen = set()
        for icon in icons_of(slide):
            if icon in seen:
                issues.append(Issue(
                    'error', 'DUPLICATE_ICON', index,
                    'icon "%s" is used twice on this slide - give each card, '
                    'step or point its own icon' % icon))
            seen.add(icon)
        # Count each icon once per slide across the deck: two repeats on one
        # slide is already DUPLICATE_ICON above, and doubling them in the
        # counter would mean complaining about the same thing twice.
        for icon in sorted(seen):
            counts[icon] = counts.get(icon, 0) + 1
            first_slide.setdefault(icon, index)

    for icon in sorted(counts):
        if counts[icon] > 3:
            issues.append(Issue(
                'warning', 'REPEATED_ICON', first_slide[icon],
                'icon "%s" carries %d slides of this deck - vary it'
                % (icon, counts[icon])))

    # Same icon on adjacent slides stands out more than the same repetition
    # ten slides apart, so this is checked separately from volume.
    previous = set()
    for index, slide in enumerate(deck.slides, 1):
        current = set(icons_of(slide))
        repeated = current & previous
        if repeated:
            issues.append(Issue(
                'warning', 'SAME_ICON', index,
                'icon %s repeats from the adjacent slide' % ', '.join(sorted(repeated))))
        previous = current

    # The same layout on consecutive slides, whatever its element count:
    # holding `cards` and changing the count is how the long runs were made,
    # so counting 3 -> 4 -> 3 as a change would miss the common case.
    # Charts are the exception - a bar chart after a line chart is a
    # different picture - so their type is part of the key.
    keys = [_layout_key(slide) for slide in deck.slides]
    start = 0
    for index in range(1, len(keys) + 1):
        if index < len(keys) and keys[index] == keys[start]:
            continue
        if index - start >= _LAYOUT_RUN:
            issues.append(Issue(
                'warning', 'REPEATED_LAYOUT', start + 1,
                'slides %d-%d are all "%s" - a run this long reads as one '
                'slide repeated; regroup the material (several single cards '
                'make one grid) or give part of it another layout'
                % (start + 1, index, keys[start][0])))
        start = index

    # Two statements in a row are an error, not a run: a statement is the
    # pause between sections, and a second one straight after it is a pause
    # with nothing to pause from (the author, 2026-10-04). A change of look
    # does not make them two slides worth having.
    for index in range(1, len(keys)):
        if keys[index][0] == keys[index - 1][0] == 'statement':
            issues.append(Issue(
                'error', 'STATEMENT_RUN', index + 1,
                'slides %d-%d are both statements - a statement is a pause '
                'between sections and does not follow another one; merge them '
                'into one claim, or put the slide they introduce between them'
                % (index, index + 1)))
    text_slides = [index + 1 for index, key in enumerate(keys)
                   if key[0] == 'text-slide']
    for index in text_slides[2:]:
        issues.append(Issue(
            'error', 'TEXT_SLIDE_LIMIT', index,
            'a deck takes at most two text slides; condense this text or '
            'turn it into cards, a diagram or a chart'))
    for previous, current in zip(text_slides, text_slides[1:]):
        if current == previous + 1:
            issues.append(Issue(
                'error', 'TEXT_SLIDE_RUN', current,
                'slides %d-%d are both text slides; merge them or place '
                'a slide with cards, a diagram or a chart between them'
                % (previous, current)))
    return issues + _check_layout_mix(deck)


def _check_layout_mix(deck):
    """Deck share and overlapping content windows, with original slide IDs.

    A family is the existing run key: counts and looks do not create variety;
    different chart types still do. No headings or notes are inferred as
    section boundaries. Overlapping windows for one family produce one issue.
    """
    content = []
    for index, slide in enumerate(deck.slides, 1):
        key = _layout_key(slide)
        if key[0] not in _LAYOUT_FRAMING:
            content.append((index, key))
    total = len(content)
    if total < _LAYOUT_MIX_MIN:
        return []
    issues = []
    remedy = ('Review the grouping and explanation: use a flow for a causal '
              'chain, a timeline for time, or a comparison for alternatives '
              'when the content calls for it. Do not shuffle layouts to meet '
              'a quota; a specialized deck may retain this format with a '
              'stated reason.')
    counts = collections.Counter(key for _, key in content)
    for key, count in counts.items():
        if count * 2 <= total:
            continue
        slides = [str(index) for index, family in content if family == key]
        issues.append(Issue(
            'warning', 'LAYOUT_DOMINANCE', int(slides[0]),
            'layout family "%s" carries %d/%d content slides (%.1f%%, over '
            '50%%); slides %s. %s'
            % (_layout_label(key), count, total, 100.0 * count / total,
               ', '.join(slides), remedy)))

    hotspots = collections.OrderedDict()
    for start in range(total - _LAYOUT_WINDOW + 1):
        window = content[start:start + _LAYOUT_WINDOW]
        for key, count in collections.Counter(k for _, k in window).items():
            if count <= _LAYOUT_WINDOW_MAX:
                continue
            spans = hotspots.setdefault(key, [])
            end = start + _LAYOUT_WINDOW - 1
            if spans and start <= spans[-1][1]:
                spans[-1][1] = end
                if count > spans[-1][3]:
                    spans[-1][2:4] = [start, count]
            else:
                spans.append([start, end, start, count])
    for key, spans in hotspots.items():
        for start, end, peak, count in spans:
            window = content[peak:peak + _LAYOUT_WINDOW]
            matching = [str(index) for index, family in window if family == key]
            issues.append(Issue(
                'warning', 'LAYOUT_CONCENTRATION', content[start][0],
                'content windows in slides %d-%d overuse layout family "%s"; '
                'peak window slides %d-%d has %d/10 (over 6/10), at slides '
                '%s. Overlapping windows are grouped. %s'
                % (content[start][0], content[end][0], _layout_label(key),
                   window[0][0], window[-1][0], count, ', '.join(matching),
                   remedy)))
    return issues


def _layout_label(key):
    types = [kind for kind in key[1:] if kind]
    return key[0] + (':' + '+'.join(types) if types else '')


def _layout_key(slide):
    """What makes two neighbouring slides look the same: the layout the
    spec named - `slide.layout` is the physical variant by now, and
    `cards-3` next to `cards-4` is the same layout - and for a chart the
    chart type too."""
    record = L.public_of(slide.layout)
    name = record.name if record else slide.layout
    data = slide.data
    if data.get('charts'):
        return (name,) + tuple(c.get('chart_type') for c in data['charts'])
    return (name, data.get('chart_type'))


def icons_of(slide):
    """Every icon on a slide: cards, steps, chart points, a note's icon.

    Asked of the layout record rather than read off `cards`: until 2.1 this
    read cards only, so a flow or chart deck with the same icon on every
    slide was never warned about.
    """
    record = L.public_of(slide.layout)
    return record.icons_of(slide.data) if record is not None else []


# -------------------------------------------------------------------- media

def _check_media(document):
    """Advisory checks for `image` slides: resolution and crop.

    `resolve_image` already fails the build on a missing or unreadable file
    — this is the softer half, run once the picture is known good and its
    panel size is known from layout. Both are warnings: a slightly soft or
    cropped picture still ships, it just may not be what the author wanted.
    """
    issues = []
    for index, root in enumerate(document.boxes(), 1):
        for box in _walk(root, []):
            if box.kind == 'image' and 'media-image' in box.classes():
                issues.extend(_image_issues(box, index))
    return issues


def _image_issues(box, slide_index):
    issues = []
    if not box.src or not box.w or not box.h:
        return issues
    try:
        native_w, native_h = image_size(box.src)
    except (IOError, OSError):
        return issues
    if not native_w or not native_h:
        return issues

    display_w, display_h = box.w, box.h
    contained = box.style.get('object-fit') == 'contain'
    framed = bool({'framed-image', 'gallery-picture'} & set(box.classes())) if hasattr(box, 'classes') else False
    if framed:
        radius = PV.length(box.style.get('border-radius'), default=0) or 0
        outline = PV.outline(box.style.get('clip-path'), box.w, box.h)
        visible, radius, outline, crop, target = picture_placement(
            box, box.src, radius, outline)
        if visible <= 0:
            return issues
        if contained:
            _, _, display_w, display_h = target
        else:
            scale = max(box.w/native_w, box.h/native_h)
            display_w, display_h = native_w*scale, native_h*scale
    elif contained:
        _, _, display_w, display_h = contain_rect(box.src, box.w, box.h)
    elif box.style.get('object-fit') == 'cover':
        scale = max(box.w/native_w, box.h/native_h)
        display_w, display_h = native_w*scale, native_h*scale
    if native_w < display_w or native_h < display_h:
        issues.append(Issue(
            'warning', 'LOW_RES_IMAGE', slide_index,
            'image is %dx%d px but its panel shows it at %dx%d - it will be '
            'upscaled and look soft. Use a higher-resolution source'
            % (native_w, native_h, round(display_w), round(display_h))))

    if framed:
        mask_area = picture_mask_area(box.w, visible, radius, outline)
        mask_fraction = min(1, max(0, mask_area / (box.w*visible)))
        if contained:
            empty = max(0, 1-display_w*display_h/max(1, mask_area))
            if empty > _ASPECT_WARN:
                issues.append(Issue('warning', 'IMAGE_LETTERBOX', slide_index,
                    'contain preserves the whole source inside the rounded/cutout '
                    'safe region; %.1f%% of the visible frame is empty. '
                    'Use a source closer to the frame proportions or cover '
                    'if cropping is acceptable' % (empty*100)))
        else:
            left, top, right, bottom = crop or (0, 0, 0, 0)
            rectangular = max(0, 1-(1-left-right)*(1-top-bottom))
            removed = 1-(1-rectangular)*mask_fraction
            if removed > _ASPECT_WARN:
                remedy = ('Use a source composed for this gallery frame or crop '
                          'it yourself. For an information-heavy diagram, use '
                          'image-points with fit: contain'
                          if 'gallery-picture' in box.classes() else
                          'Use contain to preserve the whole source or crop '
                          'the source yourself')
                issues.append(Issue('warning', 'IMAGE_CROP', slide_index,
                    'cover removes %.1f%% of the source area: rectangular crop '
                    '%.1f%%, source edges left %.1f%% / top %.1f%% / right %.1f%% '
                    '/ bottom %.1f%%; the rounded/cutout mask removes a further '
                    '%.1f%% of the retained area. %s'
                    % (removed*100, rectangular*100, left*100, top*100,
                       right*100, bottom*100, (1-mask_fraction)*100, remedy)))
        return issues

    box_ratio = box.w / box.h
    img_ratio = native_w / native_h
    if abs(img_ratio - box_ratio) / box_ratio > _ASPECT_WARN:
        detail = ('"object-fit: contain" keeps the whole image with empty '
                  'margins. Use a source matching the screen proportions '
                  'or choose cover if cropping is acceptable'
                  if contained else
                  '"object-fit: cover" will crop it to fill. Crop it yourself '
                  'first if the composition matters')
        issues.append(Issue(
            'warning', 'IMAGE_ASPECT', slide_index,
            'image is %dx%d px, a different shape than its panel - '
            '%s' % (native_w, native_h, detail)))
    return issues


# ------------------------------------------------------------------ layout

def _walk(box, out):
    out.append(box)
    for child in box.children:
        _walk(child, out)
    return out


def _check_overflow(document, layouts=()):
    """Read the laid-out slides and find content that overflowed its box.

    `layouts` is the physical layout slug per slide, in document order. It only
    shapes the advice at the end of a message: a card layout can be traded for
    one with fewer cards and a column layout for one with fewer columns, but
    the metrics header can be traded for nothing — its type is fixed, so the
    only remaining fix is shorter text and the message must not imply otherwise.
    """
    issues = []
    for index, root in enumerate(document.boxes(), 1):
        layout = layouts[index - 1] if index <= len(layouts) else ''
        boxes = _walk(root, [])
        for box in boxes:
            if box.classes() & FIT_CLASSES:
                issues.extend(_card_issues(box, index, layout))
        issues.extend(_slide_issues(root, boxes, index))
    return issues


def _check_formula_width(document, skill_dir, layouts=()):
    """A formula that only fits because the whole slide dropped a step.

    `OVERFLOW` catches a formula wider than its box at the size that shipped.
    It cannot catch the other failure, which is quieter and more common: the
    formula *did* fit, but only after the size search walked the slide down
    the ladder to make room, so every card on it is set smaller than the
    layout was designed for. Before this check that cost was invisible — the
    build reported no issues and the deck simply looked timid.

    The reference size is **one step below the layout's ceiling**, not the
    ceiling itself. Costing a slide one step is ordinary give-and-take —
    prose does it constantly, and refusing a formula for being 10 px over an
    idealised size would be pedantry. Costing two or more means the formula
    is driving the design, and that is what this refuses. The reference is
    taken from the ladder rather than from whatever the search picked, so it
    does not move when a neighbouring card's text is edited.

    An error, not a warning: the author's call (2026-09-09) was that refusing
    and asking for the formula to be split across two lines is better than
    silently shrinking a slide someone else designed. Same reasoning as the
    one-word headline, and the opposite of what v1.8 did.
    """
    from . import typography as T
    from .html2pptx.formula import MathRun, math_width

    issues = []
    scale = T.load(skill_dir)
    for index, root in enumerate(document.boxes(), 1):
        layout = layouts[index - 1] if index <= len(layouts) else ''
        steps = scale.candidates(layout) or ()
        # candidates() runs largest first; [1] is one step below the ceiling.
        # A layout with a single step has no give at all, so its ceiling is
        # the reference.
        body_ceiling = steps[min(1, len(steps) - 1)][1] if steps else None
        for box in _walk(root, []):
            if box.kind != 'text' or not box.lines:
                continue
            size = _font_size_of(box)
            # A box outside the scale keeps its own size, and the check then
            # reduces to the plain overflow one — which already reported it.
            reference = max(size, body_ceiling or 0) or size
            if not reference:
                continue
            for line in box.lines:
                for run in line:
                    if not isinstance(run, MathRun):
                        continue
                    width = math_width(run.mathtext, reference, run.weight)
                    if width <= box.w + 0.5:
                        continue
                    # The message claims only what was measured. It used to
                    # say the formula "fits only by dropping the whole slide
                    # two type steps", and on a real deck that was false: on
                    # one card-4 slide the surrounding prose already cost five
                    # steps on its own and the formula added one, so the
                    # sentence blamed it for damage it did not do. What the
                    # check actually establishes is narrower and still
                    # actionable — this formula alone cannot be set at the
                    # reference size, whatever else is on the slide.
                    issues.append(Issue(
                        'error', 'FORMULA_TOO_WIDE', index,
                        'formula \\(%s\\) needs %d px at %d px type and its '
                        'column is only %d px, so this formula on its own '
                        'forces the slide below the size the layout intends. '
                        'Split it into two \\(...\\) formulas - the line can '
                        'break between them - or shorten it.'
                        % (run.latex, round(width), round(reference),
                           round(box.w))))
    return issues


# chart-wide (2.3.0, the designers' review: "more than 8 on a narrow chart -
# take the wide one; fewer than 6 on the wide one - take the narrow").
# Warnings: the chart is drawn either way, and is only less readable.
_NARROW_CATEGORIES_MAX = 8
_WIDE_CATEGORIES_MIN = 6
# The note beside the title of chart-two and chart-wide (2.3.0, the
# designers: "exactly two lines, a short one not drawn"): one line hangs
# beside the title as a stray caption, three crowd it.
_NOTE_LINES = 2


def _check_chart_width(deck):
    """A chart of many categories across beside its points, or a short
    series across the whole slide: point to the other layout."""
    issues = []
    for index, slide in enumerate(deck.slides, 1):
        data = slide.data.get('data')
        count = len(getattr(data, 'categories', None) or ())
        # bar_h lists its categories down the plot, and the wide plot is
        # the shorter one: its bars would only get thinner there.
        if slide.layout in ('chart-points', 'chart-points-plates') \
                and G.canonical(slide.data.get('chart_type')) != 'bar_h' \
                and count > _NARROW_CATEGORIES_MAX:
            issues.append(Issue(
                'warning', 'CHART_WIDTH', index,
                'a chart of %d categories beside its points is cramped - '
                '"chart-wide" sets one of more than %d across the slide, the '
                'takeaway in its "note"' % (count, _NARROW_CATEGORIES_MAX)))
        elif slide.layout == 'chart-wide' and count < _WIDE_CATEGORIES_MIN:
            issues.append(Issue(
                'warning', 'CHART_WIDTH', index,
                '"chart-wide" is for a long series, %d categories or more; '
                'this one has %d - "chart" sets it beside its points'
                % (_WIDE_CATEGORIES_MIN, count)))
    return issues


def _check_leads(document):
    """The note beside the title of a chart slide holds exactly two lines.
    How many characters that is depends on the layout (references/
    layouts.md), so the messages give the lines, not a count."""
    issues = []
    for index, root in enumerate(document.boxes(), 1):
        for box in _walk(root, []):
            if 'chart-note-text' not in box.classes() or not box.lines:
                continue
            if len(box.lines) > _NOTE_LINES:
                issues.append(Issue(
                    'error', 'OVERFLOW', index,
                    'the note beside the title takes %d lines, it holds '
                    'exactly %d - shorten it ("%s")'
                    % (len(box.lines), _NOTE_LINES, _snippet(box))))
            elif len(box.lines) < _NOTE_LINES:
                issues.append(Issue(
                    'error', 'NOTE_SHORT', index,
                    'the note beside the title takes one line and would hang '
                    'there as a stray caption - it is exactly two lines: '
                    'write it out or drop "note" and "note_icon" ("%s")'
                    % _snippet(box)))
    return issues


def _check_charts(document):
    """What a chart's layout could not seat (`Geometry.problems`).

    The chart is native, so PowerPoint sets its labels, and where they do not
    fit it wraps, rotates or overprints them on its own — nothing the preview
    shows. `chartgeom` measures the labels against their columns and bars in
    the layout pass; this turns what it could not seat into errors, and
    what it drew without (a doughnut slice left unlabelled) into warnings.
    """
    issues = []
    for index, root in enumerate(document.boxes(), 1):
        reduced = []
        for box in _walk(root, []):
            chart = box.chart if box.kind == 'chart' else None
            if chart is None or chart.geometry is None:
                continue
            if chart.chart_type != 'doughnut' and chart.geometry.dense:
                reduced.append(chart)
            for problem in chart.geometry.problems:
                issues.append(Issue('error', 'CHART_LABELS', index,
                                    '%s chart: %s' % (chart.chart_type,
                                                      problem)))
            for warning in chart.geometry.warnings:
                issues.append(Issue('warning', 'CHART_LABELS', index,
                                    '%s chart: %s' % (chart.chart_type,
                                                      warning)))
        if reduced:
            palette = reduced[0].palette
            full = palette.type['chart_text']['size'] * 0.75
            small = palette.type['chart_text_dense']['size'] * 0.75
            issues.append(Issue(
                'warning', 'CHART_TEXT_REDUCED', index,
                'dense values or a long legend reduced chart text on this '
                'slide from %g pt to %g pt (%d chart%s); consider fewer '
                'categories or series, shorter names, or a wider chart'
                % (full, small, len(reduced),
                   '' if len(reduced) == 1 else 's')))
    return issues


def _check_statements(document, layouts):
    """A `statement` longer than `_STATEMENT_LINES` lines at its set size."""
    issues = []
    for index, root in enumerate(document.boxes(), 1):
        if index > len(layouts) or layouts[index - 1] not in _STATEMENT_LINES:
            continue
        limit, chars = _STATEMENT_LINES[layouts[index - 1]]
        for box in _walk(root, []):
            if 'title-large' not in box.classes() or not box.lines:
                continue
            if len(box.lines) > limit:
                issues.append(Issue(
                    'error', 'STATEMENT_TOO_LONG', index,
                    'the statement "%s" takes %d lines at %dpx; a statement '
                    'is one thought and here holds %d (about %d characters). '
                    'Cut it to the claim%s, or make it a cards slide with '
                    'the claim as its title'
                    % (_snippet(box), len(box.lines),
                       round(box.font_size or 0), limit, chars,
                       ', take "look": "glass" (three lines)'
                       if limit < 3 else '')))
    return issues


def _check_versus(document, layouts):
    """How much text a versus side holds, and how far the two may differ."""
    issues = []
    for index, root in enumerate(document.boxes(), 1):
        if index > len(layouts) or layouts[index - 1] != 'versus':
            continue
        lines = []
        for side, card in zip(('left', 'right'), [
                b for b in _walk(root, []) if 'versus-card' in b.classes()]):
            texts = {}
            for box in _walk(card, []):
                for name in ('versus-title', 'card-subtitle', 'card-description'):
                    if name in box.classes() and box.lines:
                        texts[name] = box
            title, subtitle = texts.get('versus-title'), texts.get('card-subtitle')
            text = texts.get('card-description')
            if title is not None and len(title.lines) > _VERSUS_TITLE:
                issues.append(Issue(
                    'error', 'VERSUS_TOO_LONG', index,
                    'the %s title "%s" takes %d lines, a versus title holds '
                    '%d - shorten it to the name of the option'
                    % (side, _snippet(title), len(title.lines), _VERSUS_TITLE)))
            if subtitle is not None and len(subtitle.lines) > _VERSUS_SUBTITLE:
                issues.append(Issue(
                    'error', 'VERSUS_TOO_LONG', index,
                    'the %s subtitle "%s" takes %d lines, it holds %d'
                    % (side, _snippet(subtitle), len(subtitle.lines),
                       _VERSUS_SUBTITLE)))
            if text is None:
                continue
            count = len(text.lines)
            lines.append((side, count))
            low, high = _VERSUS_TEXT
            if count < low:
                issues.append(Issue(
                    'error', 'VERSUS_SHORT', index,
                    'the %s text "%s" takes %d line%s; a versus side needs '
                    '%d to %d (about %d-%d characters) or the card stands '
                    'empty - say what the option means in practice'
                    % (side, _snippet(text), count, '' if count == 1 else 's',
                       low, high, low * 42, high * 42)))
            elif count > high:
                issues.append(Issue(
                    'error', 'VERSUS_TOO_LONG', index,
                    'the %s text "%s" takes %d lines; a versus side holds '
                    '%d (about %d characters) - cut it to the difference '
                    'that matters' % (side, _snippet(text), count, high,
                                      high * 42)))
        if len(lines) == 2 and abs(lines[0][1] - lines[1][1]) > _VERSUS_SKEW:
            issues.append(Issue(
                'error', 'VERSUS_SKEW', index,
                'the left text takes %d lines and the right %d; the two '
                'sides may differ by %d line at most, or they stop reading '
                'as a pair - even them out' % (lines[0][1], lines[1][1],
                                               _VERSUS_SKEW)))
    return issues


def _check_tables(document, layouts):
    """What a native table's cells hold (2.4.0).

    Overflow of the whole grid is the card check's (the table card is a
    fit-box, the compare cards are cards). What is left is table-shaped: a
    figure split over two lines reads as two figures, and a heading taller
    than its fixed row runs across the rule under it.
    """
    issues = []
    for index, root in enumerate(document.boxes(), 1):
        if index > len(layouts) \
                or layouts[index - 1] not in ('table', 'table-compare'):
            continue
        for region in (box for box in _walk(root, [])
                       if 'table-region' in box.classes()):
            grid = next(box for box in region.walk()
                        if 'table-grid' in box.classes())
            if grid.y + grid.h > region.y + region.h + 0.5:
                issues.append(Issue(
                    'error', 'TABLE_HEIGHT', index,
                    'the table exceeds its fixed card at the minimum body '
                    'size and row padding - shorten cells or split the table'))
        for row in _walk(root, []):
            classes = row.classes()
            if 'table-row' not in classes:
                continue
            head = 'table-head' in classes
            for cell in row.children:
                figure = 'num' in cell.classes() and not head
                for text in _walk(cell, []):
                    if text.kind != 'text' or not text.lines:
                        continue
                    # Typesetting glues a figure's digit groups, so a long
                    # one runs past its column rather than wrapping.
                    wide = widest_line(text) - text.w
                    if figure and (len(text.lines) > 1
                                   or wide > _OVERFLOW_ERROR):
                        issues.append(Issue(
                            'error', 'TABLE_WRAP', index,
                            'the figure "%s" does not fit its column on one '
                            'line - shorten it (round it, or move the unit '
                            'into the column heading)' % _snippet(text)))
                    over = (text.y + text.h) - (row.y + row.h)
                    if not head and max(over, row.y - text.y, wide) > _OVERFLOW_ERROR:
                        issues.append(Issue(
                            'error', 'TABLE_CELL_LONG', index,
                            'the cell \"%s\" runs past its bounds - shorten its '
                            'text or split the table' % _snippet(text)))
                    if head and over > _OVERFLOW_ERROR:
                        issues.append(Issue(
                            'error', 'TABLE_HEAD_LONG', index,
                            'the column heading "%s" takes %d lines and runs '
                            '%d px past the header row - a heading holds '
                            'one line; shorten it'
                            % (_snippet(text), len(text.lines), round(over))))
    return issues


def _check_headlines(document, sizes, skill_dir):
    """Headlines the ladder could not seat, even at its smallest step.

    What a headline has to clear - a chart's points, a timeline's row, the
    logo - is named per layout in `typography.json` `slide_layouts`, and the
    search already measured against it (`fit.headline_fits`). So its verdict
    is the report. For columns, the final measured boxes only add the exact
    gap or overlap to the message; they do not decide whether the title fits.
    Until 2.1 `build.py` turned the verdict into an issue itself, with
    the `chart-points` wording picked by slug; the layout's `remedy` in the
    same entry now says which text to cut.
    """
    issues = []
    conf_of = T.load(skill_dir).slide_layouts if sizes else {}
    roots = document.boxes() if sizes else ()
    for size in sizes:
        if size.headline is None or size.headline_fits:
            continue
        conf = conf_of.get(size.layout, {})
        remedy = conf.get('remedy', 'title')
        if size.layout.startswith('columns-'):
            root = roots[size.index - 1]
            heading = next((box for box in root.walk()
                            if box.kind == 'text' and 'slide-title' in box.classes()), None)
            panel = next((box for box in root.walk()
                          if 'columns-panel' in box.classes()), None)
            if heading is not None and panel is not None:
                gap = panel.y - (heading.y + heading.h)
                required = conf.get('clearance', 0)
                if gap < required - 0.5:
                    state = ('overlap %.1fpx' % -gap if gap < 0
                             else 'gap %.1fpx' % gap)
                    text = ('columns title at %dpx ends at y=%.1f; white panel '
                            'begins at y=%.1f (%s; need %.1fpx clearance) - '
                            'shorten the title or use another layout'
                            % (size.headline, heading.y + heading.h, panel.y,
                               state, required))
                    issues.append(Issue('error', 'OVERFLOW', size.index, text))
                    continue
        if remedy == 'points':
            # Points grow upwards from the bottom; a headline line cap does
            # not imply that the headline caused the overlap.
            text = ('the title and the points under it do not fit together '
                    'even with the title at %dpx - shorten the points (or '
                    'drop one) or the title' % size.headline)
        elif conf.get('max_lines') and size.layout != 'final':
            text = ('the title does not fit its %d-line region even at %dpx; '
                    'shorten the title or move details to another slide'
                    % (conf['max_lines'], size.headline))
        elif conf.get('max_lines'):
            text = ('the text takes more than %d lines even at %dpx; this '
                    'slide holds %d - shorten it to a short farewell '
                    '(«Спасибо за внимание», «Вопросы?»)'
                    % (conf['max_lines'], size.headline, conf['max_lines']))
        else:
            text = ('the title does not fit its place even at %dpx: it runs '
                    'off the slide or into what sits beside it (the logo, a '
                    'timeline row, a chart plate) - shorten it' % size.headline)
        issues.append(Issue('error', 'OVERFLOW', size.index, text))
    return issues


def _check_headline_density(document, sizes, skill_dir):
    """Warn when a geometrically safe headline is still too small or dense."""
    if not sizes:
        return []
    scale = T.load(skill_dir)
    issues = []
    for size, root in zip(sizes, document.boxes()):
        if not size.headline_fits or size.headline is None:
            continue  # The blocking OVERFLOW already tells the author to edit.
        conf = scale.slide_layouts.get(size.layout, {})
        role = conf.get('role')
        ladder = scale.slide_ladders.get(role, {})
        min_size = ladder.get('preferred_min_size')
        max_lines = ladder.get('preferred_max_lines')
        if min_size is None or max_lines is None:
            continue
        heading = next((box for box in root.walk()
                        if box.kind == 'text' and role in box.classes()), None)
        if heading is None:
            continue
        lines = len(heading.lines)
        if size.headline < min_size or lines > max_lines:
            issues.append(Issue(
                'warning', 'COLUMNS_TITLE_DENSE', size.index,
                'columns title uses %d lines at %dpx; shorten it to at most '
                '%d lines and rebuild before delivery' %
                (lines, size.headline, max_lines)))
    return issues


def _check_headline_orphans(document, layouts, skill_dir):
    """Flag a stranded connector left by the final measured headline."""
    scale = T.load(skill_dir)
    issues = []
    for index, root in enumerate(document.boxes(), 1):
        layout = layouts[index - 1] if index <= len(layouts) else ''
        role = scale.slide_layouts.get(layout, {}).get('role')
        if not role:
            continue
        for box in root.walk():
            if box.kind != 'text' or role not in box.classes():
                continue
            for line, label in headline_orphans(box):
                issues.append(Issue(
                    'warning', 'HEADLINE_ORPHAN', index,
                    'headline line %d contains only the connector "%s", '
                    'detached from its following phrase; rephrase the title '
                    'or use an explicit break that keeps the phrase together'
                    % (line, label)))
    return issues


def _font_size_of(box):
    raw = (box.style or {}).get('font-size')
    try:
        return float(str(raw).replace('px', '').strip())
    except (TypeError, ValueError):
        return 0.0


def _slide_issues(root, boxes, slide_index):
    """Text that overflowed the slide itself.

    Cards are checked separately, but the title, agenda items, phrase filling
    the whole slide, and metric captions lie outside cards — without this
    check they silently go off the bottom edge, and you only see it on the
    finished file.
    """
    issues = []
    bottom = root.y + root.h
    right = root.x + root.w
    for box in boxes:
        if box.kind != 'text' or not box.lines:
            continue

        # Metric value is set large and stands in a fixed-width column.
        # Wrapping to a second line shifts the caption down, and columns
        # stop aligning with each other — immediately noticeable on the slide.
        classes = box.classes()
        metric = classes & _METRIC_VALUES
        if metric and len(box.lines) > 1:
            issues.append(Issue(
                'error', 'METRIC_WRAP', slide_index,
                'metric value "%s" does not fit on one line - move the unit '
                'into the caption ("174" + "Выручка, млрд") or write the '
                'number more compactly' % _snippet(box)))
        elif metric and _metric_crowds(box, boxes, metric):
            issues.append(Issue(
                'error', 'METRIC_WRAP', slide_index,
                'metric value "%s" fills its column to the edge and reads as '
                'the start of the next metric - move the unit into the '
                'caption or write the number more compactly' % _snippet(box)))

        if _inside_card(box, boxes):
            continue

        # Same failure as the card check below, outside a card: the wrapper
        # breaks between words, so one word longer than the box paints straight
        # past its edge with nothing objecting — `image`/`chart` titles are the
        # sharpest case, a fixed 144px with no ladder underneath to shrink it.
        wide_line = widest_line(box) - box.w
        if wide_line > _OVERFLOW_ERROR and 'chart-title' in classes:
            # The plate's title has a fixed size; a legend row that crowds
            # it has already moved under it (autofit) - so the word that does
            # not fit is the author's to change, and the field is named.
            issues.append(Issue(
                'error', 'OVERFLOW', slide_index,
                'chart_title "%s" is %d px wider than its plate at %dpx - '
                'shorten it (the unit is enough: "млн ₽")'
                % (_snippet(box), round(wide_line),
                   round(box.font_size or 0))))
        elif wide_line > _OVERFLOW_ERROR:
            issues.append(Issue(
                'error', 'OVERFLOW', slide_index,
                'text "%s" is wider than its box: %d px over at %dpx. A '
                'single word does not fit and will print past the edge - '
                'shorten the word'
                % (_snippet(box), round(wide_line),
                   round(box.font_size or 0))))

        over = (box.y + box.h) - bottom
        if over > _OVERFLOW_ERROR:
            issues.append(Issue(
                'error', 'OVERFLOW', slide_index,
                'text "%s" does not fit the slide: %d px short in height. '
                'Shorten it or split the material across two slides'
                % (_snippet(box), round(over))))
        # The top edge, which nothing watched until v1.3. The title slide's
        # block is centred and grows in BOTH directions, so an oversized
        # subtitle pushes the headline off the top rather than off the bottom -
        # and the bottom is the only edge the check above looks at. A 1000
        # character subtitle measured as "fits" purely because the part that
        # did not fit had gone upwards, off-slide, where nobody was looking.
        above = root.y - box.y
        if above > _OVERFLOW_ERROR:
            issues.append(Issue(
                'error', 'OVERFLOW', slide_index,
                'text "%s" runs past the top edge of the slide by %d px. '
                'Shorten it or split the material across two slides'
                % (_snippet(box), round(above))))

        wide = (box.x + box.w) - right
        if wide > _OVERFLOW_ERROR:
            issues.append(Issue(
                'error', 'OVERFLOW', slide_index,
                'text "%s" runs past the right edge of the slide by %d px'
                % (_snippet(box), round(wide))))

        # Slide title stands above cards, and cards are positioned rigidly:
        # a long title does not push them apart, but lies on top. The VS
        # badge is the exception by design: it sits in the cards' notch,
        # inside their bounding boxes and outside their outlines.
        in_badge = any('versus-badge' in other.classes()
                       and _overlaps(box, other, slack=0.0) for other in boxes)
        for card in ([] if in_badge else boxes):
            if 'card' in card.classes() and _overlaps(box, card, slack=4.0):
                issues.append(Issue(
                    'error', 'COLLISION', slide_index,
                    'text "%s" runs into the cards - it is longer than the '
                    'layout allows' % _snippet(box)))
                break

        # The logo and the author line are the same kind of fixed obstacle,
        # but on slides without cards, and before v1.3 nobody checked them.
        # The title slide's heading block is centered and grows upward: a
        # four-line, 144px title landed right on the logo, and the file went
        # to the client without a single remark. autofit picks the size, so
        # what reaches here is only what even the lowest ladder step couldn't
        # rescue.
        for other in boxes:
            if other is box or not (other.classes() & _OBSTACLES):
                continue
            if _overlaps(box, other, slack=4.0):
                issues.append(Issue(
                    'error', 'COLLISION', slide_index,
                    'text "%s" runs into the %s - shorten it'
                    % (_snippet(box), 'logo' if 'logo' in other.classes()
                       else 'author line')))
                break
    return issues


_METRIC_VALUES = frozenset(('metric-value-large', 'metric-value-medium'))


def _metric_crowds(box, boxes, metric):
    """A one-line metric value that runs too close to the value on its right.

    Only a value with a neighbour to its right on the same row: the last
    column has the margin after it, and nothing to be read into.
    """
    neighbour = any(
        other is not box and other.classes() & metric and other.x > box.x
        and abs(other.y - box.y) < 1.0 for other in boxes)
    clearance = _METRIC_CLEARANCE_EM * (box.font_size or 0)
    return neighbour and widest_line(box) > box.w - clearance


def _inside_card(box, boxes):
    """Whether a box lies inside some card — those are checked separately."""
    for other in boxes:
        if not (other.classes() & FIT_CLASSES):
            continue
        if (other.x <= box.x and other.y <= box.y
                and box.x + box.w <= other.x + other.w + 1
                and box.y <= other.y + other.h):
            return True
    return False


def _run_label(run):
    return getattr(run, 'text', '\\(%s\\)' % getattr(run, 'latex', ''))


def _snippet(box, limit=32):
    # Runs and lines are joined with a space, and a run may already end in one,
    # so collapse the doubles: the snippet goes into an error message a person
    # reads. A formula is labelled by source without pretending it is prose.
    text = ' '.join(' '.join(_run_label(run) for line in box.lines
                             for run in line).split())
    return text[:limit] + ('…' if len(text) > limit else '')


def _fewer_of(layout):
    """What the reader can trade this layout for. None when nothing.

    The layout record says (`Layout.fewer`): the metrics header is the one
    measured box in the set whose type is fixed - 112px for the heading, one
    line, no ladder underneath it - so offering "a layout with fewer cards"
    there would be advice the build cannot take.
    """
    record = L.public_of(layout)
    if record is None or record.fewer is None:
        return None
    return 'a layout with fewer %s' % record.fewer


def _card_issues(card, slide_index, layout=''):
    """Issues for a single card: overflowed text and icon collision."""
    issues = []
    bottom = card.y + card.h
    icon = None
    texts = []

    for box in _walk(card, []):
        if box is card:
            continue
        if 'icon-container' in box.classes():
            icon = box
        elif box.kind == 'text' and box.lines and not (
                icon is not None and _inside(box, icon)):
            # A numbered card's digit is the badge's own text (2.4.0).
            texts.append(box)

    # A v1.4 column has no `.card-subtitle`, so the message falls back to the
    # column's own first line. Without it every report on those layouts would
    # say "?" and the reader would not know which column overflowed.
    title = _card_text(card, 'card-subtitle') or _card_text(card, 'point-title')
    if not title and texts:
        title = _snippet(texts[0], 24)
    label = (title or '?')[:24]

    # Horizontal overflow. Everything else in the build measures height only:
    # the size search compares `text.y + text.h` against the box, and so does
    # the report below. But the wrapper breaks between words, so a line can
    # still be wider than its box — when a single word does not fit — and that
    # word paints straight across the neighbouring column with nothing
    # objecting. A flow deck whose captions were one word each shipped with
    # every caption overlapping and "0 warnings" against it.
    for box in texts:
        over = widest_line(box) - box.w
        if over > _OVERFLOW_ERROR:
            issues.append(Issue(
                'error', 'OVERFLOW', slide_index,
                'text is wider than its column in "%s": %d px over at '
                '%dpx. A single word does not fit and will print across '
                'the neighbouring column — shorten the word%s'
                % (label, round(over), round(box.font_size or 0),
                   '' if _fewer_of(layout) is None
                   else ' or take ' + _fewer_of(layout))))

    fewer = _fewer_of(layout)
    holder = 'card' if 'card' in card.classes() else 'box'

    for box in texts:
        above = card.y - box.y
        if above > _OVERFLOW_ERROR:
            issues.append(Issue(
                'error', 'OVERFLOW', slide_index,
                'text in "%s" grows above its %s by %d px at %dpx; '
                'shorten it or split the material across other layouts'
                % (label, holder, round(above), round(box.font_size or 0))))
        elif above > _OVERFLOW_WARN:
            issues.append(Issue(
                'warning', 'OVERFLOW', slide_index,
                'text in "%s" grows above its %s by %d px; shorten it'
                % (label, holder, round(above))))
        over = (box.y + box.h) - bottom
        if over > _OVERFLOW_ERROR:
            # The size that reaches here has already been picked. If the text
            # still overflows the card, it means autofit walked the whole
            # ladder and stopped on the lowest step — saying "reduce the
            # size" is pointless, the size is already the minimum, and there
            # is only one fix left: shorter text or a different layout. That
            # is why the message states the size: it explains why the
            # suggestion is worded this way.
            if fewer is None and not layout.startswith('metrics-'):
                issues.append(Issue(
                    'error', 'OVERFLOW', slide_index,
                    'text does not fit the %s "%s": %d px over at %dpx; '
                    'shorten it or split the material across other layouts'
                    % (holder, label, round(over), round(box.font_size or 0))))
            elif fewer is None:
                issues.append(Issue(
                    'error', 'OVERFLOW', slide_index,
                    'text does not fit the space above the metrics: "%s" is '
                    '%d px too long at %dpx. Type on this layout is a fixed '
                    'size and the heading holds one line - shorten the text'
                    % (
                        label, round(over), round(box.font_size or 0))))
            else:
                issues.append(Issue(
                    'error', 'OVERFLOW', slide_index,
                    'text does not fit the %s "%s": %d px over at %dpx, the '
                    'smallest size this layout allows. Shorten it or take %s'
                    % (holder, label, round(over),
                       round(box.font_size or 0), fewer)))
        elif over > _OVERFLOW_WARN:
            issues.append(Issue(
                'warning', 'OVERFLOW', slide_index,
                'text in the %s "%s" reaches the very edge (%d px)'
                % (holder, label, round(over))))

        # autofit reserves the icon's band in advance, so an overlap is only
        # possible for text that didn't fit anyway. A second message about
        # the same card adds nothing — with eight per slide that would be
        # sixteen — so we only keep the overflow report. The check still acts
        # as a safety net: a spec assembled bypassing autofit, or a layout
        # without the reservation, will still get caught.
        if icon is not None and over <= _OVERFLOW_ERROR and _overlaps(box, icon):
            issues.append(Issue(
                'error', 'ICON_OVERLAP', slide_index,
                'text runs into the icon in the card "%s" - shorten the description'
                % label))
    return issues


def _card_text(card, class_name):
    for box in _walk(card, []):
        if class_name in box.classes() and box.lines:
            return ' '.join(_run_label(run) for line in box.lines for run in line).strip()
    return None


def _inside(a, b):
    return (b.x <= a.x and a.x + a.w <= b.x + b.w
            and b.y <= a.y and a.y + a.h <= b.y + b.h)


def _overlaps(a, b, slack=2.0):
    return not (a.x + a.w <= b.x + slack or b.x + b.w <= a.x + slack
                or a.y + a.h <= b.y + slack or b.y + b.h <= a.y + slack)
