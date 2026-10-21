# P2.286 — second survey of unmeasured site-count claims

**Surveyed at SHA `09b77d44903d0695afb278515ea9d51260f91e5b`** (branch `feat/TCODE-000`,
working tree dirty with five other lanes' in-flight edits). Tracker snapshotted at that SHA to
`<scratchpad>/sdd2/x6/tracker.md`, md5 `e2f1528506d74712881e5af6eaf561ed`; every row quotation
below is from that snapshot, not from a later re-read.

**Read-only on source. Nothing fixed, nothing committed, the plan file was not touched.**

`[doc:none]` — this is a survey of our own tracker. No Claude or Codex page governs any finding
below except where explicitly noted (none do).

---

## 1. Gate — the positive controls, verbatim

Every measurement below ran through `/usr/bin/git grep` at the survey SHA. Controls, run first:

```
$ /usr/bin/python3 -c "b=open('packages/shared/src/agent/permissions-config.ts','rb').read()
  i=b.find(b'\0'); print('NUL at offset',i,'of',len(b))"
NUL at offset 44920 of 88504

$ grep -c "codex-execpolicy-" packages/shared/src/agent/permissions-config.ts; echo "exit=$?"
wrapped exit=1                      # BLIND — no output, exit 1

$ /usr/bin/grep -ac "codex-execpolicy-" packages/shared/src/agent/permissions-config.ts
1

$ /usr/bin/git grep -c "codex-execpolicy-" 09b77d449 -- packages/shared/src/agent/permissions-config.ts
09b77d449:packages/shared/src/agent/permissions-config.ts:1
```

Negative control: `git grep -c "zzzNoSuchTokenXyzzy" 09b77d449` → exit 1, no output. So a true
zero and a blind zero are distinguishable only by cross-instrument comparison, which is why
every absence claim below carries its own positive control.

### 1a. A FOURTH silent-empty mechanism, measured today, and it hit me mid-survey

The brief names three mechanisms that produce a confident empty result. There is a fourth, and
it is in the tool the brief recommends:

**A `git grep` pathspec containing a glob matches NOTHING and exits 0.**

```
$ /usr/bin/git grep -c "\.commands" 09b77d449 -- 'packages/*/src'        → 0 files, exit 0
$ /usr/bin/git grep -c "\.commands" 09b77d449 -- 'packages/*/src/**/*.ts' → 26 files
$ /usr/bin/git grep -c "\.commands" 09b77d449 -- 'packages/'              → 29 files
$ /usr/bin/git grep -c "\.commands" 09b77d449 -- ':(glob)packages/*/src/**' → 29 files
```

`packages/*/src` returns **zero, exit 0**. `packages/*/src/**/*.ts` returns 26 where the truth is
29 — it does not fail, it silently **undercounts by three files**. I hit this live: my first
`.commands` enumeration returned 0 hits for a symbol I had already seen, and only a positive
control caught it. An earlier figure in this run ("158 CapabilityContext producers") was measured
with the lossy form and is not to be trusted.

**Rule for the close-out sweep: literal directory pathspecs only (`packages/`, `apps/`,
`scripts/`), then filter with a second `grep`.** Never a glob in a pathspec.

Two smaller ones, both of which bit me and both of which fail loudly rather than silently:
- zsh applies its `:a` history modifier to `$S:apps/foo`. Always `"${S}:apps/foo"`.
- An `awk` that finds no match leaves an empty variable, and `git grep -n "" <ref>` then matches
  **every line in the repo** (2.6 MB of output). Guard extracted names before using them.

### 1b. My own tracker parser produced a confident, badly wrong answer

My first parse split rows on `' | '` and read status from field 2. It reported **287 rows, 2 open**.
Reparsing by pipe-field position gives **411 rows: 281 ✅ · 123 ⬜ · 6 ⏸**. I caught it only
because 2 open rows contradicted the previous survey's 97. Recording it because it is the same
failure class this row exists to find, produced by the survey instrument itself.

---

## 2. Scope, honestly stated

| Measure | Previous survey (`ef91e6762`) | This survey (`09b77d449`) |
| :-- | --: | --: |
| Rows in tracker | 345 | **411** |
| ✅ / ⬜ / ⏸ | 243 / 97 / 5 | **281 / 123 / 6** |
| Rows carrying a count or absence claim | 208 | **216** (170 ✅ + 46 ⬜) |
| Re-measured in depth | 25 | **19** |
| Rows that carried a correction | 8 of 25 (32%) | **14 of 19 (74%)** |

**The rate did not merely hold — it doubled.** That is partly selection: I deliberately took the
two rows the previous survey named as most suspect, then the open rows nobody had touched. But
selection does not explain a 74% hit rate on rows that are all marked closed-or-recorded, and
**five of the fourteen are undercounts of a number the row itself offers as the bound on remaining
work** (X-3, X-4, X-5, X-6, X-9). That is the specific mechanism by which a subset reads as closure.

**Two scoping corrections to the previous survey's §5:**

1. **Its "~30 genuine site-count claims" over-counts.** At least three of the fourteen rows it
   named carry *gate tallies*, not site counts, and belong in the ~150 it excluded: **P2.152**
   ("18 mutants, 0 survivors", "646 tests", "108/108"), **P2.167** ("917 loose assertions"
   catalogued by kind, "11 tier-1", "68 tier-2" — all products of that lane's own private
   detector, not re-derivable), and **P2.173** ("3 579 files → 1 274 → 99 → 50 → 25", a funnel
   whose definition lives only in the lane's report). I did not pad the table with these; I
   classify them **unverifiable-by-construction** and say so.

2. **It under-counts the open-row exposure by an order of magnitude.** It said open rows "were
   deprioritised" without sizing them. Measured: **46 open rows carry a count or absence claim**,
   none ever re-measured by anyone. **Six of my fourteen corrections come from that set**
   (X-1, X-2, X-3, X-9, X-10, X-11), including the two largest and the only live fail-open.
   The open rows were the richest seam in this survey, not the leftovers — which inverts the
   previous brief's ordering advice for whoever goes next.

---

## 3. Corrections table

Verdicts: **confirmed** / **undercount (N→M)** / **stale** / **understated** / **unverifiable**.

| # | Row | Claim as written | Measured | Evidence | Verdict |
| :-- | :-- | :-- | :-- | :-- | :-- |
| X-1 | **P2.293** ⬜ | `setAdvisorEnabled` "silently no-ops with no config.json" — `storage.ts:1799` — framed as **one** instance, "the same shape one layer down" | **Thirty setters in the same file carry the identical shape** | `packages/shared/src/config/storage.ts` — 30 `export function set*` whose body within 6 lines is `if (!config) return;`. `setAdvisorEnabled` is `:1799`, one of thirty. Security-relevant siblings: `setAllowRemoteEvaluate` `:1233`, `setBypassPermissionsAcknowledged` `:1283`, `setMacosSeatbeltBashSandboxEnabled` `:1318`, `setNetworkProxySettings` `:3133`, `setActiveWorkspace` `:2015`. Anchor `:1799` is exact. | **undercount (1→30)** |
| X-2 | **P2.249** ⬜ | "written two ways and **read as one**" — names one reader, `platform-headless.ts:51` (`=== 'true'`); consumers "**between those two points**" see false | **Read three ways by five readers; the odd reader is not in a window — it is permanently wrong, and it gates a validation branch** | Writes: `apps/electron/src/main/index.ts:128` `'1'/'0'` (module-level block opening `:112`, runs at load) and `:448` `'true'/'false'` (inside `app.whenReady().then` opening `:383`). Readers: `platform-headless.ts:27,46` (`!== 'true'`), `:51` (`=== 'true'`), `logger.ts:19-20` (`'true'`/`'false'`, else falls through), and **`packages/session-tools-core/src/runtime/resolve-script-runtime.ts:67` `=== '1'`**. Both production callers of `resolveScriptRuntime` — `script-sandbox.ts:77`, `transform-data.ts:92` — pass **no ctx**, so `:66`'s escape hatch never fires. `:448` has always run before any tool handler, so `inferPackagedMode()` returns **false on every production path**. Consequence: all **three** `validatePackagedEnvRuntime` guards (`:167` uv, `:207` node, `:233` bun) are unreachable in production, and the dev-only PATH fallbacks (`:186`, `:217`, `:243`) are reachable in a packaged app. Tests pass `{isPackaged: true/false}` explicitly, so the suite is green either way. | **understated — live fail-open** |
| X-3 | **P2.319** ⬜ | `pi-agent-server` is unlintable, and `codex-responses-adapter` is "**A SECOND** unlintable package" | **Eleven of fifteen workspace packages have no eslint config and are outside the root `lint` chain** | Only four packages carry `eslint.config.*` at the survey SHA: `apps/electron`, `packages/server-core`, `packages/shared`, `packages/ui` (plus `scripts/`). Root `lint` = exactly those five targets (`package.json:54`). The other **11**: `apps/cli`, `apps/viewer`, `apps/webui`, `packages/codex-agent-server`, `packages/codex-protocol`, `packages/codex-responses-adapter`, `packages/core`, `packages/pi-agent-server`, `packages/server`, `packages/session-mcp-server`, `packages/session-tools-core`. The row's thesis is right; its scope is 2→11. Note the convergence: X-2's defect lives in `session-tools-core`, one of the eleven. | **undercount (2→11)** |
| X-4 | **P2.142** ✅ `68ca32fa9`+`a0a5ca4da` | Its own *correction* of an earlier undercount: "**THREE callers read this list, not two**" (`claude-bash-rule.ts:1624`), sized as "the blast radius is three consumers wide and the next maintainer will size it from this sentence" | **Four.** The omitted one is an enforcement floor | `compoundKeywordBodies` (`:1639`) has one call site, `splitWithSubstitutions:1412`. Production entries to `splitWithSubstitutions`: `claude-bash-rule.ts:1351` (deny + ask), `:1861` (`matchClaudeBashIfRule`, the hook `if` filter), and **`removal-circuit-breaker.ts:797`** (`findShRemoval`). Fourth consumer verified by full chain, not by import alone: `pre-tool-use.ts:1025 findRootOrHomeRemoval(command)` → `removal-circuit-breaker.ts:1250` (exported) → `:1258 findShRemoval` → `:797 splitWithSubstitutions` → `claude-bash-rule.ts:1412 compoundKeywordBodies`. That is the live PreToolUse `nonNegotiable` removal floor. The `allow` boundary the sentence draws is correct (`:1349-1351` routes allow to `splitCompoundCommand`) — the miss is the circuit breaker, which `splitWithSubstitutions`' own docblock acknowledges 260 lines earlier at `:1365` but the sizing sentence does not count. | **undercount (3→4)** |
| X-5 | **P2.118** ✅ `42ebdc062` | "the central constant `UNRESOLVABLE_OPERAND_METACHAR` has **exactly 2 call sites in the whole repo**" — cited as why changing the instrument "is an owner call rather than an implementer's" | **Three at HEAD.** True when written | `.test(` call sites at `42ebdc062` = **2**; at survey SHA = **3**. The third is `bash-validator.ts:1759` in `wordMetacharactersAreLiteral`, added by **`64c6a8391`** ("a quoted regex is not a glob"). Live consequence rather than history: the number bounds the still-**open** P2.207/P2.208 escalation. | **stale (2→3)** |
| X-6 | **P2.6** ✅ (wave-2 note) | "the reviewer audited **all 60 map keys** — `uniq` is the ONLY output-positional command and `sed` the ONLY unguarded script-carrier" — the sentence that made wave 3 "terminal on this axis" | **The map was BORN at 63 keys, in the audited commit itself** | `PROVEN_READ_FLAGS` (`bash-validator.ts:1325-1414`) extracted at four refs: `08f2ea3b5^` = **0 — the map does not exist**; `08f2ea3b5` (wave 2, which introduces it) = **63**; `e9a898e9e` = 63; survey SHA = 63. Key set byte-identical across the three non-zero refs (`comm` difference empty). So this is not later drift and not an ambiguity about which map: the denominator was misstated by three the moment it was written. The bound may still hold — but it is unproven for three keys, and this sentence is the stated authority for a terminality claim. | **undercount (60→63)** |
| X-7 | **P2.198** ✅ `32b2402b3` | "four production sites, **two behind `assertStorageId` on the line above**, **two inside `buildCapabilityResolutionInputsV2`**"; anchors `storage-runtime.ts:975` and `:1144` | Count right, composition different, both anchors drifted | Four *direct* production call sites: `management-service-v2.ts:467`, `:501`, `plugin-settings.ts:215`, `storage-runtime.ts:1180`. The row's four are a **different set** — it counts `storage-runtime.ts:975` (an *indirect* reach via `readPluginOptionEnvironment`) and never names `plugin-settings.ts:215` as a site. Anchors: `:975`→**`:1011`**, `:1144`→**`:1180`**. Substance holds: `readPluginOptionEnvironment` has exactly one production caller (`storage-runtime.ts:1011`), inside the funnel (`:667`–`:1193`). Sub-claim "`SessionManager`'s **five** context literals" — exactly five (`:5446, :5529, :5702, :9542, :21345`). **Residual:** `readPluginOptionEnvironment` is exported from `plugins/index.ts:35`, so "only caller" is an in-repo fact. | **confirmed, anchors drifted** |
| X-9 | **P2.333** ⬜ | `BaseAgent.destroy()` throws synchronously on a bad host sink; "**Pi is immune; Codex and Nestor are not**" — "two of three runtimes" | **Three of four production backends are exposed. `ClaudeAgent` is exposed and the row does not name it.** | Both anchors exact (`usage-tracker.ts:287-289`, `base-agent.ts:3361-3365`) and the synchronous chain confirmed end to end with no `try` on it (`destroy():3361` → `:3365 usageTracker.reset()` → `usage-tracker.ts:269 debug()` → `:288 config.onDebug?.()` → `base-agent.ts:2252` → host sink at `SessionManager.ts:16265-16288`). Four classes extend `BaseAgent`: `pi-agent.ts:9757` does **not** chain `super.destroy()` and overrides `debug()` with a try/catch (`:10167-10173`) — immune twice; `codex-agent.ts:3893`, `nestor-cloud-agent.ts:402` **and `claude-agent.ts:5758`** all chain and none overrides `debug()`. `ClaudeAgent.destroy()` clears three callbacks at `:5740-5742` but not `onDebug`. Likely origin of the row's two-name set: `pi-agent.ts:9763-9769`'s comment, which is about `endLifecycle` rejections and excludes Claude by scope. Caller impact real: `SessionManager.ts:19390` and `:23865` call `agent.destroy()` in a bare `finally` with no enclosing catch. Also understated within the method — `:3362 stopConfigWatcher()` and the unconditional `:3385 debug(...)` are the same unguarded shape. | **undercount (2→3 exposed)** |
| X-10 | **P2.336** ⬜ | Its **central point**: "**The reason for that join lives in a THIRD file**", so a tidy-up "silently reopens a permission bug", and "**nothing at either site would stop it**". Remediation asked for: "state the dependency **at the join**, and pin it with a test that fails if the separator changes" | **Both already shipped.** The reason is stated **at the join, in the same file**, and a test already pins the separator against the real `globMatches` | `hook-env-file.ts:133-143` — the docstring on the very constant a tidy-up would edit names the mechanism, the third file, and the measurement: *"joined with `;` rather than a newline … `globMatches` compiles `*` to `.*`, which does NOT cross a newline … `;` keeps those globs matching."* And `packages/shared/src/agent/__tests__/hook-env-file-channel.test.ts:333-350` asserts `expect(line).not.toContain('\n')` **and** `expect(globMatches('*docker*', line)).toBe(true)`. Parts (a) and (b) confirmed: `sandbox-settings.ts:1288-1292` still lacks the `s` flag that P2.329 added at three siblings (`claude-bash-rule.ts:1259`, `claude-powershell-rule.ts:305`, `permission-dsl.ts:612`); `hook-env-file.ts:156-157`/`:296` is the `;` join. **What survives the row is only (a)** — the missing `s` — which the row itself defers as an owner call. | **premise refuted (central point)** |
| X-11 | **P2.293** ⬜ | Reachability: "`config.json` **is bootstrapped at workspace creation** and a session cannot precede a workspace"; and the shape is "a switch reported success while changing nothing" | Conclusion survives, **stated mechanism is wrong on both halves** | `config.json` is not written at workspace creation: it is written by the storage-layout installer at boot — `workspaces/storage-readiness.ts:287-292`, reached from `ensureStorageLayoutV2` `:439-466`; a root without it is `'unmarked'` (`:160-161`) and boot reinstalls or blocks. And the ordering **is** enforced, contradicting "rests on an ordering nobody enforces": `server-core/src/bootstrap/headless-start.ts:498-504` `ensureGlobalConfigExists` throws `HeadlessStorageReadinessError('corrupt-v2')` when `loadStoredConfig()` is null, called unconditionally at `:621`. Unnamed reachable window: the check is **boot-time only and never re-checked**, so deleting `~/.nessy/config.json` while the app runs reaches the no-op. Framing correction: the user does **not** see success — `describeAdvisor` sets at `base-agent.ts:4806` and re-reads at `:4808`, and `getAdvisorEnabled()` falls to the bundled default `false`, so `/advisor on` answers "off". A visibly wrong answer, not a silent success. | **premise refuted (mechanism)** |
| X-8 | **P2.133** ✅ `e0a64da64` | `managedDisableAllHooks` is "**dead on every provider** … no production caller at all", cited at `runtime-automations.ts:125` | Absence confirmed; anchor drifted | Only hits: declaration `runtime-automations.ts:131`, self-reads `:157`/`:159`, tests, and one comment (`claude-managed-settings.ts:341`). **No production caller passes it.** Positive control on the same rig: `claudeManagedPolicyUnenforcedKeys` → hits in 2 files. Anchor `:125`→`:131`/`:157`. | **confirmed, anchor drifted** |

| X-12 | **P2.196** ✅ `5231cefb2` | "Sweep of **699 files → 17 call sites → 15 blank**" | **Stale (17→19), and 17 was never exact even at its own commit** | The sweep's definition is its own test (`packages/server/src/__tests__/headless-i18n.test.ts:45-93`: roots `packages/shared/src` + `packages/server-core/src`, `.ts`, counting *lines* containing `i18n.t(`). Re-implemented exactly: at `5231cefb2` → `699 files / 17`, **reproducing the row**; at survey SHA → **701 files / 19**, the two added by `fecfe1d7c` (`base-agent.ts:4273`) and `33901a82b` (`:4788`). Reading the sites moves it both ways: `thinking-levels.ts:125` is a **JSDoc line**, not a call site, and `handlers/rpc/auth.ts:23`/`:39` each carry **two** invocations the line-based instrument counts once. True invocations: **18 across 16 lines** at the row's commit, **20 across 18 lines** at the survey SHA. "15 blank" arithmetic and "never calls `setupI18n()`" both **confirmed** (positive control: `git grep -c bootstrapServer` on the same file/ref → 2). Unclaimed adjacent surface: four `i18n.resolvedLanguage` reads (`SessionManager.ts:19319`, `:23812`; `config/preferences.ts:140`, `:211`) also degrade on an uninitialized singleton. | **stale (17→19) + never exact** |
| X-13 | **P2.202** ✅ `6f51646d2` | "a fifth instance … at **`pi-harness/runtime-agent-definition.ts:629`** in `parseTools`"; "at **TWO sites**, and the one the row named runs **SECOND**" | Substance confirmed; the anchor was wrong when written and is wronger now | Two sites confirmed: producer `runtime-agent-definition.ts:1311-1313` (`...(tools && tools.length > 0 ? …)`) and wire parse `parseTools` collapsing at **`:635`**. Ordering confirmed by reading the production path — `materializePiRuntimeAgentDefinitions` builds at `:1062`, parses at `:1082`; the named site runs second. "Worse than inert" mechanism confirmed at `:886-889` (digest mismatch drops the definition whole). **No third site on this path.** **Anchor:** `:629` is a *comment line inside* `parseTools` at the row's own commit — it should have been `:635`; at the survey SHA `:629` lands in a different function's doc comment and `parseTools` has moved to `:662-674`. Unchased possible family member outside the row's scope: `plugins/format-adapters.ts:1161`. | **confirmed, anchor wrong at birth** |
| X-14 | **P2.230** ⬜ | "**P2.36's crash fixture** carries `input_tokens: 10, output_tokens: 2`, so the case titled *'a zeroed crash result…'*  has never once exercised a zeroed `usage`" — framed as **one** fixture, one case | Confirmed, and **understated: two fixtures, three cases** | Fixture confirmed at `claude-event-adapter.test.ts:638-650`; `...overrides` spreads *after* `usage`, so the crash override (which carries no `usage` key) leaves 10/2 intact and only `total_cost_usd` is zeroed. The row names the P2.36 case at `:810`. **Also mismatched:** `:688` (same title stem, same fixture, under the **P2.35** banner) and a **second helper** `usageResult` (`:898-913`) hard-coding the same 10/2, whose case `:1023` quotes `sdk.d.ts:4367` *"crash/startup-error results may carry zeroed usage"* while the block is 10/2. So the fix is two fixture lines (`:647`, `:910`) across three cases. Control: `emptySnapshot` (`:277`) is genuinely zeroed — no false positive. | **understated (1→2 fixtures, 3 cases)** |

### Rows re-measured with **no** correction

| Row | Claim | Measured |
| :-- | :-- | :-- |
| **P2.169** ✅ | "`view.commands` has exactly **three readers** — `enabledPluginBundleRoots`, `intersectAgentRuntimeView`, `harness-manifest.ts`" | **Exactly three**, and this needed the full enumeration to establish: the three are spelled *differently* (`view.commands`, `current.commands`/`ceiling.commands`, `input.view.commands`), so a `view.commands` grep finds only 2 of 3. Enumerated all **66** non-test `.commands` reads repo-wide and classified each: `data-paths.ts:284`, `child-session-port.ts:308`, `harness-manifest.ts:449`; all 63 others are unrelated properties (AST nodes, `nessyExtensions`, `tool.commands`, `editor.commands`, i18n keys). **Confirmed.** |
| **P2.166** ✅ `20146b0e0` | "still **13 call sites** of `disposeManagedAgentRuntime`, still **11 reachable** by a live watch, the two exceptions the idle-agent reaper and the live-agent ceiling"; "**auth retry is TWO of the eleven**" | **Exactly 13** `this.disposeManagedAgentRuntime(` call sites in `SessionManager.ts` (`:9523, :11786, :11962, :11998, :12486, :12532, :14878, :14902, :15197, :15258, :16226, :16238, :22620`). The two exceptions are `:15197` (idle-agent reaper) and `:15258` (live-agent ceiling) → 11. Auth retry has two arms at `:22618` (`strictDrainPiSession`) and `:22620` (`disposeManagedAgentRuntime`). **Confirmed.** Minor imprecision worth noting, not a correction: only one of the two arms is a `disposeManagedAgentRuntime` site, so "two of the eleven" reads as two of that set when it means two arms of one path. |
| **P2.305** ⬜ | `macosSeatbeltBashSandboxEnabled` has "**two production readers**" (offered as proof the inert-spec entry calling it dead is wrong) | Production callers of `getMacosSeatbeltBashSandboxEnabled`: `claude-agent.ts:3115` and `pi-agent.ts:5389` — **exactly two**. `setMacosSeatbeltBashSandboxEnabled` has none. **Confirmed.** |
| **P2.288** ⬜ | "an `ifRule` is validated at **none of its four registration sites**" | **Exactly four** sites write an `ifRule` into a record: `format-adapters/claude.ts:1477`+`:1488`, `plugins/schema.ts:802`, `capabilities/runtime-automations.ts:339`, `capabilities/resolver.ts:1470`. **None validates:** no rule parser (`parseClaudeRuleString` / `evaluateClaudeHookIfFilter` / `matchClaudeBashIfRule`) is called in any of the four files — 0 hits each. `runtime-automations.ts:308` gates on the *event*, not the rule. The only parse is at evaluation, `claude-permission-rules.ts:256`. Positive control: `parseClaudeRuleString` returns hits in `prerequisite-manager.ts:416` and `permissions-config.ts:547` on the same rig. **Confirmed, both halves.** |

| **P2.276** ⬜ | needs "a `permissionDslDiagnostics` carrier on `MergedPermissionsConfig` (one line), a consumer in `SessionManager.ts` (**~4649**, beside the existing `security.filesystemScope.configDiagnostics`)" | `permissionDslDiagnostics` → **0 hits** repo-wide, so the carrier genuinely does not exist (positive control: `configDiagnostics` returns hits on the same rig). The sibling it must sit beside is at **`:4745`**, not `:4649` — **anchor drifted ~96 lines**, substance intact. **Confirmed.** |
| **P2.313** ⬜ `[doc:claude]` | Mechanism: "the mechanism is **one line** — `options.ts` spreads `process.env` into the SDK subprocess, which is exactly what Pi does not do" | `packages/shared/src/agent/options.ts:245` is `...process.env,` — one spread, exactly as stated, with a docblock at `:312` explaining it. Repo-wide there are 10 non-test `...process.env` sites in 8 files; the only one under `packages/pi-agent-server` is `scripts/smoke-orchestrator.ts`, a script rather than the production spawn path, so the contrast holds. **Mechanism confirmed.** Its headline numbers (105 of 216 settings keys, 279 of 361 env vars, 14 spot-verified in the binary) are P5.1 binary-probe measurements; I did **not** re-derive them and do not vouch for them. |

### Rows triaged and deliberately NOT re-measured, with the reason

- **P2.152, P2.167, P2.173** — gate tallies and private-detector funnels (see §2.1). **Unverifiable
  by construction**; re-running them is not this row's job and padding the table with them would
  have been worth nothing.
- **P2.150** — its numbers ("30 values × 37 files, 19 changed — 11 same, 9 wider, 5 narrower,
  5 disjoint") are a differential-harness tally, same class. Internally consistent (11+9+5+5 = 30).
- **P2.127** — "TWENTY-TWO pattern classes reach that throw, nine predicates across seven matcher
  kinds": re-deriving needs the enumeration table that lives in the lane's report, not in the tree.
  **Not measured; not assumed correct either.**

---

## 4. What I would put in front of the owner

1. **X-2 (P2.249) is the one that matters most, and it is a live fail-open.** A packaged app runs
   `inferPackagedMode() === false` forever, so the packaged-mode validation of the uv / node / bun
   runtime command is skipped and the dev-only PATH fallback becomes reachable. The row that
   flagged it asked for "the measurement, not the fix" and guessed the defect was a *window*
   between two writes; measured, it is permanent, and on a different reader than the row names.
   The tests cannot catch it — they pass `isPackaged` explicitly, which is the exact
   "test double drops the argument under test" blind spot in the lane rules.

   **What the skipped guard actually enforces**, `resolve-script-runtime.ts:129-148`: that an
   env-supplied runtime is an absolute/bundled path — its own message says *"Packaged builds do
   not allow PATH-based runtime resolution"* — and that the path exists. **And the bad case needs
   no attacker.** `apps/electron/src/main/index.ts:125` sets `const fallbackUv = bundledUvExists
   ? null : 'uv'` and `:132` writes that into `NESSY_UV`. So a packaged build that shipped without
   its bundled `uv` puts the **bare string `'uv'`** in the env var, and with the guard inert it is
   returned as the command and resolved through `PATH` at execution — precisely the outcome the
   guard's error text exists to refuse. A packaging defect alone is sufficient to reach it.

2. **X-1 (P2.293) is 1-of-30, and five of the thirty are security-relevant.** Same shape as the
   1-of-11 and 1-of-22 the brief cites. `setAllowRemoteEvaluate`, `setBypassPermissionsAcknowledged`
   and `setMacosSeatbeltBashSandboxEnabled` all silently no-op with no `config.json`.
   **P2.293 is wrong twice over and in opposite directions** — X-1 says its scope is thirty times
   larger, X-11 says its stated reachability mechanism is wrong on both halves and its
   "reported success" framing is wrong too. The row's *conclusion* (not live today) survives both.

3. **Two rows would have dispatched work that is already done or aimed at the wrong line.**
   X-10: P2.336's central point — "the reason lives in a THIRD file … nothing at either site would
   stop it" — is false; the reason is in the docstring on the constant itself and a test already
   pins the separator against the real `globMatches`. Only its deferred `s`-flag half survives.
   X-13: P2.202's `:629` anchor pointed at a comment line **at the row's own commit**, and now
   points into a different function. Both are cheap to fix and expensive to dispatch blind.

4. **X-4 is the finding that should most affect how this plan closes.** P2.142 already *was* a
   correction — a lane found a docblock claiming two consumers when there were three, fixed the
   sentence, and wrote "the next maintainer will size it from this sentence". That corrected
   sentence is still a subset. A correction is not self-certifying, and the fourth consumer is the
   `nonNegotiable` removal floor.

5. **X-5 and X-6 both bound work that is still open or still cited as terminal.** P2.118's "exactly
   2 call sites" is 3 and bounds open P2.207/P2.208; P2.6's "all 60 map keys" was 63 at the audit.

6. **The instrument advice from the previous survey needs one amendment before close-out.** Its
   remedy — "sweep with `git grep`" — is right, but `git grep` has its own silent-empty mode
   (§1a): a globbed pathspec returns zero with exit 0, and a `**/*.ts` pathspec undercounts. Use
   literal directory pathspecs and filter afterwards.

---

## 5. Where I stopped

**Triaged 411 rows / 216 flagged as carrying a count or absence claim / 19 re-measured in depth /
14 carried a correction.**

The nineteen: P2.6, P2.118, P2.133, P2.142, P2.166, P2.169, P2.196, P2.198, P2.202, P2.230,
P2.249, P2.276, P2.288, P2.293, P2.305, P2.313, P2.319, P2.333, P2.336.

Not reached, named so the next pass starts there rather than re-triaging:

- **From the previous survey's §5 list.** Measured: P2.198, P2.118, P2.169, P2.166, P2.142,
  P2.133, P2.196, P2.202. Reclassified as gate tallies / private-detector funnels and
  **deliberately not measured**: P2.152, P2.167, P2.173, P2.150. **Still genuinely unmeasured:
  P2.209** ("eleven latent errors"; "16 errors across 6 files" → open P2.218) and **P2.127**
  ("twenty-two pattern classes, nine predicates across seven matcher kinds").
- **36 of the 46 open rows carrying a count or absence claim.** Measured: P2.230, P2.249, P2.276,
  P2.288, P2.293, P2.305, P2.313, P2.319, P2.333, P2.336. Triaged-but-not-measured: P2.224,
  P2.227, P2.262. **Untouched:** P2.47, P2.53, P2.56, P2.83, P2.147, P2.175, P2.188, P2.189,
  P2.216, P2.217, P2.218, P2.220, P2.229, P2.235, P2.239, P2.240, P2.241, P2.244, P2.246,
  P2.263, P2.264, P2.269, P2.291, P2.295, P2.318, P2.322, P2.338, P2.341, P2.342, P3.21,
  P5.3, P5.4.
- **159 of the 170 closed rows carrying a count or absence claim.**

**Two loose ends I opened and did not close**, so they are not lost:
- `plugins/format-adapters.ts:1161` — `source.tools?.length ? … : …` collapses a manifest-declared
  `tools: []` on the legacy path. Possibly a further member of the empty-means-absent family;
  **different producer, not chased** (surfaced under X-13).
- Four `i18n.resolvedLanguage` reads on the headless path (`SessionManager.ts:19319`, `:23812`;
  `config/preferences.ts:140`, `:211`) degrade on an uninitialized singleton. Outside P2.196's
  claim, never examined by anyone (surfaced under X-12). **Kind: never-looked-at.**

**Honest boundary.** 14 corrections in 19 rows, against the previous survey's 8 in 25. Combined,
the two surveys have re-measured **44 of 216** flagged rows — **20%** — and the base rate has
*risen* rather than fallen across that sample. Nothing in this report licenses a completeness
claim about the tracker's site counts; section 3 is a floor. The single most important number
here is not any of the corrections but the denominator: **four fifths of the flagged claims on
this plan have still never been checked by anyone**, and the two rows the previous survey singled
out as most likely wrong (P2.198, P2.118) both turned out to carry a defect — one stale count
bounding two open rows, one anchor set that had drifted.

## 5a. Time-sensitive note on X-9 — flagging, not claiming

At the end of this survey `git status` showed a lane holding, uncommitted:
`agent/core/usage-tracker.ts`, `agent/base-agent.ts`, `agent/codex-agent.ts`,
`agent/nestor-cloud-agent.ts`, `agent/pi-agent.ts`, plus
`__tests__/fixtures/floating-emission-probe.ts`.

That is **exactly the file set X-9 (P2.333) concerns — and `claude-agent.ts` is not in it.**
I have not read that lane's diff and make no claim about its intent. But if it is the P2.333 fix,
it is landing on the three backends the row named and **not** on `ClaudeAgent`, which X-9 measured
as the fourth exposed one (`claude-agent.ts:5758` chains `super.destroy()`, no `debug()` override,
`onDebug` not cleared at `:5740-5742`). **Worth putting in front of that lane before it commits**,
because the resulting row would read as closed while one of the three exposed backends still is.

## 6. Gate

Read-only survey; no source file changed, so no test/typecheck/lint gate applies to a diff.

- `bun test` — **NOT-RUN.** No code changed; running it would prove nothing about this row and
  would take the shared mutex from lanes that need it.
- typecheck / eslint / `git diff --check` — **NOT-RUN**, same reason. `git status --porcelain`
  confirms I created no file inside the repo (my working files are all under `<scratchpad>/sdd2/x6/`).
- The measurement instrument itself **was** gated, and that is the gate that matters here: positive
  control (§1), negative control (§1), cross-instrument comparison on every absence claim, and one
  instrument defect found and pinned (§1a) plus one of my own (§1b).
