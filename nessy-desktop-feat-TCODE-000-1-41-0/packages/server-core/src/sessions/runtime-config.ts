import type { AgentProvider, LlmAuthType } from '@nessy-agent/shared/agent/backend'
import { providerTypeToAgentProvider, resolveComposerCapabilities } from '@nessy-agent/shared/agent/backend'
import { getMiniModel, isAdapterRuntimeProvider, isCompatProvider, type LlmConnection } from '@nessy-agent/shared/config'
import type { FileAttachment } from '@nessy-agent/shared/protocol'

export interface BackendRuntimeSignatureInput {
  connection: LlmConnection | null
  provider: AgentProvider
  authType?: LlmAuthType
  resolvedModel: string
}

export interface ModelAttachmentFilterResult {
  /** Attachments safe to pass to the model, or undefined when none remain. */
  attachments?: FileAttachment[]
  /** Image attachments intentionally omitted from the model payload. */
  omittedImages: FileAttachment[]
}

function definedObject<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined))
}

function normalizeCustomModels(connection: LlmConnection): Array<Record<string, unknown>> {
  return (connection.models ?? [])
    .map(model => {
      if (typeof model === 'string') return { id: model }
      return definedObject({
        id: model.id,
        contextWindow: model.contextWindow,
        supportsImages: typeof model.supportsImages === 'boolean' ? model.supportsImages : undefined,
      })
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

/**
 * Build a stable signature over the fields that the `update_runtime_config`
 * IPC envelope cannot safely propagate to a live subprocess. When this
 * signature drifts, the in-place refresh path must be skipped in favour of
 * a clean dispose + recreate so the new auth/provider routing actually takes
 * effect.
 *
 * Concretely, `update_runtime_config` (see `pi-agent.ts:requestRuntimeConfigUpdate`
 * and the matching handler at `pi-agent-server/src/index.ts:handleUpdateRuntimeConfig`)
 * carries `model, miniModel, providerType, authType, baseUrl, customEndpoint,
 * customModels` (`miniModel` since UB12.11) — but NOT `piAuthProvider`, and
 * switching `slug`/`providerType`/`authType` mid-life pulls in credential
 * routing and provider-registry state the subprocess doesn't fully reset on a
 * runtime update.
 */
export function buildRestartRequiredSignature(input: BackendRuntimeSignatureInput): string {
  const { connection, provider, authType } = input
  return JSON.stringify(definedObject({
    provider,
    authType,
    slug: connection?.slug,
    providerType: connection?.providerType,
    piAuthProvider: connection?.piAuthProvider,
  }))
}

/**
 * Build a stable signature for config fields that affect an already-created
 * backend runtime. Metadata such as `lastUsedAt` is intentionally omitted.
 *
 * The endpoint-bearing block covers `pi_compat` AND the two adapter runtimes
 * (`isAdapterRuntimeProvider`). C3 made a runtime connection's endpoint
 * user-editable; without this the signature would not drift when it changed, so
 * a live session's agent — and the local adapter it already started — would keep
 * posting to the previous upstream until the session restarted.
 *
 * UB12.38 — the RESOLVED Utility model is hashed on every provider type, with
 * the build-time expression (`getMiniModel(connection) ?? connection.defaultModel`,
 * the one `runAgentRuntimeRefresh` re-runs for the envelope). Without it, editing
 * only a connection's explicit `miniModel` drifted nothing, so the SAVE handler's
 * `refreshConnectionRuntime` returned early and every runtime kept the old id
 * until a respawn. On a drift Pi and codex adopt the id in place
 * (`updateRuntimeConfig`, UB12.11 and UB12.37); claude has no in-place update
 * and is rebuilt, which is what its spawn-time haiku env needs. The resolved id,
 * not the raw field: typing the id the heuristic already picks changes no model
 * any runtime runs on, so it drifts nothing.
 */
export function buildBackendRuntimeSignature(input: BackendRuntimeSignatureInput): string {
  const { connection, provider, authType, resolvedModel } = input

  const connectionShape = connection
    ? definedObject({
        slug: connection.slug,
        providerType: connection.providerType,
        authType: connection.authType,
        defaultModel: connection.defaultModel,
        miniModel: getMiniModel(connection) ?? connection.defaultModel,
        ...(isCompatProvider(connection.providerType) || isAdapterRuntimeProvider(connection.providerType)
          ? {
              baseUrl: connection.baseUrl,
              piAuthProvider: connection.piAuthProvider,
              customEndpoint: connection.customEndpoint
                ? definedObject({
                    api: connection.customEndpoint.api,
                    supportsImages: typeof connection.customEndpoint.supportsImages === 'boolean'
                      ? connection.customEndpoint.supportsImages
                      : undefined,
                  })
                : undefined,
              models: normalizeCustomModels(connection),
            }
          : {}),
      })
    : null

  return JSON.stringify(definedObject({
    provider,
    authType,
    resolvedModel,
    connection: connectionShape,
  }))
}

export function isImageAttachment(attachment: Pick<FileAttachment, 'type' | 'mimeType'>): boolean {
  return attachment.type === 'image' || attachment.mimeType?.startsWith('image/') === true
}

/**
 * Enforce the runtime's declared image capability at send time. The session can
 * still persist/display image attachments, but they are not passed to a model
 * that cannot read them — even if an older subprocess has stale vision-capable
 * registry state.
 *
 * The decision is `resolveComposerCapabilities(...).attachments.images`, which
 * is the same answer the COMPOSER draws its warning from, so the two surfaces
 * cannot disagree. This used to be gated on `isCompatProvider` alone, which
 * meant `claude-runtime` never reached the filter at all.
 *
 * **What reaches the filter has NARROWED, and the reason recorded here was
 * dead.** It named `to-chat.ts:flattenContent` — "it keeps only content parts
 * carrying a string `text`" — as why a staged image on `claude-runtime` was
 * dropped without a word. That symbol no longer exists and that behaviour is
 * reversed: `30628c7d0` renamed it `toChatContent` and taught it the chat
 * `image_url` part, so the local adapter now CARRIES the image and a text-only
 * model refuses at the endpoint, in the endpoint's own words. Per the owner
 * ruling of 2026-08-28 the host no longer predicts that refusal
 * (`modelSupportsImages` gates on an explicit declaration only), so what still
 * arrives here is exactly the two cases where the omission is real and would
 * otherwise be silent: a model or endpoint that DECLARES `supportsImages:
 * false`, and `nestor-cloud-agent`, which declares `images: 'no'` and whose
 * backend ignores attachments outright (`nestor-cloud-agent.ts:62` takes
 * `_attachments`).
 *
 * The provider is DERIVED from the connection rather than taken as an argument
 * — `providerTypeToAgentProvider` is exactly what `resolveBackendContext` calls,
 * so the value here is identical to the one the caller resolved. Note that
 * `claude-runtime` collapses onto the `anthropic` AgentProvider, which is why
 * the connection has to be passed alongside it.
 */
export function filterAttachmentsForModelInput(
  attachments: FileAttachment[] | undefined,
  connection: LlmConnection | null,
  modelId: string,
): ModelAttachmentFilterResult {
  if (!attachments?.length) return { attachments, omittedImages: [] }
  if (!connection) return { attachments, omittedImages: [] }
  const capabilities = resolveComposerCapabilities({
    provider: providerTypeToAgentProvider(connection.providerType),
    connection,
    model: modelId,
  })
  if (capabilities.attachments.images !== 'no') return { attachments, omittedImages: [] }

  const modelAttachments: FileAttachment[] = []
  const omittedImages: FileAttachment[] = []

  for (const attachment of attachments) {
    if (isImageAttachment(attachment)) {
      omittedImages.push(attachment)
    } else {
      modelAttachments.push(attachment)
    }
  }

  return {
    attachments: modelAttachments.length > 0 ? modelAttachments : undefined,
    omittedImages,
  }
}
