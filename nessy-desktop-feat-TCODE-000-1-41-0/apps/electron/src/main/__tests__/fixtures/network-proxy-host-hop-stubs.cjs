/**
 * F1.498 — the three Electron-only modules `network-proxy.ts` reaches, stubbed so
 * the PRODUCT's Node half can run in a plain Node / Electron-as-Node child.
 *
 * The test bundles `fixtures/network-proxy-host-hop-child.ts` with the Electron
 * main's own esbuild flags and aliases `electron`, `electron-log/main` and
 * `electron-updater/out/electronHttpExecutor` to this one file. What each alias
 * needs from it:
 *
 * - `electron`: `app.isReady()` answers FALSE, so `configureElectronProxy`
 *   returns before touching a Chromium session. The Node half — the global undici
 *   dispatcher the main process's `fetch` uses, and the only half F1.498 is about
 *   — is untouched.
 * - `electron-log/main`: `logger.ts` configures transports and scopes at import;
 *   every access answers a no-op, and `warn`/`error` go to stderr so a failing
 *   arm shows the product's own `[proxy] …` line.
 * - `electron-updater`: `session-partitions.ts` reads one constant.
 */
'use strict'

const noop = new Proxy(function noopStub() {}, {
  get: (_target, prop) => (prop === 'then' ? undefined : noop),
  apply: () => noop,
  set: () => true,
})

const toStderr = (level) => (...args) => {
  process.stderr.write(`[stub-log ${level}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`)
}

const log = new Proxy({}, {
  get: (_target, prop) => {
    if (prop === 'warn' || prop === 'error') return toStderr(prop)
    if (prop === 'scope') return () => log
    if (prop === '__esModule') return false
    if (prop === 'default') return log
    return noop
  },
  set: () => true,
})

const known = {
  // electron
  app: { isReady: () => false, isPackaged: false, getPath: () => process.env.HOME, getVersion: () => '0.0.0-f1498', on: () => {} },
  session: noop,
  net: noop,
  // electron-updater/out/electronHttpExecutor
  NET_SESSION_NAME: 'electron-updater',
}

module.exports = new Proxy(known, {
  get: (target, prop) => (prop in target ? target[prop] : log[prop]),
})
