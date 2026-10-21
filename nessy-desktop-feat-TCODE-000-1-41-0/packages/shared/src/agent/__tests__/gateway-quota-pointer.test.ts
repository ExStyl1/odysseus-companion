/**
 * F1.6 (origin D1.77) — `/quota` on the two non-Pi gateway cards reads the SAME
 * budget the Pi gateway card reads. The file keeps its DA1.17 name because the
 * plans cite it by that name; what it pins was flipped by the owner's decision.
 *
 * ## The decision this file now pins
 *
 * OWNER 2026-09-18 ~16:40, item 3, build (b), the gateway half: *"a non-BYO
 * (gateway) codex card uses the llm-proxy quota"* — and the row opens the claude
 * card with it, because `claude-gateway` and `codex-gateway` carry the same base
 * URL, the same dp JWT prefill and the same per-user limiter as the Pi card.
 * `backend/composer-capabilities.ts` symbol `offersNestorQuota` gated `/quota` on
 * the RUNTIME; DA1.17 option B left that gate standing (it was an open posture)
 * and made both cards NAME the budget instead of showing it, through a pointer
 * sentence. That pointer is gone: a card that can show the number must not also
 * point elsewhere for it. The composer-capabilities pin that held the old gate
 * as a negative control flips in the SAME commit as this file.
 *
 * ## What each arm kills
 *
 * - the READ arms die if either card goes back to a sentence: they assert the
 *   request (URL, method, `Nestor-Token`) and the rendered budget, and they
 *   assert the three cards render the SAME text for the same answer — the
 *   done-means is "the same budget the Pi card reports", so the Pi card is read
 *   in the same file rather than assumed;
 * - the BYO arms are the negative control in every direction DA1.44 and review
 *   R1 found (another host, a CLI-prefix sibling, a chat-base SUBPATH, no
 *   connection): the answer is the runtime's own, and NO request is made, so no
 *   `Nestor-Token` can travel to an endpoint that was never asked;
 * - the typed arms drive the real `chat('/quota')` through the
 *   `BaseAgent.chat` seam, which is how the command actually arrives (DA1.57);
 * - the Stop arms die if the read is bound only to its ten-second timeout.
 *
 * ## Why the CONNECTION and not `runtime.baseUrl`
 *
 * `PiAgent.describeQuota` reads `getBackendRuntime(this.config).baseUrl`, and
 * copying that here would have been wrong in a way that passes a typecheck:
 * `backend/internal/drivers/codex.ts` says in as many words that it sets no
 * `baseUrl` on the runtime payload, so every codex session would have answered
 * "not the gateway". The connection's own `baseUrl` through
 * `isNessyGatewayBaseUrl` is the value `offersNestorQuota` reads, so the menu and
 * this answer cannot disagree.
 *
 * The connections are written into this PROCESS's isolated config dir through the
 * real storage API rather than mocked, so nothing here can amputate
 * `config/storage.ts` for a neighbouring suite. The transport seam
 * (`quotaTransport`) keeps every read off the live gateway and every credential
 * read on a temp file — never `~/.nessy/dp_auth_creds.json`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '@nessy-agent/core/types';
import { NESTOR_CLI_BASE_PREFIX } from '../../auth/nestor.ts';
import { makeTestJwt } from '../../auth/dp/__tests__/test-jwt.ts';
import { AbortReason } from '../core/index.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import { addLlmConnection, getLlmConnection, type LlmConnection } from '../../config/storage.ts';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { CodexAgent } from '../codex-agent.ts';
import { PiAgent } from '../pi-agent.ts';
import { collectEvents } from './test-utils.ts';

const BASE_MESSAGE = 'Quota is not available on this runtime.';
/** `null` when this file created `config.json`; the previous bytes otherwise. */
let previousConfigJson: string | null = null;
const GATEWAY_SLUG = 'f16-gateway';
const BYO_SLUG = 'f16-byo';
/**
 * DA1.44 — a BYO endpoint ON the gateway HOST, under the `…/api/v1/cli/` prefix
 * but NOT at a named gateway endpoint. DA1.10 measured that such a connection
 * receives no dp JWT at all, so it spends its own key against its own endpoint.
 */
