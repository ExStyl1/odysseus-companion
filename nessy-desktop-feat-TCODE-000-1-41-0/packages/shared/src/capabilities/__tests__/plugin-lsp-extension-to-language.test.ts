/**
 * F1.1025 — a Claude plugin's `lspServers.extensionToLanguage` map reaches the
 * registration the session routes by, so a document's language id can come from
 * its extension.
 *
 * `plugins-reference.md` § `lspServers`: `extensionToLanguage` is the "Map of file
 * extension to LSP language ID, at least one entry. Keys start with a dot, such
 * as `".go"`". Before this row the Claude adapter kept only the map's VALUES (as
 * `languages`), so the extension half never left the adapter.
 *
 * Driven through the real chain: the Claude adapter and the schema rebuild
 * (`normalizePluginBundle`), the store's re-read of a cached manifest
 * (`normalizeNessyPluginManifest`), then the resolver and the runtime view.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCapabilityResolver,
  resolvePluginLspDocumentLanguage,
  type CapabilityContext,
  type CapabilityResolutionInputs,
  type InstalledPluginInput,
  type RuntimeLspRegistration,
} from '../resolver.ts';
import { toAgentRuntime } from '../views.ts';
import { normalizePluginBundle } from '../../plugins/format-adapters.ts';
import { normalizeNessyPluginManifest } from '../../plugins/schema.ts';
import type { PluginCapability } from '../../plugins/types.ts';

const CONTEXT: CapabilityContext = {
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  projectTrustState: 'trusted',
  projectTrustRevision: 'trust-r1',
};
const INSTANCE = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);

/**
 * The official `clangd-lsp` map, abridged (claude-plugins-official
 * `marketplace.json`, read 2026-09-28): `.c` is `c` and `.C` is `cpp`, so the
 * extension must be matched with its case.
 */
const CLANGD_MAP = { '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.C': 'cpp' };

const created: string[] = [];
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function claudeBundleWithLsp(servers: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'lsp-extension-map-'));
  created.push(root);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'lsp-map', version: '1.0.0' }));
  writeFileSync(join(root, '.lsp.json'), JSON.stringify(servers));
  return root;
}

async function lspCapabilities(servers: Record<string, unknown>) {
  const normalized = await normalizePluginBundle(claudeBundleWithLsp(servers), { source: 'local-path', resolvedAt: 0 });
  expect(normalized.ok).toBe(true);
  // The store re-reads a CACHED manifest through the schema on every load, which
  // rebuilds the descriptor field by field — the hop where `supervision` once
  // vanished. Read the capabilities back through it, not from the adapter.
  const reread = normalizeNessyPluginManifest(JSON.parse(JSON.stringify(normalized.value)));
  expect(reread.ok).toBe(true);
  return {
    diagnostics: normalized.diagnostics,
    capabilities: (reread.value?.capabilities ?? []).filter(capability => capability.kind === 'lsp'),
  };
}

async function resolveFor(capabilities: PluginCapability[]): Promise<{ lspServers: RuntimeLspRegistration[]; generation: string }> {
  const installed: InstalledPluginInput = {
    pluginInstanceId: INSTANCE,
    pluginKey: 'pk-1',
    marketplaceId: 'm',
    pluginId: 'p',
    version: '1.0.0',
    bundleHash: 'b'.repeat(64),
    cacheRef: { marketplaceId: 'm', pluginId: 'p', version: '1.0.0', bundleHash: 'b'.repeat(64) },
    manifest: { schemaVersion: 1, kind: 'plugin', id: 'p', name: 'Plugin P', version: '1.0.0', capabilities: [] },
    origin: { source: 'marketplace', resolvedAt: 0 },
    installedAt: 1000,
    diagnostics: [],
  };
  const inputs: CapabilityResolutionInputs = {
    nativeInventory: { records: [], blockedLayers: [] },
    installedPlugins: [installed],
    activePluginInstances: { 'pk-1': INSTANCE },
    pluginCandidates: capabilities.map(capability => ({
      key: `plug:lsp:${capability.kind === 'lsp' ? capability.lsp.id : capability.id}`,
      pluginKey: 'pk-1',
      pluginInstanceId: INSTANCE,
      capabilityId: capability.id,
      kind: 'lsp',
      logicalName: capability.kind === 'lsp' ? capability.lsp.id : capability.id,
      selectedScope: { kind: 'global' },
      trust: { required: false },
      runtimeDefinition: capability,
    })),
    resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
    resolveTrust: () => 'trusted',
  };
  const resolver = createCapabilityResolver({ inputs: () => inputs });
  const snapshot = await resolver.resolve(CONTEXT);
  const lspServers = toAgentRuntime(snapshot).lspServers ?? [];
  resolver.releaseSnapshot(snapshot.leaseId);
  return { lspServers, generation: snapshot.generation };
}

