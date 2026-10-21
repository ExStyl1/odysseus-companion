/**
 * The removal spellings the Linux half of the platform rig executes, and the
 * host half classifies (`run-linux-removal-probe.ts`).
 *
 * ## Why this corpus exists at all (P2.188, owner decision 2026-09-02 §A4)
 *
 * `removal-circuit-breaker.ts` is a cross-platform floor whose test host is
 * darwin, and darwin ships BSD `rm`, which **takes no long options at all**
 * (`rm: illegal option -- -`, exit 64, usage `[-f | -i] [-dIPRrvWx]`). So every
 * claim the floor makes about `--recursive`, `--dir` and `--force` — three
 * spellings it accepts in code — was untestable on the machine that tests it.
 * The row asked whether that is acceptable or whether a GNU coreutils path
 * belongs in the verification kit. The owner said it does.
 *
 * The corpus is therefore GNU-shaped on purpose: the interesting rows are the
 * ones darwin cannot run. It is **not** an attempt to re-cover what the
 * adversarial corpus already covers on the host.
 *
 * ## Every entry is synthetic, and `$HOME` is a directory the probe created
 *
 * The probe points `HOME` at a tree it built inside the container, one per
 * entry, so a spelling that really does destroy `$HOME` destroys that tree and
 * nothing else. Nothing here may name a real path; `expectation` is what a
 * reader should predict, and the probe prints the MEASURED answer beside it so
 * a wrong prediction is visible rather than assumed.
 */

/**
 * What a reader should predict before the probe runs. Compared, never trusted.
 *
 * Three outcomes and not two, because `rm -rf "$HOME"/*` leaves the DIRECTORY
 * standing and takes everything a user cares about — a two-valued verdict
 * would have scored that row as harmless.
 */
export type Expectation = 'home-removed' | 'content-removed' | 'intact' | 'unknown'

export interface RemovalSpelling {
  /** Stable id — the join key between the container half and the host half. */
  readonly id: string
  /**
   * Shell text, run by `sh -c` inside the container with `HOME` pointing at a
   * freshly built synthetic tree. `$HOME` is expanded by that inner shell, so
   * the same string is what the host half hands to the floor (with `$HOME`
   * substituted for the probe's home).
   */
  readonly command: string
  /** Why the row is in the corpus. One line; it is printed in the table. */
  readonly note: string
  readonly expectation: Expectation
}

/**
 * Rows the corpus needs in order to prove the INSTRUMENT works before any
 * absence claim is read off it: one spelling that must destroy the tree, one
 * that must leave it, and one that never touches it.
 */
export const CONTROL_IDS = ['control-rf', 'control-flagless', 'control-noop'] as const

export const REMOVAL_CORPUS: readonly RemovalSpelling[] = [
  // ---- positive/negative controls for the container half -------------------
  {
    id: 'control-rf',
    command: 'rm -rf "$HOME"',
    note: 'POSITIVE CONTROL — must destroy, or the probe is not running commands',
    expectation: 'home-removed',
  },
  {
    id: 'control-flagless',
    command: 'rm "$HOME"',
    note: 'NEGATIVE CONTROL — GNU `rm` refuses a directory without -r/-d',
    expectation: 'intact',
  },
  {
    id: 'control-noop',
    command: 'ls "$HOME" >/dev/null',
    note: 'INERT CONTROL — proves a surviving tree is not simply an unrun command',
    expectation: 'intact',
  },

  // ---- P2.188 residue (1): the flagless spelling the two matchers disagree on
  {
    id: 'flagless-force',
    command: 'rm --force "$HOME"',
    note: 'residue (1) sibling: force without recursion, long spelling',
    expectation: 'intact',
  },

  // ---- P2.188 residue (2): the -i over-fire ---------------------------------
  {
    id: 'rfi',
    command: 'rm -rfi "$HOME"',
    note: 'residue (2): -i is interactive and comes last; the floor fires anyway',
    expectation: 'intact',
  },
  {
    id: 'r-interactive-always',
    command: 'rm -r --interactive=always "$HOME"',
    note: 'GNU-only spelling of the same over-fire',
    expectation: 'intact',
  },
  {
    id: 'r-interactive-never',
    command: 'rm -r --interactive=never "$HOME"',
    note: 'GNU-only: --interactive=never IS -f, and our parser reads neither',
    expectation: 'home-removed',
  },

  // ---- P2.188 residue (3): --dir, unmeasurable on BSD ----------------------
  {
    id: 'dir-alone',
    command: 'rm --dir "$HOME"',
    note: 'residue (3): the spelling darwin cannot execute at all',
    expectation: 'intact',
  },
  {
    id: 'dir-force',
    command: 'rm --dir --force "$HOME"',
    note: 'residue (3): the pair the floor treats as a removal',
    expectation: 'intact',
  },
  {
    id: 'dir-force-empty',
    command: 'rm --dir --force "$HOME"',
    note: 'residue (3) on an EMPTY home — the one shape --dir does remove',
    expectation: 'home-removed',
  },

  // ---- the long spellings the floor claims to accept ----------------------
  {
    id: 'recursive-long',
    command: 'rm --recursive --force "$HOME"',
    note: 'the documented GNU spelling the floor accepts and darwin cannot run',
    expectation: 'home-removed',
  },
  {
    id: 'recursive-long-noforce',
    command: 'rm --recursive "$HOME"',
    note: 'P2.178 measured force is not required; this is the GNU spelling of it',
    expectation: 'home-removed',
  },

  // ---- GNU getopt_long ABBREVIATION: the spellings nobody wrote down -------
  {
    id: 'abbrev-rec',
    command: 'rm --rec --force "$HOME"',
    note: 'GNU accepts any UNAMBIGUOUS long-option prefix',
    expectation: 'unknown',
  },
  {
    id: 'abbrev-r',
    command: 'rm --r -f "$HOME"',
    note: 'shortest unambiguous prefix of --recursive',
    expectation: 'unknown',
  },
  {
    id: 'abbrev-force',
    command: 'rm -r --fo "$HOME"',
    note: 'abbreviated --force beside a short -r',
    expectation: 'unknown',
  },
  {
    id: 'abbrev-both',
    command: 'rm --rec --fo "$HOME"',
    note: 'both halves abbreviated — neither word is in the floor parser',
    expectation: 'unknown',
  },

  // ---- other GNU-only spellings worth a verdict ---------------------------
  {
    id: 'one-file-system',
    command: 'rm -rf --one-file-system "$HOME"',
    note: 'GNU-only flag beside a removal the floor already names',
    expectation: 'home-removed',
  },
  {
    id: 'no-preserve-root',
    command: 'rm -rf --no-preserve-root "$HOME"',
    note: 'the flag that matters for `/`, spelled against a home',
    expectation: 'home-removed',
  },
  {
    id: 'capital-i',
    command: 'rm -rI "$HOME"',
    note: '-I prompts once; on a pipe the answer is EOF',
    expectation: 'intact',
  },
  {
    id: 'tilde-rf',
    command: 'rm -rf ~',
    note: 'the tilde form, expanded by the inner shell rather than by us',
    expectation: 'home-removed',
  },
  {
    id: 'tilde-flagless',
    command: 'rm ~',
    note: 'residue (1) verbatim: the form the textual fallback will not name',
    expectation: 'intact',
  },
  {
    id: 'home-glob',
    command: 'rm -rf "$HOME"/*',
    note: 'contents rather than the directory — destroys everything that matters',
    expectation: 'content-removed',
  },
]

/** Entries whose synthetic home must be built EMPTY. */
export const EMPTY_HOME_IDS: ReadonlySet<string> = new Set(['dir-force-empty'])
