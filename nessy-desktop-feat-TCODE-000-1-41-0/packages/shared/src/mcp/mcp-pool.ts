/**
 * Centralized MCP Client Pool
 *
 * Owns all MCP source connections in the main Electron process.
 * All backends (Claude, Pi) receive proxy tool definitions
 * and route tool calls through this pool instead of managing MCP connections
 * themselves.
 *
 * Benefits:
 * - One MCP code path for all backends
 * - Shared clients across sessions (e.g., same Linear connection)
 * - No credential cache files — main process has direct access
 * - Runtime source switching without session restart
 */

import {
  NessyMcpClient,
  MCP_CHANNEL_MAX_TEXT_BYTES, partitionListedTools,
  type McpClientConfig,
  type McpChannelMessage,
  type McpCapabilityKind,
  type McpElicitationContext,
  type McpElicitationHandler,
  type McpPromptGetResult,
  type McpPromptListPage,
  type McpResourceListPage,
  type McpResourceTemplatesPage,
  type McpResourceReadResult,
  type PluginMcpProcessAuthority,
  type PoolClient,
} from './client.ts';
import { isChannelMetaKey } from './channel-tag.ts';
import { ANTHROPIC_PROPERTY_NAME_PATTERN, findInvalidProperties } from './validation.ts';
import {
  MCP_CONNECT_BATCH_TIMEOUT_COMPAT_ENV,
  MCP_CONNECT_BATCH_TIMEOUT_ENV,
  MCP_STARTUP_TIMEOUT_COMPAT_ENV,
  MCP_STARTUP_TIMEOUT_ENV,
  MCP_TOOL_IDLE_TIMEOUT_COMPAT_ENV,
  MCP_TOOL_IDLE_TIMEOUT_ENV,
  MCP_TOOL_IDLE_TIMEOUT_MIN_MS,
  MCP_TOOL_TIMEOUT_COMPAT_ENV,
  MCP_TOOL_TIMEOUT_ENV,
  mcpConnectBatchTimeoutMsFromEnv,
  mcpConnectionNonBlockingFromEnv,
  mcpDefaultToolTimeoutMsFromEnv,
  readMcpTimeoutEnv,
} from './server-config-values.ts';
import { ApiSourcePoolClient } from './api-source-pool-client.ts';
import { McpHeadersHelperError, resolveMcpDynamicHeaders } from './headers-helper.ts';
import type { ToolDescriptorStore } from './tool-descriptor-store.ts';
import type { McpServerStatusLine } from './server-status.ts';
import type { McpHeadersHelperSpec, SdkMcpServerConfig } from '../agent/backend/types.ts';
import type { ElicitRequest, ElicitResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  isDeniedNetworkTarget,
  validateWsWatchInput,
  type NetworkAddressGuardResult,
} from '../config/network-address-guard.ts';
import { isLocalMcpEnabled } from '../workspaces/storage.ts';
import { capMcpNameSegment } from '../capabilities/mcp-wire-name.ts';
import { estimateTokensDensityAware, guardLargeResult } from '../utils/large-response.ts';
import {
  MCP_OUTPUT_WARN_TOKENS,
  mcpOutputTokenLimit,
} from '../config/mcp-output-settings.ts';
import {
  saveBinaryResponse,
  detectExtensionFromMagic,
  sanitizeFilename,
} from '../utils/binary-detection.ts';

/**
 * Configuration for an in-process API source server.
 * Used by sync() to connect API sources alongside MCP sources.
 */
export interface ApiServerConfig {
  type: 'sdk';
  instance: McpServer;
}

interface RevisionedDesired<T> {
  config: T;
  revision: number;
  connectionKey: string;
}

interface DesiredConnection<T> extends RevisionedDesired<T> {
  slug: string;
}

interface McpContextCatalog {
  resources?: unknown[];
  /** UB7.10 — optional within the resources capability; absent = the server answered none (or method-not-found). */
  resourceTemplates?: unknown[];
  prompts?: unknown[];
}

type McpContextCapabilityKind = Exclude<McpCapabilityKind, 'tools'>;

// The post-connect `resources/list` / `prompts/list` discovery calls retry
// transient network and 5xx server errors up to three attempts with short
// backoff, and never retry auth errors, 4xx responses, or timeouts. This mirrors
// Claude Code's documented capability-discovery retry (mcp.md): before it, a
// single transient blip during a refresh replaced the catalog with an empty list.
const CONTEXT_DISCOVERY_RETRY_ATTEMPTS = 3;
const CONTEXT_DISCOVERY_RETRY_BASE_DELAY_MS = 200;

// ============================================================
// MCP source prompts (UB7.11, upstream v0.15.1 `mcp-pool.ts`) — the listing
// shape the source_*_prompts session tools read, and the page walker their
// listing follows. The resource arms of the same upstream block
// (`McpResourceListing`, the template pages, `readResource`'s guard) are
// UB7.10's and land there; this half is shaped so they slot in beside it.
// ============================================================

/** The fields of a prompt listing entry the agent-facing projection reads. */
export interface McpPromptListEntry {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

/** Prompts a source publishes. */
export interface McpPromptListing {
  prompts: McpPromptListEntry[];
  /** Listing stopped at the page cap while the server still had pages */
  truncated: boolean;
}

/**
 * Resources a source publishes — and its resource templates, which are OPTIONAL
 * within the resources capability: servers without any often answer
 * `-32601 Method not found`, so a failed template list yields none instead of
 * failing the call (UB7.10, upstream v0.15.1 `McpResourceListing`).
 */
export interface McpResourceListing {
  resources: unknown[];
  resourceTemplates: unknown[];
  /** Listing stopped at the page cap while the server still had pages */
  truncated: boolean;
}

/** Pages read per list call: a server that keeps paginating must not stall the turn. */
const MAX_LIST_PAGES = 10;

interface McpListPage<T> {
  items: T[];
  nextCursor?: string;
}

/**
 * Follow `nextCursor` up to MAX_LIST_PAGES. A cursor the server already returned
 * ends the walk: following it would only repeat pages. (Upstream v0.15.1
 * `readAllPages`, verbatim behaviour; the resource list walkers join with
 * UB7.10.)
 */
async function readAllPages<T>(readPage: (cursor?: string) => Promise<McpListPage<T>>): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await readPage(cursor);
    items.push(...result.items);
    if (!result.nextCursor || seen.has(result.nextCursor)) {
      return { items, truncated: Boolean(result.nextCursor) };
    }
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return { items, truncated: true };
}

/** Page reader for prompt listings; callers check that the client has the method. */
const promptPages = (client: PoolClient) =>
  async (cursor?: string): Promise<McpListPage<McpPromptListEntry>> => {
    const page: McpPromptListPage = await client.listPrompts!(cursor);
    return { items: page.prompts as McpPromptListEntry[], nextCursor: page.nextCursor };
  };

/** UB7.10 — page readers for the resource and resource-template listings. */
const resourcePages = (client: PoolClient) =>
  async (cursor?: string): Promise<McpListPage<unknown>> => {
    const page: McpResourceListPage = await client.listResources!(cursor);
    return { items: page.resources, nextCursor: page.nextCursor };
  };
const resourceTemplatePages = (client: PoolClient) =>
  async (cursor?: string): Promise<McpListPage<unknown>> => {
    const page: McpResourceTemplatesPage = await client.listResourceTemplates!(cursor);
    return { items: page.resourceTemplates, nextCursor: page.nextCursor };
  };

/**
 * Extract an HTTP status code from an MCP transport error. The streamable-HTTP
 * transport surfaces the status on `code`/`status`/`statusCode`; MCP JSON-RPC
 * errors instead carry negative codes, which fall outside the HTTP range and are
 * correctly ignored here.
 */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  for (const key of ['status', 'statusCode', 'code'] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return undefined;
}

function isTransientNetworkError(error: unknown): boolean {
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED']);
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.code === 'string' && codes.has(record.code)) return true;
    const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
    if (message.includes('fetch failed') || message.includes('socket hang up') || message.includes('network')) return true;
    current = record.cause;
  }
  return false;
}

/**
 * Retry only positively-identified transient failures: an HTTP 5xx or a
 * transport-level network error. Auth errors, 4xx responses (including 401/403),
 * timeouts, and unclassifiable errors are NOT retried — retrying a permanent
 * failure only triples the latency before the keep-on-failure path takes over.
 */
function isRetryableDiscoveryError(error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status !== undefined) return status >= 500 && status <= 599;
  return isTransientNetworkError(error);
}

/**
 * The status of an AUTH rejection — 401 or 403 — found anywhere in the error's
 * cause chain, or `undefined` for every other failure.
 *
 * Deliberately a SEPARATE predicate from {@link isRetryableDiscoveryError},
 * not a widening of it: that one decides RETRY, and its exclusion of 4xx is
 * correct and unchanged. This one decides ATTRIBUTION — a 401/403 is the
 * server saying the credential is wrong, which is a sign-in prompt rather than
 * a broken server, and until H1 that difference was invisible to the user
 * (the only needs-auth signal was an EMPTY credential slot, so a revoked or
 * expired token read as "this server is broken").
 *
 * The cause chain is walked because `NessyMcpClient.connect` re-wraps a failing
 * post-handshake health check, and a server that accepts `initialize` and then
 * 401s on `tools/list` carries its status only on `cause`.
 */
function authFailureStatusOf(error: unknown): 401 | 403 | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const status = httpStatusOf(current);
    if (status === 401 || status === 403) return status;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

type ProxyRoute = { slug: string; originalName: string };

function desiredConnectionUnion<T>(
  desiredByLeaser: Map<string, Map<string, RevisionedDesired<T>>>,
): Map<string, DesiredConnection<T>> {
  const union = new Map<string, DesiredConnection<T>>();
  for (const desired of desiredByLeaser.values()) {
    for (const [slug, candidate] of desired) {
      const current = union.get(candidate.connectionKey);
      if (!current || candidate.revision > current.revision) {
        union.set(candidate.connectionKey, { slug, ...candidate });
      }
    }
  }
  return union;
}

function sameConnectionIdentitySet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const connectionKey of left) {
    if (!right.has(connectionKey)) return false;
  }
  return true;
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableJson(child)]),
  );
}

/**
 * The identity that decides which sessions SHARE one transport (P3.371).
 *
 * ## The radius, stated because no page states it
 *
 * Without an `isolationTerm` this is `sha256(stableJson(config))` and nothing
 * else, so two sessions in the same workspace whose materialized config is
 * byte-identical share ONE transport, ONE `initialize`, ONE `Mcp-Session-Id`,
 * and every tool call from both rides it. That is a real product posture and
 * neither `mcp.md` nor codex's own pages say what the radius should be, so it is
 * decided here, transparently: SHARED is the default, because it is what shipped
 * and because the connection-count cost of the alternative is paid per session
 * per server (measured in `tests/mcp-pool.test.ts`), and the alternative is
 * available as a lever rather than as a rewrite.
 *
 * `DA3.2` added a THIRD spelling to that lever, {@link McpConnectionIsolation}'s
 * `by-transport`, so the question can be answered per TRANSPORT instead of per
 * pool — see {@link SHARED_TRANSPORTS_DEFAULT} for the table and for the
 * measurement that kept it OPT-IN rather than making it the default.
 *
 * ## The half a config digest cannot see
 *
 * Static `headers` ARE in the config, so two sessions carrying different static
 * credentials already split the key. A `headersHelper` is not: the digest covers
 * the SPEC (`{command, cwd?, pluginRoot?}`) and never the resolved values, by
 * design — "the RESOLVED headers exist only on the client config … so reconnects
 * keep their connection identity" ({@link McpClientPool.openConnection}, which
 * is where that sentence moved when `DA3.6` split the seam out of `connect`). So two
 * sessions declaring the SAME helper share one connection carrying whichever
 * token resolved first. {@link McpClientPool.reportSharedDynamicHeaderConnections}
 * names that case rather than leaving it silent; the lever below is how an
 * operator acts on it.
 *
 * @param isolationTerm appended as a FOURTH element when the pool is running
 * per-leaser. Fourth and not folded into the digest so
 * {@link toolDescriptorStoreKey} can strip it — the durable descriptor cache is
 * keyed by what the SERVER is, which isolation must not change, or every
 * isolated session takes a permanent cache miss and the store grows without
 * bound.
 */
function mcpConnectionKey(slug: string, config: SdkMcpServerConfig, isolationTerm?: string): string {
  const identity = createHash('sha256').update(JSON.stringify(stableJson(config))).digest('hex');
  return isolationTerm === undefined
    ? JSON.stringify(['mcp', slug, identity])
    : JSON.stringify(['mcp', slug, identity, isolationTerm]);
}

/**
 * The connection key with any per-leaser isolation term removed — the identity
 * the DURABLE tool-descriptor store is keyed by.
 *
 * The store answers "what tools did this server report last time", and that is a
 * property of the server, not of which session is holding the socket. Keying it
 * by the isolated connection key would make every session's first sync a miss
 * (the leaser id is fresh per setup, so no record is ever read twice) and would
 * grow the store by one record per session per server, forever. Non-`mcp` keys
 * and un-isolated keys pass through unchanged, so this is a no-op on the default
 * posture.
 */
export function toolDescriptorStoreKey(connectionKey: string): string {
  try {
    const parts: unknown = JSON.parse(connectionKey);
    if (Array.isArray(parts) && parts.length === 4 && parts[0] === 'mcp') {
      return JSON.stringify(parts.slice(0, 3));
    }
  } catch {
    // Not one of our JSON-array keys; the store can hold it verbatim.
  }
  return connectionKey;
}

/**
 * How many sessions may share one MCP transport within a pool.
 *
 * `shared` is the DEFAULT and the shipped behaviour: one connection per distinct
 * server config, reused by every leaser that wants it. `per-leaser` gives each
 * leaser its own transport for the same server — its own `initialize` and its
 * own `Mcp-Session-Id` — at one connection per session per server.
 * `by-transport` (`DA3.2`) answers the question per transport, by
 * {@link SHARED_TRANSPORTS_DEFAULT}.
 *
 * **BOTH isolating postures are OPT-IN, and both WORK on the real path** —
 * `DA3.8` repaired the one that did not, and cases (i)/(j) of
 * `__tests__/mcp-pool-connection-isolation.test.ts` drive each of them through a
 * real transport and a real tool call. Why the default stays `shared` anyway is
 * on the block at {@link SHARED_TRANSPORTS_DEFAULT}.
 */
export type McpConnectionIsolation = 'shared' | 'per-leaser' | 'by-transport';

/**
 * **WHICH TRANSPORTS `by-transport` SHARES, stated here because this is where an
 * operator reads it.**
 *
 * | transport | under `by-transport` | why |
 * | --- | --- | --- |
 * | `stdio` | SHARED | one PROCESS per session per server is the cost `P3.371` refused, and it is the expensive half. |
 * | `ws` | SHARED | one socket per session per server, for a transport that cannot even carry per-session headers. |
 * | `http` | per leaser | some MCP HTTP servers bind auth context or conversation memory to the stream. |
 * | `sse` | per leaser | same stream state, same reason. |
 *
 * ## What `DA3.2` fixed: the lever's GRANULARITY, not its default
 *
 * `P3.371` made the sharing radius a single pool-wide lever and chose `shared`,
 * transparently, because the alternative's cost is paid per session per server.
 * That pricing is a STDIO fact: a stdio connection is an operating-system
 * process. An http/sse connection is a socket plus one `initialize`, and our
 * sharing radius — every session in a workspace, plus browse — is WIDER than
 * the reference implementations'. So the lever was right and its granularity was
 * not: an operator who wanted the stream-state protection had to buy one PROCESS
 * per session per server to get it. This constant is that missing axis, and the
 * shape is the reference's (`mcp-pool-key.ts` symbols `POOLED_TRANSPORTS_DEFAULT`
 * and `isPoolable`, which pool `stdio` and `websocket` and isolate the rest) —
 * the piece `P3.371` did not take. It is spelled as the SHARED set rather than
 * the isolated one so an unrecognised transport added to the union later defaults
 * to isolation, which is the failure-closed direction.
 *
 * ## WHY THIS IS NOT THE DEFAULT — and the blocking half of the answer is GONE
 *
 * `DA3.2` was written to make `by-transport` the pool default. It did not, and
 * the reason it gave was a measurement: making it the default was the first
 * thing that ever exercised an ISOLATED posture end-to-end, and the posture did
 * not work. That block used to end by telling an operator not to reach for
 * either isolating spelling. **`DA3.8` repaired it, and the sentence is
 * withdrawn**: both isolating spellings now work on the real path.
 *
 * What was wrong, kept because it is the only record of it: `McpClientPool.connect`
 * computed the isolated key and then called {@link McpClientPool.registerClient}
 * without it, so the client, the tool cache, the proxy routes and the slug map
 * were filed under the SHARED identity while the reconcile, `clients.has`,
 * `dispatchElicitation` and `activeConfigs` all used the isolated one — an
 * isolated connection created and then unreachable through every surface that
 * routes by tool NAME or reports by connection VERDICT. One argument, measured
 * both ways on one tree, one day, one set of bytes, varying ONLY
 * `NESSY_MCP_CONNECTION_ISOLATION`:
 *
 * | suite | `shared` | `per-leaser` before `DA3.8` | `per-leaser` after |
 * | --- | --- | --- | --- |
 * | `__tests__/mcp-pool-elicitation-routing.test.ts` (a REAL Streamable HTTP server, no stub) | 10 / 0 | 2 pass / **8 fail** | 10 / 0 |
 * | `__tests__/mcp-pool-auth-failure.test.ts` | 15 / 0 | 10 pass / **5 fail** | 15 / 0 |
 *
 * `P3.371`'s own isolation suite could not see any of it, because every fixture
 * pool in it overrides `connect` — which is the one method the defect lived in.
 * Cases (i) and (j) of `__tests__/mcp-pool-connection-isolation.test.ts` drive
 * the REAL `connect` against a REAL server and call a REAL tool per session for
 * that reason; they fail on the one-argument mutant and pass here.
 *
 * **So the default still does not move, and now for an ordinary reason rather
 * than a blocking one.** `shared` is what shipped, the alternative's cost is
 * real and is paid per session per server, and which posture a product wants is
 * a decision for whoever owns that trade — not a clause of the row that fixed
 * the transport. Turning either isolating spelling on is an operator's
 * deliberate act, exactly as it was before; what changed is that it now does
 * what it says.
 *
 * **Native mechanism: none.** Neither `mcp.md` nor codex's pages state a
 * sharing radius at all, which is why `P3.371` decided it in the open and why
 * this row extends that same decision by one axis rather than inventing a
 * posture.
 */
export const SHARED_TRANSPORTS_DEFAULT: ReadonlySet<SdkMcpServerConfig['type']> = new Set(
  ['stdio', 'ws'] as const,
);

/**
 * `NESSY_MCP_CONNECTION_ISOLATION` chooses the pool's sharing posture.
 *
 * An operator lever rather than a user setting, for the reason the pool's other
 * two levers are: "the pool has no settings layer of its own". `shared` and
 * `per-leaser` keep exactly the meanings they had before `DA3.2`, and `shared`
 * is still the default, so nothing an operator has already set changes meaning
 * and nothing changes for an operator who has set nothing. `by-transport` is the
 * spelling `DA3.2` adds: isolate only the transports whose cost is a socket
 * ({@link SHARED_TRANSPORTS_DEFAULT} carries the table AND the reason the
 * default stays where it is). Anything other than the three spellings
 * is ignored and reported by the constructor, because a lever that answers a
 * typo with silence is the defect this file already refuses for the two
 * timeouts.
 */
function mcpConnectionIsolationFromEnv(): McpConnectionIsolation | undefined {
  const raw = (process.env.NESSY_MCP_CONNECTION_ISOLATION ?? '').trim();
  if (raw === 'per-leaser' || raw === 'shared' || raw === 'by-transport') return raw;
  return undefined;
}

const apiServerIdentities = new WeakMap<object, number>();
let nextApiServerIdentity = 1;

function apiConnectionKey(slug: string, server: McpServer): string {
  let identity = apiServerIdentities.get(server);
  if (identity === undefined) {
    identity = nextApiServerIdentity++;
    apiServerIdentities.set(server, identity);
  }
  return JSON.stringify(['api', slug, identity]);
}

function unboundConnectionKey(slug: string): string {
  return JSON.stringify(['unbound', slug]);
}

/**
 * Every variant of {@link SdkMcpServerConfig}, which is a FOUR-transport union
 * (`agent/backend/types.ts:793`): `http | sse`, `ws`, `stdio`.
 *
 * `ws` was missing, and the failure was silent rather than typed — a WebSocket
 * server went down the `McpServer` branch of {@link registerClient} and got an
 * `apiConnectionKey` (`["api", slug, n]`) where the connect path that called it
 * had already computed an `mcpConnectionKey` (`["mcp", slug, hash]`) at
 * {@link connectMcpServer}. The two halves of one connection were then filed
 * under DIFFERENT keys: the client, its tool cache and its slug under the api
 * key, and `activeConfigs` under the mcp key. So a `ws` server connected and
 * served tools while every per-connection lookup that starts from its config —
 * session-scoped views, tool timeouts, `alwaysLoad` pinning — missed it.
 */
function isSdkMcpServerConfig(value: SdkMcpServerConfig | McpServer): value is SdkMcpServerConfig {
  const type = (value as { type?: unknown }).type;
  return type === 'http' || type === 'sse' || type === 'stdio' || type === 'ws';
}

/**
 * The implicit single leaser used when a caller does not pass `leaserId`.
 * Every legacy two-arg `sync(mcp, api)` call routes through this one leaser,
 * so the effective desired set equals the caller's set and behavior is
 * byte-equivalent to the pre-refcount single-owner pool.
 */
export const DEFAULT_LEASER_ID = '__default__';

/**
 * The bucket a tool call with no `leaserId` is counted under while it is in
 * flight. Distinct from {@link DEFAULT_LEASER_ID}, which is a desired-set
 * identity: this one exists so an unscoped call is VISIBLE to elicitation
 * attribution as "a caller we cannot name", rather than absent from it.
 */
const UNSCOPED_CALL_LEASER = '__unscoped_call__';

/**
 * Existing calls get one short grace period when their connection is drained;
 * calls still pending at the boundary are aborted before transport close.
 */
const MCP_CONNECTION_DRAIN_GRACE_MS = 1_000;

/**
 * Per-server connect deadline. An unbounded connect blocks the whole reconcile
 * and every sync queued behind it on the pool's sync chain, which is how one
 * hanging server used to stall every turn in a workspace.
 *
 * The 30 s default matches Claude's `MCP_TIMEOUT` (`env-vars.md:412`, "Timeout
 * in milliseconds for MCP server startup (default: 30000, or 30 seconds)");
 * `NESSY_MCP_TIMEOUT` is the operator lever ({@link mcpStartupTimeoutMsFromEnv}).
 * NOT named `MCP_CONNECT_TIMEOUT_MS`: that spelling is Claude's OTHER variable
 * — `env-vars.md#variables`, "Distinct from `MCP_TIMEOUT`, which bounds an
 * individual server's connect attempt" — and P3.237 has since built that row as
 * `NESSY_MCP_CONNECT_TIMEOUT_MS` ({@link mcpConnectBatchTimeoutMsFromEnv}), so
 * the collision this line was written to avoid would now be a real one. The two
 * are different scopes: this bounds ONE server's attempt, that caps the wait
 * over the batch.
 */
const MCP_STARTUP_TIMEOUT_MS = 30_000;

/**
 * The `NESSY_MCP_TIMEOUT` env override for {@link MCP_STARTUP_TIMEOUT_MS}, in
 * milliseconds — the documented remedy for a stdio server whose first run is
 * slow while `npx` downloads the package (`mcp-quickstart.md:333`). The
 * documented `MCP_TIMEOUT` spelling is accepted as a compat alias, the Nessy
 * name winning when both are set. Trim;
 * empty, malformed, or non-positive falls back silently, matching
 * `mcpAutoBackgroundDelayMs`. Read at pool construction, not per connect, so
 * the pool's deadline is stable for its lifetime.
 */
