# Session-tool wire-name unification (Pi / Claude / Codex → `mcp__session__<RegistryId>`)

Status: DRAFT, OWNER-APPROVED 2026-08-15 to run NEXT — dispatches after the
runtime-icons/plates/model-sync plan (2026-08-14) closes and after the
planner's triple-check pass. Authored by the planner from workflow
`wf_b2d4c1bd-cb8` (3 agents: current-state map + blast-radius audit +
plan synthesis, all claims code-verified on HEAD). Full analysis:
`assets/2026-08-15-tool-naming-unification-analysis.json`.

## Premise correction (load-bearing — read first)

The originating question was «Pi шлёт голые имена, привести к виду Claude
SDK». **That premise is FALSE on HEAD (1.25.1).** Pi's model-facing name is
ALREADY `mcp__session__<descriptorId>` — minted at
`harness-tool-descriptor.ts:253-259` (`piName = 'mcp__session__' +
descriptorId`), installed at `tool-manifest.ts:388`. Bare names
(`source_manage`, `TodoWrite`) live only on Pi's PERMISSION/HOOK layer
(`permissionName`) and in the UI transcript after the prefix is stripped
(`tool-parsers.ts:433`). The real divergence is **three prefixed
spellings**, not bare-vs-prefixed:

| Runtime | Wire form | Example |
| --- | --- | --- |
| **Claude** (target — SDK mints it) | `mcp__session__<RegistryId verbatim>` | `mcp__session__TodoWrite` |
| **Pi** | `mcp__session__<snake_case descriptorId>` | `mcp__session__todo_write` |
| **Codex** | `mcp__nessy_session__<RegistryId>` (server segment differs) | `mcp__nessy_session__TodoWrite` |

~28 snake-named tools (`source_manage`, `config_validate`,
`transform_data`, …) are ALREADY identical across all three (descriptorId
== handlerName). Only ~22 CamelCase tools diverge on Pi (casing), and
Codex diverges on the server segment for ALL of them.

## Goal and non-goals

**Goal:** every SESSION tool carries a byte-identical model-facing wire
name across Pi, Claude, Codex, equal to the Claude Agent SDK form
`mcp__session__<RegistryId>` (`<RegistryId>` = canonical `SESSION_TOOL_DEFS`
id verbatim, `tool-defs.ts:1046-1170`). Claude is already at target. Two
edits reach parity: Pi stops snake-casing `piName`; Codex renames its
bundled MCP server config key `nessy_session` → `session`.

**Non-goals (explicit):**
- Integrations / plugins / dp / source-pool MCP names — already unified,
  DO NOT touch.
- Native SDK built-ins (Bash, Read, Edit, Grep, WebFetch, Agent…) — not
  session tools; their Pi bindings deliberately keep `piName ≠ bindingName`
  and the manifest union rule serves them — DO NOT touch.
- The permission/hook layer stays bare (rules match `permissionName`, never
  `piName`) — grammar unchanged.
- Pi-only tools (Task*/Goal*/Monitor/Cron*/…) get renamed as a free
  consequence of the one-function fix — acceptable, desirable (consistency).
- llm-proxy allowlist registration — downstream DEPENDENCY (§ below), not
  folded in.

## Approach (chosen: collapse Pi `piName` onto `bindingName` + rename Codex key)

Pi's `sessionBinding` (`harness-tool-descriptor.ts:253-259`): change
`piName` from `mcp__session__${descriptorId}` to
`mcp__session__${handlerName}`. `handlerName` is ALREADY the exact
Claude/Codex registry id for all 55 session tools (verified `:295-362`).
Low-risk because the internal registration key (`bindingName`, the
definition-lookup key at `tool-manifest.ts:287`) already uses the registry
spelling and is UNCHANGED; session tools carry NO static model-contract pin
(`PI_STATIC_MODEL_CONTRACT_HASHES:45-71` — verified no `mcp__session__*`),
and the per-session digest moves consistently on host+subprocess (same
registry) — no "manifest model contract mismatch" wall.

Codex: rename the literal `[mcp_servers.nessy_session]`
(`config-writer.ts:613`) → `[mcp_servers.session]`; the binary then mints
`mcp__session__<id>` (`event-adapter.ts:148` `mcpRowToolName =
mcp__${server}__${tool}`), and the UI prefix-strip fires for Codex too.

