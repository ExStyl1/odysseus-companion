/**
 * ESLint Configuration for Shared Package
 *
 * Uses flat config format (ESLint 9+).
 * Includes custom rules for enforcing best practices in shared code.
 *
 * ## P2.480 — this package now adopts the shared base
 *
 * It did not until now, and the consequence was not cosmetic: measured with
 * ESLint's own `--print-config`, this config resolved to **3 rules** (the three
 * `nessy-shared/*` ones below) where a base adopter resolves to **38**. So the
 * repo's LARGEST package — 1455 files under `src/**` — was its least checked,
 * and every green `lint:shared` in this plan meant *three rules passed*. The
 * row that found it recorded 2; the third arrived with P2.86 between the
 * measurement and this fix, which is the ordinary fate of a number written in
 * prose.
 *
 * ## The damage was measured BEFORE adopting, not discovered after
 *
 * The base's 38 rules were run over this package in a throwaway config, at load
 * 17, 1455 files linted, zero parse failures:
 *
 * | Rule | Hits | Files |
 * | --- | --- | --- |
 * | `@typescript-eslint/no-require-imports` | 18 | 10 |
 * | `require-yield` | 16 | 11 |
 * | `no-irregular-whitespace` | 11 | 9 |
 * | `no-fallthrough` | 2 | 2 |
 * | `no-constant-binary-expression` | 2 | 1 |
 * | `no-self-compare` | 1 | 1 |
 *
 * **50 errors over 33 files — and 32 of the 38 rules are clean today.** That is
 * the number the row asked for and it is far smaller than the row feared, which
 * is exactly why it was worth measuring rather than staging blind. The six above
 * are switched off below **with their counts**, which is the base's own written
 * policy for a rule a package is not clean under; the other 32 are ON from this
 * commit.
 *
 * Fixing the 50 is deliberately NOT part of this change. Half of them sit in
 * files other lanes hold right now, and mixing a mechanical config diff with 50
 * judgement calls is the move the base's own header warns against.
 *
 * **No base rule was found inapplicable to this package.** The base describes a
 * CommonJS exemption for `no-require-imports`; this package is
 * `"type": "module"`, so that carve-out is not the reason here — the reason is a
 * measured 18 deliberate lazy requires, and it is written at the rule.
 */

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import { NESSY_BASE_IGNORES, NESSY_CORRECTNESS_RULES } from '../../eslint.config.base.mjs'
import noDirectOpenImport from './eslint-rules/no-direct-open-import.cjs'
import noInlineSourceAuthCheck from './eslint-rules/no-inline-source-auth-check.cjs'
import noHandRolledTranscriptOpener from './eslint-rules/no-hand-rolled-transcript-opener.cjs'

