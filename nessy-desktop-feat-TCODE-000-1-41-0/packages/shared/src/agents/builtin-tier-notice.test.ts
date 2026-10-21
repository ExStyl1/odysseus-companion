/**
 * P6.156 — the aggregated inert-tier line, and the two locales that carry it.
 *
 * The behaviour is driven end to end through the claude arm in
 * `agent/__tests__/claude-builtin-agent-tier.test.ts`; this file pins the two
 * things that live here and nowhere else: the structural answer a caller can act
 * on without parsing prose, and the sentence existing in BOTH locales with both
 * of its placeholders filled. A locale that keeps the key and loses `{{agents}}`
 * passes `lint:i18n:parity` and `lint:i18n:sorted` and is still wrong.
 */
import { describe, expect, it } from 'bun:test';
import {
  buildBuiltinAgentTierNotice,
  inertBuiltinAgentTiers,
} from './builtin-tier-notice.ts';
import { BUILTIN_AGENT_DEFINITIONS } from './definitions.ts';
import { i18n, setupI18n } from '../i18n/index.ts';
import { SUPPORTED_LANGUAGE_CODES } from '../i18n/languages.ts';

const FULL_MAP = { small: 'x/small', medium: 'x/medium', big: 'x/big' } as const;

describe('inertBuiltinAgentTiers', () => {
  it('with no map, every bundled agent is inert', () => {
    expect(inertBuiltinAgentTiers().map(e => e.agent).sort())
      .toEqual(BUILTIN_AGENT_DEFINITIONS.map(d => d.name).sort());
  });

  it('with a full map, none is', () => {
    expect(inertBuiltinAgentTiers(FULL_MAP)).toEqual([]);
  });

  it('an EMPTY id counts as unresolved, not as resolved', () => {
    // The guard that matters on a catalogue with no fast alias: the host writes
    // the key with nothing in it rather than omitting it.
    expect(inertBuiltinAgentTiers({ small: '' }).some(e => e.tier === 'small')).toBe(true);
  });
});

describe('buildBuiltinAgentTierNotice', () => {
  it('is ONE line, never one per agent', () => {
    expect(buildBuiltinAgentTierNotice()).toHaveLength(1);
  });

  it('is empty when every tier resolves', () => {
    expect(buildBuiltinAgentTierNotice(FULL_MAP)).toEqual([]);
  });

  it('both locales carry the key with both placeholders filled', () => {
    if (!i18n.isInitialized) setupI18n();
    const saved = i18n.language;
    try {
      for (const code of SUPPORTED_LANGUAGE_CODES) {
        i18n.changeLanguage(code);
        const line = buildBuiltinAgentTierNotice()[0]!;
        expect(line, `${code}: the key is missing or untranslated`).not.toContain('builtinAgentTier');
        expect(line, `${code}: {{agents}} was not interpolated`).not.toContain('{{');
        for (const definition of BUILTIN_AGENT_DEFINITIONS) {
          expect(line, `${code}: ${definition.name} is not named`).toContain(definition.name);
        }
        for (const tier of ['small', 'medium', 'big']) {
          expect(line, `${code}: the ${tier} tier is not named`).toContain(tier);
        }
      }
    } finally {
      i18n.changeLanguage(saved);
    }
  });
});
