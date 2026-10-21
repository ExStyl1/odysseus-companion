import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs';
import { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager, type ModelRuntime, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, retryDelayMs, type AssistantMessage, type Model } from '@earendil-works/pi-ai';

import {
  GATEWAY_RETRY_SETTINGS,
  GATEWAY_SPAWN_RETRY_BASE_DELAY_MS,
  GATEWAY_UTILITY_RETRY_SETTINGS,
  PI_DEFAULT_RETRY_SETTINGS,
  PI_PROVIDER_RETRY_SETTINGS,
  PI_UTILITY_PROVIDER_RETRY_SETTINGS,
  PI_UTILITY_RETRY_SETTINGS,
  applyRetryPolicy,
  providerRetrySettingsFor,
  resolveRetrySettings,
  resolveSpawnRetryBaseDelayMs,
  type RetrySettings,
} from './gateway-retry-settings.ts';
import { DEFAULT_SPAWN_RETRY_BASE_DELAY_MS } from './orchestrator/spawner.ts';
import { EPHEMERAL_QUERY_DEADLINE_MS } from './ephemeral-query-lifecycle.ts';

describe('resolveRetrySettings', () => {
  it('returns the long gateway profile when the gateway runtime is active', () => {
    expect(resolveRetrySettings(true)).toEqual(GATEWAY_RETRY_SETTINGS);
    // UB2.15 — the measured ladder untouched, the provider block stacked under it.
    expect(GATEWAY_RETRY_SETTINGS).toEqual({
      maxRetries: 5,
      baseDelayMs: 15_000,
      provider: { maxRetries: 2, maxRetryDelayMs: 60_000 },
    });
  });

  it('restores Pi SDK defaults when the runtime leaves the gateway', () => {
    expect(resolveRetrySettings(false)).toEqual(PI_DEFAULT_RETRY_SETTINGS);
    expect(PI_DEFAULT_RETRY_SETTINGS).toEqual({
      maxRetries: 3,
      baseDelayMs: 2_000,
      provider: { maxRetries: 2, maxRetryDelayMs: 60_000 },
    });
  });
});

/**
 * P6.273 — the operator's attempt ceiling reaches this seam.
 *
 * The env is passed EXPLICITLY rather than mutated on `process.env`: assigning
 * to a name Bun pre-creates a slot for leaves it readable by property and
 * invisible to a spread, so a suite that mutated the real environment would be
 * testing a shape no subprocess ever receives (AGENTS.md, measured 2026-09-01).
 */
describe('P6.273 · the retry ceiling an operator set', () => {
  it('keeps both shipped ladders byte-identical when nothing is set', () => {
    // BY REFERENCE, not merely by value: the frozen profile objects are what
    // callers had before this row, so nothing about the ladder moved.
    expect(resolveRetrySettings(true, {})).toBe(GATEWAY_RETRY_SETTINGS);
    expect(resolveRetrySettings(false, {})).toBe(PI_DEFAULT_RETRY_SETTINGS);
    expect(resolveRetrySettings(true, { NESSY_MAX_API_RETRIES: '  ' })).toBe(GATEWAY_RETRY_SETTINGS);
  });

  it('moves maxRetries on either profile and leaves the measured delay alone', () => {
    expect(resolveRetrySettings(true, { NESSY_MAX_API_RETRIES: '9' }))
      .toEqual({ maxRetries: 9, baseDelayMs: GATEWAY_RETRY_SETTINGS.baseDelayMs, provider: PI_PROVIDER_RETRY_SETTINGS });
    expect(resolveRetrySettings(false, { NESSY_MAX_API_RETRIES: '9' }))
      .toEqual({ maxRetries: 9, baseDelayMs: PI_DEFAULT_RETRY_SETTINGS.baseDelayMs, provider: PI_PROVIDER_RETRY_SETTINGS });
  });

  it('accepts the documented claude spelling as a compat alias, with ours winning', () => {
    expect(resolveRetrySettings(true, { CLAUDE_CODE_MAX_RETRIES: '4' }).maxRetries).toBe(4);
    expect(
      resolveRetrySettings(true, { NESSY_MAX_API_RETRIES: '2', CLAUDE_CODE_MAX_RETRIES: '4' }).maxRetries,
    ).toBe(2);
  });

  it('refuses a bad value BY NAME and keeps the profile, rather than defaulting in silence', () => {
    const said: string[] = [];
    expect(resolveRetrySettings(true, { NESSY_MAX_API_RETRIES: 'lots' }, m => said.push(m)))
      .toBe(GATEWAY_RETRY_SETTINGS);
    expect(said.join(' ')).toContain('NESSY_MAX_API_RETRIES');
    // The sentence has to be TRUE: the house reader would have ended it "using
    // 0 instead", naming a ladder nobody runs.
    expect(said.join(' ')).toContain('the retry ladder is unchanged');
    expect(said.join(' ')).not.toContain('using 0 instead');
    // "the variable can adjust the cap but can't disable it" — a 0-attempt
    // ladder fails the session on the first transient 429.
    expect(resolveRetrySettings(true, { NESSY_MAX_API_RETRIES: '0' })).toBe(GATEWAY_RETRY_SETTINGS);
  });

  it('reaches the Pi SDK itself, which is the only place the ladder is spent', () => {
    const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
    applyRetryPolicy({ settingsManager }, true, { NESSY_MAX_API_RETRIES: '8' });
    expect(settingsManager.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: 8,
      baseDelayMs: 15_000,
      // 0.87 added a per-delay cap the SDK spends itself (pi-ai retry.js
      // `retryDelayMs`: `min(baseDelayMs * 2 ** (attempt - 1), maxAgentDelayMs)`);
      // our profile leaves the knob unset, so the vendored 60 s default applies.
      maxAgentDelayMs: 60_000,
    });
  });
});

