/**
 * UB4.9 — the first `describe` is copied from craft-agents-oss
 * `v0.15.1:packages/pi-agent-server/src/mini-model-query.test.ts` (Apache-2.0,
 * first shipped v0.13.6). It already carries the row's named arms:
 *  - positive: an ENTITLEMENT rejection of the first candidate ("… is not
 *    supported when using Codex with a ChatGPT account") yields a title from the
 *    next one ("regenerates a title with the session model …");
 *  - negative (control): a not-found is still retried as before the row
 *    ("preserves the cheap OpenAI API-key fallback …", `model_not_found`); an
 *    auth error (`HTTP 401`) and a non-rejection error (`rate limit exceeded`)
 *    are not; and the precision the new classifier adds over
 *    `isModelNotFoundError` — "The 'temperature' parameter is not supported"
 *    names no model and no longer burns candidates.
 *
 * One upstream arm is adapted, not verbatim ("continues past a catalog model
 * …"): it walks OUR `openai-codex` defaults instead of upstream's ids.
 *
 * The second `describe` is ours: the gateway arm (an alias's id resolved at call
 * time, never pinned) and the custom-endpoint route rule this row adds
 * (`isUtilityModelRouteAllowed`, `pickCustomEndpointUtilityModel`). The third
 * (UB12.10) pins the same rule on the MAIN session's model
 * (`resolveRoutedSessionModel`); its wiring is driven in
 * `__tests__/session-model-route-real-server.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { validateTitle } from '../../shared/src/utils/title-generator.ts';
import { PI_PREFERRED_DEFAULTS, resolveGatewayCoderModelId, resolveGatewayFastModelId } from '../../shared/src/config/llm-connections.ts';
import type { ModelDefinition } from '../../shared/src/config/models.ts';
import { isUtilityModelRouteAllowed, pickCustomEndpointUtilityModel, queryMiniModel, resolveRoutedSessionModel } from './mini-model-query.ts';

function registry(providers: Record<string, string[]>): ModelRegistry {
  const models = Object.entries(providers).flatMap(([provider, ids]) =>
    ids.map(id => ({ id, name: id, provider })),
  );
  return {
    find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
    getAll: () => models,
  } as unknown as ModelRegistry;
}

function rejection(model: string): Error {
  return new Error(`Codex error: The '${model.replace(/^pi\//, '')}' model is not supported when using Codex with a ChatGPT account.`);
}

const codexOptions = {
  model: 'pi/gpt-5.4-mini',
  miniModel: 'pi/gpt-5.4-mini',
  sessionModel: 'pi/gpt-5.4',
  authProvider: 'openai-codex',
  modelRegistry: registry({
    'openai-codex': ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5'],
    openai: ['gpt-5-mini'],
    anthropic: ['claude-haiku-4-5'],
  }),
  preferCustomEndpoint: false,
};

describe('queryMiniModel', () => {
  it('regenerates a title with the session model when ChatGPT rejects the configured mini', async () => {
    const tried: string[] = [];
    const result = await queryMiniModel(codexOptions, async model => {
      tried.push(model);
      if (model === 'pi/gpt-5.4-mini') throw rejection(model);
      return 'Fix ChatGPT Title Regeneration';
    });

    expect(tried).toEqual(['pi/gpt-5.4-mini', 'pi/gpt-5.4']);
    expect(result.model).toBe('pi/gpt-5.4');
    expect(validateTitle(result.text)).toBe('Fix ChatGPT Title Regeneration');
  });

  it('keeps a working mini model, including on accounts that support it', async () => {
    const tried: string[] = [];
    const result = await queryMiniModel(codexOptions, async model => {
      tried.push(model);
      return 'A Title';
    });
    expect(tried).toEqual(['pi/gpt-5.4-mini']);
    expect(result).toEqual({ text: 'A Title', model: 'pi/gpt-5.4-mini' });
  });

  it('tries provider catalog alternatives when the session model is also rejected', async () => {
    const tried: string[] = [];
    const result = await queryMiniModel(codexOptions, async model => {
      tried.push(model);
      if (model !== 'gpt-5.5') throw rejection(model);
      return 'Recovered';
    });
    expect(tried).toEqual(['pi/gpt-5.4-mini', 'pi/gpt-5.4', 'gpt-5.5']);
    expect(result.model).toBe('gpt-5.5');
  });

  it('continues past a catalog model that resolves locally but is unavailable to the account', async () => {
    // NESSY: upstream's arm names `gpt-6-astra` and `gpt-5.5`, the head of ITS
    // `openai-codex` defaults; ours keeps the P2.318 list (owner ruling, see its
    // comment in llm-connections.ts), so the arm walks our table's first two.
    const [unavailable, available] = PI_PREFERRED_DEFAULTS['openai-codex'] as [string, string, ...string[]];
    const tried: string[] = [];
    const result = await queryMiniModel({
      ...codexOptions,
      sessionModel: undefined,
      modelRegistry: registry({ 'openai-codex': ['gpt-5.4-mini', unavailable, available] }),
    }, async model => {
      tried.push(model);
      if (model !== available) throw rejection(model);
      return 'Recovered';
    });
    expect(tried).toEqual(['pi/gpt-5.4-mini', unavailable, available]);
    expect(result.model).toBe(available);
  });

  it('never retries the same model through prefixed and bare aliases', async () => {
    const tried: string[] = [];
    const error = rejection('gpt-5.5');
    await expect(queryMiniModel({
      ...codexOptions,
      model: 'pi/gpt-5.5',
      miniModel: 'gpt-5.5',
      sessionModel: 'pi/gpt-5.5',
      modelRegistry: registry({ 'openai-codex': ['gpt-5.5'] }),
    }, async model => {
      tried.push(model);
      throw error;
    })).rejects.toBe(error);
    expect(tried).toEqual(['pi/gpt-5.5']);
  });

  it.each([
    'HTTP 401: Unauthorized',
    'rate limit exceeded',
    'Ephemeral query cancelled',
    "The 'temperature' parameter is not supported",
  ])('does not switch models for unrelated errors: %s', async message => {
    const tried: string[] = [];
    const error = new Error(message);
    await expect(queryMiniModel(codexOptions, async model => {
      tried.push(model);
      throw error;
    })).rejects.toBe(error);
    expect(tried).toEqual(['pi/gpt-5.4-mini']);
  });

  it('does not send OAuth utility requests to OpenAI API-key or Anthropic models', async () => {
    const tried: string[] = [];
    const error = rejection('gpt-5.4-mini');
    await expect(queryMiniModel({
      ...codexOptions,
      sessionModel: 'pi/gpt-5.5',
      modelRegistry: registry({
        'openai-codex': ['gpt-5.4-mini'],
        openai: ['gpt-5-mini', 'gpt-5.5', 'gpt-6-astra'],
        anthropic: ['claude-haiku-4-5'],
      }),
    }, async model => {
      tried.push(model);
      throw error;
    })).rejects.toBe(error);
    expect(tried).toEqual(['pi/gpt-5.4-mini']);
  });

  it('skips known denied Codex mini fallbacks even if they resolve in the registry', async () => {
    const tried: string[] = [];
    const result = await queryMiniModel({
      ...codexOptions,
      sessionModel: 'pi/gpt-5.1-codex-mini',
      modelRegistry: registry({ 'openai-codex': ['gpt-5.4-mini', 'gpt-5.1-codex-mini', 'gpt-5.5'] }),
    }, async model => {
      tried.push(model);
      if (model === 'pi/gpt-5.4-mini') throw rejection(model);
      return 'Recovered';
    });
    expect(tried).toEqual(['pi/gpt-5.4-mini', 'gpt-5.5']);
    expect(result.model).toBe('gpt-5.5');
  });

  it('preserves the cheap OpenAI API-key fallback before trying a larger session model', async () => {
    const tried: string[] = [];
    const result = await queryMiniModel({
      ...codexOptions,
      authProvider: 'openai',
      modelRegistry: registry({ openai: ['gpt-5.4-mini', 'gpt-5-mini', 'gpt-5.4'] }),
    }, async model => {
      tried.push(model);
      if (model === 'pi/gpt-5.4-mini') throw new Error('model_not_found');
      return 'API Title';
    });
    expect(tried).toEqual(['pi/gpt-5.4-mini', 'pi/gpt-5-mini']);
    expect(result.model).toBe('pi/gpt-5-mini');
  });

  it('respects custom-endpoint precedence when resolving fallback candidates', async () => {
    const result = await queryMiniModel({
      ...codexOptions,
      sessionModel: 'private-model',
      modelRegistry: registry({ 'custom-endpoint': ['private-model'] }),
      preferCustomEndpoint: true,
    }, async model => {
      if (model === 'pi/gpt-5.4-mini') throw rejection(model);
      return 'Private Title';
    });
    expect(result.model).toBe('private-model');
  });
});

// ---------------------------------------------------------------------------
// Ours (UB4.9): the gateway and the custom-endpoint route rule.
// ---------------------------------------------------------------------------

/** A gateway catalogue as `fetchNestorModels` stores it: the alias rides `shortName`. */
function gatewayCatalogue(fastId: string, coderId: string): { models: ModelDefinition[] } {
  const row = (id: string, alias: string): ModelDefinition => ({
    id, name: id, shortName: alias, description: '', provider: 'pi', contextWindow: 262_000,
  });
  return { models: [row(fastId, 'fast'), row(coderId, 'coder')] };
}

