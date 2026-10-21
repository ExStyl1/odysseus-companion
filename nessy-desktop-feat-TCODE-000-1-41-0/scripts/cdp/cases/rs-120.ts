/**
 * RS-120 (F1.748) — the C24 re-drive: a model switch against a pending card with
 * NO host turn, on claude-gateway in `default`, plus the setSessionModel IPC arm.
 *
 * ## The row
 *
 * F1.748 (origin: the 1.41.0 release sitting, lane SIT-h, packaged `5896a66d2`,
 * 2026-09-25) carries two claims. The first is C24's premise about the
 * model-switch trigger: the plan expected a pending card to close "…because the
 * session's agent runtime was shut down" when the model switches; SIT-h observed
 * the card stay up >3 min across deepseek→qwen36→deepseek with no dispose,
 * respawn or shutdown line, and read that as "the check's model-switch trigger
 * may be a plan premise error rather than a product defect". The second is the
 * `session:setModel` IPC answering `Request timeout (30000ms)` although the
 * switch lands — which the row itself files under the F1.212 family (the
 * renderer's 30 s RPC budget vs a loaded host).
 *
 * ## The measured answer (RC4, 2026-10-11, lane L5F2, port 9342)
 *
 * **Correction (same lane, later the same sitting, found while driving F1.749):** the
 * reading first recorded here was taken on a session that NEVER switched its card —
 * freshSession binds the profile's default connection (pi), and the drive script's
 * `"runtime":"pi"` markers in the host transcript prove it measured PI, not claude.
 * The arms were re-driven on a session bound to claude-gateway (switchRuntime + the
 * bound-connection read-back, `work/sitting7/L5F2/f1749-claude-reading.json`, session
 * B, mode `default` read back) and BOTH findings below held on claude: the card
 * survived two landed switches plus the 3-minute watch with count 1 and no
 * dispose/respawn line, and the switches answered fast (263 ms / 397 ms, no 30 s
 * timeout). The steps, controls and detector are unchanged by the correction; the
 * recipe's step 1 now says what the first drive missed — record the BOUND CONNECTION,
 * never the requested one.
 *
 * Driven on the packaged 1.42.0 RC4 (`b72bb163d`): the FIRST drive (pi by the rig
 * error above, `work/sitting7/L5F2/f1748-reading.json`) and the claude RE-DRIVE
 * (`work/sitting7/L5F2/f1749-claude-reading.json`, session B, claude-gateway, mode
 * `default` read back) both read:
 *
 * - **The C24 shape was reached deterministically**: a background subagent's Bash
 *   card (one `echo` write outside the workspace) up at `awaitingApprovalCount: 1`
 *   with the host reading `isProcessing: false`.
 * - **The switch does NOT decline the card — SIT-h reproduces**: two switches
 *   (deepseek→qwen36-35b→deepseek), each landing (read back), left the card up
 *   through both and a 3-minute 20 s-poll watch (count 1, banner present, tail
 *   23:38:32→23:39:32); the app log (NESSY_DEBUG=1) carries ZERO
 *   dispose/respawn/"runtime was shut down" lines. The card stayed honest and
 *   answerable — the lane's cleanup click cleared it (count 0) — so the severity
 *   stays NON-CRITICAL and C24's model-switch premise stays WRONG on claude.
 * - **The IPC timeout did NOT reproduce on a quiet rig**: both switches answered
 *   without error in 169 ms and 187 ms. Consistent with the row's own filing: the
 *   30 s timeout is a loaded-host reading (F1.212 family), not a property of the
 *   call.
 * - The plugin-toggle trigger (which runs the runtime refresh) is STILL unmeasured
 *   — the profile carries no plugin, exactly as in the origin.
 *
 * What this recipe adds is the re-drive on the next build: same four steps, same
 * two controls.
 */

import type { CaseMeta, SittingRecipe } from '../lib/sitting.ts'

const ID = 'RS-120'
const TITLE =
  'does a model switch decline a permission card that is up while no host turn runs (claude, default mode), and does setSessionModel time out'

export const meta = {
  id: ID,
  title: TITLE,
  row: 'F1.748',
  runtimes: ['claude'],
  credentials:
    'owner: the Claude Code (Nessy Gateway) one-click card. No key, token or credential file is read. '
    + 'The session is set to `default` and the mode is read back — the card is the subject.',
} as const satisfies CaseMeta

