import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parsePermissionJsonc } from './pi-harness/permission-dsl.ts'

/**
 * C3.18 — the two `permissions.defaultMode` values a REPOSITORY may not set,
 * refused by scope on every runtime, ahead of the vendor's own 2.1.257 change.
 *
 * ## The contract, verbatim
 *
 * `settings-reference.md#permissions-defaultmode` (anchor verified on the
 * rendered page 2026-09-12, with `#permissions-disablebypasspermissionsmode` as
 * the positive control and a fabricated anchor at 0 as the negative one):
 *
 *   "**Scope**: `Any file`. `auto` and `bypassPermissions` don't take effect
 *   from project or local settings, so set them in `~/.claude/settings.json`
 *   instead. Before v2.1.257, `bypassPermissions` took effect from any file."
 *
 * So the restriction is on the SCOPE, not on the key: the same two values set
 * in the user's own file are honoured, and that asymmetry is the whole of this
 * module. It is also the control the measurement rig could not do without — a
 * refusal that fired in every scope would be indistinguishable from a dead
 * reader, which is exactly what the host has (see below).
 *
 * ## Why this belongs in the HOST and not in the claude arm
 *
 * The direction of the error is WIDENING and the predicate is one sentence, so
 * one copy states it for all three runtimes rather than three copies drifting.
 * Measured at HEAD, 2026-09-12, `git grep -an defaultMode` over `packages` and
 * `apps` with `defaultModel`/`defaultModeId` excluded and test files dropped:
 *
 * - **Pi and codex** — the host has NO reader for `permissions.defaultMode`
 *   from a `.claude` settings file in any scope. Every non-test occurrence of
 *   the name is either `managedPiPolicy.defaultMode` (our own administrator
 *   key, delivered as `ManagedPiPolicyV1` and never read out of a checkout) or
 *   an unrelated `ThemeContext` prop. `pi-agent.ts`'s `applyPermissionRequestUpdates`
 *   already says so in a refusal string it hands a hook: *"permissions.defaultMode
 *   has no reader, so the write would change nothing."*
 * - **Claude** — the child DOES read those files for a trusted project: the spawn
 *   passes `settingSources` with `project`/`local` there (F1.768), and the vendored bundle
 *   self-reports `2.1.247` on both of its own reports (the SDK package's
 *   `claudeCodeVersion` and `claude --version`), which is BEHIND the 2.1.257
 *   the sentence above dates the rule to. What keeps the file inert all the
 *   same is the host's own starting mode: `buildClaudePermissionModeOptions`
 *   puts a non-optional `permissionMode` in `Options` on every spawn, and the
 *   same page names that as the override — *"**Per-session overrides**:
 *   `--permission-mode`, and its equivalent `--dangerously-skip-permissions`
 *   for `bypassPermissions`, take precedence over this key for one session."*
 *
 * The managed tier cannot carry the refusal and that null is recorded rather
 * than papered over: the SDK's restrictive managed-settings filter, read out of
 * the shipped binary in `claude-managed-settings.ts`, copies `permissions`
 * narrowed to `pick(['deny','ask'])`, so `defaultMode` sent through
 * `Options.managedSettings` would look like enforcement and do nothing — the
 * same measurement that made `claudePowerShellToolDenyFloor` a deny rule rather
 * than the vendor's own key.
 *
 * ## So this module is the refusal plus its DISCLOSURE, and that is the whole
 *
 * Nothing here changes a permission decision, because on all three runtimes the
 * value was already not honoured. What it changes is that a repository author
 * or an operator can now SEE the refusal and its scope, which is the owner's
 * "transparent and simple" rule: an undocumented choice nobody can see is
 * indistinguishable from a defect. The sentence names the file, the value, the
 * scope and the place the value WOULD be honoured, because "which file do I
 * edit" is the operator's next question — the shape
 * `claude-dangerous-mode-settings.ts` settled for the neighbouring key.
 */
export const CLAUDE_DEFAULT_MODE_SETTING_PATH = 'permissions.defaultMode'

/**
 * The two values the page names, and only those two.
 *
 * `plan`, `default`, `acceptEdits`, `dontAsk` and the `manual` alias are NOT
 * here and must not be added: they narrow or hold the posture, the sentence
 * restricts exactly two names, and a refusal wider than the contract would
 * break a repository that legitimately starts its sessions in `plan`.
 */
export const CLAUDE_WIDENING_DEFAULT_MODES: readonly string[] = Object.freeze([
  'auto',
  'bypassPermissions',
])

