/**
 * P3.220 — a private registry whose CATALOG needs a credential.
 *
 * P6.39 closed the entry-archive 401. This is the same 401 one step earlier: the
 * marketplace `url` source's own `headers`, which
 * `settings-reference.md#extraknownmarketplaces` documents as part of the source
 * object — "**`url`**: a direct URL to a `marketplace.json` file, with `url` and
 * optional `headers` and `headersHelper` for authenticated access" — and
 * `plugins/host-marketplace.md#authenticate-archive-downloads` places: "Before each
 * fetch of the marketplace's `marketplace.json` and before each archive download
 * on that origin."
 *
 * Two halves, and they land together on purpose. `headersHelper` is a COMMAND
 * and is never run; `disableCommandPluginSources` is the operator key that
 * blocks such a command, and the credential path must not ship ahead of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  areMarketplaceCommandSourcesAllowed,
  DEFAULT_MANAGED_PI_POLICY,
  parseManagedPiPolicyTolerantV1,
  type ManagedPiPolicyV1,
} from '../../agent/pi-harness/managed-policy.ts';
import { fetchRegistryCatalog, type RegistryStagingService } from '../registry-catalog-fetcher.ts';
import { createPluginStagingArea, resolvePluginInstallSource } from '../source-resolver.ts';
import type { PluginInstallPlan, PluginInstallSource, PluginStagedInstall } from '../types.ts';

const CATALOG_URL = 'https://registry.example.com/plugins/catalog.zip';

const policyWith = (extra: Record<string, unknown>) => parseManagedPiPolicyTolerantV1(
  { schemaVersion: 1, disabledPermissionModes: [], ...extra },
  { source: '/etc/nessy/managed-policy.json' },
);

describe('P3.220 · a managed url marketplace carries its catalog credential', () => {
  it('parses headers onto the delivered entry and applies the routing/identity filter', () => {
    const { policy, drops } = policyWith({
      extraKnownMarketplaces: {
        'acme-internal': {
          source: {
            source: 'url',
            url: CATALOG_URL,
            headers: {
              Authorization: 'Bearer not-a-real-token',
              'X-Registry-Scope': 'plugins',
              Cookie: 'session=abc',
              'X-Forwarded-For': '10.0.0.1',
            },
          },
        },
      },
    });
    const entry = policy.extraKnownMarketplaces?.[0];
    expect(entry?.name).toBe('acme-internal');
    expect(entry?.source).toBe(CATALOG_URL);
    // `#when-claude-code-skips-a-headershelper-command-or-drops-its-output`:
    // routing and identity names go, "authentication names such as
    // `Authorization`" stay.
    expect(entry?.headers).toEqual({
      Authorization: 'Bearer not-a-real-token',
      'X-Registry-Scope': 'plugins',
    });
    expect(drops).toHaveLength(1);
    expect(drops[0]?.reason).toContain('Cookie, X-Forwarded-For');
    // A drop is rendered to a terminal and to `doctor`. It must never carry the
    // credential itself.
    for (const drop of drops) expect(JSON.stringify(drop)).not.toContain('not-a-real-token');
  });

  it('delivers the marketplace with no headers when it declares none', () => {
    const { policy, drops } = policyWith({
      extraKnownMarketplaces: { plain: { source: { source: 'url', url: CATALOG_URL } } },
    });
    expect(drops).toEqual([]);
    expect(policy.extraKnownMarketplaces?.[0]?.headers).toBeUndefined();
  });

  it('reports headers declared on a source kind that never sends them', () => {
    const { policy, drops } = policyWith({
      extraKnownMarketplaces: {
        'acme-gh': { source: { source: 'github', repo: 'acme/plugins', headers: { Authorization: 'x' } } },
      },
    });
    // The marketplace is still delivered — the credential is the optional part.
    expect(policy.extraKnownMarketplaces?.[0]?.source).toBe('acme/plugins');
    expect(policy.extraKnownMarketplaces?.[0]?.headers).toBeUndefined();
    expect(drops.map(drop => drop.reason)).toEqual([
      'delivered marketplace source "github" carries headers, which only a url source sends',
    ]);
  });

  it('CARRIES a headersHelper on this tier, which P6.479 made the documented exception', () => {
    // This case asserted the opposite until P6.479 — the parser dropped the
    // command and said so. Owner decision Q7 (2026-09-05), option C, made a
    // marketplace that MANAGED settings themselves declare the one tier that
    // runs it, and `plugins/host-marketplace.md#how-users-accept-a-headershelper-command`
    // gives that tier the row "Without asking, including during a background
    // marketplace refresh". (Re-anchored P6.661: the table's own heading, "When
    // a marketplace `url` source's command runs", is an `#####` and publishes no
    // `id`, so the cite hangs on the enclosing `####` section.) The command is
    // carried here and executed in
    // `marketplace/managed-headers-helper.ts`, under that module's gates.
    const permissive = policyWith({
      extraKnownMarketplaces: {
        acme: {
          source: {
            source: 'url',
            url: CATALOG_URL,
            headers: { Authorization: 'Bearer x' },
            headersHelper: '/opt/bin/mint-token.sh',
          },
        },
      },
    });
    expect(permissive.policy.extraKnownMarketplaces?.[0]?.headers).toEqual({ Authorization: 'Bearer x' });
    expect(permissive.policy.extraKnownMarketplaces?.[0]?.headersHelper).toBe('/opt/bin/mint-token.sh');
    expect(permissive.drops).toEqual([]);

    // And the operator key does NOT change that, which is the carve-out stated
    // verbatim: "Under either block, Claude Code still runs the command for a
    // marketplace that managed settings themselves declare." Every OTHER command
    // source stays blocked by it — that is what `areMarketplaceCommandSourcesAllowed`
    // below still governs.
    const blocked = policyWith({
      disableCommandPluginSources: true,
      extraKnownMarketplaces: {
        acme: { source: { source: 'url', url: CATALOG_URL, headersHelper: '/opt/bin/mint-token.sh' } },
      },
    });
    expect(blocked.policy.extraKnownMarketplaces?.[0]?.headersHelper).toBe('/opt/bin/mint-token.sh');
    expect(blocked.drops).toEqual([]);
  });

  it('drops a headersHelper the executor could never run, where the administrator reads it', () => {
    // The parser's half of `#write-the-headershelper-command`'s "at most 500
    // characters of printable ASCII": a value that is not a string, or is longer
    // than the cap, is refused HERE so the receipt reaches the person who wrote
    // it rather than a user watching a catalog fail to load.
    const tooLong = policyWith({
      extraKnownMarketplaces: {
        acme: { source: { source: 'url', url: CATALOG_URL, headersHelper: 'x'.repeat(501) } },
      },
    });
    expect(tooLong.policy.extraKnownMarketplaces?.[0]?.headersHelper).toBeUndefined();
    expect(tooLong.drops.map(drop => drop.reason)).toEqual([
      'invalid delivered marketplace url headersHelper; it must be a command of at most'
      + ' 500 characters, so only the fixed "headers" are sent',
    ]);
    // The marketplace is still delivered: the credential is the optional part.
    expect(tooLong.policy.extraKnownMarketplaces?.[0]?.source).toBe(CATALOG_URL);
  });
});

describe('P3.220 · disableCommandPluginSources is a three-state key', () => {
  const policy = (over: Partial<ManagedPiPolicyV1>): ManagedPiPolicyV1 =>
    ({ ...DEFAULT_MANAGED_PI_POLICY, ...over });

  it('unset DELEGATES to allowManagedHooksOnly rather than meaning "allowed"', () => {
    // `settings-reference.md#disablecommandpluginsources`: "**Default**: unset,
    // so Claude Code follows `allowManagedHooksOnly`: an organization that
    // restricts hook execution to managed settings gets command sources disabled
    // too."
    expect(areMarketplaceCommandSourcesAllowed(policy({}))).toBe(true);
    expect(areMarketplaceCommandSourcesAllowed(policy({ allowManagedHooksOnly: true }))).toBe(false);
  });

  it('an explicit value outranks that delegation in both directions', () => {
    // `#what-runs-under-allowmanagedhooksonly` blocks headersHelper commands
    // "unless `disableCommandPluginSources` is explicitly set to `false`".
    expect(areMarketplaceCommandSourcesAllowed(
      policy({ allowManagedHooksOnly: true, disableCommandPluginSources: false }),
    )).toBe(true);
    expect(areMarketplaceCommandSourcesAllowed(policy({ disableCommandPluginSources: true }))).toBe(false);
  });

  it('an invalid value reads at the enforcing pole and is recorded, never as absent', () => {
    // Absent means DELEGATE. Landing an invalid value on `undefined` would hand
    // the decision to another key the administrator did not write.
    const { policy: parsed, drops } = policyWith({ disableCommandPluginSources: 'yes' });
    expect(parsed.disableCommandPluginSources).toBe(true);
    expect(drops.map(drop => [drop.field, drop.disposition])).toEqual([
      ['disableCommandPluginSources', 'tightened'],
    ]);
  });
});

/**
 * A fake staging seam: the fetcher must add no network client of its own, so the
 * test asserts on the SOURCE it hands to staging. `registrySource` is returned
 * on the staging-error path, which is what makes the assertion possible without
 * a clone.
 */
