import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProcessIsolation } from './isolation.ts'
import {
  ISOLATION_UNAVAILABLE_PREFIX,
  isolationUnavailable,
  probeIsolationCapabilities,
} from './isolation-capabilities.ts'

describe('isolation remediation', () => {
  test('names the remediation for each unavailable reason', () => {
    // The message is already structured; what is missing is what to do about it.
    for (const [message, hint] of [
      [isolationUnavailable('darwin', 'workspace'), /sandbox-exec/],
      [isolationUnavailable('linux', 'workspace', 'network'), /bwrap|firejail|unshare/],
      [isolationUnavailable('linux', 'workspace', 'filesystem'), /bwrap|firejail/],
      [isolationUnavailable('win32', 'workspace', 'runtime'), /toolchain/],
      [isolationUnavailable('win32', 'workspace', 'state-root'), /state root/],
      [isolationUnavailable('linux', 'isolated-code', 'declared-input-read-boundary'), /not implemented/],
      [isolationUnavailable('freebsd', 'workspace'), /no process isolation backend/],
    ] as const) {
      expect(message).toMatch(hint)
    }
  })

  test('keeps the structured prefix so existing parsers still work', () => {
    expect(isolationUnavailable('darwin', 'workspace')).toStartWith(`${ISOLATION_UNAVAILABLE_PREFIX}:darwin:workspace`)
    expect(isolationUnavailable('linux', 'workspace', 'network'))
      .toStartWith(`${ISOLATION_UNAVAILABLE_PREFIX}:linux:workspace:network`)
  })

  test('every real throw site keeps the parseable prefix and gains a remediation', () => {
    let testRoot = ''
    try {
      testRoot = mkdtempSync(join(tmpdir(), 'nessy-isolation-remediation-'))
      const workspaceRoot = join(testRoot, 'workspace')
      mkdirSync(workspaceRoot, { recursive: true })
      const base = {
        profile: 'workspace' as const,
        command: '/usr/bin/true',
        args: [],
        workspaceRoot,
        workingDirectory: workspaceRoot,
        scratchRoot: join(testRoot, 'scratch'),
      }

      // isolated-code: unconditional on every platform.
      expect(() => resolveProcessIsolation({ ...base, platform: 'linux', profile: 'isolated-code' }))
        .toThrow(/^process-isolation-unavailable:linux:isolated-code:declared-input-read-boundary — /)
      // Unknown platform: no backend at all.
      expect(() => resolveProcessIsolation({ ...base, platform: 'freebsd' }))
        .toThrow(/^process-isolation-unavailable:freebsd:workspace — /)
      // win32 with no state root, then with a state root but no toolchain.
      expect(() => resolveProcessIsolation({ ...base, platform: 'win32' }))
        .toThrow(/^process-isolation-unavailable:win32:workspace:state-root — /)
      expect(() => resolveProcessIsolation({
        ...base,
        platform: 'win32',
        windowsSandboxStateRoot: join(testRoot, 'win-state'),
      })).toThrow(/^process-isolation-unavailable:win32:workspace:runtime — .*toolchain/)
    } finally {
      if (testRoot) rmSync(testRoot, { recursive: true, force: true })
    }
  })
})

