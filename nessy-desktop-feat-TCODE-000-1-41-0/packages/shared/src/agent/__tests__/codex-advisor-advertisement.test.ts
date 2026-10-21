/**
 * P3.28 — an advisor flip reaches codex WITHOUT a runtime restart.
 *
 * P3.13 raised the flip as a latency gap, reasoning that codex's tool list is
 * fixed at spawn. The subprocess's list is; the app-server's SURFACE is not —
 * `config/value/write` + `config/mcpServer/reload` re-spawns the MCP child and
 * the next turn on the SAME thread carries the new tool. That upstream half is
 * measured against the real binary in `codex-advisor-advertisement-e2e.test.ts`
 * (gated); this file pins OUR half of it.
 *
 * Six propositions, each separable:
 *
 * 1. **A flip re-advertises**, and what is written is the spec's own argv — not
 *    a second hand-built list that could disagree with what a spawn would emit.
 * 2. **BOTH directions**, because an advisor turned OFF must stop being
 *    advertised, and a one-directional refresh would pass test 1 forever.
 * 3. **No drift → NO requests.** This runs at the head of every turn; a version
 *    that fired unconditionally would re-spawn every configured MCP server on
 *    every message, which is a far larger regression than the gap it closes.
 * 4. **A failure leaves the recorded surface ALONE**, so the next turn retries
 *    rather than believing a refresh that never landed.
 * 5. **Production's own budget reaches the channel**, and a wedged call ends in
 *    bounded time whether or not the channel honours `timeoutMs`. Every other
 *    assertion here passes with the bound deleted.
 * 6. **No live runtime → nothing to correct.** The next spawn reads the setting
 *    itself, and a refresh against a dead client would be an error, not a fix.
 *
 * The storage module is mocked with a SPREAD and restored from functions
 * captured BEFORE the mock is installed — a bare `mock.module` amputates the
 * module for every later test file in the process, and restoring by re-spreading
 * the (already mutated) namespace re-installs the mocks permanently.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import * as realStorage from '../../config/storage.ts';

const originals = { getAdvisorEnabled: realStorage.getAdvisorEnabled };

let advisorEnabled = false;

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getAdvisorEnabled: () => advisorEnabled,
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => ({
    ...realStorage,
    getAdvisorEnabled: originals.getAdvisorEnabled,
  }));
});

const { CodexAgent, CODEX_ADVISOR_CONSULT_FLAG } = await import('../codex-agent.ts');
const { cleanupModeState } = await import('../mode-manager.ts');
import type { BackendConfig } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';

const WORKSPACE_ID = 'ws-advisor-ad';
const SESSION_ID = 'session-advisor-ad';
const SESSION_KEY: SessionKey = { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID };
const BRIDGE_PORT = 45_311;

/** Short enough that a wedged call is provable inside bun's own default timeout. */
const BUDGET_MS = 300;

interface Recorded { method: string; params: any; timeoutMs: number | undefined }

interface Harness {
  agent: any;
  requests: Recorded[];
  /** Drive the private seam directly, the way the re-fork's own tests do. */
  refresh: (timeoutMs?: number) => Promise<void>;
  advertised: () => boolean | null;
}

