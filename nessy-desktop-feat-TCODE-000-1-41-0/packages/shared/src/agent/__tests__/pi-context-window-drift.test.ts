/**
 * P3.43 — the context-window drift detector, and the proof it can fire.
 *
 * The premise first, because it is the whole row: `catalogContextWindow` read
 * the STATIC registry and nothing else, and the static registry has never heard
 * of a gateway or BYO id. `contextWindowDriftDiagnostic` returns `null` the
 * moment either side is unknown, so the detector was structurally dead on every
 * model the shipped default card serves — while firing correctly on the
 * registry ids nobody was worried about.
 *
 * Both directions are asserted here: the registry answering (the positive
 * control that proves the rig works) and the registry NOT answering (the state
 * the fix has to survive).
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';
import { getModelById } from '../../config/models.ts';
import { NESSY_GATEWAY_CHAT_BASE_URL } from '../backend/internal/drivers/upstream-target.ts';
import { nestorGatewayModelWindow } from '../../auth/nestor.ts';

const GATEWAY_MODEL = 'tgpt/qwen35-397b-a17b-fp8';
const REGISTRY_MODEL = 'nestor-cloud-code-agent';

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-drift',
      name: 'Drift Workspace',
      rootPath: '/tmp/nessy-drift-test',
      workspaceRootPath: '/tmp/nessy-drift-test',
      sessionRootPath: '/tmp/nessy-drift-test-sessions/ws-drift',
    } as any,
    session: {
      id: 'session-drift',
      workspaceRootPath: '/tmp/nessy-drift-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    ...overrides,
  };
}

/** Drive the private drift log with a runtime snapshot and collect what it said. */
function driftLines(agent: PiAgent, runtimeContextWindow: number, modelId: string): string[] {
  const lines: string[] = [];
  agent.onDebug = (message: string) => { lines.push(message); };
  (agent as any).logContextWindowDrift({ modelId, contextWindow: runtimeContextWindow });
  // `PiAgent.debug` prefixes every line with `[pi] `, so match on the body.
  return lines.filter(line => line.includes('Context window drift'));
}

describe('the premise: what the static registry can and cannot answer', () => {
  it('answers for a registry id and not for a gateway id', () => {
    // The positive control for every absence claim below.
    expect(getModelById(REGISTRY_MODEL)?.contextWindow).toBe(200_000);
    expect(getModelById(GATEWAY_MODEL)?.contextWindow).toBeUndefined();
  });
});

describe('PiAgent context-window drift detection', () => {
  it('fires for a gateway model whose window the connection catalogue carries', () => {
    const agent = new PiAgent(createConfig({
      model: GATEWAY_MODEL,
      runtime: {
        baseUrl: NESSY_GATEWAY_CHAT_BASE_URL,
        customModels: [{ id: GATEWAY_MODEL, contextWindow: 262_000 }],
      },
    }));

    expect((agent as any).catalogContextWindow).toBe(262_000);
    expect((agent as any).catalogContextWindowSource).toBe('provider_catalog');

    const lines = driftLines(agent, 131_072, GATEWAY_MODEL);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('catalog=262000 runtime=131072');
    expect(lines[0]).toContain('source=provider_catalog');
  });

  it('falls back to the shipped gateway table when the catalogue entry lost its window', () => {
    const preset = nestorGatewayModelWindow(GATEWAY_MODEL);
    expect(preset).toBeGreaterThan(0);

    const agent = new PiAgent(createConfig({
      model: GATEWAY_MODEL,
      runtime: {
        baseUrl: NESSY_GATEWAY_CHAT_BASE_URL,
        // A refresh that predates the table, or a hand-edited connection: the id
        // is there, the window is not.
        customModels: [GATEWAY_MODEL],
      },
    }));

    expect((agent as any).catalogContextWindow).toBe(preset);
    expect((agent as any).catalogContextWindowSource).toBe('preset');
    expect(driftLines(agent, 131_072, GATEWAY_MODEL)[0]).toContain('source=preset');
  });

  it('does not reach for the gateway table on a BYO endpoint that merely resembles it', () => {
    // Whole-URL match, never a prefix: a different path on the same host is a
    // different deployment that may serve a same-named id at a different window.
    const agent = new PiAgent(createConfig({
      model: GATEWAY_MODEL,
      runtime: {
        baseUrl: `${NESSY_GATEWAY_CHAT_BASE_URL}/../other/v1`,
        customModels: [GATEWAY_MODEL],
      },
    }));

    expect((agent as any).catalogContextWindow).toBeUndefined();
    expect((agent as any).catalogContextWindowSource).toBe('unavailable');
    expect(driftLines(agent, 131_072, GATEWAY_MODEL)).toEqual([]);
  });

  it('still fires from the static registry for an id the registry knows', () => {
    const agent = new PiAgent(createConfig({ model: REGISTRY_MODEL }));

    expect((agent as any).catalogContextWindow).toBe(200_000);
    expect((agent as any).catalogContextWindowSource).toBe('static_registry');
    expect(driftLines(agent, 131_072, REGISTRY_MODEL)[0])
      .toContain('catalog=200000 runtime=131072 source=static_registry');
  });

  it('stays silent when catalogue and runtime agree', () => {
    const agent = new PiAgent(createConfig({
      model: GATEWAY_MODEL,
      runtime: {
        baseUrl: NESSY_GATEWAY_CHAT_BASE_URL,
        customModels: [{ id: GATEWAY_MODEL, contextWindow: 262_000 }],
      },
    }));
    expect(driftLines(agent, 262_000, GATEWAY_MODEL)).toEqual([]);
  });

  it('re-resolves against the new model on setModel', () => {
    const agent = new PiAgent(createConfig({
      model: GATEWAY_MODEL,
      runtime: {
        baseUrl: NESSY_GATEWAY_CHAT_BASE_URL,
        customModels: [
          { id: GATEWAY_MODEL, contextWindow: 262_000 },
          { id: 'tgpt/qwen36-35b-a3b-fp8', contextWindow: 131_072 },
        ],
      },
    }));

    agent.setModel('tgpt/qwen36-35b-a3b-fp8');
    expect((agent as any).catalogContextWindow).toBe(131_072);
    expect((agent as any).catalogContextWindowSource).toBe('provider_catalog');
  });
});
