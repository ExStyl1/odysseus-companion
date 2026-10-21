# Continue the runtime-parity-closure plan (nessy-desktop)

> **Handoff document, written 2026-08-23.** It is the operating manual for
> `2026-08-22-runtime-parity-closure.md` — not a plan: no tracker, nothing here to execute.
> Hand it to whoever picks the plan up next; delete it when the plan is deleted.
>
> Two paths in it point at the previous session's scratchpad — **gone as of 2026-09-02; the directory no longer exists, so those artifacts are unrecoverable and only the row notes remain** —
> (`/private/tmp/claude-503/…/867097f9-…/scratchpad/sdd/`). Those artifacts are the prior briefs and
> reports — readable while that directory survives, and worth reading for a row's history, but they
> are machine-local and temporary. Everything durable is in the plan's own row notes.

> ## START HERE (rewritten 2026-09-02 — the 2026-08-23 warning below it is RESOLVED)
>
> The regression this box used to warn about is closed: **P2.93 ✅ `f3631c227`**, P2.71 ✅, P2.75 closed, the
> chain re-reviewed. Everything dated 2026-08-23 in this document is history; the plan's own
> `## Continuation protocol` — **item 10, "State at 2026-09-02"** — is the current operating note. In order:
>
> 1. `python3 scripts/plan-status.py` — read the **ledger-age stamp** before any percentage (the ledger was
>    last re-scored at `3288b115c`, 2026-08-30; **P3.263** re-scores it and precedes the CDP pass).
> 2. Read the plan's owner rulings of 2026-08-28 (goal = the agent loop; integration first; native-first;
>    read-don't-invent), 2026-08-31 (a lane fixes a small in-zone residue in place) and 2026-09-01 (four
>    decisions — P4.7 *do not build*, P3.242 *refuse naming the override*, P2.381 *explicitly disable*,
>    P3.129 *defer as a posture*). The tracker already reflects them.
> 3. The queue is the tracker, filtered by tag: `[doc:claude]`/`[doc:codex]` first; `[doc:none]` waits for the
>    verification pass except its two exceptions. **Row births are by design** (owner 2026-09-02) — report
>    the ratio with its window, never as a problem.
> 4. **OQ-14** (the fourth runtime, `nestor-cloud-agent`) is open and blocks only `[remote]` rows.
>
> <details><summary>The 2026-08-23 warning, kept as history</summary>
>
> ## ⚠️ Before you dispatch anything: `feat/TCODE-000` currently loses a permission deny
>
> A regression this plan introduced is **live on HEAD**, measured, with a reproduction in tracker row
> **P2.93**. Its own fix chain (`3f83aa51c`, `d76df0fbf`) was never reviewed — that agent was stopped
> mid-flight. **Read the section "START HERE — a live regression on HEAD" in §8 before choosing a
> row.** It gives three steps, in order, and they come before the parity queue. The owner has
> confirmed that order.
>
> </details>

You are the **controller** of a subagent-driven execution of one plan in
`/Users/i.i.gavrikov/Desktop/work/nessy-desktop`, branch `feat/TCODE-000`. A previous session ran
it to 68 closed rows of 153 and handed over mid-flight. Nothing is paused — read the warning above,
then orient and keep dispatching.

**Announce and use `superpowers:subagent-driven-development`** if that skill is available to you.
This document is the delta on top of it — what it cannot know about this plan, this repo and this
run — and it is self-contained enough to work without it: §2 states the loop, and §2 carries a
plain-git fallback for the one script the skill provides.

**Two things are machine-local, not in git.** `.superpowers/sdd/progress.md` (the ledger — **frozen: its last entry is dated 2026-08-28 11:35, nothing has been written since, so its tail is NOT fresher than the plan any more**) is
git-ignored, so it exists only in this checkout on this machine — if you are working from a fresh
clone it will be missing and you must reconstruct state from `git log` and the plan's row notes. The
same is true of the previous session's scratchpad referenced below.

**Answer the owner in Russian.** Code, commits, plan text and briefs stay in English.

---

## 0. First five minutes

```bash
cd /Users/i.i.gavrikov/Desktop/work/nessy-desktop
git log --oneline -25
python3 scripts/plan-status.py      # ledger age stamp, tracker counter, open rows by tag
git log --oneline -40 -- docs/superpowers/plans/2026-08-22-runtime-parity-closure.md
```

