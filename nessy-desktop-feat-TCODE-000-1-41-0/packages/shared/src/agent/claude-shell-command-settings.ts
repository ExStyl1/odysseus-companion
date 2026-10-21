import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parsePermissionJsonc } from './pi-harness/permission-dsl.ts'

/**
 * P6.254 — the `.claude` settings keys whose VALUE is a shell command, and the
 * one line this product owes an operator who sets one.
 *
 * ## What was wrong
 *
 * `apiKeyHelper` is a real Claude settings key at authentication precedence
 * tier 4, and the vendored SDK reads it. It can never be consulted from a Nessy
 * session, because every claude child is spawned with tier-3
 * `ANTHROPIC_API_KEY` written unconditionally, and tier 3 outranks tier 4. An
 * operator who put a helper in `~/.claude/settings.json` therefore got a
 * credential rotation that silently never ran, on a product that never said so.
 *
 * ## The mechanism stays refused; this is the honesty half only
 *
 * Owner ruling of 2026-08-08 (R50 `managed-policy-sources`, verbatim: "Not
 * deferred — out of scope for this product"), extended to these two keys in
 * `config/managed-env.ts`: "this product does not accept an admin-supplied
 * executable as a settings source … the two helper keys here differ from
 * `policyHelper` only in what the executable's output is used for … it is not
 * built, not deferred, and not a gap." The pages' own class name for them is
 * `server-managed-settings.md#security-approval-dialogs`: "settings that execute
 * shell commands, such as `apiKeyHelper`, `statusLine`, and `otelHeadersHelper`".
 *
 * Re-anchored P6.661 — the class name moved PAGE, not just section. It used to
 * be cited against `settings-reference.md`, section "settings that require
 * approval", which is no section of that page (301 of them) and does not exist
 * on it at all. The sentence is verbatim-unchanged on
 * `server-managed-settings.md`, one more instance of the `settings.md` split
 * AGENTS.md records.
 *
 * The old anchor is spelled APART on purpose: `check-doc-anchors.ts` scans every
 * tracked file, so writing a dead citation the way one is normally written — page
 * slug, dot-m-d, hash, section slug, one unbroken token — would RE-CREATE here the
 * finding this sentence reports as closed. The known-failing register (§P2.376a)
 * records that trap springing on its own prose, and a PLACEHOLDER in that shape is
 * the second way it springs: the guard reads the placeholder's stand-in word as a
 * page name and reports a page it cannot find. Measured on this very comment.
 *
 * ## F1.1064 — the Claude runtime runs `apiKeyHelper` itself (refuted: "unreachable")
 *
 * "What was wrong" above said the helper can never be consulted from a Nessy
 * session. Measured (DN-259, 2026-09-28, vendored 2.1.267, a trusted project's
 * `.claude/settings.json`, a loopback stub recording headers by label): the child
 * RAN the helper on every arm; on an OAuth-shaped connection its output replaced
 * the connection's sign-in (`apiKeySource: 'apiKeyHelper'`), and beside an API
 * key it rode as a bearer token. Under the owner decision of 2026-09-28 a trusted
 * project's own settings choose the credential as the runtime allows, so the line
 * below no longer claims Claude ignores it; the Claude session names the file
 * itself (`claude-endpoint-settings.ts`, `claude-settings-file-credential-in-use`).
 * Pi and codex still apply neither key. `otelHeadersHelper` on Claude is unmeasured.
 *
 * ## Why the two credential helpers and not `statusLine`
 *
 * Both keys here mint a SECRET on demand, so the failure they produce is a
 * credential that silently does not rotate — invisible until an expiry.
 * `statusLine` is the same class of setting and a different consequence (a
 * cosmetic line that does not render), and it has its own row; naming it in the
 * same sentence would blur a security fact into a display one.
 *
 * ## The bound, and what is never printed
 *
 * At most one line, and only when a key is actually present — a diagnostic that
 * always prints is one nobody reads. The line names the KEY and the ruling and
 * NEVER the value: the value is a command line, and a command line an
 * administrator wrote may itself carry a secret.
 */
export const CLAUDE_SHELL_COMMAND_CREDENTIAL_SETTING_KEYS: readonly string[] = Object.freeze([
  'apiKeyHelper',
  'otelHeadersHelper',
])

/**
 * The top-level keys a project's own `.claude` settings files declare.
 *
 * The two filenames and the 1 MiB ceiling are the ones `cross-session-inbound.ts`
 * already applies to the same pair: a settings file that size is not a settings
 * file. Every failure — missing, oversized, unparseable, not an object — is a
 * SKIP, which is the same outcome as a file with no keys, and correct: an
 * unparseable settings file is not honoured by any family's reader either.
 */
export function readClaudeProjectSettingsKeys(workingDirectory: string): string[] {
  return readSettingsKeysFrom(
    ['settings.json', 'settings.local.json'].map(name => join(workingDirectory, '.claude', name)),
  )
}

