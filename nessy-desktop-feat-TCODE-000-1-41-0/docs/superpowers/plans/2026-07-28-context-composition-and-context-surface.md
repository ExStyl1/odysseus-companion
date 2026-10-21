# Context-Window Composition and the /context Breakdown (R11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the total-only context accounting a per-category dimension (the seven documented categories), carry it over the wire, and surface it in the existing `/context` overlay together with the loaded-file list and the documented over-limit warnings.

**Architecture (verified 2026-07-28 at `bf326714`):**
- Producer side (Pi subprocess): `buildContextUsageSnapshot` (`packages/pi-agent-server/src/context-usage.ts:42`) fills `ContextUsageSnapshot` (`packages/core/src/types/message.ts:452-478`) — totals only, no category dimension. Emitted as `context_usage_update` (emit sites re-verified on HEAD after Task 0: `packages/pi-agent-server/src/index.ts:3371` manual compact, `:3480` update_runtime_config, `:3546` set_model; the polled `context_usage_result` reply is `:3321`).
- Composition inputs already exist as separate parts: `composePiHarnessPrompt` (`packages/shared/src/agent/pi-harness/prompt-composer.ts:15`), `buildStableContextParts`/`buildVolatileContextParts` (`packages/shared/src/agent/core/prompt-builder.ts:202/:150` — R4's size guideline lives at `:90/:223`), instruction/memory loads (`packages/shared/src/prompts/system.ts`, `memory-store.ts:65`), skill re-attach budget (`skill-reattach-budget.ts:3`, `estimateTokens`).
- Subagent provenance EXISTS on the descriptor (`runtime-agent-definition.ts:71`, field `:79`) but `buildPiRuntimeAgentDefinitions` (`packages/pi-agent-server/src/orchestrator/runtime-agent-definitions.ts:79`) DROPS it — the "custom subagents with the source each loaded from" category needs it carried through.
- Surface EXISTS (doc-verification § R11 is stale on this one point): renderer `/context` command (`slash-command-menu.tsx:174`, `slash-command-actions.ts:91`) opens the context overlay in `ChatDisplay.tsx:2448` (drifted from `:2432` by Task 0's consent-card edits), which renders totals + a tokenUsage-derived row set (`buildContextBreakdownRows`, defined `:196`, called `:2465`: optional system/tools/history/files rows off `tokenUsage` fields Pi never populates, plus an `unattributed` remainder — so a Pi session shows one unattributed row equal to the total). The work is extending this overlay, not building a new surface.

**Contract source:** `code.claude.com/docs/en/` — `debug-your-config.md` (the seven categories), `commands.md` (`/context [all]` behavior), `context-window.md`, `memory.md` (loaded-file list as the verification step), `errors.md` (exact over-limit strings), `prompt-caching.md` (three-layer cache ordering). Distilled in `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R11 — **READ IT FIRST** (corrected entry + newFacts).

## Global Constraints

- One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits; do not touch `docs/superpowers/specs/` (you may edit this plan file); Implementation-First Verification Budget.
- The recurring defect of this series is now TEN instances: two parallel paths, tests green on the one production does not use. The producer runs in the **Pi subprocess**, the snapshot travels a **wire event**, the surface is the **renderer overlay**. Assert each layer through its production seam — a category breakdown that a unit computes but `context_usage_update` never carries is exactly this defect. The last two instances (R4): a schema key declared in the type but absent from the strict envelope; a consent contract tested above the layer production routes through.
- **The breakdown is an accounting, not a new prompt path.** Measure the same strings production sends (the composed parts), do not re-compose them a second way for measurement — a drift between measured and sent is a silent lie in the UI. Reuse `estimateTokens` (the skill-budget estimator) for consistency.
- Wire compatibility: `categories`/`loadedFiles` are OPTIONAL on `ContextUsageSnapshot`. An old subprocess emitting no categories must render exactly today's overlay (totals only). No schema-version bump.
- Cache discipline: category accounting must not disturb the three-layer ordering (system prompt → project context → conversation) and must not add per-turn re-composition of stable parts (`prompt-builder` comment at `buildVolatileContextParts` — call once per turn).
- Renderer strings are i18n'd in ALL locales (`en.json`, `ru.json`), parity+sorted green. The two over-limit warning strings follow `errors.md` shapes, including the `/clear` variant when compaction is disabled.
- §4 deliberate-difference note: Claude's `/context [all]` is a TUI colored grid; ours is the existing overlay. Category set and numbers must match the documented contract; the visual form stays Nessy's.

---

### Task 0: Pre-phase — the four live defects CDP pass 8 routed here (R4 workflows)

All four are in `docs/testing/cdp-live-checklist.md` § "P1 — Workflows (R4)". Fix order: (d) first — it blocks re-verifying the others live.

- (d) **BLOCKER — approved slash launch hangs.** `/pass8-demo` (zero-agent saved workflow, repo fixture `.nessy-agent/workflows/pass8-demo.js`) passed consent, then the turn ran 4+ minutes with no workflow events, no `.orchestrator/` dir, subprocess alive; stop yielded "Tool execution cancelled". The slash path ("adapted production Pi tool without a model hop", `00c57493`) executes the tool but its completion never ends the turn. Find where the adapted call's result should resolve the turn and prove the fix with a test through the production slash-resolve path (not a workflow-tool unit).
- (a) **Consent card renders the wrong template**: "Admin approval required / macOS password/Touch ID" header on a workflow launch (body correct). Find the renderer's approval-template selection and give the workflow-launch consent its own template.
- (b) **`meta.phases` is lost on the slash path**: the card said "declares no phases up front" for a workflow declaring one phase. The consent builder reads phases through the pure-literal parser; the slash invocation must hand it the same script/metadata the direct tool input path gets. Regression test: slash-invoked consent prompt contains the declared phase list.
- (c) **No per-workflow-per-project "Always"**: only the generic "Remember for 10 min" renders. The store, gate and host writer landed in `33bf2062`; the renderer control did not. Wire the durable remember into the consent card (both axes already tested host-side).

- [x] **Step 1:** Failing tests for (d) and (b) through production seams; implement (d), (b), then (a), (c). i18n for any new card strings.
- [x] **Step 2:** Suites + typecheck. Commit: `fix(workflows): slash-launch completion, consent template, phases and the durable remember`

### Task 1: Re-verify this plan against current code

- [x] **Step 1:** Re-check every anchor above on HEAD (they were verified at `bf326714`, before Task 0 landed). Correct the plan file where drifted; record corrections in the commit body of Task 2.
- [x] **Step 2:** Confirm what `buildContextBreakdownRows` renders today and which of its rows the category breakdown subsumes. (Today: optional `context.system|tools|history|files` rows from tokenUsage fields + `context.unattributed` remainder vs `contextTokens`. The category breakdown subsumes all of them — system→system prompt, tools→system tools+MCP tools, history→conversation messages, files→memory files — and adds subagents and skills; a legacy snapshot keeps exactly this row set.)

### Task 2: The per-category producer (Pi subprocess)

**Files:** `packages/pi-agent-server/src/context-usage.ts` (+ a pure category-accounting module beside it), provenance: `runtime-agent-definitions.ts`
- Test: colocated; drive `buildContextUsageSnapshot` with a real composed session, not hand-built parts

- Seven categories exactly (`debug-your-config.md`): **system prompt, system tools, MCP tools, custom subagents (with the source each loaded from), memory files, skills, conversation messages.**
- Measure the production-composed strings (prompt parts, tool listings, agent definitions, instruction/memory blocks, skill listing) via `estimateTokens`; conversation = the session's message history tokens (the existing total minus the accounted prefix is acceptable as the residual ONLY if stated in a comment; prefer direct accounting where the parts are at hand).
- Carry descriptor `provenance` through `buildPiRuntimeAgentDefinitions` so each subagent row names its source; drop nothing else.
- Loaded-file list: the instruction/memory files actually loaded this session (project context files, MEMORY.md with imports), with per-file token estimates.

- [x] **Step 1:** Failing tests: a composed session yields all seven categories with non-zero where content exists; the sum of categories + residual equals the reported total; each subagent row carries its provenance; the loaded-file list names the files the session actually loaded.
- [x] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit: `feat(context): per-category accounting in the Pi producer`

### Task 3: The wire field

**Files:** `packages/core/src/types/message.ts` (optional `categories` + `loadedFiles` on `ContextUsageSnapshot`), the `context_usage_update` emit sites
- Test: through the production emit path (the subprocess wire fixture / harness-contract fixtures if they pin the event shape — update them deliberately, not incidentally)

- [x] **Step 1:** Failing tests: `context_usage_update` carries the categories end-to-end; a snapshot without categories still parses (back-compat); the harness-contract fixture change is explicit. (No harness-contract fixture pins `context_usage_update`, so no fixture change was needed — verified, deliberate.)
- [x] **Step 2:** Implement. Commit: `feat(context): carry the category breakdown on context_usage_update`

### Task 4: The surface

**Files:** `ChatDisplay.tsx` context overlay (+ its row builder), locales
- Test: overlay component test with a categories-bearing snapshot AND a legacy snapshot

- Per-category rows with tokens and percent; the subagent rows show source; the loaded-file list renders (memory.md's documented verification step); absent categories → exactly today's totals view.
- The two documented over-limit warnings (`errors.md`), with the `/clear` variant when compaction is disabled; capacity warning near the auto-compact threshold.
- i18n all locales; parity+sorted green.

- [x] **Step 1:** Failing tests. **Step 2:** Implement. **Step 3:** PASS + i18n checks. Commit: `feat(context): category breakdown and over-limit warnings in the /context overlay`

### Task 5: Close-out

- [x] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, pi-agent-server + server-core + electron-affected suites, `bun run lint`, `lint:i18n:parity`, `lint:i18n:sorted`, `git diff --check`. (The `test:shared:*` root scripts had to move from `cd <package> && bun test` to root-relative paths — the package-dir form trips the load-bearing CONFIG_DIR guard `9bb59bc1`.)
- [x] **Step 2:** Mutation probes: (a) make the producer measure a re-composed string instead of the production part → the measured-equals-sent test must fail; (b) drop provenance in `buildPiRuntimeAgentDefinitions` again → the subagent-source test must fail; (c) strip `categories` from the emit → the wire test must fail; (d) render the over-limit warning without the `/clear` variant under disabled compaction → that test must fail. Restore all four. (All four failed exactly their guarding test and were restored; suites re-verified green.)
- [x] **Step 3:** Report: per-task shas, real gate numbers, deviations, probe results, and the CDP cases for the planning session — expected: `/context` on a live session shows seven categories summing to the total, the loaded-file list names this repo's AGENTS.md/CLAUDE.md and MEMORY.md, a subagent row names its source; plus re-drive of the four Task 0 fixes: `/pass8-demo` runs to completion after consent, the card shows the phase list and a per-project "Always", and Always suppresses the next prompt.
