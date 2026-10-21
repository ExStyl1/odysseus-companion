/**
 * UA5.9 — the session list's `'project'` grouping and the bound row (craft-agents-oss v0.13.4 SessionList.tsx and
 * SessionItem.tsx project hunks, Apache-2.0).
 *
 * POSITIVE: rows are grouped by `projectId`, configured projects in registration order, each group newest first; a
 * collapsed group comes back as a header-only placeholder; "collapse all" collapses every group key.
 * NEGATIVE: a session whose project no longer exists (deleted, or of another workspace) and a session with no
 * project both land under "No project", which sinks to the bottom; a single bucket is not collapsible.
 * KEEP OURS (plan UA5.9): after the port the session row still wires the last-output line, the waiting label, the
 * server-fed shield and Allow once / Deny (read from its code: the row cannot render under bun, see below), gains the
 * project stripe (rendered), name and menu, and carries no messaging pill (`hasMessagingBinding`, `PLATFORM_PILL`;
 * messaging is removed in ours).
 */
import { describe, expect, it } from 'bun:test'
import * as React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  groupSessionRowsByProject,
  projectGroupKeys,
  NO_PROJECT_GROUP_KEY,
  type SessionListProjectOption,
} from '../session-list-project-groups'

const PROJECTS: SessionListProjectOption[] = [
  { id: 'proj_a', slug: 'alpha', name: 'Alpha', color: '#6366f1' },
  { id: 'proj_b', slug: 'beta', name: 'Beta' },
]
const LABELS = { noProject: 'No project', unknownProject: 'Unknown project' }
const row = (id: string, projectId: string | undefined, lastMessageAt: number) => ({ item: { id, projectId, lastMessageAt } })

describe('UA5.9 — grouping by project', () => {
  it('POSITIVE: rows bucket by projectId, projects in registration order, newest first inside a group', () => {
    const rows = [row('s1', 'proj_b', 10), row('s2', 'proj_a', 5), row('s3', 'proj_a', 20), row('s4', undefined, 30)]
    const { groups, rows: ordered } = groupSessionRowsByProject(rows, PROJECTS, [], LABELS)
    expect(groups.map(g => [g.key, g.label])).toEqual([
      ['project-proj_a', 'Alpha'],
      ['project-proj_b', 'Beta'],
      [NO_PROJECT_GROUP_KEY, 'No project'],
    ])
    expect(groups[0]!.items.map(r => r.item.id)).toEqual(['s3', 's2'])
    expect(ordered.map(r => r.item.id)).toEqual(['s3', 's2', 's1', 's4'])
    expect(groups.every(g => g.collapsible)).toBe(true)
  })

  it('NEGATIVE: a deleted project\'s sessions show under "No project", never under a stale header', () => {
    const rows = [row('s1', 'proj_deleted', 10), row('s2', 'proj_a', 5)]
    const { groups } = groupSessionRowsByProject(rows, PROJECTS, [], LABELS)
    expect(groups.map(g => g.key)).toEqual(['project-proj_a', NO_PROJECT_GROUP_KEY])
    expect(groups[1]!.items.map(r => r.item.id)).toEqual(['s1'])
    expect(groups.some(g => g.label.includes('proj_deleted'))).toBe(false)
  })

  it('BOUNDARY: a collapsed group is a header-only placeholder with its count; a lone bucket is not collapsible', () => {
    const { groups } = groupSessionRowsByProject([row('s1', 'proj_a', 1)], PROJECTS, [{ key: 'project-proj_b', count: 3 }], LABELS)
    expect(groups.find(g => g.key === 'project-proj_b')).toMatchObject({ items: [], collapsedCount: 3, label: 'Beta' })
    const lone = groupSessionRowsByProject([row('s1', undefined, 1)], PROJECTS, [], LABELS)
    expect(lone.groups).toHaveLength(1)
    expect(lone.groups[0]!.collapsible).toBe(false)
  })

  it('POSITIVE: "collapse all" collapses one key per bucket, an unknown project folding into "No project"', () => {
    expect(projectGroupKeys([{ projectId: 'proj_a' }, { projectId: 'gone' }, {}], PROJECTS))
      .toEqual(new Set(['project-proj_a', NO_PROJECT_GROUP_KEY]))
  })
})

describe('UA12.121 — the collapse key resolves a stale projectId the way the grouping does', () => {
  // The grouping (`groupSessionRowsByProject`) buckets a session whose project no longer exists under
  // "No project" (the NEGATIVE arm above), while `useSessionSearch.getCollapseGroupKey` keyed it
  // blindly as `project-<gone>` — collapsing "No project" left those rows paginated. The list hands
  // the hook the workspace's projects (`knownProjects`), and the key routes through
  // `projectGroupKeyOf` (behaviour arms on the pure seam: `hooks/__tests__/useSessionSearch.test.ts`).
  const list = code('SessionList.tsx')

  it('POSITIVE — the hook options carry the workspace\'s projects', () => {
    expect(list).toContain('groupingMode, knownProjects: projects,')
  })

  // Follow-up (2026-10-08 verification, findings/UA12.121.md): the CONTROL that stood here dropped every line
  // holding the needle and then asserted the needle absent — true of ANY input, so it proved nothing about the
  // scanner. The two controls below run the scanner's own stripper and can fail on it.
  it('CONTROL — the scanner drops the needle when it sits only in a comment (a commented-out wiring is not wiring)', () => {
    expect(stripComments('  // groupingMode, knownProjects: projects,\n')).not.toContain('groupingMode, knownProjects: projects,')
    expect(stripComments('  /* groupingMode, knownProjects: projects, */\n')).not.toContain('groupingMode, knownProjects: projects,')
  })

  it('CONTROL — the scanner keeps the needle on a code line that carries a trailing comment', () => {
    expect(stripComments('  groupingMode, knownProjects: projects, // note\n')).toContain('groupingMode, knownProjects: projects,')
  })
})

