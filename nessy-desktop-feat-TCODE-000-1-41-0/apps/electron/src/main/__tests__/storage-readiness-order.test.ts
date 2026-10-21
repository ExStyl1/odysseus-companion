import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

function position(needle: string): number {
  const index = source.indexOf(needle)
  expect(index, `missing source anchor: ${needle}`).toBeGreaterThanOrEqual(0)
  return index
}

describe('electron storage readiness order', () => {
  it('holds the single-instance lease and verifies v2 before normal consumers', () => {
    const lock = position('const gotTheLock = app.requestSingleInstanceLock()')
    const whenReady = position('app.whenReady().then(async () => {')
    const readiness = position('const readiness = await ensureStorageLayoutV2({')
    const readinessComplete = position('// User-owned config may be read only after verified-v2 readiness.')

    expect(lock).toBeLessThan(whenReady)
    expect(whenReady).toBeLessThan(readiness)

    for (const consumer of [
      'const persistedUiLanguage = getPersistedUiLanguage()',
      'initializeBackendHostRuntime({',
      'initializeDocs()',
      'windowManager = new WindowManager(',
      'storageRuntime = await createStorageRuntime(verifiedStorageLayout,',
      'const instance = await bootstrapServer<SessionManager, HandlerDeps>({',
      'await createInitialWindows()',
    ]) {
      expect(position(consumer)).toBeGreaterThan(readinessComplete)
    }
  })

  it('keeps blocked startup inside Retry/Open diagnostics/Quit and reuses the exact layout', () => {
    const blockedDialog = position('const action = await showStorageReadinessBlockedDialog(readiness, {')
    const quit = position("if (action === 'quit') return")
    const readinessComplete = position('// User-owned config may be read only after verified-v2 readiness.')

    expect(blockedDialog).toBeLessThan(quit)
    expect(quit).toBeLessThan(readinessComplete)
    expect(source).toContain('createStorageRuntime(verifiedStorageLayout,')
    expect(source).toContain('verifiedStorageLayout,\n        serverToken,')
    expect(source).not.toContain('continue-old-layout')
  })

  it('ends a windowless startup failure loudly instead of leaving the promise unhandled', () => {
    // The 2026-08-21 hang: the whenReady callback is async, so its rejection
    // reached only `process.on('unhandledRejection')` — which logs nowhere in a
    // packaged build (electron-log's transports are off) and returns, leaving a
    // process with no window that `window-all-closed` never quits.
    const bootPromise = position('const bootPromise = app.whenReady().then(async () => {')
    const bootCatch = position('bootPromise.catch(error => {')
    const reported = position("reportBootFatalIfWindowless('app-startup', error)")

    expect(bootPromise).toBeLessThan(bootCatch)
    expect(bootCatch).toBeLessThan(reported)

    // The initialization catch used to `app.quit()` — exit 0, and silent.
    expect(source).toContain("if (!reportBootFatalIfWindowless('app-initialization', error)) app.quit()")
    // And a blocked readiness result had no diagnostic at all.
    expect(source).toContain('bootDiagnostic(formatBootBlockedLogLine({ code: readiness.code, configDir: CONFIG_DIR }))')
    // `bootCompleted` is what keeps the surface scoped to a windowless startup.
    expect(position('bootCompleted = true')).toBeGreaterThan(position('await createInitialWindows()'))
    // `app.exit()` alone leaves a windowless startup idling in the run loop.
    expect(source).toContain("hardExit: () => { process.kill(process.pid, 'SIGKILL') },")
  })

  it('passes the packaged host runtime into both storage compositions', () => {
    const hosts = source.match(/pluginRuntimeHost: \{[^}]+\}/g) ?? []
    expect(hosts).toHaveLength(2)
    for (const host of hosts) {
      expect(host).toContain('appRootPath: platform.appRootPath')
      expect(host).toContain('resourcesPath: platform.resourcesPath')
      expect(host).toContain('platform: process.platform')
    }
  })
})
