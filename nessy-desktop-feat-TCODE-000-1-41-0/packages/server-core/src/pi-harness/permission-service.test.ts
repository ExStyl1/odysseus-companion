import { describe, expect, test } from 'bun:test'

import { createPiPermissionService, type PiPermissionServiceOptions } from './permission-service.ts'
import {
  parseAndFreezePiPermissionReceipt,
  type PiPermissionAuthorizationRequest,
} from '@nessy-agent/shared/agent/pi-harness/permission-receipt'

function authorization(
  decision: PiPermissionAuthorizationRequest['decision'],
  overrides: Partial<PiPermissionAuthorizationRequest> = {},
): PiPermissionAuthorizationRequest {
  return {
    subject: {
      sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      provider: 'pi',
      surfaceVersion: 1,
      piName: 'bash',
      bindingName: 'bash',
      semanticId: 'bash',
      descriptorId: 'bash',
      manifestGeneration: 'generation-1',
      manifestHash: 'hash-1',
      manifestProvenance: [],
      responseEpoch: 3,
      contextProfile: 'normal',
      sandboxRequirement: 'workspace',
    },
    canonicalInput: { command: 'echo original' },
    decision,
    canonicalizeApprovedInput: input => ({ ...input }),
    ...overrides,
  }
}

/**
 * A forwarder in the removed `emitAutomationEvent` option's shape. `authorize`
 * must never invoke one, however it is smuggled in (R15): the band site in
 * pi-agent is the ONLY `PermissionRequest`/`PermissionDenied` emitter, because
 * it is the one with the documented input. Passing it through a cast keeps
 * this pin biting if the option — and its emissions — are ever re-added.
 */
function legacyEmitterOptions(
  events: string[],
  options: PiPermissionServiceOptions,
): PiPermissionServiceOptions {
  return {
    ...options,
    emitAutomationEvent: async (event: string) => { events.push(event) },
  } as PiPermissionServiceOptions
}

describe('Pi permission service', () => {
  test('is the sole approval and immutable receipt composer, and emits no hook events', async () => {
    const events: string[] = []
    const service = createPiPermissionService(legacyEmitterOptions(events, {
      createDecisionId: () => 'decision-1',
      requestApproval: async request => {
        expect(request.subject.semanticId).toBe('bash')
        return { allowed: true, canonicalInput: { command: 'echo approved' } }
      },
    }))

    const receipt = await service.authorize(authorization({
      outcome: 'ask',
      reason: 'Confirm command',
      request: { toolName: 'Bash', type: 'bash', description: 'Confirm command' },
    }))

    expect(receipt).toMatchObject({
      decisionId: 'decision-1',
      outcome: 'allow',
      canonicalInput: { command: 'echo approved' },
    })
    expect(Object.isFrozen(receipt)).toBe(true)
    // The band in pi-agent already fired PermissionRequest for this prompt;
    // a second emission from here is the R15 defect.
    expect(events).toEqual([])
  })

  test('fails closed without approval, with no PermissionDenied of its own', async () => {
    const events: string[] = []
    const service = createPiPermissionService(legacyEmitterOptions(events, {
      createDecisionId: () => 'decision-denied',
    }))
    const receipt = await service.authorize(authorization({
      outcome: 'ask',
      reason: 'Approval required',
      request: { toolName: 'Bash', type: 'bash', description: 'Approval required' },
    }))

    expect(receipt).toMatchObject({ outcome: 'deny', decisionId: 'decision-denied' })
    // hooks.md § PermissionDenied scopes the event to auto-mode classifier
    // denials; pi-agent's `permissionDeniedEligible()` owns that decision.
    expect(events).toEqual([])
  })

  test('never asks for an existing deny floor, and never emits for it either', async () => {
    let approvals = 0
    const events: string[] = []
    const service = createPiPermissionService(legacyEmitterOptions(events, {
      createDecisionId: () => 'decision-floor',
      requestApproval: async () => { approvals += 1; return { allowed: true } },
    }))
    const receipt = await service.authorize(authorization({ outcome: 'deny', reason: 'denied path' }))
    expect(receipt).toMatchObject({ outcome: 'deny', canonicalInput: { command: 'echo original' } })
    expect(approvals).toBe(0)
    // A deny-rule denial must never fire PermissionDenied (hooks.md: "when a
    // `deny` rule matches" the event does not run).
    expect(events).toEqual([])
  })

  test('a human refusing the prompt does not fire PermissionDenied', async () => {
    // hooks.md § PermissionDenied: the event "doesn't run when you manually deny
    // a permission dialog". A human saying no is an answer, not a policy
    // decision a hook gets to retry.
    const events: string[] = []
    const service = createPiPermissionService(legacyEmitterOptions(events, {
      createDecisionId: () => 'decision-user-denied',
      requestApproval: async () => ({ allowed: false }),
    }))

    const receipt = await service.authorize(authorization({
      outcome: 'ask',
      reason: 'Approval required',
      request: { toolName: 'Bash', type: 'bash', description: 'Approval required' },
    }))

    expect(receipt).toMatchObject({ outcome: 'deny', reason: 'Permission denied by user.' })
    expect(events).toEqual([])
  })
})

/**
 * P6.761 — the receipt records the runtime the subject actually ran on.
 *
 * The whole receipt family is named for the Pi harness, so `provider` was the
 * LITERAL `'pi'` and read as a constant rather than a fact. P6.590 assigned the
 * child-session port on claude and codex, and the `agent-admission` receipt an
 * operator reads then named the wrong runtime for a claude or codex agent hook:
 * harmless in telemetry (`emitPiTelemetry` returns early off the same resolved
 * provider, so nothing was EXPORTED wrong) and wrong in the audit trail, which
 * is the artefact that has to survive being read a year later.
 *
 * One row per runtime, as the row asks — and the fourth vocabulary member with
 * them, because a check that covered only the three anyone was thinking about
 * is how the next runtime inherits a silent default.
 */
