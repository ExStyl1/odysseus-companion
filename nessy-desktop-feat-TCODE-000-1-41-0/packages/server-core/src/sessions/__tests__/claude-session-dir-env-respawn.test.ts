/**
 * F1.953 — CREATING ANOTHER SESSION'S AGENT MUST NOT RESPAWN A LIVE CLAUDE CHILD.
 *
 * ## What the sitting saw (SIT-al, packaged RC #3 `bd8ac0d68`, 2026-09-25)
 *
 * Two claude-gateway sessions: bg started a background worker (its card
 * pending), then session mk was created and sent its first message, then bg's
 * next turn logged `Live session options drifted — respawning (changed:
 * env.NESSY_SESSION_DIR)`. The respawn ended bg's background task ("A background
 * task did not survive the Claude session restart") and took its card with it.
 * The most recently created session reused its child.
 *
 * ## The cause, read from the source
 *
 * `getOrCreateAgentUnchecked` wrote the PROCESS-GLOBAL
 * `process.env.NESSY_SESSION_DIR` to its own session's directory on every agent
 * creation. `buildClaudeSubprocessEnv` spreads `process.env` into every claude
 * child's `options.env`, and `claudeLiveSessionSignature` hashes the whole of it
 * (F1.512 — rightly: an env change is one the running child cannot be told
 * about). So creating session B changed the env session A's next turn was built
 * from, and A's child was respawned — with B's directory in its environment.
 *
 * ## The instrument
 *
 * Every step up to the backend factory is production code: both sessions' agents
 * are created through the real `getOrCreateAgent`, and the per-session env
 * overrides are captured at the `createBackendFromManagedContext` boundary
 * (`agent-config-memory-scope.test.ts`'s instrument — the factory tail spawns a
 * child and cannot run here). Session A's turns are real `ClaudeAgent.chatImpl`
 * turns built from A's captured overrides, with the SDK `query` the only double
 * (`claude-first-turn-thinking-drift.test.ts`'s rig), so the `options.env` each
 * fake child receives is what a real child would receive.
 *
 * Every reuse claim sits beside a control on the same rig that still respawns: a
 * real change of the host's env between the turns (F1.512's axis — the signature
 * must go on hashing the env) and a real option change (entering bypass).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as claudeAgentSdk from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent } from '@nessy-agent/core/types'
import { buildPiSubprocessEnv } from '@nessy-agent/shared/agent/pi-agent'
import { enableDebug } from '@nessy-agent/shared/utils/debug'
import { createHeadlessPlatform } from '../../runtime/platform-headless.ts'
import { createManagedSession, setSessionPlatform } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

/** A SNAPSHOT of the SDK's exports, never the live namespace (AGENTS.md §Traps, the `mock.module` bullet). */
const realSdk = { ...claudeAgentSdk }
const realQuery = realSdk.query

const GATEWAY_MODEL = 'tgpt/deepseek-v4-flash-0731'

interface FakeChild {
  prompts: number
  options: Record<string, unknown>
  aborted: boolean
}

const children: FakeChild[] = []

function assistantMessage(text: string): unknown {
  return {
    type: 'assistant', session_id: 'fake-f1953-session',
    message: {
      id: `msg-${text}-${Math.random()}`, role: 'assistant', model: GATEWAY_MODEL,
      content: [{ type: 'text', text }], stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }
}

function resultMessage(): unknown {
  return {
    type: 'result', subtype: 'success', result: 'ok', is_error: false, num_turns: 1,
    total_cost_usd: 0, session_id: 'fake-f1953-session', stop_reason: null, modelUsage: {},
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
})

const { ClaudeAgent } = await import('@nessy-agent/shared/agent/claude-agent')

// A server-core module graph plus real `chatImpl` turns: the budget belongs to the file.
setDefaultTimeout(120_000)

setSessionPlatform(createHeadlessPlatform())

const WORKSPACE_ID = 'ws-f1953'
const roots: string[] = []
const agents: Array<{ destroy(): void }> = []
const cleanups: Array<() => void> = []
let launchSessionDir: string | undefined
let hadLaunchSessionDir = false

beforeEach(() => {
  rigArmed = true
  children.length = 0
  enableDebug()
  // The launch value, restored after each case: agent creation at HEAD rewrote it.
  hadLaunchSessionDir = Object.prototype.hasOwnProperty.call(process.env, 'NESSY_SESSION_DIR')
  launchSessionDir = process.env.NESSY_SESSION_DIR
})

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy()
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  delete process.env.NESSY_SESSION_DIR
  if (hadLaunchSessionDir) process.env.NESSY_SESSION_DIR = launchSessionDir
  delete process.env.NESSY_F1953_REAL_DRIFT
  rigArmed = false
})

