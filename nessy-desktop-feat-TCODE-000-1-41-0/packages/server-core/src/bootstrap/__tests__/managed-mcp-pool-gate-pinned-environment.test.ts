/**
 * P2.410 — the two managed-MCP gates in `mcp/runtime-pool-servers.ts` expand a
 * policy entry from the PINNED environment too.
 *
 * P2.396 split the two sides of a managed-MCP match across two environments and
 * threaded the pinned one to the four gate call sites inside this package's
 * storage runtime. Two more call sites were outside that lane's zone and stayed
 * unpinned — `applyManagedMcpPolicy` (the built-in dp fold) and
 * `isPluginMcpServerManagedAllowed` (the plugin stdio fold). They are the LAST
 * gate before a server is spawned, so the defect P2.396 closed survived at the
 * two places it costs the most.
 *
 * `managed-mcp.md#how-policy-entries-expand` (anchor read off the RENDERED page
 * — `curl https://code.claude.com/docs/en/managed-mcp` and a grep for `id="…"`,
 * with `#how-a-server-is-evaluated`, `#match-servers-by-url-command-or-name`
 * and `#how-restrictions-appear-to-users` as positive controls on the same
 * fetch, all four present):
 *
 *   "The server's configured value expands from the live process environment,
 *   like the rest of `.mcp.json`. A policy entry expands from a pinned
 *   environment instead, so a variable set by a project or user settings file
 *   can't change what an allowlist entry means."
 *
 * and the table's pinned column for `allowedMcpServers`: "The environment
 * Claude Code started with, plus `env` values from managed settings".
 *
 * ## What this file drives, and why it is here rather than in `shared`
 *
 * The two gates live in `packages/shared`; the pinned environment is composed
 * in `packages/server-core`. Registering a hand-made provider in a shared test
 * would prove the call sites read A registry and say nothing about whether the
 * production host ever fills it — which is the half that was missing. So every
 * arm below goes through the REAL bridge,
 * `registerEnforcedManagedPolicyProvider`, the same function both hosts call at
 * boot, and then drives the REAL `materializeRuntimePoolServers` fold.
 *
 * ## The three arms pull in two directions on purpose
 *
 * Pinning BOTH sides is the symmetric-looking fix and is a fail-OPEN one, so
 * arms 1 and 2 pin the ENTRY while arm 3 proves the SERVER still reads the live
 * environment. A change that pins both makes arm 3 red.
 *
 * ## Nothing here is executed
 *
 * The fold produces server CONFIGS; no pool is created, so no `spawn` is
 * reached. Every absolute path below is matcher input and marker data, and
 * `MATCHER_ONLY` asserts mechanically that the policy fixtures would be REFUSED
 * by this repo's own gate-runner executor guard.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseManagedPiPolicyV1,
  registerManagedPiPolicyProvider,
  registerManagedPolicyExpansionEnvironmentProvider,
  resolveManagedPolicyExpansionEnvironment,
  type ManagedPiPolicyV1,
} from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { registerComposedManagedEnvProvider } from '@nessy-agent/shared/config'
import { materializeRuntimePoolServers } from '@nessy-agent/shared/mcp'
import { computeNormalizedBundleHash } from '@nessy-agent/shared/plugins'
import type { CapabilityTurnRuntime } from '@nessy-agent/shared/agent/backend/types'
import { registerEnforcedManagedPolicyProvider } from '../managed-policy-resolution.ts'
import {
  assertNoHomeOrRootPath,
  GateSafetyRefusal,
} from '../../../../../scripts/gate-safety.ts'

/**
 * Assert that `value` would be REFUSED by the gate runners' executor guard —
 * i.e. that it can only ever be matcher input. The same harness P2.396's file
 * uses, for the same reason: an environment-expansion test with toy values
 * proves nothing about a policy an administrator would write.
 */
function MATCHER_ONLY(value: string): string {
  expect(() => assertNoHomeOrRootPath('a P2.410 fixture', value)).toThrow(GateSafetyRefusal)
  return value
}

/** The variable an administrator pins in the managed `env` block. */
const TOOLS_VAR = 'NESSY_P2410_TOOLS'

let root: string
let vettedDir: string
let decoyDir: string
let bundleRoot: string
let previousToolsVar: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'p2410-pool-gate-'))
  // Absolute, and matcher input only — asserted, not assumed. A `${VAR}` entry
  // is NOT wrapped: it starts with the reference, so the executor guard's
  // absolute-path rule does not see it, and claiming otherwise would be a
  // harness that fires for the wrong reason.
  vettedDir = MATCHER_ONLY(join(root, 'vetted'))
  decoyDir = MATCHER_ONLY(join(root, 'decoy'))
  bundleRoot = join(root, 'bundle')
  mkdirSync(vettedDir, { recursive: true })
  mkdirSync(decoyDir, { recursive: true })
  mkdirSync(join(bundleRoot, 'bin'), { recursive: true })
  // A file, executable, and never run: `qualifyPluginStdioCommand` stats it and
  // checks the X bit before the fold will consider the server at all.
  writeFileSync(join(bundleRoot, 'bin', 'acme'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(bundleRoot, 'bin', 'acme'), 0o755)
  previousToolsVar = process.env[TOOLS_VAR]
})

