/**
 * UA4.2 — child posture (spec §11 "Conductor" item 2, OQ-7; plan UA4.2 "Tests"): a Conductor child runs under the
 * orchestrator's LIFETIME ceiling, managed normalisation included, and upstream's `allow-all` default stays gone.
 *
 * The formula the spec names — `normalize(child, clampPermissionModeToParent(requested, normalize(orch, orch.mode)))`
 * — is held at two doors, and both are driven here through the real code:
 * - at DISPATCH, `TaskRunner.dispatch` clamps the node's mode to the orchestrator's, and `SessionManager.createSession`
 *   (the create door, P6.685) normalises the result against the managed `disabledPermissionModes`;
 * - for the node's LIFETIME, every later mode change (the RPC funnel `setSessionPermissionMode`, the agent's own
 *   `onPermissionModeChange`) goes through `SessionManager.clampChildPermissionModeToParent`, whose ceiling keys are
 *   `piParentSessionKey` and — UA4.2 — a Conductor child's `parentSessionId` (a session carrying `taskNodeId`).
 *
 * Positive: `acceptEdits` under a `default` orchestrator clamps to `default` (dispatch and a later change); a narrower
 * request is kept; an unset node mode under a `bypassPermissions` orchestrator is `bypassPermissions`.
 * Negative: an unset mode never yields bypass unless the orchestrator is bypass; lowering the orchestrator to `plan`
 * mid-run caps the node's NEXT mode change (the plan's `explore` left with F1.1050; `plan` is the narrowest mode a
 * human can pick in the composer); a live orchestrator with no recorded mode caps the node at `default` at dispatch
 * AND for every later change (the host's own reading of an unset mode); a managed-disabled bypass never yields a
 * bypass child, at dispatch or later; the test fails if `AUTONOMOUS_DEFAULT_MODE` returns to `TaskRunner.ts`.
 * Boundaries (each a stated decision): a quick-add subtask (`parentSessionId` with no `taskNodeId`, created by the
 * user from a tile) is NOT a Conductor child and keeps its own mode; a node whose orchestrator is gone has no live
 * ceiling (it is an ordinary session now — no creation-time ceiling is recorded for a Conductor child).
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types'
import { parseManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import type { CreateSessionOptions } from '@nessy-agent/shared/protocol'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { parseTaskSpec, saveTaskSpec, type TaskSpec } from '@nessy-agent/shared/tasks'
// UA12.129 — the CASE-shaped budget: every use below is the third argument of an `it()` case, and
// F1.668 refuses the hook-shaped name there. Measured 2026-10-03 (junit): largest case 109.89 ms,
// ~2700x under CASE's 300 000 — the old 600 000 was the hook name mis-describing the shape, never a
// ceiling a case needed.
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import type { SessionCompletionEvent, SessionManager } from '../../sessions/SessionManager'
import { createTestSessionManager } from '../../sessions/__tests__/test-session-manager.ts'
import { TaskRunner } from '../TaskRunner'
import { createSessionConductorHost, type ConductorSessionManager } from '../conductor-host'

const roots: string[] = []
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })
/**
 * UA12.190 (P-LF-4-2) — wait on the FACT with a time budget (the `waitFor` shape of tasks-generate.test.ts), never a
 * tick count: 100 `setTimeout(0)` ticks ran out while a child's createSession was still answering under concurrent
 * load (2 588 ms, 2026-10-09; 147 ms here against a 1 500 ms host). Returns whether the fact held in time.
 */
const CHILD_WAIT_BUDGET_MS = 30_000
async function waitFor(fact: () => boolean, budgetMs = CHILD_WAIT_BUDGET_MS): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (!fact()) {
    if (Date.now() >= deadline) return false
    await new Promise<void>((r) => setTimeout(r, 5))
  }
  return true
}

function specOf(raw: unknown): TaskSpec {
  const r = parseTaskSpec(raw)
  if (!r.success) throw new Error('bad fixture: ' + JSON.stringify(r.error.issues))
  return r.data
}

