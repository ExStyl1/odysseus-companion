---
name: "spec-import"
description: "Перенос спецификации из Confluence в дерево докаскод-документов с переписыванием ссылок и явными TODO."
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

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


# Spec-Import Skill for Nessy CLI

Move an existing spec from Confluence into docs-as-code, bringing it to one shared structure.

This is a one-off onboarding skill: **not** a mechanical html→md conversion, but **conforming the
content to the canonical template** (the tree below) so every team spec is laid out identically.
It is not part of the working conveyor — it lives next to project setup.

## Available MCP Tools

| Tool | When to Use |
|------|-------------|
| **Wiki** (`dp_wixie_*`) | **Primary source** — read the Confluence page and its children |
| **GitLab** (`dp_gitlab_*`) | Locate the target service repo and its `docs/` tree |
| **Code Search** (`dp_code-search_*`) | Find where OpenAPI schemas / `api-schemas/` live to extract into |
| **Jira** (`dp_jira_*`) | Resolve epic/task references found in the source page (for links) |

**Guideline**: the source is the Confluence page(s). Everything else is used to place files and
fix links correctly.

## Activation Triggers

- "перенеси спеку из вики", "spec-import", "мигрируй документацию в докаскод"
- "import spec from Confluence"

## Process

1. **Pull the source.** Read the Confluence page (and nested pages) via `dp_wixie_*`.
2. **Lay out by tree.** Content → `index.md` (overview/glossary/monitoring), `scenarios/`
   (sequences), `database/` (tables), `api/` (operations), `queues/`. Diagrams → `mermaid`.
3. **Conform to the template.** Sections required by the template but missing from the source are
   created with an explicit `<!-- TODO: нет в исходнике -->` — do **not** invent content.
   Placeholders from the source (`XXXXXX`, `pageId=XXXXXX`) are kept as visible TODOs to fill in.
4. **Fix links and schemas.** Absolute `/docs` links → `/docs/projects/<name>`; nested API schemas
   extracted into `api-schemas/`; internal cross-references → relative tree paths.
5. **Report.** Report the list of created files and remaining TODOs/placeholders.

## Diagram Format Rule

**All UML diagrams must be converted to Mermaid format.** This includes:

- Sequence diagrams → `sequenceDiagram`
- Class diagrams → `classDiagram`
- State diagrams → `stateDiagram`
- Flowcharts → `flowchart`
- Component diagrams → `flowchart` or `graph`
- Deployment diagrams → `flowchart` or `graph`

If the source contains images (Visio, PlantUML exports, draw.io PNGs), recreate them in Mermaid syntax rather than embedding as images. Mermaid blocks must use standard markdown code fences:

\`\`\`mermaid
<diagram syntax>
\`\`\`

## MDX Format Requirements

Documentation is built locally via **auto-doc** in Docker. All pages **must comply with MDX format** to pass the build.

### JSX Character Escaping

MDX parses JSX expressions, so the following characters **must be escaped** in regular text:

| Character | Problem | Escape sequence | Example |
|-----------|---------|-----------------|---------|
| `<` | Opening JSX tag | `&lt;` or `\<` | `&lt;div&gt;` or `\<div\>` |
| `>` | Closing JSX tag | `&gt;` or `\>` | `&lt;/div&gt;` |
| `{` | JSX expression start | `&lbrace;` or `\{` | `&lbrace;count\}` |
| `}` | JSX expression end | `&rbrace;` or `\}` | `\&rbrace;` |
| `@` | May trigger decorators | `\@` | `\@deprecated` |

**Examples:**

```md
<!-- WRONG: will break MDX build -->
Use <status> field with values {NEW, PROCESSING}

