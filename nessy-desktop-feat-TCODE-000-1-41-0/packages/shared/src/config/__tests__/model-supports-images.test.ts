import { describe, expect, it } from 'bun:test'
import { modelSupportsImages, type LlmConnection } from '../llm-connections.ts'
import { PI_COMPAT_UNDECLARED_SUPPORTS_IMAGES } from '../compat-image-default.ts'
import { mapClaudeSdkAssistantError } from '../../agent/claude-sdk-error-mapper.ts'

const BASE_COMPAT: LlmConnection = {
  slug: 'custom',
  name: 'Custom',
  providerType: 'pi_compat',
  authType: 'api_key_with_endpoint',
  baseUrl: 'http://localhost:8080',
  customEndpoint: { api: 'openai-completions' },
  createdAt: 1,
}

// `pi_compat`'s undeclared `false` is the ONE local default that survived the
// 2026-08-28 ruling, and not as a prediction about a model: it is the value we
// author downstream. `buildCustomEndpointModelDef`
// (`pi-agent-server/src/custom-endpoint-models.ts`) applies the identical
// `overrides ?? defaults ?? false` and turns it into `input: ['text']`, and pi-ai
// honours that — `api/transform-messages.js` `downgradeUnsupportedImages`
// substitutes `(image omitted: model does not support images)` for every image
// block when `model.input` lacks `"image"`. Answering `true` here while that
// default stays `false` would stop the host reporting the omission and leave Pi
// quietly substituting a placeholder: no gate, and no endpoint answer either.
describe('modelSupportsImages — pi_compat precedence', () => {
  it('returns true when per-model supportsImages: true (override wins over connection default)', () => {
    const conn: LlmConnection = {
      ...BASE_COMPAT,
      customEndpoint: { api: 'openai-completions', supportsImages: false },
      models: [{ id: 'vision', supportsImages: true } as never],
    }
    expect(modelSupportsImages(conn, 'vision')).toBe(true)
  })

  it('returns false when per-model supportsImages: false (override wins over connection default true)', () => {
    const conn: LlmConnection = {
      ...BASE_COMPAT,
      customEndpoint: { api: 'openai-completions', supportsImages: true },
      models: [{ id: 'text-only', supportsImages: false } as never],
    }
    expect(modelSupportsImages(conn, 'text-only')).toBe(false)
  })

  it('falls back to connection-level supportsImages when no per-model override', () => {
    const conn: LlmConnection = {
      ...BASE_COMPAT,
      customEndpoint: { api: 'openai-completions', supportsImages: true },
      models: ['plain'],
    }
    expect(modelSupportsImages(conn, 'plain')).toBe(true)
  })

  it('returns false when neither per-model override nor connection default is set', () => {
    const conn: LlmConnection = { ...BASE_COMPAT, models: ['plain'] }
    expect(modelSupportsImages(conn, 'plain')).toBe(false)
  })

  it('returns false when the model is not in models[] (matches Pi default)', () => {
    const conn: LlmConnection = { ...BASE_COMPAT, models: ['plain'] }
    expect(modelSupportsImages(conn, 'unknown')).toBe(false)
  })

  it('returns connection default when the model is missing but connection default is true', () => {
    const conn: LlmConnection = {
      ...BASE_COMPAT,
      customEndpoint: { api: 'openai-completions', supportsImages: true },
      models: ['plain'],
    }
    expect(modelSupportsImages(conn, 'unknown')).toBe(true)
  })

  // P3.137. The two cases above assert the LITERAL `false`; this one asserts
  // that the host is answering from the shared constant, so a lane that moves
  // the default moves it here and in `pi-agent-server` together — the whole
  // point of `compat-image-default.ts`. Written as an equality against the
  // constant rather than a second `toBe(false)`: hard-coding the value again is
  // exactly the drift the constant exists to prevent.
  it('answers the undeclared case from the shared two-reader constant', () => {
    const conn: LlmConnection = { ...BASE_COMPAT, models: ['plain'] }
    expect(modelSupportsImages(conn, 'plain')).toBe(PI_COMPAT_UNDECLARED_SUPPORTS_IMAGES)
  })
})

