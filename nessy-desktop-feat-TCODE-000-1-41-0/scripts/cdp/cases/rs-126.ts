/**
 * RS-126 (UB2.7) — the Phase 2 live cases: four drives this lane can land
 * offline but not run (a packaged sitting owns every drive).
 *
 * ## The row
 *
 * UB2.7 names four live cases on the landed Phase 2 rows; this file is their
 * recipe sheet. The id is lane-picked (next free after RS-125; the dispatch
 * allocated none), NOT in `run.ts`'s `SITTING` (the checklist is
 * controller-owned — the rs-121 rule), and the controller confirms it at the pin.
 *
 * ## Arm A — the Claude plan-accept transcript (UB2.1)
 *
 * Landed with UB2.1: a plan handoff (`SubmitPlan`/auth tools) waits up to
 * `HANDOFF_RESULT_WAIT_MS` (3 s) for the tool result before the interrupt
 * fires, so the transcript after an accept carries the turn's OWN tool result —
 * not an interruption ghost. `pauseSteerFifo`/steer retention kept.
 *
 * ## Arm B — Stop on Claude: turn 2, and mid-answer then reload (UB2.2)
 *
 * Landed with UB2.2: the empty-response recovery skips a turn whose
 * `lastAbortReason` is user_stop (the stopped message is never re-sent, the
 * session id survives), `flushPending` at the AbortError branch keeps a
 * FINISHED text block across a reload, and a Stop during the prep window
 * answers Interrupted instead of a generic error. `INTERRUPT_DEADLINE_MS` 5 s
 * (kept deviation, UB2.10).
 *
 * ## Arm C — /compact plus a message (UB2.3)
 *
 * Landed with UB2.3: on Pi `isCompactionInFlight` makes `redirect()` refuse
 * WITHOUT aborting the compact and the host QUEUES the message (no
 * `wasInterrupted` stamp); the compact RPC deadline aborts the child. On
 * Claude UB2.3 KEPT the F1.238 arm by code reading (the steer rides the
 * F1.335 FIFO and `recoverPendingSteers` re-queues it at `complete`) — the
 * Claude half of this drive IS that KEEP's confirming measure.
 *
 * ## Arm D — an attachment-only turn needing a source (UB2.4)
 *
 * Landed with UB2.4: the `source_activated` retry falls back to the LAST USER
 * MESSAGE when the captured original is empty (an attachment-only turn), and
 * the turn's steers ride the retry. Since UB2.14 the retry is sent HIDDEN, as
 * upstream does: the transcript shows the user's turn, the activation and the
 * answer, and NO second user bubble carrying the `[<slug> activated]` suffix —
 * live and after a reload (the row persists `hidden: true`).
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-126'
const TITLE =
  'the Phase 2 drives: the Claude plan-accept transcript, Stop on turn 2 and mid-answer then reload, /compact plus a message on Pi (and the Claude KEEP measure), and an attachment-only turn needing a source'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB2.7',
  runtimes: ['claude', 'pi'],
  credentials:
    'owner: arms A and B need the claude-gateway card (a signed-in claude-runtime session), arm C needs the Pi gateway card (and the claude-gateway card for its Claude half), arm D needs a session whose workspace has one configured source that requires activation (an OAuth source the rig may sign in). No key or token is ever read or printed.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-checks per arm (scripts/cdp/README.md\'s stale-bundle rule — rebuild, relaunch, then measure): A needs UB2.1 (handoff wait in the build), B needs UB2.2, C needs UB2.3, D needs UB2.4. Each arm runs on its own fresh session so a prior arm\'s transcript never feeds a detector.',
    '1. Launch the PACKAGED build by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, dark theme, bypassPermissions except where the arm says otherwise.',
    '2. ARM A (UB2.1, claude-gateway, a PLAN-capable card): ask the agent to plan a small change ("plan how you would rename the utils module") and press through the plan flow (SubmitPlan fires; the turn is mid-handoff). ACCEPT the plan immediately (inside the 3 s handoff window). THE DETECTOR: the runtime debug log\'s turn record — the accepted turn completes with its OWN handoff tool result attached (a plan_accepted/tool result in the same turn record), and NO interrupt/interruption record between the handoff begin and the result. POSITIVE CONTROL: accept AFTER the handoff window on a second run (or pause the debugger path by accepting on a noticeably delayed second) — the transcript then shows the ordinary interrupt path, proving the detector can see the difference.',
    '3. ARM B1 (UB2.2, claude-gateway, turn 2): turn 1 — any short prompt answered fully. Turn 2 — ask for a long answer and press Stop ~2 s in. EXPECT: the turn ends Interrupted (not an error), turn 2\'s message is NOT re-sent (no duplicate user bubble, no surprise second answer), the session id is unchanged (reload keeps the history), and a following turn answers normally. ARM B2 (same session): ask for a long multi-block answer, let ONE text block finish, then Stop mid-answer; reload the session. EXPECT: the finished block is present after the reload (flushPending), the partial tail is not double-painted, and a following turn is clean. DETECTOR: the runtime debug log\'s turn records (lastAbortReason user_stop; the resumed turn carries no re-send) plus the visible transcript; never model prose alone.',
    '4. ARM C (UB2.3, Pi gateway card): in a session long enough to compact, send /compact and IMMEDIATELY send a message ("count to three") while the compact is running. EXPECT on Pi: the compact completes and the queued message is then answered (one reply after the compact; no `wasInterrupted` stamp in the turn record; the compact is not aborted). THE CLAUDE HALF (the UB2.3 KEEP measure, claude-gateway card, same recipe): the same drive — EXPECT the message rides the FIFO and is answered after the compact completes (recoverPendingSteers). If the Claude drive shows the message LOST or the compact aborted, the KEEP verdict flips and UB2.3\'s cell records it — that is a finding, not a pass. CONTROL: the same message sent with NO compact running answers at once (proves the queue detector sees the ordinary path too).',
    '5. ARM D (UB2.4, a workspace with one activation-needing source): start a NEW turn whose content is ONLY an attachment (a small text file) asking nothing in words, on a session bound to the source that must activate. Approve the activation when the card raises. EXPECT: the source_activated retry fires with the attachment turn\'s content (the last-user-message fallback) plus any steers, the agent answers about the attachment using the activated source, and the retry message is NOT drawn (UB2.14: no second user bubble with the "[<slug> activated]" suffix, live and after a reload). CONTROLS: (a) the same attachment-only turn on a session whose source is ALREADY activated needs no retry and answers at once; (b) a turn with no content at all does not retry (nothing to resend) and reports honestly.',
    '6. Verdict per arm, recorded in the checklist rows the controller writes: A passes when the accepted handoff turn carries its own result with no interrupt record (and the control shows the detector sees the other path); B passes when the stopped message is never re-sent and the finished block survives the reload; C passes when the queued message is answered after the compact on Pi and the Claude KEEP measure confirms or honestly flips; D passes when the attachment-only retry carries the attachment turn, draws no second user bubble (its persisted row reads `hidden: true`), and the two controls hold.',
  ],
  expected:
    'Arm A: an accepted plan handoff completes with its own tool result and no interrupt record inside the 3 s window. Arm B: a turn-2 Stop leaves no re-send and the session intact; a mid-answer Stop then reload keeps the finished block. Arm C: a message sent during /compact is answered after the compact on Pi (queued, not interrupted), and the same drive on Claude confirms the KEEP (or honestly flips it). Arm D: an attachment-only turn needing a source retries with the attachment turn\'s content, answers from the activated source, and the retry draws no bubble, live or after a reload (UB2.14).',
  detector:
    'Product-written records plus the visible transcript: the runtime debug log\'s turn records (handoff begin/result pairs, lastAbortReason, the queue\'s no-wasInterrupted stamp, the retry message record), never model prose alone. The reload check reads the persisted transcript, not the in-memory DOM.',
  positiveControl:
    'Per arm: A — a late accept (outside the window) shows the ordinary interrupt path, so the detector sees both; B — a turn completed without Stop renders one clean answer (the no-re-send detector reads a normal turn too); C — the same message with no compact running answers at once through the same queue reader; D — an already-activated source answers without a retry, proving the detector reads the retry\'s absence as well as its presence.',
  runOnlyIf:
    'Arm A/B: the claude-gateway card signed in and UB2.1/UB2.2 in the build. Arm C: UB2.3 in the build; the Pi half needs the Pi gateway card, the Claude half the claude-gateway card (run both halves; the Claude half is UB2.3\'s KEEP measure). Arm D: a workspace with one configured OAuth source the rig may activate, and UB2.4 in the build. An arm whose runtime card is unavailable BLOCKS, it does not fail.',
  doneMeans:
    'UB2.7\'s checklist row (the controller\'s) carries verdicts: the handoff transcript, the two Stop drives, the /compact queue (both halves) and the attachment-only retry, each with its control, in the packaged sitting.',
  doNotConflate:
    'Arm A\'s "no interrupt" is the ABSENCE of an interrupt record between the handoff begin and the result in the runtime log — a completed turn with a late tool result is still a pass if the interrupt record is absent. Arm B\'s "no re-send" is about turn 2\'s USER message never appearing twice, not about the assistant\'s partial text (which may legitimately end mid-sentence). Arm C\'s queued answer must come AFTER the compact\'s own completion record — a reply that raced the compact is a different finding. Arm D\'s visible retry is the RESIDUE working as recorded, not a defect to file against this row.',
  safety:
    'All four arms run on rig-owned sessions and workspaces. Arm D\'s source is one the rig itself configured; the activation consent card is approved by the operator, never bypassed. No key or token is ever read or printed; the attachment is a rig-made text file.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