const ON_PREFIX_BYO_SLUG = 'f16-on-prefix-byo';
const ON_PREFIX_BYO_URL = `${NESTOR_CLI_BASE_PREFIX}personal/v1`;
/** The chat base itself — the one URL a one-click gateway card writes. */
const GATEWAY_URL = `${NESTOR_CLI_BASE_PREFIX}openai-like/v1`;
/**
 * Review R1 (2026-09-17) — a SUBPATH of the chat base, the shape the REQUEST-url
 * predicate accepts and the CONNECTION rule must refuse.
 */
const CHAT_BASE_SUBPATH_BYO_SLUG = 'f16-chat-base-subpath-byo';
const CHAT_BASE_SUBPATH_BYO_URL = `${GATEWAY_URL}/pi_compat`;
const QUOTA_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/quota';

// DA1.50 · the creds fixture must DECODE; the value is fabricated.
const FIXTURE_JWT = makeTestJwt({ preferred_username: 'tester', sub: 'user-f16' });
const ALLOWED_MESSAGE = 'Запросы доступны. Возможны ограничения при высокой нагрузке';
const QUOTA_BODY = {
  schema_version: '1.0',
  generated_at: '2026-09-23T09:00:00Z',
  limits: [{
    id: 'token-usage',
    display: { title: 'Бюджет использования токенов' },
    scope: { type: 'mode', values: ['default'] },
    usage: 0.25,
    status: { state: 'allowed', severity: 'info', message: ALLOWED_MESSAGE },
    reset_at: '2026-09-24T08:00:00Z',
  }],
};

function connection(slug: string, baseUrl: string, providerType: LlmConnection['providerType']): LlmConnection {
  return {
    slug,
    name: slug,
    providerType,
    authType: 'api_key_with_endpoint',
    baseUrl,
    models: [],
  } as unknown as LlmConnection;
}

beforeAll(() => {
  // The isolated config dir starts EMPTY and `addLlmConnection` refuses to
  // create the file, warning to stderr and returning — so without this the
  // connections are never written and every case reads "no connection", i.e.
  // passes the negatives and fails the positives for the wrong reason. The
  // controls after the writes turn that into a loud failure.
  mkdirSync(CONFIG_DIR, { recursive: true });
  const configPath = join(CONFIG_DIR, 'config.json');
  previousConfigJson = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
  if (previousConfigJson === null) {
    writeFileSync(configPath, JSON.stringify({ storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null }), 'utf-8');
  }
  addLlmConnection(connection(GATEWAY_SLUG, GATEWAY_URL, 'claude-runtime'));
  addLlmConnection(connection(BYO_SLUG, 'https://api.deepseek.com/v1', 'claude-runtime'));
  addLlmConnection(connection(ON_PREFIX_BYO_SLUG, ON_PREFIX_BYO_URL, 'claude-runtime'));
  addLlmConnection(connection(CHAT_BASE_SUBPATH_BYO_SLUG, CHAT_BASE_SUBPATH_BYO_URL, 'claude-runtime'));
  expect(getLlmConnection(GATEWAY_SLUG)?.baseUrl).toBe(GATEWAY_URL);
  expect(getLlmConnection(BYO_SLUG)?.baseUrl).toBe('https://api.deepseek.com/v1');
  expect(getLlmConnection(ON_PREFIX_BYO_SLUG)?.baseUrl).toBe(ON_PREFIX_BYO_URL);
  expect(ON_PREFIX_BYO_URL.startsWith(NESTOR_CLI_BASE_PREFIX)).toBe(true);
  expect(getLlmConnection(CHAT_BASE_SUBPATH_BYO_SLUG)?.baseUrl).toBe(CHAT_BASE_SUBPATH_BYO_URL);
  expect(CHAT_BASE_SUBPATH_BYO_URL.startsWith(`${GATEWAY_URL}/`)).toBe(true);
});

/**
 * Put the file back byte-for-byte (or remove the one this file created), rather
 * than calling `deleteLlmConnection`, which reaches the credential manager and
 * throws in a bare test process.
 */
afterAll(() => {
  if (previousConfigJson === null) {
    rmSync(join(CONFIG_DIR, 'config.json'), { force: true });
    return;
  }
  writeFileSync(join(CONFIG_DIR, 'config.json'), previousConfigJson, 'utf-8');
});

