/**
 * The marketplace entry as a plugin definition (S9).
 *
 * `plugin-marketplaces.md` § Plugin entries (`:195`): "You can include any field
 * from the plugin manifest schema, such as `description`, `version`, `author`,
 * `commands`, and `hooks`, plus these marketplace-specific fields: `source`,
 * `category`, `tags`, `strict`, and `relevance`."
 *
 * Every fixture here is a directory this file created. No test clones, fetches
 * or resolves a real remote marketplace.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginInstallService } from '../acquisition.ts';
import {
  parseExternalPluginCatalog,
  type ExternalPluginCatalogDto,
} from '../../marketplace/external-catalog-adapters.ts';
import type {
  NessyPluginManifest,
  PluginDiagnostic,
  PluginInstallSource,
  PluginMarketplaceEntryDefinition,
} from '../types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'marketplace-entry-authority-'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('a marketplace entry declaring component paths', () => {
  it('produces those capabilities on the installed plugin', async () => {
    // Raw files with no `skills/` or `commands/` default folder: only the entry
    // says where the components are.
    const bundle = createBundle('entry-defined', {
      'curated/review/SKILL.md': '---\nname: review\n---\nReview it.\n',
      'extra/deploy.md': '---\ndescription: Deploy\n---\nDeploy it.\n',
    });
    const result = await install(bundle, {
      fields: { skills: ['./curated'], commands: ['./extra'] },
    });

    expect(result.ok).toBe(true);
    expect(capabilityIds(result)).toEqual(['prompt-command.deploy', 'skill.review']);
  });

  it('carries the entry version and description when plugin.json is silent', async () => {
    const bundle = createBundle('entry-metadata', {
      'curated/review/SKILL.md': '# Review\n',
    });
    const result = await install(bundle, {
      fields: { skills: ['./curated'], version: '2.1.0', description: 'Curated by the operator' },
    });

    expect(result.manifest?.version).toBe('2.1.0');
    expect(result.manifest?.description).toBe('Curated by the operator');
  });

  it('lets plugin.json win on version and the entry win on defaultEnabled', async () => {
    // `plugins/manifest-reference.md#marketplace-entries-and-the-manifest` — "If also set in the marketplace entry,
    // `plugin.json` wins". `:518` — `defaultEnabled` in the entry "takes
    // precedence over the value in `plugin.json`". Opposite directions, on
    // purpose, so a single "entry always wins" rule would fail one of them.
    const bundle = createBundle('entry-precedence', {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'entry-precedence',
        version: '1.0.0',
        defaultEnabled: true,
      }),
      'skills/review/SKILL.md': '# Review\n',
    });
    const result = await install(bundle, {
      fields: { version: '9.9.9', defaultEnabled: false },
    });

    expect(result.manifest?.version).toBe('1.0.0');
    expect(result.manifest?.defaultEnabled).toBe(false);
  });

  it('merges with plugin.json rather than replacing it, the default strict behaviour', async () => {
    // `:519` — with `strict: true` (the default) "The marketplace entry can
    // supplement it with additional components, and both sources are merged."
    const bundle = createBundle('entry-merge', {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'entry-merge',
        commands: ['./own'],
      }),
      'own/build.md': 'Build it.\n',
      'curated/deploy.md': 'Deploy it.\n',
    });
    const result = await install(bundle, { fields: { commands: ['./curated'] } });

    expect(capabilityIds(result)).toEqual(['prompt-command.build', 'prompt-command.deploy']);
  });

  it('makes a strict:true entry the manifest when there is no plugin.json, displacing the default folder', async () => {
    // F1.1059 — `plugins/marketplace-reference.md`, "How an entry combines with
    // plugin.json": "**No `plugin.json`**: the entry is the manifest regardless of
    // `strict`." And `plugins/manifest-reference.md`, "How each key combines with
    // its default location": "When you set `commands`, the default `commands/`
    // directory isn't scanned." This case used to assert the supplement.
    const bundle = createBundle('entry-manifestless-replaces-default', {
      'commands/base.md': 'Base.\n',
      'extras/extra.md': 'Extra.\n',
    });
    const result = await install(bundle, { fields: { commands: ['./extras/'] } });

    expect(capabilityIds(result)).toEqual(['prompt-command.extra']);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.format.claude_default_folder_ignored');
  });

  it('still supplements the default folder of a plugin whose plugin.json declares no commands', async () => {
    // The boundary: over a plugin.json the entry is appended, not the manifest,
    // so the plugin's own commands/ keeps loading beside the entry's.
    const bundle = createBundle('entry-supplements-default', {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'entry-supplements-default' }),
      'commands/base.md': 'Base.\n',
      'extras/extra.md': 'Extra.\n',
    });
    const result = await install(bundle, { fields: { commands: ['./extras/'] } });

    expect(capabilityIds(result)).toEqual(['prompt-command.base', 'prompt-command.extra']);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).not.toContain('plugin.format.claude_default_folder_ignored');
  });

  it('lets the plugin manifest displace its own default folder, entry or no entry', async () => {
    const bundle = createBundle('manifest-replaces-default', {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'manifest-replaces-default',
        commands: ['./own'],
      }),
      'commands/base.md': 'Base.\n',
      'own/build.md': 'Build.\n',
      'extras/extra.md': 'Extra.\n',
    });
    const result = await install(bundle, { fields: { commands: ['./extras/'] } });

    // The manifest is the authority under strict:true, so commands/ is not
    // scanned — and the entry still supplements what the authority chose.
    expect(capabilityIds(result)).toEqual(['prompt-command.build', 'prompt-command.extra']);
  });

  it('makes the entry the authority under strict:false, displacing the default folder', async () => {
    // `:515` — strict "controls whether `plugin.json` is the authority for
    // component definitions", so with `false` the entry inherits that role and
    // `plugins/manifest-reference.md#how-each-key-combines-with-its-default-location`'s REPLACES rule applies to ITS declaration.
    const bundle = createBundle('entry-is-authority', {
      'commands/base.md': 'Base.\n',
      'curated/deploy.md': 'Deploy.\n',
    });
    const result = await install(bundle, { strict: false, fields: { commands: ['./curated'] } });

    expect(capabilityIds(result)).toEqual(['prompt-command.deploy']);
  });

  it('refuses an entry path that escapes the bundle root, with a diagnostic', async () => {
    const outside = join(tempDir, 'outside', 'secrets');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'SKILL.md'), '# Secret\n');
    const bundle = createBundle('entry-escape', {
      'skills/review/SKILL.md': '# Review\n',
    });
    const result = await install(bundle, { fields: { skills: ['../outside'] } });

    expect(result.ok).toBe(true);
    // The escaping path is refused and named; the bundle's own skill still loads.
    expect(result.diagnostics.some(diagnostic =>
      diagnostic.code === 'plugin.format.claude_path_invalid'
      && diagnostic.message.includes('..'))).toBe(true);
    expect(capabilityIds(result)).toEqual(['skill.review']);
  });
});

/**
 * F1.1034 — `plugins/marketplace-reference.md` § Strict mode (read 2026-09-28):
 * "With `strict: false`, an entry that declares any component field is a
 * conflict, and the plugin fails to load." Its table: "`false` | present | none
 * | `plugin.json` is the manifest, as with `true`". The conflict is asked of the
 * ENTRY; what `plugin.json` declares does not decide it.
 */
