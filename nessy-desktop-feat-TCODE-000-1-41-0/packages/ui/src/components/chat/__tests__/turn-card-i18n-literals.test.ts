/**
 * P2.494 · the four `TurnCard.tsx` strings a Russian-locale user read in
 * English, asserted where they are — in the source.
 *
 * UB14.11 (v0.15.1's work log) moved the tool row out of `TurnCard.tsx` into
 * `turn/ActivityRow.tsx`, so the row's keys are read THERE now (through
 * `useTranslation`'s `t`), and the two thinking-line keys stay in `TurnCard.tsx`.
 * UB14.12 (v0.15.1's TurnCard shell) took upstream's name for the thinking line,
 * `chat.processing.thinking`, and retired ours, `turnCard.thinkingIndicator`, with
 * its last reader; `TurnCard.tsx` now reads both keys through `useTranslation`'s `t`.
 * The guard against upstream's English `Task ID:` / `Shell ID:` literals follows
 * the row: v0.15.1's `ActivityRow` ships them, ours must not.
 *
 * WHY A SOURCE ASSERTION, WHICH THIS TREE OTHERWISE WARNS AGAINST.
 * `TurnCard.tsx` cannot be loaded by the bun runner at all: it reaches
 * `pdfjs-dist` through `Markdown` → `MarkdownPdfBlock`, and stubbing that only
 * moves the failure to `ReferenceError: DOMMatrix is not defined` inside
 * `react-pdf` (measured 2026-08-21, recorded in three sibling test headers). So
 * a rendered assertion is unavailable, and `intermediate-row.ts` /
 * `tool-elapsed.ts` exist precisely because a source assertion cannot tell a
 * painted value from a dropped one.
 *
 * That objection does not apply to THIS question. The defect being guarded is
 * not "does the row paint the right value" — it is "is there a bare English
 * literal at this site", which is a property of the text and nothing else. The
 * instrument matches the claim here, where it did not there.
 *
 * The literal check is paired with a key check in BOTH directions, because
 * P2.490 measured that either half alone is passable: a key added to both
 * locales in sorted position satisfies `lint:i18n:parity` AND
 * `lint:i18n:sorted` while nothing reads it, and removing a literal without
 * adding a key leaves an empty span that no gate notices.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const TURN_CARD = new URL('../TurnCard.tsx', import.meta.url)
const ACTIVITY_ROW = new URL('../turn/ActivityRow.tsx', import.meta.url)
const TOOL_ELAPSED = new URL('../tool-elapsed.ts', import.meta.url)
const EN = new URL('../../../../../shared/src/i18n/locales/en.json', import.meta.url)
const RU = new URL('../../../../../shared/src/i18n/locales/ru.json', import.meta.url)

const turnCardSource = readFileSync(TURN_CARD, 'utf8')
const rowSource = readFileSync(ACTIVITY_ROW, 'utf8')
const toolElapsedSource = readFileSync(TOOL_ELAPSED, 'utf8')
const en: Record<string, string> = JSON.parse(readFileSync(EN, 'utf8'))
const ru: Record<string, string> = JSON.parse(readFileSync(RU, 'utf8'))

/** Every key this row introduced or reused, what it replaced, and the file that reads it. */
const KEYED = [
  { key: 'turnCard.intermediateStreaming', literal: "'Thinking...'", file: 'row' },
  { key: 'chat.processing.thinking', literal: null, file: 'turnCard' },
  { key: 'turnCard.preparingResponse', literal: "'Preparing response...'", file: 'turnCard' },
  // Reused, NOT duplicated. `common.error` resolves the row's error label;
  // `turnCard.subagent.status.error` and `turnCard.workflow.error` also read
  // "Error" and belong to other surfaces, so adding a third would have been the
  // wrong kind of tidy.
  { key: 'common.error', literal: null, file: 'row' },
] as const

const sourceOf = (file: 'row' | 'turnCard'): string => (file === 'row' ? rowSource : turnCardSource)
/** `t('k'` (useTranslation) in TurnCard and in the row. */
const callOf = (key: string): string => `t('${key}'`

