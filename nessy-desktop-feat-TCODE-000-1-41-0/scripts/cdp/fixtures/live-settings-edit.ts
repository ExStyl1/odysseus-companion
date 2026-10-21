/**
 * Edit a settings file in a config dir this fixture owns, WHILE a session is
 * open, for `RS-83` (plan row `D1.76`, half (a)).
 *
 * ## Why this is a FIXTURE
 *
 * `scripts/cdp/README.md`: a CASE never writes configuration; a FIXTURE may,
 * *"in one reviewable place, against a scratch config dir"*. The row's subject
 * is precisely a settings file edited by hand with a session live, so the write
 * has to happen mid-run — and this is the one reviewable place it happens.
 *
 * ## What it writes, and what it refuses
 *
 * It MERGES one documented key into `<configDir>/config.json`, preserving every
 * other key byte-for-byte through a parse/merge/serialise round trip, and it
 * hands back the exact previous value so the caller can put it back. It refuses
 * a config dir that is not the one the app under test was launched with, and it
 * refuses to run against `~/.nessy-agent`: a settings edit in an operator's live
 * profile is the one thing the README's rule is unambiguously about.
 *
 * The key is `instructionExcludes`, chosen because the product's own
 * settings-provenance surface publishes it as a FAMILY with a `union` combine
 * rule and reports the file's state (`present-no-keys` when the file exists and
 * carries none of the family's keys). That gives the case a state that MOVES on
 * a correct write and a name the product already knows, rather than an invented
 * key a validator would reject — `StoredConfigKnownFields` is the envelope a
 * key has to be in, and a key outside it is how a config file gets wiped.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** The family key the settings-provenance surface publishes with `combine: 'union'`. */
export const LIVE_EDIT_KEY = 'instructionExcludes'

export interface LiveSettingsEdit {
  file: string
  /** The value the file carried before, so the caller can restore exactly it. */
  previous: unknown
  wrote: unknown
  bytesBefore: number
  bytesAfter: number
  /** Every top-level key, before and after — the round trip's own control. */
  keysBefore: string[]
  keysAfter: string[]
}

function guard(configDir: string): string {
  const dir = resolve(configDir)
  if (dir === resolve(join(homedir(), '.nessy-agent')) || dir.startsWith(`${resolve(homedir())}/.nessy-agent`)) {
    throw new Error(
      `refusing-to-edit: ${dir} is the operator's own profile. This fixture edits a settings file in a config dir `
      + 'created for a run, never a live one.',
    )
  }
  return dir
}

/** Merge one key into `<configDir>/config.json`; returns what was there before. */
export function writeLiveSetting(configDir: string, value: unknown, key = LIVE_EDIT_KEY): LiveSettingsEdit {
  const file = join(guard(configDir), 'config.json')
  const before = readFileSync(file, 'utf8')
  const parsed = JSON.parse(before) as Record<string, unknown>
  const previous = key in parsed ? parsed[key] : undefined
  const next = value === undefined ? { ...parsed } : { ...parsed, [key]: value }
  if (value === undefined) delete next[key]
  const text = `${JSON.stringify(next, null, 2)}\n`
  writeFileSync(file, text, 'utf8')
  return {
    file,
    previous,
    wrote: value,
    bytesBefore: before.length,
    bytesAfter: text.length,
    keysBefore: Object.keys(parsed).sort(),
    keysAfter: Object.keys(next).sort(),
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const configDir = args[args.indexOf('--config-dir') + 1]
  if (!configDir || args.indexOf('--config-dir') === -1) {
    console.error('usage: bun run scripts/cdp/fixtures/live-settings-edit.ts --config-dir <dir> [--value <json>]')
    process.exit(2)
  }
  const raw = args.indexOf('--value') === -1 ? undefined : args[args.indexOf('--value') + 1]
  console.log(JSON.stringify(writeLiveSetting(configDir, raw === undefined ? undefined : JSON.parse(raw)), null, 2))
}
