/**
 * F1.598 (origin WJ-bl P-WJbl-1, 2026-09-24, DECIDE) — on the ChatGPT (Codex)
 * card the host's per-session web-search cap (`NESSY_MAX_WEB_SEARCHES_PER_SESSION`,
 * `config/web-search-budget.ts`) bounds nothing: F1.570 withholds the host's own
 * `web_search` there and codex's native search runs instead.
 *
 * Codex was read for a native bound first (`rust-v0.156.1`): `WebSearchToolConfig`
 * carries `context_size`, `allowed_domains` and `location`, and `WebSearchMode`
 * is `disabled`/`cached`/`indexed`/`live` (`protocol/src/config_types.rs`); the
 * search runs inside the Responses request and nothing in `core/src` counts
 * `WebSearchCall` items against a limit; `TurnStartParams` carries no per-turn
 * tool override. So there is no native bound to enable and no lever to stop the
 * search mid-thread. DECIDED: the host counts codex's own `webSearch` items on
 * that card (the main thread and every subagent thread it spawned) and, on the
 * first search past the cap, SAYS once, durably, that the cap does not stop them
 * and why. The CONTROL the row asks for: "a card session past the cap either
 * stops searching or says why it does not".
 *
 * WHAT EACH ARM KILLS: a notice before the cap is passed, a notice repeated
 * past it, a count fed by anything but a `webSearch` item start, a notice on a
 * card whose search is the host's (the gateway card), and a new thread (a
 * cleared conversation) that inherits the old count.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from '../../config/paths.ts';
import { addLlmConnection, getLlmConnection, type LlmConnection } from '../../config/storage.ts';
import { MAX_WEB_SEARCHES_PER_SESSION_ENV } from '../../config/web-search-budget.ts';
import type { BackendConfig } from '../backend/types.ts';
import {
  createCodexNativeWebSearchTally,
  describeCodexNativeWebSearchPastCap,
  isCodexWebSearchItemStart,
} from '../backend/codex/native-web-search-cap.ts';
import { CodexAgent } from '../codex-agent.ts';

const SEARCH = { threadId: 'thread-1', item: { type: 'webSearch', id: 'ws-1', query: 'q' } };

describe('F1.598 · the tally of codex\'s own searches', () => {
  it('counts only a webSearch item START', () => {
    expect(isCodexWebSearchItemStart('item/started', SEARCH)).toBe(true);
    expect(isCodexWebSearchItemStart('item/completed', SEARCH)).toBe(false);
    expect(isCodexWebSearchItemStart('item/started', { item: { type: 'commandExecution' } })).toBe(false);
    expect(isCodexWebSearchItemStart('item/started', undefined)).toBe(false);
  });

  it('says nothing up to the cap, says it once on the first search past it, and nothing after', () => {
    const tally = createCodexNativeWebSearchTally(2);
    expect(tally.note('item/started', SEARCH)).toBeNull();
    expect(tally.note('item/completed', SEARCH)).toBeNull();
    expect(tally.note('item/started', { item: { type: 'mcpToolCall' } })).toBeNull();
    expect(tally.note('item/started', SEARCH)).toBeNull();
    expect(tally.count()).toBe(2);
    expect(tally.note('item/started', SEARCH)).toBe(describeCodexNativeWebSearchPastCap(3, 2));
    expect(tally.note('item/started', SEARCH)).toBeNull();
    expect(tally.count()).toBe(4);
  });

  it('the limit is the host setting, read the way the host search reads it', () => {
    expect(createCodexNativeWebSearchTally(undefined, { [MAX_WEB_SEARCHES_PER_SESSION_ENV]: '7' }).limit).toBe(7);
    expect(createCodexNativeWebSearchTally(undefined, {}).limit).toBe(200);
  });

  it('the sentence names the count, the cap, the setting, and why the cap does not stop codex', () => {
    const sentence = describeCodexNativeWebSearchPastCap(201, 200);
    expect(sentence).toContain('201');
    expect(sentence).toContain('200');
    expect(sentence).toContain(MAX_WEB_SEARCHES_PER_SESSION_ENV);
    expect(sentence).toContain('no per-session limit');
    expect(sentence).toContain('not stopped');
  });
});

const CARD_SLUG = 'f1598-chatgpt-codex';
const GATEWAY_SLUG = 'f1598-codex-gateway';
const GATEWAY_URL = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';
let previousConfigJson: string | null = null;
let previousCap: string | undefined;

beforeAll(() => {
  previousCap = process.env[MAX_WEB_SEARCHES_PER_SESSION_ENV];
  delete process.env[MAX_WEB_SEARCHES_PER_SESSION_ENV];
  process.env[MAX_WEB_SEARCHES_PER_SESSION_ENV] = '2';
  mkdirSync(CONFIG_DIR, { recursive: true });
  const configPath = join(CONFIG_DIR, 'config.json');
  previousConfigJson = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
  if (previousConfigJson === null) {
    writeFileSync(configPath, JSON.stringify({ storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null }), 'utf-8');
  }
  addLlmConnection({
    slug: CARD_SLUG, name: 'ChatGPT (Codex)', providerType: 'codex-runtime', authType: 'oauth',
    codexModelProvider: 'openai', models: [], createdAt: 0,
  } as unknown as LlmConnection);
  addLlmConnection({
    slug: GATEWAY_SLUG, name: 'Codex (Nessy Gateway)', providerType: 'codex-runtime', authType: 'api_key_with_endpoint',
    baseUrl: GATEWAY_URL, models: [], createdAt: 0,
  } as unknown as LlmConnection);
  // The fixture controls: without them a lost write reads as "not the card".
  expect(getLlmConnection(CARD_SLUG)?.codexModelProvider).toBe('openai');
  expect(getLlmConnection(GATEWAY_SLUG)?.baseUrl).toBe(GATEWAY_URL);
});

afterAll(() => {
  delete process.env[MAX_WEB_SEARCHES_PER_SESSION_ENV];
  if (previousCap !== undefined) process.env[MAX_WEB_SEARCHES_PER_SESSION_ENV] = previousCap;
  if (previousConfigJson === null) {
    rmSync(join(CONFIG_DIR, 'config.json'), { force: true });
    return;
  }
  writeFileSync(join(CONFIG_DIR, 'config.json'), previousConfigJson, 'utf-8');
});

interface Pushed { type: string; message?: string; level?: string }

function harness(connectionSlug: string) {
  const agent = new CodexAgent({
    provider: 'codex-runtime', providerType: 'codex-runtime', connectionSlug, isHeadless: true,
    workspace: { id: 'ws-f1598', name: 'F1.598', rootPath: '/tmp/nessy-f1598', workspaceRootPath: '/tmp/nessy-f1598', sessionRootPath: '/tmp/nessy-f1598/sessions' },
    session: { id: 'session-f1598', workspaceRootPath: '/tmp/nessy-f1598', createdAt: Date.now(), lastUsedAt: Date.now() },
  } as unknown as BackendConfig);
  const pushed: Pushed[] = [];
  const internals = agent as unknown as {
    handleNotification: (method: string, params: unknown) => void;
    threadId: string | null;
    turnSink: { push: (event: Pushed) => void } | null;
    debug: (message: string) => void;
  };
  internals.debug = () => {};
  internals.threadId = 'thread-1';
  internals.turnSink = { push: event => { pushed.push(event); } };
  const notices = () => pushed.filter(event => event.type === 'info' && event.message?.includes(MAX_WEB_SEARCHES_PER_SESSION_ENV));
  const search = (id: string, threadId = 'thread-1') =>
    internals.handleNotification('item/started', { threadId, turnId: 'turn-1', item: { type: 'webSearch', id, query: 'q' } });
  return { agent, internals, notices, search, destroy: () => agent.destroy() };
}

describe('F1.598 · CodexAgent says so on the ChatGPT (Codex) card', () => {
  it('the card: one durable notice on the first search past the cap, none before and none after', () => {
    const h = harness(CARD_SLUG);
    try {
      h.search('ws-1');
      h.search('ws-2');
      expect(h.notices()).toEqual([]);
      h.search('ws-3');
      h.search('ws-4');
      expect(h.notices()).toEqual([
        { type: 'info', message: describeCodexNativeWebSearchPastCap(3, 2), level: 'warning' },
      ]);
    } finally { h.destroy(); }
  });

  it('a new thread (a cleared conversation) starts the count again', () => {
    const h = harness(CARD_SLUG);
    try {
      h.search('ws-1');
      h.search('ws-2');
      h.internals.threadId = 'thread-2';
      h.search('ws-3', 'thread-2');
      h.search('ws-4', 'thread-2');
      expect(h.notices()).toEqual([]);
      h.search('ws-5', 'thread-2');
      expect(h.notices()).toHaveLength(1);
    } finally { h.destroy(); }
  });

  it('a subagent thread this session spawned counts toward the same cap; a thread it did not spawn does not', () => {
    const h = harness(CARD_SLUG);
    try {
      h.internals.handleNotification('item/started', {
        threadId: 'thread-1', turnId: 'turn-1',
        item: { type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: ['child-1'] },
      });
      h.search('ws-1');
      h.search('ws-foreign-1', 'someone-elses-thread');
      h.search('ws-foreign-2', 'someone-elses-thread');
      h.search('ws-child-1', 'child-1');
      expect(h.notices()).toEqual([]);
      h.search('ws-child-2', 'child-1');
      expect(h.notices()).toHaveLength(1);
      expect(h.notices()[0]?.message).toBe(describeCodexNativeWebSearchPastCap(3, 2));
    } finally { h.destroy(); }
  });

  it('CONTROL: the gateway card, whose search is the host\'s own and capped there, gets no notice', () => {
    const h = harness(GATEWAY_SLUG);
    try {
      for (const id of ['ws-1', 'ws-2', 'ws-3', 'ws-4']) h.search(id);
      expect(h.notices()).toEqual([]);
    } finally { h.destroy(); }
  });
});
