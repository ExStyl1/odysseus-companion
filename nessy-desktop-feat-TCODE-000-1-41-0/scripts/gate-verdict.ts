/**
 * gate-verdict — turn a child process's raw exit into a word.
 *
 * P2.353 opened as "a lint script OOMs and reads as a pass": a run killed
 * mid-flight leaves `exitCode 134` (Bun's OOM abort) or a signal, and a caller
 * reading a number records it next to the 0s. The number is not the problem —
 * the problem is that nothing SAYS what happened, so the three outcomes that
 * matter (finished clean / finished red / never finished) are one glance apart.
 *
 * So there are three verdicts, not two, and the third has its own sentence.
 * `exitCode >= 128` counts as killed because `bun run` and `npm run` translate
 * a child's fatal signal into `128 + signo` rather than re-raising it, so the
 * signal is gone by the time a wrapper sees it.
 */

export type VerdictKind = 'pass' | 'fail' | 'killed'

export interface Verdict {
  kind: VerdictKind
  exitCode: number | null
  signal: string | null
  /** One short phrase for a table cell, e.g. `FAIL (exit 1)`. */
  label: string
}

export function classifyRun(
  exitCode: number | null | undefined,
  signalCode: string | null | undefined,
): Verdict {
  const signal = signalCode === undefined || signalCode === null ? null : signalCode
  const code = exitCode === undefined || exitCode === null ? null : exitCode

  if (signal !== null) {
    return { kind: 'killed', exitCode: code, signal, label: `KILLED (${signal})` }
  }
  if (code === null) {
    return { kind: 'killed', exitCode: null, signal: null, label: 'KILLED (no exit status)' }
  }
  if (code >= 128) {
    return { kind: 'killed', exitCode: code, signal: null, label: `KILLED (exit ${code})` }
  }
  if (code === 0) {
    return { kind: 'pass', exitCode: 0, signal: null, label: 'PASS' }
  }
  return { kind: 'fail', exitCode: code, signal: null, label: `FAIL (exit ${code})` }
}

/**
 * The paragraph a killed step gets. Written out rather than left implicit:
 * this exact shape has been recorded as a pass on this branch before.
 */
export function killedExplanation(what: string, verdict: Verdict): string {
  return (
    `${what} was KILLED (signal ${verdict.signal ?? 'none reported'}, ` +
    `exit ${verdict.exitCode ?? 'none'}).\n` +
    '  It did NOT finish, so it proved nothing — this is a FAILURE, not a pass.\n' +
    '  134 is what Bun reports when it runs out of memory; 137 is an outside kill.\n' +
    '  Said in words because a caller reading only an exit status has recorded\n' +
    '  this shape as a pass before (P2.353).'
  )
}
