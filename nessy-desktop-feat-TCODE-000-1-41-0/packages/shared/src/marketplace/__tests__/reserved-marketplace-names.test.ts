/**
 * P6.41 — the reserved marketplace names, at ADD and at LOAD.
 *
 * `plugins/marketplace-reference.md#reserved-names` (re-pointed 2026-10-01, F1.1033:
 * the plugin-marketplaces page whose first required-fields heading held the
 * reserved-names Note left the docs index; the quote is as read on that page):
 *
 *   "Reserving these names prevents a third-party marketplace from presenting
 *   itself as an Anthropic-published source."
 *
 *   "Claude Code re-checks reserved names every time it loads a marketplace, not
 *   only when you add one."
 *
 * Measured at HEAD before this suite existed: `add`ing
 * `https://cdn.example.com/claude-plugins-official` registered a marketplace
 * whose display name was exactly `claude-plugins-official`, with no refusal and
 * no diagnostic; `https://evil.example.com/agent-skills.git` did the same for
 * `agent-skills`. The positive control on the same run —
 * `https://github.com/evil/claude-plugins-official` deriving `evil/claude-plugins-official`
 * — proves the label really is derived rather than collapsing to a constant.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MarketplaceReservedNameError,
  PluginRegistrySource,
  type MarketplaceRegistrySourceOptions,
  type MarketplaceRegistryStore,
} from '../registry-source.ts';
import {
  RESERVED_MARKETPLACE_NAMES,
  canonicalMarketplaceName,
  reservedMarketplaceNameFor,
} from '../reserved-names.ts';
import { createPluginStagingArea, resolvePluginInstallSource } from '../../plugins/source-resolver.ts';
import type {
  PluginInstallPlan,
  PluginMarketplaceRegistry,
  PluginStagedInstall,
  RegistryStagingService,
} from '../../plugins/index.ts';

let tempDir: string;
beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'reserved-names-test-')); });
afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

class MemoryRegistryStore implements MarketplaceRegistryStore {
  writes = 0;
  constructor(private registries: PluginMarketplaceRegistry[] = []) {}
  async readMarketplaceRegistries() {
    return { schemaVersion: 1, updatedAt: 0, registries: [...this.registries] };
  }
  async writeMarketplaceRegistries(file: {
    registries: PluginMarketplaceRegistry[]; schemaVersion: number; updatedAt: number;
  }) {
    this.writes += 1;
    this.registries = [...file.registries];
  }
  snapshot() { return this.registries; }
}

function fakePlan(source: string | import('../../plugins/types.ts').PluginInstallSource): PluginInstallPlan {
  const resolved = resolvePluginInstallSource(source);
  return {
    state: 'resolved',
    planId: 'plan-1',
    source: resolved.source,
    origin: resolved.origin,
    ...(resolved.artifact ? { artifact: resolved.artifact } : {}),
    diagnostics: [],
    createdAt: 0,
    lifecycle: [],
  };
}

/** FAKE staging. `stageCalls` is the assertion that no clone was paid for. */
class FakeStagingService implements RegistryStagingService {
  stageCalls = 0;
  constructor(private readonly files: Record<string, string> = {}) {}
  async createInstallPlanFromSource(source: string | import('../../plugins/types.ts').PluginInstallSource) {
    return fakePlan(source);
  }
  async stageInstall(plan: PluginInstallPlan, options: { baseTempDir?: string } = {}): Promise<PluginStagedInstall> {
    this.stageCalls += 1;
    const staged = await createPluginStagingArea(plan, { baseTempDir: options.baseTempDir });
    for (const [name, contents] of Object.entries(this.files)) {
      const target = join(staged.rawDirectory, name);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, contents);
    }
    return staged;
  }
}

