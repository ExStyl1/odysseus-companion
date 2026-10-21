import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_BUNDLED_SKILLS_DOCTOR,
  SKILL_LISTING_BUDGET_DOCTOR,
  collectAgentDefinitionFindings,
  collectInstructionFileFindings,
  runDoctor,
  skillListingBudgetSection,
  type DoctorJsonReportV1,
  type DoctorOptions,
} from './doctor.ts'
import type {
  ConfigDoctorInputV1,
  GatewayAuthDoctorInputV1,
} from '@nessy-agent/shared/config/config-doctor'
import { NESSY_HOME_ENV } from '@nessy-agent/shared/auth/dp'
import {
  CONFIG_DIR,
  STORAGE_LAYOUT_VERSION,
  resolveSandboxNetworkEnforcement,
} from '@nessy-agent/shared/config'
import { documentedUncarriedSandboxKeys } from '@nessy-agent/shared/config/sandbox-settings'
import {
  collectStoredConfigValidationInput,
  collectUserAutoModeInput,
} from '@nessy-agent/shared/config/doctor-collectors'

const CLEAN: ConfigDoctorInputV1 = {
  drops: [],
  winner: 'none',
  fileCarriesSettings: false,
  filePath: '/etc/nessy/managed-policy.json',
  deliveryCachePath: '/home/u/.nessy-agent/managed-delivery.json',
  rejectedLayers: [],
}

const BROKEN: ConfigDoctorInputV1 = {
  ...CLEAN,
  winner: 'delivered',
  fileCarriesSettings: true,
  drops: [{
    source: '/etc/nessy/managed-policy.json',
    field: 'autoMode.allow[1]',
    reason: 'duplicate managed autoMode entry',
    disposition: 'stripped',
  }],
}

/**
 * The registry seam, off. Every case below asserts the SETTINGS half of the
 * report, and the plugin-mandate half reads two files under the real plugin
 * root — so it is injected as "could not read" here and exercised on its own in
 * the D13 cases at the bottom.
 */
const NONE = () => undefined

/**
 * DA1.55 - the per-collector decision about what this suite is allowed to read,
 * in ONE place instead of 44.
 *
 * ## What was true before
 *
 * R3 (`97091647f`) closed the CREDENTIAL half: every `runDoctor` call site
 * injects `collectGatewayAuth` now, so no case opens the runner's own
 * `dp_auth_creds.json`. It did not close the rest, and the report text those
 * same cases build went on naming the machine that runs them - measured at this
 * file's dominant call shape on 2026-09-17:
 * `Safety judge, user scope: file: <the runner's home>/.claude/settings.json`,
 * `Project instruction files: <this checkout>/AGENTS.md`, the resolved ripgrep
 * under `node_modules`, and a `Network trust chain` read out of the runner's own
 * environment. No assertion read any of them, so nothing could go red - the same
 * latency R3 described, one class over.
 *
 * ## The decision, per collector
 *
 * All ELEVEN are injected here as "could not look". Six of them read OUTSIDE
 * this process's isolated config directory and are the reason this constant
 * exists: `collect` (the enforced managed policy, a machine-wide path),
 * `collectSearchBackend` (the host's ripgrep, resolved through PATH),
 * `collectInstructionFiles` (`process.cwd()`, i.e. this checkout),
 * `collectNetworkTrust` (the runner's proxy and CA environment),
 * `collectUserAutoMode` (the `.claude` settings file under the runner's home),
 * and `collectGatewayAuth`, which R3 already closed and which is kept here so
 * its answer stops depending on 44 call sites remembering.
 *
 * The other five - `collectMandatedPlugins`, `collectAgentDefinitions`,
 * `collectUncarriedSandboxKeys`, `collectStoredConfigValidation` and
 * `collectConfigOnlySettings` - read only under `CONFIG_DIR`, which `bun test`
 * has already pointed at a per-run temp directory through the root
 * `bunfig.toml`'s `[test].preload` (the only form of that isolation that works;
 * AGENTS.md section Traps). They are injected too, because a collector left at
 * its default BY ACCIDENT is what this row exists to end - and a case that wants
 * the production wiring says so by passing the real collector, which is what
 * P6.886's positive case below now does with its reason beside it.
 *
 * ## Why the explicit `NONE`s at each call site stay
 *
 * They are each case's own statement about the collector it is reasoning about,
 * and R3 put them there one commit ago. This spread is the FLOOR under them:
 * later keys in an object literal win, so every existing injection keeps its
 * exact meaning and only the collectors nobody named change answer.
 *
 * The guard at the bottom of this file reads `doctor.ts`'s own `DoctorOptions`
 * and fails when a twelfth collector is declared and not decided here - the
 * alternative being a list in prose beside a growing interface, which AGENTS.md
 * records as ageing silently.
 */
const OFFLINE = {
  collect: () => CLEAN,
  collectMandatedPlugins: NONE,
  collectAgentDefinitions: NONE,
  collectSearchBackend: NONE,
  collectInstructionFiles: NONE,
  collectNetworkTrust: NONE,
  collectGatewayAuth: NONE,
  collectUncarriedSandboxKeys: NONE,
  collectUserAutoMode: NONE,
  collectStoredConfigValidation: NONE,
  collectConfigOnlySettings: NONE,
} satisfies DoctorOptions

describe('C3.212 — the refusal to repair is said where it is read', () => {
  /**
   * Owner answer QM8=A, the transparency half. `doctor.ts` has carried the
   * invariant in its own docblock since P6.398 — "It never repairs anything" —
   * and the audience for a docblock is a reader of this fork's source, not the
   * operator holding a list of findings. "Read-only checkup" alone is fairly
   * read as "it has not written yet".
   *
   * Both surfaces say it now, and both are pinned in the one place that can see
   * them together. The app half is
   * `apps/electron/src/renderer/pages/settings/__tests__/config-doctor-settings-surface.test.ts`,
   * which asserts the same sentence against this module's docblock from the
   * other side.
   */
  const cli = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8')

  it('the help entry for `doctor` says it repairs nothing, and who fixes the findings', () => {
    const helpEntry = cli.slice(cli.indexOf('  doctor                 '))
      .split('\n').slice(0, 8).join(' ').replace(/\s+/g, ' ')
    // The positive control on the slice: if the help entry moved or was
    // reworded past recognition, this read would be about the wrong lines.
    expect(helpEntry).toContain('Read-only configuration checkup')
    expect(helpEntry).toContain('It never repairs anything')
    expect(helpEntry).toContain('yours to fix by hand')
  })
})

