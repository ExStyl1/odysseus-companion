/**
 * UB12.11 — `PiAgent.updateRuntimeConfig` forwards the host's re-resolved mini
 * model to the subprocess and adopts it on the host side too.
 *
 * The host resolves the background tier's model once, at agent build
 * (`getMiniModel`, which asks the gateway's `fast` alias first), and three readers
 * hold it for the agent's life: the subprocess's `config.miniModel` (titles and
 * mini completions, `queryLlm`), `PiEventAdapter`'s `call_llm` default, and the
 * `call_llm` tool description's "Default fast model" line. The live refresh
 * (`SessionManager.runAgentRuntimeRefresh`) now carries `miniModel`; this pins
 * the hop between that call and the `update_runtime_config` line on the wire,
 * the hop a whitelisting envelope drops in silence.
 *
 * The real `PiAgent` with its subprocess faked at `send`, answered the way
 * `handleRuntimeConfigUpdateResult` is by the real subprocess.
 */
import { describe, expect, it } from 'bun:test';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig, BackendRuntimeUpdate } from '../backend/types.ts';
import { createMockBackendConfig } from './test-utils.ts';

const FAST_OLD = 'tgpt/fast-retired';
const FAST_NEW = 'tgpt/fast-current';
const CODER = 'tgpt/coder-current';

function setupAgent(): { agent: PiAgent; sent: Array<Record<string, unknown>> } {
  const agent = new PiAgent({
    ...createMockBackendConfig({ provider: 'pi', model: CODER, miniModel: FAST_OLD }),
    providerType: 'pi_compat',
    runtime: { baseUrl: 'http://localhost:8085/v1' },
  } as unknown as BackendConfig);
  const sent: Array<Record<string, unknown>> = [];
  (agent as any).subprocess = {};
  (agent as any).send = (message: Record<string, unknown>) => {
    sent.push(message);
    if (message.type === 'update_runtime_config') {
      queueMicrotask(() => (agent as any).handleRuntimeConfigUpdateResult({ id: message.id, success: true, updated: true }));
    }
  };
  return { agent, sent };
}

/** The three host-side readers of the mini model, plus what the wire carried. */
async function update(update: BackendRuntimeUpdate): Promise<Record<string, unknown>> {
  const { agent, sent } = setupAgent();
  const refreshed = await agent.updateRuntimeConfig(update);
  const wire = sent.find(message => message.type === 'update_runtime_config');
  return {
    refreshed,
    wire: wire?.miniModel,
    config: (agent as any).config.miniModel,
    callLlmDefault: (agent as any).adapter.miniModel,
  };
}

describe('UB12.11 · PiAgent.updateRuntimeConfig carries the re-resolved mini model', () => {
  it('POSITIVE: a rotated fast id reaches the subprocess envelope, the agent config and the call_llm default', async () => {
    expect(await update({ model: CODER, miniModel: FAST_NEW })).toEqual({
      refreshed: true,
      wire: FAST_NEW,
      config: FAST_NEW,
      callLlmDefault: FAST_NEW,
    });
  });

  it('NEGATIVE: an update with no mini model leaves the built one in place on every reader', async () => {
    expect(await update({ model: CODER })).toEqual({
      refreshed: true,
      wire: undefined,
      config: FAST_OLD,
      callLlmDefault: FAST_OLD,
    });
  });
});
