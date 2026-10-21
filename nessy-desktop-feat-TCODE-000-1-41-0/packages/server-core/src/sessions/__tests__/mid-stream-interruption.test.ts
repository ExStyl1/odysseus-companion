/**
 * U5's second half. The flag decides whether the NEXT turn opens by telling the
 * model its previous reply was cut off, so getting it wrong on the default path
 * misinforms every queued follow-up on a gateway connection.
 *
 * The second half of the second half (this row): "steer" stopped implying
 * "aborted". `CodexAgent.redirect` returns `false` WITHOUT interrupting, and
 * codex's default flipped to `'steer'` in the same change, so the configured
 * behaviour alone stamped the flag on a turn nothing had touched. The classifier
 * now asks the backend, and the backends are checked ONE BY ONE against what
 * their `redirect()` actually does — a single generic case is what let the
 * divergence in.
 */
import { describe, expect, it } from 'bun:test'
import {
  backendInterruptsOnFailedSteer,
  canSteerTextPayload,
  effectiveMidStreamBehavior,
  queuedSendInterruptedTurn,
  queueHoldsUnsteerablePayload,
} from '../mid-stream-interruption'
import { defaultMidStreamBehavior, otherMidStreamBehavior } from '@nessy-agent/shared/config/llm-connections'
import { ClaudeAgent } from '../../../../shared/src/agent/claude-agent.ts'
import { PiAgent } from '../../../../shared/src/agent/pi-agent.ts'
import { CodexAgent } from '../../../../shared/src/agent/codex-agent.ts'
import { NestorCloudAgent } from '../../../../shared/src/agent/nestor-cloud-agent.ts'

describe('U5 mid-stream interruption classification', () => {
  it('a failed steer on an ABORTING backend DID interrupt', () => {
    expect(queuedSendInterruptedTurn('steer', true)).toBe(true)
  })

  it('a failed steer on a backend that did not abort interrupted NOTHING', () => {
    // The new door: codex's `false` means "no turn to steer" and leaves the
    // thread running. Saying "interrupted" here is the same lie as the queue
    // path's, arriving through the steer branch.
    expect(queuedSendInterruptedTurn('steer', false)).toBe(false)
  })

  it('a queued send did NOT — redirect is never called and the turn finishes', () => {
    // The original defect: this used to be true, so the agent was told its own
    // completed response had been interrupted. `queue` is the default on every
    // gateway connection, which is why it mattered on the ordinary path. Both
    // halves must hold, so the backend's answer cannot resurrect it.
    expect(queuedSendInterruptedTurn('queue', false)).toBe(false)
    expect(queuedSendInterruptedTurn('queue', true)).toBe(false)
  })

  it('no agent means redirect was never called on anything', () => {
    expect(backendInterruptsOnFailedSteer(null)).toBe(false)
    expect(backendInterruptsOnFailedSteer(undefined)).toBe(false)
  })
})

/**
 * ONE ROW PER BACKEND, and each row OBSERVES `redirect()`'s fallback rather than
 * trusting the declaration next to it.
 *
 * `Object.create(prototype)` gives a real method on a bare object: no
 * constructor, no runtime, no subprocess. Every field these fallbacks read is
 * absent and therefore falsy, which IS the fallback branch — "not streaming" for
 * Claude and Pi, "no active turn" for codex — and `forceAbort`/`debug` are stubbed
 * on the instance so the only thing measured is whether the backend reached for
 * the abort.
 */
