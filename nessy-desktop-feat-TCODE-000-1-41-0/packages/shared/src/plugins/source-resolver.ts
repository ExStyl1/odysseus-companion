import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  PLUGIN_LIFECYCLE,
  type PluginDiagnostic,
  type PluginInstallPlan,
  type PluginInstallSource,
  type PluginMarketplaceInstallMetadata,
  type PluginOrigin,
  type PluginResolvedSource,
  type PluginScope,
  type PluginStagedInstall,
} from './types.ts';
import { pluginDiagnostic } from './schema.ts';
import {
  describeStructurallyUnroutableHost,
  describeSupportedRepositoryHosts,
  describeUnlistedGitLabLookalike,
  isSupportedRepositoryHost,
  parseBitbucketOrAzureRepositoryUrl,
  repositoryHostKind,
} from './repository-hosts.ts';

export const DEFAULT_PLUGIN_MARKETPLACE_ID = 'nessy-marketplace';
export const DEFAULT_PLUGIN_MARKETPLACE_BASE_URL = 'https://skills-market.t-tech.team/api/v1';

/**
 * C4 — the only git hosts this app has an acquisition route for. GitHub is
 * fetched through codeload and GitLab through `/api/v4/projects/:id/repository/
 * archive` (`acquisition.ts:normalizeRepositorySpec`); no other host has a
 * route at all. Claude's `url` source type is documented with no host
 * constraint and its docs name Bitbucket and AWS CodeCommit, so an entry on one
 * of those hosts is something we legitimately cannot install — but it used to
 * PARSE cleanly and be refused only after staging (and, for an `https://…​.git`
 * string, after a real archive download of the host's HTML landing page).
 *
 * The refusal is moved to resolution so the reason names the host instead of
 * blaming the URL. This does NOT widen the allowlist.
 *
 * **P3.219 — the staged route this comment used to name (C4b, extending the
 * archive route; C4c, a `git clone` fallback) belonged to no row, so the refusal
 * was a dead end rather than a deferral. The decision, and what it was read
 * from, so the next lane inherits the reasoning rather than the question:**
 *
 * WHICH SIDE GOVERNS. `plugins/marketplace-reference.md#url-plugin-source` gives the `url`
 * source's field as "Required. Full git repository URL (`https://` or `git@`).
 * The `.git` suffix is optional, so Azure DevOps and AWS CodeCommit URLs without
 * the suffix work", and `#plugin-sources` adds "On most git hosts, including
 * GitHub, GitLab, and Bitbucket, this means installation succeeds". Both source
 * kinds are host-agnostic and the documented mechanism is a git CLONE
 * (`git-subdir` is "a sparse, partial clone"). The vendored bundle does NOT lag
 * here — its plugin-source union already carries `url` and `git-subdir`, and
 * both predate every version gate on that page (`archive` 2.1.224, entry
 * `headers` 2.1.238) — so for this row the page and the bundle agree and there
 * is no disagreement to adjudicate. AGENTS.md's rule applies unchanged: the
 * documentation is the denominator for what we must be able to ACCEPT, and by
 * that denominator this app is narrower than the contract.
 *
 * WHAT IS NOT BUILT, AND WHY THAT IS A POSTURE RATHER THAN AN OVERSIGHT.
 * `acquisition.ts` has no child-process spawn at all — it is fetch-only by
 * construction ("no new network client, no git, no archive code of its own") —
 * and a clone route brings the git binary, credential-helper/SSH authentication,
 * egress policy and sandboxing with it. That is a decision about what this app
 * executes on a user's machine, not a parser change, so it is written down here
 * rather than taken quietly inside a lane.
 *
 * WHAT WORKS TODAY, which is what the refusal now says, because "cannot be
 * installed" with no route is the complaint this row is: an `archive` entry
 * (`#zip-archives` — an HTTPS zip, with an optional `sha256` pin and its own
 * `headers` credential since P6.39) and an `npm` entry (`#npm-packages`, private
 * registry included) are both fully supported here and both host-agnostic. A
 * corporate deployment on a self-hosted forge publishes one of those instead of
 * pointing at the repository.
 *
 * Measured while deciding, and it refuted the obvious worry: a catalog entry
 * that DECLARES itself a git source (`url`, `git-subdir`, `github`) resolves to
 * `kind: 'repository'` through
 * `external-catalog-adapters.ts:claudeRepositorySource` and is refused here
 * whatever its URL looks like — the `.git` test below never runs on it. That
 * test governs only a BARE STRING source, where the same page makes an
 * `https://` value an archive download rather than a repository, so widening it
 * would refuse working archive entries. The refusal is complete; the ROUTE is
 * what is missing.
 *
 * **C3.190 (owner answer QL9, 2026-09-11) widened the SET, not the posture.**
 * The single boolean this comment described — `github.com`, or any hostname
 * CONTAINING the substring `gitlab` — is now `repositoryHostKind`
 * (`./repository-hosts.ts`), shared with `acquisition.ts` and with the
 * `marketplace/` sibling that spelled the same test twice more. Our own git
 * host resolves; the substring is replaced by a DNS-label test, which is a
 * narrowing the refusal itself now names; Bitbucket, CodeCommit and Azure
 * DevOps stay refused for the fetch-only reason above, with the two working
 * routes named as before. The reasoning for each half is in that module's
 * header.
 */

export interface ResolvePluginInstallSourceOptions {
  cwd?: string;
  now?: () => number;
  defaultMarketplaceId?: string;
  defaultMarketplaceBaseUrl?: string;
}

export interface CreatePluginInstallPlanOptions extends ResolvePluginInstallSourceOptions {
  requestedScope?: PluginScope;
  diagnostics?: PluginDiagnostic[];
}

