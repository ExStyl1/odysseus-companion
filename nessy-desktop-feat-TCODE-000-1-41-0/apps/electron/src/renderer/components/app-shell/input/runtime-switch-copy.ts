import type { HistoryCarryPlan, HistoryCarryReason, RuntimeSwitchKind } from '@nessy-agent/shared/protocol'
import type { ModelProvider } from '@config/models'
import type { LlmProviderType } from '@config/llm-connections'

/**
 * Prefix of the transcript row the server appends at a runtime change
 * (`SessionManager.appendRuntimeSwitchNotice`). The stored content is
 * `runtime_switched:<from>:<to>`, optionally followed by a JSON tail —
 * machine-readable on purpose, because a row persisted in one UI language must
 * not be frozen in it. The human copy is composed at render time from
 * `chat.runtimeSwitch.notice*`.
 */
export const RUNTIME_SWITCH_MARKER = 'runtime_switched:'

/**
 * The JSON tail R1 added: `runtime_switched:pi:anthropic:{"carry":"native"}`.
 *
 * Only `carry` is defined today. It is read leniently on purpose — a tail this
 * renderer does not understand must degrade to the copy that predates it, never
 * to a broken row, because the transcript is durable and a marker written by a
 * NEWER server can reach an older client (remote sessions, the iOS app, a
 * transcript export re-opened later).
 *
 * A `type` and not an `interface`, and that is load-bearing: this value is
 * handed straight to `t(key, marker)` as the interpolation bag, and i18next's
 * `TOptions` needs an index signature. TypeScript infers an implicit one for a
 * type alias and refuses to for an interface, so the interface form fails to
 * typecheck at the one call site that exists.
 */
export type RuntimeSwitchMarker = {
  from: string
  to: string
  /**
   * What actually crossed, per the switch's own plan. `undefined` for a marker
   * written before R1 — which is the whole reason the field is optional rather
   * than defaulted: guessing `native` for an old row would state something the
   * switch never decided.
   */
  carry?: HistoryCarryPlan
}

const CARRY_VALUES: readonly HistoryCarryPlan[] = ['native', 'anchor', 'text']

/**
 * Read a switch marker out of an `info` row's content, or `null` when the row
 * is an ordinary notice. Returns the two runtime LABELS, ready to interpolate,
 * plus what crossed when the row says so.
 *
 * **Split by position, not by `split(':')`.** The tail is JSON and JSON
 * contains `:`, so the two segments are taken by index and everything after the
 * second separator is handed to `JSON.parse` whole. The pre-R1 form has no
 * third segment and is unaffected — `parseRuntimeSwitchMarker('…:pi:anthropic')`
 * answers exactly what it answered before, which the round-trip test pins.
 */
export function parseRuntimeSwitchMarker(content: string): RuntimeSwitchMarker | null {
  if (!content.startsWith(RUNTIME_SWITCH_MARKER)) return null
  const rest = content.slice(RUNTIME_SWITCH_MARKER.length)
  const firstSeparator = rest.indexOf(':')
  if (firstSeparator <= 0) return null
  const from = rest.slice(0, firstSeparator)
  const afterFrom = rest.slice(firstSeparator + 1)
  const secondSeparator = afterFrom.indexOf(':')
  const to = secondSeparator === -1 ? afterFrom : afterFrom.slice(0, secondSeparator)
  if (!to) return null
  const carry = parseMarkerCarry(secondSeparator === -1 ? '' : afterFrom.slice(secondSeparator + 1))
  return {
    from: runtimeLabel(from as ModelProvider),
    to: runtimeLabel(to as ModelProvider),
    ...(carry ? { carry } : {}),
  }
}

function parseMarkerCarry(tail: string): HistoryCarryPlan | undefined {
  if (!tail) return undefined
  try {
    const parsed: unknown = JSON.parse(tail)
    if (!parsed || typeof parsed !== 'object') return undefined
    const carry = (parsed as { carry?: unknown }).carry
    return CARRY_VALUES.find(value => value === carry)
  } catch {
    // A malformed tail is a row we do not understand, not a row to break on.
    return undefined
  }
}

