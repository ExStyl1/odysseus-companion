/**
 * @license
 * Copyright 2025 Nessy CLI Team
 * SPDX-License-Identifier: Apache-2.0
 */

// ---------------------------------------------------------------------------
// Shared ACP route table
// ---------------------------------------------------------------------------
// Single source of truth for the URL→JSON-RPC mapping used by both
// `AcpWsTransport` and `AcpHttpTransport`. Keeping a single table
// prevents route inconsistencies between the two transport variants.
// ---------------------------------------------------------------------------

import { isRecord } from './acpTransportUtils.js';

export interface RouteMapping {
  method: string;
  /** Extract JSON-RPC params from URL path segments + request body. */
  extractParams: (
    segments: string[],
    body: unknown,
    httpMethod: string,
  ) => Record<string, unknown>;
  /**
   * True for notifications (no response expected). The transport will
   * NOT wait for a JSON-RPC response from the server.
   */
  notification?: boolean;
}

export interface RouteEntry {
  httpMethod: string;
  pattern: RegExp;
  mapping: RouteMapping;
}

/**
 * Map of `METHOD PATH_PATTERN` to JSON-RPC method + params extractor.
 * Path segments are split by `/` after stripping the base URL prefix.
 *
 * Pattern conventions:
 *   - `:param` = named path param (consumed positionally)
 *   - `*`      = rest wildcard
 */