export function resolvePluginInstallSource(
  input: string | PluginInstallSource,
  options: ResolvePluginInstallSourceOptions = {},
): PluginResolvedSource {
  const now = options.now?.() ?? Date.now();
  const diagnostics: PluginDiagnostic[] = [];

  if (typeof input !== 'string') {
    return resolveClassifiedSource(input, now, options, diagnostics);
  }

  const trimmed = input.trim();
  if (!trimmed) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.source.empty', 'Plugin install source is empty'));
    const source: PluginInstallSource = {
      kind: 'unsupported',
      value: input,
      reason: 'empty',
    };
    return {
      state: 'resolved',
      source,
      origin: originForSource(source, now, options),
      diagnostics,
      resolvedAt: now,
    };
  }

  // `plugins/cli-reference.md#plugin-marketplace-add` — "`<source>`: GitHub
  // `owner/repo` shorthand, git URL, remote URL to a `marketplace.json` file, or
  // local directory path. To pin to a branch or tag, append `@ref` to the GitHub
  // shorthand or `#ref` to a git URL". Only the `@ref` half was implemented, so
  // the `#ref` half was DROPPED SILENTLY: a marketplace or plugin pinned to a
  // tag resolved to the repository's default branch with no `ref` and no
  // diagnostic — the branch the pin exists to avoid.
  const refPin = parseGitUrlRefPin(trimmed);
  const pinnedInput = refPin?.base ?? trimmed;

  const repositoryUrl = parseHostedRepositoryUrl(pinnedInput);
  if (repositoryUrl) {
    return resolveClassifiedSource(
      applyRefPin(repositoryUrl, refPin?.ref, diagnostics),
      now,
      options,
      diagnostics,
    );
  }

  if (/^https?:\/\//.test(trimmed)) {
    // Deliberately the RAW string, fragment included: an `https://` URL that is
    // not a hosted repository is a "remote URL to a `marketplace.json` file" in
    // the same sentence, and a fragment on one of those is part of the URL, not
    // a git ref. The unsupported-host refusal below still names it verbatim.
    return resolveClassifiedSource({ kind: 'url', url: trimmed }, now, options, diagnostics);
  }

  if (/^(git|ssh):\/\//.test(pinnedInput) || pinnedInput.endsWith('.git')) {
    // The scp-like form our own add dialog offers as an example
    // (`git@github.com:org/repo.git`) reaches this branch. Before the pin was
    // split off, appending the documented `#ref` to it turned a SUPPORTED source
    // into `unsupported` outright: the string no longer ended in `.git`, so
    // every test above failed and the shorthand pattern refused a string with a
    // `@`, `:` and `/` in it.
    return resolveClassifiedSource(
      {
        kind: 'repository',
        repositoryUrl: pinnedInput,
        ...(refPin?.ref ? { ref: refPin.ref } : {}),
      },
      now,
      options,
      diagnostics,
    );
  }

  const pathCandidate = resolve(options.cwd ?? process.cwd(), expandHome(trimmed));
  if (isPathLike(trimmed) || existsSync(pathCandidate)) {
    if (existsSync(pathCandidate) && !statSync(pathCandidate).isDirectory() && !statSync(pathCandidate).isFile()) {
      diagnostics.push(pluginDiagnostic('warning', 'plugin.source.unsupported_local_type', 'Local source is neither a file nor a directory'));
    }
    return resolveClassifiedSource({ kind: 'local-path', path: pathCandidate }, now, options, diagnostics);
  }

  // `plugins/marketplace-reference.md#github-plugin-source` — "`<source>`: GitHub `owner/repo` shorthand,
  // git URL, remote URL to a `marketplace.json` file, or local directory path.
  // To pin to a branch or tag, append `@ref` to the GitHub shorthand". Our own
  // add dialog offers the same form ("openai/plugins or git@github.com:org/repo.git")
  // and the managed-policy identity classifier has classified it since day one
  // (`managed-marketplace-entries.ts:GITHUB_SHORTHAND`) — this resolver was the
  // only layer that never learned it, so every shorthand registry classified
  // `unsupported`, took artifact type `unknown`, and failed in 4ms without a
  // single network call: `upgrade()` refused it as `not-git` and the browse
  // fetch died at `plugin.install.unknown_artifact`.
  //
  // Deliberately LAST, after the local-path probe: `owner/repo` is also a
  // legitimate relative directory, and an existing directory must keep winning.
  // This branch therefore only ever converts what used to be a hard error.
  //
  // Claude clones shorthand over SSH by default (`:553`); we resolve to the
  // HTTPS repository URL because codeload is the acquisition route this app has.
  const shorthand = parseGitHubShorthand(trimmed);
  if (shorthand) {
    return resolveClassifiedSource(
      {
        kind: 'repository',
        repositoryUrl: shorthand.repositoryUrl,
        ...(shorthand.ref ? { ref: shorthand.ref } : {}),
      },
      now,
      options,
      diagnostics,
    );
  }

  diagnostics.push(pluginDiagnostic(
    'error',
    'plugin.source.unsupported',
    'Plugin install source must be a local path, URL, hosted repository URL, GitHub owner/repo shorthand, or structured marketplace install source.',
    'source',
    { source: trimmed },
  ));
  const unsupportedSource: PluginInstallSource = {
    kind: 'unsupported',
    value: trimmed,
    reason: 'unrecognized-string',
  };
  return {
    state: 'resolved',
    source: unsupportedSource,
    origin: originForSource(unsupportedSource, now, options),
    artifact: artifactForSource(unsupportedSource),
    diagnostics,
    resolvedAt: now,
  };
}

/**
 * Shape the resolved result for an already-classified source, refusing an
 * unsupported git host HERE rather than letting it reach the staging layer.
 * Every classification branch funnels through this so the refusal cannot be
 * added to one shape and forgotten on another.
 */
