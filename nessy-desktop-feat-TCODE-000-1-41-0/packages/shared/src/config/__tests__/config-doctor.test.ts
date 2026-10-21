import { describe, expect, it } from 'bun:test'
import {
  INSTRUCTION_FILE_TRIM_LINE_LIMIT,
  SETTINGS_PROVENANCE_COMBINE,
  SETTINGS_PROVENANCE_FAMILY_KEYS,
  buildConfigDoctorReport,
  buildSettingsTiersSessionClauses,
  buildSettingsTiersSessionLine,
  classifySettingsProvenanceEntry,
  describeManagedDeliveryOutcome,
  instructionFileSections,
  redactProxyUrl,
  shadowedManagedFileWarning,
  type ConfigDoctorInputV1,
  type NetworkTrustDoctorInputV1,
} from '../config-doctor.ts'
import { INSTRUCTION_EXCLUDE_SETTING_KEYS } from '../../agent/memory/instruction-excludes.ts'
import { REJECTED_LAYER_REASON_MAX, type ManagedPolicyDropV1 } from '../managed-drops.ts'
import type { UserScopeAutoModeReadV1 } from '../../agent/pi-harness/user-auto-mode-policy.ts'
import { documentedUncarriedSandboxKeys, resolveSandboxNetworkEnforcement } from '../sandbox-settings.ts'

const CLEAN: ConfigDoctorInputV1 = {
  drops: [],
  winner: 'file',
  fileCarriesSettings: true,
  filePath: '/etc/nessy/managed-policy.json',
}

function drop(overrides: Partial<ManagedPolicyDropV1> = {}): ManagedPolicyDropV1 {
  return {
    source: '/etc/nessy/managed-policy.json',
    field: 'deniedMcpServers[1]',
    reason: 'invalid managed Pi policy denied MCP server',
    disposition: 'stripped',
    ...overrides,
  }
}

