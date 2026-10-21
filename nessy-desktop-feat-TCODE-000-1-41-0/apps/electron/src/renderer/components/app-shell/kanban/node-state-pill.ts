/* Copied verbatim from v0.15.1:apps/electron/src/renderer/components/app-shell/kanban/node-state-pill.ts
   (craft-agents-oss, Apache-2.0; changed in v0.15.0) by UB14.60 (R2-16), 2026-10-16, over UA4.4's v0.13.4 copy: the
   pills take the solved status roles. Only the comment's package name is rebranded. */
// Renderer-local mapping for per-node run-state pills in the Results panel.
// Kept out of @nessy-agent/shared (Node-only) — the renderer can't import it.
// Keys are 1:1 with the NodeRunState literals the runner emits
// (packages/shared/src/tasks/storage.ts): pending | running | done | failed | cancelled | skipped.
//
// Colors are solved roles (design spec §2.4 run-state vocabulary): done = success, failed =
// destructive, running = accent (the "working" color — amber/info is reserved for "needs you").

const NEUTRAL_PILL = 'bg-fill-hover text-secondary'

const NODE_STATE_PILL: Record<string, string> = {
  done: 'bg-success-tint text-success',
  failed: 'bg-destructive-tint text-destructive',
  running: 'bg-accent-tint text-accent',
  // cancelled is a user/system stop, not a failure — keep it neutral so it never reads as red/error.
  cancelled: NEUTRAL_PILL,
  skipped: NEUTRAL_PILL,
  pending: NEUTRAL_PILL,
}

const NODE_STATE_LABEL_KEY: Record<string, string> = {
  done: 'tasks.nodeStateDone',
  failed: 'tasks.nodeStateFailed',
  running: 'tasks.nodeStateRunning',
  cancelled: 'tasks.nodeStateCancelled',
  skipped: 'tasks.nodeStateSkipped',
  pending: 'tasks.nodeStatePending',
}

/**
 * Resolve a node-state string to its pill classes + i18n label key.
 * Unknown/unexpected states fall back to a neutral pill with `labelKey: null`;
 * the caller renders the raw state string as the label in that case.
 */
export function resolveNodeStatePill(state: string): { className: string; labelKey: string | null } {
  return {
    className: NODE_STATE_PILL[state] ?? NEUTRAL_PILL,
    labelKey: NODE_STATE_LABEL_KEY[state] ?? null,
  }
}
