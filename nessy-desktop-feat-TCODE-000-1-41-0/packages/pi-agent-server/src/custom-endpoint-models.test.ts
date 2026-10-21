import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildCustomEndpointModelDef,
  customEndpointModelOverrides,
  FALLBACK_CONTEXT_WINDOW,
  normalizeCustomEndpointModelEntry,
  stripPiPrefix,
} from './custom-endpoint-models.ts'
import { NESTOR_GATEWAY_MODEL_WINDOWS } from '../../shared/src/auth/nestor.ts'
import { NESSY_GATEWAY_CHAT_BASE_URL } from '../../shared/src/agent/backend/internal/drivers/upstream-target.ts'
import { MODULE_GRAPH_BUDGET_MS, MODULE_GRAPH_HOOK_BUDGET_MS } from '../../shared/src/testing/module-graph-budgets.ts'

/**
 * The gateway URL is IMPORTED, never spelled out: the whole point of P2.392 is
 * that this file and `isNessyGatewayBaseUrl` cannot disagree about which URL is
 * the gateway, and a hand-typed copy here would be a third one.
 */
const GATEWAY = NESSY_GATEWAY_CHAT_BASE_URL
/**
 * A BYO endpoint. `.invalid` is reserved (RFC 2606) so nothing here can resolve;
 * the path deliberately mimics the gateway's tail so the assertion is about the
 * WHOLE-URL match rather than about a suffix.
 */
const BYO = 'https://byo.example.invalid/api/v1/cli/openai-like/v1'
/** F1.1263 — the compat a BYO (non-gateway, non-api.openai.com) openai-completions model carries. */
const BYO_COMPAT = { supportsStore: false, maxTokensField: 'max_tokens', supportsUsageInStreaming: false }

describe('normalizeCustomEndpointModelEntry', () => {
  it('strips pi/ prefixes from string model IDs', () => {
    expect(stripPiPrefix('pi/my-model')).toBe('my-model')
    expect(normalizeCustomEndpointModelEntry('pi/my-model')).toEqual({ id: 'my-model' })
  })

  it('preserves per-model image support when enabled', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/vision-model',
      supportsImages: true,
    })).toEqual({
      id: 'vision-model',
      supportsImages: true,
    })
  })

  it('preserves explicit per-model image support when disabled', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/text-only-model',
      supportsImages: false,
    })).toEqual({
      id: 'text-only-model',
      supportsImages: false,
    })
  })

  it('preserves context window and image support together', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/vision-model',
      contextWindow: 262_144,
      supportsImages: true,
    })).toEqual({
      id: 'vision-model',
      contextWindow: 262_144,
      supportsImages: true,
    })
  })
})

describe('P6.367 — the operator can declare that a custom-endpoint id reasons', () => {
  it('carries the declaration through the normalizer', () => {
    expect(normalizeCustomEndpointModelEntry({ id: 'pi/tgpt/qwen35', supportsThinking: true }))
      .toEqual({ id: 'tgpt/qwen35', supportsThinking: true })
    // The explicit negative is preserved too — it is a declaration, not an
    // absence, and it must survive the same way `supportsImages: false` does.
    expect(normalizeCustomEndpointModelEntry({ id: 'tgpt/qwen35', supportsThinking: false }))
      .toEqual({ id: 'tgpt/qwen35', supportsThinking: false })
  })

  it('sends `reasoning: true` for a declared model — the effort the runtime was refusing', () => {
    expect(buildCustomEndpointModelDef('tgpt/qwen35', BYO, undefined, { supportsThinking: true })
      .def.reasoning).toBe(true)
  })

  it('leaves an UNDECLARED model exactly as it was, and honours an explicit `false`', () => {
    // The boundary this row must not cross: `ModelDefinition.supportsThinking`
    // documents "defaults to true when undefined", and this default is
    // deliberately the opposite — an undeclared id must not start sending an
    // effort parameter a plain OpenAI-compatible endpoint never asked for.
    expect(buildCustomEndpointModelDef('tgpt/qwen35', BYO).def.reasoning).toBe(false)
    expect(buildCustomEndpointModelDef('tgpt/qwen35', BYO, undefined, {}).def.reasoning).toBe(false)
    expect(buildCustomEndpointModelDef('tgpt/qwen35', BYO, undefined, { supportsThinking: false })
      .def.reasoning).toBe(false)
    // Control: the declaration must not disturb the other two overrides.
    const def = buildCustomEndpointModelDef('tgpt/qwen35', BYO, undefined, {
      supportsThinking: true, supportsImages: true, contextWindow: 40_960,
    }).def
    expect(def.contextWindow).toBe(40_960)
    expect(def.input).toEqual(['text', 'image'])
  })
})

