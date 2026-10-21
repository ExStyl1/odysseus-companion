/**
 * F1.549 (origin WJ-ba P-WJ-ba-3, DECIDED 2026-09-24) — a session the agent starts with `spawn_session` is never
 * more permissive than the session that started it, and the child says so when it was narrowed.
 *
 * Measured at HEAD before the fix (WJ-ba, read): `onSpawnSession` passed `request.permissionMode ?? managed.permissionMode`
 * to `createSession`, so a `default` parent that spawned with `permissionMode: 'bypassPermissions'` got a bypass
 * child — the F1.549 control. The clamp is `clampPermissionModeToParent`, the subagent rule, reused.
 *
 * Three arms: the rule itself (every direction the ranking has), the handler (structural, as P6.334's deferral
 * pin in `deferred-spawn-proposal.test.ts` is, because `onSpawnSession` is wired only inside a live agent build),
 * and the note — the real `SessionManager` writing it into a registered child's transcript.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveSpawnedSessionPermissionMode } from '../spawn-session-permission-mode.ts'
import { createManagedSession } from '../SessionManager.ts'
import { createTestSessionManager } from './test-session-manager.ts'

describe('F1.549 — the spawned session\'s mode is clamped by its parent\'s', () => {
  test('THE CONTROL — a default parent asking for bypassPermissions gets a default child, and says what it asked for', () => {
    expect(resolveSpawnedSessionPermissionMode('bypassPermissions', 'default'))
      .toEqual({ mode: 'default', narrowedFrom: 'bypassPermissions' })
    // A legacy spelling is the same request, alias-resolved before the clamp.
    expect(resolveSpawnedSessionPermissionMode('allow-all', 'acceptEdits'))
      .toEqual({ mode: 'acceptEdits', narrowedFrom: 'allow-all' })
    // F1.1050: the retired explore is read as plan, so a plan parent's explore request IS plan — nothing narrowed.
    expect(resolveSpawnedSessionPermissionMode('explore', 'plan')).toEqual({ mode: 'plan' })
    expect(resolveSpawnedSessionPermissionMode('explore', 'dontAsk')).toEqual({ mode: 'dontAsk', narrowedFrom: 'explore' })
    // An unrecognised value never widens.
    expect(resolveSpawnedSessionPermissionMode('yolo', 'default')).toEqual({ mode: 'default', narrowedFrom: 'yolo' })
  })

  test('BOUNDARY — narrowing, an equal mode and no request are untouched (no note)', () => {
    expect(resolveSpawnedSessionPermissionMode('default', 'bypassPermissions')).toEqual({ mode: 'default' })
    expect(resolveSpawnedSessionPermissionMode('auto', 'auto')).toEqual({ mode: 'auto' })
    expect(resolveSpawnedSessionPermissionMode(undefined, 'acceptEdits')).toEqual({ mode: 'acceptEdits' })
    // A parent with no recorded mode is `default` — the subagent clamp's own floor.
    expect(resolveSpawnedSessionPermissionMode('bypassPermissions', undefined))
      .toEqual({ mode: 'default', narrowedFrom: 'bypassPermissions' })
  })

  test('THE HANDLER — onSpawnSession creates the child in the clamped mode, never in the raw request', () => {
    const source = readFileSync(fileURLToPath(new URL('../SessionManager.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('managed.agent.onSpawnSession = async (request) =>')
    expect(start).toBeGreaterThan(-1)
    // Bounded by the NEXT wiring statement, declared BELOW the handler (a forward-only boundary cannot fail on
    // a needle above it — AGENTS.md).
    const end = source.indexOf('mergeSessionScopedToolCallbacks({ workspaceId: managed.workspace.id, sessionId: managed.id }', start)
    expect(end).toBeGreaterThan(start)
    const handler = source.slice(start, end)
    expect(handler).not.toContain('permissionMode: request.permissionMode ?? managed.permissionMode')
    expect(handler).toContain('resolveSpawnedSessionPermissionMode(request.permissionMode, managed.permissionMode)')
    expect(handler).toContain('permissionMode: spawnMode.mode')
    // …and the clamp is computed after the deferral returns, so a proposal still creates nothing (P6.334).
    expect(handler.indexOf('request.defer === true')).toBeLessThan(handler.indexOf('resolveSpawnedSessionPermissionMode('))
    expect(handler).toContain('this.noteSpawnedSessionModeNarrowed(')
  })

  test('THE NOTE — the child\'s transcript says it was narrowed, and from what', async () => {
    const manager = createTestSessionManager() as any
    try {
      const workspace = { id: 'ws-f1549', name: 'ws-f1549', slug: 'ws-f1549', rootPath: '/tmp/ws-f1549', createdAt: Date.now() }
      const parent = createManagedSession({ id: 'parent', name: 'Refactor lead' }, workspace, { messagesLoaded: true, ephemeral: true })
      const child = createManagedSession({ id: 'child' }, workspace, { messagesLoaded: true, ephemeral: true })
      manager.sessions.set('ws-f1549:parent', parent)
      manager.sessions.set('ws-f1549:child', child)
      manager.noteSpawnedSessionModeNarrowed('child', parent, { mode: 'default', narrowedFrom: 'bypassPermissions' })
      const notes = (child.messages as Array<{ role: string; content: string }>).filter(message => message.role === 'info')
      expect(notes).toHaveLength(1)
      expect(notes[0]!.content).toContain('"bypassPermissions"')
      expect(notes[0]!.content).toContain('"default"')
      // CONTROL — nothing narrowed, nothing written.
      manager.noteSpawnedSessionModeNarrowed('child', parent, { mode: 'default' })
      expect((child.messages as unknown[]).length).toBe(1)
      expect((parent.messages as unknown[]).length).toBe(0)
    } finally {
      await manager.cleanup()
    }
  })
})
