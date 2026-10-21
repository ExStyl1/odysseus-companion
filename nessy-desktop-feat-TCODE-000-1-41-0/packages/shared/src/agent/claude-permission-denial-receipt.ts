/**
 * **P3.97 — a classifier denial finally becomes a record with a TYPE on it.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, row P3.97.
 * Before this module, `backend/claude/event-adapter.ts` read
 * `denial.decision_reason || denial.message` and never the discriminator, so a
 * denial minted by the SDK's auto-mode classifier was indistinguishable, in our
 * own record, from one minted by a `permissions.deny` rule.
 *
 * ## The row's premise was WRONG about where the type lives, and the artefacts
 * ## are what settled it
 *
 * The row says *"`result.permission_denials` carries `decision_reason_type:
 * 'classifier'`"*. Measured against BOTH vendored artefacts, it does not, and
 * an implementation built on that sentence would have read `undefined`:
 *
 * - `@anthropic-ai/claude-agent-sdk` `sdk.d.ts` declares
 *   `SDKPermissionDenial = { tool_name; tool_use_id; tool_input }` — three
 *   fields, no discriminator, no reason.
 * - `@anthropic-ai/claude-agent-sdk-darwin-arm64` `claude` agrees at the schema
 *   level: the element validator is
 *   `E.object({tool_name:E.string(),tool_use_id:E.string(),tool_input:E.record(E.string(),E.unknown())})`.
 *
 * **RE-MEASURED at the S0-3 lift, 2026-09-03: unchanged at SDK `0.3.233` /
 * `claudeCodeVersion 2.1.233`, and RE-MEASURED AGAIN at the P7.1 lift --
 * `0.3.247` / `claudeCodeVersion 2.1.247`, 2026-09-12, C3.252. Two things were
 * re-read and both hold: `sdk.d.ts` still declares
 * `PermissionDeniedHookInput` with exactly `tool_name: string`,
 * `tool_input: unknown` and `tool_use_id: string`; and the binary's runner still
 * builds the payload as `{…, hook_event_name:"PermissionDenied", tool_name,
 * tool_input, tool_use_id, reason}` -- 1 line / 1 occurrence on that anchor, so
 * it is the only site.** Both artefacts were first read at `0.3.223` /
 * `2.1.223`, and every claim below was re-run against the vendored 0.3.233 pair
 * rather than carried forward — the bump is the moment a receipt built on a
 * binary's internals is most likely to have gone quietly wrong. `sdk.d.ts` still
 * declares the same three fields; the binary's validator now minifies as
 * `Se(()=>be({tool_name:F(),tool_use_id:F(),tool_input:oo(F(),no())}))` (same
 * shape, reassigned identifiers — which is why nothing here is cited by
 * minified name), and its PRODUCER pushes the same three fields:
 * `{tool_name:…(e.name),tool_use_id:…,tool_input:…}`, deduplicated by
 * `tool_use_id`.
 *
 * The discriminator exists on exactly two other surfaces, and **neither one is
 * complete on its own**:
 *
 * | Channel | `decision_reason_type` | `tool_input` | Scope |
 * | --- | --- | --- | --- |
 * | `system/permission_denied` message | **yes** | no | denials resolved at `canUseTool` |
 * | `PermissionDenied` hook | no | **yes** | auto-mode classifier denials only |
 * | `result.permission_denials[]` | no | **yes** | the authoritative end-of-turn list |
 *
 * ## Why the hook path can still stamp `'classifier'` — read, not assumed
 *
 * The hook input carries no type, so writing one would ordinarily be inventing
 * a value. It is not invented here: the shipped binary gates the hook on the
 * discriminator itself. The dispatch site reads
 *
 *   `if(Q.decisionReason?.type==="classifier"&&Q.decisionReason.classifier==="auto-mode"){ … }`
 *
 * whose body iterates the `PermissionDenied` hook runner
 * (`{…, hook_event_name:"PermissionDenied", tool_name, tool_input, tool_use_id, reason}`),
 * passing `Q.decisionReason.reason ?? "Permission denied"` — which is where
 * {@link buildClaudeAutoModeDenialReceipt}'s tolerance of an empty reason comes
 * from. Byte-for-byte the same gate at `2.1.233` as at `2.1.223`; only the
 * minified identifiers moved (`j`→`Q`, and the runner's own name), which is why
 * this quote keeps the field names and drops the symbols.
 * So the hook FIRING is itself the evidence of the type — the binary's gate is
 * strictly tighter than the page's prose, which only says
 * (`hooks.md#permissiondenied`, verbatim): *"This hook only fires in auto mode:
 * it doesn't run when you manually deny a permission dialog, when a
 * `PreToolUse` hook blocks a call, or when a `deny` rule matches."* That is why
 * {@link ClaudePermissionDenialReceiptV1.decisionReasonTypeSource} exists: a
 * receipt states HOW it knows its own type, so `hook-gate` can never be
 * mistaken for a value read off a payload.
 *
 * ## What this receipt provably does NOT cover
 *
 * Stated here rather than in a plan note, because the operator of a bank
 * deployment has to be told which half of an audit they are getting:
 *
 * 1. **Refusals only.** In auto mode the classifier IS the permission prompt,
 *    and an approved call raises nothing — `canUseTool` is skipped for
 *    auto-approved tools. There is no approval channel to mint from, so this is
 *    the half that matters for REVIEW and not the half that matters for
 *    ATTRIBUTION.
 * 2. **Nothing at all in the configuration we ship today.** P3.93 measured
 *    (`claude-auto-mode-classifier-e2e.test.ts`, arm A2) that our PreToolUse
 *    gate's `permissionDecision: 'allow'` silences the classifier entirely:
 *    zero classifier requests, zero denials, zero hook fires. Every branch of
 *    our gate returns a decision, so the classifier is never consulted and this
 *    receipt is DORMANT BY CONSTRUCTION. It becomes live only if P3.121's
 *    mode-conditional fall-through ships. Building it first is deliberate: the
 *    fall-through must not ship without the instrument that would show what it
 *    started denying.
 *
 *    Re-verified 2026-09-03 (W3-b): still dormant. `buildClaudePreToolUseContinue`
 *    returns `permissionDecision` `'defer'`, `'ask'` or `'allow'` on every path
 *    and never omits the field, which is P3.93's arm A4 — the one shape that
 *    lets the classifier run. Checking THIS rather than re-reading the sentence
 *    is the point: the day the fall-through lands, this paragraph is the first
 *    thing that becomes false.
 * 3. **Not our own gate's denials.** A `PreToolUse` hook deny resolves before
 *    `canUseTool` and fires neither this hook nor the stream event; that record
 *    is `__PERMISSION_BLOCK__`, which already exists.
 *
 *    Re-measured in the shipped binary 2026-09-03 (W4-g), because point 3 is
 *    the load-bearing one for the decision below and it had only ever been
 *    asserted. The dispatcher short-circuits on a hook deny before the
 *    permission callback is reached at all:
 *
 *      `async function <dispatch>(e,t,r,n,o,i,s){ … `
 *      `  if(e?.behavior==="deny")return w(\`Hook denied tool use for ${t.name}\`),`
 *      `    {decision:e,input:r}; … return{decision:await o(t,c,n,i,s,e),input:c}}`
 *
 *    `o` is the permission callback that owns BOTH emitters, so a `PreToolUse`
 *    deny — every one of ours, `mode-manager.ts` `denyToolWithReason` —
 *    returns before either can fire. The two records cannot double up.
 *
 * ## THE DECISION (P3.97, held twice, taken 2026-09-03)
 *
 * **Mint from the SDK's own denial event as well as from the hook.** The row
 * was held because the hook half is dormant by construction, and holding it a
 * third time would have been recording an audit gap rather than closing one.
 * The stream event is the channel that is NOT dormant, it carries a reason and
 * a verbatim type, and this module already read it — for a transcript LABEL
 * and nothing else. So {@link buildClaudeStreamDenialReceipt} mints the same
 * `ClaudePermissionDenialReceiptV1` from it, and the audit record now exists in
 * the configuration we actually ship.
 *
 * What the stream channel covers that the hook does not: **every SDK-side
 * denial** — `rule`, `mode`, `classifier`, `safetyCheck` — not the classifier
 * alone. Those are exactly the refusals our own `__PERMISSION_BLOCK__` record
 * cannot see, because they are decided inside the binary before our gate is
 * consulted.
 *
 * What it costs: **no `tool_input`.** The message does not carry one (pinned in
 * the suite), so a stream receipt says what was refused only by tool NAME. That
 * is a weaker record than the hook's, and it is written into the receipt rather
 * than left for a reader to infer — `decisionReasonTypeSource: 'payload'` on a
 * receipt with no `toolInput` IS the stream channel's signature.
 *
 * **Both channels fire for one classifier denial, and that is deliberate, not a
 * defect to dedup.** Measured in the binary: the stream emitter runs inside the
 * permission callback, and the `PermissionDenied` hook runner is dispatched
 * later from the SAME resolved decision, so once P3.121's fall-through ships a
 * classifier denial produces two receipts sharing one `toolUseId`. They are
 * complementary by the vendor's own shape — the table above is the whole
 * reason `decisionReasonTypeSource` exists — and a de-duplicator would have to
 * DISCARD either the verbatim type or the input. So neither is discarded:
 * **a consumer counts denials by distinct `toolUseId`**, and each receipt says
 * which channel it came from. Rule, mode and safety-check denials reach the
 * stream channel only and are never doubled.
 */

