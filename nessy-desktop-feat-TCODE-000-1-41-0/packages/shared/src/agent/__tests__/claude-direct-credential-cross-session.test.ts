/**
 * F1.958 — TWO DIRECT-ANTHROPIC CLAUDE SESSIONS ON TWO CONNECTIONS MUST NEVER
 * CARRY EACH OTHER'S CREDENTIAL.
 *
 * ## The question (origin WJ-crit-ooo P-1, read from the code, unmeasured)
 *
 * `ClaudeAgent.postInit`'s direct-Anthropic tail resolves the session's
 * credential through `resolveAuthEnvVars` and wrote it into the PROCESS-GLOBAL
 * `process.env` — the same shape F1.953 removed for `NESSY_SESSION_DIR`. Every
 * claude child's `options.env` is `{ ...process.env, ...envOverrides }`
 * (`buildClaudeSubprocessEnv`), and `claudeLiveSessionSignature` hashes that env
 * (F1.512). So the question is whether creating session B's agent — `postInit`
 * runs at every agent creation, and at every temporary title/summary agent —
 * changes the env session A's NEXT turn is built from: does A's child drift,
 * and does a respawn of A carry B's key (and B's endpoint)?
 *
 * ## The instrument
 *
 * Two real `ClaudeAgent`s on two DIRECT connections (`providerType:
 * 'anthropic'`), each with a FABRICATED key — no value in this file is a real
 * credential. The connection store and the credential manager are the only
 * stand-ins for storage (spread and restored from snapshots, AGENTS.md §Traps);
 * `postInit` and `resolveAuthEnvVars` are production code. Session A's turns are
 * real `chatImpl` turns with the SDK `query` the only double — F1.953's rig
 * (`claude-session-dir-env-respawn.test.ts`) — so the `options.env` each fake
 * child receives is what a real child would receive.
 *
 * ## Measured (2026-09-25, before the fix)
 *
 * It reproduced. After B's `postInit`, A's turn two logged `Live session options
 * drifted — respawning (changed: env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL)`,
 * and A's children carried the keys `['A', 'B']`: A's respawned child held B's
 * key AND B's endpoint, so A's transcript would have gone to B's endpoint under
 * B's credential. The same held for a respawn forced by entering bypass.
 * 3 pass / 2 fail over 1 file, and the three controls passed.
 *
 * The fix: `postInit` writes the resolved auth into THIS session's
 * `envOverrides`, which `buildClaudeSubprocessEnv` spreads after `process.env`.
 * The credential kind a connection does not use is set to `''`, as the adapter
 * path and `llm-validation.ts` already do, so a value another writer leaves in
 * `process.env` cannot show through. `refreshClaudeOAuthTokenForLiveSession`
 * got the same treatment: its "unchanged" guard reads the session's own copy.
 *
 * Every reuse claim sits beside a control on the same rig that still respawns:
 * A alone reuses (the rig itself moves nothing), and a REAL credential change on
 * A's OWN connection (re-running A's `postInit` after its key was replaced — what
 * `reinitializeAuth` does on a connection save) still respawns A with the new key.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as claudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import * as configStorage from '../../config/storage.ts'
import * as credentialsIndex from '../../credentials/index.ts'
import type { LlmConnection } from '../../config/storage.ts'
import type { AgentEvent } from '@nessy-agent/core/types'
import type { BackendConfig } from '../backend/types.ts'
import { enableDebug } from '../../utils/debug.ts'

/** SNAPSHOTS of each module's exports, never the live namespace (AGENTS.md §Traps, the `mock.module` bullet). */
const realSdk = { ...claudeAgentSdk }
const realQuery = realSdk.query
const realStorage = { ...configStorage }
const realCredentials = { ...credentialsIndex }

const MODEL = 'claude-sonnet-4-5'
/** Fabricated. Never a real key. */
const KEY_A = 'sk-ant-f1958-FABRICATED-A-0000'
const KEY_A_ROTATED = 'sk-ant-f1958-FABRICATED-A-ROTATED-0000'
const KEY_B = 'sk-ant-f1958-FABRICATED-B-0000'
/** B's own endpoint — A has none, so A's child must never carry one. */
const BASE_URL_B = 'https://f1958-b.example.invalid'

const connections = new Map<string, LlmConnection>()
const apiKeys = new Map<string, string>()

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getLlmConnection: (slug: string) => connections.get(slug) ?? realStorage.getLlmConnection(slug),
}))