describe('modelSupportsImages — non-pi_compat fallthrough', () => {
  // A DECLARATION is authoritative on every provider type. This used to expect
  // `true` here: the old shape returned `true` unconditionally for anything that
  // was neither `pi_compat` nor one of the two runtimes, so an explicit
  // `supportsImages: false` was overruled — the same defect P3.101 measured on
  // `codex-runtime`, still live for the rest of the union.
  it('honours an explicit supportsImages: false on anthropic', () => {
    const conn: LlmConnection = {
      slug: 'a', name: 'a', providerType: 'anthropic', authType: 'api_key',
      models: [{ id: 'claude-haiku', supportsImages: false } as never],
      createdAt: 1,
    }
    expect(modelSupportsImages(conn, 'claude-haiku')).toBe(false)
  })

  it('returns true for an undeclared anthropic model (no declaration, no gate)', () => {
    const conn: LlmConnection = {
      slug: 'a', name: 'a', providerType: 'anthropic', authType: 'api_key',
      models: ['claude-haiku'],
      createdAt: 1,
    }
    expect(modelSupportsImages(conn, 'claude-haiku')).toBe(true)
  })

  // P3.125 — `claude-runtime`'s undeclared default WAS `false`, and its recorded
  // reason was "`to-chat.ts` has no image mapping". `30628c7d0` killed that
  // reason: `anthropic/inbound.ts` `imageBlockToInputImage` maps the Anthropic
  // image block onto `input_image` and `to-chat.ts` `toChatContent` maps that
  // onto the chat `image_url` part, so the local adapter carries the image end to
  // end. Per the owner ruling of 2026-08-28 the fix is LESS GATING, not a better
  // guess: a declaration is honoured, an undeclared model is left to the endpoint.
  // The shipped gateway card is unaffected — both `NESSY_GATEWAY_MODELS` entries
  // declare `supportsImages: false`, and `fetchNestorModels` spreads the stored
  // override back over every refresh.
  it('honours a claude-runtime declaration and leaves undeclared models to the endpoint', () => {
    const base = {
      slug: 'claude-gateway', name: 'Claude Code (Nessy Gateway)',
      providerType: 'claude-runtime', authType: 'api_key_with_endpoint',
      baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
      createdAt: 1,
    } satisfies Omit<LlmConnection, 'models'>

    const declaredFalse: LlmConnection = { ...base, models: [{ id: 'tgpt/qwen', supportsImages: false } as never] }
    const declaredTrue: LlmConnection = { ...base, models: [{ id: 'tgpt/qwen', supportsImages: true } as never] }
    const undeclared: LlmConnection = { ...base, models: ['tgpt/qwen'] }

    expect(modelSupportsImages(declaredFalse, 'tgpt/qwen')).toBe(false)
    // An explicit per-model override still wins, end to end (AGENTS.md).
    expect(modelSupportsImages(declaredTrue, 'tgpt/qwen')).toBe(true)
    // The flip: a BYO vision-capable upstream is no longer denied by us.
    expect(modelSupportsImages(undeclared, 'tgpt/qwen')).toBe(true)
    expect(modelSupportsImages(undeclared, 'never-heard-of-it')).toBe(true)
  })

  it('lets a claude-runtime connection-level default speak for undeclared models', () => {
    const conn: LlmConnection = {
      slug: 'claude-byo', name: 'Claude BYO', providerType: 'claude-runtime',
      authType: 'api_key_with_endpoint', baseUrl: 'https://example.invalid/v1',
      customEndpoint: { api: 'openai-completions', supportsImages: false },
      models: ['text-only'],
      createdAt: 1,
    }
    expect(modelSupportsImages(conn, 'text-only')).toBe(false)
  })

  // P3.101 — `codex-runtime` reached the blanket `true` through the docstring's
  // "the renderer doesn't own the catalog", which does not hold for it:
  // `getModelsForProviderType` returns `[]` there because the models are
  // gateway-fetched onto the connection. The consequence was not cosmetic — an
  // explicit `supportsImages: false` was overruled, so `filterAttachmentsForModelInput`
  // never fired and (before P6.28 gave the adapter its `localImage` member) the
  // image was dropped with nothing said anywhere.
  //
  // The undeclared default is `true` because codex's host path carries the image
  // natively, so a text-only model fails at the endpoint visibly. As of P3.125
  // that is no longer a special case: claude-runtime answers `true` undeclared
  // too, on the same fact, and the docstring carries the recorded null (nothing
  // reports per-model modality for these connections).
  it('consults the catalog for codex-runtime and defaults undeclared models to images', () => {
    const base = {
      slug: 'codex-gateway', name: 'Codex (Nessy Gateway)',
      providerType: 'codex-runtime', authType: 'api_key_with_endpoint',
      baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
      createdAt: 1,
    } satisfies Omit<LlmConnection, 'models'>

    const declaredFalse: LlmConnection = { ...base, models: [{ id: 'tgpt/qwen', supportsImages: false } as never] }
    const declaredTrue: LlmConnection = { ...base, models: [{ id: 'tgpt/qwen', supportsImages: true } as never] }
    const undeclared: LlmConnection = { ...base, models: ['tgpt/qwen'] }

    // The half that was broken: a declaration is now authoritative.
    expect(modelSupportsImages(declaredFalse, 'tgpt/qwen')).toBe(false)
    expect(modelSupportsImages(declaredTrue, 'tgpt/qwen')).toBe(true)
    // The half that is a decision, not an accident.
    expect(modelSupportsImages(undeclared, 'tgpt/qwen')).toBe(true)
    expect(modelSupportsImages(undeclared, 'never-heard-of-it')).toBe(true)
  })

  it('lets a codex-runtime connection-level default speak for undeclared models', () => {
    const conn: LlmConnection = {
      slug: 'codex-byo', name: 'Codex BYO', providerType: 'codex-runtime',
      authType: 'api_key_with_endpoint', baseUrl: 'https://example.invalid/v1',
      customEndpoint: { api: 'openai-completions', supportsImages: false },
      models: ['text-only'],
      createdAt: 1,
    }
    expect(modelSupportsImages(conn, 'text-only')).toBe(false)
  })

  it('honours an explicit supportsImages: false on the native pi provider type', () => {
    const conn: LlmConnection = {
      slug: 'p', name: 'p', providerType: 'pi', authType: 'api_key',
      models: [{ id: 'gpt-x', supportsImages: false } as never],
      createdAt: 1,
    }
    expect(modelSupportsImages(conn, 'gpt-x')).toBe(false)
  })

  it('returns true for an undeclared pi model', () => {
    const conn: LlmConnection = {
      slug: 'p', name: 'p', providerType: 'pi', authType: 'api_key',
      models: ['gpt-x'],
      createdAt: 1,
    }
    expect(modelSupportsImages(conn, 'gpt-x')).toBe(true)
  })
})

