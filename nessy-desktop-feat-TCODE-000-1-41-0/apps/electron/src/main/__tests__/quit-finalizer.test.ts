/**
 * U3 — the quit must survive its own cleanup, and a failed update handoff must
 * not leave the app half-shut-down.
 *
 * Both cases come from a real shape in `before-quit`: `event.preventDefault()`
 * followed by a long cleanup chain, of which only the session flush was ever
 * guarded. A throw after it aborted the handler before any quit call, which is
 * exactly how an update ends up downloaded and never installed.
 */
import { describe, expect, it } from 'bun:test'
import { finalizeQuit, UPDATE_HANDOFF_GRACE_MS, type QuitFinalizerHost } from '../quit-finalizer'

interface Recorded {
  host: QuitFinalizerHost
  calls: string[]
  timers: Array<{ fn: () => void, ms: number }>
  unrefs: number
}

function recorder(): Recorded {
  const calls: string[] = []
  const timers: Array<{ fn: () => void, ms: number }> = []
  const state = { unrefs: 0 }
  return {
    calls,
    timers,
    get unrefs() { return state.unrefs },
    host: {
      quit: () => { calls.push('quit') },
      exit: (code: number) => { calls.push(`exit(${code})`) },
      relaunch: () => { calls.push('relaunch') },
      schedule: (fn, ms) => {
        timers.push({ fn, ms })
        return { unref: () => { state.unrefs += 1 } }
      },
      log: (message: string) => { calls.push(`log:${message.slice(0, 24)}`) },
    },
  } as Recorded
}

describe('U3 quit finalizer', () => {
  it('exits on an ordinary quit', () => {
    const r = recorder()

    expect(finalizeQuit({ isUpdating: false }, r.host)).toBe('exit')
    expect(r.calls).toContain('exit(0)')
    expect(r.calls).not.toContain('quit')
  })

  it('quits through electron-updater during an update, never force-exiting', () => {
    const r = recorder()

    expect(finalizeQuit({ isUpdating: true }, r.host)).toBe('updater-handoff')
    expect(r.calls).toContain('quit')
    // Force exit breaks the NSIS installer on Windows — the update path must
    // hand over, not exit underneath the updater.
    expect(r.calls.some(c => c.startsWith('exit('))).toBe(false)
  })

  it('still quits when cleanup threw — the defect this unit exists for', () => {
    const r = recorder()

    // Before this, a throw anywhere in the cleanup chain aborted `before-quit`
    // and the app never reached any quit call at all.
    expect(finalizeQuit({ isUpdating: false, cleanupError: new Error('dispose blew up') }, r.host))
      .toBe('exit')
    expect(r.calls).toContain('exit(0)')
  })

  it('still hands over to the updater when cleanup threw', () => {
    const r = recorder()

    expect(finalizeQuit({ isUpdating: true, cleanupError: new Error('dispose blew up') }, r.host))
      .toBe('updater-handoff')
    expect(r.calls).toContain('quit')
  })

  it('relaunches when the update handoff never completes', () => {
    const r = recorder()
    finalizeQuit({ isUpdating: true }, r.host)

    expect(r.timers).toHaveLength(1)
    expect(r.timers[0]!.ms).toBe(UPDATE_HANDOFF_GRACE_MS)

    // Firing the timer stands in for "electron-updater never took over". A
    // process that had actually handed off would be gone before this point.
    r.timers[0]!.fn()

    expect(r.calls).toContain('relaunch')
    expect(r.calls.indexOf('relaunch')).toBeLessThan(r.calls.indexOf('exit(0)'))
  })

  it('arms no fallback on an ordinary quit, and never holds the loop open', () => {
    const ordinary = recorder()
    finalizeQuit({ isUpdating: false }, ordinary.host)
    expect(ordinary.timers).toHaveLength(0)

    const updating = recorder()
    finalizeQuit({ isUpdating: true }, updating.host)
    // The fallback must not be the reason the process stays alive.
    expect(updating.unrefs).toBe(1)
  })
})
