/**
 * P2.467 — `blockedMarketplaces`, at ADD, at UPGRADE, at LOAD and at DELIVERY.
 *
 * `settings-reference.md#blockedmarketplaces` (published exactly once on the
 * rendered page, `id="blockedmarketplaces"`, no `-2` twin):
 *
 *   "Block plugin marketplace sources for your organization. Claude Code checks
 *   the blocklist on marketplace add and on plugin install, update, refresh, and
 *   auto-update, so a marketplace someone added before you set the policy can't
 *   be used to fetch plugins either. Blocked sources are checked before download,
 *   so they never touch the filesystem."
 *
 * WHY THIS SUITE IS SHAPED THE WAY IT IS. The neighbouring key P2.442 closed was
 * safe to record as a null because it is an ALLOWLIST: unenforced, it could only
 * ever have narrowed what an operator may do. This one is a BLOCKLIST, and
 * unenforced it fails OPEN — an administrator sets it, sees no error, and the
 * marketplaces they blocked keep working. So every case below has a positive
 * control on the same rig that proves the source WOULD have been admitted without
 * the entry; a blocklist test that only asserts refusals cannot tell a working
 * guard from one that refuses everything.
 *
 * The NEAR-MISS cases are the other half. Blocklist matching is documented as
 * wider than allowlist matching in four ways
 * (`settings-reference.md#owner-wildcards`), and each of the four is a place an
 * allowlist-shaped comparison silently admits a source the administrator named:
 * a git-URL spelling of a blocked repo, a differently-cased owner, a ref-pinned
 * source under an entry naming no ref, a path-scoped source under an entry naming
 * no path.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MarketplaceSourceBlockedError,
  MarketplaceSourceNotAllowedError,
  PluginRegistrySource,
  type MarketplaceRegistryStore,
} from '../registry-source.ts';
import {
  blockedMarketplaceEntryFor,
  managedMarketplaceSourceIdentity,
  parseBlockedMarketplaceEntryList,
  parseManagedMarketplaceEntryList,
  type ManagedMarketplaceEntryV1,
} from '../../agent/pi-harness/managed-marketplace-entries.ts';
import { createPluginStagingArea, resolvePluginInstallSource } from '../../plugins/source-resolver.ts';
import type {
  PluginInstallPlan,
  PluginMarketplaceRegistry,
  PluginStagedInstall,
  RegistryStagingService,
} from '../../plugins/index.ts';
import { parseManagedPiPolicyTolerantV1 } from '../../agent/pi-harness/managed-policy.ts';
import type { ManagedPolicyDropV1 } from '../../config/managed-drops.ts';

let tempDir: string;
beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'blocked-marketplaces-test-')); });
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

/** A tolerant drop sink, the shape `parseManagedPiPolicy` hands its parsers. */
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

const blocked = (...entries: ManagedMarketplaceEntryV1[]): readonly ManagedMarketplaceEntryV1[] => entries;

/** Does this blocklist refuse this source? The predicate under the gate. */
function refuses(entries: readonly ManagedMarketplaceEntryV1[], source: string, refName?: string): boolean {
  return blockedMarketplaceEntryFor(entries, managedMarketplaceSourceIdentity(source, refName)) !== undefined;
}

describe('blockedMarketplaceEntryFor — what an entry matches on', () => {
  it('matches the SOURCE identity, and is untouched by the display name', () => {
    // The load-bearing choice. `displayName` is the one field a user picks freely
    // at add time, so a blocklist keyed on it is bypassable by construction. The
    // entry names a repository; the label is irrelevant to whether it matches.
    const entries = blocked({ source: 'github', repo: 'untrusted/plugins' });
    expect(refuses(entries, 'untrusted/plugins')).toBe(true);
    // POSITIVE CONTROL: a different repository under an identical-looking label
    // is admitted, so the predicate is reading the source and not a constant.
    expect(refuses(entries, 'trusted/plugins')).toBe(false);
  });

  it('an absent blocklist and an empty one both block nothing', () => {
    // Unlike `strictKnownMarketplaces`, where `[]` is a complete lockdown.
    expect(refuses([], 'untrusted/plugins')).toBe(false);
    expect(blockedMarketplaceEntryFor(undefined, managedMarketplaceSourceIdentity('untrusted/plugins')))
      .toBeUndefined();
  });

  it('names the entry that refused, so the refusal can say which rule fired', () => {
    const entry = blockedMarketplaceEntryFor(
      blocked({ source: 'github', repo: 'other/repo' }, { source: 'github', repo: 'untrusted/plugins' }),
      managedMarketplaceSourceIdentity('untrusted/plugins'),
    );
    expect(entry).toEqual({ source: 'github', repo: 'untrusted/plugins' });
  });
});