/**
 * The Nessy Gateway Pi card's shape inside the subprocess: a custom endpoint
 * whose wire protocol is `openai` (so `authProvider` is `'openai'`), with the
 * built-in `openai` catalogue still registered beside it — exactly the ids the
 * 2026-10-16 measurement found resolving to `https://api.openai.com/v1`.
 */
function gatewayRegistry(endpointIds: string[]): ModelRegistry {
  return registry({
    'custom-endpoint': endpointIds,
    openai: ['gpt-5-mini', 'gpt-5.5', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'o4-mini', 'o3', 'gpt-4o', 'gpt-6-luna'],
  });
}

const notFound = (model: string) => new Error(`404 The model \`${model}\` does not exist`);

describe('UB4.9 (Nessy) — gateway ids and the custom-endpoint route rule', () => {
  it('positive — a gateway candidate is the alias\'s id resolved at call time, never a pinned one', async () => {
    // The gateway rotated the ids behind both aliases (it has, twice): whatever
    // the catalogue says NOW is what the loop tries.
    for (const [fastId, coderId] of [['tgpt/fast-a', 'tgpt/coder-a'], ['tgpt/fast-b', 'tgpt/coder-b']] as const) {
      const catalogue = gatewayCatalogue(fastId, coderId);
      const miniModel = resolveGatewayFastModelId(catalogue);
      const sessionModel = resolveGatewayCoderModelId(catalogue);
      expect([miniModel, sessionModel]).toEqual([fastId, coderId]);

      const tried: string[] = [];
      const result = await queryMiniModel({
        model: miniModel!,
        miniModel,
        sessionModel,
        authProvider: 'openai',
        modelRegistry: gatewayRegistry([fastId, coderId]),
        preferCustomEndpoint: true,
      }, async model => {
        tried.push(model);
        if (model === fastId) throw notFound(model);
        return 'Gateway Title';
      });
      expect(tried).toEqual([fastId, coderId]);
      expect(result.model).toBe(coderId);
    }
  });

  it('negative — on a custom endpoint the loop never falls to a public-API candidate, even when it resolves', async () => {
    // Both endpoint models rejected: upstream's rule would go on to `pi/gpt-5-mini`
    // and `gpt-5.5` (provider `openai` = authProvider); ours throws the original error.
    const tried: string[] = [];
    const error = notFound('tgpt/coder-a');
    await expect(queryMiniModel({
      model: 'tgpt/fast-a',
      miniModel: 'tgpt/fast-a',
      sessionModel: 'tgpt/coder-a',
      authProvider: 'openai',
      modelRegistry: gatewayRegistry(['tgpt/fast-a', 'tgpt/coder-a']),
      preferCustomEndpoint: true,
    }, async model => {
      tried.push(model);
      throw model === 'tgpt/coder-a' ? error : notFound(model);
    })).rejects.toBe(error);
    expect(tried).toEqual(['tgpt/fast-a', 'tgpt/coder-a']);
  });

  it('control — the same registry on a plain OpenAI key connection keeps upstream\'s fallback', async () => {
    // The rule is scoped to custom endpoints: with preferCustomEndpoint false the
    // built-in `openai` model IS the connection, and `pi/gpt-5-mini` is still tried.
    const tried: string[] = [];
    const result = await queryMiniModel({
      model: 'gpt-5.5',
      authProvider: 'openai',
      modelRegistry: gatewayRegistry([]),
      preferCustomEndpoint: false,
    }, async model => {
      tried.push(model);
      if (model === 'gpt-5.5') throw notFound(model);
      return 'OpenAI Title';
    });
    expect(tried).toEqual(['gpt-5.5', 'pi/gpt-5-mini']);
    expect(result.model).toBe('pi/gpt-5-mini');
  });

  it('isUtilityModelRouteAllowed — custom endpoint: its own models only; otherwise upstream\'s provider rule', () => {
    expect(isUtilityModelRouteAllowed('custom-endpoint', 'openai', true)).toBe(true);
    expect(isUtilityModelRouteAllowed('openai', 'openai', true)).toBe(false);
    expect(isUtilityModelRouteAllowed('anthropic', undefined, true)).toBe(false);
    expect(isUtilityModelRouteAllowed(undefined, 'openai', true)).toBe(false);
    expect(isUtilityModelRouteAllowed('openai', 'openai', false)).toBe(true);
    expect(isUtilityModelRouteAllowed('custom-endpoint', 'openai', false)).toBe(true);
    expect(isUtilityModelRouteAllowed('anthropic', 'openai', false)).toBe(false);
    expect(isUtilityModelRouteAllowed('anthropic', undefined, false)).toBe(true);
  });

  it('pickCustomEndpointUtilityModel — the first candidate the endpoint serves, or nothing', () => {
    const reg = gatewayRegistry(['tgpt/fast-b', 'tgpt/coder-b']);
    // The host-resolved mini model first.
    expect(pickCustomEndpointUtilityModel(['tgpt/fast-b', 'tgpt/coder-b'], reg, 'openai')).toBe('tgpt/fast-b');
    // A mini id the endpoint no longer serves (rotated while the subprocess lived) → the session's model.
    expect(pickCustomEndpointUtilityModel(['tgpt/fast-a', 'tgpt/coder-b'], reg, 'openai')).toBe('tgpt/coder-b');
    // Ids that resolve only to the public API (or not at all) are never picked.
    expect(pickCustomEndpointUtilityModel(['gpt-5-mini', 'claude-haiku-5-5', undefined], reg, 'openai')).toBeUndefined();
  });
});

