/**
 * ESLint config for `@nessy-agent/session-mcp-server` — see
 * `../../eslint.config.base.mjs` for why every workspace package now has one.
 *
 * Wired into the root `lint` as `lint:session-mcp-server`.
 *
 * This package is the one CommonJS workspace (`package.json` has no
 * `"type": "module"`), so the base's `@typescript-eslint/no-require-imports` is
 * a rule about a different module system here. It is left ON regardless,
 * because measured, this package has **zero** `require()` call sites — the rule
 * is not a burden, it is the thing that will speak up the first time somebody
 * adds one on the assumption that CJS makes it free.
 *
 * Measured under the base rule set at the commit that added this file:
 * 8 files linted, **0 errors**. No rule is switched off here.
 */

import { nessyPackageConfig } from '../../eslint.config.base.mjs'

export default nessyPackageConfig()
