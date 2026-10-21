/**
 * `/quota` on the built-in Pi Nessy Gateway connection (T19).
 *
 * The daily budget `GET /api/v1/quota` reports is the per-user `qwen35`-pool
 * limit, and the SAME limiter meters the CLI-proxy routes the built-in Pi
 * gateway card talks through (`cli_proxy_handler.go:109,:205,:286-298`). So the
 * command extends to that ONE Pi connection — and to no other: a Pi connection
 * pointed at a BYO endpoint has no Nestor budget to report, and answering with
 * someone else's numbers would be worse than answering "not available".
 *
 * The discriminator is the repo's established one: `baseUrl` starting with
 * `NESTOR_CLI_BASE_PREFIX` (`auth/nestor.ts` — the same rule that decides
 * whether the `Nestor-Token` header may ride a request). Never a second
 * spelling.
 *
 * The renderer and the response shape are NOT re-pinned here: they live in
 * `backend/internal/nestor-quota.ts`, shared with `NestorCloudAgent`, and
 * `nestor-cloud-agent-quota.test.ts` pins them (unchanged by the extraction —
 * that is the extraction's proof). This file pins what is new: the gate, the
 * fallback in both negative directions, the auth/level shaping reaching the Pi
 * seam, and Stop.
 *
 * Harness mirrors `session-command-seam.test.ts` (the Pi seam's existing home)
 * and `nestor-cloud-agent-quota.test.ts` (the transport seam), so the live
 * gateway is never called and `~/.nessy/dp_auth_creds.json` is never read.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import { NESTOR_CLI_BASE_PREFIX } from '../../auth/nestor.ts';
import type { BackendConfig } from '../backend/types.ts';
import { piDriver } from '../backend/internal/drivers/pi.ts';
import { PiAgent } from '../pi-agent.ts';
import { collectEvents, createMockCapabilityTurnRuntime } from './test-utils.ts';
import { makeTestJwt } from '../../auth/dp/__tests__/test-jwt.ts';

// DA1.50 · `getValidCreds` gates on `isUsableJwt`, so a credential fixture
// must DECODE. `makeTestJwt` is the existing maker; the value is fabricated and
// carries no real token.
const FIXTURE_JWT = makeTestJwt({ preferred_username: 'tester', sub: 'user-42' });

const GATEWAY_BASE_URL = `${NESTOR_CLI_BASE_PREFIX}openai-like/v1`;
const WORKSPACE_ID = 'ws-pi-quota';
const SESSION_ID = 'session-pi-quota';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** A creds file the auth builder accepts, on a temp path — never `~/.nessy`. */
function tempCredsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-quota-creds-'));
  const path = join(dir, 'dp_auth_creds.json');
  writeFileSync(path, JSON.stringify({
    jwt: FIXTURE_JWT,
    expiresAt: Date.now() + 3_600_000,
    username: 'tester',
    userId: 'user-42',
  }));
  return path;
}

function createConfig(baseUrl?: string): BackendConfig {
  return {
    provider: 'pi',
    providerType: 'pi_compat',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Pi Quota Workspace',
      rootPath: '/tmp/nessy-pi-quota-test',
      workspaceRootPath: '/tmp/nessy-pi-quota-test',
      sessionRootPath: '/tmp/nessy-pi-quota-test-sessions/ws-pi-quota',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/nessy-pi-quota-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    ...(baseUrl ? { runtime: { baseUrl } } : {}),
  } as BackendConfig;
}

class FixturePiAgent extends PiAgent {
  readonly fetchCalls: FetchCall[] = [];

  constructor(
    config: BackendConfig,
    /** Receives the `init` so a case can bind its answer to the composed signal. */
    private readonly respond: (init?: RequestInit) => Response | Promise<Response>,
  ) {
    super(config);
  }

  protected override quotaTransport(): { fetchImpl: typeof fetch; credsPath?: string } {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      this.fetchCalls.push({ url: String(input), init });
      return this.respond(init);
    }) as unknown as typeof fetch;
    return { fetchImpl, credsPath: tempCredsPath() };
  }
}

