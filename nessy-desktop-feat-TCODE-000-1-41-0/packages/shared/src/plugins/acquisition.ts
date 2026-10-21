/**
 * V2-owned bundle acquisition pipeline — the ONLY one (F4).
 *
 * Format-agnostic plan → stage → normalize: remote fetch, archive extraction
 * (`tar` / `yauzl`), adapter normalization via `normalizePluginBundle`, semver
 * resolution, and repository tag listing. It was lifted out of the V1-era
 * `install-service.ts` in F4 part 1 and became the only copy in F4 part 2, which
 * deleted that file along with the V1 registry, projection and commit path it
 * still held. Nothing here reads or writes a plugin registry; committing is
 * `management-service-v2.ts`'s job, through `PluginStoreV2`, using only what is
 * exported from this module.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x as extractTar, t as listTar } from 'tar';
import { open as openZipArchive, type Entry as ZipEntry, type ZipFile } from 'yauzl';
import { parse as parseSemverStrict, rcompare, type SemVer } from 'semver';
import {
  createDefaultPluginFormatAdapters,
  normalizePluginBundle,
} from './format-adapters.ts';
import {
  createPluginInstallPlan,
  createPluginStagingArea,
  resolvePluginInstallSource,
  type CreatePluginInstallPlanOptions,
} from './source-resolver.ts';
import { normalizeNessyPluginManifest, pluginDiagnostic } from './schema.ts';
import { BUNDLE_COPY_OPTIONS, findUnsafeBundleSymlink } from './bundle-hash.ts';
import {
  extractMcpbArchive,
  hasMcpbArchiveExtension,
  hasRootMcpbManifest,
  isZipArchive,
} from './mcpb-archive.ts';
import { archiveUrlRefusalReason } from './archive-url-guard.ts';
import {
  parseBitbucketOrAzureRepositoryUrl,
  repositoryHostKind,
  type RepositoryHostKind,
} from './repository-hosts.ts';
import { isPlaceholderPluginVersion, resolvePluginVersionChain } from './plugin-version-chain.ts';
import type { RepositoryTagRef } from './version-tags.ts';
import type { PluginRuntimeDependencyInstaller } from './install-types.ts';
import {
  hasMaterializedPluginPackageRunner,
  parsePluginPackageRunnerArgs,
  pluginNpxRuntimeRoot,
  qualifyPluginStdioCommand,
} from './stdio-command.ts';
import { DEFAULT_SKILLS_MARKET_API_BASE_URL, SkillsMarketClient } from '../marketplace/client.ts';
import type { MarketplaceSkillSnapshot } from '../marketplace/types.ts';
import { getValidCreds } from '../auth/dp/creds-store.ts';
import {
  dpSessionBroker,
  type DpSessionBroker,
} from '../auth/dp/session-broker.ts';
import { DpAuthError, DpAuthServiceError } from '../auth/dp/errors.ts';
import type {
  NessyPluginManifest,
  PluginCompatibilityReport,
  PluginDiagnostic,
  PluginEcosystemFormat,
  PluginFormatAdapter,
  PluginInstallPlan,
  PluginInstallSource,
  PluginMarketplaceEntryDefinition,
  PluginScope,
  PluginStagedInstall,
} from './types.ts';

export type PluginAgentInstallProposalSource = Exclude<PluginInstallSource, { kind: 'agent-proposed' }>;

/**
 * The marketplace entry definition carried by an install source, if any (S9).
 * `agent-proposed` wraps another source, so it is unwrapped rather than treated
 * as a source kind that cannot come from a marketplace.
 */
function marketplaceEntryDefinitionOf(
  source: PluginInstallSource,
): PluginMarketplaceEntryDefinition | undefined {
  if (source.kind === 'agent-proposed') return marketplaceEntryDefinitionOf(source.source);
  return 'marketplace' in source ? source.marketplace?.entry : undefined;
}

export interface PluginInstallServiceOptions {
  fetchImpl?: typeof fetch;
  artifactAuthProvider?: PluginArtifactAuthProvider;
  dpSessionBroker?: DpSessionBroker;
  runtimeDependencyInstaller?: PluginRuntimeDependencyInstaller;
  baseTempDir?: string;
  formatAdapters?: PluginFormatAdapter[];
  now?: () => number;
  /**
   * Bearer JWT for the Skills Market install counter (F5). Defaults to the
   * cached gateway credentials, which this app treats as read-only.
   */
  marketplaceAccessToken?: () => string | undefined;
}

export type PluginInstallPlanOptions = CreatePluginInstallPlanOptions;

export interface PluginStagedNormalizationResult {
  manifest?: NessyPluginManifest;
  adapterId?: string;
  adapterVersion?: string;
  /** Ecosystem format detected for this bundle (A3); presentation/reporting only. */
  detectedFormat?: PluginEcosystemFormat;
  /** Lossless compatibility summary for the detected format (A2/A3). */
  compatibility?: PluginCompatibilityReport;
  diagnostics: PluginDiagnostic[];
}

export interface PluginAgentInstallProposal {
  label: string;
  source: PluginAgentInstallProposalSource;
  rationale?: string;
  requestedScope?: PluginScope;
}

export interface PluginAgentInstallProposalResult {
  source: PluginInstallSource;
  plan: PluginInstallPlan;
  diagnostics: PluginDiagnostic[];
  confirmationSummary: string[];
}

interface ArtifactFetchResult {
  diagnostics: PluginDiagnostic[];
}

export interface PluginArtifactAuthProvider {
  fetchArtifact(url: URL, fetchImpl: typeof fetch, init?: RequestInit): Promise<Response>;
}

export class PluginInstallService {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseTempDir?: string;
  private readonly adapters: PluginFormatAdapter[];
  private readonly artifactAuthProvider: PluginArtifactAuthProvider;
  private readonly runtimeDependencyInstaller?: PluginRuntimeDependencyInstaller;
  private readonly marketplaceAccessToken: () => string | undefined;

  constructor(options: PluginInstallServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.artifactAuthProvider =
      options.artifactAuthProvider ??
      new DpGitLabArtifactAuthProvider(options.dpSessionBroker ?? dpSessionBroker);
    this.runtimeDependencyInstaller = options.runtimeDependencyInstaller;
    // The Skills Market shares nessy-cli's `~/.nessy/dp_auth_creds.json`, which
    // this app only ever READS. Overridable so a test never touches the real
    // file and never has a real JWT to leak into its own output.
    this.marketplaceAccessToken = options.marketplaceAccessToken ?? (() => getValidCreds()?.jwt);
    this.now = options.now ?? (() => Date.now());
    this.baseTempDir = options.baseTempDir;
    this.adapters = options.formatAdapters ?? createDefaultPluginFormatAdapters();
  }

  /**
   * A market client bound to the host the install's own listing URL came from,
   * sharing this service's `fetchImpl` so a test seam and any host proxying
   * applies to the v2 skill calls too.
   */
  private marketplaceClient(baseUrl: string): SkillsMarketClient {
    return new SkillsMarketClient({ baseUrl, fetchImpl: this.fetchImpl });
  }

  /**
   * F5. `POST /v2/registry/entries/{kind}/{id}/installations` existed and
   * nothing in the repo called it, so every desktop install was invisible to the
   * marketplace's own counters. Issued once per staged market-skill install.
   *
   * **Fail-soft twice over:** the client resolves any network, HTTP or payload
   * failure to `null`, and this wrapper additionally swallows anything the
   * token lookup could throw. A counter must never fail an install.
   *
   * **The bearer is scoped to the verified Skills Market host.** `filesUrl`
   * comes from a catalog row, and a bring-your-own registry can put any host
   * there — attaching the user's JWT to whatever host a listing names would be
   * credential exfiltration by catalog entry. On any other host the report is
   * skipped entirely rather than sent anonymously. The token travels in the
   * `Authorization` header only, never a query parameter, and is never logged
   * or placed in a diagnostic.
   */
  private async reportMarketSkillInstallation(
    market: { baseUrl: string; skillId: string } | undefined,
  ): Promise<void> {
    if (!market || !isSkillsMarketApiBase(market.baseUrl)) return;
    try {
      const accessToken = this.marketplaceAccessToken();
      await this.marketplaceClient(market.baseUrl).reportSkillsRegistryInstallation({
        kind: 'agent-skill',
        id: market.skillId,
        ...(accessToken ? { accessToken } : {}),
      });
    } catch {
      // Deliberately silent: an install that worked must not report a failure
      // whose only subject is a counter the user never asked about.
    }
  }

  async createInstallPlanFromSource(
    source: string | PluginInstallSource,
    options: PluginInstallPlanOptions = {},
  ): Promise<PluginInstallPlan> {
    const resolved = resolvePluginInstallSource(source, options);
    const plan = createPluginInstallPlan(resolved, options);
    return normalizeUrlArtifact(plan);
  }

  async createInstallPlanFromAgentProposal(
    proposal: PluginAgentInstallProposal,
    options: PluginInstallPlanOptions = {},
  ): Promise<PluginAgentInstallProposalResult> {
    const source: PluginInstallSource = {
      kind: 'agent-proposed',
      label: proposal.label,
      source: proposal.source,
      ...(proposal.rationale ? { rationale: proposal.rationale } : {}),
    };
    const plan = await this.createInstallPlanFromSource(source, {
      ...options,
      ...(proposal.requestedScope ? { requestedScope: proposal.requestedScope } : {}),
    });
    return {
      source,
      plan,
      diagnostics: plan.diagnostics,
      confirmationSummary: confirmationSummaryForProposal(proposal, plan),
    };
  }

  async stageInstall(plan: PluginInstallPlan, options: { baseTempDir?: string } = {}): Promise<PluginStagedInstall> {
    const staged = await createPluginStagingArea(plan, {
      baseTempDir: options.baseTempDir ?? this.baseTempDir,
      now: this.now,
    });
    const fetchResult = await this.fetchArtifact(staged);
    staged.diagnostics = [...staged.diagnostics, ...fetchResult.diagnostics];
    staged.plan = {
      ...staged.plan,
      diagnostics: staged.diagnostics,
    };
    return staged;
  }

  async normalizeStagedInstall(staged: PluginStagedInstall): Promise<PluginStagedNormalizationResult> {
    const canonicalRawDirectory = await realpath(staged.rawDirectory);
    const unsafeRawSymlink = await findUnsafeBundleSymlink(staged.rawDirectory, canonicalRawDirectory);
    if (unsafeRawSymlink) {
      const diagnostics = [unsafeBundleSymlinkDiagnostic(canonicalRawDirectory, unsafeRawSymlink)];
      staged.diagnostics = [...staged.diagnostics, ...diagnostics];
      return { diagnostics };
    }
    // S9: the marketplace entry this bundle was installed from is part of its
    // plugin definition, not only of its provenance. It rides the install source
    // (`marketplace.entry`), so this is where it re-enters normalization.
    const marketplaceEntry = marketplaceEntryDefinitionOf(staged.plan.source);
    if (marketplaceEntry) {
      // Persisted with the installed record so a later adapter-version migration
      // re-normalizes with the same definition it installed with.
      staged.plan.origin = { ...staged.plan.origin, marketplaceEntry };
    }
    const normalized = await normalizePluginBundle(
      staged.rawDirectory,
      staged.plan.origin,
      this.adapters,
      marketplaceEntry ? { marketplaceEntry } : {},
    );
    const diagnostics: PluginDiagnostic[] = [...normalized.diagnostics];
    if (!normalized.ok || !normalized.value) {
      const wrapped = isUnsupportedFormatFailure(normalized.diagnostics)
        ? await wrapStandaloneSkillFile(staged.rawDirectory, staged.plan.artifact?.path)
        : undefined;
      if (!wrapped) {
        staged.diagnostics = [...staged.diagnostics, ...diagnostics];
        return {
          ...(normalized.adapterId ? { adapterId: normalized.adapterId } : {}),
          ...(normalized.adapterVersion ? { adapterVersion: normalized.adapterVersion } : {}),
          diagnostics,
        };
      }
      return this.finalizeNormalizedInstall(staged, wrapped, []);
    }

    return this.finalizeNormalizedInstall(staged, normalized.value, diagnostics, {
      ...(normalized.adapterId ? { adapterId: normalized.adapterId } : {}),
      ...(normalized.adapterVersion ? { adapterVersion: normalized.adapterVersion } : {}),
      ...(normalized.compatibility ? { compatibility: normalized.compatibility } : {}),
    });
  }

  private async finalizeNormalizedInstall(
    staged: PluginStagedInstall,
    normalizedManifest: NessyPluginManifest,
    diagnostics: PluginDiagnostic[],
    adapterInfo: { adapterId?: string; adapterVersion?: string; compatibility?: PluginCompatibilityReport } = {},
  ): Promise<PluginStagedNormalizationResult> {
    // P6.577 — steps 3-5 of `plugins/loading.md#how-claude-code-computes-the-version`, applied
    // BEFORE the manifest is written into the bundle, because the file written
    // here is what every later reader (cache key, update check, display) treats
    // as the plugin's own answer. Steps 1 and 2 already ran in the format
    // adapter; reaching this line with the placeholder means neither was set.
    const manifest = resolveInstalledPluginVersion(staged, normalizedManifest);
    staged.plan.origin = {
      ...staged.plan.origin,
      ...(adapterInfo.adapterId ? { adapterId: adapterInfo.adapterId } : {}),
      ...(adapterInfo.adapterVersion ? { adapterVersion: adapterInfo.adapterVersion } : {}),
    };
    await copyDirectoryContents(staged.rawDirectory, staged.normalizedDirectory);
    const canonicalNormalizedDirectory = await realpath(staged.normalizedDirectory);
    const unsafeBundleSymlinkBeforeWrite = await findUnsafeBundleSymlink(
      staged.normalizedDirectory,
      canonicalNormalizedDirectory,
    );
    const bundleDiagnostics = unsafeBundleSymlinkBeforeWrite
      ? [unsafeBundleSymlinkDiagnostic(canonicalNormalizedDirectory, unsafeBundleSymlinkBeforeWrite)]
      : [];
    const materializationDiagnostics: PluginDiagnostic[] = [];
    if (!unsafeBundleSymlinkBeforeWrite) {
      await writeJsonInside(staged.normalizedDirectory, 'plugin.json', manifest);
      const runtimeDependencyDiagnostics = await materializeRuntimeDependencies(
        staged.normalizedDirectory,
        manifest,
        this.runtimeDependencyInstaller,
      );
      materializationDiagnostics.push(
        ...validateMaterializedCapabilities(staged.normalizedDirectory, manifest),
        ...runtimeDependencyDiagnostics,
      );
      if (!runtimeDependencyDiagnostics.some(diagnostic => diagnostic.severity === 'error')) {
        materializationDiagnostics.push(...await materializeDeclaredNpxPackages(
          staged.normalizedDirectory,
          manifest,
          this.runtimeDependencyInstaller,
        ));
      }
      const unsafeBundleSymlinkAfterMaterialization = await findUnsafeBundleSymlink(
        staged.normalizedDirectory,
        canonicalNormalizedDirectory,
      );
      if (unsafeBundleSymlinkAfterMaterialization
        && !materializationDiagnostics.some(diagnostic => diagnostic.code.endsWith('symlink_unsafe'))) {
        bundleDiagnostics.push(unsafeBundleSymlinkDiagnostic(
          canonicalNormalizedDirectory,
          unsafeBundleSymlinkAfterMaterialization,
        ));
      }
    }
    const allDiagnostics = [
      ...diagnostics,
      ...bundleDiagnostics,
      ...materializationDiagnostics,
    ];
    staged.diagnostics = [...staged.diagnostics, ...allDiagnostics];
    const detectedFormat = detectEcosystemFormat(manifest, adapterInfo.adapterId);
    // Consume the format adapter's OWN compatibility report (real deferred/
    // blocked entries, D12) rather than recomputing one from
    // `manifest.capabilities` — a recomputation has no visibility into
    // deferred (non-capability) external fields and always drops them.
    // Only a bundle with no adapter report (native nessy-plugin-json /
    // nessy-extension-json adapters, and the wrapped standalone-skill path,
    // none of which populate `compatibility`) derives one directly from the
    // manifest's own `unsupported` capabilities — those are always fully
    // captured on the manifest itself, so no adapter-side report is lost.
    const compatibility = adapterInfo.compatibility ?? nativeCompatibilityReport(detectedFormat, manifest);
    return {
      manifest,
      ...(adapterInfo.adapterId ? { adapterId: adapterInfo.adapterId } : {}),
      ...(adapterInfo.adapterVersion ? { adapterVersion: adapterInfo.adapterVersion } : {}),
      detectedFormat,
      compatibility,
      diagnostics: allDiagnostics,
    };
  }

