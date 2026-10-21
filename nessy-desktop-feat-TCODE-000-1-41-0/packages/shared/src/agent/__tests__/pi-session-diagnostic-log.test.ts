/**
 * C3.274 — the PI arm of the host-owned per-session diagnostic file.
 *
 * M17 asks for a readable plaintext log when a runtime fails, per session, in a
 * directory the product owns. C3.215 built that for claude and left
 * `sessionRuntimeDebugLogPath('pi', …)` accepting a runtime name **no caller
 * ever passed** — so the function existed, the naming rule existed, and a Pi
 * session still had no file. That is the defect this suite pins, and it is the
 * kind a unit test of the helper alone cannot see: a perfectly green sink with
 * nothing calling it is exactly the state C3.274 was born from. Hence the last
 * describe, which asserts the WIRING at the Pi spawn site from the source text.
 *
 * Reading the source rather than driving a subprocess is deliberate. Spawning a
 * real Pi child needs a model, a workspace and a network posture; the question
 * here is only "does the sink reach the stderr pipe, keyed by this session, and
 * only in debug mode", and the spawn site is 20 lines of straight-line code
 * whose text answers it without a 100-second module graph (AGENTS.md §Traps, the
 * render-test measurement).
 *
 * The two choices pinned on the behaviour half are the ones a later edit would
 * flip without noticing:
 *
 * - the file exists ONLY while the host is in debug mode (a plaintext runtime
 *   log can carry prompt text, so it follows the switch a user already turns on
 *   to produce a report — the claude arm's posture, unchanged);
 * - a sink that cannot be opened, or that fails later, is SILENT: a diagnostic
 *   nobody asked to be load-bearing must never become the session's problem.
 */
import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  openSessionRuntimeDebugLog,
  sessionRuntimeDebugLogDir,
  sessionRuntimeDebugLogHeader,
  sessionRuntimeDebugLogPath,
} from '../session-debug-log.ts'

/**
 * Wait for the append stream's bytes to REACH the file — bounded, and read by
 * the bytes themselves rather than by a clock.
 *
 * The first draft slept 50 ms and then read the file: a TIMER raced against the
 * runner's filesystem. Measured 2026-09-20 on CI (pipeline 126389358, the same
 * bytes green on the three pipelines before it): the double-close case read
 * ENOENT — the stream had not even OPENED its file inside 50 ms — while its
 * POSITIVE sibling passed at 55 ms, one yield from the same red. That is the
 * timer lottery AGENTS.md §Traps describes as the third outcome of a timeout
 * with zero assertion failures, met here as a fixed sleep instead of a budget.
 * So the instrument is the content: poll until the needle is in the file, and
 * fail LOUDLY with the last read after a budget sized for a CI runner, never
 * zero. The sink exposes no stream on purpose (a diagnostic must not become a
 * handle the session waits on), which is why the test reads the file and not
 * a `finish` event.
 */
