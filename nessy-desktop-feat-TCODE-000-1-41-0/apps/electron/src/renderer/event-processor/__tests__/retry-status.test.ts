/**
 * P6.274 (b) / P6.916 / P6.942 — the retry chip's attempt, reason and countdown.
 *
 * The second half used to be a SOURCE-TEXT pin: the parser was only correct
 * while three producers and one `startsWith` in `SessionManager` still spelled
 * the same four things, and nothing in the type system connected them. P6.916
 * gave the `status` branch a `retry` field and P6.942 moved the vocabulary into
 * `@nessy-agent/core/types`, so the pin below is now a ROUND TRIP — the sentence
 * the producers mint and the facts this module reads back out of it are checked
 * against each other — plus the two structural facts that make the round trip
 * the whole story: every producer goes through `retryStatusEvent`, and
 * `SessionManager` stamps the chip off the field rather than off the words.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  RETRY_STATUS_PREFIXES as CORE_RETRY_STATUS_PREFIXES,
  retryStatusMessage,
  type AgentRetryFacts,
} from '@nessy-agent/core/types'

import {
  RETRY_STATUS_PREFIXES,
  formatRetryStatus,
  parseRetryStatus,
  retryCountdownSeconds,
  retryFactsFor,
} from '../retry-status'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..')

/** The renderer's own sentence, rendered as `i18next` renders it. */
const t = (key: string, options?: Record<string, unknown>): string => {
  const en: Record<string, string> = {
    'chat.retryStatus.attempt': 'retry {{attempt}}/{{max}}',
    'chat.retryStatus.attemptOnly': 'retry {{attempt}}',
    'chat.retryStatus.countdown': 'in {{seconds}}s',
    'chat.retryStatus.imminent': 'retrying now…',
  }
  return (en[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''))
}

describe('parseRetryStatus reads the parts out of the one string a retry has', () => {
  it('reads the attempt, the maximum and the wait off pi’s throttled line', () => {
    const facts = parseRetryStatus('Rate limited by the provider — retry 2/5 in 30s')
    expect(facts).toEqual({
      kind: 'rate_limit',
      attempt: 2,
      maxAttempts: 5,
      delaySeconds: 30,
    })
  })

  it('reads the runtime’s own cause out of the parenthesis', () => {
    const pi = parseRetryStatus('Provider error (fetch failed) — retry 1/5 in 15s')
    expect(pi?.cause).toBe('fetch failed')
    expect(pi?.attempt).toBe(1)

    const claude = parseRetryStatus('Provider error (server_error) — retry 1/3 in 15s')
    expect(claude?.cause).toBe('server_error')
  })

  it('leaves the attempt and the wait undefined for codex, which publishes neither', () => {
    // `ErrorNotification` is `{ error, willRetry, threadId, turnId }`. Reading a
    // count out of a line that carries none would be a number the user could
    // check and find wrong, so the parse simply comes back without one.
    const facts = parseRetryStatus('Rate limited by the provider')
    expect(facts).toEqual({ kind: 'rate_limit' })
    expect(facts?.attempt).toBeUndefined()
    expect(facts?.delaySeconds).toBeUndefined()
  })

  it('is not fooled by a status that is not a retry', () => {
    // The negative case that matters: `handleStatus` sees compaction lines on
    // the same channel, and a parser that matched loosely would put an attempt
    // number on one of them.
    expect(parseRetryStatus('Compacting conversation')).toBeNull()
    expect(parseRetryStatus('Scanning for secrets…')).toBeNull()
    expect(parseRetryStatus('')).toBeNull()
  })

  it('reads the success line pi sends when the ladder pays off', () => {
    const facts = parseRetryStatus('Retry succeeded — resuming...')
    expect(facts?.kind).toBe('succeeded')
  })
})

describe('the countdown counts DOWN, anchored on the line’s arrival', () => {
  const facts = parseRetryStatus('Rate limited by the provider — retry 2/5 in 30s')!

  it('spends the announced wait a second at a time and stops at zero', () => {
    expect(retryCountdownSeconds(facts, 1_000, 1_000)).toBe(30)
    expect(retryCountdownSeconds(facts, 1_000, 12_000)).toBe(19)
    expect(retryCountdownSeconds(facts, 1_000, 31_000)).toBe(0)
    // Past the announced wait it stays at zero rather than going negative: the
    // provider may take longer than it said, and a negative second reads as a
    // bug rather than as a wait.
    expect(retryCountdownSeconds(facts, 1_000, 99_000)).toBe(0)
  })

  it('has nothing to count when the runtime announced no wait', () => {
    const codex = parseRetryStatus('Provider error')!
    expect(retryCountdownSeconds(codex, 1_000, 5_000)).toBeNull()
  })
})

describe('formatRetryStatus assembles the label instead of echoing it', () => {
  it('keeps the producer’s reason and localises the renderer’s own clauses', () => {
    const facts = parseRetryStatus('Rate limited by the provider — retry 2/5 in 30s')!
    expect(formatRetryStatus(facts, 12, t)).toBe('Rate limited by the provider — retry 2/5 in 12s')
    expect(formatRetryStatus(facts, 0, t)).toBe('Rate limited by the provider — retry 2/5 retrying now…')
  })

  it('shows the cause and drops the clauses the runtime did not publish', () => {
    const withCause = parseRetryStatus('Provider error (fetch failed) — retry 1/5 in 15s')!
    expect(formatRetryStatus(withCause, 15, t)).toBe('Provider error (fetch failed) — retry 1/5 in 15s')

    // codex: a reason and nothing else, which is exactly what it published.
    const codex = parseRetryStatus('Provider error')!
    expect(formatRetryStatus(codex, null, t)).toBe('Provider error')
  })

  it('renders an attempt with no maximum, which claude can send', () => {
    const facts = parseRetryStatus('Provider error — retry 3')!
    expect(formatRetryStatus(facts, null, t)).toBe('Provider error — retry 3')
  })
})