  private async fetchArtifact(staged: PluginStagedInstall): Promise<ArtifactFetchResult> {
    const artifact = staged.plan.artifact;
    if (!artifact) {
      return {
        diagnostics: [pluginDiagnostic('error', 'plugin.install.missing_artifact', 'Install plan does not contain an artifact source.')],
      };
    }

    switch (artifact.type) {
      case 'inline-manifest':
        if (artifact.manifest === undefined) {
          return {
            diagnostics: [pluginDiagnostic('error', 'plugin.install.inline_manifest_missing', 'Inline manifest artifact is missing manifest content.')],
          };
        }
        await writeJsonInside(staged.rawDirectory, 'plugin.json', artifact.manifest);
        await writeJsonInside(staged.normalizedDirectory, 'plugin.json', artifact.manifest);
        return { diagnostics: [] };
      case 'local-path':
        return this.copyLocalPathArtifact(staged, artifact.path);
      case 'manifest-url':
        return this.fetchManifestUrlArtifact(staged);
      case 'repository':
        return this.fetchRepositoryArtifact(staged);
      case 'archive-url':
        return this.fetchArchiveUrlArtifact(staged);
      case 'npm-package':
        return this.fetchNpmPackageArtifact(staged);
      case 'gitlab-skill':
        return this.fetchGitLabSkillArtifact(staged);
      case 'skill-files':
        return this.fetchMarketSkillFilesArtifact(staged);
      case 'unknown':
        return {
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.install.unknown_artifact',
            'Install plan artifact source is unknown and cannot be staged safely.',
            undefined,
            artifact.display ? { display: artifact.display } : undefined,
          )],
        };
    }
  }

  private async copyLocalPathArtifact(staged: PluginStagedInstall, sourcePath?: string): Promise<ArtifactFetchResult> {
    if (!sourcePath) {
      return {
        diagnostics: [pluginDiagnostic('error', 'plugin.install.local_path_missing', 'Local plugin artifact path is missing.')],
      };
    }
    try {
      const symlinkPath = await findFirstSymlink(sourcePath);
      if (symlinkPath) {
        return {
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.install.local_path_symlink_unsupported',
            'Local plugin bundles must not contain symlinks for plugin installation.',
            undefined,
            { path: symlinkPath },
          )],
        };
      }
      const stats = await lstat(sourcePath);
      if (stats.isDirectory()) {
        await copyDirectoryContents(sourcePath, staged.rawDirectory);
        return { diagnostics: [] };
      }
      if (stats.isFile()) {
        if (stats.size > MAX_PLUGIN_ARTIFACT_BYTES) {
          return artifactTooLarge(sourcePath);
        }
        const bytes = await readFile(sourcePath);
        if (isZipArchive(bytes.subarray(0, 4))
          && (hasMcpbArchiveExtension(sourcePath) || await hasRootMcpbManifest(sourcePath))) {
          await extractMcpbArchive(sourcePath, staged.rawDirectory);
          return { diagnostics: [] };
        }
        await copyInside(sourcePath, staged.rawDirectory, basename(sourcePath));
        return { diagnostics: [] };
      }
      return {
        diagnostics: [pluginDiagnostic(
          'error',
          'plugin.install.local_path_unsupported',
          'Local plugin artifact is neither a file nor a directory.',
          undefined,
          { path: sourcePath },
        )],
      };
    } catch (error) {
      return {
        diagnostics: [pluginDiagnostic(
          'error',
          'plugin.install.local_path_unreadable',
          `Local plugin artifact could not be read: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          { path: sourcePath },
        )],
      };
    }
  }

  private async fetchManifestUrlArtifact(staged: PluginStagedInstall): Promise<ArtifactFetchResult> {
    const artifact = staged.plan.artifact;
    const url = artifact?.url ?? artifact?.manifestUrl;
    if (!url) {
      return {
        diagnostics: [pluginDiagnostic('error', 'plugin.install.manifest_url_missing', 'Manifest URL artifact is missing a URL.')],
      };
    }
    if (isGitLabBlobUrl(url)) {
      return {
        diagnostics: [
          pluginDiagnostic(
            'warning',
            'plugin.install.manifest_url_blob_not_direct',
            'Manifest URL points to a GitLab blob page, not a direct JSON artifact.',
            undefined,
            { url },
          ),
          ...(artifact?.repositoryUrl ? [repositoryNotImplementedDiagnostic(artifact.repositoryUrl)] : []),
        ],
      };
    }

    try {
      const response = await this.fetchImpl(new URL(url));
      if (!response.ok) {
        return {
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.install.manifest_url_fetch_failed',
            `Manifest URL request failed: ${response.status}`,
            undefined,
            { url },
          )],
        };
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!isJsonContentType(contentType)) {
        return {
          diagnostics: [
            pluginDiagnostic(
              'warning',
              'plugin.install.manifest_url_not_json',
              'Manifest URL response is not JSON and will not be installed as a plugin manifest.',
              undefined,
              { url, contentType },
            ),
            ...(artifact?.repositoryUrl ? [repositoryNotImplementedDiagnostic(artifact.repositoryUrl)] : []),
          ],
        };
      }
      const manifest = await response.json();
      await writeJsonInside(staged.rawDirectory, 'plugin.json', manifest);
      await writeJsonInside(staged.normalizedDirectory, 'plugin.json', manifest);
      return { diagnostics: [] };
    } catch (error) {
      return {
        diagnostics: [pluginDiagnostic(
          'error',
          'plugin.install.manifest_url_fetch_failed',
          `Manifest URL could not be fetched: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          { url },
        )],
      };
    }
  }

  private async fetchNpmPackageArtifact(staged: PluginStagedInstall): Promise<ArtifactFetchResult> {
    const artifact = staged.plan.artifact;
    const packageName = artifact?.packageName;
    if (!packageName) {
      return {
        diagnostics: [pluginDiagnostic('error', 'plugin.install.npm_package_missing', 'NPM package artifact is missing a package name.')],
      };
    }
    const registry = trimTrailingSlash(artifact.registry ?? 'https://registry.npmjs.org');
    const metadataUrl = `${registry}/${encodeURIComponent(packageName)}`;
    try {
      const metadataResponse = await this.fetchImpl(new URL(metadataUrl));
      if (!metadataResponse.ok) {
        return {
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.install.npm_metadata_fetch_failed',
            `NPM package metadata request failed: ${metadataResponse.status}`,
            undefined,
            { registry, packageName },
          )],
        };
      }
      const metadata = await metadataResponse.json();
      const selection = selectNpmVersionName(metadata, artifact.version);
      const versionInfo = selection && isRecord(metadata) && isRecord(metadata.versions)
        ? metadata.versions[selection.version]
        : undefined;
      if (!selection || !isRecord(versionInfo)) {
        return {
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.install.npm_version_missing',
            `NPM package metadata does not contain version "${artifact.version ?? 'latest'}".`,
            undefined,
            { registry, packageName, version: artifact.version ?? 'latest' },
          )],
        };
      }
      // Requested vs resolved, out loud. A CI build stamp is the same release,
      // but "asked for 1.0.9, installed 1.0.9-source.<stamp>" is exactly the
      // kind of substitution that must never be discovered later from a bundle.
      const resolutionDiagnostics = selection.version === artifact.version
        ? []
        : [pluginDiagnostic(
            'info',
            'plugin.install.npm_version_resolved',
            `NPM package ${packageName}: requested "${artifact.version ?? 'latest'}", resolved "${selection.version}" (${selection.rule}).`,
            undefined,
            {
              registry,
              packageName,
              requested: artifact.version ?? 'latest',
              resolved: selection.version,
              rule: selection.rule,
              ...selection.info,
            },
          )];
      const coordinateDiagnostics = derivedCoordinateRepositoryDiagnostics(staged.plan.source, versionInfo, {
        registry,
        packageName,
        version: selection.version,
      });
      const tarballUrl = readNestedString(versionInfo, ['dist', 'tarball']);
      if (!tarballUrl) {
        return {
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.install.npm_tarball_missing',
            'NPM package metadata does not contain a tarball URL.',
            undefined,
            { registry, packageName },
          )],
        };
      }
      const archivePath = join(staged.stageDirectory, 'package.tgz');
      const downloaded = await this.downloadArtifact(tarballUrl, archivePath);
      if (downloaded.diagnostics.length) return downloaded;
      // `dist.integrity` is the trust anchor; `dist.shasum` is the legacy SHA-1
      // some registry mirrors publish alone, and it is a transport check only.
      // An artifact that offers NEITHER is still installed — that is not ours
      // to refuse — but it says so out loud rather than reporting the silence
      // as a passed check, which is what the old fail-open return did.
      const expectedIntegrity = artifact.integrity ?? readNestedString(versionInfo, ['dist', 'integrity']);
      const expectedShasum = readNestedString(versionInfo, ['dist', 'shasum']);
      const digestDiagnostics: PluginDiagnostic[] = [];
      let verifiedIntegrity: string | undefined;
      if (expectedIntegrity) {
        const failure = verifyIntegrity(downloaded.bytes, expectedIntegrity, { packageName });
        if (failure) return { diagnostics: [failure] };
        verifiedIntegrity = expectedIntegrity.trim();
      } else if (expectedShasum) {
        const failure = verifyDistShasum(downloaded.bytes, expectedShasum, { packageName });
        if (failure) return { diagnostics: [failure] };
      } else {
        digestDiagnostics.push(pluginDiagnostic(
          'warning',
          'plugin.install.integrity_unverified',
          `NPM package ${packageName} publishes no digest for version "${selection.version}"; the download could not be verified.`,
          undefined,
          { registry, packageName, version: selection.version },
        ));
      }
      stampResolvedNpmProvenance(staged, {
        resolvedVersion: selection.version,
        ...(artifact.version ? { advertisedVersion: artifact.version } : {}),
        ...(verifiedIntegrity ? { integrity: verifiedIntegrity } : {}),
      });
      await extractArchiveFile(archivePath, staged.rawDirectory, { strip: 1 });
      await writeMarketplaceMetadataSnapshot(staged);
      return { diagnostics: [...resolutionDiagnostics, ...coordinateDiagnostics, ...digestDiagnostics] };
    } catch (error) {
      return {
        diagnostics: [pluginDiagnostic(
          'error',
          'plugin.install.npm_package_fetch_failed',
          `NPM package could not be staged: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          { registry, packageName },
        )],
      };
    }
  }

  private async fetchArchiveUrlArtifact(staged: PluginStagedInstall): Promise<ArtifactFetchResult> {
    const artifact = staged.plan.artifact;
    const url = artifact?.url;
    if (!url) {
      return {
        diagnostics: [pluginDiagnostic('error', 'plugin.install.archive_url_missing', 'Archive artifact is missing a URL.')],
      };
    }
    try {
      const archivePath = join(staged.stageDirectory, 'artifact.tgz');
      // The archive `url` field's redirect rule applies to this download alone
      // (the npm and repository paths reach their own hosts' redirect semantics),
      // so the hop guard is passed here and nowhere else.
      // The entry's own archive-download headers travel with the hop guard for
      // one reason: `plugins/host-marketplace.md#when-claude-code-skips-a-headershelper-command-or-drops-its-output`
      // — "**Redirect leaves the origin**: when a download is redirected off the
      // archive URL's origin, Claude Code drops the `headers` values and command
      // output of both the marketplace `url` source and the plugin entry." The
      // guarded-redirect loop is the ONLY place in this file that knows which
      // origin a hop is on, so that is where the credential can be bound to it.
      const downloaded = await this.downloadArtifact(url, archivePath, {
        redirectGuard: archiveUrlRefusalReason,
        ...(artifact.headers ? { originHeaders: artifact.headers } : {}),
      });
      if (downloaded.diagnostics.length) return downloaded;
      const hashDiagnostic = artifact.expectedHash ? verifyExpectedHash(downloaded.bytes, artifact.expectedHash, { url }) : undefined;
      if (hashDiagnostic) return { diagnostics: [hashDiagnostic] };
      // P6.577, step 4's second half: "the `sha256` pin in the marketplace
      // entry, or the digest of the downloaded file when you set no pin". This
      // is the ONE line in the fork where an unpinned archive's bytes are in
      // hand, so it is the only place that half can be produced. Recorded
      // whether or not a pin exists — the pin still wins, and a recorded digest
      // that agrees with it costs one hash of bytes already in memory.
      staged.artifactDigest = createHash('sha256').update(downloaded.bytes).digest('hex');
      if (isZipArchive(downloaded.bytes.subarray(0, 4))
        && (hasMcpbArchiveExtension(url) || await hasRootMcpbManifest(archivePath))) {
        await extractMcpbArchive(archivePath, staged.rawDirectory);
      } else {
        // Both zip layouts the page documents, not only the folder-wrapped one:
        // strip the wrapping folder when there is one, keep the contents in
        // place when the plugin root is already at the archive top.
        await extractArchiveFile(archivePath, staged.rawDirectory, {
          strip: await detectArchivePluginStrip(archivePath),
        });
      }
      await writeMarketplaceMetadataSnapshot(staged);
      return { diagnostics: [] };
    } catch (error) {
      return {
        diagnostics: [pluginDiagnostic(
          'error',
          'plugin.install.archive_fetch_failed',
          `Archive artifact could not be staged: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          { url },
        )],
      };
    }
  }

  private async fetchRepositoryArtifact(staged: PluginStagedInstall): Promise<ArtifactFetchResult> {
    const artifact = staged.plan.artifact;
    const source = staged.plan.source.kind === 'repository' ? staged.plan.source : undefined;
    const repositoryUrl = source?.repositoryUrl ?? artifact?.repositoryUrl ?? artifact?.url;
    if (!repositoryUrl) {
      return {
        diagnostics: [pluginDiagnostic('error', 'plugin.install.repository_url_missing', 'Repository artifact is missing a repository URL.')],
      };
    }
    try {
      const spec = normalizeRepositorySpec(repositoryUrl, source?.ref, source?.subdirectory);
      if (!spec) {
        return {
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.install.repository_url_unsupported',
            'Only GitHub, GitLab, Bitbucket Cloud and Azure DevOps repository URLs are supported for marketplace repository installs.',
            undefined,
            { repositoryUrl },
          )],
        };
      }
      const ref = spec.ref ?? await this.fetchRepositoryDefaultRef(spec);
      if (!ref) {
        return {
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.install.repository_ref_unresolved',
            'Repository ref is missing and the default branch could not be discovered.',
            undefined,
            { repositoryUrl },
          )],
        };
      }
      const format = repositoryArchiveFormat(spec);
      const archivePath = join(staged.stageDirectory, format === 'zip' ? 'repository.zip' : 'repository.tgz');
      // One candidate on every host but Azure DevOps, where a bare ref cannot
      // say whether it names a branch or a tag — see {@link azureDevOpsArchiveUrls}.
      // A failed attempt writes nothing, so the retry cannot extract a partial
      // download from the previous one.
      const candidates = repositoryArchiveUrls(spec, ref);
      let downloaded = await this.downloadArtifact(candidates[0] ?? '', archivePath);
      for (const candidate of candidates.slice(1)) {
        if (!downloaded.diagnostics.length) break;
        downloaded = await this.downloadArtifact(candidate, archivePath);
      }
      if (downloaded.diagnostics.length) return downloaded;
      const subdirectory = spec.subdirectory;
      if (format === 'tar' && !subdirectory) {
        await extractArchiveFile(archivePath, staged.rawDirectory, { strip: 1 });
      } else {
        const extractDirectory = await mkdtemp(join(staged.stageDirectory, 'repository-extract-'));
        if (format === 'zip') await extractRepositoryZip(archivePath, extractDirectory);
        else await extractArchiveFile(archivePath, extractDirectory, { strip: 1 });
        const contentRoot = format === 'zip'
          ? await resolveExtractedRepositoryRoot(extractDirectory)
          : extractDirectory;
        const sourceDirectory = subdirectory ? join(contentRoot, subdirectory) : contentRoot;
        assertPathInside(extractDirectory, sourceDirectory);
        await copyDirectoryContents(sourceDirectory, staged.rawDirectory);
      }
      await writeMarketplaceMetadataSnapshot(staged);
      return { diagnostics: [] };
    } catch (error) {
      return {
        diagnostics: [pluginDiagnostic(
          'error',
          'plugin.install.repository_fetch_failed',
          `Repository artifact could not be staged: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          { repositoryUrl },
        )],
      };
    }
  }

  private async fetchGitLabSkillArtifact(staged: PluginStagedInstall): Promise<ArtifactFetchResult> {
    const artifact = staged.plan.artifact;
    const url = artifact?.url;
    if (!url) {
      return {
        diagnostics: [pluginDiagnostic('error', 'plugin.install.gitlab_skill_url_missing', 'GitLab skill artifact is missing a URL.')],
      };
    }
    const rawUrl = gitLabRawUrl(url, artifact.ref, artifact.path);
    const downloadUrl = gitLabApiRawUrl(url, artifact.ref, artifact.path) ?? rawUrl;
    try {
      const requestUrl = new URL(downloadUrl);
      const response = await this.artifactAuthProvider.fetchArtifact(requestUrl, this.fetchImpl);
      if (!response.ok) {
        return {
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.install.gitlab_skill_fetch_failed',
            `GitLab skill request failed: ${response.status}`,
            undefined,
            { url: downloadUrl },
          )],
        };
      }
      const contentType = response.headers.get('content-type') ?? '';
      const content = await response.text();
      if (isHtmlResponse(content, contentType)) {
        return {
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.install.gitlab_skill_unexpected_html',
            'GitLab skill request returned an HTML page instead of a markdown skill file. The repository likely requires browser authentication or an unsupported GitLab token.',
            undefined,
            { url: downloadUrl, contentType },
          )],
        };
      }
      const references = findUnavailableRelativeReferences(content);
      if (references.length > 0) {
        return {
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.install.gitlab_skill_references_not_available',
            'Marketplace GitLab skill references sibling files that are not available from the single-file install source.',
            undefined,
            { references },
          )],
        };
      }
      const skillSlug = sanitizePluginIdSegment(artifact.skillSlug ?? basename(artifact.path ?? new URL(rawUrl).pathname, '.md'));
      const pluginId = artifact.pluginId ?? `marketplace-skill-${skillSlug}`;
      const skillPath = `skills/${skillSlug}/SKILL.md`;
      await mkdir(join(staged.rawDirectory, 'skills', skillSlug), { recursive: true });
      await writeFile(join(staged.rawDirectory, skillPath), content, { encoding: 'utf-8', mode: 0o600 });
      await writeJsonInside(staged.rawDirectory, 'plugin.json', {
        schemaVersion: 1,
        kind: 'plugin',
        id: pluginId,
        name: artifact.name ?? skillSlug,
        version: artifact.version ?? '0.0.0',
        capabilities: [
          {
            kind: 'skill',
            id: skillSlug,
            skill: {
              slug: skillSlug,
              path: skillPath,
            },
          },
        ],
        compatibility: {
          rawExternalKind: 'marketplace-skill',
        },
      } satisfies NessyPluginManifest);
      await writeMarketplaceMetadataSnapshot(staged);
      return { diagnostics: [] };
    } catch (error) {
      return {
        diagnostics: [pluginDiagnostic(
          'error',
          'plugin.install.gitlab_skill_fetch_failed',
          `GitLab skill could not be staged: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          { url: downloadUrl },
        )],
      };
    }
  }

  /**
   * skills-market v2 per-file snapshot install. Every file in the skill
   * directory is fetched individually from the market (no GitLab auth),
   * digest-verified against the listing, and written under
   * `skills/<slug>/…`; the synthesized manifest matches the gitlab-skill
   * path. Bounded fail-closed: file count, per-file and total size caps,
   * unsafe/absolute paths, digest mismatches and non-market download URLs
   * all abort the staging with a typed diagnostic.
   */
  private async fetchMarketSkillFilesArtifact(staged: PluginStagedInstall): Promise<ArtifactFetchResult> {
    const artifact = staged.plan.artifact;
    const filesUrl = artifact?.filesUrl;
    if (!filesUrl) {
      return {
        diagnostics: [pluginDiagnostic('error', 'plugin.install.skill_files_url_missing', 'Market skill artifact is missing the files listing URL.')],
      };
    }
    const fail = (code: string, message: string, details?: Record<string, unknown>): ArtifactFetchResult => ({
      diagnostics: [pluginDiagnostic('error', code, message, undefined, { url: filesUrl, ...details })],
    });
    // F3. Record WHICH immutable snapshot this install took. Without it a market
    // skill carries no revision identity at all and can never be told stale: the
    // per-file listing URL names a snapshot, but nothing durable did. Read from
    // `/v2/skills/{id}/releases/latest` because the listing URL alone cannot say
    // whether the snapshot it names is still the latest one.
    const snapshotDiagnostics: PluginDiagnostic[] = [];
    const market = parseMarketSkillEndpoint(filesUrl);
    let archiveDigest: string | undefined;
    if (market) {
      const snapshot = await this.marketplaceClient(market.baseUrl)
        .getMarketplaceSkillSnapshot(market.skillId)
        .catch(() => undefined);
      if (snapshot) {
        stampMarketSkillSnapshot(staged, snapshot);
        archiveDigest = snapshot.archive?.digest;
      } else {
        // Not fatal — the per-file listing still installs a correct skill — but
        // it is recorded, because a silently unversioned install is the state
        // this row exists to end.
        snapshotDiagnostics.push(pluginDiagnostic(
          'warning',
          'plugin.install.skill_snapshot_unrecorded',
          'The marketplace did not return a release snapshot for this skill; the install cannot be told stale later.',
          undefined,
          { skillId: market.skillId },
        ));
      }
    }
    // F4. One archive request instead of 1 listing + N file requests. The
    // release we just fetched names the archive's digest INDEPENDENTLY of the
    // archive response, so the bytes are pinned to the artifact the market
    // named rather than merely un-corrupted in transit (live 2026-07-31 on
    // `skl_v1_225cfdef…`: `artifact.archive.digest`, the `archive.zip` ETag and
    // sha256 of the 84899-byte body are the same hex, and the tree is 6 files —
    // 7 requests become 1).
    //
    // The per-file listing stays as the fallback for a market that names no
    // archive at all. It is NOT a fallback for a failed archive: an archive
    // that was fetched and then failed digest or extraction is a refusal, never
    // a quiet downgrade back to N+1.
    if (market && archiveDigest) {
      return await this.fetchMarketSkillArchiveArtifact(staged, market, archiveDigest, snapshotDiagnostics);
    }
    try {
      const listingUrl = new URL(filesUrl);
      const response = await this.fetchImpl(listingUrl);
      if (!response.ok) {
        return fail('plugin.install.skill_files_fetch_failed', `Market skill files listing request failed: ${response.status}`);
      }
      const payload: unknown = await response.json();
      const files = isRecord(payload) && Array.isArray(payload.files) ? payload.files : undefined;
      if (!files || files.length === 0) {
        return fail('plugin.install.skill_files_listing_invalid', 'Market skill files listing has no files.');
      }
      if (files.length > MAX_SKILL_SNAPSHOT_FILES) {
        return fail('plugin.install.skill_files_too_many', `Market skill snapshot exceeds ${MAX_SKILL_SNAPSHOT_FILES} files.`, { files: files.length });
      }

      const skillSlug = sanitizePluginIdSegment(artifact.skillSlug ?? 'skill');
      const skillRoot = join(staged.rawDirectory, 'skills', skillSlug);
      let totalBytes = 0;
      let sawEntrypoint = false;
      for (const entry of files) {
        if (!isRecord(entry)) return fail('plugin.install.skill_files_listing_invalid', 'Market skill files listing entry is not an object.');
        const path = typeof entry.path === 'string' ? entry.path : undefined;
        const digest = typeof entry.digest === 'string' ? entry.digest : undefined;
        const downloadUrl = typeof entry.downloadUrl === 'string' ? entry.downloadUrl : undefined;
        if (!path || !digest || !downloadUrl) {
          return fail('plugin.install.skill_files_listing_invalid', 'Market skill files listing entry is missing path/digest/downloadUrl.');
        }
        if (isUnsafeArchivePath(path)) {
          return fail('plugin.install.skill_files_unsafe_path', 'Market skill file path would escape the staging directory.', { path });
        }
        // `downloadUrl` is relative to the market API BASE (…/api), not the
        // host origin — the listing URL itself is `<apiBase>/v2/…`, so the
        // base is everything before its `/v2/` segment.
        const apiBaseEnd = listingUrl.href.indexOf('/v2/');
        // P2.184 — `new URL` THROWS on a malformed `downloadUrl`, and it was
        // the one field in this loop that did. Every sibling check above
        // returns a named `fail(...)`; this one escaped to the function's
        // outer catch, which renames the fault
        // `plugin.install.skill_files_fetch_failed` — "the request failed" —
        // for a listing that was never requestable, and drops the `{ path }`
        // that says WHICH entry. The listing is market-supplied, so the operand
        // is upstream-controlled: a single bad row mislabelled the whole
        // install. The refusal itself stays whole-snapshot, which is correct
        // here (a partially staged skill tree is not a skill), but it now
        // carries the name its siblings carry.
        let fileUrl: URL;
        try {
          fileUrl = downloadUrl.startsWith('/v2/') && apiBaseEnd > 0
            ? new URL(`${listingUrl.href.slice(0, apiBaseEnd)}${downloadUrl}`)
            : new URL(downloadUrl, listingUrl);
        } catch {
          return fail(
            'plugin.install.skill_files_listing_invalid',
            'Market skill files listing entry has an unparseable downloadUrl.',
            { path },
          );
        }
        if (fileUrl.origin !== listingUrl.origin) {
          return fail('plugin.install.skill_files_foreign_origin', 'Market skill file download URL points outside the marketplace.', { path });
        }
        const fileResponse = await this.fetchImpl(fileUrl);
        if (!fileResponse.ok) {
          return fail('plugin.install.skill_files_fetch_failed', `Market skill file request failed: ${fileResponse.status}`, { path });
        }
        const bytes = Buffer.from(await fileResponse.arrayBuffer());
        totalBytes += bytes.byteLength;
        if (bytes.byteLength > MAX_SKILL_SNAPSHOT_FILE_BYTES || totalBytes > MAX_SKILL_SNAPSHOT_TOTAL_BYTES) {
          return fail('plugin.install.skill_files_too_large', 'Market skill snapshot exceeds the download size cap.', { path });
        }
        const digestMatch = digest.match(/^sha256:([0-9a-f]{64})$/i);
        if (!digestMatch || createHash('sha256').update(bytes).digest('hex') !== digestMatch[1]?.toLowerCase()) {
          return fail('plugin.install.skill_files_digest_mismatch', 'Market skill file bytes do not match the listing digest.', { path });
        }
        const targetPath = join(skillRoot, path);
        assertPathInside(skillRoot, targetPath);
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, bytes, { mode: entry.executable === true ? 0o700 : 0o600 });
        if (path === 'SKILL.md') sawEntrypoint = true;
      }
      if (!sawEntrypoint) {
        return fail('plugin.install.skill_files_entrypoint_missing', 'Market skill snapshot has no SKILL.md entrypoint.');
      }

      await this.writeMarketSkillManifest(staged, skillSlug);
      await this.reportMarketSkillInstallation(market);
      return { diagnostics: snapshotDiagnostics };
    } catch (error) {
      return fail(
        'plugin.install.skill_files_fetch_failed',
        `Market skill snapshot could not be staged: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * F4. The whole skill tree in ONE request: `/v1/skills/{id}/archive.zip`
   * serves it anonymously, and `expectedDigest` comes from the separately
   * fetched release, so the client refuses bytes that are not the artifact the
   * market named.
   *
   * Staged through exactly the same synthesized manifest, marketplace metadata
   * snapshot and install report as the per-file path, so which transport was
   * used is invisible downstream.
   */
  private async fetchMarketSkillArchiveArtifact(
    staged: PluginStagedInstall,
    market: { baseUrl: string; skillId: string },
    expectedDigest: string,
    carriedDiagnostics: PluginDiagnostic[],
  ): Promise<ArtifactFetchResult> {
    const skillSlug = sanitizePluginIdSegment(staged.plan.artifact?.skillSlug ?? 'skill');
    const archivePath = join(staged.stageDirectory, 'skill-archive.zip');
    try {
      const download = await this.marketplaceClient(market.baseUrl)
        .downloadMarketplaceSkillArchive(market.skillId, { expectedDigest });
      await writeFile(archivePath, download.bytes, { mode: 0o600 });
      const entries = await extractSkillArchiveZip(archivePath, join(staged.rawDirectory, 'skills', skillSlug));
      if (!entries.has('SKILL.md')) {
        return {
          diagnostics: [...carriedDiagnostics, pluginDiagnostic(
            'error',
            'plugin.install.skill_files_entrypoint_missing',
            'Market skill archive has no SKILL.md entrypoint.',
            undefined,
            { skillId: market.skillId },
          )],
        };
      }
      await this.writeMarketSkillManifest(staged, skillSlug);
      await this.reportMarketSkillInstallation(market);
      return { diagnostics: carriedDiagnostics };
    } catch (error) {
      return {
        diagnostics: [...carriedDiagnostics, pluginDiagnostic(
          'error',
          'plugin.install.skill_archive_fetch_failed',
          `Market skill archive could not be staged: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          { skillId: market.skillId },
        )],
      };
    } finally {
      await rm(archivePath, { force: true });
    }
  }

  /**
   * The synthesized plugin manifest a market skill install stages, shared by the
   * archive and per-file transports so they cannot describe the same skill
   * differently.
   */
  private async writeMarketSkillManifest(staged: PluginStagedInstall, skillSlug: string): Promise<void> {
    const artifact = staged.plan.artifact;
    await writeJsonInside(staged.rawDirectory, 'plugin.json', {
      schemaVersion: 1,
      kind: 'plugin',
      id: artifact?.pluginId ?? `marketplace-skill-${skillSlug}`,
      name: artifact?.name ?? skillSlug,
      version: artifact?.version ?? '0.0.0',
      capabilities: [
        {
          kind: 'skill',
          id: skillSlug,
          skill: {
            slug: skillSlug,
            path: `skills/${skillSlug}/SKILL.md`,
          },
        },
      ],
      compatibility: {
        rawExternalKind: 'marketplace-skill',
      },
    } satisfies NessyPluginManifest);
    await writeMarketplaceMetadataSnapshot(staged);
  }

  /**
   * `plugin-marketplaces.md` § Zip archives, `url` field (fetched 2026-08-24,
   * re-fetched 2026-08-26 at `plugins/host-marketplace.md#stay-within-the-download-limits-for-hosted-files`): "Every
   * redirect hop must satisfy the same rules, or Claude Code refuses the
   * download." Native `fetch` follows redirects internally and hands back only the
   * FINAL response, so a hop through a refused host would never be seen. This
   * follows redirects manually — `redirect: 'manual'` threaded through the auth
   * provider so an internal-GitLab archive keeps its token — and runs the same
   * guard against each hop's target before following it.
   *
   * **Credentials stop at the ORIGIN (P2.103, measured 2026-08-26).** Same page,
   * `#when-claude-code-skips-a-headershelper-command-or-drops-its-output`:
   * "**Redirect leaves the origin**: when a download is redirected off the
   * archive URL's origin, Claude Code drops the `headers` values and command
   * output of both the marketplace `url` source and the plugin entry." The auth
   * provider decides per hop from that hop's OWN hostname, so before this the
   * rule held by accident in one direction and was inverted in the other: an
   * internal-GitLab URL redirecting outward correctly lost its token (the
   * provider's allowlist declined), but an ARBITRARY external archive URL
   * redirecting INTO `gitlab.tcsbank.ru` had the user's internal token attached
   * to a request the archive's author chose — an authenticated internal read on
   * behalf of an untrusted URL, whose body is then installed as a plugin.
   * Comparing against the ORIGINAL origin covers both directions with one term.
   */
  private async fetchFollowingGuardedRedirects(
    url: string,
    redirectGuard: (candidate: string) => string | undefined,
    originHeaders?: Record<string, string>,
  ): Promise<{ response: Response } | { refusal: ArtifactFetchResult & { bytes: Buffer } }> {
    let currentUrl = new URL(url);
    const initialOrigin = currentUrl.origin;
    for (let hop = 0; hop <= MAX_ARTIFACT_REDIRECTS; hop++) {
      const response = currentUrl.origin === initialOrigin
        ? await this.artifactAuthProvider.fetchArtifact(
            currentUrl,
            this.fetchImpl,
            { redirect: 'manual', ...(originHeaders ? { headers: { ...originHeaders } } : {}) },
          )
        : await this.fetchImpl(currentUrl, { redirect: 'manual' });
      if (!isRedirectStatus(response.status)) return { response };
      const location = response.headers.get('location');
      // A 3xx with no `Location` is a malformed redirect, not a hop to validate:
      // hand it back and let the caller's not-ok handling report it.
      if (!location) return { response };
      await response.body?.cancel();
      let nextUrl: URL;
      try {
        nextUrl = new URL(location, currentUrl);
      } catch {
        return { refusal: artifactRedirectRefused(url, location, 'the redirect target is unparseable') };
      }
      const reason = redirectGuard(nextUrl.href);
      if (reason) return { refusal: artifactRedirectRefused(url, nextUrl.href, reason) };
      currentUrl = nextUrl;
    }
    return {
      refusal: artifactRedirectRefused(url, currentUrl.href, `the download exceeded ${MAX_ARTIFACT_REDIRECTS} redirects`),
    };
  }

  private async downloadArtifact(
    url: string,
    targetPath: string,
    options: {
      redirectGuard?: (candidate: string) => string | undefined;
      /**
       * Headers sent on `url`'s OWN origin only. Reachable exclusively through
       * the guarded-redirect path, because that path is what enforces the
       * "drops the `headers` values … off the archive URL's origin" rule — a
       * credential with no origin binding has no business on this method.
       */
      originHeaders?: Record<string, string>;
    } = {},
  ): Promise<ArtifactFetchResult & { bytes: Buffer }> {
    let response: Response;
    if (options.redirectGuard) {
      const followed = await this.fetchFollowingGuardedRedirects(
        url,
        options.redirectGuard,
        options.originHeaders,
      );
      if ('refusal' in followed) return followed.refusal;
      response = followed.response;
    } else {
      response = await this.artifactAuthProvider.fetchArtifact(new URL(url), this.fetchImpl);
    }
    if (!response.ok) {
      return {
        bytes: Buffer.alloc(0),
        diagnostics: [pluginDiagnostic(
          'error',
          'plugin.install.artifact_download_failed',
          `Artifact request failed: ${response.status}`,
          undefined,
          { url },
        )],
      };
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PLUGIN_ARTIFACT_BYTES) {
      await response.body?.cancel();
      return artifactTooLarge(url);
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_PLUGIN_ARTIFACT_BYTES) {
            await reader.cancel();
            return artifactTooLarge(url);
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = Buffer.concat(chunks, totalBytes);
    // A3. A GitLab route that wants a browser session answers 200 with a
    // sign-in PAGE after the redirect, not an error — so without this the tar
    // extractor is the first thing to notice, and it reports a corrupt archive
    // rather than "this host wants you signed in". Sniffed rather than trusted
    // to the content-type alone: the same reader already exists for single-file
    // GitLab skills (`fetchGitLabSkillArtifact`), where the identical page was
    // reaching the parser.
    if (isHtmlResponse(bytes.subarray(0, 512).toString('utf-8'), response.headers.get('content-type') ?? '')) {
      return {
        bytes: Buffer.alloc(0),
        diagnostics: [pluginDiagnostic(
          'error',
          'plugin.install.artifact_unexpected_html',
          'Artifact request returned an HTML page instead of an archive. The repository likely requires browser authentication or an unsupported token.',
          undefined,
          { url, contentType: response.headers.get('content-type') ?? '' },
        )],
      };
    }
    await writeFile(targetPath, bytes, { mode: 0o600 });
    return { bytes, diagnostics: [] };
  }

  private async fetchRepositoryDefaultRef(spec: RepositorySpec): Promise<string | undefined> {
    const requestUrl = new URL(repositoryMetadataUrl(spec));
    const response = await this.artifactAuthProvider.fetchArtifact(requestUrl, this.fetchImpl);
    if (!response.ok) return undefined;
    const payload = await response.json();
    return isRecord(payload) ? readRepositoryDefaultRef(spec, payload) : undefined;
  }

  /**
   * `plugins/host-marketplace.md#run-release-channels` — "Claude Code lists the marketplace's tags".
   *
   * The one network prerequisite the whole version-constraint feature was
   * missing, and it is smaller than three separate records in this repo assumed:
   * no git binary is involved, only one more REST path hanging off the base
   * `repositoryApiUrl` already computes for {@link fetchRepositoryDefaultRef}.
   * GitHub exposes `/tags` on `…/repos/{owner}/{repo}`; GitLab exposes
   * `/repository/tags` on `…/projects/{id}`. Same hosts, same auth provider,
   * same fetch seam.
   *
   * Returns `undefined` — not `[]` — when the listing could not be read at all.
   * The difference is load-bearing: an empty list means "this repository
   * publishes no tag for that plugin", which `:127` turns into a
   * `no-matching-tag` refusal, while an unreachable listing must not be
   * reported as an authoritative absence.
   */
  async listRepositoryTags(
    repositoryUrl: string,
    options: { ref?: string; subdirectory?: string } = {},
  ): Promise<RepositoryTagRef[] | undefined> {
    const spec = normalizeRepositorySpec(repositoryUrl, options.ref, options.subdirectory);
    if (!spec) return undefined;
    const tags: RepositoryTagRef[] = [];
    try {
      for (let page = 1; page <= MAX_REPOSITORY_TAG_PAGES; page += 1) {
        const requestUrl = new URL(repositoryTagsUrl(spec, page));
        const response = await this.artifactAuthProvider.fetchArtifact(requestUrl, this.fetchImpl);
        if (!response.ok) return page === 1 ? undefined : tags;
        const rows = readRepositoryTagPage(spec, await response.json());
        if (!rows) return page === 1 ? undefined : tags;
        for (const row of rows) tags.push(...readRepositoryTagRow(spec, row));
        // Azure DevOps pages by opaque continuation token rather than by page
        // number, so one request asks for the whole ceiling and there is no
        // second page to ask for — see {@link repositoryTagsUrl}.
        if (rows.length < REPOSITORY_TAG_PAGE_SIZE || spec.host === 'azure-devops') break;
      }
    } catch {
      // An unreachable listing is not an authoritative "no tags" — see above.
      return tags.length > 0 ? tags : undefined;
    }
    return tags;
  }
}

/** One page each for GitHub and GitLab; 1 000 tags is far past any real plugin repo. */
const REPOSITORY_TAG_PAGE_SIZE = 100;
const MAX_REPOSITORY_TAG_PAGES = 10;

/**
 * The repository-metadata request, which carries the default branch.
 *
 * Only Azure DevOps needs a query on it: its REST surface requires
 * `api-version` on every call and answers 400 without one
 * (`rest/api/azure/devops`, "Every REST API call needs to include the
 * api-version").
 */
function repositoryMetadataUrl(spec: RepositorySpec): string {
  const base = repositoryApiUrl(spec);
  return spec.host === 'azure-devops' ? `${base}?api-version=${AZURE_DEVOPS_API_VERSION}` : base;
}

/**
 * Four hosts, three spellings of the same field — which is exactly why this is
 * a switch and not a `readString(payload, 'default_branch')` shared by all.
 *
 * - GitHub and GitLab: `default_branch`, a bare branch name.
 * - Bitbucket Cloud: `mainbranch.name` — MEASURED 2026-09-12 against
 *   `api.bitbucket.org/2.0/repositories/atlassian/atlassian-frontend-mirror`,
 *   whose top-level keys do NOT include `default_branch` at all. Had this
 *   stayed one shared read, every Bitbucket install without an explicit ref
 *   would have failed as `plugin.install.repository_ref_unresolved` — a typed
 *   refusal naming the wrong cause.
 * - Azure DevOps: `defaultBranch`, and it is a FULL ref
 *   (`refs/heads/main`) rather than a branch name, so the prefix is stripped
 *   before it reaches a `versionDescriptor.version`
 *   (`rest/api/azure/devops/git/repositories/get-repository`). Read, not
 *   measured — `dev.azure.com` is blocked from this rig.
 */
function readRepositoryDefaultRef(spec: RepositorySpec, payload: Record<string, unknown>): string | undefined {
  switch (spec.host) {
    case 'github':
    case 'gitlab':
      return readString(payload, 'default_branch');
    case 'bitbucket': {
      const mainBranch = payload.mainbranch;
      return isRecord(mainBranch) ? readString(mainBranch, 'name') : undefined;
    }
    case 'azure-devops': {
      const defaultBranch = readString(payload, 'defaultBranch');
      return defaultBranch ? defaultBranch.replace(/^refs\/heads\//, '') : undefined;
    }
  }
}

/**
 * One page of the tag listing, paged the way each host pages.
 *
 * `per_page` is GitHub's and GitLab's; Bitbucket's is `pagelen` (MEASURED
 * 2026-09-12 — its response echoes `pagelen`, and `per_page` is simply ignored,
 * which would have silently capped every listing at Bitbucket's default page
 * size). Azure DevOps's refs listing pages by an opaque `continuationToken`
 * rather than a page number, so it asks once for the whole ceiling this
 * function's two constants already define and the caller stops after one
 * request — a listing longer than that is the same truncation the other three
 * hit at `MAX_REPOSITORY_TAG_PAGES`, not a new one.
 */
function repositoryTagsUrl(spec: RepositorySpec, page: number): string {
  const base = repositoryApiUrl(spec);
  switch (spec.host) {
    case 'github':
      return `${base}/tags?per_page=${REPOSITORY_TAG_PAGE_SIZE}&page=${page}`;
    case 'gitlab':
      return `${base}/repository/tags?per_page=${REPOSITORY_TAG_PAGE_SIZE}&page=${page}`;
    case 'bitbucket':
      return `${base}/refs/tags?pagelen=${REPOSITORY_TAG_PAGE_SIZE}&page=${page}`;
    case 'azure-devops':
      return `${base}/refs?filter=tags&$top=${REPOSITORY_TAG_PAGE_SIZE * MAX_REPOSITORY_TAG_PAGES}`
        + `&api-version=${AZURE_DEVOPS_API_VERSION}`;
  }
}

/**
 * The rows of one tag page, or `undefined` when the payload is not a listing at
 * all — which the caller turns into "the listing could not be read", never into
 * an authoritative "no tags".
 *
 * GitHub and GitLab answer a bare JSON array. Bitbucket wraps it in `values`
 * (MEASURED 2026-09-12: `{ values, pagelen, size, page, next }`) and Azure
 * DevOps in `value` (`rest/api/azure/devops/git/refs/list`). A shared
 * `Array.isArray(payload)` would have read both envelopes as "not a listing"
 * and reported an unreachable listing where the request had in fact succeeded.
 */
function readRepositoryTagPage(spec: RepositorySpec, payload: unknown): unknown[] | undefined {
  if (spec.host === 'github' || spec.host === 'gitlab') {
    return Array.isArray(payload) ? payload : undefined;
  }
  if (!isRecord(payload)) return undefined;
  const rows = spec.host === 'bitbucket' ? payload.values : payload.value;
  return Array.isArray(rows) ? rows : undefined;
}

/**
 * One tag row, in each host's own spelling. Rows without a usable `name` are
 * dropped rather than guessed at.
 *
 * - GitHub: `{ name, commit: { sha } }`; GitLab nests the sha under `commit.id`.
 * - Bitbucket: `{ name, target: { hash } }` — MEASURED 2026-09-12 against
 *   `atlassian/aui`, whose first row is
 *   `{"name": "0.0.0-5-10-0-SNAPSHOT-…", "target": {"hash": "427be59d…"}}`.
 * - Azure DevOps: `{ name: "refs/tags/v1.0.0", objectId, peeledObjectId }`
 *   (`rest/api/azure/devops/git/refs/list`). The `refs/tags/` prefix is stripped
 *   so the name matches the `<plugin>--v<semver>` convention
 *   `version-tags.ts` symbol `pluginVersionTagPrefix` filters on — an unstripped
 *   name would match no plugin and every Azure repository would read as
 *   carrying no tags. `peeledObjectId` is preferred when present because an
 *   ANNOTATED tag's `objectId` is the tag object, not the commit.
 */
function readRepositoryTagRow(spec: RepositorySpec, row: unknown): RepositoryTagRef[] {
  if (!isRecord(row)) return [];
  const rawName = readString(row, 'name');
  if (!rawName) return [];
  if (spec.host === 'azure-devops') {
    const name = rawName.replace(/^refs\/tags\//, '');
    if (!name) return [];
    const commitSha = readString(row, 'peeledObjectId') ?? readString(row, 'objectId');
    return [{ name, ...(commitSha ? { commitSha } : {}) }];
  }
  if (spec.host === 'bitbucket') {
    const target = row.target;
    const commitSha = isRecord(target) ? readString(target, 'hash') : undefined;
    return [{ name: rawName, ...(commitSha ? { commitSha } : {}) }];
  }
  const commit = row.commit;
  const commitSha = isRecord(commit)
    ? readString(commit, 'sha') ?? readString(commit, 'id')
    : undefined;
  return [{ name: rawName, ...(commitSha ? { commitSha } : {}) }];
}

/**
 * P6.577 — the install-time half of `plugins/loading.md#how-claude-code-computes-the-version`.
 *
 * Called with the manifest the format adapter produced, which has already
 * applied step 1 (`plugin.json`'s `version`) and step 2 (the marketplace
 * entry's). A manifest still carrying a PLACEHOLDER at this point declared
 * neither, so the chain continues:
 *
 *  - step 3, "The git commit SHA of the plugin's source" — passed through from
 *    the plan when a caller resolved one. Nothing in this fork does today: a
 *    repository install downloads a tarball through the host's archive endpoint
 *    rather than cloning, so there is no local git directory and `ref` is a
 *    branch name, not a SHA. The null is recorded in `plugin-version-chain.ts`
 *    together with what producing it would cost.
 *  - step 4, "The SHA-256 digest, for `archive` sources: the `sha256` pin in the
 *    marketplace entry, or the digest of the downloaded file when you set no
 *    pin" — the pin arrives as the url source's `expectedHash`; the downloaded
 *    digest is recorded by `fetchArchiveUrlArtifact`.
 *  - step 5, `unknown` — the honest floor, and a DIFFERENT string from the
 *    adapter's `0.0.0` placeholder on purpose: "nothing was declared" and
 *    "nothing is knowable" are different facts.
 *
 * Returns the manifest unchanged whenever a real version was declared, so the
 * overwhelming majority of installs are byte-identical to before.
 */
function resolveInstalledPluginVersion(
  staged: PluginStagedInstall,
  manifest: NessyPluginManifest,
): NessyPluginManifest {
  if (!isPlaceholderPluginVersion(manifest.version)) return manifest;
  const source = staged.plan.source;
  const pinnedDigest = source.kind === 'url' ? source.expectedHash : undefined;
  const version = resolvePluginVersionChain({
    ...(staged.commitSha ? { commitSha: staged.commitSha } : {}),
    archiveDigest: pinnedDigest ?? staged.artifactDigest,
  });
  // The floor is not a change worth rewriting the manifest for when the
  // placeholder already said the same thing in a different spelling — but it IS
  // the page's spelling, and a reader comparing our answer to the page's must
  // find the page's. So it is applied, and the two placeholders are equivalent
  // everywhere that matters through `isPlaceholderPluginVersion`.
  return version === manifest.version ? manifest : { ...manifest, version };
}

export async function createInstallPlanFromSource(
  source: string | PluginInstallSource,
  options: PluginInstallPlanOptions & PluginInstallServiceOptions = {},
): Promise<PluginInstallPlan> {
  return new PluginInstallService(options).createInstallPlanFromSource(source, options);
}

/**
 * `plugins/host-marketplace.md#run-release-channels`'s tag listing, as a module-level wrapper so a
 * composition root can hand `MarketplaceService` the one function it needs
 * without owning an acquisition-service instance. Same defaults (artifact auth
 * provider, fetch seam) as every other wrapper here.
 */
export async function listRepositoryTags(
  repositoryUrl: string,
  options: PluginInstallServiceOptions & { ref?: string; subdirectory?: string } = {},
): Promise<RepositoryTagRef[] | undefined> {
  return new PluginInstallService(options).listRepositoryTags(repositoryUrl, {
    ...(options.ref ? { ref: options.ref } : {}),
    ...(options.subdirectory ? { subdirectory: options.subdirectory } : {}),
  });
}

export async function createInstallPlanFromAgentProposal(
  proposal: PluginAgentInstallProposal,
  options: PluginInstallPlanOptions & PluginInstallServiceOptions = {},
): Promise<PluginAgentInstallProposalResult> {
  return new PluginInstallService(options).createInstallPlanFromAgentProposal(proposal, options);
}

export async function stageInstall(
  plan: PluginInstallPlan,
  options: PluginInstallServiceOptions = {},
): Promise<PluginStagedInstall> {
  return new PluginInstallService(options).stageInstall(plan, options);
}

export async function normalizeStagedInstall(
  staged: PluginStagedInstall,
  options: PluginInstallServiceOptions = {},
): Promise<PluginStagedNormalizationResult> {
  return new PluginInstallService(options).normalizeStagedInstall(staged);
}

interface RepositorySpec {
  host: RepositoryHostKind;
  repositoryUrl: string;
  /** GitHub owner, or Bitbucket workspace. */
  owner?: string;
  repo: string;
  /** GitLab's full namespace path, the id its API encodes. */
  projectPath?: string;
  /** Azure DevOps organization — the first segment of the API route. */
  organization?: string;
  /** Azure DevOps team project — the second. */
  project?: string;
  ref?: string;
  subdirectory?: string;
}

async function extractArchiveFile(
  archivePath: string,
  targetDirectory: string,
  options: { strip: number },
): Promise<void> {
  await mkdir(targetDirectory, { recursive: true });
  const unsafePaths: string[] = [];
  let entryCount = 0;
  let extractedBytes = 0;
  let limitExceeded = false;
  const limitMessage = `Archive exceeds plugin extraction limits (${MAX_PLUGIN_ARCHIVE_ENTRIES} entries, ${MAX_PLUGIN_EXTRACTED_BYTES} bytes).`;
  try {
    await extractTar({
      file: archivePath,
      cwd: targetDirectory,
      strip: options.strip,
      filter(path, entry) {
        if (limitExceeded) return false;
        entryCount += 1;
        extractedBytes += entry.size;
        if (entryCount > MAX_PLUGIN_ARCHIVE_ENTRIES || extractedBytes > MAX_PLUGIN_EXTRACTED_BYTES) {
          limitExceeded = true;
          return false;
        }
        if (isUnsafeArchivePath(path)) {
          unsafePaths.push(path);
          return false;
        }
        return true;
      },
    });
  } catch (error) {
    if (limitExceeded) throw new Error(limitMessage);
    throw error;
  }
  if (limitExceeded) throw new Error(limitMessage);
  if (unsafePaths.length > 0) {
    throw new Error(`Archive entry would escape plugin staging directory: ${unsafePaths.join(', ')}`);
  }
}

/**
 * C3.260 — the SECOND archive format this pipeline speaks, and it exists for
 * exactly one host.
 *
 * Azure DevOps publishes no tarball: its items route serves `$format=zip` and
 * the page says so about that format in terms — *"Doesn't apply to zipped
 * content, which is always returned as a download"*
 * (`rest/api/azure/devops/git/items/get?view=azure-devops-rest-7.1`, fetched
 * 2026-09-12). Every other host here serves a gzipped tar, so this is the
 * narrowest thing that could be added rather than a general capability.
 *
 * **Why not `extractMcpbArchive` or `extractSkillArchiveZip`, both of which
 * already open a zip in this package.** The first REFUSES any archive without a
 * root `manifest.json` and refuses every executable entry that is not a declared
 * binary server — a repository has neither. The second is written to the SKILL
 * caps (`MAX_SKILL_SNAPSHOT_*`), which are much smaller than a repository's, and
 * returns the written entry list its own caller requires. What is shared is the
 * part that must never diverge: containment goes through this file's own
 * {@link isUnsafeArchivePath} and `assertPathInside`, the same two the tar path
 * and the skill path call, and the caps are the PLUGIN caps the tar path
 * enforces — so no archive format reaching this pipeline gets a weaker rule than
 * another.
 *
 * Extracts FLAT, with no `strip`: a zip's wrapping layout is the host's, not
 * ours, and {@link resolveExtractedRepositoryRoot} decides it by looking rather
 * than by assuming.
 */
async function extractRepositoryZip(archivePath: string, targetDirectory: string): Promise<void> {
  await mkdir(targetDirectory, { recursive: true });
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    openZipArchive(archivePath, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (openError, opened) => {
      if (openError || !opened) reject(openError ?? new Error('Repository archive could not be opened.'));
      else resolve(opened);
    });
  });
  let entryCount = 0;
  let extractedBytes = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    zip.on('error', fail);
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on('entry', (entry: ZipEntry) => {
      void (async () => {
        entryCount += 1;
        extractedBytes += Number.isSafeInteger(entry.uncompressedSize) ? entry.uncompressedSize : 0;
        if (entryCount > MAX_PLUGIN_ARCHIVE_ENTRIES || extractedBytes > MAX_PLUGIN_EXTRACTED_BYTES) {
          throw new Error(`Archive exceeds plugin extraction limits (${MAX_PLUGIN_ARCHIVE_ENTRIES} entries, ${MAX_PLUGIN_EXTRACTED_BYTES} bytes).`);
        }
        const path = entry.fileName;
        if (isUnsafeArchivePath(path)) {
          throw new Error(`Archive entry would escape plugin staging directory: ${path}`);
        }
        const unixMode = entry.versionMadeBy >>> 8 === 3 ? entry.externalFileAttributes >>> 16 : 0;
        const fileType = unixMode & 0o170000;
        if (fileType === 0o120000) {
          throw new Error(`Repository archive symlinks are not supported: ${path}`);
        }
        if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) {
          throw new Error(`Repository archive entry type is not supported: ${path}`);
        }
        const targetPath = join(targetDirectory, path);
        assertPathInside(targetDirectory, targetPath);
        if (path.endsWith('/') || fileType === 0o040000) {
          await mkdir(targetPath, { recursive: true });
          zip.readEntry();
          return;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        const stream = await new Promise<Readable>((streamResolve, streamReject) => {
          zip.openReadStream(entry, (streamError, readStream) => {
            if (streamError || !readStream) {
              streamReject(streamError ?? new Error(`Repository archive entry could not be read: ${path}`));
            } else {
              streamResolve(readStream);
            }
          });
        });
        // `wx` also rejects an archive that carries the same path twice.
        await pipeline(stream, createWriteStream(targetPath, {
          flags: 'wx',
          mode: (unixMode & 0o111) !== 0 ? 0o700 : 0o600,
        }));
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

/**
 * Where the repository's own files begin inside an extracted zip.
 *
 * The tar hosts all wrap their content in exactly one directory, which is why
 * `strip: 1` is hard-coded for them and was measured for Bitbucket before it was
 * relied on. **The Azure DevOps zip's layout could not be measured at all** —
 * `dev.azure.com` answers 503 through this network's proxy (2026-09-12) — so
 * rather than guess a `strip`, this looks:
 *
 * 1. A plugin root marker at the top means the content was archived directly,
 *    the same signal {@link detectArchivePluginStrip} reads for a tar.
 * 2. Otherwise a SINGLE top-level directory is a wrapper and the content is
 *    inside it.
 * 3. Otherwise the top level IS the content.
 *
 * Both possible layouts therefore install, and a third one nobody predicted
 * fails loudly (a missing plugin manifest) instead of installing the wrong
 * directory. Prefer this shape to a measured constant for any host this rig
 * cannot reach.
 */
async function resolveExtractedRepositoryRoot(extractDirectory: string): Promise<string> {
  const entries = await readdir(extractDirectory, { withFileTypes: true });
  for (const marker of PLUGIN_ROOT_MARKERS) {
    if (entries.some((entry) => entry.name === marker)) return extractDirectory;
  }
  const [only] = entries;
  if (entries.length === 1 && only?.isDirectory()) return join(extractDirectory, only.name);
  return extractDirectory;
}

function isUnsafeArchivePath(path: string): boolean {
  const parts = path.split(/[\\/]+/);
  return path.startsWith('/') || path.startsWith('\\') || path.includes('\0') || parts.includes('..');
}

/**
 * `plugin-marketplaces.md` § Zip archives (fetched 2026-08-24,
 * `https://code.claude.com/docs/en/plugin-marketplaces.md`): "When you build the
 * zip, you can zip the plugin's contents directly or zip the plugin folder
 * itself. Claude Code looks for `.claude-plugin/` at the top of the archive, then
 * inside a single top-level folder, so both layouts install" — and "Claude Code
 * doesn't look deeper than one folder, so a plugin nested further down fails to
 * install."
 *
 * A plugin-root marker at the archive top means the contents were zipped directly
 * (strip 0). Otherwise the plugin was wrapped in its own folder and the one
 * wrapping segment is stripped (strip 1) — the prior always-on behaviour, and the
 * shape npm tarballs and GitHub/GitLab archives always take. This one path stages
 * Claude, Codex and native bundles, so all three root markers count, not only
 * `.claude-plugin/`.
 */
const PLUGIN_ROOT_MARKERS = new Set(['.claude-plugin', '.codex-plugin', 'plugin.json']);

async function detectArchivePluginStrip(archivePath: string): Promise<0 | 1> {
  const topLevelEntries = new Set<string>();
  await listTar({
    file: archivePath,
    onentry(entry) {
      const first = entry.path.split(/[\\/]+/).find(Boolean);
      if (first) topLevelEntries.add(first);
    },
  });
  for (const marker of PLUGIN_ROOT_MARKERS) {
    if (topLevelEntries.has(marker)) return 0;
  }
  return 1;
}

/**
 * F4. Unpack a market skill's `archive.zip` into the staging skill root, and
 * report which entry paths were written so the caller can require `SKILL.md`.
 *
 * `extractMcpbArchive` cannot serve this: it refuses any archive without a root
 * `manifest.json`, and a skill archive is rooted at `SKILL.md` (live 2026-07-31:
 * 6 entries, `SKILL.md` at the top, no manifest). Its executable-entry rule is
 * also defined against an MCPB manifest's declared binary server, which a skill
 * does not have.
 *
 * What is deliberately NOT re-written here is path safety. Containment goes
 * through this file's own `isUnsafeArchivePath` and `assertPathInside` — the
 * same two functions the per-file listing path calls on every entry — so the two
 * market transports cannot drift apart on traversal. The caps are likewise the
 * skill-snapshot caps the per-file path already enforces, and symlinks and every
 * non-regular entry type are refused.
 *
 * Measured while gating this: under `decodeStrings: true` yauzl's own
 * `validateFileName` already refuses a `..` segment, a backslash and an absolute
 * or drive-letter name before an entry is ever emitted (`../escape.md` →
 * "invalid relative path"), so no test can distinguish those two calls from the
 * library's check. They are kept as the seatbelt for that option changing, not
 * as the only line — and they are the reason this extractor cannot silently
 * diverge from the per-file path's containment rule.
 */
async function extractSkillArchiveZip(archivePath: string, skillRoot: string): Promise<Set<string>> {
  await mkdir(skillRoot, { recursive: true });
  const written = new Set<string>();
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    openZipArchive(archivePath, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (openError, opened) => {
      if (openError || !opened) reject(openError ?? new Error('Market skill archive could not be opened.'));
      else resolve(opened);
    });
  });
  let entryCount = 0;
  let totalBytes = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    zip.on('error', fail);
    zip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    zip.on('entry', (entry: ZipEntry) => {
      void (async () => {
        entryCount += 1;
        if (entryCount > MAX_SKILL_SNAPSHOT_FILES) {
          throw new Error(`Market skill archive exceeds ${MAX_SKILL_SNAPSHOT_FILES} entries.`);
        }
        const path = entry.fileName;
        if (isUnsafeArchivePath(path)) {
          throw new Error(`Market skill archive entry would escape the staging directory: ${path}`);
        }
        const unixMode = entry.versionMadeBy >>> 8 === 3 ? entry.externalFileAttributes >>> 16 : 0;
        const fileType = unixMode & 0o170000;
        if (fileType === 0o120000) {
          throw new Error(`Market skill archive symlinks are not supported: ${path}`);
        }
        if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) {
          throw new Error(`Market skill archive entry type is not supported: ${path}`);
        }
        const targetPath = join(skillRoot, path);
        assertPathInside(skillRoot, targetPath);
        if (path.endsWith('/') || fileType === 0o040000) {
          await mkdir(targetPath, { recursive: true });
          zip.readEntry();
          return;
        }
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > MAX_SKILL_SNAPSHOT_FILE_BYTES) {
          throw new Error(`Market skill archive entry exceeds the ${MAX_SKILL_SNAPSHOT_FILE_BYTES}-byte limit: ${path}`);
        }
        totalBytes += entry.uncompressedSize;
        if (totalBytes > MAX_SKILL_SNAPSHOT_TOTAL_BYTES) {
          throw new Error('Market skill archive exceeds the extraction size cap.');
        }
        await mkdir(dirname(targetPath), { recursive: true });
        const stream = await new Promise<Readable>((streamResolve, streamReject) => {
          zip.openReadStream(entry, (streamError, readStream) => {
            if (streamError || !readStream) {
              streamReject(streamError ?? new Error(`Market skill archive entry could not be read: ${path}`));
            } else {
              streamResolve(readStream);
            }
          });
        });
        // `wx` also rejects an archive that carries the same path twice.
        await pipeline(stream, createWriteStream(targetPath, {
          flags: 'wx',
          mode: (unixMode & 0o111) !== 0 ? 0o700 : 0o600,
        }));
        written.add(path);
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
  return written;
}

/** Which rule matched, so the install log can say how a version was reached. */
export type NpmVersionMatchRule = 'exact' | 'widened-within-base' | 'dist-tag-latest';

export interface NpmVersionSelection {
  version: string;
  rule: NpmVersionMatchRule;
  info: Record<string, unknown>;
}

/**
 * Resolve the version an install should actually fetch.
 *
 * An exact key lookup was not enough against the real registry. The marketplace
 * advertises `1.0.9` for `@ai-office/nessy-extension-nestor-nessy-default-extension`
 * and Artifactory publishes no plain `1.0.9` at all — only
 * `1.0.9-source.20260716152955.45c8ba6c7514`, the CI build stamp for that same
 * release — so the install failed with `npm_version_missing` on a version the
 * catalog itself advertised. (nessy-cli sidesteps this by pinning no version and
 * taking `dist-tags.latest`; we keep the pin and make it resolvable.)
 *
 * Ordered, and the matched rule is recorded on the resolution:
 *
 * 1. `exact` — the requested version is published;
 * 2. `widened-within-base` — the HIGHEST published build named
 *    `<requested>-…` whose major.minor.patch still equals the request, ordered
 *    by `semver.rcompare`. A `-source.<timestamp>.<sha>` stamp is the same
 *    release, and semver ordering is what makes `-source.10.x` beat
 *    `-source.9.x` where a string sort would not. A candidate whose version
 *    will not parse as semver is refused;
 * 3. `dist-tag-latest` — when nothing was requested at all.
 *
 * A different base version is never substituted. Requesting `2.0.0` against
 * metadata whose `dist-tags.latest` is `1.0.9-…` refuses rather than installing
 * a different release.
 *
 * **This is a narrow, documented exception to the repo's default**, not a
 * general prerelease opt-in: `dependencies.ts:123` resolves plugin dependency
 * ranges with `includePrerelease: false` and stays that way. The exception is
 * scoped to an EXACT requested version whose own base is being matched — never
 * to a range, and never across bases.
 */
export function selectNpmVersionName(
  metadata: unknown,
  requestedVersion?: string,
): NpmVersionSelection | undefined {
  if (!isRecord(metadata)) return undefined;
  const versions = isRecord(metadata.versions) ? metadata.versions : undefined;
  if (!versions) return undefined;
  const distTagLatest = isRecord(metadata['dist-tags'])
    ? readString(metadata['dist-tags'], 'latest')
    : undefined;
  const published = (name: string | undefined): name is string => (
    !!name && isRecord(versions[name])
  );

  if (!requestedVersion) {
    return published(distTagLatest)
      ? { version: distTagLatest, rule: 'dist-tag-latest', info: {} }
      : undefined;
  }
  if (published(requestedVersion)) {
    return { version: requestedVersion, rule: 'exact', info: {} };
  }

  const requested = parseSemver(requestedVersion);
  if (!requested) return undefined;
  // A CI stamp is the REQUESTED version with a suffix — `1.0.9` →
  // `1.0.9-source.<ts>.<sha>`, and equally `1.0.3-beta.0` →
  // `1.0.3-beta.0-source.<ts>.<sha>`, which is why the test is a prefix of the
  // request itself rather than "any prerelease sharing the base". The
  // difference is load-bearing in both directions: it admits a stamp on a
  // PRERELEASE base (3 live catalog rows are published only that way), and it
  // still refuses `1.0.3-beta.1` for a requested `1.0.3-beta.0` — a different
  // build, not a stamp of this one. The base equality below is the belt: a
  // candidate that will not parse, or that somehow lands on another release,
  // is not a build of what was asked for.
  const stampPrefix = `${requestedVersion}-`;
  const widened = Object.keys(versions)
    .filter(name => {
      if (!name.startsWith(stampPrefix) || !isRecord(versions[name])) return false;
      const parsed = parseSemver(name);
      return !!parsed
        && parsed.major === requested.major
        && parsed.minor === requested.minor
        && parsed.patch === requested.patch;
    })
    .sort(rcompare);
  const highest = widened[0];
  if (highest) {
    return { version: highest, rule: 'widened-within-base', info: { candidates: widened.length } };
  }

  // Rule 3 is reachable only for an UNPINNED request (handled above): once a
  // version is pinned, rules 1 and 2 already cover every string `latest` could
  // legally be for that same release, so falling through to the tag could only
  // ever cross into a different one. Left explicit rather than removed so the
  // ordering the plan specifies stays readable.
  return undefined;
}

function parseSemver(value: string): SemVer | null {
  try {
    return parseSemverStrict(value);
  } catch {
    return null;
  }
}

/**
 * A digest we cannot evaluate is a FAILED verification, not a passed one.
 *
 * This used to `return undefined` on anything that was not `sha256/384/512-`,
 * and `undefined` is the caller's "nothing wrong with this artifact" — so
 * `sha1-`, `md5-` or a malformed string turned the check OFF on the one field
 * the registry metadata controls. `verifyExpectedHash` below never had that
 * hole: an unrecognized prefix there falls through to sha256 and mismatches,
 * which fails closed. This is now the same direction.
 *
 * Measured against the real registry 2026-07-31: every one of the 8 published
 * versions of `@ai-office/nessy-extension-nestor-nessy-default-extension`
 * carries `dist.integrity` as `sha512-…`, so an algorithm we do not recognize
 * means the metadata is not the metadata we install against.
 */
function verifyIntegrity(bytes: Buffer, integrity: string, details: Record<string, unknown>): PluginDiagnostic | undefined {
  const normalized = integrity.trim();
  const match = normalized.match(/^(sha(?:256|384|512))-(.+)$/);
  if (!match) {
    const separator = normalized.indexOf('-');
    return pluginDiagnostic(
      'error',
      'plugin.install.integrity_algorithm_unsupported',
      'Downloaded marketplace artifact declares an integrity digest this app cannot verify.',
      undefined,
      { ...details, algorithm: separator > 0 ? normalized.slice(0, separator) : 'unknown' },
    );
  }
  const [, algorithm, expected] = match;
  if (!algorithm || !expected) return undefined;
  const actual = createHash(algorithm).update(bytes).digest('base64');
  if (actual === expected) return undefined;
  return pluginDiagnostic(
    'error',
    'plugin.install.integrity_mismatch',
    'Downloaded marketplace artifact integrity does not match the expected digest.',
    undefined,
    { ...details, algorithm, expected, actual },
  );
}

/**
 * `dist.shasum` is npm's legacy SHA-1 hex digest, published alongside
 * `integrity` on every version this registry serves. SHA-1 is a TRANSPORT
 * check — it catches a truncated or corrupted download, not a deliberate
 * substitution — so it is consulted only when `integrity` is absent and is
 * never persisted as the pinned digest a repair verifies against.
 */
function verifyDistShasum(bytes: Buffer, shasum: string, details: Record<string, unknown>): PluginDiagnostic | undefined {
  const expected = shasum.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expected)) {
    return pluginDiagnostic(
      'error',
      'plugin.install.integrity_algorithm_unsupported',
      'Downloaded marketplace artifact declares a legacy shasum this app cannot verify.',
      undefined,
      { ...details, algorithm: 'sha1' },
    );
  }
  const actual = createHash('sha1').update(bytes).digest('hex');
  if (actual === expected) return undefined;
  return pluginDiagnostic(
    'error',
    'plugin.install.integrity_mismatch',
    'Downloaded marketplace artifact integrity does not match the expected digest.',
    undefined,
    { ...details, algorithm: 'sha1', expected, actual },
  );
}

function verifyExpectedHash(bytes: Buffer, expectedHash: string, details: Record<string, unknown>): PluginDiagnostic | undefined {
  const normalized = expectedHash.trim();
  const algorithm = normalized.startsWith('sha512-') ? 'sha512' : 'sha256';
  const expected = normalized.startsWith('sha512-') ? normalized.slice('sha512-'.length) : normalized.replace(/^sha256-/, '');
  const actual = algorithm === 'sha512'
    ? createHash('sha512').update(bytes).digest('hex')
    : createHash('sha256').update(bytes).digest('hex');
  if (actual === expected) return undefined;
  return pluginDiagnostic(
    'error',
    'plugin.install.hash_mismatch',
    'Downloaded marketplace artifact hash does not match the expected digest.',
    undefined,
    { ...details, algorithm, expected, actual },
  );
}

function normalizeRepositorySpec(
  repositoryUrl: string,
  requestedRef?: string,
  requestedSubdirectory?: string,
): RepositorySpec | null {
  try {
    const url = new URL(repositoryUrl);
    const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (repositoryHostKind(url.hostname) === 'github' && segments.length >= 2) {
      const [owner, rawRepo, marker, ref, ...subdirectoryParts] = segments;
      if (!owner || !rawRepo) return null;
      const repo = rawRepo.replace(/\.git$/, '');
      return {
        host: 'github',
        repositoryUrl: `${url.origin}/${owner}/${repo}`,
        owner,
        repo,
        ref: requestedRef ?? (marker === 'tree' ? ref : undefined),
        subdirectory: requestedSubdirectory ?? (marker === 'tree' && subdirectoryParts.length ? subdirectoryParts.join('/') : undefined),
      };
    }
    if (repositoryHostKind(url.hostname) === 'gitlab' && segments.length >= 2) {
      const markerIndex = segments.indexOf('-');
      const repoSegments = markerIndex >= 0 ? segments.slice(0, markerIndex) : segments;
      const marker = markerIndex >= 0 ? segments[markerIndex + 1] : undefined;
      const ref = marker === 'tree' ? segments[markerIndex + 2] : undefined;
      const subdirectoryParts = marker === 'tree' ? segments.slice(markerIndex + 3) : [];
      if (repoSegments.length < 2) return null;
      const projectPath = repoSegments.join('/').replace(/\.git$/, '');
      const repo = repoSegments[repoSegments.length - 1]?.replace(/\.git$/, '') ?? 'repository';
      return {
        host: 'gitlab',
        repositoryUrl: `${url.origin}/${projectPath}`,
        repo,
        projectPath,
        ref: requestedRef ?? ref,
        subdirectory: requestedSubdirectory ?? (subdirectoryParts.length ? subdirectoryParts.join('/') : undefined),
      };
    }
    // C3.260 — Bitbucket and Azure DevOps share ONE parser
    // (`repository-hosts.ts`), because the two shapes above are each spelled in
    // three files and a fourth copy per host is how the routes drift apart.
    const added = parseBitbucketOrAzureRepositoryUrl(url);
    if (added) {
      return {
        host: added.kind,
        repositoryUrl: added.repositoryUrl,
        repo: added.repo,
        ...(added.owner ? { owner: added.owner } : {}),
        ...(added.organization ? { organization: added.organization } : {}),
        ...(added.project ? { project: added.project } : {}),
        ref: requestedRef ?? added.ref,
        subdirectory: requestedSubdirectory ?? added.subdirectory,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The metadata base each host hangs its default-branch and tag routes off.
 *
 * Bitbucket is the only one whose API lives on a DIFFERENT ORIGIN from the
 * repository URL — `api.bitbucket.org`, not `bitbucket.org` — which is why the
 * self-hosted-declaration escape hatch `NESSY_PLUGIN_GITLAB_HOSTS` opens for
 * GitLab and not for it.
 */
function repositoryApiUrl(spec: RepositorySpec): string {
  switch (spec.host) {
    case 'github':
      return `https://api.github.com/repos/${spec.owner}/${spec.repo}`;
    case 'bitbucket':
      // Measured 2026-09-12: `GET /2.0/repositories/atlassian/atlassian-frontend-mirror`
      // → 200 `application/json`, carrying `mainbranch: { name: "master" }`.
      return `https://api.bitbucket.org/2.0/repositories/${spec.owner}/${spec.repo}`;
    case 'azure-devops':
      // `rest/api/azure/devops/git/repositories/get-repository?view=azure-devops-rest-7.1`:
      // `GET https://dev.azure.com/{organization}/{project}/_apis/git/repositories/{repositoryId}?api-version=7.1`.
      // Read, not measured — `dev.azure.com` is blocked from this rig.
      return `${new URL(spec.repositoryUrl).origin}/${spec.organization}/${spec.project}/_apis/git/repositories/${encodeURIComponent(spec.repo)}`;
    case 'gitlab':
      return `${new URL(spec.repositoryUrl).origin}/api/v4/projects/${encodeURIComponent(spec.projectPath ?? spec.repo)}`;
  }
}

/**
 * A3. GitLab's Rails WEB route is not an API and does not behave like one.
 *
 * Probed anonymously against `gitlab.tcsbank.ru` on 2026-07-31,
 * `/<project>/-/archive/master/<repo>-master.tar.gz` answers **302 with
 * `content-type: text/html`**, redirecting to `/users/sign_in` — so the tar
 * extractor is handed a sign-in page and fails opaquely. **Positive control,
 * same host, same minute:** the documented API route
 * `/api/v4/projects/<encoded>/repository/archive.tar.gz?sha=master` answers
 * **404 `application/json`** (`{"message":"404 Project Not Found"}`). It also
 * fails anonymously — the project is private — but it fails TYPED instead of
 * returning HTML, which is the whole difference, and it takes the same token
 * auth `gitLabApiRawUrl` already relies on for files.
 *
 * `path=` is a download-size win only: GitLab keeps the full
 * `<project>-<ref>-<sha>/<path>/…` prefix inside a path-filtered archive, so the
 * extract-then-copy branch in `fetchRepositoryArtifact` is unchanged.
 */
function repositoryArchiveUrls(spec: RepositorySpec, ref: string): string[] {
  switch (spec.host) {
    case 'github':
      // GitHub's generic archive route accepts branches, tags, and commit SHAs.
      // The refs/heads route rejects pinned commits and tags.
      return [`${spec.repositoryUrl}/archive/${encodeURIComponent(ref)}.tar.gz`];
    case 'bitbucket':
      // Measured 2026-09-12 against `atlassian/atlassian-frontend-mirror`:
      // `GET bitbucket.org/<ws>/<repo>/get/master.tar.gz` → 200
      // `application/x-tar-gz`, no redirect, unpacking under exactly one
      // top-level directory `<ws>-<repo>-<12-hex>/` (plus a `pax_global_header`
      // the tar reader consumes), so `strip: 1` is right here for the same
      // reason it is right for GitHub and GitLab. Like GitHub's, this route
      // takes a branch, a tag or a commit in the same slot, so there is one
      // candidate.
      return [`${spec.repositoryUrl}/get/${encodeURIComponent(ref)}.tar.gz`];
    case 'azure-devops':
      return azureDevOpsArchiveUrls(spec, ref);
    case 'gitlab': {
      const archiveUrl = new URL(`${repositoryApiUrl(spec)}/repository/archive.tar.gz`);
      archiveUrl.searchParams.set('sha', ref);
      if (spec.subdirectory) archiveUrl.searchParams.set('path', spec.subdirectory);
      return [archiveUrl.toString()];
    }
  }
}

/** `rest/api/azure/devops/git/items/get`'s pinned version, in one place. */
const AZURE_DEVOPS_API_VERSION = '7.1';

/**
 * Azure DevOps is the ONE host here that cannot be addressed with a bare ref,
 * and that is why this returns a LIST where every other host returns one URL.
 *
 * `versionDescriptor.versionType` is an enum — `branch`, `tag` or `commit`
 * (`rest/api/azure/devops/git/items/get?view=azure-devops-rest-7.1`) — where
 * GitHub's `/archive/<ref>` and GitLab's `sha=<ref>` each accept all three in
 * one slot. A ref reaching this function is a bare string: it is whatever the
 * entry declared, or a `#ref` pin, or the tag name a version-constrained
 * dependency resolved to (`marketplace/service.ts` symbol `withDependencyRef`
 * pins the resolved TAG, not its commit). Nothing in that string says which
 * namespace it lives in.
 *
 * So the namespace is derived, transparently, and the derivation is a rule
 * rather than a guess:
 *
 * - 40 hex characters is a commit SHA and can be nothing else → one candidate.
 * - Anything else is tried as a BRANCH first — the documented default and the
 *   overwhelmingly common case, since an unpinned install resolves the default
 *   branch — and then as a TAG, which is the only other namespace a plugin
 *   source can name. The second request is made only after the first has
 *   FAILED, so the ordinary path still costs exactly one request, and a failed
 *   attempt writes nothing (`downloadArtifact` writes the file only on a
 *   successful, non-HTML response).
 *
 * The alternative — one extra `_apis/git/repositories/{id}/refs?filter=…` call
 * per install to learn the namespace — costs a request on the SUCCESS path
 * instead of the failure path, for the same answer. Recorded here rather than
 * built, since neither can be measured from this rig: `dev.azure.com` answers
 * 503 through this network's proxy (2026-09-12).
 *
 * `path=/` asks for the whole repository rather than `spec.subdirectory`,
 * matching what GitHub does: the subdirectory is applied by the caller's
 * extract-then-copy branch, which is the only one of the two that works for
 * every host.
 */
function azureDevOpsArchiveUrls(spec: RepositorySpec, ref: string): string[] {
  const versionTypes = /^[0-9a-f]{40}$/i.test(ref) ? ['commit'] : ['branch', 'tag'];
  // Built by hand rather than through `URLSearchParams` so `$format` reaches the
  // server spelled the way the page spells it, instead of as `%24format`.
  return versionTypes.map((versionType) => `${repositoryApiUrl(spec)}/items`
    + '?path=%2F'
    + '&$format=zip'
    + '&download=true'
    + `&versionDescriptor.versionType=${versionType}`
    + `&versionDescriptor.version=${encodeURIComponent(ref)}`
    + `&api-version=${AZURE_DEVOPS_API_VERSION}`);
}

/**
 * Which extractor the host's archive route needs.
 *
 * Azure DevOps is the only `zip` in this module, and not by choice: its items
 * route publishes no tar at all — *"Doesn't apply to zipped content, which is
 * always returned as a download"* (`rest/api/azure/devops/git/items/get`,
 * fetched 2026-09-12) is the page describing `$format=zip` as the one archive
 * shape it serves.
 */
function repositoryArchiveFormat(spec: RepositorySpec): 'tar' | 'zip' {
  return spec.host === 'azure-devops' ? 'zip' : 'tar';
}

function gitLabRawUrl(url: string, ref?: string, path?: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/-/blob/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      const blobParts = parts[1].split('/').filter(Boolean);
      const blobRef = ref ?? blobParts.shift();
      const blobPath = path ?? blobParts.join('/');
      if (blobRef && blobPath) {
        parsed.pathname = `${parts[0]}/-/raw/${blobRef}/${blobPath}`;
        return parsed.toString();
      }
    }
  } catch {
    return url;
  }
  return url;
}

function gitLabApiRawUrl(url: string, ref?: string, path?: string): string | undefined {
  const parsed = parseGitLabFileUrl(url, ref, path);
  if (!parsed || !isInternalGitLabHost(parsed.hostname)) return undefined;
  const apiUrl = new URL(`https://${parsed.hostname}/api/v4/projects/${encodeURIComponent(parsed.projectPath)}/repository/files/${encodeURIComponent(parsed.filePath)}/raw`);
  apiUrl.searchParams.set('ref', parsed.ref);
  return apiUrl.toString();
}

function parseGitLabFileUrl(url: string, ref?: string, path?: string): { hostname: string; projectPath: string; ref: string; filePath: string } | undefined {
  try {
    const parsed = new URL(url);
    const marker = parsed.pathname.includes('/-/blob/') ? '/-/blob/' : parsed.pathname.includes('/-/raw/') ? '/-/raw/' : undefined;
    if (!marker) return undefined;
    const [projectPart, filePart] = parsed.pathname.split(marker);
    if (!projectPart || !filePart) return undefined;
    const fileParts = filePart.split('/').filter(Boolean);
    const fileRef = ref ?? fileParts.shift();
    const filePath = path ?? fileParts.join('/');
    if (!fileRef || !filePath) return undefined;
    return {
      hostname: parsed.hostname,
      projectPath: decodeURIComponent(projectPart.replace(/^\/+/, '').replace(/\/+$/, '')),
      ref: decodeURIComponent(fileRef),
      filePath: decodeURIComponent(filePath),
    };
  } catch {
    return undefined;
  }
}

// Bounded pre-trust download caps for the market per-file skill snapshot.
const MAX_SKILL_SNAPSHOT_FILES = 256;
const MAX_SKILL_SNAPSHOT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_SKILL_SNAPSHOT_TOTAL_BYTES = 32 * 1024 * 1024;
// `plugin-marketplaces.md` § Zip archives (fetched 2026-08-24,
// `https://code.claude.com/docs/en/plugin-marketplaces.md`): "Claude Code
// refuses archives larger than 256 MiB." That sentence bounds the downloaded
// ARCHIVE file, which is this cap (checked against `content-length` and the
// running byte total in `downloadArtifact`). `MAX_PLUGIN_EXTRACTED_BYTES` below
// governs a different quantity — the sum of uncompressed entry sizes, a
// zip-bomb bound — and stays where it was.
const MAX_PLUGIN_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_ENTRIES = 10_000;
const MAX_PLUGIN_EXTRACTED_BYTES = 256 * 1024 * 1024;

// Browsers cap a redirect chain at 20 hops; the same ceiling keeps a
// redirect loop from spinning forever before the guard or the server ends it.
const MAX_ARTIFACT_REDIRECTS = 20;

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function artifactRedirectRefused(
  url: string,
  redirectTarget: string,
  reason: string,
): ArtifactFetchResult & { bytes: Buffer } {
  return {
    bytes: Buffer.alloc(0),
    diagnostics: [pluginDiagnostic(
      'error',
      'plugin.install.artifact_redirect_unsafe',
      `Plugin archive download refused a redirect to a URL that is not a public HTTPS URL: ${reason}.`,
      undefined,
      { url, redirectTarget, reason },
    )],
  };
}

function artifactTooLarge(url: string): ArtifactFetchResult & { bytes: Buffer } {
  return {
    bytes: Buffer.alloc(0),
    diagnostics: [pluginDiagnostic(
      'error',
      'plugin.install.artifact_too_large',
      `Plugin artifact exceeds the ${MAX_PLUGIN_ARTIFACT_BYTES}-byte download limit.`,
      undefined,
      { url, maxBytes: MAX_PLUGIN_ARTIFACT_BYTES },
    )],
  };
}

/**
 * The ONE host whose requests carry the user's internal DP token.
 *
 * C3.190 widened `repositoryHostKind` (`./repository-hosts.ts`) so a
 * self-hosted GitLab resolves and fetches; it deliberately did NOT widen this.
 * Admitting a host means we will try a public REST route against it — not that
 * we will authenticate to it — and the two questions must stay apart, because
 * an operator adding a hostname to `NESSY_PLUGIN_GITLAB_HOSTS` is declaring a
 * route, never handing it a credential.
 */
const INTERNAL_GITLAB_HOST = 'gitlab.tcsbank.ru';

function isInternalGitLabHost(hostname: string): boolean {
  return hostname === INTERNAL_GITLAB_HOST;
}

class DpGitLabArtifactAuthProvider implements PluginArtifactAuthProvider {
  constructor(private readonly broker: DpSessionBroker) {}

  async fetchArtifact(url: URL, fetchImpl: typeof fetch, init?: RequestInit): Promise<Response> {
    if (!isInternalGitLabHost(url.hostname)) return fetchImpl(url, init);
    try {
      return await this.broker.withAccessToken(async (token) =>
        // MERGED, not replaced. A marketplace entry hosted on internal GitLab
        // may declare its own archive `headers`; replacing `init.headers`
        // wholesale dropped them without a word, which is the same silent
        // credential loss this row exists to close. The host's own token wins a
        // name collision — it is the credential the user actually holds, and a
        // catalog row must not be able to override it.
        fetchImpl(url, { ...init, headers: { ...headerRecord(init?.headers), ...gitLabAuthHeaders(token) } }),
      );
    } catch (error) {
      if (error instanceof DpAuthServiceError && error.code === DpAuthError.NeedsLogin) {
        return fetchImpl(url, init);
      }
      throw error;
    }
  }
}

/** `RequestInit['headers']` in the one shape this file ever constructs. */
function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  // `Headers.entries()` exists at runtime everywhere we run, but its type is only
  // declared under the DOM lib — and pi-agent-server's tsconfig does not load it, so
  // spreading it typechecks in `shared` and goes red there. `forEach` is declared in
  // both libs and takes (value, name) — note the order, which is the reverse of the
  // [name, value] pairs every other arm of this function produces.
  const fromHeaders: Array<[unknown, unknown]> = [];
  if (headers instanceof Headers) headers.forEach((value, name) => fromHeaders.push([name, value]));
  const entries: Array<[unknown, unknown]> = headers instanceof Headers
    ? fromHeaders
    : Array.isArray(headers)
      ? (headers as Array<[unknown, unknown]>)
      : Object.entries(headers as Record<string, unknown>);
  const record: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (typeof name === 'string' && typeof value === 'string') record[name] = value;
  }
  return record;
}

function gitLabAuthHeaders(token: string): Record<string, string> {
  if (token.startsWith('ory_at_') || token.startsWith('oauth_')) {
    return { Authorization: `Bearer ${token}` };
  }
  return { 'PRIVATE-TOKEN': token };
}

function findUnavailableRelativeReferences(content: string): string[] {
  const references = new Set<string>();
  const linkPattern = /!?\[[^\]]*]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(content)) !== null) {
    const target = match[1]?.trim();
    if (!target || isExternalReference(target)) continue;
    references.add(target);
  }
  return [...references].sort();
}

function isExternalReference(target: string): boolean {
  return target.startsWith('#')
    || target.startsWith('/')
    || /^[a-z][a-z0-9+.-]*:/i.test(target);
}

/**
 * A market skill's per-file listing URL is
 * `<apiBase>/v2/skills/<skillId>/snapshots/<snapshotId>/files`, so it already
 * carries everything the v2 skill endpoints need. Derived from the artifact
 * rather than from a configured base URL because a bring-your-own registry can
 * serve the same shape from another host, and the install must talk to the host
 * the listing actually came from.
 */
function parseMarketSkillEndpoint(
  filesUrl: string,
): { baseUrl: string; skillId: string; snapshotId?: string } | undefined {
  try {
    const url = new URL(filesUrl);
    const apiBaseEnd = url.href.indexOf('/v2/');
    if (apiBaseEnd <= 0) return undefined;
    const segments = url.pathname.split('/').filter(Boolean);
    const skillsIndex = segments.indexOf('skills');
    const skillId = skillsIndex >= 0 ? segments[skillsIndex + 1] : undefined;
    if (!skillId) return undefined;
    const snapshotsIndex = segments.indexOf('snapshots');
    const snapshotId = snapshotsIndex >= 0 ? segments[snapshotsIndex + 1] : undefined;
    return {
      baseUrl: url.href.slice(0, apiBaseEnd),
      skillId: decodeURIComponent(skillId),
      ...(snapshotId ? { snapshotId: decodeURIComponent(snapshotId) } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * A8, re-shaped. **A warning, never a refusal** — and the refusal it replaces is
 * the point of the row.
 *
 * The original asked us to refuse a derived coordinate whose package does not
 * correspond to the listing's `path`. Measured across the live catalog that gate
 * is unsatisfiable: of the 88 derived rows, `repository.url` is populated on 18
 * (12 agree, 6 disagree), **empty (`{"type":"","url":""}`) on 68**, and the
 * package 404s on 2. A hard gate refuses 68 of 88 and undoes most of A2's
 * measured 12 → 116.
 *
 * Worse, the 6 disagreements are verifiably the CORRECT packages — their
 * `repository` is inherited from the template repo the extension was copied out
 * of, so it records authorship, not identity.
 *
 * So: say something when the field is populated AND disagrees, naming both, and
 * say nothing when it is empty, which is the common case. The seatbelt A8
 * actually wanted is A2's `widened-within-base`, which ties the derived package
 * to the listing's own advertised version base — a field that IS published on
 * essentially every row.
 *
 * Scoped to derived coordinates: a row that published its own install command
 * stated its identity, and is untouched.
 */
function derivedCoordinateRepositoryDiagnostics(
  source: PluginInstallSource,
  versionInfo: Record<string, unknown>,
  details: Record<string, unknown>,
): PluginDiagnostic[] {
  if (source.kind !== 'marketplace-npm-package' || !source.derivedCoordinates) return [];
  const listingPath = source.marketplace?.sourceUrl;
  const declaredRepository = readRepositoryUrl(versionInfo.repository);
  if (!listingPath || !declaredRepository) return [];
  if (repositoryCoordinatesAgree(declaredRepository, listingPath)) return [];
  return [pluginDiagnostic(
    'warning',
    'plugin.install.derived_repository_mismatch',
    `The package resolved for this listing declares a different repository than the listing points at. `
      + `This is usually a template repository the extension was copied out of, and the install continues.`,
    undefined,
    { ...details, declaredRepository, listingPath },
  )];
}

/** npm allows `repository` as a bare string or as `{ type, url }`. */
function readRepositoryUrl(repository: unknown): string | undefined {
  const raw = typeof repository === 'string'
    ? repository
    : isRecord(repository) ? readString(repository, 'url') : undefined;
  return raw?.trim() ? raw.trim() : undefined;
}

function repositoryCoordinatesAgree(declaredRepository: string, listingPath: string): boolean {
  const declared = normalizeRepositoryCoordinate(declaredRepository);
  const listing = normalizeRepositoryCoordinate(listingPath);
  if (!declared || !listing) return true;
  return declared.startsWith(listing) || listing.startsWith(declared);
}

/**
 * `host/group/project`, comparable across the shapes both fields really take:
 * `git+https://…​.git`, a bare `https://…`, and a listing path that continues
 * into `/-/tree/<ref>/<subdirectory>` past the project itself.
 */
function normalizeRepositoryCoordinate(value: string): string {
  const withoutScheme = value
    .trim()
    .toLowerCase()
    .replace(/^git\+/, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^git@([^:]+):/, '$1/');
  const [beforeMarker = ''] = withoutScheme.split('/-/');
  return beforeMarker.replace(/\.git$/, '').replace(/\/+$/, '');
}

/**
 * The one host whose install counter may see a bearer token. Compared as a whole
 * API base, not a hostname substring, so a lookalike path on the same host is
 * still not the Skills Market.
 */
function isSkillsMarketApiBase(baseUrl: string): boolean {
  return trimTrailingSlash(baseUrl) === trimTrailingSlash(DEFAULT_SKILLS_MARKET_API_BASE_URL);
}

/**
 * F3. The immutable revision identity of a market skill install, on the origin
 * because the origin is what the installed record persists. `snapshotId` is what
 * a later staleness check compares against `/releases/latest`; `contentDigest`
 * and `sourceCommit` are what let a human see WHAT changed rather than only
 * that something did.
 */
function stampMarketSkillSnapshot(staged: PluginStagedInstall, snapshot: MarketplaceSkillSnapshot): void {
  staged.plan.origin = {
    ...staged.plan.origin,
    provenance: {
      ...(staged.plan.origin.provenance ?? {}),
      snapshotId: snapshot.snapshotId,
      artifactId: snapshot.artifactId,
      ...(snapshot.contentDigest ? { contentDigest: snapshot.contentDigest } : {}),
      ...(snapshot.sourceCommit ? { sourceCommit: snapshot.sourceCommit } : {}),
      ...(snapshot.lifecycle ? { snapshotLifecycle: snapshot.lifecycle } : {}),
    },
  };
}

/**
 * E6. The install record must name what was actually installed.
 *
 * `provenance.version` used to keep the ADVERTISED string — the one the catalog
 * row carries — so `reconstructInstallSource` handed Repair the advertised
 * version and Repair re-entered the A2 ladder. Between the two runs the
 * registry can publish a newer build stamp of the same base, and
 * `widened-within-base` takes the HIGHEST one: repair then reproduces a
 * different artifact than the one on disk. Compounding it, no digest was
 * persisted from the resolved dist at all, so the install was never byte-pinned
 * in the first place and "reproducible" meant reproducible-by-name.
 *
 * Both fields now come from the artifact we actually verified, and the
 * advertised string is kept beside them because it is the only thing that joins
 * the record back to the catalog row a human reads.
 *
 * The digest is the verified `dist.integrity` ONLY. `dist.shasum` is sha1, and
 * A9 made an unrecognized algorithm a hard refusal on the verify path — so
 * persisting `sha1-…` here would make a later repair of this same plugin fail
 * with `integrity_algorithm_unsupported`.
 */
function stampResolvedNpmProvenance(
  staged: PluginStagedInstall,
  resolution: { resolvedVersion: string; advertisedVersion?: string; integrity?: string },
): void {
  staged.plan.origin = {
    ...staged.plan.origin,
    provenance: {
      ...(staged.plan.origin.provenance ?? {}),
      version: resolution.resolvedVersion,
      ...(resolution.advertisedVersion ? { advertisedVersion: resolution.advertisedVersion } : {}),
      ...(resolution.integrity ? { integrity: resolution.integrity } : {}),
    },
  };
}

async function writeMarketplaceMetadataSnapshot(staged: PluginStagedInstall): Promise<void> {
  const marketplace = marketplaceMetadataForSource(staged.plan.source);
  if (!marketplace) return;
  await writeJsonInside(staged.rawDirectory, 'marketplace.json', {
    schemaVersion: 1,
    capturedAt: staged.stagedAt,
    marketplace,
    origin: staged.plan.origin,
  });
}

function marketplaceMetadataForSource(source: PluginInstallSource): unknown | undefined {
  switch (source.kind) {
    case 'marketplace-npm-package':
    case 'marketplace-gitlab-skill':
    case 'marketplace-skill-files':
    case 'marketplace-url':
      return source.marketplace;
    case 'agent-proposed':
      return marketplaceMetadataForSource(source.source);
    default:
      return undefined;
  }
}

function readNestedString(record: unknown, keys: string[]): string | undefined {
  let value = record;
  for (const key of keys) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizePluginIdSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    || 'skill';
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

async function copyDirectoryContents(sourceDirectory: string, targetDirectory: string): Promise<void> {
  await mkdir(targetDirectory, { recursive: true });
  for (const entry of await readdir(sourceDirectory)) {
    await copyInside(join(sourceDirectory, entry), targetDirectory, entry);
  }
}

async function copyInside(sourcePath: string, targetDirectory: string, relativeTarget: string): Promise<void> {
  const targetPath = join(targetDirectory, relativeTarget);
  assertPathInside(targetDirectory, targetPath);
  await cp(sourcePath, targetPath, { ...BUNDLE_COPY_OPTIONS, force: true });
}

async function writeJsonInside(rootDirectory: string, relativePath: string, value: unknown): Promise<void> {
  const targetPath = join(rootDirectory, relativePath);
  assertPathInside(rootDirectory, targetPath);
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function assertPathInside(rootDirectory: string, targetPath: string): void {
  const inside = relative(rootDirectory, targetPath);
  if (inside.startsWith('..') || isAbsolute(inside) || inside.includes('\0')) {
    throw new Error(`Refusing to write outside plugin staging directory: ${targetPath}`);
  }
}

async function findFirstSymlink(sourcePath: string): Promise<string | null> {
  const stats = await lstat(sourcePath);
  if (stats.isSymbolicLink()) return sourcePath;
  if (!stats.isDirectory()) return null;
  for (const entry of await readdir(sourcePath)) {
    const found = await findFirstSymlink(join(sourcePath, entry));
    if (found) return found;
  }
  return null;
}

function validateMaterializedCapabilities(
  normalizedDirectory: string,
  manifest: NessyPluginManifest,
): PluginDiagnostic[] {
  const diagnostics: PluginDiagnostic[] = [];
  for (const capability of manifest.capabilities) {
    switch (capability.kind) {
      case 'skill': {
        const targetPath = join(normalizedDirectory, capability.skill.path);
        try {
          assertPathInside(normalizedDirectory, targetPath);
          if (!existsSync(targetPath)) {
            diagnostics.push(pluginDiagnostic(
              'error',
              'plugin.install.missing_skill_path',
              `Skill capability "${capability.id}" references a missing file: ${capability.skill.path}`,
              `capabilities.${capability.id}.skill.path`,
              { path: capability.skill.path },
            ));
          }
        } catch (error) {
          diagnostics.push(pluginDiagnostic(
            'error',
            'plugin.install.invalid_skill_path',
            error instanceof Error ? error.message : String(error),
            `capabilities.${capability.id}.skill.path`,
            { path: capability.skill.path },
          ));
        }
        break;
      }
      case 'asset': {
        const targetPath = join(normalizedDirectory, capability.asset.path);
        try {
          assertPathInside(normalizedDirectory, targetPath);
          if (!existsSync(targetPath)) {
            diagnostics.push(pluginDiagnostic(
              'error',
              'plugin.install.missing_asset_path',
              `Asset capability "${capability.id}" references a missing file: ${capability.asset.path}`,
              `capabilities.${capability.id}.asset.path`,
              { path: capability.asset.path },
            ));
          }
        } catch (error) {
          diagnostics.push(pluginDiagnostic(
            'error',
            'plugin.install.invalid_asset_path',
            error instanceof Error ? error.message : String(error),
            `capabilities.${capability.id}.asset.path`,
            { path: capability.asset.path },
          ));
        }
        break;
      }
      case 'hook': {
        if (!capability.hook.cwd) break;
        const targetPath = join(normalizedDirectory, capability.hook.cwd);
        try {
          assertPathInside(normalizedDirectory, targetPath);
          if (!existsSync(targetPath)) {
            diagnostics.push(pluginDiagnostic(
              'warning',
              'plugin.install.missing_hook_cwd',
              `Hook capability "${capability.id}" references a cwd that does not exist yet: ${capability.hook.cwd}`,
              `capabilities.${capability.id}.hook.cwd`,
              { cwd: capability.hook.cwd },
            ));
          }
        } catch (error) {
          diagnostics.push(pluginDiagnostic(
            'warning',
            'plugin.install.invalid_hook_cwd',
            error instanceof Error ? error.message : String(error),
            `capabilities.${capability.id}.hook.cwd`,
            { cwd: capability.hook.cwd },
          ));
        }
        break;
      }
    }
  }
  return diagnostics;
}

const PLUGIN_RUNTIME_LOCKFILES = [
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
] as const;
const PLUGIN_RUNTIME_UNSAFE_CONFIG = [
  '.npmrc',
  'bunfig.toml',
  'bunfig.json',
  '.yarnrc',
  '.yarnrc.yml',
  '.pnpmfile.cjs',
  'pnpm-workspace.yaml',
] as const;

function unsafeBundleSymlinkDiagnostic(root: string, path: string): PluginDiagnostic {
  return pluginDiagnostic(
    'error',
    'plugin.install.bundle_symlink_unsafe',
    'Normalized plugin bundle contains a symlink that escapes the immutable bundle.',
    undefined,
    { path: relative(root, path) },
  );
}

async function materializeRuntimeDependencies(
  normalizedDirectory: string,
  manifest: NessyPluginManifest,
  installer: PluginRuntimeDependencyInstaller | undefined,
): Promise<PluginDiagnostic[]> {
  if (!hasLocalExecutable(manifest)) return [];

  const packageJsonPath = join(normalizedDirectory, 'package.json');
  if (!existsSync(packageJsonPath)) return [];

  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
  } catch {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_manifest_invalid',
      'Executable plugin package.json is not valid JSON.',
    )];
  }
  if (!isRecord(packageJson)) {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_manifest_invalid',
      'Executable plugin package.json must contain an object.',
    )];
  }
  if (['workspaces', 'overrides', 'resolutions', 'pnpm'].some(field => packageJson[field] !== undefined)
    || PLUGIN_RUNTIME_UNSAFE_CONFIG.some(name => existsSync(join(normalizedDirectory, name)))) {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_config_unsafe',
      'Executable plugin package-manager overrides and repository-local package-manager config are not allowed.',
    )];
  }

  const dependencyNames = new Set<string>();
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const dependencies = packageJson[field];
    if (dependencies === undefined) continue;
    if (!isRecord(dependencies)) {
      return [pluginDiagnostic(
        'error',
        'plugin.install.runtime_dependency_manifest_invalid',
        `Executable plugin package.json ${field} must contain an object.`,
      )];
    }
    for (const [name, spec] of Object.entries(dependencies)) {
      if (!isSafeDependencyName(name) || typeof spec !== 'string' || isUnsafeDependencySpec(spec)) {
        return [pluginDiagnostic(
          'error',
          'plugin.install.runtime_dependency_spec_unsafe',
          `Executable plugin dependency "${name}" does not use an allowed registry package spec.`,
          field,
          { dependency: name },
        )];
      }
      dependencyNames.add(name);
    }
  }

  const nodeModulesPath = join(normalizedDirectory, 'node_modules');
  const canonicalNormalizedDirectory = await realpath(normalizedDirectory);
  if (dependencyNames.size === 0) return [];

  const lockfilePaths = await findPluginRuntimeLockfiles(normalizedDirectory);
  if (lockfilePaths.length > 1) {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_lock_ambiguous',
      'Executable plugins must contain exactly one supported runtime dependency lockfile.',
      undefined,
      { lockfiles: lockfilePaths.map(path => basename(path)).sort() },
    )];
  }
  if (existsSync(nodeModulesPath)) {
    const escapingSymlink = await findUnsafeBundleSymlink(nodeModulesPath, canonicalNormalizedDirectory);
    if (escapingSymlink) {
      return [pluginDiagnostic(
        'error',
        'plugin.install.runtime_dependency_symlink_unsafe',
        'Vendored plugin dependencies contain a symlink that escapes the immutable bundle.',
        undefined,
        { path: relative(canonicalNormalizedDirectory, escapingSymlink) },
      )];
    }
    const selfContained = await hasCompleteVendoredDependencyGraph(
      canonicalNormalizedDirectory,
      packageJson,
    );
    if (selfContained) return [];
  }
  const lockfilePath = lockfilePaths[0];
  if (!lockfilePath) {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_lock_missing',
      'Executable plugin runtime dependencies require a committed lockfile.',
    )];
  }
  if (!installer) {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_installer_unavailable',
      'This Nessy runtime cannot materialize the executable plugin dependencies.',
    )];
  }

  const packageJsonBefore = await readFile(packageJsonPath);
  const lockfileBefore = await readFile(lockfilePath);
  try {
    await installer({
      mode: 'locked',
      directory: normalizedDirectory,
      packageJsonPath,
      lockfilePath,
      production: true,
      ignoreScripts: true,
      frozenLockfile: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'plugin-runtime-dependency-quota-exceeded') {
      return [pluginDiagnostic(
        'error',
        'plugin.install.runtime_dependency_quota_exceeded',
        'Executable plugin dependencies exceeded the bounded installation quota.',
      )];
    }
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_install_failed',
      'Executable plugin dependencies could not be materialized from the committed lockfile.',
    )];
  }

  let packageJsonAfter: Buffer;
  let lockfileAfter: Buffer;
  try {
    const lockfilesAfter = await findPluginRuntimeLockfiles(normalizedDirectory);
    if (lockfilesAfter.length !== 1 || lockfilesAfter[0] !== lockfilePath) {
      throw new Error('runtime dependency lockfile set changed');
    }
    [packageJsonAfter, lockfileAfter] = await Promise.all([
      readFile(packageJsonPath),
      readFile(lockfilePath),
    ]);
  } catch {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_lock_changed',
      'Dependency installation removed immutable plugin package metadata.',
    )];
  }
  if (!packageJsonBefore.equals(packageJsonAfter) || !lockfileBefore.equals(lockfileAfter)) {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_lock_changed',
      'Dependency installation modified immutable plugin package metadata.',
    )];
  }
  const escapingSymlink = await findUnsafeBundleSymlink(
    normalizedDirectory,
    canonicalNormalizedDirectory,
  );
  if (escapingSymlink) {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_symlink_unsafe',
      'Materialized plugin dependencies contain a symlink that escapes the immutable bundle.',
      undefined,
      { path: relative(canonicalNormalizedDirectory, escapingSymlink) },
    )];
  }
  if (!await hasCompleteVendoredDependencyGraph(canonicalNormalizedDirectory, packageJson)) {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_materialization_incomplete',
      'Dependency installation did not produce a complete executable plugin dependency graph.',
    )];
  }
  return [];
}

