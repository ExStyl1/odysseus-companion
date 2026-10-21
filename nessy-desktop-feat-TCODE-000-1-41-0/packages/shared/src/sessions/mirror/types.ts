/**
 * Session mirror contract — the documented `SessionStore` MIRROR
 * (code.claude.com/docs/en/agent-sdk/session-storage.md), on OUR key shape.
 *
 * Local disk is written FIRST and stays authoritative; a configured mirror
 * receives best-effort batched appends (see envelope.ts for the failure
 * envelope) and provides load-fallback before resume. This is deliberately NOT
 * `@earendil-works/pi-agent-core`'s ten-method `SessionStorage` — that is a
 * primary-storage replacement, and drop-and-continue is only sound for a
 * mirror (doc-verification § R6).
 *
 * Naming: the local W5 storage facade already exports `SessionStore`
 * (`sessions/store-v2.ts`), so the mirror uses its own names. The METHOD shape
 * matches the documented contract (`append`/`load` required, four optional);
 * the KEY is our composite workspace/session key — our `projectKey` equivalent
 * is `workspaceId`, a deliberate divergence (doc-verification § R6 fact 13).
 * No shipped runtime consumes Claude's SDK option, so the interface shape is
 * portability guidance, not a compatibility surface.
 */

export interface MirrorSessionKey {
  /** Our `projectKey` equivalent (fact 13): the owning Workspace's immutable id. */
  workspaceId: string
  sessionId: string
  /**
   * Absent = the main transcript. Set when the entries belong to a subagent
   * transcript or sidecar file — an opaque key suffix following the on-disk
   * layout, e.g. `subagents/agent-<id>`.
   */
  subpath?: string
}

/**
 * One mirrored transcript entry. Opaque JSON-safe value apart from the two
 * identity fields: stores must persist entries in order and return them
 * deep-equal from `load` (byte-equal serialization NOT required).
 */
export interface SessionMirrorEntry {
  /**
   * Dedup identity. "Because a retried batch can re-deliver entries that
   * already landed, deduplicate by `entry.uuid` in your `append()`
   * implementation."
   */
  uuid: string
  type: string
  [key: string]: unknown
}

/** Summary sidecar entry (fact 1). `data` is folder-owned state, persisted verbatim. */
export interface MirrorSessionSummaryEntry {
  sessionId: string
  /**
   * Storage write time, stamped by the STORE at persist time (the fold never
   * sets it) and sharing a clock source with `listSessions` mtimes.
   */
  mtime: number
  data: Record<string, unknown>
}

/**
 * The mirror store contract: two required methods, four optional. Documented
 * failure consequences of omitting an optional method (session-storage.md):
 * without `listSessions`, most-recent-session listing cannot be served from the
 * mirror; without `listSessionSummaries`, listing falls back to `listSessions`
 * plus a per-session `load`; without `delete`, deletion is a no-op ("which
 * suits append-only backends") — a provided `delete` of the main key must
 * cascade to all subkeys and remove the summary entry; without `listSubkeys`,
 * only the main transcript is restored on fallback.
 */
export interface SessionMirrorStore {
  /** Best-effort batched append. Must dedupe by `entry.uuid`. */
  append(key: MirrorSessionKey, entries: SessionMirrorEntry[]): Promise<void>
  /** Ordered, deep-equal entries; `null` when the session is unknown. */
  load(key: MirrorSessionKey): Promise<SessionMirrorEntry[] | null>

  listSessions?(workspaceId: string): Promise<Array<{ sessionId: string; mtime: number }>>
  listSessionSummaries?(workspaceId: string): Promise<MirrorSessionSummaryEntry[]>
  delete?(key: MirrorSessionKey): Promise<void>
  listSubkeys?(key: { workspaceId: string; sessionId: string }): Promise<string[]>
}

/**
 * Emitted when a batch is dropped after the envelope gives up. Surfaces
 * host-side as a session system message + log line (never a subprocess RPC).
 */
export interface MirrorEvent {
  type: 'system'
  subtype: 'mirror_error'
  key: MirrorSessionKey
  /** The giving-up reason (last rejection message, or the timeout). */
  reason: string
  /** Attempts actually made: 3 on repeated rejection, 1 on timeout. */
  attempts: number
  entryCount: number
}
