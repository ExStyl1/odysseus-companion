/**
 * A marketplace entry's own archive-download credential, both halves: the
 * catalog parse that reads `headers` off the entry, and the download that binds
 * them to the archive URL's origin.
 *
 * `plugins/host-marketplace.md#authenticate-archive-downloads` (fetched 2026-08-28,
 * `https://code.claude.com/docs/en/plugin-marketplaces.md`) states the failure
 * this closes as its own history: "Before v2.1.238, Claude Code downloaded an
 * entry's archive without its `headers` or `headersHelper`, so an install that
 * relied on them failed with `HTTP 401 while downloading plugin archive from`,
 * followed by the URL, with the registry's status code in place of 401."
 *
 * Every credential in this file is an obvious placeholder.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginInstallService } from '../acquisition.ts';
import {
  parseExternalPluginCatalog,
  type ExternalPluginCatalogDto,
} from '../../marketplace/external-catalog-adapters.ts';

const PLACEHOLDER_AUTHORIZATION = 'Bearer PLACEHOLDER-NOT-A-REAL-TOKEN';

function parseClaudeCatalog(dto: ExternalPluginCatalogDto) {
  return parseExternalPluginCatalog('claude', dto, { catalogRoot: '/catalog' });
}

function archiveEntry(extra: Record<string, unknown>) {
  return {
    name: 'internal-tools',
    source: { source: 'archive', url: 'https://registry.example.com/plugins/internal-tools-1.0.0.zip' },
    ...extra,
  };
}

describe("a marketplace entry's archive headers", () => {
  it('carries the entry headers onto the install source', () => {
    // `#optional-plugin-fields`, **Archive authentication fields:** — `headers`
    // is "HTTP headers Claude Code sends when it downloads this entry's archive".
    const { proposals, diagnostics } = parseClaudeCatalog({
      name: 'internal',
      plugins: [archiveEntry({ headers: { Authorization: PLACEHOLDER_AUTHORIZATION } })],
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.source).toEqual({
      kind: 'url',
      url: 'https://registry.example.com/plugins/internal-tools-1.0.0.zip',
      headers: { Authorization: PLACEHOLDER_AUTHORIZATION },
    });
    expect(diagnostics).toEqual([]);
  });

  it('drops routing and identity header names and keeps the authentication one', () => {
    // `#when-claude-code-skips-a-headershelper-command-or-drops-its-output` —
    // "Claude Code drops request-routing and client-identity names such as
    // `Host`, `Cookie`, and `X-Forwarded-*` from an entry's `headers` and command
    // output, and keeps authentication names such as `Authorization`."
    const { proposals, diagnostics } = parseClaudeCatalog({
      name: 'internal',
      plugins: [archiveEntry({
        headers: {
          Authorization: PLACEHOLDER_AUTHORIZATION,
          Host: 'internal.example.com',
          Cookie: 'session=placeholder',
          'X-Forwarded-For': '10.0.0.1',
          'x-real-ip': '10.0.0.1',
        },
      })],
    });

    expect(proposals[0]!.source).toEqual({
      kind: 'url',
      url: 'https://registry.example.com/plugins/internal-tools-1.0.0.zip',
      headers: { Authorization: PLACEHOLDER_AUTHORIZATION },
    });
    const dropped = diagnostics.find(d => d.code === 'marketplace.catalog.entry_header_dropped');
    expect(dropped?.severity).toBe('warning');
    expect((dropped?.details as { headerNames?: string[] } | undefined)?.headerNames)
      .toEqual(['Host', 'Cookie', 'X-Forwarded-For', 'x-real-ip']);
  });

  it('says so, and names the tier that IS executed, when only a headersHelper is declared', () => {
    // P6.479 (owner decision 2026-09-05 Q7, option C): an entry's `headersHelper`
    // is CATALOG-declared — written by whoever publishes the marketplace, gated
    // on the page by a per-install acceptance dialog that option B, and with it
    // that dialog, was declined. So this tier never executes, permanently, and
    // the refusal's job is to point at the tier that does: a marketplace the
    // operator's own MANAGED settings declare.
    const command = '/opt/bin/mint-registry-token.sh';
    const { proposals, diagnostics } = parseClaudeCatalog({
      name: 'internal',
      plugins: [archiveEntry({ strict: false, headersHelper: command })],
    });

    expect(proposals[0]!.source).toEqual({
      kind: 'url',
      url: 'https://registry.example.com/plugins/internal-tools-1.0.0.zip',
    });
    const refusal = diagnostics.find(d => d.code === 'marketplace.catalog.entry_headers_helper_unsupported');
    expect(refusal).toBeDefined();
    // A refusal that only says "not supported" is a dead end; this one carries
    // the remedy.
    expect(refusal!.message).toContain('managed settings');
    // ...and never echoes the command, which the catalog author wrote and the
    // reader never chose to read.
    expect(refusal!.message).not.toContain(command);
  });

  it('refuses a malformed headers object without deleting the entry', () => {
    const { proposals, diagnostics } = parseClaudeCatalog({
      name: 'internal',
      plugins: [
        archiveEntry({ headers: 'Authorization: nope' }),
        { name: 'second', source: { source: 'archive', url: 'https://registry.example.com/second.zip' }, headers: { Authorization: 42 } },
      ],
    });

    // Both entries survive: a bad credential is not a reason to hide a plugin.
    expect(proposals.map(proposal => proposal.pluginName)).toEqual(['internal-tools', 'second']);
    expect(proposals.every(proposal => !(proposal.source as { headers?: unknown }).headers)).toBe(true);
    expect(diagnostics.map(d => d.code)).toEqual([
      'marketplace.catalog.entry_headers_invalid',
      'marketplace.catalog.entry_header_value_invalid',
    ]);
    expect(diagnostics.every(d => d.severity === 'warning')).toBe(true);
  });

  it('does not attach headers to a source that is not an archive download', () => {
    // "Set these when the entry has an `archive` source" — a `github` source is
    // cloned, not downloaded over HTTPS with headers.
    const { proposals, diagnostics } = parseClaudeCatalog({
      name: 'internal',
      plugins: [{
        name: 'cloned',
        source: { source: 'github', repo: 'acme/plugins' },
        headers: { Authorization: PLACEHOLDER_AUTHORIZATION },
      }],
    });

    expect(proposals[0]!.source).toEqual({ kind: 'repository', repositoryUrl: 'https://github.com/acme/plugins' });
    expect(diagnostics.map(d => d.code)).toContain('marketplace.catalog.entry_headers_not_applicable');
  });
});

/**
 * P6.177 — the marketplace's OWN credential and the second clause of the page
 * sentence P3.220 implemented only the first half of.
 *
 * `plugins/host-marketplace.md#authenticate-archive-downloads`, the "Place" table
 * (fetched 2026-09-06), row "Marketplace `url` source", verbatim:
 *
 *   Downloads that get the headers — "Archive downloads on the marketplace
 *   URL's origin, meaning the same scheme, host, and port"
 *   When — "Before each fetch of the marketplace's `marketplace.json` and before
 *   each archive download on that origin."
 *
 * and the precedence, same section, verbatim: "Where both places set a header of
 * the same name, Claude Code sends the entry's value."
 *
 * Only the `marketplace.json` fetch honoured it, so an entry with no `headers`
 * of its own on the SAME artifact server still went out unauthenticated. The
 * download half needs nothing new: the block below already pins that
 * `source.headers` are sent on the archive URL's origin and dropped across a
 * redirect that leaves it.
 */
