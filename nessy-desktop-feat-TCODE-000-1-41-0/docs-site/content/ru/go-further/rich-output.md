# Rich Output

Conversations in Nessy Desktop are more than plain text. Когда response contains structured data, relationship, document или code change, агент emits rich block rendered natively in session view — no setup required. Agent picks block type fitting content, and you can ask for a specific one.

## Data Tables

For structured rows and columns agent uses interactive **datatable** rather than static Markdown table. You can:

- Click column header to sort.
- Type to filter across columns.
- See values formatted by type — currencies, percentages, dates and status pills render with appropriate styling.

```text
"Show our top 10 customers by revenue"
```

Column types include text, number, currency, percentage (colored by sign), boolean, date and badge.

## Spreadsheets

When data is report-shaped or export likely, agent renders **spreadsheet** block — Excel-style grid with row numbers and column letters — downloadable as `.xlsx` or `.csv` straight from conversation.

```text
"Build a Q4 revenue report by region"
```

## Diagrams

Agent renders **Mermaid** diagrams as themed SVGs and reaches for them when picture explains system better than prose — flowcharts, sequence diagrams, entity-relationship diagrams, state machines and more.

```text
"Diagram how our authentication flow works"
```

## HTML Preview

Rich HTML — email body, newsletter, styled report — renders inline as live **HTML preview** in sandboxed frame, preserving CSS, table layouts and formatting instead of flattening to text.

```text
"Show me that HTML report"
```

## PDF Preview

PDF files display inline as **PDF preview** with expand control for full multi-page navigation, so you can glance at document without opening another app.

```text
"Show me the Q4 report PDF"
```

## Markdown Preview

Point agent at `.md` file on disk — spec, plan, draft — and instead of pasting raw contents into fenced block, it can surface **markdown preview** in place. You see rendered document: headings, tables, syntax-highlighted code, lists, rendered by same chat renderer.

```text
"Draft a project spec and show it to me"
```

Reference is always absolute path, and safety layer constrains where it may point: home directory, system temp location or workspace directory. Anything outside roots refused — same check gating other preview blocks.

## Code Diffs

When agent edits files it shows change as unified **diff** — removed lines in red, added lines in green — so you can review exactly what changed before accepting.

```text
"Refactor the auth module to async/await"
```

## How the Agent Chooses

Block type follows content shape:

| Content | Block |
| ------- | ----- |
| Rows and columns | datatable or spreadsheet |
| Relationship or flow | Mermaid diagram |
| Rich HTML (emails, reports) | HTML preview |
| PDF file | PDF preview |
| Markdown file (specs, plans) | markdown preview |
| File edit | unified diff |
| Everything else | regular Markdown |

You can override choice — "show this as a spreadsheet", "draw a diagram of this" or "render `~/notes/decision.md`".

::: tip
When result runs to hundreds of rows, agent saves it to file and links that instead of pouring every row into chat — keeping session snappy.
:::

## Tool Results Stay in History

Every tool call and result stays attached to session, so reviewer can inspect exactly what agent did — which command ran, what it returned, what changed — before accepting work. See [conversations](../core-concepts/conversations) for how session history preserved.
