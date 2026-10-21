/**
 * P6.135: the close-time keep-or-remove card is DRAWABLE, and it asks the
 * question the page asks.
 *
 * `worktrees.md#clean-up-worktrees` frames the close of a worktree session as
 * *"Claude prompts you to keep or remove the worktree. Keeping preserves the
 * directory and branch so you can return later"*. The generic permission card's
 * Allow/Deny pair reads as the wrong question for that: "Deny" is not a refusal
 * here, it is the SAFE half. So `worktree_cleanup` gets its own labels, loses
 * Always Allow — an "always remove" would be a standing instruction to delete
 * directories — and loses the destructive tone on the half that destroys
 * nothing.
 *
 * Pinned rather than reasoned about, for `WorktreeApprovalPermission.test.tsx`'s
 * reason: a prompt type the renderer cannot draw is a dead approval, one type
 * over.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRequest as PermissionRequestType } from '../../../../shared/types'
import { PermissionRequest } from '../input/structured/PermissionRequest'
import en from '@nessy-agent/shared/i18n/locales/en.json'

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n
    .use(initReactI18next)
    .init({
      lng: 'en',
      fallbackLng: 'en',
      // The REAL locale file, so a key that exists in the component and not in
      // `en.json` fails here instead of rendering its own name.
      resources: { en: { translation: en as Record<string, string> } },
      interpolation: { escapeValue: false },
    })
}, 20_000)

function render(request: PermissionRequestType): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={testI18n}>
      <PermissionRequest request={request} onResponse={() => {}} />
    </I18nextProvider>
  )
}

/** What the host publishes when a session closes holding a worktree. */
const cleanupRequest = {
  requestId: 'worktree-cleanup-1',
  toolName: 'WorktreeCleanup',
  description:
    'This chat is closing while it still holds the worktree at /repo/.nessy-worktrees/proj/w,'
    + ' on branch `nessy/session-1/lease`. Remove it, or keep it for later?',
  impact: 'The worktree still has uncommitted or untracked changes.',
  type: 'worktree_cleanup',
} as PermissionRequestType

describe('P6.135 · the close-time keep-or-remove card', () => {
  it('asks keep or remove, not allow or deny', () => {
    const html = render(cleanupRequest)

    expect(html).toContain('Remove worktree')
    expect(html).toContain('Keep worktree')
    // The generic labels are the failure this row exists to avoid.
    expect(html).not.toContain('>Allow<')
    expect(html).not.toContain('>Deny<')
  })

  it('names the worktree, the branch and the work removal would delete', () => {
    const html = render(cleanupRequest)

    expect(html).toContain('/repo/.nessy-worktrees/proj/w')
    // The branch is the handle on the work; a card without it names a directory
    // the user never chose and gives them no way back to what is in it.
    expect(html).toContain('nessy/session-1/lease')
    expect(html).toContain('uncommitted or untracked changes')
  })

  it('offers no Always Allow, and says what each answer keeps', () => {
    const html = render(cleanupRequest)

    expect(html).not.toContain('Always Allow')
    expect(html).toContain('the branch stays')
  })

  it('CONTROL — the shared card is unchanged for an ordinary prompt', () => {
    // The boundary pair: the relabelling is specific to this type, not a
    // regression in the card every other approval draws.
    const html = render({
      requestId: 'pi-bash-1',
      toolName: 'Bash',
      command: 'npm run build',
      description: 'Execute: npm run build',
      type: 'bash',
      rememberForMinutes: 10,
    } as PermissionRequestType)

    expect(html).toContain('Allow')
    expect(html).toContain('Deny')
    expect(html).toContain('Always Allow')
    expect(html).not.toContain('Keep worktree')
  })
})
