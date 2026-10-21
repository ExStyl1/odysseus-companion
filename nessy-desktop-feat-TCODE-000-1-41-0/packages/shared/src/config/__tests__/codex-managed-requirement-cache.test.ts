/**
 * P3.261 — the launch update check ran UNGATED on a codex-only fleet.
 *
 * The codex tier is module-scope, so it can only be armed once the first codex
 * runtime of the process has started, and `checkForUpdatesOnLaunch()` runs
 * before that. An organisation running codex alone therefore got a WEAKER
 * guarantee than a mixed fleet, which inverts what an operator would assume.
 *
 * This file pins the persistence half — the writer, the reader, and the rule
 * that decides what may be written. The remaining half is one CALL to
 * {@link restoreCodexInAppUpdatesRequirement} from the electron host's bootstrap
 * before `registerEnforcedManagedInAppUpdatesProvider()`; the row's own note
 * says the in-zone half ALONE would be a dead mechanism, which is why the reader
 * ships and is tested here rather than being left for that call site to invent.
 *
 * WHAT EACH TEST KILLS:
 *  - "round-trips an answered requirement" dies if the write or the read is
 *    dropped — the mechanism itself.
 *  - "an answered NO-REQUIREMENT clears the tier" dies if `null` is treated as
 *    "we do not know": an administrator WITHDRAWING the policy would then never
 *    take effect across a restart.
 *  - "a non-answer never reaches the cache" dies if the caller's
 *    `requirementAnswered` guard is dropped — P2.137's exact defect, where one
 *    failed probe re-opened an update channel an administrator had closed, now
 *    with a restart's persistence behind it.
 *  - "refuses a cache it cannot trust" dies if a missing, corrupt, mis-versioned
 *    or wrong-typed file is read as "there is no requirement" instead of "we do
 *    not know". Those are different facts and only one of them may clear a
 *    deployed policy.
 *  - "never throws on an unwritable location" dies if the write stops being
 *    best-effort — an identity/caching convenience must not stop a runtime.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  persistCodexInAppUpdatesRequirement,
  readCodexInAppUpdatesRequirementCache,
  restoreCodexInAppUpdatesRequirement,
  CODEX_MANAGED_REQUIREMENT_CACHE_FILE,
} from '../codex-managed-requirement-cache.ts'
import {
  recordCodexInAppUpdatesRequirement,
  registerManagedInAppUpdatesDisabledProvider,
  resolveManagedInAppUpdatesDisabled,
} from '../managed-in-app-updates.ts'

// The tier is a process-wide singleton, so every test puts it back.
afterEach(() => {
  registerManagedInAppUpdatesDisabledProvider(undefined)
  recordCodexInAppUpdatesRequirement(undefined)
})

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'w2s-codex-req-'))
}

describe('P3.261 · the answered codex requirement survives a restart', () => {
  it('round-trips an answered requirement and applies it to the tier', () => {
    for (const disabled of [true, false]) {
      const dir = scratch()
      expect(persistCodexInAppUpdatesRequirement(disabled, dir)).toBe(true)
      expect(readCodexInAppUpdatesRequirementCache(dir)).toEqual({ v: 1, inAppUpdatesDisabled: disabled })
      // A fresh process: nothing has armed the tier yet.
      recordCodexInAppUpdatesRequirement(undefined)
      expect(restoreCodexInAppUpdatesRequirement(dir)).toBe(true)
      expect({ disabled, tier: resolveManagedInAppUpdatesDisabled() }).toEqual({ disabled, tier: disabled })
    }
  })

  it('an answered NO-REQUIREMENT clears the tier rather than leaving a stale disable', () => {
    const dir = scratch()
    // The server answered `status:'none'` — an administrator withdrew the policy.
    expect(persistCodexInAppUpdatesRequirement(undefined, dir)).toBe(true)
    expect(readCodexInAppUpdatesRequirementCache(dir)).toEqual({ v: 1, inAppUpdatesDisabled: null })
    recordCodexInAppUpdatesRequirement(true)
    expect(restoreCodexInAppUpdatesRequirement(dir)).toBe(true)
    expect(resolveManagedInAppUpdatesDisabled()).toBeUndefined()
  })

  it('writes the cache private, because it records an administrator policy', () => {
    const dir = scratch()
    persistCodexInAppUpdatesRequirement(true, dir)
    const file = join(dir, CODEX_MANAGED_REQUIREMENT_CACHE_FILE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, inAppUpdatesDisabled: true })
  })

  it('refuses a cache it cannot trust, and leaves the tier alone', () => {
    const cases: Array<[string, string | undefined]> = [
      ['absent', undefined],
      ['unparseable', '{not json'],
      ['wrong version', JSON.stringify({ v: 2, inAppUpdatesDisabled: true })],
      ['wrong type', JSON.stringify({ v: 1, inAppUpdatesDisabled: 'true' })],
      ['null document', 'null'],
      ['missing field', JSON.stringify({ v: 1 })],
    ]
    for (const [label, contents] of cases) {
      const dir = scratch()
      if (contents !== undefined) writeFileSync(join(dir, CODEX_MANAGED_REQUIREMENT_CACHE_FILE), contents)
      expect({ label, cache: readCodexInAppUpdatesRequirementCache(dir) }).toEqual({ label, cache: undefined })
      recordCodexInAppUpdatesRequirement(true)
      expect({ label, applied: restoreCodexInAppUpdatesRequirement(dir) }).toEqual({ label, applied: false })
      // "We do not know" must never clear a value that is already standing.
      expect({ label, tier: resolveManagedInAppUpdatesDisabled() }).toEqual({ label, tier: true })
    }
  })

  it('never throws on an unwritable location', () => {
    const dir = scratch()
    // A FILE where the config directory should be: `mkdirSync` fails, and so
    // does the write. The contract is `false`, never a throw.
    const blocked = join(dir, 'not-a-directory')
    writeFileSync(blocked, 'x')
    expect(persistCodexInAppUpdatesRequirement(true, blocked)).toBe(false)
    expect(readCodexInAppUpdatesRequirementCache(blocked)).toBeUndefined()
    expect(restoreCodexInAppUpdatesRequirement(blocked)).toBe(false)
  })

  it('creates the config directory when it does not exist yet', () => {
    const dir = join(scratch(), 'nested', 'config')
    expect(persistCodexInAppUpdatesRequirement(false, dir)).toBe(true)
    expect(readCodexInAppUpdatesRequirementCache(dir)).toEqual({ v: 1, inAppUpdatesDisabled: false })
  })
})

/**
 * The caller's guard, pinned in source for the same reason
 * `codex-config-requirements.test.ts` pins its twin: the write happens inside
 * `createRuntime`, which needs a real app-server and an adapter port to reach.
 */
describe('P3.261 · only an ANSWERED requirement may write', () => {
  it('the cache write sits inside the requirementAnswered guard', () => {
    const source = readFileSync(
      new URL('../../agent/codex-agent.ts', import.meta.url),
      'utf8',
    )
    const guard = source.indexOf("const requirementAnswered = requirements.status === 'read' || requirements.status === 'none';")
    const write = source.indexOf('persistCodexInAppUpdatesRequirement(requirements.inAppUpdatesDisabled)')
    const elseArm = source.indexOf('} else {', guard)
    expect(guard).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(guard)
    expect(write).toBeLessThan(elseArm)
    // And the reader is named at the site, so the owed bootstrap call is not
    // rediscovered by grep.
    expect(source).toContain('restoreCodexInAppUpdatesRequirement')
  })
})
