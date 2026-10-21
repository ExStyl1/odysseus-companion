> **CLOSED 2026-07-26.** Executed and verified; evidence recorded in the parity audit §0 (R22).
> Kept until the end-of-series sweep. Do not execute again.

# Hook Type Contract (R22) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the R22 gap — bring imported hooks up to Claude's documented type contract: the per-event type-support matrix, the `defer` decision, the `async`/`once`/`statusMessage`/`if` common fields, HTTP env interpolation with its two managed containment keys, and a real (blocking) prompt-hook decision path.

**Architecture:** Everything lands on existing seams. Import-time rules go in the Claude adapter (`normalizeClaudeHookEntry`); runtime semantics go in the automation execution path (`hooks-automation.ts` / `runtime-automations.ts`); enforcement keys extend `ManagedPiPolicyV1` exactly the way P10's `channelsEnabled`/`sandbox` did; the prompt-hook decision runner is an injected authority like the existing `httpRunner`/`agentRunner` — absent runner means the current observational behaviour, so nothing widens by default.

**Tech Stack:** TypeScript, Bun test, zod-free hand validators (matching the existing plugin schema style).

**Contract source:** `code.claude.com/docs/en/hooks.md` + `settings-reference.md#hook-configuration` (the section moved off `settings.md` when that page split; re-pointed 2026-09-11), re-fetched 2026-07-26. (Re-checked 2026-08-25: that anchor still resolves, but `settings.md` now keeps it only as a redirect stub at the top of the page — the hook keys are documented at `settings-reference.md#hook-configuration`.) The distilled contract lives in `docs/superpowers/specs/2026-07-26-r-queue-doc-verification.md` § R22 — read it before starting. Cite `hooks.md` in commit bodies.

## Global Constraints

