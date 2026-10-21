/**
 * bypassPermissions refuses root/sudo outside a recognized container.
 *
 * Contract: `code.claude.com/docs/en/permission-modes.md`: "On Linux and
 * macOS, Claude Code refuses to start in this mode when running as root or
 * under sudo … The check is skipped automatically inside a recognized
 * sandbox."
 *
 * Windows has no POSIX effective-uid concept and that sentence names only
 * "Linux and macOS", so `platform === 'win32'` always passes without even
 * consulting `euid`. A "recognized sandbox" is a container, recognized four
 * ways: the Docker/Podman marker files, the `container` env var, the
 * Kubernetes service env, and the init process's cgroup naming a container
 * runtime. The first version stopped at the two marker files and a concrete
 * host immediately disproved that scope — see the note above
 * {@link CONTAINER_ENV_VARS}.
 *
 * Pure decision function otherwise: its only I/O is the injectable
 * `containerMarker` (defaults to a real filesystem check), so the two host
 * acceptance points (`SessionManager.createSession`,
 * `SessionManager.setSessionPermissionMode`) can call it with no arguments in
 * production while tests drive every branch hermetically.
 */
import { existsSync, readFileSync } from 'node:fs'

/** Marker files Docker and Podman write into every container's root filesystem. */
const CONTAINER_MARKERS = ['/.dockerenv', '/run/.containerenv'] as const

/**
 * Container detection beyond the two marker files — added from a MEASURED miss,
 * not speculation: this repo's GitLab CI runs the test job as root in a
 * Kubernetes pod, which has neither `/.dockerenv` nor `/run/.containerenv`, so
 * the guard refused `bypassPermissions` in exactly the environment the contract
 * exempts ("The check is skipped automatically inside a recognized sandbox") and
 * a pre-existing parentless-mode test went red on pipeline #121280633.
 *
 * - `container` env: systemd-nspawn, LXC and Podman set it on PID 1's children.
 * - `KUBERNETES_SERVICE_HOST` env: injected into every Kubernetes pod container.
 * - `/proc/1/cgroup`: on Linux under Docker/containerd/CRI-O/LXC the init
 *   process's cgroup path names the runtime. Best effort — cgroup v2 often
 *   yields a bare `0::/`, which is why the env signals come first.
 */
const CONTAINER_ENV_VARS = ['container', 'KUBERNETES_SERVICE_HOST'] as const
const CGROUP_RUNTIME = /docker|kubepods|containerd|crio|libpod|lxc|buildkit/

/**
 * Thrown by {@link assertBypassPermittedForProcess}. `code` follows this
 * repo's coded-error convention (compare `tool-executor.ts`'s file-local
 * `CodedError`) — branch on `.code`, not `instanceof`, since identity does
 * not survive a subprocess/IPC boundary.
 */
export class BypassPermissionsRootRefusedError extends Error {
  readonly code = 'bypass-permissions-root-refused' as const

  constructor() {
    super('bypassPermissions cannot be used with root/sudo privileges for security reasons')
    this.name = 'BypassPermissionsRootRefusedError'
  }
}

export interface AssertBypassPermittedForProcessOptions {
  /** Effective UID to evaluate. Defaults to `process.geteuid?.()`. */
  euid?: number
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /**
   * Returns whether the given container-marker path exists. Defaults to a
   * real filesystem check. Inject in tests so nothing here ever touches the
   * real filesystem or depends on the host it runs on.
   */
  containerMarker?: (path: string) => boolean
  /** Environment to consult for the container env signals. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /**
   * Returns `/proc/1/cgroup`'s content, or empty when unreadable. Defaults to a
   * real best-effort read on linux and `''` elsewhere.
   */
  readInitCgroup?: () => string
}

/**
 * Refuses `bypassPermissions` for a process running as root/sudo, unless it
 * is inside a recognized container. Call this at every site that ACCEPTS a
 * resolved `permissionMode` of `'bypassPermissions'` (session create, the
 * mid-session mode-switch acceptance point) — never at a display/read site.
 *
 * No-ops (never throws) when:
 * - `platform` is `'win32'` (no POSIX root concept there), or
 * - the effective uid is not 0 (the ordinary desktop case), or
 * - `geteuid` is unavailable and no explicit `euid` was given (fails open —
 *   a host where the concept does not apply, not a reason to refuse every
 *   session), or
 * - a recognized container marker is present.
 *
 * @throws {BypassPermissionsRootRefusedError} when none of the above apply.
 */
export function assertBypassPermittedForProcess(
  options: AssertBypassPermittedForProcessOptions = {},
): void {
  if (isBypassPermittedForProcess(options)) return
  throw new BypassPermissionsRootRefusedError()
}

/**
 * Whether a clamped arriving mode still needs the authoritative mode state
 * reconciled, even though it now equals the session's own mode.
 *
 * The host's agent-mode-change handler early-returns when the arriving mode
 * equals the session's — normally correct, since there is nothing to change.
 * It is wrong for a CLAMPED arrival, and that is not a corner case: the agent
 * writes the mode-manager singleton BEFORE telling the host, and the permission
 * gate reads that singleton. On a refusing host the session mode is already
 * `default` (the load-time clamp put it there), so a restored `bypassPermissions`
 * clamps to an equal value, hits the early return, and leaves the singleton
 * saying bypass — under a log line claiming the refusal happened. The two halves
 * of the same protection would cancel each other out.
 *
 * Pure so the rule is provable: reconstructing it needs a live agent
 * subprocess, which no unit harness here has.
 */
export function arrivingModeNeedsReconcile<TMode extends string>(args: {
  /** What the agent reported. */
  arriving: TMode
  /** What the host clamp turned it into. */
  clamped: TMode
  /** What the session already holds. */
  managed: TMode
}): boolean {
  return args.clamped === args.managed && args.arriving !== args.clamped
}

/**
 * The same decision as {@link assertBypassPermittedForProcess}, as a boolean.
 *
 * Exists because not every site that meets a `bypassPermissions` can THROW.
 * The two original doors are user REQUESTS — "put this session in bypass now" —
 * and refusing a request is the honest answer. But a persisted session being
 * restored, a session bundle being imported, and an agent reporting the mode it
 * has already entered are DATA arriving, not requests: throwing there would
 * make a whole session unloadable, or an entire import fail, over one field.
 * Those sites downgrade instead (see `SessionManager`), and they need the
 * predicate rather than the exception to do it.
 */
export function isBypassPermittedForProcess(
  options: AssertBypassPermittedForProcessOptions = {},
): boolean {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return true

  const euid = options.euid ?? process.geteuid?.()
  if (euid !== 0) return true

  const markerPresent = options.containerMarker ?? existsSync
  if (CONTAINER_MARKERS.some(marker => markerPresent(marker))) return true

  const env = options.env ?? process.env
  if (CONTAINER_ENV_VARS.some(name => (env[name] ?? '') !== '')) return true

  const readInitCgroup = options.readInitCgroup ?? defaultReadInitCgroup
  return CGROUP_RUNTIME.test(readInitCgroup())
}

function defaultReadInitCgroup(): string {
  if (process.platform !== 'linux') return ''
  try {
    return readFileSync('/proc/1/cgroup', 'utf8')
  } catch {
    return ''
  }
}
