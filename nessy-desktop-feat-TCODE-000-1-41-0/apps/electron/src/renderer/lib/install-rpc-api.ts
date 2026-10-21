/**
 * Publish `window.electronAPI` — wrapped, in the MAIN world.
 *
 * Side-effecting on purpose, and it must be main.tsx's FIRST import: ES module
 * bodies run before the importer's own statements, so an install written as a
 * statement in main.tsx would run AFTER every transitively imported module had
 * already had a chance to read the global.
 *
 * The preload exposes the raw surface as `__nessyRpcRaw` rather than as
 * `electronAPI`, because a contextBridge global is non-writable,
 * non-configurable and frozen — measured, not assumed — so the wrapper could
 * not otherwise be the object product code reaches. 610 call sites read
 * `window.electronAPI` directly and none of them binds it at module scope,
 * which is what makes publishing it here safe.
 */

import { wrapElectronApi } from './rpc-error-rehydration'

declare global {
  interface Window {
    __nessyRpcRaw?: Record<string, unknown>
  }
}

const raw = window.__nessyRpcRaw

if (raw) {
  Object.defineProperty(window, 'electronAPI', {
    value: wrapElectronApi(raw),
    writable: false,
    configurable: false,
    enumerable: true,
  })
} else if (!window.electronAPI) {
  // Neither surface is present: a renderer running without this preload (the
  // playground installs its own mock). Say so once rather than let the first
  // call fail with `undefined is not an object`.
  console.error('[rpc] no preload API found: neither window.__nessyRpcRaw nor window.electronAPI is defined')
}

export {}
