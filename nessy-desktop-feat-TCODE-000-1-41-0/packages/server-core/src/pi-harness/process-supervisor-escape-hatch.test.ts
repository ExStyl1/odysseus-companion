import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionKey } from '@nessy-agent/shared/sessions/session-key'
import { ProcessStore } from './process-store.ts'
import { ProcessSupervisor } from './process-supervisor.ts'
import { isolationUnavailable } from './isolation-remediation.ts'

const OWNER: SessionKey = { workspaceId: 'workspace-a', sessionId: 'session-a' }

/**
 * Runs one real supervised process. `isolationUnavailable` swaps the resolver for
 * one that throws the way a host with no backend does, so the fail-closed paths
 * are exercised without needing a machine that actually lacks one.
 */
async function runSupervised(options: {
  command?: string
  excludedCommands?: readonly string[]
  allowUnsandboxedCommands?: boolean
  dangerouslyDisableSandbox?: boolean
  isolationDowngradeDecision?: string
  isolationUnavailable?: boolean
}) {
  const root = await mkdtemp(join(tmpdir(), 'nessy-escape-hatch-'))
  try {
    const store = new ProcessStore({ root })
    const supervisor = new ProcessSupervisor({
      store,
      ...(options.excludedCommands ? { excludedCommands: options.excludedCommands } : {}),
      ...(options.allowUnsandboxedCommands === undefined
        ? {}
        : { allowUnsandboxedCommands: options.allowUnsandboxedCommands }),
      resolveIsolation: input => {
        if (options.isolationUnavailable) throw new Error(isolationUnavailable('linux', input.profile))
        return {
          command: input.command,
          args: input.args,
          backend: 'stub-backend',
          profile: input.profile as Exclude<typeof input.profile, 'none'>,
        }
      },
    })
    const result = await supervisor.start({
      sessionKey: OWNER,
      executionId: 'exec-1',
      semanticId: 'bash',
      command: options.command ?? process.execPath,
      args: options.command ? [] : ['-e', 'process.stdout.write("ok")'],
      cwd: root,
      workspaceRoot: root,
      profile: 'workspace',
      background: false,
      timeoutMs: 5_000,
      ...(options.dangerouslyDisableSandbox ? { dangerouslyDisableSandbox: true } : {}),
      ...(options.isolationDowngradeDecision
        ? { isolationDowngradeDecision: options.isolationDowngradeDecision }
        : {}),
    })
    return { result, stored: await store.get(result.handle) }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('ProcessSupervisor escape hatch', () => {
  test('runs an excluded command without isolation and records the downgrade', async () => {
    const { result, stored } = await runSupervised({
      command: '/usr/bin/true',
      excludedCommands: ['/usr/bin/true'],
    })
    expect(result.isolationProfile).toBe('excluded-by-policy')
    expect(result.isolationDowngrade).toMatchObject({ reason: 'excludedCommands', pattern: '/usr/bin/true' })
    // Persisted, not just returned — a read() after recovery must still see it.
    expect(stored.isolationProfile).toBe('excluded-by-policy')
    expect(stored.isolationDowngrade).toMatchObject({ reason: 'excludedCommands' })
  })

  test('does not let the downgrade hide behind the existing no-host-isolation marker', async () => {
    // tool-executor.ts already falls back to 'no-host-isolation' when a result
    // carries no profile. A policy downgrade must be distinguishable from that
    // fallback, or an audit cannot tell an intentional exclusion from a missing
    // backend.
    const excluded = await runSupervised({ command: '/usr/bin/true', excludedCommands: ['/usr/bin/true'] })
    expect(excluded.result.isolationProfile).not.toBe('no-host-isolation')
    expect(excluded.result.isolationProfile).toBe('excluded-by-policy')

    const isolated = await runSupervised({})
    expect(isolated.result.isolationProfile).toBe('workspace:stub-backend')
    expect(isolated.result.isolationDowngrade).toBeUndefined()
  })

  test('requires an explicit decision for dangerouslyDisableSandbox', async () => {
    await expect(runSupervised({ dangerouslyDisableSandbox: true }))
      .rejects.toThrow('process-isolation-downgrade-decision-required')
  })

  test('runs and records an explicitly decided dangerouslyDisableSandbox', async () => {
    const { result } = await runSupervised({
      command: '/usr/bin/true',
      dangerouslyDisableSandbox: true,
      isolationDowngradeDecision: 'decision-42',
    })
    expect(result.isolationProfile).toBe('sandbox-disabled-by-decision')
    expect(result.isolationDowngrade).toMatchObject({
      reason: 'dangerouslyDisableSandbox',
      decisionId: 'decision-42',
    })
  })

  test('refuses dangerouslyDisableSandbox outright under strict sandbox mode', async () => {
    // allowUnsandboxedCommands:false is the enterprise lock. Not prompted, not
    // downgraded-and-recorded — refused.
    await expect(runSupervised({
      dangerouslyDisableSandbox: true,
      isolationDowngradeDecision: 'decision-42',
      allowUnsandboxedCommands: false,
    })).rejects.toThrow('process-isolation-unsandboxed-commands-disallowed')
  })

  test('keeps excludedCommands working under strict sandbox mode', async () => {
    // The documented contract: strict mode locks the dangerouslyDisableSandbox
    // hatch and leaves excludedCommands alone, which is what makes it usable.
    const { result } = await runSupervised({
      command: '/usr/bin/true',
      excludedCommands: ['/usr/bin/true'],
      allowUnsandboxedCommands: false,
    })
    expect(result.isolationProfile).toBe('excluded-by-policy')
  })

  test('keeps failing closed for a command that matches nothing', async () => {
    await expect(runSupervised({
      command: '/usr/bin/true',
      excludedCommands: ['docker *'],
      isolationUnavailable: true,
    })).rejects.toThrow('process-isolation-unavailable')
  })

  test('fails closed with no escape configuration at all', async () => {
    await expect(runSupervised({ isolationUnavailable: true }))
      .rejects.toThrow('process-isolation-unavailable')
  })
})