describe('P2.494 · turn-card strings are keyed, not literal', () => {
  it('reads the files it is asserting about', () => {
    // The positive controls. Without them every `not.toContain` below passes
    // vacuously the moment a URL stops resolving.
    expect(rowSource).toContain('export function ActivityRow(')
    expect(rowSource).toContain("const { t } = useTranslation()")
    expect(turnCardSource).toContain('export const TurnCard = React.memo(')
    expect(turnCardSource.length).toBeGreaterThan(10_000)
  })

  it.each([...KEYED])('resolves $key from i18n at its call site', ({ key, file }) => {
    expect(sourceOf(file)).toContain(callOf(key))
  })

  it.each([...KEYED])('ships $key in both locales', ({ key }) => {
    expect(en[key]).toBeTruthy()
    expect(ru[key]).toBeTruthy()
    // A Russian value identical to the English one is the shape this row
    // exists to remove, so it is refused rather than tolerated.
    expect(ru[key]).not.toBe(en[key])
  })

  it('has no bare English literal left at the sites it replaced', () => {
    for (const { literal, file } of KEYED) {
      if (literal) expect(sourceOf(file)).not.toContain(literal)
    }
    // The native-tool error badge was a bare JSX text node rather than a
    // quoted literal, so it needs its own spelling.
    expect(rowSource).not.toMatch(/>\s*\n?\s*Error\s*\n?\s*<\/span>/)
  })

  it('leaves the three tool-elapsed strings to their own module', () => {
    // They are injected from here (`toolElapsedLabels`) and asserted
    // byte-identically in `tool-elapsed.test.ts`; this only pins that the
    // composition still happens through the keys and not inline.
    for (const key of ['turnCard.elapsed', 'turnCard.backgroundTaskId', 'turnCard.backgroundShellId']) {
      expect(rowSource).toContain(callOf(key))
      expect(en[key]).toBeTruthy()
      expect(ru[key]).toBeTruthy()
    }
    // v0.15.1's `ActivityRow` builds exactly these two in English; ours must not.
    expect(rowSource).not.toContain('Task ID: ${')
    expect(rowSource).not.toContain('Shell ID: ${')
    expect(rowSource).not.toContain('elapsed` : ')
    expect(turnCardSource).not.toContain('Task ID: ${')
  })

  /**
   * The gap the English assertions alone cannot see, and the reason this block
   * exists: `tool-elapsed.ts`'s three strings resolve to the SAME English text
   * whether they come from a key or from an inline template, so every value
   * test in `tool-elapsed.test.ts` stays green against a re-inlined literal.
   * Only the source can tell those two apart, and only for a Russian user does
   * the difference show.
   */
  it('composes tool-elapsed text from the injected labels, never inline', () => {
    // Positive control for this second read.
    expect(toolElapsedSource).toContain('export function describeToolElapsed(')

    expect(toolElapsedSource).toContain('labels.taskId(activity.taskId)')
    expect(toolElapsedSource).toContain('labels.shellId(activity.shellId)')
    expect(toolElapsedSource).toContain('labels.elapsed(formatDuration(')

    // The interface's own doc comments quote the English, so the literals are
    // matched in their COMPOSING form — a template hole, or a backtick-joined
    // suffix — rather than as bare words.
    expect(toolElapsedSource).not.toContain('`Task ID: ${')
    expect(toolElapsedSource).not.toContain('`Shell ID: ${')
    expect(toolElapsedSource).not.toContain('} elapsed`')
  })
})

/**
 * UB14.12 · v0.15.1's TurnCard shell keyed the three English literals our v0.14.0-shaped card still
 * painted ("Plan", "Markdown", "Streaming..."), and its work-log menu trigger gained a name. Each new
 * key is read where it is drawn; the retired thinking key has no reader and no entry.
 */
describe('UB14.12 · the shell, the footer and the menu trigger read keys', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const footerSource = read('../turn/ResponseFooter.tsx')
  const menuSource = read('../TurnCardActionsMenu.tsx')

  it('POSITIVE — each key is read at its site and shipped in both locales', () => {
    expect(footerSource).toContain('export function ResponseFooter(')
    for (const [source, key] of [
      [turnCardSource, 'turnCard.plan'],
      [footerSource, 'turnCard.viewAsMarkdown'],
      [menuSource, 'turnCard.moreActions'],
    ] as const) {
      expect({ key, read: source.includes(callOf(key)) }).toEqual({ key, read: true })
      expect(en[key]).toBeTruthy()
      expect(ru[key]).toBeTruthy()
      expect(ru[key]).not.toBe(en[key])
    }
  })

  it('NEGATIVE — no English literal of the old card is left, and the retired key is gone', () => {
    expect(turnCardSource).not.toContain('>Plan<')
    expect(turnCardSource).not.toContain('<span>Markdown</span>')
    expect(turnCardSource).not.toContain('Streaming...')
    expect(footerSource).not.toContain('>Markdown<')
    expect(turnCardSource).not.toContain("'turnCard.thinkingIndicator'")
    expect(en['turnCard.thinkingIndicator']).toBeUndefined()
    expect(ru['turnCard.thinkingIndicator']).toBeUndefined()
  })
})
