# Gateway 429 Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Survive Nestor gateway 429s the way nessy-cli does — long minute-window-crossing
retries, seconds-not-milliseconds child-spawn backoff, live 429 evidence in logs, and a
visible retry status in chat instead of a dead ~14-second silence ending in an error.

**Architecture:** Every change rides an existing mechanism: the Pi SDK's per-session
`settingsManager.applyOverrides({ retry })` (the same deep-merge path already used for
compaction), the spawner's existing `retryBaseDelayMs` knob, the reasoning proxy's single
response-forwarding point, and the already-flowing `auto_retry_*` session events mapped
through the same status pipeline compaction uses.

**Tech Stack:** TypeScript, Bun, Pi SDK 0.80.3 (`@earendil-works/pi-coding-agent`).

## Global Constraints

- Bun for everything: `bun test <file>`, `bun run typecheck:all` (does NOT cover `apps/cli` — run its typecheck separately).
- One commit per task, message given in the task; no `Co-Authored-By` trailers.
- Do not touch `.gitlab-ci.yml`, `fastlane/`, `policy.yml`.
- Update the `## Tracker` section of THIS plan in the same commit that lands each task.
- Zone by file vs any concurrently-executing plan (repo rule): this plan owns
  `packages/pi-agent-server/src/*`, `packages/shared/src/agent/backend/pi/event-adapter.ts`,
  `packages/shared/src/protocol/dto.ts`, `packages/core/src/types/message.ts`, and one
  SessionManager hunk (`statusType` sniff). If another active plan touches any of these
  files, run the overlapping task AFTER it lands.
- No new i18n keys: backend status messages are English by existing precedent
  (`'Compacting context...'` is unlocalized).

## Verified premises (2026-08-07 — plan is planned against these; re-verify only if the cited code moved)

- Pi session auto-retry defaults: `enabled ?? true`, `maxRetries ?? 3`, `baseDelayMs ?? 2000`,
  delay `base × 2^(attempt−1)`, NO per-delay cap, NO Retry-After handling — the full
  context is re-sent on every attempt (`node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js`
  `getRetrySettings`, `dist/core/agent-session.js` `_prepareRetry`). `applyOverrides`
  deep-merges in memory and does not persist (`settings-manager.js:300`).
- 429 is classified retryable by `pi-ai/dist/utils/retry.js`
  (`RETRYABLE_PROVIDER_ERROR_PATTERN` includes `429`, `rate.?limit`, `too many requests`).
- pi-ai's HTTP layer does NOT retry: `maxRetries: options?.maxRetries ?? 0`
  (`pi-ai/dist/api/openai-completions.js:114`) — the session-level retry is the only loop.
- Spawner: `MAX_ATTEMPTS = 3`, backoff `(cfg.retryBaseDelayMs ?? 250) × 2^(attempt−1)`
  (`packages/pi-agent-server/src/orchestrator/spawner.ts:118`, `:643-645`);
  `configureSpawnerForGeneration` (single `configureSpawner({...})` call site in
  `packages/pi-agent-server/src/index.ts`) does not pass `retryBaseDelayMs` today.
- `initConfig.baseUrl` is REWRITTEN to the loopback proxy URL by `applyNestorReasoningProxy`
  (`index.ts` ~1141-1161), so "is the gateway active" inside the subprocess is
  `nestorReasoningProxy !== null` — never a URL check on the active config.
- Proxy forwards every upstream response at ONE point:
  `res.writeHead(upstream.status, headersToObject(responseHeaders))`
  (`packages/pi-agent-server/src/gateway-proxy/nestor-reasoning-proxy.ts:326`).
- `handleSessionEvent` (`index.ts` ~2668) forwards ALL `AgentSessionEvent`s host-ward.
  The compaction events demonstrably traverse subprocess → host → event adapter (the
  adapter has `case 'compaction_start'` at
  `packages/shared/src/agent/backend/pi/event-adapter.ts:837`), and `auto_retry_start` /
  `auto_retry_end` ride the same `_emit` stream in `agent-session.js`. They are handled
  NOWHERE today (`rg -n "auto_retry"` over pi-agent-server, shared, electron, ui → only
  SDK dist). Payloads: start = `{attempt, maxAttempts, delayMs, errorMessage}`,
  end = `{success, attempt, finalError?}`.
