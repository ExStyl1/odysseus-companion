import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildNestorCloudAuthHeaders } from '../auth.ts';
import {
  DEFAULT_NESTOR_CLOUD_A2A_URL,
  DEFAULT_NESTOR_CLOUD_AGENT_CARD_URL,
  NestorCloudClient,
  buildToolResultPart,
  validateNestorAgentCard,
} from '../client.ts';
import { NESTOR_AGENT_SETTINGS_EXTENSION_URI, parseNestorCloudAgentCardModes } from '../agent-card-modes.ts';
import { NESTOR_ERROR_MESSAGE_MAX_CHARS, NestorCloudRetryableTransportError } from '../retry.ts';
import { NestorCloudTurn } from '../turn.ts';
import { NestorCloudClientError, NestorCloudTerminalTaskError, type NestorAgentCard } from '../types.ts';
import { makeTestJwt } from '../../../../auth/dp/__tests__/test-jwt.ts';

// DA1.50 · `getValidCreds` gates on `isUsableJwt`, so a credential fixture
// must DECODE. `makeTestJwt` is the existing maker; the value is fabricated and
// carries no real token.
const FIXTURE_JWT = makeTestJwt({ preferred_username: 'tester', sub: 'user-42' });
// A SECOND, different decodable value, so the arms that assert a token never
// reaches a message keep asserting over a token distinct from the default one.
const SECRET_JWT = makeTestJwt({ preferred_username: 'secret-user', sub: 'secret-id' });

function tempCreds(jwt = SECRET_JWT): string {
  const dir = mkdtempSync(join(tmpdir(), 'nestor-cloud-client-'));
  const path = join(dir, 'dp_auth_creds.json');
  writeFileSync(path, JSON.stringify({
    jwt,
    expiresAt: Date.now() + 60_000,
    username: 'user@example.com',
    userId: 'u-123',
  }));
  return path;
}

/**
 * The v2 card as the backend produces it (`usecase_nessy.go:165-188` +
 * `a2a/agent.go:46-136`): no top-level `url`, `protocolVersion` or
 * `preferredTransport` — the endpoint and the protocol version live per
 * interface, and the extensions ride under `capabilities`.
 */
function validCard(overrides: Partial<NestorAgentCard> = {}): NestorAgentCard {
  return {
    name: 'Code Agent',
    capabilities: { streaming: true },
    supportedInterfaces: [{
      url: DEFAULT_NESTOR_CLOUD_A2A_URL,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    }],
    ...overrides,
  };
}

function sse(...results: unknown[]): Response {
  return new Response(results.map((result) =>
    `data: ${JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), result })}\n\n`
  ).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

afterEach(() => {
  delete process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD;
});

describe('buildNestorCloudAuthHeaders', () => {
  it('reads a valid DP JWT and builds Nestor auth headers', () => {
    const credsPath = tempCreds(FIXTURE_JWT);
    const auth = buildNestorCloudAuthHeaders({
      credsPath,
      deviceId: 'device-1',
      userAgent: 'NessyDesktop/test',
    });

    expect(auth.headers).toMatchObject({
      'Nestor-Token': FIXTURE_JWT,
      'Device-Id': 'device-1',
      'User-Agent': 'NessyDesktop/test',
    });
    expect(auth.userId).toBe('u-123');
  });

  it('classifies missing or expired DP creds without touching the real store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nestor-cloud-client-missing-'));
    expect(() => buildNestorCloudAuthHeaders({ credsPath: join(dir, 'missing.json') }))
      .toThrow(new NestorCloudClientError('missing-token', 'Nestor credentials are missing or expired'));
  });
});

describe('the default endpoints', () => {
  it('point at the A2A 1.0 routes', () => {
    expect(DEFAULT_NESTOR_CLOUD_A2A_URL)
      .toBe('https://code-completion-nestor.tcsbank.ru/api/v2/code-agent/a2a');
    expect(DEFAULT_NESTOR_CLOUD_AGENT_CARD_URL)
      .toBe('https://code-completion-nestor.tcsbank.ru/api/v2/code-agent/a2a/.well-known/agent-card.json');
    expect(DEFAULT_NESTOR_CLOUD_A2A_URL).not.toContain('/api/v1/');
    expect(DEFAULT_NESTOR_CLOUD_AGENT_CARD_URL).not.toContain('/api/v1/');
  });
});

