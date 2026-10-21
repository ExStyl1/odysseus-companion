import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { c as createTar } from 'tar';
import { CapabilityPolicyStore } from '../../capabilities/policy-store.ts';
import { CapabilityTrustStore } from '../../capabilities/trust-store.ts';
import { PluginManagementServiceV2 } from '../../plugins/management-service-v2.ts';
import { PluginStoreV2 } from '../../plugins/store-v2.ts';
import {
  installRepositoryProposal,
  normalizeRepositoryDisplaySource,
  proposeRepositoryInstall,
} from '../repository-install.ts';

describe('normalizeRepositoryDisplaySource', () => {
  it('strips userinfo, query and fragment to a safe host+path label', () => {
    expect(
      normalizeRepositoryDisplaySource(
        'https://user:pass@github.com/Green-PT/honey-for-devs.git?token=x#frag',
        'https://github.com/Green-PT/honey-for-devs',
      ),
    ).toBe('github.com/Green-PT/honey-for-devs');
  });

  it('falls back to a generic label for an unparseable source', () => {
    expect(normalizeRepositoryDisplaySource('not a url')).toBe('unknown-source');
  });
});

describe('marketplace repository install proposals', () => {
  it('normalizes GitHub tree URLs into typed installable proposals', () => {
    const proposal = proposeRepositoryInstall({
      url: 'https://github.com/Green-PT/honey-for-devs/tree/main',
    });

    expect(proposal.status).toBe('installable');
    expect(proposal.hostKind).toBe('github');
    expect(proposal.ref).toBe('main');
    expect(proposal.subdirectory).toBeUndefined();
    expect(proposal.source).toEqual({
      kind: 'repository',
      repositoryUrl: 'https://github.com/Green-PT/honey-for-devs',
      ref: 'main',
    });
    expect(proposal.candidateFiles).toEqual([
      '.codex-plugin/plugin.json',
      // submission-errors.md:155 names three accepted manifest locations; the
      // neutral `.agent-plugin` one has to be offered too or a repository laid
      // out that way is never named as installable.
      '.agent-plugin/plugin.json',
      '.claude-plugin/plugin.json',
      'nessy-extension.json',
      'plugin.json',
      'SKILL.md',
    ]);
  });

  it('does not auto-select a single format when a proposal has multiple candidate files', () => {
    const proposal = proposeRepositoryInstall({
      url: 'https://github.com/Green-PT/honey-for-devs/tree/main',
    });

    expect(proposal.detectedFormat).toBe('unknown');
    expect(proposal.candidateFiles.length).toBeGreaterThan(1);
  });

  // F1.805 — the proposal is built from the URL alone; the repository is never
  // contacted, so a non-existent one used to come back `installable` with no
  // diagnostic at all (release sitting SIT-p, 2026-09-25). It stays installable
  // (the install stage fetches and validates), but it now SAYS what it is, and
  // it no longer claims a `high` confidence it never earned.
  it('says a repository proposal was not contacted, and never claims high confidence (F1.805)', () => {
    const unpinned = proposeRepositoryInstall({
      url: 'https://github.com/acme/this-repository-does-not-exist',
    });
    expect(unpinned.status).toBe('installable');
    const notContacted = unpinned.diagnostics.find(
      diagnostic => diagnostic.code === 'marketplace.repository.not_contacted',
    );
    expect(notContacted?.severity).toBe('info');
    expect(notContacted?.message).toContain('plugin_install');
    expect(unpinned.confidence).toBe('low');

    const pinned = proposeRepositoryInstall({
      url: 'https://github.com/acme/this-repository-does-not-exist/tree/v1.0.0',
    });
    expect(pinned.ref).toBe('v1.0.0');
    expect(pinned.diagnostics.map(diagnostic => diagnostic.code)).toContain('marketplace.repository.not_contacted');
    expect(pinned.confidence).toBe('medium');
  });

  it('keeps the not-contacted note off an unsupported URL, which carries only its error (F1.805)', () => {
    const proposal = proposeRepositoryInstall({ url: 'https://example.com/not-a-supported-repo' });
    expect(proposal.diagnostics.map(diagnostic => diagnostic.code)).toEqual(['marketplace.repository.unsupported_url']);
  });

  it('returns unsupported diagnostics without an install source for unsupported URLs', () => {
    const proposal = proposeRepositoryInstall({
      url: 'https://example.com/not-a-supported-repo',
    });

    expect(proposal.status).toBe('unsupported');
    expect(proposal.source).toBeUndefined();
    expect(proposal.diagnostics.map(diagnostic => diagnostic.code)).toContain('marketplace.repository.unsupported_url');
    expect(proposal.suggestedNextSteps).toContain('Use a GitHub or GitLab repository URL.');
  });

  it('installs a Codex plugin repository fixture only through the v2 management boundary', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'marketplace-repository-install-'));
    try {
      const bundle = createCodexBundle(tempDir, 'honey');
      const archive = await createArchiveFromDirectory(tempDir, bundle, 'honey-main.tgz');
      const { service, store } = createService(tempDir, routeFetch({
        'https://github.com/Green-PT/honey-for-devs/archive/main.tar.gz': binaryResponse(readFileSync(archive)),
      }));
      const proposal = proposeRepositoryInstall({
        url: 'https://github.com/Green-PT/honey-for-devs/tree/main',
      });

      const result = await installRepositoryProposal(proposal, service);
      expect(result.ok).toBe(true);
      expect(result.installed?.pluginId).toBe('honey');
      expect((await store.readInstalledRegistry()).plugins[0]?.manifest.compatibility?.rawExternalKind).toBe('codex-plugin');
      expect(existsSync(join(tempDir, 'plugins', 'installed.json'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('installs a repository whose only manifest is .agent-plugin/plugin.json', async () => {
    // submission-errors.md:155 (`plugin_manifest_missing`): "ZIP must contain
    // `.codex-plugin/plugin.json`, `.agent-plugin/plugin.json`, or
    // `.claude-plugin/plugin.json` at the root or in its single top-level
    // directory." We recognised two of the three, so a bundle laid out the
    // neutral way did not install at all — this is the user-visible half.
    const tempDir = mkdtempSync(join(tmpdir(), 'marketplace-repository-agent-manifest-'));
    try {
      const bundle = createCodexBundle(tempDir, 'honey', { manifestDir: '.agent-plugin' });
      const archive = await createArchiveFromDirectory(tempDir, bundle, 'honey-main.tgz');
      const { service, store } = createService(tempDir, routeFetch({
        'https://github.com/Green-PT/honey-for-devs/archive/main.tar.gz': binaryResponse(readFileSync(archive)),
      }));
      const proposal = proposeRepositoryInstall({
        url: 'https://github.com/Green-PT/honey-for-devs/tree/main',
      });

      const result = await installRepositoryProposal(proposal, service);
      expect(result.diagnostics.map(diagnostic => diagnostic.code)).not.toContain('plugin.format.unsupported_format');
      expect(result.ok).toBe(true);
      expect(result.installed?.pluginId).toBe('honey');
      expect((await store.readInstalledRegistry()).plugins[0]?.manifest.compatibility?.rawExternalKind).toBe('codex-plugin');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps reading the format-specific manifest when a bundle ships both locations', async () => {
    // The neutral name is a fallback, never an override: a bundle carrying both
    // must still normalize from `.codex-plugin/plugin.json`.
    const tempDir = mkdtempSync(join(tmpdir(), 'marketplace-repository-dual-manifest-'));
    try {
      const bundle = createCodexBundle(tempDir, 'honey', { alsoWriteManifestDir: '.agent-plugin', alsoWriteVersion: '9.9.9' });
      const archive = await createArchiveFromDirectory(tempDir, bundle, 'honey-main.tgz');
      const { service, store } = createService(tempDir, routeFetch({
        'https://github.com/Green-PT/honey-for-devs/archive/main.tar.gz': binaryResponse(readFileSync(archive)),
      }));
      const proposal = proposeRepositoryInstall({
        url: 'https://github.com/Green-PT/honey-for-devs/tree/main',
      });

      const result = await installRepositoryProposal(proposal, service);
      expect(result.ok).toBe(true);
      expect((await store.readInstalledRegistry()).plugins[0]?.manifest.version).toBe('1.0.0');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps failed repository fetches as backend install failures without installed entries', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'marketplace-repository-unavailable-'));
    try {
      const { service, store } = createService(tempDir, routeFetch({}));
      const proposal = proposeRepositoryInstall({
        url: 'https://github.com/Green-PT/honey-for-devs/tree/main',
      });

      const result = await installRepositoryProposal(proposal, service);

      expect(result.ok).toBe(false);
      expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.install.artifact_download_failed');
      expect((await store.readInstalledRegistry()).plugins).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('normalizes GitLab tree URLs with subdirectories into typed proposals', () => {
    const proposal = proposeRepositoryInstall({
      url: 'https://gitlab.example.com/group/subgroup/repo/-/tree/main/plugins/toolkit',
    });

    expect(proposal.status).toBe('installable');
    expect(proposal.hostKind).toBe('gitlab');
    expect(proposal.ref).toBe('main');
    expect(proposal.subdirectory).toBe('plugins/toolkit');
    expect(proposal.source).toEqual({
      kind: 'repository',
      repositoryUrl: 'https://gitlab.example.com/group/subgroup/repo',
      ref: 'main',
      subdirectory: 'plugins/toolkit',
    });
  });
});

function createService(tempDir: string, fetchImpl: typeof fetch): {
  service: PluginManagementServiceV2;
  store: PluginStoreV2;
} {
  const store = new PluginStoreV2({ rootDirectory: join(tempDir, 'plugins'), now: () => 20_000 });
  return {
    store,
    service: new PluginManagementServiceV2({
      store,
      policyStore: new CapabilityPolicyStore({
        globalPath: join(tempDir, 'capabilities.json'),
        workspacePolicyPath: workspaceId => join(tempDir, 'workspaces', workspaceId, 'capabilities.json'),
      }),
      trustStore: new CapabilityTrustStore({ path: join(tempDir, 'capability-trust.json') }),
      baseTempDir: join(tempDir, 'stages'),
      fetchImpl,
      now: () => 20_000,
    }),
  };
}

async function createArchiveFromDirectory(tempDir: string, sourceDirectory: string, name: string): Promise<string> {
  const archivePath = join(tempDir, name);
  await createTar({
    gzip: true,
    cwd: join(sourceDirectory, '..'),
    file: archivePath,
  }, [basename(sourceDirectory)]);
  return archivePath;
}

function routeFetch(routes: Record<string, Response>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const response = routes[url.toString()];
    if (!response) {
      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return response.clone();
  }) as typeof fetch;
}

function binaryResponse(bytes: Buffer): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/gzip' },
  });
}

function createCodexBundle(
  tempDir: string,
  id: string,
  options: { manifestDir?: string; alsoWriteManifestDir?: string; alsoWriteVersion?: string } = {},
): string {
  const manifestDir = options.manifestDir ?? '.codex-plugin';
  const localPlugin = join(tempDir, `${id}-plugin`);
  mkdirSync(join(localPlugin, manifestDir), { recursive: true });
  mkdirSync(join(localPlugin, 'skills', 'review'), { recursive: true });
  mkdirSync(join(localPlugin, 'hooks'), { recursive: true });
  writeFileSync(join(localPlugin, 'skills', 'review', 'SKILL.md'), '# Review\n');
  writeFileSync(join(localPlugin, 'hooks', 'policy.js'), 'console.log("{}")\n');
  const manifest = (version: string) => JSON.stringify({
    name: id,
    version,
    description: 'Codex style plugin',
    skills: './skills/',
    hooks: {
      pre_tool_use: [
        {
          id: 'policy',
          command: 'node hooks/policy.js',
          cwd: './hooks/',
        },
      ],
    },
  }, null, 2);
  writeFileSync(join(localPlugin, manifestDir, 'plugin.json'), manifest('1.0.0'));
  if (options.alsoWriteManifestDir) {
    mkdirSync(join(localPlugin, options.alsoWriteManifestDir), { recursive: true });
    writeFileSync(
      join(localPlugin, options.alsoWriteManifestDir, 'plugin.json'),
      manifest(options.alsoWriteVersion ?? '1.0.0'),
    );
  }
  return localPlugin;
}