describe('nessy-general-agent doctor', () => {
  it('exits 0 on a clean configuration', () => {
    const result = runDoctor({ ...OFFLINE, collectGatewayAuth: NONE, collectMandatedPlugins: NONE, collectAgentDefinitions: NONE, collect: () => CLEAN })
    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('No managed settings source is in effect')
  })

  it('exits 1 when it finds something, so a fleet push can be gated on it', () => {
    // `server-managed-settings.md#invalid-entries-in-delivered-settings` —
    // "Validate a payload change with `claude doctor` on a test machine before
    // rolling it out to the organization."
    const result = runDoctor({ ...OFFLINE, collectGatewayAuth: NONE, collectMandatedPlugins: NONE, collectAgentDefinitions: NONE, collect: () => BROKEN })
    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('autoMode.allow[1]')
  })

  it('--json carries the same verdict in a scriptable shape', () => {
    const result = runDoctor({ ...OFFLINE, json: true, collectGatewayAuth: NONE, collectMandatedPlugins: NONE, collectAgentDefinitions: NONE, collect: () => BROKEN })
    expect(result.exitCode).toBe(1)
    const parsed = JSON.parse(result.text) as Record<string, unknown>
    expect(parsed.managedSource).toBe('delivered')
    expect(parsed.managedPolicyFileShadowed).toBe(true)
    expect(parsed.hasFindings).toBe(true)
    expect((parsed.invalidManagedEntries as unknown[])).toHaveLength(1)
  })

  it('--json on a clean configuration reports no findings', () => {
    const result = runDoctor({ ...OFFLINE, json: true, collectGatewayAuth: NONE, collectMandatedPlugins: NONE, collectAgentDefinitions: NONE, collect: () => CLEAN })
    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.text) as Record<string, unknown>
    expect(parsed.hasFindings).toBe(false)
    expect(parsed.managedPolicyFileShadowed).toBe(false)
  })

  it('emits exactly the keys DoctorJsonReportV1 declares, all of them, always (P6.640)', () => {
    // The `--json` form is a fleet-check contract with nine null-vs-absent
    // conventions, and its type is where they are written down. This case is the
    // hinge that keeps the type honest, in BOTH directions:
    //
    //  - a field in the type and not in the emitter fails at compile time, because
    //    `runDoctor` builds a `DoctorJsonReportV1` and TypeScript demands it whole;
    //  - a field in the emitter and not in the type fails here, because the record
    //    below is keyed by `keyof DoctorJsonReportV1` and its keys are compared
    //    with the emitted object's.
    //
    // The record is `Record<keyof …, true>` on purpose: TypeScript then refuses a
    // missing key AND an unknown one, so the list cannot rot into a subset.
    const EXPECTED: Record<keyof DoctorJsonReportV1, true> = {
      managedSource: true,
      managedPolicyFile: true,
      managedDeliveryCache: true,
    managedDeliveryOutcome: true,
    managedDeliveryFetchError: true,
      managedPolicyFileShadowed: true,
      invalidManagedEntries: true,
      rejectedSettingsLayers: true,
      availableModels: true,
      enforceAvailableModels: true,
      sandboxEgress: true,
      sandboxEgressSource: true,
      sandboxAllowedDomains: true,
      sandboxDeniedDomains: true,
      unenforceableDomainRules: true,
      retentionState: true,
      retentionDays: true,
      retentionSource: true,
      retentionWarning: true,
      unfulfilledPluginMandates: true,
      invalidAgentDefinitions: true,
      searchBackend: true,
      codexRemoteControl: true,
      codexBundledSkills: true,
      acceptedUncarriedSandboxKeys: true,
      projectInstructionFiles: true,
      networkTrust: true,
      gatewayAuth: true,
      skillListingBudget: true,
      userAutoMode: true,
      storedConfigValidation: true,
      configOnlySettings: true,
      hasFindings: true,
    }
    const emitted = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectSearchBackend: NONE,
      collectInstructionFiles: NONE,
      collectNetworkTrust: NONE,
      collectUncarriedSandboxKeys: NONE,
      collectUserAutoMode: NONE,
      collectStoredConfigValidation: NONE,
      collect: () => CLEAN,
    }).text) as Record<string, unknown>
    expect(Object.keys(emitted).sort()).toEqual(Object.keys(EXPECTED).sort())

    // `JSON.stringify` DROPS an `undefined` value, so "every key is present" is
    // the assertion that proves the no-optional-fields rule survives the wire —
    // the key count above would pass with a key whose value was `undefined` only
    // if the emitter had never written it at all.
    for (const key of Object.keys(EXPECTED)) {
      expect(emitted, key).toHaveProperty(key)
    }

    // Every injectable collector is "could not look" here — the count is not
    // written down, because a number beside a growing list is what P6.775 cost
    // — and each one's absence reads as `null` rather than a missing key, the
    // distinction the type's header exists for.
    expect(emitted.unfulfilledPluginMandates).toBeNull()
    expect(emitted.invalidAgentDefinitions).toBeNull()
    expect(emitted.searchBackend).toBeNull()
    expect(emitted.projectInstructionFiles).toBeNull()
    expect(emitted.networkTrust).toBeNull()
    expect(emitted.gatewayAuth).toBeNull()
    expect(emitted.acceptedUncarriedSandboxKeys).toBeNull()
    expect(emitted.userAutoMode).toBeNull()
    expect(emitted.storedConfigValidation).toBeNull()

    // And a present collector with nothing to say is the OTHER answer: an empty
    // list, not a null. This is the pair the conventions exist to separate.
    const looked = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: () => [],
      collectAgentDefinitions: () => [],
      collectGatewayAuth: NONE,
      collectSearchBackend: NONE,
      collectInstructionFiles: () => [],
      collectNetworkTrust: NONE,
      collectUncarriedSandboxKeys: () => [],
      collectUserAutoMode: () => ({ path: '/home/u/.claude/settings.json', refusedKeys: [] }),
      collectStoredConfigValidation: () => ({ file: '/home/u/.nessy-agent/config.json', issues: [] }),
      collect: () => CLEAN,
    }).text) as Record<string, unknown>
    expect(looked.unfulfilledPluginMandates).toEqual([])
    expect(looked.invalidAgentDefinitions).toEqual([])
    expect(looked.projectInstructionFiles).toEqual([])
    expect(looked.acceptedUncarriedSandboxKeys).toEqual([])
    // The two P6.886 added carry the same pair, and their present-with-nothing
    // answer is an OBJECT with an empty list inside — a settings file with no
    // `autoMode` block, and a `config.json` the schema accepted whole.
    expect(looked.userAutoMode).toEqual({
      file: '/home/u/.claude/settings.json',
      applied: [],
      refusedKeys: [],
      invalidReason: null,
    })
    expect(looked.storedConfigValidation)
      .toEqual({ file: '/home/u/.nessy-agent/config.json', issues: [] })
  })

  it('reports the enforced model allowlist in both output shapes', () => {
    // `settings-reference.md#availablemodels` and `#enforceavailablemodels`.
    // The text form answers "why can I not pick that
    // model"; the JSON form is what a fleet push can assert on.
    const restricted: ConfigDoctorInputV1 = {
      ...CLEAN,
      winner: 'file',
      availableModels: ['claude-sonnet-4-5'],
      enforceAvailableModels: true,
    }
    expect(runDoctor({ ...OFFLINE, collectGatewayAuth: NONE, collectMandatedPlugins: NONE, collectAgentDefinitions: NONE, collect: () => restricted }).text).toContain('claude-sonnet-4-5')

    const parsed = JSON.parse(runDoctor({ ...OFFLINE, json: true, collectGatewayAuth: NONE, collectMandatedPlugins: NONE, collectAgentDefinitions: NONE, collect: () => restricted }).text) as Record<string, unknown>
    expect(parsed.availableModels).toEqual(['claude-sonnet-4-5'])
    expect(parsed.enforceAvailableModels).toBe(true)
    // An allowlist is a working policy, not a finding.
    expect(parsed.hasFindings).toBe(false)

    // `null` is the shape that separates "no allowlist" from a deployed `[]`.
    const none = JSON.parse(runDoctor({ ...OFFLINE, json: true, collectGatewayAuth: NONE, collectMandatedPlugins: NONE, collectAgentDefinitions: NONE, collect: () => CLEAN }).text) as Record<string, unknown>
    expect(none.availableModels).toBeNull()
    const empty = JSON.parse(
      runDoctor({ ...OFFLINE, json: true, collectGatewayAuth: NONE, collectMandatedPlugins: NONE, collectAgentDefinitions: NONE, collect: () => ({ ...CLEAN, availableModels: [] }) }).text,
    ) as Record<string, unknown>
    expect(empty.availableModels).toEqual([])
  })

  // P6.359 — the Search line `troubleshooting.md#search-and-discovery-issues`
  // tells a user to check after flipping `USE_BUILTIN_RIPGREP`, verbatim: "run
  // `claude doctor` in your terminal and check that the Search line shows the
  // path of your system ripgrep instead of `OK (bundled)`."
  it('reports which ripgrep the host search resolved, in both output shapes', () => {
    const system = () => ({ isPackaged: false, ripgrepPath: '/opt/homebrew/bin/rg' })
    const text = runDoctor({
      ...OFFLINE,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectSearchBackend: system,
      collect: () => CLEAN,
    })
    expect(text.text).toContain('Search backend:')
    expect(text.text).toContain('system — /opt/homebrew/bin/rg')
    // A resolved binary never moves the exit code: the code gates a policy push.
    expect(text.exitCode).toBe(0)

    const parsed = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectSearchBackend: system,
      collect: () => CLEAN,
    }).text) as Record<string, unknown>
    expect(parsed.searchBackend).toEqual({ ripgrepPath: '/opt/homebrew/bin/rg', isPackaged: false })
  })

  it('--json distinguishes an unresolved ripgrep from a resolver it could not consult', () => {
    // The two nulls a fleet check has to tell apart: `null` for the whole object
    // means "did not look"; a present object with a null path means "looked, and
    // session search is unavailable on this host".
    const unresolved = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectSearchBackend: () => ({ isPackaged: true }),
      collect: () => CLEAN,
    }).text) as Record<string, unknown>
    expect(unresolved.searchBackend).toEqual({ ripgrepPath: null, isPackaged: true })
    expect(unresolved.hasFindings).toBe(false)

    const notLooked = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectSearchBackend: NONE,
      collect: () => CLEAN,
    }).text) as Record<string, unknown>
    expect(notLooked.searchBackend).toBeNull()
  })

  it('reports the effective sandbox egress policy, and fails on a rule that does not bind', () => {
    const locked: ConfigDoctorInputV1 = {
      ...CLEAN,
      winner: 'file',
      sandboxNetwork: {
        enforcement: resolveSandboxNetworkEnforcement({
          allowedDomains: ['corp.example'],
          deniedDomains: [],
          allowManagedDomainsOnly: true,
        }),
        settings: { allowedDomains: ['corp.example'], deniedDomains: [], allowManagedDomainsOnly: true },
        fromManagedSettings: true,
      },
    }
    const text = runDoctor({ ...OFFLINE, collectGatewayAuth: NONE, collectMandatedPlugins: NONE, collectAgentDefinitions: NONE, collect: () => locked })
    expect(text.text).toContain('sandboxed-command egress: DENIED')
    expect(text.text).toContain('sandbox.network.allowManagedDomainsOnly')
    expect(text.exitCode).toBe(1)

    const parsed = JSON.parse(runDoctor({ ...OFFLINE, json: true, collectGatewayAuth: NONE, collectMandatedPlugins: NONE, collectAgentDefinitions: NONE, collect: () => locked }).text) as Record<string, unknown>
    expect(parsed.sandboxEgress).toBe('denied')
    expect(parsed.sandboxEgressSource).toBe('allowManagedDomainsOnly')
    expect(parsed.sandboxAllowedDomains).toEqual(['corp.example'])
    expect((parsed.unenforceableDomainRules as unknown[])).toHaveLength(1)

    // No policy at all is not a finding, and reports null rather than a guess.
    const none = JSON.parse(runDoctor({ ...OFFLINE, json: true, collectGatewayAuth: NONE, collectMandatedPlugins: NONE, collectAgentDefinitions: NONE, collect: () => CLEAN }).text) as Record<string, unknown>
    expect(none.sandboxEgress).toBeNull()
    expect(none.unenforceableDomainRules).toEqual([])
  })

  it('names the sandbox keys it accepted and carries nowhere, from the same list the session path reads (P6.710)', () => {
    // P6.233 made the parser accept these and put the naming on the SESSION
    // composition's diagnostic channel. `debug-your-config.md` scopes the
    // terminal form to diagnostics "without starting a session", so until this
    // row an operator could read back an accepted-and-uncarried key only by
    // starting one.
    //
    // The list is not retyped here: it is produced by the SAME exported
    // function `resolveHostSandboxSettings` calls, fed a raw block. If the two
    // could name different keys this assertion would be the place it shows.
    const carried = documentedUncarriedSandboxKeys({
      autoAllowBashOutputRedirect: true,
      network: { strictAllowlist: true },
      enabled: false,
    })
    expect(carried.length).toBeGreaterThan(0)

    const text = runDoctor({
      ...OFFLINE,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectUncarriedSandboxKeys: () => carried,
      collect: () => CLEAN,
    })
    for (const key of carried) expect(text.text).toContain(key)
    expect(text.text).toContain('Sandbox keys accepted without effect:')
    // Accepted is not invalid: a fleet check must not fail because an operator
    // wrote a key Claude Code documents.
    expect(text.exitCode).toBe(0)

    // The control: a block naming none of them prints no section at all, so the
    // arm above is not passing on a header that is always there.
    const quiet = runDoctor({
      ...OFFLINE,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectUncarriedSandboxKeys: () => documentedUncarriedSandboxKeys({ enabled: true }),
      collect: () => CLEAN,
    })
    expect(quiet.text).not.toContain('Sandbox keys accepted without effect:')

    const parsed = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectUncarriedSandboxKeys: () => carried,
      collect: () => CLEAN,
    }).text) as Record<string, unknown>
    expect(parsed.acceptedUncarriedSandboxKeys).toEqual([...carried])
  })
})

