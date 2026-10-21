import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { DEFAULT_MANAGED_PI_POLICY, parseManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { executePluginHookAutomations } from '@nessy-agent/shared/plugins/hooks-automation'
import { ChildSessionService } from '../pi-harness/child-session-service.ts'
import { SessionManager } from './SessionManager.ts'
import { createTestSessionManager } from './__tests__/test-session-manager.ts'

const source = () => readFileSync(fileURLToPath(new URL('./SessionManager.ts', import.meta.url)), 'utf8')

function createRunnerHarness() {
  // D1.242 — a REAL instance through `createTestSessionManager`, not
  // a bare prototype double. Every assignment below still
  // overrides what it overrode; the fields nobody seeded are now the
  // constructor's rather than `undefined`. D1.109 priced it: a `mkdtemp` and
  // four in-memory stores, not measurably expensive.
  const manager = createTestSessionManager() as any
  const receipts: Array<Record<string, unknown>> = []
  manager.appendPiExecutionReceipt = (_managed: unknown, receipt: Record<string, unknown>) => {
    receipts.push(receipt)
    return receipt
  }
  manager.piGoalReceiptReference = () => undefined
  // D4: the enforced policy is a GETTER now; the harness seeds its backing
  // field, which is also what `refreshManagedPiPolicy` writes.
  manager.managedPiPolicyCurrent = DEFAULT_MANAGED_PI_POLICY
  return { manager, receipts }
}

function createCapabilityRuntime(overrides: Record<string, unknown> = {}) {
  return {
    projectTrustState: 'trusted',
    view: { generation: 'test-generation', hooks: [], permissionLayers: [] },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
    },
    ...overrides,
  }
}

function createMcpManagedSession(callTool: (...args: unknown[]) => Promise<unknown>) {
  return {
    id: 'session-hook',
    workspace: { id: 'workspace-hook', rootPath: process.cwd() },
    mcpLeaserId: 'lease-hook',
    mcpPool: {
      isProxyTool: () => true,
      callTool,
    },
  }
}

function createPinnedAgentCapabilityRuntime(agentOverrides: Record<string, unknown> = {}) {
  const agentKey = 'plugin://test/agent.review@workspace'
  return {
    agentKey,
    runtime: createCapabilityRuntime({
      view: {
        generation: 'test-agent-generation',
        sources: [],
        skills: [],
        mcpServers: [],
        hooks: [],
        automations: [],
        agents: [{
          key: agentKey,
          name: 'reviewer',
          description: 'Pinned review agent',
          instructionsResource: {
            pluginInstanceId: 'plugin://test@1.0.0#fixture',
            relativePath: 'agents/reviewer.md',
            contentHash: 'fixture',
          },
          model: 'agent-model',
          tools: ['Read', 'Write'],
          effort: 'high',
          maxTurns: 9,
          permissionMode: 'allow-all',
          ...agentOverrides,
        }],
        promptLayers: [],
        memory: [],
        permissionLayers: [],
        commands: [],
        promptCommands: [],
        apps: [],
      },
      materializer: {
        assertActive() {},
        async verifyPlugin() {},
        async resolvePath() { throw new Error('not used') },
        async readText() { return 'Pinned review instructions.' },
        resolveCredential() { throw new Error('not used') },
      },
    }),
  }
}

function createPendingChildPort() {
  const starts: any[] = []
  const stops: string[] = []
  let markStarted!: () => void
  const started = new Promise<void>(resolve => { markStarted = resolve })
  let resolveChild!: (value: any) => void
  const pendingChild = new Promise<any>(resolve => { resolveChild = resolve })
  return {
    port: {
      async start(input: unknown) {
        starts.push(input)
        markStarted()
        return await pendingChild
      },
      async stop(agentId: string) {
        stops.push(agentId)
      },
    },
    starts,
    stops,
    started,
    finish() {
      resolveChild({ agentId: 'child-agent', status: 'completed', output: '' })
    },
  }
}

// P6.117 — this test was `injects governed effectful plugin hook runners only
// for Pi`, and "only for Pi" was the defect rather than the contract: an
// imported `http`/`mcp`/`prompt` hook was advertised in the catalogue and dead
// on claude and codex. The three cheap runners are now supplied wherever
// `PLUGIN_HOOK_ACTION_RUNNERS` lists their kind; only `agent` is still Pi-only,
// and for a HOST reason (`managed.piChildSessionPort`) rather than a runtime
// limit. The dimension this test covered survives — each runner is still built
// by name in the factory — and the per-runtime half is the behavioural block at
// the bottom of this file.
test('builds each governed effectful plugin hook runner from the per-runtime record', () => {
  const sessionManager = source()
  const start = sessionManager.indexOf('private async buildAgentAutomationSystem(')
  const end = sessionManager.indexOf('/**\n   * Get or create agent', start)
  const factory = sessionManager.slice(start, end)

  for (const runner of ['pluginAgentHookRunner', 'pluginMcpToolHookRunner', 'pluginHttpHookRunner']) {
    expect(sessionManager).toContain(`private ${runner}(`)
    expect(factory).toContain(`${runner}: this.${runner}(`)
  }
  // The gate is the record, read once per build — not a provider literal.
  expect(factory).toContain('const runners = new Set(pluginHookActionRunnersFor(provider))')
  // The legacy direct-spawn opt-in is the one thing here that IS still a
  // provider question, and it is about the command runner rather than the four.
  expect(factory).toContain("...(provider === 'pi' ? {} : { allowDirectCommandRunner: true })")
})

test('keeps each effectful runner behind the pinned runtime and existing host ports', () => {
  const sessionManager = source()
  const runners = [
    ['pluginAgentHookRunner', 'managed.piChildSessionPort', 'capabilityGeneration'],
    ['pluginMcpToolHookRunner', 'managed.mcpPool', 'isProxyTool'],
    ['pluginHttpHookRunner', 'executeWebhookRequest', 'new URL'],
  ] as const

  for (const [name, port, guard] of runners) {
    const start = sessionManager.indexOf(`private ${name}(`)
    const end = sessionManager.indexOf('\n  private ', start + 1)
    const runner = sessionManager.slice(start, end < 0 ? undefined : end)
    expect(runner).toContain('capabilityRuntime.materializer.assertActive()')
    expect(runner).toContain('verifyPlugin(')
    expect(runner).toContain(port)
    expect(runner).toContain(guard)
    expect(runner).toContain('appendPiExecutionReceipt(managed')
    expect(runner).toContain('let terminal = false')
    expect(runner).toContain('if (terminal) return')
    expect(runner).toContain('request.signal?.aborted')
    expect(runner).not.toContain('resolveCredential(')
  }

  const agentRunner = sessionManager.slice(
    sessionManager.indexOf('private pluginAgentHookRunner('),
    sessionManager.indexOf('\n  private ', sessionManager.indexOf('private pluginAgentHookRunner(') + 1),
  )
  expect(agentRunner).toContain('permissionMode')
  expect(agentRunner).toContain('capabilityGeneration')
  expect(agentRunner).toContain('AbortSignal.timeout')
  expect(agentRunner).toContain('port.stop(requestedAgentId)')

  const mcpRunner = sessionManager.slice(
    sessionManager.indexOf('private pluginMcpToolHookRunner('),
    sessionManager.indexOf('\n  private ', sessionManager.indexOf('private pluginMcpToolHookRunner(') + 1),
  )
  expect(mcpRunner).toContain('managed.mcpLeaserId')
  expect(mcpRunner).toContain('pool.callTool(request.proxyName, request.args, signal, { leaserId })')

  const httpRunner = sessionManager.slice(
    sessionManager.indexOf('private pluginHttpHookRunner('),
    sessionManager.indexOf('\n  private ', sessionManager.indexOf('private pluginHttpHookRunner(') + 1),
  )
  expect(httpRunner).toContain('this.isPluginHookEffectAllowed(')
  expect(httpRunner).toContain('timeoutMs: pluginHookBudgetMs(request)') // F1.209: the hook's resolved timeout, else 30 s

  // D7: the sandboxed command runner and the direct `runHookCommand` path build
  // the stdin payload from one function, so a hook reads the same documented
  // JSON on Pi and on every other provider.
  const commandRunner = sessionManager.slice(
    sessionManager.indexOf('private pluginCommandHookRunner('),
    sessionManager.indexOf('\n  /** Pi-only, volatile one-shot runner'),
  )
  expect(commandRunner).toContain("stdin: 'pipe'")
  expect(commandRunner).toContain('stdinData: hookCommandStdinPayload(options.event, options.input, authorizedCwd)')
})

