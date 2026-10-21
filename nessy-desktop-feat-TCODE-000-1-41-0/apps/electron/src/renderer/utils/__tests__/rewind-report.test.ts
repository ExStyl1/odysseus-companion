/**
 * Two things a rewind toast can get wrong, and only one of them was the
 * reported defect.
 *
 * Reporting a green success when nothing could be restored is the lie this row
 * exists to remove. Reporting "your edits were not tracked" because the server
 * did not send the field is the same lie inverted, and it would fire against
 * every older server. `undefined` therefore has to stay distinct from `false`.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setupI18n } from '@nessy-agent/shared/i18n/setupI18n'
import {
  fileCheckpointsUntracked,
  rewindFilesDescription,
  rewindUntrackedDescription,
  uncoveredRewindCategories,
  uncoveredRewindCategoryKey,
} from '../rewind-report.ts'

describe('fileCheckpointsUntracked', () => {
  it('is true only when the server said so explicitly', () => {
    expect(fileCheckpointsUntracked({ fileCheckpointsTracked: false })).toBe(true)
    expect(fileCheckpointsUntracked({ fileCheckpointsTracked: true })).toBe(false)
  })

  it('is false when the field is absent or the result is missing', () => {
    expect(fileCheckpointsUntracked({})).toBe(false)
    expect(fileCheckpointsUntracked(undefined)).toBe(false)
  })
})

describe('the strings the honest branches render', () => {
  const LOCALES_DIR = resolve(import.meta.dir, '../../../../../../packages/shared/src/i18n/locales')
  const KEYS = [
    'toast.conversationRewoundFilesNotTracked',
    'toast.fileCheckpointsNotTracked',
    'toast.fileCheckpointsNotTrackedDescription',
    // P6.268 — derived from the mapping rather than retyped, so a new category
    // cannot be added with no string behind it.
    ...(['bash', 'subagent'] as const).map(uncoveredRewindCategoryKey),
  ] as const

  // A missing key renders as the key itself, which is a toast that says nothing
  // — the failure mode the whole row is about, arriving through i18n instead.
  for (const locale of ['en', 'ru'] as const) {
    it(`resolves every new key in ${locale}`, () => {
      const messages = JSON.parse(
        readFileSync(resolve(LOCALES_DIR, `${locale}.json`), 'utf-8'),
      ) as Record<string, string>
      for (const key of KEYS) {
        expect(typeof messages[key]).toBe('string')
        expect(messages[key]!.length).toBeGreaterThan(0)
      }
    })
  }
})

/**
 * P6.268 — a rewind restores only what the checkpoint adapter mediated, and
 * until now it said "restored N" for a span whose shell commands and background
 * subagents it never snapshotted.
 */
describe('uncoveredRewindCategories', () => {
  it('names bash for a shell tool in the span, whatever its casing', () => {
    expect(uncoveredRewindCategories([{ toolName: 'Bash' }])).toEqual(['bash'])
    expect(uncoveredRewindCategories([{ toolName: 'bash' }])).toEqual(['bash'])
    expect(uncoveredRewindCategories([{ toolName: 'Monitor' }])).toEqual(['bash'])
  })

  it('names subagent for a background task', () => {
    expect(uncoveredRewindCategories([{ toolName: 'Task', taskId: 'task-1' }])).toEqual(['subagent'])
    expect(uncoveredRewindCategories([{ toolName: 'Agent', isBackground: true }])).toEqual(['subagent'])
  })

  it('names both when the span did both, in a stable order', () => {
    expect(uncoveredRewindCategories([
      { toolName: 'Edit' },
      { toolName: 'Bash' },
      { toolName: 'Task', taskId: 'task-1' },
    ])).toEqual(['bash', 'subagent'])
  })

  it('CONTROL — a span of foreground editors names nothing', () => {
    expect(uncoveredRewindCategories([
      { toolName: 'Edit' },
      { toolName: 'Write' },
      { toolName: 'Read' },
      // A foreground subagent ran through the parent's own dispatch.
      { toolName: 'Task' },
      // Reading a background shell is not producing an edit.
      { toolName: 'BashOutput' },
    ])).toEqual([])
    expect(uncoveredRewindCategories([])).toEqual([])
  })
})

