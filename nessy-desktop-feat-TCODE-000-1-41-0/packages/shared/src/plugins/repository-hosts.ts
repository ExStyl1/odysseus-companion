/**
 * C3.190 — WHICH GIT HOST HAS AN ACQUISITION ROUTE HERE, in one place.
 *
 * This app never clones. It has exactly TWO fetch-only archive routes
 * (`acquisition.ts`): GitHub's `<repo>/archive/<ref>.tar.gz`, and GitLab's
 * documented REST route `/api/v4/projects/<encoded>/repository/archive.tar.gz`.
 * So the only question a hostname can answer is *which of those two shapes do
 * we speak to it in* — not whether the host is trusted, and not whether the
 * user may install from it.
 *
 * **Why this module exists at all.** The question was answered in FIVE places
 * by two subsystems, each re-spelling `hostname.includes('gitlab')` inline:
 * `source-resolver.ts` twice (`unsupportedRepositoryHost`,
 * `parseHostedRepositoryUrl`), `acquisition.ts` once (`normalizeRepositorySpec`
 * — the half that decides whether an accepted source actually FETCHES), and
 * `marketplace/install-source.ts` + `marketplace/repository-install.ts` once
 * each. Widening any subset of those would have made the same host install
 * through one route and refuse through another.
 *
 * **The substring is gone, deliberately, and it is a narrowing.** Owner answer
 * QL9 (2026-09-11), option B: extend the supported set, and — the plan row's
 * own done-clause — replace the substring "with something a hostname cannot
 * pass by accident". `includes('gitlab')` admitted `mygitlab.acme.com`,
 * `notgitlab.io` and `gitlab-mirror.example.net`; a DNS LABEL test admits
 * `gitlab.com`, `gitlab.example.com` and `gitlab.tcsbank.ru` and refuses the
 * three. That removes hosts that used to resolve, so
 * {@link describeUnlistedGitLabLookalike} exists to say EXACTLY that to whoever
 * meets the refusal, naming the escape hatch rather than leaving a host that
 * worked yesterday looking broken.
 *
 * **What is widened.** {@link SELF_HOSTED_GITLAB_HOSTS} — this fork's own git
 * host, whose hostname does not say "gitlab" and which was therefore refused at
 * HEAD (measured 2026-09-11: `https://git.tcsbank.ru/grp/repo.git` resolved to
 * `unsupported` / `plugin.source.unsupported_repository_host`) — plus anything
 * an operator lists in {@link GITLAB_HOSTS_ENV_VAR}. Both take the GitLab v4
 * route unchanged, because `repositoryApiUrl` and `repositoryArchiveUrl` build
 * it from the repository URL's own origin and are already host-agnostic.
 *
 * **C3.260 (2026-09-12) built the two routes C3.190 priced and deferred**, and
 * recorded the third as a structural null. Each needed exactly what C3.190 said
 * it would — its own archive URL shape, its own tag route and its own
 * extracted-top-directory rule — and the two that could be measured were:
 *
 * - **Bitbucket Cloud** ({@link BITBUCKET_HOSTS}), measured live from this rig
 *   on 2026-09-12 against the public `atlassian/atlassian-frontend-mirror` and
 *   `atlassian/aui`. `…/get/<ref>.tar.gz` answers `200
 *   application/x-tar-gz` and unpacks under ONE top-level directory
 *   (`atlassian-atlassian-frontend-mirror-f69cf25b0e32/`), so the existing tar
 *   path and its `strip: 1` serve it unchanged. The default branch is
 *   `mainbranch.name`, NOT `default_branch`, and the tag listing is a
 *   `{ values: [{ name, target: { hash } }], next }` envelope paged by
 *   `pagelen`, not a bare array paged by `per_page` — three shape differences
 *   that each had to be read rather than assumed.
 * - **Azure DevOps Services** ({@link AZURE_DEVOPS_HOSTS}), built from the
 *   documented routes and NOT measured: `dev.azure.com` is blocked from this
 *   rig by the corporate proxy (`503`, an HTML page titled "Сайт заблокирован",
 *   2026-09-12), so every claim about it here is `learn.microsoft.com`'s, never
 *   an observation. Its one structural difference is named at its call site:
 *   the items route publishes **zip only** — "Doesn't apply to zipped content,
 *   which is always returned as a download"
 *   (`rest/api/azure/devops/git/items/get?view=azure-devops-rest-7.1`, fetched
 *   2026-09-12) — where every other route in this module is a gzipped tar.
 * - **AWS CodeCommit is a STRUCTURAL null, not a deferral** — see
 *   {@link describeStructurallyUnroutableHost}.
 *
 * **What is still NOT widened, and why each is a posture rather than an
 * oversight:**
 *
 * - **Azure DevOps Server (on-premises) and the legacy
 *   `<org>.visualstudio.com` spelling.** Both address a repository differently
 *   from `dev.azure.com/<org>/<project>/_git/<repo>` — the collection segment
 *   on one, the organization in the HOSTNAME on the other — and neither is
 *   reachable from here either. They meet the named refusal, which is the
 *   honest answer for a shape nobody has driven.
 * - **GitHub Enterprise Server.** Its archive route would work
 *   (`<repo>/archive/<ref>.tar.gz` is the same), but `repositoryApiUrl` sends
 *   the GitHub kind to the literal `https://api.github.com/repos/...`, so a
 *   declared GHES host would resolve its TAGS against github.com — the wrong
 *   server, silently. So {@link GITLAB_HOSTS_ENV_VAR} declares GitLab hosts
 *   ONLY; there is deliberately no github-kind declaration until that hard-coded
 *   origin is lifted.
 * - **The internal DP credential.** `acquisition.ts`'s
 *   `isInternalGitLabHost`/`DpGitLabArtifactAuthProvider` still match ONE exact
 *   hostname. Nothing here widens the set of hosts the user's internal token is
 *   attached to — admitting a host means we will try a public REST route
 *   against it, not that we will authenticate to it.
 */

