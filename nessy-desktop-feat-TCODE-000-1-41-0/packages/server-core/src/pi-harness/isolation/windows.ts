import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { WindowsSandboxRuntimeBinding } from '@nessy-agent/shared/agent/backend'
import codexManifest from '@nessy-agent/codex-protocol/manifest.json' with { type: 'json' }
import type { ProcessIsolationInput, ProcessIsolationPlan } from '../isolation.ts'
import { isolationUnavailable } from '../isolation-remediation.ts'
import { FILESYSTEM_OFF_SCOPE, writeScopeLabel } from './write-scope-label.ts'

const EXPECTED_RUNTIME_NAMES = {
  command: 'codex.exe',
  commandRunner: 'codex-command-runner.exe',
  setupCommand: 'codex-windows-sandbox-setup.exe',
} as const

const PERMISSION_PROFILE_NAME = 'nessy-supervised-process'
const BASE_CONFIG = '# Host-owned Nessy Windows sandbox state.\n'

export interface WindowsSandboxCodexManifest {
  windowsSandbox?: Record<string, {
    files?: Record<string, { binarySha256?: string }>
  }>
}

const digestCache = new Map<string, {
  ctimeMs: number
  ino: number
  mtimeMs: number
  size: number
  sha256: string
}>()

function loadCodexManifest(): WindowsSandboxCodexManifest {
  return codexManifest as WindowsSandboxCodexManifest
}

function digest(path: string): string {
  const stats = statSync(path)
  const cached = digestCache.get(path)
  if (cached
    && cached.ctimeMs === stats.ctimeMs
    && cached.ino === stats.ino
    && cached.mtimeMs === stats.mtimeMs
    && cached.size === stats.size) return cached.sha256
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex').toLowerCase()
  digestCache.set(path, {
    ctimeMs: stats.ctimeMs,
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    sha256,
  })
  return sha256
}

