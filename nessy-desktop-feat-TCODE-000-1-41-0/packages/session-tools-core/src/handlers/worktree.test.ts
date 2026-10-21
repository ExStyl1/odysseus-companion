import { describe, expect, test } from 'bun:test'
import type { SessionToolContext, SessionWorktreePort } from '../context.ts'
import { handleEnterWorktree, handleExitWorktree, handleWorktreeBatch } from './worktree.ts'

function context(worktree?: SessionWorktreePort): SessionToolContext {
  return {
    configRoot: '/tmp/config',
    sessionId: 'session-1',
    workspacePath: '/tmp/workspace',
    sourcesPath: '/tmp/workspace/sources',
    skillsPath: '/tmp/workspace/skills',
    plansFolderPath: '/tmp/workspace/plans',
    callbacks: {} as SessionToolContext['callbacks'],
    fs: {} as SessionToolContext['fs'],
    loadSourceConfig: () => null,
    worktree,
  }
}

function port(overrides: Partial<SessionWorktreePort> = {}): SessionWorktreePort {
  return {
    enter: async input => ({
      worktreeLeaseId: 'lease-1',
      path: input.path ?? '/projects/.nessy-worktrees/app/lease-1',
      branch: 'nessy/session/lease-1',
      previousWorkingDirectory: '/projects/app',
      created: input.path === undefined,
    }),
    exit: async () => ({ path: '/projects/app', previousWorkingDirectory: '/projects/.nessy-worktrees/app/lease-1' }),
    list: async () => [],
    batch: async () => ({ started: [], deferred: [], bound: 30, summary: 'No work was started.' }),
    ...overrides,
  }
}

describe('handleEnterWorktree', () => {
  test('creates a worktree and reports the new working directory', async () => {
    const calls: unknown[] = []
    const result = await handleEnterWorktree(context(port({
      enter: async input => {
        calls.push(input)
        return {
          worktreeLeaseId: 'lease-1',
          path: '/projects/.nessy-worktrees/app/lease-1',
          branch: 'nessy/session/lease-1',
          previousWorkingDirectory: '/projects/app',
          created: true,
        }
      },
    })), { name: ' bold-oak ' })

    expect(calls).toEqual([{ name: 'bold-oak' }])
    expect(result.isError).toBe(false)
    expect(result.content[0]?.text).toContain('/projects/.nessy-worktrees/app/lease-1')
    expect(result.content[0]?.text).toContain('nessy/session/lease-1')
  })

  test('enters an existing worktree by path', async () => {
    const calls: unknown[] = []
    const result = await handleEnterWorktree(context(port({
      enter: async input => {
        calls.push(input)
        return {
          worktreeLeaseId: 'lease-2',
          path: '/projects/.nessy-worktrees/app/lease-2',
          branch: 'nessy/session/lease-2',
          previousWorkingDirectory: '/projects/app',
          created: false,
        }
      },
    })), { path: ' /projects/.nessy-worktrees/app/lease-2 ' })

    expect(calls).toEqual([{ path: '/projects/.nessy-worktrees/app/lease-2' }])
    expect(result.isError).toBe(false)
  })

  test('reports unavailability instead of guessing when there is no repository', async () => {
    const result = await handleEnterWorktree(context(), {})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('EnterWorktree')
  })

  test('surfaces a host refusal as a tool error, not a thrown turn failure', async () => {
    const result = await handleEnterWorktree(context(port({
      enter: async () => { throw new Error('worktree-collision') },
    })), {})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('worktree-collision')
  })
})

