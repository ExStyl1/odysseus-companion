/**
 * **P3.147 — our `deniedPaths` credential floor, translated into the Claude
 * SDK's own permission-rule grammar and handed to it.**
 *
 * `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`, row P3.147.
 *
 * ## Why this exists: the half our own gate cannot implement
 *
 * Isolation is OFF by standing owner decision (2026-08-12/13), so `deniedPaths`
 * is the ONLY read-side credential protection a default install has, and until
 * now it was enforced at exactly one place — our own `getDeniedPathViolation`
 * REQUEST gate. `settings-reference.md#exclude-sensitive-files` states what the
 * SDK's own `permissions.deny` does, verbatim:
 *
 * > "Use it for files that hold API keys, secrets, or environment values:
 * > Claude Code excludes matching files from file discovery and search results,
 * > denies reads of them, and blocks the Edit and Write tools on the matching
 * > paths."
 *
 * We implemented the second and third; the FIRST — *file discovery and search
 * results* — is a RESPONSE-side filter that cannot be built from outside the
 * binary, and that is row P3.105.
 *
 * That page records why sending the list is not redundant: **`Default: unset`**
 * — the SDK denies nothing out of the box, so nothing was reaching it. Only an
 * enterprise managed policy did (`claude-managed-settings.ts`), and only when
 * an administrator wrote one.
 *
 * ## What this DOES NOT buy, measured rather than assumed
 *
 * P3.147 was opened on the reasoning that handing the floor over would close
 * P3.105's results half **for free**, because the sentence above says the SDK
 * already does it. **That was refuted on every binary we vendored from 2.1.223
 * to 2.1.247, and the vendor repaired it at 2.1.251.**
 * `__tests__/claude-denied-path-search-results-e2e.test.ts` measures all four
 * calls in ONE run. On `claude` 2.1.223 (darwin-arm64), with these rules in
 * `settings.permissions.deny`:
 *
 * | Call | Outcome |
 * | --- | --- |
 * | `Read` the denied file | **DENIED** |
 * | `Grep` rooted above it, `output_mode: content` | returns its line, **secret value included** |
 * | `Grep` same, `output_mode: files_with_matches` | **lists it** |
 * | `Glob` rooted the same way | **lists it** |
 *
 * The `Read` denial is the control that makes the three absences findings: same
 * settings object, same run, same path, so "the option was ignored" is excluded.
 * That table reproduced unchanged at 2.1.233 and 2.1.247.
 *
 * **Driven again 2026-09-13 at 2.1.251 (C3.380's lift), every row of it
 * inverted**: `Grep` content, `Grep` files-with-matches and `Glob` no longer
 * name the denied file or its secret, with the same `Read` refusal and the same
 * undenied-file hits as controls. So the clause the page publishes is now
 * PERFORMED by the binary, and this module's mirror does buy the results half on
 * claude after all.
 *
 * **What that does NOT license.** Do not delete the host-side limitation prose
 * or the host search-result filter on the strength of this paragraph: the filter
 * is what makes Pi and codex answer the same way, so retiring it on claude alone
 * is a one-runtime divergence and therefore a switch verdict for the owner, not
 * a consequence of a version bump.
 *
 * ## What it DOES buy, which is why it ships anyway
 *
 * A second enforcement point for reads and edits, inside the binary, that does
 * not share a line of code with our own matcher. That matters more than it
 * sounds: FOUR separate defects in that matcher shipped in a single day —
 * a `<dir>/**` deny that never matched its directory (P3.104), ten entries inert
 * under a Windows home (P3.108), a floor that spoke only Claude's tool
 * vocabulary and was a no-op on Pi (P3.146), and a malformed entry that denied
 * nothing silently. A mirror with an independent implementation does not
 * inherit any of them. It also reaches somewhere we do not: per the same page,
 * *"Read and Edit deny rules apply to Claude's built-in file tools and to file
 * commands Claude Code recognizes in Bash, such as `cat`, `head`, `tail`, and
 * `sed`"*.
 *
 * ## Defence in depth, not a replacement
 *
 * Our gate stays exactly as it is and stays authoritative. Where the two could
 * disagree, ours is the stricter one and it wins, because it runs first and
 * fails the call before the SDK is asked. This module only MIRRORS the floor
 * onto a second enforcement point, and it mirrors a SUBSET on purpose: a
 * pattern that cannot be translated faithfully is dropped from the mirror and
 * reported, never widened and never silently turned into "deny nothing".
 *
 * ## The grammar, from `permissions.md#read-and-edit`
 *
 * Their rules are `Tool(pattern)` strings whose pattern half is
 * [gitignore](https://git-scm.com/docs/gitignore) syntax with FOUR anchor
 * forms, and the anchors do not mean what a filesystem reader assumes:
 *
 * | Form | Meaning (verbatim from the page's table) |
 * | --- | --- |
 * | `//path` | "Absolute path from filesystem root" |
 * | `~/path` | "Path from home directory" |
 * | `/path` | "Path relative to the settings source" |
 * | `path` or `./path` | "Path relative to current directory" |
 *
 * The third is the trap, and the page flags it: *"A pattern like
 * `/Users/alice/file` isn't an absolute path. The single leading slash anchors
 * at the settings source, not the filesystem root. Use `//Users/alice/file` for
 * absolute paths."* An absolute pattern of ours copied across verbatim would
 * therefore anchor somewhere else entirely — which is why {@link ABSOLUTE} is
 * rewritten rather than passed through.
 *
 * Two further facts shape the output:
 *
 * 1. **Both `Read` and `Edit` are emitted for every pattern.** *"Claude Code
 *    checks file permissions against `Edit(path)` and `Read(path)` rules only.
 *    If you write a path rule for `Write`, `NotebookEdit`, `Glob`, or the
 *    legacy `MultiEdit` tool instead, Claude Code accepts the rule but never
 *    consults it, and warns at startup"* — so `Edit(p)` is the spelling that
 *    reaches `Write`/`NotebookEdit`/`MultiEdit`, and `Read(p)` is the spelling
 *    that reaches `Glob`. Our floor governs all of them
 *    (`getDeniedPathViolation`), so both halves have to be written.
 * 2. **A `<dir>/**` deny covers the directory itself on their side.** *"Deny
 *    and ask rules: `Read(secrets/**)` matches a directory named `secrets` at
 *    any depth under the current directory"*. This is the defect P3.104 had to
 *    fix in OUR compiler; theirs does not have it, so no container entry is
 *    synthesized here.
 *
 * ## Our own grammar, from `globToRegex` (`mode-manager.ts`)
 *
 * A pattern is expanded (`~`), then compiled whole-string-anchored with
 * `**` → `.*` (crosses `/`) and `*` → `[^/]*` (one segment). So `**\/.env`
 * matches ANY absolute path ending `/.env`, anywhere on the filesystem — which
 * is `//**\/.env` in their grammar, not `**\/.env` (that one anchors at the
 * current directory).
 *
 * The one place the two dialects differ in OUR favour is `?`: ours compiles to
 * `.` (any character, `/` included), gitignore's excludes `/`. Ours is
 * therefore the broader matcher, the mirror is a subset, and the invariant
 * "ours is the stricter one" holds. No shipped entry uses `?`.
 */