- Status pipeline (Task 4's rails): event adapter yields
  `{ type: 'status', message: 'Compacting context...' }` (`event-adapter.ts:846`);
  `SessionManager.ts:18975` sniffs the message keyword to set
  `statusType: 'compacting'`; the wire union is
  `statusType?: 'compacting' | 'hook'` (`packages/shared/src/protocol/dto.ts:415`) and
  `statusType?: 'compacting' | 'compaction_complete'`
  (`packages/core/src/types/message.ts:316` and `:410`); the renderer reads
  `session.currentStatus?.statusType === 'compacting'`
  (`apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx`) and already renders
  `currentStatus.message` as the status line — a new status message displays with NO
  renderer change; widening the `statusType` unions is only for styling parity.
- Session construction: main, ephemeral (mini-completion), and working-directory-candidate
  sessions are ALL created via `runtimeAdapter.createSession` (`index.ts:2057`, `:2495`,
  `:3124`; adapter impl `packages/pi-agent-server/src/compat/pi-runtime-adapter.ts:258`).
  Subagent children are NOT in-process: `childSessionPort.start` (`index.ts:3739`) sends a
  `requestChildSession` JSONL request host-ward, and each child runs its own
  pi-agent-server subprocess with the same init flow — so per-subprocess policy wiring
  covers children automatically.
- Empirical (live probes with the real JWT, 2026-08-07 ~11:40 MSK): the gateway sends NO
  `X-RateLimit-*`/`Retry-After` headers on 200/400 responses; 30 tiny requests
  ×10-parallel → all 200; 330k distinct prompt tokens in one 6-way burst (fast model) →
  all 200; 3×55k distinct tokens on the 397B coder → all 200 in 2-4s; a 419k-token input →
  clean 400 `"The input (419340 tokens) is longer than the model's context length
  (262144 tokens)"`. Per-user burst limits are not reachable from one client; live 429s
  must be captured in production (Task 3).
- nessy-cli (same endpoint, same JWT: `packages/core/src/core/openaiContentGenerator/provider/nestor.ts`,
  `packages/core/src/dp/nestorAuthHeader.ts`) retries 429 with
  `maxRetries: 10, initialDelayMs: 60_000, maxDelayMs: 300_000` and honors Retry-After as
  a minimum (`packages/core/src/core/geminiChat.ts:781`,
  `packages/core/src/utils/rateLimit.ts:131`). Desktop currently gives up after ~14s total.

## Prior art (verified 2026-08-07): opencodex

`@bitkyc08/opencodex` (local checkout `/Users/i.i.gavrikov/Desktop/work/opencodex`,
MIT) is a provider proxy solving this same problem class. Reference
implementations relevant here — if any code is copied, record source + license
in the adoption scorecard (repo editing rule):

- `src/lib/upstream-retry.ts` `retryBackoffDelayMs`: Retry-After wins over
  exponential backoff when present (parsed as delta-seconds OR HTTP-date by
  `retryAfterDelayMs`, capped at `maxDelayMs`); otherwise exponential with ±20%
  jitter — `Math.floor(exp * (0.8 + Math.random() * 0.4))`.
- `src/lib/upstream-retry.ts` `sleepWithHeartbeats` + `prepareSameTarget429Wait`:
  long 429 waits are chunked (default 10s) and yield heartbeat events so stream
  watchdogs stay fed; their doc comment pins the failure mode — bridges kill turns
  "that stay silent past the stall budget (default 300s), while a retryOn429 wait
  may legally reach 600s". Our Task 4 status events double as that liveness
  signal; this is the plan-B mechanism if the `auto_retry_*` premise breaks.
- `src/lib/retry-after.ts` `resolveClientRetryAfter`: client-facing Retry-After
  resolution order — validated upstream header → delay parsed out of the error
  message → default 2s, and only for retryable (non-quota-exhausted) 429s.

---

### Task 1: Gateway retry profile for Pi sessions

> **Two corrections found while executing (2026-08-07).**
> 1. **"the initial apply" does not exist.** Step 5.1 names five sites; the fifth is
>    `handleSetAutoCompaction`, not an initial apply. And Step 5.2's parenthetical —
>    "the main path does, via its initial apply" — is FALSE: nothing calls
>    `applyAutoCompactionPolicy` after the main `createSession`; compaction is seeded
>    through the adapter's `createSession({ compaction })` option. All three
>    construction sites therefore needed the retry policy added explicitly.
> 2. **This plan's ordering is right for a reason it never states, and it is a live
>    footgun.** `setAutoCompactionEnabled` ends in `save()`, and `save()` rebuilds
>    `settings` from global+project (`settings-manager.js:386-387`), discarding every
>    in-memory `applyOverrides`. Reversing the two lines silently restores Pi's
>    14-second give-up on a throttled gateway.
>
> **Orchestrator follow-up on (2):** the executor's test pins the SDK BEHAVIOUR, not
> the call order — and a control proved the difference. Reversing the two lines in
> `applySessionRuntimePolicies` left this file passing 7/7, because `index.ts` calls
> `main()` at module load and is not importable. A source-reading contract test (the
> package's own established form) now pins the order itself; the same reversal now
> fails exactly that one case.

**Files:**
- Create: `packages/pi-agent-server/src/gateway-retry-settings.ts`
- Create: `packages/pi-agent-server/src/gateway-retry-settings.test.ts`
- Modify: `packages/pi-agent-server/src/index.ts`

**Interfaces:**
- Produces: `resolveRetrySettings(gatewayActive: boolean): { maxRetries: number; baseDelayMs: number }`;
  `applySessionRuntimePolicies(session: AgentSession, model: unknown): void` — the one
  helper every session-construction and model/config-change site calls (subsumes bare
  `applyAutoCompactionPolicy` calls; that function itself is unchanged).
- Consumes: `nestorReasoningProxy` module variable (`index.ts`), `applyAutoCompactionPolicy`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/pi-agent-server/src/gateway-retry-settings.test.ts
import { describe, expect, it } from 'bun:test';
import {
  GATEWAY_RETRY_SETTINGS,
  PI_DEFAULT_RETRY_SETTINGS,
  resolveRetrySettings,
} from './gateway-retry-settings.ts';

describe('resolveRetrySettings', () => {
  it('returns the long gateway profile when the gateway runtime is active', () => {
    expect(resolveRetrySettings(true)).toEqual(GATEWAY_RETRY_SETTINGS);
    expect(GATEWAY_RETRY_SETTINGS).toEqual({ maxRetries: 5, baseDelayMs: 15_000 });
  });

  it('restores Pi SDK defaults when the runtime leaves the gateway', () => {
    expect(resolveRetrySettings(false)).toEqual(PI_DEFAULT_RETRY_SETTINGS);
    expect(PI_DEFAULT_RETRY_SETTINGS).toEqual({ maxRetries: 3, baseDelayMs: 2_000 });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test packages/pi-agent-server/src/gateway-retry-settings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
// packages/pi-agent-server/src/gateway-retry-settings.ts
/**
 * Pi session retry profile for the Nestor gateway.
 *
 * The SDK default (3 attempts, 2s base -> 2s/4s/8s) burns every retry inside
 * the same per-minute limiter window and then surfaces the 429 to the user
 * ~14s in. nessy-cli waits 60s x 10 against the same gateway
 * (geminiChat.ts:781). 15s x 5 crosses the minute boundary by attempt 3
 * (15/30/60/120/240s, worst case < 8 min). Pi applies no per-delay cap, so
 * the cap lives in the attempt count.
 */
export const GATEWAY_RETRY_SETTINGS = Object.freeze({ maxRetries: 5, baseDelayMs: 15_000 });

/**
 * Pi SDK defaults (settings-manager.js getRetrySettings), re-applied when the
 * runtime leaves the gateway so a mid-session endpoint switch does not keep
 * the long ladder.
 */
export const PI_DEFAULT_RETRY_SETTINGS = Object.freeze({ maxRetries: 3, baseDelayMs: 2_000 });

export function resolveRetrySettings(
  gatewayActive: boolean,
): { maxRetries: number; baseDelayMs: number } {
  return gatewayActive ? GATEWAY_RETRY_SETTINGS : PI_DEFAULT_RETRY_SETTINGS;
}
```

- [ ] **Step 4: Run the test, make sure it passes**

Run: `bun test packages/pi-agent-server/src/gateway-retry-settings.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire into index.ts as one composite policy helper**

In `packages/pi-agent-server/src/index.ts`, directly below `applyAutoCompactionPolicy`
(~line 778):

```ts
import { resolveRetrySettings } from './gateway-retry-settings.ts';

/** Compaction + retry are the two per-session runtime policies; apply together. */
function applySessionRuntimePolicies(session: AgentSession, model: unknown): void {
  applyAutoCompactionPolicy(session, model);
  session.settingsManager.applyOverrides({
    retry: resolveRetrySettings(nestorReasoningProxy !== null),
  });
}
```

Then:
1. Replace every bare `applyAutoCompactionPolicy(...)` CALL with
   `applySessionRuntimePolicies(...)` using identical arguments. Find them with
   `rg -n "applyAutoCompactionPolicy\(" packages/pi-agent-server/src/index.ts` — 5 sites
   today (thrashing-guard reset, `handleUpdateRuntimeConfig`, `handleSetModel`,
   `handleSetThinkingLevel`, and the initial apply). Keep the `applyAutoCompactionPolicy`
   function definition itself.
2. Immediately after EACH of the three `await runtimeAdapter.createSession({...})` sites
   (`rg -n "runtimeAdapter.createSession" packages/pi-agent-server/src/index.ts` —
   main ~2057, ephemeral ~2495, candidate ~3124), call
   `applySessionRuntimePolicies(<the AgentSession the returned handle exposes — the same
   object later stored in piSession / used by the ephemeral runner>, <the session's
   model>)` unless that construction path already reaches one of the replaced call sites
   (the main path does, via its initial apply — verify by reading the surrounding code;
   add the call only where no replaced site runs).

- [ ] **Step 6: Typecheck + focused suite**

Run: `bun run typecheck:all && bun test packages/pi-agent-server/src/gateway-retry-settings.test.ts`
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add packages/pi-agent-server/src/gateway-retry-settings.ts \
        packages/pi-agent-server/src/gateway-retry-settings.test.ts \
        packages/pi-agent-server/src/index.ts \
        docs/superpowers/plans/2026-08-07-gateway-429-resilience.md
git commit -m "feat(gateway): pi session retries survive per-minute 429 windows [T1]"
```

---

### Task 2: Spawner child-start backoff in seconds for the gateway

> **Correction found while executing (2026-08-07): the snapshot form in this task
> contradicts a trap documented eight lines above its own insertion point.**
> `update_runtime_config` starts and stops the reasoning proxy WITHOUT committing a
> capability generation, so a snapshot
> (`...(nestorReasoningProxy !== null ? { retryBaseDelayMs: 5_000 } : {})`) keeps the
> OLD endpoint's backoff for every child spawned in between — children hammering a
> freshly-throttled gateway every 250 ms, i.e. exactly the bug this task exists to
> fix. `SpawnerRuntime.retryBaseDelayMs` was therefore changed from `number` to
> `() => number`, matching the `thinkingLevel` reader precedent verbatim (whose own
> comment already records that a snapshot there "stayed stale"). Cost: five test
> fixtures `0` → `() => 0`. Benefit: the staleness became testable.

**Files:**
- Modify: `packages/pi-agent-server/src/index.ts` (`configureSpawnerForGeneration`)
- Test: `packages/pi-agent-server/src/orchestrator/spawner.test.ts`

**Interfaces:**
- Consumes: `SpawnerRuntime.retryBaseDelayMs` (exists, default 250 — `spawner.ts:644`).

- [ ] **Step 1: Check whether a test already pins the knob**

Run: `rg -n "retryBaseDelayMs" packages/pi-agent-server/src/orchestrator/spawner.test.ts`
If a case already injects it and asserts the delay, skip to Step 3.

- [ ] **Step 2 (only if absent): add the pin test**

Mirror the existing 429-retry fixtures (`spawner.test.ts:696-747` — fake
`childSessionPort` whose `start` throws `{ status: 429 }` twice, then succeeds; copy
their construction verbatim):

```ts
it('honors cfg.retryBaseDelayMs for rate-limit backoff', async () => {
  // configureSpawner({ ...the suite's defaults, retryBaseDelayMs: 40 })
  // record Date.now() before the spawn and after each fake-port start() call;
  // assert gap(attempt1 -> attempt2) >= 40ms and gap(attempt2 -> attempt3) >= 80ms
});
```

Run: `bun test packages/pi-agent-server/src/orchestrator/spawner.test.ts`
Expected: new case FAILS only if the knob were broken — it should PASS immediately
(the knob exists); its value is pinning behavior for the next step's wiring.

- [ ] **Step 3: Pass the knob from the generation config**

In `configureSpawnerForGeneration` (single `configureSpawner({...})` call site,
`index.ts`), append to the options object:

```ts
    availableModels: config.orchestrator?.availableModels,
    // Gateway children share one per-user limiter with the parent; a 250ms
    // base re-hits a hot window before it can reset. Seconds, not ms.
    ...(nestorReasoningProxy !== null ? { retryBaseDelayMs: 5_000 } : {}),
  });
```

- [ ] **Step 4: Run the spawner suite**

Run: `bun test packages/pi-agent-server/src/orchestrator/spawner.test.ts`
Expected: PASS, including all existing 429 cases.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-agent-server/src/index.ts \
        packages/pi-agent-server/src/orchestrator/spawner.test.ts \
        docs/superpowers/plans/2026-08-07-gateway-429-resilience.md
git commit -m "feat(gateway): spawner child retries back off in seconds, not 250ms [T2]"
```

---

### Task 3: Live 429/5xx evidence from the reasoning proxy

**Files:**
- Modify: `packages/pi-agent-server/src/gateway-proxy/nestor-reasoning-proxy.ts`
- Test: `packages/pi-agent-server/src/gateway-proxy/nestor-reasoning-proxy-real-server.test.ts`
  (existing stub-upstream harness; add a sibling `describe` block)

**Interfaces:**
- Produces: `formatGatewayThrottleLog(status: number, headers: Headers): string | null` —
  exported pure function; `null` for every status below 429 and for plain 4xx (400/401/404).

- [ ] **Step 1: Write the failing test (pure formatter)**

```ts
// append to nestor-reasoning-proxy-real-server.test.ts
import { formatGatewayThrottleLog } from './nestor-reasoning-proxy.ts';

describe('formatGatewayThrottleLog', () => {
  it('captures throttle evidence with trace ids, never auth material', () => {
    const headers = new Headers({
      'retry-after': '17',
      'x-request-id': 'req-1',
      'x-trace-id': 'trace-1',
      'nestor-token': 'MUST-NEVER-APPEAR',
    });
    const line = formatGatewayThrottleLog(429, headers)!;
    expect(line).toContain('status=429');
    expect(line).toContain('retry-after=17');
    expect(line).toContain('x-request-id=req-1');
    expect(line).toContain('x-trace-id=trace-1');
    expect(line).not.toContain('MUST-NEVER-APPEAR');
  });

  it('stays silent for ordinary statuses', () => {
    expect(formatGatewayThrottleLog(200, new Headers())).toBeNull();
    expect(formatGatewayThrottleLog(400, new Headers())).toBeNull();
    expect(formatGatewayThrottleLog(503, new Headers())).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** (`formatGatewayThrottleLog` is not exported).

Run: `bun test packages/pi-agent-server/src/gateway-proxy/nestor-reasoning-proxy-real-server.test.ts`

- [ ] **Step 3: Implement**

```ts
// nestor-reasoning-proxy.ts
/**
 * One log line per throttled/failed upstream response. The gateway advertises
 * no limits on success responses (verified 2026-08-07), so a live 429's
 * headers are the only evidence of WHICH limiter fired; x-request-id and
 * x-trace-id let the gateway owners answer that. Allow-listed fields only —
 * auth material must never reach a log.
 */
export function formatGatewayThrottleLog(status: number, headers: Headers): string | null {
  if (status !== 429 && status < 500) return null;
  const field = (name: string) => `${name}=${headers.get(name) ?? '-'}`;
  return [
    `upstream status=${status}`,
    field('retry-after'),
    field('x-request-id'),
    field('x-trace-id'),
    field('x-envoy-upstream-service-time'),
  ].join(' ');
}
```

At the single forwarding point (line ~326):

```ts
  const throttleLine = formatGatewayThrottleLog(upstream.status, responseHeaders);
  if (throttleLine) process.stderr.write(`[nestor-proxy] ${throttleLine}\n`);
  res.writeHead(upstream.status, headersToObject(responseHeaders));
```

- [ ] **Step 4: Run the proxy test directory**

Run: `bun test packages/pi-agent-server/src/gateway-proxy/`
Expected: PASS; existing passthrough cases untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/pi-agent-server/src/gateway-proxy/nestor-reasoning-proxy.ts \
        packages/pi-agent-server/src/gateway-proxy/nestor-reasoning-proxy-real-server.test.ts \
        docs/superpowers/plans/2026-08-07-gateway-429-resilience.md
git commit -m "feat(gateway): proxy logs 429/5xx throttle evidence with trace ids [T3]"
```

---

### Task 4: Make auto-retry visible in chat

> **Three corrections found while executing this task (2026-08-07). The task was
> still worth doing; its premises were wrong.**
>
> 1. **"They are handled NOWHERE today" is FALSE.** `case 'auto_retry_start'` and
>    `case 'auto_retry_end'` have existed in `event-adapter.ts` since the baseline
>    commit `845cf0a41`, with three tests covering them — `grep -a` finds them, and
>    the premise's sweep simply missed them. So this task was not "add two cases"
>    but "fix two cases that already showed the user an attempt counter with **no
>    wait, no cause and no `statusType`**". The gap it chases is still real — a
>    240-second wait rendered as `Retrying (attempt 5/5)...` reads as hung — but
>    the framing was wrong.
> 2. **`auto_retry_start` is NOT 429-specific.** It fires for every error
>    `pi-ai/dist/utils/retry.js` classifies retryable: `timed?out`, `500`–`504`,
>    `fetch failed`, `socket hang up`, `websocket.?closed`. This plan hardcoded
>    `Rate limited by the provider` for all of them, which states a FALSE CAUSE on
>    most retries. The implementation classifies off `errorMessage` and says
>    `Provider error — …` otherwise, so the SessionManager sniff matches three
>    prefixes rather than one.
> 3. **The plan's `auto_retry_end` body DELETES an existing error emission** — it
>    drops the failure branch on the theory that "the terminal error surfaces
>    through the existing rate_limited error mapping". That branch exists today and
>    is covered by `should emit error for failed auto_retry_end`. It was kept, and
>    the success status added alongside.
>
> Line numbers below have drifted: `SessionManager.ts` 18975 → 19403. `dto.ts:415`
> and `message.ts:316`/`:410` were accurate.

**Files:**
- Modify: `packages/shared/src/agent/backend/pi/event-adapter.ts` (two new cases in the
  session-level events section, beside `case 'compaction_start'` at ~line 837)
- Modify: `packages/server-core/src/sessions/SessionManager.ts` (~line 18975 — the
  `statusType` keyword sniff)
- Modify: `packages/shared/src/protocol/dto.ts:415` and
  `packages/core/src/types/message.ts:316`, `:410` (widen `statusType` unions)
- Test: the event-adapter test file colocated with `event-adapter.ts` (find it:
  `ls packages/shared/src/agent/backend/pi/*test*`; the `compaction_start` →
  `status` mapping case is the template)

**Interfaces:**
- Consumes: forwarded events `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage }`
  and `auto_retry_end { success, attempt, finalError? }` (already flowing — see premises).
- Produces: status messages beginning with the literal `Rate limited` (the sniff keyword)
  and `statusType: 'retrying'` on the wire.

- [ ] **Step 1: Failing test on the adapter mapping**

Clone the existing `compaction_start` mapping test and assert:
feeding `{ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 30000 }`
yields `{ type: 'status', message: 'Rate limited by the provider — retry 2/5 in 30s' }`;
feeding `{ type: 'auto_retry_end', success: true, attempt: 2 }` yields
`{ type: 'status', message: 'Retry succeeded — resuming...' }`.

Run the colocated test file; expected: FAIL (events fall through to the default arm).

- [ ] **Step 2: Implement the adapter cases** (after `compaction_end`'s block):

```ts
      case 'auto_retry_start': {
        const retry = event as unknown as {
          attempt: number; maxAttempts: number; delayMs: number;
        };
        // "Rate limited" keyword -> session handler stamps statusType: 'retrying'
        // (same sniff mechanism as 'Compacting' above).
        yield {
          type: 'status',
          message: `Rate limited by the provider — retry ${retry.attempt}/${retry.maxAttempts} in ${Math.round(retry.delayMs / 1000)}s`,
        };
        break;
      }

      case 'auto_retry_end': {
        const retry = event as unknown as { success: boolean };
        if (retry.success) {
          yield { type: 'status', message: 'Retry succeeded — resuming...' };
        }
        // Failure needs no status: the terminal error message surfaces through
        // the existing rate_limited error mapping.
        break;
      }
```

If `AgentSessionEvent`'s union does not carry these members, keep the
`as unknown as` cast — the payload shape is pinned by `agent-session.js` `_emit` calls
(see premises).

- [ ] **Step 3: Widen the wire unions + the sniff**

- `packages/shared/src/protocol/dto.ts:415`:
  `statusType?: 'compacting' | 'hook' | 'retrying'`
- `packages/core/src/types/message.ts:316` and `:410`:
  `statusType?: 'compacting' | 'compaction_complete' | 'retrying'`
- `packages/server-core/src/sessions/SessionManager.ts` ~18975:

```ts
          statusType: event.message.includes('Compacting')
            ? 'compacting'
            : event.message.startsWith('Rate limited')
              ? 'retrying'
              : undefined
```

No renderer change: `ChatDisplay.tsx` already renders `currentStatus.message`; the
`statusType` value is available for styling later.

- [ ] **Step 4: Gates**

Run: `bun test <the adapter test file> && bun run typecheck:all`
Expected: green. (No i18n gates — no locale keys were added, matching the compaction
precedent.)

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/agent/backend/pi/event-adapter.ts \
        packages/shared/src/protocol/dto.ts packages/core/src/types/message.ts \
        packages/server-core/src/sessions/SessionManager.ts \
        <the adapter test file> \
        docs/superpowers/plans/2026-08-07-gateway-429-resilience.md
git commit -m "feat(gateway): rate-limit retries visible in chat [T4]"
```

---

### Task 5: Close-out (final regression + release bookkeeping)

**Files:**
- Modify: `package.json`, `apps/electron/package.json` (lockstep patch bump from whatever
  version is current at execution time)
- Create: `apps/electron/resources/release-notes/<bumped-version>.md`
- Modify: `docs-site/` ONLY if a page documents gateway retry behavior (check:
  `rg -rn "429|rate limit" docs-site/content | head` — if no hits, no docs-site change)

- [ ] **Step 1: Final regression**

Ensure no other `bun test` process is running and no `release/` dir exists
(`rm -rf release` first if it does — packaged app copies poison test collection). Then:

```bash
bun run typecheck:all
cd apps/cli && bun run typecheck; cd ../..
bun run lint
bun test packages/pi-agent-server packages/shared/src/agent
```
Expected: all green; cross-check any failure against
`docs/superpowers/specs/2026-07-29-known-failing-tests.md` before treating it as new.

- [ ] **Step 2: Version bump + release notes**

Patch-bump BOTH `package.json` files in lockstep. Create
`apps/electron/resources/release-notes/<version>.md` in the in-app style
(`# Nessy Desktop <version>`, date line, then sections):

```markdown
## IMPROVED
- Nessy Gateway rate limits are now ridden out automatically (up to 5 retries across
  ~8 minutes, matching nessy-cli behavior) with a visible retry status in chat.

## FIXED
- Subagent starts no longer hammer a throttled gateway with 250ms retries.
```

- [ ] **Step 3: Tracker final sweep** — all rows ✅ with commit shas.

- [ ] **Step 4: Commit**

```bash
git add package.json apps/electron/package.json apps/electron/resources/release-notes/ \
        docs/superpowers/plans/2026-08-07-gateway-429-resilience.md
git commit -m "chore(release): close out gateway-429 resilience plan [T5]"
```

## Deferred (recorded, not tasked)

- ~~**Compaction threshold for the gateway** stays at the Pi default~~ **CLOSED
  2026-08-08 by measurement + a fix, `0acdd4511` (1.21.3).** Three things were
  settled, and two of them refuted the reason this row existed:
  - **Estimator drift is not the mechanism and never was.** `_checkCompaction`
    compares `calculateContextTokens(assistantMessage.usage)` — the PROVIDER's
    reported count; a local estimate is used only when a response carries no
    usage at all. Measured on a live gateway session: the context the app reports
    equalled the gateway's own totals on **12 of 12 turns, 0.0000 % divergence**,
    because the meter is anchored on that same report. A "measure our estimator
    against `usage.prompt_tokens`" exercise answers a question that does not gate
    the decision.
  - **The 419k probe that motivated the thin-margin argument never went through a
    Pi session** — it was a raw HTTP rate-limit probe. And a single over-window
    input cannot be compacted away in any case: compaction summarises prior
    history, and a first message has none.
  - **What WAS real is arithmetic, not margin.** The default reserve of 16 384 is
    smaller than the 25 000 our own contract permits for a SINGLE MCP tool result
    (`mcp.md` § MCP output limits and warnings), so one permitted tool call could
    take a session from just under the threshold to over the window with no check
    in between. Fixed: the reserve now floors at the live tool-result cap plus a
    user-message allowance, capped at a third of capacity and never below the SDK
    default. Live-verified in `AGT-9`; see the checklist run of 2026-08-08.
- **Retry-After honoring inside Pi's session retry** needs an upstream Pi SDK change;
  with a 15–240s ladder it is not load-bearing. Revisit if Task 3's production logs show
  `retry-after` values larger than our ladder. If revisited, there are TWO routes:
  (a) the upstream Pi SDK change; (b) proxy-level replay —
  `nestor-reasoning-proxy.ts` already buffers the full request body before
  `fetchImpl` (`readRequestBody`, ~:269), so on a pre-stream 429 it can wait out
  Retry-After and re-send without touching Pi. Reference implementation for (b):
  opencodex `src/lib/upstream-retry.ts` (see Prior art). Caution: proxy retries
  STACK multiplicatively under Pi's own session ladder — if (b) is built, scope
  it to waits Pi would not survive (Retry-After exceeding Pi's next delay) or
  make one layer own the wait.
- **Backoff jitter:** Pi's session ladder and the spawner's backoff are both
  unjittered, and gateway children share one per-user limiter, so concurrent
  retriers can re-collide in sync. Not load-bearing at ≤3 spawn attempts;
  opencodex's ±20% formula (`retryBackoffDelayMs`, see Prior art) is the
  reference if Task 3's logs show synchronized re-hits.
- **Mini-model note:** title/summary mini-completions already resolve to the gateway's
  `fast`-alias model (`getMiniModel` → `findSmallModel`,
  `packages/shared/src/config/llm-connections.ts:264`) — no change needed there.

## Tracker

| Task | Status | Commit | Note |
| --- | --- | --- | --- |
| T1 session retry profile | ✅ | `parity(gateway-retry-profile)` | gateway ladder 15/30/60/120/240s (crosses a full minute window; Pi's default gives up after ~14s total). Two plan premises corrected — see the note on the task. Executor's own first control exposed a WORTHLESS test ("puts the SDK back on its own ladder" passed with the code fully broken, because SDK defaults are what it asserted); it was rewritten and re-controlled. Orchestrator added the call-ORDER pin the executor's test could not provide. |
| T2 spawner backoff | ✅ | same commit | 250ms → 5s on the gateway. `retryBaseDelayMs` became a READER, not a snapshot — see the note on the task; a snapshot would have kept the old endpoint's backoff across a proxy start/stop that commits no capability generation. |
| T3 proxy throttle log | ✅ | same commit | `formatGatewayThrottleLog` at the single response-forwarding point, plus a live-proxy case beyond the plan: a real proxy over HTTP asserting the 429 line appears with trace ids, that neither the request bearer token nor a non-allow-listed response header leaks, and that a 200 emits nothing. Control (G) — dropping only the `stderr.write` — fails ONLY that live case, which is why it was added. |
| T4 visible retries | ✅ | same commit | three plan premises corrected — see the note on the task; the biggest is that these two cases already existed, so the work was fixing a line that showed an attempt counter with no wait and no cause. |
| T5 close-out | ✅ | `chore(release): 1.20.1` | full regression green; version 1.20.1 in lockstep with a new release-notes file. **No `docs-site` change, by the task's own rule** — its check (`429\|rate limit` under `docs-site/content`) hits only the VitePress build cache and `dist/`, never a source page, so there is no page documenting gateway retry behaviour to update. |
