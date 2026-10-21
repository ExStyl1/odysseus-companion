/**
 * ESLint config for `@nessy-agent/cli` — see `../../eslint.config.base.mjs`
 * for why every workspace package now has one.
 *
 * Wired into the root `lint` as `lint:cli`.
 *
 * Measured under the base rule set at the commit that added this file:
 * 11 files linted, **1 error**, and it was a false positive — see below.
 * Effective backlog after the documented option below: **0 errors**.
 */

import { nessyPackageConfig } from '../../eslint.config.base.mjs'

export default nessyPackageConfig({
  rules: {
    // `no-fallthrough` fired once, at `src/plugin.ts:139`:
    //
    //     case 'list':
    //     // `:1097` — "`ls` as a shorthand for `list`".
    //     case 'ls':
    //       return runList(options)
    //
    // An empty case label falling into the next one is the idiomatic way to
    // spell an alias and the rule normally allows it — but ESLint's default
    // `allowEmptyCase: false` treats a case carrying only a COMMENT as
    // non-empty, so the explanatory comment is what makes this report. There is
    // no fallthrough of statements here.
    //
    // The option is narrowed rather than the rule disabled: a case with actual
    // statements and no `break` still errors, which is the defect the rule
    // exists for. This is the only hit in the package.
    'no-fallthrough': ['error', { allowEmptyCase: true }],
  },
})
