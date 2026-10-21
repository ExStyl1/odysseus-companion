/**
 * DA2.2 half A — the pool really withholds non-whitelisted MCP servers from an
 * external model target (owner decision DA2.14, 2026-09-17).
 *
 * `agent/backend/internal/drivers/external-model-mcp-whitelist.test.ts` pins the
 * POLICY (the seed, and which verdicts withhold). This suite pins the two things
 * that file cannot see:
 *
 * 1. `materializeRuntimePoolServers` — the single materialization authority both
 *    pools share — applies it to the maps that reach `pool.sync`, BOTH of them
 *    (the merged MCP map and the api-transport map), and leaves them untouched
 *    for an unrestricted target or for no verdict at all;
 * 2. a REAL `BaseAgent.setSourceServers` carries the verdict off
 *    `BackendConfig.modelTarget` into that call, so the session path is wired
 *    and not just the function. That arm is the one that answers "does this
 *    reach pi, claude and codex": all three reach the pool through this one
 *    method — `PiAgent` overrides it and delegates with `super`, and the claude
 *    and codex agents do not override it at all (`git grep -an setSourceServers`
 *    over `packages/**` names `base-agent.ts` and `pi-agent.ts` and no other
 *    source file, 2026-09-17) — so one arm covers the three.
 *
 * Every verdict comes from the real `classifyModelTarget`; none is a literal.
 * Nothing here connects anything: the end-to-end arm's pool RECORDS what it was
 * handed instead of delegating, which is exactly the contract under test — what
 * the session asks the pool to run.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpClientPool } from '../mcp-pool.ts'
import { materializeRuntimePoolServers } from '../runtime-pool-servers.ts'
import {
  classifyModelTarget,
  NESSY_GATEWAY_CHAT_BASE_URL,
  type ModelTargetVerdict,
} from '../../agent/backend/internal/drivers/upstream-target.ts'
import { CapabilityMaterializationError, type CapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts'
import type { NativeResourceRef } from '../../capabilities/resolver.ts'
import type { CapabilityTurnRuntime, SdkMcpServerConfig } from '../../agent/backend/types.ts'
import { TestAgent, createMockBackendConfig } from '../../agent/__tests__/test-utils.ts'

/** The built-in dp fold is irrelevant here and host-dependent; opt out by name. */
const NO_BUILTIN_DP = { builtinDpMcpServers: false } as const
const BASE = { ...NO_BUILTIN_DP, workspaceRootPath: '/ws', workspaceId: 'ws-1' } as const

