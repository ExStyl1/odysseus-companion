/**
 * P2.409(a) — `doctor` carries the "enforced differently from how it reads"
 * list.
 *
 * P2.398 added the disposition and surfaced it in ONE place:
 * `createStorageRuntime`'s load-time summary, on stderr in the headless server
 * and the main log in the desktop shell. That stream is written once, at boot,
 * and nobody is reading it at the moment their policy misbehaves.
 *
 * `server-managed-settings.md#invalid-entries-in-delivered-settings` names the
 * surface they DO run, and names it as the pre-deployment check: "Validate a
 * payload change with `claude doctor` on a test machine before rolling it out to
 * the organization." (That is the one "test machine" sentence in Claude's whole
 * documentation index, checked 2026-09-10 over the 191-page snapshot in
 * `scripts/claude-doc-pages.tsv`; the file-policy twin of the same check is
 * `managed-settings.md#check-that-a-policy-is-in-force`.) A caveat is exactly
 * what that check is for — the policy parses, deploys cleanly, and enforces a
 * different scope from the one written.
 *
 * The remedy line is the page's own,
 * `managed-mcp.md#how-policy-entries-expand` (anchor read off the RENDERED page
 * with `curl https://code.claude.com/docs/en/managed-mcp` and a grep for
 * `id="…"`, `#how-a-server-is-evaluated` and
 * `#how-restrictions-appear-to-users` as positive controls on the same fetch):
 * "Because a policy entry still depends on the launching shell's value for any
 * variable it references, use literal URLs and commands for entries you rely on
 * for enforcement."
 *
 * ## The renderer is NOT the other half of this row
 *
 * P2.409(b) asked whether an entry-level caveat should reach
 * `apps/electron/src/renderer/lib/capability-catalog.ts`'s MCP server rows. It
 * should not, and the three reasons are recorded in `config-doctor.ts`'s
 * `caveatLines` docblock beside the surface that does carry it. The shortest of
 * them is the one this file can assert: both dispositions manifest as a server
 * row that is ABSENT, so a per-row field has nothing to attach to.
 */
import { describe, expect, it } from 'bun:test'
import {
  buildConfigDoctorReport,
  type ConfigDoctorInputV1,
} from '@nessy-agent/shared/config/config-doctor'
import {
  DEFAULT_MANAGED_PI_POLICY,
  collectManagedPolicyCaveats,
  formatManagedPolicyCaveat,
  formatManagedPolicyCaveatSummary,
  parseManagedPiPolicyV1,
  type ManagedPiPolicyV1,
  type ManagedPolicyCaveatV1,
} from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { collectConfigDoctorInput } from '../managed-policy-resolution.ts'

/** A clean report with nothing else in it, so a finding can only be the caveats. */
const CLEAN: ConfigDoctorInputV1 = Object.freeze({
  drops: [],
  winner: 'file' as const,
  fileCarriesSettings: true,
})

/** The entry an administrator wrote: a URL whose host a variable decides. */
const STEERABLE_URL = 'https://${MCP_HOST}/api/*'

const ALLOW_CAVEAT: ManagedPolicyCaveatV1 = Object.freeze({
  field: 'allowedMcpServers[0]',
  entry: STEERABLE_URL,
  disposition: 'retained-admitting-nothing' as const,
})

const DENY_CAVEAT: ManagedPolicyCaveatV1 = Object.freeze({
  field: 'deniedMcpServers[0]',
  entry: STEERABLE_URL,
  disposition: 'retained-widened' as const,
})

