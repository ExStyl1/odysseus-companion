/**
 * `/quota` on the Nestor Cloud backend (T17).
 *
 * `GET /api/v1/quota` is the ONE quota route the backend serves
 * (`httpserver/handler.go:309-310`) — outside the a2a versioning scheme, so it
 * survives the v2 migration unchanged, and it does NOT consume quota (no
 * `userLimitMiddleware` on that route). The response is a normalized snapshot:
 * `{schema_version, generated_at, limits:[{id, display:{title}, scope:{type,
 * values}, usage, status:{state, severity, message}, reset_at?}]}`
 * (`httpserver/api.go:1406-1443`).
 *
 * Two backend mandates this file pins, because both are easy to render away:
 *
 * - **Availability comes from `status.state`, never from `usage`** — the
 *   handler's own doc says clients "must be used by clients instead of deriving
 *   availability from quota values" (`quota_handler.go:18`). We therefore print
 *   the backend's `status.message` VERBATIM and never compute a verdict from
 *   the ratio. The `usage` number is rendered only as "N% remaining".
 * - **`limits: []` means no quota applies** (a disabled limiter,
 *   `quota_handler.go:36-41`), NOT exhausted.
 *
 * Harness mirrors `nestor-cloud-agent-clear.test.ts` — the whole shared
 * `chat()` seam runs, and the ONE test seam is the agent's `quotaTransport()`
 * (the sibling of `createClient()`), so the live gateway is never called and
 * `~/.nessy/dp_auth_creds.json` is never read or written.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import type { BackendConfig } from '../backend/types.ts';
import { parseSessionCommand } from '../../slash-commands/session-command.ts';
import { NestorCloudAgent } from '../nestor-cloud-agent.ts';
import {
  createMockBackendConfig,
  createMockCapabilityTurnRuntime,
  createMockSession,
  createMockWorkspace,
} from './test-utils.ts';
import { makeTestJwt } from '../../auth/dp/__tests__/test-jwt.ts';

// DA1.50 · `getValidCreds` gates on `isUsableJwt`, so a credential fixture
// must DECODE. `makeTestJwt` is the existing maker; the value is fabricated and
// carries no real token.
const FIXTURE_JWT = makeTestJwt({ preferred_username: 'tester', sub: 'user-42' });

const WORKSPACE_ID = 'test-workspace-id';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/** A creds file the auth builder accepts, on a temp path — never `~/.nessy`. */
function tempCredsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nestor-quota-creds-'));
  const path = join(dir, 'dp_auth_creds.json');
  writeFileSync(path, JSON.stringify({
    jwt: FIXTURE_JWT,
    expiresAt: Date.now() + 3_600_000,
    username: 'tester',
    userId: 'user-42',
  }));
  return path;
}

class FixtureNestorCloudAgent extends NestorCloudAgent {
  readonly fetchCalls: FetchCall[] = [];

  constructor(
    config: BackendConfig,
    /**
     * Receives the `init` so a case can bind its answer to the composed abort
     * signal — the Stop case below cannot be written without it.
     */
    private readonly respond: (init?: RequestInit) => Response | Promise<Response>,
  ) {
    super(config);
  }

  /**
   * `/quota` answers at the `BaseAgent.chat` seam and must never enter
   * `chatImpl`. This override is the enforcement, not a convenience: without it
   * a regression that drops the seam arm would send `/quota` to the REAL
   * gateway from a unit test (measured — this file's first red run did exactly
   * that, because a developer machine has valid `~/.nessy` creds on disk).
   */
  protected override createClient(): never {
    throw new Error('chatImpl must not run for /quota');
  }

  protected override quotaTransport(): { fetchImpl: typeof fetch; credsPath?: string } {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      this.fetchCalls.push({ url: String(input), init });
      return this.respond(init);
    }) as unknown as typeof fetch;
    return { fetchImpl, credsPath: tempCredsPath() };
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createNestorConfig(sessionId: string, baseUrl?: string): BackendConfig {
  const root = mkdtempSync(join(tmpdir(), 'nestor-cloud-quota-'));
  return createMockBackendConfig({
    provider: 'nestor-cloud-agent',
    workspace: createMockWorkspace({
      id: WORKSPACE_ID,
      workspaceRootPath: root,
      sessionRootPath: join(root, 'sessions'),
    }),
    session: createMockSession({ id: sessionId }),
    ...(baseUrl ? { runtime: { baseUrl } } : {}),
  });
}

function createAgent(
  sessionId: string,
  respond: (init?: RequestInit) => Response | Promise<Response>,
  baseUrl?: string,
): FixtureNestorCloudAgent {
  const agent = new FixtureNestorCloudAgent(createNestorConfig(sessionId, baseUrl), respond);
  agent.setCapabilityTurnRuntime(createMockCapabilityTurnRuntime({
    workspaceId: WORKSPACE_ID,
    sessionId,
  }));
  return agent;
}