const EXTERNAL = classifyModelTarget({ baseUrl: 'https://api.vendor.example/v1', model: 'anthropic/claude-x' })
const GATEWAY = classifyModelTarget({ baseUrl: NESSY_GATEWAY_CHAT_BASE_URL, model: 'tgpt/deepseek' })

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

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
function runtimeWith(
  view: Partial<CapabilityTurnRuntime['view']>,
  materializer = fakeMaterializer(),
): CapabilityTurnRuntime {
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

/**
 * One whitelisted server and one that is not, as PINNED snapshot MCP servers.
 * `dpJira` is on the list; `dpFs` is a shipped built-in that is NOT, which makes
 * the pair a policy test rather than a "known name vs nonsense" test.
 */
function twoServers(): CapabilityTurnRuntime['view']['mcpServers'] {
  return [
    { key: 'k1', wireName: 'dpJira', definition: { type: 'http', url: 'https://mcp.test/jira' } },
    { key: 'k2', wireName: 'dpFs', definition: { type: 'http', url: 'https://mcp.test/fs' } },
  ] as unknown as CapabilityTurnRuntime['view']['mcpServers']
}

/** A pinned `config.json` for an api-transport source, on disk. */
function apiSourceRuntime(slug: string): CapabilityTurnRuntime {
  const root = mkdtempSync(join(tmpdir(), 'da22-api-'))
  roots.push(root)
  const path = join(root, 'config.json')
  const document = JSON.stringify({
    id: slug, name: slug, slug, enabled: true, provider: 'custom', type: 'api',
    isAuthenticated: true,
    api: { baseUrl: `https://api.example.test/${slug}`, authType: 'none' },
  })
  writeFileSync(path, document)
  const resource: NativeResourceRef = {
    source: 'workspace',
    scope: { kind: 'workspace', workspaceId: 'ws-1' },
    resourceId: `source:workspace:${slug}`,
    absolutePath: path,
    revision: String(statSync(path).mtimeMs),
    contentHash: createHash('sha256').update(document).digest('hex'),
  }
  return runtimeWith({
    sources: [{ key: `source:${slug}`, logicalName: slug, resource }] as unknown as CapabilityTurnRuntime['view']['sources'],
    mcpServers: twoServers(),
  }, fakeMaterializer({ readText: async () => document }))
}

describe('materializeRuntimePoolServers · the external-model withholding', () => {
  it('withholds a non-whitelisted server from an external vendor and keeps the whitelisted one', async () => {
    const diagnostics: string[] = []
    const out = await materializeRuntimePoolServers(runtimeWith({ mcpServers: twoServers() }), {
      ...BASE,
      modelTarget: EXTERNAL,
      debug: message => diagnostics.push(message),
    })

    expect(Object.keys(out.mergedMcpServers)).toEqual(['dpJira'])
    // The operator's channel: named, not silent. Same posture as the managed
    // denylist's own `builtin_dp_mcp.managed_policy_denied` line.
    expect(diagnostics).toContain('external_model_mcp.withheld:external-vendor: dpFs')
  })

  it('withholds NOTHING from the verified gateway — same two servers, same call', async () => {
    const out = await materializeRuntimePoolServers(runtimeWith({ mcpServers: twoServers() }), {
      ...BASE,
      modelTarget: GATEWAY,
    })
    expect(Object.keys(out.mergedMcpServers).sort()).toEqual(['dpFs', 'dpJira'])
  })

  it('withholds NOTHING when nothing classified — the browse pool and every pre-DA2.2 caller', async () => {
    const out = await materializeRuntimePoolServers(runtimeWith({ mcpServers: twoServers() }), BASE)
    expect(Object.keys(out.mergedMcpServers).sort()).toEqual(['dpFs', 'dpJira'])
  })

  it('reaches the api-transport map too, not only the MCP one', async () => {
    const before = await materializeRuntimePoolServers(apiSourceRuntime('reporting'), BASE)
    // The control: without a verdict this source IS an api server in the pool.
    expect(Object.keys(before.apiServers)).toEqual(['reporting'])

    const after = await materializeRuntimePoolServers(apiSourceRuntime('reporting'), {
      ...BASE,
      modelTarget: EXTERNAL,
    })
    expect(Object.keys(after.apiServers)).toEqual([])
    expect(Object.keys(after.mergedMcpServers)).toEqual(['dpJira'])
  })
})

/** The real pool, recording what it is asked to run instead of connecting. */
class RecordingPool extends McpClientPool {
  readonly synced: { mcp: Record<string, SdkMcpServerConfig>; api: Record<string, unknown> }[] = []

  override async sync(
    mcpServers: Parameters<McpClientPool['sync']>[0],
    apiServers: Parameters<McpClientPool['sync']>[1] = {},
  ): Promise<string[]> {
    this.synced.push({ mcp: mcpServers as Record<string, SdkMcpServerConfig>, api: apiServers as Record<string, unknown> })
    return []
  }
}

describe('BaseAgent.setSourceServers · the session path carries the verdict', () => {
  /**
   * `model` is the model the AGENT is on, and it is passed deliberately rather
   * than left at the `test-model` default: a real session is constructed with
   * `config.model === context.resolvedModel`, the same id the verdict beside it
   * was classified from, and an arm whose two halves disagree measures the
   * D1.425 re-derivation by accident instead of the withholding it names.
   * `switchTo` is the mid-session pick, through the real `BaseAgent.setModel`.
   */
  async function syncWith(
    modelTarget: ModelTargetVerdict | undefined,
    options: { model?: string; switchTo?: string } = {},
  ) {
    const pool = new RecordingPool({})
    const agent = new TestAgent(createMockBackendConfig({
      mcpPool: pool,
      mcpLeaserId: 'session-da22',
      ...(options.model ? { model: options.model } : {}),
      ...(modelTarget ? { modelTarget } : {}),
    }))
    agent.setCapabilityTurnRuntime(runtimeWith({ mcpServers: twoServers() }))
    if (options.switchTo) agent.setModel(options.switchTo)
    await agent.setSourceServers({}, {}, [])
    return pool
  }

  it('an external target reaches the pool having already lost the non-whitelisted server', async () => {
    const pool = await syncWith(EXTERNAL, { model: 'anthropic/claude-x' })
    expect(pool.synced.length).toBe(1)
    expect(Object.keys(pool.synced[0]!.mcp)).toEqual(['dpJira'])
  })

  it('a gateway target hands the pool both — the filter is the verdict, not the call site', async () => {
    const pool = await syncWith(GATEWAY, { model: 'tgpt/deepseek' })
    expect(Object.keys(pool.synced[0]!.mcp).sort()).toEqual(['dpFs', 'dpJira'])
  })

  it('a config with no verdict is byte-for-byte the pre-DA2.2 behaviour', async () => {
    const pool = await syncWith(undefined)
    expect(Object.keys(pool.synced[0]!.mcp).sort()).toEqual(['dpFs', 'dpJira'])
  })
})

/**
 * D1.425 — the verdict is classified ONCE, at backend construction, and pi and
 * codex outlive it: a mid-session model pick reaches `BaseAgent.setModel` and
 * `SessionManager` keeps the agent (`buildRestartRequiredSignature` hashes no
 * model), so before this row the session kept handing an external model every
 * server the whitelist withholds — while the model picker's own disclosure had
 * already told the user they would be withheld.
 *
 * These arms drive the REAL `setModel` and the REAL `setSourceServers` over one
 * BYO endpoint that serves both an in-perimeter and an external model, which is
 * the product's own documented axis (`upstream-target.test.ts` pins that the
 * namespace moves the verdict on an unchanged endpoint) and the one way that
 * verdict moves without a slug or providerType change — i.e. without a rebuild.
 */
describe('BaseAgent.setSourceServers · a mid-session model switch (D1.425)', () => {
  const BYO = 'https://llm-proxy.corp.test/v1'
  const INTERNAL_MODEL = 'tgpt/deepseek-v4-flash-0731'
  const OTHER_INTERNAL_MODEL = 'tgpt/qwen36-35b-a3b-fp8'
  const EXTERNAL_MODEL = 'gpt-4o'
  const BYO_INTERNAL = classifyModelTarget({ baseUrl: BYO, model: INTERNAL_MODEL })
  const BYO_EXTERNAL = classifyModelTarget({ baseUrl: BYO, model: EXTERNAL_MODEL })

  async function syncAfterSwitch(target: ModelTargetVerdict, model: string, switchTo: string) {
    const pool = new RecordingPool({})
    const agent = new TestAgent(createMockBackendConfig({
      mcpPool: pool,
      mcpLeaserId: 'session-d1425',
      model,
      modelTarget: target,
    }))
    agent.setCapabilityTurnRuntime(runtimeWith({ mcpServers: twoServers() }))
    agent.setModel(switchTo)
    await agent.setSourceServers({}, {}, [])
    return pool
  }

  it('withholds the non-whitelisted server after a switch from an in-perimeter model to an external one', async () => {
    // The fail-OPEN half: `dpFs` is a shipped built-in that is NOT on the
    // whitelist, and before D1.425 it stayed in the map the pool syncs, was
    // listed to the model and was callable — the corporate file-system server
    // handed to an external vendor.
    expect(BYO_INTERNAL.restricted).toBe(false)
    const pool = await syncAfterSwitch(BYO_INTERNAL, INTERNAL_MODEL, EXTERNAL_MODEL)
    expect(Object.keys(pool.synced[0]!.mcp)).toEqual(['dpJira'])
  })

  it('gives the servers BACK on a switch from an external model to an in-perimeter one', async () => {
    // The lock-OUT half, and it is the one a user meets first: a session that
    // once touched an external model kept the seven-name whitelist in force
    // over its own servers until it was restarted.
    expect(BYO_EXTERNAL.restricted).toBe(true)
    const pool = await syncAfterSwitch(BYO_EXTERNAL, EXTERNAL_MODEL, INTERNAL_MODEL)
    expect(Object.keys(pool.synced[0]!.mcp).sort()).toEqual(['dpFs', 'dpJira'])
  })

  it('changes NOTHING on a switch between two in-perimeter models', async () => {
    // The control the row asks for: the re-derivation must be invisible unless
    // the verdict itself moved, so a pick inside the perimeter is a no-op.
    const pool = await syncAfterSwitch(BYO_INTERNAL, INTERNAL_MODEL, OTHER_INTERNAL_MODEL)
    expect(Object.keys(pool.synced[0]!.mcp).sort()).toEqual(['dpFs', 'dpJira'])
  })

  it('leaves a session CONSTRUCTED on an external model withheld exactly as before', async () => {
    // The second control: the construction-time path is untouched. No switch at
    // all, the agent's model is the one the verdict was classified from.
    const pool = await syncAfterSwitch(BYO_EXTERNAL, EXTERNAL_MODEL, EXTERNAL_MODEL)
    expect(Object.keys(pool.synced[0]!.mcp)).toEqual(['dpJira'])
  })

  it('keeps a GATEWAY session unrestricted whatever it switches to', async () => {
    // The boundary: on the verified gateway the endpoint decides and the model
    // is not an input, so a switch there may not start withholding.
    const pool = await syncAfterSwitch(GATEWAY, 'tgpt/deepseek', EXTERNAL_MODEL)
    expect(Object.keys(pool.synced[0]!.mcp).sort()).toEqual(['dpFs', 'dpJira'])
  })
})
