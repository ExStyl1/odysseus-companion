/**
 * Tests for model detection utilities in config/models.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  isClaudeModel,
  getModelShortName,
  getModelDisplayName,
  getModelContextWindow,
  getModelById,
  ANTHROPIC_MODELS,
  DEFAULT_MODEL,
  getDefaultSummarizationModel,
  getModelIdByShortName,
  isAdaptiveThinkingAlwaysOnModel,
  normalizeDeprecatedModelId,
} from '../src/config/models.ts';

describe('isClaudeModel', () => {
  // Direct Anthropic model IDs
  it('detects direct Anthropic Claude model IDs', () => {
    expect(isClaudeModel('claude-sonnet-4-6')).toBe(true);
    expect(isClaudeModel('claude-opus-4-8')).toBe(true);
    expect(isClaudeModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isClaudeModel('claude-3-5-sonnet-20241022')).toBe(true);
  });

  // OpenRouter provider-prefixed Claude IDs
  it('detects OpenRouter-prefixed Claude model IDs', () => {
    expect(isClaudeModel('anthropic/claude-sonnet-4')).toBe(true);
    expect(isClaudeModel('anthropic/claude-opus-4-7')).toBe(true);
    expect(isClaudeModel('anthropic/claude-3.5-haiku')).toBe(true);
  });

  // Non-Claude models via OpenRouter
  it('rejects non-Claude OpenRouter models', () => {
    expect(isClaudeModel('openai/gpt-5')).toBe(false);
    expect(isClaudeModel('openai/gpt-4o')).toBe(false);
    expect(isClaudeModel('google/gemini-2.5-pro')).toBe(false);
    expect(isClaudeModel('meta-llama/llama-4-maverick')).toBe(false);
    expect(isClaudeModel('deepseek/deepseek-r1')).toBe(false);
    expect(isClaudeModel('mistralai/mistral-large')).toBe(false);
  });

  // Non-Claude models via Ollama (no provider prefix)
  it('rejects non-Claude Ollama models', () => {
    expect(isClaudeModel('llama3.2')).toBe(false);
    expect(isClaudeModel('deepseek-r1')).toBe(false);
    expect(isClaudeModel('qwen3-coder')).toBe(false);
    expect(isClaudeModel('mistral')).toBe(false);
    expect(isClaudeModel('gemma2')).toBe(false);
  });

  // Bedrock-native model IDs
  it('detects Bedrock-native Claude model IDs', () => {
    expect(isClaudeModel('anthropic.claude-opus-4-8')).toBe(true);
    expect(isClaudeModel('anthropic.claude-sonnet-4-6')).toBe(true);
    expect(isClaudeModel('anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(true);
  });

  // Case insensitivity
  it('handles case variations', () => {
    expect(isClaudeModel('Claude-Sonnet-4-6')).toBe(true);
    expect(isClaudeModel('CLAUDE-OPUS-4-8')).toBe(true);
    expect(isClaudeModel('Anthropic/Claude-Sonnet-4')).toBe(true);
  });
});

describe('getModelShortName', () => {
  it('returns registry shortName for known models', () => {
    expect(getModelShortName('claude-opus-4-8')).toBe('Opus');
    expect(getModelShortName('claude-sonnet-4-6')).toBe('Sonnet');
    expect(getModelShortName('claude-haiku-4-5-20251001')).toBe('Haiku');
  });

  it('strips provider prefix for slash-separated IDs', () => {
    expect(getModelShortName('openai/gpt-5.4')).toBe('gpt-5.4');
    expect(getModelShortName('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  it('preserves version numbers for custom endpoint models', () => {
    expect(getModelShortName('gpt-5.4')).toBe('Gpt 5.4');
    expect(getModelShortName('gpt-5.2')).toBe('Gpt 5.2');
    expect(getModelShortName('glm-4.7')).toBe('Glm 4.7');
  });

  it('humanizes bare model names without versions', () => {
    expect(getModelShortName('mistral')).toBe('Mistral');
    expect(getModelShortName('gemma2')).toBe('Gemma2');
  });

  it('humanizes multi-part model names', () => {
    expect(getModelShortName('mistral-large')).toBe('Mistral large');
    expect(getModelShortName('deepseek-r1')).toBe('Deepseek r1');
  });

  it('strips date suffix for unknown claude models', () => {
    expect(getModelShortName('claude-sonnet-3-5-20241022')).toBe('Sonnet 3.5');
  });
});

describe('Opus registry', () => {
  it('includes Opus 4.8 and keeps Opus 4.7, but excludes deprecated Opus 4.6', () => {
    const ids = ANTHROPIC_MODELS.map(m => m.id);
    expect(ids).toContain('claude-opus-4-8');
    expect(ids).toContain('claude-opus-4-7');
    expect(ids).not.toContain('claude-opus-4-6');
  });

  it('resolves "Opus" shortName to 4.8', () => {
    expect(getModelIdByShortName('Opus')).toBe('claude-opus-4-8');
  });

  it('normalizes deprecated Opus IDs to Opus 4.8 without migrating Opus 4.7', () => {
    expect(normalizeDeprecatedModelId('claude-opus-4-6')).toBe('claude-opus-4-8');
    expect(normalizeDeprecatedModelId('pi/claude-opus-4-6')).toBe('pi/claude-opus-4-8');
    expect(normalizeDeprecatedModelId('us.anthropic.claude-opus-4-6-v1')).toBe('us.anthropic.claude-opus-4-8');
    expect(normalizeDeprecatedModelId('claude-opus-4-7')).toBe('claude-opus-4-7');
  });
});

describe('Claude Opus 5 registration', () => {
  it('is registered as an Anthropic model with a 1M context window', () => {
    const opus5 = ANTHROPIC_MODELS.find(m => m.id === 'claude-opus-5');
    expect(opus5).toBeDefined();
    expect(opus5!.provider).toBe('anthropic');
    expect(opus5!.name).toBe('Opus 5');
    expect(opus5!.shortName).toBe('Opus');
    expect(opus5!.contextWindow).toBe(1_000_000);
    expect(opus5!.descriptionKey).toBe('model.opusDesc');
  });

  it('resolves display name, short name and context window from the registry', () => {
    expect(getModelById('claude-opus-5')?.id).toBe('claude-opus-5');
    expect(getModelDisplayName('claude-opus-5')).toBe('Opus 5');
    expect(getModelShortName('claude-opus-5')).toBe('Opus');
    expect(getModelContextWindow('claude-opus-5')).toBe(1_000_000);
    expect(isClaudeModel('claude-opus-5')).toBe(true);
  });

  it('does NOT take over the "Opus" shortName slot that DEFAULT_MODEL derives from', () => {
    // `DEFAULT_MODEL = getModelIdByShortName('Opus')` resolves to the FIRST Opus
    // entry in MODEL_REGISTRY, and that constant is the runtime model fallback
    // (`claude-agent.ts`: `session?.model ?? config.model ?? DEFAULT_MODEL`).
    // Opus 5 is a catalog entry while BYOK stays feature-flag-off, so it is
    // registered right AFTER Opus 4.8 and the fallback is left where it was.
    expect(getModelIdByShortName('Opus')).toBe('claude-opus-4-8');
    expect(DEFAULT_MODEL).toBe('claude-opus-4-8');
    expect(ANTHROPIC_MODELS[0]!.id).toBe('claude-opus-4-8');
  });
});

describe('Sonnet registry', () => {
  it('includes Sonnet 5 and keeps Sonnet 4.6', () => {
    const ids = ANTHROPIC_MODELS.map(m => m.id);
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-sonnet-4-6');
  });

  it('resolves "Sonnet" shortName to Sonnet 5', () => {
    expect(getModelIdByShortName('Sonnet')).toBe('claude-sonnet-5');
  });

  it('exposes Sonnet 5 metadata', () => {
    expect(getModelDisplayName('claude-sonnet-5')).toBe('Sonnet 5');
    expect(getModelShortName('claude-sonnet-5')).toBe('Sonnet');
    expect(getModelContextWindow('claude-sonnet-5')).toBe(1_000_000);
  });

  it('maps Bedrock Sonnet 5 IDs back to the bare ID', () => {
    expect(getModelById('us.anthropic.claude-sonnet-5')?.id).toBe('claude-sonnet-5');
    expect(getModelById('anthropic.claude-sonnet-5')?.id).toBe('claude-sonnet-5');
  });
});

/**
 * F1.1214 — the three models the models overview lists as current
 * (platform.claude.com/docs/en/models/overview.md, "Context window" row:
 * "1M tokens" for each of Claude Fable 5.1, Claude Opus 5.5 and Claude Sonnet 5.5).
 * Without a row (and with no window from the connection) the host treats them
 * as 200K: no `[1m]` selector and a 200K BackendConfig window (F1.1241).
 */
