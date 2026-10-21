/**
 * The documented managed MCP entry, and the matcher that decides on it.
 *
 * Contract: `managed-mcp.md`, fetched 2026-07-29; the line numbers below are
 * where each quotation was found.
 *
 * `:132` — "`allowedMcpServers` and `deniedMcpServers` are lists of entries.
 * Each entry is an object with a single key that identifies servers by their
 * URL, their command, or their name". Our lists were `readonly string[]`
 * validated by a name regex, so a policy written in the documented syntax parsed
 * to an EMPTY list. On the allowlist that admits nothing; on the DENYLIST it
 * blocks nothing, which is the fail-open this module exists to remove.
 *
 * `:150` states in terms why the name dimension alone is not enough: a
 * `serverName` entry "is not a security control. The name is the label a user
 * assigns … so a user can call any server `github`. … To enforce which servers
 * actually run, add `serverCommand` or `serverUrl` entries."
 */

import {
  expandConfigVariables,
  referencesConfigVariable,
  replaceConfigVariableReferences,
} from '../../mcp/server-config-values.ts'
import type { ManagedDropSink } from '../../config/managed-drops.ts'

/** `:136` — "A remote server URL, exact or with `*` wildcards". */
export interface ManagedMcpUrlEntryV1 {
  readonly serverUrl: string
}

/** `:137` — "The exact command and arguments that start a stdio server". */
export interface ManagedMcpCommandEntryV1 {
  readonly serverCommand: readonly string[]
}

/** `:138` — "The user-assigned label. Exact match only; wildcards are not expanded". */
export interface ManagedMcpNameEntryV1 {
  readonly serverName: string
}

/** One entry of `allowedMcpServers`/`deniedMcpServers`. Exactly one key. */
export type ManagedMcpEntryV1 =
  | ManagedMcpUrlEntryV1
  | ManagedMcpCommandEntryV1
  | ManagedMcpNameEntryV1

// `ws` is here for a security reason, not a completeness one: a plugin can now
// declare a ws MCP server, and an administrator's denylist must be able to name
// what a plugin can ship. A transport the identity cannot express is a transport
// the deny rule cannot cover.
export type ManagedMcpTransportV1 = 'stdio' | 'http' | 'sse' | 'ws'

/**
 * What a server actually IS, as opposed to what it is called.
 *
 * `name` is the only field the pre-S5 gate had, and `:150` disclaims it as a
 * security control. `url` and `command` are the dimensions an administrator can
 * actually enforce on; `command` is the full argv (`[command, ...args]`),
 * because `:175` matches "Every argument, in order".
 *
 * `transport` decides which allowlist row of `:168`-`:171` applies. When it is
 * absent the kind is inferred from whichever of `url`/`command` is present, and
 * when neither is present the server has no provable type — see
 * {@link isManagedMcpServerAllowed} for what that costs it.
 */
export interface ManagedMcpServerIdentityV1 {
  readonly name: string
  readonly transport?: ManagedMcpTransportV1
  readonly url?: string
  readonly command?: readonly string[]
  /**
   * Every OTHER spelling of the same argv — most importantly the resolved one,
   * when the configured command is a bare word the OS resolves at spawn.
   *
   * P3.217. A server can be true under two argvs at once: the built-in dp set is
   * CONFIGURED as `dp ai mcp <sub>` and SPAWNED as
   * `/usr/local/bin/dp ai mcp <sub>`, because an agent subprocess does not
   * necessarily inherit the PATH that found dp
   * (`builtin-dp-servers.ts:materializeBuiltinDpMcpServers`). Judging only the
   * configured spelling meant a denylist entry written the way `which dp` prints
   * it looked correct, read correct in the UI, and blocked nothing.
   *
   * This is an IDENTITY widening, not a MATCHING one: `:175`'s "Commands match
   * exactly. Every argument, in order" still governs each comparison, and a
   * pattern still has to equal one full argv token for token. What changed is
   * how many argvs the server admits to having. The precedent is
   * `permissions.md` § Cd, which says the same thing for paths — "Deny rules
   * check every spelling of the target, including each symlink hop it resolves
   * through, so a rule written for one path also blocks targets that resolve to
   * it" — and which this repo already models as `alternatePaths`.
   *
   * Populated only where the resolved argv is KNOWN for free. Where it is not —
   * the capability mirror, which would have to scan PATH on every resolve and
   * would then report differently on a machine with dp than on CI without it —
   * the identity carries the configured spelling alone and enforces strictly
   * less than the policy says, exactly as {@link managedMcpEntryNames}'s
   * consumers already do. The load-bearing gate is
   * {@link isManagedMcpServerAllowed}, and it is given both.
   */
  readonly alternateCommands?: readonly (readonly string[])[]
}

