/**
 * P6.878 — the values `config.json` carries that never took effect now reach a
 * user without being asked for.
 *
 * W9-aw measured (P6.874) that `validateConfig()`'s report reached nobody
 * proactively: the watcher's route ended at a `BaseAgent` property with no
 * writer — P6.884 has since deleted that property, so the route now ends at a
 * debug line — and the only live route was the `config_validate` session tool,
 * on demand. Six keys in `validators.ts` are typed for exactly
 * this — the load path is unknown-tolerant, so a wrong value resolves to the
 * default silently, and the validator is *"the only place a user learns their
 * value never took effect"*.
 *
 * Both directions are pinned here, because both are silent and they fail
 * opposite ways:
 *
 * - POSITIVE: a planted `crossSessionInbound` typo is named, by key, in the
 *   report both the settings page and the terminal render. The key is the row's
 *   own example and the one P6.874's record is written on.
 * - NEGATIVE: a file that validates clean still PRINTS its section. A section
 *   that appeared only on a broken machine would leave "validated clean" and
 *   "not checked" indistinguishable — the same silence the row exists to end —
 *   and it must not move `hasFindings`, which is the pre-deployment fleet
 *   check `server-managed-settings.md#invalid-entries-in-delivered-settings`
 *   prescribes ("Validate a payload change with `claude doctor` on a test
 *   machine before rolling it out to the organization.").
 *
 * The collector reads the REAL `CONFIG_FILE`, so this file writes the real one:
 * under `bun test` the repo's `[test].preload` has already pointed
 * `NESSY_CONFIG_DIR` at a per-run temp directory before `paths.ts` froze
 * `CONFIG_DIR`, which is the only form of that isolation that works
 * (AGENTS.md §Traps). The previous contents are restored after each case so no
 * sibling file in the same run meets a config this suite wrote.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildConfigDoctorReport } from '../config-doctor.ts'
import { collectStoredConfigValidationInput } from '../doctor-collectors.ts'
import { CONFIG_DIR, STORAGE_LAYOUT_VERSION } from '../paths.ts'

const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

/** The managed half held constant, so what the report renders is the collector's. */
const MANAGED_INPUT = Object.freeze({
  drops: [],
  winner: 'none' as const,
  fileCarriesSettings: false,
})

/** The smallest file `StoredConfigSchema` accepts. */
function validConfig(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    storageLayoutVersion: STORAGE_LAYOUT_VERSION,
    workspaceRefs: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...extra,
  })
}

let previous: string | undefined

beforeEach(() => {
  previous = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : undefined
})

afterEach(() => {
  if (previous === undefined) rmSync(CONFIG_FILE, { force: true })
  else writeFileSync(CONFIG_FILE, previous, 'utf-8')
})

describe('the doctor names the config.json values that never took effect', () => {
  it('POSITIVE — a crossSessionInbound typo is named by key in the rendered report', () => {
    writeFileSync(CONFIG_FILE, validConfig({ crossSessionInbound: 'hodl' }), 'utf-8')

    const collected = collectStoredConfigValidationInput()

    // The collector's own answer first: a record, not "I could not look".
    expect(collected).toBeDefined()
    expect(collected?.file).toBe(CONFIG_FILE)
    const keys = (collected?.issues ?? []).map(issue => issue.key)
    expect(keys).toContain('crossSessionInbound')

    // Read the message into a LOCAL before asserting on it — an asymmetric
    // matcher passed into `toMatchObject` OVERWRITES the field it matches
    // (AGENTS.md §Traps, W8-td) and every later read of the object gets the
    // matcher instead of the value.
    const issue = (collected?.issues ?? []).find(entry => entry.key === 'crossSessionInbound')
    expect(issue?.severity).toBe('error')
    expect(issue?.message.length).toBeGreaterThan(0)

    // And the half the row is actually about: it reaches the surface. This is
    // the same `buildConfigDoctorReport` the settings page renders as text and
    // the CLI prints, so one assertion covers both.
    const report = buildConfigDoctorReport({ ...MANAGED_INPUT, storedConfigValidation: collected })
    expect(report.text).toContain('User config (config.json):')
    expect(report.text).toContain(`  - crossSessionInbound: ${issue?.message}`)
    expect(report.text).toContain(CONFIG_FILE)
  })

  it('NEGATIVE — a clean file still prints its section, and never moves the exit code', () => {
    writeFileSync(CONFIG_FILE, validConfig({ crossSessionInbound: 'hold' }), 'utf-8')

    const collected = collectStoredConfigValidationInput()

    expect(collected).toBeDefined()
    expect(collected?.issues).toEqual([])

    const report = buildConfigDoctorReport({ ...MANAGED_INPUT, storedConfigValidation: collected })
    // The honest-absence line: the validator RAN and refused nothing, which is
    // a different answer from a section that is simply not there.
    expect(report.text).toContain('User config (config.json):')
    expect(report.text).toContain('every value in this file was accepted by the schema.')
    expect(report.text).not.toContain('  - crossSessionInbound:')

    // A fault in a file on the reader's own desk is not an administrator's
    // finding — the call the safety judge's refused-key line already makes —
    // and `validateConfig()` answers `valid: false` for a config.json that does
    // not exist, which would fail every fresh install's fleet check.
    expect(report.hasFindings).toBe(false)
  })

  it('NEGATIVE — an absent config.json is a record about this machine, not a failed read', () => {
    rmSync(CONFIG_FILE, { force: true })

    const collected = collectStoredConfigValidationInput()

    // `undefined` here would omit the section entirely and the reader could not
    // tell "no config file" from "the doctor could not look".
    expect(collected).toBeDefined()
    expect(collected?.issues.length).toBe(1)
    // `path` is empty for a whole-file fault, so the issue's own file name is
    // what keys it — a bare colon would be the alternative.
    expect(collected?.issues[0]?.key).toBe('config.json')

    const report = buildConfigDoctorReport({ ...MANAGED_INPUT, storedConfigValidation: collected })
    expect(report.text).toContain('  - config.json: ')
    expect(report.hasFindings).toBe(false)
  })
})
