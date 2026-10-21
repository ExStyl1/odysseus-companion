import type { SessionKey } from '../../sessions/session-key.ts'
import type { AgentProvider } from '../backend/types.ts'
import { AGENT_PROVIDERS } from '../backend/runtime-vocabulary.ts'

export type PiContextProfile = 'normal' | 'bare'
export type PiSandboxRequirement = 'workspace' | 'host' | 'none'

export interface PiPermissionBindingIdentity {
  /**
   * P6.761 — the runtime the subject actually ran on.
   *
   * This was the LITERAL `'pi'` and the whole receipt family is named for the
   * Pi harness, so the field read as a constant rather than a fact. P6.590 then
   * assigned the child-session port on claude and codex too, and the
   * `agent-admission` receipt an operator reads started naming the wrong
   * runtime for a claude or codex agent hook. Harmless in telemetry —
   * `emitPiTelemetry` returns early off the resolved provider, so nothing was
   * EXPORTED wrong — and wrong in the audit trail, which is the artefact that
   * has to survive being read a year later.
   *
   * Typed as {@link AgentProvider} rather than a hand-written union so a fifth
   * runtime cannot appear in the vocabulary and be silently unrepresentable
   * here.
   */
  provider: AgentProvider
  surfaceVersion: number
  piName: string
  bindingName: string
  semanticId: string
  descriptorId: string
}

export interface PiPermissionManifestIdentity {
  generation: string
  hash: string
  provenance: readonly string[]
  responseEpoch: number
}

export interface PiPermissionReceiptV1 {
  version: 1
  sessionKey: SessionKey
  binding: PiPermissionBindingIdentity
  manifest: PiPermissionManifestIdentity
  decisionId: string
  outcome: 'allow' | 'deny'
  canonicalInput: Readonly<Record<string, unknown>>
  contextProfile: PiContextProfile
  sandboxRequirement: PiSandboxRequirement
  reason?: string
  additionalContext?: string
}

export interface PiPermissionReceiptExpectation {
  sessionKey: SessionKey
  /** P6.761 — see {@link PiPermissionBindingIdentity.provider}. */
  provider: AgentProvider
  surfaceVersion: number
  piName: string
  bindingName: string
  semanticId: string
  descriptorId: string
  manifestGeneration: string
  manifestHash: string
  manifestProvenance: readonly string[]
  responseEpoch: number
  contextProfile: PiContextProfile
  sandboxRequirement: PiSandboxRequirement
}

export interface PiPermissionSubject extends PiPermissionReceiptExpectation {
  contextProfile: PiContextProfile
}

export type PiPermissionPolicyDecision =
  | { outcome: 'allow'; canonicalInput?: Record<string, unknown>; additionalContext?: string }
  | { outcome: 'deny'; reason: string; additionalContext?: string }
  | {
      outcome: 'ask'
      reason?: string
      additionalContext?: string
      request: {
        toolName: string
        type: string
        description: string
        command?: string
        appName?: string
        impact?: string
        requiresSystemPrompt?: boolean
        rememberForMinutes?: number
        commandHash?: string
        approvalTtlSeconds?: number
        /**
         * P6.202 clause (3) — the first-read-outside card's payload, carried
         * through the Pi authorization seam unchanged. Optional and inert: a
         * decision that does not set it produces the same card it always did.
         */
        outsideWorkingDirectoryRead?: import('@nessy-agent/core/types').FirstOutsideReadPermissionRequest
        /** P6.863 — the mode alone raised this prompt, so a mode change removes it. */
        modePrompt?: true
        /**
         * F1.913 — the card offers no Always Allow (the wire field of the same
         * name; `SessionManager.requestPiToolApproval` forwards it). Set on
         * the readable-rule `ask` cards, whose rule outranks any grant a click
         * could save.
         */
        noAlwaysAllow?: true
      }
    }

export interface PiPermissionAuthorizationRequest {
  subject: PiPermissionSubject
  canonicalInput: Record<string, unknown>
  decision: PiPermissionPolicyDecision
  canonicalizeApprovedInput(input: Record<string, unknown>): Record<string, unknown>
}

export interface PiPermissionServicePort {
  authorize(request: PiPermissionAuthorizationRequest): Promise<PiPermissionReceiptV1>
}

