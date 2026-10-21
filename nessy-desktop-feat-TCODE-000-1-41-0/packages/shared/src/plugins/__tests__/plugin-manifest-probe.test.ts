/**
 * D3 — the ONE manifest a detail page may fetch, at the entry's pinned sha.
 *
 * The sources here are the real shapes `anthropics/claude-plugins-official`
 * resolves to (measured 2026-08-01): `{source:'url', url, sha}` for 137 entries
 * and `{source:'git-subdir', url, path, sha}` for 84 more, both of which
 * `claudeRepositorySource` turns into a `repository` source whose `ref` is the
 * SHA.
 */
import { describe, expect, it } from 'bun:test';
import {
  pluginManifestUrls,
  probePluginManifestComponentKinds,
} from '../plugin-manifest-probe.ts';
import type { PluginInstallSource } from '../types.ts';

const SHA = 'ef474d181a6eca44b37722f839e8a7eb58d644ec';

const pinned: PluginInstallSource = {
  kind: 'repository',
  repositoryUrl: 'https://github.com/figma/mcp-server-guide.git',
  ref: SHA,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('pluginManifestUrls', () => {
  it('addresses both manifest paths at the pinned ref, Claude first', () => {
    expect(pluginManifestUrls(pinned)).toEqual([
      `https://raw.githubusercontent.com/figma/mcp-server-guide/${SHA}/.claude-plugin/plugin.json`,
      `https://raw.githubusercontent.com/figma/mcp-server-guide/${SHA}/.codex-plugin/plugin.json`,
    ]);
  });

  it('carries a git-subdir path into the URL', () => {
    expect(pluginManifestUrls({
      kind: 'repository',
      repositoryUrl: 'https://github.com/42Crunch-AI/claude-plugins.git',
      ref: SHA,
      subdirectory: 'plugins/api-security-testing',
    })[0]).toBe(
      `https://raw.githubusercontent.com/42Crunch-AI/claude-plugins/${SHA}`
      + '/plugins/api-security-testing/.claude-plugin/plugin.json',
    );
  });

  it('refuses anything it cannot address at a pinned ref', () => {
    // No ref: showing a branch's composition would not be what installs.
    expect(pluginManifestUrls({ kind: 'repository', repositoryUrl: 'https://github.com/a/b' })).toEqual([]);
    // Not GitHub: no raw-blob address is derivable.
    expect(pluginManifestUrls({ kind: 'repository', repositoryUrl: 'https://gitlab.com/a/b', ref: SHA })).toEqual([]);
    // Not a repository at all.
    expect(pluginManifestUrls({ kind: 'local-path', path: '/tmp/x' })).toEqual([]);
    expect(pluginManifestUrls(undefined)).toEqual([]);
    // Traversal in the subdirectory drops the subdirectory rather than escaping.
    expect(pluginManifestUrls({
      kind: 'repository', repositoryUrl: 'https://github.com/a/b', ref: SHA, subdirectory: '../../etc',
    })[0]).toBe(`https://raw.githubusercontent.com/a/b/${SHA}/.claude-plugin/plugin.json`);
  });
});

describe('probePluginManifestComponentKinds', () => {
  it('reads the first manifest that exists and reports its declared kinds', async () => {
    const seen: string[] = [];
    const kinds = await probePluginManifestComponentKinds(pinned, {
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return jsonResponse({ name: 'figma', skills: './skills/', mcpServers: './.mcp.json' });
      }) as unknown as typeof fetch,
    });
    expect(kinds).toEqual(['skill', 'mcp']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('.claude-plugin/plugin.json');
  });

  it('falls through to the Codex path when the Claude one is absent', async () => {
    const seen: string[] = [];
    const kinds = await probePluginManifestComponentKinds(pinned, {
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return String(url).includes('.codex-plugin')
          ? jsonResponse({ name: 'figma', apps: './.app.json' })
          : new Response('404: Not Found', { status: 404 });
      }) as unknown as typeof fetch,
    });
    expect(kinds).toEqual(['app']);
    expect(seen).toHaveLength(2);
  });

  it('returns undefined — never an empty inventory — when nothing is readable', async () => {
    const notFound = (async () => new Response('404', { status: 404 })) as unknown as typeof fetch;
    expect(await probePluginManifestComponentKinds(pinned, { fetchImpl: notFound })).toBeUndefined();

    const throws = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await probePluginManifestComponentKinds(pinned, { fetchImpl: throws })).toBeUndefined();

    // Unaddressable source: no request is made at all.
    let calls = 0;
    const counting = (async () => { calls += 1; return jsonResponse({}); }) as unknown as typeof fetch;
    expect(await probePluginManifestComponentKinds(
      { kind: 'local-path', path: '/tmp/x' },
      { fetchImpl: counting },
    )).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('reports an empty declaration for a manifest that declares nothing', async () => {
    // The measured Claude norm: 34 of 59 official manifests look like this.
    // `[]` is "read and silent", which the RPC collapses into "does not say".
    const kinds = await probePluginManifestComponentKinds(pinned, {
      fetchImpl: (async () => jsonResponse({
        name: 'figma', version: '2.2.87', description: 'Figma MCP server and Skills',
      })) as unknown as typeof fetch,
    });
    expect(kinds).toEqual([]);
  });

  it('drops a response that redirected off the blob host', async () => {
    const redirected = (async () => {
      const response = jsonResponse({ name: 'x', skills: './skills/' });
      Object.defineProperty(response, 'url', { value: 'https://evil.example/plugin.json' });
      return response;
    }) as unknown as typeof fetch;
    expect(await probePluginManifestComponentKinds(pinned, { fetchImpl: redirected })).toBeUndefined();
  });
});
