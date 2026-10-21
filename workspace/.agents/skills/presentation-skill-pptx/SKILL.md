---
name: "presentation-skill-pptx"
description: "Сборка презентации PPTX в корпоративном шаблоне Т-Банка по JSON-описанию содержания."
license: "proprietary"
compatibility: "Python 3.9+ with python-pptx, lxml, Pillow, numpy, matplotlib. Runs offline; no browser or network access needed."
metadata: {"author":"m.lenivkin","version":"2.5.0","last-updated":"2026-10-09"}
disable-model-invocation: false
user-invocable: true
when_to_use: "Когда входом или результатом служит документ соответствующего формата; передай файлы, ожидаемые изменения и путь результата."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Навык можно выбирать автоматически, когда текущая задача соответствует описанию. Загружай только нужный режим и относящиеся к нему ресурсы.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.
<!-- /odysseus-invocation-policy -->

## Odysseus: user-approved supplied skill

This skill was explicitly added by the user as an exception to the base
local/browser/Obsidian catalog. The services, local applications and MCP/CLI
integrations required by this skill are permitted for its requested workflow.
The local-only restriction of unrelated skills does not disable this exception.

Importing the skill does not connect a service, install a runtime or authorize
sending messages, publishing artifacts or changing external records by itself.
Use the host's available tools and the user's actual task authorization.
Resolve bundled scripts, assets and references from this installed skill's own
root; write task outputs in the user's working project. If a required tool,
connection or referenced resource is absent, report the exact dependency rather
than inventing a successful result.

---


# PPTX presentations in the T-Bank template

## Core rule

Never write deck markup. The layouts include `timeline`, `flow`,
`columns`, native tables, picture layouts and four for charts — you describe content in a
JSON file and a script builds the deck. Anything not in the spec — sizes,
colours, fonts, positions — belongs to
the template and is not configurable.

Slide text is written in Russian unless the user asks otherwise. These
instructions are in English; the presentation is not.

## Instructions

1. **Gather the content.** Establish what the deck is about, who reads it and
   what conclusion it must leave. If the user supplied material, work from it —
   never invent figures.
   For pictures, use the user's images or extract them from supplied materials.
   Ask for images if neither is available; generate example illustrations only
   when the user explicitly authorizes generation.
2. **Map content to layouts.** Read `references/layouts.md`: it holds the
   "what to show → which layout" table and the fields of every layout. Minimum
   deck: title slide, agenda, content slides, closing slide.
   For `image-points`, prefer `fit: "cover"` for photographs and
   `fit: "contain"` for diagrams/chart images whose labels or edges matter.
   Choose from the visual content; the builder does not classify images.
   `image-gallery` always uses cover and accepts no fit setting; reserve it
   for photographs or simple illustrations that tolerate cropping.
   If the material needs mathematical typesetting, inventory each intended
   equation before choosing its layout: slide, meaning, permitted body field
   and expression. Keep currency, units and simple arithmetic as prose.
   Choose layouts by the explanation: causal chains use `flow`, time uses
   `timeline`, alternatives use `versus`, standalone ideas use `cards`/`grid`,
   and labelled diagrams use `image-points` with contain. In a long deck,
   review the rhythm of each explicitly planned section; do not invent section
   boundaries from headings or notes, or rotate layouts just for variety.
3. **Settle the plan before writing the spec.** The plan is `results.plan.md`
   next to the future deck: the one message in a sentence, the figures with
   where each came from, and the slide list. A wrong through-line costs a line
   to fix here and a rebuild once fifteen slides exist. Whether it is agreed
   in advance is the user's call, so **ask them — once, before writing
   anything**: agree the plan first, or build the deck straight away? Put it as
   a question with those two answers.
   - **The user already sent a plan** — then that is the plan and there is no
     question. Work from it, do not restate it in your own shape; say once what
     it lacks for a deck and go on.
   - **Agree first** — write the detailed plan: the wording drafted for every
     slide, the title as it will read, the text of each card, bullet and
     metric, every figure traced to its source. Show it and **wait**. Do not
     write the spec until the user has answered. Shape:
     `assets/example-plan.md`.
   - **Straight away** — write the short plan: one line per slide, its layout
     and what it carries. Show it and carry on to the spec in the same turn.
     Shape: `assets/example-plan-quick.md`.

   The question belongs to the deck, not to the turn: asked once, and not
   re-opened for later edits, which go through the spec.
