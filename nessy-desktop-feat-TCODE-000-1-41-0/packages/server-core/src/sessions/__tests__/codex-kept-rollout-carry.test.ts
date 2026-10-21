/**
 * F1.1272 (origin lane CR-2's residue, 2026-10-01) — a codex session's kept rollout tree
 * (`nessy-codex-sessions-<workspace>--<session>`, F1.1074) is keyed by workspace and session, so a
 * session MOVED to another workspace (`importSession(…, 'move')`, same session id, same codex
 * thread id on the resume path) finds no tree at its new key: `thread/resume` answers "no rollout"
 * and the user gets the resume-failed notice. A fork-IMPORT (mode 'fork') has the same gap one
 * level up: F1.1076's seeding reads `branchFrom.parent`, whose workspace the importer REBASES to
 * the target, so a same-host fork from another workspace's session cannot find the parent's tree.
 *
 * THE FIX — carry or relink, at the importer, by evidence in the kept-sessions root itself (the
 * bundle deliberately carries no server-local workspace identity, `serializeSession` deletes
 * `header.workspaceId`):
 * - move: the one tree the session id names is RENAMED to the target key — only when no live
 *   session holds that id (a shared id stays with its survivor), the target key is free, and the
 *   id names exactly ONE tree (two is ambiguous; none is a cross-server move, whose notice stays);
 * - fork: `branchFrom.parent.workspaceId` is re-pointed at the single origin workspace the parent
 *   session id names, so F1.1076's seeding finds it at every build.
 *
 * THE DEFECT (red at HEAD) — the tree stays under the source name and the rebased lineage stays.
 * CONTROLS — a live same-id session, an existing target tree, an ambiguous id, a cross-server
 * import, and a same-workspace fork all keep today's shapes.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { encodeSessionKey } from '@nessy-agent/shared/sessions/session-key'
import { codexKeptSessionsDirName } from '@nessy-agent/shared/agent/backend/codex/host-owned-dirs'

import { createTestSessionManager } from './test-session-manager.ts'

const ROOT = join(CONFIG_DIR, 'codex-home')
/** The tree-relative path seedTree writes for `threadId` (codex's own rollout layout). */
const rolloutRelative = (threadId: string) => join('2025', '10', '10', `rollout-2025-10-10T10-00-00-${threadId}.jsonl`)

const bundle = (id: string, extra: Record<string, unknown> = {}) => ({
  version: 1 as const,
  session: { header: { id, createdAt: 1, name: `S ${id}`, ...extra }, messages: [] },
  files: [],
})

/** A fork bundle: the importer builds the lineage from `branchInfo`, never from the header's. */
const forkBundle = (id: string, threadId: string) => ({
  ...bundle(id),
  branchInfo: { sdkSessionId: threadId, sdkTurnId: `turn-${id}`, sdkCwd: '/tmp/f1272-source-cwd' },
})

/** Seeds one kept tree with one rollout of `threadId`, and returns the tree's name. */
function seedTree(workspaceId: string, sessionId: string, threadId: string): string {
  const name = codexKeptSessionsDirName(workspaceId, sessionId)
  const rollout = join(ROOT, name, '2025', '10', '10', `rollout-2025-10-10T10-00-00-${threadId}.jsonl`)
  mkdirSync(join(rollout, '..'), { recursive: true })
  writeFileSync(rollout, `{"thread":"${threadId}"}\n`)
  return name
}

const treeNames = (): Set<string> =>
  new Set((existsSync(ROOT) ? readdirSync(ROOT) : []).filter(name => name.startsWith('nessy-codex-sessions-')))

