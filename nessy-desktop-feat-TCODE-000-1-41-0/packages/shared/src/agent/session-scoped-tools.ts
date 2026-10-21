/**
 * Session-Scoped Tools
 *
 * Tools that are scoped to a specific session. Each session gets its own
 * instance of these tools with session-specific callbacks and state.
 *
 * This file is a thin adapter that wraps the shared handlers from
 * @nessy-agent/session-tools-core for use with the Claude SDK.
 *
 * All tool definitions, schemas, and handlers live in session-tools-core.
 * This adapter only handles:
 * - Session callback registry (per-session onPlanSubmitted, onAuthRequest, queryFn)
 * - Plan state management
 * - Claude SDK tool() wrapping with DOC_REF-enriched descriptions
 * - call_llm (backend-specific, not in registry)
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { getSessionPlansDir as getSessionPlansDirById, getSessionDirPath } from '../sessions/storage.ts';
import { encodeSessionKey, type SessionKey } from '../sessions/session-key.ts';
import { DOC_REFS } from '../docs/index.ts';
import { createClaudeContext } from './claude-context.ts';
import type { SessionMemoryScopeOverride } from './memory/session-memory-scope.ts';

// Import from session-tools-core: registry + schemas + base descriptions
import {
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  flattenDiscriminatedUnionForSdkTool,
  getSessionToolDefs,
  isOfferedByHostPorts,
  TOOL_DESCRIPTIONS as BASE_DESCRIPTIONS,
  // Types
  type SessionToolFilterOptions,
  type ToolResult,
  type AuthRequest,
} from '@nessy-agent/session-tools-core';
import { createLLMTool, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';
import { createAdvisorConsultTool } from './advisor-consult-tool.ts';
import { createSpawnSessionTool, type SpawnSessionFn } from './spawn-session-tool.ts';
import { createBrowserTools, type BrowserPaneFns } from './browser-tools.ts';
import { convertResult } from './session-tool-result.ts';
import { FEATURE_FLAGS } from '../feature-flags.ts';
import { getAdvisorEnabled, getBrowserToolEnabled } from '../config/storage.ts';

// Re-export types for backward compatibility
export type {
  CredentialInputMode,
  AuthRequestType,
  AuthRequest,
  AuthResult,
  CredentialAuthRequest,
  McpOAuthAuthRequest,
  GoogleOAuthAuthRequest,
  GoogleService,
} from '@nessy-agent/session-tools-core';

// Re-export browser pane types for session manager wiring
export type { BrowserPaneFns } from './browser-tools.ts';

// ============================================================
// Session-Scoped Tool Callbacks (re-exported from dedicated registry module)
// ============================================================

// Re-export for all downstream consumers (index.ts, claude-agent.ts, pi-agent.ts, etc.)
export {
  type SessionScopedToolCallbacks,
  registerSessionScopedToolCallbacks,
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  getSessionScopedToolCallbacks,
} from './session-scoped-tool-callback-registry.ts';

// Local imports for use within this file's factory function
import { getSessionScopedToolCallbacks } from './session-scoped-tool-callback-registry.ts';
import { attachSessionSelfManagementBindings } from './session-self-management-bindings.ts';

/** Backend-executed session tools currently supported by the Claude adapter layer. */
export const CLAUDE_BACKEND_SESSION_TOOL_NAMES = new Set<string>([
  'call_llm',
  // P2.1 — the advisor consult, backend-executed for call_llm's reason.
  // `assertClaudeBackendSessionToolParity` throws at setup if this set and
  // `SESSION_BACKEND_TOOL_NAMES` ever disagree, which is what makes adding a
  // backend tool to the registry without a Claude adapter a fail-fast.
  'advisor_consult',
  'spawn_session',
  'browser_tool',
]);

/**
 * Guardrail: ensure Claude adapter wiring stays in sync with backend-mode tools
 * declared in session-tools-core. Fail fast during setup instead of runtime drift.
 */
function assertClaudeBackendSessionToolParity(): void {
  const missing = [...SESSION_BACKEND_TOOL_NAMES].filter(
    (name) => !CLAUDE_BACKEND_SESSION_TOOL_NAMES.has(name),
  );

  if (missing.length > 0) {
    throw new Error(
      `Claude session tools missing backend adapter implementations: ${missing.join(', ')}`,
    );
  }
}

// ============================================================
// Plan State Management
// ============================================================

// Map of composite {workspaceId, sessionId} -> last submitted plan path so two
// workspaces reusing the same bare sessionId keep distinct plan state.
const sessionPlanFilePaths = new Map<string, string>();

/**
 * Get the last submitted plan file path for a session
 */
export function getLastPlanFilePath(key: SessionKey): string | null {
  return sessionPlanFilePaths.get(encodeSessionKey(key)) ?? null;
}

