import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFileCheckpoint,
  finalizeFileCheckpoint,
  listFileCheckpoints,
  revertFileCheckpoint,
} from '../file-checkpoints'
import {
  deleteSession,
  getSessionDirPath,
} from '../storage'
import { SESSIONS_DIR } from '../../workspaces/paths'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `file-checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('file checkpoints', () => {
  let workspaceRoot: string
  let workspaceId: string
  let sessionPath: string

  beforeEach(() => {
    workspaceRoot = makeTmpDir()
    workspaceId = `file-checkpoint-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`
    sessionPath = getSessionDirPath(workspaceId, '260706-file-checkpoint')
    mkdirSync(sessionPath, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(workspaceRoot)) {
      rmSync(workspaceRoot, { recursive: true, force: true })
    }
    rmSync(join(SESSIONS_DIR, workspaceId), { recursive: true, force: true })
  })

  it('captures a pre-write snapshot for edit tools', async () => {
    const filePath = join(workspaceRoot, 'note.txt')
    writeFileSync(filePath, 'before')

    const entries = await createFileCheckpoint({
      sessionPath,
      adapter: 'file',
      toolName: 'Edit',
      toolCallId: 'tool-1',
      input: { file_path: filePath },
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]!.existed).toBe(true)
    expect(entries[0]!.filePath).toBe(filePath)

    const checkpoints = await listFileCheckpoints(sessionPath)
    expect(checkpoints).toHaveLength(1)
    const snapshotFile = checkpoints[0]!.snapshotFile
    expect(snapshotFile).toBeDefined()
    expect(readFileSync(join(sessionPath, snapshotFile!), 'utf8')).toBe('before')
  })

  it('reverts the latest checkpoint to the original bytes', async () => {
    const filePath = join(workspaceRoot, 'note.txt')
    writeFileSync(filePath, 'before')

    const [checkpoint] = await createFileCheckpoint({
      sessionPath,
      adapter: 'file',
      toolName: 'Write',
      input: { file_path: filePath },
    })
    writeFileSync(filePath, 'after')
    await finalizeFileCheckpoint({ sessionPath, checkpointId: checkpoint!.id, succeeded: true })

    const result = await revertFileCheckpoint({ sessionPath })

    expect(result).toMatchObject({ success: true, restored: true, filePath })
    expect(readFileSync(filePath, 'utf8')).toBe('before')
  })

  it('removes files created after a missing-file checkpoint', async () => {
    const filePath = join(workspaceRoot, 'new-file.txt')

    const [checkpoint] = await createFileCheckpoint({
      sessionPath,
      adapter: 'file',
      toolName: 'Write',
      input: { path: filePath },
    })
    writeFileSync(filePath, 'created')
    await finalizeFileCheckpoint({ sessionPath, checkpointId: checkpoint!.id, succeeded: true })

    const result = await revertFileCheckpoint({ sessionPath })

    expect(result).toMatchObject({ success: true, deleted: true, filePath })
    expect(existsSync(filePath)).toBe(false)
  })

  it('reclaims snapshots when the session is deleted', async () => {
    const filePath = join(workspaceRoot, 'note.txt')
    writeFileSync(filePath, 'before')

    await createFileCheckpoint({
      sessionPath,
      adapter: 'file',
      toolName: 'Edit',
      input: { file_path: filePath },
    })

    expect(existsSync(join(sessionPath, 'file_checkpoints'))).toBe(true)
    expect(deleteSession(workspaceId, '260706-file-checkpoint')).toBe(true)
    expect(existsSync(sessionPath)).toBe(false)
  })
})
