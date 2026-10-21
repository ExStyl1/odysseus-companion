import { nestorGatewayModelWindow } from '../../shared/src/auth/nestor.ts'
import { PI_COMPAT_UNDECLARED_SUPPORTS_IMAGES } from '../../shared/src/config/compat-image-default.ts'
import { isNessyGatewayBaseUrl } from '../../shared/src/agent/backend/internal/drivers/upstream-target.ts'

export type CustomEndpointInput = 'text' | 'image'

export interface CustomEndpointModelDefaults {
  supportsImages?: boolean
}

export interface CustomEndpointModelOverrides {
  contextWindow?: number
  supportsImages?: boolean
  /**
   * P6.367 — the operator's own declaration that this id reasons.
   *
   * `supportsThinking` and not a new word: it is `ModelDefinition`'s existing
   * field, the one the `/model` picker already hides the effort control on and
   * the one `activeEffortLevelForModel` already reads to refuse aloud. A second
   * spelling for the same question is how the two answers drift apart, and the
   * host has been carrying this one since long before this row.
   *
   * Absent means UNDECLARED, and undeclared keeps the behaviour this file has
   * always had — see the `reasoning` line in {@link buildCustomEndpointModelDef}
   * for why the default here is deliberately the opposite of the field's
   * documented default one layer up.
   */
  supportsThinking?: boolean
  /**
   * DA1.22 — the sampling parameters the model's own catalogue published.
   *
   * NATIVE, and that is the whole reason this field exists rather than a
   * translation: Pi's `Model` declares `samplingParams?: Record<string, unknown>`
   * — *"Default sampling parameters for this model … per-request keys override
   * these"* (`@earendil-works/pi-ai` `dist/types.d.ts`) — and its
   * OpenAI-compatible adapters merge it into the request body as-is, after the
   * named fields. The gateway publishes `sampling_params` per `/cli/models` row
   * in exactly that shape. So the host carries an object across and invents
   * nothing, which is the native-first answer rather than a knob of our own.
   *
   * `Record<string, unknown>` and no key allowlist, deliberately: `top_k` is
   * published on the `fast` row and there is no other route for it, and an
   * allowlist would silently drop the next key the catalogue grows.
   */
  samplingParams?: Record<string, unknown>
}

export interface CustomEndpointModelEntry extends CustomEndpointModelOverrides {
  id: string
}

export type CustomEndpointModelConfig = string | {
  id: string
  contextWindow?: number
  supportsImages?: boolean
  supportsThinking?: boolean
  samplingParams?: Record<string, unknown>
}

/** Strip bare model IDs (remove pi/ prefix if present). */
export function stripPiPrefix(id: string): string {
  return id.startsWith('pi/') ? id.slice(3) : id
}

/**
 * Normalize a user-configured custom endpoint model for Pi SDK registration.
 *
 * Keep explicit per-model capability overrides intact. In particular,
 * `supportsImages: false` is meaningful because it can override a global
 * endpoint default of `supportsImages: true` for text-only models.
 */
export function normalizeCustomEndpointModelEntry(model: CustomEndpointModelConfig): CustomEndpointModelEntry {
  if (typeof model === 'string') {
    return { id: stripPiPrefix(model) }
  }

  return {
    id: stripPiPrefix(model.id),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
    ...(model.supportsThinking !== undefined ? { supportsThinking: model.supportsThinking } : {}),
    ...(model.samplingParams !== undefined ? { samplingParams: model.samplingParams } : {}),
  }
}

