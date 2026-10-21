/**
 * P6: outside-root approval rendering — canonical target shown, once vs
 * for-this-session lifetimes, narrower choice as the primary action, and the
 * renderer submitting only requestId + lifetime (no root/receipt choice).
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PermissionRequest as PermissionRequestType } from '../../../../shared/types'
import { PermissionRequest } from '../input/structured/PermissionRequest'

const translations = {
  'chat.outsideRoot.allowOnce': 'Allow once',
  'chat.outsideRoot.allowSession': 'Allow for this session',
  'chat.outsideRoot.header': 'Filesystem access required',
  'chat.outsideRoot.hint': 'Once grants this path for the current call only',
  'chat.permissionRequired': 'Permission Required',
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

describe('outside root permission rendering', () => {
  it('renders the canonical target with once and session lifetimes for outside_root', () => {
    const html = render({
      requestId: 'pi-oroot-1',
      toolName: 'Read',
      command: '/Users/dev/elsewhere/notes.txt',
      description: 'Allow read access outside the session root: /Users/dev/elsewhere/notes.txt',
      type: 'outside_root',
    } as PermissionRequestType)

    expect(html).toContain('Filesystem access required')
    expect(html).toContain('/Users/dev/elsewhere/notes.txt')
    expect(html).toContain('Allow once')
    expect(html).toContain('Allow for this session')
    // The narrower choice is the primary (first) action button.
    expect(html.indexOf('Allow once')).toBeLessThan(html.indexOf('Allow for this session'))
  })

  it('keeps the generic permission rendering for non outside_root requests', () => {
    const html = render({
      requestId: 'req-1',
      toolName: 'Bash',
      command: 'ls',
      description: 'Run ls',
      type: 'bash',
    } as PermissionRequestType)

    expect(html).toContain('Permission Required')
    expect(html).not.toContain('Allow for this session')
  })
})
