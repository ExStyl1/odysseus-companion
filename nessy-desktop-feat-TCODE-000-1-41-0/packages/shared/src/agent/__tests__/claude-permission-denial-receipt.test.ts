/**
 * **P3.97 — the classifier-denial receipt, and the premise correction it rests on.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, row P3.97. The
 * row's build instruction was sound and its cited FIELD LOCATION was not: it
 * says `result.permission_denials` carries `decision_reason_type: 'classifier'`.
 * It does not, in either vendored artefact, and an implementation written to
 * that sentence would have read `undefined` and recorded every classifier
 * denial as untyped — the exact defect the row exists to close.
 *
 * The membership rule applies here in its strongest form: **the vendored bundle
 * is the denominator.** The three declaration pins below read the SHIPPED
 * `sdk.d.ts` rather than quoting a page, so an SDK bump that moves the
 * discriminator fails here instead of silently un-typing the audit record.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

import { bracedRegion } from '../../testing/source-regions.ts'

import {
  CLAUDE_CLASSIFIER_DECISION_REASON_TYPE,
  CLAUDE_PERMISSION_DENIAL_RECEIPT_MARKER,
  CLAUDE_UNKNOWN_DECISION_REASON_TYPE,
  buildClaudeAutoModeDenialReceipt,
  buildClaudeStreamDenialReceipt,
  formatClaudeDenialTypeLabel,
  formatClaudePermissionDenialReceipt,
  parseClaudePermissionDenialReceipt,
} from '../claude-permission-denial-receipt.ts'

/** The installed SDK's typings — the artefact, not a page about it. */
function sdkTypings(): string {
  const entry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir)
  return readFileSync(`${entry.slice(0, entry.lastIndexOf('/'))}/sdk.d.ts`, 'utf8')
}

/** The body of one `export declare type <name> = …;` block. */
function declarationBody(source: string, name: string): string {
  const at = source.indexOf(`export declare type ${name} = `)
  if (at < 0) throw new Error(`${name} is not declared in the installed sdk.d.ts`)
  const end = source.indexOf('\n};', at)
  if (end < 0) throw new Error(`${name} is not an object declaration in the installed sdk.d.ts`)
  return source.slice(at, end)
}

describe('P3.97 · where the denial discriminator actually lives', () => {
  const source = sdkTypings()

  /**
   * THE PREMISE CORRECTION. `result.permission_denials` is typed
   * `SDKPermissionDenial[]`, and that element carries three fields. The shipped
   * binary (2.1.223) agrees at the schema level — its validator is
   * `E.object({tool_name,tool_use_id,tool_input})` — so this is not a typings
   * lag. There is nothing on this channel to read a type from.
   */
  it('result.permission_denials carries NO decision_reason_type — the row said it did', () => {
    const denial = declarationBody(source, 'SDKPermissionDenial')
    expect(denial).toContain('tool_name')
    expect(denial).toContain('tool_use_id')
    expect(denial).toContain('tool_input')
    expect(denial).not.toContain('decision_reason_type')
    expect(denial).not.toContain('decision_reason')
  })

  /**
   * The hook has the INPUT and not the type. So neither channel the row names
   * is complete on its own, which is why the receipt records how it knows its
   * own type instead of pretending it read one.
   */
  it('the PermissionDenied hook carries tool_input and reason but no discriminator', () => {
    const hook = declarationBody(source, 'PermissionDeniedHookInput')
    for (const field of ['tool_name', 'tool_input', 'tool_use_id', 'reason']) {
      expect(hook).toContain(field)
    }
    expect(hook).not.toContain('decision_reason_type')
  })

  /**
   * The one channel that does carry it — and, since 2026-09-03, the channel the
   * receipt is MINTED from. This test's own comment used to say the missing
   * `tool_input` is "why it cannot be the receipt's source"; that was a
   * conclusion drawn from one field, and it kept the audit record dormant for
   * two waves while the only live channel sat here being read for a label.
   * The absence is real and is now recorded IN the receipt (a `'payload'`
   * source with no `toolInput`) instead of being a reason to record nothing.
   */
  it('the system/permission_denied message is the only channel with the discriminator', () => {
    const message = declarationBody(source, 'SDKPermissionDeniedMessage')
    expect(message).toContain('decision_reason_type')
    expect(message).toContain('decision_reason')
    // The join key and the tool name — without these two there is no receipt to
    // mint from this channel at all, so they are pinned as hard as the type.
    expect(message).toContain('tool_use_id')
    expect(message).toContain('tool_name')
    // `message` is the fallback reason: the binary's own reason formatter
    // returns nothing for `rule`, `mode`, `subcommandResults` and
    // `permissionPromptTool`, so without it the commonest denials are reasonless.
    expect(message).toContain('message: string')
    // The cost of choosing this channel, pinned so it cannot be forgotten.
    expect(message).not.toContain('tool_input')
  })
})