/**
 * Set the last submitted plan file path for a session
 */
export function setLastPlanFilePath(key: SessionKey, path: string): void {
  sessionPlanFilePaths.set(encodeSessionKey(key), path);
}

/**
 * Clear plan file state for a session
 */
export function clearPlanFileState(key: SessionKey): void {
  sessionPlanFilePaths.delete(encodeSessionKey(key));
}

// ============================================================
// Plan Path Helpers
// ============================================================

/**
 * Get the plans directory for a session (ID-first, global v2 layout)
 */
export function getSessionPlansDir(workspaceId: string, sessionId: string): string {
  return getSessionPlansDirById(workspaceId, sessionId);
}

/**
 * Check if a path is within a session's plans directory
 */
export function isPathInPlansDir(path: string, workspacePath: string, sessionId: string): boolean {
  const plansDir = getSessionPlansDir(workspacePath, sessionId);
  return path.startsWith(plansDir);
}

// ============================================================
// Tool Result Converter
// ============================================================

/**
 * P6.148 / P6.895 — the host-port OFFER gate, as this builder's own inputs
 * spell it.
 *
 * Two per-session facts live in the callback registry and both decide whether a
 * tool may be ADVERTISED at all: a bound `reviewDiff` port, and the claude
 * session whose native `WebSearch` is withheld. `session-tools-core` already
 * owns the rule — `isOfferedByHostPorts` — so this translates the registry's
 * spelling into that function's option spelling and does nothing else. It does
 * NOT re-state which tools are gated: that list is the gate's, and a copy here
 * is the two-lists-must-agree shape (P6.895 was born from exactly one such
 * copy, which knew about `web_search` and not about `ReviewDiff`).
 *
 * Exported as a function of its two inputs so the DEFAULT is machine-checked:
 * the whole safety of this gate is that a caller which has not thought about
 * the target model's wire, or which has no diff port, gets nothing — and a
 * default is exactly the kind of claim that rots into "someone will remember".
 */
export function hostPortOfferOptions(
  callbacks: { reviewDiff?: unknown; hostWebSearchOffered?: boolean; decide?: unknown } | undefined,
): SessionToolFilterOptions {
  return {
    reviewDiffPort: Boolean(callbacks?.reviewDiff),
    hostWebSearch: callbacks?.hostWebSearchOffered === true,
    // UB6.11 — the decision port. The registry slot is bound by SessionManager
    // ONLY when the decision layer is configured, so `Boolean(callbacks?.decide)`
    // is exactly `SessionToolFilterOptions.decidePort`'s contract: offered and
    // servable together, no session left advertising a tool that can only
    // refuse.
    decidePort: Boolean(callbacks?.decide),
  };
}

/** {@link hostPortOfferOptions} applied — the exact filter the builder runs. */
export function withHostPortGate<T extends { name: string }>(
  defs: readonly T[],
  callbacks: { reviewDiff?: unknown; hostWebSearchOffered?: boolean; decide?: unknown } | undefined,
): T[] {
  const options = hostPortOfferOptions(callbacks);
  return defs.filter(def => isOfferedByHostPorts(def, options));
}

// C3.147 — moved to the leaf `session-tool-result.ts` so `browser-tools.ts`,
// which this module imports, can reach it without an import cycle. Re-exported
// here because this is the name every existing caller and test knows; the
// builder below calls it too, so it is imported rather than only re-exported.
export { convertResult };

// ============================================================
// Cache for Session-Scoped Tools
// ============================================================

// Cache tools by session to avoid recreating them on every query.
// We cache the tools array (expensive to build) but NOT the MCP server wrapper,
// because createSdkMcpServer returns an MCP Server instance that holds transport
// state. The SDK's query() calls connect() on it, setting _transport. On the next
// query(), connect() is called again — but if the previous Query's subprocess hasn't
// fully exited yet, _transport is still set and connect() throws
// "Already connected to a transport". Creating a fresh server wrapper per query avoids this.
const sessionToolsCache = new Map<string, ReturnType<typeof tool>[]>();

/**
 * Invalidate ALL session tool caches (e.g., when a global setting like browserToolEnabled changes).
 * This forces tools to be rebuilt on the next message for every session.
 */
export function invalidateAllSessionToolsCaches(): void {
  sessionToolsCache.clear();
}

/**
 * Clean up cached tools for a session
 */
export function cleanupSessionScopedTools(key: SessionKey): void {
  sessionToolsCache.delete(encodeSessionKey(key));
}

// ============================================================
// Tool Descriptions (base from registry + Claude-specific DOC_REFS)
// ============================================================