describe('the four documented rules that make blocklist matching WIDER', () => {
  // `settings-reference.md#owner-wildcards`, the table headed "The matching rules
  // differ between the two settings". Each `it` is one row, and each carries the
  // allowlist behaviour as its foil: these are precisely the near-misses an
  // allowlist-shaped comparison admits.

  it('row 1 — any spelling, including a git URL resolving to the same repository', () => {
    // "Matching source spellings: Any spelling, including git URLs that resolve
    // to the same github.com repository" (allowlist: "`owner/repo` form only. A
    // git URL that clones the same repository doesn't match").
    const entries = blocked({ source: 'github', repo: 'untrusted/plugins' });
    for (const spelling of [
      'untrusted/plugins',
      'https://github.com/untrusted/plugins',
      'https://github.com/untrusted/plugins.git',
      'git@github.com:untrusted/plugins.git',
      'https://github.com/untrusted/plugins/tree/main',
    ]) {
      expect({ spelling, refused: refuses(entries, spelling) }).toEqual({ spelling, refused: true });
    }
    // POSITIVE CONTROL on the same spellings: a different host is not this repo,
    // so the convergence is on identity rather than on substring luck.
    expect(refuses(entries, 'https://gitlab.example.com/untrusted/plugins.git')).toBe(false);
  });

  it('row 2 — the owner comparison is case-INSENSITIVE', () => {
    // "Owner case: Case-insensitive" (allowlist: "Case-sensitive, like
    // exact-entry matching"). The classic near-miss: an administrator writes the
    // owner as it appears on GitHub, the user types it lower-cased.
    const entries = blocked({ source: 'github', repo: 'Untrusted-Org/Plugins' });
    expect(refuses(entries, 'untrusted-org/plugins')).toBe(true);
    expect(refuses(entries, 'UNTRUSTED-ORG/PLUGINS')).toBe(true);
    // POSITIVE CONTROL: case-insensitivity is not name-insensitivity.
    expect(refuses(entries, 'untrusted-org/other')).toBe(false);
  });

  it('row 3 — an entry without a `ref` blocks ALL refs', () => {
    // "`ref`: An entry without a `ref` blocks all refs of the repositories it
    // matches" (allowlist: an entry without one "matches only sources that don't
    // specify a ref"). Under allowlist semantics a pinned ref walks straight
    // past a blocklist that names the repository.
    const entries = blocked({ source: 'github', repo: 'untrusted/plugins' });
    expect(refuses(entries, 'untrusted/plugins', 'v2.0')).toBe(true);
    expect(refuses(entries, 'https://github.com/untrusted/plugins#release')).toBe(true);
    // And an entry that DOES name a ref keeps the exact-match rule, so an
    // administrator can block one branch without blocking the repository.
    const pinned = blocked({ source: 'github', repo: 'untrusted/plugins', ref: 'v2.0' });
    expect(refuses(pinned, 'untrusted/plugins', 'v2.0')).toBe(true);
    expect(refuses(pinned, 'untrusted/plugins', 'v1.0')).toBe(false);
    expect(refuses(pinned, 'untrusted/plugins')).toBe(false);
  });

  it('row 4 — an entry without a `path` blocks ALL paths', () => {
    // "`path`: An entry without a `path` blocks all paths of the repositories it
    // matches." A subdirectory marketplace in a blocked repository is still in
    // the blocked repository.
    const entries = blocked({ source: 'github', repo: 'untrusted/plugins' });
    expect(refuses(entries, 'https://github.com/untrusted/plugins/tree/main/marketplace')).toBe(true);
    const scoped = blocked({ source: 'github', repo: 'untrusted/plugins', path: 'marketplace' });
    expect(refuses(scoped, 'https://github.com/untrusted/plugins/tree/main/marketplace')).toBe(true);
    expect(refuses(scoped, 'https://github.com/untrusted/plugins/tree/main/other')).toBe(false);
  });

  it('the owner WILDCARD blocks every repository under the owner', () => {
    // "A `github` entry whose `repo` value is `"<owner>/*"` matches every
    // repository under that GitHub owner … work only in `strictKnownMarketplaces`
    // and `blockedMarketplaces`."
    const entries = blocked({ source: 'github', repo: 'untrusted-org/*' });
    expect(refuses(entries, 'untrusted-org/plugins')).toBe(true);
    expect(refuses(entries, 'untrusted-org/anything-else')).toBe(true);
    expect(refuses(entries, 'https://github.com/UNTRUSTED-ORG/tools.git')).toBe(true);
    // POSITIVE CONTROL: the wildcard is scoped to the owner it names.
    expect(refuses(entries, 'other-org/plugins')).toBe(false);
  });

  it('a `url` entry ignores a `.git` suffix and a `#ref`, and nothing else', () => {
    // "In that comparison, Claude Code ignores the `.git` suffix and any ref the
    // user appends after `#`." Narrower than a full canonicalisation on purpose:
    // the page names two things to ignore, and a third would refuse sources
    // upstream admits.
    const entries = blocked({ source: 'url', url: 'https://plugins.example.com/marketplace.json' });
    expect(refuses(entries, 'https://plugins.example.com/marketplace.json')).toBe(true);
    expect(refuses(entries, 'https://plugins.example.com/marketplace.json#v2')).toBe(true);
    expect(refuses(entries, 'https://cdn.example.com/other.json')).toBe(false);
    const repoUrl = blocked({ source: 'url', url: 'https://gitlab.example.com/untrusted/plugins' });
    expect(refuses(repoUrl, 'https://gitlab.example.com/untrusted/plugins.git')).toBe(true);
  });

  it('`hostPattern` and `pathPattern` match as they do in the allowlist', () => {
    // The recorded RESIDUE: the page says a blocklist `hostPattern` "takes a host
    // from a wider set of forms" and never enumerates that set, so these two are
    // unchanged rather than widened by invention.
    const host = blocked({ source: 'hostPattern', hostPattern: '^untrusted\\.example\\.com$' });
    expect(refuses(host, 'https://untrusted.example.com/marketplace.json')).toBe(true);
    expect(refuses(host, 'git@untrusted.example.com:team/plugins.git')).toBe(true);
    expect(refuses(host, 'https://trusted.example.com/marketplace.json')).toBe(false);
    const path = blocked({ source: 'pathPattern', pathPattern: '^/tmp/untrusted/' });
    expect(refuses(path, '/tmp/untrusted/plugins')).toBe(true);
    // `..`-collapsed before matching, so a traversal cannot dodge the pattern.
    expect(refuses(path, '/tmp/untrusted/../trusted/plugins')).toBe(false);
  });
});

