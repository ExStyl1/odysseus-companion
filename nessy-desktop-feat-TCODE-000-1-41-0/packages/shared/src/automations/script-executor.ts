/**
 * Script action executor — `runApprovedScript`, the ONLY way a script action runs (UA8.1, spec §15).
 *
 * Adapted from craft-agents-oss v0.13.4:packages/shared/src/automations/script-executor.ts (Apache-2.0): argv spawn
 * through `resolveScriptRuntime` (bun / node / uv for python3) — never a shell; symlink-aware workspace
 * containment; default timeout 60 s clamped to 1 s–15 min; SIGTERM, then SIGKILL after a 5 s grace; captured
 * output capped; cooperative cancellation by `AbortSignal`; a page refresh records its outcome on page.json LAST.
 *
 * Our adaptations (spec §15 items 1–5; Review Focus 6):
 * 1. **One entry point, and the verified bytes are the bytes that run.** Upstream's raw executor export (one that spawns
 *    any path) does not exist here (a guard test finds no importer of a raw executor). `runApprovedScript` reads the script bytes
 *    ONCE, hashes them, requires a host-approvals ledger entry (`approvals/host-approvals.ts`, MAC-verified)
 *    bound to `{ path, sha256, args, runtime }`, writes those exact bytes to a private file in a fresh 0700
 *    directory and spawns the interpreter on THAT copy, with upstream's working directory (the workspace root).
 *    A swap of the original between the check and the spawn therefore cannot run.
 *    STATED RESIDUE: the digest pins the entry file only. An approved script is a single self-contained file:
 *    one that imports sibling files cannot resolve them from the private copy (and a sibling it could resolve is
 *    not covered by the approval).
 * 2. **Environment by allowlist** — the caller passes `buildScriptEnv` / `buildBaseScriptEnv` (`utils.ts`); the
 *    child gets exactly that object, never `process.env`.
 * 3. **Approval.** An unapproved run, or one whose bytes, args or runtime differ from the approval, is REFUSED
 *    (`blocked: true`, the reason in `stderr`, which the callers record in automation history). The approval is
 *    given in the UI (`automations:approveScript`, `pages:approveRefresh` — UA8.2/UA8.3) and recorded through
 *    {@link scriptApprovalRecord}, so writer and reader agree on the shape. A ledger key the host cannot load
 *    refuses every run (the closed failure).
 * 4. **Audit.** An injected {@link ScriptAuditPort}; `SessionManager` wires it to
 *    `PrivilegedExecutionBroker.auditEvent` (`logs/privileged-actions.jsonl`) — `shared` cannot import
 *    `server-core`. The record names the script, its sha256, the runtime, the argument COUNT, the trigger and the
 *    outcome; never the env, the arguments' values or the output.
 * 5. **Managed gate (an existing policy, spec §6).** `isLocalAutomationManagedDisabled()` is asked at USE time,
 *    on every run, before anything is read — the D1.409 shape of `SessionManager.runMissedRunSweep`: a policy
 *    that turns on after the `AutomationSystem` was built stops the next run. `describeManagedLocalAutomationRefusal()`
 *    is the text. It is asked for every trigger (automation, Test, refresh, page action): the policy says the
 *    app runs no local automations, and a page-action caller (UA9.2) that needs another posture says so there.
 * 6. **Network** stays allowed (upstream parity; the sandbox is off by standing decision) — a stated residue.
 *
 * 7. **A page refresh never overlaps itself** (spec §15 "a per-matcher lock", UA8.3 follow-up). The ScriptHandler's
 *    per-matcher lock only sees runs the handler started, and `pages:runRefreshNow` calls this module directly, so
 *    the lock for `page-refresh` runs lives HERE, keyed by workspace root + page slug: a run that finds the page's
 *    previous refresh still going is SKIPPED (`skipped: true`, {@link SCRIPT_RUN_IN_PROGRESS_REASON}) whichever door
 *    started either run. Other triggers keep the ScriptHandler's per-matcher lock alone (upstream).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { isPathWithinDirectory, resolveScriptRuntime } from '@nessy-agent/session-tools-core';
import {
  canonicalJson,
  findHostApproval,
  getHostApprovalsKeyProvider,
  type HostApprovalKind,
  type HostApprovalsKeyProvider,
  type JsonValue,
} from '../approvals/host-approvals.ts';
import { describeManagedLocalAutomationRefusal, isLocalAutomationManagedDisabled } from '../config/managed-local-automation.ts';
import { recordPageRefresh } from '../pages/storage.ts';
import { createLogger } from '../utils/debug.ts';
import { HISTORY_FIELD_MAX_LENGTH } from './constants.ts';
import type { ScriptAction, ScriptActionResult, ScriptActionRuntime } from './types.ts';

const log = createLogger('script-executor');

/** Default per-run timeout (design: 60s default, 15min maximum) */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 60_000;
/** Timeout clamp bounds */
export const MIN_SCRIPT_TIMEOUT_MS = 1_000;
export const MAX_SCRIPT_TIMEOUT_MS = 900_000;
/** Grace period between SIGTERM and SIGKILL */
const SIGKILL_GRACE_MS = 5_000;
/** Cap for captured stdout/stderr, each */
const OUTPUT_CAPTURE_MAX_BYTES = 16 * 1024;

