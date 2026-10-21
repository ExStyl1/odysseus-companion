/**
 * ESLint config for `@nessy-agent/codex-protocol` — see
 * `../../eslint.config.base.mjs` for why every workspace package now has one.
 *
 * Wired into the root `lint` as `lint:codex-protocol`.
 *
 * Every TypeScript file in this package lives under `generated/` (655 of them,
 * all git-tracked). They are NOT ignored. "A machine wrote it" is a reason to
 * read the hits carefully, not a reason to stop looking: a correctness rule
 * firing in generated output is a bug in the generator, and nothing else in the
 * repo would surface it.
 *
 * Measured under the base rule set at the commit that added this file:
 * 656 files linted, **0 errors**. No rule is switched off here.
 */

import { nessyPackageConfig } from '../../eslint.config.base.mjs'

export default nessyPackageConfig()
