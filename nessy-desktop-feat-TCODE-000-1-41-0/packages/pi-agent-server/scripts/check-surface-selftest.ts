/**
 * check-surface-selftest — the CHECKER's own invariants, asserted on the command
 * every lane already runs.
 *
 * P2.255, and it is the row's THIRD ANSWER. Read the refusal first, because the
 * shape of this file is entirely determined by it.
 *
 * ## The seam
 *
 * `check:surface` (the gate) rides `packages/pi-agent-server`'s `typecheck`,
 * which every lane runs in its implementation loop. The TEST of the gate —
 * `src/harness/source-state-contract.test.ts` — rides the root `bun test`, which
 * CI runs and lanes do not. So the invariants that row fought for are protected
 * only at merge, and a lane can narrow the gate locally and stay green.
 *
 * W2-y already moved the REPORT-SHAPE half onto the fast path
 * (`reportShapeSelfCheckFailure`, called from the gate's own `run()`). What is
 * left is the half about the CHECKER: does it still read all three digest
 * fields, does it still tell a hand-edited pin from real drift.
 *
 * ## Why the obvious fix is worse, written down rather than assumed
 *
 * The obvious fix is to add `bun test src/harness/source-state-contract.test.ts`
 * to `typecheck`. Four reasons it is worse, and the first is decisive:
 *
 * 1. **It drags the repo's test mutex into the command lanes run constantly.**
 *    `scripts/bun-test-lock.ts` is ADVISORY — wired into no bunfig and no CI —
 *    so attaching `bun test` to `typecheck` means either every lane serialises
 *    on that lock (blocking a whole parallel wave on the most frequently run
 *    command there is) or lanes run unsynchronised concurrent `bun test`
 *    processes, which is the documented trap that manufactures failures.
 * 2. **It inverts the dependency.** `typecheck` would require a test runner, and
 *    a runner fault would reach the operator as a type error — the wrong file to
 *    go and edit, which is the same misdirection the gate's own `main()` guards
 *    against for its refusals.
 * 3. **It pays for the whole matrix to protect a few invariants.** That file is
 *    528 lines of synthetic-repo cases; the regressions that are SILENT are a
 *    handful of derivations.
 * 4. **It is not even sufficient.** The same argument would then be owed for
 *    every other gate in the same family (P2.222, P2.233), and "add a test run
 *    to typecheck" does not scale to them.
 *
 * ## The third answer
 *
 * The invariants worth protecting in-loop are properties of PURE FUNCTIONS over
 * plain values — `expectedPinValue`, `factoryFunctionName`,
 * `pinIsInternallyInconsistent`. They need no test runner, no synthetic repo,
 * and no filesystem at all. So they run in an ordinary `bun` process, from the
 * package's own `typecheck`, beside the gate they protect. It is the shape the
 * gate already uses for its report half, and the shape
 * `scripts/check-claude-bash-split-fuzz.ts` uses for its rig: **assert first,
 * then do the work.**
 *
 * **What this does NOT close.** The synthetic-repo cases — drift detection over
 * a real fixture, the per-field refusals, `--pin` — still ride `bun test`.
 * Those need a filesystem and a fixture, and duplicating the 60-line synthetic
 * repo here would create a second harness to keep in step with the first, which
 * is a worse trade than the seam it closes. The seam itself, and the larger
 * question the row poses — which command is a lane GUARANTEED to run, and can
 * anything be attached to it without dragging the mutex along — is still open
 * and still to be decided with P2.222 and P2.233.
 *
 *
 * ## The SPLIT is the policy, not an accident of this file (D1.1, decided 2026-09-17)
 *
 * P2.255 asked which command a lane is GUARANTEED to run, and whether anything
 * can be attached to it without dragging the test mutex along. Both halves are
 * now answered, and the answer is the rule this file already follows:
 *
 *   - **The guarantee is `bun run typecheck:<pkg>`, for a package the lane
 *     touched, and nothing else.** A focused `bun test` covers only the files
 *     the lane itself changed, and `lint:chain` / `validate:ci` are
 *     wave-boundary gates by the Implementation-First Verification Budget.
 *   - **What may be attached to it is a pure derivation over plain values**, as
 *     a plain `bun <script>` step with no runner, no fixture and no filesystem —
 *     which is exactly what this file is.
 *   - **Everything that needs a runner, a fixture tree or a filesystem rides
 *     `bun test` and is a MERGE-time protection.** That is not a defect to be
 *     closed later; it is the trade, and the reason is the four-part refusal
 *     above.
 *
 * So each gate in this family DECLARES which of its invariants sit on which
 * side, in its own docblock, rather than leaving the reader to infer it from
 * what happens to be where. A merge-time protection that is written down is
 * finishable; one the tree merely implies is indistinguishable from an
 * oversight — which is the whole of what P2.255 was about.
 * ## Usage
 *
 *     bun scripts/check-surface-selftest.ts             # from the package root
 *     bun scripts/check-surface-selftest.ts --self-test # prove it can fail
 */

