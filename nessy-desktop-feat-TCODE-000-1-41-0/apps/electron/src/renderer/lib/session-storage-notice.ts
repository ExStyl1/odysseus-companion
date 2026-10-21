/**
 * D1.251 / D1.141 posture B — the user-facing half of "this session has no
 * project folder, so the agent works somewhere else".
 *
 * ## The fact
 *
 * A session with no project folder still runs its child somewhere: the session's
 * own managed storage directory, which `store-v2`'s `create` seeds into `sdkCwd`
 * (`options.workingDirectory ?? sessionDir`). The model, meanwhile, is told
 * `config.session?.workingDirectory ?? workspaceRootPath` — the workspace root.
 * So a relative `Write` lands in a directory neither the user nor the model was
 * shown. WI-o measured that at the seam and made it machine-readable; posture B
 * is that the host MOVES nothing and the fact becomes readable at the moment it
 * becomes true.
 *
 * ## Why a function and not a ternary in the badge
 *
 * Two conditions have to be true together, and the second one is easy to get
 * backwards: the session must have no project folder, AND the storage directory
 * must be known and different from it. A rule that fired whenever `sdkCwd` was
 * present would put the sentence on every session with a folder, where it is
 * false — `sdkCwd` EQUALS `workingDirectory` there.
 *
 * ## What it deliberately does not do
 *
 * It does not compare paths for equality beyond the trivial case, and it does
 * not normalise them: the renderer has no canonicaliser, the host's own
 * comparison lives where the paths are resolved, and a wrong answer here would
 * either hide a true sentence or print a false one. The `workingDirectory`
 * ABSENCE is the condition the badge already renders its no-folder state from,
 * so this reads the same fact the surface around it does.
 */

/** The two session facts this decision reads. */
export interface SessionStorageFacts {
  /** The project folder, when the session has one. */
  readonly workingDirectory?: string
  /** Where the child actually runs — see the protocol `Session.sdkCwd`. */
  readonly sdkCwd?: string
}

/**
 * The directory to name in the no-project-folder sentence, or `null` when there
 * is nothing to say.
 *
 * `null` for a session with a project folder (the badge already names it), and
 * for one whose storage directory the server did not send — an older server, or
 * a session record written before `sdkCwd` existed. A surface that cannot name
 * the directory says nothing rather than guessing one.
 */
export function sessionStorageWorkingDirectory(facts: SessionStorageFacts): string | null {
  if (facts.workingDirectory) return null
  const sdkCwd = facts.sdkCwd?.trim()
  if (!sdkCwd) return null
  return sdkCwd
}
