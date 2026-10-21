/**
 * F1.101 (origin D1.419, D1.409's named residue) — the managed local-automation
 * policy reaches a process in which no codex runtime starts.
 *
 * `recordCodexLocalAutomationRequirement` writes a MODULE-SCOPE tier, and only
 * the codex probe writes it, so a Pi-only or claude-only launch ran schedulers an
 * administrator had forbidden — ungated, and reported nowhere. The in-app-UPDATES
 * twin had solved exactly this with a disk cache, which D1.409 refused to reuse
 * for one measured reason: its reader ran from the ELECTRON bootstrap only, so
 * the headless server would ignore the policy. The fix is the twin's mechanism
 * restored from the ONE bootstrap both hosts run — `bootstrapServer`'s config
 * artifacts step — ahead of the session manager that builds the schedulers.
 *
 * The three controls D1.419 names: an answered requirement round-trips; an
 * answered "no requirement" CLEARS the tier (P2.137's rule); an unreadable cache
 * leaves it alone. D1.409's own suite (case (f)) is the fourth, run beside this.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CODEX_MANAGED_LOCAL_AUTOMATION_CACHE_FILE,
  persistCodexLocalAutomationRequirement,
  recordAndPersistCodexLocalAutomationRequirement,
  restoreCodexLocalAutomationRequirement,
} from '../codex-managed-requirement-cache.ts'
import {
  recordCodexLocalAutomationRequirement,
  resolveManagedLocalAutomationDisabled,
} from '../managed-local-automation.ts'

afterEach(() => { recordCodexLocalAutomationRequirement(undefined) })

const scratch = (): string => mkdtempSync(join(tmpdir(), 'f1101-local-automation-'))

describe('F1.101 — the answered local-automation tier survives a restart', () => {
  it('round-trips an answered requirement and applies it to the tier', () => {
    const dir = scratch()
    expect(persistCodexLocalAutomationRequirement(true, dir)).toBe(true)
    expect(resolveManagedLocalAutomationDisabled()).toBeUndefined()
    expect(restoreCodexLocalAutomationRequirement(dir)).toBe(true)
    expect(resolveManagedLocalAutomationDisabled()).toBe(true)
    // Private, because it records an administrator policy — the twin's rule.
    expect(statSync(join(dir, CODEX_MANAGED_LOCAL_AUTOMATION_CACHE_FILE)).mode & 0o777).toBe(0o600)
  })

  it('CONTROL — an answered NO-REQUIREMENT clears the tier rather than leaving a stale disable', () => {
    const dir = scratch()
    recordCodexLocalAutomationRequirement(true)
    expect(persistCodexLocalAutomationRequirement(undefined, dir)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, CODEX_MANAGED_LOCAL_AUTOMATION_CACHE_FILE), 'utf8')))
      .toEqual({ v: 1, localAutomationDisabled: null })
    expect(restoreCodexLocalAutomationRequirement(dir)).toBe(true)
    expect(resolveManagedLocalAutomationDisabled()).toBeUndefined()
  })

  it('CONTROL — an unreadable cache leaves the tier alone', () => {
    for (const body of ['not json', '{"v":2,"localAutomationDisabled":true}', '{"v":1,"localAutomationDisabled":"yes"}']) {
      const dir = scratch()
      writeFileSync(join(dir, CODEX_MANAGED_LOCAL_AUTOMATION_CACHE_FILE), body)
      recordCodexLocalAutomationRequirement(true)
      expect(restoreCodexLocalAutomationRequirement(dir)).toBe(false)
      expect(resolveManagedLocalAutomationDisabled()).toBe(true)
    }
    // Absent file: the same "we do not know".
    expect(restoreCodexLocalAutomationRequirement(scratch())).toBe(false)
  })

  it('the codex probe records AND persists, inside the requirementAnswered guard', () => {
    const dir = scratch()
    recordAndPersistCodexLocalAutomationRequirement(true, dir)
    expect(resolveManagedLocalAutomationDisabled()).toBe(true)
    recordCodexLocalAutomationRequirement(undefined)
    expect(restoreCodexLocalAutomationRequirement(dir)).toBe(true)
    expect(resolveManagedLocalAutomationDisabled()).toBe(true)

    const source = readFileSync(new URL('../../agent/codex-agent.ts', import.meta.url), 'utf8')
    const guard = source.indexOf("const requirementAnswered = requirements.status === 'read' || requirements.status === 'none';")
    const write = source.indexOf('recordAndPersistCodexLocalAutomationRequirement(requirements.localAutomationDisabled)')
    const elseArm = source.indexOf('} else {', guard)
    expect(guard).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(guard)
    expect(write).toBeLessThan(elseArm)
  })

  it('BOTH hosts restore it: bootstrapServer’s config-artifacts step, ahead of the config dir and the session manager', () => {
    const source = readFileSync(
      new URL('../../../../server-core/src/bootstrap/headless-start.ts', import.meta.url),
      'utf8',
    )
    const step = source.indexOf('function bootstrapConfigArtifacts(')
    // The CALL lines, indented as statements: the step's own first comment names
    // `ensureConfigDir()` ("MUST precede ensureConfigDir()"), so a bare needle
    // would find the comment and read the order backwards.
    const restore = source.indexOf('\n  restoreCodexLocalAutomationRequirement()\n', step)
    const configDir = source.indexOf('\n  ensureConfigDir()\n', step)
    const sessionManager = source.indexOf('options.createSessionManager(storageLayout)')
    expect(step).toBeGreaterThan(-1)
    expect(restore).toBeGreaterThan(step)
    expect(restore).toBeLessThan(configDir)
    expect(configDir).toBeLessThan(sessionManager)
    // Electron runs the same step: its main process calls `bootstrapServer` with
    // no `configArtifactsInitializer`, so the default above is what it gets.
    const electron = readFileSync(
      new URL('../../../../../apps/electron/src/main/index.ts', import.meta.url),
      'utf8',
    )
    expect(electron).toContain('bootstrapServer<SessionManager, HandlerDeps>({')
    expect(electron).not.toContain('configArtifactsInitializer')
  })
})
