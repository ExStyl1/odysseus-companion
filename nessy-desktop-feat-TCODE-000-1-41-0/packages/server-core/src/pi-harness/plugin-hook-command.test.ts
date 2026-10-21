import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildPluginHookProcessCommand, buildPluginHookShellCommand } from './plugin-hook-command'

describe('plugin hook command runtime', () => {
  test('binds bare node to the host runtime even when PATH has no node', () => {
    const result = spawnSync('/bin/sh', ['-c', buildPluginHookShellCommand({
      command: process.execPath,
      environment: { ELECTRON_RUN_AS_NODE: '1' },
    })], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        NESSY_HOOK_CWD: process.cwd(),
        NESSY_HOOK_COMMAND: "true && node -e 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE || \"missing\")'",
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('1')
  })

  test('exposes the packaged node shim only inside the hook process environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-hook-shim-'))
    try {
      const shim = join(root, process.platform === 'win32' ? 'node.cmd' : 'node')
      writeFileSync(shim, 'host-owned-stub')
      const plan = buildPluginHookProcessCommand({
        command: process.execPath,
        nodeShimDirectory: root,
      }, { hostEnvironment: { PATH: '/host/bin' } })

      expect(plan.environment.NESSY_BUN).toBe(process.execPath)
      expect(plan.environment.PATH?.split(process.platform === 'win32' ? ';' : ':')[0]).toBe(root)
      expect(process.env.PATH?.split(process.platform === 'win32' ? ';' : ':')[0]).not.toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('fails closed instead of falling back to a PATH node', () => {
    const result = spawnSync('/bin/sh', ['-c', buildPluginHookShellCommand(undefined)], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        NESSY_HOOK_CWD: process.cwd(),
        NESSY_HOOK_COMMAND: "node -e 'process.stdout.write(\"path-node-leaked\")'",
      },
    })

    expect(result.status).toBe(127)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('plugin-node-runtime-unavailable')
  })

  test('rejects a relative runtime binding', () => {
    const result = spawnSync('/bin/sh', ['-c', buildPluginHookShellCommand({ command: 'node' })], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        NESSY_HOOK_CWD: process.cwd(),
        NESSY_HOOK_COMMAND: 'node --version',
      },
    })

    expect(result.status).toBe(127)
    expect(result.stderr).toContain('plugin-node-runtime-unavailable')
  })

  test('runs an exec-form hook from its argument vector without a shell parse', () => {
    // hooks.md § Exec form and shell form: `args` present means the executable
    // is spawned directly with that vector, so "each `args` element is one
    // argument exactly as written" and `$`, backticks and apostrophes survive.
    // The wrapper still has to bind bare `node` to the host runtime, which is
    // why exec form runs through the same shell without ever evaluating a
    // string: `"$NESSY_HOOK_COMMAND" "$@"` is a simple-command lookup.
    const argv = ['-e', 'process.stdout.write(process.argv[1])', '$HOME `id` \'x\'; rm -rf /']
    const plan = buildPluginHookProcessCommand({
      command: process.execPath,
      environment: { ELECTRON_RUN_AS_NODE: '1' },
    }, { execArgs: argv })

    expect(plan.args.slice(2)).toEqual(['nessy-plugin-hook', ...argv])
    const result = spawnSync(plan.command, plan.args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        NESSY_HOOK_CWD: process.cwd(),
        NESSY_HOOK_COMMAND: 'node',
        ...plan.environment,
      },
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('$HOME `id` \'x\'; rm -rf /')
  })

  test('carries the exec-form vector to the Windows runner as JSON, never as script text', () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-hook-windows-exec-'))
    try {
      const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      mkdirSync(dirname(powershell), { recursive: true })
      writeFileSync(powershell, 'host-owned-stub')

      const plan = buildPluginHookProcessCommand({ command: process.execPath }, {
        platform: 'win32',
        hostEnvironment: { SystemRoot: root },
        execArgs: ['--fix'],
      })

      // PowerShell's `-Command` folds trailing positional arguments into the
      // script text, so the vector travels in the environment instead — and the
      // script calls the executable with `&`, never Invoke-Expression.
      expect(plan.environment.NESSY_HOOK_ARGS_JSON).toBe('["--fix"]')
      expect(plan.args.at(-1)).toContain('& $env:NESSY_HOOK_COMMAND @hookArgs')
      expect(plan.args.at(-1)).not.toContain('Invoke-Expression')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('selects an absolute host-owned Windows PowerShell runner without PATH discovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-hook-windows-'))
    try {
      const powershell = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      mkdirSync(dirname(powershell), { recursive: true })
      writeFileSync(powershell, 'host-owned-stub')

      const plan = buildPluginHookProcessCommand({
        command: process.execPath,
        environment: { ELECTRON_RUN_AS_NODE: '1' },
      }, {
        platform: 'win32',
        hostEnvironment: { SystemRoot: root, PATH: join(root, 'untrusted-path') },
      })

      expect(plan.command).toBe(realpathSync(powershell))
      expect(plan.args).toContain('-NoProfile')
      expect(plan.args).toContain('-NonInteractive')
      expect(plan.environment).toMatchObject({
        NESSY_PLUGIN_NODE: process.execPath,
        NESSY_PLUGIN_NODE_ENV_JSON: JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' }),
      })
      expect(plan.command).not.toContain('untrusted-path')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('fails closed when the host-owned Windows hook shell is missing', () => {
    expect(() => buildPluginHookProcessCommand({ command: process.execPath }, {
      platform: 'win32',
      hostEnvironment: { SystemRoot: join(tmpdir(), 'missing-windows-root') },
    })).toThrow('plugin-hook-shell-unavailable:win32')
  })

  // hooks.md § Command hook fields, `shell` — the per-hook interpreter choice.
  test('a hook declaring shell bash runs under a fixed bash path', () => {
    const plan = buildPluginHookProcessCommand(undefined, { platform: 'darwin', shell: 'bash' })
    expect(plan.command.endsWith('/bash')).toBe(true)
  })

  test('a declared powershell without pwsh installed is a stated error, never a bash fallback', () => {
    const pwshInstalled = ['/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh', '/usr/bin/pwsh', '/snap/bin/pwsh']
      .some(candidate => existsSync(candidate))
    if (pwshInstalled) {
      const plan = buildPluginHookProcessCommand(undefined, { platform: 'darwin', shell: 'powershell' })
      expect(plan.command.endsWith('/pwsh')).toBe(true)
      expect(plan.args).toContain('-NonInteractive')
    } else {
      expect(() => buildPluginHookProcessCommand(undefined, { platform: 'darwin', shell: 'powershell' }))
        .toThrow('plugin-hook-shell-unavailable:powershell')
    }
  })

  test('exec form ignores the shell field ("Ignored when `args` is set")', () => {
    const plan = buildPluginHookProcessCommand(undefined, { platform: 'darwin', shell: 'powershell', execArgs: ['lint.js'] })
    expect(plan.command).toBe('/bin/sh')
  })

  test('a declared bash on the PowerShell-only Windows runner is a stated error', () => {
    expect(() => buildPluginHookProcessCommand(undefined, { platform: 'win32', shell: 'bash' }))
      .toThrow('plugin-hook-shell-unavailable:bash')
  })
})
