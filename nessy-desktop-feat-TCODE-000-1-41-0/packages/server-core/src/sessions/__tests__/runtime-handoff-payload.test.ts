/**
 * T1a · the handoff projection, and the four-leg sequence that refutes its old
 * premise.
 *
 * `buildRuntimeHandoffPayload` was a closure inside
 * `SessionManager.getOrCreateAgentUnchecked` until T1a. It was extracted for
 * one reason worth repeating here: the trim it performs was keyed on message
 * PROVENANCE while its own comment justified it by the ANCHOR, and the only
 * test of it re-implemented the closure's body by hand instead of calling it —
 * so the test could not have caught the divergence, and did not.
 *
 * The divergence is real and it is one provider wide. `ANCHORED_PROVIDERS` is
 * `['pi', 'anthropic']`; `codex-runtime` is deliberately absent, because a
 * codex thread is not resumable across a switch. So a Codex leg that has
 * spoken here before has assistant rows carrying its provenance and NO anchor
 * to resume them from, and a provenance-keyed trim hands its second leg
 * nothing of what happened before it.
 */
import { describe, expect, it } from 'bun:test'
import { buildRuntimeHandoffContext } from '@nessy-agent/shared/agent/base-agent'
import { buildCodexInjectItems } from '@nessy-agent/shared/agent/codex-handoff-items'
import {
  buildRuntimeHandoffHistory,
  buildRuntimeHandoffPayload,
  HANDOFF_IMAGE_NOTE,
  handoffAttachmentBlock,
  type RuntimeHandoffRow,
} from '../runtime-handoff.ts'

const armed = { from: 'pi' as const, applied: false }

function rows(...entries: Array<[string, string, string | undefined]>): RuntimeHandoffRow[] {
  return entries.map(([role, content, runtime]) => ({
    role,
    content,
    ...(runtime ? { runtime } : {}),
  }))
}

describe('buildRuntimeHandoffPayload', () => {
  it('is null when nothing is armed, and null once applied', () => {
    const transcript = rows(['user', 'hello', undefined])
    expect(buildRuntimeHandoffPayload({
      rows: transcript, from: undefined, applied: false, target: 'codex-runtime', targetHasAnchor: false, plan: 'native',
    })).toBeNull()
    expect(buildRuntimeHandoffPayload({
      rows: transcript, ...armed, applied: true, target: 'codex-runtime', targetHasAnchor: false, plan: 'native',
    })).toBeNull()
  })

  it('drops streaming scaffolding and non-conversation rows', () => {
    const transcript: RuntimeHandoffRow[] = [
      { role: 'user', content: 'add a retry' },
      { role: 'assistant', content: 'thinking…', isIntermediate: true },
      { role: 'info', content: 'runtime_switched:pi:codex-runtime' },
      { role: 'assistant', content: 'done' },
    ]
    const payload = buildRuntimeHandoffPayload({
      rows: transcript, ...armed, target: 'codex-runtime', targetHasAnchor: false, plan: 'native',
    })
    expect(payload?.messages).toEqual([
      { type: 'user', content: 'add a retry' },
      { type: 'assistant', content: 'done' },
    ])
  })

  it('carries the plan the switch decided, and omits it when there is none', () => {
    const transcript = rows(['user', 'hello', undefined])
    expect(buildRuntimeHandoffPayload({
      rows: transcript, ...armed, target: 'codex-runtime', targetHasAnchor: false, plan: 'native',
    })?.plan).toBe('native')
    expect(buildRuntimeHandoffPayload({
      rows: transcript, ...armed, target: 'codex-runtime', targetHasAnchor: false, plan: undefined,
    })).not.toHaveProperty('plan')
  })

  // RTS-3's finding, kept: a runtime that resumes its own thread must not be
  // handed what it already holds. This is the POSITIVE CONTROL for the guard
  // below — without it, "the trim is gated on the anchor" would be satisfied by
  // deleting the trim.
  it('trims to what the target missed when it really does resume its own thread', () => {
    const transcript = rows(
      ['user', 'plant: opal-lantern-77', undefined],
      ['assistant', 'noted', 'pi'],
      ['user', 'now ask the other one', undefined],
      ['assistant', 'answered on codex', 'codex-runtime'],
    )
    const payload = buildRuntimeHandoffPayload({
      rows: transcript, from: 'codex-runtime', applied: false, target: 'pi', targetHasAnchor: true, plan: 'text',
    })
    expect(payload?.messages).toEqual([
      { type: 'user', content: 'now ask the other one' },
      { type: 'assistant', content: 'answered on codex' },
    ])
  })

  // The negative half of the same rule. A user row carrying the target's
  // provenance is the message being sent RIGHT NOW — stamped with the provider
  // about to answer it — so keying the boundary on it puts the cut at the end
  // of the transcript and the handoff disappears.
  it('never takes its boundary from a USER row, even on an anchored target', () => {
    const transcript = rows(
      ['user', 'plant: opal-lantern-77', undefined],
      ['assistant', 'answered on codex', 'codex-runtime'],
      ['user', 'what was the password?', 'pi'],
    )
    const payload = buildRuntimeHandoffPayload({
      rows: transcript, from: 'codex-runtime', applied: false, target: 'pi', targetHasAnchor: true, plan: 'text',
    })
    expect(payload?.messages.map(m => m.content)).toContain('plant: opal-lantern-77')
  })

  // THE FOUR-LEG SEQUENCE. pi → codex → pi → codex, with the fact planted on
  // leg 1. On the second Codex leg the transcript already holds a Codex
  // assistant row, but Codex holds no anchor — so the trim must not fire, and
  // leg 1's fact must still be in the payload.
  it('does not trim a returning CODEX leg, which has provenance but no anchor', () => {
    const transcript = rows(
      // leg 1 — pi
      ['user', 'remember: the fixture password is opal-lantern-77', undefined],
      ['assistant', 'noted', 'pi'],
      // leg 2 — codex
      ['user', 'summarise what we have', 'codex-runtime'],
      ['assistant', 'a password was noted', 'codex-runtime'],
      // leg 3 — back on pi
      ['user', 'keep going', 'pi'],
      ['assistant', 'continuing', 'pi'],
    )
    const payload = buildRuntimeHandoffPayload({
      rows: transcript,
      from: 'pi',
      applied: false,
      target: 'codex-runtime',
      // The whole point: Codex is absent from `ANCHORED_PROVIDERS`, so a
      // returning Codex leg answers false here no matter how much it has said.
      targetHasAnchor: false,
      plan: 'native',
    })
    const contents = payload?.messages.map(m => m.content) ?? []
    expect(contents).toContain('remember: the fixture password is opal-lantern-77')
    // Nothing is trimmed at all — the whole conversation crosses.
    expect(contents).toHaveLength(6)

    // The refuted behaviour, spelled out as the control: had the trim been
    // keyed on provenance alone, it would have cut at the leg-2 assistant row
    // and leg 1's fact would be gone.
    const asIfProvenanceKeyed = buildRuntimeHandoffPayload({
      rows: transcript, ...armed, target: 'codex-runtime', targetHasAnchor: true, plan: 'native',
    })
    expect(asIfProvenanceKeyed?.messages.map(m => m.content))
      .not.toContain('remember: the fixture password is opal-lantern-77')
  })

  it('is null when the trim leaves nothing to carry', () => {
    const transcript = rows(['assistant', 'answered on pi', 'pi'])
    expect(buildRuntimeHandoffPayload({
      rows: transcript, from: 'anthropic', applied: false, target: 'pi', targetHasAnchor: true, plan: 'text',
    })).toBeNull()
  })
})

