/**
 * The rewind MENU — the surface `/rewind` opens (P2.425).
 *
 * `checkpointing.md#rewind-and-summarize`: "Run `/rewind`, or press `Esc` twice
 * when the prompt input is empty, to open the rewind menu." and "The rewind menu
 * lists each prompt you sent during the session. Select the point you want to
 * act on, then choose an action."
 *
 * Until this module existed, the rewind actions were reachable ONLY by
 * right-clicking a user message in the transcript — a thing you find rather than
 * a thing you open. Both actions still run through `ChatDisplay`'s one
 * `handleRewindConversation`; this is a second way IN, not a second
 * implementation.
 *
 * WHAT THIS MENU DOES NOT OFFER, and why — the record is
 * {@link REWIND_MENU_DOCUMENTED_ITEMS} below rather than this paragraph, so it
 * can be read by a test instead of by a person. P2.425 left these as "P6.56's
 * rows"; P6.56 measured them and they are now DECIDED, because two of them can
 * never be built here and a row that stays open on an impossibility is a queue
 * entry nobody can close.
 *
 * The action labels are the product's existing `messageMenu.rewindToHere*`
 * strings rather than the page's "Restore conversation" / "Restore code and
 * conversation". One vocabulary in one product beats matching the page in one of
 * its two surfaces; renaming the per-message menu is a wider change than an
 * opener.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw, Scissors, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { appendRestoredInput, coerceInputText } from '@/lib/input-text'
import { parseRewindCommand } from '@nessy-agent/shared/slash-commands/rewind'
import { isRendererMintedSessionId } from './input/stub-session'

/**
 * The fields this menu needs off a transcript message. Structural on purpose:
 * the test builds rows without dragging in the whole `Message` shape, and the
 * caller passes real ones.
 */
export interface RewindCandidateMessage {
  id: string
  /**
   * C3.384 — the id the SERVER knows this row by, when it differs from `id`.
   * See {@link rewindAnchorId}.
   */
  serverId?: string
  role: string
  content: string
  timestamp?: number
  isPending?: boolean
  isQueued?: boolean
  /**
   * UB12.53 — UB2.14's `Message.hidden`: a host-sent row that drives a turn but
   * never renders. See {@link collectRewindPrompts}.
   */
  hidden?: boolean
}

/**
 * C3.384 — the id a rewind must ADDRESS, which is not always the id the bubble
 * is rendered under.
 *
 * The composer mints an optimistic id, the send path mints its own on the
 * server, and the renderer's `user_message` reconciler deliberately keeps the
 * optimistic one so the bubble is not remounted mid-flight — recording the
 * canonical one as `serverId` instead. Every server call that ADDRESSES a
 * message therefore has to translate, and two of them are in this menu:
 * `rewindToMessage` looks the anchor up in `managed.messages`, and
 * `rewindTrackedChanges` answers with server ids that
 * {@link rewindOffersCodeRestore} compares the selection against.
 *
 * R7 measured both halves failing at once on the packaged 1.36.0 (C5.2 /
 * RS-05): `Rewind to here` answered *"Message not found"* — the string only
 * `rewindToMessage`'s `targetIndex < 0` produces — and `Rewind and restore
 * files` appeared for no anchor in any read. One cause, two symptoms.
 *
 * A row loaded from the server carries no `serverId` and the fallback is exact,
 * which is why a rewind in a REOPENED session always worked and one in the
 * session that sent the message never did.
 */
export function rewindAnchorId(message: Pick<RewindCandidateMessage, 'id' | 'serverId'>): string {
  return message.serverId ?? message.id
}

/** One selectable row: a prompt the user sent, and the anchor a rewind uses. */
export interface RewindMenuPrompt {
  /** The message id `rewindToMessage` takes. */
  id: string
  /** Single-line preview text. */
  preview: string
  timestamp?: number
}