describe('buildCustomEndpointModelDef', () => {
  it('defaults custom endpoint models to text-only input', () => {
    const { def } = buildCustomEndpointModelDef('my-model', BYO)
    expect(def.input).toEqual(['text'])
  })

  it('enables image input when the connection explicitly opts in', () => {
    const { def } = buildCustomEndpointModelDef('vision-model', BYO, { supportsImages: true })
    expect(def.input).toEqual(['text', 'image'])
  })

  it('lets per-model overrides disable image input even when the connection default is enabled', () => {
    const { def } = buildCustomEndpointModelDef('text-only-model', BYO, { supportsImages: true }, { supportsImages: false })
    expect(def.input).toEqual(['text'])
  })

  it('lets per-model overrides enable image input and custom context window', () => {
    const { def } = buildCustomEndpointModelDef('vision-model', BYO, undefined, { supportsImages: true, contextWindow: 262_144 })
    expect(def.input).toEqual(['text', 'image'])
    expect(def.contextWindow).toBe(262_144)
  })

  it('reports the fabricated window as a fallback, and a known one as not', () => {
    // The whole point of the second return value: once the number is inside a
    // model definition, a fabricated 128 000 and a real one are identical.
    const guessed = buildCustomEndpointModelDef('unknown-model', BYO)
    expect(guessed.def.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW)
    expect(guessed.windowIsFallback).toBe(true)

    const known = buildCustomEndpointModelDef('sized-model', BYO, undefined, { contextWindow: 40_960 })
    expect(known.windowIsFallback).toBe(false)

    // A model whose REAL window happens to equal the fallback is still not a
    // fallback — the flag tracks provenance, not the value.
    const coincidence = buildCustomEndpointModelDef('big-model', BYO, undefined, { contextWindow: FALLBACK_CONTEXT_WINDOW })
    expect(coincidence.windowIsFallback).toBe(false)
  })

  it('takes the fallback from the runtime that consumes it, not from a number typed here', () => {
    // P3.79. `@earendil-works/pi-coding-agent@0.84.0`,
    // `core/provider-composer.js:72` — the function that turns a definition like
    // ours into a Pi model — reads `definition.contextWindow ?? 128000`, and the
    // same 128000 appears again in that package's branch summarization, in
    // pi-agent-core's copy of it, and in the llama extension. So 128 000 is what
    // applies when we pass nothing, and the hand-typed 131 072 that used to sit
    // here was 1 072 tokens ABOVE it — over-stating, which is the direction that
    // runs a session past the real limit before anything compacts.
    expect(FALLBACK_CONTEXT_WINDOW).toBe(128_000)
  })

  it('prefers a measured gateway window over the fabrication', () => {
    // The parity half: `claude-agent.ts` already recovers the real window for a
    // gateway id whose stored catalogue entry lost it. The Pi session beside it
    // stamped the fabrication instead.
    const measured = NESTOR_GATEWAY_MODEL_WINDOWS['tgpt/qwen35-397b-a17b-fp8']
    expect(measured).toBeGreaterThan(0)

    const gateway = buildCustomEndpointModelDef('tgpt/qwen35-397b-a17b-fp8', GATEWAY)
    expect(gateway.def.contextWindow).toBe(measured!)
    // And it is NOT reported as a fallback: somebody measured this one.
    expect(gateway.windowIsFallback).toBe(false)

    // Coverage rather than two hand-written ids: a third gateway model added to
    // the table must reach this path too.
    for (const [id, window] of Object.entries(NESTOR_GATEWAY_MODEL_WINDOWS)) {
      const built = buildCustomEndpointModelDef(id, GATEWAY)
      expect(built.def.contextWindow, `no measured window reached the def for ${id}`).toBe(window)
      expect(built.windowIsFallback).toBe(false)
    }
  })

  it('still lets a stored window override the table', () => {
    // The table is the fallback, never an override: a user (or a live refresh)
    // owns the number when there is one.
    const stored = buildCustomEndpointModelDef('tgpt/qwen35-397b-a17b-fp8', GATEWAY, undefined, { contextWindow: 40_960 })
    expect(stored.def.contextWindow).toBe(40_960)
    expect(stored.windowIsFallback).toBe(false)
  })

  it('refuses the measured table to a BYO endpoint serving a gateway id (P2.392)', () => {
    // The defect this row closes: the tier used to match on the ID ALONE, so a
    // BYO endpoint serving an id spelled exactly like an internal gateway one
    // inherited the gateway's window. The cost is an OVER-stated window, the
    // direction that runs a session past the real limit before anything
    // compacts, on the runtime we ship by default.
    const id = 'tgpt/qwen35-397b-a17b-fp8'
    const measured = NESTOR_GATEWAY_MODEL_WINDOWS[id]
    // The positive control for the negative claim below, on the same rig: the
    // table DOES cover this id, so a fallback verdict is the gate acting and
    // not an id the table never had.
    expect(measured).toBeGreaterThan(0)
    expect(measured).not.toBe(FALLBACK_CONTEXT_WINDOW)

    const byo = buildCustomEndpointModelDef(id, BYO)
    expect(byo.def.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW)
    expect(byo.windowIsFallback).toBe(true)

    // Every id in the table, not two hand-written ones — a third gateway model
    // added later must be refused here too.
    for (const gatewayId of Object.keys(NESTOR_GATEWAY_MODEL_WINDOWS)) {
      const built = buildCustomEndpointModelDef(gatewayId, BYO)
      expect(built.def.contextWindow, `BYO endpoint inherited the gateway window for ${gatewayId}`)
        .toBe(FALLBACK_CONTEXT_WINDOW)
      expect(built.windowIsFallback).toBe(true)
    }
  })

  it('treats a missing base URL as not the gateway, and a same-host different path too', () => {
    const id = 'tgpt/qwen35-397b-a17b-fp8'
    // Absent: a caller that cannot say which endpoint this is gets the honest
    // fabrication rather than the gateway's number.
    expect(buildCustomEndpointModelDef(id, undefined).windowIsFallback).toBe(true)
    expect(buildCustomEndpointModelDef(id, '').windowIsFallback).toBe(true)
    // Same host, different path — the case the whole-URL match exists for
    // (AGENTS.md "Gateway Facts": custom endpoints keep normal provider auth
    // semantics even on the gateway host).
    const sameHost = `${GATEWAY.replace(/\/openai-like\/v1$/, '')}/other/v1`
    expect(sameHost).not.toBe(GATEWAY)
    expect(buildCustomEndpointModelDef(id, sameHost).windowIsFallback).toBe(true)
    // And a trailing slash on the real gateway is still the gateway: the
    // matcher normalizes, so the gate cannot be defeated by a formatting
    // difference in stored config.
    expect(buildCustomEndpointModelDef(id, `${GATEWAY}/`).windowIsFallback).toBe(false)
  })

  it('lets a stored window through on a BYO endpoint — the gate narrows one tier only', () => {
    // The gate must not cost the caller its OWN number: tier one is the stored
    // window and it is endpoint-independent.
    const stored = buildCustomEndpointModelDef('tgpt/qwen35-397b-a17b-fp8', BYO, undefined, { contextWindow: 40_960 })
    expect(stored.def.contextWindow).toBe(40_960)
    expect(stored.windowIsFallback).toBe(false)
  })
})