describe('P3.97 · minting the receipt', () => {
  const base = {
    sessionId: 'sess-1',
    toolName: 'Bash',
    toolUseId: 'toolu_01ABC',
    toolInput: { command: 'rm -rf /tmp/build', description: 'Clean build directory' },
    reason: 'Blocked by classifier',
    permissionMode: 'auto',
    now: new Date('2026-08-28T10:00:00.000Z'),
  }

  it('stamps the classifier type and says the CHANNEL is how it knows', () => {
    const receipt = buildClaudeAutoModeDenialReceipt(base)!
    expect(receipt).toMatchObject({
      version: 1,
      provider: 'claude',
      sessionId: 'sess-1',
      toolName: 'Bash',
      toolUseId: 'toolu_01ABC',
      decisionReasonType: CLAUDE_CLASSIFIER_DECISION_REASON_TYPE,
      // Never `payload`: the hook input has no type field to read (pinned above).
      decisionReasonTypeSource: 'hook-gate',
      reason: 'Blocked by classifier',
      permissionMode: 'auto',
      deniedAt: '2026-08-28T10:00:00.000Z',
    })
    // A refusal receipt that does not say what was refused is not an audit
    // record — `PiPermissionReceiptV1.canonicalInput` is the precedent.
    expect(receipt.toolInput).toEqual(base.toolInput)
  })

  it('round-trips through the debug marker the session log already carries', () => {
    const receipt = buildClaudeAutoModeDenialReceipt(base)!
    const line = formatClaudePermissionDenialReceipt(receipt)
    expect(line.startsWith(CLAUDE_PERMISSION_DENIAL_RECEIPT_MARKER)).toBe(true)
    expect(parseClaudePermissionDenialReceipt(line)).toEqual(receipt)
    expect(parseClaudePermissionDenialReceipt('nothing to see here')).toBeNull()
    expect(parseClaudePermissionDenialReceipt(`${CLAUDE_PERMISSION_DENIAL_RECEIPT_MARKER}{oops`)).toBeNull()
  })

  /**
   * The negative half. A record naming no tool, or joined to no tool call, is
   * worse than no record because it looks like evidence — so it is refused
   * rather than minted with an empty field.
   */
  it('refuses to mint a receipt that identifies nothing', () => {
    expect(buildClaudeAutoModeDenialReceipt({ ...base, toolName: '' })).toBeNull()
    expect(buildClaudeAutoModeDenialReceipt({ ...base, toolName: undefined })).toBeNull()
    expect(buildClaudeAutoModeDenialReceipt({ ...base, toolUseId: '   ' })).toBeNull()
    expect(buildClaudeAutoModeDenialReceipt({ ...base, toolUseId: 42 })).toBeNull()
  })

  /**
   * An absent reason is a real state, not a defect: the binary passes the fixed
   * string `"Permission denied"` when the decision carried none, and a
   * non-object `tool_input` is dropped rather than coerced.
   */
  it('normalises a missing reason and a non-object input without refusing the receipt', () => {
    const receipt = buildClaudeAutoModeDenialReceipt({ ...base, reason: undefined, toolInput: 'not-an-object' })!
    expect(receipt.reason).toBe('')
    expect(receipt.toolInput).toBeUndefined()
  })
})

/**
 * Source probe. The internal hook map is an object literal inside the `query()`
 * options builder — a unit test cannot reach it without constructing an agent
 * and a live query, and the `claude-scheduling-projection` suite established
 * this shape for exactly that reason. Every claim here carries its own control.
 */
