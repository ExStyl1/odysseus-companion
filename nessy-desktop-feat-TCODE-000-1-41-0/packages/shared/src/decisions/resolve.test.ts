// UB6.1a — the resolve gate order has no upstream suite (upstream tests client,
// health, records, settings), so the row's named negative controls live here:
// off → null, no key → null, and the Nestor-Token posture pin (never attached to
// a non-verified URL — the decision client sends `Authorization: Bearer` only).

import { describe, it, expect } from 'bun:test';
import { getDecisionClient, resolveDecisionClient } from './resolve.ts';
import { normalizeDecisionLayerSettings } from './settings.ts';
import type { DecisionLayerSettings } from './settings.ts';
import type { CredentialManager } from '../credentials/index.ts';
import type { DecisionFailure } from './types.ts';

function settingsWith(patch: Partial<DecisionLayerSettings>): DecisionLayerSettings {
  return normalizeDecisionLayerSettings(patch as Parameters<typeof normalizeDecisionLayerSettings>[0]);
}

/** Credential manager stub: no key anywhere unless the test stores one. */
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

const OK_ENVELOPE = {
  model: 'jev-test',
  answers: { succeeded: { type: 'noul', noul: 0.93 } },
  usage: { input_tokens: 10, output_tokens: 2 },
};

describe('resolveDecisionClient gate order (UB6.1)', () => {
  it('positive: a reachable endpoint answers with probabilities and the client is ready', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(OK_ENVELOPE), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof globalThis.fetch;

    const resolution = await resolveDecisionClient({
      settings: settingsWith({ enabled: true, provider: 'laya' }),
      credentialManager: credentials(),
      fetch: fetchImpl,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const result = await resolution.value.client.decide({
      state: 'Deployment finished. All 42 checks passed.',
      questions: { succeeded: { type: 'noul', instructions: 'Did the deployment succeed?' } },
    });
    expect(result.answers.succeeded).toEqual({ type: 'noul', noul: 0.93 });
    expect(calls[0]!.url).toBe('http://127.0.0.1:8000/v1/systemone');
    expect((calls[0]!.init.headers as Record<string, string>)['Nestor-Token']).toBeUndefined();
  });

  it('negative (control): the master switch off fails closed with disabled', async () => {
    const resolution = await resolveDecisionClient({
      settings: settingsWith({ enabled: false, provider: 'laya' }),
      credentialManager: credentials(),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect((resolution.failure as DecisionFailure).kind).toBe('disabled');
    expect(await getDecisionClient({ settings: settingsWith({ enabled: false }), credentialManager: credentials() })).toBeNull();
  });

  it('negative (control): no key for a keyed provider is unconfigured and getDecisionClient returns null', async () => {
    const resolution = await resolveDecisionClient({
      settings: settingsWith({ enabled: true, provider: 'typesafe' }),
      credentialManager: credentials(),
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.failure.kind).toBe('unconfigured');
    expect(await getDecisionClient({ settings: settingsWith({ enabled: true, provider: 'typesafe' }), credentialManager: credentials() })).toBeNull();
  });

  it('posture (SEC-8): a SaaS request carries Bearer auth only — never Nestor-Token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(OK_ENVELOPE), { status: 200 });
    }) as typeof globalThis.fetch;
    const resolution = await resolveDecisionClient({
      settings: settingsWith({ enabled: true, provider: 'typesafe' }),
      credentialManager: credentials({ typesafe: 'sk-fixture-key' }),
      fetch: fetchImpl,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    await resolution.value.client.decide({
      state: 'state text',
      questions: { succeeded: { type: 'noul', instructions: 'ok?' } },
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-fixture-key');
    expect(headers['Nestor-Token']).toBeUndefined();
    expect(calls[0]!.url).not.toContain('tcsbank.ru');
  });
});
