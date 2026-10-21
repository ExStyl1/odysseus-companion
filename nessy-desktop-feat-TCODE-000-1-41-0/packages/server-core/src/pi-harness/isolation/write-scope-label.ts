/**
 * The write-scope segment of an isolation receipt, in one definition.
 *
 * All three backends record the same fact and used to spell it out separately.
 * That was tolerable while the fact was one ternary; it stopped being tolerable
 * when the shared-git grant (`sandboxing.md:314`) arrived, because the git
 * directory travels in `additionalWritableRoots` and a third copy of
 * `additionalWritableRoots?.length ? '+managed-data' : ''` would have labelled a
 * git grant as managed data on whichever backend was updated last.
 *
 * The receipt is what an administrator reads to tell a policy from an outage
 * (the S12 argument), so an extra scope that goes unnamed here is an extra scope
 * nobody can see.
 */
/**
 * The write-scope segment when `sandbox.filesystem.disabled` is in force.
 *
 * One constant read by all three backends, for the reason above: the receipt is
 * what tells a policy from an outage, and "the filesystem layer is off" is the
 * single most consequential thing it can say. It replaces the scope rather than
 * decorating it — there is no scope left to name.
 */
export const FILESYSTEM_OFF_SCOPE = 'filesystem-off'

export function writeScopeLabel(input: {
  /** False for the scratch-only profiles (`read-only`, `plugin-mcp`). */
  writesWorkspace: boolean
  additionalWritableRoots?: readonly string[]
  sharedGitDirectory?: string
}): string {
  const managedData = (input.additionalWritableRoots ?? [])
    .some(root => root !== input.sharedGitDirectory)
  return [
    input.writesWorkspace ? 'write-workspace+scratch' : 'write-scratch-only',
    ...(managedData ? ['managed-data'] : []),
    ...(input.sharedGitDirectory ? ['shared-git'] : []),
  ].join('+')
}