describe('config doctor report', () => {
  it('names the active managed source with the documented channel word', () => {
    // `managed-settings.md#read-the-source-in-/status` — the `Setting sources`
    // line "lists `Enterprise managed settings` with the source Claude Code
    // selected in parentheses", `(remote)` and `(file)` among them.
    expect(buildConfigDoctorReport(CLEAN).text).toContain('Managed settings (file)')
    expect(buildConfigDoctorReport({ ...CLEAN, winner: 'delivered' }).text)
      .toContain('Managed settings (remote)')
    expect(buildConfigDoctorReport({ ...CLEAN, winner: 'none', fileCarriesSettings: false }).text)
      .toContain('No managed settings source is in effect')
  })

  it('a clean configuration is not a finding', () => {
    const report = buildConfigDoctorReport(CLEAN)
    expect(report.hasFindings).toBe(false)
    expect(report.text).toContain('Invalid managed entries:\n  none')
    expect(report.text).toContain('Rejected settings layers:\n  none')
  })

  it('shows the enforced model allowlist, and does not call it a finding', () => {
    // `settings-reference.md#availablemodels` with
    // `settings-reference.md#enforceavailablemodels`. A valid allowlist is a working policy, not a
    // problem, so it must never move `hasFindings` — but it is the only enforced
    // policy an administrator cannot read back from any other surface, which is
    // what a restricted user's ticket needs.
    expect(buildConfigDoctorReport(CLEAN).text)
      .toContain('no managed allowlist — every model in a connection is selectable')

    const enforced = buildConfigDoctorReport({
      ...CLEAN,
      availableModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
      enforceAvailableModels: true,
    })
    expect(enforced.hasFindings).toBe(false)
    expect(enforced.text).toContain('Model allowlist:\n  2 entries enforced:')
    expect(enforced.text).toContain('  - claude-sonnet-4-5')
    expect(enforced.text).toContain('Default model: constrained to this list')

    expect(buildConfigDoctorReport({ ...CLEAN, availableModels: ['claude-haiku-4-5'] }).text)
      .toContain('Default model: unconstrained')
  })

  it('distinguishes a deployed empty allowlist from no allowlist at all', () => {
    // `managed-settings.md#keys-that-fail-closed` enforces an INVALID
    // `availableModels` as an empty allowlist — "so only the Default model is
    // available" — which looks identical
    // to a working policy from the outside. This section is where the two come
    // apart, so it points at the invalid-entry list rather than just saying
    // "empty".
    const report = buildConfigDoctorReport({ ...CLEAN, availableModels: [] })
    expect(report.text).toContain('empty allowlist — no named model is selectable')
    expect(report.text).toContain('An invalid availableModels value is enforced this way')
    expect(report.hasFindings).toBe(false)
  })

  it('sanitizes an allowlist entry like every other document value', () => {
    // An entry is arbitrary document text on a path that ends at a terminal.
    const report = buildConfigDoctorReport({
      ...CLEAN,
      availableModels: ['claude\u001b[31m-sonnet\n- injected: line'],
    })
    expect(report.text).not.toContain('\u001b')
    expect(report.text.split('\n').filter(line => line.includes('injected'))).toHaveLength(1)
  })

  it('lists each invalid entry with its source and field', () => {
    // `managed-settings.md#invalid-entries-in-managed-settings` — "[`claude
    // doctor`](/docs/en/debug-your-config) lists each invalid entry with its
    // source and field", the two fields the listing must carry.
    const report = buildConfigDoctorReport({ ...CLEAN, drops: [drop(), drop({ field: 'workflow' })] })
    expect(report.hasFindings).toBe(true)
    expect(report.text).toContain('Invalid managed entries (2):')
    expect(report.text).toContain('/etc/nessy/managed-policy.json: deniedMcpServers[1]')
    expect(report.text).toContain('/etc/nessy/managed-policy.json: workflow')
  })

  it('reports a delivered payload shadowing a file policy that carries settings', () => {
    // The cleared-console paragraph of
    // `server-managed-settings.md#settings-precedence` — the state an admin
    // reaches by clearing the console configuration and expecting the file to
    // take over.
    const report = buildConfigDoctorReport({ ...CLEAN, winner: 'delivered', fileCarriesSettings: true })
    expect(report.hasFindings).toBe(true)
    expect(report.text).toContain('carries settings and none of them apply')
    expect(report.text).toContain('server-managed-settings.md#settings-precedence')
  })

  it('does not warn when the shadowed file carries nothing, or when the file won', () => {
    expect(shadowedManagedFileWarning('delivered', false)).toBeUndefined()
    expect(shadowedManagedFileWarning('file', true)).toBeUndefined()
    expect(shadowedManagedFileWarning('none', false)).toBeUndefined()
    expect(buildConfigDoctorReport({
      ...CLEAN,
      winner: 'delivered',
      fileCarriesSettings: false,
    }).hasFindings).toBe(false)
  })

  it('lists a rejected strict-tier layer and counts it as a finding', () => {
    // `settings.md#fix-a-broken-settings-file` — "After you continue, run
    // `/status` to see the affected files and `claude doctor` for the details
    // of each error."
    const report = buildConfigDoctorReport({
      ...CLEAN,
      rejectedLayers: [{
        source: '/home/u/.nessy-agent/config.json',
        key: 'worktree',
        reason: 'invalid worktree settings',
      }],
    })
    expect(report.hasFindings).toBe(true)
    expect(report.text).toContain('Rejected settings layers (1):')
    expect(report.text).toContain('/home/u/.nessy-agent/config.json: worktree')
    expect(report.text).toContain('[layer rejected whole]')
  })

  it('renders a rejected layer reason to the type\'s own cap, not a literal (P6.639)', () => {
    // The field has two halves — a producer in `config/storage.ts` writes it, this
    // renderer reads it — and until P6.639 each half carried its own number. A
    // reason one character under the cap has to arrive whole: at the managed-drop
    // default of 200 the disclosure P3.373 put in the user `env` refusal is cut
    // exactly where it names the divergence.
    const reason = `${'r'.repeat(REJECTED_LAYER_REASON_MAX - 2)}END`.slice(0, REJECTED_LAYER_REASON_MAX - 1)
    expect(reason).toHaveLength(REJECTED_LAYER_REASON_MAX - 1)
    const report = buildConfigDoctorReport({
      ...CLEAN,
      rejectedLayers: [{ source: '/home/u/.nessy-agent/config.json', key: 'env', reason }],
    })
    expect(report.text).toContain(reason)
    expect(report.text).not.toContain('…')

    // Boundary: one character OVER the cap is the first that loses anything, and
    // what survives is exactly the cap — an ellipsis replaces the last character,
    // so the rendered reason never grows past the number the constant states.
    const over = 'o'.repeat(REJECTED_LAYER_REASON_MAX + 1)
    const truncated = buildConfigDoctorReport({
      ...CLEAN,
      rejectedLayers: [{ source: '/home/u/.nessy-agent/config.json', key: 'env', reason: over }],
    })
    const rendered = truncated.text.split('\n')
      .find(line => line.includes('config.json: env'))
    expect(rendered).toBeDefined()
    const body = rendered!.slice(rendered!.indexOf('env — ') + 'env — '.length)
      .replace(' [layer rejected whole]', '')
    expect(body).toHaveLength(REJECTED_LAYER_REASON_MAX)
    expect(body.endsWith('…')).toBe(true)
  })

  it('omits the sandbox network section when the host could not resolve one', () => {
    expect(buildConfigDoctorReport(CLEAN).text).not.toContain('Sandbox network policy:')
  })

  it('names the documented sandbox keys it accepts and carries nowhere, and does not call them findings (P6.710)', () => {
    // The list is produced by the SAME exported function the session
    // composition reads (`resolveHostSandboxSettings`), never retyped, so the
    // two surfaces cannot name different keys.
    const keys = documentedUncarriedSandboxKeys({
      autoAllowBashOutputRedirect: true,
      network: { strictAllowlist: true },
    })
    expect(keys.length).toBeGreaterThan(0)

    const report = buildConfigDoctorReport({ ...CLEAN, sandboxUncarriedKeys: keys })
    expect(report.text).toContain('Sandbox keys accepted without effect:')
    for (const key of keys) expect(report.text).toContain(key)
    expect(report.text).toContain('Every other key in the same block still applies.')
    // Accepted is not invalid. `sandbox.filesystem.disabled` follows the same
    // rule, and a fleet check must not fail on a key an operator legitimately
    // wrote from the vendor's own documentation.
    expect(report.hasFindings).toBe(false)
  })

  it('omits that section entirely when the block names none of them', () => {
    // The control for the arm above: without it, "the header is present" is
    // compatible with a header that is always present.
    expect(buildConfigDoctorReport({ ...CLEAN, sandboxUncarriedKeys: [] }).text)
      .not.toContain('Sandbox keys accepted without effect:')
    expect(buildConfigDoctorReport(CLEAN).text)
      .not.toContain('Sandbox keys accepted without effect:')
  })

  it('names the effective sandbox egress policy and the setting it came from', () => {
    const report = buildConfigDoctorReport({
      ...CLEAN,
      sandboxNetwork: {
        enforcement: resolveSandboxNetworkEnforcement({
          allowedDomains: ['corp.example'],
          deniedDomains: [],
          allowManagedDomainsOnly: true,
        }),
        settings: { allowedDomains: ['corp.example'], deniedDomains: [], allowManagedDomainsOnly: true },
        fromManagedSettings: true,
      },
    })
    expect(report.text).toContain('Sandbox network policy:')
    expect(report.text).toContain('sandboxed-command egress: DENIED')
    expect(report.text).toContain('source: sandbox.network.allowManagedDomainsOnly, from managed settings')
    expect(report.text).toContain('allowedDomains: corp.example')
    // The point of the section: the entry is configured, composed — and not
    // reachable. An administrator has to learn that here, not from tcpdump.
    expect(report.text).toContain('1 configured domain rule do not bind a sandboxed command:')
    expect(report.hasFindings).toBe(true)
  })

  it('reports an open default as a working policy rather than a finding', () => {
    const report = buildConfigDoctorReport({
      ...CLEAN,
      sandboxNetwork: {
        enforcement: resolveSandboxNetworkEnforcement({
          allowedDomains: [], deniedDomains: [], allowManagedDomainsOnly: false,
        }),
        settings: { allowedDomains: [], deniedDomains: [], allowManagedDomainsOnly: false },
        fromManagedSettings: false,
      },
    })
    expect(report.text).toContain('sandboxed-command egress: open')
    expect(report.text).toContain('source: no sandbox.network policy is in effect')
    expect(report.hasFindings).toBe(false)
  })

  it('omits the retention section when the caller could not resolve one', () => {
    expect(buildConfigDoctorReport(CLEAN).text).not.toContain('Retention cleanup:')
  })

  it('reports a paused retention sweep as a finding, with the reason', () => {
    // `claude-directory.md#cleaned-up-automatically` — a settings file that
    // can't be read or parsed pauses the sweep, and Claude Code "also shows a
    // warning in `/status` until you fix the settings errors". Asserted on the
    // RENDERED report, which is what a user reads.
    const report = buildConfigDoctorReport({
      ...CLEAN,
      retention: {
        sweeps: false,
        state: 'paused',
        warning: 'Retention cleanup is paused because the settings file could not be read or parsed.',
      },
    })
    expect(report.text).toContain('Retention cleanup:')
    expect(report.text).toContain('PAUSED — nothing is being cleaned up')
    expect(report.text).toContain('! Retention cleanup is paused because')
    expect(report.hasFindings).toBe(true)
  })

  it('reports an active window and a deliberate off switch, neither as a finding', () => {
    const active = buildConfigDoctorReport({
      ...CLEAN,
      retention: { sweeps: true, state: 'active', retentionDays: 14, source: 'managed' },
    })
    expect(active.text).toContain('active — data older than 14 days is deleted at startup (from managed settings)')
    expect(active.hasFindings).toBe(false)

    const off = buildConfigDoctorReport({
      ...CLEAN,
      retention: { sweeps: false, state: 'disabled' },
    })
    expect(off.text).toContain('off — nothing is deleted automatically')
    expect(off.hasFindings).toBe(false)
  })

  // P6.359 — the search backend. `troubleshooting.md#search-and-discovery-issues`
  // ends its `USE_BUILTIN_RIPGREP` remedy with a verification step, verbatim:
  // "run `claude doctor` in your terminal and check that the Search line shows
  // the path of your system ripgrep instead of `OK (bundled)`." There was no
  // Search line on any runtime, so the resolved binary was unobservable.

  it('names the vendored ripgrep in the documented words', () => {
    const report = buildConfigDoctorReport({
      ...CLEAN,
      searchBackend: {
        isPackaged: true,
        ripgrepPath: '/Applications/Nessy.app/Contents/node_modules/@vscode/ripgrep/bin/rg',
      },
    })
    expect(report.text).toContain('Search backend:')
    // The page's own phrase, so an operator following it recognises the answer.
    expect(report.text).toContain('OK (bundled)')
    expect(report.text).toContain('/@vscode/ripgrep/bin/rg')
    // A resolved binary is a working configuration, not something to act on.
    expect(report.hasFindings).toBe(false)
  })

  it('classifies a Windows vendored path without a node:path import', () => {
    // The boundary the forward-slash literal would miss. This module is reachable
    // from the renderer, so the separator is normalised rather than imported.
    const report = buildConfigDoctorReport({
      ...CLEAN,
      searchBackend: {
        isPackaged: false,
        ripgrepPath: 'C:\\app\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe',
      },
    })
    expect(report.text).toContain('OK (bundled)')
    expect(report.text).not.toContain('system —')
  })

  it('names a system ripgrep as system, which is what the page tells the user to look for', () => {
    const report = buildConfigDoctorReport({
      ...CLEAN,
      searchBackend: { isPackaged: false, ripgrepPath: '/opt/homebrew/bin/rg' },
    })
    expect(report.text).toContain('system — /opt/homebrew/bin/rg')
    expect(report.text).not.toContain('OK (bundled)')
    expect(report.hasFindings).toBe(false)
  })

  it('says search is unavailable when nothing resolved, and still does not fail the exit code', () => {
    const packaged = buildConfigDoctorReport({
      ...CLEAN,
      searchBackend: { isPackaged: true },
    })
    expect(packaged.text).toContain('! not resolved — session search is unavailable on this host')
    // The packaged arm must name the deliberate PATH refusal, or the operator
    // reads a missing binary as a broken PATH and "fixes" it by installing rg.
    expect(packaged.text).toContain('PATH is deliberately not consulted')
    // Machine-local tooling, not a policy an administrator deployed wrongly:
    // the exit code gates a policy push
    // (`server-managed-settings.md#invalid-entries-in-delivered-settings`).
    expect(packaged.hasFindings).toBe(false)

    const headless = buildConfigDoctorReport({ ...CLEAN, searchBackend: { isPackaged: false } })
    expect(headless.text).toContain('nor a system rg on PATH was found')
    expect(headless.text).not.toContain('PATH is deliberately not consulted')
  })

  it('omits the search section when the caller did not look', () => {
    // "Could not look" and "looked and found none" are different answers — the
    // same distinction the caveats and retention sections already draw.
    expect(buildConfigDoctorReport(CLEAN).text).not.toContain('Search backend:')
  })

  it('omits the sandbox section when the host could not resolve one (T1 contour f)', () => {
    expect(buildConfigDoctorReport(CLEAN).text).not.toContain('Sandbox:')
  })

  it('reports the master switch as disabled by config default, and does not call it a finding', () => {
    // T1 owner decision 2026-08-12: a deliberate off switch is a setting, not
    // a fault — the same rule retention's `disabled` state and
    // `sandbox.filesystem.disabled` already follow in this report.
    const report = buildConfigDoctorReport({ ...CLEAN, sandboxEnabled: false })
    expect(report.text).toContain('Sandbox:')
    expect(report.text).toContain('disabled (config default)')
    expect(report.hasFindings).toBe(false)
  })

  it('reports the master switch as enabled when a layer turned it on', () => {
    const report = buildConfigDoctorReport({ ...CLEAN, sandboxEnabled: true })
    expect(report.text).toContain('Sandbox:')
    expect(report.text).toContain('enabled')
    expect(report.text).not.toContain('disabled (config default)')
    expect(report.hasFindings).toBe(false)
  })

  it('strips control characters out of every settings-derived string it renders', () => {
    // Same threat as the startup summary: a policy author controls `field` and
    // `reason`, and both reach a terminal.
    const report = buildConfigDoctorReport({
      ...CLEAN,
      drops: [drop({ field: 'a\u001b[2Kb', reason: 'r\ne\u0007d' })],
      rejectedLayers: [{ source: 's\u0000x', key: 'k\u2028y', reason: 'why\rnot' }],
    })
    expect(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(report.text.replace(/\n/g, ''))).toBe(false)
  })
})

