/**
 * ESLint config for `@nessy-agent/pi-agent-server` — see
 * `../../eslint.config.base.mjs` for why every workspace package now has one.
 *
 * Wired into the root `lint` as `lint:pi-agent-server`.
 *
 * P2.319 (and P2.309 before it) named this package first: it wraps the Pi
 * subprocess, so its failures are the hardest to see from the app, and it is
 * also the package `typecheck:all` never covers for tests (a 567-error backlog,
 * re-measured 2026-08-21). It was the least statically-checked package in the
 * repo. Any earlier report of "eslint clean" for this package is retroactively
 * NOT-RUN — `npx eslint .` exited 2 here with "couldn't find an eslint.config
 * file".
 *
 * `dist/` is ignored by the base; it is a build artefact this package ships.
 *
 * Measured under the base rule set at the commit that added this file:
 * 153 files linted, **0 errors**. No rule is switched off here.
 */

import { nessyPackageConfig } from '../../eslint.config.base.mjs'

export default nessyPackageConfig()