/** The host's reason for a run skipped because the same matcher's (or page refresh's) previous run is still going. */
export const SCRIPT_RUN_IN_PROGRESS_REASON = 'Skipped: previous run of this automation is still in progress';

/** The ledger kind an automation's script approval is recorded under. */
export const SCRIPT_APPROVAL_KIND: HostApprovalKind = 'script-approval';

/** What an approval binds besides the digest (spec §15 item 3: `{ path, sha256(bytes), args, runtime }`). */
export interface ScriptApprovalBinding {
  path: string;
  args: string[];
  runtime: ScriptActionRuntime;
}

/** Who asked for the run — an audit label, and the reason a refusal is worded as it is. */
export type ScriptRunTrigger = 'automation' | 'test' | 'page-refresh' | 'page-action';

/** The injected audit sink (`PrivilegedExecutionBroker.auditEvent` in production). Must not throw; a throw is swallowed. */
export type ScriptAuditPort = (event: string, payload: Record<string, unknown>) => void;

export interface ApprovedScriptRequest {
  action: ScriptAction;
  /** Workspace root — scripts must live inside it, run with it as cwd, and be approved in ITS ledger. */
  workspaceRootPath: string;
  /** The allowlisted environment (`buildScriptEnv` / `buildBaseScriptEnv`); the child gets exactly this. */
  env: Record<string, string>;
  trigger: ScriptRunTrigger;
  /** The ledger entry that must approve the run; default: `script-approval` / {@link scriptApprovalSubject}. */
  approval?: { kind: HostApprovalKind; subject: string };
  /**
   * Optional cooperative-cancellation signal. When it aborts, the child gets SIGTERM with a SIGKILL fallback, so a
   * caller with its own deadline can guarantee the process cannot outlive the request.
   */
  signal?: AbortSignal;
  /** Audit label fields. */
  workspaceId?: string;
  matcherId?: string;
  audit?: ScriptAuditPort;
  /** The ledger key's provider; default: the one the host installed (`getHostApprovalsKeyProvider`). */
  keyProvider?: HostApprovalsKeyProvider;
  /**
   * TEST SEAMS. `afterVerify` runs after the bytes were hashed, approved and copied, immediately before the spawn
   * (the swap window this module exists to close); `killGraceMs` shortens the SIGTERM→SIGKILL grace.
   */
  testSeams?: { afterVerify?: (scriptPath: string) => void; killGraceMs?: number };
}

/** Clamp a configured timeout into the allowed window. */
export function clampScriptTimeout(timeoutMs: number | undefined): number {
  const requested = timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  return Math.min(MAX_SCRIPT_TIMEOUT_MS, Math.max(MIN_SCRIPT_TIMEOUT_MS, requested));
}