class RecordingStagingService implements RegistryStagingService {
  planned: PluginInstallSource | string | undefined;

  async createInstallPlanFromSource(source: string | PluginInstallSource): Promise<PluginInstallPlan> {
    this.planned = source;
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

  async stageInstall(plan: PluginInstallPlan, options: { baseTempDir?: string } = {}): Promise<PluginStagedInstall> {
    const staged = await createPluginStagingArea(plan, { baseTempDir: options.baseTempDir });
    staged.diagnostics = [...staged.diagnostics, {
      severity: 'error',
      code: 'test.stop',
      message: 'stop before any download',
    }];
    return staged;
  }
}

describe('P3.220 · the catalog fetch carries the credential', () => {
  let tempDir: string;
  beforeEach(() => { tempDir = mkdtempSync(join(tmpdir(), 'p3220-')); });
  afterEach(() => { if (tempDir) rmSync(tempDir, { recursive: true, force: true }); });

  it('binds the headers to the url source the downloader actually reads', async () => {
    const service = new RecordingStagingService();
    const result = await fetchRegistryCatalog(service, {
      source: CATALOG_URL,
      headers: { Authorization: 'Bearer not-a-real-token' },
      baseTempDir: tempDir,
    });
    expect(result.ok).toBe(false);
    expect(result.registrySource).toEqual({
      kind: 'url',
      url: CATALOG_URL,
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    // The artifact is what `acquisition.ts` reads; a header left on the source
    // and dropped here would never be sent.
    const planned = await service.createInstallPlanFromSource(result.registrySource!);
    expect(planned.artifact).toMatchObject({
      type: 'archive-url',
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
  });

  it('THE CONTROL: with no headers the source is byte-identical to before', async () => {
    const service = new RecordingStagingService();
    const result = await fetchRegistryCatalog(service, { source: CATALOG_URL, baseTempDir: tempDir });
    expect(result.registrySource).toEqual({ kind: 'url', url: CATALOG_URL });
  });

  it('leaves a repository source alone — it authenticates through the artifact provider', async () => {
    const service = new RecordingStagingService();
    const result = await fetchRegistryCatalog(service, {
      source: 'https://github.com/acme/plugins',
      headers: { Authorization: 'Bearer not-a-real-token' },
      baseTempDir: tempDir,
    });
    expect(result.registrySource).toMatchObject({ kind: 'repository' });
    expect(JSON.stringify(result.registrySource)).not.toContain('not-a-real-token');
  });
});
