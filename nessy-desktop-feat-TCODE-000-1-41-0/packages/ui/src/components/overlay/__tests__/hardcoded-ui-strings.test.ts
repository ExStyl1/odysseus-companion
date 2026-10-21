/**
 * F1.250 — the user-visible strings `packages/ui` still spelled in English.
 *
 * Nine at the row's reading, in six files: seven that upstream craft-agents-oss
 * moved to i18n in v0.11.0 (`ActivityCardsOverlay`'s Command / Input Params
 * headings, `TiptapCodeBlockView`'s code-language aria-label and its
 * no-languages empty state, the copy aria-labels of `CodeBlock` and
 * `MarkdownJsonBlock`, the `Spinner`'s Loading label) and two in the fork-only
 * diff-comment surface of `MultiDiffPreviewOverlay`. Reading that file whole
 * found four more of the same kind beside them — the Cancel / Add comment /
 * Send comments buttons and the "N comments on M files" sentence, whose plural
 * was an English `=== 1 ? '' : 's'` — so they go through `t()` in the same
 * change (an in-zone residue, reported).
 *
 * Upstream's key names are used where upstream has them; the three that
 * already existed here (`editor.codeLanguage`, `common.copyCode`,
 * `common.loading`) are only wired. The CodeBlock header's 'plain text' stays a
 * literal, as upstream v0.13.4 keeps it: it is the language slot, beside
 * untranslated language ids.
 *
 * Positive arm: each file calls `t()` with each key, and every key exists in
 * BOTH locales with a Russian value that is not the English one (a copied value
 * passes `lint:i18n:parity` and says nothing). Negative arm: no literal
 * `aria-label="…"` or `placeholder="…"` attribute remains anywhere in
 * `packages/ui/src` — read with `git grep` over the tracked sources, the arm
 * the row asks for, so a sixth file cannot hide from a hand-written list.
 */

import { afterAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import i18n from 'i18next'
import { setupI18n } from '@nessy-agent/shared/i18n/setupI18n'
import enMessages from '../../../../../shared/src/i18n/locales/en.json'
import ruMessages from '../../../../../shared/src/i18n/locales/ru.json'

setupI18n()
afterAll(async () => {
  await i18n.changeLanguage('en')
})

const COMPONENTS = fileURLToPath(new URL('../../', import.meta.url))
const UI_SRC = fileURLToPath(new URL('../../../', import.meta.url))

const read = (relative: string): string => readFileSync(`${COMPONENTS}${relative}`, 'utf-8')

/** Every (file, key) pair the row routes through `t()`. Plural keys are named by their base. */
const WIRED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['overlay/ActivityCardsOverlay.tsx', ['activity.command', 'activity.inputParams', 'overlay.activity']],
  ['overlay/HTMLPreviewOverlay.tsx', ['common.copyHtml']],
  ['markdown/TiptapCodeBlockView.tsx', ['editor.codeLanguage', 'editor.noLanguagesFound']],
  ['markdown/CodeBlock.tsx', ['common.copyCode']],
  ['markdown/MarkdownJsonBlock.tsx', ['common.copyJson']],
  ['ui/LoadingIndicator.tsx', ['common.loading']],
  // F1.441 — the literal the widened negative arm found (it was in the one form the old regex could not see).
  // UB14.10 — v0.15.1 spells it `preview.openMermaidFullscreen`; ours (`overlay.…`) is retired.
  ['markdown/MarkdownMermaidBlock.tsx', ['preview.openMermaidFullscreen']],
  // UB14.10 (R3-03) — v0.15.1's preview blocks translate what v0.14.0 spelled in English: the
  // datatable's boolean cells and empty body, the image block's title/alt fallback, and the
  // navigator menu's unlabelled item.
  ['markdown/MarkdownDatatableBlock.tsx', ['datatable.yes', 'datatable.no', 'datatable.noRows']],
  ['markdown/MarkdownImageBlock.tsx', ['preview.imagePreview']],
  ['markdown/PreviewBlockChrome.tsx', ['overlay.itemNumber']],
  ['overlay/MultiDiffPreviewOverlay.tsx', [
    'diff.removeComment',
    'diff.commentPlaceholder',
    'common.cancel',
    'diff.addComment',
    'diff.sendComments',
    'diff.commentsSummary',
    'diff.commentCount',
    'diff.commentFileCount',
    // F1.442 — the header title and the type badge.
    'diff.edit',
    'diff.write',
    'diff.editBadgeCount',
    'diff.writeBadgeCount',
    'diff.editCount',
    'diff.editFileCount',
    'diff.editsSummary',
  ]],
]

const PLURAL_SUFFIXES = ['_few', '_many', '_one', '_other'] as const

/**
 * F1.441 — the negative arm's pattern, widened. F1.250's `(aria-label|placeholder)="[^"]*[A-Za-z]`
 * saw only the double-quoted attribute form; a literal written as an EXPRESSION —
 * `{'…'}`, `{cond ? '…' : …}`, a template literal, or single quotes — passed it,
 * which is how MarkdownMermaidBlock's fullscreen label (a ternary) survived F1.250.
 * A literal is a quoted value starting with a capital letter, directly or anywhere
 * inside the attribute's braces; an i18n key (`t('common.copyCode')`) starts lower-case.
 * ERE, because `git grep -E` reads it.
 */
