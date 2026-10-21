/**
 * RS-24 (P6.481, the LIVE arm only) — a SIGNED thinking block is accepted by the
 * claude child, and an UNSIGNED one is refused with a 400.
 *
 * Everything else in P6.481 is built. Both replay arms landed (`2a9731131`), the
 * two `SessionManager` lines landed (`e99c31040`), and the switch-cost row landed
 * (`84badb3e3` + `73e40b639`) with codex's cell `'conditional'` because the
 * gateway leg drops reasoning per MODEL rather than per runtime. What remains,
 * and the only reason the row still carries 🟨, is the pair of live facts a
 * credential is needed for.
 *
 * ## Both halves, and why one without the other proves nothing
 *
 * - **the positive**: a claude → claude switch replays the persisted `isThinking`
 *   rows WITH their signature and the child ACCEPTS them. Alone, this is
 *   consistent with the child ignoring the blocks entirely.
 * - **the negative control**: an unsigned or foreign-origin block, sent
 *   unstripped, must 400. Alone, this is consistent with the child rejecting
 *   every thinking block including the good ones.
 *
 * Only the pair says the signature is what the child is checking. The 400 is
 * documented from an earlier run (plan `2026-08-04`, line 729); this sitting is
 * where it is reproduced against the shipped binary.
 *
 * ## The control is deliberately NOT driven through the product path
 *
 * The host STRIPS a signature-less or foreign-origin block by design — that is
 * the feature. So a case that simply switched a foreign-origin session and
 * watched for a 400 would measure the STRIP, not the child, and would pass on a
 * build whose child accepts anything. The negative arm has to send an unstripped
 * block deliberately: point a claude-runtime connection at a loopback recorder
 * that forwards upstream unchanged, and inject one block with its `signature`
 * removed. The 400 then comes from the real upstream and means what it says.
 *
 * Record the upstream's verbatim refusal. "It failed" is not the evidence; the
 * refusal text is.
 *
 * ## The detector
 *
 * The claude SDK's own transcript for what was SENT
 * (`<config>/workspaces/<workspaceId>/claude-config/projects/…/*.jsonl`, which
 * `scripts/cdp/lib/runtime-session-log.ts` walks in full — one Nessy session is
 * many SDK transcripts and reading only the newest loses the boundary), and the
 * loopback recorder's log for what the upstream ANSWERED. Our own transcript
 * cannot answer either half: the replay is a wire concern.
 *
 * A thinking block is identified by `"type":"thinking"` beside a `"signature"`
 * field — the observable shape the row already measured across 149 of the first
 * 200 of 5 324 real transcripts.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-24'
const TITLE = 'the live reasoning-replay arm — a signed thinking block accepted by the claude child, and the unsigned-block 400 control'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.481',
  runtimes: ['claude'],
  credentials: 'owner: a claude-runtime card (the "Claude Code (Nessy Gateway)" card is enough) plus, for the negative arm, a second claude-runtime connection pointed at a loopback recorder that forwards upstream unchanged. No key is typed by the sitting; the card is already signed in.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. PACKAGED build. Confirm the three landed pieces are IN the artefact before measuring — a run against a build predating `2a9731131` / `e99c31040` measures the old behaviour and would reopen a closed row for nothing.',
    '2. THE POSITIVE ARM. New session on a claude-runtime card. Set the thinking level to one that reasons and run two or three turns that actually produce thinking (a small design question, not a one-word reply). Confirm the transcript carries `isThinking` rows.',
    '3. Switch the session to ANOTHER claude-runtime card (claude → claude, so the replay format is the child\'s own). Then send one ordinary turn.',
    '4. Read the SDK transcript for the new child and record: how many `"type":"thinking"` entries were replayed, and whether each carries a `"signature"`. Then record whether the turn COMPLETED — an accepted replay finishes normally.',
    '5. Record the upstream\'s answer verbatim if it did not complete. A refusal here is the finding.',
    '6. THE NEGATIVE CONTROL. Point a second claude-runtime connection at a loopback recorder that forwards upstream unchanged and logs both directions. Repeat 2–3 on it, and have the recorder REMOVE the `signature` field from one replayed thinking block before forwarding.',
    '7. Record the upstream\'s status and its verbatim message. The expected reading is a 400. A 200 here is the important finding: it would mean the signature is not what the child checks, and the strip the host performs is protecting nothing.',
    '8. SECOND CONTROL, cheap and load-bearing: with the recorder forwarding UNMODIFIED, the same switch must complete. Without it, a 400 in step 7 is indistinguishable from a recorder that mangles every request it touches.',
    '9. Write both halves into the row. The positive alone is consistent with a child that ignores thinking blocks; the negative alone with a child that refuses all of them. Only the pair says the signature is the thing being checked.',
  ],
  expected: 'a claude → claude switch replays the signed blocks and the child accepts them (the turn completes); the same replay with one signature removed is refused by the upstream, verbatim quoted; and the unmodified pass-through control completes.',
  detector: 'the claude SDK\'s own transcript for what was sent (every `.jsonl` in the session\'s `claude-config/projects` directory, not just the newest), and the loopback recorder\'s log for what the upstream answered. Our own transcript cannot see either.',
  positiveControl: 'the unsigned-block 400 is itself the row\'s named negative control; plus an unmodified pass-through arm that must complete, so a refusal cannot be blamed on the recorder.',
  doneMeans: 'a claude→claude switch replays the persisted `isThinking` rows with their signature and the child accepts them; a signature-less or foreign-origin block is STRIPPED rather than sent, with a negative control proving an unstripped one 400s.',
  neverDo: 'Do not drive the negative arm through the product path. The host strips an unsigned block by design, so that route measures the strip and would pass on a child that accepts anything.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
