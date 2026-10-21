/**
 * P6.760 — `collectUserAutoModeInput` is the seventh doctor collector, and the
 * one P6.684 deliberately left inside `apps/cli/src/doctor.ts` so that its own
 * five-collector done-means stayed checkable against a fixed number.
 *
 * Two things are pinned here, and the second is the one a move can quietly
 * break. First, that the collector is REACHABLE from `packages/shared` and
 * reads the same user-scope block the CLI's private copy read — the whole point
 * of the lift, because while it was CLI-private only the CLI could fill the
 * `userAutoMode` input and every other surface rendered a narrower report.
 * Second, the distinction every collector in that module documents:
 * `undefined` is *"I could not look"* and omits the section, while a settings
 * file that is simply ABSENT is a real answer and must come back as a record.
 * A wrapper that conflated them would make the report lie in the quiet
 * direction — the section would vanish rather than say "nothing configured".
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectUserAutoModeInput } from '../doctor-collectors.ts'

let configDir: string
let previousConfigDir: string | undefined

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'nessy-doctor-automode-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  // `delete` before assign: AGENTS.md §Traps — a plain assignment to a name Bun
  // pre-creates a slot for stays invisible to every env SPREAD. Nothing here
  // spreads, but the discipline is unconditional because the name is arbitrary.
  delete process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR
  if (previousConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

describe('the doctor reads the safety judge user scope from the shared collectors', () => {
  it('carries the tightening keys and names the widening one, called from packages/shared', () => {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        autoMode: {
          hard_deny: ['never touch production'],
          soft_deny: ['ask before deleting'],
          // The control: the user scope may tighten and may never widen, so this
          // key must come back REFUSED BY NAME rather than silently dropped.
          allow: ['anything at all'],
        },
      }),
      'utf-8',
    )

    const read = collectUserAutoModeInput()

    expect(read).toBeDefined()
    expect(read?.policy?.hard_deny).toEqual(['never touch production'])
    expect(read?.policy?.soft_deny).toEqual(['ask before deleting'])
    expect(read?.refusedKeys).toEqual(['allow'])
    expect(read?.path).toBe(join(configDir, 'settings.json'))
  })

  it('reports an ABSENT settings file as a record, not as "I could not look"', () => {
    // No file written: the ordinary case, since most developers write no
    // `autoMode` block at all.
    const read = collectUserAutoModeInput()

    // A record, so `buildConfigDoctorReport` still renders the section and can
    // say "nothing configured". `undefined` here would omit it entirely and the
    // reader could not tell absence from a failed read.
    expect(read).toBeDefined()
    expect(read?.policy).toBeUndefined()
    expect(read?.refusedKeys).toEqual([])
    expect(read?.invalidReason).toBeUndefined()
    expect(read?.path).toBe(join(configDir, 'settings.json'))
  })
})