describe('reservedMarketplaceNameFor', () => {
  it('claims every one of the page\'s sixteen names, exactly', () => {
    expect(RESERVED_MARKETPLACE_NAMES).toHaveLength(16);
    for (const name of RESERVED_MARKETPLACE_NAMES) {
      expect(reservedMarketplaceNameFor(name)).toBe(name);
      // Casing and surrounding whitespace are presentation, not identity.
      expect(reservedMarketplaceNameFor(`  ${name.toUpperCase()}  `)).toBe(name);
    }
  });

  it('blocks the page\'s two impersonation examples, and names what they collide with', () => {
    // "Names that impersonate official marketplaces, such as
    // `official-claude-plugins` or `anthropic-plugins-v2`, are also blocked."
    expect(reservedMarketplaceNameFor('official-claude-plugins')).toBe('claude-plugins-official');
    expect(reservedMarketplaceNameFor('anthropic-plugins-v2')).toBe('anthropic-plugins');
    // The same two rules, one step further, so the mechanism is pinned and not
    // just its two examples: reordering and a bare numeric suffix.
    expect(reservedMarketplaceNameFor('plugins_official_claude')).toBe('claude-plugins-official');
    expect(reservedMarketplaceNameFor('agent-skills-2')).toBe('agent-skills');
  });

  it('leaves alone every name the rule deliberately does not reach', () => {
    // An owner-qualified label is NOT presenting itself as Anthropic-published:
    // this is the derived label for `https://github.com/evil/claude-plugins-official`.
    expect(reservedMarketplaceNameFor('evil/claude-plugins-official')).toBeUndefined();
    // Residue 1 in `reserved-names.ts`, pinned as a deliberate non-refusal
    // rather than left to be discovered as a regression: supersets and near-miss
    // spellings are out of the rule's reach on purpose.
    expect(reservedMarketplaceNameFor('my-anthropic-plugins-mirror')).toBeUndefined();
    expect(reservedMarketplaceNameFor('claude-plugins-oficial')).toBeUndefined();
    expect(reservedMarketplaceNameFor('acme-tools')).toBeUndefined();
    expect(reservedMarketplaceNameFor('')).toBeUndefined();
  });

  it('canonicalises by sorted tokens, keeping a lone version token', () => {
    expect(canonicalMarketplaceName('Anthropic_Plugins')).toBe('anthropic-plugins');
    // `tokens.length > 1` guard: a name that is ONLY a version token survives.
    expect(canonicalMarketplaceName('v2')).toBe('v2');
  });
});

