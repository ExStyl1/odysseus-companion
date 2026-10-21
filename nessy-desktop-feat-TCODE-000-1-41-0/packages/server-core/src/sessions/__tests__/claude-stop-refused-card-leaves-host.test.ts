/**
 * F1.954 (origin SIT-al FAILS 2, 2026-09-25, RC #3) — a claude permission card the runtime REFUSES on a Stop leaves
 * the host, and a card record whose waiter is gone does not come back as live.
 *
 * ## What was measured (packaged RC #3 `bd8ac0d68`, `work/sitting/SIT-al/verdicts.md`)
 *
 * A background worker's `rm -rf ./scratch-dir3` card was pending (count 1). The user started a turn and stopped it.
 * The runtime refused the worker's call — the hook log said `permissionDecision: deny (reason: User denied
 * permission)` — and the worker ended, but the HOST kept the approval: `awaitingApprovalCount` stayed 1 and
 * `pendingApproval` stayed persisted with no card on screen, F1.527's 540 s withdrawal never removed it, and after an
 * app restart it came back as a LIVE card whose Allow ran the stopped command in the parent session.
 *
 * ## The cause, read from the source
 *
 * A Stop reaches `ClaudeAgent.forceAbort(UserStop)` → `interruptLiveTurn` → `cancelTurnScopedUi` →
 * `cancelPendingPermissions`, which resolves every waiter `false` (hence 'User denied permission') and clears the map
 * — and tells the host nothing. F1.541's withdrawal (`withdrawAbandonedCard`) covers a call the CLI abandons, and
 * F1.527's (`withdrawClaudeCard`) covers a deadline, but a waiter settled by the Stop has neither: its deadline timer
 * is gone with it. The host's record is then answerable by nothing, and `reprojectPendingApproval` re-fires it after a
 * restart, where `settleDurableApproval` honours its grant (`rememberForMinutes`, `commandHash`) on the re-driven turn.
 *
 * ## What this file pins (the rig: a REAL SessionManager and a REAL ClaudeAgent, the SDK `query` the only stand-in;
 * the host wiring is the production one — `handleAgentPermissionRequest` as the permission handler and
 * `wireOutOfTurnCardWithdrawal` as the out-of-turn channel; the PreToolUse hook is the REAL one read back off the
 * options the fake received)
 *
 * (1) The SIT-al sequence: a background worker's card pending between turns, a turn started and Stopped through the
 *     host's own `cancelProcessing` → the hook answers deny, and the host keeps NO record: count 0, no persisted
 *     `pendingApproval`, the renderer told `permission_request_cancelled`; a restart's re-projection shows nothing.
 * (2) A record whose waiter is already gone (a teardown that settled it without a word — `destroy`) is swept at the
 *     card's own lifetime (F1.527's budget, which the agent reports) — not kept until a restart.
 * (3) A restored claude record older than that lifetime is not re-shown live after a restart, and an Allow on one
 *     already on screen is settled as a denial — its grant is not honoured.
 * CONTROLS: F1.900 — a card survives an ORDINARY turn end and its Allow still reaches the hook; F1.541's Stop Task
 * (the hook call abandoned) still withdraws; F1.527's expiry of a live waiter still withdraws; a FRESH MAIN-THREAD
 * claude record is still re-shown after a restart (a stamped one is not — F1.961); Pi is unchanged (an old Pi record
 * is still re-shown; an agent that reports no card lifetime arms no sweep).
 *
 * F1.975 (origin WJ-crit-ttt P-2, measured in SIT-an1, 2026-09-26) — a claude child stopped INSIDE the app while
 * idle (a trust revoke, a cwd move, a runtime refresh, an auth retry, the reaper) is disposed, not interrupted:
 * `destroy` → `cancelPendingPermissions` refuses every waiter and tells the host nothing, and the host's teardown
 * (`disposeManagedAgentRuntime`) withdrew only host cards (F1.403) and question dialogs (F1.369). The card stayed on
 * screen and counted, its Allow answered a child that never held it (or re-drove the PARENT's turn), and nobody was
 * told the worker had stopped; F1.954's sweep removed it only at 540 + 30 s, silently. The host now withdraws the
 * cards whose waiter the teardown settled and says why — except on the app-exit drain, whose relaunch re-shows a
 * MAIN-THREAD record (since F1.961 a subagent-raised record expires on re-projection instead — BOUNDARY below).
 *
 * F1.993 (origin DN-012) — the same teardown DURING a live turn: `strictDrainSessionForMutation` interrupts first, and
 * F1.954's Stop path withdrew the refused cards before the dispose looked, so the card left with no line saying why.
 * The drain now names them too; the user's own Stop still withdraws its cards without one (BOUNDARY below).
 *
 * F1.962 (origin WJ-crit-ppp P-2) — a SESSION DEATH, as distinct from a dispose: `killLiveSession` (a capability
 * revoke, the redirect fallback, a turn or token cap, an interrupt nobody answered) ends the child but keeps the agent,
 * and refused every waiter without a word, so the record stood until F1.954's sweep (540 + 30 s). It now reports each
 * card as the Stop path does, and the host's revoke names them; `destroy` still reports nothing (BOUNDARY below).
 *
 * SAFETY: no real home directory, no credential; every workspace is a temp directory; nothing is executed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent } from '@nessy-agent/core/types'
import { AbortReason } from '@nessy-agent/shared/agent'
import { createManagedSession, SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

// Importing `claude-agent.ts` is this file's wall-clock cost; the cases are milliseconds (AGENTS.md §Traps).
setDefaultTimeout(120_000)

const realSdk = { ...sdkPackage }

type HookFn = (input: Record<string, unknown>, toolUseId: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>
type HookMatcher = { hooks: HookFn[] }

const scripts: Array<() => AsyncGenerator<unknown>> = []
let capturedHooks: Record<string, HookMatcher[]> | undefined

function resultMessage(): unknown {
  return {
    type: 'result',
    subtype: 'success',
    result: 'ok',
    num_turns: 1,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }
}

async function* plainSuccess(): AsyncGenerator<unknown> {
  yield resultMessage()
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedHooks = input.options.hooks as Record<string, HookMatcher[]> | undefined
    const iterator = (input.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    async function* serveTurns(): AsyncGenerator<unknown> {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
        yield* (scripts.shift() ?? plainSuccess)()
      }
    }
    const stream = serveTurns() as AsyncGenerator<unknown> & { interrupt(): Promise<unknown> }
    stream.interrupt = async () => ({ still_queued: [] })
    return stream
  },
}))

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk)
})

const { ClaudeAgent } = await import('@nessy-agent/shared/agent/claude-agent')

const WS_ID = 'ws-f1-954'
const COMMAND = 'rm -rf ./scratch-dir3'
const roots: string[] = []
const agents: Array<{ destroy(): void }> = []

interface PendingRecord { sessionId: string; workspaceId: string }
interface Internals {
  sessions: Map<string, unknown>
  pendingPermissionRequests: Map<string, PendingRecord>
  handleAgentPermissionRequest(managed: unknown, request: unknown): void
  wireOutOfTurnCardWithdrawal(managed: unknown): void
  reprojectPendingApproval(managed: unknown): void
  respondToPermission(sessionId: string, requestId: string, allowed: boolean, alwaysAllow?: boolean, options?: unknown, workspaceId?: string): boolean
  awaitingApprovalCount(managed: unknown): number
  persistSession(managed: unknown, immediate?: boolean): void
  resolveManagedProvider(managed: unknown): string
  runtimeCardOrphanSweepGraceMs: number
  disposeManagedAgentRuntime(managed: unknown, reason: string, strict?: boolean): Promise<void>
  strictDrainSessionForMutation(managed: unknown, reason: string, boundaryHeld?: boolean): Promise<void>
}

interface Managed extends Record<string, unknown> {
  id: string
  workspace: { id: string }
  pendingApproval?: { requestId: string; command?: string; requestedAt: number; rememberForMinutes?: number; raisedBySubagent?: boolean }
  isProcessing: boolean
  agent: unknown
}

interface Rig {
  manager: ReturnType<typeof createTestSessionManager>
  internals: Internals
  managed: Managed
  forwarded: Array<Record<string, unknown>>
}

let counter = 0

function hostRig(options?: Parameters<typeof createTestSessionManager>[0]): Rig {
  counter += 1
  const stateRoot = mkdtempSync(join(tmpdir(), 'sm-f1-954-'))
  roots.push(stateRoot)
  const workspace = { id: WS_ID, name: 'F1.954', slug: 'f1-954', rootPath: join(stateRoot, 'workspace'), createdAt: Date.now() }
  mkdirSync(workspace.rootPath, { recursive: true })
  const manager = createTestSessionManager(options)
  const managed = createManagedSession({ id: `session-f1-954-${counter}` }, workspace as never, { messagesLoaded: true, ephemeral: true }) as unknown as Managed
  const internals = manager as unknown as Internals
  internals.sessions.set(`${workspace.id}:${managed.id}`, managed)
  internals.persistSession = () => {}
  manager.flushSession = async () => {}
  const forwarded: Array<Record<string, unknown>> = []
  manager.setEventSink(((_channel: unknown, _target: unknown, event: Record<string, unknown>) => {
    forwarded.push(event)
  }) as Parameters<typeof manager.setEventSink>[0])
  return { manager, internals, managed, forwarded }
}

type RealClaudeAgent = InstanceType<typeof ClaudeAgent>

/** A real ClaudeAgent wired to the host exactly as `getOrCreateAgent` wires it. */
function claudeRig(options?: Parameters<typeof createTestSessionManager>[0]): Rig & { agent: RealClaudeAgent } {
  const rig = hostRig(options)
  const root = mkdtempSync(join(tmpdir(), 'sm-f1-954-agent-'))
  roots.push(root)
  const agent = new ClaudeAgent({
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: { id: WS_ID, name: 'F1.954', rootPath: root, workspaceRootPath: root, sessionRootPath: `${root}/sessions` },
    session: { id: rig.managed.id, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: root, permissionMode: 'default' },
  } as never)
  agents.push(agent)
  // The fixture's runtime is asserted rather than assumed (AGENTS.md §Traps, the 2026-09-20 fixture trap).
  expect(agent).toBeInstanceOf(ClaudeAgent)
  rig.managed.agent = agent
  // Production's wiring (`getOrCreateAgentUnchecked`): the out-of-turn channel, then the permission handler.
  rig.internals.wireOutOfTurnCardWithdrawal(rig.managed)
  ;(agent as unknown as { onPermissionRequest: (request: unknown) => void }).onPermissionRequest = request => {
    rig.internals.handleAgentPermissionRequest(rig.managed, request)
  }
  return { ...rig, agent }
}

