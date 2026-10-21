/**
 * R64 · f010/f216 host half — a hook's `sessionTitle` renaming a real session.
 *
 * hooks.md:1060 gives the field "the same effect as `/rename`", so the rename
 * has to go through `renameSession` (persistence + `title_generated` + the
 * watcher poke) rather than a second title writer. And it has to SURVIVE: the
 * async LLM title lands seconds later and used to overwrite `managed.name`
 * unconditionally, which would have made a correctly delivered rename look like
 * it never happened.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { getSessionFilePath } from '@nessy-agent/shared/sessions'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { SessionManager, createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

/** `ManagedSession` is module-local in SessionManager.ts; this is its public face. */
type ManagedSession = ReturnType<typeof createManagedSession>

describe('hook sessionTitle on the host', () => {
  let workspaceId: string
  let sm: SessionManager

  beforeEach(() => {
    workspaceId = `ws-hook-title-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sm = createTestSessionManager()
  })

  afterEach(() => {
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
  })

  function seed(sessionId: string, name?: string): ManagedSession {
    const managed = createManagedSession(
      { id: sessionId, ...(name ? { name } : {}), createdAt: Date.now() },
      {
        id: workspaceId,
        name: 'Test Workspace',
        rootPath: join(SESSIONS_DIR, '..', 'workspaces', workspaceId),
        createdAt: Date.now(),
      } as never,
    )
    managed.messagesLoaded = true
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(`${workspaceId}:${sessionId}`, managed)
    return managed
  }

  /** The private the agent callback is wired to, driven exactly as it is wired. */
  function applyHookTitle(managed: ManagedSession, title: string): Promise<void> {
    return (sm as unknown as {
      applyHookSessionTitle(m: ManagedSession, t: string): Promise<void>
    }).applyHookSessionTitle(managed, title)
  }

  it('renames the session, persists it, and tells the renderer', async () => {
    const events: Array<Record<string, unknown>> = []
    ;(sm as unknown as { sendEvent(e: Record<string, unknown>, w?: string): void }).sendEvent =
      event => { events.push(event) }
    const managed = seed('hook-title-basic', 'New Chat')

    await applyHookTitle(managed, 'auth-refactor')
    await sm.flushSession('hook-title-basic', workspaceId)

    expect(managed.name).toBe('auth-refactor')
    const header = JSON.parse(readFileSync(getSessionFilePath(workspaceId, 'hook-title-basic'), 'utf-8').split('\n')[0]!)
    expect(header.name).toBe('auth-refactor')
    expect(events).toContainEqual({
      type: 'title_generated',
      sessionId: 'hook-title-basic',
      title: 'auth-refactor',
    })
  })

  it('sanitizes and bounds hook-authored text, and ignores a title that empties out', async () => {
    const managed = seed('hook-title-hostile', 'New Chat')

    // Hook output is arbitrary text on a sidebar row: the same sanitizer and
    // the same 50-character budget the automatic first-message title uses.
    await applyHookTitle(managed, `<b>release</b> ${'x'.repeat(80)}`)
    expect(managed.name).not.toContain('<b>')
    expect(managed.name!.length).toBe(51)
    expect(managed.name!.endsWith('…')).toBe(true)

    // Nothing left after sanitizing is not a rename to the empty string.
    const named = managed.name
    await applyHookTitle(managed, '   <tag></tag>  ')
    expect(managed.name).toBe(named)
  })

  it('keeps the hook title when the async LLM title returns after it', async () => {
    const managed = seed('hook-title-vs-llm', 'New Chat')
    managed.agent = {
      generateTitle: async () => 'A Chat About Authentication Refactoring',
    } as never

    await applyHookTitle(managed, 'auth-refactor')
    await (sm as unknown as {
      generateTitle(m: ManagedSession, msg: string, retry?: boolean): Promise<void>
    }).generateTitle(managed, 'please refactor auth', false)

    expect(managed.name).toBe('auth-refactor')
  })

  it('still lets the LLM title win when no hook or user named the session', async () => {
    // The control for the assertion above: without the explicit-title flag the
    // same call must still write, or the guard would be indistinguishable from
    // a broken title generator.
    const managed = seed('hook-title-llm-free')
    managed.agent = {
      generateTitle: async () => 'A Chat About Authentication Refactoring',
    } as never

    await (sm as unknown as {
      generateTitle(m: ManagedSession, msg: string, retry?: boolean): Promise<void>
    }).generateTitle(managed, 'please refactor auth', false)

    expect(managed.name).toBe('A Chat About Authentication Refactoring')
  })
})
