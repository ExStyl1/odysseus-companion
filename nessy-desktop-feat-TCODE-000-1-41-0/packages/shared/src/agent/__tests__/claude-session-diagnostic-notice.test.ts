/**
 * C3.336 — the CLAUDE arm of the per-session diagnostic disclosure.
 *
 * C3.302 gave Pi a chat line naming its diagnostic file and recorded, at both
 * ends, that the claude arm still reached the host log only. That divergence was
 * created by a row rather than found in the wild, and it is the shape AGENTS.md
 * §Traps names as the largest defect class here: two runtimes, one product, one
 * of them silently quieter.
 *
 * Two halves, and they fail in different ways, so they are pinned separately:
 *
 *  - the READ-BACK is driven through the REAL `buildClaudeSubprocessEnv`, in all
 *    three arms the writer can take, so the reader cannot drift away from the
 *    writer without something going red here;
 *  - the WIRING is asserted from the source text of the call site, because the
 *    alternative is a real claude subprocess with a model, a workspace and a
 *    network posture behind it to answer "is the value yielded" (the same
 *    judgement `pi-session-diagnostic-log.test.ts` records for the Pi half, and
 *    the render-test measurement in AGENTS.md §Traps).
 *
 * A predicate that returned a path for everything would satisfy the positive arm
 * while telling an ordinary user that their session writes a plaintext log, so
 * the negative arm is the one that matters and it is written first.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildClaudeSubprocessEnv, claudeSessionDiagnosticPath } from '../options.ts'
import {
  CLAUDE_DEBUG_ENABLE_ENV,
  CLAUDE_DEBUG_LOG_PATH_ENV,
  sessionRuntimeDebugLogDir,
} from '../session-debug-log.ts'

const HERE = new URL('.', import.meta.url).pathname
const agentDir = join(HERE, '..')

/**
 * `delete` before assigning, and delete again to restore: the Bun 1.3.14 env-slot
 * trap (AGENTS.md §Traps) makes an INTRODUCED name invisible to the spread that
 * builds the child's environment, which is exactly the spread under test.
 */
function withHostEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name])
    delete process.env[name]
    if (value !== undefined) process.env[name] = value
  }
  try {
    return run()
  } finally {
    for (const [name, value] of previous) {
      delete process.env[name]
      if (value !== undefined) process.env[name] = value
    }
  }
}

afterEach(() => {
  // Nothing to tear down beyond `withHostEnv`'s own restore; the diagnostic
  // directory is the isolated config dir the test preload gives this process.
})

describe('C3.336 — which diagnostic file a claude session admits to writing', () => {
  it('NEGATIVE: an ordinary session names nothing, because it writes nothing', () => {
    const env = withHostEnv(
      { NESSY_DEBUG: '0', [CLAUDE_DEBUG_ENABLE_ENV]: undefined, [CLAUDE_DEBUG_LOG_PATH_ENV]: undefined },
      () => buildClaudeSubprocessEnv({ NESSY_SESSION_ID: 'sess-c3336-ordinary' }),
    )
    // The writer's own early return, read back: no enable switch, no path, and
    // therefore no sentence to a user who never asked to debug anything.
    expect(env[CLAUDE_DEBUG_ENABLE_ENV]).toBeUndefined()
    expect(claudeSessionDiagnosticPath(env)).toBeUndefined()
  })

  it('POSITIVE: in host debug mode the session names the file the writer chose', () => {
    const env = withHostEnv(
      { NESSY_DEBUG: '1', [CLAUDE_DEBUG_ENABLE_ENV]: undefined, [CLAUDE_DEBUG_LOG_PATH_ENV]: undefined },
      () => buildClaudeSubprocessEnv({ NESSY_SESSION_ID: 'sess-c3336-debug' }),
    )
    const path = claudeSessionDiagnosticPath(env)
    expect(path).toBeTruthy()
    // The READ-BACK property: the reader answers the writer's own post-state,
    // never a second derivation of it.
    expect(path).toBe(env[CLAUDE_DEBUG_LOG_PATH_ENV])
    expect(env[CLAUDE_DEBUG_ENABLE_ENV]).toBe('1')
    // And it is the host-owned directory M17 asks for, not somewhere else.
    expect(path!.startsWith(sessionRuntimeDebugLogDir())).toBe(true)
    expect(path).toContain('sess-c3336-debug')
  })

  it("POSITIVE: an operator's own path is left alone AND is the path the user is told", () => {
    const operatorPath = '/tmp/nessy-c3336-operator-choice'
    const env = withHostEnv(
      { NESSY_DEBUG: '1', [CLAUDE_DEBUG_ENABLE_ENV]: undefined, [CLAUDE_DEBUG_LOG_PATH_ENV]: operatorPath },
      () => buildClaudeSubprocessEnv({ NESSY_SESSION_ID: 'sess-c3336-operator' }),
    )
    expect(env[CLAUDE_DEBUG_LOG_PATH_ENV]).toBe(operatorPath)
    // The half that would be wrong if the reader re-derived the host path: the
    // user must be pointed at the file the BINARY will use.
    expect(claudeSessionDiagnosticPath(env)).toBe(operatorPath)
  })

  it('NEGATIVE: an operator debugging the SDK outside host debug mode is not spoken for', () => {
    // Deliberately silent, and the safe direction: the copy opens with "Debug
    // mode is on", meaning the HOST's mode, so a notice here would be false in
    // its first clause. Stated in the reader's own docblock.
    const env = withHostEnv(
      { NESSY_DEBUG: '0', [CLAUDE_DEBUG_ENABLE_ENV]: '1', [CLAUDE_DEBUG_LOG_PATH_ENV]: '/tmp/nessy-c3336-theirs' },
      () => buildClaudeSubprocessEnv({ NESSY_SESSION_ID: 'sess-c3336-theirs' }),
    )
    expect(claudeSessionDiagnosticPath(env)).toBeUndefined()
  })

  it('NEGATIVE: a blank path is not a path', () => {
    expect(claudeSessionDiagnosticPath({
      NESSY_DEBUG: '1',
      [CLAUDE_DEBUG_ENABLE_ENV]: '1',
      [CLAUDE_DEBUG_LOG_PATH_ENV]: '   ',
    })).toBeUndefined()
  })
})

