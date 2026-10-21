/**
 * Tests for Agent Factory
 *
 * Verifies:
 * - Provider detection from auth type
 * - Backend creation for different providers
 * - Available providers list
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { join } from 'node:path';
import {
  createBackend,
  createAgent,
  fetchBackendModels,
  getAvailableProviders,
  initializeBackendHostRuntime,
  isProviderAvailable,
  getDefaultAuthType,
  providerTypeToAgentProvider,
  resolveModelForProvider,
  tryProviderTypeToAgentProvider,
  resolveSetupTestConnectionHint,
  createBackendFromConnection,
  testBackendConnection,
  validateConnection,
  validateStoredBackendConnection,
} from '../factory.ts';
import { AGENT_PROVIDERS, LLM_PROVIDER_TYPES } from '../runtime-vocabulary.ts';
import { DEFAULT_MODEL } from '../../../config/models.ts';
import type { BackendConfig } from '../types.ts';
import type { LlmConnection } from '../../../config/storage.ts';
import type { ResolvedWorkspace as Workspace } from '../../../workspaces/types.ts';
import type { SessionConfig as Session } from '../../../sessions/storage.ts';
import { ClaudeAgent } from '../../claude-agent.ts';
import { PiAgent } from '../../pi-agent.ts';
import { NestorCloudAgent } from '../../nestor-cloud-agent.ts';
import {
  defaultMidStreamBehavior,
  getDefaultModelForConnection,
  getDefaultModelsForConnection,
  getModelsForProviderType,
  isValidProviderAuthCombination,
} from '../../../config/llm-connections.ts';

// Test helpers
function createTestWorkspace(): Workspace {
  return {
    id: 'test-workspace',
    workspaceRootPath: '/test/workspace',
    sessionRootPath: '/test/sessions/test-workspace',
    config: { id: 'test-workspace', name: 'Test Workspace', createdAt: 1, updatedAt: 1 },
    lastAccessedAt: 1,
  };
}

function createTestSession(): Session {
  return {
    id: 'test-session',
    name: 'Test Session',
    workspaceId: 'test-workspace-id',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    permissionMode: 'default',
  };
}

function createTestConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'anthropic',
    workspace: createTestWorkspace(),
    session: createTestSession(),
    isHeadless: true, // Prevent config watchers from starting
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.NESSY_FEATURE_PROVIDER_CLAUDE;
  delete process.env.NESSY_FEATURE_CLAUDE_RUNTIME;
  delete process.env.NESSY_FEATURE_CODEX_RUNTIME;
  delete process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD;
});

describe('createBackend / createAgent', () => {
  describe('Anthropic provider', () => {
    it('should create ClaudeAgent for anthropic provider', () => {
      const config = createTestConfig({ provider: 'anthropic' });
      const agent = createBackend(config);

      expect(agent).toBeInstanceOf(ClaudeAgent);
    });
  });

  describe('Pi provider', () => {
    it('should create PiAgent for pi provider', () => {
      const config = createTestConfig({ provider: 'pi' });
      const agent = createBackend(config);

      expect(agent).toBeInstanceOf(PiAgent);
    });
  });

  describe('Nestor cloud provider', () => {
    it('should create NestorCloudAgent for nestor-cloud-agent provider', () => {
      const config = createTestConfig({ provider: 'nestor-cloud-agent' });
      const agent = createBackend(config);

      expect(agent).toBeInstanceOf(NestorCloudAgent);
    });
  });

  describe('Unknown provider', () => {
    it('should throw for unknown provider', () => {
      const config = createTestConfig({ provider: 'unknown' as any });

      // P2.205 — same arm (throw), new message: it now names the site that
      // answered, which the original `Unknown provider:` string did not.
      expect(() => createBackend(config)).toThrow('createBackend: no arm for runtime "unknown"');
    });
  });

  describe('createAgent alias', () => {
    it('should be an alias for createBackend', () => {
      expect(createAgent).toBe(createBackend);
    });
  });
});

describe('getAvailableProviders', () => {
  it('should include both coding runtimes by default (defaults flipped 2026-08-06)', () => {
    expect(getAvailableProviders()).toEqual(['anthropic', 'pi', 'nestor-cloud-agent', 'codex-runtime']);
  });

  it('should include anthropic when only the subscription flag keeps it on', () => {
    process.env.NESSY_FEATURE_PROVIDER_CLAUDE = '1';
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    process.env.NESSY_FEATURE_CODEX_RUNTIME = '0';
    expect(getAvailableProviders()).toEqual(['anthropic', 'pi', 'nestor-cloud-agent']);
  });

  it('should include nestor-cloud-agent by default and drop it when the flag is 0', () => {
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    process.env.NESSY_FEATURE_CODEX_RUNTIME = '0';
    expect(getAvailableProviders()).toEqual(['pi', 'nestor-cloud-agent']);

    process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD = '0';
    expect(getAvailableProviders()).toEqual(['pi']);
  });
});

describe('isProviderAvailable', () => {
  it('should return false for anthropic when the runtime is opted out', () => {
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    expect(isProviderAvailable('anthropic')).toBe(false);
  });

  it('should return true for anthropic when Claude is enabled', () => {
    process.env.NESSY_FEATURE_PROVIDER_CLAUDE = '1';
    expect(isProviderAvailable('anthropic')).toBe(true);
  });

  it('should return true for pi', () => {
    expect(isProviderAvailable('pi')).toBe(true);
  });

  it('should return true for nestor-cloud-agent by default and false when disabled', () => {
    expect(isProviderAvailable('nestor-cloud-agent')).toBe(true);
    process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD = '0';
    expect(isProviderAvailable('nestor-cloud-agent')).toBe(false);
  });

  it('should return false for unknown provider', () => {
    expect(isProviderAvailable('unknown' as any)).toBe(false);
  });
});

describe('providerTypeToAgentProvider', () => {
  describe('Anthropic SDK providers', () => {
    it('should map anthropic to anthropic', () => {
      expect(providerTypeToAgentProvider('anthropic')).toBe('anthropic');
    });
  });

  describe('Pi SDK providers', () => {
    it('should map pi to pi', () => {
      expect(providerTypeToAgentProvider('pi')).toBe('pi');
    });

    it('should map pi_compat to pi', () => {
      expect(providerTypeToAgentProvider('pi_compat')).toBe('pi');
    });
  });

  describe('Nestor cloud provider', () => {
    it('should map nestor-cloud-agent to nestor-cloud-agent', () => {
      expect(providerTypeToAgentProvider('nestor-cloud-agent')).toBe('nestor-cloud-agent');
      expect(providerTypeToAgentProvider('pi_compat')).toBe('pi');
    });
  });
});

// ============================================================
// Provider-Auth Validation Tests
// ============================================================

describe('isValidProviderAuthCombination', () => {
  describe('Anthropic provider', () => {
    it('should accept api_key auth', () => {
      expect(isValidProviderAuthCombination('anthropic', 'api_key')).toBe(true);
    });

    it('should accept oauth auth', () => {
      expect(isValidProviderAuthCombination('anthropic', 'oauth')).toBe(true);
    });

    it('should reject api_key_with_endpoint auth', () => {
      expect(isValidProviderAuthCombination('anthropic', 'api_key_with_endpoint')).toBe(false);
    });

    it('should reject none auth', () => {
      expect(isValidProviderAuthCombination('anthropic', 'none')).toBe(false);
    });
  });

  describe('Pi provider', () => {
    it('should accept api_key auth', () => {
      expect(isValidProviderAuthCombination('pi', 'api_key')).toBe(true);
    });

    it('should accept oauth auth', () => {
      expect(isValidProviderAuthCombination('pi', 'oauth')).toBe(true);
    });

    it('should accept none auth', () => {
      expect(isValidProviderAuthCombination('pi', 'none')).toBe(true);
    });
  });

  describe('Pi compat provider', () => {
    it('should accept api_key_with_endpoint auth', () => {
      expect(isValidProviderAuthCombination('pi_compat', 'api_key_with_endpoint')).toBe(true);
    });

    it('should accept none auth (for local models like Ollama)', () => {
      expect(isValidProviderAuthCombination('pi_compat', 'none')).toBe(true);
    });
  });

  describe('Nestor cloud provider', () => {
    it('should accept none auth only', () => {
      expect(isValidProviderAuthCombination('nestor-cloud-agent', 'none')).toBe(true);
      expect(isValidProviderAuthCombination('nestor-cloud-agent', 'api_key_with_endpoint')).toBe(false);
    });
  });

  describe('Claude runtime provider', () => {
    it('should accept api_key_with_endpoint auth', () => {
      expect(isValidProviderAuthCombination('claude-runtime', 'api_key_with_endpoint')).toBe(true);
    });

    it('should accept api_key and none auth', () => {
      expect(isValidProviderAuthCombination('claude-runtime', 'api_key')).toBe(true);
      expect(isValidProviderAuthCombination('claude-runtime', 'none')).toBe(true);
    });

    it('should reject oauth auth (subscription login is the anthropic provider type)', () => {
      expect(isValidProviderAuthCombination('claude-runtime', 'oauth')).toBe(false);
    });

    it('should reject iam_credentials auth', () => {
      expect(isValidProviderAuthCombination('claude-runtime', 'iam_credentials')).toBe(false);
    });
  });

});

// ============================================================
// claude-runtime provider type (T4)
// ============================================================

describe('claude-runtime provider type', () => {
  function createClaudeRuntimeConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
    return {
      slug: 'nessy-gateway-claude',
      name: 'Nessy Gateway (Claude runtime)',
      providerType: 'claude-runtime',
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1',
      createdAt: 1,
      ...overrides,
    } as LlmConnection;
  }

  it('maps to the existing anthropic agent provider (reuses ClaudeAgent)', () => {
    expect(providerTypeToAgentProvider('claude-runtime')).toBe('anthropic');
  });

  it('defaults to api_key_with_endpoint auth', () => {
    expect(getDefaultAuthType('claude-runtime')).toBe('api_key_with_endpoint');
  });

  it('has no built-in model catalog — models come from the connection', () => {
    expect(getModelsForProviderType('claude-runtime')).toEqual([]);
    // The seeding path `createBuiltInConnection` uses must agree, otherwise a
    // new claude-runtime connection is born with defaultModel 'claude-opus-4-8'.
    expect(getDefaultModelsForConnection('claude-runtime')).toEqual([]);
    expect(getDefaultModelForConnection('claude-runtime')).toBe('');
  });

  it("defaults mid-stream sends to 'steer', same as the anthropic backend", () => {
    // Flipped 2026-08-17 after both arms of Claude's hook-based steer were driven
    // in the app: the delivered one works, and the undelivered one was found to be
    // losing the correction rather than merely wasting the turn. Fixed, then
    // flipped — see `defaultMidStreamBehavior`'s doc.
    expect(defaultMidStreamBehavior('claude-runtime')).toBe('steer');
  });

  it("resolves the connection's defaultModel, never the bundled Claude DEFAULT_MODEL", () => {
    const connection = createClaudeRuntimeConnection({ defaultModel: 'tgpt/qwen35-397b-a17b-fp8' });
    expect(resolveModelForProvider('anthropic', undefined, connection)).toBe('tgpt/qwen35-397b-a17b-fp8');
  });

  it('resolves to empty string when the connection carries no defaultModel', () => {
    const connection = createClaudeRuntimeConnection();
    expect(resolveModelForProvider('anthropic', undefined, connection)).toBe('');
  });

  it('still honours an explicit session model on a claude-runtime connection', () => {
    const connection = createClaudeRuntimeConnection({ defaultModel: 'tgpt/qwen35-397b-a17b-fp8' });
    expect(resolveModelForProvider('anthropic', 'claude-sonnet-4-6', connection)).toBe('claude-sonnet-4-6');
  });

  it('leaves the plain anthropic provider type on the Claude default fallback', () => {
    const connection = { ...createClaudeRuntimeConnection(), providerType: 'anthropic' } as LlmConnection;
    expect(resolveModelForProvider('anthropic', undefined, connection)).not.toBe('');
  });
});

describe('phase4 backend abstraction APIs', () => {
  it('initializeBackendHostRuntime bootstraps without throwing in dev runtime', () => {
    expect(() => initializeBackendHostRuntime({
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    })).not.toThrow();
  });

  // Skip: resolveClaudeCliPath finds the CLI via node_modules traversal even from dist/, so this
  // only fails in a truly isolated packaged environment, not in the dev monorepo.
  it.skip('initializeBackendHostRuntime throws for dist-style host root in dev', () => {
    expect(() => initializeBackendHostRuntime({
      hostRuntime: {
        appRootPath: join(process.cwd(), 'apps', 'electron', 'dist'),
        isPackaged: false,
      },
    })).toThrow('Claude Code SDK not found');
  });

  it('resolveSetupTestConnectionHint maps provider/baseUrl/piAuthProvider correctly', () => {
    expect(resolveSetupTestConnectionHint({
      provider: 'anthropic',
      baseUrl: 'https://api.example.com',
    })).toEqual({ providerType: 'pi_compat' });

    expect(resolveSetupTestConnectionHint({
      provider: 'anthropic',
      baseUrl: '',
    })).toEqual({ providerType: 'anthropic' });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      piAuthProvider: 'openai-codex',
    })).toEqual({ providerType: 'pi', piAuthProvider: 'openai-codex' });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      customEndpoint: { api: 'openai-completions' },
    })).toEqual({ providerType: 'pi_compat', piAuthProvider: 'openai', customEndpoint: { api: 'openai-completions' } });

    expect(resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://my-anthropic-proxy.internal/v1',
      customEndpoint: { api: 'anthropic-messages' },
    })).toEqual({ providerType: 'pi_compat', piAuthProvider: 'anthropic', customEndpoint: { api: 'anthropic-messages' } });
  });

  // C3 — before this arm the resolver could only emit 'pi' | 'pi_compat' |
  // 'anthropic', so a BYO runtime connection's setup test was classified as a
  // pi_compat custom endpoint: `anthropicDriver.testConnection`'s claude-runtime
  // branch was unreachable from the RPC path, and the generic fallback pointed
  // the direct Claude SDK at an OpenAI-shaped endpoint (a healthy connection
  // reported as broken).
  it('resolveSetupTestConnectionHint honours an explicit runtime provider type', () => {
    expect(resolveSetupTestConnectionHint({
      provider: 'anthropic',
      baseUrl: 'https://llm-proxy.internal.example.com/v1',
      runtimeProviderType: 'claude-runtime',
    })).toEqual({ providerType: 'claude-runtime' });

    expect(resolveSetupTestConnectionHint({
      provider: 'anthropic',
      baseUrl: 'https://llm-proxy.internal.example.com/v1',
      runtimeProviderType: 'codex-runtime',
    })).toEqual({ providerType: 'codex-runtime' });
  });

  it('resolveSetupTestConnectionHint never attaches a customEndpoint to a runtime hint', () => {
    // A `customEndpoint` on the hint makes `testBackendConnection` build a
    // pi_compat synthetic connection, which is the same conversion the SETUP
    // handler performs — the runtime arm must win outright.
    const hint = resolveSetupTestConnectionHint({
      provider: 'pi',
      baseUrl: 'https://llm-proxy.internal.example.com/v1',
      customEndpoint: { api: 'openai-completions' },
      runtimeProviderType: 'codex-runtime',
    });

    expect(hint).toEqual({ providerType: 'codex-runtime' });
  });

  it('fetchBackendModels dispatches for pi provider', async () => {
    const connection: LlmConnection = {
      slug: 'pi-test',
      name: 'Pi Test',
      providerType: 'pi',
      authType: 'none',
      createdAt: Date.now(),
    };

    const result = await fetchBackendModels({
      connection,
      credentials: {},
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.models.length).toBeGreaterThan(0);
  });

  it('validateStoredBackendConnection returns not found for unknown slug', async () => {
    const result = await validateStoredBackendConnection({
      slug: '__missing-connection__',
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection not found');
  });

  it('validateConnection returns a clean disabled-Claude error without SDK validation', async () => {
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    const result = await validateConnection({
      slug: 'claude-off',
      name: 'Claude Off',
      providerType: 'anthropic',
      authType: 'api_key',
      defaultModel: 'claude-sonnet-4-6',
      createdAt: Date.now(),
    }, { apiKey: 'test-key' });

    expect(result).toEqual({
      success: false,
      error: 'Claude support is not included in this build.',
    });
  });

  it('testBackendConnection keeps required model argument and validates key presence', async () => {
    const result = await testBackendConnection({
      provider: 'anthropic',
      apiKey: '   ',
      model: 'claude-sonnet-4-6',
      hostRuntime: {
        appRootPath: process.cwd(),
        isPackaged: false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('API key is required');
  });
});

// T5 — the two Claude build flags. `NESSY_FEATURE_PROVIDER_CLAUDE` gates only
// the Pro/Max subscription card but implies the runtime it needs, so the
// `anthropic` backend is available under EITHER flag. The `claude-runtime`
// providerType (the Nessy Gateway Claude card) additionally requires
// `NESSY_FEATURE_CLAUDE_RUNTIME` on its own.
//
// The gate is observed through `fetchBackendModels`. For `anthropic` the marker
// is the driver's own `Anthropic credentials required to fetch models` with
// empty credentials — deterministic and network-free. For `claude-runtime` that
// marker no longer exists: T7 made the driver answer from the connection's
// stored catalog instead of calling Anthropic's `/v1/models`, so RESOLVING is
// what "past the gate" looks like there (see that row's comment).
describe('claude build gates', () => {
  const PASSED_THE_GATE = 'Anthropic credentials required to fetch models';
  const hostRuntime = { appRootPath: process.cwd(), isPackaged: false };

  const fetchModels = (providerType: LlmConnection['providerType']) => fetchBackendModels({
    connection: {
      slug: 'claude-gate',
      name: 'Claude Gate',
      providerType,
      authType: 'api_key',
      createdAt: Date.now(),
    } as LlmConnection,
    credentials: {},
    hostRuntime,
  });

  it('blocks the anthropic backend when the runtime is opted out and the subscription flag is off', async () => {
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    expect(isProviderAvailable('anthropic')).toBe(false);
    await expect(fetchModels('anthropic')).rejects.toThrow('Claude support is not included in this build.');
  });

  it('the subscription flag alone still enables the anthropic backend', async () => {
    process.env.NESSY_FEATURE_PROVIDER_CLAUDE = '1';
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    expect(isProviderAvailable('anthropic')).toBe(true);
    await expect(fetchModels('anthropic')).rejects.toThrow(PASSED_THE_GATE);
  });

  it('the runtime flag alone enables the anthropic backend without the subscription card', async () => {
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '1';
    expect(isProviderAvailable('anthropic')).toBe(true);
    await expect(fetchModels('anthropic')).rejects.toThrow(PASSED_THE_GATE);
  });

  it('a claude-runtime connection needs the runtime flag — the subscription flag is not enough', async () => {
    process.env.NESSY_FEATURE_PROVIDER_CLAUDE = '1';
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    await expect(fetchModels('claude-runtime')).rejects.toThrow(
      'Claude runtime support is not included in this build.',
    );
  });

  it('a claude-runtime connection passes the gate once the runtime flag is set', async () => {
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '1';
    // Past the gate this provider type does NOT reach the credential check
    // above: T7 made `anthropicDriver.fetchModels` answer a claude-runtime
    // connection from its stored catalog instead of GET-ing
    // `<gateway>/v1/models` with the Nestor JWT in `x-api-key`. Resolving (with
    // the empty catalog this fixture carries) is therefore the "got past the
    // gate" marker for this row; the gated case still throws, one row above.
    await expect(fetchModels('claude-runtime')).resolves.toEqual({
      models: [],
      serverDefault: undefined,
    });
  });

  it('validateConnection reports the runtime-specific error for a claude-runtime connection', async () => {
    process.env.NESSY_FEATURE_PROVIDER_CLAUDE = '1';
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    const result = await validateConnection({
      slug: 'claude-runtime-off',
      name: 'Gateway Claude',
      providerType: 'claude-runtime',
      authType: 'api_key_with_endpoint',
      createdAt: Date.now(),
    } as LlmConnection, { apiKey: 'test-key' });

    expect(result).toEqual({
      success: false,
      error: 'Claude runtime support is not included in this build.',
    });
  });

  it('testBackendConnection reports the runtime-specific error for a claude-runtime connection', async () => {
    process.env.NESSY_FEATURE_PROVIDER_CLAUDE = '1';
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    const result = await testBackendConnection({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet-4-6',
      hostRuntime,
      connection: { providerType: 'claude-runtime' } as LlmConnection,
    });

    expect(result).toEqual({
      success: false,
      error: 'Claude runtime support is not included in this build.',
    });
  });
});

describe('resolveModelForProvider', () => {
  it('falls back to the Pi connection default when a normalized stale model is not in the connection list', () => {
    const connection = {
      providerType: 'pi',
      defaultModel: 'pi/claude-opus-4-7',
      models: ['pi/claude-opus-4-7', 'pi/claude-sonnet-4-6'],
    } as unknown as LlmConnection;

    expect(resolveModelForProvider('pi', 'pi/claude-opus-4-6', connection)).toBe('pi/claude-opus-4-7');
  });

  it('uses the single server-routed Nestor cloud model id', () => {
    expect(resolveModelForProvider('nestor-cloud-agent', undefined, null)).toBe('nestor-cloud-code-agent');
  });

  // P2.194(1) — the shipped Pi Bedrock catalog publishes no `apac.` ids at all
  // (measured: 55 Claude ids over `anthropic.`/`us.`/`eu.`/`global.`/`au.`/`jp.`),
  // so the region correction an `ap-*` user gets selects a prefix the catalog
  // cannot resolve, and this substitution is where that lands.
  it('substitutes the SAME Bedrock model under another geography, not the catalog head', () => {
    const connection = {
      providerType: 'pi',
      piAuthProvider: 'amazon-bedrock',
      // What `toBedrockNativeId(bare, deriveBedrockRegionPrefix('ap-southeast-1'))`
      // writes into a new Bedrock connection.
      defaultModel: 'pi/apac.anthropic.claude-opus-5',
      // The real catalog's head order for this provider, measured 2026-08-26.
      models: [
        'pi/us.anthropic.claude-opus-5',
        'pi/au.anthropic.claude-opus-5',
        'pi/global.anthropic.claude-opus-5',
        'pi/global.anthropic.claude-sonnet-5',
      ],
    } as unknown as LlmConnection;

    // MUTATION KILLED (first): deleting the `sameBedrockModelInCatalog` call.
    // The answer becomes `connectionModelIds[0]` — `pi/us.anthropic.claude-opus-5`
    // — silently undoing the region correction back to `us.`, which is the exact
    // defect P2.95c fixed in the derivation.
    // MUTATION KILLED (second): returning `sameModel[0]` without preferring
    // `global.`. That is `us.` again: same wrong geography, one layer in.
    expect(resolveModelForProvider('pi', undefined, connection))
      .toBe('pi/global.anthropic.claude-opus-5');
  });

  it('still falls back to the catalog head when no geography of the model is offered', () => {
    // The control, in two directions: a Bedrock default whose MODEL the catalog
    // does not carry at all, and a non-Bedrock stale id with no geography to
    // swap. Both keep the pre-existing head substitution — the fallback must be
    // narrower than "always pick something else".
    const noSuchModel = {
      providerType: 'pi',
      defaultModel: 'pi/apac.anthropic.claude-opus-5',
      models: ['pi/global.anthropic.claude-sonnet-5', 'pi/us.anthropic.claude-sonnet-4-6'],
    } as unknown as LlmConnection;
    expect(resolveModelForProvider('pi', undefined, noSuchModel))
      .toBe('pi/global.anthropic.claude-sonnet-5');

    const notBedrock = {
      providerType: 'pi',
      defaultModel: 'pi/gpt-5.2',
      models: ['pi/gpt-5.5', 'pi/gpt-5-mini'],
    } as unknown as LlmConnection;
    expect(resolveModelForProvider('pi', undefined, notBedrock)).toBe('pi/gpt-5.5');
  });
});

describe('ClaudeAgent model switching', () => {
  it('setModel updates getModel (regression: setModel used to write config.model but getModel reads _model)', () => {
    const agent = createBackend(createTestConfig({ provider: 'anthropic', model: 'claude-opus-4-7' }));

    expect(agent.getModel()).toBe('claude-opus-4-7');

    agent.setModel('claude-sonnet-4-6');

    expect(agent.getModel()).toBe('claude-sonnet-4-6');
  });
});

// ============================================================
// P2.205 — every per-runtime dispatch site in this file is TOTAL over the
// runtime vocabulary, and the arm for a runtime nobody described is a decision.
//
// The compiler holds one half: every site is now either a
// `Record<AgentProvider | LlmProviderType, …>` literal or a switch terminated by
// `unreachableRuntime`, so adding a member to either union breaks
// `bun run typecheck:shared` AT THE SITE. `bun test` does not typecheck, so
// these are the RUNTIME half: a value that was never in the union at all, which
// is reachable in production because `getLlmConnections()` returns
// `config.llmConnections` straight off disk with no per-field validation.
//
// Baseline for every "used to" below, measured on the parent commit by driving
// the real exports with `provider: 'sonnet-of-nobody'`.
// ============================================================

const UNDESCRIBED_RUNTIME = 'sonnet-of-nobody';

describe('P2.205 — dispatch sites are total over the runtime vocabulary', () => {
  it('providerTypeToAgentProvider throws instead of answering anthropic (site 7, the root)', () => {
    // MUTATION KILLED: restoring the old `default:` arm's `return 'anthropic'`
    // beside its `const _exhaustive: never`. The switch was already
    // compiler-total; the runtime arm answered `'anthropic'`, and every other
    // fail-open answer in this file came through here first.
    expect(() => providerTypeToAgentProvider(UNDESCRIBED_RUNTIME as never))
      .toThrow(/no arm for runtime/);
    // ...while every member of the vocabulary still resolves, so the throw is
    // not a blanket refusal.
    for (const providerType of LLM_PROVIDER_TYPES) {
      expect(AGENT_PROVIDERS).toContain(providerTypeToAgentProvider(providerType));
    }
  });

  it('tryProviderTypeToAgentProvider is the degrade half and reports undefined', () => {
    // MUTATION KILLED: making the validation surfaces call the throwing form and
    // swallow the error — an unsupported connection would then be indistinguishable
    // from an infrastructure failure.
    expect(tryProviderTypeToAgentProvider(UNDESCRIBED_RUNTIME)).toBeUndefined();
    expect(tryProviderTypeToAgentProvider(undefined)).toBeUndefined();
    expect(tryProviderTypeToAgentProvider('claude-runtime')).toBe('anthropic');
  });

  it('resolveModelForProvider hands no runtime an api.anthropic.com model id by default (site 13)', () => {
    // MUTATION KILLED (first): restoring `default: return managedModel ||
    // connectionDefault || DEFAULT_MODEL`, which is what handed an undescribed
    // runtime `claude-opus-4-8`.
    expect(() => resolveModelForProvider(UNDESCRIBED_RUNTIME as never, undefined, null))
      .toThrow(/no arm for runtime/);
    // MUTATION KILLED (second): deleting the explicit `case 'codex-runtime'` so
    // codex falls back through the anthropic arm again. A BYO codex connection
    // with no defaultModel was being handed a Claude model id to send to the
    // codex app-server.
    expect(resolveModelForProvider('codex-runtime', undefined, null)).toBe('');
    // The control: anthropic KEEPS the Claude default. Collapsing these two is
    // the other direction of the same bug.
    expect(resolveModelForProvider('anthropic', undefined, null)).toBe(DEFAULT_MODEL);
  });

  it('validateConnection reports an unsupported connection instead of validating it (site 15)', async () => {
    // MUTATION KILLED: reverting the `tryProviderTypeToAgentProvider` read to the
    // throwing form's old behaviour. Measured on the parent commit, an unknown
    // providerType reached the ANTHROPIC arm and came back carrying Anthropic's
    // own auth-failure string — it had been sent to api.anthropic.com.
    const result = await validateConnection(
      { slug: 'x', name: 'x', providerType: UNDESCRIBED_RUNTIME, authType: 'api_key', createdAt: 0 } as never,
      {},
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported connection type');
    expect(result.error).not.toContain('Authentication failed');
  });

  it('validateConnection decides every runtime without a catch-all arm (site 15)', async () => {
    // Both Claude flags off, so the two provider types that map to `anthropic`
    // short-circuit at the build gate and NOTHING reaches the SDK or the network.
    process.env.NESSY_FEATURE_PROVIDER_CLAUDE = '0';
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    for (const providerType of LLM_PROVIDER_TYPES) {
      const result = await validateConnection(
        { slug: 'x', name: 'x', providerType, authType: 'none', createdAt: 0 } as never,
        {},
      );
      // MUTATION KILLED: deleting the explicit `case 'codex-runtime'` /
      // `case 'nestor-cloud-agent'` arms. With the catch-all gone their
      // `{ success: true }` would become an `unreachableRuntime` throw, so the
      // two runtimes that used to be validated-as-working BY ACCIDENT now have
      // to say so on purpose.
      expect(typeof result.success).toBe('boolean');
    }
  });

  it('getDefaultAuthType decides pi_compat, and every answer is legal for its provider type (site 12)', () => {
    // MUTATION KILLED (first): removing the `pi_compat` row so it falls back to
    // `undefined` — "needs no credential" for the one provider type defined by
    // carrying its own endpoint AND key.
    expect(getDefaultAuthType('pi_compat')).toBe('api_key_with_endpoint');
    // MUTATION KILLED (second): inventing a value for any row. Cross-checked
    // against the independent table in `llm-connections.ts`, so the two agree
    // by test rather than by hope.
    for (const providerType of LLM_PROVIDER_TYPES) {
      const authType = getDefaultAuthType(providerType);
      if (authType === undefined) continue;
      expect(isValidProviderAuthCombination(providerType, authType)).toBe(true);
    }
    expect(() => getDefaultAuthType(UNDESCRIBED_RUNTIME as never)).toThrow(/no arm for runtime/);
  });

  it('getAvailableProviders decides every runtime in the vocabulary (site 5)', () => {
    process.env.NESSY_FEATURE_PROVIDER_CLAUDE = '1';
    process.env.NESSY_FEATURE_CODEX_RUNTIME = '1';
    // MUTATION KILLED: adding a runtime to the vocabulary without a build gate.
    // The old `push` chain failed in the QUIET direction — the runtime is simply
    // never available and nothing says so — which is why this asserts the SET
    // rather than the list.
    expect([...getAvailableProviders()].sort()).toEqual([...AGENT_PROVIDERS].sort());
  });

  it('resolveSetupTestConnectionHint names the two runtimes that used to fall through (site 9)', () => {
    // MUTATION KILLED: restoring the final `return { providerType: args.baseUrl
    // ? 'pi_compat' : 'anthropic' }` as a fall-through. Measured on the parent
    // commit, an undescribed runtime's endpoint and key were classified
    // `anthropic` and about to be tested against the Claude SDK.
    expect(resolveSetupTestConnectionHint({ provider: 'codex-runtime' }))
      .toEqual({ providerType: 'codex-runtime' });
    expect(resolveSetupTestConnectionHint({ provider: 'nestor-cloud-agent' }))
      .toEqual({ providerType: 'nestor-cloud-agent' });
    // The control: the anthropic arm's own baseUrl rule is unchanged.
    expect(resolveSetupTestConnectionHint({ provider: 'anthropic', baseUrl: 'https://x/v1' }))
      .toEqual({ providerType: 'pi_compat' });
    expect(() => resolveSetupTestConnectionHint({ provider: UNDESCRIBED_RUNTIME as never }))
      .toThrow(/no arm for runtime/);
  });

  it('createBackend still throws, and now says which site answered (site 4)', () => {
    // MUTATION KILLED: swapping `unreachableRuntime` for a bare `throw new
    // Error` again — the message would stop naming the site, which is what made
    // the original inventory a by-hand exercise.
    expect(() => createBackend({ ...createTestConfig(), provider: UNDESCRIBED_RUNTIME as never }))
      .toThrow(/createBackend: no arm for runtime/);
  });
});
