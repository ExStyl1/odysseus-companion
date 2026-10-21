---
name: Security Review
description: Run one security pass over the changes on the current branch — injection, auth, secrets and data exposure — against the default branch on origin. Reports findings; it does not apply fixes. Use when the user types /security-review.
disable-model-invocation: true
argument-hint: "[base-branch]"
---

# Security Review

One security pass over what this branch changed.

`commands.md` § *All commands*, verbatim: "Analyze the changes on your current
branch for security vulnerabilities. Reviews the diff between your branch and
origin's default branch, identifying risks like injection, auth issues, and data
exposure." `claude-security.md` places it in the stack as the "On demand, single
pass ... One-time security pass on the current branch".

This is the SAME reviewer `/code-review` runs, with a security preset — not a
second review path. Only the rubric and the default target differ.

## Step 1 — pick the diff

The default target is **the merge-base with the default branch on `origin`**. If
the user typed a branch name after the command, use that instead.

Pass it as the review's `base` field. The host's own review port resolves the
merge-base for you, so this command does **not** shell out to
`git diff origin/HEAD...` the way the upstream implementation does, and the
`ambiguous argument 'origin/HEAD...'` failure that comes with it cannot happen
here.

What can still go wrong is the ref itself: if the session has no `origin`
remote, or `origin/HEAD` is not set, say so and offer the fix from the error
reference — `git remote set-head origin <default-branch>`, or
`git fetch origin && git remote set-head origin --auto` — then review this
branch's commits ahead of its upstream instead of stopping.

## Step 2 — run the review with the security preset

**When the `review` tool is in your tool list, call it** with the `base` from
step 1 and this preset in `instructions`:

> Security pass. Read the diff for exploitable weaknesses the change
> INTRODUCED: injection (SQL, shell, path, template), authentication and
> authorization gaps, secrets or credentials committed or logged, unsafe
> deserialization, missing or wrong input validation, sensitive data reaching a
> log, a URL, an error message or a third party, unsafe defaults, and weakened
> cryptography. Report each as `category: "correctness"` and open the finding
> text with the risk class. Ignore style, naming and performance.

**`review` ships with the Pi runtime only.** When it is absent — a claude or a
codex session — do not say the command is unavailable and do not answer as
though a review had run:

1. **Call `ReviewDiff`** if it is in your tool list. It is the host's own diff
   port and is present on every runtime that has no `review`, so a security pass
   covers the same changes wherever the session runs. It takes the same `base`
   field, and its reply carries the diff, the rubric and the reviewer agent's
   name.
2. **Delegate to a subagent**, read-only if the runtime offers one, handing it
   that diff, that rubric, and the preset above. **Leave it in the BACKGROUND.**
   On claude that is already the default — "Agents run in the background by
   default; you will be notified when one completes." — and on codex spawning and
   waiting are two separate tool calls (`spawn_agent`, then `wait_agent`), so
   spawn the reviewer and let the turn continue. This command reports and stops,
   so the findings are the only thing waiting on it: report them when they land,
   and never answer as though the pass had finished before it has.
3. Only if neither is available, do the pass yourself in this conversation, and
   say once that is what happened.

Do not run `git diff` by hand while `ReviewDiff` is there.

## Step 3 — report

Report through `ReportFindings` when it is available — one call, every finding —
mapping `title` to `summary`, `body` to `failureScenario` (the concrete way the
weakness is exploited) and `file` including the line.

**There is no `security` category**, and that is worth saying rather than
working around: this reviewer's categories are `correctness`, `reuse`,
`simplification`, `efficiency` and `test-coverage`, and `ReportFindings` rejects
anything else. A security finding is a `correctness` finding whose text names
the risk class first — "Command injection: ...". Do not invent a category.

Order the findings most-severe-first and give the overall verdict in your own
reply.

## What this command does not do

- **It does not apply fixes.** Report what it found and stop. If the user wants
  the fixes applied, they can say so and you apply them in this conversation.
- **It is not a full audit.** It reads the diff, plus whatever the repository
  needs to confirm a finding. Weaknesses the change did not introduce are out of
  scope, exactly as in `/code-review`.
- **It is not a scanner.** There is no SAST tool behind it; it is a model
  reading a diff against the rubric above.

If the diff is empty, say which scope was empty — most often the branch has no
commits ahead of the default branch — rather than reporting a clean pass over
nothing.
