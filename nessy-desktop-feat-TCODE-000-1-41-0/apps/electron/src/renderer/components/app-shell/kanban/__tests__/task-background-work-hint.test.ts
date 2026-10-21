/**
 * UA4.8 — the task editor states the HONEST residue of node completion vs background work (plan UA4.8 "Files": "For
 * the rest, state the residue in the editor help (i18n)"; spec §11 item 4).
 *
 * The host now waits for every background producer it can see (`conductor-host.ts` `isSessionSettled`, `TaskRunner`
 * header item 14). One it cannot see: a codex `spawn_agent` child left running after its parent's turn (the adapter's
 * collab maps are turn-scoped and codex has no between-turns channel). Follow-up 3: the turn the Claude CLI opens itself
 * to deliver a background task's result IS seen (the between-turns door; `ClaudeAgent.backgroundActivityCount` holds
 * the gate through it) — what stays a residue is its OUTPUT: that reply is in the subtask's chat, not its output.
 * Follow-up 4: a codex background command started in the node's LAST turn is counted only once the turn-end
 * `thread/backgroundTerminals/list` refresh lands (fire-and-forget, skipped within 30 s of the previous one —
 * `conductor-host.ts` header), so a door read before it completes the node; the line names that residue too.
 *
 * UA12.99: the codex `spawn_agent` child IS waited for now (`CodexAgent.backgroundActivityCount` counts it; codex
 * queues its report for the parent's next turn), so the line says it is waited for and that its report is not the
 * output. UA12.100: the Claude reply IS the subtask's output (a settled re-check takes a final message written after
 * the door), so the line says so and no longer calls it "not its output".
 *
 * Positive: the editor reads `tasks.backgroundWorkHint` in the subtasks footer, beside `tasks.subtaskFooter` (the
 * control: same file, same instrument), and both locales carry it naming both residues.
 * Negative: the line never promises that every background producer is waited for, and never calls the Claude reply
 * invisible (it says the subtask waits for it).
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..', '..', '..', '..')
const editor = readFileSync(join(REPO, 'apps/electron/src/renderer/components/app-shell/kanban/TaskEditor.tsx'), 'utf-8')
const en = JSON.parse(readFileSync(join(REPO, 'packages/shared/src/i18n/locales/en.json'), 'utf-8')) as Record<string, string>
const ru = JSON.parse(readFileSync(join(REPO, 'packages/shared/src/i18n/locales/ru.json'), 'utf-8')) as Record<string, string>

describe('UA4.8 — the task editor states the background-work residue', () => {
  it('the subtasks footer reads the hint beside the existing footer line', () => {
    expect(editor).toContain("t('tasks.subtaskFooter')")
    expect(editor).toContain("t('tasks.backgroundWorkHint')")
    const footer = editor.indexOf("t('tasks.subtaskFooter')")
    const hint = editor.indexOf("t('tasks.backgroundWorkHint')")
    expect(hint).toBeGreaterThan(footer)
    expect(hint - footer).toBeLessThan(400)
  })

  it('both locales carry it, naming the codex and the Claude residue', () => {
    expect(en['tasks.backgroundWorkHint']).toContain('Codex')
    expect(en['tasks.backgroundWorkHint']).toContain('Claude Code')
    expect(ru['tasks.backgroundWorkHint']).toContain('Codex')
    expect(ru['tasks.backgroundWorkHint']).toContain('Claude Code')
  })

  it('it says the subtask waits for the Claude reply, never that the reply is invisible (follow-up 3)', () => {
    expect(en['tasks.backgroundWorkHint']).not.toMatch(/Two cases are not visible/i)
    expect(en['tasks.backgroundWorkHint']).toMatch(/waits for the reply/i)
    expect(ru['tasks.backgroundWorkHint']).not.toMatch(/Два случая приложение не видит/i)
    expect(ru['tasks.backgroundWorkHint']).toMatch(/ждёт ответа/i)
  })

  it('it names the codex background command started in the last turn (follow-up 4)', () => {
    expect(en['tasks.backgroundWorkHint']).toMatch(/background command started in the subtask's last turn/i)
    expect(ru['tasks.backgroundWorkHint']).toMatch(/фоновую команду, запущенную в последнем ходе/i)
  })

  it('UA12.156: it scopes a scheduled wake-up to a self-paced /loop — a bare wake call is refused and schedules nothing', () => {
    // SIT-D F6's W/pi-wakeup reading corrected: the child's bare `ScheduleWakeup` was refused ("No
    // self-paced /loop is active in this session."), nothing was armed and the node finished at its
    // turn's end — correct, but a surprise unless the hint says a wake exists only inside a /loop.
    expect(en['tasks.backgroundWorkHint']).toMatch(/self-paced \/loop/i)
    expect(en['tasks.backgroundWorkHint']).toMatch(/refused/i)
    expect(ru['tasks.backgroundWorkHint']).toMatch(/самоуправляемого цикла \/loop/)
    expect(ru['tasks.backgroundWorkHint']).toMatch(/отказ/i)
  })

  it('UA12.99: the codex agent left running is waited for, and its report is not the output', () => {
    expect(en['tasks.backgroundWorkHint']).toMatch(/an agent left running after its turn is waited for/i)
    expect(en['tasks.backgroundWorkHint']).not.toMatch(/two cases can be missed/i)
    expect(ru['tasks.backgroundWorkHint']).toMatch(/агента, оставленного работать после хода, подзадача ждёт/)
    expect(ru['tasks.backgroundWorkHint']).not.toMatch(/может пропустить два случая/)
  })

  it('UA12.100: the Claude reply written after a background task ends is the subtask\'s output', () => {
    expect(en['tasks.backgroundWorkHint']).toMatch(/waits for the reply written after a background task ends, and that reply is its output/i)
    expect(en['tasks.backgroundWorkHint']).not.toMatch(/stays in its chat and is not its output/i)
    expect(ru['tasks.backgroundWorkHint']).toMatch(/и этот ответ становится её результатом/)
    expect(ru['tasks.backgroundWorkHint']).not.toMatch(/остаётся в её чате и не становится её результатом/)
  })

  it('it never promises that every background producer is waited for', () => {
    for (const text of [en['tasks.backgroundWorkHint']!, ru['tasks.backgroundWorkHint']!]) {
      expect(text).not.toMatch(/\b(all|every|any)\b background/i)
      expect(text).not.toMatch(/(всей|любой|всех) фонов/i)
    }
  })
})