/**
 * `_prepareRetry` (agent-session.js) computes the wait through pi-ai's
 * `retryDelayMs`: `baseDelayMs * 2 ** (attempt - 1)` capped at
 * `maxAgentDelayMs` — unset in our profiles, so the vendored 60 s default
 * (pi-ai retry.js `DEFAULT_MAX_AGENT_RETRY_DELAY_MS`) bounds every wait. The
 * 0.85 ladder was uncapped; the cap is 0.87's own direction and the properties
 * the plan is for survive it — the ladder still leaves the per-minute limiter
 * window and stays bounded.
 */
const VENDORED_MAX_AGENT_RETRY_DELAY_MS = 60_000;
function retryLadder(settings: { maxRetries: number; baseDelayMs: number }): number[] {
  return Array.from(
    { length: settings.maxRetries },
    (_unused, index) => Math.min(settings.baseDelayMs * 2 ** index, VENDORED_MAX_AGENT_RETRY_DELAY_MS),
  );
}

describe('the gateway retry ladder', () => {
  it('waits past a full per-minute window, unlike the Pi default', () => {
    const gateway = retryLadder(GATEWAY_RETRY_SETTINGS);
    const piDefault = retryLadder(PI_DEFAULT_RETRY_SETTINGS);

    expect(gateway).toEqual([15_000, 30_000, 60_000, 60_000, 60_000]);
    // The whole reason for the change: Pi's default gives up 14s in, inside the
    // same limiter minute that rejected the request.
    expect(piDefault.reduce((a, b) => a + b, 0)).toBeLessThan(60_000);
    // A wait as long as the limiter window by attempt 3, so that attempt starts
    // in a window the throttled one did not touch.
    expect(gateway.some(delay => delay >= 60_000)).toBe(true);
    // ...and still bounded: a stuck turn cannot hang for hours.
    expect(gateway.reduce((a, b) => a + b, 0)).toBeLessThan(8 * 60_000);
  });
});

describe('the gateway child-spawn backoff', () => {
  it('outlives a limiter burst that the spawner default lands inside', () => {
    // The spawner ladder is base x 2^(attempt-1) over MAX_ATTEMPTS = 3.
    const total = (base: number) => base + base * 2;

    expect(resolveSpawnRetryBaseDelayMs(false)).toBe(DEFAULT_SPAWN_RETRY_BASE_DELAY_MS);
    expect(resolveSpawnRetryBaseDelayMs(true)).toBe(GATEWAY_SPAWN_RETRY_BASE_DELAY_MS);

    expect(total(DEFAULT_SPAWN_RETRY_BASE_DELAY_MS)).toBeLessThan(1_000);
    expect(total(GATEWAY_SPAWN_RETRY_BASE_DELAY_MS)).toBe(15_000);
    // Long enough that the last child start is seconds — not milliseconds —
    // after the 429 that rejected the first.
    expect(GATEWAY_SPAWN_RETRY_BASE_DELAY_MS).toBeGreaterThanOrEqual(5_000);
    // ...and still short enough that a dead gateway fails a fan-out promptly.
    expect(total(GATEWAY_SPAWN_RETRY_BASE_DELAY_MS)).toBeLessThanOrEqual(30_000);
  });
});

