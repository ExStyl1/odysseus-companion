/**
 * ESLint config for `@nessy-agent/codex-responses-adapter` — see
 * `../../eslint.config.base.mjs` for why every workspace package now has one.
 *
 * Wired into the root `lint` as `lint:codex-responses-adapter`.
 *
 * P2.319 named this package specifically: it holds the security-path config
 * writer and 14 test files, and until this file existed not one of them had ever
 * been linted. Any earlier report of "eslint clean" for this package is
 * retroactively NOT-RUN — `npx eslint .` exited 2 here with "couldn't find an
 * eslint.config file".
 *
 * `scripts/reliability-probe.mjs` is included deliberately; `vendor/opencodex`
 * carries no source, so it needs no ignore.
 *
 * Measured under the base rule set at the commit that added this file:
 * 31 files linted, **0 errors**. No rule is switched off here.
 */

import { nessyPackageConfig } from '../../eslint.config.base.mjs'

export default nessyPackageConfig({
  files: ['**/*.ts', '**/*.mjs'],
})
