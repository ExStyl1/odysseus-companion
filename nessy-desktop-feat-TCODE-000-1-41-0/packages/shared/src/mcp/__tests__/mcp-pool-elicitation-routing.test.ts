/**
 * An MCP server must be able to ASK the user something on every runtime, not
 * only on Pi.
 *
 * Measured live on the packaged 1.25.1 build (`.superpowers/sdd/q13-codex-0147-report.md`,
 * Q13-D1): a probe server's `elicitation/create` was answered
 * `-32601 Method not found` in the same millisecond on the Codex runtime, while
 * the identical server on Pi received `elicitation: {form, url}` in the client's
 * capabilities and was held open awaiting the user. The cause is one line —
 * `client.ts` advertises the capability only when an `elicitationHandler` was
 * supplied at CONSTRUCTION, and the pool used to supply one only if a session
 * had already called `setElicitationHandler`. On the shared workspace pool the
 * connections are made during session setup, BEFORE the agent that would
 * register a handler exists, so the capability was fixed as absent at the
 * handshake and no later wiring could reach it.
 *
 * MCP client capabilities are declared once, at `initialize`
 * (`modelcontextprotocol.io/specification/…/client/elicitation`: "Clients that
 * support elicitation MUST declare the `elicitation` capability during
 * initialization"), which is why the fix lives at the pool's client factory and
 * not in a session's start-up order.
 *
 * Driven against a REAL MCP server, spoken over a REAL Streamable HTTP
 * transport, because the assertion is about what the SERVER sees on the wire —
 * the capabilities in our `initialize`, and whether its `elicitation/create`
 * comes back with an action or with `-32601`. A fake client cannot prove
 * either. The server half is the vendored SDK's own `Server`, so
 * `getClientCapabilities()` is the SDK's reading of the handshake rather than
 * this test's.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ClientCapabilities,
  type ElicitRequest,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { McpClientPool } from '../mcp-pool.ts';

interface ElicitingServer {
  http: HttpServer;
  port: number;
  /** Client capabilities the SDK read from `initialize`, newest connect last. */
  readonly handshakes: ClientCapabilities[];
}

/**
 * A server that elicits from inside its own `tools/call` — the shape a sign-in
 * flow takes, where the call is held open while the user answers.
 *
 * The tool reports what came back, so an assertion on the tool RESULT is an
 * assertion on what the server experienced: `accept`/`decline`, or the JSON-RPC
 * error code when the client refuses the method outright.
 *
 * It elicits from `resources/read` and `prompts/get` the same way, because those
 * are the OTHER two call kinds a server may hold open on a question and the pool
 * used to make them invisible to its own attribution ledger.
 */
function startElicitingServer(): ElicitingServer {
  const handshakes: ClientCapabilities[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const buildServer = (): Server => {
    // P6.553 — KEPT on the low-level `Server`: this fixture reads the handshake
    // (`oninitialized` + `getClientCapabilities`) and calls `elicitInput` with an
    // explicit `relatedRequestId` taken from each handler's `extra.requestId`, on all
    // three call kinds. Those are protocol-level surfaces; `McpServer` reaches them
    // only by unwrapping to this same class through `.server`.
    const server = new Server(
      { name: 'eliciting-fixture', version: '1.0.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
    server.oninitialized = () => {
      handshakes.push(server.getClientCapabilities() ?? {});
    };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{
        name: 'signin',
        description: 'Needs the user to finish a browser sign-in.',
        inputSchema: { type: 'object' as const, properties: {} },
      }],
    }));
    const elicit = async (requestId: string | number): Promise<string> => {
      try {
        const answer = await server.elicitInput({
          mode: 'url',
          elicitationId: 'elicit-signin-1',
          url: 'https://mcp.example.test/authorize',
          message: 'Sign in to continue.',
        }, { relatedRequestId: requestId });
        return answer.action;
      } catch (error) {
        // Two shapes of the same refusal: the SDK short-circuits with a plain
        // Error when the client declared no `elicitation` capability, and a
        // server that sends anyway is answered `-32601 Method not found` — the
        // code Q13 measured on the Codex runtime.
        const code = (error as { code?: number }).code;
        return `refused:${code ?? (error as Error).message}`;
      }
    };

    server.setRequestHandler(CallToolRequestSchema, async (_request, extra) => ({
      content: [{ type: 'text' as const, text: await elicit(extra.requestId) }],
    }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: SIGNIN_RESOURCE, name: 'profile' }],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => ({
      contents: [{
        uri: request.params.uri,
        mimeType: 'text/plain',
        text: await elicit(extra.requestId),
      }],
    }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [{ name: SIGNIN_PROMPT, description: 'Needs a browser sign-in first.' }],
    }));
    server.setRequestHandler(GetPromptRequestSchema, async (_request, extra) => ({
      messages: [{
        role: 'user' as const,
        content: { type: 'text' as const, text: await elicit(extra.requestId) },
      }],
    }));
    return server;
  };

  const http = createServer(async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const existing = transports.get(sessionId);
      if (!existing) {
        res.writeHead(404).end();
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: id => { transports.set(id, transport); },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) transports.delete(id);
    };
    await buildServer().connect(transport);
    await transport.handleRequest(req, res);
  });
  http.listen(0, '127.0.0.1');
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return { http, port, handshakes };
}

