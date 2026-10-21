/**
 * The documented managed marketplace-source allowlist and BLOCKLIST, and the two
 * matchers that decide on them.
 *
 * The blocklist half (`blockedMarketplaces`, P2.467) shares this module because
 * it shares the entry SHAPES; its matching rules are documented as different in
 * four ways and are a separate function —
 * {@link matchesBlockedMarketplaceEntry} carries the table.
 *
 * Contract: `plugin-marketplaces.md` § Managed marketplace restrictions, fetched
 * 2026-07-29; the line numbers below are where each quotation was found.
 *
 * `:671` — "For organizations requiring strict control over plugin sources,
 * administrators can restrict which plugin marketplaces users are allowed to add
 * using the `strictKnownMarketplaces` setting in managed settings."
 *
 * `:762` — "Restrictions are checked before any network or filesystem operation.
 * The check runs on marketplace add and on plugin install, update, refresh, and
 * auto-update. If a marketplace was added before the policy was configured and
 * its source no longer matches the allowlist, Claude Code refuses to install or
 * update plugins from it."
 *
 * Before S9 there was no analogue at all. `allowedPluginKeys` gates plugin KEYS
 * at use time: it cannot express "only marketplaces on our internal GitLab host",
 * and it does not run before the clone — which is the half that matters, because
 * the clone is the part that touches the network.
 *
 * The source identity is derived by a PURE classifier here rather than by
 * `resolvePluginInstallSource`, which probes the filesystem (`existsSync` /
 * `statSync`) to decide whether a bare string is a path. `:762` says the check
 * runs before any filesystem operation, and a gate that stats the very string it
 * is judging does not.
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ManagedDropSink } from '../../config/managed-drops.ts'
import { filterDeclaredRequestHeaders } from '../../plugins/request-header-filter.ts'
import { MANAGED_HEADERS_HELPER_MAX_COMMAND_CHARS } from '../../marketplace/managed-headers-helper.ts'

/**
 * `:696` — a GitHub entry: `{ "source": "github", "repo": "owner/repo" }`, with
 * the optional `ref` of `:718`. `:766` — "For GitHub sources: `repo` is required,
 * and `ref` and `path` must each match exactly or be absent from both the
 * marketplace source and the allowlist entry".
 */
export interface ManagedMarketplaceGithubEntryV1 {
  readonly source: 'github'
  readonly repo: string
  readonly ref?: string
  readonly path?: string
}

/** `:722` — `{ "source": "url", "url": "https://plugins.example.com/marketplace.json" }`. */
export interface ManagedMarketplaceUrlEntryV1 {
  readonly source: 'url'
  readonly url: string
}

/**
 * `:734` — `{ "source": "hostPattern", "hostPattern": "^github\\.example\\.com$" }`,
 * "the recommended approach for GitHub Enterprise Server or self-hosted GitLab
 * instances". `:768` — "the marketplace host is matched against the regex
 * pattern".
 */
export interface ManagedMarketplaceHostPatternEntryV1 {
  readonly source: 'hostPattern'
  readonly hostPattern: string
}

/**
 * `:746` — `{ "source": "pathPattern", "pathPattern": "^/opt/approved/" }`.
 * `:754` — "Use `".*"` as the `pathPattern` to allow any filesystem path while
 * still controlling network sources with `hostPattern`."
 */
export interface ManagedMarketplacePathPatternEntryV1 {
  readonly source: 'pathPattern'
  readonly pathPattern: string
}

export type ManagedMarketplaceEntryV1 =
  | ManagedMarketplaceGithubEntryV1
  | ManagedMarketplaceUrlEntryV1
  | ManagedMarketplaceHostPatternEntryV1
  | ManagedMarketplacePathPatternEntryV1

/* ------------------------------------------------------------------------- *
 * Delivery — `settings-reference.md#extraknownmarketplaces`
 * ------------------------------------------------------------------------- */

/**
 * One marketplace an administrator DELIVERS, as opposed to one they permit.
 *
 * `settings-reference.md#extraknownmarketplaces` — "Register additional plugin
 * marketplaces by name, so that people who open the repository, or everyone your
 * managed settings reach, get the marketplace without adding it themselves."
 * `settings-reference.md#strictknownmarketplaces` is the other half of the pair
 * and only ever narrows:
 * it can say which sources a user MAY add and cannot pre-supply one, so before
 * this every workstation had to add the internal marketplace by hand before a
 * mandated plugin could resolve.
 *
 * The value carried here is Nessy's own source vocabulary — the single raw
 * string `PluginRegistrySource.add` already takes ("GitHub `owner/repo`
 * shorthand, git URL, remote URL to a `marketplace.json` file, or local
 * directory path", `plugins/marketplace-reference.md#github-plugin-source`) — because delivery MUST reuse
 * the interactive add path rather than build a second one. The documented
 * `{ "source": { "source": "github", "repo": "…" } }` nesting is accepted at
 * parse time and flattened to that string, so a policy written from Claude's
 * page is readable here.
 */