/**
 * Marker prefix on the debug line that carries a receipt.
 *
 * Mirrors `__PERMISSION_BLOCK__` (`claude-agent.ts`, `pi-agent.ts`) rather than
 * inventing a transport: `SessionManager` installs `agent.onDebug` and writes
 * every line it does not specially parse through `sessionLog.info`, so a marker
 * line reaches the session log with no server-core change and no new port.
 */
export const CLAUDE_PERMISSION_DENIAL_RECEIPT_MARKER = '__CLAUDE_PERMISSION_DENIAL__'

/**
 * How the receipt knows its own `decisionReasonType`.
 *
 * - `hook-gate` — the value is implied by the channel: the shipped binary runs
 *   the `PermissionDenied` hook ONLY for `type === 'classifier'` /
 *   `classifier === 'auto-mode'` denials, so firing is the evidence.
 * - `payload` — the value was read verbatim from `decision_reason_type` on a
 *   `system/permission_denied` message.
 */
export type ClaudePermissionDenialTypeSource = 'hook-gate' | 'payload'

/** The audit record one refused Claude-runtime tool call produces. */
export interface ClaudePermissionDenialReceiptV1 {
  readonly version: 1
  readonly provider: 'claude'
  /** Nessy's session id, so the receipt joins the session log's other rows. */
  readonly sessionId: string
  readonly toolName: string
  /** The SDK's `tool_use_id`; the join key back to the turn's tool call. */
  readonly toolUseId: string
  /** `'classifier'` for every hook-minted receipt — see this file's header. */
  readonly decisionReasonType: string
  readonly decisionReasonTypeSource: ClaudePermissionDenialTypeSource
  /**
   * The denying component's own words. `hooks.md#permissiondenied` enumerates
   * what this can be: the fixed `Blocked by classifier`, the classifier's
   * written explanation, a string opening `Auto mode could not evaluate this
   * action and is blocking it for safety`, or the fixed `Classifier
   * unavailable`.
   */
  readonly reason: string
  /** Nessy's permission mode at the moment of the denial. */
  readonly permissionMode: string
  /**
   * What was refused. A refusal receipt that does not say what was refused is
   * not an audit record; `PiPermissionReceiptV1.canonicalInput` is the
   * precedent this follows rather than inventing a redaction policy.
   */
  readonly toolInput?: Readonly<Record<string, unknown>>
  /** ISO-8601, minted by the caller's clock so tests can pin it. */
  readonly deniedAt: string
}