describe('strict mode', () => {
  it('refuses to load when a strict:false entry and its plugin.json both declare components', async () => {
    const bundle = createBundle('strict-conflict', {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'strict-conflict', commands: ['./own'] }),
      'own/build.md': 'Build it.\n',
      'curated/deploy.md': 'Deploy it.\n',
    });
    const result = await install(bundle, { strict: false, fields: { commands: ['./curated'] } });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code))
      .toContain('plugin.format.claude_conflicting_manifests');
    expect(result.manifest).toBeUndefined();
  });

  it('refuses a strict:false entry that declares components beside a plugin.json with metadata only', async () => {
    // The boundary the old test inverted: a plugin.json that declares nothing
    // does not make the entry's commands load, because the page asks the entry.
    const bundle = createBundle('strict-metadata-only', {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'strict-metadata-only',
        version: '3.0.0',
        author: { name: 'Plugin Author' },
      }),
      'curated/deploy.md': 'Deploy it.\n',
    });
    const result = await install(bundle, { strict: false, fields: { commands: ['./curated'] } });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code))
      .toContain('plugin.format.claude_conflicting_manifests');
    expect(result.manifest).toBeUndefined();
  });

  it('loads plugin.json as the manifest when a strict:false entry declares no component field', async () => {
    // The headersHelper shape: that field "must also set `"strict": false`", and
    // the plugin's own plugin.json lists its commands and dependencies. The
    // entry's server map is not one of the six, so it is no conflict either;
    // it just does not apply over a plugin.json (F1.1032).
    const bundle = createBundle('strict-false-no-entry-components', {
      '.claude-plugin/plugin.json': JSON.stringify({
        name: 'strict-false-no-entry-components',
        commands: ['./own'],
        dependencies: ['helper-plugin'],
      }),
      'own/build.md': 'Build it.\n',
    });
    const result = await install(bundle, {
      strict: false,
      fields: { description: 'Served as an archive', mcpServers: { added: { command: 'node', args: ['added.js'] } } },
    });

    expect(result.ok).toBe(true);
    expect(capabilityIds(result)).toEqual(['prompt-command.build']);
    expect(result.manifest?.dependencies?.map(dependency => dependency.name)).toEqual(['helper-plugin']);
    expect(result.manifest?.description).toBe('Served as an archive');
  });
});