/**
 * Why an item on `checkpointing.md#rewind-and-summarize` is or is not here.
 *
 * - `offered` — this menu renders it, or the action it reports back produces
 *   it. The second half is P6.104's: "restored into the input field" is a
 *   consequence of the ACTION, so it can never be a row in this panel, and a
 *   verdict vocabulary that could not say so would have kept it
 *   `documented-and-unbuilt` after it was built.
 * - `equivalent-surface` — the page lists it because the CLI's menu is a
 *   keyboard list with no other exit; ours is a panel, so the behaviour exists
 *   without a row of its own.
 * - `documented-and-impossible` — no runtime we drive can perform it, measured
 *   rather than assumed. These are NOT open work.
 * - `documented-and-unbuilt` — a runtime can, and we have not. Open work.
 * - `offered-by-approximation` — this menu renders it and the HOST produces it
 *   over a mechanism that is not the documented one, because no runtime has the
 *   documented one. Added by P6.280, and the vocabulary needed it: recording
 *   such an item as `offered` would erase the measurement that no runtime can do
 *   it, and leaving it `documented-and-impossible` would say the menu withholds
 *   an action it now offers. The residue belongs in the `note`, and the user is
 *   told in the panel — an approximation nobody can see is indistinguishable
 *   from a defect.
 */
export type RewindMenuItemVerdict =
  | 'offered'
  | 'offered-by-approximation'
  | 'equivalent-surface'
  | 'documented-and-impossible'
  | 'documented-and-unbuilt'

export interface RewindMenuDocumentedItem {
  /** The page's own name for it. */
  label: string
  verdict: RewindMenuItemVerdict
  /** What was measured. Present on every entry; it is the whole value of this record. */
  note: string
}

/**
 * The page's rewind surface, item by item, with this build's verdict (P6.56).
 *
 * The row that opened this said "four of the rewind menu's six documented
 * actions exist on no runtime". Both halves of that were wrong, in opposite
 * directions, which is why the record is a list and not a count: THREE of the
 * six actions are missing, and the page documents THREE further items nobody
 * had counted — a conditional-visibility rule, a prompt restore, and a seventh
 * menu entry after a `/clear`. All three of those are host-side and
 * runtime-neutral; none is blocked by a runtime.
 *
 * Re-verified against the vendored SDK at **0.3.251** (the row measured 0.3.223;
 * S0-3 lifted it to 0.3.233, P7.1 to 0.3.247 and C3.380 to this one): the
 * complete control-request enumeration is **34 members of
 * `SDKControlRequestInner`** — it was 36 at 0.3.233, so the set SHRANK and the
 * verdict did not move — and it still contains NO compaction or summarize entry
 * of any kind, with `SDKControlRewindFilesRequest` and
 * `SDKControlGetContextUsageRequest` present as the positive controls.
 *
 * **Spelled as members of the union and no longer as "named `SDKControl*Request`
 * types" (I2.13, WI-a's hand-off):** the NUMBER is right and unchanged, the
 * DESCRIPTION was not. One of the 34 is `SDKHookCallbackRequest`, which does not
 * carry that prefix at all, and the file declares 35 types that do, of which two
 * sit outside the union — `SDKControlRequest`, the envelope, and
 * `SDKControlCancelRequest`. So "34 named `SDKControl*Request` types" was three
 * different sets at once. Read the union line, which is the thing the claim is
 * about.
 * `Query.rewindFiles` exists and this tree has ZERO call sites for it — three
 * textual mentions, all in comments.
 */
