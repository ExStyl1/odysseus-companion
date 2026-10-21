/**
 * The plugin version chain — `plugins/loading.md#how-claude-code-computes-the-version`, all
 * five steps, in one place (P6.577).
 *
 * The page, fetched 2026-09-07 from
 * `https://code.claude.com/docs/en/plugins-reference.md`, says what the version
 * is FOR before it says how it is resolved, and the purpose is the whole reason
 * this module exists:
 *
 *   "Claude Code uses the plugin's version as the cache key that determines
 *   whether an update is available. When you run `/plugin update` or auto-update
 *   fires, Claude Code computes the current version and skips the update if it
 *   matches what's already installed."
 *
 * and then:
 *
 *   "For every source type except `command`, Claude Code resolves the version
 *   from the first of these that is set:
 *    1. The `version` field in the plugin's `plugin.json`
 *    2. The `version` field in the plugin's marketplace entry in `marketplace.json`
 *    3. The git commit SHA of the plugin's source, for `github`, `url`,
 *       `git-subdir`, and relative-path sources in a git-hosted marketplace
 *    4. The SHA-256 digest, for `archive` sources: the `sha256` pin in the
 *       marketplace entry, or the digest of the downloaded file when you set no
 *       pin. Claude Code shortens it to the first 12 characters
 *    5. `unknown`, for `npm` sources or local directories not inside a git
 *       repository"
 *
 * ## What this fork had, and what it cost
 *
 * Steps 1 and 2 were implemented (`format-adapters/claude.ts`), step 5 was
 * spelled `'0.0.0'` ({@link UNDECLARED_PLUGIN_VERSION}), and steps 3 and 4 did
 * not exist on the install path at all. The consequence is the row's title: a
 * source that declares no version collapsed EVERY revision onto one string, so
 * the page's update DETECTION — which keys on the version — could never fire.
 * Cache SEPARATION was never at risk (the `<bundleHash>` level below the version
 * keeps the bytes apart), and this module does not touch it.
 *
 * ## What is wired, and the one step that has no producer
 *
 * Step 4 is wired on both of its halves: the `sha256` PIN reaches
 * `marketplace/registry-catalog-items.ts` as the url source's `expectedHash`,
 * and the DOWNLOADED digest is computed in `acquisition.ts` at the one place the
 * archive's bytes are in hand.
 *
 * **Step 3 has no producer in this fork today, and that is a measured null, not
 * an omission.** Our repository installs do not clone: `fetchRepositoryArtifact`
 * downloads a tarball through the host's archive endpoint, so there is no local
 * git directory to `rev-parse` and nothing in `PluginInstallSource` carries a
 * resolved commit — `ref` is whatever the entry named, which is usually a branch
 * and is not a SHA. The one place a real commit SHA does exist is a dependency
 * resolved at a release tag (`version-tags.ts:PluginVersionTag.commitSha`), and
 * there the tag's own semver already answers step 2. Producing it generally
 * would cost one call on the repository API seam that `listRepositoryTags`
 * already uses (`GET …/commits/<ref>` → `sha`) — a network round trip per
 * install, which is a decision with a cost, not a refactor. So the step is
 * IMPLEMENTED here and takes `commitSha` from any caller that has one; no value
 * is invented for the callers that do not.
 *
 * The page's `command`-source rule — "a 12-character content hash on its own, or
 * appended to the `plugin.json` version as `<version>-<hash>`" — is deliberately
 * NOT implemented: this fork refuses a `command` plugin source outright
 * (`source-resolver.ts`), so the rule has no subject. Writing it would be dead
 * code guarding a source kind that cannot reach here. If that refusal is ever
 * lifted (P6.511), this is the module the rule belongs in.
 */
// Both placeholders live in `types.ts`, beside each other and beside the
// manifest that carries them, so a display rule can ask ONE module whether a
// version string names a version. Re-exported here because this module is where
// a reader arrives looking for the chain.
import { isPlaceholderPluginVersion, UNKNOWN_PLUGIN_VERSION } from './types.ts';

export { isPlaceholderPluginVersion, UNKNOWN_PLUGIN_VERSION };

/**
 * Step 4's shortening: "Claude Code shortens it to the first 12 characters".
 *
 * Accepts the two spellings a digest reaches us in — bare 64-hex, and the
 * `sha256-<64 hex>` form `external-catalog-adapters.ts:resolveClaudeArchiveSource`
 * normalises a marketplace entry's `sha256` pin into. Anything else returns
 * `undefined`: a digest we cannot recognise is not a version, and guessing at
 * one would key the cache on a string no other step could reproduce.
 */
export function shortenArchiveDigest(digest: string | undefined): string | undefined {
  if (!digest) return undefined;
  const match = /^(?:sha256[-:])?([0-9a-f]{64})$/i.exec(digest.trim());
  return match ? match[1]!.toLowerCase().slice(0, 12) : undefined;
}

export interface PluginVersionChainInput {
  /** Step 1 — `plugin.json`'s own `version`. The adapter's placeholder counts as absent. */
  readonly manifestVersion?: string | undefined;
  /** Step 2 — the marketplace entry's `version`. */
  readonly entryVersion?: string | undefined;
  /** Step 3 — a RESOLVED commit SHA, when the caller has one. Never a ref name. */
  readonly commitSha?: string | undefined;
  /** Step 4 — the `sha256` pin, or the downloaded archive's digest when unpinned. */
  readonly archiveDigest?: string | undefined;
}

/**
 * Resolve one plugin's version by the documented chain, or {@link
 * UNKNOWN_PLUGIN_VERSION} when no step answers.
 *
 * Pure. Every caller passes what it has and nothing it does not: an absent input
 * is the page's "not set", and that is the only thing that moves the chain to
 * the next step.
 */
export function resolvePluginVersionChain(input: PluginVersionChainInput): string {
  const declared = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed || isPlaceholderPluginVersion(trimmed)) return undefined;
    return trimmed;
  };
  const manifest = declared(input.manifestVersion);
  if (manifest) return manifest;
  const entry = declared(input.entryVersion);
  if (entry) return entry;
  // Step 3 before step 4, in the page's order. They are mutually exclusive in
  // practice — an archive source has no commit and a git source has no digest —
  // but the order is the contract, not the practice.
  const commit = input.commitSha?.trim();
  if (commit && /^[0-9a-f]{7,64}$/i.test(commit)) return commit.toLowerCase();
  const digest = shortenArchiveDigest(input.archiveDigest);
  if (digest) return digest;
  return UNKNOWN_PLUGIN_VERSION;
}