/** One pattern that could not be mirrored, and the reason a reader needs. */
export interface ClaudeDeniedPathRuleRejection {
  readonly pattern: string
  readonly reason: ClaudeDeniedPathRuleRejectionReason
}

/**
 * Why a pattern was left out of the mirror.
 *
 * - `unsafe-in-rule-string` — the pattern carries a character that cannot
 *   survive the `Tool(pattern)` wrapper or that means something different in
 *   gitignore than in ours: `(`/`)` would terminate the rule early, a newline
 *   or NUL would produce a rule nobody can read (and this repo has already
 *   shipped one newline deny-bypass), and a backslash is a gitignore ESCAPE
 *   character while ours is a literal separator.
 * - `unanchored` — a relative pattern such as `secrets/**`. Ours compiles
 *   whole-path-anchored, so it effectively never matches an absolute candidate;
 *   theirs would anchor it at the working directory and, as a deny rule, match
 *   that directory name at ANY depth. Translating it would WIDEN the mirror
 *   past the floor it mirrors, denying files our own gate allows — a
 *   user-visible refusal that would read as a bug. A widening is still a
 *   divergence, so the entry is reported rather than guessed at.
 * - `bare-home` — `~` or `~/**` alone. Denying the whole home directory is not
 *   a credential floor, and no shipped entry has this shape; if one ever
 *   appears it is a policy decision, not a translation.
 */
