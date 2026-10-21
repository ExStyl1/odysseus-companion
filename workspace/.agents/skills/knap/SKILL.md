---
name: "knap"
description: "Пакетное создание Markdown-заметок из шаблонов и JSON/CSV с помощью Knap CLI."
disable-model-invocation: false
user-invocable: true
when_to_use: "При работе с хранилищем заметок или его форматами; передай путь хранилища, нужные файлы и ожидаемую структуру."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Навык можно выбирать автоматически, когда текущая задача соответствует описанию. Загружай только нужный режим и относящиеся к нему ресурсы.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.
<!-- /odysseus-invocation-policy -->

## Odysseus execution profile: local, browser and Obsidian

This installation is configured for local execution. This profile narrows the
upstream workflows below and takes precedence over their optional online modes.
Use the current Nessy agent/model, local files, installed CLI tools and libraries.
Browser interaction and the local Obsidian integration are explicitly allowed.

- Do not request, configure or use extra API keys, cloud AI providers, hosted
  rendering, SaaS MCP connections or another agent runtime to complete this skill.
- Use local inputs, cached/bundled assets and installed local engines. When web
  content is necessary, use the host's browser tools; do not replace them with a
  provider API, authenticated scraping service or non-browser cloud connector.
- Select documented offline branches without waiting for cloud sign-in. Ignore
  upstream instructions to refresh skills remotely, log into a provider, generate
  media remotely, publish through a SaaS API, or invoke a removed skill.
- Use native host tools for browser control, subagents and language servers when
  available. A local LSP/MCP adapter is allowed; a foreign agent/plugin runtime is
  not a prerequisite to install. Report missing local capability honestly.
- If the requested output cannot be produced locally, explain the missing local
  input or tool. Do not silently switch to a cloud service or claim completion.
  Installing a skill does not install its local engines or dependencies.

For Obsidian commands, use the running local Obsidian app. File-format and
template operations stay local; remote page reading uses the browser.

---


# Knap

Use Knap CLI to render Markdown templates with variables, filters, and logic.

If not installed: `npm install -g knap` (requires Node.js 20 or later). Alternatively, use `npx knap`.

Run `knap --help` for available commands and options. Discover the language through the CLI's offline reference:

```bash
knap help syntax
knap help filters
knap help filter date
knap help tags
knap help tag for
```

Use the lists to find names, then request individual help for syntax, parameters, and examples with expected output.

## Usage

Render a template with JSON variables:

```bash
knap render template.md --data article.json -o note.md
```

Supply a template and data inline:

```bash
knap render -t '# {{ title | trim }}' --data-json '{"title":"Hello"}'
```

Override a variable or pipe JSON data:

```bash
knap render template.md --data article.json --set 'title=Custom title'
cat article.json | knap render template.md --data -
```

Data must be a JSON object; its properties become template variables. `--set` overrides literal top-level keys with strings. Use JSON for nested objects, arrays, numbers, and booleans.

Choose one template source (file, `-t`, or stdin) and one data source (`--data` or `--data-json`). Only one input can read stdin. Without a template file or `-t`, Knap reads the template from stdin.

Output defaults to stdout. `-o` creates parent directories and overwrites the destination after rendering succeeds. Errors exit with status `1`; diagnostics go to stderr. Warnings can accompany successful output.

## Templates

Use `{{ variable }}` for values, `|` for filters, and `{% ... %}` for logic. For example, save this as `template.md`:

```knap
---
{{ title | yaml_property:"title" }}
{{ tags | yaml_property:"tags" }}
---
# {{ title | trim }}
{% if author %}
By {{ author }}
{% endif %}

{{ content }}
```

Use `yaml_property` for complete frontmatter properties so values are quoted and indented correctly. The CLI includes standard filters, but does not supply Web Clipper browser variables, selectors, prompts, or DOM-dependent HTML filters. Supply variables through JSON.

Check a template before rendering:

```bash
knap validate template.md
```

Validation checks syntax, filter names, and static filter arguments without data or file output. It does not check variable existence, runtime values, or dynamic arguments; render with real data to check runtime behavior. Diagnostics go to stderr and include relevant help commands.

## Defuddle pipeline

Extract a web page as JSON with Markdown content, then render it into a note:

```bash
defuddle parse https://example.com/article --md --json \
  | knap render template.md --data - -o note.md
```

Defuddle's JSON properties, such as `title` and `content`, become template variables directly.

## Batch rendering

Create one file per CSV row, JSON array object, or JSON file in a folder:

```bash
knap batch template.md --data articles.csv --output-dir notes \
  --filename '{{ title | safe_name }}.md'
```

Use `--data articles.json` for an array or `--data ./articles` for a folder of JSON objects. CSV headers become variable names and values remain strings. Piped data defaults to JSON; add `--format csv` for piped CSV.

Use `--dry-run` to validate and list output paths without writing files. Existing files require `--overwrite`, including during a dry run. Duplicate output names within a batch are errors even with `--overwrite`.

Filename templates must produce a single filename with its extension, without directories. Use `safe_name` for data-derived names. Without `--filename`, Knap preserves source JSON basenames or numbers CSV rows and array items as `1.md`, `2.md`, and so on.
