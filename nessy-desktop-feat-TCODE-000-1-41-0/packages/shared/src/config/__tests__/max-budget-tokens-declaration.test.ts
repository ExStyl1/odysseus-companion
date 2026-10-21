/**
 * P6.645 — the DECLARATION half of the token ceiling, and it takes TWO files to
 * declare it.
 *
 * `syncConfigDefaults()` overwrites `~/.nessy-agent/config-defaults.json` from
 * the bundled asset on every launch and falls back to `FALLBACK_CONFIG_DEFAULTS`
 * only when the assets directory is missing. So the bundled JSON governs a
 * normal launch and the constant governs a broken one; a key added to one of
 * them alone works in the running session, reverts on the next launch, and
 * passes every other test in between.
 *
 * Why this matters MORE for this key than for its siblings: the reader
 * (`resolveMaxBudgetTokens()`) reads an ABSENT field as 0, which is "no cap" —
 * deliberately, so that the reader could land before the declaration without
 * changing any behaviour. That defensive read means a half-landed declaration
 * is SILENT: the ceiling an operator configured would simply never bind, and
 * nothing anywhere would say so. This file is the thing that says so.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

import { FALLBACK_CONFIG_DEFAULTS } from '../storage.ts'

const BUNDLED_ASSET = join(
  import.meta.dir, '..', '..', '..', '..', '..',
  'apps', 'electron', 'resources', 'config-defaults.json',
)

const bundled = JSON.parse(readFileSync(BUNDLED_ASSET, 'utf-8')) as {
  workspaceDefaults?: { maxBudgetTokens?: unknown; maxBudgetUsd?: unknown }
}

describe('the shipped token ceiling', () => {
  it('is declared, and off, in the bundled asset AND in the in-code fallback', () => {
    expect(bundled.workspaceDefaults?.maxBudgetTokens).toBe(0)
    expect(FALLBACK_CONFIG_DEFAULTS.workspaceDefaults.maxBudgetTokens).toBe(0)
  })

  it('spells "off" the same way its USD twin does', () => {
    // Two ceilings with two different spellings of off is the defect this
    // pairing exists to prevent: 0 means no cap on both, so an operator who
    // learns one has learnt the other.
    expect(bundled.workspaceDefaults?.maxBudgetUsd).toBe(0)
    expect(FALLBACK_CONFIG_DEFAULTS.workspaceDefaults.maxBudgetTokens)
      .toBe(FALLBACK_CONFIG_DEFAULTS.workspaceDefaults.maxBudgetUsd)
  })

  it('is a number in the asset, not a string the reader would drop', () => {
    // `resolveMaxBudgetTokens()` requires `typeof raw === 'number'`, so a JSON
    // `"200000"` reads as no cap: configured by declaration, absent in fact.
    expect(typeof bundled.workspaceDefaults?.maxBudgetTokens).toBe('number')
  })
})
