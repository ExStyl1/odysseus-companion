/**
 * Tests for Nessy model utilities in config/models.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_MODEL,
  NESSY_MODELS,
  getModelShortName,
  getModelDisplayName,
  getModelContextWindow,
  getModelProvider,
  isNessyModel,
} from '../src/config/models.ts';

describe('Nessy model registry', () => {
  it('uses qwen3-coder as the fallback model', () => {
    expect(DEFAULT_MODEL).toBe('qwen3-coder');
    expect(NESSY_MODELS.map(model => model.id)).toContain('qwen3-coder');
  });

  it('detects Nessy model IDs', () => {
    expect(isNessyModel('qwen3-coder')).toBe(true);
    expect(isNessyModel('NESSY_MAX')).toBe(true);
    expect(isNessyModel('gpt-4o')).toBe(false);
  });

  it('resolves provider metadata for Nessy models', () => {
    expect(getModelProvider('qwen3-coder')).toBe('nessy');
    expect(getModelProvider('qwen-max')).toBe('nessy');
    expect(getModelProvider('gpt-4o')).toBeUndefined();
  });

  it('formats Nessy model names', () => {
    expect(getModelShortName('qwen3-coder')).toBe('Nessy');
    expect(getModelDisplayName('qwen-max')).toBe('Nessy max');
    expect(getModelContextWindow('qwen3-coder')).toBe(1_000_000);
  });
});
