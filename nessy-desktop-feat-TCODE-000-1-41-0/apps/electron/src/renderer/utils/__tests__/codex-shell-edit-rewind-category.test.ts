/**
 * C3.309 — a codex file edited by a SHELL command is not checkpointed, and the
 * only thing that says so is a warning whose trigger nothing pinned.
 *
 * ## The two ends, and why they need a pin between them
 *
 * C3.67 gave codex a checkpoint producer on `apply_patch` — the same scope Pi's
 * and claude's have, whose producers are keyed on file TOOLS and not on the
 * shell. So a codex turn that rewrote a file with `sed -i` was never
 * snapshotted, and the user's only signal is
 * `uncoveredRewindCategories`'s `bash` category (P6.268), which fires on a
 * transcript row whose `toolName` lower-cases into
 * `UNCHECKPOINTED_COMMAND_TOOLS`.
 *
 * The codex end of that agreement is one string literal: the event adapter
 * spells a `commandExecution` item `'Bash'`. Nothing asserted the two halves
 * agreed, so **a rename on either side removes the warning silently** — the
 * rewind would go on reporting `restored N` with nothing said about the file the
 * shell rewrote, which is the exact lie `rewind-report.ts` exists to remove.
 *
 * ## The instrument
 *
 * Both ends, for real: the shipped `CodexEventAdapter` is driven with a
 * `commandExecution` item and the name it EMITS is handed to the renderer verb.
 * Neither string is retyped in an assertion — a test that spelled `'Bash'` on
 * both sides would pass against a rename of both and prove nothing about their
 * agreement.
 *
 * Its own file rather than a case in `rewind-report.test.ts`, deliberately:
 * importing the adapter costs ~36 s of module-graph I/O (measured 2026-09-12,
 * `user 0.12 sys 0.06` — the AGENTS.md §Traps shape), and that file is otherwise
 * a sub-second pure-function suite. The import is top-level, per the measured
 * rule that a dynamic `await import` inside a case spends the whole graph
 * against the 5 s per-test timer.
 */
import { describe, expect, it } from 'bun:test'
import { CodexEventAdapter } from '@nessy-agent/shared/agent/backend/codex/event-adapter'
import { uncoveredRewindCategories } from '../rewind-report.ts'

/** The tool names a codex turn of `item`s produces, in order. */
function toolNamesFor(items: readonly Record<string, unknown>[]): string[] {
  const adapter = new CodexEventAdapter()
  adapter.startTurn('turn-c3309')
  const names: string[] = []
  for (const item of items) {
    for (const method of ['item/started', 'item/completed'] as const) {
      for (const event of adapter.adapt(method, { item })) {
        if (event.type === 'tool_start' || event.type === 'tool_result') {
          if (typeof event.toolName === 'string') names.push(event.toolName)
        }
      }
    }
  }
  return names
}

const COMMAND_ITEM = { type: 'commandExecution', id: 'c3309-cmd', command: "sed -i '' s/a/b/ src/x.ts", aggregatedOutput: '', exitCode: 0 }
const FILE_CHANGE_ITEM = { type: 'fileChange', id: 'c3309-edit', changes: [{ path: '/tmp/x.ts', kind: 'update' }], status: 'applied' }

describe('C3.309 — a codex command turn produces the `bash` uncovered category', () => {
  it('POSITIVE: the name the adapter emits for a command is one the renderer counts as uncheckpointed', () => {
    const names = toolNamesFor([COMMAND_ITEM])
    // The adapter really did name the row — otherwise the assertion below would
    // be about an empty transcript.
    expect(names.length).toBeGreaterThan(0)
    // THE AGREEMENT. The name is taken from the adapter, never retyped here.
    expect(uncoveredRewindCategories(names.map(toolName => ({ toolName })))).toEqual(['bash'])
  })

  it('NEGATIVE: a codex FILE-CHANGE turn produces no category, because that is the scope C3.67 covers', () => {
    const names = toolNamesFor([FILE_CHANGE_ITEM])
    expect(names.length).toBeGreaterThan(0)
    expect(uncoveredRewindCategories(names.map(toolName => ({ toolName })))).toEqual([])
  })

  it('BOUNDARY: the two ends disagree on CASE, so the lower-casing in the verb is load-bearing', () => {
    // The adapter says `Bash`; the set holds `bash`. This is the assertion that
    // fails if someone "simplifies" `uncoveredRewindCategories` by dropping
    // `.toLowerCase()` — on codex the warning would then never fire, while Pi
    // and claude kept theirs, which is the silent divergence the set's own
    // docblock says it exists to prevent.
    const [first] = toolNamesFor([COMMAND_ITEM])
    expect(first).toBeDefined()
    expect(first).not.toBe(first!.toLowerCase())
    expect(uncoveredRewindCategories([{ toolName: first! }])).toEqual(['bash'])
  })

  it('a mixed turn reports it once, not once per row', () => {
    const names = toolNamesFor([COMMAND_ITEM, FILE_CHANGE_ITEM])
    expect(uncoveredRewindCategories(names.map(toolName => ({ toolName })))).toEqual(['bash'])
  })
})