describe('a Claude plugin\'s extensionToLanguage map', () => {
  it('reaches the registration exactly as declared, and picks a document\'s language from its extension', async () => {
    const { capabilities } = await lspCapabilities({ clangd: { command: 'clangd', extensionToLanguage: CLANGD_MAP } });
    const [registration] = (await resolveFor(capabilities)).lspServers;

    expect(registration?.extensionToLanguage).toEqual(CLANGD_MAP);
    expect([...(registration?.languages ?? [])].sort()).toEqual(['c', 'cpp']);
    const key = registration!.key;
    // Case is kept: `.C` is C++, `.c` is C.
    expect(resolvePluginLspDocumentLanguage([registration!], 'src/main.C')).toEqual({ key, languageId: 'cpp' });
    expect(resolvePluginLspDocumentLanguage([registration!], '/abs/src/util.c')).toEqual({ key, languageId: 'c' });
  });

  it('carries no entry it cannot route by, and names each one; routing then answers nothing rather than a guess', async () => {
    const { capabilities, diagnostics } = await lspCapabilities({
      go: { command: 'gopls', extensionToLanguage: { '.go': 'go', mod: 'gomod', '.sum': 7 } },
    });
    const [registration] = (await resolveFor(capabilities)).lspServers;

    // The server still starts; only the two malformed entries are left behind.
    expect(registration?.extensionToLanguage).toEqual({ '.go': 'go' });
    expect(diagnostics
      .filter(diagnostic => diagnostic.code === 'plugin.format.claude_lsp_field_invalid')
      .map(diagnostic => diagnostic.details?.extension)
      .sort()).toEqual(['.sum', 'mod']);
    // No extension, an extension nobody claims, and the key that was refused.
    expect(resolvePluginLspDocumentLanguage([registration!], 'Makefile')).toBeUndefined();
    expect(resolvePluginLspDocumentLanguage([registration!], 'main.rs')).toBeUndefined();
    expect(resolvePluginLspDocumentLanguage([registration!], 'go.mod')).toBeUndefined();
  });

  it('gives an extension two servers claim to the first one registered', async () => {
    // `plugins/components.md#lsp-servers`: "when two enabled servers claim the
    // same extension, the first registered handles those files and the other
    // isn't used for them".
    const first = { key: 'first', languages: ['typescript'], extensionToLanguage: { '.ts': 'typescript' } };
    const second = { key: 'second', languages: ['ts'], extensionToLanguage: { '.ts': 'ts' } };

    expect(resolvePluginLspDocumentLanguage([first, second], 'a.ts')).toEqual({ key: 'first', languageId: 'typescript' });
    expect(resolvePluginLspDocumentLanguage([second, first], 'a.ts')).toEqual({ key: 'second', languageId: 'ts' });
    // Our own `languages` spelling carries no map, so it claims no extension.
    expect(resolvePluginLspDocumentLanguage([{ key: 'legacy', languages: ['typescript'] }], 'a.ts')).toBeUndefined();
  });

  it('moves the generation when the map changes, so a retained server is re-provisioned with the new routing', async () => {
    // SessionManager keeps the registrations it routes by for as long as the
    // authority signature holds, and that signature hashes the generation.
    const generationOf = async (map: Record<string, string>): Promise<string> => {
      const { capabilities } = await lspCapabilities({ ts: { command: 'typescript-language-server', extensionToLanguage: map } });
      return (await resolveFor(capabilities)).generation;
    };
    const base = await generationOf({ '.ts': 'typescript' });

    expect(await generationOf({ '.ts': 'typescript' })).toBe(base);
    expect(await generationOf({ '.ts': 'typescript', '.mts': 'typescript' })).not.toBe(base);
  });
});
