/**
 * F1.577 — the Send-to-workspace dialog tells the user WHY, not only that nothing arrived.
 *
 * Before: `SendResourceToWorkspaceDialog`'s `handleSend` wrote the export's warnings to
 * `console.warn` only, and never read the import bucket's `failed` or `warnings`. So a send
 * whose every entry was skipped showed "Nothing was sent to <workspace>" with no reason, for
 * example a skill folder linked out of the workspace (F1.575) or a source folder linked out
 * of it (F1.576). The same toast appeared for an import-side refusal, such as a bundle the
 * target refused whole.
 *
 * After: every result toast carries a description with the notes' COUNT and the FIRST one
 * verbatim. The notes are the export's warnings first, then the import's failures (by id),
 * then its warnings. `collectSendResourceNotes` is the pure half and is tested here through
 * the real export → import pipeline (no RPC). The dialog half is a source-text check,
 * because rendering the dialog to click Send costs a renderer module graph for one prop.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, symlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { exportResources, importResources } from '@nessy-agent/shared/resources'
import { collectSendResourceNotes } from '../send-resource-notes'

const noopDeps = { clearSourceCredentials: async () => {} }

function put(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

const SKILL_MD = (marker: string) => `---\nname: s\ndescription: s\n---\n${marker}`

describe('F1.577 — collectSendResourceNotes, driven through the real export → import pipeline', () => {
  let root: string
  let from: string
  let to: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wjbo-f1577-'))
    from = join(root, 'workspaces', 'from')
    to = join(root, 'workspaces', 'to')
    put(join(from, 'skills', 'real', 'SKILL.md'), SKILL_MD('REAL'))
    put(join(root, 'outside-skill', 'SKILL.md'), SKILL_MD('OUTSIDE'))
    symlinkSync(join(root, 'outside-skill'), join(from, 'skills', 'out'))
    mkdirSync(to, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('CONTROL — a clean send has no notes, so its toast is unchanged', async () => {
    const { bundle, warnings } = exportResources(from, { skills: ['real'] })
    const result = await importResources(to, bundle, 'skip', noopDeps)
    expect(result.skills.imported).toEqual(['real'])
    expect(collectSendResourceNotes(warnings, result.skills)).toBeUndefined()
  })

  it('a skill whose folder links out of the workspace: nothing arrives, and the note names the reason', async () => {
    const { bundle, warnings } = exportResources(from, { skills: ['out'] })
    const result = await importResources(to, bundle, 'skip', noopDeps)
    expect(result.skills.imported).toEqual([])
    expect(result.skills.skipped).toEqual([])
    expect(collectSendResourceNotes(warnings, result.skills)).toEqual({
      count: 1,
      first: 'skills[0]: does not resolve inside the workspace, skipping',
    })
  })

  it('an import-side refusal is a note too, named by the id it failed on; the export warnings come first', () => {
    const notes = collectSendResourceNotes(
      ['skills[1]: repeats an earlier entry, skipping'],
      { failed: [{ id: 'my-src', error: 'Cannot import builtin source slug' }], warnings: ['a later warning'] },
    )
    expect(notes).toEqual({ count: 3, first: 'skills[1]: repeats an earlier entry, skipping' })
    expect(collectSendResourceNotes([], { failed: [{ id: 'my-src', error: 'Cannot import builtin source slug' }] }))
      .toEqual({ count: 1, first: 'my-src: Cannot import builtin source slug' })
  })

  it("a whole-bundle refusal (id '*') is shown as its error alone", () => {
    const notes = collectSendResourceNotes(undefined, { failed: [{ id: '*', error: 'Invalid bundle: x' }], warnings: [] })
    expect(notes).toEqual({ count: 1, first: 'Invalid bundle: x' })
  })

  it('a blank note is not counted, and nothing at all is no notes', () => {
    expect(collectSendResourceNotes(['', '   '], undefined)).toBeUndefined()
    expect(collectSendResourceNotes(undefined, undefined)).toBeUndefined()
  })
})

describe('F1.577 — the dialog and both locales carry it', () => {
  const dialog = readFileSync(join(import.meta.dir, '..', '..', 'components', 'app-shell', 'SendResourceToWorkspaceDialog.tsx'), 'utf-8')
  const locales = join(import.meta.dir, '..', '..', '..', '..', '..', '..', 'packages', 'shared', 'src', 'i18n', 'locales')

  it('every result toast of handleSend carries the notes as its description, and the notes are no longer console-only', () => {
    const start = dialog.indexOf('// 3. Report result')
    const end = dialog.indexOf('} catch (error', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const report = dialog.slice(start, end)
    const toasts = report.match(/toast\.(success|info|warning)\(/g) ?? []
    expect(toasts).toHaveLength(4)
    expect(report.match(/\{ id: toastId, description: notesDescription \}/g) ?? []).toHaveLength(4)
    expect(report).toContain('collectSendResourceNotes(exportWarnings, bucket)')
    expect(report).toContain("t('sendToWorkspace.resourceNotes', { count: notes.count, reason: notes.first })")
  })

  it('both locales carry the plural family with the same two variables in every form', () => {
    for (const lang of ['en', 'ru']) {
      const messages = JSON.parse(readFileSync(join(locales, `${lang}.json`), 'utf-8')) as Record<string, string>
      for (const form of ['few', 'many', 'one', 'other']) {
        const value = messages[`sendToWorkspace.resourceNotes_${form}`]
        expect(value).toBeString()
        expect(value).toContain('{{count}}')
        expect(value).toContain('{{reason}}')
      }
    }
  })
})
