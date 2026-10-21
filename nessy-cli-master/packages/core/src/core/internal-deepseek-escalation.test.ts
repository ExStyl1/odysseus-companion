// [nessy-fork] internal-deepseek-64k-escalation
import { describe, it, expect } from 'vitest';
import { tokenLimit, ESCALATED_MAX_TOKENS } from './tokenLimits.js';

describe('Internal DeepSeek escalation limit', () => {
  it('should use 64K output limit for tgpt/deepseek-v4-flash-fp8', () => {
    const limit = tokenLimit('tgpt/deepseek-v4-flash-fp8', 'output');
    expect(limit).toBe(65536);
  });

  it('should use 64K output limit for tgpt/deepseek-v4-flash-0731', () => {
    const limit = tokenLimit('tgpt/deepseek-v4-flash-0731', 'output');
    expect(limit).toBe(65536);
  });

  it('should use 64K output limit for tgpt/deepseek-v4-flash (generic)', () => {
    const limit = tokenLimit('tgpt/deepseek-v4-flash', 'output');
    expect(limit).toBe(65536);
  });

  it('should use 384K output limit for non-internal DeepSeek V4 models', () => {
    expect(tokenLimit('deepseek-v4-flash', 'output')).toBe(384000);
    expect(tokenLimit('deepseek-v4-pro', 'output')).toBe(384000);
    // deepseek-v4 without suffix falls back to general deepseek limit (128K input, 32K output default)
    expect(tokenLimit('deepseek-v4', 'output')).toBe(32000);
  });

  it('should compute correct escalatedLimit for internal models', () => {
    // escalatedLimit = max(ESCALATED_MAX_TOKENS, tokenLimit(model, 'output'))
    // For internal models: max(64000, 65536) = 65536
    const internalLimit = tokenLimit('tgpt/deepseek-v4-flash-fp8', 'output');
    const escalatedLimit = Math.max(ESCALATED_MAX_TOKENS, internalLimit);
    expect(escalatedLimit).toBe(65536);
  });

  it('should compute correct escalatedLimit for external DeepSeek models', () => {
    // escalatedLimit = max(ESCALATED_MAX_TOKENS, tokenLimit(model, 'output'))
    // For external DeepSeek V4: max(64000, 384000) = 384000
    const externalLimit = tokenLimit('deepseek-v4-flash', 'output');
    const escalatedLimit = Math.max(ESCALATED_MAX_TOKENS, externalLimit);
    expect(escalatedLimit).toBe(384000);
  });
});
