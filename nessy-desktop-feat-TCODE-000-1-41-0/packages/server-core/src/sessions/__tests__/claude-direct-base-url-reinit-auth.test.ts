/**
 * F1.963 — A CONNECTION SAVE MUST NOT MOVE A LIVE DIRECT-ANTHROPIC CLAUDE
 * SESSION ONTO ANOTHER CONNECTION'S ENDPOINT.
 *
 * ## The question (origin WJ-crit-rrr P-1, read from the code, unmeasured)
 *
 * `SessionManager.reinitializeAuth` runs at `initialize()` and on three RPCs —
 * SETUP of any connection (with that connection's slug), SAVE of the default
 * connection and SET_DEFAULT — and it wrote the resolved auth of THAT connection
 * (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`) into
 * the process-global `process.env`. Since F1.958 a direct claude session's own
 * `envOverrides` mask the key and the OAuth token, but a connection with NO base
 * URL leaves `ANTHROPIC_BASE_URL` to `process.env` — and `postInit` deleted it
 * there only at agent creation. So: after such a save, does that session's next
 * turn respawn with its own key pointed at the saved connection's endpoint? And
 * does every other child that spreads `process.env` (Pi's builder is read here;
 * codex's app-server spawn spreads it the same way) inherit the saved
 * connection's key?
 *
 * ## The instrument
 *
 * A real `ClaudeAgent` on a direct connection C (no base URL) and the REAL
 * `SessionManager.reinitializeAuth` for a direct connection D that has one; keys
 * FABRICATED — no value in this file is a real credential. The connection store
 * and the credential manager are the only storage stand-ins (spread and restored
 * from snapshots, AGENTS.md §Traps); `postInit`, `resolveAuthEnvVars` and
 * `resetManagedAnthropicAuthEnvVars` are production code. The session's turns
 * are real `chatImpl` turns with the SDK `query` the only double (F1.953's and
 * F1.958's rig), so the `options.env` each fake child receives is what a real
 * child would receive.
 *
 * ## The launch environment is a separate leg, and it is why one describe skips
 *
 * `resetManagedAnthropicAuthEnvVars` restores the LAUNCH value of every managed
 * name, and `postInit` deleted `ANTHROPIC_BASE_URL` at agent creation — so a
 * host launched with that name exported puts it back under a live session on
 * every save, whatever the connection says. That is F1.963's launch leg, a row
 * of its own; the no-drift describe below is only meaningful when the launch
 * environment carries no such name, and it says so by skipping rather than by a
 * conditional expect. The always-on describe asserts the launch-independent
 * half: no child and no host env ever carries D's key or D's endpoint.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as claudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent } from '@nessy-agent/core/types'
import * as configBarrel from '@nessy-agent/shared/config'
import * as configStorage from '@nessy-agent/shared/config/storage'
import type { LlmConnection } from '@nessy-agent/shared/config/storage'
import * as credentialsIndex from '@nessy-agent/shared/credentials'
import { buildPiSubprocessEnv } from '@nessy-agent/shared/agent/pi-agent'
import { enableDebug } from '@nessy-agent/shared/utils/debug'
import { createTestSessionManager } from './test-session-manager.ts'

/** SNAPSHOTS of each module's exports, never the live namespace (AGENTS.md §Traps, the `mock.module` bullet). */
const realSdk = { ...claudeAgentSdk }
const realQuery = realSdk.query
const realBarrel = { ...configBarrel }
const realStorage = { ...configStorage }
const realCredentials = { ...credentialsIndex }

/** Read before any agent exists: what the reset restores `ANTHROPIC_BASE_URL` to. */
const LAUNCH_BASE_URL_SET = { ...process.env }.ANTHROPIC_BASE_URL !== undefined

const MODEL = 'claude-sonnet-4-5'
/** Fabricated. Never a real key. */
const KEY_C = 'sk-ant-f1963-FABRICATED-C-0000'
const KEY_C_ROTATED = 'sk-ant-f1963-FABRICATED-C-ROTATED-0000'
const KEY_D = 'sk-ant-f1963-FABRICATED-D-0000'
/** D's own endpoint — C has none, so C's child must never carry this one. */
const BASE_URL_D = 'https://f1963-d.example.invalid'