describe('parseBlockedMarketplaceEntryList — the polarity the page decides', () => {
  it('strips ONE bad entry and enforces the valid subset, saying what is not blocked', () => {
    // `managed-settings.md#keys-that-fail-closed`, the `deniedMcpServers` row —
    // the nearest documented sibling: "An individual invalid entry is stripped
    // and the valid subset is enforced."
    const { drops, sink } = tolerantSink();
    const parsed = parseBlockedMarketplaceEntryList(
      [{ source: 'github' }, { source: 'github', repo: 'untrusted/plugins' }],
      { field: 'blockedMarketplaces', sink },
    );
    expect(parsed).toEqual([{ source: 'github', repo: 'untrusted/plugins' }]);
    expect(drops).toHaveLength(1);
    expect(drops[0]?.field).toBe('blockedMarketplaces[0]');
    expect(drops[0]?.reason).toContain('is NOT blocked');
  });

  it('DROPS a wholly invalid value rather than reading it as block-everything', () => {
    // Same row: "A wholly invalid value is dropped with a warning, since denying
    // every server would block servers the policy never named." That direction
    // fails open, and is what the page decides; the drop is what makes it
    // survivable, so the reason has to say nothing is blocked.
    const { drops, sink } = tolerantSink();
    expect(parseBlockedMarketplaceEntryList('untrusted/plugins', { field: 'blockedMarketplaces', sink }))
      .toBeUndefined();
    expect(drops[0]?.disposition).toBe('stripped');
    expect(drops[0]?.reason).toContain('no marketplace source is blocked by it');
  });

  it('accepts the owner wildcard HERE and refuses it in the allowlist', () => {
    // "Owner wildcards … work only in `strictKnownMarketplaces` and
    // `blockedMarketplaces`." Only the blocklist half is opened by this row:
    // teaching the allowlist parser the wildcard would WIDEN a grant, which needs
    // its own row. An admin who writes it there still gets a visible drop.
    const { sink } = tolerantSink();
    expect(parseBlockedMarketplaceEntryList([{ source: 'github', repo: 'untrusted-org/*' }], {
      field: 'blockedMarketplaces', sink,
    })).toEqual([{ source: 'github', repo: 'untrusted-org/*' }]);
    // The forms the page says are compared literally, so they match no
    // repository — refused at parse instead, where the admin can see it.
    const literal = tolerantSink();
    expect(parseBlockedMarketplaceEntryList(
      [{ source: 'github', repo: '*/plugins' }, { source: 'github', repo: 'acme/tools-*' }],
      { field: 'blockedMarketplaces', sink: literal.sink },
    )).toEqual([]);
    expect(literal.drops).toHaveLength(2);
  });

  /**
   * P2.483 — this case used to assert the OPPOSITE, and the inversion is the
   * record, not a relaxation.
   *
   * It was written by P2.467 as a characterization: a mutation survived without
   * it, so the then-current behaviour (drop `acme-corp/*` from the allowlist)
   * was pinned, with "closing that half is a row of its own" as the note. That
   * row was P2.483, and its owner answer (2026-09-02, §A7) was conditional on
   * the page being SILENT about wildcards on the allowlist key.
   *
   * The page is not silent. `settings-reference.md#owner-wildcards` documents
   * `<owner>/*` for `strictKnownMarketplaces` by name, shows a worked example
   * under that key, and fills in that column of the matching-rules table; the
   * vendored bundle (`claudeCodeVersion 2.1.247`) parses it too. So the
   * antecedent fails and the documented behaviour governs.
   *
   * **This IS a grant widening and the pin now says so**, which is why the case
   * survives instead of being deleted: the narrowing rules that keep the
   * wildcard from becoming a blank cheque — shorthand spelling only,
   * case-sensitive owner, exact-entry `ref` — are pinned next door in
   * `pi-harness/managed-marketplace-entries.test.ts` §"P2.483".
   */
  it('the ALLOWLIST accepts an owner wildcard, and the malformed spellings still drop', () => {
    const { drops, sink } = tolerantSink();
    expect(parseManagedMarketplaceEntryList([
      { source: 'github', repo: 'acme-corp/*' },
      { source: 'github', repo: 'acme-corp/approved' },
    ], { field: 'strictKnownMarketplaces', sink })).toEqual([
      { source: 'github', repo: 'acme-corp/*' },
      { source: 'github', repo: 'acme-corp/approved' },
    ]);
    expect(drops).toHaveLength(0);

    // The forms the page compares literally — "a bare star, a star in the owner
    // position, or a prefix followed by a star" — are still refused at parse in
    // BOTH lists, which is visible where a literal never-match is not.
    const literal = tolerantSink();
    expect(parseManagedMarketplaceEntryList(
      [{ source: 'github', repo: '*' }, { source: 'github', repo: 'acme-corp/tools-*' }],
      { field: 'strictKnownMarketplaces', sink: literal.sink },
    )).toEqual([]);
    expect(literal.drops).toHaveLength(2);
    expect(literal.drops[0]?.field).toBe('strictKnownMarketplaces[0]');
    expect(literal.drops[0]?.reason).toContain('allowlist');
  });

  it('refuses a `skills-dir` entry with a reason that says why it would be inert', () => {
    // A real upstream entry this build cannot honour: it never loads an
    // `@skills-dir` plugin at all, so accepting the entry would look like a block
    // and be nothing.
    const { drops, sink } = tolerantSink();
    expect(parseBlockedMarketplaceEntryList([{ source: 'skills-dir' }], {
      field: 'blockedMarketplaces', sink,
    })).toEqual([]);
    expect(drops[0]?.reason).toContain('this build never loads');
  });

  it('throws under the STRICT sink, like every other list on this policy', () => {
    const strict = {
      tolerant: false as const,
      drop: () => { throw new Error('unreachable'); },
    };
    expect(() => parseBlockedMarketplaceEntryList([{ source: 'github' }], {
      field: 'blockedMarketplaces', sink: strict,
    })).toThrow();
  });
});

