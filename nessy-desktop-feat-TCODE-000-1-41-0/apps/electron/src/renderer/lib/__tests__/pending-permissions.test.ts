/**
 * R29b Task 2 — `sub-agents.md:1043`, renderer half.
 *
 * A hidden child's prompt is filed under the VISIBLE ancestor the server names,
 * while its `sessionId` — the id the answer is validated against — stays the
 * child's. Removal is therefore by request id, since the two keys differ for
 * exactly these prompts.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PermissionRequest } from '../../../shared/types'
import {
  addPendingPermission,
  pendingPermissionsAtTurnEnd,
  permissionSurfaceSessionId,
  rehydratePendingHostCards,
  removePendingPermission,
} from '../pending-permissions'

function request(over: Partial<PermissionRequest>): PermissionRequest {
  return { requestId: 'r1', toolName: 'bash', description: 'run', ...over } as PermissionRequest
}

describe('permissionSurfaceSessionId', () => {
  test('a child prompt surfaces in the ancestor the server named', () => {
    expect(permissionSurfaceSessionId(request({ parentSessionId: 'parent-1' }), 'child-1')).toBe('parent-1')
  })

  test('a top-level prompt surfaces in its own session', () => {
    expect(permissionSurfaceSessionId(request({}), 'main-1')).toBe('main-1')
  })
})

describe('the pending queue', () => {
  test('files a child prompt under the parent while keeping the child as the answer target', () => {
    const child = request({ requestId: 'r-child', parentSessionId: 'parent-1', sessionId: 'child-1' } as never)
    const map = addPendingPermission(new Map(), child, 'child-1')
    expect([...map.keys()]).toEqual(['parent-1'])
    expect(map.get('parent-1')![0]!.sessionId).toBe('child-1')
  })

  test('queues the parent and the child prompt in arrival order under one key', () => {
    let map = addPendingPermission(new Map(), request({ requestId: 'r-main' }), 'parent-1')
    map = addPendingPermission(map, request({ requestId: 'r-child', parentSessionId: 'parent-1' }), 'child-1')
    expect(map.get('parent-1')!.map(entry => entry.requestId)).toEqual(['r-main', 'r-child'])
  })

  test('removes an answered child prompt even though it was filed under the parent', () => {
    let map: ReadonlyMap<string, PermissionRequest[]> =
      addPendingPermission(new Map(), request({ requestId: 'r-child', parentSessionId: 'parent-1' }), 'child-1')
    map = removePendingPermission(map, 'r-child')
    expect(map.size).toBe(0)
  })

  test('is unchanged when the request id is not queued', () => {
    const map = addPendingPermission(new Map(), request({ requestId: 'r-main' }), 'parent-1')
    expect(removePendingPermission(map, 'nope')).toBe(map)
  })
})

/**
 * F1.900 — a card leaves when it is ANSWERED or WITHDRAWN, never because a turn
 * ended. Measured on the packaged RC (SIT-ad FAILS 2, SIT-ac FAILS 1): a claude
 * background subagent's `rm -rf ./scratch-dir` card left the DOM the moment the
 * parent turn (or the next one) ended, while the host still held the approval
 * (`awaitingApprovalCount` 1, `pendingApproval` persisted) — so the only thing to
 * answer was gone until F1.527's 540 s expiry. The eraser was `App.tsx`'s
 * `handleEffects`, which dropped the session's whole queue on every `complete`;
 * every card surface (the main pane, the session row's inline buttons, the
 * popover) reads that one map, and the host never re-fires a record it still
 * holds live, so nothing brought the card back.
 */
