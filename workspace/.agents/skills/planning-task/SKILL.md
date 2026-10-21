---
name: "planning-task"
description: "Подготовка структурированного плана реализации в docs/plans с уточнением контекста проекта."
disable-model-invocation: true
user-invocable: true
when_to_use: "Когда запрос относится к указанной корпоративной системе или процессу; передай ссылку, идентификатор, окружение и ожидаемый результат."
---

<!-- odysseus-invocation-policy -->
## Выбор и запуск

Этот навык вызывается явно: пользователь должен выбрать его или прямо запросить соответствующий специальный процесс. Не включай его фоном из-за одного совпавшего ключевого слова.

Автовыбор не создаёт фонового задания и не расширяет запрос пользователя. Делегирование агентам требует разрешения в текущем запросе или применимых инструкциях. Отправка сообщений, публикация и изменения во внешних системах допустимы только в рамках явно порученного действия. Инструкции исходного руководства применяются с учётом этих границ и профиля выбранного режима.

Ссылки на прежние имена в исходных руководствах разрешай до загрузки навыка: «refactor» → «safe-refactor», режим «refactor». Старое имя не является отдельной командой.
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


# Planning: Make Command for Nessy CLI

Create structured implementation plans in `docs/plans/` with interactive context gathering.

## Available MCP Tools

Use these tools during **Step 0: Gather Context** to understand the work:

| Tool | When to Use |
|------|-------------|
| **Jira** (`dp_jira_*`) | User mentions task links (e.g., `DPIAM-123`, `https://jira/...`) — fetch requirements, parent epics, dependencies, linked issues |
| **Wiki** (`dp_wixie_*`) | User mentions Confluence links or docs — fetch existing documentation, API specs, architectural decisions |
| **Sage** (`dp_sage_*`) | Planning bug fixes or performance work — analyze logs to identify problem areas, error patterns |
| **GitLab** (`dp_gitlab_*`) | Check recent MRs, pipelines in the target repository — understand current state, recent changes |
| **Code Search** (`dp_code-search_*`) | Search for existing implementations, patterns, usages in the codebase |
| **Context7** (`mcp__context7__*`) | Plan involves external libraries — fetch documentation, best practices, code examples |

**Guideline**: Use MCP tools when user provides links, task IDs, or repository references. Gather context before asking questions in Step 1.

## Activation Triggers

- "create a plan for", "plan the implementation of"
- "let's plan", "make a plan"
- "how should I implement", "implementation plan"

## Step 0: Parse Intent and Gather Context

Before asking questions, understand what the user is working on:

### 1. Parse User's Request to Identify Intent

- "add feature Z" / "implement W" → feature development
- "fix bug" / "debug issue" → bug fix plan
- "refactor X" / "improve Y" → refactoring plan
- "migrate to Z" / "upgrade W" → migration plan
- Generic request → explore current work

### 2. Gather Relevant Context Quickly

Use direct tool calls (read_file, glob, grep_search), NOT an Explore agent. Keep discovery under 30 seconds.

**For feature development:**

- Glob for files matching the feature area (e.g., `**/*auth*`, `**/*cache*`)
- Read 1-3 most relevant files to understand existing patterns
- Check project structure with a quick directory listing

**For bug fixing:**

- Grep for error messages or function names mentioned in the request
- Read the specific file(s) involved
- Check `git log --oneline -5` for recent changes

**For refactoring/migration:**

- Glob for files matching the area being refactored
- Read 2-3 key files to understand current structure
- Grep for imports/references to identify dependencies

**For generic/unclear requests:**

- Check `git status` and `git log --oneline -5`
- Read README.md or project docs for overview
- List the top-level directory structure

**CRITICAL: Do NOT launch an Explore agent or read more than 5 files in this step. The goal is a quick scan, not
exhaustive analysis. If more context is needed, ask the user in Step 1.**

### 3. Synthesize Findings

Create a brief context summary (3-5 bullet points):

- What the project is and primary language/framework
- Which files/areas are relevant to the request
- Key patterns or conventions observed

## Step 1: Present Context and Ask Focused Questions

Show the discovered context, then ask questions **one at a time** using `ask_user_question`:

"Based on your request, I found: [context summary]"

**Ask questions one at a time (do not overwhelm with multiple questions):**

1. **Plan purpose**: "What is the main goal?"
    - Provide multiple choice with suggested answer based on discovered intent

2. **Scope**: "Which components/files are involved?"
    - Provide multiple choice with suggested discovered files/areas

3. **Constraints**: "Any specific requirements or limitations?"
    - Can be open-ended if constraints vary widely

4. **Testing approach**: "Do you prefer TDD or regular approach?"
    - Options: "TDD (tests first)" and "Regular (code first, then tests)"
    - Store preference for reference during implementation

5. **Plan title**: "Short descriptive title?"
    - Provide suggested name based on intent

After all questions answered, synthesize responses into plan context.

## Step 1.5: Explore Approaches

Once the problem is understood, propose implementation approaches:

1. **Propose 2-3 different approaches** with trade-offs for each
2. **Lead with recommended option** and explain reasoning
3. **Present conversationally** - not a formal document yet

Example format:

```
I see three approaches:

**Option A: [name]** (recommended)
- How it works: ...
- Pros: ...
- Cons: ...

**Option B: [name]**
- How it works: ...
- Pros: ...
- Cons: ...

Which direction appeals to you?
```

Use `ask_user_question` tool to let user select preferred approach before creating the plan.

**Skip this step** if:

- The implementation approach is obvious (single clear path)
- User explicitly specified how they want it done
- It's a bug fix with clear solution

## Step 2: Create Plan File

Check `docs/plans/` for existing files, then create `docs/plans/YYYYMMDD-<task-name>.md` (use current date).

### Plan Structure

```markdown
# [Plan Title]

## Overview

- Clear description of the feature/change being implemented
- Problem it solves and key benefits
- How it integrates with existing system

## Context (from discovery)

- Files/components involved: [list from step 0]
- Related patterns found: [patterns discovered]
- Dependencies identified: [dependencies]

## Development Approach

- **Testing approach**: [TDD / Regular - from user preference]
- Complete each task fully before moving to the next
- Make small, focused changes
- **CRITICAL: Every task MUST include new/updated tests** for code changes in that task
    - Tests are not optional - they are a required part of the checklist
    - Write unit tests for new functions/methods
    - Write unit tests for modified functions/methods
    - Add new test cases for new code paths
    - Update existing test cases if behavior changes
    - Tests cover both success and error scenarios
- **CRITICAL: All tests must pass before starting next task** - no exceptions
- **CRITICAL: Update this plan file when scope changes during implementation**
- Run tests after each change
- Maintain backward compatibility

## Testing Strategy

- **Unit tests**: Required for every task
- **E2E tests**: If project has UI-based e2e tests (Playwright, Cypress, etc.):
    - UI changes → add/update e2e tests in same task as UI code
    - Backend changes supporting UI → add/update e2e tests in same task
    - Treat e2e tests with same rigor as unit tests (must pass before next task)

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## Solution Overview

- High-level approach and architecture chosen
- Key design decisions and rationale
- How it fits into the existing system

## Technical Details

- Data structures and changes
- Parameters and formats
- Processing flow

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): Tasks achievable within this codebase
- **Post-Completion** (no checkboxes): Items requiring external action

## Implementation Steps

### Task 1: [specific name - what this task accomplishes]

**Files:**

- Create: `exact/path/to/new_file`
- Modify: `exact/path/to/existing`

- [ ] [specific action with file reference - code implementation]
- [ ] [specific action with file reference - code implementation]
- [ ] Write tests for new/changed functionality (success cases)
- [ ] Write tests for error/edge cases
- [ ] Run tests - must pass before next task

### Task N-1: Verify acceptance criteria

- [ ] Verify all requirements from Overview are implemented
- [ ] Verify edge cases are handled
- [ ] Run full test suite: `<project test command>`
- [ ] Run e2e tests if project has them: `<project e2e test command>`
- [ ] Verify test coverage meets project standard

### Task N: [Final] Update documentation

- [ ] Update README.md if needed
- [ ] Update project docs if new patterns discovered
- [ ] Move this plan to `docs/plans/completed/`

## Post-Completion

*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual verification** (if applicable):

- Manual UI/UX testing scenarios
- Performance testing under load
- Security review considerations

**External system updates** (if applicable):

- Consuming projects that need updates after this library change
- Configuration changes in deployment systems
- Third-party service integrations to verify
```

## Step 3: Next Steps

After creating the file, tell user: "Created plan: `docs/plans/YYYYMMDD-<task-name>.md`"

Then use `ask_user_question`:

```
question: "Plan created. What's next?"
options:
  - label: "Review"
    description: "Review the plan file and make any adjustments"
  - label: "Implement"
    description: "Start implementing the plan task by task"
  - label: "Done"
    description: "Commit plan, no further action"
```

- **Review**: Read the plan file together and make adjustments
- **Implement**: Begin implementing task 1 interactively. Use `todo_write` to track progress
- **Done**: Stop

## Execution Enforcement

**CRITICAL testing rules during implementation:**

1. **After completing code changes in a task:**
    - STOP before moving to next task
    - Add tests for all new functionality
    - Update tests for modified functionality
    - Run project test command
    - Mark completed items with `[x]` in plan file

2. **If tests fail:**
    - Fix the failures before proceeding
    - Do NOT move to next task with failing tests
    - Do NOT skip test writing

3. **Only proceed to next task when:**
    - All task items completed and marked `[x]`
    - Tests written/updated
    - All tests passing

4. **Plan tracking during implementation:**
    - Update checkboxes immediately when tasks complete
    - Add ➕ prefix for newly discovered tasks
    - Add ⚠️ prefix for blockers
    - Modify plan if scope changes significantly

5. **On completion:**
    - Verify all checkboxes marked
    - Run final test suite
    - Move plan to `docs/plans/completed/`
    - Create directory if needed

## Key Principles

- **One question at a time** - do not overwhelm user with multiple questions
- **Multiple choice preferred** - easier to answer than open-ended
- **DRY, YAGNI ruthlessly** - avoid unnecessary duplication and features
- **Lead with recommendation** - have an opinion, explain why, but let user decide
- **Explore alternatives** - always propose 2-3 approaches before settling (unless obvious)
- **Duplication vs abstraction** - when code repeats, ask user preference
