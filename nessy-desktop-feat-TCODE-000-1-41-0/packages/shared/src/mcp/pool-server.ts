/**
 * MCP Pool Server
 *
 * Serves McpClientPool tools over HTTP using the MCP Streamable HTTP protocol.
 * This allows external SDK subprocesses (Codex, Copilot) to access pool-managed
 * MCP source tools through a single HTTP endpoint instead of connecting to each
 * source independently.
 *
 * Uses one stateful Streamable HTTP transport per protocol session. The SDK
 * forbids reusing stateless transports across requests, while a stateful
 * session also gives list-changed notifications a live delivery channel.
 *
 * Architecture:
 *   Codex/Copilot SDK subprocess
 *       ↓ (HTTP Streamable HTTP protocol)
 *   McpPoolServer (this, in Electron main process)
 *       ↓
 *   McpClientPool
 *       ↓ (per-source MCP connections)
 *   Linear / GitHub / Notion / etc.
 *
 * ## Inbound authorization, and the ONE check that is deliberately absent (DA2.5)
 *
 * Every request carries a per-instance 32-byte random bearer ({@link
 * McpPoolServer.bearerToken}), compared in {@link McpPoolServer.isAuthorized}
 * with a length pre-check and `timingSafeEqual`, and an unauthorized request is
 * answered 401 BEFORE any route work; the listener binds `127.0.0.1` only. That
 * has been true since `b995cc93a` (2026-07-25), and the negative tripwire landed
 * in the same commit — `__tests__/proxy-tool-names.test.ts` case "rejects missing
 * and wrong bearer credentials before MCP protocol handling" asserts 401 for an
 * absent and a wrong bearer and then asserts NO session was created, which is the
 * stronger property. Only `codex-runtime` starts one of these
 * (`agent/backend/factory.ts` symbol `BACKEND_CAPABILITIES`), and the token
 * reaches it by NAME (`bearer_token_env_var`), never by value.
 *
 * **There is NO `Origin` or `Host` check here, and that is a decision rather than
 * an oversight.** Measured 2026-09-14 over this file: `headers.origin`,
 * `headers.host`, `allowedHosts`, `allowedOrigins` and
 * `enableDnsRebindingProtection` each score 0 occurrences (positive control, the
 * loopback address, answers 4). The Streamable-HTTP guidance asks for one, so
 * the reasoning is written down instead of left to be re-derived: a browser can
 * reach a loopback port, but it cannot read a reply it is not allowed to read
 * (no CORS headers are sent) and it cannot GUESS a 32-byte bearer, so the
 * DNS-rebinding attack the check exists to stop cannot get past the 401 that
 * already runs first.
 *
 * **NATIVE-FIRST, and the reading is what makes this narrow.** The vendored SDK
 * 1.29.0 DOES ship the check — `enableDnsRebindingProtection` with `allowedHosts`
 * / `allowedOrigins` — but only on `server/sse.js`, `server/express.js` and
 * `server/webStandardStreamableHttp.js`. It is absent from
 * `server/streamableHttp.js`, which is the transport imported below:
 * `allowedHosts` scores 3 (d.ts) / 6 (js) occurrences on the web-standard
 * variant and **0 / 0** on this one. So there is no native option to ENABLE here;
 * adopting it would mean either switching this surface to the web-standard
 * transport or hand-rolling the check. Both are worth more than the residue, and
 * neither is a lane's call — if it is ever wanted, it is one `if` above
 * {@link McpPoolServer.isAuthorized} comparing `Host` against `127.0.0.1:<port>`.
 *
 * ## Two OTHER loopback listeners, which are not this one
 *
 * Named here because the row that produced this paragraph was written about a
 * symbol that does not exist in this repository — `LocalMcpHttpServer` is
 * nessy-cli's vendored desktop copy, where the gap is real (an absence probe over
 * `packages apps scripts` answers files=0; positive control, `McpPoolServer`,
 * answers 17, both re-measured 2026-09-14) — and the reader who comes looking for
 * "the loopback MCP auth gap" should find the two listeners that do exist:
 * `agent/backend/codex/session-callback-bridge.ts` authenticates by
 * session-id-in-body (403 on mismatch, checked before a port is even resolved)
 * and carries NO bearer; and `packages/codex-responses-adapter/src/server.ts` has
 * NO inbound authorization at all while holding the upstream credential (probe:
 * `headers.authorization`, `Bearer` and `isAuthorized` each 0 occurrences;
 * control, its JSON reply helper, 22). Both bind loopback only. Neither is this
 * class's to fix, and neither has a row yet.
 */

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpClientPool } from './mcp-pool.ts';
import { MCP_POOL_SERVER_STARTUP_WAIT_MS } from './server-config-values.ts';
// The one posture for MCP-authored prose across all three runtimes (P3.292,
// P3.293): capped at claude's measured spelling, never fenced. Read that
// module's docblock — including why the HOST caps this surface where codex
// itself would not — before changing either call site below.
import { capMcpText } from './third-party-text.ts';