describe('what an administrator who deploys the key sees', () => {
  it('is ENFORCED rather than explained — the schema now carries it (P2.481)', () => {
    // WHAT THIS TEST USED TO SAY, and why the replacement is the row. P2.467
    // corrected the row's premise that an administrator "sees no error": they saw
    // one, because the key was not in `MANAGED_PI_POLICY_KEYS` and
    // `refuseUnknownKeys` recorded a drop. That drop's sentence was softened to
    // say in words that nothing was blocked. Nothing was blocked because the
    // gate's only feed was a `createPluginRegistrySource` parameter that
    // production never set.
    //
    // P2.481 sets it. So the honest assertion is the opposite one: the key parses
    // into the enforced policy, and there is no drop at all. A softened
    // explanation left standing beside a working gate would tell an administrator
    // their policy does nothing while it blocks.
    const parsed = parseManagedPiPolicyTolerantV1({
      schemaVersion: 1,
      blockedMarketplaces: [{ source: 'github', repo: 'untrusted/plugins' }],
    }, { source: 'test' });
    expect(parsed.drops).toEqual([]);
    expect(parsed.policy.blockedMarketplaces)
      .toEqual([{ source: 'github', repo: 'untrusted/plugins' }]);
  });

  it('the value it parses is the one the gate refuses on', () => {
    // The seam this row exists to close, asserted end to end WITHOUT the boot
    // wiring: policy document -> parsed policy -> the gate's own reader. If the
    // parser produced a shape `blockedMarketplaceEntryFor` cannot match, every
    // gate above would pass while the schema key looked enforced.
    const parsed = parseManagedPiPolicyTolerantV1({
      schemaVersion: 1,
      blockedMarketplaces: [{ source: 'github', repo: 'untrusted/plugins' }],
    }, { source: 'test' });
    const identity = managedMarketplaceSourceIdentity('https://github.com/untrusted/plugins.git');
    expect(identity).toBeDefined();
    expect(blockedMarketplaceEntryFor(parsed.policy.blockedMarketplaces, identity!))
      .toEqual({ source: 'github', repo: 'untrusted/plugins' });
    // POSITIVE CONTROL on the same rig: a source the administrator did NOT name
    // is admitted, so the assertion above cannot be satisfied by a matcher that
    // refuses everything.
    const other = managedMarketplaceSourceIdentity('https://github.com/acme/plugins.git');
    expect(blockedMarketplaceEntryFor(parsed.policy.blockedMarketplaces, other!)).toBeUndefined();
  });

  it('an OWNER WILDCARD survives the policy parse, which is the direction that widens a grant', () => {
    // P2.467 pinned this asymmetry at the PARSER — the blocklist accepts
    // `owner/*` and the allowlist refuses it — because its own M6 survived by
    // accepting the wildcard in both lists, and that direction widens a grant.
    // The asymmetry was NOT pinned through the policy, and P2.481 is the commit
    // that gives the policy a path to the parser at all. Substituting
    // `parseManagedMarketplaceEntryList` there is a plausible copy-paste and it
    // measures `[]` here: an administrator's `untrusted/*` blocklist silently
    // becomes an empty one, so every repo they blocked keeps working.
    const parsed = parseManagedPiPolicyTolerantV1({
      schemaVersion: 1,
      blockedMarketplaces: [{ source: 'github', repo: 'untrusted/*' }],
    }, { source: 'test' });
    expect(parsed.drops).toEqual([]);
    expect(parsed.policy.blockedMarketplaces).toEqual([{ source: 'github', repo: 'untrusted/*' }]);
    // And it still MATCHES, so this is not a shape assertion: the well-formed
    // wildcard and a source outside it travel the same path in the same test.
    const inside = managedMarketplaceSourceIdentity('https://github.com/untrusted/anything.git');
    const outside = managedMarketplaceSourceIdentity('https://github.com/acme/anything.git');
    expect(blockedMarketplaceEntryFor(parsed.policy.blockedMarketplaces, inside!))
      .toEqual({ source: 'github', repo: 'untrusted/*' });
    expect(blockedMarketplaceEntryFor(parsed.policy.blockedMarketplaces, outside!)).toBeUndefined();
  });

  it('a wholly invalid value is DROPPED, so the key never escalates to block-everything', () => {
    // The polarity, now that the key reaches the policy: a typo in the VALUE must
    // not brick every marketplace. `managed-settings.md`
    // §`invalid-entries-in-managed-settings` plus the `deniedMcpServers` reading
    // that `parseBlockedMarketplaceEntryList` quotes.
    const parsed = parseManagedPiPolicyTolerantV1({
      schemaVersion: 1,
      blockedMarketplaces: 'untrusted/plugins',
    }, { source: 'test' });
    expect(parsed.policy.blockedMarketplaces).toBeUndefined();
    expect(parsed.drops.map(drop => drop.field)).toEqual(['blockedMarketplaces']);
    expect(parsed.drops[0]?.disposition).toBe('stripped');
  });

  it('POSITIVE CONTROL: an actual typo still reads as an invalid key', () => {
    // The register is a claim that somebody measured a key's status here, not a
    // blanket softening of the unknown-key message.
    const parsed = parseManagedPiPolicyTolerantV1({
      schemaVersion: 1,
      blockedMarketplacez: [],
    }, { source: 'test' });
    expect(parsed.drops.find(entry => entry.field === 'blockedMarketplacez')?.reason)
      .toBe('invalid managed Pi policy key: blockedMarketplacez');
  });
});

