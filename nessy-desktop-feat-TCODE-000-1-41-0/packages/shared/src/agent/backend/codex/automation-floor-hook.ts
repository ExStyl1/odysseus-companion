/**
 * F1.386 (origin the WJ-hh verifier on F1.233, "F1.233-b"; DECIDED by the
 * controller 2026-09-23, owner posture under delegation) — the ONE hook the
 * host authors into codex's own `[hooks]` table: a `PermissionRequest` hook
 * that makes the unattended-automation floor fail CLOSED while codex's
 * auto-review reviewer is on.
 *
 * ## Why codex needed one, read at `rust-v0.154.0`
 *
 * `core/src/tools/approvals.rs` `Session::request_approval`: "Approval
 * precedence is: 1. Hooks 2. If StrictAutoReview || Guardian enabled, then
 * Guardian. Else, user." With `approvals_reviewer = "auto_review"` the reviewer
 * answers the session tool's approval and `CodexAgent`'s F1.113/F1.227 floor —
 * which lives on the "user" arm — never sees `automation_update`, so a change to
 * what an automation that runs with nobody watching does, or when it runs, was
 * the reviewer's to approve. A hook is the one step codex takes BEFORE the
 * reviewer, and `hooks/src/events/permission_request.rs` folds the verdicts "any
 * deny wins". The hook's own contract (exit 2 + reason on stderr to deny,
 * exit 0 and silence for no verdict) is `session-mcp-server`'s
 * `permission-request-hook.ts`, the command below.
 *
 * ## The two halves this module owns
 *
 * - {@link codexAutomationFloorHookPlan} mints the plan through the ONE door
 *   (`mintHostAuthoredCodexHooks`, P2.414): host-authored content only, and
 *   the revocation answer is `next-runtime-build` — `config.toml` is read when
 *   the app-server starts, so the switch is the next runtime build, and turning
 *   auto-review off is what stops projecting it.
 * - {@link trustCodexHostAuthoredHooks} is the TRUST pass P2.414's docblock owed
 *   and nobody had built, in ONE boot. MEASURED on the shipped binary
 *   2026-09-24 (`work/wjrr/probe/hook-trust-batchwrite.ts`): after
 *   `initialize`, `hooks/list` answers the projected entry `untrusted` with the
 *   key and `currentHash` the binary computed; `config/batchWrite` of
 *   `hooks.state."<key>" = { enabled = true, trusted_hash = <hash> }` with
 *   `reloadUserConfig: true` answers `status: "ok"`, and a second `hooks/list`
 *   answers the same entry `trusted`, with no `configWarning` — so no second
 *   boot. It trusts only a `permissionRequest` command entry whose command line
 *   is EXACTLY one this host minted, so no user-, project- or plugin-authored
 *   hook can ride it.
 *
 * ## What still fails OPEN, stated
 *
 * A hook codex cannot run (the command missing, a crash, a timeout) is codex's
 * `failed` status with no verdict, and a trust pass that did not complete
 * leaves the entry inert: in both cases the reviewer answers the edit, which is
 * the posture before this row. The trust half is said on the session-facts
 * channel ({@link CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE}); the per-call
 * half (F1.482 (3)) is said on the turn that met it
 * ({@link CODEX_AUTOMATION_FLOOR_HOOK_FAILED_NOTICE}), beside codex's own
 * "Hook … failed" line. Read at `rust-v0.154.0`,
 * `hooks/src/events/permission_request.rs` `parse_completed`: a run `error`
 * (spawn failure, "hook timed out after {N}s", a failed stdin write), an exit
 * other than 0 or 2, an exit 2 with no stderr, and invalid JSON are each
 * `HookRunStatus::Failed` with an `Error` entry and NO decision, and
 * `resolve_permission_request_decision` then returns `None` — "decline to
 * decide and let the normal approval flow continue".
 */
import {
  mintHostAuthoredCodexHooks,
  type CodexHostAuthoredHooksPlan,
} from '@nessy-agent/codex-responses-adapter/config-writer';
import { mintHostOwnedDir } from './host-owned-dirs.ts';
import { bunProjectIsolationArgs } from '../../bun-project-isolation.ts';