describe('SessionManager effectful plugin hook runners', () => {
  test('evaluates actual MCP args while preserving the qualified proxy identity before mutation', async () => {
    const { manager, receipts } = createRunnerHarness()
    const permissionInputs: Array<Record<string, unknown>> = []
    let calls = 0
    manager.isPluginHookEffectAllowed = async (
      _managed: unknown,
      _runtime: unknown,
      _toolName: string,
      _semanticId: string,
      input: Record<string, unknown>,
    ) => {
      permissionInputs.push(input)
      return input.operation !== 'delete'
    }
    const managed = createMcpManagedSession(async () => {
      calls++
      return { isError: false }
    })
    const runner = manager.pluginMcpToolHookRunner(managed, createCapabilityRuntime())

    await runner({
      proxyName: 'mcp__storage__mutate',
      args: {
        operation: 'delete',
        proxy_name: 'mcp__forged__bypass',
      },
      event: 'PostToolUse',
    })

    expect(permissionInputs).toEqual([{
      operation: 'delete',
      proxy_name: 'mcp__storage__mutate',
    }])
    expect(calls).toBe(0)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      outcome: 'denied',
      isolationProfile: 'not-started',
      code: 'permission-denied',
    })
  })

  test('fails closed on absent trust and stale runtime before MCP execution with a terminal receipt', async () => {
    const { manager, receipts } = createRunnerHarness()
    let calls = 0
    manager.isPluginHookEffectAllowed = async () => {
      throw new Error('policy must not run')
    }
    const managed = createMcpManagedSession(async () => {
      calls++
      return { isError: false }
    })

    await manager.pluginMcpToolHookRunner(managed, createCapabilityRuntime({
      projectTrustState: 'none',
    }))({
      proxyName: 'mcp__storage__mutate', args: {}, event: 'PostToolUse',
    })
    await manager.pluginMcpToolHookRunner(managed, createCapabilityRuntime({
      materializer: {
        assertActive() { throw new Error('stale capability generation') },
        async verifyPlugin() {},
      },
    }))({
      proxyName: 'mcp__storage__mutate', args: {}, event: 'PostToolUse',
    })

    expect(calls).toBe(0)
    expect(receipts).toHaveLength(2)
    expect(receipts[0]).toMatchObject({
      outcome: 'denied',
      isolationProfile: 'not-started',
      code: 'plugin-trust-unavailable',
    })
    expect(receipts[1]).toMatchObject({
      outcome: 'error',
      code: 'execution-error',
    })
  })

  test('rejects credential-bearing HTTP descriptors at the runner boundary before policy or fetch', async () => {
    const { manager, receipts } = createRunnerHarness()
    let permissionChecks = 0
    let fetchCalls = 0
    manager.isPluginHookEffectAllowed = async () => {
      permissionChecks++
      return true
    }
    const runner = manager.pluginHttpHookRunner({
      id: 'session-hook',
      workspace: { id: 'workspace-hook', rootPath: process.cwd() },
    }, createCapabilityRuntime())
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response('unexpected')
    }) as unknown as typeof fetch

    try {
      for (const http of [
        { url: 'https://host/hook', headers: { 'X-Api-Key': 'redacted' } },
        { url: 'https://host/hook', headers: { 'X-Custom': 'Bearer raw' } },
        { url: 'https://host/hook', auth: { type: 'bearer', token: 'redacted' } },
        { url: 'https://host/hook?token=raw' },
        { url: 'https://host/hook?value=Bearer%20raw' },
        { url: 'https://user:password@host/hook' },
        { url: 'https://host/hook', body: { payload: { credential: 'raw' } } },
        { url: 'https://host/hook', body: 'token=raw' },
        { url: 'https://host/hook', body: 'Bearer raw' },
        { url: 'https://host/hook', body: 'Basic raw' },
      ]) {
        await runner({ event: 'Stop', http: http as any })
      }
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(permissionChecks).toBe(0)
    expect(fetchCalls).toBe(0)
    expect(receipts).toHaveLength(10)
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({
        outcome: 'denied',
        isolationProfile: 'not-started',
        code: 'credential-bearing-http-hook',
      })
    }
    expect(JSON.stringify(receipts)).not.toContain('raw')
  })

  test('enforces the managed http-hook URL allowlist before permission or fetch, and reports the refusal (R22, UB12.50)', async () => {
    const { manager, receipts } = createRunnerHarness()
    manager.managedPiPolicyCurrent = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      allowedHttpHookUrls: ['https://hooks.example.com/*'],
    })
    let permissionChecks = 0
    manager.isPluginHookEffectAllowed = async () => {
      permissionChecks++
      return true
    }
    const fetchUrls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      fetchUrls.push(String(url))
      return new Response('ok')
    }) as unknown as typeof fetch
    const runner = manager.pluginHttpHookRunner({
      id: 'session-hook',
      workspace: { id: 'workspace-hook', rootPath: process.cwd() },
    }, createCapabilityRuntime())

    let refused: unknown
    try {
      refused = await runner({ event: 'Stop', http: { url: 'https://evil.example.net/x' } })
      await runner({ event: 'Stop', http: { url: 'https://hooks.example.com/deploy' } })
    } finally {
      globalThis.fetch = originalFetch
    }

    // settings-reference.md#allowedhttphookurls: Claude Code "runs an HTTP hook
    // only if its URL matches one of the patterns and blocks the rest without
    // running them" — denied means no request AND no permission evaluation.
    // UB12.50: and the refusal is ANSWERED, so the executor can report it; the
    // page says "blocks", not "silently".
    expect(refused).toEqual({ refused: 'http-hook-url-not-allowed' })
    expect(fetchUrls).toEqual(['https://hooks.example.com/deploy'])
    expect(permissionChecks).toBe(1)
    expect(receipts).toHaveLength(2)
    expect(receipts[0]).toMatchObject({
      outcome: 'denied',
      isolationProfile: 'not-started',
      code: 'http-hook-url-not-allowed',
    })
    expect(receipts[1]).toMatchObject({ outcome: 'success', isolationProfile: 'host-webhook' })
  })

  test('interpolates only the managed-intersected env vars into http hook headers (R22)', async () => {
    const { manager, receipts } = createRunnerHarness()
    manager.managedPiPolicyCurrent = parseManagedPiPolicyV1({
      schemaVersion: 1,
      disabledPermissionModes: [],
      httpHookAllowedEnvVars: ['NESSY_R22_CI_TOKEN'],
    })
    manager.isPluginHookEffectAllowed = async () => true
    process.env.NESSY_R22_CI_TOKEN = 'ci-value'
    process.env.NESSY_R22_HOME = 'home-value'
    let captured: Record<string, string> | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      captured = init?.headers
      return new Response('ok')
    }) as unknown as typeof fetch
    const runner = manager.pluginHttpHookRunner({
      id: 'session-hook',
      workspace: { id: 'workspace-hook', rootPath: process.cwd() },
    }, createCapabilityRuntime())

    try {
      await runner({
        event: 'Stop',
        http: {
          url: 'https://hooks.example.com/deploy',
          allowedEnvVars: ['NESSY_R22_CI_TOKEN', 'NESSY_R22_HOME'],
          headers: { 'X-CI': '$NESSY_R22_CI_TOKEN', 'X-Home': '$NESSY_R22_HOME' },
        },
      })
    } finally {
      globalThis.fetch = originalFetch
      delete process.env.NESSY_R22_CI_TOKEN
      delete process.env.NESSY_R22_HOME
    }

    // Effective allowlist = hook list ∩ managed httpHookAllowedEnvVars, so the
    // hook-listed but managed-excluded HOME reference resolves to ''.
    expect(captured).toMatchObject({ 'X-CI': 'ci-value', 'X-Home': '' })
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ outcome: 'success', isolationProfile: 'host-webhook' })
  })

  test('a prompt hook decides through the production mini-model runner (R22)', async () => {
    const { manager, receipts } = createRunnerHarness()
    const prompts: string[] = []
    const responses = ['{"ok":false,"reason":"r"}', 'garbage, not a verdict']
    const managed = {
      id: 'session-hook',
      workspace: { id: 'workspace-hook', rootPath: process.cwd() },
      agent: {
        runMiniCompletion: async (prompt: string) => {
          prompts.push(prompt)
          return responses.shift() ?? null
        },
      },
    }
    const promptRunner = manager.pluginPromptHookRunner(managed, createCapabilityRuntime())
    const config = {
      automations: {
        PreToolUse: [{
          matcher: 'Bash',
          actions: [{ type: 'plugin-prompt' as const, prompt: 'Judge this call: $ARGUMENTS' }],
        }],
      },
    }
    const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' } }

    const blocked = await executePluginHookAutomations(config, 'PreToolUse', input, {
      workspaceRootPath: process.cwd(), promptRunner,
    })
    const unparseable = await executePluginHookAutomations(config, 'PreToolUse', input, {
      workspaceRootPath: process.cwd(), promptRunner,
    })

    expect(blocked.decision).toMatchObject({ decision: 'block', reason: 'r' })
    // hooks.md: the hook input JSON is substituted for $ARGUMENTS.
    expect(prompts[0]).toContain(`Judge this call: ${JSON.stringify(input)}`)
    // A garbage verdict fails open: no block, error receipt only.
    expect(unparseable.decision).toBeUndefined()
    expect(receipts).toHaveLength(2)
    expect(receipts[0]).toMatchObject({
      semanticId: 'plugin-prompt-hook',
      outcome: 'success',
      isolationProfile: 'host-mini-model',
      code: 'verdict-block',
    })
    expect(receipts[1]).toMatchObject({
      semanticId: 'plugin-prompt-hook',
      outcome: 'error',
      code: 'unparseable-verdict',
    })
  })

  test('pins the agent declaration and clamps the child admission before aborting once', async () => {
    const { manager, receipts } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => true
    const { agentKey, runtime } = createPinnedAgentCapabilityRuntime()
    const child = createPendingChildPort()
    const parentDeadline = Date.now() + 60_000
    const managed = {
      id: 'session-hook',
      workspace: { id: 'workspace-hook', rootPath: process.cwd() },
      model: 'parent-model',
      permissionMode: 'ask',
      piChildRestrictions: { permissionMode: 'ask', maxTurns: 2 },
      piChildBudgets: {
        depth: 2,
        maxDepth: 4,
        fanout: 3,
        concurrency: 2,
        tokenLimit: 20_000,
        costLimitUsd: 3,
        deadlineAt: parentDeadline,
        ancestry: ['root', 'parent'],
      },
      piChildSessionPort: child.port,
    }
    const controller = new AbortController()
    const runner = manager.pluginAgentHookRunner(managed, runtime)

    const pending = runner({ agentName: agentKey, event: 'Stop', signal: controller.signal })
    await child.started

    expect(child.starts).toHaveLength(1)
    // AGENTS.md §Traps — `toMatchObject` OVERWRITES the asserted field with an
    // asymmetric matcher, so passing `expect.stringMatching(...)` here would
    // leave `child.starts[0].restrictions.definitionDigest` holding the MATCHER
    // for every later read in this test (P6.762). Read the value out first,
    // assert the shape on the local, and keep the object assertion literal.
    const definitionDigest = child.starts[0].restrictions.definitionDigest
    expect(definitionDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(child.starts[0]).toMatchObject({
      agent: agentKey,
      background: false,
      restrictions: {
        model: 'agent-model',
        tools: ['Read', 'Write'],
        capabilityGeneration: 'test-agent-generation',
        definitionKey: agentKey,
        definitionDigest,
        permissionMode: 'ask',
        maxTurns: 2,
        worktreePolicy: 'isolated-worktree',
        // `sub-agents.md:289` — the declaration overrides the session level.
        thinkingLevel: 'high',
      },
      budgets: {
        depth: 3,
        maxDepth: 4,
        // F1.740 — the parent's own ceilings (3, 2), no longer a flat 1 that
        // refused the hook agent once the session had had any child.
        fanout: 3,
        concurrency: 2,
        tokenLimit: 10_000,
        costLimitUsd: 1,
        ancestry: ['root', 'parent'],
      },
    })
    expect(child.starts[0].budgets.deadlineAt).toBeLessThanOrEqual(parentDeadline)
    // The negative half of the same trap: with the matcher passed in above, this
    // read returned the matcher object rather than the 64-hex digest.
    expect(child.starts[0].restrictions.definitionDigest).toBe(definitionDigest)
    expect(typeof child.starts[0].restrictions.definitionDigest).toBe('string')

    controller.abort()
    await pending
    child.finish()

    expect(child.stops).toHaveLength(1)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      semanticId: 'plugin-agent-hook',
      outcome: 'cancelled',
      isolationProfile: 'host-child-session',
      code: 'aborted',
    })
  })

  /**
   * P2.273 + P2.301 — THIS TEST NOW ASSERTS THE FIX. It landed on `1981a1470`
   * asserting the DEFECT (`toEqual([])`), deliberately and with the reason
   * written out, because the correction did not compile from inside that lane's
   * zone; it was flipped in the same commit that made it compile, so the repo
   * never held a green test that read like a bug was intended.
   *
   * The contract is `errors.md` § *Agent would be spawned with zero tools*,
   * which keeps two answers apart in one sentence: "Omitting the `tools` field
   * never triggers this refusal. If you leave the `tools` list empty, or
   * `disallowedTools` removes every entry in it, Claude Code also skips the
   * refusal and launches the subagent without tools." — with the fix list
   * spelling out what the omission buys: "Delete the `tools` field instead of
   * listing tools to give the subagent every tool available to subagents", and
   * `sub-agents.md` § *Supported frontmatter fields* stating the positive half
   * in its `tools` row: "Inherits every tool available to subagents if omitted."
   *
   * `parseDeclaredTools` always distinguished the two (`undefined` vs the frozen
   * empty list) and so did both layers under the transport (`piAllowedTools`,
   * and `resolvePiAllowedBindingNames`'s `if (!allowedToolNames) return null`).
   * The producer's `definition.tools ? [...definition.tools] : []` threw the
   * distinction away, and it had to: `PiChildRestrictionsV1.tools` was a
   * REQUIRED `string[]`, so the host transport could not say "inherit" at all.
   * P2.301 made the field optional; the producer now omits the key, which is the
   * one thing it could not do before.
   *
   * What was MEASURED on the unmodified defect, for whoever reads this later:
   * `restrictions.tools === []`, `worktreePolicy === 'isolated-worktree'`, and a
   * receipt reading `outcome: 'success'` — a child that could call nothing,
   * holding a worktree lease, reported as a success. Only the first of those
   * three changes here; the lease and the success are now honest, because the
   * child arrives with the parent's pool instead of an empty one.
   */
  test('an omitted `tools:` reaches the child as an omitted ceiling, not the empty set', async () => {
    const { manager, receipts } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => true
    const { agentKey, runtime } = createPinnedAgentCapabilityRuntime({ tools: undefined })
    const child = createPendingChildPort()
    const managed = {
      id: 'session-hook',
      workspace: { id: 'workspace-hook', rootPath: process.cwd() },
      model: 'parent-model',
      piChildSessionPort: child.port,
    }

    const pending = manager.pluginAgentHookRunner(managed, runtime)({ agentName: agentKey, event: 'Stop' })
    await child.started
    child.finish()
    await pending

    // Absent, and absent by OMISSION — not a key holding `undefined`. The
    // difference is invisible to a reader and load-bearing for a persisted
    // record, which is what `PiChildSessionRecordV1.restrictions` is.
    expect(child.starts[0].restrictions.tools).toBeUndefined()
    expect('tools' in child.starts[0].restrictions).toBe(false)
    // Unchanged, and now honest: `isReadOnlySubagentToolGrant` still answers
    // false for an omitted list, so an inheriting child takes the isolating
    // policy. It is a lease for an agent that can now act, not for one that
    // could not.
    expect(child.starts[0].restrictions.worktreePolicy).toBe('isolated-worktree')
    // Also unchanged, and also now honest: the receipt says `success` for a
    // child that had a tool pool.
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      semanticId: 'plugin-agent-hook',
      outcome: 'success',
      isolationProfile: 'host-child-session',
    })
  })

  /**
   * The boundary the fix above must not widen, and the positive control for the
   * fixture route: an author who WROTE `tools: []` asked for the empty set and
   * still gets it (`errors.md`, same section). This test was NON-DISCRIMINATING
   * until the fix landed — both shapes produced `[]`, which was the whole
   * defect — and it discriminates now: `EMPTY_TOOL_LIST` is a frozen `[]` and
   * therefore TRUTHY, so the producer's `?` branch fires for it and the `: {}`
   * branch fires only for the genuinely missing key.
   */
  test('keeps an authored-empty `tools: []` as the empty pool it declared', async () => {
    const { manager } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => true
    const { agentKey, runtime } = createPinnedAgentCapabilityRuntime({ tools: [] })
    const child = createPendingChildPort()
    const managed = {
      id: 'session-hook',
      workspace: { id: 'workspace-hook', rootPath: process.cwd() },
      model: 'parent-model',
      piChildSessionPort: child.port,
    }

    const pending = manager.pluginAgentHookRunner(managed, runtime)({ agentName: agentKey, event: 'Stop' })
    await child.started
    child.finish()
    await pending

    expect(child.starts[0].restrictions.tools).toEqual([])
    // Present, not merely equal to `[]` — the pair of `in` checks is what makes
    // the two shapes distinguishable at all.
    expect('tools' in child.starts[0].restrictions).toBe(true)
  })

  /**
   * `sub-agents.md:289` — a subagent's `effort` "Overrides the session effort
   * level. Default: inherits from session." This defaulted to `off`, so a
   * hook-spawned agent thought at NOTHING regardless of the session — a quality
   * regression with no surface anyone could have seen it on. The model clamp
   * (`model-config.md:452`) is the separate rule that only ever lowers.
   */
  test.each([
    // declared effort   session level   child model            resolved
    [undefined,          'xhigh',        'agent-model',         'xhigh'],
    [undefined,          undefined,      'agent-model',         'medium'],
    ['low',              'max',          'agent-model',         'low'],
    ['max',              'low',          'agent-model',         'max'],
    ['xhigh',            'low',          'claude-opus-4-6',     'high'],
  ] as const)(
    'spawns a hook agent declaring %p under a session at %p on %s at %p',
    async (declared, sessionLevel, childModel, expected) => {
      const { manager } = createRunnerHarness()
      manager.isPluginHookEffectAllowed = async () => true
      const { agentKey, runtime } = createPinnedAgentCapabilityRuntime({
        model: childModel,
        ...(declared === undefined ? { effort: undefined } : { effort: declared }),
      })
      const child = createPendingChildPort()
      const managed = {
        id: 'session-hook',
        workspace: { id: 'workspace-hook', rootPath: process.cwd() },
        model: 'parent-model',
        ...(sessionLevel === undefined ? {} : { thinkingLevel: sessionLevel }),
        piChildSessionPort: child.port,
      }
      const controller = new AbortController()
      const pending = manager.pluginAgentHookRunner(managed, runtime)({ agentName: agentKey, event: 'Stop', signal: controller.signal })
      await child.started

      expect(child.starts[0].restrictions).toMatchObject({ model: childModel, thinkingLevel: expected })

      controller.abort()
      await pending
      child.finish()
    },
  )

  test('stops a pinned child exactly once when the hook timeout fires', async () => {
    const { manager, receipts } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => true
    const { agentKey, runtime } = createPinnedAgentCapabilityRuntime()
    const child = createPendingChildPort()
    const managed = {
      id: 'session-hook',
      workspace: { id: 'workspace-hook', rootPath: process.cwd() },
      model: 'parent-model',
      permissionMode: 'ask',
      piChildSessionPort: child.port,
    }
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
    let timeoutController: AbortController | undefined
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: () => {
        timeoutController = new AbortController()
        return timeoutController.signal
      },
    })

    try {
      const pending = manager.pluginAgentHookRunner(managed, runtime)({ agentName: agentKey, event: 'Stop' })
      await child.started
      timeoutController!.abort()
      await pending
      child.finish()
    } finally {
      if (timeoutDescriptor) Object.defineProperty(AbortSignal, 'timeout', timeoutDescriptor)
    }

    expect(child.stops).toHaveLength(1)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      semanticId: 'plugin-agent-hook',
      outcome: 'timed-out',
      isolationProfile: 'host-child-session',
      code: 'timeout',
    })
  })

  test('forwards a live HTTP hook abort into the webhook executor before the terminal receipt', async () => {
    const { manager, receipts } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => true
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let markClientClosed!: () => void
    const clientClosed = new Promise<void>(resolve => { markClientClosed = resolve })
    const server = createServer((request, response) => {
      markStarted()
      request.once('close', () => {
        markClientClosed()
        response.destroy()
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('local test server address unavailable')
    const controller = new AbortController()
    const runner = manager.pluginHttpHookRunner({
      id: 'session-hook',
      workspace: { id: 'workspace-hook', rootPath: process.cwd() },
    }, createCapabilityRuntime())

    try {
      const pending = runner({
        event: 'Stop',
        http: { url: `http://127.0.0.1:${address.port}` },
        signal: controller.signal,
      })
      await started
      controller.abort()
      await pending
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }

    await expect(Promise.race([
      clientClosed.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 500)),
    ])).resolves.toBe(true)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      outcome: 'cancelled',
      isolationProfile: 'host-webhook',
      code: 'aborted',
    })
  })

  /**
   * D6/D8 — the runners answer. hooks.md § HTTP response handling: a 2xx body
   * "parsed using the same JSON output schema as command hooks"; § MCP tool
   * hook fields: "The tool's text content is treated like command-hook stdout".
   * Loopback only — a hook probe never points at a real host.
   */
  test('returns the http hook answer for 2xx and a non-blocking error otherwise', async () => {
    const { manager } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => true
    const server = createServer((request, response) => {
      if (request.url === '/deny') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ decision: 'block', reason: 'denied by policy' }))
        return
      }
      response.writeHead(503)
      response.end('unavailable')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('local test server address unavailable')
    const runner = manager.pluginHttpHookRunner({
      id: 'session-hook',
      workspace: { id: 'workspace-hook', rootPath: process.cwd() },
    }, createCapabilityRuntime())

    try {
      const allowed = await runner({ event: 'PreToolUse', http: { url: `http://127.0.0.1:${address.port}/deny` } })
      expect(JSON.parse(String(allowed?.body))).toEqual({ decision: 'block', reason: 'denied by policy' })
      expect(allowed?.failed).toBeUndefined()

      const failed = await runner({ event: 'PreToolUse', http: { url: `http://127.0.0.1:${address.port}/boom` } })
      expect(failed).toEqual({ failed: true, code: 'http-hook-error' })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('returns the mcp_tool hook text content, and a non-blocking error for isError', async () => {
    const { manager } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => true
    const answers = [
      { isError: false, content: '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"scanned"}}' },
      { isError: true, content: 'tool failed' },
    ]
    const managed = createMcpManagedSession(async () => answers.shift())
    const runner = manager.pluginMcpToolHookRunner(managed, createCapabilityRuntime())

    expect(await runner({ event: 'PostToolUse', proxyName: 'mcp__policy__check', args: {} })).toEqual({
      body: '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"scanned"}}',
    })
    expect(await runner({ event: 'PostToolUse', proxyName: 'mcp__policy__check', args: {} })).toEqual({
      failed: true,
      code: 'mcp-tool-hook-error',
    })
  })
})