describe('PluginRegistrySource and blockedMarketplaces', () => {
  const BLOCKED = blocked({ source: 'github', repo: 'untrusted/plugins' });

  it('refuses `add` before touching the store or staging anything, and NAMES the entry', async () => {
    // "Blocked sources are checked before download, so they never touch the
    // filesystem" — and the store read is a filesystem operation.
    const store = new MemoryRegistryStore();
    const staging = new FakeStagingService();
    const source = new PluginRegistrySource({
      store, staging, baseTempDir: tempDir, blockedMarketplaces: BLOCKED,
    });

    await expect(source.add({ source: 'https://github.com/untrusted/plugins.git' }))
      .rejects.toThrow(MarketplaceSourceBlockedError);
    await expect(source.add({ source: 'https://github.com/untrusted/plugins.git' }))
      .rejects.toThrow(/blockedMarketplaces entry "github:untrusted\/plugins::"/);
    expect(store.writes).toBe(0);
    expect(store.snapshot()).toEqual([]);
    expect(staging.stageCalls).toBe(0);
  });

  it('POSITIVE CONTROL: the same add succeeds with no blocklist, and for another repo', async () => {
    // Without this the suite above cannot distinguish a working gate from one
    // that refuses every add.
    const unguarded = new MemoryRegistryStore();
    await new PluginRegistrySource({
      store: unguarded, staging: new FakeStagingService(), baseTempDir: tempDir,
    }).add({ source: 'https://github.com/untrusted/plugins.git' });
    expect(unguarded.snapshot()).toHaveLength(1);

    const guarded = new MemoryRegistryStore();
    await new PluginRegistrySource({
      store: guarded, staging: new FakeStagingService(), baseTempDir: tempDir, blockedMarketplaces: BLOCKED,
    }).add({ source: 'https://github.com/trusted/plugins.git' });
    expect(guarded.snapshot()).toHaveLength(1);
  });

  it('is a SECOND question, independent of the allowlist', async () => {
    // With no `strictKnownMarketplaces` the allowlist admits everything, so a
    // blocklist folded into that predicate would be unreachable in exactly the
    // deployment the key is written for. And the two refusals are different
    // classes, because the administrator's remedies are opposite.
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore(),
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      blockedMarketplaces: BLOCKED,
      strictKnownMarketplaces: [{ source: 'hostPattern', hostPattern: '^github\\.com$' }],
    });
    // Allowed by the allowlist, blocked by the blocklist → the blocklist wins,
    // and says so.
    await expect(source.add({ source: 'untrusted/plugins' }))
      .rejects.toThrow(MarketplaceSourceBlockedError);
    // Refused by the allowlist instead → the OTHER class.
    await expect(source.add({ source: 'https://gitlab.example.com/team/plugins.git' }))
      .rejects.toThrow(MarketplaceSourceNotAllowedError);
  });

  it('re-checks on LOAD, so a row added before the policy stops fetching plugins', async () => {
    // "so a marketplace someone added before you set the policy can't be used to
    // fetch plugins either" — a row already in `marketplaces.json` never passes
    // through `add()` again, so the add gate alone would leave it live.
    const staging = new FakeStagingService({
      'marketplace.json': JSON.stringify({ name: 'Untrusted', plugins: [] }),
    });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([{
        id: 'registry-legacy',
        source: 'https://github.com/untrusted/plugins.git',
        displayName: 'untrusted-plugins',
        addedAt: 0,
      }]),
      staging,
      baseTempDir: tempDir,
      blockedMarketplaces: BLOCKED,
    });

    await source.listItems();
    await source.awaitPendingFetches();
    const result = await source.listItems();

    expect(result.items).toEqual([]);
    // ITS OWN code since P2.482. This assertion read
    // `marketplace.registry.source_not_allowed` until then, and the comment
    // above it explained why the fifth code could not exist: the renderer's
    // table is machine-checked to cover every `marketplace.registry.*` literal
    // in `registry-source.ts`, so a new code obliged an edit in two files P2.467
    // did not own. Those edits landed (`5afd7772a`), so the two refusals — whose
    // remedies are OPPOSITE, widen an allowlist versus remove a blocklist entry —
    // no longer share a sentence. The blocked ENTRY still goes only to the log
    // (the case below): `toLoadError` stays path-free.
    expect(result.loadErrors?.[0]?.diagnosticCodes).toEqual([
      'marketplace.registry.source_blocked',
    ]);
    // Refused before the clone: a marketplace we will not load costs no network.
    expect(staging.stageCalls).toBe(0);
  });

  it('THE FAIL-OPEN CONTROL: the same legacy row loads when nothing blocks it', async () => {
    // If this case and the one above cannot be told apart, the gate is
    // decorative. Identical rig, identical row, blocklist naming a different
    // repository — the catalog must resolve and the clone must happen.
    const staging = new FakeStagingService({
      'marketplace.json': JSON.stringify({
        name: 'Untrusted', plugins: [{ name: 'toolkit', source: 'https://github.com/acme/toolkit' }],
      }),
    });
    const source = new PluginRegistrySource({
      store: new MemoryRegistryStore([{
        id: 'registry-legacy',
        source: 'https://github.com/untrusted/plugins.git',
        displayName: 'untrusted-plugins',
        addedAt: 0,
      }]),
      staging,
      baseTempDir: tempDir,
      blockedMarketplaces: blocked({ source: 'github', repo: 'someone-else/plugins' }),
    });

    await source.listItems();
    await source.awaitPendingFetches();
    const result = await source.listItems();

    expect(result.loadErrors).toBeUndefined();
    expect(result.items).toHaveLength(1);
    expect(staging.stageCalls).toBe(1);
  });

  it('logs a REFUSAL as a refusal, not as a catalog fetch that failed', async () => {
    // An in-place fix found while adding this gate: `fetchRegistryEntry`'s
    // `console.warn` said "catalog fetch failed" for all four load-error codes,
    // including the two managed-policy refusals and the reserved-name verdict.
    // Nothing was fetched, so nothing failed to fetch, and the remedies are
    // opposite — the same confusion P2.429 removed from the renderer's side of
    // this code path. A genuine fetch failure keeps the old verb, which is what
    // `registry-source.test.ts`'s log case pins.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const source = new PluginRegistrySource({
        store: new MemoryRegistryStore([{
          id: 'registry-legacy',
          source: 'https://github.com/untrusted/plugins.git',
          displayName: 'untrusted-plugins',
          addedAt: 0,
        }]),
        staging: new FakeStagingService(),
        baseTempDir: tempDir,
        blockedMarketplaces: BLOCKED,
      });
      await source.listItems();
      await source.awaitPendingFetches();
      // The blocklist entry BY NAME, which the shared diagnostic code cannot
      // carry — this is where a blocked marketplace is distinguishable from one
      // the allowlist refused, and the remedies are opposite.
      expect(warnings.some(line => line.includes('untrusted-plugins')
        && line.includes('blocked by the blockedMarketplaces entry "github:untrusted/plugins::"'))).toBe(true);
      // P2.482 moved the code, and the VERB must move with it: a code added to
      // the branch and not to `fetchRegistryEntry`'s refused-classifier rejoins
      // the "catalog fetch failed" wording, which is what the last assertion in
      // this block is for.
      expect(warnings.some(line => line.includes('marketplace refused')
        && line.includes('marketplace.registry.source_blocked'))).toBe(true);
      expect(warnings.some(line => line.includes('catalog fetch failed'))).toBe(false);
    } finally {
      console.warn = realWarn;
    }
  });

  it('refuses `upgrade` by name rather than reporting a fetch that never happened', async () => {
    // The check runs "on plugin install, update, refresh, and auto-update".
    // `upgrade()` maps a non-persistable entry onto `'fetch-failed'`, so leaving
    // this to the load gate would tell the user their refresh failed to fetch
    // when their administrator refused it.
    const store = new MemoryRegistryStore([{
      id: 'registry-legacy',
      source: 'https://github.com/untrusted/plugins.git',
      displayName: 'untrusted-plugins',
      addedAt: 0,
    }]);
    const staging = new FakeStagingService();
    const source = new PluginRegistrySource({
      store, staging, baseTempDir: tempDir, blockedMarketplaces: BLOCKED,
    });

    await expect(source.upgrade({ marketplaceId: 'registry-legacy' }))
      .rejects.toThrow(/blocked by your organization's managed settings/);
    expect(store.writes).toBe(0);
    expect(staging.stageCalls).toBe(0);
  });

  it('reports a delivered entry the admin\'s own blocklist blocks, and delivers the rest', async () => {
    // The strangest of the three refusal states, which is why it has its own:
    // the administrator delivered a marketplace their own `blockedMarketplaces`
    // blocks. The remedy is to remove the blocklist entry, not to widen anything.
    const store = new MemoryRegistryStore();
    const source = new PluginRegistrySource({
      store,
      staging: new FakeStagingService(),
      baseTempDir: tempDir,
      blockedMarketplaces: BLOCKED,
      extraKnownMarketplaces: [
        { name: 'untrusted-plugins', source: 'https://github.com/untrusted/plugins.git' },
        { name: 'corp-plugins', source: 'https://gitlab.example.com/corp/plugins.git' },
      ],
    });

    const outcomes = await source.ensureDeliveredMarketplaces();
    expect(outcomes.map(outcome => [outcome.name, outcome.state])).toEqual([
      ['untrusted-plugins', 'refused-by-blocklist'],
      ['corp-plugins', 'registered'],
    ]);
    expect(store.snapshot().map(registry => registry.displayName)).toEqual(['corp-plugins']);
  });
});