const LITERAL_LABEL_PATTERN = `(aria-label|placeholder)=(\\{[^}]*)?["'\`][A-Z]`

function localeKeysFor(base: string, messages: Record<string, string>): string[] {
  if (base in messages) return [base]
  return PLURAL_SUFFIXES.map(suffix => `${base}${suffix}`)
}

describe('F1.250 — packages/ui strings go through t()', () => {
  it('each of the six files calls t() with each of its keys', () => {
    for (const [file, keys] of WIRED) {
      const source = read(file)
      expect({ file, usesHook: /\buseTranslation\(\)/.test(source) }).toEqual({ file, usesHook: true })
      for (const key of keys) {
        expect({ file, key, called: new RegExp(`\\bt\\((['"])${key.replace(/\./g, '\\.')}\\1`).test(source) })
          .toEqual({ file, key, called: true })
      }
    }
  })

  it('every key exists in both locales, and the Russian value is not the English one', () => {
    const en = enMessages as Record<string, string>
    const ru = ruMessages as Record<string, string>
    for (const [, keys] of WIRED) {
      for (const base of keys) {
        for (const key of localeKeysFor(base, en)) {
          expect({ key, en: typeof en[key], ru: typeof ru[key] }).toEqual({ key, en: 'string', ru: 'string' })
          // A value that is ONLY interpolation (`{{comments}} {{files}}`) is the
          // same in every language by construction; everything else must differ.
          if ((en[key] ?? '').replace(/\{\{\w+\}\}/g, '').trim() === '') continue
          expect({ key, same: en[key] === ru[key] }).toEqual({ key, same: false })
        }
      }
    }
  })

  it('the review-comment summary is a real plural in both languages (it was an English `=== 1 ? \'\' : \'s\'`)', async () => {
    const summary = (comments: number, files: number): string => i18n.t('diff.commentsSummary', {
      comments: i18n.t('diff.commentCount', { count: comments }),
      files: i18n.t('diff.commentFileCount', { count: files }),
    })
    await i18n.changeLanguage('en')
    expect(summary(1, 1)).toBe('1 comment on 1 file')
    expect(summary(3, 2)).toBe('3 comments on 2 files')
    await i18n.changeLanguage('ru')
    expect(summary(1, 1)).toBe('1 комментарий в 1 файле')
    expect(summary(3, 2)).toBe('3 комментария в 2 файлах')
    expect(summary(5, 21)).toBe('5 комментариев в 21 файле')
  })

  it('no literal aria-label or placeholder attribute remains in packages/ui/src', () => {
    let hits = ''
    try {
      hits = execFileSync('git', [
        'grep', '-nE', LITERAL_LABEL_PATTERN,
        '--', '.', ':(exclude)**/__tests__/**', ':(exclude)*.test.ts', ':(exclude)*.test.tsx',
      ], { cwd: UI_SRC, encoding: 'utf-8' })
    } catch (error) {
      // `git grep` exits 1 when nothing matches — the passing case.
      if ((error as { status?: number }).status !== 1) throw error
    }
    expect(hits).toBe('')
  })

  it('F1.441 — the widened pattern sees all five literal forms, and no t() call', () => {
    const pattern = new RegExp(LITERAL_LABEL_PATTERN)
    for (const form of [
      '<a aria-label="Open thing" />',
      "<b aria-label={'Open thing'} />",
      '<c aria-label={cond ? "Open thing" : undefined} />',
      '<d placeholder={`Type here`} />',
      "<e aria-label='Open thing' />",
    ]) {
      expect({ form, matched: pattern.test(form) }).toEqual({ form, matched: true })
    }
    for (const wired of [
      "<a aria-label={t('common.copyCode')} />",
      "<b aria-label={tapToOpen ? t('preview.openMermaidFullscreen') : undefined} />",
      '<c placeholder={t("diff.commentPlaceholder")} />',
    ]) {
      expect({ wired, matched: pattern.test(wired) }).toEqual({ wired, matched: false })
    }
  })

  it('F1.442 — the multi-file header and the badge are real plurals in both languages (they were English-only plural suffixes)', async () => {
    const header = (edits: number, files: number): string => i18n.t('diff.editsSummary', {
      edits: i18n.t('diff.editCount', { count: edits }),
      files: i18n.t('diff.editFileCount', { count: files }),
    })
    await i18n.changeLanguage('en')
    expect(header(3, 2)).toBe('3 edits across 2 files')
    expect(header(1, 1)).toBe('1 edit across 1 file')
    expect(i18n.t('diff.writeBadgeCount', { count: 4 })).toBe('4 Writes')
    await i18n.changeLanguage('ru')
    expect(header(3, 2)).toBe('3 правки в 2 файлах')
    expect(header(5, 21)).toBe('5 правок в 21 файле')
    expect(i18n.t('diff.editBadgeCount', { count: 2 })).toBe('2 правки')
    expect(i18n.t('diff.write')).toBe('Запись')
    await i18n.changeLanguage('en')
  })
})