const fixture = startElicitingServer();
afterAll(() => { fixture.http.close(); });

const serverConfig = () => ({
  type: 'http' as const,
  url: `http://127.0.0.1:${fixture.port}/mcp`,
});

function newPool(): McpClientPool {
  return new McpClientPool({});
}

/**
 * Lease the server under each named session, the way a real session does. The
 * per-leaser call-authz guard refuses a proxy tool a leaser never asked for, so
 * a routing test has to lease before it calls.
 */
async function lease(pool: McpClientPool, ...leaserIds: string[]): Promise<void> {
  for (const leaserId of leaserIds) {
    await pool.sync({ 'signin-server': serverConfig() }, {}, { leaserId });
  }
}

const SIGNIN_TOOL = 'mcp__signin-server__signin';
const SIGNIN_RESOURCE = 'signin://profile';
const SIGNIN_PROMPT = 'signin-brief';

/** An accepting handler that records what it was asked. */
function recordingHandler(seen: ElicitRequest[]) {
  return async (request: ElicitRequest): Promise<ElicitResult> => {
    seen.push(request);
    return { action: 'accept' };
  };
}

describe('every pool client advertises the elicitation capability', () => {
  /**
   * THE regression. Q13-D1 measured `-32601` on Codex because the capability
   * was keyed on a handler that did not exist yet. It is keyed on the pool now,
   * so a connection made before any session attaches still advertises it.
   */
  it('declares elicitation {form, url} even when no handler has been registered yet', async () => {
    const pool = newPool();
    const before = fixture.handshakes.length;

    await pool.connect('signin-server', serverConfig());

    expect(fixture.handshakes.length).toBe(before + 1);
    expect(fixture.handshakes[before]!.elicitation).toEqual({ form: {}, url: {} });

    await pool.disconnectAll();
  });

  it('answers a server that elicits instead of refusing the method', async () => {
    const pool = newPool();
    const seen: ElicitRequest[] = [];
    pool.registerElicitationHandler('session-a', recordingHandler(seen));

    await lease(pool, 'session-a');
    const result = await pool.callTool(SIGNIN_TOOL, {}, undefined, { leaserId: 'session-a' });

    expect(result.isError).toBe(false);
    // The server's own view: an action, never `refused:-32601`.
    expect(result.content).toBe('accept');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.params.message).toBe('Sign in to continue.');
    expect(seen[0]!.params.mode).toBe('url');

    await pool.disconnectAll();
  });
});

describe('an elicitation reaches the leaser whose call is in flight', () => {
  it('asks the calling session, not the other one sharing the pool', async () => {
    const pool = newPool();
    const askedA: ElicitRequest[] = [];
    const askedB: ElicitRequest[] = [];
    pool.registerElicitationHandler('session-a', recordingHandler(askedA));
    pool.registerElicitationHandler('session-b', recordingHandler(askedB));

    await lease(pool, 'session-a', 'session-b');
    await pool.callTool(SIGNIN_TOOL, {}, undefined, { leaserId: 'session-b' });

    expect(askedA).toHaveLength(0);
    expect(askedB).toHaveLength(1);

    await pool.disconnectAll();
  });

  /**
   * Fail closed, visibly. A call from a leaser with no handler has no user to
   * ask, and asking SOMEBODY ELSE'S user would be worse than not asking — so it
   * is declined, with the reason named in the pool's log rather than dropped.
   */
  it('declines, and says why, when the calling leaser has no handler', async () => {
    const messages: string[] = [];
    const pool = new McpClientPool({ debug: message => messages.push(message) });
    const askedA: ElicitRequest[] = [];
    pool.registerElicitationHandler('session-a', recordingHandler(askedA));

    await lease(pool, 'session-a', 'session-c');
    const result = await pool.callTool(SIGNIN_TOOL, {}, undefined, { leaserId: 'session-c' });

    expect(result.content).toBe('decline');
    expect(askedA).toHaveLength(0);
    expect(messages.join('\n')).toContain('elicitation');
    expect(messages.join('\n')).toContain('session-c');

    await pool.disconnectAll();
  });

  /**
   * The single-owner pool (a headless agent, or a workspace with one session)
   * keeps working with no leaser threading at all: one handler is unambiguous.
   */
  it('uses the only handler there is when the call carries no leaser', async () => {
    const pool = newPool();
    const seen: ElicitRequest[] = [];
    pool.setElicitationHandler(recordingHandler(seen));

    await pool.connect('signin-server', serverConfig());
    const result = await pool.callTool(SIGNIN_TOOL, {});

    expect(result.content).toBe('accept');
    expect(seen).toHaveLength(1);

    await pool.disconnectAll();
  });

  /**
   * Two candidate users and nothing naming one of them: decline, never guess.
   *
   * `shared` is NAMED rather than inherited from the pool default, and it is the
   * ONE case in this file that needs to be — for the reason DA3.2 names the
   * posture on four cases of the isolation suite. The case requires two sessions
   * on ONE transport, which is what the shared posture means; under
   * `NESSY_MCP_CONNECTION_ISOLATION=per-leaser` each session has a connection of
   * its own and an unscoped call is refused EARLIER, by
   * `preferredConnectionKey` declining to guess between them — so the elicitation
   * this case is about never happens. Inheriting the default would make the case
   * measure whatever the lever is set to rather than the rule it was written for.
   * DA3.8's sweep of both spellings is what surfaced it; every other case in this
   * file passes under all three.
   */
  it('declines an unattributable elicitation rather than picking a session', async () => {
    const pool = new McpClientPool({ connectionIsolation: 'shared' });
    const askedA: ElicitRequest[] = [];
    const askedB: ElicitRequest[] = [];
    pool.registerElicitationHandler('session-a', recordingHandler(askedA));
    pool.registerElicitationHandler('session-b', recordingHandler(askedB));

    await lease(pool, 'session-a', 'session-b');
    // No `leaserId`: the pool cannot tell which of the two users is waiting.
    const result = await pool.callTool(SIGNIN_TOOL, {});

    expect(result.content).toBe('decline');
    expect(askedA).toHaveLength(0);
    expect(askedB).toHaveLength(0);

    await pool.disconnectAll();
  });

  it('stops routing to a session once its registration is released', async () => {
    const pool = newPool();
    const seen: ElicitRequest[] = [];
    const release = pool.registerElicitationHandler('session-a', recordingHandler(seen));

    await lease(pool, 'session-a');
    release();
    const result = await pool.callTool(SIGNIN_TOOL, {}, undefined, { leaserId: 'session-a' });

    expect(result.content).toBe('decline');
    expect(seen).toHaveLength(0);

    await pool.disconnectAll();
  });
});