describe('the skills default scan: the ordinary rule and the marketplace-root exception', () => {
  // ONE fixture, TWO entries. `plugins/manifest-reference.md#how-each-key-combines-with-its-default-location` makes the marketplace
  // root the only condition that separates them, so each is asserted against the
  // other's expectation on the same bytes: an edit that collapses the two rules
  // into one cannot leave both of these green.
  const sharedSkills = {
    'skills/code-review/SKILL.md': '# Code review\n',
    'skills/docs/SKILL.md': '# Docs\n',
  };

  it('EXTENDS the default scan for an ordinary entry', async () => {
    const bundle = createBundle('skills-extend', sharedSkills);
    const result = await install(bundle, { fields: { skills: ['./skills/code-review'] } });

    expect(capabilityIds(result)).toEqual(['skill.code-review', 'skill.docs']);
  });

  it('REPLACES the default scan for a marketplace-root entry', async () => {
    const bundle = createBundle('skills-replace', sharedSkills);
    const result = await install(bundle, {
      sourceIsMarketplaceRoot: true,
      fields: { skills: ['./skills/code-review'] },
    });

    // `:511` — "other directories in the shared `skills/` folder don't load".
    expect(capabilityIds(result)).toEqual(['skill.code-review']);
  });

  it('keeps the full scan when a marketplace-root entry lists the skills folder itself', async () => {
    const bundle = createBundle('skills-root-listed', sharedSkills);
    const result = await install(bundle, {
      sourceIsMarketplaceRoot: true,
      fields: { skills: ['./skills/', './skills/code-review'] },
    });

    expect(capabilityIds(result)).toEqual(['skill.code-review', 'skill.docs']);
  });

  it('falls back to the default scan when none of a marketplace-root entry\'s paths exist', async () => {
    const bundle = createBundle('skills-none-exist', sharedSkills);
    const result = await install(bundle, {
      sourceIsMarketplaceRoot: true,
      fields: { skills: ['./skills/absent'] },
    });

    // `:511` — "If none of the listed paths exist, the default scan runs instead."
    expect(capabilityIds(result)).toEqual(['skill.code-review', 'skill.docs']);
  });
});

