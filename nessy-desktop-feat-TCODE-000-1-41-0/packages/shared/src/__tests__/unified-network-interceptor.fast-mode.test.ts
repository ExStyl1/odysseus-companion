/**
 * P6.244 — the host's own fast path: operator-settable, and gated on the
 * model list the PAGE publishes rather than a stale compile-time id.
 *
 * Three separate claims, because the row's `done_means` has three parts and a
 * single "it works" assertion would hide two of them:
 *
 *  1. the flag is reachable by an operator (`NESSY_FEATURE_FAST_MODE`), where
 *     it used to be a hardcoded `false` literal;
 *  2. the model gate matches `fast-mode.md`'s current list — Opus 5.5, Opus 5
 *     and Opus 4.8 — and NOT `claude-opus-4-7`, the one Opus the page says fast mode was
 *     removed from on July 24, 2026;
 *  3. a codex `features.fast_mode` requirement is reported as constraining
 *     CODEX ONLY, by name — so an administrator is not told the desktop host
 *     enforces it.
 *
 * The env writes below `delete` before assigning (Bun 1.3.14 env-slot trap,
 * AGENTS.md §Traps) even though this name is not one Bun pre-creates a slot
 * for: the rule is unconditional because the list cannot be complete.
 */
import { describe, expect, it, afterEach } from 'bun:test'
import { FEATURE_FLAGS, isFastModeEnabled } from '../feature-flags'
import { shouldEnableFastMode } from '../unified-network-interceptor'
import { classifyCodexRequirementField } from '../agent/codex-config-requirements'

const NAME = 'NESSY_FEATURE_FAST_MODE'

function setFlag(value: string | undefined): void {
  delete process.env[NAME]
  if (value !== undefined) process.env[NAME] = value
}

afterEach(() => {
  setFlag(undefined)
})

describe('P6.244 — the host fast path is operator-settable', () => {
  it('defaults to off with no override, matching the page default', () => {
    setFlag(undefined)
    expect(isFastModeEnabled()).toBe(false)
    expect(FEATURE_FLAGS.fastMode).toBe(false)
  })

  it('an operator can turn it on, which the hardcoded literal made impossible', () => {
    setFlag('1')
    expect(isFastModeEnabled()).toBe(true)
    expect(FEATURE_FLAGS.fastMode).toBe(true)
  })

  it('an explicit off is honoured and an unparseable value falls back to off', () => {
    setFlag('0')
    expect(FEATURE_FLAGS.fastMode).toBe(false)
    setFlag('maybe')
    expect(FEATURE_FLAGS.fastMode).toBe(false)
  })
})

describe('P6.244 — the model gate is the page list, not the removed id', () => {
  it('does not fire for any model while the flag is off', () => {
    setFlag('0')
    expect(shouldEnableFastMode('claude-opus-5')).toBe(false)
  })

  it('fires for Opus 5 and Opus 4.8, bare and dated', () => {
    setFlag('1')
    expect(shouldEnableFastMode('claude-opus-5')).toBe(true)
    expect(shouldEnableFastMode('claude-opus-5-20260514')).toBe(true)
    expect(shouldEnableFastMode('claude-opus-4-8')).toBe(true)
    expect(shouldEnableFastMode('claude-opus-4-8-v1')).toBe(true)
  })

  // F1.1214 — fast-mode.md (re-read 2026-10-01) adds Opus 5.5; the `claude-opus-5`
  // prefix already covers it, and Sonnet 5.5 stays out ("not available on Sonnet").
  it('fires for Opus 5.5 and not for Sonnet 5.5', () => {
    setFlag('1')
    expect(shouldEnableFastMode('claude-opus-5-5')).toBe(true)
    expect(shouldEnableFastMode('claude-sonnet-5-5')).toBe(false)
  })

  it('does NOT fire for Opus 4.7 — the id the old gate named', () => {
    setFlag('1')
    expect(shouldEnableFastMode('claude-opus-4-7')).toBe(false)
    expect(shouldEnableFastMode('claude-opus-4-7-v1')).toBe(false)
  })

  it('does not fire for Sonnet, Haiku or a non-string model', () => {
    setFlag('1')
    expect(shouldEnableFastMode('claude-sonnet-4-6')).toBe(false)
    expect(shouldEnableFastMode('claude-haiku-4-5')).toBe(false)
    expect(shouldEnableFastMode(undefined)).toBe(false)
    expect(shouldEnableFastMode(42)).toBe(false)
  })
})

describe('P6.244 — codex owns `features.fast_mode`, and the report says so', () => {
  it('reports the requirement as enforced by CODEX, not by this host', () => {
    expect(classifyCodexRequirementField('featureRequirements.fast_mode')).toBe('codex')
  })

  it('control — the two host-facing feature keys still answer `nessy`', () => {
    expect(classifyCodexRequirementField('featureRequirements.in_app_updates')).toBe('nessy')
  })
})
