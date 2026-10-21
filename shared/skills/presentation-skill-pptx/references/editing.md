# Editing a finished deck

The source of a presentation is its spec file, not the `.pptx`. Change the
spec, then rebuild the whole deck. That way editing one slide cannot damage
the others.

## Procedure

1. Find the spec — it sits next to the `.pptx` under the same name:
   `results.pptx` was built from `results.json`. If there is none, the deck was
   not built with this skill; move the content into a new spec by hand.
2. Read it and locate the slide by its `layout` and text.
3. Change field values. Leave the structure alone: each layout has a fixed set
   of fields, listed in `references/layouts.md`.
4. Rebuild: `python3 scripts/build_deck.py results.json`
5. Tell the user what changed, and pass on any warnings the build returned.

Never hand-edit the `.pptx`: the next rebuild overwrites it and the edit is
lost. The same goes for the intermediate `.html`.

A `*.plan.md` next to the spec records how the deck was arrived at before the
spec existed. It is not updated when a slide changes — leave it alone and edit
the JSON. Do not ask whether to agree a plan either: that question belongs to
the deck and was settled before it was built.

## Common requests

| Request | What to do |
|---|---|
| "Change the text on slide 3" | Edit the field in the third `slides` entry |
| "Add a slide about X" | Insert an object at the right position in `slides` |
| "Introduce the speaker" | When explicitly requested, add `self-intro` near the beginning with `name`, `role`, an identified local PNG/JPEG `src`, and 2–4 plain-text `items`; ask for the person's photo if missing |
| "Replace the speaker photo" | Change `self-intro.src` to the supplied person's photo; preview the centred cover crop |
| "Add another biography point" | Keep `self-intro.items` at 2–4 strings; shorten or move detail into notes if the bounded list overflows |
| "Drop that slide" | Remove the object from `slides` |
| "Swap these two" | Reorder the objects in `slides` |
| "Too much text here" | Shorten it, or split the slide in two |
| "Use a different icon" | Change `icon`, checking the word with `find_icon.py` |
| "Add one more card" | Verify the layout accepts that count first |
| "Emphasise this number on a card" | Replace that card's `title` with a string `value`, such as `"+38%"`; keep `title` on every other card. At most one card per slide may carry `value`, including numbered cards and `chart-cards` |
| "Move the focus figure to another card" | Replace the old card's `value` with `title`, then replace the new card's `title` with `value`; rebuild and preview |
| "Add a table row or column" | Keep `table` at 2–6 columns and 1–8 body rows; update `header` and every row together. Use `""` for an empty cell |
| "Emphasise table labels or totals" | Set `label_column: true` for the first column or `total_column: true` for the last; both change weight, not values |
| "Colour a table result by meaning" | Use `{"text": "+5", "tone": "positive"}` in a `table` cell, or `tone` on a `table-compare` row; `negative` is the other choice. Remove `tone` to restore ordinary text |
| "Compare two sets of figures" | Use `table-compare`: exactly two titled objects, each with 2–6 `label`/`value` rows; values are strings |
| "Make the timeline yellow" | Set `look` to `yellow`; it needs 4–5 points. Use `grey` for three points |
| "Alternate the flow captions" | Set `look` to `zigzag`; remove `summary`, or keep `line` if the summary is needed |
| "Emphasise the final flow step" | Set `highlight_last` to `true`; it works with either look and with a `line` summary. Set `false` to remove it |
| "Add a stage to the cycle" | Keep `circle.points` at 3–6 objects with `text` and `icon`, and exactly two `cards`; preview after changing the count |
| "Expand a cycle label" | Keep its `text` short; put detail in a right-hand card or another slide. Both cards and labels share the measured type ladder |
| "Replace this picture" | Change `src` on `image-points`, or the relevant `images[].src` on `image-gallery`; use a readable local PNG/JPEG and preview its cover crop |
| "Put conclusions beside this picture" | Use `image-points` with 1–5 objects containing `text` and `icon`; keep its default `plates`, or choose `plate` |
| "Show two or three pictures together" | Use `image-gallery`; every image needs `src`, `title`, `text` and `icon` |
| "Add a third picture" | Add one full image object to the gallery; the count selects the three-picture layout and all captions share its smaller ceiling |
| "Remove one gallery picture" | A gallery still needs two or three images; with one remaining, use `image-points` and write its conclusions |
| "Replace an app screen" | Change `screenshot-phone.images[].src`; preview the top-aligned cover crop |
| "Add a label to this phone" | Add a short `images[].caption`; its native arc and Medium caption appear together. Remove the field to remove both |
| "Show the whole screenshot" | Set `fit` to `contain`; white margins may appear. Omit it or set `cover` to fill the device frame |
| "Show a desktop interface" | Use `screenshot-monitor` with `src` and 1–4 `text`/`icon` points; its cover crop keeps the left edge |

