import { describe, expect, it } from 'bun:test'

import {
  FILE_READ_MAX_OUTPUT_TOKENS_COMPAT_ENV,
  FILE_READ_MAX_OUTPUT_TOKENS_ENV,
  fileReadOutputTokenLimit,
} from '../file-read-output-limit'

describe('fileReadOutputTokenLimit', () => {
  // The load-bearing negative: an unset environment must leave the model-aware
  // threshold alone. `undefined` and NOT `0` — a zero here would be a ceiling of
  // nothing, which truncates every read.
  it('answers undefined when neither spelling is set', () => {
    expect(fileReadOutputTokenLimit({})).toBeUndefined()
    expect(fileReadOutputTokenLimit({ [FILE_READ_MAX_OUTPUT_TOKENS_ENV]: '' })).toBeUndefined()
    expect(fileReadOutputTokenLimit({ [FILE_READ_MAX_OUTPUT_TOKENS_ENV]: '   ' })).toBeUndefined()
  })

  it('reads either spelling, and the Nessy name wins when both are set', () => {
    expect(fileReadOutputTokenLimit({ [FILE_READ_MAX_OUTPUT_TOKENS_COMPAT_ENV]: '4000' })).toBe(4000)
    expect(fileReadOutputTokenLimit({ [FILE_READ_MAX_OUTPUT_TOKENS_ENV]: '9000' })).toBe(9000)
    expect(fileReadOutputTokenLimit({
      [FILE_READ_MAX_OUTPUT_TOKENS_ENV]: '9000',
      [FILE_READ_MAX_OUTPUT_TOKENS_COMPAT_ENV]: '4000',
    })).toBe(9000)
  })

  it('accepts the spellings the page says numeric variables accept', () => {
    // `env-vars.md#variables`: "Claude Code reads `2e3` as 2000 and `64_000` as
    // 64000." This row notes no plain-digits-only restriction, so the general
    // rule governs.
    expect(fileReadOutputTokenLimit({ [FILE_READ_MAX_OUTPUT_TOKENS_ENV]: '2e3' })).toBe(2000)
    expect(fileReadOutputTokenLimit({ [FILE_READ_MAX_OUTPUT_TOKENS_ENV]: '64_000' })).toBe(64000)
  })

  // The boundary. The page offers a raise, never a disable, so 0 and negatives
  // are rejected — and rejected LOUDLY, naming the variable, because a silently
  // ignored ceiling is exactly the shape this row exists to end.
  it('rejects a value that is not a legal ceiling and says which one, by name', () => {
    for (const raw of ['0', '-1', 'lots', '1.5']) {
      const said: string[] = []
      expect(fileReadOutputTokenLimit({ [FILE_READ_MAX_OUTPUT_TOKENS_ENV]: raw }, m => said.push(m)))
        .toBeUndefined()
      expect(said).toHaveLength(1)
      expect(said[0]).toContain(FILE_READ_MAX_OUTPUT_TOKENS_ENV)
      expect(said[0]).toContain(JSON.stringify(raw))
      // The sentence must say what happens next, and there is no number to name.
      expect(said[0]).toContain('keeping the model-aware file-read threshold')
      expect(said[0]).not.toContain('using 0 instead')
    }
  })

  it('names the COMPAT spelling in the rejection when that is the one that was set', () => {
    const said: string[] = []
    fileReadOutputTokenLimit({ [FILE_READ_MAX_OUTPUT_TOKENS_COMPAT_ENV]: 'nope' }, m => said.push(m))
    expect(said[0]).toContain(FILE_READ_MAX_OUTPUT_TOKENS_COMPAT_ENV)
    expect(said[0]).not.toContain(FILE_READ_MAX_OUTPUT_TOKENS_ENV)
  })
})
