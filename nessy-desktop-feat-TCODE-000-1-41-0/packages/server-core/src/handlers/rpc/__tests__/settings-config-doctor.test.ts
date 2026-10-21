/**
 * P6.775 — the settings-doctor channel reports the record the terminal does.
 *
 * The defect this pins was a COMMENT: the handler passed
 * `collectConfigDoctorInput()` alone because a docblock said the doctor's other
 * collectors were unexported functions inside `apps/cli/src/doctor.ts`. P6.684
 * and P6.760 moved all seven into
 * `@nessy-agent/shared/config/doctor-collectors`; the sentence stayed, and with
 * it a settings page that rendered a report missing those sections while telling
 * the user the terminal saw more. Nothing here would have failed before that
 * move — the point of the file is that it fails the day a collector stops being
 * called.
 *
 * The collectors are stubbed rather than run: their own suites cover what they
 * FIND, and what this seam owns is whether they are called at all, with which
 * argument, and what happens to a section whose input is absent.
 *
 * **P6.787 adds the last collector to that list, and it is the one whose
 * argument the CALLER supplies.** Project instruction files are measured in a
 * directory, so the channel now takes an optional `workspaceId` and resolves it
 * to a root path. Three states are pinned below, because the two failure
 * directions are opposite and both are silent: calling the collector with its
 * `process.cwd()` default would report the app's own working directory as the
 * user's project, and refusing to call it at all keeps out a section the page
 * can now honestly render.
 *
 * **P6.878 adds an eighth**, so the sentence above no longer names the last one
 * — a count in prose beside a growing list is exactly what P6.775 cost. It is
 * parameter-free: `validateConfig()` reads `<config dir>/config.json` from this
 * process's own `CONFIG_DIR`, which the desktop and the CLI share, so the two
 * assertions it earns here are the ones every other collector has — the section
 * appears when the input is present, and is absent when the collector could not
 * look.
 */

