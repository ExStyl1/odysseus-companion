# Extending the skill

Read this only when the template itself changes: designers added a layout,
adjusted a type size, shipped new icons. It is not needed to build decks.

## How it fits together

```
assets/layouts/template.html   source of truth: every physical layout in one document
assets/layouts/NN-slug.html    fragments cut from the template by a script
assets/layouts/layouts.json    registry: order, names, when to use each layout
assets/base.css                the single stylesheet
scripts/deckkit/layouts.py     what a layout is: fields, counts, variants
scripts/deckkit/elements.py    what an element is: card, metric, point, step,
                               column, summary, chart — fields, icons, formulas
scripts/deckkit/               library: spec, filling, checks, PPTX emission
scripts/deckkit/html2pptx/     CSS layout engine and PPTX writer
scripts/deckkit/html2pptx/document.py   an open deck: the tree, the engine,
                                        the laid-out slides
```

Run the commands below from the package root (the directory holding `SKILL.md`).
`python3 scripts/sync_layouts.py --check` reports the current physical layout
count. Fragment paths come from each entry's position and slug in
`assets/layouts/layouts.json`, exposed by `layouts.physical(skill_dir)`;
do not maintain a second filename list. Available spec names are the keys of
`layouts.PUBLIC` minus `layouts.DRAFT`: physical fragments also include draft
and helper frames, so their count is not the number of available spec names.

The deck is laid out **once**. `Document.open` parses the file and builds the
stylesheet, the font metrics and the layout engine; the size search, the
validator, the PPTX writer and the PNG preview all read its box trees. Nothing
downstream builds an engine of its own — if you find yourself writing
`Stylesheet.from_document` outside `document.py`, that is the sign you want a
`Document` instead.

Grid columns are bounded by `grid-template-columns` (one column if omitted).
A parsed column start/span extending beyond these tracks raises the engine's
`GridPlacementError`, a `ValueError` subclass, before layout. The engine does
not add implicit columns or clamp such placements, even with an explicit row;
automatic placement can still add rows. The preview CLI reports the offending
`grid-column` and explicit track count and exits 1.

Markup lives only in the template. The builder does not reproduce it, it fills
it: finds nodes by class, substitutes text, deletes surplus repeats. So editing
the template immediately changes every deck built afterwards, and there is
nothing for them to drift against — no second description of the markup exists.

That is exactly how this set once fell apart: template and fragments were
edited separately, filenames stopped matching contents, some layouts were
duplicated. Hence the rule: **edit the template, then run `sync_layouts.py`**.

## Changing an existing layout

1. Edit `assets/layouts/template.html`.
2. `python3 scripts/sync_layouts.py` — regenerate the fragments.
3. `python3 scripts/selftest.py` — confirm the builder still matches the markup
   node for node.
4. `python3 scripts/preview_deck.py assets/layouts/template.html` — look at it.

If the self-check reports a fingerprint mismatch, the number or order of the
nodes the builder fills has changed; update the filler in
`scripts/deckkit/slides.py`.

## Adding a layout

1. Add the slide to `template.html` with a marker comment in the same form as
   its neighbours: the layout name and a run of equals signs.
2. Add an entry to `assets/layouts/layouts.json` at the same position as in the
   template — registry order must match slide order.
3. Register the physical slug in `scripts/deckkit/layouts.py` **before running
   sync**. Sync refuses `template slides no layout record can fill` when a
   registry slug is absent from `layouts.known_slugs()`; it writes no fragments
   in that case. For a new public layout, add a record. One entry carries what used to
   be spread over five files: the public name a spec may use, its fields, the
   countable element, the count → physical variant table, the filler and
   `kinds` — which element kind each list field holds. The spec check, the
   icons (allocation and the repeat warnings), the fields that take formulas
   and the shape the filler receives all follow from `kinds`. A layout whose
   elements are cards, points or steps needs nothing more; a genuinely new
   element is one `Kind` in `scripts/deckkit/elements.py` (fields, cross-field
   rule, icon fields, formula fields, normalised shape). A new *variant* of a
   layout that already exists — a seventh column, a ninth card — is one line in
   that record's `variants` and changes nothing else in Python.
