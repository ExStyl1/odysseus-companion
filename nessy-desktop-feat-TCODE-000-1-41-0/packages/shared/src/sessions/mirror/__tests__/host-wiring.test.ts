/**
 * Production wiring: the mirror consumes the persistence QUEUE's output. These
 * tests go through the real `saveSession` → `sessionPersistenceQueue` → flush
 * path — a mirror that a unit calls directly but the queue never invokes is the
 * series' recurring defect (eleven instances).
 *
 * Local disk is written FIRST and stays authoritative: an unwritable or
 * misconfigured mirror never fails, blocks, or reorders the local write.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import { CONFIG_DIR } from '../../../config/paths.ts'
import { saveSession } from '../../storage.ts'
import type { StoredSession } from '../../types.ts'
import {
  evictSessionMirrorState,
  hasSessionMirrorState,
  resetSessionMirrorHostForTests,
  sessionMirrorIdle,
  setSessionMirrorErrorSink,
} from '../host.ts'
import type { MirrorEvent } from '../types.ts'

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const WS = 'ws_mirror_host'
const MIRROR_ROOT = join(CONFIG_DIR, 'mirror-root')

function writeConfig(sessionMirror: unknown): void {
  writeFileSync(CONFIG_FILE, JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...(sessionMirror === undefined ? {} : { sessionMirror }),
  }), 'utf-8')
}

function storedSession(id: string, messageCount: number): StoredSession {
  return {
    id,
    workspaceId: WS,
    createdAt: 1000,
    lastUsedAt: 2000,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: `m-${index + 1}`,
      type: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `message ${index + 1}`,
      timestamp: 3000 + index,
    })),
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  }
}

function mirrorTranscript(sessionId: string): Array<Record<string, unknown>> {
  const file = join(MIRROR_ROOT, WS, sessionId, 'transcript.jsonl')
  return readFileSync(file, 'utf-8').trim().split('\n').map(line => JSON.parse(line))
}

beforeEach(() => {
  resetSessionMirrorHostForTests()
  rmSync(MIRROR_ROOT, { recursive: true, force: true })
})

afterEach(() => {
  setSessionMirrorErrorSink(null)
  resetSessionMirrorHostForTests()
  rmSync(CONFIG_FILE, { force: true })
  rmSync(join(CONFIG_DIR, 'sessions', WS), { recursive: true, force: true })
  rmSync(MIRROR_ROOT, { recursive: true, force: true })
})

describe('session mirror production wiring', () => {
  it('a saved session appears in the mirror directory after flush, and a later flush appends only the diff', async () => {
    writeConfig({ adapter: 'directory', path: MIRROR_ROOT })

    await saveSession(storedSession('s-mirrored', 2))
    await sessionMirrorIdle()

    const localFile = join(CONFIG_DIR, 'sessions', WS, 's-mirrored', 'session.jsonl')
    expect(existsSync(localFile)).toBe(true)

    const entries = mirrorTranscript('s-mirrored')
    // Header entry + one entry per message, in order.
    expect(entries).toHaveLength(3)
    expect(entries[0]!.type).toBe('session_header')
    expect((entries[1]!.data as { content: string }).content).toBe('message 1')
    expect((entries[2]!.data as { content: string }).content).toBe('message 2')

    // Second flush with one more message mirrors ONLY the diff: unchanged
    // messages never re-append; the new message plus one new header revision
    // (its messageCount really changed) do. lastUsedAt alone never re-mirrors
    // the header — the uuid hash excludes the volatile write stamp.
    await saveSession(storedSession('s-mirrored', 3))
    await sessionMirrorIdle()

    const after = mirrorTranscript('s-mirrored')
    expect(after).toHaveLength(5)
    expect(after.filter(entry => entry.type === 'message')).toHaveLength(3)
    expect(after.filter(entry => entry.type === 'session_header')).toHaveLength(2)
    expect((after[4]!.data as { content: string }).content).toBe('message 3')
  })

  it('an unwritable mirror never fails the local write and reports mirror_error through the sink', async () => {
    // The mirror "root" is a file, so every mkdir/append inside it rejects.
    mkdirSync(join(CONFIG_DIR), { recursive: true })
    writeFileSync(MIRROR_ROOT, 'not a directory', 'utf-8')
    writeConfig({ adapter: 'directory', path: MIRROR_ROOT })

    const events: MirrorEvent[] = []
    setSessionMirrorErrorSink(event => { events.push(event) })

    await saveSession(storedSession('s-unwritable', 1))
    await sessionMirrorIdle()

    // Local disk first and authoritative — the local write must be intact.
    const localFile = join(CONFIG_DIR, 'sessions', WS, 's-unwritable', 'session.jsonl')
    const lines = readFileSync(localFile, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!).content).toBe('message 1')

    expect(events).toHaveLength(1)
    expect(events[0]!.subtype).toBe('mirror_error')
    expect(events[0]!.key).toEqual({ workspaceId: WS, sessionId: 's-unwritable' })
    expect(events[0]!.reason.length).toBeGreaterThan(0)

    // The same failing reason is not re-surfaced on every flush (log-only);
    // the transcript sink stays quiet until the reason changes or a write lands.
    await saveSession(storedSession('s-unwritable', 1))
    await sessionMirrorIdle()
    expect(events).toHaveLength(1)
  })

  it('an unknown adapter fails closed: session persistence is unaffected and nothing throws', async () => {
    writeConfig({ adapter: 'webdav', path: MIRROR_ROOT })

    await saveSession(storedSession('s-bad-adapter', 1))
    await sessionMirrorIdle()

    const localFile = join(CONFIG_DIR, 'sessions', WS, 's-bad-adapter', 'session.jsonl')
    expect(existsSync(localFile)).toBe(true)
    expect(existsSync(join(MIRROR_ROOT, WS))).toBe(false)
  })

  it('evicting an active session mid-flush is harmless: store-side uuid dedup keeps the transcript exact', async () => {
    writeConfig({ adapter: 'directory', path: MIRROR_ROOT })

    await saveSession(storedSession('s-evicted', 2))
    await sessionMirrorIdle()
    expect(hasSessionMirrorState({ workspaceId: WS, sessionId: 's-evicted' })).toBe(true)

    // Evict WHILE a new flush is in flight — the eviction serializes with the
    // dispatch, and the diff cache resets, so the next flush re-appends
    // everything; the store's uuid dedup keeps the re-delivery harmless.
    const save = saveSession(storedSession('s-evicted', 3))
    const evicted = evictSessionMirrorState({ workspaceId: WS, sessionId: 's-evicted' })
    await Promise.all([save, evicted])
    await sessionMirrorIdle()

    const entries = mirrorTranscript('s-evicted')
    const uuids = entries.map(entry => entry.uuid as string)
    expect(new Set(uuids).size).toBe(uuids.length)
    const messages = entries.filter(entry => entry.type === 'message')
    expect(new Set(messages.map(entry => (entry.data as { id: string }).id)).size).toBe(3)
    expect(messages.map(entry => (entry.data as { content: string }).content).sort()).toEqual([
      'message 1',
      'message 2',
      'message 3',
    ])
  })

  it('absent sessionMirror config means no mirror and no mirror directory', async () => {
    writeConfig(undefined)

    await saveSession(storedSession('s-no-mirror', 1))
    await sessionMirrorIdle()

    expect(existsSync(join(CONFIG_DIR, 'sessions', WS, 's-no-mirror', 'session.jsonl'))).toBe(true)
    expect(existsSync(MIRROR_ROOT)).toBe(false)
  })
})