describe('applyRetryPolicy', () => {
  const inMemorySettings = () => SettingsManager.inMemory({}, { projectTrusted: false });

  it('makes the Pi SDK itself report the gateway ladder', () => {
    const settingsManager = inMemorySettings();
    expect(settingsManager.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2_000,
      maxAgentDelayMs: 60_000,
    });

    applyRetryPolicy({ settingsManager }, true);

    // getRetrySettings() is the exact call `_prepareRetry` makes.
    expect(settingsManager.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: 5,
      baseDelayMs: 15_000,
      maxAgentDelayMs: 60_000,
    });
  });

  it('puts the SDK back on its own ladder when the gateway is not active', () => {
    const settingsManager = inMemorySettings();
    applyRetryPolicy({ settingsManager }, true);
    // Guard rail: without this the case would also pass against a no-op
    // `applyRetryPolicy`, because SDK defaults are what it asserts.
    expect(settingsManager.getRetrySettings().baseDelayMs).toBe(15_000);

    applyRetryPolicy({ settingsManager }, false);

    expect(settingsManager.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2_000,
      maxAgentDelayMs: 60_000,
    });
  });

  it('is wiped by a later compaction toggle — which is why callers apply it LAST', () => {
    // `setCompactionEnabled` ends in `save()`, and `save()` rebuilds `settings`
    // from global+project (settings-manager.js:386-387), discarding every
    // in-memory `applyOverrides`. `applySessionRuntimePolicies` in index.ts
    // therefore runs the compaction policy FIRST and this second; reversing the
    // two silently restores Pi's 14-second give-up.
    const settingsManager = inMemorySettings();
    applyRetryPolicy({ settingsManager }, true);
    settingsManager.setCompactionEnabled(true);

    expect(settingsManager.getRetrySettings()).toEqual({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 2_000,
      maxAgentDelayMs: 60_000,
    });

    applyRetryPolicy({ settingsManager }, true);
    expect(settingsManager.getRetrySettings().baseDelayMs).toBe(15_000);
  });

  // The case above pins the SDK BEHAVIOUR (a later `save()` wipes the
  // overrides). It cannot pin the CALL ORDER, because `index.ts` calls `main()`
  // at module load and is therefore not importable — so reversing the two lines
  // in `applySessionRuntimePolicies` breaks the gateway retry ladder and every
  // runtime test stays green. Measured: the orchestrator reversed them and this
  // whole file still passed 7/7.
  //
  // This is the package's source-reading contract form (the same shape
  // `pi-harness-baseline.test.ts` uses for `configureSpawnerForGeneration`),
  // and it is the only thing standing between that reversal and a silent
  // regression to Pi's 14-second give-up on a throttled gateway.
  it('applies the retry policy AFTER the compaction policy at the one call site', () => {
    const source = readFileSync(
      new URL('./index.ts', import.meta.url).pathname,
      'utf-8',
    );
    const start = source.indexOf('function applySessionRuntimePolicies');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}', start));
    const compactionAt = body.indexOf('applyAutoCompactionPolicy(');
    const retryAt = body.indexOf('applyRetryPolicy(');
    expect(compactionAt).toBeGreaterThan(-1);
    expect(retryAt).toBeGreaterThan(-1);
    expect(retryAt).toBeGreaterThan(compactionAt);
  });
});