/** The three scopes the page's own table gives, and the file each one is. */
export const CLAUDE_DEFAULT_MODE_SETTINGS_FILES = {
  /** Repository-owned, shipped to whoever clones it. */
  project: join('.claude', 'settings.json'),
  /** The user's own file INSIDE the repository — still a file in a checkout. */
  local: join('.claude', 'settings.local.json'),
  /** `~/.claude/settings.json`. The scope the page sends these two values to. */
  user: join('~', '.claude', 'settings.json'),
} as const

export type ClaudeDefaultModeScope = keyof typeof CLAUDE_DEFAULT_MODE_SETTINGS_FILES

/** The two per-repository scopes, in the order the page's scope table gives. */
export const CLAUDE_REPOSITORY_DEFAULT_MODE_SCOPES: readonly ClaudeDefaultModeScope[] =
  Object.freeze(['project', 'local'])

/**
 * The predicate, and the ONE place the rule is written down.
 *
 * `true` means the scope may set this value; `false` means the value is refused
 * BECAUSE OF WHERE IT IS SET. A value that is not one of the two widening names
 * is never refused here — this is a scope restriction, not a value allowlist,
 * and an unknown string is the vendor's problem to reject, not ours to guess at.
 */
export function claudeDefaultModeTakesEffect(
  value: unknown,
  scope: ClaudeDefaultModeScope,
): boolean {
  if (typeof value !== 'string') return true
  if (scope === 'user') return true
  return !CLAUDE_WIDENING_DEFAULT_MODES.includes(value.trim())
}

/** One repository scope that set a widening value, and the value it set. */
export interface ClaudeWideningDefaultModeV1 {
  readonly scope: ClaudeDefaultModeScope
  readonly value: string
}

/** A settings file this size is not a settings file; skip it. */
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024

/**
 * The repository scopes whose `.claude` settings file sets a widening
 * `permissions.defaultMode`, in `project`, `local` order.
 *
 * Every failure — missing, oversized, unparseable, not an object, no
 * `permissions` block, a non-string value — is a SKIP, the same outcome as a
 * file that does not carry the key, and for the reason
 * `readClaudeProjectSettingsKeys` gives: these files are co-owned with real
 * Claude Code, and a document we cannot parse must never take a session down.
 *
 * The USER scope is deliberately not read. It is the scope the page sends these
 * values TO, so there is nothing to report about it, and reading a developer's
 * home directory to say nothing would make the silent case depend on whose
 * machine the test runs on.
 */
export function readClaudeWideningDefaultModeScopes(
  workingDirectory: string | undefined,
): ClaudeWideningDefaultModeV1[] {
  if (!workingDirectory) return []
  const found: ClaudeWideningDefaultModeV1[] = []
  for (const scope of CLAUDE_REPOSITORY_DEFAULT_MODE_SCOPES) {
    const path = join(workingDirectory, CLAUDE_DEFAULT_MODE_SETTINGS_FILES[scope])
    let raw: string
    try {
      raw = readFileSync(path, 'utf-8')
    } catch {
      continue
    }
    if (raw.length > MAX_SETTINGS_FILE_BYTES) continue
    try {
      const parsed = parsePermissionJsonc(raw) as Record<string, unknown> | null
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const permissions = parsed.permissions as Record<string, unknown> | undefined
      if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) continue
      const value = permissions.defaultMode
      if (typeof value !== 'string') continue
      const trimmed = value.trim()
      if (claudeDefaultModeTakesEffect(trimmed, scope)) continue
      found.push({ scope, value: trimmed })
    } catch {
      continue
    }
  }
  return found
}

/**
 * The refusal line, or `[]` when no repository scope set a widening value.
 *
 * ONE line however many scopes are involved, naming the file, the value and the
 * scope that would honour it — and never the file's other contents. English and
 * unlocalised like every other runtime notice on this seam, because it names
 * machine identifiers a translation would carry verbatim anyway.
 */
export function formatClaudeWideningDefaultModeRefusal(
  found: readonly ClaudeWideningDefaultModeV1[],
): string[] {
  if (found.length === 0) return []
  const named = found
    .map(entry => `${CLAUDE_DEFAULT_MODE_SETTINGS_FILES[entry.scope]} sets \`${entry.value}\``)
    .join(' and ')
  return [
    `claude-default-mode-scope-refused: ${named} for \`${CLAUDE_DEFAULT_MODE_SETTING_PATH}\`, `
    + 'which this product does not honour from a file in a checkout on any runtime. '
    + '`settings-reference.md#permissions-defaultmode`: "`auto` and `bypassPermissions` don\'t take '
    + 'effect from project or local settings, so set them in `~/.claude/settings.json` instead." '
    + 'The same two values in your own user file are still honoured — this is a restriction on the '
    + 'SCOPE, not on the mode. The session starts in the mode this host resolved instead.',
  ]
}