/**
 * D13 — a managed `enabledPlugins: true` naming a plugin nobody installed is a
 * silent no-op. `server-managed-settings.md#invalid-entries-in-delivered-settings`
 * puts the pre-deployment check for exactly that on this command, and the non-zero exit is what lets a fleet gate on it.
 */
describe('force-enabled plugins that are not installed', () => {
  it('exits 1 and names the plugin', () => {
    const result = runDoctor({
      ...OFFLINE,
      collect: () => CLEAN,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectMandatedPlugins: () => [
        { pluginKey: 'corp.toolkit', state: 'not-installed', marketplacesRegistered: 0 },
      ],
    })
    expect(result.exitCode).toBe(1)
    expect(result.text).toContain('corp.toolkit')
    expect(result.text).toContain('the mandate does nothing')
  })

  it('--json lists the unfulfilled mandates, and distinguishes them from an unread registry', () => {
    const parsed = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collect: () => CLEAN,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectMandatedPlugins: () => [
        { pluginKey: 'corp.toolkit', state: 'not-installed', marketplacesRegistered: 1 },
        { pluginKey: 'corp.linter', state: 'installed' },
      ],
    }).text) as Record<string, unknown>
    expect(parsed.unfulfilledPluginMandates).toEqual(['corp.toolkit'])
    expect(parsed.hasFindings).toBe(true)

    const unread = JSON.parse(runDoctor({ ...OFFLINE, json: true, collectGatewayAuth: NONE, collectMandatedPlugins: NONE, collectAgentDefinitions: NONE, collect: () => CLEAN }).text) as Record<string, unknown>
    expect(unread.unfulfilledPluginMandates).toBeNull()
    expect(unread.hasFindings).toBe(false)
  })

  it('stays quiet when every mandate is fulfilled', () => {
    const result = runDoctor({
      ...OFFLINE,
      collect: () => CLEAN,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectMandatedPlugins: () => [{ pluginKey: 'corp.toolkit', state: 'installed' }],
    })
    expect(result.exitCode).toBe(0)
    expect(result.text).toContain('1 force-enabled plugin is installed')
  })
})

