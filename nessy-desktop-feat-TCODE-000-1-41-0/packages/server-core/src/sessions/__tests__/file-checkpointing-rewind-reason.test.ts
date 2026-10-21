/**
 * P6.272, the third control — with the switch off the rewind entry reports the
 * HONEST reason instead of failing.
 *
 * `managedRuntimeTracksFileEdits` is the one seam that answers "are this
 * session's file edits tracked", and its answer becomes
 * `conversation_rewound.fileCheckpointsTracked`, which the renderer turns into
 * `toast.fileCheckpointsNotTracked` ("This session's runtime does not create
 * file checkpoints, so there is nothing to revert"). With checkpointing off,
 * `createFileCheckpoint` writes nothing — so a `true` here would promise a
 * restore from an empty manifest, which is the failure mode `done_means` names.
 *
 * The runtime arm is asserted beside it, unchanged, so this cannot pass by
 * turning every session's answer into `false`.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from '@nessy-agent/shared/config/paths'
import { setFileCheckpointingEnabled } from '@nessy-agent/shared/config/storage'
import { createTestSessionManager } from './test-session-manager.ts'

/**
 * `loadConfigForMutation` refuses to write when `config.json` is absent — the
 * fail-closed rule that stops a half-initialised install from being given a
 * fresh file. The isolate preload hands this run an empty temp `CONFIG_DIR`, so
 * the file has to exist before any setter is meaningful; without this the
 * setters log "the change was NOT persisted" and every assertion measures the
 * default.
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

function managerFor(provider: string) {
  const manager = createTestSessionManager() as any
  const managed = { id: 's', workspace: { id: 'w', rootPath: '/tmp/p6272' } }
  manager.resolveManagedProvider = () => provider
  return { manager, managed }
}

const tracks = (provider: string): boolean | undefined => {
  const { manager, managed } = managerFor(provider)
  return manager.managedRuntimeTracksFileEdits(managed)
}

describe('P6.272 · the rewind entry’s honest reason', () => {
  afterEach(() => { setFileCheckpointingEnabled(true) })

  test('with the switch ON the runtime table still decides, both ways', () => {
    setFileCheckpointingEnabled(true)
    expect(tracks('pi')).toBe(true)
    expect(tracks('nestor-cloud-agent')).toBe(true)
    expect(tracks('anthropic')).toBe(false)
    // C3.67 · codex moved to the TRUE side when it got a real producer
    // (`CodexAgent.checkpointCodexFileChange`). It is asserted here rather than
    // dropped, because this test's whole claim is "the table decides, both
    // ways" and a runtime that changed side is the strongest evidence of that.
    expect(tracks('codex-runtime')).toBe(true)
  })

  test('with the switch OFF even the producing runtimes report not-tracked', () => {
    setFileCheckpointingEnabled(false)
    expect(tracks('pi')).toBe(false)
    expect(tracks('nestor-cloud-agent')).toBe(false)
    // And the runtimes that never tracked are unchanged, so the switch adds a
    // reason rather than replacing one.
    expect(tracks('anthropic')).toBe(false)
  })
})