/** The turn machinery a Conductor needs, inert: every send is delivered and never completes. */
function inertTurns() {
  const listeners = new Set<(evt: SessionCompletionEvent) => void>()
  return {
    sendMessage: (_id: string, _m: string, _a: unknown, _b: unknown, _o: unknown, _c: unknown, _d: unknown, onAck?: (id: string) => void) => {
      onAck?.('m')
      return new Promise<void>(() => {})
    },
    setSessionStatus: async () => {},
    setKanbanColumn: async () => {},
    setTaskNodeCount: async () => {},
    cancelProcessing: async () => {},
    onSessionComplete: (l: (evt: SessionCompletionEvent) => void) => { listeners.add(l); return () => { listeners.delete(l) } },
    getPiHarnessRuntimeSnapshot: async () => ({ settlement: { settled: true } }),
    listSessionScheduledWork: () => ({ crons: [], tasks: [] }),
  }
}

/** A Conductor over a REAL SessionManager's create/list/announce (no backend runs in this process). */
function conductorOver(real: SessionManager, workspaceId: string, spec: Record<string, unknown>, createDelayMs = 0) {
  const root = mkdtempSync(join(tmpdir(), 'ua4-2-posture-'))
  roots.push(root)
  saveTaskSpec(root, specOf(spec))
  const created: CreateSessionOptions[] = []
  const host = {
    ...inertTurns(),
    createSession: (ws: string, options: CreateSessionOptions) => {
      created.push(options)
      // UA12.190 — a loaded host: the child's createSession answers late.
      return createDelayMs ? new Promise(r => setTimeout(r, createDelayMs)).then(() => real.createSession(ws, options)) : real.createSession(ws, options)
    },
    announceSessionCreated: real.announceSessionCreated.bind(real),
    getSessions: real.getSessions.bind(real),
    getProjectHandleService: real.getProjectHandleService.bind(real),
  } as unknown as ConductorSessionManager
  const runner = new TaskRunner({ host: createSessionConductorHost(host, { workspaceId, workspaceRoot: root }), workspaceId, workspaceRoot: root })
  return { runner, created }
}

async function runOneNode(real: SessionManager, workspaceId: string, orchestratorId: string, slug: string, node: Record<string, unknown>, createDelayMs = 0) {
  const { runner, created } = conductorOver(real, workspaceId, { id: slug, title: slug, goal: 'g', nodes: [{ id: 'a', prompt: 'a', ...node }] }, createDelayMs)
  await runner.run(slug, { runId: 'r1', orchestratorSessionId: orchestratorId })
  await waitFor(() => !!runner.getRunState(slug, 'r1')?.nodes[0]?.sessionId)
  const childId = runner.getRunState(slug, 'r1')!.nodes[0]!.sessionId!
  expect(childId).toBeTruthy()
  return { childId, requested: created[0]?.permissionMode }
}

/** The session's own record (planted sessions carry only the fields a mode change reads). */
const modeOf = (real: SessionManager, workspaceId: string, id: string): PermissionMode | undefined => (real as any).getManaged(id, workspaceId)?.permissionMode

