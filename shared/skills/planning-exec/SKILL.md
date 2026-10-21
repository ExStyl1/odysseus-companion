---
name: "planning-exec"
description: "Последовательное выполнение задач из файла плана в изолированных агентах при разрешённом делегировании."
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


# Planning: Exec Skill for Nessy CLI

Execute plan file tasks sequentially, each in an isolated subagent.

## Available MCP Tools

| Tool | When to Use |
|------|-------------|
| **GitLab** (`dp_gitlab_*`) | Step 8 (Finalize) — check pipelines, MR status; Step 9 — create MR via `mcp__dpMR__create_merge_request` |
| **Jira** (`dp_jira_*`) | If plan references Jira tasks — update status, add comments on completion |
| **Wiki** (`dp_wixie_*`) | If plan includes documentation tasks — fetch/update relevant pages |
| **Sage** (`dp_sage_*`) | Post-deployment verification — check for new errors, performance regressions |

**Guideline**: GitLab MCP is used for MR creation in Step 9. Use other MCP tools when plan tasks reference external systems.

## Activation Triggers

- "exec", "execute plan", "run plan"
- "implement the plan", "execute tasks"
- "autonomous execution"

## Arguments

- Path to plan file (optional; if omitted, ask user to pick from `docs/plans/`)

## Process

### Step 1: Resolve Plan File

If a file path is provided, use it. Otherwise:

1. List `.md` files in `docs/plans/`, excluding `completed/`
2. If exactly one plan found, use it automatically
3. If multiple found, ask the user to pick one using `ask_user_question`

Read the plan file. Count total Task sections (`### Task N:`) to know the scope.

Determine the default branch:

```bash
git rev-parse --abbrev-ref HEAD
```

### Step 2: Create Branch

**MANDATORY**: Create a feature branch from the plan filename.

```bash
# Extract name from plan file (e.g., 20260329-feature-name.md → feature-name)
plan_name=$(basename "$PLAN_FILE" .md | sed 's/^[0-9]*-//')
branch_name="feature/$plan_name"

# Create branch if on main/master
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" = "main" ] || [ "$current_branch" = "master" ]; then
    git checkout -b "$branch_name"
fi
```

### Step 3: Initialize Todo List

Create tasks using `todo_write` before starting any work:

For each `### Task N:` section in the plan:

- Create a todo item with the task title and checkbox items

Then add review tasks:

- Review phase 1: comprehensive review
- Review phase 2: code smells
- Review phase 3: external review (via `tclaude`/`codex` if available)
- Finalize: commit cleanup

### Step 4: Task Loop

Repeat until no `[ ]` checkboxes remain in any Task section:

1. **Re-read the plan file** (subagent modifies it each iteration)

2. **Find the first Task section** (`### Task N:`) that still has `[ ]` checkboxes

3. **If none found** — all tasks complete, go to Step 5

4. **Announce the task to the user** — output a visible summary:
    - Task number and title (from the `### Task N:` header)
    - List all `[ ]` checkbox items in that task section

5. **Spawn a subagent** using `agent` tool with:
    - `subagent_type: "general-purpose"`
    - Prompt including:
        - The task description from the plan
        - Files to create/modify
        - Testing requirements
        - Plan file path for updates

6. **After subagent returns**, re-read the plan file and check if that task's checkboxes are now `[x]`
    - If yes — task succeeded, continue to step 7
    - If no — **retry** with a fresh subagent for the same task (up to 3 retries)
    - If all retries fail, stop and report failure to user

7. **Commit the completed task** — once the task succeeded, commit its changes before moving to the next task:

    ```bash
    git add -A
    git commit -m "<type>(<scope>): Task N — <task title>"
    ```

    - One commit per task keeps history granular and makes the Step 8 cleanup (squash/fixup) straightforward.
    - Include the plan-file update (the flipped `[x]` checkboxes) in the same commit.
    - Use a Conventional Commit type that matches the task (`feat`, `fix`, `refactor`, `test`, `docs`, …).
    - If there is nothing to commit (subagent already committed, or no file changes), skip silently — do not fail the loop.
    - The orchestrator performs this commit itself; this is a git operation, not code work, so it does not violate the "orchestrator never touches code" rule.

8. **Report to user**: "Task N completed and committed" (one line)

**CRITICAL**: Do NOT stop the loop based on subagent return text. The ONLY condition to stop is: no `[ ]` checkboxes
remain in any Task section. Always re-read the plan file to check.

**CRITICAL**: You are the ORCHESTRATOR. Never read code, debug errors, investigate diagnostics, or fix issues yourself.
If a subagent leaves problems (compiler errors, test failures, lint issues), retry with a fresh subagent — pass the
error details in the prompt so it can fix them. All code work happens inside subagents, not in the orchestrator.

**Maximum iterations safety limit: 50.** If reached, stop and report to user.

### Step 5: Review Phase 1 — Comprehensive

After all tasks complete, run a comprehensive code review.

Report to user: "--- Review phase 1: comprehensive ---"

1. **Spawn a review agent** using `agent` tool:
    - Prompt: Review all changed files for quality, implementation correctness, testing coverage, simplification
      opportunities, and documentation

2. **Collect findings** — pass the review agent's complete output to a fixer agent

3. **If ALL agents reported zero issues** → report "Review phase 1: clean" and proceed to the next phase

4. **Spawn a fixer agent** using `agent` tool:
    - Prompt: Evaluate each finding, fix confirmed issues, reject false positives
    - Pass the FULL unedited review output as findings

