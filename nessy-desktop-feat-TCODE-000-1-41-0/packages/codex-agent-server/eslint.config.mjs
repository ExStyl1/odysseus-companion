/**
 * ESLint config for `@nessy-agent/codex-agent-server` — see
 * `../../eslint.config.base.mjs` for why every workspace package now has one.
 *
 * Wired into the root `lint` as `lint:codex-agent-server`.
 *
 * `evals/run.mjs` is included deliberately: it is the package's only non-`.ts`
 * source and was outside every gate in the repo before this file existed.
 *
 * Measured under the base rule set at the commit that added this file:
 * 15 files linted, **0 errors**. No rule is switched off here.
 *
 * **Re-measured 2026-09-01 (P2.233): 21 files, 0 errors, 0 warnings.** The count
 * above was correct when written and is not any more — a count in a comment is a
 * reading with a date, and this block's own contract is that re-running it is how
 * you check it (P2.229 found the sibling number in `server-core`'s config off by
 * 4.3x for the same reason). Read the number the gate prints, not this one.
 *
 * **Which half of D1.1's split this gate sits in.** The lint rules themselves
 * run on `lint:codex-agent-server`, a step of the chain a lane runs at a wave
 * boundary; the PROOF that they gate — the planted violation and its control —
 * was a one-off measurement recorded below and is not re-run by anything. So
 * this package's protection is boundary-time on one side and a dated reading on
 * the other, and neither is loop-time. That is the trade D1.1 states as policy
 * rather than leaving to be inferred: see
 * `packages/pi-agent-server/scripts/check-surface-selftest.ts` §"The SPLIT is
 * the policy" for the guarantee it rests on.
 *
 * ## The proof the row owed, and the premise in it that had gone stale
 *
 * P2.233 opened because this package had no eslint config, no tsconfig, no
 * scripts and no place in `typecheck:all` — the only gate reaching it was
 * another package's typecheck, transitively, which is how a live error in it
 * swallowed other lanes' messages for an afternoon. All of that landed before
 * this note: `9f4f15d31` wrote this file and `lint:codex-agent-server`,
 * `7d6541aeb` wrote the tsconfig, the package `typecheck` script and the
 * `typecheck:codex-agent-server` chain step. What nobody had done is the thing
 * the row said it owed — plant a violation and watch the chain.
 *
 * Done 2026-09-01 in a disposable worktree, one plant tripping both gates
 * (`const x: number = 'not a number'` for the compiler, an `n === n` self-compare
 * for `no-self-compare`, which the base set carries):
 *
 *   - `bun run lint` → `lint:codex-agent-server FAIL (exit 1)`, named in the
 *     verdict line, with the seven steps AFTER it still run;
 *   - `bun run typecheck:all` → `typecheck:codex-agent-server FAIL (exit 2)`,
 *     attributed to `packages/codex-agent-server/tsconfig.json`.
 *
 * The row's phrasing — *show the chain STOPS there* — is what had gone stale.
 * P2.222 replaced both `&&` chains with `run-gates`, so a red step no longer
 * stops anything; every step runs and the verdict names all the reds. Restored by
 * writing the captured file back and asserting SHA-256 returned to 2be9dc20.
 *
 * The control matters as much as the kill: on the same rig with the plant
 * removed, `typecheck:codex-agent-server` is the ONE step whose verdict changes.
 */

import { nessyPackageConfig } from '../../eslint.config.base.mjs'

export default nessyPackageConfig({
  files: ['**/*.ts', '**/*.mjs'],
})
