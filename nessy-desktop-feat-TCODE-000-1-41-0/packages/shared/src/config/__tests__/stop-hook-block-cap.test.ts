import { describe, expect, it } from 'bun:test'

import { resetNumericSettingReports } from '../numeric-setting.ts'
import {
  DEFAULT_STOP_HOOK_BLOCK_CAP,
  STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR,
  STOP_HOOK_BLOCK_CAP_DISABLED,
  STOP_HOOK_BLOCK_CAP_ENV_VAR,
  resolveStopHookBlockCap,
} from '../stop-hook-block-cap.ts'

describe('resolveStopHookBlockCap', () => {
  it('defaults to eight blocks when neither name is set', () => {
    // env-vars.md, CLAUDE_CODE_STOP_HOOK_BLOCK_CAP — "(default: 8)".
    expect(DEFAULT_STOP_HOOK_BLOCK_CAP).toBe(8)
    expect(resolveStopHookBlockCap({})).toBe(8)
    expect(resolveStopHookBlockCap({ UNRELATED: '20' })).toBe(8)
  })

  it('returns the documented disable sentinel verbatim', () => {
    // "Set to `0` to disable the cap." 0 is a legal setting, not a malformed
    // one, and it must survive the parse untouched.
    expect(STOP_HOOK_BLOCK_CAP_DISABLED).toBe(0)
    expect(resolveStopHookBlockCap({ [STOP_HOOK_BLOCK_CAP_ENV_VAR]: '0' })).toBe(0)
    expect(resolveStopHookBlockCap({ [STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR]: '0' })).toBe(0)
  })

  // "Raise this if your hook legitimately needs more iterations to resolve."
  // This key's row notes NO plain-digits restriction, so `env-vars.md#variables`
  // grants it scientific notation and digit separators: "Numeric variables …
  // accept scientific notation and digit-separator spellings in addition to
  // plain digits, except where a variable's row notes it takes plain digits
  // only." Everything the general rule still refuses falls back to 8 and NEVER
  // to 0 — a typo must not silently buy an uncapped hook loop.
  it.each([
    ['12', 12], // raised
    ['3', 3], // lowered
    [' 20 ', 20], // trimmed before the shape check
    ['1e3', 1000], // scientific notation — the page's own example spelling
    ['1_000', 1000], // digit-separator spelling — "reads … `64_000` as 64000"
    ['-1', 8], // signed — and must not be read as "disabled"
    ['1.5', 8], // a float where a whole number is required
    ['0x8', 8], // hex — Number() would take it, the page never grants it
    ['+8', 8], // signed
    ['8,0', 8],
    ['1__0', 8], // doubled separator — the literal grammar allows only one
    ['_8', 8], // leading separator
    ['8_', 8], // trailing separator
    ['abc', 8],
    ['', 8],
    [' ', 8],
    ['9007199254740993', 8], // plain digits but not a safe integer
  ])('reads %j as %i under the page general numeric rule', (raw, expected) => {
    expect(resolveStopHookBlockCap({ [STOP_HOOK_BLOCK_CAP_ENV_VAR]: raw }, () => {})).toBe(expected)
  })

  it('honours the Claude compat alias alone', () => {
    expect(resolveStopHookBlockCap({ [STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR]: '12' })).toBe(12)
    expect(resolveStopHookBlockCap({ [STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR]: '1e3' })).toBe(1000)
  })

  it('says a refused value out loud, naming the spelling it actually read', () => {
    // A cap that quietly becomes its default is a control that silently stopped
    // controlling — the whole reason `numeric-setting.ts` returns a reason.
    resetNumericSettingReports()
    const said: string[] = []
    expect(resolveStopHookBlockCap(
      { [STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR]: '0x8' },
      message => { said.push(message) },
    )).toBe(DEFAULT_STOP_HOOK_BLOCK_CAP)
    expect(said).toHaveLength(1)
    expect(said[0]).toContain(STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR)
    expect(said[0]).not.toContain(STOP_HOOK_BLOCK_CAP_ENV_VAR)
  })

  it('stays silent for the two spellings that are not mistakes', () => {
    // Unset is the ordinary case; empty is how a settings `env` block spells
    // "leave it alone". Both fall back, neither is reported.
    resetNumericSettingReports()
    const said: string[] = []
    const write = (message: string) => { said.push(message) }
    expect(resolveStopHookBlockCap({}, write)).toBe(DEFAULT_STOP_HOOK_BLOCK_CAP)
    expect(resolveStopHookBlockCap({ [STOP_HOOK_BLOCK_CAP_ENV_VAR]: '' }, write)).toBe(DEFAULT_STOP_HOOK_BLOCK_CAP)
    expect(said).toHaveLength(0)
  })

  it('lets the Nessy name win when both names are set', () => {
    expect(resolveStopHookBlockCap({
      [STOP_HOOK_BLOCK_CAP_ENV_VAR]: '20',
      [STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR]: '12',
    })).toBe(20)
    // Presence decides, validity does not re-route: a malformed Nessy name
    // falls back to 8 rather than deferring to a valid compat alias. Same rule
    // as the print-background-wait and subagent-spawn-depth pairs.
    expect(resolveStopHookBlockCap({
      [STOP_HOOK_BLOCK_CAP_ENV_VAR]: 'abc',
      [STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR]: '12',
    }, () => {})).toBe(8)
    // Including when the Nessy name asks to disable the cap.
    expect(resolveStopHookBlockCap({
      [STOP_HOOK_BLOCK_CAP_ENV_VAR]: '0',
      [STOP_HOOK_BLOCK_CAP_COMPAT_ENV_VAR]: '12',
    })).toBe(0)
  })
})