const connections = new Map<string, LlmConnection>()
const apiKeys = new Map<string, string>()
let defaultSlug: string | null = null

const storageOverrides = {
  getLlmConnection: (slug: string) => connections.get(slug) ?? realStorage.getLlmConnection(slug),
  getDefaultLlmConnection: () => defaultSlug,
}
mock.module('@nessy-agent/shared/config/storage', () => ({ ...realStorage, ...storageOverrides }))
// `SessionManager` imports both names through the barrel; `ClaudeAgent` through the file.
mock.module('@nessy-agent/shared/config', () => ({ ...realBarrel, ...storageOverrides }))
mock.module('@nessy-agent/shared/credentials', () => ({
  ...realCredentials,
  getCredentialManager: () => ({ getLlmApiKey: async (slug: string) => apiKeys.get(slug) ?? null }),
}))

interface FakeChild {
  prompts: number
  options: Record<string, unknown>
  aborted: boolean
}

const children: FakeChild[] = []

function assistantMessage(text: string): unknown {
  return {
    type: 'assistant', session_id: 'fake-f1963-session',
    message: {
      id: `msg-${text}-${Math.random()}`, role: 'assistant', model: MODEL,
      content: [{ type: 'text', text }], stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }
}

function resultMessage(): unknown {
  return {
    type: 'result', subtype: 'success', result: 'ok', is_error: false, num_turns: 1,
    total_cost_usd: 0, session_id: 'fake-f1963-session', stop_reason: null, modelUsage: {},
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
}

/** Armed only while this file's own tests run: the last `mock.module` for a specifier is live for other files too. */
let rigArmed = false

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    if (!rigArmed) return (realQuery as unknown as (arg: unknown) => unknown)(input)
    const child: FakeChild = { prompts: 0, options: input.options, aborted: false }
    children.push(child)
    const abortController = input.options.abortController as AbortController | undefined
    abortController?.signal.addEventListener('abort', () => { child.aborted = true }, { once: true })
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        child.prompts += 1
        yield assistantMessage('ok')
        yield resultMessage()
      }
    }
    const stream = serveTurns() as AsyncGenerator<unknown> & Record<string, unknown>
    stream.interrupt = async () => ({ still_queued: [] })
    stream.setModel = async () => {}
    stream.setPermissionMode = async () => {}
    stream.setMcpServers = async () => ({ added: [], removed: [], errors: {} })
    stream.supportedModels = async () => []
    return stream
  },
}))

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk)
  mock.module('@nessy-agent/shared/config/storage', () => realStorage)
  mock.module('@nessy-agent/shared/config', () => realBarrel)
  mock.module('@nessy-agent/shared/credentials', () => realCredentials)
})

const { ClaudeAgent } = await import('@nessy-agent/shared/agent/claude-agent')

// A server-core module graph plus real `chatImpl` turns: the budget belongs to the file.
setDefaultTimeout(120_000)

/** Every managed name `postInit` or `reinitializeAuth` deletes or writes, restored delete-then-assign (the Bun env-slot rule). */
const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const
let savedEnv: Record<string, string | undefined> = {}
const agents: Array<{ destroy(): void }> = []
const cleanups: Array<() => void> = []
const roots: string[] = []
let workspaceRoot = ''

beforeEach(() => {
  rigArmed = true
  workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-f1963-'))
  mkdirSync(join(workspaceRoot, 'sessions'), { recursive: true })
  roots.push(workspaceRoot)
  children.length = 0
  enableDebug()
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  connections.clear()
  apiKeys.clear()
  connections.set('f1963-direct-c', {
    slug: 'f1963-direct-c', name: 'Direct C', providerType: 'anthropic', authType: 'api_key',
    defaultModel: MODEL, createdAt: 1,
  } as LlmConnection)
  connections.set('f1963-direct-d', {
    slug: 'f1963-direct-d', name: 'Direct D', providerType: 'anthropic', authType: 'api_key_with_endpoint',
    baseUrl: BASE_URL_D, defaultModel: MODEL, createdAt: 1,
  } as LlmConnection)
  apiKeys.set('f1963-direct-c', KEY_C)
  apiKeys.set('f1963-direct-d', KEY_D)
  defaultSlug = 'f1963-direct-d'
})

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy()
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    delete process.env[key]
    const value = savedEnv[key]
    if (value !== undefined) process.env[key] = value
  }
  rigArmed = false
})