export type ClaudeDeniedPathRuleRejectionReason =
  | 'unsafe-in-rule-string'
  | 'unanchored'
  | 'bare-home'

/** What {@link mapDeniedPathsToClaudeRules} produced, mirror and residue both. */
export interface ClaudeDeniedPathRuleMapping {
  /**
   * The rule strings, deduplicated and sorted so the settings blob is stable
   * across spawns (an unstable blob would defeat prompt caching and make a
   * diff of two sessions unreadable).
   */
  readonly rules: readonly string[]
  /** Patterns that reached {@link rules}, in input order. */
  readonly mirrored: readonly string[]
  /**
   * Patterns that did NOT. Each one is a path where our own gate is still the
   * only enforcement point — so the RESULTS half (P3.105) stays open for it,
   * which is exactly the fact a reader of a diagnostic needs.
   */
  readonly rejected: readonly ClaudeDeniedPathRuleRejection[]
}

/**
 * Characters that cannot appear in a pattern we wrap in `Tool(...)`.
 *
 * `)` closes the rule; `(` makes it unparseable; `\r`/`\n`/`\0` produce a rule
 * that no log line and no settings reader renders honestly; `\` is a gitignore
 * escape rather than a separator, so a Windows-spelled pattern would silently
 * change meaning. `classifyDeniedPathPattern` already warns about the backslash
 * case on OUR side and deliberately tests the RAW pattern so it does not start
 * warning about our own defaults on Windows — this check is the mirror's own,
 * and it drops rather than warns.
 */
const UNSAFE_IN_RULE_STRING = /[()\r\n\0\\]/

/** A pattern already anchored at the filesystem root in THEIR grammar. */
const ROOT_ANCHORED = '//'

/** A pattern anchored at the filesystem root in OURS: a single leading slash. */
const ABSOLUTE = '/'

/** Home-anchored, and spelled identically in both grammars. */
const HOME_ANCHORED = '~/'

/**
 * Filesystem-wide in ours (`**` crosses `/`, and the compile is whole-string
 * anchored), which is `//**\/…` in theirs.
 */
const ANY_DEPTH = '**/'

/**
 * The tools whose path rules Claude Code actually consults, per
 * `permissions.md#read-and-edit`. Order is fixed so {@link rules} is stable.
 */
const RULE_TOOLS = ['Read', 'Edit'] as const

/**
 * Translate one of our patterns into the pattern half of a Claude rule, or
 * report why it cannot be.
 */
function translatePattern(
  pattern: string,
): { readonly translated: string } | { readonly reason: ClaudeDeniedPathRuleRejectionReason } {
  if (pattern.length === 0) return { reason: 'unanchored' }
  if (UNSAFE_IN_RULE_STRING.test(pattern)) return { reason: 'unsafe-in-rule-string' }

  if (pattern === '~' || pattern === HOME_ANCHORED || pattern === '~/**') {
    return { reason: 'bare-home' }
  }
  if (pattern.startsWith(HOME_ANCHORED)) return { translated: pattern }
  if (pattern.startsWith(ANY_DEPTH)) return { translated: `${ROOT_ANCHORED}${pattern}` }
  if (pattern.startsWith(ROOT_ANCHORED)) return { translated: pattern }
  if (pattern.startsWith(ABSOLUTE)) {
    // A single leading slash anchors at the SETTINGS SOURCE on their side, so
    // an absolute pattern of ours has to gain a second one to keep its meaning.
    return { translated: `${ROOT_ANCHORED}${pattern.slice(ABSOLUTE.length)}` }
  }
  return { reason: 'unanchored' }
}