describe('metadata.pluginRoot', () => {
  // `plugins/marketplace-reference.md#bare-names-under-pluginroot` — "Base directory prepended to relative plugin
  // source paths (for example, `"./plugins"` lets you write `"source":
  // "formatter"` instead of `"source": "./plugins/formatter"`)".
  //
  // The finding's own case: a decoy `formatter/` at the repository root beside
  // the real `plugins/formatter/`. Anyone who can land a top-level directory in
  // a marketplace repository can create that decoy.
  function createMarketplaceWithDecoy(name: string): string {
    return createBundle(name, {
      'formatter/.claude-plugin/plugin.json': JSON.stringify({ name: 'formatter' }),
      'formatter/skills/decoy/SKILL.md': '# Decoy\n',
      'plugins/formatter/.claude-plugin/plugin.json': JSON.stringify({ name: 'formatter' }),
      'plugins/formatter/skills/real/SKILL.md': '# Real\n',
    });
  }

  function catalog(pluginRoot?: string): ExternalPluginCatalogDto {
    return {
      name: 'company-tools',
      ...(pluginRoot === undefined ? {} : { metadata: { pluginRoot } }),
      plugins: [{ name: 'formatter', source: 'formatter' }],
    };
  }

  it('installs the plugin beneath the declared root, not the decoy at the repository root', async () => {
    const market = createMarketplaceWithDecoy('market-with-root');
    const parsed = parseExternalPluginCatalog('claude', catalog('./plugins'), { catalogRoot: market });

    expect(parsed.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const source = parsed.proposals[0]?.source;
    expect(source).toEqual({ kind: 'local-path', path: join(market, 'plugins', 'formatter') });

    const result = await installSource(source!);
    expect(result.ok).toBe(true);
    // WHICH directory was installed, not merely that an install happened.
    expect(capabilityIds(result)).toEqual(['skill.real']);
    expect(capabilityIds(result)).not.toContain('skill.decoy');
  });

  it('installs the repository-root directory when no pluginRoot is declared', async () => {
    const market = createMarketplaceWithDecoy('market-no-root');
    const parsed = parseExternalPluginCatalog('claude', catalog(), { catalogRoot: market });

    expect(parsed.proposals[0]?.source).toEqual({ kind: 'local-path', path: join(market, 'formatter') });
    const result = await installSource(parsed.proposals[0]!.source);
    expect(capabilityIds(result)).toEqual(['skill.decoy']);
  });

  it('refuses every relative source when the declared pluginRoot escapes the marketplace', async () => {
    const market = createMarketplaceWithDecoy('market-escaping-root');
    const parsed = parseExternalPluginCatalog('claude', catalog('../elsewhere'), { catalogRoot: market });

    expect(parsed.proposals).toEqual([]);
    expect(parsed.diagnostics.map(diagnostic => diagnostic.code)).toEqual([
      'marketplace.catalog.plugin_root_uncontained',
      'marketplace.catalog.plugin_root_invalid',
    ]);
  });

  it('refuses a source that climbs out of the declared pluginRoot', async () => {
    const market = createMarketplaceWithDecoy('market-climbing-source');
    const parsed = parseExternalPluginCatalog('claude', {
      name: 'company-tools',
      metadata: { pluginRoot: './plugins' },
      // Stays inside the repository, but leaves the declared plugin root.
      plugins: [{ name: 'formatter', source: '../formatter' }],
    }, { catalogRoot: market });

    expect(parsed.proposals).toEqual([]);
    expect(parsed.diagnostics.map(diagnostic => diagnostic.code))
      .toEqual(['marketplace.catalog.path_traversal']);
  });
});

/**
 * F1.1032 — `plugins/marketplace-reference.md` § "How an entry combines with
 * plugin.json" (`#entry-and-plugin-json`, read 2026-09-28):
 *
 *  - "**No `plugin.json`**: the entry is the manifest regardless of `strict`.
 *    Every manifest field in the entry applies, including `mcpServers`,
 *    `lspServers`, `userConfig`, and `channels`."
 *  - "**`plugin.json` present**: `plugin.json` is the manifest. Strict mode
 *    decides whether the entry's six component fields, `commands`, `agents`,
 *    `skills`, `hooks`, `outputStyles`, and `themes`, are combined with it or
 *    rejected as a conflict. Entry `mcpServers`, `lspServers`, `userConfig`, and
 *    `channels` don't apply."
 *
 * Every entry below goes through the real catalog parser first, so a field the
 * parser does not carry fails here rather than passing on a hand-built entry.
 */
describe('F1.1032 — how an entry combines with plugin.json', () => {
  const SERVERS = {
    mcpServers: { added: { command: 'node', args: ['added.js'] } },
    lspServers: { go: { command: 'gopls', extensionToLanguage: { '.go': 'go' } } },
    userConfig: { API_TOKEN: { title: 'API token', type: 'string', sensitive: true } },
  };

  function catalogEntry(market: string, fields: Record<string, unknown>): PluginMarketplaceEntryDefinition {
    const parsed = parseExternalPluginCatalog('claude', {
      name: 'operator-marketplace',
      plugins: [{ name: 'entry-plugin', source: './entry-plugin', ...fields }],
    }, { catalogRoot: market });
    expect(parsed.diagnostics.filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
    const entry = parsed.proposals[0]?.entryDefinition;
    expect(entry).toBeDefined();
    return entry!;
  }

  function serverNames(result: { manifest?: NessyPluginManifest }, kind: 'mcp' | 'lsp'): string[] {
    return (result.manifest?.capabilities ?? [])
      .filter(capability => capability.kind === kind)
      .map(capability => capability.kind === 'mcp' ? capability.mcp.serverName
        : capability.kind === 'lsp' ? capability.lsp.id : '')
      .sort();
  }

  function notApplied(result: { diagnostics: PluginDiagnostic[] }): string[] {
    return result.diagnostics
      .filter(diagnostic => diagnostic.code === 'plugin.format.claude_marketplace_entry_field_not_applied')
      .map(diagnostic => String(diagnostic.details?.field))
      .sort();
  }

  it('claims a bundle with no layout marker from an entry declaring only outputStyles or themes', async () => {
    const market = createBundle('market-styles', {
      'entry-plugin/styles/terse.md': '---\nname: Terse\ndescription: Short answers\n---\nBe terse.\n',
      'entry-plugin/palettes/dark.json': JSON.stringify({ base: 'dark', overrides: {} }),
    });
    const bundle = join(market, 'entry-plugin');

    const styled = await install(bundle, catalogEntry(market, { outputStyles: ['./styles'] }));
    expect(styled.ok).toBe(true);
    expect(capabilityIds(styled)).toEqual(['output-style.terse']);

    // Themes are refused by name rather than loaded, so the claim is visible as
    // the refusal: before, the bundle was an unsupported format and said nothing.
    const themed = await installSource(entrySource(bundle, catalogEntry(market, { themes: ['./palettes'] })));
    expect(themed.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.format.claude_theme_unsupported');
    expect(themed.diagnostics.map(diagnostic => diagnostic.code)).not.toContain('plugin.format.unsupported_format');
  });

  it('does not claim the same bundle from an entry that declares no component field', async () => {
    const market = createBundle('market-metadata-only', {
      'entry-plugin/styles/terse.md': '---\nname: Terse\n---\nBe terse.\n',
    });
    const result = await install(join(market, 'entry-plugin'), catalogEntry(market, { description: 'Only words' }));

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.format.unsupported_format');
  });

  it('applies the entry mcpServers, lspServers and userConfig when the plugin has no plugin.json', async () => {
    const market = createBundle('market-manifestless', {
      'entry-plugin/skills/review/SKILL.md': '# Review\n',
    });
    const result = await install(join(market, 'entry-plugin'), catalogEntry(market, SERVERS));

    expect(result.ok).toBe(true);
    expect(serverNames(result, 'mcp')).toEqual(['added']);
    expect(serverNames(result, 'lsp')).toEqual(['go']);
    expect(result.manifest?.nessyExtensions?.userConfiguration?.map(option => option.key)).toEqual(['API_TOKEN']);
    expect(notApplied(result)).toEqual([]);
  });

  it('does not let the entry add servers or options over a plugin.json, under either strict value, and says so', async () => {
    for (const strict of [undefined, false]) {
      const market = createBundle(`market-with-manifest-${String(strict)}`, {
        // The testdino shape: plugin.json with metadata only, the server in
        // `.mcp.json`, and the entry repeating a server map of its own.
        'entry-plugin/.claude-plugin/plugin.json': JSON.stringify({ name: 'entry-plugin', version: '1.0.0' }),
        'entry-plugin/.mcp.json': JSON.stringify({ mcpServers: { own: { command: 'node', args: ['own.js'] } } }),
      });
      const entry = catalogEntry(market, { ...SERVERS, ...(strict === undefined ? {} : { strict }) });
      const result = await install(join(market, 'entry-plugin'), entry);

      expect(result.ok).toBe(true);
      expect(serverNames(result, 'mcp')).toEqual(['own']);
      expect(serverNames(result, 'lsp')).toEqual([]);
      expect(result.manifest?.nessyExtensions?.userConfiguration).toBeUndefined();
      expect(notApplied(result)).toEqual(['lspServers', 'mcpServers', 'userConfig']);
    }
  });

  // F1.1036 — "Every manifest field in the entry applies" reaches settings and
  // monitors too; over a plugin.json they do not apply, like the four above.
  const MANIFEST_ONLY = {
    settings: { agent: 'reviewer' },
    monitors: [{ name: 'top', command: 'tail -f top.log', description: 'Top-level spelling' }],
    experimental: {
      monitors: [{ name: 'log', command: 'tail -f build.log', description: 'Build log lines' }],
      evals: './evals',
    },
  };

  function monitorCount(result: { manifest?: NessyPluginManifest }): number {
    return (result.manifest?.capabilities ?? []).filter(capability => capability.kind === 'monitor').length;
  }

  it('applies the entry settings and monitors when the plugin has no plugin.json', async () => {
    const market = createBundle('market-manifestless-settings', {
      'entry-plugin/skills/review/SKILL.md': '# Review\n',
    });
    const entry = catalogEntry(market, MANIFEST_ONLY);
    // The parser carries the two experimental members an adapter reads, not evals.
    expect(entry.fields.experimental).toEqual({ monitors: MANIFEST_ONLY.experimental.monitors });
    const result = await install(join(market, 'entry-plugin'), entry);

    expect(result.ok).toBe(true);
    // `experimental.monitors` wins over the top-level spelling, as in a plugin.json.
    expect(monitorCount(result)).toBe(1);
    expect(result.manifest?.nessyExtensions?.defaultSettings).toEqual({ agent: 'reviewer' });
    expect(notApplied(result)).toEqual([]);
  });

  it('does not apply the entry settings or monitors over a plugin.json, and says so', async () => {
    const market = createBundle('market-with-manifest-settings', {
      'entry-plugin/.claude-plugin/plugin.json': JSON.stringify({ name: 'entry-plugin', version: '1.0.0' }),
      'entry-plugin/skills/review/SKILL.md': '# Review\n',
    });
    const result = await install(join(market, 'entry-plugin'), catalogEntry(market, MANIFEST_ONLY));

    expect(result.ok).toBe(true);
    expect(monitorCount(result)).toBe(0);
    expect(result.manifest?.nessyExtensions?.defaultSettings).toBeUndefined();
    expect(notApplied(result)).toEqual(['experimental.monitors', 'monitors', 'settings']);
  });

  it('refuses an entry experimental path outside the plugin root at catalog parse', () => {
    const parsed = parseExternalPluginCatalog('claude', {
      name: 'operator-marketplace',
      plugins: [{ name: 'entry-plugin', source: './entry-plugin', experimental: { themes: '../outside' } }],
    }, { catalogRoot: tempDir });

    expect(parsed.diagnostics.map(diagnostic => diagnostic.code)).toContain('marketplace.catalog.entry_path_uncontained');
    expect(parsed.proposals[0]?.entryDefinition?.fields.experimental).toBeUndefined();
  });
});

/**
 * F1.1035 — `plugins/manifest-reference.md` § "How entry fields combine with
 * `plugin.json`" (read 2026-09-28): "For `hooks`, the entry's matchers for an
 * event replace the manifest's matchers for that same event, and events only the
 * manifest declares keep theirs".
 */
describe('F1.1035 — entry hooks replace the plugin hooks event by event', () => {
  const groups = (command: string) => [{ matcher: 'Write', hooks: [{ type: 'command', command }] }];

  function hookCommands(result: { manifest?: NessyPluginManifest }): string[] {
    return (result.manifest?.capabilities ?? [])
      .flatMap(capability => capability.kind === 'hook' && capability.hook.type === 'command'
        ? [`${capability.hook.event}:${capability.hook.command}`] : [])
      .sort();
  }

  it('replaces the manifest file and the default file for an entry event, and keeps every other event', async () => {
    const bundle = createBundle('entry-hooks-per-event', {
      '.claude-plugin/plugin.json': JSON.stringify({ name: 'entry-hooks-per-event', hooks: './config/hooks.json' }),
      'config/hooks.json': JSON.stringify({
        hooks: { PostToolUse: groups('echo manifest-post'), PreToolUse: groups('echo manifest-pre') },
      }),
      'hooks/hooks.json': JSON.stringify({
        hooks: { PostToolUse: groups('echo default-post'), Stop: [{ hooks: [{ type: 'command', command: 'echo default-stop' }] }] },
      }),
    });
    const result = await install(bundle, { fields: { hooks: { PostToolUse: groups('echo entry-post') } } });

    expect(result.ok).toBe(true);
    expect(hookCommands(result)).toEqual([
      'PostToolUse:echo entry-post',
      'PreToolUse:echo manifest-pre',
      'Stop:echo default-stop',
    ]);
  });

  it('keeps merging an entry map with the default file when there is no plugin.json, since the entry is the manifest', async () => {
    const bundle = createBundle('entry-hooks-manifestless', {
      'hooks/hooks.json': JSON.stringify({ hooks: { PostToolUse: groups('echo default-post') } }),
    });
    const result = await install(bundle, { fields: { hooks: { PostToolUse: groups('echo entry-post') } } });

    expect(result.ok).toBe(true);
    expect(hookCommands(result)).toEqual(['PostToolUse:echo default-post', 'PostToolUse:echo entry-post']);
  });
});

/**
 * F1.1058 — `plugins/marketplace-reference.md` § "Hooks in an entry" (read
 * 2026-09-28): "Write entry `hooks` as an inline object that maps hook event
 * names to matcher arrays. If you write a file path or an array instead, [...]
 * Those hooks never run, and Claude Code reports a `not yet supported in a
 * marketplace entry` error for the plugin."
 */
describe('F1.1058 — entry hooks load only as an inline event map', () => {
  const groups = (command: string) => [{ matcher: 'Write', hooks: [{ type: 'command', command }] }];
  const UNSUPPORTED = 'plugin.format.claude_marketplace_entry_hooks_form_unsupported';

  function hookCommands(result: { manifest?: NessyPluginManifest }): string[] {
    return (result.manifest?.capabilities ?? [])
      .flatMap(capability => capability.kind === 'hook' && capability.hook.type === 'command'
        ? [`${capability.hook.event}:${capability.hook.command}`] : [])
      .sort();
  }

  it('runs no entry hooks written as a path or an array, with or without a plugin.json, and says so', async () => {
    const cases: Array<{ name: string; manifest: boolean; hooks: unknown }> = [
      { name: 'entry-hooks-path-manifestless', manifest: false, hooks: './config/entry-hooks.json' },
      { name: 'entry-hooks-array-manifestless', manifest: false, hooks: ['./config/entry-hooks.json'] },
      {
        name: 'entry-hooks-array-with-manifest',
        manifest: true,
        hooks: ['./config/entry-hooks.json', { PreToolUse: groups('echo entry-inline') }],
      },
      // F1.1189 — a record whose values are path strings is the multi-path shape, not an event map.
      { name: 'entry-hooks-path-record-manifestless', manifest: false, hooks: { main: './config/entry-hooks.json' } },
      { name: 'entry-hooks-path-record-with-manifest', manifest: true, hooks: { main: './config/entry-hooks.json' } },
    ];
    for (const { name, manifest, hooks } of cases) {
      const bundle = createBundle(name, {
        ...(manifest ? { '.claude-plugin/plugin.json': JSON.stringify({ name }) } : {}),
        'config/entry-hooks.json': JSON.stringify({ hooks: { PostToolUse: groups('echo entry-file') } }),
        'hooks/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo default-stop' }] }] } }),
      });
      const result = await install(bundle, { fields: { hooks } });

      expect(result.ok).toBe(true);
      // The plugin's own hooks file still loads; nothing the entry named does.
      expect(hookCommands(result)).toEqual(['Stop:echo default-stop']);
      expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(UNSUPPORTED);
      expect(result.deferred).toContain('marketplace-entry-hooks-path-or-array');
    }
  });

  it('still loads an entry hooks inline object, with no such warning', async () => {
    const bundle = createBundle('entry-hooks-inline', {
      'hooks/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo default-stop' }] }] } }),
    });
    const result = await install(bundle, { fields: { hooks: { PostToolUse: groups('echo entry-post') } } });

    expect(result.ok).toBe(true);
    expect(hookCommands(result)).toEqual(['PostToolUse:echo entry-post', 'Stop:echo default-stop']);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).not.toContain(UNSUPPORTED);
    expect(result.deferred).not.toContain('marketplace-entry-hooks-path-or-array');
  });
});