4. Add the filler to `scripts/deckkit/slides.py` (`BY_NAME`), unless one of the
   existing ones fits: several physical layouts share `cards` under different
   geometry. If the layout should also be reachable from the builder API, add a
   method to `scripts/deckkit/deck.py` — one line over `Deck.add`.
5. Add the slug to `assets/typography.json`: a `layouts` entry if it carries
   card-like text (tier, card box, ceiling), a `slide_layouts` entry if it
   carries a headline (role, clearance), or an `unfitted` entry with the
   reason it has no ladder. `typography.load` refuses a file that leaves a
   physical layout out of all three, or names one that does not exist — every
   build stops with `TypographyError` naming the slug. Until 2.1 a slug in no
   table was built with no size search and nothing warned.
   If its text does not fit at the smallest step, the OVERFLOW advice offers
   "a layout with fewer cards"; set `fewer='columns'` on the record for a
   column layout, `fewer=None` where the type is fixed.
6. `python3 scripts/sync_layouts.py` — regenerate after registration. The
   fragment path follows from the registry position and slug (`NN-slug.html`);
   the builder derives it from there too.
7. Describe an available layout in `references/layouts.md`: when to use it,
   fields and measured text limits. A prototype keeps `status='draft'` on its
   record until approved; do not advertise it as an available spec layout.
8. Run `python3 scripts/sync_layouts.py --check` and
   `python3 scripts/selftest.py` — they verify that template, registry, code and
   documentation agree. Build a representative spec and inspect its PNGs;
   when PowerPoint is available, inspect an export of a scratch copy as well.

## Type sizes and colours

Values are written directly in `base.css`; the project uses no CSS variables.

| Class | Size | Weight | Used for |
|---|---|---|---|
| `.title-xlarge` | 168px | 700 | closing slide |
| `.title-large` | 144px | 700 | title slide, large centred statement |
| `.title-slide` | 112px | 700 | heading on the metrics slide |
| `.title-agenda` | 112px | 700 | agenda heading |
| `.slide-title` | 88px | 700 | heading above the cards |
| `.agenda-number` | 72px | 500 | agenda item numbers |
| `.subtitle-medium` | 48px | 500 | subheading on the metrics slide |
| `.subtitle-large` | 40px | 400 | title slide subheading |
| `.text-author` | 40px | 400 | author on the title slide |
| `.subtitle-small` | 32px | 400 | secondary text on dark backgrounds |
| `.agenda-description` | 32px | 400 | agenda item text |
| `.bullet-text` | 28px | 400 | list item |
| `.metric-value-large` | 192px | 500 | large metric value |
| `.metric-value-medium` | 136px | 500 | metric value in a grid |
| `.metric-description` | 40px | 400 | metric caption |
| `.metric-description-small` | 32px | 400 | caption in a grid |

`.card-subtitle` and `.card-description` set family, weight and colour but
**not size**: that is inline in each layout, because it depends on card size —
48px and 24px in wide cards, 32px and 24px in dense grids.

Palette: `#FFDD2D` yellow, `#FDBD24` the lower stop of the yellow gradient,
`#EDEDED → #E2E1E1` the grey card gradient, `#333333` body text, `#898989`
secondary, `#FFFFFF` background and text on dark. The dark background of the
metrics slides comes from the `.background-black` class — an image with a
highlight, not a flat fill.

The colour *gallery* PowerPoint shows the reader is a different thing and
lives in `assets/theme-colors.json`: twelve OOXML theme slots, written into
every `ppt/theme/*.xml` of the finished file by
`deckkit/html2pptx/theme.py`. Nothing on a slide reads it — shapes are painted
with the direct values above, and no `schemeClr` reference exists in the code
— so editing it changes the dropdown and the objects a reader draws by hand,
never the deck. The brand yellow is `#FFDD2D` in both. The file explains
which slot is which; PowerPoint's first row is not in schema order.

Weight 500 (Medium) reaches PPTX through the **typeface name**, not a bold
flag: the format has no numeric font weight. Take the name from the font's
`name` table, Windows record; the Macintosh record loses the style.

Paths inside CSS `url()` resolve relative to the CSS file, not to the HTML that
links it. The asset resolver is given the stylesheet directories for exactly
this reason — without them the agenda and dark backgrounds are not found.