export type RepositoryHostKind = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops';

/**
 * GitHub, exactly. `www.github.com` redirects to the apex on every route we
 * use, and a user who pastes it should not meet a refusal for a spelling.
 */
const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com']);

/**
 * GitLab instances whose hostname does not contain the label `gitlab`.
 *
 * `git.tcsbank.ru` is this fork's own git host and the one the ledger's L13 row
 * and owner answer QL9 both name. Recorded as read, not probed: no lane has
 * driven an install against it, and the failure mode if it turns out not to be
 * a GitLab is a TYPED one — `/api/v4/...` answers JSON on a GitLab and 404s
 * legibly elsewhere (A3, measured against `gitlab.tcsbank.ru` 2026-07-31) — not
 * the HTML-sign-in-page-into-the-tar-extractor failure the web route gives.
 */
const SELF_HOSTED_GITLAB_HOSTS: ReadonlySet<string> = new Set([
  'git.tcsbank.ru',
  // Matched by the label rule as well; listed so the pair reads as one
  // deployment rather than as one host plus a coincidence.
  'gitlab.tcsbank.ru',
]);

/**
 * Bitbucket Cloud, exactly. The archive route lives on the WEB origin
 * (`bitbucket.org/<workspace>/<repo>/get/<ref>.tar.gz`) and the metadata route
 * on a DIFFERENT origin (`api.bitbucket.org/2.0/repositories/...`), so
 * `acquisition.ts`'s `repositoryApiUrl` builds the API origin from a constant
 * instead of reusing the repository URL's own — the one place a Bitbucket spec
 * cannot follow the GitLab pattern of hanging the API off its own origin, and
 * therefore the one reason a self-hosted Bitbucket cannot be declared into this
 * set the way a self-hosted GitLab can.
 *
 * Bitbucket Data Center (the self-hosted product) is a different API (`/rest/api/1.0/`)
 * on an operator's own hostname and is deliberately absent: nothing here can
 * name its hosts, and its archive route is not this one.
 */
const BITBUCKET_HOSTS: ReadonlySet<string> = new Set(['bitbucket.org', 'www.bitbucket.org']);

/**
 * Azure DevOps Services, exactly — the multi-tenant host. See the file header
 * for why the on-premises product and the legacy `<org>.visualstudio.com`
 * spelling are not here.
 */
const AZURE_DEVOPS_HOSTS: ReadonlySet<string> = new Set(['dev.azure.com']);

/**
 * AWS CodeCommit's git endpoints, which this app can never fetch from.
 *
 * `git-codecommit.<region>.amazonaws.com` is the documented git remote host.
 * Recorded as a pattern rather than a list because the region is open-ended.
 */
const CODECOMMIT_HOST_PATTERN = /^git-codecommit\.[a-z0-9-]+\.amazonaws\.com$/;

