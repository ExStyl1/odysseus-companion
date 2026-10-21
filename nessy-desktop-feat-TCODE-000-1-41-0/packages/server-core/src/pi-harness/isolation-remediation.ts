import type { ProcessIsolationProfile } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'

/**
 * The stable, machine-parseable head of every isolation-unavailable error.
 *
 * Log parsers and tests match on `<prefix>:<platform>:<profile>[:<reason>]`.
 * Remediation is APPENDED after {@link REMEDIATION_SEPARATOR}; the structure
 * ahead of it never changes.
 *
 * Deliberately a leaf module: `isolation.ts` and all three per-platform
 * backends throw through it, so it must not import any of them.
 */
export const ISOLATION_UNAVAILABLE_PREFIX = 'process-isolation-unavailable'

/** Separator between the parseable prefix and the human remediation. */
export const REMEDIATION_SEPARATOR = ' — '

/**
 * Where codex's Windows sandbox binaries keep their OWN diagnostics.
 *
 * Read from the codex SOURCE at `rust-v0.148.0`, which outranks the page for
 * this runtime: `windows-sandbox-rs/src/setup.rs` `sandbox_dir` joins
 * `.sandbox` onto `CODEX_HOME`, and `windows-sandbox-rs/src/logging.rs` builds
 * a DAILY rolling appender with prefix `sandbox`, suffix `log` and
 * `MAX_LOG_FILES = 90` — so the file on disk is `sandbox.<YYYY-MM-DD>.log`.
 *
 * It is deliberately NOT `windows-sandbox.log`. That name exists only as
 * `WINDOWS_SANDBOX_LOG_ATTACHMENT_FILENAME` in `feedback/src/lib.rs`, the
 * override codex renames the file to when uploading it to OpenAI, and the
 * shipped app-server carries the literal for exactly that path
 * (`request_processors/feedback_processor.rs` `windows_sandbox_log_attachment`).
 * Naming it here would send an operator looking for a file that never exists.
 *
 * The elevated setup helper writes `setup_error.json` into the same directory,
 * which is why this text is attached to the pre-launch toolchain failure too:
 * that is the case where the setup helper has already run and failed.
 */
const WINDOWS_SANDBOX_DIAGNOSTIC_DIRECTORY = '.sandbox\\'
const WINDOWS_SANDBOX_LOG_BASENAME_SHAPE = 'sandbox.<YYYY-MM-DD>.log'
const WINDOWS_SANDBOX_LOG_RETENTION = '90 files'
/** Sibling of the diagnostic directory, and the one an operator must not touch. */
const WINDOWS_SANDBOX_SECRETS_DIRECTORY = '.sandbox-secrets\\'

/**
 * The half of a read boundary no runtime can widen: a running one.
 *
 * A read grant is composed once, when the supervised process starts, and no
 * mid-session control exists anywhere — so an administrator who adds a path
 * after the session began sees nothing change and has, until now, been told
 * nothing. Measured per runtime rather than assumed:
 *
 * - **pi** — ours, and the boundary is an argument to
 *   `resolveProcessIsolation` at spawn; there is no re-resolve.
 * - **claude** — the only route is launch-time. The vendored SDK 2.1.247 says
 *   so itself: a directory "must resolve to a strict subdirectory of cwd, or of
 *   a directory passed at launch via --add-dir / the SDK additionalDirectories
 *   option" (the sentence still resolves at this bundle — 2 hits in the native
 *   binary, 1 in `sdk.d.ts`). Probed for a mid-session control request and it is
 *   a NULL, not an omission. Re-measured 2026-09-12 at `0.3.247` / `2.1.247`
 *   (C3.252), each count naming its instrument as lines/occurrences because on a
 *   minified artefact the two disagree (C3.294): `add_directory` and
 *   `addDirectory` are 0/0 in both `sdk.mjs` and `sdk.d.ts`, against controls
 *   `set_permission_mode` 1/1 and `setModel` 1/1 in both and `can_use_tool`
 *   1/2 in `sdk.mjs` and 8/8 in `sdk.d.ts`, with `zzz_not_real` 0/0 as the
 *   negative. **The NAME is no longer absent from the NATIVE BINARY and the
 *   verdict does not move** — `add_directory` scores 7/8 and `addDirectory` 4/4
 *   there, and read at their offsets every one belongs to a managed-remote
 *   container feature, not to a grant this host could use: the handler refuses
 *   unless `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is "set in the
 *   container environment", the `mount_path` must be under `/uploads/` or
 *   `/outputs/`, it wants a `CLAUDE_CODE_REMOTE_SESSION_ID`, and every
 *   `addDirectory` hit is the helper `addDirectoryDestFromMountPath`. On the
 *   ordinary control path the binary answers the subtype with
 *   `{kind:"reject"}`, beside `set_cwd` and `register_repo_root`. So the SDK
 *   surface a host drives still carries no such request.
 * - **codex** — `sandbox-add-read-dir` exists only in the TUI binary (2 hits in
 *   `win32-x64/codex.exe`) and is absent from both app-servers we actually
 *   drive (0 in `win32-x64/codex-app-server.exe`, 0 in
 *   `darwin-arm64/codex-app-server`).
 *
 * Stated once here and appended to the read-allowlist refusal, which is the
 * only sentence the host has ever spoken about read grants.
 */