interface HostRig {
  /** Create `sessionId`'s agent through the real `getOrCreateAgent`; returns the env overrides its backend was handed. */
  createAgent(sessionId: string): Promise<Record<string, string>>
  sessionDir(sessionId: string): string
  workspaceRoot: string
}

function hostRig(): HostRig {
  const root = mkdtempSync(join(tmpdir(), 'nessy-f1953-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  const workspace = { id: WORKSPACE_ID, name: 'F1.953', rootPath: workspaceRoot, createdAt: 1 }
  const manager = createTestSessionManager()
  const internals = manager as unknown as {
    sessions: Map<string, unknown>
    sessionStore: { getSessionPath(key: { workspaceId: string; sessionId: string }): string }
    createCapabilityTurn(managed: unknown): Promise<{ runtime: unknown }>
    getOrCreateAgent(managed: unknown, runtime: unknown): Promise<unknown>
    createBackendFromManagedContext(args: { coreConfig: Record<string, unknown> }): unknown
    cleanup(): void
  }
  cleanups.push(() => internals.cleanup())
  let captured: Record<string, unknown> | undefined
  internals.createBackendFromManagedContext = args => {
    captured = args.coreConfig
    throw new Error('captured-before-construction')
  }
  return {
    workspaceRoot,
    sessionDir: sessionId => internals.sessionStore.getSessionPath({ workspaceId: WORKSPACE_ID, sessionId }),
    async createAgent(sessionId) {
      const managed = createManagedSession({ id: sessionId }, workspace as never, { messagesLoaded: true, ephemeral: true })
      managed.activeProvider = 'anthropic'
      internals.sessions.set(`${WORKSPACE_ID}:${sessionId}`, managed)
      const turn = await internals.createCapabilityTurn(managed)
      captured = undefined
      await expect(internals.getOrCreateAgent(managed, turn.runtime)).rejects.toThrow('captured-before-construction')
      expect(captured).toBeTruthy()
      return { ...(captured!.envOverrides as Record<string, string>) }
    },
  }
}

type Agent = InstanceType<typeof ClaudeAgent>

/** Session A's claude agent, built from the env overrides the host handed A's backend. */
function claudeAgentFor(sessionId: string, workspaceRoot: string, envOverrides: Record<string, string>): Agent {
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: GATEWAY_MODEL,
    isHeadless: true,
    skipConfigWatcher: true,
    envOverrides,
    workspace: {
      id: WORKSPACE_ID, name: 'F1.953', rootPath: workspaceRoot,
      workspaceRootPath: workspaceRoot, sessionRootPath: join(workspaceRoot, 'sessions'),
    },
    // `sdkCwd` as the host sets it at session creation (`sessionConfig.sdkCwd`): without it turn 2's cwd
    // falls through to the session directory the host has just created, which would be a drift of the RIG.
    session: { id: sessionId, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: workspaceRoot, sdkCwd: workspaceRoot },
  } as never) as Agent
  agent.setPermissionMode('default')
  agent.setThinkingLevel('low')
  agents.push(agent)
  return agent
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
const childDir = (child: FakeChild | undefined): unknown => (child?.options.env as Record<string, unknown> | undefined)?.NESSY_SESSION_DIR

describe('F1.953 — the host hands each session its OWN session dir, never through process.env', () => {
  it('creating session B does not move process.env, and A\'s and B\'s overrides each carry their own dir', async () => {
    const rig = hostRig()
    const before = process.env.NESSY_SESSION_DIR

    const envA = await rig.createAgent('session-a')
    const envB = await rig.createAgent('session-b')

    expect(rig.sessionDir('session-a')).not.toBe(rig.sessionDir('session-b'))
    expect(envA.NESSY_SESSION_DIR).toBe(rig.sessionDir('session-a'))
    expect(envB.NESSY_SESSION_DIR).toBe(rig.sessionDir('session-b'))
    // The global is left as the app was launched with it — no agent creation writes it.
    expect(process.env.NESSY_SESSION_DIR).toBe(before)
  })
})

describe('F1.953 — session A\'s next turn after session B\'s agent is created', () => {
  it('THE CLAIM: A reuses its child, and A\'s child env carries A\'s own dir', async () => {
    const rig = hostRig()
    const envA = await rig.createAgent('session-a')
    const agentA = claudeAgentFor('session-a', rig.workspaceRoot, envA)
    await runTurn(agentA, 'turn one')
    expect(children).toHaveLength(1)
    expect(childDir(children[0])).toBe(rig.sessionDir('session-a'))

    await rig.createAgent('session-b')
    const second = await runTurn(agentA, 'turn two')

    expect(driftLines(second.log)).toEqual([])
    expect(children).toHaveLength(1)
    expect(children[0]!.aborted).toBe(false)
    expect(children[0]!.prompts).toBe(2)
    expect(second.log.some(line => line.includes('Reusing the live session'))).toBe(true)
    // No child of A's ever sees B's directory.
    expect(children.map(childDir)).toEqual([rig.sessionDir('session-a')])
  })

  it('CONTROL (F1.512 kept): a REAL change of the host env between the turns still respawns, and the line names it', async () => {
    const rig = hostRig()
    const envA = await rig.createAgent('session-a')
    const agentA = claudeAgentFor('session-a', rig.workspaceRoot, envA)
    await runTurn(agentA, 'turn one')

    delete process.env.NESSY_F1953_REAL_DRIFT
    process.env.NESSY_F1953_REAL_DRIFT = 'moved'
    const second = await runTurn(agentA, 'turn two')

    expect(children).toHaveLength(2)
    expect(children[0]!.aborted).toBe(true)
    const lines = driftLines(second.log)
    expect(lines).toHaveLength(1)
    // The ONLY moved key: the rig itself moves nothing else between the turns.
    expect(lines[0]).toContain('(changed: env.NESSY_F1953_REAL_DRIFT)')
    // The respawned child is still A's.
    expect(childDir(children[1])).toBe(rig.sessionDir('session-a'))
  })

  it('CONTROL: a real option change (entering bypass) still respawns', async () => {
    const rig = hostRig()
    const envA = await rig.createAgent('session-a')
    const agentA = claudeAgentFor('session-a', rig.workspaceRoot, envA)
    await runTurn(agentA, 'turn one')

    agentA.setPermissionMode('bypassPermissions')
    const second = await runTurn(agentA, 'turn two')

    expect(children).toHaveLength(2)
    const lines = driftLines(second.log)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('allowDangerouslySkipPermissions')
  })
})

describe('F1.953 — Pi keeps its own dir', () => {
  it('CONTROL: Pi\'s builder names its own session dir after every spread, whatever the overrides carry', () => {
    const env = buildPiSubprocessEnv({
      processEnv: { NESSY_SESSION_DIR: '/sessions/launch' },
      proxyEnv: {},
      envOverrides: { NESSY_WORKSPACE_ID: WORKSPACE_ID, NESSY_SESSION_ID: 'session-pi', NESSY_SESSION_DIR: '/sessions/from-overrides' },
      awsEnv: {},
      sessionDir: '/sessions/session-pi',
      sessionId: 'session-pi',
      debug: false,
    })
    expect(env.NESSY_SESSION_DIR).toBe('/sessions/session-pi')
  })
})
