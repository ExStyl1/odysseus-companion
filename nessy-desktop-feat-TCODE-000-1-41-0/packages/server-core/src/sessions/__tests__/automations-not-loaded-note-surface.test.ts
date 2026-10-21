/**
 * F1.494 (origin WJ-vv P-WJ-vv-1) — an `automations.json` that did not load
 * reaches a session as text a person reads.
 *
 * The note itself is pinned where it is produced
 * (`packages/shared/src/automations/automations-json-refusal-note.test.ts`).
 * What this file pins is the SURFACE: `SessionManager.warnHooksConfigNotes`'
 * message expression, read from the source exactly as F1.456's arms read it
 * (`hooks-config-notes-surface.test.ts`), evaluated over a real
 * `AutomationSystem`'s `configWarnings`. Before F1.494 neither arm had an
 * `automations.json` line to render: the producer's own arms were red at the
 * parent (no note at load, none after a refused reload), so arm 1's array was
 * empty — the method returns before sending — and arm 2's held the hook note alone.
 */
import { describe, expect, test } from 'bun:test'
import { bracedRegion } from '@nessy-agent/shared/testing/source-regions'
import { AutomationSystem } from '@nessy-agent/shared/automations'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SESSION_MANAGER = new URL('../SessionManager.ts', import.meta.url).pathname

async function renderLeadIn(): Promise<(notes: readonly string[]) => string> {
  const src = await Bun.file(SESSION_MANAGER).text()
  const body = bracedRegion(src, src.indexOf('private warnHooksConfigNotes'))
  // BOUNDARY CONTROL: the region is that method, not the rest of the file.
  expect(body).not.toContain('private async getOrCreateAgent(')
  const from = body.indexOf('message:')
  expect(from).toBeGreaterThan(0)
  const expr = body.slice(from + 'message:'.length, body.indexOf('}, managed.workspace.id)', from)).trim().replace(/,$/, '')
  return new Function('notes', `return ${expr}`) as (notes: readonly string[]) => string
}

const structurallyInvalid = JSON.stringify({ automations: { LabelAdd: [{ matcher: 'test', actions: 'not-an-array' }] } })

describe('F1.494 — the automations.json note on the session surface', () => {
  test('at load: an invalid automations.json alone is one note under the singular lead-in', async () => {
    const render = await renderLeadIn()
    const dir = mkdtempSync(join(tmpdir(), 'f1494-surface-'))
    try {
      writeFileSync(join(dir, 'automations.json'), structurallyInvalid)
      const system = new AutomationSystem({ workspaceRootPath: dir, workspaceId: 'f1494' })
      try {
        const lines = render(system.configWarnings).split('\n')
        expect(lines).toHaveLength(2)
        expect(lines[0]).toBe('Your hooks and automations configuration has one note. It says what it affects:')
        expect(lines[1]).toStartWith('- automations.json did not load (automations.LabelAdd.0.actions: ')
        expect(lines[1]).toEndWith('); no automations from it are in effect')
      } finally {
        await system.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a refused reload beside a broken hooks.json: two notes, the refusal first, under the plural lead-in', async () => {
    const render = await renderLeadIn()
    const dir = mkdtempSync(join(tmpdir(), 'f1494-surface-'))
    try {
      writeFileSync(join(dir, 'automations.json'), JSON.stringify({
        automations: { LabelAdd: [{ matcher: 'test', actions: [{ type: 'prompt', prompt: 'first' }] }] },
      }))
      writeFileSync(join(dir, 'hooks.json'), '{ "hooks": ')
      const system = new AutomationSystem({ workspaceRootPath: dir, workspaceId: 'f1494' })
      try {
        // CONTROL: before the edit, the one note is the hook document's.
        expect(render(system.configWarnings).split('\n')[0]).toBe('Your hooks and automations configuration has one note. It says what it affects:')
        writeFileSync(join(dir, 'automations.json'), '{ "automations": ')
        expect(system.reloadConfig().success).toBe(false)
        const lines = render(system.configWarnings).split('\n')
        expect(lines).toHaveLength(3)
        expect(lines[0]).toBe('Your hooks and automations configuration has 2 notes. Each says what it affects:')
        expect(lines[1]).toStartWith('- automations.json did not load (Failed to parse JSON: ')
        expect(lines[1]).toEndWith('); the previous automations stay in effect')
        expect(lines[2]).toStartWith('- hooks.json: ')
      } finally {
        await system.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