function config(slug: string | undefined, provider: 'anthropic' | 'codex-runtime'): BackendConfig {
  return {
    provider,
    providerType: provider === 'anthropic' ? 'claude-runtime' : 'codex-runtime',
    ...(slug ? { connectionSlug: slug } : {}),
    isHeadless: true,
    workspace: {
      id: 'ws-f16',
      name: 'F1.6 Workspace',
      rootPath: '/tmp/nessy-f16',
      workspaceRootPath: '/tmp/nessy-f16',
      sessionRootPath: '/tmp/nessy-f16/sessions',
    },
    session: {
      id: 'session-f16',
      workspaceRootPath: '/tmp/nessy-f16',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    },
  } as unknown as BackendConfig;
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}
type Answer = (init?: RequestInit) => Response | Promise<Response>;
type QuotaFixture = { readonly fetchCalls: FetchCall[] };

/** A creds file the auth builder accepts, on a temp path — never `~/.nessy`. */
function tempCredsPath(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'f16-quota-creds-')), 'dp_auth_creds.json');
  writeFileSync(path, JSON.stringify({
    jwt: FIXTURE_JWT,
    expiresAt: Date.now() + 3_600_000,
    username: 'tester',
    userId: 'user-f16',
  }));
  return path;
}

function recordingTransport(calls: FetchCall[], answer: Answer): { fetchImpl: typeof fetch; credsPath: string } {
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer(init);
  }) as unknown as typeof fetch;
  return { fetchImpl, credsPath: tempCredsPath() };
}

const jsonAnswer: Answer = () => new Response(JSON.stringify(QUOTA_BODY), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

/** Never answers until the read is aborted — the Stop arms' transport. */
const hangingAnswer: Answer = init => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => {
    reject(new DOMException('The operation was aborted.', 'AbortError'));
  });
});

class FixtureClaudeAgent extends ClaudeAgent implements QuotaFixture {
  readonly fetchCalls: FetchCall[] = [];
  constructor(config: BackendConfig, private readonly quotaAnswer: Answer = jsonAnswer) {
    super(config);
  }
  protected override quotaTransport(): { fetchImpl: typeof fetch; credsPath?: string } {
    return recordingTransport(this.fetchCalls, this.quotaAnswer);
  }
}

class FixtureCodexAgent extends CodexAgent implements QuotaFixture {
  readonly fetchCalls: FetchCall[] = [];
  constructor(config: BackendConfig, private readonly quotaAnswer: Answer = jsonAnswer) {
    super(config);
  }
  protected override quotaTransport(): { fetchImpl: typeof fetch; credsPath?: string } {
    return recordingTransport(this.fetchCalls, this.quotaAnswer);
  }
}

/** The Pi gateway card — the reference the other two must agree with. */
class FixturePiAgent extends PiAgent implements QuotaFixture {
  readonly fetchCalls: FetchCall[] = [];
  constructor(config: BackendConfig, private readonly quotaAnswer: Answer = jsonAnswer) {
    super(config);
  }
  protected override quotaTransport(): { fetchImpl: typeof fetch; credsPath?: string } {
    return recordingTransport(this.fetchCalls, this.quotaAnswer);
  }
}

function piGatewayConfig(): BackendConfig {
  return {
    ...config(undefined, 'anthropic'),
    provider: 'pi',
    providerType: 'pi_compat',
    runtime: { baseUrl: GATEWAY_URL },
  } as unknown as BackendConfig;
}

/**
 * `describeQuota` is `protected`, and it is the unit the READ arms test; the
 * typed arms below drive the seam that routes a `/quota` into it.
 */
async function quotaEvents(agent: { destroy(): void }): Promise<AgentEvent[]> {
  try {
    return await collectEvents((agent as unknown as {
      describeQuota(): AsyncGenerator<AgentEvent>
    }).describeQuota());
  } finally {
    agent.destroy();
  }
}

function onlyInfo(events: AgentEvent[]): string {
  expect(events.map(event => event.type)).toEqual(['info']);
  const [info] = events;
  return info && info.type === 'info' ? info.message : '';
}

function expectOneGatewayRead(agent: QuotaFixture): void {
  expect(agent.fetchCalls).toHaveLength(1);
  const [call] = agent.fetchCalls;
  expect(call?.url).toBe(QUOTA_URL);
  expect(call?.init?.method).toBe('GET');
  expect((call?.init?.headers as Record<string, string> | undefined)?.['Nestor-Token']).toBe(FIXTURE_JWT);
  expect(call?.init?.signal).toBeInstanceOf(AbortSignal);
}

