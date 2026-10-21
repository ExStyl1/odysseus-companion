import { describe, expect, it } from 'bun:test'
import {
  collectConfigDoctorInput,
  collectMandatedPluginFindingsFromEnforcedPolicy,
  resolveEnforcedManagedPolicy,
} from '../managed-policy-resolution'
import type { ManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'

const FILE_POLICY: ManagedPiPolicyV1 = Object.freeze({
  ...DEFAULT_MANAGED_PI_POLICY,
  deniedMcpServers: Object.freeze([{ serverName: 'from-file' }]),
})

const DELIVERED_POLICY: ManagedPiPolicyV1 = Object.freeze({
  ...DEFAULT_MANAGED_PI_POLICY,
  deniedMcpServers: Object.freeze([{ serverName: 'from-server' }]),
})

describe('managed policy resolution carries its own provenance', () => {
  it('labels the file source and reports the file as carrying settings', () => {
    const enforced = resolveEnforcedManagedPolicy({
      file: () => ({ policy: FILE_POLICY, drops: [] }),
      delivered: () => undefined,
    })
    expect(enforced.winner).toBe('file')
    expect(enforced.fileCarriesSettings).toBe(true)
    expect(enforced.policy.deniedMcpServers).toEqual([{ serverName: 'from-file' }])
  })

  it('labels the delivered source, and the label follows the policy that won', () => {
    // The property that matters is that the two cannot disagree: whichever
    // policy comes back is the one the label names.
    const enforced = resolveEnforcedManagedPolicy({
      file: () => ({ policy: FILE_POLICY, drops: [] }),
      delivered: () => DELIVERED_POLICY,
    })
    expect(enforced.winner).toBe('delivered')
    expect(enforced.policy.deniedMcpServers).toEqual([{ serverName: 'from-server' }])
    expect(enforced.fileCarriesSettings).toBe(true)
  })

  it('reports `none` when neither source carries a setting', () => {
    const enforced = resolveEnforcedManagedPolicy({
      file: () => ({ policy: DEFAULT_MANAGED_PI_POLICY, drops: [] }),
      delivered: () => undefined,
    })
    expect(enforced.winner).toBe('none')
    expect(enforced.fileCarriesSettings).toBe(false)
  })
})

describe('collectConfigDoctorInput', () => {
  it('carries the drops, the winner and the shadowing flag through unchanged', () => {
    const input = collectConfigDoctorInput({
      file: () => ({
        policy: FILE_POLICY,
        drops: [{
          source: '/etc/nessy/managed-policy.json',
          field: 'workflow',
          reason: 'invalid managed workflow settings',
          disposition: 'stripped',
        }],
      }),
      delivered: () => DELIVERED_POLICY,
    })
    expect(input.winner).toBe('delivered')
    expect(input.fileCarriesSettings).toBe(true)
    expect(input.drops).toHaveLength(1)
    expect(input.drops[0]!.field).toBe('workflow')
  })

  it('does not throw when the managed policy file itself is unloadable', () => {
    // `settings-reference.md#requiredminimumversion` ("`claude update`, `claude
    // install`, and `claude doctor` keep working below the floor so users can
    // recover") and `#requiredmaximumversion` keep `claude doctor` working when
    // the app refuses to start, and `managed-policy-loader` still fails closed
    // on a file-level defect. A diagnosis tool that crashes on the defect it exists to name is
    // not a tool — so the failure becomes a whole-document drop.
    const input = collectConfigDoctorInput({
      file: () => { throw new Error('managed-pi-policy-invalid') },
      delivered: () => undefined,
    })
    expect(input.drops).toHaveLength(1)
    expect(input.drops[0]!.field).toBe('')
    expect(input.drops[0]!.reason).toBe('managed-pi-policy-invalid')
    expect(input.winner).toBe('none')
    expect(input.fileCarriesSettings).toBe(false)
  })

  it('still names the delivered source when the file load failed', () => {
    // The two sources are independent. Reporting `none` because the FILE broke
    // would tell an administrator that no policy applies while a remote one is
    // being enforced.
    const input = collectConfigDoctorInput({
      file: () => { throw new Error('managed-pi-policy-invalid') },
      delivered: () => DELIVERED_POLICY,
    })
    expect(input.winner).toBe('delivered')
    expect(input.drops).toHaveLength(1)
  })

  it('survives a delivered read that throws as well', () => {
    const input = collectConfigDoctorInput({
      file: () => { throw new Error('managed-pi-policy-invalid') },
      delivered: () => { throw new Error('cache unreadable') },
    })
    expect(input.winner).toBe('none')
    expect(input.drops).toHaveLength(1)
  })

  it('reports the effective sandbox network policy from the ENFORCED policy', () => {
    // The doctor must describe the composition the process supervisor is built
    // from, not a second derivation of it — so the delivered policy that wins
    // above is the one whose network section shows up here.
    const input = collectConfigDoctorInput({
      file: () => ({
        policy: { ...FILE_POLICY, sandbox: { network: { deniedDomains: ['from-file.example'] } } },
        drops: [],
      }),
      delivered: () => ({
        ...DELIVERED_POLICY,
        sandbox: { network: { allowedDomains: ['corp.example'], allowManagedDomainsOnly: true } },
      }),
    })
    expect(input.winner).toBe('delivered')
    expect(input.sandboxNetwork?.enforcement.egress).toBe('denied')
    expect(input.sandboxNetwork?.settings.allowedDomains).toEqual(['corp.example'])
    expect(input.sandboxNetwork?.settings.deniedDomains).not.toContain('from-file.example')
    expect(input.sandboxNetwork?.fromManagedSettings).toBe(true)
  })

  it('reports the open default without naming a source', () => {
    const input = collectConfigDoctorInput({
      file: () => ({ policy: DEFAULT_MANAGED_PI_POLICY, drops: [] }),
      delivered: () => undefined,
    })
    expect(input.sandboxNetwork?.enforcement.egress).toBe('open')
    expect(input.sandboxNetwork?.enforcement.unenforceable).toEqual([])
    expect(input.sandboxNetwork?.fromManagedSettings).toBe(false)
  })

  it('reports the T1 sandbox.enabled master switch from the SAME composition the supervisor is built from', () => {
    // A fresh install (no config anywhere) resolves to false —
    // SANDBOX_ENABLED_DEFAULT, per the same `resolveHostSandboxSettings` the
    // process supervisor reads.
    const off = collectConfigDoctorInput({
      file: () => ({ policy: DEFAULT_MANAGED_PI_POLICY, drops: [] }),
      delivered: () => undefined,
    })
    expect(off.sandboxEnabled).toBe(false)

    const on = collectConfigDoctorInput({
      file: () => ({ policy: { ...DEFAULT_MANAGED_PI_POLICY, sandbox: { enabled: true } }, drops: [] }),
      delivered: () => undefined,
    })
    expect(on.sandboxEnabled).toBe(true)
  })
})

/**
 * P6.788 — the enforced-policy wiring the mandate collector needs, in ONE place.
 *
 * It was written out three times (`apps/cli/src/doctor.ts`, the
 * `GET_CONFIG_DOCTOR` handler, `SessionManager`), each with its own `catch`, and
 * only one of those catches covered the collector as well as the resolve. What
 * is asserted here is the `catch`, because that is the part that decides what an
 * administrator is TOLD: `undefined` omits the section, an array claims the
 * machine was inspected.
 */
describe('the mandate collector reads the enforced policy through one seam', () => {
  const MANDATED_KEY = 'p6788-sentinel-marketplace.p6788-sentinel-plugin'

  it('hands the collector the ENFORCED map, not the file policy alone', () => {
    // Delivered wins the tier, so a mandate that reached the fleet by delivery is
    // the one reported — the composition, never one source.
    const findings = collectMandatedPluginFindingsFromEnforcedPolicy({
      file: () => ({ policy: FILE_POLICY, drops: [] }),
      delivered: () => Object.freeze({
        ...DEFAULT_MANAGED_PI_POLICY,
        enabledPlugins: Object.freeze({ [MANDATED_KEY]: true }),
      }),
    })
    expect(findings).toBeDefined()
    const mandate = findings?.find(finding => finding.pluginKey === MANDATED_KEY)
    expect(mandate?.state).toBe('not-installed')
  })

  it('answers "I could not look" — not "no mandate exists" — when the policy cannot be resolved', () => {
    // The whole reason the wiring has a `catch`. An unresolvable managed policy
    // that rendered as an empty finding list would tell an administrator their
    // mandate is fine on a machine nothing was read from.
    const findings = collectMandatedPluginFindingsFromEnforcedPolicy({
      file: () => { throw new Error('managed-pi-policy-invalid') },
      delivered: () => undefined,
    })
    expect(findings).toBeUndefined()
  })
})
