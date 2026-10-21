/**
 * Case runner and machine-readable result line.
 *
 * Every case prints human lines to stderr and exactly one result line to stdout:
 *
 *     ##CDP-RESULT## {"case":"AGT-1","status":"FAIL","checks":[…],"observations":{…}}
 *
 * The wave runner reads that line and nothing else, so a case can log freely.
 * Exit codes: 0 PASS, 1 FAIL, 2 BLOCKED (a precondition the harness cannot
 * create for itself — a missing fixture, an unauthenticated gateway). BLOCKED is
 * deliberately not FAIL and deliberately not PASS: the retraction in
 * docs/testing/cdp-live-checklist.md exists because a case that could not really
 * run reported a result anyway.
 */

import { attach, type CdpSession, type ConnectOptions } from './connect.ts'
import { setCurrentCaseId } from './permission-mode.ts'
import { readRendererHealth } from './renderer-health.ts'

export const RESULT_PREFIX = '##CDP-RESULT##'

export type CaseStatus = 'PASS' | 'FAIL' | 'BLOCKED'

export interface CaseCheck {
  label: string
  ok: boolean
  detail?: string
}

export interface CaseResult {
  case: string
  title: string
  status: CaseStatus
  durationMs: number
  checks: CaseCheck[]
  observations: Record<string, unknown>
  error?: string
  screenshot?: string
}

/** Thrown by `blocked()`; carries a precondition the harness cannot satisfy. */
export class BlockedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'BlockedError'
  }
}

export function blocked(reason: string): never {
  throw new BlockedError(reason)
}

export class CaseRun {
  readonly checks: CaseCheck[] = []
  readonly observations: Record<string, unknown> = {}

  constructor(readonly id: string, readonly title: string) {}

  /** Record a value the report should carry whether or not the case passes. */
  observe(label: string, value: unknown): void {
    this.observations[label] = value
    console.error(`  · ${label}: ${format(value)}`)
  }