/* ------------------------------------------------------------------------- *
 * Parsing
 * ------------------------------------------------------------------------- */

/**
 * The three entry keys, and the order a multi-key DENY entry is enforced in.
 *
 * This array is not style. `parseManagedMcpEntry` reads a denylist entry
 * carrying more than one recognised key as one deny PER key, and it emits them
 * in THIS order rather than in the order the administrator wrote them — so when
 * `parseManagedMcpEntryList` hits the `MCP_ENTRIES_MAX` ceiling part-way
 * through such an entry, the order decides **which server stops being
 * blocked**: the keys later in this array are the ones cut. Reversing it would
 * silently move the loss from the `serverName` deny to the `serverUrl` one,
 * with no test, type or diagnostic changing.
 *
 * That boundary is pinned from the test side by
 * `managed-mcp-entries.test.ts`'s *"the per-entry drop path stops at the 128th
 * KEPT entry"*, which walks 43 three-key entries into the ceiling and asserts
 * the 43rd keeps its `serverUrl` and `serverCommand` and loses its
 * `serverName`. A killed session's hand-over test asserted the opposite entry
 * with full confidence, which is why the consequence is written here and not
 * only there.
 *
 * The order is the page's own table order in
 * `managed-mcp.md#match-servers-by-url-command-or-name`, and the Warning under
 * that table is why it is the right way round: "A `serverName` entry, in either
 * list, is not a security control. … To enforce which servers actually run, add
 * `serverCommand` or `serverUrl` entries." The key the page disclaims is last,
 * so a full list drops the deny that was never enforcement to begin with.
 */
const MCP_ENTRY_KEYS = ['serverUrl', 'serverCommand', 'serverName'] as const
type ManagedMcpEntryKey = typeof MCP_ENTRY_KEYS[number]

const MCP_ENTRIES_MAX = 128
const URL_PATTERN_MAX = 2048
const COMMAND_ARGV_MAX = 64
const COMMAND_ARGUMENT_MAX = 1024
const SERVER_NAME_MAX = 256

/**
 * C0/C1/DEL and the line separators. A policy entry carrying one could forge a
 * second line in the drop summary an operator reads on stderr, and no real
 * server name, URL or argv needs one.
 */
const MCP_ENTRY_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/**
 * The allowlist's `serverName` charset.
 *
 * `:156` — "In `allowedMcpServers`, `serverName` is limited to letters,
 * numbers, hyphens, and underscores." This pattern is that set PLUS `.`, and it
 * additionally requires the first character to be alphanumeric.
 *
 * The `.` is deliberate and is the one place this module is wider than the
 * page. It is the charset our deployed `allowedMcpServers` has always used
 * (the pre-S5 `MCP_SERVER` regex), and this list is a grant: narrowing the
 * VALIDATOR would strip an existing administrator's `{"serverName":"my.server"}`
 * and stop that server loading — a silent fleet-wide narrowing to satisfy a
 * restriction the page gives no reason for. The leading-alphanumeric rule is
 * kept from the same regex; a name beginning with `-` is argv-shaped and we
 * have never accepted one.
 */
const ALLOW_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Which list an entry belongs to. The two validate `serverName` differently. */
export type ManagedMcpListKind = 'allow' | 'deny'

function validateUrlPattern(value: unknown): ManagedMcpUrlEntryV1 | undefined {
  if (typeof value !== 'string') return undefined
  if (value.trim().length === 0 || value.length > URL_PATTERN_MAX) return undefined
  if (MCP_ENTRY_FORBIDDEN.test(value) || /\s/.test(value)) return undefined
  return { serverUrl: value }
}