The plan's row notes and `git log` are fresher than this document (the progress ledger froze 2026-08-28). Then measure the tracker (§7) — never trust a
count you did not just take.

**Read `AGENTS.md` in full before your first dispatch.** It is binding project instruction and it
carries the repo's register of measured traps.

Prior briefs and reports live in the previous session's scratchpad:
`/private/tmp/claude-503/-Users-i-i-gavrikov-Desktop-work-nessy-desktop/867097f9-7afb-4480-a5d3-bfe33087163c/scratchpad/sdd/`
— readable, and worth reading when a row's history matters (`p<row>-brief.md`, `p<row>-report.md`).
**Write your own artifacts to your own scratchpad**, and create your own test-mutex lock path there
(§3); the old one belongs to a session that has ended.

---

## 1. The plan

`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` closes behaviour parity between the
three runtimes this Electron app embeds — **Pi**, **claude-runtime**, **codex**.

**It is the single source of truth for status.** The `## Tracker` table is the queue:
`✅` done · `⬜` open and dispatchable · `⏸` open but blocked on an owner answer.

Each row's Note carries its own evidence: what was measured, what was refuted, which alternatives a
reviewer already rejected and why. **Read the row before dispatching it** — most rows already
contain the decision, and re-litigating one wastes a wave.

### The doc corpora, and why they differ per runtime

- **Claude docs are both the spec for Pi and the integration contract for claude-runtime.** Pi is
  being pulled to parity *with Claude*, so a Claude page is Pi's requirements document. The plan
  cites `permission-modes.md` (×8), `sandboxing.md` (×7), plus `hooks.md`, `permissions.md`,
  `slash-commands.md`, `code-review.md`, `model-config.md`, `plugin-marketplaces.md`,
  `manage-app-updates.md`. Index: `https://code.claude.com/docs/llms.txt`, pages fetchable as
  `<url>.md`; the snapshot is `scripts/claude-doc-pages.tsv` — read its own `Snapshot:` line for the page count (191 on 2026-08-25; this document said 174, and `AGENTS.md` records the count moving 174 → 186 → 191 while prose still said 174) with verdicts in
  `docs/superpowers/specs/2026-07-31-claude-coverage-map.md`. That index is the whole corpus —
  `platform.claude.com/docs` is out of scope by owner decision.
- **Codex's corpus is `https://learn.chatgpt.com/llms.txt` — 139 pages, all of them already swept.**
  `docs/superpowers/specs/2026-08-22-codex-coverage-map.md` gives every page a row and a verdict,
  built by a 13-agent pass with adversarial verification (84 "gap / not our surface" verdicts
  re-checked, 2 refuted and corrected in place); the snapshot is `scripts/codex-doc-pages.tsv`.
  Standing tally: **3 pages with the contract taken, 48 🟨 (the feature exists here but no closed row
  cites the page), 12 🟥 (a real gap)** — that 🟨/🟥 set was what plan row **P5.2** was for, as **P5.1** was for Claude's — **both sweeps are closed (✅), and the stopping rule now runs on the capability ledger, not on the sweeps.**
  **Do not repeat the mistake this handoff's author made:** `AGENTS.md`'s "the useful subset is three
  pages" is about **plugins only**, not about Codex. The deepest integration we have is the
  **app-server** (`packages/codex-protocol`, built from the page's own `codex app-server generate-ts`
  recipe, pinned to `openai/codex rust-v0.148.0`, 249 schemas / 94 types), and its page is **🟨** —
  one narrow citation, contract not taken. Measured as never touched: `thread/resume` (deliberate),
  `thread/list|read|archive|delete|rollback`, `model/list`, `skills/list`, `hooks/list`, `plugin/*`,
  `app/*`, `command/exec*`, `process/*`, `review/start`, `config/read|write|batchWrite`,
  `configRequirements/read`, `fs/*`, `windowsSandbox/setupStart`, and the whole Auth block.
  For plugins specifically, practice (`github.com/openai/plugins`, 180 manifests) disagrees with
  spec — read both.
- **Pi has no external doc contract.** It is the subprocess we vendor and wrap; its "documentation"
  is `packages/pi-agent-server`'s README config knobs and its own code. There are zero Pi citations
  in the plan, correctly — there is nothing to check Pi against except Claude's behaviour.