/** Verify the complete sibling toolchain immediately before constructing a spawn plan. */
export function verifyWindowsSandboxRuntime(
  runtime: WindowsSandboxRuntimeBinding,
  manifest: WindowsSandboxCodexManifest = loadCodexManifest(),
): void {
  const canonical = Object.fromEntries(Object.entries(runtime).map(([key, path]) => {
    if (!isAbsolute(path)) throw new Error(`windows-sandbox-runtime-path-not-absolute:${key}`)
    return [key, realpathSync(path)]
  })) as unknown as WindowsSandboxRuntimeBinding
  const runtimeDirectory = dirname(canonical.command)
  for (const [key, expectedName] of Object.entries(EXPECTED_RUNTIME_NAMES)) {
    const path = canonical[key as keyof WindowsSandboxRuntimeBinding]
    if (dirname(path) !== runtimeDirectory || basename(path).toLowerCase() !== expectedName) {
      throw new Error(`windows-sandbox-runtime-layout-invalid:${key}`)
    }
  }

  const files = manifest.windowsSandbox?.['win32-x64']?.files
  if (!files) throw new Error('windows-sandbox-manifest-missing:win32-x64')
  for (const path of Object.values(canonical)) {
    const name = basename(path).toLowerCase()
    const expected = files[name]?.binarySha256?.toLowerCase()
    if (!expected) throw new Error(`windows-sandbox-manifest-file-missing:${name}`)
    if (digest(path) !== expected) throw new Error(`windows-sandbox-runtime-sha-mismatch:${name}`)
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function renderPermissionProfile(
  writableRoots: readonly string[],
  deniedReadRoots: readonly string[],
  deniedWriteRoots: readonly string[],
  networkEnabled: boolean,
  filesystemIsolationDisabled = false,
): string {
  // One TOML key per path, tighter value last: a root named by both a grant and
  // a deny must appear once, denied. Insertion order is write -> read-only ->
  // deny, and `Map.set` overwrites, so the tighter classification always wins.
  const filesystem = new Map<string, string>()
  for (const path of writableRoots) filesystem.set(path, 'write')
  for (const path of deniedWriteRoots) filesystem.set(path, 'read')
  for (const path of deniedReadRoots) filesystem.set(path, 'deny')
  return [
    `default_permissions = ${tomlString(PERMISSION_PROFILE_NAME)}`,
    '',
    '[shell_environment_policy]',
    'inherit = "all"',
    'ignore_default_excludes = true',
    'experimental_use_profile = false',
    '',
    '[windows]',
    // TWO DECIDED REFUSALS LIVE IN THIS LITERAL. Neither is an oversight, and an
    // undocumented choice nobody can see is indistinguishable from a defect
    // (AGENTS.md, "Where the documentation is silent: TRANSPARENT and SIMPLE").
    //
    // 1. `unelevated`, not `elevated` — owner decision D8 of 2026-09-05, option A
    //    ("keep `unelevated` and record it honestly"). codex supports a stronger
    //    Windows implementation, and we already SHIP the binary it needs:
    //    `codex-windows-sandbox-setup.exe` is located, `existsSync`-gated and
    //    `realpathSync`-resolved onto `WindowsSandboxRuntime.setupCommand` by
    //    `packages/shared/src/agent/backend/internal/runtime-resolver.ts`, and
    //    `verifyWindowsSandboxRuntime` above checks its layout and its pinned
    //    sha256 — and NOTHING EVER SPAWNS IT. Every other mention of
    //    `setupCommand` in this repo is a test or the type declaration; there is
    //    no `spawn`/`exec` site. Running it would provision local sandbox users
    //    and a secrets store on the user's own machine, i.e. a first-run cost
    //    for the operator, which cannot be priced without a Windows rig.
    // 2. Native Windows only, no WSL 2 session mode — owner answer to QI8 of
    //    2026-09-11, option A, taken under point 3 of the 2026-09-10 ruling
    //    (answer every open question now by the balance rule). The default does
    //    not change until a Windows rig exists.
    //
    // The product-visible consequence, stated rather than discovered: on Windows
    // this product ships the WEAKER of the two sandbox implementations codex
    // offers, and a user whose code lives inside WSL 2 gets an agent that does
    // not live where their code does.
    //
    // Both refusals unpark together the day a Windows rig exists: follow-up row
    // `D1.96` (carried from P3.7, whose park reason is "no Windows host on any
    // rig"). The separate question of what codex's OWN `[windows]` default is —
    // this is the only `[windows]` block this repo emits and it is the Pi one, so
    // for a codex session codex's own default governs, clamped by an admin's
    // `allowedWindowsSandboxImplementations` (codex's own
    // `ConfigRequirements`, `Array<WindowsSandboxSetupMode> | null`, which this
    // host reads and reports but does not apply) — is `D1.35`.
    'sandbox = "unelevated"',
    'sandbox_private_desktop = true',
    '',
    `[permissions.${PERMISSION_PROFILE_NAME}]`,
    'description = "Host-owned Nessy supervised process profile"',
    '',
    `[permissions.${PERMISSION_PROFILE_NAME}.filesystem]`,
    // `":root"` is the base posture and the one key the layer's absence changes:
    // read-only whole-disk with per-path grants, or writable whole-disk with only
    // the credential floor's `deny` entries left standing.
    `":root" = "${filesystemIsolationDisabled ? 'write' : 'read'}"`,
    ...[...filesystem].map(([path, permission]) => `${tomlString(path)} = "${permission}"`),
    '',
    `[permissions.${PERMISSION_PROFILE_NAME}.network]`,
    `enabled = ${networkEnabled ? 'true' : 'false'}`,
    '',
  ].join('\n')
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

function ensureProtectedConfig(configPath: string, config: string): void {
  try {
    const existing = readFileSync(configPath, 'utf8')
    if (existing !== config) throw new Error('windows-sandbox-profile-config-mismatch')
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
    const temporaryPath = join(dirname(configPath), `.config-${randomUUID()}.tmp`)
    try {
      writeFileSync(temporaryPath, config, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      try {
        renameSync(temporaryPath, configPath)
      } catch (renameError) {
        // A concurrent resolver may have installed the identical immutable
        // profile first. Any other result remains fail-closed.
        if (readFileSync(configPath, 'utf8') !== config) throw renameError
      }
    } finally {
      rmSync(temporaryPath, { force: true })
    }
  }

  const configStats = lstatSync(configPath)
  if (!configStats.isFile() || configStats.isSymbolicLink()) {
    throw new Error('windows-sandbox-profile-config-invalid')
  }
  chmodSync(configPath, 0o600)
}

function assertContained(root: string, candidate: string, errorCode: string): void {
  const rel = relative(root, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(errorCode)
  }
}

function ensureProtectedCodexHome(stateRoot: string, config: string): {
  codexHome: string
  configProfile: string
} {
  const canonicalStateRoot = realpathSync(stateRoot)
  const stateStats = lstatSync(canonicalStateRoot)
  if (!stateStats.isDirectory() || stateStats.isSymbolicLink()) {
    throw new Error('windows-sandbox-state-root-invalid')
  }
  chmodSync(canonicalStateRoot, 0o700)

  // Keep Codex's Windows sandbox setup/cache under one stable CODEX_HOME while
  // selecting an immutable, content-addressed profile for each exact root set.
  // This prevents setup churn without ever rewriting a profile used by another
  // concurrent plugin process.
  ensureProtectedConfig(join(canonicalStateRoot, 'config.toml'), BASE_CONFIG)
  const profileHash = createHash('sha256').update(config).digest('hex')
  const configProfile = `nessy-${profileHash}`
  const profilePath = join(canonicalStateRoot, `${configProfile}.config.toml`)
  assertContained(canonicalStateRoot, profilePath, 'windows-sandbox-profile-outside-state')
  ensureProtectedConfig(profilePath, config)
  return { codexHome: canonicalStateRoot, configProfile }
}

export function resolveWindowsIsolation(
  input: ProcessIsolationInput & {
    profile: Exclude<ProcessIsolationInput['profile'], 'none' | 'isolated-code'>
    scratchRoot: string
    windowsSandboxStateRoot: string
    /** The linked-worktree shared `.git` grant; see the darwin resolver. */
    sharedGitDirectory?: string
  },
): ProcessIsolationPlan {
  const runtime = input.windowsSandboxRuntime
  if (!runtime) throw new Error(isolationUnavailable('win32', input.profile, 'runtime'))
  try {
    ;(input.verifyWindowsSandboxRuntime ?? verifyWindowsSandboxRuntime)(runtime)
  } catch (error) {
    throw new Error(isolationUnavailable('win32', input.profile, 'runtime'), { cause: error })
  }

  const writesWorkspace = input.profile === 'workspace' || input.profile === 'networked'
  const writableRoot = writesWorkspace ? input.workspaceRoot : input.scratchRoot
  const writableRoots = [...new Set([
    writableRoot,
    ...(writesWorkspace ? [input.scratchRoot] : []),
    ...(input.additionalWritableRoots ?? []),
  ])]
  const deniedReadRoots = [...new Set(input.deniedReadRoots ?? [])]
  const deniedWriteRoots = [...new Set(input.deniedWriteRoots ?? [])]
  // The Windows profile's network dimension is the single `enabled` key
  // `renderPermissionProfile` writes, so the managed deny is expressible here
  // exactly as it is on the other two backends — and no more narrowly.
  const networkEnabled = input.denyNetworkEgress !== true
    && (input.profile === 'networked' || input.profile === 'plugin-mcp')
  const filesystemIsolationDisabled = input.filesystemIsolationDisabled === true
  const writeScope = filesystemIsolationDisabled
    ? FILESYSTEM_OFF_SCOPE
    : writeScopeLabel({
        writesWorkspace,
        ...(input.additionalWritableRoots ? { additionalWritableRoots: input.additionalWritableRoots } : {}),
        ...(input.sharedGitDirectory ? { sharedGitDirectory: input.sharedGitDirectory } : {}),
      })
  const config = renderPermissionProfile(
    writableRoots,
    deniedReadRoots,
    deniedWriteRoots,
    networkEnabled,
    filesystemIsolationDisabled,
  )
  const { codexHome, configProfile } = ensureProtectedCodexHome(input.windowsSandboxStateRoot, config)
  const args = [
    'sandbox',
    '--profile', configProfile,
    '--permissions-profile', PERMISSION_PROFILE_NAME,
    '--cd', input.workingDirectory,
    '--', input.command, ...input.args,
  ]

  return {
    command: runtime.command,
    args,
    environment: {
      ...(input.environment ?? {}),
      CODEX_HOME: codexHome,
    },
    backend: `codex-windows-restricted-token:host-read:${writeScope}:${networkEnabled ? 'network-enabled' : 'network-restricted'}${input.denyNetworkEgress === true ? ':managed-egress-denied' : ''}`,
    profile: input.profile,
  }
}
