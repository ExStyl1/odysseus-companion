---
name: "n8n-workflow-agent"
description: "Проектирование и проверка процессов n8n через n8n MCP с учётом доступности инструментов и зависимостей."
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

### Supplied package dependencies

- The n8n MCP server and the companion n8n skills listed by the upstream instructions are runtime prerequisites; they were not installed by this import.

---


# n8n Workflow Agent

Use this skill for any task involving n8n workflows.

Before doing workflow work, verify that the environment is ready:

1. `n8n-mcp` MCP server is configured and its tools are available.
2. The following n8n skills from `https://github.com/czlonkowski/n8n-skills` are available:
  - `n8n-expressions`
  - `n8n-mcp-tools`
  - `n8n-workflow-patterns`
  - `n8n-validation`
  - `n8n-node-configuration`
  - `n8n-code-javascript`
  - `n8n-code-python`

If either is missing, do not continue with workflow implementation. Read `references/SETUP_GUIDE.md` and guide the user through setup.

## MCP usage

The `n8n-mcp` server is the primary interface for discovering nodes, validating configurations, reading workflow details, and applying workflow changes.

## Known n8n MCP nuances

### Workflow listing is unavailable

`list workflows` is not available. Do not assume you can enumerate all workflows through MCP.

Ask the user for one of:

- workflow ID
- workflow URL
- exported workflow JSON
- exact workflow name plus enough context to identify it

### `n8n_update_partial_workflow.updateNode` requires `updates`

When using `n8n_update_partial_workflow` with operation type `updateNode`, the `updates` parameter is required.

Always wrap changed node fields inside `updates`.

Correct:

```javascript
{
  type: "updateNode",
  nodeId: "abc-123",
  updates: {
    parameters: {
      jsCode: "..."
    }
    // other updatable fields can also go here:
    // name, position, disabled, etc.
  }
}
```

## Required skill loading behavior

When using n8n MCP tools, always load or activate the MCP tools skill first:

- `n8n-mcp-tools`

Then load other n8n skills only as needed:

- Expression work → `n8n-expressions`
- New workflow architecture → `n8n-workflow-patterns`
- Validation failures → `n8n-validation`
- Node parameters/configuration → `n8n-node-configuration`
- JavaScript Code node → `n8n-code-javascript`
- Python Code node → `n8n-code-python`

Do not load all n8n skills by default. Load progressively based on the task.

## Change control

Never change an n8n workflow immediately.

Before any workflow change:

1. Inspect the current workflow or ask the user for the workflow JSON/ID/link.
2. Explain what you found.
3. Propose a concrete change plan.
4. Ask the user to approve the plan.
5. Only after approval, apply the changes.
6. Validate the workflow after changes.
7. Report exactly what changed and any remaining risks.

If the user asks for a “quick fix”, still propose the minimal plan first.

## Setup check

At the start of an n8n task, quickly check:

- Are `n8n-mcp` tools visible to the agent?
- Can the agent call at least one harmless discovery/validation MCP tool?
- Are the n8n skills installed/available?
- Is `n8n MCP Tools Expert` loadable?


If not, switch to setup mode and use `references/SETUP_GUIDE.md`.

## Do not

- Do not invent workflow IDs.
- Do not assume workflow listing exists.
- Do not skip validation after edits.
- Do not make destructive changes without explicit user approval.
- Do not hardcode API keys into workflow files, docs, or chat output except when showing placeholders.
- Do not continue debugging MCP behavior from memory if the MCP tools are unavailable; fix setup first.