/**
 * F1.307 — a utility session (title / summary mini-completions, `call_llm`)
 * runs its ephemeral query under F1.239's ONE deadline,
 * `EPHEMERAL_QUERY_DEADLINE_MS` (115 s, inside the host's 120 s RPC timeout),
 * and used to get the main session's gateway ladder: 15 + 30 + 60 = 105 s of
 * backoff by attempt 3, so the deadline killed the query mid-ladder and the
 * last attempts could never run. The utility profile keeps the gateway's
 * MEASURED base delay (the limiter window) and takes only the attempts that fit.
 * craft-agents-oss v0.13.4 splits the same way (`session-settings.ts`,
 * `CRAFT_PI_EPHEMERAL_RETRY_SETTINGS`: 2 retries, a smaller budget for utility
 * sessions, Apache-2.0).
 */
describe('F1.307 · the utility retry profile fits inside the ephemeral deadline', () => {
  const total = (settings: { maxRetries: number; baseDelayMs: number }) =>
    retryLadder(settings).reduce((a, b) => a + b, 0);

  it('CONTROL — the main gateway ladder does not fit the deadline, which is the defect', () => {
    expect(retryLadder(GATEWAY_RETRY_SETTINGS).slice(0, 3).reduce((a, b) => a + b, 0)).toBe(105_000);
    expect(total(GATEWAY_RETRY_SETTINGS)).toBeGreaterThan(EPHEMERAL_QUERY_DEADLINE_MS);
    // The main session keeps 5 x 15 s, byte-identical, by reference.
    expect(resolveRetrySettings(true, {})).toBe(GATEWAY_RETRY_SETTINGS);
    expect(resolveRetrySettings(true, {}, undefined, 'main')).toBe(GATEWAY_RETRY_SETTINGS);
  });

  it('on the gateway a utility session keeps the measured base delay and a whole ladder that leaves half the deadline for its attempts', () => {
    const utility = resolveRetrySettings(true, {}, undefined, 'utility');
    expect(utility.baseDelayMs).toBe(GATEWAY_RETRY_SETTINGS.baseDelayMs);
    expect(utility.maxRetries).toBeGreaterThanOrEqual(1);
    expect(total(utility)).toBeLessThanOrEqual(EPHEMERAL_QUERY_DEADLINE_MS / 2);
  });

  it('off the gateway a utility session gets a short ladder inside the deadline too', () => {
    const utility = resolveRetrySettings(false, {}, undefined, 'utility');
    expect(utility.maxRetries).toBeGreaterThanOrEqual(1);
    expect(total(utility)).toBeLessThanOrEqual(EPHEMERAL_QUERY_DEADLINE_MS / 2);
  });

  it('an operator ceiling can LOWER the utility attempts but never raise them past the deadline', () => {
    const shipped = resolveRetrySettings(true, {}, undefined, 'utility');
    expect(resolveRetrySettings(true, { NESSY_MAX_API_RETRIES: '1' }, undefined, 'utility').maxRetries).toBe(1);
    expect(resolveRetrySettings(true, { NESSY_MAX_API_RETRIES: '10' }, undefined, 'utility')).toEqual(shipped);
    // The main profile still honours the full ceiling (P6.273, unchanged).
    expect(resolveRetrySettings(true, { NESSY_MAX_API_RETRIES: '10' }).maxRetries).toBe(10);
  });

  it('reaches the Pi SDK itself: applyRetryPolicy(..., "utility") is what getRetrySettings() reports', () => {
    const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
    applyRetryPolicy({ settingsManager }, true, {}, undefined, 'utility');
    const { provider: _provider, ...utility } = resolveRetrySettings(true, {}, undefined, 'utility');
    expect(settingsManager.getRetrySettings()).toEqual({ enabled: true, maxAgentDelayMs: 60_000, ...utility });
    expect(settingsManager.getRetrySettings().maxRetries).toBeLessThan(GATEWAY_RETRY_SETTINGS.maxRetries);
  });

  it('index.ts applies the UTILITY profile at the ephemeral session site and nowhere else', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf-8');
    const calls = source.split('\n').filter(line => /^\s*applyRetryPolicy\(/.test(line));
    const utilityCalls = calls.filter(line => line.includes("'utility'"));
    expect(utilityCalls).toHaveLength(1);
    expect(utilityCalls[0]).toContain('ephemeralRuntime.session');
    expect(calls.length).toBeGreaterThan(utilityCalls.length);
  });
});