/**
 * A marketplace entry whose source RUNS A COMMAND — P6.511.
 *
 * Structurally typed rather than matched against {@link PluginInstallSource},
 * and that is the finding this function was written for. Our union has no
 * `command` member, so before this the kind could not be REFUSED here at all: a
 * structured source with an unmodelled `kind` walked past
 * `unsupportedRepositoryHost` and fell out of the tail return as
 * `state: 'resolved'` with **zero diagnostics**. The row said the resolver
 * "refuses a `command` marketplace source"; measured, only the STRING path did,
 * and only through the generic unsupported-string message, which names the four
 * accepted shapes and says nothing about why a command is different.
 *
 * `plugin-marketplaces.md` added `command` as a marketplace-entry source kind,
 * and the vendored 2.1.247 bundle carries it. Delegated decision Q-den 42 chose
 * option 2: refuse it uniformly and close the claude leak, rather than keep
 * refusing quietly (option 1 — this fork's largest defect class exactly) or
 * accept it behind an approval (option 3, admissible only together with the
 * `headersHelper` decision, which landed on managed-only execution: P6.479,
 * owner decision 7 of 2026-09-05). The approval floor is therefore taken ONCE,
 * and the refusal text below names the same single exception that decision did.
 */
function isCommandMarketplaceSource(source: PluginInstallSource): boolean {
  return (source as { kind?: unknown }).kind === 'command';
}

function resolveClassifiedSource(
  source: PluginInstallSource,
  now: number,
  options: ResolvePluginInstallSourceOptions,
  diagnostics: PluginDiagnostic[],
): PluginResolvedSource {
  if (isCommandMarketplaceSource(source)) {
    const refused: PluginInstallSource = {
      kind: 'unsupported',
      value: 'command',
      reason: 'command-source-refused',
    };
    return {
      state: 'resolved',
      source: refused,
      origin: originForSource(refused, now, options),
      artifact: artifactForSource(refused),
      diagnostics: [
        ...diagnostics,
        pluginDiagnostic(
          'error',
          'plugin.source.command_refused',
          'This entry installs by RUNNING A COMMAND, which this app refuses on every runtime. '
          + 'A marketplace that can name a command can run it on every machine that adds the '
          + 'marketplace, before anyone has read the plugin. The only exception this product '
          + 'recognises is a marketplace declared by MANAGED settings — an administrator\'s own '
          + 'document, not a catalog entry and not a user-added source. Publish the plugin as an '
          + '"archive", "npm" or hosted-repository source and it installs from any host.',
          'source',
          { source: 'command' },
        ),
      ],
      resolvedAt: now,
    };
  }

  const refusedHost = unsupportedRepositoryHost(source);
  if (refusedHost) {
    const supportedHosts = describeSupportedRepositoryHosts();
    const lookalike = describeUnlistedGitLabLookalike(refusedHost.host);
    // C3.260 — a host that can never HAVE a route reads exactly like one that
    // merely lacks one, and the difference is the whole reason the row asked for
    // CodeCommit to be RECORDED rather than built.
    const structural = describeStructurallyUnroutableHost(refusedHost.host);
    const refused: PluginInstallSource = {
      kind: 'unsupported',
      value: refusedHost.url,
      reason: 'unsupported-repository-host',
    };
    return {
      state: 'resolved',
      source: refused,
      origin: originForSource(refused, now, options),
      artifact: artifactForSource(refused),
      diagnostics: [
        ...diagnostics,
        pluginDiagnostic(
          'error',
          'plugin.source.unsupported_repository_host',
          `Git repositories on "${refusedHost.host}" cannot be installed: this app has no clone route for that host, only for ${supportedHosts}. `
          // C3.190 — the one host shape this change made WORSE says so here,
          // and names the setting that brings it back. A hostname that merely
          // CONTAINED "gitlab" resolved before the label test replaced the
          // substring, and a host that worked yesterday reading as simply
          // unsupported is the silent-divergence shape this fork keeps paying
          // for.
          + (lookalike ? `${lookalike} ` : '')
          + (structural ?? '')
          + 'The entry itself is valid — publish the plugin as an "archive" source (an HTTPS zip, which may carry a "sha256" pin and its own "headers" credential) '
          + 'or as an "npm" source from your own registry, and it installs from any host.',
          'source',
          {
            host: refusedHost.host,
            supportedHosts,
            source: refusedHost.url,
            ...(structural ? { structurallyUnroutable: true } : {}),
            // P3.219 — named so a caller rendering this can offer the route
            // rather than only the refusal. Both are host-agnostic here.
            supportedAlternatives: ['archive', 'npm'],
          },
        ),
      ],
      resolvedAt: now,
    };
  }
  return {
    state: 'resolved',
    source,
    origin: originForSource(source, now, options),
    artifact: artifactForSource(source),
    diagnostics,
    resolvedAt: now,
  };
}

/**
 * The host of a git-repository-shaped source we have no acquisition route for,
 * or `undefined` when the source is fine (or is not repository-shaped at all).
 *
 * Deliberately narrow in two directions. An UNPARSEABLE repository URL is never
 * refused — `git@github.com:owner/repo.git` and a `git-subdir` entry's bare
 * `owner/repo` shorthand (190 of the community catalogue's 2307 entries) both
 * fail `new URL`, and refusing what we cannot read would refuse them. And a
 * plain `url` source is only judged when its path ends in `.git`: an archive or
 * manifest URL on any host stays a supported route, which is the whole reason
 * this is not a blanket host check.
 */
function unsupportedRepositoryHost(source: PluginInstallSource): { host: string; url: string } | undefined {
  const candidate = source.kind === 'repository'
    ? source.repositoryUrl
    : source.kind === 'url' && looksLikeGitRepositoryUrl(source.url)
      ? source.url
      : undefined;
  if (!candidate) return undefined;
  let host: string;
  try {
    host = new URL(candidate).hostname;
  } catch {
    return undefined;
  }
  if (!host || isSupportedRepositoryHost(host)) return undefined;
  return { host, url: candidate };
}