/**
 * THE CONDITION THIS WHOLE DEFAULT DEPENDS ON.
 *
 * The owner ruling of 2026-08-28 replaces our guess about a model's modality
 * with the endpoint's own answer — *"it will say so itself"* — and that is only
 * true while the endpoint's answer REACHES the user as something they can act
 * on. The gateway's refusal is a named 400: `Invalid Chat Message Part: Model
 * Does Not Support Image Inputs` (measured 2026-08-28). If a future path folds
 * that into a generic failure, this ruling silently becomes the silent-loss
 * defect it replaced — so the legibility is pinned here, next to the default it
 * licences, rather than left as an assumption.
 *
 * `mapClaudeSdkAssistantError` is the swallow point for `claude-runtime`, the
 * runtime whose undeclared default this change flips.
 */
describe('the endpoint refusal stays legible (the ruling\'s first condition)', () => {
  const GATEWAY_IMAGE_REFUSAL = 'Invalid Chat Message Part: Model Does Not Support Image Inputs'

  const contextFor = (message: string) => ({
    actualError: null,
    capturedApiError: {
      status: 400,
      statusText: 'Bad Request',
      message,
      timestamp: 1,
    },
    providerType: 'claude-runtime',
    claudeRuntimeUpstreamKind: 'nestor',
    userTurnHadAttachments: true,
  })

  it('carries the endpoint\'s named capability refusal through verbatim', () => {
    const error = mapClaudeSdkAssistantError('invalid_request', contextFor(GATEWAY_IMAGE_REFUSAL))

    expect(error.details?.some(detail => detail.includes(GATEWAY_IMAGE_REFUSAL))).toBe(true)
  })

  it('does not re-tell a capability refusal as a context-window story', () => {
    const error = mapClaudeSdkAssistantError('invalid_request', contextFor(GATEWAY_IMAGE_REFUSAL))

    // The two arms above the generic fallback replace the upstream's reason with
    // /compact advice. A refusal about a MODALITY must not reach either of them.
    expect(error.title).not.toContain('Context')
    expect(error.details?.some(detail => detail.includes('/compact'))).toBe(false)
  })

  // Positive control on the same rig: the assertions above measure message
  // SURVIVAL, not an always-true property. With nothing to carry, the mapper
  // says so instead of inventing a reason.
  it('positive control — an empty upstream message yields no phantom detail', () => {
    const error = mapClaudeSdkAssistantError('invalid_request', {
      actualError: null,
      capturedApiError: null,
      providerType: 'claude-runtime',
      userTurnHadAttachments: true,
    })

    expect(error.details?.some(detail => detail.includes(GATEWAY_IMAGE_REFUSAL))).toBe(false)
    expect(error.details?.some(detail => detail.includes('No detailed error info available'))).toBe(true)
  })
})