**Citation discipline, learned the hard way here:** a doc line number decays, the quoted sentence
does not. Hang every citation on a **quoted sentence** with the fetch date, number as convenience
only. When a sentence moves, grep the repo for **the sentence**, not the old number. This plan
shipped citations to sentences that had moved, twice, and one file's header claimed all its
citations were freshly measured when six were not.

`.superpowers/sdd/progress.md` is the durable ledger — every dispatch, verdict, opened row and
controller error. It is git-ignored scratch; `git clean -fdx` destroys it, recover from `git log`.

---

## 2. The loop, as this run does it

```
brief → implementer → review package → reviewer → (fix wave → re-review) → pin the row
```

- **Every `Agent` dispatch carries `model: opus`.** The owner confirmed this explicitly for all
  background agents, subagents and workflows. Never omit it — an omitted model silently inherits.
- **Brief and report are files.** `scripts/task-brief` does not fit this plan's row shape; write the
  brief yourself to `<scratch>/sdd/p<row>-brief.md`, with every exact value: paths, the measured
  evidence, required tests, the exact commit message, the gate commands, the binding constraints.
  The dispatch prompt adds only what the brief cannot know. The report path is
  `<scratch>/sdd/p<row>-report.md`; the implementer returns **only** status, SHA(s), a one-line test
  summary, and concerns.
- **Review package.** With the superpowers plugin installed:
  `~/.claude/plugins/cache/claude-plugins-official/superpowers/<version>/skills/subagent-driven-development/scripts/review-package BASE HEAD`
  (it prints the path it wrote; the path is version-pinned, so `ls` that directory rather than
  trusting a version from this document). Without the plugin, the equivalent is three git commands —
  the reviewer only ever needs one file holding the commit list, the stat summary and the full diff:

  ```bash
  BASE=<commit that was HEAD before the implementer started>; HEAD=<implementer's commit>
  OUT=.superpowers/sdd/review-$BASE..$HEAD.diff
  { git log --oneline $BASE..$HEAD; echo; git diff --stat $BASE..$HEAD; echo; \
    git diff -U10 $BASE..$HEAD; } > "$OUT"
  ```

  **BASE is the commit that was HEAD before that implementer started**, never `HEAD~1`. With parallel lanes commits interleave, so you usually need one
  single-commit package per row rather than one range; verify with `git log --oneline BASE..HEAD`
  that the package holds exactly the commits you intend.
- **Fix waves and re-reviews go back to the SAME agent via `SendMessage`**, not to a fresh one. The
  reviewer keeps its measurement rig and its own findings; twice in this run a reviewer graded and
  **withdrew** its own claim on re-review, which a fresh agent could not have done.
- **Critical / Important → fix wave. Minor → fold** into whichever open row next holds that file, so
  it costs no commit; record in the row note which Minors went where.
- **Never pre-judge a finding for a reviewer.** If your dispatch prompt contains "do not flag", "at
  most Minor", or "the plan already chose" — delete it. Let the reviewer raise it; you adjudicate.

### Make agents challenge their instructions

Put this in every implementer dispatch:

> If your measurements contradict this brief, the measurements win — report the contradiction rather
> than implementing around it.

In this run implementers measured a brief's premise false **five times**, and every one was a real
correction: a failure mode worse than described, a rebuild attributed to the wrong bundle, a
"complete" enumeration that was short, a suggested one-liner that would have been incomplete, and a
stated test control that was vacuous. When an implementer contradicts a brief, hand that
contradiction to the reviewer as an **explicit adjudication item**.

Reviewers get the same posture: ask them to build their own rig with a positive control, to measure
the parent in a throwaway `git worktree` rather than reverting a contended file, and to try the
attack themselves where the row is a security gate.

---

## 3. Parallelism — two to four lanes, one working tree, no worktrees for implementers

- **Zone by FILE.** `git commit <pathspec>` commits the file's *working-tree state*, not your hunks,
  so two agents editing one file commit each other's half-finished work. Every dispatch names the
  zones other agents hold. This fired for real in this run; pathspec discipline caught it.
- **Test mutex is mandatory** — two concurrent `bun test` processes in this repo manufacture false
  failures (module-scope env mutation). Write your own `<scratch>/sdd/test-mutex.md` and put its path
  in every brief:

