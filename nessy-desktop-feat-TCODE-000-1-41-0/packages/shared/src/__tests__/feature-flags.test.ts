import { describe, it, expect, afterEach } from 'bun:test';
import { isDevRuntime, isDeveloperFeedbackEnabled, isEmbeddedServerEnabled, isCodexRuntimeEnabled, isClaudeRuntimeEnabled, isAnthropicBackendEnabled, isProviderEnabled, resolveProviderFlags } from '../feature-flags.ts';
import { getAvailableProviders } from '../agent/backend/factory.ts';

// Task 7.7 wired the rollout gate; owner decision 2026-08-06 flipped the
// default: the coding runtimes ship by default, only subscription cards stay
// flag-gated. getAvailableProviders() is the single surfacing path.
describe('codex-runtime feature flag + rollout gate', () => {
  afterEach(() => {
    delete process.env.NESSY_FEATURE_CODEX_RUNTIME;
    delete process.env.NESSY_FEATURE_PROVIDER_CLAUDE;
    delete process.env.NESSY_FEATURE_CLAUDE_RUNTIME;
    delete process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD;
  });

  it('defaults to enabled (Codex present in the default build)', () => {
    delete process.env.NESSY_FEATURE_CODEX_RUNTIME;
    delete process.env.NESSY_FEATURE_PROVIDER_CLAUDE;
    delete process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD;
    expect(isCodexRuntimeEnabled()).toBe(true);
    const providers = getAvailableProviders();
    expect(providers).toContain('codex-runtime');
  });

  it('NESSY_FEATURE_CODEX_RUNTIME=0 removes codex-runtime from getAvailableProviders', () => {
    process.env.NESSY_FEATURE_CODEX_RUNTIME = '0';
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    delete process.env.NESSY_FEATURE_PROVIDER_CLAUDE;
    delete process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD;
    expect(isCodexRuntimeEnabled()).toBe(false);
    expect(getAvailableProviders()).toEqual(['pi', 'nestor-cloud-agent']);
  });

  it('unset and =1 both include codex-runtime; =0 excludes it, pi remains', () => {
    delete process.env.NESSY_FEATURE_PROVIDER_CLAUDE;
    delete process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD;
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';

    process.env.NESSY_FEATURE_CODEX_RUNTIME = '1';
    expect(getAvailableProviders()).toEqual(['pi', 'nestor-cloud-agent', 'codex-runtime']);

    delete process.env.NESSY_FEATURE_CODEX_RUNTIME;
    expect(getAvailableProviders()).toEqual(['pi', 'nestor-cloud-agent', 'codex-runtime']);

    process.env.NESSY_FEATURE_CODEX_RUNTIME = '0';
    expect(getAvailableProviders()).toEqual(['pi', 'nestor-cloud-agent']);
  });

  it('NESSY_FEATURE_PROVIDER_CLAUDE=1 keeps anthropic present even with the runtime off', () => {
    process.env.NESSY_FEATURE_CODEX_RUNTIME = '0';
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    delete process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD;
    process.env.NESSY_FEATURE_PROVIDER_CLAUDE = '1';
    expect(getAvailableProviders()).toEqual(['anthropic', 'pi', 'nestor-cloud-agent']);
  });

  it('NESSY_FEATURE_PROVIDER_NESTOR_CLOUD=1 adds the native cloud backend without changing pi_compat routing', () => {
    process.env.NESSY_FEATURE_CODEX_RUNTIME = '0';
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    delete process.env.NESSY_FEATURE_PROVIDER_CLAUDE;
    process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD = '1';

    expect(isProviderEnabled('nessy_cloud')).toBe(true);
    expect(getAvailableProviders()).toEqual(['pi', 'nestor-cloud-agent']);
  });
});