function validateCommandPattern(value: unknown): ManagedMcpCommandEntryV1 | undefined {
  if (!Array.isArray(value)) return undefined
  if (value.length === 0 || value.length > COMMAND_ARGV_MAX) return undefined
  for (const [index, token] of value.entries()) {
    if (typeof token !== 'string') return undefined
    if (token.length > COMMAND_ARGUMENT_MAX || MCP_ENTRY_FORBIDDEN.test(token)) return undefined
    // Argument 0 is the executable. An empty later argument is legitimate
    // (`--flag ""`), an empty executable can never start anything.
    if (index === 0 && token.trim().length === 0) return undefined
  }
  return { serverCommand: Object.freeze([...value as string[]]) }
}

/**
 * `:155` — "In `deniedMcpServers`, `serverName` accepts any non-empty string,
 * so you can block claude.ai connectors by their display name. For example,
 * `{ "serverName": "claude.ai Slack" }` blocks the Slack connector."
 */
function validateServerName(value: unknown, list: ManagedMcpListKind): ManagedMcpNameEntryV1 | undefined {
  if (typeof value !== 'string') return undefined
  if (value.trim().length === 0 || value.length > SERVER_NAME_MAX) return undefined
  if (MCP_ENTRY_FORBIDDEN.test(value)) return undefined
  if (list === 'allow' && !ALLOW_SERVER_NAME.test(value)) return undefined
  return { serverName: value }
}

function validateEntryKey(
  key: ManagedMcpEntryKey,
  value: unknown,
  list: ManagedMcpListKind,
): ManagedMcpEntryV1 | undefined {
  if (key === 'serverUrl') return validateUrlPattern(value)
  if (key === 'serverCommand') return validateCommandPattern(value)
  return validateServerName(value, list)
}

/** What one raw entry produced, and why it is not simply itself. */
interface ParsedMcpEntryV1 {
  readonly entries: readonly ManagedMcpEntryV1[]
  /** Set when the entry was refused outright: nothing usable in it. */
  readonly refused?: string
  /** Set when the entry was REINTERPRETED rather than taken at face value. */
  readonly reinterpreted?: string
}

/**
 * Parse one raw entry.
 *
 * Three shapes are accepted:
 *
 * 1. The documented object with exactly one of the three keys.
 * 2. A BARE STRING, read as `{ serverName: … }`. This is the shape our own
 *    `managed-policy.json` has always used and it is deployed; dropping it to
 *    gain the documented one would break the administrators we have.
 * 3. On the DENYLIST ONLY, an object carrying more than one recognised key, or
 *    a recognised key beside an unrecognised one. See {@link parseManagedMcpEntryList}
 *    for why that is not simply refused.
 */
function parseManagedMcpEntry(raw: unknown, list: ManagedMcpListKind): ParsedMcpEntryV1 {
  if (typeof raw === 'string') {
    const entry = validateServerName(raw, list)
    return entry
      ? { entries: [entry] }
      : { entries: [], refused: `invalid managed MCP ${list}list serverName` }
  }
  const object = record(raw)
  if (!object) return { entries: [], refused: `invalid managed MCP ${list}list entry` }
  const present = MCP_ENTRY_KEYS.filter(key => object[key] !== undefined)
  const unknown = Object.keys(object).filter(key => !(MCP_ENTRY_KEYS as readonly string[]).includes(key))
  if (present.length === 0) {
    return { entries: [], refused: `invalid managed MCP ${list}list entry: no serverUrl, serverCommand or serverName` }
  }
  const parsed = present
    .map(key => validateEntryKey(key, object[key], list))
    .filter((entry): entry is ManagedMcpEntryV1 => entry !== undefined)
  const clean = present.length === 1 && unknown.length === 0
  if (clean) {
    return parsed.length === 1
      ? { entries: parsed }
      : { entries: [], refused: `invalid managed MCP ${list}list ${present[0]}` }
  }
  // `:132` — "an object with a single key". An entry with two of them, or with
  // a typo beside a good key, is not the documented shape.
  const defect = unknown.length > 0
    ? `managed MCP ${list}list entry carries an unrecognized key: ${unknown[0]}`
    : `managed MCP ${list}list entry carries ${present.length} keys, and the schema allows one`
  if (list === 'allow' || parsed.length === 0) {
    return { entries: [], refused: defect }
  }
  // The DENY pole. Stripping this entry would UNBLOCK every server it names,
  // which is the failure this unit exists to remove; and each surviving key is
  // a server the administrator wrote down by hand, so honouring all of them
  // blocks nothing "the policy never named" — the exact bound the
  // `deniedMcpServers` row of `managed-settings.md#keys-that-fail-closed` sets on
  // how far a denylist defect may be read. Recorded as a reinterpretation
  // so `nessy-general-agent doctor` names the entry and the reading it took.
  return { entries: parsed, reinterpreted: `${defect}; every valid key in it is enforced as its own deny` }
}

