/**
 * P6.385 — the official-marketplace auto-install opt-out.
 *
 * `data-usage.md#default-behaviors-by-api-provider`, verbatim: *"This variable
 * doesn't affect the WebFetch check or official plugin marketplace
 * auto-install; each has its own opt-out: `skipWebFetchPreflight` in settings
 * for WebFetch, and `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` for
 * the marketplace."*
 *
 * The name is spelled once, here and in `managed-marketplace-entries.ts`, and
 * the binary probe below is what makes a typo fail rather than silently do
 * nothing — an environment variable the child does not recognise is not an
 * error anywhere, which is exactly why this kind of setting rots unnoticed.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  OFFICIAL_MARKETPLACE_AUTOINSTALL_OFF_ENV,
  officialMarketplaceAutoinstallOffEnv,
} from '../managed-marketplace-entries.ts'

const BINARY = fileURLToPath(new URL(
  '../../../../../../node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
  import.meta.url,
))

function occurrences(haystack: string, needle: string): number {
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

describe('P6.385 — the opt-out the non-essential-traffic switch does not cover', () => {
  it('is a single frozen entry with the page\'s own value shape', () => {
    const env = officialMarketplaceAutoinstallOffEnv()
    expect(env).toEqual({ CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1' })
    expect(Object.isFrozen(env)).toBe(true)
  })

  it('the name is spelled the way the shipped binary reads it', () => {
    // Skipped rather than failed off-arm: the darwin-arm64 bundle is one of
    // several per-platform packages, and a linux CI runner has a different one.
    // The assertion that matters is the CONTROL beside it — without it a probe
    // that read nothing would report a clean pass.
    if (!existsSync(BINARY)) return
    const bundle = readFileSync(BINARY, 'latin1')
    expect(occurrences(bundle, OFFICIAL_MARKETPLACE_AUTOINSTALL_OFF_ENV)).toBeGreaterThan(0)
    // Positive control: a sibling this fork already sets, on the same rig.
    expect(occurrences(bundle, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')).toBeGreaterThan(0)
    // Negative control: a name that cannot be there, so a probe matching
    // everything cannot pass.
    expect(occurrences(bundle, 'NESSY_NOT_A_REAL_ENV_NAME_P6_385')).toBe(0)
    // One whole-binary read (214 MB at 2.1.274). Measured 1.7 s alone and 15.1 s
    // inside the 214-file bundle-reading sweep (F1.1213), against bun's 5 s
    // default, which failed it for the wrong reason: budget set against the
    // loaded floor, not zero, as P3.338 does for the same read.
  }, 60_000)
})
