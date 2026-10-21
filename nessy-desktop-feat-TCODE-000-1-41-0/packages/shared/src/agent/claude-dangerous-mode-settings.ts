import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parsePermissionJsonc } from './pi-harness/permission-dsl.ts'

/**
 * P6.495 — the vendor key that says "the user has already accepted the bypass
 * dialog", refused by name when a repository ships it.
 *
 * ## The key, and what it really is
 *
 * `skipDangerousModePermissionPrompt` is a real settings key in the vendored
 * bundle. Its own `describe` says what it means, verbatim: *"Whether the user
 * has accepted the bypass permissions mode dialog"*. The reader is a single
 * predicate, and it is an OR over four tiers:
 *
 * ```js
 * return !!(dn("userSettings")?.skipDangerousModePermissionPrompt
 *   || dn("localSettings")?.skipDangerousModePermissionPrompt
 *   || dn("flagSettings")?.skipDangerousModePermissionPrompt
 *   || dn("policySettings")?.skipDangerousModePermissionPrompt)
 * ```
 *
 * That block was read at `2.1.233`. **Re-read at the vendored `2.1.247`
 * (C3.252, 2026-09-12) and unchanged in substance** — only the minified names
 * moved: the accessor `dn` → `h`, and the predicate carries the minified name
 * `Fs` in that bundle. It is still an OR over the same four tiers in the same
 * order. Locate it by the body above, never by either name — both are the
 * minifier's and the next lift reassigns them.
 *
 * ## Two corrections to the row that asked for this, both measured at HEAD
 *
 * 1. **`projectSettings` is NOT in that list.** The row's headline says the key
 *    is "reachable from project settings"; the shipped 2.1.247 binary reads
 *    `user`, `local`, `flag` and `policy` and never the project tier. So a
 *    repository's own `.claude/settings.json` cannot reach it, and the tier that
 *    can is `.claude/settings.local.json` — a per-repository file all the same,
 *    which is why both scopes are read here and each is named as what it is.
 * 2. **The auto-mode twin is NOT absent.** The row records
 *    `skipAutoPermissionPrompt` as scoring 0 against the bundle. Re-measured on
 *    the vendored `2.1.247` native binary (2026-09-12), **with the instrument
 *    named on both sides because the two answer differently on a minified
 *    artefact** (AGENTS.md §Traps, C3.294): `grep -acF` (LINES) → **5**,
 *    `grep -aoF … | wc -l` (OCCURRENCES) → **6**; positive controls on the same
 *    file `Cookie` 41/72 and `git-subdir` 8/30, negative control
 *    `nessyNotARealSdkKey` 0/0. (The superseded reading was "5 at 2.1.233 with
 *    `Cookie` 82 and `git-subdir` 37" — its instrument was not named, and the
 *    clause explaining the controls by the bundle having GROWN is false of this
 *    bundle: 2.1.247 is 233 MB where 2.1.233 was 307 MB.) It is deliberately
 *    NOT handled here: its own reader, re-read at `2.1.247`, is
 *    `!["policySettings","userSettings","flagSettings"].some((o)=>i(o)?.skipAutoPermissionPrompt===!0)`,
 *    which contains neither `localSettings` nor `projectSettings`, so no
 *    repository file reaches it at all.
 *
 * ## What blocks it is OURS, and it was already blocking
 *
 * The dangerous-mode confirmation a user of this product meets is not the
 * vendor's dialog. It is the host's, gated on `bypassPermissionsAcknowledged` in
 * `config.json` (`config/storage.ts`), which is a wholly separate file from
 * `.claude/settings.json`, is not writable by any model-invocable surface, and
 * is identical on Pi, claude and codex. No value of this key in any `.claude`
 * file changes it. That is the block; it is the host seam, and it needed no new
 * code.
 *
 * The vendor key cannot additionally be FILTERED out of the child, and that null
 * is recorded rather than papered over: for a trusted project the tiers load whole
 * through `settingSources` (F1.768 drops `local` otherwise), the reader is an OR so a
 * managed `false` cannot cancel a local `true`, and the only lever that would
 * remove it is dropping the `local` source entirely — which would also drop the
 * user's own permission rules, memory excludes and skill overrides. Searched:
 * the SDK `Options` surface (`sdk.d.ts`), the restrictive managed filter read
 * out of the binary in `claude-managed-settings.ts`, and `cli-reference.md`.
 * There is no per-key tier filter.
 *
 * ## So this module is the DISCLOSURE, and that is the whole of it
 *
 * Q-den 4 chose option B — refuse the key by name — over A (implement the
 * suppression host-side on all three, refused because it would ship a supported
 * way to remove a safety confirmation from a repository) and over C
 * (managed-scope admission, admissible only on a written operator case, and none
 * is written). Refusing by name, when the thing it would suppress is already not
 * suppressible, is exactly one line addressed to whoever set it — because a
 * refusal nobody can see is indistinguishable from a defect.
 */
