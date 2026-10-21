/**
 * P6.531's residue — the unattended-approval fallback becomes a MANAGED key, so
 * it is scored for enforcement like every other one.
 *
 * Hand-off from W8-f, whose `done_means` asked for exactly this and whose lane
 * held neither half of the rule-15 pair. The setting itself already shipped
 * (`config/unattended-approval.ts`, `61d6c51ca`); what was missing was an
 * administrator's ability to pin it, and a verdict in the claude enforcement
 * partition saying why nothing is projected.
 *
 * WHAT EACH TEST KILLS:
 *  - the pin arm dies if the managed value stops out-ranking the operator's own
 *    settings key, which is the whole point of registering it.
 *  - the widening arm dies if a managed `allow` starts GRANTING on its own. A
 *    floor that hands capability out is not a floor.
 *  - the typo arm dies if an unrecognised managed value reads as anything but
 *    the enforcing pole, and asserts the drop is reported as a TIGHTENING rather
 *    than as a strip, because those tell an administrator different things.
 *  - the partition arm dies if the key is registered on one side of the pair and
 *    not the other.
 */
import { describe, expect, test } from 'bun:test'
import {
  MANAGED_PI_POLICY_KEYS,
  parseManagedPiPolicyTolerantV1,
  parseManagedPiPolicyV1,
} from './managed-policy.ts'
import { mapManagedPolicyToClaudeSettings } from '../claude-managed-settings.ts'
import {
  resolveUnattendedApprovalFallback,
  UNATTENDED_APPROVAL_FALLBACK_ENV_VAR as ENV_VAR,
  UNATTENDED_APPROVAL_FALLBACK_SETTING_KEY as KEY,
} from '../../config/unattended-approval.ts'

const base = { schemaVersion: 1 } as const

describe('P6.531 residue — the managed unattended-approval floor', () => {
  test('a managed deny out-ranks the operator settings key AND the env', () => {
    // The positive case, and the reason the key exists: an administrator can pin
    // the restriction where an operator cannot lift it.
    const policy = parseManagedPiPolicyV1({ ...base, unattendedApprovalFallback: 'deny' })
    expect(policy.unattendedApprovalFallback).toBe('deny')
    expect(resolveUnattendedApprovalFallback(
      { [KEY]: 'allow' }, { [ENV_VAR]: 'allow' }, policy.unattendedApprovalFallback,
    )).toBe('deny')
  })

  test('a managed allow grants nothing on its own — it narrows only', () => {
    // The boundary case. `allow` is the widening pole, so the managed layer must
    // not be able to open the gate for an operator who did not ask; the
    // settings/env chain still decides, and its own default is deny.
    const policy = parseManagedPiPolicyV1({ ...base, unattendedApprovalFallback: 'allow' })
    expect(policy.unattendedApprovalFallback).toBe('allow')
    expect(resolveUnattendedApprovalFallback({}, {}, policy.unattendedApprovalFallback)).toBe('deny')
    // ...and it does not get in the way of an operator who DID ask.
    expect(resolveUnattendedApprovalFallback({ [KEY]: 'allow' }, {}, 'allow')).toBe('allow')
    // An absent managed key is the same as no managed layer at all.
    expect(parseManagedPiPolicyV1(base).unattendedApprovalFallback).toBeUndefined()
    expect(resolveUnattendedApprovalFallback({ [KEY]: 'allow' }, {}, undefined)).toBe('allow')
  })

  test('an unrecognised managed value reads as deny, and says it TIGHTENED', () => {
    // The negative case. A typo in a restriction must not silently open it — the
    // same direction the user-scope parser takes, for the same reason.
    for (const bad of ['Allow', 'ALLOW', 'yes', true, 1, null, {}]) {
      const parsed = parseManagedPiPolicyTolerantV1(
        { ...base, unattendedApprovalFallback: bad }, { source: 'test' },
      )
      expect({ bad, value: parsed.policy.unattendedApprovalFallback })
        .toEqual({ bad, value: 'deny' })
      const drop = parsed.drops.find(d => d.field === 'unattendedApprovalFallback')
      // Reported, not swallowed: an administrator who wrote `"Allow"` learns the
      // key was refused instead of discovering it when a pipeline stops.
      expect({ bad, disposition: drop?.disposition }).toEqual({ bad, disposition: 'tightened' })
      expect(drop?.reason).toContain('unattendedApprovalFallback')
    }
    // The strict tier still throws rather than reinterpreting silently.
    expect(() => parseManagedPiPolicyV1({ ...base, unattendedApprovalFallback: 'Allow' })).toThrow()
  })

  test('the key is registered on BOTH sides of the pair (rule 15)', () => {
    // Registered in the policy vocabulary...
    expect(MANAGED_PI_POLICY_KEYS).toContain('unattendedApprovalFallback')
    // ...and SCORED in the claude enforcement partition, which is the half
    // `done_means` names. Every policy key is either mapped or carries a gap
    // entry with the reason it is not; a key registered on the policy side alone
    // would appear in neither, and the partition test beside this one fails.
    const mapping = mapManagedPolicyToClaudeSettings(
      parseManagedPiPolicyV1({ ...base, unattendedApprovalFallback: 'deny' }),
    )
    const gap = mapping.unsupported.find(entry => entry.key === 'unattendedApprovalFallback')
    expect(gap?.kind).toBe('enforced-elsewhere')
    // Not mapped, and that is deliberate: no vendor key names this question, so
    // an emission would be a silent drop.
    expect(mapping.mapped).not.toContain('unattendedApprovalFallback')
  })
})
