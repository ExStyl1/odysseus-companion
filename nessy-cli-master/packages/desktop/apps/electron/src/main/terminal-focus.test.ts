import { describe, expect, it } from 'bun:test'
import { focusTerminalSession, resolveTty, type RunCommand } from './terminal-focus'

interface Call {
  cmd: string
  args: string[]
}

type Responder = (call: Call) => { stdout: string }
type Step = Responder | { stdout: string }

/**
 * Scripted `run` seam: records every spawn, answers them in order. A step is
 * either a canned `{ stdout }` or an asserting responder. A missing step
 * rejects — any unexpected OS interaction fails the test loudly.
 */
function scriptedRun(steps: Step[]) {
  const calls: Call[] = []
  let next = 0
  const run: RunCommand = async (cmd, args) => {
    const call = { cmd, args }
    calls.push(call)
    const step = steps[next]
    next++
    if (!step) {
      throw new Error(`unexpected spawn #${next}: ${cmd} ${args.join(' ')}`)
    }
    return typeof step === 'function' ? step(call) : step
  }
  return { run, calls }
}

const lsOfOutput = (tty: string | null) =>
  `p4242\nf4\nn${tty ?? '/Users/dev/work/repo'}\nf18\nntcp\n`

describe('resolveTty', () => {
  it('extracts the first controlling /dev/ttys* from lsof -Fn output', async () => {
    const { run } = scriptedRun([
      { stdout: lsOfOutput('/dev/ttys003') },
    ])

    expect(await resolveTty(4242, run)).toBe('/dev/ttys003')
  })

  it('returns null when the process owns no tty', async () => {
    const { run } = scriptedRun([{ stdout: 'p4242\nf4\nntcp\n' }])

    expect(await resolveTty(4242, run)).toBeNull()
  })

  it('spawns lsof exactly once with -p <pid> -Fn', async () => {
    const { run, calls } = scriptedRun([{ stdout: lsOfOutput('/dev/ttys009') }])

    await resolveTty(99, run)

    expect(calls).toEqual([{ cmd: 'lsof', args: ['-p', '99', '-Fn'] }])
  })
})

describe('focusTerminalSession', () => {
  const realPlatform = process.platform

  const isRunningReply = (app: string, running: boolean): Responder => (call) => {
    expect(call.args.join(' ')).toContain(`application "${app}" is running`)
    return { stdout: running ? 'true' : 'false' }
  }

  it('focuses iTerm2 by tty and stops there on success', async () => {
    const { run, calls } = scriptedRun([
      isRunningReply('iTerm', true),
      (call) => {
        expect(call.cmd).toBe('osascript')
        expect(call.args.join(' ')).toContain('tell application "iTerm"')
        expect(call.args.join(' ')).toContain('tty of s is "/dev/ttys003"')
        return { stdout: 'true' }
      },
    ])

    const focused = await focusTerminalSession({ pid: 4242 }, async (cmd, args) => {
      if (cmd === 'lsof') return { stdout: lsOfOutput('/dev/ttys003') }
      return run(cmd, args)
    })

    expect(focused).toBe(true)
    expect(calls).toHaveLength(2) // no Terminal.app probe after iTerm2 hit
  })

  it('falls through to Terminal.app when iTerm2 misses the tty', async () => {
    const { run, calls } = scriptedRun([
      isRunningReply('iTerm', true),
      () => ({ stdout: 'false' }), // iTerm2: no matching session
      isRunningReply('Terminal', true),
      (call) => {
        expect(call.args.join(' ')).toContain('tell application "Terminal"')
        expect(call.args.join(' ')).toContain('tty of t is "/dev/ttys003"')
        expect(call.args.join(' ')).toContain('set selected tab of w to t')
        return { stdout: 'true' }
      },
    ])

    const focused = await focusTerminalSession({ pid: 4242 }, async (cmd, args) => {
      if (cmd === 'lsof') return { stdout: lsOfOutput('/dev/ttys003') }
      return run(cmd, args)
    })

    expect(focused).toBe(true)
    expect(calls).toHaveLength(4)
  })

  it('skips a not-running iTerm2 without spawning its search script', async () => {
    const { run, calls } = scriptedRun([
      isRunningReply('iTerm', false),
      isRunningReply('Terminal', true),
      () => ({ stdout: 'true' }),
    ])

    await focusTerminalSession({ pid: 1 }, async (cmd, args) => {
      if (cmd === 'lsof') return { stdout: lsOfOutput('/dev/ttys001') }
      return run(cmd, args)
    })

    expect(calls).toHaveLength(3)
    expect(calls[0]?.args.join(' ')).toContain('"iTerm"')
  })

  it('falls back to a title match over frontmost apps when both terminals miss', async () => {
    const { run, calls } = scriptedRun([
      isRunningReply('iTerm', false),
      isRunningReply('Terminal', true),
      () => ({ stdout: 'false' }), // Terminal.app: no matching tab
      (call) => {
        expect(call.args.join(' ')).toContain('name of every process whose background only is false')
        expect(call.args.join(' ')).toContain('name of w contains "my-repo"')
        return { stdout: 'true' }
      },
    ])

    const focused = await focusTerminalSession(
      { pid: 1, workDir: '/Users/dev/work/my-repo' },
      async (cmd, args) => {
        if (cmd === 'lsof') return { stdout: lsOfOutput('/dev/ttys002') }
        return run(cmd, args)
      },
    )

    expect(focused).toBe(true)
    expect(calls).toHaveLength(4)
  })

  it('escapes quotes and backslashes in the title fallback', async () => {
    const { run, calls } = scriptedRun([
      (call) => {
        expect(call.args.join(' ')).toContain('name of w contains "pro\\"j\\\\ect"')
        return { stdout: 'true' }
      },
    ])

    await focusTerminalSession({ workDir: '/tmp/pro"j\\ect' }, run)

    expect(calls).toHaveLength(1)
  })

  it('uses the title fallback when no pid is given', async () => {
    const { run } = scriptedRun([
      (call) => {
        expect(call.args.join(' ')).toContain('my-repo')
        return { stdout: 'true' }
      },
    ])

    expect(await focusTerminalSession({ workDir: '/x/my-repo' }, run)).toBe(true)
  })

  it('recovers from a tty probe failure via the title fallback', async () => {
    const { run, calls } = scriptedRun([
      () => ({ stdout: 'true' }),
    ])

    const focused = await focusTerminalSession(
      { pid: 7, workDir: '/x/my-repo' },
      async (cmd, args) => {
        if (cmd === 'lsof') throw new Error('process gone')
        return run(cmd, args)
      },
    )

    expect(focused).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args.join(' ')).toContain('my-repo')
  })

  it('reports failure when nothing matches and no workDir is available', async () => {
    const { run, calls } = scriptedRun([
      isRunningReply('iTerm', false),
      isRunningReply('Terminal', false),
    ])

    const focused = await focusTerminalSession({ pid: 7 }, async (cmd, args) => {
      if (cmd === 'lsof') return { stdout: lsOfOutput('/dev/ttys005') }
      return run(cmd, args)
    })

    expect(focused).toBe(false)
    expect(calls).toHaveLength(2)
  })

  it('is a no-op without any spawn on non-darwin platforms', async () => {
    const calls: Call[] = []
    const run: RunCommand = async (cmd, args) => {
      calls.push({ cmd, args })
      return { stdout: 'true' }
    }
    const saved = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })

    try {
      expect(await focusTerminalSession({ pid: 1, workDir: '/x' }, run)).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { value: saved, configurable: true })
    }

    expect(calls).toHaveLength(0)
  })
})