/**
 * `dropLeaser` is the pool's own release primitive and the ONLY thing the lease
 * release calls, so anything it forgets is retained for the pool's lifetime —
 * and the workspace pool outlives every session in it, staying warm for browse.
 */
describe('a released leaser stops being a candidate for anybody else\'s elicitation', () => {
  /**
   * The damage is not the leak, it is what the leak does to the SURVIVOR. Rule 2
   * — "unattributable, but the pool has exactly one bridge" — is how an
   * out-of-band ask reaches the only user there is. A registration left behind by
   * a closed session makes `candidates.length` 2 forever, so the one live session
   * is declined instead, in a workspace where it is the only session.
   */
  it('leaves the one live session reachable by an out-of-band ask', async () => {
    const pool = newPool();
    const askedClosed: ElicitRequest[] = [];
    const askedLive: ElicitRequest[] = [];
    pool.registerElicitationHandler('session-closed', recordingHandler(askedClosed));
    pool.registerElicitationHandler('session-live', recordingHandler(askedLive));

    await lease(pool, 'session-closed', 'session-live');
    await pool.dropLeaser('session-closed');

    // No leaser on the call: the out-of-band shape, which is what rule 2 exists
    // for. One registration is left, so there is exactly one user it can be.
    const result = await pool.callTool(SIGNIN_TOOL, {});

    expect(result.content).toBe('accept');
    expect(askedLive).toHaveLength(1);
    expect(askedClosed).toHaveLength(0);

    await pool.disconnectAll();
  });
});

/**
 * A tool call is not the only thing a server can hold open on a question. Both
 * of these took a `leaserId` and dropped it, so their own elicitation was
 * unattributable — declined at best, and at worst routed to whichever OTHER
 * session happened to have a tool call open on the same shared connection.
 */
describe('a resource read and a prompt render are attributable to the session that made them', () => {
  it('asks the reading session, not the other one sharing the pool', async () => {
    const pool = newPool();
    const askedA: ElicitRequest[] = [];
    const askedB: ElicitRequest[] = [];
    pool.registerElicitationHandler('session-a', recordingHandler(askedA));
    pool.registerElicitationHandler('session-b', recordingHandler(askedB));

    await lease(pool, 'session-a', 'session-b');
    const result = await pool.readResource('signin-server', SIGNIN_RESOURCE, 'session-b');

    // The server's own view of the answer, carried back in the contents.
    expect(result.contents[0]!.text).toBe('accept');
    expect(askedB).toHaveLength(1);
    expect(askedA).toHaveLength(0);

    await pool.disconnectAll();
  });

  it('asks the rendering session, not the other one sharing the pool', async () => {
    const pool = newPool();
    const askedA: ElicitRequest[] = [];
    const askedB: ElicitRequest[] = [];
    pool.registerElicitationHandler('session-a', recordingHandler(askedA));
    pool.registerElicitationHandler('session-b', recordingHandler(askedB));

    await lease(pool, 'session-a', 'session-b');
    const result = await pool.getPrompt('signin-server', SIGNIN_PROMPT, undefined, 'session-b');

    expect((result.messages[0]!.content as { text: string }).text).toBe('accept');
    expect(askedB).toHaveLength(1);
    expect(askedA).toHaveLength(0);

    await pool.disconnectAll();
  });
});
