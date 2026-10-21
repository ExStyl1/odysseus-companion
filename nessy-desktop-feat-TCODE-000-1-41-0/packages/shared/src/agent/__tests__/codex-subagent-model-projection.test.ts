/**
 * C3.373 — codex's first `spawn_agent` is refused on the projected
 * `default_subagent_model`.
 *
 * ## The cause, read at the source (strong tier), not inferred from the failure
 *
 * R6b measured it on packaged `70d269e46`: with `[agents] default_subagent_model
 * = "tgpt/qwen36-35b-a3b-fp8"` in the session's own `config.toml`, the FIRST
 * `spawn_agent` came back *"refused before an agent existed"*, the model's own
 * next sentence was *"The default model isn't available for subagents; retrying
 * with an explicit model"*, and the retry succeeded.
 *
 * `github.com/openai/codex` at `rust-v0.150.1`,
 * `core/src/tools/handlers/multi_agents_common.rs`:
 * `apply_requested_spawn_agent_model_overrides` folds this config key and the
 * spawn call's own `model` into ONE variable, and `find_spawn_agent_model_name`
 * then resolves it against
 * `models_manager.list_models(RefreshStrategy::Offline, …)` — codex's own
 * cached, auth-filtered OpenAI preset catalogue, read with no network — failing
 * with `FunctionCallError::RespondToModel("Unknown model … for spawn_agent.
 * Available models: …")`. **The provider actually serving the session is never
 * consulted**, so a gateway id cannot pass however well the gateway serves it.
 *
 * Two consequences that shaped the fix rather than decorating it:
 *
 *  1. It is not fatal — `RespondToModel` becomes a `function_call_output` with
 *     `success: false` and the turn continues — which is why one wasted call per
 *     session went unnoticed for as long as it did.
 *  2. The failure is not confined to gateway ids. An id codex's cache happens to
 *     hold from an earlier OpenAI-authenticated use would PASS the catalogue
 *     check and then run the child against `model_provider = nessy_gateway`
 *     with an id the gateway does not serve — a worse failure, one step later.
 *     That is why the operator's own override is declined on the same session
 *     rather than exempted from the guard.
 *
 * ## What is asserted here
 *
 * The guard, at the one predicate that decides it. `declaredCodexModelProvider`
 * is stubbed rather than driven through `getLlmConnection`, because the
 * connection plumbing behind it is P6.532's and already has its own tests; what
 * is new in this row is what the projection does with each of its two answers.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

const SESSION_MODEL = 'tgpt/deepseek-v4-flash-0731';
const GATEWAY_FAST_MODEL = 'tgpt/qwen36-35b-a3b-fp8';

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

/** `undefined` is the loopback pin — every install that declared nothing. */
function withDeclaredProvider(agent: CodexAgent, provider: string | undefined): void {
  (agent as any).declaredCodexModelProvider = () => provider;
}

function projection(agent: CodexAgent): { defaultSubagentModel?: string } {
  return (agent as any).codexDefaultSubagentModelOption();
}

function facts(agent: CodexAgent): string {
  return [...((agent as any).sessionFacts as Map<string, string>).values()].join('\n');
}

describe('C3.373 — the subagent-model projection against codex\'s own catalogue', () => {
  it('POSITIVE — a loopback-pinned session projects NO default_subagent_model', async () => {
    // The measured case. codex's documented default takes over — "spawned
    // agents inherit your current model" — which is the one id this session is
    // already known to serve.
    const agent = new CodexAgent(createConfig(GATEWAY_FAST_MODEL));
    withDeclaredProvider(agent, undefined);

    expect(projection(agent)).toEqual({});

    agent.destroy();
  });

  it('POSITIVE — the refusal SAYS so, naming the id and the reason, on the durable channel', async () => {
    // An absent key reads as "nothing was configured", which is the misreading
    // `hostAuthoredHookProjection` exists to prevent one row over. The session
    // fact is what a packaged build can still surface after electron-log's
    // transports are disabled.
    const agent = new CodexAgent(createConfig(GATEWAY_FAST_MODEL));
    withDeclaredProvider(agent, undefined);

    projection(agent);
    const text = facts(agent);

    expect(text).toContain(GATEWAY_FAST_MODEL);
    expect(text).toContain('cached OpenAI model catalogue');
    // The sentence must tell the user what happens INSTEAD, not only what does
    // not happen — otherwise it reads as a fault rather than as a fallback.
    expect(text).toContain('inherit');

    agent.destroy();
  });

  it('POSITIVE — a session that DECLARED one of codex\'s own providers still projects', async () => {
    // The guard is about whose catalogue the ids come from, not about disabling
    // the feature: a connection that declared codex's own provider is serving
    // OpenAI presets, which is exactly what `find_spawn_agent_model_name` can
    // resolve.
    const agent = new CodexAgent(createConfig('gpt-5-mini'));
    withDeclaredProvider(agent, 'openai');

    expect(projection(agent)).toEqual({ defaultSubagentModel: 'gpt-5-mini' });

    agent.destroy();
  });

  it('BOUNDARY — a loopback session with NO cheap model resolved says nothing at all', async () => {
    // Nothing was going to be projected either way, so a notice here would be a
    // sentence about a decision nobody made — the noise that teaches a reader to
    // stop reading the channel.
    const agent = new CodexAgent(createConfig());
    withDeclaredProvider(agent, undefined);

    expect(projection(agent)).toEqual({});
    expect(facts(agent)).not.toContain('default_subagent_model');

    agent.destroy();
  });

  it('CONTROL — the pre-existing equality refusal still stands on a declared session', async () => {
    // `codexDefaultSubagentModelOption`'s older discipline: a "cheap" model that
    // IS the session model is no cheaper, so codex keeps its own default. The
    // new guard must not have swallowed it — if it had, this would return the
    // session model and every declared session would gain a pointless key.
    const agent = new CodexAgent(createConfig(SESSION_MODEL));
    withDeclaredProvider(agent, 'openai');

    expect(projection(agent)).toEqual({});

    agent.destroy();
  });
});