async function materializeDeclaredNpxPackages(
  normalizedDirectory: string,
  manifest: NessyPluginManifest,
  installer: PluginRuntimeDependencyInstaller | undefined,
): Promise<PluginDiagnostic[]> {
  const reservedRoot = join(normalizedDirectory, '.nessy-runtime');
  if (existsSync(reservedRoot)) {
    return [pluginDiagnostic(
      'error',
      'plugin.install.npx_runtime_path_reserved',
      'The .nessy-runtime directory is reserved for host-materialized package executables.',
    )];
  }
  const declarations = new Map<string, Extract<ReturnType<typeof parsePluginPackageRunnerArgs>, { ok: true }>>();
  const packages = new Map<string, Extract<ReturnType<typeof parsePluginPackageRunnerArgs>, { ok: true }>>();
  for (const capability of manifest.capabilities) {
    if (capability.kind !== 'mcp'
      || capability.mcp.transport !== 'stdio'
      || !capability.mcp.command) continue;
    const qualification = qualifyPluginStdioCommand(capability.mcp.command, normalizedDirectory);
    if (!qualification.ok || qualification.kind !== 'host' || qualification.runtime !== 'npx') continue;
    const parsed = parsePluginPackageRunnerArgs(capability.mcp.args ?? []);
    if (!parsed.ok) continue;
    const existing = declarations.get(parsed.packageName);
    if (existing && existing.versionSpec !== parsed.versionSpec) {
      return [pluginDiagnostic(
        'error',
        'plugin.install.npx_dependency_conflict',
        `Declared npx package "${parsed.packageName}" uses conflicting registry versions.`,
      )];
    }
    declarations.set(parsed.packageName, parsed);
    if (hasMaterializedPluginPackageRunner(normalizedDirectory, capability.mcp.args ?? [])) continue;
    packages.set(parsed.packageName, parsed);
  }
  if (packages.size === 0) return [];

  if (!installer) {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_installer_unavailable',
      'This Nessy runtime cannot materialize declared npx packages.',
    )];
  }

  const directory = pluginNpxRuntimeRoot(normalizedDirectory);
  const packageJsonPath = join(directory, 'package.json');
  const sortedPackages = [...packages.values()].sort((a, b) => a.packageName.localeCompare(b.packageName));
  const packageJson = Buffer.from(`${JSON.stringify({
    name: 'nessy-plugin-npx-runtime',
    private: true,
    version: '0.0.0',
    dependencies: Object.fromEntries(sortedPackages.map(parsed => [parsed.packageName, parsed.versionSpec])),
  }, null, 2)}\n`);
  await mkdir(directory, { recursive: true });
  await writeFile(packageJsonPath, packageJson);
  try {
    await installer({
      mode: 'generate-lock',
      directory,
      packageJsonPath,
      production: true,
      ignoreScripts: true,
      frozenLockfile: false,
    });
  } catch (error) {
    return [pluginDiagnostic(
      'error',
      error instanceof Error && error.message === 'plugin-runtime-dependency-quota-exceeded'
        ? 'plugin.install.runtime_dependency_quota_exceeded'
        : 'plugin.install.runtime_dependency_install_failed',
      'Declared npx package dependencies could not be materialized.',
    )];
  }
  const lockfiles = await findPluginRuntimeLockfiles(directory);
  let packageJsonAfter: Buffer;
  try {
    packageJsonAfter = await readFile(packageJsonPath);
  } catch {
    packageJsonAfter = Buffer.alloc(0);
  }
  if (lockfiles.length !== 1 || !packageJson.equals(packageJsonAfter)) {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_lock_changed',
      'Declared npx package materialization did not produce immutable package metadata.',
    )];
  }
  const packageRecord = JSON.parse(packageJson.toString('utf-8')) as Record<string, unknown>;
  const canonicalDirectory = await realpath(directory);
  if (!await hasCompleteVendoredDependencyGraph(canonicalDirectory, packageRecord)
    || sortedPackages.some(parsed => !hasMaterializedPluginPackageRunner(directory, [parsed.packageSpec]))) {
    return [pluginDiagnostic(
      'error',
      'plugin.install.runtime_dependency_materialization_incomplete',
      'Declared npx package materialization did not produce a complete executable dependency graph.',
    )];
  }
  return [];
}

