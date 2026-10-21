/**
 * P6.102 — the codex branch anchor sidecar.
 *
 * Same shape as claude's (`{ sdkSessionId, sdkMessageUuid }` per host message
 * id) and a SEPARATE FILE, because the two runtimes' anchors are not
 * interchangeable and a session that has been switched between them holds
 * both. The slot claude fills with an SDK message uuid holds, on codex, the
 * TURN id `thread/fork` takes as `lastTurnId`.
 *
 * What is pinned here is the property the branch arm depends on: an anchor
 * written for one runtime is never handed to the other, and a lookup that finds
 * nothing says so rather than guessing — the caller then falls back to codex's
 * documented full-history fork.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getRuntimeTurnAnchor,
  saveRuntimeTurnAnchor,
  CLAUDE_TURN_ANCHORS_FILE,
  CODEX_TURN_ANCHORS_FILE,
} from './SessionManager.ts'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'codex-turn-anchors-test-'))
})

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

const sessionDir = (name: string): string => {
  const p = join(tmpRoot, name)
  mkdirSync(p, { recursive: true })
  return p
}

describe('P6.102 · codex turn anchors', () => {
  it('round-trips the thread id and the turn id a fork needs', async () => {
    const session = sessionDir('s1')
    await saveRuntimeTurnAnchor(session, 'nessy-msg-1', 'thread_cx_a', 'cx-turn-7', CODEX_TURN_ANCHORS_FILE)

    expect(await getRuntimeTurnAnchor(session, 'nessy-msg-1', CODEX_TURN_ANCHORS_FILE)).toEqual({
      sdkSessionId: 'thread_cx_a',
      sdkMessageUuid: 'cx-turn-7',
    })
    expect(existsSync(join(session, 'meta', CODEX_TURN_ANCHORS_FILE))).toBe(true)
  })

  it('keeps the two runtimes apart for the SAME host message', async () => {
    // A session switched between runtimes holds an anchor of each kind for the
    // same message. Reading one file must never answer with the other's value:
    // handing a claude message uuid to `thread/fork` names a turn no codex
    // thread has.
    const session = sessionDir('s2')
    await saveRuntimeTurnAnchor(session, 'nessy-msg-1', 'thread_cx_a', 'cx-turn-7', CODEX_TURN_ANCHORS_FILE)
    await saveRuntimeTurnAnchor(session, 'nessy-msg-1', 'claude-sess-a', 'msg_abc123', CLAUDE_TURN_ANCHORS_FILE)

    expect((await getRuntimeTurnAnchor(session, 'nessy-msg-1', CODEX_TURN_ANCHORS_FILE))?.sdkMessageUuid)
      .toBe('cx-turn-7')
    expect((await getRuntimeTurnAnchor(session, 'nessy-msg-1', CLAUDE_TURN_ANCHORS_FILE))?.sdkMessageUuid)
      .toBe('msg_abc123')
  })

  it('carries the parent thread id so a lineage mismatch is visible', async () => {
    // The branch arm compares this against the thread it is about to fork. An
    // anchor written while the session was on a DIFFERENT codex thread names a
    // turn that thread does not contain, and the caller degrades rather than
    // forking through a stranger's turn.
    const session = sessionDir('s3')
    await saveRuntimeTurnAnchor(session, 'nessy-msg-1', 'thread_cx_old', 'cx-turn-1', CODEX_TURN_ANCHORS_FILE)
    const anchor = await getRuntimeTurnAnchor(session, 'nessy-msg-1', CODEX_TURN_ANCHORS_FILE)
    expect(anchor?.sdkSessionId).toBe('thread_cx_old')
    expect(anchor?.sdkSessionId).not.toBe('thread_cx_new')
  })

  it('answers undefined for a message with no anchor, and for a session with no sidecar', async () => {
    const session = sessionDir('s4')
    expect(await getRuntimeTurnAnchor(session, 'nessy-msg-1', CODEX_TURN_ANCHORS_FILE)).toBeUndefined()

    await saveRuntimeTurnAnchor(session, 'nessy-msg-1', 'thread_cx_a', 'cx-turn-7', CODEX_TURN_ANCHORS_FILE)
    expect(await getRuntimeTurnAnchor(session, 'nessy-msg-2', CODEX_TURN_ANCHORS_FILE)).toBeUndefined()
  })

  it('writes nothing when any part of the anchor is missing', async () => {
    // The adapter withholds `runtimeTurnId` when the only turn id available is
    // one we invented, so this guard is what keeps an empty string out of the
    // sidecar rather than into a `lastTurnId`.
    const session = sessionDir('s5')
    await saveRuntimeTurnAnchor(session, 'nessy-msg-1', 'thread_cx_a', '', CODEX_TURN_ANCHORS_FILE)
    await saveRuntimeTurnAnchor(session, 'nessy-msg-1', '', 'cx-turn-7', CODEX_TURN_ANCHORS_FILE)
    expect(existsSync(join(session, 'meta', CODEX_TURN_ANCHORS_FILE))).toBe(false)
    expect(await getRuntimeTurnAnchor(session, 'nessy-msg-1', CODEX_TURN_ANCHORS_FILE)).toBeUndefined()
  })
})