describe('backendInterruptsOnFailedSteer — measured against each backend', () => {
  interface Row {
    name: string
    prototype: object
    /**
     * Does this backend's `redirect()` fallback actually abort the turn? Measured
     * below; stated here so a row cannot pass by tautology.
     */
    aborts: boolean
    /** What the classifier reads. Equal to `aborts` except where noted. */
    declared: boolean
    note?: string
  }

  const rows: Row[] = [
    { name: 'ClaudeAgent', prototype: ClaudeAgent.prototype, aborts: true, declared: true },
    { name: 'PiAgent', prototype: PiAgent.prototype, aborts: true, declared: true },
    { name: 'CodexAgent', prototype: CodexAgent.prototype, aborts: false, declared: false },
    {
      name: 'NestorCloudAgent',
      prototype: NestorCloudAgent.prototype,
      aborts: false,
      // THE GAP THIS ROW RECORDED IS NOW CLOSED, and the row it left behind is
      // the reason it could be: it predicted its own resolution — "when that
      // lands, this row's `declared` becomes `false`". Nestor's `redirect` is a
      // bare `return false` that aborts nothing, so reading `true` off the
      // silent-backend default was the same lie the whole module exists to
      // remove, one backend over. It now declares
      // `redirectFallbackInterruptsTurn()` and the member lives on the
      // `AgentBackend` contract, so the next backend whose fallback is inert has
      // somewhere to say so instead of inheriting a guess. Reachable only if a
      // user set that connection to `'steer'` in Settings — which is a narrow
      // door, not a closed one.
      declared: false,
    },
  ]

  for (const row of rows) {
    it(`${row.name}: redirect's fallback ${row.aborts ? 'aborts' : 'aborts nothing'}, and the classifier reads ${row.declared}`, () => {
      const agent = Object.create(row.prototype) as {
        redirect: (message: string) => boolean
        forceAbort: (reason: unknown) => void
        debug: (message: string) => void
      }
      let aborted = false
      agent.forceAbort = () => { aborted = true }
      agent.debug = () => undefined

      // Every backend's fallback returns false — that is the shared contract.
      expect(agent.redirect('a correction typed mid-turn')).toBe(false)
      expect(aborted).toBe(row.aborts)

      expect(backendInterruptsOnFailedSteer(agent)).toBe(row.declared)
      expect(queuedSendInterruptedTurn('steer', backendInterruptsOnFailedSteer(agent)))
        .toBe(row.declared)
    })
  }

  it('POSITIVE CONTROL: the declaration is read off the backend, not guessed', () => {
    // Without this, all four rows above would still pass against a classifier
    // that ignored its argument and returned a constant.
    expect(rows.map(r => r.declared)).toEqual([true, true, false, false])
    expect(new Set(rows.map(r => r.declared)).size).toBe(2)
  })
})

/**
 * P6.480 — the one-message steer-or-queue override.
 *
 * The override is one line; the PRECEDENCE around it is the row. Two of the
 * three inputs must beat it, and a chord that could overrule either would be a
 * shortcut that silently downgrades a workflow command to prose or names an
 * in-flight turn that does not exist yet.
 */
describe('P6.480 — the one-message follow-up override', () => {
  const base = { workflowInvocation: false, followUpDuringSendStart: false, steerableTextPayload: true, unsteerableQueuedAhead: false, stopRequested: false } as const

  it('uses the connection default when no override is sent — THE BASELINE', () => {
    // Every client that does not send the field, and every send that is not the
    // chord. If this moved, shipping the field would change behaviour for
    // everyone who never pressed anything.
    expect(effectiveMidStreamBehavior({ ...base, connectionDefault: 'queue' })).toBe('queue')
    expect(effectiveMidStreamBehavior({ ...base, connectionDefault: 'steer' })).toBe('steer')
    expect(effectiveMidStreamBehavior({ ...base, connectionDefault: 'queue', override: undefined }))
      .toBe('queue')
  })

  it('steers a queueing connection for ONE message, and queues a steering one', () => {
    // The row's own `done_means`, both directions. One direction alone would
    // pass for an implementation that always steers.
    expect(effectiveMidStreamBehavior({ ...base, connectionDefault: 'queue', override: 'steer' }))
      .toBe('steer')
    expect(effectiveMidStreamBehavior({ ...base, connectionDefault: 'steer', override: 'queue' }))
      .toBe('queue')
  })

  it('a WORKFLOW invocation is queued whatever the chord says', () => {
    // Steering forwards text into the current model turn and discards the
    // host-resolved structured payload. A shortcut must not be able to do that.
    expect(effectiveMidStreamBehavior({
      connectionDefault: 'steer', override: 'steer', workflowInvocation: true, followUpDuringSendStart: false, steerableTextPayload: true, unsteerableQueuedAhead: false, stopRequested: false,
    })).toBe('queue')
  })

  it('a follow-up racing send-start is queued whatever the chord says', () => {
    // There is no in-flight turn to steer into yet, so the override would name
    // a destination that does not exist.
    expect(effectiveMidStreamBehavior({
      connectionDefault: 'steer', override: 'steer', workflowInvocation: false, followUpDuringSendStart: true, steerableTextPayload: true, unsteerableQueuedAhead: false, stopRequested: false,
    })).toBe('queue')
  })

  it('the chord asks for THE OTHER behaviour, and inverting twice is identity', () => {
    expect(otherMidStreamBehavior('steer')).toBe('queue')
    expect(otherMidStreamBehavior('queue')).toBe('steer')
    // The property the composer relies on: pressing the chord on a connection
    // whose default has just been flipped asks for the original again.
    expect(otherMidStreamBehavior(otherMidStreamBehavior('steer'))).toBe('steer')
  })

  it('the override does not change what a failed steer REPORTS', () => {
    // The neighbouring classifier reads the EFFECTIVE behaviour, so an override
    // that steered must report exactly as a connection that steers — and one
    // that queued must report nothing. Asserted because the two functions now
    // share an input and a wrong wiring would be invisible from either alone.
    const steeredByOverride = effectiveMidStreamBehavior({ ...base, connectionDefault: 'queue', override: 'steer' })
    expect(queuedSendInterruptedTurn(steeredByOverride, true)).toBe(true)
    const queuedByOverride = effectiveMidStreamBehavior({ ...base, connectionDefault: 'steer', override: 'queue' })
    expect(queuedSendInterruptedTurn(queuedByOverride, true)).toBe(false)
  })
})