4. **Write the spec** as JSON next to where the presentation should live. Name
   it after the future PPTX: `results.json` produces `results.pptx`. Worked
   example: `assets/example-deck.json`. From here the spec is the deck — the
   plan is not updated for later edits.
5. **Check before building:**
   `python3 scripts/build_deck.py results.json --check`
   This parses the spec, computes the layout and reports anything that does not
   fit. No files are written.
6. **Build:**
   `python3 scripts/build_deck.py results.json`
   Produces `results.pptx`. An error means the slide would come out broken —
   fix the spec and rerun.
7. **Look at the result.** Render a few slides and open the PNGs with the image
   reader:
   `python3 scripts/preview_deck.py results.json --slides 1,3,5`
   Text that technically fits can still sit badly, and this is the only way to
   see it.
   For mathematical decks, also reconcile every inventoried expression with
   native OMML on its slide and beside its expected prose, in order. A nonzero
   equation count for the deck proves neither completeness nor placement.
   The verification procedure is in `references/layouts.md`, Inline formulas.
   For a large technical deck, review a contact sheet covering every slide,
   then inspect every substantive diagram and each formula at readable size.
   Check diagram edge labels/arrows and the prose following inline equations;
   neither a fitted box nor a nonzero OMML count proves their completeness.
   Keep geometry validation, PNG review and native PowerPoint review separate.
   Run `python3 scripts/check_delivery.py results.json results.pptx` on the
   generated artifact. Read [delivery checks](references/delivery.md) for its
   per-slide formula/title checks and review-slide list. A passing report is
   evidence of those checks only, not semantic or visual approval.
   When PowerPoint is available, open/save a scratch copy and inspect its
   export; preserve the generated original. Otherwise report the missing
   native verification. Group issues by code with original slide numbers and
   a disposition for each: corrected, intentionally retained with a reason,
   or unresolved. State the actual visual coverage and remaining limits.
8. **Report:** path to the `.pptx`, slide count, layouts used, any remaining
   warnings. Keep the spec — edits are made through it.

## Writing the slides

**One message per deck, settled before any layout is chosen.** Put it in a
single sentence: what the audience should be able to repeat once it is over.
That is what step 1 is asking for. Every slide then either moves that message
or does not belong. The common failure here is not an ugly slide — it is a
pile of correct numbers with no through-line, where nobody can say afterwards
what the deck was for. A number without a conclusion is not a slide; it is
evidence for one.

The occasion suggests an arc — a review runs problem → what changed → result →
what is next, a pitch runs opportunity → approach → proof → ask — but the arc
follows the material, not the other way round. Decks and the people asking for
them differ; take the shape the content actually has instead of filling in a
template.

A deck is a management document. Every slide answers "so what?" — conclusion
first, evidence second. Write in Russian, in the register of these examples:

| Weak | Strong |
|---|---|
| «В условиях динамично меняющейся конъюнктуры…» | «Выручка выросла на 38% за счёт…» |
| «Оптимизация операционной эффективности» | «Сократили обработку с 5 до 2 дней» |
| «Синергетический эффект от интеграции» | «Объединение команд дало +15% к скорости» |

No throat-clearing, no adjectives for decoration. A slide title is a claim, not
a topic: «Конверсия выросла на треть», not «Конверсия». Before writing the
spec, read the titles in a row: on their own they should retell the deck, all
in one form. A teaching deck may title its slides as questions — «Что такое
LTV», «Как считать эффект» — but then every content slide does; a mix of
claims, questions and bare nouns reads as three authors. Call one thing by one
name, spelled the same way on every slide.

