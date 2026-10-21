/**
 * Session Self-Management Bindings
 *
 * Attaches the session-management properties and host ports to a
 * SessionToolContext using Object.defineProperty with non-memoized lazy getters
 * (the count is deliberately not stated here — it has been wrong twice; the
 * `defineProperty` calls below are the list). Each access resolves
 * the callback from the session-scoped tool callback registry at call time,
 * so late merges and callback replacements are immediately visible without
 * recreating the context.
 *
 * Used by both the Claude and Pi agent paths to ensure a single binding
 * implementation — the root cause of #511 was that PiAgent's context was
 * missing these bindings entirely.
 *
 * Design rules:
 * - Each getter calls getSessionScopedToolCallbacks() fresh — NO memoization
 * - Returns undefined when the callback is missing — NO no-ops, NO fake data
 * - getSessionInfo is the only field that wraps (for sid ?? sessionId defaulting)
 * - All other fields return the raw registry callback directly (signatures match)
 */

import type { SessionToolContext } from '@nessy-agent/session-tools-core';
import { getSessionScopedToolCallbacks } from './session-scoped-tool-callback-registry.ts';
import type { SessionKey } from '../sessions/session-key.ts';

/**
 * Attach session self-management bindings to a SessionToolContext.
 *
 * Defines lazy getters for the session-management callbacks (setSessionLabels,
 * setSessionStatus, getSessionInfo, listSessions, resolveLabels, resolveStatus,
 * sendAgentMessage, activateSourceInSession) and for the host ports the
 * registry carries (monitor, cronPort, goalPort, worktree, mcpResources,
 * mcpSources, skillResources, pluginManagement).
 *
 * @param context - The SessionToolContext to augment (mutated in place)
 * @param key - Composite session identity for registry lookup. The caller's own
 *   bare sessionId (`key.sessionId`) is the default target for getSessionInfo;
 *   any target it resolves is scoped to this caller's workspace.
 */