/** One leased source's resource, as this surface republishes it. */
export interface PublishedResource {
  sourceSlug: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * P6.139 — the server key the claude-runtime resource surface is registered
 * under, so the model-visible name is one constant rather than two spellings.
 */
export const POOLED_RESOURCE_SERVER_NAME = 'nessy-sources-resources';

/**
 * Every leased source's resources, flattened — the ONE collection both resource
 * surfaces read (P3.344's HTTP handlers, P6.139's in-process instance).
 *
 * Extracted from `McpPoolServer.publishedResources` rather than copied: two
 * derivations of "which resource belongs to which source" is exactly how the
 * two surfaces would come to disagree, and the disagreement would only be
 * visible as a read landing on the wrong source.
 */
export async function collectPooledResources(
  pool: McpClientPool,
  leaserId?: string,
): Promise<PublishedResource[]> {
  const slugs = leaserId !== undefined ? new Set(pool.slugsForLeaser(leaserId)) : undefined;
  const entries = await pool.listContextResources(slugs, leaserId);
  const published: PublishedResource[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'resource') continue;
    const uri = readStringField(entry.value, 'uri');
    if (!uri) continue;
    const name = readStringField(entry.value, 'name') ?? uri;
    const description = readStringField(entry.value, 'description');
    const mimeType = readStringField(entry.value, 'mimeType');
    published.push({
      sourceSlug: entry.sourceSlug,
      uri,
      name,
      ...(description ? { description } : {}),
      ...(mimeType ? { mimeType } : {}),
    });
  }
  return published;
}

/** One leased source's resource template, as this surface republishes it (UB7.10). */
export interface PublishedResourceTemplate {
  sourceSlug: string;
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * UB7.10 — every leased source's resource TEMPLATES, flattened: the same
 * collection both template surfaces read (the HTTP handler below and P6.139's
 * in-process instance).
 *
 * Unlike {@link collectPooledResources} this walks the sources' LIVE listings —
 * the discovery catalog carries no template entries. Templates are OPTIONAL
 * within the resources capability (a server without any often answers
 * `-32601 Method not found`), so a source that refuses or fails yields none
 * instead of failing the whole collection; a source that is not connected, is
 * an API source, or never declared the resources capability does the same. The
 * residue the resources list carries is carried here too: the `uriTemplate` is
 * the source's own, unrewritten, so two sources publishing the same template
 * cannot be told apart on this list (the name carries the slug, so a model
 * reading the list can see the collision).
 */
export async function collectPooledResourceTemplates(
  pool: McpClientPool,
  leaserId?: string,
  debug?: (message: string) => void,
): Promise<PublishedResourceTemplate[]> {
  const slugs = [...(leaserId !== undefined ? pool.slugsForLeaser(leaserId) : pool.getConnectedSlugs())].sort();
  const listings = await Promise.allSettled(slugs.map(async slug => ({
    slug,
    listing: await pool.listResources(slug, leaserId),
  })));
  const published: PublishedResourceTemplate[] = [];
  for (const listing of listings) {
    if (listing.status === 'rejected') {
      debug?.(`Could not list resource templates of a leased source: ${listing.reason instanceof Error ? listing.reason.message : String(listing.reason)}`);
      continue;
    }
    const { slug, listing: { resourceTemplates } } = listing.value;
    for (const template of resourceTemplates) {
      const uriTemplate = readStringField(template, 'uriTemplate');
      if (!uriTemplate) continue;
      const name = readStringField(template, 'name') ?? uriTemplate;
      const description = readStringField(template, 'description');
      const mimeType = readStringField(template, 'mimeType');
      published.push({
        sourceSlug: slug,
        uriTemplate,
        name,
        ...(description ? { description } : {}),
        ...(mimeType ? { mimeType } : {}),
      });
    }
  }
  return published;
}

/**
 * Which leased source a `resources/read` uri belongs to, or `undefined`.
 *
 * Re-derived per read rather than cached from the last list: a source can
 * connect or drop between the two calls, and serving a read from a stale map
 * would route to a connection the pool has already released. A uri advertised by
 * more than one leased source resolves to the alphabetically-first slug and says
 * so — MCP identifies a resource by uri alone on both of these surfaces, so the
 * others' resource of the same uri is not reachable through it.
 */
export function routePooledResourceUri(
  resources: readonly PublishedResource[],
  uri: string,
  debug?: (message: string) => void,
): string | undefined {
  const matches = resources
    .filter(resource => resource.uri === uri)
    .map(resource => resource.sourceSlug)
    .sort();
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    debug?.(
      `Resource uri ${uri} is advertised by ${matches.length} leased sources (${matches.join(', ')}); `
      + `reading it from ${matches[0]}. MCP identifies a resource by uri alone on this surface, `
      + 'so the other sources\' resource of the same uri is not reachable through it.',
    );
  }
  return matches[0];
}

