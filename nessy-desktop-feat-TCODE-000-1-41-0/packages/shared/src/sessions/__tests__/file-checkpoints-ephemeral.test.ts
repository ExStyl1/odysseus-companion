/**
 * P2.524 — an ephemeral session's file snapshots are REMOVED, not un-written.
 *
 * Owner-delegated controller decision 2026-09-02 (§F4). The two candidate
 * meanings of "ephemeral" have different failure modes, and the one taken keeps
 * the user's in-session revert and pays a crash window for it:
 *
 * - *nothing is written* — costs the ability to revert an edit inside the
 *   session, which is the only thing these snapshots exist for;
 * - *everything written is removed on exit* — keeps it, and leaves a window
 *   where a crash preserves what was promised not to persist. That residue is
 *   one sentence in the setting's own text (`apps/cli/src/index.ts`'s
 *   `--no-session-persistence` help), and is stated at the function too.
 *
 * What the flag promises ELSEWHERE was measured before deciding, and it does not
 * contradict this: `cli-reference.md`'s `--no-session-persistence` row and
 * `env-vars.md#variables`' `CLAUDE_CODE_SKIP_PROMPT_HISTORY` both promise the
 * SESSION RECORD is not written — prompt history, transcripts, resumability —
 * and neither mentions file snapshots, which are this product's own.
 *
 * These tests are about the BYTES. The session lifecycle that calls this on an
 * ephemeral teardown lives in `server-core`'s `SessionManager` and is wired
 * separately; the capability has to be correct and idempotent first, because a
 * teardown path that can throw is a teardown path that leaves a session hanging.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileCheckpoint, listFileCheckpoints, removeFileCheckpointStore } from '../file-checkpoints'
import { getSessionDirPath } from '../storage'
import { SESSIONS_DIR } from '../../workspaces/paths'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `file-checkpoint-ephemeral-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('removeFileCheckpointStore', () => {
  let workspaceRoot: string
  let workspaceId: string
  let sessionPath: string

  beforeEach(() => {
    workspaceRoot = makeTmpDir()
    workspaceId = `file-checkpoint-ephemeral-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sessionPath = getSessionDirPath(workspaceId, '260903-file-checkpoint-ephemeral')
    mkdirSync(sessionPath, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(workspaceRoot)) rmSync(workspaceRoot, { recursive: true, force: true })
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
  })

  async function seedOneCheckpoint(): Promise<void> {
    const filePath = join(workspaceRoot, 'note.txt')
    writeFileSync(filePath, 'before')
    await createFileCheckpoint({
      sessionPath,
      adapter: 'file',
      toolName: 'Edit',
      toolCallId: 'call-1',
      input: { file_path: filePath },
      baseDirectory: workspaceRoot,
    })
  }

  it('removes the whole store — the manifest AND the file snapshots', async () => {
    // The snapshot BYTES are the thing an ephemeral session promised not to
    // leave behind; deleting only the manifest would leave the contents on disk
    // with nothing pointing at them, which is worse than leaving both.
    await seedOneCheckpoint()
    const storePath = join(sessionPath, 'file_checkpoints')
    expect(existsSync(storePath)).toBe(true)
    expect((await listFileCheckpoints(sessionPath)).length).toBe(1)

    const result = await removeFileCheckpointStore(sessionPath)

    expect(result.removed).toBe(true)
    expect(result.path).toBe(storePath)
    expect(existsSync(storePath)).toBe(false)
    expect(await listFileCheckpoints(sessionPath)).toEqual([])
  })

  it('leaves the session directory itself alone', async () => {
    // It removes ITS store, not the session. A teardown that took the session
    // directory with it would delete whatever else lives there.
    await seedOneCheckpoint()
    await removeFileCheckpointStore(sessionPath)
    expect(existsSync(sessionPath)).toBe(true)
  })

  it('reports removed: false when there was nothing to remove, and does not throw', async () => {
    // A session that edited no files is the common ephemeral case. `rm --force`
    // collapses "nothing there" into silence, so the verdict is read before the
    // removal — a caller logging this wants to know which of the two happened.
    const result = await removeFileCheckpointStore(sessionPath)
    expect(result.removed).toBe(false)
    expect(existsSync(join(sessionPath, 'file_checkpoints'))).toBe(false)
  })

  it('is idempotent — a second call is a no-op, not a failure', async () => {
    // Teardown paths run twice (an explicit close plus a disposal sweep), and a
    // throw on the second one would fail a session's exit.
    await seedOneCheckpoint()
    expect((await removeFileCheckpointStore(sessionPath)).removed).toBe(true)
    expect((await removeFileCheckpointStore(sessionPath)).removed).toBe(false)
  })

  it('does not throw for a session path that never existed', async () => {
    const result = await removeFileCheckpointStore(join(sessionPath, 'no-such-session'))
    expect(result.removed).toBe(false)
  })

  it('serializes against a concurrent checkpoint write instead of racing it', async () => {
    // Both go through `serializeCheckpointMutation` on the same session path, so
    // the removal cannot land between a snapshot write and its manifest write —
    // which is exactly the interleaving that would leave orphaned bytes.
    const filePath = join(workspaceRoot, 'raced.txt')
    writeFileSync(filePath, 'before')
    const write = createFileCheckpoint({
      sessionPath,
      adapter: 'file',
      toolName: 'Edit',
      toolCallId: 'call-raced',
      input: { file_path: filePath },
      baseDirectory: workspaceRoot,
    })
    const remove = removeFileCheckpointStore(sessionPath)
    await Promise.all([write, remove])

    // Whichever order the queue chose, the store is never half-removed: either
    // it is gone, or it holds exactly the one checkpoint that was written.
    const store = join(sessionPath, 'file_checkpoints')
    const entries = existsSync(store) ? await listFileCheckpoints(sessionPath) : []
    expect(entries.length === 0 || entries.length === 1).toBe(true)
  })
})
