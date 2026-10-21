import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionKey } from '@nessy-agent/shared/sessions/session-key'
// TFP1 (2026-10-10): the four real-child cases below spawn `process.execPath` and wait
// for the reaper to settle the record. Alone each is sub-second, but the ci-test-chunks
// composition runs this directory as ONE bun process over 48 files, and there the SILENT
// case fired bun's 5 000 ms default twice (final gate 2: 5 000.54 ms; re-measured
// 2026-10-10 on the same chunk: 5 002.58 ms, 613 tests / 48 files / 25.43 s) with zero
// assertion failures — spawn + store I/O under the chunk's module graph, not a hang: the
// case's own 10 s poll deadline and its `expect(record.status).not.toBe('running')` still
// fire long before this ceiling, so a genuinely wedged reaper is still heard about.
// Sized by the module-graph-budgets rule (per-case work, smallest shared number).
import { MODULE_GRAPH_CASE_BUDGET_MS } from '@nessy-agent/shared/testing/module-graph-budgets'
import { ProcessStore } from './process-store.ts'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_BACKGROUND_SHELL_IDLE_MS,
  parseLinuxProcStatStartTime,
  ProcessSessionDrainError,
  ProcessSupervisor,
  resolveBackgroundShellReaping,
} from './process-supervisor.ts'
import {
  DEFAULT_PROCESS_OUTPUT_CEILING_BYTES,
  PROCESS_MEMORY_PRESSURE_ENV,
  PROCESS_OUTPUT_CEILING_ENV,
  resolveMemoryPressureThresholdPercent,
  resolveProcessOutputCeilingBytes,
} from './process-store.ts'