export const READ_GRANT_IS_LAUNCH_TIME =
  'A read grant is fixed when the session\'s supervised process starts, on every runtime:'
  + ' Pi resolves it once per spawn, claude accepts it only at launch (--add-dir /'
  + ' additionalDirectories), and codex\'s sandbox-add-read-dir is a TUI command absent from'
  + ' the app-server we drive. A widened boundary applies to a NEW session, never to this one'

/**
 * What to do about one unavailable isolation case.
 *
 * Keyed by the same `platform`/`reason` pair the structured message already
 * carries, so a new throw site cannot invent a reason without landing here too.
 */
function remediationFor(
  platform: NodeJS.Platform,
  profile: ProcessIsolationProfile,
  reason?: string,
): string {
  // Platform-first, because this one is a refusal rather than a missing
  // dependency: nothing can be installed to make bwrap, firejail or the Windows
  // restricted-token profile express a read allowlist. Saying so is the point —
  // the alternative is running the command with the setting silently dropped.
  if (reason === 'read-allowlist') {
    return 'sandbox.filesystem.allowRead is configured and no isolation backend on this platform can enforce it;'
      + ' only macOS sandbox-exec has a rule that re-opens a subtree inside a denied one.'
      + ' Remove the setting to run here, or deploy it only to macOS hosts'
      + `. ${READ_GRANT_IS_LAUNCH_TIME}`
  }
  if (profile === 'isolated-code') {
    return 'the isolated-code profile is not implemented on any platform; use `workspace` for a write-scoped run or `read-only` for a scratch-only one'
  }
  if (platform === 'darwin') {
    return 'install or restore the host-owned /usr/bin/sandbox-exec; only a trusted absolute launcher is accepted, never one resolved from PATH'
  }
  if (platform === 'linux') {
    if (reason === 'network') {
      return 'install bwrap (bubblewrap), firejail or unshare so outbound network can be denied; the networked profile is the only one that does not need it'
    }
    return 'install bwrap (bubblewrap) or firejail so writes can be scoped to the workspace'
  }
  if (platform === 'win32') {
    if (reason === 'state-root') {
      return 'no host-owned Windows sandbox state root was supplied for this process; this is a host wiring fault, not a missing dependency'
    }
    return 'the Windows sandbox toolchain (codex.exe, codex-command-runner.exe, codex-windows-sandbox-setup.exe) is missing or failed sha256 manifest verification; reinstall the app to restore the pinned toolchain'
      + `; the binaries keep their own diagnostics under ${WINDOWS_SANDBOX_DIAGNOSTIC_DIRECTORY} of the state root we hand them as CODEX_HOME`
      + ` (${WINDOWS_SANDBOX_LOG_BASENAME_SHAPE}, rotated daily, ${WINDOWS_SANDBOX_LOG_RETENTION} kept, plus setup_error.json)`
      + `, and never read or copy ${WINDOWS_SANDBOX_SECRETS_DIRECTORY}, which holds the DPAPI-protected sandbox account secrets`
  }
  return `no process isolation backend exists for ${platform}; supervised processes cannot run here`
}

/**
 * Build one isolation-unavailable message: parseable prefix, then remediation.
 *
 * Every throw site goes through here so the reason vocabulary and the
 * remediation text cannot drift apart.
 */
export function isolationUnavailable(
  platform: NodeJS.Platform,
  profile: ProcessIsolationProfile,
  reason?: string,
): string {
  const structured = `${ISOLATION_UNAVAILABLE_PREFIX}:${platform}:${profile}${reason ? `:${reason}` : ''}`
  return `${structured}${REMEDIATION_SEPARATOR}${remediationFor(platform, profile, reason)}`
}

/** Split a caught isolation failure back into its structured reason segment. */
export function isolationUnavailableReason(
  message: string,
  platform: NodeJS.Platform,
  profile: string,
): string | undefined {
  const head = message.split(REMEDIATION_SEPARATOR)[0] ?? message
  const expected = `${ISOLATION_UNAVAILABLE_PREFIX}:${platform}:${profile}`
  if (!head.startsWith(expected)) return undefined
  const rest = head.slice(expected.length)
  return rest.startsWith(':') ? rest.slice(1) : undefined
}

/** The remediation half of a caught message, or the whole message when absent. */
export function isolationUnavailableRemediation(message: string): string {
  const parts = message.split(REMEDIATION_SEPARATOR)
  return parts.length > 1 ? parts.slice(1).join(REMEDIATION_SEPARATOR) : message
}
