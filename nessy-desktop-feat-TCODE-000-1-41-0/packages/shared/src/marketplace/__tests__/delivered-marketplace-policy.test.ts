/**
 * D13 — the managed schema half: what an administrator may write, and what a
 * mandate that names an uninstalled plugin looks like from `doctor`.
 *
 * `settings-reference.md#extraknownmarketplaces` documents the key — "Register
 * additional plugin marketplaces by name, so that people who open the
 * repository, or everyone your managed settings reach, get the marketplace
 * without adding it themselves"; `settings-reference.md#enabledplugins` makes a
 * managed `enabledPlugins: true` a fleet mandate — "**Managed settings**:
 * organization-wide policy" and "Plugins force-enabled by managed settings
 * can't be disabled this way, since managed settings override local settings."
 * The two are tested together
 * because they fail together: the mandate is what the marketplace exists to
 * serve, and a mandate with nothing to act on is the silent no-op this row is
 * about.
 */
import { describe, expect, it } from 'bun:test';
import { parseDeliveredMarketplaceEntryList } from '../../agent/pi-harness/managed-marketplace-entries.ts';
import {
  MANAGED_PI_POLICY_KEYS,
  parseManagedPiPolicyTolerantV1,
} from '../../agent/pi-harness/managed-policy.ts';
import type { ManagedPolicyDropV1 } from '../../config/managed-drops.ts';
import { resolveMandatedPluginFindings } from '../../plugins/mandated-plugins.ts';
import { buildConfigDoctorReport } from '../../config/config-doctor.ts';

function tolerantSink() {
  const drops: ManagedPolicyDropV1[] = [];
  return {
    drops,
    sink: {
      tolerant: true as const,
      drop: (field: string, reason: string, disposition: ManagedPolicyDropV1['disposition']) => {
        drops.push({ source: 'test', field, reason, disposition });
      },
    },
  };
}

function parse(value: unknown) {
  const { drops, sink } = tolerantSink();
  return { entries: parseDeliveredMarketplaceEntryList(value, { field: 'extraKnownMarketplaces', sink }), drops };
}

describe('parseDeliveredMarketplaceEntryList', () => {
  it('flattens the documented object-map shape to the source string the add path takes', () => {
    // The `settings-reference.md#extraknownmarketplaces` example document, in
    // our source vocabulary — "This example registers a GitHub marketplace and
    // a marketplace from a self-hosted git URL".
    const { entries, drops } = parse({
      'acme-tools': { source: { source: 'github', repo: 'acme-corp/claude-plugins' } },
      'security-plugins': { source: { source: 'git', url: 'https://git.example.com/security/plugins.git' } },
    });
    expect(drops).toEqual([]);
    expect(entries).toEqual([
      { name: 'acme-tools', source: 'acme-corp/claude-plugins' },
      { name: 'security-plugins', source: 'https://git.example.com/security/plugins.git' },
    ]);
  });

  it('accepts a bare source string and a pinned ref', () => {
    const { entries } = parse({ corp: { source: '/opt/approved/plugins', ref: 'release' } });
    expect(entries).toEqual([{ name: 'corp', source: '/opt/approved/plugins', refName: 'release' }]);
  });

  it('refuses the two source types that name no place, and keeps the rest', () => {
    const { entries, drops } = parse({
      pattern: { source: { source: 'hostPattern', hostPattern: '^gitlab\\.corp$' } },
      inline: { source: { source: 'settings', name: 'inline', plugins: [] } },
      corp: { source: { source: 'github', repo: 'corp/plugins' } },
    });
    expect(entries).toEqual([{ name: 'corp', source: 'corp/plugins' }]);
    expect(drops.map(drop => drop.field)).toEqual([
      'extraKnownMarketplaces.pattern',
      'extraKnownMarketplaces.inline',
    ]);
    expect(drops.every(drop => drop.disposition === 'stripped')).toBe(true);
  });

  /**
   * `settings-reference.md#extraknownmarketplaces` — "**Type**: object mapping
   * a marketplace name to an object with a `source` object and an optional
   * `autoUpdate` Boolean", and "Set `\"autoUpdate\": true` alongside `source`
   * to make Claude Code refresh that marketplace and update its installed
   * plugins in the background after startup."
   * Note "alongside": the key is a SIBLING of `source`, not a member of it.
   */
  it('carries an autoUpdate declared alongside source, in both accepted spellings', () => {
    const { entries, drops } = parse({
      corp: { source: { source: 'github', repo: 'corp/plugins' }, autoUpdate: true },
      other: { source: 'other/plugins', autoUpdate: false },
    });
    expect(drops).toEqual([]);
    expect(entries).toEqual([
      { name: 'corp', source: 'corp/plugins', autoUpdate: true },
      { name: 'other', source: 'other/plugins', autoUpdate: false },
    ]);
    // The array spelling carries it too.
    expect(parse([{ name: 'corp', source: 'corp/plugins', autoUpdate: true }]).entries)
      .toEqual([{ name: 'corp', source: 'corp/plugins', autoUpdate: true }]);
  });

  /**
   * The receipt is the point. Before this the key was dropped one function
   * earlier than the drop sink, so an administrator following `settings.md`
   * got a policy that looked accepted and scheduled nothing.
   */
  it('records a receipt for a non-Boolean autoUpdate but still delivers the marketplace', () => {
    // `autoUpdate` MODIFIES an entry; `name`/`source`/`ref` IDENTIFY it. A typo
    // in the optional modifier must not take the marketplace away from the whole
    // fleet — the entry is delivered with the flag absent, so it falls back to
    // the documented polarity (off for everything but an official Anthropic
    // marketplace), and the receipt tells the administrator why.
    const { entries, drops } = parse({
      corp: { source: 'corp/plugins', autoUpdate: 'yes' },
      good: { source: 'good/plugins', autoUpdate: true },
    });
    expect(entries).toEqual([
      { name: 'corp', source: 'corp/plugins' },
      { name: 'good', source: 'good/plugins', autoUpdate: true },
    ]);
    expect(drops).toEqual([{
      source: 'test',
      field: 'extraKnownMarketplaces.corp',
      reason: 'invalid delivered marketplace autoUpdate',
      disposition: 'stripped',
    }]);
  });

  it('delivers nothing at all from a wholly invalid value', () => {
    const { entries, drops } = parse(42);
    expect(entries).toEqual([]);
    expect(drops[0]?.disposition).toBe('emptied');
  });

  it('registers one row for a source two names point at', () => {
    const { entries } = parse({
      first: { source: 'corp/plugins' },
      second: { source: 'corp/plugins' },
    });
    expect(entries).toEqual([{ name: 'first', source: 'corp/plugins' }]);
  });
});

