import { describe, expect, it } from 'bun:test'

import { PI_TOOL_BINDINGS } from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts'
import { normalizePiSdkToolCallRecordsV1 } from './pi-legacy-ingress.ts'

describe('Pi SDK persisted tool-call ingress', () => {
  /**
   * The session-tool wire-name unification CHANGED THE ANSWER of this case.
   *
   * Before it, Pi's model-facing name was the snake_case descriptor id, so a
   * transcript carrying `mcp__session__SubmitPlan` was the stale one and ingress
   * rewrote it DOWN to `mcp__session__submit_plan`. Now the registry id verbatim
   * is the live name on every runtime, so the same pair is normalized the other
   * way — and the transcripts that need rewriting are the ones written before
   * the change.
   */
  it('normalizes a legacy snake_case session name forward to the registry id', () => {
    // Annotated, not inferred: `normalizePiSdkToolCallRecordsV1<T>(value: T): T`
    // is identity-typed, so `output` inherits whatever this literal widens to —
    // and the bare literal has no `originalName`, which is the field the
    // function ADDS and the expectation below is here to pin.
    const input: Array<{
      content: Array<{ type: string; name: string; originalName?: string; arguments: Record<string, unknown> }>
    }> = [{ content: [
      { type: 'toolCall', name: 'mcp__session__submit_plan', arguments: {} },
      { type: 'toolCall', name: 'mcp__GitHub__CreateIssue', arguments: {} },
    ] }]

    const output = normalizePiSdkToolCallRecordsV1(input)

    expect(output).toEqual([{ content: [
      { type: 'toolCall', name: 'mcp__session__SubmitPlan', originalName: 'mcp__session__submit_plan', arguments: {} },
      { type: 'toolCall', name: 'mcp__GitHub__CreateIssue', arguments: {} },
    ] }])
    expect(input[0]!.content[0]!.name).toBe('mcp__session__submit_plan')
  })

  it('keeps the two native bindings pointing at their Pi wire names', () => {
    // F5's fence: the derived half of the table is predicated on
    // `bindingName.startsWith('mcp__session__')`, because `descriptorId !==
    // handlerName` alone also matches these two natives — and inverting them
    // would send a resumed transcript at a name Pi does not dispatch on.
    const output = normalizePiSdkToolCallRecordsV1([{ content: [
      { type: 'toolCall', name: 'NotebookEdit', arguments: {} },
      { type: 'toolCall', name: 'stopTask', arguments: {} },
    ] }]) as Array<{ content: Array<{ name: string }> }>
    expect(output[0]!.content.map(part => part.name)).toEqual(['notebook_edit', 'stop_task'])
  })

  it('covers every session tool whose wire name moved, from the live registry', () => {
    // The table is derived, so this asserts the DERIVATION rather than a list:
    // each formerly-divergent session tool's old piName must land on its
    // current one, and a tool that never diverged must not appear at all.
    const divergent = PI_TOOL_BINDINGS.filter(binding =>
      binding.bindingName.startsWith('mcp__session__') && binding.descriptorId !== binding.handlerName)
    expect(divergent.length).toBeGreaterThan(20)
    const output = normalizePiSdkToolCallRecordsV1([{ content: [
      ...divergent.map(binding => ({ type: 'toolCall', name: `mcp__session__${binding.descriptorId}` })),
      { type: 'toolCall', name: 'mcp__session__source_manage' },
    ] }]) as Array<{ content: Array<{ name: string }> }>
    expect(output[0]!.content.map(part => part.name))
      .toEqual([...divergent.map(binding => binding.piName), 'mcp__session__source_manage'])
  })

  it('fails atomically on malformed or oversized names', () => {
    for (const input of [
      [{ content: [{ type: 'toolCall', name: 'mcp__session__task' }, { type: 'toolCall', name: 42 }] }],
      [{ content: [{ type: 'toolCall', name: 'mcp__session__task' }, { type: 'toolCall', name: 'x'.repeat(513) }] }],
      Array.from({ length: 10_001 }, () => ({ content: [] })),
      [{ content: Array.from({ length: 1_001 }, () => ({ type: 'text', text: '' })) }],
    ]) {
      const before = structuredClone(input)
      expect(() => normalizePiSdkToolCallRecordsV1(input)).toThrow()
      expect(input).toEqual(before)
    }
  })
})
