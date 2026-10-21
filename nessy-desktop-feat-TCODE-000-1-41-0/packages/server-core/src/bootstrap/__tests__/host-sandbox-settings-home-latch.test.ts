/**
 * F1.193 — ONE resolver for the credential read floor's seed in server-core, and
 * it is the latched one.
 *
 * `resolveHostSandboxSettings` (the ProcessSupervisor's sandbox, resolved once
 * per `SessionManager`) and the doctor's `collectSandboxFilesystem`
 * (`managed-policy-resolution.ts`) seeded `credentialDenyRoots` from the LIVE
 * `os.homedir()`, while `pi-harness/isolation.ts` seeded the same roots from
 * `latchedHomeDir()` (P3.168). On Node a confirmed managed `HOME` moves
 * `os.homedir()` mid-session (P3.143), so the two could name different trees —
 * and only the latched one holds `~/.nessy/dp_auth_creds.json`.
 *
 * This moves the LATCH rather than `process.env.HOME`, because under `bun test`
 * the variable moves nothing (P3.169); the negative control proves the two homes
 * really differ in this run.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { latchedHomeDir, relatchHomeDirForTests } from '@nessy-agent/shared/config/home-latch'
import { DEFAULT_MANAGED_PI_POLICY } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { resolveHostSandboxSettings } from '../host-sandbox-settings.ts'

const LATCHED = '/tmp/f1193-latched-home'

afterEach(() => { relatchHomeDirForTests() })

describe('F1.193 — the server-core credential floor seed reads the latched home', () => {
  it('resolveHostSandboxSettings denies the LATCHED home’s credential roots, not the live one’s', () => {
    relatchHomeDirForTests(LATCHED)
    expect(latchedHomeDir()).toBe(LATCHED)
    expect(homedir()).not.toBe(LATCHED)
    const { deniedReadRoots } = resolveHostSandboxSettings(DEFAULT_MANAGED_PI_POLICY, { dpStateRoot: () => undefined })
    expect(deniedReadRoots).toContain(join(LATCHED, '.nessy'))
    expect(deniedReadRoots).toContain(join(LATCHED, '.ssh'))
    expect(deniedReadRoots).not.toContain(join(homedir(), '.nessy'))
  })

  it('CONTROL — latch unmoved: the seed is the same home it always was', () => {
    const { deniedReadRoots } = resolveHostSandboxSettings(DEFAULT_MANAGED_PI_POLICY, { dpStateRoot: () => undefined })
    expect(deniedReadRoots).toContain(join(homedir(), '.nessy'))
  })

  it('the doctor seeds its floor through the same resolver — no second live-home read in either bootstrap file', () => {
    const doctor = readFileSync(new URL('../managed-policy-resolution.ts', import.meta.url), 'utf8')
    const settings = readFileSync(new URL('../host-sandbox-settings.ts', import.meta.url), 'utf8')
    // Guard the CALL, not the identifier, and assert the successor in the same test.
    expect(doctor).not.toContain('credentialDenyRoots(homedir()')
    expect(settings).not.toContain('credentialDenyRoots(homedir()')
    expect(doctor).toContain('credentialFloor: hostCredentialDenyRoots()')
    expect(settings).toContain('const seeded = hostCredentialDenyRoots()')
  })
})