describe("the marketplace's own headers reach an archive download on its origin", () => {
  const MARKETPLACE_SOURCE = {
    kind: 'url' as const,
    url: 'https://registry.example.com/plugins/marketplace.json',
    headers: { Authorization: PLACEHOLDER_AUTHORIZATION, 'X-Registry': 'internal' },
  };

  function parseWithMarketplace(dto: ExternalPluginCatalogDto) {
    return parseExternalPluginCatalog('claude', dto, {
      catalogRoot: '/catalog',
      marketplaceSource: MARKETPLACE_SOURCE,
    });
  }

  it('inherits on the same origin, sends nothing off it and says so, and lets the entry override by name', () => {
    // ARM 1 — the row's case: an entry with NO `headers` of its own, whose
    // archive URL is same-scheme/host/port with the marketplace it came from.
    const sameOrigin = parseWithMarketplace({
      name: 'internal',
      plugins: [archiveEntry({})],
    });
    expect(sameOrigin.proposals[0]!.source).toEqual({
      kind: 'url',
      url: 'https://registry.example.com/plugins/internal-tools-1.0.0.zip',
      headers: { Authorization: PLACEHOLDER_AUTHORIZATION, 'X-Registry': 'internal' },
    });
    expect(sameOrigin.diagnostics).toEqual([]);

    // The control that makes ARM 1 mean something: the SAME catalog with no
    // marketplace source carries no credential at all, so the assertion above
    // is reading the inheritance and not a default.
    expect(parseClaudeCatalog({ name: 'internal', plugins: [archiveEntry({})] }).proposals[0]!.source)
      .toEqual({ kind: 'url', url: 'https://registry.example.com/plugins/internal-tools-1.0.0.zip' });

    // ARM 2 — off-origin: no headers, and the drop is STATED rather than left to
    // the page's own 401.
    const offOrigin = parseWithMarketplace({
      name: 'internal',
      plugins: [{
        name: 'internal-tools',
        source: { source: 'archive', url: 'https://cdn.other.example/internal-tools-1.0.0.zip' },
      }],
    });
    expect(offOrigin.proposals[0]!.source)
      .toEqual({ kind: 'url', url: 'https://cdn.other.example/internal-tools-1.0.0.zip' });
    const drop = offOrigin.diagnostics
      .find(diagnostic => diagnostic.code === 'marketplace.catalog.marketplace_headers_off_origin');
    expect(drop).toBeDefined();
    expect(drop!.severity).toBe('warning');
    // Names, never values — the field carries a credential.
    expect(drop!.message).toContain('Authorization');
    expect(drop!.message).not.toContain(PLACEHOLDER_AUTHORIZATION);

    // A port difference is a different origin, which is the half of "the same
    // scheme, host, and port" a host-only comparison would get wrong.
    const otherPort = parseWithMarketplace({
      name: 'internal',
      plugins: [{
        name: 'internal-tools',
        source: { source: 'archive', url: 'https://registry.example.com:8443/plugins/internal-tools-1.0.0.zip' },
      }],
    });
    expect(otherPort.proposals[0]!.source)
      .toEqual({ kind: 'url', url: 'https://registry.example.com:8443/plugins/internal-tools-1.0.0.zip' });

    // PRECEDENCE — "Claude Code sends the entry's value", case-insensitively on
    // the name, with the marketplace's other header still carried.
    const overridden = parseWithMarketplace({
      name: 'internal',
      plugins: [archiveEntry({ headers: { authorization: 'Bearer PLACEHOLDER-ENTRY-VALUE' } })],
    });
    expect(overridden.proposals[0]!.source).toEqual({
      kind: 'url',
      url: 'https://registry.example.com/plugins/internal-tools-1.0.0.zip',
      headers: { 'X-Registry': 'internal', authorization: 'Bearer PLACEHOLDER-ENTRY-VALUE' },
    });
  });
});