export interface DeliveredMarketplaceEntryV1 {
  /** `:773`'s object key — the marketplace name the policy declares. */
  readonly name: string
  /** The raw source string, in the vocabulary the add path classifies. */
  readonly source: string
  /**
   * P3.220 — the `url` source's own request headers.
   *
   * `settings-reference.md#extraknownmarketplaces`, § Marketplace source types:
   * "**`url`**: a direct URL to a `marketplace.json` file, with `url` and
   * optional `headers` and `headersHelper` for authenticated access."
   * `plugins/host-marketplace.md#authenticate-archive-downloads` says where they are
   * sent from: "Before each fetch of the marketplace's `marketplace.json` and
   * before each archive download on that origin."
   *
   * Without this a private registry could not be REGISTERED at all — not the
   * 401 on an entry's archive that P6.39 closed, but the same 401 one step
   * earlier, on the catalog fetch itself. Already filtered
   * (`plugins/request-header-filter.ts`); values never appear in a drop.
   *
   * BOTH clauses are implemented now, and this paragraph said otherwise until
   * P6.479 read it: "Only the catalog fetch consumes it today … the second
   * clause is NOT implemented" was true when P3.220 landed and stopped being
   * true when P6.177 did. The catalog fetch consumes it in
   * `marketplace/registry-source.ts`; the archive download on the marketplace
   * URL's origin inherits it in
   * `marketplace/external-catalog-adapters.ts:applyEntryArchiveHeaders`, where
   * an entry's own `headers` (P6.39) still win by name, as the page requires.
   */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * P6.479 — the `url` source's `headersHelper`, the COMMAND that mints a
   * credential which expires, carried since the owner's 2026-09-05 decision
   * (Q7, option C) made this tier the one that runs it.
   *
   * `settings-reference.md#extraknownmarketplaces` declares it beside `headers`,
   * and `plugins/host-marketplace.md#how-users-accept-a-headershelper-command` gives
   * our tier — "a managed settings file on the machine" — the row "Without
   * asking, including during a background marketplace refresh".
   *
   * That table sits under the page's own "When a marketplace `url` source's
   * command runs", which is an `#####` heading and therefore publishes NO `id`
   * (AGENTS.md's measured slug rule: only `##`/`###`/`####` get one), so the
   * citation hangs on the enclosing `####` section instead. Re-anchored P6.661;
   * the sentences above are unchanged and still verbatim on the page.
   *
   * The command TEXT is carried verbatim and validated by the runner, not here:
   * `plugins/host-marketplace.md#write-the-headershelper-command`'s shape rule ("at
   * most 500 characters of printable ASCII, with no run of four or more spaces")
   * belongs beside the spawn that would execute it, so a policy parser cannot
   * disagree with the executor about what is runnable. The parser's own cap is
   * the length one, which the shape rule already implies.
   *
   * NOT carried for any other source kind, and never for a catalog-declared
   * entry: an entry's `headersHelper` in a published `marketplace.json` is
   * refused at parse time in `plugins/archive-headers.ts` and stays refused.
   */
  readonly headersHelper?: string
  /** `:718`'s optional pinned ref, when the policy names one. */
  readonly refName?: string
  /**
   * `settings-reference.md#extraknownmarketplaces` — the entry's **Type** bullet
   * is "object mapping a marketplace name to an object with a `source` object and
   * an optional `autoUpdate` Boolean", and the same section says: "Set
   * `"autoUpdate": true` alongside `source` to make Claude Code refresh that
   * marketplace and update its installed plugins in the background after startup.
   * When omitted, `claude-plugins-official` and most other official Anthropic
   * marketplaces default to `true`, and third-party marketplaces default to
   * `false`."
   *
   * Note the placement: `autoUpdate` sits BESIDE `source`, unlike the
   * neighbouring `skipLfs` — "For `github` and `git` sources, set
   * `"skipLfs": true` inside the `source` object" — which sits INSIDE the source
   * object and is flattened away one function earlier in
   * {@link deliveredMarketplaceSource}.
   *
   * Undefined here means "the policy said nothing", which is a different answer
   * from `false`: the resolver falls through to the user's own toggle and only
   * then to the documented default polarity
   * ({@link defaultMarketplaceAutoUpdate}).
   */
  readonly autoUpdate?: boolean
}

/**
 * What a marketplace source IS, derived from the string a user typed plus the
 * ref they pinned. Every field is optional because a source only proves the
 * dimensions its own shape carries: a local directory has no host, and a bare
 * URL has no `owner/repo`.
 */
export interface ManagedMarketplaceSourceIdentityV1 {
  /** The source string exactly as given. `:771` matches URLs on it unnormalized. */
  readonly raw: string
  readonly host?: string
  readonly repo?: string
  readonly ref?: string
  readonly path?: string
  readonly filesystemPath?: string
}

const MARKETPLACE_ENTRIES_MAX = 128
const PATTERN_MAX = 512
const URL_MAX = 2048
const REPO_MAX = 256
/** C0/C1/DEL and the line separators — see `managed-mcp-entries.ts` for why. */
const MARKETPLACE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/**
 * `settings-reference.md#owner-wildcards` — "A `github` entry whose `repo` value
 * is `"<owner>/*"` matches every repository under that GitHub owner. Owner
 * wildcards … work only in `strictKnownMarketplaces` and `blockedMarketplaces`.
 * … Only the whole repository-name position can be a wildcard. Claude Code
 * compares entries such as a bare star, a star in the OWNER position, or
 * `acme-corp/tools-` followed by a star, literally, so they match no
 * repository." (The page's three examples are written out in words here rather
 * than quoted: the middle one is a star followed by a slash, which closes a
 * block comment.)
 *
 * **P2.483 — accepted on BOTH lists since 2026-09-03, and the reason the
 * allowlist half changed is that its premise was refuted rather than
 * overruled.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, row P2.483.
 * The owner's answer (2026-09-02, §A7) was conditional: *"Read the page first;
 * if silent, do not accept `owner/*` in the allowlist — keep dropping it
 * visibly."* The page is NOT silent, so the antecedent does not hold and the
 * documented behaviour governs (read-don't-invent).
 *
 * Both denominators were checked, in the direction AGENTS.md prescribes for
 * each — the page for what we must be able to ACCEPT, the bundle for what the
 * runtime can already DO — and they agree:
 *
 *  - `settings-reference.md#owner-wildcards`, verbatim: *"A `github` entry
 *    whose `repo` value is `"<owner>/*"` matches every repository under that
 *    GitHub owner. Owner wildcards require Claude Code v2.1.223 or later and
 *    work only in `strictKnownMarketplaces` and `blockedMarketplaces`."* The
 *    page then shows a worked `strictKnownMarketplaces` example and fills in
 *    that column of the four-row matching table below.
 *  - The vendored bundle is `claudeCodeVersion 2.1.247`, twenty-four patches
 *    past the stated 2.1.223 floor (it was 2.1.233 and ten patches past when
 *    this bullet was written), and its allowlist matcher parses the wildcard
 *    explicitly:
 *    it logs at ERROR level *"Invalid owner-wildcard repo in policy settings
 *    strictKnownMarketplaces: … (only "<owner>/*" is supported); entry only
 *    matches a literally identical repo string"* for the malformed spellings,
 *    which is a message that can only exist because the well-formed spelling
 *    works.
 *
 * **This is a GRANT WIDENING and it is stated rather than slipped in**: one
 * entry now admits every marketplace repository under an owner. That is what
 * the setting means on the runtime we are built to; refusing it made an
 * administrator's working configuration fail on this fork alone, which is the
 * divergence class this plan exists to remove. The previous behaviour — a
 * recorded, `doctor`-listed drop — was honest, and honest about the wrong
 * thing.
 *
 * The four rules that differ between the two lists are in
 * {@link matchesBlockedMarketplaceEntry}'s table; the allowlist column is
 * implemented in {@link matchesManagedMarketplaceEntry}, and it is STRICTER on
 * every row: `owner/repo` spelling only, case-SENSITIVE owner, exact-entry
 * `ref`, and a `path` rule that is looser than exact matching but only for the
 * repositories the wildcard already selected.
 */
const GITHUB_OWNER_WILDCARD = /^[A-Za-z0-9_.-]+\/\*$/
const REF_OR_PATH = /^[^\s]{1,256}$/

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return undefined
  if (MARKETPLACE_FORBIDDEN.test(trimmed)) return undefined
  return trimmed
}

/**
 * A pattern is compiled at PARSE time so an uncompilable one is a recorded drop
 * an administrator can see, not a silent never-match at every later decision.
 */
function pattern(value: unknown): string | undefined {
  const raw = text(value, PATTERN_MAX)
  if (raw === undefined) return undefined
  try {
    new RegExp(raw)
  } catch {
    return undefined
  }
  return raw
}

/**
 * Which of the two documented marketplace-source lists an entry belongs to.
 *
 * The source SHAPES are identical — `settings-reference.md#blockedmarketplaces`
 * says the type is an "array of marketplace source objects, in the same forms as
 * `strictKnownMarketplaces`" — so the two lists share this parser. What differs
 * is the owner-wildcard form (blocklist only here, see
 * {@link GITHUB_OWNER_WILDCARD}) and the reason text a drop carries, which has
 * to name the list an administrator actually wrote.
 */
type MarketplaceListKind = 'allowlist' | 'blocklist'

function parseManagedMarketplaceEntry(
  raw: unknown,
  list: MarketplaceListKind = 'allowlist',
): ManagedMarketplaceEntryV1 | string {
  const object = record(raw)
  if (!object) return `invalid managed marketplace ${list} entry`
  const kind = text(object.source, 32)
  switch (kind) {
    case 'github': {
      const repo = text(object.repo, REPO_MAX)
      // P2.483 — accepted on BOTH lists now. The page is not silent about the
      // allowlist half; see {@link GITHUB_OWNER_WILDCARD}.
      const wildcard = repo !== undefined && GITHUB_OWNER_WILDCARD.test(repo)
      if (repo === undefined || !(GITHUB_REPO.test(repo) || wildcard)) {
        return `invalid managed marketplace ${list} github repo`
      }
      const ref = object.ref === undefined ? undefined : text(object.ref, 256)
      const path = object.path === undefined ? undefined : text(object.path, 256)
      if ((object.ref !== undefined && (ref === undefined || !REF_OR_PATH.test(ref)))
        || (object.path !== undefined && (path === undefined || !REF_OR_PATH.test(path)))) {
        return `invalid managed marketplace ${list} github ref or path`
      }
      return Object.freeze({
        source: 'github' as const,
        repo,
        ...(ref === undefined ? {} : { ref }),
        ...(path === undefined ? {} : { path }),
      })
    }
    case 'url': {
      const url = text(object.url, URL_MAX)
      if (url === undefined) return `invalid managed marketplace ${list} url`
      return Object.freeze({ source: 'url' as const, url })
    }
    case 'hostPattern': {
      const hostPattern = pattern(object.hostPattern)
      if (hostPattern === undefined) return `invalid managed marketplace ${list} hostPattern`
      return Object.freeze({ source: 'hostPattern' as const, hostPattern })
    }
    case 'pathPattern': {
      const pathPattern = pattern(object.pathPattern)
      if (pathPattern === undefined) return `invalid managed marketplace ${list} pathPattern`
      return Object.freeze({ source: 'pathPattern' as const, pathPattern })
    }
    case 'skills-dir':
      // A REAL blocklist entry upstream — `settings-reference.md#blockedmarketplaces`:
      // "Add `{ "source": "skills-dir" }` to stop Claude Code loading
      // `@skills-dir` plugins from `~/.claude/skills/` without restricting any
      // marketplace." Refused here rather than accepted-and-inert, and the reason
      // says why: this build never loads an `@skills-dir` plugin at all
      // (`plugins/types.ts`'s `'skills-dir'` origin is RESERVED and unproduced,
      // finding f054), so an accepted entry would block nothing while looking
      // like it blocked something. A visible drop is the honest form of that.
      return `managed marketplace ${list} entry names "skills-dir", a plugin source this build never loads, so the entry blocks nothing`
    default:
      return `managed marketplace ${list} entry declares an unsupported source "${kind ?? 'unknown'}"`
  }
}

