/**
 * C3.307 — the hook and automation config notes have a user-facing surface.
 *
 * ## The state this closes
 *
 * `HooksLoadResult.warnings` exists because C3.90 refused to widen
 * `reloadConfig`'s failure test, and C3.284 then moved two more notes onto it
 * after measuring that a portable hook with no producer here turned every
 * automation in the workspace off on the next reload. So the array now carries
 * notes an author needs — and `AutomationSystem.warnConfig`'s only outlet was
 * `console.warn`, which for a document authored by hand is the one place its
 * author never looks.
 *
 * ## Why the source is the instrument HERE
 *
 * The retention and the reset-per-read are behavioural and are pinned where
 * they live, in `packages/shared/src/automations/automation-system.test.ts`
 * (`C3.307: the non-fatal notes are retained…` and its control). What no test
 * over there can see is whether anything READS the getter — which is the whole
 * of this row, and exactly the shape P6.167's docblock calls out: *"a reader
 * with no call site is the defect this file exists for"*.
 *
 * Every read is paired with a positive control proving it found real code.
 */
import { describe, expect, test } from 'bun:test'
import { bracedRegion } from '@nessy-agent/shared/testing/source-regions'
import { AutomationSystem } from '@nessy-agent/shared/automations'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SESSION_MANAGER = new URL('../SessionManager.ts', import.meta.url).pathname

async function manager(): Promise<string> {
  return await Bun.file(SESSION_MANAGER).text()
}

describe('C3.307 — the config notes reach a session', () => {
  test('the host reads the retained notes and raises them on the warning seam', async () => {
    const src = await manager()
    expect(src).toContain('private warnHooksConfigNotes(managed: ManagedSession): void')
    expect(src).toContain('this.automationSystems.get(managed.workspace.id)?.configWarnings ?? []')
    // Raised from the agent-construction slice every runtime passes through,
    // beside its C3.18 sibling — which is the POSITIVE CONTROL that the slice
    // this asserts about is the one that still exists.
    expect(src).toContain('this.warnHooksConfigNotes(managed)')
    expect(src).toContain('this.warnIfProjectSettingsWidenDefaultMode(managed)')
    const call = src.indexOf('this.warnHooksConfigNotes(managed)')
    const sibling = src.indexOf('this.warnIfProjectSettingsWidenDefaultMode(managed)')
    expect(call).toBeGreaterThan(0)
    expect(Math.abs(call - sibling)).toBeLessThan(800)
  })

  test('one event for the whole list, latched, and machine-readable first', async () => {
    const src = await manager()
    const start = src.indexOf('private warnHooksConfigNotes')
    expect(start).toBeGreaterThan(0)
    // D1.111 — the method's own braces, not 2 200 characters of it. The count
    // assertion below is the one a too-WIDE window silently breaks: a second
    // `sendEvent` from the next method would read as this one emitting twice.
    const body = bracedRegion(src, start)
    // BOUNDARY CONTROL: the region is that method and not the rest of the file.
    // The anchor is the NEXT declaration — `warnIfProjectSettingsWidenDefaultMode`
    // sits above this method and would make the line pass on a runaway scan.
    expect(body).not.toContain('private async getOrCreateAgent(')
    // One `sendEvent` however many notes there are: four warning banners for
    // four lines of one file is the crowding-out shape P6.167 names.
    expect(body.split('this.sendEvent({').length - 1).toBe(1)
    expect(body).toContain("level: 'warning',")
    expect(body).toContain("sessionLog.warn('hooks_config_notes_surfaced'")
    // Latched per session per note set, so a reload that changes the set says so
    // once and an unchanged set never repeats.
    expect(body).toContain('if (this.hooksConfigNoteNotices.has(noticeKey)) return')
    expect(body).toContain('this.hooksConfigNoteNotices.add(noticeKey)')
    // NEGATIVE: silent when the documents carry no note. Without this the
    // surface is a banner every session shows.
    expect(body).toContain('if (notes.length === 0) return')
  })

  test('the lead-in claims less than any note, and the notes carry their own text', async () => {
    const src = await manager()
    const start = src.indexOf('private warnHooksConfigNotes')
    expect(start).toBeGreaterThan(0)
    const body = bracedRegion(src, start)
    expect(body).not.toContain('private async getOrCreateAgent(')
    // Read the MESSAGE EXPRESSION, not the method body. The comment beside the
    // message explains the trap by spelling the phrase it refuses, so a negative
    // over the whole body would fail against correct code — the stale-NAME shape
    // AGENTS.md §Traps describes, met once while writing this file.
    const from = body.indexOf('message:')
    const message = body.slice(from, body.indexOf('}, managed.workspace.id)', from))
    expect(from).toBeGreaterThan(0)
    // Every validation warning of automations.json and the hook documents reaches
    // here, plus (F1.229) a hook document that did not load — not one kind of
    // thing (F1.458). A lead-in claiming they all never run would be false of a
    // comma in a matcher or a `bypassPermissions` mode.
    // F1.269 — the lead-in used to add "Nothing failed and nothing was
    // disabled". Since F1.229 a hook-document ERROR note can arrive under it,
    // so that clause could be false of the very list it introduced; the lead-in
    // now claims only what every note does. Red at the parent on the first two.
    expect(message).toContain('Each says what it affects:')
    // F1.457 — both halves of the old clause, in any case: negating only
    // 'Nothing failed' let a re-added ' Nothing was disabled.' pass every pin.
    expect(message).not.toMatch(/nothing (failed|was disabled)/i)
    expect(message).not.toContain('never run')
    expect(message).not.toContain('will not do what they say')
    // The notes go through verbatim: each already names its own source file and
    // its own reason, and re-wording them here would be a second place to keep
    // four sentences correct.
    expect(message).toContain('notes.map(note => `- ${note}`).join(')
  })
})

