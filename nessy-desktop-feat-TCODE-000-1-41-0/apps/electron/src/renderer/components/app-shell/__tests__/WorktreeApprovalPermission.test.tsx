/**
 * R2: the worktree approval floor's prompt is DRAWABLE and approvable.
 *
 * The floor used to be minted as `promptType: 'admin_approval'`, which routed it
 * to the macOS-elevation card and, worse, through the privileged-execution
 * broker, where a command-less request failed closed — Approve did nothing. It
 * now carries its own `worktree_approval` type, which `ChatDisplay` maps to the
 * ordinary permission card (no `admin_approval`/`workflow_launch` special case
 * matches it), so this pins the card that type actually renders: the question is
 * shown, Allow and Deny are offered, and Always Allow is NOT — worktrees.md:
 * "An `EnterWorktree` permission rule or choosing 'don't ask again' doesn't
 * suppress this prompt; only `bypassPermissions` mode skips it."
 *
 * A prompt type the renderer cannot draw is the same dead approval, one type
 * over, so this is asserted rather than reasoned about.
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
  'chat.permissionRemember.repository': 'Remembered for this repository',
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

/** What the host publishes for the floor: no command, no remember fields. */
const floorRequest = {
  requestId: 'pi-worktree-1',
  toolName: 'EnterWorktree',
  description:
    "Enter the worktree at /somewhere/else? It is outside this repository's worktree directory, "
    + "so the session's working directory, write access and project config all move there.",
  type: 'worktree_approval',
  noAlwaysAllow: true,
} as PermissionRequestType

describe('worktree approval floor rendering', () => {
  it('draws the permission card with the question and both answers', () => {
    const html = render(floorRequest)

    expect(html).toContain('Permission Required')
    expect(html).toContain('EnterWorktree')
    expect(html).toContain('/somewhere/else')
    // Both answers reachable — the whole point of R2.
    expect(html).toContain('Allow')
    expect(html).toContain('Deny')
  })

  it('offers no Always Allow, because the floor has no don\'t-ask-again', () => {
    const html = render(floorRequest)

    expect(html).not.toContain('Always Allow')
    expect(html).toContain('This approval covers this action only')
  })

  it('still offers Always Allow for an ordinary rememberable prompt', () => {
    // The boundary pair: the hidden button is specific to the floor, not a
    // regression in the shared card.
    const html = render({
      requestId: 'pi-bash-1',
      toolName: 'Bash',
      command: 'npm run build',
      description: 'Execute: npm run build',
      type: 'bash',
      rememberForMinutes: 10,
      commandHash: 'hash-npm-run-build',
    } as PermissionRequestType)

    expect(html).toContain('Always Allow')
  })
})
