/**
 * Canonical string encoding for a composite session identity.
 *
 * Shared session-keyed singletons (permission modes, session-scoped tool
 * callbacks, plan-file state, the session-tools cache) are module-level `Map`s.
 * They must be keyed by the composite `{workspaceId, sessionId}` so two
 * workspaces that reuse the same bare `sessionId` never collide. This helper is
 * the single canonical encoder every such singleton routes through.
 *
 * `workspaceId` is an immutable UUID (only `[0-9a-f-]`), so it can never contain
 * the `:` separator. Putting it first therefore makes the concatenation an
 * injective key regardless of what characters a `sessionId` slug contains.
 */
import type { SessionKey } from './types.ts';

export type { SessionKey } from './types.ts';

const SESSION_KEY_SEPARATOR = ':';

/** Encode a composite session identity into a canonical, collision-free map key. */
export function encodeSessionKey(key: SessionKey): string {
  return `${key.workspaceId}${SESSION_KEY_SEPARATOR}${key.sessionId}`;
}