async function writtenOnce(path: string, needle: string, budgetMs = 10_000): Promise<string> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    let text = ''
    try {
      text = await readFile(path, 'utf-8')
    } catch {
      // Not opened yet — `createWriteStream` opens asynchronously.
    }
    if (text.includes(needle)) return text
    if (Date.now() > deadline) {
      throw new Error(`${path} did not contain ${JSON.stringify(needle)} within ${budgetMs} ms; last read: ${JSON.stringify(text)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * The one wait that has NO bytes to poll for: the negative arm opens no stream,
 * so a short yield is all that separates "nothing was created" from "not yet".
 */
async function settled(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}

describe('C3.274 — a Pi session writes a diagnostic only when the host is in debug mode', () => {
  it('POSITIVE: debug mode opens the file the naming rule names, and the bytes land in it', async () => {
    const sessionId = 'sess-c3274-positive'
    const sink = openSessionRuntimeDebugLog('pi', sessionId, true)
    expect(sink).toBeDefined()
    // The same naming rule the claude arm uses, with `pi` as the runtime — the
    // whole point of M17's "one directory you can point a user at".
    expect(sink!.path).toBe(sessionRuntimeDebugLogPath('pi', sessionId))
    expect(sink!.path.startsWith(sessionRuntimeDebugLogDir())).toBe(true)
    // The directory is created before the path is named, for the reason
    // `ensureSessionRuntimeDebugLog` gives: naming a path nothing can write to
    // turns a promise into a confusing failure.
    expect(existsSync(sessionRuntimeDebugLogDir())).toBe(true)

    sink!.write('pi: connecting to the gateway\n')
    sink!.write('pi: model resolved\n')
    sink!.close()

    const written = await writtenOnce(sink!.path, 'pi: model resolved')
    expect(written).toContain('pi: connecting to the gateway')
    expect(written).toContain('pi: model resolved')
  })

  it('NEGATIVE: an ordinary session opens nothing, and writes no file', async () => {
    // The privacy half. A session nobody asked to debug must leave no plaintext
    // runtime log behind — this is the arm that would go silently wrong if a
    // later edit hoisted the sink above the debug check.
    const sessionId = 'sess-c3274-not-debugging'
    expect(openSessionRuntimeDebugLog('pi', sessionId, false)).toBeUndefined()
    await settled()
    expect(existsSync(sessionRuntimeDebugLogPath('pi', sessionId))).toBe(false)
  })

  it('NEGATIVE: no session identity, no file — there is nothing to key it by', () => {
    expect(openSessionRuntimeDebugLog('pi', undefined, true)).toBeUndefined()
    expect(openSessionRuntimeDebugLog('pi', '', true)).toBeUndefined()
  })

  it('close() is idempotent and a write after it is a no-op, because two child events can both fire', async () => {
    // `exit` and `error` both close this sink, and a subprocess can emit both.
    // A sink that threw on the second one would turn a diagnostic into a fault.
    const sink = openSessionRuntimeDebugLog('pi', 'sess-c3274-double-close', true)
    expect(sink).toBeDefined()
    sink!.write('first\n')
    sink!.close()
    expect(() => sink!.close()).not.toThrow()
    expect(() => sink!.write('after close\n')).not.toThrow()
    const written = await writtenOnce(sink!.path, 'first')
    // Structural, not timed: `close()` drops the stream before the write, so
    // there is no later moment at which these bytes could still arrive.
    expect(written).toContain('first')
    expect(written).not.toContain('after close')
  })

  it('two runs of one session append to ONE file, separated by the run header', async () => {
    // Pi RESPAWNS its subprocess inside a session. Without the header the second
    // run's first line reads as a continuation of the first run's last one.
    const sessionId = 'sess-c3274-respawn'
    const first = openSessionRuntimeDebugLog('pi', sessionId, true)!
    first.write(sessionRuntimeDebugLogHeader('pi', sessionId, new Date('2026-09-12T10:00:00.000Z')))
    first.write('run one\n')
    first.close()
    await writtenOnce(first.path, 'run one')

    const second = openSessionRuntimeDebugLog('pi', sessionId, true)!
    expect(second.path).toBe(first.path)
    second.write(sessionRuntimeDebugLogHeader('pi', sessionId, new Date('2026-09-12T10:05:00.000Z')))
    second.write('run two\n')
    second.close()

    // One stream writes in order, so a read that holds 'run two' holds the
    // header written before it as well.
    const written = await writtenOnce(first.path, 'run two')
    expect(written).toContain('run one')
    expect(written).toContain('run two')
    expect(written).toContain('2026-09-12T10:00:00.000Z')
    expect(written).toContain('2026-09-12T10:05:00.000Z')
    expect(written.indexOf('run one')).toBeLessThan(written.indexOf('run two'))
  })

  it('the header names the runtime and the session, so one directory stays readable', () => {
    const header = sessionRuntimeDebugLogHeader('pi', 'sess-x', new Date('2026-09-12T00:00:00.000Z'))
    expect(header).toContain('pi')
    expect(header).toContain('sess-x')
    expect(header).toContain('2026-09-12T00:00:00.000Z')
    // The claude arm shares the function, so the directory cannot grow two
    // separator shapes.
    expect(sessionRuntimeDebugLogHeader('claude', 'sess-x')).toContain('claude')
  })
})

describe('C3.274 — the sink is actually WIRED at the Pi spawn site', () => {
  // The refuted state this row closed was "the function exists and nothing calls
  // it", which every test above would have passed. These read the one call site.
  const source = readFileSync(join(import.meta.dir, '..', 'pi-agent.ts'), 'utf-8')

  it('POSITIVE: the spawn site opens a `pi` sink keyed by the session, gated on the host debug switch', () => {
    expect(source).toContain("openSessionRuntimeDebugLog('pi', sessionId, hostDebug)")
    // One resolution of the switch, used for BOTH the child's `NESSY_DEBUG` and
    // the file — the two must never disagree about whether this is a debug run.
    expect(source).toContain(
      "const hostDebug = process.argv.includes('--debug') || process.env.NESSY_DEBUG === '1'",
    )
    expect(source).toContain('debug: hostDebug,')
  })

  it('POSITIVE: the stderr pipe feeds it, and both of the child\'s end events close it', () => {
    expect(source).toContain('diagnosticLog?.write(text)')
    // Two closers, because `exit` and `error` are different events and a child
    // that errors without exiting would otherwise leak an open stream per run.
    expect(source.match(/diagnosticLog\?\.close\(\)/g)?.length).toBe(2)
  })

  it('NEGATIVE: nothing holds the sink on the instance, so a stale child cannot close a live run\'s file', () => {
    // Pi respawns within one session; a `this.diagnosticLog` field would let the
    // previous child's `exit` close the current child's file. The sink is a
    // local captured by this child's own listeners, and this is the assertion
    // that keeps it that way.
    expect(source).not.toContain('this.diagnosticLog')
    expect(source).toContain('const diagnosticLog = openSessionRuntimeDebugLog(')
  })
})

/**
 * C3.302 — and the user is told, not only the host log.
 *
 * The state this row closed is the one C3.274 left: the file exists, its path is
 * announced, and the announcement goes to `this.debug(...)` — the channel a
 * developer tails, while the person who turned debug mode on did so to produce a
 * report. Source read, for the reason the describe above gives and one more: the
 * emitter is a `protected` method on `BaseAgent`, whose constructor is the whole
 * backend graph, so driving it would cost minutes of module-graph I/O to assert
 * a `Set.has` (the measured trade `shortcuts-surfaces.test.ts` and
 * `SessionStatusIcon.test.tsx` both record). What a source read CAN see here is
 * exactly what went wrong before: a correct mechanism nothing calls, and a
 * second copy of a queue that already existed.
 */
describe('C3.302 — the diagnostic path reaches the user, once per session', () => {
  const pi = readFileSync(join(import.meta.dir, '..', 'pi-agent.ts'), 'utf-8')
  const base = readFileSync(join(import.meta.dir, '..', 'base-agent.ts'), 'utf-8')
  const options = readFileSync(join(import.meta.dir, '..', 'options.ts'), 'utf-8')
  const locales = join(import.meta.dir, '..', '..', 'i18n', 'locales')

  it('POSITIVE: the Pi spawn site queues the localized line with the path it just opened', () => {
    expect(pi).toContain(
      "this.noteSessionNoticeOnce('chat.runtimeDiagnostic.path', { path: diagnosticLog.path })",
    )
    // Inside the `if (diagnosticLog)` branch, beside the host-log line: a notice
    // naming a file that was never opened would be worse than silence.
    expect(pi.indexOf('const diagnosticLog = openSessionRuntimeDebugLog('))
      .toBeLessThan(pi.indexOf("this.noteSessionNoticeOnce('chat.runtimeDiagnostic.path'"))
  })

  it('POSITIVE: the host-log line SURVIVES — this is a second audience, not a move', () => {
    // A developer tailing the log and a user reading the chat need the same fact
    // at different moments; deleting either one is a regression.
    expect(pi).toContain('[pi] C3.274 — this Pi session writes its runtime diagnostic to ')
  })

  it('NEGATIVE: there is ONE notice queue and ONE dedupe set, not a second pair', () => {
    // Pi respawns inside one session, so the dedupe is what turns three respawns
    // into one sentence. The failure this forbids is a second queue drained
    // somewhere else, which is how two surfaces start disagreeing about whether
    // a fact has already been stated.
    expect(base.match(/pendingSessionNotices\.push\(/g)?.length).toBe(1)
    expect(base.match(/private readonly sessionNoticeKeysSent/g)?.length).toBe(1)
    expect(base).not.toContain('inertDirectiveNoticesSent')
    // The inert-directive notice now goes through the same door, carrying the
    // only field the two callers differ in.
    expect(base).toContain("this.noteSessionNoticeOnce(key, values, 'warning')")
  })

  it('NEGATIVE: the Pi line is plain `info`, not a warning', () => {
    // A carried-and-not-honoured directive is a warning because something the
    // user configured is not happening. A file the user asked for by turning
    // debug mode on is not something to act on, and rendering it as a warning
    // would ask them to.
    expect(pi).not.toContain("'chat.runtimeDiagnostic.path', { path: diagnosticLog.path }, 'warning'")
  })

  it('the key is in BOTH locales and carries the interpolation the call site passes', () => {
    for (const name of ['en.json', 'ru.json']) {
      const table = JSON.parse(readFileSync(join(locales, name), 'utf8')) as Record<string, string>
      const copy = table['chat.runtimeDiagnostic.path']
      expect(copy, `${name} is missing chat.runtimeDiagnostic.path`).toBeTruthy()
      // `{{path}}` is the whole point: a sentence that lost it would announce a
      // diagnostic without saying where it is.
      expect(copy).toContain('{{path}}')
      // And the posture C3.274 took, stated to the person deciding whether to
      // attach the file to a ticket rather than only in a docblock.
      expect(copy!.length).toBeGreaterThan(60)
    }
  })

  it('the claude arm\'s divergence is recorded where the falsifying edit happens', () => {
    // P6.551's lesson: an assertion about another module has no guard, so the
    // back-pointer lives in the module that would falsify it.
    expect(options).toContain('C3.302')
    expect(options).toContain('chat.runtimeDiagnostic.path')
  })
})
