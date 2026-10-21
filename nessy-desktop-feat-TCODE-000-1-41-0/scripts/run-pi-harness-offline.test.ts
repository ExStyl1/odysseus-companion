import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  A0_PHASE_MANIFEST,
  parseBunTestSummary,
  parseOfflineCliArgs,
  parseRunnerCliArgs,
  resolveCommandCwd,
  runOfflineCommand,
  runPhaseAcceptance,
  shouldStripOfflineEnv,
} from './run-pi-harness-offline.ts'

const RUNNER_PATH = fileURLToPath(new URL('./run-pi-harness-offline.ts', import.meta.url))
const cleanupPaths = new Set<string>()

interface FixtureRepository {
  root: string
  subdir: string
  runner: string
  probe: string
  cwdProbe: string
  argvProbe: string
  exitProbe: string
  outputProbe: string
  networkProbe: string
  directProbe: string
  signalProbe: string
  heldPipeProbe: string
  heldPipeDriver: string
  tracked: string
  untracked: string
}

afterEach(() => {
  for (const path of cleanupPaths) rmSync(path, { recursive: true, force: true })
  cleanupPaths.clear()
})

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  cleanupPaths.add(path)
  return path
}

function runHost(command: string[], cwd?: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env: {
      HOME: '/var/empty',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    throw new Error('fixture command failed: ' + result.stderr.toString())
  }
  return result.stdout.toString()
}

