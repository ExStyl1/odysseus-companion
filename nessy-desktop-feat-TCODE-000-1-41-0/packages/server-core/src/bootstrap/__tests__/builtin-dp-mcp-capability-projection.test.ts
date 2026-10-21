/**
 * A7, option A: the built-in dp-backed MCP set is projected into the capability
 * catalog, so a built-in behaves like every other capability and the only
 * difference is that it is built in (owner decision 2026-08-01).
 *
 * What is proven here, through the real layers and never a re-derivation:
 *
 * - The set arrives as ordinary `kind: 'mcp'` records with `origin: 'builtin'`,
 *   a stable key, the `stdio` transport the row badge shows, and dp's own
 *   description — which is what makes the row clickable and the detail page
 *   real, since `buildDetail` is a pure projection of exactly these fields.
 * - The per-server preference is the ONE source of enablement: an off server
 *   resolves `disabled/source-disabled`, an on one resolves `active`.
 * - **An enabled built-in still reaches the materialized pool.** This is the
 *   hazard the projection is most likely to cause and least likely to show: if
 *   the capability's runtime binding pinned a document under the built-in's wire
 *   name, `mergeBuiltinDpMcpServers` would treat the name as configured and
 *   stand the real built-in down — the list would say enabled and nothing would
 *   start. The arm drives the REAL `materializeRuntimePoolServers` over the REAL
 *   runtime view, with a materializer whose `readText` THROWS, so a built-in
 *   that took the pinned-document branch fails loudly instead of quietly.
 * - The write path is untouched: `setBuiltinDpMcpServerEnabled` still puts
 *   `{"enabled":{"<name>":true}}` in `config.json`'s `builtinDpMcpServers` key.
 *   Asserted on the FILE, in a child process with its own `NESSY_CONFIG_DIR`.
 *
 * Nothing here runs `dp`, resolves `dp`, or reads the developer's real config:
 * `resolveDpPath` is injected and the stored config is passed in.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import { PluginStoreV2 } from '@nessy-agent/shared/plugins'
import { createCapabilityResolver, type CapabilityContext } from '@nessy-agent/shared/capabilities/resolver'
import { toAgentRuntime, toUserCatalog } from '@nessy-agent/shared/capabilities/views'
import {
  BUILTIN_DP_MCP_SERVERS,
  builtinDpMcpServerIdentity,
  materializeRuntimePoolServers,
} from '@nessy-agent/shared/mcp'
import { parseManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import {
  buildCapabilityResolutionInputsV2,
  builtinDpMcpCapabilityRecords,
  type CapabilityInputsV2Deps,
} from '../storage-runtime'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'builtin-dp-capability-'))
  mkdirSync(join(root, 'workspaces', 'ws_a', 'sources'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const CONTEXT: CapabilityContext = {
  workspaceId: 'ws_a',
  projectTrustState: 'none',
  projectTrustRevision: '',
}

function depsWith(
  storedConfig: unknown,
  managedPiPolicy?: ReturnType<typeof parseManagedPiPolicyV1>,
): CapabilityInputsV2Deps {
  return {
    ...(managedPiPolicy ? { managedPiPolicy } : {}),
    resolveWorkspaceRootPath: () => join(root, 'workspaces', 'ws_a'),
    nativeSourcesEnv: {
      // P2.455 / P2.461 — `[]` is "no administrator tier", pinned so this rig
      // cannot read the machine's real administrator roots. Why the field is
      // required rather than defaulting: `NativeSourcesEnv.adminSkillsDirs`.
      adminSkillsDirs: [],
      configDir: join(root, 'config'),
      homeAgentsSkillsDir: join(root, 'agents', 'skills'),
    },
    pluginStore: new PluginStoreV2({ rootDirectory: join(root, 'plugins') }),
    policyStore: new CapabilityPolicyStore({
      globalPath: join(root, 'config', 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(root, 'workspaces', workspaceId, 'capabilities.json'),
    }),
    trustStore: { resolve: () => 'trusted' } as unknown as CapabilityInputsV2Deps['trustStore'],
    credentialBackend: {
      bind: (id: unknown) => ({ id, expectedRevision: 0 }),
      getRuntimeCredentialStatus: () => ({ state: 'missing', revision: 0 }),
    } as unknown as CapabilityInputsV2Deps['credentialBackend'],
    // The stored `config.json`, injected — no disk read, no developer config.
    storedConfig,
    // Keep the bundled-skill half out of this suite's way.
    bundledSkillRoots: { bundledRoot: join(root, 'no-bundled'), skillsRoot: join(root, 'no-skills') },
  }
}

async function resolveOnce<T>(storedConfig: unknown, read: (
  catalog: ReturnType<typeof toUserCatalog>,
  view: ReturnType<typeof toAgentRuntime>,
  snapshot: Awaited<ReturnType<ReturnType<typeof createCapabilityResolver>['resolve']>>,
) => T, managedPiPolicy?: ReturnType<typeof parseManagedPiPolicyV1>): Promise<T> {
  const deps = depsWith(storedConfig, managedPiPolicy)
  const resolver = createCapabilityResolver({
    inputs: () => buildCapabilityResolutionInputsV2(CONTEXT, deps),
  })
  const snapshot = await resolver.resolve(CONTEXT)
  try {
    return read(toUserCatalog(snapshot), toAgentRuntime(snapshot), snapshot)
  } finally {
    resolver.releaseSnapshot(snapshot.leaseId)
  }
}

describe('the built-in dp set is an ordinary capability (A7 option A)', () => {
  it('projects every built-in as an mcp capability the detail page can render', async () => {
    const jira = await resolveOnce(null, catalog => (
      catalog.capabilities.find(capability => capability.key === 'builtin:mcp:dpJira')
    ))
    expect(jira).toBeDefined()
    expect(jira).toMatchObject({
      kind: 'mcp',
      logicalName: 'dpJira',
      origin: 'builtin',
      // The transport badge and the detail page's `transport` field both read
      // this; `stdio` is what `dp ai mcp <sub>` is by construction.
      mcpTransport: 'stdio',
      description: 'Tool for working with Jira issues',
      scope: { kind: 'builtin' },
      // Nothing about a built-in is editable in place.
      readOnly: true,
      // A built-in holds no credential — dp authenticates itself — so the row
      // and the tools section must never claim a sign-in is outstanding.
      credentialState: 'not-required',
      trustState: 'not-required',
    })
    // The two fields `buildDetail`'s `buildSafeFields` copies verbatim
    // (`handlers/rpc/capabilities.ts`): origin, and the binding's transport.
    const binding = await resolveOnce(null, (_catalog, _view, snapshot) => (
      snapshot.entries.find(entry => entry.summary.key === 'builtin:mcp:dpJira')!.runtimeBinding
    ))
    expect(binding.kind).toBe('mcp')
    expect(binding.kind === 'mcp' && binding.server.definition.type).toBe('stdio')
    // `resolveMcpBindingFromContext` finds the live tools by this wire name.
    expect(binding.kind === 'mcp' && binding.server.wireName).toBe('dpJira')
  })

  it('takes enablement from the stored preference, and nothing else', async () => {
    const off = await resolveOnce(null, catalog => (
      catalog.capabilities.find(capability => capability.key === 'builtin:mcp:dpJira')!
    ))
    // Every definition ships disabled (owner decision 2026-08-01), so the
    // no-preference case is the off case.
    expect(off.state).toBe('disabled')
    expect(off.unavailableReason).toBe('source-disabled')

    const on = await resolveOnce(
      { builtinDpMcpServers: { enabled: { dpJira: true } } },
      catalog => catalog.capabilities.find(capability => capability.key === 'builtin:mcp:dpJira')!,
    )
    expect(on.state).toBe('active')
    expect(on.unavailableReason).toBeUndefined()
    // Positive control on the same resolve: a server the preference did not
    // name is still off, so the arm above is reading the preference and not
    // "everything turned on".
    const sibling = await resolveOnce(
      { builtinDpMcpServers: { enabled: { dpJira: true } } },
      catalog => catalog.capabilities.find(capability => capability.key === 'builtin:mcp:dpSage')!,
    )
    expect(sibling.state).toBe('disabled')
  })

  it('keeps a disabled built-in out of the runtime view and lets an enabled one in', async () => {
    const offView = await resolveOnce(null, (_catalog, view) => view.mcpServers.map(server => server.wireName))
    expect(offView).toEqual([])

    const onView = await resolveOnce(
      { builtinDpMcpServers: { enabled: { dpJira: true } } },
      (_catalog, view) => view.mcpServers,
    )
    expect(onView.map(server => server.wireName)).toEqual(['dpJira'])
    // THE HAZARD. A built-in pins no document and names no `.mcp.json` entry —
    // it has neither — so `materializeSnapshotMcpServers` cannot produce an
    // entry under this wire name and the built-in fold stays the single
    // materialization path. Drop this and the next arm's server disappears.
    expect(onView[0]!.resource).toBeUndefined()
    expect(onView[0]!.sourceName).toBeUndefined()
  })

  it('an enabled built-in still reaches the materialized pool', async () => {
    const view = await resolveOnce(
      { builtinDpMcpServers: { enabled: { dpJira: true } } },
      (_catalog, agentView) => agentView,
    )
    const materialized = await materializeRuntimePoolServers(
      {
        view,
        materializer: {
          assertActive: () => {},
          verifyPlugin: async () => {},
          resolvePath: async () => join(root, 'abs'),
          // A built-in has no document. Reading one would mean the binding took
          // the pinned-document branch, which is exactly the regression this
          // suite exists to catch — so it fails here rather than silently.
          readText: async () => { throw new Error('a built-in must not be read from disk') },
          resolveCredential: () => { throw new Error('no credential in this suite') },
        },
      } as unknown as Parameters<typeof materializeRuntimePoolServers>[0],
      {
        workspaceRootPath: join(root, 'workspaces', 'ws_a'),
        workspaceId: 'ws_a',
        builtinDpMcpServers: {
          enabled: { dpJira: true },
          // Injected: this suite never looks for dp and never runs it.
          resolveDpPath: () => join(root, 'bin', 'dp'),
          runtimeEnv: {},
        },
      },
    )
    expect(materialized.mergedMcpServers.dpJira).toEqual({
      type: 'stdio',
      command: join(root, 'bin', 'dp'),
      args: ['ai', 'mcp', 'jira'],
    })
    // …and it got there through the fold, not through the snapshot path: the
    // capability contributed no configured server of its own.
    expect(materialized.mcpServers).toEqual({})
    // A server the preference left off is still absent (positive control).
    expect(materialized.mergedMcpServers.dpSage).toBeUndefined()
  })

  it('describes the whole set; the managed filter is its CALLER\'s job (P2.368)', async () => {
    // This arm used to read "is NOT subject to the managed MCP policy,
    // deliberately", and said that the day the fold gained managed filtering it
    // would be the one saying "now do both". Both landed: the fold enforces
    // (`mcp/runtime-pool-servers.ts:applyManagedMcpPolicy`) and the resolve
    // filters the mirror on the SAME identity. What this exported function does
    // is unchanged, and that is the point — it still describes the set as the
    // preference does, so the policy decision lives at exactly one layer.
    const records = builtinDpMcpCapabilityRecords({ builtinDpMcpServers: { enabled: { dpJira: true } } })
    expect(records).toHaveLength(28)
    const jira = records.find(record => record.logicalName === 'dpJira')!
    expect(jira.sourceEnabled).toBe(true)
    // The identity BOTH the mirror and the fold match on — one definition
    // (`builtinDpMcpServerIdentity`), so a row cannot say "disabled" while its
    // server runs (`managed-mcp.md:150` — the NAME is not a security control,
    // which is why the logical `dp ai mcp <sub>` argv rides along).
    expect(jira.mcpServerIdentity).toEqual({ transport: 'stdio', command: ['dp', 'ai', 'mcp', 'jira'] })
    expect(jira.mcpServerIdentity).toEqual(builtinDpMcpServerIdentity(
      BUILTIN_DP_MCP_SERVERS.find(definition => definition.name === 'dpJira')!,
    ))
  })

  it('a managed denial reaches the catalog row, not only the pool (P2.368)', async () => {
    // The display half of the same fix. Before it, an administrator who denied
    // `dpJira` saw the row still reading ENABLED — and it was, because the fold
    // started the server. The row is KEPT rather than dropped on this
    // provider-neutral read, so the denial is visible instead of reproducing
    // `managed-mcp.md#how-restrictions-appear-to-users`' silent disappearance.
    const stored = { builtinDpMcpServers: { enabled: { dpJira: true } } }
    const denied = await resolveOnce(stored, catalog => (
      catalog.capabilities.find(capability => capability.key === 'builtin:mcp:dpJira')!
    ), parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      deniedMcpServers: [{ serverCommand: ['dp', 'ai', 'mcp', 'jira'] }],
    }))
    expect(denied).toBeDefined()
    expect(denied.state).toBe('disabled')

    // Positive control on the same rig: without the denial the same stored
    // preference resolves active, so the arm above reads the policy rather than
    // the preference.
    const allowed = await resolveOnce(stored, catalog => (
      catalog.capabilities.find(capability => capability.key === 'builtin:mcp:dpJira')!
    ))
    expect(allowed.state).toBe('active')

    // …and it is denied by its COMMAND, not merely by its name: a denial aimed
    // at a sibling's command leaves this one active (`managed-mcp.md:150`).
    const sibling = await resolveOnce(stored, catalog => (
      catalog.capabilities.find(capability => capability.key === 'builtin:mcp:dpJira')!
    ), parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      deniedMcpServers: [{ serverCommand: ['dp', 'ai', 'mcp', 'sage'] }],
    }))
    expect(sibling.state).toBe('active')
  })

  it('P3.218: the denial says WHOSE it is, and a user\'s own OFF still says that (the honest-reporting half)', async () => {
    // P2.368 made the denial VISIBLE — the row survives and reads disabled. It
    // deliberately stopped there, and the residue is this: a managed denial and
    // a user's own OFF are the same `sourceEnabled: false`, so both resolved
    // `'source-disabled'` and the detail page told an administrator's victim to
    // flip a switch that reverts. Nothing downstream could tell them apart,
    // because the two facts were one bit.
    //
    // Driven through the REAL fold — `builtinDpMcpCapabilityRecords` →
    // `isManagedMcpServerAllowed` → the resolver — so a stamp written at the
    // fold and read anywhere else would fail here.
    const stored = { builtinDpMcpServers: { enabled: { dpJira: true } } }
    const denied = await resolveOnce(stored, catalog => (
      catalog.capabilities.find(capability => capability.key === 'builtin:mcp:dpJira')!
    ), parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      deniedMcpServers: [{ serverCommand: ['dp', 'ai', 'mcp', 'jira'] }],
    }))
    expect(denied.state).toBe('disabled')
    expect(denied.unavailableReason).toBe('managed-denied')

    // THE PAIR, and it is what makes the line above a finding rather than a
    // rename: the user's own OFF — no preference, no managed policy — must keep
    // saying exactly what it said before.
    const userOff = await resolveOnce(null, catalog => (
      catalog.capabilities.find(capability => capability.key === 'builtin:mcp:dpJira')!
    ))
    expect(userOff.state).toBe('disabled')
    expect(userOff.unavailableReason).toBe('source-disabled')
    expect(denied.unavailableReason).not.toBe(userOff.unavailableReason)

    // And the stamp is scoped to the DENIED record: a sibling denied by another
    // command is untouched, so this is not "everything managed is now denied".
    const sibling = await resolveOnce(stored, catalog => (
      catalog.capabilities.find(capability => capability.key === 'builtin:mcp:dpJira')!
    ), parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      deniedMcpServers: [{ serverCommand: ['dp', 'ai', 'mcp', 'sage'] }],
    }))
    expect(sibling.unavailableReason).toBeUndefined()
  })
})

/**
 * The WRITE half, unchanged and asserted on the FILE.
 *
 * `setBuiltinDpMcpServerEnabled` is still the only writer, and it still writes
 * the `builtinDpMcpServers.enabled` map — NOT a capability policy record. Run in
 * a child process with its own `NESSY_CONFIG_DIR` so the developer's real
 * `config.json` is never touched and nothing in this repo's suite can collide on
 * the env var.
 */
