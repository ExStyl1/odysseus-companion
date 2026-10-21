import { describe, expect, it } from 'bun:test'
import { getMiniModel, type LlmConnection } from '@nessy-agent/shared/config'
import type { FileAttachment } from '@nessy-agent/shared/protocol'
import { buildBackendRuntimeSignature, filterAttachmentsForModelInput } from './runtime-config'

const baseCompat: LlmConnection = {
  slug: 'local',
  name: 'Local',
  providerType: 'pi_compat',
  authType: 'none',
  createdAt: 1,
  baseUrl: 'http://127.0.0.1:1234/v1',
  defaultModel: 'gemma',
  piAuthProvider: 'openai',
  customEndpoint: { api: 'openai-completions', supportsImages: true },
  models: [{ id: 'gemma', supportsImages: true } as never],
}

/**
 * The Nessy Gateway's Claude Code card, as it actually ships: both
 * `NESSY_GATEWAY_MODELS` entries DECLARE `supportsImages: false`, and
 * `fetchNestorModels` spreads the stored override back over the fetched row, so
 * a refresh cannot erase the declaration.
 *
 * The declaration is now what the filter runs on. It used to be an undeclared
 * model plus a `claude-runtime` default of "no", justified by
 * `codex-responses-adapter/src/to-chat.ts:67` keeping only content parts with a
 * string `text` — a symbol and a behaviour that `30628c7d0` replaced
 * (`toChatContent` emits the chat `image_url` part). See `claudeGatewayUndeclared`
 * for the half that changed.
 */
const claudeGateway: LlmConnection = {
  slug: 'claude-gateway',
  name: 'Claude Code (Nessy Gateway)',
  providerType: 'claude-runtime',
  authType: 'api_key',
  createdAt: 1,
  baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
  defaultModel: 'tgpt/qwen35-397b-a17b-fp8',
  models: [{ id: 'tgpt/qwen35-397b-a17b-fp8', supportsImages: false } as never],
}

/** The same card with a model the gateway serves but the catalog never described. */
const claudeGatewayUndeclared: LlmConnection = {
  ...claudeGateway,
  models: [{ id: 'tgpt/qwen35-397b-a17b-fp8' } as never],
}

function sig(connection: LlmConnection) {
  return buildBackendRuntimeSignature({
    connection,
    provider: 'pi',
    authType: 'api_key',
    resolvedModel: 'gemma',
  })
}

const imageAttachment: FileAttachment = {
  type: 'image',
  path: '/tmp/image.png',
  name: 'image.png',
  mimeType: 'image/png',
  size: 123,
  base64: 'abc',
}

const textAttachment: FileAttachment = {
  type: 'text',
  path: '/tmp/note.txt',
  name: 'note.txt',
  mimeType: 'text/plain',
  size: 12,
  text: 'hello',
}

describe('buildBackendRuntimeSignature', () => {
  it('changes when a custom endpoint model image override changes', () => {
    const enabled = sig(baseCompat)
    const disabled = sig({
      ...baseCompat,
      models: [{ id: 'gemma', supportsImages: false } as never],
    })

    expect(disabled).not.toBe(enabled)
  })

  it('ignores non-runtime metadata such as lastUsedAt', () => {
    expect(sig({ ...baseCompat, lastUsedAt: 1 })).toBe(sig({ ...baseCompat, lastUsedAt: 2 }))
  })
})