/**
 * The argv flag that turns the session MCP server's entry point into the hook.
 * Spelled again in `session-mcp-server/src/permission-request-hook.ts`
 * (`PERMISSION_REQUEST_HOOK_FLAG`), which cannot import this module without
 * pulling the config writer into its bundle; that package's test pins the two
 * spellings equal.
 */
export const CODEX_AUTOMATION_FLOOR_HOOK_FLAG = '--permission-request-hook';

/**
 * The hook's matcher: codex's own name for the session tool. A regex over the
 * hook tool name (`core/src/tools/handlers/mcp.rs` `hook_tool_name`), anchored
 * so a pool tool that happens to end in the same words is not matched — the
 * command re-checks the name anyway.
 */
export const CODEX_AUTOMATION_FLOOR_HOOK_MATCHER = '^mcp__session__automation_update$';

/**
 * F1.1200 — WHEN codex's reviewer answers, as the code decides it since F1.1169: Auto and Bypass permissions with
 * the Settings toggle on ({@link codexModeHandsApprovalsToReviewer}), every mode under an administrator list that
 * leaves out `user` ({@link codexFloorHookReviewerAnswers}'s `requiredByPolicy`). Shared by the three notices below.
 */
const CODEX_REVIEWER_ANSWERS_WHEN = 'while Codex\'s auto-review reviewer answers this session\'s approvals (in Auto'
  + ' and Bypass permissions with auto-review on in Settings, or in every mode when your organisation\'s policy'
  + ' requires the reviewer)';

/** What a session with the hook projected says about codex's `[hooks]` table. */
export const CODEX_AUTOMATION_FLOOR_HOOK_NOTICE =
  `[codex-hooks] one host-authored hook is projected into codex's own [hooks] table: ${CODEX_REVIEWER_ANSWERS_WHEN},`
  + ' a PermissionRequest hook refuses a change to what an'
  + ' unattended automation does or when it runs, before the reviewer is asked (F1.386, F1.514) — except in'
  + ' bypassPermissions, which skips that floor on every runtime (F1.532). In Manual and Accept edits with no such'
  + ' policy the reviewer is not asked: the hook steps aside and the app shows you a card (F1.1169). Your user- and'
  + ' plugin-authored hooks are NOT projected here: their content is not ours. They still run host-side, on the'
  + ' events this runtime emits.';

/**
 * What a session says when the hook was projected but is not live after the trust pass. F1.553 — it claims
 * no cause: {@link trustCodexHostAuthoredHooks} returns 0 alike when `hooks/list` does not report the hook
 * (codex did not load it — `allow_managed_hooks_only` is the measured case), when it stays untrusted after
 * `config/batchWrite`, and when the pass throws. Only a requirements read that answers can name the policy
 * ({@link CODEX_AUTOMATION_FLOOR_HOOK_MANAGED_ONLY_NOTICE}); one that fails leaves this sentence standing.
 */
export const CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE =
  '[codex-hooks] the unattended-automation floor hook was not found or could not be trusted in codex this runtime'
  + ` build, so ${CODEX_REVIEWER_ANSWERS_WHEN} its reviewer`
  + ' answers changes to unattended automations (F1.386).';

/**
 * F1.516 (1) (origin WJ-an P-WJ-an-1) — what a session says when an administrator's
 * `allow_managed_hooks_only` keeps codex from loading the hook. Measured on the shipped binary at
 * `rust-v0.154.0` and `rust-v0.156.1` (WJ-ag's MDM rig, `work/wjaz/f1516-probe.ts`): `hooks/list` then
 * reports no hook and no warning, and the trust pass trusts nothing — codex loads hooks only from its
 * managed layers under that requirement (`hooks/src/engine/discovery.rs`, `HookDiscoveryPolicy::allows`),
 * and this app writes codex's USER layer. The trust pass runs before the requirements probe, so it can
 * only say {@link CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE}; this replaces it once the probe has read
 * the cause.
 */
export const CODEX_AUTOMATION_FLOOR_HOOK_MANAGED_ONLY_NOTICE =
  '[codex-hooks] your organisation\'s Codex policy (allow_managed_hooks_only) lets codex run only hooks the'
  + ' organisation manages, so the unattended-automation floor hook this app writes does not run in this session:'
  + ` ${CODEX_REVIEWER_ANSWERS_WHEN} its reviewer answers`
  + ' changes to what an unattended automation does or when it runs (F1.386, F1.516).';

