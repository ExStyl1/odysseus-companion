> **CLOSED — do not execute.** Landed as `d4064337`, `b57b284c`, `ba9833cd`,
> `fd648afd`, `94d4849d`, `00d6fb7d`, `a138b0e8`. Five of six tasks shipped;
> **Task 6 hit its stop condition** and its findings moved to audit row R13.
> **Live verification never ran** — it needs an Anthropic connection, see the
> audit's `Known follow-ups`. Retained for the end-of-series review; every
> checkbox below is finished or explicitly stopped work. Evidence lives in
> `docs/superpowers/specs/2026-07-25-nessy-claude-parity-audit.md` §0, row P4.

# Claude Backend Turn Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a turn on the Claude backend stops, the user and the journal learn *why* — and the caps, checkpoints and rewind that already exist on Pi stop being silently absent there.

**Architecture:** The Claude SDK already reports every stop cause on its result
message; we throw that away at one `as any` and collapse it into a single error
string. Task 1 puts a terminal reason on the wire, Task 2 makes the Claude adapter
produce it from the real union, and Task 3 makes the session record it. Tasks 4-6
then close the three places where the Claude backend silently lacks a mechanism Pi
has: no turn cap, no budget cap, no file checkpoints or rewind.

**Tech Stack:** TypeScript, Bun test runner. Packages: `@nessy-agent/core` (wire
types), `@nessy-agent/shared` (`src/agent`), `@nessy-agent/server-core`
(`src/sessions`).

Covers audit items 3, 4 and 5 (`2026-07-25-nessy-claude-parity-audit.md` §0, rows
`Termination reporting`, `Turn and budget caps`, `Rewind and file checkpoints`,
plus `Turn-level structured output` and `Bash isolation on the Claude backend`
partially — see `## Deliberately out of scope`).

## Precondition, already satisfied

The SDK typings spike (`docs/superpowers/specs/2026-07-25-claude-sdk-typings-spike.md`,
commit `375d2a0b`) compiled every option this plan passes against the installed
`@anthropic-ai/claude-agent-sdk` **`0.3.183`**. Do not re-derive it from the docs —
the docs were wrong about two shapes and the spike is what corrected them:

- `rewindFiles` is **not** an option. It is a method on the query handle:
  `Query.rewindFiles()`.
- `excludeDynamicSections` is **not** top level. It nests **inside**
  `Options.systemPrompt`, as a sibling of `type` / `preset` / `append`.
- `sandbox` is accepted but its type is loose, so TypeScript will **not** catch a
  typo'd key inside it. Validate that shape ourselves.
- Accepted as plain options: `maxTurns`, `maxBudgetUsd`, `outputFormat`,
  `enableFileCheckpointing`, `resumeSessionAt`, `settingSources`.
- On the result message, `subtype`, `num_turns` and `stop_reason` exist in
  **snake_case only**. `numTurns` and `stopReason` do not exist.

## Before you start: re-verify

Verified by the planning session on 2026-07-25 against HEAD `4c1ca6e1`. Re-check
only if HEAD has moved past that; correct this file in place if anything differs.

- [x] `backend/claude/event-adapter.ts:463` is still `const msg = message as any`,
  and `:504-516` still collapses every non-`success` subtype into one
  `errors.join(', ')` string plus a bare `complete`.
- [x] `packages/core/src/types/message.ts:659` still declares
  `| { type: 'complete'; usage?: AgentEventUsage }` — no reason field of any kind.
- [x] `AbortReason` (`shared/src/agent/core/session-lifecycle.ts:22`) **already**
  has `MaxAgentTurns = 'max_agent_turns'` and `MaxBudgetUsd = 'max_budget_usd'`.
  The vocabulary exists; the Claude backend simply never reaches it. Reuse these
  names rather than inventing a second set.
- [x] `maxBudgetUsd` is real but Pi-only: read at `pi-agent.ts:4767` from
  `loadConfigDefaults().workspaceDefaults.maxBudgetUsd`, defaulted to **0** (off)
  at `config/storage.ts:130`, and enforced only inside `PiAgent`'s own chat loop
  (`pi-agent.ts:4816-4827` + `:5038-5053`). Nothing checks it on the Claude path.
- [x] There is **no** per-turn `maxTurns` for a main session anywhere. Every
  `maxTurns` in the repo is a *child/subagent restriction*
  (`child-session-service.ts:195-209`, `SessionManager.ts:3690`, `:8304-8310`).
  Note: the audit row says "Pi-only config values"; for `maxTurns` that is
  imprecise — it is subagent-only, on both backends.
- [x] `SessionManager.ts:14892` `case 'complete':` accumulates usage and nothing
  else. The comment there says the `complete` the renderer sees comes from
  `sendMessage`'s `finally` block — find that block before Task 3, it is the real
  surfacing point.
- [x] `rewindToMessage` (`SessionManager.ts:10873`) is backend-agnostic and reverts
  file checkpoints via `listFileCheckpoints` / `revertStoredFileCheckpoint`
  (`:10919-10937`). So conversation rewind is **not** Claude-specific — what is
  missing is whether Claude turns produce checkpoints at all. Establish that
  empirically in Task 6 before writing code for it.

## Global Constraints

- **`AbortReason` is the vocabulary.** A terminal reason must be one of its
  existing values or a new value added to that enum — never a free string, and
  never a second parallel enum.
- **Do not change what a successful turn looks like.** `subtype === 'success'`
  must keep emitting exactly today's `complete` with usage. Every new field is
  optional and absent on the success path, so no existing consumer changes
  behavior.
