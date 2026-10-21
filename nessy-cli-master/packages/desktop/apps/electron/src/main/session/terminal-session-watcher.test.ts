import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import {
  PET_SESSION_IDLE_HIDE_MS,
  TerminalSessionWatcher,
  resolveNessyDir,
  type TerminalSessionWatcherDeps,
} from './terminal-session-watcher'
import type { PetSessionUpdate } from '@craft-agent/shared/protocol'

const PID = 424_242
const NOW_MS = 1_700_000_000_000
const NOW_S = NOW_MS / 1000

interface SidecarOverrides {
  pid?: number
  session_id?: string
  work_dir?: string
  schema_version?: number
  state?: Record<string, unknown> | null
}

function makeSidecar(overrides: SidecarOverrides = {}) {
  return {
    schema_version: 1,
    pid: PID,
    session_id: 'sess-1',
    work_dir: '/Users/dev/work/my-repo',
    ...overrides,
    state: {
      phase: 'working',
      updated_at: NOW_S,
      pending_request: null,
      control: { input_file: '/Users/dev/.nessy/ctl/sess-1/input.jsonl' },
      ...(overrides.state ?? {}),
    },
  }
}

/** Distinct mtime so the size-identical rewrite of dedup tests still trips the fingerprint cache. */
function touch(path: string, ms = Date.now()): void {
  const t = new Date(ms)
  utimesSync(path, t, t)
}