async function findPluginRuntimeLockfiles(normalizedDirectory: string): Promise<string[]> {
  const lockfiles: string[] = [];
  for (const name of PLUGIN_RUNTIME_LOCKFILES) {
    const candidate = join(normalizedDirectory, name);
    if (!existsSync(candidate)) continue;
    const stats = await lstat(candidate);
    if (stats.isFile() && !stats.isSymbolicLink()) lockfiles.push(candidate);
  }
  return lockfiles;
}

async function hasCompleteVendoredDependencyGraph(
  rootDirectory: string,
  rootManifest: Record<string, unknown>,
): Promise<boolean> {
  const visited = new Set<string>([rootDirectory]);

  const visit = async (packageDirectory: string, manifest: Record<string, unknown>): Promise<boolean> => {
    const dependencyNames = requiredVendoredDependencyNames(manifest);
    if (!dependencyNames) return false;
    for (const name of dependencyNames) {
      const dependencyDirectory = await resolveVendoredDependencyDirectory(
        packageDirectory,
        rootDirectory,
        name,
      );
      if (!dependencyDirectory) return false;
      if (visited.has(dependencyDirectory)) continue;
      visited.add(dependencyDirectory);
      let dependencyManifest: unknown;
      try {
        dependencyManifest = JSON.parse(await readFile(join(dependencyDirectory, 'package.json'), 'utf-8'));
      } catch {
        return false;
      }
      if (!isRecord(dependencyManifest) || !await visit(dependencyDirectory, dependencyManifest)) {
        return false;
      }
    }
    return true;
  };

  return visit(rootDirectory, rootManifest);
}