async function collectAgent(agent: NestorCloudAgent, message: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.chat(message)) events.push(event);
  return events;
}

function infoMessage(events: AgentEvent[]): string {
  const info = events.find(event => event.type === 'info');
  if (!info || info.type !== 'info') throw new Error(`no info event in ${events.map(e => e.type).join(',')}`);
  return info.message;
}

/** The `allowed` status the backend produces below the 0.8 threshold. */
const ALLOWED_MESSAGE = 'Запросы доступны. Возможны ограничения при высокой нагрузке';
/** The `exhausted` status at `usage >= 1` (`userlimit.go:80-92`). */
const EXHAUSTED_MESSAGE = 'Бюджет использования токенов исчерпан. При высокой нагрузке доступ будет ограничен.';

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

describe('parseSessionCommand claims /quota, whole-message only', () => {
  it('parses the bare command in any case, and nothing else', () => {
    expect(parseSessionCommand('/quota')).toEqual({ kind: 'quota' });
    expect(parseSessionCommand('  /QUOTA  ')).toEqual({ kind: 'quota' });
    // Whole-message rule: trailing text makes it prose for the model.
    expect(parseSessionCommand('/quota now')).toBeNull();
    expect(parseSessionCommand('what does /quota do?')).toBeNull();
  });
});

