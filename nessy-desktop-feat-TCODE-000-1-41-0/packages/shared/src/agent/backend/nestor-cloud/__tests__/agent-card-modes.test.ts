import { describe, expect, it } from 'bun:test';
import {
  NESTOR_AGENT_SETTINGS_EXTENSION_URI,
  parseNestorCloudAgentCardModes,
} from '../agent-card-modes.ts';
import type { NestorAgentCard } from '../types.ts';

function card(modeEnum: unknown, extra: Partial<NestorAgentCard> = {}): NestorAgentCard {
  return {
    extension: [{
      uri: NESTOR_AGENT_SETTINGS_EXTENSION_URI,
      params: {
        agentSettingsSchema: {
          properties: {
            mode: {
              enum: modeEnum,
            },
          },
        },
      },
    }],
    ...extra,
  };
}

describe('parseNestorCloudAgentCardModes', () => {
  it('returns null when the agent settings extension is missing', () => {
    expect(parseNestorCloudAgentCardModes({})).toBeNull();
  });

  it('returns null for an empty mode enum', () => {
    expect(parseNestorCloudAgentCardModes(card([]))).toBeNull();
  });

  it('returns null for malformed params', () => {
    expect(parseNestorCloudAgentCardModes({
      extension: [{ uri: NESTOR_AGENT_SETTINGS_EXTENSION_URI, params: { nope: true } }],
    })).toBeNull();
  });

  it('maps plan and act into composer-safe local modes', () => {
    const parsed = parseNestorCloudAgentCardModes(card(['plan', 'act']));

    expect(parsed?.defaultModeId).toBe('act');
    expect(parsed?.remoteModeIds).toEqual(['plan', 'act']);
    expect(parsed?.modeOptions.map(({ mode, label, remoteModeId }) => ({ mode, label, remoteModeId }))).toEqual([
      { mode: 'plan', label: 'Plan', remoteModeId: 'plan' },
      { mode: 'default', label: 'Act', remoteModeId: 'act' },
    ]);
  });

  it('preserves a future string id when no act mode is advertised', () => {
    const parsed = parseNestorCloudAgentCardModes(card(['review']));

    expect(parsed?.defaultModeId).toBe('review');
    expect(parsed?.remoteModeIds).toEqual(['review']);
    expect(parsed?.modeOptions).toEqual([{
      mode: 'default',
      label: 'Review',
      shortLabel: 'Review',
      description: 'Remote Review mode.',
      iconMode: 'default',
      remoteModeId: 'review',
    }]);
  });

  it('supports plural extensions and deduplicates mode ids', () => {
    const parsed = parseNestorCloudAgentCardModes(card([], {
      extension: undefined,
      extensions: [{
        uri: NESTOR_AGENT_SETTINGS_EXTENSION_URI,
        params: {
          agentSettingsSchema: {
            properties: {
              mode: { enum: ['plan', 'plan', 'act'] },
            },
          },
        },
      }],
    }));

    expect(parsed?.remoteModeIds).toEqual(['plan', 'act']);
  });
});