export const REWIND_MENU_DOCUMENTED_ITEMS: readonly RewindMenuDocumentedItem[] = Object.freeze([
  {
    label: 'Restore code and conversation',
    verdict: 'offered',
    note: 'The file-restoring button; `onRewind(id, true)`.',
  },
  {
    label: 'Restore conversation',
    verdict: 'offered',
    note: 'The conversation-only button, and the one Enter confirms; `onRewind(id, false)`.',
  },
  {
    label: 'Restore code',
    verdict: 'documented-and-unbuilt',
    note:
      'The one gap we own, and it is claude-only. The SDK exposes `Query.rewindFiles(userMessageId)` '
      + 'with zero call sites here; codex refuses it in its own generated `ThreadRevertParams` ("This only '
      + 'changes persisted conversation history. It does not revert local file changes."). Blocked on P3.48, '
      + 'which clears the UUID handle `rewindFiles` needs; it also needs the wire DTO, the RPC handler '
      + 'and a split of the checkpoint walk from the transcript truncation, none of which is in this file.',
  },
  {
    label: 'Summarize from here',
    verdict: 'offered-by-approximation',
    note:
      'P6.280. The MEASUREMENT that made this `documented-and-impossible` still stands and is not '
      + 'softened: no anchored compaction exists on any runtime we drive — the SDK publishes no compact '
      + 'or summarize control request at all (34 members of `SDKControlRequestInner` at 0.3.251, none '
      + 'of them compaction), and codex\'s `thread/compact/start` takes a thread id with no anchor. What '
      + 'changed is that the row\'s own native-mechanism clause named the host mechanism that does '
      + 'exist: "the same instruction channel `/compact [instructions]` already uses". So the menu now '
      + 'composes an instruction NAMING the selected prompt and sends it through that channel. The '
      + 'compaction is still whole-conversation — it is guided toward the anchor, not cut at it — and '
      + 'the panel says so, because an approximation nobody can see is a defect.',
  },
  {
    label: 'Summarize up to here',
    verdict: 'documented-and-impossible',
    note:
      'Same measurement as the entry above, and NOT lifted with it. The instruction channel can say '
      + '"treat this prompt as where the detail starts"; it cannot make the runtime discard everything '
      + 'after the anchor, which is what this item means. Offering both would present one mechanism as '
      + 'two actions and let a user pick a direction the runtime does not have.',
  },
  {
    label: 'Never mind',
    verdict: 'equivalent-surface',
    note:
      'The Cancel button, plus Escape and an outside click. The page lists it because the CLI menu is a '
      + 'keyboard list with no other exit.',
  },
  {
    label: 'Code restore options appear only when the checkpoint has tracked changes',
    verdict: 'offered',
    note:
      'P6.103. Host-side and runtime-neutral, and gated PER ANCHOR: `SessionManager.'
      + 'listRewindTrackedChanges` answers "does THIS prompt have tracked file changes" with the rewind '
      + 'walk\'s own predicate — an un-reverted checkpoint created strictly after the anchor, over the '
      + 'session\'s directory and its forks\' — so the affordance is hidden exactly when the walk would '
      + 'find nothing. Hiding it per RUNTIME would be wrong for a separate measured reason, which is why '
      + 'nothing on this path reads the provider: a session that ran on Pi and later switched has real '
      + 'revertable checkpoints, and a rewind reverts them whatever runtime is current. An unanswerable '
      + 'read offers the action, so `fileCheckpointsUntracked` in the toast remains the fallback it '
      + 'always was rather than being replaced by a silent hide.',
  },
  {
    label: 'The selected prompt is restored into the input field afterwards',
    verdict: 'offered',
    note:
      'P6.104. `checkpointing.md#rewind-and-summarize`: "After restoring the conversation or choosing '
      + 'Summarize from here, the original prompt from the selected message is restored into the input '
      + 'field so you can re-send or edit it." Host-side and runtime-neutral, and it belongs to the '
      + 'ACTION rather than to this panel — so the menu owns the DECISION (`rewindComposerText`) and '
      + '`ChatDisplay` applies it to the composer it owns, on the success path of both restore buttons. '
      + 'The page names both, and both of ours restore the conversation. RESIDUE, stated rather than '
      + 'implied: our rewind RETAINS the selected prompt in the transcript (`slice(0, targetIndex + 1)`), '
      + 'where the page\'s removes it — so a re-send from the composer appends a second copy. That is a '
      + 'divergence in the rewind ACTION, older than this row and not created by it.',
  },
  {
    label: '`/resume <session-id> (previous session)` after a /clear',
    verdict: 'offered',
    note:
      'P6.106. The record this note said nothing kept is now kept: `/clear` reads the RUNTIME session '
      + 'anchor before the reset that drops it, and its own reply names the id and the command to type — '
      + 'the offer is made at the one moment there is something to resume, which is also the only moment '
      + 'the id is known, so there is no permanent menu row. The command is host-side and runtime-neutral '
      + 'like `/clear` itself; what differs per runtime is the anchor, and each of the three that has one '
      + 'restores it its own way — Pi its subprocess session id, claude the `resume` id, codex '
      + '`thread/resume`, which this build had never called. Only the id this session set aside is '
      + 'accepted: honouring an arbitrary one would open an empty conversation that LOOKS resumed.',
  },
])