describe('handleExitWorktree', () => {
  test('moves back to the launch directory', async () => {
    const result = await handleExitWorktree(context(port()), {})
    expect(result.isError).toBe(false)
    expect(result.content[0]?.text).toContain('/projects/app')
  })

  test('is a no-op success when the session is not in a worktree', async () => {
    // ExitWorktree is `Permission required: No` and must never fail a turn for
    // being called redundantly.
    const result = await handleExitWorktree(context(port({ exit: async () => null })), {})
    expect(result.isError).toBe(false)
    expect(result.content[0]?.text).toMatch(/not in a worktree/i)
  })

  test('reports unavailability when there is no repository', async () => {
    const result = await handleExitWorktree(context(), {})
    expect(result.isError).toBe(true)
  })

  // P6.22 — the keep-or-remove offer.
  test('does not ask for removal unless the call did', async () => {
    const asked: unknown[] = []
    await handleExitWorktree(context(port({
      exit: async input => {
        asked.push(input)
        return { path: '/projects/app', previousWorkingDirectory: '/projects/.nessy-worktrees/app/lease-1' }
      },
    })), {})

    expect(asked).toEqual([{}])
  })

  test('removes the worktree and names the branch it took with it', async () => {
    const asked: unknown[] = []
    const result = await handleExitWorktree(context(port({
      exit: async input => {
        asked.push(input)
        return {
          path: '/projects/app',
          previousWorkingDirectory: '/projects/.nessy-worktrees/app/lease-1',
          removal: { removed: true, branch: 'nessy/session/lease-1' },
        }
      },
    })), { remove: true })

    expect(asked).toEqual([{ remove: true }])
    expect(result.isError).toBe(false)
    expect(result.content[0]?.text).toContain('Removed the worktree')
    expect(result.content[0]?.text).toContain('nessy/session/lease-1')
  })

  test('a refused removal is a success carrying the reason and the branch', async () => {
    // Not an error: the worktree still holding work is the normal outcome of
    // asking to remove one, and `ExitWorktree` must not fail a turn.
    const result = await handleExitWorktree(context(port({
      exit: async () => ({
        path: '/projects/app',
        previousWorkingDirectory: '/projects/.nessy-worktrees/app/lease-1',
        removal: {
          removed: false,
          branch: 'nessy/session/lease-1',
          keptReason: 'it holds commits that exist nowhere else',
        },
      }),
    })), { remove: true })

    expect(result.isError).toBe(false)
    const text = result.content[0]?.text ?? ''
    expect(text).toContain('Kept the worktree')
    expect(text).toContain('it holds commits that exist nowhere else')
    expect(text).toContain('git checkout nessy/session/lease-1')
  })
})

/**
 * P6.333 — `carryWork` on the two tools that already move the session between
 * the checkout and its worktree.
 *
 * The planner (`server-core/sessions/checkout-move-plan.ts`) owns the git
 * decision and the executor owns the I/O; these rows pin the two things the
 * HANDLERS own: the flag reaches the port only when asked for, and a refused
 * carry is REPORTED beside a move that still happened rather than thrown.
 */
describe('P6.333 · carrying uncommitted work with the chat', () => {
  test('EnterWorktree forwards carryWork and prints what the carry did', async () => {
    const calls: unknown[] = []
    const result = await handleEnterWorktree(context(port({
      enter: async input => {
        calls.push(input)
        return {
          worktreeLeaseId: 'lease-1',
          path: '/projects/.nessy-worktrees/app/lease-1',
          branch: 'nessy/session/lease-1',
          previousWorkingDirectory: '/projects/app',
          created: true,
          carry: { carried: true, summary: 'Carried the uncommitted work into the worktree.' },
        }
      },
    })), { carryWork: true })
    expect(result.isError).toBe(false)
    expect(calls).toEqual([{ carryWork: true }])
    expect(result.content[0]!.text).toContain('Carried the uncommitted work into the worktree.')
  })

  test('ExitWorktree forwards carryWork and prints what the carry did', async () => {
    const calls: unknown[] = []
    const result = await handleExitWorktree(context(port({
      exit: async input => {
        calls.push(input)
        return {
          path: '/projects/app',
          previousWorkingDirectory: '/projects/.nessy-worktrees/app/lease-1',
          carry: { carried: true, summary: 'Carried the uncommitted work back to the checkout.' },
        }
      },
    })), { carryWork: true })
    expect(result.isError).toBe(false)
    expect(calls).toEqual([{ carryWork: true }])
    expect(result.content[0]!.text).toContain('Carried the uncommitted work back to the checkout.')
  })

  // NEGATIVE 1 — a REFUSED carry is a success carrying the reason, the same
  // shape a refused removal already has: the session HAS moved, and a throw
  // would turn a completed move into a failed turn.
  test('a refused carry is reported, not thrown, and the move still stands', async () => {
    const result = await handleExitWorktree(context(port({
      exit: async () => ({
        path: '/projects/app',
        previousWorkingDirectory: '/projects/.nessy-worktrees/app/lease-1',
        carry: { carried: false, summary: '/projects/app has uncommitted changes. Commit or stash them there first.' },
      }),
    })), { carryWork: true })
    expect(result.isError).toBe(false)
    expect(result.content[0]!.text).toContain('Working directory is now /projects/app.')
    expect(result.content[0]!.text).toContain('has uncommitted changes')
  })

  // NEGATIVE 2 — not asking must reach the port as NOTHING, so a port that
  // reads the flag cannot see a `false` that looks like a decision, and the
  // result carries no carry line at all.
  test('a move that did not ask to carry sends no flag and prints no carry line', async () => {
    const calls: unknown[] = []
    const enter = await handleEnterWorktree(context(port({
      enter: async input => {
        calls.push(input)
        return {
          worktreeLeaseId: 'lease-1',
          path: '/projects/.nessy-worktrees/app/lease-1',
          branch: 'nessy/session/lease-1',
          previousWorkingDirectory: '/projects/app',
          created: true,
        }
      },
    })), {})
    expect(calls).toEqual([{}])
    expect(enter.content[0]!.text).not.toContain('Carried')

    const exitCalls: unknown[] = []
    await handleExitWorktree(context(port({
      exit: async input => {
        exitCalls.push(input)
        return { path: '/projects/app', previousWorkingDirectory: '/projects/.nessy-worktrees/app/lease-1' }
      },
    })), { carryWork: false })
    // `false` is "did not ask", exactly as `remove: false` is.
    expect(exitCalls).toEqual([{}])
  })
})