describe('C3.336 — the wiring, which a unit test of the reader alone cannot see', () => {
  const claude = readFileSync(join(agentDir, 'claude-agent.ts'), 'utf8')
  const base = readFileSync(join(agentDir, 'base-agent.ts'), 'utf8')
  const options = readFileSync(join(agentDir, 'options.ts'), 'utf8')

  it('the source really was read (the control for every assertion below)', () => {
    expect(claude).toContain('R12 — announce those degradations where the user can see them')
    expect(base).toContain('protected noteSessionNoticeOnce(')
    expect(options).toContain('export function claudeSessionDiagnosticPath(')
  })

  it('the claude option builder reads the path and YIELDS the notice', () => {
    expect(claude).toContain('claudeSessionDiagnosticPath(options.env ?? {})')
    expect(claude).toContain("'chat.runtimeDiagnostic.path',")
    expect(claude).toContain('if (notice) yield notice')
  })

  it('NEGATIVE: the claude arm does not QUEUE it — the queue drains before this point', () => {
    // `drainPendingSessionNotices` runs at the top of `chat()`; this builder is
    // inside `chatImpl`. A queued line would hold a fact about THIS run until
    // the user sent a second message, which is the defect in a quieter shape.
    expect(claude).not.toContain("noteSessionNoticeOnce('chat.runtimeDiagnostic.path'")
  })

  it('NEGATIVE: still ONE notice queue and ONE dedupe set, not a second pair', () => {
    // The property C3.302 bought by extracting the helper, and the reason this
    // row split it rather than writing a second one: a respawn inside one
    // session must stay one sentence about a path that never changed.
    expect(base.match(/pendingSessionNotices\.push\(/g)?.length).toBe(1)
    expect(base.match(/private readonly sessionNoticeKeysSent/g)?.length).toBe(1)
    expect(base.match(/this\.sessionNoticeKeysSent\.add\(/g)?.length).toBe(1)
    expect(base).toContain('const notice = this.takeSessionNoticeOnce(key, values, level)')
  })

  it('the falsifying edit site carries the back-pointer, and the closed divergence says so', () => {
    // P6.551: an assertion about another module has no guard, so the note lives
    // where the edit that would falsify it happens.
    expect(options).toContain('C3.336')
    expect(options).toContain('chat.runtimeDiagnostic.path')
    // The paragraph that asked for this row is spent: it named its own deletion
    // condition, and the condition is met.
    expect(options).not.toContain('Whoever adds the return value should delete this paragraph')
  })

  it('the runtime-neutral key is in BOTH locales and still carries its interpolation', () => {
    const locales = join(agentDir, '..', 'i18n', 'locales')
    for (const name of ['en.json', 'ru.json']) {
      const table = JSON.parse(readFileSync(join(locales, name), 'utf8')) as Record<string, string>
      const copy = table['chat.runtimeDiagnostic.path']
      expect(copy, `${name} is missing chat.runtimeDiagnostic.path`).toBeTruthy()
      // One key, two runtimes: the sentence takes the path as a value precisely
      // so the claude arm is one call and not a second sentence.
      expect(copy).toContain('{{path}}')
    }
  })
})