- **Do not fabricate a cost the provider did not report.** `total_cost_usd` is
  absent or zero on subscription and gateway backends. A budget cap that reads a
  missing cost as `0` must not silently never fire *and* must not report a spend
  figure as if it were billing data.
- **A cap is a stop, not a failure.** Hitting `maxTurns` or the budget must
  terminate the turn with a reason the user can see, not surface as a crash and
  not lose the assistant text already produced.
- Enabling SDK file checkpointing writes to the SDK's own store under the session
  cwd. Confirm it does not collide with our `file-checkpoints.ts` store before
  turning it on for every session; if it does, gate it and say so.
- One commit per task. No `Co-Authored-By` trailers.
- Gates: `bun run typecheck:shared`, `cd packages/server-core && bun run typecheck`,
  `bun run typecheck:electron` (the renderer consumes the wire type).

## File Structure

| File | Responsibility |
| --- | --- |
| Modify `packages/core/src/types/message.ts` | `complete` gains an optional terminal reason. |
| Modify `packages/shared/src/agent/core/session-lifecycle.ts` | Any new `AbortReason` values. |
| Modify `packages/shared/src/agent/backend/claude/event-adapter.ts` | Narrow the result union; map `subtype` → reason. |
| Modify `packages/shared/src/agent/claude-agent.ts` | Pass the verified SDK options; expose `rewindFiles`. |
| Modify `packages/server-core/src/sessions/SessionManager.ts` | Record and surface the reason; host-side budget cap. |
| Modify `packages/shared/src/i18n/locales/{en,ru}.json` | User-facing reason labels. |

---

### Task 1: A terminal reason on the wire

