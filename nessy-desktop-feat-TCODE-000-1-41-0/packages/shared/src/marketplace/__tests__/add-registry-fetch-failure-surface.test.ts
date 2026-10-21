/**
 * F1.81 (origin D1.387) — where an added registry's catalogue failure already
 * travels, measured on the real registry source and the real list merge.
 *
 * ## The measured claim, and which half of it this file refutes
 *
 * RS-99 (SIT-6b, packaged 1.40.0): `marketplace.addRegistry` answered
 * `alreadyAdded: false`, the listing stayed at the 168 `skills-market` rows a
 * registry-free profile has, and "the only account of the failure is a debug
 * line a packaged build does not write" (`[marketplace-registry] catalog fetch
 * failed … plugin.install.repository_ref_unresolved`). The sitting read the
 * list's `total` and its rows. It did not read `registryLoadErrors`.
 *
 * Read before building, the design is deliberate and has three parts:
 *
 * 1. `add()` only RECORDS the row — it clones nothing, so it has no fetch
 *    outcome to report. The clone runs OFF the request path on the next list
 *    (`listItems` → `ensureBackgroundFetch`), so a slow network can never hang
 *    the browse list.
 * 2. That list answers `marketplace.registry.fetch_pending` for the registry
 *    while the clone runs, and the FAILURE's own codes once it settles — on the
 *    `loadErrors` → `registryLoadErrors` channel, which `PluginsPage` renders as
 *    the note of the registry's own section (`registryLoadErrorMessageKey`).
 * 3. The operator line is `console.warn`, which no debug switch gates — it is
 *    the channel `createLogger` (the F1.143 / F1.177 route) would make QUIETER,
 *    since that one writes only under `NESSY_DEBUG=1`.
 *
 * So the failure was never only a log line: the wire carried it. What was
 * silent is the one place the user stands after the add — the page kept its
 * current marketplace chip, and the section that renders the note is the new
 * registry's. That half is `apps/electron/src/renderer/pages/__tests__/
 * add-registry-lands-on-its-section.test.ts`.
 *
 * Nothing is planted but the network: the staging service fails the clone with
 * the same staging diagnostic the measured run named, the way the real
 * acquisition path reports an unresolvable ref.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRegistrySource, type MarketplaceRegistryStore } from '../registry-source.ts';
import { MarketplaceService } from '../service.ts';
import type { SkillsMarketClient } from '../client.ts';
import type { MarketplaceRawListResult, PluginDto } from '../types.ts';
import { createPluginStagingArea, resolvePluginInstallSource } from '../../plugins/source-resolver.ts';
import type {
  PluginInstallPlan,
  PluginMarketplaceRegistry,
  PluginStagedInstall,
  RegistryStagingService,
} from '../../plugins/index.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'f181-add-registry-'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

class MemoryRegistryStore implements MarketplaceRegistryStore {
  constructor(private registries: PluginMarketplaceRegistry[] = []) {}
  async readMarketplaceRegistries() {
    return { schemaVersion: 1, updatedAt: 0, registries: [...this.registries] };
  }
  async writeMarketplaceRegistries(file: { registries: PluginMarketplaceRegistry[]; schemaVersion: number; updatedAt: number }) {
    this.registries = [...file.registries];
  }
}

/** A clone that cannot resolve its ref — the staging diagnostic RS-99 named. */
class UnresolvableRefStaging implements RegistryStagingService {
  stageCalls = 0;
  async createInstallPlanFromSource(source: string | import('../../plugins/types.ts').PluginInstallSource): Promise<PluginInstallPlan> {
    const resolved = resolvePluginInstallSource(source);
    return {
      state: 'resolved',
      planId: 'plan-f181',
      source: resolved.source,
      origin: resolved.origin,
      ...(resolved.artifact ? { artifact: resolved.artifact } : {}),
      diagnostics: [],
      createdAt: 0,
      lifecycle: [],
    };
  }
  async stageInstall(plan: PluginInstallPlan, options: { baseTempDir?: string } = {}): Promise<PluginStagedInstall> {
    this.stageCalls += 1;
    const staged = await createPluginStagingArea(plan, { baseTempDir: options.baseTempDir });
    staged.diagnostics = [...staged.diagnostics, {
      severity: 'error',
      code: 'plugin.install.repository_ref_unresolved',
      message: 'The repository ref could not be resolved.',
    } as PluginStagedInstall['diagnostics'][number]];
    return staged;
  }
}

/** The 168-row built-in catalogue's stand-in: one Skills Market row. */
function skillsMarket(): SkillsMarketClient {
  const raw: MarketplaceRawListResult<PluginDto> = {
    items: [{ id: 'sm-1', name: 'Skills Market Plugin', version: '1.0.0' }],
    page: 1, pageSize: 100, total: 1, visible: 1, raw: {},
  };
  return {
    async listMarketplacePlugins() { return raw; },
    async listMarketplaceSkills() { return raw; },
  } as unknown as SkillsMarketClient;
}

function rig() {
  const staging = new UnresolvableRefStaging();
  const registrySource = new PluginRegistrySource({
    store: new MemoryRegistryStore(),
    staging,
    baseTempDir: tempDir,
    now: () => 1_000_000,
    env: {},
  });
  const service = new MarketplaceService({ client: skillsMarket(), registrySource });
  return { staging, registrySource, service };
}

describe('F1.81 · an added registry whose catalogue cannot be fetched', () => {
  it('the add reports success, because the add fetches nothing', async () => {
    // The measured answer, reproduced — and the reason for it: no clone ran.
    const { staging, registrySource } = rig();
    const added = await registrySource.add({ source: 'anthropics/claude-plugins-official' });
    expect(added.alreadyAdded).toBe(false);
    expect(staging.stageCalls).toBe(0);
  });

  it('the list carries the failure on registryLoadErrors — pending first, then the codes', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { staging, registrySource, service } = rig();
      const added = await registrySource.add({ source: 'anthropics/claude-plugins-official' });

      const first = await service.list({ kind: 'plugins', page: 1, pageSize: 100 });
      // RS-99's reading, reproduced: the rows are the built-in catalogue's only.
      expect(first.items.map(item => item.id)).toEqual(['sm-1']);
      // ...and the half it did not read: the registry is named as still loading.
      const pending = (first.registryLoadErrors ?? []).find(error => error.marketplaceRegistryId === added.marketplaceId);
      expect(pending?.diagnosticCodes).toEqual(['marketplace.registry.fetch_pending']);

      await registrySource.awaitPendingFetches();
      expect(staging.stageCalls).toBe(1);
      const settled = await service.list({ kind: 'plugins', page: 1, pageSize: 100 });
      expect(settled.items.map(item => item.id)).toEqual(['sm-1']);
      const failure = (settled.registryLoadErrors ?? []).find(error => error.marketplaceRegistryId === added.marketplaceId);
      expect(failure?.diagnosticCodes).toContain('plugin.install.repository_ref_unresolved');
      expect(failure?.diagnosticCodes).not.toContain('marketplace.registry.fetch_pending');

      // The operator line is console.warn — ungated, unlike a createLogger line.
      const lines = warn.mock.calls.map(call => String(call[0]));
      expect(lines.some(line => line.startsWith('[marketplace-registry] catalog fetch failed')
        && line.includes('plugin.install.repository_ref_unresolved'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('CONTROL: a registry-free profile lists no load error at all', async () => {
    // Proves the field is not always populated — the entries above are this
    // registry's, not a default.
    const { service } = rig();
    const result = await service.list({ kind: 'plugins', page: 1, pageSize: 100 });
    expect(result.registryLoadErrors).toBeUndefined();
  });
});