/**
 * A1 — the runtime SKIPS a malformed agent definition instead of dying on it
 * (one `tools: []` file used to kill every send in every session). The skip's
 * user-visible surface is this report: it names the file and the reason, from
 * the same validation code the send path runs.
 */
describe('malformed agent definitions', () => {
  const withAgentsDir = (files: Record<string, string>, run: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'nessy-doctor-agents-'))
    try {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, name), content)
      }
      run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('names the file and the reason, exits 1, and leaves the valid file unnamed', () => {
    withAgentsDir({
      'good.md': '---\ntools: Read\n---\nDo the thing.',
      'broken.md': '---\npermissionMode: nope\n---\nDo the thing.',
    }, dir => {
      const findings = collectAgentDefinitionFindings(dir)
      expect(findings).toHaveLength(1)
      const result = runDoctor({
        ...OFFLINE,
        collectMandatedPlugins: NONE,
        collect: () => CLEAN,
        collectAgentDefinitions: () => findings,
        collectGatewayAuth: NONE,
      })
      expect(result.exitCode).toBe(1)
      expect(result.text).toContain(join(dir, 'broken.md'))
      expect(result.text).toContain('permissionMode')
      expect(result.text).not.toContain('good.md')
    })
  })

  it('treats the measured tools:[] shape as valid (inherit) and a clean directory as no finding', () => {
    // sub-agents.md:279 — "Inherits every tool available to subagents if
    // omitted." — an empty list parses as omitted, so the exact file that
    // caused the live failure is a valid definition, not a finding.
    withAgentsDir({
      'cdp-high-effort.md': '---\ntools: []\n---\nInstructions.',
      // Instruction files are never agent definitions and must not be scanned.
      'AGENTS.md': 'not frontmatter at all',
    }, dir => {
      const findings = collectAgentDefinitionFindings(dir)
      expect(findings).toEqual([])
      const result = runDoctor({
        ...OFFLINE,
        collectMandatedPlugins: NONE,
        collect: () => CLEAN,
        collectAgentDefinitions: () => findings,
        collectGatewayAuth: NONE,
      })
      expect(result.exitCode).toBe(0)
      expect(result.text).toContain('every agent definition parses cleanly')
    })
  })

  it('A2: names a file only the markdown fallback loader refuses (divergent parse)', () => {
    // `toolset` is validated by the fallback loader
    // (shared/src/agents/definitions.ts) and ignored by the capability
    // pipeline. Both loaders read the global agents directory, so the doctor
    // runs both validators over it.
    withAgentsDir({
      'divergent.md': '---\ntoolset: everything\n---\nDo the thing.',
    }, dir => {
      const findings = collectAgentDefinitionFindings(dir) ?? []
      expect(findings).toHaveLength(1)
      expect(findings[0]!.reason).toContain('toolset')
      expect(findings[0]!.reason).toContain('markdown fallback loader')
      const result = runDoctor({
        ...OFFLINE,
        collectMandatedPlugins: NONE,
        collect: () => CLEAN,
        collectAgentDefinitions: () => findings,
        collectGatewayAuth: NONE,
      })
      expect(result.exitCode).toBe(1)
      expect(result.text).toContain(join(dir, 'divergent.md'))
    })
  })

  it('--json carries the findings, and an unreadable directory reports null rather than none', () => {
    const finding = { file: '/x/agents/broken.md', agentName: 'broken', reason: 'Invalid agent.broken.tier' }
    const parsed = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collect: () => CLEAN,
      collectAgentDefinitions: () => [finding],
      collectGatewayAuth: NONE,
    }).text) as Record<string, unknown>
    expect(parsed.invalidAgentDefinitions).toEqual([finding])
    expect(parsed.hasFindings).toBe(true)

    const unread = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collect: () => CLEAN,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
    }).text) as Record<string, unknown>
    expect(unread.invalidAgentDefinitions).toBeNull()
    expect(unread.hasFindings).toBe(false)
  })
})