mock.module('../../credentials/index.ts', () => ({
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
    type: 'assistant', session_id: 'fake-f1958-session',
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
    total_cost_usd: 0, session_id: 'fake-f1958-session', stop_reason: null, modelUsage: {},
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
  mock.module('../../config/storage.ts', () => realStorage)
  mock.module('../../credentials/index.ts', () => realCredentials)
})

const { ClaudeAgent } = await import('../claude-agent.ts')

// Real `chatImpl` turns over the shared module graph: the budget belongs to the file.
setDefaultTimeout(120_000)

/** Every name `postInit` deletes or writes on this path, restored delete-then-assign (the Bun env-slot rule). */
const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const
let savedEnv: Record<string, string | undefined> = {}
const agents: Array<{ destroy(): void }> = []
const roots: string[] = []
/** A REAL directory: a missing one makes turn 1's and turn 2's `cwd` differ, a drift of the RIG (F1.953's red1). */
let workspaceRoot = ''

beforeEach(() => {
  rigArmed = true
  workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-f1958-'))
  mkdirSync(join(workspaceRoot, 'sessions'), { recursive: true })
  roots.push(workspaceRoot)
  children.length = 0
  enableDebug()
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  connections.clear()
  apiKeys.clear()
  connections.set('f1958-direct-a', {
    slug: 'f1958-direct-a', name: 'Direct A', providerType: 'anthropic', authType: 'api_key',
    defaultModel: MODEL, createdAt: 1,
  } as LlmConnection)
  connections.set('f1958-direct-b', {
    slug: 'f1958-direct-b', name: 'Direct B', providerType: 'anthropic', authType: 'api_key_with_endpoint',
    baseUrl: BASE_URL_B, defaultModel: MODEL, createdAt: 1,
  } as LlmConnection)
  apiKeys.set('f1958-direct-a', KEY_A)
  apiKeys.set('f1958-direct-b', KEY_B)
})

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  for (const key of ENV_KEYS) {
    delete process.env[key]
    const value = savedEnv[key]
    if (value !== undefined) process.env[key] = value
  }
  rigArmed = false
})

type Agent = InstanceType<typeof ClaudeAgent>

/**
 * A direct-Anthropic claude agent, with the overrides the host builds for it
 * (`getOrCreateAgentUnchecked`'s `envOverrides` literal: identity, its own
 * session dir since F1.953, and `ANTHROPIC_DEFAULT_HAIKU_MODEL` from the
 * connection's mini model — which shadows `postInit`'s own write of that name on
 * the real path). `hostHaiku` undefined builds an agent whose host overrides do
 * NOT carry the name, the shape F1.965's block below measures.
 */
function directAgent(
  sessionId: string, connectionSlug: string, miniModel: string | undefined, hostHaiku: string | undefined = miniModel,
): Agent {
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    connectionSlug,
    model: MODEL,
    miniModel,
    isHeadless: true,
    skipConfigWatcher: true,
    envOverrides: {
      NESSY_WORKSPACE_ID: 'ws-f1958',
      NESSY_SESSION_ID: sessionId,
      NESSY_SESSION_DIR: join(workspaceRoot, 'sessions', sessionId),
      ...(hostHaiku ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: hostHaiku } : {}),
    },
    workspace: {
      id: 'ws-f1958', name: 'F1.958', rootPath: workspaceRoot,
      workspaceRootPath: workspaceRoot, sessionRootPath: join(workspaceRoot, 'sessions'),
    },
    session: {
      id: sessionId, createdAt: Date.now(), lastUsedAt: Date.now(),
      workingDirectory: workspaceRoot, sdkCwd: workspaceRoot,
    },
  } as unknown as BackendConfig) as Agent
  agent.setPermissionMode('default')
  agent.setThinkingLevel('low')
  agents.push(agent)
  return agent
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
/** Which fabricated key a child carries, by NAME — the log never needs the value. */
const keyOf = (child: FakeChild | undefined): string => {
  const value = childEnv(child).ANTHROPIC_API_KEY
  if (value === KEY_A) return 'A'
  if (value === KEY_A_ROTATED) return 'A-rotated'
  if (value === KEY_B) return 'B'
  return value === undefined ? 'none' : 'other'
}

