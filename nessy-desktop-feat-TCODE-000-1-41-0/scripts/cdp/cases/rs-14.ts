/**
 * RS-14 (P6.218) — a BACKGROUND subagent trips an ask rule: does the prompt
 * reach the MAIN session, does it name the asking subagent, and what does Esc do.
 *
 * ## Why this one is a recipe and not a `drive()`
 *
 * Three reasons, each of which would make an automated verdict wrong rather
 * than merely absent:
 *
 * 1. **It is a three-runtime question and each runtime spawns differently.**
 *    The row's own native-mechanism clause, verbatim: *"claude: native. Pi:
 *    background spawns are the default at depth 1 and the host owns the
 *    permission surface. codex: subagent threads share the session's approval
 *    channel."* Three different spawn paths mean three different sessions on
 *    three different cards — the owner's cards — driven one at a time.
 * 2. **The Esc half has no single state read.** "Esc stopped the whole agent"
 *    and "Esc stopped only that call" differ in the CHILD's fate, and only Pi
 *    publishes a child record the renderer can read
 *    (`getPiHarnessRuntime().snapshot.childState.children[].status`). On claude
 *    and codex the same distinction has to be read off the parent transcript
 *    continuing — or not — after the decline.
 * 3. **A prompt that appears is not a prompt that names the asker.** The row
 *    asks three things and a case that scored "a card appeared" would answer
 *    one of them.
 *
 * ## The detector, per half — a source the feature itself writes
 *
 * | Half | Read |
 * | --- | --- |
 * | a prompt exists at all | `electronAPI.getPiHarnessRuntime({workspaceId,sessionId}).snapshot.security.pendingPermissions` — what the BACKEND still considers unanswered, not what is on screen |
 * | the prompt reached the MAIN session | the card is mounted in the parent session's pane: `[data-tutorial="permission-banner"]` while that session is the selected row |
 * | the prompt NAMES the asking subagent | the card's own text, read after it has content (see the README's "wait for the surface" rule — an `innerText` taken the instant the selector matches returns `''`) |
 * | what Esc did | Pi: the child's `status` in `childState.children`. claude/codex: whether the parent transcript grows again after the decline, i.e. whether the agent had more to say |
 *
 * **Never a UI impression.** "I saw a prompt" and "the backend had an unanswered
 * request" are different facts; `pendingPermissions` is the one the feature
 * writes.
 *
 * ## The positive control, and why the row insists on it
 *
 * The row states it: *"the same ask rule tripped by the main thread in the same
 * session, which must prompt — otherwise the rig cannot distinguish a missing
 * background surface from a dead rule."* A rule that no longer asks (a mode
 * change, a stale allow-rule, a grant that outlived its session) produces
 * exactly the same emptiness as a background spawn whose prompt never surfaced.
 * Run the control FIRST, in the same session, before the background arm is
 * scored — a control run afterwards has already been contaminated by whatever
 * the decline did.
 *
 * ## Phrasing
 *
 * Every prompt here is POSITIVE. A prompt that names a tool and forbids calling
 * it trips Pi's Guardian as prompt injection and the wreckage reads like a
 * dispatch bug (AGENTS.md §Traps). Ask for the work; do not ask for a refusal.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-14'
const TITLE = 'a background subagent trips an ask rule — does the prompt reach the main session, does it name the subagent, and what does Esc do'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'P6.218',
  runtimes: ['pi', 'claude', 'codex'],
  credentials: 'owner: one card per runtime — the Pi gateway card, the "Claude Code (Nessy Gateway)" card, and a codex-runtime card. Name the card in the run notes; never a key.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. Launch the PACKAGED build (a dev build runs main and Pi from built bundles and is not the shipped artefact). Dark theme. One content panel open — a multi-panel layout puts several selected session rows on screen and no read below can say which one it meant.',
    '2. Pick the runtime for this sitting by selecting its card on a NEW session. Record the card name and the providerType (`electronAPI.listLlmConnections()`), not just "claude".',
    '3. Set the session permission mode to `default` (the ask mode) — `electronAPI.sessionCommand(id, { type: "setPermissionMode", mode: "default" })`, a state write rather than a menu click that may or may not have landed.',
    '4. THE CONTROL, FIRST: ask the MAIN thread for work that trips the ask rule — e.g. "Use your shell tool to list the files in <a directory outside the session workspace> and tell me what you found." Confirm a permission card appears AND that `snapshot.security.pendingPermissions` is non-empty. Answer it (allow) and let the turn finish. If no card appears, STOP: the rule is dead on this rig and nothing measured below means anything.',
    '5. THE PROBE: start a BACKGROUND subagent and give IT the same work. On Pi that is `/subtask` selected from the palette (typed one character at a time, selected with the arrow keys and Enter — see the README\'s insertText trap). On claude and codex use the runtime\'s own subagent entry point for a background spawn, and record which entry point you used.',
    '6. Watch the MAIN session\'s pane. Record: (a) does a permission card mount there at all; (b) `snapshot.security.pendingPermissions` at that moment; (c) the card\'s full text once it has content — WAIT for content rather than sampling, the card is `h-full` inside a pane that sizes a frame later and a read taken the instant the selector matches returns an empty string.',
    '7. Record whether the card NAMES the asking subagent — the agent id or the subagent\'s name, verbatim, quoted into the run notes. "It says an agent is asking" is not naming it.',
    '8. Press Escape once, with the card focused. Record `pendingPermissions` immediately afterwards.',
    '9. Read what Esc did. Pi: `getPiHarnessRuntime(...).snapshot.childState.children` — the child\'s `status` and `error`. claude/codex: watch the parent transcript for one minute — a child that only lost one tool call comes back with more work; a child that was stopped does not.',
    '10. Repeat 2–9 on the next runtime, in a session of its own. Do not reuse the session: an answered request and a granted rule both survive it.',
  ],
  expected: 'Per runtime, an explicit answer to three questions: the background subagent\'s permission request DOES / DOES NOT surface in the main session; the card DOES / DOES NOT name the asking subagent (quote the naming text); Esc stops ONLY THAT CALL / THE WHOLE AGENT (quote the child status or the transcript evidence).',
  detector: '`electronAPI.getPiHarnessRuntime({workspaceId, sessionId}).snapshot.security.pendingPermissions` for "a request exists and is unanswered"; `[data-tutorial="permission-banner"]` mounted in the MAIN session\'s pane, read after it has content, for "it reached the user"; `snapshot.childState.children[].status`/`.error` on Pi for what Esc did to the agent. Never the screen alone — a card left up by the renderer after an answered request and a genuinely pending second request look identical.',
  positiveControl: 'The SAME ask rule tripped by the MAIN thread in the SAME session, run BEFORE the background arm and required to prompt. Without it a silent background arm is indistinguishable from a rule that no longer asks. A second, cheaper control for the Esc half: press Escape when NO card is up, which must change nothing.',
  doneMeans: 'three cells with driven verdicts, and any runtime where Esc stops the whole agent gets either a fix or a named divergence.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
