/**
 * The project-tier settings file D1.75 needs, written where the PRODUCT says
 * that tier lives — and it is not where the row assumes.
 *
 * ## Why this is a fixture and not part of the case
 *
 * `scripts/cdp/README.md`'s rule: a CASE never writes configuration, a FIXTURE
 * may, in one reviewable place, against a config dir it owns. This writes one
 * file under `NESSY_CONFIG_DIR` and hands back the exact previous bytes —
 * including "absent", which is a different state from "present and empty".
 *
 * ## Where the project tier actually is, measured 2026-09-18 (SIT-6a)
 *
 * The row's rig says *"an untrusted workspace whose settings carry all four
 * keys"*, and the obvious reading of that is a `.claude/settings.json` in the
 * directory the session is working in. Measured, the product's own
 * `getSettingsProvenance` names four families and, for each, the exact files it
 * consults — and its `project` scope is rooted at
 *
 *     <config>/workspaces/<workspaceId>/.claude/settings.json
 *     <config>/workspaces/<workspaceId>/.nessy-agent/permissions.json   (permissions only)
 *     <config>/workspaces/<workspaceId>/.claude/settings.local.json     (scope `local`)
 *
 * NOT the session's working directory. A file written into the working
 * directory is reported nowhere in that report, so a case that writes there
 * measures a file nothing reads and records the resulting silence as a trust
 * gate. That is the confound this fixture exists to remove; the working
 * directory is still what the TRUST DIALOG asks about, which is exactly why the
 * two have to be separated before the row can be answered.
 *
 * ## What it writes
 *
 * All four keys D1.75 names — `permissions.allow`, `permissions.deny`,
 * `permissions.ask`, `permissions.additionalDirectories`, `env`,
 * `extraKnownMarketplaces` — each carrying the caller's token, so a hit on any
 * surface can only have come from this file.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The `project`-scope settings file, as the product's own provenance report names it. */
export function projectTierSettingsFile(configDir: string, workspaceId: string): string {
  return join(configDir, 'workspaces', workspaceId, '.claude', 'settings.json')
}

export interface TrustSettingsSeed {
  /** The file that was written. */
  file: string
  /** The exact previous bytes, or `undefined` when the file did not exist. */
  previous: string | undefined
  /** The token every key carries. */
  token: string
  /** The directory granted through `permissions.additionalDirectories`. */
  grantedDirectory: string
  bytes: number
}

/**
 * Write the four keys plus one deny and one ask rule into the project tier.
 *
 * `grantedDirectory` is the caller's, so the case can assert on a path it minted
 * rather than on one this fixture invented.
 */
export function seedTrustSettings(
  configDir: string,
  workspaceId: string,
  token: string,
  grantedDirectory: string,
): TrustSettingsSeed {
  const file = projectTierSettingsFile(configDir, workspaceId)
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : undefined
  const body = {
    permissions: {
      allow: [`Bash(echo ${token}:*)`],
      deny: [`Bash(curl ${token}:*)`],
      ask: [`Bash(git ${token}:*)`],
      additionalDirectories: [grantedDirectory],
    },
    env: { RS87_TOKEN: token },
    extraKnownMarketplaces: {
      [`rs87-${token}`]: { source: { source: `https://example.invalid/${token}/marketplace.json` } },
    },
  }
  const text = `${JSON.stringify(body, null, 2)}\n`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
  return { file, previous, token, grantedDirectory, bytes: text.length }
}

/** Put back exactly what was there — including nothing. */
export function restoreTrustSettings(seed: TrustSettingsSeed): { restored: 'bytes' | 'removed' } {
  if (seed.previous === undefined) {
    rmSync(seed.file, { force: true })
    return { restored: 'removed' }
  }
  writeFileSync(seed.file, seed.previous, 'utf8')
  return { restored: 'bytes' }
}

if (import.meta.main) {
  const [configDir, workspaceId, token, granted] = process.argv.slice(2)
  if (!configDir || !workspaceId) {
    console.error('usage: bun run scripts/cdp/fixtures/workspace-trust-settings.ts <configDir> <workspaceId> [token] [grantedDir]')
    process.exit(2)
  }
  const seed = seedTrustSettings(
    configDir,
    workspaceId,
    token ?? `rs87${Math.random().toString(16).slice(2, 10)}`,
    granted ?? join(configDir, 'rs87-granted'),
  )
  console.log(JSON.stringify(seed, null, 2))
}