/**
 * P6.404 — the codex bundled-skill tree is withheld, and the checkup says so.
 *
 * A stated posture, so the assertion pairs the sentence with the exit code
 * staying where it was: a property of the codex binary we ship is not a finding
 * about this machine, and a fleet check gated on `doctor` must not go red for it.
 */
describe('codex bundled skills', () => {
  const NONE = () => undefined
  const CLEAN_INPUT: ConfigDoctorInputV1 = { winner: 'none', fileCarriesSettings: false, drops: [] }

  it('names the withheld tree, its installer and the reason, without becoming a finding', () => {
    const result = runDoctor({
      ...OFFLINE,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectSearchBackend: NONE,
      collect: () => CLEAN_INPUT,
    })
    expect(result.text).toContain('Codex bundled skills:')
    expect(result.text).toContain(CODEX_BUNDLED_SKILLS_DOCTOR.notableSkill)
    expect(result.text).toContain(CODEX_BUNDLED_SKILLS_DOCTOR.reason)
    expect(result.exitCode).toBe(0)
  })

  it('is scriptable, and `listed` is the flag a fleet check watches', () => {
    const parsed = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectSearchBackend: NONE,
      collect: () => CLEAN_INPUT,
    }).text) as { codexBundledSkills: Record<string, unknown> }
    expect(parsed.codexBundledSkills).toMatchObject({
      listed: false,
      gated: false,
      entryCount: CODEX_BUNDLED_SKILLS_DOCTOR.entryCount,
      notableSkill: CODEX_BUNDLED_SKILLS_DOCTOR.notableSkill,
    })
  })
})

/**
 * P6.398 — what the checkup measures before it can propose a trim.
 *
 * The collector half. It reads the WORKING DIRECTORY, deliberately: doctor is
 * session-free (`debug-your-config.md:46` — "without starting a session"), so
 * it has no workspace or trusted-project context to resolve, exactly as the
 * agent-definition scan above.
 */
describe('project instruction files', () => {
  const withTempDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'nessy-doctor-instructions-'))
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('measures every checked-in instruction file, and reports none as an empty list', () => {
    withTempDir(dir => {
      // "no instruction file" is a real answer and must not look like "I could
      // not look" — the same distinction the agent-definition scan draws.
      expect(collectInstructionFileFindings(dir)).toEqual([])

      writeFileSync(join(dir, 'AGENTS.md'), ['# Guide', 'one', 'two'].join('\n'))
      writeFileSync(join(dir, 'CLAUDE.md'), '@AGENTS.md')
      const found = collectInstructionFileFindings(dir) ?? []
      expect(found.map(entry => entry.path.replace(`${dir}/`, ''))).toEqual(['AGENTS.md', 'CLAUDE.md'])
      expect(found[0]?.lineCount).toBe(3)
      expect(found[0]?.sections.map(entry => entry.heading)).toEqual(['# Guide'])
    })
  })

  it("honours codex's supersession rule, so it never proposes cuts to a file nothing reads", () => {
    withTempDir(dir => {
      writeFileSync(join(dir, 'AGENTS.md'), 'superseded')
      writeFileSync(join(dir, 'AGENTS.override.md'), 'the one that loads')
      const paths = (collectInstructionFileFindings(dir) ?? [])
        .map(entry => entry.path.replace(`${dir}/`, ''))
      expect(paths).toContain('AGENTS.override.md')
      expect(paths).not.toContain('AGENTS.md')
    })
  })

  it('reaches the report and the JSON without moving the exit code', () => {
    const instructionFiles = [{
      path: '/repo/AGENTS.md',
      lineCount: 900,
      sections: [{ heading: '## Monorepo map', lineCount: 900 }],
    }]
    const result = runDoctor({
      ...OFFLINE,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectInstructionFiles: () => instructionFiles,
      collect: () => CLEAN,
    })
    expect(result.text).toContain('700 over the 200-line guidance')
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectInstructionFiles: () => instructionFiles,
      collect: () => CLEAN,
    }).text)
    expect(json.projectInstructionFiles).toEqual(instructionFiles)
    expect(json.hasFindings).toBe(false)
    // `null` is "I could not read the directory", which a fleet check must be
    // able to tell apart from "this repository has no instruction file".
    expect(JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectInstructionFiles: () => undefined,
      collect: () => CLEAN,
    }).text).projectInstructionFiles).toBeNull()
  })
})