/**
 * UB2.15 — upstream v0.15.1's provider-level block (`session-settings.ts`,
 * `CRAFT_PI_RETRY_SETTINGS.provider` {2, 60 s} / ephemeral {2, 10 s}; Apache-2.0)
 * stacked under our measured agent ladders. UB5.3 measured why: with the block
 * pi-ai honours `retry-after` at the provider level; without it the 429 re-rolls
 * the whole turn on the agent ladder and the header is discarded.
 */
describe('UB2.15 · the provider-level retry block', () => {
  it('positive — every profile carries upstream\'s block, main {2, 60 s} and utility {2, 10 s}, on and off the gateway', () => {
    expect(resolveRetrySettings(true)).toEqual({
      maxRetries: 5,
      baseDelayMs: 15_000,
      provider: { maxRetries: 2, maxRetryDelayMs: 60_000 },
    });
    expect(resolveRetrySettings(false).provider).toEqual({ maxRetries: 2, maxRetryDelayMs: 60_000 });
    for (const gatewayActive of [true, false]) {
      expect(resolveRetrySettings(gatewayActive, {}, undefined, 'utility').provider)
        .toEqual({ maxRetries: 2, maxRetryDelayMs: 10_000 });
    }
    expect(providerRetrySettingsFor('main')).toBe(PI_PROVIDER_RETRY_SETTINGS);
    expect(providerRetrySettingsFor('utility')).toBe(PI_UTILITY_PROVIDER_RETRY_SETTINGS);
  });

  it('negative — the operator ceiling moves only the agent maxRetries, never the provider block, and unset stays the frozen profile', () => {
    for (const gatewayActive of [true, false]) {
      const main = resolveRetrySettings(gatewayActive, { NESSY_MAX_API_RETRIES: '9' });
      expect(main.maxRetries).toBe(9);
      expect(main.provider).toBe(PI_PROVIDER_RETRY_SETTINGS);
      const utility = resolveRetrySettings(gatewayActive, { NESSY_MAX_API_RETRIES: '1' }, undefined, 'utility');
      expect(utility.maxRetries).toBe(1);
      expect(utility.provider).toBe(PI_UTILITY_PROVIDER_RETRY_SETTINGS);
    }
    // Unset is still byte-identical BY REFERENCE (P6.273's promise survives the new key).
    expect(resolveRetrySettings(true, {})).toBe(GATEWAY_RETRY_SETTINGS);
    expect(resolveRetrySettings(false, {})).toBe(PI_DEFAULT_RETRY_SETTINGS);
    expect(resolveRetrySettings(true, {}, undefined, 'utility')).toBe(GATEWAY_UTILITY_RETRY_SETTINGS);
    expect(resolveRetrySettings(false, {}, undefined, 'utility')).toBe(PI_UTILITY_RETRY_SETTINGS);
    // The block is frozen too: nothing downstream can widen it in place.
    expect(Object.isFrozen(PI_PROVIDER_RETRY_SETTINGS)).toBe(true);
    expect(Object.isFrozen(PI_UTILITY_PROVIDER_RETRY_SETTINGS)).toBe(true);
  });

  it('reaches the Pi SDK: applyRetryPolicy turns the provider block on where our wiring left Pi\'s 0', () => {
    const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
    // CONTROL — the wiring before this row: Pi's provider retry is OFF
    // (`maxRetries ?? 0` in pi-ai provider-retry.js).
    expect(settingsManager.getProviderRetrySettings().maxRetries).toBeUndefined();
    applyRetryPolicy({ settingsManager }, true, {});
    expect(settingsManager.getProviderRetrySettings()).toEqual({
      timeoutMs: undefined,
      maxRetries: 2,
      maxRetryDelayMs: 60_000,
    });
    // The agent ladder is unchanged by the stacked block.
    expect(settingsManager.getRetrySettings().baseDelayMs).toBe(15_000);
  });

  /**
   * The worst case upstream budgets (`CRAFT_PI_EPHEMERAL_MAX_BACKOFF_MS`): every
   * agent attempt spends its provider retries at the cap, then the agent ladder
   * sleeps between attempts. It must fit F1.239's one ephemeral deadline.
   */
  const worstCaseBackoffMs = (settings: RetrySettings, provider = settings.provider) =>
    provider.maxRetries * provider.maxRetryDelayMs * (settings.maxRetries + 1)
    + retryLadder(settings).reduce((a, b) => a + b, 0);

  it('positive — a utility query\'s worst-case provider + agent backoff fits the ephemeral deadline, on and off the gateway', () => {
    for (const gatewayActive of [true, false]) {
      const utility = resolveRetrySettings(gatewayActive, {}, undefined, 'utility');
      expect(worstCaseBackoffMs(utility)).toBeLessThan(EPHEMERAL_QUERY_DEADLINE_MS);
    }
    // The reading, so a later number change is a visible diff: 60 s + 45 s.
    expect(worstCaseBackoffMs(GATEWAY_UTILITY_RETRY_SETTINGS)).toBe(105_000);
    // The main session's stated bound (PI_PROVIDER_RETRY_SETTINGS docblock):
    // 6 attempts × 2 × 60 s + the 225 s ladder.
    expect(worstCaseBackoffMs(GATEWAY_RETRY_SETTINGS)).toBe(945_000);
  });

  it('CONTROL — the main block on a utility ladder would blow the deadline, which is why utility has its own 10 s cap', () => {
    expect(worstCaseBackoffMs(GATEWAY_UTILITY_RETRY_SETTINGS, PI_PROVIDER_RETRY_SETTINGS))
      .toBeGreaterThan(EPHEMERAL_QUERY_DEADLINE_MS);
  });

  /**
   * The cap's binding point, measured on the installed SDK through its own
   * request path: `createAgentSession`'s `streamFn` builds the request options
   * (`buildRequestOptions`) and hands them to `modelRuntime.streamSimple` — the
   * options pi-ai's `retryProviderRequest` reads. Offline (the steering-sdk rig):
   * the runtime answers locally and fails on any network reach.
   */
  const requestOptionsFor = async (
    settings: Parameters<typeof SettingsManager.inMemory>[0],
    purpose: 'main' | 'utility',
  ): Promise<{ maxRetries?: number; maxRetryDelayMs?: number }> => {
    const model: Model<'openai-completions'> = {
      id: 'offline-provider-retry-test', name: 'Offline', api: 'openai-completions', provider: 'openai',
      baseUrl: 'https://invalid.test', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
    };
    const resourceLoader: ResourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => 'Offline provider-retry test', getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources: () => {}, reload: async () => {},
    };
    const seen: { maxRetries?: number; maxRetryDelayMs?: number }[] = [];
    const { session } = await createAgentSession({
      cwd: import.meta.dir, model, settingsManager: SettingsManager.inMemory(settings, { projectTrusted: false }),
      sessionManager: SessionManager.inMemory(import.meta.dir), resourceLoader, tools: [],
      modelRuntime: {
        hasConfiguredAuth: () => true, getModel: () => model, getAvailableSnapshot: () => [model],
        streamSimple: (_model: unknown, _context: unknown, options: { maxRetries?: number; maxRetryDelayMs?: number }) => {
          seen.push({ maxRetries: options.maxRetries, maxRetryDelayMs: options.maxRetryDelayMs });
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = {
            role: 'assistant', content: [{ type: 'text', text: 'done' }], api: model.api, provider: model.provider,
            model: model.id, timestamp: Date.now(), stopReason: 'stop',
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          stream.push({ type: 'start', partial: { ...message, content: [], stopReason: 'pending' } as never });
          stream.push({ type: 'done', reason: 'stop', message });
          return stream;
        },
      } as unknown as ModelRuntime,
    });
    try {
      // What every production site does right after creation.
      applyRetryPolicy(session, true, {}, undefined, purpose);
      await session.prompt('hello');
    } finally {
      session.dispose();
    }
    expect(seen).toHaveLength(1);
    return seen[0]!;
  };

  it('CONTROL — an override after creation reaches maxRetries but NOT the cap: the Agent snapshots 60 s at creation', async () => {
    expect(await requestOptionsFor({}, 'utility')).toEqual({ maxRetries: 2, maxRetryDelayMs: 60_000 });
  });

  it('positive — seeded at creation (what createSession({ providerRetry }) builds), the utility request carries the 10 s cap', async () => {
    expect(
      await requestOptionsFor({ retry: { provider: { ...PI_UTILITY_PROVIDER_RETRY_SETTINGS } } }, 'utility'),
    ).toEqual({ maxRetries: 2, maxRetryDelayMs: 10_000 });
  });

  it('a main session needs no seed: Pi\'s creation-time cap IS the main block\'s 60 s', async () => {
    expect(await requestOptionsFor({}, 'main')).toEqual(PI_PROVIDER_RETRY_SETTINGS);
  });

  it('index.ts seeds the utility block at the one ephemeral createSession site and nowhere else', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf-8');
    const seeds = source.split('\n').filter(line => line.includes('providerRetry:'));
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toContain("providerRetrySettingsFor('utility')");
    // On the utility call itself: the line carries its memory strategy.
    expect(seeds[0]).toContain("strategy: { kind: 'memory' }");
  });
});