describe('PluginRegistrySource and the reserved marketplace names', () => {
  const RESERVING_URL = 'https://cdn.example.com/claude-plugins-official';

  it('refuses `add` before touching the store or staging anything', async () => {
    const store = new MemoryRegistryStore();
    const staging = new FakeStagingService();
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    await expect(source.add({ source: RESERVING_URL }))
      .rejects.toThrow(MarketplaceReservedNameError);
    // The refusal has to SAY which reservation it hit — that is the whole row.
    await expect(source.add({ source: RESERVING_URL }))
      .rejects.toThrow(/"claude-plugins-official"/);
    expect(store.writes).toBe(0);
    expect(store.snapshot()).toEqual([]);
    expect(staging.stageCalls).toBe(0);
  });

  it('admits the same repository under its owner-qualified label', async () => {
    // Positive control for the refusal above: the guard reads a derived name, so
    // a source whose derived name is not reserved must still register.
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({ store, staging: new FakeStagingService(), baseTempDir: tempDir });

    const added = await source.add({ source: 'https://github.com/evil/claude-plugins-official' });
    expect(added.displayName).toBe('evil/claude-plugins-official');
    expect(store.snapshot()).toHaveLength(1);
  });

  it('admits a reserved name when the source really is the official Anthropic marketplace', async () => {
    // The page reserves the names "for official Anthropic use" — the reservation
    // is against third parties, not against the official source itself.
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({ store, staging: new FakeStagingService(), baseTempDir: tempDir });

    const added = await source.add({
      source: 'anthropics/claude-plugins-official',
      displayName: 'claude-plugins-official',
    });
    expect(added.displayName).toBe('claude-plugins-official');
    expect(store.snapshot()).toHaveLength(1);
  });

  it('re-checks on LOAD, so a row that predates the reservation stops loading', async () => {
    // "Claude Code re-checks reserved names every time it loads a marketplace,
    // not only when you add one." A row already in `marketplaces.json` never
    // passes through `add()` again, so the add gate alone would leave it live.
    const staging = new FakeStagingService({
      'marketplace.json': JSON.stringify({ name: 'Impostor', plugins: [] }),
    });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([
        { id: 'registry-legacy', source: RESERVING_URL, displayName: 'claude-plugins-official', addedAt: 0 },
      ]),
      staging,
      baseTempDir: tempDir,
    });

    await source.listItems();
    await source.awaitPendingFetches();
    const result = await source.listItems();

    expect(result.items).toEqual([]);
    expect(result.loadErrors?.[0]?.diagnosticCodes).toEqual(['marketplace.registry.reserved_name']);
    expect(result.loadErrors?.[0]?.displayName).toBe('claude-plugins-official');
    // Refused BEFORE the clone: a marketplace we will not load costs no network.
    expect(staging.stageCalls).toBe(0);
  });

  it('keeps loading a legacy row whose name is not reserved', async () => {
    // Positive control on the same rig: the load gate must not be a blanket stop.
    const staging = new FakeStagingService({
      'marketplace.json': JSON.stringify({
        name: 'Acme', plugins: [{ name: 'toolkit', source: 'https://github.com/acme/toolkit' }],
      }),
    });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([
        { id: 'registry-ok', source: 'https://github.com/acme/registry', displayName: 'acme-tools', addedAt: 0 },
      ]),
      staging,
      baseTempDir: tempDir,
    });

    await source.listItems();
    await source.awaitPendingFetches();
    const result = await source.listItems();

    expect(result.loadErrors).toBeUndefined();
    expect(result.items).toHaveLength(1);
    expect(staging.stageCalls).toBe(1);
  });

  it('refuses `upgrade` by name rather than reporting a fetch that never happened', async () => {
    // A GIT source, so the pre-existing `not-git` no-op cannot be what stops it:
    // this is the shape a delivered row left behind on a machine that registered
    // it before the gate existed, refreshed by hand from the Plugins page.
    const store = new MemoryRegistryStore([
      {
        id: 'registry-legacy',
        source: 'https://gitlab.example.com/anyone/mirror.git',
        displayName: 'claude-plugins-official',
        addedAt: 0,
      },
    ]);
    const staging = new FakeStagingService();
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    await expect(source.upgrade({ marketplaceId: 'registry-legacy' }))
      .rejects.toThrow(/reserved for official Anthropic use/);
    expect(store.writes).toBe(0);
    expect(staging.stageCalls).toBe(0);
  });

  it('reports a delivered entry refused by name as its own outcome, and delivers the rest', async () => {
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({
      store,
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      extraKnownMarketplaces: [
        { name: 'claude-plugins-official', source: 'https://gitlab.example.com/anyone/mirror.git' },
        { name: 'corp-plugins', source: 'https://gitlab.example.com/corp/plugins.git' },
      ],
    });

    const outcomes = await source.ensureDeliveredMarketplaces();
    expect(outcomes.map(outcome => [outcome.name, outcome.state])).toEqual([
      ['claude-plugins-official', 'refused-reserved-name'],
      ['corp-plugins', 'registered'],
    ]);
    expect(store.snapshot().map(registry => registry.displayName)).toEqual(['corp-plugins']);
  });
});

/**
 * P2.430 — the SECOND documented reservation, pinned as a deliberate
 * NON-refusal rather than left to be closed by accident.
 *
 * `plugins/marketplace-reference.md#validation-messages`, Warnings
 * (non-blocking): "`Marketplace name "x" is reserved in Claude Desktop`: the
 * marketplace is named `org`, `org-provisioned`, or `unknown`, in any casing.
 * Claude Code accepts these names, but Claude Desktop's managed marketplace
 * sync rejects the whole marketplace."
 *
 * Nessy is NEITHER of that sentence's two surfaces — not Claude Desktop's
 * managed sync (keyed on `allowedPluginMarketplaces`, which this fork has no
 * integration with), and not `claude plugin validate` pointed at a marketplace
 * DIRECTORY (this fork's validate verb checks a plugin bundle). The verdict and
 * its measurements are recorded in full in `reserved-names.ts`. These tests are
 * what stops it drifting: the gates below are Claude CODE positions, and the
 * page says Claude Code accepts these names, so a refusal here would be a
 * defect. Each case carries a positive control on the same rig, because an
 * assertion that nothing happened is worthless if nothing could have.
 */
