/**
 * P2.459 — every host-side refusal in `SessionManager.ts` that a readable
 * permission rule produced now NAMES that rule and the scope it came from.
 *
 * P2.445 closed the same defect on Pi and composed the three renderers
 * (`describePermissionDslMatch`, `permissionDslDenyReason`,
 * `permissionDslAskReason`) in `permission-dsl.ts` for exactly this reason: so
 * every host that renders this decision renders the SAME sentence. They were
 * not re-exported from `agent/index.ts`, so this file's own gates could not
 * reach them and still said "Denied by readable permission policy." — a refusal
 * a user cannot act on, since it names neither what refused nor where it came
 * from.
 *
 * WHAT THIS SUITE REFUSES TO DO, because it is what let a P2.445 mutant survive:
 * it never hands a hand-built policy object to the evaluator. Every rule below
 * is a REAL settings document that enters through `parsePermissionsJson` and
 * `claudeSettingsPermissionDsl` — the production producer — and is merged by
 * `permissionsConfigCache.getMergedConfig`. That matters here more than it did
 * there: the id those producers mint is POSITIONAL (`claude-settings-deny-0`),
 * so a test that wrote its own id would silently be asserting a name the user
 * had actually seen, and the whole point is that they have not.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  describePermissionDslMatch,
  permissionDslAskReason,
  permissionDslDenyReason,
  permissionsConfigCache,
} from '@nessy-agent/shared/agent'
import { computeNormalizedBundleHash } from '@nessy-agent/shared/plugins/bundle-hash'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { materializePiRuntimeAgentDefinitions } from '@nessy-agent/shared/agent/pi-harness/runtime-agent-definition'
import type { StoredConfig } from '@nessy-agent/shared/config/storage'
import { MODULE_GRAPH_HOOK_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'

const stateRoot = mkdtempSync(join(tmpdir(), 'sm-refusal-names-rule-'))
const workspaceRoot = join(stateRoot, 'workspace')
mkdirSync(workspaceRoot, { recursive: true })
const WORKSPACE_ID = 'ws-refusal-names-rule'
writeFileSync(
  join(workspaceRoot, 'config.json'),
  JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Refusal Names Rule Workspace',
    slug: 'refusal-names-rule-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, null, 2),
  'utf-8',
)

/**
 * The rule strings below are MATCHER data and are never executed. A permission
 * row is the one place the adversarial spelling is the one that matters — a
 * refusal naming `Read(~/.ssh/**)` is the refusal a user needs to see — so the
 * matchers name a home while every command this suite feeds is a harmless
 * repo-relative line inside the temp workspace above.
 */
const DENY_RULE = 'Bash(rm:*)'
const ASK_RULE = 'Bash(npm test:*)'

type SessionManagerModule = typeof import('../SessionManager.ts')
let SessionManagerCtor: SessionManagerModule['SessionManager']
let createManagedSessionFn: SessionManagerModule['createManagedSession']
let createTestSessionManagerFn: typeof import('./test-session-manager.ts')['createTestSessionManager']
let restoreConfig: () => void = () => {}

const TEST_CONNECTIONS = [
  {
    slug: 'claude-gateway',
    name: 'Claude Code (Nessy Gateway)',
    providerType: 'claude-runtime',
    authType: 'bearer_token',
    defaultModel: 'claude-gw-model-a',
    createdAt: Date.now(),
  },
] as unknown as NonNullable<StoredConfig['llmConnections']>

beforeAll(async () => {
  const mod = await import('../SessionManager.ts')
  SessionManagerCtor = mod.SessionManager
  createManagedSessionFn = mod.createManagedSession
  ;({ createTestSessionManager: createTestSessionManagerFn } = await import('./test-session-manager.ts'))

  const storage = await import('@nessy-agent/shared/config/storage')
  const configPath = storage.getConfigPath()
  const previous = existsSync(configPath) ? storage.loadStoredConfig() : null
  const base: StoredConfig = previous ?? ({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  } as unknown as StoredConfig)
  storage.saveConfig({ ...base, defaultLlmConnection: 'claude-gateway', llmConnections: TEST_CONNECTIONS })
  restoreConfig = () => {
    if (previous) storage.saveConfig(previous)
    else if (existsSync(configPath)) rmSync(configPath)
  }
}, MODULE_GRAPH_HOOK_BUDGET_MS)