describe('Nestor cloud /quota', () => {
  it('renders remaining percent, the backend message verbatim, and reset_at', async () => {
    const agent = createAgent('nestor-quota-one', () => jsonResponse({
      schema_version: '1.0',
      generated_at: '2026-08-22T09:00:00Z',
      limits: [limit({ usage: 0.25, reset_at: '2026-08-23T08:00:00Z' })],
    }));

    const events = await collectAgent(agent, '/quota');

    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    const message = infoMessage(events);
    // Math.round((1 - 0.25) * 100)
    expect(message).toContain('75% remaining');
    expect(message).toContain('Бюджет использования токенов');
    expect(message).toContain(ALLOWED_MESSAGE);
    expect(message).toContain('2026-08-23T08:00:00Z');

    // The version-agnostic quota route, with the module's own auth headers.
    expect(agent.fetchCalls).toHaveLength(1);
    expect(agent.fetchCalls[0]?.url).toBe('https://code-completion-nestor.tcsbank.ru/api/v1/quota');
    expect(agent.fetchCalls[0]?.init?.method).toBe('GET');
    expect((agent.fetchCalls[0]?.init?.headers as Record<string, string>)['Nestor-Token'])
      .toBe(FIXTURE_JWT);
    expect(agent.fetchCalls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('distinguishes the two limiters, which share one title and differ only by scope', () => {
    // `userlimit.go:63-64` gives BOTH limiters the same id and the same title;
    // only `scope.values` (["default"] vs ["fast"]) tells them apart
    // (`main.go:70-75`). Rendering the title alone prints one line twice.
    const agent = createAgent('nestor-quota-two', () => jsonResponse({
      schema_version: '1.0',
      generated_at: '2026-08-22T09:00:00Z',
      limits: [
        limit({ usage: 0.25, scope: { type: 'mode', values: ['default'] } }),
        limit({ usage: 0.8, scope: { type: 'mode', values: ['fast'] } }),
      ],
    }));

    return collectAgent(agent, '/quota').then(events => {
      const message = infoMessage(events);
      expect(message).toContain('default');
      expect(message).toContain('fast');
      expect(message).toContain('75% remaining');
      expect(message).toContain('20% remaining');
    });
  });

  it('reports the backend state verbatim and never derives availability from usage', async () => {
    // quota_handler.go:18 — clients must use `status`, never the ratio. A
    // renderer that computed a verdict from `usage: 0` would say "available"
    // here; the backend says exhausted.
    const agent = createAgent('nestor-quota-state', () => jsonResponse({
      schema_version: '1.0',
      generated_at: '2026-08-22T09:00:00Z',
      limits: [limit({
        usage: 0,
        status: { state: 'exhausted', severity: 'error', message: EXHAUSTED_MESSAGE },
      })],
    }));

    const message = infoMessage(await collectAgent(agent, '/quota'));

    expect(message).toContain(EXHAUSTED_MESSAGE);
    expect(message).not.toContain('available');
    // `state` is the authority, and `usage: 0` on an exhausted limiter is a
    // shape the backend really produces (the ratio is reset before the state
    // is). "100% remaining" next to an exhausted verdict is the exact
    // misreading this pins: the marker rides the head and the ratio clause is
    // suppressed outright.
    expect(message).toContain('exhausted');
    expect(message).not.toContain('% remaining');
  });

  it('marks the state on the head line, and lets it stand as the verdict when the backend sends no message', async () => {
    const agent = createAgent('nestor-quota-state-only', () => jsonResponse({
      schema_version: '1.0',
      generated_at: '2026-08-22T09:00:00Z',
      limits: [
        limit({ usage: 0.5, status: { state: 'allowed', severity: 'info' } }),
        limit({
          usage: 0.9,
          scope: { type: 'mode', values: ['fast'] },
          status: { state: 'warning', severity: 'warning', message: '' },
        }),
      ],
    }));

    const message = infoMessage(await collectAgent(agent, '/quota'));

    // Head marker present for every state, message or no message.
    expect(message).toContain('(allowed)');
    expect(message).toContain('(warning)');
    // The quantitative clause survives on a non-exhausted state.
    expect(message).toContain('50% remaining');
    expect(message).toContain('10% remaining');
  });

  it('reports an empty limits array as "no quota applies", not as exhausted', async () => {
    const agent = createAgent('nestor-quota-empty', () => jsonResponse({
      schema_version: '1.0',
      generated_at: '2026-08-22T09:00:00Z',
      limits: [],
    }));

    const events = await collectAgent(agent, '/quota');

    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    expect(infoMessage(events)).toBe('No quota limits apply to your account.');
  });

  it('keeps the gateway error detail readable instead of redacting the whole envelope away', async () => {
    // `QuotaErrorResponse` is `{"message":"failed to read quota status"}`
    // (`quota_handler.go:671`, `api.go:747`). Pasting the RAW body into the
    // line and then redacting it destroys it: `redactNestorSecrets` replaces
    // any `{…}` run wholesale, so the user reads "[redacted-payload]" and
    // learns nothing. Same fix the 429 path took (T14): unwrap the envelope
    // FIRST (`readNestorErrorBodyMessage`), redact the prose, cap it.
    const agent = createAgent('nestor-quota-http', () => new Response(
      JSON.stringify({ message: 'failed to read quota status' }),
      { status: 500 },
    ));

    const events = await collectAgent(agent, '/quota');

    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    const message = infoMessage(events);
    expect(message).toContain('500');
    expect(message).toContain('failed to read quota status');
    expect(message).not.toContain('[redacted-payload]');
    // A 5xx is a blip, not a state the user must act on — plain info, so the
    // renderer never leaves a standing banner behind a transient failure.
    const info = events[0];
    expect(info?.type === 'info' && info.level).toBeUndefined();
  });

  it('caps a runaway error body instead of pasting it whole', async () => {
    const agent = createAgent('nestor-quota-http-long', () => new Response(
      'x'.repeat(5_000),
      { status: 502 },
    ));

    const message = infoMessage(await collectAgent(agent, '/quota'));

    expect(message.length).toBeLessThan(500);
    expect(message).toContain('…');
  });

  it('raises the level to warning only for an auth failure, which the user can act on', async () => {
    const agent = createAgent('nestor-quota-401', () => new Response(
      JSON.stringify({ message: 'invalid token' }),
      { status: 401 },
    ));

    const events = await collectAgent(agent, '/quota');

    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    const info = events[0];
    expect(info?.type === 'info' && info.level).toBe('warning');
    expect(infoMessage(events)).toContain('invalid token');
  });

  it('turns a transport failure into an info with the token redacted, never a thrown turn error', async () => {
    const agent = createAgent('nestor-quota-throw', () => {
      throw new Error(`connect ECONNREFUSED (Nestor-Token: ${FIXTURE_JWT})`);
    });

    const events = await collectAgent(agent, '/quota');

    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    const message = infoMessage(events);
    expect(message).not.toContain(FIXTURE_JWT);
    expect(message).toContain('[redacted]');
    const info = events[0];
    expect(info?.type === 'info' && info.level).toBeUndefined();
  });

  it('asks the host the connection actually addresses, not the production constant', async () => {
    // The token rides this request. Sending it to the hardcoded production
    // origin while the connection talks to another host is a credential leak
    // to a third party; the quota origin therefore follows `runtime.baseUrl`.
    const agent = createAgent(
      'nestor-quota-origin',
      () => jsonResponse({ schema_version: '1.0', limits: [] }),
      'https://nestor-stage.example.com/api/v2/code-agent/a2a',
    );

    await collectAgent(agent, '/quota');

    expect(agent.fetchCalls[0]?.url).toBe('https://nestor-stage.example.com/api/v1/quota');
  });

  it('falls back to the production quota route when the connection carries no baseUrl', async () => {
    const agent = createAgent('nestor-quota-origin-default', () => jsonResponse({
      schema_version: '1.0',
      limits: [],
    }));

    await collectAgent(agent, '/quota');

    expect(agent.fetchCalls[0]?.url).toBe('https://code-completion-nestor.tcsbank.ru/api/v1/quota');
  });

  it('answers a Stop mid-read instead of hanging until the timeout', async () => {
    const agent = createAgent('nestor-quota-abort', init => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    }));

    const collected = collectAgent(agent, '/quota');
    // Wait for the request to be in flight before stopping it.
    for (let i = 0; i < 100 && agent.fetchCalls.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    expect(agent.fetchCalls).toHaveLength(1);
    await agent.abort();

    const events = await collected;
    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    expect(infoMessage(events)).toContain('cancelled');
  });
});