function mcpStartupTimeoutMsFromEnv(env = process.env): number | undefined {
  const reading = readMcpTimeoutEnv(env, MCP_STARTUP_TIMEOUT_ENV, MCP_STARTUP_TIMEOUT_COMPAT_ENV);
  if (!reading) return undefined;
  const value = Number(reading.raw.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The documented `_meta` key an MCP server uses to raise ONE of its tools'
 * result-size allowance (`code.claude.com/docs/en/mcp`, "Raise the limit for a
 * specific tool"). Vendor-namespaced exactly as documented — the bare
 * `maxResultSizeChars` spelling is not part of any contract.
 */
const MCP_MAX_RESULT_SIZE_CHARS_META_KEY = 'anthropic/maxResultSizeChars';

/**
 * The documented `_meta` key an MCP server uses to pin ONE of its tools past
 * deferred tool loading (`code.claude.com/docs/en/mcp` — "An MCP server can also
 * mark individual tools as always-loaded"). Only the JSON boolean `true` counts,
 * matching the sibling `requiresUserInteraction` rule.
 */
const MCP_ALWAYS_LOAD_META_KEY = 'anthropic/alwaysLoad';

/**
 * The documented `_meta` key an MCP server uses to require explicit approval on
 * every call of ONE of its tools (`code.claude.com/docs/en/mcp` — "Require
 * approval for a specific tool"). Vendor-namespaced exactly as documented, and
 * only the JSON boolean `true` counts: "any other value is ignored".
 */
const MCP_REQUIRES_USER_INTERACTION_META_KEY = 'anthropic/requiresUserInteraction';

/**
 * Default idle windows for a tool call: abort after this long with NO response
 * and NO progress notification.
 *
 * `env-vars.md#variables`, the `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` row:
 * *"Overrides the per-transport defaults of 300000 (5 minutes) for network
 * servers and 1800000 (30 minutes) for stdio servers."* Both numbers below are
 * that sentence, and the reason it is shaped that way holds for us too: a stdio
 * server is a local process we supervise, so it gets the longer window, while a
 * remote transport going silent is far more likely to be a dropped connection
 * than slow work.
 *
 * The same row's *"Before v2.1.203, stdio servers were exempt from the idle
 * timeout"* is history rather than contract — our stdio servers are covered, as
 * the current sentence says they should be.
 *
 * Set `NESSY_MCP_TOOL_IDLE_TIMEOUT` or the documented
 * `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (milliseconds) to override, or `0` to
 * disable the check entirely.
 */
const MCP_TOOL_IDLE_TIMEOUT_REMOTE_MS = 5 * 60_000;
const MCP_TOOL_IDLE_TIMEOUT_STDIO_MS = 30 * 60_000;

/**
 * A per-server wall clock below this is not treated as an idle-window floor —
 * it is short enough that flooring the idle window to it would abort healthy
 * calls the wall clock is already responsible for.
 */
const MCP_TOOL_IDLE_FLOOR_MIN_MS = 1_000;

/**
 * Per-call session identity for tool-response persistence.
 *
 * `callTool` saves large/binary responses into a session's `downloads/` dir and
 * summarizes over-threshold text with that session's callback. Historically the
 * pool held ONE session's `sessionPath` + `summarizeCallback` (fine when every
 * session owns its own pool). When sessions share ONE pool (the shared-workspace
 * pool goal), a per-call context lets each caller supply ITS OWN session's dir +
 * callback, so responses never land in another session's directory. When omitted,
 * `callTool` falls back to the pool-level `sessionPath`/`setSummarizeCallback`
 * defaults — byte-equivalent to today's single-owner-per-session behavior.
 */
export interface McpCallToolContext {
  /** Session storage path for saving this call's large/binary responses. */
  sessionPath?: string;
  /** Summarize callback for this call's over-threshold text responses. */
  summarize?: (prompt: string) => Promise<string | null>;
  /**
   * The agent's stated purpose for this call (UB3.9, upstream v0.15.1
   * `PoolCallToolOptions.intent`): steers the large-result summariser
   * (`guardLargeResult`'s `intent`) and rides to API sources as `_intent`
   * through {@link McpToolCallOptions.intent}. Per call by nature — no
   * pool-level default exists, so an omitted intent reads as absent, and the
   * summariser falls back to the user request exactly as before.
   */
  intent?: string;
  /**
   * Leaser (session) identity for the per-session call-authz guard. When set,
   * `callTool` executes the proxy tool ONLY if its slug is in this leaser's
   * desired set (see {@link McpClientPool.slugsForLeaser}); a foreign slug is
   * refused without executing. Omit to reproduce today's global behavior — any
   * connected proxy tool runs regardless of which leaser wants its slug.
   */
  leaserId?: string;
}

/** Options for {@link McpClientPool.sync}. */
export interface McpPoolSyncOptions {
  /**
   * Identifies the leaser contributing this desired set. Each leaser owns one
   * slot in the pool's per-leaser desired maps; the pool reconciles against the
   * UNION across all leasers. Omit for the single implicit leaser (today's
   * callers), which preserves the pre-refcount behavior exactly.
   */
  leaserId?: string;
}

/**
 * The one argument {@link McpClientPool.openConnection} receives — `DA3.6`.
 *
 * An OBJECT with three required fields rather than three positional parameters,
 * and the shape is the whole point: the seam it replaces was
 * `connect(slug, config, isolatedConnectionKey?)`, whose third parameter was
 * optional, so `override async connect(slug, config)` was a legal TypeScript
 * override that silently dropped the connection identity. 28 of 31 override
 * sites did exactly that (census 2026-09-17), and `DA3.8` then found the base
 * method dropping it too. Here the key arrives whether the override names it or
 * not, and the override never files anything — {@link McpClientPool.connect}
 * does — so there is nothing left for it to drop.
 */
export interface McpOpenConnectionRequest {
  /** The public source slug, for diagnostics and for the channel dispatcher. */
  slug: string;
  /** The materialized server config this transport is being opened for. */
  config: SdkMcpServerConfig;
  /**
   * The identity the returned client will be filed under. Required: an
   * elicitation dispatcher or a failure record keyed by anything else reaches
   * the wrong connection, or none.
   */
  connectionKey: string;
}

/**
 * Proxy tool definition — the format passed to backends for registration.
 * Uses mcp__{slug}__{toolName} naming convention.
 */
export interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * The server's own advisory hints, carried through verbatim. ADVISORY ONLY —
   * `annotations` is a hint from a possibly untrusted server and must never
   * become an authorization signal (see "does not project advisory protocol
   * metadata into authorization fields"). Absent when the server sends none.
   */
  annotations?: Tool['annotations'];
  /**
   * The server's own `_meta` bag, carried through verbatim so vendor flags such
   * as `anthropic/maxResultSizeChars` and `anthropic/requiresUserInteraction`
   * reach a consumer at all. Absent when the server sends none.
   */
  _meta?: Tool['_meta'];
}

/**
 * Result of an MCP tool call, matching the subprocess protocol format.
 */
export interface McpToolResult {
  content: string;
  isError: boolean;
  structuredContent?: Record<string, unknown>;
  /** Source slug for error attribution (set on failure) */
  sourceSlug?: string;
}

/**
 * P6.711 — what a requested reconnect did.
 *
 * A verdict rather than a throw: every failure here is something the panel has
 * to render, and three of the four are not errors at all — they are statements
 * about what the pool knows.
 */
export type McpReconnectResult =
  | { ok: true }
  | { ok: false; reason: 'unknown-server' | 'no-config' | 'in-process' | 'failed'; detail?: string };

export interface McpPoolHealth {
  status: 'unavailable' | 'ready' | 'degraded'
  connected: readonly string[]
  failed: readonly string[]
  /**
   * P6.715 — why each `failed` slug failed, keyed by slug, for the failures the
   * pool caught a reason for.
   *
   * The pool ALWAYS sets this (`{}` when nothing failed). It is optional on the
   * interface only because several test doubles construct this shape by hand;
   * every reader must therefore treat an absent map and an empty one alike.
   *
   * A slug can be in `failed` with no entry here — a capability failure is a
   * verdict with no transport error behind it — so this is a lookup, never a
   * second list of what failed.
   */
  failureReasons?: Readonly<Record<string, string>>
}

/**
 * Whether a connected MCP server may push text into a live turn through the
 * `claude/channel` notification.
 *
 * Enforced at handler INSTALLATION, not at dispatch: a source the policy does
 * not permit never gets a dispatcher at all, so there is nothing to discard
 * from. A handler that exists but throws its input away is a weaker guarantee.
 *
 * `enabled` is the master switch and defaults to OFF ({@link CHANNEL_PUSH_OFF}),
 * so a pool constructed with no channel configuration installs nothing. That is
 * the fail-closed case: an admin or user has to opt in before any server can
 * steer a turn it was not asked to steer.
 */
export interface ChannelPolicy {
  enabled: boolean;
  /**
   * Permitted source slugs. `undefined` means "no per-source restriction",
   * matching the convention `isManagedMcpServerAllowed` already uses for
   * `allowedMcpServers`. Only meaningful when `enabled` is true.
   */
  allowedSources?: readonly string[];
  /**
   * Sources that may never push, whatever {@link allowedSources} says.
   *
   * A separate list because deny is terminal and an allowlist cannot express
   * it: `allowedSources: undefined` means "no per-source restriction", so
   * subtracting a denied name from an absent list changes nothing. Checked
   * first, matching the deny-terminal shape of every managed helper.
   */
  deniedSources?: readonly string[];
}

/** Fail-closed channel policy: no source gets a handler. */
export const CHANNEL_PUSH_OFF: ChannelPolicy = Object.freeze({ enabled: false });

/**
 * The handshake key a server sets to declare itself a channel — the SECOND
 * precondition for a dispatcher, beside the policy above (P6.341).
 *
 * `channels-reference.md#server-options`, verbatim:
 * "`capabilities.experimental['claude/channel']` | `object` | Required. Always
 * `{}`. Presence registers the notification listener."
 *
 * The name is exported so the one reader ({@link McpClientPool.declaresChannel})
 * and any server we build against it cannot drift apart in spelling.
 */
export const MCP_CHANNEL_CAPABILITY = 'claude/channel';

function hasStructuredContent(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length > 0;
}

/**
 * The fail-closed boundary between an untrusted server and the prompt.
 *
 * ## ONE rule for a malformed `meta`, and it is REJECT
 *
 * f135 and f136 proposed opposite defaults for this guard; the rule is: a
 * `meta` that is present and not a plain object of identifier-keyed string
 * values REJECTS the whole message. Two reasons, and they are the same reason
 * from two sides:
 *
 * - This is a type PREDICATE (`value is McpChannelMessage`). "Drop just `meta`"
 *   requires mutating the message, which would turn the guard into a
 *   normalizer that silently rewrites what a caller passed it. Rejecting is the
 *   only shape that stays a pure predicate AND stays fail-closed.
 * - The doc's "silently dropped" rule (`channels-reference.md:230`) is about
 *   PARSE, and it is honoured at parse: `boundedChannelMeta` in `client.ts`
 *   drops non-identifier keys, non-string values and over-budget entries without
 *   a warning. So on the production path a `meta` reaching this guard is already
 *   sanitized and the rejection never fires. It fires only when something
 *   bypassed the transport parser — tests inject `PoolClient`s directly — which
 *   is exactly the unsanitized-record case this boundary exists to stop.
 */
function isMcpChannelMessage(value: unknown): value is McpChannelMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<McpChannelMessage>;
  if (typeof message.server !== 'string') return false;
  if (typeof message.text !== 'string') return false;
  if (Buffer.byteLength(message.text, 'utf8') > MCP_CHANNEL_MAX_TEXT_BYTES) return false;
  if (message.meta !== undefined) {
    if (typeof message.meta !== 'object' || message.meta === null || Array.isArray(message.meta)) return false;
    for (const [key, entry] of Object.entries(message.meta)) {
      if (!isChannelMetaKey(key) || typeof entry !== 'string') return false;
    }
  }
  return true;
}

export function redactConfiguredMcpSecrets<T>(value: T, secrets: ReadonlySet<string>): T {
  const replace = (text: string) => {
    let redacted = text
    for (const secret of secrets) {
      if (secret.length >= 4) redacted = redacted.split(secret).join('[REDACTED]')
    }
    return redacted
  }
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return replace(item)
    if (Array.isArray(item)) return item.map(visit)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([key, child]) => [key, visit(child)]))
    }
    return item
  }
  return visit(value) as T
}

function deepFreezeJson<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child)
  return Object.freeze(value)
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

/**
 * A tool-call wall clock that aborts with a REASON, not with the platform's
 * anonymous `TimeoutError`.
 *
 * `AbortSignal.timeout(ms)` would be one line, and it is what this replaced. Its
 * reason is a bare "The operation timed out": `abortReason` passes that straight
 * into `failureResult`, so the model — and the operator reading the transcript —
 * learned that a call stopped and never learned after how long, or which of the
 * two knobs stopped it. A ceiling nobody can attribute is a control that has
 * silently stopped controlling.
 *
 * The caller MUST `cancel()` in a `finally`: this timer is a plain `setTimeout`
 * and, unlike `AbortSignal.timeout`, it holds the event loop until it is
 * cleared — and the default ceiling is measured in hours.
 */
function toolWallClockAbort(ms: number, reason: Error): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(reason), ms);
  return { signal: controller.signal, cancel: () => { clearTimeout(timer); } };
}

/**
 * Settle the host-side call even when a non-conforming PoolClient ignores the
 * AbortSignal passed to callTool. Closing the transport then owns termination
 * of the underlying request/process.
 */
async function settleOnAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal, 'mcp-tool-call-aborted');
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal, 'mcp-tool-call-aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Convert SdkMcpServerConfig (used by backend types) to NessyMcpClient config.
 */
export function sdkConfigToClientConfig(config: SdkMcpServerConfig): McpClientConfig | null {
  if (config.type === 'http') {
    return {
      transport: 'http',
      url: config.url,
      headers: config.headers,
    };
  }
  if (config.type === 'sse') {
    return {
      transport: 'sse',
      url: config.url,
      headers: config.headers,
    };
  }
  if (config.type === 'ws') {
    return {
      transport: 'ws',
      url: config.url,
      headers: config.headers,
    };
  }
  if (config.type === 'stdio') {
    return {
      transport: 'stdio',
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      ...((config.inheritProcessEnv === false || config.pluginOrigin || config.pluginRuntime)
        ? { inheritProcessEnv: false }
        : {}),
      ...(config.pluginRuntime ? { pluginRuntime: config.pluginRuntime } : {}),
    };
  }
  return null;
}

/** Settings the ws address guard consults; both default to "nothing configured". */
export interface McpWsNetworkPolicy {
  /** `sandbox.network.deniedDomains`, already composed across settings layers. */
  deniedDomains?: readonly string[];
  /** Passed ONLY when `allowManagedDomainsOnly` resolves true; presence IS the flag. */
  managedAllowlist?: readonly string[];
  /** Injected so the guard is testable without DNS; production resolves all records. */
  resolve?: (host: string) => Promise<string[]>;
}

/** Every address a name resolves to — taking only the first would hide one. */
async function resolveAllAddresses(host: string): Promise<string[]> {
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map(record => record.address);
}

/**
 * The address gate a `ws` MCP server passes before a socket is opened.
 *
 * A `ws://`/`wss://` MCP URL is the same class of outbound target as a Monitor
 * `ws` watch, so it goes through the SAME two checks, in the same order
 * (`config/network-address-guard.ts`):
 *
 * 1. {@link validateWsWatchInput} — scheme, embedded credentials, ASCII/no
 *    whitespace. Pure, and its reasons never quote the URL, because the rule it
 *    enforces is that a URL may carry a secret.
 * 2. {@link isDeniedNetworkTarget} — literal private/link-local/metadata
 *    addresses, `sandbox.network.deniedDomains`, the managed allowlist, and the
 *    re-check of every RESOLVED address that turns an attacker-controlled DNS
 *    record into an SSRF when it is skipped.
 *
 * Clause 1 of the address guard denies loopback and private ranges, and that is
 * deliberate here too: `mcp.md:136` introduces this transport as "Add a remote
 * WebSocket server" for servers that "push events to Claude unprompted". A
 * local MCP server is a `stdio` or `http` entry, neither of which this touches.
 */
export async function checkMcpWsTarget(
  url: string,
  policy?: McpWsNetworkPolicy,
): Promise<NetworkAddressGuardResult> {
  const shape = validateWsWatchInput({ url });
  if (!shape.ok) return { denied: true, reason: shape.reason ?? 'the ws url was refused' };

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { denied: true, reason: 'the ws url is not a valid URL' };
  }

  return isDeniedNetworkTarget(host, {
    resolve: policy?.resolve ?? resolveAllAddresses,
    deniedDomains: policy?.deniedDomains ?? [],
    ...(policy?.managedAllowlist !== undefined ? { managedAllowlist: policy.managedAllowlist } : {}),
  });
}

/**
 * Sanitize a single tool-name segment to the charset accepted by OpenAI-like
 * function names ([A-Za-z0-9_-]). Dotted/spaced names from remote MCP servers
 * (e.g. "foo.bar") are otherwise rejected by the Pi/OpenAI-like backend (#864).
 * Only the tool-name segment is sanitized; the "mcp__" prefix and slug are
 * already charset-safe.
 */
export function sanitizeMcpToolNameSegment(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * `mcp__<slug>__<tool>`, capped at 64 chars for OpenAI-compatible endpoints by
 * truncating the TOOL segment with a hash tail — separators survive so
 * `tryParsePiDynamicMcpBindingName` still splits correctly.
 *
 * The 64-char cap on the FULL name holds only because `slug` itself is
 * guaranteed ≤ 40 chars: every wire name is capped at the MINT
 * (`capMcpNameSegment(name, 40)` in `applyCollisionPolicy`'s `byMcp` branch,
 * `capabilities/resolver.ts`), not here. This function deliberately does NOT
 * re-truncate the slug — with an uncapped slug over ~49 chars, the tool-segment
 * floor below (`Math.max(8, …)`) would win and the result would exceed 64
 * again. Capping the slug HERE instead of at the mint was considered and
 * rejected: the Pi execution-manifest seed captures wire names from the same
 * mint this pool consumes, so a pool-local truncation would desync the seed
 * from the pool's connection key and silently drop tools (review finding,
 * task 2 of stable-plugin-mcp-wire-names, 2026-08-10).
 */
export function buildPoolProxyBaseName(slug: string, toolName: string): string {
  const prefix = `mcp__${slug}__`;
  const toolSegment = sanitizeMcpToolNameSegment(toolName);
  if (prefix.length + toolSegment.length <= 64) return `${prefix}${toolSegment}`;
  return `${prefix}${capMcpNameSegment(toolSegment, Math.max(8, 64 - prefix.length))}`;
}

export class McpClientPool {
  /** Active clients keyed by immutable (kind, slug, config identity). */
  private clients = new Map<string, PoolClient>();

  /** Public source slug for each physical connection key. */
  private connectionSlugs = new Map<string, string>();

  /** Configs used for active MCP connections, keyed by physical connection. */
  protected activeConfigs = new Map<string, SdkMcpServerConfig>();

  /** Instances used for active in-process API connections. */
  protected activeApiServers = new Map<string, McpServer>();

  /** Cached tool lists keyed by physical connection. */
  private toolCache = new Map<string, Tool[]>();

  /** Durable backing store for {@link toolCache}; absent in ephemeral pools. */
  private readonly toolDescriptorStore?: ToolDescriptorStore;
  /** See {@link McpConnectionIsolation} and {@link mcpConnectionKey}. */
  private readonly connectionIsolation: McpConnectionIsolation = 'shared';
  /**
   * Connection keys already named by
   * {@link reportSharedDynamicHeaderConnections}. The line is worth saying once
   * per connection, not once per sync — a per-sync repeat is how an operator
   * learns to filter the log that carries it.
   */
  private readonly reportedSharedDynamicHeaders = new Set<string>();

  /** Settings half of the `ws` address guard; the pure clauses apply regardless. */
  private readonly wsNetworkPolicy?: McpWsNetworkPolicy;

  /** Last good resources/prompts keyed by physical connection. */
  private contextCache = new Map<string, McpContextCatalog>();

  // Connections whose server declared the `resources` capability at the MCP
  // handshake. Captured once at registerClient so capability-conditional tool
  // projection (the list_mcp_resources/read_mcp_resource surface) has a
  // synchronous signal at projection time — the discovered list is lazy and may
  // still be empty then. `hasResourceCapability` intersects with the live
  // `clients` map, so a stale key left after a disconnect is never counted.
  private resourceCapableConnections = new Set<string>();

  /**
   * Per-connection `instructions`, as the server returned them from
   * `initialize`. Captured at registerClient beside the tool cache because it is
   * the OTHER half of what the model learns about a server before it searches:
   * `mcp.md#scale-with-mcp-tool-search` — "Only tool names and server
   * instructions load at session start". Nothing read it until P3.228, so every
   * runtime dropped it. Read through {@link getInstructions}, which intersects
   * with the live `clients` map the way `hasResourceCapability` does.
   */
  private instructionsByConnection = new Map<string, string>();

  /**
   * `<connectionKey>\u0000<toolName>` pairs whose drop has already been logged,
   * so the per-turn read paths say it once rather than once per turn.
   */
  private reportedMalformedTools = new Set<string>();

  /**
   * Proxy tool name → per-connection route. Side-by-side plugin versions keep
   * the same model-visible name while calls resolve through the caller's leaser.
   */
  private proxyTools = new Map<string, Map<string, ProxyRoute>>();

  /** Optional debug logger */
  private debugFn: ((msg: string) => void) | undefined;

  /** Workspace root path for local MCP filtering */
  private workspaceRootPath?: string;

  /** See the `rootsProvider` constructor option. Present ⇒ clients advertise `roots`. */
  private rootsProvider?: () => readonly string[] | Promise<readonly string[]>;

  /** Session storage path for saving large responses */
  private sessionPath?: string;
  private readonly pluginProcessAuthority?: PluginMcpProcessAuthority;
  private readonly connectionDrainGraceMs: number;
  private readonly connectTimeoutMs: number;

  /**
   * The wall clock applied to a running tool call on a connection that declares
   * no per-server `timeout` of its own. See {@link mcpDefaultToolTimeoutMsFromEnv}.
   */
  private readonly defaultToolTimeoutMs: number;
  private readonly connectRetryAttempts: number;
  private readonly connectRetryBaseDelayMs: number;

  /**
   * Whether a connect that need not delay the first turn is allowed to run in
   * the background. See {@link mcpConnectionNonBlockingFromEnv}.
   */
  private readonly connectionNonBlocking: boolean;

  /**
   * Optional cap on how long one reconcile waits for its connect batch.
   * `undefined` means the batch's own per-server deadline is the only bound.
   */
  private readonly connectBatchTimeoutMs: number | undefined;

  /** Summarize callback for large response handling */
  private summarizeCallback?: (prompt: string) => Promise<string | null>;

  /**
   * Ask-user bridge for MCP `elicitation/create` on a pool with ONE owner —
   * a headless agent or any caller that never threads a `leaserId`. Consulted
   * only while {@link elicitationHandlersByLeaser} is empty; see
   * {@link resolveElicitationHandler}.
   */
  private elicitationHandler?: McpElicitationHandler;

  /**
   * Ask-user bridges per leasing session. A shared workspace pool is leased by
   * several sessions at once, so "the user" is not a property of the pool — it
   * is a property of whichever session's call the server is answering.
   */
  private elicitationHandlersByLeaser = new Map<string, McpElicitationHandler>();

  /**
   * In-flight tool calls per connection, counted per leaser. This is the ONLY
   * thing on a pool connection that names a session at the moment a server
   * elicits: an `elicitation/create` arrives out of band on the transport, so
   * no async context reaches it and the request itself carries no session.
   * Calls with no `leaserId` count under {@link UNSCOPED_CALL_LEASER}, so an
   * unscoped call in flight makes attribution ambiguous instead of silently
   * yielding to the one scoped call beside it.
   */
  private inFlightCallLeasers = new Map<string, Map<string, number>>();
  private configuredSecretsByConnection = new Map<string, Set<string>>();
  /** Transport/connect failures, which make a source unavailable to sync callers. */
  private failedConnections = new Set<string>();
  /**
   * P6.715 — WHY each entry of {@link failedConnections} failed.
   *
   * Kept beside the set rather than replacing it: the set is asked
   * `has(connectionKey)` on the hot path (on-demand connect, `callTool`'s
   * guard, the verdict signature) and a Map lookup there would buy nothing.
   * What was missing is the reason, which every failure site had in hand and
   * threw away — so `<source_issue>` could carry a status and never a text, and
   * the `/mcp` report's `detail` field was documented as "absent on the pool".
   *
   * Written only through {@link markConnectionFailed}, which redacts the
   * connection's own configured secrets: this text reaches the MODEL and the
   * user's report, not just {@link debug}.
   */
  private connectionFailureReasons = new Map<string, string>();
  /**
   * H1: connections a server itself rejected with 401/403 — at connect or on a
   * tool call, on every transport, not only helper-backed ones. Kept SEPARATE
   * from {@link failedConnections}: that set is connection health and governs
   * on-demand reconnect, this one is the USER-facing "sign in again" verdict
   * that {@link authNeededSlugs} hands to the pending-auth notice. A revoked
   * token leaves `isAuthenticated` true, so nothing else in the product can
   * tell that state apart from a broken server.
   */
  private authFailedConnections = new Set<string>();
  /** Dynamic capability failures; a source stays degraded until every failed kind recovers. */
  private failedCapabilityKindsByConnection = new Map<string, Set<McpCapabilityKind>>();
  /** Connects in flight, keyed by connection identity. See {@link connectOnce}. */
  private pendingConnects = new Map<string, Promise<void>>();
  /**
   * P6.351 (denominator J43) — scheduled MID-SESSION reconnects, keyed by
   * connection identity. See {@link scheduleReconnectAfterUnexpectedClose}.
   */
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inFlightCalls = new Map<string, number>();
  private inFlightCallControllers = new Map<string, Set<AbortController>>();
  private inFlightDrainWaiters = new Map<string, Set<() => void>>();
  private drainingConnections = new Set<string>();

  /**
   * Per-leaser desired MCP sets. The effective desired set the pool reconciles
   * against is the UNION across every leaser: a server stays connected while
   * ANY leaser wants it and is disconnected only when it leaves EVERY set. The
   * default single implicit leaser (`DEFAULT_LEASER_ID`) makes a two-arg
   * `sync(mcp, api)` byte-equivalent to the pre-refcount single-owner behavior.
   */
  private desiredMcpByLeaser = new Map<string, Map<string, RevisionedDesired<SdkMcpServerConfig>>>();

  /** Per-leaser desired API-source sets (union-merged the same way as MCP). */
  private desiredApiByLeaser = new Map<string, Map<string, RevisionedDesired<ApiServerConfig>>>();

  /** Monotonic call-order revision used to resolve a slug desired by several leasers. */
  private desiredRevision = 0;

  /**
   * Serializes sync() so two leasers syncing concurrently converge to the union
   * instead of interleaving their connect/disconnect passes over shared state.
   */
  private syncChain: Promise<unknown> = Promise.resolve();
  private capabilityRefreshChains = new Map<string, Promise<void>>();
  /** At most one queued notification per capability kind and connection. */
  private pendingCapabilityNotifications = new Map<string, Set<McpCapabilityKind>>();
  private capabilityNotificationRunners = new Map<string, Promise<void>>();
  private toolsChangedListeners = new Set<() => void>();
  /**
   * P3.246. Listeners told that {@link authNeededSlugs} or {@link health} would
   * now answer differently than when this pool last published.
   *
   * Both of those are pull-only verdicts, and BOTH of their consumers read them
   * once, synchronously, right after a `sync` — the session-start pending-auth
   * notice and the browse registry's staleness judgement. Every verdict change
   * that lands after that read was therefore invisible: a token revoked between
   * two turns produced a 401 on the next tool call, marked the connection, and
   * told nobody, so the one sign-in affordance we ship never appeared. That is
   * the same defect P3.237 measured on a deferred connect, and it exists today
   * without deferring anything.
   */
  private connectionVerdictListeners = new Set<() => void>();
  /**
   * The last signature published to {@link connectionVerdictListeners}. Set in
   * the constructor so a pool that comes up empty and stays empty never fires.
   */
  private lastPublishedConnectionVerdict = '';
  /**
   * Non-zero while a reconcile is rewriting connection state. A reconcile
   * passes through torn intermediates by construction — it marks filtered
   * connections failed, disconnects the undesired, then connects the rest — and
   * a listener that read `health()` in the middle of that would act on a verdict
   * the pool is about to contradict. The reconcile publishes ONCE, at its end.
   */
  private connectionVerdictPublishSuspended = 0;
  private channelSubscribers = new Map<string, Set<(message: McpChannelMessage) => void>>();

  /** See {@link ChannelPolicy}. Fail-closed until a caller opts in. */
  private channelPolicy: ChannelPolicy = CHANNEL_PUSH_OFF;

