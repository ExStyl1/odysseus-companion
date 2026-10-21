> **CLOSED 2026-07-27.** Executed and verified; evidence in the parity audit §0 (R9).
> CDP pass 4 confirmed the band live (allow suppresses the prompt, deny blocks).
> Kept until the end-of-series sweep. Do not execute again.

# Hook Decision Patterns (R9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make hook output actually decide on the events beyond `PreToolUse` — the five documented decision patterns, the five universal output fields with their 10 000-char cap, `PostToolUse` result rewriting, `WorktreeCreate`'s path return, and the event-name/breadth corrections (`Elicitation` alias, the two missing contracts).

**Architecture:** One parser, five shapes. Today `parseHookCommandOutput` returns a `PreToolUseDecision`-shaped object and every non-`PreToolUse` event is observational by construction (`AGENT_EVENT_CONTRACTS_V1`: 29 entries, only `PreToolUse` and `PermissionRequest` are `kind: 'decision'`). This plan adds a per-event **decision contract** table that says which pattern an event speaks, keeps the parse in one place, and lets each emission site consume only what its pattern allows. No event gains a decision it does not have in the docs.

**Tech Stack:** TypeScript, Bun test.

**Contract source:** `code.claude.com/docs/en/hooks.md` (Decision control + exit-code tables), `plugins-reference.md`, `agent-sdk/hooks.md` — distilled in `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R9. **READ IT FIRST.** It corrects three defects in the old R9 text: there is no `applyRule` field; the event denominator is 30 not 34; "non-PreToolUse decisions" is five patterns, not one.

## Global Constraints

- Scope: Pi runtime + app. One commit per task; no `Co-Authored-By`; no MR/tags; never reset/rebase/amend; pathspec-limited commits only; do not touch `docs/superpowers/specs/` (you may edit this plan file); Implementation-First Verification Budget.
- **The deny floor is not in scope and must not move.** Docs confirm both directions already match us: "Deny and ask rules are still evaluated regardless of what the hook returns." Any change to `pi-agent.ts`'s gate-block-terminal or hook-deny-wins branches is out of scope for R9 — R15 owns that file's band.
- **Rewritten input/output must be re-evaluated, never trusted.** `updatedInput` re-gates (R15 wired this); `updatedToolOutput` on a built-in tool whose value does not match the tool's output schema is **ignored, original used**.
- Reachability, decided from the docs: `PermissionDenied` is reachable now (R21 landed the classifier; R15 adds the event). `TeammateIdle` needs agent teams → **defer to R23** with a recorded reason. `MessageDisplay` needs a per-message display interception channel we do not have → **defer to R30** with a recorded reason (it also carries a 10s timeout, not 600s — record that where the deferral is recorded so R30 does not re-derive it).
- Every output string is capped at **10 000 characters**. Apply the cap once, in the parser, for every field — not per call site.

---

### Task 0: Pre-phase — fold in R15 close-out follow-ups

- [x] **Step 0 (FIRST, its own commit): the band is inert on the live plugin path — CDP pass 3 proved it.**
  A `PermissionRequest` command hook returning `hookSpecificOutput.decision.behavior: "allow"` executed on the
  real app and the prompt was raised anyway. Cause, located in code: `packages/shared/src/plugins/hooks-automation.ts:730`
  gates native `decision` actions on `event === 'PreToolUse'`, and `:847-861` parses a command hook's stdout as a
  decision only for `PreToolUse` — every other event is forced observational (`additionalContext` /
  `updatedToolOutput` only). R15's band tests pass because they stub the automation system ABOVE that layer.
  **This is the third instance of the series' recurring defect** (P6 `path`/`file_path`, pass 2 `ifRule`, now this):
  two parallel paths, tests green on the one production does not use.
  Fix: this plan's Task 2 contract table is exactly the right mechanism — land the table FIRST, then replace both
  `event === 'PreToolUse'` gates with `hookDecisionPattern(event)` so each event gets precisely the decision surface
  the docs give it and nothing more. Minimum for this step: `PermissionRequest` (band decision reaches the caller),
  with the nine top-level-block events still inert until Task 3 wires their emission sites.
  Check the **live** path too (`packages/shared/src/capabilities/runtime-automations.ts`) — pass 2's lesson.
  Add one test per un-gated event that asserts through the plugin automation path, not a stub above it, and note
  the fix for CDP pass 4.
**Step 0 execution record (2026-07-27, executor):** landed the Task 2 contract table
FIRST (`packages/shared/src/automations/hook-decision-contract.ts`:
`HOOK_DECISION_PATTERN` semantics via `hookDecisionPattern`, plus
`hookEventDecisionSurface` / `hookEventCanDecide` / `projectHookDecisionForEvent`),
then replaced BOTH `event === 'PreToolUse'` gates in
`packages/shared/src/plugins/hooks-automation.ts` (`:730` stored `decision`
actions, `:847-861` command stdout) with the table. Found and fixed a **third**
copy of the same gate in `packages/shared/src/automations/automation-system.ts`
(`executeAgentEvent`) so the defect cannot re-enter through the native system.
The live path `packages/shared/src/capabilities/runtime-automations.ts` needed no
change (it builds `PluginScopedAutomationSystem`, which routes through
`executePluginHookAutomations`) — proven by a NEW live-path test that drives
`buildPinnedAgentAutomationSystem` end to end, not a stub above it.
The `!runner` fail-closed branch deliberately stays PreToolUse-named: it is a
fail-closed policy choice (a PreToolUse hook may be the deny gate), not a
decision-surface question — on any other event a hook that cannot run leaves the
prompt/turn in charge, which is the safe default.
Fixture correction: the Honey live-path test asserted output containing
`continue: false` on SessionStart and PostToolUse. The installed plugin
(`greenpt/honey` 1.0.0, `hooks/honey-session.js`, `hooks/logcompress-hook.js`)
emits **no** `continue` field — the fixture was synthetic, and under the contract
table `continue: false` is a documented hard stop that takes precedence over
`updatedToolOutput`. Fixture corrected to the real shapes and the precedence
pinned as its own assertion.
**CDP pass 4:** re-verify live that a `PermissionRequest` command hook returning
`hookSpecificOutput.decision.behavior: "allow"` now suppresses the prompt, and
that a `deny` + `interrupt: true` denies and aborts.

- [ ] **Step 1:** Read the R15 close-out (audit §0 entry "R15", or the R15 plan's close-out notes at `docs/superpowers/plans/2026-07-26-permission-request-band.md`). R15 landed `PermissionRequest`'s `{behavior, updatedInput, updatedPermissions, message, interrupt}` decision, the session-scoped `updatedPermissions` subset, and the `PermissionDenied` event. **This plan must not re-implement any of it** — Task 3 extends `PermissionDenied` with its own documented `{retry: true}` shape and nothing else. If R15 deferred `updatedPermissions` entry types with a diagnostic, leave them deferred (settings-file destinations belong to R25). If R15 recorded follow-ups touching the automation/hook files this plan edits, land them first as their own commits.

### Task 1: Re-verify the plan against current code

- [x] **Step 1:** Confirm anchors (verified 2026-07-27 at `ee5c3f41`, i.e. mid-R15 — expect drift):
  - `packages/shared/src/automations/types.ts:36-64` — `AGENT_EVENT_CONTRACTS_V1`, 29 entries, `kind: 'decision'` only on `PreToolUse` and `PermissionRequest`; `McpElicitation` + `McpResult` are ours, `Elicitation`/`ElicitationResult` are Claude's names.
  - `packages/shared/src/automations/hook-command.ts` — `parseHookCommandOutput` / `getHookCommandPreToolDecision`, the `defer` pin R22 added, `redactHookOutput`.
  - `packages/shared/src/plugins/hooks-automation.ts` — the per-event application loop (R22 made non-`PreToolUse` output observational-only: `additionalContext` + `updatedToolOutput` survive, decisions are dropped); R1's `if` evaluation; R22's `continueOnBlock` stored-but-inert field **this plan consumes**.
  - `packages/shared/src/capabilities/runtime-automations.ts` — the live path (R15 pre-phase fixed its `if` gap; confirm the fix is present before assuming any other field reaches it — **check both paths for every field you add**).
  - `packages/shared/src/plugins/hooks-runtime.ts:12-27` — `PluginHookEventName` (15 members, 13 Claude names), `BLOCKING_HOOK_EVENTS`.
  - Emission sites: `SessionManager.ts` (7 dispatches), `base-agent.ts`, `claude-agent.ts`.

**Task 1 verification record (2026-07-27, executor).** All anchors exist; four
drifted, and three architectural facts change the shape of Tasks 3-5.

Anchor corrections:
1. `types.ts:37-65` (not `36-64`) holds the 29 entries. Confirmed: `kind: 'decision'`
   only on `PreToolUse` + `PermissionRequest`; `PermissionDenied` is `observational`.
2. `hooks-automation.ts`'s two gates are already replaced by the contract table
   (Step 0, `dc2250d5`), and a **third** copy lived in
   `automations/automation-system.ts` — also replaced.
3. `hooks-runtime.ts:12-28` — `PluginHookEventName` is **16** members / **14**
   Claude names, not 15/13: R15 added `PermissionDenied`. `BLOCKING_HOOK_EVENTS`
   is `{UserPromptSubmit, PreToolUse, PermissionRequest}` and has exactly one
   reader (`hooks-runtime.ts:510`).
4. `format-adapters.ts:91-105` — `CLAUDE_HOOK_EVENT_MAP` has 14 entries. Nine-event
   members `UserPromptExpansion`, `PostToolBatch` and `ConfigChange` are **absent**,
   as are `Elicitation`/`ElicitationResult`, `TaskCreated`/`TaskCompleted`,
   `WorktreeCreate`/`WorktreeRemove`, `StopFailure`, `InstructionsLoaded`,
   `CwdChanged`, `FileChanged`, `PostCompact` — all events we *do* emit. A Claude
   plugin naming any of them is rejected `plugin.hooks.unsupported_event`. Task 5
   therefore widens the plugin-facing union to the events we emit (14 → 28 of 30)
   in addition to the `Elicitation` alias and the two deferrals.

Architectural facts (they bound Task 3/4, recorded here so the reviewer sees the
reason and not a silent omission):
5. **Pi's lifecycle-bridge emit is one-way.** `packages/pi-agent-server/src/extensions/lifecycle-bridge.ts`
   emits through `send({ type: 'automation_event', … })` (`index.ts:1486`), and
   `pi-agent.ts:2004` handles it with `void this.emitAutomationEvent(...)`. There
   is no response channel, unlike `pre_tool_use_request` / `post_tool_use_request`.
   So on Pi, `UserPromptSubmit`, `UserPromptExpansion`, `PostToolBatch` and
   `PreCompact` **cannot** act on a block without a new IPC request/response pair.
   Task 3 acts on the sites that do have a channel and records this gap with the
   wire it needs; the Claude-SDK path (`buildSdkHooks` → `automationResultToSdkHookResult`)
   already honours these blocks natively, so the decision layer is not inert.
6. **`Stop` has no turn-continuation mechanism.** `pi-agent.ts:5893` fires Stop
   fire-and-forget after the turn ends; codex/nestor await it only for ordering.
   "Block continues the turn with the reason injected" would need a self-re-prompt
   loop plus the documented 8-consecutive-block cap. Task 3 delivers the half that
   is provable now — the reason reaches the model as one-shot next-turn context via
   the existing `_sessionHookContext` mechanism — and defers auto-continuation.
7. **`WorktreeCreate` fires after the worktree exists.** `worktree-lease-service.ts:79`
   `notifyCreated` runs post-`git.create`; the path is chosen by `policy.select`
   (`SessionManager.ts:8107`). Honouring a returned path requires moving the
   emission to before creation and giving the emit callback a return value. Task 4
   does exactly that and updates the contract's `ordering` text.
8. `TaskCreated`/`TaskCompleted` have no plugin-facing spelling, so their
   exit-code-only tests use the native/stored config shape.

- [x] **Step 2:** Correct this plan in place; say what changed in the Task 1 commit body.

### Task 2: The per-event decision contract + universal output fields

**Files:**
- Modify: `packages/shared/src/automations/hook-command.ts` (parse + cap)
- Create: `packages/shared/src/automations/hook-decision-contract.ts`
- Test: `packages/shared/src/automations/hook-command.test.ts` (colocated — R22 corrected this path) and a new colocated test for the contract module

**Interfaces:**
- Produces `HOOK_DECISION_PATTERN: Readonly<Record<AgentEvent, 'top-level' | 'hook-specific' | 'exit-code-only' | 'path-return' | 'context-only'>>` and `hookDecisionPattern(event): …`.
- Produces `parseHookOutputForEvent(stdout: string, event: AgentEvent): { universal: HookUniversalOutput; pattern: …; payload: … }` where `HookUniversalOutput = { continue?: boolean; stopReason?: string; suppressOutput?: boolean; systemMessage?: string; terminalSequence?: string }`.

Documented pattern assignment — implement exactly this table, citing hooks.md:
- **top-level** (`decision: "block"` + `reason`): `UserPromptSubmit`, `UserPromptExpansion`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `SubagentStop`, `ConfigChange`, `PreCompact`.
- **hook-specific** (`hookSpecificOutput`, per-event shape): `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse` (`updatedToolOutput` — yes, `PostToolUse` speaks both), `MessageDisplay` (deferred), `Elicitation`, `ElicitationResult`.
- **exit-code-only** (exit 2 or `continue: false`, **no `decision` field at all**): `TaskCreated`, `TaskCompleted`, `TeammateIdle` (deferred).
- **path-return**: `WorktreeCreate`.
- **context-only**: `SessionStart`, `Setup`, `SubagentStart`.

Universal semantics: `continue: false` **takes precedence over any event-specific decision field**; `stopReason` is shown to the user and NOT to the model; `suppressOutput` hides stdout from the transcript; `systemMessage` warns the user; `terminalSequence` is restricted to OSC 0/1/2/9/99/777 and BEL — anything else means the field is ignored entirely (not sanitised).

- [ ] **Step 1: Write the failing tests** — table-driven:

```ts
test.each([
  ['UserPromptSubmit', 'top-level'], ['PostToolUse', 'top-level'], ['Stop', 'top-level'],
  ['PreToolUse', 'hook-specific'], ['PermissionRequest', 'hook-specific'],
  ['TaskCreated', 'exit-code-only'], ['TaskCompleted', 'exit-code-only'],
  ['WorktreeCreate', 'path-return'], ['SessionStart', 'context-only'], ['Setup', 'context-only'],
])('%s speaks the %s pattern', (event, pattern) => {
  expect(hookDecisionPattern(event)).toBe(pattern);
});