/** Canonical identity of an entry, for de-duplication. */
function entryToken(entry: ManagedMcpEntryV1): string {
  if ('serverUrl' in entry) return `url:${entry.serverUrl}`
  if ('serverCommand' in entry) return `command:${JSON.stringify(entry.serverCommand)}`
  return `name:${entry.serverName}`
}

/**
 * Parse one whole list.
 *
 * The per-defect behaviour is the `allowedMcpServers` row of
 * `managed-settings.md#keys-that-fail-closed` against the `deniedMcpServers` row
 * of the same table — the pair that reacts to the same defect in OPPOSITE
 * directions:
 *
 * - `allowedMcpServers` wholly invalid → an EMPTY allowlist, so no server is
 *   admitted until it is fixed.
 * - `deniedMcpServers` wholly invalid → the field is DROPPED, "since denying
 *   every server would block servers the policy never named".
 * - Either list, one invalid entry → "An individual invalid entry is stripped
 *   and the valid subset is enforced."
 *
 * That last rule is the sharp edge, because stripping means opposite things on
 * the two lists: on the allowlist it NARROWS, which is safe, and on the
 * denylist it UNBLOCKS a server the administrator listed. Both poles were
 * considered and neither alternative survives the page: reading a broken deny
 * entry as "block everything" is what the `deniedMcpServers` row rules out by
 * name, and refusing the document is what
 * `managed-settings.md#invalid-entries-in-managed-settings` rules out — "Claude
 * Code first skips the individual entries it can repair, such as one invalid
 * permission rule, with a warning for each, then drops any top-level key whose
 * value still fails and keeps enforcing every remaining valid key."
 *
 * That last citation used to carry a reassurance instead of the rule: that a
 * single typo cannot disable the rest of your organization's policy. The word
 * "typo" is on none of the successor pages (checked 2026-09-10, positive control
 * "tolerance" 1), so the per-key fallback above is quoted and the reassurance is
 * dropped rather than re-anchored.
 *
 * So the documented strip
 * stands, and what changes is that it is no longer silent — every strip is a
 * drop, `doctor` lists it with its source and field, and a denylist strip says
 * in its reason that the entry now blocks nothing.
 *
 * Returns `undefined` when the whole field is dropped. The STRICT sink throws on
 * the first defect, which is the posture
 * `managed-settings.md#keys-that-fail-closed` gives user, project and local
 * settings: "This tolerance applies only to managed settings. User, project, and
 * local settings files remain strict: a file whose JSON or top-level shape fails
 * validation is rejected as a whole and reported, and an individual entry that
 * fails, such as a malformed permission rule, is skipped with a warning while the
 * rest of the file applies."
 */
export function parseManagedMcpEntryList(
  value: unknown,
  options: { list: ManagedMcpListKind; field: string; sink: ManagedDropSink },
): readonly ManagedMcpEntryV1[] | undefined {
  const { list, field, sink } = options
  if (!Array.isArray(value) || value.length > MCP_ENTRIES_MAX) {
    const reason = `invalid managed Pi policy ${field}`
    if (!sink.tolerant) throw new Error(reason)
    if (list === 'allow') {
      sink.drop(field, reason, 'emptied')
      return Object.freeze([])
    }
    sink.drop(field, `${reason}; no server is blocked by it`, 'stripped')
    return undefined
  }
  const kept: ManagedMcpEntryV1[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const at = `${field}[${index}]`
    const parsed = parseManagedMcpEntry(raw, list)
    if (parsed.refused !== undefined) {
      const reason = list === 'deny'
        ? `${parsed.refused}; the server it named is NOT blocked`
        : parsed.refused
      if (!sink.tolerant) throw new Error(reason)
      sink.drop(at, reason, 'stripped')
      continue
    }
    if (parsed.reinterpreted !== undefined) {
      if (!sink.tolerant) throw new Error(parsed.reinterpreted)
      sink.drop(at, parsed.reinterpreted, 'tightened')
    }
    for (const entry of parsed.entries) {
      const token = entryToken(entry)
      if (seen.has(token)) continue
      if (kept.length >= MCP_ENTRIES_MAX) {
        const reason = `managed Pi policy ${field} exceeds ${MCP_ENTRIES_MAX} entries`
        if (!sink.tolerant) throw new Error(reason)
        sink.drop(at, reason, 'stripped')
        continue
      }
      seen.add(token)
      kept.push(entry)
    }
  }
  return Object.freeze(kept)
}

