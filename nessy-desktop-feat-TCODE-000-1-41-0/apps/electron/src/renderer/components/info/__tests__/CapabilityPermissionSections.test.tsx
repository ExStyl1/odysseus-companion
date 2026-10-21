/**
 * U2 kind-specific permission sections (renderer).
 *
 * CapabilityPermissionModesSection (skill) + CapabilityPermissionsSection
 * (source): both render their table when the projection is present, and a quiet
 * in-section placeholder when it is absent (U1 placeholder-not-hidden). Also
 * pins the additive-compatibility invariant: a SafeCapabilityDetail WITHOUT the
 * optional permissionModes/permissions fields renders the placeholder rather
 * than throwing — legacy details stay valid.
 */

import * as React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createInstance, type i18n as I18nInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SafeCapabilityDetail } from '@nessy-agent/shared/protocol/capabilities'
// The concrete modules, never the `@/components/info` BARREL: the barrel reaches
// Info_Markdown, which imports `pdfjs-dist/build/pdf.worker.min.mjs?url`, and
// bun's runner cannot load a `?url` import — it throws
// `Missing 'default' export`, the module graph never finishes, and every render
// in the SAME bun process returns "" from there on. That is what turned one
// broken import into 15 red tests in CI across four unrelated files.
import { CapabilityPermissionModesSection } from '@/components/info/CapabilityPermissionModesSection'
import { CapabilityPermissionsSection } from '@/components/info/CapabilityPermissionsSection'

const KEYS = [
  'skillInfo.permissionModes', 'skillInfo.permissionModesDesc',
  'skillInfo.behaviorBlocked', 'skillInfo.behaviorAllowed', 'skillInfo.behaviorNeutral',
  'mode.auto', 'mode.default', 'mode.acceptEdits', 'mode.plan', 'mode.bypassPermissions',
  'sourceInfo.permissions', 'table.access', 'table.pattern',
  'table.statusAllowed', 'table.statusBlocked', 'table.noPermissionsConfigured',
  'capabilityDetail.noPermissionModes',
]

let testI18n: I18nInstance

beforeAll(async () => {
  testI18n = createInstance()
  await testI18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: Object.fromEntries(KEYS.map((k) => [k, k])) } },
    interpolation: { escapeValue: false },
  })
})

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<I18nextProvider i18n={testI18n}>{node}</I18nextProvider>)
}

// F1.1052: what the server projects — the real mode ids, in the picker's order.
const modes: NonNullable<SafeCapabilityDetail['permissionModes']> = [
  { mode: 'auto', behavior: 'allowed' },
  { mode: 'default', behavior: 'allowed' },
  { mode: 'acceptEdits', behavior: 'allowed' },
  { mode: 'plan', behavior: 'blocked' },
  { mode: 'bypassPermissions', behavior: 'neutral' },
]

const permissions: NonNullable<SafeCapabilityDetail['permissions']> = [
  { pattern: 'GET /issues', access: 'allowed' },
  { pattern: 'mcp__x__delete_.*', access: 'blocked' },
]

describe('CapabilityPermissionModesSection', () => {
  it('renders a row per mode with our mode labels when alwaysAllow is present', () => {
    const html = render(<CapabilityPermissionModesSection modes={modes} />)
    expect(html).toContain('skillInfo.permissionModes')
    // F1.1052: each row is named by the composer's own `mode.*` key, in the order sent.
    const labels = ['mode.auto', 'mode.default', 'mode.acceptEdits', 'mode.plan', 'mode.bypassPermissions']
    const at = labels.map(label => html.indexOf(`>${label}<`))
    expect(at.every(index => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(html).toContain('skillInfo.behaviorBlocked')
    expect(html).toContain('skillInfo.behaviorNeutral')
    expect(html).toContain('data-testid="permission-mode-plan"')
    expect(html).not.toContain('permission-modes-empty')
  })

  it('F1.1052 BOUNDARY: an id this client does not know shows raw, not as a missing mode key', () => {
    const html = render(<CapabilityPermissionModesSection modes={[{ mode: 'explore', behavior: 'blocked' }]} />)
    expect(html).toContain('>explore<')
    expect(html).not.toContain('mode.explore')
    expect(html).toContain('skillInfo.behaviorBlocked')
  })

  it('renders an in-section placeholder when no modes are projected', () => {
    const html = render(<CapabilityPermissionModesSection modes={undefined} />)
    // Section title still renders (not hidden).
    expect(html).toContain('skillInfo.permissionModes')
    expect(html).toContain('data-testid="permission-modes-empty"')
    expect(html).toContain('capabilityDetail.noPermissionModes')
  })
})

describe('CapabilityPermissionsSection', () => {
  it('renders pattern/access rows when permissions are projected', () => {
    const html = render(<CapabilityPermissionsSection permissions={permissions} />)
    expect(html).toContain('sourceInfo.permissions')
    expect(html).toContain('table.access')
    expect(html).toContain('table.pattern')
    expect(html).toContain('GET /issues')
    expect(html).toContain('mcp__x__delete_.*')
    // Access badges resolve to allowed/blocked labels.
    expect(html).toContain('table.statusAllowed')
    expect(html).toContain('table.statusBlocked')
    expect(html).not.toContain('permissions-empty')
  })

  it('renders an in-section placeholder when no permissions are projected', () => {
    const html = render(<CapabilityPermissionsSection permissions={[]} />)
    expect(html).toContain('sourceInfo.permissions')
    expect(html).toContain('data-testid="permissions-empty"')
    expect(html).toContain('table.noPermissionsConfigured')
  })
})

describe('additive compatibility', () => {
  it('a legacy detail without the optional fields drives the placeholder, not a throw', () => {
    // Legacy shape: no permissionModes / permissions keys at all.
    const legacy: SafeCapabilityDetail = {
      summary: {
        key: 'skill:legacy', kind: 'skill', logicalName: 'legacy', origin: 'native',
        scope: { kind: 'workspace', workspaceId: 'ws' }, state: 'active', readOnly: false,
        trustState: 'not-required', credentialState: 'not-required',
        selectedAsUnqualifiedAlias: true, diagnosticCodes: [],
      },
      safeFields: [],
      resources: [],
    }
    expect(() => render(<CapabilityPermissionModesSection modes={legacy.permissionModes} />)).not.toThrow()
    expect(() => render(<CapabilityPermissionsSection permissions={legacy.permissions} />)).not.toThrow()
    expect(render(<CapabilityPermissionModesSection modes={legacy.permissionModes} />)).toContain('permission-modes-empty')
    expect(render(<CapabilityPermissionsSection permissions={legacy.permissions} />)).toContain('permissions-empty')
  })
})
