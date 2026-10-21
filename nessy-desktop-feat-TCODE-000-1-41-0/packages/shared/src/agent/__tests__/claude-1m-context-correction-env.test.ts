/**
 * P3.44 — `CLAUDE_CODE_DISABLE_1M_CONTEXT`, the companion that makes
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` apply to a `[1m]` gateway id.
 *
 * The row is LATENT: no gateway alias contains `[1m]` today, so this env is
 * absent from every session we ship. Pinned anyway, because the day an alias
 * does carry the suffix the failure is a session that runs to 1M tokens against
 * a 262 000 window with nothing to say about it, and the symptom reads as "the
 * model got worse".
 *
 * Contract: `model-config.md#correct-the-window-for-a-gateway-or-custom-model-id`
 * — "If the ID doesn't start with `claude-` but contains `[1m]`, in any casing,
 * and Claude Code can't resolve it to a Claude model, Claude Code assumes a 1M
 * window for it and the variable doesn't apply on its own. To correct the window
 * while keeping proactive compaction, also set `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`."
 */
import { describe, expect, it } from 'bun:test';
import {
  buildClaude1MContextCorrectionEnv,
  buildClaudeMaxContextTokensEnv,
} from '../claude-agent.ts';
import { gatewayModelFixture } from '../../config/__tests__/fixtures/gateway-connection-fixture.ts';

/**
 * P6.784 — the rows that stand for a shipped gateway card come from the card's
 * own builder, which is what puts `supportsThinking: false` into them. Written
 * by hand the field was absent, and `ModelDefinition` documents it *"Defaults to
 * true when undefined"* while both shipped gateway rows declare `false` — so a
 * hand-written row stood for a card that reasons, which the shipped one does
 * not. Inert for THIS suite (the builders under test read `id` and
 * `contextWindow` only), which is exactly why it went unnoticed.
 *
 * `tgpt/unsized[1m]` stays hand-written: its whole subject is a catalogue entry
 * with NO window, and the builder seeds one from the card. It does not stand for
 * the card, so adopting it would delete the case.
 */
const gateway = {
  models: [
    { ...gatewayModelFixture({ id: 'tgpt/qwen35-397b-a17b-fp8', contextWindow: 262_000 }), name: 'Qwen 3.5' },
    { ...gatewayModelFixture({ id: 'tgpt/qwen35[1m]', contextWindow: 262_000 }), name: 'Qwen 3.5 long' },
    { ...gatewayModelFixture({ id: 'TGPT/QWEN35[1M]', contextWindow: 262_000 }), name: 'Shouty' },
    { id: 'tgpt/unsized[1m]', name: 'Unsized long' },
    { ...gatewayModelFixture({ id: 'claude-opus-4-8[1m]', contextWindow: 200_000 }), name: 'Opus long' },
  ],
} as unknown as Parameters<typeof buildClaude1MContextCorrectionEnv>[0];

describe('buildClaude1MContextCorrectionEnv', () => {
  it('emits nothing for every id shape we ship today', () => {
    // The whole default card, and the absence that makes this row latent rather
    // than exploitable. The positive control is the next test.
    expect(buildClaude1MContextCorrectionEnv(gateway, 'tgpt/qwen35-397b-a17b-fp8')).toEqual({});
    expect(buildClaude1MContextCorrectionEnv(gateway, undefined)).toEqual({});
  });

  it('emits the correction for a non-claude gateway id carrying [1m]', () => {
    // Without it the declared window below is inert and the binary assumes 1M.
    expect(buildClaudeMaxContextTokensEnv(gateway, 'tgpt/qwen35[1m]'))
      .toEqual({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: '262000' });
    expect(buildClaude1MContextCorrectionEnv(gateway, 'tgpt/qwen35[1m]'))
      .toEqual({ CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' });
  });

  it('matches the suffix and the claude- prefix in any casing, as the page says', () => {
    expect(buildClaude1MContextCorrectionEnv(gateway, 'TGPT/QWEN35[1M]'))
      .toEqual({ CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' });
  });

  it('leaves a claude-* [1m] id alone', () => {
    // Third case on the page: the binary resolves `claude-opus-4-8[1m]` to Opus
    // 4.8 "even with CLAUDE_CODE_DISABLE_1M_CONTEXT set". Nothing to correct —
    // and the variable would still strip 1M variants from the picker, a
    // capability the model has (F1.1241: each model's own window decides).
    expect(buildClaude1MContextCorrectionEnv(gateway, 'claude-opus-4-8[1m]')).toEqual({});
  });

  it('stays absent when there is no declared window to correct', () => {
    // The variable's documented job here is to make a DECLARED window apply.
    // With none, emitting it is a bare capability removal with nothing gained.
    expect(buildClaudeMaxContextTokensEnv(gateway, 'tgpt/unsized[1m]')).toEqual({});
    expect(buildClaude1MContextCorrectionEnv(gateway, 'tgpt/unsized[1m]')).toEqual({});
  });
});
