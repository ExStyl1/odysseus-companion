/**
 * Shared ESLint base for every workspace package — flat config (ESLint 9+).
 *
 * P2.319 — why this file exists.
 *
 * `packages/server-core` got a config in P2.88 and `scripts/` got one before
 * that, each written by hand because someone happened to notice the package was
 * unlinted. P2.319 stopped noticing and enumerated: of the 15 workspace packages
 * (a directory under `packages/*` or `apps/*` with a `package.json`), **11 had
 * no `eslint.config.*` at all**. In those 11, ESLint was not merely unrun but
 * unrunnable — `npx eslint .` exits 2 with "ESLint couldn't find an
 * eslint.config.(js|mjs|cjs) file" and, with `--format json`, writes a
 * zero-byte report that reads exactly like a clean one.
 *
 * The mechanism, which is the actual defect: **a package added without a lint
 * config is silently exempt forever, because nothing fails when a config is
 * absent.** A package with no config and a package that lints clean are
 * indistinguishable from the outside — which is how this grew from 1 to 2 to 11
 * with nobody seeing it. Configs alone only reset that clock, so P2.319 also
 * adds `scripts/check-eslint-coverage.ts`, wired into the root `lint` and
 * `validate:ci`: a new workspace package now fails the gate until it has a
 * config and a `lint:<pkg>` entry in the root chain.
 *
 * Rule policy, inherited from `packages/server-core/eslint.config.mjs` and
 * `scripts/eslint.config.mjs`: a curated set of high-signal correctness rules
 * rather than a `recommended` preset, every one at `error`. A rule kept at
 * `warn` does not fail `lint` and therefore does not gate anything.
 *
 * P2.319 was scoped to configuration ONLY. Where a package is not clean under a
 * base rule, the rule is switched off **in that package's own config with its
 * measured hit count recorded next to it**, so the backlog is a written number
 * with a follow-up row rather than a silent exemption. Fixing those hits is
 * deliberately not part of this change: it would mix a mechanical config diff
 * with a pile of judgement calls.
 */

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'

/**
 * The curated correctness set. Identical to the rules `packages/server-core`
 * adopted in P2.88, which are themselves a superset of `scripts/`'s list minus
 * that directory's package-specific `no-restricted-syntax` selectors.
 *
 * `no-promise-executor-return` is deliberately NOT here: it was measured at 95
 * hits in server-core, effectively all of them the
 * `await new Promise(resolve => setTimeout(resolve, ms))` idiom, and it is just
 * as common in the packages this base now covers.
 */
export const NESSY_CORRECTNESS_RULES = {
  // ---- Possible problems: logic that is provably wrong without type info.
  'no-cond-assign': 'error',
  'no-constant-binary-expression': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-self-compare': 'error',
  'no-sparse-arrays': 'error',
  'no-unreachable-loop': 'error',
  'no-unsafe-negation': 'error',
  'no-useless-backreference': 'error',
  'valid-typeof': 'error',

  // ---- Further correctness rules.
  'array-callback-return': 'error',
  'getter-return': 'error',
  'no-async-promise-executor': 'error',
  'no-class-assign': 'error',
  'no-compare-neg-zero': 'error',
  'no-const-assign': 'error',
  'no-debugger': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-keys': 'error',
  'no-ex-assign': 'error',
  'no-fallthrough': 'error',
  'no-func-assign': 'error',
  'no-import-assign': 'error',
  'no-invalid-regexp': 'error',
  'no-irregular-whitespace': 'error',
  'no-loss-of-precision': 'error',
  'no-misleading-character-class': 'error',
  'no-new-native-nonconstructor': 'error',
  'no-obj-calls': 'error',
  'no-setter-return': 'error',
  'no-unexpected-multiline': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-with': 'error',
  'require-yield': 'error',
  'use-isnan': 'error',

  // An empty `catch {}` is house style for fire-and-forget observer callbacks
  // that must not break their caller; an empty `if`/`try`/loop body is not.
  'no-empty': ['error', { allowEmptyCatch: true }],

  // Most packages here are ESM (`"type": "module"`). A `require()` in one is a
  // deliberate exception and must say so at the call site. CommonJS packages
  // switch this off in their own config.
  '@typescript-eslint/no-require-imports': 'error',
}

/**
 * Directories no package should ever lint. Build output and dependencies only —
 * `generated/` and `vendor/` are NOT here, because "we did not write it" is a
 * decision each package states for itself with a reason.
 */
export const NESSY_BASE_IGNORES = [
  'node_modules/**',
  'dist/**',
  'build/**',
]

/**
 * Build a package's flat config from the shared base.
 *
 * @param {object} [options]
 * @param {string[]} [options.files]   Glob(s) to lint. Default `['**\/*.ts']`.
 * @param {string[]} [options.ignores] Extra ignores on top of `NESSY_BASE_IGNORES`.
 * @param {boolean}  [options.jsx]     Enable JSX parsing (`.tsx` packages).
 * @param {object}   [options.rules]   Per-package overrides. Every `'off'` here
 *                                     MUST carry its measured hit count.
 * @param {'error'|'off'} [options.reportUnusedDisableDirectives]
 *   `error` by default: an `eslint-disable` naming a rule the config does not
 *   enable is a decoration, not a waiver, and two such fossils were found by
 *   P2.319 in packages that had never been linted.
 */
export function nessyPackageConfig(options = {}) {
  const {
    files = ['**/*.ts'],
    ignores = [],
    jsx = false,
    rules = {},
    reportUnusedDisableDirectives = 'error',
  } = options

  return [
    { ignores: [...NESSY_BASE_IGNORES, ...ignores] },
    {
      files,
      languageOptions: {
        parser: tsParser,
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
          ...(jsx ? { ecmaFeatures: { jsx: true } } : {}),
        },
      },
      plugins: {
        '@typescript-eslint': tsPlugin,
      },
      linterOptions: {
        reportUnusedDisableDirectives,
      },
      rules: {
        ...NESSY_CORRECTNESS_RULES,
        ...rules,
      },
    },
  ]
}