describe('the built-in write path is unchanged', () => {
  it('a toggle puts {"enabled":{"<name>":true}} in config.json and leaves neighbours alone', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'builtin-dp-write-'))
    try {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        storageLayoutVersion: 2,
        workspaceRefs: [{ id: 'ws-1', lastAccessedAt: 0 }],
        activeWorkspaceId: 'ws-1',
        activeSessionId: null,
      }), 'utf-8')
      const configModule = pathToFileURL(
        join(import.meta.dir, '..', '..', '..', '..', 'shared', 'src', 'config', 'index.ts'),
      ).href
      const run = Bun.spawnSync([
        process.execPath,
        '--eval',
        [
          `import * as C from '${configModule}';`,
          `C.setBuiltinDpMcpServerEnabled('dpJira', true);`,
        ].join('\n'),
      ], { env: { ...process.env, NESSY_CONFIG_DIR: configDir }, stdout: 'pipe', stderr: 'pipe' })
      expect(run.exitCode, run.stderr.toString()).toBe(0)
      const written = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8')) as {
        builtinDpMcpServers?: unknown
        capabilities?: unknown
      }
      expect(written.builtinDpMcpServers).toEqual({ enabled: { dpJira: true } })
      // Only the named server. Writing the whole set would freeze today's
      // defaults into every user's config and hide every future built-in.
      expect(Object.keys((written.builtinDpMcpServers as { enabled: Record<string, boolean> }).enabled))
        .toEqual(['dpJira'])
      // And NOT through the plugin capability policy mechanism.
      expect(written.capabilities).toBeUndefined()
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