/**
 * Operator escape hatch: additional GitLab hostnames, comma- or
 * whitespace-separated. The refusal diagnostic names it, so a deployment on a
 * forge we have never heard of is a setting away rather than a code change.
 *
 * ## C3.261 — this IS the managed setting, and that is why there is no second one
 *
 * C3.261 was born from W15-f's PR-2 on the premise that *"an administrator
 * mandating a forge for a fleet wants managed settings, not an exported
 * variable"*. **Measured 2026-09-12, the premise does not hold: a managed `env`
 * block already mandates this variable fleet-wide, from the root-owned policy
 * file, before the first install.** Nobody has to export anything.
 *
 * The readings, each with the control that makes it a reading rather than a
 * tautology about a name nothing classifies:
 *
 * - `classifyManagedEnvVar` (`config/managed-env.ts`) answers `immediate` for
 *   this name — control: `HTTPS_PROXY` answers `transport`, so the classifier
 *   really does discriminate. `immediate` is the category that is applied at
 *   once rather than held back until the settings fetch confirms.
 * - `isRefusedManagedEnvVar` answers `false` — control:
 *   `CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION`, the ONE refused name, answers `true`.
 * - `applyManagedEnv` writes it from BOTH admin sources (`managed-file` and
 *   `server-cache`), confirmed and unconfirmed, with `withholding: false`, and
 *   {@link repositoryHostKind} then resolves the declared host. Negative
 *   control: with no value the same host answers `undefined`.
 *
 * ## Why a `StoredConfig` key was NOT added beside it (posture, stated)
 *
 * It would be the WEAKER scope for the stated need, not the stronger one:
 * `StoredConfig` is the USER's `settings.json`, which the user can edit, so a
 * key there could not mandate anything an administrator wants mandated — the
 * managed `env` block above is the tier that can. And this fork already has an
 * established two-rung idiom for exactly this shape, with the ENV VAR as the
 * operator rung: `crossSessionInbound` is a `StoredConfig` key whose operator
 * lock is `NESSY_CROSS_SESSION_INBOUND` read from `process.env`
 * (`config/storage.ts` symbol `getCrossSessionInboundSettings`, which reports
 * `operatorLocked` from exactly that). A second, user-scope source of truth for
 * one host list would be a divergence to keep in sync, for a rung that is
 * strictly lower than the one that already works.
 *
 * What WAS owed, and is delivered here, is that none of this was visible: an
 * administrator reading the refusal met a variable NAME and no hint that their
 * own policy document could set it. {@link describeSupportedRepositoryHosts}
 * now says so.
 */
export const GITLAB_HOSTS_ENV_VAR = 'NESSY_PLUGIN_GITLAB_HOSTS';

/** Lower-case, FQDN trailing dot stripped, brackets stripped from a literal IPv6. */
function normalizeHostname(hostname: string): string {
  const lowered = hostname.trim().toLowerCase();
  const undotted = lowered.endsWith('.') ? lowered.slice(0, -1) : lowered;
  return undotted.startsWith('[') && undotted.endsWith(']') ? undotted.slice(1, -1) : undotted;
}

function declaredGitLabHosts(env: Record<string, string | undefined>): string[] {
  const raw = env[GITLAB_HOSTS_ENV_VAR];
  if (!raw) return [];
  return raw.split(/[\s,]+/).map(normalizeHostname).filter(Boolean);
}

/** A whole DNS label is `gitlab` — never a substring of one. */
function hasGitLabLabel(hostname: string): boolean {
  return hostname.split('.').includes('gitlab');
}

/**
 * The acquisition route for a hostname, or `undefined` when this app has none.
 *
 * `env` is a parameter rather than a module-scope read so a caller (and a test)
 * can ask the question about a specific environment; it defaults to the
 * process's own.
 */
export function repositoryHostKind(
  hostname: string,
  env: Record<string, string | undefined> = process.env,
): RepositoryHostKind | undefined {
  const host = normalizeHostname(hostname);
  if (!host) return undefined;
  if (GITHUB_HOSTS.has(host)) return 'github';
  if (hasGitLabLabel(host)) return 'gitlab';
  if (SELF_HOSTED_GITLAB_HOSTS.has(host)) return 'gitlab';
  if (BITBUCKET_HOSTS.has(host)) return 'bitbucket';
  if (AZURE_DEVOPS_HOSTS.has(host)) return 'azure-devops';
  if (declaredGitLabHosts(env).includes(host)) return 'gitlab';
  return undefined;
}