/**
 * UB12.33 · the files UB12.17 did not read, each of which still spelled
 * 15/30/60/120/240s (the `ChatDisplay.tsx` site moved to `ProcessingIndicator.tsx`
 * with UB14.15) or, in `index.ts`, priced the compaction posture at the uncapped
 * ladder's ~8 min. A file that moves fails the read here rather than leaving the
 * list quietly short.
 */
const UB12_33_LADDER_PROSE_FILES = [
  '../../../apps/electron/src/renderer/event-processor/retry-status.ts',
  '../../../apps/electron/src/renderer/components/app-shell/chat-display/ProcessingIndicator.tsx',
  '../../server-core/src/sessions/__tests__/session-retry-status-visibility.test.ts',
  '../../shared/src/agent/__tests__/pi-event-adapter.test.ts',
  './index.ts',
] as const;

/**
 * UB12.17 · the prose that spells the gateway ladder spells the one the SDK spends.
 *
 * Two comments said 15/30/60/120/240s, and `GATEWAY_RETRY_SETTINGS`'s docblock
 * added that Pi applies no per-delay cap, long after 0.87's `maxAgentDelayMs`
 * capped every wait at 60 s. The expectation below is COMPUTED through pi-ai's
 * own `retryDelayMs` over what `getRetrySettings()` reports once
 * `applyRetryPolicy` has run, so a lift that moves the cap or the base moves
 * the expectation, and the prose has to follow. Extend `LADDER_PROSE_FILES`
 * when another file spells the ladder.
 */
