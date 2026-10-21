---
name: "dialectic"
description: "Проверка утверждения двумя противоположными исследовательскими позициями с синтезом выводов."
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


# Dialectic Skill for Nessy CLI

Objective analysis of a statement by running two agents with opposing goals in parallel, then synthesizing findings.

## Available MCP Tools

Use these tools during **Step 1: Launch Parallel Agents** to gather evidence for thesis/antithesis:

| Tool | When to Use |
|------|-------------|
| **Jira** (`dp_jira_*`) | Fetch bug history, incidents, performance tickets — evidence for/against stability claims |
| **Wiki** (`dp_wixie_*`) | Fetch architectural decisions, design docs — verify alignment with stated architecture |
| **Sage** (`dp_sage_*`) | Analyze logs for performance metrics, error rates — quantitative evidence for both sides |
| **GitLab** (`dp_gitlab_*`) | Check commit history, MR discussions, pipeline stability — implementation quality evidence |
| **Code Search** (`dp_code-search_*`) | Find code patterns, usages, technical debt — structural evidence |

**Guideline**: Both thesis and antithesis agents must cite specific evidence from MCP tools (file:line, metrics, task IDs). Quantitative data > opinions.

## Activation Triggers

- "dialectic", "prove and disprove"
- "stress test this claim", "is this really true"
- "argue both sides", "analyze both perspectives"
- "challenge this assumption"

## Process

### Step 1: Launch Parallel Agents

**CRITICAL: Launch both agents in parallel for true dialectic analysis.**

**Agent 1 (Thesis)** — find all POSITIVE evidence:

- What works well, improvements, correct patterns
- Supporting facts, proof the statement is TRUE
- Benefits, strengths, successful outcomes

**Agent 2 (Antithesis)** — find all NEGATIVE evidence:

- What's problematic, issues, risks, anti-patterns
- Edge cases, proof the statement is FALSE
- Weaknesses, failure modes, hidden costs

Both agents must provide specific file paths and line numbers when analyzing code.

### Step 2: Synthesize

After both agents complete, synthesize findings into an objective conclusion:

- Weigh evidence from both sides
- Identify where thesis and antithesis agree (strongest signal)
- Note unresolved tensions

### Step 3: Verify

**CRITICAL** — after presenting the synthesis, verify it against actual implementation:

- Read the specific files and line numbers referenced by both agents
- Confirm the evidence cited actually exists in the codebase
- Check the implementation flow matches the claims made
- Verify the synthesis accurately reflects the actual code context
- Identify any misinterpretations or missing context from agent reports
- Revise synthesis if verification reveals inaccuracies

## Use Cases

**Architecture decisions:**

```
dialectic: this microservice split improves maintainability
```

**Bug analysis:**

```
dialectic: the connection pool fixes the timeout issue
```

**Performance claims:**

```
dialectic: caching reduced database load by 80%
```

**Refactoring safety:**

```
dialectic: extracting this interface simplifies testing
```

**Code review:**

```
dialectic: this implementation is thread-safe
```

## Key Principles

- **Eliminate confirmation bias** — examining both sides simultaneously prevents anchoring on the first conclusion
- **Evidence-based** — agents must cite specific files, lines, and facts, not general claims
- **Verification required** — synthesis must be checked against actual code before presenting
- **Objective conclusion** — the goal is truth, not winning either side