/**
 * T1b · the ROW projection, which is a different projection from the one above
 * and must stay that way.
 *
 * §P.2(b): `getRuntimeHandoffMessages` filters `!isIntermediate` because it
 * feeds a text summary; in a native history those rows are the model's own
 * commentary between tool calls, and they are **1 835 of 2 969 assistant rows
 * (61.8%)**. Reusing the message projection here would silently discard most of
 * the transcript, which is why the two are tested separately.
 *
 * Every guard below carries the count the plan measured on the 677-session
 * corpus, because a guard whose predicate is wrong passes vacuously — the
 * empty-row one is the example the plan itself records (`content === ''` matches
 * **0** rows; `content.trim() === ''` matches 317).
 */
describe('buildRuntimeHandoffHistory — the row projection', () => {
  const base = { target: 'codex-runtime' as const, targetHasAnchor: false }

  it('keeps user, assistant INCLUDING isIntermediate, and tool — and drops the other six roles', () => {
    const transcript: RuntimeHandoffRow[] = [
      { id: 'r1', role: 'user', content: 'read the config' },
      { id: 'r2', role: 'assistant', content: 'reading it now', isIntermediate: true },
      { id: 'r3', role: 'tool', toolName: 'Read', rawToolInput: { file_path: './config.json' }, rawToolResult: '{"port":8123}', toolStatus: 'completed', content: '' },
      { id: 'r4', role: 'assistant', content: 'the port is 8123' },
      // The complete drop list, written out as rows so a new `MessageRole`
      // member cannot quietly start crossing.
      { id: 'r5', role: 'error', content: 'ECONNRESET' },
      { id: 'r6', role: 'info', content: 'runtime_switched:pi:codex-runtime' },
      { id: 'r7', role: 'warning', content: 'rate limited' },
      { id: 'r8', role: 'status', content: 'compacting' },
      { id: 'r9', role: 'plan', content: 'a plan the user approved' },
      { id: 'r10', role: 'auth-request', content: 'sign in to continue' },
    ]

    const history = buildRuntimeHandoffHistory({ rows: transcript, ...base })

    expect(history).toEqual([
      { kind: 'message', role: 'user', content: 'read the config' },
      // The intermediate row survives. This is the assertion §P.2(b) exists for.
      { kind: 'message', role: 'assistant', content: 'reading it now' },
      { kind: 'tool', callId: 'nessy_handoff_r3', name: 'Read', input: { file_path: './config.json' }, output: '{"port":8123}' },
      { kind: 'message', role: 'assistant', content: 'the port is 8123' },
    ])
  })

  // GUARD 1 — 32/733 (4.4%). An unpaired `function_call` is a hard provider
  // error, so the pair is CLOSED, never dropped: dropping it would take the
  // assistant's own explanation of the call with it.
  it('GUARD 1 · closes a dangling tool call with a synthesized (interrupted) result', () => {
    const dangling = (toolStatus: string): RuntimeHandoffRow[] => ([
      { id: 'd1', role: 'tool', toolName: 'Bash', rawToolInput: { command: 'sleep 900' }, toolStatus, content: '' },
    ])
    for (const status of ['executing', 'pending']) {
      expect(buildRuntimeHandoffHistory({ rows: dangling(status), ...base })).toEqual([
        { kind: 'tool', callId: 'nessy_handoff_d1', name: 'Bash', input: { command: 'sleep 900' }, output: '(interrupted)' },
      ])
    }
    // The safe superset: a row whose STATUS claims completion but carries no
    // result is the same unpaired call to the provider, and the fact beats the
    // claim.
    expect(buildRuntimeHandoffHistory({ rows: dangling('completed'), ...base })[0])
      .toMatchObject({ output: '(interrupted)' })
    // POSITIVE CONTROL — a real result is not overwritten by the synthetic one.
    expect(buildRuntimeHandoffHistory({
      rows: [{ id: 'd2', role: 'tool', toolName: 'Bash', rawToolInput: { command: 'ls' }, rawToolResult: 'README.md', toolStatus: 'completed', content: '' }],
      ...base,
    })[0]).toMatchObject({ output: 'README.md' })
    // An empty-string result is a REAL result (a command that printed nothing)
    // and must pass through rather than be mistaken for a dangling call.
    expect(buildRuntimeHandoffHistory({
      rows: [{ id: 'd3', role: 'tool', toolName: 'Bash', rawToolInput: { command: 'true' }, rawToolResult: '', toolStatus: 'completed', content: '' }],
      ...base,
    })[0]).toMatchObject({ output: '' })
  })

  // GUARD 2 — 34/733 (4.6%). These are `tool_start` rows whose second event
  // never filled the input. Drop the PAIR: a call whose arguments are `{}` is
  // malformed, and the model would try to interpret it.
  it('GUARD 2 · drops the pair when the tool row has no input', () => {
    const missing: RuntimeHandoffRow[] = [
      { id: 'u', role: 'user', content: 'run it' },
      { id: 'n1', role: 'tool', toolName: 'Bash', rawToolResult: 'done', toolStatus: 'completed', content: '' },
      { id: 'n2', role: 'tool', toolName: 'Bash', rawToolInput: {}, rawToolResult: 'done', toolStatus: 'completed', content: '' },
      { id: 'n3', role: 'tool', toolName: 'Bash', toolInput: {}, rawToolResult: 'done', toolStatus: 'completed', content: '' },
    ]
    // Only the user row survives — all three malformed shapes are gone, and
    // nothing half-formed took their place.
    expect(buildRuntimeHandoffHistory({ rows: missing, ...base }))
      .toEqual([{ kind: 'message', role: 'user', content: 'run it' }])
  })

  // GUARD 3 — 317/2 969 (10.7%). The predicate is `content.trim() === ''`; the
  // plan records that a literal `content === ''` matches **0 rows**, so the
  // whitespace row below is the one that discriminates a working guard from a
  // vacuous one.
  it('GUARD 3 · drops an empty row on trim(), not on strict equality', () => {
    const empties: RuntimeHandoffRow[] = [
      { id: 'e1', role: 'assistant', content: '' },
      { id: 'e2', role: 'assistant', content: '   \n\t  ' },
      { id: 'e3', role: 'user', content: '\n' },
      { id: 'e4', role: 'assistant', content: 'kept' },
    ]
    expect(buildRuntimeHandoffHistory({ rows: empties, ...base }))
      .toEqual([{ kind: 'message', role: 'assistant', content: 'kept' }])
  })

  // GUARD 4 — 80 rows. `error` is the drop class a list has to name explicitly:
  // the other five are either absent from the corpus or obviously not
  // conversation. It is scaffolding this process wrote, not something the model
  // said.
  it('GUARD 4 · drops error rows, which are scaffolding rather than conversation', () => {
    const withErrors: RuntimeHandoffRow[] = [
      { id: 'x1', role: 'user', content: 'deploy' },
      { id: 'x2', role: 'error', content: 'Error: ECONNRESET while calling the gateway' },
      { id: 'x3', role: 'assistant', content: 'retrying' },
    ]
    const history = buildRuntimeHandoffHistory({ rows: withErrors, ...base })
    expect(history.map(e => (e.kind === 'tool' ? e.name : e.content))).toEqual(['deploy', 'retrying'])
    expect(JSON.stringify(history)).not.toContain('ECONNRESET')
  })

  // P1's raw pair is what a converter must send — the display projection was
  // path-rewritten against the HOST process's cwd. A pre-P1 row still converts,
  // and the degraded path announces itself rather than resolving somewhere else
  // in silence.
  it('prefers the raw pair, falls back to the display fields, and says when it did', () => {
    const mixed: RuntimeHandoffRow[] = [
      { id: 'p1', role: 'tool', toolName: 'Read', rawToolInput: { file_path: '/abs/real.ts' }, toolInput: { file_path: './Users/real.ts' }, rawToolResult: 'RAW', toolResult: 'DISPLAY', toolStatus: 'completed', content: '' },
      { id: 'p2', role: 'tool', toolName: 'Read', toolInput: { file_path: './Users/old.ts' }, toolResult: 'OLD DISPLAY', toolStatus: 'completed', content: '' },
    ]
    const lines: string[] = []
    const history = buildRuntimeHandoffHistory({ rows: mixed, ...base, log: m => lines.push(m) })

    expect(history[0]).toMatchObject({ input: { file_path: '/abs/real.ts' }, output: 'RAW' })
    expect(history[1]).toMatchObject({ input: { file_path: './Users/old.ts' }, output: 'OLD DISPLAY' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('1 tool input(s) and 1 tool result(s) fell back to the display projection')

    // POSITIVE CONTROL for the absence: an all-raw transcript logs nothing at
    // all, so the line above means "a row was degraded" and not "the logger
    // fires".
    const quiet: string[] = []
    buildRuntimeHandoffHistory({ rows: [mixed[0]!], ...base, log: m => quiet.push(m) })
    expect(quiet).toEqual([])
  })

  it('mints a deterministic, unique call_id per tool row', () => {
    const pair: RuntimeHandoffRow[] = [
      { id: 'a/b:c', role: 'tool', toolName: 'Read', rawToolInput: { p: 1 }, rawToolResult: 'x', content: '' },
      // No id and no toolUseId — the index fallback, which must not collide.
      { role: 'tool', toolName: 'Read', rawToolInput: { p: 2 }, rawToolResult: 'y', content: '' },
      { role: 'tool', toolName: 'Read', rawToolInput: { p: 3 }, rawToolResult: 'z', content: '' },
    ]
    const first = buildRuntimeHandoffHistory({ rows: pair, ...base })
    const second = buildRuntimeHandoffHistory({ rows: pair, ...base })
    const ids = first.map(e => (e.kind === 'tool' ? e.callId : ''))

    expect(ids[0]).toBe('nessy_handoff_abc')
    expect(new Set(ids).size).toBe(3)
    // Deterministic: the same transcript rebuilds to the same ids.
    expect(second.map(e => (e.kind === 'tool' ? e.callId : ''))).toEqual(ids)
  })

  // The trim is the message projection's own rule, applied to the same
  // boundary: gated on the ANCHOR (never on provenance alone) and never taken
  // from a USER row.
  it('applies the anchor-gated trim, and only when the target really has an anchor', () => {
    const transcript: RuntimeHandoffRow[] = [
      { id: 't1', role: 'user', content: 'plant: opal-lantern-77' },
      { id: 't2', role: 'assistant', content: 'noted', runtime: 'pi' },
      { id: 't3', role: 'user', content: 'carry on' },
    ]
    expect(buildRuntimeHandoffHistory({ rows: transcript, target: 'pi', targetHasAnchor: true }))
      .toEqual([{ kind: 'message', role: 'user', content: 'carry on' }])
    // Codex is absent from `ANCHORED_PROVIDERS`, so it never trims — and the
    // whole span crosses.
    expect(buildRuntimeHandoffHistory({ rows: transcript, ...base })).toHaveLength(3)
  })
})

/**
 * D4 · an image attachment crosses as a path, and the block now SAYS that
 * rather than presenting a filename indistinguishable from a text file's.
 *
 * The two arms that matter are the two this describe covers: an image gains a
 * named loss and a pointer the target can act on (Claude's Read returns images
 * as visual content per `tools-reference.md#read-tool-behavior`; Pi's `read`
 * tool advertises the same), and a NON-image is byte-identical to what D6
 * shipped — which is the boundary, because every existing D6 assertion is
 * written against those exact strings.
 */
describe('handoffAttachmentBlock — D4, the named image loss', () => {
  it('names an image, keeps its path, and tells the model the content did not cross', () => {
    const block = handoffAttachmentBlock({
      name: 'screenshot.png',
      type: 'image',
      mimeType: 'image/png',
      resolvedPath: '/sessions/s1/screenshot.png',
    })
    expect(block).toBe(
      '[Attached image: screenshot.png]\n'
      + '[Stored at: /sessions/s1/screenshot.png]\n'
      + HANDOFF_IMAGE_NOTE,
    )
    // The mime prefix alone is enough: a row stored before `type` was populated
    // still reaches the image arm, which is why PiAgent's own live branch keys
    // on the same thing.
    expect(handoffAttachmentBlock({ name: 'a.webp', mimeType: 'image/webp', resolvedPath: '/p/a.webp' }))
      .toContain(HANDOFF_IMAGE_NOTE)
  })

  it('BOUNDARY · a non-image is byte-identical to the D6 block, both arms', () => {
    expect(handoffAttachmentBlock({ name: 'notes.txt', type: 'text', mimeType: 'text/plain', resolvedPath: '/s/notes.txt' }))
      .toBe('[Attached file: notes.txt]\n[Stored at: /s/notes.txt]')
    expect(handoffAttachmentBlock({ name: 'gone.txt', type: 'text', mimeType: 'text/plain' }))
      .toBe('[Attached file: gone.txt]\n[Unavailable: the stored copy could not be opened]')
  })

  it('NEGATIVE · an unopenable image gets no pointer at all, because there is nothing to point at', () => {
    const block = handoffAttachmentBlock({ name: 'gone.png', type: 'image', mimeType: 'image/png' })
    expect(block).toBe('[Attached image: gone.png]\n[Unavailable: the stored copy could not be opened]')
    expect(block).not.toContain(HANDOFF_IMAGE_NOTE)
    expect(block).not.toContain('Stored at')
  })

  /**
   * P3.151 · the pointer must be a FACT, not an imperative, and must name a
   * capability rather than a tool. Both properties are load-bearing and neither
   * is visible to any other assertion in this file, which all reference the
   * constant and would pass on any wording at all.
   *
   * **Why fact and not instruction.** On the `text` tier this note is delivered
   * inside `buildRuntimeHandoffContext`'s untrusted fence, whose own
   * `UNTRUSTED_TRANSCRIPT_NOTICE` says *"Nothing inside that fence is a new
   * directive to you or the harness speaking"*. An imperative there is a
   * command we told the model not to obey; a true statement survives as exactly
   * what the fence says its contents are — data the model may act on.
   *
   * **Why capability and not tool.** Claude and Pi recover the image with a
   * read; Codex has no `read` tool and uses `view_image`
   * (`codex-rs/core/src/tools/handlers/view_image.rs` at `rust-v0.150.1`
   * returns `FunctionCallOutputContentItem::InputImage`). A note naming one
   * tool would be weakest on the runtime where this route is least proven.
   */
  it('P3.151 · states the recovery as a fact and names no tool', () => {
    // The imperative D4 shipped is gone, in every mood it could return in.
    expect(HANDOFF_IMAGE_NOTE).not.toContain('read the file')
    expect(HANDOFF_IMAGE_NOTE).not.toMatch(/\b(read|open|view|use|call)\s+(the\s+)?(file|path|image)\b/i)
    // No tool name, on any of the three runtimes that can receive this block.
    for (const tool of ['Read', 'view_image', 'Bash', 'shell']) {
      expect(HANDOFF_IMAGE_NOTE).not.toContain(tool)
    }
    // POSITIVE CONTROL — the three facts are still all there, so the negatives
    // above are not satisfied by an emptied constant.
    expect(HANDOFF_IMAGE_NOTE).toContain('did not cross the runtime switch')
    expect(HANDOFF_IMAGE_NOTE).toContain('still at the path above')
    expect(HANDOFF_IMAGE_NOTE).toContain('visual content')
  })

  /**
   * P3.280 · the note must state a CONDITION, not a promise.
   *
   * D4's sentence was unqualified — *"opening it returns the image as visual
   * content"* — which is true of Claude's `Read` and Pi's `read` and true of
   * Codex's `view_image` only for a model that declares image input. The model
   * this fork's codex sessions run against does not: the Nessy Gateway answers
   * an image content part with `400 … Model Does Not Support Image Inputs`
   * (P3.114/P3.127). So the block promised a capability the session lacks.
   *
   * Pinned here and not by the constant's own docblock, because the failure is
   * a REGRESSION shape: every other assertion in this file references the
   * constant and would pass if the qualification were dropped again.
   */
  it('P3.280 · the recovery is conditional on the model accepting image input', () => {
    // The condition is present, in both directions.
    expect(HANDOFF_IMAGE_NOTE).toContain('accepts image input')
    expect(HANDOFF_IMAGE_NOTE).toContain('does not is offered no way')
    // NEGATIVE — the unconditional promise D4 shipped must not come back.
    expect(HANDOFF_IMAGE_NOTE).not.toContain('and opening it returns the image as visual content')
    // The whole block still fits inside the tail budget a folded transcript row
    // reserves for it (`TRANSCRIPT_TAIL_BUDGET_CHARS` = 500 in `base-agent.ts`),
    // with a worst-case stored path of ~160 characters. A longer note would be
    // silently clipped at the fold, which is how an honest sentence becomes a
    // truncated one.
    const worstCase = handoffAttachmentBlock({
      name: 'screenshot.png',
      type: 'image',
      mimeType: 'image/png',
      resolvedPath: `/${'p'.repeat(150)}/screenshot.png`,
    })
    expect(worstCase.length).toBeLessThan(500)
  })

  it('reaches the projected content through the attachmentBlock hook', () => {
    const transcript: RuntimeHandoffRow[] = [
      {
        id: 'i1',
        role: 'user',
        content: 'what is wrong here',
        attachments: [{ id: 'att-1', name: 'bug.png', type: 'image', mimeType: 'image/png' }],
      },
    ]
    const [entry] = buildRuntimeHandoffHistory({
      rows: transcript,
      target: 'pi',
      targetHasAnchor: false,
      attachmentBlock: row => handoffAttachmentBlock({
        name: row.attachments![0]!.name,
        type: row.attachments![0]!.type,
        mimeType: row.attachments![0]!.mimeType,
        resolvedPath: '/s/bug.png',
      }),
    })
    expect(entry).toEqual({
      kind: 'message',
      role: 'user',
      content: `what is wrong here\n\n[Attached image: bug.png]\n[Stored at: /s/bug.png]\n${HANDOFF_IMAGE_NOTE}`,
    })
  })
})

describe('the payload carries the row projection only on a native plan', () => {
  const toolTranscript: RuntimeHandoffRow[] = [
    { id: 'm1', role: 'user', content: 'what port does the service use?' },
    { id: 'm2', role: 'assistant', content: 'checking', isIntermediate: true },
    { id: 'm3', role: 'tool', toolName: 'Read', rawToolInput: { file_path: './config.json' }, rawToolResult: 'port = 8123', toolStatus: 'completed', content: '' },
    { id: 'm4', role: 'assistant', content: 'it is in the config' },
  ]
  const armedFromPi = { from: 'pi' as const, applied: false, target: 'codex-runtime' as const, targetHasAnchor: false }

  it('attaches history on `native`, with the tool row in it', () => {
    const payload = buildRuntimeHandoffPayload({ rows: toolTranscript, ...armedFromPi, plan: 'native' })
    expect(payload?.history?.some(e => e.kind === 'tool' && e.output === 'port = 8123')).toBe(true)
    // …and `messages` is UNCHANGED, because it is still the in-turn fallback
    // when `thread/inject_items` is refused.
    expect(payload?.messages).toEqual([
      { type: 'user', content: 'what port does the service use?' },
      { type: 'assistant', content: 'it is in the config' },
    ])
  })

  // The bound P3 owns, asserted as byte-stability rather than as a preference:
  // on a non-native plan the payload is exactly the object T1a produced, field
  // for field. A `history` key appearing here would be a silent uncap.
  it('leaves the text and anchor tiers byte-identical to what they were before T1b', () => {
    for (const plan of ['text', 'anchor'] as const) {
      const payload = buildRuntimeHandoffPayload({ rows: toolTranscript, ...armedFromPi, plan })
      expect(payload).toEqual({
        from: 'pi',
        plan,
        messages: [
          { type: 'user', content: 'what port does the service use?' },
          { type: 'assistant', content: 'it is in the config' },
        ],
      })
      expect(payload).not.toHaveProperty('history')
    }
    // Same for a payload with no plan at all — read as `text`, the shipped
    // behaviour.
    expect(buildRuntimeHandoffPayload({ rows: toolTranscript, ...armedFromPi, plan: undefined }))
      .not.toHaveProperty('history')
  })

  it('omits history rather than attaching an empty array when nothing survives the guards', () => {
    const noTools: RuntimeHandoffRow[] = [{ id: 'o1', role: 'user', content: 'hello' }]
    const payload = buildRuntimeHandoffPayload({ rows: noTools, ...armedFromPi, plan: 'native' })
    expect(payload?.history).toEqual([
      { kind: 'message', role: 'user', content: 'hello' },
    ])
    // An all-whitespace transcript leaves the history empty, and the field is
    // then absent so the mapper falls back to `messages`.
    const blank: RuntimeHandoffRow[] = [{ id: 'o2', role: 'user', content: '   ' }]
    expect(buildRuntimeHandoffPayload({ rows: blank, ...armedFromPi, plan: 'native' }))
      .not.toHaveProperty('history')
  })

  /**
   * THE PLAN'S DONE CRITERION, encoded.
   *
   * *"a Pi session with real tool traffic, switched to `codex-gateway`, can
   * answer a question whose only source is a **tool result** — not prose — from
   * before the switch."*
   *
   * So: a transcript whose ONLY mention of the fact lives in a `toolResult`,
   * projected by the shipped `buildRuntimeHandoffPayload` and mapped by the
   * shipped `buildCodexInjectItems`, and the fact must be in the items. The
   * negative control is the same transcript on a `text` plan, where the fact
   * provably does NOT cross — which is the state this task was written to end.
   *
   * The RPC leg (these items reach `thread/inject_items`) is
   * `codex-runtime-handoff.test.ts`; the wire leg (they reach the model's
   * request body) is `codex-inject-items-e2e.test.ts`. The arming leg (a real
   * `switchSessionRuntime` produces this plan and this `from`) is
   * `runtime-switch-session.test.ts`.
   */
  it('DONE · a fact that exists only in a tool result reaches the inject items', () => {
    const secretInAToolResultOnly: RuntimeHandoffRow[] = [
      { id: 'k1', role: 'user', content: 'what is in the deploy key file?' },
      { id: 'k2', role: 'assistant', content: 'let me read it', isIntermediate: true },
      {
        id: 'k3',
        role: 'tool',
        toolName: 'Read',
        rawToolInput: { file_path: './deploy.key' },
        rawToolResult: 'DEPLOY_FINGERPRINT=opal-lantern-77',
        toolStatus: 'completed',
        content: '',
      },
      { id: 'k4', role: 'assistant', content: 'I have read the file.' },
    ]
    // The fact is nowhere in the prose — the premise of the whole row.
    const prose = secretInAToolResultOnly
      .filter(r => r.role !== 'tool')
      .map(r => r.content)
      .join(' ')
    expect(prose).not.toContain('opal-lantern-77')

    const payload = buildRuntimeHandoffPayload({ rows: secretInAToolResultOnly, ...armedFromPi, plan: 'native' })
    const items = buildCodexInjectItems(payload!)
    expect(JSON.stringify(items)).toContain('opal-lantern-77')

    // The pair is adjacent and ordered, and the call carries the arguments.
    const call = items.findIndex(i => i.type === 'function_call')
    expect(items[call]).toEqual({
      type: 'function_call',
      name: 'Read',
      arguments: JSON.stringify({ file_path: './deploy.key' }),
      call_id: 'nessy_handoff_k3',
    })
    expect(items[call + 1]).toEqual({
      type: 'function_call_output',
      call_id: 'nessy_handoff_k3',
      output: 'DEPLOY_FINGERPRINT=opal-lantern-77',
    })

    // NEGATIVE CONTROL — the state before T1b. On a `text` plan the same
    // transcript carries no tool traffic at all, so the fact does not cross.
    const textPayload = buildRuntimeHandoffPayload({ rows: secretInAToolResultOnly, ...armedFromPi, plan: 'text' })
    expect(JSON.stringify(buildCodexInjectItems(textPayload!))).not.toContain('opal-lantern-77')
  })
})

/**
 * P3.102 · the pointer crosses on EVERY plan, not only on a rebuilt one.
 *
 * **The gap, measured at HEAD before the fix, with its control on the same
 * rig.** `handoffAttachmentBlock`'s output was reachable only through
 * `buildRuntimeHandoffHistory`, and only the two REBUILD arms passed the hook —
 * both of which run exclusively on a `native` plan. So the control
 * (`buildRuntimeHandoffHistory` + hook) carried path and note on all three
 * targets, while `buildRuntimeHandoffPayload` on `text` / `anchor` / no plan
 * carried **neither, on all three** — and `buildRuntimeHandoffContext`, the
 * block the model actually reads, did not even carry the file's NAME. Nine
 * cells, all empty, against a control that was full in three.
 *
 * **`text` is not the fringe case; it is where the fallbacks land.** A `native`
 * plan whose Claude or Pi rebuild fails is NOT downgraded — `runtimeHandoffPlan`
 * stays `native` and only the durable notice is corrected — so the armed TEXT
 * handoff is what delivers, through `messages`. Codex's refused
 * `thread/inject_items` falls back to `buildRuntimeHandoffContext(handoff.from,
 * handoff.messages)` inside the same turn. Both read the leg that carried least.
 *
 * All three runtimes are driven here because the payload builder is the one
 * seam all three share: `BaseAgent.chat` composes the text block for every
 * backend, so a per-target fix would have been a per-target hole.
 */
describe('P3.102 · an attachment pointer crosses on every handoff plan', () => {
  /** The three providers a cross-runtime switch can actually land on. */
  const TARGETS = ['pi', 'anthropic', 'codex-runtime'] as const
  /** Every plan whose delivery goes through `messages`, plus the absent one. */
  const TEXT_TIER_PLANS = ['text', 'anchor', undefined] as const

  const withImage: RuntimeHandoffRow[] = [
    {
      id: 'p1',
      role: 'user',
      content: 'what is wrong here',
      attachments: [{ id: 'att-1', name: 'bug.png', type: 'image', mimeType: 'image/png' }],
    },
    { id: 'p2', role: 'assistant', content: 'looking now' },
  ]

  const hook = (row: RuntimeHandoffRow) => (row.attachments?.length
    ? handoffAttachmentBlock({
        name: row.attachments[0]!.name,
        type: row.attachments[0]!.type,
        mimeType: row.attachments[0]!.mimeType,
        resolvedPath: '/sessions/s1/attachments/bug.png',
      })
    : undefined)

  const armed = (target: typeof TARGETS[number]) => ({
    rows: withImage,
    from: 'pi' as const,
    applied: false,
    target,
    targetHasAnchor: false,
  })

  it('reaches `messages` on the text tier, on all three runtimes, with its control', () => {
    for (const target of TARGETS) {
      for (const plan of TEXT_TIER_PLANS) {
        const carried = buildRuntimeHandoffPayload({ ...armed(target), plan, attachmentBlock: hook })
        expect(carried!.messages[0]!.content).toBe(
          'what is wrong here\n\n'
          + '[Attached image: bug.png]\n'
          + '[Stored at: /sessions/s1/attachments/bug.png]\n'
          + HANDOFF_IMAGE_NOTE,
        )

        // CONTROL — the same transcript, the same target, the same plan, the
        // hook withheld. This is the shipped pre-P3.102 behaviour and it must
        // stay byte-identical, because it is what every caller that has no
        // attachments to resolve still gets.
        const bare = buildRuntimeHandoffPayload({ ...armed(target), plan })
        expect(bare!.messages[0]!.content).toBe('what is wrong here')
        expect(JSON.stringify(bare)).not.toContain('bug.png')
      }
    }
  })

  /**
   * THE CASE THAT MATTERS MOST, and the one a happy-path row misses.
   *
   * A `native` plan whose rebuild did not land keeps `plan: 'native'` — the
   * downgrade is applied to the durable NOTICE only — so the delivery falls
   * through to `messages` while the payload still says `native`. That is the
   * exact shape asserted here: on a `native` plan the pointer must be in BOTH
   * legs, because either one of them can be the one that delivers.
   */
  it('REBUILD-FAILED FALLBACK · a `native` payload carries the pointer in both legs', () => {
    for (const target of TARGETS) {
      const payload = buildRuntimeHandoffPayload({ ...armed(target), plan: 'native', attachmentBlock: hook })
      // The leg a failed rebuild actually delivers through.
      expect(payload!.messages[0]!.content).toContain('/sessions/s1/attachments/bug.png')
      expect(payload!.messages[0]!.content).toContain(HANDOFF_IMAGE_NOTE)
      // The leg a landed native carry delivers through — Codex's inject items
      // among them, which referenced no attachment at all before this row.
      expect(JSON.stringify(payload!.history)).toContain('/sessions/s1/attachments/bug.png')
      expect(JSON.stringify(buildCodexInjectItems(payload!))).toContain(HANDOFF_IMAGE_NOTE)

      // CONTROL — the same native payload without the hook, which is what both
      // legs carried before P3.102: the filename appears nowhere.
      const bare = buildRuntimeHandoffPayload({ ...armed(target), plan: 'native' })
      expect(JSON.stringify(bare)).not.toContain('bug.png')
    }
  })

  it('keeps a row whose only content IS the attachment, which the bare fold would leave empty', () => {
    const attachmentOnly: RuntimeHandoffRow[] = [
      { id: 'q1', role: 'user', content: '', attachments: [{ id: 'att-1', name: 'bug.png', type: 'image', mimeType: 'image/png' }] },
    ]
    const payload = buildRuntimeHandoffPayload({
      rows: attachmentOnly, from: 'pi', applied: false, target: 'pi', targetHasAnchor: false, plan: 'text',
      attachmentBlock: hook,
    })
    // No leading blank line: the empty half is dropped, not joined.
    expect(payload!.messages[0]!.content).toBe(
      '[Attached image: bug.png]\n[Stored at: /sessions/s1/attachments/bug.png]\n' + HANDOFF_IMAGE_NOTE,
    )
  })

  it('leaves a non-image byte-identical to the D6 block on the text tier too', () => {
    const withFile: RuntimeHandoffRow[] = [
      { id: 'f1', role: 'user', content: 'read this', attachments: [{ id: 'att-1', name: 'notes.txt', type: 'file', mimeType: 'text/plain' }] },
    ]
    const payload = buildRuntimeHandoffPayload({
      rows: withFile, from: 'pi', applied: false, target: 'anthropic', targetHasAnchor: false, plan: 'text',
      attachmentBlock: row => handoffAttachmentBlock({
        name: row.attachments![0]!.name,
        type: row.attachments![0]!.type,
        mimeType: row.attachments![0]!.mimeType,
        resolvedPath: '/s/notes.txt',
      }),
    })
    expect(payload!.messages[0]!.content).toBe('read this\n\n[Attached file: notes.txt]\n[Stored at: /s/notes.txt]')
    expect(payload!.messages[0]!.content).not.toContain(HANDOFF_IMAGE_NOTE)
  })

  /**
   * P3.102 · the pointer in the block the MODEL reads — and P3.153, the two
   * bounds that used to eat it.
   *
   * A payload field is not a thing a model has seen. `BaseAgent.chat` composes
   * the text handoff with `buildRuntimeHandoffContext(handoff.from,
   * handoff.messages)` for every backend — and so does `CodexAgent`'s in-turn
   * fallback — so this is the last hop before the prompt, and it is where the
   * claim "the pointer crosses" is either true or not.
   *
   * **P3.153 CLOSED both bounds, and they were closed differently because they
   * are different defects.**
   *
   * Bound 1 was the 1 200-character cap, and it was the dangerous one: the cut
   * landed at a character offset, so a long message left `[Attached image: …]`
   * standing over a HALF path — a string that looks openable and resolves to
   * nothing. `capTranscriptEntry` now keeps the entry's trailing whole lines,
   * so a path is carried entire or not at all. Pinned below in both
   * directions: the pointer survives the cap, and a single-line body — which
   * has no complete trailing line to protect — is still truncated exactly as
   * before, marker included.
   *
   * Bound 2 was the 24-message window, and it is a LOSS rather than a lie: the
   * message and everything it introduced fall out together. It is not hoisted
   * (that would put a file in front of the model with none of the conversation
   * that explains it — the owner's own objection to bulk re-attachment at
   * P3.57), so what changed is that the block now SAYS a cut happened instead
   * of staying silent about it.
   *
   * Measured against the local corpus first — 949 `session.jsonl` files hold 2
   * rows carrying attachments, both images, both with 48-character content —
   * so neither bound was reached by anything written before the fix. That is a
   * statement about today's corpus, not about the code.
   */
  it('the pointer reaches the model, survives the cap, and the window says when it did not', () => {
    const carried = (content: string) => buildRuntimeHandoffPayload({
      rows: [{ id: 'r1', role: 'user', content, attachments: [{ id: 'att-1', name: 'bug.png', type: 'image', mimeType: 'image/png' }] }],
      from: 'pi',
      applied: false,
      target: 'pi',
      targetHasAnchor: false,
      plan: 'text',
      attachmentBlock: hook,
    })!

    // The claim itself: a short message's pointer arrives whole in the fenced
    // block the model is handed.
    const short = buildRuntimeHandoffContext('pi', carried('what is wrong here').messages)!
    expect(short).toContain('[Attached image: bug.png]')
    expect(short).toContain('[Stored at: /sessions/s1/attachments/bug.png]')
    expect(short).toContain(HANDOFF_IMAGE_NOTE)

    // BOUND 1, CLOSED — the message's own words lose their tail to the cap and
    // the whole pointer rides through underneath it. The `...[truncated]`
    // marker still says a cut happened, and it now sits BEFORE the block rather
    // than through it.
    const long = buildRuntimeHandoffContext('pi', carried('x'.repeat(1_150)).messages)!
    expect(long).toContain('...[truncated]')
    expect(long).toContain('[Attached image: bug.png]')
    expect(long).toContain('[Stored at: /sessions/s1/attachments/bug.png]')
    expect(long).toContain(HANDOFF_IMAGE_NOTE)
    expect(long.indexOf('...[truncated]')).toBeLessThan(long.indexOf('[Attached image: bug.png]'))

    // …and the path is never HALF there, which is the property the fix is
    // actually for. Every `[Stored at: …]` occurrence closes its own bracket.
    for (const line of long.split('\n')) {
      if (!line.startsWith('[Stored at: ')) continue
      expect(line).toEndWith(']')
    }

    // BOUND 2 — the 24-message window still drops the message and its pointer
    // together, deliberately: hoisting the file up here would show the model a
    // screenshot with none of the conversation that explains it. What changed
    // is that the block no longer keeps that quiet.
    const buried = buildRuntimeHandoffPayload({
      rows: [
        { id: 'img', role: 'user', content: 'look', attachments: [{ id: 'att-1', name: 'bug.png', type: 'image', mimeType: 'image/png' }] },
        ...Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` })),
      ],
      from: 'pi',
      applied: false,
      target: 'pi',
      targetHasAnchor: false,
      plan: 'text',
      attachmentBlock: hook,
    })!
    expect(JSON.stringify(buried.messages)).toContain('bug.png')
    const buriedText = buildRuntimeHandoffContext('pi', buried.messages)!
    expect(buriedText).not.toContain('bug.png')
    expect(buriedText).toContain('Only the last 24 of 31 messages are reproduced below; the 7 earlier ones are not, and neither are the files they named.')
  })
})

/**
 * P2.125 · the handoff carries an image as a POINTER, on every target, and
 * never as a synthesized content block — pinned as a refusal, with the three
 * measurements that make it one.
 *
 * The row this closes proposed the opposite: replay a structured image block
 * across the switch the way omnigent does. Three independent findings say no,
 * and none of them is a preference.
 *
 * 1. **The owner reversed it** (P3.57, 2026-08-28), after objecting to the
 *    controller's own bulk-re-attachment proposal on grounds that apply to
 *    transcript embedding too: an image attached to message 3 of 20 must not
 *    reappear as content the conversation never placed there. The verdict was
 *    *"a better design than either transcript embedding or bulk
 *    re-attachment, and it already ships"* — the pointer the model opens on
 *    demand, in position, with one tool call.
 * 2. **The default codex upstream REFUSES an image part.** Measured against the
 *    Nessy gateway 2026-08-28 and recorded at the site
 *    (`codex-responses-adapter/src/to-chat.ts`, `toChatContent`): the gateway
 *    parses the part and answers 400 — *"Invalid Chat Message Part: Model Does
 *    Not Support Image Inputs"* — where a text-part array answers 200. On a
 *    live turn that is one visible refusal; on the HANDOFF it would fail the
 *    leg that exists to be the fallback.
 * 3. **The block form is required precisely because base64-in-text is ruinous**
 *    — omnigent measured seven ~390 KB PNGs expanding to ~2.5 M tokens — so the
 *    cheap version of this row is not a smaller version of it, it is a
 *    context-destroying one.
 *
 * **What is NOT the reason: "codex cannot".** That premise is dead. P6.28 gave
 * codex its native `localImage` wire and P3.114 gave the responses adapter an
 * `input_image` → `image_url` translation, so the bytes now reach the endpoint;
 * what stops them is the served model's capability, one hop further on. Read
 * this file's refusal as a design decision with a measured cost, never as a
 * missing mechanism.
 *
 * The seam is the right place for the pin. `RuntimeHandoffHistoryItem`'s
 * message content is a `string`, so BOTH rebuild arms — Claude's transcript and
 * Pi's carry session — are structurally incapable of receiving a block from
 * here, and `buildCodexInjectItems` maps the same string to `input_text`. The
 * Claude arm additionally has a byte-level base64 pin of its own in
 * `runtime-switch-session.test.ts`.
 */
describe('P2.125 · an image crosses as a pointer, never as a synthesized block', () => {
  const imageRow: RuntimeHandoffRow[] = [
    {
      id: 'i1',
      role: 'user',
      content: 'what is wrong here',
      attachments: [{ id: 'att-1', name: 'bug.png', type: 'image', mimeType: 'image/png' }],
    },
  ]

  const pointer = (row: RuntimeHandoffRow) => (row.attachments?.length
    ? handoffAttachmentBlock({
        name: row.attachments[0]!.name,
        type: row.attachments[0]!.type,
        mimeType: row.attachments[0]!.mimeType,
        resolvedPath: '/sessions/s1/attachments/bug.png',
      })
    : undefined)

  it('the row projection both rebuild arms consume emits text, and says the image did not cross', () => {
    const history = buildRuntimeHandoffHistory({
      rows: imageRow,
      target: 'anthropic',
      targetHasAnchor: false,
      attachmentBlock: pointer,
    })

    expect(history).toHaveLength(1)
    const entry = history[0]!
    expect(entry.kind).toBe('message')
    // The POSITIVE CONTROL for every absence below: the hook fired and the
    // pointer is really in this string. A zero measured against a projection
    // that never saw the attachment would be a dead control.
    expect(entry.kind === 'message' && entry.content).toContain('[Stored at: /sessions/s1/attachments/bug.png]')
    expect(entry.kind === 'message' && entry.content).toContain(HANDOFF_IMAGE_NOTE)
    // …and it is a string, which is what makes a block structurally
    // unreachable in both rebuild arms rather than merely absent today.
    expect(typeof (entry.kind === 'message' ? entry.content : '')).toBe('string')
    expect(JSON.stringify(history)).not.toContain('base64')
    expect(JSON.stringify(history)).not.toContain('"type":"image"')
  })

  it('the codex items carry input_text and no image part', () => {
    const payload = buildRuntimeHandoffPayload({
      rows: imageRow,
      from: 'pi',
      applied: false,
      target: 'codex-runtime',
      targetHasAnchor: false,
      plan: 'native',
      attachmentBlock: pointer,
    })!
    const items = buildCodexInjectItems(payload)

    expect(items).toHaveLength(1)
    const serialized = JSON.stringify(items)
    // Positive control first, again: the pointer reached the items.
    expect(serialized).toContain('bug.png')
    expect(serialized).toContain('input_text')
    // The two shapes an image would have to take on this wire, and the payload
    // that would blow the context if it did.
    expect(serialized).not.toContain('input_image')
    expect(serialized).not.toContain('image_url')
    expect(serialized).not.toContain('base64')
  })

  it('the text tier says the same thing about the same file', () => {
    const payload = buildRuntimeHandoffPayload({
      rows: imageRow,
      from: 'pi',
      applied: false,
      target: 'pi',
      targetHasAnchor: false,
      plan: 'text',
      attachmentBlock: pointer,
    })!
    expect(payload.messages[0]!.content).toContain('[Attached image: bug.png]')
    expect(payload.messages[0]!.content).toContain(HANDOFF_IMAGE_NOTE)
    expect(JSON.stringify(payload)).not.toContain('base64')
  })
})

/**
 * P6.604 + P6.481 — reasoning crosses a switch, within one runtime only.
 *
 * The premise it corrects is not "reasoning does not cross". Before this pair a
 * thinking row projected as `{kind:'message', role:'assistant'}` — the previous
 * model's private reasoning handed to the next one as prose it had spoken out
 * loud, an `output_text` on the codex leg and a `text` block on claude's.
 */
describe('P6.604 · a reasoning row is its own kind, and only crosses within one runtime', () => {
  const thinking: RuntimeHandoffRow[] = [
    { id: 'r1', role: 'user', content: 'why is it slow' },
    {
      id: 'r2',
      role: 'assistant',
      content: 'the loop is O(n^2); check the join',
      isIntermediate: true,
      isThinking: true,
      thinkingSignature: 'CAISmQIKiAEIEBgC',
    },
    { id: 'r3', role: 'assistant', content: 'the join is quadratic' },
  ]

  it('same-runtime: the row becomes a `reasoning` entry carrying its signature', () => {
    const history = buildRuntimeHandoffHistory({
      rows: thinking,
      target: 'anthropic',
      targetHasAnchor: false,
      origin: 'anthropic',
    })
    expect(history).toEqual([
      { kind: 'message', role: 'user', content: 'why is it slow' },
      { kind: 'reasoning', content: 'the loop is O(n^2); check the join', signature: 'CAISmQIKiAEIEBgC' },
      { kind: 'message', role: 'assistant', content: 'the join is quadratic' },
    ])
    // The regression this row exists to prevent: it must NOT be an assistant
    // message any more.
    expect(history.some(e => e.kind === 'message' && e.content.startsWith('the loop'))).toBe(false)
  })

  it('foreign-origin: the row is DROPPED, and the drop is announced', () => {
    const lines: string[] = []
    const history = buildRuntimeHandoffHistory({
      rows: thinking,
      target: 'codex-runtime',
      targetHasAnchor: false,
      origin: 'anthropic',
      log: message => lines.push(message),
    })
    expect(history.map(e => e.kind)).toEqual(['message', 'message'])
    expect(JSON.stringify(history)).not.toContain('O(n^2)')
    expect(lines.join('\n')).toContain('reasoning crosses only within one runtime')
  })

  it('unattributable: no `runtime` on the row and no `origin` means DROPPED, never guessed', () => {
    const history = buildRuntimeHandoffHistory({
      rows: thinking,
      target: 'anthropic',
      targetHasAnchor: false,
    })
    expect(history.map(e => e.kind)).toEqual(['message', 'message'])
  })

  it('the row\'s own `runtime` outranks the handoff origin', () => {
    const rows: RuntimeHandoffRow[] = [{
      id: 'x', role: 'assistant', content: 'thought', isIntermediate: true, isThinking: true, runtime: 'pi',
    }]
    expect(buildRuntimeHandoffHistory({ rows, target: 'pi', targetHasAnchor: false, origin: 'anthropic' }))
      .toEqual([{ kind: 'reasoning', content: 'thought', runtime: 'pi' }])
    expect(buildRuntimeHandoffHistory({ rows, target: 'anthropic', targetHasAnchor: false, origin: 'anthropic' }))
      .toEqual([])
  })

  it('P6.481 · the codex mapper emits codex\'s own replay shape, attestation NULL', () => {
    const payload = buildRuntimeHandoffPayload({
      rows: thinking,
      from: 'codex-runtime',
      applied: false,
      target: 'codex-runtime',
      targetHasAnchor: false,
      plan: 'native',
    })!
    const items = buildCodexInjectItems(payload)
    // `ReasoningResponseItem` at rust-v0.148.0 is required:["summary","type"],
    // with `encrypted_content` typed `["string","null"]` — so a null attestation
    // is the schema's own value, not a placeholder we invented.
    expect(items).toContainEqual({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'the loop is O(n^2); check the join' }],
      encrypted_content: null,
    })
    // It is NOT an assistant message any more.
    expect(JSON.stringify(items)).not.toContain('"output_text","text":"the loop')
  })
})