/**
 * C3.49 — the USER scope, which is the one the paragraph above is ACTUALLY
 * about and the one this reader did not read.
 *
 * `settings.md#compare-the-scope-of-each-settings-file` gives the path
 * verbatim: user settings are `~/.claude/settings.json`, "You, in every project
 * on this machine". `settings.md#find-or-create-your-settings-files` gives the
 * one relocation: "To keep the home-directory files somewhere else, set
 * `CLAUDE_CONFIG_DIR`; Claude Code then stores your settings, session history,
 * and plugins there instead" — so the variable REPLACES `~/.claude`, it does not
 * nest under it. This product never sets `CLAUDE_CONFIG_DIR` for a claude child
 * (0 non-test occurrences under `packages/shared/src/agent` and
 * `packages/server-core/src`, positive control `'.claude'` on the same corpus),
 * so the file the SDK reads is whichever of the two an operator has, and both
 * are checked here.
 *
 * There is no `settings.local.json` in this scope: the page's table lists the
 * local file only under the project row, and inventing a second user filename
 * would be a reader of a file no runtime writes.
 *
 * The owner's 2026-09-11 answer to QC3 is option A — the R50 refusal of an
 * admin-supplied executable as a settings source stands, extended to EVERY
 * scope, so the diagnostic stops distinguishing scopes it never had a reason to
 * distinguish. Scope is still NAMED in the line, because "which file do I edit"
 * is the operator's next question.
 */
export function readClaudeUserSettingsKeys(
  options: { home?: string; configDir?: string } = {},
): string[] {
  // An explicit `home` outranks the ambient `CLAUDE_CONFIG_DIR` on purpose: only
  // a test passes one, and the alternative is a case whose verdict depends on
  // the developer's own environment. In production neither override is given and
  // the order is the documented one, the variable ahead of the home directory.
  const configDir = options.configDir
    ?? (options.home === undefined ? undefined : join(options.home, '.claude'))
    ?? process.env.CLAUDE_CONFIG_DIR
    ?? join(homedir(), '.claude')
  return readSettingsKeysFrom([join(configDir, 'settings.json')])
}

/** The shared file loop: every failure is a SKIP, for the reason above. */
function readSettingsKeysFrom(paths: readonly string[]): string[] {
  const keys = new Set<string>()
  for (const path of paths) {
    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch {
      continue
    }
    if (raw.length > 1024 * 1024) continue
    try {
      const parsed = parsePermissionJsonc(raw) as Record<string, unknown> | null
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      for (const key of Object.keys(parsed)) keys.add(key)
    } catch {
      continue
    }
  }
  return [...keys]
}

/**
 * The keys each scope declares. An ARRAY is still accepted and still means the
 * project scope, so the two call sites and the P6.254 cases that predate C3.49
 * read exactly as they did.
 */
export interface ClaudeShellCommandSettingScopeKeysV1 {
  /** `<workingDirectory>/.claude/settings.json` + `settings.local.json`. */
  readonly project?: readonly string[]
  /** `~/.claude/settings.json`, or `CLAUDE_CONFIG_DIR`'s `settings.json`. */
  readonly user?: readonly string[]
}

/** How each scope is named to the operator — the file they would edit. */
const SCOPE_LABELS: Readonly<Record<keyof ClaudeShellCommandSettingScopeKeysV1, string>> = {
  project: "this project's .claude settings",
  user: 'your user ~/.claude/settings.json',
}

/**
 * The refusal line, or `[]` when the session's settings carry none of these
 * keys in any scope.
 *
 * Pure and runtime-agnostic on purpose: the fact is product-wide — no runtime we
 * drive consults a settings-supplied executable — so the same sentence is
 * correct on Pi, on claude and on codex, and a per-runtime rewording would be
 * three chances to describe one decision differently. Purity is also what keeps
 * the silent case testable: a formatter that read `~/.claude/settings.json`
 * itself would make the "no key set" case depend on the developer's own home
 * directory.
 *
 * Still ONE line however many scopes are involved, for the reason the bound
 * above gives, and it still names the key and the ruling and NEVER the value.
 */
export function formatClaudeShellCommandSettingRefusal(
  settingsKeys: readonly string[] | ClaudeShellCommandSettingScopeKeysV1 | undefined,
): string[] {
  const scopes: ClaudeShellCommandSettingScopeKeysV1 = Array.isArray(settingsKeys)
    ? { project: settingsKeys }
    : (settingsKeys as ClaudeShellCommandSettingScopeKeysV1 | undefined) ?? {}
  const named: string[] = []
  for (const key of CLAUDE_SHELL_COMMAND_CREDENTIAL_SETTING_KEYS) {
    const where = (Object.keys(SCOPE_LABELS) as (keyof ClaudeShellCommandSettingScopeKeysV1)[])
      .filter(scope => (scopes[scope] ?? []).includes(key))
      .map(scope => SCOPE_LABELS[scope])
    if (where.length > 0) named.push(`${key} (in ${where.join(' and ')})`)
  }
  if (named.length === 0) return []
  return [
    `claude-shell-command-setting-refused: this session's Claude settings carry `
    + `${named.join(' and ')}, which the Pi and codex runtimes do not apply, in any scope. A settings `
    + 'key whose value is a shell command is refused there by the owner decision of 2026-08-08 (R50, '
    + 'the same one that dropped `policyHelper`): an admin-supplied executable is not accepted as a '
    + 'settings source. On the Claude runtime Claude Code itself runs an `apiKeyHelper` from a '
    + 'settings file it loads, by its own authentication precedence, and that session names the file '
    + '(F1.1064). Supply the credential through a connection instead.',
  ]
}
