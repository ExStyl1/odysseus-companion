import { describe, expect, it } from 'bun:test'
import { flattenDisposalFailure, sessionDisposalFailureMessage } from './SessionManager.ts'

/**
 * T25 (plan 2026-08-20): the strict-drain failure used to say `pi-` for every
 * provider, and a nested AggregateError's leaves reached no log. The message
 * crosses the RPC verbatim and the renderer parses it (`ChatPage.tsx`), so its
 * shape is a contract, not a debug string.
 */
describe('sessionDisposalFailureMessage', () => {
  it.each([
    ['pi', 'pi-session-disposal-failed'],
    ['codex-runtime', 'codex-runtime-session-disposal-failed'],
    ['anthropic', 'anthropic-session-disposal-failed'],
    ['nestor-cloud-agent', 'nestor-cloud-agent-session-disposal-failed'],
  ])('names the %s runtime', (provider, expected) => {
    expect(sessionDisposalFailureMessage(provider)).toBe(expected)
    // The renderer's parse of this exact shape must keep working.
    expect(/^([a-z][a-z-]*)-session-disposal-failed$/.exec(expected)?.[1]).toBe(provider)
  })
})

describe('flattenDisposalFailure', () => {
  it('keeps a plain error as its single leaf', () => {
    expect(flattenDisposalFailure(new Error('boom'))).toEqual(['Error: boom'])
  })

  it('surfaces every leaf of the codex cleanup shape, head first', () => {
    // codex-agent.ts throws AggregateError(leaves, 'codex-runtime-cleanup-failed');
    // before T25 only that head message reached a log.
    const nested = new AggregateError(
      [new Error('adapter port still bound'), new Error('CODEX_HOME rm EBUSY')],
      'codex-runtime-cleanup-failed',
    )
    expect(flattenDisposalFailure(nested)).toEqual([
      'AggregateError: codex-runtime-cleanup-failed',
      'Error: adapter port still bound',
      'Error: CODEX_HOME rm EBUSY',
    ])
  })

  it('stringifies a non-Error and bounds pathological nesting', () => {
    expect(flattenDisposalFailure('raw-string')).toEqual(['raw-string'])
    let deep: unknown = new Error('leaf')
    for (let i = 0; i < 10; i += 1) deep = new AggregateError([deep as Error], `level-${i}`)
    expect(flattenDisposalFailure(deep)).toContain('<flatten depth exceeded>')
  })
})
