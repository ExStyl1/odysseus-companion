/**
 * ESLint config for `@nessy-agent/webui` — see `../../eslint.config.base.mjs`
 * for why every workspace package now has one.
 *
 * Wired into the root `lint` as `lint:webui`.
 *
 * This app is dormant (see `AGENTS.md` §Monorepo Map) and is linted anyway, for
 * the reason given in `apps/viewer/eslint.config.mjs`.
 *
 * P2.476 removed this file's only deviation from the base, and the deviation is
 * worth a note for what it was rather than for what it cost. P2.319 switched
 * `reportUnusedDisableDirectives` off for `src/shims/ws.ts`, which carried a
 * file-wide `eslint-disable` naming `@typescript-eslint/no-unused-vars` — a rule
 * no config in this repo enables — and the block closed with "Follow-up row:
 * delete the directive, then delete this block", addressed to a row nobody ever
 * wrote. So the file held a written instruction that nothing tracked, and the
 * fossil was invisible to the exact gate the block described. Both halves had to
 * go together: the directive alone leaves an exemption for nothing, the
 * exemption alone turns a warning into a gate failure.
 *
 * Measured inert before deleting it, in the form that leaves no alternate
 * configuration: `eslint --print-config src/shims/ws.ts` reported
 * `@typescript-eslint/no-unused-vars` ABSENT, with `no-require-imports` and
 * `no-self-compare` reading `error` in the same output as the controls proving
 * the reading is real; the rule name appears in no `rules` block repo-wide, no
 * `.eslintrc*` exists anywhere, and no `package.json` carries an `eslintConfig`
 * key.
 *
 * Measured under the base rule set at the commit that removed the exemption:
 * 11 files linted, **0 errors**, 0 warnings. No rule is switched off here.
 */

import { nessyPackageConfig } from '../../eslint.config.base.mjs'

export default nessyPackageConfig({ files: ['**/*.{ts,tsx}'], jsx: true })
