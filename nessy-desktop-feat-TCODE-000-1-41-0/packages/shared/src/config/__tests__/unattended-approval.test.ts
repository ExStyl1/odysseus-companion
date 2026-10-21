/**
 * P6.531 — the operator escape hatch for an unattended turn's fallback.
 *
 * Q-den 68 = A + C: deny by default, with an operator setting whose default is
 * deny. Option B — keep auto-approving and pay the honesty in documentation —
 * was refused, because a documented divergence is copy, not protection.
 *
 * WHAT EACH TEST KILLS:
 *  - the default arm dies the day the shipped default drifts to `allow`, which
 *    is the whole row.
 *  - the typo arms die if the parse becomes tolerant in the OPEN direction. This
 *    reader deliberately inverts the tolerant-parse rule the rest of the package
 *    follows for preferences: a typo in a RESTRICTION must not silently open it.
 *  - the precedence arm dies if a per-launch env var starts overriding the
 *    reviewed settings file, which would make the reviewed value unverifiable.
 *  - the "settings present but unparseable" arm dies if such a value falls
 *    THROUGH to the env instead of to deny — a value meant to open the gate and
 *    failing to parse must not be replaced by whatever the other scope says.
 */
import { describe, expect, it } from 'bun:test'
import {
  UNATTENDED_APPROVAL_FALLBACK_DEFAULT,
  UNATTENDED_APPROVAL_FALLBACK_ENV_VAR,
  UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY,
  describeUnattendedApprovalRefusal,
  resolveUnattendedApprovalFallback,
} from '../unattended-approval.ts'

const KEY = UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY

describe('P6.531 · the shipped default is deny', () => {
  it('denies with nothing set anywhere', () => {
    expect(UNATTENDED_APPROVAL_FALLBACK_DEFAULT).toBe('deny')
    expect(resolveUnattendedApprovalFallback(undefined, {})).toBe('deny')
    expect(resolveUnattendedApprovalFallback({}, {})).toBe('deny')
    expect(resolveUnattendedApprovalFallback(null, {})).toBe('deny')
  })
})

describe('P6.531 · both scopes open it, and only with a value it recognises', () => {
  it('reads the settings key', () => {
    expect(resolveUnattendedApprovalFallback({ [KEY]: 'allow' }, {})).toBe('allow')
    expect(resolveUnattendedApprovalFallback({ [KEY]: 'deny' }, {})).toBe('deny')
    // Case and surrounding space are an operator typing, not a different value.
    expect(resolveUnattendedApprovalFallback({ [KEY]: '  ALLOW ' }, {})).toBe('allow')
  })

  it('reads the env when the settings key is absent', () => {
    expect(resolveUnattendedApprovalFallback({}, { [UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]: 'allow' }))
      .toBe('allow')
  })

  it.each(['yes', 'true', '1', 'ALLOWED', '', 'off', 'allow-all'])(
    'reads the unrecognised value %p as DENY in the settings scope',
    (value) => {
      expect(resolveUnattendedApprovalFallback({ [KEY]: value }, {})).toBe('deny')
    },
  )

  it.each(['yes', 'true', '1', ''])(
    'reads the unrecognised value %p as DENY in the env scope',
    (value) => {
      expect(resolveUnattendedApprovalFallback({}, { [UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]: value }))
        .toBe('deny')
    },
  )

  it('reads a non-string settings value as DENY', () => {
    for (const value of [true, 1, null, {}, ['allow']]) {
      expect(resolveUnattendedApprovalFallback({ [KEY]: value }, {})).toBe('deny')
    }
  })
})

describe('P6.531 · the reviewed scope outranks the per-launch one', () => {
  it('the settings key wins over the env when both are set', () => {
    expect(resolveUnattendedApprovalFallback(
      { [KEY]: 'deny' },
      { [UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]: 'allow' },
    )).toBe('deny')
    expect(resolveUnattendedApprovalFallback(
      { [KEY]: 'allow' },
      { [UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]: 'deny' },
    )).toBe('allow')
  })

  it('a PRESENT but unparseable settings value denies rather than falling through to the env', () => {
    expect(resolveUnattendedApprovalFallback(
      { [KEY]: 'yes' },
      { [UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]: 'allow' },
    )).toBe('deny')
  })
})

describe('P6.531 · the refusal names what to change', () => {
  it('carries the setting name and the value that would open it', () => {
    const sentence = describeUnattendedApprovalRefusal()
    expect(sentence).toContain(UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY)
    expect(sentence).toContain('"allow"')
    // It must NOT read like a floor refusal: those are non-negotiable, this one
    // is a setting, and a person reading a stopped pipeline has to tell them
    // apart.
    expect(sentence).not.toContain('non-negotiable')
  })
})
