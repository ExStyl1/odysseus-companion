/**
 * Typed native-source invalidation bus (W6 Step 7; consumed by W8).
 *
 * Watcher/automation change points emit one scoped, typed event per detected
 * native-source change — keyed by capability kind and an explicit scope
 * (global | workspace(workspaceId) | project(projectKey?)) — instead of ad-hoc
 * per-feature callbacks. W8's unified resolver subscribes here to invalidate
 * its capability snapshots; W6 provides only this additive emission surface.
 *
 * Process-local by design: the bus carries no payloads beyond kind/scope and a
 * monotonic revision, never paths or content.
 */

import type { ProjectKey } from '../projects/project-identity.ts';
import type { PluginKey } from '../plugins/types.ts';
import type { NativeCapabilityKind } from './types.ts';

export type NativeSourceInvalidationScope =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'project'; workspaceId: string; projectKey?: ProjectKey };

export interface NativeSourceInvalidation {
  kind: NativeCapabilityKind;
  scope: NativeSourceInvalidationScope;
  /** Monotonic per-process revision so consumers can order/dedupe events. */
  revision: string;
}

/**
 * Whether a plugin runtime change ADDS/refreshes availability (W8 queues it) or
 * REMOVES security/availability (W8 revokes the active snapshot immediately).
 */
export type CapabilityInvalidationEffect = 'add-or-refresh' | 'remove';

/**
 * Plugin-runtime invalidation (W7 Step 10). Reuses this bus rather than a second
 * event system — the `kind: 'plugin'` discriminant plus the `effect` field is the
 * only extension.
 */
export interface PluginRuntimeInvalidation {
  kind: 'plugin';
  scope: NativeSourceInvalidationScope;
  effect: CapabilityInvalidationEffect;
  revision: string;
}

export type CapabilityInvalidation = NativeSourceInvalidation | PluginRuntimeInvalidation;

export type NativeSourceInvalidationListener = (invalidation: NativeSourceInvalidation) => void;
export type CapabilityInvalidationListener = (invalidation: CapabilityInvalidation) => void;

const listeners = new Set<CapabilityInvalidationListener>();
let revisionCounter = 0;

/**
 * Subscribe to native-source invalidations only (plugin events are filtered
 * out), preserving the W6 typed contract. Returns an unsubscribe function.
 */
export function onNativeSourceInvalidation(listener: NativeSourceInvalidationListener): () => void {
  const wrapped: CapabilityInvalidationListener = (event) => {
    if (event.kind !== 'plugin') listener(event);
  };
  listeners.add(wrapped);
  return () => {
    listeners.delete(wrapped);
  };
}

/** Subscribe to every capability invalidation (native + plugin). */
export function onCapabilityInvalidation(listener: CapabilityInvalidationListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function dispatch(event: CapabilityInvalidation): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // One consumer's failure must not break the others.
    }
  }
}

/** Emit a typed native-source invalidation. Listener errors are isolated. */
export function emitNativeSourceInvalidation(
  invalidation: Omit<NativeSourceInvalidation, 'revision'>,
): void {
  revisionCounter += 1;
  dispatch({ ...invalidation, revision: String(revisionCounter) });
}

/** Emit a plugin-runtime invalidation carrying its add/refresh-vs-remove effect. */
export function emitPluginRuntimeInvalidation(
  invalidation: Omit<PluginRuntimeInvalidation, 'revision' | 'kind'>,
): void {
  revisionCounter += 1;
  dispatch({ kind: 'plugin', ...invalidation, revision: String(revisionCounter) });
}

// ============================================================
// Resolver-facing scoped catalog invalidation (W8 Step 8)
// ============================================================

/**
 * The scopes the unified resolver invalidates. Broader than the watcher-level
 * `NativeSourceInvalidationScope`: it adds a whole-project trust fan-out (every
 * active Workspace context with that `ProjectKey`), a per-session scope and a
 * per-plugin scope. This is the single source of truth for the scope type; the
 * resolver imports it from here.
 */
export type CapabilityInvalidationScope =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'project'; workspaceId: string; projectKey: ProjectKey }
  | { kind: 'project-trust'; projectKey: ProjectKey }
  | { kind: 'session'; workspaceId: string; sessionId: string }
  | { kind: 'plugin'; pluginKey: PluginKey };

/**
 * Whether an invalidation refreshes availability before the next turn (idle
 * sessions rebuild; a processing session keeps its captured generation) or
 * revokes the active snapshot immediately (fail-closed security removal).
 */
export type CapabilityCatalogInvalidationEffect =
  | 'refresh-before-next-turn'
  | 'revoke-active-snapshot';

export interface CapabilityCatalogInvalidation {
  scope: CapabilityInvalidationScope;
  reason: string;
  effect: CapabilityCatalogInvalidationEffect;
  revision: string;
}

export type CapabilityCatalogInvalidationListener = (
  invalidation: CapabilityCatalogInvalidation,
) => void;

const catalogListeners = new Set<CapabilityCatalogInvalidationListener>();

/** Subscribe to resolver-facing scoped catalog invalidations. */
export function onCapabilityCatalogInvalidation(
  listener: CapabilityCatalogInvalidationListener,
): () => void {
  catalogListeners.add(listener);
  return () => {
    catalogListeners.delete(listener);
  };
}

/** Emit a scoped catalog invalidation with an explicit effect. */
export function emitCapabilityCatalogInvalidation(
  invalidation: Omit<CapabilityCatalogInvalidation, 'revision'>,
): void {
  revisionCounter += 1;
  const event: CapabilityCatalogInvalidation = { ...invalidation, revision: String(revisionCounter) };
  for (const listener of catalogListeners) {
    try {
      listener(event);
    } catch {
      // One consumer's failure must not break the others.
    }
  }
}

// F1.766 — declared by interface merging so no cited line above moves.
export interface CapabilityCatalogInvalidation {
  /**
   * F1.766 (owner decision 2026-09-26, option A) — the plugin a `revoke-active-snapshot` is about, when the emitter
   * knows it. It NARROWS the revoke: the resolver revokes a lease in `scope` only when that lease's snapshot holds an
   * instance of this plugin, so a turn that never loaded the plugin (an install refresh deferred for a busy session)
   * keeps running and picks the change up before its next turn. It never widens `scope`. Absent keeps the fail-closed
   * default: every lease in `scope`. It rides beside the scope rather than as the `plugin` scope kind above, because
   * that kind carries no workspace or project and every consumer of `scope.kind` (the browse-pool resync, for one)
   * would read a plugin mutation as machine-wide.
   */
  pluginKey?: PluginKey;
}
