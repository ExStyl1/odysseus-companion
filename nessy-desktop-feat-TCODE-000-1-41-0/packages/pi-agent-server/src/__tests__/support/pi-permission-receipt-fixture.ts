/**
 * Mints a VALID Pi permission receipt for a `pre_tool_use_request`, so a
 * real-server test can answer the permission round-trip instead of hanging on it.
 *
 * Why this exists as a fixture rather than fourteen literals at a call site:
 * `parseAndFreezePiPermissionReceipt` validates fourteen fields against an
 * expectation the subprocess builds from its own manifest, and until now
 * NOTHING exercised that round trip. `pi-runtime-protocol.test.ts`'s receipt
 * test asserts the SOURCE TEXT of the bridge, which cannot catch a shape that
 * parses and then mismatches. A test that wants to drive a tool through
 * permissions had to either build all fourteen by hand or mock the bridge away
 * — and mocking it away is what let a deferred built-in's permission path go
 * unmeasured until C7.
 *
 * TWO FIELDS THE REQUEST DOES NOT CARRY, and both are why this cannot be a
 * mechanical echo of the request:
 *
 *   - `bindingName` — the request sends `piName` and `semanticId` but not the
 *     binding name, and the two spellings diverge for `notebook_edit`/`NotebookEdit`
 *     and `stop_task`/`stopTask`. Resolved from the manifest.
 *   - `sandboxRequirement` — the descriptor's `sandboxProfile`, also manifest-only.
 *
 * AND ONE FIELD THAT LOOKS LIKE AN ECHO AND IS NOT: the request's
 * `manifestProvenance` is `[capabilityKey]` for a resolved capability and `[]`
 * for a built-in, while the receipt must carry the MANIFEST's provenance
 * rendered as `capabilityKey@generation` (`index.ts`, the `permissionBridge`'s
 * `manifest.provenance.map(...)`). Copying the request's value straight across
 * parses cleanly and then fails with `manifestProvenance mismatch`, which is
 * exactly the kind of near-miss this helper exists to stop each caller from
 * rediscovering.
 */
import type { PiExecutionManifestV2 } from '../../../../shared/src/agent/pi-harness/harness-manifest.ts'

/** The subset of `pre_tool_use_request` a receipt is minted from. */
export interface PiPreToolUseRequestLike {
  requestId: string
  piName: string
  semanticId: string
  surfaceVersion: number
  manifestResponseEpoch: number
  manifestGeneration: string
  manifestHash: string
  input?: Record<string, unknown>
  toolCallId?: string
}

export interface MintPiPermissionReceiptOptions {
  manifest: PiExecutionManifestV2
  request: PiPreToolUseRequestLike
  /** `permissionBridge` compares against `generationConfig.contextProfile ?? 'bare'`. */
  contextProfile?: 'normal' | 'bare'
  /** Defaults to allow. A `deny` receipt is just as valid and is how a test drives a refusal. */
  outcome?: 'allow' | 'deny'
  reason?: string
  /**
   * `decisionId`s are single-use — the bridge keeps a `consumedPermissionDecisionIds`
   * set and throws `Pi permission receipt replay` on a repeat. Callers that answer
   * more than one request MUST vary this; the default derives from `requestId`,
   * which is already unique per request.
   */
  decisionId?: string
}

export function isPiPreToolUseRequest(message: unknown): message is PiPreToolUseRequestLike & { type: string } {
  const value = message as { type?: unknown; requestId?: unknown; piName?: unknown }
  return value?.type === 'pre_tool_use_request'
    && typeof value.requestId === 'string'
    && typeof value.piName === 'string'
}

export function mintPiPermissionReceipt(options: MintPiPermissionReceiptOptions): Record<string, unknown> {
  const { manifest, request } = options
  const tool = manifest.tools.find(value => value.binding.piName === request.piName)
  if (!tool) {
    // Loud on purpose. A silent fallback here would answer with a receipt the
    // subprocess rejects, and the caller would read a permission mismatch where
    // the real fault is that the tool never reached the manifest.
    throw new Error(`No manifest tool for piName ${request.piName}; cannot mint a receipt`)
  }

  return {
    version: 1,
    sessionKey: {
      workspaceId: manifest.sessionKey.workspaceId,
      sessionId: manifest.sessionKey.sessionId,
    },
    binding: {
      provider: 'pi',
      surfaceVersion: request.surfaceVersion ?? manifest.surfaceVersion,
      piName: tool.binding.piName,
      bindingName: tool.binding.bindingName,
      semanticId: tool.descriptor.id,
      descriptorId: tool.binding.descriptorId,
    },
    manifest: {
      generation: request.manifestGeneration ?? manifest.snapshotGeneration,
      hash: request.manifestHash ?? manifest.manifestHash,
      provenance: manifest.provenance.map(value => `${value.capabilityKey}@${value.generation}`),
      responseEpoch: request.manifestResponseEpoch,
    },
    decisionId: options.decisionId ?? `decision-${request.requestId}`,
    outcome: options.outcome ?? 'allow',
    canonicalInput: { ...(request.input ?? {}) },
    contextProfile: options.contextProfile ?? 'bare',
    sandboxRequirement: tool.descriptor.sandboxProfile,
    ...(options.reason === undefined ? {} : { reason: options.reason }),
  }
}

/**
 * The reply envelope `handlePreToolUseResponse` expects on stdin.
 */
export function piPreToolUseResponse(
  options: MintPiPermissionReceiptOptions,
): { type: 'pre_tool_use_response'; requestId: string; receipt: Record<string, unknown> } {
  return {
    type: 'pre_tool_use_response',
    requestId: options.request.requestId,
    receipt: mintPiPermissionReceipt(options),
  }
}
