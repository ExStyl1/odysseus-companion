# Turn-Level Structured Output (R18) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both halves of doc-verification § R18: a real draft-07 validator with a shared configurable retry loop replacing the hand-rolled checker (subagent + workflow), Pi-side schema-on-prompt for the TURN with validate-and-reprompt and the documented terminal identifiers, and the Claude-side `outputFormat` turn wiring + headless surface.

**Architecture (verified 2026-07-28 at `8da5aef5`):**
- The checker to replace: `validateAgainstSchema` (`packages/pi-agent-server/src/orchestrator/subagent-tool.ts:152`; entry `parseSchemaResult:180`; retry `runWithSchemaRetry:268`, hardcoded 2 attempts `:277`). The workflow tool imports the same `parseSchemaResult` (`workflow-tool.ts:24`) with its own 2-attempt loop (`runAgentWithSchemaRetry:346/:354`). One replacement serves both.
- Validator options in-tree: `@sinclair/typebox` (pi-agent-server dep, generation only) and root `zod` — neither does full draft-07 (`$ref`, `oneOf/anyOf/allOf`, `pattern`, numeric bounds, array items). **Decision: add `ajv@8` as a direct pi-agent-server dependency** (resolves via the Artifactory registry; ubiquitous; draft-07 native). Do NOT add `ajv-formats` — the contract wants `format` as an ANNOTATION only, which is ajv's default without it.
- Pi turn seams: `SendMessageOptions` (`server-core/src/handlers/session-manager-interface.ts:151`, no schema field yet; RPC `sessions.ts:310/:368`); subprocess `prompt` message (`pi-agent-server/src/index.ts:273`, no outputSchema); `handlePrompt` (`:3135`, turn result seam after promptRun `:3210`).
- Terminal reporting: `AbortReason` already has `MaxStructuredOutputRetries` (`packages/shared/src/agent/core/session-lifecycle.ts:45`); terminal-reason family from R7 lives in `packages/shared/src/agent/backend/pi/event-adapter.ts` (`tool_deferred` precedent).
- Claude side: plumbing proven for `call_llm` — `claude-llm-query.ts:91` (`outputFormat: {type:'json_schema', schema}`), `claude-agent.ts:3091-3093`, `LLMQueryRequest.outputSchema` (`llm-tool.ts:50`).
- CLI: `--output-format` exists (`apps/cli/src/index.ts:97`, `text|stream-json`); no `--json-schema`.

**Contract source:** `code.claude.com/docs/en/agent-sdk/structured-outputs.md` (bare `structured-outputs.md` 404s) + doc-verification § R18 (line 576) — **READ BOTH FIRST**.

## Global Constraints

