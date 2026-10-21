/**
 * C3.364 — codex's background tier runs on the resolved mini model, not on the
 * session model.
 *
 * ## What was measured (RS-21 / C5.16, and re-read at HEAD 2026-09-12)
 *
 * `BaseAgent.generateTitle` and `regenerateTitle` are the only title path on
 * every runtime, and both funnel into `runMiniCompletion(prompt)`, which takes
 * NO model argument. So whatever a backend's `runMiniCompletion` passes to
 * `queryLlm` is the model a title is billed at. codex passed `{ prompt }` alone,
 * and `CodexAgent.queryLlm`'s `request.model || this._model` then picked the
 * SESSION model — while `config.miniModel`, already resolved and already on the
 * same config, was used by this file only for `[agents]
 * default_subagent_model`.
 *
 * The other two arms, for the parity this row closes:
 *
 *  - claude — `claude-agent.ts` symbol `runMiniCompletion` throws unless
 *    `config.miniModel` is set, so a title there can only run cheap;
 *  - pi — `packages/pi-agent-server/src/index.ts` symbol `queryLlm` defaults to
 *    `config.miniModel` inside the subprocess.
 *
 * ## Why the assertions sit on `queryLlm`'s REQUEST
 *
 * `queryLlm` is the seam the model decision crosses, and it is the last point
 * before the request leaves for the upstream — `CodexAgent.queryLlm` posts
 * straight to the gateway through `postChat`, bypassing the codex binary
 * entirely, so no catalogue of codex's own can rewrite the id afterwards. A
 * stub there reads exactly what the upstream would have been sent.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { NESSY_GATEWAY_CHAT_BASE_URL } from '../backend/internal/drivers/upstream-target.ts';
import type { LLMQueryRequest, LLMQueryResult } from '../llm-tool.ts';
import { CodexAgent } from '../codex-agent.ts';

const SESSION_MODEL = 'codex/session-flagship';
const MINI_MODEL = 'codex/cheap-fast';

function createConfig(miniModel?: string): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: SESSION_MODEL,
    ...(miniModel ? { miniModel } : {}),
    isHeadless: true,
  } as BackendConfig;
}

/**
 * Replace `queryLlm` and record every request it receives. The real one needs an
 * upstream, a JWT and a live `postChat`; the model decision this row is about
 * happens entirely on THIS side of it.
 */
function recordQueryLlm(agent: CodexAgent, text = 'Cheap Title Here'): LLMQueryRequest[] {
  const seen: LLMQueryRequest[] = [];
  (agent as any).queryLlm = async (request: LLMQueryRequest): Promise<LLMQueryResult> => {
    seen.push(request);
    return { text, model: request.model ?? SESSION_MODEL };
  };
  return seen;
}

describe('C3.364 — the codex background tier picks the mini model', () => {
  it('POSITIVE — a title request carries the resolved mini model, not the session model', async () => {
    const agent = new CodexAgent(createConfig(MINI_MODEL));
    const seen = recordQueryLlm(agent);

    const title = await agent.generateTitle('please refactor the payment retry ladder');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe(MINI_MODEL);
    // The regression this row exists for: the flagship must not appear at all.
    expect(seen[0]?.model).not.toBe(SESSION_MODEL);
    // …and the title itself still comes back, so the cheap model is not bought
    // by breaking the feature.
    expect(title).toBe('Cheap Title Here');

    agent.destroy();
  });

  it('POSITIVE — the refresh-title path takes the same model', async () => {
    // `regenerateTitle` is a second entry point into the same
    // `runMiniCompletion`; asserting only `generateTitle` would leave the
    // manual "regenerate title" menu item unpinned.
    const agent = new CodexAgent(createConfig(MINI_MODEL));
    const seen = recordQueryLlm(agent);

    await agent.regenerateTitle(['first ask', 'second ask'], 'the assistant answered');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe(MINI_MODEL);

    agent.destroy();
  });

  it('BOUNDARY — with no mini model resolved the request names NO model, so the session model still answers', async () => {
    // The pre-C3.364 behaviour, kept exactly: codex has no third id to invent,
    // and claude's throw is not portable to a fire-and-forget title. Asserting
    // the ABSENCE of the key rather than its value is the point — `queryLlm`'s
    // own `request.model || this._model` is what must stay in charge.
    const agent = new CodexAgent(createConfig());
    const seen = recordQueryLlm(agent);

    await agent.generateTitle('a session with no cheap model on its connection');

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('model');

    agent.destroy();
  });

  it('BOUNDARY — a blank or whitespace-only mini model is treated as absent', async () => {
    // `config.miniModel` is resolved host-side as
    // `getMiniModel(connection) ?? connection.defaultModel`, and a connection
    // can carry a blank string. Sending `model: ''` would reach the upstream as
    // a request for a model named nothing.
    const agent = new CodexAgent(createConfig('   '));
    const seen = recordQueryLlm(agent);

    await agent.generateTitle('whitespace should not become a model id');

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('model');

    agent.destroy();
  });

  it('CONTROL — the mini model reaches the request only through this path, and a failure still yields null', async () => {
    // Two controls in one: the stub proves it is reached (above), and a
    // throwing `queryLlm` proves the row did not turn a fire-and-forget title
    // into a rejection at the caller — `runMiniCompletion` swallows and returns
    // null, which `validateTitle` turns into a null title.
    const agent = new CodexAgent(createConfig(MINI_MODEL));
    (agent as any).queryLlm = async () => { throw new Error('upstream refused'); };

    expect(await agent.generateTitle('anything')).toBeNull();

    agent.destroy();
  });
});

