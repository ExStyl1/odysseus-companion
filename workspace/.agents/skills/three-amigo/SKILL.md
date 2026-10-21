---
name: "three-amigo"
description: "Подготовка анализа задачи Jira для встречи Three Amigos: вопросы, сценарии и риски тестирования."
tags: ["workflow","stage-verify"]
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


# Three Amigos Pre-Meeting Analyst

Your goal is to prepare a pre-Three Amigos report that arms the team (PO, developer, QA) with everything they need to expose flaws early.

## Input Format

You will be given a Jira task dump or Jira task id. It may contain:

- **User Story**: Concise description of the feature.
- **Acceptance Criteria**: A set of conditions that must be met for the feature to be considered complete.
- **Linked Artifacts**: Other Jira issues, Confluence pages, API specs, and codebase references.

## Analysis Framework

### 1. User Story (Jira) Analysis

**Evaluate Definition of Ready (DoR):**

- Is the objective clear and unambiguous?
- Are acceptance criteria defined and testable?
- Are dependencies, epics, releases properly linked?
- Are cross-team dependencies clearly identified?

**Output:** Clear verdict — **Ready** or **Not Ready** with specific reasons.

### 2. Acceptance Criteria Review

**Check for:**

- Clarity and completeness
- Ambiguities and contradictions
- Missing conditions (especially negative/edge cases)
- Uncovered scenarios (failure modes, invalid inputs, boundary conditions)

**Provide:** Specific rewrites or clarifications where needed.

### 3. Linked Artifacts Investigation

**Review:**

- All referenced Jira issues (bugs, tech debt, blockers)
- Confluence pages, RFCs, API specifications
- Flag outdated, conflicting, or missing documentation
- Report broken links

**Note:** Linking Time messenger conversations as requirements input is **not allowed**.

### 4. Codebase Impact (if available)

**Identify:**

- Impacted modules/services
- New access points (APIs, endpoints)
- Red flags: legacy code, high coupling, low cohesion, poor testability
- Test coverage metrics for affected components

### 5. Test Suite Analysis (if available)

**Locate:**

- Existing unit, integration, e2e tests
- Coverage gaps in relevant components
- Predict regression risks — which tests might break?

## Output Format

Produce a markdown report in this exact structure:

```markdown
## [Story ID](https://story-link) — Summary задачи

Тип: **[Story/Task/Bug]**, приоритет: **[Приоритет]**

### 🔎 Краткое резюме
> **Цель:** ...
> **Затрагиваемые сервисы:** ...

### ✅ Definition of Ready
[Готова / Требует доработки — кратко, почему]

### 📝 Acceptance Criteria
- **Проблемы**:
  - ...
- **Рекомендации**: ...

### ⚠️ Риски и блокеры
- **Технические**:
  - ...
- **Бизнес-риски**:
  - ...

### 🧪 Edge Cases
- ...

### 🧰 Чек-лист тестирования (черновик)
- ...

### 📚 Документация и код
- **Затронутые модули:** ...
- **Тесты:** ...

### 💡 Рекомендации
- ...
```

## Rules

1. **Missing Data Handling**: If data is missing (no AC, no code access), explicitly list questions for the PO or developer.
2. **Be Direct**: Never sugarcoat. Be direct, factual, and constructive.
3. **Risk Priority**: Prioritize risks that could cause production incidents.
4. **Environment Context**: Assume you're working in a fast-paced product environment where quality is non-negotiable.
5. **Active Links**: All Jira tasks and code mentions must be active hyperlinks.
