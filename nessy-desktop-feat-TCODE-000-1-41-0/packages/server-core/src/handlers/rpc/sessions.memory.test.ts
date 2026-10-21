import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS, type MemoryAppendResult } from '@nessy-agent/shared/protocol'
import * as sharedConfig from '@nessy-agent/shared/config'
import { getUserMemoryFilePath } from '@nessy-agent/shared/agent/memory'
import type { HandlerDeps } from '../handler-deps'
import type { HandlerFn, RequestContext, RpcServer } from '../../transport/types'

// SPREAD the real module — the pattern of `sessions.shell-command.test.ts:16`.
// `mock.module` is process-global and permanent, so a replacement that lists
// only the two exports this file needs silently un-implements every OTHER
// export of `@nessy-agent/shared/config` for every test file that loads after
// it. That is not hypothetical: without the spread, `getMemoryEnabled` stayed
// stubbed to `true` all the way into
// `packages/shared/src/agent/memory/__tests__/agent-memory.test.ts`, whose
// "is entirely inert when auto memory is off" case then read `true` from the
// stub while its own config.json on disk said `false` — green alone, red in the
// full suite, and the failure pointed at memory rather than at this file.
const realSharedConfig = { ...sharedConfig }

mock.module('@nessy-agent/shared/config', () => ({
  ...realSharedConfig,
  getMemoryEnabled: () => true,
  getWorkspaceByNameOrId: () => null,
}))

// RESTORE it — the pattern of
// `packages/shared/src/agent/__tests__/claude-gateway-adapter.test.ts:79`.
// The spread above is not enough on its own, because the point of this mock is
// to override `getMemoryEnabled`, and that override is what leaks: without this
// hook the stub stays installed for every test file that loads afterwards.
afterAll(() => {
  mock.module('@nessy-agent/shared/config', () => realSharedConfig)
})

let tempDirs: string[] = []
const originalConfigDir = process.env.NESSY_CONFIG_DIR

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function createHarness(workingDirectory: string | null) {
  const handlers = new Map<string, HandlerFn>()

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }

  const deps: HandlerDeps = {
    sessionManager: {
      getWorkingDirectory: () => workingDirectory,
      waitForInit: async () => {},
      getSessions: () => [],
    } as unknown as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      imageProcessor: { getMetadata: async () => null, process: async () => Buffer.from('') },
    } as unknown as HandlerDeps['platform'],
    oauthFlowStore: {
      store() {}, getByState: () => null, remove() {}, cleanup() {}, dispose() {}, size: 0,
    } as unknown as HandlerDeps['oauthFlowStore'],
  }

  const { registerSessionsHandlers } = await import('./sessions')
  registerSessionsHandlers(server, deps)

  const ctx: RequestContext = { clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: null }
  return { handlers, ctx }
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []

  if (originalConfigDir === undefined) {
    delete process.env.NESSY_CONFIG_DIR
  } else {
    process.env.NESSY_CONFIG_DIR = originalConfigDir
  }
})

describe('session appendMemory command', () => {
  it('appends selected text to project memory through the sessions command handler', async () => {
    const projectDir = makeTempDir('nessy-project-memory-')
    process.env.NESSY_CONFIG_DIR = makeTempDir('nessy-user-memory-')
    const { handlers, ctx } = await createHarness(projectDir)

    const result = await handlers.get(RPC_CHANNELS.sessions.COMMAND)!(
      ctx,
      'session-1',
      { type: 'appendMemory', scope: 'project', text: '  Project uses Bun gates.  ' },
    ) as MemoryAppendResult

    const memoryPath = join(projectDir, 'MEMORY.md')
    expect(result).toEqual({ success: true, scope: 'project' })
    expect(JSON.stringify(result)).not.toContain(memoryPath)
    expect(readFileSync(memoryPath, 'utf8')).toContain('- Project uses Bun gates.')
  })

  /**
   * P6.704 — the target is whatever `getUserMemoryFilePath()` says, and the
   * assertion asks IT rather than naming a directory of its own.
   *
   * This case used to set `process.env.NESSY_CONFIG_DIR` to a fresh temp dir and
   * assert the append landed there, which passed only because the handler read
   * that variable LIVE and passed it as an explicit `configDir`. That is exactly
   * the bug the row names: an explicit directory outranks the user's
   * `autoMemoryDirectory` by contract, so on any machine that sets the variable
   * — every multi-instance dev run, and every test process — this one RPC wrote
   * somewhere other than the setting while every other reader honoured it. A
   * test written against the env var could not see that, because it was the
   * thing being asserted.
   */
  it('appends selected text where the memory store itself resolves user memory', async () => {
    const projectDir = makeTempDir('nessy-project-memory-')
    const { handlers, ctx } = await createHarness(projectDir)

    const result = await handlers.get(RPC_CHANNELS.sessions.COMMAND)!(
      ctx,
      'session-1',
      { type: 'appendMemory', scope: 'user', text: 'User likes compact updates.' },
    ) as MemoryAppendResult

    const userMemoryPath = getUserMemoryFilePath()
    expect(result).toEqual({ success: true, scope: 'user' })
    expect(JSON.stringify(result)).not.toContain(userMemoryPath)
    expect(readFileSync(userMemoryPath, 'utf8')).toContain('- User likes compact updates.')
    expect(existsSync(join(projectDir, 'MEMORY.md'))).toBe(false)
  })

  /**
   * The negative arm, and the one that would have caught the defect: a
   * `NESSY_CONFIG_DIR` set AFTER the process started must not move the target.
   *
   * `CONFIG_DIR` freezes at first import (`config/paths.ts`), so a mid-process
   * change to the variable moves nothing for any other reader in the tree. The
   * handler used to be the single exception, and an exception in a path that
   * decides WHERE A FILE IS WRITTEN is a divergence, not a convenience.
   */
  it('does not follow a NESSY_CONFIG_DIR set after the process started', async () => {
    const projectDir = makeTempDir('nessy-project-memory-')
    const strayDir = makeTempDir('nessy-stray-memory-')
    process.env.NESSY_CONFIG_DIR = strayDir
    const { handlers, ctx } = await createHarness(projectDir)

    await handlers.get(RPC_CHANNELS.sessions.COMMAND)!(
      ctx,
      'session-1',
      { type: 'appendMemory', scope: 'user', text: 'Written to the frozen root.' },
    ) as MemoryAppendResult

    expect(existsSync(join(strayDir, 'MEMORY.md'))).toBe(false)
    expect(readFileSync(getUserMemoryFilePath(), 'utf8')).toContain('- Written to the frozen root.')
  })
})
