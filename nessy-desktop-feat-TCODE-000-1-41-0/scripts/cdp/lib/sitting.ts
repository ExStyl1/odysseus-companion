/**
 * The sitting cases' two shared shapes — P6.1014.
 *
 * ## Why a type and not another string check
 *
 * Twenty-eight `cases/rs-*.ts` files landed in one wave from two lanes, and every
 * property the sitting depends on was a hand-written literal that nothing read.
 * P6.1012 put the directory under a guard, but a guard that reads `manual` as
 * `Record<string, unknown>` can only ask *is there a key spelled `detector`* —
 * which is a string check wearing a test's clothes. These two types move the
 * question to the compiler: a case that forgets its detector, or its positive
 * control, fails `bun x tsc -p scripts/cdp/tsconfig.json` in the file that
 * forgot it, naming the missing key.
 *
 * The runtime guard in `harness.test.ts` stays, because `satisfies` only binds a
 * file that opted in and the glob is what catches a file that did not.
 *
 * ## Types only — nothing here runs in a case process
 *
 * Every case imports these with `import type`, which is erased before bun sees
 * the file, so a standalone `bun run scripts/cdp/cases/rs-15.ts` loads no extra
 * module. That is the invariant to keep — not a count of what this file exports:
 * the value exports here ({@link SITTING_RUNTIMES}, {@link positiveControlOf})
 * exist for `harness.test.ts`, which is a `bun test` file and not a case process.
 * A case that ever imports one of them as a VALUE is the thing that breaks this.
 */

/**
 * The runtime FAMILY vocabulary the sitting table is per (P7.5, P6.1026) — never
 * a providerType.
 *
 * A VALUE, and the type below is derived from it rather than written twice. The
 * union alone cannot be read at run time, so the guard in `harness.test.ts` that
 * checks the case files a `satisfies` never bound — a file is only bound if it
 * opted in — would have had to restate these three names, which is the defect
 * P6.1058 is named for: a list beside a list, one of them going stale quietly.
 */
export const SITTING_RUNTIMES = ['pi', 'claude', 'codex'] as const

export type SittingRuntime = typeof SITTING_RUNTIMES[number]

/** The identity block every CDP case exports, sitting or wave. */
export interface CaseMeta {
  /** The filename upper-cased — `rs-15.ts` says `RS-15`. Pinned by `harness.test.ts`. */
  readonly id: string
  readonly title: string
  /** The plan row this case answers, e.g. `P6.226`. Pinned against the plan itself. */
  readonly row: string
  /**
   * The runtimes the case is asked about, in the FAMILY form and no other —
   * {@link SITTING_RUNTIMES}, which this union is derived from.
   *
   * The vocabulary was settled by the controller on 2026-09-10 (plan row P7.5)
   * and every case was aligned to it in `03318461c`; the union has been pinned
   * here since the same commit. What this type CANNOT do is bind a file that
   * never opted in with `satisfies CaseMeta` — `cru-7.ts` carried this whole
   * block unbound until P6.1058 — so the run-time half lives in
   * `harness.test.ts`, reads {@link SITTING_RUNTIMES} rather than restating it,
   * and holds every case file that declares `runtimes` to opting in.
   */
  readonly runtimes: readonly SittingRuntime[]
  /** What the operator must have, in words. Never a key, never a token. */
  readonly credentials: string
}

/**
 * The prose a sitting recipe carries, minus its control.
 *
 * The optional keys are the notes the existing files already carry. They are
 * ENUMERATED rather than swallowed by an index signature, and the friction is
 * deliberate: an index signature would make `detecter:` a legal recipe, and this
 * type exists precisely so a mis-spelled key is a compile error rather than a
 * property nothing reads. A new note key costs one line here.
 */
interface SittingRecipeBody {
  /** Every step in order, each a whole instruction the operator can follow. */
  readonly steps: readonly string[]
  /** What the run must produce for the row to be answered. */
  readonly expected: string
  /**
   * The source the FEATURE itself writes, never the screen and never the model's
   * prose. A detector nobody tested is this repo's most expensive recurring
   * mistake; a recipe without one cannot be run twice to the same verdict.
   */
  readonly detector: string
  /** What the plan row is allowed to be marked once this has been run. */
  readonly doneMeans: string
  /** Why this case is a recipe rather than a `drive()`. */
  readonly why?: string
  /** A precondition that decides whether the recipe is worth running at all. */
  readonly runOnlyIf?: string
  /** A read that would answer the wrong question — `rs-17`. */
  readonly doNotRead?: string
  /** What the operator must not damage while running it — `rs-18`, `rs-25`. */
  readonly safety?: string
  /** Two findings that look identical and are not — `rs-19`. */
  readonly doNotConflate?: string
  /** An arm that must not be driven at all — `rs-24`, `rs-26`. */
  readonly neverDo?: string
}