/**
 * F1.989 — the sentence a files-restoring rewind says, rendered through the
 * shipped i18n instance and both shipped locales rather than a stub `t`, so a
 * renamed `{{skipped}}` placeholder or a dropped reason fails here instead of
 * reaching a toast. `getFixedT` pins the language per call without moving the
 * global one other suites read.
 */
describe('rewindFilesDescription', () => {
  const i18n = setupI18n()
  const en = (key: string, options?: Record<string, unknown>): string => i18n.getFixedT('en')(key, options)
  const ru = (key: string, options?: Record<string, unknown>): string => i18n.getFixedT('ru')(key, options)

  it('a rewind that skipped every checkpoint says so, with each distinct reason once', () => {
    const allSkipped = {
      restored: 0,
      failed: 0,
      skipped: 3,
      skippedPaths: [
        { filePath: '/w/a.ts', reason: 'symlink' as const },
        { filePath: '/w/b.ts', reason: 'hard-link' as const },
        { filePath: '/w/c.ts', reason: 'symlink' as const },
      ],
    }
    expect(rewindFilesDescription(allSkipped, en)).toBe(
      'Restored 0 checkpoints; 0 failed; 3 left unchanged'
      + ' — the path is now a shortcut to another file; the path now shares its content with another file',
    )
    expect(rewindFilesDescription(allSkipped, ru)).toBe(
      'Восстановлено чекпоинтов: 0; ошибок: 0; оставлено без изменений: 3'
      + ' — по этому пути теперь ссылка на другой файл; содержимое файла теперь общее с другим файлом',
    )
  })

  it('CONTROL — with nothing skipped it counts restores and failures and names no skip', () => {
    const clean = { restored: 2, failed: 1, skipped: 0, skippedPaths: undefined }
    expect(rewindFilesDescription(clean, en)).toBe('Restored 2 checkpoints; 1 failed')
    expect(rewindFilesDescription(clean, ru)).toBe('Восстановлено чекпоинтов: 2; ошибок: 1')
  })
})

/**
 * F1.1134 (origin DN-157) — on a runtime that tracks no file edits, a rewind whose older checkpoints were ALL
 * skipped for link safety said only "does not track file edits": ChatDisplay kept the files sentence only when
 * `restored > 0`, so the skip count and the reasons F1.989 composed were dropped. The sentence now stays whenever
 * the counts carry anything (restored, failed or skipped).
 */
describe('F1.1134 — rewindUntrackedDescription keeps the skip count beside "does not track edits"', () => {
  const i18n = setupI18n()
  const en = (key: string, options?: Record<string, unknown>): string => i18n.getFixedT('en')(key, options)
  const notTracked = en('toast.conversationRewoundFilesNotTracked')
  const skippedAll = {
    restored: 0,
    failed: 0,
    skipped: 2,
    skippedPaths: [{ filePath: '/w/a.ts', reason: 'symlink' as const }, { filePath: '/w/b.ts', reason: 'symlink' as const }],
  }

  it('all checkpoints skipped: the count and the reason stay, then the untracked clause', () => {
    const files = rewindFilesDescription(skippedAll, en)
    expect(rewindUntrackedDescription(files, skippedAll, en)).toBe(`${files} — ${notTracked}`)
    expect(rewindUntrackedDescription(files, skippedAll, en)).toContain('2 left unchanged')
  })

  it('CONTROL — nothing restored, failed or skipped: only the untracked clause', () => {
    const none = { restored: 0, failed: 0, skipped: 0, skippedPaths: undefined }
    expect(rewindUntrackedDescription(rewindFilesDescription(none, en), none, en)).toBe(notTracked)
  })

  it('ChatDisplay composes the untracked branch through the helper, not a restored-only ternary', () => {
    const chat = readFileSync(resolve(import.meta.dir, '../../components/app-shell/ChatDisplay.tsx'), 'utf8')
    expect(chat).toContain('rewindUntrackedDescription(filesDescription, {')
    expect(chat).not.toMatch(/\? \(restored > 0\s*\n\s*\? `\$\{filesDescription\}/)
  })
})
