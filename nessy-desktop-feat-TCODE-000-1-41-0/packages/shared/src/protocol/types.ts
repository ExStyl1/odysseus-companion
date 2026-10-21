/**
 * Wire protocol types for the WS-based RPC layer.
 *
 * Shared between server (main process / headless) and client (renderer / Node).
 */

// ---------------------------------------------------------------------------
// Message envelope
// ---------------------------------------------------------------------------

export type MessageType =
  | 'handshake'
  | 'handshake_ack'
  | 'request'
  | 'response'
  | 'event'
  | 'error'
  | 'sequence_ack'

export interface MessageEnvelope {
  /** Correlation ID. UUIDv4 for requests; echoed in responses. */
  id: string
  type: MessageType
  /** Required for request / response / event / error. */
  channel?: string
  /** Request args or event payload. */
  args?: unknown[]
  /** Response payload. */
  result?: unknown
  /** Structured error. */
  error?: WireError
  /** Sent on handshake / handshake_ack. */
  protocolVersion?: string
  /** Sent on handshake by the client. */
  workspaceId?: string
  /** Sent on handshake for remote auth. */
  token?: string
  /** Assigned by server in handshake_ack. */
  clientId?: string
  /** Server identity stamp on outgoing events. For MultiClient source disambiguation. */
  serverId?: string
  /** Electron webContents.id, sent on handshake by local clients. */
  webContentsId?: number
  /** Client capabilities advertised on handshake. */
  clientCapabilities?: string[]
  /** Server-registered channels, sent in handshake_ack. Clients use this to avoid calling unavailable channels. */
  registeredChannels?: string[]

  // -- Reliable delivery fields --

  /** Per-client monotonic delivery sequence number, assigned when an event is targeted to that client. */
  seq?: number
  /** Client's last processed per-client seq — sent in sequence_ack and reconnect handshake. */
  lastSeq?: number
  /** Previous clientId — sent by client on reconnect handshake. */
  reconnectClientId?: string
  /** True when handshake_ack is for a reconnection (vs fresh connect). */
  reconnected?: boolean
  /** True when server buffer was evicted — client must do a full state refresh. */
  stale?: boolean
  /** Server app version, sent in handshake_ack. Clients can use this for compatibility checks. */
  serverVersion?: string
  /** Largest message the server accepts, in bytes (handshake_ack); a bigger one closes the connection. See message-limits.ts. */
  maxMessageBytes?: number
}

