/**
 * UA1.2 (OQ-6, spec §8) — the status ids the agent is SHOWN exist, and the text it is shown ends at `needs-review`.
 *
 * Before this row the `set_session_status` description and its schema example offered `"in_progress"` — an id no
 * default config has, which resolved to "Unknown status" on the first call — and `system.ts` taught a self-closing
 * workflow ("Agent calls `set_session_status` with "done""), which the closure guard now refuses.
 *
 * SCOPED, deliberately, to three agent-facing texts: `TOOL_DESCRIPTIONS.set_session_status`, the `status` field's
 * description in `SetSessionStatusSchema` (read from its projected JSON schema), and the `system.ts` Session
 * Self-Management text from "Setting status" to the end of the hand-off steps. `in_progress` is a LEGITIMATE value
 * elsewhere — the TodoWrite and TaskCreate schemas use it for task items, not session statuses, and the statuses
 * docs site uses an added "In Progress" to demo a CUSTOM status — so a whole-file scan would be wrong, not merely
 * noisy.
 *
 * UA12.5 extends the scope to the shipped docs that name session statuses: automations.md's `SessionStatusChange`
 * example cell and the conversations.md status table and inbox group-by line (EN and RU, read across the monorepo
 * by repo-relative path). The customizing.md pages are deliberately NOT read: their "In Progress" is the worked
 * example of a status a user adds, which must stay legal.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getToolDefsAsJsonSchema, TOOL_DESCRIPTIONS } from '@nessy-agent/session-tools-core'
import { getDefaultStatusConfig } from '../storage.ts'

const DEFAULT_IDS = new Set(getDefaultStatusConfig().statuses.map(status => status.id))
const DEFAULT_LABELS = new Set(getDefaultStatusConfig().statuses.map(status => status.label))

/** Every double-quoted lowercase id-shaped token in a text. */
const quotedIds = (text: string): string[] => [...text.matchAll(/"([a-z][a-z0-9_-]*)"/g)].map(match => match[1]!)

const absentIds = (text: string): string[] => quotedIds(text).filter(id => !DEFAULT_IDS.has(id))

const systemSource = readFileSync(fileURLToPath(new URL('../../prompts/system.ts', import.meta.url)), 'utf8')

/** The shipped docs that name session statuses, read from the repo root (this file sits five levels down). */
const automationsDoc = readFileSync(
  fileURLToPath(new URL('../../../../../apps/electron/resources/docs/automations.md', import.meta.url)),
  'utf8',
)
const conversationsDocs = {
  en: readFileSync(
    fileURLToPath(new URL('../../../../../docs-site/content/core-concepts/conversations.md', import.meta.url)),
    'utf8',
  ),
  ru: readFileSync(
    fileURLToPath(new URL('../../../../../docs-site/content/ru/core-concepts/conversations.md', import.meta.url)),
    'utf8',
  ),
}

/** `system.ts` from "**Setting status:**" up to "## Diagrams" — the status text and the hand-off steps under it. */
function settingStatusSection(): string {
  const start = systemSource.indexOf('**Setting status:**')
  const end = systemSource.indexOf('## Diagrams and Visualization', start)
  expect(start, 'the Setting status heading moved').toBeGreaterThan(-1)
  expect(end, 'the section end marker moved').toBeGreaterThan(start)
  return systemSource.slice(start, end)
}

/** The backtick-quoted lowercase ids in automations.md's `SessionStatusChange` row (its example cell). */
function sessionStatusChangeExamples(): string[] {
  const row = automationsDoc.split('\n').find(line => line.startsWith('| `SessionStatusChange`'))
  expect(row, 'the SessionStatusChange row moved in automations.md').toBeDefined()
  return [...row!.matchAll(/`([a-z][a-z0-9_-]*)`/g)].map(match => match[1]!)
}

/**
 * The bold first-cell labels of the status table under a conversations.md status section (scoped to that section,
 * so other tables' bold first cells — Batch Operations' "Change Status" — never enter the parse).
 */
function statusTableLabels(source: string, heading: string): string[] {
  const start = source.indexOf(heading)
  expect(start, `the ${heading} heading moved`).toBeGreaterThan(-1)
  const end = source.indexOf('\n## ', start)
  expect(end, `the section after ${heading} moved`).toBeGreaterThan(start)
  const labels: string[] = []
  for (const line of source.slice(start, end).split('\n')) {
    const match = line.match(/^\| \*\*([^*]+)\*\*/)
    if (match) labels.push(match[1]!.trim())
  }
  return labels
}

