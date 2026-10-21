import { existsSync, realpathSync } from 'node:fs'
import { delimiter, isAbsolute, join, relative, sep } from 'node:path'
import type { PluginNodeRuntimeBinding } from '@nessy-agent/shared/agent/backend'

export interface PluginHookProcessCommand {
  command: string
  args: string[]
  environment: Record<string, string>
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function usableRuntime(
  runtime: PluginNodeRuntimeBinding | undefined,
): runtime is PluginNodeRuntimeBinding {
  return !!runtime && isAbsolute(runtime.command) && existsSync(runtime.command)
}

function scopedRuntimeEnvironment(
  runtime: PluginNodeRuntimeBinding | undefined,
  hostEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Record<string, string> {
  if (!usableRuntime(runtime)) return {}
  const shimDirectory = runtime.nodeShimDirectory
  const shimName = platform === 'win32' ? 'node.cmd' : 'node'
  const shimAvailable = !!shimDirectory
    && isAbsolute(shimDirectory)
    && existsSync(join(shimDirectory, shimName))
  return {
    ...runtime.environment,
    NESSY_BUN: runtime.command,
    ...(shimAvailable ? {
      PATH: [shimDirectory, hostEnvironment.PATH].filter(Boolean).join(delimiter),
    } : {}),
  }
}

/**
 * Execute a trusted hook command in one shell where bare `node` is always a
 * host-owned function. The runtime environment is scoped to that one function
 * invocation (not every child process the hook may launch).
 *
 * Two documented forms (hooks.md § Exec form and shell form). Shell form is the
 * `eval` below: the whole `command` string is tokenized by the shell. Exec form
 * — selected by the caller passing `execForm` when the descriptor carries
 * `args` — never evaluates the string: the executable and its argument vector
 * arrive as positional parameters and `"$@"` runs them verbatim, so "each
 * `args` element is one argument exactly as written" and apostrophes, `$` and
 * backticks pass through with no shell to interpret them. `"$@"` is still a
 * simple-command lookup, so the host-owned `node` function keeps intercepting
 * the documented `{"command":"node","args":[…]}` shape.
 */
export function buildPluginHookShellCommand(
  runtime: PluginNodeRuntimeBinding | undefined,
  options: { execForm?: boolean } = {},
): string {
  const nodeInvocation = usableRuntime(runtime)
    ? [
        ...Object.entries(runtime.environment ?? {})
          .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          .map(([key, value]) => `${key}=${shellLiteral(value)}`),
        shellLiteral(runtime.command),
        '"$@"',
      ].join(' ')
    : undefined

  return [
    'cd -- "$NESSY_HOOK_CWD" || exit $?',
    'node() {',
    ...(nodeInvocation
      ? [`  ${nodeInvocation}`]
      : [
          '  printf "%s\\n" "plugin-node-runtime-unavailable" >&2',
          '  return 127',
        ]),
    '}',
    options.execForm ? '"$NESSY_HOOK_COMMAND" "$@"' : 'eval "$NESSY_HOOK_COMMAND"',
  ].join('\n')
}

/**
 * The shell-equivalent rendering of an exec-form hook, used for the permission
 * decision, the approval card and the transcript. The spawn itself never sees
 * this string — it takes the argument vector — but a `Bash(...)` rule and the
 * human approving the call must judge the whole invocation, not just the bare
 * executable name.
 */
export function formatExecFormHookCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(part => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : shellLiteral(part))).join(' ')
}

const windowsHookRunner = (execForm: boolean): string => [
  "$ErrorActionPreference = 'Stop'",
  'Set-Location -LiteralPath $env:NESSY_HOOK_CWD',
  // Imported plugin commands conventionally use ${PLUGIN_ROOT}-style tokens.
  // Mirror safe environment names into PowerShell variables before evaluation.
  "Get-ChildItem Env: | ForEach-Object { if ($_.Name -match '^[A-Za-z_][A-Za-z0-9_]*$') { Set-Variable -Scope Script -Name $_.Name -Value $_.Value } }",
  'function global:node {',
  '  if (-not $env:NESSY_PLUGIN_NODE) {',
  "    [Console]::Error.WriteLine('plugin-node-runtime-unavailable')",
  '    $global:LASTEXITCODE = 127',
  '    return',
  '  }',
  '  $bindings = @{}',
  '  if ($env:NESSY_PLUGIN_NODE_ENV_JSON) {',
  '    (ConvertFrom-Json $env:NESSY_PLUGIN_NODE_ENV_JSON).PSObject.Properties | ForEach-Object {',
  '      $bindings[$_.Name] = [Environment]::GetEnvironmentVariable($_.Name, \'Process\')',
  '      [Environment]::SetEnvironmentVariable($_.Name, [string]$_.Value, \'Process\')',
  '    }',
  '  }',
  '  try { & $env:NESSY_PLUGIN_NODE @args } finally {',
  '    foreach ($entry in $bindings.GetEnumerator()) {',
  '      [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, \'Process\')',
  '    }',
  '  }',
  '}',
  '$global:LASTEXITCODE = 0',
  // Exec form (hooks.md): no Invoke-Expression, so nothing re-parses the
  // executable or its arguments. The vector arrives as JSON in the environment
  // because PowerShell's `-Command` swallows trailing positional arguments into
  // the script text, unlike `sh -c`.
  ...(execForm
    ? [
        '$hookArgs = @()',
        'if ($env:NESSY_HOOK_ARGS_JSON) { $hookArgs = @(ConvertFrom-Json $env:NESSY_HOOK_ARGS_JSON) }',
        '& $env:NESSY_HOOK_COMMAND @hookArgs',
      ]
    : ['Invoke-Expression $env:NESSY_HOOK_COMMAND']),
  'exit $global:LASTEXITCODE',
].join('\n')

