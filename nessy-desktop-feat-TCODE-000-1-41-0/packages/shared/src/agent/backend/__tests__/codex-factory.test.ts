/**
 * Task 3.6 gate: codex-runtime factory wiring + feature-flag gating.
 *
 * Asserts the pure factory mappings (no CodexAgent construction — that side of
 * the wiring is exercised by the Phase 3 e2e harness) and that
 * getAvailableProviders() follows NESSY_FEATURE_CODEX_RUNTIME. Default flipped
 * 2026-08-06 (owner decision): the runtime ships by default and `=0` opts out.
 */
import { test, expect, describe, afterEach } from 'bun:test';
import {
  BACKEND_CAPABILITIES,
  getAvailableProviders,
  providerTypeToAgentProvider,
  getDefaultAuthType,
} from '../factory.ts';

const FLAG = 'NESSY_FEATURE_CODEX_RUNTIME';
const CLAUDE_FLAG = 'NESSY_FEATURE_CLAUDE_RUNTIME';

describe('codex-runtime factory wiring', () => {
  afterEach(() => {
    delete process.env[FLAG];
    delete process.env[CLAUDE_FLAG];
  });

  test('providerTypeToAgentProvider maps codex-runtime → codex-runtime', () => {
    expect(providerTypeToAgentProvider('codex-runtime')).toBe('codex-runtime');
    // existing mappings unchanged
    expect(providerTypeToAgentProvider('pi')).toBe('pi');
    expect(providerTypeToAgentProvider('pi_compat')).toBe('pi');
    expect(providerTypeToAgentProvider('anthropic')).toBe('anthropic');
  });

  test('getDefaultAuthType(codex-runtime) is api_key_with_endpoint', () => {
    expect(getDefaultAuthType('codex-runtime')).toBe('api_key_with_endpoint');
  });

  test('codex-runtime requests the per-session HTTP MCP pool bridge', () => {
    expect(BACKEND_CAPABILITIES['codex-runtime'].needsHttpPoolServer).toBe(true);
  });

  test('getAvailableProviders includes codex-runtime by default (flag unset — default flipped 2026-08-06)', () => {
    delete process.env[FLAG];
    delete process.env[CLAUDE_FLAG];
    expect(getAvailableProviders()).toEqual(['anthropic', 'pi', 'nestor-cloud-agent', 'codex-runtime']);
  });

  test('getAvailableProviders includes codex-runtime with NESSY_FEATURE_CODEX_RUNTIME=1', () => {
    process.env[FLAG] = '1';
    process.env[CLAUDE_FLAG] = '0';
    expect(getAvailableProviders()).toEqual(['pi', 'nestor-cloud-agent', 'codex-runtime']);
  });

  test('getAvailableProviders excludes codex-runtime with the flag explicitly 0', () => {
    process.env[FLAG] = '0';
    process.env[CLAUDE_FLAG] = '0';
    expect(getAvailableProviders()).toEqual(['pi', 'nestor-cloud-agent']);
  });
});