function fixtureRepo(): FixtureRepository {
  const root = temp('nessy-offline-repo-')
  const subdir = join(root, 'packages', 'fixture')
  const scripts = join(root, 'scripts')
  const sensitiveDir = join(root, 'nested', 'credentials')
  mkdirSync(subdir, { recursive: true })
  mkdirSync(scripts, { recursive: true })
  mkdirSync(sensitiveDir, { recursive: true })

  const runner = join(scripts, 'run-pi-harness-offline.ts')
  const probe = join(root, 'probe.ts')
  const cwdProbe = join(subdir, 'cwd-probe.ts')
  const argvProbe = join(root, 'argv-probe.ts')
  const exitProbe = join(root, 'exit-probe.ts')
  const outputProbe = join(root, 'output-probe.ts')
  const networkProbe = join(root, 'network-probe.ts')
  const directProbe = join(root, 'direct-probe.ts')
  const signalProbe = join(root, 'signal-probe.ts')
  const heldPipeProbe = join(root, 'held-pipe-probe.rb')
  const heldPipeDriver = join(root, 'held-pipe-driver.ts')
  const tracked = join(root, 'tracked.txt')
  const untracked = join(root, 'untracked.txt')
  const nodeShebangProbe = join(root, 'node_modules', '.bin', 'node-shebang-probe')
  const nodeShebangCli = join(root, 'node_modules', 'probe-package', 'bin', 'cli.js')

  copyFileSync(RUNNER_PATH, runner)
  writeFileSync(join(root, '.gitignore'), ['.env', '.env.*', '.npmrc', ''].join('\n'))
  writeFileSync(join(root, '.env'), 'AMBIENT_ENV_SHOULD_NOT_LOAD=leaked\n')
  writeFileSync(join(root, '.npmrc'), '//registry.example.invalid/:_authToken=forbidden\n')
  writeFileSync(join(sensitiveDir, '.env.local'), 'NESTED_ENV_SHOULD_NOT_LOAD=leaked\n')
  writeFileSync(join(sensitiveDir, '.yarnrc'), 'npmAuthToken forbidden\n')
  writeFileSync(join(sensitiveDir, '.pypirc'), 'password=forbidden\n')
  writeFileSync(join(sensitiveDir, '.netrc'), 'password forbidden\n')
  writeFileSync(tracked, 'source-original')
  writeFileSync(untracked, 'untracked-current-state')
  mkdirSync(dirname(nodeShebangProbe), { recursive: true })
  mkdirSync(dirname(nodeShebangCli), { recursive: true })
  writeFileSync(nodeShebangCli, [
    '#!/usr/bin/env node',
    "console.log('node-bin-ok')",
  ].join('\n'))
  chmodSync(nodeShebangCli, 0o755)
  symlinkSync('../probe-package/bin/cli.js', nodeShebangProbe)
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: { 'node-shebang-probe': 'node-shebang-probe' },
  }))

  writeFileSync(probe, [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "function attempt(path: string) {",
    "  let readable = false",
    "  let writable = false",
    "  let readError: string | undefined",
    "  let writeError: string | undefined",
    "  try { readFileSync(path, 'utf8'); readable = true } catch (error) { readError = (error as NodeJS.ErrnoException).code }",
    "  try { writeFileSync(path, 'tampered'); writable = true } catch (error) { writeError = (error as NodeJS.ErrnoException).code }",
    "  return { readable, writable, readError, writeError }",
    "}",
    "const envNames = [",
    "  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',",
    "  'TMPDIR', 'TEMP', 'TMP', 'NESSY_CONFIG_DIR', 'NESSY_DATA_DIR',",
    "  'NESSY_CACHE_DIR', 'NESSY_TEMP_DIR', 'NESSY_REPOSITORIES_DIR',",
    "  'NESSY_WORKSPACES_DIR', 'NESSY_SESSION_ROOT', 'BUN_INSTALL_CACHE_DIR',",
    "  'npm_config_offline', 'NPM_CONFIG_OFFLINE', 'YARN_ENABLE_NETWORK',",
    "  'CARGO_NET_OFFLINE', 'PIP_NO_INDEX', 'PIP_DISABLE_PIP_VERSION_CHECK',",
    "  'UV_OFFLINE', 'GIT_TERMINAL_PROMPT', 'HOMEBREW_NO_AUTO_UPDATE', 'NESSY_OFFLINE',",
    "  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY',",
    "  'NESSY_DP_AUTH_TOKEN', 'NESSY_FEATURE_PROVIDER_CLAUDE', 'RUN_LIVE_PROVIDER_TEST',",
    "  'GITHUB_TOKEN', 'HTTP_PROXY', 'SSH_AUTH_SOCK', 'CI_JOB_JWT', 'CI_JOB_JWT_V2',",
    "  'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig', 'GIT_CONFIG_GLOBAL',",
    "  'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',",
    "  'NODE_OPTIONS', 'BUN_OPTIONS', 'BUN_CONFIG_VERBOSE_FETCH',",
    "  'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'UNLISTED_AMBIENT',",
    "  'LC_API_KEY',",
    "  'AMBIENT_ENV_SHOULD_NOT_LOAD'",
    "]",
    "const git = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'pipe' })",
    "const trackedBefore = readFileSync('tracked.txt', 'utf8')",
    "writeFileSync('tracked.txt', 'copy-mutated')",
    "console.log(JSON.stringify({",
    "  cwd: process.cwd(),",
    "  argv: process.argv.slice(2),",
    "  execArgv: process.execArgv,",
    "  env: Object.fromEntries(envNames.map(name => [name, process.env[name]])),",
    "  envKeys: Object.keys(process.env).sort(),",
    "  envFileExists: existsSync(join(process.cwd(), '.env')),",
    "  npmrcExists: existsSync(join(process.cwd(), '.npmrc')),",
    "  trackedBefore,",
    "  untracked: readFileSync('untracked.txt', 'utf8'),",
    "  gitExit: git.exitCode,",
    "  gitTopLevel: git.stdout.toString().trim(),",
    "  gitStderr: git.stderr.toString().trim(),",
    "  realHomeSentinel: attempt(process.argv[2]),",
    "  authConfig: attempt(process.argv[3]),",
    "  sourceTracked: attempt(process.argv[4]),",
    "}))",
  ].join('\n'))
  writeFileSync(cwdProbe, [
    "console.log(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }))",
  ].join('\n'))
  writeFileSync(argvProbe, [
    "console.log(JSON.stringify(process.argv.slice(2)))",
  ].join('\n'))
  writeFileSync(exitProbe, 'process.exit(Number(process.argv[2] ?? 0))\n')
  writeFileSync(outputProbe, [
    "const stdoutChunk = 'o'.repeat(65536)",
    "const stderrChunk = 'e'.repeat(65536)",
    "for (let index = 0; index < 32; index += 1) {",
    "  process.stdout.write(stdoutChunk)",
    "  process.stderr.write(stderrChunk)",
    "}",
  ].join('\n'))
  writeFileSync(networkProbe, [
    "import http from 'node:http'",
    "const server = http.createServer((_request, response) => response.end('loopback-ok'))",
    "await new Promise<void>((resolve, reject) => {",
    "  server.once('error', reject)",
    "  server.listen(0, '127.0.0.1', resolve)",
    "})",
    "try {",
    "  const address = server.address()",
    "  if (!address || typeof address === 'string') throw new Error('loopback-address-missing')",
    "  const local = await (await fetch(`http://127.0.0.1:${address.port}`)).text()",
    "  const external = await fetch('http://192.0.2.1:9', { signal: AbortSignal.timeout(500) })",
    "    .then(() => 'connected', () => 'blocked')",
    "  console.log(JSON.stringify({ local, external }))",
    "} finally {",
    "  await new Promise<void>(resolve => server.close(() => resolve()))",
    "}",
  ].join('\n'))
  writeFileSync(directProbe, [
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "function readable(path: string) { try { readFileSync(path, 'utf8'); return true } catch { return false } }",
    "function writable(path: string) { try { writeFileSync(path, 'tampered'); return true } catch { return false } }",
    "const workspacePath = process.env.NESSY_WORKSPACES_DIR",
    "if (!workspacePath) throw new Error('isolated-workspace-missing')",
    "mkdirSync(workspacePath, { recursive: true })",
    "const workspaceSentinel = join(workspacePath, 'direct-probe.txt')",
    "writeFileSync(workspaceSentinel, 'workspace-ok')",
    "console.log(JSON.stringify({",
    "  cwd: process.cwd(),",
    "  sourceReadable: readable('tracked.txt'),",
    "  sourceWritable: writable('tracked.txt'),",
    "  envReadable: readable('.env'),",
    "  npmrcReadable: readable('.npmrc'),",
    "  nestedEnvReadable: readable('nested/credentials/.env.local'),",
    "  yarnrcReadable: readable('nested/credentials/.yarnrc'),",
    "  pypircReadable: readable('nested/credentials/.pypirc'),",
    "  netrcReadable: readable('nested/credentials/.netrc'),",
    "  realHomeReadable: readable(process.argv[2]),",
    "  authConfigReadable: readable(process.argv[3]),",
    "  workspacePath,",
    "  workspaceWritable: readFileSync(workspaceSentinel, 'utf8') === 'workspace-ok',",
    "}))",
  ].join('\n'))
  const grandchildCode = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  writeFileSync(signalProbe, [
    "const grandchild = Bun.spawn([process.execPath, '--no-env-file', '--no-install', '--no-orphans', '-e', "
      + JSON.stringify(grandchildCode)
      + "], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })",
    "process.stdout.write(JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid, root: process.env.HOME }) + '\\n')",
    "process.on('SIGTERM', () => {})",
    "setInterval(() => {}, 1000)",
  ].join('\n'))
  writeFileSync(heldPipeProbe, [
    'descendant_pid = fork do',
    "  %w[HUP INT TERM].each { |signal| Signal.trap(signal, 'IGNORE') }",
    '  loop { sleep 60 }',
    'end',
    'File.write(ARGV.fetch(0), %Q({"childPid":#{Process.pid},"descendantPid":#{descendant_pid},"root":"#{ENV.fetch(\'HOME\')}"}\\n))',
    "STDOUT.syswrite('held-pipe-ready\\n')",
    'exit! 0',
  ].join('\n'))
  writeFileSync(heldPipeDriver, [
    "import { runOfflineCommand } from './scripts/run-pi-harness-offline.ts'",
    'const marker = process.argv[2]',
    'const tempParent = process.argv[3]',
    "if (!marker || !tempParent) throw new Error('held-pipe-driver-args-required')",
    'const result = await runOfflineCommand({',
    '  repoRoot: process.cwd(),',
    "  command: ['synthetic-held-pipe-child'],",
    '  captureOutput: true,',
    '  tempParent,',
    '}, {',
    "  sandboxExecutable: '/usr/bin/true',",
    '  spawnChild: ((_command, options) => Bun.spawn([',
    "    '/usr/bin/ruby',",
    "    './held-pipe-probe.rb',",
    '    marker,',
    '  ], options)) as typeof Bun.spawn,',
    '})',
    'process.exitCode = result.exitCode',
  ].join('\n'))

  runHost(['/usr/bin/git', 'init', '-q', root])
  runHost(['/usr/bin/git', '-C', root, 'add', '.gitignore', 'tracked.txt'])
  runHost(['/usr/bin/git', '-C', root, 'add', '-f', '.env', '.npmrc'])
  return {
    root,
    subdir,
    runner,
    probe,
    cwdProbe,
    argvProbe,
    exitProbe,
    outputProbe,
    networkProbe,
    directProbe,
    signalProbe,
    heldPipeProbe,
    heldPipeDriver,
    tracked,
    untracked,
  }
}