/**
 * The notice copy for what crossed.
 *
 * One key per outcome family, because the three are different events and the
 * single pre-R1 line ("the conversation so far was handed over") was only ever
 * true of the first: a `text` carry hands over a summary with no tool traffic,
 * and an `anchor` resume hands over nothing new at all — the target picks up its
 * own thread. **The no-carry arm keeps the original key**, so a marker written
 * before R1 renders today's copy unchanged.
 */
export function runtimeSwitchNoticeKey(carry?: HistoryCarryPlan): string {
  switch (carry) {
    case 'native': return 'chat.runtimeSwitch.noticeNative'
    case 'anchor': return 'chat.runtimeSwitch.noticeAnchor'
    case 'text': return 'chat.runtimeSwitch.noticeText'
    default: return 'chat.runtimeSwitch.notice'
  }
}

export interface RuntimeSwitchCopy {
  titleKey: string
  bodyKey: string
  confirmKey: string
  /**
   * The one line the modal was missing: WHAT WILL CROSS.
   *
   * `null` when the tier makes no such promise — a same-runtime switch (the
   * runtime keeps its own thread, which `sameRuntimeBody` already says), and a
   * cross-runtime switch whose plan the renderer could not obtain. A missing
   * line is honest; a guessed one is not, so nothing is invented here when the
   * preview did not answer.
   */
  carryKey: string | null
  /**
   * P3.266 — WHY it will cross that way, when the way is a degradation.
   *
   * The carry line above says the conversation arrives as a text summary. It
   * does not say whether that is a permanent property of these two runtimes,
   * something we failed to measure, or the user's own transcript outgrowing the
   * target model — three facts with three different answers, of which only the
   * last is actionable. `planHistoryCarry` has always decided between them and
   * its `reason` field said so in its own comment: *"Not rendered — logged"*.
   *
   * `null` for the two non-degrading reasons and for a preview that did not
   * answer, on the same rule the carry line follows: the modal says less rather
   * than guessing. `fits` needs no explanation and `target-already-anchored` is
   * already the whole of `carryAnchor`, so adding a second sentence there would
   * restate the line above it.
   */
  reasonKey: string | null
}

/**
 * The three promises, one per plan. Each says something the other two do not,
 * which is the entire reason `planHistoryCarry` returns three values and not a
 * boolean:
 *
 * - `native` — everything crosses, tool calls and results included. It also
 *   states the one loss D6 records: an image attachment crosses as a PATH and
 *   not as an image, so the target has to open it from disk again.
 * - `anchor` — the target resumes its OWN conversation and only the gap crosses
 *   as text. Must NOT read as "full history": for a returning leg there is no
 *   new carry (D7).
 * - `text` — a text summary of the most recent messages, tool rows excluded.
 *
 * **P3.55 · `carryNative` used to end *"Image attachments cross as file paths,
 * which the model cannot open"*, and a second key existed because of it.** That
 * clause is refuted verbatim for Claude by `tools-reference.md#read-tool-behavior`
 * — *"**Images**: PNG, JPG, and other image formats are returned as visual
 * content that Claude can see, not as raw bytes."* — and for Pi by the pinned
 * SDK's own `read` tool (`pi-coding-agent/dist/core/tools/read.js:136`). T7 had
 * added `chat.runtimeSwitch.carryNativePi` to drop it *"for Claude, where it is
 * true"*; it is not true there either, so the two keys collapsed back into one
 * on 2026-08-28. The surviving text is T7's — the one already measured true —
 * and `carryNativePi` is deleted from both locales.
 *
 * The two strings differed in a SECOND place nobody had recorded: T7's opener
 * says the conversation crosses *"as its own history"* and the shared one did
 * not, so "identical but for the image clause" was wrong in both the comment
 * that claimed it and the test that restated it. The merged line keeps the
 * longer opener, which is true of both targets that reach this key —
 * `NATIVE_HISTORY_CARRY_IMPLEMENTED` (`runtime-switch.ts`) is `true` for `pi`
 * and `anthropic`, Codex takes {@link CODEX_CARRY_NATIVE_KEY}, and
 * `nestor-cloud-agent` is refused as a switch target before it is consulted.
 */
const CARRY_KEY_BY_PLAN: Record<HistoryCarryPlan, string> = {
  native: 'chat.runtimeSwitch.carryNative',
  anchor: 'chat.runtimeSwitch.carryAnchor',
  text: 'chat.runtimeSwitch.carryText',
}