/**
 * P6.255 (c) — the network trust chain reaches the report and the `--json`.
 *
 * The rendering itself is pinned in `config-doctor.test.ts`; what this asserts
 * is the WIRING, and the one distinction a fleet check depends on: `null` means
 * the chain could not be resolved on this host, which is a different answer from
 * a resolved chain with nothing configured.
 */
describe('network trust chain wiring', () => {
  const TRUST = {
    proxyEnv: [{ name: 'https_proxy', value: 'http://lower.internal:3128' }],
    caSource: 'custom' as const,
    caPath: '/etc/ssl/corp.pem',
    clientCertificate: true,
    mtlsReloadDisabled: false,
  }

  it('reaches both surfaces, and distinguishes "could not look" from "nothing set"', () => {
    const result = runDoctor({
      ...OFFLINE,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectInstructionFiles: NONE,
      collectNetworkTrust: () => TRUST,
      collect: () => CLEAN,
    })
    expect(result.text).toContain('Network trust chain:')
    expect(result.text).toContain('proxy: https_proxy = http://lower.internal:3128 (wins)')
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectInstructionFiles: NONE,
      collectNetworkTrust: () => TRUST,
      collect: () => CLEAN,
    }).text)
    expect(json.networkTrust.caPath).toBe('/etc/ssl/corp.pem')

    expect(JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectInstructionFiles: NONE,
      collectNetworkTrust: NONE,
      collect: () => CLEAN,
    }).text).networkTrust).toBeNull()
  })
})

/**
 * P6.477 — the doctor's half. The prompt side's posture is already written at
 * `SKILL_LISTING_MAX_CHARS`; what was missing is the place an OPERATOR looks.
 */
describe('skill listing budget section', () => {
  const promptBuilder = readFileSync(
    new URL('../../../packages/shared/src/agent/core/prompt-builder.ts', import.meta.url),
    'utf8',
  )

  it('is a second spelling of prompt-builder.ts, so it is pinned to it', () => {
    // The positive control: if these two regexes stop matching, the pin below is
    // asserting against `undefined` and would pass with the constants renamed.
    const maxChars = /export const SKILL_LISTING_MAX_CHARS = ([\d_]+);/.exec(promptBuilder)?.[1]
    const envVar = /export const SKILL_LISTING_BUDGET_ENV = '([^']+)';/.exec(promptBuilder)?.[1]
    expect(maxChars).toBeDefined()
    expect(envVar).toBeDefined()

    expect(Number(maxChars?.replaceAll('_', ''))).toBe(SKILL_LISTING_BUDGET_DOCTOR.maxChars)
    expect(envVar).toBe(SKILL_LISTING_BUDGET_DOCTOR.envVar)
  })

  it('names both unread keys in the page\'s own spelling', () => {
    // Not a loose `toContain`: the page spells them `skillListingBudgetFraction`
    // and `skillListingMaxDescChars`, and an operator searching the doctor's
    // output for the key they set finds nothing if either spelling drifts.
    for (const key of SKILL_LISTING_BUDGET_DOCTOR.unreadSettingKeys) {
      expect(promptBuilder).toContain(key)
      expect(skillListingBudgetSection({})).toContain(`${key}`)
    }
    expect(skillListingBudgetSection({})).toContain('are not read by this listing')
  })

  it('reports the channel it DOES read, on both arms', () => {
    expect(skillListingBudgetSection({})).toContain(
      `raise it with ${SKILL_LISTING_BUDGET_DOCTOR.envVar}=<characters> (not set here)`,
    )
    expect(skillListingBudgetSection({ [SKILL_LISTING_BUDGET_DOCTOR.envVar]: '9000' }))
      .toContain('(set here to "9000"; a non-digit value keeps the default)')
  })

  it('reaches the report and the JSON without moving the exit code', () => {
    const result = runDoctor({
      ...OFFLINE,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectInstructionFiles: NONE,
      collect: () => CLEAN,
    })
    expect(result.text).toContain('Skill listing budget:')
    expect(result.text).toContain('identical on Pi, claude and codex')
    expect(result.exitCode).toBe(0)

    const json = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectInstructionFiles: NONE,
      collect: () => CLEAN,
    }).text)
    expect(json.skillListingBudget.maxChars).toBe(SKILL_LISTING_BUDGET_DOCTOR.maxChars)
    expect(json.skillListingBudget.unreadSettingKeys)
      .toEqual([...SKILL_LISTING_BUDGET_DOCTOR.unreadSettingKeys])
    expect(json.hasFindings).toBe(false)
  })
})

/**
 * P6.886 — the `--json` route carries the two input sections the text form
 * already reported: the safety judge's user scope (P6.493) and the values
 * `config.json` carries that never took effect (P6.878).
 *
 * Both were text-only, so a fleet check reading `--json` saw neither: it could
 * not tell a machine whose developer had written `autoMode.allow` (refused, and
 * doing nothing) from one that had not, nor a `config.json` full of silently
 * ignored keys from a clean one. The key-set case above pins that the keys
 * exist and that "could not look" is a `null`; these two pin the VALUES, which
 * is the half a guard on key names cannot see.
 *
 * Widened ADDITIVELY rather than by a version bump: the type's header states
 * exactly one rule — no optional fields, absence is `null` — and says nothing
 * about the key set being closed, and P6.710 already grew it the same way
 * (`acceptedUncarriedSandboxKeys`, `e2d49ecdd`) after the type existed.
 */