// `options` must not carry stdio: spreading a value whose type still admits
// `stdout`/`stderr` defeats Bun.spawn's inference of the literal 'pipe'
// below, and `child.stdout` widens to `number | ReadableStream | undefined`.
async function spawnAndCollect(
  command: string[],
  options: Omit<NonNullable<Parameters<typeof Bun.spawn>[1]>, 'stdout' | 'stderr'> = {},
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  const child = Bun.spawn(command, {
    ...options,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  // `stdout`/`stderr` are pinned to 'pipe' above, so both are streams; Bun's
  // generic signature cannot narrow that through the `...options` spread and
  // leaves them as `number | ReadableStream | undefined`.
  const stdoutPromise = new Response(child.stdout as ReadableStream<Uint8Array<ArrayBuffer>>).text()
  const stderrPromise = new Response(child.stderr as ReadableStream<Uint8Array<ArrayBuffer>>).text()
  const exitCode = await child.exited
  return {
    exitCode,
    stdout: await stdoutPromise,
    stderr: await stderrPromise,
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + '-timeout')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Structural, so it accepts a reader from either the global `ReadableStream`
// or `node:stream/web` — with `types: ["bun", "node"]` both declarations are in
// the program and they are not mutually assignable.
type ByteStreamReader = { read(): Promise<{ done: boolean; value?: Uint8Array<ArrayBuffer> | undefined }> }

async function readFirstLine(reader: ByteStreamReader): Promise<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  while (!buffer.includes('\n')) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error('signal-probe-ended-before-ready')
    buffer += decoder.decode(chunk.value, { stream: true })
  }
  return buffer.slice(0, buffer.indexOf('\n'))
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function waitForPidExit(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000
  while (pidExists(pid)) {
    if (Date.now() >= deadline) throw new Error('pid-still-alive:' + pid)
    await Bun.sleep(25)
  }
}

describe('offline runner CLI contract', () => {
  test('parses repository-relative cwd and preserves a literal child separator', () => {
    expect(parseOfflineCliArgs([
      '--cwd',
      'packages/shared',
      '--',
      'bun',
      'test',
      '--',
      'literal',
    ])).toEqual({
      cwd: 'packages/shared',
      command: ['bun', 'test', '--', 'literal'],
    })
    expect(() => parseOfflineCliArgs(['bun', 'test'])).toThrow('Usage:')
    expect(() => parseOfflineCliArgs(['--'])).toThrow('offline-runner-command-required')
    expect(parseOfflineCliArgs([
      '--direct-readonly',
      '--cwd',
      'packages/shared',
      '--',
      'bun',
      'test',
    ])).toEqual({
      directReadonly: true,
      cwd: 'packages/shared',
      command: ['bun', 'test'],
    })
  })

  test('accepts relative cwd and rejects absolute, traversal, missing, and symlink escapes', () => {
    const repo = fixtureRepo()
    expect(resolveCommandCwd(repo.root, 'packages/fixture')).toBe(realpathSync(repo.subdir))
    expect(() => resolveCommandCwd(repo.root, '/tmp')).toThrow('offline-runner-cwd-absolute')
    expect(() => resolveCommandCwd(repo.root, '../outside')).toThrow('offline-runner-cwd-traversal')
    expect(() => resolveCommandCwd(repo.root, 'missing')).toThrow('offline-runner-cwd-outside-repository')
    const outside = temp('nessy-offline-outside-')
    symlinkSync(outside, join(repo.root, 'escape'), 'dir')
    expect(() => resolveCommandCwd(repo.root, 'escape')).toThrow('offline-runner-cwd-symlink-escape')
  })

  test('uses a minimal ambient allowlist and strips auth, loaders, providers, live flags, and proxies', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'NESSY_DP_AUTH_TOKEN',
      'NESSY_FEATURE_PROVIDER_CLAUDE',
      'NESSY_FEATURE_CODEX_RUNTIME',
      'RUN_LIVE_PROVIDER_TEST',
      'GITHUB_TOKEN',
      'HTTPS_PROXY',
      'SSH_AUTH_SOCK',
      'CI_JOB_JWT',
      'CI_JOB_JWT_V2',
      'NPM_CONFIG_USERCONFIG',
      'npm_config_userconfig',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'NODE_OPTIONS',
      'BUN_OPTIONS',
      'BUN_CONFIG_VERBOSE_FETCH',
      'DYLD_INSERT_LIBRARIES',
      'LD_PRELOAD',
      'LC_API_KEY',
      'UNLISTED_AMBIENT',
    ]) {
      expect(shouldStripOfflineEnv(name)).toBe(true)
    }
    expect(shouldStripOfflineEnv('LANG')).toBe(false)
    expect(shouldStripOfflineEnv('LC_CTYPE')).toBe(false)
  })
})