describe('the vocabulary pin — one constant, and the two ends that read it', () => {
  const read = (relative: string) => readFileSync(join(REPO_ROOT, relative), 'utf8')

  /**
   * The three shapes the three runtimes actually publish. Written as FACTS,
   * which is what the producers now hand to `retryStatusEvent`.
   */
  const producerShapes: Array<[string, AgentRetryFacts]> = [
    ['pi, throttled', { kind: 'rate_limit', attempt: 2, maxAttempts: 5, delaySeconds: 30 }],
    ['pi, provider error', { kind: 'provider_error', cause: 'fetch failed', attempt: 1, maxAttempts: 5, delaySeconds: 15 }],
    ['claude, no budget', { kind: 'provider_error', cause: 'server_error', attempt: 3, delaySeconds: 15 }],
    ['codex, attempt only', { kind: 'rate_limit', attempt: 2 }],
    ['codex, nothing but the kind', { kind: 'provider_error' }],
    ['the resolution', { kind: 'succeeded' }],
  ]

  it('is ONE constant — the renderer re-exports core’s rather than restating it', () => {
    // P6.942 in one assertion: identity, not equality. Two objects that happen
    // to agree today is exactly the state this row exists to end.
    expect(RETRY_STATUS_PREFIXES).toBe(CORE_RETRY_STATUS_PREFIXES)
  })

  it('round-trips every producer shape through the sentence and back', () => {
    // The pin that replaces four source greps: whatever the shared builder
    // writes, this module's fallback parse must read back unchanged. A reworded
    // head breaks BOTH sides at once, which is the point of one constant.
    for (const [name, facts] of producerShapes) {
      expect(parseRetryStatus(retryStatusMessage(facts)), name).toEqual(facts)
    }
  })

  it('keeps the shipped wording byte-for-byte', () => {
    // Release note 1.20.1 quotes this line. P6.916 moved WHERE it is written,
    // not what it says, so the exact strings are pinned here rather than left to
    // be re-derived from the builder that produces them.
    expect(retryStatusMessage({ kind: 'rate_limit', attempt: 2, maxAttempts: 5, delaySeconds: 30 }))
      .toBe('Rate limited by the provider — retry 2/5 in 30s')
    expect(retryStatusMessage({ kind: 'provider_error', cause: 'fetch failed', attempt: 1, maxAttempts: 5, delaySeconds: 15 }))
      .toBe('Provider error (fetch failed) — retry 1/5 in 15s')
    expect(retryStatusMessage({ kind: 'succeeded' })).toBe('Retry succeeded — resuming...')
  })

  it('is minted by all three producers through the one builder', () => {
    // The structural half: a producer that stopped calling `retryStatusEvent`
    // would be free to invent a fourth spelling again, and no round trip would
    // notice because it would never reach this module.
    const producers = {
      pi: read('packages/shared/src/agent/backend/pi/event-adapter.ts'),
      claude: read('packages/shared/src/agent/backend/claude/event-adapter.ts'),
      codex: read('packages/shared/src/agent/codex-agent.ts'),
    }
    for (const [runtime, source] of Object.entries(producers)) {
      expect(source, `${runtime} mints its retry status through the shared builder`)
        .toContain('retryStatusEvent(')
    }
    // And the two per-runtime sentence builders are gone. Guarded by their CALL
    // form, not by the bare name: a comment explaining the removal spells the
    // name, and a bare-identifier guard then fails on the very commit that made
    // it true (AGENTS.md §Traps, W9-f).
    expect(producers.claude, 'claude no longer assembles its own sentence')
      .not.toContain('buildRetryStatusMessage(')
    expect(producers.codex, 'codex no longer assembles its own sentence')
      .not.toContain('codexRetryStatusMessage(')
  })

  it('is what SessionManager reads instead of sniffing the words', () => {
    const sessionManager = read('packages/server-core/src/sessions/SessionManager.ts')
    // F1.1150 interleaved the phase branch ahead of the retry branch, so the
    // contiguous literal went away while the field still feeds the chip; the pin
    // reads the ternary's own two lines (the discriminator arm and its word).
    expect(sessionManager, 'the chip is stamped off the field').toContain(': event.retry')
    expect(sessionManager).toContain("? 'retrying'")
    for (const sniffed of ['Rate limited', 'Provider error', 'Retry succeeded']) {
      expect(sessionManager, `SessionManager no longer sniffs ${sniffed}`)
        .not.toContain(`startsWith('${sniffed}')`)
    }
  })
})

describe('retryFactsFor prefers what the producer sent', () => {
  it('takes the field and never parses when one is present', () => {
    // The field is the truth even when the sentence disagrees: a producer that
    // publishes an attempt it counted but words the line without one must not
    // have the count re-derived away.
    const sent: AgentRetryFacts = { kind: 'rate_limit', attempt: 7 }
    expect(retryFactsFor('retrying', 'Rate limited by the provider', sent)).toBe(sent)
  })

  it('falls back to the parse for a replayed line that carries no field', () => {
    expect(retryFactsFor('retrying', 'Provider error (fetch failed) — retry 1/5 in 15s', undefined))
      .toEqual({ kind: 'provider_error', cause: 'fetch failed', attempt: 1, maxAttempts: 5, delaySeconds: 15 })
  })

  it('says nothing for a status that is not a retry', () => {
    expect(retryFactsFor('compacting', 'Compacting conversation', undefined)).toBeNull()
    expect(retryFactsFor(undefined, 'Rate limited by the provider', undefined)).toBeNull()
  })
})
