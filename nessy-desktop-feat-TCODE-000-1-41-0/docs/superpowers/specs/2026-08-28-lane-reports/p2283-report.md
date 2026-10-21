# P2.283 — report

**Status:** CLOSED. **Commit:** `c6bcdf7e4` (branch `feat/TCODE-000`, 4 files, +221/−27).
**Base SHA recorded before starting:** `f58f66a36f6314384fef1d4c535f7772dd0ca84b`.

---

## The site list — proved and unproved, first, because that is the row

The experiment the row asked for: on an isolated **clone** at `f58f66a36`, add a member
(`'probe-runtime'`) to `ModelProvider` (= `AgentProvider`, `types.ts:205`) and read the
compiler. Baseline before the probe: `packages/shared`, `packages/server-core` and
`apps/electron` all exit 0 with **zero** error lines.

### Sites where I PROVED adding a runtime breaks the build

| # | Site | Evidence (error coordinates, probe run) |
|---|---|---|
| 1 | `agent/backend/runtime-vocabulary.ts` `AGENT_PROVIDER_VOCABULARY` | `:68,12` TS1360 |
| 2 | `agent/backend/composer-capabilities.ts` `PROVIDER_DEFAULTS` | `:47,14` TS2741 + `:171,9` TS2322 (exhaustive switch) |
| 3 | `agent/backend/factory.ts` (the "~15 dispatch sites") | **9 errors**: `:81 :97 :223 :320 :562 :807 :1035 :1071 :1294` |
| 4 | `server-core/src/sessions/runtime-switch.ts` `NATIVE_HISTORY_CARRY_IMPLEMENTED` | `:241,7` TS2741 — the exact line the P2.124 row named |
| 5 | `renderer/.../runtime-switch-costs.ts` rows | `:137,7` TS2322 |
| 6 | **`agent/runtime-agent-support.ts` — AFTER this commit** | `:87,14` TS2741 (`AGENT_DEFINITION_DISPATCH`), `:163,14` TS2741 (`PLUGIN_PERIPHERAL_SUPPORT`) |
| 7 | **`sessions/runtime-anchors.ts` — AFTER this commit** | `:59,14` TS2741 (`RUNTIME_ANCHOR_SUPPORT`) |

Two sites break that the P2.124 row never named, found by the same probe:

| # | Site | Evidence |
|---|---|---|
| 8 | `agent/backend/internal/driver-types.ts` `getDefaultProviderType` | `:125,66` TS2366 |
| 9 | `server-core/src/sessions/SessionManager.ts` | `:4527,7` and `:9920,5` TS2322 |

### The site I could NOT make break — and it is a correction to the survey

**`packages/shared/src/feature-flags.ts` — 0 errors, and no repair is available at that
file.** It holds no `ModelProvider`-keyed structure at all. Its per-runtime decision is
`resolveProviderFlags(): Record<ProviderFlagId, boolean>` over a **different union** —
build-flag ids (`nessy_cloud`, `claude`, `chatgpt`, …), not runtimes — and the provider
names appear in it only inside prose and flag names (`/usr/bin/grep -an` over the file:
five hits, all comments). Adding a runtime cannot break it and *should* not: a runtime is
not a build flag.

The `ModelProvider`-keyed gate that feature-flags feeds **does** break —
`factory.ts:320 PROVIDER_BUILD_GATES: Record<AgentProvider, () => boolean>`, which is where
the totality belongs and where it already is.

So P2.274's **"5 of 7"** is right if `factory.ts:320` stands in for `feature-flags.ts`, and
is **4 of 7** if you require the file the row named to break. Either reading, the two files
this row is about were the real gap, and they were the whole gap.

### The absence claim, with its positive control

`/usr/bin/grep -ac -E 'runtime-agent-support|runtime-anchors'` over the three probe-run
typecheck logs (shared / server-core / electron) returns **0, 0, 0**. The same grep over the
post-fix probe run returns **3**. So the zero is a measured zero, not a wrong needle.
Neither zone file carries a NUL byte (byte-scanned, `tr/\0//` count = 0), so a text search
over them is honest here.

---

## Premise: confirmed exactly as written