// T5 — the NESSY_FEATURE_CLAUDE_RUNTIME split. Before T5 a single flag
// (NESSY_FEATURE_PROVIDER_CLAUDE) conflated three things: the Pro/Max
// subscription card, the `anthropic` agent backend, and bundling of the ~210MB
// native `claude` binary. After T5 the runtime flag owns the backend + the
// binary, the provider flag owns only the card, and the card implies the
// runtime it needs — so backend availability is the OR of the two.
describe('claude-runtime feature flag split', () => {
  const CLAUDE_ENV = [
    'NESSY_FEATURE_PROVIDER_CLAUDE',
    'NESSY_FEATURE_CLAUDE_RUNTIME',
    'NESSY_FEATURE_CODEX_RUNTIME',
    'NESSY_FEATURE_PROVIDER_NESTOR_CLOUD',
  ] as const;

  const clearClaudeEnv = () => {
    for (const key of CLAUDE_ENV) delete process.env[key];
  };

  afterEach(clearClaudeEnv);

  it('defaults to enabled — runtime and anthropic backend present', () => {
    clearClaudeEnv();
    expect(isClaudeRuntimeEnabled()).toBe(true);
    expect(isProviderEnabled('nessy_claude')).toBe(true);
    expect(isAnthropicBackendEnabled()).toBe(true);
    expect(getAvailableProviders()).toContain('anthropic');
  });

  it('NESSY_FEATURE_CLAUDE_RUNTIME=0 disables the runtime and the anthropic backend', () => {
    clearClaudeEnv();
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    expect(isClaudeRuntimeEnabled()).toBe(false);
    expect(isProviderEnabled('nessy_claude')).toBe(false);
    expect(isAnthropicBackendEnabled()).toBe(false);
    expect(getAvailableProviders()).not.toContain('anthropic');
  });

  it('honors every accepted truthy/falsy spelling, and unset means ON (default flipped 2026-08-06)', () => {
    for (const on of ['1', 'true', 'yes', 'on', 'ON', ' True ']) {
      process.env.NESSY_FEATURE_CLAUDE_RUNTIME = on;
      expect(isClaudeRuntimeEnabled()).toBe(true);
    }
    for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
      process.env.NESSY_FEATURE_CLAUDE_RUNTIME = off;
      expect(isClaudeRuntimeEnabled()).toBe(false);
    }
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = 'maybe'; // unparseable → default
    expect(isClaudeRuntimeEnabled()).toBe(true);
    delete process.env.NESSY_FEATURE_CLAUDE_RUNTIME;
    expect(isClaudeRuntimeEnabled()).toBe(true);
  });

  it('the runtime flag does not turn on the Pro/Max subscription card', () => {
    clearClaudeEnv();
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '1';
    expect(isProviderEnabled('claude')).toBe(false);
  });

  it('the subscription card implies the runtime backend but not the nessy_claude card', () => {
    clearClaudeEnv();
    process.env.NESSY_FEATURE_PROVIDER_CLAUDE = '1';
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    expect(isAnthropicBackendEnabled()).toBe(true);
    expect(getAvailableProviders()).toContain('anthropic');
    // The gateway card rides the runtime flag alone (wired in T7).
    expect(isClaudeRuntimeEnabled()).toBe(false);
    expect(isProviderEnabled('nessy_claude')).toBe(false);
  });

  it('explicitly disabling the runtime does not disable a build that ships the subscription card', () => {
    clearClaudeEnv();
    process.env.NESSY_FEATURE_PROVIDER_CLAUDE = '1';
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    expect(isAnthropicBackendEnabled()).toBe(true);
    expect(isClaudeRuntimeEnabled()).toBe(false);
  });

  it('resolveProviderFlags carries nessy_claude for the renderer IPC payload', () => {
    clearClaudeEnv();
    expect(resolveProviderFlags().nessy_claude).toBe(true);
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    expect(resolveProviderFlags().nessy_claude).toBe(false);
  });
});

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  NESSY_DEBUG: process.env.NESSY_DEBUG,
  NESSY_FEATURE_DEVELOPER_FEEDBACK: process.env.NESSY_FEATURE_DEVELOPER_FEEDBACK,
  NESSY_FEATURE_EMBEDDED_SERVER: process.env.NESSY_FEATURE_EMBEDDED_SERVER,
};

