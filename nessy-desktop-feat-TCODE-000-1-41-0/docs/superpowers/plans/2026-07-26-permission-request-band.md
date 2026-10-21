> **CLOSED 2026-07-27.** Executed and verified; evidence in the parity audit §0 (R15).
> CDP pass 3 found the band inert on the live plugin path — that fix is R9's pre-phase Step 0,
> not a reopening of this plan. Kept until the end-of-series sweep. Do not execute again.

# PermissionRequest Band (R15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the hook-approval band the way Claude actually does it — a `PermissionRequest` event fired when a permission prompt is about to be shown, whose `allow` skips that prompt without ever crossing the deny floor — plus the `dontAsk` hook-approve branch and the `PermissionDenied` side event.

**Architecture:** **The gate order does not move.** R15 was re-scoped 2026-07-26 (doc-verification § R15): Claude's hook `allow` does NOT widen past deny/ask rules, so nothing reverses and no threat model is owed. The band is a separate event at the point where the gate has already decided `prompt` (after the guardian consult) — exactly `PermissionRequest`'s documented position: "when a permission dialog is about to be shown". A hook `allow` there replaces the human's click, an ask-rule match or `requiresUserInteraction` tool still prompts, and a deny stays terminal. `dontAsk` gains the documented "calls approved by a PreToolUse hook" branch under the same non-negotiables.

**Tech Stack:** TypeScript, Bun test.