describe('the managed policy carries the delivery', () => {
  it('is a policy key, so the delivered-vs-file composition covers it', () => {
    expect(MANAGED_PI_POLICY_KEYS).toContain('extraKnownMarketplaces');
  });

  it('parses through the tolerant policy parser with no drops', () => {
    const parsed = parseManagedPiPolicyTolerantV1({
      schemaVersion: 1,
      extraKnownMarketplaces: { 'corp-plugins': { source: { source: 'git', url: 'https://gitlab.tcsbank.ru/corp/plugins.git' } } },
      strictKnownMarketplaces: [{ source: 'hostPattern', hostPattern: '^gitlab\\.tcsbank\\.ru$' }],
    }, { source: 'managed-policy.json' });
    expect(parsed.drops).toEqual([]);
    expect(parsed.policy.extraKnownMarketplaces).toEqual([
      { name: 'corp-plugins', source: 'https://gitlab.tcsbank.ru/corp/plugins.git' },
    ]);
  });

  it('carries autoUpdate through the tolerant policy parser', () => {
    const parsed = parseManagedPiPolicyTolerantV1({
      schemaVersion: 1,
      extraKnownMarketplaces: {
        'corp-plugins': {
          source: { source: 'git', url: 'https://gitlab.tcsbank.ru/corp/plugins.git' },
          autoUpdate: true,
        },
      },
    }, { source: 'managed-policy.json' });
    expect(parsed.drops).toEqual([]);
    expect(parsed.policy.extraKnownMarketplaces).toEqual([
      { name: 'corp-plugins', source: 'https://gitlab.tcsbank.ru/corp/plugins.git', autoUpdate: true },
    ]);
  });
});

describe('a force-enable that does nothing is visible', () => {
  it('reports an uninstalled mandate and tells the administrator no marketplace is registered', () => {
    const findings = resolveMandatedPluginFindings({
      enabledPlugins: { 'corp.toolkit': true, 'corp.optional': false },
      installedPluginKeys: [],
      marketplacesRegistered: 0,
    });
    expect(findings).toEqual([
      { pluginKey: 'corp.toolkit', state: 'not-installed', marketplacesRegistered: 0 },
    ]);

    const report = buildConfigDoctorReport({
      drops: [], winner: 'file', fileCarriesSettings: true, mandatedPlugins: findings,
    });
    expect(report.hasFindings).toBe(true);
    expect(report.text).toContain('corp.toolkit');
    expect(report.text).toContain('extraKnownMarketplaces');
  });

  it('is not a finding once the mandated plugin is installed', () => {
    const findings = resolveMandatedPluginFindings({
      enabledPlugins: { 'corp.toolkit': true },
      installedPluginKeys: ['corp.toolkit'],
      marketplacesRegistered: 1,
    });
    expect(findings).toEqual([{ pluginKey: 'corp.toolkit', state: 'installed' }]);

    const report = buildConfigDoctorReport({
      drops: [], winner: 'file', fileCarriesSettings: true, mandatedPlugins: findings,
    });
    expect(report.hasFindings).toBe(false);
    expect(report.text).toContain('1 force-enabled plugin is installed');
  });

  it('omits the section entirely when the registry could not be read', () => {
    const report = buildConfigDoctorReport({ drops: [], winner: 'none', fileCarriesSettings: false });
    expect(report.text).not.toContain('Force-enabled plugins:');
    expect(report.hasFindings).toBe(false);
  });
});
