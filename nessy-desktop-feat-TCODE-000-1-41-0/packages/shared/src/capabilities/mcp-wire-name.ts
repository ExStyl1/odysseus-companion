// Wire-name mint for plugin-bundled MCP servers. Contract: mcp.md:357/365 —
// plugin servers are ALWAYS namespaced by plugin identity; the name is a pure
// function of (pluginId, serverName) so projection, resolver, and translation
// compute it identically with no registry state.
//
// The digest is the ISOMORPHIC SHA-256 of `../utils/sha256-isomorphic.ts`, not
// `node:crypto`'s, and deliberately so (P6.971, 2026-09-10): this module is
// reached from the RENDERER through `capabilities/views.ts`, and in a Vite
// production build every browser-externalized builtin is one stub whose body is
// `export default {}`, so `import { createHash } from 'node:crypto'` here was a
// hard rollup error that failed the packaged build. The two digests are
// byte-identical — `__tests__/mcp-wire-name.test.ts` and
// `../utils/__tests__/sha256-isomorphic.test.ts` pin that against `node:crypto`
// over a corpus — so NO wire name changes; that was the controller's decision,
// because a wire name is a contract every projection/resolver/translation site
// recomputes.
import { sha256Hex } from '../utils/sha256-isomorphic.ts'

const sha6 = (value: string): string => sha256Hex(value).slice(0, 6)

/**
 * `mcp.md:357` sanitization + collapse `_` runs so `mcp__<wire>__<tool>`
 * stays parseable: non-`[A-Za-z0-9_-]` runs collapse to a single `_`, `_`
 * runs collapse further, and leading/trailing `_` are trimmed.
 *
 * F3 (2026-08-11): extracted and exported so every mint site can sanitize,
 * not just `pluginMcpWireName` below — `capMcpNameSegment` truncates but
 * never sanitizes, and until this fix a scoped/native/builtin wire name went
 * through the cap alone, so a space or a dot in a `.mcp.json` server name
 * survived straight into the wire name and broke
 * `tryParsePiDynamicMcpBindingName`'s `[A-Za-z0-9_-]` regex. Sanitize THEN
 * cap at every call site — capping first can leave a trailing `_` this would
 * have trimmed, and the cap's hash tail must be computed over the value
 * actually used.
 */
export function sanitizeMcpNameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '')
}

/** Truncate to `max` with a deterministic 6-hex tail when over. The slice is
 *  right-trimmed of `_` so the joint never forms a `__` run (parseability). */