// ============================================================
// UB12.50 · a hook the host runner refuses to start is REPORTED.
//
// The premise, measured at HEAD before this change: `pluginHttpHookRunner`
// wrote a `denied`/`not-started` receipt and returned NOTHING for the trust,
// managed-allowlist and permission refusals, and `applyHookRunnerVerdict`
// reads nothing as "the hook answered nothing" — so `hookErrors` stayed empty
// and a webhook that never fired (UB12.28 dispatches native ones here) said so
// nowhere but the receipt. hooks.md#exit-code-output: a hook that "fails in
// some other way, such as not starting" is a non-blocking error, and "on
// events such as `PreToolUse` you see a `<hook name> hook error` notice".
//
// The rig drives the REAL runner through the REAL executor, so the arm fails
// if either half goes back to silence.
// ============================================================

describe('UB12.50 · a host-refused http hook is reported, not silent', () => {
  /** Fresh action objects per call: the notice is deduplicated per action. */
  function httpHookConfig(url: string) {
    return {
      automations: {
        PreToolUse: [{ id: 'policy/webhook', name: 'policy/webhook', matcher: 'Bash', actions: [{ type: 'plugin-http' as const, http: { url } }] }],
      },
    }
  }
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' } }
  const managed = { id: 'session-hook', workspace: { id: 'workspace-hook', rootPath: process.cwd() } }

  test('a permission-denied run yields ONE notice, keeps its receipt on every dispatch, and never sends', async () => {
    const { manager, receipts } = createRunnerHarness()
    // `default`/`acceptEdits` ASK for an http POST, and a hook cannot ask, so the
    // production check fails closed — this is that answer.
    manager.isPluginHookEffectAllowed = async () => false
    const httpRunner = manager.pluginHttpHookRunner(managed, createCapabilityRuntime())
    const config = httpHookConfig('https://hooks.example.com/policy')
    let fetchCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { fetchCalls++; return new Response('') }) as unknown as typeof fetch

    let first: any
    let second: any
    try {
      first = await executePluginHookAutomations(config, 'PreToolUse', input, { workspaceRootPath: process.cwd(), httpRunner })
      second = await executePluginHookAutomations(config, 'PreToolUse', input, { workspaceRootPath: process.cwd(), httpRunner })
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(fetchCalls).toBe(0)
    expect(first.hookErrors).toHaveLength(1)
    expect(first.hookErrors[0]).toMatchObject({
      hookName: 'policy/webhook',
      event: 'PreToolUse',
      exitCode: null,
      summary: "http hook did not run: the session's permission mode and rules do not allow it",
    })
    expect(first.hookErrors[0].detail).toContain('the request was never sent')
    // A non-blocking error: the tool call is not blocked by a hook that never ran.
    expect(first.decision?.decision).not.toBe('block')
    // Boundary: the SAME action refused for the same reason again is not a
    // second transcript warning (a PreToolUse hook fires on every tool call) …
    expect(second.hookErrors ?? []).toEqual([])
    // … but the receipt and the /hooks run row are written on every dispatch.
    expect(receipts).toHaveLength(2)
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({ outcome: 'denied', isolationProfile: 'not-started', code: 'permission-denied' })
    }
    for (const result of [first, second]) {
      expect(result.hookRuns).toHaveLength(1)
      expect(result.hookRuns[0]).toMatchObject({ runtime: 'host', name: 'policy/webhook', outcome: 'error' })
      expect(result.hookRuns[0].stderr).toContain('did not allow its effect without asking')
    }
  })

  test('an untrusted project with no plugin hook refuses before policy, and that refusal is reported too', async () => {
    const { manager, receipts } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => { throw new Error('policy must not run') }
    const httpRunner = manager.pluginHttpHookRunner(managed, createCapabilityRuntime({ projectTrustState: 'none' }))

    const result = await executePluginHookAutomations(httpHookConfig('https://hooks.example.com/policy'), 'PreToolUse', input, {
      workspaceRootPath: process.cwd(), httpRunner,
    })

    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ outcome: 'denied', isolationProfile: 'not-started', code: 'plugin-trust-unavailable' })
    expect(result.hookErrors).toHaveLength(1)
    expect(result.hookErrors?.[0]?.summary).toBe('http hook did not run: this project is not trusted')
  })

  test('an allowed run yields no notice (the negative arm)', async () => {
    const { manager, receipts } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => true
    const bodies: string[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        bodies.push(body)
        response.writeHead(200)
        response.end() // hooks.md: a 2xx empty body is "equivalent to exit code 0 with no output"
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('local test server address unavailable')
    const httpRunner = manager.pluginHttpHookRunner(managed, createCapabilityRuntime())

    let result: any
    try {
      result = await executePluginHookAutomations(httpHookConfig(`http://127.0.0.1:${address.port}/policy`), 'PreToolUse', input, {
        workspaceRootPath: process.cwd(), httpRunner,
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }

    expect(bodies).toHaveLength(1)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ outcome: 'success', isolationProfile: 'host-webhook' })
    expect(result.hookErrors).toBeUndefined()
    expect(result.hookRuns?.[0]).toMatchObject({ outcome: 'success' })
  })
})

