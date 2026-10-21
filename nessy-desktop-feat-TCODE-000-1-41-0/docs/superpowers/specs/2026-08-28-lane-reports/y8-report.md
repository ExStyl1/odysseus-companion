# P2.286 — third survey of unmeasured site-count claims

**Surveyed at SHA `40b3c84a3955a7716bdaeef2c9098154ab52082a`** (branch `feat/TCODE-000`,
HEAD subject `fix(generators): a quotation counted as a record, an untracked file as a tree`).
Tracker snapshotted at that SHA to `<scratchpad>/sdd2/y8/tracker.md`, md5
`afaae1bb7b4baf8b4043c8ef59fb601d`; every quotation below is from that snapshot.

**HEAD advanced to `62e566a93184646abebc689dfba61793718c12aa` while I worked** (eight lanes are
live). Every `git grep` / `git show` below is pinned to `40b3c84a3` explicitly; the two
working-tree tools (`tsc`, `eslint`) ran against the tree as it stood, and where that matters
I checked the relevant package was clean (`git status --porcelain packages/server-core` → empty).

**Read-only on source. Nothing fixed, nothing committed, the plan file was not touched.**
`git status --porcelain` shows no file created by me inside the repo — all working files are
under `<scratchpad>/sdd2/y8/`.

`[doc:none]` — this is a survey of our own tracker. No Claude or Codex page governs any finding
below. Two findings touch doc-governed rows and are marked where they do.

---

## 1. Instrument — controls first, and one near-miss it caught

Every measurement used `/usr/bin/git grep` at the survey SHA with **literal directory
pathspecs**. Controls, run before any row:

```
$ /usr/bin/python3 -c "b=open('packages/shared/src/agent/permissions-config.ts','rb').read()
  i=b.find(b'\0'); print('NUL at',i,'of',len(b))"
NUL at 44920 of 88504

$ grep -c "codex-execpolicy-" packages/shared/src/agent/permissions-config.ts   # wrapped
(no output)                                                     exit=1   ← BLIND
$ /usr/bin/grep -ac "codex-execpolicy-" …/permissions-config.ts
1
$ /usr/bin/git grep -c "codex-execpolicy-" 40b3c84a3 -- …/permissions-config.ts
40b3c84a3…:packages/shared/src/agent/permissions-config.ts:1

$ /usr/bin/git grep -c "zzzNoSuchTokenXyzzy1234" 40b3c84a3 -- packages    exit=1, no output
```

**The fourth mechanism reproduces on this rig, independently:**

```
$ /usr/bin/git grep -c "\.commands" 40b3c84a3 -- 'packages/*/src'   →  0 files, exit 0
$ /usr/bin/git grep -c "\.commands" 40b3c84a3 -- packages           → 29 files
```

Two more that bit me and failed **loudly**, worth restating because both are one keystroke away:

- **zsh's `:a` history modifier eats `$SHA:apps/…`.** `git show $SHA:apps/ios/…` resolved to
  `…/40b3c84a3955a7716bdaeef2c9098154ab52082apps/ios/…` — the `:a` was consumed as a modifier
  and the ref and path fused. Always `"${SHA}:path"`.
- **A command in a shell variable does not word-split in zsh.** `G="/usr/bin/git grep"; $G …`
  → `no such file or directory: /usr/bin/git grep`, exit 127.

### 1a. My own instrument produced two confident wrong answers, both caught by cross-check

Recording these because they are the same failure class the row exists to find.