afterEach(() => {
  if (ORIGINAL_ENV.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;

  if (ORIGINAL_ENV.NESSY_DEBUG === undefined) delete process.env.NESSY_DEBUG;
  else process.env.NESSY_DEBUG = ORIGINAL_ENV.NESSY_DEBUG;

  if (ORIGINAL_ENV.NESSY_FEATURE_DEVELOPER_FEEDBACK === undefined) delete process.env.NESSY_FEATURE_DEVELOPER_FEEDBACK;
  else process.env.NESSY_FEATURE_DEVELOPER_FEEDBACK = ORIGINAL_ENV.NESSY_FEATURE_DEVELOPER_FEEDBACK;

  if (ORIGINAL_ENV.NESSY_FEATURE_EMBEDDED_SERVER === undefined) delete process.env.NESSY_FEATURE_EMBEDDED_SERVER;
  else process.env.NESSY_FEATURE_EMBEDDED_SERVER = ORIGINAL_ENV.NESSY_FEATURE_EMBEDDED_SERVER;
});

describe('feature-flags runtime helpers', () => {
  it('isDevRuntime returns true for explicit dev NODE_ENV', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.NESSY_DEBUG;

    expect(isDevRuntime()).toBe(true);
  });

  it('isDevRuntime returns true for NESSY_DEBUG override', () => {
    process.env.NODE_ENV = 'production';
    process.env.NESSY_DEBUG = '1';

    expect(isDevRuntime()).toBe(true);
  });

  it('isDeveloperFeedbackEnabled honors explicit override false', () => {
    process.env.NODE_ENV = 'development';
    process.env.NESSY_FEATURE_DEVELOPER_FEEDBACK = '0';

    expect(isDeveloperFeedbackEnabled()).toBe(false);
  });

  it('isDeveloperFeedbackEnabled honors explicit override true', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NESSY_DEBUG;
    process.env.NESSY_FEATURE_DEVELOPER_FEEDBACK = '1';

    expect(isDeveloperFeedbackEnabled()).toBe(true);
  });

  it('isDeveloperFeedbackEnabled falls back to dev runtime when no override', () => {
    process.env.NODE_ENV = 'production';
    process.env.NESSY_DEBUG = '1';
    delete process.env.NESSY_FEATURE_DEVELOPER_FEEDBACK;

    expect(isDeveloperFeedbackEnabled()).toBe(true);
  });

  it('isEmbeddedServerEnabled defaults to false when no override is set', () => {
    delete process.env.NESSY_FEATURE_EMBEDDED_SERVER;

    expect(isEmbeddedServerEnabled()).toBe(false);
  });

  it('isEmbeddedServerEnabled honors explicit override true', () => {
    process.env.NESSY_FEATURE_EMBEDDED_SERVER = '1';

    expect(isEmbeddedServerEnabled()).toBe(true);
  });

  it('isEmbeddedServerEnabled honors explicit override false', () => {
    process.env.NESSY_FEATURE_EMBEDDED_SERVER = '0';

    expect(isEmbeddedServerEnabled()).toBe(false);
  });
});

describe('provider gating flags (build-time provider cards)', () => {
  const PROVIDER_ENV = [
    'NESSY_FEATURE_PROVIDER_NESSY',
    'NESSY_FEATURE_PROVIDER_NESTOR_CLOUD',
    'NESSY_FEATURE_PROVIDER_CLAUDE',
    'NESSY_FEATURE_PROVIDER_CHATGPT',
    'NESSY_FEATURE_PROVIDER_API_KEY',
    'NESSY_FEATURE_PROVIDER_LOCAL',
    'NESSY_FEATURE_CODEX_RUNTIME',
    'NESSY_FEATURE_CLAUDE_RUNTIME',
  ] as const;

  afterEach(() => {
    for (const key of PROVIDER_ENV) delete process.env[key];
  });

  it('default build offers the gateways, both coding runtimes, and custom endpoint — subscriptions stay off', () => {
    for (const key of PROVIDER_ENV) delete process.env[key];
    expect(resolveProviderFlags()).toEqual({
      nessy: true,
      nessy_cloud: true,
      api_key: true,
      local: false,
      claude: false,
      chatgpt: false,
      nessy_codex: true,
      nessy_claude: true,
    });
  });

  it('a per-provider override flips one card without touching the rest', () => {
    process.env.NESSY_FEATURE_PROVIDER_LOCAL = '1';
    process.env.NESSY_FEATURE_PROVIDER_NESSY = '0';
    expect(isProviderEnabled('local')).toBe(true);
    expect(isProviderEnabled('nessy')).toBe(false);
    expect(isProviderEnabled('api_key')).toBe(true); // default preserved
  });

  it('the nessy_cloud card is default-on and can be disabled by its dedicated env flag', () => {
    delete process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD;
    expect(isProviderEnabled('nessy_cloud')).toBe(true);
    process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD = '0';
    expect(isProviderEnabled('nessy_cloud')).toBe(false);
    process.env.NESSY_FEATURE_PROVIDER_NESTOR_CLOUD = '1';
    expect(isProviderEnabled('nessy_cloud')).toBe(true);
  });

  it('the nessy_codex card follows the single codex-runtime flag (default on)', () => {
    delete process.env.NESSY_FEATURE_CODEX_RUNTIME;
    expect(isProviderEnabled('nessy_codex')).toBe(true);
    process.env.NESSY_FEATURE_CODEX_RUNTIME = '0';
    expect(isProviderEnabled('nessy_codex')).toBe(false);
  });

  it('the nessy_claude card follows the single claude-runtime flag (default on)', () => {
    delete process.env.NESSY_FEATURE_CLAUDE_RUNTIME;
    expect(isProviderEnabled('nessy_claude')).toBe(true);
    process.env.NESSY_FEATURE_CLAUDE_RUNTIME = '0';
    expect(isProviderEnabled('nessy_claude')).toBe(false);
  });
});
