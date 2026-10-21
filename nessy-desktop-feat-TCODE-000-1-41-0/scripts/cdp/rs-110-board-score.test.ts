/**
 * RS-110 (UA2.7) - the board case's scorers, and the three renderer facts it
 * restates because a case may not import the renderer's module graph.
 *
 * - `tileVerdict`: an unrendered tile FAILS (never "no badge, so it is absent"),
 *   and every wanted field is compared.
 * - `dropVerdict`: a drop is the placement AND the status the drop should or
 *   should not have applied.
 * - `RUNTIME_CHIP_LABEL`, `BOARD_COLUMNS` and `DROP_STATUS_STORAGE_KEY` are read
 *   back out of the renderer SOURCE they restate (`runtime-switch-copy.ts`
 *   `RUNTIME_LABELS`, `status-column.ts` `KANBAN_COLUMNS`, `atoms/kanban.ts`
 *   `kanbanColumnStatusAtom`), so a rename there turns this file red instead of
 *   leaving the case reading a key or a label the app no longer writes.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BOARD_COLUMNS, DROP_STATUS_STORAGE_KEY, dropVerdict, RUNTIME_CHIP_LABEL, tileVerdict,
} from './cases/rs-110.ts'

const RENDERER = join(import.meta.dir, '..', '..', 'apps', 'electron', 'src', 'renderer')
const source = (path: string): string => readFileSync(join(RENDERER, path), 'utf8')

describe('RS-110: tileVerdict', () => {
  it('passes a tile in the wanted column with the badge and the runtime chip', () => {
    const verdict = tileVerdict({ column: 'todo', needsInput: true, runtime: 'Codex' }, { column: 'todo', needsInput: true, runtime: 'Codex' })
    expect(verdict.ok).toBe(true)
  })

  it('fails a tile the board does not render, whatever was wanted of it', () => {
    const verdict = tileVerdict(null, { needsInput: false })
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toStartWith('tile-not-rendered')
  })

  it('fails a missing badge, a badge that stayed, a wrong chip and a wrong column - each named', () => {
    expect(tileVerdict({ column: 'todo', needsInput: false, runtime: 'Pi' }, { needsInput: true }).detail).toContain('no needs-input badge')
    expect(tileVerdict({ column: 'todo', needsInput: true, runtime: 'Pi' }, { needsInput: false }).detail).toContain('still shown')
    expect(tileVerdict({ column: 'todo', needsInput: true, runtime: 'Pi' }, { runtime: 'Claude' }).ok).toBe(false)
    expect(tileVerdict({ column: 'todo', needsInput: false, runtime: null }, { column: 'done' }).ok).toBe(false)
  })
})

describe('RS-110: dropVerdict', () => {
  it('passes a record placed in Done whose status is the one the drop should leave', () => {
    expect(dropVerdict({ found: true, kanbanColumn: 'done', sessionStatus: 'done' }, { column: 'done', status: 'done' }).ok).toBe(true)
    expect(dropVerdict({ found: true, kanbanColumn: 'done', sessionStatus: 'todo' }, { column: 'done', status: 'todo' }).ok).toBe(true)
  })

  it('fails a drop that did not place, a status a mapping did not apply, one an absent mapping changed, and a gone record', () => {
    expect(dropVerdict({ found: true, kanbanColumn: null, sessionStatus: 'done' }, { column: 'done', status: 'done' }).ok).toBe(false)
    expect(dropVerdict({ found: true, kanbanColumn: 'done', sessionStatus: 'todo' }, { column: 'done', status: 'done' }).ok).toBe(false)
    expect(dropVerdict({ found: true, kanbanColumn: 'done', sessionStatus: 'done' }, { column: 'done', status: 'todo' }).ok).toBe(false)
    expect(dropVerdict({ found: false, kanbanColumn: 'done', sessionStatus: 'done' }, { column: 'done', status: 'done' }).ok).toBe(false)
  })
})

describe('RS-110: the renderer facts the case restates', () => {
  it('names each runtime chip as runtime-switch-copy.ts RUNTIME_LABELS does', () => {
    const copy = source('components/app-shell/input/runtime-switch-copy.ts')
    const block = copy.slice(copy.indexOf('const RUNTIME_LABELS'), copy.indexOf('}', copy.indexOf('const RUNTIME_LABELS')))
    // The anti-vacuum control: a slice that missed the constant reads as an empty block.
    expect(block).toContain('RUNTIME_LABELS')
    expect(block).toContain(`pi: '${RUNTIME_CHIP_LABEL.pi}'`)
    expect(block).toContain(`anthropic: '${RUNTIME_CHIP_LABEL.claude}'`)
    expect(block).toContain(`'codex-runtime': '${RUNTIME_CHIP_LABEL.codex}'`)
    expect(block).not.toContain(`pi: '${RUNTIME_CHIP_LABEL.claude}'`)
  })

  it('reads the board columns in status-column.ts KANBAN_COLUMNS order', () => {
    const columns = source('components/app-shell/kanban/status-column.ts')
    const block = columns.slice(columns.indexOf('export const KANBAN_COLUMNS'), columns.indexOf('] as const'))
    const ids = [...block.matchAll(/\{ id: '([^']+)'/g)].map(match => match[1])
    expect(ids).toEqual([...BOARD_COLUMNS])
    expect(ids).not.toEqual([...BOARD_COLUMNS].reverse())
  })

  it('reads the drop-status map under the key kanbanColumnStatusAtom persists', () => {
    const atoms = source('atoms/kanban.ts')
    const at = atoms.indexOf('export const kanbanColumnStatusAtom')
    expect(at).toBeGreaterThan(-1)
    // The atom's own declaration: from its name to the next export, never a fixed-size window.
    const declaration = atoms.slice(at, atoms.indexOf('export ', at + 1))
    expect(declaration).toContain(`'${DROP_STATUS_STORAGE_KEY}'`)
    // The neighbouring colour map is a different key - the control that the region is the atom's own.
    expect(declaration).not.toContain("'nessy-kanban-column-colors'")
  })
})