function entryToken(entry: ManagedMarketplaceEntryV1): string {
  switch (entry.source) {
    case 'github': return `github:${entry.repo}:${entry.ref ?? ''}:${entry.path ?? ''}`
    case 'url': return `url:${entry.url}`
    case 'hostPattern': return `host:${entry.hostPattern}`
    case 'pathPattern': return `path:${entry.pathPattern}`
  }
}

/**
 * Parse the whole list.
 *
 * This is an ALLOWLIST, so it takes the polarity
 * `managed-settings.md#keys-that-fail-closed` gives `allowedMcpServers`:
 * "Enforced as an empty allowlist until the value is fixed, so no MCP servers
 * that users add are admitted. … An individual invalid entry is stripped and the
 * valid subset is enforced." Both narrow, which is the safe direction for a
 * grant.
 *
 * `[]` is NOT a defect and is never confused with one:
 * `settings-reference.md#strictknownmarketplaces` gives it a meaning of its own —
 * "**Default**: unset, so users can add any marketplace. An empty array is a
 * complete lockdown that blocks every marketplace source, including the official
 * Anthropic marketplace". An empty result and an absent field are
 * therefore different answers, which is why this returns `undefined` only when
 * the field was absent.
 *
 * ## Four of the page's NINE entry shapes, and what the other five are
 *
 * `settings-reference.md#allowed-source-types` tabulates nine source types —
 * `github`, `git`, `url`, `npm`, `file`, `directory`, `hostPattern`,
 * `pathPattern` and `skills-dir` — and {@link parseManagedMarketplaceEntry}
 * accepts four of them: `github`, `url`, `hostPattern` and `pathPattern`. The
 * other five were READ one at a time rather than assumed (2026-09-11, P6.1047),
 * and they are not one kind of absence:
 *
 *  - `skills-dir` is a DECIDED refusal with its reason in the switch and a test
 *    pinning it (`marketplace/__tests__/blocked-marketplaces.test.ts`, "refuses a
 *    `skills-dir` entry with a reason that says why it would be inert"): this
 *    build never loads an `@skills-dir` plugin, so an accepted entry would look
 *    like a restriction and restrict nothing.
 *  - `git`, `file` and `directory` have NO PIN and are simply not carried here,
 *    though all three are real source kinds elsewhere in this module:
 *    {@link deliveredMarketplaceSource} flattens each one for the delivery key,
 *    and {@link managedMarketplaceSourceIdentity} derives a `host` from a git URL
 *    and a `filesystemPath` from a local path — so a `hostPattern` or
 *    `pathPattern` entry already matches such a source. What is absent is the
 *    exact-entry spelling, not the coverage — and the operator who meets that
 *    is the one who DELIVERS such a marketplace, because `extraKnownMarketplaces`
 *    registers through the same add path an interactive add takes and a
 *    delivered source is refused by this allowlist like any other
 *    (`managed-policy.ts`, `extraKnownMarketplaces`: "A delivery may not widen
 *    the narrowing"). Such an administrator has to write a `hostPattern` or a
 *    `pathPattern` where the page offers an exact entry.
 *  - `npm` has NO PIN either, and there is no marketplace spelling here for a
 *    case to flatten to: the page's DELIVERY vocabulary
 *    (`settings-reference.md#marketplace-source-types`) does not list `npm`, and
 *    `plugins/source-resolver.ts`'s `resolvePluginInstallSource` classifies a
 *    source STRING as a hosted repository, a URL or a local path, and anything
 *    else as `unsupported`. An npm package is a PLUGIN source here, never a
 *    marketplace one.
 *
 * Whether the four unpinned kinds should gain cases is a PRODUCT posture and
 * stays the owner's — a coverage-95 question names these five. Until it is
 * answered they fall to the switch's default branch, which drops them visibly
 * with "declares an unsupported source", never silently.
 */
export function parseManagedMarketplaceEntryList(
  value: unknown,
  options: { field: string; sink: ManagedDropSink },
): readonly ManagedMarketplaceEntryV1[] {
  const { field, sink } = options
  if (!Array.isArray(value) || value.length > MARKETPLACE_ENTRIES_MAX) {
    const reason = `invalid managed Pi policy ${field}`
    if (!sink.tolerant) throw new Error(reason)
    sink.drop(field, `${reason}; no marketplace source is allowed by it`, 'emptied')
    return Object.freeze([])
  }
  const kept: ManagedMarketplaceEntryV1[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const at = `${field}[${index}]`
    const parsed = parseManagedMarketplaceEntry(raw)
    if (typeof parsed === 'string') {
      if (!sink.tolerant) throw new Error(parsed)
      sink.drop(at, parsed, 'stripped')
      continue
    }
    const token = entryToken(parsed)
    if (seen.has(token)) continue
    seen.add(token)
    kept.push(parsed)
  }
  return Object.freeze(kept)
}

/* ------------------------------------------------------------------------- *
 * Blocklist — `settings-reference.md#blockedmarketplaces` (P2.467)
 * ------------------------------------------------------------------------- */

/**
 * Parse `blockedMarketplaces`.
 *
 * `settings-reference.md#blockedmarketplaces` — "Block plugin marketplace sources
 * for your organization. Claude Code checks the blocklist on marketplace add and
 * on plugin install, update, refresh, and auto-update, so a marketplace someone
 * added before you set the policy can't be used to fetch plugins either. Blocked
 * sources are checked before download, so they never touch the filesystem."
 *
 * THE POLARITY IS THE OPPOSITE OF {@link parseManagedMarketplaceEntryList}'s, and
 * it was READ rather than chosen. `blockedMarketplaces` is not in
 * `managed-settings.md#keys-that-fail-closed`, so the general rule at
 * `#invalid-entries-in-managed-settings` applies — "skips the individual entries
 * it can repair … then drops any top-level key whose value still fails and keeps
 * enforcing every remaining valid key" — and the nearest documented sibling, the
 * other blocklist on this policy, spells out the reasoning that would otherwise
 * have to be invented: `deniedMcpServers`, "An individual invalid entry is
 * stripped and the valid subset is enforced. A wholly invalid value is dropped
 * with a warning, since denying every server would block servers the policy never
 * named."
 *
 * So a wholly invalid value is DROPPED (`undefined`, blocking nothing) rather
 * than escalated to a block-everything reading. That direction fails OPEN, which
 * is uncomfortable for a blocklist and is nonetheless what the page decides: the
 * alternative bricks every marketplace on a typo. What makes it survivable is
 * that the drop is RECORDED — `doctor` lists it with its source and field
 * (`managed-settings.md#find-entries-claude-code-dropped`) — and the reason says
 * in words that nothing is blocked by it.
 *
 * Absent and `[]` mean the same thing here, unlike the allowlist where `[]` is a
 * complete lockdown: an empty blocklist blocks nothing.
 */