export interface WireError {
  code: ErrorCode
  message: string
  data?: unknown
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'HANDLER_ERROR'
  | 'CHANNEL_NOT_FOUND'
  | 'AUTH_FAILED'
  | 'PROTOCOL_VERSION_UNSUPPORTED'
  | 'SESSION_NOT_IDLE'
  | 'SESSION_ID_CONFLICT'
  | 'ARTIFACT_NOT_PORTABLE'
  | 'TRANSFER_TOO_LARGE'
  | 'TRANSFER_TIMEOUT'
  | 'TRANSFER_VERIFICATION_FAILED'
  | 'REQUEST_TIMEOUT'
  | 'CAPABILITY_UNAVAILABLE'
  | 'CLIENT_DISCONNECTED'
  | 'CLIENT_REQUEST_TIMEOUT'
  | 'BROWSER_NO_CAPABLE_CLIENT'
  | 'BROWSER_INSTANCE_NOT_OWNED'
  | 'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED'
  | 'BROWSER_REMOTE_EVALUATE_BLOCKED'
  /**
   * The built-in browser, refused by a managed policy
   * (`managed-in-app-browser.ts`). Its own code for the same reason as
   * `MODEL_RESTRICTED_BY_POLICY` below: a refusal a renderer can only render as
   * an English server sentence is a refusal a Russian-locale user reads as a
   * malfunction (P2.464). The message names the administrator's DOCUMENT — the
   * host's managed policy, a codex `requirements.toml`, or both — and never the
   * policy contents.
   */
  | 'BROWSER_MANAGED_DISABLED'
  /**
   * P6.536 — the DevTools debugger was refused for this origin: an
   * administrator locked CDP off (a switch separate from the pane's), the user
   * denied the origin, or there was no way to ask. Its own code, beside its
   * navigation twin below, for the reason `BROWSER_MANAGED_DISABLED` records —
   * the receiver translates the refusal instead of rendering an English server
   * sentence at a user in another locale.
   */
  | 'BROWSER_CDP_DENIED'
  /** P6.536 — a navigation the per-origin trust store refused. */
  | 'BROWSER_ORIGIN_DENIED'
  /**
   * A model selection the managed allowlist refuses
   * (`settings-reference.md#availablemodels`, `model-config.md:165`). Its own
   * code rather than `HANDLER_ERROR` so the
   * renderer can translate the refusal instead of surfacing an English server
   * string — the message carries only the model id, never the policy.
   */
  | 'MODEL_RESTRICTED_BY_POLICY'
  /**
   * Runtime switching (`2026-08-14-session-runtime-switching.md`). Each is its own code rather than `HANDLER_ERROR`
   * for the same reason as the one above: the renderer translates the refusal, and the message carries only the
   * identifier involved. `SESSION_BUSY` — a turn is in flight; the switch would race it. `CONNECTION_NOT_SWITCHABLE`
   * — the target connection cannot host this session (no capable runtime, or the session is pinned to its
   * current one). `CONNECTION_IN_USE` — the connection being deleted still owns live sessions.
   * `WORKTREE_EXIT_UNAVAILABLE` — the session sits in a worktree it cannot leave. `WORKTREE_DIRTY` — leaving
   * would strand uncommitted changes. `RUNTIME_UNHOSTABLE` — the target runtime cannot start on this host (not compiled
   * into this build, its binary absent, or no usable credential); unlike `CONNECTION_NOT_SWITCHABLE` (categorical: a
   * remote target is never switchable), this refusal is environmental — the message names the failed precondition.
   */
  | 'SESSION_BUSY'
  | 'CONNECTION_NOT_SWITCHABLE'
  | 'CONNECTION_IN_USE'
  /**
   * P6.498 — the operator requires the built-in gateway sign-in, so a
   * personal-key or BYO connection cannot be created or edited.
   *
   * A CODE and not an English string for `CONNECTION_IN_USE`'s reason: the
   * refusal is rendered to a user in their own language, and the sentence has
   * one home in the locale files. Host-side and runtime-blind, so Pi, claude
   * and codex refuse identically.
   */
  | 'CONNECTION_GATEWAY_ONLY'
  | 'WORKTREE_EXIT_UNAVAILABLE'
  | 'WORKTREE_DIRTY'
  | 'RUNTIME_UNHOSTABLE'
  /**
   * UA12.149 — a project's stored folder no longer has the identity that was bound (moved, replaced, or its
   * `config.json` edited on disk); `createSession({ projectId })` refuses rather than start a session elsewhere.
   * Spelled as `ProjectFolderView['problem']` (dto.ts) — one fact, one name; the lowercase-dashed break from
   * this set's convention is deliberate (the refusal's readers compare case-sensitively).
   */
  | 'project-folder-identity-changed'

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  'HANDLER_ERROR',
  'CHANNEL_NOT_FOUND',
  'AUTH_FAILED',
  'PROTOCOL_VERSION_UNSUPPORTED',
  'SESSION_NOT_IDLE',
  'SESSION_ID_CONFLICT',
  'ARTIFACT_NOT_PORTABLE',
  'TRANSFER_TOO_LARGE',
  'TRANSFER_TIMEOUT',
  'TRANSFER_VERIFICATION_FAILED',
  'REQUEST_TIMEOUT',
  'CAPABILITY_UNAVAILABLE',
  'CLIENT_DISCONNECTED',
  'CLIENT_REQUEST_TIMEOUT',
  'BROWSER_NO_CAPABLE_CLIENT',
  'BROWSER_INSTANCE_NOT_OWNED',
  'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
  'BROWSER_REMOTE_EVALUATE_BLOCKED',
  'BROWSER_MANAGED_DISABLED',
  'BROWSER_CDP_DENIED',
  'BROWSER_ORIGIN_DENIED',
  'MODEL_RESTRICTED_BY_POLICY',
  'SESSION_BUSY',
  'CONNECTION_NOT_SWITCHABLE',
  'CONNECTION_IN_USE',
  'CONNECTION_GATEWAY_ONLY',
  'WORKTREE_EXIT_UNAVAILABLE',
  'WORKTREE_DIRTY',
  'RUNTIME_UNHOSTABLE',
  'project-folder-identity-changed',
])

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value)
}

