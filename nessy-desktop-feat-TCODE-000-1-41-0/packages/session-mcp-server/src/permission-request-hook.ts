/**
 * F1.386 (DECIDED 2026-09-23, owner posture under delegation) — the HOST-AUTHORED
 * `PermissionRequest` hook codex runs before its auto-review reviewer, so the
 * unattended-automation floor fails CLOSED while auto-review is on.
 *
 * ## Why a hook, and why before the reviewer
 *
 * Read at `openai/codex@rust-v0.154.0` (`packages/codex-protocol/manifest.json`):
 * `core/src/tools/approvals.rs` `Session::request_approval` orders "1. Hooks
 * 2. If StrictAutoReview || Guardian enabled, then Guardian. Else, user." — so
 * with `approvals_reviewer = "auto_review"` the reviewer answers the session
 * tool's approval and the host's F1.113/F1.227 floor never sees the call. A
 * `PermissionRequest` hook is the one thing codex asks FIRST, and
 * `hooks/src/events/permission_request.rs` folds hook decisions "any deny wins,
 * otherwise the last allow wins, otherwise there is no hook verdict". The call
 * reaches the hook as the MCP tool call's own arguments (`tool_input`), the same
 * fields `findUnattendedAutomationEdit` reads on every other runtime.
 *
 * ## The contract with codex, chosen for the failure direction
 *
 * - A FLOORED edit (an automation whose stored mode is above the model-facing
 *   ceiling, and whose actions or schedule the call changes): exit **2** with the
 *   reason on stderr. The event's parser turns "exit 2 + non-empty stderr" into
 *   `PermissionRequestDecision::Deny { message }` whatever stdout holds — and
 *   codex runs the command through `$SHELL -lc`, whose login profile may write
 *   to stdout, so the JSON-on-stdout form could be spoiled where exit 2 cannot.
 * - Anything else: exit **0**, nothing written — "no hook verdict", and the
 *   reviewer answers as before.
 * - A hook that cannot run (a crash, a timeout) is codex's "failed" status, which
 *   also carries no verdict — so the reviewer answers. That is today's posture,
 *   stated rather than hidden: the floor fails closed when the hook RUNS.
 *
 * The posture matches the one the same floor already takes on an UNATTENDED
 * turn (`CodexAgent.unattendedAutomationEditFloor`): a change to what an
 * automation that runs with nobody watching does, or when it runs, is refused
 * when no person can be asked.
 *
 * ## The session's mode, and who the refusal names (F1.532)
 *
 * `bypassPermissions` skips the floor on every runtime — the host's own floor
 * (`unattendedAutomationEditFloor` returns null there) and the Pi/claude gate
 * alike — so in bypass this hook gives no verdict too. It cannot learn the mode
 * from codex: the payload's `permission_mode` is `hook_permission_mode`
 * (`core/src/hook_runtime.rs`, `rust-v0.154.0`), which says `bypassPermissions`
 * only for approval policy `never`, and bypass runs on `on-request` here. So the
 * host writes a state file (`automation-floor-hook.ts`
 * `codexAutomationFloorHookState`), names it on this command line
 * (`--state-file`), and rewrites it on every mode change and before every turn —
 * a mode change does not respawn codex (P6.223). F1.609 — this hook trusts that
 * file only because of WHERE it is: a per-build directory under the host's config
 * directory, named only when no root the session's codex profile lets an agent
 * command write covers it (`CodexAgent.newFloorHookStateFile`). It used to be the
 * runtime's `CODEX_HOME`, a `mkdtemp` under `$TMPDIR` that an agent command writes
 * with no card, so one `printf` turned this floor off. A missing,
 * unreadable or other-shape file keeps the floor: the hook fails closed on its
 * own input, as it does today. The same file says whether an administrator's
 * `allowed_approvals_reviewers` requires the reviewer (F1.514); then the refusal
 * names that policy, because "turn auto-review off" is not a remedy it allows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findUnattendedAutomationEdit } from '@nessy-agent/session-tools-core';

/** The argv flag that selects this mode instead of the MCP server. */
export const PERMISSION_REQUEST_HOOK_FLAG = '--permission-request-hook';

/**
 * F1.532 — the argv flag naming the host's state file. Spelled again in
 * `shared/src/agent/backend/codex/automation-floor-hook.ts`
 * (`CODEX_AUTOMATION_FLOOR_HOOK_STATE_FLAG`); `permission-request-hook-mode.test.ts` pins the two equal.
 */
export const PERMISSION_REQUEST_HOOK_STATE_FLAG = '--state-file';

/** Both spellings the call can carry — codex's hook name and the bare tool name. */
const AUTOMATION_UPDATE_TOOLS = new Set(['mcp__session__automation_update', 'automation_update']);

/** `automations.json`, the file `findUnattendedAutomationEdit`'s stored side is read from. */
const AUTOMATIONS_FILE = 'automations.json';