export const ROUTE_TABLE: readonly RouteEntry[] = [
  // POST /session → session/new
  // ACP standard: session/new always creates an isolated session.
  // Strip non-standard params (sessionScope) — the server enforces
  // 'thread' regardless, so passing it is harmless but misleading.
  {
    httpMethod: 'POST',
    pattern: /^\/session\/?$/,
    mapping: {
      method: 'session/new',
      extractParams: (_s, body) => {
        if (!isRecord(body)) return {};
        const { sessionScope: _, ...rest } = body as Record<string, unknown>;
        return rest;
      },
    },
  },
  // POST /session/:id/prompt → session/prompt
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/prompt$/,
    mapping: {
      method: 'session/prompt',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/cancel → session/cancel (notification)
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/cancel$/,
    mapping: {
      method: 'session/cancel',
      extractParams: (segs) => ({ sessionId: segs[0] }),
      notification: true,
    },
  },
  // DELETE /session/:id → session/close
  {
    httpMethod: 'DELETE',
    pattern: /^\/session\/([^/]+)\/?$/,
    mapping: {
      method: 'session/close',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // POST /session/:id/load → session/load
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/load$/,
    mapping: {
      method: 'session/load',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/resume → session/resume
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/resume$/,
    mapping: {
      method: 'session/resume',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/permission/:reqId → session/permission
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/permission\/([^/]+)$/,
    mapping: {
      method: 'session/permission',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        requestId: segs[1],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /permission/:reqId (without session prefix)
  {
    httpMethod: 'POST',
    pattern: /^\/permission\/([^/]+)$/,
    mapping: {
      method: 'session/permission',
      extractParams: (segs, body) => ({
        requestId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/model → session/set_model
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/model$/,
    mapping: {
      method: 'session/set_model',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // GET /capabilities → use initialize result (handled specially)
  {
    httpMethod: 'GET',
    pattern: /^\/capabilities\/?$/,
    mapping: {
      method: '_capabilities',
      extractParams: () => ({}),
    },
  },
  // GET /health
  {
    httpMethod: 'GET',
    pattern: /^\/health\/?$/,
    mapping: {
      method: '_nessy/health',
      extractParams: () => ({}),
    },
  },

  // ---- Vendor session extensions (_nessy/ prefix) -------------------------

  // PATCH /session/:id/metadata → _nessy/session/update_metadata
  {
    httpMethod: 'PATCH',
    pattern: /^\/session\/([^/]+)\/metadata$/,
    mapping: {
      method: '_nessy/session/update_metadata',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/heartbeat → _nessy/session/heartbeat
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/heartbeat$/,
    mapping: {
      method: '_nessy/session/heartbeat',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/recap → _nessy/session/recap
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/recap$/,
    mapping: {
      method: '_nessy/session/recap',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/btw → _nessy/session/btw
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/btw$/,
    mapping: {
      method: '_nessy/session/btw',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/shell → _nessy/session/shell
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/shell$/,
    mapping: {
      method: '_nessy/session/shell',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/branch → session/fork
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/branch$/,
    mapping: {
      method: 'session/fork',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /session/:id/detach → _nessy/session/detach
  {
    httpMethod: 'POST',
    pattern: /^\/session\/([^/]+)\/detach$/,
    mapping: {
      method: '_nessy/session/detach',
      extractParams: (segs, body) => ({
        sessionId: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },

  // ---- Session diagnostic routes (_nessy/ prefix) -------------------------

  // GET /session/:id/context → _nessy/session/context
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/context$/,
    mapping: {
      method: '_nessy/session/context',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // GET /session/:id/context-usage → _nessy/session/context_usage
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/context-usage$/,
    mapping: {
      method: '_nessy/session/context_usage',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // GET /session/:id/supported-commands → _nessy/session/supported_commands
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/supported-commands$/,
    mapping: {
      method: '_nessy/session/supported_commands',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // GET /session/:id/tasks → _nessy/session/tasks
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/tasks$/,
    mapping: {
      method: '_nessy/session/tasks',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },
  // GET /session/:id/lsp -> _nessy/session/lsp
  {
    httpMethod: 'GET',
    pattern: /^\/session\/([^/]+)\/lsp$/,
    mapping: {
      method: '_nessy/session/lsp',
      extractParams: (segs) => ({ sessionId: segs[0] }),
    },
  },

  // ---- Granular workspace routes (_nessy/workspace/*) ---------------------

  // GET /workspace/mcp → _nessy/workspace/mcp
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/mcp\/?$/,
    mapping: {
      method: '_nessy/workspace/mcp',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/skills → _nessy/workspace/skills
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/skills\/?$/,
    mapping: {
      method: '_nessy/workspace/skills',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/providers → _nessy/workspace/providers
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/providers\/?$/,
    mapping: {
      method: '_nessy/workspace/providers',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/env → _nessy/workspace/env
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/env\/?$/,
    mapping: {
      method: '_nessy/workspace/env',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/preflight → _nessy/workspace/preflight
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/preflight\/?$/,
    mapping: {
      method: '_nessy/workspace/preflight',
      extractParams: () => ({}),
    },
  },
  // POST /workspace/init → _nessy/workspace/init
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/init\/?$/,
    mapping: {
      method: '_nessy/workspace/init',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // GET /workspace/tools → _nessy/workspace/tools
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/tools\/?$/,
    mapping: {
      method: '_nessy/workspace/tools',
      extractParams: () => ({}),
    },
  },
  // GET /workspace/memory → _nessy/workspace/memory
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/memory\/?$/,
    mapping: {
      method: '_nessy/workspace/memory',
      extractParams: () => ({}),
    },
  },
  // POST /workspace/memory → _nessy/workspace/memory/write
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/memory\/?$/,
    mapping: {
      method: '_nessy/workspace/memory/write',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // GET /workspace/agents → _nessy/workspace/agents/list
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/agents\/?$/,
    mapping: {
      method: '_nessy/workspace/agents/list',
      extractParams: () => ({}),
    },
  },
  // POST /workspace/agents → _nessy/workspace/agents/create
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/agents\/?$/,
    mapping: {
      method: '_nessy/workspace/agents/create',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // GET /workspace/agents/:agentType → _nessy/workspace/agents/get
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/agents\/([^/]+)\/?$/,
    mapping: {
      method: '_nessy/workspace/agents/get',
      extractParams: (segs) => ({ agentType: segs[0] }),
    },
  },
  // DELETE /workspace/agents/:agentType → _nessy/workspace/agents/delete
  {
    httpMethod: 'DELETE',
    pattern: /^\/workspace\/agents\/([^/]+)\/?$/,
    mapping: {
      method: '_nessy/workspace/agents/delete',
      extractParams: (segs, body) => ({
        agentType: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // GET /workspace/mcp/:server/tools → _nessy/workspace/mcp/tools
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/mcp\/([^/]+)\/tools\/?$/,
    mapping: {
      method: '_nessy/workspace/mcp/tools',
      extractParams: (segs) => ({ serverName: segs[0] }),
    },
  },
  // POST /workspace/mcp/servers → _nessy/workspace/mcp/servers/add
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/mcp\/servers\/?$/,
    mapping: {
      method: '_nessy/workspace/mcp/servers/add',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // DELETE /workspace/mcp/servers/:name → _nessy/workspace/mcp/servers/remove
  {
    httpMethod: 'DELETE',
    pattern: /^\/workspace\/mcp\/servers\/([^/]+)\/?$/,
    mapping: {
      method: '_nessy/workspace/mcp/servers/remove',
      extractParams: (segs, body) => ({
        name: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // POST /workspace/set-tool-enabled → _nessy/workspace/set_tool_enabled
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/set-tool-enabled\/?$/,
    mapping: {
      method: '_nessy/workspace/set_tool_enabled',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // POST /workspace/mcp/:server/restart → _nessy/workspace/restart_mcp_server
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/mcp\/([^/]+)\/restart\/?$/,
    mapping: {
      method: '_nessy/workspace/restart_mcp_server',
      extractParams: (segs, body) => ({
        serverName: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },
  // GET /workspace/auth/status → _nessy/workspace/auth/status
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/auth\/status\/?$/,
    mapping: {
      method: '_nessy/workspace/auth/status',
      extractParams: () => ({}),
    },
  },
  // POST /workspace/auth/device-flow → _nessy/workspace/auth/device_flow/start
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/auth\/device-flow\/?$/,
    mapping: {
      method: '_nessy/workspace/auth/device_flow/start',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // GET /workspace/auth/device-flow/:id → _nessy/workspace/auth/device_flow/get
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/auth\/device-flow\/([^/]+)\/?$/,
    mapping: {
      method: '_nessy/workspace/auth/device_flow/get',
      extractParams: (segs) => ({ id: segs[0] }),
    },
  },
  // DELETE /workspace/auth/device-flow/:id → _nessy/workspace/auth/device_flow/cancel
  {
    httpMethod: 'DELETE',
    pattern: /^\/workspace\/auth\/device-flow\/([^/]+)\/?$/,
    mapping: {
      method: '_nessy/workspace/auth/device_flow/cancel',
      extractParams: (segs) => ({ id: segs[0] }),
    },
  },

  // ---- Workspace catch-all (must be AFTER all specific workspace routes) --
  // Handles any workspace path not matched above (e.g., /workspace/custom/path).
  {
    httpMethod: 'GET',
    pattern: /^\/workspace\/(.+)$/,
    mapping: {
      method: '_nessy/workspace',
      extractParams: (segs) => ({ path: segs[0] }),
    },
  },
  {
    httpMethod: 'POST',
    pattern: /^\/workspace\/(.+)$/,
    mapping: {
      method: '_nessy/workspace',
      extractParams: (segs, body) => ({
        path: segs[0],
        ...(isRecord(body) ? body : {}),
      }),
    },
  },

  // ---- File system routes -----------------------------------------------
  // These map the DaemonClient's file-system helpers to _nessy/file/* RPC
  // methods on the ACP daemon.

  // GET /file → _nessy/file/read (query params forwarded as RPC params)
  {
    httpMethod: 'GET',
    pattern: /^\/file\/?$/,
    mapping: {
      method: '_nessy/file/read',
      extractParams: () => ({}),
    },
  },
  // GET /file/bytes → _nessy/file/read_bytes
  {
    httpMethod: 'GET',
    pattern: /^\/file\/bytes\/?$/,
    mapping: {
      method: '_nessy/file/read_bytes',
      extractParams: () => ({}),
    },
  },
  // GET /stat → _nessy/file/stat
  {
    httpMethod: 'GET',
    pattern: /^\/stat\/?$/,
    mapping: {
      method: '_nessy/file/stat',
      extractParams: () => ({}),
    },
  },
  // GET /list → _nessy/file/list
  {
    httpMethod: 'GET',
    pattern: /^\/list\/?$/,
    mapping: {
      method: '_nessy/file/list',
      extractParams: () => ({}),
    },
  },
  // GET /glob → _nessy/file/glob
  {
    httpMethod: 'GET',
    pattern: /^\/glob\/?$/,
    mapping: {
      method: '_nessy/file/glob',
      extractParams: () => ({}),
    },
  },
  // POST /file/write → _nessy/file/write
  {
    httpMethod: 'POST',
    pattern: /^\/file\/write\/?$/,
    mapping: {
      method: '_nessy/file/write',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
  // POST /file/edit → _nessy/file/edit
  {
    httpMethod: 'POST',
    pattern: /^\/file\/edit\/?$/,
    mapping: {
      method: '_nessy/file/edit',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },

  // ---- Bulk session operations -------------------------------------------

  // POST /sessions/delete → _nessy/sessions/delete
  {
    httpMethod: 'POST',
    pattern: /^\/sessions\/delete\/?$/,
    mapping: {
      method: '_nessy/sessions/delete',
      extractParams: (_s, body) => (isRecord(body) ? body : {}),
    },
  },
];