describe('Pi ProcessSupervisor', () => {
  test('projects bounded owner metadata without log content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x11-process-snapshot-'))
    try {
      const store = new ProcessStore({ root })
      const owner = { workspaceId: 'w', sessionId: 's' }
      await store.create({
        sessionKey: owner, executionId: 'e', semanticId: 'bash', pid: null,
        startedAt: 1, deadlineAt: 2, status: 'running', exitCode: null, signal: null,
        pidStartMarker: null, profile: 'workspace', isolationProfile: 'workspace:test', environmentProfile: 'restricted', environmentDigest: 'digest', cwd: root,
      })
      await store.create({
        sessionKey: owner, executionId: 'newest', semanticId: 'bash', pid: null,
        startedAt: 3, deadlineAt: 4, status: 'running', exitCode: null, signal: null,
        pidStartMarker: null, profile: 'workspace', isolationProfile: 'workspace:test', environmentProfile: 'restricted', environmentDigest: 'digest', cwd: root,
      })
      const supervisor = new ProcessSupervisor({ store })
      const snapshot = await supervisor.snapshot(owner, { limit: 1 })
      expect(snapshot).toHaveLength(1)
      expect(snapshot[0]?.startedAt).toBe(3)
      expect(snapshot[0]).not.toHaveProperty('output')
      expect(await supervisor.snapshot({ workspaceId: 'w', sessionId: 'other' }, { limit: 1 })).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * D12. The record OUTLIVES the process that wrote it: a session resumed in a
   * new host process adopts it, and the Stop hook that then asks what the agent
   * left running reads this field. It is the REQUESTED command line, not the
   * sandbox invocation the isolation plan rewrote it into — an audit needs what
   * the agent asked for, not which wrapper the host chose.
   */
  test('persists the requested command line on the durable record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-d12-command-'))
    try {
      const store = new ProcessStore({ root })
      const supervisor = new ProcessSupervisor({
        store,
        // A plan whose command bears no resemblance to the request, so the
        // assertion cannot pass by accident if the wrong one is recorded.
        resolveIsolation: () => ({
          profile: 'workspace', backend: 'test',
          command: '/usr/bin/sandbox-exec', args: ['-p', '(version 1)', '/bin/sh', '-lc', 'echo hi'],
          environment: {},
        }) as never,
      })
      await supervisor.start({
        sessionKey: { workspaceId: 'w', sessionId: 's' },
        executionId: 'e', semanticId: 'bash_background',
        command: '/bin/sh', args: ['-lc', 'echo hi'],
        cwd: root, workspaceRoot: root,
        profile: 'workspace', background: true, timeoutMs: 5_000,
      })
      const [record] = await store.list({ workspaceId: 'w', sessionId: 's' })
      expect(record?.command).toBe('/bin/sh -lc echo hi')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('binds opaque handles and cursor logs to one SessionKey', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x4a-'))
    try {
      const store = new ProcessStore({ root })
      const supervisor = new ProcessSupervisor({
        store,
        resolveIsolation: input => ({
          command: input.command,
          args: input.args,
          backend: 'test',
          profile: input.profile as Exclude<typeof input.profile, 'none'>,
        }),
      })
      const owner = { workspaceId: 'workspace-a', sessionId: 'session-a' }
      const other = { workspaceId: 'workspace-b', sessionId: 'session-a' }
      const started = await supervisor.start({
        sessionKey: owner,
        executionId: 'exec-1',
        semanticId: 'bash_background',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("hello")'],
        cwd: root,
        workspaceRoot: root,
        profile: 'workspace',
        background: true,
        timeoutMs: 5_000,
      })
      expect(started.handle).toMatch(/^process_/)
      await expect(supervisor.read({ sessionKey: other, handle: started.handle, cursor: 0 }))
        .rejects.toThrow('process-handle-owner-mismatch')
      const output = await supervisor.waitAndRead(owner, started.handle)
      expect(output.output).toBe('hello')
      expect(output.nextCursor).toBe(5)
      expect(output.isRunning).toBe(false)
      expect(output.isolationProfile).toBe('workspace:test')
      expect((await store.get(started.handle)).pidStartMarker).toMatch(/^(linux|darwin):/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('writes one bounded stdin payload and closes the stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-hook-stdin-'))
    try {
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root: join(root, 'store') }),
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
      })
      const base = {
        sessionKey: { workspaceId: 'w', sessionId: 's' }, executionId: 'hook', semanticId: 'plugin-hook',
        command: process.execPath, args: ['-e', 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(s))'],
        cwd: root, workspaceRoot: root, profile: 'workspace' as const, background: false, timeoutMs: 10_000,
      }
      const input = JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'worker' })
      const result = await supervisor.start({ ...base, stdin: 'pipe', stdinData: input })
      expect(result.output).toBe(input)
      expect(result.stdout).toBe(input)
      expect(result.stderr).toBe('')
      const splitStreams = await supervisor.start({
        ...base,
        executionId: 'split-streams',
        args: ['-e', 'process.stderr.write("sandbox warning\\n");process.stdout.write("{\\\"hookSpecificOutput\\\":{\\\"additionalContext\\\":\\\"active\\\"}}")'],
      })
      expect(splitStreams.stdout).toBe('{"hookSpecificOutput":{"additionalContext":"active"}}')
      expect(splitStreams.stderr).toBe('sandbox warning\n')
      expect(splitStreams.output).toContain('sandbox warning')
      expect(splitStreams.output).toContain('hookSpecificOutput')
      const quoteHeavyToolOutput = '"\\\n'.repeat(Math.floor((50 * 1024) / 3))
      const escapedHookPayload = JSON.stringify({ hook_event_name: 'PostToolUse', tool_response: quoteHeavyToolOutput })
      expect(Buffer.byteLength(escapedHookPayload)).toBeGreaterThan(ProcessSupervisor.MAX_STDIN_WRITE_BYTES)
      const expandedInput = await supervisor.start({
        ...base,
        executionId: 'expanded-hook-input',
        args: ['-e', 'let n=0;process.stdin.on("data",d=>n+=d.length);process.stdin.on("end",()=>process.stdout.write(String(n)))'],
        stdin: 'pipe',
        stdinData: escapedHookPayload,
      })
      expect(Number(expandedInput.output)).toBe(Buffer.byteLength(escapedHookPayload))
      const boundaryPayload = 'x'.repeat(ProcessSupervisor.MAX_STDIN_DATA_BYTES)
      const boundaryInput = await supervisor.start({
        ...base,
        executionId: 'max-hook-input',
        args: ['-e', 'let n=0;process.stdin.on("data",d=>n+=d.length);process.stdin.on("end",()=>process.stdout.write(String(n)))'],
        stdin: 'pipe',
        stdinData: boundaryPayload,
      })
      expect(Number(boundaryInput.output)).toBe(ProcessSupervisor.MAX_STDIN_DATA_BYTES)
      const unsafeEnvKey = 'NESSY_PROCESS_SUPERVISOR_UNSAFE_SECRET'
      const previousUnsafeEnv = process.env[unsafeEnvKey]
      process.env[unsafeEnvKey] = 'must-not-leak'
      try {
        const envResult = await supervisor.start({
          ...base,
          executionId: 'allowlisted-env',
          args: ['-e', `process.stdout.write(JSON.stringify({ inherited: process.env.${unsafeEnvKey}, allowed: process.env.NESSY_ALLOWED_HOOK_ENV }))`],
          inheritHostEnv: false,
          env: { NESSY_ALLOWED_HOOK_ENV: 'visible' },
        })
        expect(JSON.parse(envResult.output)).toEqual({ allowed: 'visible' })
      } finally {
        if (previousUnsafeEnv === undefined) delete process.env[unsafeEnvKey]
        else process.env[unsafeEnvKey] = previousUnsafeEnv
      }
      const tempResult = await supervisor.start({
        ...base,
        executionId: 'host-temp',
        args: ['-e', 'const fs=require("node:fs"),os=require("node:os"),p=os.tmpdir();fs.writeFileSync(p+"/probe","ok");process.stdout.write(p)'],
      })
      expect(tempResult.output.startsWith(await realpath(join(root, 'store', 'scratch')))).toBe(true)
      expect(tempResult.output).not.toBe(join(root, 'store', 'scratch'))
      await expect(supervisor.start({ ...base, executionId: 'missing-pipe', stdinData: input }))
        .rejects.toThrow('process-stdin-data-requires-pipe')
      await expect(supervisor.start({ ...base, executionId: 'too-large', stdin: 'pipe', stdinData: 'x'.repeat(ProcessSupervisor.MAX_STDIN_DATA_BYTES + 1) }))
        .rejects.toThrow('process-stdin-data-too-large')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('uses a host-owned isolation environment without exposing it through argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-isolation-env-'))
    try {
      const secret = 'sandbox-secret-must-not-be-an-argument'
      let resolvedArgs: readonly string[] = []
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root: join(root, 'store') }),
        resolveIsolation: input => {
          resolvedArgs = input.args
          return {
            command: input.command,
            args: input.args,
            environment: { NESSY_SANDBOX_SECRET: secret },
            backend: 'test',
            profile: input.profile as Exclude<typeof input.profile, 'none'>,
          }
        },
      })
      const result = await supervisor.start({
        sessionKey: { workspaceId: 'w', sessionId: 's' },
        executionId: 'isolation-env',
        semanticId: 'plugin-mcp',
        command: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.NESSY_SANDBOX_SECRET ?? "missing")'],
        cwd: root,
        workspaceRoot: root,
        profile: 'plugin-mcp',
        background: false,
        timeoutMs: 5_000,
        inheritHostEnv: false,
      })

      expect(result.stdout).toBe(secret)
      expect(resolvedArgs.join(' ')).not.toContain(secret)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('filters credential families by default and binds only environment profile and digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-process-env-'))
    const canaryKeys = [
      'CI_JOB_JWT', 'DATABASE_URL', 'DOCKER_AUTH_CONFIG', 'KUBECONFIG', 'SSH_AUTH_SOCK',
      'AWS_SECRET_ACCESS_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CLIENT_SECRET',
      'NPM_TOKEN', 'GITHUB_TOKEN', 'VAULT_TOKEN', 'REDIS_URL', 'MONGODB_URI',
    ]
    const safeKeys = ['JAVA_HOME', 'LC_ALL', 'NESSY_UV']
    const previous = new Map([...canaryKeys, ...safeKeys].map(key => [key, process.env[key]]))
    for (const key of canaryKeys) process.env[key] = `canary-${key}`
    for (const key of safeKeys) process.env[key] = `safe-${key}`
    try {
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root: join(root, 'store') }),
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
      })
      const base = {
        sessionKey: { workspaceId: 'w', sessionId: 's' }, semanticId: 'bash',
        command: process.execPath, cwd: root, workspaceRoot: root,
        profile: 'workspace' as const, background: false, timeoutMs: 5_000,
      }
      const restricted = await supervisor.start({
        ...base,
        executionId: 'restricted-env',
        args: ['-e', `const keys=${JSON.stringify([...canaryKeys, ...safeKeys])};process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(key=>[key,process.env[key]!==undefined]))))`],
      })
      expect(JSON.parse(restricted.output)).toEqual(Object.fromEntries([
        ...canaryKeys.map(key => [key, false]),
        ...safeKeys.map(key => [key, true]),
      ]))
      expect(restricted.environmentProfile).toBe('restricted')
      expect(restricted.environmentDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify({ profile: restricted.environmentProfile, digest: restricted.environmentDigest })).not.toContain('canary-')

      const trusted = await supervisor.start({
        ...base,
        executionId: 'trusted-env',
        environmentProfile: 'trusted-host',
        args: ['-e', 'process.stdout.write(process.env.CI_JOB_JWT ?? "missing")'],
      })
      expect(trusted.output).toBe('canary-CI_JOB_JWT')
      expect(trusted.environmentProfile).toBe('trusted-host')
      expect(trusted.environmentDigest).not.toBe(restricted.environmentDigest)
      expect(JSON.stringify({ profile: trusted.environmentProfile, digest: trusted.environmentDigest })).not.toContain('canary-')

      const explicit = await supervisor.start({
        ...base,
        executionId: 'explicit-env',
        environmentProfile: 'explicit',
        env: { CI_JOB_JWT: 'explicit-scoped-value' },
        args: ['-e', 'process.stdout.write(process.env.CI_JOB_JWT ?? "missing")'],
      })
      expect(explicit.output).toBe('explicit-scoped-value')

      await expect(supervisor.start({
        ...base,
        executionId: 'profile-conflict',
        environmentProfile: 'explicit',
        inheritHostEnv: false,
      })).rejects.toThrow('process-environment-profile-conflict')
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test('mkdirs and canonicalizes only explicit host writable roots before isolation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-plugin-data-supervisor-'))
    const workspace = join(root, 'workspace')
    const pluginData = join(root, 'managed', 'plugin-data')
    let capturedRoots: readonly string[] | undefined
    try {
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root: join(root, 'store') }),
        resolveIsolation: input => {
          capturedRoots = input.additionalWritableRoots
          return { command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }
        },
      })
      await mkdir(workspace, { recursive: true })
      await supervisor.start({
        sessionKey: { workspaceId: 'w', sessionId: 's' }, executionId: 'plugin-data', semanticId: 'bash',
        command: process.execPath, args: ['-e', ''], cwd: workspace, workspaceRoot: workspace,
        profile: 'workspace', background: false, timeoutMs: 5_000,
        additionalWritableRoots: [pluginData, pluginData],
      })
      expect(capturedRoots).toEqual([await realpath(pluginData)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // `sandboxing.md#configure-sandboxing` (2026-08-25 fetch, 677 lines, md5
  // 3538c3dd04b83d8bbaa35d0fad0ccb88; section anchor rather than a line number
  // because this page's numbers have moved on three consecutive fetches) —
  // `sandbox.filesystem.allowWrite` grants write access to specific paths, and
  // "These paths are enforced at the OS level, so all commands running inside the
  // sandbox, including their child processes, respect them." The
  // host-resolved grant therefore reaches EVERY start, not only the callers who
  // pass a per-request root, and merges with those rather than replacing them.
  test('merges host-resolved writable grants into every isolation plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-host-writable-supervisor-'))
    const workspace = join(root, 'workspace')
    const hostGrant = join(root, 'host', 'build-cache')
    const requestRoot = join(root, 'managed', 'plugin-data')
    const captured: (readonly string[] | undefined)[] = []
    try {
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root: join(root, 'store') }),
        additionalWritableRoots: [hostGrant],
        resolveIsolation: input => {
          captured.push(input.additionalWritableRoots)
          return { command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }
        },
      })
      await mkdir(workspace, { recursive: true })
      const base = {
        sessionKey: { workspaceId: 'w', sessionId: 's' }, semanticId: 'bash',
        command: process.execPath, args: ['-e', ''], cwd: workspace, workspaceRoot: workspace,
        profile: 'workspace' as const, background: false, timeoutMs: 5_000,
      }
      await supervisor.start({ ...base, executionId: 'host-only' })
      await supervisor.start({ ...base, executionId: 'host-plus-request', additionalWritableRoots: [requestRoot] })
      expect(captured[0]).toEqual([await realpath(hostGrant)])
      expect(captured[1]).toEqual([await realpath(hostGrant), await realpath(requestRoot)])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('injects canonical host-owned read denials into every isolation plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-sensitive-root-supervisor-'))
    const workspace = join(root, 'workspace')
    const credentialFile = join(root, 'config', 'credentials.enc')
    let capturedRoots: readonly string[] | undefined
    try {
      await mkdir(workspace, { recursive: true })
      await mkdir(dirname(credentialFile), { recursive: true })
      await writeFile(credentialFile, 'encrypted')
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root: join(root, 'store') }),
        deniedReadRoots: [credentialFile],
        resolveIsolation: input => {
          capturedRoots = input.deniedReadRoots
          return { command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }
        },
      })
      await supervisor.start({
        sessionKey: { workspaceId: 'w', sessionId: 's' }, executionId: 'sensitive-root', semanticId: 'bash',
        command: process.execPath, args: ['-e', ''], cwd: workspace, workspaceRoot: workspace,
        profile: 'workspace', background: false, timeoutMs: 5_000,
      })
      // The PAIR, not just the canonical form: `denyRootPair` keeps the path as
      // written alongside its symlink target (`sandboxing.md#protected-paths`),
      // so on a host whose temp root is itself a link both spellings appear. De-duplicated
      // here so the assertion states the contract on either kind of host.
      expect(capturedRoots).toEqual([...new Set([credentialFile, await realpath(credentialFile)])])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // `settings-reference.md#sandbox-filesystem-denywrite` — "Claude Code merges
  // entries across every settings scope the session loads, and adds the paths
  // from your `Edit(...)` deny permission rules." It travels on its own key so an
  // edit deny never also removes reads.
  test('injects canonical host-owned write denials into every isolation plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-write-deny-supervisor-'))
    const workspace = join(root, 'workspace')
    const protectedDir = join(root, 'shared', 'protected')
    let captured: { read?: readonly string[]; write?: readonly string[] } = {}
    try {
      await mkdir(workspace, { recursive: true })
      await mkdir(protectedDir, { recursive: true })
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root: join(root, 'store') }),
        deniedWriteRoots: [protectedDir],
        resolveIsolation: input => {
          captured = { read: input.deniedReadRoots, write: input.deniedWriteRoots }
          return { command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }
        },
      })
      await supervisor.start({
        sessionKey: { workspaceId: 'w', sessionId: 's' }, executionId: 'write-deny', semanticId: 'bash',
        command: process.execPath, args: ['-e', ''], cwd: workspace, workspaceRoot: workspace,
        profile: 'workspace', background: false, timeoutMs: 5_000,
      })
      expect(captured.write).toEqual([...new Set([protectedDir, await realpath(protectedDir)])])
      expect(captured.read).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('carries the managed egress deny into every isolation plan, and nothing when it is off', async () => {
    // The supervisor is the only place every sandboxed command passes through,
    // so it is the only place `sandbox.network` can reach one. Both directions
    // are asserted: an unset host must produce the identical input it produced
    // before this option existed.
    const root = await mkdtemp(join(tmpdir(), 'nessy-egress-supervisor-'))
    const workspace = join(root, 'workspace')
    const captured: (boolean | undefined)[] = []
    try {
      await mkdir(workspace, { recursive: true })
      const run = async (denyNetworkEgress: boolean | undefined, executionId: string): Promise<void> => {
        const supervisor = new ProcessSupervisor({
          store: new ProcessStore({ root: join(root, `store-${executionId}`) }),
          ...(denyNetworkEgress === undefined ? {} : { denyNetworkEgress }),
          resolveIsolation: input => {
            captured.push(input.denyNetworkEgress)
            return { command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }
          },
        })
        await supervisor.start({
          sessionKey: { workspaceId: 'w', sessionId: 's' }, executionId, semanticId: 'bash',
          command: process.execPath, args: ['-e', ''], cwd: workspace, workspaceRoot: workspace,
          profile: 'networked', background: false, timeoutMs: 5_000,
        })
      }
      await run(undefined, 'egress-default')
      await run(false, 'egress-open')
      await run(true, 'egress-denied')
      expect(captured).toEqual([undefined, undefined, true])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('tolerates a credential deny path that does not exist on this machine', async () => {
    // The seeded list names `~/.aws` and the shared gateway JWT, neither of which
    // every machine has. Canonicalisation falls back to the nearest EXISTING
    // ancestor's realpath with the missing tail re-appended; if that tolerance
    // ever regressed, a user with no `~/.aws` would have every process spawn fail.
    const root = await mkdtemp(join(tmpdir(), 'nessy-missing-deny-root-'))
    const workspace = join(root, 'workspace')
    const home = join(root, 'home')
    const missing = join(home, '.aws')
    let capturedRoots: readonly string[] | undefined
    try {
      await mkdir(workspace, { recursive: true })
      await mkdir(home, { recursive: true })
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root: join(root, 'store') }),
        deniedReadRoots: [missing],
        resolveIsolation: input => {
          capturedRoots = input.deniedReadRoots
          return { command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }
        },
      })
      const started = await supervisor.start({
        sessionKey: { workspaceId: 'w', sessionId: 's' }, executionId: 'missing-deny-root', semanticId: 'bash',
        command: process.execPath, args: ['-e', 'process.stdout.write("spawned")'], cwd: workspace, workspaceRoot: workspace,
        profile: 'workspace', background: false, timeoutMs: 5_000,
      })
      expect(capturedRoots).toEqual([...new Set([missing, join(await realpath(home), '.aws')])])
      expect((await supervisor.waitAndRead({ workspaceId: 'w', sessionId: 's' }, started.handle)).output).toBe('spawned')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('plugin MCP allows only managed data writes and denies bundle/sibling writes on macOS', async () => {
    if (process.platform !== 'darwin') return
    const root = await mkdtemp(join(tmpdir(), 'nessy-plugin-data-isolation-'))
    const workspace = join(root, 'workspace')
    const pluginData = join(root, 'managed', 'honey')
    const siblingData = join(root, 'managed', 'other')
    try {
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(pluginData, { recursive: true }),
        mkdir(siblingData, { recursive: true }),
      ])
      const supervisor = new ProcessSupervisor({ store: new ProcessStore({ root: join(root, 'store') }) })
      const base = {
        sessionKey: { workspaceId: 'w', sessionId: 's' }, semanticId: 'bash',
        command: '/bin/sh', cwd: workspace, workspaceRoot: workspace,
        profile: 'plugin-mcp' as const, background: false, timeoutMs: 10_000,
        inheritHostEnv: false,
        additionalWritableRoots: [pluginData],
      }
      const allowed = await supervisor.start({
        ...base,
        executionId: 'plugin-data-allowed',
        args: ['-c', 'printf ok > "$CLAUDE_CONFIG_DIR/state"'],
        env: { CLAUDE_CONFIG_DIR: pluginData },
      })
      expect(allowed.exitCode).toBe(0)
      await access(join(pluginData, 'state'))

      const denied = await supervisor.start({
        ...base,
        executionId: 'plugin-data-denied',
        args: ['-c', 'printf bad > "$CLAUDE_CONFIG_DIR/state"'],
        env: { CLAUDE_CONFIG_DIR: siblingData },
      })
      expect(denied.exitCode).not.toBe(0)
      await expect(access(join(siblingData, 'state'))).rejects.toThrow()

      const bundleDenied = await supervisor.start({
        ...base,
        executionId: 'plugin-bundle-denied',
        args: ['-c', 'printf bad > "$PWD/cache-state"'],
      })
      expect(bundleDenied.exitCode).not.toBe(0)
      await expect(access(join(workspace, 'cache-state'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('runs the integrity gate before spawn and streams persistent stdout until idempotent stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-plugin-mcp-supervisor-'))
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      const supervisor = new ProcessSupervisor({
        store,
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
      })
      const base = {
        sessionKey: { workspaceId: 'w', sessionId: 'mcp-pool:test' },
        semanticId: 'plugin-mcp-stdio', command: process.execPath, cwd: root, workspaceRoot: root,
        profile: 'plugin-mcp' as const, background: true, persistent: true, timeoutMs: 0, stdin: 'pipe' as const,
      }
      const spawnMarker = join(root, 'spawned')
      await expect(supervisor.start({
        ...base, executionId: 'hash-failed', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(spawnMarker)},'yes')`],
        beforeStart: async () => { throw new Error('hash-mismatch') },
      })).rejects.toThrow('hash-mismatch')
      await expect(access(spawnMarker)).rejects.toThrow()

      const stdout: Buffer[] = []
      let resolveStdout!: () => void
      const stdoutReceived = new Promise<void>(resolve => { resolveStdout = resolve })
      let closes = 0
      const started = await supervisor.start({
        ...base,
        executionId: 'persistent',
        args: ['-e', 'process.stdin.on("data",d=>{const s=d.toString();if(s==="ping\\n")process.stdout.write("ready\\n");if(s==="quit\\n")process.exit(0)})'],
        beforeStart: async () => {},
        persistOutput: false,
        onStdout: chunk => {
          stdout.push(Buffer.from(chunk))
          resolveStdout()
        },
        onClose: () => { closes++ },
      })
      await supervisor.write({ sessionKey: base.sessionKey, handle: started.handle, data: 'ping\n' })
      let stdoutTimeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          stdoutReceived,
          new Promise<never>((_, reject) => {
            stdoutTimeout = setTimeout(
              () => reject(new Error('persistent process stdout was not observed within 2000ms')),
              2_000,
            )
          }),
        ])
      } finally {
        if (stdoutTimeout) clearTimeout(stdoutTimeout)
      }
      const active = await supervisor.read({ sessionKey: base.sessionKey, handle: started.handle })
      expect(active.isRunning).toBe(true)
      expect(active.output).toBe('')
      expect(active.nextCursor).toBe(0)
      expect(Buffer.concat(stdout).toString()).toBe('ready\n')
      expect((await stat(join(root, 'store'))).mode & 0o777).toBe(0o700)
      expect((await stat(join(root, 'store', `${started.handle}.log`))).mode & 0o777).toBe(0o600)
      await supervisor.write({ sessionKey: base.sessionKey, handle: started.handle, data: 'quit\n' })
      await supervisor.stop({ sessionKey: base.sessionKey, handle: started.handle })
      await supervisor.stop({ sessionKey: base.sessionKey, handle: started.handle })
      expect(closes).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * F1.1207 harnesses. The window the row measures — a stop whose decision
   * block runs between `ProcessStore.create` and the spawn — is invisible from
   * outside `start()`, so both hold it open from inside the store: one reports
   * the handle the moment the record exists (the stop is then awaited from
   * `beforeStart`, whose await sits between create and spawn), the other keeps
   * `create` itself unresolved after the record is written (the stop then lands
   * while the record exists but `start()` has not been handed it yet).
   */
  class HandleCaptureStore extends ProcessStore {
    captured: string | undefined
    override async create(...args: Parameters<ProcessStore['create']>) {
      const record = await super.create(...args)
      this.captured = record.handle
      return record
    }
  }

  class GatedCreateStore extends HandleCaptureStore {
    private gateResolve: (() => void) | undefined
    private readonly gate = new Promise<void>(resolve => { this.gateResolve = resolve })
    openGate(): void { this.gateResolve?.() }
    override async create(...args: Parameters<ProcessStore['create']>) {
      const record = await super.create(...args)
      await this.gate
      return record
    }
  }

  /**
   * F1.1207 — the stop half of the window. A stop landing here used to fall
   * through to `stopRecovered`, which marked the never-started record `lost`
   * and threw `process-recovery-identity-mismatch` — and `start()` then spawned
   * the child anyway: alive, owned by nobody, and unreachable by a second stop
   * (which returns on a non-`running` record without signalling anything). The
   * stop must instead consume the admission, settle the record `stopped`, and
   * the start must refuse the spawn — the same shape the abort-signal
   * admission one case above already has.
   */
  test('refuses to spawn when a stop lands while beforeStart is pending (F1.1207)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-f11207-beforestart-stop-'))
    const sessionKey = { workspaceId: 'w', sessionId: 's' }
    try {
      const store = new HandleCaptureStore({ root: join(root, 'store') })
      let spawnCalls = 0
      const supervisor = new ProcessSupervisor({
        store,
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
        spawnProcess: (() => {
          spawnCalls += 1
          throw new Error('unexpected-spawn')
        }) as typeof spawn,
      })
      const starting = supervisor.start({
        sessionKey, executionId: 'stop-before-spawn', semanticId: 'bash', command: process.execPath, args: ['-e', ''],
        cwd: root, workspaceRoot: root, profile: 'workspace', background: true, timeoutMs: 5_000,
        beforeStart: async () => {
          // The window: the record exists, the child does not.
          await supervisor.stop({ sessionKey, handle: store.captured! })
        },
      })
      const result = await starting
      expect(spawnCalls).toBe(0)
      expect(await store.list(sessionKey)).toMatchObject([{ status: 'stopped', pid: null }])
      expect(result.isRunning).toBe(false)
      expect(await supervisor.drainSession(sessionKey)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * F1.1207 — the other half of the same window: the stop lands while `create`
   * is still settling (CI-k3's probe widened exactly this call), so no
   * admission latch is armed yet and the stop goes down `stopRecovered` —
   * `lost` plus its throw, which THIS window keeps (the record carries no
   * recoverable identity). What must change is the spawn: the final admission
   * re-read of the record sees a terminal status and the start refuses, then
   * repairs the never-started record to `stopped` — a `lost` record with a
   * null pid can never be proven gone, so it would wedge a strict drain for
   * ever (the UA12.153 residual half).
   */
  test('refuses to spawn when a stop lands while create is still settling (F1.1207)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-f11207-create-stop-'))
    const sessionKey = { workspaceId: 'w', sessionId: 's' }
    try {
      const store = new GatedCreateStore({ root: join(root, 'store') })
      let spawnCalls = 0
      const supervisor = new ProcessSupervisor({
        store,
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
        spawnProcess: ((...args: Parameters<typeof spawn>) => {
          spawnCalls += 1
          return spawn(...args)
        }) as typeof spawn,
      })
      const starting = supervisor.start({
        sessionKey, executionId: 'stop-during-create', semanticId: 'bash', command: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(0), 2000)'],
        cwd: root, workspaceRoot: root, profile: 'workspace', background: true, timeoutMs: 5_000,
      })
      // Marked handled the moment it exists (the same shape as the
      // close-finalization case below): an unhandled `starting` rejection would
      // otherwise be reported against whichever test follows.
      void starting.catch(() => {})
      let handle = ''
      for (let attempt = 0; attempt < 500 && !handle; attempt++) {
        handle = store.captured ?? ''
        if (!handle) await new Promise(resolve => setTimeout(resolve, 2))
      }
      let stopError: unknown
      await supervisor.stop({ sessionKey, handle }).then(() => undefined, error => { stopError = error })
      // The stop caller's throw is this window's stated residue: with no
      // admission armed, the record has no recoverable identity to stop by.
      expect(String(stopError)).toContain('process-recovery-identity-mismatch')
      store.openGate()
      const result = await starting
      expect(spawnCalls).toBe(0)
      expect(await store.list(sessionKey)).toMatchObject([{ status: 'stopped', pid: null }])
      expect(result.isRunning).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('terminalizes a process admission aborted while beforeStart is pending without spawning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-process-abort-admission-'))
    const sessionKey = { workspaceId: 'w', sessionId: 's' }
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      let beforeStartEntered!: () => void
      let releaseBeforeStart!: () => void
      const beforeStartStarted = new Promise<void>(resolve => { beforeStartEntered = resolve })
      const beforeStartGate = new Promise<void>(resolve => { releaseBeforeStart = resolve })
      let spawnCalls = 0
      const supervisor = new ProcessSupervisor({
        store,
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
        spawnProcess: (() => {
          spawnCalls += 1
          throw new Error('unexpected-spawn')
        }) as typeof spawn,
      })
      const controller = new AbortController()
      const starting = supervisor.start({
        sessionKey, executionId: 'cancelled-admission', semanticId: 'bash', command: process.execPath, args: ['-e', ''],
        cwd: root, workspaceRoot: root, profile: 'workspace', background: true, timeoutMs: 5_000, signal: controller.signal,
        beforeStart: async () => {
          beforeStartEntered()
          await beforeStartGate
        },
      })
      await beforeStartStarted
      controller.abort()
      releaseBeforeStart()

      const result = await starting
      expect(result.isRunning).toBe(false)
      expect(spawnCalls).toBe(0)
      expect(await store.list(sessionKey)).toMatchObject([{ status: 'stopped', pid: null }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * P2.139. `keepSemanticIds` has to be honoured in BOTH halves of the drain.
   * Not signalling the record is useless on its own: the drain re-lists after
   * stopping and throws `ProcessSessionDrainError` for anything still `running`,
   * so a record deliberately left alive would report itself as this drain's own
   * failure — and under a strict teardown, fail the operation that spared it.
   */
  test('keeps an exempted semanticId running and does not count it as a residual', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p2139-drain-keep-'))
    try {
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root }),
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
      })
      const sessionKey: SessionKey = { workspaceId: 'workspace-keep', sessionId: 'session-keep' }
      const start = (semanticId: string, executionId: string) => supervisor.start({
        sessionKey,
        executionId,
        semanticId,
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        workspaceRoot: root,
        profile: 'workspace',
        background: true,
        timeoutMs: 10_000,
      })
      const watch = await start('monitor', 'exec-monitor')
      const shell = await start('bash_background', 'exec-shell')

      // The exempted record is neither stopped nor reported: the drain resolves
      // (no `ProcessSessionDrainError`) naming only the record it took.
      expect(await supervisor.drainSession(sessionKey, { keepSemanticIds: ['monitor'] })).toEqual([shell.handle])
      expect((await supervisor.read({ sessionKey, handle: watch.handle })).isRunning).toBe(true)

      // The boundary: same record, same drain, no exemption — it goes.
      expect(await supervisor.drainSession(sessionKey)).toEqual([watch.handle])
      expect((await supervisor.read({ sessionKey, handle: watch.handle })).isRunning).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('stop is idempotent and drains only the selected session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x4a-'))
    try {
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root }),
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
      })
      const sessionKey = { workspaceId: 'workspace-a', sessionId: 'session-a' }
      const other = { workspaceId: 'workspace-b', sessionId: 'session-b' }
      const start = (owner: typeof sessionKey, executionId: string) => supervisor.start({
        sessionKey: owner,
        executionId,
        semanticId: 'bash_background',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        workspaceRoot: root,
        profile: 'workspace',
        background: true,
        timeoutMs: 10_000,
      })
      const started = await start(sessionKey, 'exec-2')
      const otherStarted = await start(other, 'exec-3')
      await supervisor.stop({ sessionKey, handle: started.handle })
      await supervisor.stop({ sessionKey, handle: started.handle })
      expect(await supervisor.drainSession(sessionKey)).toEqual([])
      expect((await supervisor.read({ sessionKey: other, handle: otherStarted.handle })).isRunning).toBe(true)
      await supervisor.stop({ sessionKey: other, handle: otherStarted.handle })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * P2.523 — the host half: the list beside the count is FREE, and scoped the
   * same way.
   *
   * `countRunning` is `.length` over `ProcessStore.listRunning`'s body, so a
   * caller that wants the records pays no second walk. The claim is asserted as
   * an AGREEMENT on one rig rather than as a cost measurement: the two answers
   * come from the same index, for the same `SessionKey`, at the same moment.
   * The cross-session row is the control — without it "the list agrees with the
   * count" would also hold for a global list.
   */
  test('listRunning returns exactly what countRunning counted, per session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p2523-supervisor-'))
    try {
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root }),
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
      })
      const sessionKey: SessionKey = { workspaceId: 'workspace-a', sessionId: 'session-a' }
      const other: SessionKey = { workspaceId: 'workspace-b', sessionId: 'session-b' }
      const start = (key: SessionKey, executionId: string) => supervisor.start({
        sessionKey: key,
        executionId,
        semanticId: 'bash_background',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        workspaceRoot: root,
        profile: 'workspace',
        background: true,
        timeoutMs: 10_000,
      })

      expect(await supervisor.listRunning(sessionKey)).toEqual([])
      const mine = await start(sessionKey, 'exec-mine')
      const theirs = await start(other, 'exec-theirs')

      const listed = await supervisor.listRunning(sessionKey)
      expect(listed.map(record => record.executionId)).toEqual(['exec-mine'])
      expect(listed).toHaveLength(await supervisor.countRunning(sessionKey))
      // The record really is a record, not a bare handle — this is what the
      // settlement projects, so an empty projection would pass the length row.
      expect(listed[0]).toMatchObject({ handle: mine.handle, status: 'running', semanticId: 'bash_background' })

      // THE CONTROL: scoped, not global. Without it the agreement above holds
      // just as well for a list that ignores the SessionKey.
      expect((await supervisor.listRunning(other)).map(record => record.executionId)).toEqual(['exec-theirs'])

      await supervisor.stop({ sessionKey, handle: mine.handle })
      expect(await supervisor.listRunning(sessionKey)).toEqual([])
      expect(await supervisor.listRunning(other)).toHaveLength(await supervisor.countRunning(other))

      await supervisor.stop({ sessionKey: other, handle: theirs.handle })
      expect(await supervisor.listRunning(other)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * P2.22. The settlement's question is "does this session still have a process
   * running", and it used to answer it by reading every record in the global
   * store. `countRunning` answers it from the durable running index instead, and
   * the property that makes that legal is asserted against a REAL child rather
   * than a hand-written record: the count has to come back down through the
   * supervisor's own close handler, which is the only exit signal the host has.
   */
  test('counts a session\'s running processes and comes back down when one ends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p222-supervisor-'))
    try {
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root }),
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
      })
      const sessionKey: SessionKey = { workspaceId: 'workspace-a', sessionId: 'session-a' }
      const other: SessionKey = { workspaceId: 'workspace-b', sessionId: 'session-b' }
      const start = (key: SessionKey, executionId: string) => supervisor.start({
        sessionKey: key,
        executionId,
        semanticId: 'bash_background',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        workspaceRoot: root,
        profile: 'workspace',
        background: true,
        timeoutMs: 10_000,
      })

      expect(await supervisor.countRunning(sessionKey)).toBe(0)
      const mine = await start(sessionKey, 'exec-mine')
      const theirs = await start(other, 'exec-theirs')

      expect(await supervisor.countRunning(sessionKey)).toBe(1)
      // Scoped, not global: the other session's live child is not this
      // session's reason to stay unsettled.
      expect(await supervisor.countRunning(other)).toBe(1)

      await supervisor.stop({ sessionKey, handle: mine.handle })
      expect(await supervisor.countRunning(sessionKey)).toBe(0)
      expect(await supervisor.countRunning(other)).toBe(1)

      await supervisor.stop({ sessionKey: other, handle: theirs.handle })
      expect(await supervisor.countRunning(other)).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects traversal handles and symlink cwd escapes before spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x4a-'))
    const outside = await mkdtemp(join(tmpdir(), 'nessy-x4a-outside-'))
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      await expect(store.get('../escape')).rejects.toThrow('invalid-process-handle')
      await symlink(outside, join(root, 'escape'))
      const supervisor = new ProcessSupervisor({ store, resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }) })
      await expect(supervisor.start({
        sessionKey: { workspaceId: 'w', sessionId: 's' }, executionId: 'e', semanticId: 'bash',
        command: process.execPath, args: ['-e', ''], cwd: join(root, 'escape'), workspaceRoot: root,
        profile: 'workspace', background: false, timeoutMs: 100,
      })).rejects.toThrow('process-working-directory-outside-workspace')
    } finally {
      await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true })
    }
  })

  test('serializes concurrent log quota rollover and cursor accounting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x4a-'))
    try {
      const store = new ProcessStore({ root, maxLogBytes: 5 })
      const record = await store.create({
        sessionKey: { workspaceId: 'w', sessionId: 's' }, executionId: 'e', semanticId: 'bash', pid: null,
        pidStartMarker: null, startedAt: 1, deadlineAt: 2, status: 'running', exitCode: null, signal: null,
        profile: 'workspace', isolationProfile: 'workspace:test', environmentProfile: 'restricted', environmentDigest: 'digest', cwd: root,
      })
      await Promise.all([store.append(record.handle, 'abc'), store.append(record.handle, 'def')])
      // P3.320 — this row used to read `{ output: 'bcdef', nextCursor: 6 }`, and
      // that WAS the defect in miniature: the ring had dropped the 'a' and the
      // result said nothing, so a reader could not tell 'bcdef' from the whole
      // output. The bytes are unchanged; what is new is the notice in front of
      // them, and the numbers in it are the ones a reader needs to judge how
      // much is gone.
      const rolled = await store.readLog(record.handle, 0)
      expect(rolled.nextCursor).toBe(6)
      expect(rolled.output).toBe(
        '[earlier output dropped: 1 of 6 bytes produced; this result holds the last 5 bytes.'
        + ' Raise NESSY_BASH_MAX_OUTPUT_LENGTH (or BASH_MAX_OUTPUT_LENGTH) to keep more.]\nbcdef',
      )
      expect((await store.get(record.handle)).baseCursor).toBe(1)
      const pending = store.append(record.handle, 'ghi')
      // THE CONTROL, and the reason the notice is keyed on `cursor < baseCursor`
      // rather than on `baseCursor > 0`: a follower still inside the window lost
      // nothing, so it is handed byte-identical output to before this row.
      expect(await store.readLog(record.handle, 6)).toEqual({ output: 'ghi', nextCursor: 9 })
      await pending

      await Promise.all([
        store.update(record.handle, { pidStartMarker: 'marker' }),
        store.update(record.handle, { status: 'exited', exitCode: 0 }),
        store.update(record.handle, { baseCursor: 4, nextCursor: 9 }),
      ])
      expect(await store.get(record.handle)).toMatchObject({
        pidStartMarker: 'marker', status: 'exited', exitCode: 0, baseCursor: 4, nextCursor: 9,
      })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('parses Linux start time after a parenthesized command containing spaces', () => {
    const fields = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), '987654', 'after']
    expect(parseLinuxProcStatStartTime(`123 (command with ) spaces) ${fields.join(' ')}`)).toBe('987654')
  })

  test('turns spawn and identity acquisition failures into one durable lost state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x4a-'))
    const sessionKey = { workspaceId: 'w', sessionId: 's' }
    try {
      const spawnStore = new ProcessStore({ root: join(root, 'spawn') })
      const spawnFailure = new ProcessSupervisor({
        store: spawnStore,
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
        spawnProcess: (() => { throw new Error('spawn-failed') }) as typeof import('node:child_process').spawn,
      })
      await expect(spawnFailure.start({
        sessionKey, executionId: 'spawn', semanticId: 'bash', command: process.execPath, args: ['-e', ''],
        cwd: root, workspaceRoot: root, profile: 'workspace', background: false, timeoutMs: 100,
      })).rejects.toThrow('spawn-failed')
      expect((await spawnStore.list(sessionKey)).map(record => record.status)).toEqual(['lost'])

      const markerStore = new ProcessStore({ root: join(root, 'marker') })
      const markerFailure = new ProcessSupervisor({
        store: markerStore,
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
        readPidStartMarker: async () => { throw new Error('marker-failed') },
      })
      await expect(markerFailure.start({
        sessionKey, executionId: 'marker', semanticId: 'bash', command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, workspaceRoot: root,
        profile: 'workspace', background: false, timeoutMs: 100,
      })).rejects.toThrow('marker-failed')
      expect((await markerStore.list(sessionKey)).map(record => record.status)).toEqual(['lost'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('keeps an in-memory Windows child usable without weakening recovery identity checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-windows-process-'))
    const sessionKey = { workspaceId: 'w', sessionId: 's' }
    try {
      const store = new ProcessStore({ root: join(root, 'store') })
      const supervisor = new ProcessSupervisor({
        store,
        platform: 'win32',
        runWindowsTaskkill: args => {
          process.kill(Number(args[1]), args.includes('/F') ? 'SIGKILL' : 'SIGTERM')
        },
        resolveIsolation: input => ({
          command: input.command,
          args: input.args,
          backend: 'test',
          profile: input.profile as Exclude<typeof input.profile, 'none'>,
        }),
      })
      const started = await supervisor.start({
        sessionKey,
        executionId: 'windows-owned',
        semanticId: 'plugin-mcp',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        workspaceRoot: root,
        profile: 'plugin-mcp',
        background: true,
        timeoutMs: 5_000,
      })
      expect(started.isRunning).toBe(true)
      expect((await store.get(started.handle)).pidStartMarker).toBeNull()
      await supervisor.stop({ sessionKey, handle: started.handle })
      expect((await store.get(started.handle)).status).toBe('stopped')

      const recovered = new ProcessSupervisor({ store, platform: 'win32' })
      await store.update(started.handle, { status: 'running' })
      await expect(recovered.read({ sessionKey, handle: started.handle }))
        .rejects.toThrow('process-recovery-identity-mismatch')
      expect((await store.get(started.handle)).status).toBe('lost')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('drains a running process recovered from the durable session store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-recovered-process-drain-'))
    const sessionKey = { workspaceId: 'w', sessionId: 'cold-session' }
    const store = new ProcessStore({ root: join(root, 'store') })
    const owner = new ProcessSupervisor({
      store,
      graceMs: 50,
      resolveIsolation: input => ({
        command: input.command,
        args: input.args,
        backend: 'test',
        profile: input.profile as Exclude<typeof input.profile, 'none'>,
      }),
    })
    let handle: string | undefined
    try {
      handle = (await owner.start({
        sessionKey,
        executionId: 'cold-running',
        semanticId: 'bash',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        workspaceRoot: root,
        profile: 'workspace',
        background: true,
        persistent: true,
        timeoutMs: 5_000,
      })).handle
      expect((await store.get(handle)).pidStartMarker).toBeTruthy()

      const recovered = new ProcessSupervisor({ store, graceMs: 50 })
      await expect(recovered.drainSession(sessionKey)).resolves.toEqual([handle])
      expect((await store.get(handle)).status).toBe('stopped')
      expect((await recovered.snapshot(sessionKey)).some(process => process.status === 'running')).toBe(false)
    } finally {
      if (handle && (await store.get(handle).catch(() => undefined))?.status === 'running') {
        await owner.stop({ sessionKey, handle }).catch(() => undefined)
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test('terminates the complete Windows wrapper tree and escalates when graceful taskkill fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-windows-tree-'))
    const sessionKey = { workspaceId: 'w', sessionId: 's' }
    let child: ReturnType<typeof spawn> | undefined
    const taskkillArgs: string[][] = []
    try {
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root: join(root, 'store') }),
        platform: 'win32',
        graceMs: 10,
        resolveIsolation: input => ({
          command: input.command,
          args: input.args,
          backend: 'test',
          profile: input.profile as Exclude<typeof input.profile, 'none'>,
        }),
        spawnProcess: ((command, args, options) => {
          child = spawn(command, args ?? [], options ?? {})
          return child
        }) as typeof spawn,
        runWindowsTaskkill: args => {
          taskkillArgs.push([...args])
          if (!args.includes('/F')) throw new Error('graceful-taskkill-unavailable')
          child?.kill('SIGKILL')
        },
      })
      const started = await supervisor.start({
        sessionKey,
        executionId: 'windows-tree',
        semanticId: 'plugin-mcp',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        workspaceRoot: root,
        profile: 'plugin-mcp',
        background: true,
        timeoutMs: 5_000,
      })

      await supervisor.stop({ sessionKey, handle: started.handle })

      expect(taskkillArgs).toEqual([
        ['/PID', String(child?.pid), '/T'],
        ['/PID', String(child?.pid), '/T', '/F'],
      ])
      expect((await supervisor.read({ sessionKey, handle: started.handle })).isRunning).toBe(false)
    } finally {
      child?.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not report a Windows process stopped when taskkill cannot terminate its tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-windows-tree-failure-'))
    const sessionKey = { workspaceId: 'w', sessionId: 's' }
    const store = new ProcessStore({ root: join(root, 'store') })
    let child: ReturnType<typeof spawn> | undefined
    try {
      const supervisor = new ProcessSupervisor({
        store,
        platform: 'win32',
        graceMs: 10,
        resolveIsolation: input => ({
          command: input.command,
          args: input.args,
          backend: 'test',
          profile: input.profile as Exclude<typeof input.profile, 'none'>,
        }),
        spawnProcess: ((command, args, options) => {
          child = spawn(command, args ?? [], options ?? {})
          return child
        }) as typeof spawn,
        runWindowsTaskkill: () => { throw new Error('taskkill-failed') },
      })
      const started = await supervisor.start({
        sessionKey,
        executionId: 'windows-tree-failure',
        semanticId: 'plugin-mcp',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        workspaceRoot: root,
        profile: 'plugin-mcp',
        background: true,
        timeoutMs: 5_000,
      })

      await expect(supervisor.stop({ sessionKey, handle: started.handle }))
        .rejects.toThrow('process-tree-termination-failed')
      expect((await store.get(started.handle)).status).toBe('running')
      const closed = new Promise<void>(resolve => child?.once('close', () => resolve()))
      child?.kill('SIGKILL')
      await closed
      for (let attempt = 0; attempt < 50 && (await store.get(started.handle)).status === 'running'; attempt++) {
        await Bun.sleep(10)
      }
      expect((await store.get(started.handle)).status).toBe('exited')
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          child?.once('close', () => resolve())
          child?.kill('SIGKILL')
        })
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test('preserves a fast observed exit when recovery marker lookup loses the race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x4a-'))
    try {
      const store = new ProcessStore({ root })
      const supervisor = new ProcessSupervisor({
        store,
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
        readPidStartMarker: async () => { await new Promise(resolve => setTimeout(resolve, 20)); throw new Error('already-exited') },
      })
      const result = await supervisor.start({
        sessionKey: { workspaceId: 'w', sessionId: 's' }, executionId: 'fast', semanticId: 'find',
        command: process.execPath, args: ['-e', ''], cwd: root, workspaceRoot: root,
        profile: 'read-only', background: false, timeoutMs: 1000,
      })
      expect(result.exitCode).toBe(0)
      expect((await store.get(result.handle)).status).toBe('exited')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('does not return a running background handle when abort or deadline wins during marker admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x4a-'))
    const sessionKey = { workspaceId: 'w', sessionId: 's' }
    try {
      let releaseAbortMarker!: (value: string) => void
      const abortMarker = new Promise<string>(resolve => { releaseAbortMarker = resolve })
      const abortStore = new ProcessStore({ root: join(root, 'abort') })
      const abortSupervisor = new ProcessSupervisor({
        store: abortStore,
        graceMs: 10,
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
        readPidStartMarker: () => abortMarker,
      })
      const controller = new AbortController()
      const aborting = abortSupervisor.start({
        sessionKey, executionId: 'abort-admission', semanticId: 'bash_background', command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, workspaceRoot: root,
        profile: 'workspace', background: true, timeoutMs: 5_000, signal: controller.signal,
      })
      await Bun.sleep(5)
      controller.abort()
      releaseAbortMarker('marker')
      const aborted = await aborting
      expect(aborted.isRunning).toBe(false)
      expect((await abortStore.get(aborted.handle)).status).toBe('stopped')

      const deadlineStore = new ProcessStore({ root: join(root, 'deadline') })
      const deadlineSupervisor = new ProcessSupervisor({
        store: deadlineStore,
        graceMs: 10,
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
        readPidStartMarker: async () => { await Bun.sleep(50); return 'marker' },
      })
      const timedOut = await deadlineSupervisor.start({
        sessionKey, executionId: 'deadline-admission', semanticId: 'bash_background', command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, workspaceRoot: root,
        profile: 'workspace', background: true, timeoutMs: 5,
      })
      expect(timedOut.isRunning).toBe(false)
      expect((await deadlineStore.get(timedOut.handle)).status).toBe('timed-out')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('awaits close finalization instead of marking an already-removed child lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x4a-'))
    let releaseFlush!: () => void
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    let ownerReads = 0
    class SlowFlushStore extends ProcessStore {
      override async flush(handle: string): Promise<void> { await flushGate; await super.flush(handle) }
      // The instrument for the release ordering below, and nothing else: it
      // counts the reads, it does not change what any caller sees.
      override async assertOwner(sessionKey: SessionKey, handle: string) {
        const record = await super.assertOwner(sessionKey, handle)
        ownerReads += 1
        return record
      }
    }
    try {
      const store = new SlowFlushStore({ root })
      const supervisor = new ProcessSupervisor({ store, resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }) })
      const sessionKey = { workspaceId: 'w', sessionId: 's' }
      const starting = supervisor.start({
        sessionKey, executionId: 'close-race', semanticId: 'find', command: process.execPath, args: ['-e', ''],
        cwd: root, workspaceRoot: root, profile: 'read-only', background: true, timeoutMs: 1000,
      })
      // Marked handled the moment it exists. `starting` is awaited at the END of
      // this case, so ANY failure above that line abandons it — and its own
      // rejection (an ENOENT, once the `finally` below removes the store root
      // from under the in-flight start) was then reported by bun as a failure of
      // the NEXT test in this file, `append failure remains lost after process
      // close`. That case is green 2/2 alone; it was never broken. Attaching a
      // handler swallows nothing: the `await starting` below still sees it.
      void starting.catch(() => {})
      let handle = ''
      for (let attempt = 0; attempt < 50 && !handle; attempt++) {
        handle = (await store.list(sessionKey))[0]?.handle ?? ''
        if (!handle) await new Promise(resolve => setTimeout(resolve, 2))
      }
      // 500 x 2 ms, not 50: at ~100 ms this poll GAVE UP with the child still
      // registered, `stop()` then took the child branch, and that branch stamps
      // `requestedTerminal` `stopped` — which is the `Expected "exited" /
      // Received "stopped"` symptom the known-failing register has carried for
      // this case since 2026-08-23. It was 3 of the 9 failures in a 25-run
      // measurement at the 1.38.0 close-out. Giving up is never the right
      // answer here: the case is ABOUT the child having left, so waiting
      // longer for it costs a busy box a second and costs a healthy one
      // nothing.
      // And "left" means REGISTERED and then gone, never merely "not in
      // `children`": `store.list` sees the record the moment `create` writes
      // it, and `create` still writes the log file, its mode and the running
      // marker before `start()` spawns and registers the child. A poll on
      // `children` alone read "not spawned yet" as "already left" and stopped
      // waiting at once; `stop()` then found the freshly spawned child and
      // stamped it `stopped` (CI pipeline 127598882: the whole case in 8.35 ms),
      // or found nothing and threw `process-recovery-identity-mismatch` — both
      // registered symptoms, reproduced on demand by delaying `create`'s return
      // (CI-k3, 2026-10-01). `completions` is set in the same synchronous block
      // as `children` and keeps its entry until the close finalization, parked
      // on the flush gate, resolves — so "in `completions`, not in `children`"
      // is exactly the state this case is about, and it holds while the gate
      // is shut.
      const internals = supervisor as unknown as { children: Map<string, unknown>; completions: Map<string, unknown> }
      const departed = () => internals.completions.has(handle) && !internals.children.has(handle)
      for (let attempt = 0; attempt < 500 && !departed(); attempt++) await new Promise(resolve => setTimeout(resolve, 2))
      expect(departed()).toBe(true)
      const ownerReadsBeforeStop = ownerReads
      const stopping = supervisor.stop({ sessionKey, handle })
      // `stop()` suspends on its FIRST await — `store.assertOwner` — and from
      // there to its `completions` lookup it runs synchronously. Releasing the
      // gate on the very next line, as this case did until the 1.38.0 close-out,
      // let the close finalization run to completion and DEREGISTER that
      // completion while the owner read was still in flight; `stop()` then found
      // no child and no completion, took the recovered-process path and threw
      // `process-recovery-identity-mismatch` — 2 of 5 runs ALONE at load ~9
      // (2026-09-13), which is why this case reads as a long-standing flake.
      // Waiting on a TIMER for that owner read to land orders the release
      // strictly after the completion lookup: a timer callback runs after every
      // pending microtask, so `stop()` is parked on `await completion` by the
      // time the gate opens. Bounded, so a `stop()` that fails before the read
      // reports its own error instead of hanging here.
      const ownerReadDeadline = Date.now() + 5000
      while (ownerReads === ownerReadsBeforeStop && Date.now() < ownerReadDeadline) {
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      releaseFlush()
      await stopping
      const started = await starting
      expect(started.handle).toBe(handle)
      expect((await store.get(handle)).status).toBe('exited')
    } finally { releaseFlush(); await rm(root, { recursive: true, force: true }) }
  })

  test('append failure remains lost after process close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x4a-'))
    class FailingStore extends ProcessStore {
      override async append(): Promise<number> { throw new Error('append-failed') }
    }
    try {
      const store = new FailingStore({ root })
      const supervisor = new ProcessSupervisor({ store, resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }) })
      const sessionKey = { workspaceId: 'w', sessionId: 's' }
      const result = await supervisor.start({
        sessionKey, executionId: 'append', semanticId: 'bash', command: process.execPath,
        args: ['-e', 'process.stdout.write("x")'], cwd: root, workspaceRoot: root,
        profile: 'workspace', background: false, timeoutMs: 1000,
      })
      expect((await store.get(result.handle)).status).toBe('lost')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('keeps scratch outside the workspace and kills descendant trees on timeout', async () => {
    if (process.platform === 'win32') return
    const workspace = await mkdtemp(join(tmpdir(), 'nessy-x4a-workspace-'))
    const storeRoot = await mkdtemp(join(tmpdir(), 'nessy-x4a-store-'))
    const marker = join(workspace, 'descendant-leak')
    try {
      const store = new ProcessStore({ root: storeRoot })
      let scratchRoot = ''
      const supervisor = new ProcessSupervisor({
        store,
        graceMs: 20,
        resolveIsolation: input => {
          scratchRoot = input.scratchRoot ?? ''
          return { command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }
        },
      })
      const sessionKey = { workspaceId: 'w', sessionId: 's' }
      const result = await supervisor.start({
        sessionKey, executionId: 'timeout', semanticId: 'bash', command: '/bin/sh',
        args: ['-lc', `(sleep 0.25; printf leaked > ${JSON.stringify(marker)}) & wait`],
        cwd: workspace, workspaceRoot: workspace, profile: 'workspace', background: false, timeoutMs: 30,
      })
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(scratchRoot.startsWith(await realpath(storeRoot))).toBe(true)
      expect(scratchRoot.startsWith(await realpath(workspace))).toBe(false)
      expect((await store.get(result.handle)).status).toBe('timed-out')
      expect(await access(marker).then(() => true, () => false)).toBe(false)
    } finally {
      await rm(workspace, { recursive: true, force: true }); await rm(storeRoot, { recursive: true, force: true })
    }
  })

  test('abort and natural exit each publish one stable final state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x4a-'))
    try {
      const store = new ProcessStore({ root })
      const supervisor = new ProcessSupervisor({ store, graceMs: 20, resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }) })
      const sessionKey = { workspaceId: 'w', sessionId: 's' }
      const controller = new AbortController()
      controller.abort()
      await expect(supervisor.start({
        sessionKey, executionId: 'already-aborted', semanticId: 'bash', command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, workspaceRoot: root,
        profile: 'workspace', background: true, timeoutMs: 30, signal: controller.signal,
      })).rejects.toThrow('process-start-aborted')
      expect(await store.list(sessionKey)).toEqual([])

      const activeController = new AbortController()
      const aborted = supervisor.start({
        sessionKey, executionId: 'abort', semanticId: 'bash', command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, workspaceRoot: root,
        profile: 'workspace', background: false, timeoutMs: 30, signal: activeController.signal,
      })
      setTimeout(() => activeController.abort(), 5)
      const abortedResult = await aborted
      expect((await store.get(abortedResult.handle)).status).toBe('stopped')
      await new Promise(resolve => setTimeout(resolve, 20))
      expect((await store.get(abortedResult.handle)).status).toBe('stopped')

      const exited = await supervisor.start({
        sessionKey, executionId: 'exit', semanticId: 'bash', command: process.execPath,
        args: ['-e', ''], cwd: root, workspaceRoot: root, profile: 'workspace', background: false, timeoutMs: 5_000,
      })
      expect((await store.get(exited.handle)).status).toBe('exited')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('publishes durable registration before foreground completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x4b-'))
    try {
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root }),
        resolveIsolation: input => ({ command: input.command, args: input.args, backend: 'test', profile: input.profile as Exclude<typeof input.profile, 'none'> }),
      })
      let registered = false
      let completed = false
      const starting = supervisor.start({
        sessionKey: { workspaceId: 'w', sessionId: 's' }, executionId: 'registration', semanticId: 'bash',
        command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30)'], cwd: root, workspaceRoot: root,
        profile: 'workspace', background: false, timeoutMs: 1_000,
      }, () => { registered = true })
      void starting.finally(() => { completed = true })
      for (let attempt = 0; attempt < 50 && !registered; attempt++) await Bun.sleep(2)
      expect(registered).toBe(true)
      expect(completed).toBe(false)
      await starting
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('aggregates exact failed process handles while completing successful stops', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x4b-'))
    const sessionKey = { workspaceId: 'w', sessionId: 's' }
    try {
      const store = new ProcessStore({ root })
      const handles: string[] = []
      for (const executionId of ['ok', 'failed']) {
        handles.push((await store.create({
          sessionKey, executionId, semanticId: 'bash', pid: null, pidStartMarker: null,
          startedAt: 1, deadlineAt: 2, status: 'running', exitCode: null, signal: null,
          profile: 'workspace', isolationProfile: 'workspace:test', environmentProfile: 'restricted', environmentDigest: 'digest', cwd: root,
        })).handle)
      }
      class DrainSupervisor extends ProcessSupervisor {
        override async stop(request: { sessionKey: SessionKey; handle: string }): Promise<void> {
          if (request.handle === handles[1]) throw new Error('stop-failed')
          await store.update(request.handle, { status: 'stopped' })
        }
      }
      const supervisor = new DrainSupervisor({ store })
      let error: unknown
      try { await supervisor.drainSession(sessionKey) } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(ProcessSessionDrainError)
      expect(error).toMatchObject({ failedHandles: [handles[1]] })
      expect((await store.get(handles[0]!)).status).toBe('stopped')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  /**
   * UA12.153 (SIT-D F3) — a session killed by an app quit becomes undeletable:
   * the quit's close-handler race writes `lost` on records whose process died
   * with the host, `drainSession`'s residual half counts `lost` unconditionally,
   * and the strict drain behind `deleteSession` then refuses forever
   * (`pi-session-drain-failed:session deletion`) on a session that holds no live
   * work. `countActive` already asks `retireRecoveredProcessIfGone` before
   * counting (D1.345); the drain's residual half must ask the same question on
   * the same evidence: PROVEN gone (pid start-marker mismatch) → retire to
   * `exited`, not a residual. A `lost` record whose pid still matches its marker
   * (live work, or a platform that cannot be asked) keeps failing the drain.
   */
  test('UA12.153: a lost record whose process is provably gone is retired, not counted as the drain\'s residual', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-ua12-153-drain-'))
    const sessionKey = { workspaceId: 'w', sessionId: 'killed-by-quit' }
    try {
      const store = new ProcessStore({ root })
      const handle = (await store.create({
        sessionKey, executionId: 'quit-sleep', semanticId: 'bash', pid: 424242,
        pidStartMarker: 'darwin:Sun Oct  4 04:28:30 2026',
        startedAt: 1, deadlineAt: 2, status: 'lost', exitCode: null, signal: null,
        profile: 'workspace', isolationProfile: 'workspace:test', environmentProfile: 'restricted', environmentDigest: 'digest', cwd: root,
      })).handle

      // The reader answers NOTHING for the pid — `ps` for a process that died
      // with the previous host — which `retireRecoveredProcessIfGone` reads as a
      // marker mismatch: PROVEN gone.
      const gone = new ProcessSupervisor({ store, readPidStartMarker: async () => { throw new Error('no such process') } })
      await expect(gone.drainSession(sessionKey)).resolves.toEqual([])
      expect((await store.get(handle)).status).toBe('exited')

      // Negative control (fail-closed): the same record with the pid still
      // alive under the SAME start marker is live work the drain must name.
      const store2 = new ProcessStore({ root: join(root, 'second') })
      const alive = (await store2.create({
        sessionKey, executionId: 'quit-sleep', semanticId: 'bash', pid: 424242,
        pidStartMarker: 'darwin:Sun Oct  4 04:28:30 2026',
        startedAt: 1, deadlineAt: 2, status: 'lost', exitCode: null, signal: null,
        profile: 'workspace', isolationProfile: 'workspace:test', environmentProfile: 'restricted', environmentDigest: 'digest', cwd: root,
      })).handle
      const stillRunning = new ProcessSupervisor({ store: store2, readPidStartMarker: async () => 'darwin:Sun Oct  4 04:28:30 2026' })
      let error: unknown
      try { await stillRunning.drainSession(sessionKey) } catch (caught) { error = caught }
      expect(error).toBeInstanceOf(ProcessSessionDrainError)
      expect(error).toMatchObject({ failedHandles: [alive] })

      // Boundary control (cannot ask → fail-closed, the Windows residue): a
      // platform whose marker reader is undefined never retires a lost record.
      const store3 = new ProcessStore({ root: join(root, 'third') })
      await store3.create({
        sessionKey, executionId: 'quit-sleep', semanticId: 'bash', pid: 424242,
        pidStartMarker: 'darwin:Sun Oct  4 04:28:30 2026',
        startedAt: 1, deadlineAt: 2, status: 'lost', exitCode: null, signal: null,
        profile: 'workspace', isolationProfile: 'workspace:test', environmentProfile: 'restricted', environmentDigest: 'digest', cwd: root,
      })
      const windows = new ProcessSupervisor({ store: store3, platform: 'win32' })
      await expect(windows.drainSession(sessionKey)).rejects.toBeInstanceOf(ProcessSessionDrainError)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('writes bounded stdin only for the owning live process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-x8-stdin-'))
    const owner = { workspaceId: 'w', sessionId: 's' }
    try {
      const supervisor = new ProcessSupervisor({
        store: new ProcessStore({ root }),
        resolveIsolation: input => ({
          command: input.command,
          args: input.args,
          backend: 'test',
          profile: input.profile as Exclude<typeof input.profile, 'none'>,
        }),
      })
      const started = await supervisor.start({
        sessionKey: owner,
        executionId: 'lsp',
        semanticId: 'lsp.request',
        command: process.execPath,
        args: ['-e', 'process.stdin.on("data", d => { process.stdout.write(d); if (d.toString().includes("quit")) process.exit(0) })'],
        cwd: root,
        workspaceRoot: root,
        profile: 'workspace',
        background: true,
        timeoutMs: 5_000,
        stdin: 'pipe',
      })
      await expect(supervisor.write({
        sessionKey: { workspaceId: 'other', sessionId: 's' },
        handle: started.handle,
        data: 'denied',
      })).rejects.toThrow('process-handle-owner-mismatch')
      await expect(supervisor.write({
        sessionKey: owner,
        handle: started.handle,
        data: 'x'.repeat(64 * 1024 + 1),
      })).rejects.toThrow('process-stdin-write-too-large')
      await supervisor.write({ sessionKey: owner, handle: started.handle, data: 'quit' })
      expect((await supervisor.waitAndRead(owner, started.handle)).output).toBe('quit')
      await expect(supervisor.write({ sessionKey: owner, handle: started.handle, data: 'late' }))
        .rejects.toThrow('process-stdin-unavailable')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  /**
   * T1 contour (a) — the `sandbox.enabled` master kill switch, checked FIRST
   * and unconditionally in `resolveIsolationDowngrade`: `sandboxEnabled ===
   * false` skips isolation resolution entirely, with no egress exception and
   * no interaction with `dangerouslyDisableSandbox`/`excludedCommands`. The
   * supervisor's OWN default (option absent) stays "isolate" — the
   * DEFAULT-OFF lives in the settings resolver only, never here.
   */
  describe('sandbox.enabled master switch', () => {
    test('sandboxEnabled: false never consults isolation resolution and records the config-disabled downgrade', async () => {
      const root = await mkdtemp(join(tmpdir(), 'nessy-sandbox-off-'))
      try {
        const store = new ProcessStore({ root })
        let resolveIsolationCalls = 0
        const supervisor = new ProcessSupervisor({
          store,
          sandboxEnabled: false,
          resolveIsolation: input => {
            resolveIsolationCalls += 1
            // If this were ever consulted, argv would carry an obvious wrapper —
            // the assertion below is that it never runs at all.
            return {
              command: 'sandbox-exec',
              args: ['-p', '(deny default)', input.command, ...input.args],
              backend: 'stub-backend',
              profile: input.profile as Exclude<typeof input.profile, 'none'>,
            }
          },
        })
        const owner = { workspaceId: 'w', sessionId: 's' }
        const result = await supervisor.start({
          sessionKey: owner,
          executionId: 'exec-1',
          semanticId: 'bash',
          command: process.execPath,
          args: ['-e', 'process.stdout.write("bare-ok")'],
          cwd: root,
          workspaceRoot: root,
          profile: 'workspace',
          background: false,
          timeoutMs: 5_000,
        })
        expect(resolveIsolationCalls).toBe(0)
        expect(result.output).toContain('bare-ok')
        expect(result.isolationProfile).toBe('unsandboxed:disabled-by-config')
        expect(result.isolationDowngrade).toEqual({ reason: 'sandboxDisabled' })
        const stored = await store.get(result.handle)
        expect(stored.isolationProfile).toBe('unsandboxed:disabled-by-config')
        expect(stored.isolationDowngrade).toEqual({ reason: 'sandboxDisabled' })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    test('sandboxEnabled: false stays bare even with denyNetworkEgress set — no egress exception', async () => {
      const root = await mkdtemp(join(tmpdir(), 'nessy-sandbox-off-egress-'))
      try {
        const store = new ProcessStore({ root })
        let resolveIsolationCalls = 0
        const supervisor = new ProcessSupervisor({
          store,
          sandboxEnabled: false,
          denyNetworkEgress: true,
          resolveIsolation: input => {
            resolveIsolationCalls += 1
            return {
              command: input.command,
              args: input.args,
              backend: 'stub-backend',
              profile: input.profile as Exclude<typeof input.profile, 'none'>,
            }
          },
        })
        const owner = { workspaceId: 'w', sessionId: 's' }
        const result = await supervisor.start({
          sessionKey: owner,
          executionId: 'exec-1',
          semanticId: 'bash',
          command: process.execPath,
          args: ['-e', 'process.stdout.write("bare-ok")'],
          cwd: root,
          workspaceRoot: root,
          profile: 'workspace',
          background: false,
          timeoutMs: 5_000,
        })
        // «вообще выключены» — a network-egress lock does not carve out an
        // exception; the master switch still skips isolation resolution
        // entirely, so denyNetworkEgress is never even consulted.
        expect(resolveIsolationCalls).toBe(0)
        expect(result.isolationProfile).toBe('unsandboxed:disabled-by-config')
        expect(result.isolationDowngrade).toEqual({ reason: 'sandboxDisabled' })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    test('sandboxEnabled left unset (option absent) wraps exactly as today — fail-closed pin', async () => {
      const root = await mkdtemp(join(tmpdir(), 'nessy-sandbox-unset-'))
      try {
        const store = new ProcessStore({ root })
        const supervisor = new ProcessSupervisor({
          store,
          resolveIsolation: input => ({
            command: input.command,
            args: input.args,
            backend: 'stub-backend',
            profile: input.profile as Exclude<typeof input.profile, 'none'>,
          }),
        })
        const owner = { workspaceId: 'w', sessionId: 's' }
        const result = await supervisor.start({
          sessionKey: owner,
          executionId: 'exec-1',
          semanticId: 'bash',
          command: process.execPath,
          args: ['-e', 'process.stdout.write("wrapped-ok")'],
          cwd: root,
          workspaceRoot: root,
          profile: 'workspace',
          background: false,
          timeoutMs: 5_000,
        })
        expect(result.isolationProfile).toBe('workspace:stub-backend')
        expect(result.isolationDowngrade).toBeUndefined()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })
})

/**
 * Whether THIS host can actually start a supervised process at all.
 *
 * The four cases below that spawn a real child go through
 * `supervisor.start`, which resolves the `workspace` isolation profile and
 * THROWS `process-isolation-unavailable:…` when no backend exists. On a
 * Kubernetes runner with no bwrap, firejail or unshare — which is what CI is —
 * that throw is the honest fail-closed behaviour of the product, and reporting
 * it as four test failures told a reader to "install bubblewrap" on a container
 * nobody can install into. A skip that PRINTS the product's own verdict says
 * the same thing truthfully.
 *
 * The verdict comes from `probeIsolationCapabilities`, the product's own
 * capability report: it resolves every profile through the same
 * `resolveProcessIsolation` a real supervised process uses and NEVER throws, so
 * an unavailable entry carries the reason and remediation a real run would have
 * raised. Deliberately not a platform list — a darwin host with
 * `/usr/bin/sandbox-exec` removed is as unable as the CI container, and a host
 * list would run the cases there and call the refusal a defect.
 *
 * Imported dynamically rather than at the top of the file so the import region
 * is untouched: 54 doc anchors cite this file by line and all of them are at or
 * above line 1040, so everything this block adds sits below every one of them.
 */
const isolationProbe = await (async () => {
  const { probeIsolationCapabilities } = await import('./isolation-capabilities.ts')
  const report = await probeIsolationCapabilities()
  return report.profiles.workspace
})()
if (!isolationProbe.available) {
  // stderr, so the reason travels with the run rather than living only here.
  console.warn(
    '[process-supervisor.test.ts] the background-shell ceiling cases that spawn a child are SKIPPED: '
    + `this host cannot enforce the workspace isolation profile — ${isolationProbe.reason ?? 'no reason reported'}`
    + ` (${isolationProbe.remediation ?? 'no remediation reported'})`,
  )
}
/** Sugar so each case reads as its own decision rather than repeating the negation. */
const skipUnlessIsolated = !isolationProbe.available

/**
 * P6.346 (b)/(c)/(d) — the LIFETIME ceiling, the memory-pressure reaper behind
 * the page's three reap guards, and the hook exemption.
 *
 * The row's premise at HEAD, re-read before any of this was written:
 * `process-store.ts`'s `MAX_LOG_BYTES` is a RING — it drops the head and the
 * process keeps running — so what existed bounded what the model READ and
 * nothing else. `memoryPressure` scored 0 over `packages` + `apps`.
 *
 * Clause (a) was already landed (`947fba8ee`) and is not rebuilt here.
 */
describe('Pi ProcessSupervisor — the background-shell ceilings (P6.346)', () => {
  test.skipIf(skipUnlessIsolated)('the lifetime ceiling KILLS, and the log says which ceiling did it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p6346-ceiling-'))
    try {
      const store = new ProcessStore({ root })
      const supervisor = new ProcessSupervisor({ store, maxLifetimeOutputBytes: 64 })
      const sessionKey: SessionKey = { workspaceId: 'w', sessionId: 's' }
      const result = await supervisor.start({
        sessionKey, executionId: 'ceiling', semanticId: 'bash', command: process.execPath,
        // Writes far past the ceiling and then would sleep for a minute: the
        // control that separates "the ceiling killed it" from "it finished".
        args: ['-e', 'process.stdout.write("x".repeat(4096)); setTimeout(() => {}, 60000)'],
        cwd: root, workspaceRoot: root, profile: 'workspace', background: true, timeoutMs: 30_000,
      })
      const deadline = Date.now() + 10_000
      let record = await store.get(result.handle)
      while (record.status === 'running' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
        record = await store.get(result.handle)
      }
      expect(record.status).not.toBe('running')
      const log = await store.readLog(result.handle, record.baseCursor)
      // The note names the ceiling it hit and the way out — a marker saying only
      // "killed" leaves the reader unable to tell a runaway from a bug.
      expect(log.output).toContain('past the 64-byte lifetime output ceiling')
      expect(log.output).toContain(PROCESS_OUTPUT_CEILING_ENV)
      // ...and it does NOT blame the other ceiling, which is the whole of the
      // row's "a note saying WHICH killed it".
      expect(log.output).not.toContain('free memory')
    } finally { await rm(root, { recursive: true, force: true }) }
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  test.skipIf(skipUnlessIsolated)('a process under the ceiling is untouched, and 0 disables it', async () => {
    // The negative arm. Without it the case above passes for a supervisor that
    // kills everything.
    const root = await mkdtemp(join(tmpdir(), 'nessy-p6346-under-'))
    try {
      const store = new ProcessStore({ root })
      const supervisor = new ProcessSupervisor({ store, maxLifetimeOutputBytes: 0 })
      const sessionKey: SessionKey = { workspaceId: 'w', sessionId: 's' }
      const result = await supervisor.start({
        sessionKey, executionId: 'under', semanticId: 'bash', command: process.execPath,
        args: ['-e', 'process.stdout.write("y".repeat(4096))'],
        cwd: root, workspaceRoot: root, profile: 'workspace', background: false, timeoutMs: 10_000,
      })
      await store.flush(result.handle)
      const record = await store.get(result.handle)
      expect(record.status).toBe('exited')
      expect(record.exitCode).toBe(0)
      const log = await store.readLog(result.handle, record.baseCursor)
      expect(log.output).not.toContain('process killed')
    } finally { await rm(root, { recursive: true, force: true }) }
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  test('the ceiling default is the page\'s own number, and a typo does not remove it', () => {
    // Read, do not invent: `tools-reference.md#output-limits` says "a command
    // whose output passes 5 GB is killed", and `process-store.ts` recorded that
    // sentence as absent until this row.
    expect(DEFAULT_PROCESS_OUTPUT_CEILING_BYTES).toBe(5 * 1024 * 1024 * 1024)
    expect(resolveProcessOutputCeilingBytes({})).toBe(DEFAULT_PROCESS_OUTPUT_CEILING_BYTES)
    expect(resolveProcessOutputCeilingBytes({ [PROCESS_OUTPUT_CEILING_ENV]: '1024' })).toBe(1024)
    // `0` is the operator's off switch and must be honoured as one...
    expect(resolveProcessOutputCeilingBytes({ [PROCESS_OUTPUT_CEILING_ENV]: '0' })).toBe(0)
    // ...but a value that is not a non-negative integer keeps the default: the
    // other reading lets a typo silently remove a bound.
    for (const bad of ['-1', 'lots', '1e400', '1.5']) {
      expect(resolveProcessOutputCeilingBytes({ [PROCESS_OUTPUT_CEILING_ENV]: bad }))
        .toBe(DEFAULT_PROCESS_OUTPUT_CEILING_BYTES)
    }
  })

  test('the memory-pressure reaper honours the page\'s three guards, and defaults OFF', () => {
    const base = {
      now: 10_000_000,
      freeBytes: 1,
      totalBytes: 100,
      thresholdPercent: 10,
      guards: {
        lastActiveAt: 10_000_000 - DEFAULT_BACKGROUND_SHELL_IDLE_MS,
        turnRunning: false,
        subagentRunning: false,
      },
    }
    // Positive: 1% free against a 10% threshold, idle exactly 30 minutes, no
    // turn and no subagent.
    expect(resolveBackgroundShellReaping(base).reap).toBe(true)
    expect(resolveBackgroundShellReaping(base).freeRatioPercent).toBe(1)
    // Guard 1 — idle 30 minutes. One millisecond short does not reap.
    expect(resolveBackgroundShellReaping({
      ...base,
      guards: { ...base.guards, lastActiveAt: base.guards.lastActiveAt + 1 },
    }).reap).toBe(false)
    // Guards 2 and 3 — no turn running, no subagent running.
    expect(resolveBackgroundShellReaping({ ...base, guards: { ...base.guards, turnRunning: true } }).reap).toBe(false)
    expect(resolveBackgroundShellReaping({ ...base, guards: { ...base.guards, subagentRunning: true } }).reap).toBe(false)
    // Guards that CANNOT be evaluated never reap — the fail-safe direction, and
    // the reason the supervisor's `sessionQuiescence` is optional.
    expect(resolveBackgroundShellReaping({ ...base, guards: undefined }).reap).toBe(false)
    // A clock step reads as not-idle rather than as ancient.
    expect(resolveBackgroundShellReaping({
      ...base, guards: { ...base.guards, lastActiveAt: base.now + 60_000 },
    }).reap).toBe(false)
    // Not under pressure at all.
    expect(resolveBackgroundShellReaping({ ...base, freeBytes: 50 }).reap).toBe(false)
    // And the posture: OFF unless an operator says otherwise, on every shape of
    // the knob including the out-of-range ones.
    expect(resolveBackgroundShellReaping({ ...base, thresholdPercent: 0 }).reap).toBe(false)
    expect(resolveMemoryPressureThresholdPercent({})).toBe(0)
    expect(resolveMemoryPressureThresholdPercent({ [PROCESS_MEMORY_PRESSURE_ENV]: '15' })).toBe(15)
    for (const bad of ['0', '-5', '100', '120', 'some']) {
      expect(resolveMemoryPressureThresholdPercent({ [PROCESS_MEMORY_PRESSURE_ENV]: bad })).toBe(0)
    }
  })

  /**
   * P6.825 — the reaper only looked when a process SPOKE.
   *
   * Verified at HEAD before this was written: `enforceMemoryPressure` had
   * exactly one caller, the `.then()` of `trackAppend`, which runs per appended
   * chunk. So the shape the reaper exists for — a memory-hungry process that has
   * gone quiet — was the one shape it could never see, and a `sleep 3600 &` was
   * exempt by silence.
   */
  test.skipIf(skipUnlessIsolated)('a SILENT process is reaped: the sweep looks without being spoken to', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nessy-p6825-silent-'))
    try {
      const store = new ProcessStore({ root })
      const supervisor = new ProcessSupervisor({
        store,
        memoryPressurePercent: 10,
        // 1 % free against a 10 % threshold: under pressure, deterministically.
        readFreeMemory: () => ({ freeBytes: 1, totalBytes: 100 }),
        sessionQuiescence: () => ({
          lastActiveAt: Date.now() - DEFAULT_BACKGROUND_SHELL_IDLE_MS,
          turnRunning: false,
          subagentRunning: false,
        }),
      })
      const sessionKey: SessionKey = { workspaceId: 'w', sessionId: 's' }
      const result = await supervisor.start({
        sessionKey, executionId: 'silent', semanticId: 'bash', command: process.execPath,
        // Writes NOTHING and would sleep for a minute. Under the append edge
        // alone this process is unreachable: no chunk, no sample, no verdict.
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        cwd: root, workspaceRoot: root, profile: 'workspace', background: true, timeoutMs: 30_000,
      })
      // The timer is ARMED by a live process, which is the mechanism under test.
      expect((supervisor as any).memorySweepTimer).toBeDefined()
      // Driven directly rather than waited on: the tick is a five-second
      // heartbeat and what is being asserted is what a tick DOES, not that
      // `setInterval` counts.
      ;(supervisor as any).sweepMemoryPressure()
      const deadline = Date.now() + 10_000
      let record = await store.get(result.handle)
      while (record.status === 'running' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
        record = await store.get(result.handle)
      }
      expect(record.status).not.toBe('running')
      const log = await store.readLog(result.handle, record.baseCursor)
      // The memory sentence, and NOT the lifetime one: a process that produced
      // zero bytes must never be told it passed an output ceiling.
      expect(log.output).toContain('free memory')
      expect(log.output).not.toContain('lifetime output ceiling')
    } finally { await rm(root, { recursive: true, force: true }) }
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  test.skipIf(skipUnlessIsolated)('the sweep is armed only while the reaper is on, and cleared on exit', async () => {
    // The negative arm, in both directions. Without it the case above passes for
    // a supervisor that arms a heartbeat on every install and keeps it forever.
    const root = await mkdtemp(join(tmpdir(), 'nessy-p6825-arming-'))
    try {
      const store = new ProcessStore({ root })
      const sessionKey: SessionKey = { workspaceId: 'w', sessionId: 's' }

      // OFF is the default posture (P6.346): no threshold, no timer, even with a
      // process running.
      const off = new ProcessSupervisor({ store, memoryPressurePercent: 0 })
      const idle = await off.start({
        sessionKey, executionId: 'off', semanticId: 'bash', command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 250)'],
        cwd: root, workspaceRoot: root, profile: 'workspace', background: true, timeoutMs: 10_000,
      })
      expect((off as any).memorySweepTimer).toBeUndefined()
      await off.stop({ sessionKey, handle: idle.handle }).catch(() => undefined)

      // ON, and the timer follows the LAST live process out of the door.
      const on = new ProcessSupervisor({
        store,
        memoryPressurePercent: 10,
        // Not under pressure: this case is about the timer's lifetime, and a
        // reaping verdict here would end the process for the other reason.
        readFreeMemory: () => ({ freeBytes: 90, totalBytes: 100 }),
      })
      const short = await on.start({
        sessionKey, executionId: 'short', semanticId: 'bash', command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 50)'],
        cwd: root, workspaceRoot: root, profile: 'workspace', background: true, timeoutMs: 10_000,
      })
      expect((on as any).memorySweepTimer).toBeDefined()
      const deadline = Date.now() + 10_000
      let record = await store.get(short.handle)
      while (record.status === 'running' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25))
        record = await store.get(short.handle)
      }
      expect(record.status).not.toBe('running')
      for (let attempt = 0; attempt < 200 && (on as any).memorySweepTimer !== undefined; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect((on as any).memorySweepTimer).toBeUndefined()
    } finally { await rm(root, { recursive: true, force: true }) }
  }, MODULE_GRAPH_CASE_BUDGET_MS)

  test('permission-gating hooks are EXEMPT from these ceilings, by construction', () => {
    // Clause (d). The row asks for hooks to be exempt "because killing a
    // blocking hook allows the action", and nothing had to be built for it: a
    // hook is spawned by `automations/hook-command.ts` with `node:child_process`
    // directly and never passes this class, so no ceiling of this supervisor's
    // can reach one. Stated and PINNED rather than assumed, because the
    // exemption is invisible at both sites and a future refactor routing hooks
    // through the supervisor would silently remove it.
    const hookCommand = readFileSync(
      join(import.meta.dir, '..', '..', '..', 'shared', 'src', 'automations', 'hook-command.ts'),
      'utf8',
    )
    // Positive control: the file loaded and does spawn processes.
    expect(hookCommand).toContain("import { spawn } from 'node:child_process'")
    expect(hookCommand).toMatch(/\bspawn\(/)
    // The finding: it reaches no supervisor and no process store, so neither the
    // lifetime ceiling nor the memory reaper can see a hook.
    expect(hookCommand).not.toContain('ProcessSupervisor')
    expect(hookCommand).not.toContain('process-supervisor')
    expect(hookCommand).not.toContain('ProcessStore')
  })
})