type Agent = InstanceType<typeof ClaudeAgent>

/** A direct-Anthropic claude agent on C, with the overrides the host builds for it (F1.958's `directAgent`). */
function directAgentOnC(sessionId: string): Agent {
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    connectionSlug: 'f1963-direct-c',
    model: MODEL,
    miniModel: 'claude-haiku-c',
    isHeadless: true,
    skipConfigWatcher: true,
    envOverrides: {
      NESSY_WORKSPACE_ID: 'ws-f1963',
      NESSY_SESSION_ID: sessionId,
      NESSY_SESSION_DIR: join(workspaceRoot, 'sessions', sessionId),
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-c',
    },
    workspace: {
      id: 'ws-f1963', name: 'F1.963', rootPath: workspaceRoot,
      workspaceRootPath: workspaceRoot, sessionRootPath: join(workspaceRoot, 'sessions'),
    },
    session: {
      id: sessionId, createdAt: Date.now(), lastUsedAt: Date.now(),
      workingDirectory: workspaceRoot, sdkCwd: workspaceRoot,
    },
  } as never) as Agent
  agent.setPermissionMode('default')
  agent.setThinkingLevel('low')
  agents.push(agent)
  return agent
}

/** The REAL `SessionManager.reinitializeAuth`, as the three connection RPCs call it. */
async function reinitializeAuth(slug?: string): Promise<void> {
  const manager = createTestSessionManager()
  cleanups.push(() => (manager as unknown as { cleanup(): void }).cleanup())
  await manager.reinitializeAuth(slug)
}

async function postInit(agent: Agent): Promise<void> {
  const result = await agent.postInit()
  expect(result.authInjected).toBe(true)
}

async function runTurn(agent: Agent, message: string): Promise<{ events: AgentEvent[]; log: string[] }> {
  const chatImpl = (agent as unknown as { chatImpl(message: string): AsyncGenerator<AgentEvent> }).chatImpl.bind(agent)
  const events: AgentEvent[] = []
  const log: string[] = []
  const realWrite = process.stderr.write.bind(process.stderr)
  ;(process.stderr as { write: unknown }).write = (chunk: unknown) => {
    log.push(String(chunk))
    return true
  }
  try {
    for await (const event of chatImpl(message)) events.push(event)
  } finally {
    ;(process.stderr as { write: unknown }).write = realWrite
  }
  return { events, log }
}

const driftLines = (log: string[]): string[] => log.filter(line => line.includes('Live session options drifted'))
const childEnv = (child: FakeChild | undefined): Record<string, unknown> =>
  (child?.options.env as Record<string, unknown> | undefined) ?? {}
/** Which fabricated key a child carries, by NAME — nothing here ever prints a value. */
const keyOf = (env: Record<string, unknown>): string => {
  const value = env.ANTHROPIC_API_KEY
  if (value === KEY_C) return 'C'
  if (value === KEY_C_ROTATED) return 'C-rotated'
  if (value === KEY_D) return 'D'
  return value === undefined ? 'none' : 'other'
}
/** Whether an env points at D's endpoint — a boolean, so a red names the fact and not a URL. */
const onD = (env: Record<string, unknown>): boolean => env.ANTHROPIC_BASE_URL === BASE_URL_D