/**
 * P3.266 — one line per DEGRADING reason, and `null` for the two that degrade
 * nothing.
 *
 * A total record over {@link HistoryCarryReason} rather than a lookup with a
 * default, for the reason this file's sibling table gives: a reason added to the
 * planner's union breaks the build here instead of silently falling through to
 * "no explanation", which is the state P3.266 exists to end. The two `null`s are
 * therefore decisions and not omissions.
 *
 * What each line has to say, and why they are not one string:
 *
 * - `no-native-carry-implemented` — a property of the PAIR of runtimes. Nothing
 *   about this conversation caused it and nothing the user does changes it
 *   today, so the copy must not imply a remedy.
 * - `context-window-unknown` — we could not size the target model at all. The
 *   summary is the SAFE answer rather than the right one, and saying so is the
 *   difference between a limitation and a bug in the user's mind.
 * - `context-window-unenforced` — the window is known and nothing on the target
 *   will hold the conversation to it, so we decline to promise a fit we cannot
 *   police. Distinct from the line above it: there, we knew nothing; here, we
 *   know and cannot enforce.
 * - `does-not-fit` — the one the user can act on. It names the cause (their
 *   conversation is larger than the target model's window) so the two real
 *   options — a roomier model, or accepting the summary — are visible.
 *
 * The strings deliberately do NOT quote token counts. `planHistoryCarry`'s
 * estimate is a heuristic with a declared 1.25 margin over a chars-per-token
 * approximation (`HISTORY_CARRY_TOKEN_MARGIN`, and the corpus that forced it),
 * and a number shown to a user reads as measured. The modal states the FACT and
 * leaves the arithmetic where it is checkable.
 */
const REASON_KEY_BY_REASON: Record<HistoryCarryReason, string | null> = {
  fits: null,
  'target-already-anchored': null,
  'no-native-carry-implemented': 'chat.runtimeSwitch.reasonNoNativeCarry',
  'context-window-unknown': 'chat.runtimeSwitch.reasonWindowUnknown',
  'context-window-unenforced': 'chat.runtimeSwitch.reasonWindowUnenforced',
  'does-not-fit': 'chat.runtimeSwitch.reasonDoesNotFit',
}

/**
 * Every reason key the dialog can emit — the set the locale files must cover.
 *
 * Derived from the record rather than listed again, the same way
 * `RUNTIME_SWITCH_COST_BODY_KEYS` is derived from its rows: a second copy of
 * four key names is how a shipped string goes missing in one locale.
 */
export const RUNTIME_SWITCH_REASON_KEYS: readonly string[] = Object.freeze(
  Object.values(REASON_KEY_BY_REASON).filter((key): key is string => key !== null),
)

/**
 * Codex's own two lines. **Both changed meaning at T1b, and the change is a
 * routing change, not only a wording one.**
 *
 * T1a's body carried the clause *"{{toRuntime}} receives what was said, not
 * what was done"*, and chose it on the TARGET RUNTIME alone — correct then,
 * because no tool traffic crossed into Codex on any tier. T1b makes tool calls
 * and their results cross on a `native` plan, so that clause is now false on
 * exactly one tier and true on the other two. A key chosen on the runtime alone
 * can no longer be right, so the tier decides:
 *
 * - **`native` into Codex** takes the SHARED body. Read it: it promises the
 *   transcript is kept and the working memory is not, and it says nothing about
 *   what was done — every word of it is true of a native Codex carry, so there
 *   is nothing to add and nothing to correct.
 * - **`text` / `anchor` into Codex** keeps `crossRuntimeBodyCodex`, whose words
 *   are unchanged because they are still exactly true there: those tiers carry
 *   prose and no tool traffic.
 *
 * The CARRY line stays a Codex-specific key rather than folding into the shared
 * `carryNative` — **but not for the reason written here until P2.507, and that
 * reason had reached the user.** It said the two carries differ because *"T2's
 * rebuild crosses image attachments as file paths (D6), and Codex's inject
 * crosses no attachment at all"*, and `carryNativeCodex` accordingly ended by
 * listing image attachments among what STAYS BEHIND. **P3.102 refuted it:
 * `attachmentBlock` is passed on every plan and every target**, so the pointer
 * reaches Codex exactly as it reaches Pi and Claude — `runtime-handoff.ts` says
 * so in its own words, *"P3.102 passes the hook on every plan and every target,
 * so Codex has received this block since that landed"* — and Codex opens it
 * with `view_image`, read from the source at our binary's own tag and measured
 * against the shipped binary rather than off a page (P3.116,
 * `codex-responses-adapter/src/config-writer.ts`, which now declares
 * `view_image = true` so a default flip cannot remove the mechanism silently).
 * The user was being told they would lose something they keep; the image clause
 * is now the same promise `carryNative` makes.
 *
 * What still earns the key is the half nothing refuted, and it is two clauses,
 * neither of which the shared line carries: Codex takes the transcript as
 * MODEL-VISIBLE history with nothing trimmed, and its own reasoning items are
 * deliberately not carried (`shared/src/agent/codex-handoff-items.ts`,
 * *"Reasoning items are deliberately not carried"*). So the two carries are
 * still not the same thing — just not in the way this comment claimed.
 *
 * A caller that names no plan (`ConnectionRow`, asking only whether a tier has
 * copy at all) lands on the Codex body — the arm that claims LESS.
 */
