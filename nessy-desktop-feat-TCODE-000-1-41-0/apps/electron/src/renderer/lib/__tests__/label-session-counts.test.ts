/**
 * F1.357 — the sidebar count on a parent label counted a chat TWICE when the
 * chat carried both the parent label and one of its descendants.
 *
 * AppShell's `labelCounts` set a direct count in one pass and then ADDED a
 * descendant count over an overlapping set in a second, while the `label`
 * filter lists the chat once (one `{label, ...descendants}` union). The count
 * now goes through the same predicate the list does (`matchesLabelFilter`),
 * once per label.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import type { LabelConfig } from '@nessy-agent/shared/labels'
import { countSessionsPerLabel } from '../label-session-counts'

const TREE: LabelConfig[] = [
  { id: 'parent', name: 'Parent', children: [{ id: 'child', name: 'Child' }] },
  { id: 'priority', name: 'Priority', valueType: 'number' },
] as LabelConfig[]

describe('F1.357 — one count per label, over the rule the list filters by', () => {
  it('positive — one chat tagged parent AND child counts 1 on the parent and 1 on the child', () => {
    const counts = countSessionsPerLabel([{ labels: ['parent', 'child'] }], TREE)
    expect(counts.parent).toBe(1)
    expect(counts.child).toBe(1)
  })

  it('negative — two chats, one per label, count 2 on the parent (descendants still roll up)', () => {
    const counts = countSessionsPerLabel([{ labels: ['parent'] }, { labels: ['child'] }], TREE)
    expect(counts.parent).toBe(2)
    expect(counts.child).toBe(1)
  })

  it('valued entries count by base id, and an unlabelled chat counts nowhere', () => {
    const counts = countSessionsPerLabel([{ labels: ['priority::3'] }, { labels: [] }, {}], TREE)
    expect(counts.priority).toBe(1)
    expect(counts.parent).toBe(0)
  })

  it('AppShell\'s labelCounts is this helper, not a second copy of the rule', () => {
    const appShell = readFileSync(
      fileURLToPath(new URL('../../components/app-shell/AppShell.tsx', import.meta.url)),
      'utf-8',
    )
    expect(appShell).toContain('countSessionsPerLabel(activeSessionMetas, labelConfigs)')
    expect(appShell).not.toContain('const descendantCount = activeSessionMetas.filter(')
  })
})
