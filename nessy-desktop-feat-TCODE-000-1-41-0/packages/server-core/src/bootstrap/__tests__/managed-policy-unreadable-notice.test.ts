/**
 * P6.246(a) — an unreadable managed policy is legible to the operator.
 *
 * The defect at HEAD was not that the throw was lost: it was CAUGHT, at the
 * desktop shell's version-gate call site, and degraded to `mainLog.warn`. Three
 * consequences, and the third is why a warning was not enough — the admin
 * version floor was skipped, startup continued, and a packaged build writes
 * nothing outside debug mode, so no operator saw the line at all.
 *
 * These assertions pin the CLASSIFIER. The call site's own branch (error box,
 * `app.exit(1)`) is Electron main-process code with no test harness in this
 * tree; the classifier is the half that can be pinned, and it is the half that
 * decides.
 */
import { describe, expect, it } from 'bun:test'
import { ManagedSettingsStartupError } from '../headless-start.ts'
import { managedPolicyUnreadableNotice } from '../managed-policy-resolution.ts'

describe('managedPolicyUnreadableNotice', () => {
  it('names the absolute policy file for the loader\'s own fail-closed throw', () => {
    const notice = managedPolicyUnreadableNotice(new Error('managed-pi-policy-invalid'), 'darwin')
    expect(notice?.reason).toBe('managed-pi-policy-invalid')
    expect(notice?.title).toBe('Managed policy could not be read')
    // The absolute path is the only thing the operator can act on.
    expect(notice?.message).toContain('/Library/Application Support/Nessy/managed-policy.json')
    expect(notice?.message).toContain('administrator')
  })

  it('is undefined for a version refusal, which already has its own branch', () => {
    // By NAME, not `instanceof`: `headless-start.ts` imports the module this
    // function lives in, so importing the class back would close a cycle. The
    // real class is used here so the name check cannot drift silently.
    const refusal = new ManagedSettingsStartupError('below-floor', 'Update through your organisation.')
    expect(refusal.name).toBe('ManagedSettingsStartupError')
    expect(managedPolicyUnreadableNotice(refusal, 'darwin')).toBeUndefined()
  })

  it('is undefined for an incidental error, which must keep degrading to a warning', () => {
    // The negative control. A classifier that answered every error would turn
    // any startup hiccup into a fatal dialog, which is worse than the defect.
    expect(managedPolicyUnreadableNotice(new Error('ENOENT: something else'), 'darwin')).toBeUndefined()
    expect(managedPolicyUnreadableNotice('managed-pi-policy-invalid', 'darwin')).toBeUndefined()
    expect(managedPolicyUnreadableNotice(undefined, 'darwin')).toBeUndefined()
  })

  it('still produces a notice when the path lookup itself cannot resolve', () => {
    // `managedPiPolicyPathForPlatform` throws the SAME `managed-pi-policy-invalid`
    // on win32 without an absolute `%ProgramFiles%`. A notice whose own lookup
    // threw would turn a legible refusal back into a crash at the call site.
    const notice = managedPolicyUnreadableNotice(new Error('managed-pi-policy-invalid'), 'win32', '')
    expect(notice?.title).toBe('Managed policy could not be read')
    expect(notice?.message).toContain('the managed policy file in the system directory')
    // The positive control on the same platform: a real ProgramFiles resolves.
    const resolved = managedPolicyUnreadableNotice(
      new Error('managed-pi-policy-invalid'), 'win32', 'C:\\Program Files',
    )
    expect(resolved?.message).toContain('managed-policy.json')
  })
})
