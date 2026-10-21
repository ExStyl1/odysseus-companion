---
name: Simplify
description: Review the changed code for reuse, simplification, efficiency and altitude cleanups, then apply the fixes. It does not hunt for correctness bugs — /code-review does that. A target may be a file path, a branch name, or a ref range such as main...my-feature. Use when the user types /simplify.
disable-model-invocation: true
argument-hint: "[effort] [target]"
---

# Simplify

Run a **cleanup-only** review of the current change and **apply what it finds**.

`commands.md` § *All commands*, verbatim: "Review the changed code for cleanup
opportunities and apply the fixes. Four review agents run in parallel, covering
reuse of existing helpers, simplification, efficiency, and whether the change is
at the right level of abstraction. The review doesn't look for correctness bugs.
Use `/code-review` to find bugs. Pass a path or PR reference to review a
specific target."

This is the SAME reviewer `/code-review` runs, with a cleanup-only preset — not
a second review path. Everything `/code-review` says about targets, effort and
reporting holds here; only the categories and the default for fixing differ.

## Step 1 — read the arguments

```
/simplify [effort] [target]
```

1. **Effort** — only a leading bare word that is one of `off`, `low`, `medium`,
   `high`, `xhigh`, `max`. Anything else in first position is part of the target.
2. **Target** — everything left, verbatim. If it does not name a branch, path or
   range, treat it as a note and pass it as `instructions`; never drop it.

`--fix` is not a flag here: applying the fixes is what this command IS. If the
user types it anyway, accept it silently rather than refusing.

## Step 2 — run the review

**When the `review` tool is in your tool list, call it.** Pass the target the
arguments named — `base` for a branch, `range` for a ref range, `paths` for file
paths, `commit` for a single sha, `scope: "uncommitted"` for the working tree
alone, nothing at all for the default — **at most one** — and put the cleanup
preset in `instructions`, ahead of any note the user attached:

> Cleanup pass only. Report `reuse`, `simplification` and `efficiency` findings,
> including whether the change sits at the right level of abstraction. Do not
> hunt for correctness bugs.

**`review` ships with the Pi runtime only.** When it is absent — a claude or a
codex session — do not say the command is unavailable and do not answer as
though a review had run. Instead:

1. **Call `ReviewDiff`** if it is in your tool list. It is the host's own diff
   port and is present on every runtime that has no `review`, so the scope of a
   cleanup pass is the same wherever the session runs. It takes the same target
   fields, and its reply carries the diff, the rubric and the reviewer agent's
   name.
2. **Delegate to a subagent**, read-only if the runtime offers one, handing it
   that diff, that rubric, and the cleanup preset above. The review runs in its
   own context window so a large diff does not crowd out the user's work.
   **Leave it in the BACKGROUND.** On claude that is already the default —
   "Agents run in the background by default; you will be notified when one
   completes." — and on codex spawning and waiting are two separate tool calls
   (`spawn_agent`, then `wait_agent`), so spawn the reviewer and let the turn
   continue. Because this command APPLIES what comes back, backgrounding changes
   only WHEN you edit: step 3 still runs in this conversation, once the findings
   land, and nothing is edited before then.
3. Only if neither is available, do the review yourself in this conversation,
   and say once that is what happened.

Do not run `git diff` by hand while `ReviewDiff` is there.

## Step 3 — report the cleanups, then apply them

Report through `ReportFindings` when it is available — one call, every finding —
mapping `title` to `summary`, `body` to `failureScenario` and `category`
unchanged.

**Keep only `reuse`, `simplification` and `efficiency`.** Those are the three
categories this reviewer emits for cleanups.

**Altitude has no category of its own here**, and that is a deliberate
difference from the page's four agents: a finding about the level of abstraction
is reported as `simplification`, and its text says so. Do not invent a fourth
category name — `ReportFindings` would reject it.

**A correctness finding is not silently dropped.** This command does not report
bugs, but hiding one the reviewer already found would be worse than the noise:
say in ONE line that the reviewer also raised N correctness findings and that
`/code-review` reports them, then leave them out of the list and out of the
fixes.

Then **apply the cleanup findings** to the working tree with the ordinary
Edit/Write tools and say what changed. These edits are part of this session, so
`/rewind` restores them.

Finally, re-report the same list through `ReportFindings` with `outcome` set on
every entry — `fixed`, `skipped`, or `no_change_needed` — exactly as
`/code-review` does after a `--fix`. Re-report the WHOLE list: the updated list
replaces the previous one.

## When there is nothing to do

If the review reports no changes to review, say which scope was empty — most
often the branch has no commits ahead of its upstream and the working tree is
clean. If it found only correctness findings, say so and stop; do not
manufacture a cleanup to have something to apply.