/**
 * F1.516 (1) — does a `configRequirements/read` result carry `allowManagedHooksOnly: true`? It is on the wire
 * (the field is not one of the four ts-rs drops); anything but a literal `true` reads as not set.
 */
export function codexRequirementsAllowManagedHooksOnly(result: unknown): boolean {
  const requirements = (result as { requirements?: unknown } | null | undefined)?.requirements;
  return (requirements as { allowManagedHooksOnly?: unknown } | null | undefined)?.allowManagedHooksOnly === true;
}

/**
 * F1.532 — the argv flag naming the hook's STATE FILE, which tells it the session's permission mode
 * and whether an administrator's `allowed_approvals_reviewers` requires the reviewer. Spelled again in
 * `session-mcp-server/src/permission-request-hook.ts` (`PERMISSION_REQUEST_HOOK_STATE_FLAG`), pinned
 * equal by that package's `permission-request-hook-mode.test.ts`.
 *
 * Why a file the host rewrites, and not the command line or the payload: a mode change does not
 * respawn codex (P6.223), so `config.toml` — this command line included — keeps the mode it was
 * built with; and codex's own payload field cannot say bypass here, because `hook_permission_mode`
 * (`core/src/hook_runtime.rs`, read at `rust-v0.154.0`) answers `bypassPermissions` only for approval
 * policy `never`, while this host runs bypassPermissions on `on-request` (`CODEX_PERMISSION_MODE_TABLE`).
 * F1.609: never in `CODEX_HOME` (under `$TMPDIR`, agent-writable); see `CodexAgent.newFloorHookStateFile`.
 */
export const CODEX_AUTOMATION_FLOOR_HOOK_STATE_FLAG = '--state-file';

/** F1.532 — the state file's name inside its runtime build's own state directory (F1.609). */
export const CODEX_AUTOMATION_FLOOR_HOOK_STATE_FILE = 'nessy-automation-floor-state.json';

/**
 * F1.654 — the prefix of each runtime build's own state directory under the state root, and its mint:
 * `build-<pid>-XXXXXX`, after removing the ones a host process no longer running left behind (a crash
 * runs no teardown). The sweep's rules and residue are {@link mintHostOwnedDir}'s.
 */
export const CODEX_AUTOMATION_FLOOR_HOOK_STATE_BUILD_PREFIX = 'build-';
export function mintCodexFloorHookStateBuildDir(stateRoot: string, debug?: (line: string) => void): string {
  return mintHostOwnedDir(stateRoot, CODEX_AUTOMATION_FLOOR_HOOK_STATE_BUILD_PREFIX, 'floor-hook state directories', debug);
}

/**
 * F1.532 — the state file's text, the one shape the hook reads (`v: 1`). A missing file, unreadable
 * JSON or any other shape keeps the floor: the hook fails closed on its own input.
 *
 * F1.781 — `reviewerAnswers: false` is written only when codex's reviewer no longer answers this
 * session's approvals ({@link codexFloorHookReviewerAnswers}); the hook then gives no verdict, and the
 * host's own floor (`CodexAgent.unattendedAutomationEditFloor`) cards a person. Left out otherwise, so
 * a session whose reviewer still answers writes F1.532's text byte for byte.
 */
export function codexAutomationFloorHookState(
  permissionMode: string,
  reviewerRequiredByPolicy: boolean,
  reviewerAnswers = true,
): string {
  return JSON.stringify({ v: 1, permissionMode, reviewerRequiredByPolicy, ...(reviewerAnswers ? {} : { reviewerAnswers: false }) });
}

/**
 * F1.781 — does codex's reviewer still answer this session's approvals, with the Settings toggle
 * re-read NOW rather than at the runtime build? The floor hook is projected at the build when it will
 * (`CodexAgent.unattendedAutomationFloorHookProjection`), but a mode change or a Settings change does
 * not respawn codex, and turning auto-review OFF reaches the live session: every turn then asks for
 * `'user'` (`codexTurnApprovalsReviewer`), so this host is asked and the hook must step aside. An
 * administrator list that leaves out `user` keeps the reviewer whatever the toggle says
 * (`requiredByPolicy`); one that leaves out `auto_review` never hands it the approvals.
 */
