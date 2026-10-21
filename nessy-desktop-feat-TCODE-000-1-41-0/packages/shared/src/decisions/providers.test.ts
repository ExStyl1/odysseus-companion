// UB6.2 — the five upstream provider presets, per the owner's 2026-10-02 answer to
// OQ-43.2/OQ-43.2b ("identical to craft agents: if there is a key we use it, if not
// the feature is not used"). Rebased from the preset pins of upstream
// `v0.15.1:packages/shared/src/decisions/settings.test.ts`; the licence premise is
// recorded in providers.ts's header (package + all three checkpoints Apache-2.0,
// read 2026-10-15). Our rebrand drops the OpenRouter X-Title header.

import { describe, it, expect } from 'bun:test';
import {
  DECISION_PROVIDER_IDS,
  isDecisionProviderId,
  type DecisionProviderId,
} from './types.ts';
import {
  DECISION_PROVIDER_PRESETS,
  DEFAULT_LAYA_BASE_URL,
  decisionProviderForConnection,
  buildSystemOneEndpoint,
} from './providers.ts';
import { resolveDecisionClient } from './resolve.ts';
import { normalizeDecisionLayerSettings } from './settings.ts';
import type { CredentialManager } from '../credentials/index.ts';

function credentials(keys: Record<string, string> = {}): CredentialManager {
  return {
    async getDecisionApiKey(provider: string) {
      return keys[provider] ?? null;
    },
    async getLlmApiKey() {
      return null;
    },
  } as unknown as CredentialManager;
}

const FIXTURE_KEY = 'sk-fixture-not-a-real-key';

describe('the five provider presets (UB6.2)', () => {
  it('positive: each of the five presets parses and resolves with a fixture key', async () => {
    expect(DECISION_PROVIDER_IDS).toEqual(['typesafe', 'openrouter', 'vercel-ai-gateway', 'laya', 'custom']);
    for (const id of DECISION_PROVIDER_IDS) {
      expect(isDecisionProviderId(id)).toBe(true);
      const resolution = await resolveDecisionClient({
        settings: normalizeDecisionLayerSettings({ enabled: true, provider: id, baseUrl: id === 'custom' ? 'http://127.0.0.1:9000' : undefined }),
        credentialManager: credentials({ [id]: FIXTURE_KEY }),
      });
      expect(resolution.ok, `${id} resolves with a key`).toBe(true);
      if (resolution.ok) {
        expect(resolution.value.provider).toBe(id);
        expect(resolution.value.keySource).toBe(id === 'laya' || id === 'custom' ? 'provider' : 'provider');
        expect(resolution.value.endpoint.endpoint).toMatch(/\/v1\/systemone$/);
      }
    }
  });

  it('positive: laya and custom resolve KEYLESS on their local bases', async () => {
    for (const id of ['laya', 'custom'] as const) {
      const resolution = await resolveDecisionClient({
        settings: normalizeDecisionLayerSettings({ enabled: true, provider: id, baseUrl: id === 'custom' ? 'http://127.0.0.1:9000' : undefined }),
        credentialManager: credentials(),
      });
      expect(resolution.ok, `${id} needs no key`).toBe(true);
    }
  });

  it('laya ships upstream\u2019s install hint and docs link verbatim (OQ-43.2b: identical), on loopback with the 48 KB state cap', () => {
    const laya = DECISION_PROVIDER_PRESETS.laya;
    expect(laya.installHint).toBe('pip install "laya[serve]" && laya-serve');
    expect(laya.docsUrl).toBe('https://github.com/NandhaKishorM/laya');
    expect(laya.baseUrl).toBe(DEFAULT_LAYA_BASE_URL);
    expect(new URL(laya.baseUrl).hostname).toBe('127.0.0.1');
    expect(laya.healthPath).toBe('/health');
    expect(laya.maxStateBytes).toBe(48 * 1024);
    expect(laya.requiresKey).toBe(false);
    expect(laya.local).toBe(true);
  });

  it('reuses an OpenRouter / Vercel AI Gateway connection\u2019s key and nothing else maps to a provider', () => {
    expect(decisionProviderForConnection('openrouter')).toBe('openrouter');
    expect(decisionProviderForConnection('vercel-ai-gateway')).toBe('vercel-ai-gateway');
    expect(decisionProviderForConnection('openai')).toBeNull();
    expect(decisionProviderForConnection('anthropic')).toBeNull();
    expect(decisionProviderForConnection(undefined)).toBeNull();
    expect(DECISION_PROVIDER_PRESETS.openrouter.reusableConnectionProviders).toEqual(['openrouter']);
    expect(DECISION_PROVIDER_PRESETS['vercel-ai-gateway'].reusableConnectionProviders).toEqual(['vercel-ai-gateway']);
  });

  it('negative (control): no key for a keyed preset resolves null; a custom URL is still required for custom', async () => {
    for (const id of ['typesafe', 'openrouter', 'vercel-ai-gateway'] as const) {
      const resolution = await resolveDecisionClient({
        settings: normalizeDecisionLayerSettings({ enabled: true, provider: id }),
        credentialManager: credentials(),
      });
      expect(resolution.ok, `${id} without a key is unconfigured`).toBe(false);
      if (!resolution.ok) expect(resolution.failure.kind).toBe('unconfigured');
    }
    const custom = await resolveDecisionClient({
      settings: normalizeDecisionLayerSettings({ enabled: true, provider: 'custom' }),
      credentialManager: credentials(),
    });
    expect(custom.ok).toBe(false);
  });

  it('negative (control): no SaaS preset id parses beyond the five, and hosted presets never claim local', () => {
    expect(isDecisionProviderId('nessy-gateway')).toBe(false);
    expect(isDecisionProviderId('cloudflare-ai-gateway')).toBe(false);
    expect(isDecisionProviderId('laya-serve')).toBe(false);
    for (const id of ['typesafe', 'openrouter', 'vercel-ai-gateway'] as DecisionProviderId[]) {
      expect(DECISION_PROVIDER_PRESETS[id].local).toBeUndefined();
    }
  });

  it('builds endpoints tolerantly and refuses an empty base', () => {
    expect(buildSystemOneEndpoint('https://api.typesafe.ai/')).toBe('https://api.typesafe.ai/v1/systemone');
    expect(buildSystemOneEndpoint('https://x.test/v1/systemone')).toBe('https://x.test/v1/systemone');
    expect(() => buildSystemOneEndpoint('   ')).toThrow();
  });
});