/**
 * A `.git` URL is a git repository someone pasted, not an archive. On a
 * supported host `parseHostedRepositoryUrl` has already claimed it, so what
 * reaches the `url` branch with this shape is exactly the unsupported-host case
 * — which the archive route answered by downloading the host's HTML page.
 */
/** The `mkdtemp` prefix every plugin staging directory carries. */
const PLUGIN_STAGE_PREFIX = 'nessy-plugin-stage-';

/** The ownership marker {@link createPluginStagingArea} writes into each stage. */
const PLUGIN_STAGE_OWNER_MARKER = '.nessy-stage-owner.json';

/**
 * How old an abandoned stage must be before the sweep will remove it.
 *
 * The liveness check below is the real guard; this floor is the belt. A stage
 * younger than this is left alone whatever its marker says, so a sweep racing a
 * *just-started* install — in this process or another — cannot win.
 */
const PLUGIN_STAGE_SWEEP_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/** Is a process with this pid running? Wrapped so a test can drive both arms. */
function pidIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check and sends nothing.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it EXISTS and is someone else's — alive for our purposes.
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

/**
 * D1.187 — remove plugin staging directories a crash left behind.
 *
 * `releaseSessionScopedPlugins` runs on `deleteSession` and on `cleanup()`, so
 * an ordinary quit and an explicit delete both clean up; a hard kill does not,
 * and the directory then lives under the OS temp root until the OS reaps it.
 * This is the startup half, and it is a SWEEP rather than a lease: the same
 * shape `PluginStoreV2.pruneOnStartup` already has, called from the same place.
 *
 * ## What it refuses to touch, and why each refusal is the safe direction
 *
 *  - **A directory with no marker.** It is either from a build older than this
 *    row or not ours at all, and a temp root is shared with every other program
 *    on the machine. Deleting on a NAME match alone would make this function's
 *    blast radius a string literal.
 *  - **A marker naming a LIVE pid.** `process.kill(pid, 0)` answers existence,
 *    and `EPERM` — the process exists and belongs to another user — counts as
 *    alive. Pid reuse can only make a dead owner look alive, which costs one
 *    skipped directory; it cannot make a live owner look dead.
 *  - **A stage younger than {@link PLUGIN_STAGE_SWEEP_MIN_AGE_MS}.** Belt to the
 *    liveness braces, and the one that covers a marker written moments before
 *    its own process is examined.
 *  - **An unreadable or malformed marker.** Same rule as the missing one: this
 *    function removes only what it can prove is ours and finished.
 *
 * Best-effort throughout: a startup path is not a place to fail, and every
 * failure arm leaves the directory exactly where it was. Returns the number of
 * directories removed so a caller can log it.
 */
