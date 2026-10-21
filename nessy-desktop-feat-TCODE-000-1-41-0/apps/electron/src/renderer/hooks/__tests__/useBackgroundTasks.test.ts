/**
 * L9 — THE KILL BUTTON STOPS LYING.
 *
 * What this file pins is a defect rather than a feature. `useBackgroundTasks`
 * used to run, for BOTH kinds of task, a branch commented *"Always remove from UI
 * after kill attempt"* — and for an agent task the "attempt" was
 * `console.warn('Killing agent tasks not yet implemented')`, i.e. nothing at all.
 * The user pressed stop, the row disappeared, and the task kept running.
 *
 * The repo has no renderHook/DOM lib, so the load-bearing decision is exported
 * pure (`requestTaskStop`) and tested directly — the established pattern for
 * renderer hooks (`usePluginEnablement`). The wiring the pure function cannot see
 * — that the row is dropped ONLY inside the success branch, and that the console
 * warning is gone — is pinned against the hook's own source, the pattern
 * `useMarketplaceInstall.test.ts` uses for the same class of claim.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { StopAgentTaskFailureReason } from '@nessy-agent/shared/protocol'
import { requestTaskStop, type StopTaskRoutes } from '../useBackgroundTasks.ts'

const hookSource = readFileSync(new URL('../useBackgroundTasks.ts', import.meta.url), 'utf8')

/**
 * The hook's source WITHOUT its comments.
 *
 * The three absence guards below name the exact strings the defect was made of,
 * and the fix's own doc comment QUOTES those strings to record what it replaced —
 * so asserting against the raw file makes the documentation defeat the guard.
 * Measured, not anticipated: two of these tests failed on the first run for that
 * reason and for no other. Stripping comments keeps both, and an absence claim
 * about code is what was meant in the first place.
 */
const hookCode = hookSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

function routes(overrides: Partial<StopTaskRoutes> = {}): StopTaskRoutes & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    killShell: async id => { calls.push(`killShell:${id}`); return { success: true } },
    stopAgentTask: async id => { calls.push(`stopAgentTask:${id}`); return { success: true } },
    ...overrides,
  }
}

describe('requestTaskStop — route selection', () => {
  it('an agent task goes to stopAgentTask, which before this row did not exist', async () => {
    const r = routes()
    expect(await requestTaskStop('task_7', 'agent', r)).toEqual({ removeRow: true })
    expect(r.calls).toEqual(['stopAgentTask:task_7'])
  })

  it('a shell task still goes to killShell', async () => {
    const r = routes()
    expect(await requestTaskStop('shell_3', 'shell', r)).toEqual({ removeRow: true })
    expect(r.calls).toEqual(['killShell:shell_3'])
  })
})

describe('requestTaskStop — the row survives anything that is not a confirmed stop', () => {
  it('a refused agent stop keeps the row', async () => {
    const r = routes({
      stopAgentTask: async () => ({ success: false, reason: 'unsupported' as const }),
    })
    expect(await requestTaskStop('task_7', 'agent', r)).toEqual({
      removeRow: false,
      failureKey: 'toast.stopTaskUnsupported',
    })
  })

  it('a refused shell kill keeps the row — it used to be swallowed as "may already be gone"', async () => {
    const r = routes({
      killShell: async () => ({ success: false, error: 'Unknown supervised process handle' }),
    })
    expect(await requestTaskStop('shell_3', 'shell', r)).toEqual({
      removeRow: false,
      failureKey: 'toast.stopTaskGone',
    })
  })

  it('a THROWN route is a failure, not an "already gone"', async () => {
    const r = routes({ killShell: async () => { throw new Error('transport disconnected') } })
    expect(await requestTaskStop('shell_3', 'shell', r)).toEqual({
      removeRow: false,
      failureKey: 'toast.stopTaskFailed',
      failureDetail: 'transport disconnected',
    })
  })

  it('a failure with no reason still keeps the row', async () => {
    const r = routes({ stopAgentTask: async () => ({ success: false }) })
    const outcome = await requestTaskStop('task_7', 'agent', r)
    expect(outcome.removeRow).toBe(false)
    expect(outcome.failureKey).toBe('toast.stopTaskFailed')
  })
})

/**
 * L9 review finding 3 — RAW BACKEND ENGLISH IN A USER-FACING TOAST.
 *
 * The first version put the host's own string in the toast body: a user pressing
 * stop on a stale row read `unknown-task-id:bg-9`, and a Russian user read it too,
 * because there was no key to translate. Every failure path must now resolve to an
 * i18n key, and the two tokens that were actually observed must never be the
 * message.
 */