- Scope: Pi runtime + app. Claude/Codex runtimes are flag-off; do not touch them.
- One commit per task. No `Co-Authored-By` trailers. Do not create MRs or tags.
- Do not touch `docs/superpowers/specs/` — the planning session owns those files.
- Verification per the Implementation-First Verification Budget: focused suites + affected-package typecheck during the loop; full gates only at close-out.
- Every new runtime authority must be injected (runner pattern), never ambient.
- Deliberate differences to KEEP (do not "fix"): our 60s hook-timeout ceiling stays (Claude's 600s default exceeds it — we clamp, record, and move on); `MessageDisplay` is undocumented in Claude's own type table and we do not have the event — nothing to do here.
- Deliberate deferrals: `asyncRewake` (idle-session wake) is R3's mechanism — import it, store it, defer its wake semantics to R3 with a reason code; full `if` evaluation is R1's parser — this plan imports and stores `if` and fails open per the documented contract ("The filter also fails open ... use the permission system rather than a hook to enforce a hard allow or deny").

---

### Task 0: Pre-phase — fold in R21 close-out follow-ups

**Files:** none yet — this task exists because the operating loop requires out-of-plan fixes to enter the next plan as a pre-phase.

- [x] **Step 1:** Read the R21 executor's close-out report (the planning session will have appended its evidence to §0 of the audit). If it names follow-up fixes that touch the hook/automation/policy files this plan edits, do them FIRST as their own commits, before Task 1. If it names none, record "no R21 follow-ups" in your first commit body and move on.

### Task 1: Re-verify the plan against current code

**Files:** read-only pass over every file named below.

- [x] **Step 1:** Confirm the anchors still hold (they were verified 2026-07-26 at `3fc5285c`):
  - `packages/shared/src/plugins/format-adapters/claude.ts:654-670` — `normalizeClaudeHookEntry` type dispatch, `mcp_tool`→`mcp` mapping, unknown types deferred.
  - `packages/shared/src/plugins/types.ts:156-178` — `PluginHookDescriptor` already carries `type/matcher/command/args/timeoutMs/statusMessage/cwd/prompt/agentName`.
  - `packages/shared/src/capabilities/resolver.ts:269-285` — `RuntimeHookRegistration` mirrors it.
  - `packages/shared/src/automations/hook-command.ts:100-137` — decision vocabulary `['allow','ask','block','deny']` top-level, nested `permissionDecision` accepts `deny|allow|ask`; **`defer` is silently ignored on both paths today.**
  - `packages/shared/src/plugins/hooks-automation.ts:600-749` — runner injection points (`agentRunner`, `mcpToolRunner`, `httpRunner`), prompt hooks observational at `:648-655`, http guard `isSafePluginHookHttpUrl` + `isCredentialBearingPluginHttpDescriptor` at `:687-700`.
  - `packages/shared/src/capabilities/runtime-automations.ts:146-184` — `pluginHookAction` five-type dispatch.
  - `packages/shared/src/agent/pi-harness/managed-policy.ts:10-55` — `ManagedPiPolicyV1` strict keys; R21 added `autoMode`; the loader is `packages/server-core/src/pi-harness/managed-policy-loader.ts` and MUST keep failing closed.
  - `packages/server-core/src/sessions/SessionManager.ts:3966` — the http hook runner (receipt-writing enforcement point).
- [x] **Step 2:** If any anchor moved, correct the task text in this file in place (executors may edit plan files; the spec stays planner-owned), say what changed in the Task 1 commit body (docs-only commit permitted for the plan file), and only then continue.

### Task 2: Pin `defer` and the unknown-decision contract

**Files:**
- Modify: `packages/shared/src/automations/hook-command.ts:100-137`
- Test: `packages/shared/src/automations/hook-command.test.ts` (extend the existing decision-parse suite; colocated, not under `__tests__/`)

**Interfaces:**
- Consumes: `getHookCommandPreToolDecision` / the candidate-collection block at `:104-122`.
- Produces: unchanged signatures; `defer` documented as an explicit no-decision.

Claude's contract: `permissionDecision: "defer"` means "this hook declines to decide — continue normal permission evaluation". Ignoring the word already produces that behaviour by accident; pin it so a refactor cannot turn `defer` into a dropped/deny.

- [x] **Step 1: Write the failing tests** — table-driven, both spellings:

```ts
test('permissionDecision defer is an explicit no-decision, not a deny', () => {
  const out = parseForTest({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer' } });
  expect(out?.decision).toBeUndefined();
});

test('top-level decision defer is an explicit no-decision', () => {
  const out = parseForTest({ decision: 'defer' });
  expect(out?.decision).toBeUndefined();
});

test('defer alongside additionalContext keeps the context', () => {
  const out = parseForTest({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'defer', additionalContext: 'ctx' },
  });
  expect(out?.decision).toBeUndefined();
  expect(out?.additionalContext).toBe('ctx');
});
```

(Use the file's existing helper for invoking the parser; if none exists, call `getHookCommandPreToolDecision` with a stub action and a result whose stdout is the JSON above and exitCode 0.)

- [x] **Step 2:** Run: `bun test packages/shared/src/automations/hook-command.test.ts` — expect the new tests to pass or fail depending on current accidental behaviour; if they already pass, the change is comment + explicit branch only (still commit — the pin is the deliverable).
- [x] **Step 3:** Make `defer` explicit in the parser: add `'defer'` handling that records nothing but is named, with a comment citing hooks.md ("defer — continue normal permission evaluation"):

```ts
// 'defer' (hooks.md) is an explicit no-decision: the hook declines and normal
// permission evaluation continues. Named here so a refactor cannot reclassify
// it as unknown-word (dropped) or, worse, a deny.
if (nested === 'defer' || parsed.decision === 'defer') {
  // no candidate pushed, deliberately
}
```

- [x] **Step 4:** Run the same suite — PASS. `bun run typecheck:shared`.
- [x] **Step 5:** Commit: `fix(hooks): pin 'defer' as an explicit no-decision in hook output`

### Task 3: Enforce the per-event type-support matrix at import

**Files:**
- Modify: `packages/shared/src/plugins/format-adapters/claude.ts` (inside `normalizeClaudeHookEntry`, after the `mapped.event` resolution at `:671-680`)
- Test: `packages/shared/src/plugins/__tests__/format-adapters.test.ts` (extend alongside the existing B1/B2 hook tests; there is no separate `format-adapters-claude.test.ts`)

**Interfaces:**
- Consumes: `mapped.event` (a `PluginHookEventName`), `hookType` (already normalized, `mcp` = Claude's `mcp_tool`).
- Produces: deferral entries `{ externalKind: 'hook-type-<type>-on-<event>', reasonCode: 'plugin.deferred.claude_hook_type_unsupported_event' }`.

Contract (hooks.md, verbatim): "`SessionStart` and `Setup` support `command` and `mcp_tool` hooks. They don't support `http`, `prompt`, or `agent` hooks." Claude never runs them; importing them as executable capabilities would make us run something the author never saw run.

- [x] **Step 1: Write the failing test:**

```ts
test('http/prompt/agent hooks on SessionStart and Setup are deferred, not imported', async () => {
  const bundle = await normalizeFixtureWithHooks({
    SessionStart: [{ hooks: [{ type: 'http', http: { url: 'https://example.com/h' } }] }],
    Setup: [{ hooks: [{ type: 'prompt', prompt: 'check' }, { type: 'agent', agent: 'reviewer' }] }],
  });
  const hookCaps = bundle.capabilities.filter(c => c.kind === 'hook');
  expect(hookCaps).toHaveLength(0);
  const kinds = bundle.report.deferred.map(d => d.externalKind).sort();
  expect(kinds).toEqual([
    'hook-type-agent-on-Setup',
    'hook-type-http-on-SessionStart',
    'hook-type-prompt-on-Setup',
  ]);
  expect(bundle.report.deferred.every(d => d.reasonCode === 'plugin.deferred.claude_hook_type_unsupported_event')).toBe(true);
});

test('command and mcp_tool hooks on SessionStart still import', async () => {
  const bundle = await normalizeFixtureWithHooks({
    SessionStart: [{ hooks: [{ type: 'command', command: './x.sh' }, { type: 'mcp_tool', server: 's', tool: 't' }] }],
  });
  expect(bundle.capabilities.filter(c => c.kind === 'hook')).toHaveLength(2);
});
```

(Reuse the file's existing hook-fixture helper; every prior hook test builds bundles the same way — copy its construction, do not invent a new harness.)

- [x] **Step 2:** Run: `bun test packages/shared/src/plugins/__tests__/format-adapters.test.ts -t 'SessionStart'` — FAIL (capabilities imported today).
- [x] **Step 3:** Implement, right after the `if (!mapped.event) { ... return; }` block:

```ts
// hooks.md: "SessionStart and Setup support command and mcp_tool hooks. They
// don't support http, prompt, or agent hooks." Claude never runs these; import
// them as report entries only so the author sees why nothing fired.
const RESTRICTED_LIFECYCLE_EVENTS = new Set<PluginHookEventName>(['SessionStart', 'Setup']);
if (RESTRICTED_LIFECYCLE_EVENTS.has(mapped.event) && hookType !== 'command' && hookType !== 'mcp') {
  deferred.push({
    externalKind: `hook-type-${hookType}-on-${mapped.event}`,
    reasonCode: 'plugin.deferred.claude_hook_type_unsupported_event',
  });
  return;
}
```

(Hoist the `Set` to module scope next to the other module constants.)

- [x] **Step 4:** Run the suite — PASS. Then the whole adapter file's suite: `bun test packages/shared/src/plugins/__tests__/format-adapters.test.ts`.
- [x] **Step 5:** Commit: `feat(plugins): enforce Claude's SessionStart/Setup hook-type restriction at import`

### Task 4: Import and honour the common fields — `async`, `once`, `if`; store `asyncRewake`

**Files:**
- Modify: `packages/shared/src/plugins/types.ts:156-178` (`PluginHookDescriptor`)
- Modify: `packages/shared/src/capabilities/resolver.ts:269-285` (`RuntimeHookRegistration`) and the projection code that copies descriptor→registration (follow `statusMessage`, which already flows end-to-end, and mirror it exactly)
- Modify: `packages/shared/src/plugins/format-adapters/claude.ts` (`normalizeClaudeHookEntry` — read the fields)
- Modify: `packages/shared/src/capabilities/runtime-automations.ts:146-184` (`pluginHookAction` — carry onto the command action)
- Modify: `packages/shared/src/plugins/hooks-automation.ts:600-749` (runtime semantics)
- Test: `packages/shared/src/plugins/__tests__/format-adapters.test.ts`, `packages/shared/src/plugins/__tests__/hooks-automation.test.ts`

**Interfaces:**
- Produces: `PluginHookDescriptor` + `RuntimeHookRegistration` gain `async?: boolean`, `asyncRewake?: boolean`, `once?: boolean`, `ifRule?: string`. The command `AutomationAction` gains `async?: boolean` (in `packages/shared/src/automations/types.ts`, next to `blockOnNonZero`).

Semantics being implemented (hooks.md):
- `async: true` — command hooks only; run in the background without blocking; its output is never parsed for a decision. **On blocking events (`PreToolUse`, `UserPromptSubmit`, `PermissionRequest`) an async hook still runs but can never block** — that is the documented effect of not waiting.
- `asyncRewake` — implies `async`; the wake-on-exit-2 half is R3's idle-wake mechanism. Store it, treat it as `async`, and record a deferral diagnostic `plugin.hooks.async_rewake_deferred` so it is visible.
- `once` — honoured only in skill frontmatter per the docs; we have no frontmatter hooks yet, so: import, store, and emit an info diagnostic `plugin.hooks.once_ignored` ("once is honoured for skill-frontmatter hooks only; ignored here" — matching Claude, which ignores it in settings files too).
- `if` — permission-rule filter, tool events only. Import into `ifRule`. At runtime: we have no rule parser until R1, and the documented behaviour on an unparseable rule is fail-open. So: when `ifRule` is present, run the hook and emit an info diagnostic `plugin.hooks.if_deferred` once per registration. R1 replaces the diagnostic with real evaluation.

- [x] **Step 1: Write the failing import test:**

```ts
test('async, asyncRewake, once and if survive import onto the hook descriptor', async () => {
  const bundle = await normalizeFixtureWithHooks({
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh', async: true, once: true, if: 'Bash(git *)' }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: './bg.sh', asyncRewake: true }] }],
  });
  const hooks = bundle.capabilities.filter(c => c.kind === 'hook').map(c => c.hook);
  expect(hooks[0]).toMatchObject({ async: true, once: true, ifRule: 'Bash(git *)' });
  expect(hooks[1]).toMatchObject({ async: true, asyncRewake: true });  // asyncRewake implies async
});
```

- [x] **Step 2:** Run — FAIL. Implement the field reads in `normalizeClaudeHookEntry` (command branch only for `async`/`asyncRewake`; `once`/`if` on all types):

```ts
const asyncRewake = entry.asyncRewake === true;
const asyncFlag = entry.async === true || asyncRewake;
const once = entry.once === true;
const ifRule = stringField(entry, 'if');
```

and spread onto the pushed descriptor: `...(asyncFlag ? { async: true } : {}), ...(asyncRewake ? { asyncRewake: true } : {}), ...(once ? { once: true } : {}), ...(ifRule ? { ifRule } : {})` — command branch gets all four; the other four type branches get only `once`/`ifRule`. Extend `PluginHookDescriptor` and `RuntimeHookRegistration`, and mirror the projection copy the way `statusMessage` flows.

- [x] **Step 3:** Run the import test — PASS. `bun run typecheck:shared`.
- [x] **Step 4: Write the failing runtime test** (in `hooks-automation.test.ts`, alongside the existing command-action tests):

```ts
test('an async command hook fires without blocking and cannot decide', async () => {
  let resolveRun: () => void;
  const gate = new Promise<void>(r => { resolveRun = r; });
  const slowRunner = async () => { await gate; return { exitCode: 0, stdout: '{"decision":"block"}', stderr: '' }; };
  const resultPromise = executePluginAutomationEvent('PreToolUse', input, configWithAsyncCommandHook, { runner: slowRunner, pluginRuntime: true });
  const result = await resultPromise;           // returns without waiting for the gate
  expect(result.decision?.decision).toBeUndefined();
  resolveRun!();                                 // let the background run finish; no unhandled rejection
});

test('an async hook result is never parsed for a decision even after completion', async () => {
  const runner = async () => ({ exitCode: 2, stdout: '', stderr: 'blocked!' });
  const result = await executePluginAutomationEvent('PreToolUse', input, configWithAsyncCommandHook, { runner, pluginRuntime: true });
  expect(result.decision).toBeUndefined();
});
```

(Adapt names to the file's real entry point — the suite already invokes the plugin automation execution path; follow its existing fixtures for `input`/config shape.)

- [x] **Step 5:** Run — FAIL. Implement in the command-action loop of `hooks-automation.ts` (`:703-746`): when `action.async`, call the runner without awaiting the decision path —

```ts
if (action.async) {
  // hooks.md: async command hooks run in the background without blocking and
  // their output is not parsed for a decision. Fire, log failures, move on.
  void runner(action, { event, input: commandInput, cwd: options.workingDir ?? options.workspaceRootPath, ...(options.signal ? { signal: options.signal } : {}) })
    .catch(() => { /* background failure is non-blocking by contract */ });
  continue;
}
```

and carry `async` through `pluginHookAction` in both `runtime-automations.ts` and `hooks-automation.ts` (`pluginHookAction` at `:770-806` — the older projection path — gets the same spread).

- [x] **Step 6:** Run the runtime suite — PASS.
- [x] **Step 7:** Add the two diagnostics (`plugin.hooks.once_ignored` info at registration time where hooks project into automations; `plugin.hooks.if_deferred` info once per registration carrying `ifRule`) — one test each asserting the diagnostic code and that the hook still runs.
- [x] **Step 8:** Focused suites + `bun run typecheck:shared`. Commit: `feat(hooks): import async/once/if common fields and honour async fire-and-forget`

### Task 5: HTTP hook env interpolation + the two managed containment keys

**Files:**
- Modify: `packages/shared/src/plugins/types.ts` (http descriptor gains `allowedEnvVars?: string[]`)
- Modify: `packages/shared/src/plugins/format-adapters/claude.ts:746-770` (read `allowedEnvVars`)
- Modify: `packages/shared/src/agent/pi-harness/managed-policy.ts` (two new strict keys)
- Modify: `packages/server-core/src/pi-harness/managed-policy-loader.ts` (parse them, fail-closed unchanged)
- Modify: `packages/server-core/src/sessions/SessionManager.ts:3966+` (enforce both in the http runner)
- Create: `packages/shared/src/plugins/http-hook-env.ts` (pure interpolation helper)
- Test: `packages/shared/src/plugins/__tests__/http-hook-env.test.ts`, `packages/shared/src/agent/pi-harness/managed-policy.test.ts`, plus the SessionManager orchestration suite for the runner gate

**Interfaces:**
- Produces: `interpolateHttpHookHeaders(headers: Record<string,string>, allowedEnvVars: readonly string[], env: NodeJS.ProcessEnv): Record<string,string>` — `$VAR`/`${VAR}` resolved only for allowed names, unlisted references replaced with `''`.
- Produces: `ManagedPiPolicyV1.allowedHttpHookUrls?: readonly string[]` (wildcard URL allowlist; when defined, non-matching http hooks are silently blocked — matching Claude's wording) and `httpHookAllowedEnvVars?: readonly string[]` (effective allowlist = intersection of the hook's own list and this key).

Contract (settings.md): hostname match case-insensitive; trailing FQDN dot ignored; `*` wildcard segments. These two keys are the SSRF/exfiltration containment for the `http` type — the reason this task exists for a bank fork.

- [x] **Step 1: Failing tests for the helper** (table-driven):

```ts
const cases = [
  { h: { A: 'Bearer $TOKEN' },        allowed: ['TOKEN'], env: { TOKEN: 'x' }, want: { A: 'Bearer x' } },
  { h: { A: 'Bearer ${TOKEN}' },      allowed: ['TOKEN'], env: { TOKEN: 'x' }, want: { A: 'Bearer x' } },
  { h: { A: '$SECRET' },              allowed: [],        env: { SECRET: 's' }, want: { A: '' } },        // unlisted → empty string
  { h: { A: '$TOKEN-$SECRET' },       allowed: ['TOKEN'], env: { TOKEN: 'x', SECRET: 's' }, want: { A: 'x-' } },
  { h: { A: 'no refs' },              allowed: [],        env: {},             want: { A: 'no refs' } },
];
```

- [x] **Step 2:** Run — FAIL (module absent). Implement the helper: one regex pass `/\$\{([A-Z0-9_]+)\}|\$([A-Z0-9_]+)/gi`, allowed set lookup, else `''`.
- [x] **Step 3:** Run — PASS. Commit: `feat(hooks): interpolate allowed env vars into http hook headers`
- [x] **Step 4: Failing tests for the policy keys** in `managed-policy.test.ts` — follow the exact pattern R21's `autoMode` tests use: unknown-key rejection stays intact (`exact()`), both keys parse as string arrays, absence means no constraint.
- [x] **Step 5:** Add the two readonly keys to `ManagedPiPolicyV1` with doc comments naming their Claude settings.md counterparts, parse them in the loader (string-array validation, same style as `allowedChannelServers`). Run — PASS. Commit: `feat(policy): add http-hook URL and env-var containment keys`
- [x] **Step 6: Failing test for the runner gate** (SessionManager orchestration suite): with `allowedHttpHookUrls: ['https://hooks.example.com/*']` a hook to `https://evil.example.net/x` never reaches the webhook executor and writes a `denied` receipt with code `http-hook-url-not-allowed`; a matching URL fires. With `httpHookAllowedEnvVars: ['CI_TOKEN']` and a hook whose own `allowedEnvVars: ['CI_TOKEN','HOME']`, only `CI_TOKEN` resolves.
- [x] **Step 7:** Implement in the http runner: URL allowlist check (case-insensitive hostname, trailing-dot strip, `*` segment wildcard — write `matchesHttpHookUrlPattern` next to the helper from Step 2 and unit-test it in the same file: exact, `*` subdomain segment, case-insensitivity, trailing dot, path prefix) + header interpolation using the intersection. Denied = receipt + no request, silent to the model (matching "silently blocked").
- [x] **Step 8:** Focused suites + `bun run typecheck:server-core` (or the repo's per-package equivalent — check `package.json` scripts). Commit: `feat(sessions): enforce managed http-hook containment in the runner`

### Task 6: Prompt hooks decide — injected LLM runner with observational fallback

**Files:**
- Modify: `packages/shared/src/plugins/hooks-automation.ts` (new optional `promptRunner` on the options object at `:595-618`; decision path at `:646-655`)
- Modify: `packages/shared/src/capabilities/runtime-automations.ts` (carry `continueOnBlock` if declared)
- Modify: `packages/shared/src/plugins/format-adapters/claude.ts:684-702` (read `model`, `continueOnBlock` onto the prompt descriptor)
- Modify: `packages/shared/src/plugins/types.ts` (+`model?: string`, `continueOnBlock?: boolean` on the descriptor)
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (inject the runner next to the existing `httpRunner` construction at `:3966`, built on the session's existing mini-model completion path — find the call site `getMiniModel` imported at `:235` and follow how the guardian judge invokes its completion; reuse that, never a new client)
- Test: `packages/shared/src/plugins/__tests__/hooks-automation.test.ts` + one orchestration test

**Interfaces:**
- Produces: `type PluginPromptHookRunner = (request: { prompt: string; model?: string; event: AgentEvent; input: unknown; signal?: AbortSignal }) => Promise<{ ok: boolean; reason?: string } | undefined>`
- Semantics (hooks.md): the model answers allow/deny; `ok:false` → `decision: 'block'` with `reason`. On `PreToolUse` it denies. `continueOnBlock` (default false) maps to `continue: true` on the resulting block — for us: the block stands but is non-terminal, i.e. merge as an ordinary deny rather than a turn-ender (our automation merge already distinguishes only via decision value — so `continueOnBlock` changes nothing today; store it and pin that in a test with a comment, so R9's per-event matrix work has the field). On `PermissionRequest` the output is discarded (docs: "their output is discarded") — keep prompt hooks observational there.
- Fallback: no `promptRunner` injected → exactly today's behaviour (`additionalContext` injection). This is the no-new-ambient-authority rule.

- [x] **Step 1: Failing runtime tests:**

```ts
test('a prompt hook with a runner returning ok:false blocks PreToolUse', async () => {
  const promptRunner = async () => ({ ok: false, reason: 'policy says no' });
  const result = await executePluginAutomationEvent('PreToolUse', input, configWithPromptHook, { promptRunner, pluginRuntime: true });
  expect(result.decision?.decision).toBe('block');
  expect(result.decision?.reason).toContain('policy says no');
});

test('a prompt hook with a runner returning ok:true does not block and injects nothing', async () => {
  const promptRunner = async () => ({ ok: true });
  const result = await executePluginAutomationEvent('PreToolUse', input, configWithPromptHook, { promptRunner, pluginRuntime: true });
  expect(result.decision?.decision).toBeUndefined();
});

test('without a runner, prompt hooks stay observational additionalContext', async () => {
  const result = await executePluginAutomationEvent('PreToolUse', input, configWithPromptHook, { pluginRuntime: true });
  expect(result.decision?.additionalContext).toBeDefined();
  expect(result.decision?.decision).toBeUndefined();
});

test('on PermissionRequest a prompt-hook decision is discarded', async () => {
  const promptRunner = async () => ({ ok: false, reason: 'no' });
  const result = await executePluginAutomationEvent('PermissionRequest', permInput, configWithPromptHookOnPermissionRequest, { promptRunner, pluginRuntime: true });
  expect(result.decision?.decision).toBeUndefined();
});
```

- [x] **Step 2:** Run — FAIL. Implement: in the prompt-action loop, when `options.promptRunner` is present and the event is not `PermissionRequest`, await the runner (bounded by the hook's clamped timeout — reuse `clampTimeout` semantics; 30s default for prompt hooks) and merge `ok:false` as `{ decision: 'block', reason }`; `ok:true`/`undefined` merges nothing. Runner absent → existing `additionalContext` path unchanged.
- [x] **Step 3:** Run — PASS. `bun run typecheck:shared`.
- [x] **Step 4:** Inject the production runner in SessionManager: prompt goes to the mini-model completion with the hook input JSON substituted for `$ARGUMENTS` (hooks.md placeholder — implement the substitution: `prompt.replaceAll('$ARGUMENTS', JSON.stringify(hookInputJson))`, backslash-escaped `\$ARGUMENTS` left literal), parse the strict `{ok, reason}` JSON response, `undefined` on parse failure (fail-open: a broken judge must not block every tool call — same posture as the guardian judge's error path; verify that posture in `SessionManager.ts:8732`'s error handling and match it). Write a receipt like the http runner does.
- [x] **Step 5:** One orchestration test: prompt hook on PreToolUse with a stubbed mini-model returning `{"ok":false,"reason":"r"}` blocks the tool; stub returning garbage does not block.
- [x] **Step 6:** Focused suites. Commit: `feat(hooks): prompt hooks decide through an injected LLM runner`

### Task 7: Close-out

- [x] **Step 1:** Full gates: `bun run typecheck:all`, `bun run test:shared:all`, the server-core suite, `bun run lint`, `bun run lint:i18n:parity` (only if you added i18n keys — this plan should add none).
- [x] **Step 2:** Re-run the mutation probes for the two security-relevant guards you touched: (a) comment out the `allowedHttpHookUrls` check — the runner-gate test must fail; (b) flip the async no-decision rule to parse output — the Task 4 test must fail. Restore both.
- [x] **Step 3:** Report back: per-task shas, real gate numbers, deviations, follow-ups (expected: `asyncRewake`→R3 deferral note, `if`→R1 handoff note, `continueOnBlock` pinned-inert note for R9). Do NOT edit the audit spec — the planning session records evidence.
