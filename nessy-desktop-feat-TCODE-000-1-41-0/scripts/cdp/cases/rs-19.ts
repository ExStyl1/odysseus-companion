/**
 * RS-19 (P6.282) — what a runtime KEEPS when the connection drops mid-response:
 * the text, the tool calls, and whether anyone is told it may be incomplete.
 *
 * ## Why this is a measure and not a build
 *
 * The row's native-mechanism clause, verbatim: *"Not established on any arm.
 * claude: the SDK owns this and 0.3.233 post-dates the v2.1.199 change, so the
 * behaviour is probably inherited — nothing in our stream adapter names it."*
 * "Probably inherited" is a claim about a vendor binary nobody has run, and the
 * row says so in as many words. A run settles it; a read cannot.
 *
 * ## Three drops that are NOT this one
 *
 * The row names two neighbours and they must not be conflated, because each
 * would answer a different question with this one's evidence:
 *
 * - **P6.114** — an upstream that holds the socket OPEN and silent on claude.
 *   The opposite condition: nothing arrives and nothing closes.
 * - **P6.115** — the byte watchdog is inert on every Nessy claude session. A
 *   fact about the timer, not about the drop.
 * - and a USER interrupt, which is RS-19's sibling RS-20 (P6.284). An interrupt
 *   is orderly and the host knows it happened; a drop is neither.
 *
 * Share their rig, never their verdict.
 *
 * ## The rig: a stub upstream, because a real one cannot be made to drop
 *
 * A small HTTP server the sitting runs on loopback, pointed at by a BYO
 * connection on each runtime (pi_compat / the claude-runtime loopback adapter's
 * `openai-compatible` upstream / the codex Responses adapter). It streams:
 *
 *   1. a few tokens of assistant text;
 *   2. one COMPLETE tool call — complete, so the "are the completed tool calls
 *      kept and continuable from their results" question has a subject;
 *   3. then destroys the socket, mid-response, without a terminating frame.
 *
 * The same server serves both controls by flag, so all three arms are the same
 * bytes up to the last one.
 *
 * ## The detector
 *
 * The session's own stored transcript AFTER the drop — `getSessionMessages` —
 * plus the runtime's own session file for what the runtime believes it has.
 * Three separate readings, because the row asks three separate questions and a
 * single "the turn ended badly" verdict answers none of them:
 *
 * | Question | Read |
 * | --- | --- |
 * | is the produced text kept | the assistant message content in the stored transcript |
 * | are the completed tool calls kept and CONTINUABLE | the tool entry's `toolUseId` and `toolResult`, and then whether a follow-up turn can refer to that result |
 * | is the user told it may be incomplete | any info/warning/error message the turn added, quoted verbatim |
 *
 * The third is the one with a known-empty starting point: the row records that
 * the phrase *"may be incomplete"* scores nothing in our own surfaces today. So
 * an absence there is the expected reading and must still be written down as a
 * verdict — `absent` with the run behind it — rather than left as a blank cell.
 *
 * ## Never the app log
 *
 * A packaged build turns both electron-log transports off unless it is launched
 * with `-- --debug`, so an empty `main.log` is not evidence of anything. If a
 * stream-level line is genuinely needed, that lever (F1.767,
 * `lib/runtime-session-log.ts` symbol `DEBUG_LEVER`) is what costs an observer
 * effect — `NESSY_IS_PACKAGED=false` is only the fallback, and it loaded no
 * session on the 1.41.0 RC — and the transcript reading above does not need it.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-19'
const TITLE = 'a connection that drops mid-response — what text and which tool calls survive, and whether the user is told it may be incomplete'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.282',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'none — every arm runs against a loopback stub the sitting starts. A BYO connection per runtime points at it; no provider key is needed and none may be entered.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. Start the stub upstream on loopback. It must stream, in one response: a short run of assistant text, then ONE complete tool call, then destroy the socket without a terminating frame. Give it two flags: `--close-clean` (finish the response normally) and `--drop-early` (destroy the socket before any output).',
    '2. PACKAGED build. Create one BYO connection per runtime pointing at the stub — pi_compat for Pi, a claude-runtime connection whose upstream is the stub (the per-session loopback adapter translates it), and a codex-runtime connection on the Responses adapter. Record each card by slug.',
    '3. CONTROL A, first, per runtime: run the stub with `--close-clean`. The turn must COMPLETE — text present, tool call present with a result, no error notice. Without this arm the whole case is measuring a broken connection rather than a drop.',
    '4. THE PROBE, per runtime: run the stub in its default (drop) mode and send one turn. Wait until the session stops processing.',
    '5. Read the stored transcript (`electronAPI.getSessionMessages(id).messages`) and record THREE things separately: (a) is the assistant text that had already streamed still there, verbatim; (b) is the completed tool call still there with its `toolUseId` and its result; (c) what, if anything, the user is told — every info/warning/error message the turn added, quoted.',
    '6. Test CONTINUABLE for (b): send one follow-up turn that refers to the tool\'s result by name and see whether the runtime can use it. "The entry is in the transcript" and "the next turn can build on it" are different facts.',
    '7. CONTROL B, per runtime: run the stub with `--drop-early`. Nothing was produced, so nothing may be kept — a partial assistant message here would mean the host is manufacturing one, which is a finding of its own.',
    '8. Write each runtime\'s cell as three answers plus the notice text, or as `absent` with the run behind it. Do NOT write one combined verdict: the row asks three questions and the ledger cell carries `ʰ` per answer.',
  ],
  expected: 'Per runtime, three recorded answers (text kept / tool calls kept and continuable / user told) and the verbatim notice text if any. Control A completes; control B keeps nothing.',
  detector: 'the stored transcript after the drop, and the runtime\'s own session file for what the runtime believes it holds. Never the application log — a packaged build writes none and its emptiness is not evidence.',
  positiveControl: 'A: the same stub closing normally, which must complete the turn. B: a drop BEFORE any output, which must not manufacture a partial.',
  doneMeans: 'per runtime, a recorded answer to three questions — is the already-produced text kept, are the completed tool calls kept and continuable from their results, and is the user told the response may be incomplete — written into the cell with `ʰ`, or the cell recorded `absent` with the run behind it.',
  doNotConflate: 'P6.114 (an upstream that holds the socket OPEN and silent on claude), P6.115 (the byte watchdog inert on every Nessy claude session), and RS-20/P6.284 (a USER interrupt). Same rig, different conditions, different verdicts.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