describe('F1.1272 — a moved codex session carries its kept rollout tree; a fork import is relinked', () => {
  afterAll(() => {
    for (const name of treeNames()) rmSync(join(ROOT, name), { recursive: true, force: true })
  })

  test('THE DEFECT — a move carries the single source tree to the target key, source name gone', async () => {
    const source = seedTree('ws-src-a', 'sess-move-1', 'thread-move-1')
    const manager = createTestSessionManager() as any
    const imported = await manager.importSession('ws-dst-a', bundle('sess-move-1', { sdkSessionId: 'thread-move-1' }), 'move')
    expect(imported.sessionId).toBe('sess-move-1')
    const carried = join(ROOT, codexKeptSessionsDirName('ws-dst-a', 'sess-move-1'), rolloutRelative('thread-move-1'))
    expect(existsSync(carried)).toBe(true)
    expect(readFileSync(carried, 'utf-8')).toContain('thread-move-1')
    expect(existsSync(join(ROOT, source))).toBe(false)
  })

  test('CONTROL — a live session holding the same id keeps its tree where it is', async () => {
    const source = seedTree('ws-src-b', 'sess-move-2', 'thread-move-2')
    const manager = createTestSessionManager() as any
    // The id is LIVE in another workspace: registered directly, so no import can have carried
    // the tree before this arm's move (an import of the same id would do exactly that).
    manager.sessions.set(encodeSessionKey({ workspaceId: 'ws-live-b', sessionId: 'sess-move-2' }), {
      id: 'sess-move-2',
      workspace: { id: 'ws-live-b' },
    })
    await manager.importSession('ws-dst-b', bundle('sess-move-2', { sdkSessionId: 'thread-move-2' }), 'move')
    expect(existsSync(join(ROOT, source))).toBe(true)
    expect(existsSync(join(ROOT, codexKeptSessionsDirName('ws-dst-b', 'sess-move-2')))).toBe(false)
  })

  test('CONTROL — an existing tree at the target key is not clobbered and the source stays', async () => {
    const source = seedTree('ws-src-c', 'sess-move-3', 'thread-move-3')
    const target = codexKeptSessionsDirName('ws-dst-c', 'sess-move-3')
    mkdirSync(join(ROOT, target), { recursive: true })
    writeFileSync(join(ROOT, target, 'already-here.jsonl'), 'keep\n')
    const manager = createTestSessionManager() as any
    await manager.importSession('ws-dst-c', bundle('sess-move-3', { sdkSessionId: 'thread-move-3' }), 'move')
    expect(readFileSync(join(ROOT, target, 'already-here.jsonl'), 'utf-8')).toBe('keep\n')
    expect(existsSync(join(ROOT, source))).toBe(true)
  })

  test('CONTROL — an ambiguous id (trees in two workspaces) is not carried', async () => {
    const a = seedTree('ws-src-d1', 'sess-move-4', 'thread-move-4')
    const c = seedTree('ws-src-d2', 'sess-move-4', 'thread-move-4')
    const manager = createTestSessionManager() as any
    await manager.importSession('ws-dst-d', bundle('sess-move-4', { sdkSessionId: 'thread-move-4' }), 'move')
    expect(existsSync(join(ROOT, a))).toBe(true)
    expect(existsSync(join(ROOT, c))).toBe(true)
    expect(existsSync(join(ROOT, codexKeptSessionsDirName('ws-dst-d', 'sess-move-4')))).toBe(false)
  })

  test('CONTROL — a cross-server move (no tree on this host) imports cleanly', async () => {
    const manager = createTestSessionManager() as any
    const imported = await manager.importSession('ws-dst-e', bundle('sess-move-5', { sdkSessionId: 'thread-move-5' }), 'move')
    expect(imported.sessionId).toBe('sess-move-5')
  })

  test('THE DEFECT (fork) — a fork import is relinked to the origin workspace the parent tree lives in', async () => {
    seedTree('ws-src-f', 'sess-fork-1', 'thread-fork-1')
    const manager = createTestSessionManager() as any
    const imported = await manager.importSession('ws-dst-f', forkBundle('sess-fork-1', 'thread-fork-1'), 'fork')
    expect(imported.sessionId).not.toBe('sess-fork-1')
    const header = JSON.parse(readFileSync(join(manager.getSessionPath(imported.sessionId, 'ws-dst-f'), 'session.jsonl'), 'utf-8'))
    expect(header.branchFrom?.parent?.workspaceId).toBe('ws-src-f')
    expect(header.branchFrom?.parent?.sessionId).toBe('sess-fork-1')
    expect(header.branchFrom?.sdkSessionId).toBe('thread-fork-1')
  })

  test('CONTROL — a same-workspace fork import keeps the rebased lineage', async () => {
    seedTree('ws-dst-g', 'sess-fork-2', 'thread-fork-2')
    const manager = createTestSessionManager() as any
    const imported = await manager.importSession('ws-dst-g', forkBundle('sess-fork-2', 'thread-fork-2'), 'fork')
    const header = JSON.parse(readFileSync(join(manager.getSessionPath(imported.sessionId, 'ws-dst-g'), 'session.jsonl'), 'utf-8'))
    expect(header.branchFrom?.parent?.workspaceId).toBe('ws-dst-g')
  })

  test('CONTROL — a fork import with no origin tree keeps the rebased lineage (cross-server)', async () => {
    const manager = createTestSessionManager() as any
    const imported = await manager.importSession('ws-dst-h', forkBundle('sess-fork-3', 'thread-fork-3'), 'fork')
    const header = JSON.parse(readFileSync(join(manager.getSessionPath(imported.sessionId, 'ws-dst-h'), 'session.jsonl'), 'utf-8'))
    expect(header.branchFrom?.parent?.workspaceId).toBe('ws-dst-h')
  })
})