/**
 * The status names in a conversations.md inbox "group threads by status (…)" line, EN or RU. The filter keeps only
 * label-shaped items (capitalised Latin words), dropping the "and any custom states you add" tails.
 */
function groupByStatusNames(source: string): string[] {
  const match = source.match(/(?:by status|по status) \(([^)]*)\)/)
  expect(match, 'the inbox group-by-status line moved').not.toBeNull()
  return match![1]!
    .split(',')
    .map(name => name.trim())
    .filter(name => /^[A-Z][A-Za-z ]*$/.test(name))
}

const description = TOOL_DESCRIPTIONS.set_session_status
/** The `status` field's description exactly as the model receives it (the JSON schema every runtime projects). */
const schemaExample = (() => {
  const definition = getToolDefsAsJsonSchema().find(tool => tool.name === 'set_session_status')
  const properties = (definition?.inputSchema as { properties?: Record<string, { description?: string }> } | undefined)?.properties
  return properties?.status?.description ?? ''
})()

describe('the status ids the agent is shown exist in the default config', () => {
  it('the default config is the five ids the spec names, with done and cancelled closed', () => {
    expect([...DEFAULT_IDS]).toEqual(['backlog', 'todo', 'needs-review', 'done', 'cancelled'])
    const closed = getDefaultStatusConfig().statuses.filter(status => status.category === 'closed').map(status => status.id)
    expect(closed).toEqual(['done', 'cancelled'])
  })

  for (const [name, text] of [
    ['TOOL_DESCRIPTIONS.set_session_status', description],
    ['SetSessionStatusSchema.status', schemaExample],
    ['system.ts Setting status', settingStatusSection()],
  ] as const) {
    it(`${name} names only ids the default config has`, () => {
      // Positive control: the text does name ids, so an empty extraction cannot pass as "no absent id".
      expect(quotedIds(text).length, `${name} names no status id at all`).toBeGreaterThan(0)
      expect(quotedIds(text)).toContain('needs-review')
      expect(absentIds(text)).toEqual([])
    })
  }

  it('the instrument catches the defect it exists for (planted "in_progress")', () => {
    expect(absentIds('Set the status (e.g., "todo", "in_progress", "done")')).toEqual(['in_progress'])
  })
})

describe('the text tells the agent it cannot close', () => {
  it('the description carries the closure rule', () => {
    expect(description).toContain('Never set a closed status')
    expect(description).toContain('refused')
  })

  it('the self-closing steps end at needs-review, not done', () => {
    const section = settingStatusSection()
    const steps = section.slice(section.indexOf('1. Scheduled automation creates a session'))
    expect(steps).toContain('with "needs-review"')
    expect(steps).not.toContain('with "done"')
    // Control: the pattern this assertion negates is spellable in the section's own grammar.
    expect('Agent calls \\`set_session_status\\` with "done"').toContain('with "done"')
  })
})

describe('the status names the shipped docs show exist in the default config (UA12.5)', () => {
  const notDefaultLabels = (labels: string[]): string[] => labels.filter(label => !DEFAULT_LABELS.has(label))

  it('automations.md SessionStatusChange examples name only default status ids', () => {
    const examples = sessionStatusChangeExamples()
    // Positive control: the example cell names ids, so an empty extraction cannot pass as "no absent id".
    expect(examples.length, 'the example cell names no status id at all').toBeGreaterThan(0)
    expect(examples).toContain('done')
    expect(examples.filter(id => !DEFAULT_IDS.has(id))).toEqual([])
  })

  for (const [locale, source, heading] of [
    ['en', conversationsDocs.en, '## Status-Based Organisation'],
    ['ru', conversationsDocs.ru, '## Организация по статусам'],
  ] as const) {
    it(`conversations.md ${locale} status table lists only default statuses`, () => {
      const labels = statusTableLabels(source, heading)
      expect(labels.length, `${locale} status table parsed no rows at all`).toBeGreaterThan(0)
      expect(labels).toContain('Todo')
      expect(notDefaultLabels(labels)).toEqual([])
    })
  }

  it('the inbox group-by-status lines name only default statuses (EN and RU)', () => {
    for (const [locale, source] of Object.entries(conversationsDocs)) {
      const names = groupByStatusNames(source)
      expect(names.length, `${locale} group-by line parsed no status names at all`).toBeGreaterThan(0)
      expect(names).toContain('Todo')
      expect(notDefaultLabels(names)).toEqual([])
    }
  })

  it('the instrument catches the defect it exists for (planted "In Progress")', () => {
    expect(notDefaultLabels(['Todo', 'In Progress'])).toEqual(['In Progress'])
  })
})
