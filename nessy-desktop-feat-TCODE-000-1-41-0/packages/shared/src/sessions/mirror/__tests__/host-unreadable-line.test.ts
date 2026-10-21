/**
 * P2.204 — one unreadable line in a flushed transcript used to cost the WHOLE
 * flush, silently.
 *
 * `snapshotFromLines` parsed every line with a bare `JSON.parse`, so a single
 * unreadable line threw out of `dispatch`, out of `notifySessionMirrorFlush`'s
 * `.catch`, and into a `console.error` — bypassing `mirror_error`, the one
 * channel this subsystem has for making mirror data loss visible. And the bad
 * line stays in the file, so every later flush died the same way: the session
 * stopped mirroring permanently and nothing on screen ever said so.
 *
 * Driven through `notifySessionMirrorFlush`, which IS the production tap
 * (`SessionPersistenceQueue.writePending` calls it with the exact lines it
 * wrote), rather than through the private function.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import { CONFIG_DIR } from '../../../config/paths.ts'
import {
  notifySessionMirrorFlush,
  resetSessionMirrorHostForTests,
  sessionMirrorIdle,
  setSessionMirrorErrorSink,
} from '../host.ts'
import type { MirrorEvent } from '../types.ts'

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const WS = 'ws_mirror_unreadable'
const MIRROR_ROOT = join(CONFIG_DIR, 'mirror-unreadable-root')

function writeConfig(): void {
  writeFileSync(CONFIG_FILE, JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    sessionMirror: { adapter: 'directory', path: MIRROR_ROOT },
  }), 'utf-8')
}

function mirrorTranscript(sessionId: string): Array<Record<string, unknown>> {
  const file = join(MIRROR_ROOT, WS, sessionId, 'transcript.jsonl')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf-8').trim().split('\n').map(line => JSON.parse(line))
}

function header(): string {
  return JSON.stringify({ id: 's', workspaceId: WS, createdAt: 1, lastUsedAt: 2 })
}

function message(id: string, content: string): string {
  return JSON.stringify({ id, type: 'user', content, timestamp: 3 })
}

/** The shape a string-replacement inside serialized JSON produces: torn escapes. */
const TORN_LINE = '{"id":"m-2","content":"NOT-JSON-SECRET-PAYLOAD'

beforeEach(() => {
  resetSessionMirrorHostForTests()
  rmSync(MIRROR_ROOT, { recursive: true, force: true })
  writeConfig()
})

afterEach(() => {
  setSessionMirrorErrorSink(null)
  resetSessionMirrorHostForTests()
  rmSync(CONFIG_FILE, { force: true })
  rmSync(MIRROR_ROOT, { recursive: true, force: true })
})

describe('P2.204 · a mirror flush contains an unreadable line', () => {
  it('mirrors every readable line and loses only the one it cannot read', async () => {
    const events: MirrorEvent[] = []
    setSessionMirrorErrorSink(event => { events.push(event) })

    notifySessionMirrorFlush({ workspaceId: WS, sessionId: 's-torn' }, [
      header(),
      message('m-1', 'first'),
      TORN_LINE,
      message('m-3', 'third'),
    ])
    await sessionMirrorIdle()

    const entries = mirrorTranscript('s-torn')
    expect(entries.map(entry => entry.type)).toEqual(['session_header', 'message', 'message'])
    expect(entries.filter(entry => entry.type === 'message').map(entry => (entry.data as { id?: string }).id))
      .toEqual(['m-1', 'm-3'])

    expect(events).toHaveLength(1)
    expect(events[0]!.subtype).toBe('mirror_error')
    expect(events[0]!.key).toEqual({ workspaceId: WS, sessionId: 's-torn' })
    expect(events[0]!.entryCount).toBe(1)
    // Named by POSITION, never by content: the reason reaches the transcript and
    // a renderer, and the line is session data.
    // The 1-based FILE line, so the reason points at the byte range a reader can
    // open: header is line 1, so the third line of the flush is line 3.
    expect(events[0]!.reason).toContain('line 3')
    expect(events[0]!.reason).not.toContain('NOT-JSON-SECRET-PAYLOAD')
  })

  it('reports the same unreadable line once, not on every flush', async () => {
    const events: MirrorEvent[] = []
    setSessionMirrorErrorSink(event => { events.push(event) })
    const lines = [header(), message('m-1', 'first'), TORN_LINE]

    notifySessionMirrorFlush({ workspaceId: WS, sessionId: 's-repeat' }, lines)
    await sessionMirrorIdle()
    // A SUCCESSFUL delivery happened in between — the batch's good half landed.
    // The unreadable-line notice must not be re-armed by that success, or every
    // later flush of a file that keeps its bad line would post a new message.
    notifySessionMirrorFlush({ workspaceId: WS, sessionId: 's-repeat' }, [...lines, message('m-3', 'third')])
    await sessionMirrorIdle()

    expect(events).toHaveLength(1)
    // The later flush still mirrored its own new content.
    expect(mirrorTranscript('s-repeat').filter(entry => entry.type === 'message')).toHaveLength(2)
  })

  it('an unreadable HEADER costs the flush, and says so instead of failing silently', async () => {
    const events: MirrorEvent[] = []
    setSessionMirrorErrorSink(event => { events.push(event) })

    notifySessionMirrorFlush({ workspaceId: WS, sessionId: 's-torn-header' }, [
      '{"id":"s","createdAt":',
      message('m-1', 'first'),
    ])
    await sessionMirrorIdle()

    expect(mirrorTranscript('s-torn-header')).toEqual([])
    expect(events).toHaveLength(1)
    expect(events[0]!.reason).toContain('header')
    expect(events[0]!.entryCount).toBe(1)
  })

  it('a flush with nothing unreadable stays silent', async () => {
    const events: MirrorEvent[] = []
    setSessionMirrorErrorSink(event => { events.push(event) })

    notifySessionMirrorFlush({ workspaceId: WS, sessionId: 's-clean' }, [header(), message('m-1', 'first')])
    await sessionMirrorIdle()

    expect(mirrorTranscript('s-clean')).toHaveLength(2)
    expect(events).toEqual([])
  })
})