**Rejected:** (a) live dual-accept shim on the wire — over-built; the
permission layer never saw `piName`, and nothing on master mints the bare
form; old spellings arrive only via replayed disk history (handled by one
inbound map, not a standing shim — the "wildcard seatbelt" the
inert-worklist warns against). (c) a second projection layer leaving
internals snake — that IS today's divergence; doubles the mapping surface
for no parity.

## Tasks

### Verification corrections (pass 2026-08-15, applied — read before T1)

The pre-dispatch verification confirmed the premise and both mint sites
byte-exact, and proved EMPIRICALLY that the rewrite moves **0 of 20**
static pins. It also found nine things this plan had wrong; all are folded
into the tasks below. The load-bearing five:

- **F1 (HIGH) — T1 DOES have to regenerate two static pins, and my risk
  row said the opposite.** `runtime-backed-tools.ts:84` (`bash`'s
  `run_in_background` schema text) and `background-bash.ts:35`
  (`bash_background`'s promptSnippet) HARDCODE «Use
  `mcp__session__process_stop` to stop it» — model-visible text naming a
  tool that stops existing post-T1. Fixing that text changes two PINNED
  tools' projected text → their `PI_STATIC_MODEL_CONTRACT_HASHES` entries
  AND the fixture's embedded copies must be regenerated in the SAME
  commit. Also update the safety comment at `runtime-backed-tools.ts:63-69`
  («rewrite targets, never sources») — T1 is exactly what invalidates it.
- **F2 (HIGH) — the golden-test list below is ~⅓ of the surface.** Ten more
  files carry divergent snake literals, several failing by THROW (not
  string mismatch) because `getPiToolBinding(<old piName>)` no longer
  resolves: `orchestrator/runtime-agent-definitions.test.ts` (27 hits),
  `__tests__/harness-contract/fixtures/tool-surface.json` (26
  `finalPiName` rows) + `pi-harness-baseline.test.ts` (throws at :544,
  `toEqual(liveContracts)` at :523, and a `historicalNameMappings` block
  at :795-802 whose `currentName !== finalPiName` invariant T1 INVERTS —
  semantic rework, not a string flip), `worktree-approval-floor.test.ts`,
  `permission-dsl.test.ts`, `runtime-agent-definition.test.ts`,
  `monitor-bash-rules.test.ts`, `harness-tool-descriptor.test.ts`,
  `pi-agent-orchestration.test.ts`, `tool-wrapper.test.ts`,
  `lifecycle-bridge.test.ts`. T1's instruction is therefore RUN THE SWEEP
  and co-evolve every hit — the list is a starting point, not the set.
- **F3 (HIGH) — my DO-NOT-TOUCH note named the WRONG file and hid a real
  gap.** The alias table lives in `pi-harness/runtime-agent-definition.ts`
  (SINGULAR, never dirty); the file that was dirty is
  `orchestrator/runtime-agent-definitions.ts` (PLURAL, now clean and one
  T1 MUST edit per F2). And «already resolves all three forms» is FALSE
  for **7 divergent tools with no alias entry at all**: SubmitPlan,
  SlashCommand, BashOutput, ProcessStop, Task, Goal, GoalGet. The
  resolver's case-insensitive step bridges pure-case names
  (`monitor`/`task`/`goal`) but NEVER underscore-divergent ones — so
  post-T1 an agent's `tools:`/`disallowedTools:` entry written in today's
  advertised spelling silently stops resolving (allow→dropped, or worse, a
  deny that silently fails to deny). T1 EXTENDS the table with those 7
  keys (each carrying legacy snake + new Pascal prefixed forms) or the
  breakage is recorded as accepted — extending is the default.
- **F4 (MED-HIGH) — T3 cannot deliver its invariant from `tool-parsers.ts`
  alone.** MCP row display names come from `resolveToolDisplayMeta`
  (`SessionManager.ts:995+`), whose table is keyed `'session'` only, so old
  Codex rows keep missing labels/icons whatever the parser strips; and
  `normalizeToolCommandName` is UNEXPORTED and feeds only the command
  preview (test through `formatToolCommandPreview` or export it). T3 either
  adds the `nessy_session` alias in `resolveToolDisplayMeta` or narrows its
  invariant to the preview and says so. COORDINATE: the in-flight
  `2026-08-14-session-runtime-switching.md` audit rows 2 and 4 cover this
  same territory — do not double-fix.
- **F5 (MED) — the compat-map predicate leaks natives.** «descriptorId !==
  handlerName» also matches `notebook_edit`, `stop_task`,
  `mcp_tool_search`, `mcp_tool_load`, and a naive inversion would reverse
  the 2 NATIVE entries that must stay Pascal→snake. Correct predicate:
  `binding.bindingName.startsWith('mcp__session__') && descriptorId !==
  handlerName`; alias `mcp__session__${descriptorId} → binding.piName`;
  preserve `NotebookEdit`/`stopTask` verbatim.

Also folded in: **F6** Codex resume back-compat (a pre-T2 session resumed
post-T2 names `mcp__nessy_session__*` with no ingress map — record the
accepted risk or have T4 exercise one resumed session); **F7** T2 newly
activates the hard-coded `'session'`-segment consumers for Codex
(`pre-tool-use.ts:858` `BUILT_IN_MCP_SERVERS`, the display table) — desired
direction, but T4 asserts the Codex row's built-in classification and no
permission-prompt regression; **F8** gates widen to
`bun test packages/pi-agent-server packages/shared/src/agent` +
`typecheck:all`, and edited pi-agent-server TEST files need the
no-exclusion tsc pass (AGENTS.md trap); **F9** no working-tree collisions
today, and T4's version bump is computed from whatever is current at
dispatch. Minor drift: `PI_STATIC_MODEL_CONTRACT_HASHES` spans :32-68 (not
:45-71); the divergent count is 22 of 55 (so 33 already identical, not
«~28»); `browser-tool-names.ts:38` does NOT participate in Codex rendering
(no T3 edit); docs-site has no `nessy_session` (T4's docs step is a
verified no-op).

**T1 `fix(pi): session tools project under the registry-id spelling`** —
one-line `sessionBinding` change + INVERT & EXTEND the transcript compat
map (`pi-legacy-ingress.ts:5-13`, today Pascal→snake for only 5 tools) to
snake→Pascal over the FULL divergent set, derived PROGRAMMATICALLY from
`PI_TOOL_BINDINGS` where `descriptorId !== handlerName` (never
hand-maintained) + co-evolve the golden tests hardcoding snake piName
(`whole-tool-deny-manifest.test.ts:184`, `harness-manifest.test.ts:222`,
`tool-manifest.test.ts:384+`, `context-usage.categories.test.ts:82`,
`context-categories.suggestions.test.ts:48`, `pi-legacy-ingress.test.ts:15`,
and the rationale comment at `pi-runtime-protocol.test.ts:218-235` — rewrite
to cite a NATIVE example like `notebook_edit`, since the union rule still
serves native tools). DO NOT touch `runtime-agent-definition.ts` (already
dirty in the tree; its `PI_RUNTIME_AGENT_TOOL_ALIASES` already resolves all
three forms — serialize by file). NEW parity unit test: Pi `piName` ==
Claude SDK name for every cross-visible tool, computed from live registries.
Gate: `typecheck:all` + focused pi-agent-server/pi-harness suites.

**T2 `fix(codex): session MCP server key becomes 'session'`** —
`config-writer.ts:613` literal + its test (assert emitted TOML has exactly
one `[mcp_servers.session]`), comments at `codex-agent.ts:176`,
`event-adapter.ts:124-148`, `codex.ts:75`; codex golden strings
`mcp__nessy_session__…` → `mcp__session__…`. DO NOT touch
`server-core/src/webui/auth.ts:56` (`nessy_session` = unrelated HTTP cookie,
verified). Gate: codex-responses-adapter + codex-event-adapter suites.

**T3 `fix(ui): render legacy nessy_session transcript rows`** — add a
`mcp__nessy_session__` strip branch beside `mcp__session__` in
`tool-parsers.ts:433` so pre-T2 Codex sessions still render clean names.
Gate: ui tool-parsers tests + one row assertion.

**T4 `chore: live parity verification + close-out`** — new
`scripts/cdp/cases/session-tool-wire-parity.ts` on a PACKAGED build (dev
bundles don't exercise the Pi subprocess path), dark theme, anchor tool
`config_validate` or `transform_data` (snake, host-callback-free →
Codex-visible, no NESSY_ENABLE_TASKS gate): one real turn per runtime,
assert the model-facing wire name at the harness boundary is byte-identical
`mcp__session__<id>` on Pi+Claude+Codex, no `nessy_session` in the Codex
capture; checklist row near MCP-W2. Version bump (both package.jsons,
patch), release-notes, docs-site wire-name pages if they list
`nessy_session`; full regression at this wave boundary (`rm -rf release`
first).

## Backward compat (explicit)

Old on-disk sessions must render and resume. Pi `.pi-sessions/*.jsonl`
recorded snake `piName`; on resume `normalizePiSdkToolCallRecordsV1`
(`pi-legacy-ingress.ts`) normalizes them FORWARD to the new Pascal spelling
(T1's inverted+extended map) so a resumed session shows one consistent name
across turns — the single HARD seam, made SOFT. UI rendering is already
suffix-agnostic (strips the prefix, any suffix). NO on-disk rewrite —
read-time normalization only (append-only history contract preserved).

## Risks (repo-specific)

- Two prod bugs already came from upstream tool renames (AGENTS.md:
  `Task`→`Agent`; LSP `input.lsp`→`lspServers`) — same failure class. The
  guard is T1's live-registry parity test, not a hardcoded table.
- Manifest digest is not hand-written; session tools carry no static pin —
  do NOT add one; assert host+subprocess `modelContractHash` agree for a
  renamed tool.
- Permission rules / pre-tool-use classifiers are fed `permissionName`, not
  `piName` — insulated; but `grep -a` each divergent snake literal across
  `pre-tool-use.ts` (getter/setter-style miss risk); the name sets already
  list both forms (`ENTER_WORKTREE_TOOLS:877`).
- Guardian carries no session-tool-name literals (grep clean) — keep the
  negative honest with `-a`.
- NUL-byte files: `grep -a` for every absence claim.
- Packaged-build-only evidence for live parity; `rm -rf release` before any
  root `bun test` wave.
- UNVERIFIED, executor confirms in-task: the full set of Pi golden-test
  files with snake literals (`lifecycle-bridge.test.ts`,
  `pi-agent-orchestration.test.ts` named but not line-confirmed); whether
  `browser-tool-names.ts:38` participates in Codex rendering; any snapshot
  fixture embedding a session-tool `modelContractHash`.

## Relationship to the deferred llm-proxy allowlist registration

DEPENDENCY, not folded in. The proxy allowlist work needs ONE canonical
host-tool list to register. Today that would be three per-runtime spellings
(un-registrable as one set). After this plan,
`getToolDefsAsJsonSchema({prefix:'mcp__session__'})` yields ONE canonical
`mcp__session__*` list identical on all three runtimes — the single
registrable list the proxy plan consumes downstream. This plan is a
PRECONDITION for that registration; it does not implement the platform-side
call.

## Tracker

| Task | Status | Commit | Note |
| --- | --- | --- | --- |
| T1 Pi registry-id projection + compat map | ✅ | `2e4f1307f` | Sweep: 22 of 55 session bindings moved; 17 files carried divergent literals (10 failed by THROW on `getPiToolBinding`). F1 confirmed — `bash` + `bash_background` are the ONLY two pins that moved, regenerated with the fixture's copies; 0 other pins changed, measured by the pin loop. F3 closed by EXTENDING the alias table: 19 derived legacy-prefixed keys + 6 documented bare keys (`Task` excluded — the `task` key belongs to Claude's subagent tool, and the case-insensitive step already reaches the session Task). F5's predicate used verbatim. `historicalNameMappings` reworked to `persistedName`→`normalizedName` and asserted against the live ingress function. |
| T2 Codex server key → session | ✅ | `8a2affa8b` | One literal (`config-writer.ts` `[mcp_servers.nessy_session]` → `[mcp_servers.session]`) plus its test, the four comments (`config-writer.ts`, `codex-agent.ts`, `backend/codex/event-adapter.ts`, `backend/internal/drivers/codex.ts`) and the `codex-event-adapter.test.ts` golden. `server-core/src/webui/auth.ts:56` left alone as verified (unrelated HTTP cookie) — it and its own test are the only `nessy_session` left in the tree. The T1 parity test grew a Codex arm that reads the server segment out of the TOML the writer actually emits, so all three runtimes are now proven from live sources rather than two. F6 (ACCEPTED RISK, T4 to exercise): a Codex thread started before this and resumed after it carries `mcp__nessy_session__*` rows in its history with no ingress map — the model gets the new tool list from a freshly written config.toml so it calls the new names, but the old rows render raw until T3. F7 is live: `BUILT_IN_MCP_SERVERS = {'session'}` in `pre-tool-use.ts` and the `internalMcpServers` table in `SessionManager.ts` now match Codex rows too — before this, a Codex `mcp__nessy_session__*` call was neither built-in nor a known source and fell into the `source_activation_needed` branch. T4 asserts the classification and that no permission prompt regressed.
| T3 UI legacy nessy_session strip | ✅ | `c0b6f63fa` | BOTH halves of F4, because the coordination hazard it warned about is moot: the `2026-08-14-session-runtime-switching.md` plan it told me to check against is NOT in the tree (untracked at session start, gone now), so there is nothing to double-fix. (1) `tool-parsers.ts` `normalizeToolCommandName` now strips from a named prefix list (`mcp__session__`, `mcp__nessy_session__`, `mcp__workspace__`) and is EXPORTED, so the invariant is testable directly instead of only through `formatToolCommandPreview`. (2) `resolveToolDisplayMeta` (`SessionManager.ts`) aliases the `nessy_session` segment onto the same internal session-tool table, so a pre-T2 Codex row keeps its label and icon rather than missing the table, matching no source, and rendering bare. NOT touched, verified: `mcp-tool-name.ts` `stripMcpToolPrefix` is already generic over the server segment (row titles were never broken); `task-checklist.ts` `matchesTool` matches on `endsWith('__' + tool)` and is prefix-agnostic; `browser-tool-names.ts:38` is not in the Codex path and `browser_tool` is host-callback so it is not Codex-visible at all. No-widening control in both tests: `mcp__my_session__whoami` keeps its wire name and an unknown tool under the legacy segment still falls through.
| T4 live parity + close-out | ✅ | | **`WIRE-PARITY` PASS 20/20 on a PACKAGED `.app`** (`scripts/cdp/cases/session-tool-wire-parity.ts`, anchor `config_validate`, dark theme, one real turn per runtime). Byte-identical `mcp__session__config_validate` on all three, read from each runtime's OWN file: Pi `.pi-sessions/*.jsonl` (`toolCall` part), Claude `claude-config/projects/…/*.jsonl`, Codex the LIVE `CODEX_HOME` — snapshot-and-diff before/after the turn, which is how the arm `lib/runtime-session-log.ts` calls instrument-less got an instrument. Codex's emitted `config.toml` carries `[mcp_servers.session]` (T2's artifact) and its rollout the call. Transcript rows read `config_validate` on all three (Pi stores it bare, Claude and Codex store it whole). Zero `nessy_session` in any capture. **F7 answered directly**: the Codex row's `toolDisplayMeta.category = native` — reached only through the `internalMcpServers` table — the call ran (`completed`, 19 chars), and no source-activation prompt or denial occurred. **The one permission card is STRUCTURAL, not a regression**: `explore` emits `approval_policy = "on-request"` and the binary then asks for every MCP call; pre-T2 `nessy-codex-home-*` dirs still on the machine carry the identical policy, which is the positive control. Four rig corrections landed in the checklist — `loadShellEnv` makes the `/usr/sbin` recipe inert on a packaged build (so the run needs its own `NESSY_CONFIG_DIR`), the Claude SDK truncates its project-dir slug, Codex records an MCP call split into `name`+`namespace`, and that approval card. **F6 NOT exercised live** (no pre-T2 Codex session existed in the isolated config dir); it stays as T2 recorded it — an accepted risk whose read path T3's two tests cover, and the seven stale pre-T2 `CODEX_HOME`s found on this machine are field evidence the legacy spelling really is on disk. |

## Verification Log

1. Analysis self-verified by the synthesis agent against HEAD
   (`wf_b2d4c1bd-cb8`): premise correction, both mint sites, the 22/55
   split, the no-static-pin claim.
2. **Planner pre-dispatch verification 2026-08-15 — PASS with 9 findings,
   ALL applied** (see "Verification corrections" above). Anchor table:
   every load-bearing anchor OK except two minor drifts (the pin
   constant's line span; the "~28 identical" count) and one overstated
   claim (the alias table does NOT cover 7 divergent tools — F3).
   Empirical addition the pass contributed: a scratchpad probe replicating
   `live-manifest-contract.test.ts`'s definition assembly proved the
   rewrite moves **0 of 20** static pins — so the ONLY pin regeneration in
   T1 is the one F1 introduces (the two hardcoded
   `mcp__session__process_stop` mentions), not a wall of digest churn.
   Resolved the draft's three UNVERIFIED items: (a) the full literal sweep
   → 10 additional files + the baseline fixture; (b) `browser-tool-names`
   is not in the Codex path; (c) YES, `tool-surface.json` embeds
   `finalPiName` rows, verbatim pin copies and the historical-mappings
   model — hand/scripted regeneration is a T1 step.

**Status: DISPATCH-READY.** Executes as plan 2 of the owner's four-plan
queue, after `2026-08-14-runtime-icons-plates-model-sync.md` closes.