```bash
LOCK=<your scratch>/sdd/test-mutex.lock
until mkdir "$LOCK" 2>/dev/null; do
  if [ -d "$LOCK" ] && [ $(( $(date +%s) - $(stat -f %m "$LOCK") )) -gt 900 ]; then
    rmdir "$LOCK" 2>/dev/null
  else sleep 20; fi
done
# run the tests, then immediately:
rmdir "$LOCK"
```

  Never hold it while reading, editing or thinking. `tsc` and eslint need no lock.
- A `tsc` run can pick up another agent's half-finished edit **in a different package**. Tell agents
  to re-run before attributing an error outside their zone.
- **You are the only writer of the plan file.** Implementers never touch it.
- Four to five concurrent agents is the practical ceiling — beyond that they queue on the mutex.

---

## 4. Standing owner rules

1. **Findings become plan rows AT CONFIRMATION.** Every defect, premise correction or refuted claim
   goes into the plan — row, row note, or OQ entry — the moment it is confirmed. Never held as a
   "candidate" in your head or only in a subagent report. The owner tracks work through the tracker;
   anything outside it reads as dropped.
2. **New rows are inserted in SORTED position, never appended:**
   `python3 scripts/sort-plan-tracker.py <plan>` after any addition. It hashes the row multiset and
   refuses to write if content changed, so reordering can never edit a row. `--check` reports drift.
3. **Phase 4's new UI surfaces are drawn in the playground LAST**, after phases 2 and 3 close, so the
   design is made against data that actually exists; the owner reviews and corrects them there before
   they move into the app. Those are the `⏸` rows — do not build them early.
4. Resolved open questions, recorded in the plan: OQ-1 ALIGN · OQ-2 KEEP STRICTER · OQ-3 STRICTER ·
   OQ-4 literal-per-page · OQ-5 keep orphaned session trees.

---

## 5. Traps that fired in THIS run

`AGENTS.md` and `docs/superpowers/specs/2026-08-21-measured-traps.md` carry the full register. These
are the ones that actually bit here:

- **A test that passes in every world, including the broken one.** Twice: one row mapped a field the
  type does not have (`undefined === undefined`); another asserted `allowed === true` for a tool that
  falls through to `true` when *no rule loads at all* — a misspelled fixture filename made both
  branches answer `true`. Both were caught by their own authors. **The pattern that catches it: after
  tightening a test, deliberately re-break the tree, confirm each row still fails for its own reason,
  then restore.**
- **A guard nobody attacked.** A source-regex tripwire caught **1 of 8** evasion shapes while failing
  on any *legitimate* new call site. It was deleted, not sharpened. Ask every guard's author for the
  evasion set they measured.
- **A comment-only commit can author a truth regression** — one did. Comment-only waves get a real
  re-review, and the proof needs a declared non-empty byte floor plus a sighted positive control:
  **transpile-and-hash false-passes** when the transpiler errors and stderr is discarded, because
  every hash becomes the SHA-256 of the empty string.
- **`rg -a` for every absence claim** — some files carry a NUL byte and plain grep skips them
  silently (`packages/shared/src/agent/base-agent.ts` is one).
- **An absence finding needs a positive control on the same rig.**
- **`rm -rf release` before any repo-root `bun test`.** Do **not** delete
  `packages/pi-agent-server/dist` — that breaks the dev app's Pi path until it is rebuilt.
- **Known pre-existing failures, do not chase:** `monitor-ws-approval`,
  `filesystem-scope-revocation`. (The 18 rows of `pre-tool-use-checks.isolated.ts` are RETIRED from
  this list — W5-j/P3.355, `3c7bcc951`: all eighteen were diagnosed into three causes and fixed, the
  file is `205 pass / 0 fail`, and it now runs in CI through `bun run test:isolated`.)
  Register: `docs/superpowers/specs/2026-07-29-known-failing-tests.md` — diff it **by name**, never
  by count.
- **`mock.module` without a spread** amputates the module for every later test file in the process;
  without a restore it is permanent. Spread AND restore.

### Controller errors from this run — do not repeat them

- **`ls` a brief and a source path before naming either in a dispatch.** Three briefs carried a wrong
  module path; a wrong path into a real sibling directory reads as plausible and costs a round.
- **Never report a count you did not just measure.** A hand-incremented tally drifted for many turns
  before the owner caught it.
- **Order two commits that touch one helper so no intermediate state is worse than either endpoint.**
  A mandated order left a genuinely destructive `cmd` command unguarded at the intermediate commit;
  the stated reason (file contention) was symmetric and did not bind a direction.
