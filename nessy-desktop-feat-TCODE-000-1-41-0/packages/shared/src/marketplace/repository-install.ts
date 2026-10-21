import { pluginDiagnostic } from '../plugins/schema.ts';
import { parseBitbucketOrAzureRepositoryUrl, repositoryHostKind } from '../plugins/repository-hosts.ts';
import type { PluginInstallSource } from '../plugins/types.ts';
import type { PluginManagementInstallResult } from '../plugins/management-types.ts';
import type {
  MarketplaceRepositoryHostKind,
  MarketplaceRepositoryInstallProposal,
  MarketplaceRepositoryInstallRequest,
  MarketplaceRepositoryInstaller,
} from './types.ts';

/**
 * D4 — `submission-errors.md:155` (`plugin_manifest_missing`) names THREE
 * accepted manifest locations: "ZIP must contain `.codex-plugin/plugin.json`,
 * `.agent-plugin/plugin.json`, or `.claude-plugin/plugin.json` at the root or
 * in its single top-level directory." The neutral `.agent-plugin` one was
 * missing here, so a repository laid out that way was proposed without ever
 * naming the file the user would have to add.
 */
const REPOSITORY_CANDIDATE_FILES = [
  '.codex-plugin/plugin.json',
  '.agent-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  'nessy-extension.json',
  'plugin.json',
  'SKILL.md',
] as const;

export function proposeRepositoryInstall(
  request: MarketplaceRepositoryInstallRequest,
): MarketplaceRepositoryInstallProposal {
  const parsed = parseRepositoryUrl(request.url, request.ref, request.subdirectory);
  if (!parsed) {
    return {
      status: 'unsupported',
      sourceUrl: request.url,
      detectedFormat: 'unknown',
      confidence: 'low',
      candidateFiles: [...REPOSITORY_CANDIDATE_FILES],
      diagnostics: [
        pluginDiagnostic(
          'error',
          'marketplace.repository.unsupported_url',
          'Only GitHub and GitLab repository URLs can be proposed for marketplace repository installs.',
          'url',
          { url: request.url },
        ),
      ],
      suggestedNextSteps: [
        'Use a GitHub or GitLab repository URL.',
        `Choose a ref and subdirectory that contains ${REPOSITORY_CANDIDATE_FILES.slice(0, -1).join(', ')}, or ${REPOSITORY_CANDIDATE_FILES.at(-1)}.`,
      ],
    };
  }

  const source: PluginInstallSource = {
    kind: 'repository',
    repositoryUrl: parsed.repositoryUrl,
    ...(parsed.ref ? { ref: parsed.ref } : {}),
    ...(parsed.subdirectory ? { subdirectory: parsed.subdirectory } : {}),
  };
  // F1.805 — this proposal is built from the URL ALONE: the repository is never
  // contacted, so it cannot know whether the repository exists, is reachable, or
  // holds a supported manifest. The install stage (`installer.install`, reached
  // through `plugin_install`) fetches and validates it and fails honestly there.
  // The proposal says so with an `info` diagnostic, whose code is what reaches
  // the model and the renderer, and never claims `high` confidence: a pinned ref
  // is `medium`, a default-branch guess is `low`. No `git ls-remote` probe here:
  // it would make this pure, synchronous, offline-safe step network-bound and
  // need the install path's credential handling for private repositories.
  return {
    status: 'installable',
    sourceUrl: request.url,
    hostKind: parsed.hostKind,
    repositoryUrl: parsed.repositoryUrl,
    ...(parsed.ref ? { ref: parsed.ref } : {}),
    ...(parsed.subdirectory ? { subdirectory: parsed.subdirectory } : {}),
    detectedFormat: 'unknown',
    confidence: parsed.ref ? 'medium' : 'low',
    candidateFiles: [...REPOSITORY_CANDIDATE_FILES],
    diagnostics: [
      pluginDiagnostic(
        'info',
        'marketplace.repository.not_contacted',
        'The repository was not contacted: only its URL was checked. Whether it exists, is reachable, and contains a supported plugin or skill is checked when plugin_install fetches it.',
        'url',
        { repositoryUrl: parsed.repositoryUrl },
      ),
    ],
    suggestedNextSteps: [
      'Install through the backend plugin installer so repository contents are staged, normalized, validated, and committed by PluginStore.',
    ],
    source,
  };
}

/**
 * Normalize a repository URL into a safe display label for the renderer: host +
 * path only, with userinfo (credentials), query and fragment stripped. Falls
 * back to a generic label when the URL cannot be parsed.
 */
export function normalizeRepositoryDisplaySource(
  sourceUrl: string,
  repositoryUrl?: string,
): string {
  const candidate = repositoryUrl ?? sourceUrl;
  try {
    const url = new URL(candidate);
    const path = url.pathname.replace(/\.git$/, '').replace(/\/+$/, '');
    return `${url.host}${path}`;
  } catch {
    return 'unknown-source';
  }
}

export async function installRepositoryProposal(
  proposal: MarketplaceRepositoryInstallProposal,
  installer: MarketplaceRepositoryInstaller,
): Promise<PluginManagementInstallResult> {
  if (proposal.status !== 'installable' || !proposal.source) {
    throw new Error('Repository install proposal is not installable.');
  }
  return installer.install(proposal.source);
}

function parseRepositoryUrl(
  input: string,
  requestedRef?: string,
  requestedSubdirectory?: string,
): {
  hostKind: MarketplaceRepositoryHostKind;
  repositoryUrl: string;
  ref?: string;
  subdirectory?: string;
} | null {
  try {
    const url = new URL(input);
    const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    if (repositoryHostKind(url.hostname) === 'github' && segments.length >= 2) {
      const [owner, rawRepo, marker, ref, ...subdirectoryParts] = segments;
      if (!owner || !rawRepo) return null;
      const repo = rawRepo.replace(/\.git$/, '');
      return {
        hostKind: 'github',
        repositoryUrl: `${url.origin}/${owner}/${repo}`,
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
      return {
        hostKind: 'gitlab',
        repositoryUrl: `${url.origin}/${repoSegments.join('/').replace(/\.git$/, '')}`,
        ref: requestedRef ?? ref,
        subdirectory: requestedSubdirectory ?? (subdirectoryParts.length ? subdirectoryParts.join('/') : undefined),
      };
    }
    // C3.260 — the third call site of the one parser the two added hosts share
    // (`plugins/repository-hosts.ts` symbol `parseBitbucketOrAzureRepositoryUrl`).
    // Widening the resolver without widening this one would let a host be
    // ACCEPTED by the install proposal and then refused when it fetches, which
    // is the five-places defect C3.190 removed.
    const added = parseBitbucketOrAzureRepositoryUrl(url);
    if (added) {
      return {
        hostKind: added.kind,
        repositoryUrl: added.repositoryUrl,
        ref: requestedRef ?? added.ref,
        subdirectory: requestedSubdirectory ?? added.subdirectory,
      };
    }
  } catch {
    return null;
  }
  return null;
}
