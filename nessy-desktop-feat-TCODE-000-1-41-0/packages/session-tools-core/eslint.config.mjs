/**
 * ESLint config for `@nessy-agent/session-tools-core` — see
 * `../../eslint.config.base.mjs` for why every workspace package now has one.
 *
 * Wired into the root `lint` as `lint:session-tools-core`.
 *
 * Measured under the base rule set at the commit that added this file:
 * 96 files linted, **2 errors**, listed below.
 */

import { nessyPackageConfig } from '../../eslint.config.base.mjs'

export default [
  ...nessyPackageConfig(),

  // ---- P2.319 backlog: 2 errors, not fixed here ---------------------------
  //
  // `@typescript-eslint/no-require-imports`, two call sites in a package whose
  // `package.json` says `"type": "module"`:
  //
  //   * `src/context.ts:938` — `const fs = require('node:fs')` inside
  //     `createNodeFileSystem()`, i.e. PRODUCTION code, under a comment that
  //     reads "Dynamic import to work in both environments". Under a bundler or
  //     Bun this resolves; under plain Node ESM `require` is not defined in a
  //     module scope. This is the one hit here that may be a live defect rather
  //     than a style point, and it wants a reader who can decide between
  //     `createRequire`, a top-level `import`, and leaving it alone.
  //   * `src/handlers/source-manage.test.ts:34` — the same call inside a test
  //     double's `loadSourceConfig`.
  //
  // (Nine further `require(` occurrences in this package are inside string
  // literals — programs the sandbox tests write out and execute in a child:
  // one in `handlers/script-sandbox.test.ts`, eight in
  // `handlers/transform-data.test.ts`. The rule correctly ignores them; they
  // are noted so that `rg -ao 'require\(' src | wc -l` reporting 11 does not
  // read as a discrepancy against the 2 errors above.)
  //
  // Both fixes are source edits, so they are out of scope for a
  // configuration-only change. The rule is switched off for those TWO FILES
  // rather than the package, so a third `require()` added anywhere else here
  // still fails the gate.
  //
  // Follow-up row: resolve both call sites, then delete this block.
  {
    files: ['src/context.ts', 'src/handlers/source-manage.test.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
]