export function parseBlockedMarketplaceEntryList(
  value: unknown,
  options: { field: string; sink: ManagedDropSink },
): readonly ManagedMarketplaceEntryV1[] | undefined {
  const { field, sink } = options
  if (!Array.isArray(value) || value.length > MARKETPLACE_ENTRIES_MAX) {
    const reason = `invalid managed Pi policy ${field}`
    if (!sink.tolerant) throw new Error(reason)
    sink.drop(field, `${reason}; no marketplace source is blocked by it`, 'stripped')
    return undefined
  }
  const kept: ManagedMarketplaceEntryV1[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const at = `${field}[${index}]`
    const parsed = parseManagedMarketplaceEntry(raw, 'blocklist')
    if (typeof parsed === 'string') {
      // A stripped BLOCKLIST entry leaves a source admitted, which is the
      // opposite consequence from a stripped allowlist entry — so the reason
      // says so, the way the MCP denylist's does.
      const reason = `${parsed}; the marketplace source it named is NOT blocked`
      if (!sink.tolerant) throw new Error(reason)
      sink.drop(at, reason, 'stripped')
      continue
    }
    const token = entryToken(parsed)
    if (seen.has(token)) continue
    seen.add(token)
    kept.push(parsed)
  }
  return Object.freeze(kept)
}

/** `<owner>` and `<repo>` of an `owner/repo` string, or `undefined`. */
function splitRepo(repo: string): readonly [string, string] | undefined {
  const segments = repo.split('/')
  if (segments.length !== 2) return undefined
  const [owner, name] = segments
  if (!owner || !name) return undefined
  return [owner, name] as const
}

/**
 * The form a blocklist `url` entry is compared in.
 *
 * `plugins/org.md#how-entries-match` — "Claude Code also checks it
 * against the `url` entries in `blockedMarketplaces`. Claude Code blocks the
 * addition if an entry names the same URL. In that comparison, Claude Code
 * ignores the `.git` suffix and any ref the user appends after `#`."
 *
 * Deliberately narrower than a full URL canonicalisation: the page names exactly
 * two things to ignore, and inventing a third (a trailing slash, a scheme swap)
 * would make this fork block sources upstream admits.
 */