5. **After fixer returns** → show the "FIXES:" section to the user

6. **Loop back to step 1** if issues were found

Maximum iterations: 5. If reached with issues still found, report and continue.

### Step 6: Review Phase 2 — Code Smells

Report to user: "--- Review phase 2: code smells analysis ---"

Run once (no loop):

1. **Spawn a smells agent** using `agent` tool:
    - Prompt: Check for code smells, convention violations, style issues, naming problems

2. **Collect findings** — report to user with a compact list

3. **If no issues found** → report "Smells analysis: clean" and proceed

4. **Spawn a fixer agent** to address confirmed issues

5. **After fixer returns** → report fixes to user

### Step 7: Review Phase 3 — External Review (Optional)

Report to user: "--- Review phase 3: external review ---"

This phase runs an **independent** reviewer (a separate CLI agent) over the diff for a
second opinion. It is optional and only runs if such a tool is available to the user.

**Detect an available external reviewer**, in priority order:

```bash
# Prefer tclaude (corporate wrapper over Claude Code) — most users have this.
# Fall back to codex only if it is actually installed (not available on most machines).
if command -v tclaude >/dev/null 2>&1; then
    reviewer="tclaude"
elif command -v codex >/dev/null 2>&1; then
    reviewer="codex"
else
    reviewer=""
fi
```

**If no reviewer is available (`reviewer` is empty)** → report
"Review phase 3: skipped (no external review tool available)" and proceed to Step 8.

**If a reviewer is available:**

1. **Run the external review** by piping the branch diff into the reviewer in
   non-interactive (print) mode. `tclaude` shares Claude Code's `-p` interface:

   ```bash
   # Base = the branch the feature was cut from (main or master)
   base=$(git rev-parse --verify origin/main >/dev/null 2>&1 && echo origin/main || echo origin/master)

   git diff "$base"...HEAD | "$reviewer" -p "You are an independent code reviewer. \
   Review the following diff for correctness bugs, missing edge cases, security issues, \
   and test gaps. Be specific: cite file and line. List only real, actionable findings; \
   if the diff looks clean, say so."
   ```

   - Capture the reviewer's full output.
   - If `tclaude`/`codex` fails to launch (e.g., not authenticated, sandbox error), report
     the failure to the user and skip this phase rather than blocking finalization.

2. **Report findings** to user (verbatim — do not summarize or filter).

3. **If findings exist**, spawn a fixer agent using the `agent` tool to evaluate each finding,
   fix confirmed issues, and reject false positives. Pass the reviewer's FULL unedited output
   as findings.

4. **Loop** up to 10 iterations if issues persist. Re-run the external reviewer after each fix
   round until it reports clean or the iteration limit is reached.

### Step 8: Finalize

After all reviews pass, clean up commits.

Report to user: "--- Finalize: cleaning up commits ---"

1. **Check commit history**:

```bash
git log --oneline
```

2. **Squash/fixup commits** if needed:
    - The task loop already produced one commit per task (Step 4.7); fold review-fix commits into the task commit they belong to
    - Combine "fix typo", "address review", "wip" commits
    - Ensure each commit has a meaningful message

3. **Rebase on latest main/master**:

```bash
git fetch origin
git rebase origin/main  # or origin/master
```

4. **Report the final state**:
    - Branch name
    - Number of commits
    - Commit messages (cleaned up)

### Step 9: Completion

When finalize is done:

- Report summary: "All N tasks completed, reviews passed, branch finalized"
- Report branch name: `feature/<name>`
- Report commit count and summary
- **Do NOT push** — user decides when to push

### Step 10: Archive Plan

**MANDATORY**: After the plan is fully executed, move the plan file to `docs/plans/completed/`.

```bash
mkdir -p docs/plans/completed
git mv "$PLAN_FILE" "docs/plans/completed/$(basename "$PLAN_FILE")"
```

- Use `git mv` so the move is tracked; fall back to `mv` if the file is not yet tracked by git.
- Report to user: "Plan archived to docs/plans/completed/<file>"
- This keeps `docs/plans/` holding only active plans (Step 1 already excludes `completed/` when resolving plans).

## Key Rules

- Each subagent gets a fresh context — no accumulated state from previous tasks
- Parent session only tracks: task number, success/failure, retry count
- Plan file is the single source of truth for progress — always re-read it
- Commit after each completed task (one commit per task) — Step 8 later squashes/cleans them up
- Do not modify the plan file yourself — only subagents modify it
- Do not implement or fix code yourself — only subagents implement and fix
- If a subagent fails or leaves broken code, re-run the loop — do NOT investigate or fix it yourself
- NEVER dismiss findings as "pre-existing", "not from changes", or "architectural" — ALL findings are actionable
- NEVER summarize or filter agent findings — pass the full output to the fixer agent verbatim

## GitLab Integration

For GitLab repositories, the exec skill can integrate with GitLab MR workflow:

1. **After finalize**, offer to create a Merge Request:

```
question: "Create a Merge Request for this branch?"
options:
  - label: "Create MR"
    description: "Open a draft MR on GitLab"
  - label: "Push only"
    description: "Push branch without creating MR"
  - label: "Done"
    description: "Keep local, no push"
```

2. **If creating MR**:

```bash
git push -u origin <branch-name>
# Use MCP tool mcp__dpMR__create_merge_request
```

3. **MR settings**:
    - Draft: true (user can mark ready when tests pass)
    - Squash: true (default, can be overridden)
    - Delete source branch: true (after merge)
