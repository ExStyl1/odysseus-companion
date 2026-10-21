import { describe, expect, it } from 'bun:test';
import { buildClaudeMaxContextTokensEnv } from '../claude-agent.ts';
import { gatewayModelFixture } from '../../config/__tests__/fixtures/gateway-connection-fixture.ts';

/**
 * P6.784 — the card-shaped rows come from the card's own builder, which is what
 * puts `supportsThinking: false` into them; by hand the field was absent, and
 * `ModelDefinition` documents it *"Defaults to true when undefined"* while both
 * shipped gateway rows declare `false`.
 *
 * `tgpt/unsized` and the bare string stay hand-written on purpose: the first is
 * a catalogue entry with NO window (the builder seeds one) and the second is not
 * an object.
 */
const gateway = {
  models: [
    { ...gatewayModelFixture({ id: 'tgpt/qwen35-397b-a17b-fp8', contextWindow: 262_144 }), name: 'Qwen 3.5' },
    { ...gatewayModelFixture({ id: 'tgpt/small', contextWindow: 40_960 }), name: 'Small' },
    { id: 'tgpt/unsized', name: 'Unsized' },
    'tgpt/bare-string',
  ],
} as unknown as Parameters<typeof buildClaudeMaxContextTokensEnv>[0];

describe('buildClaudeMaxContextTokensEnv', () => {
  it('tells the SDK the synced window of a gateway spawn model', () => {
    // Without this the SDK falls back to its own constant for an id it has no
    // catalogue entry for, and BOTH the context readout and the auto-compaction
    // point then describe a model that is not running.
    expect(buildClaudeMaxContextTokensEnv(gateway, 'tgpt/qwen35-397b-a17b-fp8'))
      .toEqual({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262144' });

    // The case that made this worth doing: a genuinely small window, which the
    // SDK would otherwise never learn about.
    expect(buildClaudeMaxContextTokensEnv(gateway, 'tgpt/small'))
      .toEqual({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: '40960' });
  });

  it('stays absent for a claude-* spawn model', () => {
    // Matching the binary's own guard (`NKc`: `!yo(Si(e)).startsWith("claude-")`).
    // Setting it anyway would be inert on the normal path but NOT under
    // DISABLE_COMPACT, where `MKc` reads the same env with no model gate.
    const anthropic = {
      models: [{ id: 'claude-opus-5', name: 'Opus 5', contextWindow: 200_000 }],
    } as unknown as Parameters<typeof buildClaudeMaxContextTokensEnv>[0];
    expect(buildClaudeMaxContextTokensEnv(anthropic, 'claude-opus-5')).toEqual({});
  });

  it('stays absent when nothing has stored a window for the spawn model', () => {
    // An unsized entry, a bare-string entry, an id the connection does not
    // carry, and no spawn model at all: a fabricated number here would be the
    // same lie F1 just removed from the Pi side.
    expect(buildClaudeMaxContextTokensEnv(gateway, 'tgpt/unsized')).toEqual({});
    expect(buildClaudeMaxContextTokensEnv(gateway, 'tgpt/bare-string')).toEqual({});
    expect(buildClaudeMaxContextTokensEnv(gateway, 'tgpt/not-in-catalogue')).toEqual({});
    expect(buildClaudeMaxContextTokensEnv(gateway, undefined)).toEqual({});
    expect(buildClaudeMaxContextTokensEnv({ models: undefined } as never, 'tgpt/small')).toEqual({});
  });

  it('rejects a window that is not a usable number', () => {
    // The binary requires `n > 0`; a 0, a negative or a NaN would produce an
    // env the SDK silently ignores, which is worse than not setting it.
    const broken = {
      models: [
        { id: 'a', name: 'a', contextWindow: 0 },
        { id: 'b', name: 'b', contextWindow: -1 },
        { id: 'c', name: 'c', contextWindow: Number.NaN },
      ],
    } as unknown as Parameters<typeof buildClaudeMaxContextTokensEnv>[0];
    for (const id of ['a', 'b', 'c']) {
      expect(buildClaudeMaxContextTokensEnv(broken, id)).toEqual({});
    }
  });
});