**Formulas are rare and explicit.** Use `\(…\)` (in the JSON, `\\(…\\)` — every
backslash doubled) only when body text genuinely
needs typesetting — a fraction, root, sum, integral or statistical equation —
not for currency, units, percentages or ordinary arithmetic. They are native,
editable PowerPoint equations. The exact allowed fields and syntax are in
`references/layouts.md`; a formula in a title or metric value is rejected. A
formula is one unbreakable unit and has to fit its column on its own — if the
build refuses one as too wide, split it into two `\(…\)` formulas (the line
breaks between them) or shorten it rather than moving it to a roomier layout.
`UNTAGGED_MATH` is advisory: inspect the named field, tag a real equation in
an allowed body field, or retain intentional prose/code. The builder does not
classify intent or rewrite text. Never silently replace unsupported mathematics
with ASCII, an image or an approximate expression; explain the limitation and
agree a faithful supported formulation.

## Editing an existing deck

Edit the **spec**, then rebuild the whole deck. Never hand-edit the `.pptx` —
the next build overwrites it. Typical requests and how to handle them are in
`references/editing.md`.

## Gotchas

- **Tables hold plain text.** Use `table` for 2–6 columns and 1–8 rows on a
  fixed white card, or `table-compare` for exactly two titled cards with
  2–6 label/value rows each. No lists, formulas or icons in either layout.
  `tone: "positive"` / `"negative"` is a table-only semantic colour choice.
  White tables fit body text through 30/28/26/24/20 px and row padding;
  headers stay 36 px and small tables remain at the top of the full card.
  Read fields, examples and measured limits in `references/layouts.md`.
- **Cycle with takeaways.** Use `circle` for 3–6 short icon labels around a
  ring and exactly two regular icon cards on the right. Keep labels concise;
  their type size follows the cards. See `references/layouts.md`.
- **Fixed collage and takeaways.** Use `illustration-points` for the supplied
  yellow collage and 2–4 titled icon points. Two points are centered vertically;
  no custom illustration or alignment setting. See `references/layouts.md`.
- **Introduce a person only when explicitly requested.** Use `self-intro`
  near the beginning, before or after the agenda, with `name`, `role`,
  an identified local PNG/JPEG photo in `src`, and **2–4** plain-text
  `items`. Find the person's photo in the user's materials or ask for it;
  never generate a substitute for a missing real-person photo. Preview the
  centred cover crop. Read the measured text budgets in `references/layouts.md`.
- **Every regular card must have an icon**, including a card with a large
  `value`. Numbered cards take no `icon`; neither do `chart-cards`.
- **Pictures use `image-points` or `image-gallery`.** One picture with 1–5
  conclusions is `image-points`, with a mandatory `text` and `icon` per point;
  `look` is `plates` by default or `plate`. Two or three pictures, each with a
  caption, are `image-gallery`: every image needs `src`, `title`, `text` and
  `icon`. Use the user's local PNG/JPEG files; generation needs explicit
  authorization. The legacy `image`, wide-image and dense-text drafts are
  unavailable to ordinary specs.
- **Pictures fill their frame by cropping, never stretching.** Relative `src`
  paths resolve from the command's working directory, not the spec directory.
  An unreadable file or another format stops the build; `LOW_RES_IMAGE` and
  `IMAGE_ASPECT` warn about softness and cropping. Preview the composition and
  use a larger or pre-cropped source when needed. Picture points and gallery
  captions take plain text, without formulas.
- **App screens use `screenshot-phone`, with 1–3 `images`.** Each image
  needs a local PNG/JPEG `src`; an optional plain-text `caption` adds an
  editable arrow annotation. The slide also needs `title` and `text`.
  Desktop interfaces use `screenshot-monitor`, with `title`, `src` and
  1–4 `points`, each containing `text` and `icon`. Both default to `cover`:
  phones keep the top of the interface, monitors keep its left edge. The
  second phone is clipped at the slide bottom. Explicit `fit: "contain"`
  shows the whole source with white margins when proportions differ.
  Preview every crop and keep arrow captions short; read the measured
  capacities in `references/layouts.md`.