export default [
  // Ignore patterns
  {
    ignores: [
      ...NESSY_BASE_IGNORES,
      '*.cjs',
      'eslint-rules/**',
    ],
  },

  // TypeScript files
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      // Custom plugin for shared package rules
      'nessy-shared': {
        rules: {
          'no-direct-open-import': noDirectOpenImport,
          'no-inline-source-auth-check': noInlineSourceAuthCheck,
          'no-hand-rolled-transcript-opener': noHandRolledTranscriptOpener,
        },
      },
    },
    linterOptions: {
      // P2.229. ESLint 9 defaults this to `warn`, and a warning does not fail
      // `lint` — so until this line existed the package carried FOUR inert
      // directives that the gate reported on every run and nobody had to act
      // on. All four named rules no config in this repo has ever enabled, which
      // is the same fossil class P2.88 found in `server-core` and P2.319 found
      // in `core` and `webui`; `error` is what makes the next one cost
      // something. The four, deleted with this change:
      //   * `agent/session-scoped-tools.ts:232,272` and `i18n/setupI18n.ts:23`
      //     — `@typescript-eslint/no-explicit-any`, enabled in zero configs
      //     here. The prose at `session-scoped-tools.ts:269-271` explaining the
      //     Zod variance `as any` stays; only the fake waiver went.
      //   * `utils/debug.ts:41` — `@typescript-eslint/no-var-requires`. That
      //     rule still SHIPS in the installed @typescript-eslint/eslint-plugin
      //     8.61.1, but its metadata carries `deprecated` and
      //     `replacedBy: ['@typescript-eslint/no-require-imports']`. It read
      //     like a live waiver for the `require('electron-log/main')` beneath
      //     it and was nothing of the kind: this package enables NEITHER
      //     spelling. The reason that call is a `require` at all is stated at
      //     the call site.
      //
      // P2.477 then asked the question that fossil invites — adopt the current
      // spelling here? — and the answer is NOT YET. It is written down because
      // it looks like renaming a string and is not.
      //
      // The rule is not unwanted; the repo has already chosen it.
      // `no-require-imports` is `'error'` in `eslint.config.base.mjs`'s
      // NESSY_CORRECTNESS_RULES and live in 12 of the 16 workspace configs, and
      // this package is `"type": "module"`, so it is not the CommonJS exemption
      // the base describes. What blocks it is THIS config: it adopted none of
      // the base. `eslint --print-config src/utils/debug.ts` resolves to **2
      // rules** — the two `nessy-shared/*` rules below — where a base adopter
      // resolves to 38. Switching one base rule on here would hand the largest
      // package in the repo (1374 linted files) a three-rule config wearing a
      // curated-correctness badge it has not earned. The row that actually
      // closes this is "packages/shared adopts the base", 36 rules over those
      // 1374 files, and that is a different and larger decision.
      //
      // The cost was also overstated, and correcting it is half the point of
      // recording this. This block said **25 `require(` call sites**. Measured
      // by enabling the rule in a throwaway config and counting what it
      // reports: **16 sites across 10 files** — 12 in 7 production files, 4 in
      // 3 test files. 25 is a `require(` grep count, and NINE of those 25 sit
      // inside string literals (`node -e` payloads and fixture source text)
      // that no linter reads as a require; a disjoint 12 `createRequire(`
      // occurrences are not flagged either. Of the real 16, the production ones
      // are deliberate lazy requires breaking import cycles
      // (`require('./storage.ts')` inside a function body) plus this file's
      // optional-dependency probe — so adopting the rule buys 16 waivers or 16
      // refactors, and the base's own comment endorses the waiver route.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // P2.480 — the shared curated correctness set, 38 rules, every one at
      // `error`. Six are switched back off immediately below with the hit count
      // that bought the exemption; the other 32 are live from this commit.
      ...NESSY_CORRECTNESS_RULES,

      // ── Measured and NOT YET adopted (P2.480) ─────────────────────────────
      // Each line carries the count the throwaway-config run reported over
      // `src/**/*.ts`, so the backlog is a written number rather than a silent
      // exemption, and re-running the rule is how to check whether it still
      // holds. Turning any one of them on is a follow-up with real edits behind
      // it, not a config change.

      // 18 hits / 10 files. NOT the base's CommonJS carve-out — this package is
      // `"type": "module"`. They are deliberate lazy `require()`s inside function
      // bodies breaking import cycles (`require('./storage.ts')` and friends),
      // plus `utils/debug.ts`'s optional-dependency probe. P2.477 measured the
      // production/test split at 12/4 with the rule enabled, against a `require(`
      // GREP of 25 — nine of which sit inside string literals no linter reads as
      // code. Adopting buys 18 waivers or 18 refactors; the base's own comment
      // endorses the waiver route, and each would need its reason at the site.
      '@typescript-eslint/no-require-imports': 'off',

      // 16 hits / 11 files, ALL of them `__tests__`: `async function*` fakes
      // that stand in for a streaming agent turn and return without yielding.
      // Every one is a rig, so this is the cheapest of the six to close — and
      // it is still 16 files two other lanes are editing this week.
      'require-yield': 'off',

      // 11 hits / 9 files. Non-ASCII whitespace, and the ones in
      // `pi-harness/gitignore-glob.ts` and `plugins/source-resolver.ts` are
      // FIXTURE data — a rule about a character class cannot tell a stray
      // non-breaking space from a deliberately exotic path being matched, so
      // this one needs reading rather than sweeping.
      'no-irregular-whitespace': 'off',

      // 2 hits / 2 files (`automations/utils.ts`, `plugins/presentation.ts`).
      // A missing `break` is either a bug or an intended fallthrough needing a
      // comment; both are edits in files this lane does not hold.
      'no-fallthrough': 'off',

      // 2 hits / 1 file and 1 hit / 1 file, and they are the SAME line —
      // `sessions/__tests__/persistence-queue.test.ts:90`. Two independent rules
      // pointing at one expression is the strongest signal in this table that
      // something there is worth reading; it is the first of the six to look at.
      'no-constant-binary-expression': 'off',
      'no-self-compare': 'off',

      // ── This package's own rules ──────────────────────────────────────────
      // Prevent direct imports of 'open' package — use openUrl() from utils instead
      'nessy-shared/no-direct-open-import': 'error',
      // Prevent inline source.config.isAuthenticated checks — use isSourceUsable() instead
      'nessy-shared/no-inline-source-auth-check': 'error',
      // P2.86 — prevent a hand-rolled `User: ` opener, which skips the defang
      // that `renderTranscriptEntry` applies to the body. The seam's own commit
      // claimed this "physically cannot" happen while `utils/title-generator.ts`
      // was doing it; a rule is what makes the claim true rather than hopeful.
      'nessy-shared/no-hand-rolled-transcript-opener': 'error',
    },
  },
]