export async function sweepAbandonedPluginStages(
  options: {
    baseTempDir?: string;
    now?: () => number;
    minimumAgeMs?: number;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): Promise<number> {
  const base = options.baseTempDir ?? tmpdir();
  const now = options.now?.() ?? Date.now();
  const minimumAgeMs = options.minimumAgeMs ?? PLUGIN_STAGE_SWEEP_MIN_AGE_MS;
  const isAlive = options.isProcessAlive ?? pidIsAlive;

  let entries: string[];
  try {
    entries = (await readdir(base, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith(PLUGIN_STAGE_PREFIX)) continue;
    const directory = join(base, name);
    let marker: { pid?: unknown; createdAt?: unknown };
    try {
      marker = JSON.parse(await readFile(join(directory, PLUGIN_STAGE_OWNER_MARKER), 'utf-8')) as typeof marker;
    } catch {
      continue;
    }
    const pid = typeof marker.pid === 'number' && Number.isInteger(marker.pid) && marker.pid > 0
      ? marker.pid
      : undefined;
    const createdAt = typeof marker.createdAt === 'number' ? marker.createdAt : undefined;
    if (pid === undefined || createdAt === undefined) continue;
    if (now - createdAt < minimumAgeMs) continue;
    if (isAlive(pid)) continue;
    try {
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      // The temp root owns it from here; the next startup will try again.
    }
  }
  return removed;
}

/**
 * A path segment that names a file we would FETCH rather than a repository we
 * would archive: the documented `marketplace.json` remote URL, and the archive
 * shapes an `archive` source is published as. `.git` is deliberately absent —
 * that suffix marks a repository, and the branch above strips it.
 */
function looksLikeFetchableFile(segment: string): boolean {
  return /\.(?:json|zip|tar|tgz|tar\.gz|gz|bz2|xz|tar\.bz2|tar\.xz)$/i.test(segment);
}

function looksLikeGitRepositoryUrl(value: string): boolean {
  try {
    return new URL(value).pathname.toLowerCase().endsWith('.git');
  } catch {
    return false;
  }
}

export function createPluginInstallPlan(
  input: string | PluginInstallSource | PluginResolvedSource,
  options: CreatePluginInstallPlanOptions = {},
): PluginInstallPlan {
  const resolved = isResolvedSource(input)
    ? input
    : resolvePluginInstallSource(input, options);
  const createdAt = options.now?.() ?? Date.now();
  const diagnostics = [...resolved.diagnostics, ...(options.diagnostics ?? [])];
  return {
    state: 'resolved',
    planId: createPlanId(resolved.source, createdAt),
    source: resolved.source,
    origin: resolved.origin,
    ...(options.requestedScope ? { requestedScope: options.requestedScope } : {}),
    ...(resolved.artifact ? { artifact: resolved.artifact } : {}),
    diagnostics,
    createdAt,
    lifecycle: PLUGIN_LIFECYCLE,
  };
}

export async function createPluginStagingArea(
  plan: PluginInstallPlan,
  options: { baseTempDir?: string; now?: () => number } = {},
): Promise<PluginStagedInstall> {
  const base = options.baseTempDir ?? tmpdir();
  await mkdir(base, { recursive: true });
  const stageDirectory = await mkdtemp(join(base, PLUGIN_STAGE_PREFIX));
  const rawDirectory = join(stageDirectory, 'raw');
  const normalizedDirectory = join(stageDirectory, 'normalized');
  await mkdir(rawDirectory, { recursive: true });
  await mkdir(normalizedDirectory, { recursive: true });
  const stagedAt = options.now?.() ?? Date.now();
  // D1.187 — the ownership marker, written before anything else lands in the
  // stage. It is what lets {@link sweepAbandonedPluginStages} tell a directory
  // THIS machine abandoned from one another process is using right now, and it
  // is deliberately two numbers and no path: a temp root is world-readable.
  await writeFile(
    join(stageDirectory, PLUGIN_STAGE_OWNER_MARKER),
    `${JSON.stringify({ pid: process.pid, createdAt: stagedAt })}\n`,
    { encoding: 'utf-8', mode: 0o600 },
  );
  const stagedPlan: PluginInstallPlan = {
    ...plan,
    state: 'staged',
    stagedAt,
    stage: {
      directory: stageDirectory,
      rawDirectory,
      normalizedDirectory,
    },
  };
  return {
    state: 'staged',
    plan: stagedPlan,
    stageDirectory,
    rawDirectory,
    normalizedDirectory,
    stagedAt,
    diagnostics: [...plan.diagnostics],
  };
}

function isResolvedSource(input: string | PluginInstallSource | PluginResolvedSource): input is PluginResolvedSource {
  return typeof input === 'object' && input !== null && 'state' in input && input.state === 'resolved' && 'source' in input;
}

/**
 * P6.426 — MEASURED 2026-09-06, at HEAD. The four questions the row asks about
 * the plugin cache's version model, each answered with a file:line or a null.
 * Recorded HERE because this switch is where a reader asks "what version does
 * this source kind resolve to?", and the answer is: none of them decides it.
 *
 * 1. **Per-version layout — PRESENT.** `workspaces/paths.ts:99-110`
 *    (`getPluginCachePath`) lays the cache out as
 *    `<enc(marketplaceId)>/<enc(pluginId)>/<enc(version)>/<bundleHash>`, so each
 *    installed version is its own directory, grouped by marketplace then plugin,
 *    exactly as `plugins-reference.md` § *Plugin caching and file resolution*
 *    describes. We add a content-address level the page does not have.
 *
 * 2. **~14-day orphan sweep — ABSENT, and deliberately so.** The page: "Claude
 *    Code marks the previous version directory as orphaned and removes it in a
 *    background sweep roughly 14 days later." Ours prunes IMMEDIATELY —
 *    `store-v2.ts:402-425` (`pruneInactiveInstancesLocked`) `rm`s any instance
 *    that is not active, not journalled and not leased; there is no orphan mark
 *    and no time grace (`DAY`/`14 * 24`/`days` all score 0 in `store-v2.ts` and
 *    `management-service-v2.ts`). The page's grace exists to protect concurrent
 *    sessions that already loaded the old version; we protect the same thing
 *    with an explicit LEASE (`store-v2.ts:355-373`) instead of a timer, which is
 *    strictly tighter. Not a gap — a different, host-owned mechanism.
 *
 * 3. **Glob/Grep exclusion of orphaned directories — NULL, and vacuous.** The
 *    page: "Claude's Glob and Grep tools skip orphaned version directories."
 *    `PLUGIN_CACHE_DIR` / `plugins/cache` reach no search surface
 *    (`agent/claude-search-result-filter.ts` is the positive control: the
 *    Grep/Glob result seam EXISTS and filters `deniedPaths` only). There is
 *    nothing to exclude, because (2) leaves no orphaned directory on disk.
 *
 * 4. **Version resolution — the page's five steps, four of them wired (P6.577).**
 *    None of the nine kinds below carries a version: every kind mints provenance
 *    only, and the version is taken from the materialized manifest
 *    (`management-service-v2.ts:967`). Steps 1 and 2 — `plugin.json`'s `version`
 *    then the marketplace entry's — are the format adapter's
 *    (`format-adapters/claude.ts`). Steps 3-5 are `plugin-version-chain.ts`,
 *    applied at install by `acquisition.ts:resolveInstalledPluginVersion`: the
 *    commit SHA, the archive digest shortened to 12 characters (the entry's
 *    `sha256` pin, or the digest of the file actually downloaded), and the floor
 *    `unknown`. The npm arm is the one place we are richer than the page rather
 *    than poorer: `selectNpmVersionName` resolves exact → widened-within-base →
 *    dist-tag-latest where the page says `unknown`.
 *
 *    This paragraph said "SHORTER THAN THE PAGE BY THREE STEPS" until P6.577,
 *    and the consequence it recorded was real: a source declaring no version
 *    collapsed every revision onto `0.0.0`, so the page's update DETECTION,
 *    which keys on the version string, could never fire. Cache SEPARATION was
 *    never at risk (the `<bundleHash>` level below the version keeps the bytes
 *    apart) and is untouched.
 *
 *    **Step 3 remains a measured null and the reason is here, one layer from
 *    where it would be produced:** these kinds resolve a `ref`, which is a
 *    branch name, and `fetchRepositoryArtifact` downloads a tarball through the
 *    host's archive endpoint rather than cloning — so no resolved commit exists
 *    to carry. The chain accepts one from any caller that has one.
 */
function originForSource(
  source: PluginInstallSource,
  resolvedAt: number,
  options: ResolvePluginInstallSourceOptions,
): PluginOrigin {
  switch (source.kind) {
    case 'marketplace-npm-package':
      return {
        source: 'marketplace',
        marketplaceId: source.marketplace?.marketplaceId ?? options.defaultMarketplaceId ?? DEFAULT_PLUGIN_MARKETPLACE_ID,
        marketplaceBaseUrl: source.marketplace?.marketplaceBaseUrl ?? options.defaultMarketplaceBaseUrl ?? DEFAULT_PLUGIN_MARKETPLACE_BASE_URL,
        sourceUrl: source.marketplace?.sourceUrl ?? source.registry,
        resolvedAt,
        provenance: marketplaceProvenance(source.marketplace, {
          packageName: source.packageName,
          version: source.version ?? source.marketplace?.version ?? null,
          // Repair/update must use the exact acquisition endpoint and pinned
          // integrity from the original install. Dropping these fields makes
          // an internal package silently fall back to registry.npmjs.org.
          registry: source.registry ?? null,
          integrity: source.integrity ?? null,
        }),
      };
    case 'marketplace-gitlab-skill':
      return {
        source: 'marketplace',
        marketplaceId: source.marketplace?.marketplaceId ?? options.defaultMarketplaceId ?? DEFAULT_PLUGIN_MARKETPLACE_ID,
        marketplaceBaseUrl: source.marketplace?.marketplaceBaseUrl ?? options.defaultMarketplaceBaseUrl ?? DEFAULT_PLUGIN_MARKETPLACE_BASE_URL,
        sourceUrl: source.url,
        resolvedAt,
        provenance: marketplaceProvenance(source.marketplace, {
          skillSlug: source.skillSlug,
          path: source.path ?? null,
          ref: source.ref ?? null,
        }),
      };
    case 'marketplace-skill-files':
      return {
        source: 'marketplace',
        marketplaceId: source.marketplace?.marketplaceId ?? options.defaultMarketplaceId ?? DEFAULT_PLUGIN_MARKETPLACE_ID,
        marketplaceBaseUrl: source.marketplace?.marketplaceBaseUrl ?? options.defaultMarketplaceBaseUrl ?? DEFAULT_PLUGIN_MARKETPLACE_BASE_URL,
        sourceUrl: source.filesUrl,
        resolvedAt,
        provenance: marketplaceProvenance(source.marketplace, {
          skillSlug: source.skillSlug,
        }),
      };
    case 'marketplace-url':
      return {
        source: 'marketplace',
        marketplaceId: source.marketplace?.marketplaceId ?? options.defaultMarketplaceId ?? DEFAULT_PLUGIN_MARKETPLACE_ID,
        marketplaceBaseUrl: source.marketplace?.marketplaceBaseUrl ?? options.defaultMarketplaceBaseUrl ?? DEFAULT_PLUGIN_MARKETPLACE_BASE_URL,
        sourceUrl: source.url,
        resolvedAt,
        provenance: marketplaceProvenance(source.marketplace, {
          expectedHash: source.expectedHash ?? null,
        }),
      };
    case 'url':
      return { source: 'url', sourceUrl: source.url, resolvedAt };
    case 'repository':
      if (source.marketplace) {
        return {
          source: 'marketplace',
          marketplaceId: source.marketplace.marketplaceId ?? options.defaultMarketplaceId ?? DEFAULT_PLUGIN_MARKETPLACE_ID,
          marketplaceBaseUrl: source.marketplace.marketplaceBaseUrl ?? options.defaultMarketplaceBaseUrl ?? DEFAULT_PLUGIN_MARKETPLACE_BASE_URL,
          repositoryUrl: source.repositoryUrl,
          sourceUrl: source.marketplace.sourceUrl ?? source.repositoryUrl,
          resolvedAt,
          provenance: marketplaceProvenance(source.marketplace, {
            ref: source.ref ?? null,
            subdirectory: source.subdirectory ?? null,
          }),
        };
      }
      return { source: 'repository', repositoryUrl: source.repositoryUrl, resolvedAt };
    case 'local-path':
      if (source.marketplace) {
        return {
          source: 'marketplace',
          marketplaceId: source.marketplace.marketplaceId ?? options.defaultMarketplaceId ?? DEFAULT_PLUGIN_MARKETPLACE_ID,
          ...(source.marketplace.marketplaceBaseUrl
            ? { marketplaceBaseUrl: source.marketplace.marketplaceBaseUrl }
            : {}),
          ...(source.marketplace.sourceUrl ? { sourceUrl: source.marketplace.sourceUrl } : {}),
          localPath: source.path,
          resolvedAt,
          provenance: marketplaceProvenance(source.marketplace, { local: true }),
        };
      }
      return { source: 'local-path', localPath: source.path, resolvedAt };
    case 'agent-proposed':
      return {
        ...originForSource(source.source, resolvedAt, options),
        source: 'agent-proposed',
        provenance: { label: source.label, rationale: source.rationale ?? null },
      };
    case 'unsupported':
      return {
        source: 'unknown',
        resolvedAt,
        provenance: {
          value: source.value,
          reason: source.reason,
        },
      };
  }
}

function marketplaceProvenance(
  marketplace: PluginMarketplaceInstallMetadata | undefined,
  extra: NonNullable<PluginOrigin['provenance']> = {},
): NonNullable<PluginOrigin['provenance']> {
  return {
    itemId: marketplace?.itemId ?? null,
    listKind: marketplace?.listKind ?? null,
    itemKind: marketplace?.itemKind ?? null,
    name: marketplace?.name ?? null,
    version: marketplace?.version ?? null,
    sourceUrl: marketplace?.sourceUrl ?? null,
    packageName: marketplace?.packageName ?? null,
    ...extra,
  };
}

function artifactForSource(source: PluginInstallSource) {
  switch (source.kind) {
    case 'marketplace-npm-package':
      return {
        type: 'npm-package' as const,
        packageName: source.packageName,
        ...(source.version ? { version: source.version } : {}),
        ...(source.registry ? { registry: source.registry } : {}),
        ...(source.integrity ? { integrity: source.integrity } : {}),
        display: `${source.packageName}${source.version ? `@${source.version}` : ''}`,
      };
    case 'marketplace-gitlab-skill':
      return {
        type: 'gitlab-skill' as const,
        url: source.url,
        ...(source.ref ? { ref: source.ref } : {}),
        ...(source.path ? { path: source.path } : {}),
        pluginId: source.pluginId,
        skillSlug: source.skillSlug,
        ...(source.name ? { name: source.name } : {}),
        ...(source.version ? { version: source.version } : {}),
      };
    case 'marketplace-skill-files':
      return {
        type: 'skill-files' as const,
        filesUrl: source.filesUrl,
        pluginId: source.pluginId,
        skillSlug: source.skillSlug,
        ...(source.name ? { name: source.name } : {}),
        ...(source.version ? { version: source.version } : {}),
      };
    case 'marketplace-url':
      if (looksLikeJsonUrl(source.url)) {
        return { type: 'manifest-url' as const, url: source.url, manifestUrl: source.url, ...(source.expectedHash ? { expectedHash: source.expectedHash } : {}) };
      }
      return { type: 'archive-url' as const, url: source.url, ...(source.expectedHash ? { expectedHash: source.expectedHash } : {}) };
    case 'url':
      // `expectedHash` has always been part of this source type and was dropped
      // here, so nothing that produced a pinned `url` source could ever have it
      // verified. `plugin-marketplaces.md` § Zip archives makes that reachable:
      // an `archive` entry's `sha256` — "Claude Code verifies every download
      // against it and refuses the install on a mismatch" — arrives on exactly
      // this shape, and `acquisition.ts:fetchArchiveUrlArtifact` only checks a
      // pin the artifact carries.
      // `headers` rides the artifact for the same reason `expectedHash` does:
      // the downloader only ever reads the artifact, so a field left behind here
      // is a field that silently never applies — which for this one means the
      // 401 `plugins/host-marketplace.md#authenticate-archive-downloads` describes.
      return {
        type: 'archive-url' as const,
        url: source.url,
        ...(source.expectedHash ? { expectedHash: source.expectedHash } : {}),
        ...(source.headers ? { headers: source.headers } : {}),
      };
    case 'repository':
      return { type: 'repository' as const, url: source.repositoryUrl };
    case 'local-path':
      return { type: 'local-path' as const, path: source.path };
    case 'agent-proposed':
      return artifactForSource(source.source);
    case 'unsupported':
      return { type: 'unknown' as const, display: source.value };
  }
}

/**
 * Classify a hosted repository URL. Only `tree` is a directory marker: a `blob`
 * (or `raw`, `commits`, `issues`, …) marker addresses something that is NOT a
 * repository directory, and treating it as one silently DROPPED both the ref
 * and the path — `…/-/blob/main/skills/x/SKILL.md` resolved to the whole
 * repository at its default branch. Refusing to classify it is what
 * `install-source.ts:parseGitLabRepositorySource` already does; a file-shaped
 * GitLab URL has its own route (`acquisition.ts:isGitLabBlobUrl`, the
 * gitlab-skill artifact), and this classifier is not it.
 */
function parseHostedRepositoryUrl(input: string): PluginInstallSource | null {
  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    const segments = path.split('/').filter(Boolean);
    if (repositoryHostKind(url.hostname) === 'github' && segments.length >= 2) {
      const [owner, rawRepo, marker, ref, ...subdirectoryParts] = segments;
      if (!owner || !rawRepo) return null;
      const repo = rawRepo.replace(/\.git$/, '');
      if (!repo) return null;
      if (marker !== undefined && marker !== 'tree') return null;
      const source: PluginInstallSource = {
        kind: 'repository',
        repositoryUrl: `${url.origin}/${owner}/${repo}`,
        ...(ref ? { ref: decodeURIComponent(ref) } : {}),
        ...(subdirectoryParts.length ? { subdirectory: subdirectoryParts.map(decodeURIComponent).join('/') } : {}),
      };
      return source;
    }
    if (repositoryHostKind(url.hostname) === 'gitlab' && segments.length >= 2) {
      const treeIndex = segments.indexOf('-');
      const repoSegments = treeIndex >= 0 ? segments.slice(0, treeIndex) : segments;
      const marker = treeIndex >= 0 ? segments[treeIndex + 1] : undefined;
      if (marker !== undefined && marker !== 'tree') return null;
      const ref = treeIndex >= 0 ? segments[treeIndex + 2] : undefined;
      const subdirectoryParts = treeIndex >= 0 ? segments.slice(treeIndex + 3) : [];
      if (repoSegments.length < 2) return null;
      // C3.190, measured at HEAD before the widening:
      // `https://gitlab.example.com/team/marketplace.json` resolved to
      // `kind: 'repository'` with `repositoryUrl` ending in `.json` — the
      // documented "remote URL to a `marketplace.json` file"
      // (`plugins/cli-reference.md#plugin-marketplace-add`) swallowed by the
      // repository branch on every GitLab host. The GitHub branch cannot hit
      // this: it takes exactly `owner/repo` and stops. Left unguarded, the
      // widened host set would have carried the same defect onto our own git
      // host, so the last segment is required not to be a FILE.
      if (looksLikeFetchableFile(repoSegments[repoSegments.length - 1] ?? '')) return null;
      const repositoryPath = repoSegments.join('/').replace(/\.git$/, '');
      return {
        kind: 'repository',
        repositoryUrl: `${url.origin}/${repositoryPath}`,
        ...(ref ? { ref: decodeURIComponent(ref) } : {}),
        ...(subdirectoryParts.length ? { subdirectory: subdirectoryParts.map(decodeURIComponent).join('/') } : {}),
      };
    }
    // C3.260 — the two hosts added here share ONE parser
    // (`repository-hosts.ts` symbol `parseBitbucketOrAzureRepositoryUrl`),
    // because the two branches above are each spelled in three files. The
    // file-shaped-last-segment guard is applied here too rather than inside it:
    // a `marketplace.json` at `<workspace>/marketplace.json` is the documented
    // "remote URL to a marketplace.json file", and it is the defect C3.190
    // found on the GitLab branch, arriving on a new host.
    const added = parseBitbucketOrAzureRepositoryUrl(url);
    if (added && !looksLikeFetchableFile(added.repo)) {
      return {
        kind: 'repository',
        repositoryUrl: added.repositoryUrl,
        ...(added.ref ? { ref: added.ref } : {}),
        ...(added.subdirectory ? { subdirectory: added.subdirectory } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Split a trailing `#ref` pin off a git URL.
 *
 * `plugins/cli-reference.md#plugin-marketplace-add` — "To pin to a branch or tag,
 * append `@ref` to the GitHub shorthand or `#ref` to a git URL".
 *
 * The FIRST `#` delimits, matching both RFC 3986 and `URL.hash`, so a hosted URL
 * split here and the same URL handed to `new URL` agree on where the fragment
 * begins. An empty pin (`…#`) is not a pin: `URL.hash` is `''` for it too, so
 * treating it as one would make the two disagree on the only case where the
 * fragment is absent.
 *
 * Returns `undefined` when there is no pin, so a caller that never consumes one
 * — a local path, whose filename may legitimately contain `#` — keeps the raw
 * string it was given.
 */
function parseGitUrlRefPin(value: string): { base: string; ref: string } | undefined {
  const hash = value.indexOf('#');
  if (hash <= 0) return undefined;
  const ref = value.slice(hash + 1).trim();
  if (!ref) return undefined;
  return { base: value.slice(0, hash), ref };
}

/**
 * Attach a `#ref` pin to an already-classified hosted repository source.
 *
 * A GitHub/GitLab BROWSE url can carry a ref of its own in the path
 * (`…/tree/<ref>/<subdir>`), so a pinned browse url names two refs. The
 * documentation is silent on which wins — no page, no reference — so this is
 * decided here rather than queued: the `#ref` pin wins, because it is the only
 * form the `<source>` grammar calls a pin and it is the part the user appended
 * last. A DIFFERENT path ref is not overridden quietly; the diagnostic names
 * both, so the choice is visible to whoever meets it.
 */
function applyRefPin(
  source: PluginInstallSource,
  ref: string | undefined,
  diagnostics: PluginDiagnostic[],
): PluginInstallSource {
  if (!ref || source.kind !== 'repository') return source;
  if (source.ref && source.ref !== ref) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.source.ref_pin_overrides_url_ref',
      `Source URL names ref "${source.ref}" and is pinned to "#${ref}"; the "#${ref}" pin is used.`,
      'source',
      { urlRef: source.ref, pinnedRef: ref },
    ));
  }
  return { ...source, ref };
}

/**
 * GitHub `owner/repo` shorthand, deliberately a STRICT SUBSET of the pattern the
 * managed-policy identity classifier accepts
 * (`managed-marketplace-entries.ts:GITHUB_SHORTHAND`).
 *
 * The subset direction is the security-relevant one and must not be inverted:
 * `strictKnownMarketplaces` is enforced against what that classifier calls a
 * github.com shorthand, so anything this resolver is willing to CLONE has to be
 * something the allowlist already judged. A wider pattern here would fetch a
 * source the allowlist never classified; a narrower one only refuses, which is
 * safe.
 *
 * Owner excludes `.` (GitHub owners are alphanumeric + hyphen), which is also
 * what implements `:955` — "A URL must include its scheme. As of Claude Code
 * v2.1.196, a host typed without one, such as `gitlab.example.com/team/plugins`,
 * is rejected as an invalid `owner/repo` shorthand". A two-segment path fails on
 * the single-slash shape; a one-segment `gitlab.example.com/team` fails on the
 * dotted owner. Repo keeps `.` (real repo names carry one) but may not START
 * with one, so `./x` and `../evil` can never be shorthand-shaped.
 */
const GITHUB_OWNER_REPO_SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/**
 * Resolve a bare GitHub shorthand to its HTTPS repository URL, honoring the
 * `@ref` pin from the second half of `plugins/marketplace-reference.md#github-plugin-source` ("To pin to a
 * branch or tag, append `@ref` to the GitHub shorthand"). Returns undefined for
 * anything that is not shorthand-shaped, so the caller can fall through to its
 * unsupported-source diagnostic.
 *
 * A repository name cannot contain `@`, so the LAST `@` is unambiguously the
 * ref delimiter.
 */
function parseGitHubShorthand(
  value: string,
): { repositoryUrl: string; ref?: string } | undefined {
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf('@');
  const repoPart = at > 0 ? trimmed.slice(0, at) : trimmed;
  const ref = at > 0 ? trimmed.slice(at + 1).trim() : '';
  // An `@` with nothing after it is a typo, not a pin to the default branch.
  if (at > 0 && !ref) return undefined;
  if (!GITHUB_OWNER_REPO_SHORTHAND.test(repoPart)) return undefined;
  return {
    repositoryUrl: `https://github.com/${repoPart}`,
    ...(ref ? { ref } : {}),
  };
}

function createPlanId(source: PluginInstallSource, createdAt: number): string {
  const hash = createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 12);
  return `plugin-plan-${createdAt}-${hash}`;
}

function looksLikeJsonUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname.endsWith('.json');
  } catch {
    return false;
  }
}

function isPathLike(input: string): boolean {
  return input.startsWith('.') || input.startsWith('~') || isAbsolute(input);
}

function expandHome(input: string): string {
  if (input === '~') return process.env.HOME ?? input;
  if (input.startsWith('~/')) return join(process.env.HOME ?? '', input.slice(2));
  return input;
}
