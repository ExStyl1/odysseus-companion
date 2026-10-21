/**
 * T6 of the plugin-install usability plan (2026-07-31): install hygiene.
 *
 * The measured probe showed each install diagnostic printed TWICE (npx
 * installer-unavailable ×2, Codex app warnings ×2): `normalizeStagedInstall`
 * both appends its findings to `staged.diagnostics` and returns them, and the
 * manifest is validated twice. Plus two silences: nothing said when the
 * marketplace listing's version differed from the installed bundle's, and a
 * dual-format repo (honey ships both a Codex and a Claude manifest) never said
 * which manifest won.
 */

import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { PluginManagementServiceV2 } from '../management-service-v2.ts';
import { PluginStoreV2 } from '../store-v2.ts';
import type { PluginDiagnostic } from '../types.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-install-hygiene-'));
});

afterEach(async () => { await installs.settle(); // F1.424 — never remove a root under an install still copying into it
  rmSync(dir, { recursive: true, force: true });
});

function createService(): PluginManagementServiceV2 {
  return installs.track(new PluginManagementServiceV2({
    store: new PluginStoreV2({ rootDirectory: join(dir, 'plugins') }),
    policyStore: new CapabilityPolicyStore({
      globalPath: join(dir, 'capabilities.json'),
      workspacePolicyPath: workspaceId => join(dir, 'workspaces', workspaceId, 'capabilities.json'),
      workspaceIds: () => existsSync(join(dir, 'workspaces')) ? readdirSync(join(dir, 'workspaces')) : [],
    }),
    trustStore: new CapabilityTrustStore({ path: join(dir, 'capability-trust.json') }),
    fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
    baseTempDir: join(dir, 'staging'),
    pluginDataDir: join(dir, 'plugins', 'data'),
  }));
}

/** Codex bundle whose app references a connector with no bundled metadata. */
function createCodexAppBundle(): string {
  const root = join(dir, 'codex-app-mixed');
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'figma-mixed',
    version: '2.0.16',
    apps: './.app.json',
    skills: './skills/',
  }));
  writeFileSync(join(root, '.app.json'), JSON.stringify({
    apps: { figma: { id: 'connector_68df038e0ba48191908c8434991bbac2' } },
  }));
  mkdirSync(join(root, 'skills', 'figma-help'), { recursive: true });
  writeFileSync(join(root, 'skills', 'figma-help', 'SKILL.md'), [
    '---',
    'name: figma-help',
    'description: Explain Figma workflows.',
    '---',
    '',
    '# Figma help',
  ].join('\n'));
  return root;
}

/** A honey-shaped DUAL-format bundle: both a Codex and a Claude manifest. */
function createDualFormatBundle(): string {
  const root = join(dir, 'dual-format');
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'honey-like',
    version: '1.0.0',
    skills: './skills/',
  }));
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'honey-like',
    version: '1.0.0',
  }));
  mkdirSync(join(root, 'skills', 'buzz'), { recursive: true });
  writeFileSync(join(root, 'skills', 'buzz', 'SKILL.md'), [
    '---',
    'name: buzz',
    'description: Buzz.',
    '---',
    '',
    '# Buzz',
  ].join('\n'));
  return root;
}

function createPlainBundle(): string {
  const root = join(dir, 'plain');
  mkdirSync(join(root, 'skills', 'review'), { recursive: true });
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'plugin',
    id: 'toolkit',
    name: 'Toolkit',
    version: '1.0.0',
    capabilities: [{ kind: 'skill', id: 'review', skill: { slug: 'review', path: 'skills/review/SKILL.md' } }],
  }));
  writeFileSync(join(root, 'skills', 'review', 'SKILL.md'), '# Review');
  return root;
}

function countByCode(diagnostics: readonly PluginDiagnostic[], code: string): number {
  return diagnostics.filter(diagnostic => diagnostic.code === code).length;
}

describe('install hygiene (T6)', () => {
  it('reports each diagnostic exactly once — the Codex app warning is not doubled', async () => {
    const service = createService();
    const result = await service.install({ kind: 'local-path', path: createCodexAppBundle() });

    expect(result.ok).toBe(true);
    expect(countByCode(result.diagnostics, 'plugin.format.codex_app_connector_unresolved')).toBe(1);
    // No diagnostic of ANY code appears twice with identical content.
    const keys = result.diagnostics.map(diagnostic => JSON.stringify([
      diagnostic.severity, diagnostic.code, diagnostic.message, diagnostic.path ?? null, diagnostic.details ?? null,
    ]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('says so when the marketplace listing version differs from the installed bundle version', async () => {
    const service = createService();
    const result = await service.install({
      kind: 'local-path',
      path: createPlainBundle(),
      marketplace: { marketplaceId: 'internal', name: 'Toolkit', version: '2.0.0' },
    });

    expect(result.ok).toBe(true);
    const mismatch = result.diagnostics.filter(d => d.code === 'plugin.install.version_mismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.severity).toBe('info');
    expect(mismatch[0]?.message).toContain('2.0.0');
    expect(mismatch[0]?.message).toContain('1.0.0');
  });

  it('stays silent about versions when the listing and the bundle agree', async () => {
    const service = createService();
    const result = await service.install({
      kind: 'local-path',
      path: createPlainBundle(),
      marketplace: { marketplaceId: 'internal', name: 'Toolkit', version: '1.0.0' },
    });
    expect(result.ok).toBe(true);
    expect(countByCode(result.diagnostics, 'plugin.install.version_mismatch')).toBe(0);
  });

  it('names the manifest chosen for a dual-format (honey-shaped) bundle', async () => {
    const service = createService();
    const result = await service.install({ kind: 'local-path', path: createDualFormatBundle() });

    expect(result.ok).toBe(true);
    const choice = result.diagnostics.filter(d => d.code === 'plugin.install.manifest_format_selected');
    expect(choice).toHaveLength(1);
    expect(choice[0]?.severity).toBe('info');
    expect(choice[0]?.message).toContain('codex-plugin-json');
    expect(choice[0]?.message).toContain('claude');
  });

  it('never flags a single-manifest bundle as dual-format', async () => {
    const service = createService();
    const result = await service.install({ kind: 'local-path', path: createPlainBundle() });
    expect(result.ok).toBe(true);
    expect(countByCode(result.diagnostics, 'plugin.install.manifest_format_selected')).toBe(0);
  });
});

// F1.424 — every case here runs a REAL plugin-store install: a per-CASE budget, and a teardown that waits for every
// install still copying before it removes a root (`packages/shared/src/testing/install-tracker.ts` says why and what
// the tracker does not change). Placed last so no cited line moves: imports hoist, and bun applies a default set
// at module load to the cases registered above it (measured 2026-09-24).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '../../testing/module-graph-budgets.ts';
import { createInstallTracker } from '../../testing/install-tracker.ts';
setDefaultTimeout(MODULE_GRAPH_CASE_BUDGET_MS);
const installs = createInstallTracker();