export function codexFloorHookReviewerAnswers(
  requiredByPolicy: boolean,
  configured: 'auto_review' | undefined,
  settingOn: boolean,
  allowed: readonly string[] | undefined,
): boolean {
  if (requiredByPolicy) return true;
  return configured === 'auto_review' && settingOn && (allowed === undefined || allowed.includes('auto_review'));
}

/**
 * F1.1169 (controller decision 2026-09-29, `donow/DECISIONS-2.md`) — the modes in which codex's auto-review
 * reviewer answers what codex raises: Auto, Claude's "Everything, with background safety checks"
 * (permission-modes.md, "Available modes"; MODES-SPEC: `approvals_reviewer=auto_review` for Auto where the operator
 * enabled it), and Bypass permissions as the operator's explicit safety net (Pi's Guardian keeps its deny-net
 * there). Every other mode sends codex's approvals to this host: Manual and Accept edits card the user, Plan and
 * Don't ask refuse (F1.373, F1.1056). One predicate, read by `codexTurnApprovalsReviewer` for the turn's
 * `approvalsReviewer` and by `CodexAgent.writeFloorHookState` for the hook, so the two cannot disagree about who
 * answers. An administrator list that leaves out `user` still decides above it.
 */
export function codexModeHandsApprovalsToReviewer(mode: string): boolean {
  return mode === 'auto' || mode === 'bypassPermissions';
}

/** POSIX single-quoting — the hook runs through `$SHELL -lc` (`hooks/src/engine/command_runner.rs`). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact command line the hook runs; F1.532 — with the state file when the runtime build has one.
 *
 * F1.1066 — codex runs it in the request's cwd, the session folder (`hooks/src/engine/command_runner.rs`
 * `run_command`, `current_dir(cwd)`, at rust-v0.156.1), so a Bun runtime gets
 * {@link bunProjectIsolationArgs} in front of the entry point: without them that folder's `.env` files
 * reached the hook and its `bunfig.toml` preload ran first. Bun consumes both switches, so the hook's
 * own argv is unchanged. The trust pass reads this same string, so the two cannot drift.
 */
export function codexAutomationFloorHookCommand(node: string, sessionServer: string, workspaceRoot: string, stateFile?: string): string {
  return [
    node, ...bunProjectIsolationArgs(node), sessionServer, CODEX_AUTOMATION_FLOOR_HOOK_FLAG, '--workspace-root', workspaceRoot,
    ...(stateFile ? [CODEX_AUTOMATION_FLOOR_HOOK_STATE_FLAG, stateFile] : []),
  ].map(shellQuote).join(' ');
}

/** The minted plan: one `PermissionRequest` group, one handler. */
export function codexAutomationFloorHookPlan(
  node: string,
  sessionServer: string,
  workspaceRoot: string,
  /** Seconds; the packaged session server is one bundled file, so the default is generous. */
  timeoutSec = 30,
  /** F1.532 — the state file {@link codexAutomationFloorHookCommand} names, when the build has one. */
  stateFile?: string,
): CodexHostAuthoredHooksPlan {
  return mintHostAuthoredCodexHooks(
    { origin: 'CodexAgent.unattendedAutomationFloorHookProjection', revocation: { kind: 'next-runtime-build' } },
    {
      PermissionRequest: [{
        matcher: CODEX_AUTOMATION_FLOOR_HOOK_MATCHER,
        hooks: [{
          command: codexAutomationFloorHookCommand(node, sessionServer, workspaceRoot, stateFile),
          timeoutSec,
          statusMessage: CODEX_AUTOMATION_FLOOR_HOOK_STATUS_MESSAGE,
        }],
      }],
    },
  );
}

interface TrustClient {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
}

interface ListedHook {
  key?: unknown;
  eventName?: unknown;
  handlerType?: unknown;
  command?: unknown;
  currentHash?: unknown;
  trustStatus?: unknown;
}

/**
 * The one-boot trust pass. Returns how many projected host hooks are trusted
 * afterwards (already-trusted ones included); `0` means none is live. Never
 * throws — a runtime that cannot answer must still start a session.
 */