/**
 * DA1.22 — the entry's capability half, with the id dropped: what
 * {@link buildCustomEndpointModelDef} takes as its `overrides` argument.
 *
 * IT EXISTS BECAUSE THE HAND-WRITTEN VERSION OF IT DROPPED A FIELD FOR A MONTH.
 * `registerCustomEndpointModels` (`index.ts`) used to build this object inline
 * from a list of field NAMES — `contextWindow` and `supportsImages` — which made
 * it a THIRD whitelist after the two host-side mappers, and the one nobody
 * widened: P6.367 threaded an operator's `supportsThinking` through four type
 * copies, both host mappers and {@link normalizeCustomEndpointModelEntry}, and
 * it died there, so every custom-endpoint model reached pi-ai with
 * `reasoning: false` whatever the operator had declared. It was invisible
 * because the suite drives `buildCustomEndpointModelDef` directly with an
 * overrides object — through a stub of precisely that seam.
 *
 * So the projection is STRUCTURAL rather than nominal: `entry` minus `id`. A
 * field added to {@link CustomEndpointModelOverrides} is carried by construction
 * and cannot be forgotten here. The one remaining whitelist is
 * {@link normalizeCustomEndpointModelEntry}, which is in this file and under
 * test.
 *
 * Returns `undefined` when the entry declares nothing, so the caller stores no
 * map entry at all and a bare-id model takes exactly the path it took before.
 */
export function customEndpointModelOverrides(
  entry: CustomEndpointModelEntry,
): CustomEndpointModelOverrides | undefined {
  const { id: _id, ...overrides } = entry
  return Object.keys(overrides).length > 0 ? overrides : undefined
}

