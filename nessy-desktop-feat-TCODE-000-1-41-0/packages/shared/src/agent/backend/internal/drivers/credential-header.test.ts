/**
 * P6.258 — the connection's credential-header choice reaches the upstream target.
 *
 * The adapter's own suite proves the header leaves in the request; this one
 * proves the CONNECTION field gets there.
 *
 * **Both arms since P6.585.** P6.258 took the `claude-runtime` arm alone and
 * asserted the codex boundary rather than merely writing it down: widening the
 * codex observability sink meant writing `codex-agent.ts`, a hot-spot file that
 * lane could not touch, and the two go together (an x-api-key codex session with
 * a sink that cannot say so is worse than one that cannot happen). P6.585 landed
 * both in one commit, so the boundary row below became the parity row it named.
 *
 * The gateway row is the control: `Nestor-Token` is the only scheme that URL may
 * carry, so a `credentialHeader` on a gateway connection must change nothing.
 */
import { describe, expect, it } from 'bun:test';
import type { LlmConnection } from '../../../../config/llm-connections.ts';
import { buildClaudeRuntimeUpstream } from './anthropic.ts';
import { buildCodexRuntimeUpstream } from './codex.ts';
import { NESSY_GATEWAY_CHAT_BASE_URL } from './upstream-target.ts';

const BYO = (extra: Partial<LlmConnection> = {}): LlmConnection => ({
  slug: 'byo',
  name: 'A domain endpoint',
  providerType: 'claude-runtime',
  authType: 'api_key_with_endpoint',
  baseUrl: 'https://llm.example.internal/v1',
  createdAt: 1,
  ...extra,
});

describe('credentialHeader reaches the upstream target', () => {
  it('claude-runtime carries the choice', () => {
    const target = buildClaudeRuntimeUpstream(
      BYO({ customEndpoint: { api: 'openai-completions', credentialHeader: 'x-api-key' } }),
    );
    expect(target).toEqual({
      kind: 'openai-compatible',
      baseUrl: 'https://llm.example.internal/v1',
      credentialHeader: 'x-api-key',
    });
  });

  it('a connection that never set it stays undefined, which the transport reads as bearer', () => {
    expect(buildClaudeRuntimeUpstream(BYO()))
      .toEqual({ kind: 'openai-compatible', baseUrl: 'https://llm.example.internal/v1', credentialHeader: undefined });
  });

  it('codex-runtime carries the choice too (P6.585 — the boundary this row used to assert)', () => {
    const target = buildCodexRuntimeUpstream(
      BYO({ providerType: 'codex-runtime', customEndpoint: { api: 'openai-completions', credentialHeader: 'x-api-key' } }),
    );
    expect(target).toEqual({
      kind: 'openai-compatible',
      baseUrl: 'https://llm.example.internal/v1',
      credentialHeader: 'x-api-key',
    });
  });

  it('a codex connection that never set it stays undefined, which the transport reads as bearer', () => {
    expect(buildCodexRuntimeUpstream(BYO({ providerType: 'codex-runtime' })))
      .toEqual({ kind: 'openai-compatible', baseUrl: 'https://llm.example.internal/v1', credentialHeader: undefined });
  });

  it('control — the gateway arm is unchanged on both runtimes even if the field is set', () => {
    const gateway = BYO({
      baseUrl: NESSY_GATEWAY_CHAT_BASE_URL,
      customEndpoint: { api: 'openai-completions', credentialHeader: 'x-api-key' },
    });
    expect(buildClaudeRuntimeUpstream(gateway)).toEqual({ kind: 'nestor' });
    expect(buildCodexRuntimeUpstream(gateway)).toEqual({ kind: 'nestor' });
    // The gateway arm is where an x-api-key would be most dangerous, and it is
    // structurally unreachable: the branch returns before the field is read.
  });
});