/**
 * The `serverName` entries of a list, as bare names.
 *
 * For the consumers whose only handle on a server is its slug — the MCP channel
 * gate is the one we have. A `serverUrl`/`serverCommand` deny cannot be
 * projected onto a slug, so those consumers enforce strictly less than the
 * policy says; the load-bearing gate is {@link isManagedMcpServerAllowed}, which
 * sees the whole identity.
 */
export function managedMcpEntryNames(
  entries: readonly ManagedMcpEntryV1[] | undefined,
): readonly string[] | undefined {
  if (entries === undefined) return undefined
  return Object.freeze(entries.flatMap(entry => 'serverName' in entry ? [entry.serverName] : []))
}

/* ------------------------------------------------------------------------- *
 * Matching — `:173`-`:187`
 * ------------------------------------------------------------------------- */

/**
 * `:176` — "`serverCommand` and `serverUrl` values expand before matching. Both
 * the policy entry and the server's configured value go through the same
 * `${VAR}` and `${VAR:-default}` expansion as `.mcp.json`, so an entry written
 * as `["${HOME}/bin/server"]` matches a server config that uses either the same
 * reference or the expanded path. … `serverName` values match literally and
 * never expand."
 *
 * The SAME expansion, not a second one: `expandConfigVariables` is the
 * `.mcp.json` reader's own grammar, and a policy that disagreed with it about
 * `${VAR:-default}` would deny a server whose config it could not read.
 *
 * THE "NO MATCHING RULE CAN CLOSE IT" THAT USED TO END THIS COMMENT WAS WRONG,
 * and P2.375 is the correction. The bypass was narrowed upstream, and the page
 * says so by version — `managed-mcp.md#how-policy-entries-expand`, which closes
 * with "Requires Claude Code v2.1.219 or later", gives the two rules in one
 * table. The column is "Expansion that would change a URL entry's scheme, host,
 * or path scope"; the `allowedMcpServers` row is "Claude Code ignores the
 * entry", the `deniedMcpServers` row is "The entry still matches".
 *
 * They are deliberately OPPOSITE, and that asymmetry is the whole mechanism: a
 * variable can neither widen an allow nor steer anything out of a deny. See
 * {@link urlEntryScopeIsVariableDetermined} for the predicate they share and
 * `docs/architecture/managed-mcp-access.md` for what is still divergent — the
 * PINNED environment this section also introduces is not implemented, so both
 * sides here still expand from the live one.
 */
function expand(value: string, environment: Record<string, string | undefined>): string {
  return expandConfigVariables(value, environment).value
}

function processEnvironment(): Record<string, string | undefined> {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
}

/**
 * `:177` — "URLs support `*` wildcards anywhere in the pattern, including the
 * scheme." Every other character is literal.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*')
  return new RegExp(`^${escaped}$`)
}

/**
 * Split a URL or URL pattern into the part that is matched case-INsensitively
 * (scheme + host + port) and the part that is not (`:177` — "Paths stay
 * case-sensitive").
 *
 * The split is what keeps a `*` in the authority from consuming a `/` and
 * reaching into the path: `https://*.example.com` can never match
 * `https://evil.test/.example.com`.
 */
function splitUrl(value: string): { authority: string; path: string } {
  const schemeEnd = value.indexOf('://')
  const from = schemeEnd === -1 ? 0 : schemeEnd + 3
  const slash = value.indexOf('/', from)
  return slash === -1
    ? { authority: value, path: '' }
    : { authority: value.slice(0, slash), path: value.slice(slash) }
}