/**
 * The `decision_reason_type` value the binary stamps on an auto-mode classifier
 * denial, and the only one this module writes without reading it.
 */
export const CLAUDE_CLASSIFIER_DECISION_REASON_TYPE = 'classifier'

/**
 * Mint the receipt for one `PermissionDenied` hook fire.
 *
 * Returns `null` when the payload is missing a field the record cannot be
 * honest without: a receipt naming no tool, or joined to no tool call, is worse
 * than no receipt because it looks like evidence. `reason` is allowed to be
 * empty and normalised — the binary passes `"Permission denied"` when the
 * decision carried none, so an absent reason is a real state, not a defect.
 */
export function buildClaudeAutoModeDenialReceipt(input: {
  readonly sessionId: string
  readonly toolName: unknown
  readonly toolUseId: unknown
  readonly toolInput: unknown
  readonly reason: unknown
  readonly permissionMode: string
  readonly now?: Date
}): ClaudePermissionDenialReceiptV1 | null {
  const toolName = typeof input.toolName === 'string' ? input.toolName.trim() : ''
  const toolUseId = typeof input.toolUseId === 'string' ? input.toolUseId.trim() : ''
  if (!toolName || !toolUseId) return null
  const toolInput = input.toolInput && typeof input.toolInput === 'object' && !Array.isArray(input.toolInput)
    ? (input.toolInput as Record<string, unknown>)
    : undefined
  return Object.freeze({
    version: 1 as const,
    provider: 'claude' as const,
    sessionId: input.sessionId,
    toolName,
    toolUseId,
    decisionReasonType: CLAUDE_CLASSIFIER_DECISION_REASON_TYPE,
    decisionReasonTypeSource: 'hook-gate' as const,
    reason: typeof input.reason === 'string' ? input.reason : '',
    permissionMode: input.permissionMode,
    ...(toolInput ? { toolInput } : {}),
    deniedAt: (input.now ?? new Date()).toISOString(),
  })
}

