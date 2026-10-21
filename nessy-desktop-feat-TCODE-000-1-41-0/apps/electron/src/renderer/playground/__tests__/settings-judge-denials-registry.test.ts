/**
 * P6.209 (A42) — the denials list's design surface.
 *
 * Its states cannot be reached on a real machine without arranging for a safety
 * judge to refuse something, so the playground is the only place they can be
 * reviewed. Source-text assertions for the reason
 * `workspace-actions-menu-registry.test.ts` measures — importing a registry entry
 * that pulls a settings component graph times out under `bun test`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const REGISTRY_DIR = join(import.meta.dir, '..', 'registry')
const entrySource = readFileSync(join(REGISTRY_DIR, 'settings-judge-denials.tsx'), 'utf-8')
const indexSource = readFileSync(join(REGISTRY_DIR, 'index.ts'), 'utf-8')

describe('auto-mode denials playground entry', () => {
  it('declares one entry and is wired into registry/index', () => {
    expect(entrySource).toContain("id: 'settings-judge-denials'")
    expect(entrySource.match(/^\s+id: '/gm) ?? []).toHaveLength(1)
    expect(indexSource).toContain("import { settingsJudgeDenialsComponents } from './settings-judge-denials'")
    expect(indexSource).toContain('...settingsJudgeDenialsComponents,')
  })

  it('keeps the four EMPTY-looking states apart, which is the whole design', () => {
    // "no chat open", "refused nothing", "could not be read" and (P6.721) "this
    // runtime keeps no such record" are four different facts. Collapsing any two
    // of them would let the page claim the judge refused nothing when it does
    // not know — which is precisely what a Pi session rendered before the
    // channel's answer began carrying its own capability.
    for (const state of ['no-session', 'empty', 'unavailable', 'unsupported']) {
      expect(entrySource, `no variant for ${state}`).toContain(`state: '${state}'`)
    }
    expect(entrySource).toContain("state: 'listed'")
  })

  it('the section it previews offers no ACTION at all, because re-issuing a refused call is a product posture', () => {
    // Asserted against the component rather than the entry: the entry's own
    // prose says the word "retry" while explaining its absence, and a text match
    // cannot tell a caption from a button. A viewer with no click handler and no
    // button cannot grow one silently.
    const sectionSource = readFileSync(
      join(import.meta.dir, '..', '..', 'pages', 'settings', 'AutoModeDenialsSection.tsx'),
      'utf-8',
    )
    expect(sectionSource).not.toContain('onClick')
    expect(sectionSource).not.toContain('<button')
    expect(sectionSource).not.toContain('<Button')
  })
})