  /** Connections that currently hold an installed channel dispatcher. */
  private channelArmedConnections = new Set<string>();

  /** Called after sync() connects/disconnects sources, so clients can be notified */
  onToolsChanged?: () => void;

  constructor(options?: {
    debug?: (msg: string) => void;
    workspaceRootPath?: string;
    sessionPath?: string;
    pluginProcessAuthority?: PluginMcpProcessAuthority;
    /** Focused-test seam; production uses the bounded default grace. */
    connectionDrainGraceMs?: number;
    /**
     * Per-server connect deadline. A server past it is recorded as failed
     * instead of holding the reconcile open. Defaults to `NESSY_MCP_TIMEOUT`
     * when set, else {@link MCP_STARTUP_TIMEOUT_MS}.
     */
    connectTimeoutMs?: number;
    /**
     * Wall clock for one RUNNING tool call on a connection whose config carries
     * no per-server `timeout`. Defaults to `NESSY_MCP_TOOL_TIMEOUT` when set,
     * else {@link MCP_DEFAULT_TOOL_TIMEOUT_MS}.
     *
     * The per-server field still wins for its own connection — `mcp.md`, the
     * `.mcp.json` `timeout` bullet: "This overrides the `MCP_TOOL_TIMEOUT`
     * environment variable for that server only."
     */
    defaultToolTimeoutMs?: number;
    /**
     * Whether a connect the documented table exempts from the first-turn wait
     * may run in the background. Defaults to `NESSY_MCP_CONNECTION_NONBLOCKING`,
     * i.e. `false` unless an operator writes `1` — see that reader for why this
     * default deviates from Claude's.
     */
    connectionNonBlocking?: boolean;
    /**
     * Cap on the reconcile's wait for its connect batch. Defaults to
     * `NESSY_MCP_CONNECT_TIMEOUT_MS` when set, else no separate cap.
     */
    connectBatchTimeoutMs?: number;
    /**
     * Bounded initial-connect retry. Default is ONE attempt, so a caller that
     * does not opt in behaves exactly as before. The retry lives inside
     * {@link connectOnce}, so concurrent leasers still share one in-flight
     * attempt chain and one transport — the leak `connectOnce` was added to
     * close — and the whole chain runs inside ONE {@link connectTimeoutMs}
     * deadline, so retries never add serial latency past what that deadline
     * already allowed.
     */
    retry?: { attempts: number; baseDelayMs: number };
    /**
     * Durable per-connection tool descriptors. Injected so tests can supply an
     * in-memory implementation; production passes a store rooted at
     * `<config>/mcp/tool-descriptors`.
     */
    toolDescriptorStore?: ToolDescriptorStore;
    /**
     * Channel push gate. Omitted means {@link CHANNEL_PUSH_OFF}; callers that
     * want channel push must say so, and may re-narrow it later through
     * {@link McpClientPool.setChannelPolicy}.
     */
    channelPolicy?: ChannelPolicy;
    /**
     * Network policy for `ws` MCP targets. The literal-address and
     * DNS-resolution clauses apply with or without this; `deniedDomains` and the
     * managed allowlist are settings the pool's owner has to supply, because the
     * pool has no settings layer of its own.
     */
    wsNetworkPolicy?: McpWsNetworkPolicy;
    /**
     * The roots this pool's clients answer `roots/list` with (`mcp.md:108`).
     *
     * INJECTED, never read from config here, for the same reason
     * `wsNetworkPolicy` is injected: "the pool has no settings layer of its own"
     * (see that option above). Absent means the `roots` capability is not
     * advertised at all.
     */
    rootsProvider?: () => readonly string[] | Promise<readonly string[]>;
    /**
     * How many sessions may share one transport. See
     * {@link McpConnectionIsolation}, the per-transport table on
     * {@link SHARED_TRANSPORTS_DEFAULT}, and the radius decision recorded on
     * {@link mcpConnectionKey}. Option wins over
     * `NESSY_MCP_CONNECTION_ISOLATION`, same precedence as the two timeouts.
     */
    connectionIsolation?: McpConnectionIsolation;
  }) {
    this.debugFn = options?.debug;
    this.workspaceRootPath = options?.workspaceRootPath;
    this.rootsProvider = options?.rootsProvider;
    this.sessionPath = options?.sessionPath;
    this.pluginProcessAuthority = options?.pluginProcessAuthority;
    this.connectionDrainGraceMs = Math.max(0, options?.connectionDrainGraceMs ?? MCP_CONNECTION_DRAIN_GRACE_MS);
    // The programmatic option wins over the env lever: it is the focused-test
    // seam the pool suites pass, and env only replaces the compile-time default.
    this.connectTimeoutMs = clampToTimerMaxMs(Math.max(1, options?.connectTimeoutMs ?? mcpStartupTimeoutMsFromEnv() ?? MCP_STARTUP_TIMEOUT_MS));
    // Same precedence as the connect deadline above: the programmatic option is
    // the focused-test seam, env only replaces the compile-time default. Read at
    // construction so the ceiling is stable for the pool's lifetime. The
    // documented one-second floor is the ENV variable's rule and is applied by
    // its reader, NOT here — flooring the option too would make the test seam
    // unable to express a short ceiling, and would be a rule the page does not
    // state about a value the page does not know exists.
    this.defaultToolTimeoutMs = Math.max(
      1,
      options?.defaultToolTimeoutMs ?? mcpDefaultToolTimeoutMsFromEnv(),
    );
    // The row this lever closes is "an operator who sets it gets silence", and a
    // silent fallback on a typo reproduces that one level down. So whenever the
    // name is set at all, say what it resolved to — including when it resolved
    // to the default because the value was unusable.
    const toolTimeoutReading = readMcpTimeoutEnv(
      process.env,
      MCP_TOOL_TIMEOUT_ENV,
      MCP_TOOL_TIMEOUT_COMPAT_ENV,
    );
    if (options?.defaultToolTimeoutMs === undefined && toolTimeoutReading) {
      this.debug(
        `${toolTimeoutReading.name}="${toolTimeoutReading.raw}" resolved to a `
        + `${this.defaultToolTimeoutMs}ms ceiling per MCP tool call `
        + '(a per-server `timeout` still overrides it for that server).',
      );
    }
    // Same precedence as the two deadlines above: option is the test seam, env
    // replaces the compile-time default.
    this.connectionNonBlocking = options?.connectionNonBlocking ?? mcpConnectionNonBlockingFromEnv();
    this.connectBatchTimeoutMs = clampToTimerMaxMs(options?.connectBatchTimeoutMs ?? mcpConnectBatchTimeoutMsFromEnv());
    // Same reason as the tool ceiling's line above: an operator who sets a lever
    // and gets silence is the defect, and a silent fallback on a typo reproduces
    // it one level down.
    const connectBatchReading = readMcpTimeoutEnv(
      process.env,
      MCP_CONNECT_BATCH_TIMEOUT_ENV,
      MCP_CONNECT_BATCH_TIMEOUT_COMPAT_ENV,
    );
    if (options?.connectBatchTimeoutMs === undefined && connectBatchReading) {
      this.debug(
        `${connectBatchReading.name}="${connectBatchReading.raw}" resolved to `
        + (this.connectBatchTimeoutMs === undefined
          ? 'NO batch cap (unusable value); the per-server connect deadline remains the only bound.'
          : `a ${this.connectBatchTimeoutMs}ms cap on each reconcile's connect batch.`),
      );
    }
    this.connectRetryAttempts = Math.max(1, Math.floor(options?.retry?.attempts ?? 1));
    this.connectRetryBaseDelayMs = Math.max(0, options?.retry?.baseDelayMs ?? 0);
    this.toolDescriptorStore = options?.toolDescriptorStore;
    // Same precedence as the deadlines above, and the same refusal to answer a
    // typo with silence: whenever the name is set at all, say what it resolved
    // to — including when it resolved to the default because it was unusable.
    this.connectionIsolation = options?.connectionIsolation ?? mcpConnectionIsolationFromEnv() ?? 'shared';
    if (options?.connectionIsolation === undefined && (process.env.NESSY_MCP_CONNECTION_ISOLATION ?? '').trim()) {
      this.debug(
        `NESSY_MCP_CONNECTION_ISOLATION="${process.env.NESSY_MCP_CONNECTION_ISOLATION}" resolved to `
        + `"${this.connectionIsolation}" `
        + (this.connectionIsolation === 'per-leaser'
          ? '— one transport per session per server, so a dynamic per-user credential is no longer shared.'
          : this.connectionIsolation === 'shared'
            ? '— one transport per distinct server config, shared by every session in this pool.'
            : `— per transport: ${[...SHARED_TRANSPORTS_DEFAULT].join('/')} shared, every other transport one per session.`),
      );
    }
    this.wsNetworkPolicy = options?.wsNetworkPolicy;
    if (options?.channelPolicy) this.channelPolicy = options.channelPolicy;
    // Seed the baseline from the real (empty) state rather than from a literal,
    // so the first publish reports a CHANGE and not merely the first reading.
    this.lastPublishedConnectionVerdict = this.connectionVerdictSignature();
  }

  /**
   * Set the summarize callback for large response handling.
   * Typically called after agent creation: pool.setSummarizeCallback(agent.getSummarizeCallback())
   */
  setSummarizeCallback(fn: (prompt: string) => Promise<string | null>): void {
    this.summarizeCallback = fn;
  }

  /**
   * Install the single-owner ask-user bridge. Kept for pools nobody leases by
   * name (headless agents, focused tests); a session on the shared workspace
   * pool must use {@link registerElicitationHandler} instead, or its prompts
   * would be indistinguishable from another session's.
   */
  setElicitationHandler(fn: McpElicitationHandler): void {
    this.elicitationHandler = fn;
  }

  /**
   * Install one leasing session's ask-user bridge, and return its release.
   *
   * Registration is deliberately NOT what makes the capability reachable: MCP
   * client capabilities are frozen at `initialize`, and on a shared pool the
   * connections predate the session, so every pool client advertises
   * `elicitation` and the routing decision is made per request (see
   * {@link resolveElicitationHandler}). Registering late therefore works;
   * registering is only how a session says which user is behind a leaser id.
   */
  registerElicitationHandler(leaserId: string, fn: McpElicitationHandler): () => void {
    this.elicitationHandlersByLeaser.set(leaserId, fn);
    return () => {
      if (this.elicitationHandlersByLeaser.get(leaserId) === fn) {
        this.elicitationHandlersByLeaser.delete(leaserId);
      }
    };
  }

  /**
   * Which session's user this connection's elicitation belongs to, or
   * `undefined` when the pool cannot say.
   *
   * Exactly one distinct leaser with a call in flight is the attributable case:
   * the server is eliciting inside that call, so its user is the one waiting.
   * Zero (an out-of-band ask), several, or an unscoped call in the mix all read
   * as "cannot say" — and are then answered by the unambiguous-handler rule
   * rather than by a guess.
   */
  private attributedElicitationLeaser(connectionKey: string): string | undefined {
    const leasers = [...(this.inFlightCallLeasers.get(connectionKey)?.keys() ?? [])];
    if (leasers.length !== 1) return undefined;
    const only = leasers[0]!;
    return only === UNSCOPED_CALL_LEASER ? undefined : only;
  }

  /**
   * Route one `elicitation/create` to a user, or to nobody.
   *
   * 1. Attributed to a leaser → that leaser's bridge, and ONLY that one. A
   *    leaser with no bridge gets no answer from a different session's user;
   *    asking the wrong person is worse than not asking.
   * 2. Unattributable, but the pool has exactly one bridge → that one. This is
   *    the single-session workspace and the headless single-owner pool, where
   *    there is no other user it could belong to.
   * 3. Otherwise → nobody, and the caller declines.
   */
  private resolveElicitationHandler(connectionKey: string): {
    handler?: McpElicitationHandler;
    reason?: string;
  } {
    const attributed = this.attributedElicitationLeaser(connectionKey);
    if (attributed !== undefined) {
      const scoped = this.elicitationHandlersByLeaser.get(attributed);
      if (scoped) return { handler: scoped };
      // A pool nobody leases by name still honours its single owner.
      if (this.elicitationHandlersByLeaser.size === 0 && this.elicitationHandler) {
        return { handler: this.elicitationHandler };
      }
      return { reason: `the calling session (${attributed}) has no interactive surface attached` };
    }

    const candidates = this.elicitationHandlersByLeaser.size > 0
      ? [...this.elicitationHandlersByLeaser.values()]
      : this.elicitationHandler ? [this.elicitationHandler] : [];
    if (candidates.length === 1) return { handler: candidates[0]! };
    return {
      reason: candidates.length === 0
        ? 'no session with an interactive surface is attached to this pool'
        : `${candidates.length} sessions share this connection and none of them has a call in flight`,
    };
  }

  /**
   * The dispatcher every pool client is built with.
   *
   * Installed unconditionally, which is what fixes the measured defect. Client
   * capabilities are declared once, at `initialize`, and the server half
   * enforces them before anything reaches the wire — the vendored SDK's
   * `server/index.js:159`: `if (!this._clientCapabilities?.elicitation) throw
   * new Error(\`Client does not support elicitation (required for ${method})\`)`,
   * with `:197` requiring `elicitation.url` for
   * `notifications/elicitation/complete` as well. On the shared workspace pool
   * the connections are made during session setup, BEFORE the agent that
   * registers a bridge exists, so keying the capability on a handler being
   * present at construction fixed it as ABSENT for the whole connection's life
   * — and a server asking anything got `-32601 Method not found`
   * (Q13-D1, measured on the packaged 1.25.1 build).
   *
   * It always answers. An elicitation with nobody to ask is DECLINED with the
   * reason logged — never dropped and never left pending, because a server held
   * open by a client that will never reply is exactly the broken-tool symptom
   * this is fixing.
   */
  private async dispatchElicitation(
    connectionKey: string,
    request: ElicitRequest,
    signal: AbortSignal,
    context: McpElicitationContext,
  ): Promise<ElicitResult> {
    const { handler, reason } = this.resolveElicitationHandler(connectionKey);
    if (!handler) {
      this.debug(
        `Declined an elicitation from "${context.server ?? this.connectionSlugs.get(connectionKey) ?? 'unknown'}": ${reason}.`,
      );
      return { action: 'decline' };
    }
    return handler(request, signal, context);
  }

  subscribeToolsChanged(listener: () => void): () => void {
    this.toolsChangedListeners.add(listener);
    return () => this.toolsChangedListeners.delete(listener);
  }

  /**
   * P3.246: be told when this pool's connection VERDICTS moved.
   *
   * Deliberately separate from {@link subscribeToolsChanged}, which fires on the
   * effective TOOL CATALOG. The two are not the same event and neither implies
   * the other: a server that answers 401 contributes no tools, so its rejection
   * leaves the catalog hash untouched and `toolsChanged` silent — which is
   * exactly the case that has to reach a sign-in prompt. In the other direction
   * a tool-list change on a healthy server moves no verdict.
   *
   * The listener is told THAT the verdict moved, never what it is: both
   * verdicts are per-leaser projections ({@link authNeededSlugs},
   * {@link health}), so each subscriber re-reads its own scope. The signature
   * behind this notification is taken at connection granularity — a superset of
   * every leaser's view — so no leaser's change can be missed by it.
   */
  subscribeConnectionVerdictChanged(listener: () => void): () => void {
    this.connectionVerdictListeners.add(listener);
    return () => this.connectionVerdictListeners.delete(listener);
  }

  subscribeChannel(leaserId: string, listener: (message: McpChannelMessage) => void): () => void {
    const listeners = this.channelSubscribers.get(leaserId) ?? new Set();
    listeners.add(listener);
    this.channelSubscribers.set(leaserId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.channelSubscribers.delete(leaserId);
    };
  }

  /**
   * Re-narrow or widen the channel gate over live connections.
   *
   * Applied immediately to every connected source rather than only to the next
   * connect: a policy that revoked a source must not leave that source's
   * dispatcher installed until it happens to reconnect.
   */
  setChannelPolicy(policy: ChannelPolicy): void {
    this.channelPolicy = policy;
    for (const [connectionKey, client] of this.clients) {
      this.applyChannelPolicy(connectionKey, client);
    }
  }

  /**
   * Install or replace the roots source (`mcp.md:108`).
   *
   * Takes effect for connections made AFTER this call, and for existing ones
   * too, because each client calls back through the pool rather than holding its
   * own copy. A pool constructed without a provider advertises no `roots`
   * capability on its already-open connections, though: the capability is sent
   * in the `initialize` handshake and cannot be added to a live connection.
   */
  setRootsProvider(provider: (() => readonly string[] | Promise<readonly string[]>) | undefined): void {
    this.rootsProvider = provider;
  }