function blockedUrlForm(raw: string): string {
  return raw.trim().replace(/#.*$/u, '').replace(/\.git$/iu, '')
}

/**
 * Does one blocklist entry match this source?
 *
 * `settings-reference.md#owner-wildcards` publishes the four rules that make
 * blocklist matching WIDER than allowlist matching, and every one of them is a
 * place an allowlist-shaped comparison would have failed OPEN:
 *
 * | Rule | `strictKnownMarketplaces` | `blockedMarketplaces` |
 * | --- | --- | --- |
 * | Matching source spellings | "`owner/repo` form only. A git URL that clones the same repository doesn't match" | "Any spelling, including git URLs that resolve to the same github.com repository" |
 * | Owner case | "Case-sensitive, like exact-entry matching" | "Case-insensitive" |
 * | `ref` | an entry with a `ref` matches only that ref, without one only sources without a ref | "An entry without a `ref` blocks all refs of the repositories it matches" |
 * | `path` | an entry with a `path` requires that exact value | "An entry without a `path` blocks all paths of the repositories it matches" |
 *
 * WHAT AN ENTRY MATCHES ON, and it is the load-bearing choice: the SOURCE
 * identity — `repo` / `url` / `host` / `filesystemPath` from
 * {@link managedMarketplaceSourceIdentity} — never the marketplace's display
 * NAME. A blocklist keyed on a display name is bypassable by construction, since
 * the label is the one field a user chooses freely at add time
 * (`registry-source.ts`'s `displayName`); the source is what a clone actually
 * goes to. The reserved-NAME gate next door is keyed on the label precisely
 * because its rule is about impersonation, which is a claim made in a label.
 *
 * The first row costs nothing extra here: the identity classifier already
 * derives `repo` from the github shorthand, from `https://github.com/owner/repo`
 * (with `.git`, `#ref` and `/tree/<ref>/<path>` forms) and from
 * `git@github.com:owner/repo.git`, so the spellings converge before matching.
 *
 * ONE RESIDUE, recorded rather than guessed at. The page says a blocklist
 * `hostPattern` "takes a host from a wider set of forms" than the allowlist's,
 * and never enumerates that set — `settings-reference.md#allowed-source-types`
 * names only the three forms both keys share (scheme URL, `user@host:path`, and
 * "any other form without a scheme: no host"). So `hostPattern` and
 * `pathPattern` match exactly as they do in the allowlist. Widening them would
 * mean inventing the form list the page withheld.
 */
export function matchesBlockedMarketplaceEntry(
  entry: ManagedMarketplaceEntryV1,
  identity: ManagedMarketplaceSourceIdentityV1,
): boolean {
  switch (entry.source) {
    case 'github': {
      if (identity.repo === undefined) return false
      const wanted = splitRepo(entry.repo)
      const actual = splitRepo(identity.repo)
      if (!wanted || !actual) return false
      if (wanted[0].toLowerCase() !== actual[0].toLowerCase()) return false
      if (wanted[1] !== '*' && wanted[1].toLowerCase() !== actual[1].toLowerCase()) return false
      // Absent on the ENTRY means "every ref" / "every path" — the two rows of
      // the table where a `sameOrBothAbsent` comparison would have let a
      // ref-pinned or path-scoped source through a blocklist that named neither.
      if (entry.ref !== undefined && entry.ref !== identity.ref) return false
      if (entry.path !== undefined && entry.path !== identity.path) return false
      return true
    }
    case 'url':
      return blockedUrlForm(entry.url) === blockedUrlForm(identity.raw)
    case 'hostPattern':
      return identity.host !== undefined && safeTest(entry.hostPattern, identity.host)
    case 'pathPattern':
      return identity.filesystemPath !== undefined && safeTest(entry.pathPattern, identity.filesystemPath)
  }
}

/**
 * The blocklist entry that refuses this source, or `undefined`.
 *
 * Returns the ENTRY rather than a boolean for the same reason
 * {@link reservedMarketplaceNameFor} returns a name: "blocked by managed
 * settings" is not actionable, "blocked by the `blockedMarketplaces` entry
 * `github:untrusted/*`" is, and this plan has closed several rows where a
 * refusal and a failure read identically to a user and had opposite remedies.
 */
export function blockedMarketplaceEntryFor(
  blockedMarketplaces: readonly ManagedMarketplaceEntryV1[] | undefined,
  identity: ManagedMarketplaceSourceIdentityV1,
): ManagedMarketplaceEntryV1 | undefined {
  if (blockedMarketplaces === undefined) return undefined
  return blockedMarketplaces.find(entry => matchesBlockedMarketplaceEntry(entry, identity))
}

/** A blocklist entry as one path-free, log-safe token. See {@link entryToken}. */
export function describeManagedMarketplaceEntry(entry: ManagedMarketplaceEntryV1): string {
  return entryToken(entry)
}

/**
 * `settings-reference.md#extraknownmarketplaces`'s object key ("**Type**: object
 * mapping a marketplace name to an object with a `source` object and an optional
 * `autoUpdate` Boolean") and
 * `settings-reference.md#pluginsuggestionmarketplaces`'s allowlist entry
 * ("**Type**: array of marketplace names"): a marketplace name in both cases.
 * Exported so the suggestion allowlist validates its names with the SAME
 * grammar the delivery key does — two grammars would let an admin write a name
 * one key accepts and the other silently drops.
 */
export const MANAGED_MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MARKETPLACE_NAME = MANAGED_MARKETPLACE_NAME
const SOURCE_MAX = 2048

/**
 * P6.479 — `plugins/host-marketplace.md#write-the-headershelper-command`: "at most
 * 500 characters of printable ASCII". Imported from the module that EXECUTES
 * the command rather than written again here: a parser and an executor that
 * each carry their own copy of a cap is how one of them silently becomes the
 * real rule.
 */
const HEADERS_HELPER_MAX = MANAGED_HEADERS_HELPER_MAX_COMMAND_CHARS

/**
 * Flatten one documented `source` object to the raw string the add path takes.
 *
 * `settings-reference.md#marketplace-source-types` is the list this switch is
 * derived from — read it rather than a count written here, which is what the
 * comment this replaced got wrong. As read 2026-09-10 it names `github`, `git`,
 * `url`, `file`, `directory` and `settings`. All but one name a concrete place
 * and flatten cleanly:
 *
 * * `github` (uses `repo`) — the `owner/repo` shorthand
 * * `git` (uses `url`) and `url` (uses `url`) — the URL, unnormalized
 * * `directory` (uses `path`) — "a local filesystem path, with `path`, for
 *   development only"
 * * `file` (uses `path`) — "a local path to a `marketplace.json` file, with
 *   `path`". Admitted by P6.1039 (2026-09-11); it had been falling to the
 *   unsupported-source branch with no case of its own.
 *
 * `settings` does NOT, and is refused rather than guessed at: "an inline
 * marketplace declared directly in the settings file without a hosted
 * repository, with `name` and `plugins`" is a catalogue format we do not have —
 * accepting it would register a marketplace whose catalogue can never load.
 *
 * **That refusal is why `file` needed a measurement and not a guess.** A path to
 * a JSON FILE looks like the same "catalogue that can never load" problem, since
 * the loader reads a manifest at a staged ROOT. It is not, and no path rewriting
 * is needed here: the flattened path reaches `source-resolver.ts` as a
 * `local-path`, and `acquisition.ts`'s `copyLocalPathArtifact` stages a
 * local path that is a FILE by copying it into the staging root under its own
 * basename (`stats.isFile()` branch, `copyInside(sourcePath, …, basename(…))`);
 * `marketplace.json` is the FIRST entry of `registry-catalog-fetcher.ts`'s
 * `REGISTRY_CATALOG_MANIFEST_FILES`, read at exactly that root. So the file the
 * administrator named IS the catalogue that loads, and `file` gets the same
 * flattening and the same validation as `directory` — the two share a case.
 *
 * `hostPattern` used to be named here as a refused DELIVERY kind, and it is not
 * one: it belongs to the allowlist vocabulary at
 * `settings-reference.md#allowed-source-types` ("`hostPattern` required, a regex
 * matched against the marketplace host"), where a pattern is a way to RECOGNIZE
 * sources rather than a source there is anything to clone.
 *
 * A plain string is also accepted, because that is what Nessy's own add path
 * takes and a policy author who knows this product will write it.
 */
function deliveredMarketplaceSource(raw: unknown): string | { reason: string } {
  const direct = text(raw, SOURCE_MAX)
  if (direct !== undefined) return direct
  const object = record(raw)
  if (!object) return { reason: 'invalid delivered marketplace source' }
  const kind = text(object.source, 32)
  switch (kind) {
    case 'github': {
      const repo = text(object.repo, REPO_MAX)
      if (repo === undefined || !GITHUB_REPO.test(repo)) {
        return { reason: 'invalid delivered marketplace github repo' }
      }
      return repo
    }
    case 'git':
    case 'url': {
      const url = text(object.url, URL_MAX)
      if (url === undefined) return { reason: `invalid delivered marketplace ${kind} url` }
      return url
    }
    case 'file':
    case 'directory': {
      // Same cap, same forbidden-character set, same trim as every other
      // flattening here — `text()` is the whole of the `directory` case's
      // validation, and `file` gets exactly it. The page calls both paths
      // absolute; nothing here requires that, because the resolver is what
      // resolves a relative path against the cwd and a stricter rule invented
      // at this layer would refuse a document Claude Code accepts.
      const path = text(object.path, SOURCE_MAX)
      if (path === undefined) return { reason: `invalid delivered marketplace ${kind} path` }
      return path
    }
    case 'hostPattern':
      return { reason: 'a delivered marketplace cannot be a hostPattern; a pattern recognizes sources but names none' }
    case 'settings':
      return { reason: 'a delivered marketplace cannot be an inline settings catalogue; that format has no reader here' }
    default:
      return { reason: `delivered marketplace declares an unsupported source "${kind ?? 'unknown'}"` }
  }
}

/**
 * P3.220 — the `url` source's `headers` and `headersHelper`, read off the SOURCE
 * OBJECT (they sit inside it, beside `url`, unlike `autoUpdate` which sits
 * beside `source`).
 *
 * `headersHelper` is a COMMAND, and since P6.479 it is CARRIED rather than
 * dropped — for this tier and this tier only. The paragraph that stood here said
 * the command "is never run", which was true of every tier until the owner's
 * 2026-09-05 decision (Q7, option C) made a marketplace that MANAGED settings
 * themselves declare the documented exception:
 * `plugins/host-marketplace.md#when-claude-code-skips-a-headershelper-command-or-drops-its-output`
 * — "Under either block, Claude Code still runs the command for a marketplace
 * that managed settings themselves declare." Everything the old paragraph listed
 * as missing now exists beside the spawn rather than in this parser:
 * `marketplace/managed-headers-helper.ts` runs it through the shell from the
 * configuration directory on the documented 10-second budget, and the entry
 * spelling — the one a published catalog declares, which needs the acceptance
 * flow this fork does not build — is still refused outright in
 * `plugins/archive-headers.ts`.
 *
 * The parser therefore validates SHAPE and carries TEXT. It does not decide
 * whether the command runs: that is one decision and it lives at the one place
 * that can execute it.
 *
 * `commandSourcesAllowed` is no longer read for this field, deliberately. The
 * page's block has an explicit carve-out for exactly the tier this function
 * parses, so an entry here is unaffected by `disableCommandPluginSources`
 * whatever it is set to — and a receipt claiming otherwise is worse than none.
 * The parameter stays because the option is part of this list's signature and
 * its caller sits behind the managed-policy pair rule.
 */
function deliveredMarketplaceHeaders(
  raw: unknown,
  at: string,
  sink: ManagedDropSink,
  _commandSourcesAllowed: boolean,
): { headers?: Readonly<Record<string, string>>; headersHelper?: string } | undefined {
  const object = record(raw)
  if (!object) return undefined
  const kind = text(object.source, 32)
  if (kind !== 'url') {
    // The page attaches both fields to the `url` source alone. Any OTHER kind
    // that carries them is told so rather than having them silently ignored —
    // stated as "not url" rather than as a list of the others, because that
    // list grows (`file` joined it at P6.1039) and a stale enumeration here
    // would read as a decision about the kinds it forgot.
    if (object.headers !== undefined || object.headersHelper !== undefined) {
      sink.drop(
        at,
        `delivered marketplace source "${kind ?? 'unknown'}" carries headers, which only a url source sends`,
        'stripped',
      )
    }
    return undefined
  }
  let headersHelper: string | undefined
  if (object.headersHelper !== undefined) {
    // The length cap is the parser's half of the shape rule. A value that is not
    // a string, or is longer than the documented 500 characters, is not a
    // command this app would run, so it is dropped HERE — where the receipt
    // reaches the administrator who wrote it — rather than at a fetch that then
    // has to explain itself to a user who cannot fix it.
    headersHelper = text(object.headersHelper, HEADERS_HELPER_MAX)
    if (headersHelper === undefined) {
      sink.drop(
        at,
        'invalid delivered marketplace url headersHelper; it must be a command of at most'
        + ` ${HEADERS_HELPER_MAX} characters, so only the fixed "headers" are sent`,
        'stripped',
      )
    }
  }
  const filtered = filterDeclaredRequestHeaders(object.headers)
  if (!filtered) {
    sink.drop(at, 'invalid delivered marketplace url headers; none are sent', 'stripped')
    return headersHelper === undefined ? undefined : { headersHelper }
  }
  if (filtered.malformed.length > 0) {
    sink.drop(
      at,
      `delivered marketplace url headers whose values are not strings: ${filtered.malformed.join(', ')}`,
      'stripped',
    )
  }
  if (filtered.dropped.length > 0) {
    sink.drop(
      at,
      `delivered marketplace url declares request-routing or client-identity headers, which are dropped: ${filtered.dropped.join(', ')}`,
      'stripped',
    )
  }
  const headers = filtered.headers === undefined ? undefined : Object.freeze({ ...filtered.headers })
  if (headers === undefined && headersHelper === undefined) return undefined
  return {
    ...(headers === undefined ? {} : { headers }),
    ...(headersHelper === undefined ? {} : { headersHelper }),
  }
}

/**
 * Parse `extraKnownMarketplaces`.
 *
 * This is a DELIVERY, not a grant, so it takes the opposite polarity to
 * {@link parseManagedMarketplaceEntryList}: a wholly invalid value delivers
 * NOTHING (an empty list is the same outcome as an absent field here — neither
 * registers a marketplace, and there is no `:678` lockdown meaning to preserve),
 * and an individual invalid entry is stripped while the valid rest is delivered.
 * Both directions narrow what gets registered, which is the safe direction for a
 * code-distribution channel.
 *
 * Accepts the documented object-map shape (`:773` — keyed by marketplace name)
 * and, for symmetry with every other list on this policy, an array of entries
 * that carry their own `name`.
 */
export function parseDeliveredMarketplaceEntryList(
  value: unknown,
  options: {
    field: string
    sink: ManagedDropSink
    /**
     * P3.220 — `settings-reference.md#disablecommandpluginsources` resolved by
     * `areMarketplaceCommandSourcesAllowed`, passed in because the key is on the
     * SAME document being parsed and this list must not re-derive a tri-state
     * two ways. Defaults to `true` for a caller with no policy in hand, which is
     * the reading that claims the least.
     */
    commandSourcesAllowed?: boolean
  },
): readonly DeliveredMarketplaceEntryV1[] {
  const { field, sink } = options
  const commandSourcesAllowed = options.commandSourcesAllowed ?? true
  const rows = deliveredRows(value)
  if (rows === null || rows.length > MARKETPLACE_ENTRIES_MAX) {
    const reason = `invalid managed Pi policy ${field}`
    if (!sink.tolerant) throw new Error(reason)
    sink.drop(field, `${reason}; no marketplace is delivered by it`, 'emptied')
    return Object.freeze([])
  }
  const kept: DeliveredMarketplaceEntryV1[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const at = `${field}.${row.at}`
    const name = text(row.name, 128)
    if (name === undefined || !MARKETPLACE_NAME.test(name)) {
      if (!sink.tolerant) throw new Error('invalid delivered marketplace name')
      sink.drop(at, 'invalid delivered marketplace name', 'stripped')
      continue
    }
    const source = deliveredMarketplaceSource(row.source)
    if (typeof source !== 'string') {
      if (!sink.tolerant) throw new Error(source.reason)
      sink.drop(at, source.reason, 'stripped')
      continue
    }
    const refName = row.ref === undefined ? undefined : text(row.ref, 256)
    if (row.ref !== undefined && (refName === undefined || !REF_OR_PATH.test(refName))) {
      if (!sink.tolerant) throw new Error('invalid delivered marketplace ref')
      sink.drop(at, 'invalid delivered marketplace ref', 'stripped')
      continue
    }
    // `settings-reference.md#extraknownmarketplaces`'s `autoUpdate` — "Set
    // `"autoUpdate": true` alongside `source` to make Claude Code refresh that
    // marketplace and update its installed plugins in the background after
    // startup." STRICT Boolean: `"true"`, `1` and `"yes"`
    // are all refused rather than coerced, because this key schedules an
    // unattended re-fetch of a code-distribution channel and a coerced truthy
    // string would turn a typo into a standing background job. The defect is
    // recorded through the same sink `ref` uses, so an administrator sees it
    // instead of the silence the key got before this.
    //
    // Unlike `name`, `source` and `ref`, a bad value here does NOT drop the
    // entry. Those three IDENTIFY the marketplace — without them there is
    // nothing to deliver — while `autoUpdate` only modifies one. Dropping the
    // whole delivery over a typo in an optional field would take the
    // marketplace away from every user in the fleet, which is a far larger
    // consequence than the typo. Fail-closed here means "do not auto-update",
    // so the field falls back to the documented polarity and the receipt tells
    // the administrator why.
    const autoUpdate = typeof row.autoUpdate === 'boolean' ? row.autoUpdate : undefined
    if (row.autoUpdate !== undefined && autoUpdate === undefined) {
      if (!sink.tolerant) throw new Error('invalid delivered marketplace autoUpdate')
      sink.drop(at, 'invalid delivered marketplace autoUpdate', 'stripped')
    }
    // Two entries naming the same source would register once anyway (the add
    // path dedupes on the source string); the FIRST name wins so the outcome
    // does not depend on object key order.
    if (seen.has(name) || seen.has(`source:${source}`)) continue
    seen.add(name)
    seen.add(`source:${source}`)
    const credential = deliveredMarketplaceHeaders(row.source, at, sink, commandSourcesAllowed)
    kept.push(Object.freeze({
      name,
      source,
      ...(refName === undefined ? {} : { refName }),
      ...(autoUpdate === undefined ? {} : { autoUpdate }),
      ...(credential?.headers === undefined ? {} : { headers: credential.headers }),
      ...(credential?.headersHelper === undefined ? {} : { headersHelper: credential.headersHelper }),
    }))
  }
  return Object.freeze(kept)
}

/** The two accepted spellings, flattened to one row shape. */
function deliveredRows(value: unknown): Array<{
  at: string
  name: unknown
  source: unknown
  ref: unknown
  autoUpdate: unknown
}> | null {
  if (Array.isArray(value)) {
    return value.map((raw, index) => {
      const object = record(raw) ?? {}
      return {
        at: `[${index}]`,
        name: object.name,
        source: object.source,
        ref: object.ref,
        autoUpdate: object.autoUpdate,
      }
    })
  }
  const object = record(value)
  if (!object) return null
  return Object.entries(object).map(([name, raw]) => {
    const entry = record(raw)
    // `:850` nests the source under a `source` key; a bare string value is the
    // same declaration with the wrapper omitted. A bare string carries no
    // sibling keys at all, so it can declare no `autoUpdate` either.
    return entry
      ? { at: name, name, source: entry.source, ref: entry.ref, autoUpdate: entry.autoUpdate }
      : { at: name, name, source: raw, ref: undefined, autoUpdate: undefined }
  })
}

/* ------------------------------------------------------------------------- *
 * The official Anthropic marketplace
 * ------------------------------------------------------------------------- */

/**
 * `plugins/security.md#official-marketplace-names` — the official Anthropic marketplace is
 * `anthropics/claude-plugins-official`, and `plugin-relevance.md` § Enable
 * suggestions names it `claude-plugins-official`.
 *
 * NOTHING IN THIS FORK REGISTERS IT. Nessy ships the built-in Skills Market and
 * whatever an administrator delivers; there is no official-Anthropic marketplace
 * on any Nessy workstation, so in practice every one of the two predicates below
 * answers "no" and every documented default lands on `false`.
 *
 * They are implemented anyway, and deliberately.
 * `settings-reference.md#extraknownmarketplaces` and
 * `plugins/loading.md#which-marketplaces-and-plugins-auto-update` state the default as a POLARITY,
 * not as a blanket
 * `false`; encoding only the half we can reach today would leave a hidden `true`
 * — an unattended background re-fetch nobody asked for — waiting for the day the
 * first official marketplace is added. Written down, the polarity is auditable
 * and its one reachable branch is testable.
 */
export const OFFICIAL_ANTHROPIC_MARKETPLACE_NAME = 'claude-plugins-official'

/** The `owner/repo` the official marketplace name can register from. */
const OFFICIAL_ANTHROPIC_MARKETPLACE_REPO = 'anthropics/claude-plugins-official'

/**
 * True when a raw marketplace source string IS the official Anthropic
 * marketplace. Decided on the CLASSIFIED identity, never on the raw text, so
 * `anthropics/claude-plugins-official`, `https://github.com/anthropics/claude-plugins-official`
 * and its `.git` spelling all answer the same.
 */
export function isOfficialAnthropicMarketplaceSource(source: string, refName?: string): boolean {
  return managedMarketplaceSourceIdentity(source, refName).repo === OFFICIAL_ANTHROPIC_MARKETPLACE_REPO
}

/**
 * `settings-reference.md#extraknownmarketplaces` — "When omitted,
 * `claude-plugins-official` and most other official Anthropic marketplaces
 * default to `true`, and third-party marketplaces default to `false`." Said again
 * on `plugins/loading.md#which-marketplaces-and-plugins-auto-update`: "`claude-plugins-official` and
 * most other official Anthropic marketplaces have auto-update enabled by default.
 * Third-party and local development marketplaces have auto-update disabled by
 * default."
 *
 * This is the LAST step of the resolution order, consulted only when neither the
 * managed policy nor the user's own toggle has an answer.
 */
export function defaultMarketplaceAutoUpdate(source: string, refName?: string): boolean {
  return isOfficialAnthropicMarketplaceSource(source, refName)
}

/**
 * P6.385 — the claude child's own opt-out from auto-installing the official
 * Anthropic marketplace.
 *
 * `data-usage.md#default-behaviors-by-api-provider`, verbatim: *"This variable
 * doesn't affect the WebFetch check or official plugin marketplace
 * auto-install; each has its own opt-out: `skipWebFetchPreflight` in settings
 * for WebFetch, and `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` for
 * the marketplace."* So the non-essential-traffic switch this fork already sets
 * does NOT cover it — the page says so in the same sentence that names it.
 *
 * **Native-first case (1): enable what the runtime already has.** Measured on
 * the shipped `claude-agent-sdk-darwin-arm64/claude` at 2.1.247 (re-measured
 * 2026-09-12, C3.252) —
 * `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL` → **3 lines / 3
 * occurrences**, unchanged from the 3 read at 2.1.233, an
 * unused-name control → **0/0**, and the whole first-party tree → **0 files**
 * (`git grep -ail -F` over `:(glob)packages/**` `:(glob)apps/**`). The opt-out
 * exists in the binary we ship and nothing in this fork sets it.
 *
 * **Why it must be set rather than left alone**, and this is the half a reader
 * usually misses: the child runs with a PER-WORKSPACE `CLAUDE_CONFIG_DIR`, so
 * an auto-install lands in a tree the host's plugin policy never reads. The
 * result is not "an extra marketplace we tolerate" — it is a marketplace
 * outside `strictKnownMarketplaces`, outside `blockedMarketplaces`, and outside
 * every allowlist this module exists to enforce. The block above records that
 * NOTHING IN THIS FORK REGISTERS the official marketplace; without this
 * variable the child registers it for us.
 *
 * The value lives here, with the marketplace policy it belongs to, rather than
 * as a literal at the env-building call site — that file writes many names and
 * none of them can carry this reasoning.
 */
export const OFFICIAL_MARKETPLACE_AUTOINSTALL_OFF_ENV =
  'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL'

/**
 * The environment entry a claude child must be spawned with. Spread into the
 * child's env — and `delete` the name before assigning, per the Bun 1.3.14
 * env-slot trap, if the caller is mutating a record rather than building one.
 *
 * `1` rather than `true`: every documented sibling in this family is probed as
 * `1` by the same binary, and the page's own examples for the neighbouring
 * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` use `1`.
 */
export function officialMarketplaceAutoinstallOffEnv(): Readonly<Record<string, string>> {
  return Object.freeze({ [OFFICIAL_MARKETPLACE_AUTOINSTALL_OFF_ENV]: '1' })
}

/* ------------------------------------------------------------------------- *
 * Identity
 * ------------------------------------------------------------------------- */

/**
 * `owner/repo`. Neither segment may be `.` or `..` or start with a dot: the dot
 * is in the charset because real repository names contain one, and without this
 * guard `../evil` and `./x` are shorthand-shaped, so a `hostPattern` allowing
 * github.com would admit an arbitrary LOCAL directory.
 */
const GITHUB_SHORTHAND = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/
const SCP_LIKE = /^([^@\s/]+@)?([^:\s/]+):(.+)$/

/** Anything our own source resolver would treat as a path on sight. */
function looksLikePath(raw: string): boolean {
  return raw.startsWith('/')
    || raw.startsWith('./')
    || raw.startsWith('../')
    || raw === '.'
    || raw === '..'
    || raw.startsWith('~')
    || raw.includes('\\')
    || /^[A-Za-z]:[\\/]/.test(raw)
}

/**
 * The path a `pathPattern` is matched against: absolute and `..`-collapsed.
 *
 * `:769` matches "the marketplace's filesystem path", which is the path the
 * source resolves to, not the text typed. Matching the raw text let
 * `/opt/approved/../../tmp/evil` satisfy `^/opt/approved/` while resolving to
 * `/tmp/evil`, and stopped `~/x` matching any absolute pattern at all. `resolve`
 * and `homedir` are pure — neither touches the filesystem — so the check still
 * runs before any filesystem operation.
 */
function normalizeFilesystemPath(raw: string): string {
  const expanded = raw === '~' || raw.startsWith('~/')
    ? join(homedir(), raw.slice(1))
    : raw
  return resolve(expanded)
}

/**
 * Classify a raw marketplace source string. PURE: no filesystem access, so the
 * check can honour `:762`'s "before any network or filesystem operation".
 *
 * `:953` — "`<source>`: GitHub `owner/repo` shorthand, git URL, remote URL to a
 * `marketplace.json` file, or local directory path". `:955` — "A URL must include
 * its scheme. As of Claude Code v2.1.196, a host typed without one, such as
 * `gitlab.example.com/team/plugins`, is rejected as an invalid `owner/repo`
 * shorthand", so a bare host with a path is neither a URL nor a shorthand here
 * and proves no dimension at all — which the allowlist reads as "matches
 * nothing".
 *
 * The path test runs FIRST, before the shorthand test, because a path is the one
 * shape whose misclassification widens the allowlist rather than narrowing it.
 */
export function managedMarketplaceSourceIdentity(
  source: string,
  refName?: string,
): ManagedMarketplaceSourceIdentityV1 {
  const raw = source.trim()
  const ref = refName?.trim() || undefined
  const base = { raw, ...(ref ? { ref } : {}) }

  if (looksLikePath(raw)) {
    return { ...base, filesystemPath: normalizeFilesystemPath(raw) }
  }
  if (GITHUB_SHORTHAND.test(raw)) {
    return { ...base, host: 'github.com', repo: raw }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    return { ...base, ...urlIdentity(raw, ref) }
  }
  const scp = SCP_LIKE.exec(raw)
  if (scp) {
    // `git@github.com:owner/repo.git` — an SSH remote, whose host is the field
    // `hostPattern` matches on.
    const host = scp[2]?.toLowerCase()
    const repoPath = (scp[3] ?? '').replace(/^\/+/, '').replace(/\.git$/i, '')
    return {
      ...base,
      ...(host ? { host } : {}),
      ...(host === 'github.com' && GITHUB_SHORTHAND.test(repoPath) ? { repo: repoPath } : {}),
    }
  }
  // Neither a scheme-bearing URL, an SSH remote, a shorthand, nor a path-looking
  // string. It proves nothing, so nothing can allow it.
  return base
}

/**
 * The identity of a source that has already been CLASSIFIED by the install-source
 * resolver.
 *
 * The pure classifier above cannot see one thing the resolver can: our resolver
 * treats a bare `acme/plugins` as a LOCAL directory when one exists relative to
 * the working directory, so a `hostPattern` for github.com would admit an install
 * from that directory. Re-deriving the identity from the resolved source closes
 * that gap. It runs only AFTER the pure check has already refused everything it
 * can refuse, so nothing the allowlist rejects ever reaches a filesystem probe.
 */
export function managedMarketplaceResolvedIdentity(
  raw: string,
  resolved:
    | { kind: 'local-path'; path: string }
    | { kind: 'repository'; repositoryUrl: string; ref?: string; subdirectory?: string }
    | { kind: string },
  refName?: string,
): ManagedMarketplaceSourceIdentityV1 {
  const trimmed = raw.trim()
  const ref = refName?.trim() || undefined
  if (resolved.kind === 'local-path') {
    return { raw: trimmed, ...(ref ? { ref } : {}), filesystemPath: resolve((resolved as { path: string }).path) }
  }
  if (resolved.kind === 'repository') {
    const repository = resolved as { repositoryUrl: string; ref?: string; subdirectory?: string }
    const url = urlIdentity(repository.repositoryUrl, repository.ref ?? ref)
    return {
      raw: trimmed,
      ...url,
      ...(repository.ref ?? url.ref ?? ref ? { ref: repository.ref ?? url.ref ?? ref } : {}),
      ...(repository.subdirectory ? { path: repository.subdirectory } : {}),
    }
  }
  return managedMarketplaceSourceIdentity(trimmed, refName)
}

function urlIdentity(raw: string, ref?: string): Partial<ManagedMarketplaceSourceIdentityV1> {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return {}
  }
  if (parsed.protocol === 'file:') {
    return { filesystemPath: resolve(decodeURIComponent(parsed.pathname)) }
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '')
  const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  if (host !== 'github.com' || segments.length < 2) return { host }
  const repo = `${segments[0]}/${segments[1]!.replace(/\.git$/i, '')}`
  if (!GITHUB_SHORTHAND.test(repo)) return { host }
  // `plugins/cli-reference.md#plugin-marketplace-add` — "To pin to a branch or tag,
  // append `@ref` to the GitHub shorthand or `#ref` to a git URL". The install
  // resolver honours that pin (`plugins/source-resolver.ts:parseGitUrlRefPin`),
  // and the allowlist rule at `plugins/org.md#how-entries-match` is
  // "For single-repository entries, `ref` must match exactly or be absent from
  // both the marketplace source and the allowlist entry, and the same rule
  // applies to `path`". So the pin has to be part of the IDENTITY too, in the same
  // precedence the resolver uses (pin over browse-URL ref). Left out, an
  // allowlist entry that names no ref would admit a source the resolver then
  // fetches at a pinned ref — the allowlist judging something other than what is
  // cloned, which is the one direction this classifier must never drift in.
  const pinnedRef = parsed.hash.slice(1).trim() || undefined
  // `https://github.com/owner/repo/tree/<ref>/<path>` — the browse-URL form our
  // own source classifier already accepts.
  const marker = segments[2]
  if (marker !== 'tree') return { host, repo, ...(pinnedRef ? { ref: pinnedRef } : {}) }
  const treeRef = segments[3]
  const treePath = segments.slice(4).join('/')
  const resolvedRef = pinnedRef ?? treeRef ?? ref
  return {
    host,
    repo,
    ...(resolvedRef ? { ref: resolvedRef } : {}),
    ...(treePath ? { path: treePath } : {}),
  }
}