/** F1.532 — what the host's state file says (`codexAutomationFloorHookState`, `v: 1`). */
export interface PermissionRequestHookState {
  permissionMode: string;
  reviewerRequiredByPolicy: boolean;
  /**
   * F1.781 — `false` only when the host wrote `reviewerAnswers: false`: the user turned Codex
   * auto-review off in a live session, so codex asks the host and the host's own floor cards a person.
   * Any other value (the field absent included) keeps the floor.
   */
  reviewerAnswers: boolean;
}

/**
 * F1.532 — the host's state file, or `null` for no path, a missing or unreadable
 * file, or any shape but `v: 1` with a string mode. `null` keeps the floor.
 */
export function readPermissionRequestHookState(path: string | undefined): PermissionRequestHookState | null {
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1 || typeof parsed.permissionMode !== 'string') return null;
    return {
      permissionMode: parsed.permissionMode,
      reviewerRequiredByPolicy: parsed.reviewerRequiredByPolicy === true,
      reviewerAnswers: parsed.reviewerAnswers !== false,
    };
  } catch {
    return null;
  }
}

/**
 * The deny reason for one hook payload, or `null` for no verdict. Pure over the
 * payload and one file read; a payload, a file or a patch it cannot read answers
 * `null`, because the tool's own handler then refuses the call itself
 * ("Automation not found") and nothing is changed. F1.532 — under an
 * administrator policy that requires the reviewer the sentence names the policy
 * and a remedy the user has, never the Settings toggle.
 *
 * F1.516 (3) — `reviewerRequiredByPolicy` is three-valued: `true` and `false`
 * come from the host's state file, and `undefined` means the hook could not read
 * one (it then keeps the floor), so it does not know WHO turned the reviewer on.
 * That sentence says both, in the words F1.514 gave the two session-facts
 * notices, with a remedy true under either.
 */
export function permissionRequestHookDenial(
  payload: unknown,
  workspaceRoot: string,
  options: { reviewerRequiredByPolicy?: boolean } = {},
): string | null {
  const request = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const toolName = typeof request.tool_name === 'string' ? request.tool_name : '';
  if (!AUTOMATION_UPDATE_TOOLS.has(toolName)) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(join(workspaceRoot, AUTOMATIONS_FILE), 'utf-8'));
  } catch {
    return null;
  }
  const edit = findUnattendedAutomationEdit(request.tool_input, stored);
  if (!edit) return null;
  const label = edit.name ? `"${edit.name}" (${edit.automationId})` : edit.automationId;
  const refused = `this change to the automation ${label} (${edit.changes.join(', ')}) is `
    + `refused rather than reviewed: it runs unattended in ${edit.permissionMode} mode, and a change to what it `
    + 'does or when it runs needs a person.';
  if (options.reviewerRequiredByPolicy === true) {
    return `Your organisation's Codex policy (allowed_approvals_reviewers) has Codex's auto-review reviewer answer `
      + `approvals, so ${refused} Make the change yourself in the automation's configuration instead.`;
  }
  if (options.reviewerRequiredByPolicy === false) {
    return `Codex auto-review is on, so ${refused} Turn Codex auto-review off to be asked instead.`;
  }
  return `Codex auto-review is on (in Settings, or required by your organisation's policy), so ${refused} `
    + 'Make the change yourself in the automation\'s configuration, or turn Codex auto-review off in Settings '
    + 'where your organisation\'s policy allows it.';
}

/**
 * The whole hook: read the payload from stdin, answer through the exit code.
 * `--workspace-root <path>` names the workspace whose `automations.json` is the
 * stored side; `--state-file <path>` (F1.532) the host's record of the session's
 * mode. Returns the exit code rather than exiting, so it is testable.
 */
export function runPermissionRequestHook(
  argv: readonly string[],
  stdinText: string,
  writeStderr: (text: string) => void,
): number {
  const rootAt = argv.indexOf('--workspace-root');
  const workspaceRoot = rootAt >= 0 ? argv[rootAt + 1] : undefined;
  if (!workspaceRoot) return 0;
  const stateAt = argv.indexOf(PERMISSION_REQUEST_HOOK_STATE_FLAG);
  const state = readPermissionRequestHookState(stateAt >= 0 ? argv[stateAt + 1] : undefined);
  if (state?.permissionMode === 'bypassPermissions') return 0;
  if (state?.reviewerAnswers === false) return 0; // F1.781 — the reviewer is off live: the host is asked and floors itself
  let payload: unknown;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    return 0;
  }
  const denial = permissionRequestHookDenial(payload, workspaceRoot, { reviewerRequiredByPolicy: state?.reviewerRequiredByPolicy });
  if (!denial) return 0;
  writeStderr(`${denial}\n`);
  return 2;
}
