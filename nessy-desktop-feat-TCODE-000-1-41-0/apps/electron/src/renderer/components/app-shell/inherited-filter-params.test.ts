/* Copied from v0.13.4:apps/electron/src/renderer/components/app-shell/inherited-filter-params.test.ts (craft-agents-oss, Apache-2.0) by
   UA5.9, 2026-10-02, verbatim. */
/* UA12.163 (2026-10-04) — the arms below thread the REQUIRED isLiveLabel predicate the rule now
   takes (the upstream suite's three-argument calls predate it); the UA12.163 describe at the end
   is new, not upstream. */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveInheritedFilterParams, type FilterMode } from './inherited-filter-params'

const m = (...entries: [string, FilterMode][]) => new Map(entries)
/** Every id is live — the liveness the upstream arms assume. */
const live = () => true

describe('resolveInheritedFilterParams (#970)', () => {
  it('inherits a sole include-mode status', () => {
    expect(resolveInheritedFilterParams(m(['todo', 'include']), m(), m(), live)).toEqual({ status: 'todo' })
  })

  it('does NOT inherit an excluded status (the bug)', () => {
    // With only `Done → exclude`, a new session must fall back to the workspace
    // default, not be created as Done.
    expect(resolveInheritedFilterParams(m(['done', 'exclude']), m(), m(), live)).toBeNull()
  })

  it('counts only includes — a single include alongside an exclude still inherits the include', () => {
    expect(resolveInheritedFilterParams(m(['todo', 'include'], ['done', 'exclude']), m(), m(), live)).toEqual({ status: 'todo' })
  })

  it('returns null for multiple includes (ambiguous)', () => {
    expect(resolveInheritedFilterParams(m(['todo', 'include'], ['wip', 'include']), m(), m(), live)).toBeNull()
  })

  it('inherits a sole include label or project', () => {
    expect(resolveInheritedFilterParams(m(), m(['bug', 'include']), m(), live)).toEqual({ label: 'bug' })
    expect(resolveInheritedFilterParams(m(), m(), m(['proj1', 'include']), live)).toEqual({ project: 'proj1' })
  })

  it('returns null with no filters', () => {
    expect(resolveInheritedFilterParams(m(), m(), m(), live)).toBeNull()
  })

  it('returns null for cross-dimension ambiguity (one status + one label include)', () => {
    expect(resolveInheritedFilterParams(m(['todo', 'include']), m(['bug', 'include']), m(), live)).toBeNull()
  })
})

/**
 * UA12.163 — the label half of the inherit rule prunes DEAD label ids before counting. The two
 * list consumers prune since UA12.154 (expandLabelFilterIds), but this rule still read the raw
 * persisted map, so in the SIT-D F4 state (a sole include of a label since deleted) a new chat
 * inherited `{ label: <dead-id> }` — a label that does not exist. The caller threads the same
 * liveness the list consumers use (AppShell passes `expandLabelFilterIds(labelConfigs, id)
 * .length > 0`); the predicate is a REQUIRED parameter, so a caller cannot silently re-create
 * the defect by forgetting it.
 *
 * These arms were written FIRST and fail at HEAD, where the extra argument is ignored and the
 * dead id is inherited verbatim.
 */
describe('UA12.163 — a dead label include is not inherited (the SIT-D F4 state)', () => {
  /** The liveness AppShell threads: a label the config still carries. */
  const liveLabels = (...ids: string[]) => (id: string) => ids.includes(id)

  it('CONTROL — the F4 state: a sole include of a dead label inherits NOTHING (no labels on the new chat)', () => {
    expect(resolveInheritedFilterParams(m(), m(['gone', 'include']), m(), liveLabels())).toBeNull()
  })

  it('BOUNDARY — a dead include does not create ambiguity: live label + dead label inherits the live one', () => {
    expect(resolveInheritedFilterParams(m(), m(['bug', 'include'], ['gone', 'include']), m(), liveLabels('bug'))).toEqual({ label: 'bug' })
  })

  it('POSITIVE — a live label include still inherits (the predicate changes nothing for live ids)', () => {
    expect(resolveInheritedFilterParams(m(), m(['bug', 'include']), m(), liveLabels('bug'))).toEqual({ label: 'bug' })
  })

  it('BOUNDARY — a dead EXCLUDE was already inert and stays inert', () => {
    expect(resolveInheritedFilterParams(m(), m(['gone', 'exclude']), m(), liveLabels())).toBeNull()
  })

  it('WIRING — AppShell threads the same prune the list consumers use (expandLabelFilterIds)', () => {
    // No DOM in this repo's `bun test`: the caller half is a source scan, the same two-headed
    // shape as UA12.145's page-toast pin and UA12.162's wiring arms.
    const appShell = readFileSync(join(import.meta.dir, 'AppShell.tsx'), 'utf8')
    expect(appShell).toContain('resolveInheritedFilterParams(')
    expect(appShell).toContain('(id) => expandLabelFilterIds(labelConfigs, id).length > 0')
  })
})
