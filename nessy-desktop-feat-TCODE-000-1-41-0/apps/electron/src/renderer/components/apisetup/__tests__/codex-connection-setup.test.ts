/**
 * Task 4.5 gate: a Codex connection is built from the Nessy Gateway preset with
 * providerType `codex-runtime`, base URL = NESSY_GATEWAY_BASE_URL, and default
 * model = NESSY_GATEWAY_DEFAULT_MODEL — reusing the shared preset literals.
 */
import { test, expect, describe } from 'bun:test';
import {
  codexGatewayConnectionDefaults,
  NESSY_GATEWAY_BASE_URL,
  NESSY_GATEWAY_DEFAULT_MODEL,
  NESSY_GATEWAY_MODELS,
} from '../nessy-gateway.ts';

describe('codex connection setup', () => {
  test('codexGatewayConnectionDefaults yields a codex-runtime Nessy Gateway connection', () => {
    const d = codexGatewayConnectionDefaults();
    expect(d.providerType).toBe('codex-runtime');
    expect(d.authType).toBe('api_key_with_endpoint');
    expect(d.baseUrl).toBe(NESSY_GATEWAY_BASE_URL);
    expect(d.defaultModel).toBe(NESSY_GATEWAY_DEFAULT_MODEL);
    expect(d.models).toEqual(NESSY_GATEWAY_MODELS);
    // reuses the gateway coder default (00-context). The id behind the
    // gateway's `coder` alias, re-measured 2026-09-11 (P6.1080) after the
    // gateway retired the previous one and began answering 404 for it.
    expect(d.defaultModel).toBe('tgpt/deepseek-v4-flash-0731');
  });
});