const RECEIPT_KEYS = new Set([
  'version', 'sessionKey', 'binding', 'manifest', 'decisionId', 'outcome', 'canonicalInput',
  'contextProfile', 'sandboxRequirement', 'reason', 'additionalContext',
])
const SESSION_KEYS = new Set(['workspaceId', 'sessionId'])
const BINDING_KEYS = new Set(['provider', 'surfaceVersion', 'piName', 'bindingName', 'semanticId', 'descriptorId'])
const MANIFEST_KEYS = new Set(['generation', 'hash', 'provenance', 'responseEpoch'])

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid Pi permission ${label}`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown) throw new Error(`Unknown Pi permission ${label} field: ${unknown}`)
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid Pi permission ${label}`)
  return value
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`Invalid Pi permission ${label}`)
  return value as number
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function parseAndFreezePiPermissionReceipt(
  value: unknown,
  expected?: PiPermissionReceiptExpectation,
): PiPermissionReceiptV1 {
  const cloned = structuredClone(value)
  const root = record(cloned, 'receipt')
  exactKeys(root, RECEIPT_KEYS, 'receipt')
  if (root.version !== 1) throw new Error('Unsupported Pi permission receipt version')

  const sessionKey = record(root.sessionKey, 'SessionKey')
  exactKeys(sessionKey, SESSION_KEYS, 'SessionKey')
  const binding = record(root.binding, 'binding')
  exactKeys(binding, BINDING_KEYS, 'binding')
  const manifest = record(root.manifest, 'manifest')
  exactKeys(manifest, MANIFEST_KEYS, 'manifest')
  const canonicalInput = record(root.canonicalInput, 'canonicalInput')
  const provenance = manifest.provenance
  if (!Array.isArray(provenance) || provenance.some(value => typeof value !== 'string')) {
    throw new Error('Invalid Pi permission manifest provenance')
  }
  // P6.761 — checked against the VOCABULARY, not against the literal `'pi'`.
  // Still a closed check: an unknown provider is refused exactly as it was, so
  // a corrupt or forged receipt cannot name a runtime that does not exist.
  if (typeof binding.provider !== 'string' || !(AGENT_PROVIDERS as readonly string[]).includes(binding.provider)) {
    throw new Error('Invalid Pi permission provider')
  }
  if (root.outcome !== 'allow' && root.outcome !== 'deny') throw new Error('Invalid Pi permission outcome')
  if (root.contextProfile !== 'normal' && root.contextProfile !== 'bare') throw new Error('Invalid Pi permission contextProfile')
  if (!['workspace', 'host', 'none'].includes(String(root.sandboxRequirement))) {
    throw new Error('Invalid Pi permission sandboxRequirement')
  }
  if (root.reason !== undefined && typeof root.reason !== 'string') throw new Error('Invalid Pi permission reason')
  if (root.additionalContext !== undefined && typeof root.additionalContext !== 'string') {
    throw new Error('Invalid Pi permission additionalContext')
  }
  const receipt: PiPermissionReceiptV1 = {
    version: 1,
    sessionKey: {
      workspaceId: string(sessionKey.workspaceId, 'workspaceId'),
      sessionId: string(sessionKey.sessionId, 'sessionId'),
    },
    binding: {
      provider: binding.provider as AgentProvider,
      surfaceVersion: integer(binding.surfaceVersion, 'surfaceVersion'),
      piName: string(binding.piName, 'piName'),
      bindingName: string(binding.bindingName, 'bindingName'),
      semanticId: string(binding.semanticId, 'semanticId'),
      descriptorId: string(binding.descriptorId, 'descriptorId'),
    },
    manifest: {
      generation: string(manifest.generation, 'manifest generation'),
      hash: string(manifest.hash, 'manifest hash'),
      provenance: [...provenance] as string[],
      responseEpoch: integer(manifest.responseEpoch, 'responseEpoch'),
    },
    decisionId: string(root.decisionId, 'decisionId'),
    outcome: root.outcome,
    canonicalInput: { ...canonicalInput },
    contextProfile: root.contextProfile,
    sandboxRequirement: root.sandboxRequirement as PiSandboxRequirement,
    ...(root.reason === undefined ? {} : { reason: root.reason }),
    ...(root.additionalContext === undefined ? {} : { additionalContext: root.additionalContext }),
  }

  if (expected) {
    const mismatches: Array<[boolean, string]> = [
      [receipt.sessionKey.workspaceId !== expected.sessionKey.workspaceId, 'workspaceId'],
      [receipt.sessionKey.sessionId !== expected.sessionKey.sessionId, 'sessionId'],
      [receipt.binding.provider !== expected.provider, 'provider'],
      [receipt.binding.surfaceVersion !== expected.surfaceVersion, 'surfaceVersion'],
      [receipt.binding.piName !== expected.piName, 'piName'],
      [receipt.binding.bindingName !== expected.bindingName, 'bindingName'],
      [receipt.binding.semanticId !== expected.semanticId, 'semanticId'],
      [receipt.binding.descriptorId !== expected.descriptorId, 'descriptorId'],
      [receipt.manifest.generation !== expected.manifestGeneration, 'manifestGeneration'],
      [receipt.manifest.hash !== expected.manifestHash, 'manifestHash'],
      [!sameStrings(receipt.manifest.provenance, expected.manifestProvenance), 'manifestProvenance'],
      [receipt.manifest.responseEpoch !== expected.responseEpoch, 'responseEpoch'],
      [receipt.contextProfile !== expected.contextProfile, 'contextProfile'],
      [receipt.sandboxRequirement !== expected.sandboxRequirement, 'sandboxRequirement'],
    ]
    const mismatch = mismatches.find(([failed]) => failed)
    if (mismatch) throw new Error(`Pi permission receipt ${mismatch[1]} mismatch`)
  }
  return deepFreeze(receipt)
}