/**
 * F1.456 (origin WJ-ii verifier on F1.269, F1.269a) — the lead-in makes NO load
 * claim. "…configuration loaded with one note" sat over F1.229's "this hook
 * document did not load as written"; with only a broken `hooks.json` and no
 * `automations.json`, nothing loaded at all. The MESSAGE EXPRESSION is read from
 * the source and evaluated over a real `AutomationSystem`'s `configWarnings`, so
 * the pin is the text a person reads, singular and plural both.
 */
describe('F1.456 — the lead-in over a real note list', () => {
  async function renderLeadIn(): Promise<(notes: readonly string[]) => string> {
    const src = await manager()
    const body = bracedRegion(src, src.indexOf('private warnHooksConfigNotes'))
    // Boundary control: the declaration right BELOW the method, so a runaway region fails here.
    expect(body).not.toContain('private readonly hooksConfigNoteNotices')
    const from = body.indexOf('message:')
    const expr = body.slice(from + 'message:'.length, body.indexOf('}, managed.workspace.id)', from)).trim().replace(/,$/, '')
    return new Function('notes', `return ${expr}`) as (notes: readonly string[]) => string
  }

  async function notesFor(files: Record<string, string>): Promise<readonly string[]> {
    const dir = mkdtempSync(join(tmpdir(), 'f1456-'))
    try {
      for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
      const system = new AutomationSystem({ workspaceRootPath: dir, workspaceId: 'f1456' })
      try {
        return [...system.configWarnings]
      } finally {
        await system.dispose()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a broken hooks.json alone: one note that did not load, under a lead-in that claims no load', async () => {
    const render = await renderLeadIn()
    const notes = await notesFor({ 'hooks.json': '{ "hooks": ' })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('did not load')
    const text = render(notes)
    expect(text).not.toContain('loaded')
    expect(text.split('\n')[0]).toBe('Your hooks and automations configuration has one note. It says what it affects:')
  })

  test('CONTROL: a cron-only note and a two-note list render singular and plural', async () => {
    const render = await renderLeadIn()
    const cron = await notesFor({
      'automations.json': JSON.stringify({ automations: { LabelAdd: [{ cron: '0 9 * * *', actions: [{ type: 'prompt', prompt: 'hi' }] }] } }),
    })
    expect(cron.some(note => note.includes('Cron expressions are only used for SchedulerTick events'))).toBe(true)
    expect(render(cron).split('\n')[0]).toBe(`Your hooks and automations configuration has ${cron.length === 1 ? 'one note. It' : `${cron.length} notes. Each`} says what it affects:`)
    expect(render(['a', 'b'])).toBe('Your hooks and automations configuration has 2 notes. Each says what it affects:\n- a\n- b')
  })
})