Adding a card may force a layout change: `cards` takes at most four, `grid`
takes 4, 6 or 8, `complex` and `pyramid` take exactly five. The build says so
plainly, but choosing the layout up front is better.

Changing a `flow` from `line` to `zigzag` reduces each caption's room; preview
the changed slide and shorten captions if it reports `OVERFLOW`. `look` and
`highlight_last` are separate fields: a look change preserves the chosen
highlight. A `timeline` look change preserves the point text budget.

A card needs exactly one non-empty string `title` or `value`; do not add
`value` alongside its existing `title`. For example, change
`{"title": "Рост выручки", "text": "За год", "icon": "рост"}` to
`{"value": "+38%", "text": "Рост выручки за год", "icon": "рост"}`.
Regular cards keep their icon; numbered cards refuse it, and `chart-cards`
take no icon and require text. If the slide already has another card with
`value`, restore that card's ordinary `title` first. Zero value cards is valid.

The figure is twice the shared title size and follows the same measured fit
as the descriptions and lists. A value overflowing at the smallest step
needs shorter wording or its unit moved into `text`, for example `"value":
"174"`, `"text": "Выручка, млрд"`. Never put a formula in `value` or try to
set a separate font size.

Picture paths are relative to the command's current working directory, not
to the JSON file. Keep that directory stable when rebuilding or use absolute
paths. A path to a missing, unreadable or unsupported file fails the build;
changing the filename extension does not change the actual image format.
Do not remove an image's caption fields or icon to recover space. Shorten
captions or split the gallery, and preview after replacing an image or
changing the image count. Picture points and gallery captions do not accept
inline formulas. Legacy, wide-image and dense-text drafts stay unavailable;
use the public picture layouts for edits.

Table changes may alter wrapping and the shared body size. The white card
stays full height even for one row; its rows remain at the top. The fitter
tries body 30/28/26/24/20 px and vertical padding 24/18/12 px, while headers
stay 36 px. Do not add a font-size, padding or card-height field. Comparison
values remain 40 px; adding a sixth row tightens row spacing. Both layouts
accept plain text only, without lists, formulas, icons or pictures in cells.
Numeric columns align right automatically; shorten units or move them into
headers if figures stop fitting. Preview after changing row count or wording.

## If the user asks about grouped shapes in PowerPoint

A few things in the deck arrive as PowerPoint groups, because they are one
object the format cannot express as one shape: the glass panel on the title
slide (a shadow, the panel, an inner shadow), the rings in `columns`,
the numbered circles in `timeline`, the icon badges in `flow` and `circle`, and each bullet
with its marker. Gallery icon badges are groups too; their pictures and
captions remain separate editable objects. The closing background is one
picture. They are grouped so that moving one cannot leave a shadow
behind its panel or a hole outside its ring. To edit inside one, double-click
it; to take it apart, ungroup it — nothing in the build objects, and the next
rebuild restores it.

Cards, metrics and agenda items are *not* grouped: those are separate objects
and editing one alone is normal. This is not configurable from the spec.

## When the build reports an error

An error means no file is written, and it always names the slide.