describe('settings provenance', () => {
  // P6.168. `settings.md#confirm-what-loaded`, verbatim: "The line confirms
  // which files Claude Code read; it doesn't show which file supplied each key."
  // The host answers it per FAMILY, because there is no whole-settings merge to
  // hang per-key provenance on.
  //
  // Re-anchored P6.663: the former cite named `settings.md` and a section
  // "debug settings precedence", which the page does not publish — the sentence
  // is verbatim-unchanged under "Confirm what loaded". Spelled apart because
  // `check-doc-anchors.ts` scans every tracked file and the dead anchor written
  // in its full citation form would re-create the finding this note closes.

  it('separates a file that sets nothing for a family from a file that is not there', () => {
    // The whole point of the view: a listing of "files read" cannot tell these
    // two apart, and the first is the state a user misreads as "my setting is
    // being ignored".
    const present = classifySettingsProvenanceEntry(
      'project', '/w/.claude/settings.json', 'skillOverrides', { permissions: { allow: [] } },
    )
    expect(present.state).toBe('present-no-keys')

    const supplies = classifySettingsProvenanceEntry(
      'project', '/w/.claude/settings.json', 'skillOverrides', { skills: { demo: 'off' } },
    )
    expect(supplies.state).toBe('supplies')

    const missing = classifySettingsProvenanceEntry(
      'local', '/w/.claude/settings.local.json', 'skillOverrides', undefined,
    )
    expect(missing.state).toBe('missing')
    expect(missing.file).toBe('/w/.claude/settings.local.json')
    expect(missing.scope).toBe('local')
  })

  it('reads BOTH exclude spellings, because the readers merge both', () => {
    // `INSTRUCTION_EXCLUDE_SETTING_KEYS` is imported rather than restated, so a
    // third spelling added there and not here goes red instead of going quiet.
    expect([...SETTINGS_PROVENANCE_FAMILY_KEYS.instructionExcludes])
      .toEqual([...INSTRUCTION_EXCLUDE_SETTING_KEYS])
    for (const key of INSTRUCTION_EXCLUDE_SETTING_KEYS) {
      expect(classifySettingsProvenanceEntry('user', '/c.json', 'instructionExcludes', { [key]: ['x'] }).state)
        .toBe('supplies')
    }
  })

  it('carries a different combine rule per family, none of them assumable', () => {
    // Three different answers over four families. A single rule stated once for
    // all of them would be wrong for two of them.
    expect(SETTINGS_PROVENANCE_COMBINE.permissions).toBe('last-wins')
    // "There is deliberately NO way to subtract an inherited exclusion."
    expect(SETTINGS_PROVENANCE_COMBINE.instructionExcludes).toBe('union')
    expect(SETTINGS_PROVENANCE_COMBINE.skillOverrides).toBe('last-wins')
    // `server-managed-settings.md#settings-precedence` — "Claude Code by
    // default uses the first source that delivers at least one policy key".
    expect(SETTINGS_PROVENANCE_COMBINE.managedSettings).toBe('winner-takes-all')
  })

  it('treats an unparseable document exactly as the readers do — as supplying nothing', () => {
    // Every one of the four readers fails open leg by leg, so a file that cannot
    // be read must not be reported as contributing. `undefined` is the collector's
    // single spelling for "absent or unreadable", and that collapse is deliberate.
    expect(classifySettingsProvenanceEntry('user', '/broken.json', 'permissions', undefined).state)
      .toBe('missing')
    // Boundary: an empty object is a READ file that sets nothing, which is a
    // different answer and must not collapse into the one above.
    expect(classifySettingsProvenanceEntry('user', '/empty.json', 'permissions', {}).state)
      .toBe('present-no-keys')
  })
})