function startTurn(agent: RealClaudeAgent, message: string): Promise<AgentEvent[]> {
  const chatImpl = (agent as unknown as { chatImpl: (message: string) => AsyncGenerator<AgentEvent> }).chatImpl.bind(agent)
  return (async () => {
    const events: AgentEvent[] = []
    for await (const event of chatImpl(message)) events.push(event)
    return events
  })()
}

/** A turn the test holds open (its result withheld) until `end()`. */
function heldTurn(): { end(): void; opened: Promise<void> } {
  let release!: () => void
  let markOpened!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const opened = new Promise<void>(resolve => { markOpened = resolve })
  scripts.push(async function* held() {
    yield { type: 'system', subtype: 'init', session_id: 'sdk-f1-954', uuid: `u-init-${Math.random()}` }
    markOpened()
    await gate
    yield resultMessage()
  })
  return { end: () => release(), opened }
}

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return
    await tick(10)
  }
  throw new Error(`F1.954 rig: timed out waiting for ${label}`)
}

/** The REAL PreToolUse hook, fired for a BACKGROUND worker's destructive Bash call (the hook input names the agent). */
function fireWorkerCard(toolUseId: string, signal: AbortSignal = new AbortController().signal): Promise<unknown> {
  const hook = capturedHooks?.PreToolUse?.[0]?.hooks?.[0]
  if (!hook) throw new Error('F1.954 rig: no PreToolUse hook was registered')
  return hook({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: toolUseId,
    tool_input: { command: COMMAND },
    session_id: 'sdk-f1-954',
    transcript_path: '/tmp/f1-954.jsonl',
    cwd: '/tmp',
    agent_id: 'a-background-f1-954',
    agent_type: 'general-purpose',
  }, toolUseId, { signal })
}