/**
 * A sitting recipe: the body above plus a POSITIVE CONTROL — the run that proves
 * the rig can see the thing whose absence is about to be scored.
 *
 * ## One spelling, since P6.1027
 *
 * It was an exclusive union of two keys until 2026-09-10, because the two
 * wave-10 lanes named the same field differently: `rs-02`…`rs-13` wrote
 * `positiveControl` and `rs-14`…`rs-29` wrote `control`. The union kept the
 * REQUIREMENT honest — exactly one of them, always present — and deferred the
 * rename, because renaming a key in sixteen case bodies is a different change
 * from typing them. The sixteen were renamed to `positiveControl`, so the union
 * collapses to the one intersection it always meant.
 *
 * The name that survived is the longer one, and deliberately: `control` alone is
 * the word this repo uses for BOTH arms of a measurement (a negative control is
 * a control too), while a recipe's field is specifically the positive one. A
 * case that means the other arm says so in its prose.
 */
export type SittingRecipe = SittingRecipeBody & { readonly positiveControl: string }

/**
 * A recipe's positive control.
 *
 * One line since P6.1027 collapsed the two spellings, and kept rather than
 * inlined for the reason it was written for: every reader still enters here, so
 * a control that ever becomes computed — or spelled differently again — is this
 * function and nothing else. The compiler now carries the half this used to: a
 * case that omits the key fails `tsc` in the file that omitted it.
 */
export function positiveControlOf(recipe: SittingRecipe): string {
  return recipe.positiveControl
}

/**
 * F1.184 (origin WJ-j `P-WJ-j-3`, DA2.18's residue) — `run.ts`'s `SITTING`
 * list against the CHECKLIST, both directions.
 *
 * `harness.test.ts` already holds the runner to the DIRECTORY: every driving
 * `rs-*.ts` is in `SITTING`, no recipe is, and every `SITTING` id has a file.
 * What nothing held was the checklist, which is where a sitting's reading is
 * recorded — so a case could be reachable by name, driven, and have nowhere to
 * write its verdict (`RS-108` landed that way on 2026-09-20), or a checklist row
 * could name a driving case the runner refuses by name. The harness cannot gate
 * the first direction, by its own recorded rule: the checklist is
 * controller-owned and a new case's row arrives after the case, so a harness
 * failure would redden every lane that lands one. So it is a CHECK the
 * controller runs — `bun run scripts/cdp/run.ts --check` — and this is its
 * logic, pure so a test can drive it against a fabricated checklist.
 *
 * Only the RS family is read in the reverse direction: the checklist also
 * carries rows (`QL9`, `AGENT-INSTALL`) whose driving case is deliberately in
 * neither runner list, because it mutates a real profile and wants to be asked
 * for by file.
 */
export interface SittingChecklistDrift {
  /** A `SITTING` id the checklist has no row for — reachable by name, nowhere to record it. */
  readonly sittingWithoutRow: readonly string[]
  /** A checklist `RS-*` row whose case file DRIVES and which `SITTING` does not name. */
  readonly rowsNotInSitting: readonly string[]
  /** Checklist `RS-*` rows with no case file yet (`case owed`) — information, not drift. */
  readonly rowsOwed: readonly string[]
  /** Checklist `RS-*` rows whose case is a pure recipe — never in `SITTING` by design. */
  readonly rowsRecipe: readonly string[]
}

/** What a checklist id's case file is: a `drive()`, a recipe, or not written yet. */
export type SittingCaseKind = 'drive' | 'recipe' | 'absent'

export function sittingChecklistDrift(
  sitting: readonly string[],
  checklist: string,
  caseKind: (id: string) => SittingCaseKind,
): SittingChecklistDrift {
  const rowIds = new Set([...checklist.matchAll(/^\| ([A-Z0-9]+(?:-[A-Z0-9]+)+) \|/gm)].map(match => match[1]!))
  const listed = new Set(sitting)
  const rsRows = [...rowIds].filter(id => /^RS-\d+$/.test(id))
  const kindOf = new Map(rsRows.map(id => [id, caseKind(id)] as const))
  return {
    sittingWithoutRow: sitting.filter(id => !rowIds.has(id)),
    rowsNotInSitting: rsRows.filter(id => kindOf.get(id) === 'drive' && !listed.has(id)),
    rowsOwed: rsRows.filter(id => kindOf.get(id) === 'absent'),
    rowsRecipe: rsRows.filter(id => kindOf.get(id) === 'recipe'),
  }
}