const TOOL_DESCRIPTIONS: Record<string, string> = {
  ...BASE_DESCRIPTIONS,
  // Claude-specific enrichments with DOC_REFs
  config_validate: BASE_DESCRIPTIONS.config_validate + `\n\n**Reference:** ${DOC_REFS.sources}`,
  skill_validate: BASE_DESCRIPTIONS.skill_validate + `\n\n**Reference:** ${DOC_REFS.skills}`,
  mermaid_validate: BASE_DESCRIPTIONS.mermaid_validate + `\n\n**Reference:** ${DOC_REFS.mermaid}`,
  source_test: BASE_DESCRIPTIONS.source_test + `\n\n**Reference:** ${DOC_REFS.sources}`,
};

// ============================================================
// Main Factory Function
// ============================================================

/**
 * Get or create session-scoped tools for a session.
 * Returns an MCP server with all session-scoped tools registered.
 *
 * All tools come from the canonical SESSION_TOOL_DEFS registry in session-tools-core,
 * except call_llm which is backend-specific.
 */
export function getSessionScopedTools(
  sessionId: string,
  workspaceRootPath: string,
  workspaceId: string,
  workingDirectory?: string,
  // P6.795 — this chat's own memory override, as an ACCESSOR rather than a
  // value. The context below is built ONLY on a cache miss, so a captured value
  // would freeze the override at the first build and re-create the staleness
  // `claude-context.ts` removed by resolving it on read.
  getMemoryScopeOverride?: () => SessionMemoryScopeOverride | undefined
): ReturnType<typeof createSdkMcpServer> {
  // Composite identity for every session-keyed singleton this factory touches
  // (tools cache, callback registry, plan state, self-management bindings).
  const key: SessionKey = { workspaceId, sessionId };
  const cacheKey = encodeSessionKey(key);

  // ID-first session-path derivation (global SESSIONS_DIR). Derived once here and
  // threaded to createClaudeContext + createLLMTool so no consumer recomputes it.
  const sessionPath = getSessionDirPath(workspaceId, sessionId);

  // Return cached tools if available, but always create a fresh MCP server wrapper
  let tools: any[] | undefined = sessionToolsCache.get(cacheKey);
  if (!tools) {
    // Create Claude context with full capabilities
    const ctx = createClaudeContext({
      sessionId,
      workspacePath: workspaceRootPath,
      workspaceId,
      sessionPath,
      workingDirectory,
      onPlanSubmitted: (planPath: string) => {
        setLastPlanFilePath(key, planPath);
        const callbacks = getSessionScopedToolCallbacks(key);
        callbacks?.onPlanSubmitted?.(planPath);
      },
      onAuthRequest: (request: unknown) => {
        const callbacks = getSessionScopedToolCallbacks(key);
        callbacks?.onAuthRequest?.(request as AuthRequest);
      },
      onRemoveSource: async (sourceSlug: string) => {
        const remove = getSessionScopedToolCallbacks(key)?.removeSourceFn;
        if (!remove) throw new Error('Removing a source is not available in this context.');
        await remove(sourceSlug);
      },
      ...(getMemoryScopeOverride ? { getMemoryScopeOverride } : {}),
    });

    // Attach session self-management bindings (lazy getters from callback registry)
    attachSessionSelfManagementBindings(ctx, key);
    ctx.dispatchSlashCommand = async (command: string) => {
      const callbacks = getSessionScopedToolCallbacks(key);
      const dispatch = callbacks?.dispatchSlashCommandFn;
      if (!dispatch) {
        throw new Error('SlashCommand dispatch is not available in this context.');
      }
      return dispatch(command);
    };

    // Helper to create a tool from the canonical registry.
    // The `as any` on schema bridges a Zod generic-variance issue when .shape
    // types (ZodType<string>) flow into Record<string, ZodType<unknown>>.
    function registryTool(name: string, schema: any) {
      const def = SESSION_TOOL_REGISTRY.get(name)!;
      return tool(name, TOOL_DESCRIPTIONS[name] || def.description, schema, async (args: any, extra: unknown) => {
        const result = await runInSessionToolCall(sessionToolCallOriginOf(sessionId, extra), () => def.handler!(ctx, args)); // F1.475 — whose call it is, for the host's cards
        return convertResult(result);
      }, def.readOnly ? { annotations: { readOnlyHint: true } } : undefined);
    }

    // Ensure backend-mode tool wiring is in sync with core metadata.
    assertClaudeBackendSessionToolParity();

    // Create tools from the canonical registry — all tools with handlers.
    // Tool visibility is centrally filtered in session-tools-core to avoid backend drift.
    // P3.276 / P6.148 / P6.895 — the per-session host bindings that decide what
    // may be ADVERTISED at all: a bound diff port, and a claude session whose
    // own hosted search is withheld. Read through the registry rather than
    // memoized for the reason the bindings module gives: a runtime switch
    // re-merges a port or clears it.
    //
    // The cache below keys on the session, and both facts are properties of the
    // session rather than of the turn (`claude-agent.ts` drops this session's
    // cache when the web-search verdict moves), so reading them here is stable
    // for the cache's lifetime.
    //
    // The gate runs on the RESULT rather than as an option to
    // `getSessionToolDefs`, because that function deliberately does not apply it
    // (P3.276: it also answers the Explore/Safe classification, which is called
    // with no per-session facts, and a gate inside it refused a read-only diff
    // in Explore on every runtime). Handing it `reviewDiffPort` and stopping
    // there was the defect P6.895 names: nothing reads the option in there, so
    // `ReviewDiff` was advertised to claude with no port bound.
    //
    // Default OFF for both facts, and the default is the safety: an unbound
    // `ReviewDiff` reached `handleReviewDiff` only to be refused by name, and
    // claude's `WebSearch` is native and kept for a connection stamped
    // `wire: 'anthropic-messages'`, so building ours unconditionally would put
    // two search tools in front of that model. The handler's by-name refusal
    // stays as the second line: the registry still sees both tools, so a call
    // that arrives anyway is answered rather than lost.
    tools = withHostPortGate(
      getSessionToolDefs({ includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback })
        .filter(def => def.handler !== null), // Skip backend-specific tools (call_llm)
      getSessionScopedToolCallbacks(key),
    )
      .map(def => {
        const shape = (def.inputSchema as { shape?: unknown }).shape
          ?? flattenDiscriminatedUnionForSdkTool(def.inputSchema);
        if (!shape) throw new Error(`claude-session-tool-schema-not-object:${def.name}`);
        return registryTool(def.name, shape);
      });

    // Add call_llm — backend-specific (not in registry handler)
    tools.push(
      createLLMTool({
        sessionId,
        sessionPath,
        // F1.694 — the attachments this tool reads pass the floor that refuses `Read` of them; F1.709 — judged on the claude gate's own (pinned) context, read per call; F1.1116 — readable rules anchored at the working directory, as `Read`'s are.
        attachmentReadGuard: callLlmAttachmentReadGuard(() => getSessionScopedToolCallbacks(key)?.gatePermissionsContextFn?.() ?? { workspaceRootPath }, () => workingDirectory),
        getQueryFn: () => {
          const callbacks = getSessionScopedToolCallbacks(key);
          return callbacks?.queryFn;
        },
        // F1.757 — read per call, like `getQueryFn`: the ids the session's own connection serves.
        getConnectionModelIds: () => getSessionScopedToolCallbacks(key)?.connectionModelIds?.(),
      }),
    );

    // Add advisor_consult — backend-specific (P2.1), gated by `advisorEnabled`
    // exactly as the browser tools below are gated by `browserToolEnabled`.
    //
    // The gate is here and NOT only at call time: the advisor ships OFF, and an
    // opt-in feature that is off must not spend schema on every session or show
    // up in the /context breakdown of a user who never enabled it. The cached
    // tools array is not an argument against it — `setAdvisorEnabled` clears
    // that cache (as `setBrowserToolEnabled` does), so a toggle lands on the
    // next turn. `BaseAgent.executeAdvisorConsult` keeps its own read of the
    // setting as the second belt.
    if (getAdvisorEnabled()) {
      tools.push(
        createAdvisorConsultTool({
          getConsultFn: () => getSessionScopedToolCallbacks(key)?.advisorConsultFn,
        }),
      );
    }

    // Add spawn_session — backend-specific (not in registry handler)
    tools.push(
      createSpawnSessionTool({
        sessionId,
        getSpawnSessionFn: () => {
          const callbacks = getSessionScopedToolCallbacks(key);
          return callbacks?.spawnSessionFn;
        },
      }),
    );

    // Add browser_* tools — backend-specific (requires BrowserPaneManager in Electron)
    // Gated by the "Built-in browser" setting so users with external browser tools
    // (Playwright, Puppeteer, etc.) can disable the built-in one.
    if (getBrowserToolEnabled()) {
      tools.push(
        ...createBrowserTools({
          sessionId,
          getBrowserPaneFns: () => {
            const callbacks = getSessionScopedToolCallbacks(key);
            return callbacks?.browserPaneFns;
          },
        }),
      );
    }

    sessionToolsCache.set(cacheKey, tools);
  }

  // Always create a fresh MCP server wrapper to avoid "Already connected to a transport"
  // race condition when queries are sent back-to-back (see comment on sessionToolsCache).
  return createSdkMcpServer({
    name: 'session',
    version: '1.0.0',
    tools,
  });
}

// F1.475 — appended rather than grouped with the imports above so every docs-cited line keeps its number; ES
// imports are hoisted, so its position changes nothing at run time. See the module's docblock for why a scope.
import { runInSessionToolCall, sessionToolCallOriginOf } from './backend/claude/session-tool-call-origin.ts';
import { callLlmAttachmentReadGuard } from './mode-manager.ts';
