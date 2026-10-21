import { describe, expect, it } from 'bun:test';
import { providerEndpointEnv } from './provider-endpoint-env.ts';

/**
 * UB3.12 (upstream v0.15.0 `provider-endpoint-env.test.ts`, Azure arm — the
 * Cloudflare arm is DROP-a and its test arm is not ported).
 *
 * The contract under test: the env the Pi SDK reads a tenant-specific Azure
 * endpoint from follows the connection's edited base URL at BOTH doors that
 * learn one — init and update_runtime_config (which re-points the session in
 * place, so a stale env means the model keeps using the OLD endpoint while
 * the UI discloses the new one, owner rule F1.966). Everything but an Azure
 * provider with a non-empty URL must leave the environment untouched.
 */
describe('providerEndpointEnv', () => {
  it('positive: an Azure base URL becomes AZURE_OPENAI_BASE_URL — the edited endpoint takes effect', () => {
    expect(providerEndpointEnv('azure-openai-responses', 'https://res.openai.example')).toEqual({
      AZURE_OPENAI_BASE_URL: 'https://res.openai.example',
    });
    // The user's edit often carries padding; the SDK must see the trimmed URL.
    expect(providerEndpointEnv('azure-openai-responses', '  https://res.openai.example  ')).toEqual({
      AZURE_OPENAI_BASE_URL: 'https://res.openai.example',
    });
  });

  it('negative (control): a non-Azure provider sets nothing', () => {
    expect(providerEndpointEnv('openai', 'https://example.com')).toEqual({});
    expect(providerEndpointEnv('anthropic', 'https://res.openai.example')).toEqual({});
    expect(providerEndpointEnv(undefined, 'https://res.openai.example')).toEqual({});
  });

  it('negative (control): an empty or whitespace URL sets nothing, even for Azure', () => {
    expect(providerEndpointEnv('azure-openai-responses', undefined)).toEqual({});
    expect(providerEndpointEnv('azure-openai-responses', '')).toEqual({});
    expect(providerEndpointEnv('azure-openai-responses', '   ')).toEqual({});
  });
});