/**
 * DA1.22 — the gateway publishes `sampling_params` per `/cli/models` row and Pi
 * has a field of exactly that shape, so the host carries the object across and
 * invents nothing. Fixture values are WA-e's live reading of 2026-09-13.
 */
describe('DA1.22 — the catalogue\'s sampling params reach Pi\'s own field', () => {
  it('carries the object through the normalizer, top_k and all', () => {
    expect(normalizeCustomEndpointModelEntry({
      id: 'pi/tgpt/qwen36-35b-a3b-fp8',
      samplingParams: { temperature: 0.7, top_k: 20, top_p: 0.8 },
    })).toEqual({
      id: 'tgpt/qwen36-35b-a3b-fp8',
      samplingParams: { temperature: 0.7, top_k: 20, top_p: 0.8 },
    })
  })

  it('puts it on the model definition pi-ai reads', () => {
    const { def } = buildCustomEndpointModelDef('tgpt/deepseek-v4-flash-0731', GATEWAY, undefined, {
      samplingParams: { temperature: 1, top_p: 0.95 },
    })
    expect(def.samplingParams).toEqual({ temperature: 1, top_p: 0.95 })
  })

  /**
   * The control, and it is what keeps every pre-DA1.22 model on its old path: a
   * definition with NO key at all, not an empty object. pi-ai merges
   * `Model.samplingParams` into the body, so an empty object and an absent field
   * behave the same today — and a future key with a default would not.
   */
  it('omits the field entirely when the row published none', () => {
    expect('samplingParams' in buildCustomEndpointModelDef('tgpt/plain', GATEWAY).def).toBe(false)
    expect('samplingParams' in buildCustomEndpointModelDef('tgpt/plain', GATEWAY, undefined, {}).def).toBe(false)
    // Positive control on the same call shape: the overrides argument IS read.
    expect(buildCustomEndpointModelDef('tgpt/plain', GATEWAY, undefined, { contextWindow: 40_960 })
      .def.contextWindow).toBe(40_960)
  })
})