describe('P3.97 · the hook is registered on the claude path', () => {
  const source = readFileSync(new URL('../claude-agent.ts', import.meta.url).pathname, 'utf8')

  it('registers PermissionDenied in the internal hook map and mints from it', () => {
    // Positive control: the read works and finds a matcher that was already here.
    expect(source).toMatch(/^\s*SubagentStart: \[\{/m)
    expect(source).toMatch(/^\s*PermissionDenied: \[\{/m)
    expect(source).toContain('formatClaudePermissionDenialReceipt(receipt)')
  })

  /**
   * Observational only. `hookSpecificOutput.retry` is the one documented lever
   * on this event, and minting an audit record is not a reason to re-run a
   * refused action — a retry policy nobody asked for would be a new permission
   * behaviour smuggled in behind an audit row. Matched by SHAPE so a different
   * spelling cannot slip past.
   */
  it('never returns retry from the audit hook', () => {
    const at = source.indexOf('PermissionDenied: [{')
    expect(at).toBeGreaterThan(0)
    // D1.111 — the hook ENTRY's own braces, not a 2 000-character window. The
    // anchor ends in `[{`, so the first `{` at or after it is the entry object
    // and the region is the hook body exactly.
    const block = bracedRegion(source, at)
    expect(block).not.toMatch(/retry/)
    // Control on the same slice: it really is the hook body being read.
    expect(block).toContain('buildClaudeAutoModeDenialReceipt')
    expect(block).toContain('{ continue: true }')
    // The BOUNDARY control, naming a heading BELOW the region: a brace scan runs
    // forward, so a runaway would swallow the subagent-hooks block underneath.
    expect(block).not.toContain('SUBAGENT HOOKS')
  })
})

describe('P3.97 · minting from the SDK\'s own denial event — the live channel', () => {
  const base = {
    sessionId: 'sess-2',
    toolName: 'Bash',
    toolUseId: 'toolu_02XYZ',
    decisionReasonType: 'classifier',
    decisionReason: 'Auto mode could not evaluate this action and is blocking it for safety',
    message: 'Permission denied',
    permissionMode: 'auto',
    now: new Date('2026-09-03T12:00:00.000Z'),
  }

  /**
   * THE DECISION, as an assertion. `payload` was a declared-and-never-minted
   * member of `ClaudePermissionDenialTypeSource` until this channel was wired:
   * the type is READ here, not implied by a gate, and the receipt says so.
   */
  it('reads the type off the payload and says the payload is how it knows', () => {
    const receipt = buildClaudeStreamDenialReceipt(base)!
    expect(receipt).toMatchObject({
      version: 1,
      provider: 'claude',
      sessionId: 'sess-2',
      toolName: 'Bash',
      toolUseId: 'toolu_02XYZ',
      decisionReasonType: 'classifier',
      decisionReasonTypeSource: 'payload',
      reason: base.decisionReason,
      permissionMode: 'auto',
      deniedAt: '2026-09-03T12:00:00.000Z',
    })
    // The cost of this channel, asserted rather than described: the message
    // carries no `tool_input`, so the receipt carries none either. A `payload`
    // source with no `toolInput` IS the stream channel's signature.
    expect(receipt.toolInput).toBeUndefined()
    expect(formatClaudePermissionDenialReceipt(receipt)).toContain(CLAUDE_PERMISSION_DENIAL_RECEIPT_MARKER)
    expect(parseClaudePermissionDenialReceipt(formatClaudePermissionDenialReceipt(receipt))).toEqual(receipt)
  })

  /**
   * The channel's REACH, which is the reason it was chosen: it is not the
   * classifier's channel, it is every denial the binary decides for itself.
   */
  it('records a rule and a mode denial, whose only text is the rejection message', () => {
    const rule = buildClaudeStreamDenialReceipt({
      ...base, decisionReasonType: 'rule', decisionReason: undefined,
      message: 'Bash(rm:*) is blocked by a deny rule',
    })!
    expect(rule.decisionReasonType).toBe('rule')
    expect(rule.reason).toBe('Bash(rm:*) is blocked by a deny rule')

    const mode = buildClaudeStreamDenialReceipt({ ...base, decisionReasonType: 'mode', decisionReason: '' })!
    expect(mode.decisionReasonType).toBe('mode')
    expect(mode.reason).toBe('Permission denied')
  })

  /**
   * `decision_reason_type` is OPTIONAL in `sdk.d.ts`. An empty type beside a
   * `'payload'` source would read as "not recorded" when it was; the binary's
   * own telemetry writes `"unknown"` for exactly this state, so that word is
   * read rather than chosen.
   */
  it('names an absent type instead of leaving the field blank', () => {
    expect(buildClaudeStreamDenialReceipt({ ...base, decisionReasonType: undefined })!.decisionReasonType)
      .toBe(CLAUDE_UNKNOWN_DECISION_REASON_TYPE)
    expect(buildClaudeStreamDenialReceipt({ ...base, decisionReasonType: 7 })!.decisionReasonType)
      .toBe(CLAUDE_UNKNOWN_DECISION_REASON_TYPE)
    expect(buildClaudeStreamDenialReceipt({ ...base, decisionReasonType: '   ' })!.decisionReasonType)
      .toBe(CLAUDE_UNKNOWN_DECISION_REASON_TYPE)
  })

  /**
   * The type is producer-authored text typed `string`, not the closed union its
   * ask-path sibling uses — so it is bounded on the way into the receipt by the
   * SAME function that bounds it on the way into the transcript. One sanitizer,
   * so an auditor and a user can never be shown different types.
   */
  it('bounds a producer-authored type the same way the transcript label does', () => {
    const junk = 'class[31mifier\n): injected'
    expect(buildClaudeStreamDenialReceipt({ ...base, decisionReasonType: junk })!.decisionReasonType)
      .toBe('class 31mifier injected')
    expect(formatClaudeDenialTypeLabel(junk)).toBe(' (class 31mifier injected)')
    expect(buildClaudeStreamDenialReceipt({ ...base, decisionReasonType: 'x'.repeat(200) })!.decisionReasonType)
      .toBe('x'.repeat(40))
  })

  /** The negative half, on the same terms as the hook path. */
  it('refuses to mint a receipt that identifies nothing', () => {
    expect(buildClaudeStreamDenialReceipt({ ...base, toolName: '' })).toBeNull()
    expect(buildClaudeStreamDenialReceipt({ ...base, toolUseId: undefined })).toBeNull()
    expect(buildClaudeStreamDenialReceipt({ ...base, toolUseId: 42 })).toBeNull()
  })

  /**
   * Source probe — the wiring, which no unit test can reach without a live
   * query. Same shape as the hook probe above, and every claim has a control.
   */
  describe('the wiring', () => {
    const adapter = readFileSync(new URL('../backend/claude/event-adapter.ts', import.meta.url).pathname, 'utf8')
    const agent = readFileSync(new URL('../claude-agent.ts', import.meta.url).pathname, 'utf8')

    it('the adapter hands the denial on from the permission_denied branch', () => {
      // The needle is DOUBLE-quoted on purpose: `check-braced-region-controls.ts`
      // reads the first single- or double-quoted literal of the `indexOf(` call
      // as the anchor, and a backticked template hands it the inner
      // `'permission_denied'` — which occurs in `claude-agent.ts` too, so the
      // gate resolved the wrong source and called this file's control unfailable.
      const at = adapter.indexOf("msg.subtype === 'permission_denied'")
      expect(at).toBeGreaterThan(0)
      // D1.111 — the `else if` branch's own block. The template literal inside it
      // carries `${…}`, whose braces balance textually, which is the one thing
      // this brace matcher needs.
      const block = bracedRegion(adapter, at)
      expect(block).toContain('this.callbacks.onPermissionDenied?.(denial)')
      // Control on the same slice: it is the branch that already rendered the label.
      expect(block).toContain('formatClaudeDenialTypeLabel(denial.decision_reason_type)')
      // The BOUNDARY control: the NEXT branch of the same chain, below this one.
      expect(block).not.toContain("msg.subtype === 'mirror_error'")
    })

    it('the agent fulfils the seam and mints through the marker the log already carries', () => {
      expect(agent).toContain('onPermissionDenied: (denial) => this.mintStreamPermissionDenialReceipt(denial)')
      const at = agent.indexOf('private mintStreamPermissionDenialReceipt(')
      expect(at).toBeGreaterThan(0)
      // D1.111 — and the anchor needs ONE more step than the others, which is
      // the trap `source-regions.ts` names: this method's first `{` is its
      // PARAMETER TYPE literal, so a region anchored on the declaration would be
      // the signature and nothing else. Anchor past the signature instead.
      const bodyAt = agent.indexOf('): void {', at)
      expect(bodyAt).toBeGreaterThan(at)
      const block = bracedRegion(agent, bodyAt)
      expect(block).toContain('buildClaudeStreamDenialReceipt')
      expect(block).toContain('formatClaudePermissionDenialReceipt(receipt)')
      // Observational only — the same standing rule as the hook mint. A denial
      // audit must not become a permission behaviour.
      expect(block).not.toMatch(/retry/)
      // The BOUNDARY control: the next method below this one.
      expect(block).not.toContain('getPermissionMode(): PermissionMode')
    })
  })
})

describe('P3.97 · the transcript label for a stream denial', () => {
  it('names the discriminator so a classifier denial stops reading like a rule denial', () => {
    expect(formatClaudeDenialTypeLabel('classifier')).toBe(' (classifier)')
    expect(formatClaudeDenialTypeLabel('mode')).toBe(' (mode)')
  })

  it('is inert when the field is absent, and bounded when it is producer-authored junk', () => {
    expect(formatClaudeDenialTypeLabel(undefined)).toBe('')
    expect(formatClaudeDenialTypeLabel('')).toBe('')
    expect(formatClaudeDenialTypeLabel(7)).toBe('')
    // `sdk.d.ts` types this `string`, not a closed union, and warns that sibling
    // reason fields "may carry ANSI escapes; sanitize before rendering".
    expect(formatClaudeDenialTypeLabel('class[31mifier\n): injected')).toBe(' (class 31mifier injected)')
    expect(formatClaudeDenialTypeLabel('x'.repeat(200))).toBe(` (${'x'.repeat(40)})`)
  })
})
