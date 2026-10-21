/**
 * What an MCP tool's NAME says about its effect — ONE table, read by the host
 * gate (`mode-manager.ts`, `isReadOnlyMcpToolWithConfig`) and by the Pi
 * deferred-tool catalogue (`pi-agent-server/src/deferred-mcp-tools.ts`,
 * `catalogInput`), so the catalogue's `effect=`/`risk=` label and the gate's
 * verdict are read from the same words (F1.295). This module imports nothing: the
 * Pi subprocess loads it without the gate's module graph.
 *
 * Until F1.295 the catalogue kept a second verb table — a prefix regex with no `_`
 * boundary that also knew `lookup` — so it labelled `getIssue` a low-risk read
 * while the gate carded it, and `describe_x`/`status_x` a high-risk write while
 * the gate allowed them.
 */

/**
 * The read verbs the shipped `resources/permissions/default.json` names in its
 * verb rules (F1.258: `^mcp__<server>__<verb>(_<word>)*$`), in the file's order.
 * `shipped-mcp-read-only-anchoring.test.ts` pins that the file names exactly these.
 */
export const SHIPPED_READ_ONLY_MCP_VERBS: readonly string[] = Object.freeze([
  'search', 'list', 'get', 'read', 'info', 'describe', 'show', 'view',
  'find', 'query', 'count', 'exists', 'status', 'inspect', 'fetch',
]);

/**
 * F1.289 — the write tokens no read-only MCP verdict survives. DECIDED by the
 * controller (2026-09-23): a tool whose name carries one of these as a
 * `_`-separated word AFTER its leading word is never read-only by pattern — the
 * shipped patterns (F1.258), a source's own (F1.287, `scopeSourceMcpPattern`) and
 * a user's alike, because every one of them is consulted in
 * `isReadOnlyMcpToolWithConfig` (`mode-manager.ts`) and nowhere else.
 * `get_or_create_user`, `find_and_replace`, `status_update` and
 * `fetch_and_delete` each START with a read verb, and each answered allow in
 * Explore, `default` and `dontAsk` until this rule
 * (`mcp-read-only-write-tokens.test.ts`).
 *
 * Amended by UB1.8 (2026-10-15, upstream v0.15.1
 * `packages/shared/src/agent/mcp-tool-names.ts` `MCP_WRITE_WORDS`, Apache-2.0,
 * first shipped v0.14.0): the list is upstream's (about 120 words, covering
 * `archive`, `ack`, `cancel`, `approve`, `submit`, `retry`, …) plus OUR two —
 * `push` and `upload`, from the original decision — so every word the old list
 * had is still here and the widening only refuses. The old derivation is kept
 * below so the union stays re-derivable. Upstream's two POSITION widenings (a
 * read verb right after the source slug; a trailing read verb in a two-word
 * name) are NOT adopted — a name is read-only here only when a shipped read
 * verb LEADS it (`mcpToolNameReadsAsReadOnly`), the anchoring F1.258 chose.
 *
 * The word list is the union of three sources, each named so it can be
 * re-derived. (1) Every verb the shipped file's bash side already refuses as a
 * write (`resources/permissions/default.json`, the comments of its fd, git,
 * gh, kubectl, sed, yq, xmllint, ss, ip and `-h` entries): create, add, remove,
 * set, write, delete, drop, destroy, expire, post, edit, push, execute, run —
 * `mcp-read-only-write-tokens.test.ts` re-reads that file for each of them.
 * (2) The controller's decision (2026-09-23), which named twenty; nine of them
 * are already in (1), and the other eleven — update, replace, put, patch,
 * insert, reset, clear, move, rename, upload, send — are the decision's own. A
 * list restricted to (1) would fail the row's own control: update and replace
 * are the verbs of its measured `status_update` and `find_and_replace`.
 * (3) Upstream's `MCP_WRITE_WORDS` verbatim (UB1.8), which subsumes most of
 * (1)+(2) and adds the rest of the list below.
 *
 * Words are split on camelCase and any non-alphanumeric separator
 * ({@link mcpToolNameWords}), upstream's splitting: `fetch-and-ack`,
 * `fetchAndAck` and `fetch_and_ack` all carry `ack`, and `post-analyses` now
 * reads as `post` where the old `_`-only split kept it one word. Stated
 * residue: a READ that carries a token as a word (`get_run_status`,
 * `get_post`) takes the card too, and a write that carries none
 * (`get_and_forget`) still passes — a name is a heuristic, which is why
 * F1.288 names the builtin dp reads exactly.
 */
