/**
 * The human half of the script action's approval (UA8.3, spec §15 item 3): read where a saved `type:'script'`
 * action stands against the host-approvals ledger, and record the person's approval of its CURRENT bytes — the
 * writer `runApprovedScript` (`script-executor.ts`) reads, through the same {@link scriptApprovalSubject} /
 * {@link scriptApprovalRecord}, so writer and reader cannot disagree on the shape.
 *
 * Ours: upstream (craft-agents-oss v0.13.4) has no approval at all — its script action runs on authoring. The
 * channel that calls {@link approveScriptAction} (`automations:approveScript`, `rpc/automations.ts`) takes the
 * action from the SAVED automation on disk, never from the client, and the digest the person was shown, so an
 * approval never covers bytes the person did not see (a swap after the row rendered is refused).
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isPathWithinDirectory } from '@nessy-agent/session-tools-core';
import { canonicalJson, findHostApproval, recordHostApproval } from '../approvals/host-approvals.ts';
import { SCRIPT_APPROVAL_KIND, scriptApprovalRecord, scriptApprovalSubject, scriptSha256 } from './script-executor.ts';
import type { ScriptAction } from './types.ts';

/**
 * - `outside` — the path is absolute or escapes the workspace (it can never run);
 * - `missing` — the file is not there;
 * - `unapproved` — no approval; `changed` — approved once, but the bytes differ now;
 * - `approved` — the current bytes are the approved ones (args and runtime included).
 */
export type ScriptApprovalState = 'outside' | 'missing' | 'unapproved' | 'changed' | 'approved';

export interface ScriptApprovalStatus {
  state: ScriptApprovalState;
  /** sha256 of the script's CURRENT bytes, when it can be read. */
  sha256?: string;
}

function currentBytes(workspaceRootPath: string, action: Pick<ScriptAction, 'script'>): { state: 'outside' | 'missing' } | { bytes: Buffer } {
  if (isAbsolute(action.script)) return { state: 'outside' };
  const path = join(workspaceRootPath, action.script);
  if (!existsSync(path)) return { state: 'missing' };
  if (!isPathWithinDirectory(path, workspaceRootPath)) return { state: 'outside' };
  return { bytes: readFileSync(path) };
}

/** Where a script action stands against the ledger (`key`: `getHostApprovalsKeyProvider().getKey()`). */
export function readScriptActionApproval(
  workspaceRootPath: string,
  key: Buffer,
  action: Pick<ScriptAction, 'script' | 'args' | 'runtime'>,
): ScriptApprovalStatus {
  const read = currentBytes(workspaceRootPath, action);
  if ('state' in read) return { state: read.state };
  const sha256 = scriptSha256(read.bytes);
  const entry = findHostApproval(workspaceRootPath, key, SCRIPT_APPROVAL_KIND, scriptApprovalSubject(action));
  if (!entry) return { state: 'unapproved', sha256 };
  const expected = scriptApprovalRecord(action, sha256);
  const same = entry.digest === expected.digest && canonicalJson(entry.data ?? null) === canonicalJson(expected.data);
  return { state: same ? 'approved' : 'changed', sha256 };
}

/**
 * Record the person's approval of a script action's CURRENT bytes. With `expectedSha256` (the digest the UI showed),
 * bytes that changed since are refused. Throws on a path that cannot run.
 */
export function approveScriptAction(
  workspaceRootPath: string,
  key: Buffer,
  action: Pick<ScriptAction, 'script' | 'args' | 'runtime'>,
  expectedSha256?: string,
): ScriptApprovalStatus {
  const read = currentBytes(workspaceRootPath, action);
  if ('state' in read) {
    throw new Error(read.state === 'missing'
      ? `Script not found: ${action.script}`
      : `Script path escapes the workspace: ${action.script}`);
  }
  const sha256 = scriptSha256(read.bytes);
  if (expectedSha256 !== undefined && expectedSha256 !== sha256) {
    throw new Error(`The script ${action.script} changed while it was being reviewed; review it again before approving`);
  }
  recordHostApproval(workspaceRootPath, key, {
    kind: SCRIPT_APPROVAL_KIND,
    subject: scriptApprovalSubject(action),
    ...scriptApprovalRecord(action, sha256),
  });
  return { state: 'approved', sha256 };
}