export const CLAUDE_DANGEROUS_MODE_ACK_SETTING_KEY = 'skipDangerousModePermissionPrompt'

/** The two per-repository scopes, and the file each one is. */
export const CLAUDE_DANGEROUS_MODE_SETTINGS_FILES = {
  /** Repository-owned, shipped to whoever clones it. The child does NOT read it. */
  project: join('.claude', 'settings.json'),
  /** The user's own file in the repository. The child DOES read it. */
  local: join('.claude', 'settings.local.json'),
} as const

export type ClaudeDangerousModeScope = keyof typeof CLAUDE_DANGEROUS_MODE_SETTINGS_FILES

/** A settings file this size is not a settings file; skip it. */
const MAX_SETTINGS_FILE_BYTES = 1024 * 1024

/**
 * The scopes whose `.claude` settings file carries the key with a truthy value,
 * in `project`, `local` order.
 *
 * Every failure — missing, oversized, unparseable, not an object — is a SKIP,
 * the same outcome as a file that does not carry the key, and for the same
 * reason `readClaudeProjectSettingsKeys` gives: this file is co-owned with real
 * Claude Code, and a document we cannot parse must never take a session down.
 * A falsy value is not a suppression and is not reported.
 */
export function readClaudeDangerousModeAckScopes(
  workingDirectory: string | undefined,
): ClaudeDangerousModeScope[] {
  if (!workingDirectory) return []
  const found: ClaudeDangerousModeScope[] = []
  for (const scope of ['project', 'local'] as const) {
    const path = join(workingDirectory, CLAUDE_DANGEROUS_MODE_SETTINGS_FILES[scope])
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
      if (parsed[CLAUDE_DANGEROUS_MODE_ACK_SETTING_KEY] === true) found.push(scope)
    } catch {
      continue
    }
  }
  return found
}

/**
 * The refusal line, or `[]` when no scope carries the key.
 *
 * One line, naming the key and every scope it was found in, and never the file's
 * other contents. The two scopes carry different facts and the sentence says
 * which is which, because telling an operator that a key was refused where it
 * was never read would be a second untruth in place of the first.
 */
export function formatClaudeDangerousModeAckRefusal(
  scopes: readonly ClaudeDangerousModeScope[],
): string[] {
  if (scopes.length === 0) return []
  const files = scopes.map(scope => CLAUDE_DANGEROUS_MODE_SETTINGS_FILES[scope]).join(' and ')
  const reachability = scopes.includes('local')
    ? 'The Claude child does read the local file for it, so without this refusal it would treat '
      + 'the bypass dialog as already accepted.'
    : 'The Claude child does not read the project file for it, so it was already inert there.'
  return [
    `claude-dangerous-mode-ack-refused: ${files} sets \`${CLAUDE_DANGEROUS_MODE_ACK_SETTING_KEY}\`, `
    + 'which this product does not honour from a repository on any runtime. The confirmation before '
    + 'a session may run in bypass mode is the host\'s own, recorded once per install in config.json, '
    + `and no \`.claude\` settings file can remove it. ${reachability} `
    + 'If an operator needs this, it is a managed-policy decision and not a file in a checkout.',
  ]
}