/** Read `field` off an unknown MCP payload when it is a non-empty string. */
function readStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Per-call session context resolved lazily at tool-call time. */
export interface McpPoolServerCallContext {
  sessionPath?: string;
  summarize?: (prompt: string) => Promise<string | null>;
}

interface McpPoolServerSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

export class McpPoolServer {
  private pool: McpClientPool;
  private httpServer: HttpServer | null = null;
  private sessions = new Map<string, McpPoolServerSession>();
  private removeToolsChangedListener: (() => void) | undefined;
  private removeVerdictListener: (() => void) | undefined;
  /**
   * The instructions composition the LIVE protocol sessions were handed at their
   * handshake, or `undefined` while none has been handed out.
   *
   * P3.248 · `instructions` travel in the `initialize` result and MCP has no
   * notification that revises them — twelve `notifications/*` methods in the
   * vendored SDK 1.29.0 and none of them is this. So a source that connects,
   * disconnects, or rewrites its prose after a subprocess handshook cannot be
   * told to it, on any protocol-legal route. What CAN be done is refuse to let
   * that be silent, which is what this field is for: the drift is named, with
   * the slugs, so an operator reading a session log can see that the model's
   * description of a server is older than the server.
   */
  private publishedInstructions: string | undefined;
  private hasPublishedInstructions = false;
  private debugFn: ((msg: string) => void) | undefined;
  private _port = 0;
  readonly bearerToken = randomBytes(32).toString('base64url');
  /**
   * Leaser identity scoping this server to ONE session's view of the shared
   * pool. When set, ListTools serves only this leaser's slugs and CallTool
   * routes with this leaser's call-authz guard. Omit for the whole union
   * (byte-identical to the pre-sharing per-session pool).
   */
  private readonly leaserId?: string;
  /** Resolves this session's per-call persistence context at call time. */
  private readonly getCallContext?: () => McpPoolServerCallContext;
  /**
   * Focused-test seam ONLY, mirroring `McpClientPool`'s own option/env split:
   * the constant is the production value and this exists so a suite can pin the
   * cap's behaviour without spending it. It is deliberately NOT an operator
   * lever — see {@link MCP_POOL_SERVER_STARTUP_WAIT_MS} for why the number is
   * fixed between two other people's timeouts.
   */
  private readonly startupWaitMs: number;

  constructor(
    pool: McpClientPool,
    options?: {
      debug?: (msg: string) => void;
      leaserId?: string;
      getCallContext?: () => McpPoolServerCallContext;
      /** See {@link startupWaitMs}. Tests only. */
      startupWaitMs?: number;
    },
  ) {
    this.pool = pool;
    this.debugFn = options?.debug;
    this.leaserId = options?.leaserId;
    this.getCallContext = options?.getCallContext;
    this.startupWaitMs = Math.max(1, options?.startupWaitMs ?? MCP_POOL_SERVER_STARTUP_WAIT_MS);
  }

  private debug(msg: string): void {
    this.debugFn?.(`[McpPoolServer] ${msg}`);
  }

