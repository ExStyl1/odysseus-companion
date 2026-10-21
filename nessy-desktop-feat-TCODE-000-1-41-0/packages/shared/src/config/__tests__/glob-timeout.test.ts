import { describe, expect, it } from 'bun:test'

import {
  GLOB_TIMEOUT_DEFAULT_SECONDS,
  GLOB_TIMEOUT_SECONDS_COMPAT_ENV,
  GLOB_TIMEOUT_SECONDS_ENV,
  GLOB_TIMEOUT_WSL_SECONDS,
  globTimeoutMs,
  globTimeoutSeconds,
} from '../glob-timeout'

describe('globTimeoutSeconds', () => {
  it('defaults to the number the page states', () => {
    // `env-vars.md#variables`: "Timeout in seconds for Glob tool file
    // discovery. Defaults to 20 seconds on most platforms and 60 seconds on WSL".
    expect(GLOB_TIMEOUT_DEFAULT_SECONDS).toBe(20)
    expect(globTimeoutSeconds({})).toBe(20)
    expect(globTimeoutMs({})).toBe(20_000)
  })

  it('reads either spelling, and the Nessy name wins when both are set', () => {
    expect(globTimeoutSeconds({ [GLOB_TIMEOUT_SECONDS_COMPAT_ENV]: '45' })).toBe(45)
    expect(globTimeoutSeconds({ [GLOB_TIMEOUT_SECONDS_ENV]: '5' })).toBe(5)
    expect(globTimeoutSeconds({
      [GLOB_TIMEOUT_SECONDS_ENV]: '5',
      [GLOB_TIMEOUT_SECONDS_COMPAT_ENV]: '45',
    })).toBe(5)
  })

  it('accepts the spellings the page says numeric variables accept', () => {
    expect(globTimeoutSeconds({ [GLOB_TIMEOUT_SECONDS_ENV]: '2e1' })).toBe(20)
    expect(globTimeoutSeconds({ [GLOB_TIMEOUT_SECONDS_ENV]: '1_200' })).toBe(1200)
  })

  // The boundary: a zero-second budget is a tool that always fails, and the
  // page describes a timeout rather than a disable.
  it('refuses a value that is not a legal budget, by name, and keeps the default', () => {
    for (const raw of ['0', '-5', 'soon', '1.5']) {
      const said: string[] = []
      expect(globTimeoutSeconds({ [GLOB_TIMEOUT_SECONDS_ENV]: raw }, m => said.push(m)))
        .toBe(GLOB_TIMEOUT_DEFAULT_SECONDS)
      expect(said).toHaveLength(1)
      expect(said[0]).toContain(GLOB_TIMEOUT_SECONDS_ENV)
      expect(said[0]).toContain(String(GLOB_TIMEOUT_DEFAULT_SECONDS))
    }
  })

  // The WSL half of the documented default is carried and DELIBERATELY unread —
  // this tree has no WSL detection at all. Pinned so the clause stays visible
  // instead of being quietly dropped, and so nobody "fixes" it by wiring the
  // number to the wrong platform test.
  it('carries the documented WSL default without reading it', () => {
    expect(GLOB_TIMEOUT_WSL_SECONDS).toBe(60)
    expect(globTimeoutSeconds({})).not.toBe(GLOB_TIMEOUT_WSL_SECONDS)
  })
})