import {
  DIGEST_FIELDS,
  DYNAMIC_WIRE_SOURCE_KIND,
  PIN_FIELDS,
  SOURCE_STATE_FACTORIES,
  type SourceStateDrift,
  dynamicWireSourceSelfCheckFailure,
  expectedDynamicWirePinValue,
  expectedPinValue,
  factoryFunctionName,
  modelContractSelfCheckFailure,
  pinIsInternallyInconsistent,
} from '../src/harness/source-state-contract.ts'

/** A check answers with the reason it failed, or `null`. */
interface Check {
  readonly name: string
  readonly run: () => string | null
}

const DIGEST = 'a'.repeat(64)
const COMMIT = `@${'e'.repeat(40)}`

/** Any real factory: these are derivations, so which one does not matter. */
const [FACTORY_NAME, FACTORY] = Object.entries(SOURCE_STATE_FACTORIES)[0]!

/** A drift row carrying whatever stored digests a case wants to ask about. */
function driftWithStoredDigests(digests: readonly string[]): SourceStateDrift {
  const stored = Object.fromEntries(
    DIGEST_FIELDS.map((field, index) => [field, digests[index] ?? digests[0]!]),
  ) as SourceStateDrift['stored']
  const full = Object.fromEntries(PIN_FIELDS.map(field => [field, field])) as SourceStateDrift['storedFull']
  return {
    currentName: FACTORY_NAME,
    semanticId: FACTORY.semanticId,
    path: FACTORY.path,
    stored,
    storedFull: full,
    expected: full,
    live: DIGEST,
    mismatched: [],
    mismatchedFull: [],
  }
}

