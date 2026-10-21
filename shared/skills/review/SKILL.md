---
name: "review"
description: "Комплексное ревью GitLab merge request с архитектурной проверкой через корпоративные MCP-инструменты."
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


# Review: GitLab MR Skill for Nessy CLI

Comprehensive Merge Request review using GitLab API via MCP tools.

## Available MCP Tools

| Tool | When to Use |
|------|-------------|
| **GitLab** (`dp_gitlab_*`) | **Primary tool** — fetch MR details, diff, comments, pipelines, jobs (used in all phases) |
| **Jira** (`dp_jira_*`) | User mentions task links — fetch requirements, acceptance criteria to verify MR scope |
| **Wiki** (`dp_wixie_*`) | Verify architectural guidelines, API specs mentioned in MR description |
| **Sage** (`dp_sage_*`) | Check for new errors, performance regressions after MR deployment (if deployed) |
| **Code Search** (`dp_code-search_*`) | Search for similar patterns, usages of changed code in other repositories |

**Guideline**: GitLab MCP is used automatically for all reviews. Use other MCP tools when user provides links or references in MR description/comments.

## Activation Triggers

- "review mr", "review merge request"
- "check mr", "look at mr"
- "review pr" (also accepted for GitHub users)
- "review !123", "mr 123"

## Workflow

```
1. Fetch MR metadata + discussion history + merge status
1.5. Ask review mode: Full (default) or Quick
--- Full path ---
2. Launch subagent for deep analysis (read files, validate, architecture, scope creep)
2.5. External review via `tclaude`/`codex` if available (optional second opinion)
3. Present condensed findings from subagent, ask to proceed
4. Resolve open questions (if any)
5. Draft review comment
--- Quick path ---
Q1. Read diff inline, summarize what/why/size
Q2. Flag obvious issues from diff
Q3. Draft review comment
```

## Phase 0: Detect MR Number and Repository

Get MR number from user input. If not provided, list recent MRs.

**Extract tenant and repository from current directory:**
```bash
# Parse git remote URL
git remote get-url origin
# Extract: https://gitlab.tcsbank.ru/<tenant>/<repo>.git
```

**Use MCP tool to fetch MR:**
```
mcp__dpGitlab__dp_gitlab_merge-request
  - tenant: <extracted>
  - repository: <extracted>
  - id: <mr-number>
```

## Phase 1: Fetch MR Metadata and Discussion History

### 1.1 Get MR Details

Use MCP tool `mcp__dpGitlab__dp_gitlab_merge-request` with `with-comments: true`:

Captures:
- **title**: what the MR claims to do
- **description**: detailed description
- **changes**: list of changed files with additions/deletions
- **scope**: total additions/deletions, number of files
- **discussion history**: all comments and thread discussions
- **state**: opened, merged, closed
- **merge_status**: can_merge, cannot_merge, checking
- **ci_status**: success, failed, running, skipped

### 1.2 Analyze Discussion History

Before reviewing, understand what has already been discussed:

Summarize discussion:
- What issues were raised by reviewers?
- What was the MR author's response?
- Are there unresolved threads or pending questions?
- What has already been addressed vs still open?

**CRITICAL - Check for inline comments:**
The MCP tool returns comments with their context. Look specifically for:
- **Suggested changes** - code blocks with proposed fixes
- **Inline comments** - specific line-by-line feedback
- **Security/bug warnings** - automated tools often catch real issues

The review body is often just a summary. The **inline comments** are where the real feedback is.

**Important**: Do not re-raise issues that were already discussed and resolved. Focus on new findings or unaddressed concerns.

### 1.3 Check Merge Status

Report:
- **merge_status**: can_merge, cannot_merge, conflicts
- **ci_status**: success, failed, running
- **approvals**: number of approvals vs required

If MR has conflicts or CI is failing, note this early.

Print summary:
```
MR !<number>: <title>
Author: <author> | State: <state>
+<additions>/-<deletions> across <changedFiles> files
Merge status: <merge_status> | CI: <ci_status>
Approvals: <current>/<required>

Discussion: <N> comments, <M> threads
- Resolved: <list of addressed issues>
- Open: <list of unresolved questions>
```

## Phase 1.5: Select Review Mode

After presenting the Phase 1 summary, ask the user to choose review depth:

```
question: "Review mode for MR !<number>?"
options:
  - label: "Full review (Recommended)"
    description: "Deep analysis with subagent, architecture review, scope creep detection"
  - label: "Quick review"
    description: "Diff-only, summarize what/why/size, flag obvious issues"
```

- **Full review** → continue to Phase 2 (deep analysis)
- **Quick review** → jump to Quick Review path below

## Quick Review Path

Lightweight review based on diff and metadata only. No subagent.

### Q1. Read and Summarize Diff

The MCP tool returns the diff. From the diff and Phase 1 metadata, present:

- **What**: 2-3 sentence summary of what the MR does
- **Why**: purpose/motivation (from MR description or inferred)
- **Size**: +additions/-deletions across N files - small/medium/large assessment
- **Files changed**: grouped list (code, tests, config, docs)

