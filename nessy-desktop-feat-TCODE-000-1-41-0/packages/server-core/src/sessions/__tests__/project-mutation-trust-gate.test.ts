/**
 * P3.325 — a working-directory bind on a directory the app has NO trust
 * decision for must RETURN. It must not wait for the trust gate it raises.
 *
 * ## What the row claimed, and what this file measures
 *
 * W2-p8 (2026-09-03) recorded: *"`updateWorkingDirectory` deadlocks on the trust
 * gate it raises — every CDP case answers that gate on a line the `await` makes
 * unreachable"*, and prescribed one of two fixes — return before the gate, or
 * answer the gate from the RPC that raised it.
 *
 * Read at the site, neither is owed, and this file is the proof rather than the
 * assertion. `mutateWorkingDirectory` awaits exactly five things — a prior
 * runtime refresh, the project handle, the strict drain, the runtime cwd
 * transaction, and the session flush — and **not one of them is a user
 * decision**. `ProjectHandleService.resolveHandle` reads the stored trust
 * decision and returns it as a field; nothing on the path blocks on `'unknown'`.
 * The gate is raised afterwards and elsewhere: `ChatPage`'s effect sees the new
 * `workingDirectory`, calls `validateProjectDirectory`, and opens
 * `ProjectTrustDialog` — a renderer modal, downstream of the RPC's reply.
 *
 * So the mechanism the row named is REFUTED, and the deadlock the harness met
 * was its own ordering (`pkg-4.ts` now issues the bind without awaiting it). The
 * 30 s `Request timeout` on a mutation that had LANDED belongs to P3.326: the
 * sessions projection was O(all sessions) with a per-session disk read, and a
 * main process spending seconds inside `getSessions()` cannot reply to
 * `sessions:command` either.
 *
 * A refutation decays into folklore unless something keeps measuring it, which
 * is what these two cases are: each binds a directory whose trust state is
 * `'unknown'` — asserted, so the gate really would be raised — and fails if the
 * mutation does not settle inside a budget far below any RPC timeout.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectTrustStore } from '@nessy-agent/shared/capabilities/project-trust-store'
import { ProjectHandleService } from '@nessy-agent/shared/projects/project-handle-service'
import { RecentProjectStore } from '@nessy-agent/shared/projects/recent-store'
import { createManagedSession } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

/**
 * Well under Electron's own 30 s `sessions:command` budget and far above the
 * work these paths actually do (no agent, no runtime transaction). A budget set
 * at the resting floor would manufacture its own failure under wave load; this
 * one only fires on a WAIT.
 */
const SETTLE_BUDGET_MS = 10_000

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), 'nessy-trust-gate-'))
  roots.push(stateRoot)
  const projectPath = join(stateRoot, 'project')
  mkdirSync(projectPath)
  // A trust store with NO recorded decision for this path — the state that puts
  // the modal on screen.
  const handles = new ProjectHandleService({
    trustStore: new ProjectTrustStore({ path: join(stateRoot, 'trust.json') }),
    newId: () => 'project-handle',
  })
  const manager = createTestSessionManager({
    projectHandleService: handles,
    recentProjectStore: new RecentProjectStore(
      { storageLayoutVersion: 2, verificationId: 'trust-gate-test' },
      { filePath: join(stateRoot, 'recent.json'), newId: () => 'recent-project' },
    ),
  })
  // The cwd transaction itself is what is under test; runtime settlement has its
  // own suites (same isolation `project-mutation.test.ts` uses).
  ;(manager as never as { strictDrainPiSession(): Promise<void> }).strictDrainPiSession = async () => {}
  ;(manager as never as { strictDrainSessionForMutation(): Promise<void> })
    .strictDrainSessionForMutation = async () => {}
  const workspace = {
    id: 'ws-trust-gate',
    name: 'Trust Gate Workspace',
    slug: 'trust-gate-workspace',
    rootPath: join(stateRoot, 'workspace'),
    createdAt: Date.now(),
  }
  const managed = createManagedSession({ id: 'session-trust-gate' }, workspace, {
    messagesLoaded: true,
    ephemeral: true,
  })
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspace.id}:${managed.id}`,
    managed,
  )
  return { manager, handles, managed, workspace, projectPath }
}

/**
 * Settle or say so. `Promise.race` against a timer, because the failure this
 * guards against is a promise that never settles — an `await` would hang the
 * runner instead of failing the case, and a hung suite reads as contention.
 */
async function within<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle within ${SETTLE_BUDGET_MS}ms`)),
          SETTLE_BUDGET_MS,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe('P3.325 · a bind never waits for the trust gate it raises', () => {
  it('setSessionProject returns for a project whose trust state is unknown', async () => {
    const fx = fixture()
    const issued = await fx.handles.validateProjectDirectory(fx.workspace.id, fx.projectPath)
    // The positive control for the whole case: with any other trust state the
    // renderer would not open the modal and there would be no gate to deadlock on.
    expect(issued.trustState).toBe('unknown')

    const events: string[] = []
    fx.manager.setEventSink((_channel, _target, event) => { events.push(event.type) })

    const session = await within('setSessionProject', fx.manager.setSessionProject({
      session: { workspaceId: fx.workspace.id, sessionId: fx.managed.id },
      projectHandleId: issued.id,
    }))

    // The canonical path: a bind stores `project.canonicalPath`, and `mkdtemp`
    // hands back a symlinked `/var/...` on darwin.
    expect(session.workingDirectory).toBe(realpathSync(fx.projectPath))
    expect(events).toContain('working_directory_changed')
    // Still untrusted after the bind: the mutation neither waited for a decision
    // nor invented one.
    const resolved = await fx.handles.resolveHandle({
      workspaceId: fx.workspace.id,
      sessionId: fx.managed.id,
    })
    expect(resolved?.trustDecision).toBe('none')
    fx.manager.cleanup()
  })

  it('updateWorkingDirectory returns for a directory with no trust decision', async () => {
    const fx = fixture()
    const issued = await fx.handles.validateProjectDirectory(fx.workspace.id, fx.projectPath)
    expect(issued.trustState).toBe('unknown')

    const events: string[] = []
    fx.manager.setEventSink((_channel, _target, event) => { events.push(event.type) })

    await within('updateWorkingDirectory', fx.manager.updateWorkingDirectory(
      fx.managed.id,
      fx.projectPath,
      fx.workspace.id,
    ))

    expect(events).toContain('working_directory_changed')
    expect(events).not.toContain('working_directory_error')
    fx.manager.cleanup()
  })
})
