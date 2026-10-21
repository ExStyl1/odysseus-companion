/**
 * ESLint Configuration for `packages/server-core`
 *
 * Uses flat config format (ESLint 9+).
 *
 * P2.88 — why this file exists. Until it did, `packages/server-core` had no
 * ESLint config AND was absent from the root `lint` script
 * (`lint:electron && lint:shared && lint:ui && lint:scripts`), so the package
 * holding `SessionManager`, the RPC handlers, the transport and the whole
 * pi-harness was outside the lint gate entirely. Every brief in the parity plan
 * that asked for "an eslint gate on server-core" was therefore asking for
 * nothing, and the absence was invisible because a package with no config and a
 * package that lints clean are indistinguishable from the outside.
 *
 * The absence had already left a fossil: `src/transport/client.ts:355` carries
 *   // eslint-disable-next-line @typescript-eslint/no-require-imports
 * — the ONLY eslint directive in the package's 370 TypeScript files, silencing a
 * rule that had never been enabled here. It has been inert since it was written.
 * `@typescript-eslint/no-require-imports` is adopted below partly so that
 * directive means something again, and `reportUnusedDisableDirectives` is raised
 * to `error` so the next inert directive is loud instead of decorative.
 *
 * Wired into the root `lint` as `lint:server-core`, which `.gitlab-ci.yml`'s
 * `lint` job runs via `bun run lint` on every branch and merge request.
 *
 * Rule policy: house style is a curated set of high-signal rules rather than a
 * `recommended` preset (see `scripts/eslint.config.mjs`,
 * `packages/shared/eslint.config.mjs` and `apps/electron/eslint.config.mjs`).
 * Every rule below is at `error` and this package is clean under it — a rule
 * kept at `warn` does not fail `lint` and therefore does not gate anything.
 *
 * The §"Measured and NOT adopted" block at the bottom is part of the contract:
 * each entry was run over this package, its hits were read, and the reason it is
 * absent is recorded with them. Re-running any of them is the way to check
 * whether the reason still holds.
 */

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
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
      // An eslint-disable naming a rule this config does not enable is not a
      // waiver, it is a decoration — see `client.ts:355` above, inert for as
      // long as it has existed. Make the next one fail the gate.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // ---- Possible problems: logic that is provably wrong without type info.
      // These eleven are the set `scripts/eslint.config.mjs` adopted; ten of
      // them are clean over this package too (the eleventh,
      // `no-promise-executor-return`, is in the not-adopted block below).
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

      // ---- Further correctness rules, each measured at zero hits here.
      // A zero-hit rule is not an idle rule: it is the one that will fail the
      // gate the first time this package grows the mistake.
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

      // An empty `catch {}` is deliberate house style at four sites here, all of
      // them the same shape — a fire-and-forget observer callback that must not
      // break its caller: `pi-harness/child-session-service.ts:635`,
      // `pi-harness/process-supervisor.ts:322`, `pi-harness/task-service.ts:75`
      // and `pi-harness/worktree-lease-service.ts:531`. An empty `if`/`try`/loop
      // body is NOT house style, so the rule stays on with only catch exempted
      // rather than being switched off.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // This package is ESM (`"type": "module"`). A `require()` here is always a
      // deliberate exception and must say so at the call site; three sites carry
      // a directive with a reason, and `client.ts:355`'s pre-existing one is now
      // live rather than inert.
      '@typescript-eslint/no-require-imports': 'error',
    },
  },

  // ---- Measured and NOT adopted -------------------------------------------
  //
  // Each rule below was run over this package with the same parser and its hits
  // were read. None is disabled blind; the count and the reason are the record.
  //
  //  * `no-promise-executor-return` — 95 hits. 93 are the idiom
  //    `await new Promise(resolve => setTimeout(resolve, ms))`, where the concise
  //    arrow body "returns" the timer handle; the value is discarded and the
  //    pattern appears in ~40 files. The remaining two
  //    (`sessions/SessionManager.ts:6039` and `:6322`) are
  //    `if (signal.aborted) return abort()` early-outs where `abort()` is void.
  //    Adopting the rule means rewriting 95 call sites for no defect found, so
  //    it is deferred to a row that owns that churn rather than smuggled into
  //    the commit that creates this file. `scripts/` adopts it and is clean
  //    there; that directory simply does not use the idiom.
  //
  //  * `no-template-curly-in-string` — 13 hits, every one a literal `${...}` a
  //    test means literally: plugin-root placeholders that the harness expands
  //    (`SessionManager.plugin-monitors.test.ts:79,100,137,141`,
  //    `SessionManager.process-supervisor.test.ts:845,846`), `${DOCS_TOKEN}` and
  //    `${__dirname}` fixtures (`capabilities.test.ts:717,1144`,
  //    `marketplace.test.ts:118`), a `Keep ${HOME} literal.` assertion
  //    (`sessions.custom-slash-command.test.ts:88,122,129`) and one line of a
  //    program written to disk (`process-supervisor-auto-background.test.ts:34`).
  //    `scripts/` measured and rejected this rule for the same reason.
  //
  //  * `no-unmodified-loop-condition` — 1 hit
  //    (`pi-harness/process-supervisor.test.ts:1241`), the closure false positive
  //    `scripts/` already documented: the flag is cleared by a sibling callback
  //    the rule cannot see through.
  //
  //  * `no-control-regex` — 3 hits, all three the rule's canonical false
  //    positive: a sanitizer whose whole job is stripping control characters
  //    (`handlers/utils.ts:35`, `pi-harness/goal-service.ts:427`,
  //    `sessions/SessionManager.ts:2249`).
  //
  //  * `no-useless-escape` — 6 hits, all on the single line
  //    `pi-harness/process-supervisor.test.ts:131`: a `node -e` program passed as
  //    a string, where the escaping mirrors the JSON the child prints.
  //
  //  * `@typescript-eslint/no-unsafe-function-type` — 3 hits, all bare `Function`
  //    in test doubles (`handlers/rpc/sessions.pi-runtime.test.ts:7,12`,
  //    `sessions/worktree-setup-wire.test.ts:320`).
  //
  //  * `no-case-declarations` — 3 hits, all inside the one `case 'typed_error':`
  //    arm of SessionManager's event switch
  //    (`sessions/SessionManager.ts:24203,24217,24226`). The fix is to brace that
  //    arm, which is a diff in a 24k-line file and belongs to a row that owns it.
  //
  //  * `@typescript-eslint/no-non-null-asserted-optional-chain` — 1 hit,
  //    `sessions/SessionManager.ts:19624`:
  //    `model ?? wsConfig?.defaults?.model ?? sessionConn?.defaultModel!`.
  //    This is not a style hit. If `sessionConn` is undefined the expression is
  //    `undefined` at runtime while the type says `string`, and the value is
  //    handed straight to `agent.setModel(...)`. Adopting the rule here would
  //    force either `(sessionConn?.defaultModel)!` — which relocates the lie
  //    without removing it — or a behaviour change in model fallback. Both need
  //    their own row, so the rule waits for that row rather than being satisfied
  //    cosmetically.
  //
  //  * `@typescript-eslint/no-unused-vars` — **172 hits across 28 files.** The
  //    reason stands and is re-verified: no config in this repo enables the rule,
  //    so adopting it here alone would make server-core the strictest package by
  //    accident. The COUNT did not. This entry read "40 hits" until P2.229, and
  //    40 is not what the rule gives in the form every other entry here takes —
  //    a bare `'error'`. It is what an underscore-ignoring variant gives:
  //      ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_',
  //                  caughtErrorsIgnorePattern: '^_' }]   -> 41 across 17 files
  //    Neither the option set nor its effect was recorded, so a reader following
  //    this block's own instruction — re-run it to check whether the reason still
  //    holds — got 4.3x the written number and no way to tell a drifted package
  //    from a differently-configured measurement. Both readings are kept for
  //    exactly that reason. The gap is one directory of stubs: 87 of the 172 are
  //    `src/runtime/null-browser-pane-manager.ts`, whose `_`-prefixed parameters
  //    are deliberate, then 25 in `sessions/SessionManager.ts` and 15 in
  //    `sessions/RemoteBrowserPaneManager.ts`. Whichever row adopts this rule
  //    picks the option set first; the two numbers above are what each costs.
  //
  //  * a `no-restricted-syntax` selector for the P2.106 vacuity class —
  //    `expect(<optional chain>).toBeUndefined()`, which holds whether or not the
  //    subject exists — 28 hits across 13 files, measured with
  //      selector: "CallExpression[callee.property.name='toBeUndefined']
  //                 [callee.object.callee.name='expect']
  //                 [callee.object.arguments.0.type='ChainExpression']"
  //    The selector is correct (the P2.106 line it was written for is gone from
  //    the hit list now that the row fixed it, and `turn-terminal-reason.test.ts`
  //    :168 is the same shape still present). Adopting it means auditing 28
  //    assertions one at a time — each is either genuinely vacuous or needs an
  //    existence check first, and neither verdict can be reached mechanically.
  //    That audit is a row of its own; this comment is the measurement it starts
  //    from.
]