- **A deferral's RATIONALE propagates into the plan and gets executed later.** A row was filed
  carrying an implementer's wrong reasoning and would have produced a half-fix. Grade the reason a
  finding is deferred as carefully as you grade a fix.
- **Escape `|` inside a tracker cell as `\|`** — an unescaped pipe breaks the table and shifts the
  status column for any column-based parse.
- **Edit the plan by cell index, never by prose anchor** — a prose anchor once matched a different
  row's note and aborted the write.

---

## 6. Gate commands

```bash
bun install --frozen-lockfile
bun run typecheck:all
bun run lint
bun test
```

Per-package, which is what a focused row needs:

```bash
cd packages/shared && bun run tsc --noEmit
cd packages/shared && npx eslint <files>
```

`packages/shared/eslint.config.mjs` **does exist** (one task wrongly reported it did not).
`typecheck:all` never covers `packages/pi-agent-server`'s tests — tsc a touched test file there via a
config without the exclusion.

**Implementation-first verification budget** (AGENTS.md, binding): during the loop run only focused
tests for changed behaviour, affected-package typechecks, directly affected contract tests, and
`git diff --check`. Full repo typecheck/lint/test, builds and packaging happen at a verification-wave
boundary or final close-out — not per row.

---

## 7. Measuring and editing the tracker

The obvious `awk -F'|'` one-liner is **unsafe** — notes contain escaped pipes:

```bash
python3 - <<'PY'
import io,re
from collections import Counter
p='docs/superpowers/plans/2026-08-22-runtime-parity-closure.md'
rows=[l for l in io.open(p,encoding='utf-8') if re.match(r'^\| (P\d+\.\d+|T\d+[a-z]?) *\|', l)]
S=re.compile(r'(?<!\\)\|'); c=Counter(); open_rows=[]
for l in rows:
    cells=[x.strip() for x in S.split(l)]; c[cells[3]]+=1
    if cells[3]=='⬜': open_rows.append(cells[1])
print('total',len(rows),dict(c)); print('open:', ' '.join(open_rows))
PY
```

Pin by **cell index** (1 = row id, 3 = status, 4 = commit, 5 = note):

```python
i=[k for k,l in enumerate(lines) if l.startswith('| P2.76 |')][0]   # assert exactly one hit
cells=re.split(r'(?<!\\)\|', lines[i])
cells[3]=' ✅ '; cells[4]=' <sha> '; cells[5]=cells[5].rstrip()+' '+note+' '
lines[i]='|'.join(cells)
```

Then sort, then **check the diff size before committing**:

```bash
python3 scripts/sort-plan-tracker.py docs/superpowers/plans/2026-08-22-runtime-parity-closure.md
git add docs/superpowers/plans/2026-08-22-runtime-parity-closure.md
git diff --cached --numstat     # changed lines must equal the rows you touched
git commit -m "docs(plan): ..." docs/superpowers/plans/2026-08-22-runtime-parity-closure.md
```

More changed lines than rows you edited means you truncated something — that happened once, 20 rows
were lost and restored from the parent commit. Commit the plan **separately** from code.

**What a pin's Note should say:** not "approved". Write what lets a stranger re-derive the verdict —
the measurement and its positive control, the premise corrected and by whom, the alternatives
rejected and why, the Minors folded into which rows, and any residue left standing with its reason.
Two generators harvest these notes. **Never delete a finished plan.**

---

## 8. Where the work stands

At handoff: **68 ✅ · 80 ⬜ · 5 ⏸ · 153 rows.** Re-measure before trusting it.

42 rows at birth, 153 now, **nothing deleted**. ~60 % of the added rows came from the review layer —
reviews here measure rather than read. Open rows held flat near 40 for the first day and have climbed
since phase 2 (the permission core, the most shared code in the repo) began in earnest. Branching
factor is near 1 excluding one-off audit sweeps. **Do not promise the owner convergence** — report
the measured open count.

### START HERE — a live regression on HEAD, and no review to lean on (2026-08-23, ~23:00) — RESOLVED, historical

> **2026-09-02:** P2.93 ✅ `f3631c227`; P2.71 ✅; P2.75 closed; the chain was re-reviewed. Read the box at the top of this document instead.

**P2.71's fix is incomplete and `feat/TCODE-000` currently loses a deny.** Its fix wave landed
(`3f83aa51c`, `d76df0fbf`) and closed two instances; the re-review agent was then **stopped by a
session exit before writing any verdict**, so there is no review of that fix wave — only its rigs.

