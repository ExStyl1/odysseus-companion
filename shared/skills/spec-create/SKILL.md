---
name: "spec-create"
description: "Проектирование докаскод-спецификации из эпика через интервью: сценарии, база данных и API."
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.

Ссылки на прежние имена в исходных руководствах разрешай до загрузки навыка: «brainstorm» → «brainstorming», режим «brainstorm». Старое имя не является отдельной командой.
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


# Spec-Create Skill for Nessy CLI

Turn a thin epic task into a project spec through dialogue — **inventing nothing**.

This is the analyst counterpart of `brainstorm`: it reuses the same one-question-at-a-time DNA,
but instead of a solution design it collects a description of the future service/feature in our
format (scenarios, DB, API). The result is a tree of documents following the canonical template
(embedded below).

The spec lives in the service's `docs/` and is the source development follows —
`planning-task` reads it as input, turning its scenarios into plan tasks and tests.

## Available MCP Tools

| Tool | When to Use |
|------|-------------|
| **Jira** (`dp_jira_*`) | **Primary input** — fetch the epic task, its description, links, acceptance notes |
| **Wiki** (`dp_wixie_*`) | Fetch linked business requirements (БТ), domain glossary, existing docs |
| **Code Search** (`dp_code-search_*`) | Check whether the service already has a docs tree / api-schemas to match format and terms |
| **GitLab** (`dp_gitlab_*`) | Locate the service repo and its existing `docs/` tree |

**Guideline**: pull the epic and requirements before writing anything. Never fabricate scenarios
or fields to fill a gap — a plausible-looking invented spec is worse than an empty one.

## Activation Triggers

- "спека из эпика", "spec-create", "сделай спеку по задаче", "эпик → спека"
- "draft a spec from the epic", "draft the spec"

## Process

### 1. Gather context

Pull the epic task from Jira (`dp_jira_*`) and the linked business requirements from Wiki
(`dp_wixie_*`). If the service already has a docs tree, read it for format, terminology and
glossary. **Do not start writing until context is gathered.**

### 2. Interview, one question at a time

Clarify the unknowns using `ask_user_question`, one question per message (prefer multiple choice):

- external systems and call direction (who calls whom);
- sync vs async;
- error format and error codes;
- data fields and their sources;
- edge cases and alternative branches.

**Do not guess.** If there is no answer, it is an open question — mark it, do not fill it in.

### 3. Design the tree

Produce the tree per the canonical template (below):

- `index.md` — glossary, domain overview, integrations;
- `scenarios/SXX` — sequence diagram + "Основной / Альтернативный сценарий" table with exact
  error codes (these are the acceptance criteria → future componentTest);
- `database/` — table fields;
- `api/` — contract **by reference** to `api-schemas/`, not duplicated.

### 4. Mark provenance

Tag every fact: `[эпик]` / `[БТ]` / `[допущение]` / `[?]`. Collect all `[допущение]` and `[?]`
into an "Открытые вопросы" section. These marks are literal tokens written into the docs.

### 5. Finish

Set the `epic`/`bt` frontmatter links. Offer next steps: `spec-review`
(cross-check) and handoff to the developer via `brainstorm`.

## Grounding convention (against hallucination)

Each unverified fact in the spec is tagged with its origin:

- `[эпик]` — taken from the epic;
- `[БТ]` — from business requirements;
- `[допущение]` — the analyst's assumption, needs confirmation;
- `[?]` — open question, no answer yet.

`spec-create` must **ask, not fill**. Everything `[допущение]`/`[?]` goes into "Открытые вопросы".

---

## Canonical spec template (embedded)

> Extracted from `tgw-tips-service` / `tgw-merchant-service` — the structure that has actually
> settled. A spec is **not one file but a per-service tree**. Every document carries `status` in
> frontmatter: `draft` (designed ahead) → `review` → `as-built` (reflects implementation).

### Tree structure

```
<service>/
  index.md                     # service overview
  scenarios/
    index.md
    S01-<name>.md              # scenarios (sequence + основной/альт table)
    common-<name>.md           # reusable sub-scenarios
  database/
    index.md
    <SCHEMA>.<TABLE>.md        # fields + indexes
  api/
    index.md
    error_codes.md
    operations/
      <name>_<METHOD>.md       # REST operation (contract → link to api-schemas)
  queues/
    index.md
    <topic>.md
```

### `index.md` — service overview

