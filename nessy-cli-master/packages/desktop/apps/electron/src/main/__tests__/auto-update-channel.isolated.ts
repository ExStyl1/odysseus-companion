import { describe, expect, it, mock } from 'bun:test'

const updater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  _channel: null as string | null,
  get channel(): string | null {
    return this._channel
  },
  set channel(value: string | null) {
    this._channel = value
    this.allowDowngrade = true
  },
  allowPrerelease: true,
  allowDowngrade: true,
  logger: null as unknown,
  on: () => updater,
}

mock.module('electron-updater', () => ({
  autoUpdater: updater,
}))

mock.module('electron', () => ({
  app: {
    isPackaged: false,
    getName: () => 'Nessy CLI Desktop',
    getPath: () => '',
    getAppPath: () => '',
  },
  net: { fetch: () => Promise.reject(new Error('unexpected fetch')) },
}))

mock.module('../logger', () => ({
  mainLog: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}))

mock.module('../notifications', () => ({
  showUpdateNotification: () => {},
}))

describe('auto-update channel', () => {
  it('always checks the stable feed without allowing downgrades', async () => {
    await import('../auto-update')

    expect(updater.channel).toBe('latest')
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })
})