function decisionOf(answer: unknown): string | undefined {
  return (answer as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision
}

function cancelledIds(rig: Rig): string[] {
  return rig.forwarded.filter(event => event.type === 'permission_request_cancelled').map(event => String(event.requestId))
}

function projectedIds(rig: Rig): string[] {
  return rig.forwarded
    .filter(event => event.type === 'permission_request')
    .map(event => String((event.request as { requestId?: string } | undefined)?.requestId))
}

/** A card pending between turns: turn 1 ran and ended, then the worker's call reached the gate. */
async function pendingWorkerCard(rig: Rig & { agent: RealClaudeAgent }, toolUseId: string, signal?: AbortSignal): Promise<{ requestId: string; answer: Promise<unknown> }> {
  await startTurn(rig.agent, 'start a background worker')
  expect(rig.agent.isProcessing()).toBe(false)
  const requestId = `perm-${toolUseId}`
  const answer = fireWorkerCard(toolUseId, signal)
  await until(() => rig.internals.pendingPermissionRequests.has(requestId), 'the worker card to reach the host')
  expect(rig.managed.pendingApproval?.requestId).toBe(requestId)
  expect(rig.internals.awaitingApprovalCount(rig.managed)).toBe(1)
  return { requestId, answer }
}

/** A persisted record as a previous process left it, re-projected by a FRESH manager (the restart). */
function restartWith(record: { requestId: string; requestedAt: number; raisedBySubagent?: boolean }, provider: string): Rig {
  const rig = hostRig()
  rig.internals.resolveManagedProvider = () => provider
  // An Allow re-drives the turn through `sendMessage` (R7); the send itself is not under test here.
  ;(rig.internals as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => {}
  rig.managed.pendingApproval = {
    schemaVersion: 1,
    toolName: 'Bash',
    description: `Execute: ${COMMAND}`,
    type: 'bash',
    command: COMMAND,
    rememberForMinutes: 10,
    commandHash: 'hash-f1-954',
    ...record,
  } as Managed['pendingApproval']
  rig.internals.reprojectPendingApproval(rig.managed)
  return rig
}

beforeEach(() => {
  scripts.length = 0
  capturedHooks = undefined
})

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('F1.954 — a claude card the runtime refused on a Stop leaves the host, and stays gone', () => {
  it('(1) the SIT-al sequence: a Stop refuses the worker\'s card, and the host keeps no count and no record', async () => {
    const rig = claudeRig()
    const { requestId, answer } = await pendingWorkerCard(rig, 'toolu_f1954_stop')

    // The user starts a turn and stops it — through the host's own Stop, as the renderer's Escape does.
    const turn = heldTurn()
    const turnEvents = startTurn(rig.agent, 'Please write a detailed 800-word essay about the history of pears')
    await turn.opened
    await until(() => rig.agent.isProcessing(), 'the stopped turn to open')
    rig.managed.isProcessing = true
    await rig.manager.cancelProcessing(rig.managed.id, false, WS_ID)
    rig.managed.isProcessing = false // the drain would lower it; the 5 s safety timer must find nothing to end
    turn.end()
    await turnEvents

    // The runtime refused the call, as the packaged hook log said.
    expect(decisionOf(await answer)).toBe('deny')
    // THE DEFECT: the host kept all three.
    expect(rig.internals.pendingPermissionRequests.has(requestId)).toBe(false)
    expect(rig.internals.awaitingApprovalCount(rig.managed)).toBe(0)
    expect(rig.managed.pendingApproval).toBeUndefined()
    expect(cancelledIds(rig)).toContain(requestId)

    // The restart: a fresh host re-projects whatever the session carries — and it carries nothing.
    const restarted = hostRig()
    restarted.managed.pendingApproval = rig.managed.pendingApproval
    restarted.internals.reprojectPendingApproval(restarted.managed)
    expect(projectedIds(restarted)).toEqual([])
  })

  it('(2) a record whose waiter a teardown settled without a word is swept at the card\'s own lifetime', async () => {
    const rig = claudeRig()
    ;(rig.agent as unknown as { permissionCardBudgetMs: number }).permissionCardBudgetMs = 400
    rig.internals.runtimeCardOrphanSweepGraceMs = 0
    const { requestId, answer } = await pendingWorkerCard(rig, 'toolu_f1954_orphan')

    // `destroy` settles every waiter `false` and tells the host nothing (the death/teardown path).
    rig.agent.destroy()
    expect(decisionOf(await answer)).toBe('deny')
    expect(rig.internals.pendingPermissionRequests.has(requestId)).toBe(true) // the orphan, as SIT-al measured it

    // THE DEFECT: F1.527's expiry lives with the waiter, so nothing ever removed this record.
    await until(() => !rig.internals.pendingPermissionRequests.has(requestId), 'the orphan sweep')
    expect(rig.managed.pendingApproval).toBeUndefined()
    expect(cancelledIds(rig)).toContain(requestId)
  })

  it('(3) a restored claude record older than the card\'s lifetime is not re-shown, and a late Allow on one is a denial', async () => {
    const stale = restartWith({ requestId: 'perm-toolu_f1954_stale', requestedAt: Date.now() - 10 * 60_000 }, 'anthropic')
    // THE DEFECT: it came back as a live card, and its Allow ran the command through the record's grant.
    expect(projectedIds(stale)).toEqual([])
    expect(stale.managed.pendingApproval).toBeUndefined()
    expect(stale.forwarded.some(event => event.type === 'info' && event.level === 'warning')).toBe(true)

    // The same record already on screen (re-shown while fresh), answered Allow after the lifetime passed.
    const shown = restartWith({ requestId: 'perm-toolu_f1954_late', requestedAt: Date.now() - 60_000 }, 'anthropic')
    expect(projectedIds(shown)).toEqual(['perm-toolu_f1954_late'])
    shown.managed.pendingApproval!.requestedAt = Date.now() - 10 * 60_000
    const beforeAllow = shown.forwarded.length
    expect(shown.internals.respondToPermission(shown.managed.id, 'perm-toolu_f1954_late', true, false, undefined, WS_ID)).toBe(true)
    expect(shown.managed.pendingApproval).toBeUndefined()
    expect((shown.managed as Record<string, unknown>).restartApprovalAnswer).toBeUndefined()
    expect(shown.forwarded.slice(beforeAllow).some(event => event.type === 'info' && event.level === 'warning')).toBe(true)
  })
})

describe('F1.954 — CONTROLS', () => {
  it('F1.900: a card survives an ORDINARY turn end, stays counted and persisted, and its Allow reaches the hook', async () => {
    const rig = claudeRig()
    const { requestId, answer } = await pendingWorkerCard(rig, 'toolu_f1954_survives')
    await startTurn(rig.agent, 'While that runs, please reply with the single word READY.')
    expect(rig.internals.pendingPermissionRequests.has(requestId)).toBe(true)
    expect(rig.internals.awaitingApprovalCount(rig.managed)).toBe(1)
    expect(rig.managed.pendingApproval?.requestId).toBe(requestId)

    expect(rig.internals.respondToPermission(rig.managed.id, requestId, true, false, undefined, WS_ID)).toBe(true)
    expect(decisionOf(await answer)).toBe('allow')
    expect(rig.internals.awaitingApprovalCount(rig.managed)).toBe(0)
    expect(rig.managed.pendingApproval).toBeUndefined()
  })

  it('F1.541: Stop Task (the CLI abandons the hook call) still withdraws the card from the host', async () => {
    const rig = claudeRig()
    const call = new AbortController()
    const { requestId, answer } = await pendingWorkerCard(rig, 'toolu_f1954_stoptask', call.signal)
    call.abort()
    expect(decisionOf(await answer)).toBe('deny')
    await until(() => !rig.internals.pendingPermissionRequests.has(requestId), 'the Stop Task withdrawal')
    expect(rig.managed.pendingApproval).toBeUndefined()
    expect(cancelledIds(rig)).toEqual([requestId])
  })

  it('F1.527: an unanswered card whose waiter is alive is still withdrawn by the runtime\'s own deadline', async () => {
    const rig = claudeRig()
    ;(rig.agent as unknown as { permissionCardBudgetMs: number }).permissionCardBudgetMs = 100
    const { requestId, answer } = await pendingWorkerCard(rig, 'toolu_f1954_deadline')
    expect(decisionOf(await answer)).toBe('deny')
    await until(() => !rig.internals.pendingPermissionRequests.has(requestId), 'F1.527\'s withdrawal')
    expect(rig.managed.pendingApproval).toBeUndefined()
    expect(cancelledIds(rig)).toEqual([requestId])
  })

  it('a FRESH claude record (a genuinely pending main-thread card) is still re-shown after a restart', () => {
    const fresh = restartWith({ requestId: 'perm-toolu_f1954_fresh', requestedAt: Date.now() - 60_000 }, 'anthropic')
    expect(projectedIds(fresh)).toEqual(['perm-toolu_f1954_fresh'])
    expect(fresh.managed.pendingApproval?.requestId).toBe('perm-toolu_f1954_fresh')
  })

  it('Pi is unchanged: an old Pi record is still re-shown, and an agent reporting no card lifetime arms no sweep', async () => {
    const pi = restartWith({ requestId: 'pi-approval-f1954', requestedAt: Date.now() - 20 * 60_000 }, 'pi')
    expect(projectedIds(pi)).toEqual(['pi-approval-f1954'])

    const rig = hostRig()
    rig.internals.runtimeCardOrphanSweepGraceMs = 0
    rig.managed.agent = { respondToPermission: () => {} } // no `permissionCardLifetimeMs`: Pi's and codex's shape
    rig.internals.handleAgentPermissionRequest(rig.managed, {
      requestId: 'pi-approval-live', toolName: 'Bash', command: COMMAND, description: `Execute: ${COMMAND}`, type: 'bash',
    })
    expect(rig.internals.pendingPermissionRequests.has('pi-approval-live')).toBe(true)
    await tick(250)
    expect(rig.internals.pendingPermissionRequests.has('pi-approval-live')).toBe(true)
    expect(rig.managed.pendingApproval?.requestId).toBe('pi-approval-live')
  })
})

describe('F1.975 — a claude child stopped inside the app takes its cards off the host, and the chat is told why', () => {
  function warnings(rig: Rig): string[] {
    return rig.forwarded.filter(event => event.type === 'info' && event.level === 'warning').map(event => String(event.message))
  }

  it('an in-app teardown between turns (SIT-an1\'s trust revoke) withdraws the worker\'s card, its count, its durable copy, and posts the reason', async () => {
    const rig = claudeRig()
    const { requestId, answer } = await pendingWorkerCard(rig, 'toolu_f1975_revoke')

    await rig.internals.disposeManagedAgentRuntime(rig.managed, 'project trust blocked')

    expect(decisionOf(await answer)).toBe('deny') // the child's waiter was refused by its own teardown
    // THE DEFECT: all four stayed — the record, the count, the persisted copy, and silence.
    expect(rig.internals.pendingPermissionRequests.has(requestId)).toBe(false)
    expect(rig.internals.awaitingApprovalCount(rig.managed)).toBe(0)
    expect(rig.managed.pendingApproval).toBeUndefined()
    expect(cancelledIds(rig)).toEqual([requestId])
    const notices = warnings(rig)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(COMMAND)
    expect(notices[0]).toContain('project trust blocked')
    // An Allow that arrives anyway answers nothing and re-drives nothing: the record is gone.
    expect(rig.internals.respondToPermission(rig.managed.id, requestId, true, false, undefined, WS_ID)).toBe(false)
  })

  // F1.1246 (the final sitting's D-8) — the line was only sent, never stored, so a reload lost the one explanation.
  it('F1.1246: the line is a stored warning row, written to disk after it, so it survives a reload', async () => {
    const rig = claudeRig()
    const { requestId } = await pendingWorkerCard(rig, 'toolu_f1246_persist')
    const managed = rig.managed as Managed & { ephemeral?: boolean; messages: Array<{ role: string; infoLevel?: string; content: string }> }
    managed.ephemeral = false // the rig's session is ephemeral; a user's chat is not, and only it is written to disk
    const storedAtPersist: string[][] = []
    rig.internals.persistSession = () => {
      storedAtPersist.push(managed.messages.filter(row => row.role === 'info' && row.infoLevel === 'warning').map(row => row.content))
    }

    await rig.internals.disposeManagedAgentRuntime(rig.managed, 'project trust blocked')

    expect(cancelledIds(rig)).toEqual([requestId])
    const rows = managed.messages.filter(row => row.role === 'info' && row.infoLevel === 'warning' && row.content.includes(COMMAND))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toContain('project trust blocked')
    expect(warnings(rig).filter(line => line.includes(COMMAND))).toEqual([rows[0]!.content]) // the line sent is the line stored
    // The LAST write carries the row, so the line is on disk, not only in this process's memory.
    expect(storedAtPersist.at(-1)?.filter(line => line.includes(COMMAND))).toEqual([rows[0]!.content])
  })

  it('BOUNDARY: the app-exit drain keeps the record and its durable copy; F1.961 — and the relaunch EXPIRES a record a subagent raised (R7 re-shows main-thread records, the F1.961 CONTROL)', async () => {
    const rig = claudeRig()
    const { requestId, answer } = await pendingWorkerCard(rig, 'toolu_f1975_quit')
    const stored = (rig.managed as unknown as { messages: Array<{ role: string }> }).messages
    const appExit = (SessionManager as unknown as { appExitTeardownReason: string }).appExitTeardownReason
    expect(appExit).toBe('session manager cleanup') // the reason `cleanup()` drains every session with

    await rig.internals.disposeManagedAgentRuntime(rig.managed, appExit)

    expect(decisionOf(await answer)).toBe('deny')
    expect(rig.managed.pendingApproval?.requestId).toBe(requestId)
    expect(cancelledIds(rig)).toEqual([])
    expect(warnings(rig)).toEqual([])
    expect(stored.filter(row => row.role === 'info')).toEqual([]) // F1.1246 — nor a stored line

    // F1.961 supersedes the relaunch half as it applied to a WORKER's record:
    // the drain still keeps it (this half is F1.975's own claim), but the
    // worker died with the previous process, so the re-projection expires it
    // instead of re-showing it — and the R7 re-show holds for MAIN-THREAD
    // records, which the F1.961 CONTROL pins.
    const relaunched = hostRig()
    relaunched.managed.pendingApproval = rig.managed.pendingApproval
    relaunched.internals.reprojectPendingApproval(relaunched.managed)
    expect(projectedIds(relaunched)).toEqual([])
    expect(relaunched.managed.pendingApproval).toBeUndefined()
  })
})

describe('F1.993 — a claude child stopped DURING a live turn is named too, not only withdrawn', () => {
  function warnings(rig: Rig): string[] {
    return rig.forwarded.filter(event => event.type === 'info' && event.level === 'warning').map(event => String(event.message))
  }

  /** The worker's card pending, then a turn the test holds open — the state the drain meets in SIT-an1's live arm. */
  async function cardDuringLiveTurn(rig: Rig & { agent: RealClaudeAgent }, toolUseId: string) {
    // The rig's session has no connection, so it would resolve to the default runtime (Pi) and take the Pi drain.
    rig.internals.resolveManagedProvider = () => 'anthropic'
    const card = await pendingWorkerCard(rig, toolUseId)
    const turn = heldTurn()
    const turnEvents = startTurn(rig.agent, 'Please write a detailed 800-word essay about the history of pears')
    await turn.opened
    await until(() => rig.agent.isProcessing(), 'the live turn to open')
    rig.managed.isProcessing = true
    return { ...card, finish: async () => { turn.end(); await turnEvents } }
  }

  it('an in-app teardown during a live turn (the drain interrupts first) withdraws the card once and posts the reason', async () => {
    const rig = claudeRig()
    const { requestId, answer, finish } = await cardDuringLiveTurn(rig, 'toolu_f1993_drain')

    // Positive control on the route: the notice comes from the claude branch, not from the Pi drain.
    const piDrain = mock(async () => {})
    ;(rig.internals as unknown as { strictDrainPiSession: typeof piDrain }).strictDrainPiSession = piDrain
    await rig.internals.strictDrainSessionForMutation(rig.managed, 'project trust blocked', true)
    await finish()
    expect(piDrain).not.toHaveBeenCalled()

    expect(decisionOf(await answer)).toBe('deny')
    expect(rig.internals.pendingPermissionRequests.has(requestId)).toBe(false)
    expect(rig.internals.awaitingApprovalCount(rig.managed)).toBe(0)
    expect(rig.managed.pendingApproval).toBeUndefined()
    expect(cancelledIds(rig)).toEqual([requestId])
    // THE DEFECT: the Stop path withdrew the card first, so the dispose found nothing held and said nothing.
    const notices = warnings(rig)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(COMMAND)
    expect(notices[0]).toContain('project trust blocked')
  })

  it('BOUNDARY: the user\'s own Stop during a live turn withdraws the card with no teardown line (F1.954 unchanged)', async () => {
    const rig = claudeRig()
    const { requestId, answer, finish } = await cardDuringLiveTurn(rig, 'toolu_f1993_userstop')

    await rig.manager.cancelProcessing(rig.managed.id, false, WS_ID)
    rig.managed.isProcessing = false
    await finish()

    expect(decisionOf(await answer)).toBe('deny')
    expect(rig.internals.pendingPermissionRequests.has(requestId)).toBe(false)
    expect(cancelledIds(rig)).toEqual([requestId])
    expect(warnings(rig).filter(line => line.includes(COMMAND))).toEqual([])
  })
})

describe('F1.962 — a claude session death (not a dispose) takes its cards off the host at once', () => {
  function warnings(rig: Rig): string[] {
    return rig.forwarded.filter(event => event.type === 'info' && event.level === 'warning').map(event => String(event.message))
  }

  it('a capability revoke ends the child: the worker\'s card, its count and its durable copy leave at once, and the chat names it', async () => {
    type Listener = (event: { scope: { kind: string }; effect: string; revokedLeaseIds: string[]; reason?: string }) => void
    let listener: Listener | undefined
    const rig = claudeRig({ subscribeInvalidation: (next: Listener) => { listener = next; return () => { listener = undefined } } } as never)
    const { requestId, answer } = await pendingWorkerCard(rig, 'toolu_f1962_revoke')
    ;(rig.managed as { capabilityLeaseId?: string }).capabilityLeaseId = 'lease-f1962'

    listener!({ scope: { kind: 'global' }, effect: 'revoke-active-snapshot', revokedLeaseIds: ['lease-f1962'], reason: 'plugin uninstall (local.toolkit-1)' })

    expect(decisionOf(await answer)).toBe('deny') // the killed child's waiter was refused
    // THE DEFECT: the record, the count and the persisted copy stood until F1.954's sweep, with no word.
    expect(rig.internals.pendingPermissionRequests.has(requestId)).toBe(false)
    expect(rig.internals.awaitingApprovalCount(rig.managed)).toBe(0)
    expect(rig.managed.pendingApproval).toBeUndefined()
    expect(cancelledIds(rig)).toEqual([requestId])
    const named = warnings(rig).filter(line => line.includes(COMMAND))
    expect(named).toHaveLength(1)
    expect(named[0]).toContain('plugin uninstall (local.toolkit-1)')
    // A late Allow reaches the kept agent, which holds no waiter, and re-drives nothing: no durable record to honour.
    expect(rig.agent.heldPermissionRequestIds).toEqual([])
    rig.internals.respondToPermission(rig.managed.id, requestId, true, false, undefined, WS_ID)
    expect(rig.managed.pendingApproval).toBeUndefined()
    expect((rig.managed as Record<string, unknown>).restartApprovalAnswer).toBeUndefined()
  })

  it('a session death the runtime performs itself (the redirect fallback between turns) withdraws the card at once', async () => {
    const rig = claudeRig()
    const { requestId, answer } = await pendingWorkerCard(rig, 'toolu_f1962_redirect')

    rig.agent.forceAbort(AbortReason.Redirect) // no turn open: `killLiveSession`, the child ends, the agent stays

    expect(decisionOf(await answer)).toBe('deny')
    expect(rig.internals.pendingPermissionRequests.has(requestId)).toBe(false)
    expect(rig.internals.awaitingApprovalCount(rig.managed)).toBe(0)
    expect(rig.managed.pendingApproval).toBeUndefined()
    expect(cancelledIds(rig)).toEqual([requestId])
  })

  it('BOUNDARY: `destroy` (every dispose, the app exit included) still withdraws nothing by itself — the host decides (R7, F1.975)', async () => {
    const rig = claudeRig()
    const { requestId, answer } = await pendingWorkerCard(rig, 'toolu_f1962_destroy')

    rig.agent.destroy()

    expect(decisionOf(await answer)).toBe('deny')
    expect(rig.internals.pendingPermissionRequests.has(requestId)).toBe(true)
    expect(rig.managed.pendingApproval?.requestId).toBe(requestId)
    expect(cancelledIds(rig)).toEqual([])
    expect(warnings(rig)).toEqual([])
  })
})

/**
 * F1.961 (origin WJ-crit-ppp P-1, 2026-09-25 — the gap F1.954's own docblock
 * states) — F1.954 expires a restored claude record by AGE alone, so a
 * background worker's card persisted LESS than 540 s before a quit still comes
 * back after the restart, and its Allow re-drives the PARENT's turn with the
 * record's grant: the record never said a subagent raised it. The fix carries
 * the hook's identity (claude's `canUseTool` already receives the SDK's
 * `agentID`, C3.370, riding the request as `agentLabel`) into the persisted
 * record as an additive `raisedBySubagent` flag, and both F1.954 gates —
 * `reprojectPendingApproval` and `settleDurableApproval` — treat a stamped
 * record exactly like an aged one: the worker is gone with the previous
 * process, so nothing may re-drive.
 */
describe('F1.961 — a restored record a subagent raised is expired, not re-shown', () => {
  it('PREMISE: the real hook carry stamps the persisted record with the raising subagent', async () => {
    const rig = claudeRig()
    const { requestId } = await pendingWorkerCard(rig, 'toolu_f1961_carry')
    const record = rig.managed.pendingApproval
    expect(record?.requestId).toBe(requestId)
    // RED at HEAD: the record answered "who raised this" with nothing.
    expect((record as { raisedBySubagent?: boolean } | undefined)?.raisedBySubagent).toBe(true)
  });

  it('a restored record a subagent raised is not re-shown — expired with the warning, nothing projected', () => {
    const rig = restartWith({ requestId: 'perm-toolu_f1961_young', requestedAt: Date.now(), raisedBySubagent: true }, 'anthropic')
    // RED at HEAD: the young record passed both age gates and came back live.
    expect(projectedIds(rig)).toEqual([])
    expect(rig.managed.pendingApproval).toBeUndefined()
    expect(rig.forwarded.some(event => event.type === 'info' && event.level === 'warning')).toBe(true)
  });

  it('a late Allow on a subagent record settles as a denial and re-drives nothing', () => {
    const rig = restartWith({ requestId: 'perm-toolu_f1961_allow', requestedAt: Date.now(), raisedBySubagent: true }, 'anthropic')
    rig.internals.reprojectPendingApproval(rig.managed) // idempotent; the record is already gone after the gate
    // The record was expired at re-projection, so a stale client's Allow
    // delivers to nothing: respond answers false, and THE re-drive — the row's
    // measured harm, which carried the grant into the parent's next turn at
    // HEAD — never happens.
    expect(rig.internals.respondToPermission(rig.managed.id, 'perm-toolu_f1961_allow', true, false, undefined, WS_ID)).toBe(false)
    expect(rig.managed.pendingApproval).toBeUndefined()
    expect((rig.managed as Record<string, unknown>).restartApprovalAnswer).toBeUndefined()
    expect(rig.forwarded.some(event => event.type === 'info' && event.level === 'warning')).toBe(true)
  });

  it('CONTROL: a main-thread record (no stamp) is still re-shown, and its Allow still re-drives', () => {
    const rig = restartWith({ requestId: 'perm-toolu_f1961_main', requestedAt: Date.now() }, 'anthropic')
    expect(projectedIds(rig)).toEqual(['perm-toolu_f1961_main'])
    expect(rig.managed.pendingApproval).toBeDefined()
    expect(rig.internals.respondToPermission(rig.managed.id, 'perm-toolu_f1961_main', true, false, undefined, WS_ID)).toBe(true)
    expect((rig.managed as Record<string, unknown>).restartApprovalAnswer).toBeDefined()
    expect(rig.forwarded.some(event => event.type === 'info' && event.level === 'warning')).toBe(false)
  });

  it('and the settle gate itself: an Allow on a stamped record that SKIPPED re-projection settles as a denial, re-driving nothing', () => {
    // The arm above answers a record the re-projection already expired, so its Allow returns false at the
    // empty-record path. This one skips re-projection, so the LIVE record reaches `settleDurableApproval`'s own
    // F1.961 arm — the gate an answer can meet before the next startup's re-projection reads the record.
    const rig = hostRig()
    rig.internals.resolveManagedProvider = () => 'anthropic'
    ;(rig.internals as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => {}
    rig.managed.pendingApproval = {
      schemaVersion: 1,
      toolName: 'Bash',
      description: `Execute: ${COMMAND}`,
      type: 'bash',
      command: COMMAND,
      rememberForMinutes: 10,
      commandHash: 'hash-f1-954',
      requestId: 'perm-toolu_f1961_settle',
      requestedAt: Date.now(),
      raisedBySubagent: true,
    } as Managed['pendingApproval']
    expect(rig.internals.respondToPermission(rig.managed.id, 'perm-toolu_f1961_settle', true, false, undefined, WS_ID)).toBe(true)
    expect(rig.managed.pendingApproval).toBeUndefined()
    expect((rig.managed as Record<string, unknown>).restartApprovalAnswer).toBeUndefined() // nothing re-drove
    expect(rig.forwarded.some(event => event.type === 'info' && event.level === 'warning')).toBe(true)
  });
});