- One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits; no edits to `docs/superpowers/specs/`, the audit, or the CDP checklist; you may edit this plan file. Implementation-First Verification Budget. Tests from the repo root.
- **The three documented identifiers are distinct — keep all three straight:** the retry knob env (`NESSY_MAX_STRUCTURED_OUTPUT_RETRIES`, **default 5**), the result subtype `error_max_structured_output_retries`, and the terminal reason `structured_output_retry_exhausted`.
- **Draft-07 gate at startup:** the caller's schema is itself validated as JSON Schema draft-07 before the run; a schema declaring a newer `$schema` draft is REJECTED with a named error; `format` is accepted as an annotation, never enforced (no ajv-formats).
- **Two non-validation endings, told apart via the result's `errors` list:** (a) a completed structured output retracted mid-stream by a model fallback ends in the same `error_max_structured_output_retries` subtype with no validation failure recorded; (b) a run ending `success` with NO structured_output at all is reported as a failure. Both need tests.
- The shared retry loop is configurable and defaults to 5; the subagent/workflow 2-attempt loops lift onto it (their per-call override stays possible). Per-subagent output schemas are a Nessy extension (hardening, not parity) — do not gold-plate beyond replacing the checker + lifting the loop.
- Dependency rule: `ajv` added ONLY to `packages/pi-agent-server` (and shared if the validator module lands there — pick ONE home, prefer `packages/shared` so server-core can reuse), lockfile via `bun install` against the Artifactory registry — do not touch registry config.
- Model-contract pins: if any tool schema text changes, remember R10's lesson — projection-stable text, repin deliberately, restage bundles (`bun run electron:build:servers`), and keep the live-composition guard green.
- The recurring defect count is FIFTEEN. The turn path spans RPC → subprocess prompt → validate loop → terminal reporting → renderer/CLI result. Assert through production seams (a validator wired in a unit but not reached by `handlePrompt`'s turn-result seam is THE defect). Live re-drive is the planner's pass 13.

---

### Task 0: Pre-phase

R10 pass-12 leftovers: none routed here (remaining rows are live-condition). Confirm in one paragraph in this plan file; fold in any newly routed defect if the audit gained one.

- [x] **Step 1:** Confirm/record.

**Confirmed 2026-07-28 at `a69184f5`:** No R10 pass-12 leftover routes to R18. The audit's R10 row (`2026-07-25-nessy-claude-parity-audit.md:44`) closes with all three live fixes committed (`a3c6baca`, `851bb9e1`, `d47de6fe`) and "instances fourteen and fifteen ... killed with committed guards" — nothing routed onward. The CDP checklist's remaining unchecked auto-backgrounding rows (MCP detach live, `NESSY_DISABLE_BACKGROUND_TASKS=1` live, renderer `kind:'mcp'` listing entry) are live-condition wave items owned by the checklist, not build defects for this plan. The audit gained no new defect row naming R18 since this plan was written (R18 row status: not started, no routed-defect note).

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Re-check every anchor on HEAD; correct drifts here; record in Task 2's commit body. Specifically: (a) how the final assistant text of a turn is produced/collected in `handlePrompt` (the exact string the validator will see); (b) whether `AbortReason.MaxStructuredOutputRetries` is currently produced anywhere or dormant; (c) the wire shape for turn results where `.structured_output` will ride.

**Re-verified 2026-07-28 at `a69184f5` (HEAD == plan commit, tree clean):**

- Anchors CONFIRMED: `subagent-tool.ts:152/:180/:268/:277` (checker/entry/loop/hardcoded-2); `workflow-tool.ts:24/:346/:354`; `session-manager-interface.ts:151` (`options?: SendMessageOptions` — the type itself is defined at `packages/shared/src/protocol/dto.ts:389`, no schema field); RPC `sessions.ts:310` (options in) / `:368` (pass-through to `sessionManager.sendMessage`); subprocess `prompt` message `pi-agent-server/src/index.ts:273` (no outputSchema); `handlePrompt:3135`, `await promptRun` at `:3210`; `session-lifecycle.ts:45`; Pi terminal family reads `terminalReason` off enriched `agent_end` at `backend/pi/event-adapter.ts:443-483` (subprocess enrichment precedent: `EnrichedAgentEndEvent`, `pi-agent-server/src/index.ts:324`, thrashing-reason producer `:695-700`); `claude-agent.ts:3091-3092` (`outputFormat` on `queryLlm`); `llm-tool.ts:50`; CLI `--output-format` `apps/cli/src/index.ts:97`.
- Anchor DRIFT: "`claude-llm-query.ts:91`" — the file is 84 lines. The `outputFormat: {type:'json_schema', schema}` shape lives at `claude-agent.ts:3091-3092`; `claude-llm-query.ts` contributes the subtype label map (`:16`) and the `structured_output` read (`:58`).
- (a) Final assistant text: `handlePrompt` awaits `session.prompt(...)` (`:3201-3210`); after the run the turn's final text is the LAST assistant message of `session.messages`, text blocks filtered `type === 'text'` and joined — the established extraction pattern at `index.ts:2334-2341` (queryLlm). The validator sees that joined string, trimmed.
- (b) `AbortReason.MaxStructuredOutputRetries` ('max_structured_output_retries') is WIRED but UNREACHABLE: `backend/claude/event-adapter.ts:53` maps SDK subtype `error_max_structured_output_retries` → that literal (test `claude-event-adapter.test.ts:323`; vocabulary `core/src/types/message.ts:750`), but nothing sets `outputFormat` on any TURN today, so the subtype can never occur — dormant everywhere, Pi side has no producer. **The value itself is the wrong identifier** (doc-verification § R18: no such terminal_reason exists in the docs): fix is to rename the enum value + `TERMINAL_REASON_VALUES` entry + the claude adapter mapping to the documented `structured_output_retry_exhausted`. Safe: `turnTerminalReason` is runtime-only (never persisted), zero renderer/CLI consumers of the old literal (rg: no matches outside the producer+test+vocabulary), and the enum↔list pin (`adjacent-backend-frozen-contract.test.ts:447-451`) plus the `agent-events.json` fixture get updated in the same change.
- (c) Wire shape for `.structured_output` (the fifteen-instance defect lives exactly here — every leg is production): subprocess enriched `agent_end` (`OutboundAgentEvent`, `index.ts:324` precedent) → Pi event-adapter `complete` AgentEvent (`core/src/types/message.ts:811`) → `ManagedSession` runtime turn fields (`SessionManager.ts:1050` precedent, cleared at turn start `:13552`) → the renderer-facing `complete` SessionEvent rebuilt in `onProcessingStopped` (`SessionManager.ts:15128-15137`; dto at `protocol/dto.ts:334`) → CLI `sendAndStream` `case 'complete'` (`apps/cli/src/index.ts:464`). New optional fields on all four legs: `structuredOutput?: unknown`, `structuredOutputSubtype?: 'success' | 'error_max_structured_output_retries'`, `structuredOutputErrors?: string[]` — all absent when no schema rides the turn (byte-identical today). The `complete`-event field list is pinned by `fixtures/adjacent-backends/agent-events.json` (optionalFields) — deliberate fixture update rides Task 3's commit.
- Installed SDK check: `sdk.d.ts` HAS `outputFormat?: OutputFormat` (`:1638`, `OutputFormat = JsonSchemaOutputFormat` `:1968`) and the `error_max_structured_output_retries` subtype (`:3839`), so the Claude turn wiring is typable as-is. Its `TerminalReason` union (`:6333`, 12 values) predates the docs' 19-value list and LACKS `structured_output_retry_exhausted` — the docs, not the installed typings, are the contract for our own terminal vocabulary (we map from the SUBTYPE, not from the SDK's terminal_reason field).
- Harness for Task 3 exists: `__tests__/pi-runtime-h1-real-server.test.ts` spawns the real subprocess against a scripted `openai-completions` HTTP stub (init → prompt → observe outbound JSONL) — the scripted-model pattern this plan's invalid-then-valid/always-invalid runs will use.
- ajv availability confirmed without touching registry config: `bun.lock` already resolves `ajv@8.20.0` through Artifactory as a nested dep (`@modelcontextprotocol/sdk/ajv`, `ajv-formats/ajv`, `app-builder-lib/ajv`). Top-level `ajv` is 6.15.0 (eslint's); adding `ajv` to `packages/shared` scopes an 8.x resolution for the validator module.
- Tool-schema text: NO model-facing tool schema text changes in this plan's scope (the checker/loop are internal; `outputSchema` already exists in the subagent/workflow tool parameter schemas) — the R10 repin/restage/live-guard clause is not triggered unless that changes.

### Task 2: The draft-07 validator + shared retry loop (replace the checker)

**Files:** a new shared validator module (one home; prefer `packages/shared/src/structured-output/`), `subagent-tool.ts` (drop `validateAgainstSchema`, keep `parseSchemaResult`'s surface on the new engine), `workflow-tool.ts` loop lift, `package.json` + lockfile for ajv
- Test: table-driven over the features the old checker ignored

- Draft-07 validation via ajv (strict enough to reject unknown-draft `$schema`; `format` annotation-only); the schema-itself gate with a named error (`invalid structured-output schema: …`).
- Shared `runSchemaRetryLoop` (configurable attempts, default 5; env `NESSY_MAX_STRUCTURED_OUTPUT_RETRIES` parsed once) consumed by subagent + workflow paths.

- [x] **Step 1:** Failing tests: `enum`, `const`, `$ref` (internal), `items` (incl. element validation), `additionalProperties`, `oneOf`/`anyOf`/`allOf`, numeric bounds, `pattern` all ENFORCED (each with a passing and failing datum); `format: email` does NOT reject a non-email (annotation); a schema with `$schema: 2020-12` is rejected with the named error; the retry loop defaults to 5 and honors the env + per-call override; subagent and workflow paths both route through it (production call sites, not copies).
- [x] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** PASS. Commit: `feat(structured-output): draft-07 validator and the shared retry loop`

**Task 2 decisions recorded:** validator home is `packages/shared/src/structured-output/` (validator.ts + retry.ts + index.ts, subpath export `@nessy-agent/shared/structured-output`); `ajv@^8.17.1` added to `packages/shared` only, resolved 8.20.0 through the Artifactory registry (`bun install`, registry config untouched; top-level ajv flips 6.15.0→8.20.0 with eslint's v6 nesting under `@eslint/eslintrc/ajv` — eslint is the only v6 consumer). "Parsed once" for the env knob = ONE parser (`resolveMaxStructuredOutputRetries`), evaluated per run so tests and long-lived subprocesses see current env; malformed/non-positive values fall back to 5. The knob is an ATTEMPT cap (the plan's "configurable attempts, default 5"): the pre-R18 loops were 2 total attempts, now 5. `parseSchemaResult` keeps its exported surface on the new engine (review-tool untouched); its error wording changed to ajv's (review-tool.test.ts prose assertions updated). Both production loops now gate the schema BEFORE the first child spawn (invalid schema = named error, zero spawns). FAIL evidence: shared module `Cannot find module '../index.ts'` (1 fail); subagent/workflow 4 new tests failed (attempts 2≠5, 1≠3, 1≠0, 1≠5) with 47 pre-existing passing. PASS evidence: 85 pass / 0 fail across the 4 files; `typecheck:shared` exit 0; pi-agent-server typecheck exit 0.

### Task 3: Pi turn-level structured output

**Files:** `SendMessageOptions` (+ RPC pass-through), the subprocess `prompt` message (+ init/back-compat: absent field = today's behavior), `handlePrompt`'s validate-and-reprompt loop, terminal reporting (`structured_output_retry_exhausted` through the event adapter), the turn-result `.structured_output` field
- Test: real pi-agent-server harness with a scripted model (first reply invalid, second valid; and an always-invalid run)

- Schema-on-prompt: the schema rides the turn; the final assistant text must parse+validate; on failure the loop re-prompts with the validation errors (same turn, no user-visible extra turns beyond the documented retry behavior); success puts the parsed value at the result's `.structured_output`.
- Exhaustion (default 5) ends the run with subtype `error_max_structured_output_retries` + terminal reason `structured_output_retry_exhausted` (rides the R7 terminal family).
- The two non-validation endings per Global Constraints, distinguishable via `errors`.
- Draft-07 gate runs BEFORE the turn starts (a bad schema never spawns a model call).

- [x] **Step 1:** Failing tests: invalid-then-valid run returns `.structured_output` with the parsed value; always-invalid exhausts at the configured count with BOTH identifiers correct; a bad schema fails pre-model with the named error; absent schema = byte-identical today's behavior; success-without-output reported as failure via `errors`.
- [x] **Step 2:** Implement. Commit: `feat(pi): turn-level structured output with validate-and-reprompt`

**Task 3 decisions recorded:**
- Wire shape (all four legs, per Task 1(c)): three optional fields `structuredOutput` / `structuredOutputSubtype` (`'success' | 'error_max_structured_output_retries'`) / `structuredOutputErrors` on the enriched subprocess `agent_end`, the `complete` AgentEvent, the ManagedSession turn fields, and the renderer `complete` SessionEvent. All absent when no schema rides the turn — proven byte-identical by the real-server absence case and the SessionManager seam test.
- Terminal-vocabulary rename executed with Task 3 (not a separate change): `AbortReason.MaxStructuredOutputRetries` → `StructuredOutputRetryExhausted = 'structured_output_retry_exhausted'`; `TERMINAL_REASON_VALUES` swap; Claude adapter subtype map now emits the documented value; `agent-events.json` fixture updated surgically (one line). The old literal survives only in one explanatory comment. Nothing consumed the old value (Task 1(b)).
- Turn loop semantics: suppression of intermediate `agent_end` in `handleSessionEvent` keeps the host's per-turn queue open across reprompts (ONE user-visible turn); the loop forwards the single final agent_end itself. Retry prompt is the shared sentence WITHOUT re-sending the original ask (`buildSchemaRetryNote`; the conversation already carries it). A terminal agent_end enriched elsewhere (thrashing guard) still flows and the loop stands down; user abort forwards the held agent_end unenriched (today's abort shape) and `handleAbort` flags the loop for between-attempt aborts.
- Non-validation endings: (a) an attempt ending `stopReason 'error'` (or a thrown retry prompt) = the model-fallback-retraction analog → same subtype + terminal reason, errors carry the NON-validation cause (no schema-mismatch text) — proven live with a scripted 500 on the retry; (b) empty/whitespace final text → subtype `'success'`, NO `structuredOutput`, errors `['run completed without a structured output']`, no terminal reason, no retries burned (the documented distinct ending, deliberately not retried).
- The draft-07 gate runs in `handlePrompt` BEFORE `ensureSession`/any model call; the named error rides the existing `prompt_error` + synthetic agent_end path (0 stub requests proven).
- The subprocess resolves the retry cap via the ONE shared parser from its own env (`NESSY_MAX_STRUCTURED_OUTPUT_RETRIES=2` proven at the spawn boundary in the harness).

**Evidence:** FAIL first: 4 fail across pi-event-adapter/claude-event-adapter/turn-terminal-reason (119 pass), real-server 5 fail / 1 pass. PASS after: real-server 6/0 (16.0s, includes the 500-retraction and empty-output cases); adapters+seam+frozen-contract 131/0; base-agent+query-llm+pi-agent lifecycle/budget 120/0; sendmessage-durability+queue-ops 7/0; pi-runtime-protocol + h1 real-server regression 15/0. Typechecks: core 0, shared 0, server-core 0, pi-agent-server 0.

### Task 4: Claude-side wiring + the headless surface

**Files:** claude-agent turn path (`outputFormat` onto the turn query, reusing the proven call_llm shape), env `MAX_STRUCTURED_OUTPUT_RETRIES` passthrough (Claude SDK's own knob — do not rename on the Claude side), CLI `--json-schema '<schema>'` for the single-shot run printing `.structured_output` (works against the Pi path too — it rides `SendMessageOptions`)
- Test: claude-agent unit through the existing mocked-SDK harness; CLI arg-parse + single-shot test against the server harness

- [x] **Step 1:** Failing tests: the turn query carries `outputFormat: {type:'json_schema', schema}` when the option is set; the CLI accepts `--output-format json --json-schema '<schema>'`, sends the schema on the message options, and prints the result's `.structured_output`; invalid schema → named error, exit non-zero.
- [x] **Step 2:** Implement. Commit: `feat(structured-output): Claude turn wiring and the headless surface`

**Task 4 decisions recorded:**
- "Existing mocked-SDK harness" does not exist for the turn query (no `mock.module('@anthropic-ai/claude-agent-sdk')` harness in the repo; claude-agent tests are extracted-logic tests). The repo-blessed pattern for exactly this option class is `claude-turn-options.test.ts` (`buildClaudeTurnShapeOptions`): the wiring landed as an exported `buildClaudeStructuredOutputOptions` builder + a source-level wiring pin (the h1a-test pattern) asserting chatImpl spreads it — with `turnOutputSchema` captured before the SDK options literal, which shadows the ChatOptions parameter name (caught by typecheck).
- Claude event adapter forwards the structured result statelessly: `structured_output` present on a success result → `structuredOutput` + subtype `success`; subtype `error_max_structured_output_retries` → subtype + `errors` list (terminal reason already mapped). A schema-less turn stays byte-identical (asserted). The Claude-side (b)-case (success + schema + no output) is not synthesized by the adapter — the SDK owns that surface; Pi's loop owns it on our side (Task 3).
- Env passthrough: `buildClaudeSubprocessEnv` spreads `process.env` and strips only the three Bedrock vars, so the SDK's own `MAX_STRUCTURED_OUTPUT_RETRIES` reaches the subprocess by inheritance; pinned by a test that also asserts no NESSY_-rename bridging. (This pin passes immediately — it freezes existing behavior; it was not in the failing set.)
- CLI: `--json-schema` gates through the ONE shared engine (`parseJsonSchemaArg` → `compileStructuredOutputSchema`) BEFORE the server spawns (run) / before connect (send), with the documented failure string `Error: --json-schema is not a valid JSON Schema` (+ detail in parens). The schema rides `sessions:sendMessage` options — the same `SendMessageOptions.outputSchema` the Pi path consumes, so the flag works against both backends. Print-mode semantics when a schema is set (non-stream-json): streaming text suppressed, `complete` prints `.structured_output` on success, exhaustion prints the errors and exits 1, success-without-output exits 1 (the docs' example branches). A schema-less send stays byte-identical on the wire (no trailing null args).

**Evidence:** FAIL first: shared 2 fail + 1 import error; CLI 4 fail. PASS after: claude-turn-options 7/0 (incl. env pin + wiring pin), claude-event-adapter + query-llm 61/0 combined, full CLI suite 92/0 (run/commands/client). Typechecks: shared 0, cli 0.

### Task 5: Close-out

- [x] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, pi-agent-server + server-core + cli suites, `bun run lint`, `git diff --check`; if any tool schema text changed — the live-composition pin guard + restaged bundles.
- [x] **Step 2:** Mutation probes: (a) make `format` enforcing → the annotation test must fail; (b) accept a 2020-12 schema → the gate test must fail; (c) drop the reprompt (return the first invalid) → the invalid-then-valid test must fail; (d) report exhaustion with subtype but the OLD terminal reason → the identifier test must fail. Restore all four.
- [x] **Step 3:** Report: per-task shas, real gate numbers, anchor corrections, deviations, probe results, and the live/CDP cases for the planner's pass 13 — expected: a live turn with a schema riding sendMessage returns `.structured_output` (visible via CLI or transcript); an impossible schema exhausts with the documented subtype; the subagent/workflow schema paths still green end-to-end.

**Close-out record (2026-07-28):**

Commits: Task 2 `3c3ee721`, Task 3 `3d972dfc`, Task 4 `a9d69022` (Tasks 0-1 recorded in this file, rode Task 2's commit per the plan). 31 files changed since `a69184f5`. Zero edits under `docs/superpowers/specs/`, the audit, or `docs/testing/cdp-live-checklist.md`.

Gates (all from the repo root):
- `bun run typecheck:all` — exit 0 (all eight legs).
- `bun run test:shared:all` — exit 0: 20/0 + 5/0 + 66/0 + 48/0. One transient on the first aggregate run: `codex-responses-adapter` live-gateway conformance case timed out at its own 60s limit (network), green on isolated re-run 13/0 in 66s and on the aggregate re-run; `describe.if(!!jwt)` live-conditional, zero R18 files involved.
- pi-agent-server suite — **453 pass / 0 fail** (63 files, 105.2s), including the new `structured-output-real-server.test.ts` 6/0. The R10-era cwd-transaction flake did not appear.
- server-core suite — **894 pass / 0 fail** (129 files, 26.8s).
- cli suite — **92 pass / 0 fail** (3 files).
- `bun run lint` — exit 0 (0 errors; 4 pre-existing renderer warnings in files this plan never touched).
- `git diff --check` — clean.
- Tool schema text: ZERO changes (verified over the full diff) → the R10 repin/restage/live-composition-guard clause was not triggered.

Mutation probes (each mutated → targeted test FAILED → restored → green; final `git status` clean and both suites re-green 33/0):
- (a) `validateFormats: true` + a registered email format in the validator → the annotation test failed (26/1). Restored.
- (b) `$schema` acceptance (strip-and-compile instead of reject) → the 2020-12 gate test failed (26/1). Restored. (Note: merely whitelisting the 2020-12 URI is NOT a valid probe form — ajv then throws its own missing-meta-schema error which still matches the named-error assertion; the probe must actually accept.)
- (c) turn-loop reprompt dropped (first invalid ends the run) in `handlePrompt`'s loop → real-server invalid-then-valid failed (3/3, also always-invalid count and the 500-retry case, consistent). Restored.
- (d) exhaustion enriched with the OLD `max_structured_output_retries` terminal reason → the real-server BOTH-identifiers test failed (4/2, also the retraction case which asserts the reason). Restored.

Deviations from the plan text (all recorded in-task above): the `claude-llm-query.ts:91` anchor drift; no mocked-SDK query harness exists (Task 4 used the repo's turn-shape builder + source-pin pattern instead); the turn loop shares the ENGINE (compile/validate/knob/reprompt sentence) while `runSchemaRetryLoop` is the shared loop for the subagent/workflow call sites — the turn's orchestration handles abort/terminal/non-validation endings the generic loop has no seams for.

Live/CDP cases owed to the planner's pass 13:
1. **CLI single-shot structured output (either backend):** `nessy-general-agent --output-format json --json-schema '{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}' run 'Reply with JSON: {"ok": true}'` → prints exactly the validated `.structured_output` JSON and exits 0; the transcript shows ONE user-visible turn.
2. **Impossible schema exhausts with the documented identifiers:** same invocation with schema `{"type":"object","required":["impossible"],"properties":{"impossible":{"const":"unproducible-sentinel-000"}}}` and a prompt that refuses it → stderr `Could not produce valid structured output: …`, exit 1; the session's `complete` event carries `structuredOutputSubtype: 'error_max_structured_output_retries'` AND `terminalReason: 'structured_output_retry_exhausted'` (with `NESSY_MAX_STRUCTURED_OUTPUT_RETRIES` set low to keep it fast).
3. **Pre-model gate live:** `--json-schema '{"$schema":"https://json-schema.org/draft/2020-12/schema"}'` → `Error: --json-schema is not a valid JSON Schema (…)`, exit 1, no server session created.
4. **Subagent/workflow schema paths still green live:** a live subagent call with an `outputSchema` whose enum the first reply violates → the retry prompt (with the validation errors) is visible in the child transcript and the final result validates; a deliberately invalid `outputSchema` fails the call with `invalid structured-output schema: …` BEFORE any child spawns.