export function capMcpNameSegment(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max - 7).replace(/_+$/, '')}_${sha6(value)}`
}

export function pluginMcpWireName(pluginId: string, serverName: string): string {
  const raw = `plugin_${sanitizeMcpNameSegment(pluginId) || 'plugin'}_${sanitizeMcpNameSegment(serverName) || 'server'}`
  return capMcpNameSegment(raw.replace(/_{2,}/g, '_'), 40)
}

export function pluginIdFromInstanceId(instanceId: string): string | null {
  const match = /^plugin:\/\/[^/]+\/([^@#/]+)@/.exec(instanceId)
  return match?.[1] ?? null
}

/**
 * Compatibility rewrite for plugin CONTENT (hooks/skills/agents) that names a
 * plugin's OWN bundled MCP server by bare short name instead of the qualified
 * `mcp__plugin_<id>_<server>__<tool>` form (`mcp.md:363`: a bare reference
 * "never fires" for a plugin server in Claude either, so this only helps
 * legacy content). Anything else — an already-qualified reference (this mint's
 * own output has no `__` runs, so the greedy first group still splits on the
 * LAST `__` and parses a wire-name `serverRef` that is never in
 * `ownServerNames`), a foreign server, or a non-MCP tool name — passes through
 * unchanged.
 */
export function translatePluginMcpToolName(
  raw: string,
  pluginId: string,
  ownServerNames: ReadonlySet<string>,
): string {
  const match = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/.exec(raw)
  if (!match) return raw
  const [, serverRef, toolSegment] = match
  if (!ownServerNames.has(serverRef!)) return raw
  return `mcp__${pluginMcpWireName(pluginId, serverRef!)}__${toolSegment}`
}

/**
 * F1.155 — the namespace codex puts a pool tool under, at the pinned
 * `openai/codex@rust-v0.154.0` (`packages/codex-protocol/manifest.json`).
 *
 * The host hands codex its whole source pool as ONE MCP server,
 * `[mcp_servers.sources]` (`codex-responses-adapter/src/config-writer.ts`), and
 * codex files every tool of a regular MCP server under a namespace named after
 * that server (`codex-mcp/src/rmcp_client.rs`,
 * `regular_mcp_tool_info_from_listed_tool`: `callable_namespace:
 * server_name`), sanitized and given the legacy `mcp__` prefix
 * (`codex-mcp/src/tools.rs`, `callable_namespace_with_prefix`). The prefix is
 * dropped only under the `non_prefixed_mcp_tool_names` feature, which is
 * `Stage::UnderDevelopment`, `default_enabled: false`
 * (`features/src/lib.rs`), and this host never writes it.
 */
export const CODEX_POOL_TOOL_NAMESPACE = 'mcp__sources'

/**
 * F1.155 — the function name a CODEX model is handed for a pool tool, which is
 * NOT the name the host records for the call.
 *
 * `wireName` is the pool's wire name (the `<wire>` of the pool's own
 * `mcp__<wire>__<tool>`); `toolName` is the tool's own name. The pool bridge
 * exposes the tool to codex as `<wire>__<tool>` (`mcp/pool-server.ts`,
 * `createMcpServer`), and codex's model-visible NAME for it is that string
 * through `sanitize_responses_api_tool_name` (`codex-mcp/src/mcp/mod.rs`):
 * every character that is not an ASCII letter, digit or `_` becomes `_` — a
 * hyphen included, one `_` per character (Rust `chars()`, so per code point),
 * and an empty result is `_`. So `plugin_cdp-echo-probe_echo` + `whoami` is
 * handed as `plugin_cdp_echo_probe_echo__whoami`.
 *
 * The namespace ({@link CODEX_POOL_TOOL_NAMESPACE}) travels BESIDE the name,
 * never inside it: codex emits `{"type":"namespace","name":"mcp__sources",
 * "tools":[…]}` (`core/src/tools/handlers/mcp.rs`, `create_tool_spec`). A
 * provider that speaks Responses natively shows the model the pair; the Nessy
 * Gateway leg shows it this name ALONE, because the adapter flattens namespace
 * tools for chat-completions (`codex-responses-adapter/src/to-chat.ts`,
 * `toChatRequest`) and re-attaches the namespace on the way back
 * (`extractToolNamespaces`). The HOST row keeps codex's raw `(server, tool)`
 * pair — `mcp__sources__<wire>__<tool>`, hyphens and all — which is the
 * spelling a transcript and the UI read (a rule: {@link hostMcpToolNameForCodexRow}).
 *
 * NOT modelled, stated: codex makes a name unique by appending
 * `_<12 hex of sha1>` when two tools collide after sanitizing, and truncates
 * plus hashes when namespace + name + 2 exceeds 128 bytes
 * (`codex-mcp/src/tools.rs`, `unique_callable_parts`). Neither happens for a
 * pool whose sanitized names are distinct and under ~114 characters; outside
 * that, the name codex hands the model is this one with a hash tail.
 */
export function codexModelToolName(wireName: string, toolName: string): string {
  let out = ''
  for (const ch of `${wireName}__${toolName}`) out += /^[A-Za-z0-9_]$/.test(ch) ? ch : '_'
  return out || '_'
}

/**
 * F1.219 — the tool name codex's OWN hooks see for a pool tool, which is neither
 * the host row nor the bare name the model is handed.
 *
 * Read at `openai/codex@rust-v0.154.0`, `core/src/tools/handlers/mcp.rs`:
 * `hook_tool_name` is `ensure_mcp_prefix(join_tool_name(callable))`, where
 * `join_tool_name` joins the callable namespace ({@link CODEX_POOL_TOOL_NAMESPACE},
 * trailing `_` trimmed) and the callable name ({@link codexModelToolName},
 * leading `_` trimmed) with `__`. MEASURED on the shipped binary 2026-09-23
 * (`mcp/__tests__/codex-native-hook-matcher-live.test.ts`): a native `PreToolUse`
 * matcher spelled with the host row's hyphens did not fire, the one spelled with
 * this function's output did, and the payload's `tool_name` was this string.
 *
 * So a matcher projected into codex's `[hooks]` table must be written against
 * THIS spelling, not against `mcp__sources__<wire>__<tool>`. Today nothing is
 * projected — every hook on a codex session runs host-side and sees Pi's name,
 * {@link hostMcpToolNameForCodexRow} (F1.274 for the post-tool events and the dontAsk
 * PermissionDenied, whole since F1.371; F1.382 for the auto-review one, which named
 * the bare `<wire>__<tool>` until then; P2.414 mints none) — so this is the
 * translation the first projecting lane owes, stated where it will look.
 */
export function codexHookToolName(wireName: string, toolName: string): string {
  return `${CODEX_POOL_TOOL_NAMESPACE.replace(/_+$/, '')}__${codexModelToolName(wireName, toolName).replace(/^_+/, '')}`
}

/**
 * F1.272 — the HOST vocabulary's name for a codex MCP row: the name Pi and
 * claude record for the same call, which is what a permission rule (and a hook
 * matcher) is written against.
 *
 * Codex's row is its raw `(server, tool)` pair, so a pool tool reads
 * `mcp__sources__<wire>__<tool>` (`backend/codex/event-adapter.ts`
 * `mcpRowToolName`); Pi and claude record `mcp__<wire>__<tool>`, one segment
 * shifted past the bridge (`backend/base-event-adapter.ts` `buildMcpToolName`,
 * the same `__` test). Any other row — `mcp__session__<tool>`, or a name that is
 * not a pool row — is already the host's spelling and comes back unchanged.
 * Three spellings of one pool call, and this is the one the rules speak:
 * the model's is {@link codexModelToolName}, codex's own hooks' is
 * {@link codexHookToolName}.
 */
export function hostMcpToolNameForCodexRow(rowName: string): string {
  const prefix = `${CODEX_POOL_TOOL_NAMESPACE}__`
  if (!rowName.startsWith(prefix)) return rowName
  const rest = rowName.slice(prefix.length)
  return rest.includes('__') ? `mcp__${rest}` : rowName
}