The row said the property holds at 5 of 7 named sites and that
`runtime-agent-support.ts` / `runtime-anchors.ts` are hand-maintained lists no plan commit
ever touched. Confirmed by measurement, not by reading: `ReadonlySet<AgentProvider>` and
`readonly AgentProvider[]` accept **any subset**, so the fifth runtime compiled clean at
both and was silently

- **denied agent definitions** (`AGENT_DEFINITION_RUNTIMES`),
- **denied plugin peripherals** (`PLUGIN_PERIPHERAL_RUNTIMES`),
- **left unanchored** (`ANCHORED_PROVIDERS`),

three defaults, no build error, no diagnostic. Three sites, not two — the first file holds
two of them.

## The fix

Each list becomes `Record<AgentProvider, boolean>`, with the reason for every arm **on the
value line** (the brief's warning: prose kept in a separate paragraph drifts from the list
it describes). A missing arm is a type error; an invented one is an excess-property error.
The exported `Set` / array is **derived from the record**, so every reader's `.has()` /
`includes` semantics — including what an off-disk string that is in no union gets — are
unchanged. `isAnchored` reads the record and answers `false` for a missing key exactly as
`.includes()` did.

New exports: `AGENT_DEFINITION_DISPATCH`, `PLUGIN_PERIPHERAL_SUPPORT`,
`RUNTIME_ANCHOR_SUPPORT`, and `ANCHORED_PROVIDERS` (derived; exported because eight
docblocks across `server-core`, `pi-agent-server` and `scripts/cdp` cite it by name and
restate its contents in prose).

### The drift test's exemption paragraph was the bug, and it is gone

`runtime-capability-drift.test.ts` explicitly exempted these three sites: *"the sites that
are still SET-shaped … are reported as row text rather than converted here … flipping a
`Set` to a `Record` changes what an unknown runtime gets."* That sentence is how P2.124
closed claiming a TOTAL property with three of its own sites outside it. Its justification
is also **false for a derived Set** — measured, an unknown runtime gets the same answer.
All three are now in `RECORD_SITES`.

## Re-break — both halves, against the recorded base SHA, never `HEAD~1`

Both mutations were applied **in the clone**, so no other lane saw them.

1. **Re-transcribe `ANCHORED_PROVIDERS`** as `['pi','anthropic','codex-runtime']` so it
   drifts from its record → **2 fail / 39 pass**, and the two failures are exactly the two
   new tests. The pre-existing *"never records or adopts an anchor for codex-runtime"* test
   **still passes** under this mutation, because `isAnchored` reads the record — i.e. the
   new tests catch a drift no existing test caught.
2. **Widen `AGENT_DEFINITION_DISPATCH` to `Partial<Record<…>>` and drop an arm** — the
   exact scenario `runtime-vocabulary.ts`'s docblock names as what the compiler cannot see
   → **2 fail / 30 pass**, with the message naming the site:
   `runtime-agent-support.ts AGENT_DEFINITION_DISPATCH leaves a runtime undecided`.

Plus the compiler half: with the fix in place, the same fifth runtime that produced **20**
errors and **none** in these files now produces **23**, three of them exactly here.

## Gates — with proof of work, not exit statuses

| Gate | Result |
|---|---|
| `bun-test-lock … -- bun test` (4 zone files) | `Ran 50 tests across 4 files. 49 pass, 1 todo, 0 fail, 158 expect() calls` |
| `bun-test-lock … -- bun test` (4 consumer files) | `Ran 169 tests across 4 files. 168 pass, 1 fail` — see flake below |
| re-run of that one file alone | `Ran 34 tests across 1 file. 34 pass, 0 fail` |
| `cd packages/shared && bun run tsc --noEmit` (shared tree) | exit 0, **0** `error TS` lines |
| `packages/server-core` tsc, `apps/electron` typecheck | exit 0, **0** errors each — run **in the clone**, with only my four files copied onto a clean `f58f66a36`, so six other live lanes cannot contaminate the result |
| `npx eslint` from `packages/shared` (not repo root) | exit 0; positive control via `-f json`: **4 files linted, errors=0 warnings=0 on each** |
| `git diff --check` | clean |
| Full repo suite | **NOT RUN** — the brief says no full repo suite. |