  /**
   * Wait out any reconcile still in flight, and SAY SO when the wait was real.
   *
   * P3.247 stopped `SessionManager` from awaiting the connect batch before a
   * codex session's setup returned; this is where that wait is re-paid, at the
   * two moments a subprocess actually reads the answer. The attribution is not
   * decoration: a first turn that took two seconds longer than the last one has
   * to be explainable, and on the runtime this surface serves the alternative
   * recovery does not exist — `openai/codex@rust-v0.148.0` logs
   * `notifications/tools/list_changed` and acts on nothing.
   */
  private async awaitPendingReconcile(reason: string): Promise<void> {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = await Promise.race([
      this.pool.whenReconciled().then(() => false),
      new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(true), this.startupWaitMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    const elapsed = Date.now() - startedAt;
    if (capped) {
      // The cap STOPS WAITING; it never aborts, exactly as the batch cap does —
      // every connect keeps running and lands on its own. What this line has to
      // carry is the CONSEQUENCE, because on the runtime this surface serves
      // there is no second chance: codex logs `notifications/tools/list_changed`
      // and acts on nothing, so a tool missing from this answer is missing until
      // that runtime re-handshakes.
      const pending = this.pendingSlugs();
      this.debug(
        `Stopped waiting for the MCP reconcile after ${this.startupWaitMs}ms before answering ${reason}`
        + (pending.length > 0 ? ` (still connecting: ${pending.join(', ')})` : '')
        + '. They keep connecting, but a subprocess that does not re-list will not see them this session.',
      );
      return;
    }
    // Zero means the pool was already settled, which is the common case and not
    // worth a line. Anything else is latency somebody will ask about.
    if (elapsed > 0) this.debug(`Waited ${elapsed}ms for the MCP reconcile before answering ${reason}.`);
  }

  /** Leased slugs that are neither connected nor recorded as failed yet. */
  private pendingSlugs(): string[] {
    const leased = this.leaserId !== undefined
      ? [...this.pool.slugsForLeaser(this.leaserId)]
      : [...new Set(this.pool.getConnectedSlugs())];
    const health = this.pool.health(this.leaserId);
    const settled = new Set([...health.connected, ...health.failed]);
    return leased.filter(slug => !settled.has(slug)).sort();
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}/mcp`;
  }

  /**
   * Start the HTTP MCP server on a random port.
   * Returns the URL clients should connect to.
   */
  async start(): Promise<string> {
    if (this.httpServer) {
      return this.url;
    }

    this.httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1`);
      if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      if (!this.isAuthorized(req)) {
        this.sendProtocolError(res, 401, 'Unauthorized');
        return;
      }

      try {
        await this.handleRequest(req, res);
      } catch (error) {
        this.debug(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) this.sendProtocolError(res, 500, 'Internal server error');
        else if (!res.writableEnded) res.end();
      }
    });

    const httpServer = this.httpServer;
    await new Promise<void>((resolve, reject) => {
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address();
        this._port = typeof addr === 'object' && addr ? addr.port : 0;
        this.debug(`Listening on 127.0.0.1:${this._port}`);
        resolve();
      });
      httpServer.on('error', reject);
    });

    this.removeToolsChangedListener = this.pool.subscribeToolsChanged(() => this.notifyToolsChanged());
    // The verdict change is the precise hook, not `toolsChanged`: this surface's
    // instructions are `getInstructions`, which answers only for a LIVE
    // connection, so its answer moves exactly when a client is registered or
    // dropped — which is what the connection-verdict signature is taken over
    // (P3.246). A server that answers 401 contributes no tools at all, so the
    // catalog hash would not move and `toolsChanged` would stay silent.
    this.removeVerdictListener = this.pool.subscribeConnectionVerdictChanged(() => this.reportInstructionsDrift());

    return this.url;
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const actual = req.headers.authorization;
    const expected = `Bearer ${this.bearerToken}`;
    if (!actual || Buffer.byteLength(actual) !== Buffer.byteLength(expected)) return false;
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawSessionId = req.headers['mcp-session-id'];
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined;
    if (rawSessionId !== undefined && !sessionId) {
      this.sendProtocolError(res, 400, 'Bad Request: Invalid session ID');
      return;
    }

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.sendProtocolError(res, 404, 'Session not found');
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== 'POST') {
      this.sendProtocolError(res, 400, 'Bad Request: No valid session ID provided');
      return;
    }

    // P3.247/P3.248 · the handshake is a POINT OF NEED, so it re-pays the wait
    // session setup stopped paying. `instructions` travel in the `initialize`
    // result and the MCP protocol has no list-changed equivalent for them (the
    // vendored SDK 1.29.0 declares twelve `notifications/*` methods and none of
    // them is about instructions), so whatever this composition is missing right
    // now, the subprocess holding this session is missing for its lifetime.
    // Waiting here costs nothing when the pool is already settled and buys the
    // whole difference when it is not.
    await this.awaitPendingReconcile('handshake');
    let transport!: StreamableHTTPServerTransport;
    const server = this.createMcpServer();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: id => {
        this.sessions.set(id, { server, transport });
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && this.sessions.get(id)?.transport === transport) this.sessions.delete(id);
    };
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res);
    } finally {
      if (!transport.sessionId) {
        await transport.close().catch(() => {});
        await server.close().catch(() => {});
      }
    }
  }

  private sendProtocolError(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message },
      id: null,
    }));
  }

  /**
   * Every leased source's own `instructions`, labelled by slug.
   *
   * This surface FLATTENS N sources into ONE MCP server — the same reason tool
   * names carry their source in `<slug>__<tool>` — and MCP gives a server a
   * single `instructions` string. So the slug heading is not decoration: it is
   * the only thing that tells the model which server a paragraph is about.
   *
   * Snapshot semantics, stated because they differ from tools: `instructions`
   * travels in the `initialize` result and the protocol has no list-changed
   * equivalent for it, so a source that connects after this subprocess
   * handshook contributes nothing until the next handshake. Tools do not have
   * that limitation (`notifications/tools/list_changed` is wired above), which
   * is exactly why this is composed here rather than pushed later.
   *
   * P3.292 — capped PER SOURCE, before the join, which is the only placement
   * that means anything here: this surface flattens N sources into one server
   * with one `instructions` slot, so a cap on the composed string would let a
   * first verbose source consume the budget of every source after it. Per
   * source is also what the other two runtimes do, so one source's prose is the
   * same bytes on all three.
   *
   * Codex applies no cap of its own on this path — `parse_mcp_tool` at
   * `rust-v0.148.0` passes `description_limit: None`, and a server's
   * `instructions` become `namespace_description` verbatim — so this is the
   * HOST supplying uniformly what one runtime lacks, not a mirror of codex.
   * `third-party-text.ts` carries the reasoning and the measurement.
   */
  private aggregateSourceInstructions(): string | undefined {
    const slugs = this.leaserId !== undefined
      ? [...this.pool.slugsForLeaser(this.leaserId)]
      : this.pool.getConnectedSlugs();
    const blocks: string[] = [];
    for (const slug of slugs) {
      const instructions = this.pool.getInstructions(slug, this.leaserId);
      if (instructions) blocks.push(`## ${slug}\n\n${capMcpText(instructions)}`);
    }
    if (blocks.length === 0) return undefined;
    return blocks.join('\n\n');
  }

  /**
   * Create an MCP Server instance wired to the pool.
   * Tools from pool use `mcp__nessy__search_spaces` naming internally. We strip
   * the `mcp__` prefix, because the runtime reaching this bridge files every
   * tool under the server it came from (`[mcp_servers.sources]`) by itself:
   *   pool internal:     mcp__nessy__search_spaces
   *   exposed here:      nessy__search_spaces
   *   codex namespace:   mcp__sources — BESIDE the name, never joined into it
   *   codex MODEL name:  nessy__search_spaces, every character outside
   *                      [A-Za-z0-9_] made `_` (a hyphen too) — computed by
   *                      `codexModelToolName` (`capabilities/mcp-wire-name.ts`)
   *   host row name:     mcp__sources__nessy__search_spaces (codex's raw pair)
   * F1.155 — this block said "Codex sees: mcp__sources__nessy__search_spaces",
   * and a cdp case asked a codex model for that name: the model has no such
   * tool. The gateway leg hands it the MODEL name alone (the adapter flattens
   * the namespace, `toChatRequest`); measured on the shipped binary, call
   * included, by `__tests__/codex-model-tool-name-live.test.ts`.
   */
  private createMcpServer(): Server {
    const instructions = this.aggregateSourceInstructions();
    // What this protocol session is being handed, so a later change can be
    // recognised as a change rather than looking like the current truth.
    this.publishedInstructions = instructions;
    this.hasPublishedInstructions = true;
    // P6.553 — KEPT on the `@deprecated` low-level `Server`, deliberately: this is a
    // PROXY, the "advanced use case" the SDK's note carves out. Names, schemas and
    // results are another server's and are only known per call, so there is nothing to
    // `registerTool`; and the capability block below declares `resources` while
    // WITHHOLDING `listChanged`, a distinction `McpServer.registerResource` cannot
    // express because it owns the notification. `createPooledResourceSdkServer` at the
    // foot of this file is the same measurement from the other side: it takes an
    // `McpServer` because its caller's shape demands one, then reaches through
    // `.server.setRequestHandler` for exactly these two proxied handlers.
    const server = new Server(
      { name: 'nessy-pool-proxy', version: '1.0.0' },
      {
        capabilities: {
          tools: { listChanged: true },
          // P3.344 · declared UNCONDITIONALLY, and that is the load-bearing
          // half. Capabilities travel in the `initialize` result and MCP has no
          // notification that revises them (same protocol fact as
          // `instructions`, {@link reportInstructionsDrift}), so a capability
          // computed from "does a leased source advertise resources RIGHT NOW"
          // would be pinned at the handshake — and a source that connects
          // afterwards could never be listed for the life of the subprocess.
          // The cost of declaring it always is an empty `resources/list` when
          // no source has any, which is TRUE-empty; the cost of declaring it
          // conditionally is a resource that exists and is unreachable.
          //
          // `listChanged` is deliberately NOT claimed: we send no
          // `notifications/resources/list_changed`, and declaring a
          // notification we never emit is the kind of quiet lie this file
          // already refuses for instructions.
          resources: {},
        },
        // Without this, a source's own `instructions` reached the model on
        // claude-runtime (through the per-source SDK proxy) and nowhere else,
        // which is a switch-visible difference in what the model is TOLD about
        // the same server. See {@link aggregateSourceInstructions}.
        ...(instructions ? { instructions } : {}),
      },
    );

    // List tools — proxy from pool, strip `mcp__` prefix. Scoped to this
    // session's leased slugs when a leaserId is configured (shared pool).
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      // The second point of need, and the one that decides what the model may
      // call on its first turn. `agent-sdk/mcp.md#connection-timing` says a
      // server without a cached tool list delays the first turn "until it
      // connects" — this is where that sentence is true for a subprocess
      // runtime, now that the setup path no longer makes it true earlier.
      // Whether an individual connect is still awaited inside the reconcile is
      // the pool's documented per-server table, not this line's business.
      await this.awaitPendingReconcile('tools/list');
      const proxyDefs = this.leaserId !== undefined
        ? this.pool.getProxyToolDefs([...this.pool.slugsForLeaser(this.leaserId)], this.leaserId)
        : this.pool.getProxyToolDefs();
      return {
        tools: proxyDefs.map(def => ({
          name: def.name.replace(/^mcp__/, ''),
          // P3.292 — the tool-DESCRIPTION half of the same cap. Codex's own
          // `parse_mcp_tool` does not cap an ordinary server's description (its
          // 1000-BYTE, marker-less cap is reached only through
          // `parse_agent_plugin_mcp_tool`, which our `[mcp_servers.*]` entry is
          // not), so without this line the same MCP server's tool descriptions
          // reach the model whole on codex and cut at 2048 on claude and Pi.
          description: capMcpText(def.description),
          inputSchema: def.inputSchema as {
            type: 'object';
            properties?: Record<string, unknown>;
          },
          // Re-emitting a def without its metadata would leave this surface's
          // consumer (Codex) blind to the same hints the pool now carries.
          ...(def.annotations ? { annotations: def.annotations } : {}),
          ...(def._meta ? { _meta: def._meta } : {}),
        })),
      };
    });

    // Call tool — add `mcp__` prefix back before routing through pool
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const internalName = `mcp__${name}`;
      this.debug(`Tool call: ${name} → ${internalName}`);

      // Thread this session's per-call persistence context + leaser identity so
      // responses save into THIS session's dir and the call-authz guard scopes
      // to its leased slugs. Absent both, this is byte-identical to no context.
      const result = await this.pool.callTool(internalName, args || {}, undefined, {
        ...this.getCallContext?.(),
        ...(this.leaserId !== undefined ? { leaserId: this.leaserId } : {}),
      });

      return {
        content: [{ type: 'text' as const, text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    });

    // P3.344 · resources. See {@link publishedResources} for what this closes
    // and what it deliberately leaves open.
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      await this.awaitPendingReconcile('resources/list');
      const published = await this.publishedResources();
      return {
        resources: published.map(resource => ({
          uri: resource.uri,
          // The same flattening convention the tool list uses two handlers up
          // (`<slug>__<tool>`): N sources become ONE server here, so without the
          // slug the model cannot tell two sources' resources apart, and codex's
          // own `read_mcp_resource` gives it only (server, uri) to ask with.
          name: `${resource.sourceSlug}__${resource.name}`,
          ...(resource.description ? { description: capMcpText(resource.description) } : {}),
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        })),
      };
    });

    // UB7.10 · resource templates. This closes P3.344's stated residue (the
    // `-32601` a template ask used to get): the pool grew the template channel,
    // and an EMPTY answer here is TRUE-empty (a connected source published no
    // templates), not the manufactured kind the old note warned about — a
    // source that refuses templates never reaches this list at all. The uri
    // stays the source's own; a template-filled `resources/read` still routes
    // through {@link routeResourceUri}, so a filled uri must ALSO be a listed
    // resource to read.
    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      await this.awaitPendingReconcile('resources/list');
      const published = await collectPooledResourceTemplates(this.pool, this.leaserId, message => this.debug(message));
      return {
        resourceTemplates: published.map(template => ({
          uriTemplate: template.uriTemplate,
          name: `${template.sourceSlug}__${template.name}`,
          ...(template.description ? { description: capMcpText(template.description) } : {}),
          ...(template.mimeType ? { mimeType: template.mimeType } : {}),
        })),
      };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const slug = await this.routeResourceUri(uri);
      if (!slug) throw new Error(`mcp-resource-not-listed:${uri}`);
      const result = await this.pool.readResource(slug, uri, this.leaserId);
      return { contents: result.contents };
    });

    return server;
  }

  /**
   * Every leased source's resources, flattened, for `resources/list`.
   *
   * ## Why this exists (P3.344)
   *
   * Codex registers three model-facing resource tools — `list_mcp_resources`,
   * `list_mcp_resource_templates`, `read_mcp_resource` — whenever ANY MCP server
   * is configured (`openai/codex@rust-v0.148.0`,
   * `core/src/tools/spec_plan.rs::add_mcp_resource_tools`, gated only on
   * `context.mcp.has_servers()`), and we always configure one: this server, as
   * `[mcp_servers.sources]`. Its no-`server`-argument path is
   * `McpConnectionSet::list_all_resources`, which logs a per-server failure and
   * drops it (`warn!("Failed to list resources for MCP server …")`). So before
   * this handler existed the model on codex was offered a resource tool that
   * answered EMPTY for every source the user had connected — not an absence it
   * could see, a false negative it could not.
   *
   * Native-first, in order: (1) codex's own mechanism is exactly these three
   * tools and they are already on; what was missing is the SERVER half, which is
   * this file. (2) The host cannot supply it uniformly — Pi reaches resources
   * through its own session tools and claude-runtime through per-source SDK
   * proxies, two different seams. So this is step 1, configured rather than
   * built: we make codex's own tools answer.
   *
 * ## What this deliberately does NOT do, stated rather than left silent
 *
 * - **Resource templates.** CLOSED by UB7.10 (2026-10-15). This note's
 *   original text — the pool carries no `resources/templates/list`, a client
 *   that asks gets `-32601 Method not found`, the honest shape until the pool
 *   grows the channel — described the state UB7.10 existed to close. The pool
 *   grew the channel (`PoolClient.listResourceTemplates`, the paginated
 *   `McpClientPool.listResources`), and the handler above serves it from
 *   {@link collectPooledResourceTemplates} — where a source that refuses
 *   templates (the `-32601` servers without any usually answer) yields NONE
 *   instead of failing the collection, so the empty answer is TRUE-empty. The
 *   filled-uri read still routes through {@link routeResourceUri}, so a
 *   template-filled uri must also be a listed resource to read.
 * - **URI collisions across sources.** The advertised `uri` is the source's
   *   OWN uri, unrewritten: a URI is the resource's identity and its scheme is
   *   already a namespace, unlike a tool name, which MCP namespaces per server
   *   and which this surface therefore has to re-namespace by hand. The cost is
   *   that two leased sources publishing the SAME uri cannot be told apart on
   *   the read, since codex hands us only (server, uri). {@link routeResourceUri}
   *   resolves such a read to the alphabetically-first slug and says so on
   *   `debug`; the residue is that one read of a colliding uri can reach the
   *   other source's resource. Measured as rare rather than assumed impossible:
   *   the slug is in every advertised `name`, so a model reading the list can
   *   see the collision even though it cannot address it.
   */
  private async publishedResources(): Promise<PublishedResource[]> {
    return await collectPooledResources(this.pool, this.leaserId);
  }

  /**
   * Which leased source a `resources/read` uri belongs to, or `undefined` when
   * no leased source advertises it.
   *
   * Re-derived per read rather than cached from the last list: a source can
   * connect or drop between the two calls, and serving a read from a stale map
   * would route to a connection the pool has already released. See
   * {@link publishedResources} for the collision rule this implements.
   */
  private async routeResourceUri(uri: string): Promise<string | undefined> {
    return routePooledResourceUri(await this.publishedResources(), uri, message => this.debug(message));
  }

  /**
   * P3.248 · say when the model's description of these servers has gone stale.
   *
   * Native-first was asked and the answer is a clean NO on both halves. The MCP
   * protocol carries `instructions` only in the `initialize` result and defines
   * no notification that revises them, and the vendored SDK's own type list is
   * the denominator: twelve `notifications/*` methods, none of them about
   * instructions. Nor can the server force a re-handshake — the SDK's
   * `StreamableHTTPClientTransport` (1.29.0) does not re-initialize on a 404, so
   * terminating the session would break the subprocess rather than refresh it.
   *
   * So the residue cannot be closed and is made HONEST instead, which is the
   * host's job under the native-first rule's second half. The comparison is
   * cheap and the line names the slugs, so an operator reading a session log can
   * see exactly which server the model is being told about out of date. Codex
   * DOES re-handshake on several of its own triggers (`Op::RefreshMcpServers`,
   * an auth change, a settings change — `openai/codex@rust-v0.148.0`,
   * `McpRuntime::replace`), and each of those picks the new composition up; this
   * line is what makes the interval until one of them fires legible.
   */
  private reportInstructionsDrift(): void {
    if (!this.hasPublishedInstructions || this.sessions.size === 0) return;
    const current = this.aggregateSourceInstructions();
    if (current === this.publishedInstructions) return;
    const slugsOf = (blocks: string | undefined) => new Set(
      [...(blocks ?? '').matchAll(/^## (.+)$/gm)].map(match => match[1] as string),
    );
    const before = slugsOf(this.publishedInstructions);
    const after = slugsOf(current);
    const gained = [...after].filter(slug => !before.has(slug)).sort();
    const lost = [...before].filter(slug => !after.has(slug)).sort();
    const changed = [...after].filter(slug => before.has(slug)).sort();
    const parts = [
      gained.length > 0 ? `now available: ${gained.join(', ')}` : '',
      lost.length > 0 ? `no longer connected: ${lost.join(', ')}` : '',
      gained.length === 0 && lost.length === 0 && changed.length > 0 ? `rewritten: ${changed.join(', ')}` : '',
    ].filter(part => part !== '');
    this.debug(
      'Source instructions changed after the subprocess handshake '
      + `(${parts.join('; ') || 'composition changed'}). MCP carries instructions only in the `
      + 'initialize result, so the model keeps the older description until this runtime re-handshakes.',
    );
  }

  /**
   * Notify MCP clients with the standard payload-free list-change notification.
   */
  notifyToolsChanged(): void {
    for (const { server } of this.sessions.values()) {
      void server.sendToolListChanged().catch(error => {
        this.debug(`Tools changed notification failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  /**
   * Stop the HTTP server and close the transport.
   */
  async stop(): Promise<void> {
    this.removeToolsChangedListener?.();
    this.removeToolsChangedListener = undefined;
    this.removeVerdictListener?.();
    this.removeVerdictListener = undefined;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async ({ server, transport }) => {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }));

    if (this.httpServer) {
      const httpServer = this.httpServer;
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      this.httpServer = null;
      this._port = 0;
      this.debug('Stopped');
    }
  }
}

/**
 * P6.139 — the SAME resource surface, for the runtime that reaches it through
 * an in-process instance instead of HTTP.
 *
 * ## What was absent, and it was absent at ONE field
 *
 * Claude's own `ListMcpResources` / `ReadMcpResource` are in the `claude_code`
 * preset and were always callable; they answered EMPTY because no server we
 * registered declared any resources. We build every source proxy through
 * `createSdkMcpServer({ … tools })` — tools only, and P6.25 recorded that as
 * `cannot-at-this-seam` from the FACTORY's option type. That verdict is refuted
 * by the SDK's own config union: `McpSdkServerConfigWithInstance` is
 * `McpSdkServerConfig & { instance: McpServer }` (`sdk.d.ts:1063`), reachable
 * through `McpServerConfig` (`:1070`). The factory cannot express resources; the
 * OPTION can, because it accepts a whole `McpServer`.
 *
 * ## Native-first, in order
 *
 * (1) The runtime already has the mechanism — two preset tools, already on. What
 * was missing is the SERVER half. (2) The host cannot supply it uniformly: Pi
 * reaches resources through its own session tools and codex through the HTTP
 * surface above, which are two different seams. So this is step 1 for the third
 * runtime, configured rather than built — and it is deliberately the same
 * COLLECTION and the same ROUTING the HTTP handlers use, extracted rather than
 * re-derived, so the two surfaces cannot come to disagree about which resource
 * belongs to which source.
 *
 * ## Why a whole `McpServer` and not four `registerResource` calls
 *
 * `registerResource` needs the resource list at construction, and this list is
 * live: a source can connect or drop between two turns. Handlers on the
 * underlying `.server` are re-evaluated per request, which is the same property
 * the HTTP surface relies on. The capability is declared UNCONDITIONALLY for the
 * reason `createMcpServer` states at length — capabilities travel in the
 * `initialize` result and MCP has no notification that revises them, so a
 * capability computed from "does a leased source advertise resources right now"
 * would be pinned at the handshake, and a source connecting afterwards could
 * never be listed. `listChanged` is NOT claimed, because we emit no such
 * notification.
 *
 * ## Residue, stated because the SDK's types hide it
 *
 * A SUBAGENT cannot be given this server: `AgentMcpServerSpec` (`sdk.d.ts:120`)
 * is typed over `McpServerConfigForProcessTransport` (`:1077`), which is exactly
 * the union MINUS the instance variant. So a subagent on claude-runtime still
 * sees no resources, and that is a property of the SDK's transport model rather
 * than of this file.
 */
export function createPooledResourceSdkServer(
  pool: McpClientPool,
  options: { leaserId?: string; debug?: (message: string) => void } = {},
): { type: 'sdk'; name: string; instance: McpServer } {
  const name = POOLED_RESOURCE_SERVER_NAME;
  const server = new McpServer(
    { name, version: '1.0.0' },
    { capabilities: { resources: {} } },
  );
  server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const published = await collectPooledResources(pool, options.leaserId);
    return {
      resources: published.map(resource => ({
        uri: resource.uri,
        // The SAME flattening the HTTP surface uses (`<slug>__<name>`): N
        // sources become ONE server here too, so without the slug the model
        // cannot tell two sources' resources apart.
        name: `${resource.sourceSlug}__${resource.name}`,
        ...(resource.description ? { description: capMcpText(resource.description) } : {}),
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      })),
    };
  });
  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const published = await collectPooledResources(pool, options.leaserId);
    const slug = routePooledResourceUri(published, uri, options.debug);
    if (!slug) throw new Error(`mcp-resource-not-listed:${uri}`);
    const result = await pool.readResource(slug, uri, options.leaserId);
    return { contents: result.contents };
  });
  // UB7.10 — the SAME template channel the HTTP surface gained, on the same
  // collection, so the two surfaces cannot disagree about which template
  // belongs to which source.
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const published = await collectPooledResourceTemplates(pool, options.leaserId, options.debug);
    return {
      resourceTemplates: published.map(template => ({
        uriTemplate: template.uriTemplate,
        name: `${template.sourceSlug}__${template.name}`,
        ...(template.description ? { description: capMcpText(template.description) } : {}),
        ...(template.mimeType ? { mimeType: template.mimeType } : {}),
      })),
    };
  });
  return { type: 'sdk', name, instance: server };
}