describe('UA4.2 — a Conductor child at DISPATCH (TaskRunner → the real createSession)', () => {
  it('POSITIVE — acceptEdits under a default orchestrator clamps to default; a narrower plan is kept', async () => {
    const real = createTestSessionManager()
    const ws = 'ws-ua4-2-dispatch'
    const orch = await real.createSession(ws, { name: 'orch', permissionMode: 'default' })
    const wide = await runOneNode(real, ws, orch.id, 'wide', { permissionMode: 'acceptEdits' })
    expect(modeOf(real, ws, wide.childId)).toBe('default')
    const narrow = await runOneNode(real, ws, orch.id, 'narrow', { permissionMode: 'plan' })
    expect(modeOf(real, ws, narrow.childId)).toBe('plan')
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  it('NEGATIVE — an unset mode never yields bypass unless the orchestrator is bypass', async () => {
    const real = createTestSessionManager()
    const ws = 'ws-ua4-2-unset'
    for (const orchMode of ['dontAsk', 'plan', 'default', 'acceptEdits', 'auto'] as PermissionMode[]) {
      const orch = await real.createSession(ws, { name: `orch-${orchMode}`, permissionMode: orchMode })
      const { childId } = await runOneNode(real, ws, orch.id, `unset-${orchMode.toLowerCase()}`, {})
      expect(modeOf(real, ws, childId)).toBe(orchMode)
    }
    // The one orchestrator under which an unset node IS bypass: a bypass orchestrator (the user activated it).
    const bypass = await real.createSession(ws, { name: 'orch-bypass', permissionMode: 'bypassPermissions' })
    const { childId } = await runOneNode(real, ws, bypass.id, 'unset-bypass', {})
    expect(modeOf(real, ws, childId)).toBe('bypassPermissions')
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  it('NEGATIVE — an orchestrator with no recorded mode caps its nodes at default, the host\'s own reading of an unset mode', async () => {
    const real = createTestSessionManager()
    const ws = 'ws-ua4-2-unrecorded'
    const orch = await real.createSession(ws, { name: 'orch', permissionMode: 'default' })
    // A record that never carried a mode (the host reads it as `default` everywhere: `managed.permissionMode ?? 'default'`).
    delete (real as any).getManaged(orch.id, ws).permissionMode
    const { childId, requested } = await runOneNode(real, ws, orch.id, 'unrecorded', { permissionMode: 'bypassPermissions' })
    expect(requested).toBe('default')
    expect(modeOf(real, ws, childId)).toBe('default')
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  it('NEGATIVE — a managed-disabled bypass never yields a bypass child, even under a stale bypass orchestrator', async () => {
    const real = createTestSessionManager({
      managedPiPolicy: parseManagedPiPolicyV1({ schemaVersion: 1, disabledPermissionModes: ['bypassPermissions'] }),
    })
    const ws = 'ws-ua4-2-managed'
    const orch = await real.createSession(ws, { name: 'orch', permissionMode: 'bypassPermissions' })
    expect(modeOf(real, ws, orch.id)).toBe('auto') // the create door already normalised the orchestrator
    // A stale record (persisted before the policy arrived): the dispatch ceiling reads bypass.
    ;(real as any).getManaged(orch.id, ws).permissionMode = 'bypassPermissions'
    const { childId, requested } = await runOneNode(real, ws, orch.id, 'managed', { permissionMode: 'bypassPermissions' })
    expect(requested).toBe('bypassPermissions') // what the Conductor asked for …
    expect(modeOf(real, ws, childId)).toBe('auto') // … and what the create door let it be
    // A later change cannot get there either.
    real.setSessionPermissionMode(childId, 'bypassPermissions', ws)
    expect(modeOf(real, ws, childId)).not.toBe('bypassPermissions')
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)
})

describe('UA4.2 — a Conductor child for its LIFETIME (clampChildPermissionModeToParent, parentSessionId key)', () => {
  it('POSITIVE — a later acceptEdits request under a default orchestrator resolves to default', async () => {
    const real = createTestSessionManager()
    const ws = 'ws-ua4-2-life'
    const orch = await real.createSession(ws, { name: 'orch', permissionMode: 'default' })
    const { childId } = await runOneNode(real, ws, orch.id, 'life', { permissionMode: 'plan' })
    real.setSessionPermissionMode(childId, 'acceptEdits', ws)
    expect(modeOf(real, ws, childId)).toBe('default')
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  it('NEGATIVE — lowering the orchestrator to plan mid-run caps the node\'s next mode change', async () => {
    const real = createTestSessionManager()
    const ws = 'ws-ua4-2-lower'
    const orch = await real.createSession(ws, { name: 'orch', permissionMode: 'acceptEdits' })
    const { childId } = await runOneNode(real, ws, orch.id, 'lower', {})
    expect(modeOf(real, ws, childId)).toBe('acceptEdits')
    real.setSessionPermissionMode(orch.id, 'plan', ws)
    real.setSessionPermissionMode(childId, 'default', ws)
    expect(modeOf(real, ws, childId)).toBe('plan')
    // The agent's own mode change (a plan-exit restore, a runtime echo) funnels through the same clamp.
    const managed = (real as any).getManaged(childId, ws)
    expect((real as any).clampChildPermissionModeToParent(managed, 'bypassPermissions')).toBe('plan')
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  it('NEGATIVE — a live orchestrator with no recorded mode caps every later change at default, as at dispatch', async () => {
    const real = createTestSessionManager()
    const ws = 'ws-ua4-2-life-unrecorded'
    const orch = await real.createSession(ws, { name: 'orch', permissionMode: 'default' })
    // A record that never carried a mode (an older chat bound as the orchestrator); the host reads it as `default`.
    delete (real as any).getManaged(orch.id, ws).permissionMode
    const { childId } = await runOneNode(real, ws, orch.id, 'life-unrecorded', {})
    expect(modeOf(real, ws, childId)).toBe('default') // dispatch (749302025)
    real.setSessionPermissionMode(childId, 'auto', ws)
    expect(modeOf(real, ws, childId)).toBe('default')
    const managed = (real as any).getManaged(childId, ws)
    expect((real as any).clampChildPermissionModeToParent(managed, 'bypassPermissions')).toBe('default')
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)
})

describe('UA12.190 — the child wait is a time budget on the fact, not a tick count', () => {
  it('BOUNDARY — a child whose createSession answers late (a loaded host, 1 500 ms) is still awaited', async () => {
    const real = createTestSessionManager()
    const ws = 'ws-ua12-190-late'
    const orch = await real.createSession(ws, { name: 'orch', permissionMode: 'default' })
    const { childId } = await runOneNode(real, ws, orch.id, 'late', {}, 1_500)
    expect(modeOf(real, ws, childId)).toBe('default')
    real.cleanup()
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  it('NEGATIVE — a fact that never holds gives up at its budget instead of waiting the case out', async () => {
    const started = Date.now()
    expect(await waitFor(() => false, 50)).toBe(false)
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(50)
    expect(waited).toBeLessThan(5_000)
  })
})

describe('UA4.2 — boundaries of the ceiling key (stated decisions)', () => {
  const workspaceId = 'ws-ua4-2-planted'
  const plant = (real: SessionManager, session: Record<string, unknown>) => {
    ;(real as any).sessions.set(encodeSessionKey({ workspaceId, sessionId: session.id as string }), {
      workspace: { id: workspaceId }, messagesLoaded: true, messages: [], ...session,
    })
    ;(real as any).persistSession = () => {}
  }

  it('a quick-add subtask (parentSessionId, no taskNodeId) is not a Conductor child and keeps its own mode', () => {
    const real = createTestSessionManager()
    plant(real, { id: 'orch', permissionMode: 'default' })
    plant(real, { id: 'quick', permissionMode: 'default', parentSessionId: 'orch' })
    plant(real, { id: 'node', permissionMode: 'default', parentSessionId: 'orch', taskSlug: 't', taskRunId: 'r', taskNodeId: 'a' })
    real.setSessionPermissionMode('quick', 'auto', workspaceId)
    real.setSessionPermissionMode('node', 'auto', workspaceId)
    expect(modeOf(real, workspaceId, 'quick')).toBe('auto')
    expect(modeOf(real, workspaceId, 'node')).toBe('default') // control: the same request on a Conductor child
    real.cleanup()
  })

  it('a node whose orchestrator is gone has no live ceiling', () => {
    const real = createTestSessionManager()
    plant(real, { id: 'orphan', permissionMode: 'default', parentSessionId: 'deleted-orch', taskSlug: 't', taskRunId: 'r', taskNodeId: 'a' })
    real.setSessionPermissionMode('orphan', 'auto', workspaceId)
    expect(modeOf(real, workspaceId, 'orphan')).toBe('auto')
    real.cleanup()
  })
})

describe('UA4.2 — upstream\'s allow-all default does not return', () => {
  /** TaskRunner.ts with comments removed — the header and item 3 NAME the constant to say it is gone. */
  const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  const FORBIDDEN = [/\bAUTONOMOUS_DEFAULT_MODE\b/, /['"`]allow-all['"`]/, /['"`]bypassPermissions['"`]/]

  it('the instrument reads code: it finds the clamp call, and it catches the constant in a planted line', () => {
    const runner = code(readFileSync(join(import.meta.dir, '..', 'TaskRunner.ts'), 'utf8'))
    expect(runner).toContain('clampPermissionModeToParent(requested, bound)') // UA12.78 named the clamped ceiling `bound`
    const planted = code(`${runner}\nconst AUTONOMOUS_DEFAULT_MODE = 'allow-all';\n`)
    expect(FORBIDDEN.some(re => re.test(planted))).toBe(true)
    expect(FORBIDDEN.some(re => re.test(code(`${runner}\nconst x = 'bypassPermissions';\n`)))).toBe(true)
  })

  it('NEGATIVE — TaskRunner.ts names no AUTONOMOUS_DEFAULT_MODE, allow-all or bypassPermissions literal outside its comments', () => {
    const runner = code(readFileSync(join(import.meta.dir, '..', 'TaskRunner.ts'), 'utf8'))
    for (const re of FORBIDDEN) expect(re.test(runner)).toBe(false)
  })
})
