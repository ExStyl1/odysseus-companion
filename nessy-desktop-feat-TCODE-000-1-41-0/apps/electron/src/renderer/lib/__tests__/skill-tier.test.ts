import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SafeCapabilitySummary } from '@nessy-agent/shared/protocol/capabilities'
import { skillOwnerLabelKey } from '../skill-tier'

function skillRow(
  scope: SafeCapabilitySummary['scope'],
  origin: SafeCapabilitySummary['origin'] = 'native',
): Pick<SafeCapabilitySummary, 'origin' | 'scope'> {
  return { origin, scope }
}

describe('skillOwnerLabelKey — the tier that owns a skill the app cannot delete', () => {
  it('names the administrator for the machine-wide tier', () => {
    expect(skillOwnerLabelKey(skillRow({ kind: 'builtin' })))
      .toBe('skillsList.managedByAdministrator')
  })

  it('does not call the machine-wide tier "system"', () => {
    // codex's own `system` scope is `$CODEX_HOME/skills/.system` — the cache in
    // the USER's home — while the machine-wide one is `admin` (P6.8, measured at
    // `openai/codex` rust-v0.148.0). A "system" label here would mean the exact
    // opposite of what a codex user's own runtime means by the word.
    expect(skillOwnerLabelKey(skillRow({ kind: 'builtin' })).toLowerCase())
      .not.toContain('system')
  })

  it('distinguishes the personal global folder from the project', () => {
    // The defect this closes: both used to answer "Managed by project".
    expect(skillOwnerLabelKey(skillRow({ kind: 'global' })))
      .toBe('skillsList.managedByGlobal')
    expect(skillOwnerLabelKey(skillRow({ kind: 'project', projectKey: 'p1' })))
      .toBe('skillsList.managedByProject')
  })

  it('names the workspace for a read-only workspace skill', () => {
    expect(skillOwnerLabelKey(skillRow({ kind: 'workspace', workspaceId: 'ws-1' })))
      .toBe('skillsList.managedByWorkspace')
  })

  it('lets plugin ownership win over the scope the plugin sits at', () => {
    for (const scope of [
      { kind: 'builtin' },
      { kind: 'global' },
      { kind: 'workspace', workspaceId: 'ws-1' },
      { kind: 'project', projectKey: 'p1' },
    ] as SafeCapabilitySummary['scope'][]) {
      expect(skillOwnerLabelKey(skillRow(scope, 'plugin')))
        .toBe('skillsList.managedByPlugin')
    }
  })

  it('gives every scope kind a distinct answer — no shared fallback', () => {
    const keys = ([
      { kind: 'builtin' },
      { kind: 'global' },
      { kind: 'workspace', workspaceId: 'ws-1' },
      { kind: 'project', projectKey: 'p1' },
    ] as SafeCapabilitySummary['scope'][]).map(scope => skillOwnerLabelKey(skillRow(scope)))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

/**
 * Containment. The renderer component graph cannot be loaded by the bun runner
 * (the measured trade `SessionStatusIcon.test.tsx` and `hotkey-overrides.test.ts`
 * both document), so the panel is read as source — without this arm a perfectly
 * tested resolver could sit beside a panel still hardcoding the blanket string.
 *
 * UB12.80: the label is resolved by the ONE menu builder (`skillMenuProps`,
 * `hooks/useSkillActions.ts`) that both skill menus spread — the list row and the
 * detail page's header "⋯" — so the arm pins the builder's call and both callers.
 */
describe('containment — the skills list actually asks', () => {
  const root = join(import.meta.dir, '..', '..')
  const panel = readFileSync(join(root, 'components', 'app-shell', 'SkillsListPanel.tsx'), 'utf8')
  const builder = readFileSync(join(root, 'hooks', 'useSkillActions.ts'), 'utf8')
  const detailMenu = readFileSync(join(root, 'components', 'app-shell', 'SkillDetailActions.tsx'), 'utf8')
  const en = JSON.parse(readFileSync(
    join(root, '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales', 'en.json'),
    'utf8',
  )) as Record<string, string>
  const ru = JSON.parse(readFileSync(
    join(root, '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales', 'ru.json'),
    'utf8',
  )) as Record<string, string>

  it('the menu builder resolves the label through this module, and both skill menus spread the builder', () => {
    expect(builder).toContain('t(skillOwnerLabelKey(skill))')
    expect(panel).toContain('{...skillMenuProps(skill, {')
    expect(detailMenu).toContain('const menu = skillMenuProps(skill, {')
    expect(detailMenu).toContain('<SkillMenu {...menu} />')
  })

  it('neither the panel nor the builder hardcodes the blanket project answer', () => {
    expect(panel).not.toContain("skill.origin === 'plugin' ? t('skillsList.managedByPlugin')")
    expect(builder).not.toContain("skill.origin === 'plugin' ? t('skillsList.managedByPlugin')")
  })

  it('every key the resolver can return exists in BOTH locales', () => {
    const scopes = [
      { kind: 'builtin' },
      { kind: 'global' },
      { kind: 'workspace', workspaceId: 'ws-1' },
      { kind: 'project', projectKey: 'p1' },
    ] as SafeCapabilitySummary['scope'][]
    const keys = [
      ...scopes.map(scope => skillOwnerLabelKey(skillRow(scope))),
      skillOwnerLabelKey(skillRow({ kind: 'global' }, 'plugin')),
    ]
    for (const key of keys) {
      expect(en[key], `en.json is missing ${key}`).toBeTruthy()
      expect(ru[key], `ru.json is missing ${key}`).toBeTruthy()
    }
  })

  it('neither locale describes the machine-wide tier as a system one', () => {
    const key = skillOwnerLabelKey(skillRow({ kind: 'builtin' }))
    expect(en[key].toLowerCase()).not.toContain('system')
    expect(ru[key].toLowerCase()).not.toContain('систем')
  })
})