- **A card takes exactly one of `title` or `value`.** Use a short string
  `value` for the slide's focus figure. **At most one card per slide may use
  `value`**, including numbered slides and `chart-cards`; all other cards use
  `title`. A slide with no large figure is valid. Keep further figures in
  ordinary titles or body text. The figure is twice the shared card-title
  size and steps down with the whole slide; read `references/layouts.md` for
  the ladder and ceilings. If it overflows, shorten it or move its unit into
  the caption. Formulas are forbidden in a card `value`.
- **Icons are requested by meaning**, never by filename: `"icon": "рост"`,
  `"icon": "безопасность"`. The matching file is looked up in an index of 355
  icons plus a layer of 411 business concepts. If nothing matches, the build
  stops and shows near misses.
- **No duplicates on a slide.** The same icon on two cards of the same slide
  is impossible — the allocator picks the next best match automatically. Across
  the deck, repeats are penalised, not forbidden.
- **Batch icon lookup.** Before building, resolve all icons in one call:
  `python3 scripts/find_icon.py рост эффективность команда`
  Use `--exclude` to skip already-used icons, `--concepts` to list the
  business vocabulary.
- **An unknown field is an error**, not a silent skip. A typo like `titel`
  will not become an empty heading on the slide.
- **Element count picks the layout variant:** 6 cards in `grid` give a
  two-by-three grid. A count the layout does not support fails immediately.
- **A card takes an `items` list** for bullet points, up to five, in any card
  layout. A list that is the whole slide is `cards` with a single card.
- **`"numbered": true` numbers the cards** of a `cards` slide (2–4 cards) or
  a `grid`: all grey, the number in a yellow circle where the icon would be.
  Take it when the order matters — steps, stages, a ranking; the cards then
  take no `icon`.
- **You do not choose the type size, and you cannot.** Each layout has a ladder
  of steps, and the build lays the slide out for real and keeps the largest step
  the text fits at — one size per slide, shared by all its cards. There is no
  font-size field in the spec. Write the text the slide needs.
- **Overflow is caught by measurement**, not by eye; `references/layouts.md`
  lists the measured limit for each layout. An `OVERFLOW` error means the text
  did not fit *at the smallest size the layout allows* — the build has already
  tried shrinking, so the only fixes are shorter text, a layout with fewer
  cards, or splitting the material across two slides.
- **A metric `value` must fit on one line, and the room runs out fast.** Three
  metrics is the tightest case, not six, because the type stays at 192 px while
  the column narrows: «174» fits there, «174 млрд» does not. Move the unit into
  the caption — `{"value": "174", "text": "Выручка, млрд"}`. A value that fits
  but fills its column to the edge is an error too: «3100 ₽» beside «1,9 %»
  reads as «₽1,9 %». The measured limits per metric count are in
  `references/layouts.md`.
- **A `statement` is one thought: three lines, about 50 characters.** Longer
  is a `STATEMENT_TOO_LONG` error — a paragraph is a `cards` slide with the
  claim as its title. Short words («не», «в», «на») are kept with the next word
  for you, so no line ends on one.
- **A `statement` has two looks, set by `look`:** `glass` (the default, a
  glass panel — for a quote, an audience question or a substantive phrase)
  and `cards` (two glass cards at a slant — for a short section name;
  **two lines, about 25 characters**). Choose by the phrase's purpose, not
  for visual rotation. The old yellow-pattern look is retired:
  `"look": "pattern"` is refused. **Two statements in a
  row are a `STATEMENT_RUN` error** whatever their looks: a statement is the
  pause between sections, not a slide on its own.
- **`versus` sets two options against each other** — before/after,
  ours/theirs: two `sides`, each `{"title", "subtitle", "text"}`, the first
  yellow on the left. **Each text is three to six lines (about 130–250
  characters), and the two differ by one line at most**; a subtitle goes on
  both sides or neither. Shorter, longer or lopsided is an error
  (`VERSUS_SHORT`, `VERSUS_TOO_LONG`, `VERSUS_SKEW`): write both sides to
  the same length and say what each option means in practice.
- **The `final` text is a short farewell: three lines, about 35 characters**
  — «Спасибо за внимание», «Вопросы?», «Спасибо за внимание! Вопросы?».
  Longer is an `OVERFLOW` error; the closing thesis of the talk belongs on
  a `statement` before it.