/** How much of a prompt a row shows before it is cut. */
export const REWIND_PREVIEW_MAX_CHARS = 160

/**
 * Collapse a prompt to one line for the row.
 *
 * Newlines become spaces rather than being cut at the first one: a prompt whose
 * first line is "Fix this:" and whose body is the actual request would render as
 * an unidentifiable row, and the row is the only thing the user picks by.
 */
export function rewindPromptPreview(content: string, maxChars = REWIND_PREVIEW_MAX_CHARS): string {
  const flattened = content.replace(/\s+/g, ' ').trim()
  if (flattened.length <= maxChars) return flattened
  return `${flattened.slice(0, maxChars - 1).trimEnd()}…`
}

/**
 * D1.390 — whether a submitted composer message should OPEN the rewind menu,
 * which is two questions and not one.
 *
 * `/rewind` is answered entirely in the renderer, by opening a menu over the
 * session the composer belongs to. Two surfaces mount a whole `ChatDisplay`
 * over a session the HOST has never heard of — the `/btw` panel (D1.375), whose
 * id is derived from the real one, and `EditPopover`'s inline install chat
 * (D1.383), whose id is a stub minted before the hidden session exists. Opening
 * the menu over either addresses a session no server can look up: the
 * `rewindTrackedChanges` round trip can only fail, and the transcript the menu
 * lists is one the product invented. So on those surfaces a typed `/rewind` is
 * ORDINARY TEXT and is asked as a question, which is what D1.384 already
 * decided one layer up for `/btw`, `/recap` and `/heapdump` in the same panel.
 *
 * It asks {@link isRendererMintedSessionId} rather than sniffing a prefix of
 * its own: that module is the one spelling of which ids the renderer minted,
 * and a second spelling is free to drift the day either surface is renamed.
 *
 * ANDed rather than ordered. The guard it replaced was an ordering between two
 * statements in `handleSubmit`, and an ordering is a thing a later edit can get
 * wrong silently; there is nothing left here to sequence.
 *
 * An id-less composer (`undefined`) still opens the menu — that is not a minted
 * session but no session at all, and `handleOpenRewindMenu` already stops at
 * the round trip once it finds nothing to ask about.
 */
export function rewindCommandOpensMenu(message: string, sessionId: string | undefined): boolean {
  if (isRendererMintedSessionId(sessionId ?? '')) return false
  return parseRewindCommand(message) !== null
}

/**
 * P6.103 — whether the FILE-restoring action belongs on the panel for the
 * currently selected anchor.
 *
 * `checkpointing.md#rewind-and-summarize`, verbatim: *"The two code restore
 * options appear only when the selected checkpoint has tracked file changes to
 * revert. If no file edits were captured after that point, the menu offers only
 * **Restore conversation**, the summarize options, and **Never mind**."*
 *
 * PER ANCHOR, never per runtime. The distinction is measured, not stylistic: a
 * session that ran on Pi and later switched has real revertable checkpoints, and
 * a rewind reverts them whatever runtime is current — so a runtime-shaped gate
 * would hide a working action on exactly the sessions that need it most. The
 * ids come from the server, which computes them with the rewind walk's own
 * predicate.
 *
 * D1.378 — `undefined` is UNKNOWN and FAILS CLOSED: the server has not answered
 * yet, or could not. This function failed OPEN until that row, and SIT-6a
 * measured what that cost on the packaged 1.40.0 (RS-05, all three runtimes in
 * one run): `ChatDisplay.handleOpenRewindMenu` clears the answer at EVERY open
 * and asks again, so the panel offered the file-restoring action for the first
 * frames of every open and withdrew it when the answer landed — the menu
 * offered it on a session's first open and not on its second, and a fast press
 * pressed an action the product was about to take away.
 *
 * The reason the old direction gave — that hiding a working button on a failed
 * read is worse than showing an inert one — weighed a route that does not
 * exist: withholding it HERE removes no capability, because `ChatDisplay`'s
 * per-message context menu offers `messageMenu.rewindToHereRestoreFiles`
 * UNGATED, one right-click away, whatever this read did.
 */