Before stopping, that reviewer had built a rig hunting for a third instance. The previous controller
ran it: **it fires.** The construct is a **sh heredoc**, the trigger is an ordinary English
apostrophe, and the full reproduction with its controls is in row **P2.93** — measured, not
suspected. `deny Bash(rm:*)` goes match → no-match, the DSL verdict goes deny → none, and the removal
breaker goes from a home/root hit to null.

**So the first three things to do, in this order:**

1. **Fix P2.93.** One line, per the standing ruling: a `<<` heredoc marker disarms the comment rule
   for that command, exactly like the shipped `$'` and `<#` guards. Do **not** model heredocs — the
   plan carries a measurement showing the accurate parser had the strictly larger blast radius.
2. **Re-review the whole P2.71/P2.75 chain**, including the fix wave nobody reviewed. Its own author
   predicted this third instance in writing, so treat "is there a fourth?" as the review's main
   question rather than a formality.
3. Only then pin P2.71 and P2.75 and move to the parity queue.

Everything else below was written before that discovery; the priority ruling and the row queue are
unchanged.

### In flight when this was written (2026-08-23, ~22:00)

**One fix wave, and it is a Critical in a permission gate — start here.**

Rows **P2.71** (`9a7d2ebe1`) and **P2.75** (`f11e4aab8`) are committed and reviewed. P2.75 is clean
and closes as soon as one undisclosed widening is pinned. **P2.71 must not close as it stands**: its
review constructed, and executed against the real shell, a command that makes a `deny Bash(rm:*)`
rule stop matching and an `allow Bash(git commit:*)` rule auto-approve what used to prompt. Both
rows' full evidence is in their tracker notes; the fix wave's exact ask is reproduced there too.

The fix wave was dispatched to the P2.71 implementer moments before this handoff and may or may not
have committed. **Check `git log --oneline` for `fix(permissions): ansi-c quoting cannot hide a
subcommand` and `docs(permissions): the powershell suppression widens glob allows`.** If both are
present, package them and send the re-review to the reviewer that raised it, asking it to re-run its
own `$'…'` cases and its DSL end-to-end table. If they are absent, re-dispatch the fix from P2.71's
row note — it contains the measured cases, both acceptable fix shapes, and what is *not* sufficient.

Nothing else was running. Everything else in `⬜` is free to dispatch.

**Determine what is in flight** from the ledger tail plus `git log`. Do not dispatch into a zone
until its outstanding review has landed.

### Priority — read this before picking a row (2026-08-23 ruling; SUPERSEDED in part)

> **2026-09-02:** the buckets below were measured on a 153-row tracker. The governing rulings now are the plan's
> `## Owner ruling 2026-08-28: the goal is the AGENT LOOP`, `## Priority from 2026-08-28: integration first`,
> `## Owner ruling 2026-08-31: a lane FIXES a small in-zone residue`, and `## Owner decisions 2026-09-01`. The
> 2026-08-23 ruling on the permission-matcher internals ("the splitter gets DUMBER") still stands and is quoted
> below; the row lists are history.

The owner ruled on 2026-08-23: **parity of Pi with Claude, plus covering the Claude and Codex
surfaces, comes first; the permission matcher's internals come last.** The plan carries the full
ruling and the measured buckets under `## Owner priority decision (2026-08-23)`. In short: take the
**21 open Phase-2 rows from the original plan** and the **17 Phase-3 (Codex) rows** first, then
**P5.1/P5.2** (the 🟨 sweeps — that is what "cover the surfaces" means concretely), and leave the
**33 finding-born Phase-2 rows** about quoting, tokenizing and comment handling for last. Several of
those may be right to close as recorded-and-accepted rather than fixed.

**Two owner rulings resolved on 2026-08-23 govern that deferred bucket — read them in the plan
(`## OQ-6 …` and `## Owner ruling on the deferred internals …`) before touching any of the 33:**

- **OQ-6 resolved: our host-side gate enforces on all three runtime paths.** The SDK's own engine is
  deliberately bypassed. Decided on maintenance cost under upstream churn — delegating to the SDK
  would not remove our engine (Pi and codex have nothing to delegate to, and our protected paths,
  removal breaker, worktree approval and classifier routing do not exist in it), it would add a
  second one whose changes arrive silently inside a minified bundle.