/**
 * DA1.22 (residue fixed in place) — the projection `registerCustomEndpointModels`
 * uses to reach `buildCustomEndpointModelDef`.
 *
 * It was an inline whitelist naming `contextWindow` and `supportsImages` only,
 * and it DROPPED `supportsThinking` — the field P6.367 had threaded through four
 * type copies, both host mappers and the normalizer — so every custom-endpoint
 * model reached pi-ai with `reasoning: false` whatever the operator declared.
 * The cases above it could not see that, because they drive
 * `buildCustomEndpointModelDef` directly with an overrides object: a stub of
 * exactly the seam that was broken.
 */
describe('customEndpointModelOverrides (DA1.22)', () => {
  it('carries EVERY declared capability, not a list of names', () => {
    expect(customEndpointModelOverrides({
      id: 'tgpt/qwen35',
      contextWindow: 40_960,
      supportsImages: true,
      supportsThinking: true,
      samplingParams: { temperature: 1 },
    })).toEqual({
      contextWindow: 40_960,
      supportsImages: true,
      supportsThinking: true,
      samplingParams: { temperature: 1 },
    })
  })

  /** The regression that was live: a lone `supportsThinking` must survive. */
  it('carries a lone supportsThinking — the field the old whitelist dropped', () => {
    expect(customEndpointModelOverrides({ id: 'tgpt/qwen35', supportsThinking: true }))
      .toEqual({ supportsThinking: true })
    expect(customEndpointModelOverrides({ id: 'tgpt/qwen35', supportsThinking: false }))
      .toEqual({ supportsThinking: false })
  })

  it('is undefined for a bare id, so the caller stores nothing', () => {
    expect(customEndpointModelOverrides({ id: 'tgpt/qwen35' })).toBeUndefined()
  })
})

/**
 * F1.243 — an openai-completions custom-endpoint model declares
 * `compat.supportsStore: false`, so pi-ai stops sending `store: false`.
 *
 * pi-ai 0.84.4 `api/openai-completions.js`: `detectCompat` answers
 * `supportsStore: !isNonStandard` — true for every host off its fixed list —
 * and the request builder then writes `params.store = false`; `getCompat` lets
 * `model.compat.supportsStore` override the detection. The host declared no
 * `compat` at all, so every BYO openai-completions endpoint and the gateway
 * (through the loopback reasoning proxy, which passes `store` through) received
 * the field, and a strict OpenAI-compatible provider answers an unknown param
 * with a 400 (upstream craft-agents-oss#1022, fixed in v0.13.4 the same way).
 *
 * The third arm is the NATIVE measurement: pi-ai's own openai-completions
 * `stream`, stopped in its `onPayload` hook before any network, reports the
 * request body it would send. Its control — the same model without the compat
 * block — proves the instrument sees `store` on this host at all, so the
 * behaviour is pinned by pi-ai's OWN detection rather than by our reading of
 * it, and a Pi lift that changes the detection turns this arm red.
 */