/**
 * F1.244 — the payload half of the same decision.
 *
 * `redirect()` is a text door on every runtime, so a send whose payload the text
 * cannot carry is queued, and it outranks the one-message chord for the reason
 * a workflow invocation does. The option half is an ALLOWLIST read off this
 * product's `SendMessageOptions`, conservative for anything not on it — the
 * shape of craft-agents-oss v0.13.4's `canSteerTextPayload` (Apache-2.0).
 */
describe('F1.244 — only a text-only payload may be steered', () => {
  const FILE = [{ type: 'image', name: 'a.png' }]
  const STORED = [{ id: 'stored-1', storedPath: '/tmp/a.png' }]

  it('text alone — with or without the presentation options the composer sends — is steerable', () => {
    expect(canSteerTextPayload()).toBe(true)
    expect(canSteerTextPayload([], [], undefined)).toBe(true)
    // Exactly the object `App.tsx` builds for an ordinary composer send.
    expect(canSteerTextPayload(undefined, undefined, {
      skillSlugs: ['commit'], badges: [], optimisticMessageId: 'opt-1', origin: 'human', midStreamOverride: 'steer',
    })).toBe(true)
    // An option present but undefined carries nothing.
    expect(canSteerTextPayload(undefined, undefined, { outputSchema: undefined })).toBe(true)
  })

  it('files, in either form, are not', () => {
    expect(canSteerTextPayload(FILE, undefined)).toBe(false)
    expect(canSteerTextPayload(undefined, STORED)).toBe(false)
    expect(canSteerTextPayload(FILE, STORED, { origin: 'human' })).toBe(false)
  })

  it('a model-affecting option, and any option not on the list, is not', () => {
    expect(canSteerTextPayload(undefined, undefined, { outputSchema: { type: 'object' } })).toBe(false)
    expect(canSteerTextPayload(undefined, undefined, { someFutureOption: false })).toBe(false)
  })

  it('a payload the text door cannot carry is queued — above the chord, below nothing it contradicts', () => {
    const attachments = { workflowInvocation: false, followUpDuringSendStart: false, steerableTextPayload: false, unsteerableQueuedAhead: false, stopRequested: false } as const
    expect(effectiveMidStreamBehavior({ ...attachments, connectionDefault: 'steer' })).toBe('queue')
    expect(effectiveMidStreamBehavior({ ...attachments, connectionDefault: 'steer', override: 'steer' })).toBe('queue')
    // And, being queued, a turn it never touched is not reported as interrupted.
    expect(queuedSendInterruptedTurn(
      effectiveMidStreamBehavior({ ...attachments, connectionDefault: 'steer' }), true,
    )).toBe(false)
  })

  it('CONTROL — a queueing connection (nestor-cloud-agent\'s default) is unchanged either way', () => {
    const text = { workflowInvocation: false, followUpDuringSendStart: false, steerableTextPayload: true, unsteerableQueuedAhead: false, stopRequested: false } as const
    const nestor = defaultMidStreamBehavior('nestor-cloud-agent')
    expect(nestor).toBe('queue')
    expect(effectiveMidStreamBehavior({ ...text, connectionDefault: nestor })).toBe('queue')
    expect(effectiveMidStreamBehavior({ ...text, connectionDefault: nestor, steerableTextPayload: false })).toBe('queue')
    // And the text-only steer path is exactly what it was.
    expect(effectiveMidStreamBehavior({ ...text, connectionDefault: 'steer' })).toBe('steer')
  })
})