/**
 * The type a stream denial is recorded under when the message carries none.
 *
 * NOT invented: `decision_reason_type` is optional in `sdk.d.ts`, and the
 * binary's own telemetry for the same decision writes
 * `decisionReasonType: …(Q.decisionReason?.type ?? "unknown")` — so `'unknown'`
 * is the producer's word for this state, read rather than chosen. A receipt
 * whose type is absent must still say something, because an EMPTY type would
 * read as "not recorded" beside a `decisionReasonTypeSource` of `'payload'`
 * that says it was.
 */
export const CLAUDE_UNKNOWN_DECISION_REASON_TYPE = 'unknown'

/**
 * Bound a producer-authored discriminator to something safe to put in a line.
 *
 * One function for both consumers — {@link formatClaudeDenialTypeLabel} and
 * {@link buildClaudeStreamDenialReceipt} — so the transcript a user reads and
 * the receipt an auditor reads can never disagree about what the type WAS.
 * `:` is dropped along with everything else outside the set: the rendered line
 * already uses `: ` as its reason separator, so a type carrying one would read
 * as two fields.
 */
function sanitizeClaudeDenialType(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[^\w.-]+/g, ' ').trim().slice(0, 40)
}

/**
 * Mint the receipt for one `system/permission_denied` stream message.
 *
 * **This is the channel that is not dormant** — see this file's header for the
 * decision and for what it costs. The type is READ here rather than implied by
 * the channel, so the source is `'payload'`; there is no `tool_input` on this
 * message, so the receipt carries none and its absence beside `'payload'` is
 * the channel's signature.
 *
 * `reason` prefers `decision_reason` (the deciding component's own words) and
 * falls back to `message` (the rejection text the model was given). The binary's
 * reason formatter returns nothing for `rule`, `mode`, `subcommandResults` and
 * `permissionPromptTool`, so for those denials `message` is the only text there
 * is — dropping the fallback would leave the most common denials reasonless.
 *
 * Returns `null` on the same terms as its sibling: a record naming no tool, or
 * joined to no tool call, is worse than no record because it looks like
 * evidence.
 */