  /**
   * `mcp.md:108` — "Claude Code sends `notifications/roots/list_changed` when
   * that set changes."
   *
   * Fans out over every live client, swallowing per-connection failures the way
   * the tools-changed and channel dispatchers already do: one server whose
   * transport just died must not stop the rest from being told.
   */
  async notifyRootsChanged(): Promise<void> {
    for (const [connectionKey, client] of this.clients) {
      try {
        await client.notifyRootsChanged?.();
      } catch (error) {
        this.debug(`roots/list_changed failed for ${connectionKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Whether any live connection for `slug` holds an installed channel
   * dispatcher. Narrow read accessor for the gate — the alternative was
   * asserting on a private map from tests.
   */
  hasChannelHandler(slug: string): boolean {
    for (const connectionKey of this.channelArmedConnections) {
      if (this.connectionSlugs.get(connectionKey) === slug && this.clients.has(connectionKey)) return true;
    }
    return false;
  }

  private isChannelPermitted(slug: string): boolean {
    if (!this.channelPolicy.enabled) return false;
    if (this.channelPolicy.deniedSources?.includes(slug)) return false;
    const allowed = this.channelPolicy.allowedSources;
    return allowed === undefined || allowed.includes(slug);
  }

  /**
   * Whether the server on this connection DECLARED itself a channel.
   *
   * P6.341 — `channels-reference.md#server-options`:
   * "`capabilities.experimental['claude/channel']` | `object` | Required. Always
   * `{}`. Presence registers the notification listener."
   *
   * Until this existed the dispatcher was armed on POLICY alone, eleven lines
   * after the handshake capabilities were read for `resources`: a server that
   * never declared a channel — every ordinary MCP source the user enabled —
   * could emit `notifications/claude/channel` and have it injected into the
   * turn, because "permitted by policy" was the whole test. The declaration is
   * the server's own statement of intent and the page makes it Required, so it
   * is a precondition here rather than a second policy dial.
   *
   * A client that cannot report capabilities at all (a third-party or test
   * double: `getServerCapabilities` is optional on {@link PoolClient}) is
   * treated as UNDECLARED, which is the fail-closed direction.
   */
  private declaresChannel(client: PoolClient): boolean {
    return client.getServerCapabilities?.()?.experimental?.[MCP_CHANNEL_CAPABILITY] !== undefined;
  }

  /** Install or revoke one connection's channel dispatcher per current policy. */
  private applyChannelPolicy(connectionKey: string, client: PoolClient): void {
    if (!client.setChannelHandler) return;
    const slug = this.connectionSlugs.get(connectionKey);
    if (slug !== undefined && this.declaresChannel(client) && this.isChannelPermitted(slug)) {
      client.setChannelHandler(message => {
        this.dispatchChannelMessage(connectionKey, client, message);
      });
      this.channelArmedConnections.add(connectionKey);
      return;
    }
    client.setChannelHandler(undefined);
    this.channelArmedConnections.delete(connectionKey);
  }

  /**
   * The term that makes a leaser's connection its own, or `undefined` when this
   * server is shared. See {@link mcpConnectionKey}.
   *
   * `DA3.2` — the decision can now be taken per TRANSPORT rather than only per
   * pool: `shared` (the default) and `per-leaser` answer without reading the
   * config at all, and `by-transport` reads {@link SHARED_TRANSPORTS_DEFAULT}.
   * The config was already in scope at the one call site; what was missing was
   * the question.
   */
  private isolationTermFor(leaserId: string, config: SdkMcpServerConfig): string | undefined {
    if (this.connectionIsolation === 'shared') return undefined;
    if (this.connectionIsolation === 'per-leaser') return leaserId;
    return SHARED_TRANSPORTS_DEFAULT.has(config.type) ? undefined : leaserId;
  }

  /**
   * Name every shared connection whose credentials a config digest cannot see.
   *
   * P3.371's auth half, made HONEST rather than silently correct: static
   * `headers` are in the digest, so two sessions carrying different static
   * credentials already get different connections. A `headersHelper` is a
   * COMMAND, digested as its spec and never as what it returns — so two sessions
   * declaring the same helper share one transport carrying whichever token
   * resolved first, and every tool call from both rides it. Nothing in the
   * transport, the log or the UI said so.
   *
   * This is a report, not a repair: the repair is
   * `NESSY_MCP_CONNECTION_ISOLATION=per-leaser`, and the line names it, because
   * a diagnostic an operator cannot act on is only a different kind of silence.
   * Once per connection key, not once per sync.
   *
   * `DA3.2` REMOVED the pool-wide `connectionIsolation !== 'shared'` guard this
   * used to open with, and the removal is the point rather than a tidy-up. That
   * guard asks a POOL-WIDE question about a fact that is now per connection:
   * under `by-transport` it would silence the report for every transport,
   * including the one it stays true of — `ws` declares `headersHelper` in the
   * config union and `ws` is shared there, so a helper-headed WebSocket server
   * two sessions hold is exactly the case this exists to name. The leaser COUNT
   * below is the honest test: it measures sharing that actually happened instead
   * of inferring it from a posture, and it keeps a forced `per-leaser` pool
   * silent for free, because no key there has two leasers.
   */
  private reportSharedDynamicHeaderConnections(): void {
    const leasersByKey = new Map<string, { leasers: Set<string>; slug: string }>();
    for (const [leaserId, desired] of this.desiredMcpByLeaser) {
      for (const [slug, entry] of desired) {
        const config = entry.config as { headersHelper?: unknown };
        if (!config.headersHelper) continue;
        const seen = leasersByKey.get(entry.connectionKey) ?? { leasers: new Set<string>(), slug };
        seen.leasers.add(leaserId);
        leasersByKey.set(entry.connectionKey, seen);
      }
    }
    for (const [connectionKey, { leasers, slug }] of leasersByKey) {
      if (leasers.size < 2 || this.reportedSharedDynamicHeaders.has(connectionKey)) continue;
      this.reportedSharedDynamicHeaders.add(connectionKey);
      this.debug(
        `${leasers.size} sessions share ONE connection to "${slug}", whose headers come from a `
        + 'headersHelper the connection identity cannot see: the digest covers the helper spec and '
        + 'never what it returns, so all of them use whichever credential resolved first. Set '
        + 'NESSY_MCP_CONNECTION_ISOLATION=per-leaser to give each session its own transport.',
      );
    }
  }

  activeLeasersForConnection(connectionKey: string): Set<string> {
    if (!this.clients.has(connectionKey) || this.drainingConnections.has(connectionKey)) return new Set();
    const leasers = new Set<string>();
    for (const [leaserId, desired] of this.desiredMcpByLeaser) {
      if ([...desired.values()].some(entry => entry.connectionKey === connectionKey)) leasers.add(leaserId);
    }
    return leasers;
  }

  private debug(msg: string): void {
    this.debugFn?.(`[McpClientPool] ${msg}`);
  }

  private emitToolsChanged(): void {
    for (const listener of [this.onToolsChanged, ...this.toolsChangedListeners]) {
      try {
        listener?.();
      } catch (error) {
        this.debug(`Tools-changed listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * The connection-granular state the two user-facing verdicts are computed
   * from: what is connected, what failed, what was rejected for credentials,
   * and what has a live capability failure. `health()` and `authNeededSlugs()`
   * project this through a leaser's desired set, so any change either of them
   * could report changes this string first.
   */
  private connectionVerdictSignature(): string {
    const sorted = (keys: Iterable<string>) => [...keys].sort();
    return JSON.stringify([
      sorted(this.clients.keys()),
      sorted(this.failedConnections),
      sorted(this.authFailedConnections),
      sorted(
        [...this.failedCapabilityKindsByConnection]
          .filter(([, kinds]) => kinds.size > 0)
          .map(([connectionKey]) => connectionKey),
      ),
    ]);
  }

  /**
   * Publish a verdict change, once per distinct state.
   *
   * Signature-guarded rather than call-site-guarded on purpose: this is called
   * from every path that can move a verdict, an extra call costs one string
   * compare, and a path that forgets to call is caught by the next one that
   * does — the pool converges on telling the truth instead of depending on a
   * complete list of writers staying complete.
   */
  private publishConnectionVerdict(): void {
    if (this.connectionVerdictPublishSuspended > 0) return;
    const signature = this.connectionVerdictSignature();
    if (signature === this.lastPublishedConnectionVerdict) return;
    this.lastPublishedConnectionVerdict = signature;
    for (const listener of [...this.connectionVerdictListeners]) {
      try {
        listener();
      } catch (error) {
        this.debug(`Connection-verdict listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private effectiveToolCatalogHash(): string {
    const entries: Array<{
      proxyName: string;
      connectionKey: string;
      slug: string;
      originalName: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations?: Tool['annotations'];
      _meta?: Tool['_meta'];
    }> = [];
    for (const [proxyName, routes] of this.proxyTools) {
      for (const [connectionKey, route] of routes) {
        const tool = this.toolCache.get(connectionKey)?.find(candidate => candidate.name === route.originalName);
        if (!tool) continue;
        // The SAME filter getProxyToolDefs applies, or the hash claims a
        // catalog that is never served and a re-read is triggered for a tool
        // no consumer can see.
        if (this.malformedToolProperties(tool).length > 0) continue;
        const { $schema, ...inputSchema } = (tool.inputSchema as Record<string, unknown>) || {};
        entries.push({
          proxyName,
          connectionKey,
          slug: route.slug,
          originalName: route.originalName,
          description: tool.description || `Tool from ${route.slug}`,
          inputSchema: Object.keys(inputSchema).length > 0 ? inputSchema : { type: 'object', properties: {} },
          // Metadata is part of what a consumer reads, so a metadata-only change
          // has to count as a catalog change — otherwise a server flipping
          // `readOnlyHint` or adding a `_meta` flag reaches `toolCache` and
          // nobody is ever told to re-read it.
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          ...(tool._meta ? { _meta: tool._meta } : {}),
        });
      }
    }
    entries.sort((left, right) => (
      left.proxyName.localeCompare(right.proxyName)
      || left.connectionKey.localeCompare(right.connectionKey)
      || left.originalName.localeCompare(right.originalName)
    ));
    return createHash('sha256').update(JSON.stringify(stableJson(entries))).digest('hex');
  }

  private proxyToolsWithConnection(
    connectionKey: string,
    slug: string,
    tools: readonly Tool[],
  ): Map<string, Map<string, ProxyRoute>> {
    const previousNames = new Map<string, string>();
    const next = new Map<string, Map<string, ProxyRoute>>();
    for (const [proxyName, routes] of this.proxyTools) {
      const copied = new Map(routes);
      const previous = copied.get(connectionKey);
      if (previous) previousNames.set(previous.originalName, proxyName);
      copied.delete(connectionKey);
      if (copied.size > 0) next.set(proxyName, copied);
    }
    const retainedNames = new Set(
      [...previousNames]
        .filter(([originalName]) => tools.some(tool => tool.name === originalName))
        .map(([, proxyName]) => proxyName),
    );
    for (const tool of tools) {
      const baseName = buildPoolProxyBaseName(slug, tool.name);
      const previousName = previousNames.get(tool.name);
      let proxyName = previousName ?? baseName;
      if (!previousName && (next.get(proxyName)?.has(connectionKey) || retainedNames.has(proxyName))) {
        let suffix = 2;
        while (next.get(`${baseName}_${suffix}`)?.has(connectionKey) || retainedNames.has(`${baseName}_${suffix}`)) suffix++;
        proxyName = `${baseName}_${suffix}`;
      }
      const routes = next.get(proxyName) ?? new Map<string, ProxyRoute>();
      routes.set(connectionKey, { slug, originalName: tool.name });
      next.set(proxyName, routes);
    }
    return next;
  }

  private async listContextCapability(
    client: PoolClient,
    kind: McpContextCapabilityKind,
  ): Promise<unknown[]> {
    const list = kind === 'resources' ? client.listResources : client.listPrompts;
    if (!list) return [];
    const bound = list.bind(client);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const raw = await bound();
        // UB7.11 — both members return ONE PAGE ({ prompts | resources,
        // nextCursor }); the discovery catalog wants the entries. UB7.10 — the
        // resources member grew the cursor and the page shape beside prompts'.
        return kind === 'prompts' ? (raw as McpPromptListPage).prompts : (raw as McpResourceListPage).resources;
      } catch (error) {
        if (attempt >= CONTEXT_DISCOVERY_RETRY_ATTEMPTS || !isRetryableDiscoveryError(error)) throw error;
        const delayMs = this.discoveryRetryDelayMs(attempt);
        if (delayMs > 0) await new Promise<void>(resolve => { setTimeout(resolve, delayMs); });
      }
    }
  }

  /** Backoff before the next capability-discovery retry attempt. Overridable in tests. */
  protected discoveryRetryDelayMs(attempt: number): number {
    return CONTEXT_DISCOVERY_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  }

  private markCapabilityFailure(connectionKey: string, kind: McpCapabilityKind): void {
    const failedKinds = this.failedCapabilityKindsByConnection.get(connectionKey) ?? new Set<McpCapabilityKind>();
    failedKinds.add(kind);
    this.failedCapabilityKindsByConnection.set(connectionKey, failedKinds);
    // `health().failed` is the union of transport failures and these, so a
    // capability that started failing moves the same verdict (P3.246).
    this.publishConnectionVerdict();
  }

  private clearCapabilityFailure(connectionKey: string, kind: McpCapabilityKind): void {
    const failedKinds = this.failedCapabilityKindsByConnection.get(connectionKey);
    if (!failedKinds) return;
    failedKinds.delete(kind);
    if (failedKinds.size === 0) this.failedCapabilityKindsByConnection.delete(connectionKey);
    this.publishConnectionVerdict();
  }

  private hasCapabilityFailure(connectionKey: string): boolean {
    return (this.failedCapabilityKindsByConnection.get(connectionKey)?.size ?? 0) > 0;
  }

  private enqueueConnectionCapabilityRefresh<T>(
    connectionKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.capabilityRefreshChains.get(connectionKey) ?? Promise.resolve();
    const refresh = prior.then(operation);
    const completion = refresh.then(() => undefined, () => undefined);
    this.capabilityRefreshChains.set(connectionKey, completion);
    void completion.then(() => {
      if (this.capabilityRefreshChains.get(connectionKey) === completion) {
        this.capabilityRefreshChains.delete(connectionKey);
      }
    });
    return refresh;
  }

  private refreshConnectionCapabilities(
    connectionKey: string,
    kind: McpCapabilityKind,
  ): Promise<void> {
    return this.enqueueConnectionCapabilityRefresh(
      connectionKey,
      () => this.refreshConnectionCapabilitiesNow(connectionKey, kind),
    );
  }

  private scheduleConnectionCapabilityRefresh(
    connectionKey: string,
    kind: McpCapabilityKind,
  ): void {
    const pending = this.pendingCapabilityNotifications.get(connectionKey) ?? new Set<McpCapabilityKind>();
    pending.add(kind);
    this.pendingCapabilityNotifications.set(connectionKey, pending);
    if (this.capabilityNotificationRunners.has(connectionKey)) return;

    const runner = this.drainConnectionCapabilityNotifications(connectionKey).catch(error => {
      this.debug(`Failed to drain MCP capability notifications for ${this.connectionSlugs.get(connectionKey) ?? connectionKey}: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.capabilityNotificationRunners.set(connectionKey, runner);
    void runner.then(() => {
      if (this.capabilityNotificationRunners.get(connectionKey) !== runner) return;
      this.capabilityNotificationRunners.delete(connectionKey);
      const pending = this.pendingCapabilityNotifications.get(connectionKey);
      const nextKind = pending?.values().next().value;
      if (nextKind) this.scheduleConnectionCapabilityRefresh(connectionKey, nextKind);
      else this.pendingCapabilityNotifications.delete(connectionKey);
    });
  }

  private async drainConnectionCapabilityNotifications(connectionKey: string): Promise<void> {
    while (true) {
      const pending = this.pendingCapabilityNotifications.get(connectionKey);
      if (!pending || pending.size === 0) return;
      const kinds = [...pending];
      pending.clear();
      for (const kind of kinds) {
        await this.refreshConnectionCapabilities(connectionKey, kind);
      }
    }
  }

  private async awaitConnectionCapabilityNotifications(connectionKey: string): Promise<void> {
    while (true) {
      const runner = this.capabilityNotificationRunners.get(connectionKey);
      const chain = this.capabilityRefreshChains.get(connectionKey);
      if (!runner && !chain) return;
      await Promise.all([runner, chain].filter((value): value is Promise<void> => value !== undefined));
    }
  }

  private async refreshConnectionCapabilitiesNow(
    connectionKey: string,
    kind: McpCapabilityKind,
  ): Promise<void> {
    const client = this.clients.get(connectionKey);
    if (!client) return;
    if (kind === 'tools') {
      const before = this.effectiveToolCatalogHash();
      try {
        const tools = await client.listTools();
        if (this.clients.get(connectionKey) !== client) return;
        const slug = this.connectionSlugs.get(connectionKey);
        if (!slug) return;
        const proxyTools = this.proxyToolsWithConnection(connectionKey, slug, tools);
        this.toolCache.set(connectionKey, tools);
        // P3.371 — the DURABLE key, isolation term stripped: what this server
        // reported is a fact about the server, not about which session held it.
        this.toolDescriptorStore?.write(toolDescriptorStoreKey(connectionKey), tools);
        this.proxyTools = proxyTools;
        this.clearCapabilityFailure(connectionKey, kind);
      } catch (error) {
        if (this.clients.get(connectionKey) === client) {
          this.markCapabilityFailure(connectionKey, kind);
          this.debug(`Failed to refresh MCP tools for ${this.connectionSlugs.get(connectionKey) ?? connectionKey}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return;
      }
      if (before !== this.effectiveToolCatalogHash()) this.emitToolsChanged();
      return;
    }
    await this.refreshContextCapability(connectionKey, kind);
  }

  private async refreshContextCapability(
    connectionKey: string,
    kind: McpContextCapabilityKind,
    onlyIfMissing = false,
  ): Promise<void> {
    const client = this.clients.get(connectionKey);
    if (!client || (onlyIfMissing && this.contextCache.get(connectionKey)?.[kind] !== undefined)) return; if (this.contextCapabilityIsUndeclared(client, kind)) { this.admitContextCapabilityAbsent(connectionKey, kind); return; } // F1.801 — absences are answers, never failures; see the helpers below the cited lines
    try {
      const values = await this.listContextCapability(client, kind);
      if (this.clients.get(connectionKey) !== client) return;
      this.contextCache.set(connectionKey, { ...this.contextCache.get(connectionKey), [kind]: values });
      this.clearCapabilityFailure(connectionKey, kind);
    } catch (error) {
      if (this.clients.get(connectionKey) === client) {
        if (this.admitContextCapabilityIfRefused(connectionKey, kind, error)) return; this.markCapabilityFailure(connectionKey, kind); // F1.801 — a -32601 refusal is the server declaring the capability absent; see the helper below the cited lines
        this.debug(`Failed to refresh MCP ${kind} for ${this.connectionSlugs.get(connectionKey) ?? connectionKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // ============================================================
  // Connection Lifecycle
  // ============================================================

  /**
   * Register a client: connect, cache tools, build proxy mappings.
   * Shared logic for both remote MCP and in-process API sources.
   */
  protected async registerClient(
    slug: string,
    client: PoolClient,
    authority?: SdkMcpServerConfig | McpServer,
    isolatedConnectionKey?: string,
  ): Promise<string> {
    // P3.371 · DA3.6 — the fallback below is now reached only by callers that
    // genuinely have no isolated identity to give: `connectInProcess`, whose API
    // servers are keyed by `apiConnectionKey` and carry no isolation term at
    // all, and `unboundConnectionKey` for a client registered with no authority.
    // Every MCP path goes through {@link connect}, which owns the key and always
    // passes it. It used to be reachable by ACCIDENT — from a subclass that
    // overrode `connect(slug, config)` and dropped the key, and (DA3.8) from
    // `connect` itself, which passed three arguments — and the recomputed key is
    // the SHARED identity, so the client was filed where nothing looked for it:
    // invisible on the default posture and unreachable under `per-leaser`. That
    // is why the seam moved to {@link openConnection}, which returns a client
    // and never reaches this method.
    const connectionKey = isolatedConnectionKey ?? (authority === undefined
      ? unboundConnectionKey(slug)
      : isSdkMcpServerConfig(authority)
        ? mcpConnectionKey(slug, authority)
        : apiConnectionKey(slug, authority));
    client.setUnexpectedCloseHandler?.(() => {
      this.handleUnexpectedConnectionClose(connectionKey, client);
    });
    client.setCapabilitiesChangedHandler?.(kind => {
      if (this.clients.get(connectionKey) !== client) return;
      this.scheduleConnectionCapabilityRefresh(connectionKey, kind);
    });
    // listTools() triggers connect() internally for both NessyMcpClient and ApiSourcePoolClient
    const tools = await client.listTools();
    this.clients.set(connectionKey, client);
    if (client.getServerCapabilities?.()?.resources) this.resourceCapableConnections.add(connectionKey);
    else this.resourceCapableConnections.delete(connectionKey);
    // Trimmed, and empty means absent: a server that returned `""` has said
    // nothing, and forwarding an empty instructions block would spend prompt
    // budget to tell the model nothing.
    const instructions = client.getInstructions?.()?.trim();
    if (instructions) this.instructionsByConnection.set(connectionKey, instructions);
    else this.instructionsByConnection.delete(connectionKey);
    this.connectionSlugs.set(connectionKey, slug);
    // Gated at installation, after the slug is known: an unpermitted source
    // never receives a dispatcher. See {@link ChannelPolicy}.
    this.applyChannelPolicy(connectionKey, client);
    this.toolCache.set(connectionKey, tools);
    // P3.371 — see the sibling write above: durable key, not the isolated one.
    this.toolDescriptorStore?.write(toolDescriptorStoreKey(connectionKey), tools);
    this.proxyTools = this.proxyToolsWithConnection(connectionKey, slug, tools);
    if (authority !== undefined) {
      if (isSdkMcpServerConfig(authority)) {
        this.activeApiServers.delete(connectionKey);
        this.activeConfigs.set(connectionKey, authority);
      } else {
        this.activeConfigs.delete(connectionKey);
        this.activeApiServers.set(connectionKey, authority);
      }
    }

    this.debug(`Connected source ${slug}: ${tools.length} tools`);
    return connectionKey;
  }

  private dispatchChannelMessage(
    connectionKey: string,
    client: PoolClient,
    message: unknown,
  ): void {
    const server = this.connectionSlugs.get(connectionKey);
    if (
      this.clients.get(connectionKey) !== client
      || this.drainingConnections.has(connectionKey)
      || !server
      || !isMcpChannelMessage(message)
      || message.server !== server
    ) return;

    for (const leaserId of this.activeLeasersForConnection(connectionKey)) {
      if (!this.activeLeasersForConnection(connectionKey).has(leaserId)) continue;
      for (const listener of this.channelSubscribers.get(leaserId) ?? []) {
        try {
          listener(message);
        } catch (error) {
          this.debug(`Channel listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  /**
   * Connect to an MCP source server (remote HTTP/SSE/stdio).
   * If already connected, this is a no-op.
   *
   * **`DA3.6` — DO NOT OVERRIDE THIS. Override {@link openConnection} instead,
   * and the `lint:chain` guard enforces it.** This method owns the connection
   * IDENTITY: it resolves the key, refuses a duplicate, and files whatever
   * {@link openConnection} returns under that key. The seam it replaces was this
   * method itself, whose third parameter was OPTIONAL — so an override written
   * `connect(slug, config)` compiled, dropped the key, and filed the client under
   * the shared identity while the reconcile waited on the isolated one. A census
   * on 2026-09-17 found 31 override sites across four test trees in three
   * packages, 28 of which dropped it; and `DA3.8` then found the same drop in
   * this very method, which had asked its subclasses in prose to do what it was
   * not doing itself. Prose does not hold. {@link openConnection} RETURNS a
   * client and never sees `registerClient`, so there is nothing left to drop.
   */
  async connect(slug: string, config: SdkMcpServerConfig, isolatedConnectionKey?: string): Promise<void> {
    // P3.371 — the reconcile already computed this identity from the DESIRING
    // leaser, which is the only place the isolation term is known; recomputing
    // it here from (slug, config) alone would file the client under the shared
    // key while the reconcile waits on the isolated one. Absent (the default
    // posture, and every caller that has no leaser in hand) it is the same key
    // this line always computed.
    const connectionKey = isolatedConnectionKey ?? mcpConnectionKey(slug, config);
    if (this.clients.has(connectionKey)) return;
    const client = await this.openConnection({ slug, config, connectionKey });
    // `undefined` is "this config opens no transport, and the reason is already
    // recorded" — an unknown server type, or a websocket target the network
    // policy refused. Both used to `return` out of the middle of this method.
    if (!client) return;
    await this.registerClient(slug, client, config, connectionKey);
    this.activeApiServers.delete(connectionKey);
    this.activeConfigs.set(connectionKey, config);
  }

  /**
   * Open ONE transport for a server, and return its client — the overridable
   * half of {@link connect}.
   *
   * `DA3.6`: this is the seam a pool subclass replaces. It receives the
   * connection key as a REQUIRED field of its one argument, purely so the two
   * halves cannot disagree about identity; it is passed for the elicitation
   * dispatcher and for the failure record, and the caller does the filing. A
   * fixture that wants a fake transport returns a fake {@link PoolClient} and
   * touches nothing else.
   *
   * Returns `undefined` when the config opens no transport at all. Both such
   * cases record their own reason before returning.
   */
  protected async openConnection(
    { slug, config, connectionKey }: McpOpenConnectionRequest,
  ): Promise<PoolClient | undefined> {
    const clientConfig = sdkConfigToClientConfig(config);
    if (!clientConfig) {
      this.debug(`Unknown MCP server type for ${slug}: ${(config as { type: string }).type}`);
      return;
    }
    if (config.type === 'ws') {
      // BEFORE the client exists, so a refused target never reaches a socket.
      const verdict = await checkMcpWsTarget(config.url, this.wsNetworkPolicy);
      if (verdict.denied) {
        // The reason is stated, not swallowed: an author whose ws server never
        // appears must be able to see why. Reasons from the guard never quote
        // the URL, so a refused embedded credential cannot leak here.
        this.debug(`MCP server "${slug}" was refused: ${verdict.reason}`);
        this.markConnectionFailed(connectionKey, `The websocket target was refused: ${verdict.reason}`);
        return;
      }
    }
    // `headersHelper` runs on EVERY connect attempt — "The helper runs fresh on
    // each connection, at session start and on reconnect. There is no caching"
    // (`mcp.md:801`). This method IS the per-attempt body `connectWithRetries`
    // drives, so resolving here (after the ws guard, before the client is
    // constructed) satisfies that. The RESOLVED headers exist only on the
    // client config: `mcpConnectionKey` above digested the declared config —
    // helper spec included, resolved values never — so reconnects keep their
    // connection identity.
    if (config.type !== 'stdio' && config.headersHelper && clientConfig.transport !== 'stdio') {
      const dynamic = await this.resolveDynamicConnectionHeaders(slug, config.headersHelper, config.url);
      if (dynamic) {
        // `mcp.md:797`: "Dynamic headers override any static `headers` with the
        // same name."
        clientConfig.headers = { ...clientConfig.headers, ...dynamic };
      }
    }
    if (clientConfig.transport === 'ws' && clientConfig.headers
      && Object.keys(clientConfig.headers).length > 0) {
      // After the dynamic merge, so a helper-only ws header set is named too.
      this.debug(`MCP server "${slug}" declares ws headers, which the WebSocket transport cannot send; they were not transmitted.`);
    }
    return new NessyMcpClient(clientConfig, {
      // Read through `this` at request time, like `rootsProvider` below and for
      // the same reason — except here it is load-bearing rather than a
      // convenience: the capability this argument declares is frozen at the
      // handshake, so passing the CURRENT handler (usually none, on a shared
      // pool) is what made a server's `elicitation/create` unanswerable.
      //
      // DA3.8 — `connectionKey` here is the ISOLATED key, and it has to be the
      // same string the client is later filed under or an elicitation from this
      // transport reaches nobody. That agreement used to depend on this method
      // remembering to pass a fourth argument to `registerClient`, and it did
      // not: it passed three, so the client was filed under the SHARED key while
      // this closure asked about the isolated one. DA3.6 made the agreement
      // structural — `connect` owns the key and does the filing, and this method
      // only receives it.
      elicitationHandler: (request, signal, context) =>
        this.dispatchElicitation(connectionKey, request, signal, context),
      channelServer: slug,
      // Read through `this` at request time, not captured, so `setRootsProvider`
      // reaches connections that already exist.
      ...(this.rootsProvider ? { rootsProvider: () => this.rootsProvider!() } : {}),
      ...(clientConfig.transport === 'stdio' && clientConfig.pluginRuntime
        ? { pluginProcessAuthority: this.pluginProcessAuthority }
        : {}),
    });
  }

  /**
   * Run one `headersHelper` for a connect attempt, fail-soft.
   *
   * The contract lives in `headers-helper.ts`: on non-zero exit, timeout,
   * spawn error or malformed stdout the connect proceeds with the STATIC
   * headers and the named reason is logged here. Helper stdout is never
   * logged — a resolved header value is a credential.
   */
  private async resolveDynamicConnectionHeaders(
    slug: string,
    spec: McpHeadersHelperSpec,
    url: string,
  ): Promise<Record<string, string> | undefined> {
    try {
      return await resolveMcpDynamicHeaders(spec, { serverName: slug, url });
    } catch (error) {
      const reason = error instanceof McpHeadersHelperError
        ? `${error.reason}: ${error.message}`
        : error instanceof Error ? error.message : String(error);
      this.debug(`MCP server "${slug}" headersHelper failed (${reason}); connecting with static headers only.`);
      return undefined;
    }
  }

  /**
   * P6.715 — mark a connection failed AND keep why. Every `failedConnections.add`
   * in this file goes through here, so a failure without a reason is a deliberate
   * omission. The reason is redacted against the connection's own configured
   * secrets before it is stored, because unlike {@link debug} this text is
   * published: `<source_issue>` (the model) and the `/mcp` report (the user). F1.325:
   * control characters go FIRST, or a secret split by one skips the redaction and the
   * model copy's defang (which strips them) re-joins it; both copies lose them alike.
   */
  private markConnectionFailed(connectionKey: string, reason: string): void {
    this.failedConnections.add(connectionKey);
    this.connectionFailureReasons.set(
      connectionKey,
      redactConfiguredMcpSecrets(stripControlCharacters(reason), this.configuredSecretsByConnection.get(connectionKey) ?? new Set()),
    );
  }

  /**
   * P6.715 — clear the failure verdict and its reason together.
   *
   * They must move as one: a reason outliving its verdict would attach the last
   * transport error to whatever failed next on the same connection identity,
   * which reads exactly like a correct answer and is not one.
   */
  private clearConnectionFailure(connectionKey: string): void {
    this.failedConnections.delete(connectionKey);
    this.connectionFailureReasons.delete(connectionKey);
  }

  /** The reason a connection failed, where one was recorded. */
  private connectionFailureReason(connectionKey: string | undefined): string | undefined {
    return connectionKey === undefined ? undefined : this.connectionFailureReasons.get(connectionKey);
  }

  /**
   * Record a 401/403 against a connection, if that is what the error is (H1).
   * Returns whether it marked, so callers can keep their own logging for the
   * non-auth case. Never touches {@link failedConnections} — a caller that also
   * wants the connection treated as unhealthy says so itself.
   */
  private noteAuthFailure(connectionKey: string, slug: string, error: unknown, context: string): boolean {
    const status = authFailureStatusOf(error);
    if (status === undefined) return false;
    this.authFailedConnections.add(connectionKey);
    this.debug(`MCP server "${slug}" needs authentication: ${context} (HTTP ${status}).`);
    // P3.246: this is the sign-in verdict itself, so it is also the moment the
    // notice that offers sign-in has to be told. Suspended inside a reconcile,
    // which publishes once when its whole batch has settled.
    this.publishConnectionVerdict();
    return true;
  }

  /**
   * Clear the needs-sign-in verdict. This is what makes the state RECOVERABLE:
   * a re-authenticated source materializes new credentials, which is a new
   * connection identity whose key was never marked, and the old key is swept by
   * the reconcile's cleanup; a helper-backed connection keeps its identity, so
   * its verdict is cleared by the first connect or tool call that succeeds.
   */
  private clearAuthFailure(connectionKey: string): void {
    this.authFailedConnections.delete(connectionKey);
    // Recovery is a verdict change too: a notice still offering sign-in for a
    // source that just authenticated is as wrong as a missing one.
    this.publishConnectionVerdict();
  }

  private handleUnexpectedConnectionClose(connectionKey: string, client: PoolClient): void {
    if (this.clients.get(connectionKey) !== client) return;
    const before = this.effectiveToolCatalogHash();
    this.abortConnectionCalls(connectionKey, 'mcp-connection-closed');
    this.clients.delete(connectionKey);
    this.channelArmedConnections.delete(connectionKey);
    for (const [proxyName, routes] of this.proxyTools) {
      routes.delete(connectionKey);
      if (routes.size === 0) this.proxyTools.delete(proxyName);
    }
    this.toolCache.delete(connectionKey);
    this.contextCache.delete(connectionKey);
    this.instructionsByConnection.delete(connectionKey);
    this.pendingCapabilityNotifications.delete(connectionKey);
    this.capabilityNotificationRunners.delete(connectionKey);
    this.markConnectionFailed(connectionKey, 'The server closed the connection unexpectedly.');
    this.failedCapabilityKindsByConnection.delete(connectionKey);
    this.debug(`Connection closed unexpectedly: ${this.connectionSlugs.get(connectionKey) ?? connectionKey}`);
    if (before !== this.effectiveToolCatalogHash()) this.emitToolsChanged();
    // A server that dropped its transport is `health().failed` from now on, and
    // nothing else in this path would say so.
    this.publishConnectionVerdict();
    this.scheduleReconnectAfterUnexpectedClose(connectionKey);
  }

  /**
   * P6.351 (denominator J43) — come back on our own after a mid-session drop.
   *
   * `mcp.md` documents three retries and TWO of them were already here:
   * first-connection ({@link connectWithRetries}, fed by the registry's
   * `MCP_CONNECT_RETRY`) and discovery-request. This is the third.
   *
   * **The row's own bounding clause was wrong, and the correction is the reason
   * this is not cosmetic.** It read *"reconnect-on-demand at the next tool call
   * already exists, so the J43 loss is bounded to a stale tool list"*. Measured
   * at HEAD: {@link handleUnexpectedConnectionClose} adds the connection to
   * {@link failedConnections}, and the on-demand path in `callTool` is guarded
   * by `config && !this.failedConnections.has(connectionKey)` — the very set
   * that field's own docblock says "governs on-demand reconnect". So a dropped
   * server did not come back at the next tool call either: the call returned
   * `MCP client for source "<slug>" is not connected.` and the server stayed
   * down for the rest of the session unless a reconcile happened to run. The
   * loss was the whole server, not a stale list.
   *
   * Deliberately reusing the pieces that already exist rather than adding a
   * mechanism beside them — {@link desiredConfigForConnection} for the config,
   * {@link connectOnce} for the shared in-flight chain, and the pool's own
   * `connectRetry*` numbers for the budget, so an operator who tunes the
   * first-connect retry tunes this too and the two cannot disagree.
   *
   * **ONE scheduled recovery per drop, not a second ladder — measured.** The
   * first shape here carried its own attempt counter on top of
   * {@link connectWithRetries}, and the two MULTIPLIED: with the production
   * `{attempts: 3}` a dead server was dialled NINE times instead of three, which
   * this suite caught (`connects` was 10, not 4). The backoff this row owes is
   * already built one layer down, so the honest thing is to schedule a single
   * recovery and let `connectOnce` supply the ladder — less code, and the two
   * budgets cannot disagree.
   *
   * Bounded and quiet by construction: one timer per connection, `unref`'d so it
   * never holds a process open, abandoned the moment the connection stops being
   * desired or comes back another way, and cleared on disconnect.
   */
  private scheduleReconnectAfterUnexpectedClose(connectionKey: string): void {
    if (this.reconnectTimers.has(connectionKey)) return;
    if (this.drainingConnections.has(connectionKey)) return;
    const slug = this.connectionSlugs.get(connectionKey);
    if (!slug || !this.desiredConfigForConnection(connectionKey)) return;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(connectionKey);
      void this.attemptScheduledReconnect(connectionKey);
    }, this.connectRetryBaseDelayMs);
    timer.unref?.();
    this.reconnectTimers.set(connectionKey, timer);
  }

  private async attemptScheduledReconnect(connectionKey: string): Promise<void> {
    // Three ways this stops being the right thing to do between the schedule and
    // the fire, all of which must be checked HERE rather than at schedule time.
    if (this.clients.has(connectionKey)) return;
    if (this.drainingConnections.has(connectionKey)) return;
    const slug = this.connectionSlugs.get(connectionKey);
    const config = slug ? this.desiredConfigForConnection(connectionKey) : undefined;
    if (!slug || !config) return;
    try {
      await this.connectOnce(connectionKey, slug, () => this.connect(slug, config, connectionKey));
      // The connection is healthy again, so the verdict that made it unavailable
      // to sync callers has to go with it — otherwise the reconnect succeeds and
      // `callTool`'s own guard still refuses the server.
      this.clearConnectionFailure(connectionKey);
      this.clearAuthFailure(connectionKey);
      this.debug(`Reconnected source ${slug} after an unexpected close`);
    } catch (err) {
      // No second ladder: `connectOnce` has already spent the configured
      // attempts. The server stays failed until a reconcile, exactly as before —
      // what changed is that it now gets one bounded recovery first.
      this.debug(
        `Scheduled reconnect failed for ${slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.publishConnectionVerdict();
  }

  /** Drop any scheduled reconnect for a connection that is going away. */
  private cancelScheduledReconnect(connectionKey: string): void {
    const timer = this.reconnectTimers.get(connectionKey);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.reconnectTimers.delete(connectionKey);
  }

  /**
   * Connect to an in-process MCP server (API source) via in-memory transport.
   */
  async connectInProcess(slug: string, mcpServer: McpServer): Promise<void> {
    const connectionKey = apiConnectionKey(slug, mcpServer);
    if (this.clients.has(connectionKey)) return;
    await this.registerClient(slug, new ApiSourcePoolClient(mcpServer), mcpServer);
    this.activeConfigs.delete(connectionKey);
    this.activeApiServers.set(connectionKey, mcpServer);
  }

  /**
   * Run one connect under {@link connectTimeoutMs} and reject when it overruns.
   *
   * A transport that never completes its handshake used to hold the reconcile —
   * and every sync queued behind it on {@link syncChain} — open forever, so one
   * hanging server stalled every turn in the workspace. Past the deadline the
   * caller records the usual per-server failure and moves on. The abandoned
   * connect is left to settle on its own: `Promise.race` keeps a later rejection
   * handled, and a late success simply registers a client the next reconcile
   * finds already present.
   */
  private async connectWithDeadline(slug: string, openConnection: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => {
          expired = true;
          reject(new Error(`Timeout: "${slug}" did not connect within ${this.connectTimeoutMs}ms`));
        },
        this.connectTimeoutMs,
      );
    });
    try {
      await Promise.race([this.connectWithRetries(slug, openConnection, () => expired), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One connect, retried with exponential backoff up to the configured attempt
   * count. A transport failure is usually transient — a 5xx from a remote server,
   * a refused socket, a stdio process that lost a race with its own runtime — and
   * before this a single one made `failedConnections` a permanent verdict for the
   * whole session.
   *
   * Runs INSIDE {@link connectWithDeadline}, so the deadline bounds the whole
   * chain rather than each attempt: a hanging transport still costs exactly one
   * deadline however many attempts are configured. `expired` stops the chain once
   * the deadline has fired, so an abandoned chain cannot keep opening transports
   * after the caller already recorded the failure and moved on.
   */
  private async connectWithRetries(
    slug: string,
    openConnection: () => Promise<void>,
    expired: () => boolean,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await openConnection();
        return;
      } catch (error) {
        if (attempt >= this.connectRetryAttempts || expired()) throw error;
        const delayMs = this.connectRetryBaseDelayMs * 2 ** (attempt - 1);
        this.debug(`Retrying connect for ${slug} in ${delayMs}ms (attempt ${attempt + 1}/${this.connectRetryAttempts}): ${error instanceof Error ? error.message : String(error)}`);
        if (delayMs > 0) await new Promise<void>(resolve => { setTimeout(resolve, delayMs); });
        if (expired()) throw error;
      }
    }
  }

  /**
   * Bring one connection identity up at most once at a time, sharing the first
   * caller's bounded attempt (and therefore its deadline) with every joiner.
   *
   * {@link callTool} now connects a cold server on demand, so several parallel
   * tool calls — or a call racing the background reconcile — can want the same
   * cold identity at the same instant. Each of them opening its own transport
   * would leave {@link registerClient} keeping only the last client, orphaning
   * the processes the others spawned.
   *
   * The bounded retry chain ({@link connectWithRetries}) runs INSIDE this dedupe,
   * so concurrent leasers share ONE chain. A retry loop layered over
   * `connectOnce` instead would give every leaser its own chain and reintroduce
   * exactly that leak, multiplied by the attempt count.
   */
  private connectOnce(
    connectionKey: string,
    slug: string,
    openConnection: () => Promise<void>,
  ): Promise<void> {
    const pending = this.pendingConnects.get(connectionKey);
    if (pending) return pending;
    // `connectWithDeadline` races before it can settle, so the attempt is always
    // pending here and the entry is registered before `finally` can clear it.
    const attempt = this.connectWithDeadline(slug, openConnection)
      .finally(() => { this.pendingConnects.delete(connectionKey); });
    this.pendingConnects.set(connectionKey, attempt);
    return attempt;
  }

  /**
   * Disconnect a source and remove its tools from the pool.
   */
  async disconnect(slug: string, exactConnectionKey?: string): Promise<void> {
    const connectionKeys = exactConnectionKey
      ? [exactConnectionKey]
      : [...this.connectionSlugs]
          .filter(([, sourceSlug]) => sourceSlug === slug)
          .map(([connectionKey]) => connectionKey);
    for (const connectionKey of connectionKeys) {
      await this.disconnectConnection(slug, connectionKey);
    }
  }

  /**
   * P6.711 — reconnect ONE server, on the user's word.
   *
   * The pool had three retries and no verb. {@link connectWithRetries} is the
   * first connect, `callTool`'s on-demand path is guarded by
   * {@link failedConnections}, and {@link scheduleReconnectAfterUnexpectedClose}
   * fires once per unexpected close and then gives up — so a server that stayed
   * down had no route back inside a session at all, and the panel's only reach
   * into the host was `performOAuth`.
   *
   * ## Why this is a drop-and-redial rather than a re-run of the scheduled path
   *
   * {@link attemptScheduledReconnect} returns early when a client already exists,
   * which is right for a recovery from an unexpected close and wrong here: a user
   * presses this precisely when a server LOOKS wrong while the pool still holds a
   * client for it — a hung transport, a stale tool list, a session that outlived
   * the server's own restart. So this drops the connection first and then dials
   * the config the pool already holds. Everything else is reused rather than
   * rebuilt: {@link desiredConfigForConnection} for the config,
   * {@link connectOnce} for the shared in-flight chain and its retry ladder, and
   * {@link disconnectConnection} for the drain — which is also what makes the
   * in-flight calls of a hung server abort rather than leak.
   *
   * ## Identity, never slug
   *
   * The connection is resolved through {@link preferredConnectionKey}, so a
   * reconnect can only ever touch the exact connection the caller's own leaser
   * resolved to; side-by-side versions of one slug stay separate, and a session
   * cannot restart another session's server by naming the same slug.
   *
   * ## Refusals are named
   *
   * Three of them, and each is a different thing to tell the user: the pool does
   * not know this server, it knows it but holds no config to dial (nothing
   * desires it any more), or it is an in-process API source — those have no
   * transport to drop, and `connectInProcess` is the only way one exists.
   * A verdict rather than a throw, because every one of these is an answer the
   * panel has to render rather than an exception.
   */
  async reconnect(slug: string, leaserId?: string): Promise<McpReconnectResult> {
    const connectionKey = this.preferredConnectionKey(slug, leaserId);
    if (!connectionKey) return { ok: false, reason: 'unknown-server' };
    if (this.activeApiServers.has(connectionKey)) return { ok: false, reason: 'in-process' };
    const config = this.desiredConfigForConnection(connectionKey);
    if (!config) return { ok: false, reason: 'no-config' };

    // Before the drop, so a recovery timer armed by the close we are about to
    // cause cannot dial in parallel with the redial below.
    this.cancelScheduledReconnect(connectionKey);
    // `disconnectConnection` clears the connection's configured-secret set, and
    // `markConnectionFailed` redacts against it before publishing a reason to the
    // model and the user. Carried across the drop so a redial that fails is
    // redacted exactly as a first connect that fails would be.
    const secrets = this.configuredSecretsByConnection.get(connectionKey);
    try {
      await this.disconnectConnection(slug, connectionKey);
      if (secrets) this.configuredSecretsByConnection.set(connectionKey, secrets);
      await this.connectOnce(connectionKey, slug, () => this.connect(slug, config, connectionKey));
      // The verdicts that made it unavailable to sync callers go with it —
      // otherwise the redial succeeds and `callTool`'s own guard still refuses
      // the server, which is the exact shape P6.351 measured.
      this.clearConnectionFailure(connectionKey);
      this.clearAuthFailure(connectionKey);
      this.debug(`Reconnected source ${slug} on request`);
      return { ok: true };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // RECORD it, do not merely report it. The drop cleared the old verdict, so
      // without this a redial that failed leaves the server neither connected nor
      // failed — `health()` would stop listing it and `serverStatuses()` would
      // call it `pending`, which says "still coming up" about a server that just
      // refused. Measured while writing this row's own negative case.
      this.markConnectionFailed(connectionKey, detail);
      this.debug(`Requested reconnect failed for ${slug}: ${detail}`);
      return { ok: false, reason: 'failed', detail };
    } finally {
      // Whichever way it went, the panel that asked is reading the verdict.
      this.publishConnectionVerdict();
    }
  }

  private async disconnectConnection(slug: string, connectionKey: string): Promise<void> {
    // Before the drain flag, so a timer that fires in the same tick still sees a
    // pool that wants this connection and is stopped by the flag rather than by
    // luck.
    this.cancelScheduledReconnect(connectionKey);
    this.drainingConnections.add(connectionKey);
    let disconnected = false;
    try {
      const client = this.clients.get(connectionKey);
      if (client) {
        const drained = await this.waitForConnectionCalls(connectionKey);
        if (!drained) {
          this.debug(`Aborting in-flight calls after drain grace expired: ${slug}`);
          this.abortConnectionCalls(connectionKey, 'mcp-connection-draining');
        }
        // Do not suppress close failures. A supervised stdio close resolves only
        // after ProcessSupervisor has observed process termination, so removing
        // this connection before close succeeds would discard process authority.
        await client.close();
        if (this.clients.get(connectionKey) === client) {
          this.clients.delete(connectionKey);
          this.channelArmedConnections.delete(connectionKey);
        }
      }

      for (const [proxyName, routes] of this.proxyTools) {
        routes.delete(connectionKey);
        if (routes.size === 0) this.proxyTools.delete(proxyName);
      }
      this.connectionSlugs.delete(connectionKey);
      this.toolCache.delete(connectionKey);
      this.contextCache.delete(connectionKey);
      this.instructionsByConnection.delete(connectionKey);
      this.pendingCapabilityNotifications.delete(connectionKey);
      this.capabilityNotificationRunners.delete(connectionKey);
      this.activeConfigs.delete(connectionKey);
      this.activeApiServers.delete(connectionKey);
      this.configuredSecretsByConnection.delete(connectionKey);
      this.clearConnectionFailure(connectionKey)
      this.clearAuthFailure(connectionKey)
      this.failedCapabilityKindsByConnection.delete(connectionKey)
      this.inFlightCalls.delete(connectionKey)
      this.inFlightCallLeasers.delete(connectionKey)
      this.inFlightCallControllers.delete(connectionKey)
      this.inFlightDrainWaiters.delete(connectionKey)
      this.debug(`Disconnected source: ${slug}`);
      disconnected = true;
    } finally {
      // A failed close stays fenced so no new call can enter an unproven
      // transport. A later disconnect/dispose call can retry the close.
      if (disconnected || !this.clients.has(connectionKey)) {
        this.drainingConnections.delete(connectionKey);
      }
    }
  }

  /**
   * Disconnect all sources and clear all state.
   */
  async disconnectAll(): Promise<void> {
    const connections = [...this.connectionSlugs];
    const results = await Promise.allSettled(connections.map(([connectionKey, slug]) => (
      this.disconnectConnection(slug, connectionKey)
    )));
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'mcp-pool-disconnect-failed');
    }
    // Drop every leaser's desired set and per-slug ownership revisions: a full
    // teardown means no leaser wants anything, so a later sync starts empty.
    this.desiredMcpByLeaser.clear()
    this.desiredApiByLeaser.clear()
    this.debug('Disconnected all MCP clients');
  }

  // ============================================================
  // Sync: Reconcile active sources
  // ============================================================

  /**
   * Sync the pool to match a desired set of MCP + API sources for ONE leaser.
   * Connects new sources, disconnects removed ones, keeps existing ones.
   *
   * The pool tracks a desired set PER leaser (`options.leaserId`, defaulting to
   * the single implicit {@link DEFAULT_LEASER_ID}) and reconciles against the
   * UNION across all leasers: a server is connected while ANY leaser wants it
   * and disconnected only when it leaves EVERY leaser's set. With a single
   * leaser (today's callers) the union equals that leaser's set, so behavior is
   * identical to the pre-refcount single-owner pool.
   *
   * Concurrent syncs from different leasers are serialized onto one chain, so a
   * later sync from leaser A cannot tear down a server leaser B still wants —
   * each reconcile sees the fully-updated per-leaser maps and computes the
   * union from them.
   *
   * @param mcpServers - Map of slug → config for this leaser's desired MCP sources
   * @param apiServers - Map of slug → config for this leaser's desired API sources
   * @param options - Optional leaser identity (defaults to the single implicit leaser)
   * @returns List of slugs that failed to connect during this reconcile
   */
  async sync(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, ApiServerConfig> = {},
    options: McpPoolSyncOptions = {}
  ): Promise<string[]> {
    const leaserId = options.leaserId ?? DEFAULT_LEASER_ID;
    const leaserAlreadyPresent = this.desiredMcpByLeaser.has(leaserId)
      || this.desiredApiByLeaser.has(leaserId);
    const unionBefore = this.desiredConnectionIdentitySet();
    const revision = ++this.desiredRevision;
    // Record this leaser's latest desired set BEFORE queuing the reconcile, so a
    // reconcile queued by another leaser that runs after this call already sees
    // the updated maps and keeps this leaser's servers in the union.
    this.desiredMcpByLeaser.set(leaserId, new Map(
      Object.entries(mcpServers).map(([slug, config]) => [
        slug,
        { config, revision, connectionKey: mcpConnectionKey(slug, config, this.isolationTermFor(leaserId, config)) },
      ]),
    ));
    this.desiredApiByLeaser.set(leaserId, new Map(
      Object.entries(apiServers).map(([slug, config]) => [
        slug,
        { config, revision, connectionKey: apiConnectionKey(slug, config.instance) },
      ]),
    ));

    this.hydrateDescriptorsFromStore(leaserId);
    this.reportSharedDynamicHeaderConnections();

    // Joining an existing union is ownership-only. In particular, a new
    // session that wants the same unavailable server as the warm browse pool
    // must inherit its recorded failed state instead of paying the transport
    // connect timeout again. An existing leaser's explicit sync still
    // reconciles unchanged identities so callers retain an intentional retry
    // primitive for transient failures.
    if (!leaserAlreadyPresent && sameConnectionIdentitySet(
      unionBefore,
      this.desiredConnectionIdentitySet(),
    )) {
      return this.syncChain.then(() => this.failedSlugsForLeaser(leaserId));
    }

    // Serialize reconciles: interleaved connect/disconnect passes over the
    // shared client map would let one leaser's disconnect race another's
    // connect. Chaining makes each reconcile atomic w.r.t. the others and every
    // reconcile computes the union from the fully-updated per-leaser maps.
    return this.queueReconcile();
  }

  /**
   * Queue one serialized reconcile, and publish exactly ONE connection verdict
   * when it has settled (P3.246).
   *
   * The suspension lives here rather than inside {@link reconcileUnion} so the
   * pass itself is untouched: a reconcile marks filtered connections failed,
   * disconnects the undesired and only then connects the rest, so every writer
   * it reaches passes through states the pool is about to contradict. One
   * publish at the end reports the settled answer, and the signature guard
   * makes it silent when nothing actually moved.
   */
  private queueReconcile(): Promise<string[]> {
    const run = this.syncChain.then(async () => {
      this.connectionVerdictPublishSuspended += 1;
      try {
        return await this.reconcileUnion();
      } finally {
        this.connectionVerdictPublishSuspended -= 1;
        this.publishConnectionVerdict();
      }
    });
    this.syncChain = run.catch(() => {});
    return run;
  }

  /**
   * Resolve once every reconcile queued SO FAR has settled, successfully or not.
   *
   * The seam a caller that dropped a `sync` promise needs in order to be honest
   * at the one moment it matters. P3.247 moved two first-turn blocks off the
   * session-setup and preflight paths, which is right — nothing there reads the
   * connect result — but a subprocess asking this pool what tools exist DOES,
   * and on codex that read has no second chance: the
   * `notifications/tools/list_changed` this pool fires when a straggler lands is
   * received and DISCARDED by that runtime. Deferring the wait is therefore only
   * safe if it can be re-paid at the point of need, which is what this exists
   * for; see {@link McpPoolServer}.
   *
   * P6.1069 — RE-READ at `rust-v0.150.1`, in the file P7.2 could not find, and
   * the claim stands unchanged. `LoggingClientHandler::on_tool_list_changed` now
   * lives in `codex-rs/rmcp-client/src/logging_client_handler.rs`, beside its
   * `on_resource_list_changed` and `on_prompt_list_changed` siblings, and its
   * whole body is:
   *
   *   `async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {`
   *   `    info!("MCP server tool list changed");`
   *   `}`
   *
   * Two details worth having rather than the bare quote. The context parameter
   * is `_context` — bound to nothing, so the handler cannot reach the connection
   * it fired for even if it wanted to; and `tool_list_changed` occurs EXACTLY
   * ONCE in the whole `codex-rs` tree at that tag, so there is no second
   * subscriber that might refresh the roster out of sight of this one. The
   * notification itself carries no params in MCP, so "drops its payload" is not
   * what happens here: there is no payload, and what is dropped is the FACT.
   *
   * P7.2's own reading is superseded rather than deleted, because its evidence
   * was sound and its conclusion was the honest one to draw from it: both
   * symbols were still in the shipped binary (`on_tool_list_changed` 3,
   * `LoggingClientHandler` 22, counted as occurrences) but the handler had left
   * `rmcp-client/src/rmcp_client.rs` and `codex-mcp/src/rmcp_client.rs`, so it
   * recorded the body as unread rather than assuming it had not changed. It had
   * not.
   *
   * It cannot hang: every connect is bounded by {@link connectTimeoutMs} and the
   * batch may additionally be capped by `NESSY_MCP_CONNECT_TIMEOUT_MS`, so the
   * chain always terminates. Rejections are swallowed because a failed reconcile
   * is a settled one — the failure is recorded on the pool and read back through
   * `health()`/`authNeededSlugs()`, which publish a change notification.
   */
  async whenReconciled(): Promise<void> {
    await this.syncChain.then(() => {}, () => {});
  }

  /**
   * Reconcile the pool to the UNION of every leaser's desired set. Runs under
   * the serialized {@link syncChain}. Reads the current per-leaser maps each
   * time so concurrently-queued reconciles all converge to the same union.
   */
  private async reconcileUnion(): Promise<string[]> {
    const before = this.effectiveToolCatalogHash();
    // Keep every distinct config identity alive while any leaser pins it. This
    // is the session-snapshot boundary: an older session must never be silently
    // rerouted to a newer plugin executable, URL, header, or credential merely
    // because another session synced later under the same public slug.
    const unionMcp = desiredConnectionUnion(this.desiredMcpByLeaser);
    const unionApi = desiredConnectionUnion(this.desiredApiByLeaser);

    // Filter out stdio sources when local MCP is disabled for this workspace.
    const localEnabled = !this.workspaceRootPath || isLocalMcpEnabled(this.workspaceRootPath);
    const filteredMcp = new Map<string, DesiredConnection<SdkMcpServerConfig>>();
    for (const [connectionKey, desired] of unionMcp) {
      const { slug, config } = desired;
      this.connectionSlugs.set(connectionKey, slug);
      if (config.type === 'stdio' && !localEnabled) {
        this.debug(`Filtering out stdio source "${slug}" (local MCP disabled)`);
        this.markConnectionFailed(connectionKey, 'Local MCP servers are disabled for this workspace.');
        continue;
      }
      filteredMcp.set(connectionKey, desired);
    }
    for (const [connectionKey, { config }] of filteredMcp) {
      const value = config as { headers?: Record<string, string>; env?: Record<string, string> }
      this.configuredSecretsByConnection.set(connectionKey, new Set(
        [...Object.values(value.headers ?? {}), ...Object.values(value.env ?? {})]
          .filter(secret => typeof secret === 'string' && secret.length >= 4),
      ));
    }

    // Extract McpServer instances from API configs
    const apiConnections = new Map<string, DesiredConnection<ApiServerConfig>>();
    for (const [connectionKey, desired] of unionApi) {
      const { config } = desired;
      if (config?.type === 'sdk' && config.instance) {
        this.connectionSlugs.set(connectionKey, desired.slug);
        apiConnections.set(connectionKey, desired);
      }
    }

    const desiredConnections = new Set([...filteredMcp.keys(), ...apiConnections.keys()]);
    const retainedDesiredConnections = new Set([...unionMcp.keys(), ...unionApi.keys()]);
    const currentConnections = new Set(this.clients.keys());
    const failures: string[] = [];

    // Disconnect sources no longer desired
    for (const connectionKey of currentConnections) {
      if (!desiredConnections.has(connectionKey)) {
        const slug = this.connectionSlugs.get(connectionKey);
        if (slug) await this.disconnect(slug, connectionKey);
      }
    }
    for (const connectionKey of [...this.connectionSlugs.keys()]) {
      if (!retainedDesiredConnections.has(connectionKey) && !this.clients.has(connectionKey)) {
        this.connectionSlugs.delete(connectionKey);
        this.clearConnectionFailure(connectionKey);
        this.clearAuthFailure(connectionKey);
        this.failedCapabilityKindsByConnection.delete(connectionKey);
        this.configuredSecretsByConnection.delete(connectionKey);
      }
    }
    for (const connectionKey of unionMcp.keys()) {
      if (!filteredMcp.has(connectionKey)) {
        this.markConnectionFailed(connectionKey, 'Local MCP servers are disabled for this workspace.');
      }
    }

    // Connects run concurrently and each one is bounded: reconcile cost is one
    // deadline rather than the sum over every server, and a server that never
    // finishes its handshake cannot hold the others (or a queued sync) back.
    // The disconnect pass above stays sequential — it mutates the shared client
    // map and is already ordered.
    //
    // A config change produces a new identity. The old connection is retained
    // only when another leaser still pins it; otherwise the pass above closes it.
    const mcpConnects = [...filteredMcp].map(([connectionKey, { slug, config }]) => ({
      connectionKey,
      slug,
      // `agent-sdk/mcp.md#connection-timing`, the first-turn-wait table: a
      // "Remote server with a cached tool list, saved by Claude Code from a
      // previous connection" does NOT delay the first turn, because "the cached
      // tools are available from the first turn". `sync` hydrated exactly that
      // list from the durable descriptor store before its first await, so this
      // is that row, not an approximation of it.
      delaysFirstTurn: !this.toolCache.has(connectionKey),
      run: async () => {
        if (this.clients.has(connectionKey)) return;
        try {
          await this.connectOnce(connectionKey, slug, () => this.connect(slug, config, connectionKey));
          this.clearConnectionFailure(connectionKey)
          this.clearAuthFailure(connectionKey)
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.debug(`Failed to connect MCP source ${slug}: ${reason}`);
          failures.push(slug);
          this.markConnectionFailed(connectionKey, reason)
          // H1: a connect the server answered 401/403 is a credential the user
          // can renew, not a server that is down.
          this.noteAuthFailure(connectionKey, slug, err, 'the connect attempt was rejected')
        }
      },
    }));

    // API server instances receive the same per-leaser identity isolation.
    //
    // The same table's third row reads "In-process SDK server — No; never delays
    // the first turn", and this pass STILL WAITS for them, deliberately. The
    // reason that row is "No" is that an in-process connect has no transport to
    // negotiate and no process to start: it cannot be the slow one. Awaiting
    // something that is already instant is observationally the same as exempting
    // it, while DEFERRING it would leave `getTools` racy for every caller that
    // reads the pool straight after `sync` — a real cost for a latency win of
    // zero. Recorded rather than silently conformed to.
    const apiConnects = [...apiConnections].map(([connectionKey, { slug, config }]) => ({
      connectionKey,
      slug,
      delaysFirstTurn: true,
      run: async () => {
        if (this.clients.has(connectionKey)) return;
        try {
          await this.connectOnce(connectionKey, slug, () => this.connectInProcess(slug, config.instance));
          this.clearConnectionFailure(connectionKey)
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.debug(`Failed to connect API source ${slug}: ${reason}`);
          failures.push(slug);
          this.markConnectionFailed(connectionKey, reason)
        }
      },
    }));

    // EVERY connect starts here. The only question the split answers is which of
    // them this reconcile WAITS for — a background connect still records its
    // failure, still populates the tool cache, and still fires `toolsChanged`
    // when it lands, which is the documented "their tools become available as
    // they finish".
    const started = [...mcpConnects, ...apiConnects].map(entry => ({ ...entry, promise: entry.run() }));
    const deferred = this.connectionNonBlocking
      ? started.filter(entry => !entry.delaysFirstTurn)
      : [];
    const awaited = started.filter(entry => !deferred.includes(entry));

    const capped = await this.awaitConnectBatch(awaited);
    if (deferred.length > 0 || capped.length > 0) {
      // A connect this reconcile did not wait for is a tool the model may not
      // see on its first turn, so it is never silent: the reason is named, and
      // so is the knob that would change it.
      const name = (entry: { slug: string }) => entry.slug;
      if (deferred.length > 0) {
        this.debug(
          `Not delaying this reconcile for ${deferred.length} connect(s) the first-turn table exempts `
          + `(${deferred.map(name).join(', ')}); their tools arrive as they finish. `
          + 'Unset NESSY_MCP_CONNECTION_NONBLOCKING to wait for the whole batch.',
        );
      }
      if (capped.length > 0) {
        this.debug(
          `Stopped waiting for ${capped.length} connect(s) after ${this.connectBatchTimeoutMs}ms `
          + `(NESSY_MCP_CONNECT_TIMEOUT_MS): ${capped.map(name).join(', ')}. They keep connecting in the background.`,
        );
      }
    }

    // A connect that lands after this reconcile returned still changes what the
    // model can call, so the catalog is re-checked when the stragglers settle.
    const stragglers = [...deferred, ...capped];
    if (stragglers.length > 0) {
      void Promise.allSettled(stragglers.map(entry => entry.promise)).then(() => {
        if (before !== this.effectiveToolCatalogHash()) this.emitToolsChanged();
        // P3.246: a connect this reconcile did not wait for settles AFTER every
        // reader has read, and `toolsChanged` above cannot carry that — a
        // server that failed contributes no tools, so the catalog hash does not
        // move. MEASURED, so the claim is the narrow one: a straggler's 401
        // would be announced anyway, by `noteAuthFailure` on its own path; what
        // ONLY this line reports is a straggler that failed for any other
        // reason, and a straggler that SUCCEEDED — which is `health().connected`
        // and the difference between an `unavailable` pool and a ready one.
        this.publishConnectionVerdict();
      });
    }

    if (before !== this.effectiveToolCatalogHash()) this.emitToolsChanged();
    return failures;
  }

  /**
   * Wait for the connects this reconcile is responsible for, and report the ones
   * the batch cap cut short.
   *
   * The cap STOPS WAITING; it never aborts. `env-vars.md#variables`, the
   * `MCP_CONNECT_TIMEOUT_MS` row: "Servers still pending at the deadline keep
   * connecting in the background." Each connect is separately bounded by the
   * per-server deadline, so an uncapped wait still terminates — which is why the
   * cap's absence is a resting state and not a hole.
   */
  private async awaitConnectBatch<T extends { slug: string; promise: Promise<void> }>(
    entries: T[],
  ): Promise<T[]> {
    if (entries.length === 0) return [];
    const capMs = this.connectBatchTimeoutMs;
    if (capMs === undefined) {
      await Promise.all(entries.map(entry => entry.promise));
      return [];
    }
    const pending = new Set(entries);
    for (const entry of entries) void entry.promise.then(() => pending.delete(entry), () => pending.delete(entry));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>(resolve => { timer = setTimeout(resolve, capMs); });
    try {
      await Promise.race([Promise.all(entries.map(entry => entry.promise)), cap]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return [...pending];
  }

  private desiredConnectionForLeaser(
    leaserId: string,
    slug: string,
  ): RevisionedDesired<SdkMcpServerConfig | ApiServerConfig> | undefined {
    return this.desiredMcpByLeaser.get(leaserId)?.get(slug)
      ?? this.desiredApiByLeaser.get(leaserId)?.get(slug);
  }

  private preferredConnectionKey(slug: string, leaserId?: string): string | undefined {
    if (leaserId !== undefined) {
      return this.desiredConnectionForLeaser(leaserId, slug)?.connectionKey;
    }

    const defaultDesired = this.desiredConnectionForLeaser(DEFAULT_LEASER_ID, slug);
    if (defaultDesired) return defaultDesired.connectionKey;

    // An unscoped caller is safe only when every contributing leaser agrees on
    // one identity. Ambiguity fails closed instead of reviving latest-wins.
    const mcpKeys = new Set<string>();
    for (const desired of this.desiredMcpByLeaser.values()) {
      const candidate = desired.get(slug);
      if (candidate) mcpKeys.add(candidate.connectionKey);
    }
    if (mcpKeys.size === 1) return [...mcpKeys][0];
    if (mcpKeys.size > 1) return undefined;
    const apiKeys = new Set<string>();
    for (const desired of this.desiredApiByLeaser.values()) {
      const candidate = desired.get(slug);
      if (candidate) apiKeys.add(candidate.connectionKey);
    }
    if (apiKeys.size === 1) return [...apiKeys][0];
    if (apiKeys.size > 1) return undefined;

    const direct = [...this.connectionSlugs].find(([, sourceSlug]) => sourceSlug === slug);
    return direct?.[0];
  }

  /** The connection identity a leaser's desired entry resolves to, if any. */
  connectionKeyForDesired(slug: string, leaserId?: string): string | undefined {
    return this.preferredConnectionKey(slug, leaserId);
  }

  /**
   * D1.219 — the per-SERVER tool wall clock this pool will actually enforce for
   * one slug, for a caller that holds the pool and not its private configs.
   *
   * D1.201 projected the SESSION ceiling into the claude SDK's own per-server
   * `timeout` key and recorded the finer value as a residue in as many words:
   * *"`createSourceProxyServers` holds the pool, not its private per-slug
   * configs, so reaching it is a pool surface this row did not ask for."* This
   * is that surface, and it is one line of reading rather than a mechanism.
   *
   * READ FROM `activeConfigs`, WHICH IS THE CALL PATH'S OWN READER, not from
   * the desired config a reconnect would use. {@link callTool} resolves the wall
   * clock as `this.activeConfigs.get(connectionKey)?.toolTimeoutMs ??
   * this.defaultToolTimeoutMs`, and a projection taken from a DIFFERENT config
   * than the one that will be enforced is the race D1.201's margin exists to
   * prevent — a backstop tighter than the bound it backs up aborts first and
   * names neither the server nor the tool.
   *
   * Resolution is by connection IDENTITY through {@link preferredConnectionKey},
   * the same resolver {@link connectionKeyForDesired} wraps, so side-by-side
   * versions of one slug and a per-leaser isolated connection answer for
   * themselves rather than for whichever one connected first.
   *
   * `undefined` means BOTH "no such connection" and "this server set no
   * per-server timeout", which is deliberate: the caller's fallback is the same
   * in either case (the session ceiling), and a three-valued answer would invite
   * a reader to treat an unconnected slug as a configured zero. The value is
   * already validated by `mcpToolTimeoutMs` at every producer — finite, floored,
   * at least `MCP_MIN_TOOL_TIMEOUT_MS` — so no caller needs to re-check it.
   */
  toolTimeoutMsForSlug(slug: string, leaserId?: string): number | undefined {
    const connectionKey = this.preferredConnectionKey(slug, leaserId);
    if (!connectionKey) return undefined;
    return this.activeConfigs.get(connectionKey)?.toolTimeoutMs;
  }

  /**
   * The MCP config behind a connection identity: what any leaser desires for it,
   * else the config it was last connected with. Matching is by identity, never by
   * slug, so a call can only ever reconnect the exact config its own route
   * resolved to — side-by-side versions of one slug stay separate.
   */
  private desiredConfigForConnection(connectionKey: string): SdkMcpServerConfig | undefined {
    for (const desired of this.desiredMcpByLeaser.values()) {
      for (const entry of desired.values()) {
        if (entry.connectionKey === connectionKey) return entry.config;
      }
    }
    return this.activeConfigs.get(connectionKey);
  }

  /** Test seam: record a completed connect's tool list without a transport. */
  primeConnectedToolsForTest(connectionKey: string, slug: string, tools: Tool[]): void {
    this.toolCache.set(connectionKey, tools);
    this.connectionSlugs.set(connectionKey, slug);
    this.proxyTools = this.proxyToolsWithConnection(connectionKey, slug, tools);
  }

  /**
   * Seed the in-memory cache and proxy routes for desired servers that have
   * durable descriptors but no live client yet, so they are advertised and
   * callable before their first connect. `clients` stays empty, so
   * `isConnected` keeps reporting the truth.
   *
   * Called from `sync` only. Hydrating lazily inside `getTools` would mutate the
   * structures `effectiveToolCatalogHash` reads, making a read change the
   * catalog hash.
   *
   * F1.665 — a record is re-partitioned exactly as a live `tools/list` is
   * ({@link partitionListedTools}): one written before F1.644/F1.643 holds the RAW
   * list, and a tool Pi cannot compile served from it failed every Pi prompt —
   * indefinitely when the live connect then failed. The next live listing
   * rewrites the record clean; until then the skip is logged here.
   */
  private hydrateDescriptorsFromStore(leaserId: string): void {
    const store = this.toolDescriptorStore;
    if (!store) return;
    for (const slug of this.slugsForLeaser(leaserId)) {
      const connectionKey = this.preferredConnectionKey(slug, leaserId);
      if (!connectionKey || this.toolCache.has(connectionKey)) continue;
      const { tools: cached, skipped } = partitionListedTools(store.read(toolDescriptorStoreKey(connectionKey)) ?? []);
      for (const entry of skipped) this.debug(`Not serving cached MCP tool "${entry.name}" from ${slug}: ${entry.reason}`);
      if (skipped.length > 0) this.hydrationSkippedTools.set(connectionKey, skipped); // F1.685 — /mcp falls back to these
      else this.hydrationSkippedTools.delete(connectionKey);
      if (!cached.length) continue;
      this.toolCache.set(connectionKey, cached);
      this.proxyTools = this.proxyToolsWithConnection(connectionKey, slug, cached);
    }
  }

  /**
   * Release a leaser: drop everything the pool holds in its name and reconcile
   * to the new union. A server that leaves the union (no other leaser wants it)
   * is disconnected by {@link reconcileUnion}'s disconnect pass; a server
   * another leaser still wants stays connected. This is the counterpart to
   * {@link sync} — the release primitive for a shared pool. Serialized on
   * {@link syncChain} exactly like `sync` so a drop cannot interleave with a
   * concurrent sync.
   * @returns List of slugs that failed to (re)connect during the reconcile.
   */
  async dropLeaser(leaserId: string): Promise<string[]> {
    const unionBefore = this.desiredConnectionIdentitySet();
    this.desiredMcpByLeaser.delete(leaserId);
    this.desiredApiByLeaser.delete(leaserId);
    // The desired sets were not the only thing filed under this id. A released
    // leaser can never have a call in flight again, so its bridge stops being a
    // user this pool could ask and becomes only an extra CANDIDATE — which is
    // what silently turns off {@link resolveElicitationHandler}'s single-bridge
    // rule: one released entry beside one live session makes `candidates.length`
    // 2 forever, and every out-of-band elicitation in that workspace declines
    // with "2 sessions share this connection". The agent-side release
    // (`BaseAgent.destroy`/`disposeForRestart`) cannot be the only purge —
    // nothing makes a backend chain it, and a lease released without an agent
    // teardown at all (a construction failure, a rolled-back setup) never
    // reaches it. Deliberately NOT done in `disconnectAll`: that tears down
    // connections, and a pool can disconnect and reconnect under sessions that
    // are still very much alive.
    this.elicitationHandlersByLeaser.delete(leaserId);
    // A redundant owner leaving cannot change connections or health. Waiting
    // for the current chain preserves ordering, while skipping reconcile avoids
    // retrying every failed connection once per disposed session.
    if (sameConnectionIdentitySet(unionBefore, this.desiredConnectionIdentitySet())) {
      return this.syncChain.then(() => []);
    }
    return this.queueReconcile();
  }

  private desiredConnectionIdentitySet(): Set<string> {
    return new Set([
      ...desiredConnectionUnion(this.desiredMcpByLeaser).keys(),
      ...desiredConnectionUnion(this.desiredApiByLeaser).keys(),
    ]);
  }

  private failedSlugsForLeaser(leaserId: string): string[] {
    const failures = new Set<string>();
    for (const [slug, desired] of this.desiredMcpByLeaser.get(leaserId) ?? []) {
      if (this.failedConnections.has(desired.connectionKey)) failures.add(slug);
    }
    for (const [slug, desired] of this.desiredApiByLeaser.get(leaserId) ?? []) {
      if (this.failedConnections.has(desired.connectionKey)) failures.add(slug);
    }
    return [...failures];
  }

  /**
   * H1: slugs whose server answered 401/403 — at connect or on a tool call.
   * Scoped to one leaser's desired set when given a `leaserId`, the whole union
   * otherwise, mirroring {@link health}.
   *
   * Deliberately NOT folded into `health()`: `failed` is connection health and
   * several callers already reason about it, while this is the user-facing
   * "sign in again" verdict the pending-auth notice turns into a Connect
   * button. A slug can be in both (a connect rejected 401 is also a failure);
   * the notice de-duplicates by promoting the auth row and dropping the
   * broken-server mention.
   */
  authNeededSlugs(leaserId?: string): string[] {
    const slugs = leaserId === undefined
      ? [...new Set(this.connectionSlugs.values())]
      : [...this.slugsForLeaser(leaserId)];
    return slugs.filter(slug => {
      const connectionKey = this.preferredConnectionKey(slug, leaserId);
      return !!connectionKey && this.authFailedConnections.has(connectionKey);
    }).sort();
  }

  /**
   * Slugs a leaser currently desires: keys of its MCP set ∪ keys of its API
   * set. Empty when the leaser has never synced (or was dropped). Used by the
   * per-session read/call guards to scope the pool's global inventory down to
   * what THIS leaser leased.
   */
  slugsForLeaser(leaserId: string): Set<string> {
    return new Set([
      ...(this.desiredMcpByLeaser.get(leaserId)?.keys() ?? []),
      ...(this.desiredApiByLeaser.get(leaserId)?.keys() ?? []),
    ]);
  }

  /** Whether this leaser has submitted a desired set, including an empty one. */
  hasLeaser(leaserId: string): boolean {
    return this.desiredMcpByLeaser.has(leaserId) || this.desiredApiByLeaser.has(leaserId);
  }

  /**
   * Pool health. With a `leaserId`, the `connected`/`failed` arrays are scoped
   * to that leaser's desired slugs (its per-session view of the shared pool);
   * without one the arrays cover the whole union — byte-identical to the
   * pre-sharing behavior (browse path passes no leaserId).
   */
  health(leaserId?: string): McpPoolHealth {
    const slugs = leaserId === undefined
      ? [...new Set(this.connectionSlugs.values())]
      : [...this.slugsForLeaser(leaserId)];
    const connected = slugs.filter(slug => this.isConnected(slug, leaserId)).sort();
    const failed = slugs.filter(slug => {
      const connectionKey = this.preferredConnectionKey(slug, leaserId);
      return !!connectionKey && (
        this.failedConnections.has(connectionKey)
        || this.hasCapabilityFailure(connectionKey)
      );
    }).sort();
    // P6.715 — the reason, beside the slug that failed. Keyed by SLUG rather
    // than by connection identity because that is what every caller has: a
    // session names its sources by slug and knows nothing of the isolation term
    // in the connection key.
    const failureReasons: Record<string, string> = {};
    for (const slug of failed) {
      const reason = this.connectionFailureReason(this.preferredConnectionKey(slug, leaserId));
      if (reason) failureReasons[slug] = reason;
    }
    return {
      status: connected.length === 0 ? 'unavailable' : failed.length === 0 ? 'ready' : 'degraded',
      connected,
      failed,
      failureReasons,
    }
  }

  /**
   * P6.352 — one line per server this leaser desires: its state and its TOOL
   * COUNT, which is the pair no surface could read before.
   *
   * Built entirely from state {@link health} and {@link getTools} already hold,
   * so it adds a view rather than a second source of truth. The two facts it
   * joins were both reachable and never joined, which is why a
   * connected-but-zero-tools server was invisible: `health()` calls it
   * `connected` and is right, and nothing else was asked.
   *
   * `toolCount` is `null` for anything not connected — a disconnected server
   * has no count, and reporting `0` there would make the one case this row
   * exists to surface indistinguishable from the ordinary one.
   *
   * `needs-auth` outranks `failed`: an expired credential is a failure the user
   * can fix in one action, and collapsing it into `failed` is what sends people
   * to look for a broken server. `pending` is the residue — a slug this leaser
   * desires that is neither connected nor recorded as failed is still coming
   * up, which is the only remaining state and is honest rather than guessed.
   *
   * `disabled` never appears here and that is a property of the pool, not an
   * omission: a server the user switched off is never synced into the desired
   * set, so the pool has nothing to report about it. The surfaces that DO know
   * (the capability catalog and the panel's Switch) own that state.
   */
  serverStatuses(leaserId?: string): readonly McpServerStatusLine[] {
    const slugs = leaserId === undefined
      ? [...new Set(this.connectionSlugs.values())]
      : [...this.slugsForLeaser(leaserId)];

    return slugs.sort().map((slug): McpServerStatusLine => {
      const connectionKey = this.preferredConnectionKey(slug, leaserId);
      if (this.isConnected(slug, leaserId)) {
        // F1.644 — a connected server whose client SKIPPED tools says which and why,
        // on the same `detail` a failed server's reason rides (the `/mcp` report prints it).
        const skipped = connectionKey ? this.skippedToolsLine(connectionKey) : undefined;
        return {
          name: slug,
          state: 'connected',
          toolCount: this.getTools(slug, leaserId).length,
          ...(skipped ? { detail: skipped } : {}),
        };
      }
      if (connectionKey && this.authFailedConnections.has(connectionKey)) {
        return { name: slug, state: 'needs-auth', toolCount: null };
      }
      if (connectionKey && (this.failedConnections.has(connectionKey) || this.hasCapabilityFailure(connectionKey))) {
        // P6.715 — `detail` was documented here as "absent on the pool, which
        // knows a connection failed but keeps the transport error at the
        // connection". The pool now keeps the reason, so the pool-backed report
        // carries one exactly where claude's `McpServerStatus.error` does.
        const detail = this.connectionFailureReason(connectionKey);
        return { name: slug, state: 'failed', toolCount: null, ...(detail ? { detail } : {}) };
      }
      const skipped = connectionKey ? this.skippedToolsLine(connectionKey) : undefined; return { name: slug, state: 'pending', toolCount: null, ...(skipped ? { detail: skipped } : {}) }; // F1.685
    });
  }

  /**
   * List cached MCP resources/prompts across connected sources. With `slugs`,
   * only those sources are read; a missing catalog is fetched for that source.
   */
  async listContextResources(
    slugs?: ReadonlySet<string>,
    leaserId?: string,
  ): Promise<readonly { sourceSlug: string; kind: 'resource' | 'prompt'; value: unknown }[]> {
    const values: { sourceSlug: string; kind: 'resource' | 'prompt'; value: unknown }[] = []
    const targetSlugs = slugs ?? new Set(this.getConnectedSlugs(leaserId));
    for (const sourceSlug of [...targetSlugs].sort()) {
      const connectionKey = this.preferredConnectionKey(sourceSlug, leaserId);
      const client = connectionKey ? this.clients.get(connectionKey) : undefined;
      if (!connectionKey || !client) continue;
      await this.enqueueConnectionCapabilityRefresh(
        connectionKey,
        () => this.refreshContextCapability(connectionKey, 'resources', true),
      );
      await this.enqueueConnectionCapabilityRefresh(
        connectionKey,
        () => this.refreshContextCapability(connectionKey, 'prompts', true),
      );
      const catalog = this.contextCache.get(connectionKey) ?? {};
      for (const value of catalog.resources ?? []) {
        values.push({
          sourceSlug,
          kind: 'resource',
          value: redactConfiguredMcpSecrets(
            value,
            this.configuredSecretsByConnection.get(connectionKey) ?? new Set(),
          ),
        });
      }
      for (const value of catalog.prompts ?? []) {
        values.push({
          sourceSlug,
          kind: 'prompt',
          value: redactConfiguredMcpSecrets(
            value,
            this.configuredSecretsByConnection.get(connectionKey) ?? new Set(),
          ),
        });
      }
    }
    return deepFreezeJson(structuredClone(values))
  }

  /**
   * Read one resource's contents from the connected server for `slug`. Routes to
   * that source's preferred connection; throws when the source is not connected
   * or does not advertise the resources capability. Read-only.
   */
  async readResource(slug: string, uri: string, leaserId?: string): Promise<McpResourceReadResult> {
    const connectionKey = this.preferredConnectionKey(slug, leaserId);
    const client = connectionKey ? this.clients.get(connectionKey) : undefined;
    if (!connectionKey || !client) throw new Error(`mcp-source-not-connected:${slug}`);
    if (!client.readResource) throw new Error(`mcp-resources-unsupported:${slug}`);
    // A read elicits too — directly, or through the `-32042` sign-in retry in
    // `client.ts` — and the in-flight ledger is the ONLY thing that names a
    // session when it does. Taking the `leaserId` and not recording it left this
    // read invisible: its own elicitation was unattributable, so it declined,
    // and when another session happened to have a tool call open on the SAME
    // connection that session's user was asked to complete THIS read's sign-in.
    const activeCall = this.beginConnectionCall(connectionKey, leaserId);
    try {
      return await client.readResource(uri);
    } finally {
      // Absent means the connection is draining, which is not a reason to fail
      // a read that was already allowed to start.
      activeCall?.release();
    }
  }

  /**
   * Render a prompt from the connected server for `slug` to messages, mapping
   * `args` onto its declared parameters. Throws when the source is not connected
   * or does not advertise the prompts capability.
   */
  async getPrompt(
    slug: string,
    name: string,
    args?: Record<string, string>,
    leaserId?: string,
  ): Promise<McpPromptGetResult> {
    const connectionKey = this.preferredConnectionKey(slug, leaserId);
    const client = connectionKey ? this.clients.get(connectionKey) : undefined;
    if (!connectionKey || !client) throw new Error(`mcp-source-not-connected:${slug}`);
    if (!client.getPrompt) throw new Error(`mcp-prompts-unsupported:${slug}`);
    // Same ledger, same reason as {@link readResource}: rendering a prompt is
    // the third call kind that can elicit, and it carried a leaser it never used.
    const activeCall = this.beginConnectionCall(connectionKey, leaserId);
    try {
      return await client.getPrompt(name, args);
    } finally {
      activeCall?.release();
    }
  }

  // ============================================================
  // MCP source prompts (UB7.11, upstream v0.15.1) — the agent-facing reads the
  // `source_list_prompts` / `source_get_prompt` session tools resolve through
  // `ctx.mcpSources`. The user-command `getPrompt` above is untouched (B4-08:
  // user-invoked prompt commands are unchanged); this half is upstream's
  // `listPrompts` / `getPrompt` pair under the agent-facing shapes, with the
  // rendered prompt under `getPromptText` because the name `getPrompt` is
  // already the user-command contract on this pool.
  // ============================================================

  /**
   * The client for a prompts or resources call on a connected source, with the
   * refusals written for the agent (upstream v0.15.1 `requireFeature`; the
   * prompts arm landed with UB7.11, the resources arm with UB7.10). Throws when
   * the source is not connected, is an API source, or its server did not
   * declare the capability (the SDK only checks capabilities in strict mode, so
   * the call would otherwise fail with a vaguer protocol error).
   */
  private requireSourceFeature(slug: string, feature: 'prompts' | 'resources', leaserId?: string): PoolClient {
    const connectionKey = this.preferredConnectionKey(slug, leaserId);
    const client = connectionKey ? this.clients.get(connectionKey) : undefined;
    if (!connectionKey || !client) {
      throw new Error(`Source "${slug}" is not connected (it may need authentication or have failed to connect).`);
    }
    if (feature === 'prompts' && (!client.listPrompts || !client.getPrompt || !client.getServerCapabilities)) {
      throw new Error(`Source "${slug}" is an API source; only MCP sources offer prompts.`);
    }
    if (feature === 'resources' && (!client.listResources || !client.getServerCapabilities)) {
      throw new Error(`Source "${slug}" is an API source; only MCP sources offer resources.`);
    }
    if (!client.getServerCapabilities?.()?.[feature]) {
      throw new Error(`Source "${slug}" does not offer ${feature}: its MCP server did not declare the ${feature} capability.`);
    }
    return client;
  }

  /**
   * List a source's prompts, following pagination up to MAX_LIST_PAGES
   * (upstream v0.15.1 `listPrompts`). Throws the agent-readable refusals of
   * {@link requireSourceFeature}.
   */
  async listPrompts(slug: string, leaserId?: string): Promise<McpPromptListing> {
    const client = this.requireSourceFeature(slug, 'prompts', leaserId);
    const connectionKey = this.preferredConnectionKey(slug, leaserId)!;
    // Same ledger as {@link readResource}: a listing elicits like any other
    // call on the connection, and the in-flight ledger is what names a session
    // when the server picks that moment to ask for sign-in.
    const activeCall = this.beginConnectionCall(connectionKey, leaserId);
    try {
      const { items, truncated } = await readAllPages(promptPages(client));
      return { prompts: items, truncated };
    } finally {
      activeCall?.release();
    }
  }

  /**
   * Get a prompt with its arguments filled in, rendered as text: a role header
   * per message, text as-is, embedded text resources inlined, binary parts
   * saved to downloads/, and the large-result guard tool results get (upstream
   * v0.15.1 `getPrompt`, under its `guardText` shape: the guard fires only when
   * the pool carries a session path, and the MCP output limit — not the
   * local-tool TOKEN_LIMIT — is the threshold, re-read identically at the
   * tool-call guard site above so the number cannot differ per backend).
   */
  async getPromptText(slug: string, name: string, args?: Record<string, string>, leaserId?: string): Promise<string> {
    const client = this.requireSourceFeature(slug, 'prompts', leaserId);
    const connectionKey = this.preferredConnectionKey(slug, leaserId)!;
    const activeCall = this.beginConnectionCall(connectionKey, leaserId);
    let result: McpPromptGetResult;
    try {
      // `requireSourceFeature` verified the member above (its API-source arm
      // lists `getPrompt` among the methods an MCP client has); the type cannot
      // see through the helper, so the read asserts it.
      result = await client.getPrompt!(name, args);
    } finally {
      activeCall?.release();
    }
    const sections = (result.messages ?? []).map(message => `[${message.role}]\n${this.renderPromptContent(slug, message.content)}`);
    if (sections.length === 0) return `Prompt "${name}" returned no messages.`;
    const text = [...(result.description ? [`Description: ${result.description}`] : []), ...sections].join('\n\n');
    if (!this.sessionPath) return text;
    const guarded = await guardLargeResult(text, {
      sessionPath: this.sessionPath,
      toolName: 'source_get_prompt',
      input: { sourceSlug: slug, name, ...(args ? { arguments: args } : {}) },
      summarize: this.summarizeCallback,
      // See the tool-call guard site: MCP-surface results share the MCP output
      // limit so the number cannot differ per backend.
      tokenLimit: mcpOutputTokenLimit(),
    });
    return guarded ?? text;
  }

  // ============================================================
  // MCP source resources (UB7.10, upstream v0.15.1) — the listing and read the
  // agent-facing resource surface resolves through, beside the UB7.11 prompt
  // pair above. The wire-facing `readResource` below (codex `resources/read`,
  // Pi's raw contents) is unchanged: this is the RENDERED read.
  // ============================================================

  /**
   * List a source's resources and resource templates, following pagination up
   * to MAX_LIST_PAGES (upstream v0.15.1 `listResources`). Templates are
   * optional within the resources capability — servers without any often
   * answer `-32601 Method not found` — so a failed template list yields none
   * instead of failing the call. Throws the agent-readable refusals of
   * {@link requireSourceFeature}.
   */
  async listResources(slug: string, leaserId?: string): Promise<McpResourceListing> {
    const client = this.requireSourceFeature(slug, 'resources', leaserId);
    const connectionKey = this.preferredConnectionKey(slug, leaserId)!;
    // Same ledger as the prompt listing: a listing elicits like any other call
    // on the connection, and the in-flight ledger is what names a session when
    // the server picks that moment to ask for sign-in.
    const activeCall = this.beginConnectionCall(connectionKey, leaserId);
    try {
      const [resources, templates] = await Promise.allSettled([
        readAllPages(resourcePages(client)),
        readAllPages(resourceTemplatePages(client)),
      ]);
      if (resources.status === 'rejected') throw resources.reason;
      if (templates.status === 'rejected') {
        this.debug(`Could not list resource templates of ${slug}: ${templates.reason instanceof Error ? templates.reason.message : String(templates.reason)}`);
      }
      const templateItems = templates.status === 'fulfilled' ? templates.value : { items: [], truncated: false };
      return {
        resources: resources.value.items,
        resourceTemplates: templateItems.items,
        truncated: resources.value.truncated || templateItems.truncated,
      };
    } finally {
      activeCall?.release();
    }
  }

  /**
   * Read a resource as agent-ready text (upstream v0.15.1 `readResource`):
   * text contents joined — with a header per item when there are several —
   * binary contents saved to the session's downloads/ like tool blobs, and the
   * large-result guard tool results get. The wire-facing {@link readResource}
   * keeps returning the raw contents.
   */
  async readResourceText(slug: string, uri: string, leaserId?: string): Promise<string> {
    const client = this.requireSourceFeature(slug, 'resources', leaserId);
    const connectionKey = this.preferredConnectionKey(slug, leaserId)!;
    const activeCall = this.beginConnectionCall(connectionKey, leaserId);
    let result: McpResourceReadResult;
    try {
      result = await client.readResource!(uri);
    } finally {
      activeCall?.release();
    }
    const contents = (result.contents ?? []) as Array<{ uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown }>;
    const parts = contents.map(item => {
      const body = typeof item.text === 'string'
        ? item.text
        : typeof item.blob === 'string'
          ? this.saveBase64(`${slug}_resource`, 'Resource', item.blob, typeof item.mimeType === 'string' ? item.mimeType : undefined)
            ?? `[Binary content (${typeof item.mimeType === 'string' ? item.mimeType : 'unknown type'}) could not be saved]`
          : '';
      return contents.length > 1
        ? `--- ${typeof item.uri === 'string' ? item.uri : ''}${typeof item.mimeType === 'string' ? ` (${item.mimeType})` : ''} ---\n${body}`
        : body;
    });
    const text = parts.join('\n\n') || `Resource ${uri} has no content.`;
    if (!this.sessionPath) return text;
    const guarded = await guardLargeResult(text, {
      sessionPath: this.sessionPath,
      toolName: 'source_read_resource',
      input: { sourceSlug: slug, uri },
      summarize: this.summarizeCallback,
      // See the tool-call guard site: MCP-surface results share the MCP output
      // limit so the number cannot differ per backend.
      tokenLimit: mcpOutputTokenLimit(),
    });
    return guarded ?? text;
  }

  /** Render one prompt message's content block for {@link getPromptText} (upstream v0.15.1 `renderPromptContent`). */
  private renderPromptContent(slug: string, content: unknown): string {
    const block = (content ?? {}) as {
      type?: string;
      text?: unknown;
      resource?: { uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown };
      data?: unknown;
      mimeType?: unknown;
      uri?: unknown;
      name?: unknown;
    };
    switch (block.type) {
      case 'text':
        return typeof block.text === 'string' ? block.text : '';
      case 'resource': {
        const resource = block.resource ?? {};
        const label = `${resource.uri ?? ''}${resource.mimeType ? ` (${resource.mimeType})` : ''}`;
        if (typeof resource.text === 'string') return `[Resource ${label}]\n${resource.text}`;
        if (typeof resource.blob === 'string') {
          return this.saveBase64(`${slug}_resource`, 'Resource', resource.blob, typeof resource.mimeType === 'string' ? resource.mimeType : undefined)
            ?? `[Binary resource ${label} could not be saved]`;
        }
        return `[Resource ${label}]`;
      }
      case 'image':
      case 'audio': {
        const kind = block.type === 'image' ? 'Image' : 'Audio';
        return this.saveBase64(`${slug}_prompt`, kind, typeof block.data === 'string' ? block.data : '', typeof block.mimeType === 'string' ? block.mimeType : undefined)
          ?? `[${kind} (${block.mimeType ?? 'unknown type'}) could not be saved]`;
      }
      case 'resource_link':
        return `[Resource link: ${block.uri ?? ''}${block.name ? ` (${block.name})` : ''}. Read it with the source's resource tools.]`;
      default:
        return `[${block.type ?? 'Unknown'} content omitted]`;
    }
  }

  /**
   * Decode base64 MCP content (image/audio blocks, resource blobs) into the
   * session's downloads/ folder and describe it for the agent. Null when there
   * is no session folder or the save failed (upstream v0.15.1 `saveBase64`;
   * the tool-call path keeps its own inline decoder).
   */
  private saveBase64(label: string, kind: string, data: string, mimeType?: string): string | null {
    if (!this.sessionPath || !data) return null;
    try {
      const buffer = Buffer.from(data, 'base64');
      const ext = detectExtensionFromMagic(buffer) || '.bin';
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `${sanitizeFilename(label)}_${timestamp}${ext}`;
      const saved = saveBinaryResponse(this.sessionPath, filename, buffer, mimeType ?? null);
      return saved.type === 'file_download' ? `[${kind} saved: ${saved.path} (${saved.sizeHuman})]` : null;
    } catch {
      // Base64 decode failed
      return null;
    }
  }

  /**
   * Whether at least one currently-connected source (scoped to `leaserId` when
   * given) declared the `resources` capability at its handshake. Synchronous, so
   * it can gate tool projection. Intersects with the live `clients` map, so a
   * stale capability entry from a since-disconnected source is never counted.
   */
  hasResourceCapability(leaserId?: string): boolean {
    const slugs = leaserId === undefined
      ? new Set(this.connectionSlugs.values())
      : this.slugsForLeaser(leaserId);
    for (const slug of slugs) {
      const connectionKey = this.preferredConnectionKey(slug, leaserId);
      if (connectionKey && this.clients.has(connectionKey) && this.resourceCapableConnections.has(connectionKey)) {
        return true;
      }
    }
    return false;
  }

  // ============================================================
  // Tool Discovery
  // ============================================================

  /**
   * Get cached tools for a source. Returns empty array if not connected.
   */
  getTools(slug: string, leaserId?: string): Tool[] {
    const connectionKey = this.preferredConnectionKey(slug, leaserId);
    return connectionKey ? this.toolCache.get(connectionKey) || [] : [];
  }

  /**
   * The property paths of one tool's input schema that the Anthropic tool
   * contract refuses, or an empty array.
   *
   * `validation.ts` records the constraint and the 400 it produces verbatim:
   * property keys must match `^[a-zA-Z0-9_.-]{1,64}$`, enforced server-side by
   * the API and defined by no MCP specification. A single violation fails the
   * WHOLE `tools` array, so before this filter one bad key from one server
   * silently took down every proxied tool on the turn.
   *
   * ## Applied on all three runtimes, deliberately
   *
   * The constraint is Anthropic's; Pi and codex would accept the key. Filtering
   * only on the claude runtime would make the model's tool universe differ by
   * runtime with nothing said — the silent divergence this fork's host layer
   * exists to prevent — and a filter here needs no runtime argument threaded
   * through callers in three other files. So the drop is uniform and the reason
   * is stated to the model in {@link getInstructions}, which is the honest half
   * the host owes: the residual difference is named rather than hidden.
   *
   * Pure over `toolCache`, so it can run on the turn's read path and there is
   * no derived set to keep in sync.
   */
  private malformedToolProperties(tool: Tool): string[] {
    const schema = (tool.inputSchema as Record<string, unknown>) || {};
    return findInvalidProperties(schema).map(entry => entry.path);
  }

  /**
   * F1.644 / F1.643 — the tools this connection's CLIENT skipped at `tools/list`
   * (`NessyMcpClient.getSkippedTools`), never in `toolCache` and so never served on
   * any runtime. Logged once per tool and reason — `mcp.md#tools-with-invalid-input-schemas`:
   * Claude Code "records the reason in the server's log" — and surfaced to the user by
   * {@link skippedToolsLine} and to the model by {@link getInstructions}.
   */
  private skippedToolsForConnection(connectionKey: string): ReturnType<NonNullable<PoolClient['getSkippedTools']>> {
    const skipped = (this.clients.has(connectionKey) ? this.clients.get(connectionKey)?.getSkippedTools?.() : this.hydrationSkippedTools.get(connectionKey)) ?? []; // F1.685 — no live client: the hydration skips
    for (const entry of skipped) {
      const reportKey = `${connectionKey}\u0000skipped\u0000${entry.name}\u0000${entry.reason}`;
      if (this.reportedMalformedTools.has(reportKey)) continue;
      this.reportedMalformedTools.add(reportKey);
      this.debug(`Skipping MCP tool "${entry.name}" from ${this.connectionSlugs.get(connectionKey) ?? connectionKey}: ${entry.reason}; the server's other tools are unaffected`);
    }
    return skipped;
  }

  /** F1.644 — the skipped tools as one status line, stripped and redacted as a failure reason is. */
  private skippedToolsLine(connectionKey: string): string | undefined {
    const skipped = this.skippedToolsForConnection(connectionKey);
    if (skipped.length === 0) return undefined;
    const listed = skipped.map(entry => `"${entry.name}" (${entry.reason})`).join('; ');
    return redactConfiguredMcpSecrets(
      stripControlCharacters(`${skipped.length === 1 ? '1 tool' : `${skipped.length} tools`} skipped: ${listed}`),
      this.configuredSecretsByConnection.get(connectionKey) ?? new Set(),
    );
  }

  /** Tool names of one connection this pool will not serve, with their reason. */
  private droppedToolsForConnection(connectionKey: string): { name: string; paths: string[] }[] {
    const dropped: { name: string; paths: string[] }[] = [];
    for (const tool of this.toolCache.get(connectionKey) || []) {
      const paths = this.malformedToolProperties(tool);
      if (paths.length > 0) dropped.push({ name: tool.name, paths });
    }
    return dropped;
  }

  /**
   * The connected source's own `instructions`, or `undefined`.
   *
   * Deliberately NOT cached in the durable descriptor store the way tools are:
   * a descriptor cache exists so a cold pool can still advertise a tool name
   * before the connect lands, whereas instructions are prose the model reads
   * once per session. Serving stale prose from a server that has since changed
   * it is worse than serving none, so this answers only for a LIVE connection.
   */
  getInstructions(slug: string, leaserId?: string): string | undefined {
    const connectionKey = this.preferredConnectionKey(slug, leaserId);
    if (!connectionKey || !this.clients.has(connectionKey)) return undefined;
    const own = this.instructionsByConnection.get(connectionKey);
    // A dropped tool is told to the MODEL here, not only to the debug log: this
    // is the one model-facing string the pool itself owns, so the notice rides
    // it with no plumbing in the two agent files that read it. A server with a
    // dropped tool and no instructions of its own therefore starts answering
    // with a notice where it used to answer `undefined` — that is the point.
    const dropped = this.droppedToolsForConnection(connectionKey);
    // F1.644 — a tool the CLIENT skipped is told the same way, after any drop notice.
    const skippedLine = this.skippedToolsLine(connectionKey);
    const skippedNotice = skippedLine
      ? `Note: this server listed tools that are unavailable this session — ${skippedLine}. They were skipped to keep this server's remaining tools working. Do not attempt to call them; tell the user the server needs fixing if the task requires them.`
      : undefined;
    const withSkipped = (text: string | undefined): string | undefined => (
      skippedNotice ? (text ? `${text}\n\n${skippedNotice}` : skippedNotice) : text
    );
    if (dropped.length === 0) return withSkipped(own);
    const names = dropped.map(entry => `"${entry.name}"`).join(', ');
    const notice = `Note: ${dropped.length === 1 ? 'one tool' : `${dropped.length} tools`} from this server ${dropped.length === 1 ? 'is' : 'are'} unavailable this session — ${names}. ${dropped.length === 1 ? 'Its' : 'Their'} input schema declares a property name the tool API refuses (it must match ${ANTHROPIC_PROPERTY_NAME_PATTERN.source}), so it was dropped to keep this server's remaining tools working. Do not attempt to call ${dropped.length === 1 ? 'it' : 'them'}; tell the user the server needs fixing if the task requires ${dropped.length === 1 ? 'it' : 'them'}.`;
    return withSkipped(own ? `${own}\n\n${notice}` : notice);
  }

  /**
   * Get all connected source slugs.
   */
  getConnectedSlugs(leaserId?: string): string[] {
    if (leaserId !== undefined) {
      return [...this.slugsForLeaser(leaserId)].filter(slug => this.isConnected(slug, leaserId));
    }
    return [...new Set(this.connectionSlugs.values())]
      .filter(slug => this.isConnected(slug));
  }

  /**
   * Check if a source is connected.
   */
  isConnected(slug: string, leaserId?: string): boolean {
    const connectionKey = this.preferredConnectionKey(slug, leaserId);
    return !!connectionKey && this.clients.has(connectionKey);
  }

  /**
   * Generate proxy tool definitions for all connected sources (or a subset).
   * These are passed to backends for tool registration.
   */
  getProxyToolDefs(slugs?: string[], leaserId?: string): ProxyToolDef[] {
    const targetSlugs = slugs || this.getConnectedSlugs(leaserId);
    const defs: ProxyToolDef[] = [];

    for (const slug of targetSlugs) {
      const tools = this.getTools(slug, leaserId);
      const connectionKey = this.preferredConnectionKey(slug, leaserId);
      for (const tool of tools) {
        // ONE malformed tool costs that one tool, never its server and never
        // the turn's whole tool array — see malformedToolProperties().
        const malformed = this.malformedToolProperties(tool);
        if (malformed.length > 0) {
          const reportKey = `${connectionKey ?? slug}\u0000${tool.name}`;
          if (!this.reportedMalformedTools.has(reportKey)) {
            this.reportedMalformedTools.add(reportKey);
            this.debug(`Dropping MCP tool "${tool.name}" from ${slug}: input-schema property ${malformed.map(path => `"${path}"`).join(', ')} does not match ${ANTHROPIC_PROPERTY_NAME_PATTERN.source}; the server's other tools are unaffected`);
          }
          continue;
        }
        // Strip $schema — AJV (Pi agent) fails on unregistered meta-schema URIs.
        // Same pattern as getToolDefsAsJsonSchema() in tool-defs.ts.
        const { $schema, ...cleanSchema } = (tool.inputSchema as Record<string, unknown>) || {};
        defs.push({
          name: this.getProxyName(slug, tool.name, leaserId),
          description: tool.description || `Tool from ${slug}`,
          inputSchema: Object.keys(cleanSchema).length > 0 ? cleanSchema : { type: 'object', properties: {} },
          // Carried verbatim, absent when the server sends none. Rebuilding a
          // tool from description + inputSchema alone discarded every advisory
          // hint and every vendor `_meta` flag one layer below the cache that
          // already stores them.
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          ...(tool._meta ? { _meta: tool._meta } : {}),
        });
      }
    }

    return defs;
  }

  /**
   * Proxy names that must stay in context regardless of deferred tool loading:
   * every tool of a server whose config sets `alwaysLoad`, plus any individual
   * tool declaring `_meta["anthropic/alwaysLoad"] === true`.
   *
   * A pure read over the same structures `getProxyToolDefs` uses, so it is safe
   * on the turn's read path and cannot change the catalog hash.
   */
  alwaysLoadProxyToolNames(slugs?: string[], leaserId?: string): ReadonlySet<string> {
    const pinned = new Set<string>();
    for (const slug of slugs ?? this.getConnectedSlugs(leaserId)) {
      const connectionKey = this.preferredConnectionKey(slug, leaserId);
      if (!connectionKey) continue;
      const serverPinned = this.activeConfigs.get(connectionKey)?.alwaysLoad === true;
      for (const tool of this.getTools(slug, leaserId)) {
        if (serverPinned || tool._meta?.[MCP_ALWAYS_LOAD_META_KEY] === true) {
          pinned.add(this.getProxyName(slug, tool.name, leaserId));
        }
      }
    }
    return pinned;
  }

  /**
   * Proxy names whose server declared `_meta["anthropic/requiresUserInteraction"]`,
   * so the permission gate can prompt on every call regardless of mode.
   *
   * Server-declared metadata is advisory and never an authorization signal — this
   * flag is admissible only because it can exclusively NARROW access. There is no
   * `_meta` value that widens anything here.
   *
   * A pure read over the same structures `getProxyToolDefs` uses, so it is safe on
   * the turn's read path.
   */
  interactionRequiredProxyToolNames(slugs?: string[], leaserId?: string): ReadonlySet<string> {
    const flagged = new Set<string>();
    for (const slug of slugs ?? this.getConnectedSlugs(leaserId)) {
      for (const tool of this.getTools(slug, leaserId)) {
        if (tool._meta?.[MCP_REQUIRES_USER_INTERACTION_META_KEY] === true) {
          flagged.add(this.getProxyName(slug, tool.name, leaserId));
        }
      }
    }
    return flagged;
  }

  // ============================================================
  // Tool Execution
  // ============================================================

  private resolveProxyRoute(
    proxyName: string,
    leaserId?: string,
  ): { connectionKey: string; slug: string; originalName: string } | undefined {
    const routes = this.proxyTools.get(proxyName);
    const anyRoute = routes?.values().next().value as { slug: string; originalName: string } | undefined;
    if (!routes || !anyRoute) return undefined;
    const connectionKey = this.preferredConnectionKey(anyRoute.slug, leaserId);
    const route = connectionKey ? routes.get(connectionKey) : undefined;
    return connectionKey && route ? { connectionKey, ...route } : undefined;
  }

  /**
   * The per-tool result allowance a server declared for one of its own tools, in
   * characters. Reads the cached descriptor's `_meta` under the documented key
   * (`code.claude.com/docs/en/mcp` — "Raise the limit for a specific tool"); the
   * clamp to the hard ceiling lives in `guardLargeResult`. A non-numeric or
   * non-positive value is ignored rather than trusted.
   */
  private declaredResultSizeChars(connectionKey: string, originalName: string): number | undefined {
    const declared = this.toolCache.get(connectionKey)
      ?.find(candidate => candidate.name === originalName)
      ?._meta?.[MCP_MAX_RESULT_SIZE_CHARS_META_KEY];
    return typeof declared === 'number' && Number.isFinite(declared) && declared > 0
      ? declared
      : undefined;
  }

  /**
   * The same declared allowance, resolved from the MODEL-VISIBLE proxy name.
   *
   * Exists for the two second guards that re-decide an already-guarded MCP
   * result one layer up (`agent/claude-agent.ts`'s `tool_result` guard and
   * `agent/local-tools/runtime.ts`'s `guardResult`): without it a result the
   * pool legitimately kept inline under `anthropic/maxResultSizeChars` is
   * persisted anyway on those backends, and the annotation appears not to work.
   *
   * A pure read over the structures `getProxyToolDefs` already uses, so it is
   * safe on the turn's read path.
   */
  declaredResultSizeCharsForProxyTool(proxyName: string, leaserId?: string): number | undefined {
    const route = this.resolveProxyRoute(proxyName, leaserId);
    return route
      ? this.declaredResultSizeChars(route.connectionKey, route.originalName)
      : undefined;
  }

  /**
   * The idle window for one call on this connection, or `undefined` when the
   * check does not apply.
   *
   * Complements the per-server wall clock (`toolTimeoutMs`) rather than replacing
   * it: the wall clock bounds how long a call may run at all, the idle window
   * bounds how long it may run with nothing to show. A wall clock of at least
   * {@link MCP_TOOL_IDLE_FLOOR_MIN_MS} acts as a FLOOR, so a server can never be
   * aborted for idleness sooner than the ceiling its own config asked for.
   *
   * In-process API servers are exempt: they have no transport that can go silent,
   * and `activeConfigs` holds no entry for them.
   */
  private toolIdleTimeoutMs(connectionKey: string): number | undefined {
    const config = this.activeConfigs.get(connectionKey);
    if (!config) return undefined;
    // *"A per-server `timeout` in `.mcp.json` of at least 1000 raises that
    // server's idle window to at least the `timeout` value"* — and the
    // `MCP_TOOL_TIMEOUT` row states the other half of the same rule: *"for the
    // per-server field, values below 1000 are ignored"*.
    const floor = (config.toolTimeoutMs ?? 0) >= MCP_TOOL_IDLE_FLOOR_MIN_MS ? config.toolTimeoutMs! : 0;
    // P6.701 — the documented spelling is read HERE for the first time, under
    // the same Nessy-wins rule the three sibling levers in this file follow. The
    // Nessy name was the only one read, so an operator following the page set a
    // variable nothing consulted.
    const reading = readMcpTimeoutEnv(
      process.env,
      MCP_TOOL_IDLE_TIMEOUT_ENV,
      MCP_TOOL_IDLE_TIMEOUT_COMPAT_ENV,
    );
    // *"the value is capped at the effective `MCP_TOOL_TIMEOUT`"* — EFFECTIVE,
    // so a per-server `timeout` is the cap where one is set and the global
    // default is the cap otherwise. An idle window above the wall clock could
    // never fire: the call is already over.
    const cap = clampToTimerMaxMs(config.toolTimeoutMs ?? this.defaultToolTimeoutMs);
    if (reading) {
      const override = Number(reading.raw.trim());
      if (Number.isFinite(override) && override >= 0) {
        // *"Set to `0` to disable the idle check."* Checked before the floor, or
        // the floor below would turn the documented off switch into one second.
        if (override === 0) return undefined;
        // *"Values below 1000 are raised to one second"*, then the per-server
        // floor, then the cap. Order matters and it is the page's: the raise is
        // about the VALUE the operator wrote, the floor is about the server's own
        // ceiling, and the cap is the wall clock nothing may usefully exceed.
        return Math.min(Math.max(override, MCP_TOOL_IDLE_TIMEOUT_MIN_MS, floor), cap);
      }
      // A value that is not a number at all leaves the lever unset rather than
      // disabling the check: an unreadable value must never widen.
    }
    return Math.min(
      Math.max(
        config.type === 'stdio' ? MCP_TOOL_IDLE_TIMEOUT_STDIO_MS : MCP_TOOL_IDLE_TIMEOUT_REMOTE_MS,
        floor,
      ),
      cap,
    );
  }

  private beginConnectionCall(connectionKey: string, leaserId?: string): {
    controller: AbortController;
    release: () => void;
  } | undefined {
    if (this.drainingConnections.has(connectionKey)) return undefined;
    const controller = new AbortController();
    this.inFlightCalls.set(connectionKey, (this.inFlightCalls.get(connectionKey) ?? 0) + 1);
    const callLeaser = leaserId ?? UNSCOPED_CALL_LEASER;
    const leasers = this.inFlightCallLeasers.get(connectionKey) ?? new Map<string, number>();
    leasers.set(callLeaser, (leasers.get(callLeaser) ?? 0) + 1);
    this.inFlightCallLeasers.set(connectionKey, leasers);
    const controllers = this.inFlightCallControllers.get(connectionKey) ?? new Set<AbortController>();
    controllers.add(controller);
    this.inFlightCallControllers.set(connectionKey, controllers);
    let released = false;
    return { controller, release: () => {
      if (released) return;
      released = true;
      const activeLeasers = this.inFlightCallLeasers.get(connectionKey);
      const remainingForLeaser = (activeLeasers?.get(callLeaser) ?? 1) - 1;
      if (remainingForLeaser > 0) activeLeasers?.set(callLeaser, remainingForLeaser);
      else activeLeasers?.delete(callLeaser);
      if (activeLeasers?.size === 0) this.inFlightCallLeasers.delete(connectionKey);
      const activeControllers = this.inFlightCallControllers.get(connectionKey);
      activeControllers?.delete(controller);
      if (activeControllers?.size === 0) this.inFlightCallControllers.delete(connectionKey);
      const remaining = Math.max(0, (this.inFlightCalls.get(connectionKey) ?? 1) - 1);
      if (remaining > 0) {
        this.inFlightCalls.set(connectionKey, remaining);
        return;
      }
      this.inFlightCalls.delete(connectionKey);
      const waiters = this.inFlightDrainWaiters.get(connectionKey);
      this.inFlightDrainWaiters.delete(connectionKey);
      for (const resolve of waiters ?? []) resolve();
    } };
  }

  private abortConnectionCalls(connectionKey: string, reason: string): void {
    for (const controller of this.inFlightCallControllers.get(connectionKey) ?? []) {
      if (!controller.signal.aborted) controller.abort(new Error(reason));
    }
  }

  private async waitForConnectionCalls(connectionKey: string): Promise<boolean> {
    if ((this.inFlightCalls.get(connectionKey) ?? 0) === 0) return true;
    let resolveDrain!: () => void;
    const drained = new Promise<void>(resolve => {
      resolveDrain = resolve;
      const waiters = this.inFlightDrainWaiters.get(connectionKey) ?? new Set();
      waiters.add(resolve);
      this.inFlightDrainWaiters.set(connectionKey, waiters);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      drained.then(() => true),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), this.connectionDrainGraceMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!completed) {
      const waiters = this.inFlightDrainWaiters.get(connectionKey);
      waiters?.delete(resolveDrain);
      if (waiters?.size === 0) this.inFlightDrainWaiters.delete(connectionKey);
    }
    return completed;
  }

  /**
   * Execute an MCP tool by its proxy name (mcp__{slug}__{toolName}).
   * Returns a result matching the subprocess protocol format.
   *
   * `context` supplies the SESSION identity used to persist this call's
   * large/binary responses: its `sessionPath` (save dir) and `summarize`
   * callback override the pool-level defaults for THIS call only. Omit it to
   * fall back to the pool's `sessionPath`/`setSummarizeCallback` — byte-equivalent
   * to today's single-session-per-pool behavior. A shared pool relies on each
   * caller passing its own session context so responses stay session-attributed.
   */
  async callTool(
    proxyName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    context?: McpCallToolContext,
  ): Promise<McpToolResult> {
    // Resolve response-persistence identity per call: the caller's context wins,
    // then the pool-level default (the only source before pool sharing).
    const effectiveSessionPath = context?.sessionPath ?? this.sessionPath;
    const effectiveSummarize = context?.summarize ?? this.summarizeCallback;
    // UB3.9 — the agent's stated purpose is per call only; there is no
    // pool-level intent a caller could silently inherit.
    const effectiveIntent = context?.intent;
    const pendingRoute = this.resolveProxyRoute(proxyName, context?.leaserId);
    if (pendingRoute) {
      await this.awaitConnectionCapabilityNotifications(pendingRoute.connectionKey);
    }
    const knownRoutes = this.proxyTools.get(proxyName);
    const info = this.resolveProxyRoute(proxyName, context?.leaserId);
    if (!info) {
      if (context?.leaserId && knownRoutes) {
        return {
          content: 'Tool not available in this session',
          isError: true,
        };
      }
      // DA3.8 — an UNSCOPED call whose name IS live is a third case, and it used
      // to be answered with the second message below. That message is false: the
      // tool is known, the pool holds routes for it, and what failed is
      // {@link preferredConnectionKey} declining to guess between several
      // connection identities for one slug. It reads as a missing server and
      // sends an operator to look for one. Under an isolating posture it is the
      // ordinary shape of an unscoped call (one connection per leaser, and the
      // caller named none of them); under the shared default it is the
      // side-by-side-versions case. Same refusal, honest reason.
      if (knownRoutes && knownRoutes.size > 1) {
        return {
          content: `MCP tool "${proxyName}" is served by ${knownRoutes.size} separate connections and this `
            + 'call names no session, so the pool cannot say which one it belongs to.',
          isError: true,
        };
      }
      return {
        content: `Unknown MCP proxy tool: ${proxyName}`,
        isError: true,
      };
    }

    const { connectionKey, slug, originalName } = info;

    let client = this.clients.get(connectionKey);
    if (!client) {
      // Connect is not on the turn's critical path, so a desired-but-cold server
      // is normal here rather than a bug: the tool surface comes from the durable
      // descriptor cache and the reconcile runs in the background. Bring the
      // server up once, under the same deadline the reconcile uses. A server
      // already known to be broken keeps the soft error instead of paying that
      // deadline again on every call.
      const config = this.desiredConfigForConnection(connectionKey);
      if (config && !this.failedConnections.has(connectionKey)) {
        try {
          await this.connectOnce(connectionKey, slug, () => this.connect(slug, config, connectionKey));
          this.clearAuthFailure(connectionKey);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.markConnectionFailed(connectionKey, reason);
          this.debug(`On-demand connect failed for ${slug}: ${reason}`);
          this.noteAuthFailure(connectionKey, slug, err, 'the connect attempt was rejected');
        }
        // P3.246: this connect runs OUTSIDE any reconcile, so nothing else here
        // would publish. `noteAuthFailure` covers the 401 case; a plain
        // transport failure (or a success) moves `health()` and would not.
        this.publishConnectionVerdict();
        client = this.clients.get(connectionKey);
      }
    }
    if (!client) {
      return {
        content: `MCP client for source "${slug}" is not connected.`,
        isError: true,
        sourceSlug: slug,
      };
    }

    const configuredSecrets = this.configuredSecretsByConnection.get(connectionKey) ?? new Set<string>();
    // `mcp.md:803`: a tool call returning 401/403 on a connection whose config
    // declares a `headersHelper` re-runs the helper, reconnects with the fresh
    // headers, and retries the call EXACTLY once; the server is marked as
    // needing authentication only if that retry also fails. A NEW branch,
    // deliberately not a widening of `isRetryableDiscoveryError` — that
    // predicate excludes 4xx on purpose, for every server.
    const declaredConfig = this.activeConfigs.get(connectionKey)
      ?? this.desiredConfigForConnection(connectionKey);
    const authRecoverable = !!declaredConfig && declaredConfig.type !== 'stdio'
      && !!declaredConfig.headersHelper;

    const failureResult = (err: unknown): McpToolResult => ({
      content: redactConfiguredMcpSecrets(
        `MCP tool "${originalName}" (source: ${slug}) failed: ${err instanceof Error ? err.message : String(err)}`,
        configuredSecrets,
      ),
      isError: true,
      sourceSlug: slug,
    });

    const attemptCall = async (
      attemptClient: PoolClient,
      authRecovery: 'rethrow' | 'mark' | 'none',
    ): Promise<McpToolResult> => {
      // The leaser rides the in-flight record, so an `elicitation/create` that
      // arrives while this call is open can be attributed to the session that
      // made it (see {@link attributedElicitationLeaser}).
      const activeCall = this.beginConnectionCall(connectionKey, context?.leaserId);
      if (!activeCall) {
        return {
          content: `MCP client for source "${slug}" is disconnecting.`,
          isError: true,
          sourceSlug: slug,
        };
      }
      // Declared out here so the `finally` below always clears the timer, on
      // every exit including the auth-recovery rethrow.
      let wallClock: { signal: AbortSignal; cancel: () => void } | undefined;
      try {
        // The wall clock on a RUNNING call, and the ONE place the two sources of
        // it are ordered. `mcp.md`, the `.mcp.json` `timeout` bullet: "This
        // overrides the `MCP_TOOL_TIMEOUT` environment variable for that server
        // only" — so a per-server field wins, and every other connection lands
        // on the global default instead of running unbounded. In-process API
        // servers hold no `activeConfigs` entry and are covered by the default
        // too: the doc exempts them from the IDLE check only, and a lever an
        // operator sets must not have a silent hole in it.
        const perServerTimeoutMs = this.activeConfigs.get(connectionKey)?.toolTimeoutMs;
        const wallClockMs = clampToTimerMaxMs(perServerTimeoutMs ?? this.defaultToolTimeoutMs);
        // Named, because `AbortSignal.timeout` aborts with a bare "The operation
        // timed out" that says neither the number nor which knob produced it —
        // and this message is what `failureResult` puts in front of the model.
        wallClock = toolWallClockAbort(wallClockMs, new Error(
          `exceeded its ${wallClockMs}ms wall clock, set by ${perServerTimeoutMs !== undefined
            ? 'the "timeout" field configured for this server'
            // Name the spelling the operator actually set, not the canonical one:
            // an inherited `MCP_TOOL_TIMEOUT` is the case where naming the wrong
            // name sends the reader looking for a variable nobody set.
            : (readMcpTimeoutEnv(process.env, MCP_TOOL_TIMEOUT_ENV, MCP_TOOL_TIMEOUT_COMPAT_ENV)?.name
              ?? MCP_TOOL_TIMEOUT_ENV)}`,
        ));
        const callSignal = AbortSignal.any([
          activeCall.controller.signal,
          ...(signal ? [signal] : []),
          wallClock.signal,
        ]);
        if (callSignal.aborted) throw abortReason(callSignal, 'mcp-tool-call-aborted');
        const idleTimeoutMs = this.toolIdleTimeoutMs(connectionKey);
        const result = await settleOnAbort(
          attemptClient.callTool(
            originalName,
            args,
            callSignal,
            {
              ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
              ...(effectiveIntent !== undefined ? { intent: effectiveIntent } : {}),
            },
          ),
          callSignal,
        ) as {
          content?: Array<{
            type: string;
            text?: unknown;
            data?: string;
            mimeType?: string;
            /** `resource_link` — MCP `ResourceLinkSchema` (uri + name are required there). */
            uri?: string;
            name?: string;
            description?: string;
            /** `resource` — MCP `EmbeddedResourceSchema`, text OR blob, never both. */
            resource?: { uri?: string; mimeType?: string; text?: unknown; blob?: string };
          }>;
          structuredContent?: Record<string, unknown>;
          isError?: boolean;
        };
        // A call the server accepted is proof the credential works again — the
        // recovery path for a connection whose identity did NOT change across
        // the re-auth (a `headersHelper` server mints its token per connect, so
        // its key is the same before and after).
        this.clearAuthFailure(connectionKey);
        const structuredContent = hasStructuredContent(result.structuredContent)
          ? redactConfiguredMcpSecrets(result.structuredContent, configuredSecrets)
          : undefined;

        const contentBlocks = result.content || [];
        const parts: string[] = [];
        /**
         * True once a block contributed the content it carried, as opposed to a
         * note saying it could not be rendered. It is what the JSON fallback
         * below keys on, so a result made up ENTIRELY of unrenderable blocks
         * still falls back to the raw payload exactly as it did before notes
         * existed — the notes are added to that fallback, never a substitute
         * for it.
         */
        let extracted = false;

        /**
         * Decode a base64 payload into this session's `downloads/` and describe
         * it, or `null` when it cannot be saved — no payload, no session path, a
         * corrupt payload, or a failed write. Every `null` is reported by the
         * caller; none of them is silent any more.
         */
        const saveDecoded = (data: string | undefined, mimeType: string | undefined): string | null => {
          if (!data || !effectiveSessionPath) return null;
          try {
            const buffer = Buffer.from(data, 'base64');
            const ext = detectExtensionFromMagic(buffer) || '.bin';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const safeName = sanitizeFilename(proxyName);
            const filename = `${safeName}_${timestamp}${ext}`;
            const saved = saveBinaryResponse(effectiveSessionPath, filename, buffer, mimeType ?? null);
            return saved.type === 'file_download' ? `${saved.path} (${saved.sizeHuman})` : null;
          } catch {
            return null;
          }
        };

        // 1. Process each content block.
        //
        // The MCP SDK this pool is built against (`@modelcontextprotocol/sdk`
        // 1.29.0) defines FIVE `ContentBlock` members — text, image, audio,
        // resource_link, resource — and this loop rendered three. The two it
        // skipped vanished WITHOUT A TRACE whenever the result also carried
        // text, because the `JSON.stringify(result)` fallback below fires only
        // when nothing at all was extracted: the text arrived, the resource did
        // not, and nothing said so.
        //
        // `mcp.md` is silent on how a resource inside a TOOL RESULT should be
        // rendered — it specifies resources only as `@server:uri` mentions and
        // as the list/read tools (`mcp.md#use-mcp-resources`) — so the shape
        // below is our decision, and deliberately the smallest honest one:
        // inline what the server already sent as text, persist what it sent as
        // bytes exactly like an image, and NAME what cannot be rendered instead
        // of dropping it. The closing `else` keeps that true for a block type a
        // later SDK revision adds, which is the failure this loop just had.
        for (const block of contentBlocks) {
          if (block.type === 'text') {
            // Handle non-string text fields (e.g., objects from non-conforming servers)
            if (typeof block.text === 'string') {
              parts.push(block.text);
              extracted = true;
            } else if (block.text !== undefined && block.text !== null) {
              parts.push(JSON.stringify(block.text, null, 2));
              extracted = true;
            }
          } else if (block.type === 'image' || block.type === 'audio') {
            // Decode base64 binary content and save to downloads/
            const label = block.type === 'image' ? 'Image' : 'Audio';
            const saved = saveDecoded(block.data, block.mimeType);
            if (saved) {
              parts.push(`[${label} saved: ${saved}]`);
              extracted = true;
            } else {
              parts.push(`[${label} content returned by "${proxyName}" could not be saved and is not shown.]`);
            }
          } else if (block.type === 'resource') {
            const resource = block.resource ?? {};
            const label = [resource.uri, resource.mimeType].filter(Boolean).join(', ') || 'unknown resource';
            if (typeof resource.text === 'string') {
              parts.push(`[Resource: ${label}]\n${resource.text}`);
              extracted = true;
            } else if (resource.text !== undefined && resource.text !== null) {
              parts.push(`[Resource: ${label}]\n${JSON.stringify(resource.text, null, 2)}`);
              extracted = true;
            } else {
              const saved = saveDecoded(resource.blob, resource.mimeType);
              if (saved) {
                parts.push(`[Resource saved: ${saved}] ${label}`);
                extracted = true;
              } else {
                parts.push(`[Resource: ${label} — contents were not shown.]`);
              }
            }
          } else if (block.type === 'resource_link') {
            // A link carries no contents by design ("resource links returned by
            // tools are not guaranteed to appear in the results of
            // `resources/list`"), so naming it IS rendering it.
            const label = [block.name, block.uri].filter(Boolean).join(': ') || 'unknown resource';
            const mime = block.mimeType ? ` (${block.mimeType})` : '';
            const description = typeof block.description === 'string' && block.description
              ? `\n${block.description}`
              : '';
            parts.push(`[Resource link: ${label}${mime}]${description}`);
            extracted = true;
          } else {
            parts.push(`[MCP content block of type "${block.type}" is not supported and was omitted from this result.]`);
          }
        }

        // 2. Combine parts (fallback to JSON.stringify if no content extracted)
        const rendered = parts.join('\n');
        const text = redactConfiguredMcpSecrets(
          extracted ? rendered : [rendered, JSON.stringify(result)].filter(Boolean).join('\n'),
          configuredSecrets,
        );

        // 3. Centralized binary + large response handling
        if (!result.isError) {
          // `mcp.md:246` — "Claude Code displays a warning when MCP tool output
          // exceeds 10,000 tokens and limits output to 25,000 tokens by default
          // … the warning threshold is fixed." Emitted on the pool's existing
          // debug channel; deliberately independent of the session path, since
          // the size is a fact about the call, not about persistence.
          const estimatedTokens = estimateTokensDensityAware(text);
          if (estimatedTokens > MCP_OUTPUT_WARN_TOKENS) {
            this.debug(`MCP tool "${proxyName}" returned ~${estimatedTokens} tokens, over the ${MCP_OUTPUT_WARN_TOKENS}-token warning threshold (limit ${mcpOutputTokenLimit()}).`);
          }
        }
        if (!result.isError && effectiveSessionPath) {
          const declaredResultSize = this.declaredResultSizeChars(connectionKey, originalName);
          const guarded = await guardLargeResult(text, {
            sessionPath: effectiveSessionPath,
            toolName: proxyName,
            input: args,
            summarize: effectiveSummarize,
            // UB3.9 (upstream v0.15.1 `guardText(text, toolName, input, intent)`):
            // the agent's stated purpose steers the summariser's relevance, so
            // MCP-source summaries get the same goal context local tools have.
            ...(effectiveIntent !== undefined ? { intent: effectiveIntent } : {}),
            // `agent-sdk/mcp.md:894` / `mcp.md:1040` — MCP results are governed
            // by the MCP output limit (25,000 tokens by default), not by the
            // local-tool TOKEN_LIMIT. Read once here and re-read identically at
            // the two second-guard sites so the number cannot differ per backend.
            tokenLimit: mcpOutputTokenLimit(),
            ...(declaredResultSize !== undefined ? { maxResultSizeChars: declaredResultSize } : {}),
          });
          if (guarded) {
            return {
              content: guarded,
              isError: false,
              ...(structuredContent ? { structuredContent } : {}),
            };
          }
        }

        return {
          content: text,
          isError: !!result.isError,
          ...(structuredContent ? { structuredContent } : {}),
        };
      } catch (err) {
        const status = authFailureStatusOf(err);
        if (status !== undefined) {
          // First attempt on a helper-backed connection: hand the failure to
          // the retry-once branch below instead of minting an error result.
          if (authRecovery === 'rethrow') throw err;
          if (authRecovery === 'mark') {
            // The once-retried call failed too (`mcp.md:803`) — mark the server
            // as needing authentication, so on-demand connects stop paying the
            // deadline for a credential the helper cannot mint.
            this.markConnectionFailed(connectionKey, 'The call failed again after re-running headersHelper.');
          }
          // H1: EVERY 401/403 on a tool call is a needs-sign-in verdict, not
          // just the helper-backed one — a plain bearer/oauth server whose
          // token the provider revoked reaches here with `authRecovery: 'none'`
          // and used to produce nothing but a soft error string.
          this.noteAuthFailure(connectionKey, slug, err, authRecovery === 'mark'
            ? 'the call failed again after re-running headersHelper'
            : 'the tool call was rejected');
        }
        return failureResult(err);
      } finally {
        wallClock?.cancel();
        activeCall.release();
      }
    };

    try {
      return await attemptCall(client, authRecoverable ? 'rethrow' : 'none');
    } catch (err) {
      // Only a 401/403 on a helper-backed connection is rethrown above.
      const status = authFailureStatusOf(err);
      this.debug(`MCP tool call on "${slug}" failed ${status}; re-running headersHelper, reconnecting, and retrying once.`);
      try {
        await this.disconnectConnection(slug, connectionKey);
        // `connect` resolves the helper on every attempt, so this reconnect IS
        // the documented "re-runs the helper, reconnects with the fresh
        // headers" (`mcp.md:803`).
        await this.connectOnce(connectionKey, slug, () => this.connect(slug, declaredConfig!, connectionKey));
      } catch (reconnectError) {
        this.markConnectionFailed(connectionKey, `The reconnect failed: ${reconnectError instanceof Error ? reconnectError.message : String(reconnectError)}`);
        this.noteAuthFailure(connectionKey, slug, err, `reconnect failed: ${reconnectError instanceof Error ? reconnectError.message : String(reconnectError)}`);
        return failureResult(err);
      }
      const freshClient = this.clients.get(connectionKey);
      if (!freshClient) {
        this.markConnectionFailed(connectionKey, 'The reconnect did not restore the connection.');
        this.noteAuthFailure(connectionKey, slug, err, 'the reconnect did not restore the connection');
        return failureResult(err);
      }
      return attemptCall(freshClient, 'mark');
    }
  }

  /**
   * Check if a tool name is an MCP proxy tool managed by this pool. When a
   * `leaserId` is supplied, ADDITIONALLY require the proxy's slug to be in that
   * leaser's desired set — so a session only "sees" the tools it leased. Omit
   * `leaserId` for today's global behavior (any managed proxy tool matches).
   */
  isProxyTool(toolName: string, leaserId?: string): boolean {
    return this.resolveProxyRoute(toolName, leaserId) !== undefined;
  }

  /**
   * Look up the registered proxy name for a source's original tool name.
   * `registerClient` is the single authority for proxy naming (sanitization +
   * collision suffixes), so backends must read the name back instead of
   * recomputing it. Falls back to the naive name if not found (defensive).
   */
  getProxyName(slug: string, originalName: string, leaserId?: string): string {
    const connectionKey = this.preferredConnectionKey(slug, leaserId);
    if (connectionKey) {
      for (const [proxyName, routes] of this.proxyTools) {
        const info = routes.get(connectionKey);
        if (info?.slug === slug && info.originalName === originalName) return proxyName;
      }
    }
    return buildPoolProxyBaseName(slug, originalName);
  }

  /**
   * F1.1282 — whether `leaserId` leases a live connection whose channel
   * dispatcher is installed: the server declared `claude/channel` AND the
   * channel policy permits it ({@link applyChannelPolicy}). Only such a
   * connection can push `notifications/claude/channel` to the leaser's
   * {@link subscribeChannel} listeners; a subscription with none of them has
   * nothing to wake it.
   */
  hasArmedChannelConnection(leaserId: string): boolean {
    for (const connectionKey of this.channelArmedConnections) {
      if (this.activeLeasersForConnection(connectionKey).has(leaserId)) return true;
    }
    return false;
  }

  /**
   * F1.685 — the tools {@link hydrateDescriptorsFromStore} would not serve from a
   * cached record, per connection. {@link skippedToolsForConnection} falls back to
   * them while the connection has no live client, so `/mcp` names a skip made at
   * hydration before a live connect lands; once a client exists, its own listing
   * is the answer. Declared here, at the class end, so no line the docs cite moves.
   */
  private readonly hydrationSkippedTools = new Map<string, ReturnType<typeof partitionListedTools>['skipped']>();

  /**
   * F1.801 (SIT-r observation 2) — whether the server's own handshake already
   * answered the context-capability question with NO. `getServerCapabilities`
   * is what `registerClient` reads to maintain `resourceCapableConnections` and
   * what {@link declaresChannel} reads for the channel — this is the third
   * reader, on the same fail-closed convention: a client that cannot answer is
   * treated as DECLARED (no gate, behaviour unchanged), because a test double
   * that serves resources must keep being served.
   *
   * The boundary this draws: a tools-only server — the SIT-r fixture's
   * `capabilities: { tools: {} }` — must never be SENT a `resources/list`, and
   * must never carry a "not responding" verdict because it refused one. The
   * MCP handshake is the contract for what a server implements; asking anyway
   * converts a declaration into a failure mark on the SHARED connection.
   */
  private contextCapabilityIsUndeclared(client: PoolClient, kind: McpContextCapabilityKind): boolean {
    const declared = client.getServerCapabilities?.();
    return declared !== undefined && !declared[kind];
  }

  /**
   * F1.801 — record the capability as ABSENT, not failed: the cache reads as
   * the empty answer the spec implies, and any failure mark the kind carried is
   * cleared. Companion to {@link contextCapabilityIsUndeclared} and the -32601
   * arm of {@link refreshContextCapability}; declared at the class end so no
   * line the docs cite moves.
   */
  private admitContextCapabilityAbsent(connectionKey: string, kind: McpContextCapabilityKind): void {
    this.contextCache.set(connectionKey, { ...this.contextCache.get(connectionKey), [kind]: [] });
    this.clearCapabilityFailure(connectionKey, kind);
  }

  /**
   * F1.801 — the REFUSAL boundary. JSON-RPC `-32601 method not found` in reply
   * to a context refresh is the server DECLARING the capability absent — the
   * documented answer of a tools-only server — so it records the empty answer
   * and reports `true` (handled); every other error returns `false` and falls
   * through to the ordinary capability-failure mark, which stays load-bearing
   * for a server that DECLARED the capability and then genuinely failed to
   * serve it (P3.246's verdict is not weakened: transport failures and real
   * tools failures still move `health()`). Declared at the class end so no line
   * the docs cite moves.
   */
  private admitContextCapabilityIfRefused(connectionKey: string, kind: McpContextCapabilityKind, error: unknown): boolean {
    const code = (error as { code?: unknown } | null | undefined)?.code;
    if (code !== -32601) return false;
    this.admitContextCapabilityAbsent(connectionKey, kind);
    this.debug(`Source ${this.connectionSlugs.get(connectionKey) ?? connectionKey} refused its ${kind} list (-32601): recorded as absent, not failed.`);
    return true;
  }

  /**
   * F1.906 — connect the desired in-process API sources NOW, outside the
   * serialized reconcile, and settle them. The send path's cheap half-await:
   * `awaitConnect: false` must not wait for the MCP batch (the measured 33.7 s
   * turn-latency scaling), but it must not send a turn whose API tools are
   * missing either — the durable descriptor cache can never serve an API source
   * (its key carries a per-process instance counter, `["api", slug, n]`), so
   * until the connect lands the turn reads an empty tool surface for a source
   * that reads `connected`.
   *
   * Why this is instant and safe here rather than inside the reconcile:
   * `connectInProcess` runs no transport — an in-process client, one
   * `listTools` — so the connects settle in the time a microtask chain takes;
   * {@link connectOnce} dedupes per connection key against the reconcile's own
   * attempt (one in-flight chain, one transport), and a source the pool already
   * holds is a `clients.has` no-op in `connectInProcess` — E5a's no-reconnect
   * posture is untouched. A genuine connect failure is swallowed HERE and left
   * for the background reconcile to record (its own attempt re-runs the key and
   * marks `failedConnections`), so `health()` stays the one failure writer.
   *
   * Non-`sdk` entries and entries without an instance are skipped — they are
   * the reconcile's business, and there is nothing in-process to connect.
   * Declared at the class end so no line the docs cite moves.
   */
  async ensureApiSourcesConnected(apiServers: Record<string, ApiServerConfig>): Promise<void> {
    const connects = Object.entries(apiServers)
      .filter(([, config]) => config?.type === 'sdk' && config.instance)
      .map(([slug, config]) => this.connectOnce(
        apiConnectionKey(slug, config.instance),
        slug,
        () => this.connectInProcess(slug, config.instance),
      ));
    if (connects.length === 0) return;
    await Promise.allSettled(connects);
  }
}
import { stripControlCharacters } from '../prompts/untrusted-text.ts';

/**
 * F1.984 — hold a timer delay at the largest value `setTimeout` keeps.
 *
 * The delay is a 32-bit signed integer. Measured on Bun 1.3.14 (2026-09-26): a
 * delay past 2 147 483 647 ms prints a `TimeoutOverflowWarning` ("Timeout
 * duration was set to 1") and the timer fires after about 1 ms. Nothing above
 * the pool bounds a tool-call ceiling from above: a `.mcp.json` `timeout` only
 * has to be at least 1000 (`mcpToolTimeoutMs`), the `MCP_TOOL_TIMEOUT` lever
 * only has to be positive, and a codex `tool_timeout_sec` arrives through
 * `codexToolTimeoutMs` (which clamps too, and is covered here either way). So a
 * ceiling meant as "practically never" aborted every call at once.
 *
 * Applied to the two timers the pool derives from that ceiling: the wall clock
 * in `callTool` and the cap of `toolIdleTimeoutMs` (every idle window it returns
 * is at most its cap). The maximum is about 24.8 days, so holding a longer value
 * there changes nothing a user could wait for, and the wall-clock message names
 * the value the timer really uses. A value at or below the maximum is returned
 * unchanged.
 *
 * F1.1102: the two CONNECT timers had the same overflow and are held at
 * construction too — the per-server connect deadline (`NESSY_MCP_TIMEOUT` /
 * `MCP_TIMEOUT`) and the reconcile's batch cap (`NESSY_MCP_CONNECT_TIMEOUT_MS`,
 * `undefined` = no cap, passed through), so their debug and timeout messages
 * name the value the timer really uses.
 */
function clampToTimerMaxMs(ms: number): number;
function clampToTimerMaxMs(ms: number | undefined): number | undefined;
function clampToTimerMaxMs(ms: number | undefined): number | undefined {
  return ms === undefined ? undefined : Math.min(ms, 2_147_483_647);
}
