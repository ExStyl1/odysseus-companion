import { describe, expect, it } from 'bun:test';
import { getModels, getProviders } from '@earendil-works/pi-ai/compat';
import {
  PI_MINI_PREFERRED_DEFAULTS,
  PI_PREFERRED_DEFAULTS,
  isSmallClassModelId,
} from '../../shared/src/config/llm-connections.ts';
import {
  __resetMissingPinWarningsForTest,
  pickProviderAppropriateMiniModel,
} from './pick-mini-model.ts';

/**
 * Minimal mock of PiModelRegistry — mirrors the pattern from model-resolution.test.ts.
 */
function createMockRegistry(
  providers: Record<string, Array<{ id: string; name: string; provider?: string }>>,
) {
  const allModels = Object.entries(providers).flatMap(([provider, models]) =>
    models.map(m => ({ ...m, provider })),
  );

  return {
    find(provider: string, modelId: string) {
      const models = providers[provider];
      if (!models) return undefined;
      return models.find(m => m.id === modelId || m.name === modelId) ?? undefined;
    },
    getAll() {
      return allModels;
    },
  } as any;
}

describe('pickProviderAppropriateMiniModel', () => {
  it('picks the SMALL anthropic model, not the head of the primary list', () => {
    // P2.97. This used to assert `claude-opus-4-8` — the helper walked
    // PI_PREFERRED_DEFAULTS, which is ordered most-capable-first because it
    // answers a different question, so the mini/background slot got the most
    // expensive model the provider offers. The caller happens to gate anthropic
    // away from this helper, but the helper was wrong on its own terms and the
    // same walk was live for every other provider.
    //
    // MUTATION KILLED: reverting the walk to PI_PREFERRED_DEFAULTS — that list
    // heads with claude-opus-5, then claude-opus-4-8, both present here.
    const registry = createMockRegistry({
      anthropic: [
        { id: 'claude-opus-5', name: 'Claude Opus 5' },
        { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
        { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
      ],
    });

    const result = pickProviderAppropriateMiniModel('anthropic', registry, false);
    expect(result).toBe('claude-haiku-4-5');
  });

  it('openai-codex: skips denied codex-mini variants, returns first resolvable candidate', () => {
    // This test used to be VACUOUS and said so: no candidate in the walked list
    // was ever a *codex-mini*, so the denial it claims to cover could not fire.
    // The candidate list is injected here so a denied id is genuinely first and
    // genuinely resolvable — remove `isDeniedMiniModelId` from the loop and this
    // returns `gpt-5.1-codex-mini`, which the ChatGPT backend refuses outright.
    const registry = createMockRegistry({
      'openai-codex': [
        { id: 'gpt-5.1-codex-mini', name: 'GPT 5.1 Codex Mini' },
        { id: 'gpt-5.4-mini', name: 'GPT 5.4 Mini' },
      ],
    });
    const saved = PI_MINI_PREFERRED_DEFAULTS['openai-codex'];
    PI_MINI_PREFERRED_DEFAULTS['openai-codex'] = ['gpt-5.1-codex-mini', 'gpt-5.4-mini'];
    try {
      const result = pickProviderAppropriateMiniModel('openai-codex', registry, false);
      expect(result).toBe('gpt-5.4-mini');
    } finally {
      PI_MINI_PREFERRED_DEFAULTS['openai-codex'] = saved!;
    }
  });

  it('openai-codex: returns undefined when no preferred candidate resolves', () => {
    // No models registered under openai-codex — every candidate is unresolvable.
    const registry = createMockRegistry({
      'openai-codex': [],
    });

    const result = pickProviderAppropriateMiniModel('openai-codex', registry, false);
    expect(result).toBeUndefined();
  });

  it('openai: walks past an unresolvable head to the next SMALL candidate', () => {
    // PI_MINI_PREFERRED_DEFAULTS.openai heads with gpt-5-mini, which this
    // registry does not carry — so the walk must continue rather than give up,
    // and it must not fall back to the large models that ARE present.
    const registry = createMockRegistry({
      openai: [
        { id: 'gpt-5.5', name: 'GPT 5.5' },
        { id: 'gpt-5.4-mini', name: 'GPT 5.4 Mini' },
      ],
    });

    const result = pickProviderAppropriateMiniModel('openai', registry, false);
    expect(result).toBe('gpt-5.4-mini');
  });

  it('unknown provider: returns undefined', () => {
    const registry = createMockRegistry({
      openai: [{ id: 'gpt-5.5', name: 'GPT 5.5' }],
    });

    const result = pickProviderAppropriateMiniModel('made-up-provider', registry, false);
    expect(result).toBeUndefined();
  });

  it('empty registry: returns undefined', () => {
    const registry = createMockRegistry({});

    const result = pickProviderAppropriateMiniModel('openai-codex', registry, false);
    expect(result).toBeUndefined();
  });
});

// ============================================================
// P2.97 — measured against the SHIPPED Pi catalog, not a mock.
//
// The mock above is a fixture: it proves the walk, and it proved nothing about
// whether the candidates exist. Both failures this row closes were invisible to
// a mock — `github-copilot` spells its Claude ids with DOTS, and the Bedrock
// catalog carries only prefixed inference-profile ids — so both providers'
// mini pick resolved to NOTHING while every mock test stayed green.
//
// The facade below mirrors the shipped semantics, read out of node_modules:
//   ModelRegistry.find(p, id) → ModelRuntime.getModel → getModels(p).find(m => m.id === id)
//   ModelRegistry.getAll()    → every model, each carrying `.provider`
// ============================================================
describe('pickProviderAppropriateMiniModel against the shipped Pi catalog', () => {
  function realRegistry() {
    const byProvider = new Map<string, Array<Record<string, unknown>>>();
    for (const provider of getProviders()) {
      try {
        byProvider.set(provider, getModels(provider).map(model => ({ ...model, provider })));
      } catch {
        // Provider without a static catalog — skipped, same as production.
      }
    }
    const all = [...byProvider.values()].flat();
    return {
      find: (provider: string, modelId: string) =>
        (byProvider.get(provider) ?? []).find(model => model['id'] === modelId),
      getAll: () => all,
    } as never;
  }

  it('resolves a small model for every provider with a mini preference', () => {
    const registry = realRegistry();
    // Positive control: the catalog really loaded. Without it every expectation
    // below is satisfied by an empty registry returning undefined.
    expect((registry as unknown as { getAll(): unknown[] }).getAll().length).toBeGreaterThan(100);

    for (const provider of Object.keys(PI_MINI_PREFERRED_DEFAULTS)) {
      const picked = pickProviderAppropriateMiniModel(provider, registry, false);
      // MUTATION KILLED: an id that does not exist in that provider's catalog —
      // the exact defect for github-copilot (dots) and amazon-bedrock (bare ids).
      expect(picked, provider).toBeDefined();
      expect(isSmallClassModelId(picked!), `${provider}: ${picked}`).toBe(true);
    }
  });

  it('picks a geography-neutral Sonnet profile for Bedrock', () => {
    // Upstream: on Bedrock the small/fast default is a Sonnet, because "Haiku
    // may not be enabled in every account or region" (amazon-bedrock.md,
    // fetched 2026-08-25). `global.` because this seam has no access to the
    // connection's AWS region.
    const picked = pickProviderAppropriateMiniModel('amazon-bedrock', realRegistry(), false);
    expect(picked).toBe('global.anthropic.claude-sonnet-4-5-20250929-v1:0');
  });

  it('picks the DOTTED copilot haiku id', () => {
    // MUTATION KILLED: spelling copilot's ids the way every other provider in
    // PI_PREFERRED_DEFAULTS spells them (claude-haiku-4-5), which resolves to
    // nothing in that catalog.
    const picked = pickProviderAppropriateMiniModel('github-copilot', realRegistry(), false);
    expect(picked).toBe('claude-haiku-4.5');
  });
});

describe('the mini pick is loud when it cannot be small', () => {
  function captureStderr<T>(run: () => T): { result: T; written: string } {
    const original = process.stderr.write.bind(process.stderr);
    let written = '';
    ;(process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      written += chunk;
      return true;
    };
    try {
      return { result: run(), written };
    } finally {
      ;(process.stderr as unknown as { write: typeof original }).write = original;
    }
  }

  it('warns when the resolved candidate is not a small model', () => {
    // The fallback arm: a provider with no mini entry falls back to the
    // primary-model list, whose head is large. Silence there is how "background
    // tasks are billed at the Opus rate" happened without a word.
    //
    // MUTATION KILLED: dropping the warn call (or making it fire on every pick,
    // which the small-pick control below catches).
    const registry = createMockRegistry({ 'made-up-provider': [{ id: 'huge-model-1', name: 'Huge' }] });
    ;(PI_PREFERRED_DEFAULTS as Record<string, string[]>)['made-up-provider'] = ['huge-model-1'];
    try {
      const { result, written } = captureStderr(() =>
        pickProviderAppropriateMiniModel('made-up-provider', registry, false));
      expect(result).toBe('huge-model-1');
      expect(written).toContain('huge-model-1');
      expect(written).toContain('billed at that model');
    } finally {
      delete (PI_PREFERRED_DEFAULTS as Record<string, string[]>)['made-up-provider'];
    }
  });

  it('warns when no candidate resolves at all', () => {
    const registry = createMockRegistry({ 'openai-codex': [] });
    const { result, written } = captureStderr(() =>
      pickProviderAppropriateMiniModel('openai-codex', registry, false));
    expect(result).toBeUndefined();
    expect(written).toContain('no mini-model candidate resolved');
    expect(written).toContain('openai-codex');
  });

  it('CONTROL: says nothing when the pick IS small', () => {
    // Without this the warning could fire on every pick and both tests above
    // would still pass — a warning nobody can distinguish from noise.
    const registry = createMockRegistry({ anthropic: [{ id: 'claude-haiku-4-5', name: 'Haiku' }] });
    const { result, written } = captureStderr(() =>
      pickProviderAppropriateMiniModel('anthropic', registry, false));
    expect(result).toBe('claude-haiku-4-5');
    expect(written).toBe('');
  });
});

// ============================================================
// P2.309 — the codex mini pin had nothing behind it, and the day it retires
// is a DATE, not a hypothetical.
//
// `learn.chatgpt.com/docs/enterprise/workspace-model-availability.md#prepare-for-the-gpt-54-retirement`
// (fetched 2026-08-28): "On August 31, 2026, GPT-5.4 and GPT-5.4 mini retire
// from Codex for users signed in with ChatGPT." and "Replace `gpt-5.4-mini`
// with `gpt-5.6-luna` (GPT-5.6 Luna)."
//
// Measured against the SHIPPED Pi catalog for the same reason the block above
// is: the whole failure mode is an id that is not there, and a mock is exactly
// the instrument that cannot see it.
// ============================================================
/**
 * The shipped catalog, optionally with ids REMOVED — which is how the
 * post-retirement world is exercised without waiting for it. Same facade as the
 * P2.97 block above; module-scoped because the warning tests need it too.
 */
function shippedCatalogRegistry(retiredIds: readonly string[] = []) {
  const retired = new Set(retiredIds);
  const byProvider = new Map<string, Array<Record<string, unknown>>>();
  for (const provider of getProviders()) {
    try {
      byProvider.set(
        provider,
        getModels(provider)
          .filter(model => !retired.has(model.id))
          .map(model => ({ ...model, provider })),
      );
    } catch {
      // Provider without a static catalog — skipped, same as production.
    }
  }
  const all = [...byProvider.values()].flat();
  return {
    find: (provider: string, modelId: string) =>
      (byProvider.get(provider) ?? []).find(model => model['id'] === modelId),
    getAll: () => all,
  } as never;
}

describe('P2.309 · the openai-codex mini pin survives the GPT-5.4 retirement', () => {
  it('is more than one element, and every id exists in the shipped codex catalog', () => {
    // MUTATION KILLED: restoring the one-element `['gpt-5.4-mini']`. A single
    // pin has nothing to degrade TO — the length assertion is the row.
    const candidates = PI_MINI_PREFERRED_DEFAULTS['openai-codex']!;
    expect(candidates.length).toBeGreaterThan(1);

    const catalog = new Set(getModels('openai-codex').map(model => model.id));
    // Positive control: the catalog really loaded. Without it a `getModels`
    // that returned nothing would satisfy nothing below.
    expect(catalog.size).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(catalog.has(candidate), candidate).toBe(true);
      expect(isSmallClassModelId(candidate), candidate).toBe(true);
    }
  });

  it('picks the documented replacement today, not the retiring id', () => {
    // MUTATION KILLED: leaving `gpt-5.4-mini` at the head. It still resolves
    // until the 31st, so ONLY an assertion on which one wins catches that.
    expect(pickProviderAppropriateMiniModel('openai-codex', shippedCatalogRegistry(), false))
      .toBe('gpt-5.6-luna');
  });

  it('still resolves a small model once GPT-5.4 and 5.4-mini are gone', () => {
    // The row's actual claim, and it is a claim about a future catalog: on
    // 2026-08-31 both ids leave the codex catalog. Before this change the pick
    // returned `undefined` here — silently — and background tasks fell back to
    // a Haiku id that does not resolve under codex auth either.
    const afterRetirement = shippedCatalogRegistry(['gpt-5.4', 'gpt-5.4-mini']);
    const picked = pickProviderAppropriateMiniModel('openai-codex', afterRetirement, false);
    expect(picked).toBe('gpt-5.6-luna');
    expect(isSmallClassModelId(picked!)).toBe(true);
  });
});

// ============================================================
// P2.309 — the durable half: a pin that stopped existing is LOUD.
//
// Widening the list fixes this retirement. The warning is what stops the row
// recurring at the next one — the single-element list was only how the defect
// presented in August 2026.
// ============================================================
describe('P2.309 · a pinned id missing from the catalogue is named on stderr', () => {
  function captureStderr<T>(run: () => T): { result: T; written: string } {
    const original = process.stderr.write.bind(process.stderr);
    let written = '';
    ;(process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      written += chunk;
      return true;
    };
    try {
      return { result: run(), written };
    } finally {
      ;(process.stderr as unknown as { write: typeof original }).write = original;
    }
  }

  it('names the missing id, the provider, and still returns the next candidate', () => {
    // MUTATION KILLED: restoring the bare `if (!resolved) continue`. The pick
    // is IDENTICAL either way — a fall-through is the designed behaviour — so
    // only the stderr assertion can tell the silent version from the loud one.
    // The synthetic catalog holds the pin's TAIL (gpt-6-luna, the 0.87 pin)
    // while the HEAD is missing, so the warning names the head and the pick
    // still resolves.
    __resetMissingPinWarningsForTest();
    const registry = createMockRegistry({
      'openai-codex': [{ id: 'gpt-6-luna', name: 'GPT 6 Luna' }],
    });
    const { result, written } = captureStderr(() =>
      pickProviderAppropriateMiniModel('openai-codex', registry, false));

    expect(result).toBe('gpt-6-luna');
    expect(written).toContain('gpt-5.6-luna');
    expect(written).toContain('openai-codex');
    expect(written).toContain('no longer in the fetched catalogue');
  });

  it('says it once per (provider, id), not once per background query', () => {
    // `pickProviderAppropriateMiniModel` runs on every queryLlm — session
    // titles, summaries — so an undeduped line is noise, and noise is how a
    // real signal gets filtered out of a log.
    __resetMissingPinWarningsForTest();
    const registry = createMockRegistry({
      'openai-codex': [{ id: 'gpt-6-luna', name: 'GPT 6 Luna' }],
    });
    const first = captureStderr(() =>
      pickProviderAppropriateMiniModel('openai-codex', registry, false));
    const second = captureStderr(() =>
      pickProviderAppropriateMiniModel('openai-codex', registry, false));

    expect(first.written).toContain('gpt-5.6-luna');
    expect(second.written).toBe('');
  });

  it('CONTROL: says nothing when every pin ahead of the winner resolves', () => {
    // Without this the warning could fire on every walk and both tests above
    // would still pass. The shipped catalog is the right registry here: TODAY
    // both codex pins exist, so the correct output is silence.
    __resetMissingPinWarningsForTest();
    const { result, written } = captureStderr(() =>
      pickProviderAppropriateMiniModel('openai-codex', shippedCatalogRegistry(), false));
    expect(result).toBe('gpt-5.6-luna');
    expect(written).toBe('');
  });

  it('CONTROL: a DENIED candidate is not reported as a missing pin', () => {
    // The two silences are different things and only one of them was a bug.
    // `isDeniedMiniModelId` is a deliberate exclusion — the ChatGPT backend
    // refuses *codex-mini* ids outright — so reporting it as "retired upstream"
    // would be a false alarm on every single background query.
    __resetMissingPinWarningsForTest();
    const registry = createMockRegistry({
      'openai-codex': [
        { id: 'gpt-5.1-codex-mini', name: 'GPT 5.1 Codex Mini' },
        { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna' },
      ],
    });
    const saved = PI_MINI_PREFERRED_DEFAULTS['openai-codex'];
    PI_MINI_PREFERRED_DEFAULTS['openai-codex'] = ['gpt-5.1-codex-mini', 'gpt-5.6-luna'];
    try {
      const { result, written } = captureStderr(() =>
        pickProviderAppropriateMiniModel('openai-codex', registry, false));
      expect(result).toBe('gpt-5.6-luna');
      expect(written).toBe('');
    } finally {
      PI_MINI_PREFERRED_DEFAULTS['openai-codex'] = saved!;
    }
  });
});