function resolveWindowsPowerShell(hostEnvironment: NodeJS.ProcessEnv): string | undefined {
  const root = hostEnvironment.SystemRoot ?? hostEnvironment.WINDIR
  if (!root || !isAbsolute(root) || !existsSync(root)) return undefined
  try {
    const canonicalRoot = realpathSync(root)
    const candidate = realpathSync(join(canonicalRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    const rel = relative(canonicalRoot, candidate)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
    return candidate
  } catch {
    return undefined
  }
}

/** Fixed pwsh install locations on darwin/linux; PATH is never consulted. */
const POSIX_PWSH_CANDIDATES = ['/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh', '/usr/bin/pwsh', '/snap/bin/pwsh']
/** Fixed bash locations; /bin/bash covers darwin and virtually every linux. */
const POSIX_BASH_CANDIDATES = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']

function firstExisting(candidates: readonly string[]): string | undefined {
  return candidates.find(candidate => existsSync(candidate))
}

/**
 * Select the host-owned platform shell explicitly. Windows uses the in-box
 * PowerShell executable below the validated SystemRoot and binds bare `node`
 * inside the script; neither shell nor Node is discovered through PATH.
 *
 * hooks.md § Command hook fields, `shell`: a hook may pick `"bash"` or
 * `"powershell"` for its shell-form spawn, and the same row's closing sentence
 * — "Ignored when `args` is set" — keeps exec form on the platform shell. A
 * requested shell that is not installed throws the stated
 * `plugin-hook-shell-unavailable:*` error rather than silently running the
 * command under a shell the author never chose.
 */
export function buildPluginHookProcessCommand(
  runtime: PluginNodeRuntimeBinding | undefined,
  options: {
    platform?: NodeJS.Platform
    hostEnvironment?: NodeJS.ProcessEnv
    /**
     * The descriptor's `args`. Its PRESENCE selects exec form, so an empty
     * array is exec form with no arguments — `undefined` is the only shell
     * form. The choice is made here, from the descriptor, never from the
     * environment the hook itself can observe.
     */
    execArgs?: readonly string[]
    /** The descriptor's `shell` (hooks.md). Ignored when `execArgs` is set. */
    shell?: 'bash' | 'powershell'
  } = {},
): PluginHookProcessCommand {
  const platform = options.platform ?? process.platform
  const hostEnvironment = options.hostEnvironment ?? process.env
  const execForm = options.execArgs !== undefined
  const declaredShell = execForm ? undefined : options.shell
  if (platform === 'win32' && declaredShell === 'bash') {
    // This runner has no Git Bash integration; a silent PowerShell run under
    // a `shell: "bash"` declaration would be the exact fallback the contract
    // forbids.
    throw new Error('plugin-hook-shell-unavailable:bash')
  }
  if (platform === 'win32' || declaredShell === 'powershell') {
    // The Windows runner script is plain PowerShell and runs identically under
    // `pwsh` on darwin/linux, environment bindings included.
    const command = platform === 'win32'
      ? resolveWindowsPowerShell(hostEnvironment)
      : firstExisting(POSIX_PWSH_CANDIDATES)
    if (!command) {
      throw new Error(platform === 'win32'
        ? 'plugin-hook-shell-unavailable:win32'
        : 'plugin-hook-shell-unavailable:powershell')
    }
    return {
      command,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        windowsHookRunner(execForm),
      ],
      environment: {
        ...(usableRuntime(runtime)
          ? {
              ...scopedRuntimeEnvironment(runtime, hostEnvironment, platform),
              NESSY_PLUGIN_NODE: runtime.command,
              NESSY_PLUGIN_NODE_ENV_JSON: JSON.stringify(runtime.environment ?? {}),
            }
          : {}),
        ...(execForm ? { NESSY_HOOK_ARGS_JSON: JSON.stringify(options.execArgs) } : {}),
      },
    }
  }
  const shellExecutable = declaredShell === 'bash' ? firstExisting(POSIX_BASH_CANDIDATES) : '/bin/sh'
  if (!shellExecutable || !existsSync(shellExecutable)) {
    throw new Error(`plugin-hook-shell-unavailable:${declaredShell ?? platform}`)
  }
  return {
    command: shellExecutable,
    args: [
      '-c',
      buildPluginHookShellCommand(runtime, { execForm }),
      // `$0` for the script; the hook's own arguments follow as `$1…`, which is
      // what `"$@"` expands to. Nothing here is re-tokenized.
      ...(execForm ? ['nessy-plugin-hook', ...options.execArgs!] : []),
    ],
    environment: scopedRuntimeEnvironment(runtime, hostEnvironment, platform),
  }
}