/**
 * P6.398 — the trim proposal for an over-long project instruction file.
 *
 * `memory.md#my-claude-md-is-too-large` — "Files over 200 lines consume more
 * context and may reduce adherence." — and the rule for deciding what goes:
 * "it cuts content Claude can derive from the codebase, such as directory
 * layouts, dependency lists, and architecture overviews, and keeps pitfalls,
 * rationale, and conventions that differ from tool defaults."
 *
 * Under owner decision D12 the checkup stays read-only, so a proposal here is a
 * REPORT: named sections with their line cost, and nothing edited.
 */
describe('project instruction files', () => {
  const sectionsOf = (headingCount: number, linesEach: number) =>
    Array.from({ length: headingCount }, (_unused, index) => ({
      heading: `## Section ${index + 1}`,
      lineCount: linesEach + index,
    }))

  const withFiles = (files: ConfigDoctorInputV1['instructionFiles']) =>
    buildConfigDoctorReport({ ...CLEAN, instructionFiles: files })

  it('proposes nothing for a file under the limit, and still says how long it is', () => {
    // The control the row asks for. "Under the limit" is only meaningful beside
    // the number it is under, so the count prints either way.
    const report = withFiles([{
      path: '/repo/AGENTS.md',
      lineCount: INSTRUCTION_FILE_TRIM_LINE_LIMIT - 1,
      sections: sectionsOf(3, 60),
    }])
    expect(report.text).toContain('/repo/AGENTS.md — 199 lines')
    expect(report.text).not.toContain('Sections, largest first')
    expect(report.text).not.toContain('over the 200-line guidance')
    // Exactly at the limit is not over it — the page says "over 200 lines".
    expect(withFiles([{
      path: '/repo/AGENTS.md',
      lineCount: INSTRUCTION_FILE_TRIM_LINE_LIMIT,
      sections: sectionsOf(2, 100),
    }]).text).not.toContain('Sections, largest first')
  })

  it('names each section and what it costs, largest first, for a file over the limit', () => {
    const report = withFiles([{
      path: '/repo/CLAUDE.md',
      lineCount: 260,
      sections: [
        { heading: '## Conventions', lineCount: 20 },
        { heading: '## Directory layout', lineCount: 150 },
        { heading: '## Pitfalls', lineCount: 90 },
      ],
    }])
    expect(report.text).toContain('/repo/CLAUDE.md — 260 lines, 60 over the 200-line guidance')
    // The reader is hunting for lines to remove, so the file's own order does
    // not help: the ranking is the proposal.
    const ranked = report.text.slice(report.text.indexOf('Sections, largest first'))
    expect(ranked.indexOf('## Directory layout'))
      .toBeLessThan(ranked.indexOf('## Pitfalls'))
    expect(ranked.indexOf('## Pitfalls'))
      .toBeLessThan(ranked.indexOf('## Conventions'))
    expect(report.text).toContain('- 150 lines: ## Directory layout')
    // The documented rule for deciding travels with the proposal, because a
    // ranking with no rule invites cutting the wrong half.
    expect(report.text).toContain('derived from the codebase')
    expect(report.text).toContain('keep pitfalls, rationale, and conventions')
    // D12, stated to the reader rather than only in a docblock.
    expect(report.text).toContain('This checkup changes nothing')
  })

  it('is never a finding, so a long instruction file cannot fail a fleet check', () => {
    // The pre-deployment check of
    // `server-managed-settings.md#invalid-entries-in-delivered-settings` reads
    // this exit code. The
    // 200-line rule is guidance about a repository, not a policy defect an
    // administrator can fix from the fleet.
    expect(withFiles([{
      path: '/repo/CLAUDE.md',
      lineCount: 4000,
      sections: sectionsOf(4, 1000),
    }]).hasFindings).toBe(false)
    // And the section is omitted entirely — not reported as "none" — when the
    // caller could not look.
    expect(buildConfigDoctorReport(CLEAN).text).not.toContain('Project instruction files:')
    expect(withFiles([]).text).toContain('no checked-in project instruction file')
  })

  it('costs sections by markdown heading, and does not read a fence as one', () => {
    // The blocks this check exists to find — directory layouts, dependency
    // lists — are usually fenced, so a `#` comment inside a fence must not
    // split the section it belongs to.
    const sections = instructionFileSections([
      'preamble line',
      '',
      '## Layout',
      '```sh',
      '# not a heading',
      'src/',
      '```',
      '### Deeper',
      'tail',
    ].join('\n'))
    expect(sections.map(entry => entry.heading)).toEqual([
      '(before the first heading)',
      '## Layout',
      '### Deeper',
    ])
    expect(sections.map(entry => entry.lineCount)).toEqual([2, 5, 2])
    // The counts add up to the file: no line is dropped and none is counted
    // twice, which is what makes the ranking trustworthy.
    expect(sections.reduce((total, entry) => total + entry.lineCount, 0)).toBe(9)
  })
})