### Q2. Flag Obvious Issues

Scan the diff for issues detectable without full file context:

- Obvious bugs (nil dereference, unchecked errors, off-by-one)
- Missing error handling in new code
- Hardcoded values that should be configurable
- TODO/FIXME/HACK comments added
- Test files missing for new code files
- Large functions added (50+ lines)
- Unrelated changes mixed in (files that don't match MR purpose)

If nothing found, say so explicitly.

### Q3. Proceed to Draft

After presenting the summary and any flagged issues, skip directly to Phase 5 (Draft Review Comment).

## Phase 2: Deep Analysis via Subagent

**CRITICAL: Delegate all file reading, validation, and architecture analysis to a subagent** to protect the main conversation's context window.

### 2.1 Launch Analysis Subagent

Use the `agent` tool with `subagent_type: "general-purpose"`:

```
prompt: |
  You are reviewing MR !<number> for <tenant>/<repo>.

  **MR metadata:**
  - Title: <title>
  - Description: <description>
  - Files: <file list from Phase 1>
  - Discussion summary: <from Phase 1.2>

  **Your tasks (do all of these):**

  1. **Read changed files** - read each changed file in full to understand context
     Focus on what the code actually does vs what the MR description claims.

  2. **Run validation** - from the project directory:
     - Run project test suite
     - Run project linter
     - Detect project type from files present
     - Record all failures

  3. **Architecture analysis** - check for:
     - Over-engineering (unnecessary abstractions, premature generalization)
     - Pattern violations (inconsistent with existing codebase)
     - Error handling issues
     - Concurrency issues
     - Security concerns
     - Test quality

  4. **Scope creep detection** - categorize each file as:
     - Core (implements MR purpose)
     - Supporting (tests, config for core changes)
     - Related cleanup (minor fixes in touched files)
     - Unrelated (doesn't connect to MR purpose)

  **Return a structured report with these sections:**
  - **Functionality**: 3-5 sentence explanation of what the MR does
  - **Key decisions**: notable implementation choices
  - **Validation results**: test pass/fail, linter issues
  - **Architecture issues**: list with file:line references
  - **Over-engineering**: specific instances with simpler alternatives
  - **Scope creep**: unrelated files with explanation
  - **Positives**: what's done well
  - **Open questions**: design decisions needing user input

  Be specific - use file:line references. Skip sections with no findings.
```

### 2.2 Receive Report

The subagent returns a condensed report. This is what enters the main conversation context.

## Phase 2.5: External Review (Optional)

Run an **independent** reviewer (a separate CLI agent) over the MR diff for a second opinion.
This is optional and only runs if such a tool is available to the user. It complements the
subagent analysis — an independent agent often catches issues the first pass missed.

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

**If no reviewer is available (`reviewer` is empty)** → skip this phase silently and go to Phase 3.

**If a reviewer is available:**

1. **Get the MR diff.** The GitLab MCP tool already returned it in Phase 1. Write it to a temp
   file (or use a local `git diff` of the MR branch if the branch is checked out locally).

2. **Run the external review** by piping the diff into the reviewer in non-interactive (print)
   mode. `tclaude` shares Claude Code's `-p` interface:

   ```bash
   # diff.patch = the MR diff saved from Phase 1 (or `git diff <target>...<source>`)
   "$reviewer" -p "You are an independent code reviewer for MR !<number>. \
   Review the following diff for correctness bugs, missing edge cases, security issues, \
   and test gaps. Be specific: cite file and line. List only real, actionable findings; \
   if the diff looks clean, say so." < diff.patch
   ```

   - Capture the reviewer's full output.
   - If `tclaude`/`codex` fails to launch (e.g., not authenticated, sandbox error), note it
     briefly to the user and continue with the subagent findings only — never block the review.

3. **Merge with subagent findings.** Fold the external reviewer's findings into the report
   presented in Phase 3. Label them clearly (e.g., "External review (tclaude):") so the user
   knows which findings came from the independent pass. De-duplicate against the subagent's
   findings and against the user's previous comments (see Phase 5.1).

## Phase 3: Present Findings, Ask to Proceed

Present the subagent's report to the user.

Use `ask_user_question` to confirm next step:

```
question: "How would you like to proceed?"
options:
  - label: "Draft review comment"
    description: "Proceed to Phase 5 to draft and post review"
  - label: "Investigate specific finding"
    description: "Ask subagent for details on a specific issue"
  - label: "Done"
    description: "End review without posting"
```

If user selects "Investigate specific finding", launch another targeted subagent to dig into the specific area, then ask again.

## Phase 4: Resolve Open Questions

If the subagent report contains open questions (design decisions needing user input), ask about EACH one specifically before proceeding:

```
question: "<specific design question>?"
options:
  - label: "Accept"
    description: "Keep the current approach"
  - label: "Reject"
    description: "Request a change"
  - label: "Need more context"
    description: "Investigate further"
```

Wait for user response on each open question.

## Phase 5: Draft Review Comment

Only proceed when user explicitly asks to draft/post the review.

### 5.1 Check Previous Comments (Critical)

**NEVER duplicate what the user already said in their previous comments.**

Before drafting, review the discussion history from Phase 1.2:
- What did the USER (not other reviewers) already comment on this MR?
- What issues did the USER already raise?
- What recommendations did the USER already make?

**Exclude from draft**:
- Architecture assessments the user already posted
- Issues the user already pointed out
- Questions the user already asked
- Any point the user already made, even if phrased differently

**Include in draft only**:
- NEW findings not mentioned by the user before
- Updates on issues (e.g., "tests still failing after fix attempt")
- Responses to contributor's questions to the user
- User's decision on open questions from Phase 4
- Valid issues from automated reviews that weren't addressed

If user already covered everything and there's nothing new → say "no new findings to add" and don't draft.

### 5.2 Draft Comment

**CRITICAL: Don't restate what the MR does.** The author knows what they built. Focus only on:
- Issues that need fixing
- Questions about unclear decisions
- LGTM if everything is fine

**Keep it casual and brief.** Examples of good review comments:

```markdown
LGTM
```

```markdown
lgtm. one minor thing - could simplify the loop on line 42
```

```markdown
couple issues:

1. test failure in `TestFoo` - looks like missing mock setup
2. linter complains about unused param on line 42

otherwise looks good
```

```markdown
I don't get why we need the Factory pattern here - there's only one implementation. could simplify to just `NewNotifier()` directly?
```

**Only add sections if there are actual issues:**

- **Issues** - test failures, linter errors, bugs (numbered list)
- **Questions** - unclear design decisions, missing context
- **Complexity concerns** - if over-engineered, suggest simpler alternative

**Omit sections with no findings.** For clean MRs, just "LGTM" is fine.

**Code examples**: when suggesting fixes, always show proper error handling - never ignore errors even in snippets.

## Output

### Display Draft First

Always display the complete draft review as a text block before asking:

```
--- Draft Review Comment ---
**Overall impression**

<actual review content here>

**Issues to address**
...
--- End Draft ---
```

### Ask User via AskUserQuestion

Use `ask_user_question` tool with these options:

```
question: "Post this review to MR !<number>?"
options:
  - label: "Approve"
    description: "Post review and approve"
  - label: "Comment"
    description: "Post as comment, no approval"
  - label: "Request changes"
    description: "Post review requesting changes"
  - label: "Edit"
    description: "Tell me what to change"
  - label: "Cancel"
    description: "Discard draft"
```

### Handle Response

**Approve / Comment / Request changes**: 

Note: Nessy CLI doesn't have a direct GitLab comment posting tool. Present the draft for the user to copy/paste into GitLab UI, or use the MCP tool if available:
```
mcp__dpGitlab__dp_gitlab_merge-request (for viewing)
```

For posting, the user will need to copy the draft to GitLab UI.

**After Approve - offer to merge**:

When the user selected "Approve" and the approval was posted, analyze the MR commits to recommend a merge strategy:

**Strategy recommendations:**
- **Squash and merge (recommended)** when: multiple commits, wip/fixup commits, single logical change
- **Merge commit** when: meaningful branch history worth preserving
- **Fast-forward** when: single clean commit

Present the recommendation with reasoning and let user decide.

**Edit**: Ask user for specific changes, update draft, display again, and repeat.

**Cancel**: Acknowledge and stop.

## Examples

### Simple review (no issues)
```
User: "review mr 42"
→ Phase 1: fetch metadata, +150/-30, 5 files
→ Phase 2: subagent → reads files, tests pass, lint clean, no issues
→ Phase 3: present report - adds retry logic with exponential backoff
→ User: "post the review"
→ Phase 5: draft and post "LGTM"
```

### Review with scope creep
```
User: "review mr 58"
→ Phase 1: fetch metadata, +2k/-100, 25 files
→ Phase 2: subagent → 1 test timeout, unnecessary abstraction,
    unrelated changes in config
→ Phase 3: present report
→ User: "draft the review"
→ Phase 5: draft review highlighting issues
```

### Quick review (trusted contributor)
```
User: "review mr 95"
→ Phase 1: fetch metadata, +200/-30, 6 files
→ Phase 1.5: user selects Quick
→ Q1: read diff, summarize: adds configurable tenant for auth
→ Q2: no obvious issues, tests included
→ Q3: draft and post "lgtm"
```

## Notes

- **NEVER duplicate user's previous comments** - check discussion history first
- **Proper error handling in code suggestions** - never ignore errors in snippets
- **Subagent for heavy lifting** - all file reading and analysis runs in subagent
- **External review is optional** - a second-opinion pass via `tclaude` (or `codex`) runs only if the tool is available; never block the review if it is missing or fails to launch
- **Interactive by design** - pause for questions after presenting findings
- **Explain non-obvious patterns** - don't assume user understands clever implementations
- **Simplicity bias** - always ask "could this be simpler?"
- **Project patterns matter** - code should look like it belongs in the existing codebase
- **Over-engineering is a bug** - unnecessary abstraction is problematic
- Use writing style: direct, brief, no AI-speak
