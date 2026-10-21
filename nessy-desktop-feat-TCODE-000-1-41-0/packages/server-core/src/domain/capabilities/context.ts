/**
 * Safe capability-context ingress (W8 Step 3, server side).
 *
 * Public/remote calls carry only a `SafeCapabilityContextRef`. This module turns
 * it into the server-only `CapabilityContext` the resolver consumes, deriving
 * the project root/key/trust EXCLUSIVELY from server-owned session state or a
 * backend-issued project handle. A raw client `projectRoot`, a mismatched
 * Workspace/handle or an expired handle are rejected here — the resolver never
 * sees an untrusted path.
 *
 * `{ workspaceId }` resolves the global + Workspace layers with
 * `projectTrustState: 'none'`; it is the required catalog context for a
 * fresh/empty Workspace and never invents a session or project.
 *
 * A session-bearing ref additionally carries the session's `provider`, supplied
 * by the caller (see `resolveSessionProvider`). It is the input the catalog's
 * runtime gate reads, and without it every user-readable capability read
 * resolved provider-blind.
 */

import type { AgentProvider } from '@nessy-agent/shared/agent/backend/types';
import type { CapabilityContext } from '@nessy-agent/shared/capabilities/resolver';
import {
  isSafeCapabilityContextRef,
  type SafeCapabilityContextRef,
} from '@nessy-agent/shared/protocol';
import type {
  ProjectHandleRef,
  ProjectHandleService,
} from '@nessy-agent/shared/projects/project-handle-service';

export type CapabilityContextErrorCode =
  | 'invalid-context-ref'
  | 'unknown-or-expired-handle'
  | 'workspace-mismatch';

export class CapabilityContextError extends Error {
  constructor(readonly code: CapabilityContextErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CapabilityContextError';
  }
}

export interface CapabilityContextResolverDeps {
  handleService: ProjectHandleService;
  /**
   * Server-owned persisted session cwd used to lazily restore the in-memory
   * session -> project-handle binding after a process restart. Never accept a
   * renderer path here.
   */
  resolveSessionWorkingDirectory?: (workspaceId: string, sessionId: string) => string | undefined;
  /**
   * Q8-D4 — the session's ACTIVE backend, threaded in by the caller that owns
   * the live session, never looked up in here.
   *
   * `31da9b13f` taught the catalog to refuse an agent row on a runtime that
   * registers no definitions (`runtimeDispatchesAgentDefinitions`), keyed on
   * `CapabilityContext.provider`. The live gate then measured the refusal never
   * firing: this module produced every context a user-readable capability read
   * ever sees and set `provider` on none of them, so the whole gate collapsed
   * onto its provider-neutral `undefined` branch and a Codex session's catalog
   * was byte-identical to Pi's. A pass wired to a road nobody drives.
   *
   * Server-owned like the cwd above: the value comes from `SessionManager`'s own
   * `resolveManagedProvider`, never from the ref the renderer sent.
   *
   * Optional, and left unset for a genuinely session-less read: a
   * `{ workspaceId }` context resolves before any session exists, which runtime
   * a future session picks is unknown there, and `undefined` (→ `active`) is the
   * honest answer rather than a definite unavailability derived from an
   * indefinite input.
   */
  resolveSessionProvider?: (workspaceId: string, sessionId: string) => AgentProvider | undefined;
}

/**
 * Resolve a safe (possibly untrusted) context ref into a server-only
 * `CapabilityContext`. Throws `CapabilityContextError` on any unsafe/invalid ref.
 */
export async function resolveCapabilityContext(
  ref: unknown,
  deps: CapabilityContextResolverDeps,
): Promise<CapabilityContext> {
  if (!isSafeCapabilityContextRef(ref)) {
    throw new CapabilityContextError('invalid-context-ref');
  }
  const safe: SafeCapabilityContextRef = ref;

  // Workspace-only: global + Workspace layers, no project, trust 'none'.
  if (!('sessionId' in safe) && !('projectHandleId' in safe)) {
    return {
      workspaceId: safe.workspaceId,
      projectTrustState: 'none',
      projectTrustRevision: '',
    };
  }

  // Q8-D4: the runtime gate's only input. Resolved once here so BOTH
  // session-bearing exits carry it — the "session with no bound project" exit
  // below is the one a fresh session actually takes, and a gate that only
  // reached the fully-resolved exit would still be dead on that path.
  const sessionId = 'sessionId' in safe ? safe.sessionId : undefined;
  const provider = sessionId
    ? deps.resolveSessionProvider?.(safe.workspaceId, sessionId)
    : undefined;
  const providerPart = provider ? { provider } : {};

  const handleRef: ProjectHandleRef = 'projectHandleId' in safe
    ? { workspaceId: safe.workspaceId, projectHandleId: safe.projectHandleId }
    : { workspaceId: safe.workspaceId, sessionId: safe.sessionId };

  let resolved = await deps.handleService.resolveHandle(handleRef);
  if (!resolved && 'sessionId' in safe && deps.resolveSessionWorkingDirectory) {
    const workingDirectory = deps.resolveSessionWorkingDirectory(safe.workspaceId, safe.sessionId);
    if (workingDirectory) {
      try {
        const issued = await deps.handleService.validateProjectDirectory(safe.workspaceId, workingDirectory);
        deps.handleService.bindSession(safe.workspaceId, safe.sessionId, issued.id);
        resolved = await deps.handleService.resolveHandle(handleRef);
      } catch {
        // Missing/replaced/unreadable restored projects fail closed to the
        // Workspace-only context below. Explicit projectHandleId refs still
        // remain hard errors and never use this recovery path.
      }
    }
  }
  if (!resolved) {
    // An explicit handle ref that no longer resolves is a hard error (expired,
    // unknown or inode-replaced). A session with no bound project is simply a
    // Workspace-only context.
    if ('projectHandleId' in safe) {
      throw new CapabilityContextError('unknown-or-expired-handle');
    }
    return {
      workspaceId: safe.workspaceId,
      sessionId: safe.sessionId,
      ...providerPart,
      projectTrustState: 'none',
      projectTrustRevision: '',
    };
  }
  if (resolved.workspaceId !== safe.workspaceId) {
    throw new CapabilityContextError('workspace-mismatch');
  }

  return {
    workspaceId: safe.workspaceId,
    ...('sessionId' in safe ? { sessionId: safe.sessionId } : {}),
    ...providerPart,
    workingDirectory: resolved.canonicalPath,
    projectRoot: resolved.canonicalPath,
    projectKey: resolved.projectKey,
    projectTrustState: resolved.trustDecision,
    projectTrustRevision: resolved.trustRevision,
  };
}