const CODEX_BODY_KEY = 'chat.runtimeSwitch.crossRuntimeBodyCodex'
const CODEX_CARRY_NATIVE_KEY = 'chat.runtimeSwitch.carryNativeCodex'

/**
 * Which runtime a connection's `providerType` answers through.
 *
 * A local restatement of `providerTypeToAgentProvider`
 * (`packages/shared/src/agent/backend/factory.ts`), NOT an import: that module
 * is the backend factory and pulling it into the renderer would drag every
 * backend with it. The two must be kept in step by hand — the same trade-off
 * `MessageRuntimeProvider` records in `core/types/message.ts` — and
 * `__tests__/runtime-capability-drift.test.ts` is the hand, mechanised.
 *
 * ## P2.216 — why this is a RECORD and no longer a `switch` with a `default`
 *
 * The `default:` arm returned `'pi'`, and it swallowed TWO different things
 * that need different answers:
 *
 *  - a member of `LlmProviderType` nobody mapped here. A NEW RUNTIME was
 *    therefore described to the user as Pi, silently, on every line of the
 *    switch dialog — the twenty-second independent restatement of the runtime
 *    vocabulary in this tree, and the one that failed open. A
 *    `Record<LlmProviderType, ModelProvider>` cannot: adding a member BREAKS
 *    THE BUILD here, which is `runtime-vocabulary.ts`'s stated property.
 *  - a string that is in no union at all. `getLlmConnections()` returns stored
 *    config with no per-field validation (P2.205), so one really can arrive.
 *    That case keeps a fallback, because this is display copy on a modal the
 *    user is already looking at and there is nothing better to render — but it
 *    is now a NAMED constant with its reason beside it, so the next reader can
 *    see it is a decision rather than the tail of a switch.
 */
const RUNTIME_BY_PROVIDER_TYPE: Record<LlmProviderType, ModelProvider> = {
  anthropic: 'anthropic',
  'claude-runtime': 'anthropic',
  'codex-runtime': 'codex-runtime',
  'nestor-cloud-agent': 'nestor-cloud-agent',
  pi: 'pi',
  pi_compat: 'pi',
}

/**
 * What an unclassifiable `providerType` STRING renders as.
 *
 * Deliberate and narrow: it covers only a value outside `LlmProviderType`
 * entirely, never a runtime this build knows and forgot to map — the record
 * above makes that second case a compile error. `'pi'` because the composer's
 * own default connection is a Pi one, so it is the least surprising label on a
 * record we cannot classify; the honest alternative would be a fifth label the
 * locale files do not have.
 */
const UNCLASSIFIED_PROVIDER_TYPE_RUNTIME: ModelProvider = 'pi'

export function runtimeForProviderType(providerType: LlmProviderType): ModelProvider {
  return RUNTIME_BY_PROVIDER_TYPE[providerType] ?? UNCLASSIFIED_PROVIDER_TYPE_RUNTIME
}

