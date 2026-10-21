import { applyFilesystemIsolation } from '@nessy-agent/session-tools-core'
import type { ProcessIsolationProfile } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import { isolationUnavailable } from '../isolation-remediation.ts'
import { FILESYSTEM_OFF_SCOPE, writeScopeLabel } from './write-scope-label.ts'

export function resolveDarwinIsolation(input: {
  profile: Exclude<ProcessIsolationProfile, 'none'>
  command: string
  args: string[]
  workspaceRoot: string
  scratchRoot: string
  additionalWritableRoots?: readonly string[]
  /**
   * Set when the workspace root is a linked worktree and the grant is the main
   * repository's shared `.git` (`sandboxing.md:314`). Carried only so the receipt
   * distinguishes it from a managed-data grant; the path itself already travels in
   * {@link additionalWritableRoots}.
   */
  sharedGitDirectory?: string
  deniedReadRoots?: readonly string[]
  /**
   * `sandbox.filesystem.allowRead`, already composed with the roots a command
   * cannot run without. darwin is the ONE backend that can express it
   * (`sandboxing.md:176`); the other two refuse in `resolveProcessIsolation`.
   */
  allowedReadRoots?: readonly string[]
  /** The host credential floor, emitted after every administrator read rule. */
  unconditionalDeniedReadRoots?: readonly string[]
  deniedWriteRoots?: readonly string[]
  denyNetworkEgress?: boolean
  /** `sandbox.filesystem.disabled`; see `isolation.ts`. */
  filesystemIsolationDisabled?: boolean
}) {
  const writableRoot = input.profile === 'workspace' || input.profile === 'networked'
    ? input.workspaceRoot
    : input.scratchRoot
  // `(deny network*)` is emitted LAST by `buildDarwinSandboxProfile`, so the
  // managed deny overrides the `networked` profile's `(allow network*)` rather
  // than racing it. Seatbelt cannot express anything narrower than this bit:
  // its address filter rejects every host but `*` and `localhost`.
  const denyNetwork = input.denyNetworkEgress === true
    || (input.profile !== 'networked' && input.profile !== 'plugin-mcp')
  const plan = applyFilesystemIsolation(input.command, input.args, writableRoot, {
    includeNetworkDeny: denyNetwork,
    additionalWritableRoots: [
      ...(writableRoot === input.scratchRoot ? [] : [input.scratchRoot]),
      ...(input.additionalWritableRoots ?? []),
    ],
    deniedReadRoots: input.deniedReadRoots,
    deniedWriteRoots: input.deniedWriteRoots,
    ...(input.filesystemIsolationDisabled ? { filesystemIsolationDisabled: true } : {}),
    ...(input.allowedReadRoots ? { allowedReadRoots: input.allowedReadRoots } : {}),
    ...(input.unconditionalDeniedReadRoots
      ? { unconditionalDeniedReadRoots: input.unconditionalDeniedReadRoots }
      : {}),
  })
  if (plan.status !== 'enforced') throw new Error(isolationUnavailable('darwin', input.profile))
  // The receipt has to name the layer's absence rather than a write scope: with
  // the layer off there IS no write scope, and a receipt reading
  // `write-workspace+scratch` would describe a boundary nothing is enforcing.
  const writeScope = input.filesystemIsolationDisabled === true
    ? FILESYSTEM_OFF_SCOPE
    : writeScopeLabel({
        writesWorkspace: writableRoot !== input.scratchRoot,
        ...(input.additionalWritableRoots ? { additionalWritableRoots: input.additionalWritableRoots } : {}),
        ...(input.sharedGitDirectory ? { sharedGitDirectory: input.sharedGitDirectory } : {}),
      })
  return {
    command: plan.command,
    args: plan.args,
    // `host-read` is the ambient-read posture the other backends are stuck with.
    // A configured allowlist changes the read scope, so the receipt has to say a
    // different word — an operator greps this string to learn what a command ran
    // under, and it must not keep claiming whole-filesystem read.
    backend: `${plan.backend}:${(input.allowedReadRoots?.length ?? 0) > 0 ? 'scoped-read' : 'host-read'}:${writeScope}${input.denyNetworkEgress === true ? ':managed-egress-denied' : ''}`,
    profile: input.profile,
  }
}
