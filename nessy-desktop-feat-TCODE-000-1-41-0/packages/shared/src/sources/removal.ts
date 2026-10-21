import { deleteSource } from './storage.ts';

/**
 * Removing a source is THREE operations, not one. They were written out
 * inline in the sources DELETE RPC channel, which meant the agent path could
 * only ever fork them — the "two writers" shape the wire-names work existed to
 * kill. This is the one implementation both channels call.
 *
 * The notify seam is injected because op (3) needs a handle neither caller
 * shares: the RPC channel has its server-bound notifier, the agent path has
 * SessionManager's invalidation.
 */
export interface RemoveSourceDeps {
  workspaceRootPath: string;
  /** Slugs currently in `workspace.config.defaults.enabledSourceSlugs`, if any. */
  enabledSourceSlugs?: string[];
  /** Persist the pruned default list. Called only when the slug was actually in it. */
  updateEnabledSourceSlugs: (next: string[]) => void | Promise<void>;
  /** Capability-change notification with `revoke-active-snapshot`. */
  notifyRevoked: () => void | Promise<void>;
}

export async function removeSourceEverywhere(sourceSlug: string, deps: RemoveSourceDeps): Promise<void> {
  // (1) the source directory itself
  deleteSource(deps.workspaceRootPath, sourceSlug);

  // (2) the workspace's default-enabled list, so a deleted slug cannot come
  //     back as a phantom default on the next session
  if (deps.enabledSourceSlugs?.includes(sourceSlug)) {
    await deps.updateEnabledSourceSlugs(deps.enabledSourceSlugs.filter(slug => slug !== sourceSlug));
  }

  // (3) the live snapshot — a removed source must not survive in a session
  //     that already resolved it
  try {
    await deps.notifyRevoked();
  } catch (error) {
    throw sourceRevokeFailure(error);
  }
}

/**
 * F1.409 — op (3) threw AFTER ops (1) and (2) landed: the source IS removed, and only the sessions that were already
 * running may still hold it. The throw keeps its original message, so a caller that reports it as it stands (the
 * Sources DELETE channel) answers exactly as before; `sourceRemoved` says the removal itself landed, so a caller that
 * answers a MODEL (`source_manage: remove`) can say "removed" rather than "failed" — F1.211's rule on a third
 * channel. `cause` is the original error, which carries the host's refresh summary (F1.265) when the revoke was a
 * runtime refresh.
 */
export type SourceRevokeFailure = Error & { sourceRemoved: true; cause: unknown };

function sourceRevokeFailure(error: unknown): SourceRevokeFailure {
  const text = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(text, { cause: error }), { sourceRemoved: true as const, cause: error });
}