describe('probeIsolationCapabilities', () => {
  let testRoot = ''

  afterEach(() => {
    if (testRoot) rmSync(testRoot, { recursive: true, force: true })
    testRoot = ''
  })

  test('reports per-profile availability without spawning a turn', async () => {
    const report = await probeIsolationCapabilities()
    expect(report.platform).toBe(process.platform)
    expect(Object.keys(report.profiles)).toContain('workspace')
    expect(Object.keys(report.profiles)).toEqual([
      'read-only', 'workspace', 'networked', 'plugin-mcp', 'isolated-code',
    ])
    for (const entry of Object.values(report.profiles)) {
      expect(typeof entry.available).toBe('boolean')
      if (!entry.available) expect(entry.remediation).toBeString()
    }
  })

  test('reports isolated-code as unavailable on every platform', async () => {
    // It throws unconditionally at isolation.ts — the probe must say so rather
    // than implying a platform difference.
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const report = await probeIsolationCapabilities({ platform })
      expect(report.profiles['isolated-code']).toMatchObject({ available: false })
      expect(report.profiles['isolated-code'].reason).toBe('declared-input-read-boundary')
    }
    // P6.614 — an EXPLICIT budget, set against the measured floor rather than
    // left on bun's 5 s default, because this case is STARVED under wave load
    // and not slow. Measured 2026-09-06 with the junit reporter, which is the
    // only instrument here that reports a per-test duration:
    //
    //   load 11.75  →  67.65 ms   (the floor; slowest of this file's ten)
    //   load 55.34  →   4.11 s    (61x, and 0.9 s short of the 5 s default)
    //   load 10.4-10.7 → 8.4 s then 15.1 s, W7-l's two observations, RED
    //
    // Zero assertion failures in every one of those runs, which is the shape
    // AGENTS.md separates: the body does no I/O and no spawning, so 67 ms → 15 s
    // is where the yield lands, not work being done. The budget is 444x the
    // floor and 2x the worst observation.
    //
    // Why this case and not its nine neighbours: it is the only one that runs
    // THREE probes in one body. Its nearest neighbour is 35.7 ms — 1.9x cheaper,
    // so it crosses 5 s only under load half again as heavy, and it has never
    // been seen red. If one of them does go red, these numbers are the scale to
    // set its budget against; do not copy 30 s without re-measuring the floor.
  }, 30_000)

  test('does not throw when a backend is missing, and names what to install', async () => {
    // win32 with no toolchain binding is the silent-undefined case from the
    // audit: the runtime resolver returns undefined and nothing reports it.
    const report = await probeIsolationCapabilities({ platform: 'win32' })
    expect(report.profiles['workspace'].available).toBe(false)
    expect(report.profiles['workspace'].remediation).toMatch(/toolchain/)
  })

  // ── Egress disclosure ──────────────────────────────────────────────────
  // `networked: available` says the profile RUNS. It says nothing about what
  // the profile grants, and an administrator reads "available" as "bounded".
  // The report carries the posture so the settings page can state it, and it
  // carries the resolver's own sentences so there is never a second truth.

  test('reports the open egress posture, and names each deniedDomains entry that binds nothing', async () => {
    const report = await probeIsolationCapabilities({
      platform: 'linux',
      network: { deniedDomains: ['*.example.com'], allowedDomains: [], allowManagedDomainsOnly: false },
    })
    expect(report.network).toBeDefined()
    expect(report.network!.egress).toBe('open')
    expect(report.network!.source).toBe('default')
    expect(report.network!.unenforceable).toHaveLength(1)
    expect(report.network!.unenforceable[0]).toContain('sandbox.network.deniedDomains "*.example.com"')
    expect(report.network!.unenforceable[0]).toContain('is NOT enforced for sandboxed commands')
  })

  test('reports the denied posture, and names each allowedDomains entry the deny makes unreachable', async () => {
    const report = await probeIsolationCapabilities({
      platform: 'linux',
      network: { deniedDomains: [], allowedDomains: ['registry.npmjs.org'], allowManagedDomainsOnly: true },
    })
    expect(report.network!.egress).toBe('denied')
    expect(report.network!.source).toBe('allowManagedDomainsOnly')
    expect(report.network!.unenforceable[0]).toContain('sandbox.network.allowedDomains "registry.npmjs.org"')
    expect(report.network!.unenforceable[0]).toContain('is NOT reachable from a sandboxed command')
  })

  test('omits the posture rather than guessing one when the caller has no resolved settings', async () => {
    // Absent must read as "not reported here", never as "restricted".
    expect((await probeIsolationCapabilities({ platform: 'linux' })).network).toBeUndefined()
  })

  test('reports an available profile with the backend that would be used', async () => {
    testRoot = mkdtempSync(join(tmpdir(), 'nessy-isolation-probe-'))
    const report = await probeIsolationCapabilities({
      probeRoot: testRoot,
      platform: 'linux',
      resolve: input => ({
        command: input.command,
        args: input.args,
        backend: 'stub-backend:host-read:write-workspace+scratch',
        profile: input.profile as Exclude<typeof input.profile, 'none'>,
      }),
    })
    expect(report.profiles['workspace']).toMatchObject({
      available: true,
      backend: 'stub-backend:host-read:write-workspace+scratch',
    })
  })
})