/**
 * Short display mark for a runtime. Brand names stay in English (i18n rule 3).
 *
 * A `Record<ModelProvider, string>` for P2.216's reason: the `default: 'Pi'` it
 * replaces meant a new runtime would have been LABELLED Pi in the badge and in
 * every interpolated copy string, with nothing failing.
 */
const RUNTIME_LABELS: Record<ModelProvider, string> = {
  anthropic: 'Claude',
  'codex-runtime': 'Codex',
  'nestor-cloud-agent': 'Nestor',
  pi: 'Pi',
}

export function runtimeLabel(runtime: ModelProvider): string {
  return RUNTIME_LABELS[runtime] ?? RUNTIME_LABELS.pi
}

/**
 * The tier a connection change falls into, computed in the renderer so the
 * question can be asked BEFORE the switch runs.
 *
 * Mirrors `classifyRuntimeSwitch` (`packages/shared/src/protocol/runtime-switch.ts`),
 * which is the authority and runs server-side on the same two inputs.
 */
export function classifyConnectionSwitch(
  from: { slug?: string; runtime: ModelProvider },
  to: { slug: string; runtime: ModelProvider },
): RuntimeSwitchKind {
  if (from.slug === to.slug) return 'model'
  return from.runtime === to.runtime ? 'connection-same-runtime' : 'connection-cross-runtime'
}

/**
 * Which switches are worth interrupting the user for.
 *
 * Claude Code's picker "asks for confirmation when the conversation has prior
 * output, since the next response re-reads the full history without cached
 * context" — the confirmation is scoped to the transition that actually costs
 * something, not attached to every model pick. Same rule here, one tier
 * sharper because our cross-runtime tier loses more than a cache.
 *
 * `null` means no dialog: just do it.
 *
 * `historyCarry` is the SERVER's pre-switch decision, fetched by
 * `previewRuntimeSwitch` before the dialog opens. Optional because a preview
 * that failed must not block the switch: the dialog then renders without the
 * carry line rather than with a guess.
 *
 * `toRuntime` is the runtime taking over (T1a). Optional for the same reason
 * `historyCarry` is: the one caller that only asks "is there copy for this
 * tier at all?" (`ConnectionRow`, deciding whether to open a dialog) has no
 * need to name it, and omitting it yields the shared, runtime-neutral copy.
 */
export function runtimeSwitchCopyKey(
  kind: RuntimeSwitchKind,
  hasHistory: boolean,
  historyCarry?: HistoryCarryPlan | null,
  toRuntime?: ModelProvider | null,
  historyCarryReason?: HistoryCarryReason | null,
): RuntimeSwitchCopy | null {
  if (!hasHistory) return null
  if (kind === 'model') return null
  if (kind === 'connection-same-runtime') {
    return {
      titleKey: 'chat.runtimeSwitch.sameRuntimeTitle',
      bodyKey: 'chat.runtimeSwitch.sameRuntimeBody',
      confirmKey: 'chat.runtimeSwitch.confirm',
      carryKey: null,
      reasonKey: null,
    }
  }
  const intoCodex = toRuntime === 'codex-runtime'
  const codexNative = intoCodex && historyCarry === 'native'
  // P3.55 · Codex is the ONLY runtime with a native carry line of its own now.
  // T7's `pi` arm was deleted with the key behind it: it existed to drop a
  // clause that is false on Claude as well, so there was nothing left for it to
  // say that `carryNative` does not.
  return {
    titleKey: 'chat.runtimeSwitch.crossRuntimeTitle',
    bodyKey: intoCodex && !codexNative ? CODEX_BODY_KEY : 'chat.runtimeSwitch.crossRuntimeBody',
    confirmKey: 'chat.runtimeSwitch.confirm',
    carryKey: !historyCarry
      ? null
      : codexNative
        ? CODEX_CARRY_NATIVE_KEY
        : CARRY_KEY_BY_PLAN[historyCarry],
    // P3.266 · gated on the CARRY LINE, not only on the reason. A reason with
    // no plan beside it would explain a promise the modal is not making — the
    // preview answers both fields or neither, and an older server answers
    // neither, so this keeps the pair from coming apart on a wire that is
    // deliberately lenient about missing fields.
    reasonKey: !historyCarry || !historyCarryReason
      ? null
      : REASON_KEY_BY_REASON[historyCarryReason],
  }
}
