# Layouts and spec format

The spec is a JSON file: an object with an optional `title` and a required
`slides` list. Each slide is an object with a `layout` field plus that layout's
fields. There are no other fields — an unknown one stops the build and lists
what is allowed.

Slide text is written in Russian; the field names are not.

```json
{
  "title": "Итоги квартала",
  "slides": [
    {"layout": "title", "text": "Заголовок", "subtitle": "Итоги квартала"},
    {"layout": "cards", "title": "Что сделали", "cards": [
      {"title": "Меньше полей", "text": "Убрали шесть шагов", "icon": "список"}
    ]},
    {"layout": "final"}
  ]
}
```

A full seven-slide example: `assets/example-deck.json`.

## Choosing a layout

| What you need to show | Layout |
|---|---|
| First slide of the deck | `title` |
| The plan of the talk | `agenda` |
| Introduce a person, when explicitly requested | `self-intro` |
| Fixed yellow collage with titled icon takeaways | `illustration-points` |
| Several points of equal weight | `cards` |
| One focus figure beside supporting points | `cards`/`grid`/`complex`/`pyramid`, one card with `value` |
| Many similar items | `grid` |
| Steps or stages in their order, no icons | `cards`/`grid` + `"numbered": true` |
| A list as the whole slide | `cards` with one card + `items` |
| A list inside a card | `cards`/`grid`/`complex`/`pyramid` + `items` |
| Four observations and the conclusion from them | `complex` |
| Three specifics and two consequences | `pyramid` |
| One sentence worth pausing on | `statement` |
| Two options against each other: before/after, ours/theirs | `versus` |
| Numbers and how they moved | `metrics` |
| Exact values in rows and columns | `table` |
| Two sets of short label/value pairs side by side | `table-compare` |
| Stages of a process over time | `timeline` |
| A sequence of steps, each with an icon | `flow` |
| A cycle with short icon labels and two takeaways | `circle` |
| Several detailed points side by side, on a dark slide | `columns` |
| One picture with conclusions beside it | `image-points` |
| Two or three pictures, each with its own caption and icon | `image-gallery` |
| One to three app screens inside phone frames | `screenshot-phone` |
| A desktop interface with observations beside it | `screenshot-monitor` |
| Numbers over time or across categories, as a chart | `chart` |
| A long series — 6 categories or more, twelve months — across the slide | `chart-wide` |
| Closing slide | `final` |

**Lists:** a general-purpose list is `items` on a card. Take `cards` (1–4 cards),
`grid` (4/6/8 cards), `complex` (4+1) or `pyramid` (3+2); a single-card
`cards` gives a full-width grey list slide, which is how a list that is the
whole slide is written.

**Vary the layout with the material.** Four or more slides of the same layout in
a row — whatever the card count — raise a `REPEATED_LAYOUT` warning: a run
that long reads as one slide shown again. Check the slide list in the plan,
where it costs a line: four single-card lists are often one `grid` or
`complex`, a sequence is a `timeline` or `flow`, numbers are `metrics` or a
chart. For charts the chart type counts too, so a bar chart after a line chart
is not a repeat.

Minimum deck: `title`, `agenda`, content slides, `final`. If nothing fits
exactly, take the closest layout by structure — there are no other layouts and
inventing one is not possible.

Photos with EXIF rotation or mirroring are oriented automatically before fitting.
The original file stays unchanged.

## Fields per layout

| Layout | Required | Optional | Count |
|---|---|---|---|
| `title` | `text` | `subtitle`, `author` | at most 2 headline lines |
| `agenda` | `title`, `items` | — | 2–6 items |
| `illustration-points` | `title`, `points` | — | 2–4 objects with required `title`, `text`, `icon` |
| `self-intro` | `name`, `role`, `src`, `items` | — | 2–4 plain-text items; identified local PNG/JPEG portrait |
| `cards` | `title`, `cards` | `numbered` | 1–4 cards; numbered 2–4 |
| `grid` | `title`, `cards` | `numbered` | 4, 6 or 8 cards |
| `complex` | `title`, `cards` | — | exactly 5 cards; first four left, fifth is the yellow conclusion |
| `pyramid` | `title`, `cards` | — | exactly 5 cards |
| `statement` | `text` | `look`: `glass` (default), `cards` | — |
| `versus` | `sides` | — | exactly 2 sides; see below |
| `metrics` | `title`, `metrics` | `subtitle` | 2–6 metrics |
| `table` | `title`, `header`, `rows` | `label_column`, `total_column` | 2–6 columns; 1–8 body rows |
| `table-compare` | `title`, `tables` | — | exactly 2 titled objects; 2–6 label/value rows each |
| `timeline` | `title`, `points` | `look`: `grey` (default), `yellow` | 3–5 points; `yellow` 4–5 |
| `flow` | `title`, `steps` | `summary`, `look`: `line` (default), `zigzag`; `highlight_last` | 4–5 steps; `summary` only with `line` |
| `circle` | `title`, `points`, `cards` | — | 3–6 points with required `text`, `icon`; exactly 2 regular icon cards |
| `columns` | `title`, `columns` | — | 3–6 columns |
| `image-points` | `title`, `src`, `points` | `look`: `plates` (default), `plate`; `fit`: `cover` (default), `contain` | 1–5 points; each needs `text` and `icon` |
| `image-gallery` | `title`, `images` | — | exactly 2 or 3 images; each needs `src`, `title`, `text` and `icon` |
| `screenshot-phone` | `title`, `text`, `images` | `fit`: `cover` (default), `contain` | 1–3 objects with required `src`, optional non-empty `caption` |
| `screenshot-monitor` | `title`, `src`, `points` | `fit`: `cover` (default), `contain` | 1–4 points with required `text`, `icon` |
| `chart` | `title`, `data`, `chart_type`, `points` | `chart_title`, `x`, `y`, `mode`, `center`, `value_labels`, `number_format`, `look` | 1–5 points; `look`: `plate` (default), `plates`; see below |
| `chart-cards` | `title`, `data`, `chart_type`, `cards` | `x`, `y`, `mode`, `center`, `value_labels`, `number_format` | 3 cards; no `chart_title` — the slide title names the chart; see below |
| `chart-two` | `title`, `charts` | `note_icon`, `note` | exactly 2 charts, each with its `chart_title`; see below |
| `chart-wide` | `title`, `data`, `chart_type` | `note_icon`, `note`, `chart_title`, `x`, `y`, `mode`, `value_labels`, `number_format` | one chart; see below |
| `final` | — | `text` | — |

The `agenda` list is anchored to the bottom of the slide, not the top: the
last item always sits on the same level whatever the count (2–6), so a short
agenda does not float up and leave a gap below — a two-item agenda sits as low
as the last row of a six-item one.

For `complex`, write `cards` in logical order: the first two fill the upper
left cells, the next two fill the lower left cells, and the fifth fills the
tall yellow card on the right. Use the fifth card for the conclusion from
the four observations. Keep that order when editing or rebuilding a spec;
the layout places each card's complete content, including its icon and list.

Card: `{"title": "…", "text": "…", "icon": "…", "items": [...]}` or
`{"value": "+38%", "text": "…", "icon": "…", "items": [...]}` — exactly
one non-empty string `title` or `value` is required, and `icon` is required.
On a numbered slide (below) a card takes no `icon`. **At most one card per
slide may carry `value`**; zero is allowed. The same limit applies to
`chart-cards`, whose cards require `text` and take no `icon`.
Metric: `{"value": "+38%", "text": "Конверсия"}` — only `value` is required.
Point: `{"text": "…", "title": "…"}` — `text` is required, `title` is optional.
Every point in a `timeline` must carry a `title`, or none of them may — a row
where only some do sets their descriptions one line lower than the rest, and
the mismatch reads as a mistake rather than a choice.
Side (`versus`): `{"title": "…", "subtitle": "…", "text": "…"}` — `title` and
`text` are required. The first side is the yellow card on the left, the
second the grey one on the right; the slide has no title of its own and no
icons. A `subtitle` goes on both sides or on neither. The title hangs from
the top of its card and the subtitle and text stand on the bottom, so the
last line of both sides sits at one height whatever the length.
Step: `{"icon": "…", "text": "…"}` — both are required.
Column: `{"title": "…", "text": "…"}` — both are required.
Summary: `{"title": "…", "text": "…"}` — a single object, not a list; both are
required. Adding it to a `flow` with `look: line` selects the physical layout with the
shorter caption box (130px instead of 258px), so the step captions get less
room in exchange for the closing line.

`timeline.look` is `grey` by default: white numbered circles on the original
background, for 3–5 points. `yellow` keeps the white circles on the designers'
yellow background, with a gradient headline, for 4–5 points only; three
points with this look are an error.
Point fields and text capacity stay the same for both looks.

