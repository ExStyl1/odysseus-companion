import { applyFilesystemIsolation, applyNetworkIsolation } from '@nessy-agent/session-tools-core'
import type { ProcessIsolationProfile } from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import { isolationUnavailable } from '../isolation-remediation.ts'
import { FILESYSTEM_OFF_SCOPE, writeScopeLabel } from './write-scope-label.ts'

export function resolveLinuxIsolation(input: {
  profile: Exclude<ProcessIsolationProfile, 'none'>
  command: string
  args: string[]
  workspaceRoot: string
  scratchRoot: string
  additionalWritableRoots?: readonly string[]
  /** The linked-worktree shared `.git` grant; see the darwin resolver. */
  sharedGitDirectory?: string
  deniedReadRoots?: readonly string[]
  deniedWriteRoots?: readonly string[]
  denyNetworkEgress?: boolean
  /** `sandbox.filesystem.disabled`; see `isolation.ts`. */
  filesystemIsolationDisabled?: boolean
}) {
  const writableRoot = input.profile === 'workspace' || input.profile === 'networked'
    ? input.workspaceRoot
    : input.scratchRoot
  let command = input.command
  let args = input.args
  const backends: string[] = []
  // `unshare -n` / `firejail --net=none` are whole-namespace switches, so the
  // managed deny reuses the same wrapper the non-networked profiles get. There
  // is no narrower Linux form to reach for: a per-domain layer needs the proxy.
  if (input.denyNetworkEgress === true
    || (input.profile !== 'networked' && input.profile !== 'plugin-mcp')) {
    const network = applyNetworkIsolation(command, args)
    if (network.status !== 'enforced') throw new Error(isolationUnavailable('linux', input.profile, 'network'))
    command = network.command
    args = network.args
    backends.push(network.backend)
  }
  const filesystem = applyFilesystemIsolation(command, args, writableRoot, {
    additionalWritableRoots: [
      ...(writableRoot === input.scratchRoot ? [] : [input.scratchRoot]),
      ...(input.additionalWritableRoots ?? []),
    ],
    deniedReadRoots: input.deniedReadRoots,
    deniedWriteRoots: input.deniedWriteRoots,
    ...(input.filesystemIsolationDisabled ? { filesystemIsolationDisabled: true } : {}),
  })
  // Still REFUSED when no launcher exists, layer off or not: the credential floor
  // is expressible on Linux only through bwrap's masks or firejail's blacklists,
  // so a host without either cannot keep the one rule that survives the key.
  if (filesystem.status !== 'enforced') throw new Error(isolationUnavailable('linux', input.profile, 'filesystem'))
  backends.push(filesystem.backend)
  const writeScope = input.filesystemIsolationDisabled === true
    ? FILESYSTEM_OFF_SCOPE
    : writeScopeLabel({
        writesWorkspace: writableRoot !== input.scratchRoot,
        ...(input.additionalWritableRoots ? { additionalWritableRoots: input.additionalWritableRoots } : {}),
        ...(input.sharedGitDirectory ? { sharedGitDirectory: input.sharedGitDirectory } : {}),
      })
  return {
    command: filesystem.command,
    args: filesystem.args,
    backend: `${backends.join('+')}:host-read:${writeScope}${input.denyNetworkEgress === true ? ':managed-egress-denied' : ''}`,
    profile: input.profile,
  }
}