/**
 * P6.255 (c) — the proxy/CA/mTLS report. Before this row the host resolved all
 * three and named none of them anywhere, so a wrong answer at any leg looked
 * like a network outage.
 */
describe('network trust chain section', () => {
  const NO_TRUST: NetworkTrustDoctorInputV1 = {
    proxyEnv: [],
    caSource: 'none',
    clientCertificate: false,
    mtlsReloadDisabled: false,
  }
  const withTrust = (trust: Partial<NetworkTrustDoctorInputV1>) =>
    buildConfigDoctorReport({ ...CLEAN, networkTrust: { ...NO_TRUST, ...trust } })

  it('names the winning proxy variable, and the ones that are set and lose', () => {
    // The whole defect: two spellings of one setting resolved differently on
    // different runtimes and no surface said which one won.
    const text = withTrust({
      proxyEnv: [
        { name: 'https_proxy', value: 'http://lower.internal:3128' },
        { name: 'HTTPS_PROXY', value: 'http://upper.internal:3128' },
      ],
    }).text
    expect(text).toContain('proxy: https_proxy = http://lower.internal:3128 (wins)')
    expect(text).toContain('also set, not used: HTTPS_PROXY = http://upper.internal:3128')
  })

  it('strips credentials from a proxy URL, and refuses to print one it cannot parse', () => {
    // A proxy URL routinely carries them, and this text is copied into tickets.
    const text = withTrust({
      proxyEnv: [
        { name: 'HTTPS_PROXY', value: 'http://alice:hunter2@proxy.internal:3128' },
        { name: 'ALL_PROXY', value: 'not a url at all' },
      ],
    }).text
    expect(text).toContain('proxy.internal:3128')
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('alice')
    expect(text).toContain('(unparseable proxy URL)')
  })

  it('is ONE rule, and it answers for the connection pane too (P6.780)', () => {
    // `agent/diagnostics.ts` carried a byte-identical private twin of this
    // function until P6.780; it now imports this one, so this case is the whole
    // coverage of a rule that keeps a password off two different screens.
    // The three shapes are the ones the two call sites actually meet: a proxy
    // URL with userinfo (the leak), a bare host (must survive untouched — a
    // redactor that mangles the ordinary case gets turned off), and a value that
    // does not parse, where reporting the string would be reporting the very
    // credential the parse failed to strip.
    expect(redactProxyUrl('http://alice:hunter2@proxy.internal:3128'))
      .toBe('http://proxy.internal:3128')
    expect(redactProxyUrl('http://proxy.internal:3128')).toBe('http://proxy.internal:3128')
    expect(redactProxyUrl('not a url at all')).toBe('(unparseable proxy URL)')
    // The unparseable answer must not be a pass-through under any spelling —
    // an unparseable value is exactly where the stripping did not happen.
    expect(redactProxyUrl('http://alice:hunter2@')).not.toContain('hunter2')
  })

  it('says "none" for every leg on a host that configured nothing, and finds nothing', () => {
    const report = withTrust({})
    expect(report.text).toContain('proxy: none set — requests go direct')
    expect(report.text).toContain('extra CA: none')
    expect(report.text).toContain('client certificate: none')
    expect(report.hasFindings).toBe(false)
  })

  it('makes an unresolved client identity loud, and a finding', () => {
    // `network-mtls.ts`: "A missing or unreadable cert/key must never silently
    // downgrade to an unauthenticated connection."
    const report = withTrust({
      clientCertificateError: 'mTLS client certificate is misconfigured:'
        + ' clientKeyPath is set but clientCertPath is missing.',
    })
    expect(report.text).toContain('configured and NOT resolved')
    expect(report.hasFindings).toBe(true)
  })

  it('makes an unreadable CA file a finding, and a resolved one not', () => {
    expect(withTrust({ caSource: 'custom', caPath: '/etc/ssl/corp.pem' }).hasFindings).toBe(false)
    expect(withTrust({ caSource: 'custom', caPath: '/etc/ssl/corp.pem' }).text)
      .toContain('extra CA: custom — /etc/ssl/corp.pem')
    expect(withTrust({ caWarning: 'Could not read TLS CA certificate at /etc/ssl/corp.pem: ENOENT' })
      .hasFindings).toBe(true)
  })

  it('reports the reload off-switch without judging it a fault', () => {
    // P6.259 classifies the name as `transport`, so a managed block cannot apply
    // it before confirmation; an operator who set it here chose it. It still
    // prints, because an operator whose rotation stopped needs it beside the
    // certificate it silences.
    const report = withTrust({ clientCertificate: true, mtlsReloadDisabled: true })
    expect(report.text).toContain('CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION is set here')
    expect(report.hasFindings).toBe(false)
  })

  it('prints no section at all when the caller did not look', () => {
    // "Absent" and "resolved, nothing configured" are different answers.
    expect(buildConfigDoctorReport(CLEAN).text).not.toContain('Network trust chain:')
    expect(withTrust({}).text).toContain('Network trust chain:')
  })
})

