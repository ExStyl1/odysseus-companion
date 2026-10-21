# X3 — P2.339, P2.340: two generators the close-out reads

**Status:** both rows done and committed.
**Commit:** `40b3c84a3` on `feat/TCODE-000`.
**Absolute base SHA recorded before starting:** `09b77d44903d0695afb278515ea9d51260f91e5b`
(never `HEAD~1` — five lanes committed 6 times during this lane's run).

Files changed, all inside the zone:

- `scripts/regenerate-deviation-register.py`
- `scripts/build-parity-report.py`
- `scripts/generator-guards.test.ts` (new)
- `docs/superpowers/specs/2026-07-30-parity-report.md` (regenerated)

`docs/superpowers/specs/2026-07-29-deviation-register.md` is **unchanged** — the
harvester still produces it byte-identically. That was verified, not assumed.

---

## 1. Both premises confirmed by measurement, before any edit

### P2.339 — reproduced exactly

Restored the pre-fix coverage-map cell from `32b2b30f6^` into an isolated rig
(a copy of `docs/` + `scripts/`, so no lane's file was touched):

| corpus | TOTAL | categories |
| --- | --- | --- |
| current tree (cell fixed at `32b2b30f6`) | 363 | `not implemented` 326, `impossible` 17, `inapplicable` 20 |
| pre-fix cell restored | **364** | … `inapplicable` **21** |

The manufactured row, verbatim from the harvest:

```
### `specs/2026-07-31-claude-coverage-map.md`
- **inapplicable** — analytics.md:12 … there is nothing to implement and nothing to stub» (
```

The trailing `» (` is the quotation's own closing guillemet being harvested as
part of a "reason". Positive control: the rig reproduced the committed register
byte-identically before the defect was planted.

### P2.340 — confirmed and **sharpened**

The row (already self-corrected by the controller) said moving *one* untracked
plan aside took `--check` from 6 differing lines to 3. Measured here by moving
**both** of the branch's untracked inputs aside:

| working tree | `--check` verdict |
| --- | --- |
| as found (2 untracked plan/spec files) | STALE, **8** lines differ |
| both moved aside | STALE, **2** lines differ |

So **6 of 8 differing lines were the working tree**, not the repository — three
quarters, not "roughly half". The 2 real lines were a genuine drift
(`runtime-capability-gaps.md` 7 → 9 citations). Both untracked files were
restored immediately and verified byte-identical by md5.

---

## 2. The row's recommended fix for P2.339 is REFUTED — the measurement wins

P2.339 asks to "require a record's context rather than its shape (a fenced quote,
an indented block, or a marker the generator owns)". **Measured over the whole
corpus, a positive-context requirement drops real rows**, which is the failure
this generator has already suffered five separate ways.

Syntactic context of all 370 harvested candidates:

| context | count | genuine? |
| --- | --- | --- |
| bullet (immediate or later) | 215 | yes |
| **prose-embedded** | **89** | **yes** — `docs/architecture/*` house style |
| table cell | 54 | yes |
| line-start | 12 | yes |

And a specific killer for the blockquote variant: `plans/2026-08-20-cross-runtime-history-carry.md:588`
carries a **genuine record behind a `>` prefix**.

The second obvious rule — reject anything wrapped in quotes — is worse: **241 of
370 candidates are delimiter-wrapped**, overwhelmingly in backticks and
overwhelmingly genuine. One measured false positive settles it on its own: the
same `cross-runtime-history-carry.md` presents its own deviation inside quotes,
labelled as a literal "category string".

**Conclusion: the shape cannot decide.** A record and a citation of a record are
syntactically identical; only the surrounding sentence differs. The fix therefore
does not add a classifier that silently guesses. It adds the control that would
have caught the defect, and a warning that is explicitly allowed to be wrong.

---

## 3. What was actually built

### `regenerate-deviation-register.py`

1. **`--check`** — the control that was missing, and the reason the defect
   survived. Regenerates in memory, diffs the committed register, exits non-zero
   and **names the file that grew a deviation**. A coverage map growing one is
   recognisable on sight; nothing else about the number is. Mirrors the existing
   `build-parity-report.py --check` precedent.
2. **A citation warning on stderr, every run.** A candidate that is
   delimiter-wrapped AND names another of *our dated* plan/spec files (or a
   register line pointer) as the record's owner is printed with its file, the
   owner it names, and its reason. *Ours are dated; Claude's pages are not* —
   a record citing `sub-agents.md:1046` is normal, one citing
   `2026-07-29-session-scheduling.md:163` is naming the file that already owns it.
   Backward window 200 chars **and forward 150**, because the attribution that
   actually shipped came *after* the quote: `«…verdict…» (`plans/….md:190`)`.
   Measured 8 flags, **7 true citations**.
3. **Flagged candidates are still counted.** The warning never filters. An
   inflated count is recoverable; a silently dropped record is the failure mode
   this generator has already suffered five times, and it is the worse direction.

Default-path output is **byte-identical** to the committed register (verified
after every edit).

### `build-parity-report.py`

1. **Inputs come from git's index, not the filesystem.** A file git does not know
   about is not an input; `git add` makes it one, which is the right semantic.
2. **Every exclusion is named on stderr, every run.** Silence about an absorbed
   file is how this reached the committed report.
3. **`--include-untracked`** restores the old behaviour for a deliberate local
   preview and says so just as loudly.
4. **`_INPUTS_TRUSTED`** — when git cannot be asked (no repo, git missing), the
   run warns AND the STALE verdict stops claiming an exclusion it did not make.
   *This was a bug I introduced and caught in my own re-break: the first version
   printed "untracked … were excluded" under `--include-untracked`.*
5. The obsolete prose was corrected in both the artefact's provenance paragraph
   and the STALE message — "regenerate from a clean tree" was advice nobody on a
   working branch can follow.

The report was regenerated from tracked-only inputs. `--check` is now **green on
this contaminated working tree**, which was previously impossible.

---

## 4. Both fixes proven by re-breaking, twice each

### P2.339, against `32b2b30f6^` in an isolated rig

| rig state | `--check` exit | citation flags | says |
| --- | --- | --- | --- |
| cell fixed (`32b2b30f6`) | **0** | 8 | `up to date (363 records)` |
| pre-fix cell restored | **1** | 9 | `+TOTAL 364`, `+### specs/2026-07-31-claude-coverage-map.md` |

Worth recording honestly: **before the forward window was added, the citation
warning did NOT catch the historical defect** (7 flags in both states) — only
`--check` did. That is exactly why `--check` is the primary control and the
heuristic is a supplement.

### P2.340, A/B on one tree (git-backed rig, HEAD extracted, planted untracked plan)

| run | exit | drift lines | says |
| --- | --- | --- | --- |
| guarded | **0** | unchanged from baseline | `1 untracked input(s) EXCLUDED — …planted-untracked-plan.md` |
| `--include-untracked` (= the old code path) | 1 | **9**, all manufactured | `CAUTION: untracked … ARE counted` |
| git unavailable | 1 | — | `WARNING — git ls-files exited 128 …` + hedged verdict |

### And the tests themselves were proven load-bearing

Each guard reverted once, in the tree, then restored (0 `RE-BREAK` markers left):

- `tracked()` made a pass-through → P2.340 test fails, `Expected: 7 Received: 35`.
- citation warning made a no-op → **both** P2.339 tests fail on
  `Expected to contain: "look like a CITATION"`. The `--check` half still fired
  independently in that run (`STALE — 8 line(s) differ`, survey file named), which
  is the defence-in-depth working.

---

## 5. Gates — with proof of work, not exit statuses

| gate | result | evidence quoted |
| --- | --- | --- |
| `bun test scripts/generator-guards.test.ts` (via mutex) | **PASS** | `3 pass, 0 fail, 28 expect() calls. Ran 3 tests across 1 file.` |
| `bun scripts/check-generator-faithfulness.ts` (post-commit) | **PASS** | `8/8 artifacts byte-identical to what 5 generators produce from HEAD` (exit 0, reproduced twice) |
| `bun test scripts/check-generator-faithfulness.test.ts` | **FAIL — load artefact, see §6** | `1 fail … timed out after 120000ms` on a 193 s run |
| eslint, `scripts/`, `--format json` | **PASS** | `errors: 0 warnings: 0` (errorCount read from JSON, not from exit status) |
| `bun run typecheck:scripts` | **PASS** | exit 0, `grep -c "error TS"` = 0; `--listFiles` confirms `generator-guards.test.ts` is in the program |
| `git diff --check` (my 4 paths) | **PASS** | exit 0 |
| commit isolation | **PASS** | `git show --stat` = exactly my 4 files |

Gates deliberately **NOT RUN**: full `bun test`, `bun run lint` (all packages),
`typecheck:all`, any build or packaging. Per the implementation-first budget this
change touches two Python scripts, one new test file and one generated markdown
artefact — no shared wire, schema, auth, lifecycle, migration or lock input. The
affected-package typecheck and the package-dir eslint were run instead.

---

## 6. Findings — each tagged, with its kind

### F1 `[doc:none]` **bug** — P2.339 confirmed as written
Reproduced byte-exactly (364/21 vs 363/20). Fixed as described. Row can close.

### F2 `[doc:none]` **bug — premise correction, and it is the important one**
P2.339's recommended remedy would have **dropped ~89 genuine records**. Measured
distribution in §2. Recorded in the script itself, in a block comment naming both
rejected approaches and their measured cost, so nobody re-tries them.

### F3 `[doc:none]` **bug — NEW, not previously known, and it is still open**
**The register's own 363 is itself inflated.** Fixing the one coverage-map cell at
`32b2b30f6` did not exhaust the defect: the shipped warning raises 8 flags and
**7 are true citations**, all adjudicated by reading their context. All 7 come from
two *survey* specs that exist to cite other files' records:

| source spec | count | attributed owner (example) | in the committed register at |
| --- | --- | --- | --- |
| `specs/2026-08-02-claude-doc-sweep-divergences.md` | 6 | `register category at :289`; `2026-07-29-deviation-unit-5.md`; `2026-07-29-subagent-frontmatter.md` (×2); `2026-07-29-session-scheduling.md`; `docs/architecture/managed-mcp-access.md:95` | lines 558, 559, 560, 563 … |
| `specs/2026-08-02-claude-doc-sweep-worklist.md` | 1 | `2026-07-29-session-scheduling.md:152-210` | line 571 |

Line 558 still carries the tell in the register itself — a stray `"` mid-reason:
`- **not implemented** — Nessy has no --init/--maintenance launch mode". Shipped code carries…`

**Deliberately NOT suppressed by this lane.** Cutting the headline number by 7 on
my own reading risks the one failure worse than the inflation — a dropped real
record — and the two survey specs are not this script's content to adjudicate.
They are now named on **every run**, which is the acceptance bar. **This needs an
owner decision:** adjudicate and suppress (register goes 363 → ~356), or accept
the inflation as documented. The eighth flag,
`plans/2026-07-29-fork-surface.md`, is a **false positive** — a genuine record one
paragraph below a mention of a sibling plan — and is the reason the heuristic is
wired as a warning and not a filter.

### F4 `[doc:none]` **bug** — P2.340 confirmed and sharpened
8 → 2 lines, so 6/8 of the reported drift was the working tree (§1). Fixed. The
row's own correction understated it slightly (it measured one file, not both).

### F5 `[doc:none]` **bug — pre-existing, OUT OF ZONE, not introduced here**
`scripts/check-generator-faithfulness.test.ts` case *"reproduces every committed
artifact byte-for-byte from HEAD"* has a **120 s budget for work that is I/O-bound
and unbounded under load**. Measured on this machine (load average **21.5**, five
lanes): the gate does `git archive` + `tar` of 23 MB **five times**, and one
extraction alone timed at **2.7 s, 23.0 s, 4.0 s** on three consecutive runs —
5 × 23 s is 115 s before any Python runs. Observed 193 s alone and 252 s alongside
another file.

**Not caused by my change**, measured directly: the new `git ls-files` call costs
`build-parity-report.py` ~0.5–1 s (new 3.07/21.72/2.71 s vs base 2.13/1.97/2.51 s,
the 21.7 s being the same contention), against a 120 s budget. **The gate itself is
green** — `bun scripts/check-generator-faithfulness.ts` exits 0 with 8/8, twice.
Not in the known-failing register (checked). Suggested fix (not mine to make):
raise the budget, or extract HEAD once and share it across the five generators.

### F6 `[doc:none]` **never-looked-at** — a scratchpad path is now a published citation
`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md:1459` cites
`scratchpad/sdd2/x6-report.md` as a row's evidence. That path is a **temporary
agent scratchpad that no reader will ever have**, and because the parity report
harvests cited `.md` names from every plan, it has propagated into the generated
artefact: `docs/superpowers/specs/2026-07-30-parity-report.md:505` now lists
`` `sdd2/x6-report.md` | 1 `` in §3b, "Cited as documentation, but not a Claude
Code page". Out of my zone twice over (the tracker is controller-pinned), so
reported only. Worth a sweep: other lanes may have cited scratchpad paths too.

---

## 7. Documentation classification

**`[doc:none]` — our own tooling, stated explicitly as the brief requires.** No
Claude, Codex or Pi page governs either generator; they are internal scripts that
reshape this repo's own trackers. No page was consulted and none should have been.

## 8. Concerns / handover

1. **F3 needs an owner decision** — the register's 363 is inflated by ~7. Visible
   now, but still counted.
2. **The parity report re-stales on any plan commit.** It was regenerated at
   `f27ad5536` and committed at `40b3c84a3`; six lane commits landed during this
   lane alone. `--check` is now trustworthy mid-flight, which is the fix — but the
   artefact will need regenerating again at close-out, from a tree where the
   tracker has stopped moving.
3. **F5 will keep flaking** under five concurrent lanes and is not mine to fix.
4. Rigs and temporary copies were deleted; no worktrees were created (the two
   others in `git worktree list` belong to other lanes). The branch's two
   untracked plan/spec files were moved aside once during measurement and
   restored, md5-verified.