/**
 * `:177` — "Hostname matching is case-insensitive and ignores a trailing FQDN
 * dot, so `https://Mcp.Example.com/*` matches `https://mcp.example.com/api`."
 *
 * Applied to BOTH sides, because either can carry the dot or the capitals.
 */
function normalizeAuthority(authority: string): string {
  const lower = authority.toLowerCase()
  const schemeEnd = lower.indexOf('://')
  const prefix = schemeEnd === -1 ? '' : lower.slice(0, schemeEnd + 3)
  const host = schemeEnd === -1 ? lower : lower.slice(schemeEnd + 3)
  const colon = host.lastIndexOf(':')
  // A port, not an IPv6 group or a userinfo colon: digits, or the `*` of
  // `http://localhost:*/*`.
  const hasPort = colon > 0 && /^[0-9*]+$/.test(host.slice(colon + 1))
  const hostname = hasPort ? host.slice(0, colon) : host
  const port = hasPort ? host.slice(colon) : ''
  return `${prefix}${hostname.replace(/\.+$/, '')}${port}`
}

/** `:177` and the pattern table at `:179`-`:185`. */
export function matchesManagedMcpUrlPattern(pattern: string, url: string): boolean {
  const entry = splitUrl(pattern)
  const server = splitUrl(url)
  if (!globToRegExp(normalizeAuthority(entry.authority)).test(normalizeAuthority(server.authority))) {
    return false
  }
  // `:182` — "A pattern with no path matches any path".
  if (entry.path === '') return true
  return globToRegExp(entry.path).test(server.path)
}

/**
 * Whether a variable — not the administrator — decides this URL entry's scheme,
 * host or path scope.
 *
 * The predicate behind `managed-mcp.md#how-policy-entries-expand`'s third
 * column, "Expansion that would change a URL entry's scheme, host, or path
 * scope". Both fail-directions read it and then go opposite ways.
 *
 * Three things it is deliberately NOT:
 *
 * - It is not "the entry contains a `${`". It is a comparison of the entry AS
 *   WRITTEN against the entry AS EXPANDED, through the same {@link splitUrl} /
 *   {@link normalizeAuthority} decomposition the matcher itself uses, so a
 *   pattern whose expansion lands on the same scheme, host and path is left
 *   alone. A LITERAL entry — the resolution the page prescribes, "use literal
 *   URLs and commands for entries you rely on for enforcement" — can never
 *   trip it, which is what keeps this guard off every policy already deployed.
 *
 * - It does not exempt an UNRESOLVABLE reference, and that is the one branch
 *   worth reading twice. `expandConfigVariables` leaves `${VAR}` literal when
 *   nothing supplies it, so the as-written and as-expanded texts are then
 *   IDENTICAL and a pure text comparison would return false. That would make
 *   unsetting the variable the cheapest escape of all — cheaper than steering
 *   it — and would invert the guard on the deny side. A reference that survives
 *   expansion is still a scope this environment decides.
 *
 * - It says nothing about `serverCommand`, and P2.397 measured that this is
 *   PARITY with the vendor rather than a gap in us. Both sources were read,
 *   because a null you measured is worth more than a guard you guessed:
 *
 *   **The page is silent.** Re-fetched 2026-09-03,
 *   `managed-mcp.md#how-policy-entries-expand`'s third column still reads
 *   "Expansion that would change a URL entry's scheme, host, or path scope",
 *   with no command-side column and no command-side row; the section still
 *   closes "Requires Claude Code v2.1.219 or later".
 *
 *   **The bundle is silent, and it says so structurally.** In the shipped
 *   `claude` binary (`claude-agent-sdk-darwin-arm64`, `claudeCodeVersion
 *   2.1.247` — AHEAD of the version the section requires, so this is not the
 *   bundle lagging the page) the two expanders are not the same shape. The URL
 *   expander returns an `unsafeExpansion` verdict computed from scheme,
 *   authority, path, wildcard and traversal changes, and the allowlist loop
 *   skips an entry on it (`if (f) continue`). The COMMAND expander returns
 *   `{ expanded, missingVars }` and nothing else — no unsafe-expansion verdict
 *   exists for an argv — and the allowlist's command branch reports the
 *   telemetry pair with the flag hard-coded false. A missing variable is logged
 *   ("MCP policy predicate references environment variable(s) not present in
 *   the policy expansion env") and changes no verdict on either side.
 *
 *   So there is no argv analogue to implement, in the page or in the binary,
 *   and adding one here would make our allowlist NARROWER than the vendor's on
 *   a policy the vendor accepts — a silent fleet-wide narrowing of exactly the
 *   kind the `.` in {@link ALLOW_SERVER_NAME} was kept to avoid. The deliberate
 *   choice is therefore to expand and match a `${VAR}` argv entry with no
 *   guard, and to say so rather than leave it looking unconsidered.
 *   `docs/architecture/managed-mcp-access.md` carries the same verdict.
 */