/**
 * P6.576 (+ P6.497's S residue) — the two settings-file tiers reach session
 * start, in one line, from the same record the full report is built from.
 */
describe('settings tiers session line', () => {
  const QUIET: ConfigDoctorInputV1 = {
    drops: [],
    winner: 'none',
    fileCarriesSettings: false,
    rejectedLayers: [],
  }

  it('says NOTHING on the default install', () => {
    // The line is emitted at every session start. A machine with no managed
    // source, no drops and no rejected layer must add no text at all, or the
    // surface becomes noise everybody learns to skip.
    expect(buildSettingsTiersSessionLine(QUIET)).toBeUndefined()
    expect(buildSettingsTiersSessionLine({ ...QUIET, mandatedPlugins: [], instructionFiles: [] }))
      .toBeUndefined()
  })

  it('names a managed source that IS in effect, which is not a finding', () => {
    // An administrator's policy binding is the fact that explains every other
    // surprise in the session, so it is said even though it is nobody's fault.
    expect(buildSettingsTiersSessionLine({ ...QUIET, winner: 'delivered' }))
      .toContain('Managed settings (remote) in effect')
  })

  it('names the shadowed policy file, which no other surface shows', () => {
    const line = buildSettingsTiersSessionLine({
      ...QUIET,
      winner: 'delivered',
      fileCarriesSettings: true,
      filePath: '/etc/nessy/managed-policy.json',
    })
    expect(line).toContain('shadowed and enforces nothing')
  })

  it('counts drops and rejected layers, singular and plural', () => {
    const one = buildSettingsTiersSessionLine({
      ...QUIET,
      drops: [drop()],
      rejectedLayers: [{ source: '/home/u/config.json', key: 'env', reason: 'refused' }],
    })
    expect(one).toContain('1 invalid managed entry was dropped')
    expect(one).toContain('1 settings layer was rejected whole')

    const many = buildSettingsTiersSessionLine({ ...QUIET, drops: [drop(), drop()] })
    expect(many).toContain('2 invalid managed entries were dropped')
  })

  it('says what an unfulfilled plugin mandate actually does (P6.497)', () => {
    // "not installed" alone reads as a transient state an administrator can
    // wait out. The decision is that the mandate is report-only and never
    // acquires, so the sentence has to carry that.
    const line = buildSettingsTiersSessionLine({
      ...QUIET,
      mandatedPlugins: [
        { pluginKey: 'a.b', state: 'not-installed', marketplacesRegistered: 0 },
        { pluginKey: 'c.d', state: 'installed' },
      ],
    })
    expect(line).toContain('1 force-enabled plugin is not installed here')
    expect(line).toContain('never acquires one')
    // A fulfilled mandate alone says nothing: there is no problem to report.
    expect(buildSettingsTiersSessionLine({
      ...QUIET,
      mandatedPlugins: [{ pluginKey: 'c.d', state: 'installed' }],
    })).toBeUndefined()
  })

  it('reports only instruction files OVER the guidance (W7-w / P6.398)', () => {
    const under = buildSettingsTiersSessionLine({
      ...QUIET,
      instructionFiles: [{ path: '/repo/AGENTS.md', lineCount: 10, sections: [] }],
    })
    expect(under).toBeUndefined()

    const over = buildSettingsTiersSessionLine({
      ...QUIET,
      instructionFiles: [
        { path: '/repo/AGENTS.md', lineCount: INSTRUCTION_FILE_TRIM_LINE_LIMIT + 1, sections: [] },
        { path: '/repo/CLAUDE.md', lineCount: 10, sections: [] },
      ],
    })
    expect(over).toContain(`1 project instruction file is over the ${INSTRUCTION_FILE_TRIM_LINE_LIMIT}-line guidance`)
  })

  it('cannot disagree with the full report, because it reads the same record', () => {
    // The pin that matters: both halves are derived from one input, so a future
    // edit that changes what the report says about a state cannot leave this
    // line saying the opposite.
    const input: ConfigDoctorInputV1 = {
      ...QUIET,
      winner: 'file',
      fileCarriesSettings: true,
      filePath: '/etc/nessy/managed-policy.json',
      drops: [drop()],
    }
    expect(buildConfigDoctorReport(input).hasFindings).toBe(true)
    expect(buildSettingsTiersSessionLine(input)).toContain('Managed settings (file) in effect')
    expect(buildSettingsTiersSessionLine(input)).toContain('nessy-general-agent doctor')
  })
})