**Contract source:** `code.claude.com/docs/en/hooks.md#permissionrequest`, `permissions.md`, `agent-sdk/permissions.md` — distilled in `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R15. READ IT FIRST. The audit-text fixes that entry demands (§A row wording, §3 "deny floor is stronger" claim) are the PLANNING SESSION's job, not yours — do not touch `docs/superpowers/specs/`.

## Global Constraints

- Scope: Pi runtime + app. One commit per task; no Co-Authored-By; no MR/tags; never reset/rebase/amend; pathspec-limited commits only; Implementation-First Verification Budget.
- **Invariants that must survive, each pinned by an existing test you must NOT weaken:** a gate `block` is terminal (`pi-agent.ts` keeps `checkResult.type === 'block'` authoritative before any hook decision applies); a hook `deny`/`block` beats everything including `allow-all`; the guardian only narrows; `clampPermissionModeToParent` call sites unchanged.
- Non-negotiables a band `allow` can never skip (documented, all three): (1) MCP tools with `_meta["anthropic/requiresUserInteraction"]` (P5 landed the metadata; P6 wired force-prompt), (2) an explicit `ask` rule match from the permission DSL, (3) org-`ask` connector semantics where present. In `dontAsk` these three are **denied**, not prompted.
- `updatedPermissions`/`permission_suggestions` destinations: SESSION scope only in this plan (session whitelist + session `additionalDirectories`). Settings-file destinations are deferred to R25 with reason code — a hook writing durable config is an enterprise-surface decision.
- Deferral: `defer` → `tool_deferred` terminal contract is R7's (note the doc now says `stop_reason: "tool_deferred"`, correcting §5e-1.4) — do not implement it here.

---

### Task 0: Pre-phase — fold in R1 close-out follow-ups

- [x] **Step 0 (FIRST, its own commit): fix the live if-filter gap CDP pass 2 caught.**
  `ifRule` reaches `RuntimeHookRegistration` (`packages/shared/src/capabilities/resolver.ts:288`, threaded at `:894`) but
  `packages/shared/src/capabilities/runtime-automations.ts` — the path SessionManager actually executes hooks through —
  has ZERO `ifRule` references. Live result (real app, 2026-07-26): both `if`-filtered PreToolUse hooks ran on every tool
  call (`git status` fired the `Bash(ls *)` hook and vice versa), and a SessionStart hook with `if` executed instead of
  never running. R1's Task 5 wired `evaluateClaudeHookIfFilter` only into `hooks-automation.ts:918`. Fix: apply the same
  evaluation on the runtime-automations path — the `if`-carrying hook's action must be gated per invocation with the tool
  call context (tool name + input), and a hook with `ifRule` on a non-tool event must not produce an action at all.
  Mirror the semantics and diagnostics from `hooks-automation.ts:590-614` exactly (any-subcommand, fail-open on
  unparseable, `if_unparseable_fail_open`, non-tool-event drop). Add: one unit test per behaviour on the
  runtime-automations path (the projection-path tests exist and stayed green while live was broken — that asymmetry is
  the lesson), and note the fix for CDP pass 3 re-verification.
- [x] **Step 1:** Read the R1 close-out (audit §0 entry "R1" or the R1 plan's close-out notes). Expected handoffs that land HERE: (a) `EndConversation` consumer-side enforcement — a bare-name deny can't remove it while other tools remain, and neither `PermissionRequest` nor `PreToolUse` fires for it; (b) the `Cd` note; (c) `rawInputPath` threading to the five `evaluatePermissionDslV1` gate call sites so the symlink-pair asymmetry bites on the real gate path (currently DSL-level only). Land (a) in Task 4's exclusion list and (c) as its own commit; if R1 recorded other permission-file follow-ups, do them first as their own commits.

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Confirm anchors (verified 2026-07-26 at `b138fcb3`, BEFORE R1 landed — expect drift from R1's pathGlob work):
  - `packages/shared/src/agent/pi-agent.ts` — `applyHookDecisionToCheckResult` (gate block terminal first; hook deny converts; `checkResult.type === 'prompt'` keeps the prompt even on hook `allow` — the branch this plan extends); the guardian consult site `consultGuardianForBorderline` and its call at ~`:3183` (the band event fires AFTER it).
  - `packages/shared/src/agent/mode-manager.ts` ~`:2083-2105` — `dontAsk` denies where a rule asks, and is deliberately absent from the interactive-modes list.
  - `packages/shared/src/plugins/hooks-runtime.ts:12-27` — `PermissionRequest` already a `PluginHookEventName`, already in `BLOCKING_HOOK_EVENTS`.
  - `packages/shared/src/plugins/hooks-automation.ts` — `PLUGIN_HOOK_EVENT_TO_AGENT_EVENT` mapping for `PermissionRequest` (check whether it maps to a live `AgentEvent` or `null`; if `null`, wiring it is part of Task 2).
  - R22's prompt-hook runner and R1's `if` evaluation both apply to this event — confirm their call sites tolerate a new firing site.
  - P6's `requiresUserInteraction` force-prompt site and the DSL ask-rule match result shape (`PermissionDslEvaluationV1.action === 'ask'`).
- [x] **Step 2:** Correct this plan in place; say what changed.

**Task 0 execution record (2026-07-26, executor):** Step 0 landed as `744d6df9` — `pluginHookConfig` in `packages/shared/src/capabilities/runtime-automations.ts` now threads `ifRule` into the runtime matcher (the shared execution check `hooks-automation.ts:721` → `hookIfFilterRuns` then gates BOTH `executeAgentEvent` and the `buildSdkHooks` path, since both route through `executePluginHookAutomations`) and drops an `if`-carrying hook on a non-tool event at registration; `TOOL_HOOK_EVENTS` is now exported from `hooks-automation.ts` as the single source of the tool-event set. Three runtime-path unit tests added (per-invocation gating incl. any-subcommand, unparseable fail-open, non-tool-event drop). **Flag for CDP pass 3: re-verify live that `if`-filtered hooks fire selectively and a SessionStart+`if` hook never runs.** Step 1(c) landed as `39759a8a` — `rawInputPath` threaded at the command-hook gate (raw cwd before `canonicalizeForDecision`), the skill-context gate (raw pinned cwd), the pi-agent tool gate (raw wire input via new `rawDslInputPath` helper; approval recheck uses the approved input as its own raw), and the mcp/agent-hook gate (its input is already raw; threaded explicitly); the agent-admission site carries no path parameter (documented in place, nothing to thread). Follow-up (a) EndConversation lands in Task 4 as planned; (b) `Cd` stays a note (`claude_rule.cd_not_enforced` — needs a `/cd` surface first, unchanged).

**Task 1 re-verification notes (2026-07-26, executor, at `39759a8a`) — what changed vs the anchors above:**
- The hook-decision applier is named `applyPreToolUseHookDecision` (`pi-agent.ts:2448`), not `applyHookDecisionToCheckResult`. Semantics as planned: gate block terminal first (`:2457`), hook deny/block converts (`:2465`), `checkResult.type === 'prompt'` keeps the prompt on hook allow (`:2507-2513`). Guardian consult call at `:3184`.
- `PLUGIN_HOOK_EVENT_TO_AGENT_EVENT` ALREADY maps `PermissionRequest: 'PermissionRequest'` (`hooks-automation.ts:286`) — not `null`, so Task 2 needs no mapping work. `AGENT_EVENT_CONTRACTS_V1` already carries BOTH `PermissionRequest` (kind `decision`, `types.ts:43`) and `PermissionDenied` (kind `observational`, `types.ts:44`) — Task 5 shrinks to the plugin-facing union (`hooks-runtime.ts`), format-adapter maps, and the firing site.
- R22's prompt-hook runner already refuses to judge on `PermissionRequest` ("their output is discarded", `hooks-automation.ts:742`); R1's `if` evaluates on it via `TOOL_HOOK_EVENTS` (`:277`). Both tolerate the new firing site — the band dispatches through `emitAutomationEvent` → `dispatchAutomationAgentEvent` like every other event.
- mode-manager anchors confirmed: rule-ask deny in `dontAsk` at `mode-manager.ts:2079-2094`; deliberately absent from the interactive-modes list at `:2102-2105`.
- P6 force-prompt confirmed: `requiresUserInteraction` computed at `pre-tool-use.ts:773-775` (dontAsk denies at `:779-787`), interaction prompt returned at `:936-948`; the rule-ask/org-ask (`requiresPermission`) prompt returned at `:950-957`. NEITHER return marks its origin on the result, so Task 2 adds an optional `nonNegotiable?: 'requiresUserInteraction' | 'askRule'` discriminator to the `prompt` check result at those two sites; the readable-DSL ask (the third ask surface) is visible at the band site directly as `readableDecision.action === 'ask'`.
- **Band firing site correction:** fire inside `authorizeAndSend` where `effectiveDecision.outcome === 'ask'` (after the readable-DSL merge), not in the `case 'prompt'` switch arm. That is the single choke point where BOTH prompt sources converge — the gate's `prompt` result AND the readable-DSL allow→ask flip — and it sits after the guardian consult as required.
- The hook output parser (`parseHookCommandOutput`, `automations/hook-command.ts:90`) does not yet read the documented `PermissionRequest` output shape `hookSpecificOutput.decision: {behavior, updatedInput, updatedPermissions, message, interrupt}` — Task 2 extends it. Doc details that bind: exit code 2 denies the permission; an HTTP hook's `ok:false` has NO effect on this event (denial requires a command hook `decision.behavior: 'deny'`).
- `EndConversation`: no Pi binding by that name exists (`PI_TOOL_BINDINGS`), so the guards are name-based and self-activating — the band/PreToolUse skip matches on the tool name; Task 4's manifest-keep applies to the bare-name-deny removal filter at `pi-agent.ts:1475-1482`.

### Task 2: Fire `PermissionRequest` at the band

**Files:**
- Modify: `packages/shared/src/agent/pi-agent.ts` (the pre-tool-use flow, after guardian consult, where `checkResult.type === 'prompt'` survives)
- Modify: `packages/shared/src/plugins/hooks-automation.ts` (event mapping if `null`)
- Test: `packages/shared/src/agent/__tests__/` — extend the pre-tool-use/hook suite the P3 hook contract tests live in

**Interfaces:**
- The event payload (documented input): `{ tool_name, tool_input, permission_mode, permission_suggestions?: PermissionSuggestion[] }` — NO `tool_use_id`.
- Decision read from the hook run result: `hookSpecificOutput.decision` with `{ behavior: 'allow' | 'deny', updatedInput?, updatedPermissions?, message?, interrupt? }`. `updatedInput`/`updatedPermissions` allow-only; `message`/`interrupt` deny-only.

Semantics:
- Fires ONLY when the gate (including guardian) decided to prompt. Never for `EndConversation`.
- `behavior: 'deny'` → block with `message` as the reason; `interrupt: true` additionally aborts the turn (map to the existing hard-abort path).
- `behavior: 'allow'` → skip the prompt, EXCEPT when the prompt exists because of one of the three non-negotiables — those keep prompting (Task 4 centralises the check; implement it here as a helper `promptIsNonNegotiable(checkResult, dslEvaluation, toolMeta): boolean` and reuse it in Task 4).
- `updatedInput` replaces the whole input and is **re-evaluated against the gate** (we already re-gate hook-modified input — reuse that path; a deny/ask match on the new input wins).
- No hook / no decision → the prompt proceeds exactly as today (byte-identical path when no `PermissionRequest` hooks are registered).

- [x] **Step 1: Write the failing tests** (stub automation system, real gate):

```ts
test('PermissionRequest allow skips the prompt the gate decided to show', async () => { /* gate → prompt; hook returns behavior allow; expect tool runs, no prompt raised */ });
test('PermissionRequest deny blocks with the message', async () => { /* behavior deny + message; expect block, reason contains message */ });
test('PermissionRequest allow cannot skip an explicit ask-rule prompt', async () => { /* DSL ask rule matches; hook allow; expect prompt anyway */ });
test('PermissionRequest allow cannot skip requiresUserInteraction', async () => { /* MCP tool with the _meta flag; hook allow; expect prompt */ });
test('a matching deny rule never reaches PermissionRequest at all', async () => { /* gate block; expect zero PermissionRequest firings */ });
test('updatedInput is re-gated: a deny match on the new input blocks', async () => {});
test('PermissionRequest never fires for EndConversation', async () => {});
test('no PermissionRequest hooks registered → prompt path unchanged', async () => {});
```

- [x] **Step 2:** Run — FAIL. Implement the firing site + decision application. Keep the event dispatch through the existing `dispatchAutomationAgentEvent`/plugin-automation path so R22's type table, R1's `if`, matchers, trust and receipts all apply for free.
- [x] **Step 3:** Run — PASS. `bun run typecheck:shared`. Commit: `feat(permissions): fire PermissionRequest at the prompt band`

### Task 3: `permission_suggestions` in, `updatedPermissions` out (session scope)

**Files:**
- Modify: the Task 2 payload builder (+`permission_suggestions`), the decision applier (+`updatedPermissions`)
- Test: same suite

Six documented entry types; this plan implements the session-scoped subset and defers the rest with a diagnostic:
- IN (suggestions): populate from what the prompt would have offered — the "always allow this command/domain" option the human sees (`rememberablePrompt` already computes it; expose it as `addRules` entries with `destination: 'session'`).
- OUT (updatedPermissions applied): `addRules` (behavior allow only → session whitelist via the existing `permissionManager` remember path; deny/ask rules → session DSL layer if R1's compile path makes it one-line, else defer with `plugin.hooks.updated_permissions_deferred`), `addDirectories`/`removeDirectories` (session `additionalDirectories` — P6 landed the capability), `setMode` (session mode change through the EXISTING mode-change path with its clamp; `allow-all`/`bypassPermissions` refused unless already reachable, never persisted). `replaceRules`/`removeRules` and any non-session `destination` → deferred diagnostic, applied nothing.

- [x] **Step 1:** Failing tests: suggestions carry the rememberable rule; `addRules` allow persists to the session whitelist and a repeat of the same command doesn't prompt; `addDirectories` admits a previously-outside path via the P6 check; `setMode` to `allow-all` from `ask` is refused (clamp respected); `destination: 'projectSettings'` defers with the diagnostic and applies nothing.
- [x] **Step 2:** Implement. Every applied change writes a receipt naming the hook (reuse the plugin-hook receipt shape).
- [x] **Step 3:** Focused suites + typecheck. Commit: `feat(permissions): permission_suggestions and session-scoped updatedPermissions`

### Task 4: The `dontAsk` hook-approve branch

**Files:**
- Modify: `packages/shared/src/agent/mode-manager.ts` (~`:2083-2105`) and/or the pi-agent band site — prefer the band: in `dontAsk`, instead of denying where a rule asks, consult `PermissionRequest` hooks once; hook `allow` (non-negotiables excepted) approves, anything else denies with today's message.
- Test: mode-manager + band suites

Contract: Claude's `dontAsk` runs "actions matching your `permissions.allow` rules, read-only Bash commands, and calls approved by a PreToolUse hook", and denies the three non-negotiables outright. Ours currently denies everything a rule would ask about.

- [x] **Step 1:** Failing tests: in `dontAsk`, a would-prompt action with a hook `allow` runs; without hooks it denies exactly as today (byte-identical message); a `requiresUserInteraction` tool denies even with hook allow; an ask-rule match denies even with hook allow.
- [x] **Step 2:** Implement via `promptIsNonNegotiable` from Task 2. The gate's `dontAsk` deny becomes "deny unless a PermissionRequest hook approves" ONLY at the band site — `shouldAllowToolInMode`'s pure logic stays pure (no hook I/O inside mode-manager).
- [x] **Step 3:** Suites + typecheck. Commit: `feat(permissions): dontAsk accepts PermissionRequest hook approvals`

### Task 5: `PermissionDenied` side event

**Files:**
- Modify: `packages/shared/src/plugins/hooks-runtime.ts` (+`PermissionDenied` to the event union + maps), `packages/shared/src/plugins/format-adapters.ts` (+CLAUDE/CODEX maps), the auto-mode/gate deny site in `pi-agent.ts`
- Test: hooks-runtime + adapter suites

Observational: fires on auto-mode denials (guardian deny, `dontAsk` deny, gate deny where a prompt would have been the alternative). Never blocking, output never a decision. Matches on tool name; supports `if`.

- [x] **Step 1:** Failing tests: event imports from a Claude bundle; fires on a guardian deny with the tool name as match value; its hook output cannot un-deny (decision ignored with diagnostic).
- [x] **Step 2:** Implement. Commit: `feat(hooks): PermissionDenied observational event`

### Task 6: Close-out

- [x] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, `lint`, `git diff --check`.
- [x] **Step 2:** Mutation probes: (a) make the band skip the ask-rule non-negotiable — Task 2's test must fail; (b) let `updatedInput` bypass re-gating — the re-gate test must fail; (c) let `dontAsk` hook-approve a `requiresUserInteraction` tool — Task 4's test must fail. Restore all.
- [x] **Step 3:** Report: shas, gate numbers, deviations, follow-ups (expected: settings-file destinations→R25, `defer`/`tool_deferred`→R7, band CDP case for the wave: "hook allow works inside the band and provably cannot reach the floor" — flag it as the adversarial case the wave list already carries).

---

## Close-out evidence (2026-07-27, executor)

**Commits:** Task 0 Step 0 `744d6df9` (live if-filter fix); Task 0 Step 1(c) `39759a8a` (rawInputPath through the five gates); Task 1 `ee5c3f41` (plan re-verify); Task 2 `df3255d7`; Task 3 `5cecd131`; Task 4 (incl. R1 EndConversation follow-up) `6d51d62c`; Task 5 `831b833f`.

**Gates (final integration, at `831b833f`):** `bun run typecheck:all` exit 0 (all 8 packages). `bun run test:shared:all` 48 pass / 0 fail. Repo-wide `bun test` **8016 pass / 18 skip / 0 fail** across 741 files (212s). `bun run lint` exit 0 (4 pre-existing warnings, all in untouched `apps/electron` files — same set R1 recorded). `git diff --check` clean.

**Mutation probes (all three killed, all restored, tree verified clean against HEAD):**
- (a) band `allow` unconditional (dropped `promptIsNonNegotiable`) → 3 tests FAILED: `PermissionRequest allow cannot skip an explicit ask-rule prompt`, `…cannot skip requiresUserInteraction`, and Task 4's `an ask-rule match denies even with a hook allow` (33 pass / 3 fail).
- (b) `updatedInput` re-gate bypassed → `updatedInput is re-gated: a deny match on the new input blocks` FAILED (35 pass / 1 fail).
- (c) `dontAsk` would-prompt marker ignoring `requiresUserInteraction` → `a requiresUserInteraction tool denies even with a hook allow, without consulting the band` FAILED (35 pass / 1 fail).

**Deviations from the plan as written:**
- `promptIsNonNegotiable(checkResult, dslEvaluation)` is two-arg, not three (`toolMeta` dropped): the `requiresUserInteraction` fact is stamped onto the prompt result where the tool metadata already lives (`pre-tool-use.ts`), so the band never re-derives it.
- `interrupt` maps to a NEW `AbortReason.PermissionHookInterrupt` (`permission_hook_interrupt`), mirrored in `TERMINAL_REASON_VALUES` — reusing an existing reason (`user_stop`/`hook_loop_cap`) would misreport telemetry. The frozen-contract mirror test pins the pair and stayed green.
- The band fires inside `authorizeAndSend` where `effectiveDecision.outcome === 'ask'` (per the Task 1 correction), covering BOTH prompt sources (gate `prompt` + readable-DSL allow→ask flip). A hook-approved allow never arms the guardian post-denial override (guardian-only-narrows kept).
- `permission_suggestions` are emitted only for the spellable remember options: a Bash base-command prefix rule and a bare MCP tool rule. curl/wget domain whitelists and file-write tool+path hashes have no documented rule spelling — no suggestion rather than an invented one.
- Receipts for applied/deferred `updatedPermissions` ride a structured `__PERMISSION_UPDATE__` debug line naming the event and tool: the merged automation decision carries no single hook identity (`AgentEventExecutionResult` has `matchedCount` only), so "naming the hook" is not attributable at the application site.
- The `EndConversation` test runs on the legacy no-manifest path (no Pi binding carries the name, and the manifest identity check rejects unadvertised tools); the guard itself is name-based at the PreToolUse emit, the band site, the PermissionDenied site, and the manifest deny-removal filter (`filterCapabilityIdentitiesByWholeToolDeny`), self-activating if such a binding ever appears.
- `PermissionDenied` fires on guardian denies (both consult bands — the borderline consult IS our auto-mode classifier deny) and `dontAsk` would-prompt denies; ordinary gate blocks and floors never fire it. dontAsk hook-approve `updatedInput` re-gate treats only the mode's own would-prompt denial of the new input as approvable; floors and deny rules stay terminal.
- Session `addDirectories` roots live on the agent (one session) and are seen by `runPreToolUseChecks` via `sessionAdditionalDirectories`; SessionManager's own hook gates keep reading only the configured list — a hook-granted session root never widens the SM-side command-hook/skill-context gates.

**Follow-ups:**
- Settings-file `updatedPermissions` destinations (`projectSettings`/`userSettings`/etc.), `replaceRules`/`removeRules`, and deny/ask `addRules` (session DSL layer) → **R25** (`plugin.hooks.updated_permissions_deferred` diagnostics in place).
- `defer` → `stop_reason: "tool_deferred"` terminal contract → **R7** (the parser already treats `defer` as an explicit no-decision).
- CDP wave: re-verify the Task 0 if-filter fix live (pass 3), and the adversarial band case the wave list already carries — "hook allow works inside the band and provably cannot reach the floor" (deny rule + hook allow → still blocked; ask rule + hook allow → still prompts).
- Audit §0 R15 row + §1/§3 wording fixes are the planning session's (specs/ untouched by this executor).