// Needs the real darwin sandbox-exec backend; Linux CI runners can't run it.
describe.skipIf(process.platform !== 'darwin')('offline runner fail-closed disposable isolation', () => {
  test('copies current state, isolates roots, denies direct real paths, strips ambient config, and preserves the source', async () => {
    const repo = fixtureRepo()
    const parent = temp('nessy-offline-parent-')
    const canonicalParent = realpathSync(parent)
    const realHome = temp('nessy-real-home-')
    const sentinel = join(realHome, 'real-home-sentinel')
    const authConfig = join(realHome, '.npmrc')
    const sshAgent = join(realHome, 'ssh-agent.sock')
    writeFileSync(sentinel, 'unchanged')
    writeFileSync(authConfig, 'forbidden-auth')
    writeFileSync(sshAgent, 'not-a-real-socket')

    const result = await runOfflineCommand({
      repoRoot: repo.root,
      command: [process.execPath, './probe.ts', sentinel, authConfig, repo.tracked],
      captureOutput: true,
      tempParent: parent,
      environment: {
        ...process.env,
        HOME: realHome,
        USERPROFILE: realHome,
        ANTHROPIC_API_KEY: 'forbidden',
        OPENAI_API_KEY: 'forbidden',
        AWS_SECRET_ACCESS_KEY: 'forbidden',
        NESSY_DP_AUTH_TOKEN: 'forbidden',
        NESSY_FEATURE_PROVIDER_CLAUDE: '1',
        RUN_LIVE_PROVIDER_TEST: '1',
        GITHUB_TOKEN: 'forbidden',
        HTTP_PROXY: 'http://forbidden.invalid',
        SSH_AUTH_SOCK: sshAgent,
        CI_JOB_JWT: 'forbidden',
        CI_JOB_JWT_V2: 'forbidden',
        NPM_CONFIG_USERCONFIG: authConfig,
        npm_config_userconfig: authConfig,
        GIT_CONFIG_GLOBAL: authConfig,
        GIT_CONFIG_SYSTEM: authConfig,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: 'forbidden',
        NODE_OPTIONS: '--require=' + authConfig,
        BUN_OPTIONS: '--preload=' + authConfig,
        BUN_CONFIG_VERBOSE_FETCH: '1',
        DYLD_INSERT_LIBRARIES: authConfig,
        LD_PRELOAD: authConfig,
        LC_API_KEY: 'forbidden',
        UNLISTED_AMBIENT: 'forbidden',
      },
    })

    if (result.exitCode !== 0) throw new Error(`isolated probe failed: ${result.stderr}`)
    expect(result.exitCode).toBe(0)
    const observed = JSON.parse(result.stdout.trim()) as {
      cwd: string
      argv: string[]
      execArgv: string[]
      env: Record<string, string | undefined>
      envKeys: string[]
      envFileExists: boolean
      npmrcExists: boolean
      trackedBefore: string
      untracked: string
      gitExit: number
      gitTopLevel: string
      gitStderr: string
      realHomeSentinel: { readable: boolean; writable: boolean }
      authConfig: { readable: boolean; writable: boolean }
      sourceTracked: { readable: boolean; writable: boolean }
    }
    expect(observed.cwd.startsWith(canonicalParent)).toBe(true)
    expect(observed.cwd).not.toBe(realpathSync(repo.root))
    expect(observed.argv).toEqual([sentinel, authConfig, repo.tracked])
    for (const flag of ['--no-env-file', '--no-install', '--prefer-offline', '--no-orphans']) {
      expect(observed.execArgv).toContain(flag)
    }
    expect(observed.envFileExists).toBe(false)
    expect(observed.npmrcExists).toBe(false)
    expect(observed.trackedBefore).toBe('source-original')
    expect(observed.untracked).toBe('untracked-current-state')
    if (observed.gitExit !== 0) throw new Error(`sandbox git failed: ${observed.gitStderr}`)
    expect(observed.gitExit).toBe(0)
    expect(observed.gitTopLevel).toBe(observed.cwd)
    expect(observed.realHomeSentinel).toMatchObject({ readable: false, writable: false })
    expect(observed.authConfig).toMatchObject({ readable: false, writable: false })
    expect(observed.sourceTracked).toMatchObject({ readable: false, writable: false })
    expect(readFileSync(sentinel, 'utf8')).toBe('unchanged')
    expect(readFileSync(authConfig, 'utf8')).toBe('forbidden-auth')
    expect(readFileSync(repo.tracked, 'utf8')).toBe('source-original')
    expect(readFileSync(repo.untracked, 'utf8')).toBe('untracked-current-state')

    const isolatedRoots = [
      'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
      'TMPDIR', 'TEMP', 'TMP', 'NESSY_CONFIG_DIR', 'NESSY_DATA_DIR',
      'NESSY_CACHE_DIR', 'NESSY_TEMP_DIR', 'NESSY_REPOSITORIES_DIR',
      'NESSY_WORKSPACES_DIR', 'NESSY_SESSION_ROOT', 'BUN_INSTALL_CACHE_DIR',
    ]
    for (const name of isolatedRoots) {
      expect(observed.env[name]?.startsWith(canonicalParent)).toBe(true)
      expect(observed.env[name]).not.toBe(realHome)
    }
    for (const name of [
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY',
      'NESSY_DP_AUTH_TOKEN', 'NESSY_FEATURE_PROVIDER_CLAUDE',
      'RUN_LIVE_PROVIDER_TEST', 'GITHUB_TOKEN', 'HTTP_PROXY', 'SSH_AUTH_SOCK',
      'CI_JOB_JWT', 'CI_JOB_JWT_V2', 'NPM_CONFIG_USERCONFIG',
      'npm_config_userconfig', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
      'NODE_OPTIONS', 'BUN_CONFIG_VERBOSE_FETCH',
      'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'UNLISTED_AMBIENT',
      'LC_API_KEY',
      'AMBIENT_ENV_SHOULD_NOT_LOAD',
    ]) {
      expect(observed.env[name]).toBeUndefined()
    }
    expect(observed.env.npm_config_offline).toBe('true')
    expect(observed.env.NPM_CONFIG_OFFLINE).toBe('true')
    expect(observed.env.YARN_ENABLE_NETWORK).toBe('0')
    expect(observed.env.CARGO_NET_OFFLINE).toBe('true')
    expect(observed.env.PIP_NO_INDEX).toBe('1')
    expect(observed.env.PIP_DISABLE_PIP_VERSION_CHECK).toBe('1')
    expect(observed.env.UV_OFFLINE).toBe('1')
    expect(observed.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(observed.env.HOMEBREW_NO_AUTO_UPDATE).toBe('1')
    expect(observed.env.NESSY_OFFLINE).toBe('1')
    expect(observed.env.BUN_OPTIONS).toBe('--no-env-file')
    const permittedEnvKeys = new Set([
      'COLORTERM', 'FORCE_COLOR', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
      'NO_COLOR', 'TERM', 'TZ', 'PATH', ...isolatedRoots,
      'npm_config_offline', 'NPM_CONFIG_OFFLINE', 'YARN_ENABLE_NETWORK',
      'CARGO_NET_OFFLINE', 'PIP_NO_INDEX', 'PIP_DISABLE_PIP_VERSION_CHECK',
      'UV_OFFLINE', 'GIT_TERMINAL_PROMPT', 'HOMEBREW_NO_AUTO_UPDATE', 'NESSY_OFFLINE',
      'BUN_OPTIONS',
    ])
    for (const name of observed.envKeys) expect(permittedEnvKeys.has(name)).toBe(true)
    expect(readdirSync(parent)).toEqual([])
  }, 120_000)

  test('runs from a read-only source checkout with sensitive files hidden and a writable isolated workspace', async () => {
    const repo = fixtureRepo()
    const parent = temp('nessy-offline-direct-')
    const realHome = temp('nessy-direct-real-home-')
    const sentinel = join(realHome, 'real-home-sentinel')
    const authConfig = join(realHome, '.npmrc')
    writeFileSync(sentinel, 'unchanged')
    writeFileSync(authConfig, 'forbidden-auth')

    const result = await runOfflineCommand({
      repoRoot: repo.root,
      directReadonly: true,
      command: [process.execPath, './direct-probe.ts', sentinel, authConfig],
      captureOutput: true,
      tempParent: parent,
      environment: { ...process.env, HOME: realHome, USERPROFILE: realHome },
    }, {
      copyRepository: () => { throw new Error('copy-called-in-direct-mode') },
    })
    if (result.exitCode !== 0) throw new Error(`direct probe failed: ${result.stderr}`)
    const observed = JSON.parse(result.stdout.trim()) as {
      cwd: string
      sourceReadable: boolean
      sourceWritable: boolean
      envReadable: boolean
      npmrcReadable: boolean
      nestedEnvReadable: boolean
      yarnrcReadable: boolean
      pypircReadable: boolean
      netrcReadable: boolean
      realHomeReadable: boolean
      authConfigReadable: boolean
      workspacePath: string
      workspaceWritable: boolean
    }
    expect(result.exitCode).toBe(0)
    expect(observed.cwd).toBe(realpathSync(repo.root))
    expect(observed.sourceReadable).toBe(true)
    expect(observed.sourceWritable).toBe(false)
    expect(observed.envReadable).toBe(false)
    expect(observed.npmrcReadable).toBe(false)
    expect(observed.nestedEnvReadable).toBe(false)
    expect(observed.yarnrcReadable).toBe(false)
    expect(observed.pypircReadable).toBe(false)
    expect(observed.netrcReadable).toBe(false)
    expect(observed.realHomeReadable).toBe(false)
    expect(observed.authConfigReadable).toBe(false)
    expect(observed.workspaceWritable).toBe(true)
    expect(observed.workspacePath.startsWith(realpathSync(parent))).toBe(true)
    expect(readFileSync(sentinel, 'utf8')).toBe('unchanged')
    expect(readFileSync(authConfig, 'utf8')).toBe('forbidden-auth')
    expect(readFileSync(repo.tracked, 'utf8')).toBe('source-original')
    expect(readdirSync(parent)).toEqual([])
  }, 120_000)

  test('rejects lexical and symlink-resolved temp parents inside the source before creating them', async () => {
    const repo = fixtureRepo()
    const lexicalUnsafe = join(repo.root, 'unsafe-direct-temp')
    await expect(runOfflineCommand({
      repoRoot: repo.root,
      directReadonly: true,
      command: [process.execPath, './argv-probe.ts'],
      tempParent: lexicalUnsafe,
    })).rejects.toThrow('offline-runner-temp-overlaps-source')
    expect(existsSync(lexicalUnsafe)).toBe(false)

    const aliases = temp('nessy-offline-temp-alias-')
    const sourceAlias = join(aliases, 'source')
    const symlinkUnsafe = join(sourceAlias, 'unsafe-via-symlink')
    symlinkSync(repo.root, sourceAlias, 'dir')
    await expect(runOfflineCommand({
      repoRoot: repo.root,
      directReadonly: true,
      command: [process.execPath, './argv-probe.ts'],
      tempParent: symlinkUnsafe,
    })).rejects.toThrow('offline-runner-temp-overlaps-source')
    expect(existsSync(join(repo.root, 'unsafe-via-symlink'))).toBe(false)
  }, 120_000)

  test('runs package scripts with node shebangs under isolated Bun', async () => {
    const repo = fixtureRepo()
    const parent = temp('nessy-offline-node-shebang-')
    const result = await runOfflineCommand({
      repoRoot: repo.root,
      directReadonly: true,
      command: ['bun', 'run', 'node-shebang-probe'],
      captureOutput: true,
      tempParent: parent,
    })
    if (result.exitCode !== 0) throw new Error(`node shebang probe failed: ${result.stderr}`)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('node-bin-ok')
    expect(readdirSync(parent)).toEqual([])
  }, 120_000)

  test('allows loopback IPC while blocking non-loopback TEST-NET traffic', async () => {
    const repo = fixtureRepo()
    const parent = temp('nessy-offline-loopback-')
    const result = await runOfflineCommand({
      repoRoot: repo.root,
      directReadonly: true,
      command: [process.execPath, './network-probe.ts'],
      captureOutput: true,
      tempParent: parent,
    })
    if (result.exitCode !== 0) throw new Error(`loopback probe failed: ${result.stderr}`)
    expect(JSON.parse(result.stdout.trim())).toEqual({ local: 'loopback-ok', external: 'blocked' })
    expect(readdirSync(parent)).toEqual([])
  }, 120_000)

  test('runs an exact real CLI vector with relative cwd and preserves a literal child separator', async () => {
    const repo = fixtureRepo()
    const parent = temp('nessy-offline-cli-')
    const canonicalParent = realpathSync(parent)
    const result = await spawnAndCollect([
      process.execPath,
      repo.runner,
      '--cwd',
      'packages/fixture',
      '--',
      process.execPath,
      './cwd-probe.ts',
      'alpha',
      '--',
      'omega',
    ], {
      cwd: repo.root,
      env: { ...process.env, TMPDIR: parent },
    })
    expect(result.exitCode).toBe(0)
    const observed = JSON.parse(result.stdout.trim()) as { cwd: string; argv: string[] }
    expect(observed.cwd).toBe(join(dirname(observed.cwd), 'fixture'))
    expect(observed.cwd.startsWith(canonicalParent)).toBe(true)
    expect(observed.argv).toEqual(['alpha', '--', 'omega'])
    expect(readdirSync(parent)).toEqual([])
  }, 120_000)

  test('fails closed when the native sandbox backend is unavailable and cleans its root', async () => {
    const repo = fixtureRepo()
    const parent = temp('nessy-offline-no-sandbox-')
    await expect(runOfflineCommand({
      repoRoot: repo.root,
      command: [process.execPath, './argv-probe.ts'],
      tempParent: parent,
      captureOutput: true,
    }, {
      sandboxExecutable: null,
    })).rejects.toThrow('offline-runner-isolation-unavailable')
    expect(readdirSync(parent)).toEqual([])
  }, 120_000)

  test('propagates child success and failure exit codes and cleans both roots', async () => {
    const repo = fixtureRepo()
    const parent = temp('nessy-offline-exits-')
    const success = await runOfflineCommand({
      repoRoot: repo.root,
      command: [process.execPath, './exit-probe.ts', '0'],
      captureOutput: true,
      tempParent: parent,
    })
    expect(success.exitCode).toBe(0)
    expect(readdirSync(parent)).toEqual([])
    const failure = await runOfflineCommand({
      repoRoot: repo.root,
      command: [process.execPath, './exit-probe.ts', '37'],
      captureOutput: true,
      tempParent: parent,
    })
    expect(failure.exitCode).toBe(37)
    expect(readdirSync(parent)).toEqual([])
  }, 120_000)

  test('drains large stdout and stderr concurrently without deadlock', async () => {
    const repo = fixtureRepo()
    const result = await runOfflineCommand({
      repoRoot: repo.root,
      command: [process.execPath, './output-probe.ts'],
      captureOutput: true,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.length).toBe(32 * 65_536)
    expect(result.stderr.length).toBeGreaterThanOrEqual(32 * 65_536)
  }, 120_000)

  test('terminates a descendant that retains inherited pipes after the root exits and cleans the disposable root', async () => {
    const repo = fixtureRepo()
    const parent = temp('nessy-offline-held-pipe-')
    const control = temp('nessy-offline-held-pipe-control-')
    const marker = join(control, 'processes.json')
    const canonicalParent = realpathSync(parent)
    const runner = Bun.spawn([
      process.execPath,
      repo.heldPipeDriver,
      marker,
      parent,
    ], {
      cwd: repo.root,
      env: process.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdoutPromise = new Response(runner.stdout).text()
    const stderrPromise = new Response(runner.stderr).text()
    let childPid: number | undefined
    let descendantPid: number | undefined
    try {
      const markerDeadline = Date.now() + 60_000
      while (!existsSync(marker)) {
        if (runner.exitCode !== null) {
          throw new Error(`held-pipe-driver-exited:${runner.exitCode}:${await stderrPromise}`)
        }
        if (Date.now() >= markerDeadline) throw new Error('held-pipe-marker-timeout')
        await Bun.sleep(25)
      }
      const ready = JSON.parse(readFileSync(marker, 'utf8')) as {
        childPid: number
        descendantPid: number
        root: string
      }
      childPid = ready.childPid
      descendantPid = ready.descendantPid
      expect(ready.root.startsWith(canonicalParent)).toBe(true)
      expect(pidExists(descendantPid)).toBe(true)
      expect(await withTimeout(runner.exited, 10_000, 'held-pipe-runner-exit')).toBe(0)
      await waitForPidExit(descendantPid)
      expect(readdirSync(parent)).toEqual([])
      await stdoutPromise
      await stderrPromise
    } finally {
      if (childPid) {
        try { process.kill(-childPid, 'SIGKILL') } catch {}
      }
      if (descendantPid && pidExists(descendantPid)) {
        try { process.kill(descendantPid, 'SIGKILL') } catch {}
      }
      if (runner.exitCode === null) runner.kill('SIGKILL')
      await withTimeout(runner.exited, 5_000, 'held-pipe-diagnostic-reap').catch(() => undefined)
      await Promise.allSettled([stdoutPromise, stderrPromise])
    }
  }, 120_000)

  test('cleans the disposable root when process creation throws', async () => {
    const repo = fixtureRepo()
    const parent = temp('nessy-offline-throw-')
    await expect(runOfflineCommand({
      repoRoot: repo.root,
      command: [process.execPath, './argv-probe.ts'],
      tempParent: parent,
    }, {
      spawnChild: (() => {
        throw new Error('spawn-boom')
      }) as typeof Bun.spawn,
    })).rejects.toThrow('spawn-boom')
    expect(readdirSync(parent)).toEqual([])
  }, 120_000)

  test('forwards signals to the child process group, escalates, reaps descendants, and cleans roots', async () => {
    const repo = fixtureRepo()
    const parent = temp('nessy-offline-signal-')
    const canonicalParent = realpathSync(parent)
    const runner = Bun.spawn([
      process.execPath,
      repo.runner,
      '--direct-readonly',
      '--',
      process.execPath,
      './signal-probe.ts',
    ], {
      cwd: repo.root,
      env: { ...process.env, TMPDIR: parent },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdoutReader = runner.stdout.getReader()
    const stderrPromise = new Response(runner.stderr).text()
    let childPid: number | undefined
    let grandchildPid: number | undefined
    try {
      const readyLine = await withTimeout(readFirstLine(stdoutReader), 60_000, 'signal-ready')
      const ready = JSON.parse(readyLine) as { childPid: number; grandchildPid: number; root: string }
      childPid = ready.childPid
      grandchildPid = ready.grandchildPid
      expect(ready.root.startsWith(canonicalParent)).toBe(true)
      expect(pidExists(childPid)).toBe(true)
      expect(pidExists(grandchildPid)).toBe(true)
      runner.kill('SIGTERM')
      expect(await withTimeout(runner.exited, 30_000, 'runner-signal-exit')).toBe(143)
      await Promise.all([waitForPidExit(childPid), waitForPidExit(grandchildPid)])
      expect(readdirSync(parent)).toEqual([])
      await stderrPromise
    } finally {
      stdoutReader.releaseLock()
      if (runner.exitCode === null) runner.kill('SIGKILL')
      for (const pid of [childPid, grandchildPid]) {
        if (!pid || !pidExists(pid)) continue
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
    }
  }, 120_000)
})

describe('A0 phase acceptance', () => {
  const manifest = {
    id: 'A0',
    gate: 'pi-session-lineage-real-server',
    testPaths: ['phase-probe.test.ts'],
    expected: { pass: 2, fail: 0, expect: 38 },
  } as const

  test('parses only the built-in A0 phase acceptance command', () => {
    expect(parseRunnerCliArgs(['--phase-acceptance', 'A0'])).toEqual({
      kind: 'phase-acceptance',
      phase: 'A0',
    })
    expect(() => parseRunnerCliArgs(['--phase-acceptance', 'H1A'])).toThrow(
      'unsupported phase acceptance: H1A',
    )
    expect(() => parseRunnerCliArgs(['--phase-acceptance', 'A0', '--', 'bun', 'test'])).toThrow()
    expect(A0_PHASE_MANIFEST).toEqual({
      id: 'A0',
      gate: 'pi-session-lineage-real-server',
      testPaths: ['packages/pi-agent-server/src/__tests__/pi-session-lineage-real-server.test.ts'],
      expected: { pass: 7, fail: 0, expect: 63 },
    })
  })

  test('parses one ANSI-safe line-anchored Bun summary and rejects missing or ambiguous summaries', () => {
    const summary = '\u001b[32m 2 pass\u001b[0m\n 0 fail\n 38 expect() calls\n'
    expect(parseBunTestSummary(summary)).toEqual({ pass: 2, fail: 0, expect: 38 })
    expect(() => parseBunTestSummary('2 pass inside diagnostics')).toThrow('missing Bun test summary')
    expect(() => parseBunTestSummary(`${summary}${summary}`)).toThrow('ambiguous Bun test summary')
  })

  test('prechecks every manifest path before invoking isolation', async () => {
    const repoRoot = temp('nessy-phase-missing-')
    let invoked = false
    await expect(runPhaseAcceptance(manifest, {
      repoRoot,
      runOffline: async () => {
        invoked = true
        throw new Error('must-not-run')
      },
    })).rejects.toThrow('phase acceptance path does not exist: phase-probe.test.ts')
    expect(invoked).toBe(false)
  })

  test('rejects empty, invalid, directory, and symlinked manifest paths before isolation', async () => {
    const repoRoot = temp('nessy-phase-paths-')
    const directory = join(repoRoot, 'tests')
    const realFile = join(directory, 'real.test.ts')
    const symlink = join(repoRoot, 'linked.test.ts')
    const symlinkedDirectory = join(repoRoot, 'linked-tests')
    mkdirSync(directory)
    writeFileSync(realFile, 'test("probe", () => {})\n')
    symlinkSync(realFile, symlink)
    symlinkSync(directory, symlinkedDirectory)
    let invoked = 0
    const runOffline = async () => {
      invoked += 1
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const reject = async (testPaths: readonly string[], message: string) => {
      await expect(runPhaseAcceptance({ ...manifest, testPaths }, { repoRoot, runOffline })).rejects.toThrow(message)
    }

    await reject([], 'phase acceptance manifest A0 has no test paths')
    await reject([''], 'phase acceptance path is invalid: ')
    await reject(['bad\0path'], 'phase acceptance path is invalid: bad\\0path')
    await reject(['/absolute.test.ts'], 'phase acceptance path is invalid: /absolute.test.ts')
    await reject(['C:/absolute.test.ts'], 'phase acceptance path is invalid: C:/absolute.test.ts')
    await reject(['C:relative.test.ts'], 'phase acceptance path is invalid: C:relative.test.ts')
    await reject(['tests\\real.test.ts'], 'phase acceptance path is invalid: tests\\real.test.ts')
    await reject(['../outside.test.ts'], 'phase acceptance path is invalid: ../outside.test.ts')
    await reject(['tests'], 'phase acceptance path is not a regular file: tests')
    await reject(['linked.test.ts'], 'phase acceptance path is not canonical: linked.test.ts')
    await reject(['linked-tests/real.test.ts'], 'phase acceptance path is not canonical: linked-tests/real.test.ts')
    await reject(['tests/./real.test.ts'], 'phase acceptance path is invalid: tests/./real.test.ts')
    expect(invoked).toBe(0)
  })

  test('accepts a canonical nested forward-slash manifest path', async () => {
    const repoRoot = temp('nessy-phase-nested-')
    mkdirSync(join(repoRoot, 'tests'))
    writeFileSync(join(repoRoot, 'tests', 'real.test.ts'), 'test("probe", () => {})\n')
    let invoked = 0
    const result = await runPhaseAcceptance({ ...manifest, testPaths: ['tests/real.test.ts'] }, {
      repoRoot,
      runOffline: async () => {
        invoked += 1
        return { exitCode: 0, stdout: ' 2 pass\n 0 fail\n 38 expect() calls\n', stderr: '' }
      },
      writeStdout: () => undefined,
    })
    expect(invoked).toBe(1)
    expect(result.pass).toBe(2)
  })

  test('runs the exact manifest through one direct-readonly isolation and reports truthful counts', async () => {
    const repoRoot = temp('nessy-phase-success-')
    writeFileSync(join(repoRoot, manifest.testPaths[0]), 'test("probe", () => {})\n')
    const calls: unknown[] = []
    const stdout: string[] = []
    let now = 1_000
    const result = await runPhaseAcceptance(manifest, {
      repoRoot,
      now: () => (now += 125),
      writeStdout: (value: string) => stdout.push(value),
      runOffline: async (options: unknown) => {
        calls.push(options)
        return {
          exitCode: 0,
          signal: null,
          stdout: ' 2 pass\n 0 fail\n 38 expect() calls\n',
          stderr: 'child diagnostic\n',
        }
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      repoRoot: realpathSync(repoRoot),
      directReadonly: true,
      captureOutput: true,
      command: [process.execPath, 'test', './phase-probe.test.ts'],
    })
    expect(result).toMatchObject({
      phase: 'A0',
      gate: manifest.gate,
      exitCode: 0,
      pass: 2,
      fail: 0,
      expect: 38,
      durationMs: 125,
    })
    expect(stdout.join('')).toContain(
      'phase=A0 gate=pi-session-lineage-real-server exit=0 pass=2 fail=0 expect=38 duration_ms=125',
    )
  })

  test('fails closed on nonzero exit or expected-count drift while preserving diagnostics', async () => {
    const repoRoot = temp('nessy-phase-failure-')
    writeFileSync(join(repoRoot, manifest.testPaths[0]), 'test("probe", () => {})\n')
    const stdout: string[] = []
    const stderr: string[] = []
    const baseOptions = {
      repoRoot,
      writeStdout: (value: string) => stdout.push(value),
      writeStderr: (value: string) => stderr.push(value),
    }

    await expect(runPhaseAcceptance(manifest, {
      ...baseOptions,
      runOffline: async () => ({
        exitCode: 7,
        signal: null,
        stdout: ' 1 pass\n 1 fail\n 9 expect() calls\n',
        stderr: 'fixture failure\n',
      }),
    })).rejects.toThrow('phase acceptance A0 exited 7')
    expect(stdout.join('')).toContain(' 1 pass')
    expect(stderr.join('')).toContain('fixture failure')

    stdout.length = 0
    stderr.length = 0
    await expect(runPhaseAcceptance(manifest, {
      ...baseOptions,
      runOffline: async () => ({
        exitCode: 7,
        stdout: 'raw child output without a Bun summary\n',
        stderr: 'raw child error\n',
      }),
    })).rejects.toThrow('phase acceptance A0 exited 7')
    expect(stdout.join('')).toContain('raw child output without a Bun summary')
    expect(stderr.join('')).toContain('raw child error')
    expect(stdout.join('')).toContain(
      'phase=A0 gate=pi-session-lineage-real-server exit=7 pass=unavailable fail=unavailable expect=unavailable',
    )

    await expect(runPhaseAcceptance(manifest, {
      ...baseOptions,
      runOffline: async () => ({
        exitCode: 0,
        signal: null,
        stdout: ' 2 pass\n 0 fail\n 37 expect() calls\n',
        stderr: '',
      }),
    })).rejects.toThrow(
      'phase acceptance A0 count drift: expected 2/0/38, received 2/0/37',
    )
  })
})