function createHarness(options: {
  /** What the live app-server is recorded as currently advertising. */
  advertised?: boolean | null;
  /** Methods that accept the request and never answer. */
  silent?: string[];
  /** Methods that reject outright. */
  refuse?: string[];
  /** Omit the session-mcp launcher path, i.e. a session with no spec to write. */
  withoutSessionServer?: boolean;
  /** Leave `client` null — no runtime is up. */
  withoutClient?: boolean;
  /** Drop the channel's own `timeoutMs`, the way a two-argument double does. */
  ignoreChannelTimeout?: boolean;
} = {}): Harness {
  cleanupModeState(SESSION_KEY);
  const requests: Recorded[] = [];
  const silent = new Set(options.silent ?? []);
  const refuse = new Set(options.refuse ?? []);

  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: {
      id: WORKSPACE_ID,
      name: 'Advisor Advertisement Workspace',
      rootPath: '/tmp/ws-advisor-ad-root',
      workspaceRootPath: '/tmp/ws-advisor-ad-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-advisor-ad',
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: '/tmp/ws-advisor-ad-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: options.withoutSessionServer
      ? { paths: {} }
      : { paths: { sessionServer: '/tmp/session-mcp-server.js', node: '/tmp/node' } },
  } as any;

  const agent: any = new CodexAgent(config);
  const client = {
    request(method: string, params: any, requestOptions?: { timeoutMs?: number }) {
      requests.push({ method, params, timeoutMs: requestOptions?.timeoutMs });
      if (refuse.has(method)) return Promise.reject(new Error(`${method} refused`));
      if (silent.has(method)) {
        // A double that HONOURS `timeoutMs` is the production channel: the real
        // client arms its own timer inside `request`, before the race's timer
        // exists, so a double that drops the option cannot see which one wins.
        const channelTimeoutMs = requestOptions?.timeoutMs;
        if (channelTimeoutMs === undefined) return new Promise<never>(() => {});
        return new Promise((_resolve, reject) => setTimeout(
          () => reject(new Error(`app-server request ${method} timed out after ${channelTimeoutMs}ms`)),
          channelTimeoutMs,
        ));
      }
      if (method === 'config/value/write') return Promise.resolve({ status: 'ok' });
      return Promise.resolve({});
    },
    notify() {},
    close() {},
  };

  // A channel that DROPS the option is not hypothetical — every two-argument
  // double in this tree is one — and it is the only way the race's own timer
  // can win, which is the branch the sentinel arms exist for.
  const channel = options.ignoreChannelTimeout
    ? { request: (method: string, params: any) => client.request(method, params), notify() {}, close() {} }
    : client;

  if (!options.withoutClient) agent.client = channel;
  agent.callbackBridge = { port: BRIDGE_PORT };
  // F1.116 — the recorded surface is the WHOLE argv now, not one boolean, so
  // the harness plants the argv a spawn in that advisor state would have
  // written and reads the boolean back out of it. Everything below this line is
  // untouched: the six propositions are properties of the advisor axis, and
  // this file stays the control that widening the comparison did not move it.
  // The flag is appended LAST because that is where `buildSessionMcpSpec` emits
  // it — an unchanged state must compare element-for-element identical, or
  // proposition 3 would fire on every turn.
  const recorded = options.advertised === undefined ? false : options.advertised;
  const spawnArgs: string[] = agent.buildSessionMcpSpec(BRIDGE_PORT)?.args ?? [];
  agent.sessionMcpAdvertisedArgs = recorded === null
    ? null
    : [
        ...spawnArgs.filter(arg => arg !== CODEX_ADVISOR_CONSULT_FLAG),
        ...(recorded ? [CODEX_ADVISOR_CONSULT_FLAG] : []),
      ];

  return {
    agent,
    requests,
    refresh: (timeoutMs?: number) => (timeoutMs === undefined
      ? agent.refreshSessionMcpAdvisorAdvertisement()
      : agent.refreshSessionMcpAdvisorAdvertisement(timeoutMs)),
    advertised: () => {
      const args: string[] | null = agent.sessionMcpAdvertisedArgs;
      return args === null ? null : args.includes(CODEX_ADVISOR_CONSULT_FLAG);
    },
  };
}