- **`timeline` has two looks:** `grey` (default, 3–5 points) and `yellow`
  (4–5 points). Every point carries a `title`, or none do.
- **`flow` steps take only `icon` and `text`** — no `title`. `look` is `line`
  (default) or `zigzag`, both for 4–5 steps. Only `line` takes a `summary`, one
  object `{"title", "text"}`, not a string. `highlight_last` is an independent
  boolean, `false` by default: `true` makes the final icon badge yellow in
  either look, including a `line` with summary. A `columns` heading is short: about
  11 characters on six columns, 18 on five.
- **Keep a `columns` slide title to one or two lines.** A third line or a
  headline below 80 px raises `COLUMNS_TITLE_DENSE`. Shorten the title and
  rebuild before delivery; the smaller legal step only protects the panel
  from overlap while the wording is revised.
- **Chart labels are measured too** (`CHART_LABELS`): one word of a category
  name must fit its column — on a `chart-two` half with five categories about
  9 characters, so long names belong on a `bar_h` chart. Axis names, value
  labels and legend start at 22 pt. Crowded labels or a long legend reduce
  all charts and legends on that slide together to 16.5 pt;
  `CHART_TEXT_REDUCED` warns which slide was affected. The build stops only
  if labels still collide.
  A `line`/`bar` legend of five or more series moves to the right column. A
  doughnut slice too narrow for its percentage is a warning: merge the small
  slices into one.
- **A chart title is copied, not written.** When the source names a chart,
  its `chart_title` carries that name, even if it repeats the slide title; when
  it does not, leave the field out — except on `chart-two`, where both charts
  need one to be told apart, so take the name of what each one shows from the
  source. A unit alone (`%`, `млн ₽`) is not a chart title; it can follow a
  named measure, as in `Доля одобрений, %`.
- **The note beside a chart title is two lines or nothing.** On `chart-two`
  and `chart-wide`, `note` goes with its `note_icon` and is exactly two
  lines, about 45–80 characters. One
  line is a `NOTE_SHORT` error — write the thought out or drop the note.
- **A long series goes across the slide.** More than 8 categories
  (twelve months, ten regions) is `chart-wide`: the chart the width of the
  slide, a large title and the two-line note above it, no points.
  Fewer than 6 stays on `chart` beside its points. Either mismatch is a
  `CHART_WIDTH` warning; a doughnut is never wide, and a long `bar_h`
  list stays on `chart` (its bars run down, and the wide plot is shorter).
- **A `chart` has two looks** (2.4.0): `"look": "plate"` (the default, one
  white card) and `"plates"`, the same slide with the card on a stack of two
  translucent ones. It is a look, not content: pick it for variety, and not on
  every chart of a deck — the stack leaves the chart less room. The first
  yellow on columns and the doughnut is a gradient (a native fill, editable in
  PowerPoint); a line is never one.
- **A `line` chart is drawn without dots or labels by default.**
  `value_labels: true` labels every point — only on 1 or 2 lines of at most 8
  points; past that it is a build error, so drop the labels (the value axis
  reads the values) or chart fewer categories. There is no way to label one
  point: say that figure in the slide text. `fill` is not offered.
- **A chart prints its numbers the way the source cells do.** Copy the cells'
  values as they are stored and their Excel format code into
  `number_format`: a cell showing 27% holds 0.27 with `0%` (or 27 with
  `0"%"`); `#,##0` for thousands, `0.0" млн"` for a unit. The labels and the
  workbook take that code, so the chart reads «27%», not «27», and keeps it
  after an edit in Excel. Write the code as the .xlsx stores it, as a library
  reads it from the cell: a dot for decimals, a comma for thousands
  (`#,##0.0`, not `# ##0,0`). A `%` code over values past 10 (1000%) is a
  build error. Without the field the labels show each value as written.
- **A doughnut's `center` is one short figure** — the number and its unit,
  as the source prints it («4,2 млн», «62%»): about 11 characters on
  `chart`, 8 on `chart-cards`, 7 on a `chart-two` half. The words go into
  the chart title. It is a cell of the chart's workbook, so an edit in
  Excel changes it; a longer one is a build error.
