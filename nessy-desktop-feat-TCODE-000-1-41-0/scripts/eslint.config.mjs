/**
 * ESLint Configuration for `scripts/`
 *
 * Uses flat config format (ESLint 9+).
 *
 * Until this file existed, `bun run lint` was
 * `lint:electron && lint:shared && lint:ui` — so `scripts/` was outside the
 * lint gate entirely, including the repo's own guards
 * (`check-coverage-map.ts`, `ios-wire-enum-parity.ts`, `check-i18n-parity.ts`,
 * `ipc-inventory.ts`). The directory holding our checks was the one directory
 * our checks did not cover.
 *
 * Wired into the root `lint` as `lint:scripts`.
 *
 * Rule policy: house style here is a curated set of high-signal rules rather
 * than a `recommended` preset (see `packages/shared/eslint.config.mjs` and
 * `apps/electron/eslint.config.mjs`). Every rule below is at `error` and the
 * directory is clean under it — a rule kept at `warn` does not fail `lint`
 * and therefore does not gate anything.
 */

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'

export default [
  {
    ignores: [
      'node_modules/**',
      'cdp/fixtures/**',
    ],
  },

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    linterOptions: {
      // P2.229. ESLint 9 defaults this to `warn`, and a warning does not fail
      // `lint` — the same argument this file already makes for keeping every
      // rule at `error`, applied to the directives that switch those rules off.
      // This directory has ZERO eslint directives today, so the line changes no
      // current output; it is the check that fails the FIRST waiver written
      // against a rule this config does not enable. That matters more here than
      // most places: this is the directory holding the repo's own guards, and
      // an inert rule reads exactly like a clean directory — the lesson the
      // `no-restricted-syntax` note below was written for. Verified live by
      // planting a bogus directive and watching `lint:scripts` go red; without
      // this line the same plant is a warning and the step passes.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Possible problems — logic that is provably wrong without type info.
      // `no-cond-assign` stays at its default `except-parens`: the
      // parenthesized `while ((m = re.exec(s)) !== null)` in build-server.ts
      // is the idiomatic form, not a mistake.
      'no-cond-assign': 'error',
      'no-constant-binary-expression': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-promise-executor-return': 'error',
      'no-self-compare': 'error',
      'no-sparse-arrays': 'error',
      'no-unreachable-loop': 'error',
      'no-unsafe-negation': 'error',
      'no-useless-backreference': 'error',
      'valid-typeof': 'error',

      // Two rules were evaluated over this directory and NOT adopted, because
      // every hit was measured and every hit was a false positive. Named by
      // SYMBOL, never by line (the line anchors this comment carried drifted
      // within weeks — F1.261); the counts are a reading with a date, so
      // re-measure rather than trust them:
      //   eslint --rule '{"no-unmodified-loop-condition":"error",
      //                   "no-template-curly-in-string":"error"}' .
      //   * `no-unmodified-loop-condition` — 7 hits on 2026-09-23 (4 when
      //     first evaluated), every one the same shape: a `while (<flag>)`
      //     loop inside an async IIFE whose flag is cleared by the enclosing
      //     function or by a sibling `stop` closure after an await. In
      //     `cdp/lib/ask-user.ts`: `answerAskUserWhile` and
      //     `approvePermissionsWhile` (their returned `stop`); in `cdp/cases/`:
      //     `mcp-w2.ts`'s `approvePermissionsWhile`,
      //     `session-tool-wire-parity.ts`'s `watchPermissionCards`,
      //     `rs-86.ts`'s `answerHookCardsWhile`, and the `watcher` loops of
      //     `nca-6.ts` and `rs-103.ts`. The rule cannot see through the
      //     closure.
      //   * `no-template-curly-in-string` — 12 hits on 2026-09-23 (1 when
      //     first evaluated), every one a `${...}` inside a string that IS
      //     source text: a line of a PROGRAM a test writes to disk (the
      //     `networkProbe` in `run-pi-harness-offline.test.ts`) or a fixture
      //     a scanner test feeds its scanner / a `toContain` needle over a
      //     source file (`cdp/harness.test.ts`, the `check-*.test.ts` gates,
      //     `gate-safety.test.ts`, `ts-comment-scan.test.ts`). The
      //     interpolation is meant to be literal there.

      // A script in this directory runs with the developer's own filesystem
      // rights and no confirmation prompt. An agent working in this repo
      // destroyed unrecoverable data by handing a real home directory to a
      // destructive verb, so a delete whose operand IS `homedir()`,
      // `tmpdir()` or `process.env.*` is refused here outright: a removal
      // target must be a path the script derived and validated, never the
      // ambient root itself.
      //
      // Both spellings are covered (`rmSync(...)` imported from `node:fs` and
      // `fs.rmSync(...)`) — the first version of this selector only matched
      // the member form and therefore matched nothing in this directory,
      // where every call site imports the bare function. An inert rule reads
      // exactly like a clean directory. Positive control for both selectors is
      // in `bun-test-lock.test.ts`.
      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression:matches([callee.name=/^rm(dir)?(Sync)?$/], [callee.property.name=/^rm(dir)?(Sync)?$/]) > CallExpression[callee.name=/^(homedir|tmpdir)$/]",
          message: 'A delete in scripts/ must not take homedir()/tmpdir() itself as its target. Derive a specific subdirectory, validate it, and delete that.',
        },
        {
          selector: "CallExpression:matches([callee.name=/^rm(dir)?(Sync)?$/], [callee.property.name=/^rm(dir)?(Sync)?$/]) > MemberExpression[object.object.name='process'][object.property.name='env']",
          message: 'A delete in scripts/ must not take a raw process.env value as its target. Resolve it, validate it against a fixed root, and delete that.',
        },
        {
          // `rmSync(process.env.HOME!)` parses as TSNonNullExpression wrapping
          // the member expression, so the two selectors above walk past it.
          // Measured: without this entry the `!` spelling lints clean.
          selector: "CallExpression:matches([callee.name=/^rm(dir)?(Sync)?$/], [callee.property.name=/^rm(dir)?(Sync)?$/]) > TSNonNullExpression > :matches(CallExpression[callee.name=/^(homedir|tmpdir)$/], MemberExpression[object.object.name='process'][object.property.name='env'])",
          message: 'A delete in scripts/ must not take homedir()/tmpdir()/process.env as its target, non-null assertion included.',
        },
      ],
    },
  },
]
