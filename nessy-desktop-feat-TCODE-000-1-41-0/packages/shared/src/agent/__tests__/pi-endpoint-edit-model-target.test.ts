/**
 * F1.110 (origin WI-bx, D1.425's stated residue) - a `pi_compat` connection
 * whose ENDPOINT is edited mid-session must be re-classified for the MCP
 * withholding, not left holding the verdict of the URL it no longer points at.
 *
 * ## Why this is a second row rather than part of D1.425
 *
 * D1.425 closed the MODEL half at the one reader every runtime crosses:
 * `BaseAgent.setSourceServers` re-runs `modelTargetForModel` against the
 * verdict's own `host` on every materialization. The verdict deliberately keeps
 * no URL - only the host, never the path, query or credential - so the ENDPOINT
 * half cannot be re-decided from a verdict alone, and the gateway's rule is a
 * WHOLE-URL match rather than a host match (AGENTS.md: "Custom endpoints, even
 * on the same host with a different path, must retain normal provider auth
 * semantics"). The `gateway -> same host, different path` arm below is the one
 * that proves a host comparison would not have been enough.
 *
 * ## Why pi, and only pi
 *
 * `update_runtime_config` carries `baseUrl` (`packages/shared/AGENTS.md`) and
 * `buildRestartRequiredSignature` hashes no endpoint, so an endpoint edit keeps
 * the SAME agent object on this runtime. codex refuses any update that is not
 * model-only and is disposed and recreated through the factory; claude declares
 * no `updateRuntimeConfig` at all. The last case here is that asymmetry's
 * control, with a positive control on the same instrument.
 *
 * ## The instrument
 *
 * The real `PiAgent`, the real `updateRuntimeConfig`, the real
 * `BaseAgent.setSourceServers` and a real `McpClientPool` subclass that RECORDS
 * what it is asked to run instead of connecting - so what is asserted is the
 * server set a live session would hand the model. Every verdict comes from the
 * real `classifyModelTarget`; none is a literal.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PiAgent } from '../pi-agent.ts';
import { McpClientPool } from '../../mcp/mcp-pool.ts';
import {
  classifyModelTarget,
  NESSY_GATEWAY_CHAT_BASE_URL,
  type ModelTargetVerdict,
} from '../backend/internal/drivers/upstream-target.ts';
import { CapabilityMaterializationError, type CapabilitySnapshotMaterializer } from '../../capabilities/materializer.ts';
import type { BackendConfig, CapabilityTurnRuntime, SdkMcpServerConfig } from '../backend/types.ts';
import { createMockBackendConfig } from './test-utils.ts';

/** One whitelisted wire name and one that is not - a policy pair, not a nonsense pair. */
function twoServers(): CapabilityTurnRuntime['view']['mcpServers'] {
  return [
    { key: 'k1', wireName: 'dpJira', definition: { type: 'http', url: 'https://mcp.test/jira' } },
    { key: 'k2', wireName: 'dpFs', definition: { type: 'http', url: 'https://mcp.test/fs' } },
  ] as unknown as CapabilityTurnRuntime['view']['mcpServers'];
}

function runtimeWithTwoServers(): CapabilityTurnRuntime {
  const materializer: CapabilitySnapshotMaterializer = {
    assertActive: () => {},
    verifyPlugin: async () => {},
    resolvePath: async () => '/abs/path',
    readText: async () => '{}',
    resolveCredential: () => { throw new CapabilityMaterializationError('credential-not-ready'); },
  };
  return {
    view: {
      generation: 'g',
      sources: [], skills: [], mcpServers: twoServers(), hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [],
      apps: [], lspServers: [],
    },
    materializer,
  } as unknown as CapabilityTurnRuntime;
}

/** The real pool, recording what it is asked to run instead of connecting. */
class RecordingPool extends McpClientPool {
  readonly synced: Record<string, SdkMcpServerConfig>[] = [];

  override async sync(
    mcpServers: Parameters<McpClientPool['sync']>[0],
    _apiServers: Parameters<McpClientPool['sync']>[1] = {},
  ): Promise<string[]> {
    this.synced.push(mcpServers as Record<string, SdkMcpServerConfig>);
    return [];
  }
}

/** The live agent's own verdict - white-box on purpose: it is what the row is about. */
function verdictOf(agent: PiAgent): ModelTargetVerdict | undefined {
  return (agent as unknown as { config: BackendConfig }).config.modelTarget;
}

function makeAgent(options: { baseUrl?: string; model: string; classify?: boolean }): {
  agent: PiAgent;
  pool: RecordingPool;
} {
  const pool = new RecordingPool({});
  const modelTarget = options.classify === false
    ? undefined
    : classifyModelTarget({ baseUrl: options.baseUrl, model: options.model, providerType: 'pi_compat' });
  const agent = new PiAgent({
    ...createMockBackendConfig({
      provider: 'pi',
      model: options.model,
      mcpPool: pool,
      mcpLeaserId: 'session-f1110',
      ...(modelTarget ? { modelTarget } : {}),
    }),
    providerType: 'pi_compat',
    runtime: { baseUrl: options.baseUrl },
  } as unknown as BackendConfig);
  agent.setCapabilityTurnRuntime(runtimeWithTwoServers());
  return { agent, pool };
}

/** Edit the endpoint the way the refresh path does, then materialize one turn. */
async function editEndpointThenSync(
  agent: PiAgent,
  pool: RecordingPool,
  next: { baseUrl?: string; model?: string },
): Promise<string[]> {
  await agent.updateRuntimeConfig({
    model: next.model ?? agent.getModel(),
    ...(next.baseUrl === undefined ? {} : { runtime: { baseUrl: next.baseUrl } }),
  });
  await agent.setSourceServers({}, {}, []);
  return Object.keys(pool.synced[pool.synced.length - 1] ?? {}).sort();
}