function requiredVendoredDependencyNames(manifest: Record<string, unknown>): string[] | undefined {
  const required = new Set<string>();
  const optional = new Set<string>();
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const dependencies = manifest[field];
    if (dependencies === undefined) continue;
    if (!isRecord(dependencies)) return undefined;
    for (const [name, spec] of Object.entries(dependencies)) {
      if (!isSafeDependencyName(name) || typeof spec !== 'string') return undefined;
      if (field === 'optionalDependencies') optional.add(name);
      else required.add(name);
    }
  }
  for (const name of optional) required.delete(name);
  if (isRecord(manifest.peerDependenciesMeta)) {
    for (const [name, metadata] of Object.entries(manifest.peerDependenciesMeta)) {
      if (isRecord(metadata) && metadata.optional === true) required.delete(name);
    }
  }
  return [...required];
}

async function resolveVendoredDependencyDirectory(
  packageDirectory: string,
  rootDirectory: string,
  dependencyName: string,
): Promise<string | undefined> {
  let currentDirectory = packageDirectory;
  while (true) {
    const candidate = join(currentDirectory, 'node_modules', ...dependencyName.split('/'));
    try {
      const resolved = await realpath(candidate);
      assertPathInside(rootDirectory, resolved);
      if ((await lstat(resolved)).isDirectory()) return resolved;
      return undefined;
    } catch {
      // Keep walking the Node resolution ancestry until the immutable bundle root.
    }
    if (currentDirectory === rootDirectory) return undefined;
    const parentDirectory = dirname(currentDirectory);
    try {
      assertPathInside(rootDirectory, parentDirectory);
    } catch {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

function hasLocalExecutable(manifest: NessyPluginManifest): boolean {
  return manifest.capabilities.some(capability => (
    (capability.kind === 'mcp' && capability.mcp.transport === 'stdio')
    || (capability.kind === 'hook' && capability.hook.type === 'command')
    || capability.kind === 'command'
    || capability.kind === 'lsp'
    || (capability.kind === 'skill' && capability.skill.entrypoint !== undefined)
  ))
    || (manifest.connectors ?? []).some(connector => (
      connector.mcpServers.some(server => server.transport === 'stdio')
    ))
    || (manifest.nessyExtensions?.commands?.length ?? 0) > 0;
}

function isUnsafeDependencySpec(spec: string): boolean {
  const normalized = spec.trim();
  if (!normalized || normalized.includes('\0')) return true;
  if (normalized.startsWith('npm:')) {
    const alias = normalized.match(/^npm:((?:@[^/\s]+\/)?[^@/\s]+)@(.+)$/);
    return !alias?.[2] || isUnsafeDependencySpec(alias[2]);
  }
  if (/^(?:file|link|workspace|git(?:\+[^:]*)?|https?|ssh|github|gitlab|bitbucket|portal|patch|catalog):/i.test(normalized)) {
    return true;
  }
  return /^(?:\.{1,2}[\\/]|[\\/]|[a-z]:)/i.test(normalized)
    || normalized.includes('/')
    || normalized.includes('\\');
}

function isSafeDependencyName(name: string): boolean {
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name);
}

function normalizeUrlArtifact(plan: PluginInstallPlan): PluginInstallPlan {
  if (plan.source.kind !== 'url' || plan.artifact?.type !== 'archive-url') return plan;
  if (!looksLikeJsonUrl(plan.source.url)) return plan;
  return {
    ...plan,
    artifact: { type: 'manifest-url', url: plan.source.url, manifestUrl: plan.source.url },
  };
}

function looksLikeJsonUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname.endsWith('.json');
  } catch {
    return false;
  }
}

