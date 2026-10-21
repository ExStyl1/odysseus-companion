/**
 * C3.311 — the claude runtime's own transcript goes with the session the host
 * deletes, and a session that never had one still deletes cleanly.
 *
 * `deleteClaudeVendorSession` (`packages/shared/src/agent/claude-session-persistence.ts`)
 * shipped with no call site in W18-c's commit, deliberately: the producer is in
 * `SessionManager.ts`, which that lane did not hold. This is that producer.
 *
 * Two properties, and only one of them is behavioural:
 *
 * - **The `'skipped'` arm** — a session with no claude anchor must delete
 *   exactly as it did before. Run end to end below, because it is the arm every
 *   Pi and codex session takes and a regression there costs the user a deletion.
 * - **WHERE the call sits** — after the host delete has durably committed and
 *   outside the rollback window. That is invisible to any behavioural test: the
 *   rollback restores the HOST record, and a vendor transcript removed for a
 *   session that came back would be unrecoverable, so the property is about an
 *   ordering that only the source shows.
 */
import { afterEach, describe, expect, it, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SESSIONS_DIR } from '@nessy-agent/shared/workspaces'
import { saveSession } from '@nessy-agent/shared/sessions/storage'
import type { StoredSession } from '@nessy-agent/shared/sessions/types'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const WS = 'ws_claude_vendor_delete'
const managers: SessionManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.cleanup()
  rmSync(join(SESSIONS_DIR, WS), { recursive: true, force: true })
})

describe('C3.311 — the vendor delete never costs the user their deletion', () => {
  it('a session with NO claude anchor deletes exactly as before (the `skipped` arm)', async () => {
    const stored: StoredSession = {
      id: 's-no-claude-anchor',
      workspaceId: WS,
      createdAt: 1000,
      lastUsedAt: 2000,
      messages: [{ id: 'm-1', type: 'user', content: 'to be deleted', timestamp: 3000 }],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    }
    await saveSession(stored)
    expect(existsSync(join(SESSIONS_DIR, WS, 's-no-claude-anchor'))).toBe(true)

    const manager = createTestSessionManager()
    managers.push(manager)
    const managed = createManagedSession({ id: 's-no-claude-anchor' }, {
      id: WS,
      name: 'Claude Vendor Delete Workspace',
      rootPath: '/tmp/nessy-claude-vendor-delete',
      createdAt: 1,
    } as never, { messagesLoaded: true })
    // No `sdkSessionAnchors`: this is every Pi and codex session, and the arm
    // the vendor call must answer `'skipped'` for without touching anything.
    expect(managed.sdkSessionAnchors).toBeUndefined()
    ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
      `${WS}:s-no-claude-anchor`,
      managed,
    )

    await manager.deleteSession('s-no-claude-anchor', WS)

    expect(existsSync(join(SESSIONS_DIR, WS, 's-no-claude-anchor'))).toBe(false)
  })
})

describe('C3.311 — where the call sits, which no behavioural test can see', () => {
  test('after the storage delete commits, and outside the rollback window', async () => {
    const src = await Bun.file(new URL('../SessionManager.ts', import.meta.url).pathname).text()
    const commit = src.indexOf('      storageDeleted = true')
    const call = src.indexOf('const claudeVendorDelete = await deleteClaudeVendorSession({')
    const rollback = src.indexOf('if (deletionFenced && !storageDeleted) {')
    expect(commit).toBeGreaterThan(0)
    expect(call).toBeGreaterThan(commit)
    // The rollback branch is the POSITIVE CONTROL and the bound at once: it is
    // the thing the call must not be inside, and its presence proves this read
    // found the real `deleteSession`.
    expect(rollback).toBeGreaterThan(call)

    const body = src.slice(call, call + 700)
    // The CLAUDE anchor, not the legacy single slot, which can hold a Pi id.
    expect(body).toContain("readRuntimeAnchor(managed.sdkSessionAnchors, 'anthropic')")
    expect(body).not.toContain('managed.session.sdkSessionId')
    // Never throws: a vendor-side cleanup failure is logged, not raised.
    expect(body).toContain("if (claudeVendorDelete === 'failed') {")
    expect(body).toContain('sessionLog.warn(')
  })
})