// ============================================================
// UB12.66 · the mcp_tool runner's two not-started refusals are REPORTED too.
//
// The premise, read at HEAD 6d929aaea: `pluginMcpToolHookRunner`, the sibling
// UB12.50 left alone, wrote a `denied`/`not-started` receipt and returned
// NOTHING for `plugin-trust-unavailable` and `permission-denied`, so
// `applyHookRunnerVerdict` read "answered nothing" and `hookErrors` stayed
// empty. A non-read-only MCP tool asks in `default`/`acceptEdits`
// (`shouldPromptInAskMode`), a hook cannot ask, so outside bypassPermissions an
// mcp_tool hook never ran and said so nowhere but the receipt.
// hooks.md#exit-code-output (curl'd 2026-10-16): a hook that "fails in some
// other way, such as not starting" is a non-blocking error, and "on events
// such as `PreToolUse` you see a `<hook name> hook error` notice". The REAL
// runner through the REAL executor.
// ============================================================

describe('UB12.66 · a host-refused mcp_tool hook is reported, not silent', () => {
  /** Fresh action objects per call: the notice is deduplicated per action. */
  function mcpToolHookConfig() {
    return {
      automations: {
        PreToolUse: [{ id: 'policy/scan', name: 'policy/scan', matcher: 'Bash', actions: [{ type: 'plugin-mcp-tool' as const, mcpTool: 'mcp__policy__check' }] }],
      },
    }
  }
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' } }

  test('a permission-denied run yields ONE notice, keeps its receipt on every dispatch, and never invokes the tool', async () => {
    const { manager, receipts } = createRunnerHarness()
    // `default`/`acceptEdits` ASK for a non-read-only MCP tool, and a hook
    // cannot ask, so the production check fails closed: this is that answer.
    manager.isPluginHookEffectAllowed = async () => false
    let calls = 0
    const managed = createMcpManagedSession(async () => { calls++; return { isError: false, content: '' } })
    const mcpToolRunner = manager.pluginMcpToolHookRunner(managed, createCapabilityRuntime())
    // The runner itself names the refusal (the receipt's own code).
    expect(await mcpToolRunner({ proxyName: 'mcp__policy__check', args: {}, event: 'PreToolUse' })).toEqual({ refused: 'permission-denied' })
    receipts.length = 0

    const config = mcpToolHookConfig()
    const first: any = await executePluginHookAutomations(config, 'PreToolUse', input, { workspaceRootPath: process.cwd(), mcpToolRunner })
    const second: any = await executePluginHookAutomations(config, 'PreToolUse', input, { workspaceRootPath: process.cwd(), mcpToolRunner })

    expect(calls).toBe(0)
    expect(first.hookErrors).toHaveLength(1)
    expect(first.hookErrors[0]).toMatchObject({
      hookName: 'policy/scan',
      event: 'PreToolUse',
      exitCode: null,
      summary: "mcp_tool hook did not run: the session's permission mode and rules do not allow it",
    })
    expect(first.hookErrors[0].detail).toContain('the declared tool was never invoked')
    // A non-blocking error (hooks.md gives `onFailure` to command and http only).
    expect(first.decision?.decision).not.toBe('block')
    // Boundary: the same action refused for the same reason is not a second notice …
    expect(second.hookErrors ?? []).toEqual([])
    // … but the receipt and the /hooks run row are written on every dispatch.
    expect(receipts).toHaveLength(2)
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({ semanticId: 'plugin-mcp-hook', outcome: 'denied', isolationProfile: 'not-started', code: 'permission-denied' })
    }
    for (const result of [first, second]) {
      expect(result.hookRuns).toHaveLength(1)
      expect(result.hookRuns[0]).toMatchObject({ runtime: 'host', name: 'policy/scan', outcome: 'error' })
      expect(result.hookRuns[0].stderr).toContain('did not allow its effect without asking')
    }
  })

  test('an untrusted project with no plugin hook refuses before policy, and that refusal is reported too', async () => {
    const { manager, receipts } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => { throw new Error('policy must not run') }
    let calls = 0
    const managed = createMcpManagedSession(async () => { calls++; return { isError: false, content: '' } })
    const mcpToolRunner = manager.pluginMcpToolHookRunner(managed, createCapabilityRuntime({ projectTrustState: 'none' }))

    const result: any = await executePluginHookAutomations(mcpToolHookConfig(), 'PreToolUse', input, {
      workspaceRootPath: process.cwd(), mcpToolRunner,
    })

    expect(calls).toBe(0)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ outcome: 'denied', isolationProfile: 'not-started', code: 'plugin-trust-unavailable' })
    expect(result.hookErrors).toHaveLength(1)
    expect(result.hookErrors[0].summary).toBe('mcp_tool hook did not run: this project is not trusted')
    expect(result.decision?.decision).not.toBe('block')
  })

  test('an allowed run yields no notice (the negative arm)', async () => {
    const { manager, receipts } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => true
    let calls = 0
    const managed = createMcpManagedSession(async () => { calls++; return { isError: false, content: '' } })
    const mcpToolRunner = manager.pluginMcpToolHookRunner(managed, createCapabilityRuntime())

    const result: any = await executePluginHookAutomations(mcpToolHookConfig(), 'PreToolUse', input, {
      workspaceRootPath: process.cwd(), mcpToolRunner,
    })

    expect(calls).toBe(1)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ outcome: 'success', isolationProfile: 'host-mcp' })
    expect(result.hookErrors).toBeUndefined()
    expect(result.hookRuns?.[0]).toMatchObject({ outcome: 'success' })
  })
})