/**
 * F1.1190 — an entry's `experimental.themes` is the page's `themes` component
 * field, which combines over a `plugin.json`, so it is recorded as the refused
 * `theme` surface even when `plugin.json` has an `experimental` object of its own.
 * Before, the manifest's object replaced the entry's whole in the spread, the
 * theme row never saw `experimental.themes`, and the plugin read as fully
 * compatible.
 */
describe('F1.1190 — an entry experimental.themes beside a plugin.json experimental object', () => {
  const THEME_REFUSED = 'plugin.format.claude_theme_unsupported';
  const manifestWithMonitors = (name: string) => JSON.stringify({
    name,
    experimental: { monitors: [{ name: 'log', command: 'tail -f build.log', description: 'Build log lines' }] },
  });

  it('records the theme deferral and its refusal when both declare experimental', async () => {
    const bundle = createBundle('entry-themes-beside-manifest-experimental', {
      '.claude-plugin/plugin.json': manifestWithMonitors('entry-themes-beside-manifest-experimental'),
      'skills/review/SKILL.md': '# Review\n',
    });
    const result = await install(bundle, { fields: { experimental: { themes: './styles/theme.json' } } });

    expect(result.ok).toBe(true);
    expect(result.deferred).toContain('theme');
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(THEME_REFUSED);
  });

  it('CONTROL — the same plugin.json with an entry that declares no themes records no theme', async () => {
    const bundle = createBundle('entry-no-themes-beside-manifest-experimental', {
      '.claude-plugin/plugin.json': manifestWithMonitors('entry-no-themes-beside-manifest-experimental'),
      'skills/review/SKILL.md': '# Review\n',
    });
    const result = await install(bundle, { fields: { description: 'No themes here' } });

    expect(result.ok).toBe(true);
    expect(result.deferred).not.toContain('theme');
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).not.toContain(THEME_REFUSED);
  });
});

