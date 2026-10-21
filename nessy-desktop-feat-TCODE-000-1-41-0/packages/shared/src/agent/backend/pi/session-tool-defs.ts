/**
 * Pi Session Tool Proxy Definitions
 *
 * Thin wrapper around the canonical tool definitions in @nessy-agent/session-tools-core.
 * Adds the `mcp__session__` prefix that the Pi SDK expects.
 */

import {
  getToolDefsAsJsonSchema,
  SESSION_TOOL_NAMES,
  type JsonSchemaToolDef,
} from '@nessy-agent/session-tools-core';
import { FEATURE_FLAGS } from '../../../feature-flags.ts';

export type SessionToolProxyDef = JsonSchemaToolDef;

export { SESSION_TOOL_NAMES };

/** The prefix every internal session tool is advertised under to the Pi SDK. */
export const SESSION_TOOL_PREFIX = 'mcp__session__';

/**
 * Whether a tool name is one of Nessy's own session tools, advertised in MCP
 * spelling for the Pi SDK's benefit. These are SYSTEM tools: no user MCP server
 * supplies them, so any surface that splits system vs MCP-server tools (the
 * /context breakdown, the capability catalog's `kind`) must read this predicate
 * rather than a bare `mcp__` prefix check — the bare check files ~50 internal
 * tools under "MCP tools" with zero servers connected.
 */
export function isSessionProxyToolName(name: string): boolean {
  return name.startsWith(SESSION_TOOL_PREFIX);
}

export function getSessionToolProxyDefs(options?: { decidePort?: boolean }): SessionToolProxyDef[] {
  return getToolDefsAsJsonSchema({
    prefix: SESSION_TOOL_PREFIX,
    includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
    projection: 'pi',
    // UB6.11 — forwarded verbatim into the canonical filter (the function takes
    // the whole options type, so a new field cannot be lost). Absent = the
    // default OFF: the static Pi projection every existing caller and pin reads
    // carries no `decide`; the per-turn builder passes the port fact.
    ...options,
  });
}