describe('requestTaskStop — every refusal resolves to a translatable key', () => {
  const cases: Array<[StopAgentTaskFailureReason, string]> = [
    ['session-not-found', 'toast.stopTaskSessionMissing'],
    ['unknown-task', 'toast.stopTaskGone'],
    ['unreachable-mcp', 'toast.stopTaskMcpUnreachable'],
    ['unreachable-workflow', 'toast.stopTaskWorkflowUnreachable'],
    ['unsupported', 'toast.stopTaskUnsupported'],
    ['failed', 'toast.stopTaskFailed'],
  ]

  for (const [reason, key] of cases) {
    it(`reason "${reason}" reads as ${key}`, async () => {
      const r = routes({ stopAgentTask: async () => ({ success: false, reason }) })
      const outcome = await requestTaskStop('task_7', 'agent', r)
      expect(outcome.failureKey).toBe(key)
    })
  }

  it('the internal token never becomes the message — only the detail under it', async () => {
    const r = routes({
      stopAgentTask: async () => ({ success: false, reason: 'unknown-task' as const, error: 'unknown-task-id:bg-9' }),
    })
    const outcome = await requestTaskStop('bg-9', 'agent', r)
    expect(outcome.failureKey).toBe('toast.stopTaskGone')
    expect(outcome.failureDetail).toBeUndefined()
  })

  it('every key this maps to exists in EVERY locale', () => {
    const localeDir = new URL('../../../../../../packages/shared/src/i18n/locales/', import.meta.url)
    const keys = [...new Set([
      'toast.stopTaskFailed',
      ...cases.map(([, key]) => key),
    ])]
    for (const locale of ['en.json', 'ru.json']) {
      const messages = JSON.parse(readFileSync(new URL(locale, localeDir), 'utf8')) as Record<string, string>
      for (const key of keys) {
        expect(typeof messages[key], `${locale} is missing ${key}`).toBe('string')
        expect(messages[key]!.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('the hook wiring around that decision', () => {
  it('drops the row only inside the success branch, and no longer unconditionally', () => {
    const decision = hookCode.indexOf('if (!outcome.removeRow) {')
    const removal = hookCode.indexOf('setTasks(prev => prev.filter(t => t.id !== taskId))')
    expect(decision).toBeGreaterThan(0)
    expect(removal).toBeGreaterThan(decision)
    // The removal is gated by an early `return false`, so no `id`-keyed filter may
    // sit before the decision either.
    expect(hookCode.slice(0, decision)).not.toContain('t.id !== taskId')
  })

  it('no longer pretends an agent task cannot be stopped', () => {
    expect(hookCode).not.toContain('Killing agent tasks not yet implemented')
    expect(hookCode).toContain('window.electronAPI.stopAgentTask(sessionId, id)')
  })

  it('puts the failure in front of the user rather than in a console', () => {
    // "The failure" is the SENTENCE. The backend detail underneath it goes the
    // other way — see the next block.
    expect(hookCode).toContain('toast.error(')
    expect(hookCode).not.toContain('console.warn')
  })
})

/**
 * NO UNTRANSLATED BACKEND ENGLISH REACHES THE USER — the second half of the
 * two-contract disagreement.
 *
 * `dto.ts` says `StopAgentTaskResult.error` is "Backend detail for logs and bug
 * reports — never the whole user-facing text"; `ClaudeAgent.stopBackgroundTask`
 * said "The `error` is prose meant for the user" and returned three English
 * sentences. Whichever comment you believed, the string ended up in the toast's
 * `description`, so a Russian user read a translated headline over an English
 * body. Every value that can arrive in `failureDetail` is backend English — a
 * thrown route's `error.message`, unrecognised `killShell` prose, or arm 1's
 * `error` — so the resolution is that the detail is LOGGED and only the key is
 * rendered.
 */
describe('the toast carries a key and nothing else', () => {
  it('does not pass the backend detail as the toast description', () => {
    // Sliced rather than asserted against the whole file, so a failure prints the
    // call and not 200 lines of hook.
    const call = hookCode.slice(hookCode.indexOf('toast.error('), hookCode.indexOf('toast.error(') + 160)
    expect(call).toContain("t(outcome.failureKey ?? 'toast.stopTaskFailed')")
    expect(call).not.toContain('description')
    expect(call).not.toContain('failureDetail')
  })

  it('the detail is not discarded — it goes to the log', () => {
    expect(hookCode).toContain('console.error(')
    expect(hookCode).toContain('outcome.failureDetail')
    // Logged BEFORE the toast, so a thrown render cannot lose the diagnostic.
    expect(hookCode.indexOf('console.error(')).toBeLessThan(hookCode.indexOf('toast.error('))
  })

  it('the pure decision still reports the detail, so the log has something to say', async () => {
    const r = routes({ killShell: async () => { throw new Error('transport disconnected') } })
    const outcome = await requestTaskStop('shell_3', 'shell', r)
    expect(outcome.failureDetail).toBe('transport disconnected')
    expect(outcome.failureKey).toBe('toast.stopTaskFailed')
  })
})