const OLLAMA = 'http://localhost:11434/v1';
const VENDOR = 'https://api.openai.com/v1';
const UNPREFIXED = 'gpt-4o';

describe('PiAgent.updateRuntimeConfig - the endpoint half of the withholding verdict (F1.110)', () => {
  it('withholds the non-whitelisted server after the endpoint is edited from loopback to a vendor', async () => {
    // The fail-OPEN half. A local Ollama card is unrestricted whatever it runs;
    // re-pointed at `api.openai.com` it is `external-vendor`, and before this row
    // `dpFs` - a shipped corporate built-in that is NOT on the whitelist - stayed
    // in the map the pool syncs and was callable at the vendor.
    const { agent, pool } = makeAgent({ baseUrl: OLLAMA, model: UNPREFIXED });
    expect(verdictOf(agent)!.restricted).toBe(false);

    expect(await editEndpointThenSync(agent, pool, { baseUrl: VENDOR })).toEqual(['dpJira']);
    expect(verdictOf(agent)!.class).toBe('external-vendor');
  });

  it('gives the servers BACK when the endpoint is edited from a vendor to loopback', async () => {
    // The lock-OUT half, the one a user meets first: a session that once pointed
    // at a vendor kept the seven-name whitelist over its own servers until it was
    // restarted, although its endpoint had moved back inside.
    const { agent, pool } = makeAgent({ baseUrl: VENDOR, model: UNPREFIXED });
    expect(verdictOf(agent)!.restricted).toBe(true);

    expect(await editEndpointThenSync(agent, pool, { baseUrl: OLLAMA })).toEqual(['dpFs', 'dpJira']);
    expect(verdictOf(agent)!.class).toBe('loopback');
  });

  it('re-classifies a gateway connection edited to the SAME HOST on a different path', async () => {
    // Why the guard compares the derived URL and not the host: the gateway is a
    // WHOLE-URL match, so this edit keeps `verdict.host` byte-identical while
    // moving the class from `nessy-gateway` to `unclassified`. A host comparison
    // would have called this "unchanged" and kept every server on an endpoint the
    // `Nestor-Token` rule does not cover.
    const sameHostOtherPath = `${NESSY_GATEWAY_CHAT_BASE_URL}/not-the-gateway`;
    const { agent, pool } = makeAgent({ baseUrl: NESSY_GATEWAY_CHAT_BASE_URL, model: UNPREFIXED });
    const before = verdictOf(agent)!;
    expect(before.class).toBe('nessy-gateway');

    expect(await editEndpointThenSync(agent, pool, { baseUrl: sameHostOtherPath })).toEqual(['dpJira']);
    expect(verdictOf(agent)!.host).toBe(before.host);
    expect(verdictOf(agent)!.class).toBe('unclassified');
  });

  it('CONTROL: an edit between two in-perimeter proxies changes nothing', async () => {
    const { agent, pool } = makeAgent({ baseUrl: 'https://llm-proxy-a.corp.test/v1', model: 'tgpt/deepseek-v4-flash-0731' });
    expect(verdictOf(agent)!.class).toBe('vendor-internal');

    expect(await editEndpointThenSync(agent, pool, { baseUrl: 'https://llm-proxy-b.corp.test/v1' }))
      .toEqual(['dpFs', 'dpJira']);
    expect(verdictOf(agent)!.restricted).toBe(false);
  });

  it('CONTROL: a MODEL-ONLY update leaves the verdict the very same object', async () => {
    // D1.425's behaviour must be byte-identical: the model half is re-derived at
    // `setSourceServers`, not here, and an update that carries no endpoint must
    // not re-enter the classifier at all (it would read `BackendConfig.
    // providerType` where the factory read `connection?.providerType`).
    const { agent, pool } = makeAgent({ baseUrl: OLLAMA, model: UNPREFIXED });
    const before = verdictOf(agent);

    expect(await editEndpointThenSync(agent, pool, { model: 'anthropic/claude-x' })).toEqual(['dpFs', 'dpJira']);
    expect(verdictOf(agent)).toBe(before);
  });

  it('CONTROL: a verdict absent at construction is never MINTED by an endpoint edit', async () => {
    const { agent, pool } = makeAgent({ baseUrl: OLLAMA, model: UNPREFIXED, classify: false });
    expect(verdictOf(agent)).toBeUndefined();

    expect(await editEndpointThenSync(agent, pool, { baseUrl: VENDOR })).toEqual(['dpFs', 'dpJira']);
    expect(verdictOf(agent)).toBeUndefined();
  });
});

describe('F1.110 - the codex and claude arms are untouched', () => {
  const read = (name: string) => readFileSync(join(import.meta.dir, '..', name), 'utf8');

  it('neither backend re-derives on an endpoint edit, and pi is the positive control', () => {
    // An absence with a control on the same instrument. codex refuses a
    // non-model-only update (`codexUpdateIsModelOnly`) and is rebuilt through the
    // factory, which classifies from scratch; claude declares no
    // `updateRuntimeConfig` member at all. Neither may grow a second copy of this
    // derivation without this case going red.
    expect(read('claude-agent.ts')).not.toContain('modelTargetForEndpoint');
    expect(read('codex-agent.ts')).not.toContain('modelTargetForEndpoint');
    expect(read('pi-agent.ts')).toContain('modelTargetForEndpoint');
    expect(read('claude-agent.ts')).not.toContain('async updateRuntimeConfig(');
    expect(read('codex-agent.ts')).toContain('codexUpdateIsModelOnly(update, pinned)');
  });
});