/** The binding an approval of `action` covers (args default `[]`, runtime default `bun`, as the executor runs it). */
export function scriptApprovalBinding(action: Pick<ScriptAction, 'script' | 'args' | 'runtime'>): ScriptApprovalBinding {
  return { path: action.script, args: [...(action.args ?? [])], runtime: action.runtime ?? 'bun' };
}

/**
 * The ledger subject of an automation script approval: the path, plus a short hash of `{ args, runtime }` so two
 * automations running one script with different arguments hold two approvals instead of replacing each other.
 */
export function scriptApprovalSubject(action: Pick<ScriptAction, 'script' | 'args' | 'runtime'>): string {
  const { args, runtime } = scriptApprovalBinding(action);
  const variant = createHash('sha256').update(canonicalJson({ args, runtime }), 'utf8').digest('hex').slice(0, 16);
  return `script:${action.script}#${variant}`;
}

/** The `digest` + `data` a writer records (`recordHostApproval`) so {@link runApprovedScript} accepts it. */
export function scriptApprovalRecord(
  action: Pick<ScriptAction, 'script' | 'args' | 'runtime'>,
  sha256: string,
): { digest: string; data: { [key: string]: JsonValue } } {
  const binding = scriptApprovalBinding(action);
  return { digest: sha256, data: { path: binding.path, args: binding.args, runtime: binding.runtime } };
}

/** The sha256 (lower-case hex) of a script's bytes — what an approval records. */
export function scriptSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function blockedResult(action: ScriptAction, reason: string): ScriptActionResult {
  return {
    type: 'script',
    script: action.script,
    success: false,
    exitCode: null,
    blocked: true,
    stdout: '',
    stderr: reason,
    durationMs: 0,
    page: action.page,
  };
}

function emitAudit(request: ApprovedScriptRequest, event: string, fields: Record<string, unknown>): void {
  if (!request.audit) return;
  try {
    request.audit(event, {
      trigger: request.trigger,
      ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
      ...(request.matcherId ? { matcherId: request.matcherId } : {}),
      ...(request.action.page ? { page: request.action.page } : {}),
      script: request.action.script,
      runtime: request.action.runtime ?? 'bun',
      argCount: request.action.args?.length ?? 0,
      ...fields,
    });
  } catch (e) {
    log.debug(`[ScriptExecutor] audit port threw: ${e}`);
  }
}

function refuse(request: ApprovedScriptRequest, reason: string, sha256?: string): ScriptActionResult {
  emitAudit(request, 'automation_script_refused', { reason, ...(sha256 ? { sha256 } : {}) });
  return blockedResult(request.action, reason);
}

function sameBinding(data: { [key: string]: JsonValue } | undefined, binding: ScriptApprovalBinding): boolean {
  if (!data) return false;
  return data.path === binding.path
    && data.runtime === binding.runtime
    && canonicalJson(data.args ?? null) === canonicalJson(binding.args);
}

/**
 * Run one approved script action. Never throws — every failure (refusal, spawn error, timeout, abort) is folded
 * into the result so the callers (handler, RPC Test, page bridge) record one uniform shape.
 */
export async function runApprovedScript(request: ApprovedScriptRequest): Promise<ScriptActionResult> {
  // --- One page refresh at a time per page (module header item 7); taken before the first await ---
  const lockKey = request.trigger === 'page-refresh' && request.action.page !== undefined
    ? `${request.workspaceRootPath}\n${request.action.page}`
    : null;
  if (lockKey === null) return runVerifiedScript(request);
  if (pageRefreshesInFlight.has(lockKey)) {
    log.debug(`[ScriptExecutor] Skipping the refresh of ${request.action.page}: its previous run is still in progress`);
    return skippedResult(request.action);
  }
  pageRefreshesInFlight.add(lockKey);
  try {
    return await runVerifiedScript(request);
  } finally {
    pageRefreshesInFlight.delete(lockKey);
  }
}