<!-- CORRECT: escaped -->
Use &lt;status&gt; field with values \{NEW, PROCESSING\}
```

### Date and Time Formats

Use ISO 8601 format for dates and timestamps to ensure consistent parsing:

- **Date only:** `YYYY-MM-DD` (e.g., `2025-01-15`)
- **Date with time:** `YYYY-MM-DDTHH:MM:SSZ` (e.g., `2025-01-15T14:30:00Z`)
- **Date with time (local):** `YYYY-MM-DD HH:MM:SS` (e.g., `2025-01-15 14:30:00`)

Avoid ambiguous formats like `DD.MM.YYYY` or `MM/DD/YYYY`.

### Code Blocks

- Always specify the language identifier: \`\`\`json, \`\`\`bash, \`\`\`typescript
- Do not nest unescaped curly braces in code blocks — escape if part of prose
- For JSON with placeholders, use angle brackets with escaping: `&lt;service-name&gt;`

### Frontmatter

- YAML frontmatter must be valid YAML (use quotes for strings with special characters)
- Do not use unescaped `{`, `}`, `<`, `>` in frontmatter values

### Links and Paths

- Use relative paths for intra-spec links: `../database/SCHEMA.TABLE`
- Escape angle brackets in URLs if written inline: `&lt;https://...&gt;`
- Prefer markdown link syntax: `[text](url)` over bare URLs

### Common Pitfalls

| Wrong | Correct |
|-------|---------|
| `Response: {status: "ok"}` | `Response: \{status: "ok"\}` |
| `Field <id> is required` | `Field &lt;id&gt; is required` |
| `@Transactional` | `\@Transactional` |
| `15.01.2025` | `2025-01-15` |

## Table Formatting Rules

| Table type | Format | When to use |
|------------|--------|-------------|
| **Simple** | Markdown | Glossaries, field lists, error codes, component lists — anything that fits cleanly in `| col | col |` syntax |
| **Complex** | HTML `<table>` | Scenario tables with step-by-step branches (Основной/Альтернативный сценарий), multi-row cells, nested structures |

**HTML tables must be human-readable:**

- Use explicit indentation (2 spaces per level)
- One `<tr>` per line
- Keep `<td>`/`<th>` content on the same line or indented consistently
- Avoid minified HTML — the source should be maintainable in Git diffs

Example of acceptable HTML table:

```html
<table>
  <tr><th>Шаг</th><th>Основной сценарий</th><th>Альтернативный сценарий</th></tr>
  <tr>
    <td>1</td>
    <td><b>Действие</b><br/>Описание.</td>
    <td>Код ошибки <code>-902</code>.</td>
  </tr>
</table>
```

## Canonical tree it produces

```
<service>/
  index.md                     # overview (glossary, domain, monitoring, deploy)
  scenarios/
    index.md
    S01-<name>.md              # sequence + "Основной / Альтернативный сценарий" table
  database/
    index.md
    <SCHEMA>.<TABLE>.md        # fields + indexes
  api/
    index.md
    error_codes.md
    operations/<name>_<METHOD>.md   # contract → link to api-schemas/
  queues/
    index.md
    <topic>.md
```

The full section-by-section template (frontmatter, scenario table, DB/API/queue layouts) lives in
`spec-create` — this skill produces the same structure. Key invariant to preserve while importing:
field names and error codes in scenarios must match `database/` and `error_codes.md` verbatim; if
the source disagrees, keep the source values and flag the mismatch as a TODO rather than silently
"fixing" it.

## Example

```
User: перенеси спеку tips-service из вики в докаскод
→ Step 2: split into index + scenarios/S01 + database/TIPS.TRANSACTION_REQUEST + api
→ Step 3: "Мониторинг"/"Деплой" sections absent in source → create with TODO
→ Step 4: /docs → /docs/projects/tgw-tips-service; extract openapi into api-schemas/
→ Step 5: report: 6 files, 3 TODOs (wiki pageId, unit number, team link)
```

## When to use

Once per service, when bringing its documentation into docs-as-code. Afterwards the service lives
by the conveyor (`spec-create` for new work, `spec-review` for checks).

## Main risk

Reducing it to a dumb html→md conversion. The value is not in moving letters, but in the output
being **structurally identical to every other spec**. The skill conforms to the template and marks
gaps honestly.
