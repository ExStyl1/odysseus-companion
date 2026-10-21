/**
 * F1.736 — on a `claude-runtime` card (the Nessy Gateway card, and every BYO OpenAI-compatible card) the claude SIDE
 * child must run on a model the card serves.
 *
 * ## The defect, measured
 *
 * The 1.41.0 release sitting (SIT-v, claude-gateway, packaged `5896a66d2`) found `call_llm` unusable there: the default
 * call answered "There's an issue with the selected model (claude-haiku-4-5-20251001). It may not exist or you may not
 * have access to it." Traced through the REAL route this file drives:
 *
 * - the claude session's `call_llm` is `createLLMTool` (`llm-tool.ts`), whose handler fills an absent `model` with
 *   `getDefaultSummarizationModel()` — `claude-haiku-4-5-20251001`, a registry id — before it calls the backend;
 * - `ClaudeAgent.queryLlm` then honoured `request.model` as given, so the session's own mini model (which `/btw` and
 *   titles run on, and which is the gateway's `fast` alias there) was never consulted for `call_llm`;
 * - the per-session loopback adapter forwards the id verbatim (it maps no model), and the gateway answers 404 for an id
 *   it does not serve, which the CLI reports as the sentence above.
 *
 * Rig `work/wjcrity/` (vendored 2.1.267, the REAL loopback adapter the claude-runtime branch of `postInit` starts, a
 * fake OpenAI-compatible gateway serving only the `coder`/`fast` ids and answering 404 for any other). Before: the
 * default call and `haiku` reached the gateway as `claude-haiku-4-5-20251001`, `claude-sonnet-5` as itself, each 404,
 * then the CLI's own retry on `claude-opus-5`, 404 again — the call answered "There's an issue with the selected
 * model"; naming the card's own `tgpt/qwen36-35b-a3b-fp8` was refused by the tool as `Unknown model` before any
 * request; `/btw` and a title reached the gateway as the fast id and answered. After: the three failing calls reach it
 * as the fast id and answer; `/btw` and titles unchanged; the `Unknown model` refusal of a card id: F1.757, (f)/(g).
 *
 * ## What this file pins
 *
 * The model the side child's `query()` is spawned with, through the REAL `createLLMTool` handler and the REAL
 * `ClaudeAgent.queryLlm`, on a connection seeded through the real storage API (AGENTS.md: a module-body env assignment
 * isolates nothing, so the fixture's provider is asserted before any arm).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, setDefaultTimeout } from 'bun:test';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackendConfig } from '../backend/types.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import { addLlmConnection, getLlmConnection } from '../../config/storage.ts';
import { getMiniModel } from '../../config/llm-connections.ts';
import { getDefaultSummarizationModel } from '../../config/models.ts';
import { getSessionScopedTools, invalidateAllSessionToolsCaches } from '../session-scoped-tools.ts';

// Importing `claude-agent.ts` is this file's wall-clock cost; the cases are milliseconds (AGENTS.md: size the budget
// against the FILE, not the case).
setDefaultTimeout(120_000);

const realSdk = { ...sdkPackage };
const captured: Array<Record<string, unknown>> = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { prompt: unknown; options: Record<string, unknown> }) => {
    captured.push(input.options);
    return (async function* serveSide(): AsyncGenerator<unknown> {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'F1.736 ok' }] } };
      yield {
        type: 'result', subtype: 'success', result: 'F1.736 ok', num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
    })();
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const { ClaudeAgent, resolveClaudeRuntimeSideChildModel } = await import('../claude-agent.ts');
const { createLLMTool } = await import('../llm-tool.ts');

/** The two ids the live gateway publishes under its `coder` / `fast` aliases (AGENTS.md §Gateway Facts). */
const CODER = 'tgpt/deepseek-v4-flash-0731';
const FAST = 'tgpt/qwen36-35b-a3b-fp8';
const GATEWAY_SLUG = 'f1-736-gateway';
const DIRECT_SLUG = 'f1-736-direct';

const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const PRISTINE_CONFIG = { storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null };
let pristine = '';

beforeAll(() => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  pristine = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf-8') : JSON.stringify(PRISTINE_CONFIG, null, 2);
  writeFileSync(CONFIG_PATH, JSON.stringify(PRISTINE_CONFIG, null, 2), 'utf-8');
  expect(addLlmConnection({
    slug: GATEWAY_SLUG, name: 'F1.736 gateway-shaped card', providerType: 'claude-runtime',
    baseUrl: 'http://127.0.0.1:9/v1', authType: 'none', defaultModel: CODER,
    models: [
      { id: CODER, name: 'coder', shortName: 'coder' },
      { id: FAST, name: 'fast', shortName: 'fast' },
    ] as never,
  } as never)).toBe(true);
  expect(addLlmConnection({
    slug: DIRECT_SLUG, name: 'F1.736 direct Anthropic card', providerType: 'anthropic', authType: 'api_key',
    defaultModel: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  } as never)).toBe(true);
  // The fixture is what the arms say it is — asserted, not assumed.
  expect(getLlmConnection(GATEWAY_SLUG)?.providerType).toBe('claude-runtime');
  expect(getLlmConnection(DIRECT_SLUG)?.providerType).toBe('anthropic');
});