/** Page refreshes running now, keyed `<workspace root>\n<page slug>` (module header item 7). */
const pageRefreshesInFlight = new Set<string>();

function skippedResult(action: ScriptAction): ScriptActionResult {
  return {
    type: 'script',
    script: action.script,
    success: false,
    exitCode: null,
    skipped: true,
    stdout: '',
    stderr: SCRIPT_RUN_IN_PROGRESS_REASON,
    durationMs: 0,
    page: action.page,
  };
}

/** {@link runApprovedScript} without the page-refresh lock: the checks, the verified copy and the spawn. */
async function runVerifiedScript(request: ApprovedScriptRequest): Promise<ScriptActionResult> {
  const { action, workspaceRootPath } = request;

  // --- Managed policy, at USE time (module header item 5) ---
  if (isLocalAutomationManagedDisabled()) {
    return refuse(request, describeManagedLocalAutomationRefusal());
  }

  // --- Path containment (workspace-scoped, symlink-aware; upstream) ---
  if (isAbsolute(action.script)) {
    return refuse(request, `Script path must be relative to the workspace root: ${action.script}`);
  }
  const scriptPath = join(workspaceRootPath, action.script);
  // Existence first: isPathWithinDirectory can only resolve symlinks for paths that exist (upstream's reason).
  if (!existsSync(scriptPath)) {
    return refuse(request, `Script not found: ${action.script}`);
  }
  if (!isPathWithinDirectory(scriptPath, workspaceRootPath)) {
    return refuse(request, `Script path escapes the workspace: ${action.script}`);
  }

  // --- Runtime resolution (env override → bundled → PATH in dev; upstream) ---
  let command: string;
  let argsPrefix: string[];
  try {
    const runtime = resolveScriptRuntime(action.runtime ?? 'bun');
    command = runtime.command;
    argsPrefix = runtime.argsPrefix;
  } catch (e) {
    return refuse(request, e instanceof Error ? e.message : 'Script runtime unavailable');
  }

  // --- Read the bytes ONCE and verify them against the ledger ---
  let bytes: Buffer;
  try {
    bytes = readFileSync(scriptPath);
  } catch (e) {
    return refuse(request, `Script could not be read: ${action.script} (${e instanceof Error ? e.message : String(e)})`);
  }
  const sha256 = scriptSha256(bytes);
  let key: Buffer;
  try {
    key = await (request.keyProvider ?? getHostApprovalsKeyProvider()).getKey();
  } catch {
    return refuse(request, 'Script not run: the host-approvals key is unavailable, so no approval can be verified', sha256);
  }
  const binding = scriptApprovalBinding(action);
  const approval = request.approval ?? { kind: SCRIPT_APPROVAL_KIND, subject: scriptApprovalSubject(action) };
  const entry = findHostApproval(workspaceRootPath, key, approval.kind, approval.subject);
  if (!entry) {
    return refuse(request, `Script not approved: ${action.script} — approve it before it can run`, sha256);
  }
  if (!sameBinding(entry.data, binding)) {
    return refuse(request, `Script approval does not match: ${action.script} was approved with a different path, arguments or runtime — approve it again`, sha256);
  }
  if (entry.digest !== sha256) {
    return refuse(request, `Script changed since it was approved: ${action.script} — approve the new version before it can run`, sha256);
  }

  // --- The verified bytes, from a private copy (module header item 1) ---
  let privateDir: string;
  let privatePath: string;
  try {
    privateDir = mkdtempSync(join(tmpdir(), 'nessy-script-'));
    chmodSync(privateDir, 0o700);
    privatePath = join(privateDir, basename(action.script));
    writeFileSync(privatePath, bytes, { mode: 0o600 });
  } catch (e) {
    return refuse(request, `Script not run: its private copy could not be written (${e instanceof Error ? e.message : String(e)})`, sha256);
  }

  try {
    request.testSeams?.afterVerify?.(scriptPath);
    const result = await spawnScript(request, command, [...argsPrefix, privatePath, ...binding.args]);
    emitAudit(request, 'automation_script_ran', {
      sha256,
      success: result.success,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.timedOut ? { timedOut: true } : {}),
    });

    // --- Page refresh completion marker (must be the LAST write of the run; upstream) ---
    if (action.page) {
      try {
        recordPageRefresh(workspaceRootPath, action.page, {
          at: Date.now(),
          ok: result.success,
          durationMs: result.durationMs,
          error: result.success ? undefined : (result.stderr || undefined),
        });
      } catch (e) {
        log.debug(`[ScriptExecutor] Failed to record page refresh for ${action.page}: ${e}`);
      }
    }
    return result;
  } finally {
    try {
      rmSync(privateDir, { recursive: true, force: true });
    } catch (e) {
      log.debug(`[ScriptExecutor] Failed to remove the private copy: ${e}`);
    }
  }
}