/**
 * F1.338 — FIFO behind a queued payload that cannot be steered (DECIDED by the
 * controller 2026-09-23: order is what the user typed). Rule 3b, above the chord.
 */
describe('F1.338 — a steerable send queues behind an unsteerable queued row', () => {
  const text = { workflowInvocation: false, followUpDuringSendStart: false, steerableTextPayload: true, stopRequested: false } as const
  const FILE = [{ type: 'image', name: 'a.png' }]

  it('a queued attachment or workflow row holds a later text send back, whatever the chord says', () => {
    expect(effectiveMidStreamBehavior({ ...text, unsteerableQueuedAhead: true, connectionDefault: 'steer' })).toBe('queue')
    expect(effectiveMidStreamBehavior({ ...text, unsteerableQueuedAhead: true, connectionDefault: 'steer', override: 'steer' })).toBe('queue')
    // Queued by order: the running turn was not disturbed.
    expect(queuedSendInterruptedTurn(
      effectiveMidStreamBehavior({ ...text, unsteerableQueuedAhead: true, connectionDefault: 'steer' }), true,
    )).toBe(false)
  })

  it('the queue predicate reads the same two tests the send passes', () => {
    expect(queueHoldsUnsteerablePayload([])).toBe(false)
    expect(queueHoldsUnsteerablePayload([{ options: { origin: 'human' } }])).toBe(false)
    expect(queueHoldsUnsteerablePayload([{}, { attachments: FILE }])).toBe(true)
    expect(queueHoldsUnsteerablePayload([{ storedAttachments: [{ id: 's' }] }])).toBe(true)
    expect(queueHoldsUnsteerablePayload([{ options: { outputSchema: { type: 'object' } } }])).toBe(true)
    expect(queueHoldsUnsteerablePayload([{ workflowInvocation: { name: 'wf' } }])).toBe(true)
  })

  it('CONTROL — with nothing unsteerable ahead, a text-only send still steers', () => {
    expect(effectiveMidStreamBehavior({ ...text, unsteerableQueuedAhead: false, connectionDefault: 'steer' })).toBe('steer')
  })
})

describe('F1.335 — rule 2b: a send after Stop is queued (DECIDED 2026-09-23, host-uniform)', () => {
  const text = { workflowInvocation: false, followUpDuringSendStart: false, steerableTextPayload: true, unsteerableQueuedAhead: false } as const

  it('stopRequested queues whatever the connection default and whatever the chord asked', () => {
    expect(effectiveMidStreamBehavior({ ...text, stopRequested: true, connectionDefault: 'steer' })).toBe('queue')
    expect(effectiveMidStreamBehavior({ ...text, stopRequested: true, connectionDefault: 'steer', override: 'steer' })).toBe('queue')
    // and the queue it takes stamps nothing: the Stop already did
    expect(queuedSendInterruptedTurn(
      effectiveMidStreamBehavior({ ...text, stopRequested: true, connectionDefault: 'steer' }), true,
    )).toBe(false)
  })

  it('CONTROL — with no Stop the same text send steers', () => {
    expect(effectiveMidStreamBehavior({ ...text, stopRequested: false, connectionDefault: 'steer' })).toBe('steer')
  })
})