// --- helpers ----------------------------------------------------------------

function createBundle(name: string, files: Record<string, string>): string {
  const bundle = join(tempDir, name);
  mkdirSync(bundle, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(bundle, ...relativePath.split('/'));
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
  return bundle;
}

function entrySource(path: string, entry: PluginMarketplaceEntryDefinition): PluginInstallSource {
  return {
    kind: 'local-path',
    path,
    marketplace: { marketplaceId: 'operator-marketplace', name: 'entry-defined', entry },
  };
}

function installService(): PluginInstallService {
  return new PluginInstallService({
    baseTempDir: join(tempDir, 'stages'),
    now: () => 10_000,
  });
}

async function install(bundle: string, entry: PluginMarketplaceEntryDefinition) {
  return installSource(entrySource(bundle, entry));
}

/**
 * Plan → stage → normalize: the acquisition sequence
 * `PluginManagementServiceV2.install` runs before it commits. `ok` mirrors the
 * rule that service applies — an `error` in staging, or a normalization that
 * produced no manifest, means the bundle never reaches the store. Every
 * assertion in this file is about the manifest that sequence produces from a
 * marketplace entry, so the commit half is not part of the subject.
 */
async function installSource(
  source: PluginInstallSource,
): Promise<{ ok: boolean; manifest?: NessyPluginManifest; diagnostics: PluginDiagnostic[]; deferred?: string[] }> {
  const service = installService();
  const plan = await service.createInstallPlanFromSource(source);
  const staged = await service.stageInstall(plan);
  if (hasError(staged.diagnostics)) return { ok: false, diagnostics: staged.diagnostics };
  const normalization = await service.normalizeStagedInstall(staged);
  if (!normalization.manifest || hasError(normalization.diagnostics)) {
    return { ok: false, diagnostics: staged.diagnostics };
  }
  // The externalKinds of the compatibility report's deferred records: what the
  // plugin detail view shows as not loaded.
  const deferred = (normalization.compatibility?.deferred ?? []).map(record => record.externalKind);
  return { ok: true, manifest: normalization.manifest, diagnostics: staged.diagnostics, deferred };
}

function hasError(diagnostics: PluginDiagnostic[]): boolean {
  return diagnostics.some(diagnostic => diagnostic.severity === 'error');
}

function capabilityIds(result: { manifest?: { capabilities: { id: string }[] } }): string[] {
  return (result.manifest?.capabilities ?? []).map(capability => capability.id).sort();
}
