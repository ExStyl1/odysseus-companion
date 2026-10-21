/**
 * P3.21 · the reconcile core of the conformance bench.
 *
 * ## Where this shape comes from
 *
 * Adapted from the omnigent reference (`.references/omnigent`, Apache-2.0 — see
 * its `LICENSE`/`NOTICE`), specifically `tests/harness_bench/verdict.py`. The
 * SHAPE is borrowed and re-expressed in our own types: a verdict taxonomy that
 * separates "measured absent" from "not measured", and a `reconcile` that
 * raises DRIFT only when two CONCRETE facts disagree.
 *
 * This file used to claim "nothing is copied verbatim", and P2.134 found that
 * claim stronger than the text. {@link reconcile}'s docstring says DRIFT is
 * returned "when both sides assert a concrete fact and the facts differ", which
 * is the reference's own sentence with two words changed; the symmetry
 * paragraph below paraphrases its symmetry paragraph closely. Both are
 * permissible under Apache-2.0 with the attribution this block already carries
 * — what was not permissible was the disclaimer. So: attribution recorded,
 * licence recorded, and the wording of {@link reconcile} is ACKNOWLEDGED as
 * close to the source rather than denied.
 *
 * Why that reference at all: its own design note records that the class of
 * check we still use here was MEASURED WRONG. `designs/harness-capabilities-
 * bench-seam.md` says a declaration must come "only from a live observation of
 * 0 deltas — a static 'the forwarder posts no delta' grep is not sufficient",
 * because one harness "has no delta-posting forwarder yet streams live". A
 * source token is not the behaviour; that is the whole argument for this file.
 *
 * ## What we deliberately did NOT adopt
 *
 * The reference's bench decides its own liveness — `live = args.live if
 * args.live is not None else creds_skip is None` — and exits `1 if
 * matrix.has_drift else 0`. With no gateway credentials it therefore runs every
 * probe as SKIPPED, finds no drift, and exits 0. That is a green run that
 * measured nothing, and on our feature branches (no protected-ref secrets,
 * AGENTS.md) it is the DEFAULT run, not an edge case.
 *
 * So this port adds the piece the reference lacks: {@link assertArmed}. A
 * dimension the bench claims to cover must produce a CONCRETE verdict. A probe
 * that silently stopped running is a failure here, not a pass. P3.21's fourth
 * boundary — "instrument silently disarmed is the harder failure than
 * instrument wrong" — is the reason that assertion exists.
 */

/** One cell of the conformance matrix. */
export enum Verdict {
  /** Probed; the behaviour is present. */
  Supported = 'supported',
  /** Probed; the behaviour is absent, and absence is a measurement here. */
  Unsupported = 'unsupported',
  /** Probed; present with a stated caveat. */
  Partial = 'partial',
  /** The dimension does not apply to this subject at all. */
  NotApplicable = 'not-applicable',
  /** No probe ran. Never a pass — {@link assertArmed} refuses it. */
  Unknown = 'unknown',
  /** A probe exists but this environment could not exercise it. */
  Skipped = 'skipped',
  /** Observed and declared both assert a fact, and the facts differ. */
  Drift = 'drift',
}

/**
 * The verdicts that assert something. Only these can establish drift: an
 * unknown or a skipped cell has made no claim to contradict.
 */
const CONCRETE: ReadonlySet<Verdict> = new Set([
  Verdict.Supported,
  Verdict.Unsupported,
  Verdict.Partial,
  Verdict.NotApplicable,
])

export const isConcrete = (verdict: Verdict): boolean => CONCRETE.has(verdict)

/** What one probe measured, plus the evidence a failure should print. */
export interface ProbeResult {
  verdict: Verdict
  /** Short human-readable evidence — "2 terminal events, 0 late deltas". */
  note: string
  /** Structured evidence for a failure message. Never asserted on directly. */
  detail?: Record<string, unknown>
}

export const skipped = (reason: string): ProbeResult => ({ verdict: Verdict.Skipped, note: reason })
export const unknown = (reason: string): ProbeResult => ({ verdict: Verdict.Unknown, note: reason })

/**
 * Compare what a probe measured against what the code declares.
 *
 * Returns {@link Verdict.Drift} when both sides assert a concrete fact and the
 * facts differ, otherwise returns *observed* unchanged.
 *
 * Drift is SYMMETRIC, and that symmetry is the point rather than a nicety.
 * "Declared supported, observed unsupported" is a declaration that over-claims.
 * "Declared unsupported, observed supported" is behaviour nobody wrote down.
 * Applied to an emit surface, the second direction is what makes an UNDRIVEN
 * declared site loud: a site that stops being exercised stops being observed,
 * and a declared-but-unobserved site drifts instead of quietly passing.
 */
export function reconcile(observed: Verdict, declared: Verdict): Verdict {
  if (isConcrete(observed) && isConcrete(declared) && observed !== declared) return Verdict.Drift
  return observed
}

/** One dimension's outcome for one subject. */
export interface Cell {
  dimension: string
  subject: string
  observed: Verdict
  declared: Verdict
  verdict: Verdict
  note: string
  detail?: Record<string, unknown>
}

export function cell(args: {
  dimension: string
  subject: string
  declared: Verdict
  observed: ProbeResult
}): Cell {
  return {
    dimension: args.dimension,
    subject: args.subject,
    observed: args.observed.verdict,
    declared: args.declared,
    verdict: reconcile(args.observed.verdict, args.declared),
    note: args.observed.note,
    ...(args.observed.detail ? { detail: args.observed.detail } : {}),
  }
}

/** Cells whose reconciled verdict is DRIFT — the bench's failure set. */
export const driftCells = (cells: readonly Cell[]): Cell[] =>
  cells.filter(entry => entry.verdict === Verdict.Drift)

/**
 * Cells that measured NOTHING. The reference has no equivalent, and its absence
 * is why a credential-less run of that bench is green.
 *
 * A caller asserts this is empty for every dimension it claims to cover. The
 * escape hatch is deliberate and narrow: a dimension listed in `allowSkipped`
 * may be SKIPPED (never UNKNOWN), and the listing itself is the disclosure.
 */
export const unarmedCells = (
  cells: readonly Cell[],
  allowSkipped: readonly string[] = [],
): Cell[] =>
  cells.filter(entry => {
    if (entry.verdict === Verdict.Unknown) return true
    if (entry.verdict !== Verdict.Skipped) return false
    return !allowSkipped.includes(entry.dimension)
  })

/** A one-line rendering used in failure messages. */
export const renderCell = (entry: Cell): string =>
  `${entry.dimension}/${entry.subject}: observed=${entry.observed} declared=${entry.declared} -> ${entry.verdict} (${entry.note})`