  /**
   * Record an assertion. A false check fails the case but does not stop it.
   *
   * `detail` is the FAILURE sentence and is printed only when the check fails
   * (C3.390). It was printed unconditionally until 2026-09-12, and what that
   * looks like is why the rule changed: RS-32's own log carried
   * `ok the app left the onboarding screen — the onboarding is still on screen
   * 30 s after its last button was pressed …` and `ok the FIRST turn on the
   * freshly seeded card answers — the turn produced no assistant text`. Both
   * checks PASSED; both details are the message for the failure that did not
   * happen, because a call site computes the sentence once and hands it over
   * whatever the outcome — which is the ordinary way to write one of these, and
   * there are 680 `.check(` call sites here.
   *
   * Nothing is lost by the narrowing: `detail` still goes into `checks[]` and so
   * into the `##CDP-RESULT##` line for every check, passing or not, which is
   * what the wave runner and every report read. What it costs is a deliberately
   * INFORMATIVE detail on a passing check disappearing from stderr — and that
   * text has its own channel, `observe()`, which this harness already uses more
   * than twice as often as `check()` (1328 `.observe(` against 680 `.check(`,
   * `git grep -aho … | sort | uniq -c` over `scripts/cdp`, 2026-09-12).
   */
  check(label: string, ok: boolean, detail?: string): boolean {
    this.checks.push({ label, ok, ...(detail ? { detail } : {}) })
    console.error(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`)
    return ok
  }

  /** Record an assertion and stop the case when it fails. */
  require(label: string, ok: boolean, detail?: string): void {
    this.check(label, ok, detail)
    if (!ok) throw new Error(`required check failed: ${label}${detail ? ` — ${detail}` : ''}`)
  }

  get failed(): boolean {
    return this.checks.some(c => !c.ok)
  }
}

function format(value: unknown): string {
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value
  const json = JSON.stringify(value)
  return json && json.length > 300 ? `${json.slice(0, 300)}…` : String(json)
}

function artifactDir(): string {
  return process.env.NESSY_CDP_ARTIFACTS ?? '/tmp/nessy-cdp-artifacts'
}

// Imported here, below the lines other documents cite by number (`:47`, `:110`), so those keep their place.
import { configDirVerdict, readAppConfigDirs } from './app-env.ts'
import { resolvePort } from './connect.ts'

export interface RunCaseOptions extends ConnectOptions {
  /** Skip the screenshot taken when a case does not pass. */
  noScreenshot?: boolean
}

export async function runCase(
  id: string,
  title: string,
  body: (run: CaseRun, session: CdpSession) => Promise<void>,
  options: RunCaseOptions = {},
): Promise<CaseResult> {
  const started = Date.now()
  // D1.385 — the ONLY writer of the current-case registry `lib/permission-mode.ts`
  // keeps, which is what lets `freshSession` apply a PER-CASE permission mode
  // without every one of the 138 call sites passing its own id. It is set here
  // rather than at a call site for the reason D1.385's "done means" gives: a
  // default a case has to opt into is a default the case that forgot does not
  // have. A module-level value is correct because `run.ts` gives each case its
  // own process.
  setCurrentCaseId(id)
  const run = new CaseRun(id, title)
  console.error(`\n=== ${id} — ${title} ===`)
  let session: CdpSession | undefined
  let status: CaseStatus = 'PASS'
  let error: string | undefined
  let screenshot: string | undefined
  try {
    // F1.1141 (origin DN-195) — F1.852's config-dir verdict, taken once per CASE PROCESS, so a case file run
    // directly (not through `run.ts`, which takes the same verdict for its wave) refuses an app on another config
    // dir too: BLOCKED with `run.ts`'s own line, before anything attaches. `not-compared` lets the case run.
    const configDirCheck = configDirVerdict(process.env.NESSY_CONFIG_DIR, readAppConfigDirs(resolvePort(options.port)))
    if (configDirCheck.verdict === 'mismatch') blocked(configDirCheck.line)
    session = await attach(options)
    await body(run, session)
    if (run.failed) status = 'FAIL'
  } catch (cause) {
    if (cause instanceof BlockedError) {
      // A failed check already observed is a real failure; a missing precondition
      // discovered afterwards does not launder it into "could not run".
      status = run.failed ? 'FAIL' : 'BLOCKED'
      error = cause.message
    } else {
      status = 'FAIL'
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }
  if (status !== 'PASS' && session && !options.noScreenshot) {
    try {
      screenshot = await session.screenshot(`${artifactDir()}/${id}-${Date.now()}.png`)
    } catch { /* evidence is a nicety; the result line is the deliverable */ }
  }
  // C3.389 — whenever a case does not PASS, say whether the RENDERER was still
  // there. RV measured a renderer that disappeared under a live main process on
  // packaged 1.37.0, with no crash report and no application log; from here it
  // reads as every check timing out at once, and nothing in the result line
  // separated that from a product failure. Read over HTTP, because a lost
  // renderer takes the CDP socket with it, and read for EVERY non-pass rather
  // than per case: an instrument a case has to opt into is an instrument the
  // failing case did not have. See `lib/renderer-health.ts` for what a null
  // reading does and does not prove.
  if (status !== 'PASS') {
    try {
      run.observe('renderer health at exit', await readRendererHealth(options.port))
    } catch { /* the instrument must never be the reason a result line is lost */ }
  }
  session?.close()

  const result: CaseResult = {
    case: id,
    title,
    status,
    durationMs: Date.now() - started,
    checks: run.checks,
    observations: run.observations,
    ...(error ? { error } : {}),
    ...(screenshot ? { screenshot } : {}),
  }
  console.error(`--- ${id}: ${status}${error ? ` (${error})` : ''} ---`)
  console.log(`${RESULT_PREFIX} ${JSON.stringify(result)}`)
  return result
}

export function exitCodeFor(status: CaseStatus): number {
  return status === 'PASS' ? 0 : status === 'FAIL' ? 1 : 2
}

/** Boilerplate for a case file's `import.meta.main` block. */
export async function main(
  id: string,
  title: string,
  body: (run: CaseRun, session: CdpSession) => Promise<void>,
): Promise<void> {
  const result = await runCase(id, title, body)
  process.exit(exitCodeFor(result.status))
}
