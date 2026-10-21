import { describe, expect, it } from 'bun:test'
import {
  showStorageReadinessBlockedDialog,
  type StorageReadinessDialogOptions,
} from '../storage-readiness-ui.ts'

interface Harness {
  dialogs: StorageReadinessDialogOptions[]
  opened: string[]
  quitCalls: number
  deps: Parameters<typeof showStorageReadinessBlockedDialog>[1]
}

function harness(responses: number[], locale = 'en-US'): Harness {
  const dialogs: StorageReadinessDialogOptions[] = []
  const opened: string[] = []
  let quitCalls = 0

  return {
    dialogs,
    opened,
    get quitCalls() {
      return quitCalls
    },
    deps: {
      configDir: '/safe/.nessy-agent',
      dialog: {
        async showMessageBox(options) {
          dialogs.push(options)
          return { response: responses.shift() ?? -1 }
        },
      },
      shell: {
        async openPath(path) {
          opened.push(path)
          return ''
        },
      },
      app: {
        getLocale: () => locale,
        quit: () => {
          quitCalls += 1
        },
      },
    },
  }
}

describe('storage readiness blocked UI', () => {
  it('returns retry and exposes only the three safe actions', async () => {
    const h = harness([0])

    await expect(showStorageReadinessBlockedDialog({ code: 'corrupt-v2' }, h.deps)).resolves.toBe('retry')

    expect(h.dialogs).toHaveLength(1)
    expect(h.dialogs[0]?.buttons).toEqual(['Retry', 'Open diagnostics', 'Quit'])
    expect(h.dialogs[0]?.detail).toContain('/safe/.nessy-agent')
    expect(h.opened).toEqual([])
    expect(h.quitCalls).toBe(0)
  })

  it('opens an allowlisted marker path, then presents the blocked gate again', async () => {
    const h = harness([1, 0], 'ru-RU')
    const marker = '/safe/.nessy-agent.cutover-v2.json'

    await expect(showStorageReadinessBlockedDialog({ code: 'invalid-marker', diagnosticPath: marker }, h.deps)).resolves.toBe('retry')

    expect(h.opened).toEqual([marker])
    expect(h.dialogs).toHaveLength(2)
    expect(h.dialogs[0]?.buttons).toEqual(['Повторить', 'Открыть диагностику', 'Выйти'])
  })

  it('quits on Quit or a dismissed dialog', async () => {
    for (const response of [2, -1]) {
      const h = harness([response])
      await expect(showStorageReadinessBlockedDialog({ code: 'unsafe-root' }, h.deps)).resolves.toBe('quit')
      expect(h.quitCalls).toBe(1)
      expect(h.opened).toEqual([])
    }
  })

  it('accepts only canonical quarantine paths', async () => {
    const h = harness([1, 0])
    const quarantine = '/safe/.nessy-agent.legacy-v1.123e4567-e89b-42d3-a456-426614174000'

    await showStorageReadinessBlockedDialog({ code: 'path-collision', diagnosticPath: quarantine }, h.deps)

    expect(h.opened).toEqual([quarantine])
  })

  it('sanitizes unknown codes and secret or staging paths', async () => {
    const h = harness([1, 2])
    const secretPath = '/tmp/token-sk-secret/.nessy-agent.v2-staging.123e4567-e89b-42d3-a456-426614174000'

    await expect(showStorageReadinessBlockedDialog({ code: 'token=sk-secret', diagnosticPath: secretPath }, h.deps)).resolves.toBe('quit')

    expect(h.opened).toEqual(['/safe/.nessy-agent'])
    const serialized = JSON.stringify(h.dialogs)
    expect(serialized).not.toContain('sk-secret')
    expect(serialized).not.toContain('/tmp/token')
    expect(serialized).not.toContain('v2-staging')
  })
})
