/**
 * P2.428 — the UI half of P2.414's consequence (2): a codex session must SAY
 * that user- and plugin-authored hooks are not projected into codex's own
 * `[hooks]` table, and WHY, in the same surface that lists hooks on Pi.
 *
 * ## What this file exists to prevent
 *
 * P2.414 already delivered the sentence, once, as
 * `CODEX_HOOK_PROJECTION_NOTICE`. The row's warning is explicit: reuse it
 * rather than paraphrase it, "or the two will drift". The sentence cannot be
 * carried on the wire from this file, because `views.ts` is imported by the
 * RENDERER for a value (`plugin-update-affordance.tsx`) and the module holding
 * the constant imports `node:fs` — so a CODE crosses and the renderer holds the
 * localized copy.
 *
 * That is exactly the two-copy shape the row warns about, so the copies are
 * pinned MECHANICALLY here rather than by a comment asking the next reader to
 * be careful. Two transformations are allowed and both are spelled out in the
 * assertion: the `[codex-hooks] ` log prefix is dropped (it addresses a log
 * reader, not a user), and the first letter is capitalized (the constant is a
 * log line; this is a sentence in a panel). Nothing else may differ.
 *
 * **When this test goes red, both locales need the edit, not just `en`.** The
 * Russian value is a translation and cannot be byte-pinned to an English
 * constant; the pin below is the only thing that will tell you the source
 * sentence moved.
 */

import { describe, expect, it } from 'bun:test';
import { CODEX_HOOK_PROJECTION_NOTICE } from '@nessy-agent/codex-responses-adapter/config-writer';
import en from '../../i18n/locales/en.json' with { type: 'json' };
import ru from '../../i18n/locales/ru.json' with { type: 'json' };
import { CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE, toUserCatalog } from '../views.ts';
import type { CapabilityContext, EffectiveCapabilitySnapshot } from '../resolver.ts';
import type { AgentProvider } from '../../agent/backend/types.ts';

const NOTICE_KEY = 'sourcesHooks.codexProjectionNotice';
/** The one prefix dropped between the log line and the panel sentence. */
const LOG_PREFIX = '[codex-hooks] ';

function snapshot(provider?: AgentProvider): EffectiveCapabilitySnapshot {
  const context: CapabilityContext = {
    workspaceId: 'ws-1',
    sessionId: 'sess-1',
    projectTrustState: 'trusted',
    projectTrustRevision: 'trust-r1',
    ...(provider ? { provider } : {}),
  };
  return {
    context,
    generation: 'gen-1',
    leaseId: 'lease-1',
    entries: [],
    installedPlugins: [],
    diagnostics: [],
  };
}

function codes(provider?: AgentProvider): string[] {
  return toUserCatalog(snapshot(provider)).diagnostics.map(diagnostic => diagnostic.code);
}

describe('codex hook-projection notice', () => {
  it('reaches the catalog on codex and on no other runtime', () => {
    expect(codes('codex-runtime')).toEqual([CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE]);
    expect(codes('pi')).toEqual([]);
    expect(codes('anthropic')).toEqual([]);
    expect(codes('nestor-cloud-agent')).toEqual([]);
    // Provider-neutral catalog/browse resolution: no session, so nothing to say.
    expect(codes()).toEqual([]);
  });

  it('carries no capabilityKey, so it never lands on a detail page', () => {
    const [diagnostic] = toUserCatalog(snapshot('codex-runtime')).diagnostics;
    expect(diagnostic?.capabilityKey).toBeUndefined();
    // `info`: the hooks are not broken and not unavailable — they run host-side.
    expect(diagnostic?.severity).toBe('info');
    expect(diagnostic?.messageKey).toBe(CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE);
  });

  it('does not displace the snapshot diagnostics it is appended to', () => {
    const base = snapshot('codex-runtime');
    const withOwn: EffectiveCapabilitySnapshot = {
      ...base,
      diagnostics: [{ severity: 'error', code: 'plugin.user_config.unset', message: 'x' }],
    };
    expect(toUserCatalog(withOwn).diagnostics.map(d => d.code))
      .toEqual(['plugin.user_config.unset', CODEX_HOOK_PROJECTION_DIAGNOSTIC_CODE]);
  });

  it('renders the P2.414 sentence itself, not a paraphrase of it', () => {
    const localized = (en as Record<string, string>)[NOTICE_KEY];
    expect(localized).toBeTypeOf('string');
    const sentence = localized!;
    expect(`${LOG_PREFIX}${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`)
      .toBe(CODEX_HOOK_PROJECTION_NOTICE);
  });

  it('is translated in ru rather than copied from en', () => {
    const russian = (ru as Record<string, string>)[NOTICE_KEY];
    expect(russian).toBeTypeOf('string');
    const translated = russian!;
    expect(translated.length).toBeGreaterThan(0);
    expect(translated).not.toBe((en as Record<string, string>)[NOTICE_KEY]);
    // The two halves the sentence must keep in any language: what is not
    // projected, and that those hooks still run.
    expect(translated).toContain('НЕ проецируются');
    expect(translated).toContain('на стороне хоста');
  });
});