describe('the --json route carries the user rung too (P6.886)', () => {
  it('POSITIVE — a planted config.json key the schema refuses is named in --json', () => {
    // The collector reads the REAL `CONFIG_FILE`, and under `bun test` the
    // repo's `[test].preload` has already pointed `NESSY_CONFIG_DIR` at a
    // per-run temp directory before `paths.ts` froze `CONFIG_DIR` — the only
    // form of that isolation that works (AGENTS.md §Traps). So this plants the
    // real file and restores it, and no collector is injected: the production
    // wiring is what a fleet check runs.
    const configFile = join(CONFIG_DIR, 'config.json')
    const previous = existsSync(configFile) ? readFileSync(configFile, 'utf-8') : undefined
    try {
      writeFileSync(configFile, JSON.stringify({
        storageLayoutVersion: STORAGE_LAYOUT_VERSION,
        workspaceRefs: [],
        activeWorkspaceId: null,
        activeSessionId: null,
        // The typo P6.878's own record is written on: the load path is
        // unknown-tolerant, so this resolves to the default in silence.
        crossSessionInbound: 'hodl',
      }), 'utf-8')

      const emitted = JSON.parse(runDoctor({
        ...OFFLINE,
        json: true,
        collectMandatedPlugins: NONE,
        collectAgentDefinitions: NONE,
        collectGatewayAuth: NONE,
        collectSearchBackend: NONE,
        collectInstructionFiles: NONE,
        collectNetworkTrust: NONE,
        collectUncarriedSandboxKeys: NONE,
        collectUserAutoMode: NONE,
        // DA1.55 - the one collector this file runs for real, named rather than
        // left at a default: the section is the POINT of this case, the file it
        // reads is the one planted above, and `OFFLINE` would otherwise answer
        // "could not look" for it like every other collector.
        collectStoredConfigValidation: collectStoredConfigValidationInput,
        collect: () => CLEAN,
      }).text) as Record<string, unknown>

      const section = emitted.storedConfigValidation as
        { file: string, issues: { key: string, message: string, severity: string }[] } | null
      expect(section).not.toBeNull()
      expect(section?.file).toBe(configFile)
      expect(section?.issues.map(issue => issue.key)).toContain('crossSessionInbound')
      // Not a finding: the pre-deployment fleet check the exit code gates must
      // not fail for a value on the desk that is reading the report.
      expect(emitted.hasFindings).toBe(false)
    } finally {
      if (previous === undefined) rmSync(configFile, { force: true })
      else writeFileSync(configFile, previous, 'utf-8')
    }
  })

  it('POSITIVE — a refused managed-only autoMode key is scriptable, values are not', () => {
    const emitted = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collectGatewayAuth: NONE,
      collectSearchBackend: NONE,
      collectInstructionFiles: NONE,
      collectNetworkTrust: NONE,
      collectUncarriedSandboxKeys: NONE,
      collectStoredConfigValidation: NONE,
      collectUserAutoMode: () => ({
        path: '/home/u/.claude/settings.json',
        policy: { hard_deny: ['rm -rf /'], soft_deny: [] },
        refusedKeys: ['allow', 'environment'],
      }),
      collect: () => CLEAN,
    }).text) as Record<string, unknown>

    // `refusedKeys` is the assertion a fleet check makes; `applied` names the
    // keys and NOT their values, because the deny patterns a developer wrote
    // are file content the text section does not print either.
    expect(emitted.userAutoMode).toEqual({
      file: '/home/u/.claude/settings.json',
      applied: ['hard_deny', 'soft_deny'],
      refusedKeys: ['allow', 'environment'],
      invalidReason: null,
    })
    expect(JSON.stringify(emitted.userAutoMode)).not.toContain('rm -rf /')
    expect(emitted.hasFindings).toBe(false)
  })
})
/**
 * R3 (the wave-A2 independent review) — this suite reads no credential of
 * whoever runs it.
 *
 * DA1.34 gave the doctor a gateway sign-in section whose production collector,
 * `collectGatewayAuthInput`, opens the shared creds file. Until this row every
 * `runDoctor(` call site in this file left that collector at its default, so
 * every case here opened the runner's own `dp_auth_creds.json` — the hole
 * DA1.36/DA1.39 spent the same wave closing in four other suites. Nothing
 * asserted on the section and `d5d58c06a` had already severed its `hasFindings`
 * coupling, so nothing could go red: it was latent, not a live failure, which
 * is exactly why it survived a wave that was closing this class elsewhere.
 *
 * Every call site now injects this file's own `NONE` — the collector could not
 * look — and the section is driven from a FABRICATED input instead. The real
 * collector keeps its own coverage against a temp `NESSY_HOME` in
 * `packages/shared/src/config/__tests__/gateway-auth-doctor.test.ts`.
 *
 * THE ISOLATION IS PROVEN HERE, NOT ASSERTED ELSEWHERE. Both cases point
 * `NESSY_HOME` at an EMPTY temp directory: `getCredsPath` resolves through
 * `getNessyDir`, which returns an absolute value of that variable VERBATIM and
 * never consults the home latch, so on this rig the machine can only answer
 * `absent` / `no_credentials` — a reading neither case below accepts. Both arms
 * therefore FAIL if their injection is ever dropped, which is the property the
 * 41 call sites have no other way to state. `delete` before every assignment
 * and on the restore path, because an assignment to a name Bun pre-creates a
 * slot for is invisible to the spread every subprocess env in this tree is
 * built from (AGENTS.md section Traps; the DA1.36 pattern).
 *
 * NO REAL CREDENTIAL IS READ, WRITTEN OR ASSERTED ON: the input below is an
 * object literal of a code, a length and three booleans, and no file is created
 * inside the temp directory at all.
 */
