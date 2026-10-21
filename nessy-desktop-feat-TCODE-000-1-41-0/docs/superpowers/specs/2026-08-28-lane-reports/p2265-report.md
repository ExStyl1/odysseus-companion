# P2.265 — attributing the "82 failures", measured

**Headline: the 82 do not exist at HEAD, and nothing that fails at HEAD also fails at the
merge-base. Common = 0.** `bun test packages/shared/src` on a clean clone of
`e5a0e24a9` reads **9981 pass / 20 skip / 1 todo / 30 fail**, not 82; on a clean clone of
`git merge-base master feat/TCODE-000` (`bbd48f967`) it reads **7674 pass / 8 skip /
144 fail**. The two failing sets are **disjoint at every matching granularity I tried** —
by `(file, test name)`, by test name alone, and even by *file*.

**"All pre-existing" is refuted.** So is "all new" as a useful summary: 28 of the 30 are a
load/isolation class that passes when the file is run alone, and **2 are a real,
deterministic, committed regression on this branch.**

| Answer to the row's three numbers | Count |
| :-- | --: |
| **Common** (failing at both HEAD and merge-base) | **0** |
| **New at HEAD** | **30** (of which **2 confirmed real**, 28 full-run-only) |
| **Disappeared** (failing at merge-base, not at HEAD) | **143** distinct keys / 144 `(fail)` lines |

---

## 1. What was measured, and where

| | HEAD arm | BASE arm |
| :-- | :-- | :-- |
| SHA | `e5a0e24a9b40e2ced534f7f9bd866db752efba6c` | `bbd48f9677495c0ea235fba598ba2cab627bc744` |
| What it is | tip of `feat/TCODE-000` at 19:39 local | `git merge-base master feat/TCODE-000` |
| Tree | fresh `git clone`, `--detach` checkout, **0** dirty paths | same |
| Command | `bun test packages/shared/src` | identical |
| Result | 9981 pass / 20 skip / 1 todo / **30 fail**, 10032 tests, 660 files, 1304 s | 7674 pass / 8 skip / **144 fail**, 7826 tests, 594 files, 343 s |
| Full log | `head.log` (1182 lines, complete) | `base.log` (3423 lines, complete) |
| Sorted diffable list | `failing-head.tsv` (30 rows) | `failing-base.tsv` (143 rows) |

`master` is `0a4a5d8b8`. The branch is **680 commits** ahead of the merge-base.

**HEAD moved under me repeatedly.** The tip was `fe0e1e5be` when I started, `e5a0e24a9`
when I cloned — **that is the SHA every number in this report describes** — then
`30c8d3cc5`, and `32631ac41` when I finished. **16 commits** landed on the branch during
the measurement. My numbers describe `e5a0e24a9` and nothing else; do not read them as
describing the tip.

I did check the one thing that decides whether the finding below has already been fixed
out from under me: `packages/shared/src/protocol/routing.ts` and
`packages/shared/src/protocol/channels.ts` have **no commits** between `e5a0e24a9` and the
current tip `32631ac41`. **The regression in §3a is still live at the tip.**

### Isolation, proved rather than assumed

The brief's named trap is that a worktree's symlinked `node_modules` resolves
`@nessy-agent/*` back to the parent tree. I used **clones**, not worktrees, and verified
anyway:

- `bun install --frozen-lockfile` per clone, from that clone's own `bun.lock`.
  This matters: the arms genuinely differ in dependencies — `@earendil-works/pi-*`
  **0.84.0** at HEAD vs **0.80.3** at base, `@anthropic-ai/claude-agent-sdk` 0.3.223 vs
  0.3.218, `@anthropic-ai/sdk` 0.115.0 vs 0.100.1. A shared `node_modules` would have
  measured the base tree against the wrong SDKs.
- `Bun.resolveSync('@nessy-agent/shared/agent/thinking-levels')` and
  `'@nessy-agent/core'` both resolve **inside** the clone, in both arms.
- Negative control: all **15** `@nessy-agent/*` entries realpath inside the clone;
  **0** outside, in both arms.
- Positive control for that check: the parent repo's own link realpaths to
  `/Users/…/nessy-desktop/packages/shared`, which the predicate correctly reports as
  outside — so the check *can* fail, and didn't.