export const manual = {
  steps: [
    '1. Launch the PACKAGED build (scripts/cdp/README.md\'s env -u launcher, NESSY_DEBUG=1 so the host log captures dispose lines). FreshSession on the claude-gateway card, setPermissionMode(\'default\') and READ THE MODE BACK — an arm run in bypass is invalid (a failed freshSession fallback silently sets bypass).',
    '2. THE CONTROL, FIRST: seed one harmless turn and read the card\'s models (`listLlmConnections` → the claude row\'s `models`, current via `getSessionModel`) — the switch needs a second model to land on, and a single-model card degenerates the arm into a no-op.',
    '3. THE C24 SHAPE: prompt the main agent to start exactly one BACKGROUND subagent whose only action is a shell write outside the workspace (e.g. `mkdir -p /tmp/<marker> && echo … > /tmp/<marker>/marker.txt`), then finish its own turn. Poll `getSessions()` until `awaitingApprovalCount >= 1` AND `isProcessing === false` — the card the host does not associate with a turn. A card that only ever appears mid-turn (isProcessing true) is a DIFFERENT shape; say so rather than measuring it as this one.',
    '4. THE SWITCHES: without answering the card, call `setSessionModel(sessionId, workspaceId, <other model>)` to the second model and back. Per call record: wall time, the thrown error if any (`Request timeout: session:setModel (30000ms)` is the row\'s second claim), and `getSessionModel` AFTER the throw — a timeout that still landed is exactly the F1.212 family shape.',
    '5. THE WATCH: poll every 20 s for >3 min — `awaitingApprovalCount`, the `[data-tutorial="permission-banner"]` presence, and any transcript rows the switch added. A decline would close the card with "…because the session\'s agent runtime was shut down"; grep the app stdout for dispose/respawn/shutdown lines across the whole window.',
    '6. CLEANUP: answer the card (the banner\'s second button denies when the deny one is unnamed), assert the count is 0, then stop the app by TERM.',
    '7. Verdict: a card that stays up across both switches with no dispose line CONFIRMS "the model-switch trigger does not decline pending cards on claude" (the plan-C24 premise is wrong — plan-text, not a product fix); a timeout beside a landed model read reproduces the IPC arm only under load — record the machine\'s load beside it.',
  ],
  expected:
    'Per the re-drive: the card survives both model switches with the count and banner unchanged for the whole watch and no dispose/respawn line (C24\'s model-switch closure premise is wrong on claude), while each switch lands (model read back) and answers fast on a quiet machine; the card stays answerable throughout (cleanup clears it).',
  detector:
    '`getSessions()` for `awaitingApprovalCount`/`isProcessing`/`permissionMode` (the shape and the survival), '
    + '`[data-tutorial="permission-banner"]` for the card on screen, `getSessionModel` for what landed after each '
    + 'call, the CDP-eval error text for the 30 s IPC timeout, and the app\'s own stdout (NESSY_DEBUG=1) for the '
    + 'absence of dispose/respawn/"runtime was shut down" lines — never the DOM alone: an innerText read taken the '
    + 'moment the banner mounts returns \'\' (the card is h-full in a pane that sizes later).',
  positiveControl:
    'Two: (1) the mode read-back BEFORE the arm — a card arm in bypass measures nothing because bypass never '
    + 'asks, so a run whose session is not in `default` is invalid rather than negative; (2) the switch must LAND '
    + '(`getSessionModel` returns the new id) — without that, "the card stayed up" and "the switch never happened" '
    + 'are the same reading. The cleanup answer at the end is the third: a card that cannot be cleared is a '
    + 'different (CRITICAL) finding than one that merely survives a switch.',
  doneMeans:
    'the F1.748 row carries both RC4 verdicts: whether the model-switch trigger declines a pending no-turn card '
    + '(plan-premise reading, NOT a product defect while the card stays answerable) and whether setSessionModel '
    + 'times out while landing (F1.212 family, load-dependent — the quiet-machine number recorded beside it).',
  doNotConflate:
    'A card up MID-TURN (isProcessing true) is not the C24 shape — the row is about the card the host does not '
    + 'associate with a running turn. And "the switch did not decline the card" is not "the card is stuck": the '
    + 'row\'s own severity is NON-CRITICAL precisely because the card stays honest and answerable — measure the '
    + 'cleanup, never assume it.',
} as const satisfies SittingRecipe

if (import.meta.main) console.log(JSON.stringify({ meta, manual }, null, 2))
