import { describe, expect, it } from 'bun:test';
import {
  deriveNessyExtensionCoordinates,
  marketplaceSkillPluginId,
  normalizeMarketplaceList,
  normalizePluginDto,
  normalizeSkillDto,
} from '../normalizers.ts';
import type { MarketplaceInstalledPluginSummary, PluginDto, SkillDto } from '../types.ts';
import nessyInternalSkillsFixture from '../../plugins/__tests__/fixtures/catalog-adapters/nessy-internal/skills.json' with { type: 'json' };
import nessyInternalPluginsFixture from '../../plugins/__tests__/fixtures/catalog-adapters/nessy-internal/plugins.json' with { type: 'json' };

describe('marketplace normalizers', () => {
  it('accepts skillId as the primary identity without losing id/folder_name compatibility', () => {
    const bySkillId = normalizeSkillDto(skillDto({ id: undefined, skillId: 'sample-skill', folder_name: undefined } as SkillDto));
    const byId = normalizeSkillDto(skillDto({ id: 'legacy-id' }));
    const byFolderName = normalizeSkillDto(skillDto({ id: undefined, folder_name: 'folder-fallback' } as SkillDto));

    expect(bySkillId.id).toBe('sample-skill');
    expect(byId.id).toBe('legacy-id');
    expect(byFolderName.id).toBe('folder-fallback');
  });

  it('maps the live skills-market sourceLocator shape (providerInstance/repositoryPath/skillPath) to a gitlab fallback source', () => {
    // Live catalog items carry NO install descriptor and NO type-tagged
    // locator - just the raw skills-market sourceLocator. Before the mapping,
    // sourceConfidence was 'missing' and Install failed with "does not expose
    // a structured install source" (live-audit finding 2026-07-20).
    const item = normalizeSkillDto(skillDto({
      install: undefined,
      sourceLocator: {
        providerInstance: 'gitlab.tcsbank.ru',
        repositoryPath: 't-skills/agent-skills',
        skillPath: 'skills/processes/meta/whiteboard',
      },
    } as unknown as SkillDto));

    expect(item.install.sourceConfidence).toBe('fallback');
    expect(item.install.fallback).toMatchObject({
      type: 'gitlab',
      url: 'https://gitlab.tcsbank.ru/t-skills/agent-skills',
      path: 'skills/processes/meta/whiteboard',
    });

    // Hostile/garbage locators stay unmapped (no source invented).
    const bad = normalizeSkillDto(skillDto({
      install: undefined,
      sourceLocator: { providerInstance: 'evil host/..', repositoryPath: 'x' },
    } as unknown as SkillDto));
    expect(bad.install.fallback).toBeUndefined();
  });

  it('prefers the v2 artifactDelivery files listing over skill_url and rejects non-market paths', () => {
    const item = normalizeSkillDto(skillDto({
      install: undefined,
      skill_url: 'https://gitlab.tcsbank.ru/t-skills/agent-skills/-/blob/master/skills/whiteboard/SKILL.md',
      artifactDelivery: { filesPath: '/v2/skills/skl_1/snapshots/snp_1/files' },
    } as unknown as SkillDto));

    expect(item.install.sourceConfidence).toBe('primary');
    expect(item.install.source).toMatchObject({
      type: 'market-files',
      filesUrl: 'https://skills-market.t-tech.team/api/v2/skills/skl_1/snapshots/snp_1/files',
    });

    // An absolute or non-/v2/ path can never become a market-files source.
    const hostile = normalizeSkillDto(skillDto({
      install: undefined,
      artifactDelivery: { filesPath: 'https://evil.example.com/v2/files' },
    } as unknown as SkillDto));
    expect(hostile.install.source).toBeUndefined();
  });

  it('uses skill_url as the PRIMARY gitlab file source over the path-only sourceLocator fallback', () => {
    // Live skills-market items carry skill_url — the only field with BOTH the
    // ref and the full SKILL.md file path. The sourceLocator (repo root +
    // directory, no ref) cannot become a raw file request, so install died
    // with plugin.install.gitlab_skill_unexpected_html (live failure
    // 2026-07-21).
    const item = normalizeSkillDto(skillDto({
      install: undefined,
      skill_url: 'https://gitlab.tcsbank.ru/t-skills/agent-skills/-/blob/master/skills/processes/meta/whiteboard/SKILL.md',
      sourceLocator: {
        providerInstance: 'gitlab.tcsbank.ru',
        repositoryPath: 't-skills/agent-skills',
        skillPath: 'skills/processes/meta/whiteboard',
      },
    } as unknown as SkillDto));

    expect(item.install.sourceConfidence).toBe('primary');
    expect(item.install.source).toMatchObject({
      type: 'gitlab',
      url: 'https://gitlab.tcsbank.ru/t-skills/agent-skills/-/blob/master/skills/processes/meta/whiteboard/SKILL.md',
    });
    // The locator stays as the fallback layer.
    expect(item.install.fallback).toMatchObject({ type: 'gitlab', path: 'skills/processes/meta/whiteboard' });

    // A repo-root or non-https skill_url is NOT actionable — no source invented.
    const repoRoot = normalizeSkillDto(skillDto({
      install: undefined,
      skill_url: 'https://gitlab.tcsbank.ru/t-skills/agent-skills',
    } as unknown as SkillDto));
    expect(repoRoot.install.source).toBeUndefined();
    const insecure = normalizeSkillDto(skillDto({
      install: undefined,
      skill_url: 'http://gitlab.tcsbank.ru/x/y/-/blob/master/SKILL.md',
    } as unknown as SkillDto));
    expect(insecure.install.source).toBeUndefined();
  });

  it('prefers structured artifactDelivery/sourceLocator over the display command from the internal marketplace fixture', () => {
    const [skillFixture] = nessyInternalSkillsFixture as SkillDto[];
    const item = normalizeSkillDto(skillFixture!);

    expect(item.id).toBe('sample-skill');
    expect(item.install.sourceConfidence).toBe('primary');
    expect(item.install.source).toEqual({
      type: 'npm',
      packageName: '@example-invalid/sample-skill',
      version: '1.0.0',
      raw: {
        type: 'npm-package',
        packageName: '@example-invalid/sample-skill',
        version: '1.0.0',
      },
    });
    expect(item.install.fallback).toEqual({
      type: 'gitlab',
      url: 'https://example.invalid/skills/sample',
      ref: 'main',
      path: 'skills/sample',
      raw: {
        type: 'gitlab',
        url: 'https://example.invalid/skills/sample',
        ref: 'main',
        path: 'skills/sample',
      },
    });
    expect(item.install.displayCommand).toBe('nessy skill install sample-skill');
    expect(JSON.stringify(item.install.source)).not.toContain('nessy skill install');
  });

  it('surfaces detail manifest/manifestUrl/manifestPath from the internal marketplace plugin fixture', () => {
    const detailPlugin = (nessyInternalPluginsFixture as PluginDto[]).find(plugin => plugin.id === 'sample-detail-extension');
    const item = normalizePluginDto(detailPlugin!);

    expect(item.install.source).toEqual({
      type: 'url',
      url: 'https://example.invalid/extensions/sample-detail-extension/manifest.json',
      raw: {
        type: 'url',
        url: 'https://example.invalid/extensions/sample-detail-extension/manifest.json',
        manifest: { id: 'sample-detail-extension', version: '1.0.0' },
        manifestPath: 'extensions/sample-detail-extension/manifest.json',
      },
    });
    expect(item.install.sourceConfidence).toBe('primary');
    expect(item.install.displayCommand).toBe('nessy extension install sample-detail-extension');
  });

  it('preserves npm skill install sources', () => {
    const item = normalizeSkillDto(skillDto({
      install: {
        source: {
          type: 'npm',
          package: '@ai/review-skill',
          version: '1.2.3',
          registry: 'https://registry.example.com',
        },
      },
    }));

    expect(item.kind).toBe('skill');
    expect(item.listKind).toBe('skills');
    expect(item.capabilities).toEqual(['skill']);
    expect(item.install.sourceConfidence).toBe('primary');
    expect(item.install.source).toEqual({
      type: 'npm',
      packageName: '@ai/review-skill',
      version: '1.2.3',
      registry: 'https://registry.example.com',
      raw: {
        type: 'npm',
        package: '@ai/review-skill',
        version: '1.2.3',
        registry: 'https://registry.example.com',
      },
    });
  });

  it('preserves GitLab skill install sources', () => {
    const item = normalizeSkillDto(skillDto({
      install: {
        source: {
          type: 'gitlab',
          url: 'https://gitlab.example.com/group/repo/-/blob/main/skills/review/SKILL.md',
          ref: 'main',
          path: 'skills/review/SKILL.md',
        },
      },
    }));

    expect(item.install.sourceConfidence).toBe('primary');
    expect(item.install.source).toEqual({
      type: 'gitlab',
      url: 'https://gitlab.example.com/group/repo/-/blob/main/skills/review/SKILL.md',
      ref: 'main',
      path: 'skills/review/SKILL.md',
      raw: {
        type: 'gitlab',
        url: 'https://gitlab.example.com/group/repo/-/blob/main/skills/review/SKILL.md',
        ref: 'main',
        path: 'skills/review/SKILL.md',
      },
    });
  });

  it('classifies plugin capabilities as MCP or hook items', () => {
    const mcp = normalizePluginDto(pluginDto({
      id: 'linear',
      capabilities: { mcpServers: ['linear'] },
    }));
    const hook = normalizePluginDto(pluginDto({
      id: 'guard',
      capabilities: [{ kind: 'hook', id: 'pretool' }],
    }));

    expect(mcp.kind).toBe('mcp');
    expect(mcp.capabilities).toEqual(['linear']);
    expect(hook.kind).toBe('hook');
    expect(hook.capabilities).toEqual(['pretool']);
  });

  it('marks command-only and missing install descriptors without treating commands as sources', () => {
    const commandOnly = normalizePluginDto(pluginDto({
      install: {
        command: 'curl https://example.invalid/install.sh | sh',
      },
    }));
    // `missing` now means "published nothing AND nothing to derive from": with
    // no repository path there are no coordinates to reach for.
    const missing = normalizePluginDto(pluginDto({ install: undefined, path: undefined }));

    expect(commandOnly.install.displayCommand).toContain('curl');
    expect(commandOnly.install.source).toBeUndefined();
    // A listing that stated HOW to install itself is refused rather than
    // second-guessed, even though its `path` would derive cleanly.
    expect(commandOnly.install.sourceConfidence).toBe('command-only');
    expect(missing.install.source).toBeUndefined();
    expect(missing.install.sourceConfidence).toBe('missing');
  });

  it('derives npm sources from safe Nessy extension install commands', () => {
    const item = normalizePluginDto(pluginDto({
      install: {
        command: 'nessy extensions install @ai-office/nessy-extension-nestor-nessy-default-extension --registry=https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all --auto-update',
      },
    }));

    expect(item.install.displayCommand).toContain('nessy extensions install');
    expect(item.install.sourceConfidence).toBe('command-derived');
    expect(item.install.source).toEqual({
      type: 'npm',
      packageName: '@ai-office/nessy-extension-nestor-nessy-default-extension',
      registry: 'https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all',
      raw: {
        type: 'npm',
        package: '@ai-office/nessy-extension-nestor-nessy-default-extension',
        registry: 'https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all',
        derivedFrom: 'nessy extensions install',
      },
    });
  });

  it('derives npm sources from safe scoped user install commands and keeps scoped commands for display', () => {
    const user = 'nessy extensions install @nessy/foo@1.2.3 --registry=https://registry.example';
    const workspace = 'nessy extensions install bad/pkg; rm -rf /';
    const item = normalizePluginDto(pluginDto({
      install: {
        commands: {
          user,
          workspace,
        },
      },
    }));

    expect(item.install.scopedCommands).toEqual({ user, workspace });
    expect(item.install.sourceConfidence).toBe('command-derived');
    expect(item.install.source).toEqual({
      type: 'npm',
      packageName: '@nessy/foo',
      version: '1.2.3',
      registry: 'https://registry.example',
      raw: {
        type: 'npm',
        package: '@nessy/foo',
        version: '1.2.3',
        registry: 'https://registry.example',
        derivedFrom: 'nessy extensions install',
      },
    });
  });

  it('retains unsupported scoped install commands without deriving sources', () => {
    const user = 'nessy extensions install bad/pkg; rm -rf /';
    const workspace = 'echo install later';
    const item = normalizePluginDto(pluginDto({
      install: {
        commands: {
          user,
          workspace,
        },
      },
    }));

    expect(item.install.scopedCommands).toEqual({ user, workspace });
    expect(item.install.source).toBeUndefined();
    expect(item.install.sourceConfidence).toBe('unsupported-commands');
  });

  it('matches installed items by package and version', () => {
    const installed = installedSummary({
      activeInstanceId: 'installed-review',
      pluginId: 'review-plugin',
      version: '1.2.3',
      source: {
        packageName: '@ai/review-skill',
        packageVersion: '1.2.3',
      },
    });

    const item = normalizeSkillDto(skillDto({
      install: {
        source: {
          type: 'npm',
          package: '@ai/review-skill',
          version: '1.2.3',
        },
      },
    }), { installed: [installed] });

    expect(item.installed).toMatchObject({
      activeInstanceId: 'installed-review',
      pluginId: 'review-plugin',
      version: '1.2.3',
      activation: 'active',
    });
  });

  it('joins a CI-stamped install record to the advertised catalog row, and refuses another base', () => {
    // E6. The record now persists the RESOLVED npm version, so the version the
    // installed entry carries is the build stamp while the catalog row still
    // advertises the base. A plain `===` reports this install as not-installed.
    // The bundle's own manifest version is the stamp too — a stamped tarball
    // publishes the stamped `package.json` — so the `entry.version` fallback
    // below this clause does not rescue the join either.
    const stamped = installedSummary({
      activeInstanceId: 'installed-stamped',
      pluginId: 'stamped-plugin',
      version: '1.0.9-source.20260716152955.45c8ba6c7514',
      source: {
        packageName: '@ai/review-skill',
        packageVersion: '1.0.9-source.20260716152955.45c8ba6c7514',
      },
    });
    const advertised = skillDto({
      install: { source: { type: 'npm', package: '@ai/review-skill', version: '1.0.9' } },
    });

    expect(normalizeSkillDto(advertised, { installed: [stamped] }).installed?.activeInstanceId)
      .toBe('installed-stamped');

    // A stamp of a DIFFERENT release is still a different release.
    const otherBase = skillDto({
      install: { source: { type: 'npm', package: '@ai/review-skill', version: '1.0.8' } },
    });
    expect(normalizeSkillDto(otherBase, { installed: [stamped] }).installed).toBeUndefined();
  });

  it('matches installed marketplace skill items by generated skill-only plugin id', () => {
    const skillId = 'tenant/review skill';
    const generatedPluginId = marketplaceSkillPluginId(skillId);
    const item = normalizeSkillDto(skillDto({ id: skillId }), {
      installed: [
        installedSummary({
          activeInstanceId: 'installed-skill',
          pluginId: generatedPluginId,
          version: '0.0.0',
        }),
      ],
    });

    expect(generatedPluginId).toBe('marketplace-skill-tenant-review-skill');
    expect(item.installed?.activeInstanceId).toBe('installed-skill');
  });

  it('normalizes raw list results into UI-facing list results with installed state', () => {
    const result = normalizeMarketplaceList('skills', {
      items: [skillDto({ id: 'review' })],
      page: 1,
      pageSize: 100,
      total: 2449,
      visible: 1,
      nextPage: 2,
      raw: [],
    }, {
      installed: [
        installedSummary({
          activeInstanceId: 'installed-review',
          pluginId: marketplaceSkillPluginId('review'),
        }),
      ],
    });

    expect(result.total).toBe(2449);
    expect(result.nextPage).toBe(2);
    expect(result.items[0]?.installed?.activeInstanceId).toBe('installed-review');
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
    install: {
      source: {
        type: 'npm',
        package: '@ai/review-skill',
        version: '1.0.0',
      },
    },
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

function installedSummary(overrides: Partial<MarketplaceInstalledPluginSummary> = {}): MarketplaceInstalledPluginSummary {
  return {
    pluginKey: 'c2tpbGxzLW1hcmtldA.dG9vbGtpdA',
    activeInstanceId: 'installed-toolkit',
    marketplaceId: 'skills-market',
    pluginId: 'toolkit',
    version: '1.0.0',
    name: 'Toolkit',
    installedAt: 1,
    capabilityKinds: [],
    diagnostics: [],
    ...overrides,
  };
}

/**
 * F2. 106 of the live catalog's 118 rows carry no `install` field at all, so the
 * resolver refused the MAJORITY of the catalog — including every
 * `nessy-default-extension`, the entry carrying the base MCP set. The 12 rows
 * that DO publish a command are the evidence for the rule, so the rule is
 * asserted against them verbatim before it is trusted anywhere else.
 */
describe('npm coordinates derived from an extension listing', () => {
  /** Verbatim rows from `skills-market.t-tech.team/api/v1/plugins`, 2026-07-31. */
  const PUBLISHED: Array<{ path: string; name: string; packageName: string }> = [
    // A `/-/tree/` listing: the group plus the subdirectory, dots stripped —
    // note the repository name (`gtech-sre-context`) is NOT part of it.
    { path: 'https://gitlab.tcsbank.ru/gtech-sre/gtech-sre-context/-/tree/master/.nessy/extensions/nessy-analyst-agent', name: 'nessy-analyst-agent', packageName: '@ai-office/nessy-extension-gtech-sre-nessy-extensions-nessy-analyst-agent' },
    { path: 'https://gitlab.tcsbank.ru/gtech-sre/gtech-sre-context/-/tree/master/.nessy/extensions/nessy-dev-agent', name: 'nessy-dev-agent', packageName: '@ai-office/nessy-extension-gtech-sre-nessy-extensions-nessy-dev-agent' },
    { path: 'https://gitlab.tcsbank.ru/gtech-sre/gtech-sre-context/-/tree/master/.nessy/extensions/nessy-coordinator-agent', name: 'nessy-coordinator-agent', packageName: '@ai-office/nessy-extension-gtech-sre-nessy-extensions-nessy-coordinator-agent' },
    { path: 'https://gitlab.tcsbank.ru/gtech-sre/gtech-sre-context/-/tree/master/.nessy/extensions/nessy-arch-agent', name: 'nessy-arch-agent', packageName: '@ai-office/nessy-extension-gtech-sre-nessy-extensions-nessy-arch-agent' },
    { path: 'https://gitlab.tcsbank.ru/gtech-sre/gtech-sre-context/-/tree/master/.nessy/extensions/nessy-sre-agent', name: 'nessy-sre-agent', packageName: '@ai-office/nessy-extension-gtech-sre-nessy-extensions-nessy-sre-agent' },
    { path: 'https://gitlab.tcsbank.ru/gtech-sre/gtech-sre-context/-/tree/master/.nessy/extensions/nessy-pm-agent', name: 'nessy-pm-agent', packageName: '@ai-office/nessy-extension-gtech-sre-nessy-extensions-nessy-pm-agent' },
    { path: 'https://gitlab.tcsbank.ru/gtech-sre/gtech-sre-context/-/tree/master/.nessy/extensions/nessy-test-agent', name: 'nessy-test-agent', packageName: '@ai-office/nessy-extension-gtech-sre-nessy-extensions-nessy-test-agent' },
    { path: 'https://gitlab.tcsbank.ru/gtech-sre/gtech-sre-context/-/tree/master/.nessy/extensions/nessy-uiux-agent', name: 'nessy-uiux-agent', packageName: '@ai-office/nessy-extension-gtech-sre-nessy-extensions-nessy-uiux-agent' },
    // A subdirectory with no dot, and a listing NAME that matches nothing in
    // the path — the path wins for a `/-/tree/` listing.
    { path: 'https://gitlab.tcsbank.ru/sme-leasing/ai-tools/-/tree/master/backend/extensions/base', name: 'leasing-be-base-extension', packageName: '@ai-office/nessy-extension-sme-leasing-backend-extensions-base' },
    // Repository roots: the listing NAME wins, which `idea-to-prod-extension →
    // init-deploy` settles on its own.
    { path: 'https://gitlab.tcsbank.ru/b2b-ai-market/go-extension', name: 'go-extension', packageName: '@ai-office/nessy-extension-b2b-ai-market-go-extension' },
    { path: 'https://gitlab.tcsbank.ru/short-url/ai-pipeline-extension', name: 'ai-pipeline-extension', packageName: '@ai-office/nessy-extension-short-url-ai-pipeline-extension' },
    { path: 'https://gitlab.tcsbank.ru/b2b-ai-market/idea-to-prod-extension', name: 'init-deploy', packageName: '@ai-office/nessy-extension-b2b-ai-market-init-deploy' },
  ];

  it('reproduces every published install command from the listing alone', () => {
    for (const row of PUBLISHED) {
      expect(deriveNessyExtensionCoordinates(row), row.path).toEqual({
        packageName: row.packageName,
        registry: 'https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all',
      });
    }
    expect(PUBLISHED).toHaveLength(12);
  });

  it('gives the four nessy-default-extension rows an npm source with the derived marker', () => {
    const rows = [
      { path: 'https://gitlab.tcsbank.ru/nestor/nessy-cli-extensions', version: '1.0.9', packageName: '@ai-office/nessy-extension-nestor-nessy-default-extension' },
      { path: 'https://gitlab.tcsbank.ru/sme-factoring/sme-factoring-nessy/-/tree/master/extensions/nessy-default-extension', version: '1.0.9', packageName: '@ai-office/nessy-extension-sme-factoring-extensions-nessy-default-extension' },
      { path: 'https://gitlab.tcsbank.ru/nfs-support/nfs-nessy-api/-/tree/master/.nessy/extensions/nessy-default-extension', version: '1.0.3-beta.0', packageName: '@ai-office/nessy-extension-nfs-support-nessy-extensions-nessy-default-extension' },
      { path: 'https://gitlab.tcsbank.ru/invest-core/t-agentflow/-/tree/master/configs/runtime', version: '1.0.7-beta.0', packageName: '@ai-office/nessy-extension-invest-core-configs-runtime' },
    ];
    for (const row of rows) {
      const item = normalizePluginDto(pluginDto({
        install: undefined,
        name: 'nessy-default-extension',
        path: row.path,
        version: row.version,
      }));
      expect(item.install.sourceConfidence, row.path).toBe('coordinates-derived');
      expect(item.install.source, row.path).toEqual({
        type: 'npm',
        packageName: row.packageName,
        version: row.version,
        // Never omitted: without it an internal package falls back to
        // registry.npmjs.org and a public name-squat would answer.
        registry: 'https://artifactory.tcsbank.ru/artifactory/api/npm/npm-all',
        derivedCoordinates: true,
        raw: expect.any(Object),
      });
    }
  });

  it('lowercases and de-underscores a segment, as the registry does', () => {
    expect(deriveNessyExtensionCoordinates({
      path: 'https://gitlab.tcsbank.ru/dwh-tech-batch-etl/spark-sql-client/-/tree/master/.nessy/extensions/spark_sql_client_helper',
      name: 'spark_sql_client_helper',
    })).toMatchObject({
      packageName: '@ai-office/nessy-extension-dwh-tech-batch-etl-nessy-extensions-spark-sql-client-helper',
    });
  });

  it('names what was missing instead of deriving from nothing', () => {
    expect(deriveNessyExtensionCoordinates({ name: 'orphan' })).toEqual({ gap: 'listing-path-missing' });
    expect(deriveNessyExtensionCoordinates({ path: 'not a url', name: 'orphan' }))
      .toEqual({ gap: 'listing-path-not-a-repository-url' });
    expect(deriveNessyExtensionCoordinates({ path: 'https://gitlab.tcsbank.ru/group/repo' }))
      .toEqual({ gap: 'listing-name-missing' });
    expect(deriveNessyExtensionCoordinates({ path: 'https://gitlab.tcsbank.ru/group/repo/-/tree/master', name: 'x' }))
      .toEqual({ gap: 'listing-path-tree-without-subdirectory' });
  });
})
