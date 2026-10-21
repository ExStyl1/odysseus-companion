/**
 * P6.57 — the running-work listing is not Pi's.
 *
 * `listPiAgentView` is the surface behind `/tasks`, `/workflows` and
 * `/plugin` — "what is this session doing right now". It filtered on
 * `provider === 'pi'`, so a claude or codex session got an EMPTY page rather
 * than "not supported": an absence indistinguishable from having nothing
 * running, which is the silent-divergence shape this plan closes.
 *
 * The correction is NOT to report zeros off Pi. `active.children/processes/
 * workflows` count Pi constructs — its child sessions, its process supervisor,
 * its background workflow evaluators — and `0` there would be a CLAIM that
 * nothing is running where the truth is that nothing is tracked. So the ENTRY
 * appears and the `active` block is omitted, which is why both arms are here:
 * the first alone would pass against a build that reported zeros, and the
 * second alone would pass against one that still excluded the session.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { createManagedSession, SessionManager } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

describe('listPiAgentView is runtime-neutral (P6.57)', () => {
  let workspaceId: string
  let sm: SessionManager

  beforeEach(() => {
    workspaceId = `ws-agent-view-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sm = createTestSessionManager()
  })

  afterEach(() => {
    mock.restore()
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
  })

  function install(sessionId: string, llmConnection: string) {
    const managed = createManagedSession(
      { id: sessionId, name: sessionId, llmConnection },
      {
        id: workspaceId,
        name: 'Test Workspace',
        rootPath: join(SESSIONS_DIR, '..', 'workspaces', workspaceId),
        createdAt: Date.now(),
      } as never,
      { messagesLoaded: true },
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspaceId}:${sessionId}`, managed)
    return managed
  }

  it('lists a non-Pi session, and OMITS the Pi-only counters on it', async () => {
    const piSession = install('session-pi', 'pi-source')
    ;(sm as unknown as { resolveManagedProvider(m: unknown): string }).resolveManagedProvider =
      (m: unknown) => ((m as { id: string }).id === 'session-pi' ? 'pi' : 'anthropic')
    install('session-claude', 'nessy-claude')
    void piSession

    const page = await sm.listPiAgentView(workspaceId, { schemaVersion: 1 })
    const byId = new Map(page.items.map(item => [item.session.sessionId, item]))

    // Both sessions are on the page — the listing is about the session, not the
    // runtime.
    expect([...byId.keys()].sort()).toEqual(['session-claude', 'session-pi'])
    // Pi keeps the counters…
    expect(byId.get('session-pi')!.active).toEqual({ children: 0, processes: 0, workflows: 0 })
    // …and the other runtime has them ABSENT, not zeroed. Zero reads as
    // "nothing running"; absent reads as "not tracked", and only one of those
    // is true.
    expect(byId.get('session-claude')!.active).toBeUndefined()
    // What a claude user is actually asking about is host-side and present.
    expect(byId.get('session-claude')!.state).toBeDefined()
    expect(byId.get('session-claude')!.residency).toBeDefined()
    expect(byId.get('session-claude')!.settlement).toBeDefined()
  })

  it('THE CONTROL — a hidden session is still excluded, so the filter was narrowed and not deleted', async () => {
    ;(sm as unknown as { resolveManagedProvider(): string }).resolveManagedProvider = () => 'anthropic'
    const hidden = install('session-hidden', 'nessy-claude')
    ;(hidden as { hidden?: boolean }).hidden = true
    install('session-visible', 'nessy-claude')

    const page = await sm.listPiAgentView(workspaceId, { schemaVersion: 1 })
    expect(page.items.map(item => item.session.sessionId)).toEqual(['session-visible'])
  })
})