/**
 * The window a custom-endpoint model gets when nothing knows its real one.
 *
 * It is a FABRICATION, and the Pi SDK needs a number, so it stays — but the
 * caller is told when it was used (`windowIsFallback`) so the figure is never
 * reported to the user as if the runtime had measured it. On the owner's
 * profile a one-line prompt already spends ~70 000 input tokens, so a model
 * whose real window is 40 960 cannot answer at all; labelling that model
 * "128 000, from the runtime" hides a hard failure behind a healthy donut.
 *
 * **P3.79 — the number is no longer ours.** It was a hand-typed `131_072`
 * (2^17), and the runtime we hand these definitions to already has its own
 * answer for exactly this question. Measured in the installed SDK,
 * `@earendil-works/pi-coding-agent@0.84.0`, re-measured unchanged at
 * `@0.84.2` (S0-3, 2026-09-03) and again at `@0.84.3` (W11-pi, 2026-09-11) —
 * the literal, the fallback and both sibling copies are byte-identical, at the
 * same line numbers:
 *
 *     // core/provider-composer.js:72 — the function that turns a definition
 *     // like ours into a Pi model
 *     contextWindow: definition.contextWindow ?? 128000,
 *
 * and the same `128000` again in `core/compaction/branch-summarization.js:190`,
 * in `@earendil-works/pi-agent-core`'s copy of it, and in the llama extension's
 * `toPiModel`. So the value that applies when we pass NOTHING is 128 000, and
 * our fabrication sat 1 072 tokens ABOVE it — small, but in the one direction
 * that is not recoverable: an over-stated window runs the session past the real
 * limit before anything compacts, while an under-stated one only compacts early.
 * Matching the runtime's own default means our fallback and its fallback can no
 * longer disagree, and there is nothing left here that anyone invented.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000

/**
 * Build a synthetic model definition for a custom endpoint.
 * Uses reasonable defaults for max tokens since we can't query the endpoint for
 * its actual capabilities. Image support must be explicitly enabled either at
 * the connection level or per-model.
 *
 * Returns the definition alongside `windowIsFallback` rather than just the
 * definition: the fabricated window is indistinguishable from a real 128 000
 * once it is inside the SDK, so the fact has to travel out at build time — and
 * it now means "nobody measured this", not merely "the caller sent none",
 * because a gateway id the table covers is measured even when the caller sends
 * nothing.
 *
 * **Three tiers, P3.79.** The stored window the caller passes, then the gateway
 * windows the model fetcher measured (`nestorGatewayModelWindow`, the same table
 * `claude-agent.ts` already consults), then the runtime's own default. The
 * middle tier is the parity half: a `claude-runtime` session whose stored
 * catalogue entry lost its window — a refresh that predates the table, a
 * hand-edited connection — recovers the real number, and until now the Pi
 * session beside it did not, which is exactly the asymmetry this plan exists to
 * close.
 *
 * **The middle tier is gated on the WHOLE URL, P2.392.** Until this row it
 * matched on the ID alone, and it was the only place in this repo where the
 * gateway table was consulted without `isNessyGatewayBaseUrl` — the whole-URL
 * match the claude path (`resolveClaudeRuntimeUpstream`), the two model fetchers
 * and `runtime-switch.ts` all gate on, because a BYO endpoint on the same host
 * under another path may serve a same-named id at a different real window. The
 * exposure was a BYO endpoint serving an id spelled exactly like an internal
 * gateway one (`tgpt/qwen35-397b-a17b-fp8`, `tgpt/qwen36-35b-a3b-fp8`), which
 * inherited the gateway's window: an OVER-stated window, the direction that runs
 * a session past the real limit before anything compacts, on the runtime we ship
 * by default. `baseUrl` is therefore REQUIRED and second, so a caller cannot
 * silently omit the gate the way the previous signature let it be absent.
 *
 * The matcher itself is imported rather than re-derived: two copies of "which
 * URL is the gateway" is exactly how that boundary drifts (`upstream-target.ts`
 * header), and the two paths must not disagree about what makes a model a
 * gateway model.
 *
 * **`api` decides the one `compat` field the host declares, F1.243.** An
 * `openai-completions` model carries `compat: { supportsStore: false }`, so
 * pi-ai omits the OpenAI-platform `store` param. pi-ai 0.84.4's
 * `api/openai-completions.js` `detectCompat` answers `supportsStore:
 * !isNonStandard` — true for every host off its fixed list — and the request
 * builder then writes `params.store = false`; `getCompat` lets
 * `model.compat.supportsStore` override that detection. With no compat
 * declared, every BYO openai-completions endpoint received the field, and so
 * did the gateway (the loopback reasoning proxy passes `store` through), while
 * a strict OpenAI-compatible provider answers an unknown param with a 400.
 * Adapted from craft-agents-oss v0.13.4 `buildCustomEndpointModelDef`
 * (their #1022), Apache-2.0. An `anthropic-messages` model, and a caller that
 * passes no `api`, get no `compat` key at all — the definition they always got.
 * Pinned against pi-ai's OWN request builder in the suite, so a Pi lift that
 * changes the detection is a red test rather than a silent return of the field.
 *
 * **The trade, stated (F1.328): the rule is one for EVERY openai-completions
 * endpoint, api.openai.com included**, where pi-ai's detection would otherwise
 * send the platform's own explicit opt-out. Kept, because omitting it there
 * changes nothing: OpenAI's published schema gives the param a default of false
 * (`openai/openai-openapi` `openapi.yaml`, `CreateChatCompletionRequest.store`:
 * `type: boolean`, `default: false` — "Whether or not to store the output of
 * this chat completion request for use in our model distillation or evals
 * products"), and its List Chat Completions reference says "Only Chat
 * Completions that have been stored with the store parameter set to true will
 * be returned". Read 2026-09-24; if that default ever turns to storing, exempt
 * `api.openai.com` here rather than dropping the rule (the suite's
 * api.openai.com arm pins what pi-ai sends there).
 *
 * **F1.1263 — a BYO endpoint gets two more of pi-ai's OWN compat fields:**
 * `maxTokensField: 'max_tokens'` and `supportsUsageInStreaming: false`, so the
 * request carries the classic `max_tokens` and no `stream_options`. Measured in
 * SIT2-e (2026-10-01): a strict OpenAI-compatible endpoint answered
 * "Unrecognized request argument supplied: stream_options,
 * max_completion_tokens" to pi-ai's detected defaults, with no retry. Native:
 * both are fields of pi-ai's `OpenAICompletionsCompat` that `getCompat` prefers
 * over its URL detection — nothing of ours is translated. BYO only, meaning
 * neither the verified gateway (measured accepting both, and its streamed usage
 * feeds the meter) nor `api.openai.com` (whose reasoning models refuse
 * `max_tokens`); both keep pi-ai's detection. THE RESIDUE, stated: a BYO
 * endpoint no longer streams usage, so Pi estimates the context from message
 * sizes (its own zero-usage fallback in `_checkCompaction` and
 * `estimateContextTokens`) and the session's token counts there are estimates;
 * a BYO proxy in front of an OpenAI reasoning model that refuses `max_tokens`
 * would now 400 — that operator's remedy is a host-side compat override, which
 * no row has asked for yet.
 */