afterEach(() => {
  // The three registries this file's bridge writes, all process-scoped.
  registerManagedPiPolicyProvider(undefined)
  registerComposedManagedEnvProvider(undefined)
  registerManagedPolicyExpansionEnvironmentProvider(undefined)
  if (previousToolsVar === undefined) delete process.env[TOOLS_VAR]
  else process.env[TOOLS_VAR] = previousToolsVar
  if (root) rmSync(root, { recursive: true, force: true })
})

/**
 * Drive the REAL production bridge with an administrator's delivered payload.
 *
 * `env` is the managed block the page's pinned column names; `deniedMcpServers`
 * is the policy under test. The file source is stubbed empty so the host's own
 * managed policy file cannot decide an arm.
 */
function deployManagedPolicy(document: Record<string, unknown>): void {
  const policy: ManagedPiPolicyV1 = parseManagedPiPolicyV1({
    schemaVersion: 1,
    disabledPermissionModes: [],
    ...document,
  })
  registerEnforcedManagedPolicyProvider({
    file: () => ({ policy: parseManagedPiPolicyV1({ schemaVersion: 1, disabledPermissionModes: [] }), drops: [] }),
    delivered: () => policy,
  })
}

/** The built-in dp fold, with dp injected so no host lookup decides an arm. */
async function foldBuiltin(dpPath: string): Promise<Record<string, unknown>> {
  const result = await materializeRuntimePoolServers(
    {
      view: { sources: [], mcpServers: [] },
      materializer: {
        assertActive: () => {},
        readText: async () => { throw new Error('a built-in must not be read from disk') },
        resolvePath: async () => join(root, 'abs'),
        resolveCredential: () => { throw new Error('no credential in this suite') },
        verifyPlugin: async () => {},
      },
    } as unknown as CapabilityTurnRuntime,
    {
      workspaceRootPath: root,
      workspaceId: 'ws_a',
      dpSessionState: 'ready',
      builtinDpMcpServers: {
        enabled: { dpGitlab: true },
        resolveDpPath: () => dpPath,
        runtimeEnv: {},
      },
    },
  )
  return result.mergedMcpServers
}