- **The `metrics` heading holds exactly one line** — about 25 characters. Unlike
  a card title it sits at a fixed 112 px and does not shrink, so a longer one is
  a build error, not a smaller heading.
- **Emoji in slide text is a build error**, and so are arrows («А → Б» — the
  font has no arrow; a sequence is a `flow` slide) and a middle dot used as a
  fake bullet or an inline separator — the corporate style excludes them.
- **The template has no slide numbers.** They were dropped deliberately.
- **The same icon on adjacent slides** raises a warning worth acting on.
- **Four slides of one layout in a row** raise a `REPEATED_LAYOUT` warning
  (two `statement`s in a row are already an error, see above),
  whatever the card count — the run reads as one slide repeated. Catch it in
  the plan's slide list, where regrouping costs a line, not a rebuild.
- **Layout concentration is advisory.** With at least ten content slides,
  `LAYOUT_DOMINANCE` flags one family above 50% of the content, and
  `LAYOUT_CONCENTRATION` flags more than six occurrences in a sliding window
  of ten. Title, agenda and final slides are excluded; other slides count.
  Counts and looks are one public layout family, while chart types (including
  the ordered types in `chart-two`) remain distinct. Overlapping windows of
  one family are grouped, with original slide numbers and a peak window.
  Deck share and local concentration may both warn about the same material.
  Reconsider the grouping and explanation, preserving formulas, sources and
  notes. There is no quota or automatic rearrangement; a specialized deck can
  keep its format with a stated reason in the delivery. Short decks still
  receive the existing consecutive-run check. Runtime checks cover the deck
  and content windows, not inferred sections.
- **Any slide can carry `"notes"`** — a string written to the .pptx notes
  pane, invisible on the slide itself. Two to four sentences: what the
  presenter says out loud and the slide does not show. Not a retelling of the
  slide, and never a place to park text that did not fit — if it matters to the
  audience it belongs on a slide, and if it does not, it belongs nowhere. Notes
  longer than 600 characters raise a warning.
- **The plan is not a second spec.** `results.plan.md` is a working document:
  nothing in the build reads it, no script parses it, and it is not kept in step
  with the deck once the JSON exists. That holds all the more for the detailed
  form, which carries the same sentences as the spec — update both and they
  disagree about the same deck by the second edit. Nothing detects a skipped
  plan step either — it is worth doing because the story is cheap to fix before
  there are slides, not because a check enforces it.
- **The intermediate HTML is deleted** after the build. Pass `--keep-html` for
  diagnostics. Formula spans in that raw HTML are intentionally empty markers;
  equations are painted only by the PPTX and PNG output adapters.

## Resources

- `references/layouts.md` — spec format, layouts, fields, text limits. Read
  this while composing a deck.
- `references/editing.md` — how to change a deck without breaking it. Read
  when the user asks for edits.
- `references/extending.md` — how to add or alter a layout. Read only when the
  template itself changes.
- `assets/example-deck.json` — a seven-slide spec to copy from.
- `assets/example-plan.md` — the plan that deck was written from, in the
  detailed form: the shape of step 3 when the plan is agreed first, and what a
  supplied plan is checked against.
- `assets/example-plan-quick.md` — the same deck in the short form, for when
  the user chose to build straight away.
- `scripts/build_deck.py` — build and validate. `--check` validates without
  writing files; `--keep-html` keeps the intermediate HTML.
- `scripts/find_icon.py` — look up icons by meaning. Batch mode: pass several
  queries; `--concepts` lists the business vocabulary; `--exclude` skips
  already-used icons.
- `scripts/preview_deck.py` — render slides to PNG.
- `scripts/selftest.py` — skill self-check; run after editing the template.
- `scripts/sync_layouts.py` — regenerate layout fragments from the template.
- `scripts/pack_icons.py` — rebuild the icon archive. Not called at build time.

Every script supports `--help`.

## Output format

**Done**
Path to the `.pptx`, number of slides, layouts used.

**Checks**
What `build_deck.py` reported, including any remaining warnings — stated
plainly, not omitted.

**Next**
Where the spec lives and that edits go through it.