afterAll(() => {
  writeFileSync(CONFIG_PATH, pristine, 'utf-8');
});

afterEach(() => {
  captured.length = 0;
});

const WORKSPACE_ROOT = '/tmp/nessy-f1-736';
let counter = 0;
type SideAgent = InstanceType<typeof ClaudeAgent>;

/** A session agent built the way `SessionManager` builds it: `miniModel` is `getMiniModel(connection) ?? defaultModel`. */
function sessionAgent(slug: string, providerType: 'claude-runtime' | 'anthropic'): SideAgent {
  counter += 1;
  const connection = getLlmConnection(slug)!;
  return new ClaudeAgent({
    provider: 'anthropic',
    providerType,
    connectionSlug: slug,
    model: connection.defaultModel,
    miniModel: getMiniModel(connection) ?? connection.defaultModel,
    isHeadless: true,
    skipConfigWatcher: true,
    workspace: {
      id: 'ws-f1-736', name: 'F1.736', rootPath: WORKSPACE_ROOT, workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: `${WORKSPACE_ROOT}/sessions`,
    } as never,
    session: {
      id: `session-f1-736-${counter}`, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: WORKSPACE_ROOT,
    } as never,
    onBetweenTurnsEvent: () => {},
  } as BackendConfig);
}

type CallLlmTool = { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }> };

/** The model one REAL `call_llm` call (the claude session's `createLLMTool`) spawned its side child with. */
async function callLlmModel(slug: string, providerType: 'claude-runtime' | 'anthropic', args: Record<string, unknown>): Promise<unknown> {
  const agent = sessionAgent(slug, providerType);
  try {
    const tool = createLLMTool({ sessionId: 'f1-736', getQueryFn: () => request => agent.queryLlm(request) }) as unknown as CallLlmTool;
    const result = await tool.handler({ prompt: 'F1.736 side question', ...args }, {});
    expect(result.content[0]?.text).toBe('F1.736 ok');
    expect(captured).toHaveLength(1);
    return captured[0]!.model;
  } finally {
    agent.destroy();
  }
}

async function spawnedModel(slug: string, providerType: 'claude-runtime' | 'anthropic', spawn: (agent: SideAgent) => Promise<unknown>): Promise<unknown> {
  const agent = sessionAgent(slug, providerType);
  try {
    await spawn(agent);
    expect(captured).toHaveLength(1);
    return captured[0]!.model;
  } finally {
    agent.destroy();
  }
}

describe('F1.736 — a claude side child on a claude-runtime card runs on a model the card serves', () => {
  it('the fixture: the card mini model is the gateway fast id (what /btw and titles already run on)', () => {
    expect(getMiniModel(getLlmConnection(GATEWAY_SLUG)!)).toBe(FAST);
    // The id the tool falls back to is a registry id the card does not serve — the defect's input.
    expect(getDefaultSummarizationModel()).toBe('claude-haiku-4-5-20251001');
  });

  it('(a) call_llm with no model spawns the card fast model, not claude-haiku', async () => {
    expect(await callLlmModel(GATEWAY_SLUG, 'claude-runtime', {})).toBe(FAST);
  });

  it('(b) call_llm naming a Claude id the card does not serve (claude-sonnet-5, haiku) spawns the card fast model', async () => {
    expect(await callLlmModel(GATEWAY_SLUG, 'claude-runtime', { model: 'claude-sonnet-5' })).toBe(FAST);
    captured.length = 0;
    expect(await callLlmModel(GATEWAY_SLUG, 'claude-runtime', { model: 'haiku' })).toBe(FAST);
  });

  it('(c) CONTROL — a model the card serves is kept as asked (queryLlm, as the advisor calls it)', async () => {
    expect(await spawnedModel(GATEWAY_SLUG, 'claude-runtime', agent => agent.queryLlm({ prompt: 'F1.736', model: CODER }))).toBe(CODER);
  });

  it('(c2) the result names the EFFECTIVE model (the queryLlm contract), so a substitution is not silent', async () => {
    let reported: unknown;
    const spawned = await spawnedModel(GATEWAY_SLUG, 'claude-runtime', async agent => {
      reported = (await agent.queryLlm({ prompt: 'F1.736', model: 'claude-sonnet-5' })).model;
    });
    expect(spawned).toBe(FAST);
    expect(reported).toBe(FAST);
  });

  it('(d) CONTROL — /btw and titles keep the card mini model (unchanged)', async () => {
    expect(await spawnedModel(GATEWAY_SLUG, 'claude-runtime', agent => agent.askSideQuestion({ question: 'F1.736 btw', transcript: [] }))).toBe(FAST);
    captured.length = 0;
    expect(await spawnedModel(GATEWAY_SLUG, 'claude-runtime', agent => agent.runMiniCompletion('F1.736 title please'))).toBe(FAST);
  });

  it('(e) CONTROL — a direct Anthropic card is unchanged: call_llm keeps the registry default and a named model', async () => {
    expect(await callLlmModel(DIRECT_SLUG, 'anthropic', {})).toBe('claude-haiku-4-5-20251001');
    captured.length = 0;
    expect(await callLlmModel(DIRECT_SLUG, 'anthropic', { model: 'claude-sonnet-5' })).toBe('claude-sonnet-5');
  });
});