/**
 * Sender-side helper for throwing transport errors with a typed `code`.
 *
 * Class identity is lost across the wire — the transport reconstructs a plain
 * `Error` with `.code` on the receiving side. Receivers MUST branch on
 * `err.code === 'X'`, never `err instanceof CodedError`.
 */
export class CodedError extends Error {
  readonly code: ErrorCode
  /**
   * D1.150 — the part of a refusal a translation cannot supply.
   *
   * A code is translatable and a message is not, which is why every refusal in
   * the list above carries only an identifier in its sentence. `data` is for the
   * refusals whose identifiers are a LIST: `CONNECTION_IN_USE` names the chats
   * and automations still holding a connection, and those names are
   * user-authored text — the one part the renderer must print verbatim, beside a
   * sentence it builds itself in the user's own language.
   *
   * It lands in {@link WireError.data}, which the transport's two RECEIVING
   * halves already copy onto the rebuilt error.
   *
   * **TWO SENDING HOPS DROP IT TODAY, so this field reaches no renderer yet**
   * and a reader must not assume otherwise: `transport/server.ts` symbol
   * `sendResponseError` and the handler-response catch in `transport/client.ts`
   * both build `error: { code, message }` from their arguments, and the Electron
   * bridge's own envelope (`apps/electron/src/shared/rpc-error.ts` symbol
   * `toRpcErrorEnvelope`) rebuilds `{ marker, code, message }`. Each is one
   * field; all three are other lanes' files at the time of writing and the
   * diffs are recorded in this wave's lane report. Until they land, the data is
   * carried by the thrower and consumed by nobody — which is stated here rather
   * than discovered, because a field that silently goes nowhere is exactly the
   * defect `rpc-error.ts`'s own docblock records having shipped once.
   */
  readonly data?: unknown
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message)
    this.code = code
    this.name = 'CodedError'
    if (data !== undefined) this.data = data
  }
}

/**
 * D1.150 — `CONNECTION_IN_USE`'s payload, the shape both ends agree on.
 *
 * Names only, bounded by the sender, in the two groups the refusal's own
 * sentence counts. `moreSessions` / `moreAutomations` are what the sender left
 * out, so the renderer can say "and N more" in its own language instead of
 * reading an English tail out of the message.
 */
export interface ConnectionInUseData {
  readonly sessions: readonly string[]
  readonly automations: readonly string[]
  readonly moreSessions: number
  readonly moreAutomations: number
}

// ---------------------------------------------------------------------------
// Push target (server → clients)
// ---------------------------------------------------------------------------

export type PushTarget =
  | { to: 'all'; exclude?: string }
  | { to: 'workspace'; workspaceId: string; exclude?: string }
  | { to: 'client'; clientId: string }

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = '1.0'

/** Heartbeat interval in ms. Server pings every 30s. */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** Client that misses this many pongs gets terminated. */
export const HEARTBEAT_MAX_MISSED = 2

/** Default request timeout in ms. */
export const REQUEST_TIMEOUT_MS = 30_000

// -- Reliable delivery constants --

/** Max events to retain per client in the ring buffer. */
export const EVENT_BUFFER_MAX_SIZE = 500

/** Events older than this are evicted from the buffer. */
export const EVENT_BUFFER_TTL_MS = 30_000

/** How long to retain a disconnected client's buffer for potential reconnect. */
export const DISCONNECTED_CLIENT_TTL_MS = 60_000

/** Client sends a sequence_ack every N ms. */
export const SEQUENCE_ACK_INTERVAL_MS = 5_000
