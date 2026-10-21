/**
 * RS-127 (UB2.12) — the Phase 2 delta live cases: four drives this lane can
 * land offline but not run (a packaged sitting owns every drive).
 *
 * ## The row
 *
 * UB2.12 names four live cases on the landed delta rows; this file is their
 * recipe sheet. The id is lane-picked (next free after RS-126; the dispatch
 * allocated none), NOT in `run.ts`'s `SITTING` (the checklist is
 * controller-owned — the rs-121 rule), and the controller confirms it at the pin.
 *
 * ## Arm A — a task step stopped mid-turn, then steered (UB2.8)
 *
 * Landed with UB2.8: a USER's Stop (`interrupted`, or `timeout` from a Stop)
 * sets `waitingForUser`, logs `node-waiting {reason:'stopped'}`, moves the run
 * to needs-review and keeps the node RUNNING IN ITS OWN SESSION; the next turn
 * ANSWERING THE USER completes the step with its reply (`fromUser`); the
 * verdict listener ignores `interrupted`/`timeout` (a Stop during verify sends
 * no re-ask); an empty reply fails the node.
 *
 * ## Arm B — Generate subtasks on a real task (UB2.9)
 *
 * Landed with UB2.9: `waitForTurnReply` subscribes to `onSessionActivity`
 * BEFORE the send — an authoring turn that keeps emitting activity runs to its
 * natural end (idle 90 s rejects as stalled; cap 300 s) instead of dying at the
 * fixed 180 s attempt timer; the draft session runs at thinking `medium`.
 *
 * ## Arm C — Stop with a detached Pi MCP call running (UB2.10, the measure's sitting arm)
 *
 * Landed with UB2.10 (both halves): the subprocess sends
 * `tool_execute_detached {requestId, taskId}` and the host moves the entry into
 * `detachedToolExecutions`, which the Stop sweep cannot reach; session death
 * still settles it; `stop_background_task` stops it by taskId. This drive IS
 * the row's [measure] arm.
 *
 * ## Arm D — a 15 MB PDF on claude-gateway answers from the stored path (UB2.11)
 *
 * Landed with UB2.11: `shouldInlinePdf` inlines only ≤ 10 MB with base64, and
 * on a TRANSLATED route (the claude-runtime loopback adapter) a PDF always
 * goes by the stored path plus upstream's note — the bytes never travel a
 * route that would drop them.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-127'
const TITLE =
  'the Phase 2 delta drives: a task step stopped mid-turn then steered to completion, Generate subtasks without the 180 s timeout, Stop with a detached Pi MCP call running, and a 15 MB PDF on claude-gateway answered from the stored path'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'UB2.12',
  runtimes: ['pi', 'claude'],
  credentials:
    'owner: arms A and B need a workspace with tasks enabled and a real task to generate subtasks for; arm C needs the Pi gateway card plus a configured MCP server exposing one SLOW read-only tool (a sleep tool the rig controls) past the R10 detach threshold; arm D needs the claude-gateway card and a rig-made ~15 MB PDF. No key or token is ever read or printed.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '0. Land-checks per arm (scripts/cdp/README.md\'s stale-bundle rule — rebuild, relaunch, then measure): A needs UB2.8 (waitingForUser in the build), B needs UB2.9, C needs UB2.10 (both halves), D needs UB2.11. Each arm on its own fresh session/task so detectors never read a sibling arm\'s state.',
    '1. Launch the PACKAGED build by scripts/cdp/README.md\'s env -u launcher — fresh NESSY_CONFIG_DIR, dark theme, bypassPermissions unless the arm says otherwise.',
    '2. ARM A (UB2.8): create a task whose CURRENT step asks the agent a question that needs the user (e.g. the step prompt requests a clarification mid-turn). Start the step; while its turn runs, press Stop. EXPECT: the run moves to needs-review with `node-waiting {reason:\'stopped\'}` in the host log, the node is NOT failed and NOT re-dispatched, and no verdict re-ask fires even when the step was in its verify turn (the verdict listener ignores `interrupted`/`timeout`). Then send a plain message ANSWERING what the step asked (e.g. the clarified value). EXPECT: the SAME node completes with the user\'s reply as its output (`fromUser` on the completion event), and the run proceeds. CONTROLS: (a) a HOST interruption with no user behind it (restart the server mid-step) keeps item 9\'s pause — the step waits, needs-review, and does NOT treat the restart as the user\'s answer; (b) a step whose completing turn returns an EMPTY reply fails the node (retry policy applies). POSITIVE CONTROL for the detector: an UNSTOPPED step completes and moves the run on (proves the rig can see completion at all).',
    '3. ARM B (UB2.9): on a real task with several subtasks, open the task editor and run Generate subtasks where the authoring turn takes longer than 180 s of CONTINUOUS activity (a workspace whose generator prompt yields a long draft; or a deliberately large task). EXPECT: the generation COMPLETES with subtasks written — no 180 s timeout, no repair turn from `\'\'`. DETECTOR: the host log\'s generate-turn record (activity timestamps; the completion, not an idle-stall). CONTROLS: (a) an authoring turn that goes truly IDLE (block the model connection mid-generate) rejects as stalled at ~90 s and is NOT repaired from an empty reply; (b) an `interrupted` authoring turn (Stop during generate) rejects at once. If the rig cannot make a >180 s authoring turn honestly, record the arm\'s verdict from the controls plus the unit pin (tasks-generate-wait.test.ts) and say so in the checklist row.',
    '4. ARM C (UB2.10, Pi gateway card, the MEASUREMENT arm): start a turn whose agent calls the slow MCP tool (past the R10 detach threshold — the call detaches from the turn). While the detached call is running, press Stop. EXPECT after the fix: the turn ends, and the detached call\'s RESULT still arrives afterwards (the host records it against the task) — Stop ended only the reply. THE RECORD TO READ: the MCP task notification the host logs — a `mcp-background-task-stopped` notification arriving from the TURN STOP ALONE is the pre-fix shape persisting: record it, it is a finding that flips UB2.10\'s cell, not a pass. A silent kill (no result, no notification) is the CRITICAL shape. THE CONTROL (can fail): in the SAME turn (or a sibling turn) a background SUBAGENT started before the Stop completes after it — it runs on its own AbortController, so its completion proves the rig can observe survival. Then the explicit-stopping seam: `/workflows stop` against a detached call EXPECTS `mcp-background-task-stopped` (the stopping seam still reaches what the Stop sweep cannot).',
    '5. ARM D (UB2.11, claude-gateway card): attach a rig-made ~15 MB PDF to a message asking one question about its content. EXPECT: the turn answers from the STORED PATH — the runtime debug log\'s request record carries the path text plus the cannot-inline note (and NO base64 `document` block), and the gateway request body stays far below the attachment\'s size. CONTROLS: (a) a small (~2 MB) PDF on the SAME claude-gateway card also goes by path (the translated-route gate, not the size gate); (b) on a DIRECT Anthropic card (if the rig has one) the same 2 MB PDF goes INLINE (the size gate working where the route does not bind) — if no direct card exists, record the control as not drivable and lean on the unit pin (the pdf-inline tests).',
    '6. Verdict per arm, recorded in the checklist rows the controller writes: A passes when the stopped step waited (needs-review, no re-dispatch, no re-ask) and the answering turn completed it with the reply, both controls holding; B passes when generation survived a >180 s active turn with the idle and interrupt controls rejecting; C passes when the detached call survived the Stop WITH a notification (or its result) and the subagent control completed, `/workflows stop` still stopping it; D passes when the 15 MB PDF answered from the stored path with the route control (and the inline control where drivable).',
  ],
  expected:
    'Arm A: a stopped task step waits in needs-review with the node alive, and the user\'s next answering turn completes that node with the reply; a host interruption pauses without becoming an answer; an empty reply fails. Arm B: subtask generation survives a continuously-active >180 s authoring turn; a genuinely idle one stalls at ~90 s and an interrupted one rejects at once. Arm C: a detached Pi MCP call delivers its result after a turn Stop, a background subagent completes through the same Stop, and /workflows stop still stops a detached call (its stopped notification). Arm D: a 15 MB PDF on claude-gateway answers from the stored path with the note, the gateway body stays small, and a 2 MB PDF takes the same route there while going inline on a direct card.',
  detector:
    'Product-written records: the host log\'s `node-waiting`/completion records and the completion event\'s `fromUser` (arm A), the generate-turn activity/completion record (arm B), the MCP task notification `mcp-background-task-stopped` vs the result and the subagent\'s own completion (arm C), and the runtime debug log\'s request record showing path-plus-note and the absence of a base64 document block (arm D). Never model prose alone.',
  positiveControl:
    'Per arm: A — an unstopped step completes and advances the run (the rig sees completion); B — a short generation completes normally through the same reader; C — the subagent control completes through the Stop (survival is observable); D — the 2 MB PDF control proves the reader distinguishes route classes, not just sizes.',
  runOnlyIf:
    'Arm A/B: UB2.8/UB2.9 in the build and a workspace with tasks. Arm C: UB2.10 in the build, the Pi gateway card, and a rig-controlled slow MCP tool; without the slow tool the arm BLOCKS (it is the measurement, not a smoke). Arm D: UB2.11 in the build and the claude-gateway card; the direct-card control is best-effort.',
  doneMeans:
    'UB2.12\'s checklist row (the controller\'s) carries verdicts: the stopped-step drive with its two controls, the generate drive with its stall/interrupt controls, the detached-call Stop measurement with the subagent control and the /workflows stop seam, and the stored-path PDF drive with the route control — in the packaged sitting. Arm C doubles as UB2.10\'s [measure] verdict; arms A and B double as UB2.8/UB2.9\'s live halves.',
  doNotConflate:
    'Arm A\'s pass is the SAME node completing — a Resume that re-dispatches the step into a NEW child is the pre-fix defect, not a pass, even if the run eventually finishes. Arm B\'s >180 s must be ACTIVITY, not wall-clock idling (an idle turn rejecting at 90 s is the control, not a failure of the cap). Arm C: the survival evidence is the RESULT after the Stop — `mcp-background-task-stopped` from the turn stop alone is the finding, while the SAME notification from an explicit `/workflows stop` is that seam working; the two must not be read as the same event. Arm D: the note text in the request record is the detector — an answer that quotes the PDF without the path-plus-note record may be reading a stale inline cache; re-run before passing.',
  safety:
    'All arms run on rig-owned tasks, sessions and workspaces. Arm C\'s MCP tool is a rig-controlled sleep/read tool — never a real write; the CRITICAL shape it exists to measure is about MECHANICS (a Stop cancelling a detached write), so the drill uses a read tool and records what the mechanics would do. The PDF is a rig-made file; no key or token is ever read or printed.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