/**
 * Mirror the `deniedPaths` floor onto the SDK's own `permissions.deny`.
 *
 * Total by construction: every input pattern lands in {@link
 * ClaudeDeniedPathRuleMapping.mirrored} or {@link
 * ClaudeDeniedPathRuleMapping.rejected}, so a caller can always say which
 * entries reached the native surface and which are still ours alone.
 */
export function mapDeniedPathsToClaudeRules(
  deniedPaths: readonly string[] | undefined,
): ClaudeDeniedPathRuleMapping {
  const rules = new Set<string>()
  const mirrored: string[] = []
  const rejected: ClaudeDeniedPathRuleRejection[] = []

  for (const pattern of deniedPaths ?? []) {
    const outcome = translatePattern(pattern)
    if ('reason' in outcome) {
      rejected.push({ pattern, reason: outcome.reason })
      continue
    }
    mirrored.push(pattern)
    for (const tool of RULE_TOOLS) rules.add(`${tool}(${outcome.translated})`)
  }

  return { rules: [...rules].sort(), mirrored, rejected }
}

/**
 * The `settings` option carrying the mirror, or `{}` when there is nothing to
 * mirror.
 *
 * `settings` — not `managedSettings` — is deliberate, and the SDK's own typings
 * say why. `managedSettings` is "dropped by default" when an IT-controlled
 * managed-settings tier exists on the user's machine, layering in only if that
 * administrator opts in via `parentSettingsBehavior: 'merge'`; a credential
 * floor that disappears on exactly the managed machines an administrator
 * hardened is the wrong failure direction. `settings` is the "flag settings"
 * layer, "which has the highest priority among user-controlled settings", and
 * it applies unconditionally. The enterprise policy keeps its own channel
 * (`claude-managed-settings.ts` → `managedSettings`); the two are unioned by
 * the SDK, and deny outranks allow in every layer.
 *
 * Returned as a spreadable partial so an install with nothing to mirror spawns
 * byte-identically to before.
 */
export function buildClaudeDeniedPathSettingsOptions(
  mapping: ClaudeDeniedPathRuleMapping,
): { settings?: { permissions: { deny: string[] } } } {
  if (mapping.rules.length === 0) return {}
  return { settings: { permissions: { deny: [...mapping.rules] } } }
}

/**
 * Human-readable lines for the debug channel: what reached the SDK, and — the
 * load-bearing half — what did not.
 *
 * A dropped pattern is not cosmetic. It means the SDK will not exclude that
 * path from file discovery and search results, so P3.105's RESULTS gap stays
 * open for it while our REQUEST gate still closes the read. Saying so is the
 * difference between a known subset and a silent one.
 */
export function formatClaudeDeniedPathDiagnostics(
  mapping: ClaudeDeniedPathRuleMapping,
): string[] {
  const lines: string[] = []
  if (mapping.rules.length > 0) {
    lines.push(
      `[ClaudeAgent] credential floor mirrored to permissions.deny: `
      + `${mapping.mirrored.length} pattern(s) → ${mapping.rules.length} rule(s)`,
    )
  }
  for (const { pattern, reason } of mapping.rejected) {
    lines.push(
      `[ClaudeAgent] deniedPaths entry ${JSON.stringify(pattern)} was NOT mirrored to the SDK `
      + `(${reason}); our own gate still denies it, but the SDK will not exclude it from `
      + `file discovery or search results.`,
    )
  }
  return lines
}