describe('the gateway section answers from its injected input, never from the machine (R3)', () => {
  let home: string
  let savedNessyHome: string | undefined

  beforeEach(() => {
    savedNessyHome = process.env[NESSY_HOME_ENV]
    home = mkdtempSync(join(tmpdir(), 'nessy-cli-doctor-gw-'))
    delete process.env[NESSY_HOME_ENV]
    process.env[NESSY_HOME_ENV] = home
  })

  afterEach(() => {
    delete process.env[NESSY_HOME_ENV]
    if (savedNessyHome !== undefined) process.env[NESSY_HOME_ENV] = savedNessyHome
    rmSync(home, { recursive: true, force: true })
  })

  /** A state an empty directory cannot produce: a stored expiry already passed. */
  const EXPIRED: GatewayAuthDoctorInputV1 = {
    credentialsFile: 'present',
    jwtLength: 412,
    jwtShaped: true,
    jwtDecodes: true,
    expiresInMinutes: -7,
    reMintReason: 'credentials_expired',
    envTokenPresent: false,
    cliEnvTokenOnly: false,
  }

  it('POSITIVE — the injected reading is what the section prints, with no creds file anywhere', () => {
    const result = runDoctor({
      ...OFFLINE,
      collectGatewayAuth: () => EXPIRED,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collect: () => CLEAN,
    })

    expect(result.text).toContain('Nessy Gateway sign-in:')
    expect(result.text).toContain('re-mint reason: credentials_expired')
    expect(result.text).toContain('token: 412 characters')
    expect(result.text).toContain('passed 7 minute(s) ago')
    // The falsifier, not decoration: this is what the machine would have said.
    expect(result.text).not.toContain('credentials file: absent')
    expect(result.text).not.toContain('re-mint reason: no_credentials')
    // A printed reading moves nothing — DA1.34's own first correction.
    expect(result.exitCode).toBe(0)
  })

  it('NEGATIVE — injected as could-not-look, there is no section and the json field is null', () => {
    // Not a vacuous absence: the real collector NEVER returns `undefined` for a
    // missing file — it returns `credentialsFile: 'absent'` — so a site that
    // stopped injecting would print the section here rather than omit it.
    const result = runDoctor({
      ...OFFLINE,
      collectGatewayAuth: NONE,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collect: () => CLEAN,
    })
    expect(result.text).not.toContain('Nessy Gateway sign-in:')

    const emitted = JSON.parse(runDoctor({
      ...OFFLINE,
      json: true,
      collectGatewayAuth: NONE,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
      collect: () => CLEAN,
    }).text) as Record<string, unknown>
    expect(emitted.gatewayAuth).toBeNull()
  })
})

/**
 * DA1.55 - the floor itself, with the reading that made the row.
 *
 * Three properties, and the third is the one a later reader will want: the pair
 * DISCRIMINATES. The control arm is this file's own call shape from before this
 * row - `collect`, and the three collectors R3 and P6.684 had already pinned -
 * and it still reads the machine, which is what makes the guarded arm's silence
 * a measurement rather than a tautology.
 *
 * Nothing here prints a file's CONTENT: the control asserts on a PATH the
 * collector itself resolves, and asserts it as a boolean so a failure cannot
 * spill a whole report into the output.
 */
describe('DA1.55 - no collector reads the machine unless a case says so', () => {
  /**
   * The successor to a list written in prose: `doctor.ts` declares the
   * collectors, so the interface is read as source text and every name in it
   * must appear in `OFFLINE`. A twelfth collector then fails HERE, at the place
   * that decides what it may read, rather than silently inheriting its default
   * at 44 call sites.
   */
  it('OFFLINE decides every collector DoctorOptions declares', () => {
    const source = readFileSync(join(import.meta.dir, 'doctor.ts'), 'utf8')
    const start = source.indexOf('export interface DoctorOptions {')
    const block = source.slice(start, source.indexOf('\n}', start))
    // The positive control on the slice: if the interface moved or was renamed,
    // this read would be about the wrong lines and the loop below would be
    // vacuously green over zero names.
    expect(start).toBeGreaterThan(0)
    expect(block).toContain('readonly json?: boolean')

    const declared = [...block.matchAll(/readonly (collect[A-Za-z]*)\?:/g)].map(match => match[1])
    expect(declared).toContain('collect')
    expect(declared).toContain('collectGatewayAuth')
    for (const name of declared) expect(Object.keys(OFFLINE)).toContain(name)
  })

  it('POSITIVE - a report built on OFFLINE alone names no machine of its own', () => {
    const guarded = runDoctor({ ...OFFLINE })

    // Each of these four sections is printed only when its collector answered,
    // and each of those collectors reads outside this process's temp config
    // directory. Their absence IS the property.
    expect(guarded.text).not.toContain('Safety judge, user scope:')
    expect(guarded.text).not.toContain('Project instruction files:')
    expect(guarded.text).not.toContain('Search backend:')
    expect(guarded.text).not.toContain('Network trust chain:')
    // A read-only checkup that looked at nothing still finds nothing.
    expect(guarded.exitCode).toBe(0)

    // The runner's own `.claude` settings path, resolved by the collector rather
    // than re-derived here, so this cannot drift from what production reads.
    const machinePath = collectUserAutoModeInput()?.path
    expect(typeof machinePath).toBe('string')
    expect(guarded.text.includes(machinePath ?? '')).toBe(false)
  })

  it('CONTROL - the pre-DA1.55 call shape does read the machine, so the arm above discriminates', () => {
    const unguarded = runDoctor({
      collect: () => CLEAN,
      collectGatewayAuth: NONE,
      collectMandatedPlugins: NONE,
      collectAgentDefinitions: NONE,
    })

    expect(unguarded.text).toContain('Safety judge, user scope:')
    expect(unguarded.text).toContain('Project instruction files:')
    expect(unguarded.text).toContain('Search backend:')
    expect(unguarded.text).toContain('Network trust chain:')

    const machinePath = collectUserAutoModeInput()?.path
    expect(typeof machinePath).toBe('string')
    expect(unguarded.text.includes(machinePath ?? '')).toBe(true)
  })
})