- `bunfig.toml` is byte-identical in both arms (same sha1), so the `[test].preload` list —
  including `isolate-shared-config-dir.ts`, which mkdtemps a **private config dir per run** —
  is the same harness on both sides.
- Neither clone had a `release/` directory (fresh checkouts), so the packaged-tree phantom
  failures documented in the register cannot be in these numbers.

I never took the shared `bun test` mutex. Both arms and every confirmation run happened in
the clones.

### Method notes

- Both full logs were captured whole to files. **No `head`, no `tail`, no truncating pipe**
  anywhere in the collection path. The parser recovered **exactly 30 and exactly 144**
  `(fail)` lines, matching bun's own summary counts — that agreement is the check that
  nothing was lost.
- The arms ran **sequentially**, never concurrently, and no other `bun test` of mine was
  running at the same time.

---

## 2. The diff, by test identity

```
COMMON      : 0
NEW AT HEAD : 30
DISAPPEARED : 143  (144 (fail) lines; one test fails twice in the base run — see §5)
```

**I tried to break this result three ways and could not:**

| Matching rule | Overlap |
| :-- | --: |
| strict `(file, test name)` | 0 |
| test name only (deliberately loose — would over-count "common") | 0 |
| normalised name (whitespace/case collapsed) | 0 |
| **file only** (the loosest possible) | **0** |

HEAD fails in **9** files; base fails in **18**; **no file appears in both**. So the zero is
not an artefact of a too-strict key — the sets do not touch.

### Consequence for the spot-check the brief asked for

The brief asked me to spot-check a sample of the entries I classify as **common**, to
confirm they fail for the same reason rather than merely under the same name. **I classify
none as common, so that check has nothing to sample.** Rather than let that read as a check
skipped, I ran the symmetric version — re-running failing files *alone* on the arm(s) where
they matter, to test whether each set is real, and comparing the failure **reason**, not
just the name.

**How many I checked: 16 file-level re-runs covering 23 individual failing tests.**
Concretely: **9 of 9** HEAD-failing files re-run alone at HEAD (covering all 30 HEAD
failures); **3** of those also re-run alone at base; and **4** base-failing files re-run
alone on **both** arms (covering 103 of the 143 disappeared entries, 72%). Results in §3
and §4.

That reason-level check is what turns the zero from a set-arithmetic artefact into a
finding: the two arms do not merely fail under different names, they fail from different
**causes** — 138 of base's 144 lines are one deterministic assertion
(`PowerShell validator root not set`), while 28 of HEAD's 30 are timeouts and the other 2
are a channel-classification assertion that does not exist at base.

---

## 3. New at HEAD: 30, of which 2 are real

All 30 are in files that **exist at the base commit too** — so none of them is "new
because the test is new". I re-ran **all 9** HEAD-failing files alone in the HEAD clone.

| File | in full run | alone at HEAD | verdict |
| :-- | --: | --: | :-- |
| `protocol/__tests__/routing.test.ts` | 2 fail | **6 pass / 2 fail** | **REAL — see below** |
| `config/__tests__/user-settings-strict-report.test.ts` | 10 fail | 0 pass / 10 fail | environmental (also fails at base — §3b) |
| `agent/__tests__/permissions-config-migration.test.ts` | 1 fail | 0 pass / 1 fail | environmental (also fails at base — §3b) |
| `agent/__tests__/claude-live-settings.test.ts` | 8 fail | **41 pass / 0 fail** | full-run-only |
| `agent/__tests__/fork-parent-scope.test.ts` | 4 fail | **6 pass / 0 fail** | full-run-only |
| `plugins/__tests__/one-projection-entry-point.test.ts` | 2 fail | **4 pass / 0 fail** | full-run-only |
| `auth/dp/__tests__/e2e.test.ts` | 1 fail | **6 pass / 0 fail** | full-run-only |
| `config/__tests__/default-thinking-level.test.ts` | 1 fail | **9 pass / 0 fail** (took 153 s) | full-run-only |
| `sessions/cron-scheduler.test.ts` | 1 fail | **30 pass / 0 fail** | full-run-only |

28 of the 30 are `timeout`-kind; only 2 are assertions. Both assertions are the real one.