- **The splitter gets DUMBER, not smarter.** Anything we are not sure of falls to `unparseable` →
  prompt, rather than being parsed cleverly. The plan carries a three-way triage rule (retired /
  converted / kept) — apply it to the 33 instead of working them one at a time. Most retire.

Why the split is principled and not just triage: Claude's docs specify the rule vocabulary, the
modes, the protected paths and the classifier routing — all parity, all cited here. They say nothing
about how a command line is split into subcommands. That splitter is our own re-implementation, so
rows about its internals are correctness work we own, not parity gaps.

**The one exception is the in-flight Critical below** — it is a regression this plan introduced, not
depth, so it is finished or reverted rather than deferred.

### Good next dispatches (2026-08-23 — STALE)

> **2026-09-02:** every row in this list is closed except P2.83. Do not pick from it. Print the queue with
> `python3 scripts/plan-status.py` and read the plan's Continuation protocol item 10.

- **P2.76** — `packages/shared/src/agent/pi-agent.ts`, four items in one sweep: nine case-body
  catches that render a thrown value unsafely, the `event` belt's own catch at `:3031`/`:3034` (the
  only unconverted belt catch, which also defeats the per-signature fault bound there),
  `automation_event`'s floating promise, and a hash suffix for the 200-char signature key.
- **P2.82** — the leading-invisible hole. Its row was amended **three times**; read it carefully. The
  family is **four** line-anchored patterns, not three, and the fix is smaller than first described:
  one widened leading-class fragment plus a loosened `Tool ` separator.
- **P2.83** — one behaviour-neutral assertion pinning `JSON.stringify`'s newline-freedom in
  SessionManager's own suite. **P2.53 cannot close until this lands.**
- **P2.57 / P2.61** — the stale-key cancel that strands a host card; the capture-before-teardown
  ordering.
- **P3.17 / P3.18 / P3.19 / P3.22** — all `SessionManager.ts`. **Sequence them, do not parallelise.**
- **P2.67 / P2.68** — read both notes first; the obvious fix for P2.67 is probably wrong, because
  those artifacts are *dated verdict records* and renumbering them would falsify the record.
- **P2.81** — sweep the permission suites for bare `toBe(true)` verdict assertions with no
  reachable-deny control on the same fixture.

Phase 5 (`P5.1`–`P5.4`) is the close-out and comes last.

---

## 9. Close-out obligations (row P5.4)

- Version bump in **both** root and `apps/electron` `package.json` (lockstep).
- A **new** `apps/electron/resources/release-notes/<version>.md` — append-only; follow `1.0.2.md`.
- Update affected `docs-site/` pages.
- Update `docs/testing/cdp-live-checklist.md` — one case×runs table, a row per case this plan added or
  changed; narratives to `docs/testing/cdp-runs/`.
- **Two distinct owed rebuilds — running only one ships a stale half:**
  - `bun run electron:build` — the electron **main** bundle. `pi-agent.ts` is host-side;
    `apps/electron/dist/main.cjs` has been stale since `e0d036f31`.
  - `bun run electron:build:servers` — the packaged **Pi** bundle.
    `apps/electron/resources/pi-agent-server/index.js` inlines a copy of `untrusted-text.ts`.
  - Verify each with **string-literal positive controls in both directions** — bundlers never rename
    string literals, which makes that check decisive rather than circumstantial.
- Regenerate both generated specs and commit their output:
  `python3 scripts/build-parity-report.py > docs/superpowers/specs/2026-07-30-parity-report.md`
  `python3 scripts/regenerate-deviation-register.py > docs/superpowers/specs/2026-07-29-deviation-register.md`
- The owner asked for a **live runtime-switch verification in-session** before the plan is called done.
- Then the plan's complete final regression, on the final tree.
- **No MRs, no tags, no pushes** during autonomous execution. One commit per row with the plan's
  subject. **No `Co-Authored-By` trailers.**
- **Added 2026-09-02:**
  - **P3.263 first** — the capability ledger is the CDP pass's index and has not been re-scored since
    `3288b115c` (2026-08-30); a pass indexed by a stale ledger certifies the wrong cells.
  - The **nine NCA cases** have been written and never run (live gateway + signed-in card).
  - **OQ-14** must be answered before the `[remote]` rows (P2.335, P2.58) can close either way.
  - `scripts/plan-status.py` must print an empty lost-pin invariant on the final tree.