describe('the archive download binds those headers to one origin', () => {
  interface SeenRequest {
    url: string;
    authorization: string | null;
  }

  function serviceCapturing(seen: SeenRequest[], respond: (url: string) => Response): PluginInstallService {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      // `HeadersInit` is a DOM-lib name this package's tsconfig does not load, so it
      // typechecks nowhere even though `Headers` accepts these shapes at runtime.
      const headers = new Headers((init?.headers ?? {}) as ConstructorParameters<typeof Headers>[0]);
      seen.push({ url, authorization: headers.get('authorization') });
      return respond(url);
    }) as unknown as typeof fetch;
    // The DEFAULT artifact auth provider on purpose: `registry.example.com` is
    // not the internal GitLab host, so this exercises the production wiring's
    // forwarding arm rather than a stub that cannot forget to forward.
    return new PluginInstallService({ fetchImpl, now: () => 10_000 });
  }

  async function stageArchive(
    service: PluginInstallService,
    headers: Record<string, string> | undefined,
    baseTempDir: string,
  ): Promise<void> {
    const plan = await service.createInstallPlanFromSource({
      kind: 'url',
      url: 'https://registry.example.com/plugins/internal-tools-1.0.0.zip',
      ...(headers ? { headers } : {}),
    });
    await service.stageInstall(plan, { baseTempDir });
  }

  it('sends the headers on the archive URL and drops them across a redirect that leaves the origin', async () => {
    // `#when-claude-code-skips-a-headershelper-command-or-drops-its-output` —
    // "**Redirect leaves the origin**: when a download is redirected off the
    // archive URL's origin, Claude Code drops the `headers` values and command
    // output of both the marketplace `url` source and the plugin entry."
    const baseTempDir = mkdtempSync(join(tmpdir(), 'archive-headers-'));
    try {
      const seen: SeenRequest[] = [];
      const service = serviceCapturing(seen, url =>
        url.startsWith('https://registry.example.com')
          ? new Response(null, { status: 302, headers: { location: 'https://cdn.other.example/internal-tools.zip' } })
          : new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/zip' } }));

      await stageArchive(service, { Authorization: PLACEHOLDER_AUTHORIZATION }, baseTempDir);

      expect(seen.map(request => request.url)).toEqual([
        'https://registry.example.com/plugins/internal-tools-1.0.0.zip',
        'https://cdn.other.example/internal-tools.zip',
      ]);
      expect(seen[0]!.authorization).toBe(PLACEHOLDER_AUTHORIZATION);
      // The negative half, and the whole reason the headers travel with the hop
      // guard rather than with the fetch: the off-origin hop carries nothing.
      expect(seen[1]!.authorization).toBeNull();
    } finally {
      rmSync(baseTempDir, { recursive: true, force: true });
    }
  });

  it('sends nothing when the source declares no headers', async () => {
    // Positive control on the same rig: the capture above is reading a real
    // header, not a default one every request happens to carry.
    const baseTempDir = mkdtempSync(join(tmpdir(), 'archive-headers-none-'));
    try {
      const seen: SeenRequest[] = [];
      const service = serviceCapturing(seen, () =>
        new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'application/zip' } }));

      await stageArchive(service, undefined, baseTempDir);

      expect(seen).toHaveLength(1);
      expect(seen[0]!.authorization).toBeNull();
    } finally {
      rmSync(baseTempDir, { recursive: true, force: true });
    }
  });
});