afterAll(() => {
  restoreConfig()
  rmSync(stateRoot, { recursive: true, force: true })
})

afterEach(() => {
  permissionsConfigCache.clear()
})

/**
 * One capability permission LAYER holding a real Claude settings document.
 *
 * This is the production route for the rule text: `setCapabilityPermissionLayers`
 * hands the content to `parsePermissionsJson`, which recognizes the top-level
 * `permissions` block and compiles it with `claudeSettingsPermissionDsl`. That
 * producer is the one that mints `claude-settings-<action>-<index>` and carries
 * `text: entry` beside it, so the id the refusal falls back to and the string it
 * prefers are BOTH the production values.
 */
function settingsLayer(
  scope: 'builtin' | 'global' | 'workspace' | 'project',
  permissions: Record<string, string[]>,
) {
  const content = JSON.stringify({ permissions })
  return {
    scope,
    resource: { contentHash: `hash-${scope}-${content.length}`, pluginInstanceId: 'plugin://fixture@1.0.0#p2459' },
    content,
  }
}

/** An author-written `permissionDsl` layer — the shape that carries no `text`. */
function dslLayer(
  scope: 'builtin' | 'global' | 'workspace' | 'project',
  rules: Array<{ id: string; action: 'allow' | 'ask' | 'deny'; match: unknown }>,
) {
  return rawLayer(scope, JSON.stringify({ permissionDsl: { version: 1, rules } }))
}

/** A layer whose content is written verbatim, for the malformed-document row. */
function rawLayer(scope: 'builtin' | 'global' | 'workspace' | 'project', content: string) {
  return {
    scope,
    resource: { contentHash: `hash-${scope}-raw-${content.length}`, pluginInstanceId: 'plugin://fixture@1.0.0#p2459' },
    content,
  }
}

function capabilityRuntime(layers: ReturnType<typeof settingsLayer>[]) {
  const byHash = new Map(layers.map(layer => [layer.resource.contentHash, layer.content]))
  return {
    projectTrustState: 'trusted' as const,
    view: {
      generation: 'gen-p2459',
      skills: [],
      permissionLayers: layers.map(({ scope, resource }) => ({ scope, resource })),
    },
    materializer: {
      assertActive() {},
      async verifyPlugin() {},
      async readText(resource: { contentHash: string }) {
        const content = byHash.get(resource.contentHash)
        if (content === undefined) throw new Error('unknown permission layer')
        return content
      },
    },
  }
}

let sessionCounter = 0

