# P2.274 — re-sweep of site counts and absence claims on `2026-08-22-runtime-parity-closure.md`

**Surveyed at SHA `ef91e6762f22200499858ca9498a22026a322d20`** (branch `feat/TCODE-000`, working tree
dirty with five other lanes' in-flight edits). Tracker snapshot taken at that SHA and kept at
`<scratchpad>/sdd2/p2274/tracker-snapshot.md` (md5 `459d0ed15aa2df15952594ed62c20c07`); every row
quotation below is from that snapshot, not from a later re-read.

**Read-only on source.** Nothing was fixed, nothing was committed, the plan file was not touched.

---

## 1. Gate: the positive control, verbatim

The brief requires one positive control demonstrating that my search command finds a known hit inside
a NUL-carrying file. Run in the repo root at the surveyed SHA:

```
$ /usr/bin/python3 -c "
b=open('packages/shared/src/agent/permissions-config.ts','rb').read()
i=b.find(b'\0')
print('NUL byte at offset',i,'of',len(b)); print('line no:',b[:i].count(b'\n')+1)"
NUL byte at offset 44920 of 88504
line no: 1059

$ grep -rn "codex-execpolicy-" packages/shared/src/agent/permissions-config.ts; echo "wrapped exit=$?"
wrapped exit=1

$ /usr/bin/grep -an "codex-execpolicy-" packages/shared/src/agent/permissions-config.ts; echo "exit=$?"
1059:  const id = `codex-execpolicy-${createHash('sha256').update(clean.join(' ')).digest('hex').slice(0, 16)}`;
exit=0
```

The wrapped `grep` reports **zero hits, exit 1** on a line that demonstrably exists. `/usr/bin/grep -a`
finds it. `type grep` → `grep is a shell function from …/shell-snapshots/…`; `/usr/bin/grep --version`
→ `grep (BSD grep, GNU compatible) 2.6.0-FreeBSD`.

### 1a. The NUL file list, reproduced independently by byte scan

Not quoted from `AGENTS.md` or from the traps spec — measured by reading bytes over 3 775 source
files under `packages/*/src`, `apps/*/src` and `scripts`:

```
2 packages/server-core/src/bootstrap/storage-runtime.ts
2 packages/server-core/src/handlers/rpc/capabilities.ts
1 packages/server-core/src/projects/project-capability-watcher.ts
1 packages/server-core/src/sessions/__tests__/workspace-project-contract-corpus.test.ts
1 packages/shared/src/agent/base-agent.ts
1 packages/shared/src/agent/core/guardian-consult.ts
1 packages/shared/src/agent/memory/rule-matching.ts
1 packages/shared/src/agent/permissions-config.ts
1 packages/shared/src/marketplace/registry-source.ts
2 packages/shared/src/marketplace/service.ts
2 packages/shared/src/sessions/mirror/host.ts
7 packages/shared/src/sessions/mirror/in-memory.ts
2 packages/shared/src/telemetry/usage-metrics.ts
4 scripts/ios-wire-enum-parity.ts
TOTAL 14 of 3775 files scanned
```

Fourteen, matching the traps spec exactly. (My first attempt — `git ls-files -z` piped into Python over
the whole tree — timed out twice on this disk; the scoped walk above completes in ~50 s. Recording it
because a timed-out probe that prints nothing is the same failure shape this row exists to catch.)

### 1b. A tool the plan never named, and it is safe: `git grep`

```
$ /usr/bin/git grep -c "codex-execpolicy-" HEAD -- packages/shared/src/agent/permissions-config.ts
HEAD:packages/shared/src/agent/permissions-config.ts:1
$ /usr/bin/git grep -ac "codex-execpolicy-" HEAD -- packages/shared/src/agent/permissions-config.ts
HEAD:packages/shared/src/agent/permissions-config.ts:1
```

**`git grep` sees inside all fourteen files with or without `-a`** — git's binary heuristic reads only
the first 8 000 bytes, and every one of these NULs sits deeper. Cross-checked at scale: repo-wide
`settings\.md:[0-9]+` at `a8782cff5^` returns **899 with `git grep` and 899 with `git grep -a`**, while
the wrapped `grep` over the same directories at HEAD returns **810 against `/usr/bin/grep -aro`'s 835**.

This matters for the plan's future: `git grep` is a correct instrument here, it works on any ref, and no
lane was told so.

---

## 2. Exposure bound — how big this problem actually is

I built a byte-honest index of 3 075 source files and cross-referenced **every backticked identifier in
every row note** (1 243 distinct) against the fourteen NUL files.

| Measure | Value |
| :-- | --: |
| Rows in the tracker (parsed from the snapshot) | **345** (243 ✅ · 97 ⬜ · 5 ⏸) |
| Rows whose note carries a site count or an absence claim | **208** (168 ✅ · 40 ⬜) |
| Rows I re-measured in depth | **25** |
| Row-named identifiers with ≥1 occurrence inside a NUL file | **366 of 1 243** |
| Row-named identifiers existing **only** inside NUL files | **8** |
| Row-named identifiers ≥30 % hidden from the wrapper | **32** |

**The eight a wrapped-grep sweep sees zero of** — for these, a wrapper-based absence claim is not weak
evidence, it is no evidence:

| Identifier | Occurrences (all in NUL files) | Rows that name it |
| :-- | --: | :-- |
| `applySourceConfig` | 4 | P2.48, P2.52 |
| `runJudge` | 6 | P2.20 |
| `sessionCostUsdHydrated` | 4 | P2.44 |
| `reconstructTrustKey` | 3 | P2.158 |
| `isFailedTurnComplete` | 2 | P2.195 |
| `getEventCostUsd` | 2 | P2.36 |
| `isNativeProjectTrustEntry` | 2 | P2.158 |
| `Codable` | 1 | P3.31 |

Concrete scale check on one pattern the plan cares about: repo-wide `settings.md:<line>` anchors —
wrapper **810**, byte-honest **835**. The wrapper hides exactly **25**, all in three NUL files
(`storage-runtime.ts` 13, `registry-source.ts` 9, `permissions-config.ts` 3), and ten of the twenty-five
point past line 804 of the current page, i.e. are definitively dead.

**Also worth knowing: four of the fourteen NUL files were never touched by any commit in the plan
window** (`git log --since=2026-08-22`): `project-capability-watcher.ts`, `rule-matching.ts`,
`mirror/in-memory.ts`, `telemetry/usage-metrics.ts`. Three of them appear in the tracker only as list
entries in P2.73's NUL enumeration — never audited. One of them turned out to hold a live survivor of a
class this plan swept (finding C-3).

---

## 3. Corrections table

Verdicts: **confirmed** / **undercount (N→M)** / **overcount** / **stale** / **unverifiable**.
"stale" is added for a claim that was true when written and is false at HEAD because a later row moved
the code — not a survey defect, but a wrong sentence in a plan heading for close-out.

| # | Row | Claim as written | Measured | Evidence | Verdict |
| :-- | :-- | :-- | :-- | :-- | :-- |
| C-1 | **P2.48** ✅ `7df6f5788` | "**Nine of ten** source fields merge **unscoped** (only `allowedMcpPatterns` is scoped)" | **Eleven fields, ten unscoped, one scoped** | `applySourceConfig` body parsed at `permissions-config.ts:1845-1922`; fields = `allowedApiEndpoints, allowedBashPatterns, allowedMcpPatterns, allowedTools, allowedWritePaths, blockedCommandHints, blockedTools, deniedPaths, deniedToolPatterns, disallowedTools, toolRules`; only `allowedMcpPatterns` reaches `sourceSlug` (`:1879`). Identical at `7df6f5788^`, at `7df6f5788`, and at HEAD. | **undercount (9→10 unscoped, 10→11 total)** |
| C-2 | **P2.124** ✅ `e0a64da64` | "**Eleven sites** hold per-runtime capability truth"; fix = the property "a per-runtime site must be **TOTAL** … adding a runtime must **break the build**" | Property holds at 5 of the 7 named sites I could resolve; **2 named sites were never touched and are still not total** | `git show --stat e0a64da64` and `23e3afbcf` (P2.205) — neither touches `packages/shared/src/agent/runtime-agent-support.ts` or `packages/shared/src/sessions/runtime-anchors.ts`; `git log --since=2026-08-22` on both → **0 commits**. At HEAD: `runtime-agent-support.ts:63-67` is a hand-maintained `ReadonlySet<AgentProvider>` of three, no `Record<AgentProvider>`, no vocabulary import; `runtime-anchors.ts:38` is `readonly AgentProvider[] = ['pi','anthropic']` with `Partial<Record<AgentProvider,string>>`. | **partial closure — row closed on a subset of the sites it named** |
| C-3 | **P2.73 / P2.192** ✅ `53849b319`, `9a95ae0ff` | The floating-emission class: "five … a sixth … **a SEVENTH** … so the sweep that started at five is now at seven" | An **eighth survivor** exists, in a NUL file no plan commit touched | `packages/server-core/src/projects/project-capability-watcher.ts:135` — `void this.emit(entry);`. `emit()` (`:139-149`) catches around its `await` but then calls `this.options.onInvalidate(...)` **outside any try**; that callback is host-supplied (`SessionManager.ts:5581`, `storage-runtime.ts:369`). A throw there rejects a promise nothing holds — the exact hazard P2.192's own docblock names for `flushPendingHookSessionDirectives`. Discriminator: `grep -c "void this\." <file>` → **exit 1, no output**; `/usr/bin/grep -ac` → **1**. `git log --since=2026-08-22` on the file → **0**. | **undercount (7→8), and invisible to the sweep instrument** |
| C-4 | **T3** ✅ `904355447` | "`grep` finds **exactly one consumer** of `config.hookTaskRegistryPort`, `pi-agent.ts:8264`" — and the row calls it "**INERT today**" | **Three** production consumers at HEAD | `claude-agent.ts:3344`, `codex-agent.ts:3562`, `pi-agent.ts:9643`. Widened by T9 (`07646b54c`), whose own note records "the two consumer SHAPES". True when written. | **stale** |
| C-5 | **P2.35** ✅ `78193dc53` | "Seam proven single (`total_cost_usd` read at **exactly one place**)" | **Two** production reads at HEAD | `backend/claude/event-adapter.ts:837` (`takeReportedCostDelta(msg.total_cost_usd)`) and `:880` (`claudeCostReporting(msg.total_cost_usd)`). The second was added by P2.36 (`1bf1e52ad`), whose note explains it at `:873`. True when written. | **stale** |
| C-6 | **P2.226 / P2.82** ✅ `9e367aecc` | "**ten other sites** call [`neutralizeHarnessMarkers`] with no fence anywhere near them (advisor context and question, side question, transfer banner, guardian org-policy and judge reason, the prompt-builder's server/plugin/label names, task-notification)" | **Eleven** production call sites | `task-notification.ts:111`, `advisor.ts:287`, `:288`, `base-agent.ts:454` [NUL], `conversation-summary.ts:353`, `guardian-judge-core.ts:137`, `prompt-builder.ts:402`, `:407`, `:440`, **`:553`**, `guardian.ts:459`. The enumeration says "server/plugin/label names" (three kinds) but `serverName` is neutralised at **two** sites. **Not load-bearing** — the fix went into the shared callee, so no site was missed. | **undercount (10→11), immaterial** |
| C-7 | **P2.211** ✅ `ec7e24a51` / **T1** ✅ `985b5916c` | P2.211: dead claim at "`capabilities.ts:167-172`". T1: "`handlers/rpc/capabilities.ts:173`, which calls the predicate directly" | Both anchors drifted | The corrective comment is at `capabilities.ts:165`; the direct `cronToolsAbsentFor(...)` call is at `:188`. Substance confirmed: T1's three `/loop` surfaces measured as `SessionManager.ts:5704`, `:21232` (via `withoutLoopSkillWhereCronToolsAreAbsent`) plus `capabilities.ts:188`. | **confirmed, cited lines drifted** |
| C-8 | **P2.170** ✅ `a8782cff5` | "our **828** `settings.md:<line>` anchors are dead at the PAGE level" | **827** at the row's own parent — the row's number is byte-honest | `git grep -a -E "settings\.md:[0-9]+" a8782cff5^` → 899 total, 72 `server-managed-settings.md` → **827**. Off by one, inside any plausible counting rule. **Residual, stated because the plan is closing:** HEAD is **772** — the row re-hung 55 (its "56 anchors in `managed-policy.ts`"), and ~60–78 of the remainder point past line 804 of the current page, so they are dead rather than drifted. The class is dispositioned (P2.67 date-stamping, P2.172's anchor guard, P2.183, P2.191 open) but the 772 are not rowed as a count. | **confirmed (+ unrowed residual)** |

### Rows re-measured with **no** correction

| Row | Claim | Measured |
| :-- | :-- | :-- |
| P2.195 ✅ | "one reader repo-wide (`base-agent.ts:874`)" for `reportsCostUsd` | Exactly one call site, still at `:874`; plus declaration `:806` and two overrides. **Confirmed, line has not drifted.** |
| P2.225 ✅ | `wrapUntrusted\|hook_context\|neutralizeHarnessMarkers` control counts: nestor-cloud **7**, codex **5**, claude **0**; `fenceHookContext` applied at **three** sites, one the producer | `/usr/bin/grep -ac` → nestor-cloud 7, codex 5, claude 0 — reproduced exactly. `fenceHookContext` at `pi-agent.ts:8811`, `:8952`, `:9558` + declaration `:622`. **Confirmed.** |
| P2.60 ✅ | Chartered dead anchors re-swept: "**zero survivors** in tracked non-generated source" (`:156 :210 :433 :435-:441 :440 :443`) | Zero live citations. Every surviving `:156` token is a corrective comment ("the `:156` cited here before is a VS Code UI-label table row"). One apparent hit, `management-service-v2.ts:707`, is `plugin-dependencies.md`, a different page. Positive control: `permission-modes.md:240` (the true home) → **16** hits. **Confirmed.** |
| P2.78 ✅ | `buildCacheKey` has "one caller" | One call site (`permissions-config.ts:1420`) + declaration `:1977`. **Confirmed.** |
| P2.52 ✅ | "both private methods have exactly one caller each" | `buildCacheKey` → `:1420`; `buildMergedConfig` → `:1430`. **Confirmed.** |
| P2.37 ✅ | Premise: `terminalReason`/`terminalIsError` had "NO consumer anywhere in the UI"; `chat.terminalReason.*` had "ZERO callsites" | At `bd1900e72^`, `git grep -a` over `apps` + `packages/ui` → **1 hit, and it is a test** (`apps/cli/src/run.test.ts:695`). **Premise confirmed**; HEAD now has 49 hits across 7 files, which is the fix. |
| P2.148 ✅ / P2.155 ✅ | `compatibility.adapter.warnings` had "ZERO readers"; P2.155 then supplied one | At `53007d740^`: six hits, all tests + two docblocks, **no production reader**. At HEAD: `plugin-install-state.ts:31` and `management-service-v2.ts:1186`. **Both confirmed.** |
| P2.1 ✅ | "`setAdvisorModelId` has no caller until P4.5's UI — it is the key's only writer" | Two hits total (`config/storage.ts`, `config/validators.ts`), no caller. **Confirmed.** |
| P2.28 ✅ / P2.195-I3 | "`estimatedUsageUsdMicros` has no consumer" / "0 callers here" | Two hits repo-wide, **both comments** (`codex-agent.ts:1813`, `codex-responses-adapter/config-writer.ts:898`). **Confirmed.** |
| P2.76 ✅ | "nine case-body catches" + a tenth belt catch in `pi-agent.ts` render the thrown value unsafely | `describeThrown` adopted 54× in `pi-agent.ts`. **Confirmed within the row's stated scope.** Context worth recording, not a correction: the raw shape `instanceof Error ? …message : String(…)` survives at **489 sites in 195 files** repo-wide, **12 of them in 6 NUL files** (`base-agent.ts` 5, `storage-runtime.ts` 2, `ios-wire-enum-parity.ts` 2, `capabilities.ts`, `guardian-consult.ts`, `registry-source.ts`). The row never claimed repo-wide closure. |
| P2.81 / P2.186 / P2.189 / P2.224 | The vacuous-assertion class | `toBe(true)` repo-wide: wrapper **3 729**, byte-honest **3 729** — identical, so **no NUL file carries the pattern**; the NUL test file `workspace-project-contract-corpus.test.ts` has **0**. **This class has zero NUL exposure.** |
| P2.20 ✅ | Null-verdict hang at `guardian-consult.ts:270` | `runJudge`/`applyVerdict`/`fromCache` exist **only** inside NUL files — but the row cites line numbers, i.e. the lane **read** the file rather than grepping it. **Confirmed; the method was sound.** |
| — (negative result) | `telemetry/usage-metrics.ts:194` — `void this.flush()`, same shape as C-3, in an untouched NUL file | `flush()` (`:171`) chains `.catch(() => undefined)`, so it **cannot reject**. **Not a defect.** Recorded so the next lane does not re-open it. |

---

## 4. What I would put in front of the owner

1. **C-1 (P2.48) is the one that matters most.** It is a closed row, in `permissions-config.ts`, whose
   acceptance decision ("accepted with deny deliberately unscoped") rests on a field inventory that is
   one field short — and four of the eleven fields are unambiguously allow-direction and unscoped
   (`allowedApiEndpoints`, `allowedBashPatterns`, `allowedTools`, `allowedWritePaths`), with a fifth,
   `toolRules`, carrying both directions. That is exactly the direction the row itself flagged as
   **unverified** ("allow fields also merge unscoped, and the lane could not make one widen at the
   gate"). The count was already eleven at the row's parent commit, so this is a genuine undercount,
   not drift.

2. **C-2 (P2.124) is the "closed on a subset" shape the brief was hunting.** The row's headline is
   eleven sites and its fix is a build-breaking totality property; two of the sites it named by path and
   line have never been touched by any commit in the plan window and do not have the property. Neither
   file carries a NUL, so this was a scope failure rather than a tooling one — which is worth saying,
   because it means the exposure is not only the grep.

3. **C-3 is a live instance of a swept class hiding behind the exact defect this row exists for.**

4. **The instrument fix is one line:** `git grep` is byte-honest here on any ref. If the close-out sweep
   uses it instead of the wrapped `grep`, the whole class disappears.

---

## 5. Where I stopped, and what remains

**Triaged 345 / flagged 208 / re-measured 25.**

Deliberately **not** re-measured, and why:

- **~150 of the 208 candidates carry gate tallies, not site counts** — "8 746 pass / 0 fail / 612 files",
  "1 837 pass / 2 fail / 213 files". These are dated run records; they are not re-measurable after the
  fact and re-running them is not this row's job. Padding the table with them would have made the
  survey look thorough and been worth nothing.
- **~30 genuine site-count claims I did not reach.** Named so the next pass can start there rather than
  re-triage: **P2.152** ("18 copies" of the head gate), **P2.167** ("29 call sites"), **P2.169**
  ("13 path fields", "three readers"), **P2.209** ("eleven sites" from one import-type edge),
  **P2.118** ("27 sites", "51 of 130 allowlist entries"), **P2.166** ("13 call sites"),
  **P2.198** ("four sites, ten call sites" — the row that already records the wrapper skipping ten call
  sites), **P2.142** ("three readers, four files"), **P2.150** ("37 files"), **P2.196** ("17 call
  sites"), **P2.202** ("nine consumers"), **P2.127** ("21 paths"), **P2.133** ("7 surfaces"),
  **P2.173** ("274 call sites"). Of these, P2.198 and P2.118 are the ones I would take first —
  P2.198 because its own note says a wrapper skipped ten call sites, so its *corrected* number has
  never been independently re-derived; P2.118 because its 27 sites bound an escalation (P2.207/P2.208)
  that is still open.
- **Open (⬜) rows were deprioritised throughout**, per the brief's ordering. 40 of the 208 candidates
  are open; none were re-measured.

**Honest boundary:** this survey establishes that the exposure is real and bounded (8 identifiers wholly
invisible, 32 substantially so, 25 hidden anchors on one pattern), and it found three substantive
defects. It does **not** establish that the remaining ~30 site-count claims are correct. Treat section 3
as a floor, not a ceiling.