import { afterAll, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import type { ConfigDoctorReportV1 } from '@nessy-agent/shared/config/config-doctor'
import * as realCollectorsModule from '@nessy-agent/shared/config/doctor-collectors'
import * as realPolicyModule from '../../../bootstrap/managed-policy-resolution.ts'
import type { HandlerFn, RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { registerSettingsHandlers } from '../settings'

// SPREAD both modules and RESTORE them in `afterAll` — `mock.module` is
// process-global and permanent, so a replacement listing only the exports this
// file overrides would silently un-implement every other export for every test
// file that loads afterwards (`sessions.memory.test.ts:12` records the measured
// case).
const realCollectors = { ...realCollectorsModule }
const realPolicy = { ...realPolicyModule }

const COLLECTORS_MODULE = '@nessy-agent/shared/config/doctor-collectors'
const POLICY_MODULE = '../../../bootstrap/managed-policy-resolution.ts'

/** The managed half, held constant so the assertions are about the collectors. */
const MANAGED_INPUT = Object.freeze({
  drops: [],
  winner: 'none' as const,
  fileCarriesSettings: false,
})

const ENABLED_PLUGINS = Object.freeze({ 'bWFya2V0.cGx1Zw==': true })

type CollectorOverrides = Partial<typeof realCollectorsModule>

/**
 * P6.788 — the handler's mandate seam is
 * `collectMandatedPluginFindingsFromEnforcedPolicy` now, not the resolver, so
 * that is what this file drives. The REAL body runs, over the loader seam the
 * function already accepts: `mock.module` replaces a module's EXPORTS and cannot
 * reach a call one of its own functions makes to a sibling, so mocking
 * `resolveEnforcedManagedPolicy` alone would have left the real machine's managed
 * policy deciding what the collector is handed. Driving the seam keeps both
 * properties this file pins — the collector receives the ENFORCED map, and a
 * collector that throws omits its section instead of failing the page — asserted
 * against the shipped `catch` rather than a copy of it.
 */
const ENFORCED_POLICY_SEAMS = {
  file: () => ({
    policy: { schemaVersion: 1 as const, disabledPermissionModes: [], enabledPlugins: ENABLED_PLUGINS },
    drops: [],
  }),
  delivered: () => undefined,
}

function install(overrides: CollectorOverrides): void {
  mock.module(COLLECTORS_MODULE, () => ({ ...realCollectors, ...overrides }))
  mock.module(POLICY_MODULE, () => ({
    ...realPolicy,
    collectConfigDoctorInput: () => MANAGED_INPUT,
    collectMandatedPluginFindingsFromEnforcedPolicy: () =>
      realPolicy.collectMandatedPluginFindingsFromEnforcedPolicy(ENFORCED_POLICY_SEAMS),
  }))
}

afterAll(() => {
  mock.module(COLLECTORS_MODULE, () => realCollectors)
  mock.module(POLICY_MODULE, () => realPolicy)
})

function harness(
  platform: { appRootPath?: string; resourcesPath?: string; isPackaged?: boolean } = {},
  /**
   * The workspace records this host knows about. Absent by default, which is
   * also the shape `getWorkspaceOrThrow` meets on a headless deployment — it
   * throws "Workspace service is unavailable", and the handler must read that as
   * "I could not look" rather than failing the settings page.
   */
  workspaces?: Record<string, { workspaceRootPath?: string }>,
) {
  const registered = new Map<string, HandlerFn>()
  const server = {
    handle(channel: string, handler: HandlerFn) { registered.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer
  const deps = {
    sessionManager: {},
    ...(workspaces === undefined ? {} : {
      workspaceService: {
        resolve(workspaceId: string) {
          const found = workspaces[workspaceId]
          if (!found) throw new Error(`Unknown workspace: ${workspaceId}`)
          return found
        },
      },
    }),
    platform: {
      appRootPath: platform.appRootPath ?? '/app/root',
      resourcesPath: platform.resourcesPath ?? '/app/resources',
      isPackaged: platform.isPackaged ?? true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSettingsHandlers(server, deps)
  const handler = registered.get(RPC_CHANNELS.settings.GET_CONFIG_DOCTOR)
  if (!handler) throw new Error('GET_CONFIG_DOCTOR is not registered')
  const ctx = { clientId: 'client-a', workspaceId: 'ws-a', webContentsId: null }
  return (workspaceId?: string) => handler(ctx, workspaceId) as Promise<ConfigDoctorReportV1>
}

/** Everything except the instruction-file collector silenced, so a section that
 * appears in the text below can only have come from the one under test. */
const ONLY_INSTRUCTION_FILES: CollectorOverrides = {
  collectMandatedPluginFindings: () => undefined,
  collectAgentDefinitionFindings: () => undefined,
  collectSearchBackendInput: () => undefined,
  collectNetworkTrustInput: () => undefined,
  collectUncarriedSandboxKeys: () => undefined,
  collectUserAutoModeInput: () => undefined,
  collectStoredConfigValidationInput: () => undefined,
}

describe('the settings-doctor channel', () => {
  it('renders every collector section, and hands the mandate collector the enforced map', async () => {
    const mandateArgs: unknown[] = []
    const searchArgs: unknown[] = []
    install({
      collectMandatedPluginFindings: (enabledPlugins) => {
        mandateArgs.push(enabledPlugins)
        return [{ pluginKey: 'bWFya2V0.cGx1Zw==', state: 'not-installed', marketplacesRegistered: 0 }]
      },
      collectAgentDefinitionFindings: () => [
        { file: '/agents/broken.md', agentName: 'broken', reason: 'front matter is not an object' },
      ],
      collectSearchBackendInput: (hostRuntime) => {
        searchArgs.push(hostRuntime)
        return { isPackaged: true, ripgrepPath: '/sentinel/rg' }
      },
      collectNetworkTrustInput: () => ({
        proxyEnv: [],
        caSource: 'none',
        clientCertificate: false,
        mtlsReloadDisabled: false,
      }),
      collectUncarriedSandboxKeys: () => ['sandbox.filesystem.allowWrite'],
      collectUserAutoModeInput: () => ({ refusedKeys: [], path: '/config/settings.json' }),
      collectStoredConfigValidationInput: () => ({
        file: '/config/config.json',
        issues: [{ key: 'crossSessionInbound', message: 'Invalid option', severity: 'error' as const }],
      }),
    })

    const { text } = await harness()()

    // One assertion per collector, by the section heading `buildConfigDoctorReport`
    // renders only when that collector's input is present — which is exactly the
    // property the stale comment cost.
    expect(text).toContain('Force-enabled plugins:')
    expect(text).toContain('Agent definitions:')
    expect(text).toContain('Search backend:')
    expect(text).toContain('/sentinel/rg')
    expect(text).toContain('Network trust chain:')
    expect(text).toContain('Sandbox keys accepted without effect:')
    expect(text).toContain('Safety judge, user scope:')
    expect(text).toContain('User config (config.json):')

    // The two collectors that cannot be parameter-free get the process owner's
    // own answers: the ENFORCED `enabledPlugins` map, and this host's runtime —
    // a packaged desktop, not the CLI's unpackaged default.
    expect(mandateArgs).toEqual([ENABLED_PLUGINS])
    expect(searchArgs).toEqual([
      { appRootPath: '/app/root', resourcesPath: '/app/resources', isPackaged: true },
    ])
  })

  it('keeps "found none" and "could not look" apart, and survives both', async () => {
    // The collectors' own convention: an empty array is a finding-free section
    // that must still be RENDERED, `undefined` is "I could not look" and omits
    // it. A handler that conflated them would make the page claim a clean
    // machine it never inspected — the quiet direction this report exists to
    // remove — and one that let an unresolvable policy escape would take the
    // whole settings page down with it.
    install({
      collectMandatedPluginFindings: () => { throw new Error('managed policy unreadable') },
      collectAgentDefinitionFindings: () => [],
      collectSearchBackendInput: () => undefined,
      collectNetworkTrustInput: () => undefined,
      collectUncarriedSandboxKeys: () => undefined,
      collectUserAutoModeInput: () => undefined,
      collectStoredConfigValidationInput: () => undefined,
    })

    const report = await harness()()

    expect(report.text).toContain('Agent definitions:')
    expect(report.text).toContain('Managed settings source:')
    for (const omitted of [
      'Force-enabled plugins:',
      'Search backend:',
      'Network trust chain:',
      'Sandbox keys accepted without effect:',
      'Safety judge, user scope:',
      'User config (config.json):',
    ]) {
      expect(`${omitted}${report.text.includes(omitted)}`).toBe(`${omitted}false`)
    }
    // An empty agent-definition list is not a finding, and nothing above it is
    // either — so the page's "nothing needs attention" line is the true one.
    expect(report.hasFindings).toBe(false)
  })

  it('NEGATIVE — without a workspace it never asks for the project instruction files', async () => {
    // The default the app must never take: that collector falls back to
    // `process.cwd()`, which is the CLI's honest answer and the desktop's
    // meaningless one. Reporting the app's own working directory as the user's
    // project is a wrong answer that reads exactly like a right one — so with no
    // `workspaceId` the collector is not called at all and the section is absent.
    let called = 0
    install({
      ...ONLY_INSTRUCTION_FILES,
      collectInstructionFileFindings: () => { called += 1; return [] },
    })

    const report = await harness()()

    expect(called).toBe(0)
    expect(report.text).not.toContain('Project instruction files:')
  })

  it('POSITIVE — a workspace id is resolved to its root and that is what the collector measures', async () => {
    // The row itself: the section was absent only because the channel took no
    // argument. The assertion is on the ARGUMENT, not merely on the section
    // appearing — a handler that called the collector with its default would
    // render the same heading from the wrong directory.
    const directories: unknown[] = []
    install({
      ...ONLY_INSTRUCTION_FILES,
      collectInstructionFileFindings: (directory) => {
        directories.push(directory)
        return [{ path: '/projects/alpha/AGENTS.md', lineCount: 900, sections: [] }]
      },
    })

    const report = await harness({}, { 'ws-alpha': { workspaceRootPath: '/projects/alpha' } })('ws-alpha')

    expect(directories).toEqual(['/projects/alpha'])
    expect(report.text).toContain('Project instruction files:')
    expect(report.text).toContain('/projects/alpha/AGENTS.md')
  })

  it('an unresolvable workspace omits the section instead of failing the page', async () => {
    // Two ways this happens in production and neither is exceptional: a stale
    // id from a window whose workspace was removed, and a headless deployment
    // with no workspace service at all. `getWorkspaceOrThrow` throws for both,
    // and a diagnosis that takes the settings page down with it is worse than
    // the silence it replaces — so it degrades to "I could not look".
    let called = 0
    install({
      ...ONLY_INSTRUCTION_FILES,
      collectInstructionFileFindings: () => { called += 1; return [] },
    })

    const stale = await harness({}, { 'ws-alpha': { workspaceRootPath: '/projects/alpha' } })('ws-gone')
    const noService = await harness()('ws-alpha')

    expect(called).toBe(0)
    for (const report of [stale, noService]) {
      expect(report.text).not.toContain('Project instruction files:')
      // The rest of the report still rendered — the failure is scoped to its
      // own section rather than to the page.
      expect(report.text).toContain('Managed settings source:')
    }
  })

  it('a workspace with no root path is the same "could not look", not an empty project', async () => {
    // A workspace record can carry no `workspaceRootPath`; measuring nothing
    // there would render an empty "Project instruction files:" section, which
    // says "this project has none" about a project that was never opened.
    let called = 0
    install({
      ...ONLY_INSTRUCTION_FILES,
      collectInstructionFileFindings: () => { called += 1; return [] },
    })

    const report = await harness({}, { 'ws-rootless': {} })('ws-rootless')

    expect(called).toBe(0)
    expect(report.text).not.toContain('Project instruction files:')
  })
})