export function rewindOffersCodeRestore(
  selectedId: string | null | undefined,
  trackedChangeIds: readonly string[] | undefined,
): boolean {
  if (!trackedChangeIds) return false
  if (!selectedId) return true
  return trackedChangeIds.includes(selectedId)
}

/**
 * P6.104 — what the composer should hold after a rewind, or `undefined` to leave
 * it exactly as it is.
 *
 * `checkpointing.md#rewind-and-summarize`, verbatim: *"After restoring the
 * conversation or choosing Summarize from here, the original prompt from the
 * selected message is restored into the input field so you can re-send or edit
 * it."*
 *
 * Lives here rather than in the caller because it is a DECISION with two rules
 * a source read cannot check, and the panel is the piece with a test harness.
 *
 * It APPENDS rather than overwrites, and that is not a softening of the page:
 * the page's own flow guarantees an empty input (double-`Esc` with text clears
 * it into history INSTEAD of opening the menu), and ours does not — `/rewind`
 * opens over whatever the user was typing. Overwriting would silently destroy an
 * unsent draft. `handleStop` already answers the identical question the identical
 * way when it puts an interrupted prompt back, so this reuses that helper rather
 * than minting a second convention.
 *
 * A prompt that is empty or whitespace-only returns `undefined`: there is
 * nothing to restore, and writing `''` would clear a draft the user still has.
 */
export function rewindComposerText(
  currentDraft: string | undefined,
  restoredPrompt: unknown,
): string | undefined {
  const restored = coerceInputText(restoredPrompt).trim()
  if (!restored) return undefined
  return appendRestoredInput(currentDraft, restored)
}

/**
 * The prompts a rewind can anchor on, oldest first.
 *
 * Chronological, matching the transcript above it — a menu that reversed the
 * transcript's order would make the user re-map what they are reading. The
 * caller pre-selects the newest instead, which is the common target.
 *
 * The filter mirrors the per-message context menu's gate exactly
 * (`!isPending && !isQueued`): a message the server has not accepted yet has no
 * anchor to rewind to, and offering one would be a row that fails on click.
 *
 * UB12.53 — a HIDDEN row (UB2.14: today only the source-activation auto-retry,
 * `<original>\n\n[<slug> activated]`) is skipped by the same truthy test the
 * transcript drops it with (`groupMessagesByTurn`, `!m.hidden`), so the menu
 * lists exactly the prompts the transcript shows. Offering it anchored the
 * rewind on a row the user never saw and restored the host's suffix into the
 * composer through {@link rewindComposerText}; the visible original it restates
 * stays offered, and rewinding to it also truncates the retry after it.
 */
export function collectRewindPrompts(messages: readonly RewindCandidateMessage[]): RewindMenuPrompt[] {
  const prompts: RewindMenuPrompt[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (message.hidden) continue
    if (message.isPending || message.isQueued) continue
    const preview = rewindPromptPreview(message.content ?? '')
    if (!preview) continue
    // C3.384 — the ANCHOR id, not the render id. `RewindMenuPrompt.id` is
    // documented as "the message id `rewindToMessage` takes", and until this row
    // it was the optimistic one the server has never heard of.
    prompts.push({ id: rewindAnchorId(message), preview, timestamp: message.timestamp })
  }
  return prompts
}