describe('validateNestorAgentCard', () => {
  it('accepts the v2 production card shape', () => {
    expect(() => validateNestorAgentCard(validCard(), {
      postUrl: DEFAULT_NESTOR_CLOUD_A2A_URL,
    })).not.toThrow();
  });

  it('tolerates a patch-level protocol version at the selected interface', () => {
    expect(() => validateNestorAgentCard(validCard({
      supportedInterfaces: [{
        url: DEFAULT_NESTOR_CLOUD_A2A_URL,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0.2',
      }],
    }), { postUrl: DEFAULT_NESTOR_CLOUD_A2A_URL })).not.toThrow();
  });

  it('rejects a card whose interface still speaks 0.3, naming both versions', () => {
    let message = '';
    try {
      validateNestorAgentCard(validCard({
        supportedInterfaces: [{
          url: DEFAULT_NESTOR_CLOUD_A2A_URL,
          protocolBinding: 'JSONRPC',
          protocolVersion: '0.3',
        }],
      }), { postUrl: DEFAULT_NESTOR_CLOUD_A2A_URL });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('0.3');
    expect(message).toContain('1.0');
  });

  it('rejects a card with no interface for the selected endpoint or no streaming', () => {
    expect(() => validateNestorAgentCard(validCard({ supportedInterfaces: undefined }), {
      postUrl: DEFAULT_NESTOR_CLOUD_A2A_URL,
    })).toThrow('supportedInterfaces');

    expect(() => validateNestorAgentCard(validCard(), {
      postUrl: 'https://code-completion-nestor.tcsbank.ru/api/v2/other-agent/a2a',
    })).toThrow('does not match selected A2A endpoint');

    expect(() => validateNestorAgentCard(validCard({
      supportedInterfaces: [{
        url: DEFAULT_NESTOR_CLOUD_A2A_URL,
        protocolBinding: 'GRPC',
        protocolVersion: '1.0',
      }],
    }), { postUrl: DEFAULT_NESTOR_CLOUD_A2A_URL })).toThrow('does not match selected A2A endpoint');

    expect(() => validateNestorAgentCard(validCard({ capabilities: { streaming: false } }), {
      postUrl: DEFAULT_NESTOR_CLOUD_A2A_URL,
    })).toThrow('does not advertise streaming');
  });

  it('no longer reads the 0.3 top-level url/preferredTransport/protocolVersion', () => {
    // Those three fields do not exist on a v2 card; a card carrying only the
    // v2 shape must validate, and a card carrying only the 0.3 shape must not.
    expect(() => validateNestorAgentCard({
      url: DEFAULT_NESTOR_CLOUD_A2A_URL,
      protocolVersion: '0.3',
      preferredTransport: 'JSONRPC',
      capabilities: { streaming: true },
    }, { postUrl: DEFAULT_NESTOR_CLOUD_A2A_URL })).toThrow('supportedInterfaces');
  });
});

describe('parseNestorCloudAgentCardModes on the v2 card', () => {
  it('reads the agent-settings extension from capabilities.extensions', () => {
    const parsed = parseNestorCloudAgentCardModes(validCard({
      capabilities: {
        streaming: true,
        extensions: [{
          uri: NESTOR_AGENT_SETTINGS_EXTENSION_URI,
          params: {
            agentSettingsSchema: { properties: { mode: { enum: ['plan', 'act'] } } },
          },
        }],
      },
    }));

    expect(parsed?.remoteModeIds).toEqual(['plan', 'act']);
    expect(parsed?.defaultModeId).toBe('act');
  });
});

describe('NestorCloudClient', () => {
  it('fetches and validates the default v2 agent card with Nestor headers', async () => {
    const credsPath = tempCreds(FIXTURE_JWT);
    const calls: Array<{ url: string; token?: string; device?: string }> = [];
    const client = new NestorCloudClient({
      credsPath,
      deviceId: 'device-1',
      fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(url),
          token: headers.get('Nestor-Token') ?? undefined,
          device: headers.get('Device-Id') ?? undefined,
        });
        return Response.json(validCard());
      }) as unknown as typeof fetch,
    });

    await expect(client.loadAgentCard()).resolves.toMatchObject({ name: 'Code Agent' });
    expect(calls).toEqual([{
      url: DEFAULT_NESTOR_CLOUD_AGENT_CARD_URL,
      token: FIXTURE_JWT,
      device: 'device-1',
    }]);
  });

  it('classifies agent-card fetch failure and 401/403 auth failures', async () => {
    const credsPath = tempCreds();
    const fetch500 = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(new NestorCloudClient({ credsPath, fetchImpl: fetch500 }).loadAgentCard())
      .rejects.toMatchObject({ code: 'agent-card-fetch-failed', status: 503 });

    const fetch403 = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;
    await expect(new NestorCloudClient({ credsPath, fetchImpl: fetch403 }).loadAgentCard())
      .rejects.toMatchObject({ code: 'auth-failed', status: 403 });
  });

  it('streams JSON-RPC SSE results and sends SendStreamingMessage with a ROLE_USER message', async () => {
    const credsPath = tempCreds();
    const bodies: string[] = [];
    const client = new NestorCloudClient({
      credsPath,
      fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        expect(String(url)).toBe(DEFAULT_NESTOR_CLOUD_A2A_URL);
        expect(String(url)).not.toContain('/api/v1/');
        bodies.push(String(init?.body));
        return sse(
          { task: { id: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_SUBMITTED' } } },
          {
            statusUpdate: {
              taskId: 'task-1',
              contextId: 'ctx-1',
              status: { state: 'TASK_STATE_COMPLETED' },
            },
          },
        );
      }) as unknown as typeof fetch,
    });

    const events = [];
    for await (const event of client.sendMessageStream({
      text: 'ping',
      contextId: 'ctx-1',
      taskId: 'task-1',
      metadata: { source: 'test' },
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    const body = JSON.parse(bodies[0]!) as {
      method: string;
      params: { message: Record<string, unknown> };
    };
    expect(body.method).toBe('SendStreamingMessage');
    const message = body.params.message;
    expect(typeof message.messageId).toBe('string');
    expect(message.role).toBe('ROLE_USER');
    expect(message.contextId).toBe('ctx-1');
    expect(message.taskId).toBe('task-1');
    expect(message.metadata).toEqual({ source: 'test' });
    // Flattened parts: text by key presence, no `kind` discriminator anywhere.
    expect(message.parts).toEqual([{ text: 'ping' }]);
    expect(JSON.stringify(body)).not.toContain('"kind"');
  });

  it('never sends the bare 0.3 role, which the backend silently degrades to assistant', async () => {
    const credsPath = tempCreds();
    let body = '';
    const client = new NestorCloudClient({
      credsPath,
      fetchImpl: (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        body = String(init?.body);
        return sse({ statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } } });
      }) as unknown as typeof fetch,
    });

    for await (const _ of client.sendMessageStream({ text: 'ping' })) {
      // drain
    }

    expect((JSON.parse(body) as { params: { message: { role: string } } }).params.message.role)
      .not.toBe('user');
  });

  it('sends tool results as a flattened data part with tool_call_id plus string content', async () => {
    expect(buildToolResultPart({ toolCallId: 'call-1', content: 'ok' })).toEqual({
      data: { tool_call_id: 'call-1', content: 'ok' },
    });

    const credsPath = tempCreds();
    let body = '';
    const client = new NestorCloudClient({
      credsPath,
      fetchImpl: (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        body = String(init?.body);
        return sse({ statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } } });
      }) as unknown as typeof fetch,
    });

    for await (const _ of client.sendToolResultsStream({
      contextId: 'ctx-1',
      taskId: 'task-1',
      results: [{ toolCallId: 'call-1', content: 'tool output' }],
    })) {
      // drain
    }

    const parsed = JSON.parse(body) as { params: { message: { parts: unknown[] } } };
    expect(parsed.params.message.parts).toEqual([{
      data: { tool_call_id: 'call-1', content: 'tool output' },
    }]);
  });

  it('cancels through CancelTask with an id param', async () => {
    const credsPath = tempCreds();
    let body = '';
    const client = new NestorCloudClient({
      credsPath,
      fetchImpl: (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        body = String(init?.body);
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await client.cancelTask('task-1');

    const parsed = JSON.parse(body) as { method: string; params: Record<string, unknown> };
    expect(parsed.method).toBe('CancelTask');
    expect(parsed.params).toEqual({ id: 'task-1' });
  });

  it('classifies stream network failures and cancel failures without leaking tokens or raw payloads', async () => {
    const credsPath = tempCreds(SECRET_JWT);
    const phases: string[] = [];
    const client = new NestorCloudClient({
      credsPath,
      onPhase: (phase) => {
        phases.push(JSON.stringify(phase));
      },
      fetchImpl: (async () => {
        throw new Error('network failed Nestor-Token: super-secret-token {"prompt":"raw payload"}');
      }) as unknown as typeof fetch,
    });

    let err: unknown;
    try {
      for await (const _event of client.sendMessageStream({ text: 'raw payload' })) {
        // no-op
      }
    } catch (caught) {
      err = caught;
    }

    expect(err).toMatchObject({ code: 'stream-failed' });
    expect(String((err as Error).message)).not.toContain('super-secret-token');
    expect(String((err as Error).message)).not.toContain('Nestor-Token: super-secret-token');
    expect(String((err as Error).message)).not.toContain('raw payload');
    expect(phases.join('\n')).not.toContain('super-secret-token');

    const cancelClient = new NestorCloudClient({
      credsPath,
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(cancelClient.cancelTask('task-1'))
      .rejects.toMatchObject({ code: 'cancel-failed', status: 500 });
  });
});

/**
 * A JSON-RPC error mid-stream arrives as an ordinary SSE `data:` frame carrying
 * `{"jsonrpc":"2.0","id":…,"error":{…}}`, HTTP still 200, and the stream then
 * ends (`a2asrv/jsonrpc.go` — `eventSeqToSSEDataStream`'s `handleError` writes
 * the marshalled error into the SSE channel and returns).
 */
function errorFrame(error: unknown): Response {
  return new Response(
    `data: ${JSON.stringify({ jsonrpc: '2.0', id: 'req-1', error })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

async function drainStreamError(client: NestorCloudClient): Promise<unknown> {
  try {
    for await (const _event of client.sendMessageStream({ text: 'ping', taskId: 'stale-task' })) {
      // no-op
    }
  } catch (err) {
    return err;
  }
  throw new Error('expected the stream to reject');
}

function clientForFrames(credsPath: string, ...responses: Response[]): NestorCloudClient {
  return new NestorCloudClient({
    credsPath,
    fetchImpl: (async () => responses.shift() ?? new Response('', { status: 500 })) as unknown as typeof fetch,
  });
}

describe('NestorCloudClient JSON-RPC stream errors', () => {
  it('detects the backend\'s real terminal-task rejection frame and names the state', async () => {
    // `a2asrv/agentexec.go:201-203` wraps `ErrInvalidParams`, so the code is
    // -32602 / "invalid params" and the state survives ONLY inside
    // `error.data.error` (`…-nestor-a2a-v2-wire-and-quota.md` §"Terminal task").
    const cases: Array<[string, string]> = [
      ['TASK_STATE_COMPLETED', 'completed'],
      ['TASK_STATE_CANCELED', 'canceled'],
      ['TASK_STATE_FAILED', 'failed'],
      ['TASK_STATE_REJECTED', 'rejected'],
    ];
    for (const [wire, expected] of cases) {
      const err = await drainStreamError(clientForFrames(tempCreds(), errorFrame({
        code: -32602,
        message: 'invalid params',
        data: { error: `create execution failure: task in a terminal state "${wire}": invalid params` },
      })));
      expect(err).toBeInstanceOf(NestorCloudTerminalTaskError);
      expect((err as NestorCloudTerminalTaskError).taskState).toBe(expected as never);
    }
  });

  it('detects the stateless second shape (-32004, "task is already in terminal state")', async () => {
    // `pkg/agentcore/repo/a2ar/a2a_repo_task_store.go:106-107` wraps
    // `ErrUnsupportedOperation` and carries NO `TASK_STATE_` token at all.
    const err = await drainStreamError(clientForFrames(tempCreds(), errorFrame({
      code: -32004,
      message: 'this operation is not supported',
      data: { error: 'task is already in terminal state: this operation is not supported' },
    })));
    expect(err).toBeInstanceOf(NestorCloudTerminalTaskError);
    expect((err as NestorCloudTerminalTaskError).taskState).toBe('unknown');
  });

  it('maps task-not-found (-32001) onto the terminal-task recovery, with an unknown state', async () => {
    // ORCHESTRATOR DECISION 2026-08-22: the task is GONE (on v2 the same code is
    // also raised by `SubscribeToTask`, `a2asrv/handler.go:336`), so retrying the
    // same taskId cannot help — the recovery that resends WITHOUT the taskId is
    // exactly the right move. The connector instead backoff-retries -32001
    // (`nessy-acp-agent/src/adapter/a2a/a2a-errors.ts:86-87`); this client does
    // not, because a lost task will not reappear on the next attempt.
    const err = await drainStreamError(clientForFrames(tempCreds(), errorFrame({
      code: -32001,
      message: 'task not found',
      data: { error: 'task loading failed: task not found' },
    })));
    expect(err).toBeInstanceOf(NestorCloudTerminalTaskError);
    expect((err as NestorCloudTerminalTaskError).taskState).toBe('unknown');
    // The backend's own sentence is CARRIED, not discarded: every -32001 shares
    // one recovery, but only some of them recover, and on the paths that do not
    // (a continuation, a second -32001, no taskId to drop) the generic "already
    // terminal" text describes the wrong condition. `asSurfaced()` is what those
    // paths throw, and it says "task not found".
    expect((err as NestorCloudTerminalTaskError).detail).toContain('task not found');
    expect((err as NestorCloudTerminalTaskError).asSurfaced().message).toContain('task not found');
  });

  it('does not read a non-terminal TASK_STATE token as a terminal rejection', async () => {
    const err = await drainStreamError(clientForFrames(tempCreds(), errorFrame({
      code: -32602,
      message: 'invalid params',
      data: { error: 'task in state "TASK_STATE_INPUT_REQUIRED" cannot accept this message: invalid params' },
    })));
    expect(err).not.toBeInstanceOf(NestorCloudTerminalTaskError);
    expect(String((err as Error).message)).toContain('TASK_STATE_INPUT_REQUIRED');
  });

  it('redacts the token out of a surfaced JSON-RPC error message', async () => {
    const err = await drainStreamError(clientForFrames(tempCreds(SECRET_JWT), errorFrame({
      code: -32603,
      message: 'internal error',
      data: { error: `upstream rejected ${SECRET_JWT}` },
    })));
    expect(String((err as Error).message)).not.toContain(SECRET_JWT);
    expect(String((err as Error).message)).toContain('[redacted]');
  });

  it('recovers end to end: a stale taskId meets the real -32602 frame and is resent without it', async () => {
    const credsPath = tempCreds();
    const bodies: string[] = [];
    const responses = [
      errorFrame({
        code: -32602,
        message: 'invalid params',
        data: { error: 'create execution failure: task in a terminal state "TASK_STATE_COMPLETED": invalid params' },
      }),
      sse(
        { task: { id: 'task-2', contextId: 'ctx-1', status: { state: 'TASK_STATE_SUBMITTED' } } },
        {
          statusUpdate: {
            taskId: 'task-2',
            contextId: 'ctx-1',
            status: {
              state: 'TASK_STATE_COMPLETED',
              message: { messageId: 'm-1', role: 'ROLE_AGENT', parts: [{ text: 'reconnected' }] },
            },
          },
        },
      ),
    ];
    const client = new NestorCloudClient({
      credsPath,
      fetchImpl: (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(url) === DEFAULT_NESTOR_CLOUD_AGENT_CARD_URL) {
          return new Response(JSON.stringify(validCard()), { status: 200 });
        }
        bodies.push(String(init?.body));
        return responses.shift()!;
      }) as unknown as typeof fetch,
    });

    const updates: unknown[] = [];
    const events = [];
    const turn = new NestorCloudTurn({
      client,
      contextId: 'ctx-1',
      taskId: 'stale-task',
      onContextUpdate: (update) => {
        updates.push(update);
      },
    });
    for await (const event of turn.run('hello')) {
      events.push(event);
    }

    expect(bodies).toHaveLength(2);
    const first = (JSON.parse(bodies[0]!) as { params: { message: Record<string, unknown> } }).params.message;
    const second = (JSON.parse(bodies[1]!) as { params: { message: Record<string, unknown> } }).params.message;
    expect(first.taskId).toBe('stale-task');
    expect(second).not.toHaveProperty('taskId');
    expect(second.contextId).toBe('ctx-1');
    expect(updates).toContainEqual({ clearTask: true, taskStatus: 'completed' });
    expect(events).toContainEqual({ type: 'status', message: 'Reconnecting Nestor task...' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'text_complete', text: 'reconnected' }));
    expect(events.at(-1)).toEqual({ type: 'complete' });
  });
});

describe('NestorCloudClient transport rate limits', () => {
  function clientForStatus(credsPath: string, response: Response): NestorCloudClient {
    return new NestorCloudClient({
      credsPath,
      fetchImpl: (async () => response) as unknown as typeof fetch,
    });
  }

  it('classifies the quota 429 and echoes the backend message out of the echo envelope', async () => {
    // `userlimit_middleware.go:15-20` + echo's default `{"message":…}` body.
    const err = await drainStreamError(clientForStatus(tempCreds(), new Response(
      JSON.stringify({ message: 'суточный лимит токенов исчерпан, лимит обновится в 00:00' }),
      { status: 429 },
    )));

    expect(err).toBeInstanceOf(NestorCloudRetryableTransportError);
    expect(err).toMatchObject({ status: 429, rateLimited: true });
    expect((err as Error).message).toBe('суточный лимит токенов исчерпан, лимит обновится в 00:00');
  });

  it('carries the pool-full 429 and the plain-text limiter deny too', async () => {
    const poolFull = await drainStreamError(clientForStatus(tempCreds(), new Response(
      JSON.stringify({ message: 'too many requests' }),
      { status: 429 },
    )));
    expect((poolFull as Error).message).toBe('too many requests');

    // The generic per-identity limiter answers plain text (`middleware.go:171-175`).
    const plain = await drainStreamError(clientForStatus(tempCreds(), new Response(
      'rate limit exceeded',
      { status: 429 },
    )));
    expect((plain as Error).message).toBe('rate limit exceeded');
    expect(plain).toMatchObject({ rateLimited: true });
  });

  it('redacts the token out of a 429 body and caps a runaway one', async () => {
    const secret = await drainStreamError(clientForStatus(tempCreds(SECRET_JWT), new Response(
      JSON.stringify({ message: `rejected ${SECRET_JWT}` }),
      { status: 429 },
    )));
    expect((secret as Error).message).not.toContain(SECRET_JWT);
    expect((secret as Error).message).toContain('[redacted]');

    const huge = await drainStreamError(clientForStatus(tempCreds(), new Response(
      JSON.stringify({ message: 'x'.repeat(2_000) }),
      { status: 429 },
    )));
    expect((huge as Error).message.length).toBeLessThanOrEqual(NESTOR_ERROR_MESSAGE_MAX_CHARS + 1);
  });

  it('marks a 5xx retryable on the server-error budget, and leaves a 4xx persistent', async () => {
    const server = await drainStreamError(clientForStatus(tempCreds(), new Response('boom', { status: 503 })));
    expect(server).toBeInstanceOf(NestorCloudRetryableTransportError);
    expect(server).toMatchObject({ status: 503, rateLimited: false });

    const bad = await drainStreamError(clientForStatus(tempCreds(), new Response('nope', { status: 400 })));
    expect(bad).not.toBeInstanceOf(NestorCloudRetryableTransportError);
    expect(bad).toMatchObject({ code: 'stream-failed', status: 400 });
  });

  it('sends the retry marker on contextId alone — never on a taskId', async () => {
    const credsPath = tempCreds();
    let body = '';
    const client = new NestorCloudClient({
      credsPath,
      fetchImpl: (async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        body = String(init?.body);
        return sse({ statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } } });
      }) as unknown as typeof fetch,
    });

    for await (const _ of client.sendRetryMarkerStream({ contextId: 'ctx-1', metadata: { mode: 'act' } })) {
      // drain
    }

    const message = (JSON.parse(body) as { method: string; params: { message: Record<string, unknown> } });
    expect(message.method).toBe('SendStreamingMessage');
    expect(message.params.message.parts).toEqual([{ data: { retry: {} } }]);
    expect(message.params.message.contextId).toBe('ctx-1');
    expect(message.params.message).not.toHaveProperty('taskId');
    expect(message.params.message.role).toBe('ROLE_USER');
    expect(JSON.stringify(message)).not.toContain('"kind"');
  });
});