describe('F1.736 — resolveClaudeRuntimeSideChildModel (the rule, at its boundaries)', () => {
  const served = [CODER, FAST];
  it('keeps a served id, a served id carrying a [1m] selector, and the card mini model itself', () => {
    expect(resolveClaudeRuntimeSideChildModel({ requested: CODER, servedModels: served, miniModel: FAST })).toBe(CODER);
    expect(resolveClaudeRuntimeSideChildModel({ requested: `${CODER}[1m]`, servedModels: served, miniModel: FAST })).toBe(`${CODER}[1m]`);
    // An explicit connection `miniModel` the catalogue does not list is the person's choice (`getMiniModel` honours it).
    expect(resolveClaudeRuntimeSideChildModel({ requested: 'my-own-mini', servedModels: served, miniModel: 'my-own-mini' })).toBe('my-own-mini');
  });

  it('replaces an id the card does not serve with the card mini model', () => {
    expect(resolveClaudeRuntimeSideChildModel({ requested: 'claude-haiku-4-5-20251001', servedModels: served, miniModel: FAST })).toBe(FAST);
  });

  it('knows nothing, so changes nothing, with an empty catalogue or no mini model', () => {
    expect(resolveClaudeRuntimeSideChildModel({ requested: 'claude-haiku-4-5-20251001', servedModels: [], miniModel: FAST })).toBe('claude-haiku-4-5-20251001');
    expect(resolveClaudeRuntimeSideChildModel({ requested: 'claude-haiku-4-5-20251001', servedModels: served, miniModel: undefined })).toBe('claude-haiku-4-5-20251001');
  });
});

// F1.757 (origin WJ-crit-y P-WJcrity-1) — the tool's static-registry check refused the card's OWN ids as `Unknown model`,
// so the coder model could not be chosen through `call_llm` on a claude-runtime card (Pi's route forwards them).
describe('F1.757 — the claude session\'s call_llm accepts the ids its own card serves', () => {
  type RegisteredCallLlm = { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };
  /** The call_llm the claude session really registers (`getSessionScopedTools`), driven once. */
  async function registeredCallLlm(slug: string, providerType: 'claude-runtime' | 'anthropic', model: string): Promise<{ text: string; spawned: unknown }> {
    const agent = sessionAgent(slug, providerType);
    const sessionId = `session-f1-736-${counter}`;
    try {
      invalidateAllSessionToolsCaches();
      const server = getSessionScopedTools(sessionId, WORKSPACE_ROOT, 'ws-f1-736', WORKSPACE_ROOT) as unknown as {
        instance: { _registeredTools: Record<string, RegisteredCallLlm> };
      };
      const callLlm = server.instance._registeredTools.call_llm;
      if (!callLlm) throw new Error('no registered call_llm');
      const result = await callLlm.handler({ prompt: 'F1.757 side question', model }, {});
      return { text: result.content[0]?.text ?? '', spawned: captured[0]?.model };
    } finally {
      agent.destroy();
    }
  }

  it('(f) on a claude-runtime card, naming the card\'s coder or fast id runs that id', async () => {
    const coder = await registeredCallLlm(GATEWAY_SLUG, 'claude-runtime', CODER);
    expect(coder.text).toBe('F1.736 ok');
    expect(coder.spawned).toBe(CODER);
    captured.length = 0;
    const fast = await registeredCallLlm(GATEWAY_SLUG, 'claude-runtime', FAST);
    expect(fast.spawned).toBe(FAST);
  });

  it('(g) CONTROL — a direct Anthropic card keeps the friendly Unknown model list, and an unserved id still refuses on the gateway card', async () => {
    const direct = await registeredCallLlm(DIRECT_SLUG, 'anthropic', CODER);
    expect(direct.text).toContain(`Unknown model: "${CODER}"`);
    expect(direct.spawned).toBeUndefined();
    const unserved = await registeredCallLlm(GATEWAY_SLUG, 'claude-runtime', 'tgpt/not-on-this-card');
    expect(unserved.text).toContain('Unknown model: "tgpt/not-on-this-card"');
    expect(unserved.spawned).toBeUndefined();
  });
});
