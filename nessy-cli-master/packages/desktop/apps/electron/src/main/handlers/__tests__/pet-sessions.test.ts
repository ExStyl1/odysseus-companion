/**
 * [nessy-fork] desktop-pet-session-aggregation
 *
 * pet:answerTerminalSession / pet:focusTerminalSession handler coverage and
 * the external-session watcher wiring. The watcher and the AppleScript focus
 * helper are mocked at module level — their own behaviour has dedicated
 * collocated tests; here we assert the handler contract: untrusted paths are
 * validated against the ~/.nessy/ctl layout BEFORE any write.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { TerminalSessionWatcher } from '../../session/terminal-session-watcher'
import type { HandlerDeps } from '../handler-deps'

type HandlerFn = (ctx: unknown, ...args: unknown[]) => Promise<unknown> | unknown

// Captured by the injected seams, read by assertions. pet-window takes these
// as explicit parameters precisely because bun shares the module registry
// across test files — a mock.module here cannot rebind an already-cached
// pet-window import in the full-suite run.
const watcherCreations: Array<{ dir: string; deps: Record<string, unknown> }> =
  []
const focusCalls: Array<{ pid?: number; workDir?: string }> = []

// The ctl-root validation reads os.homedir(), and bun's homedir() ignores a
// repointed $HOME — so the module itself is mocked with a mutable root.
// (Spread of the real module keeps every other os export intact.)
let fakeHomeDir = '/nonexistent-pet-home'
mock.module('node:os', () => ({
  ...require('node:os'),
  homedir: () => fakeHomeDir,
}))

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    once: () => {},
  },
}))

describe('pet session handlers', () => {
  const handlers = new Map<string, HandlerFn>()
  const pushed: Array<{ channel: string; target: unknown; args: unknown[] }> = []
  const activeDesktopIds = [{ sessionId: 'ds-1' }, { sessionId: 'ds-2' }]

  let fakeHome = ''
  let ctlRoot = ''
  let inputFile = ''

  async function answer(payload: unknown) {
    const handler = handlers.get(RPC_CHANNELS.pet.ANSWER_TERMINAL_SESSION)
    if (!handler) throw new Error('answer handler not registered')
    return (await handler({}, payload)) as { ok: boolean; error?: string }
  }

  async function focus(payload: unknown) {
    const handler = handlers.get(RPC_CHANNELS.pet.FOCUS_TERMINAL_SESSION)
    if (!handler) throw new Error('focus handler not registered')
    return handler({}, payload)
  }

  // The node:os mock is file-scoped, but the tmp fixture dirs are not.
  afterAll(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })

  beforeEach(async () => {
    handlers.clear()
    pushed.length = 0
    watcherCreations.length = 0
    focusCalls.length = 0

    fakeHome = mkdtempSync(join(tmpdir(), 'pet-home-'))
    fakeHomeDir = fakeHome
    ctlRoot = join(fakeHome, '.nessy', 'ctl')
    const sessionCtl = join(ctlRoot, 'sess-1')
    mkdirSync(sessionCtl, { recursive: true })
    inputFile = join(sessionCtl, 'input.jsonl')
    writeFileSync(inputFile, '')

    const server = {
      handle(channel: string, handler: HandlerFn) {
        handlers.set(channel, handler)
      },
      push(channel: string, target: unknown, ...args: unknown[]) {
        pushed.push({ channel, target, args })
      },
      async invokeClient() {
        return null
      },
    } as unknown as RpcServer

    const deps = {
      sessionManager: {
        getActiveSessionsInfo: () => activeDesktopIds,
      },
    } as unknown as HandlerDeps

    const { registerPetWindowGuiHandlers } = await import('../pet-window')
    registerPetWindowGuiHandlers(server, deps, {
      createWatcher: (dir, watcherDeps) => {
        watcherCreations.push({
          dir,
          deps: watcherDeps as unknown as Record<string, unknown>,
        })
        return { start() {}, stop() {} } as unknown as TerminalSessionWatcher
      },
      focusTerminal: async (opts) => {
        focusCalls.push(opts)
        return true
      },
    })
  })

  describe('watcher wiring', () => {
    it('starts a TerminalSessionWatcher that pushes updates to all windows', () => {
      expect(watcherCreations).toHaveLength(1)
      const { deps } = watcherCreations[0]!

      const emit = deps['emit'] as (u: unknown) => void
      emit({ sessionId: 'terminal:x', source: 'terminal', phase: 'working' })

      expect(pushed).toEqual([
        {
          channel: RPC_CHANNELS.pet.SESSION_UPDATE,
          target: { to: 'all' },
          args: [{ sessionId: 'terminal:x', source: 'terminal', phase: 'working' }],
        },
      ])
    })

    it('feeds the watcher live desktop session ids for de-duplication', () => {
      const { deps } = watcherCreations[0]!
      const ids = (deps['getDesktopSessionIds'] as () => Set<string>)()

      expect(ids).toEqual(new Set(['ds-1', 'ds-2']))
    })
  })

  describe('pet:answerTerminalSession — happy paths', () => {
    it('appends an MR2 confirmation_response line with option_id', async () => {
      const res = await answer({
        controlInputFile: inputFile,
        requestId: 'req-1',
        optionId: 'q0_opt0',
      })

      expect(res.ok).toBe(true)
      expect(readFileSync(inputFile, 'utf-8')).toBe(
        '{"type":"confirmation_response","request_id":"req-1","option_id":"q0_opt0"}\n',
      )
    })

    it('appends the legacy cancel form (allowed:false) without optionId', async () => {
      const res = await answer({
        controlInputFile: inputFile,
        requestId: 'req-1',
        cancel: true,
      })

      expect(res.ok).toBe(true)
      expect(readFileSync(inputFile, 'utf-8')).toBe(
        '{"type":"confirmation_response","request_id":"req-1","allowed":false}\n',
      )
    })

    it('appends the legacy allow form (allowed:true) for option-less approvals', async () => {
      const res = await answer({
        controlInputFile: inputFile,
        requestId: 'req-1',
        allow: true,
      })

      expect(res.ok).toBe(true)
      expect(readFileSync(inputFile, 'utf-8')).toBe(
        '{"type":"confirmation_response","request_id":"req-1","allowed":true}\n',
      )
    })

    it('rejects a symlinked input.jsonl escaping the ctl root', async () => {
      // GIVEN: input.jsonl is a symlink pointing outside the ctl tree
      const victim = join(fakeHome, 'victim.txt')
      writeFileSync(victim, 'secret')
      const linkedSession = join(ctlRoot, 'sess-linked')
      mkdirSync(linkedSession, { recursive: true })
      const linkedInput = join(linkedSession, 'input.jsonl')
      symlinkSync(victim, linkedInput)

      // WHEN: answering through the symlinked path
      const res = await answer({
        controlInputFile: linkedInput,
        requestId: 'req-9',
        optionId: 'q0_opt0',
      })

      // THEN: rejected without writing through the symlink
      expect(res.ok).toBe(false)
      expect(res.error).toContain('outside the ctl directory')
      expect(readFileSync(victim, 'utf-8')).toBe('secret')
    })
  })

  describe('pet:answerTerminalSession — validation matrix', () => {
    it('rejects a missing controlInputFile / requestId / option', async () => {
      expect((await answer({ requestId: 'r', optionId: 'o' })).ok).toBe(false)
      expect((await answer({ controlInputFile: inputFile, optionId: 'o' })).ok).toBe(false)
      expect((await answer({ controlInputFile: inputFile, requestId: 'r' })).ok).toBe(false)
      expect((await answer(null)).ok).toBe(false)
      expect(readFileSync(inputFile, 'utf-8')).toBe('')
    })

    it('rejects path traversal outside the ctl root without writing', async () => {
      const evil = join(fakeHome, '.nessy', 'evil')
      mkdirSync(evil, { recursive: true })
      const evilFile = join(evil, 'input.jsonl')
      writeFileSync(evilFile, 'sentinel\n')
      const attempt = join(ctlRoot, 'sess-1', '..', '..', 'evil', 'input.jsonl')

      const res = await answer({ controlInputFile: attempt, requestId: 'r', optionId: 'o' })

      expect(res.ok).toBe(false)
      expect(res.error).toContain('~/.nessy/ctl')
      expect(readFileSync(evilFile, 'utf-8')).toBe('sentinel\n')
      expect(readFileSync(inputFile, 'utf-8')).toBe('')
    })

    it('rejects a wrong basename inside a valid session dir', async () => {
      const res = await answer({
        controlInputFile: join(ctlRoot, 'sess-1', 'events.jsonl'),
        requestId: 'r',
        optionId: 'o',
      })

      expect(res.ok).toBe(false)
      expect(readFileSync(inputFile, 'utf-8')).toBe('')
    })

    it('rejects nested session dirs and unsafe session ids', async () => {
      const nested = join(ctlRoot, 'a', 'b')
      mkdirSync(nested, { recursive: true })
      const nestedFile = join(nested, 'input.jsonl')
      writeFileSync(nestedFile, '')

      const nestedRes = await answer({
        controlInputFile: nestedFile,
        requestId: 'r',
        optionId: 'o',
      })
      expect(nestedRes.ok).toBe(false)
      expect(readFileSync(nestedFile, 'utf-8')).toBe('')

      const symlinkLike = join(ctlRoot, 'sess..%2fevil', 'input.jsonl')
      const weirdRes = await answer({
        controlInputFile: symlinkLike,
        requestId: 'r',
        optionId: 'o',
      })
      expect(weirdRes.ok).toBe(false)
    })

    it('reports a missing session dir as ok:false instead of creating it', async () => {
      const res = await answer({
        controlInputFile: join(ctlRoot, 'never-created', 'input.jsonl'),
        requestId: 'r',
        optionId: 'o',
      })

      // Shape-valid path, but appendFile must not mkdir on our behalf.
      expect(res.ok).toBe(false)
      expect(existsSync(join(ctlRoot, 'never-created'))).toBe(false)
      expect(readFileSync(inputFile, 'utf-8')).toBe('')
    })
  })

  describe('pet:focusTerminalSession', () => {
    it('delegates the payload to the terminal focus helper', async () => {
      await focus({ pid: 4242, workDir: '/w/repo' })

      expect(focusCalls).toEqual([{ pid: 4242, workDir: '/w/repo' }])
    })

    it('tolerates an absent payload', async () => {
      await focus(undefined)

      expect(focusCalls).toEqual([{}])
    })
  })
})
