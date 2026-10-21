/**
 * RS-134 (UB14.28) — the send control, the context chip and the follow-up chips, live and DARK.
 *
 * ## The row
 *
 * UB14.28 lifted three pieces of `FreeFormInput` into v0.15.1's components: `SendButton` (the round
 * accent primary that morphs to Stop instead of going grey, over OUR four-state control: Send, Queue,
 * Steer, Stop, plus Loading, `inert` and our tooltip table), `ContextUsageChip` (upstream's info-tint
 * chip at the warning, driven by our `resolveContextMeterState`, with OUR always-on quiet ring below
 * it and the broken ring for an unknown window), and `FollowUpChips` (taken 1:1). The redesign rows
 * owe "an arm in that area's CDP screenshot case in DARK theme"; this id is lane-picked (next free:
 * RS-132 is the last case file, RS-133 is L-PI's proposal for UB5.3), NOT in `run.ts`'s `SITTING`
 * (the checklist is controller-owned — the rs-121 rule), and the controller confirms it at the pin.
 * The DRIVE is the END-sitting wave's; this file is the recipe. The offline arms are
 * `send-button.test.tsx`, `follow-up-chips.test.tsx`, `context-meter-state.test.ts`'s UB14.28
 * describe, and the playground sweep's UB14.28 arm in `registry-render.test.ts` (dark).
 *
 * ## What the case proves
 *
 * The packaged app paints the accent control in every state and keeps our behaviour: the mode names,
 * the Stop that does not act twice, the tooltip's keys and its one-message override line (hidden with
 * files staged), the always-visible meter with its compact-on-click warning, and the follow-up chips'
 * two click targets.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts';

const ID = 'RS-134'
const TITLE =
  'the send control, the context chip and the follow-up chips (DARK): an idle Send on the disabled fill, Send/Steer/Queue/Stop on the same solid accent with their names and type, the inert Stop after a press, the queue/steer tooltip with its keycaps and override line, the quiet context ring, the info-tint warning chip that compacts, the broken ring for an unknown window, and the follow-up chips on v0.15.1\'s material'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB14.28',
  runtimes: ['pi'], // the three components are runtime-neutral renderer files; one Pi session carries every arm
  credentials:
    'none for step 1. Steps 2–7 send turns: the Nessy gateway card, or the mock card when every gateway model is rate-limited.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-check: the packaged build carries the UB14.28 commit or later. Launch by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, DARK theme (owner rule), bypassPermissions (no card is the subject), a Pi session open, the window ≥ 1400 px wide.',
    '1. IDLE SEND (empty composer): read `button[data-tutorial="send-button"]` — EXPECT data-state="idle", data-mode="send", type="submit", disabled; getComputedStyle background-color = the computed --fill-hover (the primary\'s disabled fill), border-radius ≥ half its width (round), getBoundingClientRect 28×28. Type one word — EXPECT data-state="ready" and background-color = --accent-solid, color = --on-accent. Screenshot dark. Clear the text.',
    '2. LIVE STOP: send "Count slowly from 1 to 40, one number per line." — while the turn runs and the composer is EMPTY, EXPECT data-mode="stop", type="button", NOT disabled, background-color = --accent-solid (the same accent as Send, not grey) and aria-label = the en/ru value of chat.submit.stop. Screenshot dark.',
    '3. STEER / QUEUE: with that turn still running (re-send step 2 if it ended), type "and add a total". With the connection\'s mid-stream default = Steer (Settings → AI) EXPECT data-mode="steer", type="submit", aria-label = chat.submit.steer. Hover the control — EXPECT the tooltip table: the Steer label beside an Enter keycap (`kbd.keycap`), the Stop label beside an "Esc Esc" keycap, and the one-message override sentence (chat.midStream.overrideQueue) beside the chord\'s keycap. Stage any small file — EXPECT data-mode="queue" and the override row ABSENT from the tooltip (F1.331). Remove the file; switch the mid-stream default to Queue — EXPECT data-mode="queue" and the override sentence = chat.midStream.overrideSteer. Screenshot dark (tooltip open).',
    '4. THE INERT STOP: clear the draft while a turn runs and click Stop once. EXPECT the stopped prompt restored into the composer exactly once, and — until the turn settles — the control still data-mode="stop" and disabled (a second click is a no-op: the composer text is unchanged, no second copy appended). After the turn settles EXPECT data-mode="send", data-state="ready".',
    '5. THE QUIET RING: after any completed turn, EXPECT one `[data-state="quiet"][role="img"]` in the toolbar left of the model picker, its color = --text-tertiary, no background, its aria-label the chat.contextUsage.label sentence with the window share; hover — the tooltip names the tokens used of the window. Screenshot dark.',
    '6. THE WARNING CHIP (runOnlyIf a session reaches ≥ 80 % of its compaction threshold — e.g. a BYO connection whose model has a small context window configured, then two long pastes): EXPECT `button[data-state="warning"]` with background-color = --info-tint, color = --info, text "N%" where N matches the ring\'s fill, aria-label the chat.contextUsage.combined sentence; while a turn runs it is disabled (cursor default), not hidden. Click it idle — EXPECT a /compact turn and, after compaction, the quiet ring back. UNKNOWN WINDOW (runOnlyIf a connection model with no recorded window): EXPECT `[data-state="unknown"]` — a broken ring with "?" — and never an empty ring. Screenshot dark.',
    '7. FOLLOW-UP CHIPS: select a sentence in an assistant message and add a follow-up note. EXPECT a chip above the editor: height 28 px, background-color = --fill-hover, the keycap index (`.keycap`), the italic excerpt in --text-tertiary, "·", the note. Hover the keycap — the tooltip shows the selected text. Click the keycap — EXPECT the transcript scrolled to that annotation (the chip body is NOT activated: the note editor does not open); click the chip body — EXPECT the note editor opened at the chip. Screenshot dark.',
    '8. Verdict, for the checklist row the controller writes: PASS when the idle Send reads the disabled fill and the ready Send, Steer, Queue and live Stop all read --accent-solid with their names and types, the tooltip shows the keycaps and the override row (absent with a file staged), the inert Stop neither re-stops nor re-restores, the quiet ring is always there after a turn, the warning chip (if run) is info-tinted and compacts, the unknown arm (if run) is the broken ring, and the follow-up chip wears the fill-hover material with its two click targets.',
  ],
  expected:
    'In the packaged app, dark theme: the send control is a round 28 px button that is neutral only while there is nothing to send and otherwise the solid accent — Send, Steer, Queue and Stop alike — named per state; after a Stop press it stays an inert Stop until the turn settles; its tooltip lists the keys and the one-message override; a quiet tertiary ring meters the context at all times and turns into an info-tinted "N%" chip that compacts at the warning; follow-up notes sit above the editor as fill-hover chips with a keycap index.',
  detector:
    'DOM reads of `button[data-tutorial="send-button"]` (data-state, data-mode, type, disabled, aria-label) and of `[data-state="quiet"|"warning"|"unknown"]` in the toolbar; getComputedStyle background-color / color compared with the computed custom properties (--fill-hover, --accent-solid, --on-accent, --text-tertiary, --info-tint, --info) on the same page; getBoundingClientRect for sizes; the composer\'s text before and after the second Stop click; screenshots only as the dark record.',
  positiveControl:
    'Step 1\'s idle and ready reads MUST differ in background-color — if they do not, the read is of the wrapper span, not the button. Step 3\'s staged-file read MUST flip data-mode from steer to queue — if it does not, the mid-stream default read is wrong and the tooltip arm proves nothing.',
  runOnlyIf:
    'The packaged build carries the UB14.28 commit or later. Steps 2–7 need a model turn (the gateway, or the mock card on quota exhaustion). Step 6\'s warning arm needs a session near its compaction threshold; its unknown arm a model with no recorded window.',
  doneMeans:
    'UB14.28\'s checklist row (the controller\'s) carries the verdict: the send control\'s computed material and attributes in idle, ready, steer, queue, stop and inert-stop; the tooltip table with and without a staged file; the quiet ring; the warning chip and its compaction (if run); the unknown ring (if run); the follow-up chip\'s material and click targets — each PASS/FAIL with its reading.',
  doNotConflate:
    'The card around the toolbar is UB14.27\'s; the toolbar ORDER and the two-group layout (context and Send outside the squeeze, compact mode · model to the right) are UB14.32\'s; the mode and model chips are UB14.29/UB14.30\'s; whether a runtime queues or steers is the connection\'s mid-stream default (P6.480), not this row.',
  safety:
    'No credentials read or printed. Turns are ordinary counting/summary prompts through the configured card; the staged file is a small text file created in the session\'s working directory under the fresh NESSY_CONFIG_DIR.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