| Code | Meaning | Fix |
|---|---|---|
| `OVERFLOW` | text does not fit the card or the slide — either past the bottom, or a single word wider than its column | shorten it or change layout |
| `TABLE_HEIGHT` | the white table exceeds its fixed card at the minimum body size and padding | shorten cells or split the table |
| `TABLE_WRAP` | a number or comparison value does not fit its column on one line | round it or move its unit into the heading or label |
| `TABLE_CELL_LONG` | a cell exceeds its row or column | shorten its text or split the table |
| `TABLE_HEAD_LONG` | a column heading exceeds the header row | shorten the heading |
| `COLLISION` | the heading runs into the cards | shorten the heading |
| `ICON_OVERLAP` | the description reaches the corner icon | shorten the description |
| `METRIC_WRAP` | a metric value did not fit on one line, or fills its column to the edge and runs into the next metric | move the unit into the caption: `"value": "174"`, `"text": "Выручка, млрд"` |
| `NOTE_SHORT` | the `note` beside a `chart-two` or `chart-wide` title takes one line; it is exactly two, about 45–80 characters | write it out, or drop `note` and `note_icon` |
| `STATEMENT_TOO_LONG` | a `statement` takes more than three lines (about 50 characters); with `look: cards`, more than two (about 25) | cut it to the claim, take `look: glass`, or make it a `cards` slide with the claim as its title |
| `VERSUS_SHORT` | a `versus` side's text takes fewer than three lines and the card stands empty | write it out to three to six lines (about 130–250 characters): what the option means in practice |
| `VERSUS_TOO_LONG` | a `versus` side's text takes more than six lines, its title more than three, or its subtitle more than two | cut the text to the difference that matters; shorten the title to the option's name |
| `VERSUS_SKEW` | the two `versus` texts differ by more than one line | even them out — shorten the long side or add to the short one |
| `STATEMENT_RUN` | two `statement` slides in a row, whatever their looks | merge them into one claim, or put the slide the first one introduces between them |
| `CHART_LABELS` | a chart's labels would run into each other in PowerPoint: a word of a category name wider than its column, or value labels crowded even at the smaller size | shorten the category or use `bar_h`; fewer categories or series, the full-width `chart` layout, or a `line` chart |
| `DUPLICATE_ICON` | the same icon twice on one slide (cards, steps, chart/image points, gallery images) | give each its own icon — an exact file name such as `check` bypasses the allocator, a concept does not |
| `EMOJI` | emoji or a forbidden separator (`·`, `•`, `∙`, `⋅`) in the text | remove it |

`OVERFLOW` already means the type has been made as small as this layout allows,
so "use a smaller font" is not a fix — the message states the size for that
reason. The word-too-wide form of it happens on the column layouts, where one
long word would otherwise print across its neighbour.

The one place `OVERFLOW` means something else is the `metrics` heading, and the
message says so: that heading is a fixed 112 px and holds one line, about 25
characters. It never had a size to give up, so the only fix is a shorter title —
move the rest into the `subtitle`, which has room for several lines.

Warnings do not stop the build, but show them to the user: no title or closing
slide, those slides out of position, the same icon on adjacent slides
(`SAME_ICON`), and one icon carrying too much of the deck (`REPEATED_ICON`).
Every icon counts toward both: cards, flow steps, circle points, chart/image points and
gallery badges alike. `LOW_RES_IMAGE` warns that a picture will be upscaled;
use a higher-resolution source. `IMAGE_ASPECT` warns about cover cropping;
preview and pre-crop the source if the subject or edges are lost. A
chart on the wrong width (`CHART_WIDTH`) is one too: more than 8 categories
beside the points belong on `chart-wide`, fewer than 6 on `chart`.

## Checking before you hand it over

Validate the spec without writing files:

```
python3 scripts/build_deck.py results.json --check
```

Look at the slides you changed:

```
python3 scripts/preview_deck.py results.json --slides 3,4
```

The previews are PNGs — open them with the image reader. This is the only way
to notice text that fits the box but still sits badly.
