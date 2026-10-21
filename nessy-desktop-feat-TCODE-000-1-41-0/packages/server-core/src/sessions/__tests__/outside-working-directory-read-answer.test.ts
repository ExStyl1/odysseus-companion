/**
 * P6.202 clause (3) — the ANSWER half: two booleans, three answers.
 *
 * `permission-modes.md#first-read-outside-the-working-directories` names them:
 * **Keep allowing** (*"the prompt doesn't appear again"*), **Ask again next
 * time**, and **Block from now on** (*"Claude Code sets
 * `permissions.blockReadsOutsideWorkingDirectories` to `true` in your user
 * settings"*). The card and the answer table both shipped in `75ef8ef87`; the
 * routing between them did not, so every answer resolved as a plain
 * allow/deny and the two that PERSIST something persisted nothing.
 *
 * Driven through the real `requestPiToolApproval` → `respondToPermission` seam
 * rather than against the table directly: the table was already right, and the
 * defect was that nobody called it.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { modeManager } from '@nessy-agent/shared/agent'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import {
  getBlockReadsOutsideWorkingDirectories,
  saveConfig,
} from '@nessy-agent/shared/config/storage'
import { createManagedSession, type SessionManager } from '../SessionManager'
import { createTestSessionManager } from './test-session-manager'

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const managers: SessionManager[] = []

/**
 * The isolated per-process config directory ships with no `config.json`, and
 * the setter deliberately refuses to invent one — so a test of the WRITE has to
 * seed the file the user would already have.
 */
function seedEmptyConfig(): void {
  saveConfig({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  } as never)
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.cleanup()
  if (existsSync(CONFIG_FILE)) rmSync(CONFIG_FILE)
})

let sessionSeq = 0

function fixture() {
  const manager = createTestSessionManager()
  managers.push(manager)
  sessionSeq += 1
  const sessionId = `session-outside-${sessionSeq}`
  const workspaceId = `workspace-outside-${sessionSeq}`
  const managed = createManagedSession({ id: sessionId }, {
    id: workspaceId,
    name: 'Workspace Outside',
    rootPath: '/tmp/nessy-outside-read-workspace',
    createdAt: 1,
  }, { messagesLoaded: true, ephemeral: true })
  managed.agent = { respondToPermission: () => {} } as never
  ;(manager as unknown as { sessions: Map<string, unknown> }).sessions.set(
    `${workspaceId}:${sessionId}`,
    managed,
  )
  const internals = manager as unknown as {
    requestPiToolApproval(managed: unknown, request: Record<string, unknown>): Promise<{ allowed: boolean }>
    respondToPermission: SessionManager['respondToPermission']
    pendingPermissionRequests: Map<string, { outsideWorkingDirectoryRead?: { path: string } }>
  }
  const ask = (decisionId: string): Promise<{ allowed: boolean }> =>
    internals.requestPiToolApproval(managed, {
      decisionId,
      toolName: 'Read',
      type: 'outside_root',
      description: 'Reading a path outside the working directories: /elsewhere/notes.md',
      outsideWorkingDirectoryRead: {
        path: '/elsewhere/notes.md',
        tool: 'Read',
        workingDirectory: '/tmp/nessy-outside-read-workspace',
      },
    })
  return { internals, sessionId, workspaceId, ask }
}

function managedOf(internals: unknown, workspaceId: string, sessionId: string): unknown {
  return (internals as { sessions: Map<string, unknown> }).sessions.get(`${workspaceId}:${sessionId}`)
}

function readsState(workspaceId: string, sessionId: string): string | undefined {
  return modeManager.getState({ workspaceId, sessionId }).outsideWorkingDirectoryReads
}

describe('the first-read-outside answer reaches the table that encodes it (P6.202 (3))', () => {
  it('Keep allowing records the session answer, and Block from now on writes the user setting', async () => {
    // POSITIVE, both persisting answers.
    seedEmptyConfig()

    const keep = fixture()
    const keepApproval = keep.ask('decision-outside-keep')
    // The payload rides the pending record: it, not the card `type`, is what
    // routes the answer.
    expect(keep.internals.pendingPermissionRequests.get('decision-outside-keep')?.outsideWorkingDirectoryRead)
      .toBeDefined()
    expect(readsState(keep.workspaceId, keep.sessionId)).toBeUndefined()

    expect(keep.internals.respondToPermission(
      keep.sessionId, 'decision-outside-keep', true, false, undefined, keep.workspaceId,
    )).toBe(true)
    await expect(keepApproval).resolves.toMatchObject({ allowed: true })
    // "the prompt doesn't appear again" — recorded on THIS session.
    expect(readsState(keep.workspaceId, keep.sessionId)).toBe('keep-allowing')
    // …and it is a session answer, not a settings write.
    expect(getBlockReadsOutsideWorkingDirectories()).toBe(false)

    const block = fixture()
    const blockApproval = block.ask('decision-outside-block')
    expect(block.internals.respondToPermission(
      block.sessionId, 'decision-outside-block', false, true, undefined, block.workspaceId,
    )).toBe(true)
    await expect(blockApproval).resolves.toMatchObject({ allowed: false })
    // "which makes the file tools refuse such reads in every later session and
    // every permission mode" — the USER layer, so the reader sees it at once.
    expect(getBlockReadsOutsideWorkingDirectories()).toBe(true)
    // The refusing answer records nothing on the session: a refusal that
    // recorded itself would make the third answer stop asking.
    expect(readsState(block.workspaceId, block.sessionId)).toBeUndefined()
  })

  it('Ask again next time persists nothing at all, and an ordinary prompt is untouched', async () => {
    // NEGATIVE, twice: the third answer, whose entire promise is that it keeps
    // asking, and a card of any other class, which must not be re-routed.
    seedEmptyConfig()

    const again = fixture()
    const againApproval = again.ask('decision-outside-again')
    expect(again.internals.respondToPermission(
      again.sessionId, 'decision-outside-again', false, false, undefined, again.workspaceId,
    )).toBe(true)
    await expect(againApproval).resolves.toMatchObject({ allowed: false })
    expect(readsState(again.workspaceId, again.sessionId)).toBeUndefined()
    expect(getBlockReadsOutsideWorkingDirectories()).toBe(false)

    // A card of any OTHER class carries no payload, so an Always on it must
    // never reach the fence — the routing is keyed on the payload precisely so
    // that a future producer of an `outside_root` card without one cannot
    // silently write a settings key either.
    const plain = fixture()
    const plainApproval = plain.internals.requestPiToolApproval(
      managedOf(plain.internals, plain.workspaceId, plain.sessionId),
      {
        decisionId: 'decision-plain-write',
        toolName: 'Write',
        type: 'file_write',
        description: 'Write a file',
      },
    )
    expect(plain.internals.pendingPermissionRequests.get('decision-plain-write')?.outsideWorkingDirectoryRead)
      .toBeUndefined()
    expect(plain.internals.respondToPermission(
      plain.sessionId, 'decision-plain-write', false, true, undefined, plain.workspaceId,
    )).toBe(true)
    await expect(plainApproval).resolves.toMatchObject({ allowed: false })
    expect(getBlockReadsOutsideWorkingDirectories()).toBe(false)
  })
})
