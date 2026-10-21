/**
 * F1.412 + F1.415 (origin: the WJ-ff verifier on F1.259) — the two F1.259 notes
 * name the door `approve_plan` really goes through, and say what no runtime but
 * Pi has.
 *
 * F1.259 deleted `SessionManager.acceptPlan` and left a note in `SessionManager.ts`
 * and one in `session-manager-interface.ts` saying a plan is approved through
 * Pi's `approve_plan` "in `controlPiAgentView`". It is not: the agent-view control
 * accepts only open, stop and resume, and `approve_plan` is a case of
 * `controlPiHarnessRuntime` (the verifier's probe: `controlPiAgentView` with that
 * action threw on `managed.workspace.name.trim`, `controlPiHarnessRuntime`
 * returned ok with the mode in `default`). `SessionManager.interaction-tools.test.ts`
 * drives that door (F1.413); this pins the prose beside it, which no behaviour
 * test can read.
 *
 * F1.415 — the notes also told a future server-side door to "reuse one of those
 * two", and for claude and codex neither is server-side: the plan card's landing
 * mode is renderer-only and `approve_plan` refuses a non-Pi session
 * (`pi-runtime-provider-required`, F1.413's negative arm). The notes now say so.
 *
 * Each region runs from the note's own first line to the first blank line after
 * it, and the negative needle (`controlPiAgentView`) is spelled elsewhere in both
 * files, so it can match.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8')

function noteRegion(source: string, opener: string): string {
  const start = source.indexOf(opener)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n\n', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('F1.412 + F1.415 — the F1.259 notes name the real plan-approval door', () => {
  for (const [file, opener] of [
    ['../SessionManager.ts', '// F1.259 (2026-09-23)'],
    ['../../handlers/session-manager-interface.ts', '  // F1.259 (2026-09-23)'],
  ] as const) {
    test(`${file.split('/').pop()}: controlPiHarnessRuntime, not the agent-view control, and the claude/codex residue`, () => {
      const source = read(file)
      // The negative needle is live in this file, so its absence from the note means something.
      expect(source).toContain('controlPiAgentView')
      const note = noteRegion(source, opener)
      expect(note).toContain('controlPiHarnessRuntime')
      expect(note).not.toContain('controlPiAgentView')
      expect(note).not.toContain('agent-view action')
      // F1.415 — the residue, stated: no server-side approval for claude or codex, and how a future one lands.
      expect(note).toContain('claude')
      expect(note).toContain('codex')
      expect(note).toContain('setSessionPermissionMode')
    })
  }

  test('the core control union spells approve_plan beside PiHarnessRuntimeControlBaseV1', () => {
    const core = read('../../../../core/src/types/pi-harness-runtime.ts')
    expect(core).toContain("(PiHarnessRuntimeControlBaseV1 & { action: 'approve_plan' })")
  })
})