describe('P3.28 · the codex advisor surface is corrected at the head of a turn', () => {
  beforeEach(() => { advisorEnabled = false; });
  afterEach(() => cleanupModeState(SESSION_KEY));

  it('turning the advisor ON rewrites the session argv and reloads', async () => {
    advisorEnabled = true;
    const { agent, requests, refresh, advertised } = createHarness({ advertised: false });

    await refresh();

    expect(requests.map(r => r.method)).toEqual(['config/value/write', 'config/mcpServer/reload']);
    const write = requests[0]!;
    expect(write.params.keyPath).toBe('mcp_servers.session.args');
    expect(write.params.mergeStrategy).toBe('replace');
    expect(write.params.value).toContain(CODEX_ADVISOR_CONSULT_FLAG);
    // Not merely "contains the flag": the value is the WHOLE argv a spawn would
    // write, so a `replace` cannot truncate the surface down to one flag.
    expect(write.params.value).toEqual(agent.buildSessionMcpSpec(BRIDGE_PORT).args);
    expect(write.params.value).toContain('--external-standalone-only');
    expect(write.params.value).toContain('--host-callback-port');
    expect(advertised()).toBe(true);

    agent.destroy();
  });

  it('turning the advisor OFF removes the flag again', async () => {
    advisorEnabled = false;
    const { agent, requests, refresh, advertised } = createHarness({ advertised: true });

    await refresh();

    expect(requests.map(r => r.method)).toEqual(['config/value/write', 'config/mcpServer/reload']);
    expect(requests[0]!.params.value).not.toContain(CODEX_ADVISOR_CONSULT_FLAG);
    // The negative control for the assertion above: the rest of the argv is
    // still there, so "flag absent" means the flag and not an empty write.
    expect(requests[0]!.params.value).toContain('--external-standalone-only');
    expect(advertised()).toBe(false);

    agent.destroy();
  });

  it('an UNCHANGED setting sends nothing — this runs on every turn', async () => {
    for (const state of [true, false]) {
      advisorEnabled = state;
      const { agent, requests, refresh, advertised } = createHarness({ advertised: state });
      await refresh();
      expect(requests).toEqual([]);
      expect(advertised()).toBe(state);
      agent.destroy();
    }
  });

  it('hands PRODUCTION\'s budget to the channel rather than an unbounded call', async () => {
    advisorEnabled = true;
    const { agent, requests, refresh } = createHarness({ advertised: false });

    await refresh();

    // Not "a number" — a default that drifted to `undefined` restores the hang
    // this bound exists to prevent, and nothing else in this file would notice.
    for (const recorded of requests) {
      expect(recorded.timeoutMs).toBeGreaterThanOrEqual(5_000);
      expect(recorded.timeoutMs).toBeLessThanOrEqual(6_000);
    }

    agent.destroy();
  });

  /**
   * BOTH rows end on the RACE's sentinel, and that is the design rather than a
   * duplicate: `requestWithinDeadline` hands the channel the budget PLUS
   * `CODEX_DEADLINE_CHANNEL_MARGIN_MS`, so the sentinel wins even against a
   * channel that honours the option. What the two rows separate is whether the
   * bound survives a channel that DROPS `timeoutMs` — a two-argument transport,
   * which every double in this tree is and any future one might be. The other
   * exit, a channel that rejects for a reason that is not a deadline, is the
   * refused-reload row below.
   */
  it.each([
    ['a channel that honours the bound', false],
    ['a channel that drops the option entirely', true],
  ])('a wedged write ends in bounded time on %s, and records nothing', async (_label, ignoreChannelTimeout) => {
    advisorEnabled = true;
    const { agent, requests, refresh, advertised } = createHarness({
      advertised: false,
      silent: ['config/value/write'],
      ignoreChannelTimeout,
    });

    const started = performance.now();
    await refresh(BUDGET_MS);

    // The failure this exists for is a turn that never ends: `client.request`
    // settles on a matching response or on `close()`, so an app-server that
    // simply never answers would hold the head of every turn forever.
    expect(performance.now() - started).toBeLessThan(BUDGET_MS * 8);
    // The reload never ran, so the live surface is still the old one — and the
    // record must still say so, or the next turn skips a refresh that never
    // happened and the flip is lost until the next runtime start.
    expect(requests.map(r => r.method)).toEqual(['config/value/write']);
    expect(advertised()).toBe(false);

    agent.destroy();
  });

  it('a refused reload leaves the record alone too, so the next turn retries', async () => {
    advisorEnabled = true;
    const { agent, requests, refresh, advertised } = createHarness({
      advertised: false,
      refuse: ['config/mcpServer/reload'],
    });

    await refresh();

    expect(requests.map(r => r.method)).toEqual(['config/value/write', 'config/mcpServer/reload']);
    expect(advertised()).toBe(false);

    // The retry is the point of leaving it alone: a second pass on a healthy
    // channel completes the flip.
    agent.client = {
      request: (method: string, params: any) => { requests.push({ method, params, timeoutMs: undefined }); return Promise.resolve({}); },
      notify() {}, close() {},
    };
    await refresh();
    expect(advertised()).toBe(true);

    agent.destroy();
  });

  it('sends nothing when there is no live runtime or no session-MCP spec', async () => {
    advisorEnabled = true;

    const noClient = createHarness({ advertised: false, withoutClient: true });
    await noClient.refresh();
    expect(noClient.requests).toEqual([]);
    noClient.agent.destroy();

    // No recorded surface: a runtime that never wrote a spec has nothing to
    // re-advertise, and the next spawn reads the setting on its own.
    const unrecorded = createHarness({ advertised: null });
    await unrecorded.refresh();
    expect(unrecorded.requests).toEqual([]);
    expect(unrecorded.advertised()).toBeNull();
    unrecorded.agent.destroy();

    // A session with no launcher path builds no spec at all.
    const noSpec = createHarness({ advertised: false, withoutSessionServer: true });
    await noSpec.refresh();
    expect(noSpec.requests).toEqual([]);
    noSpec.agent.destroy();
  });
});