function isUnsupportedFormatFailure(diagnostics: PluginDiagnostic[]): boolean {
  return diagnostics.some(diagnostic => diagnostic.code === 'plugin.format.unsupported_format');
}

/**
 * Wrap a staged raw directory whose only content is a standalone `SKILL.md`
 * (no known plugin manifest) into a minimal Nessy plugin manifest (A3 item 7).
 * Never copies into native skill directories — the synthesized manifest is
 * committed through the same immutable-cache path as every other bundle.
 * Returns `undefined` when the raw directory is not a standalone-skill shape,
 * so the caller can keep the original unsupported-format failure.
 */
async function wrapStandaloneSkillFile(rawDirectory: string, originalArtifactPath?: string): Promise<NessyPluginManifest | undefined> {
  const entries = await readdir(rawDirectory);
  if (entries.length !== 1 || entries[0] !== 'SKILL.md') return undefined;
  const skillFilePath = join(rawDirectory, 'SKILL.md');
  const stats = await lstat(skillFilePath);
  if (!stats.isFile()) return undefined;

  const slugSource = originalArtifactPath ? basename(dirname(originalArtifactPath)) : basename(dirname(rawDirectory));
  const slug = sanitizePluginIdSegment(slugSource || 'skill');
  const skillDirectory = join(rawDirectory, 'skills', slug);
  await mkdir(skillDirectory, { recursive: true });
  const content = await readFile(skillFilePath, 'utf-8');
  await writeFile(join(skillDirectory, 'SKILL.md'), content, { encoding: 'utf-8', mode: 0o600 });
  await rm(skillFilePath);

  return {
    schemaVersion: 1,
    kind: 'plugin',
    id: slug,
    name: slug,
    version: '0.0.0',
    capabilities: [
      {
        kind: 'skill',
        id: slug,
        skill: {
          slug,
          path: `skills/${slug}/SKILL.md`,
        },
      },
    ],
    compatibility: {
      rawExternalKind: 'standalone-skill',
    },
  };
}

