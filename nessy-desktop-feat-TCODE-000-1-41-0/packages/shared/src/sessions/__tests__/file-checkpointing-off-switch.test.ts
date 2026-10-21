/**
 * P6.272 — one host switch turns file checkpointing off on every runtime.
 *
 * The gate sits inside `createFileCheckpoint` because that is the ONE place both
 * host-side producers pass through — Pi in its subprocess and
 * `nestor-cloud-agent` in this process, the two `RUNTIME_FILE_CHECKPOINT_PRODUCERS`
 * declares — and they run in different PROCESSES, so two call-site gates would
 * have been two spellings of one rule with no way to keep them equal.
 *
 * The claude arm is the SDK OPTION rather than the settings key, and that is not
 * a shortcut: `settings-reference.md#filecheckpointingenabled` ends *"In a `-p`
 * run or an Agent SDK session, Claude Code ignores this key. The SDK turns
 * checkpointing on with its `enableFileCheckpointing` option"*. Every session
 * this product runs is an Agent SDK session. What is pinned here is the
 * consequence P3.48 predicted in `live-session.ts`: the option has a writer, so
 * the construction signature must separate the children or a session that flips
 * the setting mid-run keeps the old one.
 *
 * P6.851 (owner decision 2026-09-10) made that writer UNCONDITIONAL — the claude
 * child now receives `enableFileCheckpointing: getFileCheckpointingEnabled()`,
 * `true` as well as `false`, so the SDK produces checkpoints on claude for the
 * first time. The ON arm below pins that. What it does NOT pin, deliberately, is
 * a restore: `Query.rewindFiles()` has no call site in this tree and the SDK's
 * store is not our manifest, so claude's `/rewind` restoring code is a live
 * (P7.5) case, not a unit assertion. Faking it here would be the exact lie
 * `RUNTIME_FILE_CHECKPOINT_PRODUCERS` exists to prevent.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeLiveSessionSignature } from '../../agent/backend/claude/live-session.ts'
import { CONFIG_DIR } from '../../config/paths.ts'
import {
  getFileCheckpointingEnabled,
  setFileCheckpointingEnabled,
} from '../../config/storage.ts'
import { createFileCheckpoint, listFileCheckpoints } from '../file-checkpoints.ts'
import { getSessionDirPath } from '../storage.ts'
import { SESSIONS_DIR } from '../../workspaces/paths.ts'

/**
 * `loadConfigForMutation` refuses to write when `config.json` is absent — the
 * fail-closed rule that stops a half-initialised install from being handed a
 * fresh file. The isolate preload gives this run an empty temp `CONFIG_DIR`, so
 * without this seed every setter below would log "the change was NOT persisted"
 * and each assertion would silently measure the default instead.
 */
beforeAll(() => {
  const configPath = join(CONFIG_DIR, 'config.json')
  if (existsSync(configPath)) return
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(configPath, JSON.stringify({
    storageLayoutVersion: 2,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  }, null, 2), 'utf-8')
})

describe('P6.272 · the file-checkpointing off switch', () => {
  let workspaceRoot: string
  let workspaceId: string
  let sessionPath: string

  beforeEach(() => {
    workspaceRoot = join(tmpdir(), `p6272-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(workspaceRoot, { recursive: true })
    workspaceId = `p6272-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sessionPath = getSessionDirPath(workspaceId, '260908-file-checkpointing')
    mkdirSync(sessionPath, { recursive: true })
  })

  afterEach(() => {
    setFileCheckpointingEnabled(true)
    if (existsSync(workspaceRoot)) rmSync(workspaceRoot, { recursive: true, force: true })
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
  })

  const snapshot = (name: string, callId: string) => {
    const filePath = join(workspaceRoot, name)
    writeFileSync(filePath, 'before')
    return createFileCheckpoint({
      sessionPath,
      adapter: 'file',
      toolName: 'Edit',
      toolCallId: callId,
      input: { file_path: filePath },
    })
  }

  it('defaults ON — the documented default, and today’s behaviour is unchanged', async () => {
    expect(getFileCheckpointingEnabled()).toBe(true)

    const entries = await snapshot('on.txt', 'call-on')

    expect(entries).toHaveLength(1)
    expect(await listFileCheckpoints(sessionPath)).toHaveLength(1)
  })

  it('OFF writes nothing at all — not an empty entry, not a manifest row', async () => {
    setFileCheckpointingEnabled(false)

    const entries = await snapshot('off.txt', 'call-off')

    // `[]` is the answer both production callers already handle: each does
    // `const [checkpoint] = await createFileCheckpoint(...)` then `if
    // (!checkpoint) return`, so refusing needs no new shape anywhere.
    expect(entries).toEqual([])
    expect(await listFileCheckpoints(sessionPath)).toEqual([])
  })

  it('is read per call, so turning it back on resumes without a restart', async () => {
    setFileCheckpointingEnabled(false)
    expect(await snapshot('a.txt', 'call-1')).toEqual([])

    setFileCheckpointingEnabled(true)
    expect(await snapshot('b.txt', 'call-2')).toHaveLength(1)

    const manifest = await listFileCheckpoints(sessionPath)
    expect(manifest).toHaveLength(1)
  })

  it('the claude child is built differently for the two answers (P3.48’s obligation)', () => {
    const base = { cwd: '/tmp/p6272' } as never
    const on = claudeLiveSessionSignature({ ...(base as object), enableFileCheckpointing: true } as never)
    const off = claudeLiveSessionSignature({ ...(base as object), enableFileCheckpointing: false } as never)

    // Different signatures mean a session that flips the setting mid-run
    // RESPAWNS. There is no live setter for this option, so respawn is the only
    // route by which the child can learn the new answer.
    expect(off).not.toBe(on)
    // THREE answers now, not two (P6.851): the unset case is what a child built
    // by an older build hashed as, and it must hash apart from both — folding it
    // into ON would leave such a child alive under the new construction.
    const unset = claudeLiveSessionSignature({ ...(base as object) } as never)
    expect(new Set([on, off, unset]).size).toBe(3)
  })

  it('the claude ON arm reaches the child: the option follows the setting, both ways (P6.851)', () => {
    // The recurring defect this file's neighbours guard for is a helper tested
    // in a unit the turn path never reaches. The option is set inline in
    // `chatImpl`'s SDK options literal, so the production wiring is pinned the
    // way `claude-turn-options.test.ts` pins its own: on the source of the
    // literal itself.
    const source = readFileSync(new URL('../../agent/claude-agent.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/enableFileCheckpointing: getFileCheckpointingEnabled\(\),/)
    // And the shape it replaced must be gone: an off-only writer omitted the key
    // entirely when the setting was on, which is what left claude without a
    // producer. Written as the CALL it made, not as the bare option name, so the
    // paragraphs above explaining the change cannot satisfy it.
    expect(source).not.toContain('{ enableFileCheckpointing: false })')

    // The setting itself is the one the other two runtimes already read — the
    // same reader `createFileCheckpoint` consults, not a second config read.
    expect(getFileCheckpointingEnabled()).toBe(true)
    setFileCheckpointingEnabled(false)
    expect(getFileCheckpointingEnabled()).toBe(false)
  })
})