1. **Row count.** My first parser split on `|` and read field 3. It reported **404 rows** and
   found one row (`P2.75`) whose status field was the string `` ` inside a comment `` — a pipe
   inside a backtick code span. Masking code spans, and admitting the 14 `T*` rows the first
   regex rejected, gives **418**. Applying the fixed parser to x6's SHA gives **413**
   (284 ✅ / 123 ⬜ / 6 ⏸) where x6 reported **411 (281 / 123 / 6)** — whose own three numbers
   sum to 410, not 411. The ⬜ and ⏸ counts agree exactly between the two instruments; the
   ✅ figure is where the T-rows fall in or out.
2. **P5.3's plan-file denominator.** `ls docs/superpowers/plans/ | wc -l` → 135 (counts the
   `assets/` directory); `git ls-tree -r` → 145 (recurses into it). Both wrong.
   `git ls-tree` non-recursive on the directory → **134 tracked `*.md`**, which is exactly
   P5.3's number. Two wrong answers, one right, and only the third agreed with the row.

### 1b. The denominator both earlier surveys used is itself an undercount — measured

A mechanical selector over row notes gives **222 flagged rows** at this SHA
(175 ✅ / 42 ⬜ / 5 ⏸), close to x6's 216. But I measured its **recall against 34 rows already
known to carry a count claim** (x6's nineteen plus my fifteen): it captures **27 of 34, ≈79%**.
It misses P2.230, P2.293, P2.333 (x6's) and P2.338, P2.216, P2.147, P2.235 (mine).

So **"216 flagged" is a floor produced by the same kind of instrument this row exists to
distrust.** Scaled by measured recall the true population is ≈**280 of 418 rows**, and the
"20% covered" figure both earlier surveys quote is therefore **optimistic**: the denominator
is too small. Corrected, three surveys have covered **59 of ~280 — about 21%** *with a wider
denominator*, i.e. coverage has barely moved despite the third pass.

---

## 2. Scope

| Measure | Survey 1 (`ef91e6762`) | Survey 2 (`09b77d449`) | **This survey (`40b3c84a3`)** |
| :-- | --: | --: | --: |
| Rows in tracker | 345 | 411 (my re-parse: 413) | **418** (404 `P*` + 14 `T*`) |
| ✅ / ⬜ / ⏸ | 243 / 97 / 5 | 281 / 123 / 6 | **294 / 118 / 6** |
| Rows carrying a count or absence claim | 208 | 216 | **222 by selector; ≈280 corrected for 79% recall** |
| Re-measured in depth | 25 | 19 | **15** |
| Rows that carried a correction | 8 (32%) | 14 (74%) | **10 (67%)** |

Ten rows closed and five rows were born between x6's SHA and mine (`P2.343`–`P2.347` new;
`P2.286, P2.313, P2.325, P2.326, P2.330, P2.332, P2.333, P2.334, P2.336, P2.337` went ⬜→✅).
None of my fifteen overlaps x6's nineteen; all fifteen come from x6's §5 "untouched" and
"triaged-but-not-measured" lists, as instructed.

**The rate held at two thirds on a set selected purely by "nobody has looked".** The two
surveys before me selected for suspicion; I did not, and the rate barely fell.

---

## 3. Corrections table

Verdicts: **confirmed** / **undercount (N→M)** / **stale** / **understated** / **premise refuted**.

| # | Row | Claim as written | Measured | Evidence | Verdict |
| :-- | :-- | :-- | :-- | :-- | :-- |
| Y-1 | **P2.341** ⬜ `[doc:claude]`, self-classified **bug** | "`sub-agents.md` documents that `ultracode` is exempt … **Two files quote that exemption. Neither enforcement site reads the keyword** — zero hits … the exemption exists in our prose and in the vendor's page and **not in our code**: a user running `ultracode` is silently capped" | **The exemption is implemented, and has been for twenty days before the row was written.** There is **one** enforcement site, not two, and it applies the exemption | `packages/pi-agent-server/src/orchestrator/spawner.ts:765` — `if (limitScope === 'agent-tool' && sessionThinkingLevel(cfg) !== 'max')` guards the only ceiling check (`:766` `maxConcurrentSubagents()`, `:768` `concurrentSubagentLimitMessage`). `maxConcurrentSubagents(` has exactly one non-test call-site pair (`spawner.ts:766`, `:898`). Pinned by `spawner.test.ts:1180` — *"exempts an ultracode session from the check while still counting the slot"* — with the doc quotation at `:1181-1182`. `spawner.ts:760-762` states it in prose. The two "quoting files" (`subagent-limits.ts:19`, `live-agent-ceiling.ts:164`) are documentation, not enforcement. **The keyword grep was the wrong instrument**: `automations/types.ts:381` records the deliberate mapping — *"Nessy has no \"ultracode\" effort level (`ultracode` here is the workflow trigger keyword …)"* — so `thinkingLevel === 'max'` **is** our spelling of it, and a "fix" adding a literal `ultracode` read would be wrong. **Dated:** exemption and test landed in `688a4c37a` (2026-08-08); the row was written at `09b77d449` (2026-08-28), and `git merge-base --is-ancestor` confirms the ancestry. Present at the row's own birth commit. | **premise refuted (false at birth)** |
| Y-2 | **P2.189** ⬜ | "**77** `allowed → toBe(true)` sites swept across **14 files**, 8 read in full, the rest counted but neither read nor mutated — so **nothing is claimed about the other 69** … the largest untouched are `mode-manager.test.ts` (18), `skill-invocation.test.ts` (15) and `mode-gate.test.ts` (14)" | **96 sites across 15 files. The bound on remaining work is 88, not 69 — and the second-largest file is not in the row's ranking** | `git grep -c "allowed)\.toBe(true)" 40b3c84a3 -- packages` → 96 across 15. The three files the row names reproduce **exactly** (18 / 15 / 14), so the selector is the row's own. 77 is what you get from **`packages/shared` `*.test.ts` only** — which is 13 files, not the 14 the row states, so the row is internally inconsistent. Excluded by that scope: **`packages/shared/src/agent/core/__tests__/prerequisite-manager.isolated.ts` — 17 sites** (`:67, :72, :77, :83, :94, :154, …`, 41 `describe`/`it`) and `packages/server-core/src/sessions/worktree-floor-approval.test.ts` — 2. `.isolated.ts` files **are** run: `package.json:22` `"test": "bun test && for f in $(find . -name '*.isolated.ts' …)"`. Ranked by size the untouched files are mode-manager 18, **prerequisite-manager.isolated 17**, skill-invocation 15, mode-gate 14 — the row names #1, #3, #4 and omits #2. | **undercount (77/14 → 96/15; remaining 69 → 88)** |
| Y-3 | **P2.216** ⬜ | `runtime-switch-copy.ts:199` is "**a twenty-second** independent restatement of the same list … **count what is left**: two lanes have now each found sites the other did not, so **assume a twenty-third exists** until a sweep says otherwise" | **Twenty-third is fifteen lines below the site the row names, in the same file. Twenty-fourth and twenty-fifth are in Swift, in an app directory this repo's own map does not list** | Named site confirmed: `apps/electron/src/renderer/components/app-shell/input/runtime-switch-copy.ts:199-211`, fail-open `default: return 'pi'` at `:209`; its `factory.ts:314` citation **is stale** — `providerTypeToAgentProvider` is at `factory.ts:400`, and `:314` is now unrelated prose about fixture key order. **Unnamed 23rd:** `runtimeLabel` at `:214-221`, same vocabulary, same fail-open (`default: return 'Pi'`). **Unnamed 24th/25th:** `apps/ios/NessyAgentKit/Sources/NessyAgentKit/Models/RuntimeSwitch.swift:31-38` (`AgentRuntime.init(providerType:)`, `default: self = .pi`) and `:41-48` (`label`), documented at `:19-24` as *"A local restatement of `providerTypeToAgentProvider` … the same hand-kept mirror the renderer holds"* — and citing `factory.ts` **without a line number**, which is why that one did not rot. `scripts/ios-wire-enum-parity.ts:309-321` registers `AgentRuntime` as **EXEMPT** from the drift check with the reason *"KNOWN GAP, deliberate: a runtime added to the factory shows on the phone as \"Pi\" until someone extends the switch, and no list comparison can see that because there is no list"* — i.e. the identical defect is recorded-and-accepted one client over, which the row does not know. | **undercount (22 → ≥25)** |
| Y-4 | **P2.218** ⬜ | "`server-core` under `noUncheckedIndexedAccess` is **16 errors across 6 files, 11 of them in a single test file** … with 11 of 16 in one test file, the **production surface is five errors**, so the flag is far closer than the raw number suggests. **Fix the five first**" | **16 / 6 / 11 exact. But the production surface is ONE error, not five — 15 of 16 are in test files** | `tsc -p packages/server-core/tsconfig.json --noUncheckedIndexedAccess` → exit 2, **16 `error TS` lines** across **6** files, **11** in `src/handlers/rpc/__tests__/automations-management.test.ts`. Control on the same rig: same command **without** the flag → exit 0, **0** errors. The other five: `src/__tests__/conformance/wire-observer.ts` (test harness), `src/sessions/cold-session-metadata.test.ts`, `src/sessions/SessionManager.interaction-tools.test.ts`, `src/pi-harness/plan-mode-service.test.ts` — all tests — and **`src/webui/node-adapter.ts(47,20)`**, the only production file. `packages/server-core` is clean in the working tree (`git status --porcelain` empty for it), so this is the SHA's number. **Correction is in the row's favour and changes its plan**: excluding test files leaves one error, so the guard can exist now. | **overstated (5 → 1 production)** |
| Y-5 | **P2.147** ⬜ (**self-flagged UNCONFIRMED**: "confirm before fixing, and if it is not real, close the row as refuted with the measurement") | "`CLAUDE_REPLACED_DEFAULT_FOLDERS` **appears to omit `experimental.themes` and `experimental.monitors`** … the same shape (two constants that must agree, one updated and one not)" | **Not real, and structurally impossible.** The two fields cannot be members of that list, and neither has a default folder to displace | `format-adapters/claude.ts:3008-3016` — `CLAUDE_REPLACED_DEFAULT_FOLDERS: ReadonlyArray<{ field: keyof ClaudeManifestPaths; … }>` with four entries (`commands`, `agents`, `workflows`, `outputStyles`). `ClaudeManifestPaths` (`:2888-2897`) has exactly **seven** members — `skills, commands, agents, workflows, outputStyles, hooks, mcp` — so `experimental.themes` / `experimental.monitors` **would not compile** as entries. The docstring at `:3001-3006` already accounts for all three absent members with doc citations (`skills` — *"`:637` makes its default scan unconditional"*; `hooks`/`mcpServers` — *"`:638` gives them their own merge rules"*). And there is **no folder to displace**: the only `CLAUDE_DEFAULT_*_DIR` constants are `SKILLS`, `COMMANDS`, `AGENTS`, `WORKFLOWS`, `OUTPUT_STYLES` (`:166-171`) and `BIN` (`:2633`, scanned unconditionally, no manifest key). Positive control that the two fields are handled elsewhere: `experimental.themes` in `CLAUDE_RETAINED_SURFACE_FIELDS` (`:2343`, `externalKind: 'theme'` at `:2361`), `experimental.monitors` via `normalizeClaudeMonitors` (`:1783`, called `:369`). | **premise refuted** |
| Y-6 | **P2.239** ⬜ | "`x === 'reported' ? 'reported' : 'unsupported'` is **triplicated** — `SessionManager.ts:4418`, `SessionManager.ts:24529`, `telemetry/cost-reporting.ts:92` … Export it once and **read it three times**" | **Four sites, two anchors drifted, and the two branches of one emitter disagree about whether to collapse at all** | The one-line form: `SessionManager.ts:4487`, `SessionManager.ts:24798`, `cost-reporting.ts:92` — three, with **`:4418`→`:4487` and `:24529`→`:24798`** (`cost-reporting.ts:92` exact). **The fourth is spelled across two lines, which is why a one-line grep misses it:** `telemetry/usage-metrics.ts:250` `const reported = turn.costReporting === 'reported'` + `:254` `costReporting: reported ? 'reported' : 'unsupported'`. Same semantics at all four — `CostReporting` (`core/types/message.ts:526`, three-valued) → `TurnCostReporting` (`:529`, two-valued), folding `'partial'` into `'unsupported'`. **Unclaimed adjacent defect:** in that same function the map branch at `:233` passes `usage.costReporting` **uncollapsed** into the same `series()` field the fallback branch collapses at `:254`, and the key type at `:120` admits `'partial'`, which reaches the metric attribute at `:410`. So a partially-reported turn is labelled `partial` on one branch and `unsupported` on the other. "Read it three times" would leave the fourth site and would not surface the asymmetry. | **undercount (3 → 4) + 2 anchors drifted** |
| Y-7 | **P2.224** ⬜ | "**28 assertions across 13 `packages/server-core` files** … P2.106's reviewer hand-classified **all 28** … At least eleven are guarded by an immediately preceding assertion (… `plugin-hook-runners:694` … )" | **28 hits across FOURTEEN files; one anchor drifted 102 lines; three of today's 28 appear in neither of the row's lists and all three read as genuinely vacuous** | Re-ran the row's own selector verbatim (from `packages/server-core/eslint.config.mjs:196-199`) as a `no-restricted-syntax` overlay: **28 hits / 14 files**. `packages/server-core` is clean in the working tree and all three unnamed files are tracked at the SHA (`git cat-file -e`), so this is the SHA's number. The three the row never names: `src/sessions/__tests__/message-display-hook.test.ts:305`, `src/sessions/__tests__/runtime-switch-session.test.ts:1501` (`expect(error?.code).toBeUndefined()` — passes whether `error` is `undefined` or an object without `code`), `src/sessions/__tests__/subtask-result-transcript.test.ts:222`. None has a preceding existence assertion. **Anchor:** `plugin-hook-runners:694` is `timeoutController = new AbortController()` today; the file's single hit is at **`:796`**. **The row's sharp end is confirmed exactly**: `turn-terminal-reason.test.ts:167` is `expect(complete).toBeDefined()` and `:168` is the hit — so the selector's second-direction proof did rest on a fixed line. | **undercount (13 → 14 files) + anchor drifted** |
| Y-8 | **P2.338** ⬜ | "Blast radius **measured rather than estimated**: 1 product call site + 1 import, 1 import + 10 test assertions, **3 prose mentions** … the measurement is in this row rather than in someone's head" | **Everything but the prose count is exact. Prose is 6 in-code comments and 11 doc-file references across 6 files — and it was wrong at the row's own birth commit, not stale** | `narrowRuntimeSkillTools` at `40b3c84a3`: product call site `SessionManager.ts:14256` (**1** ✅), product import `:354` (**1** ✅), test import `runtime-skill-content.test.ts:12` (**1** ✅), test assertions `:612, :615, :616, :618, :619, :623, :649, :650, :653, :655` (**10** ✅). **Code comments: 6** — `SessionManager.ts:14254`, `:14370`, `claude-runtime-agents.ts:460`, `:486`, `pi-harness/runtime-agent-definition.ts:698`, `runtime-skill-content.ts:1653`. **Doc references: 11 across 6 files** (excluding the tracker's own 4): `2026-07-28-skill-tool-grants.md` 3, `2026-07-29-inert-unit-e.md` 2, `2026-08-12-audit-defect-closure.md` 2, `2026-08-02-claude-doc-sweep-worklist.md` 2, `…/data/2026-08-02-doc-sweep-worklist.tsv` 1, `…/data/phase25-specs/f062.json` 1. **Identical at the row's birth commit `c5a568df9`** — same 5 code files, same 7 doc files, same counts. `void invocations;` confirmed at `runtime-skill-content.ts:1644`. | **undercount (3 → 6 code + 11 docs), wrong at birth** |
| Y-9 | **P5.3** ⬜ | "**CONTAMINATION HAZARD** … regenerate from a clean tree or the output is wrong … the glob returns **134 plan files** and the untracked … is among them … **Three files have been sitting untracked since 2026-08-23**" | **134 exact. The hazard is CLOSED at this SHA. "Three untracked" is now twenty-three, and the committed artifact is stale by three lines — one of which is a scratchpad path** | Plan files tracked at the SHA: **134** `*.md` (see §1a — two other counting methods gave 135 and 145). **The mechanism is fixed by the survey SHA's own commit:** `build-parity-report.py:418` is now `set(p.stem for p in tracked(PLANS.glob("*.md")))` and `:421` `tracked(SPECS.glob("*.md"))`; `tracked()` (`:159-169`) drops untracked inputs and `announce_inputs()` (`:172`) names them on every run. Verified by running it: `python3 scripts/build-parity-report.py --check` → *"2 untracked input(s) EXCLUDED — this report and its --check verdict describe the committed tree, not your working tree"*, naming both dp-auth files, then *"STALE — 3 line(s) differ. This drift is REAL: untracked plans and specs were excluded from the comparison … so it is not the working tree talking."* **Untracked set is now 23 files, not 3** — the original three plus 13 `eslint.config.mjs`, `eslint.config.base.mjs`, `scripts/check-eslint-coverage.{ts,test.ts}` and 5 new test files, i.e. **this plan's own live lanes** (the eslint files are P2.319's 11 unlintable packages being fixed), which inverts the row's "they belong to no lane in this plan". **And the committed report is stale by 3 lines, one of them `| sdd2/x6-report.md | 1 |`** — a scratchpad path harvested into a repo artifact. | **premise superseded (fixed) + stale in both directions** |
| Y-10 | **P2.318** ⬜ `[doc:codex]` | "of the seven entries in `PI_PREFERRED_DEFAULTS['openai-codex']` **only `gpt-5.5` exists in the codex catalogue** … the list is now mostly decoration. Refresh it against the shipped catalogue" | Seven entries exact. But `openai-codex` is **one of two byte-identical lists**, and the file's own docstring records **two further provider rows that resolve to nothing at all** | `config/llm-connections.ts:817-833` — `PI_PREFERRED_DEFAULTS` has **7 provider keys**. `'openai-codex'` (`:820`) has exactly **7 entries**: `gpt-5.5, gpt-5.2, gpt-5.1, gpt-5, o4-mini, o3, gpt-4o` — **byte-identical to `'openai'` at `:819`**, so a refresh of one leaves two lists that agree today disagreeing tomorrow. `PI_MINI_PREFERRED_DEFAULTS`' docstring at `:854-865` states, as measured fact, that `github-copilot`'s ids *"resolved to NOTHING"* (dots vs dashes) and that `amazon-bedrock`'s *"bare `claude-*` ids in `PI_PREFERRED_DEFAULTS` are absent from that catalog"*. So **three of seven provider rows are already known-degenerate and the row names one.** (The catalogue half of the claim needs a live codex catalogue and is **NOT re-derived here**.) | **understated (1 of 7 rows named; 2 more already recorded degenerate, 1 identical twin)** |
| Y-11 | **P2.229** ⬜ | "`bun run lint` on a clean tree emits **7 `Unused eslint-disable directive` warnings — 3 in `apps/electron`, 4 in `packages/shared`**" and "its not-adopted block records `@typescript-eslint/no-unused-vars` at **40 hits**, and re-running it as written (`'error'`) gives **172 across 28 files**" | **Both halves exact** | `eslint . --format json` per package, `errorCount`/`warningCount` read from JSON (never `--format unix`): `apps/electron` **3** (`main/browser-pane-manager.ts:3302`, `:3313`, `renderer/playground/registry/types.ts:30`), `packages/shared` **4** (`agent/session-scoped-tools.ts:232`, `:272`, `i18n/setupI18n.ts:23`, `utils/debug.ts:41`), `server-core` 0, `ui` 0, `scripts` 0 → **7**. Overlay config forcing `@typescript-eslint/no-unused-vars: 'error'` on server-core → **172 hits across 28 files**, against the config comment's `40` at `eslint.config.mjs:190`. | **confirmed, both halves** |
| Y-12 | **P2.47** ⬜ | "the set still holds **six entries** … the invariant now covers **6 of 8 reachable branches** and the escape literals are hand-copied into **a third place in the same file**" | **All three sub-claims exact.** I can name the two uncovered branches and the third copy | `BLOCK_CASES` (`__tests__/mode-block-reason.test.ts:145-152`) — **6** entries. Enumerating every distinct block message: `getBlockReasonWithConfig` (`mode-manager.ts:2767-2793`) has 4 — `Bash` `:2772`, file-modification `:2775`, `API mutations` `:2791`, generic `:2793`; `shouldAllowToolInMode` has 4 more — session-configuration `:2711`, `__api_` `:2726`, MCP-write `:2735`, `api_` `:2749`. **Eight.** BLOCK_CASES covers six; the two it misses are **`Bash` (`:2772`)** and **`API mutations` (`:2791`)**, both of which the file does exercise — at `:312` and `:272` — but through the **third copy**, the `ESCAPE` map at `:254-256`, which restates the same three literals already written at `:189`, `:198` and `:203`. | **confirmed (3/3)** |
| Y-13 | **P2.235** ⬜ | "**6 of 77 pins are checked**; the other 71 are live-import digests" and the fixture's `inputCodec` rationale is "stale" | **Exact.** 77 pins, 6 checkable, and the 6 *are* a subset of the 77 | `packages/pi-agent-server/src/__tests__/harness-contract/fixtures/tool-surface.json`: **77** `bindingSchemaVersion` values of the form `exact-name:<tool>/sha256:…` (83 `bindingSchemaVersion` lines total; the other 6 are the non-tool contract rows at `:704, :725, :750, :776, :799, :822`). **6** entries carry `"evidenceKind": "source-state-schema"` (`:611, :620, :629, :638, :647, :656`), each also holding `schemaIdentity: source-state-schema:sha256:…` **and** a `bindingSchemaVersion: exact-name:…` — so the 6 are 6 of the 77, and "6 of 77" is right. (My first reading had them as disjoint; the entry structure at `:610-618` settled it.) The stale rationale is verbatim in the fixture at `:616`: *"source-state parameters declaration; live import excluded because spawner eager runtime graph retains handles"*. Three prefix spellings coexist as the row's fourth item says: `source-state-schema:`, `source-state-schema/`, `exact-name:<tool>/`. | **confirmed** |
| Y-14 | **P2.220** ⬜ | "**35 defs carry `safeMode: 'allow'` and 26 carry `'block'`**, roughly 11 and 8 respectively are named by hand across the two suites" | **35 / 26 exact in `tool-defs.ts`** | `git grep -c "safeMode: 'allow'" 40b3c84a3 -- packages` → `session-tools-core/src/tool-defs.ts:35` (plus 5 in three test files); `'block'` → `tool-defs.ts:26` (plus 7 in two test files). The "roughly 11 and 8 named by hand" is a soft figure I did not try to falsify, and the mutation demonstration (`transform_data` flip → 28 pass / 0 fail) was **NOT re-run**. | **confirmed (countable part)** |
| Y-15 | **P2.295** ⬜ | "`AppShell.tsx:1358-1364` carries the same **dead** `pi-only` claim about the cron tools, in the renderer" | **Confirmed dead — and the correct statement of the same fact is one directory away, in a file the row does not connect to it** | `AppShell.tsx:1358-1363`: *"the bundled `loop` skill is withheld wherever its cron tools are not mounted (**they are `visibility: 'pi-only'`**)"*. Measured in `session-tools-core/src/tool-defs.ts`: `CronCreate` `:1247`, `CronList` `:1248`, `CronDelete` `:1249`, `ScheduleWakeup` `:1256` and `Monitor` `:1163` carry **no `visibility` field at all**; the 12 defs that are still `pi-only` are `Task`/`Task*` (`:1095-1101`), `EnterWorktree`/`ExitWorktree` (`:1169-1170`), `list_mcp_resources`/`read_mcp_resource` (`:1176-1177`) and `PushNotification` (`:1214`). `AppShell.tsx` has exactly **one** `pi-only` mention. **The live correct text is in the same renderer directory**: `input/runtime-switch-costs.ts:270-277` — *"It used to be one sentence … were ALL `visibility: 'pi-only'` … T3 projected the first five onto Claude … What remains `pi-only` is `PushNotification` alone"* — and all four of its `pi-only` claims check out against `tool-defs.ts`. So two renderer files one directory apart state opposite facts. | **confirmed + the fix text already exists nearby** |

---

## 4. Findings that are not corrections to a row — each tagged and classified

1. **`apps/ios` is a 116-file, 97-Swift client that this repo's own orientation document does
   not mention.** `AGENTS.md`'s §Monorepo Map lists `apps/electron`, `apps/cli`, `apps/viewer`,
   `apps/webui` and no `apps/ios`; `git grep -ic "ios" 40b3c84a3 -- AGENTS.md` → **exit 1, zero
   hits** (positive control: the map text itself, quoted above, is in the same file and the same
   grep finds `apps/electron`). `typecheck:all` (`package.json:25`) names twelve targets, none
   of them `apps/ios`. It holds **hand-kept mirrors of shared TypeScript vocabularies**
   (`PermissionRequestType`, `PermissionMode`, `MessageType`, `MessageRole`, attachment `Kind`,
   `RuntimeSwitchKind`, `HistoryCarryPlan`) policed by `scripts/ios-wire-enum-parity.ts`, plus
   two **EXEMPT** entries — one of which, `AgentRuntime`, is Y-3's defect recorded as a
   deliberate known gap. **Any sweep of this plan that was scoped by AGENTS.md's map has never
   seen this directory.** `[doc:none]` · **never-looked-at**.

2. **`bun run lint:electron` cannot complete at Node's default heap on this host.**
   `cd apps/electron && eslint .` aborts with `FATAL ERROR: Ineffective mark-compacts near heap
   limit … JavaScript heap out of memory`, exit **134**, after ~40 s at ~4 GB. It completes with
   `NODE_OPTIONS=--max-old-space-size=8192` (exit 0, 1.67 MB of JSON). `package.json:47` sets no
   `NODE_OPTIONS`. A lane that runs `bun run lint` and reads only the exit status of a pipeline
   will record a **crash as a pass** — `pipefail` is off. `[doc:none]` · **bug**.

3. **`apps/electron` emits 119 eslint warnings** — 95 `react-hooks/exhaustive-deps`,
   21 `nessy-general-agent/no-localstorage`, 3 unused-disable. P2.229 measures only the third
   family; "on a clean tree `bun run lint` emits 7 warnings" is true of that family and false of
   the total. Not a correction to P2.229 (which scopes itself), but the plan has no row for the
   other 116. `[doc:none]` · **never-looked-at**.

4. **The committed parity report contains a scratchpad path.**
   `docs/superpowers/specs/2026-07-30-parity-report.md` carries `| sdd2/x6-report.md | 1 |` in
   its cited-documentation table, harvested from a quotation of a `/private/tmp/...` path inside
   the plan file. `--check` shows the regenerated report drops it (this is one of the three
   stale lines). Belongs with P5.3's regeneration. `[doc:none]` · **bug**.

5. **`git grep -ic "…" <sha> -- AGENTS.md` returning exit 1 is a usable absence result on this
   rig, but only with a positive control in the same file.** Recorded because finding 1 depends
   on it.

---

## 5. What I would put in front of the owner

1. **Y-1 (P2.341) is the one that matters most, and it is the opposite of a gap.** The row is
   tagged `[doc:claude]` and self-classified **bug**, so under this plan's stopping rule it
   *counts toward closing the documented contract* — while dispatching a fix for a control that
   has been in the tree since 2026-08-08 and is pinned by a test that quotes the same doc
   sentence. Worse, the "fix" it asks for (make an enforcement site read the `ultracode`
   keyword) is the wrong fix: `automations/types.ts:381` records that we deliberately have no
   `ultracode` effort level and that `ultracode` is our **workflow trigger keyword**. A literal
   keyword read would couple the subagent ceiling to the workflow trigger. **The row's own
   positive control is what misled it** — it controlled that the grep worked, not that the
   concept was absent, and a keyword grep cannot see a semantic mapping.

2. **Y-2 (P2.189) is the clearest instance of the mechanism this survey row exists to catch.**
   The number the row offers as the bound on remaining work — *"nothing is claimed about the
   other 69"* — is **88**, because its sweep globbed `*.test.ts` under one package and the repo
   also runs `*.isolated.ts` (`package.json:22`). The file it missed, `prerequisite-manager.isolated.ts`,
   is the **second largest in the family at 17 sites**, larger than two of the three the row
   names as "the largest untouched". A next pass that took the row's ranking at face value would
   sweep #1, #3 and #4 and call it done.

3. **Y-4 (P2.218) corrects downward, and that is worth as much.** "Fix the five first" is
   really "fix the one" — `webui/node-adapter.ts(47,20)`. Fifteen of sixteen errors are in
   tests. `noUncheckedIndexedAccess` can be turned on for `server-core` production code today,
   which is a guard this plan wants and has been deferring behind a number that was 5× too big.

4. **Y-5 (P2.147) closes as refuted, exactly as it asked to.** Its suspected divergence is
   forbidden by the type (`keyof ClaudeManifestPaths`, seven members, neither field among them)
   and by the absence of any default folder for themes or monitors. The row's larger worry —
   "two constants that must agree" — is real as a class and false here; the constant is bound to
   its sibling by the type system, which is the guard the row asks for.

5. **Y-9 (P5.3) is already fixed by the commit at the head of this survey**, and the row still
   reads as an open hazard. Meanwhile its concrete instruction ("three untracked files … must be
   resolved before this row regenerates anything") has become wrong in the other direction:
   there are 23, and 20 of them are this plan's own live lanes. If P5.3 is dispatched as
   written, someone will chase three files while the generator that used to need them chased has
   stopped caring, and will still regenerate against a tree carrying twenty in-flight files.

6. **Y-3 (P2.216) plus finding 1 is a scope hole, not a count.** The row asks for a sweep and
   guesses "assume a twenty-third exists". There is one fifteen lines below the site it names,
   and two more in a Swift client that neither `AGENTS.md`'s map, nor `typecheck:all`, nor any
   sweep in this plan has looked at. The iOS one is **already registered as a deliberate known
   gap**, which means fixing the renderer alone leaves the same fail-open shipped on the phone
   with a comment saying we meant it.

7. **The denominator is the number to distrust next (§1b).** "216 flagged rows" is the output
   of a mechanical selector, and I measured that class of selector at **79% recall** against 34
   rows already known to carry a count claim. Corrected, coverage after three surveys is
   ~**59 of ~280 = 21%** — statistically unchanged from x6's stated 20% despite fifteen more
   rows measured, because the denominator grew as fast as the numerator. **Nothing here
   licenses a completeness claim, and the correction rate has now been 32%, 74% and 67% across
   three passes with three different selection strategies.**

---

## 6. Where I stopped

**Triaged 418 rows / 222 flagged by selector (≈280 corrected for recall) / 15 re-measured in
depth / 10 carried a correction.**

The fifteen: **P2.47, P2.147, P2.189, P2.216, P2.218, P2.220, P2.224, P2.229, P2.235, P2.239,
P2.295, P2.318, P2.338, P2.341, P5.3.** None overlaps x6's nineteen or the eight x6 attributes
to survey 1.

Corrections (10): P2.147, P2.189, P2.216, P2.218, P2.224, P2.239, P2.318, P2.338, P2.341, P5.3.
Clean (5): P2.47, P2.220, P2.229, P2.235, P2.295.

**Not reached, named so the next pass starts there rather than re-triaging:**

- **From x6's §5 still-unmeasured list:** **P2.209** ("eleven latent errors" — note its
  *deferred* half is P2.218, which I measured, and its own "11 fixed" half is not re-derived)
  and **P2.127** ("twenty-two pattern classes, nine predicates across seven matcher kinds").
- **From x6's untouched-open list, still untouched:** P2.53, P2.56, P2.83, P2.175, P2.188,
  P2.217, P2.227, P2.240, P2.241, P2.244, P2.246, P2.262, P2.263, P2.264, P2.269, P2.291,
  P2.322, P2.342, P3.21, P5.4.
- **Open rows carrying a claim that NO survey has named yet** (my selector, minus everything
  above): P2.58, P2.63, P2.77, P2.86, P2.100, P2.111, P2.115, P2.119, P2.164, P2.187, P2.191,
  P2.197, P2.201, P2.214, P2.215, P2.221, P2.222, P2.233, P2.234, P2.236, P2.237, P2.242,
  P2.243, P2.247, P2.248, P2.250, P2.252, P2.253, P2.255, P2.256, P2.258, P2.261, P2.266,
  P2.268, P2.275, P2.279, P2.285, P2.294, P2.307, P2.308, P2.310, P2.312, P2.320, P2.321,
  P2.327, P2.331, P2.335, P2.339, P2.340, P2.343, P2.344, P2.345, P2.346, P2.347, P3.23.
  **The five newest (P2.343–P2.347) were born after x6's SHA and have never been triaged by
  anyone.**
- **~165 of the 175 flagged closed rows.**

**Two loose ends I opened and did not close**, so they are not lost:

- **`PI_PREFERRED_DEFAULTS['github-copilot']` and `['amazon-bedrock']`** are recorded in the
  file's own docstring (`llm-connections.ts:857-865`) as resolving to nothing against the
  shipped Pi catalogue. No row names them; P2.318 names only `openai-codex`.
  **Kind: never-looked-at.** `[doc:none]`.
- **`usage-metrics.ts:233` vs `:254`** — the map branch emits `'partial'` as a telemetry
  attribute where the fallback branch collapses it to `'unsupported'`. Surfaced under Y-6,
  outside P2.239's claim, never examined. **Kind: bug.** `[doc:none]`.

**Honest boundary.** Ten corrections in fifteen rows, on a set chosen only because nobody had
looked — no suspicion filter at all. Two of the ten are outright refutations of a stated
premise (P2.341, P2.147) and a third is a hazard the tree has already fixed (P5.3), so **three
of fifteen rows would have dispatched work that is wrong, unnecessary, or already done.** Three
more (P2.189, P2.216, P2.338) understate the bound on their own remaining work. The single most
useful number in this report is not any correction but §1b: **the denominator every survey has
been dividing by is itself a mechanically-produced undercount, measured at 79% recall**, so the
coverage figure has been flattering all three passes.

---

## 7. Gate

Read-only survey; no source file changed, so no diff-scoped gate applies.

- **`bun test` — NOT-RUN.** No code changed. Running it would prove nothing about this row and
  would take the shared mutex from lanes that need it.
- **`git diff --check` — NOT-RUN**, same reason. `git status --porcelain` confirms I created no
  file inside the repo; all working files are under `<scratchpad>/sdd2/y8/`.
- **`tsc` — RAN, as a measurement rather than a gate (Y-4).**
  `tsc -p packages/server-core/tsconfig.json --noUncheckedIndexedAccess` → exit 2,
  **16 `error TS` lines**; the same command without the flag → exit 0, **0 errors** (the control
  that makes the 16 attributable to the flag). Output redirected to files, not piped.
- **`eslint` — RAN, as a measurement rather than a gate (Y-11, Y-7, finding 2).**
  `--format json` throughout, `errorCount`/`warningCount` read from the parsed JSON — never
  `--format unix`. Five packages: `apps/electron` **0 errors / 119 warnings** (only after
  `NODE_OPTIONS=--max-old-space-size=8192`; it aborts 134 without), `packages/shared`
  **0 / 4**, `packages/server-core` **0 / 0**, `packages/ui` **0 / 0**, `scripts` **0 / 0**.
- **`python3 scripts/build-parity-report.py --check` — RAN (Y-9).** Exit 1, output quoted in
  full in the Y-9 row: 2 untracked inputs excluded by name, then `STALE — 3 line(s) differ`.
- The **instrument** was gated, which is the gate that matters here: positive control, negative
  control, the glob-pathspec mechanism reproduced independently, two of my own wrong answers
  caught by cross-check (§1a), and the flagged-row selector's recall measured rather than
  assumed (§1b).