describe('buildCustomEndpointModelDef compat (F1.243)', () => {
  // pi-ai's completions module drags in its OpenAI client: 4.66 s alone, and past
  // bun's 5 s default inside a three-file batch (2026-09-23) — a module-graph cost,
  // so the import is paid once, here, under the repo's hook budget.
  let stream: typeof import('@earendil-works/pi-ai/api/openai-completions').stream
  beforeAll(async () => {
    ({ stream } = await import('@earendil-works/pi-ai/api/openai-completions'))
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  it('an openai-completions def declares supportsStore false (and, on a BYO host, F1.1263\'s two strict-endpoint fields)', () => {
    const { def } = buildCustomEndpointModelDef('byo-model', BYO, undefined, undefined, 'openai-completions')
    expect((def as { compat?: unknown }).compat).toEqual(BYO_COMPAT)
    // F1.1263 control: the verified gateway keeps the one F1.243 field only.
    const gw = buildCustomEndpointModelDef('byo-model', GATEWAY, undefined, undefined, 'openai-completions').def
    expect((gw as { compat?: unknown }).compat).toEqual({ supportsStore: false })
  })

  it('an anthropic-messages def, and a def built with no api, declare no compat', () => {
    expect('compat' in buildCustomEndpointModelDef('byo-model', BYO, undefined, undefined, 'anthropic-messages').def)
      .toBe(false)
    expect('compat' in buildCustomEndpointModelDef('byo-model', BYO).def).toBe(false)
  })

  it('pi-ai\'s own request builder omits store for our def, and sends it without the compat block', async () => {
    const payloadFor = async (def: object): Promise<Record<string, unknown>> => {
      let captured: Record<string, unknown> | undefined
      const model = { ...def, api: 'openai-completions', provider: 'custom-endpoint', baseUrl: BYO }
      const events = stream(model as never, { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] } as never, {
        apiKey: 'test-key',
        onPayload: (params: unknown) => {
          captured = params as Record<string, unknown>
          throw new Error('payload captured; no request is sent')
        },
      } as never)
      await events.result()
      if (!captured) throw new Error('onPayload never ran')
      return captured
    }
    const { def } = buildCustomEndpointModelDef('byo-model', BYO, undefined, undefined, 'openai-completions')
    expect('store' in await payloadFor(def)).toBe(false)
    // Control: the SAME model without the compat block gets `store: false` from pi-ai's detection.
    const { compat: _compat, ...bare } = def as { compat?: unknown }
    expect((await payloadFor(bare)).store).toBe(false)
  })

  it('F1.328 — the same rule reaches api.openai.com: no store sent, where pi-ai alone would send false', async () => {
    // The decided trade (the builder's docblock): OpenAI's schema defaults `store` to false,
    // so omitting pi-ai's explicit opt-out there changes nothing — and this arm is what turns
    // red if a Pi lift starts treating the platform host differently from a BYO one.
    const OPENAI = 'https://api.openai.com/v1'
    const payloadAt = async (def: object): Promise<Record<string, unknown>> => {
      let captured: Record<string, unknown> | undefined
      const model = { ...def, api: 'openai-completions', provider: 'custom-endpoint', baseUrl: OPENAI }
      const events = stream(model as never, { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] } as never, {
        apiKey: 'test-key',
        onPayload: (params: unknown) => {
          captured = params as Record<string, unknown>
          throw new Error('payload captured; no request is sent')
        },
      } as never)
      await events.result()
      if (!captured) throw new Error('onPayload never ran')
      return captured
    }
    const { def } = buildCustomEndpointModelDef('gpt-test', OPENAI, undefined, undefined, 'openai-completions')
    expect('store' in await payloadAt(def)).toBe(false)
    // Control on the same host: without the compat block pi-ai sends OpenAI's own opt-out.
    const { compat: _compat, ...bare } = def as { compat?: unknown }
    expect((await payloadAt(bare)).store).toBe(false)
  })
})

/**
 * F1.243 — the one production caller passes `api`. `registerCustomEndpointModels`
 * lives in `index.ts`, which a test cannot import (it starts the JSONL server), so
 * the call is pinned by source: without this arm the three above would be equally
 * green with the builder never told which API it is building for.
 */
describe('registerCustomEndpointModels passes api to the builder (F1.243)', () => {
  it('the buildCustomEndpointModelDef call in index.ts carries the provider api', () => {
    const src = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')
    const start = src.indexOf('const built = allIds.map(id => buildCustomEndpointModelDef(')
    expect(start).toBeGreaterThan(-1)
    const call = src.slice(start, src.indexOf('));', start) + 3)
    expect(call).toContain('state.modelOverrides.get(id), api,')
    // Boundary control: the slice stops at the call — the registration below it is not inside.
    expect(call).not.toContain('registry.registerProvider(')
  })
})