describe('F1.963 — after reinitializeAuth for connection D (with a base URL), nothing carries D\'s key or D\'s endpoint', () => {
  it('THE CLAIM (SAVE / SET_DEFAULT: the default is D): session C\'s children never point at D, and always carry C\'s key', async () => {
    const agentC = directAgentOnC('session-c')
    await postInit(agentC)
    await runTurn(agentC, 'turn one')
    expect(children.map(child => keyOf(childEnv(child)))).toEqual(['C'])

    await reinitializeAuth()
    await runTurn(agentC, 'turn two')

    expect(children.map(child => onD(childEnv(child)))).toEqual(children.map(() => false))
    expect(children.map(child => keyOf(childEnv(child)))).toEqual(children.map(() => 'C'))
  })

  it('THE CLAIM (SETUP: reinitializeAuth with D\'s slug while the default is C): the same', async () => {
    defaultSlug = 'f1963-direct-c'
    const agentC = directAgentOnC('session-c')
    await postInit(agentC)
    await runTurn(agentC, 'turn one')

    await reinitializeAuth('f1963-direct-d')
    await runTurn(agentC, 'turn two')

    expect(children.map(child => onD(childEnv(child)))).toEqual(children.map(() => false))
    expect(children.map(child => keyOf(childEnv(child)))).toEqual(children.map(() => 'C'))
  })

  it('THE CLAIM, other runtimes: the host env — which Pi\'s builder and codex\'s spawn spread — carries neither D\'s key nor D\'s endpoint', async () => {
    await reinitializeAuth()

    expect(keyOf({ ...process.env })).not.toBe('D')
    expect(onD({ ...process.env })).toBe(false)
    const piEnv = buildPiSubprocessEnv({
      processEnv: process.env, proxyEnv: {}, awsEnv: {}, sessionId: 'session-pi', debug: false,
    }) as Record<string, unknown>
    expect(keyOf(piEnv)).not.toBe('D')
    expect(onD(piEnv)).toBe(false)
  })

  it('CONTROL: an `environment` connection still reads the ENVIRONMENT after a save — never the saved connection\'s key', async () => {
    const launchKey = { ...process.env }.ANTHROPIC_API_KEY
    await reinitializeAuth()
    // What `drivers/anthropic.ts`'s `environment` branch reads: the launch value, restored by the reset.
    expect({ ...process.env }.ANTHROPIC_API_KEY === launchKey).toBe(true)
  })
})

describe.skipIf(LAUNCH_BASE_URL_SET)('F1.963 — session C\'s live child across a save (launch env without ANTHROPIC_BASE_URL)', () => {
  it('CONTROL: no save — C reuses its child, with C\'s key and no endpoint (the rig moves nothing)', async () => {
    const agentC = directAgentOnC('session-c')
    await postInit(agentC)
    await runTurn(agentC, 'turn one')
    const second = await runTurn(agentC, 'turn two')

    expect(driftLines(second.log)).toEqual([])
    expect(children).toHaveLength(1)
    expect(keyOf(childEnv(children[0]))).toBe('C')
    expect(childEnv(children[0]).ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('THE CLAIM: a save of the default connection D moves nothing — C reuses its child, no drift, no respawn', async () => {
    const agentC = directAgentOnC('session-c')
    await postInit(agentC)
    await runTurn(agentC, 'turn one')

    await reinitializeAuth()
    const second = await runTurn(agentC, 'turn two')

    expect(driftLines(second.log)).toEqual([])
    expect(children).toHaveLength(1)
    expect(children[0]!.aborted).toBe(false)
    expect(children[0]!.prompts).toBe(2)
  })

  it('CONTROL: a REAL rotation of C\'s own key (C\'s postInit re-run) still respawns C, with the new key and no endpoint', async () => {
    const agentC = directAgentOnC('session-c')
    await postInit(agentC)
    await runTurn(agentC, 'turn one')

    apiKeys.set('f1963-direct-c', KEY_C_ROTATED)
    await postInit(agentC)
    const second = await runTurn(agentC, 'turn two')

    expect(children).toHaveLength(2)
    const lines = driftLines(second.log)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('env.ANTHROPIC_API_KEY')
    expect(keyOf(childEnv(children[1]))).toBe('C-rotated')
    expect(childEnv(children[1]).ANTHROPIC_BASE_URL).toBeUndefined()
  })
})
