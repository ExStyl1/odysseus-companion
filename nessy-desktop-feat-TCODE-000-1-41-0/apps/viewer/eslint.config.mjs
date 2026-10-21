/**
 * ESLint config for `@nessy-agent/viewer` — see `../../eslint.config.base.mjs`
 * for why every workspace package now has one.
 *
 * Wired into the root `lint` as `lint:viewer`.
 *
 * This app is dormant (see `AGENTS.md` §Monorepo Map). It is linted anyway:
 * "dormant" is a statement about attention, not about whether the code is in
 * the tree, and an unlinted dormant app is how a package stays exempt after it
 * wakes up.
 *
 * Measured under the base rule set at the commit that added this file:
 * 8 files linted, **0 errors**. No rule is switched off here.
 */

import { nessyPackageConfig } from '../../eslint.config.base.mjs'

export default nessyPackageConfig({
  files: ['**/*.{ts,tsx}'],
  jsx: true,
})