**The one failure, and why it is not mine.** `runtime-switch.test.ts >
gatewayDpCredentialsPresent > accepts a gateway card whose dp file holds a valid, unexpired
JWT` timed out at **14932ms against a 5000ms limit** in the 4-file batch. Re-run alone:
34 pass, 0 fail. That is the load-artefact profile the lane rules describe (real failures
under ~3.3 s, artefacts at 10 s+), it is a dp-credentials test with no path through my
change, and it is **not** in the known-failing register. Recorded below as a finding rather
than dismissed.

## Findings

1. **`feature-flags.ts` is not a totality site and cannot be made one** —
   `[doc:none]`, kind: **never-looked-at**. It keys on `ProviderFlagId`, a different union.
   The survey's "5 of 7" holds only if `factory.ts:320` stands in for it. Verdict: **not a
   gap** — the totality is already in the right place. Recorded so nobody re-derives it.
2. **Two sites break that P2.124 never named** — `[doc:none]`, kind: **never-looked-at**.
   `driver-types.ts:125` (`getDefaultProviderType`) and `SessionManager.ts:4527/:9920`.
   Both already break, so no work; they mean the "eleven sites" enumeration was a subset
   again, which is P2.274's whole thesis holding for a third time.
3. **The `LlmProviderType` axis is far thinner than the `AgentProvider` axis** —
   `[doc:none]`, kind: **never-looked-at**. Probed separately (`'probe-connection'`): only
   **4** errors, versus 20 on the narrower union — `runtime-vocabulary.ts:77`,
   `factory.ts:368` (`providerTypeToAgentProvider`), `factory.ts:831` (auth type),
   `llm-connections.ts:1050` (auth types). Verdict: **adequate, and deliberately so.**
   `factory.ts:368` is the funnel every wider-union value passes through to reach an
   `AgentProvider`, and it breaks — so an undescribed connection type cannot silently reach
   the narrow-axis sites. Worth a row only as a recorded verdict.
4. **`runtime-anchors.ts`'s codex rationale had decayed line numbers** — `[doc:none]`,
   kind: **bug** (documentation). It cited `codex-agent.ts:292` (mkdtempSync) and `:1066`
   (teardownRuntime delete); measured, those are `:1204` and `:3733`. **The mechanism is
   intact** — every substantive claim re-verified, including
   `/usr/bin/grep -ac sdkSessionId codex-agent.ts` = **0**. Fixed in the commit, and the
   `rg -ac` in the docblock replaced with `grep -a`: `rg` returns a silent zero on a
   NUL-carrying file, so the original evidence was recorded with the exact tool P2.274
   showed cannot support an absence claim. (`codex-agent.ts` happens to carry no NUL, so
   the claim was true — by luck, not by method.)
5. **Prose-vs-value check requested by the brief: no contradiction found.** Both files'
   docblocks matched their lists at HEAD (`pi/anthropic/codex-runtime` dispatching;
   "Pi alone" for peripherals; `pi/anthropic` anchored). The claims are now on the value
   lines so the two cannot separate.
6. **`runtime-switch.test.ts`'s dp-credentials test is timeout-fragile under load** —
   `[doc:none]`, kind: **bug**. 5000ms limit, 14.9 s under a 4-file batch, 26 s for the
   file alone. It will keep manufacturing failures for lanes that batch it. Outside my
   zone, so **reported, not touched**.

## Documentation classification

**Category (a) — our own implementation.** `AgentProvider`/`ModelProvider` is Nessy's own
runtime vocabulary; no Claude, Codex or Pi page governs which runtimes exist or which of
them anchor a conversation. No page consulted, and none should have been.

## Method notes

- Worked in a **clone** (`git clone --no-hardlinks --shared`, checkout `f58f66a36`,
  `bun install --frozen-lockfile`, 1332 packages), not a worktree — a worktree's symlinked
  `node_modules` resolves `@nessy-agent/*` back to the parent tree. Resolution proved inside
  the clone before trusting a number: `Bun.resolveSync('@nessy-agent/shared/agent/runtime-agent-support')`
  → the clone's own path. Editing `ModelProvider` in the shared tree would have broken six
  live lanes' typechecks; the clone is why that never happened.
- Clone deleted at the end; `git worktree list` shows no strays from this lane.
- Commit made by **explicit pathspec** and verified with `git show --stat --oneline HEAD`:
  exactly my four files, none of the four other files other lanes had dirty at the time.