describe('F1.958 — session A\'s claude child after session B\'s agent is created on ANOTHER direct connection', () => {
  it('CONTROL: A alone reuses its child on turn two, and the child carries A\'s key (the rig moves nothing)', async () => {
    const agentA = directAgent('session-a', 'f1958-direct-a', 'claude-haiku-a')
    await postInit(agentA)
    await runTurn(agentA, 'turn one')
    const second = await runTurn(agentA, 'turn two')

    expect(driftLines(second.log)).toEqual([])
    expect(children).toHaveLength(1)
    expect(keyOf(children[0])).toBe('A')
  })

  it('THE CLAIM: A reuses its child — no drift, no respawn — and no child of A\'s ever carries B\'s key or B\'s endpoint', async () => {
    const agentA = directAgent('session-a', 'f1958-direct-a', 'claude-haiku-a')
    await postInit(agentA)
    await runTurn(agentA, 'turn one')
    expect(children).toHaveLength(1)
    expect(keyOf(children[0])).toBe('A')
    expect(childEnv(children[0]).ANTHROPIC_BASE_URL).toBeUndefined()

    // Session B's agent is created: the host runs its `postInit` at construction.
    const agentB = directAgent('session-b', 'f1958-direct-b', 'claude-haiku-b')
    await postInit(agentB)

    const second = await runTurn(agentA, 'turn two')

    // Which key, and which endpoint, every child of A's carried — first, so a red names them.
    expect(children.map(keyOf)).toEqual(['A'])
    expect(children.map(child => childEnv(child).ANTHROPIC_BASE_URL)).toEqual([undefined])
    expect(driftLines(second.log)).toEqual([])
    expect(children).toHaveLength(1)
    expect(children[0]!.aborted).toBe(false)
    expect(children[0]!.prompts).toBe(2)
    expect(children.map(child => childEnv(child).ANTHROPIC_DEFAULT_HAIKU_MODEL)).toEqual(['claude-haiku-a'])
  })

  it('THE CLAIM, respawn arm: a respawn of A forced after B\'s agent exists (entering bypass) still carries A\'s key and no endpoint', async () => {
    const agentA = directAgent('session-a', 'f1958-direct-a', 'claude-haiku-a')
    await postInit(agentA)
    await runTurn(agentA, 'turn one')

    const agentB = directAgent('session-b', 'f1958-direct-b', 'claude-haiku-b')
    await postInit(agentB)

    agentA.setPermissionMode('bypassPermissions')
    const second = await runTurn(agentA, 'turn two')

    expect(children).toHaveLength(2)
    expect(keyOf(children[1])).toBe('A')
    expect(childEnv(children[1]).ANTHROPIC_BASE_URL).toBeUndefined()
    const lines = driftLines(second.log)
    expect(lines).toHaveLength(1)
    // The ONLY moved key is the bypass flag — no credential name.
    expect(lines[0]).toContain('(changed: allowDangerouslySkipPermissions)')
    expect(childEnv(children[1]).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-a')
  })

  it('CONTROL: B\'s own child carries B\'s key and B\'s endpoint', async () => {
    const agentA = directAgent('session-a', 'f1958-direct-a', 'claude-haiku-a')
    await postInit(agentA)
    const agentB = directAgent('session-b', 'f1958-direct-b', 'claude-haiku-b')
    await postInit(agentB)
    await runTurn(agentB, 'turn one')

    expect(children).toHaveLength(1)
    expect(keyOf(children[0])).toBe('B')
    expect(childEnv(children[0]).ANTHROPIC_BASE_URL).toBe(BASE_URL_B)
  })

  it('CONTROL: a REAL credential change on A\'s OWN connection still respawns A, with the new key', async () => {
    const agentA = directAgent('session-a', 'f1958-direct-a', 'claude-haiku-a')
    await postInit(agentA)
    await runTurn(agentA, 'turn one')

    apiKeys.set('f1958-direct-a', KEY_A_ROTATED)
    await postInit(agentA)
    const second = await runTurn(agentA, 'turn two')

    expect(children).toHaveLength(2)
    expect(children[0]!.aborted).toBe(true)
    const lines = driftLines(second.log)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('env.ANTHROPIC_API_KEY')
    expect(keyOf(children[1])).toBe('A-rotated')
  })
})

/**
 * F1.965 — `postInit`'s mini-model write. It assigned
 * `process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL`, the object Pi's
 * (`buildPiSubprocessEnv`, `processEnv: process.env`) and codex's children are
 * built from, so the last claude agent's mini model reached every later child of
 * the other two runtimes, and any claude child whose host overrides do not carry
 * the name. The value must ride THIS session's `envOverrides` instead, under any
 * value the host's overrides already carry (the precedence the `process.env`
 * write had, spread under the overrides).
 */
describe('F1.965 — the claude session\'s mini model reaches its own child only', () => {
  /** An operator's launch value, restored by `afterEach` (ENV_KEYS carries the name). */
  const LAUNCH_HAIKU = 'claude-haiku-f1965-launch'
  beforeEach(() => {
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = LAUNCH_HAIKU
  })

  it('THE CLAIM: after postInit the shared process.env still holds the launch value, and a later claude session with no mini model does not inherit A\'s', async () => {
    const agentA = directAgent('session-a', 'f1958-direct-a', 'claude-haiku-a', undefined)
    await postInit(agentA)

    // What a Pi or codex child spawned now would spread.
    expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(LAUNCH_HAIKU)

    const agentC = directAgent('session-c', 'f1958-direct-b', undefined)
    await postInit(agentC)
    await runTurn(agentC, 'turn one')
    expect(children).toHaveLength(1)
    expect(childEnv(children[0]).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(LAUNCH_HAIKU)
  })

  it('CONTROL: the claude child still gets its mini model for WebFetch when the host overrides lack the name, and a host value still wins', async () => {
    const agentA = directAgent('session-a', 'f1958-direct-a', 'claude-haiku-a', undefined)
    await postInit(agentA)
    await runTurn(agentA, 'turn one')
    const agentB = directAgent('session-b', 'f1958-direct-b', 'claude-haiku-b-config', 'claude-haiku-b-host')
    await postInit(agentB)
    await runTurn(agentB, 'turn one')

    expect(children).toHaveLength(2)
    expect(childEnv(children[0]).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-a')
    expect(childEnv(children[1]).ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-b-host')
  })
})