/** `repositoryHostKind(...) !== undefined`, for the call sites that only branch. */
export function isSupportedRepositoryHost(
  hostname: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return repositoryHostKind(hostname, env) !== undefined;
}

/**
 * The sentence the user reads inside the refusal. Built from the same sets the
 * predicate reads, so the message cannot drift from the behaviour — the
 * previous constant was a hand-written string beside a hand-written boolean.
 */
export function describeSupportedRepositoryHosts(
  env: Record<string, string | undefined> = process.env,
): string {
  const declared = declaredGitLabHosts(env);
  const parts = [
    'github.com',
    'a GitLab host (a hostname with a "gitlab" label, such as gitlab.com or gitlab.example.com)',
    [...SELF_HOSTED_GITLAB_HOSTS].join(', '),
    [...BITBUCKET_HOSTS].join(', '),
    [...AZURE_DEVOPS_HOSTS].join(', '),
  ];
  // C3.261 — the variable's name alone told an administrator nothing about the
  // tier that can set it for a fleet. Their own managed-settings `env` block
  // delivers it at startup; see {@link GITLAB_HOSTS_ENV_VAR} for the reading.
  const declarable = `${GITLAB_HOSTS_ENV_VAR} (which a managed settings "env" block sets for a whole fleet)`;
  parts.push(declared.length
    ? `and the hosts listed in ${declarable}: ${declared.join(', ')}`
    : `and any GitLab host listed in ${declarable}`);
  return parts.join(', ');
}

/**
 * The one case this change makes WORSE, said out loud.
 *
 * A hostname that merely contains `gitlab` inside a label — `mygitlab.acme.com`
 * — resolved before C3.190 and is refused now. Returns the extra sentence for
 * exactly that host shape, and nothing for any other refusal, so the message
 * stays about the host in front of the user.
 */
export function describeUnlistedGitLabLookalike(hostname: string): string | undefined {
  const host = normalizeHostname(hostname);
  if (!host || !host.includes('gitlab') || hasGitLabLabel(host)) return undefined;
  return `"${host}" contains "gitlab" but no part of it IS "gitlab", and a substring match let unrelated hostnames through. `
    + `If it is a GitLab instance, list it in ${GITLAB_HOSTS_ENV_VAR} and it resolves again.`;
}

/**
 * The second sentence a refusal carries when the host cannot EVER have a route
 * here — as opposed to not having one yet.
 *
 * C3.260 was asked to build Bitbucket and Azure DevOps and to *record* AWS
 * CodeCommit's structural null. The distinction is the whole point of this
 * function: Bitbucket and Azure DevOps were missing routes, and a route is a
 * thing you can write. CodeCommit publishes none to write, and a reader who
 * meets a bare "unsupported host" cannot tell the two apart — so the honest
 * refusal names the reason and stops the next lane from re-pricing it.
 *
 * Measured 2026-09-12 from the AWS documentation, which is reachable from this
 * rig (`docs.aws.amazon.com`, 200):
 *
 * - CodeCommit "hosts **private** Git repositories"
 *   (`codecommit/latest/userguide/welcome.html`, verbatim), so there is no
 *   anonymous route to be had even in principle — where GitHub, GitLab,
 *   Bitbucket and Azure DevOps all serve a public repository's archive with no
 *   credential at all, which is the only way this app fetches.
 * - Its API publishes **78** operations and NOT ONE of them contains `Archive`,
 *   `Zip` or `Download` (`codecommit/latest/APIReference/API_Operations.html`,
 *   counted 2026-09-12). The nearest are `GetBlob`, `GetFile` and `GetFolder` —
 *   per-object reads, each SigV4-signed.
 *
 * So a CodeCommit install would need an AWS credential chain, a SigV4 signer and
 * a per-object walk of the tree: not a route, a different acquisition model.
 * This fork's answer is the one P3.219 already gave for cloning — publish the
 * plugin as an `archive` or `npm` source, both of which work from any host.
 */
export function describeStructurallyUnroutableHost(hostname: string): string | undefined {
  const host = normalizeHostname(hostname);
  if (!host || !CODECOMMIT_HOST_PATTERN.test(host)) return undefined;
  return 'AWS CodeCommit hosts only private repositories and publishes no archive or download operation at all '
    + '(78 API operations, none named Archive, Zip or Download; the nearest are the SigV4-signed GetBlob/GetFile/GetFolder), '
    + 'so this is not a route this app is missing — there is none to add. ';
}

