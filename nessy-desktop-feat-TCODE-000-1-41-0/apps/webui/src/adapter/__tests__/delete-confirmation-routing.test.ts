/**
 * UA12.49 — the dormant web surface's delete confirmation rides the SAME wire
 * as the Electron app's.
 *
 * UA3.8 gave `showDeleteSessionConfirmation(name, sessionId)` its second
 * argument so the HOST can name the task folder the delete removes — composed
 * server-side (`auth:showDeleteSessionConfirmation` reads
 * `taskFolderDeletedWith`) and delivered to the client as a
 * `CLIENT_CONFIRM_DIALOG` request. The webui adapter answered with a LOCAL
 * override taking `(name)` only, so its `window.confirm` could never name the
 * folder; and the server could not even ask this client directly, because the
 * webui neither advertised nor answered `CLIENT_CONFIRM_DIALOG`.
 *
 * The fix removes the local override — the channel-bound CHANNEL_MAP member
 * (the exact one the Electron renderer calls) passes `(name, sessionId)` to
 * the server handler — and the webui client advertises and answers
 * `CLIENT_CONFIRM_DIALOG` through `browserConfirmDialogResponse`.
 *
 * Two halves, because either alone passes on the bug (the D1.282 reading
 * applies verbatim): the browser answer's BEHAVIOUR over a stubbed
 * `window.confirm`, and the adapter's own composition read from source (the
 * adapter cannot be imported here — its module body reaches for
 * `window.matchMedia`, `i18next` and a WebSocket client).
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { browserConfirmDialogResponse } from '../confirm-dialog'

const ADAPTER_SOURCE = readFileSync(join(import.meta.dir, '..', 'web-api.ts'), 'utf-8')

describe('UA12.49 — the webui delete confirmation rides the electron wire', () => {
  it('no local showDeleteSessionConfirmation override intercepts the call', () => {
    // RED at HEAD: webOverrides carried
    // `showDeleteSessionConfirmation: (name: string) => …window.confirm(i18n.t('dialog.deleteSessionConfirmation', { name }))`
    // — a member that never saw the sessionId and could never name a folder.
    expect(ADAPTER_SOURCE).not.toMatch(/showDeleteSessionConfirmation\s*:/)
  })

  it('the client advertises CLIENT_CONFIRM_DIALOG so the server may ask it', () => {
    // The server's invokeClient refuses a capability the handshake did not
    // advertise ("Client lacks capability"), so the constructor option is load-
    // bearing, not decorative.
    expect(ADAPTER_SOURCE).toMatch(/clientCapabilities:\s*\[CLIENT_CONFIRM_DIALOG\]/)
  })

  it('the client answers CLIENT_CONFIRM_DIALOG with the browser confirm', () => {
    expect(ADAPTER_SOURCE).toMatch(/handleCapability\(CLIENT_CONFIRM_DIALOG/)
  })

  it('the answered constant is the one the electron preload answers too', () => {
    // One fact, one source: the constant comes from the same export the
    // preload's native answerer imports, so a server-side dialog change cannot
    // fork the two surfaces.
    expect(ADAPTER_SOURCE).toContain("from '@nessy-agent/server-core/transport'")
  })
})

describe('browserConfirmDialogResponse', () => {
  let confirmText: string | undefined
  let answer: boolean

  beforeEach(() => {
    confirmText = undefined
    ;(globalThis as any).window = {
      confirm: (text: string) => {
        confirmText = text
        return answer
      },
    }
  })

  afterEach(() => {
    delete (globalThis as any).window
  })

  it('shows the server-composed text — title, message, and the detail naming the task folder', () => {
    answer = true
    const result = browserConfirmDialogResponse({
      type: 'warning',
      title: 'Delete conversation',
      message: 'Are you sure you want to delete "My Chat"?',
      detail: 'The task folder tasks/my-slug/ will also be removed.\n\nThis cannot be undone.',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
    })
    expect(confirmText).toContain('delete "My Chat"?')
    expect(confirmText).toContain('tasks/my-slug/')
    expect(confirmText).toContain('This cannot be undone.')
    expect(result).toEqual({ response: 1 })
  })

  it('cancel answers response 0 — the cancelId both existing server specs pin', () => {
    answer = false
    const result = browserConfirmDialogResponse({
      type: 'warning',
      title: 'Delete conversation',
      message: 'Are you sure you want to delete "My Chat"?',
      buttons: ['Cancel', 'Delete'],
      defaultId: 0,
      cancelId: 0,
    })
    expect(result).toEqual({ response: 0 })
  })
})
