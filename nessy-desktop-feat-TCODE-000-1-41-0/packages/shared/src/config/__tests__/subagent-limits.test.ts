import { describe, expect, it } from 'bun:test'

import {
  childSessionConcurrencyBackstop,
  concurrentSubagentLimitMessage,
  declaredMaxConcurrentSubagents,
  hostLiveAgentCeiling,
  MAX_CONCURRENT_SUBAGENTS_DEFAULT,
  maxConcurrentSubagents,
  resolveLiveAgentCeilingFor,
  resolveTaskMaxOutputChars,
  TASK_MAX_OUTPUT_CHARS_DEFAULT,
  TASK_MAX_OUTPUT_CHARS_MAX,
} from '../subagent-limits.ts'

const GIB = 1024 ** 3

describe('concurrent-subagent ceiling', () => {
  it('is the documented 20 on a machine that can hold it', () => {
    // 20 subagents plus the parent need 21 runtimes; at 2 GiB each that is
    // ~42 GiB, so a 64 GiB workstation observes the documented number exactly.
    expect(maxConcurrentSubagents({}, 64 * GIB)).toBe(MAX_CONCURRENT_SUBAGENTS_DEFAULT)
    expect(maxConcurrentSubagents({}, 48 * GIB)).toBe(20)
  })

  it('narrows the DEFAULT to what the machine can hold, one runtime below the memory bound', () => {
    // The narrowing is the whole point: without it the ninth subagent on a
    // 16 GiB laptop is refused by the MEMORY gate with `live-agent-ceiling-
    // reached`, asynchronously, instead of by the documented one.
    expect(hostLiveAgentCeiling(16 * GIB)).toBe(8)
    expect(maxConcurrentSubagents({}, 16 * GIB)).toBe(7)
    expect(maxConcurrentSubagents({}, 8 * GIB)).toBe(3)
    // The 2-runtime floor still leaves room for one child.
    expect(maxConcurrentSubagents({}, 1 * GIB)).toBe(1)
  })

  it('keeps the subagent ceiling strictly below the live-agent ceiling in BOTH directions', () => {
    for (const memory of [1, 4, 8, 16, 32, 64, 128].map(gib => gib * GIB)) {
      for (const env of [{}, { NESSY_MAX_CONCURRENT_SUBAGENTS: '40' }, { NESSY_MAX_CONCURRENT_SUBAGENTS: '1' }]) {
        expect(maxConcurrentSubagents(env, memory)).toBeLessThan(resolveLiveAgentCeilingFor(env, memory))
      }
    }
  })

  it('lets an explicit override win outright, and raises the host ceiling to follow it', () => {
    const env = { NESSY_MAX_CONCURRENT_SUBAGENTS: '40' }
    expect(maxConcurrentSubagents(env, 16 * GIB)).toBe(40)
    expect(resolveLiveAgentCeilingFor(env, 16 * GIB)).toBe(41)
    // A lower override never lowers the memory bound.
    const low = { NESSY_MAX_CONCURRENT_SUBAGENTS: '2' }
    expect(resolveLiveAgentCeilingFor(low, 64 * GIB)).toBe(32)
  })

  it('accepts the Claude spelling and lets the Nessy name win when both are set', () => {
    expect(declaredMaxConcurrentSubagents({ CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '5' })).toBe(5)
    expect(declaredMaxConcurrentSubagents({
      NESSY_MAX_CONCURRENT_SUBAGENTS: '5',
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '9',
    })).toBe(5)
  })

  it('ignores anything that is not a positive whole number in plain digits', () => {
    // `env-vars.md:277` — "anything else is ignored, so the variable can adjust
    // the cap but can't disable it". `0` is not a disable value.
    for (const raw of ['0', '-1', '2.5', '1e3', '0x3', '+3', '3_000', 'many', '']) {
      expect(declaredMaxConcurrentSubagents({ NESSY_MAX_CONCURRENT_SUBAGENTS: raw })).toBeUndefined()
    }
    expect(maxConcurrentSubagents({ NESSY_MAX_CONCURRENT_SUBAGENTS: '0' }, 64 * GIB)).toBe(20)
  })

  it('sizes the host backstop above every legitimate scope mix', () => {
    // It must never speak before the scoped gate that owns the decision, so it
    // is the sum of both ceilings plus room for the judge children.
    expect(childSessionConcurrencyBackstop({ subagentCeiling: 20, workflowCeiling: 14 })).toBe(38)
    expect(childSessionConcurrencyBackstop({ subagentCeiling: 7, workflowCeiling: 1 })).toBe(12)
    expect(childSessionConcurrencyBackstop({ subagentCeiling: 20, workflowCeiling: 14 }))
      .toBeGreaterThan(20 + 14)
  })

  it('carries the documented refusal sentence and a do-not-retry instruction', () => {
    const message = concurrentSubagentLimitMessage(20)
    expect(message).toStartWith('Concurrent subagent limit reached')
    expect(message).toContain('20')
    expect(message).toContain('Do not retry')
  })
})

describe('subagent output cap', () => {
  it('defaults to 32000 CHARACTERS and clamps to the documented maximum', () => {
    expect(resolveTaskMaxOutputChars({})).toBe(TASK_MAX_OUTPUT_CHARS_DEFAULT)
    expect(resolveTaskMaxOutputChars({ NESSY_TASK_MAX_OUTPUT_LENGTH: '100' })).toBe(100)
    expect(resolveTaskMaxOutputChars({ NESSY_TASK_MAX_OUTPUT_LENGTH: '999999' })).toBe(TASK_MAX_OUTPUT_CHARS_MAX)
  })

  it('accepts the documented Claude spelling, with the Nessy name winning', () => {
    expect(resolveTaskMaxOutputChars({ TASK_MAX_OUTPUT_LENGTH: '4096' })).toBe(4096)
    expect(resolveTaskMaxOutputChars({
      NESSY_TASK_MAX_OUTPUT_LENGTH: '4096',
      TASK_MAX_OUTPUT_LENGTH: '8192',
    })).toBe(4096)
  })

  it('falls back to the default on garbage and on a non-positive value', () => {
    for (const raw of ['0', '-5', 'lots', '3.5', '1e5', '']) {
      expect(resolveTaskMaxOutputChars({ NESSY_TASK_MAX_OUTPUT_LENGTH: raw })).toBe(TASK_MAX_OUTPUT_CHARS_DEFAULT)
    }
  })
})
