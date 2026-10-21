import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { orchestrationComponents } from '../registry/orchestration'

function variantNames(id: string): string[] {
  return orchestrationComponents.find(component => component.id === id)
    ?.variants?.map(variant => variant.name) ?? []
}

describe('orchestration playground registry', () => {
  it('registers the canonical orchestration playground entries', () => {
    expect(orchestrationComponents.map(component => component.id)).toEqual([
      'orchestration-subagent-card',
      'orchestration-workflow-panel',
      'orchestration-advisor-card',
      'orchestration-todo-list-card',
      'orchestration-task-checklist',
      'orchestration-ask-user',
      // UB14.18 — the F1.351 line, on the transcript's row language.
      'orchestration-task-notification',
    ])

    const indexSource = readFileSync(
      new URL('../registry/index.ts', import.meta.url),
      'utf8'
    )
    expect(indexSource).toContain("import { orchestrationComponents } from './orchestration'")
    expect(indexSource).toContain('...orchestrationComponents')
  })

  it('keeps knob variants for every required orchestration state', () => {
    expect(variantNames('orchestration-subagent-card')).toEqual([
      'Running',
      'Parallel',
      'Chain',
      'Error',
      'Aborted',
      'Done',
      // UB14.18 — the codex half of the card (P3.24: a `spawn_agent` collab row).
      'Codex collab (spawn_agent)',
    ])

    expect(variantNames('orchestration-workflow-panel')).toEqual([
      'Phases',
      'Budget exceeded',
      'Error',
      'Resumed',
    ])

    // P4.5 · the last two are the states the card DECLINES. They are variants
    // rather than omissions because this slot returns an element: a card that
    // renders `null` deletes the row instead of yielding it to `ActivityRow`,
    // so "the card does not draw this" is a state that has to be looked at.
    expect(variantNames('orchestration-advisor-card')).toEqual([
      'Approach',
      'Recurring error',
      'Before done',
      'No moment label',
      'Long guidance',
      'Refused (falls through)',
      'Still running (falls through)',
    ])

    // P2.503 · the last three are the states this card DECLINES, and they were
    // the live defect rather than a hypothetical: routed on the tool NAME, each
    // of them reached the card, the card rendered `null`, and the row was
    // deleted from the transcript. Same reason as the advisor card above — a
    // state the card does not draw is a state that has to be looked at.
    expect(variantNames('orchestration-todo-list-card')).toEqual([
      'Mixed',
      'Complete',
      'Result JSON',
      'Unparseable result (falls through)',
      'Awaiting input (falls through)',
      'Result without todos (falls through)',
    ])

    // R20's checklist surface: every state the panel can be in, including the
    // legacy fallback and the documented empty no-op.
    expect(variantNames('orchestration-task-checklist')).toEqual([
      'Mixed',
      'All pending',
      'Complete',
      'Overflow (>5)',
      'TaskList snapshot',
      'Legacy TodoWrite',
      'Empty (no-op)',
    ])

    // The three batched R7 variants already existed in the registry; this list
    // had not been updated to match. The three URL-consent variants are the
    // URL-mode elicitation card: the plain domain highlight, and the two
    // warning states (`elicitation.md:729`-`:730`) a spoofed URL produces.
    //
    // P6.607 — `Batched (option previews)` is the fourth batched variant, added
    // to the registry by `55a99ef59` ("the option preview Pi has always produced
    // is finally drawn") without this pinned list. That is the list doing its
    // job: it goes red when a state joins the surface, and the fix is to name
    // the new state, in registry order, rather than to loosen the assertion.
    expect(variantNames('orchestration-ask-user')).toEqual([
      'Options',
      'Free text',
      'Batched (2 questions)',
      'Batched (single)',
      'Batched (countdown)',
      'Batched (option previews)',
      'URL consent (plain)',
      'URL consent (Punycode)',
      'URL consent (lookalike)',
    ])

    expect(variantNames('orchestration-task-notification')).toEqual([
      'Subagent finished',
      'Shell failed (long body)',
      'Legacy row (no block)',
    ])
  })
})
