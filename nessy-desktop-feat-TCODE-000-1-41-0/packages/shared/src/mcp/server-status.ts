/**
 * P6.352 — ONE shape for "what MCP servers does this session have, and what
 * state is each in", and the text report `/mcp` prints from it.
 *
 * ## The row's premise, corrected at HEAD
 *
 * The row was filed as *"there is no way to see the MCP servers a session has,
 * spot a connected-but-zero-tools one, or reconnect one — and two live SDK
 * verbs that would do it have no caller"*, naming
 * `Query.reconnectMcpServer` / `Query.toggleMcpServer`. Both are real and both
 * still have zero callers. But the verb this surface actually needed is a
 * THIRD one the row did not name, and it is a READ:
 *
 *     mcpServerStatus(): Promise<McpServerStatus[]>
 *
 * whose element carries `name`, `status` (`'connected' | 'failed' |
 * 'needs-auth' | 'pending' | 'disabled'`), an `error` *"available when status
 * is 'failed'"*, a `scope` and — decisively for this row — `tools`, *"Tools
 * provided by this server (available when connected)"*. That is the whole of
 * this row's `done_means` read half, published by the vendor and called by
 * nothing. Measured in `@anthropic-ai/claude-agent-sdk` `0.3.233` (`sdk.d.ts`
 * `McpServerStatus`, `Query.mcpServerStatus`), 0 callers over `packages` +
 * `apps`.
 *
 * ## Native-first, per runtime, and it is NOT symmetric
 *
 * - **claude** — native and complete: `Query.mcpServerStatus()` above.
 * - **codex** — native and PARTIAL: `mcpServerStatus/list` exists in
 *   `packages/codex-protocol`'s `ClientRequest` union. A sibling lane measured
 *   it against the running binary for a different row and recorded the limit
 *   verbatim: it *"returns the failed server as `serverInfo: null`, `tools:
 *   {}`, with no failure reason"*. So it answers *which servers and how many
 *   tools* and cannot answer *why one failed* — the state, not the reason.
 * - **Pi** — nothing equivalent. Pi's MCP servers are the host's pooled ones,
 *   so the pool IS the source of truth there rather than a substitute for one.
 *
 * The host is therefore the seam in the exact sense the owner rule means: one
 * shape, one report, three sources, and the residual difference (a reason on
 * claude, no reason on codex, pool state on Pi) is carried in {@link detail}
 * rather than flattened away.
 *
 * ## What is deliberately NOT here
 *
 * **Enable/disable already exists** and this module must not grow a second
 * spelling of it: `McpServersPanel.tsx`'s per-server Switch writes
 * `set-capability-enabled` for plugin servers and `setBuiltinDpMcpServerEnabled`
 * for built-ins. `Query.toggleMcpServer` is the CHILD's own view of the same
 * decision, and a second writer would let the two disagree.
 *
 * **Reconnect is a verb, not a report**, and its home is per-runtime: claude
 * has `Query.reconnectMcpServer(name)`; the host pool has NO per-server
 * reconnect at HEAD (`McpClientPool` exposes `sync`, `disconnectAll` and no
 * single-server retry), and codex's nearest is `config/mcpServer/reload`, which
 * reloads the whole configuration rather than one server. Building a
 * per-server pool retry is its own row; this module states the state and says
 * nothing it cannot do.
 */

/** The five states, spelled as the claude SDK spells them. */
export type McpServerConnectionState =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'pending'
  | 'disabled';

/** One server, from whichever of the three sources this session has. */
export interface McpServerStatusLine {
  /** The server's configured name — the pool's slug, or the SDK's `name`. */
  name: string;
  state: McpServerConnectionState;
  /**
   * Tools this server currently provides, or `null` when the source cannot say.
   *
   * `null` is NOT `0`, and conflating them is the exact defect this row is
   * about: `0` on a connected server is the "connected but useless" case a user
   * needs to see, and `null` means nobody counted. A source that returns no
   * tool array for a disconnected server reports `null`, never `0`.
   */
  toolCount: number | null;
  /**
   * A short reason, where the source publishes one. Present on claude's
   * `failed` (`McpServerStatus.error`); absent on codex, which the measurement
   * above shows carries no reason; absent on the pool, which knows a connection
   * failed but keeps the transport error at the connection.
   */
  detail?: string;
}

/** The sentence a runtime with no source at all answers with. */
export const MCP_STATUS_UNSUPPORTED_LINE =
  'This session has no MCP server inventory to report: no server pool is attached and this runtime publishes no status of its own.';

/** The sentence for a session whose inventory is genuinely empty. */
export const MCP_STATUS_EMPTY_LINE = 'This session has no MCP servers configured.';

/**
 * The "connected, and yet useless" call-out — the single distinction the row
 * exists for.
 *
 * Written as a separate line rather than a per-row suffix because it is the
 * finding, not a property: a user scanning a 29-row list for the reason a tool
 * is missing should not have to notice a `0`.
 */
export const MCP_STATUS_ZERO_TOOLS_PREFIX =
  'Connected but offering no tools (so nothing from them reaches the model):';

/** How one state reads in the report. */
const STATE_LABEL: Record<McpServerConnectionState, string> = {
  connected: 'connected',
  failed: 'failed',
  'needs-auth': 'needs sign-in',
  pending: 'connecting',
  disabled: 'disabled',
};

/**
 * Render the report `/mcp` prints.
 *
 * `null` means "this session has no source" and is deliberately distinct from
 * an empty array, which means "asked, and there are none" — the same
 * absent-versus-empty rule `/help`'s own listing follows, and for the same
 * reason: a session that cannot ask must not print a sentence that reads like
 * an answer.
 *
 * Plain English literals, no `t()`, for the measured reason every other seam
 * answer uses them: the headless `nessy-server` entry never calls
 * `setupI18n()`, and an uninitialised `t()` returns `undefined` — an empty info
 * line, indistinguishable from a command that did nothing.
 */
export function formatMcpServerStatusReport(
  lines: readonly McpServerStatusLine[] | null,
): string {
  if (lines === null) return MCP_STATUS_UNSUPPORTED_LINE;
  if (lines.length === 0) return MCP_STATUS_EMPTY_LINE;

  const sorted = [...lines].sort((left, right) => left.name.localeCompare(right.name));
  const width = Math.max(...sorted.map(line => line.name.length));

  const row = (line: McpServerStatusLine): string => {
    const tools = line.toolCount === null
      ? 'tool count unknown'
      : line.toolCount === 1 ? '1 tool' : `${line.toolCount} tools`;
    const detail = line.detail ? ` — ${line.detail}` : '';
    return `  ${line.name.padEnd(width)}  ${STATE_LABEL[line.state]}, ${tools}${detail}`;
  };

  // Only a CONNECTED server with a COUNTED zero qualifies: a failed server has
  // no tools for an uninteresting reason, and `null` means nobody counted.
  const zeroTools = sorted.filter(line => line.state === 'connected' && line.toolCount === 0);

  return [
    `MCP servers for this session (${sorted.length}):`,
    ...sorted.map(row),
    ...(zeroTools.length > 0
      ? ['', `${MCP_STATUS_ZERO_TOOLS_PREFIX} ${zeroTools.map(line => line.name).join(', ')}.`]
      : []),
  ].join('\n');
}