`flow.look` is `line` by default: icons and captions in one horizontal row.
`zigzag` alternates the captions above and below the icon row, starting above,
and has a smaller caption box (210px). Both looks take 4–5 steps. A `zigzag`
with `summary` is an error: remove the summary or choose `line`.
`highlight_last` takes a boolean and defaults to `false`. Set it to `true`
to make the final icon badge yellow and fade its incoming connector toward
yellow. It works independently of `look`, including `line` with a summary;
changing the look alone does not highlight the final step.

```json
{"layout": "timeline", "title": "План запуска", "look": "yellow",
 "points": [{"text": "Подготовка"}, {"text": "Пилот"},
            {"text": "Проверка"}, {"text": "Запуск"}]}
```

```json
{"layout": "flow", "title": "Путь заявки", "look": "zigzag",
 "highlight_last": true,
 "steps": [{"icon": "список", "text": "Заполнить заявку"},
           {"icon": "безопасность", "text": "Проверить данные"},
           {"icon": "решение", "text": "Принять решение"},
           {"icon": "деньги", "text": "Выдать кредит"}]}
```

`title` without an `author` centres its block in the room under the logo
rather than on the slide, and the logo comes down a little with it, so the
slide does not read as top-heavy. The `final` text keeps its last line where
«за внимание» stands and grows upward toward the logo: one line, two or
three end at the same height. It holds **three lines at most**: a fourth
steps the size down, and a text that still takes four at the smallest step
is an error. The slide stands on the designers' picture - the glass panel
over a glass heart - and its letters fade from dark grey into orange toward
the end of the last line. Keep it a short farewell - «Спасибо за внимание», «Вопросы?»,
«Спасибо за внимание! Вопросы?».

### Pictures

`image-points` puts one picture on the right and one to five conclusions on
the left, with a short slide title above them. Every point is an object with
exactly `text` and `icon`, both non-empty strings; it has no `title`, `items`
or `value`. The points end at the same bottom line and grow upward as text is
added. Their text is fixed at 28 px with 140% leading; the slide title steps
from 72 to 48 px, with three lines at most. A long point or title is
`OVERFLOW`; shorten the conclusions or divide the material across slides.

`look: "plates"` is the default: the tall picture frame rests on two
translucent plates. `"plate"` uses one frame. These are the only picture-frame
looks; stepped and tilted alternatives are not offered. The chart's own
`look` is independent and keeps `plate` as its default.

`image-gallery` puts two or three pictures side by side on a white slide.
Every image object requires `src`, `title`, `text` and `icon`, all non-empty
strings. Gallery pictures always use cover; `fit` is refused both on the
slide and on individual items, including an explicit `"cover"`. Each picture
has a rounded corner cutout for its yellow icon badge; its title and description sit below it. The image count selects
the physical layout. A gallery has no `look`, `note`, `items` or `value` field.

Choose fit as an authoring decision, based on the visual content:

- **Photographs:** prefer image-points with cover. It usually presents photos
  better by filling the frame. Check that the crop keeps faces and the main
  subject; select another source or prepare a crop if needed. Contain is an
  explicit exception when the whole photograph must remain visible.
- **Diagrams, maps, screenshots of charts, and other labeled graphics:** prefer
  image-points with contain when cropping would remove labels, axes, nodes or
  other information. Use a native chart layout when source data is available.
  Cover remains possible for a graphic whose crop is intentional and safe.
- **Galleries:** use photographs or simple illustrations that tolerate cover
  and the badge cutout. Information-heavy diagrams belong on image-points or
  a native chart slide instead. Gallery contain is unavailable.

The builder never infers image semantics or switches fit automatically. An
omitted image-points fit remains cover for compatibility; the authoring agent
must set contain when preservation is needed and inspect the resulting crop.

The gallery captions share the card title/body ladder across the whole slide:
two pictures start at 44/30 px, three at 40/28 px, and both stop at 32/20 px.
One long caption steps every caption down together. The slide title has its
own 96/88/80/72 px ladder and holds two lines at most. Caption titles consume
the same measured box as their descriptions; they are not an extra budget.

The following slide objects illustrate the schema; replace their source
paths with the user's files before building:

```json
[
  {"layout": "image-points", "title": "Пилот упростил работу команды",
   "src": "materials/team.png", "fit": "cover", "points": [
     {"text": "Обсудили обратную связь участников", "icon": "команда"},
     {"text": "Согласовали следующий этап", "icon": "решение"}]},
  {"layout": "image-gallery", "title": "Два этапа пилота", "images": [
    {"src": "materials/workshop.png", "title": "Подготовка",
     "text": "Команда проверила сценарии", "icon": "список"},
    {"src": "materials/pilot.jpg", "title": "Запуск",
     "text": "Участники опробовали новый процесс", "icon": "рост"}]}
]
```

`src` is a local PNG or JPEG path, checked for existence, readability and
actual file format. URLs, PDFs and other image formats are not supported.
Relative paths resolve from the caller's current working directory, not from
the spec's directory; validated paths are stored as absolute paths during
the build. The original image bytes remain embedded in the PPTX, including
PNG transparency. On `image-points`, `fit: "cover"` is the default and fills
the frame with centred cropping, without stretching. `fit: "contain"` centres the whole
source within a safe rectangle inside the frame: its size respects the
rounded corners, so even source corner content is retained. This can leave
empty white margins. `fit` is configurable only on the `image-points` slide.
Gallery pictures always fill their curved frames with cover.
Their rounded outline and gallery corner cutout are
native, editable PowerPoint picture geometry, rather than baked into a
replacement bitmap.

`LOW_RES_IMAGE` warns when fitting requires source upscaling; it uses the
actual uniform display scale (including the larger pre-crop size for cover).
`IMAGE_CROP` warns when cover plus the frame mask removes more than 25% of
source area. It reports rectangular crop, fractions removed from each source
edge, and the additional mask loss separately. Even an equal-aspect cover
image can lose content at rounded corners or the badge cutout.
`IMAGE_LETTERBOX` warns when more than 25% of the visible mask area is left
empty under contain, including mask-safe sizing. These are advisory warnings;
the build proceeds. On image-points, choose contain when the complete
image matters, or prepare a crop with the desired composition. For a gallery
use a source composed for the frame, or move information-heavy content to
image-points with contain. The spec cannot
set arbitrary crop coordinates, corner radius, background, font size or badge
position. Screenshots and legacy draft pictures retain `IMAGE_ASPECT` for
aspect mismatches; their separate fit/alignment rules are unchanged.

Both layouts use the same mandatory icon lookup and allocation as cards:
give a business meaning, not a file path. Picture points and gallery captions
accept plain text only, including their titles; inline formulas are refused.
Speaker `notes` remain available on the slide.

For Python callers, use `Deck.image_points(title, src, points, look='plates',
fit='contain')`
or `Deck.image_gallery(title, images)` with the same element objects as above.
They follow the same count, field, icon and file checks as
the JSON spec. The old `Deck.image(...)` method remains for internal draft
compatibility; the legacy `image` layout is not public. Wide-image and
dense-text drafts remain outside ordinary specs. Use `chart-wide` for a
full-width analytical chart and split picture content across accepted layouts.

Measured picture-text examples use the short slide title «Заголовок слайда»
and equal prefixes of the repeated phrase «обслуживание клиентов и партнёров
банка в едином окне ». A gallery also keeps «Подзаголовок карточки» as every
caption title. Word lengths, line breaks and a different slide title can
reduce these numbers; they are measurements, not universal allowances.

| Layout | Text per point or picture, characters within the design fit |
|---|---|
| `image-points`, 1 point, either look | 685 |
| `image-points`, 2 points, either look | 329 |
| `image-points`, 5 points, either look | 105 |
| `image-gallery`, 2 pictures, fixed caption titles | 367 |
| `image-gallery`, 3 pictures, fixed caption titles | 224 |

For the picture points, the next character at each listed boundary reports
`OVERFLOW`: the fixed-size points have grown too close to the title. The
gallery figures describe the stricter design fit inside the 190 px caption
box. They are not the validator's defect threshold: slight excess can remain
below its reporting tolerance. In the same probe, 368/225 characters first
exceed the design fit, while 462/279 first report `OVERFLOW`. Stay within the
design figures and preview, rather than treating the larger error threshold
as an available text budget. Longer caption titles reduce the description's
room further.

### Person introduction

Use `self-intro` only when the user explicitly asks to introduce a speaker
or another person. Put it near the beginning, before or after the agenda;
there is no mandatory position. Required fields are non-empty plain-text
`name` and `role`, a local PNG/JPEG `src`, and **2–4** non-empty plain-text
strings in `items`. Optional `notes` work as on other slides. One item is
too sparse; five are refused before the portrait is loaded. This layout has
no `title`, icons, formulas, `look`, `fit` or font-size override.