export async function trustCodexHostAuthoredHooks(
  client: TrustClient,
  cwd: string,
  /** The EXACT command lines this host minted — nothing else is trusted. */
  commands: readonly string[],
  debug: (message: string) => void,
  timeoutMs = 15_000,
): Promise<number> {
  try {
    const listed = await client.request('hooks/list', { cwds: [cwd] }, { timeoutMs }) as {
      data?: Array<{ hooks?: ListedHook[] }>;
    };
    const ours = (listed.data ?? []).flatMap(entry => entry.hooks ?? []).filter(hook =>
      hook.eventName === 'permissionRequest'
      && hook.handlerType === 'command'
      && typeof hook.command === 'string'
      && commands.includes(hook.command)
      && typeof hook.key === 'string'
      && typeof hook.currentHash === 'string');
    if (ours.length === 0) {
      debug('[codex-hooks] F1.386: hooks/list did not report the projected automation floor hook');
      return 0;
    }
    const pending = ours.filter(hook => hook.trustStatus !== 'trusted');
    if (pending.length === 0) return ours.length;
    await client.request('config/batchWrite', {
      edits: [{
        keyPath: 'hooks.state',
        value: Object.fromEntries(pending.map(hook => [hook.key as string, { enabled: true, trusted_hash: hook.currentHash as string }])),
        mergeStrategy: 'upsert',
      }],
      reloadUserConfig: true,
    }, { timeoutMs });
    const again = await client.request('hooks/list', { cwds: [cwd] }, { timeoutMs }) as {
      data?: Array<{ hooks?: ListedHook[] }>;
    };
    const keys = new Set(ours.map(hook => hook.key));
    const trusted = (again.data ?? []).flatMap(entry => entry.hooks ?? [])
      .filter(hook => keys.has(hook.key) && hook.trustStatus === 'trusted').length;
    if (trusted < ours.length) debug(`[codex-hooks] F1.386: ${ours.length - trusted} projected hook(s) still untrusted after config/batchWrite`);
    return trusted;
  } catch (error) {
    debug(`[codex-hooks] F1.386 trust pass failed: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

/**
 * F1.482 (3) — the hook's `statusMessage`, which codex echoes on every run of it
 * (`HookRunSummary.statusMessage` is the handler's own, `hooks/src/engine/dispatcher.rs`
 * `completed_summary`), so a run of THIS hook can be told from any other.
 */
export const CODEX_AUTOMATION_FLOOR_HOOK_STATUS_MESSAGE = 'Checking the unattended-automation floor';

/**
 * F1.482 (3) — what the turn says when codex could not run the hook: the floor
 * refused nothing, and the request went on to codex's next approval step.
 */
export const CODEX_AUTOMATION_FLOOR_HOOK_FAILED_NOTICE =
  '[codex-hooks] the unattended-automation floor hook could not run for this request (codex\'s own hook line says why),'
  + ' so it refused nothing: codex treats a hook that fails, crashes or times out as no verdict and went on to its'
  + ' next approval step — with Codex auto-review on, its reviewer answered in the floor\'s place (F1.386).';

/**
 * F1.482 (3) — is this a run of the floor hook that codex could not complete?
 * Read off the observation the event adapter builds from `hook/completed`
 * (`event-adapter.ts` `hookRunEvents`): its `output` is the run's
 * `statusMessage` followed by one `[<kind>] <text>` line per entry. A FAILED run
 * carries an `[error]` entry on every path `parse_completed` has; a REFUSAL
 * (`blocked`) carries `[feedback]` only, and since F1.515 the adapter reports it
 * as `outcome: 'blocked'` — the entry kind still decides, so the two cannot mix.
 */
export function codexAutomationFloorHookRunFailed(observation: HookRunObservation): boolean {
  if (observation.runtime !== 'codex' || observation.event !== 'permissionRequest') return false;
  if (observation.outcome !== 'error' && observation.outcome !== 'timeout') return false;
  const [first, ...rest] = (observation.output ?? '').split('\n');
  return first?.trim() === CODEX_AUTOMATION_FLOOR_HOOK_STATUS_MESSAGE && rest.some(line => line.startsWith('[error] '));
}

// F1.482 (3) — imported at the end, beside the one reader that needs it.
import type { HookRunObservation } from '../../hook-run-report.ts';