`box-shadow` is baked into PNG overlays by `html2pptx/boxdeco.py`, not mapped to
the native PPTX effects, and both sides — `inset` and outer — go through it. The
native effects are wrong on a translucent fill, which is exactly what the glass
panel has: `a:innerShdw` is computed from the shape's alpha, so the glow would
fade out together with the 20% fill; `a:outerShdw` paints the shape's full
blurred silhouette behind it, and through a translucent fill that silhouette
shows through and muddies the panel. CSS does neither — an inset shadow ignores
the background's alpha, and an outer one is clipped to the border box. Keep new
shadows in `base.css` and they will work; do not reach for the native effects.
The build makes one exception itself: a single `inset 0 0 <blur>` on an opaque
fill (the cards' glow) is written as the shape's own `a:innerShdw`, since there
the alpha objection does not apply and the effect follows the card when the
user resizes it.

A box that is not a rectangle takes `clip-path: path("…")`, the path in px
of the box itself (`M L H V C Q Z`, absolute or relative; an arc refuses).
The build writes it as the shape's `a:custGeom`, curves as curves, and
fills and shadows it in the preview by the same outline - the versus cards'
notch is one. `border-radius` is then ignored: round the corners in the path.
An outline that has to follow the box's size takes `clip-path: shape(…)`
instead (CSS Shapes 2: `from`, `line`/`hline`/`vline`/`curve` with `to` or
`by`, `with` one or two control points, `close`); a coordinate is px, % of
the box or a `calc()` of the two, so `calc(100% - 58px)` holds to the right
edge. Arcs and `smooth` refuse. The numbered cards' notch is one.

A new SVG asset with a blur filter is fine: `svgraster.py` blurs the
**premultiplied** layer, so a translucent halo keeps the shape's colour instead
of sliding to black. That mattered for `black-pattern.svg`, whose grey highlights
are blurred ellipses under `mix-blend-mode: plus-lighter` — blurring the colour
channels apart from alpha turned them into dark smears and the dark slides came
out flat black. Ignored in filters: `feFlood` and `feBlend`, which Figma emits as
a no-op preamble, and the filter region — layers are viewport-sized and the blur
replicates edge pixels.

Not implemented: `backdrop-filter`. The final layout asks for `blur(18px)`
under the panel, which needs the already-painted backdrop — the writer emits
shapes and has no canvas to read back. The pattern underneath is a soft
gradient, so the loss is barely visible; implementing it would mean flattening
the backdrop into the panel picture.

## Text limits

The numbers in `references/layouts.md` are measured, not estimated. After
changing type sizes or card dimensions they must be re-measured: search for the
length at which `build(strict=False)` starts reporting `OVERFLOW`.

## Icons

`assets/icons/icons.zip` plus an `INDEX.json` with `file`, `category` and
`keywords`. The icons are packed rather than loose because the marketplace caps
a skill at 200 files and 355 loose icons blew straight past it; the build reads
single members out of the archive, so nothing has to be unpacked first.
`selftest.py` counts the package against that cap, so unpacking the archive and
forgetting to repack fails a check here instead of a publication later.

A new icon needs both an archive member and an index entry, and the two are
checked against each other in both directions by `selftest.py` — an unindexed
member cannot be found by meaning, which makes it dead weight. Round trip:

```
python3 scripts/pack_icons.py --unpack /tmp/icons
# add or replace PNGs there, update INDEX.json to match
python3 scripts/pack_icons.py --pack /tmp/icons
python3 scripts/pack_icons.py --check
```

Keyword order matters: the first one states what the icon is, and it carries the
most weight in search. Without that, a query for «молния» loses to a battery
with a lightning bolt. Search folds «ё» to «е», so both spellings work.

## What is planned next

An `.xlsx` reader for `chart`'s `data` field, alongside the CSV reader
`deckkit/chartdata.py` already has. Bounded scope: one sheet, one header row,
the same `x`/`y` column-name contract as CSV — not a general spreadsheet
importer.

## Environment limits

There is no layout engine on hand, so results cannot be compared against a
browser. Visual checking goes through `preview_deck.py`, which draws the same
layout that reaches PPTX. That verifies layout and rendering agree with each
other, not that they agree with a browser.