Use the identified person's photo from the user's materials. If no suitable
photo is supplied, ask for it. Do not create a generated substitute for a
real person's missing portrait. Preserve the name, role and biography from
the materials rather than inventing credentials.

```json
{"slides": [
  {"layout": "self-intro", "name": "Анна Миронова", "role": "Руководитель аналитики",
   "src": "materials/speaker.png", "items": [
     "Развивает продуктовую аналитику", "Помогает командам проверять гипотезы"]}
]}
```

The name uses solid dark T-Sans Bold at 128/112/96px (96/84/72pt), with two
lines at most. The role stays at 44px (33pt), Regular, on one line. The
triangle list shares a 36/32px (27/24pt) Regular ladder, 110% leading and
27.2px gaps. Its lower baseline stays at 899.051px: additional or wrapped
items grow upward within the bounded region starting at 530px. A longer
item steps every item down together. The name has its own ladder.

The square portrait uses centred cover cropping inside a rounded front
plate; native picture geometry preserves the original PNG/JPEG bytes,
including alpha. Relative `src` paths resolve from the command's working
directory. Unsupported or unreadable images stop the build. `LOW_RES_IMAGE`
and `IMAGE_ASPECT` warn about softness or substantial cropping; preview the
subject and use a better-composed source when needed. The two translucent
rear plates and gradient background are fixed.

Python callers use `Deck.self_intro(name, role, src, items, notes=None)` or
`Deck.add('self-intro', data, notes=None)`, with the same field, count and
resource checks as the JSON spec.

Measured budgets below use prefixes of repeated «обслуживание клиентов и
партнёров банка в едином окне ». The list uses equal text in every item;
other fields stay short while one region is measured. These are design-fit
boundaries for that phrase, not general character allowances. Names, words
and authored line breaks change the result; fitting measures the actual text.

| Region | Characters within the design fit | Lines / size |
|---|---:|---|
| 2 items, per item | 168 | 4 / 32px |
| 3 items, per item | 86 | 2 / 32px |
| 4 items, per item | 86 | 2 / 32px |
| Name | 27 | 2 / 96px |
| Role | 35 | 1 / 44px |

The next character reports `OVERFLOW` in these prose probes except the
three-item list: 87 characters per item first exceed the design fit with a
small excess warning, while 124 first report an error. Stay within
the 86-character design budget, rather than treating validator tolerance as
available space. Unbroken-word probes of repeated «Ж» fit 26 in every list,
7 in the name and 20 in the role; the next character reports `OVERFLOW`.
Shorten overflowing fields or move supporting detail into speaker notes;
the font ladder stops at its legal floor.

### Device screenshots

`screenshot-phone` requires `title`, a plain-text `text` block and one to
three `images`. Each image contains a non-empty local PNG/JPEG `src` and
optionally a non-empty plain-text `caption`. A caption enables its native
editable arc and arrowhead; leaving it out removes both. Captions use T-Sans
Medium at 36px (27pt), and their boxes sit at the plain ends of the arcs.
The one-phone callout sits in the upper-right with its arrow pointing down.
The headline steps through 96/88/80/72px (72/66/60/54pt), at most three
lines. The copy starts at the top and stays at 32px on one phone or 36px
on two/three phones. Unsupported fields and counts are errors.

`screenshot-monitor` requires `title`, `src` and one to four `points`, each
containing non-empty `text` and `icon`. Its headline uses the same ladder;
the top-aligned point text stays at 28px (21pt). Neither screenshot layout
accepts formulas in its copy, points or captions.

```json
{"slides": [
  {"layout": "screenshot-phone", "title": "Два экрана для сравнения",
   "text": "Проверяем новый сценарий оформления",
   "images": [{"src": "before.png", "caption": "Первый вариант"},
              {"src": "after.png", "caption": "Второй вариант"}]},
  {"layout": "screenshot-monitor", "title": "Все заявки в одном окне",
   "src": "desktop.png", "points": [
     {"text": "Команда видит статус каждой заявки", "icon": "команда"}]}
]}
```

Both accept `fit: "cover"` (default) or `"contain"`. Cover preserves
proportions and fills the aperture: phones keep the top, monitors keep the
left edge. The second phone is cropped at the slide bottom without changing
its scale. Contain centres the whole source with white margins where needed.
Original source bytes and alpha remain in native PowerPoint pictures, and
corners follow the device aperture. Preview each result; `IMAGE_ASPECT`
describes substantial cropping or letterboxing and `LOW_RES_IMAGE` warns
about a source too small for its displayed size. Relative paths resolve from
the command's working directory. Use a larger or pre-cropped source when the
important interface content would be lost.

Python callers use `Deck.screenshot_phone(title, text, images, fit=None,
notes=None)` and `Deck.screenshot_monitor(title, src, points, fit=None,
notes=None)` with the same JSON-shaped objects and validation as specs.
Keep captions short. If text reports `OVERFLOW`, shorten it or split the
slide; an unavoidable headline connector on its own line raises
`HEADLINE_ORPHAN`. There is no font-size override.

Measured text budgets below use prefixes of repeated «обслуживание клиентов
и партнёров банка в едином окне », a short fixed headline, and equal text in
every point or caption. These are design-fit boundaries for that phrase,
not general character limits. Longer words and authored line breaks change
the budget; fitting measures the actual text.

| Region | Characters that fit | Lines / size |
|---|---:|---|
| One phone, body | 278 | 6 / 32px |
| Two or three phones, body | 299 | 9 / 36px |
| Monitor, 1 point | 549 | 15 / 28px |
| Monitor, 2 points, per point | 258 | 7 / 28px |
| Monitor, 3 points, per point | 150 | 4 / 28px |
| Monitor, 4 points, per point | 117 | 3 / 28px |
| Phone caption, any count | 27 | 2 / 36px |
| One-phone headline at the floor | 42 | 3 / 72px |
| Other screenshot headlines at the floor | 40 | 3 / 72px |

The next character in each prose probe reports `OVERFLOW`. Unbroken-word
probes of repeated «Ж» distinguish design fit from defect tolerance: the
one-phone body fits 27, first reports `OVERFLOW` at 29; every caption fits 7,
first reports it at 9. Other phone bodies fit 19, monitor points fit 23,
headlines fit 10 on one phone or 9 elsewhere; each first reports overflow
at the next character. Use the design boundary, not the reporting tolerance,
as the available space.

### Tables

Use `table` when the audience needs exact values across 2–6 columns and
1–8 body rows. `header` is a list of strings; every row has exactly as many
cells as the header. A cell is a string (including `""` for an empty cell)
or an object with string `text` and optional `tone`:

```json
{"layout": "table", "title": "Онлайн превысил план",
 "header": ["Канал", "План, тыс.", "Факт, тыс.", "Разница"],
 "label_column": true, "total_column": true,
 "rows": [
   ["Онлайн", "125", "130", {"text": "+5", "tone": "positive"}],
   ["Офисы", "100", "98", {"text": "−2", "tone": "negative"}]
 ]}
```

`label_column: true` makes the first body column Medium;
`total_column: true` does the same for the last. Both are optional booleans,
with no emphasis when omitted or false; they do not calculate totals.
A column aligns right, including its heading, when all its non-empty body
cells are numbers or dashes and at least one is a number. Recognised examples
include `"25 000"`, `"−1 600"`, `"48 %"`, `"3,5 млн"`, `"120 ₽"` and `"x2"`.
Other columns align left. Keep figures as strings; put long units in the
heading and keep each figure on one line. There is no alignment field.

The white card has a fixed height. Short tables keep their natural row heights
at the top and leave space below. Longer tables use one shared body size from
30/28/26/24/20 px. At each size the fitter tries vertical cell padding of
24/18/12 px before reducing the font; headers remain Medium 36 px. The complete
grid must fit the fixed inner region. If it still fails at the floor, shorten
cells or split the table. The slide title fits one line.

Use `table-compare` for exactly two titled cards: the left is yellow and the
right grey. Each has 2–6 rows with non-empty string `label` and `value`;
optional row `tone` applies only to the value. The values align right in
Medium 40 px; labels stay 30 px and card titles 44 px. Rows retain their
natural spacing for 2–5 rows; six rows use tighter spacing, with the same
font sizes. A short comparison leaves space at the bottom of each card.
The slide title may occupy two lines.

```json
{"layout": "table-compare", "title": "Сравнение условий",
 "tables": [
   {"title": "Сейчас", "rows": [
     {"label": "Обработка", "value": "5 дней"},
     {"label": "Ручные шаги", "value": "6"}]},
   {"title": "После запуска", "rows": [
     {"label": "Обработка", "value": "2 дня"},
     {"label": "Ручные шаги", "value": "2", "tone": "positive"}]}
 ]}
```

