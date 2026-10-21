import { describe, expect, it } from 'bun:test'
import { getAgentElapsedSeconds, formatAgentElapsed } from '../agent-elapsed'

const START = '2026-07-06T12:00:00.000Z'
const startMs = Date.parse(START)

describe('getAgentElapsedSeconds', () => {
  it('returns undefined without a start time', () => {
    expect(getAgentElapsedSeconds(undefined)).toBeUndefined()
    expect(getAgentElapsedSeconds('not-a-date', undefined, startMs + 5000)).toBeUndefined()
  })

  it('ticks against now while running (no endedAt)', () => {
    expect(getAgentElapsedSeconds(START, undefined, startMs + 5000)).toBe(5)
    expect(getAgentElapsedSeconds(START, undefined, startMs + 65000)).toBe(65)
  })

  it('freezes at endedAt once finished and ignores now', () => {
    const ended = new Date(startMs + 10000).toISOString()
    // now keeps advancing but the elapsed value stays frozen at end - start.
    expect(getAgentElapsedSeconds(START, ended, startMs + 5000)).toBe(10)
    expect(getAgentElapsedSeconds(START, ended, startMs + 999999)).toBe(10)
  })

  it('never goes negative', () => {
    expect(getAgentElapsedSeconds(START, undefined, startMs - 5000)).toBe(0)
  })
})

describe('formatAgentElapsed', () => {
  it('formats seconds, minutes, hours', () => {
    expect(formatAgentElapsed(5)).toBe('5s')
    expect(formatAgentElapsed(65)).toBe('1m 5s')
    expect(formatAgentElapsed(120)).toBe('2m')
    expect(formatAgentElapsed(3660)).toBe('1h 1m')
  })
})