// --- the bound row --------------------------------------------------------------------------------------------
//
// SessionItem cannot be rendered under `bun test`: its module graph reaches pdfjs's Vite-only `?url` import
// ("Missing 'default' export in module …pdf.worker.min.mjs?url", measured 2026-10-02, 74 s). So the stripe is
// RENDERED through the wrapper the row uses, and the row's own wiring is read from its CODE (comments stripped),
// each needle with a planted-removal control on the same scanner.

const APP_SHELL_DIR = join(import.meta.dir, '..')
function code(file: string): string {
  return stripComments(readFileSync(join(APP_SHELL_DIR, file), 'utf8'))
}
/** The scanner's comment stripper, separate so its controls run on it directly (UA12.121 follow-up). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
}

/** What the row must keep after the port (plan UA5.9 "Keep ours"), and what the port adds. */
const ROW_KEEPS = [
  'const activityLineNode = item.lastOutputSummary', // P6.504 — the last-output line
  // UB14.3 (v0.15.1 anatomy) — the activity line is the subtitle's last resort, after the run state, the decision
  // verdict and the labels; the waiting label moved from the marker strip onto the run-state line.
  'const subtitle = runStateLine ?? decisionLineNode ?? (showLabels ? undefined : activityLineNode)',
  "const runStateLabel = runState === 'needs-you' || runState === 'working' ? attentionLabel : undefined",
  'title={runStateLabel}', // P6.270 / P6.764 — the waiting label
  "role={runStateLabel ? 'status' : undefined}",
  'const hasPendingPrompt = sessionAwaitsApproval(item, hasLocalPendingPrompt)', // P6.757 — the server-fed "needs you"
  '<SessionRowPermissionAnswer', // P6.589 — Allow once / Deny
] as const
const ROW_ADDS = [
  '<SessionProjectColorWrapper color={projectColor} treatment={projectColorTreatment}>',
  'suppressSelectionBar={!!projectColor}',
  'titleSuffix={projectName ? (',
  'onSetProjectId={ctx.onSetProjectId ? (pid) => ctx.onSetProjectId!(item.id, pid) : undefined}',
] as const

describe('UA5.9 — the bound row keeps ours', () => {
  it('POSITIVE: the row keeps the last-output line, the waiting label, the shield and Allow once / Deny, and gains the project stripe, name and menu', () => {
    const item = code('SessionItem.tsx')
    for (const needle of [...ROW_KEEPS, ...ROW_ADDS]) expect(item).toContain(needle)
    // The session menu keeps ours too (P6.703 memory scope, "Revert Last File Edit") and renders the Projects submenu.
    const menu = code('SessionMenu.tsx')
    expect(menu).toContain('<SessionMemoryScopeMenuItems')
    expect(menu).toContain('<Undo2')
    expect(menu).toContain('<SessionProjectMenuItems projectId={item.projectId} projects={projects} onSetProjectId={onSetProjectId} />')
  })

  it('CONTROL: each kept needle is missed on the code with its line removed', () => {
    const item = code('SessionItem.tsx')
    for (const needle of ROW_KEEPS) {
      const removed = item.split('\n').filter(line => !line.includes(needle)).join('\n')
      expect(removed).not.toContain(needle)
    }
  })

  it('NEGATIVE: no messaging pill comes back with the project hunk', () => {
    const src = code('SessionItem.tsx')
    expect(src).not.toMatch(/hasMessagingBinding|PLATFORM_PILL|messagingBindings/)
    // control: the scanner finds the needle when planted
    expect(`${src}\nconst x = PLATFORM_PILL`).toMatch(/hasMessagingBinding|PLATFORM_PILL|messagingBindings/)
  })

  it('POSITIVE (rendered): a coloured project draws the stripe, "stripe-tint" adds the tint; no colour draws nothing', async () => {
    const { SessionProjectColorWrapper } = await import('../SessionProjectColorWrapper')
    const h = React.createElement
    const stripe = renderToStaticMarkup(h(SessionProjectColorWrapper, { color: '#6366f1', treatment: 'stripe', children: h('span', null, 'row') }))
    expect(stripe).toContain('background-color:#6366f1')
    expect(stripe).not.toContain('color-mix')
    const tint = renderToStaticMarkup(h(SessionProjectColorWrapper, { color: '#6366f1', treatment: 'stripe-tint', children: h('span', null, 'row') }))
    expect(tint).toContain('color-mix(in srgb, #6366f1 6%, transparent)')
    expect(renderToStaticMarkup(h(SessionProjectColorWrapper, { color: undefined, treatment: 'stripe-tint', children: h('span', null, 'row') })))
      .toBe('<span>row</span>')
  })
})