/**
 * UB12.37 — a LIVE codex session's background tier follows a gateway `fast`
 * rotation.
 *
 * The gateway's models are aliases and the id behind `fast` rotates; a retired
 * id answers 404 (AGENTS.md, Gateway Facts). The host resolved
 * `config.miniModel` once, when it built the agent, and a catalogue refresh
 * reaches a live codex session through `SessionManager.runAgentRuntimeRefresh`
 * → `CodexAgent.updateRuntimeConfig`, whose envelope carries the re-resolved id
 * since UB12.11. The model-only branch read `update.model` alone, so every later
 * title kept asking for the build-time id until a respawn.
 *
 * The update is shaped the way the refresh sends it on the gateway card: the
 * connection's own base URL rides along and maps to the pinned nestor upstream,
 * so the update is still model-only.
 */
describe('UB12.37 — a model-only update carries the re-resolved mini model into the next title', () => {
  const FAST_RETIRED = 'codex/fast-retired';
  const FAST_CURRENT = 'codex/fast-current';

  it('POSITIVE — after a rotated fast id arrives on a model-only update, the next title requests the new id', async () => {
    const agent = new CodexAgent(createConfig(FAST_RETIRED));
    const seen = recordQueryLlm(agent);

    const applied = await agent.updateRuntimeConfig({
      model: SESSION_MODEL,
      miniModel: FAST_CURRENT,
      runtime: { baseUrl: NESSY_GATEWAY_CHAT_BASE_URL },
    });
    await agent.generateTitle('a title after the catalogue refresh');

    // Applied in place — the session is not recreated for a mini-model rotation.
    expect(applied).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe(FAST_CURRENT);

    agent.destroy();
  });

  it('NEGATIVE — a model-only update without a mini model keeps the built one', async () => {
    // An older host, or a connection whose resolution answers nothing, sends no
    // `miniModel`: absent means unchanged (the `BackendRuntimeUpdate` contract
    // Pi follows), never "clear it" — clearing would put titles on the
    // flagship session model.
    const agent = new CodexAgent(createConfig(FAST_RETIRED));
    const seen = recordQueryLlm(agent);

    expect(await agent.updateRuntimeConfig({ model: 'codex/session-other' })).toBe(true);
    await agent.generateTitle('a title after a plain model switch');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe(FAST_RETIRED);

    agent.destroy();
  });

  it('BOUNDARY — an update that is not model-only declines and adopts nothing; the recreate resolves a fresh one', async () => {
    // An endpoint move returns false, so the host disposes and rebuilds the
    // agent with a freshly resolved mini model. Adopting the id here first
    // would leave THIS (about to be discarded) agent pointed at a model of a
    // different upstream for any title that races the rebuild.
    const agent = new CodexAgent(createConfig(FAST_RETIRED));
    const seen = recordQueryLlm(agent);

    const applied = await agent.updateRuntimeConfig({
      model: SESSION_MODEL,
      miniModel: FAST_CURRENT,
      runtime: { baseUrl: 'https://example.invalid/v1' },
    });
    await agent.generateTitle('a title before the recreate');

    expect(applied).toBe(false);
    expect(seen[0]?.model).toBe(FAST_RETIRED);

    agent.destroy();
  });
});