describe('F1.6 · the two non-Pi gateway cards READ the gateway budget', () => {
  it('claude-gateway: one GET of the quota route, rendered as the budget', async () => {
    const agent = new FixtureClaudeAgent(config(GATEWAY_SLUG, 'anthropic'));
    const message = onlyInfo(await quotaEvents(agent));

    expectOneGatewayRead(agent);
    expect(message).toContain('Quota:');
    expect(message).toContain('75% remaining');
    expect(message).toContain(ALLOWED_MESSAGE);
    expect(message).toContain('2026-09-24T08:00:00Z');
    // The refusal is GONE on this card, not merely followed by a number.
    expect(message).not.toContain(BASE_MESSAGE);
  });

  it('codex-gateway: the same read — and not the codex-native null', async () => {
    const agent = new FixtureCodexAgent(config(GATEWAY_SLUG, 'codex-runtime'));
    const message = onlyInfo(await quotaEvents(agent));

    expectOneGatewayRead(agent);
    expect(message).toContain('Quota:');
    expect(message).toContain('75% remaining');
    // The null is about codex's OWN account family, which this card never
    // uses; the budget it spends is the gateway's, and that is what it shows.
    expect(message).not.toContain('codex account');
    expect(message).not.toContain(BASE_MESSAGE);
  });

  it('F1.7 NEGATIVE CONTROL — codex-gateway with a live app-server naming a ChatGPT account: still the gateway budget, and codex is asked nothing', async () => {
    // The gateway card spends the GATEWAY's budget, whatever account codex
    // might report; the subscription windows (F1.7) are for a card whose turns
    // spend the subscription. So the gateway branch decides first and the live
    // client is never asked — a reader that consulted codex here would show a
    // budget this session does not spend.
    const agent = new FixtureCodexAgent(config(GATEWAY_SLUG, 'codex-runtime'));
    const asked: string[] = [];
    (agent as unknown as { client: unknown }).client = {
      async request(method: string) {
        asked.push(method);
        return method === 'account/read'
          ? { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true }
          : { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: null } } };
      },
    };
    let message = '';
    try {
      message = onlyInfo(await collectEvents((agent as unknown as {
        describeQuota(): AsyncGenerator<AgentEvent>
      }).describeQuota()));
    } finally {
      (agent as unknown as { client: unknown }).client = null;
      agent.destroy();
    }

    expectOneGatewayRead(agent);
    expect(message).toContain('75% remaining');
    expect(message).not.toContain('Codex usage windows');
    expect(asked).toEqual([]);
  });

  it('all three gateway cards render the SAME budget for the same answer (the Pi card is the reference)', async () => {
    const pi = new FixturePiAgent(piGatewayConfig());
    const piMessage = onlyInfo(await quotaEvents(pi));
    const claudeMessage = onlyInfo(await quotaEvents(new FixtureClaudeAgent(config(GATEWAY_SLUG, 'anthropic'))));
    const codexMessage = onlyInfo(await quotaEvents(new FixtureCodexAgent(config(GATEWAY_SLUG, 'codex-runtime'))));

    // Control: the Pi card really read the gateway, so the equality below is
    // an equality of READINGS and not of two refusals.
    expectOneGatewayRead(pi);
    expect(piMessage).toContain('75% remaining');
    expect(claudeMessage).toBe(piMessage);
    expect(codexMessage).toBe(piMessage);
  });
});

describe('F1.6 · NEGATIVE CONTROLS — a BYO card reads nothing and keeps its own answer', () => {
  const byoCases = [
    ['another host', BYO_SLUG],
    ['a CLI-prefix sibling on the gateway host (DA1.44)', ON_PREFIX_BYO_SLUG],
    ['a SUBPATH of the chat base (review R1)', CHAT_BASE_SUBPATH_BYO_SLUG],
    ['no connection at all', undefined],
  ] as const;

  for (const [label, slug] of byoCases) {
    it(`claude, ${label}: the base refusal, and no request`, async () => {
      const agent = new FixtureClaudeAgent(config(slug, 'anthropic'));
      const message = onlyInfo(await quotaEvents(agent));

      expect(message).toBe(BASE_MESSAGE);
      // The load-bearing half: no request, so no `Nestor-Token` can reach an
      // endpoint that was never asked.
      expect(agent.fetchCalls).toHaveLength(0);
    });

    it(`codex, ${label}: the codex-native null, and no request`, async () => {
      const agent = new FixtureCodexAgent(config(slug, 'codex-runtime'));
      const message = onlyInfo(await quotaEvents(agent));

      expect(message).toContain(BASE_MESSAGE);
      expect(message).toContain('codex account');
      expect(message).not.toContain('Quota:');
      expect(agent.fetchCalls).toHaveLength(0);
    });
  }
});