/**
 * UB12.10 (Nessy) — the MAIN session's model under the same route rule. A
 * registry whose `custom-endpoint` provider grows when the caller registers an
 * id, as `registerCustomEndpointModels` makes it grow in `index.ts`.
 */
function growingRegistry(providers: Record<string, string[]>): { reg: ModelRegistry; registered: string[]; register: (id: string) => void } {
  const models = Object.entries(providers).flatMap(([provider, ids]) => ids.map(id => ({ id, name: id, provider })));
  const registered: string[] = [];
  return {
    reg: {
      find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
      getAll: () => models,
    } as unknown as ModelRegistry,
    registered,
    register: id => {
      registered.push(id);
      models.push({ id, name: id, provider: 'custom-endpoint' });
    },
  };
}

describe('UB12.10 (Nessy) — resolveRoutedSessionModel: the session model on a custom endpoint stays on the endpoint', () => {
  it('positive — on the gateway card\'s shape a public-catalogue id is registered on the endpoint, never resolved to openai', () => {
    // The gateway Pi card: wire protocol `openai`, so `resolvePiModel` alone returns the
    // built-in `openai` model for `gpt-5.5` (what set_model / init / update_runtime_config used).
    const { reg, registered, register } = growingRegistry({ openai: ['gpt-5.5', 'gpt-5-mini'], 'custom-endpoint': ['tgpt/coder-a'] });
    const model = resolveRoutedSessionModel(reg, 'gpt-5.5', 'openai', true, register);
    expect({ provider: model?.provider, id: model?.id }).toEqual({ provider: 'custom-endpoint', id: 'gpt-5.5' });
    // A `pi/`-prefixed id is registered bare, the id the endpoint is asked for.
    const prefixed = resolveRoutedSessionModel(reg, 'pi/gpt-5-mini', 'openai', true, register);
    expect({ provider: prefixed?.provider, id: prefixed?.id }).toEqual({ provider: 'custom-endpoint', id: 'gpt-5-mini' });
    expect(registered).toEqual(['gpt-5.5', 'gpt-5-mini']);
  });

  it('boundary — the endpoint\'s own model resolves as before, with nothing registered', () => {
    const { reg, registered, register } = growingRegistry({ openai: ['gpt-5.5'], 'custom-endpoint': ['tgpt/coder-a'] });
    expect(resolveRoutedSessionModel(reg, 'tgpt/coder-a', 'openai', true, register)?.provider).toBe('custom-endpoint');
    expect(registered).toEqual([]);
  });

  it('fail closed — a registration that does not land on the endpoint yields nothing, never the public model', () => {
    const { reg } = growingRegistry({ anthropic: ['claude-haiku-4-5'], 'custom-endpoint': ['tgpt/coder-a'] });
    expect(resolveRoutedSessionModel(reg, 'claude-haiku-4-5', 'anthropic', true, () => {})).toBeUndefined();
  });

  it('negative (control) — a plain OpenAI key connection is unchanged: the built-in model, nothing registered', () => {
    const { reg, registered, register } = growingRegistry({ openai: ['gpt-5.5'] });
    const model = resolveRoutedSessionModel(reg, 'gpt-5.5', 'openai', false, register);
    expect({ provider: model?.provider, id: model?.id }).toEqual({ provider: 'openai', id: 'gpt-5.5' });
    // An id nothing resolves stays unresolved off a custom endpoint (the callers' "could not resolve").
    expect(resolveRoutedSessionModel(reg, 'no-such-model', 'openai', false, register)).toBeUndefined();
    expect(registered).toEqual([]);
  });
});