const CHECKS: readonly Check[] = [
  {
    // I3 at the CHECKER rather than at the renderer: a gate narrowed back to
    // `schemaIdentity` alone would still print three field names while deriving
    // one value, and this is what says the three are genuinely different reads.
    name: 'the three digest fields derive three DIFFERENT strings from one digest',
    run: () => {
      const values = DIGEST_FIELDS.map(field => expectedPinValue(FACTORY, FACTORY_NAME, DIGEST, field, ''))
      if (new Set(values).size !== DIGEST_FIELDS.length) {
        return `two of the ${DIGEST_FIELDS.length} digest fields derive the same string, so a pin narrowed to one of them cannot be told from a pin carrying all three.`
      }
      const missing = DIGEST_FIELDS.filter((field, index) => !values[index]!.includes(DIGEST))
      if (missing.length > 0) {
        return `${missing.join(', ')} no longer carries the digest, so a source change cannot move it.`
      }
      return null
    },
  },
  {
    // The shape a digest-only gate is structurally blind to: the source is
    // untouched, the TOOL was renamed, and only `bindingSchemaVersion` moves.
    name: 'bindingSchemaVersion moves on a RENAME with unchanged source',
    run: () => {
      const before = expectedPinValue(FACTORY, FACTORY_NAME, DIGEST, 'bindingSchemaVersion', '')
      const after = expectedPinValue(FACTORY, `${FACTORY_NAME}_renamed`, DIGEST, 'bindingSchemaVersion', '')
      if (before === after) {
        return 'bindingSchemaVersion ignores the tool name, so a rename with unchanged source would pass this gate silently.'
      }
      const identity = expectedPinValue(FACTORY, FACTORY_NAME, DIGEST, 'schemaIdentity', '')
      if (identity !== expectedPinValue(FACTORY, `${FACTORY_NAME}_renamed`, DIGEST, 'schemaIdentity', '')) {
        return 'schemaIdentity moved on a rename too — the two fields are no longer answering different questions.'
      }
      return null
    },
  },
  {
    name: "handlerSchemaVersion names the factory's own path and function",
    run: () => {
      const value = expectedPinValue(FACTORY, FACTORY_NAME, DIGEST, 'handlerSchemaVersion', `x${COMMIT}`)
      const wanted = `${FACTORY.path}#${factoryFunctionName(FACTORY)}.execute${COMMIT}`
      if (value !== wanted) return `handlerSchemaVersion derived ${JSON.stringify(value)}, expected ${JSON.stringify(wanted)}.`
      return null
    },
  },
  {
    // The one half of the pin nothing can derive. A silently fabricated commit
    // suffix would make a hand-edited pin look complete.
    name: 'a pin with no commit suffix SAYS SO rather than fabricating one',
    run: () => {
      const value = expectedPinValue(FACTORY, FACTORY_NAME, DIGEST, 'handlerSchemaVersion', 'no commit here')
      if (!value.includes('missing from the pin')) {
        return `a pin with no 40-hex commit derived ${JSON.stringify(value)} — the gate must name the gap, not invent a suffix.`
      }
      return null
    },
  },
  {
    // Both directions, so a deleted branch cannot pass: an inconsistent pin is a
    // HAND EDIT and a consistent one is ordinary drift, and the reports differ.
    name: 'the hand-edit split answers in BOTH directions',
    run: () => {
      if (!pinIsInternallyInconsistent(driftWithStoredDigests(['a'.repeat(64), 'b'.repeat(64)]))) {
        return 'a pin whose own digest fields disagree is no longer reported as a hand edit — it would be reported as drift and `--pin` would paper over it.'
      }
      if (pinIsInternallyInconsistent(driftWithStoredDigests([DIGEST]))) {
        return 'a pin whose digest fields all agree is reported as a hand edit, so every ordinary drift would now be misreported.'
      }
      return null
    },
  },
  {
    // P6.877 — the seventh pin's payload is THREE values from two files, and a
    // region that stopped reaching the digest would leave a change-detector that
    // detects half as much while still looking correct. The check plants each
    // field in turn; it is pure, so it belongs on this fast path rather than in
    // the synthetic-repo suite that rides root `bun test`.
    name: 'every field of the dynamic-wire payload moves its digest',
    run: dynamicWireSourceSelfCheckFailure,
  },
  {
    // The copy-paste hazard the two derivations sit one screen apart from: the
    // dynamic pin reusing `source-state-schema`'s prefix would mislabel its own
    // class, and the pin would then agree with a gate reading the wrong kind.
    name: 'the dynamic-wire pin does not derive the six source-state pins’ strings',
    run: () => {
      const row = { currentName: FACTORY_NAME, handlerName: 'Pool.callTool' }
      for (const field of PIN_FIELDS) {
        const dynamic = expectedDynamicWirePinValue(row, DIGEST, field, COMMIT)
        const sourceState = expectedPinValue(FACTORY, FACTORY_NAME, DIGEST, field, COMMIT)
        if (field !== 'bindingSchemaVersion' && dynamic === sourceState) {
          return `${field} derives the same string for a dynamic-wire pin as for a source-state one, so the two classes are no longer distinguishable in the fixture.`
        }
      }
      const identity = expectedDynamicWirePinValue(row, DIGEST, 'schemaIdentity', COMMIT)
      if (!identity.startsWith(`${DYNAMIC_WIRE_SOURCE_KIND}:`)) {
        return `the dynamic-wire schemaIdentity derived ${JSON.stringify(identity)}, which does not carry its own evidence kind.`
      }
      return null
    },
  },
  {
    // P6.1077 — the `--pin` guard's comparator. It is pure over plain values, so
    // it belongs on this fast path: the guard itself runs only under `--pin`,
    // which is precisely the command whose failure mode was silence, and a
    // comparator narrowed back to "report nothing" would restore that silence
    // while `check:surface` kept printing green.
    name: 'a parted model-contract hash is reported, an agreeing one is not, and the refusal names both',
    run: modelContractSelfCheckFailure,
  },
]

/** A check that can only ever fail — the positive control for this rig. */
const ALWAYS_FAILS: Check = {
  name: '(self-test) a check that cannot pass',
  run: () => 'this check exists to prove the runner reports a failure at all.',
}

function main(argv: readonly string[]): number {
  const selfTest = argv.includes('--self-test')
  const checks = selfTest ? [...CHECKS, ALWAYS_FAILS] : CHECKS
  const failures: string[] = []
  for (const check of checks) {
    const failure = check.run()
    if (failure !== null) failures.push(`  ${check.name}\n    ${failure}`)
  }
  if (selfTest) {
    // The control is the whole point of the flag: a self-check that has never
    // refused anything is not known to work.
    if (failures.length !== 1) {
      console.error(`--self-test expected exactly the planted failure, got ${failures.length}.`)
      for (const failure of failures) console.error(failure)
      return 1
    }
    console.log(`ok — ${CHECKS.length} checks pass and the planted failure is reported`)
    return 0
  }
  if (failures.length > 0) {
    console.error('')
    console.error('SOURCE-STATE CHECKER SELF-TEST FAILED (P2.255) — the gate itself has been narrowed.')
    console.error('')
    for (const failure of failures) console.error(failure)
    console.error('')
    console.error('  These are the CHECKER\'s invariants, asserted here because their proper test')
    console.error('  (src/harness/source-state-contract.test.ts) rides root `bun test`, which no lane')
    console.error('  runs in an implementation loop. Fix the derivation, not this file.')
    console.error('')
    return 1
  }
  console.log(`source-state checker self-test: ${CHECKS.length} checks pass`)
  return 0
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