function urlEntryScopeIsVariableDetermined(pattern: string, expanded: string): boolean {
  if (!referencesConfigVariable(pattern)) return false
  if (referencesConfigVariable(expanded)) return true
  const written = splitUrl(pattern)
  const after = splitUrl(expanded)
  return normalizeAuthority(written.authority) !== normalizeAuthority(after.authority)
    || written.path !== after.path
}

/**
 * `:175` — "Commands match exactly. Every argument, in order. `["npx", "-y",
 * "server"]` does not match `["npx", "server"]` or `["npx", "-y", "server",
 * "--flag"]`." No wildcards, no prefix match, no re-ordering.
 */
function matchesCommandPattern(
  pattern: readonly string[],
  argv: readonly string[],
  environment: Record<string, string | undefined>,
): boolean {
  if (pattern.length !== argv.length) return false
  return pattern.every((token, index) => expand(token, environment) === expand(argv[index]!, environment))
}

/**
 * Whether one entry matches one server.
 *
 * `list` is what makes the two fail-directions of
 * `managed-mcp.md#how-policy-entries-expand` expressible here at all, since the
 * same URL entry means opposite things on the two lists. There is no safe
 * default for it — a wrong guess fails open in one direction or the other — so
 * `'deny'` is chosen for the narrow reason that it preserves this function's
 * pre-P2.375 behaviour for every existing caller, and the one caller that needs
 * the distinction ({@link evaluateManagedMcpServer}) passes it explicitly.
 */
export function matchesManagedMcpEntry(
  entry: ManagedMcpEntryV1,
  server: ManagedMcpServerIdentityV1,
  environment: Record<string, string | undefined> = processEnvironment(),
  list: ManagedMcpListKind = 'deny',
): boolean {
  if ('serverName' in entry) return entry.serverName === server.name
  if ('serverUrl' in entry) {
    if (server.url === undefined) return false
    const url = expand(server.url, environment)
    const expanded = expand(entry.serverUrl, environment)
    if (!urlEntryScopeIsVariableDetermined(entry.serverUrl, expanded)) {
      return matchesManagedMcpUrlPattern(expanded, url)
    }
    // ALLOW — "Claude Code ignores the entry". A grant whose scope a variable
    // decides admits nothing, so no value of that variable can widen it.
    //
    // Ignored as a MATCH, not removed from the list, and the difference is
    // load-bearing: `evaluateManagedMcpServer` counts `serverUrl` entries to
    // decide whether a `serverName` entry may stand in for one. Dropping this
    // entry from that count would let the name entry admit the very server the
    // URL entry was guarding — a variable widening the allowlist by the other
    // door, which is the one outcome this row exists to make impossible.
    if (list === 'allow') return false
    // DENY — "The entry still matches". The variable may not steer the entry
    // off what the administrator wrote it to cover, so the span the variable
    // owns — and only that span — becomes unconstrained. Every literal
    // character still has to match, so `https://internal.example.com/${TEAM}/*`
    // still blocks nothing on another host. The same row's other cell says the
    // direction out loud: a deny entry's sourcing "only ever widens what the
    // entry matches".
    //
    // The expanded form is tried as well rather than assumed subsumed: a value
    // carrying a `/` moves the authority/path boundary, and then neither form
    // is a superset of the other.
    return matchesManagedMcpUrlPattern(expanded, url)
      || matchesManagedMcpUrlPattern(replaceConfigVariableReferences(entry.serverUrl, '*'), url)
  }
  // Every spelling of the argv, not only the configured one — see
  // `ManagedMcpServerIdentityV1.alternateCommands` for why a server can have
  // more than one and why this does not widen `:175`'s exact match.
  const spellings = server.command === undefined
    ? []
    : [server.command, ...(server.alternateCommands ?? [])]
  return spellings.some(argv => matchesCommandPattern(entry.serverCommand, argv, environment))
}