export function attachSessionSelfManagementBindings(
  context: SessionToolContext,
  key: SessionKey,
): void {
  // Direct pass-through bindings — signatures match, no wrapping needed.
  // Each getter resolves fresh from the registry on every access.

  Object.defineProperty(context, 'setSessionLabels', {
    get() {
      return getSessionScopedToolCallbacks(key)?.setSessionLabelsFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'setSessionStatus', {
    get() {
      return getSessionScopedToolCallbacks(key)?.setSessionStatusFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'listSessions', {
    get() {
      return getSessionScopedToolCallbacks(key)?.listSessionsFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'resolveLabels', {
    get() {
      return getSessionScopedToolCallbacks(key)?.resolveLabelsFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'resolveStatus', {
    get() {
      return getSessionScopedToolCallbacks(key)?.resolveStatusFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'sendAgentMessage', {
    get() {
      return getSessionScopedToolCallbacks(key)?.sendAgentMessageFn;
    },
    configurable: true,
    enumerable: true,
  });

  // P6.466 — the archive verb. Bound through the registry like every sibling
  // above, so a runtime switch that re-merges the callbacks re-points this one
  // too; the approval card the verb raises lives inside the closure, not here.
  Object.defineProperty(context, 'archiveSession', {
    get() {
      return getSessionScopedToolCallbacks(key)?.archiveSessionFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'activateSourceInSession', {
    get() {
      return getSessionScopedToolCallbacks(key)?.activateSourceInSessionFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'monitor', {
    get() {
      return getSessionScopedToolCallbacks(key)?.monitorPort;
    },
    configurable: true,
    enumerable: true,
  });

  // T3 — the scheduling half of the same story `monitor` above tells. Bound
  // through the registry rather than assigned once, for this file's stated
  // rule: a runtime switch rebuilds the agent and re-merges the port (or clears
  // it), and a memoized read would hand the next runtime the previous one's.
  Object.defineProperty(context, 'cronPort', {
    get() {
      return getSessionScopedToolCallbacks(key)?.cronPort;
    },
    configurable: true,
    enumerable: true,
  });

  // P2.2 — the goal half of the same story `cronPort` above tells, and bound the
  // same way for the same reason: a runtime switch rebuilds the agent and
  // re-merges the port (or clears it), and a memoized read would hand the next
  // runtime the previous one's `GoalService`.
  Object.defineProperty(context, 'goalPort', {
    get() {
      return getSessionScopedToolCallbacks(key)?.goalPort;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'worktree', {
    get() {
      return getSessionScopedToolCallbacks(key)?.worktreePort;
    },
    configurable: true,
    enumerable: true,
  });

  // P3.276 — the diff authority behind `ReviewDiff`, bound through the registry
  // for this file's stated rule: a runtime switch rebuilds the agent and
  // re-merges the port (or clears it), and a memoized read would hand the next
  // runtime the previous one's working directory.
  Object.defineProperty(context, 'reviewDiff', {
    get() {
      return getSessionScopedToolCallbacks(key)?.reviewDiff;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'mcpResources', {
    get() {
      return getSessionScopedToolCallbacks(key)?.mcpResourcesPort;
    },
    configurable: true,
    enumerable: true,
  });

  // UB7.11 — the MCP prompts port (upstream v0.15.1's `ctx.mcpSources` getter),
  // through the registry for this file's stated rule (a runtime switch re-merges
  // the callbacks); the enabled-source check, the pool reads, the rendering and
  // the large-result guard live inside the closure.
  Object.defineProperty(context, 'mcpSources', {
    get() {
      return getSessionScopedToolCallbacks(key)?.mcpSources;
    },
    configurable: true,
    enumerable: true,
  });

  // UB6.11 — the decision port (upstream v0.15.1's `ctx.decide`), through the
  // registry for this file's stated rule (a runtime switch re-merges the
  // callbacks). Bound only when the decision layer is configured; the fail-
  // closed "not enabled" answer is the closure's.
  Object.defineProperty(context, 'decide', {
    get() {
      return getSessionScopedToolCallbacks(key)?.decide;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'skillResources', {
    get() {
      return getSessionScopedToolCallbacks(key)?.skillResourcesPort;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'pluginManagement', {
    get() {
      return getSessionScopedToolCallbacks(key)?.pluginManagementTools;
    },
    configurable: true,
    enumerable: true,
  });

  // UA1.18 — the t-artifacts pair, through the registry for this file's stated rule (a runtime switch re-merges the
  // callbacks); the publish card lives inside the closure, as archive_session's does.
  Object.defineProperty(context, 'publishArtifact', {
    get() {
      return getSessionScopedToolCallbacks(key)?.publishArtifactFn;
    },
    configurable: true,
    enumerable: true,
  });

  Object.defineProperty(context, 'listArtifacts', {
    get() {
      return getSessionScopedToolCallbacks(key)?.listArtifactsFn;
    },
    configurable: true,
    enumerable: true,
  });

  // UA3.5 — the board task tool, through the registry for this file's stated rule (a runtime switch re-merges the
  // callbacks); the restrictions on the caller live inside the closure.
  Object.defineProperty(context, 'createBoardTask', {
    get() {
      return getSessionScopedToolCallbacks(key)?.createBoardTaskFn;
    },
    configurable: true,
    enumerable: true,
  });

  // UB1.12 — the project-memory append closure (v0.15.1 upstream getter `appendProjectMemory`), through the registry
  // for the same stated rule; the project read, the dated heading and the one O_APPEND write live inside the closure.
  Object.defineProperty(context, 'appendProjectMemory', {
    get() {
      return getSessionScopedToolCallbacks(key)?.appendProjectMemoryFn;
    },
    configurable: true,
    enumerable: true,
  });

  // UA6.3 — the six page tools' grouped port (v0.13.4 `pages` getter), through the registry for this file's stated
  // rule (a runtime switch re-merges the callbacks); storage and `delete_page`'s card live inside the closure.
  Object.defineProperty(context, 'pages', {
    get() {
      return getSessionScopedToolCallbacks(key)?.pages;
    },
    configurable: true,
    enumerable: true,
  });

  // getSessionInfo needs wrapping to default sid → the caller's own sessionId
  Object.defineProperty(context, 'getSessionInfo', {
    get() {
      const fn = getSessionScopedToolCallbacks(key)?.getSessionInfoFn;
      if (!fn) return undefined;
      return (sid?: string) => fn(sid ?? key.sessionId);
    },
    configurable: true,
    enumerable: true,
  });
}