const LADDER_PROSE_FILES = [
  './gateway-retry-settings.ts',
  '../../shared/src/agent/usage-limit-reset.ts',
  '../../shared/src/agent/backend/pi/event-adapter.ts',
  ...UB12_33_LADDER_PROSE_FILES,
] as const;

/** Every `a/b/c…s` seconds ladder of three rungs or more the text spells, with its 1-based line. */
function ladderClaims(text: string): { line: number; ladder: string }[] {
  return text.split('\n').flatMap((lineText, index) =>
    [...lineText.matchAll(/\b(\d+(?:\/\d+){2,})\s?s\b/g)].map(match => ({ line: index + 1, ladder: match[1]! })));
}

function sdkGatewayLadderSeconds(): string {
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
  applyRetryPolicy({ settingsManager }, true, {});
  const settings = settingsManager.getRetrySettings();
  return Array.from({ length: settings.maxRetries }, (_unused, index) => retryDelayMs(settings, index + 1) / 1000).join('/');
}

function gatewayProfileDocblock(source: string): string {
  const at = source.indexOf('export const GATEWAY_RETRY_SETTINGS');
  const start = source.lastIndexOf('/**', at);
  expect(at).toBeGreaterThan(-1);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, at);
}

const readProse = (path: string) => readFileSync(new URL(path, import.meta.url).pathname, 'utf-8');

