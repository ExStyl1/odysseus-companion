/**
 * P6.209, the cross-scope half — "which permission rules are in effect" had no
 * surface that said how the two scopes compose.
 *
 * The page has always shown both scopes and has never said which wins. A
 * two-table layout invites the wrong reading — that the lower table overrides
 * the upper one — and the resolver does the opposite: `buildMergedConfig`
 * applies the app-level `global` layer first and the `workspace` layer second,
 * and BOTH appliers only push onto the same arrays. Additive, never last-wins.
 *
 * These cases pin the derivation itself rather than matching source text,
 * because the derivation is a pure exported function — and it lives in a LEAF
 * module, `permissions-cross-scope.ts`, for a measured reason: importing it from
 * the page instead pulls in the `@nessy-agent/ui` barrel and its pdfjs `?url`
 * chain, and this suite died on
 * `Missing 'default' export in module '.../pdf.worker.min.mjs?url'` after 186 s.
 * The one source-matched case is the sentences' placement on the page, which
 * cannot be reached any other way without a DOM.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import en from '@nessy-agent/shared/i18n/locales/en.json'
import ru from '@nessy-agent/shared/i18n/locales/ru.json'
import type { PermissionRow } from '@/components/info/PermissionsDataTable'
import { annotateRowsAlreadyGrantedByDefaults } from '../permissions-cross-scope'

const SENTENCE = 'already granted by the app defaults'

const page = readFileSync(
  fileURLToPath(new URL('../PermissionsSettingsPage.tsx', import.meta.url)),
  'utf8',
)

const row = (over: Partial<PermissionRow>): PermissionRow => ({
  access: 'allowed',
  type: 'bash',
  pattern: 'git status',
  comment: null,
  ...over,
})

describe('cross-scope precedence on the permissions page', () => {
  it('marks a workspace pattern the defaults already grant as inert', () => {
    const defaults = [row({ pattern: 'git status' })]
    const [annotated] = annotateRowsAlreadyGrantedByDefaults(
      [row({ pattern: 'git status' })],
      defaults,
      SENTENCE,
    )
    expect(annotated!.unenforceable).toBe(SENTENCE)
    // The row itself is untouched otherwise: the user's own pattern keeps its
    // badge and its place, which is the `annotate` treatment P3.351 chose over
    // greying or filtering.
    expect(annotated!.access).toBe('allowed')
    expect(annotated!.pattern).toBe('git status')
  })

  it('leaves a genuinely new workspace pattern alone', () => {
    // The negative half, and the one that matters: if this annotated everything,
    // the display would be worse than saying nothing.
    const [annotated] = annotateRowsAlreadyGrantedByDefaults(
      [row({ pattern: 'deploy --prod' })],
      [row({ pattern: 'git status' })],
      SENTENCE,
    )
    expect(annotated!.unenforceable).toBeUndefined()
  })

  it('does not confuse one type with another, or a block with a grant', () => {
    // Boundaries. The same string can be a bash pattern and an MCP pattern, and
    // the key is per type; and a `blocked` row is a different claim from an
    // `allowed` one, so a default GRANT must never mark a workspace BLOCK inert.
    const defaults = [row({ type: 'bash', pattern: 'Read' })]
    const rows = annotateRowsAlreadyGrantedByDefaults(
      [
        row({ type: 'mcp', pattern: 'Read' }),
        row({ access: 'blocked', type: 'tool', pattern: 'Read' }),
      ],
      defaults,
      SENTENCE,
    )
    expect(rows[0]!.unenforceable).toBeUndefined()
    expect(rows[1]!.unenforceable).toBeUndefined()
  })

  it('never overwrites P3.351s stronger finding', () => {
    // A blocked row can already carry the pre-emption reason — a statement about
    // what the RUNTIME does. Replacing it with "a duplicate" would trade a defect
    // report for a tidiness note.
    const preempted = row({
      access: 'blocked',
      type: 'tool',
      pattern: 'Bash',
      unenforceable: 'the bash classifier decides first',
    })
    const [kept] = annotateRowsAlreadyGrantedByDefaults([preempted], [preempted], SENTENCE)
    expect(kept!.unenforceable).toBe('the bash classifier decides first')
  })

  it('states the precedence itself, in both locales, and on the workspace section', () => {
    // The per-row sentence explains one row; the section sentence is what stops
    // a reader concluding "lower table wins" from the layout alone.
    for (const [name, bundle] of Object.entries({
      en: en as Record<string, string>,
      ru: ru as Record<string, string>,
    })) {
      for (const key of ['settings.permissions.crossScopeNote', 'settings.permissions.rowAlreadyGranted']) {
        expect(`${name}:${key}:${(bundle[key] ?? '').length > 0}`).toBe(`${name}:${key}:true`)
      }
    }
    const note = (en as Record<string, string>)['settings.permissions.crossScopeNote'] ?? ''
    // The claim measured off the resolver: additive, and the workspace scope
    // cannot subtract. A copy edit that softened either half would restore the
    // ambiguity this row closed.
    expect(note).toContain('added together')
    expect(note).toContain('never remove')
    expect(page).toContain('settings.permissions.crossScopeNote')
    // And the table has to be told to render the sentence at all.
    expect(page).toContain('unenforceableStyle="annotate"')
  })
})