/**
 * Which row of the `:168`-`:171` allowlist table a server falls on.
 *
 * `transport` decides when it is known. Otherwise the shape decides: a server
 * with a URL is remote, one with an argv is stdio. A server with NEITHER has no
 * provable type — a `.mcp.json` we could not read, or a Source whose config is
 * malformed — and `unknown` is how it says so.
 */
function transportKind(server: ManagedMcpServerIdentityV1): 'remote' | 'stdio' | 'unknown' {
  if (server.transport === 'stdio') return 'stdio'
  if (server.transport === 'http' || server.transport === 'sse') return 'remote'
  if (server.command !== undefined) return 'stdio'
  if (server.url !== undefined) return 'remote'
  return 'unknown'
}

/**
 * The three checks of § *How a server is evaluated*, in order.
 *
 * `:165` — "Check the denylist. A server that matches any denylist entry, by
 * URL, command, or name, is blocked. **Nothing overrides a denylist match.**"
 *
 * `:166` — "Check the allowlist. If `allowedMcpServers` isn't set anywhere,
 * every server that passed the denylist loads. If it is set, what the server
 * must match depends on its type". `:170`/`:171` give the two rows: a remote
 * server needs a `serverUrl` entry and "A `serverName` match counts only when
 * the allowlist contains no `serverUrl` entries"; a stdio server needs a
 * `serverCommand` entry under the same rule.
 *
 * That last clause is a property of the WHOLE list, not of one entry, which is
 * why it cannot live inside {@link matchesManagedMcpEntry}.
 *
 * A server of `unknown` type is admitted by a name entry only when the
 * allowlist carries no `serverUrl` and no `serverCommand` entry at all. We
 * cannot show it matches the stricter kind, so the enforcing pole is to refuse
 * — the same direction `:215` describes for a name entry that both stricter
 * kinds have already displaced ("A `serverName` entry in this allowlist would
 * never match anything").
 *
 * Merging across settings sources (`:164`) is not modelled: our two managed
 * sources are winner-takes-all and there is no user, project or local tier that
 * carries these keys. See `docs/architecture/managed-mcp-access.md`.
 */
export function evaluateManagedMcpServer(
  lists: {
    readonly allowedMcpServers?: readonly ManagedMcpEntryV1[] | undefined
    readonly deniedMcpServers?: readonly ManagedMcpEntryV1[] | undefined
  },
  server: ManagedMcpServerIdentityV1,
  environment: Record<string, string | undefined> = processEnvironment(),
): boolean {
  // Which list an entry sits on changes what its `${VAR}` expansion is allowed
  // to do — see {@link matchesManagedMcpEntry} — so the two poles are separate
  // predicates rather than one shared `matches`.
  const blocks = (entry: ManagedMcpEntryV1) => matchesManagedMcpEntry(entry, server, environment, 'deny')
  const admits = (entry: ManagedMcpEntryV1) => matchesManagedMcpEntry(entry, server, environment, 'allow')
  if (lists.deniedMcpServers?.some(blocks)) return false
  const allowed = lists.allowedMcpServers
  if (allowed === undefined) return true
  const kind = transportKind(server)
  const stricter = kind === 'stdio' ? 'serverCommand' : kind === 'remote' ? 'serverUrl' : undefined
  if (stricter !== undefined) {
    // Key presence, not matching: an allow entry the expansion guard ignores is
    // still a `serverUrl` entry, and still displaces the `serverName` fallback.
    const stricterEntries = allowed.filter(entry => stricter in entry)
    if (stricterEntries.some(admits)) return true
    if (stricterEntries.length > 0) return false
  } else if (allowed.some(entry => 'serverUrl' in entry || 'serverCommand' in entry)) {
    return false
  }
  return allowed.some(entry => 'serverName' in entry && admits(entry))
}