/** The spawn itself (upstream's body, unchanged but for the private path and the grace seam). */
function spawnScript(request: ApprovedScriptRequest, command: string, spawnArgs: string[]): Promise<ScriptActionResult> {
  const { action, workspaceRootPath, env, signal } = request;
  const timeoutMs = clampScriptTimeout(action.timeoutMs);
  const killGraceMs = request.testSeams?.killGraceMs ?? SIGKILL_GRACE_MS;
  const startTime = Date.now();

  return new Promise<ScriptActionResult>((resolvePromise) => {
    const child = spawn(command, spawnArgs, {
      cwd: workspaceRootPath,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let abortKillTimer: ReturnType<typeof setTimeout> | undefined;

    const capture = (current: string, chunk: Buffer): string =>
      current.length >= OUTPUT_CAPTURE_MAX_BYTES
        ? current
        : (current + chunk.toString('utf-8')).slice(0, OUTPUT_CAPTURE_MAX_BYTES);

    child.stdout?.on('data', (chunk: Buffer) => { stdout = capture(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = capture(stderr, chunk); });

    // SIGTERM at timeout; SIGKILL if the process traps it and lingers.
    const termTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        log.warn(`[ScriptExecutor] ${action.script} ignored SIGTERM, sending SIGKILL`);
        child.kill('SIGKILL');
      }
    }, timeoutMs + killGraceMs);

    // Cooperative cancellation: SIGTERM now, SIGKILL after the same grace.
    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      abortKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, killGraceMs);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const settle = (partial: Pick<ScriptActionResult, 'success' | 'exitCode'> & Partial<ScriptActionResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
      signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        type: 'script',
        script: action.script,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - startTime,
        page: action.page,
        ...partial,
      });
    };

    child.on('error', (error) => {
      settle({ success: false, exitCode: null, stderr: (stderr + '\n' + error.message).trim() });
    });

    child.on('close', (code, closeSignal) => {
      if (aborted) {
        settle({ success: false, exitCode: null, stderr: (stderr + '\nAborted').trim() });
      } else if (timedOut) {
        settle({
          success: false,
          exitCode: null,
          timedOut: true,
          stderr: (stderr + `\nTimed out after ${timeoutMs}ms${closeSignal ? ` (${closeSignal})` : ''}`).trim(),
        });
      } else {
        settle({ success: code === 0, exitCode: code });
      }
    });
  });
}

/**
 * Create a script-action history entry for automations-history.jsonl.
 * Mirrors createWebhookHistoryEntry / createPromptHistoryEntry in webhook-utils.ts (upstream).
 */
export function createScriptHistoryEntry(opts: {
  matcherId: string;
  result: ScriptActionResult;
}): Record<string, unknown> {
  const { result } = opts;
  return {
    id: opts.matcherId,
    ts: Date.now(),
    ok: result.success,
    script: {
      script: result.script,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.page ? { page: result.page } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(result.blocked ? { blocked: true } : {}),
      ...(result.skipped ? { skipped: true } : {}),
      ...(result.success || !result.stderr ? {} : { error: result.stderr.slice(0, HISTORY_FIELD_MAX_LENGTH) }),
    },
  };
}