/** The plugin stdio fold, on a bundle-contained executable. */
async function foldPlugin(args?: string[]): Promise<Record<string, unknown>> {
  const bundleHash = await computeNormalizedBundleHash(bundleRoot)
  const result = await materializeRuntimePoolServers(
    {
      view: {
        sources: [],
        mcpServers: [{
          key: 'acme#mcp',
          wireName: 'acme',
          logicalName: 'acme-server',
          definition: { type: 'stdio', command: 'bin/acme', ...(args ? { args } : {}) },
          pluginRuntime: {
            rootPath: bundleRoot,
            dataPath: join(root, 'data'),
            bundleHash,
            profile: 'claude-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://acme',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      },
      materializer: {
        assertActive: () => {},
        readText: async () => { throw new Error('a plugin server must not be read from disk here') },
        resolvePath: async () => join(root, 'abs'),
        resolveCredential: () => { throw new Error('no credential in this suite') },
        verifyPlugin: async () => {},
      },
    } as unknown as CapabilityTurnRuntime,
    {
      workspaceRootPath: root,
      workspaceId: 'ws_a',
      builtinDpMcpServers: false,
      dpSessionState: 'ready',
    },
  )
  return result.mergedMcpServers
}

describe('the refusal harness itself', () => {
  it('refuses a home-shaped fixture and accepts a repo-relative control', () => {
    // Both directions: a harness that never fires and one that always fires
    // look identical from the tests that use it.
    expect(() => MATCHER_ONLY('/Users/corp-admin/vetted/dp')).not.toThrow()
    expect(() => MATCHER_ONLY('packages/server-core')).toThrow()
    expect(() => assertNoHomeOrRootPath('control', 'packages/server-core')).not.toThrow()
  })
})

describe('P2.410 — the built-in dp fold expands the entry from the pinned environment', () => {
  it('a variable mutated after startup does not move the fold\'s verdict', async () => {
    const dpPath = join(vettedDir, 'dp')
    // What the administrator wrote. A policy pattern, never a path we run.
    const entry = '${' + TOOLS_VAR + '}/dp'
    deployManagedPolicy({
      env: { [TOOLS_VAR]: vettedDir },
      deniedMcpServers: [{ serverCommand: [entry, 'ai', 'mcp', 'gitlab'] }],
    })
    // The mid-session mutation: a project `.env`, a shell export inherited by a
    // later child, an `export` in a hook.
    process.env[TOOLS_VAR] = decoyDir

    // Pinned, the deny still means what the administrator wrote.
    expect(await foldBuiltin(dpPath)).not.toHaveProperty('dpGitlab')

    // The positive control on the same rig: with the entry pointed at the decoy
    // instead, the SAME fold yields the server. Without this, "no dpGitlab"
    // would be indistinguishable from a fold that materialized nothing.
    deployManagedPolicy({
      env: { [TOOLS_VAR]: decoyDir },
      deniedMcpServers: [{ serverCommand: [entry, 'ai', 'mcp', 'gitlab'] }],
    })
    expect(await foldBuiltin(dpPath)).toHaveProperty('dpGitlab')
  })

  it('unpinned, the same mutation evaporates the deny', async () => {
    // The pre-P2.410 behaviour, asserted rather than described, so a change that
    // quietly drops the pin at this call site cannot pass this file. Nothing
    // registers the bridge here, so the gate falls back to the live
    // environment — which is exactly what the unpinned call site did.
    const dpPath = join(vettedDir, 'dp')
    const entry = '${' + TOOLS_VAR + '}/dp'
    registerManagedPiPolicyProvider(() => parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      deniedMcpServers: [{ serverCommand: [entry, 'ai', 'mcp', 'gitlab'] }],
    }))
    process.env[TOOLS_VAR] = decoyDir
    expect(await foldBuiltin(dpPath)).toHaveProperty('dpGitlab')
    // …and the same rig denies when the live value happens to agree, which is
    // the control proving the entry is being matched at all.
    process.env[TOOLS_VAR] = vettedDir
    expect(await foldBuiltin(dpPath)).not.toHaveProperty('dpGitlab')
  })
})

describe('P2.410 — the plugin stdio fold expands the entry from the pinned environment', () => {
  it('a variable mutated after startup does not move the fold\'s verdict', async () => {
    // The deny names the bundle path the plugin executable resolves to — the
    // spelling `ps` prints — through a variable the administrator pinned.
    const entry = '${' + TOOLS_VAR + '}/bin/acme'
    const canonicalBundle = realpathSync(bundleRoot)
    deployManagedPolicy({
      env: { [TOOLS_VAR]: canonicalBundle },
      deniedMcpServers: [{ serverCommand: [entry] }],
    })
    process.env[TOOLS_VAR] = decoyDir

    expect(await foldPlugin()).not.toHaveProperty('acme')

    // Positive control on the same rig.
    deployManagedPolicy({
      env: { [TOOLS_VAR]: decoyDir },
      deniedMcpServers: [{ serverCommand: [entry] }],
    })
    expect(await foldPlugin()).toHaveProperty('acme')
  })

  it('the SERVER\'s configured value still reads the LIVE environment', async () => {
    // The other half of the split, and the reason pinning both sides would be a
    // regression rather than a stricter fix. The ENTRY is LITERAL — the
    // resolution the page prescribes, "use literal URLs and commands for
    // entries you rely on for enforcement" — and the SERVER references the
    // variable. Its real argv at spawn time is whatever the live environment
    // says, so judging it on the startup value would let it slip the deny.
    const reference = '${' + TOOLS_VAR + '}'
    deployManagedPolicy({
      env: { [TOOLS_VAR]: vettedDir },
      deniedMcpServers: [{ serverCommand: ['bin/acme', '--tools', MATCHER_ONLY(decoyDir)] }],
    })
    process.env[TOOLS_VAR] = decoyDir

    expect(await foldPlugin(['--tools', reference])).not.toHaveProperty('acme')

    // Positive control: with the live value moved off the denied directory the
    // same server materializes, so the arm above is the deny firing rather than
    // the fold refusing this fixture for an unrelated reason.
    process.env[TOOLS_VAR] = vettedDir
    expect(await foldPlugin(['--tools', reference])).toHaveProperty('acme')
  })
})

describe('the bridge itself', () => {
  it('registers the pinned environment from the same call that registers the policy', () => {
    // The half a shared-side test cannot see: that a production host wiring the
    // policy also wires the environment. Both hosts call this one function.
    // Nothing registered yet: the reader says so rather than guessing, which is
    // what keeps a non-managed install on its pre-P2.396 behaviour.
    expect(resolveManagedPolicyExpansionEnvironment()).toBeUndefined()
    deployManagedPolicy({ env: { [TOOLS_VAR]: vettedDir } })
    // Read back through the shared-side reader the two gates use.
    expect(resolveManagedPolicyExpansionEnvironment()?.[TOOLS_VAR]).toBe(vettedDir)
    // The startup snapshot underneath it, not a copy of the live environment:
    // a variable set after this process started must not reach it.
    process.env[TOOLS_VAR] = decoyDir
    expect(resolveManagedPolicyExpansionEnvironment()?.[TOOLS_VAR]).toBe(vettedDir)
  })
})