test('continue:false wins over an event-specific decision', () => {
  const out = parseHookOutputForEvent('{"continue":false,"stopReason":"halt","decision":"block","reason":"r"}', 'Stop');
  expect(out.universal.continue).toBe(false);
  expect(out.universal.stopReason).toBe('halt');
});

test('every output string is capped at 10000 characters', () => {
  const long = 'x'.repeat(10_050);
  const out = parseHookOutputForEvent(JSON.stringify({ systemMessage: long, stopReason: long }), 'Stop');
  expect(out.universal.systemMessage).toHaveLength(10_000);
  expect(out.universal.stopReason).toHaveLength(10_000);
});

test('terminalSequence outside the OSC allowlist is ignored whole', () => {
  const out = parseHookOutputForEvent('{"terminalSequence":"\\u001b]4;evil\\u0007"}', 'Stop');
  expect(out.universal.terminalSequence).toBeUndefined();
});

test('an exit-code-only event ignores a decision field', () => {
  const out = parseHookOutputForEvent('{"decision":"block","reason":"nope"}', 'TaskCreated');
  expect(out.payload).toEqual({});      // no decision surface on this pattern
});
```

- [x] **Step 2:** Run: `bun test ./packages/shared/src/automations/hook-command.test.ts` — FAIL.
- [x] **Step 3:** Implement the contract module + parser. Keep `getHookCommandPreToolDecision` working byte-identically for `PreToolUse` (its suite must not change) — the new function wraps, it does not replace.
- [x] **Step 4:** Run — PASS. `bun run typecheck:shared`. Commit: `feat(hooks): per-event decision contract and universal hook output fields`

**Task 2 execution record.** The contract module landed in Step 0; this task added
the parser half. Deviations:
- `HookUniversalOutput` lives in `automations/types.ts`, not `hook-command.ts`:
  `AgentEventExecutionResult` carries it and `types.ts` cannot import from
  `hook-command.ts` without a cycle.
- `parseHookOutputForEvent` is **wired into both execution paths in this task**,
  not deferred to Task 3. Landing a parser no production path calls is the exact
  inert-code failure this plan exists to correct, so `executePluginHookAutomations`
  and `AutomationSystem.executeAgentEvent` now merge `universal` into
  `AgentEventExecutionResult` and apply `continue: false` as the documented
  override. Task 3 consumes it at the emission sites.
- `continue: false` also forces a `block` on the exit-code-only pattern, which has
  no `decision` field: `continue` is universal, so the stop must reach events whose
  only documented lever it is. `stopReason` is never copied into `reason` (it is
  the user-facing half), pinned by its own test.
- The 10 000-char cap is applied in one helper (`hookOutputField`) used by both
  the JSON field extraction and the exit-code reason builders. It is independent
  of the pre-existing 8 192-byte stdout/stderr capture cap.
- `mergeHookUniversalOutputs` defines multi-hook merge: `continue: false` and
  `suppressOutput: true` are sticky, and the first author of each user-facing
  string keeps it.

### Task 3: Apply the top-level `block` pattern on the nine events

**Files:**
- Modify: `packages/shared/src/plugins/hooks-automation.ts` (the per-event application loop) **and** `packages/shared/src/capabilities/runtime-automations.ts` if the field must reach the live path — check both, per Task 1's warning
- Modify: the emission sites that can act on a block: `packages/shared/src/agent/base-agent.ts` / `SessionManager.ts` for `UserPromptSubmit` (refuse the turn with the reason fed back), `Stop`/`SubagentStop` (reason fed back, turn continues per docs), `PostToolUse`/`PostToolUseFailure` (reason fed back to the model), `ConfigChange`, `PreCompact`
- Test: the hooks-automation suite + one emission-site test per acted-on event

Semantics (docs): a `decision: "block"` on these events feeds `reason` back to the model rather than cancelling a tool call. `Stop`/`SubagentStop` continue with the reason injected — that is the documented "keep going, here is why" channel. `UserPromptSubmit` blocking **ends the turn** (`PostToolBatch`/`UserPromptSubmit`/`UserPromptExpansion` "end the turn on `decision: block` regardless of `continue`" — R22's doc-verification recorded this). Everything else is advisory.

Consume R22's `continueOnBlock` here: default `false`; `true` maps to `continue: true` on the resulting block (the field R22 stored and pinned inert).

- [x] **Step 1:** Failing tests, one per acted-on event: a blocking hook's reason reaches the model; `UserPromptSubmit` block ends the turn even with `continue: true`; `Stop` block continues with the reason; `continueOnBlock: true` on a prompt hook makes an otherwise-terminal block non-terminal; an event NOT in the nine ignores a top-level `decision`.
- [x] **Step 2:** Implement. Every acted-on block writes a receipt naming the hook (reuse the plugin-hook receipt shape).
- [x] **Step 3:** Suites + typecheck. Commit: `feat(hooks): honour the documented block decision on the nine top-level events`

**Task 3 execution record.** `hookBlockEndsTurn(event, continueRequested)` encodes
the documented matrix in ONE place; `continueOnBlock` now compiles to
`continue: true` on the resulting block exactly as hooks.md specifies, so R22's
stored-inert field is live.

Acted on (sites that own a channel):
- `PostToolUse` / `PostToolUseFailure` — pi-agent `handlePostToolUseRequest`: the
  block reason is appended to the tool result the model sees, layered on top of an
  `updatedToolOutput` rewrite rather than replacing it.
- `UserPromptSubmit` — codex-agent and nestor-cloud-agent: the block ends the turn
  with the reason and the prompt never reaches the model, `continue: true`
  notwithstanding.
- `Stop` / `SubagentStop` / `ConfigChange` — these fire when no tool result is
  open, so `BaseAgent.recordHookBlockFeedback` queues the reason and
  `PiAgent.buildTurnUserMessage` delivers it once on the next turn's volatile
  tail (never the system prefix — that is pi-ai's cache prefix, #862).
  `SubagentStop` routes to the PARENT agent from `SessionManager`, the only
  session still able to act on it.

Deviations, each with its reason:
- **`Stop` does not re-run the turn.** Docs: a blocking Stop hook continues the
  turn with the reason injected. We have no self-re-prompt loop (Task 1 fact 6),
  so the provable half landed — the reason reaches the model on the next turn —
  and auto-continuation is deferred. The documented 8-consecutive-block override
  IS implemented, as the bound on how many times a blocking hook's reason may be
  re-delivered before it is ignored, with a non-blocking result resetting the
  streak. (The fixed `MAX_CONSECUTIVE_HOOK_BLOCKS` constant named here was
  replaced by the env-configurable `resolveStopHookBlockCap` in R84, 2026-08-07.)
- **`UserPromptExpansion`, `PostToolBatch`, `PreCompact` are not acted on**, and
  `UserPromptSubmit` is not acted on for Pi: all four are emitted inside the Pi
  subprocess through the one-way `automation_event` sink (Task 1 fact 5). Acting on
  them needs a new IPC request/response pair mirroring `pre_tool_use_request` —
  named here as the concrete follow-up rather than faked. The Claude-SDK hook path
  honours all of them today via `automationResultToSdkHookResult`.
- **`ConfigChange` blocking is advisory.** The config is already committed when the
  event fires and hooks.md exempts managed `policy_settings` from blocking, so the
  block is receipted (`__HOOK_BLOCK__`) and fed back, not rolled back.
- **Receipts name the event, not the hook.** Same reason R15 recorded for
  `__PERMISSION_UPDATE__`: `AgentEventExecutionResult` carries `matchedCount`
  only, so no single hook identity is attributable at the application site.
- `PiAgent.buildTurnUserMessage` was extracted from `chatImpl` so the one-shot
  delivery is unit-testable. `chatImpl` cannot reach its `send` without a pinned
  capability turn, and stubbing five internals to fake one would be exactly the
  "test above the layer" pattern that hid the band bug.

### Task 4: `PostToolUse` result rewriting + `PermissionDenied` retry + `WorktreeCreate` path return

**Files:**
- Modify: `hooks-automation.ts` / `runtime-automations.ts` (both paths), the `PostToolUse` emission site, the `PermissionDenied` site R15 added, `WorktreeLeaseService`'s event site
- Test: the respective suites

Three small, independent shapes:
1. **`updatedToolOutput`** (all tools) — replaces the tool result the model sees. **Built-in tools: a value that does not match the tool's output schema is ignored and the original output is used.** Implement the schema check for our built-ins (we have the tool manifest; a mismatch is silent-ignore + one info diagnostic). `updatedMCPToolOutput` is documented as deprecated on the SDK page — do NOT implement it; record the refusal.
2. **`PermissionDenied` → `hookSpecificOutput.{retry: true}`** — re-runs the permission decision once. Cap at ONE retry per tool call and pin that with a test; an unbounded retry is a prompt loop.
3. **`WorktreeCreate` path return** — `command` hooks: last non-empty stdout line, ANSI-stripped. `http` hooks: `hookSpecificOutput.worktreePath`. **`mcp_tool` hooks have no documented return channel on this event** — accept the hook, ignore any path, emit an info diagnostic. Refuse a returned path containing `.`/`..` segments or traversing a symlink below the repo root (documented refusals — reuse `canonicalDeniedReadRoot`-style resolution).

- [x] **Step 1:** Failing tests: a `PostToolUse` hook rewrites what the model sees; a schema-mismatching value on a built-in is ignored with the original preserved; `retry: true` re-runs the decision exactly once; a second `retry` is refused; a `WorktreeCreate` command hook's last stdout line becomes the path; `../escape` is refused; an `mcp_tool` hook on that event returns no path with a diagnostic.
- [x] **Step 2:** Implement. **Step 3:** Suites + typecheck. Commit: `feat(hooks): tool-output rewriting, permission retry and worktree path return`

**Task 4 execution record.**
- **`updatedToolOutput` built-in check.** Our built-ins declare no JSON output
  schema — their results travel the Pi wire as text — so the enforceable reading
  of "a value that doesn't match the tool's output schema is ignored and the
  original output is used" is the shape the result actually has:
  `resolveHookToolOutputRewrite` requires a string, and when the ORIGINAL result
  is a JSON envelope it requires the replacement to still be parseable JSON of
  the same top-level kind. MCP results are exempt (the docs scope the constraint
  to built-ins). A rejection is silent to the model plus one
  `__HOOK_OUTPUT_IGNORED__` line. `updatedMCPToolOutput` is **refused** as
  deprecated, recorded in the parser.
- **`PermissionDenied` retry** fires BEFORE the deny reply (otherwise the deny is
  already on the wire and no retry is possible) and exactly once per tool call,
  bounded by a `let` scoped to the request so the budget cannot leak or be reset
  by the re-entrant retry. The re-run goes through the full gate, so the deny
  floor is untouched: only state a hook changed out of band can flip the outcome.
  R15's "fire-and-forget after the reply" ordering therefore changed, which is
  the point of the task; its three existing tests stayed green.
- **`WorktreeCreate` path return** moved the emission to before `git.create`
  (`applyWorktreeCreateHookPath`), since the path can only be replaced while it
  is still a proposal, and `notifyCreated` is gone. The contract's `ordering`
  text is updated; `kind` deliberately stays `observational` — that field means
  "can block or bypass a permission receipt" (pinned by the Pi lifecycle
  frozen-contract test) and a path return does neither.
- The `plugin.hooks.worktree_path_channel_unavailable` diagnostic for `mcp_tool`
  and `http` hooks is registration-time, where the hook type and the diagnostics
  channel both exist (`executePluginHookAutomations` has neither). Its test lands
  in Task 5, which is what makes `WorktreeCreate` a mappable plugin event at all.

### Task 5: Event-name and breadth corrections

**Files:**
- Modify: `packages/shared/src/automations/types.ts` (`AGENT_EVENT_CONTRACTS_V1`), `packages/shared/src/plugins/format-adapters.ts` (the Claude/Codex event maps), `packages/shared/src/plugins/hooks-runtime.ts` if the union changes
- Test: the adapter and contract suites

- **`Elicitation`**: Claude's name for what we call `McpElicitation`. Accept `Elicitation` as the imported spelling mapping to our existing event (adapter-level alias, no contract rename — a rename would break stored automations). Same for `ElicitationResult`, which we already name identically.
- **`MessageDisplay`**: not implemented, **deferred to R30** — add a deferral entry so an importing plugin sees why (`plugin.deferred.event_message_display_unsupported`) rather than installing a hook that never fires. Record the 10s timeout fact in the deferral comment.
- **`TeammateIdle`**: same treatment, **deferred to R23** (`plugin.deferred.event_teammate_idle_unsupported`).
- Keep `McpResult` — it is ours, not Claude's, and nothing in the docs contradicts it.

- [x] **Step 1:** Failing tests: a Claude bundle declaring `Elicitation` imports and maps to the existing event; a bundle declaring `MessageDisplay` or `TeammateIdle` imports as a deferral with the right reason code and creates NO executable capability; stored automations naming `McpElicitation` still load.
- [x] **Step 2:** Implement. Commit: `feat(plugins): accept Elicitation, defer MessageDisplay and TeammateIdle`

**Task 5 execution record.** Beyond the planned alias + two deferrals, this task
also closed the breadth gap Task 1 found: `PluginHookEventName` went from 16
members / 14 Claude names to **30 / 28** (the 28 documented events we emit, plus
our own `McpServerStart`/`McpToolCall`), with matching entries in
`PLUGIN_HOOK_EVENT_TO_AGENT_EVENT`, `CLAUDE_HOOK_EVENT_MAP` and
`CODEX_HOOK_EVENT_MAP`. Before this, a Claude plugin binding to
`UserPromptExpansion`, `PostToolBatch`, `ConfigChange`, `WorktreeCreate`,
`TaskCreated`/`TaskCompleted`, `FileChanged`, `CwdChanged`, `StopFailure`,
`InstructionsLoaded` or `PostCompact` — all events we DO emit — was rejected
`plugin.hooks.unsupported_event`. That also makes Task 4's
`worktree_path_channel_unavailable` diagnostic reachable, so its test landed here.

- `Elicitation` → `McpElicitation` is an adapter-level alias in both dialects; the
  contract name is untouched, pinned by a test that a stored automation naming
  `McpElicitation` still registers.
- `MessageDisplay` → `plugin.deferred.event_message_display_unsupported` (R30) and
  `TeammateIdle` → `plugin.deferred.event_teammate_idle_unsupported` (R23) now
  travel as ROUTED deferrals rather than the generic
  `claude_hook_event_unsupported`, and `mapExternalHookEventName` no longer emits
  an "unknown event" warning for them — they are documented, not typos. The
  10s-not-600s `MessageDisplay` timeout fact is recorded in the deferral comment
  so R30 does not re-derive it.
- The Codex adapter builds its deferred list from diagnostics, not a passed array,
  so its routing rides a new `plugin.format.codex_hook_event_deferred` diagnostic
  mapped in `codexDeferredEntryFor` — same visibility, that adapter's mechanism.
- The pre-existing "not-yet-emitted Claude hook event" test used `PostCompact` as
  its fixture, which this task makes supported; it was retargeted onto the two
  real deferrals rather than deleted.

### Task 6: Close-out

- [x] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, the server-core suite, `bun run lint`, `git diff --check`.
- [x] **Step 2:** Mutation probes: (a) drop the 10 000-char cap → the cap test must fail; (b) let an exit-code-only event honour `decision` → the TaskCreated test must fail; (c) allow a second `PermissionDenied` retry → the one-retry test must fail; (d) accept a schema-mismatching `updatedToolOutput` on a built-in → that test must fail. Restore all four.
- [x] **Step 3:** Report.

## Close-out evidence (2026-07-27, executor)

**Commits:** Task 0 Step 0 `dc2250d5`; Task 1 `108906b1`; Task 2 `4e28febf`;
Task 3 `3124e730`; Task 4 `60ca6d5a`; Task 5 `c63a64f5`; Task 6 probe-C fix +
close-out (this commit).

**Gates (at `c63a64f5`):** `bun run typecheck:all` exit 0 (all 8 packages).
`bun run test:shared:all` exit 0, 139 pass / 0 fail across its 4 sub-suites.
Repo-wide `bun test` **8089 pass / 18 skip / 0 fail** across 744 files (200s).
`bun run lint` exit 0 — 118 + 4 pre-existing warnings, 0 errors, none in any file
this plan touched (verified by grepping the changed-file list against the report).
`git diff --check` clean. Re-verified after the probe-C fix: `typecheck:all` exit 0
and 2895 pass / 0 fail across the agent, automations, plugins, sessions and
pi-harness suites.

**Mutation probes — three killed immediately, one exposed a real defect:**
- (a) `HOOK_OUTPUT_FIELD_LIMIT` → `MAX_SAFE_INTEGER`: `every output string is
  capped at 10000 characters` FAILED (expected 10000, received 10050). 27/1.
- (b) exit-code-only events given `BLOCK_VALUES`: **6** tests failed across three
  suites, including the pre-existing `keeps the observational hooks
  non-decision-bearing even on non-zero exit`. 98/6.
- (c) **The first attempt did NOT kill the test — the cap was not load-bearing.**
  Flipping `permissionDeniedRetryUsed` to `false` changed nothing, because the
  still-denied retry path fell through instead of re-dispatching, so a second
  consult was unreachable and the "cap" was decorative. Fixed rather than
  explained away: the retry now re-dispatches through `authorizeAndSend` on
  `block` as well (the model is told the RETRY's reason, not the stale one), and
  `MAX_PERMISSION_DENIED_RETRIES = 1` is the only thing that terminates the loop.
  Re-probed at 2 → `refuses a second retry for the same tool call` FAILED
  (expected 1, received 2). 37/1.
- (d) `resolveHookToolOutputRewrite` accepting any string: `ignores a replacement
  that breaks a built-in JSON result` FAILED. 31/1.
All four restored; `git status` shows only the intended probe-C fix, and the
changed hunk contains no probe residue.

**Follow-ups:**
- `MessageDisplay` → **R30** (`plugin.deferred.event_message_display_unsupported`;
  the 10s-not-600s timeout is recorded at the deferral).
- `TeammateIdle` → **R23** (`plugin.deferred.event_teammate_idle_unsupported`).
- `updatedMCPToolOutput` **refused** as deprecated on the SDK page, recorded in
  the parser.
- Settings-file `updatedPermissions` destinations still → **R25** (R15's follow-up,
  untouched here).
- **New, and the largest remaining gap: Pi's lifecycle-bridge sink is one-way.**
  `UserPromptSubmit`, `UserPromptExpansion`, `PostToolBatch` and `PreCompact` are
  emitted inside the Pi subprocess through `send({type:'automation_event'})`, which
  has no reply, so their documented blocks cannot take effect on that backend.
  The fix is an `automation_event_request`/`automation_event_response` pair
  mirroring `pre_tool_use_request`, with the bridge's `emit` returning the
  decision. Needs its own R-item.
- `Stop` auto-continuation (re-prompting the agent with the block reason instead of
  delivering it on the next turn) needs a continuation loop plus the documented
  8-consecutive-block turn-ending override. The re-delivery bound is implemented;
  the loop is not.
- `Elicitation`/`ElicitationResult` `{action, content}` needs an elicitation
  response channel → **R24**. The pattern is recorded; the surface is context-only.

**CDP cases for the planning session to verify live (pass 4):**
1. **The band now takes effect through the plugin path** — a `PermissionRequest`
   command hook returning `hookSpecificOutput.decision.behavior: "allow"` must
   suppress the prompt (the exact case pass 3 proved inert), and a `deny` with
   `interrupt: true` must deny and abort the turn.
2. **A blocking `Stop` hook's reason reaches the model** — a `Stop` hook returning
   `{"decision":"block","reason":"…"}` must put that reason in the NEXT turn's
   context (once, not repeatedly), and stop being delivered after 8 consecutive
   blocks.
3. **A `PostToolUse` rewrite changes what the model sees** — `updatedToolOutput`
   replaces the tool result, and a `decision: "block"` with a reason appends that
   reason to it. Also verify the negative: a value that breaks a built-in's JSON
   result is ignored and the original survives.
4. `WorktreeCreate`: a command hook's last stdout line becomes the worktree path,
   and `../escape` falls back to the policy path.
5. A Claude plugin declaring `Elicitation` installs and binds; one declaring
   `MessageDisplay` installs as a deferral with no executable hook.