describe('F1.900 — a turn end and the cards filed under the session', () => {
  const background = request({ requestId: 'r-bg', command: 'rm -rf ./scratch-dir' })
  const other = request({ requestId: 'r-other' })

  test('a completed turn keeps a card the host still holds (the background subagent\'s)', () => {
    const map = addPendingPermission(new Map(), background, 'main-1')
    const after = pendingPermissionsAtTurnEnd(map, 'main-1', 'complete')
    expect(after.get('main-1')?.map(entry => entry.requestId)).toEqual(['r-bg'])
  })

  test('the NEXT turn\'s completion keeps it too (SIT-ac: the READY turn)', () => {
    let map = pendingPermissionsAtTurnEnd(addPendingPermission(new Map(), background, 'main-1'), 'main-1', 'complete')
    map = pendingPermissionsAtTurnEnd(map, 'main-1', 'complete')
    expect(map.get('main-1')?.map(entry => entry.requestId)).toEqual(['r-bg'])
  })

  test('CONTROL: a Stop still takes the session\'s cards, as the complete after it used to', () => {
    let map: ReadonlyMap<string, PermissionRequest[]> = addPendingPermission(new Map(), background, 'main-1')
    map = pendingPermissionsAtTurnEnd(map, 'main-1', 'interrupted')
    map = pendingPermissionsAtTurnEnd(map, 'main-1', 'complete')
    expect(map.has('main-1')).toBe(false)
  })

  test('CONTROL: an answered card and a withdrawn card still leave by request id', () => {
    let map: ReadonlyMap<string, PermissionRequest[]> = addPendingPermission(addPendingPermission(new Map(), background, 'main-1'), other, 'main-1')
    map = removePendingPermission(map, 'r-other') // the answer (handleRespondToPermission)
    expect(map.get('main-1')?.map(entry => entry.requestId)).toEqual(['r-bg'])
    map = removePendingPermission(map, 'r-bg') // the withdrawal (permission_request_cancelled: F1.527 expiry, F1.524 Stop Task)
    expect(map.size).toBe(0)
  })

  test('BOUNDARY: a Stop in one session leaves every other session\'s cards alone', () => {
    const map = addPendingPermission(addPendingPermission(new Map(), background, 'main-1'), other, 'main-2')
    const after = pendingPermissionsAtTurnEnd(map, 'main-1', 'interrupted')
    expect([...after.keys()]).toEqual(['main-2'])
    expect(pendingPermissionsAtTurnEnd(map, 'main-3', 'interrupted')).toBe(map)
  })

  /**
   * F1.911 — the host names the ids it still holds on the `interrupted` itself
   * (origin WJ-crit-bbb P-3), so a Stop drops only what the host dropped with
   * the turn: a between-turn host card (the composer `!` card, the archive
   * worktree card) and a hidden Pi child's card filed under this session stay
   * on screen, answerable, exactly as the host's own count keeps them.
   */
  test('a Stop keeps the ids the host still holds and drops only the rest (F1.911)', () => {
    const composer = request({ requestId: 'r-composer', toolName: 'run_shell_command' })
    let map: ReadonlyMap<string, PermissionRequest[]> =
      addPendingPermission(addPendingPermission(new Map(), background, 'main-1'), composer, 'main-1')
    map = pendingPermissionsAtTurnEnd(map, 'main-1', 'interrupted', ['r-composer'])
    expect(map.get('main-1')?.map(entry => entry.requestId)).toEqual(['r-composer'])
    // The next Stop without the field (the host now holds none) takes the rest.
    map = pendingPermissionsAtTurnEnd(map, 'main-1', 'interrupted')
    expect(map.has('main-1')).toBe(false)
  })

  test('BOUNDARY: a completion ignores the retained ids — it never took a card (F1.911)', () => {
    const map = addPendingPermission(new Map(), background, 'main-1')
    expect(pendingPermissionsAtTurnEnd(map, 'main-1', 'complete', ['r-bg'])).toBe(map)
  })

  test('App.tsx routes both turn endings through this rule, and no longer drops the queue on complete', () => {
    const app = readFileSync(join(import.meta.dir, '..', '..', 'App.tsx'), 'utf8')
    expect(app).toContain('pendingPermissionsAtTurnEnd(prevPerms, sessionId, eventType, event?.type === \'interrupted\' ? event.retainedPermissionRequestIds : undefined)')
    expect(app).not.toContain('// Clear pending permissions and credentials on complete')
    // The credential half is unchanged: a sign-in prompt is still the turn's.
    expect(app).toContain('setPendingCredentials(prevCreds => {')
  })
})

/**
 * UA12.25 — a window that loads after a host card was raised (a reload, a second window) never saw
 * the original event; the session list carries the still-pending host cards and this helper files
 * them like the live event would, skipping requestIds the window already holds.
 */
describe('rehydratePendingHostCards (UA12.25)', () => {
  const hostCard = request({ requestId: 'r-publish', toolName: 'publish_artifact' }) as never as PermissionRequest

  test('files a card the window never saw under its session, with its full payload', () => {
    const map = rehydratePendingHostCards(new Map(), [
      { id: 'main-1', pendingHostCardRequests: [hostCard] },
    ])
    expect(map.get('main-1')?.map(entry => entry.requestId)).toEqual(['r-publish'])
    expect(map.get('main-1')![0]).toBe(hostCard)
  })

  test('CONTROL: a requestId already on screen is not stacked — the list is re-fetched on refreshes too', () => {
    const onScreen = addPendingPermission(new Map(), hostCard, 'main-1')
    const map = rehydratePendingHostCards(onScreen, [
      { id: 'main-1', pendingHostCardRequests: [hostCard] },
    ])
    expect(map.get('main-1')?.map(entry => entry.requestId)).toEqual(['r-publish'])
    expect(map).toBe(onScreen)
  })

  test('BOUNDARY: sessions that carry none leave the map identical', () => {
    const map = addPendingPermission(new Map(), hostCard, 'main-1')
    expect(rehydratePendingHostCards(map, [{ id: 'main-2' }])).toBe(map)
    expect(rehydratePendingHostCards(map, [{ id: 'main-2', pendingHostCardRequests: [] }])).toBe(map)
    expect(rehydratePendingHostCards(map, [])).toBe(map)
  })

  test('App.tsx re-files the list\'s host cards where the sessions are loaded', () => {
    const app = readFileSync(join(import.meta.dir, '..', '..', 'App.tsx'), 'utf8')
    expect(app).toContain('rehydratePendingHostCards(prev, loadedSessions)')
  })
})