describe('safety judge, user scope (P6.493)', () => {
  const withUserAutoMode = (read: Partial<UserScopeAutoModeReadV1>) =>
    buildConfigDoctorReport({
      ...CLEAN,
      userAutoMode: { refusedKeys: [], path: '/home/dev/.claude/settings.json', ...read },
    }).text

  it('names the refused keys and states which direction a user scope may move', () => {
    // The whole defect: a developer writes `autoMode.allow`, nothing happens,
    // and "the file is not read" and "the key was refused" look identical.
    const text = withUserAutoMode({
      policy: { hard_deny: ['rm -rf /'] } as never,
      refusedKeys: ['allow', 'environment'],
    })
    expect(text).toContain('Safety judge, user scope:')
    expect(text).toContain('applied: autoMode.hard_deny')
    expect(text).toContain('may only NARROW the safety judge')
    expect(text).toContain('autoMode.allow, autoMode.environment')
    // Named as a fault the DEVELOPER acts on, not one that fails an
    // administrator's fleet check.
    expect(buildConfigDoctorReport({
      ...CLEAN,
      userAutoMode: { refusedKeys: ['allow'], path: '/home/dev/.claude/settings.json' },
    }).hasFindings).toBe(false)
  })

  it('says the asymmetry on a machine whose user file carries nothing, and nothing when the caller did not look', () => {
    const text = withUserAutoMode({})
    expect(text).toContain('applied: nothing')
    expect(text).toContain('hard_deny and soft_deny travel from this file')
    // The negative control: a caller that did not look gets no section at all,
    // which is a different answer from "looked and found none".
    expect(buildConfigDoctorReport(CLEAN).text).not.toContain('Safety judge, user scope:')
  })

  it('reports a whole-block refusal without echoing the file content', () => {
    const text = withUserAutoMode({ invalidReason: 'autoMode block is not valid' })
    expect(text).toContain('autoMode was not applied: autoMode block is not valid')
  })
})