describe('TerminalSessionWatcher', () => {
  let nessyDir: string
  let chatsDir: string
  let sidecarPath: string
  let emitted: PetSessionUpdate[]
  let desktopIds: Set<string>
  let killResult: ((pid: number, signal: number) => void) | ((pid: number, signal: number) => never)
  let psCommand: string | null
  const realKill = process.kill
  const realNessyHome = process.env['NESSY_HOME']

  function writeSidecar(data: unknown, mtimeMs?: number): void {
    writeFileSync(sidecarPath, JSON.stringify(data))
    if (mtimeMs !== undefined) touch(sidecarPath, mtimeMs)
  }

  function makeWatcher(overrides: Partial<TerminalSessionWatcherDeps> = {}) {
    const deps: TerminalSessionWatcherDeps = {
      emit: (update) => emitted.push(update),
      getDesktopSessionIds: () => desktopIds,
      now: () => NOW_MS,
      readProcessCommand: async () => psCommand,
      ...overrides,
    }
    return new TerminalSessionWatcher(nessyDir, deps)
  }

  beforeEach(() => {
    nessyDir = mkdtempSync(join(tmpdir(), 'pet-watcher-'))
    const projectDir = join(nessyDir, 'projects', 'proj-hash')
    chatsDir = join(projectDir, 'chats')
    mkdirSync(chatsDir, { recursive: true })
    sidecarPath = join(chatsDir, 'sess-1.runtime.json')
    emitted = []
    desktopIds = new Set()
    psCommand = '/usr/local/bin/nessy' // no --acp ⇒ terminal
    killResult = () => {}
    process.kill = ((pid: number, signal: number) => killResult(pid, signal)) as typeof process.kill
  })

  afterEach(() => {
    process.kill = realKill
    if (realNessyHome === undefined) delete process.env['NESSY_HOME']
    else process.env['NESSY_HOME'] = realNessyHome
    rmSync(nessyDir, { recursive: true, force: true })
  })

  describe('poll → pet:sessionUpdate normalization', () => {
    it('emits a normalized working snapshot for a live terminal session', async () => {
      writeSidecar(makeSidecar())

      await makeWatcher().poll()

      expect(emitted).toEqual([
        {
          sessionId: 'terminal:sess-1',
          source: 'terminal',
          phase: 'working',
          title: 'my-repo',
          workDir: '/Users/dev/work/my-repo',
          pid: PID,
          requestId: undefined,
          toolName: undefined,
          summary: undefined,
          options: undefined,
          controlInputFile: '/Users/dev/.nessy/ctl/sess-1/input.jsonl',
          updatedAt: NOW_S,
        },
      ])
    })

    it('maps a waiting_input pending_request to camelCase option list', async () => {
      writeSidecar(
        makeSidecar({
          state: {
            phase: 'waiting_input',
            updated_at: NOW_S,
            pending_request: {
              request_id: 'req-42',
              tool_name: 'AskUserQuestion',
              summary: 'Which DB?',
              options: [
                { option_id: 'q0_opt0', name: 'Postgres' },
                { option_id: 'q0_opt1' }, // name missing ⇒ falls back to option_id
              ],
            },
            control: null,
          },
        }),
      )

      await makeWatcher().poll()

      expect(emitted).toHaveLength(1)
      expect(emitted[0].phase).toBe('waiting_input')
      expect(emitted[0].requestId).toBe('req-42')
      expect(emitted[0].toolName).toBe('AskUserQuestion')
      expect(emitted[0].summary).toBe('Which DB?')
      expect(emitted[0].options).toEqual([
        { optionId: 'q0_opt0', name: 'Postgres' },
        { optionId: 'q0_opt1', name: 'q0_opt1' },
      ])
      expect(emitted[0].controlInputFile).toBeUndefined()
    })
  })

  describe('dedup', () => {
    it('does not re-emit identical state but emits on change', async () => {
      const watcher = makeWatcher()
      writeSidecar(makeSidecar(), 1_000)
      await watcher.poll()
      expect(emitted).toHaveLength(1)

      // Same content, new mtime: parse runs, dedup (phase/requestId/updatedAt) suppresses.
      writeSidecar(makeSidecar(), 2_000)
      await watcher.poll()
      expect(emitted).toHaveLength(1)

      // New phase ⇒ second emission.
      writeSidecar(
        makeSidecar({ state: { phase: 'waiting_input', updated_at: NOW_S + 5 } }),
        3_000,
      )
      await watcher.poll()
      expect(emitted).toHaveLength(2)
      expect(emitted[1].phase).toBe('waiting_input')
    })

    it('emits again when a new pending request replaces the old one in the same phase', async () => {
      const watcher = makeWatcher()
      const state = (requestId: string) => ({
        phase: 'waiting_input',
        updated_at: NOW_S,
        pending_request: { request_id: requestId },
      })
      writeSidecar(makeSidecar({ state: state('req-1') }), 1_000)
      await watcher.poll()
      writeSidecar(makeSidecar({ state: state('req-2') }), 2_000)
      await watcher.poll()

      expect(emitted).toHaveLength(2)
      expect(emitted[1].requestId).toBe('req-2')
    })
  })

  describe('liveness', () => {
    it('emits gone once when the CLI process dies without touching the sidecar', async () => {
      const watcher = makeWatcher()
      writeSidecar(makeSidecar(), 1_000)
      await watcher.poll()
      expect(emitted).toHaveLength(1)

      // kill -9: the CLI will never rewrite runtime.json — liveness must be
      // re-checked on every cycle despite the unchanged mtime.
      killResult = () => {
        const err = new Error('no such process') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      await watcher.poll()
      expect(emitted).toHaveLength(2)
      expect(emitted[1]).toMatchObject({
        sessionId: 'terminal:sess-1',
        source: 'terminal',
        phase: 'gone',
      })

      // Untracked — repeated polls stay silent.
      await watcher.poll()
      expect(emitted).toHaveLength(2)
    })

    it('treats EPERM (other user) as alive', async () => {
      killResult = () => {
        const err = new Error('not permitted') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      writeSidecar(makeSidecar())

      await makeWatcher().poll()

      expect(emitted).toHaveLength(1)
      expect(emitted[0].phase).toBe('working')
    })

    it('emits gone when the sidecar file disappears while shown', async () => {
      const watcher = makeWatcher()
      writeSidecar(makeSidecar(), 1_000)
      await watcher.poll()
      unlinkSync(sidecarPath)

      await watcher.poll()

      expect(emitted).toHaveLength(2)
      expect(emitted[1].phase).toBe('gone')
    })

    it('never emits for a sidecar whose pid was already dead on first sight', async () => {
      killResult = () => {
        const err = new Error('no such process') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      writeSidecar(makeSidecar())

      await makeWatcher().poll()

      expect(emitted).toHaveLength(0)
    })
  })

  describe('stale idle hiding', () => {
    it('clears a shown card when idle persists beyond the hide window', async () => {
      const watcher = makeWatcher()
      writeSidecar(makeSidecar(), 1_000)
      await watcher.poll()
      expect(emitted).toHaveLength(1)

      const staleIdleS = NOW_S - PET_SESSION_IDLE_HIDE_MS / 1000 - 60
      writeSidecar(
        makeSidecar({ state: { phase: 'idle', updated_at: staleIdleS } }),
        2_000,
      )
      await watcher.poll()

      expect(emitted).toHaveLength(2)
      expect(emitted[1].phase).toBe('gone')
    })

    it('keeps a fresh idle session visible', async () => {
      writeSidecar(makeSidecar({ state: { phase: 'idle', updated_at: NOW_S - 60 } }))

      await makeWatcher().poll()

      expect(emitted).toHaveLength(1)
      expect(emitted[0].phase).toBe('idle')
    })

    it('never shows an already-stale done sidecar, even with a live pid', async () => {
      // The pid-reuse / left-open-terminal case: yesterday's done snapshot
      // must not flash a card at startup (nor ever, until the CLI rewrites).
      const staleS = NOW_S - PET_SESSION_IDLE_HIDE_MS / 1000 - 60
      writeSidecar(makeSidecar({ state: { phase: 'done', updated_at: staleS } }))

      // Enough poll cycles to expose an oscillation (show → gone → show).
      const watcher = makeWatcher()
      await watcher.poll()
      await watcher.poll()
      await watcher.poll()

      expect(emitted).toHaveLength(0)
    })

    it('drops an aged done card exactly once — no show/hide oscillation', async () => {
      // Fresh done shows; then time passes past the hide window WITHOUT the
      // CLI touching the file (same fingerprint) — the card is dropped once
      // and never re-shown.
      let now = NOW_MS
      const watcher = makeWatcher({ now: () => now })
      writeSidecar(makeSidecar({ state: { phase: 'done', updated_at: NOW_S } }), 1_000)
      await watcher.poll()
      expect(emitted).toHaveLength(1)
      expect(emitted[0].phase).toBe('done')

      now = NOW_MS + PET_SESSION_IDLE_HIDE_MS + 60_000
      await watcher.poll() // fingerprint hit → stale → gone (sticky)
      await watcher.poll() // fingerprint still cached → silent
      await watcher.poll() // and silent

      expect(emitted).toHaveLength(2)
      expect(emitted[1].phase).toBe('gone')
    })
  })

  describe('desktop session filter', () => {
    it('skips sidecars owned by desktop in-app agents', async () => {
      desktopIds = new Set(['sess-1'])
      writeSidecar(makeSidecar())

      await makeWatcher().poll()

      expect(emitted).toHaveLength(0)
    })

    it('emits gone when a tracked session becomes desktop-owned mid-life', async () => {
      // Race window: the sidecar was external, then the desktop adopted the
      // session — a bare untrack would strand the shown card forever.
      writeSidecar(makeSidecar(), 1_000)
      const watcher = makeWatcher()
      await watcher.poll()
      expect(emitted).toHaveLength(1)

      desktopIds.add('sess-1')
      writeSidecar(
        makeSidecar({ state: { phase: 'working', updated_at: NOW_S + 1 } }),
        2_000,
      )
      await watcher.poll()

      expect(emitted).toHaveLength(2)
      expect(emitted[1]).toMatchObject({
        sessionId: 'terminal:sess-1',
        phase: 'gone',
      })
    })
  })

  describe('source gates', () => {
    it('hides ACP sessions unless the ACP gate is on (default off)', async () => {
      psCommand = '/usr/local/bin/nessy --acp'
      writeSidecar(makeSidecar())

      await makeWatcher().poll()
      expect(emitted).toHaveLength(0)

      const gated = makeWatcher({ getAcpSessionsEnabled: () => true })
      // New watcher instance ⇒ cold caches; the same file re-parses.
      touch(sidecarPath, Date.now() + 5)
      await gated.poll()

      expect(emitted).toHaveLength(1)
      expect(emitted[0].source).toBe('acp')
    })

    it('classifies by cached command: one ps per pid', async () => {
      let psCalls = 0
      writeSidecar(makeSidecar(), 1_000)
      const watcher = makeWatcher({
        readProcessCommand: async () => {
          psCalls++
          return '/usr/local/bin/nessy tui'
        },
      })
      await watcher.poll()
      writeSidecar(
        makeSidecar({ state: { phase: 'waiting_input', updated_at: NOW_S + 1 } }),
        2_000,
      )
      await watcher.poll()

      expect(psCalls).toBe(1)
      expect(emitted).toHaveLength(2)
      expect(emitted.every((u) => u.source === 'terminal')).toBe(true)
    })

    it('prefers the CLI-stamped state.source over the ps heuristic', async () => {
      let psCalls = 0
      // The command line says TUI, the sidecar says ACP — the sidecar wins,
      // and the ps seam is never consulted (cross-platform classification).
      writeSidecar(
        makeSidecar({ state: { phase: 'working', updated_at: NOW_S, source: 'acp' } }),
      )
      const watcher = makeWatcher({
        getAcpSessionsEnabled: () => true,
        readProcessCommand: async () => {
          psCalls++
          return '/usr/local/bin/nessy tui'
        },
      })

      await watcher.poll()

      expect(psCalls).toBe(0)
      expect(emitted).toHaveLength(1)
      expect(emitted[0].source).toBe('acp')
    })

    it('falls back to ps when state.source is absent (older CLI)', async () => {
      psCommand = '/usr/local/bin/nessy --acp'
      // makeSidecar's state has no source key — the pre-0.13.13 shape.
      writeSidecar(makeSidecar())

      await makeWatcher({ getAcpSessionsEnabled: () => true }).poll()

      expect(emitted).toHaveLength(1)
      expect(emitted[0].source).toBe('acp')
    })

    it('hides terminal sessions when the terminal gate is off', async () => {
      writeSidecar(makeSidecar())

      await makeWatcher({ getTerminalSessionsEnabled: () => false }).poll()

      expect(emitted).toHaveLength(0)
    })

    it('drops a shown card when the gate flips off, without a sidecar rewrite', async () => {
      // The ≤ one poll interval contract: the CLI never touches the file
      // (same fingerprint) — only the settings gate changed.
      let terminalOn = true
      const watcher = makeWatcher({
        getTerminalSessionsEnabled: () => terminalOn,
      })
      writeSidecar(makeSidecar(), 1_000)
      await watcher.poll()
      expect(emitted).toHaveLength(1)

      terminalOn = false
      await watcher.poll()

      expect(emitted).toHaveLength(2)
      expect(emitted[1]).toMatchObject({
        sessionId: 'terminal:sess-1',
        phase: 'gone',
      })
    })

    it('scans nothing when both gates are off', async () => {
      psCommand = '/usr/local/bin/nessy --acp'
      writeSidecar(makeSidecar())

      await makeWatcher({ getTerminalSessionsEnabled: () => false }).poll()

      expect(emitted).toHaveLength(0)
    })
  })

  describe('defensive parsing', () => {
    it('skips a torn read and recovers on the next poll', async () => {
      const watcher = makeWatcher()
      writeFileSync(sidecarPath, '{"schema_version": 1, "pid": 424') // mid temp+rename

      await watcher.poll()
      expect(emitted).toHaveLength(0)

      writeSidecar(makeSidecar())
      await watcher.poll()

      expect(emitted).toHaveLength(1)
      expect(emitted[0].phase).toBe('working')
    })

    it('ignores pre-MR1 sidecars without a state block', async () => {
      writeSidecar({ schema_version: 1, pid: PID, session_id: 'sess-1' })

      await makeWatcher().poll()

      expect(emitted).toHaveLength(0)
    })

    it('ignores sidecars with a different schema_version', async () => {
      writeSidecar({ ...makeSidecar(), schema_version: 2 })

      await makeWatcher().poll()

      expect(emitted).toHaveLength(0)
    })

    it('tolerates a missing projects dir (fresh install)', async () => {
      rmSync(nessyDir, { recursive: true, force: true })

      await makeWatcher().poll()

      expect(emitted).toHaveLength(0)
    })
  })

  describe('resolveNessyDir', () => {
    it('prefers NESSY_HOME and falls back to ~/.nessy', () => {
      process.env['NESSY_HOME'] = '/custom/nessy'
      expect(resolveNessyDir()).toBe('/custom/nessy')

      delete process.env['NESSY_HOME']
      expect(resolveNessyDir()).toBe(join(homedir(), '.nessy'))
    })
  })
})