export const MCP_WRITE_TOKENS: ReadonlySet<string> = new Set([
  // (3) upstream v0.15.1 mcp-tool-names.ts MCP_WRITE_WORDS, verbatim
  'create', 'update', 'upsert', 'delete', 'del', 'remove', 'rm', 'destroy', 'drop', 'truncate',
  'purge', 'wipe', 'erase', 'clear', 'send', 'put', 'set', 'add', 'append', 'insert', 'write',
  'edit', 'modify', 'replace', 'rename', 'move', 'copy', 'duplicate', 'clone', 'rebase', 'revert',
  'unpublish', 'unarchive', 'reopen', 'cancel', 'approve', 'reject', 'dismiss', 'assign',
  'unassign', 'kick', 'ban', 'unban', 'unblock', 'mute', 'unmute', 'follow', 'unfollow', 'react',
  'upvote', 'downvote', 'enable', 'disable', 'activate', 'deactivate', 'restart', 'kill',
  'terminate', 'run', 'execute', 'exec', 'trigger', 'invoke', 'pay', 'buy', 'subscribe',
  'unsubscribe', 'grant', 'revoke', 'authorize', 'login', 'logout', 'reply', 'forward', 'mark',
  'submit', 'save', 'apply', 'uninstall', 'upgrade', 'downgrade', 'rollback', 'reboot',
  'shutdown', 'provision', 'allocate', 'accept', 'decline', 'attach', 'detach', 'notify', 'compose',
  'reset', 'archive', 'publish', 'deploy', 'restore', 'toggle', 'rebuild', 'refresh', 'flush',
  'optimize', 'install', 'sync', 'ack', 'confirm', 'expire', 'reindex', 'enqueue', 'dequeue', 'retry',
  // (1) the shipped file's own write side, beyond (3) — upstream deliberately
  // dropped `post` as a noun-word (`get_post`), our measured residue keeps the
  // over-refusal; `push` is ours for the same reason.
  'post', 'push',
  // (2) the controller decision's own, beyond (1)+(3)
  'upload',
]);

/**
 * UB1.8 — the words of a tool's own name, split on camelCase and on any
 * non-alphanumeric separator, lower-cased (upstream v0.15.1
 * `mcpToolNameWords`). `listIssues`, `notion-search` and `get_file_contents`
 * all read as their verbs.
 */
export function mcpToolNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(word => word.toLowerCase());
}

/** The tool segment of `mcp__<server>__<tool>` (everything after the server), or null for a non-MCP name. */
function mcpToolSegment(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null;
  const serverEnd = toolName.indexOf('__', 'mcp__'.length);
  return serverEnd < 0 ? null : toolName.slice(serverEnd + 2);
}

/**
 * F1.289 — true when a word of the TOOL segment, after its first, is one of
 * {@link MCP_WRITE_TOKENS} (case-insensitive; UB1.8's splitting). The server
 * segment is not read, and neither is the leading word, which the patterns
 * already judge — the leading-verb anchoring F1.258 chose, kept.
 */
export function mcpToolCarriesWriteToken(toolName: string): boolean {
  const segment = mcpToolSegment(toolName);
  if (segment === null) return false;
  const words = mcpToolNameWords(segment);
  return words.slice(1).some(word => MCP_WRITE_TOKENS.has(word));
}

/**
 * F1.295 — the verdict the shipped VERB rules give a tool name: its tool segment
 * starts with one of {@link SHIPPED_READ_ONLY_MCP_VERBS} as a whole `_` word
 * (case-sensitive, as the shipped regexes are) and carries no write token. The
 * gate's own answer can be WIDER — a workspace's or a source's patterns, and the
 * builtin dp exact names (F1.288), live in the host's merged config, which the Pi
 * subprocess never sees — so where the two differ the catalogue says write, the
 * conservative direction, and the gate decides.
 */
export function mcpToolNameReadsAsReadOnly(toolName: string): boolean {
  const segment = mcpToolSegment(toolName);
  // The shipped rules read `<verb>(_<word>)*` to the end: no empty word, no inner `__`.
  if (segment === null || !/^[^_]+(?:_[^_]+)*$/.test(segment)) return false;
  const leading = segment.split('_')[0] ?? '';
  return SHIPPED_READ_ONLY_MCP_VERBS.includes(leading) && !mcpToolCarriesWriteToken(toolName);
}