### 3a. THE FINDING — a committed regression on this branch

```
packages/shared/src/protocol/__tests__/routing.test.ts
  channel routing exhaustiveness > every channel is classified exactly once
  channel routing exhaustiveness > total classified equals total channels
```

Verbatim from the run:

> `error: Channel "workspace:importClaudePreview" is not classified in LOCAL_ONLY or REMOTE_ELIGIBLE. Add it to one set in routing.ts.`

and

> `Expected: 350` / `Received: 348`

Measured directly against the pinned HEAD tree:

```
total channels = 350 | classified = 348
UNCLASSIFIED (2): workspace:importClaudePreview, workspace:importClaudeApply
```

- **Deterministic and fast.** It fails in 0.40 ms and 0.17 ms — nowhere near the timeout
  class, and it fails identically run alone (6 pass / 2 fail) and inside the full run.
- **Differential is clean, on both the test and the data.** The same file, run alone in the
  **base** clone, is **8 pass / 0 fail**; `routing.test.ts` does not appear anywhere in the
  base failing list. Enumerating the same structure in the base tree:
  `base: total = 348, classified = 348, unclassified = 0`. The file exists in both trees.
  So the two unclassified channels are exactly the delta.
- **Introduced by** `e815ad274 feat(onboarding): import a Claude Code setup`
  (2026-08-24, `git log -S 'workspace:importClaudePreview'`). It is an **ancestor of the
  pinned HEAD and is not on `master`** — so it is this branch's work, and the merge-base
  ambiguity the register warns about does not arise here. Two channels were added to
  `packages/shared/src/protocol/channels.ts` without being classified in
  `packages/shared/src/protocol/routing.ts`.
- **Still present at the current tip.** `routing.ts` and `channels.ts` have no commits
  between `e5a0e24a9` and `32631ac41`, across the 16 commits that landed while I measured.
- **Not fixed here.** Per the brief's scope rule, a fix folded into a measurement makes the
  measurement unciteable. This is reported for its own row.

Why it matters beyond a red test: `LOCAL_ONLY` / `REMOTE_ELIGIBLE` is the classification
that decides whether an RPC channel may cross to a remote agent. Two unclassified channels
is a routing question the codebase currently has no answer for, and the test exists
precisely to force that answer.

### 3b. Two files that look new-at-HEAD and are not

`user-settings-strict-report.test.ts` (10) and `permissions-config-migration.test.ts` (1)
fail alone at HEAD — but they fail **identically alone at the base commit** (10 fail and
1 fail respectively). They drive the production loader through `Bun.spawnSync` +
`--eval` subprocesses against bun's default 5000 ms timeout; on this host, that spawn does
not finish in 5 s. They are environmental, not the branch's. They appear in the HEAD
column and not the base column only because the base *full* run was short (343 s) and less
contended than the HEAD full run (1304 s) — which is exactly why a set diff of two full
runs is not the last word, and the per-file re-runs are.

### 3c. The remaining 26

Pass cleanly alone, fail only inside the full run: the cross-file/full-run-only class the
register already documents. Note the shape — `claude-live-settings` 41/0 alone,
`fork-parent-scope` 6/0, `cron-scheduler` 30/0 — these are not marginal.
`default-thinking-level` is the tell: it **passes** alone but takes **153 s**, and blew a
120 000 ms timeout inside the full run. This family is timing, not logic.

---

## 4. Disappeared: 143, and they are real at base

The base failing set is dominated by a single cause. **138 of 144** `(fail)` lines carry the
identical message:

> `error: PowerShell validator root not set. Call setPowerShellValidatorRoot() at startup.`

across **16 files**, almost all in `packages/shared/src/agent/__tests__/` — led by
`pi-agent-guardian-consult` (58) and `pi-agent-pretool-hook-decision` (38). The remaining
**6** are 4 timeouts (3 in `codex-permission-rules`, 1 in `network-proxy-settings` at
30 000 ms) and 2 `toEqual` assertions in `permission-mode-runtime-translations`.

This is a base-era systemic failure that the branch's 680 commits removed. I did not
diagnose it further — it is not what this row asks — but I did confirm it is real rather
than an artefact of my clone, by re-running **4** of the base-failing files **alone on both
arms**:

| File | alone at BASE | alone at HEAD |
| :-- | --: | --: |
| `agent/__tests__/pi-agent-guardian-consult.test.ts` | 8 pass / **58 fail** (PowerShell) | 149 pass / 4 fail (timeouts) |
| `agent/__tests__/pi-agent-pretool-hook-decision.test.ts` | 9 pass / **38 fail** (PowerShell) | 45 pass / 2 fail (timeouts) |
| `agent/__tests__/mode-gate.test.ts` | 11 pass / **3 fail** (PowerShell) | **17 pass / 0 fail** |
| `agent/backend/__tests__/read-patterns.test.ts` | 16 pass / **4 fail** | **20 pass / 0 fail** |

Each base count matches its full-run count exactly, so the base failures reproduce in
isolation and are not a full-run artefact.

**The absence of the PowerShell cause at HEAD is measured, with a positive control on the
same rig.** `grep -a 'PowerShell validator root not set'` returns **0** in `head.log` and
**0** in every one of the 13 HEAD confirmation logs, while the identical grep returns
**170** lines in `base.log`. (`grep -a`, per the repo's NUL-byte rule.)

**A caution the same table produces, and it cuts against my own method.** The two big HEAD
runs above fail 4 and 2 alone — while failing **zero** inside the HEAD full run. That is
the opposite direction from the usual full-run-only story, and it is the shape the register
warns about (`Pi runtime cwd transaction`). All six are 5 000/30 000 ms timeouts on a
loaded host, none is an assertion, and none of them appears in either full-run failing set —
so they change no number in §2. But they do mean **a single per-file re-run on this host is
not by itself proof**, which is why the §3a finding rests on an assertion that completes in
0.40 ms and on the channel counts (350/348 vs 348/348) rather than on a timing result.

Full list: `failing-base.tsv`, 143 sorted rows, and `p2265-disappeared.txt`.

---

## 5. Where the "82" went — the number in the row does not reproduce

The row's premise is a count of **82** from P2.226's lane. At `e5a0e24a9` in a clean clone
the same command gives **30**. Both facts can be true, and the difference is not mysterious:

- P2.226's lane ran in the **shared working tree** at roughly 17:43, with five lanes'
  **uncommitted** edits in it, on a machine at load ~20–24. My arms are **clean checkouts**
  with zero dirty paths, and the HEAD arm ran at load ~10–16.
- The dominant class in my HEAD run (28 of 30) is timeouts that vanish when the file runs
  alone. That class scales with contention. A tree under five concurrent lanes plus a
  25-minute mutex queue would plausibly show several times as many.

So **82 was very likely mostly this same load-sensitive class, inflated by the shared
tree's contention and its uncommitted state.** I want to be explicit that this sentence is
**inferred, not measured** — I did not reconstruct that lane's exact tree, and I cannot,
because its uncommitted state no longer exists. What *is* measured is that the count is not
a stable property of the commit: the same command on the same commit gives 30 in a clean
clone.

Everything else in this report is measured, not inferred, except where §6 says otherwise.

One bookkeeping detail: the base run has **144 `(fail)` lines but 143 distinct keys** —
`permission-mode-runtime-translations.test.ts :: R5 — REFUTED: our answer does not
distinguish the four either > Bash: the four modes get the identical answer` is charged
twice in one run. I report 143 as the diff number and 144 as the line count rather than
silently picking one.

---

## 6. Concerns, and what this measurement does not establish

1. **`master` was not measured.** The register's own standing correction says the
   merge-base check "cannot see an accumulation" and that only `master` decides whether a
   branch owns a failure. The brief scoped me to the merge-base deliberately, and for the
   question *what did this branch's work add* the merge-base is right — but the 143
   disappeared failures are not evidence about `master`, and this row does not discharge
   that owed comparison.
2. **The timeout class is host-dependent, and my two arms did not run under identical
   load.** The HEAD arm took 1304 s under load ~10–16; the base arm took 343 s under
   load ~9–10. That asymmetry is enough on its own to explain the timeout column, and it is
   why I re-ran every HEAD-failing file alone rather than trusting the set diff. It also
   means the *counts* 30 and 144 are not reproducible constants — the *identities* are the
   durable part, which is why `failing-head.tsv` / `failing-base.tsv` are the deliverable.
3. **A clone is evidence, not proof.** The register documents a case that runs the other
   way — `Pi runtime cwd transaction` failing deterministically in a clean worktree and
   passing in the real repository. I have not run anything in the shared tree, by
   instruction, so I cannot exclude that some of the 28 behave differently there. The
   finding in §3a is the one I would defend hardest against this, because it is an
   assertion on a pure data structure, evaluated in under a millisecond, with no I/O,
   no subprocess and no timing in it — and I confirmed its differential (fails at HEAD,
   passes at base, same file, both alone).
4. **Dependency drift is real between the arms** (pi 0.84.0 vs 0.80.3, two Anthropic SDK
   bumps). Each arm was installed from its own lockfile, which is correct — the base tree
   *is* the base tree's dependencies — but it means "disappeared" bundles code changes and
   dependency upgrades together. For the §3a finding this is irrelevant; for the 143 it is
   not, and I have not separated them.
5. **Row-description correction.** The row asks whether the 82 are "the known full-run-only
   cross-file failure class on this branch". For the 28, that reading is **confirmed**. For
   the count 82 itself it is **not reproducible at HEAD**, and for 2 of the 30 it is
   **wrong** — those are a real defect. The register would not have caught them: no row
   there names `routing.test.ts`.
6. **Method churn, disclosed.** I first built this measurement in two `git worktree`s
   (each with its own install, resolution proved inside). The coordinator withdrew the
   worktree method mid-run, then withdrew second trees entirely, then restored the original
   brief. I killed the in-flight worktree run, removed both worktrees, ran
   `git worktree prune`, and rebuilt from scratch as clones. **No number in this report
   comes from the worktree attempt**; its partial log is retained on disk as
   `DISCARDED-worktree-run-head.log` and was not used. `git worktree list` now shows only
   the shared tree and the two pre-existing lanes' trees (`nessy-fixwave`, `nessy-gate`),
   neither of which is mine.
7. **Nothing was committed and no source was changed.** This is a measurement row; the
   regression in §3a is reported, not fixed.

---

## 7. Artefacts

All under `…/scratchpad/sdd2/`:

| File | What |
| :-- | :-- |
| `head.log` / `base.log` | complete, untruncated `bun test packages/shared/src` output for each arm |
| `failing-head.tsv` / `failing-base.tsv` | sorted `file <TAB> test <TAB> kind`, ready to diff at the verification wave without re-running |
| `head.json` / `base.json` | parsed failing sets with per-failure reason and kind |
| `p2265-common.txt` (empty), `p2265-new-at-head.txt`, `p2265-disappeared.txt`, `p2265-diff.json` | the diff itself |
| `confirm/*.log` | every per-file re-run, complete |
| `run-provenance.txt`, `loadsample.txt` | SHAs and machine load through the runs |
| `parse-failures.py`, `diff-failures.py` | the parser and differ (parser's line count is cross-checked against bun's own summary) |

Both clones (`cl-head`, `cl-base`) are removed. `git worktree list` on the shared repo now
shows only the shared tree and the two pre-existing lane trees (`nessy-fixwave`,
`nessy-gate`) — neither is mine, and `git worktree prune` reports nothing left to prune.
The shared working tree was never written to and never had its `bun test` mutex taken.

---

## 8. What the plan should do with this

1. **Do not close on "all pre-existing".** It is measured false: zero of HEAD's failures
   exist at the merge-base.
2. **Open a fix row for the two unclassified channels** (`workspace:importClaudePreview`,
   `workspace:importClaudeApply` → `LOCAL_ONLY_CHANNELS` or `REMOTE_ELIGIBLE_CHANNELS` in
   `packages/shared/src/protocol/routing.ts`). It needs a routing decision, not just a set
   insertion, so it wants its own review. Deliberately not fixed here.
3. **Retire the number 82** as a description of HEAD. Cite `failing-head.tsv` at
   `e5a0e24a9` instead — 30 entries, by name, diffable without a re-run.
4. **The owed `master` comparison is still owed** (§6.1); this row does not discharge it.
