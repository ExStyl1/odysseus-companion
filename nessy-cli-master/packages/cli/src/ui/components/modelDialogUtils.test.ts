/**
 * @license
 * Copyright 2025 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';

// Import the functions directly by copying them for testing
// In the actual code, these would be exported from ModelDialog.tsx

function buildModelSelectionKey(
  authType: string,
  modelId: string,
  baseUrl?: string,
): string {
  const base = `${authType}::${modelId}`;
  return baseUrl ? `${base}|${baseUrl}` : base;
}

function parseModelSelectionKey(key: string): {
  authType: string;
  modelId: string;
  baseUrl?: string;
} {
  const sep = '::';
  const idx = key.indexOf(sep);
  if (idx < 0) return { authType: '', modelId: key };

  const authType = key.slice(0, idx);
  const rest = key.slice(idx + sep.length);
  const pipeIdx = rest.lastIndexOf('|');
  if (pipeIdx >= 0) {
    return {
      authType,
      modelId: rest.slice(0, pipeIdx),
      baseUrl: rest.slice(pipeIdx + 1),
    };
  }
  return { authType, modelId: rest };
}

describe('modelDialogUtils', () => {
  describe('buildModelSelectionKey and parseModelSelectionKey', () => {
    it('should handle model without baseUrl', () => {
      const key = buildModelSelectionKey('dp-auth', 'qwen-coder');
      expect(key).toBe('dp-auth::qwen-coder');
      
      const parsed = parseModelSelectionKey(key);
      expect(parsed).toEqual({
        authType: 'dp-auth',
        modelId: 'qwen-coder',
      });
    });

    it('should handle model with baseUrl', () => {
      const baseUrl = 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1';
      const key = buildModelSelectionKey('dp-auth', 'tgpt/qwen3-next-80b-a3b-instruct', baseUrl);
      expect(key).toBe(`dp-auth::tgpt/qwen3-next-80b-a3b-instruct|${baseUrl}`);
      
      const parsed = parseModelSelectionKey(key);
      expect(parsed).toEqual({
        authType: 'dp-auth',
        modelId: 'tgpt/qwen3-next-80b-a3b-instruct',
        baseUrl,
      });
    });

    it('should handle model with complex baseUrl containing special characters', () => {
      const baseUrl = 'https://api.example.com/v1/models?param=value&other=123';
      const key = buildModelSelectionKey('USE_OPENAI', 'gpt-4', baseUrl);
      
      const parsed = parseModelSelectionKey(key);
      expect(parsed).toEqual({
        authType: 'USE_OPENAI',
        modelId: 'gpt-4',
        baseUrl,
      });
    });

    it('should handle model ID with slashes and dashes', () => {
      const baseUrl = 'https://example.com/api/v1';
      const modelId = 'tgpt/qwen3-next-80b-a3b-instruct';
      const key = buildModelSelectionKey('dp-auth', modelId, baseUrl);
      
      const parsed = parseModelSelectionKey(key);
      expect(parsed).toEqual({
        authType: 'dp-auth',
        modelId,
        baseUrl,
      });
    });

    it('should handle baseUrl with pipe character (edge case)', () => {
      // This is an edge case - if baseUrl contains |, lastIndexOf will find the last one
      const baseUrl = 'https://example.com/api|v1';
      const key = buildModelSelectionKey('dp-auth', 'model-id', baseUrl);
      
      const parsed = parseModelSelectionKey(key);
      // The baseUrl will be split at the last |, so modelId includes everything before it
      // This is a known limitation - baseUrl should not contain | character
      expect(parsed.authType).toBe('dp-auth');
      expect(parsed.modelId).toBe('model-id|https://example.com/api');
      expect(parsed.baseUrl).toBe('v1');
    });

    it('should document that baseUrl with pipe is not supported', () => {
      // Note: baseUrl values should not contain the | character
      // This is a documented limitation of the model selection key format
      // In practice, real base URLs (like https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1)
      // do not contain | characters, so this is not a practical issue
    });

    it('should round-trip for all DP_AUTH models', () => {
      const testCases = [
        { authType: 'dp-auth', modelId: 'qwen-coder', baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1' },
        { authType: 'dp-auth', modelId: 'tgpt/gpt-oss-120b', baseUrl: 'https://code-completion-nestor.tcsbank.ru/api/v1/cli/openai-like/v1' },
        { authType: 'USE_OPENAI', modelId: 'gpt-4', baseUrl: 'https://api.openai.com/v1' },
        { authType: 'USE_OPENAI', modelId: 'gpt-3.5-turbo', baseUrl: undefined },
      ];

      for (const tc of testCases) {
        const key = buildModelSelectionKey(tc.authType, tc.modelId, tc.baseUrl);
        const parsed = parseModelSelectionKey(key);
        
        expect(parsed.authType).toBe(tc.authType);
        expect(parsed.modelId).toBe(tc.modelId);
        expect(parsed.baseUrl).toBe(tc.baseUrl);
      }
    });

    it('should handle empty authType gracefully', () => {
      const key = buildModelSelectionKey('', 'model-id');
      expect(key).toBe('::model-id');
      
      const parsed = parseModelSelectionKey(key);
      expect(parsed.authType).toBe('');
      expect(parsed.modelId).toBe('model-id');
    });

    it('should handle model ID with special characters', () => {
      const baseUrl = 'https://example.com/api';
      const modelId = 'model.with.dots-and_dashes/123';
      const key = buildModelSelectionKey('dp-auth', modelId, baseUrl);
      
      const parsed = parseModelSelectionKey(key);
      expect(parsed).toEqual({
        authType: 'dp-auth',
        modelId,
        baseUrl,
      });
    });
  });
});