/**
 * A Pi agent whose subprocess is faked. `chatImpl` is replaced by a throw: the
 * seam must answer `/quota` without a turn, and a regression that routes it back
 * through the backend would otherwise reach the LIVE gateway from a unit test
 * (measured on the nestor half of this feature — a developer machine has valid
 * `~/.nessy` creds on disk).
 */
function setupAgent(
  baseUrl: string | undefined,
  respond: (init?: RequestInit) => Response | Promise<Response> = () => new Response('{}'),
) {
  const agent = new FixturePiAgent(createConfig(baseUrl), respond);
  const internals = agent as any;
  const sent: Array<Record<string, unknown>> = [];
  internals.ensureSubprocess = async () => undefined;
  internals.emitAutomationEvent = async () => undefined;
  internals.eventQueue.drain = async function* () { yield { type: 'complete' }; };
  internals.send = (command: Record<string, unknown>) => { sent.push(command); };
  internals.chatImpl = async function* () {
    throw new Error('chatImpl must not run for /quota');
  };
  agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
  }));
  return { agent, internals, sent };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function infoMessage(events: AgentEvent[]): string {
  const info = events.find(event => event.type === 'info');
  if (!info || info.type !== 'info') throw new Error(`no info event in ${events.map(e => e.type).join(',')}`);
  return info.message;
}

const ALLOWED_MESSAGE = 'Запросы доступны. Возможны ограничения при высокой нагрузке';

function limit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'token-usage',
    display: { title: 'Бюджет использования токенов' },
    scope: { type: 'mode', values: ['default'] },
    usage: 0.25,
    status: { state: 'allowed', severity: 'info', message: ALLOWED_MESSAGE },
    ...overrides,
  };
}

test('the built-in gateway connection reads the budget and renders it at the seam', async () => {
  const { agent, sent } = setupAgent(GATEWAY_BASE_URL, () => jsonResponse({
    schema_version: '1.0',
    generated_at: '2026-08-22T09:00:00Z',
    limits: [limit({ usage: 0.25, reset_at: '2026-08-23T08:00:00Z' })],
  }));
  try {
    const events = await collectEvents(agent.chat('/quota'));

    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    // No turn was spent: the seam answered and the subprocess saw no prompt.
    expect(sent.some(command => command.type === 'prompt')).toBe(false);

    const message = infoMessage(events);
    expect(message).toContain('75% remaining');
    expect(message).toContain(ALLOWED_MESSAGE);
    expect(message).toContain('2026-08-23T08:00:00Z');

    // The quota route lives outside the CLI-proxy path prefix, so only the
    // ORIGIN of the connection's baseUrl is reused — and the token rides this
    // request, so it must be the host the connection actually addresses.
    expect(agent.fetchCalls).toHaveLength(1);
    expect(agent.fetchCalls[0]?.url).toBe('https://code-completion-nestor.tcsbank.ru/api/v1/quota');
    expect(agent.fetchCalls[0]?.init?.method).toBe('GET');
    expect((agent.fetchCalls[0]?.init?.headers as Record<string, string>)['Nestor-Token'])
      .toBe(FIXTURE_JWT);
    expect(agent.fetchCalls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  } finally {
    agent.destroy();
  }
});

test('a BYOK Pi connection falls back to the provider-neutral answer and reads nothing', async () => {
  const { agent, sent } = setupAgent('https://api.deepseek.com/v1');
  try {
    const events = await collectEvents(agent.chat('/quota'));

    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    expect(infoMessage(events)).toBe('Quota is not available on this runtime.');
    // The load-bearing half of the negative: no request was made at all, so no
    // `Nestor-Token` could have travelled to a third-party endpoint.
    expect(agent.fetchCalls).toHaveLength(0);
    expect(sent.some(command => command.type === 'prompt')).toBe(false);
  } finally {
    agent.destroy();
  }
});

test('a connectionless Pi session falls back too — an absent baseUrl is not the gateway', async () => {
  const { agent } = setupAgent(undefined);
  try {
    const events = await collectEvents(agent.chat('/quota'));

    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    expect(infoMessage(events)).toBe('Quota is not available on this runtime.');
    expect(agent.fetchCalls).toHaveLength(0);
  } finally {
    agent.destroy();
  }
});

test('an auth failure is the one outcome raised to warning, and it never throws', async () => {
  const { agent } = setupAgent(GATEWAY_BASE_URL, () => new Response(
    JSON.stringify({ message: 'invalid token' }),
    { status: 401 },
  ));
  try {
    const events = await collectEvents(agent.chat('/quota'));

    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    const info = events[0];
    expect(info?.type === 'info' && info.level).toBe('warning');
    expect(infoMessage(events)).toContain('invalid token');
  } finally {
    agent.destroy();
  }
});

test('a 5xx stays a plain info — a transient gateway blip must leave no standing banner', async () => {
  const { agent } = setupAgent(GATEWAY_BASE_URL, () => new Response(
    JSON.stringify({ message: 'failed to read quota status' }),
    { status: 500 },
  ));
  try {
    const events = await collectEvents(agent.chat('/quota'));

    const info = events[0];
    expect(info?.type === 'info' && info.level).toBeUndefined();
    expect(infoMessage(events)).toContain('failed to read quota status');
  } finally {
    agent.destroy();
  }
});

test('Stop mid-read answers instead of hanging until the timeout', async () => {
  const { agent } = setupAgent(GATEWAY_BASE_URL, init => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  }));
  try {
    const collected = collectEvents(agent.chat('/quota'));
    for (let i = 0; i < 100 && agent.fetchCalls.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(agent.fetchCalls).toHaveLength(1);
    await agent.abort();

    const events = await collected;
    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    expect(infoMessage(events)).toContain('cancelled');
  } finally {
    agent.destroy();
  }
});

