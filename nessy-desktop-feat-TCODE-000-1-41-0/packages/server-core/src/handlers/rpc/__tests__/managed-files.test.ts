import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  SessionFileHandleError,
  SessionFileHandleRegistry,
} from '../../../domain/session-file-handles'
import { RPC_CHANNELS } from '@nessy-agent/shared/protocol'
import { registerSessionsHandlers } from '../sessions'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'nessy-session-handles-'))
  roots.push(parent)
  const sessionRoot = join(parent, 'session')
  const outsideRoot = join(parent, 'outside')
  mkdirSync(join(sessionRoot, 'nested'), { recursive: true })
  mkdirSync(outsideRoot)
  writeFileSync(join(sessionRoot, 'session.jsonl'), 'internal')
  writeFileSync(join(sessionRoot, '.hidden'), 'hidden')
  writeFileSync(join(sessionRoot, 'visible.txt'), 'visible')
  writeFileSync(join(sessionRoot, 'nested', 'deep.md'), '# deep')
  writeFileSync(join(outsideRoot, 'secret.txt'), 'outside-secret')
  symlinkSync(join(outsideRoot, 'secret.txt'), join(sessionRoot, 'escape.txt'))
  return { parent, sessionRoot }
}

describe('SessionFileHandleRegistry', () => {
  it('lists only opaque, session-contained handles without managed absolute paths', () => {
    const fx = fixture()
    let next = 0
    const registry = new SessionFileHandleRegistry({ newId: () => `handle-${++next}` })
    const session = { workspaceId: 'ws-a', sessionId: 'session-a' }

    const handles = registry.list('client-a', session, fx.sessionRoot)

    expect(handles.map(handle => [handle.displayPath, handle.kind])).toEqual([
      ['nested', 'directory'],
      ['nested/deep.md', 'file'],
      ['visible.txt', 'file'],
    ])
    const serialized = JSON.stringify(handles)
    expect(serialized).not.toContain(fx.parent)
    expect(serialized).not.toContain('session.jsonl')
    expect(serialized).not.toContain('.hidden')
    expect(serialized).not.toContain('escape.txt')
  })

  it('scope-checks handles, expires them on reconnect and previews allowlisted text', () => {
    const fx = fixture()
    let next = 0
    const registry = new SessionFileHandleRegistry({ newId: () => `opaque-handle-${++next}` })
    const session = { workspaceId: 'ws-a', sessionId: 'session-a' }
    const handle = registry.list('client-a', session, fx.sessionRoot)
      .find(candidate => candidate.displayPath === 'visible.txt')!

    expect(registry.preview('client-a', session, handle.handleId)).toBe('visible')
    expect(() => registry.resolve('client-b', session, handle.handleId)).toThrow(SessionFileHandleError)
    expect(() => registry.resolve('client-a', { ...session, workspaceId: 'ws-b' }, handle.handleId))
      .toThrow(SessionFileHandleError)

    registry.clearClient('client-a')
    expect(() => registry.resolve('client-a', session, handle.handleId)).toThrow(SessionFileHandleError)
  })
})

describe('managed session-file RPC', () => {
  it('keeps paths inside the handler for list, preview, open, reveal and clipboard actions', async () => {
    const fx = fixture()
    const handlers = new Map<string, (...args: any[]) => any>()
    const opened: string[] = []
    const revealed: string[] = []
    const copied: string[] = []
    const session = { workspaceId: 'ws-rpc', sessionId: 'session-rpc' }
    registerSessionsHandlers({
      handle: (channel: string, handler: (...args: any[]) => any) => handlers.set(channel, handler),
    } as any, {
      sessionManager: {
        getSessionPath: (sessionId: string, workspaceId: string) =>
          sessionId === session.sessionId && workspaceId === session.workspaceId ? fx.sessionRoot : null,
        getSessionAttachmentPath: async (sessionId: string, handleId: string, workspaceId: string) => {
          if (sessionId !== session.sessionId || workspaceId !== session.workspaceId || handleId !== 'attachment-handle') {
            throw new Error('unknown-attachment-handle')
          }
          return join(realpathSync(fx.sessionRoot), 'visible.txt')
        },
      },
      platform: {
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        openPath: async (path: string) => { opened.push(path) },
        showItemInFolder: (path: string) => { revealed.push(path) },
        writeClipboardText: (path: string) => { copied.push(path) },
      },
      oauthFlowStore: {},
    } as any)
    const ctx = { clientId: 'client-rpc', workspaceId: session.workspaceId }

    const files = await handlers.get(RPC_CHANNELS.sessions.GET_FILES)!(ctx, session)
    const visible = files.find((file: { displayPath: string }) => file.displayPath === 'visible.txt')
    expect(JSON.stringify(files)).not.toContain(fx.parent)
    expect(await handlers.get(RPC_CHANNELS.sessions.PREVIEW_FILE)!(ctx, {
      session,
      handleId: visible.handleId,
    })).toBe('visible')

    await handlers.get(RPC_CHANNELS.sessions.OPEN_FILE)!(ctx, { session, handleId: visible.handleId })
    await handlers.get(RPC_CHANNELS.sessions.OPEN_ATTACHMENT)!(ctx, { session, handleId: 'attachment-handle' })
    await handlers.get(RPC_CHANNELS.sessions.REVEAL_STORAGE)!(ctx, session)
    await handlers.get(RPC_CHANNELS.sessions.COPY_STORAGE_PATH)!(ctx, session)

    expect(opened).toEqual([
      join(realpathSync(fx.sessionRoot), 'visible.txt'),
      join(realpathSync(fx.sessionRoot), 'visible.txt'),
    ])
    expect(revealed).toEqual([fx.sessionRoot])
    expect(copied).toEqual([fx.sessionRoot])
  })
})