/**
 * How a repository is addressed on the two hosts C3.260 added.
 *
 * `owner`/`organization`/`project` are separate fields rather than one blob
 * because the two hosts disagree about how many segments name a repository:
 * Bitbucket takes `<workspace>/<repo>` like GitHub, Azure DevOps takes
 * `<organization>/<project>/_git/<repo>`, and the API URL each needs is built
 * from different pieces of that.
 */
export interface ParsedRepositoryAddress {
  kind: 'bitbucket' | 'azure-devops';
  /** Canonical repository URL: origin plus the addressing segments, no marker, no `.git`. */
  repositoryUrl: string;
  /** Bitbucket workspace. */
  owner?: string;
  /** Azure DevOps organization. */
  organization?: string;
  /** Azure DevOps team project. */
  project?: string;
  repo: string;
  ref?: string;
  subdirectory?: string;
}

/**
 * Parse a Bitbucket Cloud or Azure DevOps repository URL — and ONLY those two.
 *
 * It returns `null` for GitHub and GitLab deliberately. Those two are parsed in
 * three places already (`acquisition.ts:normalizeRepositorySpec`,
 * `source-resolver.ts:parseHostedRepositoryUrl`,
 * `marketplace/repository-install.ts:parseRepositoryUrl`) and the three copies
 * are NOT identical — the resolver refuses a non-`tree` marker and a
 * file-shaped last segment, the other two do not. Unifying them is a
 * behaviour-changing refactor of paths this row does not touch; adding a fourth
 * copy of the NEW hosts would be the defect C3.190 removed. So the new hosts get
 * exactly one parser, called from all three, and the old ones keep theirs.
 *
 * **Bitbucket**: `bitbucket.org/<workspace>/<repo>[/src/<ref>[/<path>]]`. `src`
 * is the browse marker — the counterpart of GitHub's `tree` and GitLab's
 * `-/tree` — and any other marker (`commits`, `pull-requests`, `downloads`)
 * addresses something that is not a repository directory, so it is refused
 * rather than silently read as the repository root.
 *
 * **Azure DevOps**: `dev.azure.com/<organization>/<project>/_git/<repo>`. The
 * web UI addresses a directory and a version through the QUERY
 * (`?path=/x&version=GBmain`), not through path segments, so no ref or
 * subdirectory is taken from the path here; both arrive from the entry's own
 * `ref`/`subdirectory` fields or from a `#ref` pin, which is the documented
 * way (`plugins/cli-reference.md#plugin-marketplace-add`). Unread rather than
 * guessed: the `GB`/`GT`/`GC` prefixes that query uses are a web-UI convention
 * this lane could not verify against a page, and inventing a meaning for them is
 * exactly what the read-don't-invent rule forbids.
 */
export function parseBitbucketOrAzureRepositoryUrl(
  url: URL,
  env: Record<string, string | undefined> = process.env,
): ParsedRepositoryAddress | null {
  const kind = repositoryHostKind(url.hostname, env);
  if (kind !== 'bitbucket' && kind !== 'azure-devops') return null;
  const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (kind === 'bitbucket') {
    const [workspace, rawRepo, marker, ref, ...subdirectoryParts] = segments;
    if (!workspace || !rawRepo) return null;
    const repo = rawRepo.replace(/\.git$/, '');
    if (!repo) return null;
    if (marker !== undefined && marker !== 'src') return null;
    const browsing = marker === 'src';
    return {
      kind: 'bitbucket',
      repositoryUrl: `${url.origin}/${workspace}/${repo}`,
      owner: workspace,
      repo,
      ...(browsing && ref ? { ref: decodeURIComponent(ref) } : {}),
      ...(browsing && subdirectoryParts.length
        ? { subdirectory: subdirectoryParts.map(decodeURIComponent).join('/') }
        : {}),
    };
  }
  // `_git` must be the THIRD segment: `<organization>/<project>/_git/<repo>`.
  // A shorter form addresses the organization or the project, not a repository.
  if (segments[2] !== '_git' || segments.length !== 4) return null;
  const [organization, project] = segments;
  const repo = (segments[3] ?? '').replace(/\.git$/, '');
  if (!organization || !project || !repo) return null;
  return {
    kind: 'azure-devops',
    repositoryUrl: `${url.origin}/${organization}/${project}/_git/${repo}`,
    organization,
    project,
    repo,
  };
}
