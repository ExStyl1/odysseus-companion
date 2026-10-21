/**
 * `plugin-relevance.md` § How it works and § What the user sees, fetched
 * 2026-09-06 — the two surfaces this fork did not have, and the limits on them:
 *
 * "A given plugin's suggestion appears at most once every three sessions across
 * the spinner tip and the session-start notification combined, and neither
 * repeats once the plugin is installed. The session-start notification
 * additionally stops appearing after the suggestion has been shown twice."
 */
import { describe, expect, it } from 'bun:test';

import {
  pluginSuggestionKey,
  selectPluginSuggestion,
  type PluginSuggestionCandidate,
} from '../plugin-suggestion.ts';
import { parseMarketplaceRelevance } from '../relevance.ts';

const terraform: PluginSuggestionCandidate = {
  pluginName: 'terraform-helpers',
  marketplaceName: 'acme-corp-plugins',
  relevance: parseMarketplaceRelevance({ signals: { cwd: ['infra'] } }),
};
const context = {
  workingDirectory: '/Users/me/proj/infra',
  repositoryRoot: '/Users/me/proj',
  sessionOrdinal: 10,
};

describe('selectPluginSuggestion', () => {
  it('produces both surfaces, the documented id, command and default topic', () => {
    const suggestion = selectPluginSuggestion([terraform], context);
    expect(suggestion).toMatchObject({
      reference: 'terraform-helpers@acme-corp-plugins',
      installCommand: '/plugin install terraform-helpers@acme-corp-plugins',
      // "Defaults to the plugin name with each hyphen segment capitalized."
      topic: 'Terraform Helpers',
      signal: 'cwd',
      spinnerTip: true,
      sessionStart: true,
    });
    // A declared topic wins over the default.
    expect(selectPluginSuggestion([{
      ...terraform,
      relevance: parseMarketplaceRelevance({ topic: 'Terraform', signals: { cwd: ['infra'] } }),
    }], context)?.topic).toBe('Terraform');
    expect(pluginSuggestionKey(terraform)).toBe('terraform-helpers@acme-corp-plugins');
  });

  it('keeps the session-start notice to cwd matches only', () => {
    // A `manifestDeps` match still tips, but the notice fires before the first
    // turn, which is the only moment `cwd` can be the answer.
    const stripe: PluginSuggestionCandidate = {
      pluginName: 'stripe-helpers',
      marketplaceName: 'acme-corp-plugins',
      relevance: parseMarketplaceRelevance({
        signals: { manifestDeps: [{ file: '[/\\\\]package\\.json$', pattern: '"stripe"\\s*:' }] },
      }),
    };
    const suggestion = selectPluginSuggestion([stripe], {
      sessionOrdinal: 1,
      manifests: [{ path: '/p/package.json', content: '{"stripe":"^1"}' }],
    });
    expect(suggestion).toMatchObject({ signal: 'manifestDeps', spinnerTip: true, sessionStart: false });
  });

  it('stays silent when installed, off, unmatched, in cooldown, or already shown twice', () => {
    expect(selectPluginSuggestion([{ ...terraform, installed: true }], context)).toBeUndefined();
    // "Claude Code disables both when `spinnerTipsEnabled` resolves to `false`".
    expect(selectPluginSuggestion([terraform], { ...context, spinnerTipsEnabled: false })).toBeUndefined();
    expect(selectPluginSuggestion([terraform], { ...context, workingDirectory: '/Users/me/proj/docs' }))
      .toBeUndefined();
    // "at most once every three sessions" — shown at ordinal 8, silent at 10.
    const shown = { 'terraform-helpers@acme-corp-plugins': { shownCount: 1, lastShownSession: 8 } };
    expect(selectPluginSuggestion([terraform], { ...context, shown })).toBeUndefined();
    // …and audible again at 11, the third session after.
    expect(selectPluginSuggestion([terraform], { ...context, sessionOrdinal: 11, shown })?.spinnerTip)
      .toBe(true);
    // The notice, and only the notice, stops after two shows.
    const twice = { 'terraform-helpers@acme-corp-plugins': { shownCount: 2, lastShownSession: 1 } };
    expect(selectPluginSuggestion([terraform], { ...context, shown: twice }))
      .toMatchObject({ spinnerTip: true, sessionStart: false });
  });
});
