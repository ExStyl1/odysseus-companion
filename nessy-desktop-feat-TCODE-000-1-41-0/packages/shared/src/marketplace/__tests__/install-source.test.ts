import { describe, expect, it } from 'bun:test';
import { marketplaceSkillPluginId, normalizePluginDto, normalizeSkillDto } from '../normalizers.ts';
import { createPluginInstallSourceFromMarketplaceItem } from '../install-source.ts';
import { resolvePluginInstallSource } from '../../plugins/source-resolver.ts';
import type { PluginDto, SkillDto } from '../types.ts';

describe('marketplace install-source conversion', () => {
  it('converts npm-backed marketplace items to typed plugin install sources', () => {
    const item = normalizePluginDto(pluginDto({
      install: {
        command: 'curl https://example.invalid/install.sh | sh',
        commands: {
          user: 'curl https://example.invalid/user.sh | sh',
          workspace: 'curl https://example.invalid/workspace.sh | sh',
        },
        note: 'safe metadata survives command scrubbing',
        source: {
          type: 'npm',
          package: '@ai/toolkit',
          version: '1.2.3',
          registry: 'https://registry.example.com',
        },
      },
    }));

    const result = createPluginInstallSourceFromMarketplaceItem(item);

    expect(result.ok).toBe(true);
    expect(result.source).toMatchObject({
      kind: 'marketplace-npm-package',
      packageName: '@ai/toolkit',
      version: '1.2.3',
      registry: 'https://registry.example.com',
      marketplace: {
        marketplaceId: 'skills-market',
        marketplaceBaseUrl: 'https://skills-market.t-tech.team/api',
        itemId: 'toolkit',
        itemKind: 'plugin',
        name: 'Toolkit',
        version: '1.0.0',
        listKind: 'plugins',
        sourceUrl: 'https://gitlab.example.com/plugins/toolkit',
        packageName: '@ai/toolkit',
        raw: {
          install: {
            note: 'safe metadata survives command scrubbing',
            source: {
              type: 'npm',
              package: '@ai/toolkit',
              version: '1.2.3',
              registry: 'https://registry.example.com',
            },
          },
        },
      },
    });
    expect(JSON.stringify(result.source)).not.toContain('curl');
    expect(JSON.stringify(result.source)).not.toContain('commands');
  });

  it('converts GitLab marketplace skills to skill-only plugin sources', () => {
    const item = normalizeSkillDto(skillDto({
      id: 'review',
      install: {
        source: {
          type: 'gitlab',
          url: 'https://gitlab.example.com/group/repo/-/blob/main/skills/review/SKILL.md',
          ref: 'main',
          path: 'skills/review/SKILL.md',
        },
      },
    }));

    const result = createPluginInstallSourceFromMarketplaceItem(item);

    expect(result.ok).toBe(true);
    expect(result.source).toMatchObject({
      kind: 'marketplace-gitlab-skill',
      url: 'https://gitlab.example.com/group/repo/-/blob/main/skills/review/SKILL.md',
      ref: 'main',
      path: 'skills/review/SKILL.md',
      pluginId: marketplaceSkillPluginId('review'),
      skillSlug: 'review',
    });
  });

  it('uses the canonical skill folder for v2 snapshots with opaque item IDs', () => {
    const item = normalizeSkillDto(skillDto({
      id: 'skl_v1_45de9d07c1c04f95a6a47f61e3e51a1a',
      name: 'Writing Plans',
      folder_name: 'writing-plans',
      artifactDelivery: {
        filesPath: '/v2/skills/skl_v1_45de9d07c1c04f95a6a47f61e3e51a1a/snapshots/snp_v1_test/files',
      },
    }));

    const result = createPluginInstallSourceFromMarketplaceItem(item);

    expect(result.ok).toBe(true);
    expect(result.source).toMatchObject({
      kind: 'marketplace-skill-files',
      filesUrl: 'https://skills-market.t-tech.team/api/v2/skills/skl_v1_45de9d07c1c04f95a6a47f61e3e51a1a/snapshots/snp_v1_test/files',
      pluginId: marketplaceSkillPluginId('skl_v1_45de9d07c1c04f95a6a47f61e3e51a1a'),
      skillSlug: 'writing-plans',
      name: 'Writing Plans',
    });
  });

  it('converts direct URL marketplace sources without treating display commands as install sources', () => {
    const item = normalizePluginDto(pluginDto({
      install: {
        command: 'npm install -g unsafe',
        source: {
          type: 'url',
          url: 'https://market.example/toolkit.tgz',
        },
      },
    }));

    const result = createPluginInstallSourceFromMarketplaceItem(item);

    expect(result.ok).toBe(true);
    expect(result.source).toEqual(expect.objectContaining({
      kind: 'marketplace-url',
      url: 'https://market.example/toolkit.tgz',
    }));
    expect(JSON.stringify(result.source)).not.toContain('npm install');
  });

  it('keeps skill GitLab blob sources mapped to marketplace-gitlab-skill', () => {
    const item = normalizeSkillDto(skillDto({
      install: {
        source: {
          type: 'gitlab',
          url: 'https://gitlab.example/group/repo/-/blob/main/skills/review/SKILL.md',
          ref: 'main',
          path: 'skills/review/SKILL.md',
        },
      },
    }));

    const result = createPluginInstallSourceFromMarketplaceItem(item);

    expect(result.ok).toBe(true);
    expect(result.source).toMatchObject({
      kind: 'marketplace-gitlab-skill',
      url: 'https://gitlab.example/group/repo/-/blob/main/skills/review/SKILL.md',
      ref: 'main',
      path: 'skills/review/SKILL.md',
    });

    const resolved = resolvePluginInstallSource(result.source!);

    expect(resolved.artifact?.type).toBe('gitlab-skill');
  });

  it('converts non-skill GitLab repository URLs to repository install sources', () => {
    const cases = [
      {
        kind: 'plugin',
        label: 'plugin repository root URL',
        item: normalizePluginDto(pluginDto({
          capabilities: capabilitiesForPluginKind('plugin'),
          install: { source: { type: 'gitlab', url: 'https://gitlab.example/group/repo' } },
        })),
        expected: { kind: 'repository', repositoryUrl: 'https://gitlab.example/group/repo' },
      },
      {
        kind: 'mcp',
        label: 'mcp repository tree URL',
        item: normalizePluginDto(pluginDto({
          capabilities: capabilitiesForPluginKind('mcp'),
          install: { source: { type: 'gitlab', url: 'https://gitlab.example/group/repo/-/tree/main/subdir' } },
        })),
        expected: {
          kind: 'repository',
          repositoryUrl: 'https://gitlab.example/group/repo',
          ref: 'main',
          subdirectory: 'subdir',
        },
      },
      {
        kind: 'hook',
        label: 'hook repository tree URL',
        item: normalizePluginDto(pluginDto({
          capabilities: capabilitiesForPluginKind('hook'),
          install: { source: { type: 'gitlab', url: 'https://gitlab.example/group/repo/-/tree/main/subdir' } },
        })),
        expected: {
          kind: 'repository',
          repositoryUrl: 'https://gitlab.example/group/repo',
          ref: 'main',
          subdirectory: 'subdir',
        },
      },
    ] as const;

    for (const testCase of cases) {
      expect(testCase.item.kind, testCase.label).toBe(testCase.kind);

      const result = createPluginInstallSourceFromMarketplaceItem(testCase.item);

      expect(result.ok, testCase.label).toBe(true);
      expect(result.source, testCase.label).toMatchObject({
        ...testCase.expected,
        marketplace: {
          marketplaceId: 'skills-market',
          marketplaceBaseUrl: 'https://skills-market.t-tech.team/api',
          itemId: 'toolkit',
          itemKind: testCase.kind,
          listKind: 'plugins',
          name: 'Toolkit',
          version: '1.0.0',
          sourceUrl: 'https://gitlab.example.com/plugins/toolkit',
        },
      });
      expect(result.source?.kind, testCase.label).toBe('repository');

      const resolved = resolvePluginInstallSource(result.source!);

      expect(resolved.origin, testCase.label).toMatchObject({
        source: 'marketplace',
        marketplaceId: 'skills-market',
        marketplaceBaseUrl: 'https://skills-market.t-tech.team/api',
        repositoryUrl: testCase.expected.repositoryUrl,
        sourceUrl: 'https://gitlab.example.com/plugins/toolkit',
        provenance: {
          itemId: 'toolkit',
        },
      });
    }
  });

  it('keeps non-skill GitLab archive and manifest URLs as marketplace URLs', () => {
    const cases = [
      { kind: 'plugin', url: 'https://gitlab.example/group/repo/-/archive/main/repo-main.tgz' },
      { kind: 'mcp', url: 'https://gitlab.example/group/repo/-/archive/main/repo-main.zip' },
      { kind: 'hook', url: 'https://gitlab.example/group/repo/-/archive/main/repo-main.tar.gz' },
      { kind: 'plugin', url: 'https://gitlab.example/group/repo/-/raw/main/plugin.json' },
      { kind: 'plugin', url: 'https://gitlab.example/group/repo/plugin.json' },
    ] as const;

    for (const testCase of cases) {
      const item = normalizePluginDto(pluginDto({
        capabilities: capabilitiesForPluginKind(testCase.kind),
        install: { source: { type: 'gitlab', url: testCase.url } },
      }));

      expect(item.kind, `${testCase.kind} ${testCase.url}`).toBe(testCase.kind);

      const result = createPluginInstallSourceFromMarketplaceItem(item);

      expect(result.ok, `${testCase.kind} ${testCase.url}`).toBe(true);
      expect(result.source).toEqual(expect.objectContaining({
        kind: 'marketplace-url',
        url: testCase.url,
      }));
    }
  });

  it('rejects bare non-skill GitLab blob URLs without manifest context', () => {
    const cases = [
      { kind: 'plugin', url: 'https://gitlab.example/group/repo/-/blob/main/README.md' },
      { kind: 'mcp', url: 'https://gitlab.example/group/repo/-/blob/main/README.md' },
      { kind: 'hook', url: 'https://gitlab.example/group/repo/-/blob/main/README.md' },
    ] as const;

    for (const testCase of cases) {
      const item = normalizePluginDto(pluginDto({
        capabilities: capabilitiesForPluginKind(testCase.kind),
        install: { source: { type: 'gitlab', url: testCase.url } },
      }));

      expect(item.kind, `${testCase.kind} ${testCase.url}`).toBe(testCase.kind);

      const result = createPluginInstallSourceFromMarketplaceItem(item);

      expect(result.ok, `${testCase.kind} ${testCase.url}`).toBe(false);
      expect(result.source, `${testCase.kind} ${testCase.url}`).toBeUndefined();
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          severity: 'error',
          code: 'marketplace.install.unsupported_source',
        }),
      ]);
    }
  });

  it('converts safe command-derived Nessy extensions to npm plugin install sources', () => {
    const item = normalizePluginDto(pluginDto({
      install: {
        command: 'nessy extensions install @ai-office/nessy-extension-nestor-nessy-default-extension --registry=https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all --auto-update',
      },
    }));

    const result = createPluginInstallSourceFromMarketplaceItem(item);

    expect(result.ok).toBe(true);
    expect(result.source).toMatchObject({
      kind: 'marketplace-npm-package',
      packageName: '@ai-office/nessy-extension-nestor-nessy-default-extension',
      registry: 'https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all',
    });
    expect(JSON.stringify(result.source)).not.toContain('nessy extensions install');
  });

  it('turns a listing with NO install field into a marked npm source and says so', () => {
    // The live shape of 106 of the catalog's 118 rows.
    const item = normalizePluginDto(pluginDto({
      install: undefined,
      id: 'nestor-nessy-cli-extensions-nessy-default-extension-9bcdc6a2',
      name: 'nessy-default-extension',
      version: '1.0.9',
      path: 'https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions',
    }));

    const result = createPluginInstallSourceFromMarketplaceItem(item);

    expect(result.ok).toBe(true);
    expect(result.source).toMatchObject({
      kind: 'marketplace-npm-package',
      packageName: '@ai-office/nessy-extension-nestor-nessy-default-extension',
      version: '1.0.9',
      registry: 'https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all',
      derivedCoordinates: true,
    });
    // A guess that installs quietly is worse than today's clean refusal, so the
    // package it resolved to is named in the log.
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'info',
        code: 'marketplace.install.derived_source',
        message: expect.stringContaining('@ai-office/nessy-extension-nestor-nessy-default-extension@1.0.9'),
      }),
    ]);
  });

  it('still refuses a listing with nothing to derive from, naming what was missing', () => {
    const item = normalizePluginDto(pluginDto({ install: undefined, path: undefined }));

    const result = createPluginInstallSourceFromMarketplaceItem(item);

    expect(result.ok).toBe(false);
    expect(result.source).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe('marketplace.install.unsupported_source');
    expect(result.diagnostics[0]?.message).toContain('no repository path');
  });

  it('rejects command-only marketplace items with typed diagnostics', () => {
    const item = normalizePluginDto(pluginDto({
      install: {
        command: 'bash install.sh',
      },
    }));

    const result = createPluginInstallSourceFromMarketplaceItem(item);

    expect(result.ok).toBe(false);
    expect(result.source).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'marketplace.install.unsupported_source',
      }),
    ]);
  });
});

function skillDto(overrides: Partial<SkillDto> = {}): SkillDto {
  return {
    id: 'review',
    name: 'Review',
    description: 'Review code changes',
    tenant: 'ai-office',
    repo_path: 'group/repo',
    repo_url: 'https://gitlab.example.com/group/repo',
    folder_name: 'review',
    skill_path: 'skills/review/SKILL.md',
    ...overrides,
  };
}

function pluginDto(overrides: Partial<PluginDto> = {}): PluginDto {
  return {
    id: 'toolkit',
    kind: 'nessy-extension',
    name: 'Toolkit',
    description: 'Plugin capabilities',
    version: '1.0.0',
    path: 'https://gitlab.example.com/plugins/toolkit',
    install: {
      source: {
        type: 'npm',
        package: '@ai/toolkit',
        version: '1.0.0',
      },
    },
    capabilities: ['skill'],
    ...overrides,
  };
}

function capabilitiesForPluginKind(kind: 'plugin' | 'mcp' | 'hook'): unknown {
  if (kind === 'mcp') return { mcpServers: ['linear'] };
  if (kind === 'hook') return [{ kind: 'hook', id: 'pretool' }];
  return [];
}