describe('P6.761 · the receipt carries the subject’s real runtime', () => {
  for (const provider of ['pi', 'anthropic', 'codex-runtime', 'nestor-cloud-agent'] as const) {
    test(`round-trips ${provider} through authorize and its own expectation`, async () => {
      const service = createPiPermissionService({ createDecisionId: () => 'decision-provider' })
      const subject = { ...authorization({ outcome: 'allow' }).subject, provider }
      const receipt = await service.authorize({ ...authorization({ outcome: 'allow' }), subject })
      expect(receipt.binding.provider).toBe(provider)
      // The expectation check compares receipt against subject, so a receipt
      // stamped with a constant would fail HERE for three of the four.
      expect(() => parseAndFreezePiPermissionReceipt(structuredClone(receipt), subject)).not.toThrow()
    })
  }

  // NEGATIVE — still a CLOSED check. Widening the field must not turn it into
  // an open string: a corrupt or forged receipt cannot name a runtime that does
  // not exist.
  test('a provider outside the vocabulary is still refused', async () => {
    const service = createPiPermissionService({ createDecisionId: () => 'decision-provider' })
    const receipt = await service.authorize(authorization({ outcome: 'allow' }))
    for (const bad of ['', 'PI', 'openai', 'claude', 42, null, undefined]) {
      const forged = { ...structuredClone(receipt), binding: { ...receipt.binding, provider: bad } }
      expect(() => parseAndFreezePiPermissionReceipt(forged), String(bad))
        .toThrow(/Invalid Pi permission provider/)
    }
  })

  // NEGATIVE — a receipt whose provider disagrees with the expectation is a
  // MISMATCH, not a pass: that is the arm that makes the field load-bearing.
  test('a receipt whose runtime disagrees with the expectation is refused', async () => {
    const service = createPiPermissionService({ createDecisionId: () => 'decision-provider' })
    const subject = { ...authorization({ outcome: 'allow' }).subject, provider: 'anthropic' as const }
    const receipt = await service.authorize({ ...authorization({ outcome: 'allow' }), subject })
    expect(() => parseAndFreezePiPermissionReceipt(
      structuredClone(receipt),
      { ...subject, provider: 'pi' },
    )).toThrow()
  })
})

/**
 * P6.963 — the denial NOTE reaches the model on Pi too.
 *
 * `permissions.md#add-a-comment-when-you-answer-a-permission-prompt`, verbatim:
 * *"**No**: Claude Code sends your comment to Claude as the reason for the
 * denial, and Claude continues working."* On claude that reason is native
 * (`PermissionResult.deny.message`); Pi has no native prompt at all, so the note
 * travels the host route it already has — this service writes the receipt's
 * `reason`, and pi-agent puts that `reason` on the `pre_tool_use_response` the
 * subprocess hands back to the model.
 *
 * P6.951 left this arm OFF for exactly the reason these cases now refute: the
 * reason was written from the policy decision and never from the card's answer.
 */
describe('P6.963 · a user denial carries the note', () => {
  test('the note becomes the receipt reason, in the user’s own words', async () => {
    const service = createPiPermissionService({
      createDecisionId: () => 'decision-noted',
      requestApproval: async () => ({ allowed: false, comment: '  use the staging bucket instead  ' }),
    })
    const receipt = await service.authorize(authorization({
      outcome: 'ask',
      reason: 'Approval required',
      request: { toolName: 'Bash', type: 'bash', description: 'Approval required' },
    }))
    expect(receipt.outcome).toBe('deny')
    // Trimmed, for the reason the card trims: whitespace is not a note.
    expect(receipt.reason).toBe('use the staging bucket instead')
  })

  // NEGATIVE — no note is the ordinary Deny, and it must be byte-identical to
  // one from before this row. A blank field is not a note either: the reveal is
  // offered on every ordinary card, so a stray space would otherwise become the
  // whole reason the model is given.
  for (const [label, comment] of [
    ['nothing typed', undefined],
    ['whitespace only', '   '],
    ['an empty string', ''],
  ] as const) {
    test(`falls back to the standing sentence when the answer carried ${label}`, async () => {
      const service = createPiPermissionService({
        createDecisionId: () => 'decision-unnoted',
        requestApproval: async () => ({ allowed: false, ...(comment === undefined ? {} : { comment }) }),
      })
      const receipt = await service.authorize(authorization({
        outcome: 'ask',
        reason: 'Approval required',
        request: { toolName: 'Bash', type: 'bash', description: 'Approval required' },
      }))
      expect(receipt.reason).toBe('Permission denied by user.')
    })
  }

  // NEGATIVE — an APPROVAL carries no reason, note or not. The page gives the
  // Yes half a different delivery ("sends your comment to Claude after the
  // result"), which no runtime's approval branch has a field for; turning a
  // comment into an allow-receipt reason here would invent one.
  test('an approval is unchanged even when a comment rides along', async () => {
    const service = createPiPermissionService({
      createDecisionId: () => 'decision-approved',
      requestApproval: async () => ({ allowed: true, comment: 'go ahead' }),
    })
    const receipt = await service.authorize(authorization({
      outcome: 'ask',
      reason: 'Approval required',
      request: { toolName: 'Bash', type: 'bash', description: 'Approval required' },
    }))
    expect(receipt.outcome).toBe('allow')
    expect(receipt.reason).toBeUndefined()
  })
})