describe('Claude Fable 5.1, Opus 5.5 and Sonnet 5.5 registration', () => {
  const NEW_ROWS = [
    { id: 'claude-fable-5-1', name: 'Fable 5.1', shortName: 'Fable' },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', shortName: 'Opus' },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', shortName: 'Sonnet' },
  ] as const;

  it('registers each with the documented 1M window, in bare and Bedrock-native form', () => {
    for (const row of NEW_ROWS) {
      const model = ANTHROPIC_MODELS.find(m => m.id === row.id);
      expect(model?.provider).toBe('anthropic');
      expect(model?.name).toBe(row.name);
      expect(model?.shortName).toBe(row.shortName);
      expect(getModelContextWindow(row.id)).toBe(1_000_000);
      expect(getModelContextWindow(`us.anthropic.${row.id}`)).toBe(1_000_000);
      expect(getModelDisplayName(row.id)).toBe(row.name);
    }
  });

  it('takes no shortName slot, so DEFAULT_MODEL and the first Sonnet and Fable rows do not move', () => {
    expect(DEFAULT_MODEL).toBe('claude-opus-4-8');
    expect(ANTHROPIC_MODELS[0]!.id).toBe('claude-opus-4-8');
    expect(getModelIdByShortName('Opus')).toBe('claude-opus-4-8');
    expect(getModelIdByShortName('Sonnet')).toBe('claude-sonnet-5');
    expect(getModelIdByShortName('Fable')).toBe('claude-fable-5');
    // Boundary: a neighbouring id the docs do not list stays unregistered.
    expect(getModelContextWindow('claude-opus-5-6')).toBeUndefined();
  });
});

