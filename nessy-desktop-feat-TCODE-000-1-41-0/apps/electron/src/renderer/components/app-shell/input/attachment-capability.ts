import type { ComposerCapabilities } from '@nessy-agent/shared/protocol'
import { modelImageRefusalSentence, type LlmConnection, type LlmProviderType } from '@config/llm-connections'

export interface StagedImagePolicy {
  /** Staged images this runtime cannot read — the send is refused until they go. */
  blocked: boolean
  /**
   * Whether to offer the one-click "enable image support" override next to the
   * warning.
   */
  offerModelOverride: boolean
  /**
   * P6.584 — the ENDPOINT'S OWN SENTENCE, when this model's `false` was LEARNED
   * from a refused turn rather than declared by a person or defaulted.
   *
   * `undefined` is the ordinary case and the banner then says nothing extra,
   * which is the point: a warning that quotes a reason is only honest while
   * there is a reason to quote. Declared and defaulted `false` both produce
   * `undefined` here — they are not the endpoint speaking, and inventing a
   * sentence for them would make a guess look like an answer.
   */
  refusalSentence?: string
}

/**
 * The provider types where the connection catalogue's `supportsImages` is what
 * the send consults, so writing it changes something. Why each is in or out is
 * {@link resolveStagedImagePolicy}'s subject.
 */
const OVERRIDE_WRITING_PROVIDER_TYPES: readonly LlmProviderType[] = ['pi_compat', 'claude-runtime']

/**
 * What the composer does about staged images the active runtime cannot take.
 *
 * The decision reads `ComposerCapabilities.attachments.images` — the SERVER's
 * answer, resolved from the connection and the model — instead of the
 * renderer's own `isCompatProvider(...) && !modelSupportsImages(...)`, which
 * knew about `pi_compat` and nothing else. The same capability gates the
 * send-time filter (`server-core/src/sessions/runtime-config.ts`), so the
 * warning and the strip can no longer disagree.
 *
 * `offerModelOverride` is the half that is NOT the capability. The banner's
 * action writes `supportsImages: true` onto the connection's model entry, so it
 * decides something exactly where that declaration is what the send consults.
 *
 * ## P3.136 — the reason for withholding it on `claude-runtime` was dead, and
 * ## withholding it left that runtime's declaration with NO UI writer at all
 *
 * This block used to read: *"On `claude-runtime` the local adapter drops image
 * parts regardless of what the catalog says, so flipping the override there
 * would clear the warning, re-enable the send and change nothing about what
 * reaches the model: a button that lies."* Both halves stopped being true at
 * `30628c7d0`, and nothing here noticed:
 *
 * 1. **The adapter carries the image end to end.**
 *    `codex-responses-adapter/src/anthropic/inbound.ts`'s
 *    `imageBlockToInputImage` maps the Anthropic `image` block onto
 *    `input_image`, and `to-chat.ts`'s `toChatContent` (the renamed
 *    `flattenContent`, which used to keep only parts carrying a string `text`)
 *    maps that onto the standard chat `image_url` part. On a BYO vision-capable
 *    upstream the image simply works.
 * 2. **The declaration is what decides the send on this runtime.**
 *    `resolveComposerCapabilities` gives `claude-runtime` `images:'per-model'`,
 *    which resolves through `modelSupportsImages` — per-model `supportsImages`
 *    first, connection-level second. Writing the override therefore moves the
 *    capability from `'no'` to `'yes'` and the send-time strip with it.
 *
 * The consequence of leaving it withheld was the sharp part: both Nessy-gateway
 * models are seeded `supportsImages: false` (`apisetup/nessy-gateway.ts`) and
 * the model picker's per-row vision toggle is `isCompatProvider`-gated
 * (`FreeFormInput.tsx`, `CompactModelSelector.tsx`), so a user on a
 * vision-capable BYO `claude-runtime` upstream could not turn image input on by
 * ANY route in the product.
 *
 * **What the user gets on the gateway, stated rather than hidden.** Flipping it
 * there does not manufacture a capability: the turn leaves with the image part
 * and the gateway answers `400 Invalid Chat Message Part: Model Does Not Support
 * Image Inputs` (measured live 2026-08-28, both served models, both roles,
 * stream and non-stream), which is the owner's 2026-08-28 posture — carry the
 * modality faithfully and let the ENDPOINT refuse. That refusal reaching the
 * user is the condition the posture depends on, and it is pinned for this
 * runtime at the `mapClaudeSdkAssistantError` swallow point
 * (`shared/src/config/__tests__/model-supports-images.test.ts`).
 *
 * `codex-runtime` is deliberately NOT added here: its images ride codex's own
 * `LocalImageUserInput` wire (P6.28) rather than a catalog declaration this
 * button writes, so the button would be the lie there that it no longer is on
 * claude. Every other provider type keeps the warning alone.
 */
export function resolveStagedImagePolicy(input: {
  hasStagedImages: boolean
  images: ComposerCapabilities['attachments']['images']
  providerType?: LlmProviderType | undefined
  /**
   * P6.584 — the connection and model whose learned refusal the banner quotes.
   * Both optional and both required together: with either missing there is
   * nothing to look the sentence up in, and the banner falls back to the plain
   * warning it has always shown.
   */
  connection?: Pick<LlmConnection, 'models'> | undefined
  modelId?: string | undefined
}): StagedImagePolicy {
  const blocked = input.hasStagedImages && input.images === 'no'
  const refusalSentence = blocked && input.connection && input.modelId
    ? modelImageRefusalSentence(input.connection, input.modelId)
    : undefined
  return {
    blocked,
    offerModelOverride: blocked
      && input.providerType !== undefined
      && OVERRIDE_WRITING_PROVIDER_TYPES.includes(input.providerType),
    ...(refusalSentence === undefined ? {} : { refusalSentence }),
  }
}