// C3 (C1 hand-off): the signature used to carry `baseUrl` only for `pi_compat`,
// so editing a codex/claude runtime connection's endpoint mid-session left the
// running agent — and its already-started local adapter — pointed at the old
// upstream until the session restarted. Unreachable before C3 (there was no edit
// form); reachable now, so the two runtime provider types join the arm.
describe('buildBackendRuntimeSignature — adapter-runtime connections', () => {
  const runtimeConnections = {
    'codex-runtime': {
      slug: 'codex-custom',
      name: 'Codex (Custom Endpoint)',
      providerType: 'codex-runtime',
      authType: 'api_key_with_endpoint',
      createdAt: 1,
      baseUrl: 'https://llm-proxy.internal.example.com/v1',
      defaultModel: 'deepseek-v3',
      models: ['deepseek-v3'],
    } satisfies LlmConnection,
    'claude-runtime': {
      slug: 'claude-custom',
      name: 'Claude Code (Custom Endpoint)',
      providerType: 'claude-runtime',
      authType: 'api_key_with_endpoint',
      createdAt: 1,
      baseUrl: 'https://llm-proxy.internal.example.com/v1',
      defaultModel: 'deepseek-v3',
      models: ['deepseek-v3'],
    } satisfies LlmConnection,
  } as const

  function runtimeSig(connection: LlmConnection) {
    return buildBackendRuntimeSignature({
      connection,
      provider: connection.providerType === 'codex-runtime' ? 'codex-runtime' : 'anthropic',
      authType: 'api_key_with_endpoint',
      resolvedModel: 'deepseek-v3',
    })
  }

  for (const [providerType, connection] of Object.entries(runtimeConnections)) {
    it(`drifts when a ${providerType} connection's endpoint changes`, () => {
      const before = runtimeSig(connection)
      const after = runtimeSig({ ...connection, baseUrl: 'https://other-proxy.internal.example.com/v1' })

      expect(after).not.toBe(before)
      expect(before).toContain('llm-proxy.internal.example.com')
    })

    it(`drifts when a ${providerType} connection's model catalog changes`, () => {
      const before = runtimeSig(connection)
      const after = runtimeSig({ ...connection, models: ['deepseek-v3', 'deepseek-r1'] })

      expect(after).not.toBe(before)
    })
  }

  it('leaves provider types outside the compat/runtime set unchanged (no baseUrl in the signature)', () => {
    const anthropic: LlmConnection = {
      slug: 'anthropic-api',
      name: 'Anthropic',
      providerType: 'anthropic',
      authType: 'api_key',
      createdAt: 1,
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-sonnet-4-6',
    }
    const moved = { ...anthropic, baseUrl: 'https://proxy.example.com' }

    const sigFor = (c: LlmConnection) => buildBackendRuntimeSignature({
      connection: c,
      provider: 'anthropic',
      authType: 'api_key',
      resolvedModel: 'claude-sonnet-4-6',
    })

    expect(sigFor(moved)).toBe(sigFor(anthropic))
  })
})

// UB12.38 — editing ONLY a connection's Utility model (`miniModel`) reached no
// live session on any runtime: the signature hashed no mini model, so
// `tryRefreshAgentRuntime` returned at "nothing drifted" until a respawn, and
// titles kept running on the old id. The signature now carries the RESOLVED id
// (the build-time expression `getMiniModel(connection) ?? connection.defaultModel`),
// on every provider type, because all three runtimes read it.
describe('buildBackendRuntimeSignature — UB12.38 the resolved Utility model', () => {
  const twoModels = [{ id: 'model-large' }, { id: 'model-small' }] as never
  const connections: Array<{ connection: LlmConnection; provider: 'pi' | 'anthropic' | 'codex-runtime' }> = [
    { connection: { ...baseCompat, defaultModel: 'model-large', models: twoModels }, provider: 'pi' },
    {
      connection: { ...claudeGateway, slug: 'claude-byo', defaultModel: 'model-large', models: twoModels },
      provider: 'anthropic',
    },
    {
      connection: {
        slug: 'codex-byo',
        name: 'Codex (Custom Endpoint)',
        providerType: 'codex-runtime',
        authType: 'api_key_with_endpoint',
        createdAt: 1,
        baseUrl: 'https://llm-proxy.internal.example.com/v1',
        defaultModel: 'model-large',
        models: twoModels,
      },
      provider: 'codex-runtime',
    },
    // Outside the endpoint-bearing arm: the Utility model matters here too
    // (the claude child's haiku env is set from it at spawn).
    {
      connection: {
        slug: 'anthropic-api',
        name: 'Anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: 1,
        defaultModel: 'claude-sonnet-4-6',
        models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
      },
      provider: 'anthropic',
    },
  ]
  const sigOf = (connection: LlmConnection, provider: 'pi' | 'anthropic' | 'codex-runtime') =>
    buildBackendRuntimeSignature({
      connection,
      provider,
      authType: connection.authType,
      resolvedModel: connection.defaultModel ?? '',
    })

  for (const { connection, provider } of connections) {
    it(`POSITIVE: a Utility-model-only edit drifts a ${connection.providerType} signature`, () => {
      const [first, second] = (connection.models ?? []).map(m => typeof m === 'string' ? m : m.id)
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      expect(sigOf({ ...connection, miniModel: second }, provider))
        .not.toBe(sigOf({ ...connection, miniModel: first }, provider))
    })

    it(`NEGATIVE: a lastUsedAt-only change still drifts nothing on ${connection.providerType}`, () => {
      const withUtility = { ...connection, miniModel: 'model-small' }
      expect(sigOf({ ...withUtility, lastUsedAt: 1 }, provider))
        .toBe(sigOf({ ...withUtility, lastUsedAt: 2 }, provider))
    })
  }

  // BOUNDARY: the RESOLVED id is hashed, not the raw field. Typing into the
  // Utility slot the id the heuristic already picks changes no model any
  // runtime runs on, so it must not respawn a claude child for nothing.
  it('BOUNDARY: setting the Utility model to the id already resolved drifts nothing', () => {
    const { connection, provider } = connections[0]!
    const picked = getMiniModel(connection)
    expect(picked).toBeDefined()
    expect(connection.miniModel).toBeUndefined()
    expect(sigOf({ ...connection, miniModel: picked }, provider)).toBe(sigOf(connection, provider))
  })
})

