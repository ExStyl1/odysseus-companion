/**
 * P3.372 · a codex bundle's root `.mcp.json` / `.app.json` when the manifest
 * does not name it.
 *
 * The question was left open by `plans/2026-07-29-codex-adapter-spec.md` § 8.2
 * because two OpenAI DOCUMENTS disagree — `deploy/submission-errors.md`'s
 * `undeclared_mcp_manifest_ignored` says a root `.mcp.json` is imported "only
 * when the plugin-manifest `mcpServers` field is set to `./.mcp.json`", while
 * `build/plugin-json-spec.md:94` says the declared fields are "supplemented on
 * top of default component discovery; they do not replace defaults". AGENTS.md
 * settles that class for codex: the SOURCE outranks the page.
 *
 * Read at `github.com/openai/codex`, `rust-v0.148.0`,
 * `codex-rs/core-plugins/src/loader.rs`:
 *
 *   fn plugin_mcp_config_paths(plugin_root, manifest_paths) {
 *       if let Some(PluginManifestMcpServers::Path(path)) = &manifest_paths.mcp_servers {
 *           return vec![path.clone()];
 *       }
 *       default_mcp_config_paths(plugin_root)   // takes the root `.mcp.json` if it is a file
 *   }
 *
 * and `plugin_app_config_paths` with the same shape over `manifest_paths.apps`,
 * with the inline-object arm of `load_plugin_mcp_servers_from_manifest_with_format`
 * never reaching the default at all. So:
 *
 *   - UNDECLARED root file  → the CLI loads it. `undeclared_mcp_manifest_ignored`
 *     describes publishing, not the loader. We match; no diagnostic.
 *   - DECLARED something else → the CLI loads only the declaration. We import the
 *     root file too, WITH a named warning, because a silent narrowing would drop
 *     servers from bundles installed here today — the same defect from the other
 *     side, which is why § 8.2 refused to resolve it by preference.
 *
 * Every codex fixture in this tree writes the DECLARED case, so the undeclared
 * branch had no test at all before this file.
 */
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// `format-adapters.ts` FIRST — entering the adapter graph through
// `format-adapters/codex.ts` throws on a pre-existing import cycle between the
// two files. Same note as `codex-contract-fields.test.ts`.
import { normalizePluginBundle } from '../format-adapters.ts';
import { normalizeCodexPluginManifest } from '../format-adapters/codex.ts';
import type { PluginCapability, PluginDiagnostic, PluginOrigin } from '../types.ts';

const UNDECLARED_ROOT_IMPORT = 'plugin.format.codex_undeclared_root_import';

let bundle: string;

beforeEach(() => {
  bundle = mkdtempSync(join(tmpdir(), 'codex-undeclared-root-'));
});

afterEach(() => {
  if (bundle) rmSync(bundle, { recursive: true, force: true });
});

function origin(): PluginOrigin {
  return { kind: 'local-path', path: bundle, installedAt: 0 } as unknown as PluginOrigin;
}

function writeJson(relativePath: string, value: unknown): void {
  const target = join(bundle, relativePath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, JSON.stringify(value, null, 2));
}

/** A stdio server — the executable shape the row is about, not a URL. */
function rootMcpFile(serverName: string): void {
  writeJson('.mcp.json', {
    mcpServers: { [serverName]: { command: 'node', args: ['./server.js'] } },
  });
}

function mcpIds(capabilities: PluginCapability[] | undefined): string[] {
  return (capabilities ?? [])
    .filter(capability => capability.kind === 'mcp')
    .map(capability => capability.id)
    .sort();
}

function codes(diagnostics: PluginDiagnostic[]): string[] {
  return diagnostics.map(diagnostic => diagnostic.code);
}

it('imports an UNDECLARED root .mcp.json with no warning, because the codex loader does the same', async () => {
  rootMcpFile('undeclared');

  const normalized = await normalizeCodexPluginManifest(
    { name: 'undeclared-mcp', version: '1.0.0' },
    bundle,
    origin(),
  );

  // The branch no fixture covered: `default_mcp_config_paths` is the codex
  // fallback whenever the manifest declares nothing, so importing here MATCHES
  // the CLI and there is no divergence to disclose.
  expect(mcpIds(normalized.value?.capabilities)).toEqual(['mcp.undeclared']);
  expect(codes(normalized.diagnostics)).not.toContain(UNDECLARED_ROOT_IMPORT);
});