describe('P2.409(a) — the doctor report carries the caveats', () => {
  it('renders both dispositions and closes on the page\'s remedy', () => {
    const report = buildConfigDoctorReport({ ...CLEAN, caveats: [ALLOW_CAVEAT, DENY_CAVEAT] })
    expect(report.text).toContain('Managed entries enforced differently (2):')
    // The per-entry line is the SAME renderer the boot summary uses, asserted
    // verbatim rather than by keyword: a second wording here is how one surface
    // starts describing an entry differently from the other.
    expect(report.text).toContain(formatManagedPolicyCaveat(ALLOW_CAVEAT))
    expect(report.text).toContain(formatManagedPolicyCaveat(DENY_CAVEAT))
    // …and the counter-intuitive half of each is inside that line, which is the
    // whole reason P2.398 gave each disposition a sentence instead of a name.
    expect(report.text).toContain('admits NOTHING')
    expect(report.text).toContain('blocks MORE than the text describes')
    expect(report.text).toContain('Use literal URLs and commands for entries you rely on for enforcement')
  })

  it('is a finding, so the pre-deployment check on a test machine catches it', () => {
    // The pre-deployment check named in this file's docblock
    // (`server-managed-settings.md#invalid-entries-in-delivered-settings`) is
    // only useful if it can FAIL. The control is
    // the same input with no caveats: a clean policy must not trip it.
    expect(buildConfigDoctorReport({ ...CLEAN, caveats: [DENY_CAVEAT] }).hasFindings).toBe(true)
    expect(buildConfigDoctorReport({ ...CLEAN, caveats: [] }).hasFindings).toBe(false)
  })

  it('separates "none" from "I could not look"', () => {
    // The rule the neighbouring sections already follow, and the two answers are
    // not the same: an empty list says the policy is clean, an absent one says
    // no policy could be resolved.
    expect(buildConfigDoctorReport({ ...CLEAN, caveats: [] }).text)
      .toContain('Managed entries enforced differently:\n  none')
    expect(buildConfigDoctorReport(CLEAN).text)
      .not.toContain('Managed entries enforced differently')
  })

  it('does not fold the caveats into the invalid-entry list', () => {
    // `ManagedPolicyDropV1`'s three dispositions all mean *not applied*, and
    // neither of these is a drop — the deny side is applied MORE broadly than
    // written. Filing them under "invalid managed entries" would tell an
    // administrator something false about their own policy.
    const report = buildConfigDoctorReport({ ...CLEAN, caveats: [DENY_CAVEAT] })
    expect(report.text).toContain('Invalid managed entries:\n  none')
  })

  it('says the same thing the boot summary says', () => {
    // The equivalence pinned from OUTSIDE both, through the shared renderer,
    // rather than by comparing two private format strings.
    const summary = formatManagedPolicyCaveatSummary([ALLOW_CAVEAT, DENY_CAVEAT])
    const report = buildConfigDoctorReport({ ...CLEAN, caveats: [ALLOW_CAVEAT, DENY_CAVEAT] })
    expect(summary).toBeDefined()
    for (const caveat of [ALLOW_CAVEAT, DENY_CAVEAT]) {
      const line = formatManagedPolicyCaveat(caveat)
      expect(summary).toContain(line)
      expect(report.text).toContain(line)
    }
  })
})

describe('P2.409(a) — the collector supplies them end to end', () => {
  const steerablePolicy = (): ManagedPiPolicyV1 => parseManagedPiPolicyV1({
    schemaVersion: 1,
    disabledPermissionModes: [],
    allowedMcpServers: [{ serverUrl: STEERABLE_URL }],
    deniedMcpServers: [{ serverUrl: STEERABLE_URL }],
  })

  it('reads them from the composed policy that actually runs', () => {
    const input = collectConfigDoctorInput({
      file: () => ({ policy: DEFAULT_MANAGED_PI_POLICY, drops: [] }),
      delivered: steerablePolicy,
    })
    // Composition is winner-takes-all, so a delivered payload's entries are the
    // ones reported — the property `resolveEnforcedManagedPolicy` already owns,
    // asserted here because the collector could have re-derived them from the
    // file and looked correct on an unmanaged machine.
    expect(input.caveats?.map(caveat => caveat.disposition))
      .toEqual(['retained-admitting-nothing', 'retained-widened'])
    expect(input.caveats).toEqual(collectManagedPolicyCaveats(steerablePolicy()))
    expect(buildConfigDoctorReport(input).text)
      .toContain('Managed entries enforced differently (2):')
  })

  it('reports none for a policy written the way the page prescribes', () => {
    // The positive control on the same rig: a LITERAL entry — "use literal URLs
    // and commands for entries you rely on for enforcement" — earns no caveat,
    // which is what keeps this diagnostic off every policy already deployed.
    const input = collectConfigDoctorInput({
      file: () => ({
        policy: parseManagedPiPolicyV1({
          schemaVersion: 1,
          disabledPermissionModes: [],
          deniedMcpServers: [{ serverUrl: 'https://mcp.example.com/*' }],
        }),
        drops: [],
      }),
      delivered: () => undefined,
    })
    expect(input.caveats).toEqual([])
    expect(buildConfigDoctorReport(input).text).toContain('Managed entries enforced differently:\n  none')
  })
})
