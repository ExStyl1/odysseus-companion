import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { CONFIG_DIR } from '@nessy-agent/shared/config'
import { credentialDenyRoots } from '@nessy-agent/session-tools-core'
import { parseManagedPiPolicyV1 } from '@nessy-agent/shared/agent/pi-harness/managed-policy'
import { resolveDpStateRoot } from '@nessy-agent/shared/auth/dp'
import { createTestSessionManager } from './test-session-manager.ts'

// This machine may or may not have a `~/.dp` state root — CI never does, a dp
// user's dev box always does. `withDpStateRootWriteGrant` appends it to
// `additionalWritableRoots` for every resolution, so any exact-array
// assertion below must account for it dynamically to stay green on both rigs.
const dpRoot = resolveDpStateRoot()
const withDpRoot = (roots: readonly string[]): string[] => (dpRoot ? [...roots, dpRoot] : [...roots])

type Internals = {
  sandboxSettings: {
    deniedReadRoots: readonly string[]
    deniedWriteRoots: readonly string[]
    additionalWritableRoots: readonly string[]
    excludedCommands: readonly string[]
    allowUnsandboxedCommands: boolean
  }
  resolveChannelPolicy(): { enabled: boolean; allowedSources?: readonly string[] }
  piProcessSupervisor: {
    options: {
      deniedReadRoots?: readonly string[]
      deniedWriteRoots?: readonly string[]
      additionalWritableRoots?: readonly string[]
    }
  }
}

function internals(policy?: Parameters<typeof parseManagedPiPolicyV1>[0]): Internals {
  const manager = createTestSessionManager(
    policy ? { managedPiPolicy: parseManagedPiPolicyV1(policy) } : {},
  )
  return manager as unknown as Internals
}

describe('managed sandbox and channel keys reach their consumers', () => {
  test('the seeded credential denies reach the process supervisor', () => {
    const supervisor = internals().piProcessSupervisor
    for (const root of credentialDenyRoots(homedir(), CONFIG_DIR)) {
      expect(supervisor.options.deniedReadRoots).toContain(root)
    }
  })

  test('a managed sandbox layer adds denies and locks strict mode', () => {
    const resolved = internals({
      schemaVersion: 1,
      disabledPermissionModes: [],
      sandbox: {
        deniedReadRoots: ['/srv/managed-secrets'],
        excludedCommands: ['docker *'],
        allowUnsandboxedCommands: false,
      },
    })
    expect(resolved.sandboxSettings.deniedReadRoots).toContain('/srv/managed-secrets')
    // The seeded floor survives alongside the managed additions.
    for (const root of credentialDenyRoots(homedir(), CONFIG_DIR)) {
      expect(resolved.sandboxSettings.deniedReadRoots).toContain(root)
    }
    expect(resolved.sandboxSettings.excludedCommands).toEqual(['docker *'])
    expect(resolved.sandboxSettings.allowUnsandboxedCommands).toBe(false)
  })

  // sandboxing.md:162 - `allowWrite` paths are "enforced at the OS level, so all
  // commands running inside the sandbox, including their child processes,
  // respect them". Resolving the grant and never handing it to the supervisor
  // made the key inert; this is the wire.
  test('a managed writable grant reaches the process supervisor', () => {
    const resolved = internals({
      schemaVersion: 1,
      disabledPermissionModes: [],
      sandbox: { additionalWritableRoots: ['/srv/build-cache'] },
    })
    expect(resolved.sandboxSettings.additionalWritableRoots).toEqual(withDpRoot(['/srv/build-cache']))
    expect(resolved.piProcessSupervisor.options.additionalWritableRoots).toEqual(withDpRoot(['/srv/build-cache']))
  })

  test('with no configured grant the supervisor widens nothing', () => {
    const resolved = internals()
    expect(resolved.sandboxSettings.additionalWritableRoots).toEqual(withDpRoot([]))
    expect(resolved.piProcessSupervisor.options.additionalWritableRoots).toEqual(withDpRoot([]))
    expect(resolved.sandboxSettings.deniedWriteRoots).toEqual([])
  })

  // sandboxing.md:372 - "Paths from both `sandbox.filesystem` settings and
  // permission rules are merged together into the final sandbox configuration."
  test('managed Edit/Read rules merge into the resolved sandbox boundary', () => {
    const resolved = internals({
      schemaVersion: 1,
      disabledPermissionModes: [],
      claudeRules: {
        allow: ['Edit(//tmp/build/**)'],
        deny: ['Edit(//usr/local/bin/**)', 'Read(//etc/shadow)'],
      },
    })
    expect(resolved.sandboxSettings.additionalWritableRoots).toEqual(withDpRoot(['/tmp/build']))
    expect(resolved.sandboxSettings.deniedWriteRoots).toEqual(['/usr/local/bin'])
    expect(resolved.sandboxSettings.deniedReadRoots).toContain('/etc/shadow')
    // The seeded credential floor is not displaced by the rule-derived denies.
    for (const root of credentialDenyRoots(homedir(), CONFIG_DIR)) {
      expect(resolved.sandboxSettings.deniedReadRoots).toContain(root)
    }
    expect(resolved.piProcessSupervisor.options.additionalWritableRoots).toEqual(withDpRoot(['/tmp/build']))
    expect(resolved.piProcessSupervisor.options.deniedWriteRoots).toEqual(['/usr/local/bin'])
  })

  test('a rule grant never unlocks a managed grant cap', () => {
    const resolved = internals({
      schemaVersion: 1,
      disabledPermissionModes: [],
      sandbox: { additionalWritableRoots: ['/opt/company'] },
      claudeRules: { allow: ['Edit(//tmp/build/**)'] },
    })
    // Both come from the administrator, so both are inside the cap - and the
    // cap still holds against every later layer.
    expect(resolved.sandboxSettings.additionalWritableRoots).toEqual(withDpRoot(['/opt/company', '/tmp/build']))
  })

  test('a managed channel switch of false is terminal for this host', () => {
    expect(internals({
      schemaVersion: 1, disabledPermissionModes: [], channelsEnabled: false,
    }).resolveChannelPolicy().enabled).toBe(false)
  })

  test('a managed channel allowlist reaches the resolved policy', () => {
    expect(internals({
      schemaVersion: 1, disabledPermissionModes: [], allowedChannelServers: ['github'],
    }).resolveChannelPolicy().allowedSources).toEqual(['github'])
  })

  test('with no managed policy the host is permissive only where the user is', () => {
    const policy = internals().resolveChannelPolicy()
    expect(policy.allowedSources).toBeUndefined()
    expect(typeof policy.enabled).toBe('boolean')
  })
})
