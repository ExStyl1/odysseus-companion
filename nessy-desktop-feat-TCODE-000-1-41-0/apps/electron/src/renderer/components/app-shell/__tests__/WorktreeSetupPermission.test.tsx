/**
 * P3.30: the setup-script consent card is the ORDINARY permission card, and it
 * tells the truth about what "Always Allow" does.
 *
 * Two ways this goes wrong silently:
 *
 *  - `worktree_setup` reusing `workflow_launch`'s prompt string. That string is
 *    a ROUTE (`ChatDisplay`'s `structuredInput`), not a style: it draws the
 *    workflow card — a workflow name and a phase list — so the user would be
 *    approving a description of something entirely different from the shell
 *    command about to run. Its own type falls through to this card, the same
 *    way `worktree_approval` already does, so this pins what that fallthrough
 *    actually draws.
 *  - The remember scope. The host writes a DURABLE, per-script, per-repository
 *    record on Always (`SessionManager.respondToPermission` ->
 *    `worktreeSetupConsent.remember`). The card's default line promises "for
 *    the session", which would understate what the click does — an approval the
 *    user believes expires with the session but that outlives every restart.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRequest as PermissionRequestType } from '../../../../shared/types'
import { PermissionRequest } from '../input/structured/PermissionRequest'

const translations = {
  'chat.permissionRequired': 'Permission Required',
  'chat.permissionAllow': 'Allow', // UA12.209 — the answers read keys now
  'chat.permissionAlwaysAllow': 'Always Allow',
  'chat.permissionDeny': 'Deny',
  'chat.permissionRemember.never': 'This approval covers this action only',
  'chat.permissionRemember.session': 'Remembered for this session',
  'chat.permissionRemember.repository': 'Saved for this repository',
}

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n
    .use(initReactI18next)
    .init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: translations } },
      interpolation: { escapeValue: false },
    })
})

function render(request: PermissionRequestType): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <PermissionRequest request={request} onResponse={() => {}} />
    </I18nextProvider>
  )
}

/** What the host publishes for a setup script (see `createWorktreeSetupPort`). */
const setupRequest = {
  requestId: 'pi-worktree-setup-1',
  toolName: 'WorktreeSetup',
  command: 'bun install',
  description:
    'Run this worktree setup script in /repos/.nessy-worktrees/app/lease-1?\n\nbun install\n\n'
    + 'It is declared by `worktree.setupScript` in your Nessy settings and runs as a shell'
    + ' command inside the new worktree, with whatever access this session already has.',
  type: 'worktree_setup',
} as PermissionRequestType

describe('worktree setup script consent card', () => {
  it('draws the ordinary permission card with the script, both answers, and a rememberable Always', () => {
    const html = render(setupRequest)

    expect(html).toContain('Permission Required')
    expect(html).toContain('WorktreeSetup')
    // The actual string that will be executed, and where.
    expect(html).toContain('bun install')
    expect(html).toContain('/repos/.nessy-worktrees/app/lease-1')
    expect(html).toContain('worktree.setupScript')
    expect(html).toContain('Allow')
    expect(html).toContain('Deny')
    // Remember-able, unlike the EnterWorktree floor.
    expect(html).toContain('Always Allow')
    // …and durable, which is what the host actually records.
    expect(html).toContain('Saved for this repository')
    expect(html).not.toContain('Remembered for this session')
  })

  it('does not widen the durable promise to every other prompt', () => {
    // The boundary: a file_write approval really does last only for the
    // session, so the repository line must stay specific to the two prompts
    // whose Always is written to disk.
    const html = render({
      requestId: 'pi-write-1',
      toolName: 'Write',
      description: 'Write to src/index.ts',
      type: 'file_write',
    } as PermissionRequestType)

    expect(html).toContain('Always Allow')
    expect(html).toContain('Remembered for this session')
    expect(html).not.toContain('Saved for this repository')
  })
})