Both layouts accept plain text only: no lists, formulas, icons or pictures in
cells. `tone` is `"positive"` (green) or `"negative"` (red), chosen by meaning,
not inferred from the sign of a number. Omit it for ordinary text. This field
exists only in tables; it is not a general colour override for other layouts.
Tables are native editable PowerPoint tables with horizontal rules and no
vertical rules or cell banding. Content changes still belong in the JSON spec.

Python helpers use the same data objects and validation:
`Deck.table(title, header, rows, label_column=None, total_column=None, notes=None)`
and `Deck.table_compare(title, tables, notes=None)`.

**Measured capacity, not a character allowance.** With six columns headed
«Канал», «Задача», «Результат», «План», «Факт», «Итог» and eight rows,
the second and third cells of every row were filled with prefixes of
«Проверяем данные клиента и согласуем условия запуска продукта. ».
The first column held short channel names and the last three held
`125 000`, `130 000`, `+5 000`. At 55 characters per tested text cell the
whole table fits at body 20 px; at 56 it is refused with `TABLE_HEIGHT`.
These limits belong to that exact phrase and shape, including its word
breaks. A separate `table-compare` probe used two cards titled «План» and
«Факт», `125 000` in every value, and prefixes of the same repeated phrase
in every label: five rows accepted 80 characters and refused 81; six rows
accepted 54 and refused 55 (`TABLE_CELL_LONG`). Its fixed type does not
shrink to make another line fit. These are boundary probes, not writing
targets. Different wording, headers, row counts and Medium columns change
capacity; run `--check` and preview the actual slide.

### Charts

A `chart` slide carries a native PowerPoint chart: the reader can open it
and edit the numbers. `chart_type` is one of:

| `chart_type` | What it draws | Limits |
|---|---|---|
| `line` | lines over categories, with a value axis and gridlines; labels on every point on request (below) | up to 8 series |
| `bar` (or `grouped`) | columns; several series stand side by side | up to 8 series |
| `stacked` | columns built of stacked series, values inside the segments | up to 14 series |
| `bar_h` | horizontal bars, values at the bar ends | up to 8 series |
| `doughnut` | one series as a ring, percentages inside | one series, 2–8 categories |

`data` is either a CSV path — then `x` is the header of the category
column and `y` the header of the value column, or a list of headers for
several series — or the data itself:

```json
{"layout": "chart", "title": "Выручка по кварталам", "chart_type": "bar",
 "chart_title": "Выручка, млн ₽",
 "data": {"categories": ["Кв1", "Кв2", "Кв3"],
          "series": [{"name": "2025", "values": [12, 18.5, 15]}]},
 "points": [{"text": "Второй квартал — пик года", "icon": "рост"}]}
```

`x`/`y` go with a CSV and only with a CSV. A CSV exported by Excel in a
Russian locale (`;` between fields, `,` as the decimal mark) reads as is.

`number_format` is the Excel format code of the source cells, for the whole
chart (any type, `chart-two` charts included). The workbook's cells get it and
the value labels link to them, so PowerPoint prints what Excel prints and an
edit in Excel keeps it; the line chart's axis takes the same code without the
decimals its ticks do not need. Numbers round half up, as PowerPoint rounds
(12.5 % → 13 %).

| Code | Value | Label |
|---|---|---|
| `0%` | 0.275 | 28% |
| `0.0%` | -0.031 | −3,1% |
| `#,##0` | 1234567 | 1 234 567 |
| `0.0" млн"` | 12.25 | 12,3 млн |
| `#,##0,"K"` | 1234567 | 1 235K |
| `0"%"` | 27 | 27% |

Values go in as the cells hold them: a percentage is a fraction (0.27), and a
`%` code over values past 10 is refused as a percentage written in points.
The code is written as the .xlsx stores it — a dot for decimals, a comma for
thousands (Russian Excel displays `#,##0.0` as `# ##0,0`). Supported: `0`,
decimals `0.0…`, `#,##0`, `%`, a trailing comma per thousand, and text in
quotes; sections (`;`), `[colours]`, dates and scientific codes are refused.
Without `number_format` each label shows its value as written («2» beside
«2,4»). A doughnut keeps its percentages of the whole either way.

`"mode": "value"` colours a single series of columns by sign — green up,
coral down — for gains and losses.

A `line` chart is drawn as 4 pt lines over a value axis, with no dots and no
labels. One optional field changes that:

| Field | Value | What it draws |
|---|---|---|
| `value_labels` | `true` | every point labelled, each with a dot in a soft halo; the value axis and its grid go |

Labels go on every point or on none — `"max"` and `"last"` were withdrawn in
2.3.0 and are a build error; a single figure worth pointing at goes in the
slide text. `value_labels` takes 1 or 2 lines of at most 8 points; 3 lines or
9 points with labels are a build error, so drop the labels and let the axis
read the values. One labelled line drops a thin vertical from each point to
the axis. Of two, the higher point of each category is labelled above it and
the lower one below, and there are no verticals.

```json
{"layout": "chart", "title": "Выручка растёт третий год", "chart_type": "line",
 "value_labels": true,
 "data": {"categories": ["2022", "2023", "2024", "2025"],
          "series": [{"name": "Выручка", "values": [100, 400, 350, 450]}]},
 "points": [{"text": "Рост в 4,5 раза за три года", "icon": "рост"}]}
```