**Files:**
- Modify: `packages/core/src/types/message.ts:659`
- Modify: `packages/shared/src/agent/core/session-lifecycle.ts:22-60`
- Test: the suite covering `AgentEvent` / adjacent-backend contract — find it with
  `rg -l "adjacent-backend-frozen-contract" packages/shared/src`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentEvent` variant `{ type: 'complete'; usage?: AgentEventUsage; terminalReason?: AgentTerminalReason }` and the exported type `AgentTerminalReason`. Tasks 2-5 all depend on these exact names.

- [x] **Step 1: Write the failing test**

There is a frozen-contract test for adjacent backends; it is the right place,
because the whole point is that adding a field must not change any backend's
existing output. Read it first, then add:

```ts
  it('carries an optional terminal reason on complete without changing success', () => {
    // A successful turn must be byte-identical to today: no reason field at all.
    const success: AgentEvent = { type: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
    expect('terminalReason' in success).toBe(false);

    // A capped turn names the reason from the existing AbortReason vocabulary.
    const capped: AgentEvent = { type: 'complete', terminalReason: AbortReason.MaxBudgetUsd };
    expect(capped.terminalReason).toBe('max_budget_usd');
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun test <that suite path>`
Expected: FAIL — `terminalReason` is not a known property of the `complete`
variant, so the second declaration does not typecheck. If the suite runs without
type errors, also run `bun run typecheck:shared` and show that it fails there; a
type-only change needs the typecheck as its red gate.

- [x] **Step 3: Write minimal implementation**

In `packages/core/src/types/message.ts`, beside `AgentEventUsage`:

```ts
/**
 * Why a turn stopped, when it did not simply finish. Absent on a normal
 * completion. Values are the string values of `AbortReason`
 * (`shared/src/agent/core/session-lifecycle.ts`) — that enum is the single
 * vocabulary for stop causes, and this type deliberately mirrors it rather than
 * introducing a second one. `core` cannot import from `shared`, so the union is
 * spelled out here and pinned to the enum by a test.
 */
export type AgentTerminalReason =
  | 'user_stop'
  | 'plan_submitted'
  | 'auth_request'
  | 'redirect'
  | 'source_activated'
  | 'max_agent_turns'
  | 'max_budget_usd'
  | 'max_structured_output_retries'
  | 'provider_refusal'
  | 'provider_error';
```

Read the full `AbortReason` enum and include **every** existing value, not just the
ones listed above — the list here is illustrative and the enum is authoritative.
Add `max_structured_output_retries`, `provider_refusal` and `provider_error` to
`AbortReason` itself if they are not already there, each with a one-line comment
saying which SDK `subtype` produces it.

Then widen the event:

```ts
  | { type: 'complete'; usage?: AgentEventUsage; terminalReason?: AgentTerminalReason }
```

- [x] **Step 4: Add the pin test**

Two vocabularies that must agree need a test that fails when they drift:

```ts
  it('pins AgentTerminalReason to the AbortReason enum', () => {
    // core cannot import shared, so nothing but this test stops the two from drifting.
    const fromEnum = Object.values(AbortReason).sort();
    expect(TERMINAL_REASON_VALUES.slice().sort()).toEqual(fromEnum);
  });
```

This needs a runtime array to compare against, so also export
`export const TERMINAL_REASON_VALUES = [...] as const satisfies readonly AgentTerminalReason[]`
from `message.ts` and derive the type from it
(`export type AgentTerminalReason = typeof TERMINAL_REASON_VALUES[number]`) rather
than declaring the union twice.

- [x] **Step 5: Run tests to verify they pass**

Run: `bun test <that suite path>` and `bun run typecheck:shared`
Expected: 0 fail, no typecheck output.

- [x] **Step 6: Commit**

```bash
git add packages/core/src packages/shared/src/agent/core
git commit -m "feat(core): carry a terminal reason on the complete event"
```

---

### Task 2: The Claude adapter reports the real stop cause

**Files:**
- Modify: `packages/shared/src/agent/backend/claude/event-adapter.ts:462-517`
- Test: `packages/shared/src/agent/__tests__/claude-event-adapter.test.ts`

**Interfaces:**
- Consumes: `AgentTerminalReason` from Task 1.
- Produces: nothing later tasks depend on.

`adaptResult` opens with `const msg = message as any`, which defeats the
`SDKResultMessage` union entirely, and then flattens every non-success subtype into
one string at `:507`. A turn cap, a budget cap, a refusal and a crash are therefore
indistinguishable downstream — which is the whole of audit item 3 on this backend.

- [x] **Step 1: Write the failing test**

```ts
  it('maps each documented result subtype to a distinct terminal reason', async () => {
    const cases: Array<[string, string]> = [
      ['error_max_turns', 'max_agent_turns'],
      ['error_max_budget_usd', 'max_budget_usd'],
      ['error_max_structured_output_retries', 'max_structured_output_retries'],
    ];
    for (const [subtype, reason] of cases) {
      const events = adaptResultMessage({ subtype, usage: usageFixture(), total_cost_usd: 0 });
      const complete = events.find(event => event.type === 'complete');
      expect(complete?.terminalReason).toBe(reason);
    }
  });

  it('leaves a successful result exactly as it was', async () => {
    const events = adaptResultMessage({ subtype: 'success', usage: usageFixture(), total_cost_usd: 0.5 });
    const complete = events.find(event => event.type === 'complete');
    expect(complete?.terminalReason).toBeUndefined();
    expect(complete?.usage?.costUsd).toBe(0.5);
  });

  it('reports a cap as a stop, not as an error event', async () => {
    // A cap must not surface as a crash: the user sees "stopped because of the
    // budget", and any assistant text already produced this turn is kept.
    const events = adaptResultMessage({ subtype: 'error_max_turns', usage: usageFixture() });
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('still emits an error event for an unrecognized failure subtype', async () => {
    const events = adaptResultMessage({ subtype: 'error_during_execution', errors: ['boom'], usage: usageFixture() });
    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(events.find(event => event.type === 'complete')?.terminalReason).toBe('provider_error');
  });
```

`adaptResultMessage` is a stand-in: read the existing suite and drive the real
adapter the way it already does (it exercises `adapt`, not private methods). Use
the suite's own usage fixture rather than inventing `usageFixture`.

**The subtype set is confirmed from the docs** (`agent-sdk/agent-loop.md`,
re-fetched 2026-07-25, "Handle the result"), exactly five values:

| subtype | meaning | `result` field |
| --- | --- | --- |
| `success` | finished normally | yes |
| `error_max_turns` | hit `maxTurns` | no |
| `error_max_budget_usd` | hit `maxBudgetUsd` | no |
| `error_during_execution` | API failure or cancelled request | no |
| `error_max_structured_output_retries` | no valid structured output within the retry limit | no |

Cross-check against `rg -n "subtype" node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
and treat the typings as authoritative if they disagree. Map the two caps and the
retry exhaustion to their own reasons and `error_during_execution` to
`provider_error`.

**Refusal is NOT a subtype — do not look for one.** The docs are explicit: refusal
is detected as `stop_reason === 'refusal'`, and `stop_reason` (`string | null`)
sits alongside `subtype` on every result, carrying `end_turn`, `max_tokens` or
`refusal`. On an error subtype it holds the value from the last assistant response
before the loop ended. So `provider_refusal` must come from `stop_reason`, checked
**before** the subtype map, and a `success` result with
`stop_reason === 'refusal'` is a refusal too. Add a fifth test for exactly that
case — a successful subtype that still refused — because reading only `subtype`
would report it as a clean completion.

Also worth carrying: **all** subtypes carry `total_cost_usd`, `usage`, `num_turns`
and `session_id`, so the usage block does not need per-subtype narrowing. And
`maxTurns` "counts tool-use turns only" — relevant to Task 4.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/agent/__tests__/claude-event-adapter.test.ts`
Expected: FAIL — every `terminalReason` is `undefined`, and the cap cases also emit
an `error` event.

- [x] **Step 3: Write minimal implementation**

Narrow the union instead of erasing it:

```ts
  private adaptResult(message: SDKMessage, events: AgentEvent[]): void {
    // Narrowed deliberately: the previous `as any` defeated SDKResultMessage, so
    // every non-success subtype collapsed into one error string and a turn cap was
    // indistinguishable from a crash.
    const msg = message as SDKResultMessage;
```

Keep the existing usage/contextWindow block working — it reads
`msg.modelUsage`, `msg.usage.*` and `msg.total_cost_usd`, all of which exist on the
union. Where a field is genuinely only on one arm, narrow per `subtype` rather than
widening back to `any`.

Then replace the `success` / else branch:

```ts
    // stop_reason is resolved BEFORE the subtype, because refusal has no subtype
    // of its own: a `success` result can carry stop_reason === 'refusal', and an
    // early return on `success` would report that as a clean completion.
    const terminalReason: AgentTerminalReason | undefined = msg.stop_reason === 'refusal'
      ? 'provider_refusal'
      : msg.subtype === 'success'
        ? undefined
        : CLAUDE_RESULT_SUBTYPE_REASON[msg.subtype] ?? 'provider_error'

    // A cap or a refusal is a stop, not a failure: no error event, so the turn's
    // assistant text survives and the UI can say why it ended. Only a genuine
    // execution error still produces one.
    if (terminalReason === 'provider_error') {
      const errorMsg = 'errors' in msg && Array.isArray(msg.errors) ? msg.errors.join(', ') : 'Query failed'
      const windowsError = buildWindowsSkillsDirError(errorMsg)
      events.push(windowsError ?? { type: 'error', message: errorMsg })
    }
    events.push({ type: 'complete', usage, ...(terminalReason ? { terminalReason } : {}) })
```

The spread keeps the success payload byte-identical to today's — the field is
absent, not `undefined`, which the Task 1 contract test asserts.

with the map declared at module scope and keyed by the real subtype strings you
read from the typings. Also drop or downgrade the unconditional
`console.error('[ClaudeAdapter] result message: …')` at `:466` — it prints on every
successful turn; use the adapter's existing debug channel if one exists.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/agent/__tests__/claude-event-adapter.test.ts`
Expected: 0 fail.

- [x] **Step 5: Prove no adjacent-backend regression**

Run: `bun test packages/shared/src/agent/__tests__`
Expected: 0 fail. The frozen-contract suite is the one that matters here — if it
fails, the change altered a backend's existing output, which this task forbids.

- [x] **Step 6: Commit**

```bash
git add packages/shared/src/agent/backend/claude
git commit -m "fix(claude): report the real result subtype as a terminal reason"
```

---

### Task 3: The session records and surfaces the reason

**Files:**
- Modify: `packages/server-core/src/sessions/SessionManager.ts:14892` and the
  `sendMessage` `finally` block the comment there points at
- Modify: `packages/shared/src/i18n/locales/en.json`, `ru.json`
- Test: `packages/server-core/src/sessions/__tests__/` (the suite covering
  `sendMessage` completion)

**Interfaces:**
- Consumes: the `terminalReason` field from Task 1, produced by Task 2.
- Produces: nothing later tasks depend on.

- [x] **Step 1: Write the failing test**

```ts
  it('forwards the backend terminal reason on the complete it sends to the renderer', async () => {
    // SessionManager:14892 accumulates usage and drops everything else, and the
    // `complete` the renderer sees is rebuilt in sendMessage's finally block — so
    // without this, a reason produced by the adapter never leaves the main process.
    const events = await runTurnEmitting([
      { type: 'complete', usage: usageFixture(), terminalReason: 'max_budget_usd' },
    ]);
    expect(events.filter(event => event.type === 'complete').at(-1)?.terminalReason).toBe('max_budget_usd');
  });

  it('sends no reason for an ordinary completion', async () => {
    const events = await runTurnEmitting([{ type: 'complete', usage: usageFixture() }]);
    expect(events.filter(event => event.type === 'complete').at(-1)?.terminalReason).toBeUndefined();
  });
```

Read the existing send-path suite and use its real harness — `runTurnEmitting` is a
stand-in for whatever it already uses to drive a fake backend through a turn.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/server-core/src/sessions/__tests__`
Expected: FAIL — the reason is dropped between the backend event and the renderer.

- [x] **Step 3: Write minimal implementation**

At `case 'complete':`, capture the reason onto the managed session (a single
field, cleared at the start of each turn), and in `sendMessage`'s `finally` block
include it on the `complete` it sends. Keep it absent when unset so the renderer
sees today's payload for a normal turn.

Add the user-facing labels to both locale files, alphabetically sorted, one key per
reason under an existing namespace (`chat.*` or `status.*` — follow whatever the
renderer's completion UI already reads). Do **not** add a renderer surface in this
task beyond the labels; wiring the UI is its own change.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/server-core/src/sessions/__tests__`
Expected: 0 fail.

- [x] **Step 5: i18n gates**

Run: `bun run lint:i18n:parity` and `bun run lint:i18n:sorted`
Expected: both clean.

- [x] **Step 6: Commit**

```bash
git add packages/server-core/src/sessions packages/shared/src/i18n
git commit -m "feat(sessions): surface the turn terminal reason to the renderer"
```

---

### Task 4: Pass the verified SDK options

**Files:**
- Modify: `packages/shared/src/agent/claude-agent.ts:1148-1190`
- Test: `packages/shared/src/agent/__tests__/` (the suite that inspects the built
  Claude query options — find it with
  `rg -l "permissionMode: 'bypassPermissions'\|buildQueryOptions" packages/shared/src/agent/__tests__`;
  if none exists, add a focused one that captures the options object)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on.

Only the shapes the spike **compiled** go in. Two of them are nested or method
calls, and passing them as plain options would not compile.

- [x] **Step 1: Write the failing test**

```ts
  it('nests excludeDynamicSections inside the preset system prompt', () => {
    // The spike proved it is a sibling of type/preset/append, NOT a top-level
    // option. It is also a no-op on the mini branch, which returns a plain string.
    const options = buildOptionsFor({ mini: false });
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    expect((options.systemPrompt as Record<string, unknown>).excludeDynamicSections).toBeDefined();
    expect('excludeDynamicSections' in options).toBe(false);
  });

  it('passes settingSources explicitly rather than leaving the SDK to guess', () => {
    expect(buildOptionsFor({ mini: false }).settingSources).toBeDefined();
  });

  it('passes no maxTurns for a main session and the clamped value for a child', () => {
    expect(buildOptionsFor({ mini: false }).maxTurns).toBeUndefined();
    expect(buildOptionsFor({ mini: false, childMaxTurns: 3 }).maxTurns).toBe(3);
  });
```

`buildOptionsFor` is a stand-in. Read the file to find how the options object is
assembled and whether a seam already exists to capture it; if the object is built
inline inside the query call, extract it to a private method in this task so it is
testable, and say so in the commit body.

`maxTurns`: the re-verify step established there is **no** main-session turn cap
anywhere in the repo, only child restrictions. So pass the child restriction when
one exists and nothing otherwise. Do **not** invent a default main-session cap —
that would silently truncate long turns users rely on.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test <that suite path>`
Expected: FAIL — none of the three are passed today.

- [x] **Step 3: Write minimal implementation**

Add `excludeDynamicSections` inside the preset object at `:1150-1168`, with a
comment noting it is a no-op on the `miniConfig.enabled` branch because that branch
returns a plain string prompt. Add `settingSources` and the conditional `maxTurns`
as plain options.

Do **not** add `outputFormat` or `sandbox` in this task. `outputFormat` has no
caller yet and adding an unused option is speculative; `sandbox` needs the settings
model that plan P9 builds, and the spike warns its type is loose enough that a
typo would compile. Both are recorded in `## Deliberately out of scope`.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test <that suite path>`; then `bun test packages/shared/src/agent/__tests__`
Expected: 0 fail in both.

- [x] **Step 5: Typecheck**

Run: `bun run typecheck:shared`
Expected: no output. This is the gate that actually proves the two corrected shapes
— a top-level `excludeDynamicSections` would fail here.

- [x] **Step 6: Commit**

```bash
git add packages/shared/src/agent/claude-agent.ts packages/shared/src/agent/__tests__
git commit -m "feat(claude): pass the verified SDK turn options"
```

---

### Task 5: The budget cap covers both backends

**Files:**
- Modify: `packages/shared/src/agent/pi-agent.ts:4808-4827`, `:5038-5053` (move, do
  not duplicate)
- Modify: `packages/shared/src/agent/base-agent.ts` (the new shared home)
- Test: `packages/shared/src/agent/__tests__/base-agent.test.ts` plus the existing
  Pi budget test — find it with `rg -l maxBudgetUsd packages/shared/src --glob '*.test.ts'`

**Interfaces:**
- Consumes: `AgentTerminalReason` from Task 1.
- Produces: nothing later tasks depend on.

`maxBudgetUsd` is enforced only inside `PiAgent`'s own chat loop, so a Claude
session has no spend ceiling at all. The check itself is backend-agnostic — it
reads `costUsd` off a `complete`/`usage_update` event — so it belongs on the shared
base.

- [x] **Step 1: Write the failing test**

```ts
  it('stops a Claude-backend turn once the configured budget is exceeded', async () => {
    // Same config value Pi reads: loadConfigDefaults().workspaceDefaults.maxBudgetUsd.
    const agent = fakeClaudeAgentWithBudget(1.0);
    const events = await collect(agent.chat('hi', [
      { type: 'usage_update', usage: { costUsd: 0.7 } },
      { type: 'usage_update', usage: { costUsd: 0.5 } },
    ]));
    expect(events.at(-1)).toMatchObject({ type: 'complete', terminalReason: 'max_budget_usd' });
  });

  it('never fires when the provider reports no cost', async () => {
    // Subscription and gateway backends report no total_cost_usd. A missing cost
    // must not read as 0 spend forever, and must not read as a breach either.
    const agent = fakeClaudeAgentWithBudget(1.0);
    const events = await collect(agent.chat('hi', [{ type: 'complete', usage: { outputTokens: 10 } }]));
    expect(events.at(-1)).toMatchObject({ type: 'complete' });
    expect((events.at(-1) as { terminalReason?: string }).terminalReason).toBeUndefined();
  });

  it('stays off at the default of 0', async () => {
    const agent = fakeClaudeAgentWithBudget(0);
    const events = await collect(agent.chat('hi', [{ type: 'usage_update', usage: { costUsd: 999 } }]));
    expect((events.at(-1) as { terminalReason?: string }).terminalReason).toBeUndefined();
  });
```

Read `base-agent.test.ts` first and use its real fake-agent harness. The Pi suite
must keep passing unchanged — that is the proof the behavior moved rather than
changed.

- [x] **Step 2: Run test to verify it fails**

Run: `bun test packages/shared/src/agent/__tests__/base-agent.test.ts`
Expected: FAIL — nothing caps a non-Pi backend.

- [x] **Step 3: Write minimal implementation**

Move `getEventCostUsd`, `exceedsMaxBudgetUsd`, `sessionCostUsd` and the
`getMaxBudgetUsd` config read onto the shared base, and have the Pi loop call the
inherited members. Emit `{ type: 'complete', terminalReason: 'max_budget_usd' }` on
breach, and keep whatever abort Pi performs today so the subprocess still stops.

Preserve the existing guard exactly: a non-finite or non-positive `costUsd`
contributes nothing, and `maxBudgetUsd <= 0` disables the cap. Those two lines are
what keep a no-cost provider from being either capped instantly or capped never.

- [x] **Step 4: Run test to verify it passes**

Run: `bun test packages/shared/src/agent/__tests__` and the Pi budget suite
Expected: 0 fail in both, with the Pi suite **unmodified**.

- [x] **Step 5: Mutation probe**

Delete the `maxBudgetUsd <= 0` early return and confirm the "stays off at the
default of 0" test fails. Revert. Then delete the `Number.isFinite` guard and
confirm the no-cost test fails. Revert.

- [x] **Step 6: Commit**

```bash
git add packages/shared/src/agent
git commit -m "feat(agent): enforce the budget ceiling on every backend"
```

---

### Task 6: Establish the Claude checkpoint and rewind story, then close it

**Files:** determined by Step 1 — do not edit anything before it.

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

The audit says rewind "silently no-ops on Claude" and discards the provider
session. The re-verify step found `rewindToMessage` is backend-agnostic and reverts
our own file checkpoints, so the claim needs narrowing before code is written.
**This task starts as an investigation and its findings decide its own scope.**

- [x] **Step 1: Establish what actually happens today**

Answer these three, in writing, appended to this file as `## Rewind findings`:

1. Does a Claude-backend turn produce any `file-checkpoints.ts` checkpoint? Find
   where checkpoints are created and whether that path runs for Claude tool calls
   (Claude's Write/Edit go through the SDK, not our local tool runtime — that is
   the likely reason for the no-op).
2. What does `rewindToMessage` do on a Claude session in practice — succeed with
   zero checkpoints reverted, or fail earlier?
3. Does the SDK's own `enableFileCheckpointing` + `Query.rewindFiles()` store
   collide with ours if both are on? Check where the SDK writes.

- [x] **Step 2: Choose the scope from the findings, and say so**

- If Claude turns produce no checkpoints because file writes bypass our runtime,
  the fix is to enable `enableFileCheckpointing` and expose
  `this.currentQuery.rewindFiles(...)` as a `ClaudeAgent` method that
  `rewindToMessage` calls for Claude sessions. Write that as tasks 6a/6b with
  their own red/green cycles.
- If the two stores collide, gate SDK checkpointing behind the absence of ours and
  record the decision.
- If conversation rewind keeping the provider session turns out to need session-id
  surgery in the SDK transcript, **stop and report**. That half becomes its own
  plan; do not attempt it inside this one.

- [x] **Step 3: Implement whatever Step 2 chose, TDD, one commit per sub-task**

The method shape is fixed by the spike — it is a call on the stored handle, not an
option:

```ts
// claude-agent.ts — `this.currentQuery` is assigned at :1588/:1594/:1598 and today
// is only ever iterated (:1622); no method on it is called anywhere.
await this.currentQuery.rewindFiles(userMessageId, { dryRun: true })
```

- [x] **Step 4: Commit**

Commit message per sub-task, in the form
`feat(claude): <what the finding required>`.

---

## Final Verification

- [x] `bun test packages/core/src packages/shared/src/agent packages/server-core/src packages/pi-agent-server/src`
- [x] `bun run typecheck:shared`; `cd packages/server-core && bun run typecheck`;
  `cd packages/pi-agent-server && bun run typecheck`; `bun run typecheck:electron`
- [x] `bun run lint:i18n:parity`; `bun run lint:i18n:sorted`; `git diff --check`
- [x] `bun run electron:build`
- [x] Diff review, specifically: a successful turn's `complete` payload is
  unchanged; no cost figure is reported that the provider did not send; the Pi
  budget suite passed without being edited; no `as any` was reintroduced in
  `adaptResult`.

### Live verification

- [ ] Run a normal turn on a Claude connection. Confirm the `complete` carries no
  reason and nothing in the UI changed.
- [ ] Set `maxBudgetUsd` to a value the turn will exceed, run a turn, and confirm it
  stops with the budget reason surfaced and the assistant text already produced is
  retained.
- [ ] Repeat on Pi to confirm the moved check behaves exactly as before.
- [ ] Whatever Task 6 chose: exercise the rewind path end to end on a Claude
  session and record what was reverted.
- [ ] Note: installing a plugin in this tree needs `NESSY_BUN` exported — see the
  audit's known-follow-ups section. Force the dark theme before any screenshot.

## Rewind findings

Answered before any file was touched, against HEAD `94d4849d` (Task 5 committed).
Installed SDK `0.3.183`; the native binary
(`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`) **is** present in this tree,
so the CLI side could be inspected.

**1. Does a Claude-backend turn produce any `file-checkpoints.ts` checkpoint? No.**

`createFileCheckpoint` has exactly two non-test callers in the whole repo:

- `packages/pi-agent-server/src/index.ts:1183` — Pi's local tool runtime, via
  `persistAuthorizedCheckpoint` on the authorized-write callback.
- `packages/shared/src/agent/backend/nestor-cloud/tool-executor.ts:155` —
  the Nestor Cloud local-tool executor's `beforeDispatch`.

Neither runs for Claude. Claude's `Write`/`Edit`/`NotebookEdit` execute **inside the
SDK subprocess**, so no Nessy local tool dispatch happens and nothing calls
`createFileCheckpoint`. The audit's hypothesis is confirmed: a Claude session's
checkpoint manifest is never created.

**2. What does `rewindToMessage` do on a Claude session? It succeeds, restoring zero
files.** It does not fail earlier.

`rewindToMessage` (`SessionManager.ts:10880`) is backend-agnostic. With
`restoreFiles: true` it calls `listFileCheckpoints(sessionPath)`, whose
`readManifest` returns `{ version: 1, entries: [] }` when the manifest file is
absent rather than throwing (`file-checkpoints.ts:168-172`) — verified empirically
against a fresh session directory, which returned `[]`. So
`checkpointsAfterTarget` is empty, `checkpointResults` is empty, and the transcript
truncation proceeds to a `success` result with `restoredCheckpoints: 0`. The user
sees a successful rewind that silently restored nothing, which is the "silent
no-op" the audit describes — the transcript half works, the file half is vacuous.

Separately, the rewind already discards the provider session on purpose:
`managed.sdkSessionId = undefined`, `branchFromSdkSessionId = undefined`,
`branchContextStrategy = 'seeded-fresh-session'` (`SessionManager.ts:10964-10970`).

**3. Does the SDK's `enableFileCheckpointing` store collide with ours? No — but the
question is moot, because the prescribed fix cannot be wired at all.**

Paths do not collide. Ours is `<sessionPath>/file_checkpoints/`
(`CHECKPOINT_DIR = 'file_checkpoints'`, `file-checkpoints.ts:7`). The CLI's own
store is `.claude/checkpoints/` under the session cwd — read from the shipped
binary, which lists `**/.claude/checkpoints/` in the same ignore-glob array as
`**/.claude/worktrees/`, `**/.claude/mailbox/` and `**/.claude/agent-registry.json`.
That is inferred from the binary's strings rather than observed at runtime; a
runtime confirmation was not pursued because of the two blockers below.

**Two blockers make `Query.rewindFiles()` unreachable from `rewindToMessage`:**

- **No live query handle at rewind time.** `rewindFiles` is not a local operation:
  it is a control request to the running subprocess
  (`SDKControlRewindFilesRequest = { subtype: 'rewind_files', user_message_id, dry_run }`,
  `sdk.d.ts:3403`). But `claude-agent.ts:2345` sets `this.currentQuery = null` in
  `chatImpl`'s `finally`, and `isProcessing()` is literally
  `this.currentQuery !== null` (`:2888`). Rewind is a between-turns action —
  `rewindToMessage` even calls `strictDrainSessionForMutation` first to guarantee the
  turn has settled. So at the moment rewind runs there is no handle and no
  subprocess to send the control request to. Making one available means keeping an
  SDK query (and its subprocess) resident across turns: a Claude backend lifecycle
  change, not a method exposure.
- **No `user_message_id` to pass.** `rewindFiles(userMessageId)` takes the SDK's own
  user-message **UUID**. Nessy addresses messages by its own `generateMessageId()`
  ids (`msg-<ts>-<rand>`), and nothing on the Claude path captures an SDK user-message
  uuid — the Claude event adapter never reads `.uuid`, and there is no
  Claude equivalent of the Pi turn anchor for user messages. Supplying one means
  capturing and persisting SDK transcript identities per user message.

**Scope chosen: none. Stopping and reporting, per the plan's stop condition.**

The second blocker is exactly "session-id surgery in the SDK transcript", and the
first is a subprocess-lifetime change to the Claude backend. Task 6's Step 2 bullet
("enable `enableFileCheckpointing` and expose `this.currentQuery.rewindFiles(...)`")
is not implementable as written, so no code was written for this task. Two things
deliberately **not** done, to avoid inventing scope:

- Setting `enableFileCheckpointing: true` on its own. With no reachable caller it is
  the same speculative unused option the plan rejects for `outputFormat`, and it
  would start writing a store into the user's working directory for no benefit.
- Changing the rewind result so a Claude session reports "this backend records no
  checkpoints" instead of a successful zero-file restore. That is a real improvement
  and finding 2 is the evidence for it, but it is a result-contract/UI change with
  its own review.

The follow-up plan needs both halves: keep an SDK handle (or a resumable session
id) alive across turns, and carry SDK user-message uuids alongside our message ids.
`resumeSessionAt`, already listed as out of scope here, belongs with it.

## Deliberately out of scope

- **`outputFormat` / turn-level structured output.** Accepted by the typings but
  with no caller; wiring it without a consumer is speculative. The audit row stays
  open and names the Pi half too (`pi-agent.ts:5020`).
- **`sandbox` on the Claude backend.** Needs P9's settings model to know what to
  pass, and the spike warns the type is loose enough that a typo compiles.
- **`resumeSessionAt`.** Belongs with the rewind-keeps-provider-context work, which
  Task 6 may hand off.
- **A renderer surface for the terminal reason** beyond the locale keys. Task 3
  puts the reason on the wire; showing it is a UI change with its own review.

## Tracker

| # | Task | Status | Gate that proves it | Evidence |
| --- | --- | --- | --- | --- |
| 0 | Re-verify (done by the planner at `4c1ca6e1`) | **done** | 7 anchors confirmed; 2 audit imprecisions corrected | in the re-verify section |
| 1 | Terminal reason on the wire | **done `d4064337`** | contract + pin tests pass; `typecheck:shared` clean | red: `bun test adjacent-backend-frozen-contract -t "terminal reason"` → `0 pass / 1 fail / 1 error`, `SyntaxError: Export named 'TERMINAL_REASON_VALUES' not found`; `typecheck:shared` → 3 errors (TS2305 missing export, TS2353 + TS2339 `terminalReason` not on the `complete` variant). green: suite `8 pass / 0 fail / 370 expect`, `typecheck:shared` + `packages/core tsc` silent. Sanity probe: adding a stray `AbortReason.ProbeDrift` made the pin test fail; reverted |
| 2 | Claude adapter maps `subtype` | **done `b57b284c`** | 5 tests pass; frozen-contract suite unchanged | red: `38 pass / 4 fail` — cap case emitted an `error` event, `terminalReason` `undefined` for `error_during_execution` and for the success-but-refused case. green: `42 pass / 0 fail / 86 expect`; whole `agent/__tests__` dir `975 pass / 2 skip / 0 fail`; no `as any` left in `adaptResult`; `console.error` on every result moved to `callbacks.onDebug` |
| 3 | Session records and surfaces it | **done `ba9833cd`** | 3 tests pass; i18n gates clean | red: `packages/server-core/src/sessions/turn-terminal-reason.test.ts` → `1 pass / 2 fail`, reason `undefined` at the renderer. green: `3 pass / 0 fail`; `packages/server-core/src/sessions` `265 pass / 0 fail`; `lint:i18n:parity` → `i18n parity OK (1 locales, 1968 keys each)`; `lint:i18n:sorted` silent. Real surfacing point was `onProcessingStopped` (`SessionManager.ts:13622`), not a `finally` block |
| 4 | Verified SDK options passed | **done `fd648afd`** | 4 tests pass; typecheck proves the nested shape | red: `SyntaxError: Export named 'buildClaudeTurnShapeOptions' not found`. green: `4 pass / 0 fail / 8 expect`; `agent/__tests__` `979 pass / 0 fail`. Typecheck probe: moving `excludeDynamicSections` to the top level → `TS2353 ... does not exist in type 'Pick<Options, "maxTurns" \| "systemPrompt" \| "settingSources">'`; reverted. Options object is inline in `chatImpl`, so the three shapes were extracted to `buildClaudeTurnShapeOptions()` |
| 5 | Budget cap on every backend | **done `94d4849d`** | 4 tests pass; Pi suite unedited; both probes re-fail | red: `2 pass / 2 fail` (nothing capped a non-Pi backend). green: `base-agent.test.ts` `67 pass / 0 fail`; `agent/__tests__` `983 pass / 0 fail`. Pi suite **unmodified** (`git diff --stat` on `pi-agent-max-budget.test.ts` empty across the whole range) and `2 pass / 0 fail`. Probe A — deleted the `maxBudgetUsd <= 0` early return → "stays off at the default of 0" failed (`Received: "max_budget_usd"`); reverted. Probe B — deleted the `Number.isFinite` guard → "no usable cost" failed on the `non-finite` row; reverted. Probe B needed the test widened first: `Number.isFinite` is load-bearing **only** for a non-finite cost (`typeof`/`> 0` already block absent/0/NaN/non-numeric), so the no-cost test is now table-driven over absent / zero / non-numeric / non-finite |
| 6 | Rewind/checkpoint: investigate, then close | **stopped, findings recorded `00d6fb7d`** | findings appended; scope chosen: none | `## Rewind findings` above. Q1 no — `createFileCheckpoint` has exactly 2 non-test callers (Pi's local tool runtime, Nestor Cloud's executor); Claude's writes run inside the SDK. Q2 succeeds with `restoredCheckpoints: 0` (verified: `listFileCheckpoints` on a fresh dir returned `[]`). Q3 no path collision (`.claude/checkpoints/` vs `file_checkpoints/`) but moot. Two blockers hit the stop condition: `currentQuery` is nulled in `chatImpl`'s `finally` so there is no live handle for the `rewind_files` control request, and `rewindFiles(userMessageId)` needs an SDK transcript UUID nothing on the Claude path captures. No code written |
| — | Final Verification | **done** | full list above | `bun test packages/core/src packages/shared/src/agent packages/server-core/src packages/pi-agent-server/src` → `2523 pass / 3 skip / 0 fail / 16551 expect` across 291 files. `typecheck:shared`, `server-core typecheck`, `pi-agent-server typecheck`, `typecheck:electron` all silent. `lint:i18n:parity` OK, `lint:i18n:sorted` silent, `git diff --check` clean. `bun run electron:build` → `✓ built in 22.98s` + resource copy. Diff review: success `complete` is `{ type, usage, ...(terminalReason ? … : {}) }` so the field is absent not `undefined`; no `as any` in `adaptResult`; no new cost figure — every `costUsd` in the diff is a test fixture or the moved guard; Pi budget suite unedited |
| — | Live verification | **blocked: no Claude connection, and an isolated config dir cannot authenticate any provider** | 4 checks in `### Live verification` | Checks 1-2 need a Claude turn: this machine has only `pi-api-key` (`pi_compat`, Nessy Gateway) and `nessy-cloud-agent` connections, no Anthropic one, and `NESSY_FEATURE_PROVIDER_CLAUDE` is off by default. Creating one needs an API key or an OAuth sign-in, which the executor must not perform. Check 3 (Pi regression) was attempted headlessly via `apps/cli` `run --output-format stream-json` against an isolated `NESSY_CONFIG_DIR`: the seeded root was rejected (`[storage-readiness] code=custom-root-reset-required`, a config.json with no layout version reads as `legacy`), an empty root bootstrapped to v2 correctly and the server reached `Server ready: ws://…`, but the turn stopped at credential resolution — the gateway key lives in the real dir's `credentials.enc` and `ensureNessyGatewayAuth` is wired only from the Electron main process (`apps/electron/src/main/handlers/nessy-auth.ts`), so no isolated-dir run can authenticate. Even authenticated, the gateway reports no `total_cost_usd`, so a budget breach is unreachable there. Not worked around: no credential was copied, read or passed, and no token was placed on a command line. Isolated dir removed; the user's `~/.nessy-agent` was not modified. Check 4 is n/a — Task 6 chose no scope |

Status values: `not started` / `in progress` / `blocked: <why>` / `done <commit>`.

**Stop conditions.** Halt and report rather than working around:

- Narrowing `as any` to `SDKResultMessage` requires reintroducing `any` to keep the
  usage block compiling. Report the field that resists narrowing.
- A successful turn's `complete` payload changes in any way.
- Task 5 cannot pass without editing the existing Pi budget test. That would mean
  the behavior changed rather than moved.
- Task 6's findings show conversation rewind needs SDK transcript surgery. That
  half is its own plan.
