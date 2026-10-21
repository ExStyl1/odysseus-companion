/**
 * materializeRuntimePoolServers (U3b) — the single materialization authority
 * shared by BaseAgent.setSourceServers and WorkspaceMcpPoolRegistry.
 *
 * Proves it maps a runtime view's pinned MCP servers + source-transport MCP
 * to wire-name-keyed configs (the exact set `pool.sync` consumes), merges the
 * two without collision, and — because it reads only `view.mcpServers` /
 * `view.sources` (which `toAgentRuntime` already filters to RUNNABLE, enabled
 * entries) — never emits a disabled source's server (connect gating inherited).
 */

import { afterEach, beforeEach, describe, it, expect, spyOn } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as credentialsIndexModule from '../../credentials/index.ts'
import * as credentialsManagerModule from '../../credentials/manager.ts'
import { credentialIdToAccount, type CredentialId, type StoredCredential } from '../../credentials/types.ts'
import { resetPluginMcpTokenRefreshForTests } from '../../plugins/mcp-token-refresh.ts'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeRuntimePoolServers, mergePinnedMcpServers } from '../runtime-pool-servers.ts'
import type { CapabilityTurnRuntime } from '../../agent/backend/types.ts'
import {
  CapabilityMaterializationError,
  createCapabilitySnapshotMaterializer,
  type CapabilitySnapshotMaterializer,
} from '../../capabilities/materializer.ts'
import type {
  CapabilityResolver,
  EffectiveCapabilitySnapshot,
  NativeResourceRef,
} from '../../capabilities/resolver.ts'
import { pluginNpxRuntimeRoot } from '../../plugins/stdio-command.ts'

const NEUTRAL_BUN_CONFIG = process.platform === 'win32' ? 'NUL' : '/dev/null'

/**
 * A7 folds the built-in dp set into `mergedMcpServers` by DEFAULT, and every arm
 * above `the built-in dp set reaches the pool` is about the CONFIGURED set — so
 * they opt out by name.
 *
 * Since the owner decision of 2026-08-01 every built-in defaults to DISABLED, so
 * the default fold already contributes nothing and these arms would pass without
 * the opt-out. It stays for two reasons. It pins them to the configured set
 * whatever the built-in defaults become, so a future flip has to fail in the A7
 * arms below — which are about exactly that decision — instead of scattering
 * through twenty unrelated ones. And it keeps them independent of whether the
 * host has `dp`: an arm asserting `mergedMcpServers` `toEqual({})` that passed
 * on a CI box with no `dp` and failed on a developer machine with one is the
 * failure mode that is hardest to read when it finally happens.
 */
const NO_BUILTIN_DP = { builtinDpMcpServers: false } as const

/**
 * `resolveCredential` THROWS when the credential is not ready, because that is
 * what the production materializer does (`materializer.ts:resolveCredential`
 * raises `capability-snapshot-credential-not-ready` for a missing, rotated or
 * expired record). Modelling it as a quiet `{ ready: false }` is what let this suite —
 * and the C5 install probe — pass while a workspace holding one
 * installed-but-not-logged-in OAuth plugin failed every materialization in the
 * shipped app.
 */
function fakeMaterializer(overrides: Partial<CapabilitySnapshotMaterializer> = {}): CapabilitySnapshotMaterializer {
  return {
    assertActive: () => {},
    verifyPlugin: async () => {},
    resolvePath: async () => '/abs/path',
    readText: async () => '{}',
    resolveCredential: () => { throw new CapabilityMaterializationError('credential-not-ready') },
    ...overrides,
  }
}

/** Minimal runtime view carrying only the fields materialization reads. */
function runtimeWith(view: Partial<CapabilityTurnRuntime['view']>, materializer = fakeMaterializer()): CapabilityTurnRuntime {
  return {
    view: {
      generation: 'g',
      sources: [],
      skills: [],
      mcpServers: [],
      hooks: [],
      automations: [],
      agents: [],
      promptLayers: [],
      memory: [],
      permissionLayers: [],
      commands: [],
      promptCommands: [],
      apps: [],
      lspServers: [],
      ...view,
    },
    materializer,
  } as unknown as CapabilityTurnRuntime
}