/**
 * F1.327 — the F1.243 arms above hand pi-ai's `stream` a model object this file
 * spread by hand. Production does not: `registerCustomEndpointModels` hands the
 * defs to `modelRegistry.registerProvider('custom-endpoint', …)`, the registry
 * copies each model into its own record (pi-coding-agent's `applyExtension`
 * path, the one `sdk.js` uses), and the request is built from THAT record by
 * `modelRuntime.streamSimple`. A Pi lift whose registry copied model fields by
 * name and forgot `compat` would drop the fix while every arm above stayed
 * green. So this arm drives the production composition end to end —
 * `createPiRuntimeAdapter().createRegistry()` → `registerProvider` with the
 * option shape `index.ts` passes → `find` → `streamSimple` — and stops in
 * `onPayload` before any network, like its siblings.
 *
 * CONTROL: the same registration with the compat block stripped, so the
 * instrument is shown to see `store` through this path at all.
 */
describe('F1.327 · the compat arm through the production registry composition', () => {
  let createPiRuntimeAdapter: typeof import('./compat/pi-runtime-adapter.ts').createPiRuntimeAdapter
  beforeAll(async () => {
    ({ createPiRuntimeAdapter } = await import('./compat/pi-runtime-adapter.ts'))
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  const payloadThroughRegistry = async (
    stripCompat: boolean,
  ): Promise<{ registeredCompat: unknown; payload: Record<string, unknown> }> => {
    const { modelRuntime, modelRegistry } = await createPiRuntimeAdapter().createRegistry()
    const { def } = buildCustomEndpointModelDef('probe-model', BYO, undefined, undefined, 'openai-completions')
    const { compat: _compat, ...bare } = def as { compat?: unknown }
    const registry = modelRegistry as unknown as {
      registerProvider(name: string, options: Record<string, unknown>): void
      find(provider: string, id: string): { compat?: unknown } | undefined
    }
    registry.registerProvider('custom-endpoint', {
      baseUrl: BYO, apiKey: 'test-key', api: 'openai-completions', authHeader: true,
      models: [stripCompat ? bare : def],
    })
    const model = registry.find('custom-endpoint', 'probe-model')
    expect(model, 'the registry did not keep the registered model').toBeDefined()
    let captured: Record<string, unknown> | undefined
    const events = (modelRuntime as unknown as {
      streamSimple(model: unknown, context: unknown, options: unknown): { result(): Promise<unknown> }
    }).streamSimple(model, { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }, {
      onPayload: (params: unknown) => {
        captured = params as Record<string, unknown>
        throw new Error('payload captured; no request is sent')
      },
    })
    await events.result()
    if (!captured) throw new Error('onPayload never ran')
    return { registeredCompat: model?.compat, payload: captured }
  }

  // Each case streams through pi-ai, whose lazy API module (`openai-completions.lazy.js`)
  // is imported there, so a case takes the budget for an import paid in the cases,
  // not the hook's (F1.668).
  it('the registry keeps compat, and the request it builds carries no store', async () => {
    const { registeredCompat, payload } = await payloadThroughRegistry(false)
    expect(registeredCompat).toEqual(BYO_COMPAT)
    expect('store' in payload).toBe(false)
    // The request really was built — the fields every openai-completions body carries.
    expect(payload.model).toBe('probe-model')
    expect(Array.isArray(payload.messages)).toBe(true)
  }, MODULE_GRAPH_BUDGET_MS)

  it('CONTROL — the same registration without compat sends pi-ai\'s store:false', async () => {
    const { registeredCompat, payload } = await payloadThroughRegistry(true)
    expect(registeredCompat).toBeUndefined()
    expect(payload.store).toBe(false)
  }, MODULE_GRAPH_BUDGET_MS)
})

/**
 * F1.329 — which OTHER OpenAI-platform fields pi-ai's detection still sends to
 * a custom endpoint, re-read on the lifted Pi 0.85.1 (F1.255, 2026-09-24)
 * through the same production composition as F1.327's arm. `openai-completions.js`
 * changed at 0.85.1 only by an opt-in `compat.vllmPriority`, and the request
 * body is the one WJ-ee read at 0.84.4, key for key:
 *
 *  - every model: `max_completion_tokens`, `stream_options: { include_usage }`,
 *    `prompt_cache_key`, `prompt_cache_retention` (the last two were not in the
 *    row's list), and the system prompt as role `system`;
 *  - a reasoning model (`supportsThinking`, the gateway `coder` row's flag):
 *    `reasoning_effort` too, and the system prompt as role `developer`.
 *
 * Pinned exactly, so a Pi lift that adds or drops a field reddens here. What is
 * NOT settled — and stays the row's owed measurement — is which of them a real
 * strict endpoint (the gateway, a BYO proxy) refuses: that needs a live
 * endpoint, and only a field MEASURED red earns its compat sibling beside
 * `supportsStore: false`.
 */
describe('F1.329 · the OpenAI-platform fields a custom-endpoint request carries, through the production registry', () => {
  let createPiRuntimeAdapter: typeof import('./compat/pi-runtime-adapter.ts').createPiRuntimeAdapter
  beforeAll(async () => {
    ({ createPiRuntimeAdapter } = await import('./compat/pi-runtime-adapter.ts'))
  }, MODULE_GRAPH_HOOK_BUDGET_MS)

  const requestBody = async (reasoning: boolean, baseUrl: string = BYO): Promise<Record<string, unknown>> => {
    const { modelRuntime, modelRegistry } = await createPiRuntimeAdapter().createRegistry()
    const { def } = buildCustomEndpointModelDef(
      'probe-model', baseUrl, undefined, reasoning ? { supportsThinking: true } : undefined, 'openai-completions',
    )
    const registry = modelRegistry as unknown as {
      registerProvider(name: string, options: Record<string, unknown>): void
      find(provider: string, id: string): unknown
    }
    registry.registerProvider('custom-endpoint', {
      baseUrl, apiKey: 'test-key', api: 'openai-completions', authHeader: true, models: [def],
    })
    let captured: Record<string, unknown> | undefined
    const events = (modelRuntime as unknown as {
      streamSimple(model: unknown, context: unknown, options: unknown): { result(): Promise<unknown> }
    }).streamSimple(registry.find('custom-endpoint', 'probe-model'), {
      systemPrompt: 'probe system prompt',
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
    }, {
      ...(reasoning ? { reasoning: 'high' } : {}),
      onPayload: (params: unknown) => {
        captured = params as Record<string, unknown>
        throw new Error('payload captured; no request is sent')
      },
    })
    await events.result()
    if (!captured) throw new Error('onPayload never ran')
    return captured
  }

  // The same lazy pi-ai import is paid in each case, as in F1.327's arm above (F1.668).
  // F1.1263 — a BYO endpoint gets the classic `max_tokens` and no `stream_options`, so a
  // strict OpenAI-compatible endpoint (SIT2-e's strict stub: 400 "Unrecognized request
  // argument supplied: stream_options, max_completion_tokens") accepts the request.
  it('an ordinary BYO model: max_tokens and no stream_options (F1.1263), system prompt as role system', async () => {
    const body = await requestBody(false)
    expect(Object.keys(body).sort()).toEqual([
      'max_tokens', 'messages', 'model', 'prompt_cache_key', 'prompt_cache_retention', 'stream',
    ])
    expect(body.max_tokens).toBe(8_192)
    expect((body.messages as Array<{ role: string }>)[0]?.role).toBe('system')
  }, MODULE_GRAPH_BUDGET_MS)

  it('a reasoning BYO model adds reasoning_effort and sends the system prompt as role developer', async () => {
    const body = await requestBody(true)
    expect(Object.keys(body).sort()).toEqual([
      'max_tokens', 'messages', 'model', 'prompt_cache_key', 'prompt_cache_retention', 'reasoning_effort', 'stream',
    ])
    expect(body.reasoning_effort).toBe('high')
    expect((body.messages as Array<{ role: string }>)[0]?.role).toBe('developer')
  }, MODULE_GRAPH_BUDGET_MS)

  // F1.1263 negative arms: the gateway (measured accepting both fields, SIT2-e, and its
  // usage feeds the meter) and api.openai.com (whose reasoning models refuse `max_tokens`)
  // keep pi-ai's own detection — the platform fields, usage streamed.
  it('the verified gateway and api.openai.com keep max_completion_tokens and streamed usage', async () => {
    for (const baseUrl of [GATEWAY, 'https://api.openai.com/v1']) {
      const body = await requestBody(false, baseUrl)
      expect('max_tokens' in body, baseUrl).toBe(false)
      expect(body.max_completion_tokens, baseUrl).toBe(8_192)
      expect(body.stream_options, baseUrl).toEqual({ include_usage: true })
    }
  }, MODULE_GRAPH_BUDGET_MS)
})