export function buildClaudeStreamDenialReceipt(input: {
  readonly sessionId: string
  readonly toolName: unknown
  readonly toolUseId: unknown
  readonly decisionReasonType: unknown
  readonly decisionReason: unknown
  readonly message: unknown
  readonly permissionMode: string
  readonly now?: Date
}): ClaudePermissionDenialReceiptV1 | null {
  const toolName = typeof input.toolName === 'string' ? input.toolName.trim() : ''
  const toolUseId = typeof input.toolUseId === 'string' ? input.toolUseId.trim() : ''
  if (!toolName || !toolUseId) return null
  const decisionReason = typeof input.decisionReason === 'string' ? input.decisionReason : ''
  const message = typeof input.message === 'string' ? input.message : ''
  return Object.freeze({
    version: 1 as const,
    provider: 'claude' as const,
    sessionId: input.sessionId,
    toolName,
    toolUseId,
    decisionReasonType: sanitizeClaudeDenialType(input.decisionReasonType) || CLAUDE_UNKNOWN_DECISION_REASON_TYPE,
    decisionReasonTypeSource: 'payload' as const,
    reason: decisionReason || message,
    permissionMode: input.permissionMode,
    deniedAt: (input.now ?? new Date()).toISOString(),
  })
}

/** Serialize a receipt onto one debug line. */
export function formatClaudePermissionDenialReceipt(receipt: ClaudePermissionDenialReceiptV1): string {
  return `${CLAUDE_PERMISSION_DENIAL_RECEIPT_MARKER}${JSON.stringify(receipt)}`
}

/**
 * Read a receipt back off a debug line, or `null` when the line carries none.
 * The reader is deliberately lenient about unknown keys and strict about the
 * two that make the record identifiable.
 */
export function parseClaudePermissionDenialReceipt(line: string): ClaudePermissionDenialReceiptV1 | null {
  const at = line.indexOf(CLAUDE_PERMISSION_DENIAL_RECEIPT_MARKER)
  if (at < 0) return null
  try {
    const parsed = JSON.parse(line.slice(at + CLAUDE_PERMISSION_DENIAL_RECEIPT_MARKER.length)) as
      Partial<ClaudePermissionDenialReceiptV1>
    if (parsed?.version !== 1 || parsed.provider !== 'claude') return null
    if (typeof parsed.toolName !== 'string' || typeof parsed.toolUseId !== 'string') return null
    return parsed as ClaudePermissionDenialReceiptV1
  } catch {
    return null
  }
}

/**
 * The transcript label for a `system/permission_denied` message.
 *
 * This is the OTHER half of P3.97 and the half that is not dormant: the stream
 * event carries `decision_reason_type` and our adapter dropped it, so a
 * `dontAsk`/mode denial and a classifier denial read identically in the user's
 * transcript. Renders as `Permission denied for Bash (classifier): …`.
 *
 * The type is producer-authored text (`sdk.d.ts`: *"Discriminator from
 * PermissionDecisionReason"*, typed `string`, not the closed union its sibling
 * `PermissionRequest` field uses), so it is bounded and stripped of anything
 * that could rewrite the line it lands in.
 *
 * Both halves re-read at `0.3.233` (2026-09-03) and both still hold: this field
 * is `decision_reason_type?: string`, while the sibling on the ask path is the
 * closed eleven-member union
 * `'rule'|'mode'|'subcommandResults'|'permissionPromptTool'|'hook'|'asyncAgent'|'sandboxOverride'|'workingDir'|'safetyCheck'|'classifier'|'other'`.
 * Narrowing this reader to that union would be borrowing a neighbour's contract:
 * the loose type is the vendor's own statement that the value here is open.
 */
export function formatClaudeDenialTypeLabel(decisionReasonType: unknown): string {
  const cleaned = sanitizeClaudeDenialType(decisionReasonType)
  return cleaned ? ` (${cleaned})` : ''
}