describe('materializeRuntimePoolServers', () => {
  it('maps a pinned HTTP mcp server to a wire-name-keyed config (no I/O)', async () => {
    const runtime = runtimeWith({
      mcpServers: [
        { key: 'k', wireName: 'gh', definition: { type: 'http', url: 'https://mcp.test/gh' } },
      ] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })
    const out = await materializeRuntimePoolServers(runtime, { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' })
    expect(out.mergedMcpServers).toEqual({ gh: { type: 'http', url: 'https://mcp.test/gh' } })
    expect(out.apiServers).toEqual({})
  })

  it('resolves a source-transport MCP from a native config document', async () => {
    const doc = JSON.stringify({
      id: 'id', name: 'GH', slug: 'gh', enabled: true, provider: 'custom', type: 'mcp',
      mcp: { url: 'https://mcp.test/gh' },
    })
    const materializer = fakeMaterializer({ readText: async () => doc })
    const runtime = runtimeWith({
      sources: [
        { key: 'src:gh', logicalName: 'gh', resource: { absolutePath: '/ws/sources/gh/config.json' }, mcpWireName: 'gh' },
      ] as unknown as CapabilityTurnRuntime['view']['sources'],
    }, materializer)
    const out = await materializeRuntimePoolServers(runtime, { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' })
    expect(Object.keys(out.mergedMcpServers)).toContain('gh')
  })

  it('emits nothing for an EMPTY runtime view (disabled sources are already filtered upstream)', async () => {
    const runtime = runtimeWith({})
    const out = await materializeRuntimePoolServers(runtime, { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' })
    expect(out.mergedMcpServers).toEqual({})
    expect(out.apiServers).toEqual({})
    expect(out.sources).toEqual([])
  })

  it('materializes plugin runtime paths and legacy environment precedence at the spawn boundary', async () => {
    const names = ['NESSY_TEST_PLUGIN_TOKEN', 'NESSY_TEST_PLUGIN_ENDPOINT', 'NESSY_TEST_PLUGIN_MODE'] as const
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
    Object.assign(process.env, {
      NESSY_TEST_PLUGIN_TOKEN: 'host-token',
      NESSY_TEST_PLUGIN_ENDPOINT: 'host-endpoint',
      NESSY_TEST_PLUGIN_MODE: 'host-mode',
    })
    try {
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#mcp',
          wireName: 'configured',
          definition: {
            type: 'stdio',
            command: 'node',
            args: ['${NESSY_PLUGIN_ROOT}/server.js', '${NESSY_TEST_PLUGIN_TOKEN}'],
            cwd: '.',
            forwardedEnvironmentNames: [...names],
            requiredEnvironmentNames: ['NESSY_TEST_PLUGIN_TOKEN'],
            toolTimeoutMs: 900_000,
            required: true,
          },
          descriptorEnvironmentDefaults: {
            NESSY_TEST_PLUGIN_ENDPOINT: 'default-endpoint',
          },
          descriptorEnvironment: {
            NESSY_TEST_PLUGIN_MODE: 'literal-mode',
          },
          pluginRuntime: {
            rootPath: '/cache/plugin',
            dataPath: '/data/plugin',
            bundleHash: 'a'.repeat(64),
            profile: 'generic-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://test',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
        workspaceId: 'ws-1',
        pluginNodeRuntime: {
          command: process.execPath,
          environment: { ELECTRON_RUN_AS_NODE: '1' },
        },
      })
      expect(out.mergedMcpServers.configured).toEqual({
        type: 'stdio',
        command: process.execPath,
        args: ['/cache/plugin/server.js', 'host-token'],
        cwd: '/cache/plugin',
        env: expect.objectContaining({
          NESSY_PLUGIN_ROOT: '/cache/plugin',
          NESSY_PLUGIN_DATA: '/data/plugin',
          NESSY_TEST_PLUGIN_TOKEN: 'host-token',
          NESSY_TEST_PLUGIN_ENDPOINT: 'host-endpoint',
          NESSY_TEST_PLUGIN_MODE: 'literal-mode',
          ELECTRON_RUN_AS_NODE: '1',
        }),
        inheritProcessEnv: false,
        toolTimeoutMs: 900_000,
        required: true,
        pluginRuntime: {
          bundleRootPath: '/cache/plugin',
          dataPath: '/data/plugin',
          expectedBundleHash: 'a'.repeat(64),
        },
      })
    } finally {
      for (const name of names) {
        const value = previous[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('keeps a reviewed default when the mapped host environment value is blank', async () => {
    const environmentName = 'NESSY_TEST_PLUGIN_BLANK_TOKEN'
    const previous = process.env[environmentName]
    process.env[environmentName] = '   '
    try {
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#blank-default',
          wireName: 'blank-default',
          definition: {
            type: 'stdio',
            command: 'node',
            forwardedEnvironmentNames: [environmentName],
            requiredEnvironmentNames: [environmentName],
          },
          descriptorEnvironmentDefaults: {
            [environmentName]: 'reviewed-fallback',
          },
          pluginRuntime: {
            rootPath: '/cache/plugin',
            dataPath: '/data/plugin',
            bundleHash: 'b'.repeat(64),
            profile: 'generic-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://blank-default',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
        workspaceId: 'ws-1',
        pluginNodeRuntime: { command: process.execPath },
      })

      expect(out.mergedMcpServers['blank-default']).toMatchObject({
        type: 'stdio',
        env: expect.objectContaining({ [environmentName]: 'reviewed-fallback' }),
      })
    } finally {
      if (previous === undefined) delete process.env[environmentName]
      else process.env[environmentName] = previous
    }
  })

  it('forwards official Codex env_vars mappings when present without requiring absent values', async () => {
    const previousCodexHome = process.env.CODEX_HOME
    const previousGhToken = process.env.GH_TOKEN
    delete process.env.CODEX_HOME
    process.env.GH_TOKEN = 'mapped-host-token'
    try {
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#security',
          wireName: 'security',
          definition: {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
            forwardedEnvironmentSources: {
              CODEX_HOME: 'CODEX_HOME',
              GITHUB_TOKEN: 'GH_TOKEN',
            },
          },
          pluginRuntime: {
            rootPath: '/cache/security', dataPath: '/data/security', bundleHash: '9'.repeat(64),
            profile: 'codex-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://security',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
        pluginNodeRuntime: { command: process.execPath },
      })

      // The ABSENCE check runs before the shape check, deliberately. On bun
      // 1.3.14 `toMatchObject` with an asymmetric matcher OVERWRITES the
      // matched property of the RECEIVED object with the matcher instance, so
      // asserting `env: expect.objectContaining(...)` first leaves
      // `security.env` an empty matcher and makes this `not.toHaveProperty`
      // vacuously true — it passed even when CODEX_HOME really was forwarded
      // (P2.413; proved by a mutant that survived until this line moved up).
      expect((out.mergedMcpServers.security as { env?: Record<string, string> }).env).not.toHaveProperty('CODEX_HOME')
      expect(out.mergedMcpServers.security).toMatchObject({
        type: 'stdio',
        env: expect.objectContaining({ GITHUB_TOKEN: 'mapped-host-token' }),
      })
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      if (previousGhToken === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = previousGhToken
    }
  })

  it('interpolates plugin HTTP only from explicitly reviewed environment names', async () => {
    const allowedName = 'NESSY_TEST_PLUGIN_REMOTE_HOST'
    const secretName = 'NESSY_TEST_PLUGIN_UNDECLARED_SECRET'
    const previousAllowed = process.env[allowedName]
    const previousSecret = process.env[secretName]
    process.env[allowedName] = 'allowed.example.test'
    process.env[secretName] = 'must-not-leak'
    try {
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#remote',
          wireName: 'remote',
          definition: {
            type: 'http',
            url: `https://\${${allowedName}}/\${${secretName}}`,
            forwardedEnvironmentNames: [allowedName],
            requiredEnvironmentNames: [allowedName],
            toolTimeoutMs: 900_000,
          },
          descriptorHeaders: {
            'X-Allowed': `\${${allowedName}}`,
            'X-Undeclared': `\${${secretName}}`,
          },
          pluginRuntime: {
            rootPath: '/cache/plugin',
            dataPath: '/data/plugin',
            bundleHash: 'd'.repeat(64),
            profile: 'generic-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://remote',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
      })

      // An undeclared name is not in the reviewed environment, so it cannot
      // resolve; per `mcp.md:477` the unexpanded `${VAR}` text is used as-is,
      // which keeps the reference visible instead of silently blanking it. The
      // isolation property is unchanged: the host value never appears.
      expect(out.mergedMcpServers.remote).toEqual({
        type: 'http',
        url: `https://allowed.example.test/\${${secretName}}`,
        headers: { 'X-Allowed': 'allowed.example.test', 'X-Undeclared': `\${${secretName}}` },
        toolTimeoutMs: 900_000,
      })
      expect(JSON.stringify(out.mergedMcpServers)).not.toContain('must-not-leak')
    } finally {
      if (previousAllowed === undefined) delete process.env[allowedName]
      else process.env[allowedName] = previousAllowed
      if (previousSecret === undefined) delete process.env[secretName]
      else process.env[secretName] = previousSecret
    }
  })

  it('keeps an unset ${VAR} literal and warns once for the server', async () => {
    // `mcp.md:477`: "the config still loads: Claude Code reports a
    // missing-variable warning for that server ... and uses the unexpanded
    // ${VAR} text as-is". Plugin servers get "the same environment variables as
    // manually configured servers" (`mcp.md:321`), so this branch must behave
    // like the `.mcp.json` reader rather than blanking the value.
    const messages: string[] = []
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'plugin#warned',
        wireName: 'warned',
        definition: {
          type: 'http',
          url: 'https://${MISSING_HOST}/mcp',
        },
        descriptorHeaders: { Authorization: 'Bearer ${MISSING_TOKEN}' },
        descriptorEnvironment: { COPY: '${MISSING_ENV}' },
        pluginRuntime: {
          rootPath: '/cache/plugin',
          dataPath: '/data/plugin',
          bundleHash: 'e'.repeat(64),
          profile: 'generic-plugin-env-v1',
        },
        pluginInstanceId: 'plugin://warned',
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
      workspaceId: 'ws-1',
      debug: message => messages.push(message),
    })

    expect(out.mergedMcpServers.warned).toEqual({
      type: 'http',
      url: 'https://${MISSING_HOST}/mcp',
      headers: { Authorization: 'Bearer ${MISSING_TOKEN}' },
    })
    const warnings = messages.filter(message => message.includes('references unset environment variables'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('MISSING_ENV, MISSING_HOST, MISSING_TOKEN')
  })

  it('still withholds a server whose required variable only resolves to a literal token', async () => {
    // The literal fallback must not make an unsatisfied requirement look
    // supplied: `${VAR}` is a non-empty string, so the availability gate reads
    // the expansion's unresolved-key set rather than the value alone.
    const messages: string[] = []
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'plugin#gated',
        wireName: 'gated',
        definition: {
          type: 'http',
          url: 'https://mcp.test/gated',
          requiredEnvironmentNames: ['NEEDED'],
        },
        descriptorEnvironment: { NEEDED: '${NESSY_TEST_ABSENT_SOURCE}' },
        pluginRuntime: {
          rootPath: '/cache/plugin',
          dataPath: '/data/plugin',
          bundleHash: 'f'.repeat(64),
          profile: 'generic-plugin-env-v1',
        },
        pluginInstanceId: 'plugin://gated',
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
      workspaceId: 'ws-1',
      debug: message => messages.push(message),
    })

    expect(out.mergedMcpServers.gated).toBeUndefined()
    expect(messages.some(message => message.includes('missing environment: NEEDED'))).toBe(true)
  })

  it('materializes an official GitHub bearer env binding without creating a Source', async () => {
    const environmentName = 'GITHUB_PAT_TOKEN'
    const previous = process.env[environmentName]
    process.env[environmentName] = 'github-token-value'
    try {
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#github',
          wireName: 'github',
          definition: {
            type: 'http',
            url: 'https://api.githubcopilot.com/mcp/',
            forwardedEnvironmentNames: [environmentName],
            forwardedEnvironmentSources: { [environmentName]: environmentName },
            requiredEnvironmentNames: [environmentName],
          },
          descriptorHeaders: {
            Authorization: `Bearer \${${environmentName}}`,
          },
          pluginRuntime: {
            rootPath: '/cache/github',
            dataPath: '/data/github',
            bundleHash: 'e'.repeat(64),
            profile: 'codex-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://github',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
      })

      expect(out.mergedMcpServers.github).toEqual({
        type: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer github-token-value' },
      })
    } finally {
      if (previous === undefined) delete process.env[environmentName]
      else process.env[environmentName] = previous
    }
  })

  it('fails closed when a reviewed plugin HTTP environment name is missing', async () => {
    const missingName = 'NESSY_TEST_PLUGIN_REMOTE_DEFINITELY_MISSING'
    const previous = process.env[missingName]
    delete process.env[missingName]
    const diagnostics: string[] = []
    try {
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#remote',
          wireName: 'remote',
          definition: {
            type: 'http',
            url: `https://\${${missingName}}/mcp`,
            forwardedEnvironmentNames: [missingName],
            requiredEnvironmentNames: [missingName],
          },
          pluginInstanceId: 'plugin://remote',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1', debug: message => diagnostics.push(message),
      })
      expect(out.mergedMcpServers).toEqual({})
      expect(diagnostics).toEqual([
        `Plugin MCP remote is unavailable; missing environment: ${missingName}`,
      ])
    } finally {
      if (previous !== undefined) process.env[missingName] = previous
    }
  })

  it('skips only the plugin MCP whose required environment disappeared after resolution', async () => {
    const runtime = runtimeWith({
      mcpServers: [
        {
          key: 'plugin#mcp',
          wireName: 'missing',
          definition: {
            type: 'stdio', command: 'node', requiredEnvironmentNames: ['NESSY_TEST_DEFINITELY_MISSING'],
          },
          pluginInstanceId: 'plugin://test',
        },
        { key: 'healthy', wireName: 'healthy', definition: { type: 'http', url: 'https://mcp.test/healthy' } },
      ] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const out = await materializeRuntimePoolServers(runtime, { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' })
    expect(out.mergedMcpServers).toEqual({ healthy: { type: 'http', url: 'https://mcp.test/healthy' } })
  })

  it('fails closed for plugin bare node when the managed runtime is unavailable', async () => {
    const diagnostics: string[] = []
    const runtime = runtimeWith({
      mcpServers: [
        {
          key: 'plugin#mcp',
          wireName: 'missing-runtime',
          definition: { type: 'stdio', command: 'node', args: ['server.js'] },
          pluginRuntime: {
            rootPath: '/cache/plugin', dataPath: '/data/plugin', bundleHash: 'e'.repeat(64),
            profile: 'generic-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://test',
        },
        { key: 'healthy', wireName: 'healthy', definition: { type: 'http', url: 'https://mcp.test/healthy' } },
      ] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
      workspaceId: 'ws-1',
      debug: message => diagnostics.push(message),
    })
    expect(out.mergedMcpServers).toEqual({ healthy: { type: 'http', url: 'https://mcp.test/healthy' } })
    expect(diagnostics).toEqual([
      'Plugin MCP missing-runtime is unavailable; managed Node runtime is missing. Reinstall or update Nessy Desktop.',
    ])
  })

  it('resolves legacy dpGitlab through the explicit host-owned dp binding', async () => {
    const previousGitlabToken = process.env.GITLAB_TOKEN
    process.env.GITLAB_TOKEN = 'must-not-reach-dp'
    try {
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#dpGitlab',
          wireName: 'dpGitlab',
          definition: {
            type: 'stdio',
            command: 'dp',
            args: ['ai', 'mcp', 'gitlab'],
            forwardedEnvironmentNames: ['GITLAB_TOKEN'],
          },
          pluginRuntime: {
            rootPath: '/cache/plugin', dataPath: '/data/plugin', bundleHash: 'b'.repeat(64),
            profile: 'generic-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://default',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })
      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
        pluginNodeRuntime: {
          command: process.execPath,
          executables: {
            dp: {
              command: process.execPath,
              environment: {
                HOME: '/managed-read-home',
                DP_WORKDIR: '/managed-dp-state',
                DP_AI_MCP_SKIP_LOGIN: 'true',
              },
              writableRoots: ['/managed-dp-state'],
              externalAuthProvider: 'dp',
            },
          },
        },
        dpSessionState: 'ready',
      })
      expect(out.mergedMcpServers.dpGitlab).toMatchObject({
        type: 'stdio', command: process.execPath, args: ['ai', 'mcp', 'gitlab'],
        env: {
          HOME: '/managed-read-home',
          DP_WORKDIR: '/managed-dp-state',
          DP_AI_MCP_SKIP_LOGIN: 'true',
        },
        inheritProcessEnv: false,
        pluginRuntime: {
          expectedBundleHash: 'b'.repeat(64),
          hostWritableRoots: ['/managed-dp-state'],
        },
      })
      const dpServer = out.mergedMcpServers.dpGitlab as Extract<
        CapabilityTurnRuntime['view']['mcpServers'][number]['definition'],
        { type: 'stdio' }
      > & { env?: Record<string, string> }
      expect(dpServer.env).not.toHaveProperty('GITLAB_TOKEN')
      expect(out.externalAuthRequirements).toEqual([{
        provider: 'dp',
        wireNames: ['dpGitlab'],
        pluginInstanceIds: ['plugin://default'],
        state: 'ready',
      }])
    } finally {
      if (previousGitlabToken === undefined) delete process.env.GITLAB_TOKEN
      else process.env.GITLAB_TOKEN = previousGitlabToken
    }
  })

  it('isolates DP env, argv, and cwd from aliased host and credential values', async () => {
    const sourceName = 'NESSY_TEST_DP_ALIASED_SECRET'
    const previous = process.env[sourceName]
    process.env[sourceName] = 'host-secret'
    try {
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#dp-isolated',
          wireName: 'dp-isolated',
          definition: {
            type: 'stdio',
            command: 'dp',
            args: [
              'ai',
              'mcp',
              'gitlab',
              '--host=${SAFE}',
              '--credential=${CREDENTIAL_ALIAS}',
              '--literal=${LITERAL}',
            ],
            cwd: 'work-${SAFE}-${CREDENTIAL_ALIAS}-${NESSY_PLUGIN_DATA}',
            forwardedEnvironmentSources: { SAFE: sourceName },
            requiredEnvironmentNames: ['LITERAL'],
          },
          descriptorEnvironment: {
            LITERAL: 'literal',
            DATA_ALIAS: '${NESSY_PLUGIN_DATA}',
            HOST_ALIAS: '${SAFE}',
            CREDENTIAL_COPY: '${CREDENTIAL_ALIAS}',
          },
          credentialEnvironment: {
            CREDENTIAL_ALIAS: {
              configKey: 'token',
              credential: { key: 'credential:test' },
            },
          },
          pluginRuntime: {
            rootPath: '/cache/plugin',
            dataPath: '/data/plugin',
            bundleHash: 'b'.repeat(64),
            profile: 'generic-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://default',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      }, fakeMaterializer({
        resolveCredential: () => ({
          ready: true,
          revision: 1,
          value: 'credential-secret',
        }),
      }))

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
        workspaceId: 'ws-1',
        pluginNodeRuntime: {
          command: process.execPath,
          executables: {
            dp: {
              command: process.execPath,
              environment: {
                DP_AI_MCP_SKIP_LOGIN: 'true',
                DP_PLUGIN_DATA: '${NESSY_PLUGIN_DATA}',
                DP_LITERAL: '${LITERAL}',
              },
              writableRoots: ['${NESSY_PLUGIN_DATA}'],
              externalAuthProvider: 'dp',
            },
          },
        },
        dpSessionState: 'ready',
      })

      // DP withholds both the forwarded host alias and the credential, so
      // neither name is in the reviewed environment and both keep their
      // unexpanded `${VAR}` text (`mcp.md:477`). The token carries no value and
      // argv is not shell-expanded, so the isolation this test guards is
      // unchanged — the two assertions ABOVE the shape check prove neither
      // secret appears.
      //
      // They sit above it deliberately: on bun 1.3.14 `toMatchObject` with an
      // asymmetric matcher OVERWRITES the matched property of the RECEIVED
      // object with the matcher instance, so `env: expect.objectContaining(...)`
      // below empties `dp-isolated.env`. Run after it, these two
      // `JSON.stringify(out)` checks no longer serialize the environment they
      // exist to search, and pass no matter what leaks into it (P2.413; proved
      // by a mutant that survived until they moved up).
      expect(JSON.stringify(out)).not.toContain('host-secret')
      expect(JSON.stringify(out)).not.toContain('credential-secret')
      expect(out.mergedMcpServers['dp-isolated']).toMatchObject({
        command: process.execPath,
        args: ['ai', 'mcp', 'gitlab', '--host=${SAFE}', '--credential=${CREDENTIAL_ALIAS}', '--literal=literal'],
        cwd: '/cache/plugin/work-${SAFE}-${CREDENTIAL_ALIAS}-/data/plugin',
        env: expect.objectContaining({
          NESSY_PLUGIN_ROOT: '/cache/plugin',
          NESSY_PLUGIN_DATA: '/data/plugin',
          LITERAL: 'literal',
          DATA_ALIAS: '/data/plugin',
          HOST_ALIAS: '${SAFE}',
          CREDENTIAL_COPY: '${CREDENTIAL_ALIAS}',
          DP_AI_MCP_SKIP_LOGIN: 'true',
          DP_PLUGIN_DATA: '/data/plugin',
          DP_LITERAL: 'literal',
        }),
        pluginRuntime: {
          expectedBundleHash: 'b'.repeat(64),
          hostWritableRoots: ['/data/plugin'],
        },
      })
    } finally {
      if (previous === undefined) delete process.env[sourceName]
      else process.env[sourceName] = previous
    }
  })

  it('preserves reviewed host and credential interpolation for non-DP runtimes', async () => {
    const sourceName = 'NESSY_TEST_NON_DP_ALIASED_VALUE'
    const previous = process.env[sourceName]
    process.env[sourceName] = 'host-value'
    try {
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#node-forwarded',
          wireName: 'node-forwarded',
          definition: {
            type: 'stdio',
            command: 'node',
            args: ['server.js', '${SAFE}', '${CREDENTIAL_ALIAS}'],
            cwd: 'work-${SAFE}-${CREDENTIAL_ALIAS}',
            forwardedEnvironmentSources: { SAFE: sourceName },
          },
          credentialEnvironment: {
            CREDENTIAL_ALIAS: {
              configKey: 'token',
              credential: { key: 'credential:test' },
            },
          },
          pluginRuntime: {
            rootPath: '/cache/plugin',
            dataPath: '/data/plugin',
            bundleHash: 'b'.repeat(64),
            profile: 'generic-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://default',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      }, fakeMaterializer({
        resolveCredential: () => ({
          ready: true,
          revision: 1,
          value: 'credential-value',
        }),
      }))

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
        workspaceId: 'ws-1',
        pluginNodeRuntime: { command: process.execPath },
      })

      expect(out.mergedMcpServers['node-forwarded']).toMatchObject({
        command: process.execPath,
        args: ['server.js', 'host-value', 'credential-value'],
        cwd: '/cache/plugin/work-host-value-credential-value',
        env: expect.objectContaining({
          SAFE: 'host-value',
          CREDENTIAL_ALIAS: 'credential-value',
        }),
      })
    } finally {
      if (previous === undefined) delete process.env[sourceName]
      else process.env[sourceName] = previous
    }
  })

  /**
   * This is the PLUGIN half of the dp gate, and its threshold is the STRICTER
   * one: `dpSessionState !== 'ready'` withholds a plugin-bound server, because
   * that path materializes real credential/argv authority through the
   * host-owned dp binding. Since owner decision 2026-08-06 the boundary is
   * explicitly TWO-TIER — a built-in dp server (no credential of its own)
   * gates on the narrower `=== 'needs-login'` instead, proven in
   * `'the built-in dp set reaches the pool (A7)'` below. Never read this
   * test's "gates … DP-bound servers" as the one rule for every dp-bound wire
   * name; it is the rule for PLUGIN ones only.
   */
  it('gates only trusted DP-bound servers and returns one stable requirement', async () => {
    const runtime = runtimeWith({
      sources: [{
        key: 'source:healthy-api',
        logicalName: 'healthy-api',
        resource: { absolutePath: '/ws/sources/healthy-api/config.json' },
      }] as unknown as CapabilityTurnRuntime['view']['sources'],
      mcpServers: [
        ...['dpGitlab', 'dpJira'].map((wireName, index) => ({
          key: `plugin#${wireName}`,
          wireName,
          definition: { type: 'stdio', command: 'dp', args: ['ai', 'mcp', wireName] },
          pluginRuntime: {
            rootPath: '/cache/plugin',
            dataPath: '/data/plugin',
            bundleHash: String(index + 1).repeat(64),
            profile: 'generic-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://default',
        })),
        {
          key: 'plugin#spoofed',
          wireName: 'spoofed',
          definition: {
            type: 'stdio',
            command: 'dp',
            args: ['ai', 'mcp', 'spoofed'],
            externalAuthProvider: 'dp',
          },
          pluginRuntime: {
            rootPath: '/cache/spoofed',
            dataPath: '/data/spoofed',
            bundleHash: '3'.repeat(64),
            profile: 'generic-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://spoofed',
        },
        {
          key: 'healthy',
          wireName: 'healthy',
          definition: { type: 'http', url: 'https://mcp.test/healthy' },
        },
      ] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    }, fakeMaterializer({
      readText: async () => JSON.stringify({
        id: 'healthy-api',
        name: 'Healthy API',
        slug: 'healthy-api',
        enabled: true,
        provider: 'custom',
        type: 'api',
        api: { baseUrl: 'https://api.test/', authType: 'none' },
      }),
    }))

    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
      workspaceId: 'ws-1',
      pluginNodeRuntime: {
        command: process.execPath,
        executables: {
          dp: {
            command: process.execPath,
            environment: { DP_AI_MCP_SKIP_LOGIN: 'true' },
            externalAuthProvider: 'dp',
          },
        },
      },
      dpSessionState: 'needs-login',
    })

    expect(Object.keys(out.mergedMcpServers).sort()).toEqual(['healthy'])
    expect(Object.keys(out.apiServers)).toEqual(['healthy-api'])
    expect(out.externalAuthRequirements).toEqual([{
      provider: 'dp',
      wireNames: ['dpGitlab', 'dpJira', 'spoofed'],
      pluginInstanceIds: ['plugin://default', 'plugin://spoofed'],
      state: 'needs-login',
    }])
  })

  it('does not trust a manifest external-auth field without a trusted host marker', async () => {
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'plugin#spoofed',
        wireName: 'spoofed',
        definition: {
          type: 'stdio',
          command: 'dp',
          args: ['ai', 'mcp', 'spoofed'],
          externalAuthProvider: 'dp',
        },
        pluginRuntime: {
          rootPath: '/cache/spoofed',
          dataPath: '/data/spoofed',
          bundleHash: '4'.repeat(64),
          profile: 'generic-plugin-env-v1',
        },
        pluginInstanceId: 'plugin://spoofed',
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
      workspaceId: 'ws-1',
      pluginNodeRuntime: {
        command: process.execPath,
        executables: { dp: { command: process.execPath } },
      },
      dpSessionState: 'needs-login',
    })

    expect(Object.keys(out.mergedMcpServers)).toEqual(['spoofed'])
    expect(out.externalAuthRequirements).toEqual([])
  })

  it('rejects non-MCP commands through the externally authenticated DP binding', async () => {
    const diagnostics: string[] = []
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'plugin#dp-token',
        wireName: 'dp-token',
        definition: { type: 'stdio', command: 'dp', args: ['print-token'] },
        pluginRuntime: {
          rootPath: '/cache/plugin',
          dataPath: '/data/plugin',
          bundleHash: '5'.repeat(64),
          profile: 'generic-plugin-env-v1',
        },
        pluginInstanceId: 'plugin://default',
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
      workspaceId: 'ws-1',
      pluginNodeRuntime: {
        command: process.execPath,
        executables: {
          dp: {
            command: process.execPath,
            environment: { DP_AI_MCP_SKIP_LOGIN: 'true' },
            externalAuthProvider: 'dp',
          },
        },
      },
      dpSessionState: 'ready',
      debug: message => diagnostics.push(message),
    })

    expect(out.mergedMcpServers).toEqual({})
    expect(out.externalAuthRequirements).toEqual([])
    expect(diagnostics).toEqual([
      'Plugin MCP dp-token is unavailable; host-owned dp executable only supports ai mcp.',
    ])
  })

  it.each([
    ['missing plugin', undefined, ['ai', 'mcp']],
    ['blank plugin', undefined, ['ai', 'mcp', ' ']],
    ['prepended binding argv', ['wrapper'], ['ai', 'mcp', 'gitlab']],
    ['altered binding prefix', ['ai', 'other'], ['gitlab']],
  ] as const)('rejects %s before propagating DP auth authority', async (_case, bindingArgs, args) => {
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'plugin#dp-invalid',
        wireName: 'dp-invalid',
        definition: { type: 'stdio', command: 'dp', args: [...args] },
        pluginRuntime: {
          rootPath: '/cache/plugin',
          dataPath: '/data/plugin',
          bundleHash: '5'.repeat(64),
          profile: 'generic-plugin-env-v1',
        },
        pluginInstanceId: 'plugin://default',
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
      workspaceId: 'ws-1',
      pluginNodeRuntime: {
        command: process.execPath,
        executables: {
          dp: {
            command: process.execPath,
            ...(bindingArgs ? { args: [...bindingArgs] } : {}),
            externalAuthProvider: 'dp',
          },
        },
      },
      dpSessionState: 'ready',
    })

    expect(out.mergedMcpServers).toEqual({})
    expect(out.externalAuthRequirements).toEqual([])
  })

  it('accepts DP auth authority when binding and descriptor compose to exact ai mcp plugin argv', async () => {
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'plugin#dp-valid',
        wireName: 'dp-valid',
        definition: { type: 'stdio', command: 'dp', args: ['gitlab'] },
        pluginRuntime: {
          rootPath: '/cache/plugin',
          dataPath: '/data/plugin',
          bundleHash: '5'.repeat(64),
          profile: 'generic-plugin-env-v1',
        },
        pluginInstanceId: 'plugin://default',
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
      workspaceId: 'ws-1',
      pluginNodeRuntime: {
        command: process.execPath,
        executables: {
          dp: {
            command: process.execPath,
            args: ['ai', 'mcp'],
            externalAuthProvider: 'dp',
          },
        },
      },
      dpSessionState: 'ready',
    })

    expect(out.mergedMcpServers['dp-valid']).toMatchObject({
      command: process.execPath,
      args: ['ai', 'mcp', 'gitlab'],
    })
    expect(out.externalAuthRequirements).toEqual([{
      provider: 'dp',
      wireNames: ['dp-valid'],
      pluginInstanceIds: ['plugin://default'],
      state: 'ready',
    }])
  })

  it.each([
    ['uvx', ['sample-mcp'], ['tool', 'run'], {
      UV_CACHE_DIR: '${NESSY_PLUGIN_DATA}/uv/cache',
      UV_TOOL_DIR: '${NESSY_PLUGIN_DATA}/uv/tools',
      UV_TOOL_BIN_DIR: '${NESSY_PLUGIN_DATA}/uv/bin',
      UV_PYTHON_INSTALL_DIR: '${NESSY_PLUGIN_DATA}/uv/python',
    }],
    ['python', ['server.py'], ['run', '--no-project', '--python', '3.12', 'python'], {
      UV_CACHE_DIR: '${NESSY_PLUGIN_DATA}/uv/cache',
      UV_PYTHON_INSTALL_DIR: '${NESSY_PLUGIN_DATA}/uv/python',
    }],
  ] as const)('runs plugin %s only through its absolute host-owned binding', async (declared, args, prefix, bindingEnvironment) => {
    const runtime = runtimeWith({
      mcpServers: [{
        key: `plugin#${declared}`, wireName: declared,
        definition: { type: 'stdio', command: declared, args: [...args] },
        pluginRuntime: {
          rootPath: '/cache/plugin', dataPath: '/data/plugin', bundleHash: '6'.repeat(64),
          profile: 'codex-plugin-env-v1',
        },
        pluginInstanceId: 'plugin://portable-runtime',
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
      pluginNodeRuntime: {
        command: process.execPath,
        executables: {
          [declared]: { command: process.execPath, args: [...prefix], environment: bindingEnvironment },
        },
      },
    })

    expect(out.mergedMcpServers[declared]).toMatchObject({
      command: process.execPath,
      args: [...prefix, ...args],
      env: expect.objectContaining({
        UV_CACHE_DIR: '/data/plugin/uv/cache',
        UV_PYTHON_INSTALL_DIR: '/data/plugin/uv/python',
      }),
    })
  })

  it('resolves a canonical plugin-root executable without PATH lookup', async () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'nessy-plugin-relative-command-'))
    const executable = join(bundleRoot, 'bin', 'local-mcp')
    try {
      mkdirSync(join(bundleRoot, 'bin'), { recursive: true })
      writeFileSync(executable, '#!/bin/sh\nexit 0\n')
      if (process.platform !== 'win32') chmodSync(executable, 0o755)
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#local', wireName: 'local',
          definition: { type: 'stdio', command: '${NESSY_PLUGIN_ROOT}/bin/local-mcp', args: ['--stdio'] },
          pluginRuntime: {
            rootPath: bundleRoot, dataPath: '/data/plugin', bundleHash: '5'.repeat(64),
            profile: 'claude-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://local',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
      })

      expect(out.mergedMcpServers.local).toMatchObject({
        command: realpathSync(executable), args: ['--stdio'],
      })
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true })
    }
  })

  it('rejects absolute and symlinked plugin executables outside the immutable bundle', async () => {
    if (process.platform === 'win32') return
    const bundleRoot = mkdtempSync(join(tmpdir(), 'nessy-plugin-command-root-'))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'nessy-plugin-command-outside-'))
    const outside = join(outsideRoot, 'outside-mcp')
    const diagnostics: string[] = []
    try {
      mkdirSync(join(bundleRoot, 'bin'), { recursive: true })
      writeFileSync(outside, '#!/bin/sh\nexit 0\n')
      chmodSync(outside, 0o755)
      symlinkSync(outside, join(bundleRoot, 'bin', 'linked-mcp'))
      const runtime = runtimeWith({
        mcpServers: [
          {
            key: 'plugin#absolute', wireName: 'absolute',
            definition: { type: 'stdio', command: outside },
            pluginRuntime: {
              rootPath: bundleRoot, dataPath: '/data/plugin', bundleHash: '4'.repeat(64),
              profile: 'codex-plugin-env-v1',
            },
            pluginInstanceId: 'plugin://absolute',
          },
          {
            key: 'plugin#linked', wireName: 'linked',
            definition: { type: 'stdio', command: './bin/linked-mcp' },
            pluginRuntime: {
              rootPath: bundleRoot, dataPath: '/data/plugin', bundleHash: '3'.repeat(64),
              profile: 'codex-plugin-env-v1',
            },
            pluginInstanceId: 'plugin://linked',
          },
        ] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1', debug: message => diagnostics.push(message),
      })

      expect(out.mergedMcpServers).toEqual({})
      expect(diagnostics).toEqual([
        'Plugin MCP absolute is unavailable; executable must be contained by the immutable plugin bundle.',
        'Plugin MCP linked is unavailable; executable must be contained by the immutable plugin bundle.',
      ])
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true })
      rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  it('materializes the official build-ios-apps npx MCP through managed Bun state', async () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'nessy-build-ios-npx-'))
    const packageSpec = 'xcodebuildmcp@latest'
    const runtimeRoot = pluginNpxRuntimeRoot(bundleRoot)
    const packageRoot = join(runtimeRoot, 'node_modules', 'xcodebuildmcp')
    const executable = join(packageRoot, 'dist', 'index.js')
    try {
      mkdirSync(join(packageRoot, 'dist'), { recursive: true })
      writeFileSync(join(runtimeRoot, 'package.json'), JSON.stringify({
        private: true,
        dependencies: { xcodebuildmcp: 'latest' },
      }))
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: 'xcodebuildmcp',
        version: '2.7.0',
        bin: 'dist/index.js',
      }))
      writeFileSync(executable, 'process.stdin.resume()')
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#xcodebuildmcp', wireName: 'xcodebuildmcp',
          definition: { type: 'stdio', command: 'npx', args: ['-y', packageSpec, 'mcp'] },
          pluginRuntime: {
            rootPath: bundleRoot, dataPath: '/data/build-ios-apps', bundleHash: 'c'.repeat(64),
            profile: 'codex-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://build-ios-apps',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })
      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
        pluginNodeRuntime: {
          command: process.execPath,
          executables: {
            bunx: {
              command: process.execPath,
              args: ['--no-env-file', `--config=${NEUTRAL_BUN_CONFIG}`],
              environment: {
                HOME: '${NESSY_PLUGIN_DATA}/home',
                BUN_INSTALL_CACHE_DIR: '${NESSY_PLUGIN_DATA}/bun/cache',
              },
            },
          },
        },
      })
      expect(out.mergedMcpServers.xcodebuildmcp).toMatchObject({
        command: process.execPath,
        args: ['--no-env-file', `--config=${NEUTRAL_BUN_CONFIG}`, realpathSync(executable), 'mcp'],
        env: expect.objectContaining({
          HOME: '/data/build-ios-apps/home',
          BUN_INSTALL_CACHE_DIR: '/data/build-ios-apps/bun/cache',
        }),
        inheritProcessEnv: false,
        pluginRuntime: {
          bundleRootPath: bundleRoot,
          dataPath: '/data/build-ios-apps',
          expectedBundleHash: 'c'.repeat(64),
        },
      })
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true })
    }
  })

  it('rejects unsafe npx specs before managed runtime launch', async () => {
    const diagnostics: string[] = []
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'plugin#unsafe', wireName: 'unsafe',
        definition: { type: 'stdio', command: 'npx', args: ['--package', 'xcodebuildmcp', 'mcp'] },
        pluginRuntime: {
          rootPath: '/cache/unsafe', dataPath: '/data/unsafe', bundleHash: 'd'.repeat(64),
          profile: 'codex-plugin-env-v1',
        },
        pluginInstanceId: 'plugin://unsafe',
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
      pluginNodeRuntime: {
        command: process.execPath,
        executables: { bunx: { command: process.execPath } },
      },
      debug: message => diagnostics.push(message),
    })

    expect(out.mergedMcpServers).toEqual({})
    expect(diagnostics).toEqual([
      'Plugin MCP unsafe is unavailable; npx invocation uses unsupported runner arguments.',
    ])
  })

  it('does not select an ancestor node_modules package for npx', async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), 'nessy-plugin-npx-parent-'))
    const bundleRoot = join(parentRoot, 'plugins', 'bundle')
    const ancestorPackage = join(parentRoot, 'node_modules', 'xcodebuildmcp')
    const diagnostics: string[] = []
    try {
      mkdirSync(join(ancestorPackage, 'dist'), { recursive: true })
      mkdirSync(bundleRoot, { recursive: true })
      writeFileSync(join(ancestorPackage, 'package.json'), JSON.stringify({
        name: 'xcodebuildmcp',
        bin: 'dist/index.js',
      }))
      writeFileSync(join(ancestorPackage, 'dist', 'index.js'), 'throw new Error("must not run")')
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#xcodebuildmcp', wireName: 'xcodebuildmcp',
          definition: { type: 'stdio', command: 'npx', args: ['xcodebuildmcp@latest', 'mcp'] },
          pluginRuntime: {
            rootPath: bundleRoot, dataPath: '/data/build-ios-apps', bundleHash: 'e'.repeat(64),
            profile: 'codex-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://build-ios-apps',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
        workspaceId: 'ws-1',
        pluginNodeRuntime: {
          command: process.execPath,
          executables: { bunx: { command: process.execPath } },
        },
        debug: message => diagnostics.push(message),
      })

      expect(out.mergedMcpServers).toEqual({})
      expect(diagnostics).toEqual([
        'Plugin MCP xcodebuildmcp is unavailable; npx dependency is not materialized in the immutable bundle.',
      ])
    } finally {
      rmSync(parentRoot, { recursive: true, force: true })
    }
  })

  it('runs npx only through a bundle-local materialized package', async () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'nessy-plugin-npx-'))
    const dataRoot = mkdtempSync(join(tmpdir(), 'nessy-plugin-npx-data-'))
    const packageRoot = join(bundleRoot, 'node_modules', '@test', 'server')
    const executable = join(packageRoot, 'bin', 'server.mjs')
    const preloadMarker = join(bundleRoot, 'preload-ran')
    try {
      mkdirSync(join(packageRoot, 'bin'), { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@test/server',
        version: '1.2.3',
        bin: { server: 'bin/server.mjs' },
      }))
      writeFileSync(executable, 'console.log("MAIN")\n')
      writeFileSync(join(bundleRoot, 'preload.ts'), `await Bun.write(${JSON.stringify(preloadMarker)}, 'unsafe')\n`)
      writeFileSync(join(bundleRoot, 'bunfig.toml'), 'preload = ["./preload.ts"]\n')
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#server', wireName: 'server',
          definition: { type: 'stdio', command: 'npx', args: ['-y', '@test/server@1.2.3', '--stdio'] },
          pluginRuntime: {
            rootPath: bundleRoot, dataPath: dataRoot, bundleHash: '8'.repeat(64),
            profile: 'codex-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://server',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
        pluginNodeRuntime: {
          command: process.execPath,
          executables: {
            bunx: {
              command: process.execPath,
              args: ['--no-env-file', `--config=${NEUTRAL_BUN_CONFIG}`],
              environment: {
                HOME: '${NESSY_PLUGIN_DATA}/home',
                XDG_CONFIG_HOME: '${NESSY_PLUGIN_DATA}/config',
              },
            },
          },
        },
      })

      expect(out.mergedMcpServers.server).toMatchObject({
        command: process.execPath,
        args: ['--no-env-file', `--config=${NEUTRAL_BUN_CONFIG}`, realpathSync(executable), '--stdio'],
        env: {
          HOME: join(dataRoot, 'home'),
          XDG_CONFIG_HOME: join(dataRoot, 'config'),
        },
      })
      const server = out.mergedMcpServers.server
      if (!server || server.type !== 'stdio' || !server.command) throw new Error('stdio server unavailable')
      const executed = spawnSync(server.command, server.args ?? [], {
        cwd: server.cwd,
        env: server.env,
        encoding: 'utf8',
      })
      expect(executed.status).toBe(0)
      expect(executed.stdout).toBe('MAIN\n')
      expect(existsSync(preloadMarker)).toBe(false)
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true })
      rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  it('rejects a materialized npx package outside the declared semver range', async () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'nessy-plugin-npx-version-'))
    const packageRoot = join(bundleRoot, 'node_modules', '@test', 'server')
    const executable = join(packageRoot, 'bin', 'server.mjs')
    const diagnostics: string[] = []
    try {
      mkdirSync(join(packageRoot, 'bin'), { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@test/server',
        version: '1.2.3',
        bin: { server: 'bin/server.mjs' },
      }))
      writeFileSync(executable, 'throw new Error("must not run")')
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#server', wireName: 'server',
          definition: { type: 'stdio', command: 'npx', args: ['@test/server@^2.0.0', '--stdio'] },
          pluginRuntime: {
            rootPath: bundleRoot, dataPath: '/data/plugin', bundleHash: '9'.repeat(64),
            profile: 'codex-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://server',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
        workspaceId: 'ws-1',
        pluginNodeRuntime: { command: process.execPath },
        debug: message => diagnostics.push(message),
      })

      expect(out.mergedMcpServers).toEqual({})
      expect(diagnostics).toEqual([
        'Plugin MCP server is unavailable; npx dependency is not materialized in the immutable bundle.',
      ])
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true })
    }
  })

  it('runs bunx only through a bundle-local package and absolute Bun binding', async () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'nessy-plugin-bunx-'))
    const packageRoot = join(bundleRoot, 'node_modules', 'sample-bun-mcp')
    const executable = join(packageRoot, 'bin', 'server.ts')
    try {
      mkdirSync(join(packageRoot, 'bin'), { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: 'sample-bun-mcp', version: '1.0.0', bin: 'bin/server.ts',
      }))
      writeFileSync(executable, 'process.exit(0)')
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#bun-server', wireName: 'bun-server',
          definition: { type: 'stdio', command: 'bunx', args: ['sample-bun-mcp', '--stdio'] },
          pluginRuntime: {
            rootPath: bundleRoot, dataPath: '/data/plugin', bundleHash: '2'.repeat(64),
            profile: 'codex-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://bun-server',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
        pluginNodeRuntime: {
          command: process.execPath,
          executables: { bunx: { command: process.execPath } },
        },
      })

      expect(out.mergedMcpServers['bun-server']).toMatchObject({
        command: process.execPath,
        args: [realpathSync(executable), '--stdio'],
      })
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true })
    }
  })

  it('rejects a materialized npx binary that escapes its package through a symlink', async () => {
    if (process.platform === 'win32') return
    const bundleRoot = mkdtempSync(join(tmpdir(), 'nessy-plugin-npx-'))
    const externalRoot = mkdtempSync(join(tmpdir(), 'nessy-plugin-npx-external-'))
    const packageRoot = join(bundleRoot, 'node_modules', '@test', 'server')
    const externalExecutable = join(externalRoot, 'server.mjs')
    const diagnostics: string[] = []
    try {
      mkdirSync(join(packageRoot, 'bin'), { recursive: true })
      writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
        name: '@test/server',
        bin: 'bin/server.mjs',
      }))
      writeFileSync(externalExecutable, 'process.exit(0)')
      symlinkSync(externalExecutable, join(packageRoot, 'bin', 'server.mjs'))
      const runtime = runtimeWith({
        mcpServers: [{
          key: 'plugin#server', wireName: 'server',
          definition: { type: 'stdio', command: 'npx', args: ['@test/server'] },
          pluginRuntime: {
            rootPath: bundleRoot, dataPath: '/data/plugin', bundleHash: '7'.repeat(64),
            profile: 'codex-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://server',
        }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
      })

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
        pluginNodeRuntime: { command: process.execPath },
        debug: message => diagnostics.push(message),
      })

      expect(out.mergedMcpServers).toEqual({})
      expect(diagnostics).toEqual([
        'Plugin MCP server is unavailable; npx dependency is not materialized in the immutable bundle.',
      ])
    } finally {
      rmSync(bundleRoot, { recursive: true, force: true })
      rmSync(externalRoot, { recursive: true, force: true })
    }
  })

  it('does not rewrite native or project bare node commands', async () => {
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'native#mcp',
        wireName: 'native',
        definition: { type: 'stdio', command: 'node', args: ['server.js'] },
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
      workspaceId: 'ws-1',
    })
    expect(out.mergedMcpServers.native).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: {},
    })
  })
})

