/**
 * F1.493 (2) — the subprocess half of carrying WHICH codex tool call a bridged session tool is running for.
 *
 * codex's MCP client sends `_meta: { callId, threadId, … }` on every `tools/call` (measured on the shipped
 * `codex-app-server` 0.156.1: a main-thread call names the main thread, a `spawn_agent` child's call names the
 * child's; see `HostCallbackBridgeCallOrigin`). The CallTool handler in `index.ts` runs the tool inside this scope,
 * and the bridge client (`host-callback-bridge-client.ts`) puts the scope's origin on every request it sends while
 * that call runs, so the host can bind a card the call raises to the thread that raised it.
 *
 * An async-local scope rather than a parameter for the reason `session-tool-call-origin.ts` gives on the host side:
 * the call crosses the registry handler, the tool context's port and the bridge client, which every tool shares,
 * and only the two ends need to know. A call whose `_meta` names no `callId` runs with NO scope rather than an
 * inherited one, and then the request carries no origin — exactly the body it carried before this module.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { hostCallbackBridgeCallOriginOf, type HostCallbackBridgeCallOrigin } from '@nessy-agent/session-tools-core';

const scope = new AsyncLocalStorage<HostCallbackBridgeCallOrigin>();

/** Run `action` for the tool call `meta` (a `tools/call` request's `_meta`) names, or with no scope. */
export function runInBridgeCallOrigin<T>(meta: unknown, action: () => T): T {
  const origin = hostCallbackBridgeCallOriginOf(meta);
  return origin ? scope.run(origin, action) : scope.exit(action);
}

/** The tool call the current async context is running for, when codex named one. */
export function currentBridgeCallOrigin(): HostCallbackBridgeCallOrigin | undefined {
  return scope.getStore();
}