export function buildCustomEndpointModelDef(
  id: string,
  baseUrl: string | undefined,
  defaults?: CustomEndpointModelDefaults,
  overrides?: CustomEndpointModelOverrides,
  api?: 'openai-completions' | 'anthropic-messages',
) {
  // P3.137 — the same constant the host answers from (`modelSupportsImages`
  // in `config/llm-connections.ts`). The two defaults move together or not at
  // all: flipping one alone yields pi-ai's `(image omitted…)` placeholder
  // instead of a refusal, or a host refusing a send the runtime would carry.
  // See `compat-image-default.ts` — this import is the residue its header
  // named, and it is now mechanical rather than documented.
  const supportsImages = overrides?.supportsImages ?? defaults?.supportsImages ?? PI_COMPAT_UNDECLARED_SUPPORTS_IMAGES
  const input: CustomEndpointInput[] = supportsImages ? ['text', 'image'] : ['text']
  // Tier two, between the stored window and the fabrication: the gateway
  // windows the model fetcher measured, and ONLY when the endpoint being
  // registered is the verified gateway. See the constant's note.
  const measured = overrides?.contextWindow
    ?? (isNessyGatewayBaseUrl(baseUrl) ? nestorGatewayModelWindow(id) : undefined)
  const contextWindow = measured ?? FALLBACK_CONTEXT_WINDOW

  return {
    def: {
      id,
      name: id,
      // P6.367 — the operator's declaration, and it was a hard `false` until
      // this row: no operator could say that a BYO or gateway id reasons, so
      // effort was disabled for every custom-endpoint model whatever the
      // endpoint could do. The regex tables in `thinking-levels.ts` were never
      // the cause (they are deliberately permissive and pass an unlisted id
      // through unchanged); this literal was.
      //
      // UNDECLARED STAYS `false`, deliberately opposite to `ModelDefinition`'s
      // documented "defaults to true when undefined". The two defaults answer
      // different questions: one layer up it decides whether to SHOW a control,
      // and being wrong costs a hidden picker; here it decides whether pi-ai
      // SENDS an effort parameter, and being wrong costs a 400 from a plain
      // OpenAI-compatible endpoint that never asked for one. So the safe
      // direction is opt-in, and the operator who wants effort says so on the
      // model entry. The divergence is stated rather than silently inherited.
      reasoning: overrides?.supportsThinking ?? false,
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens: 8_192,
      // DA1.22 — the catalogue's own sampling defaults, into the field Pi already
      // has for them. Omitted entirely when the row published none, so a model
      // with no recommendation takes the exact path it took before this row: no
      // key on the definition, and pi-ai's own per-request handling unchanged.
      ...(overrides?.samplingParams ? { samplingParams: overrides.samplingParams } : {}),
      // F1.243 — see the function's note: openai-completions only. F1.1263 adds
      // the two strict-endpoint fields for a BYO host (see the note).
      ...(api === 'openai-completions'
        ? { compat: isStrictCompatByoHost(baseUrl)
          ? { supportsStore: false, maxTokensField: 'max_tokens' as const, supportsUsageInStreaming: false }
          : { supportsStore: false } }
        : {}),
    },
    windowIsFallback: measured === undefined,
  }
}

/**
 * F1.1263 — whether an openai-completions custom endpoint takes the BYO compat
 * (`max_tokens`, no streamed usage): every host except the verified gateway and
 * `api.openai.com`, which keep pi-ai's own detection. See
 * {@link buildCustomEndpointModelDef}'s note for the measurement and residue.
 */
function isStrictCompatByoHost(baseUrl: string | undefined): boolean {
  if (isNessyGatewayBaseUrl(baseUrl)) return false
  try {
    return new URL(baseUrl ?? '').hostname !== 'api.openai.com'
  } catch {
    return true
  }
}
