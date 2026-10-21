---
name: Code Review
description: Review a diff and report correctness bugs plus reuse, simplification and efficiency cleanups. By default it reviews this branch's commits ahead of its upstream plus any uncommitted changes; a target may be a file path, a branch name, or a ref range such as main...my-feature. Use when the user types /code-review.
disable-model-invocation: true
argument-hint: "[effort] [--fix] [target]"
---

# Code Review

Review a diff in this session and report what it found.

**When the `review` tool is in your tool list, run it.** It spawns the read-only
reviewer agent over a host-computed diff and returns findings ordered
most-severe-first with an overall verdict.

**`review` ships with the Pi runtime only, so on any other runtime it is not
there; on Pi it is in your tool list from the start — run it, per the line
above.** When it is absent: do not call it, do not tell the user the command is
unavailable, and above all do not answer as though a review had run. Run the
review in a subagent instead, so it still gets its own context window — see
"Reviewing without the `review` tool" at the end of this file. Everything else
is the same either way: argument parsing, targets, flags, `ReportFindings`.

## Step 1 — read the arguments

`$ARGUMENTS` is everything the user typed after the command, in this order:

```
/code-review [effort] [--fix] [target]
```

Read it left to right and stop guessing early:

1. **Effort** — only a leading bare word that is one of `off`, `low`,
   `medium`, `high`, `xhigh`, `max`. Anything else in first position is part of
   the target.
2. **Flags** — `--fix` and `--comment`, in any order, after the effort word.
3. **Target** — **everything left, verbatim, even when it starts with `/`.**
   `/code-review /fix-issue 123` reviews with the literal text `/fix-issue 123`
   as its target — do NOT load `/fix-issue` as a second stacked skill. The
   target is never re-parsed as a command.

Nothing after the effort word and the flags is a keyword. If the remaining text
does not name a branch, path or range, treat it as a note and pass it as the
review tool's `instructions` instead of dropping it. Without the tool, carry the
note into your own review as an extra instruction — never drop it.

### Effort

Pass the level you read as the review tool's `effort`. Without the tool, the
level is still yours to honour: it sets how broadly you look, not a parameter.

- When the user typed a level, use it, and use that same level for later
  `/code-review` runs in this conversation unless they type a different one.
  Say which level you reused when you reuse one.
- When the user has never typed a level in this conversation, omit `effort`
  entirely — always, even in a brand new session. The host fills in the last
  level typed in an EARLIER session when there is one, and tells you it did;
  with nothing remembered the review runs at the session's current effort.
- **The carry-over is the host's, not yours.** `code-review.md` says the review
  reuses the last level from `low` through `max` you typed,
  **even in an earlier session**. This build remembers that level outside the
  conversation, so do not try to carry it yourself and do not guess one: when a
  review starts at a carried-over level you are told which, before it runs. Say
  that level in your first line, the same way you would for a level reused
  inside this conversation.

`low` and `medium` report only the findings the reviewer is most confident in.
`high` through `max` broaden coverage and admit findings it is less sure about.

### The neighbouring commands

Two sibling commands run the SAME reviewer with a different preset, so send the
user to one rather than reproducing it here:

- **`/simplify`** — cleanups only, and it applies them. Reach for it when the
  user wants the code tidied rather than audited.
- **`/security-review`** — one security pass over this branch against the
  default branch on `origin`. It reports; it does not fix.

### Targets

| What the user typed | What to pass |
| :--- | :--- |
| nothing | nothing — the default scope is already commits-ahead-of-upstream plus the working tree |
| a branch name (`main`, `origin/main`) | `base` |
| a ref range (`main...my-feature`, `a..b`) | `range` |
| one or more file paths | `paths` |
| a commit sha | `commit` |
| `uncommitted`, "just my working tree" | `scope: "uncommitted"` |

Two targets the page for this command describes that this build cannot serve.
Say so plainly and do the useful thing rather than failing or guessing:

- **A pull-request number.** There is no GitHub path in this build. Tell the
  user, and offer the equivalent local review — the PR's branch as `base`, or a
  `range`. Never guess that a bare number is a PR.
- **`ultra`.** Cloud ultrareview is not available here. Run the local review in
  this session instead and say that is what you did. If a single word follows
  `ultra`, treat it as the base branch; if longer text follows, treat it as a
  note and pass it as `instructions`.

### Flags

- `--fix` — after the review returns, apply the findings to the working tree
  with the normal Edit/Write tools, then say what you changed. You apply them in
  THIS conversation whenever the findings arrive — a backgrounded review does not
  change that — so the edits are part of the session and `/rewind` restores them.
- `--comment` — posting inline pull-request comments is not supported in this
  build: there is no GitHub integration. Say so and continue with the review;
  do not silently ignore the flag.

## Step 2 — report the findings

If the `ReportFindings` tool is available, report through it — one call, every
finding — instead of printing the list as prose. Otherwise print the findings as
text.

Map each review finding onto the report entry:

| Review finding | `ReportFindings` entry |
| :--- | :--- |
| `file` (and `line`) | `file` — include the line, e.g. `src/auth.ts:142` |
| `title` | `summary`, the one-sentence version |
| `body` | `failureScenario` — the concrete case in which it fails |
| `category` | `category`, unchanged: `correctness`, `reuse`, `simplification`, `efficiency` or `test-coverage` |

`priority` and `verdict` have no field on the report entry. Keep them in your
own reply — they are not the finding's `outcome`.

Do not set `outcome` in this first report. It exists only for step 3.

## Step 3 — re-report after fixing

When you later fix findings from a report you already made — because the user
asked, or because `--fix` was passed — report the SAME list again through
`ReportFindings`, and this time set `outcome` on every entry:

| What happened to the finding | `outcome` |
| :--- | :--- |
| you changed the code and it is resolved | `fixed` |
| you deliberately left it alone | `skipped` |
| you looked and there was nothing to change | `no_change_needed` |

Re-report the whole list, not only the entries that changed: the updated list
replaces the previous one, so an entry left out disappears from it.

## What the review does and does not cover

The reviewer reads only the diff plus whatever it needs from the repository to
confirm a finding, and it is read-only — it never edits, and it never runs
commands. It flags defects the change INTRODUCED; pre-existing bugs are out of
scope by design. Cleanups (`reuse`, `simplification`, `efficiency`) never make
the verdict "patch is incorrect" on their own.

If the review reports no changes to review, say which scope was empty — most
often the branch has no commits ahead of its upstream and the working tree is
clean.

## Reviewing without the `review` tool

`review` is a Pi-runtime tool. When it is not in your tool list, everything above
still describes the job — only the mechanism changes, and the answer the user
gets must be a real review, not an apology.

### Run the review in a subagent, not in this conversation

`/code-review` is a review that runs **in its own context window**, on every
runtime. The page for this command is explicit about it: "The review runs as a
background subagent with its own context window, so it doesn't fill your
conversation." That isolation is what keeps a large diff from crowding out the
work the user is actually doing, and it is provided by the runtime you are
already on — you do not need a review tool to get it.

So: **delegate the review to a subagent** with whatever mechanism this runtime
gives you for spawning one, and prefer a **read-only** agent type when one is
offered (an exploration or research agent, for instance). Give the subagent the
whole task — the target, the effort level, and any note the user attached — and
let it read the diff itself. What comes back to this conversation is the
findings, not the diff.

**Leave the subagent in the BACKGROUND, and do not opt out of it.** The
direction is the same one the page states, and on every runtime that has a
default it is already the default — so honouring it usually means passing
nothing:

- **claude** — the subagent tool's own parameter says it: "Agents run in the
  background by default; you will be notified when one completes." A review is
  not the exception that parameter describes ("your very next action depends on
  this agent's result and nothing else could usefully happen while it runs"):
  the user can keep working while it reads the diff. Pass no direction and let
  the default stand.
- **codex** — spawning a subagent and waiting for one are two separate tool
  calls (`spawn_agent`, then `wait_agent`). Spawn the reviewer, let the turn
  continue, and wait for it when you are ready to report — not in the same
  breath as the spawn.
- **A runtime whose only subagent call blocks** gives you a foreground review,
  and that is fine. Say once that it ran that way; do not pretend otherwise.

Backgrounding changes WHEN the findings arrive, never whether they are reported:
report them through `ReportFindings` when they land, exactly as step 2 says, and
`--fix` applies them after that in this conversation, exactly as step 3 says.

**Do not ask for an isolated copy of the repository.** A worktree branches from
the default branch or from HEAD and carries **no uncommitted changes**, which is
half of what a local review exists to read — a reviewer in one would silently
review the wrong tree. The reviewer must see the **live** working tree. The
isolation that matters here is the subagent's context, which you already have.

Say once, plainly, that you ran the review in a subagent because the reviewer
tool is not available on this runtime. Do not repeat it per finding.

### What to put in the subagent's task

1. **The diff to read.** **When `ReviewDiff` is in your tool list, call it
   first.** It is the host's own diff port, and it is there on every runtime
   that has no `review`: it computes the diff for you, so the scope of a review
   is the same wherever the session runs. Pass the target the arguments named —
   `base` for a branch, `range` for a ref range, `paths` for file paths,
   `commit` for a single sha, `scope: "uncommitted"` for the working tree alone,
   nothing at all for the default — **at most one**, and carry the user's note
   in `instructions`. The reply names the reviewer agent and carries the diff,
   the rubric and the task text: hand that pair to the subagent as its prompt,
   and do **not** run `git diff` by hand while the tool is there.

   **Only if `ReviewDiff` is absent too** — the reply "no host diff service is
   bound to this session" says so — describe the diff by the target the
   arguments named and let the subagent read it itself:

   | Target | Diff to read |
   | :--- | :--- |
   | nothing (default) | `git diff @{upstream}...HEAD` **and** `git diff HEAD` for the working tree |
   | a branch name | `git diff <branch>...HEAD` |
   | a ref range | `git diff <range>` |
   | file paths | `git diff HEAD -- <paths>` |
   | a commit sha | `git show <sha>` |
   | `uncommitted` | `git diff HEAD` |

   If the branch has no upstream, say so and review the working tree.

2. **The rubric**, unchanged from what the tool's reviewer uses — verbatim from
   `ReviewDiff`'s reply when it ran, and otherwise this: read the diff plus
   whatever the repository needs to confirm a finding. Flag defects the change
   INTRODUCED; pre-existing bugs stay out of scope. Cleanups (`reuse`,
   `simplification`, `efficiency`) never make the verdict "patch is incorrect" on
   their own.

3. **Read-only**, explicitly: the reviewer never edits and never runs commands
   beyond the reads above. `--fix` still applies afterwards, in THIS conversation,
   exactly as in step 3.

4. **Ordered output**: findings most-severe-first, each with a file reference, a
   one-sentence title, the concrete failure case, and a category.

### If this runtime cannot spawn a subagent at all

Then YOU are the reviewer, in this conversation. Follow the same three points
above yourself, and say once that the review ran inline because neither the
reviewer tool nor a subagent was available. This is the last resort, not the
default: it is the only path here that spends the user's own context on the diff.

### Reporting, either way

**Report through `ReportFindings`** — it is a session tool and is present on
every runtime, so steps 2 and 3 above are unchanged. Give `priority` and the
overall verdict in your own reply, as always. A subagent's findings are reported
by YOU, in this conversation, after it returns.