describe('settings tiers clauses (P6.684, P6.733)', () => {
  const QUIET2: ConfigDoctorInputV1 = {
    drops: [], winner: 'none', fileCarriesSettings: false,
    mandatedPlugins: [], instructionFiles: [],
  }

  it('returns the clauses as DATA, so a renderer can localise without re-deriving them', () => {
    const clauses = buildSettingsTiersSessionClauses({
      ...QUIET2,
      winner: 'delivered',
      rejectedLayers: [{ source: 'user', key: 'model', reason: 'not a string' }],
    })
    expect(clauses).toEqual([
      { id: 'managed-source', winner: 'delivered' },
      { id: 'rejected-layers', count: 1 },
    ])
    // And the English frame is the SAME derivation rendered, not a second one.
    expect(buildSettingsTiersSessionLine({
      ...QUIET2,
      winner: 'delivered',
      rejectedLayers: [{ source: 'user', key: 'model', reason: 'not a string' }],
    })).toContain('1 settings layer was rejected whole')
  })

  it('P6.733 — carries the identity-export clause only when the caller resolved it', () => {
    expect(buildSettingsTiersSessionClauses({ ...QUIET2, telemetryIdentityExported: true }))
      .toEqual([{ id: 'telemetry-identity-exported' }])
    // The control, and the half a positive-only test cannot prove: absent and
    // `false` are both silence, which is what keeps a default install quiet.
    expect(buildSettingsTiersSessionClauses(QUIET2)).toEqual([])
    expect(buildSettingsTiersSessionClauses({ ...QUIET2, telemetryIdentityExported: false })).toEqual([])
  })

  /**
   * A3.3 — the runtime's own credential-source answer is worth reading only when
   * it DISAGREES with the connection, which is what these three arms pin.
   *
   * The positive is the shape that matters (a gateway session whose child says
   * it used a bearer token); the first negative is the ordinary session, which
   * is nearly every session and must stay silent; the second is the absent
   * caller, because the value only exists once a query has run.
   */
  it('A3.3 — carries the credential-source clause only when the two names disagree', () => {
    expect(buildSettingsTiersSessionClauses({
      ...QUIET2,
      childCredentialSource: { source: 'none', expected: 'ANTHROPIC_API_KEY' },
    })).toEqual([{ id: 'child-credential-source-unexpected', source: 'none', expected: 'ANTHROPIC_API_KEY' }])

    // The ordinary session: the value is nearly constant, so agreement is the
    // common case and says nothing at all.
    expect(buildSettingsTiersSessionClauses({
      ...QUIET2,
      childCredentialSource: { source: 'ANTHROPIC_API_KEY', expected: 'ANTHROPIC_API_KEY' },
    })).toEqual([])
    // And a caller that could not resolve it — every session before its first
    // `system/init` — is silent rather than guessing.
    expect(buildSettingsTiersSessionClauses(QUIET2)).toEqual([])
  })

  it('A3.3 — the doctor names BOTH sides, because one name alone is not a finding', () => {
    const line = buildSettingsTiersSessionLine({
      ...QUIET2,
      // A member outside the two this fork can produce: the child reached a
      // credential source on the machine that this fork never configures.
      childCredentialSource: { source: 'apiKeyHelper', expected: 'ANTHROPIC_API_KEY' },
    })
    expect(line).toContain('apiKeyHelper')
    expect(line).toContain('ANTHROPIC_API_KEY')
    expect(line).toContain('the runtime authorized this session with')
  })

  it('P6.733 — the doctor says the same sentence, in its own voice', () => {
    expect(buildSettingsTiersSessionLine({ ...QUIET2, telemetryIdentityExported: true }))
      .toContain("this session's id is exported to your operator's telemetry collector")
    // A3.2 — the two words the old sentence carried and the product does not:
    // the ACCOUNT half has no gate (nothing consults `accountUuid`) and
    // "metrics" under-states the streams. Asserted as absences so the sentence
    // cannot drift back, and NOT as a bare `not.toContain('account')`, which
    // would fire on any future clause that legitimately mentions one.
    expect(buildSettingsTiersSessionLine({ ...QUIET2, telemetryIdentityExported: true }))
      .not.toContain("id and account")
    expect(buildSettingsTiersSessionLine({ ...QUIET2, telemetryIdentityExported: true }))
      .not.toContain("metrics collector")
  })
})

/**
 * P6.246(c) — "did the organisation's remote policy arrive?", which the report
 * could not answer at all.
 *
 * A failed fetch threw `ManagedDeliveryFetchError` out of
 * `refreshManagedDelivery` and published NOTHING, so the cause reached the
 * caller's control flow and stopped there. `winner` answered a different
 * question — what is enforced — and an administrator reading it alone cannot
 * tell a fleet running yesterday's approved policy from a fleet running none.
 */
describe('P6.246(c) — the delivery outcome', () => {
  const failed = (source: 'none' | 'cache' | 'server') => ({
    enabled: true,
    source,
    confirmed: false,
    fetchError: { cause: 'managed settings HTTP 503', at: 1 },
  } as const)

  it('names the cause AND what still applies, in one sentence', () => {
    // The control from the row: network down reports the cached policy PLUS the
    // cause. Both halves, because either alone is a false picture.
    const cached = describeManagedDeliveryOutcome(failed('cache'))
    expect(cached).toContain('managed settings HTTP 503')
    expect(cached).toContain('cached settings still apply')

    // ...and the other side of the same fact: nothing cached means nothing is
    // in effect, and that has to be said differently.
    const nothing = describeManagedDeliveryOutcome(failed('none'))
    expect(nothing).toContain('managed settings HTTP 503')
    expect(nothing).toContain('NO managed settings are in effect')
  })

  it('reports a well-formed policy as loaded, and the two silent states apart', () => {
    expect(describeManagedDeliveryOutcome({ enabled: true, source: 'server', confirmed: true }))
      .toContain('loaded')
    // Nothing configured is a real ANSWER, not an absence — an install that
    // never opted in is not the same as one whose fetch has not run yet.
    expect(describeManagedDeliveryOutcome({ enabled: false, source: 'none', confirmed: false }))
      .toContain('nothing configured')
    expect(describeManagedDeliveryOutcome({ enabled: true, source: 'none', confirmed: false }))
      .toContain('skipped')
    // ...and the host that could not resolve a state at all, which is neither.
    expect(describeManagedDeliveryOutcome(undefined)).toContain('not determined')
  })

  it('prints the outcome under the managed source, and never sets hasFindings', () => {
    // The sentence rides the section an administrator already reads for "which
    // source won", because the two are halves of one question.
    const report = buildConfigDoctorReport({ ...CLEAN, delivery: failed('cache') })
    expect(report.text).toContain('delivery: fetch FAILED')
    expect(report.text).toContain('managed settings HTTP 503')
    // A delivery outcome is a STATE, not a defect: `hasFindings` gates the
    // report's own "something is wrong" signal and a working cached policy must
    // not trip it.
    expect(buildConfigDoctorReport({ ...CLEAN, delivery: { enabled: true, source: 'server', confirmed: true } }).hasFindings)
      .toBe(buildConfigDoctorReport(CLEAN).hasFindings)
  })
})