describe('the Claude Desktop reservation, which this fork does not own', () => {
  it('does not claim `org`, `org-provisioned` or `unknown`, in any casing', () => {
    for (const name of ['org', 'org-provisioned', 'unknown']) {
      expect(reservedMarketplaceNameFor(name)).toBeUndefined();
      // "in any casing" is the page's phrase for the check we are NOT running.
      expect(reservedMarketplaceNameFor(name.toUpperCase())).toBeUndefined();
    }
    // Nor the sibling warning in the same list: `Marketplace name "x" is not
    // accepted by Claude Desktop` covers names outside
    // `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. Same owner, same verdict.
    expect(reservedMarketplaceNameFor('-leading-hyphen')).toBeUndefined();
    expect(reservedMarketplaceNameFor('a'.repeat(200))).toBeUndefined();
    // Positive control: the predicate is live on this run, so the five
    // undefineds above are a decision and not a dead function.
    expect(reservedMarketplaceNameFor('healthcare')).toBe('healthcare');
  });

  it('adds a marketplace whose derived name is one of the three', async () => {
    const store = new MemoryRegistryStore();
    const staging = new FakeStagingService();
    const source = new PluginRegistrySource({ store, staging, baseTempDir: tempDir });

    // Same shape P6.41 measured for the sixteen — a bare URL whose last path
    // segment becomes the label — so the two verdicts are compared like for
    // like, and only the name differs.
    expect((await source.add({ source: 'https://cdn.example.com/org' })).displayName).toBe('org');
    expect((await source.add({ source: 'https://cdn.example.com/unknown' })).displayName).toBe('unknown');
    expect(store.snapshot().map(registry => registry.displayName)).toEqual(['org', 'unknown']);

    // Positive control on the same rig: the add gate IS armed on this run.
    await expect(source.add({ source: 'https://cdn.example.com/claude-plugins-official' }))
      .rejects.toThrow(MarketplaceReservedNameError);
  });

  it('delivers a managed entry named `org`, and still refuses the reserved one beside it', async () => {
    // Managed delivery supplies the name directly rather than deriving it, so
    // it is the path where an administrator could most plausibly write `org`.
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({
      store,
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      extraKnownMarketplaces: [
        { name: 'org', source: 'https://gitlab.example.com/corp/org.git' },
        { name: 'org-provisioned', source: 'https://gitlab.example.com/corp/provisioned.git' },
        { name: 'unknown', source: 'https://gitlab.example.com/corp/unknown.git' },
        { name: 'anthropic-plugins', source: 'https://gitlab.example.com/anyone/mirror.git' },
      ],
    });

    const outcomes = await source.ensureDeliveredMarketplaces();
    expect(outcomes.map(outcome => [outcome.name, outcome.state])).toEqual([
      ['org', 'registered'],
      ['org-provisioned', 'registered'],
      ['unknown', 'registered'],
      ['anthropic-plugins', 'refused-reserved-name'],
    ]);
  });

  it('keeps loading a persisted row named `unknown`', async () => {
    // The load gate is the page's re-check for the SIXTEEN. It must not have
    // grown a second list on the way past.
    const staging = new FakeStagingService({
      'marketplace.json': JSON.stringify({
        name: 'Corp', plugins: [{ name: 'toolkit', source: 'https://github.com/acme/toolkit' }],
      }),
    });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([
        { id: 'registry-corp', source: 'https://cdn.example.com/unknown', displayName: 'unknown', addedAt: 0 },
      ]),
      staging,
      baseTempDir: tempDir,
    });

    await source.listItems();
    await source.awaitPendingFetches();
    const result = await source.listItems();

    expect(result.loadErrors).toBeUndefined();
    expect(result.items).toHaveLength(1);
    expect(staging.stageCalls).toBe(1);
  });
});
/**
 * P2.442 — `allowedPluginMarketplaces`, the settings key the shipped Claude
 * binary names in its own warning text and no published page names at all.
 *
 * Measured: 0 files / 0 hits across all 191 pages of
 * `scripts/claude-doc-pages.tsv`, and no other spelling of the shape either
 * (`[A-Za-z]*PluginMarketplace[a-zA-Z]*` matches nothing in the corpus), against
 * `extraKnownMarketplaces` at 14 files / 52 hits as the positive control. In the
 * binary all six occurrences sit inside message text — probed as an object key
 * or assignment target (`allowedPluginMarketplaces` followed by `:` or `=`) the
 * count is 0, against a control of 5 for `extraKnownMarketplaces`. The runtime
 * we ship QUOTES the key; it never reads it.
 *
 * The verdict and its reasoning live in `reserved-names.ts`. These tests are
 * what stops it drifting into a truth nobody re-checked: they hand this fork the
 * key, in the shape a managed settings blob would carry it, and show that
 * nothing changes. Each case carries a positive control on the same rig, because
 * an assertion that nothing happened is worthless if nothing could have.
 */