/**
 * Detect the ecosystem format for a normalized manifest (A3). Presentation
 * and compatibility-reporting only — never a runtime discriminator. Falls
 * back to `'unknown'` when the adapter/manifest gives no ecosystem evidence.
 */
function detectEcosystemFormat(manifest: NessyPluginManifest, adapterId?: string): PluginEcosystemFormat {
  const rawExternalKind = manifest.compatibility?.rawExternalKind;
  if (adapterId === 'codex-plugin-json' || rawExternalKind === 'codex-plugin') return 'codex';
  if (adapterId === 'claude-compat-detected' || rawExternalKind === 'claude-plugin') return 'claude';
  if (
    adapterId === 'nessy-plugin-json'
    || adapterId === 'nessy-extension-json'
    || rawExternalKind === 'nessy-extension'
    || rawExternalKind === 'standalone-skill'
    || rawExternalKind === 'marketplace-skill'
  ) {
    return 'nessy';
  }
  return 'unknown';
}

/**
 * Derive a compatibility report directly from a manifest's own `unsupported`
 * capabilities. Used ONLY when no format adapter supplied its own report
 * (native nessy-plugin-json/nessy-extension-json bundles and the wrapped
 * standalone-skill path) — Codex/Claude adapters always supply their own
 * report (A7/D12) and take precedence over this fallback.
 */
