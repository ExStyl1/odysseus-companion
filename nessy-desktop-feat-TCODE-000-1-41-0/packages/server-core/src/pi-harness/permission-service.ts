import { randomUUID } from 'node:crypto'

import {
  parseAndFreezePiPermissionReceipt,
  type PiPermissionAuthorizationRequest,
  type PiPermissionReceiptV1,
  type PiPermissionServicePort,
} from '@nessy-agent/shared/agent/pi-harness/permission-receipt'

export interface PiPermissionApprovalResult {
  allowed: boolean
  canonicalInput?: Record<string, unknown>
  /**
   * P6.963 — the note the user attached to a DENIAL, which becomes the
   * receipt's `reason` and therefore the `pre_tool_use_response` reason the
   * model is told. `permissions.md#add-a-comment-when-you-answer-a-permission-prompt`,
   * verbatim: *"**No**: Claude Code sends your comment to Claude as the reason
   * for the denial, and Claude continues working."*
   *
   * Absent on every path that is not a person typing one — an approval, an
   * abort, a torn-down session — exactly as `ClaudeToolApprovalAnswer.comment`
   * is on the runtime where the same field is native.
   */
  comment?: string
}

/**
 * `authorize` NEVER fires hook events (R15). It used to carry an
 * `emitAutomationEvent` option and emit its own `PermissionRequest` and
 * `PermissionDenied`, which made the composed Pi path fire each event TWICE
 * per prompt — once from pi-agent's band with the documented input
 * (`tool_name`, `tool_input`, `permission_mode`, `permission_suggestions`;
 * hooks.md#permissionrequest) and once from here with neither `tool_input`
 * nor `permission_mode`, a discarded return value, and — on
 * `PermissionDenied` — the Pi binding spelling (`subject.piName`) instead of
 * the rule spelling. The band site is the one with the full documented input,
 * so it is the ONLY emitter; hooks.md § PermissionDenied also scopes that
 * event to auto-mode denials, which this emitter ignored (it fired for every
 * non-user deny, deny rules included).
 */
export interface PiPermissionServiceOptions {
  requestApproval?: (
    request: Extract<PiPermissionAuthorizationRequest['decision'], { outcome: 'ask' }>['request'] & {
      decisionId: string
      subject: PiPermissionAuthorizationRequest['subject']
      reason?: string
    },
  ) => Promise<PiPermissionApprovalResult>
  createDecisionId?: () => string
}

export function createPiPermissionService(options: PiPermissionServiceOptions): PiPermissionServicePort {
  return Object.freeze({
    async authorize(request: PiPermissionAuthorizationRequest): Promise<PiPermissionReceiptV1> {
      const decisionId = options.createDecisionId?.() ?? `pi-permission-${randomUUID()}`
      let outcome: 'allow' | 'deny' = request.decision.outcome === 'deny' ? 'deny' : 'allow'
      let reason = request.decision.outcome === 'allow' ? undefined : request.decision.reason
      let canonicalInput = request.decision.outcome === 'allow' && request.decision.canonicalInput
        ? request.decision.canonicalInput
        : request.canonicalInput

      if (request.decision.outcome === 'ask') {
        if (!options.requestApproval) {
          outcome = 'deny'
          reason = 'Interactive approval is unavailable.'
        } else {
          const approval = await options.requestApproval({
            ...request.decision.request,
            decisionId,
            subject: request.subject,
            ...(request.decision.reason ? { reason: request.decision.reason } : {}),
          })
          outcome = approval.allowed ? 'allow' : 'deny'
          // P6.963 — the user's own words when they wrote any, and the standing
          // sentence when they did not. Trimmed for the reason the card already
          // trims: whitespace is not a note, and a stray space must not become
          // the whole reason the model is given. This is the Pi arm of the
          // answerNote capability (renamed by P6.864, which widened the field to the
          // approval half); on claude the same substitution is native
          // (`PermissionResult.deny.message`).
          reason = approval.allowed
            ? undefined
            : approval.comment?.trim() || 'Permission denied by user.'
          if (approval.allowed && approval.canonicalInput) {
            try {
              canonicalInput = request.canonicalizeApprovedInput(approval.canonicalInput)
            } catch (error) {
              outcome = 'deny'
              reason = error instanceof Error ? error.message : String(error)
            }
          }
        }
      }

      return parseAndFreezePiPermissionReceipt({
        version: 1,
        sessionKey: request.subject.sessionKey,
        binding: {
          provider: request.subject.provider,
          surfaceVersion: request.subject.surfaceVersion,
          piName: request.subject.piName,
          bindingName: request.subject.bindingName,
          semanticId: request.subject.semanticId,
          descriptorId: request.subject.descriptorId,
        },
        manifest: {
          generation: request.subject.manifestGeneration,
          hash: request.subject.manifestHash,
          provenance: request.subject.manifestProvenance,
          responseEpoch: request.subject.responseEpoch,
        },
        decisionId,
        outcome,
        canonicalInput,
        contextProfile: request.subject.contextProfile,
        sandboxRequirement: request.subject.sandboxRequirement,
        ...(reason ? { reason } : {}),
        ...(request.decision.additionalContext ? { additionalContext: request.decision.additionalContext } : {}),
      }, request.subject)
    },
  })
}