function managedSession() {
  const workspace = {
    id: WORKSPACE_ID,
    name: 'Refusal Names Rule Workspace',
    slug: 'refusal-names-rule-workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const id = `session-refusal-names-${++sessionCounter}`
  return createManagedSessionFn(
    { id, name: id, llmConnection: 'claude-gateway' },
    workspace as never,
    { messagesLoaded: true, ephemeral: true },
  ) as unknown as Record<string, unknown> & { id: string; workspace: { id: string } }
}

/**
 * Drive `pluginCommandHookRunner`'s gate and capture the DECISION it rendered.
 *
 * The permission SERVICE is stubbed and nothing else is: the transport that
 * carries the sentence to a card is not what this row changed, while the
 * evaluator, the producer, the merge and the renderers are all production. The
 * stub answers `deny` so the runner returns its `deniedResult`, which is how the
 * deny sentence is also asserted at the boundary the hook author actually reads.
 */
async function runCommandHook(options: {
  layers: ReturnType<typeof settingsLayer>[]
  command: string
}): Promise<{ decision: Record<string, any>; error: string }> {
  const manager = Object.create(SessionManagerCtor.prototype) as any
  const managed = managedSession()
  managed.permissionMode = 'bypassPermissions'
  manager.resolveManagedProvider = () => 'claude-runtime'
  manager.piGoalReceiptReference = () => undefined
  manager.appendPiExecutionReceipt = () => undefined
  manager.sessionAdditionalDirectories = () => []
  let decision: Record<string, any> | undefined
  manager.createTelemetryPiPermissionService = () => ({
    authorize: async (args: { decision: Record<string, any> }) => {
      decision = args.decision
      return { outcome: 'deny', decisionId: 'decision-p2459', reason: args.decision.reason }
    },
  })
  const runner = manager.pluginCommandHookRunner(managed, capabilityRuntime(options.layers))
  const result = await runner(
    { command: options.command },
    { event: 'PreToolUse', input: { hook_event_name: 'PreToolUse' }, cwd: workspaceRoot },
  )
  if (!decision) throw new Error('the gate never reached the permission service')
  return { decision, error: String(result.error ?? '') }
}

describe('the three renderers are reachable from the agent barrel', () => {
  it('exports all three, which is the one import the four gates were missing', () => {
    expect(typeof describePermissionDslMatch).toBe('function')
    expect(typeof permissionDslDenyReason).toBe('function')
    expect(typeof permissionDslAskReason).toBe('function')
  })
})

describe('the command hook gate names the rule and the scope', () => {
  it('renders the author’s own rule string, not the positional id the producer minted', async () => {
    const { decision, error } = await runCommandHook({
      layers: [settingsLayer('project', { deny: [DENY_RULE] })],
      command: 'rm -rf ./build',
    })

    expect(decision.outcome).toBe('deny')
    expect(decision.reason).toBe(`Denied by readable permission policy rule \`${DENY_RULE}\` (project scope).`)
    // The boundary a hook author actually reads.
    expect(error).toContain(`rule \`${DENY_RULE}\` (project scope)`)
    // The detector for the whole row: the id IS what the producer minted, and it
    // is what the sentence used to carry. Naming it would be naming nothing.
    expect(decision.reason).not.toContain('claude-settings-deny-0')
  })

  it('names the rule in BOTH halves of an ask — the reason and the card the user answers', async () => {
    const { decision } = await runCommandHook({
      layers: [settingsLayer('workspace', { ask: [ASK_RULE] })],
      command: 'npm test --silent',
    })

    expect(decision.outcome).toBe('ask')
    expect(decision.reason).toBe(`Readable permission policy rule \`${ASK_RULE}\` (workspace scope) requires approval.`)
    expect(decision.request.description).toBe(
      `Command hook requires approval by readable permission policy rule \`${ASK_RULE}\` (workspace scope).`,
    )
  })

  it('names nothing when no rule matched, so a refusal is never credited to a rule that did not make it', async () => {
    const { decision } = await runCommandHook({
      layers: [settingsLayer('project', { deny: [DENY_RULE] })],
      command: 'echo ok',
    })

    expect(decision.outcome).toBe('allow')
    expect(decision.reason).toBeUndefined()
  })

  it('falls back to the id for a rule that carries no text, rather than naming nothing', async () => {
    // An author-written `permissionDsl` document, which is the one shape where
    // the id IS what a human wrote and no `text` rides beside it. The fallback
    // is the reason `ruleTextOf` is allowed to be absent at all.
    const { decision } = await runCommandHook({
      layers: [dslLayer('global', [{ id: 'no-rm', action: 'deny', match: { kind: 'bash', pattern: 'rm:*' } }])],
      command: 'rm -rf ./build',
    })

    expect(decision.reason).toBe('Denied by readable permission policy rule `no-rm` (global scope).')
  })

  it('lets the compiler diagnostic keep the sentence, because it says more than any rule name can', async () => {
    // F1.831 — only a broken MANAGED (`builtin`) document still refuses every call;
    // a broken project document is dropped whole (the arm below).
    const { decision } = await runCommandHook({
      layers: [rawLayer('builtin', '{"permissionDsl":{"version":1,"rules":"not-an-array"}}')],
      command: 'rm -rf ./build',
    })

    expect(decision.outcome).toBe('deny')
    expect(decision.reason).toBe('Permission DSL document is invalid.')
    expect(decision.reason).not.toContain('rule `')
  })

  it('F1.831 — a broken PROJECT document is dropped whole: it refuses nothing, and a co-resident deny still names itself', async () => {
    const broken = rawLayer('project', '{"permissionDsl":{"version":1,"rules":"not-an-array"}}')
    expect((await runCommandHook({ layers: [broken], command: 'rm -rf ./build' })).decision.outcome).toBe('allow')
    const { decision } = await runCommandHook({
      layers: [broken, dslLayer('global', [{ id: 'no-rm', action: 'deny', match: { kind: 'bash', pattern: 'rm:*' } }])],
      command: 'rm -rf ./build',
    })
    expect(decision.reason).toBe('Denied by readable permission policy rule `no-rm` (global scope).')
  })
})

/**
 * The FIFTH gate, and the one the row did not list because it already named
 * something: `evaluateMonitorCommandRules` rendered `matched.ruleId`. P2.445
 * measured that every id reaching the merged program is positional and
 * internal, so on a settings-derived rule that sentence named a handle the user
 * has never seen — the same defect wearing the opposite disguise.
 *
 * This gate is driven through `authorizeMonitor`, the real entry point, with the
 * rules on DISK in the workspace `permissions.json` the production merge reads.
 */
describe('the monitor command gate names the rule the user wrote, not the id the producer minted', () => {
  function monitorHarness() {
    const manager = createTestSessionManagerFn()
    const internals = manager as unknown as {
      sessions: Map<string, unknown>
      authorizeMonitor(request: unknown): Promise<void>
      sendEvent(event: unknown, workspaceId: string): void
      persistSession(managed: unknown): void
    }
    const managed = managedSession()
    internals.sessions.set(`${WORKSPACE_ID}:${managed.id}`, managed)
    internals.sendEvent = () => undefined
    internals.persistSession = () => undefined
    return {
      authorize: (command: string) => internals.authorizeMonitor({
        sessionKey: { workspaceId: WORKSPACE_ID, sessionId: managed.id },
        cwd: workspaceRoot,
        workspaceRoot,
        description: 'watch the log',
        timeoutMs: 300_000,
        persistent: false,
        command,
      }),
    }
  }

  function setWorkspaceFile(json: unknown): void {
    writeFileSync(join(workspaceRoot, 'permissions.json'), JSON.stringify(json), 'utf-8')
    permissionsConfigCache.clear()
  }

  afterEach(() => {
    rmSync(join(workspaceRoot, 'permissions.json'), { force: true })
    permissionsConfigCache.clear()
  })

  it('refuses a watch naming the settings entry and its scope', async () => {
    setWorkspaceFile({ permissions: { deny: ['Bash(tail:*)'] } })
    const h = monitorHarness()

    let thrown: Error | undefined
    try {
      await h.authorize('tail -f ./app.log')
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown).toBeDefined()
    expect(thrown!.message).toBe(
      'Monitor command watch was denied by permission rule `Bash(tail:*)` (workspace scope).',
    )
    expect(thrown!.message).not.toContain('claude-settings-deny-0')
  })

  it('still reads the id when that is what the author wrote', async () => {
    setWorkspaceFile({ permissionDsl: { version: 1, rules: [{ id: 'no-tail', action: 'deny', match: { kind: 'bash', pattern: 'tail:*' } }] } })
    const h = monitorHarness()

    await expect(h.authorize('tail -f ./app.log')).rejects.toThrow(
      'Monitor command watch was denied by permission rule `no-tail` (workspace scope).',
    )
  })

  // F1.992 (origin DN-006) — the one matched deny that carries a diagnostic is F1.863's unparseable-command refusal,
  // and that sentence already names the rule, so the gate's own `<rule>: <diagnostic>` named it twice.
  it('F1.992 — an unparseable command under a deny-every-program rule names the rule ONCE, with the reason', async () => {
    setWorkspaceFile({ permissionDsl: { version: 1, rules: [{ id: 'deny-any-program', action: 'deny', match: { kind: 'bash', executable: '*' } }] } })
    const h = monitorHarness()

    await expect(h.authorize('echo a; echo b')).rejects.toThrow(
      'Monitor command watch was denied by permission rule `deny-any-program` (workspace scope): the shell command '
        + 'contains unsafe or unsupported syntax, so the rule cannot tell whether it runs a program it denies.',
    )
  })

  it('F1.992 BOUNDARY — a parseable command under the same rule keeps the bare-match sentence', async () => {
    setWorkspaceFile({ permissionDsl: { version: 1, rules: [{ id: 'deny-any-program', action: 'deny', match: { kind: 'bash', executable: '*' } }] } })
    const h = monitorHarness()

    await expect(h.authorize('tail -f ./app.log')).rejects.toThrow(
      /^Monitor command watch was denied by permission rule `deny-any-program` \(workspace scope\)\.$/,
    )
  })
})

/**
 * The agent-admission gate. Its two sentences keep their `Agent`/`agent`
 * wording, so they are composed from `describePermissionDslMatch` rather than
 * from `permissionDslDenyReason` — which is exactly the shape P2.445 used for
 * its own tool-name variant in `pi-agent.ts`, and exactly why both halves need
 * their own row here: a describer that returned the wrong thing would be
 * invisible to a test that only checked the Bash sentences.
 *
 * `Agent(reviewer)` was MEASURED to be a settings entry this gate matches
 * (`subagent(reviewer)`, `Task(reviewer)` and `subagent:*` all compile to
 * nothing), so the rule below arrives through the same production producer as
 * every other rule in this file.
 */
describe('the agent admission gate names the rule and the scope', () => {
  const AGENT_FILE = [
    '---',
    'name: reviewer',
    'description: A file-authored reviewer.',
    '---',
    '',
    'Review the repository and report.',
    '',
  ].join('\n')

  async function admit(options: {
    permissions: Record<string, string[]>
  }): Promise<Record<string, any>> {
    const manager = createTestSessionManagerFn()
    const manageAny = manager as never as Record<string, any>
    const parent = {
      id: `parent-${++sessionCounter}`,
      workspace: { id: WORKSPACE_ID, rootPath: workspaceRoot },
      permissionMode: 'bypassPermissions',
      thinkingLevel: 'off',
      llmConnection: 'claude-gateway',
      childSessionState: undefined,
      messagesLoaded: true,
      messages: [],
      backgroundShellCommands: new Map(),
    } as never as { id: string }
    ;(manager as never as { sessions: Map<string, unknown> }).sessions
      .set(encodeSessionKey({ workspaceId: WORKSPACE_ID, sessionId: parent.id }), parent)
    manageAny.persistSession = () => {}

    const layer = settingsLayer('project', options.permissions)
    const view = {
      generation: 'gen-p2459-agent', sources: [], hooks: [], automations: [], promptLayers: [],
      memory: [], commands: [], promptCommands: [], apps: [], skills: [], mcpServers: [],
      permissionLayers: [{ scope: layer.scope, resource: layer.resource }],
      agents: [{
        key: 'agent://project/reviewer', name: 'reviewer',
        description: 'A file-authored reviewer.',
        selectedAsUnqualifiedAlias: true,
        instructionsResource: {
          source: 'project', scope: { kind: 'project' }, resourceId: 'reviewer',
          absolutePath: join(workspaceRoot, 'reviewer.md'), revision: '1', contentHash: 'b'.repeat(64),
        },
      }],
    } as never
    const materializer = {
      assertActive() {},
      async verifyPlugin() {},
      readText: async (resource: { contentHash: string }) =>
        resource.contentHash === layer.resource.contentHash ? layer.content : AGENT_FILE,
    } as never
    const [definition] = await materializePiRuntimeAgentDefinitions({ view, materializer })
    expect(definition?.key).toBe('agent://project/reviewer')

    let decision: Record<string, any> | undefined
    const permissionService = {
      authorize: async (args: { decision: Record<string, any> }) => {
        decision = args.decision
        throw new Error('admission-stopped-after-decision')
      },
    }
    const port = await (manageAny.createPiChildSessionPort as (...args: unknown[]) => Promise<{
      start: (input: unknown) => Promise<unknown>
    }>).call(
      manager, parent, { view, materializer, projectTrustState: 'trusted' }, permissionService,
      async () => {}, async () => {}, async () => {},
    )
    await port.start({
      requestedAgentId: `agent-${sessionCounter}`, agent: 'reviewer', task: 'review', background: false,
      restrictions: {
        prompt: `Safety core.\n\n${definition!.systemPrompt}`,
        model: 'session-model',
        worktreePolicy: 'isolated-worktree', thinkingLevel: 'off',
        capabilityGeneration: 'gen-p2459-agent',
        definitionKey: definition!.key,
        definitionDigest: definition!.definitionDigest,
      },
      budgets: {
        depth: 1, maxDepth: 2, fanout: 2, concurrency: 1, tokenLimit: 100,
        costLimitUsd: 1, deadlineAt: Date.now() + 10_000, ancestry: [],
      },
    }).catch(() => undefined)
    if (!decision) throw new Error('the admission gate never reached the permission service')
    return decision
  }

  it('refuses a subagent naming the settings entry and its scope', async () => {
    const decision = await admit({ permissions: { deny: ['Agent(reviewer)'] } })

    expect(decision.outcome).toBe('deny')
    expect(decision.reason).toBe('Agent denied by readable permission policy rule `Agent(reviewer)` (project scope).')
    expect(decision.reason).not.toContain('claude-settings-deny-0')
  })

  it('asks naming the settings entry and its scope', async () => {
    const decision = await admit({ permissions: { ask: ['Agent(reviewer)'] } })

    expect(decision.outcome).toBe('ask')
    expect(decision.reason).toBe('Readable permission policy rule `Agent(reviewer)` (project scope) requires agent approval.')
  })
})

/**
 * The skill-context gate — the `!` line in a selected plugin skill.
 *
 * Its DENY sentence was the odd one out before this row: it said "Denied by
 * permission policy." while the other four said "readable permission policy",
 * so a user comparing two refusals had no way to tell they came from the same
 * mechanism. It is unified here, which is the host's job when three runtimes
 * each answer the same question their own way.
 *
 * Its CARD was worse than unnamed. The reason said the readable policy asked
 * while the description the user actually answered said only "Skill context
 * command requires approval." — so the one sentence on the approval dialog
 * named neither the rule nor the mechanism.
 */
describe('the skill-context gate names the rule and the scope', () => {
  async function runSkillContext(options: {
    permissions?: Record<string, string[]>
    rawLayerContent?: string
    command: string
  }): Promise<Record<string, any>> {
    const bundleRoot = mkdtempSync(join(stateRoot, 'skill-bundle-'))
    writeFileSync(join(bundleRoot, 'plugin.json'), JSON.stringify({ name: 'fixture' }), 'utf-8')
    const bundleHash = await computeNormalizedBundleHash(bundleRoot)

    const layer = options.rawLayerContent === undefined
      ? settingsLayer('workspace', options.permissions!)
      : rawLayer('workspace', options.rawLayerContent)
    const skill = {
      key: 'skill://fixture/context',
      pluginRuntime: { rootPath: bundleRoot, bundleHash },
      resource: { pluginInstanceId: 'plugin://fixture@1.0.0#p2459', contentHash: 'c'.repeat(64) },
    }
    const runtime = {
      projectTrustState: 'trusted' as const,
      view: {
        generation: 'gen-p2459-skill',
        skills: [skill],
        permissionLayers: [{ scope: layer.scope, resource: layer.resource }],
      },
      materializer: {
        assertActive() {},
        async verifyPlugin() {},
        async readText(resource: { contentHash: string }) {
          if (resource.contentHash !== layer.resource.contentHash) throw new Error('unknown permission layer')
          return layer.content
        },
      },
    }

    const manager = Object.create(SessionManagerCtor.prototype) as any
    const managed = managedSession()
    managed.permissionMode = 'bypassPermissions'
    managed.isProcessing = true
    managed.stopRequested = false
    managed.capabilityRuntime = runtime
    manager.resolveManagedProvider = () => 'pi'
    manager.piGoalReceiptReference = () => undefined
    manager.appendPiExecutionReceipt = () => undefined
    manager.sessionAdditionalDirectories = () => []
    let decision: Record<string, any> | undefined
    manager.createTelemetryPiPermissionService = () => ({
      authorize: async (args: { decision: Record<string, any> }) => {
        decision = args.decision
        throw new Error('skill-context-stopped-after-decision')
      },
    })

    const executor = manager.runtimeSkillContextExecutor(managed, runtime)
    await executor({
      skillKey: skill.key,
      command: options.command,
      cwd: workspaceRoot,
      generation: runtime.view.generation,
      resourceHash: skill.resource.contentHash,
      timeoutMs: 5_000,
    }, new AbortController().signal).catch(() => undefined)
    if (!decision) throw new Error('the skill-context gate never reached the permission service')
    return decision
  }

  it('refuses with the SAME sentence the other four gates render, naming the entry and its scope', async () => {
    const decision = await runSkillContext({
      permissions: { deny: [DENY_RULE] },
      command: 'rm -rf ./build',
    })

    expect(decision.outcome).toBe('deny')
    expect(decision.reason).toBe(`Denied by readable permission policy rule \`${DENY_RULE}\` (workspace scope).`)
  })

  it('names the rule on the CARD as well as in the reason', async () => {
    const decision = await runSkillContext({
      permissions: { ask: [ASK_RULE] },
      command: 'npm test --silent',
    })

    expect(decision.outcome).toBe('ask')
    expect(decision.reason).toBe(`Readable permission policy rule \`${ASK_RULE}\` (workspace scope) requires approval.`)
    expect(decision.request.description).toBe(
      `Skill context command requires approval by readable permission policy rule \`${ASK_RULE}\` (workspace scope).`,
    )
  })
})