// ============================================================
// UB12.67 · `onFailure: "block"` on an http hook fails CLOSED.
//
// hooks.md#block-the-action-when-a-hook-fails (curl'd 2026-10-16): "To block
// the action instead, set `"onFailure": "block"` on a `command` or `http`
// hook. The default value is `"continue"`." and, in the failure list, "HTTP
// error: an HTTP hook's connection fails, or the response status isn't 2xx".
// The premise at HEAD: the field was read nowhere, so a 503 from a policy
// endpoint let the tool call through whatever the author declared. The REAL
// runner through the REAL executor against a loopback sink that answers 503.
// ============================================================

describe('UB12.67 · an http hook with onFailure "block" blocks the tool when its sink answers 503', () => {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pwd' } }
  const managed = { id: 'session-hook', workspace: { id: 'workspace-hook', rootPath: process.cwd() } }

  async function fireAgainst503(onFailure: 'block' | undefined) {
    const { manager } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => true
    let hits = 0
    const server = createServer((_request, response) => {
      hits++
      response.writeHead(503)
      response.end('unavailable')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('local test server address unavailable')
    const httpRunner = manager.pluginHttpHookRunner(managed, createCapabilityRuntime())
    const config = {
      automations: {
        PreToolUse: [{
          id: 'policy/gate',
          name: 'policy/gate',
          matcher: 'Bash',
          actions: [{ type: 'plugin-http' as const, http: { url: `http://127.0.0.1:${address.port}/policy` }, ...(onFailure ? { onFailure } : {}) }],
        }],
      },
    }
    try {
      const result = await executePluginHookAutomations(config, 'PreToolUse', input, { workspaceRootPath: process.cwd(), httpRunner })
      return { result, hits }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  test('POSITIVE: onFailure "block" turns the 503 into a blocked tool call, and the failure notice stays', async () => {
    const { result, hits } = await fireAgainst503('block')
    expect(hits).toBe(1)
    const decision = result.decision?.decision
    const reason = result.decision?.reason
    expect(decision).toBe('block')
    expect(reason).toStartWith('[http hook]: failed; blocking because onFailure is "block"')
    expect(reason).toContain('http-hook-error')
    expect(result.hookErrors).toEqual([{ hookName: 'policy/gate', event: 'PreToolUse', exitCode: null, summary: 'http-hook-error' }])
  })

  test('NEGATIVE: the default "continue" lets the same 503 through with its notice', async () => {
    const { result, hits } = await fireAgainst503(undefined)
    expect(hits).toBe(1)
    expect(result.decision?.decision).toBeUndefined()
    expect(result.hookErrors).toEqual([{ hookName: 'policy/gate', event: 'PreToolUse', exitCode: null, summary: 'http-hook-error' }])
  })
})

// ============================================================
// P6.117 · a plugin-imported http hook fires on claude and on codex.
//
// The row's premise, measured at HEAD before this change: the four action
// runners were handed to `buildPinnedAgentAutomationSystem` only inside
// `provider === 'pi' ? {…} : {…}`, so `hooks-automation.ts` reached
// `reportMissingRunner` for every imported `http`/`mcp`/`prompt` hook on the
// other two runtimes — advertised in the catalogue, inert in production.
//
// These cases drive the PRODUCTION builder (`buildAgentAutomationSystem`), not
// a hand-assembled option bag, because the thing under test is which runners
// that builder supplies for which provider. The Pi arm is the positive control:
// a rig that fired nothing anywhere would pass a claude-only assertion.
// ============================================================

describe('P6.117 · the plugin http hook runner reaches every coding runtime', () => {
  const PLUGIN_INSTANCE = 'plugin://test@1.0.0#fixture'

  /** One imported `"type": "http"` hook, in the PLUGIN tier (no `absolutePath`
   * on the resource, so `isNativeResource` sends it down the plugin path). */
  function pluginHttpHookRuntime(provider: string, url: string) {
    return {
      provider,
      projectTrustState: 'trusted',
      view: {
        generation: 'test-generation',
        sources: [], skills: [], mcpServers: [],
        hooks: [{
          key: 'plugin://test/hook.deploy@workspace',
          event: 'Stop',
          type: 'http',
          http: { url },
          pluginInstanceId: PLUGIN_INSTANCE,
          resource: {
            pluginInstanceId: PLUGIN_INSTANCE,
            relativePath: 'hooks/deploy.json',
            contentHash: 'fixture',
          },
          executableHash: 'fixture',
        }],
        automations: [], agents: [], promptLayers: [], memory: [],
        permissionLayers: [], commands: [], promptCommands: [], apps: [],
      },
      materializer: {
        assertActive() {},
        async verifyPlugin() {},
        async readText() { throw new Error('the plugin tier never reads a native hooks document') },
      },
    }
  }

  async function fireStopHookOn(provider: string, options: {
    url: string
    allowedHttpHookUrls?: readonly string[]
    /**
     * The endpoint's 2xx body. Empty by default: hooks.md § HTTP response
     * handling, "2xx with an empty body: success, equivalent to exit code 0
     * with no output". UB12.51 made a plain-text body (this fixture answered
     * `ok` until then) the non-blocking error a non-2xx is.
     */
    responseBody?: string
  }) {
    const { manager, receipts } = createRunnerHarness()
    if (options.allowedHttpHookUrls) {
      manager.managedPiPolicyCurrent = parseManagedPiPolicyV1({
        schemaVersion: 1,
        disabledPermissionModes: [],
        allowedHttpHookUrls: [...options.allowedHttpHookUrls],
      })
    }
    let permissionChecks = 0
    manager.isPluginHookEffectAllowed = async () => {
      permissionChecks++
      return true
    }
    // The three collaborators this builder needs and this row does not test.
    manager.trackAgentAutomationSystem = (_managed: unknown, system: unknown) => system
    manager.liveComponentHookLayer = () => undefined
    manager.sendEvent = () => {}
    const managed = { id: 'session-hook', workspace: { id: 'workspace-hook', rootPath: process.cwd() } }

    const fetchUrls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: unknown) => {
      fetchUrls.push(String(url))
      return new Response(options.responseBody ?? '')
    }) as unknown as typeof fetch
    let result: { hookErrors?: ReadonlyArray<{ summary: string }> } | undefined
    try {
      const system = await manager.buildAgentAutomationSystem(
        managed,
        pluginHttpHookRuntime(provider, options.url),
        provider,
      )
      expect(system, `no automation system was built for ${provider}`).toBeDefined()
      result = await system.executeAgentEvent('Stop', { hook_event_name: 'Stop' })
    } finally {
      globalThis.fetch = originalFetch
    }
    return { fetchUrls, receipts, permissionChecks, hookErrors: result?.hookErrors ?? [] }
  }

  for (const provider of ['anthropic', 'codex-runtime', 'pi'] as const) {
    test(`fires the imported http hook and mints a receipt on ${provider}`, async () => {
      const { fetchUrls, receipts, permissionChecks, hookErrors } = await fireStopHookOn(provider, {
        url: 'https://hooks.example.com/deploy',
      })

      expect(fetchUrls).toEqual(['https://hooks.example.com/deploy'])
      expect(permissionChecks).toBe(1)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({ outcome: 'success', isolationProfile: 'host-webhook' })
      // UB12.50's negative arm on the production builder: a hook that ran says nothing.
      expect(hookErrors).toEqual([])
    })

    test(`UB12.51 — a 2xx plain-text answer is the non-2xx notice on ${provider}, and the request still ran`, async () => {
      const { fetchUrls, receipts, hookErrors } = await fireStopHookOn(provider, {
        url: 'https://hooks.example.com/deploy',
        responseBody: 'ok',
      })

      expect(fetchUrls).toEqual(['https://hooks.example.com/deploy'])
      // The receipt records the request, which succeeded; the notice records the answer.
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({ outcome: 'success', isolationProfile: 'host-webhook' })
      expect(hookErrors.map(notice => notice.summary)).toEqual(['http-hook-error'])
    })

    test(`denies a non-matching managed URL with http-hook-url-not-allowed on ${provider}`, async () => {
      const { fetchUrls, receipts, permissionChecks, hookErrors } = await fireStopHookOn(provider, {
        url: 'https://evil.example.net/x',
        allowedHttpHookUrls: ['https://hooks.example.com/*'],
      })

      // UB12.50 — the refusal reaches `hookErrors` (the transcript warning), on
      // every runtime the runner is supplied to, beside the receipt below.
      expect(hookErrors).toHaveLength(1)
      expect(hookErrors[0]?.summary).toBe('http hook did not run: its URL is not on the managed allowlist')

      // The whole point of widening the runner: the managed allowlist now
      // GOVERNS on claude and codex, where before it governed nothing because
      // no request was ever made through a gate of ours.
      expect(fetchUrls).toEqual([])
      expect(permissionChecks).toBe(0)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        outcome: 'denied',
        isolationProfile: 'not-started',
        code: 'http-hook-url-not-allowed',
      })
    })
  }
})