/**
 * F1.1221 — Claude Sonnet 4.6 has a 1M window, and 1M is its default on the API
 * (platform.claude.com/docs/en/build-with-claude/context-windows.md: "Claude
 * Sonnet 4.6 ... have a 1M-token context window" and "For every model with a
 * 1M-token context window, 1M is the default: you don't need a beta header").
 * The same page keeps Sonnet 4.5 at 200k, which is the boundary arm.
 */
describe('Claude Haiku 5.5 registration (UB7.14, OQ-B2.1 (a))', () => {
  it('registers Haiku 5.5 at the documented 1M window and keeps Haiku 4.5 at 200k', () => {
    const model = ANTHROPIC_MODELS.find(m => m.id === 'claude-haiku-5-5');
    expect(model?.provider).toBe('anthropic');
    expect(model?.name).toBe('Haiku 5.5');
    expect(getModelContextWindow('claude-haiku-5-5')).toBe(1_000_000);
    expect(getModelContextWindow('us.anthropic.claude-haiku-5-5')).toBe(1_000_000);
    expect(getModelContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
  });

  it('takes the FIRST Haiku slot so the summarisation default resolves to it, and only that slot', () => {
    expect(getDefaultSummarizationModel()).toBe('claude-haiku-5-5');
    expect(getModelIdByShortName('Haiku')).toBe('claude-haiku-5-5');
    // The slots that must not move: the row sits after every Sonnet and Opus.
    expect(getModelIdByShortName('Sonnet')).toBe('claude-sonnet-5');
    expect(getModelIdByShortName('Opus')).toBe('claude-opus-4-8');
    expect(DEFAULT_MODEL).toBe('claude-opus-4-8');
  });

  it('is NOT in the adaptive-always-on set: our off stays disabled (the docs-backed deviation)', () => {
    // The thinking page (curled 2026-10-14 by B2): Haiku 5.5 "accepts
    // `thinking: {type: "disabled"}` at effort `high` or below" — unlike
    // Sonnet 5.5, whose lowest is between_tools. Upstream's own registry row
    // marks it thinkingAlwaysOn and maps off to low-effort adaptive; ours does
    // not, and this pin is the deviation's enforcer.
    expect(isAdaptiveThinkingAlwaysOnModel('claude-haiku-5-5')).toBe(false);
    expect(isAdaptiveThinkingAlwaysOnModel('claude-sonnet-5-5')).toBe(true);
  });
});
describe('Claude Sonnet 4.6 context window', () => {
  it('registers Sonnet 4.6 at 1M, in bare and Bedrock-native form', () => {
    expect(getModelContextWindow('claude-sonnet-4-6')).toBe(1_000_000);
    expect(getModelContextWindow('us.anthropic.claude-sonnet-4-6')).toBe(1_000_000);
  });

  it('keeps the 200k models at 200k and Sonnet 4.6 out of the Sonnet slot', () => {
    expect(getModelContextWindow('claude-sonnet-4-5-20250929')).toBe(200_000);
    expect(getModelContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(getModelIdByShortName('Sonnet')).toBe('claude-sonnet-5');
  });
});