function nativeCompatibilityReport(format: PluginEcosystemFormat, manifest: NessyPluginManifest): PluginCompatibilityReport {
  const supportedKinds = [...new Set(
    manifest.capabilities
      .filter(capability => capability.kind !== 'unsupported')
      .map(capability => capability.kind),
  )];
  const unavailable = manifest.capabilities
    .filter((capability): capability is Extract<typeof capability, { kind: 'unsupported' }> => capability.kind === 'unsupported')
    .map(capability => ({
      externalKind: capability.unsupported.externalKind,
      reasonCode: capability.unsupported.reasonCode,
      ...(capability.unsupported.sourcePath ? { sourcePath: capability.unsupported.sourcePath } : {}),
    }));
  const deferred = unavailable.filter(entry => entry.reasonCode.startsWith('plugin.deferred.'));
  const blocked = unavailable.filter(entry => !entry.reasonCode.startsWith('plugin.deferred.'));
  return {
    format,
    state: unavailable.length > 0 ? 'partial' : 'supported',
    supportedKinds,
    deferred,
    blocked,
  };
}

function isJsonContentType(contentType: string): boolean {
  return /\bapplication\/json\b/i.test(contentType) || /\+json\b/i.test(contentType);
}

function isHtmlResponse(content: string, contentType: string): boolean {
  const trimmed = content.trimStart().toLowerCase();
  return /\btext\/html\b/i.test(contentType)
    || trimmed.startsWith('<!doctype html')
    || trimmed.startsWith('<html')
    || trimmed.includes('/users/auth/devplatform');
}

function isGitLabBlobUrl(url: string): boolean {
  try {
    return new URL(url).pathname.includes('/-/blob/');
  } catch {
    return false;
  }
}

function repositoryNotImplementedDiagnostic(repositoryUrl?: string): PluginDiagnostic {
  return pluginDiagnostic(
    'error',
    'plugin.install.repository_fetch_not_implemented',
    'Repository plugin artifacts are not fetched by the plugin install service yet.',
    undefined,
    repositoryUrl ? { repositoryUrl } : undefined,
  );
}

function confirmationSummaryForProposal(
  proposal: PluginAgentInstallProposal,
  plan: PluginInstallPlan,
): string[] {
  return [
    `Install proposed plugin "${proposal.label}" from ${describeSource(proposal.source)}.`,
    `Requested scope: ${plan.requestedScope ?? proposal.requestedScope ?? 'not enabled by default'}.`,
    'Marketplace install commands are display metadata only and will not be executed.',
  ];
}

function describeSource(source: PluginAgentInstallProposalSource): string {
  switch (source.kind) {
    case 'marketplace-npm-package':
      return `${source.packageName}${source.version ? `@${source.version}` : ''}`;
    case 'marketplace-gitlab-skill':
      return source.url;
    case 'marketplace-skill-files':
      return source.filesUrl;
    case 'marketplace-url':
      return source.url;
    case 'url':
      return source.url;
    case 'repository':
      return source.repositoryUrl;
    case 'local-path':
      return source.path;
    case 'unsupported':
      return source.value;
  }
}