/* ------------------------------------------------------------------------- *
 * Matching — `:764`-`:771`
 * ------------------------------------------------------------------------- */

/** `:766` — "must each match exactly or be absent from both". */
function sameOrBothAbsent(entryValue: string | undefined, sourceValue: string | undefined): boolean {
  return entryValue === undefined ? sourceValue === undefined : entryValue === sourceValue
}

/**
 * P2.483 — the ALLOWLIST's owner-wildcard row, which is stricter than the
 * blocklist's on every one of the four published rules.
 *
 * `settings-reference.md#owner-wildcards` fills in the `strictKnownMarketplaces`
 * column, verbatim:
 *
 * | Rule | `strictKnownMarketplaces` |
 * | --- | --- |
 * | Matching source spellings | "`owner/repo` form only. A git URL that clones the same repository doesn't match" |
 * | Owner case | "Case-sensitive, like exact-entry matching" |
 * | `ref` | "Follows the exact-entry rules: an entry with a `ref` matches only sources with that exact ref, and an entry without one matches only sources that don't specify a ref" |
 * | `path` | "Looser than the exact-entry rules: an entry with a `path` requires that exact value, while an entry without one matches any path inside the repository" |
 *
 * Two of those four cost real code rather than falling out of the shape, and
 * both are the narrowing direction:
 *
 *  - **the owner comparison stays case-SENSITIVE**, so it is `===` rather than
 *    the blocklist's `toLowerCase()` pair. A wildcard is not a licence to relax
 *    the rest of the rule.
 *  - **`ref` keeps {@link sameOrBothAbsent}**, so a wildcard entry naming no ref
 *    does NOT admit a ref-pinned source. That is the opposite of the blocklist,
 *    where an absent `ref` blocks every ref — and the difference is exactly why
 *    the two matchers cannot share one implementation.
 *
 * Only `path` loosens, and only within the repositories the wildcard already
 * selected: an entry with no `path` matches any path inside the repository,
 * which is the page's own sentence.
 *
 * **And rows 1 and 4 are in TENSION, recorded rather than resolved by inventing
 * a third rule.** The only source spelling that CARRIES a path is the browse URL
 * `https://github.com/owner/repo/tree/<ref>/<path>`, and row 1 excludes every
 * URL spelling. So for a wildcard entry the path arm is unreachable in both
 * directions — a path-scoped source matches nothing, whether or not the entry
 * names a path. That fails CLOSED, which is the safe half of an ambiguity, and
 * relaxing row 1 to reach it would widen a grant on an invented reading. Pinned
 * in `managed-marketplace-entries.test.ts` §"row 4".
 *
 * The FIRST row is also load-bearing and is why this branch requires
 * `identity.repo`: a `git`-source spelling of the same repository must not
 * match. The identity classifier derives `repo` from github shorthands and
 * `github.com` URLs, so a `git` source pointing elsewhere has no `repo` and
 * falls through to `false`.
 */