// ============================================================
// F1.740 (origin WJ-crit-v, 2026-09-25) · a plugin-hook agent is admitted
// beside the session's other children.
//
// `budgets.fanout`/`concurrency` on a child start are ALSO the PARENT's
// admission backstop: `ChildSessionService.start` refuses when the parent has
// had `fanout` children EVER (finished ones too, judge consults aside) or has
// `concurrency` of them running. The hook runner sent `1`/`1` — the shape
// F1.256 removed from the guardian judge — so in a top-level session a hook
// agent was refused `child-session-fanout-limit` once the session had had ANY
// child, its own previous hook agent included. `hooks.md#how-agent-hooks-work`:
// "When an agent hook fires: 1. Claude Code spawns a subagent with your prompt
// and the hook's JSON input" — every time it fires, not once per session.
//
// The rig drives the REAL runner over the REAL `ChildSessionService`; the port
// is the one the host builds minus its restriction plumbing, which for a
// top-level session (no `piChildBudgets`) passes the budgets through verbatim.
// ============================================================

describe('F1.740 · a plugin-hook agent is admitted beside the session\'s other children', () => {
  const parentSessionKey = { workspaceId: 'workspace-hook', sessionId: 'session-hook' }

  function serviceRig() {
    const service = new ChildSessionService({
      parentSessionKey,
      persist: async () => {},
      disabledByPolicy: () => false,
      runtime: {
        // A background child stays running (it holds a concurrency slot); a
        // foreground one completes at once, leaving a finished record behind.
        start: async record => ({
          childSessionKey: record.childSessionKey,
          transcriptId: `t-${record.agentId}`,
          status: record.background ? 'running' : 'completed',
          result: '{"ok":true}',
        }),
        resume: async () => ({ status: 'completed' }),
        steer: async () => {},
        stop: async () => {},
      },
    })
    const port = {
      start: async (input: any) => service.start(input),
      stop: async (agentId: string) => { await service.stop(agentId) },
    }
    return { service, port }
  }

  /** An Agent-tool subagent with the spawner's own budget shape (`fanout` is `orchestrator.maxAgents`, default 100). */
  function subagentStart(background: boolean, fanout = 100, prompt = 'You are worker.') {
    return {
      agent: 'worker',
      task: 'survey the tree',
      background,
      restrictions: { prompt, model: 'parent-model', tools: ['read'], worktreePolicy: 'shared' as const, thinkingLevel: 'off' as const },
      budgets: { depth: 1, maxDepth: 2, fanout, concurrency: 16, tokenLimit: 100_000, costLimitUsd: 100, deadlineAt: Date.now() + 60_000, ancestry: [] },
    }
  }

  function hookRig(piChildBudgets?: Record<string, unknown>) {
    const { manager, receipts } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => true
    const { agentKey, runtime } = createPinnedAgentCapabilityRuntime({ tools: ['Read', 'Grep'], permissionMode: undefined })
    const { service, port } = serviceRig()
    const managed = {
      id: parentSessionKey.sessionId,
      workspace: { id: parentSessionKey.workspaceId, rootPath: process.cwd() },
      model: 'parent-model',
      ...(piChildBudgets ? { piChildBudgets } : {}),
      piChildSessionPort: port,
    }
    const fire = () => manager.pluginAgentHookRunner(managed, runtime)({ agentName: agentKey, event: 'Stop' })
    return { receipts, service, fire }
  }

  test('a session that already had a subagent admits the hook agent, and the next one after it', async () => {
    const { receipts, service, fire } = hookRig()
    await service.start(subagentStart(false))

    await fire()
    await fire()

    expect(receipts.map(receipt => [receipt.outcome, receipt.code])).toEqual([['success', undefined], ['success', undefined]])
    expect(service.snapshot().children).toHaveLength(3)
  })

  test('a hook agent is admitted while a background subagent is still running', async () => {
    const { receipts, service, fire } = hookRig()
    await service.start(subagentStart(true))
    expect(service.snapshot().children.map(child => child.status)).toEqual(['running'])

    await fire()

    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ semanticId: 'plugin-agent-hook', outcome: 'success', isolationProfile: 'host-child-session' })
    expect(service.snapshot().children).toHaveLength(2)
  })

  test('BOUNDARY — an inherited fanout ceiling still clamps: a child session at its own limit refuses the hook agent', async () => {
    const { receipts, service, fire } = hookRig({
      depth: 1,
      maxDepth: 3,
      fanout: 1,
      concurrency: 4,
      tokenLimit: 100_000,
      costLimitUsd: 100,
      deadlineAt: Date.now() + 60_000,
      ancestry: ['root'],
    })
    await service.start(subagentStart(false))

    await fire()

    expect(receipts).toHaveLength(1)
    // F1.1147 — the refusal is named with the service's own code, not filed as a crash.
    expect(receipts[0]).toMatchObject({
      semanticId: 'plugin-agent-hook',
      outcome: 'denied',
      isolationProfile: 'not-started',
      code: 'child-session-fanout-limit',
    })
    expect(service.snapshot().children).toHaveLength(1)
  })

  test('F1.1147 CONTROL — a child start that fails for any other reason is still an execution error', async () => {
    const { manager, receipts } = createRunnerHarness()
    manager.isPluginHookEffectAllowed = async () => true
    const { agentKey, runtime } = createPinnedAgentCapabilityRuntime({ tools: ['Read', 'Grep'], permissionMode: undefined })
    const managed = {
      id: parentSessionKey.sessionId,
      workspace: { id: parentSessionKey.workspaceId, rootPath: process.cwd() },
      model: 'parent-model',
      piChildSessionPort: { start: async () => { throw new Error('runtime exploded') }, stop: async () => {} },
    }

    await manager.pluginAgentHookRunner(managed, runtime)({ agentName: agentKey, event: 'Stop' })

    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({ outcome: 'error', isolationProfile: 'host-child-session', code: 'execution-error' })
  })

  // F1.1047 (origin DN-217, DECISIONS-2 Q14) · once F1.740 admitted every hook
  // agent, each one left a durable record, and the Agent-tool spawn's `fanout`
  // (`orchestrator.maxAgents`, default 100) counted it: after about a hundred
  // hook fires the MODEL's own subagents were refused. Hook-agent records are
  // now left out of that count like judge consults (`isPluginHookAgentRecord`);
  // a RUNNING one still counts toward `concurrency`. The ceiling here is 3, not
  // 100, so the rig stays cheap — the check compares the same two numbers.
  test('F1.1047 — hook-agent runs do not use up the session\'s subagent limit', async () => {
    const { receipts, service, fire } = hookRig()
    await fire()
    await fire()
    await fire()
    expect(receipts.map(receipt => receipt.outcome)).toEqual(['success', 'success', 'success'])

    await service.start(subagentStart(false, 3))

    expect(service.snapshot().children).toHaveLength(4)
  })

  test('F1.1047 BOUNDARY — the limit still refuses the model\'s own subagent at its ceiling, a look-alike prompt still counts, and a hook agent after it is still admitted', async () => {
    const { receipts, service, fire } = hookRig()
    // A definition whose prompt copies the runner's prefix has no host-minted
    // `plugin-hook-agent-` id, so it is a subagent like any other.
    await service.start(subagentStart(false, 2, 'Plugin hook agent invocation.\n\nYou are worker.'))
    await service.start(subagentStart(false, 2))

    await expect(service.start(subagentStart(false, 2))).rejects.toThrow('child-session-fanout-limit')
    await fire()

    expect(receipts.map(receipt => receipt.outcome)).toEqual(['success'])
    expect(service.snapshot().children).toHaveLength(3)
  })
})