```markdown
---
id: <service>-index
title: <Service Title>
sidebar_position: 1
epic: <link to Jira epic>        # [эпик]
bt: <link to БТ in Confluence>   # [БТ]
---

# <Service Title>

> 🟠 **Business critical +**    <!-- criticality level -->

## 📖 Глоссарий
| Термин | Описание |
|--------|----------|

## 🏦 Обзор бизнес-домена
<What the service does and why. For draft — from epic/БТ with [эпик]/[БТ] marks.>

### Роль в экосистеме
<Processing pipeline: numbered steps.>

### Бизнес-сущности и связи
<ASCII or mermaid relationship diagram.>

## 🔗 Интеграция с внешними системами
<Source and consumer systems.>

## 🏗️ C4-диаграмма архитектуры
- [<service>.c4](<link to architecture repo>)
- [Architecture Views](<link to views>)

### Краткое описание компонентов
| Компонент | Описание |
|-----------|----------|

## 👥 Команда разработки
- [Структурное подразделение](<my.tbank>)

## 📊 Мониторинг и наблюдаемость
### Endpoints для мониторинга
### Поиск и анализ логов (Sage)
### Метрики (Prometheus)
### Дашборды Grafana
### Алертинг

## 📦 Версионирование
## 🚀 Развёртывание
```

### `scenarios/S01-<name>.md` — scenario

> **The core of the spec.** The "Основной / Альтернативный сценарий" table = acceptance criteria.
> Alternative branches and error codes are designed ahead — they become the
> componentTest in `planning-task`.

```markdown
---
id: S01-<name>
title: 'S01: <scenario name>'
sidebar_position: 1
---

# [<SERVICE>] S01 <scenario name>

## Диаграмма последовательности
​```mermaid
sequenceDiagram
    autonumber
    participant A
    participant B
    A->>B: ...
​```

## Описание
<table>
  <tr><th>Шаг</th><th>Основной сценарий</th><th>Альтернативный сценарий</th></tr>
  <tr>
    <td>1</td>
    <td><b>...</b><br/>Step description. DB fields — exact names from database/.</td>
    <td>Errors — exact codes from error_codes.md (e.g. <code>-902</code>).</td>
  </tr>
</table>

## Связанные документы
- [Таблица <SCHEMA>.<TABLE>](../database/<SCHEMA>-<TABLE>)
- [Коды ошибок](../api/error-codes)
```

**Consistency invariant** (checked by `spec-review`): field names and error codes in the scenario
match `database/` and `error_codes.md` verbatim.

### `database/<SCHEMA>.<TABLE>.md`

```markdown
# <SCHEMA>.<TABLE>

## Поля таблицы
| Поле | Тип | Nullable | Описание |
|------|-----|----------|----------|

## Индексы
| Индекс | Поля | Тип |
|--------|------|-----|
```

### `api/operations/<name>_<METHOD>.md`

> The contract is **not duplicated** in text — link to the OpenAPI in `api-schemas/` (the build
> extracts them per project, grouped via `x-tagGroups`).

```markdown
# <METHOD> /<path>

## Спецификация API
<Link to the OpenAPI operation in api-schemas/.>

## Карточка сервиса
## Хосты
## Входные параметры
## Выходные параметры
### Структура results
## Сценарий работы сервиса
<Link to the matching scenarios/SXX.>
## Коды ошибок
## Связанные документы
```

### `queues/<topic>.md`

```markdown
# <topic>
<Queue/topic purpose, message format, producers/consumers,
link to the schema in api-schemas/ or events-schemas.>
```

### Frontmatter fields (summary)

| Field | Where | Purpose |
|-------|-------|---------|
| `epic` | `index.md` | link to the epic |
| `bt` | `index.md` | link to business requirements |

---

## Example

```
User: сделай спеку по задаче TACP-1234 из эпика чаевых
→ Step 1: pull TACP-1234 + БТ from Wiki (dp_jira_*, dp_wixie_*)
→ Step 2: ask — Kafka or REST on input? which error codes? which fields to persist?
→ Step 3: assemble index + scenarios/S01 (основной/альт + codes) + database + api link
→ Step 4: mark [допущение] where the analyst didn't confirm; collect "Открытые вопросы"
→ Step 5: offer spec-review
```

## When to use

At the very start of the analyst leg, when there is an epic task and it must be turned into a
project spec before the developer takes on design.

## Main risk

An LLM will happily write plausible scenarios and DB fields — and that is **worse** than an empty
spec, because it looks authoritative. The skill's discipline: ask, don't fill; mark everything
unconfirmed and move it into "Открытые вопросы".