/**
 * P6.508 — the batch request entry.
 *
 * The planner owns the bound, the slugs and the deferral list; the executor
 * owns the fan-out. These rows pin what the HANDLER owns: the two refusals it
 * makes before the host is asked to create anything, and that the reply is the
 * host's own summary rather than a second rendering that could disagree.
 */
describe('P6.508 · handleWorktreeBatch', () => {
  const outcome = {
    started: [{ sessionId: 's1', name: 'one', branch: 'batch/2026-09-08/one' }],
    deferred: [{ name: 'two', reason: 'over-bound' }],
    bound: 30,
    summary: '1 agent ran…\n  batch/2026-09-08/one  (one)',
  }

  test('forwards the tasks, the prefix and a lowered bound, and replies with the host summary', async () => {
    const calls: unknown[] = []
    const result = await handleWorktreeBatch(context(port({
      batch: async input => { calls.push(input); return outcome },
    })), {
      tasks: [{ name: ' one ', prompt: ' do the thing ' }],
      branchPrefix: ' batch/2026-09-08 ',
      bound: 4,
    })
    expect(result.isError).toBe(false)
    expect(calls).toEqual([{
      tasks: [{ name: 'one', prompt: 'do the thing' }],
      branchPrefix: 'batch/2026-09-08',
      bound: 4,
    }])
    // The summary is the host's, verbatim: two renderings of one fan-out is how
    // a reply starts naming branches the plan did not create.
    expect(result.content[0]!.text).toBe(outcome.summary)
  })

  // NEGATIVE 1 — `branchPrefix` is required, not defaulted. A batch that quietly
  // wrote to `feature/<name>` would put its branches into whatever namespace the
  // repository already uses.
  test('a missing branchPrefix is refused before anything is created', async () => {
    const calls: unknown[] = []
    const result = await handleWorktreeBatch(context(port({
      batch: async input => { calls.push(input); return outcome },
    })), { tasks: [{ name: 'one', prompt: 'do the thing' }] })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('branchPrefix')
    expect(calls).toEqual([])
  })

  // NEGATIVE 2 — the port member is OPTIONAL, so a host with no session factory
  // answers "unavailable" instead of reporting a fan-out that never happened.
  test('a port without the batch member answers unavailable', async () => {
    const bare = port()
    delete (bare as { batch?: unknown }).batch
    const result = await handleWorktreeBatch(context(bare), {
      tasks: [{ name: 'one', prompt: 'do it' }], branchPrefix: 'batch/x',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('not available')
  })

  // NEGATIVE 3 — an empty or half-filled task list is refused rather than
  // fanning out into zero agents and reporting success.
  test('a task list with nothing usable in it is refused', async () => {
    const calls: unknown[] = []
    const withBatch = port({ batch: async input => { calls.push(input); return outcome } })
    for (const tasks of [[], [{ name: 'one' }], [{ prompt: 'do it' }]]) {
      const result = await handleWorktreeBatch(context(withBatch), {
        tasks: tasks as { name?: string; prompt?: string }[], branchPrefix: 'batch/x',
      })
      expect(result.isError, JSON.stringify(tasks)).toBe(true)
      expect(result.content[0]!.text).toContain('at least one task')
    }
    expect(calls).toEqual([])
  })
})

/**
 * P6.336 (b) — the permanent kind is reachable, and asking for it is the only
 * way to get it.
 */
describe('P6.336 · a permanent worktree', () => {
  test('EnterWorktree forwards permanent only when asked', async () => {
    const calls: unknown[] = []
    const forwarding = port({
      enter: async input => {
        calls.push(input)
        return {
          worktreeLeaseId: 'lease-1',
          path: '/projects/.nessy-worktrees/app/lease-1',
          branch: 'nessy/session/lease-1',
          previousWorkingDirectory: '/projects/app',
          created: true,
        }
      },
    })
    await handleEnterWorktree(context(forwarding), { permanent: true })
    await handleEnterWorktree(context(forwarding), { permanent: false })
    await handleEnterWorktree(context(forwarding), {})
    // `false` and absent both reach the port as "not asked", exactly as
    // `remove: false` does on the way out.
    expect(calls).toEqual([{ permanent: true }, {}, {}])
  })
})
