---
name: "spec-review"
description: "Проверка согласованности сценариев, БД, API, ошибок и очередей с трассировкой к требованиям."
disable-model-invocation: false
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
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


# Spec-Review Skill for Nessy CLI

Check a spec not for "nice prose" but for **consistency and coverage**.

This is the analyst counterpart of `review`. Its main value is the mechanical cross-check that
different sections of the spec don't contradict each other, plus traceability to the epic and
business requirements. It is a human control point before handoff to the developer — symmetric to
plan review on the development leg.

**Role-agnostic**: anyone can run this — the spec author, a developer picking up the spec, or a
tester validating acceptance criteria. It applies both to a freshly created spec and to an MR
containing changes to `.md` specs.

## Available MCP Tools

| Tool | When to Use |
|------|-------------|
| **Jira** (`dp_jira_*`) | Fetch the epic / task to trace spec elements back to requirements |
| **Wiki** (`dp_wixie_*`) | Fetch business requirements (БТ) for gap/orphan traceability |
| **Code Search** (`dp_code-search_*`) | Fetch the OpenAPI in `api-schemas/` to compare against `api/` |
| **GitLab** (`dp_gitlab_*`) | Read the service `docs/` tree (spec, database/, api/, queues/); diff an MR changing `.md` specs (like `review`) |

**Guideline**: gather the whole tree plus the epic/БТ before checking. Findings must cite the
concrete document and line/field, not general impressions.

## Activation Triggers

- "ревью спеки", "spec-review", "проверь спеку", "сверь спеку с БТ"
- "review the spec"

## Workflow

```
1. Gather artifacts (spec tree + api-schemas + epic + БТ)
2. Cross-consistency check (priority 1°) — mechanical field/code/contract/topic matching
3. Traceability (priority 2°) — bidirectional GAP / ORPHAN against epic/БТ
4. Quality — testability, ambiguity, missing branches, NFR; check open questions are closed
5. Contentious points → dialectic
6. Deliver: discrepancy matrix + draft edits; publish only after confirmation
```

For a large tree, delegate steps 1–4 to a `general-purpose` subagent (like `review` does) so the
main context stays clean; the subagent returns the discrepancy matrix.

## Step 1: Gather artifacts

Via MCP and the filesystem: the spec itself, the related `database/`, `api/`, `queues/`,
`error_codes.md`, schemas from `api-schemas/`, plus the epic from Jira (`dp_jira_*`) and business
requirements from Wiki (`dp_wixie_*`).

## Step 2: Cross-consistency (priority 1°)

Mechanically verify:

- field names in scenarios = fields in `database/`;
- error codes in scenarios = `error_codes.md`;
- the contract in `api/` = OpenAPI in `api-schemas/`;
- topics/queues in scenarios = `queues/`.

Any mismatch is a finding (e.g. a scenario writes `-905`, but `error_codes.md` has no such code).

**This is the underrated win.** Fields in scenario S01 (`MESSAGE_ID`, `STATUS='NEW'`) and error
codes (`-902/-905/-999`) must match `database/`, `error_codes.md` and `api-schemas/`. This
cross-check is mechanically verifiable and catches real discrepancies the eye skips — stronger than
any generic review.

## Step 3: Traceability (priority 2°)

Bidirectional:

- each epic/БТ requirement → where it's covered in the spec, or **GAP** (missing);
- each spec element → what justifies it in the epic/БТ, or **ORPHAN** (scope creep).

Our БТ are loose — trace by meaning/quotes, honestly mark "no basis found".

## Step 4: Quality

Scenario testability, ambiguous wording, missing alternative branches and edge cases, absent NFR.
Verify that open questions (`[допущение]`/`[?]`) are resolved or explicitly documented.

## Step 5: Contentious points → dialectic

Sensitive decisions (payment logic, security, idempotency) run through `dialectic` for/against.

## Step 6: Deliver result

A discrepancy matrix (GAP / ORPHAN / inconsistency) + a draft of edits. Posting a comment or edits
happens **only after the human confirms** — use `ask_user_question` to confirm before publishing.

## Consistency invariants (what "matching" means)

| Check | Left side | Right side |
|-------|-----------|-----------|
| Fields | field names in `scenarios/SXX` | columns in `database/<SCHEMA>.<TABLE>.md` |
| Error codes | codes in scenarios/api | `api/error_codes.md` |
| Contract | params in `api/operations/*` | OpenAPI in `api-schemas/` |
| Queues | topics in scenarios | `queues/<topic>.md` |

## Example

```
User: сделай ревью спеки чаевых, сверь с БТ
→ Step 2: scenario S01 persists LAYOUT_ID, but TIPS.TRANSACTION_REQUEST has no such field → finding
→ Step 2: scenario references code -905, error_codes.md has only -902/-999 → finding
→ Step 3: БТ requires a cap on tip amount → not covered in the spec → GAP
→ Step 5: idempotency by messageId is contentious → dialectic
→ Step 6: matrix + draft edits, wait for confirmation
```

## When to use

After `spec-create`, or when importing via `spec-import` — as a control point before the spec goes
to the developer. Also use when a spec is being modified (by anyone: author, developer, tester) or
when reviewing an MR that changes `.md` specs.

## Main risk

Sliding into a generic "prose style" review. The value is the mechanical matching of fields, codes
and contracts between sections; it produces findings a human misses by eye.