describe('mergePinnedMcpServers', () => {
  it('merges disjoint sets', () => {
    expect(mergePinnedMcpServers(
      { a: { type: 'http', url: 'u1' } },
      { b: { type: 'http', url: 'u2' } },
    )).toEqual({ a: { type: 'http', url: 'u1' }, b: { type: 'http', url: 'u2' } })
  })

  it('throws on a wire-name collision (fail-closed)', () => {
    expect(() => mergePinnedMcpServers(
      { a: { type: 'http', url: 'u1' } },
      { a: { type: 'http', url: 'u2' } },
    )).toThrow('capability-mcp-wire-name-collision:a')
  })
})

describe('plugin endpoint auth rides externalAuthRequirements (C3, capability path)', () => {
  const oauthServer = () => ({
    key: 'plugin#tracker',
    wireName: 'tracker',
    definition: { type: 'http', url: 'https://tracker.example.test/mcp' },
    endpointAuth: { authType: 'oauth', pluginKey: 'mk.tracker', serverName: 'tracker-mcp' },
    credential: { id: { type: 'plugin_mcp_oauth', pluginKey: 'mk.tracker', serverName: 'tracker-mcp' }, expectedRevision: 0 },
    pluginInstanceId: 'plugin://tracker',
  })

  it('skips an oauth server with an EMPTY slot and surfaces a needs-login entry with its plugin-slot target', async () => {
    const runtime = runtimeWith({
      mcpServers: [oauthServer()] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })
    const out = await materializeRuntimePoolServers(runtime, { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' })

    expect(out.mergedMcpServers).toEqual({})
    expect(out.externalAuthRequirements).toEqual([{
      provider: 'oauth',
      wireNames: ['tracker'],
      pluginInstanceIds: ['plugin://tracker'],
      state: 'needs-login',
      servers: [{ wireName: 'tracker', pluginKey: 'mk.tracker', serverName: 'tracker-mcp' }],
    }])
  })

  it('starts the server with Authorization once the slot holds a token, with no needs-login entry', async () => {
    const runtime = runtimeWith({
      mcpServers: [oauthServer()] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    }, fakeMaterializer({
      resolveCredential: () => ({ ready: true, revision: 1, value: 'slot-token' }),
    }))
    const out = await materializeRuntimePoolServers(runtime, { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' })

    expect(out.mergedMcpServers.tracker).toEqual({
      type: 'http',
      url: 'https://tracker.example.test/mcp',
      headers: { Authorization: 'Bearer slot-token' },
    })
    expect(out.externalAuthRequirements).toEqual([])
  })

  it('keeps the dp aggregation byte-identical beside an oauth entry (positive control)', async () => {
    const runtime = runtimeWith({
      mcpServers: [
        {
          key: 'plugin#dpGitlab',
          wireName: 'dpGitlab',
          definition: { type: 'stdio', command: 'dp', args: ['ai', 'mcp', 'gitlab'] },
          pluginRuntime: {
            rootPath: '/cache/plugin', dataPath: '/data/plugin', bundleHash: 'b'.repeat(64),
            profile: 'generic-plugin-env-v1',
          },
          pluginInstanceId: 'plugin://default',
        },
        oauthServer(),
      ] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })
    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1',
      pluginNodeRuntime: {
        command: process.execPath,
        executables: {
          dp: { command: process.execPath, environment: {}, externalAuthProvider: 'dp' },
        },
      },
      dpSessionState: 'needs-login',
    })

    // The dp entry keeps its exact shape and position; the oauth entry rides
    // beside it, never inside it.
    expect(out.externalAuthRequirements).toEqual([
      {
        provider: 'dp',
        wireNames: ['dpGitlab'],
        pluginInstanceIds: ['plugin://default'],
        state: 'needs-login',
      },
      {
        provider: 'oauth',
        wireNames: ['tracker'],
        pluginInstanceIds: ['plugin://tracker'],
        state: 'needs-login',
        servers: [{ wireName: 'tracker', pluginKey: 'mk.tracker', serverName: 'tracker-mcp' }],
      },
    ])
    expect(out.mergedMcpServers).toEqual({})
  })

  it('still throws when the SNAPSHOT is revoked, not just the slot (the floor holds)', async () => {
    const runtime = runtimeWith({
      mcpServers: [oauthServer()] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    }, fakeMaterializer({
      // A dead lease: `assertActive` is the correctness floor and an empty slot
      // must never be an excuse to skip past it.
      assertActive: () => { throw new CapabilityMaterializationError('revoked') },
    }))
    await expect(materializeRuntimePoolServers(runtime, { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' }))
      .rejects.toThrow('capability-snapshot-revoked')
  })

  it('never starts a remote server whose NON-endpoint-auth credential cannot resolve', async () => {
    // No `endpointAuth`: nothing downstream would refuse to start it, so a
    // credential that cannot resolve must never produce an unauthenticated
    // request. E1 changed HOW that is enforced — the server is dropped instead
    // of the whole batch — but the server still never reaches the pool.
    const diagnostics: string[] = []
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'native#remote',
        wireName: 'remote',
        definition: { type: 'http', url: 'https://remote.example.test/mcp' },
        credential: { id: { type: 'source', slug: 'remote' }, expectedRevision: 3 },
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })
    const out = await materializeRuntimePoolServers(runtime, {
      ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1', debug: message => diagnostics.push(message),
    })
    expect(out.mergedMcpServers).toEqual({})
    expect(diagnostics).toContain(
      'MCP server remote is unavailable; its capability snapshot reports credential-not-ready.',
    )
  })

  it('never gates a plain remote server (no endpointAuth) on a missing credential', async () => {
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'plugin#public',
        wireName: 'public',
        definition: { type: 'http', url: 'https://public.example.test/mcp' },
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })
    const out = await materializeRuntimePoolServers(runtime, { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' })
    expect(out.mergedMcpServers.public).toEqual({ type: 'http', url: 'https://public.example.test/mcp' })
    expect(out.externalAuthRequirements).toEqual([])
  })
})

/**
 * E1 — Claude's contract is that the unit of degradation is a TOOL, never the
 * turn. Materialization used to be all-or-nothing, so one plugin whose bundle
 * or credential could not materialize aborted the loop and unrelated, unchanged
 * servers died with it.
 */
describe('one failing server does not take the batch down (E1)', () => {
  const healthy = (wireName: string) => ({
    key: `native#${wireName}`,
    wireName,
    definition: { type: 'http', url: `https://${wireName}.example.test/mcp` },
  })
  const batch = () => [
    healthy('one'),
    {
      key: 'plugin#broken',
      wireName: 'broken',
      definition: { type: 'http', url: 'https://broken.example.test/mcp' },
      pluginInstanceId: 'plugin://broken',
    },
    healthy('two'),
    healthy('three'),
  ] as unknown as CapabilityTurnRuntime['view']['mcpServers']

  it.each(['credential-not-ready', 'stale', 'missing'] as const)(
    'keeps the three healthy servers and reports the one that fails with %s',
    async code => {
      const diagnostics: string[] = []
      const runtime = runtimeWith({ mcpServers: batch() }, fakeMaterializer({
        verifyPlugin: async () => { throw new CapabilityMaterializationError(code) },
      }))

      const out = await materializeRuntimePoolServers(runtime, {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1', debug: message => diagnostics.push(message),
      })

      expect(Object.keys(out.mergedMcpServers).sort()).toEqual(['one', 'three', 'two'])
      expect(diagnostics).toContain(
        `MCP server broken is unavailable; its capability snapshot reports ${code}.`,
      )
    },
  )

  it('still takes the whole batch down when the LEASE is revoked (the floor holds)', async () => {
    // A dead lease is a security verdict about the SNAPSHOT, not about one
    // server: nothing pinned to it may be materialized, so this one code is
    // exempt from per-server degradation.
    const runtime = runtimeWith({ mcpServers: batch() }, fakeMaterializer({
      verifyPlugin: async () => { throw new CapabilityMaterializationError('revoked') },
    }))
    await expect(materializeRuntimePoolServers(runtime, { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' }))
      .rejects.toThrow('capability-snapshot-revoked')
  })
})

/**
 * E4 — the raw `resolveCredential` sites re-resolve once.
 *
 * These arms drive the REAL materializer over a store-faithful credential
 * resolver rather than a hand-built one: modelling the credential path by hand
 * is exactly the infidelity that kept CI green through the E0 release blocker,
 * and the whole behaviour under test lives in that path.
 */
describe('a pin the credential store has moved past re-resolves once (E4)', () => {
  const e4Roots: string[] = []
  afterEach(() => {
    while (e4Roots.length) rmSync(e4Roots.pop()!, { recursive: true, force: true })
  })

  const E4_PLUGIN_INSTANCE = 'plugin://e4-env'
  const E4_PLUGIN_ROOT = '/cache/e4-plugin'
  const E4_PLUGIN_HASH = 'e'.repeat(64)

  /**
   * `secure-storage.ts:resolveRuntimeCredential`'s rules, nothing more.
   *
   * `expiresAt` rides the resolved record too, so the materializer's OWN expiry
   * check (`materializer.ts:219`) is live and not just the store's — the two are
   * separate gates and a re-resolve has to clear both.
   *
   * The lease is a MUTABLE flag rather than a captured boolean: the two lazy
   * getters below are invoked from the pool AFTER the turn that built them, and
   * "the lease died in between" is exactly the state they have to refuse.
   */
  function storeBacked(store: { revision: number; expiresAt?: number }, leaseActive = true) {
    const seen: number[] = []
    const lease = { active: leaseActive }
    const resolver = {
      resolve: async () => { throw new Error('unused') },
      releaseSnapshot() {},
      invalidate() {},
      isLeaseActive: () => lease.active,
      referencedInstances: () => new Set<string>(),
      leaseCount: () => 1,
    } as unknown as CapabilityResolver
    const snapshot = {
      context: { workspaceId: 'ws-1', sessionId: 's-1', projectTrustState: 'none', projectTrustRevision: '' },
      generation: 'g',
      leaseId: 'lease-1',
      entries: [],
      installedPlugins: [
        { activeInstanceId: E4_PLUGIN_INSTANCE, bundleHash: E4_PLUGIN_HASH, bundleRootPath: E4_PLUGIN_ROOT },
      ],
      diagnostics: [],
    } as unknown as EffectiveCapabilitySnapshot
    const materializer = createCapabilitySnapshotMaterializer(resolver, snapshot, {
      computeBundleHash: async () => E4_PLUGIN_HASH,
      resolveCredential: binding => {
        seen.push(binding.expectedRevision)
        if (binding.expectedRevision !== store.revision) return { ready: false, revision: store.revision }
        if (store.expiresAt !== undefined && store.expiresAt <= Date.now()) {
          return { ready: false, revision: store.revision }
        }
        return {
          value: 'live-secret',
          ready: true,
          revision: store.revision,
          credential: {
            value: 'live-secret',
            ...(store.expiresAt !== undefined ? { expiresAt: store.expiresAt } : {}),
          },
        }
      },
    })
    return { materializer, seen, lease }
  }

  /** A pinned native resource the real materializer will accept. */
  function pinnedSourceResource(document: string): NativeResourceRef {
    const root = mkdtempSync(join(tmpdir(), 'e4-source-'))
    e4Roots.push(root)
    const path = join(root, 'config.json')
    writeFileSync(path, document)
    return {
      source: 'workspace',
      scope: { kind: 'workspace', workspaceId: 'ws-1' },
      resourceId: 'source:workspace:api',
      absolutePath: path,
      revision: String(statSync(path).mtimeMs),
      contentHash: createHash('sha256').update(document).digest('hex'),
    }
  }

  function apiSourceRuntime(
    api: Record<string, unknown>,
    materializer: CapabilitySnapshotMaterializer,
  ): CapabilityTurnRuntime {
    const document = JSON.stringify({
      id: 'api-1', name: 'API', slug: 'api', enabled: true, provider: 'custom', type: 'api',
      isAuthenticated: true,
      api,
    })
    return runtimeWith({
      sources: [{
        key: 'source:api',
        logicalName: 'api',
        resource: pinnedSourceResource(document),
        credential: { id: { type: 'source', slug: 'api' }, expectedRevision: 1 },
      }] as unknown as CapabilityTurnRuntime['view']['sources'],
    }, materializer)
  }

  /**
   * Invoke the tool the POOL holds, over the SDK server's own transport, with
   * only `fetch` stubbed. The credential getter exercised here is the closure
   * `materializeRuntimeSources` handed the builder — the test re-builds nothing,
   * so removing the guard from that closure is what turns this red.
   */
  async function callPooledApiTool(apiServer: unknown): Promise<{
    authorization: string | undefined
    text: string
    isError: boolean
  }> {
    const authorizations: (string | undefined)[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      authorizations.push((init.headers as Record<string, string> | undefined)?.Authorization)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const instance = (apiServer as { instance: { connect: (transport: unknown) => Promise<void>; close: () => Promise<void> } }).instance
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'e4-pool', version: '1.0.0' })
    try {
      await instance.connect(serverTransport)
      await client.connect(clientTransport)
      const result = await client.callTool({
        name: 'api_api',
        arguments: { path: '/ping', method: 'GET', _intent: 'e4' },
      }) as { isError?: boolean; content: { text: string }[] }
      return {
        authorization: authorizations[0],
        text: result.content.map(part => part.text).join(''),
        isError: result.isError === true,
      }
    } finally {
      await client.close().catch(() => {})
      await instance.close().catch(() => {})
      globalThis.fetch = originalFetch
    }
  }

  const remoteServer = () => [{
    key: 'native#remote',
    wireName: 'remote',
    definition: { type: 'http', url: 'https://remote.example.test/mcp' },
    credential: { id: { type: 'source', slug: 'remote' }, expectedRevision: 1 },
  }] as unknown as CapabilityTurnRuntime['view']['mcpServers']

  it('starts a remote server whose credential ROTATED under the pinned revision', async () => {
    const { materializer, seen } = storeBacked({ revision: 2 })
    const out = await materializeRuntimePoolServers(
      runtimeWith({ mcpServers: remoteServer() }, materializer),
      { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' },
    )

    expect(out.mergedMcpServers.remote).toEqual({
      type: 'http',
      url: 'https://remote.example.test/mcp',
      headers: { Authorization: 'Bearer live-secret' },
    })
    // The pinned revision first, then the one the store named: exactly once.
    expect(seen).toEqual([1, 2])
  })

  it('does not re-resolve a credential that is EXPIRED at the revision it is pinned to', async () => {
    // Nothing rotated, so a second read returns the same expired record. The
    // credential stays unusable and the server stays out of the pool; only the
    // pointless read is skipped.
    const diagnostics: string[] = []
    const { materializer, seen } = storeBacked({ revision: 1, expiresAt: Date.now() - 1 })
    const out = await materializeRuntimePoolServers(
      runtimeWith({ mcpServers: remoteServer() }, materializer),
      { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1', debug: message => diagnostics.push(message) },
    )

    expect(out.mergedMcpServers).toEqual({})
    expect(seen).toEqual([1])
    expect(diagnostics).toContain(
      'MCP server remote is unavailable; its capability snapshot reports credential-not-ready.',
    )
  })

  it('never re-resolves against a DEAD lease (the floor holds)', async () => {
    const { materializer, seen } = storeBacked({ revision: 2 }, false)
    await expect(materializeRuntimePoolServers(
      runtimeWith({ mcpServers: remoteServer() }, materializer),
      { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' },
    )).rejects.toThrow('capability-snapshot-revoked')
    expect(seen).toEqual([])
  })

  it('resolves a SOURCE whose credential rotated, instead of failing the whole batch', async () => {
    const { materializer, seen } = storeBacked({ revision: 2 })

    const out = await materializeRuntimePoolServers(
      apiSourceRuntime({ baseUrl: 'https://api.example.test/', authType: 'bearer' }, materializer),
      { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' },
    )

    expect(Object.keys(out.apiServers)).toEqual(['api'])
    expect(seen.slice(0, 2)).toEqual([1, 2])
  })

  // --- the three sites the first E4 pass left without an arm -----------------
  //
  // `:166` (the eager read above) and `:387` (the remote server) were covered;
  // the two lazy getters the pool keeps and the plugin credential ENVIRONMENT
  // were not, and removing the guard from any of them left the suite green.

  /**
   * Site: `materializePluginMcpCredentialEnvironment`. The only one of the five
   * whose value reaches a SUBPROCESS environment rather than an HTTP header.
   */
  const pluginCredentialEnvServer = () => [{
    key: 'plugin#env',
    wireName: 'plugin-env',
    definition: { type: 'stdio', command: 'node', args: ['server.js'] },
    credentialEnvironment: {
      PLUGIN_TOKEN: {
        configKey: 'token',
        credential: {
          id: { type: 'plugin_mcp_env', pluginKey: 'mk.env', serverName: 'env-mcp' },
          expectedRevision: 1,
        },
      },
    },
    pluginRuntime: {
      rootPath: E4_PLUGIN_ROOT,
      dataPath: '/data/plugin',
      bundleHash: E4_PLUGIN_HASH,
      profile: 'generic-plugin-env-v1',
    },
    pluginInstanceId: E4_PLUGIN_INSTANCE,
  }] as unknown as CapabilityTurnRuntime['view']['mcpServers']

  it('spawns a plugin whose credential-ENVIRONMENT secret rotated under the pinned revision', async () => {
    // Rotated AND refreshed: the replacement carries a future `expiresAt`, so
    // the re-resolve has to clear the store's revision gate and the
    // materializer's own expiry gate before the subprocess sees the value.
    const { materializer, seen } = storeBacked({ revision: 2, expiresAt: Date.now() + 3_600_000 })

    const out = await materializeRuntimePoolServers(
      runtimeWith({ mcpServers: pluginCredentialEnvServer() }, materializer),
      {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
        workspaceId: 'ws-1',
        pluginNodeRuntime: { command: process.execPath },
      },
    )

    expect(out.mergedMcpServers['plugin-env']).toMatchObject({
      command: process.execPath,
      env: expect.objectContaining({ PLUGIN_TOKEN: 'live-secret' }),
    })
    expect(seen).toEqual([1, 2])
  })

  it('still withholds the plugin when the record AT THE NEW revision is itself expired', async () => {
    // The floor, at the same site: one re-resolve is allowed, a usable-looking
    // answer is not invented. The second read lands on an expired record and the
    // server stays out of the pool.
    const diagnostics: string[] = []
    const { materializer, seen } = storeBacked({ revision: 2, expiresAt: Date.now() - 1 })

    const out = await materializeRuntimePoolServers(
      runtimeWith({ mcpServers: pluginCredentialEnvServer() }, materializer),
      {
        ...NO_BUILTIN_DP, workspaceRootPath: '/ws',
        workspaceId: 'ws-1',
        pluginNodeRuntime: { command: process.execPath },
        debug: message => diagnostics.push(message),
      },
    )

    expect(out.mergedMcpServers).toEqual({})
    expect(seen).toEqual([1, 2])
    expect(diagnostics).toContain(
      'MCP server plugin-env is unavailable; its capability snapshot reports credential-not-ready.',
    )
  })

  /**
   * Site: the OAuth/renew TOKEN getter. `buildApiServer` routes an `oauth`
   * source through `getTokenForSource`, so this arm reaches that closure and no
   * other credential site.
   */
  it('serves a pooled OAuth API call from the rotated credential, one turn later', async () => {
    const { materializer, seen } = storeBacked({ revision: 2, expiresAt: Date.now() + 3_600_000 })
    const out = await materializeRuntimePoolServers(
      apiSourceRuntime({ baseUrl: 'https://api.example.test/', authType: 'oauth' }, materializer),
      { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' },
    )
    expect(seen).toEqual([1, 2])

    const call = await callPooledApiTool(out.apiServers.api)

    expect(call.isError).toBe(false)
    expect(call.authorization).toBe('Bearer live-secret')
    // One more pinned-then-current pair: the getter re-resolves once per call,
    // never twice, and never gives up on the stale pin.
    expect(seen).toEqual([1, 2, 1, 2])
  })

  it('refuses a pooled OAuth API call once the LEASE dies (the floor holds after the turn)', async () => {
    const { materializer, lease } = storeBacked({ revision: 2, expiresAt: Date.now() + 3_600_000 })
    const out = await materializeRuntimePoolServers(
      apiSourceRuntime({ baseUrl: 'https://api.example.test/', authType: 'oauth' }, materializer),
      { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' },
    )
    lease.active = false

    const call = await callPooledApiTool(out.apiServers.api)

    expect(call.isError).toBe(true)
    expect(call.text).toContain('capability-snapshot-revoked')
    expect(call.authorization).toBeUndefined()
  })

  /**
   * Site: the per-request CREDENTIAL getter (`resolveBoundCredential`). A
   * `bearer` source with no renew endpoint takes this closure and not the token
   * getter above, so the two sites stay separable under mutation.
   */
  it('serves a pooled bearer API call from the rotated credential, one turn later', async () => {
    const { materializer, seen } = storeBacked({ revision: 2, expiresAt: Date.now() + 3_600_000 })
    const out = await materializeRuntimePoolServers(
      apiSourceRuntime({ baseUrl: 'https://api.example.test/', authType: 'bearer' }, materializer),
      { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' },
    )
    expect(seen).toEqual([1, 2])

    const call = await callPooledApiTool(out.apiServers.api)

    expect(call.isError).toBe(false)
    expect(call.authorization).toBe('Bearer live-secret')
    expect(seen).toEqual([1, 2, 1, 2])
  })

  it('refuses a pooled bearer API call once the LEASE dies (the floor holds after the turn)', async () => {
    const { materializer, lease } = storeBacked({ revision: 2, expiresAt: Date.now() + 3_600_000 })
    const out = await materializeRuntimePoolServers(
      apiSourceRuntime({ baseUrl: 'https://api.example.test/', authType: 'bearer' }, materializer),
      { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' },
    )
    lease.active = false

    const call = await callPooledApiTool(out.apiServers.api)

    expect(call.isError).toBe(true)
    expect(call.text).toContain('capability-snapshot-revoked')
    expect(call.authorization).toBeUndefined()
  })
})

describe('plugin slot read-through at materialization (C4)', () => {
  const slotSpies: Array<{ mockRestore: () => void }> = []
  let slotRows: Map<string, StoredCredential>

  beforeEach(() => {
    slotRows = new Map()
    resetPluginMcpTokenRefreshForTests()
    const account = (id: CredentialId) => credentialIdToAccount(id)
    const fake = {
      get: async (id: CredentialId) => structuredClone(slotRows.get(account(id)) ?? null),
      set: async (id: CredentialId, credential: StoredCredential) => {
        slotRows.set(account(id), structuredClone(credential))
      },
      delete: async (id: CredentialId) => slotRows.delete(account(id)),
      deleteSync: (id: CredentialId) => slotRows.delete(account(id)),
      getRuntimeCredentialStatus: () => ({ state: 'ready', revision: 0 }),
    } as never
    slotSpies.push(spyOn(credentialsManagerModule, 'getCredentialManager').mockReturnValue(fake))
    slotSpies.push(spyOn(credentialsIndexModule, 'getCredentialManager').mockReturnValue(fake))
  })

  afterEach(() => {
    while (slotSpies.length) slotSpies.pop()!.mockRestore()
    resetPluginMcpTokenRefreshForTests()
  })

  it('injects the CURRENT slot token even when the snapshot binding is stale (revision-proof)', async () => {
    slotRows.set('plugin_mcp_oauth::mk.tracker::tracker-mcp', {
      value: 'current-slot-token',
      expiresAt: Date.now() + 3600_000,
    })
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'plugin#tracker',
        wireName: 'tracker',
        definition: { type: 'http', url: 'https://tracker.example.test/mcp' },
        endpointAuth: { authType: 'oauth', pluginKey: 'mk.tracker', serverName: 'tracker-mcp' },
        // The binding resolves NOT-ready (stale revision) — the slot wins.
        credential: { id: { type: 'plugin_mcp_oauth', pluginKey: 'mk.tracker', serverName: 'tracker-mcp' }, expectedRevision: 99 },
        pluginInstanceId: 'plugin://tracker',
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const out = await materializeRuntimePoolServers(runtime, { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' })

    expect(out.mergedMcpServers.tracker).toEqual({
      type: 'http',
      url: 'https://tracker.example.test/mcp',
      headers: { Authorization: 'Bearer current-slot-token' },
    })
    expect(out.externalAuthRequirements).toEqual([])
  })
})

/**
 * A7 — the built-in dp set reaches the pool.
 *
 * Every arm here drives `materializeRuntimePoolServers`, never
 * `mergeBuiltinDpMcpServers` directly: the merge helper had its own green suite
 * for a whole wave while no user's server list changed, and a helper-level
 * assertion cannot tell those two states apart.
 *
 * `resolveDpPath` is injected wherever the assertion depends on dp existing, so
 * nothing here needs the host to have `dp` and nothing here executes it.
 *
 * Every built-in is off by default (owner decision 2026-08-01), so an arm that
 * needs one PRESENT switches it on by name through `enabled`. Reading a default
 * would be reading a decision this suite is supposed to be able to change.
 *
 * Since owner decision 2026-08-06 this block also covers the dp SESSION gate:
 * a surviving built-in wire name is withheld from `mergedMcpServers` only on a
 * positive `needs-login` verdict — never on `unavailable`, which the non-Pi
 * session preflight hardcodes and a transient probe failure also reports — and
 * the `dp` requirement is emitted in EVERY state so the registry's probe loop
 * still runs. This is deliberately a LOOSER threshold than the plugin dp gate
 * (`!== 'ready'`, pinned above in `'gates only trusted DP-bound servers …'`):
 * a built-in carries no credential of its own, so there is nothing to protect
 * by withholding it outside the one state that means "the user must sign in".
 */
describe('the built-in dp set reaches the pool (A7)', () => {
  const DP = '/usr/local/bin/dp'
  const dpPresent = () => DP
  const dpMissing = () => null
  const poolOptions = (extra: Record<string, unknown> = {}) => ({
    workspaceRootPath: '/ws',
    workspaceId: 'ws-1',
    ...extra,
  })

  it('puts an enabled built-in in the materialized list and leaves a disabled one out', async () => {
    const runtime = runtimeWith({})

    const out = await materializeRuntimePoolServers(runtime, poolOptions({
      builtinDpMcpServers: {
        resolveDpPath: dpPresent,
        enabled: { dpJira: true, dpSage: false, dpMail: true },
        runtimeEnv: {},
      },
    }))

    // Switched on, and it is the WHOLE command that has to survive the fold — a
    // wire name in the map with the wrong argv is a server that starts and
    // answers nothing.
    expect(out.mergedMcpServers.dpJira).toEqual({ type: 'stdio', command: DP, args: ['ai', 'mcp', 'jira'] })
    // Switched off by the user, on top of a definition that is off by default:
    // absent from the list the pool connects.
    expect(out.mergedMcpServers.dpSage).toBeUndefined()
    expect(out.mergedMcpServers.dpMail).toEqual({ type: 'stdio', command: DP, args: ['ai', 'mcp', 'mail'] })
    // Exactly the two asked for reach the pool, out of twenty-eight embedded —
    // and dpJira being here is the positive control for dpSage's absence, so
    // "dpSage is missing" is the switch and not a fold that never ran.
    expect(Object.keys(out.mergedMcpServers).sort()).toEqual(['dpJira', 'dpMail'])
  })

  it('folds by default and still hands the pool nothing until the user opts in', async () => {
    const runtime = runtimeWith({})

    // THE property the rest of the repository leans on. Thirteen exact-map
    // assertions in four other files are green because a default materialization
    // contributes an EMPTY built-in set, not because the fold is withheld —
    // owner decision 2026-08-01: embed the whole `dp ai mcp` set, every entry
    // off, the user decides what to switch on.
    //
    // Driven through `materializeRuntimePoolServers`, the function the product
    // calls, and never through `materializeBuiltinDpMcpServers`: the helper
    // being empty says nothing about what the pool is handed, and a helper-level
    // assertion is exactly what stayed green for a whole wave while the fold
    // injected six names into every workspace.
    const noOption = await materializeRuntimePoolServers(runtime, poolOptions())
    expect(noOption.mergedMcpServers).toEqual({})

    // The same statement made host-INDEPENDENT. The line above runs the real
    // `resolveDpBinary` (a filesystem scan, never an exec), so on a machine
    // without dp it would hold even if a definition were default-on; with dp
    // stipulated present this one is red on CI too the moment any
    // `defaultEnabled` flips to true. That asymmetry is the whole reason the
    // earlier default-ON shipped looking green.
    const dpInstalled = await materializeRuntimePoolServers(
      runtime,
      poolOptions({ builtinDpMcpServers: { resolveDpPath: dpPresent } }),
    )
    expect(dpInstalled.mergedMcpServers).toEqual({})

    // `false` withholds the fold entirely — a different mechanism reaching the
    // same visible result, and the one every arm above this describe uses.
    const withheld = await materializeRuntimePoolServers(runtime, poolOptions({ builtinDpMcpServers: false }))
    expect(withheld.mergedMcpServers).toEqual({})

    // Positive control on the same rig: opting one server in DOES reach the
    // pool, so the three empties above are the defaults and not a fold that can
    // never produce anything.
    const optedIn = await materializeRuntimePoolServers(
      runtime,
      poolOptions({ builtinDpMcpServers: { resolveDpPath: dpPresent, enabled: { dpJira: true } } }),
    )
    expect(Object.keys(optedIn.mergedMcpServers)).toEqual(['dpJira'])
  })

  it('never displaces a server the user configured under the same wire name', async () => {
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'native#dpJira',
        wireName: 'dpJira',
        definition: { type: 'stdio', command: '/opt/mine/jira', args: ['--serve'] },
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })
    const diagnostics: string[] = []

    const out = await materializeRuntimePoolServers(runtime, poolOptions({
      // Both specimens are switched on by name: with every built-in off by
      // default the folded map would be empty, and an empty fold cannot collide
      // with anything.
      builtinDpMcpServers: { resolveDpPath: dpPresent, enabled: { dpJira: true, dpGitlab: true }, runtimeEnv: {} },
      debug: (message: string) => diagnostics.push(message),
    }))

    // This is the ARGUMENT-ORDER pin. `mergeBuiltinDpMcpServers` yields to
    // whichever map is passed FIRST, so swapping the configured map and the
    // built-in map silently inverts precedence: the user's own dpJira would be
    // replaced by an unasked-for one, and every other assertion in this file
    // would still be green.
    expect(out.mergedMcpServers.dpJira).toEqual({ type: 'stdio', command: '/opt/mine/jira', args: ['--serve'], env: {} })
    // The other server the user switched on still arrives — yielding one name is
    // not standing the set down.
    expect(out.mergedMcpServers.dpGitlab).toEqual({ type: 'stdio', command: DP, args: ['ai', 'mcp', 'gitlab'] })
    expect(diagnostics.some(message => message.startsWith('builtin_dp_mcp.wire_name_taken:'))).toBe(true)
  })

  it('stands down when an installed extension already runs the same dp subcommand', async () => {
    const runtime = runtimeWith({
      // The `nessy-default-extension` shape: a different wire name, the same
      // `dp ai mcp jira` behind it.
      mcpServers: [{
        key: 'native#jira',
        wireName: 'jira',
        definition: { type: 'stdio', command: 'dp', args: ['ai', 'mcp', 'jira'] },
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })
    const diagnostics: string[] = []

    const out = await materializeRuntimePoolServers(runtime, poolOptions({
      // Switched on by name, as above: the stand-down rule is unreachable while
      // the built-in map is empty.
      builtinDpMcpServers: { resolveDpPath: dpPresent, enabled: { dpJira: true, dpGitlab: true }, runtimeEnv: {} },
      debug: (message: string) => diagnostics.push(message),
    }))

    expect(out.mergedMcpServers.jira).toEqual({ type: 'stdio', command: 'dp', args: ['ai', 'mcp', 'jira'], env: {} })
    expect(out.mergedMcpServers.dpJira).toBeUndefined()
    // Positive control: only the duplicated subcommand stands down.
    expect(out.mergedMcpServers.dpGitlab).toEqual({ type: 'stdio', command: DP, args: ['ai', 'mcp', 'gitlab'] })
    expect(diagnostics.some(message => message.startsWith('builtin_dp_mcp.subcommand_taken:'))).toBe(true)
  })

  it('degrades to a named diagnostic when dp is not installed', async () => {
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'native#native',
        wireName: 'native',
        definition: { type: 'stdio', command: 'node', args: ['server.js'] },
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })
    const diagnostics: string[] = []

    const out = await materializeRuntimePoolServers(runtime, poolOptions({
      // A server the user DID switch on, so the arm proves a missing dp costs an
      // opted-in built-in. Without the preference the fold would produce nothing
      // either way and the assertion would hold for the wrong reason.
      builtinDpMcpServers: { resolveDpPath: dpMissing, enabled: { dpJira: true } },
      debug: (message: string) => diagnostics.push(message),
    }))

    // The configured server is untouched: a missing dp costs the built-in set
    // and nothing else. No throw, and no exec — `resolveDpPath` is the only
    // thing consulted.
    expect(Object.keys(out.mergedMcpServers)).toEqual(['native'])
    expect(out.mergedMcpServers.dpJira).toBeUndefined()
    expect(diagnostics.some(message => message.startsWith('builtin_dp_mcp.dp_not_found:'))).toBe(true)
  })

  /**
   * The dp session gate (owner decision 2026-08-06): a BUILT-IN carries no
   * credential of its own — dp authenticates itself — so it is withheld only
   * on a POSITIVE `needs-login` verdict, never on `unavailable` (the non-Pi
   * session preflight hardcodes that value, and a transient probe hiccup
   * reports it too; neither may evict an already-working server). The plugin
   * dp gate above this describe (`'gates only trusted DP-bound servers …'`)
   * proves the STRICTER `!== 'ready'` rule for plugin-bound servers, which
   * carry real credential material; this is the SEPARATE, looser rule for
   * builtins, and the two must never be conflated into one threshold.
   */
  it('enabled builtin + needs-login: withheld from the map, present in a dp requirement', async () => {
    const runtime = runtimeWith({})
    const result = await materializeRuntimePoolServers(runtime, poolOptions({
      dpSessionState: 'needs-login',
      builtinDpMcpServers: { resolveDpPath: dpPresent, enabled: { dpGitlab: true }, runtimeEnv: {} },
    }))
    expect(result.mergedMcpServers['dpGitlab']).toBeUndefined()
    const dp = result.externalAuthRequirements.find(r => r.provider === 'dp')
    expect(dp).toEqual({
      provider: 'dp',
      wireNames: ['dpGitlab'],
      pluginInstanceIds: [],
      state: 'needs-login',
      builtinWireNames: ['dpGitlab'],
    })
  })

  it('enabled builtin + ready: present in the map, requirement state ready', async () => {
    const runtime = runtimeWith({})
    const result = await materializeRuntimePoolServers(runtime, poolOptions({
      dpSessionState: 'ready',
      builtinDpMcpServers: { resolveDpPath: dpPresent, enabled: { dpGitlab: true }, runtimeEnv: {} },
    }))
    expect(result.mergedMcpServers['dpGitlab']).toBeDefined()
    expect(result.externalAuthRequirements.find(r => r.provider === 'dp')?.state).toBe('ready')
  })

  it('enabled builtin + unavailable: NOT withheld (non-Pi preflight and probe hiccups must not evict)', async () => {
    const runtime = runtimeWith({})
    const result = await materializeRuntimePoolServers(runtime, poolOptions({
      dpSessionState: 'unavailable',
      builtinDpMcpServers: { resolveDpPath: dpPresent, enabled: { dpGitlab: true }, runtimeEnv: {} },
    }))
    expect(result.mergedMcpServers['dpGitlab']).toBeDefined()
  })

  it('dp missing or nothing enabled: no dp requirement (registry fast path pinned)', async () => {
    const runtime = runtimeWith({})
    const missing = await materializeRuntimePoolServers(runtime, poolOptions({
      builtinDpMcpServers: { resolveDpPath: dpMissing, enabled: { dpGitlab: true }, runtimeEnv: {} },
    }))
    expect(missing.externalAuthRequirements).toEqual([])
    const disabled = await materializeRuntimePoolServers(runtime, poolOptions({
      builtinDpMcpServers: { resolveDpPath: dpPresent, enabled: {}, runtimeEnv: {} },
    }))
    expect(disabled.externalAuthRequirements).toEqual([])
  })

  /**
   * The MERGE branch (`dpIndex >= 0` in `materializeRuntimePoolServers`): a
   * snapshot-provided PLUGIN dp requirement already exists when the builtin
   * fold survives, so the two must combine into ONE requirement instead of
   * the builtin clobbering or duplicating the plugin's entry. This was the
   * review's named untested branch — every arm above this one only ever hits
   * the EMIT branch (`dpIndex < 0`, no snapshot dp requirement yet).
   */
  it('merges a surviving builtin into an existing plugin-sourced dp requirement (dpIndex >= 0)', async () => {
    const runtime = runtimeWith({
      mcpServers: [{
        key: 'plugin#dpJira',
        wireName: 'dpJira',
        definition: { type: 'stdio', command: 'dp', args: ['ai', 'mcp', 'dpJira'] },
        pluginRuntime: {
          rootPath: '/cache/plugin',
          dataPath: '/data/plugin',
          bundleHash: '1'.repeat(64),
          profile: 'generic-plugin-env-v1',
        },
        pluginInstanceId: 'plugin://default',
      }] as unknown as CapabilityTurnRuntime['view']['mcpServers'],
    })

    const result = await materializeRuntimePoolServers(runtime, poolOptions({
      dpSessionState: 'needs-login',
      pluginNodeRuntime: {
        command: process.execPath,
        executables: {
          dp: {
            command: process.execPath,
            environment: { DP_AI_MCP_SKIP_LOGIN: 'true' },
            externalAuthProvider: 'dp',
          },
        },
      },
      // Enabled by name, on top of the plugin-bound dpJira above: the fold
      // survives (different wire name) so it hits the MERGE branch, not emit.
      builtinDpMcpServers: { resolveDpPath: dpPresent, enabled: { dpGitlab: true }, runtimeEnv: {} },
    }))

    // Both withheld under needs-login: the plugin entry via the snapshot loop
    // (`dpSessionState !== 'ready'`), the builtin via the two-tier gate.
    expect(result.mergedMcpServers.dpJira).toBeUndefined()
    expect(result.mergedMcpServers.dpGitlab).toBeUndefined()

    const dp = result.externalAuthRequirements.find(r => r.provider === 'dp')
    expect(dp).toEqual({
      provider: 'dp',
      wireNames: ['dpGitlab', 'dpJira'],
      pluginInstanceIds: ['plugin://default'],
      state: 'needs-login',
      builtinWireNames: ['dpGitlab'],
    })
  })
})