/** Local clock time for a row, or `''` when the row carries no timestamp. */
export function formatRewindPromptTime(timestamp: number | undefined, locale: string): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
  try {
    return new Date(timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  } catch {
    // An unusable locale tag must not blank the whole row.
    return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
}

/**
 * P6.280 — the `/compact` message a Summarize picks.
 *
 * ## Why this is a COMPOSED INSTRUCTION and not a new control request
 *
 * `checkpointing.md#rewind-and-summarize` documents "Summarize from here", and
 * no runtime we drive has it: at SDK 0.3.251 the complete control-request
 * enumeration is 34 members of `SDKControlRequestInner` with no compaction entry
 * of any kind (36 at 0.3.233 — the set SHRANK; the two that left are `get_plan` and
 * `get_workspace_diff`, both scoring 0 in `sdk.d.ts` now, and neither a
 * compaction), and codex's `thread/compact/start` takes a thread id and no anchor.
 * The row's own native-mechanism clause names what DOES exist — *"the same
 * instruction channel `/compact [instructions]` already uses"* — so this is a
 * tier-2 build: the host supplies the affordance once, over a channel all three
 * runtimes already honour, rather than three per-runtime approximations.
 *
 * ## What it therefore is, and is not
 *
 * The compaction is whole-conversation and GUIDED toward the anchor. It is not
 * cut at the anchor, because nothing in any runtime can cut it there. The panel
 * says so beside the button; `REWIND_MENU_DOCUMENTED_ITEMS` records it as
 * `offered-by-approximation`; and this is why "Summarize up to here" is NOT
 * offered alongside it — the same channel cannot express the other direction,
 * and offering both would let a user pick a direction the runtime does not have.
 *
 * ## The anchor is quoted as TEXT, not as an id
 *
 * A message id means nothing to the model. The prompt's own preview is what
 * identifies the point in a transcript the model can see, and it is already
 * flattened to one line and bounded at {@link REWIND_PREVIEW_MAX_CHARS} by
 * {@link rewindPromptPreview} — so this cannot smuggle an unbounded span of the
 * transcript into an instruction. Quotes are stripped from the preview rather
 * than escaped: the value is guidance for a model, and a stray `"` would only
 * blur where the quotation ends.
 *
 * User instructions come LAST, so a user who wants something else gets the last
 * word — the same precedence `/compact <instructions>` already gives them.
 * Empty instructions produce the anchored summary alone, which is the control
 * the row names: nothing about the existing unguided `/compact` changes.
 *
 * ## The page section that describes THIS affordance, added by C3.68
 *
 * `checkpointing.md#guide-a-summary` (anchor verified 2026-09-11 by fetching the
 * rendered page and grepping `id="…"`, per AGENTS.md) is the section for the
 * typed half specifically, where the paragraph above cites the one for the menu:
 * *"To guide what the summary focuses on, highlight a **Summarize** option with
 * the arrow keys and type instructions where the row reads **add context
 * (optional)**, then press `Enter`. Selecting the option with its number key
 * summarizes immediately without instructions."* Both halves are honoured here —
 * typing into the row's field and pressing Enter sends the guided command, and
 * pressing the button with the field empty sends the anchored summary alone.
 *
 * TWO DIVERGENCES, stated rather than implied. The field's placeholder is
 * *"Optional: what the summary should keep"* rather than the page's *"add
 * context (optional)"* — one vocabulary in one product, the same reason this
 * menu keeps the app's own restore labels. And the page's *"same session,
 * compresses context, like a targeted `/compact`"* is exactly what this is,
 * while its *"cut at the anchor"* reading is the one no runtime can honour, as
 * the paragraphs above measure.
 */
export function rewindSummarizeCommand(
  anchorPreview: string,
  instructions?: string,
): string {
  // Quotes and line breaks become spaces, then runs of whitespace collapse: the
  // second pass is what keeps a stripped quote from leaving a double space in a
  // sentence a model reads.
  const anchor = anchorPreview.replace(/["\n\r]+/g, ' ').replace(/\s+/g, ' ').trim()
  const guidance = (instructions ?? '').trim()
  const anchored = anchor
    ? 'Summarize this conversation, treating the prompt that begins '
      + `"${anchor}" as the point from which detail matters most: keep what happened from there onward `
      + 'specific, and condense everything before it.'
    // A prompt with no readable preview cannot be quoted, so the command
    // degrades to the plain compaction rather than quoting an empty string.
    : ''
  return ['/compact', anchored, guidance].filter(Boolean).join(' ')
}

export type RewindMenuKeyAction =
  | { type: 'move'; index: number }
  | { type: 'confirm' }
  | { type: 'close' }
  | null

/**
 * Keyboard semantics for the list, as a pure function so they are testable
 * without a DOM — the same shape `sideQuestionOverlayKeyAction` uses.
 *
 * The page's menu is a keyboard list, and an opener you can only finish with a
 * mouse is half an opener. Movement CLAMPS rather than wraps: a list of prompts
 * has a first and a last, and wrapping from the newest to the oldest is how a
 * held arrow key rewinds a session to its beginning.
 *
 * `Enter` confirms the CONVERSATION-only restore, never the file-restoring one.
 * The destructive half of the pair must not be one keystroke away from a list
 * you are still browsing.
 */
export function rewindMenuKeyAction(
  key: string,
  state: { index: number; count: number },
): RewindMenuKeyAction {
  if (key === 'Escape') return { type: 'close' }
  if (state.count === 0) return null
  if (key === 'ArrowUp') return { type: 'move', index: Math.max(0, state.index - 1) }
  if (key === 'ArrowDown') return { type: 'move', index: Math.min(state.count - 1, state.index + 1) }
  if (key === 'Home') return { type: 'move', index: 0 }
  if (key === 'End') return { type: 'move', index: state.count - 1 }
  if (key === 'Enter') return { type: 'confirm' }
  return null
}

export interface RewindMenuPanelProps {
  prompts: readonly RewindMenuPrompt[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** Run the rewind. `restoreFiles` mirrors `rewindToMessage`'s option. */
  onRewind: (messageId: string, restoreFiles: boolean) => void
  /**
   * P6.280 — run a Summarize for the selected anchor. The panel hands over the
   * COMPOSED `/compact …` message; the caller sends it on the one send path it
   * already owns, so this is a second way in and not a second implementation —
   * the same relationship `onRewind` has to `handleRewindConversation`.
   */
  onSummarize?: (command: string) => void
  /** "Never mind: return to the message list without making changes." */
  onClose: () => void
  /**
   * True while a turn is in flight. The menu still OPENS — a command that
   * silently does nothing is indistinguishable from a defect — and says why its
   * actions are unavailable instead.
   */
  busy?: boolean
  /**
   * P6.103 — the anchors a file-restoring rewind would revert something for,
   * from the server. D1.378 — `undefined` means UNKNOWN and WITHHOLDS the
   * action for every anchor: the caller clears this field at every open, so
   * offering the action until the answer lands is what put the button on a
   * session's first open and not its second. See {@link rewindOffersCodeRestore}.
   */
  trackedChangeIds?: readonly string[]
  locale: string
}

/**
 * The panel, with no portal of its own: `ChatDisplay` renders it inside the same
 * hand-rolled overlay backdrop its other overlays use, which is what keeps one
 * `handleCloseOverlay` and one open-overlay-at-a-time invariant. Rendering
 * without a portal is also what lets the test take static markup of it.
 */
export function RewindMenuPanel({
  prompts,
  selectedId,
  onSelect,
  onRewind,
  onSummarize,
  onClose,
  busy = false,
  trackedChangeIds,
  locale,
}: RewindMenuPanelProps) {
  const { t } = useTranslation()
  const containerRef = React.useRef<HTMLDivElement>(null)
  // P6.280 · the instructions the highlighted row's summary is given. Local to
  // the panel because they are scoped to this open and to this selection: a
  // sentence typed for one anchor is not guidance for the next one.
  const [summarizeInstructions, setSummarizeInstructions] = React.useState('')
  const selectedIndex = Math.max(0, prompts.findIndex(prompt => prompt.id === selectedId))
  const selected = prompts[selectedIndex]
  const canAct = !busy && Boolean(selected)
  // P6.103 · recomputed per SELECTION, not per open: the page gates on "the
  // selected checkpoint", and arrowing from an anchor with edits to one without
  // has to change the panel under the user.
  const offersCodeRestore = rewindOffersCodeRestore(selected?.id, trackedChangeIds)

  // Moving the highlight drops the typed guidance, for the reason above: the
  // field belongs to the anchor, and carrying it silently to the next one would
  // send a user's sentence about a prompt they have moved off.
  React.useEffect(() => { setSummarizeInstructions('') }, [selected?.id])

  // Focus the panel so the arrow keys reach it without a click. The list is the
  // menu; a menu you must click into before you can arrow through is a dialog.
  React.useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const action = rewindMenuKeyAction(event.key, { index: selectedIndex, count: prompts.length })
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    if (action.type === 'close') {
      onClose()
      return
    }
    if (action.type === 'move') {
      const next = prompts[action.index]
      if (next) onSelect(next.id)
      return
    }
    if (canAct && selected) onRewind(selected.id, false)
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="w-full max-w-xl overflow-hidden rounded-[8px] border border-border bg-background shadow-modal-small outline-none"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/40 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{t('chat.rewindMenu.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('chat.rewindMenu.description')}</p>
        </div>
        <button
          type="button"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {busy && (
        <p className="border-b border-border/40 bg-foreground/5 px-4 py-2 text-xs text-muted-foreground">
          {t('chat.rewindMenu.busy')}
        </p>
      )}

      {prompts.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('chat.rewindMenu.empty')}</p>
      ) : (
        <ul
          role="listbox"
          aria-label={t('chat.rewindMenu.title')}
          className="m-0 max-h-[50vh] list-none overflow-y-auto p-0"
        >
          {prompts.map((prompt, index) => {
            const isSelected = index === selectedIndex
            const time = formatRewindPromptTime(prompt.timestamp, locale)
            return (
              <li key={prompt.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => onSelect(prompt.id)}
                  onDoubleClick={() => { if (canAct) onRewind(prompt.id, false) }}
                  className={cn(
                    'flex w-full items-baseline gap-2 border-b border-border/20 px-4 py-2 text-left text-sm transition-colors',
                    isSelected ? 'bg-foreground/10 text-foreground' : 'text-foreground/80 hover:bg-foreground/5',
                  )}
                >
                  <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{prompt.preview}</span>
                  {time && <span className="shrink-0 text-xs text-muted-foreground">{time}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/*
        P6.280 · the Summarize affordance. It sits ABOVE the action row rather
        than beside the two restore buttons because it is the one action that
        takes an argument, and because its sentence — that the compaction is
        guided toward the selected prompt rather than cut at it — has to be read
        before the button is pressed, not after.
      */}
      {onSummarize && (
        <div className="flex flex-col gap-2 border-t border-border/40 px-4 py-3">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={summarizeInstructions}
              disabled={!canAct}
              onChange={(event) => setSummarizeInstructions(event.target.value)}
              onKeyDown={(event) => {
                // The list's own arrow/Enter semantics must not fire while the
                // user is typing a sentence into this field.
                event.stopPropagation()
                if (event.key !== 'Enter' || !canAct || !selected) return
                event.preventDefault()
                onSummarize(rewindSummarizeCommand(selected.preview, summarizeInstructions))
              }}
              placeholder={t('chat.rewindMenu.summarizeInstructionsPlaceholder')}
              aria-label={t('chat.rewindMenu.summarizeInstructionsPlaceholder')}
              className="min-w-0 flex-1 rounded-[6px] border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/40 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <button
              type="button"
              disabled={!canAct}
              className="flex shrink-0 items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-foreground/10 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => {
                if (canAct && selected) onSummarize(rewindSummarizeCommand(selected.preview, summarizeInstructions))
              }}
            >
              <Scissors className="h-3.5 w-3.5" />
              {t('chat.rewindMenu.summarize')}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{t('chat.rewindMenu.summarizeNote')}</p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 px-4 py-3">
        <span className="text-xs text-muted-foreground">{t('chat.rewindMenu.hint')}</span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-[6px] px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            onClick={onClose}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={!canAct}
            className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-foreground/10 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => { if (canAct && selected) onRewind(selected.id, false) }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('messageMenu.rewindToHere')}
          </button>
          {offersCodeRestore && (
            <button
              type="button"
              disabled={!canAct}
              className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-foreground/10 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => { if (canAct && selected) onRewind(selected.id, true) }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('messageMenu.rewindToHereRestoreFiles')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
