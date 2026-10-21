/**
 * Deferred tool call record (R7 Task 5 — hooks.md "Defer a tool call for
 * later"). Persisted with the session when a headless PreToolUse hook returns
 * `defer`: the tool does not execute, the run terminates with
 * `tool_deferred`, and a later resume re-fires PreToolUse for the same call.
 */

import type { PermissionMode } from '../mode-manager.ts';

export interface PiDeferredToolCallV1 {
  schemaVersion: 1;
  /** The suspended tool call's id — echoed as `deferred_tool_use.id`. */
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Permission mode active when the call was deferred (restore rules below). */
  permissionMode: PermissionMode;
  deferredAt: number;
}

/** The documented `deferred_tool_use` result payload. */
export interface DeferredToolUsePayload {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export function deferredToolUsePayload(record: Pick<PiDeferredToolCallV1, 'toolUseId' | 'toolName' | 'input'>): DeferredToolUsePayload {
  return { id: record.toolUseId, name: record.toolName, input: record.input };
}

/**
 * hooks.md: "resume restores the permission mode that was active when the
 * call was deferred, except `plan` and `bypassPermissions` which are never
 * carried over and `auto` which is restored only if the account still
 * qualifies." `bypassPermissions` is now our spelling too. Returns
 * `undefined` when no restore should happen (the session keeps its current
 * mode).
 */
export function resolveDeferredModeRestore(args: {
  deferredMode: PermissionMode;
  autoStillQualified?: boolean;
}): PermissionMode | undefined {
  if (args.deferredMode === 'plan' || args.deferredMode === 'bypassPermissions') return undefined;
  if (args.deferredMode === 'auto') {
    return (args.autoStillQualified ?? true) ? 'auto' : undefined;
  }
  return args.deferredMode;
}