Colours are not a spec field: they come from the brand palette in a fixed
order, chosen by the chart type and the number of series. Bars (`bar`,
`stacked`) start yellow, light yellow. Horizontal `bar_h` with 2–4 series
uses yellow, then light-to-dark greys; one series stays yellow, and 5+ series
keep the yellow/light-yellow palette. The number of categories on the axis
does not change these choices or colour points within a single series.
A doughnut and a line start yellow, then greys in their own order.
A grouped `bar` or `bar_h` takes at most 8 series.
`"mode": "value"` on a single-series `bar`/`bar_h` paints each bar green or
red by its sign. The legend always shows the chart's own colours. A doughnut with
more than 8 categories is refused — show it as a single `stacked` column
instead. One doughnut on a slide uses 40 pt Bold percentages; two doughnuts
use 28 pt Medium on both rings. Their legends stay at 22 pt, even beside a
dense non-doughnut chart. Percentages never shrink to fit: a narrow slice
keeps its fill and legend entry but omits its percentage, with a `CHART_LABELS`
warning. Use a wider chart or `bar_h` when every value needs a label.
Value axes always start at zero.
Columns stand apart by cluster: a grouped `bar` or `bar_h` puts its groups
80 % of a bar apart (about 42 px at the plate's size) and the bars of one
group nearly touching, while a single-series or `stacked` column keeps the
same 16 px gap on every chart and layout — and takes the rest of the width,
so fewer categories give wider columns. A crowded `bar_h` (many series and
categories, value labels no longer fitting) gives the group gaps up before
its labels, as it did before 2.4.0. A column chart with a
value below zero shows a line at zero (vertical on `bar_h`); a grouped or
single `bar` keeps that baseline always.

`chart` carries the chart on a white plate on the right and a points list
on the left, anchored to the bottom. `look` picks the plate: `plate` (the
default) is the one white card; `plates` (2.4.0, the designers' charts_new)
puts the same card on a stack of two translucent ones stepping down to the
right, which leaves the chart less room — the legend then sits under the
title. `points` is **required**: one to five
`{"text": …, "icon": …}` objects, both fields required. A point is about 33
characters a line; five points take two lines each, four take three. Points
that do not fit under the title fail the build. `chart_title`
names the chart on the plate; `center` is the big figure inside a
`doughnut`'s ring and is refused on any other chart type. It is one line
in the hole, at 54 pt Bold with one ring and 44 pt Bold with two rings
on the slide. Keep it to the figure and its unit («4,2 млн»): its measured
width must fit 85% of the hole, or the build fails. PowerPoint draws it as the chart's title,
showing cell D2 of the chart's workbook: edit D2 in Excel and the centre
follows. The slide title has
room for three lines at full size (about 40 characters); a longer one steps
down to 48px, and one that fits at no step fails the build.

A legend is drawn only for two or more series (a doughnut always lists its
categories): across the top of the plate for `line` and grouped `bar` with up
to four series, in a column beside the chart for five or more of them and
always for a `stacked` chart or a doughnut, in the order of the segments. The
top legend sits level with the chart title, at the right edge of the plate.
When the two do not share the row — the title would wrap or the legend run
off the plate — the legend moves under the title, from its left edge, at
the same size. Only a legend too long for the plate even there steps the
chart down (below). A `chart_title` wider than the plate on its own stops
the build with `OVERFLOW`. A bare unit such as «млн ₽» is not a useful title:
name the measure and append its unit, for example «Выручка, млн ₽». If the
slide title already names the only chart and its source has no separate name,
omit optional `chart_title`; each `chart-two` half still needs a meaningful
name from the source.

**Chart labels are measured** — PowerPoint sets them, and left alone it
rotates, cuts or overprints what does not fit. Category names on a column or
line chart are set level and wrap at spaces, but a single word must fit its
column: on a `chart-two` half about 9 characters with five categories and 4
with twelve («Фев», «2024»; «Q1 24» wraps). A longer word stops the build with
`CHART_LABELS` — shorten it, or use `bar_h`, which gives each name a whole row.
A `bar_h` name is set on one line and PowerPoint cuts it with «…» past about
43 % of the chart's width — about 31 characters on the full `chart`, 24 on a
`chart-two` half; a longer one is `CHART_LABELS`.
All chart text - axis names, value labels, the legend - starts at 22 pt on
every chart layout, `chart-two` included. Doughnut percentages and centers
follow their separate fixed sizes, and doughnut legends stay at 22 pt. When values would touch or a legend is too long for
its plate, all non-doughnut charts on the slide automatically step down to 16.5 pt,
along with their legends. The build emits one `CHART_TEXT_REDUCED` warning
for that slide, so you can decide whether to shorten names, show fewer
categories or series,
or use a wider chart. The deck still builds if everything fits at 16.5 pt.
If labels collide even then, `CHART_LABELS` is an error; a wider chart or
less data is needed. The same fitting rule applies to a line's
`value_labels`.

`chart-cards` is the dark companion: the slide title and the chart on a plate
on the left, three cards on the right. A card is `{"title": …, "text": …}`
or `{"value": …, "text": …}` — exactly one subtitle or big figure over the
required description, with no `icon`. **At most one of the three cards may
carry `value`**, in any position; the others take `title`. All three may take
`title` instead. The cards share one size, as on
the card slides: short text is set at 40/28, longer text steps the three
cards down together to 32/20, and the figure steps with the subtitles at
twice their size (80 → 64). The title has room for two lines.

`chart-two` puts two charts side by side for a comparison. `charts` is
exactly two objects, each with the fields of a single chart
(`data`, `chart_type`, `chart_title`, `mode`, `center`, `value_labels`,
`number_format`, and `x`/`y` for a CSV). `chart_title` is required on both:
side by side the charts are told apart by their titles. Take it from the
source as it stands, even when it repeats the slide title; do not invent one.
The title has room for two lines; `note` with its `note_icon` (any icon from
the set, picked like a card icon) runs beside it, in grey. The note is
exactly two lines — about 45 to 80 characters. One line would hang
beside the title as a stray caption: it is a `NOTE_SHORT` error — write it
out, or drop `note` and `note_icon` both; three lines are an `OVERFLOW`.

```json
{"layout": "chart-two", "title": "Сравнение каналов", "note_icon": "рост",
 "note": "Канал A растёт быстрее, но в марте его догнал канал B",
 "charts": [
   {"chart_type": "stacked", "chart_title": "Выручка",
    "data": {"categories": ["Янв", "Фев", "Мар"],
             "series": [{"name": "Канал A", "values": [4, 5, 6]}]}},
   {"chart_type": "bar_h", "chart_title": "Доля",
    "data": {"categories": ["A", "B", "C"],
             "series": [{"name": "Доля", "values": [32, 18, 16]}]}}
 ]}
```

`chart-wide` sets one chart across the slide, for a long series, as on
the designers' long slide: a large title (96 px, two lines) and the note
of `chart-two` beside it on top, the chart on one plate the width of the
slide below. Any chart type but `doughnut` (a ring is as tall as it is
wide; take `chart`), with the fields of a single chart. The note is the
same pair, `note` and `note_icon`, and the same rule — exactly two lines,
about 45 to 80 characters; the head of the two layouts is one design. The plot is 1.6 times as wide as on
`chart` and about half as tall, so a category name has 1.6 times the room.

```json
{"layout": "chart-wide", "title": "Выручка по месяцам", "note_icon": "рост",
 "note": "Рост во втором полугодии дал партнёрский канал, план выполнен в ноябре",
 "chart_type": "bar", "chart_title": "Выручка, млрд ₽",
 "data": {"categories": ["Янв", "Фев", "Мар", "Апр", "Май", "Июн",
                         "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"],
          "series": [{"name": "2025", "values": [12, 14, 13, 16, 18, 17,
                                                 19, 21, 20, 22, 24, 26]}]}}
```

Which of the two: more than 8 categories on `chart` (beside its points)
raise a `CHART_WIDTH` warning pointing to `chart-wide` — except on
`bar_h`, whose categories run down the plot and which the shorter wide
plot would only thin out — and fewer than 6 on
`chart-wide` one pointing back — a short series across the whole slide is
mostly empty plate. The takeaway of a wide chart goes into its `note`.

### A large figure on one card

In `cards`, `grid`, `complex` or `pyramid`, replace one card's `title` with
`value` to make its number the focus. This works on numbered cards too.
**Only one card per slide may use `value`**: two or more stop the build,
including on `chart-cards`. Keep `title` on the other cards, or split the
figures across slides. A slide with only ordinary titles remains valid.
Each card needs exactly one non-empty string `title` or `value`; both together
are an error. A number is a string, such as `"174"` or `"+38%"`.

```json
{"layout": "cards", "title": "Выручка выросла на треть", "cards": [
  {"value": "+38%", "text": "Рост выручки за год", "icon": "рост"},
  {"title": "Новые клиенты", "text": "Основной вклад дал новый канал",
   "icon": "клиенты"}
]}
```

Regular cards keep their mandatory `icon`; numbered cards refuse it, and
`chart-cards` take no icon and require `text`. The large figure replaces the
heading at its existing position. Its `text` and `items` still share the
card's measured space and the slide's body size; it adds no new text budget.
Formulas are forbidden in `value`.

The figure is **twice the shared card-title size**: the ladder is
**96 / 88 / 80 / 72 / 64 px**, capped by the existing layout ceiling.
The figure, ordinary titles, body text and lists step down together when
needed; the spec cannot set their sizes independently.

| Layout | Largest figure, px |
|---|---|
| `cards`, 1–2 cards | 96 |
| `cards`, 3–4 cards; `grid`, 4; `complex`; `pyramid` | 88 |
| `grid`, 6; `chart-cards` | 80 |
| `grid`, 8 | 72 |

The floor is 64 px. Numbered variants use the same ceilings. These are size
ceilings, not guaranteed capacities: the actual step depends on the measured
width and on all card content. If the value does not fit, shorten it or move
its unit into the caption: `{"value": "174", "text": "Выручка, млрд",
"icon": "деньги"}`. If the description or list does not fit, shorten that
content or split it across slides.

### Bullet lists inside a card

Any card in `cards`, `grid`, `complex` or `pyramid` takes an `items` list — up
to five bullet points. The type size follows the card it sits in, so a list in a dense grid is set
smaller than one in a wide card.

```json
{"layout": "cards", "title": "Что меняем", "cards": [
  {"title": "Анкета", "icon": "список",
   "items": ["Убрали шесть шагов", "Данные из профиля", "Решение на экране"]},
  {"title": "Поддержка", "text": "Вводная фраза перед перечислением",
   "icon": "щит", "items": ["Обращений вдвое меньше", "Ответ за минуту"]}
]}
```

`text` and `items` can be used together: the sentence introduces the list. With
`items` alone the list takes the description's place instead of hanging below
it. A single card with `items` is the list that fills the whole slide; the
separate bullets layout is gone since v2.0, and a spec that names it is refused
with the rewrite.

### Numbered cards

`"numbered": true` on a `cards` slide of 2–4 cards or on a `grid` numbers
the cards 1 to N in their order: each card is grey, with the number in a
yellow circle set into a notch at its bottom right, where the icon would
be. Take it when the order is the point — steps, stages, a ranking. The
cards take no `icon` (one is refused), and no card is yellow.

```json
{"layout": "cards", "numbered": true, "title": "Как подключить", "cards": [
  {"title": "Заявка", "text": "Клиент оставляет заявку в приложении"},
  {"title": "Проверка", "text": "Скоринг занимает пару минут"},
  {"title": "Выдача", "text": "Деньги приходят на карту"}
]}
```

The variant is chosen for you: three cards in `cards` give a row of three, six
in `grid` give a two-by-three grid, four metrics switch from columns to a grid.
None of this is switchable by hand, and none of it needs to be.

### Inline formulas

**Authoring and verification.** Inventory intended equations before choosing
layouts, especially for teaching and analytical decks. Record the slide,
meaning, exact body field (with item indices), expression and nearby prose that
identifies its location. Keep this as an authoring checklist; the JSON remains
the only build input, and the build never parses the Markdown plan.

For example, the intent "sample share is successes divided by observations"
becomes the inline source `\(p=\frac{k}{n}\)`. In a JSON file it is:

```json
{"layout": "cards", "title": "Доля успехов", "cards": [
 {"title": "Расчёт", "icon": "аналитика",
  "text": "Доля: \\(p=\\frac{k}{n}\\). Числитель — успехи, знаменатель — наблюдения."}
]}
```

Every backslash is doubled in literal JSON, including the delimiters and
commands. When writing JSON from Python, pass the decoded source, such as
`r"Доля: \(p=\frac{k}{n}\)."`, to `json.dump(..., ensure_ascii=False)` once;
do not double it manually first. The output contains an editable `m:oMath`
inside `a14:m` in the paragraph for `cards[0].text`, with `m:f/m:num` holding
`k` and `m:f/m:den` holding `n`. It is not a raster picture.

After building a mathematical deck:

1. Reconcile the checklist with the actual JSON fields, including every
   intended equation in a field containing several expressions. A plain-text
   expression will not appear in an inventory derived only from tagged runs.
2. Inspect the ZIP parts `ppt/slides/slideN.xml`. For each checklist row, find
   the text shape by its surrounding prose; check its ordered `a14:m/m:oMath`
   children, their operands/symbols and their structure (`m:f` for a fraction,
   `m:nary` for a sum/integral, `m:sSub`/`m:sSup` for scripts). Compare the exact
   number on each slide and in each text field, including zero-math controls.
   Checking only that the deck has some OMML misses omissions and wrong fields.
3. Inspect representative formulas and mixed prose in desktop PowerPoint;
   save a scratch copy and repeat the inventory check there. Confirm the
   equations are selectable/editable, retain meaning and clear their neighbours.
   PNG previews validate geometry and continuation, not native OMML or editing.

For repeated expressions, distinguish fields by their nearby prose and order;
the PPTX does not carry JSON field identifiers. Report which formulas/slides
were checked and whether desktop PowerPoint was available.

Use `\(…\)` only for an equation that needs mathematical typesetting and must
remain editable in PowerPoint. The source is bounded inline LaTeX:

```json
{"layout": "cards", "title": "Оценка", "cards": [
 {"title": "Ковариация", "icon": "аналитика", "items": [
   "Используем \\(\\mathrm{Cov}(X,Y)=\\frac{1}{n}\\sum_{i=1}^{n}(x_i-\\bar{x})(y_i-\\bar{y})\\)"
 ]}]}
```

Formulas are accepted only in body text: `cards[].text`, `cards[].items[]`,
`timeline.points[].text`, `flow.steps[].text`,
`columns[].text`, and metric-caption `metrics[].text`.
They are rejected in titles, subtitles, point/column titles, card and metric `value`,
statement/final text, agenda, flow summary, media notes/captions, image points,
gallery titles/descriptions, table headers/cells/comparison labels and values, and notes.

**Supported.** Fractions (`\frac`), roots (`\sqrt`, with or without an index),
sub- and superscripts, n-ary operators with limits and a following operand
(`\sum`, `\prod`, `\int`, `\oint`, `\bigcup`, `\bigcap`), delimiter pairs
(`\left`…`\right`, and the `\bigl`…`\bigr` spelling of the same thing),
accents (`\hat`, `\tilde`, `\bar`, `\vec`, `\dot`, `\overline`), alphabets
(`\mathrm`, `\mathbb`, `\mathbf`, `\mathcal`, `\mathit`, `\mathsf`,
`\boldsymbol`), Greek letters, set and logic notation (`\in`, `\notin`,
`\subset`, `\cup`, `\cap`, `\mid`, `\perp`, `\forall`, `\exists`, `\not`),
relations and arrows (`\leq`, `\geq`, `\neq` or `\ne`, `\approx`, `\equiv`,
`\sim`, `\propto`, `\to`, `\Rightarrow`, `\Leftrightarrow`, `\mapsto`),
operators (`\cdot`, `\times`, `\pm`, `\infty`; a bare `*`, as in `x^*`, is
set as `\ast`), delimiters beyond brackets (`\{…\}`, `\|…\|`,
`\langle…\rangle`), ellipses
(`\dots`, `\cdots`, `\vdots`), spacing (`\,`, `\;`, `\quad`, `\qquad`), and
named operators (`\log`, `\ln`, `\exp`, `\sin`, `\cos`, `\tan`, `\min`,
`\max`, `\sup`, `\inf`, `\lim`, `\det`, `\arg\min`, `\arg\max`).

An argument may be bare when it is a single atom: `\hat\tau` and `\sqrt n`
are accepted, as are `\hat{\tau}` and `\sqrt{n}`. A sum, product or integral
must include its operand after the limits, and a named function must include
its argument.

**Not supported, and what to write instead.** The build names the construct
rather than rendering an approximation of it — an approximation of
mathematics is wrong mathematics.

| Instead of | Write |
|---|---|
| `\underbrace`, `\overbrace` | annotate the expression in prose |
| `\xrightarrow{d}`, `\xleftarrow`, `\stackrel` | `\to`, with the label in prose |
| `\overset`, `\underset` | put the annotation in prose |
| `\begin{matrix}`, `cases`, `align` (`\begin`/`\end`) | these are not inline math |
| `\displaystyle` | an inline formula has no display mode |
| `\limits`, `\nolimits` | limits are placed for you: `\sum_{a}^{b}` |
| `\substack` | one subscript, or move the condition to prose |
| `\binom` | write it as `\frac`, or in prose |
| `\phantom`, `\mathstrut` | spacing struts are not supported |
| `\mathbf{\log x}`, `\mathbf{\sum_i x_i}` | style the operand: `\log \mathbf{x}` |
| `\mathbb{\alpha}`, `\mathcal{\beta}` | Unicode has no blackboard or script Greek |
| Cyrillic inside `\text{}` | keep the label in the prose outside `\(…\)` |

An alphabet command reaches everything inside it, as in TeX: `\mathbf{x^2}`
sets both the base and the exponent, `\boldsymbol{\hat\beta}` gives a bold
accented letter. It is refused, never quietly dropped — a style that reached
the file but not the glyph would look right in the preview and plain in
PowerPoint.

Cyrillic is the one worth explaining: a formula is set in a maths face, and
neither the PowerPoint face nor the preview face has Cyrillic in it. So
`\text{при}` is not a formula that renders badly — it is one that cannot
render at all. Write `\(\max_h \mu_h(G)\) при \(\mu_h(C) \leq B\)`.

**A formula has to fit its column.** It is one unbreakable unit — the wrapper
cannot split it — so a long one either overflows or drags the whole slide's
type down to make room. The build refuses both (`FORMULA_TOO_WIDE`,
`OVERFLOW`) and names the formula. Split it into two formulas —
`\(S = a + b\) \(+ c + d\)` — and the line breaks between them, each half
measured on its own; or shorten it.

Do not use a formula for `$5 млн`, `+15%`, `×2`, units, metric values or
ordinary arithmetic. One slide should contain only a small number.

**Advisory `UNTAGGED_MATH`.** Outside matched `\(…\)` runs, the build flags
selected TeX commands, sum/integral/root symbols, simple letter scripts such as
`x_i`/`x^2`, and assignments such as `Var(X) = 1`. It names the slide and field
and suggests the allowed body fields, or a formula-enabled layout. The build
continues and preserves the text. It does not infer mathematical meaning,
validate plain-text equations or automatically add delimiters.

Review each warning: an article code `A_1` can be intentional prose. Backtick
code, URLs and file paths are excluded; `$5 млн`, `+15%`, `×2`, units and
`2 + 3 = 5` alone do not warn. Quoted examples outside backticks may still
warn, and unrecognised notation may pass silently. Absence of a warning does
not replace the intended-equation checklist. Unsupported tagged constructs
and formulas in prohibited fields still produce the existing blocking errors.

### Speaker notes

Any slide, of any layout, may carry an optional `notes` field — a string
written to the .pptx notes pane and nowhere else. It never affects the
slide's own layout choice or visible content.

```json
{"layout": "cards", "title": "Что сделали", "cards": [...],
 "notes": "Сделать паузу после первой карточки — это главный тезис."}
```

Keep them to two to four sentences — what the presenter says out loud and the
slide does not show. Notes are not a summary of the slide, and they are not
somewhere to move text that would not fit: anything the audience needs belongs
on a slide. Past **600 characters** the build raises a `NOTES_TOO_LONG`
warning. It is a warning, not an error — the deck still builds.

**Type size is chosen for you too, and you cannot set it.** Each layout has a
ladder of steps — a card title from 48 px down to 32, a card body from 34 down
to 20 — and the build lays the slide out with the real layout engine, largest
step first, and keeps the first one where the text fits. One size per slide,
shared by every card on it, because that is how the design works and because
neighbouring cards in different sizes read as a mistake. Write the text you
mean; if it is genuinely too long, the build says so and names the size it gave
up at. There is no field for a font size in the spec, and there will not be one.

`\n` inside `title`, `statement` and `final` breaks the heading across lines —
that is how the reference layouts are set, and the break reads deliberately.
Other fields do not need line breaks.

A `timeline` with `look: grey` and exactly 3 points gets a decorative
background image with discs on it; at 4 or 5 points that look does not.
The `yellow` look has its own background at either supported point count.

## How much text fits

These numbers come from running the layout engine, not from estimation. They
are the **hard limit** at which the build stops — the point where even the
smallest step of the ladder no longer fits. A good slide uses about half, and
stays at a larger, more readable step.

| Layout | Card text, characters |
|---|---|
| `cards`, 1 card | 2000+ |
| `cards`, 2 cards | 1382 |
| `cards`, 3 cards | 918 |
| `cards`, 4 cards | 521 |
| `grid`, 4 cards | 437 |
| `grid`, 6 cards | 271 |
| `grid`, 8 cards | 223 |
| `complex` | 271 |
| `pyramid` | 271 |

Every card carries an icon, and the icon's band at the bottom of the card is
reserved before the size is chosen — so these figures already account for it,
and text can no longer end up printed under its own icon.

The table above records cards with ordinary titles. A large `value` uses more
of its card's space, so those character counts are not allowances for a value
card. Validate the actual combination of `value`, `text` and `items`.

`timeline`, `flow` and `columns` ride a second ladder pair (point-title/
point-body, 120% leading) instead of the card ladder, and each point/step/
column carries its own `.fit-box` the same way a card does. Measured the same
way:

On a dark `columns` slide, the main title uses its own 88/80/72/64 px ladder.
One or two lines keep 88 px; a three-line title can step down to 64 px so it
stays at least 24 px above the fixed white panel. A title that cannot clear
the panel at the smallest step stops the build with a measured `OVERFLOW`;
shorten it or choose another layout. Three lines, or any title stepped below
80 px, also raise `COLUMNS_TITLE_DENSE`: shorten to at most two lines and
rebuild before delivery. The 64 px step is a safe rendering fallback, not a
recommended finished title. The column text below is fitted separately.

| Layout | Step/point text, characters |
|---|---|
| `flow`, `line`, 4 steps, no summary | 404 |
| `flow`, `line`, 4 steps, with summary | 186 |
| `flow`, `line`, 5 steps, no summary | 300 |
| `flow`, `line`, 5 steps, with summary | 137 |
| `flow`, `zigzag`, 4 steps | 332 |
| `flow`, `zigzag`, 5 steps | 246 |
| `timeline`, 3 points | 474 |
| `timeline`, 3 points, with a `title` on every point | 366 |
| `timeline`, 4 points | 472 |
| `timeline`, 4 points, with a `title` on every point | 364 |
| `timeline`, 5 points | 354 |
| `timeline`, 5 points, with a `title` on every point | 271 |
| `columns`, 3 columns | 1085 |
| `columns`, 4 columns | 732 |
| `columns`, 5 columns | 559 |
| `columns`, 6 columns | 536 |

The `columns` body figures use the same repeated phrase above, the short
heading «Этап» in every column and «Заголовок слайда» as the slide title.
All columns are filled together: the listed input length passes, one more
character reports OVERFLOW at the 20px body floor. They are examples, not
character allowances. Subtitle bands share the body's explicit text width
(542/398/312/254px for 3/4/5/6 columns), leaving the existing gutter before
the next heading. Their fixed height keeps the dots aligned with the rule.
The subtitle ladder stops at 32px; a heading that still wraps or overflows must
be shortened or placed on a layout with fewer columns. The builder never
rewrites it or adds a smaller type step.
The heading examples below repeat that same phrase with «Короткий текст»
as every body: 34/25/18/15 input characters fit at 32px for 3/4/5/6 columns;
the next character wraps and reports OVERFLOW. Trailing whitespace does not
add visible ink. Other words can reach the boundary sooner.

The `timeline` figure is **per point**, not per slide, and it drops sharply
once every point carries a `title`: the subtitle line eats directly into the
same point's text budget, not just its own line.

The `flow` figure is **per step**. The `zigzag` limits were measured by
repeating «обслуживание клиентов и партнёров банка в едином окне » under the
short slide title «Заголовок слайда», then bisecting the text length until
`build(strict=False, pptx=False)` reported `OVERFLOW`. All steps were filled
together and each above/below caption was checked separately: 332/246
characters pass for 4/5 steps, 333/247 fail at the 20px body floor. The
un-summarised `line` was checked with the same text too. These are measured
examples, not universal character allowances: word lengths, explicit line
breaks and the slide title can cause an earlier error. A step has no `title`
field; the point-title budget reduction above applies only to `timeline`.

Other fields:

| Field | Limit, characters |
|---|---|
| Slide `title` (heading above the cards) | 79 |
| `title` layout, `text` (the opening headline) | 55 — **two lines, see below** |
| `agenda` item | 131 |
| `items` entry inside a card | shares the card's text budget |
| `statement` text | 52 — **three lines, see below**; `look: cards` 25 — **two lines** |
| `columns` heading (`columns[].title`), 3 columns | 34 — one line |
| `columns` heading, 4 columns | 25 — one line |
| `columns` heading, 5 columns | 18 — one line |
| `columns` heading, 6 columns | 15 — one line |
| `final` text | 35 — **three lines** |
| `versus` side `title` | about 30 — **three lines** |
| `versus` side `subtitle` | about 50 — **two lines** |
| `versus` side `text` | 130–250 — **three to six lines, see below** |
| Metric caption, 2–3 metrics | 192 |
| Metric caption, 4–6 metrics | 103 |
| `metrics` title, both variants | 25 — **one line, see below** |
| `metrics` subtitle, 2–3 metrics | 261 |
| `metrics` subtitle, 4–6 metrics | 327 |

Most of these are larger than they were before v1.3, because the type now
shrinks a step instead of the build refusing. The card figures are not directly
comparable to the old ones: the body starts at 34 px rather than 24, and the
leading went from 120 % to 140 %, so a slide that uses its full budget is set
smaller than it used to be while a short one is set considerably larger.

**A `versus` side fills its card.** The text is set at a fixed 30 px, about
42 characters a line, and the build holds it between three and six lines:
under three the card stands empty (`VERSUS_SHORT`), past six it climbs into
the title (`VERSUS_TOO_LONG`). The two sides may differ by one line at most
(`VERSUS_SKEW`) — further apart, their subtitles and first lines stop
lining up and the pair reads lopsided. All three are errors, not warnings:
write both sides to about the same length, and say what each option means
in practice rather than naming it twice.

**A `statement` is a phrase.** At its full 144 px a line holds about twenty
characters, and the designers' own statements run 19–45 characters on one or
two lines. Past three lines the build stops with `STATEMENT_TOO_LONG` — before
2.1.1 the type shrank instead, down to nine lines of 112 px wall, which is a
paragraph, not a statement. A longer thought is a card slide with a claim for
its title.

**Two looks of one statement** (2.4.0), selected by what the phrase does:

- `glass` (default) — the designers' glass panel over the yellow, text
  centred on it, three lines. Use it for a quote, a question to the audience
  or a substantive phrase; put the «» in `text` for a quote;
- `cards` — two glass cards at a slant, text left-aligned in the lower right
  card, **two lines** (about 25 characters). Use it for a short section name,
  such as «Следующий этап». A third line is `STATEMENT_TOO_LONG`, with `glass`
  offered.

The yellow-pattern statement of 2.3.0 is retired (the author preferred the
designers' two); `"look": "pattern"` is refused with the replacement.

Two statements in a row are a `STATEMENT_RUN` error, whatever their looks:
the second is a pause with nothing to pause from. Choose each look by the
phrase's purpose rather than alternating them. On this slide alone the build
keeps short words — «не», «в», «на», «и», «по» and the like — with the word after
them, so no line ends on one.

If a number here looks wrong, trust the build over the table: the build
measures, the table only records what the measurement said.

**Numbers and short words are never split from what they belong to.** The
build puts a non-breaking space between digit groups («25 000»), between a
number and its unit or sign («4,5 млн ₽», «15 %», «3 п. п.»), before a spaced
dash, after a short word («в», «на», «не», «и» — «не всегда» stays together),
between initials and the surname («А. С. Пушкин») and before «г.» of a year
(«2024 г.»). A line never ends on «4,5», «в» or «А.» and never starts with
«—». Write ordinary spaces; the build does the rest. A glued group is measured
as one word, so an overflow message may quote «за внимание!» whole. A metric
`value` is left as written — it has its own one-line rule, below.

### The `metrics` heading is one line, and it does not shrink

Everywhere else on a card layout an over-long heading costs you a type step.
Here it costs you the build: the heading is a fixed 112 px, its box holds
exactly one line, and a second line stops the build with `OVERFLOW`. About 25
characters — «Результаты года», «Итоги первого полугодия» — with capitals and
wide letters using it up faster. The subtitle is fixed too (48 px on 2–3
metrics, 32 px on 4–6) but has room for several lines, hence the figures above.

Put the long form in the subtitle: title «Рост ключевых метрик», subtitle
«за счёт оптимизации процессов и автоматизации рабочих мест».

### A metric `value` must fit on one line, and three metrics is the tightest case

A wrap pushes the caption down and the columns stop aligning, so it is an error
(`METRIC_WRAP`) rather than a warning. What surprises people is that **six
metrics give a value more room than three**: the 4–6 grid drops the type to
136 px while the 2–3 row keeps it at 192 px in a column that has already been
cut to a third of the slide.

A value that stays on one line but fills its column is refused too, under the
same code: the gap to the next metric is 20 px, and «3100 ₽» beside «1,9 %»
read as «₽1,9 %». A value must leave a quarter of its type size clear — 48 px
at 192, 34 at 136 — when another metric stands to its right; the last one in
a row may run to its edge.

| metrics | type | column | fits | too wide |
|---|---|---|---|---|
| 2 | 192 px | 840 px | «174 млрд», «1,5 трлн» | «650 млрд», «+174 млрд», «99,9 млрд» |
| 3 | 192 px | 553 px | «6 мин», «+38%», «174», «2400» | «3100 ₽», «99 млн», «174 млрд» |
| 4–6 | 136 px | 553 px | «1,5 трлн», «99 млн», «12,5 млн» | «174 млрд», «650 млрд», «+174 млрд» |

The fix is almost always to move the unit into the caption:
`{"value": "174", "text": "Выручка, млрд"}` instead of
`{"value": "174 млрд", "text": "Выручка"}`. Dropping a `+` or a decimal comma
buys a lot too — both are as wide as a digit and neither carries much.

The opening headline (`title.text`) holds **at most two measured lines**,
with or without `author`. Its standard 144 / 128 / 112 / 96 px ladder picks the largest
size that fits both lines and the available space. If it still needs three
lines at 96 px, the build reports `OVERFLOW`: shorten the title or move details
to another slide. Explicit line breaks count too; three explicit lines cannot
be rescued by a smaller font. The subtitle participates in geometry checks,
but this headline line cap does not apply to the subtitle itself.

Short opening headlines automatically try **200 px Bold** (150 PowerPoint pt)
with a **50 px Regular** subtitle (37.5 pt). This applies only to `title.text`
with **1–15 Unicode characters inclusive**, counting ordinary spaces, NBSP,
punctuation and leading/trailing spaces. Characters are counted without
trimming or Unicode normalization. Any explicit line break uses the standard
ladder; automatic wrapping may still produce two measured lines at 200 px.
Length only admits the larger pair: width, height, logo/author clearance and
the two-line cap must also pass. If the pair cannot fit, the template's
40 px subtitle and standard headline ladder are restored. A headline longer
than 15 characters always uses that standard pair. There is no public size
override, and statement, timeline and closing headlines keep their own scales.

The 55-character figure uses the repeated filler «обслуживание клиентов и
партнёров банка в едином окне », a short subtitle and either a short author or
no author: 55 fits in two lines at 96 px; 56 needs three and fails. This is a
measured example, not a universal character limit. Word widths, line breaks
and longer subtitles can reduce the available room. The existing composition
is retained: without an author the text block moves down and the logo follows
it part of the way; adding an author uses the original positions.

The title slide's `subtitle` is bounded at **1039 characters**, and past that the
build stops with `COLLISION` against the logo. That number is not a licence to
use it. The block is centred on the slide and grows in both directions, so the
subtitle pushes the headline *up* toward the logo — and because the headline
rides a ladder, what actually happens first is that the headline shrinks to make
room. A 1000-character subtitle drags a one-line headline from 144 px down to
96 px, and the slide is still technically valid. Keep a subtitle to one line: it
is a caption, not a paragraph, and every character of it is taken out of the
headline.

When text does not fit, do not shrink it to a stub — take a layout with fewer
elements or split the material across two slides.

## Icons

An icon is requested by meaning, not by filename: `"icon": "рост"`,
`"icon": "безопасность"`. The matching file is looked up in an index of 355
icons plus a layer of 411 business concepts. If nothing matches, the build
stops and shows near misses.

**Every regular card must have an icon**, whether it has `title` or `value`.
Numbered cards and `chart-cards` take no icon. The same requirement applies
to a `flow` step, a `circle` point, a chart or image point, and every gallery image: `icon` is
required there for the same reason, and is checked the same way.

**No duplicates on a slide.** The same icon on two cards of the same slide is
impossible — the allocator picks the next best match automatically. Across the
deck, repeats are penalised, not forbidden.

To see what a word resolves to before building:

```
python3 scripts/find_icon.py безопасность
```

Batch mode — resolve several icons in one call:

```
python3 scripts/find_icon.py рост эффективность команда
python3 scripts/find_icon.py рост эффективность --exclude chart-grow --exclude flash
python3 scripts/find_icon.py --concepts  # list the business vocabulary
```

Keywords are matched with «ё» and «е» treated alike, so «самолет» finds
«самолёт». Morphological normalization handles Russian word forms:
«ускорение/ускорить/ускоряем» reach the same concept.

Use different icons on different slides — repeating one on adjacent slides
raises a warning.

## What the spec does not control

Sizes, spacing, colours, fonts, backgrounds and positions are properties of the
layout. They are absent from the spec and there is no way to add them — that is
precisely what keeps a deck inside the template. The template has no slide
numbers; they were dropped deliberately.

### Fixed collage with points

`illustration-points` uses the supplied collage on a yellow left card and
2–4 titled icon points on the right. Two points form a vertically centered
visible group; short text uses compact rows, longer text uses taller rows.
Three and four points keep their distributed placement. Titles and bodies
share the existing type ladder. No custom illustration or alignment field.

```json
{"layout": "illustration-points", "title": "От идеи к результату", "points": [
  {"title": "Выбираем цель", "text": "Определяем задачу команды.", "icon": "цель"},
  {"title": "Проверяем решение", "text": "Собираем обратную связь.", "icon": "проверка"}
]}
```

Python: `Deck.illustration_points(title, points, notes=None)`.


### Cycle with two takeaways

`circle` places 3–6 icon labels around a ring on the left and exactly two
regular cards on the right. Each point has only `text` and `icon`; both are
required. Cards use the regular card fields: exactly one non-empty `title`
or `value`, a required `icon`, and optional `text` or `items`. At most one
card may use a focus `value`. There is no `look` or alignment setting.

```json
{"layout": "circle", "title": "От идеи к результату", "points": [
  {"text": "Изучаем задачу", "icon": "поиск"},
  {"text": "Выбираем решение", "icon": "цель"},
  {"text": "Проверяем результат", "icon": "аналитика"}
], "cards": [
  {"title": "Проверяем гипотезу", "text": "Собираем обратную связь после каждого цикла.", "icon": "команда"},
  {"value": "62%", "text": "Участников пилота выбрали новый сценарий.", "icon": "рост"}
]}
```

Python: `Deck.circle(title, points, cards, notes=None)`.

The slide title uses the 96 / 88 / 80 / 72 px ladder. Point labels and card
bodies share the body size; card titles and bodies move together from
44 / 30 down to 32 / 20 px. Upper labels end above their icon badges even
when the type steps down. Keep node labels short and put explanations in
the cards or another slide. Each round badge and its icon form one editable
PowerPoint group; the label and the ring remain separate objects.


Measured examples use prefixes of repeated «обслуживание клиентов и
партнёров банка в едином окне ». Only one region grows at a time: point
labels are equal, both cards have the short title «Итоги», and all other
fields stay short. These are boundaries for that phrase, not universal
character allowances; word lengths and explicit line breaks change the fit.

| Region | Characters within the design fit | Size |
|---|---:|---|
| Slide title | 35 | 72px |
| Each label, 3–5 nodes | 86 | 20px |
| Each label, 6 nodes | 74 | 20px |
| Each card body, short card titles | 431 | 20px |

The next character reports `OVERFLOW`; for six-node labels it initially
reports a warning at 75 and first reports an error at 87. Stay within the
design boundary rather than treating reporting tolerance as available space. Longer card titles, a focus `value` or bullet items can reduce the body budget. Shorten overflowing content or
move details to another slide; do not reduce fonts below the ladder.
