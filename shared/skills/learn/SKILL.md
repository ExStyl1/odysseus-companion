---
name: "learn"
description: "Сохранение важных решений и знаний из текущего разговора в локальном NESSY.md."
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.

Ссылки на прежние имена в исходных руководствах разрешай до загрузки навыка: «debugging» → «systematic-debugging», режим «debugging». Старое имя не является отдельной командой.
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


# Learn Skill for Nessy CLI

Review the current conversation history and identify strategic, reusable project knowledge that should be captured in
the local NESSY.md file.

## Available MCP Tools

Use these tools during **Session Review** to enrich captured knowledge:

| Tool | When to Use |
|------|-------------|
| **Jira** (`dp_jira_*`) | Link learned patterns to specific tasks, epics, or incidents mentioned during session |
| **Wiki** (`dp_wixie_*`) | Cross-reference with existing documentation — note gaps or pages to update |
| **Sage** (`dp_sage_*`) | Capture useful log queries, endpoints, monitoring patterns discovered during debugging |
| **GitLab** (`dp_gitlab_*`) | Record repository paths, pipeline patterns, MR workflows encountered |

**Guideline**: Use MCP tools to add references and links to captured knowledge. NESSY.md should point to external systems (Jira tasks, Wiki pages, Sage queries, GitLab repos) for traceability.

## Activation Triggers

- "learn", "save knowledge", "update nessy.md"
- "capture learnings", "remember this pattern"
- At end of significant work sessions

## Analysis Process

### 1. Review Session History

- Examine all files read and modified during this session
- Identify patterns discovered while working on tasks
- Note architectural insights gained from exploring the codebase

### 2. Extract Strategic Knowledge

- Filter out tactical details (bug fixes, specific implementations)
- Focus on reusable patterns and project structure
- Identify conventions and architectural decisions

### 3. Categorize Findings

- Project architecture and structure
- Data flow patterns
- External service integrations
- Project-specific conventions
- Key dependencies and their purposes
- Configuration patterns
- Testing strategies
- Build and deployment processes
- Operational knowledge (debugging, DevOps)

## What Qualifies for Local NESSY.md

**INCLUDE** - Strategic discoveries from this session:

- Architectural patterns uncovered while working
- Project structure insights gained from navigation
- Conventions noticed across multiple files
- Integration patterns discovered
- Configuration approaches identified
- Testing strategies observed
- Build/deployment processes encountered
- Performance optimizations found
- Security implementations discovered
- Operational knowledge:
    - Database locations and connection details per environment
    - Useful queries discovered during debugging
    - Testing procedures and verification steps
    - Deployment workflows and commands
    - Log locations and monitoring endpoints
    - Environment-specific quirks and gotchas

**EXCLUDE** - Session-specific tactical work:

- The specific bug we fixed
- The particular feature we implemented
- Temporary workarounds we used
- One-off code changes
- TODO items we encountered
- Historical context about changes

## Decision Criteria

Ask yourself for each discovery:

- "Will this help understand the project in 6 months?"
- "Is this a pattern that appears multiple times?"
- "Does this represent a project-wide convention?"
- "Would knowing this speed up future development?"
- "Would this save debugging time in the future?" (for operational knowledge)

## Workflow

### 1. Check Existing Local NESSY.md

First, check if local NESSY.md exists and read its current content to avoid duplication.

### 2. Early Exit if Nothing Found

If no new strategic knowledge was discovered during this session:

- Report "no new strategic knowledge to capture"
- End the skill execution

### 3. Present Discovered Knowledge

Present discovered knowledge formatted for local NESSY.md:

```markdown
## [Section Name]

- Discovery 1
- Discovery 2
```

### 4. User Confirmation

Use `ask_user_question` tool for granular selection of what to save.

Build options dynamically based on discoveries:

- First option: "All knowledge" - save everything discovered
- Last option: "None" - skip saving entirely
- Middle options: Individual knowledge items (up to 2-3 most significant)
- User can always type custom selection via "Other"

Example with 3 discoveries:

```
question: "Which knowledge should I save to NESSY.md?"
options:
  - label: "All (3 items)"
    description: "Save all discovered patterns"
  - label: "Testing pattern"
    description: "Table-driven tests with testify"
  - label: "Config approach"
    description: "Environment-based configuration loading"
  - label: "None"
    description: "Skip saving, nothing worth keeping"
```

Example with 1 discovery:

```
question: "Save this knowledge to NESSY.md?"
options:
  - label: "Yes"
    description: "Save: [brief description of the discovery]"
  - label: "No"
    description: "Skip saving"
```

After user selection:

- "All" → save everything via `save_memory`
- "None" → end without saving
- Specific item → save only that item via `save_memory`
- "Other" → user types custom selection

## Closing the spec loop (draft → as-built)

`learn` also closes the analyst loop. A spec produced by `spec-create` lives in the service's
`docs/` with `status: draft` and is the source development follows. After implementation, use
`learn` to bring that `draft` spec to `as-built` so it reflects "how it was actually built" rather
than rotting:

- flip `status: draft → as-built` in the affected documents' frontmatter;
- remove the stage banner admonition from `index.md`;
- drop the `[допущение]` / `[?]` grounding marks — everything is now known from the code;
- reconcile fields, error codes and scenarios that diverged from the implementation (the same
  invariants `spec-review` checks: scenario fields ↔ `database/`, codes ↔ `error_codes.md`,
  contract ↔ `api-schemas/`).

This is not a separate skill — it is the same end-to-end `learn`, whose target now includes the
spec tree. Trigger it after code with phrases like "приведи спеку к as-built", "обнови спеку",
"close the spec". Present the diff of proposed spec edits and confirm via `ask_user_question`
before writing, exactly as with NESSY.md knowledge. `spec-review` afterwards should find no
`[допущение]`/`[?]` marks left.

## Important Guidelines

- Only capture genuinely new discoveries from this session
- Don't duplicate existing local or global NESSY.md content
- Focus on patterns observed, not specific code written
- Keep descriptions concise and actionable
- MUST use `ask_user_question` tool for confirmation (not plain text questions)
- If no knowledge found, exit early without asking
- When closing the spec loop, no `[допущение]`/`[?]` marks should remain in `as-built` documents