describe('UB12.17 · the retry prose states the ladder the SDK spends', () => {
  it('positive — every spelled ladder is the SDK-computed one, and the profile docblock names the cap and the provider block', () => {
    const expected = sdkGatewayLadderSeconds();
    expect(expected).toBe('15/30/60/60/60');
    const stale = LADDER_PROSE_FILES.flatMap(path =>
      ladderClaims(readProse(path)).filter(claim => claim.ladder !== expected).map(claim => ({ path, ...claim })));
    expect(stale).toEqual([]);
    // The successor is spelled, not merely the predecessor gone.
    expect(ladderClaims(readProse('./gateway-retry-settings.ts')).map(claim => claim.ladder)).toContain(expected);
    expect(ladderClaims(readProse('../../shared/src/agent/backend/pi/event-adapter.ts')).map(claim => claim.ladder))
      .toEqual([expected, expected]);
    const docblock = gatewayProfileDocblock(readProse('./gateway-retry-settings.ts'));
    expect(docblock).toContain('maxAgentDelayMs');
    expect(docblock).toContain('{@link PI_PROVIDER_RETRY_SETTINGS}');
    expect(docblock).not.toMatch(/no per-delay cap/i);
  });

  it('CONTROL — the pre-fix ladder planted back into the docblock is reported at its line by the same instrument', () => {
    const source = readProse('./gateway-retry-settings.ts');
    const successor = '15/30/60/60/60s';
    expect(source.split(successor)).toHaveLength(2); // the anchor is unique
    const planted = source.replace(successor, '15/30/60/120/240s');
    const line = source.slice(0, source.indexOf(successor)).split('\n').length;
    expect(ladderClaims(planted).filter(claim => claim.ladder !== sdkGatewayLadderSeconds()))
      .toEqual([{ line, ladder: '15/30/60/120/240' }]);
  });
});

/** The backoff the SDK ladder spends in all, in whole seconds (225 at Pi 0.87.1). */
function sdkGatewayLadderTotalSeconds(): number {
  return sdkGatewayLadderSeconds().split('/').reduce((sum, rung) => sum + Number(rung), 0);
}

/** UB12.33 · what is wrong with `index.ts`'s compaction posture comment; empty when it prices the SDK ladder. */
function compactionPostureProblems(source: string): string[] {
  const at = source.indexOf('// The consequence, stated rather than buried');
  const end = source.indexOf('reverse it by passing `undefined` here.', at);
  if (at < 0 || end < 0) return ['the posture comment is gone'];
  const comment = source.slice(at, end);
  const total = `${sdkGatewayLadderTotalSeconds()} s of backoff`;
  return [
    ...(comment.includes(total) ? [] : [`does not spell "${total}"`]),
    ...(comment.includes('PI_PROVIDER_RETRY_SETTINGS') ? [] : ['does not name the provider block under the ladder']),
    ...(/~\s?8\s?min/.test(comment) ? ['still prices the uncapped ladder (~8 min)'] : []),
  ];
}

describe('UB12.33 · the ladder prose outside UB12.17\'s files', () => {
  it('positive — each file spells the SDK ladder once, and index.ts prices the compaction posture at its total backoff', () => {
    const expected = sdkGatewayLadderSeconds();
    // The successor is spelled in every file, not merely the predecessor gone.
    expect(UB12_33_LADDER_PROSE_FILES.map(path => ({ path, ladders: ladderClaims(readProse(path)).map(claim => claim.ladder) })))
      .toEqual(UB12_33_LADDER_PROSE_FILES.map(path => ({ path, ladders: [expected] })));
    expect(sdkGatewayLadderTotalSeconds()).toBe(225);
    expect(compactionPostureProblems(readProse('./index.ts'))).toEqual([]);
  });

  it('CONTROL — the pre-fix ladder planted into each file, and the pre-fix worst case into index.ts, are reported by the same readings', () => {
    const successor = `${sdkGatewayLadderSeconds()}s`;
    for (const path of UB12_33_LADDER_PROSE_FILES) {
      const source = readProse(path);
      expect({ path, anchors: source.split(successor).length }).toEqual({ path, anchors: 2 }); // the anchor is unique
      const line = source.slice(0, source.indexOf(successor)).split('\n').length;
      const planted = source.replace(successor, '15/30/60/120/240s');
      expect({ path, stale: ladderClaims(planted).filter(claim => claim.ladder !== sdkGatewayLadderSeconds()) })
        .toEqual({ path, stale: [{ line, ladder: '15/30/60/120/240' }] });
    }
    const source = readProse('./index.ts');
    const total = `the ladder's ${sdkGatewayLadderTotalSeconds()} s of backoff`;
    expect(source.split(total)).toHaveLength(2);
    expect(compactionPostureProblems(source.replace(total, "the ladder's worst case (~8 min)"))).toEqual([
      `does not spell "${sdkGatewayLadderTotalSeconds()} s of backoff"`,
      'still prices the uncapped ladder (~8 min)',
    ]);
  });
});