/**
 * DA1.57's arm, kept and flipped: a TYPED `/quota` through the real `chat()`.
 * `BaseAgent.chat` answers a session command before `chatImpl` is entered, so
 * nothing here spawns a runtime; the transport seam keeps the read local.
 */
describe('F1.6 · a TYPED /quota reads the budget on both gateway cards', () => {
  async function typedQuota(agent: { chat(message: string): AsyncGenerator<AgentEvent>; destroy(): void }): Promise<AgentEvent[]> {
    try {
      return await collectEvents(agent.chat('/quota'));
    } finally {
      agent.destroy();
    }
  }

  it('claude-gateway: the seam answers with the budget', async () => {
    const agent = new FixtureClaudeAgent(config(GATEWAY_SLUG, 'anthropic'));
    const events = await typedQuota(agent);

    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    const [info] = events;
    expect(info && info.type === 'info' ? info.message : '').toContain('75% remaining');
    expectOneGatewayRead(agent);
  });

  it('codex-gateway: the seam answers with the budget', async () => {
    const agent = new FixtureCodexAgent(config(GATEWAY_SLUG, 'codex-runtime'));
    const events = await typedQuota(agent);

    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    const [info] = events;
    expect(info && info.type === 'info' ? info.message : '').toContain('75% remaining');
    expectOneGatewayRead(agent);
  });

  it('NEGATIVE CONTROL: a BYO claude connection reaches the same seam and reads nothing', async () => {
    const agent = new FixtureClaudeAgent(config(BYO_SLUG, 'anthropic'));
    const events = await typedQuota(agent);

    expect(events.map(event => event.type)).toEqual(['info', 'complete']);
    const [info] = events;
    expect(info && info.type === 'info' ? info.message : '').toBe(BASE_MESSAGE);
    expect(agent.fetchCalls).toHaveLength(0);
  });
});

/**
 * Stop must cancel the read, as it does on Pi: `/quota` answers outside any
 * turn, so there is no turn controller to hang off. `SessionManager` stops a
 * session with `forceAbort(AbortReason.UserStop)`; `destroy()` must cancel too.
 */
describe('F1.6 · Stop cancels an in-flight gateway read instead of waiting out the timeout', () => {
  async function stoppedMidRead(
    agent: QuotaFixture & { chat(message: string): AsyncGenerator<AgentEvent>; destroy(): void },
    stop: () => void,
  ): Promise<string> {
    try {
      const collected = collectEvents(agent.chat('/quota'));
      for (let i = 0; i < 200 && agent.fetchCalls.length === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      expect(agent.fetchCalls).toHaveLength(1);
      stop();
      const events = await collected;
      expect(events.map(event => event.type)).toEqual(['info', 'complete']);
      const [info] = events;
      return info && info.type === 'info' ? info.message : '';
    } finally {
      agent.destroy();
    }
  }

  it('claude-gateway: forceAbort(UserStop) answers "cancelled"', async () => {
    const agent = new FixtureClaudeAgent(config(GATEWAY_SLUG, 'anthropic'), hangingAnswer);
    expect(await stoppedMidRead(agent, () => agent.forceAbort(AbortReason.UserStop))).toContain('cancelled');
  });

  it('codex-gateway: forceAbort(UserStop) answers "cancelled"', async () => {
    const agent = new FixtureCodexAgent(config(GATEWAY_SLUG, 'codex-runtime'), hangingAnswer);
    expect(await stoppedMidRead(agent, () => agent.forceAbort(AbortReason.UserStop))).toContain('cancelled');
  });

  it('claude-gateway: destroy() cancels it too', async () => {
    const agent = new FixtureClaudeAgent(config(GATEWAY_SLUG, 'anthropic'), hangingAnswer);
    expect(await stoppedMidRead(agent, () => agent.destroy())).toContain('cancelled');
  });

  it('codex-gateway: destroy() cancels it too', async () => {
    const agent = new FixtureCodexAgent(config(GATEWAY_SLUG, 'codex-runtime'), hangingAnswer);
    expect(await stoppedMidRead(agent, () => agent.destroy())).toContain('cancelled');
  });
});