function matchesAllowlistOwnerWildcard(
  entry: Extract<ManagedMarketplaceEntryV1, { source: 'github' }>,
  identity: ManagedMarketplaceSourceIdentityV1,
): boolean {
  const wanted = splitRepo(entry.repo)
  const actual = identity.repo === undefined ? undefined : splitRepo(identity.repo)
  if (!wanted || !actual || wanted[1] !== '*') return false
  // Row 1, and it is the reason this takes the whole identity rather than just
  // its `repo`: "`owner/repo` form only. A git URL that clones the same
  // repository doesn't match." The classifier derives `repo` from github
  // shorthands AND from `https://github.com/...` / `git@github.com:...`
  // spellings, so `repo` alone cannot tell them apart — but the shorthand
  // branch is the ONLY one that returns `repo` equal to the source text, which
  // is exactly the distinction the page draws.
  if (identity.raw !== identity.repo) return false
  if (wanted[0] !== actual[0]) return false
  if (!sameOrBothAbsent(entry.ref, identity.ref)) return false
  // "an entry without one matches any path inside the repository" — so an
  // absent entry path accepts both a path-less source and a path-scoped one.
  return entry.path === undefined || entry.path === identity.path
}

export function matchesManagedMarketplaceEntry(
  entry: ManagedMarketplaceEntryV1,
  identity: ManagedMarketplaceSourceIdentityV1,
): boolean {
  switch (entry.source) {
    case 'github':
      if (entry.repo.endsWith('/*')) return matchesAllowlistOwnerWildcard(entry, identity)
      return identity.repo !== undefined
        && identity.repo === entry.repo
        && sameOrBothAbsent(entry.ref, identity.ref)
        && sameOrBothAbsent(entry.path, identity.path)
    case 'url':
      // `:771` — "Exact matching doesn't normalize URLs: a trailing slash, `.git`
      // suffix, or `ssh://` versus `https://` form are treated as different
      // values." So the raw string is compared, not a canonicalized one.
      return entry.url === identity.raw
    case 'hostPattern':
      return identity.host !== undefined && safeTest(entry.hostPattern, identity.host)
    case 'pathPattern':
      return identity.filesystemPath !== undefined && safeTest(entry.pathPattern, identity.filesystemPath)
  }
}

function safeTest(source: string, value: string): boolean {
  try {
    return new RegExp(source).test(value)
  } catch {
    return false
  }
}

/**
 * The whole decision. `:675`-`:679`:
 *
 * | Undefined (default) | No restrictions. Users can add any marketplace |
 * | Empty array `[]`    | Complete lockdown. Blocks every marketplace source, including the official Anthropic marketplace |
 * | List of sources     | Users can only add marketplaces that match the allowlist exactly |
 */
export function isManagedMarketplaceAllowed(
  strictKnownMarketplaces: readonly ManagedMarketplaceEntryV1[] | undefined,
  identity: ManagedMarketplaceSourceIdentityV1,
): boolean {
  if (strictKnownMarketplaces === undefined) return true
  return strictKnownMarketplaces.some(entry => matchesManagedMarketplaceEntry(entry, identity))
}