describe('filterAttachmentsForModelInput', () => {
  it('omits images for pi_compat text-only models while preserving other attachments', () => {
    const result = filterAttachmentsForModelInput(
      [imageAttachment, textAttachment],
      { ...baseCompat, models: [{ id: 'gemma', supportsImages: false } as never] },
      'gemma',
    )

    expect(result.omittedImages.map(a => a.name)).toEqual(['image.png'])
    expect(result.attachments?.map(a => a.name)).toEqual(['note.txt'])
  })

  it('keeps images when the per-model override enables images', () => {
    const result = filterAttachmentsForModelInput([imageAttachment], baseCompat, 'gemma')

    expect(result.omittedImages).toHaveLength(0)
    expect(result.attachments).toEqual([imageAttachment])
  })

  it('treats explicit supportsImages=false as overriding endpoint-level true', () => {
    const result = filterAttachmentsForModelInput(
      [imageAttachment],
      { ...baseCompat, customEndpoint: { api: 'openai-completions', supportsImages: true }, models: [{ id: 'gemma', supportsImages: false } as never] },
      'gemma',
    )

    expect(result.omittedImages).toEqual([imageAttachment])
    expect(result.attachments).toBeUndefined()
  })

  it('strips and reports an image on a model that DECLARES it cannot take one', () => {
    const result = filterAttachmentsForModelInput(
      [imageAttachment, textAttachment],
      claudeGateway,
      'tgpt/qwen35-397b-a17b-fp8',
    )

    expect(result.omittedImages.map(a => a.name)).toEqual(['image.png'])
    expect(result.attachments?.map(a => a.name)).toEqual(['note.txt'])
  })

  // P3.125 / owner ruling 2026-08-28 — the host carries the modality and the
  // ENDPOINT refuses. Undeclared is not a declaration, so nothing of ours denies
  // a BYO vision-capable upstream; the gateway answers with its own named 400
  // (`Invalid Chat Message Part: Model Does Not Support Image Inputs`), whose
  // legibility is pinned in
  // `shared/src/config/__tests__/model-supports-images.test.ts`.
  it('passes an image through on claude-runtime when nothing declares otherwise', () => {
    const result = filterAttachmentsForModelInput(
      [imageAttachment, textAttachment],
      claudeGatewayUndeclared,
      'tgpt/qwen35-397b-a17b-fp8',
    )

    expect(result.omittedImages).toHaveLength(0)
    expect(result.attachments?.map(a => a.name)).toEqual(['image.png', 'note.txt'])
  })

  // The negative subject. Without it this test file also passes on a filter
  // that simply strips every image off claude-runtime, which is the failure
  // mode a capability gate is most likely to ship with.
  it('keeps images on claude-runtime when the model declares it takes them', () => {
    const result = filterAttachmentsForModelInput(
      [imageAttachment],
      { ...claudeGateway, models: [{ id: 'tgpt/qwen35-397b-a17b-fp8', supportsImages: true } as never] },
      'tgpt/qwen35-397b-a17b-fp8',
    )

    expect(result.omittedImages).toHaveLength(0)
    expect(result.attachments).toEqual([imageAttachment])
  })

  // `claude-runtime` collapses onto the `anthropic` AgentProvider, so a filter
  // keyed off the provider alone would strip images on api.anthropic.com too.
  it('keeps images on a direct Anthropic connection', () => {
    const anthropic: LlmConnection = {
      slug: 'anthropic',
      name: 'Anthropic',
      providerType: 'anthropic',
      authType: 'api_key',
      createdAt: 1,
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-sonnet-4-6',
    }
    const result = filterAttachmentsForModelInput([imageAttachment], anthropic, 'claude-sonnet-4-6')

    expect(result.omittedImages).toHaveLength(0)
    expect(result.attachments).toEqual([imageAttachment])
  })
})
