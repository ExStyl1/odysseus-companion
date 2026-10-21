import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { RPC_CHANNELS } from '../../../shared/types'
import { registerSessionsHandlers, cleanupSessionFileWatchForClient } from '@nessy-agent/server-core/handlers/rpc'
import type { RpcServer } from '@nessy-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

type HandlerFn = (ctx: { clientId: string }, ...args: any[]) => Promise<any> | any

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for the EFFECT, not for a fixed number of milliseconds.
 *
 * A filesystem watcher's latency is the OS's to decide, so `await wait(300)`
 * is a budget that holds on an idle machine and loses under full-suite load —
 * this file failed exactly that way in the 2026-08-08 close-out run while
 * passing 3/3 alone. Polling makes the wait as long as it needs to be and no
 * longer, and the label says what never happened when it times out.
 */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${label}`)
    await wait(10)
  }
}

function pushedFilesChangedFor(
  pushed: Array<{ channel: string; target: any; args: any[] }>,
  clientId: string,
  sessionId: string,
): boolean {
  return pushed.some((evt) => evt.target?.to === 'client'
    && evt.target?.clientId === clientId
    && evt.channel === RPC_CHANNELS.sessions.FILES_CHANGED
    && evt.args[0] === sessionId)
}

describe('sessions file watchers', () => {
  const handlers = new Map<string, HandlerFn>()
  const pushed: Array<{ channel: string; target: any; args: any[] }> = []

  let tempRoot = ''
  let sessionDirA = ''
  let sessionDirB = ''

  beforeEach(() => {
    handlers.clear()
    pushed.length = 0

    tempRoot = mkdtempSync(join(tmpdir(), 'nessy-session-watchers-'))
    sessionDirA = join(tempRoot, 'session-a')
    sessionDirB = join(tempRoot, 'session-b')
    mkdirSync(sessionDirA, { recursive: true })
    mkdirSync(sessionDirB, { recursive: true })

    const server: RpcServer = {
      handle(channel, handler) {
        handlers.set(channel, handler as HandlerFn)
      },
      push(channel, target, ...args) {
        pushed.push({ channel, target, args })
      },
      async invokeClient() {
        return null
      },
      hasClientCapability() { return false },
      findClientsWithCapability() { return [] },
    }

    const deps: HandlerDeps = {
      sessionManager: {
        getSessionPath: (sessionId: string) => {
          if (sessionId === 'session-a') return sessionDirA
          if (sessionId === 'session-b') return sessionDirB
          return null
        },
      } as unknown as HandlerDeps['sessionManager'],
      platform: {
        appRootPath: '',
        resourcesPath: '',
        isPackaged: false,
        appVersion: '0.0.0-test',
        isDebugMode: true,
        imageProcessor: {
          getMetadata: async () => null,
          process: async () => Buffer.from(''),
        },
        logger: {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
        },
      },
      oauthFlowStore: {
        store: () => {},
        getByState: () => null,
        remove: () => {},
        cleanup: () => {},
        dispose: () => {},
        get size() { return 0 },
      } as unknown as HandlerDeps['oauthFlowStore'],
    }

    registerSessionsHandlers(server, deps)
  })

  afterEach(() => {
    cleanupSessionFileWatchForClient('client-a')
    cleanupSessionFileWatchForClient('client-b')
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('isolates file change notifications per client watcher', async () => {
    const watch = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)
    const unwatch = handlers.get(RPC_CHANNELS.sessions.UNWATCH_FILES)
    expect(watch).toBeTruthy()
    expect(unwatch).toBeTruthy()

    await watch!({ clientId: 'client-a' }, 'session-a')
    await watch!({ clientId: 'client-b' }, 'session-b')
    await wait(50)

    writeFileSync(join(sessionDirA, 'a.txt'), `a-${Date.now()}`)
    writeFileSync(join(sessionDirB, 'b.txt'), `b-${Date.now()}`)
    await waitUntil(
      () => pushedFilesChangedFor(pushed, 'client-a', 'session-a')
        && pushedFilesChangedFor(pushed, 'client-b', 'session-b'),
      'both watchers to report their own session',
    )

    expect(pushedFilesChangedFor(pushed, 'client-a', 'session-a')).toBe(true)
    expect(pushedFilesChangedFor(pushed, 'client-b', 'session-b')).toBe(true)

    pushed.length = 0
    await unwatch!({ clientId: 'client-a' })

    writeFileSync(join(sessionDirA, 'a.txt'), `a2-${Date.now()}`)
    writeFileSync(join(sessionDirB, 'b.txt'), `b2-${Date.now()}`)
    // Anchor the ABSENCE on the sibling's arrival. Waiting a fixed 300ms and
    // then asserting client-a got nothing proves nothing when the watcher was
    // merely slow — B's event is the evidence that this round of writes was
    // seen at all, so A's silence is a real isolation result.
    await waitUntil(
      () => pushedFilesChangedFor(pushed, 'client-b', 'session-b'),
      'the still-watching client to report its own session',
    )

    const aEventsAfter = pushed.filter((evt) => evt.target?.clientId === 'client-a')
    expect(aEventsAfter.length).toBe(0)
    expect(pushedFilesChangedFor(pushed, 'client-b', 'session-b')).toBe(true)
  })

  it('disconnect cleanup removes watcher and prevents further events', async () => {
    const watch = handlers.get(RPC_CHANNELS.sessions.WATCH_FILES)
    expect(watch).toBeTruthy()

    await watch!({ clientId: 'client-a' }, 'session-a')
    await wait(50)

    cleanupSessionFileWatchForClient('client-a')
    pushed.length = 0

    writeFileSync(join(sessionDirA, 'after-cleanup.txt'), `x-${Date.now()}`)
    await wait(300)

    expect(pushed.length).toBe(0)
  })
})
