# Rich Output

Conversations in Nessy Desktop are more than plain text. When a response contains structured data, a relationship, a document, or a code change, the agent emits a rich block that renders natively in the session view — no setup required. The agent picks the block type that fits the content, and you can ask for a specific one.

## Data Tables

For structured rows and columns the agent uses an interactive **datatable** rather than a static Markdown table. You can:

- Click a column header to sort.
- Type to filter across columns.
- See values formatted by type — currencies, percentages, dates, and status pills render with appropriate styling.

```text
"Show our top 10 customers by revenue"
```

Column types include text, number, currency, percentage (colored by sign), boolean, date, and badge.

## Spreadsheets

When the data is report-shaped or you may want to export it, the agent renders a **spreadsheet** block — an Excel-style grid with row numbers and column letters — that can be downloaded as `.xlsx` or `.csv` straight from the conversation.

```text
"Build a Q4 revenue report by region"
```

## Diagrams

The agent renders **Mermaid** diagrams as themed SVGs, and reaches for them when a picture explains a system better than prose — flowcharts, sequence diagrams, entity-relationship diagrams, state machines, and more.

```text
"Diagram how our authentication flow works"
```

## HTML Preview

Rich HTML — an email body, a newsletter, a styled report — renders inline as a live **HTML preview** in a sandboxed frame, preserving CSS, table layouts, and formatting instead of flattening it to text.

```text
"Show me that HTML report"
```

## PDF Preview

PDF files display inline as a **PDF preview** with an expand control for full multi-page navigation, so you can glance at a document without opening another app.

```text
"Show me the Q4 report PDF"
```

## Markdown Preview

Point the agent at some `.md` file sitting on disk — maybe a spec, a plan, an early draft — and instead of pasting its raw contents into a fenced block, it can surface a **markdown preview** in place. What you see is the rendered document: headings, tables, code with syntax highlighting, lists, all drawn by the same renderer chat uses everywhere else.

```text
"Draft a project spec and show it to me"
```

The reference is always an absolute path, and a safety layer constrains where it may point: your home directory, the system temp location, or a workspace directory. Anything outside those roots is refused — the same check that gates the other preview blocks.

## Code Diffs

When the agent edits files it shows the change as a unified **diff** — removed lines in red, added lines in green — so you can review exactly what changed before accepting it.

```text
"Refactor the auth module to async/await"
```

## How the Agent Chooses

The block type follows the shape of the content:

| Content | Block |
| ------------------------------------ | ----------------- |
| Rows and columns | datatable or spreadsheet |
| A relationship or flow | Mermaid diagram |
| Rich HTML (emails, reports) | HTML preview |
| A PDF file | PDF preview |
| A Markdown file (specs, plans) | markdown preview |
| A file edit | unified diff |
| Everything else | regular Markdown |

You can always override the choice — "show this as a spreadsheet", "draw a diagram of this", or "render `~/notes/decision.md`".

::: tip
When a result runs to hundreds of rows, the agent saves it to a file and links to that instead of pouring every row into the chat — which keeps the session snappy.
:::

## Tool Results Stay in History

Every tool call and its result stays attached to the session, so a reviewer can inspect exactly what the agent did — which command ran, what it returned, what changed — before accepting the work. See [conversations](../core-concepts/conversations) for how session history is preserved.