describe('allowedPluginMarketplaces, a managed key with no reader in this fork', () => {
  /**
   * The blob an administrator who ALSO runs Claude Desktop would write: the two
   * keys this fork reads, plus the one it does not. The cast is the invariant
   * rather than a convenience — `MarketplaceRegistrySourceOptions` does not
   * declare the key, and the test exists to show that an undeclared key reaching
   * the constructor reaches no reader.
   */
  function withDesktopKey(
    options: MarketplaceRegistrySourceOptions,
    allowed: readonly string[],
  ): MarketplaceRegistrySourceOptions {
    return { ...options, allowedPluginMarketplaces: allowed } as MarketplaceRegistrySourceOptions;
  }

  it('delivers every managed marketplace even when the blob allows none of them', async () => {
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource(withDesktopKey({
      store,
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      extraKnownMarketplaces: [
        { name: 'corp-plugins', source: 'https://gitlab.example.com/corp/plugins.git' },
        { name: 'org', source: 'https://gitlab.example.com/corp/org.git' },
        { name: 'anthropic-plugins', source: 'https://gitlab.example.com/anyone/mirror.git' },
      ],
      // An allowlist naming NEITHER marketplace above. Claude Desktop's managed
      // sync rejects the whole marketplace on this key; here it has no reader,
      // so both entries must still register.
    }, ['a-marketplace-nobody-delivered']));

    const outcomes = await source.ensureDeliveredMarketplaces();
    expect(outcomes.map(outcome => [outcome.name, outcome.state])).toEqual([
      ['corp-plugins', 'registered'],
      ['org', 'registered'],
      // Positive control INSIDE the same run: delivery is armed and does refuse
      // on the one rule this fork owns, so the two `registered` rows above are a
      // decision about this key and not a dead delivery path.
      ['anthropic-plugins', 'refused-reserved-name'],
    ]);
    expect(store.snapshot().map(registry => registry.displayName)).toEqual(['corp-plugins', 'org']);
  });

  it('adds an interactive marketplace the blob does not allow', async () => {
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource(withDesktopKey({
      store,
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
    }, []));

    // `[]` is the narrowest an allowlist can be. `strictKnownMarketplaces` at
    // `[]` IS a complete lockdown here (`plugins/org.md#allowlist-with-strictknownmarketplaces`), so a
    // reader that treated this key the same way would refuse the add below —
    // which is exactly the drift these two assertions exist to catch.
    const added = await source.add({ source: 'https://github.com/acme/registry' });
    expect(added.displayName).toBe('acme/registry');
    expect(store.snapshot()).toHaveLength(1);

    // Positive control on the same rig: the add gate is live on this run.
    await expect(source.add({ source: 'https://cdn.example.com/claude-plugins-official' }))
      .rejects.toThrow(MarketplaceReservedNameError);
  });
});
