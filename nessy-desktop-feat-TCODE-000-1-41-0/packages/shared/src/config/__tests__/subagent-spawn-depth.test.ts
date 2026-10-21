import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH,
  MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR,
  MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR,
  resolveMaxSubagentSpawnDepth,
} from '../subagent-spawn-depth.ts'
import { resetNumericSettingReports } from '../numeric-setting.ts'

describe('resolveMaxSubagentSpawnDepth', () => {
  it('defaults to three layers when neither name is set', () => {
    // env-vars.md:281 — "(default: 3)".
    expect(DEFAULT_MAX_SUBAGENT_SPAWN_DEPTH).toBe(3)
    expect(resolveMaxSubagentSpawnDepth({})).toBe(3)
    expect(resolveMaxSubagentSpawnDepth({ UNRELATED: '1' })).toBe(3)
  })

  // env-vars.md, the `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` row — "Accepts a
  // positive whole number in plain digits; anything else is ignored, so the
  // limit can be adjusted but not removed."
  //
  // These refusals are the DOCUMENTED behaviour, not a fork convention, and
  // this block is the control that says so. `env-vars.md#variables` grants
  // scientific notation and separators to numeric variables generally — "For
  // example, Claude Code reads `2e3` as 2000 and `64_000` as 64000" — "except
  // where a variable's row notes it takes plain digits only". This row notes
  // it, so `1e3` stays 3 HERE while it reads as 1000 for the web-search cap,
  // whose row is silent. Two contracts, deliberately.
  it.each([
    ['2', 2], // adjusted down
    ['1', 1], // the documented "nesting off" value — legal, not malformed
    ['5', 5], // adjusted up
    [' 4 ', 4], // trimmed before the digits check
    ['0', 3], // no disable value: 0 must never mean unlimited
    ['-1', 3],
    ['2.5', 3], // not plain digits
    ['1e3', 3], // scientific notation — granted generally, refused by THIS row
    ['2e3', 3], // the page's own general-rule example, refused here on purpose
    ['1_000', 3], // digit-separator spelling
    ['64_000', 3], // the page's other general-rule example, likewise refused
    ['0x3', 3], // hex — Number() would take it too
    ['+3', 3], // signed
    ['3,0', 3],
    ['abc', 3],
    ['', 3],
    [' ', 3],
    ['9007199254740993', 3], // plain digits but not a safe integer
  ])('reads %j as %i, falling back to 3 for anything not plain digits >= 1', (raw, expected) => {
    // Silent sink: the table exercises the VALUES; the report has its own test.
    expect(resolveMaxSubagentSpawnDepth({ [MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR]: raw }, () => {})).toBe(expected)
  })

  it('says why it refused, instead of silently becoming 3', () => {
    resetNumericSettingReports()
    const said: string[] = []
    expect(resolveMaxSubagentSpawnDepth(
      { [MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR]: '1e3' },
      m => { said.push(m) },
    )).toBe(3)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain(MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR)
    expect(said[0]).toContain('1e3')
    expect(said[0]).toContain('3')
  })

  it('honours the Claude compat alias alone', () => {
    expect(resolveMaxSubagentSpawnDepth({ [MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR]: '2' })).toBe(2)
    expect(resolveMaxSubagentSpawnDepth({ [MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR]: '1e3' }, () => {})).toBe(3)
  })

  it('lets the Nessy name win when both names are set', () => {
    expect(resolveMaxSubagentSpawnDepth({
      [MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR]: '4',
      [MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR]: '2',
    })).toBe(4)
    // The Nessy name wins even when malformed — same precedence rule as the
    // print-background-wait pair: presence decides, validity does not re-route.
    expect(resolveMaxSubagentSpawnDepth({
      [MAX_SUBAGENT_SPAWN_DEPTH_ENV_VAR]: 'abc',
      [MAX_SUBAGENT_SPAWN_DEPTH_COMPAT_ENV_VAR]: '2',
    }, () => {})).toBe(3)
  })
})
