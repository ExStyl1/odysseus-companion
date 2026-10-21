/**
 * MCP Source Tool Callbacks
 *
 * UB7.11 — backend for the agent-facing `source_list_prompts` /
 * `source_get_prompt` session tools (upstream v0.15.1
 * `server-core/src/sources/mcp-source-tool-callbacks.ts`, prompts half; the
 * resources half is not adopted — resources stay native on Claude and codex and
 * `pi-only` on Pi, B4-06). SessionManager wires one instance per session into
 * the session-scoped tool callback registry (next to `pages`), and the codex
 * bridge reaches the SAME instance over `HOST_CALLBACK_BRIDGE_ROUTES.sourceListPrompts`
 * / `sourceGetPrompt`.
 *
 * Every call reads the session's MCP pool and enabled sources at call time
 * (the pool is replaced when the agent is recreated) and only reaches sources
 * enabled in the session. The pool itself rejects sources that are not
 * connected, API sources and servers without the capability, and does the
 * protocol work (pagination, prompt rendering, the large-result guard). This
 * module maps its objects onto the plain session-tools-core shapes.
 */

import type { McpClientPool, McpPromptListing } from '@nessy-agent/shared/mcp'
import type { McpSourcePrompt, McpSourceToolCallbacks } from '@nessy-agent/session-tools-core'

/** The pool methods the callbacks use (a structural slice, so tests can pass a fake). */
export type McpSourcePool = Pick<McpClientPool, 'listPrompts' | 'getPromptText'>

export interface McpSourceToolCallbacksDeps {
  /** The session's MCP pool, read on every call. */
  getPool: () => McpSourcePool | undefined
  /** The session's enabled source slugs, read on every call. */
  getEnabledSourceSlugs: () => readonly string[] | undefined
}

// Only the fields an agent needs: icons, annotations and _meta would cost tokens for nothing.
function toPrompt(prompt: McpPromptListing['prompts'][number]): McpSourcePrompt {
  const { name, title, description } = prompt
  return {
    name,
    title,
    description,
    arguments: prompt.arguments?.map(arg => ({ name: arg.name, description: arg.description, required: arg.required })),
  }
}

export function buildMcpSourceToolCallbacks(deps: McpSourceToolCallbacksDeps): McpSourceToolCallbacks {
  // The pool only holds the session's enabled sources; checking the slug here
  // also covers the moment a source change is still being applied to it.
  const poolFor = (sourceSlug: string): McpSourcePool => {
    const enabled = deps.getEnabledSourceSlugs() ?? []
    if (!enabled.includes(sourceSlug)) {
      throw new Error(enabled.length > 0
        ? `Source "${sourceSlug}" is not enabled in this session (enabled: ${enabled.join(', ')}).`
        : `Source "${sourceSlug}" is not enabled in this session (no sources are enabled).`)
    }
    const pool = deps.getPool()
    if (!pool) throw new Error(`Source "${sourceSlug}" is not connected yet.`)
    return pool
  }

  return {
    async listPrompts(sourceSlug) {
      const listing = await poolFor(sourceSlug).listPrompts(sourceSlug)
      return {
        prompts: listing.prompts.map(toPrompt),
        ...(listing.truncated ? { truncated: true } : {}),
      }
    },
    async getPrompt(sourceSlug, name, args) {
      return poolFor(sourceSlug).getPromptText(sourceSlug, name, args)
    },
  }
}
