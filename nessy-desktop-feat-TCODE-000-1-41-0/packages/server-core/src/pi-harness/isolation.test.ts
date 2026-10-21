import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { isPathContained, resolveProcessIsolation } from './isolation.ts'
import { selfConfigDenyWriteRoots } from './isolation/self-config-deny.ts'
import { sharedGitDirectoryGrant } from './isolation/shared-git.ts'
import { verifyWindowsSandboxRuntime } from './isolation/windows.ts'

describe('Pi process isolation', () => {
  let testRoot = ''

  afterEach(() => {
    if (testRoot) rmSync(testRoot, { recursive: true, force: true })
    testRoot = ''
  })

  test('uses the verified host-owned Windows restricted-token runner for plugin MCP', () => {
    testRoot = mkdtempSync(join(tmpdir(), 'nessy-windows-isolation-'))
    const workspaceRoot = join(testRoot, 'workspace')
    const scratchRoot = join(testRoot, 'scratch')
    const stateRoot = join(testRoot, 'state')
    const pluginData = join(testRoot, 'plugin-data')
    const credentialFile = join(testRoot, 'config', 'credentials.enc')
    const runtimeRoot = join(testRoot, 'runtime')
    for (const path of [workspaceRoot, scratchRoot, stateRoot, pluginData, runtimeRoot, dirname(credentialFile)]) {
      mkdirSync(path, { recursive: true })
    }
    writeFileSync(credentialFile, 'encrypted')
    const command = join(runtimeRoot, 'codex.exe')
    const commandRunner = join(runtimeRoot, 'codex-command-runner.exe')
    const setupCommand = join(runtimeRoot, 'codex-windows-sandbox-setup.exe')
    for (const path of [command, commandRunner, setupCommand]) writeFileSync(path, 'verified-stub')

    const plan = resolveProcessIsolation({
      platform: 'win32',
      profile: 'plugin-mcp',
      command: join(testRoot, 'plugin.exe'),
      args: ['serve'],
      workspaceRoot,
      workingDirectory: workspaceRoot,
      scratchRoot,
      additionalWritableRoots: [pluginData],
      deniedReadRoots: [credentialFile],
      environment: { PLUGIN_TOKEN: 'reviewed-value' },
      windowsSandboxStateRoot: stateRoot,
      windowsSandboxRuntime: { command, commandRunner, setupCommand },
      verifyWindowsSandboxRuntime: () => undefined,
    })

    expect(plan.command).toBe(command)
    expect(plan.backend).toContain('windows-restricted-token')
    expect(plan.backend).toContain('write-scratch-only+managed-data')
    expect(plan.args[0]).toBe('sandbox')
    const configProfile = plan.args[plan.args.indexOf('--profile') + 1]
    expect(configProfile).toMatch(/^nessy-[a-f0-9]{64}$/)
    expect(plan.args[plan.args.indexOf('--permissions-profile') + 1]).toBe('nessy-supervised-process')
    const codexHome = plan.environment?.CODEX_HOME
    expect(typeof codexHome).toBe('string')
    const configPath = join(codexHome!, `${configProfile}.config.toml`)
    const config = readFileSync(configPath, 'utf8')
    expect(config).toContain('":root" = "read"')
    expect(config).toContain(`${JSON.stringify(realpathSync(scratchRoot))} = "write"`)
    expect(config).toContain(`${JSON.stringify(realpathSync(pluginData))} = "write"`)
    expect(config).toContain(`${JSON.stringify(realpathSync(credentialFile))} = "deny"`)
    expect(config).toContain('enabled = true')
    expect(config).toContain('sandbox = "unelevated"')
    expect(config).toContain('sandbox_private_desktop = true')
    expect(plan.environment?.PLUGIN_TOKEN).toBe('reviewed-value')
    expect(plan.args.join(' ')).not.toContain('reviewed-value')
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    expect(statSync(join(codexHome!, 'config.toml')).mode & 0o777).toBe(0o600)
    expect(statSync(codexHome!).mode & 0o777).toBe(0o700)
    expect(plan.args.slice(-3)).toEqual(['--', join(testRoot, 'plugin.exe'), 'serve'])
  })

  test('fails closed when the verified Windows sandbox runtime is unavailable', () => {
    testRoot = mkdtempSync(join(tmpdir(), 'nessy-windows-isolation-'))
    const workspaceRoot = join(testRoot, 'workspace')
    const scratchRoot = join(testRoot, 'scratch')
    const stateRoot = join(testRoot, 'state')
    for (const path of [workspaceRoot, scratchRoot, stateRoot]) mkdirSync(path, { recursive: true })

    expect(() => resolveProcessIsolation({
      platform: 'win32',
      profile: 'plugin-mcp',
      command: join(testRoot, 'plugin.exe'),
      args: [],
      workspaceRoot,
      workingDirectory: workspaceRoot,
      scratchRoot,
      environment: {},
      windowsSandboxStateRoot: stateRoot,
    })).toThrow('process-isolation-unavailable:win32:plugin-mcp:runtime')
  })

  test('keeps hook-style workspace processes network-restricted with exact workspace and scratch writes', () => {
    testRoot = mkdtempSync(join(tmpdir(), 'nessy-windows-isolation-'))
    const workspaceRoot = join(testRoot, 'workspace')
    const scratchRoot = join(testRoot, 'scratch')
    const stateRoot = join(testRoot, 'state')
    const runtimeRoot = join(testRoot, 'runtime')
    for (const path of [workspaceRoot, scratchRoot, stateRoot, runtimeRoot]) mkdirSync(path, { recursive: true })
    const runtime = {
      command: join(runtimeRoot, 'codex.exe'),
      commandRunner: join(runtimeRoot, 'codex-command-runner.exe'),
      setupCommand: join(runtimeRoot, 'codex-windows-sandbox-setup.exe'),
    }
    for (const path of Object.values(runtime)) writeFileSync(path, 'verified-stub')

    const plan = resolveProcessIsolation({
      platform: 'win32',
      profile: 'workspace',
      command: join(testRoot, 'powershell.exe'),
      args: ['-Command', 'node hook.js'],
      workspaceRoot,
      workingDirectory: workspaceRoot,
      scratchRoot,
      environment: {},
      windowsSandboxStateRoot: stateRoot,
      windowsSandboxRuntime: runtime,
      verifyWindowsSandboxRuntime: () => undefined,
    })

    const codexHome = plan.environment?.CODEX_HOME
    expect(typeof codexHome).toBe('string')
    const configProfile = plan.args[plan.args.indexOf('--profile') + 1]
    const config = readFileSync(join(codexHome!, `${configProfile}.config.toml`), 'utf8')
    expect(config).toContain('enabled = false')
    expect(config).toContain(`${JSON.stringify(realpathSync(workspaceRoot))} = "write"`)
    expect(config).toContain(`${JSON.stringify(realpathSync(scratchRoot))} = "write"`)
    expect(plan.backend).toContain('write-workspace+scratch')
    expect(plan.backend).toContain('network-restricted')
  })

  test('fails closed if a host-owned Windows permission profile is tampered', () => {
    testRoot = mkdtempSync(join(tmpdir(), 'nessy-windows-isolation-'))
    const workspaceRoot = join(testRoot, 'workspace')
    const scratchRoot = join(testRoot, 'scratch')
    const stateRoot = join(testRoot, 'state')
    const runtimeRoot = join(testRoot, 'runtime')
    for (const path of [workspaceRoot, scratchRoot, stateRoot, runtimeRoot]) mkdirSync(path, { recursive: true })
    const runtime = {
      command: join(runtimeRoot, 'codex.exe'),
      commandRunner: join(runtimeRoot, 'codex-command-runner.exe'),
      setupCommand: join(runtimeRoot, 'codex-windows-sandbox-setup.exe'),
    }
    for (const path of Object.values(runtime)) writeFileSync(path, 'verified-stub')
    const input = {
      platform: 'win32' as const,
      profile: 'plugin-mcp' as const,
      command: join(testRoot, 'plugin.exe'),
      args: [],
      workspaceRoot,
      workingDirectory: workspaceRoot,
      scratchRoot,
      environment: { PLUGIN_TOKEN: 'secret' },
      windowsSandboxStateRoot: stateRoot,
      windowsSandboxRuntime: runtime,
      verifyWindowsSandboxRuntime: () => undefined,
    }

    const first = resolveProcessIsolation(input)
    const configProfile = first.args[first.args.indexOf('--profile') + 1]
    writeFileSync(join(first.environment!.CODEX_HOME!, `${configProfile}.config.toml`), 'tampered')
    expect(() => resolveProcessIsolation(input)).toThrow('windows-sandbox-profile-config-mismatch')
  })

  test('verifies every Windows sandbox companion against the pinned manifest and rejects tampering', () => {
    testRoot = mkdtempSync(join(tmpdir(), 'nessy-windows-isolation-'))
    const runtime = {
      command: join(testRoot, 'codex.exe'),
      commandRunner: join(testRoot, 'codex-command-runner.exe'),
      setupCommand: join(testRoot, 'codex-windows-sandbox-setup.exe'),
    }
    const bytes = new Map<string, string>([
      ['codex.exe', 'runner'],
      ['codex-command-runner.exe', 'command-runner'],
      ['codex-windows-sandbox-setup.exe', 'setup'],
    ])
    for (const [name, content] of bytes) writeFileSync(join(testRoot, name), content)
    const manifest = {
      windowsSandbox: {
        'win32-x64': {
          files: Object.fromEntries([...bytes].map(([name, content]) => [name, {
            binarySha256: createHash('sha256').update(content).digest('hex'),
          }])),
        },
      },
    }

    expect(() => verifyWindowsSandboxRuntime(runtime, manifest)).not.toThrow()
    writeFileSync(runtime.commandRunner, 'tampered-command-runner')
    expect(() => verifyWindowsSandboxRuntime(runtime, manifest))
      .toThrow('windows-sandbox-runtime-sha-mismatch:codex-command-runner.exe')
  })

  test('never permits a subprocess with the none profile', () => {
    expect(() => resolveProcessIsolation({
      platform: 'darwin',
      profile: 'none',
      command: '/usr/bin/true',
      args: [],
      workspaceRoot: '/workspace',
      workingDirectory: '/workspace',
      scratchRoot: '/app-data/processes',
    })).toThrow('process-isolation-none-is-in-process-only')
  })

  test('still refuses a relative or filesystem-root deny entry', () => {
    // Seeding the credential list must never come at the cost of these two
    // refusals: a relative entry canonicalises against the wrong base, and a
    // filesystem root would deny reads of everything.
    testRoot = mkdtempSync(join(tmpdir(), 'nessy-deny-root-refusal-'))
    const workspaceRoot = join(testRoot, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    const base = {
      platform: 'darwin' as const,
      profile: 'workspace' as const,
      command: '/usr/bin/true',
      args: [],
      workspaceRoot,
      workingDirectory: workspaceRoot,
      scratchRoot: join(testRoot, 'scratch'),
    }

    expect(() => resolveProcessIsolation({ ...base, deniedReadRoots: ['relative/x'] }))
      .toThrow('process-denied-read-root-not-absolute')
    expect(() => resolveProcessIsolation({ ...base, deniedReadRoots: ['/'] }))
      .toThrow('process-denied-read-root-too-broad')
  })

  test('rejects Windows cross-volume and sibling-prefix working directories', () => {
    expect(isPathContained('C:\\workspace', 'D:\\workspace', win32)).toBe(false)
    expect(isPathContained('C:\\workspace', 'C:\\workspace-other', win32)).toBe(false)
    expect(isPathContained('C:\\workspace', 'C:\\workspace\\project', win32)).toBe(true)
  })

  test('fails closed instead of overstating isolated-code read containment', () => {
    expect(() => resolveProcessIsolation({
      platform: 'linux', profile: 'isolated-code', command: 'node', args: [],
      workspaceRoot: '/workspace', workingDirectory: '/workspace', scratchRoot: '/app-data/processes',
    })).toThrow('process-isolation-unavailable:linux:isolated-code:declared-input-read-boundary')
  })

  test('names the win32 system set only on win32, and the project scope everywhere', () => {
    // The win32 half is asserted through the builder rather than a resolved plan
    // because `resolveWindowsIsolation` needs the pinned toolchain, and what is
    // in question here is the SET, not the rendering. The rendering is covered by
    // the plugin-MCP profile test above.
    const environment = {
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramData: 'C:\\ProgramData',
    }
    const shared = { workspaceRoot: '/ws', home: '/home/u', configDir: '/home/u/.nessy-agent', join }
    const posix = selfConfigDenyWriteRoots({ ...shared, platform: 'darwin' })
    const windows = selfConfigDenyWriteRoots({ ...shared, platform: 'win32', windowsEnvironment: environment })

    for (const set of [posix, windows]) {
      expect(set).toContain('/ws/.claude')
      expect(set).toContain('/ws/.nessy-agent')
      expect(set).toContain('/ws/.agents')
      expect(set).toContain('/home/u/.nessy-agent/config.json')
      expect(set).toContain('/home/u/.claude')
      // `.git` stays writable: the shell's git is the intended writer.
      expect(set).not.toContain('/ws/.git')
      // The scratch/TMPDIR root lives under `<configDir>/sessions`; denying the
      // config dir wholesale would revoke the scratch grant.
      expect(set).not.toContain('/home/u/.nessy-agent')
    }
    expect(posix).toContain('/Library/Application Support/Nessy')
    expect(posix.filter(root => root.includes('Program'))).toEqual([])
    expect(windows).toContain('C:\\Windows')
    expect(windows).toContain('C:\\Program Files')
    expect(windows).toContain('C:\\Program Files (x86)')
    // The managed settings directory on win32 IS under ProgramData, which the
    // system set already denies; both entries are present and that is harmless.
    expect(windows).toContain('C:\\ProgramData')
    expect(windows).toContain('C:\\ProgramData\\Nessy')
    // A host with none of the four variables set gets no entry that names a
    // directory it does not have.
    expect(selfConfigDenyWriteRoots({ ...shared, platform: 'win32' })
      .filter(root => root.startsWith('C:'))).toEqual([])
  })
})

/**
 * The self-config write deny (B3 Task 1).
 *
 * Every `sandboxing.md` citation in THIS FILE names the page's own SECTION
 * ANCHOR, not a line number, and every quote was re-measured verbatim against
 * the 2026-08-25 fetch (`curl -s https://code.claude.com/docs/en/sandboxing.md`,
 * HTTP 200, 677 lines, md5 `3538c3dd04b83d8bbaa35d0fad0ccb88`). Numbers are gone
 * because this page's have moved on three consecutive fetches — the whole
 * "Protected paths" section shifted up 14 lines between the 2026-08-23 and
 * 2026-08-25 fetches — so a number is stale before the next reader opens the
 * file, while a section anchor is part of the page's own link contract. No claim
 * is made here about citations to any OTHER page.
 *
 * `sandboxing.md#protected-paths` — "Inside the directories that sandboxed
 * commands can write to, the sandbox still denies writes to the files Claude Code
 * loads configuration and code from", and "If a symlink appears at a protected
 * settings file's path during the session, the sandbox also denies writes to the
 * file it points to, starting with the next command". (Both sentences were
 * previously quoted in older wording hung on `sandboxing.md:478`; neither of
 * those strings is on the 2026-08-25 page, and `:478` is now the network-proxy
 * line.)
 *
 * Run as a REAL command under the composed profile, because the interesting case
 * is not what the profile text says but what the kernel does with it: Seatbelt
 * canonicalises before it matches, which is precisely why naming the protected
 * path alone is not enough.
 */
describe('Pi process isolation — a command cannot rewrite its own policy', () => {
  let testRoot = ''

  afterEach(() => {
    if (testRoot) rmSync(testRoot, { recursive: true, force: true })
    testRoot = ''
  })

  const writeUnder = (workspaceRoot: string, relativePath: string) => {
    const plan = resolveProcessIsolation({
      platform: 'darwin',
      profile: 'workspace',
      command: '/bin/bash',
      args: ['-c', `printf pwned > ${JSON.stringify(join(workspaceRoot, relativePath))} && echo WROTE`],
      workspaceRoot,
      workingDirectory: workspaceRoot,
      scratchRoot: join(testRoot, 'scratch'),
    })
    return { plan, run: spawnSync(plan.command, plan.args, { encoding: 'utf8' }) }
  }

  test.skipIf(process.platform !== 'darwin')(
    'refuses the protected path, refuses it through a symlink, and leaves a sibling alone',
    () => {
      testRoot = mkdtempSync(join(tmpdir(), 'nessy-self-config-deny-'))
      const workspaceRoot = join(testRoot, 'workspace')
      mkdirSync(join(workspaceRoot, '.claude'), { recursive: true })
      mkdirSync(join(testRoot, 'scratch'), { recursive: true })

      // 1. The protected path itself, inside the writable workspace root.
      const direct = writeUnder(workspaceRoot, '.claude/settings.json')
      expect(direct.run.stdout).not.toContain('WROTE')
      expect(direct.run.stderr).toContain('Operation not permitted')

      // 2. A SIBLING inside the same writable root stays writable, so the deny is
      //    a deny of one tree and not a retreat to a read-only workspace.
      const sibling = writeUnder(workspaceRoot, 'settings.json')
      expect(sibling.run.stdout.trim()).toBe('WROTE')
      expect(sibling.run.status).toBe(0)

      // 3. The protected path is now a SYMLINK to another path inside the same
      //    writable root. This is the case the deny list misses when it names only
      //    the path as written: the kernel resolves the link first, so the write
      //    lands on `linked-claude/settings.json`, which no rule denied.
      rmSync(join(workspaceRoot, '.claude'), { recursive: true, force: true })
      mkdirSync(join(workspaceRoot, 'linked-claude'), { recursive: true })
      symlinkSync(join(workspaceRoot, 'linked-claude'), join(workspaceRoot, '.claude'))
      const throughLink = writeUnder(workspaceRoot, '.claude/settings.json')
      expect(throughLink.run.stdout).not.toContain('WROTE')
      expect(throughLink.run.stderr).toContain('Operation not permitted')
      expect(existsSync(join(workspaceRoot, 'linked-claude', 'settings.json'))).toBe(false)
      // Both halves of the pair are in the profile: the target because the kernel
      // resolves the link, and the link's own name because `unlink` does not.
      const profile = throughLink.plan.args[1] ?? ''
      const real = realpathSync(workspaceRoot)
      expect(profile).toContain(`(deny file-write* (subpath "${join(real, '.claude')}"))`)
      expect(profile).toContain(`(deny file-write* (subpath "${join(real, 'linked-claude')}"))`)

      // 4. …and the link cannot be swapped for an ordinary file of the command's
      //    choosing, which is what the deny of the link's own name buys.
      const replace = resolveProcessIsolation({
        platform: 'darwin',
        profile: 'workspace',
        command: '/bin/bash',
        args: ['-c', `rm ${JSON.stringify(join(workspaceRoot, '.claude'))} && echo UNLINKED`],
        workspaceRoot,
        workingDirectory: workspaceRoot,
        scratchRoot: join(testRoot, 'scratch'),
      })
      const unlinked = spawnSync(replace.command, replace.args, { encoding: 'utf8' })
      expect(unlinked.stdout).not.toContain('UNLINKED')
    },
  )

  test('grants the shared git directory only for a real linked worktree', () => {
    // The pointer file is repository CONTENT, so every refusal below is a refusal
    // to take an attacker's word for a write scope. Asserted without a real
    // repository because what is in question is the parse and its guards.
    testRoot = mkdtempSync(join(tmpdir(), 'nessy-shared-git-guard-'))
    const workspaceRoot = join(testRoot, 'workspace')
    const fakeGitDir = join(testRoot, 'fake.git')
    mkdirSync(workspaceRoot, { recursive: true })
    mkdirSync(join(fakeGitDir, 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(fakeGitDir, 'HEAD'), 'ref: refs/heads/main\n')
    const pointer = join(workspaceRoot, '.git')

    // An ordinary repository: `.git` is a directory, already inside the write
    // scope, so there is nothing to grant.
    mkdirSync(pointer, { recursive: true })
    expect(sharedGitDirectoryGrant(realpathSync(workspaceRoot))).toBeUndefined()
    rmSync(pointer, { recursive: true, force: true })

    // No `commondir` beside the pointed-at gitdir: not a linked worktree.
    writeFileSync(pointer, `gitdir: ${join(fakeGitDir, 'worktrees', 'wt')}\n`)
    expect(sharedGitDirectoryGrant(realpathSync(workspaceRoot))).toBeUndefined()

    writeFileSync(join(fakeGitDir, 'worktrees', 'wt', 'commondir'), '../..\n')
    const granted = sharedGitDirectoryGrant(realpathSync(workspaceRoot))
    expect(granted?.writableRoot).toBe(realpathSync(fakeGitDir))
    expect(granted?.deniedWriteRoots).toEqual([
      join(realpathSync(fakeGitDir), 'hooks'),
      join(realpathSync(fakeGitDir), 'config'),
    ])

    // A pointer aimed at an ancestor of the workspace would turn a narrow grant
    // into a grant of everything above the project.
    writeFileSync(join(fakeGitDir, 'worktrees', 'wt', 'commondir'), realpathSync(testRoot))
    writeFileSync(join(realpathSync(testRoot), 'HEAD'), 'ref: refs/heads/main\n')
    expect(sharedGitDirectoryGrant(realpathSync(workspaceRoot))).toBeUndefined()

    // A directory that is not a git directory at all.
    writeFileSync(join(fakeGitDir, 'worktrees', 'wt', 'commondir'), join(testRoot, 'workspace'))
    expect(sharedGitDirectoryGrant(realpathSync(workspaceRoot))).toBeUndefined()
  })

  test.skipIf(process.platform !== 'darwin')(
    'lets git commit in a linked worktree while everything outside stays refused',
    () => {
      testRoot = mkdtempSync(join(tmpdir(), 'nessy-shared-git-'))
      const repoRoot = join(testRoot, 'repo')
      const worktreeRoot = join(testRoot, 'worktree')
      const scratchRoot = join(testRoot, 'scratch')
      for (const path of [repoRoot, scratchRoot]) mkdirSync(path, { recursive: true })
      // `GIT_CONFIG_GLOBAL=/dev/null` and `-c user.*`: the developer's own git
      // config must not be read, and certainly not written, by a test.
      const git = (cwd: string, ...args: string[]) => {
        const run = spawnSync('git', ['-c', 'user.email=gate@nessy.test', '-c', 'user.name=Gate', ...args], {
          cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', HOME: scratchRoot },
        })
        if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
        return run
      }
      git(repoRoot, 'init', '--initial-branch=main', '.')
      writeFileSync(join(repoRoot, 'seed.txt'), 'seed\n')
      git(repoRoot, 'add', 'seed.txt')
      git(repoRoot, 'commit', '-m', 'seed')
      git(repoRoot, 'worktree', 'add', worktreeRoot, '-b', 'gate')
      // The premise: `.git` in the worktree is a FILE, and the shared directory it
      // resolves to sits outside the workspace root.
      expect(statSync(join(worktreeRoot, '.git')).isFile()).toBe(true)
      const sharedGitDir = realpathSync(join(repoRoot, '.git'))
      expect(isPathContained(realpathSync(worktreeRoot), sharedGitDir)).toBe(false)

      const sandboxed = (command: string) => {
        const plan = resolveProcessIsolation({
          platform: 'darwin',
          profile: 'workspace',
          command: '/bin/bash',
          args: ['-c', command],
          workspaceRoot: worktreeRoot,
          workingDirectory: worktreeRoot,
          scratchRoot,
        })
        return {
          plan,
          run: spawnSync(plan.command, plan.args, {
            cwd: worktreeRoot,
            encoding: 'utf8',
            env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', HOME: scratchRoot },
          }),
        }
      }

      const committed = sandboxed(
        'printf work > tracked.txt'
        + ' && git -c user.email=gate@nessy.test -c user.name=Gate add tracked.txt'
        + ' && git -c user.email=gate@nessy.test -c user.name=Gate commit -q -m sandboxed'
        + ' && git rev-parse --short HEAD',
      )
      expect(committed.run.status).toBe(0)
      expect(committed.run.stdout.trim()).toMatch(/^[0-9a-f]{7,}$/)
      expect(committed.plan.backend).toContain('shared-git')
      // Granted, and no more than granted: the two paths inside it that turn a
      // later git invocation into someone else's command stay denied.
      expect(committed.plan.args[1]).toContain(`(allow file-write* (subpath "${sharedGitDir}"))`)
      expect(committed.plan.args[1]).toContain(`(deny file-write* (subpath "${join(sharedGitDir, 'hooks')}"))`)
      expect(committed.plan.args[1]).toContain(`(deny file-write* (subpath "${join(sharedGitDir, 'config')}"))`)

      const hook = sandboxed(`printf evil > ${JSON.stringify(join(sharedGitDir, 'hooks', 'post-commit'))}`)
      expect(hook.run.status).not.toBe(0)
      expect(hook.run.stderr).toContain('Operation not permitted')

      const outside = sandboxed(`printf escaped > ${JSON.stringify(join(testRoot, 'escaped.txt'))}`)
      expect(outside.run.status).not.toBe(0)
      expect(outside.run.stderr).toContain('Operation not permitted')
      expect(existsSync(join(testRoot, 'escaped.txt'))).toBe(false)
    },
  )

  // Resolving the darwin plan needs the REAL /usr/bin/sandbox-exec — on any
  // other host `resolveDarwinIsolation` throws `process-isolation-unavailable`
  // before the canonicalisation under test can run. Same guard as the other
  // sandbox-exec-backed cases in this file.
  test.skipIf(process.platform !== 'darwin')('tolerates a protected path whose whole branch is missing', () => {
    // `/etc/nessy` and `<workspace>/.claude` do not exist on most machines. The
    // old canonicalisation realpathed the PARENT and stopped, so a root two levels
    // below anything real threw and every spawn failed.
    testRoot = mkdtempSync(join(tmpdir(), 'nessy-missing-branch-'))
    const workspaceRoot = join(testRoot, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    mkdirSync(join(testRoot, 'scratch'), { recursive: true })
    const plan = resolveProcessIsolation({
      platform: 'darwin',
      profile: 'workspace',
      command: '/usr/bin/true',
      args: [],
      workspaceRoot,
      workingDirectory: workspaceRoot,
      scratchRoot: join(testRoot, 'scratch'),
      deniedWriteRoots: [join(testRoot, 'no', 'such', 'branch')],
    })
    expect(plan.args[1]).toContain(join(realpathSync(testRoot), 'no', 'such', 'branch'))
  })
})

/**
 * `sandbox.network` reaching a command (S12).
 *
 * The gate the plan asked for — "a denied destination refused and an allowed one
 * permitted" — is run here against a LOCAL listener this test starts, never a
 * real host. It is also narrower than the plan assumed, and deliberately so: the
 * destination cannot be a domain, because no backend can express one. Measured
 * with `sandbox-exec` itself, which rejects `(remote ip "github.com:443")`,
 * `(remote tcp "github.com:443")` and even `(remote ip "140.82.121.4:443")` with
 * `host must be * or localhost in network address`, and does not have a
 * `remote host` or `remote domain` filter at all. Upstream filters by domain in a
 * PROXY outside the sandbox (`sandboxing.md#network-isolation`: "Network access
 * is controlled through a proxy server running outside the sandbox"), not in the
 * OS profile.
 *
 * So the boundary that exists is one bit, and this is the test that it is wired
 * to `sandbox.network.allowManagedDomainsOnly` rather than to nothing.
 */
/**
 * Whether THIS host can enforce process isolation at all. The wrappers under
 * test pick their backend from the real `process.platform` regardless of the
 * `platform` argument (see the comment inside the Linux-wrapper case), so a
 * Linux host without bwrap/firejail/unshare — the CI container — throws
 * `process-isolation-unavailable` before any composition can be observed.
 * Probed through the same resolver a real supervised process uses, the way
 * `probeIsolationCapabilities` does.
 */
const hostEnforcesProcessIsolation = (() => {
  const probeRoot = mkdtempSync(join(tmpdir(), 'nessy-isolation-host-probe-'))
  try {
    const workspaceRoot = join(probeRoot, 'workspace')
    mkdirSync(workspaceRoot, { recursive: true })
    resolveProcessIsolation({
      profile: 'workspace',
      command: process.execPath,
      args: [],
      workspaceRoot,
      workingDirectory: workspaceRoot,
      scratchRoot: join(probeRoot, 'scratch'),
    })
    return true
  } catch {
    return false
  } finally {
    rmSync(probeRoot, { recursive: true, force: true })
  }
})()

describe('Pi process isolation — the managed network policy binds a command', () => {
  let testRoot = ''
  let listener: Server | undefined

  afterEach(async () => {
    if (listener) await new Promise<void>(resolve => listener!.close(() => resolve()))
    listener = undefined
    if (testRoot) rmSync(testRoot, { recursive: true, force: true })
    testRoot = ''
  })

  const workspace = (): string => {
    testRoot = mkdtempSync(join(tmpdir(), 'nessy-egress-'))
    const workspaceRoot = join(testRoot, 'workspace')
    mkdirSync(join(testRoot, 'scratch'), { recursive: true })
    mkdirSync(workspaceRoot, { recursive: true })
    return workspaceRoot
  }

  test.skipIf(process.platform !== 'darwin')(
    'refuses a live connection under the managed deny and permits the identical one without it',
    async () => {
      const workspaceRoot = workspace()
      listener = createServer(socket => socket.end())
      const port = await new Promise<number>(resolve => {
        listener!.listen(0, '127.0.0.1', () => {
          const address = listener!.address()
          resolve(typeof address === 'object' && address ? address.port : 0)
        })
      })

      const connect = (denyNetworkEgress: boolean) => {
        const plan = resolveProcessIsolation({
          platform: 'darwin',
          profile: 'networked',
          command: '/bin/bash',
          args: ['-c', `exec 3<>/dev/tcp/127.0.0.1/${port} && echo CONNECTED`],
          workspaceRoot,
          workingDirectory: workspaceRoot,
          scratchRoot: join(testRoot, 'scratch'),
          ...(denyNetworkEgress ? { denyNetworkEgress: true } : {}),
        })
        return { plan, run: spawnSync(plan.command, plan.args, { encoding: 'utf8' }) }
      }

      const permitted = connect(false)
      expect(permitted.run.stdout.trim()).toBe('CONNECTED')
      expect(permitted.run.status).toBe(0)
      expect(permitted.plan.backend).not.toContain('managed-egress-denied')

      const refused = connect(true)
      expect(refused.run.stdout).not.toContain('CONNECTED')
      expect(refused.run.status).not.toBe(0)
      expect(refused.run.stderr).toContain('Operation not permitted')
      // The receipt has to say why, or an administrator debugging a refused
      // build cannot tell a policy from an outage.
      expect(refused.plan.backend).toContain('managed-egress-denied')
      expect(refused.plan.args[1]).toContain('(deny network*)')
      expect(refused.plan.profile).toBe('networked')
    },
  )

  test.skipIf(!hostEnforcesProcessIsolation)('takes the Linux network wrapper for a networked profile only under the managed deny', () => {
    const workspaceRoot = workspace()
    const base = {
      platform: 'linux' as const,
      profile: 'networked' as const,
      command: '/bin/echo',
      args: ['hi'],
      workspaceRoot,
      workingDirectory: workspaceRoot,
      scratchRoot: join(testRoot, 'scratch'),
    }
    // The Linux resolver composes a SEPARATE network launcher around the
    // filesystem one, so "the network branch ran" is visible as a second backend
    // in the receipt. Asserted that way rather than on the launcher's name
    // because `applyNetworkIsolation` picks its backend from the real
    // `process.platform`, not from the `platform` argument that chose this
    // resolver — on a macOS host the Linux path still lands on `sandbox-exec`.
    const networkLayers = (backend: string): string[] => backend.split(':host-read:')[0]!.split('+')
    expect(networkLayers(resolveProcessIsolation(base).backend)).toHaveLength(1)
    const denied = resolveProcessIsolation({ ...base, denyNetworkEgress: true })
    expect(networkLayers(denied.backend)).toHaveLength(2)
    expect(denied.backend).toContain('managed-egress-denied')
  })

  test('writes network enabled = false into the Windows profile under the managed deny', () => {
    const workspaceRoot = workspace()
    const stateRoot = join(testRoot, 'state')
    const runtimeRoot = join(testRoot, 'runtime')
    for (const path of [stateRoot, runtimeRoot]) mkdirSync(path, { recursive: true })
    const runtime = {
      command: join(runtimeRoot, 'codex.exe'),
      commandRunner: join(runtimeRoot, 'codex-command-runner.exe'),
      setupCommand: join(runtimeRoot, 'codex-windows-sandbox-setup.exe'),
    }
    for (const path of Object.values(runtime)) writeFileSync(path, 'verified-stub')

    const plan = resolveProcessIsolation({
      platform: 'win32',
      profile: 'networked',
      command: join(testRoot, 'powershell.exe'),
      args: [],
      workspaceRoot,
      workingDirectory: workspaceRoot,
      scratchRoot: join(testRoot, 'scratch'),
      environment: {},
      windowsSandboxStateRoot: stateRoot,
      windowsSandboxRuntime: runtime,
      verifyWindowsSandboxRuntime: () => undefined,
      denyNetworkEgress: true,
    })

    const configProfile = plan.args[plan.args.indexOf('--profile') + 1]
    const config = readFileSync(join(plan.environment!.CODEX_HOME!, `${configProfile}.config.toml`), 'utf8')
    expect(config).toContain('enabled = false')
    expect(plan.backend).toContain('managed-egress-denied')
  })
})