test('missing dp credentials raise the level to warning — signing in again is the fix', async () => {
  // The level policy reserves `warning` for auth failures the user can act on.
  // On the Pi gateway card the JWT expires independently of the connection, so
  // this path is reachable in ordinary use — it must not read as a blip.
  class NoCredsPiAgent extends FixturePiAgent {
    protected override quotaTransport(): { fetchImpl: typeof fetch; credsPath?: string } {
      const base = super.quotaTransport();
      return { ...base, credsPath: join(mkdtempSync(join(tmpdir(), 'pi-quota-nocreds-')), 'absent.json') };
    }
  }
  const agent = new NoCredsPiAgent(createConfig(GATEWAY_BASE_URL), () => {
    throw new Error('fetch must not run without a token');
  });
  const internals = agent as any;
  internals.ensureSubprocess = async () => undefined;
  internals.emitAutomationEvent = async () => undefined;
  internals.eventQueue.drain = async function* () { yield { type: 'complete' }; };
  internals.chatImpl = async function* () { throw new Error('chatImpl must not run for /quota'); };
  agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
  }));
  try {
    const events = await collectEvents(agent.chat('/quota'));
    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    const info = events[0];
    expect(info?.type === 'info' ? info.level : undefined).toBe('warning');
    expect(agent.fetchCalls).toHaveLength(0);
  } finally {
    agent.destroy();
  }
});

test('the composer gate and the agent gate read ONE value: pi runtime baseUrl IS connection.baseUrl', () => {
  // The menu offers /quota off `connection.baseUrl` (composer-capabilities)
  // while the agent answers off `runtime.baseUrl`. They agree only because the
  // pi driver copies the field verbatim — this pin is what keeps a future
  // runtime-payload change from desyncing "offered" from "answerable".
  const runtime = piDriver.buildRuntime({
    context: { connection: { baseUrl: GATEWAY_BASE_URL } },
    providerOptions: undefined,
    resolvedPaths: { piServerPath: '', interceptorBundlePath: '', nodeRuntimePath: '' },
  } as any);
  expect(runtime.baseUrl).toBe(GATEWAY_BASE_URL);
});