it('imports an UNDECLARED root .app.json with no warning', async () => {
  writeJson('.app.json', { apps: { helper: { connectorId: 'helper-connector' } } });

  const normalized = await normalizeCodexPluginManifest(
    { name: 'undeclared-app', version: '1.0.0' },
    bundle,
    origin(),
  );

  expect(normalized.value?.apps?.map(app => app.id)).toEqual(['helper']);
  expect(codes(normalized.diagnostics)).not.toContain(UNDECLARED_ROOT_IMPORT);
});

it('warns when a root .mcp.json rides ALONGSIDE a manifest that declares another path', async () => {
  rootMcpFile('root-server');
  writeJson('servers/other.json', {
    mcpServers: { declared: { command: 'node', args: ['./declared.js'] } },
  });

  const normalized = await normalizeCodexPluginManifest(
    { name: 'declared-elsewhere', version: '1.0.0', mcpServers: './servers/other.json' },
    bundle,
    origin(),
  );

  // Both imported — the widening is kept deliberately, so a bundle installed
  // here today does not lose a server without a word said …
  expect(mcpIds(normalized.value?.capabilities)).toEqual(['mcp.declared', 'mcp.root-server']);
  // … and it is not silent. `plugin_mcp_config_paths` returns ONLY the declared
  // path in this arm, so `mcp.root-server` is live here and dead on codex.
  const warning = normalized.diagnostics.find(diagnostic => diagnostic.code === UNDECLARED_ROOT_IMPORT);
  expect(warning?.severity).toBe('warning');
  expect(warning?.path).toBe('mcpServers');
  expect(warning?.details?.file).toBe('.mcp.json');
});

it('warns when a root .mcp.json rides alongside an INLINE mcpServers object', async () => {
  rootMcpFile('root-server');

  const normalized = await normalizeCodexPluginManifest(
    {
      name: 'declared-inline',
      version: '1.0.0',
      mcpServers: { inline: { command: 'node', args: ['./inline.js'] } },
    },
    bundle,
    origin(),
  );

  // The sharper arm nobody had written down. Codex's `::Object` branch reads the
  // inline map and never calls `plugin_mcp_config_paths`, so the root file is
  // not opened there at all.
  expect(mcpIds(normalized.value?.capabilities)).toEqual(['mcp.inline', 'mcp.root-server']);
  expect(codes(normalized.diagnostics)).toContain(UNDECLARED_ROOT_IMPORT);
});

it('warns when a root .app.json rides alongside a declared apps path', async () => {
  writeJson('.app.json', { apps: { helper: { connectorId: 'helper-connector' } } });
  writeJson('apps/declared.json', { apps: { declared: { connectorId: 'declared-connector' } } });

  const normalized = await normalizeCodexPluginManifest(
    { name: 'declared-apps', version: '1.0.0', apps: './apps/declared.json' },
    bundle,
    origin(),
  );

  expect(normalized.value?.apps?.map(app => app.id).sort()).toEqual(['declared', 'helper']);
  const warning = normalized.diagnostics.find(diagnostic => diagnostic.code === UNDECLARED_ROOT_IMPORT);
  expect(warning?.path).toBe('apps');
  expect(warning?.details?.file).toBe('.app.json');
});

it('stays silent when the manifest declares the default path itself, and imports it once', async () => {
  // The control. This is the one arm `submission-errors.md` and the loader agree
  // on, and it must not acquire a warning: `declaresManifestDefaultPath` short-
  // circuits the default reader so the file is read exactly once.
  rootMcpFile('declared-default');

  const normalized = await normalizeCodexPluginManifest(
    { name: 'declares-default', version: '1.0.0', mcpServers: './.mcp.json' },
    bundle,
    origin(),
  );

  expect(mcpIds(normalized.value?.capabilities)).toEqual(['mcp.declared-default']);
  expect(codes(normalized.diagnostics)).not.toContain(UNDECLARED_ROOT_IMPORT);
});

it('carries the warning onto the persisted adapter warnings a whole-bundle install reads', async () => {
  // The disclosure is only real if it reaches a surface. `summarizeInstalled`
  // maps `compatibility.adapter.warnings` to `adapterWarnings` on the install
  // summary, so the code landing there is what an operator can see after install.
  rootMcpFile('root-server');
  writeJson('servers/other.json', {
    mcpServers: { declared: { command: 'node', args: ['./declared.js'] } },
  });
  writeJson('.codex-plugin/plugin.json', {
    name: 'declared-elsewhere-bundle',
    version: '1.0.0',
    mcpServers: './servers/other.json',
  });

  const normalized = await normalizePluginBundle(bundle, origin());

  expect(normalized.ok).toBe(true);
  expect(normalized.value?.compatibility?.adapter?.warnings?.map(warning => warning.code))
    .toContain(UNDECLARED_ROOT_IMPORT);
});
