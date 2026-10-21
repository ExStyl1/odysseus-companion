/**
 * ESLint config for `@nessy-agent/server` — see `../../eslint.config.base.mjs`
 * for why every workspace package now has one.
 *
 * Wired into the root `lint` as `lint:server`.
 *
 * Measured under the base rule set at the commit that added this file:
 * 5 files linted, **0 errors**. No rule is switched off here.
 */

import { nessyPackageConfig } from '../../eslint.config.base.mjs'

export default nessyPackageConfig()
