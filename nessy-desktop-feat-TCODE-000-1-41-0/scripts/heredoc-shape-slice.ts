/**
 * heredoc-shape-slice — the corpus instrument's CI arm (P6.717).
 *
 * ## The problem this closes
 *
 * `scripts/command-corpus.ts split-diff` is the heredoc split's ONLY weighting,
 * and it runs on exactly one machine: the corpus copy lives outside the
 * repository because transcripts are untrusted data that may carry secrets, and
 * it is never committed. So the model that decides what a permission rule is
 * shown has no arm that runs in CI, and a change to it goes in unweighted on
 * every other machine.
 *
 * ## What is committed instead
 *
 * Counts. `describeHeredocShape` reduces a command to five non-negative
 * integers, `classifyHeredocShape` reduces those to one of four class names, and
 * this script writes the CLASS HISTOGRAM plus the summed totals. No command
 * text, no fragment of a command, no length that could pick one out — the
 * output is arithmetic over the corpus, not a sample of it.
 *
 * That is a weaker instrument than `split-diff` and it is honest about which
 * half it keeps: `split-diff` proves nothing MOVED that should not have, this
 * proves the population the model acts on has not changed shape. A model change
 * that reclassifies commands moves these numbers, and `claude-bash-rule.test.ts`
 * goes red until someone regenerates the slice on the machine with the corpus —
 * which is exactly the moment `split-diff` should be run again.
 *
 * ## The refusal is structural, not a filter
 *
 * {@link heredocShapeSlice} takes strings and returns numbers. There is no code
 * path from a command to the output, so "it must not emit command text" is not a
 * rule this script follows but a shape it has. `heredoc-shape-slice.test.ts`
 * drives it with a planted secret-shaped string and asserts no fragment of that
 * string survives into the serialized slice — an absence finding with its
 * positive control beside it.
 *
 * ## Usage
 *
 *     NESSY_COMMAND_CORPUS=<dir> bun scripts/heredoc-shape-slice.ts        # print
 *     NESSY_COMMAND_CORPUS=<dir> bun scripts/heredoc-shape-slice.ts --write
 *
 * Unset or missing corpus is a clean SKIP with exit 0, exactly as
 * `command-corpus.ts` does: a checkout without the corpus behaves as it does
 * today, and nothing in `bun test` reads the corpus.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  HEREDOC_SHAPE_CLASSES,
  classifyHeredocShape,
  describeHeredocShape,
  type HeredocShapeClass,
} from '../packages/shared/src/agent/pi-harness/claude-bash-rule.ts'
import { loadCommandCorpus } from './command-corpus.ts'

/** Where the committed slice lives, beside the module whose test reads it. */
export const SLICE_PATH = join(
  import.meta.dir,
  '../packages/shared/src/agent/pi-harness/__fixtures__/heredoc-shape-slice.json',
)

/**
 * The committed slice. Every value is an integer or a provenance string the
 * generator itself wrote — never anything read out of the corpus.
 */
export interface HeredocShapeSliceV1 {
  readonly what: string
  readonly generatedBy: string
  /** The corpus manifest's own date, so a stale slice is visible. */
  readonly corpusTakenAt: string
  /** Distinct commands the histogram sums to. */
  readonly corpusCommands: number
  /** One count per {@link HEREDOC_SHAPE_CLASSES} name. Sums to `corpusCommands`. */
  readonly classes: Readonly<Record<HeredocShapeClass, number>>
  /** The five shape fields, summed over every command. */
  readonly totals: {
    readonly bodySpans: number
    readonly bodyLines: number
    readonly expandingBodies: number
    readonly executableBodies: number
    readonly substitutionSpans: number
  }
}

/**
 * Reduce a command list to the slice. Strings in, integers out.
 *
 * `corpusTakenAt` is the caller's, not the corpus's, so this function never
 * touches the manifest either — it is pure arithmetic over the input.
 */
export function heredocShapeSlice(
  commands: Iterable<string>,
  corpusTakenAt: string,
): HeredocShapeSliceV1 {
  const classes: Record<HeredocShapeClass, number> = {
    noHeredoc: 0,
    inertBody: 0,
    expandingWithoutSubstitution: 0,
    expandingWithSubstitution: 0,
  }
  const totals = {
    bodySpans: 0,
    bodyLines: 0,
    expandingBodies: 0,
    executableBodies: 0,
    substitutionSpans: 0,
  }
  let corpusCommands = 0
  for (const command of commands) {
    corpusCommands += 1
    const shape = describeHeredocShape(command)
    classes[classifyHeredocShape(shape)] += 1
    totals.bodySpans += shape.bodySpans
    totals.bodyLines += shape.bodyLines
    totals.expandingBodies += shape.expandingBodies
    totals.executableBodies += shape.executableBodies
    totals.substitutionSpans += shape.substitutionSpans
  }
  return {
    what: 'Derived counts-only slice of the command corpus: the structural shape of its heredocs. '
      + 'NO command text, and none is recoverable from it. Regenerate with '
      + 'NESSY_COMMAND_CORPUS=<dir> bun scripts/heredoc-shape-slice.ts --write',
    generatedBy: 'scripts/heredoc-shape-slice.ts',
    corpusTakenAt,
    corpusCommands,
    classes,
    totals,
  }
}

function main(argv: readonly string[]): number {
  const corpus = loadCommandCorpus()
  if (corpus === null) return 0
  const slice = heredocShapeSlice(corpus.commands, corpus.manifest.takenAt)
  const serialized = `${JSON.stringify(slice, null, 2)}\n`
  if (argv.includes('--write')) {
    writeFileSync(SLICE_PATH, serialized)
    console.log(`slice written to ${SLICE_PATH}`)
  }
  console.log(`corpus commands : ${slice.corpusCommands}`)
  for (const name of HEREDOC_SHAPE_CLASSES) {
    console.log(`  ${name.padEnd(28)}: ${slice.classes[name]}`)
  }
  console.log(`totals          : ${JSON.stringify(slice.totals)}`)
  return 0
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)))
}
