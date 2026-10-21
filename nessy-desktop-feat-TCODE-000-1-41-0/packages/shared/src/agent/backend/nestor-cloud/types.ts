/**
 * A2A 1.0 wire types for `/api/v2/code-agent/a2a`.
 *
 * Citations are a2a-go `v2@v2.1.0` (the version present in the local Go module
 * cache; the backend's go.mod pins v2.3.1 — treat envelope details as
 * v2.1.0-verified and keep the decoder log-and-skip on unknown keys).
 *
 * The INTERNAL vocabulary below (`A2ATaskState`) stays lowercase on purpose:
 * `turn.ts` and the context sidecar are written against it, so the wire's
 * `TASK_STATE_*` values are normalized at the codec edge only.
 */

/** Internal task-state vocabulary — NOT the wire spelling. */
export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'canceled'
  | 'failed'
  | 'rejected'
  | 'auth-required'
  | 'unknown';

/** `TASK_STATE_*` (`a2a/core.go:272-292`) → the internal lowercase vocabulary. */
const WIRE_TASK_STATES: Record<string, A2ATaskState> = {
  TASK_STATE_SUBMITTED: 'submitted',
  TASK_STATE_WORKING: 'working',
  TASK_STATE_INPUT_REQUIRED: 'input-required',
  TASK_STATE_COMPLETED: 'completed',
  TASK_STATE_CANCELED: 'canceled',
  TASK_STATE_FAILED: 'failed',
  TASK_STATE_REJECTED: 'rejected',
  TASK_STATE_AUTH_REQUIRED: 'auth-required',
  TASK_STATE_UNSPECIFIED: 'unknown',
};

/**
 * The ONE wire→internal task-state translation. The codec normalizes stream
 * envelopes with it; the client uses it on the state name the backend hides
 * inside a terminal-task rejection's `error.data.error` string.
 */
export function normalizeNestorWireTaskState(state: unknown): A2ATaskState {
  if (typeof state !== 'string') return 'unknown';
  return WIRE_TASK_STATES[state] ?? 'unknown';
}

/**
 * `TaskState.Terminal()` — `a2a/core.go:327-332`: the states in which a task
 * becomes immutable and the backend refuses any further message on it.
 * `input-required` is deliberately NOT here (it is the 0.3 `final` FLAG's
 * meaning, which the codec spells separately): a suspended turn's parked tool
 * call is addressable only by that still-live `taskId`.
 */
export function isTerminalNestorTaskState(state: A2ATaskState): boolean {
  return state === 'completed'
    || state === 'canceled'
    || state === 'failed'
    || state === 'rejected';
}

/**
 * The backend refused a message addressed to a task that has already reached a
 * terminal state (`a2asrv/agentexec.go:201-203` → `-32602`, or the task store's
 * own guard → `-32004`). It is RECOVERABLE: the turn drops the stale `taskId`
 * and resends, which is why it is not a {@link NestorCloudClientError}.
 */
export class NestorCloudTerminalTaskError extends Error {
  constructor(
    public readonly taskState: A2ATaskState,
    /**
     * The backend's own sentence for this rejection (`readJsonRpcErrorDetail`),
     * kept because the generic message above describes only ONE of the
     * conditions routed here: `-32001` means the task was NOT FOUND, not that it
     * is frozen, and every path that does not recover would otherwise tell the
     * user the wrong thing — and discard the text that said the right one.
     */
    public readonly detail?: string,
    surfaced = false,
  ) {
    super(surfaced && detail ? detail : `Nestor task is already terminal: ${taskState}`);
    this.name = 'NestorCloudTerminalTaskError';
  }

  /**
   * The form to THROW when the turn does not recover: same class, same state,
   * but the backend's own text as the message. A no-op when the backend gave no
   * detail, so a caller can apply it unconditionally.
   */
  asSurfaced(): NestorCloudTerminalTaskError {
    if (!this.detail || this.message === this.detail) return this;
    return new NestorCloudTerminalTaskError(this.taskState, this.detail, true);
  }
}

/**
 * A terminal tool call (`ask_followup_question` / `plan_mode_respond`) parked
 * while the turn waits for the user (F5). The backend ends such a turn with
 * `TASK_STATE_INPUT_REQUIRED` because it is waiting for a CLIENT answer
 * (`a2a_environment.go:174-176`), and the answer is the next user prompt sent
 * back as this call's `tool_result`.
 */
export interface NestorPendingTerminalTool {
  toolCallId: string;
  name: string;
}

/** Wire task states — `a2a/core.go:272-292`. */
export type A2AWireTaskState =
  | 'TASK_STATE_UNSPECIFIED'
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED';

/** Wire message roles — `a2a/core.go:152-158`. A bare `"user"` silently degrades to assistant. */
export type A2AWireRole = 'ROLE_USER' | 'ROLE_AGENT' | 'ROLE_UNSPECIFIED';

interface A2APartCommon {
  filename?: string;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Parts are a flattened oneof discriminated by key presence — `text` / `raw` /
 * `data` / `url`, in that decode order (`a2a/core.go:672-716`). There is no
 * `kind` field (a stray one is ignored) and no `file` key.
 */
export interface A2ATextPart extends A2APartCommon {
  text: string;
}

export interface A2ADataPart extends A2APartCommon {
  /** `a2a.Data{Value: any}` — v2 permits primitives; only objects carry Nestor extensions. */
  data: unknown;
}

export interface A2ARawPart extends A2APartCommon {
  /** base64 in JSON */
  raw: string;
}

export interface A2AUrlPart extends A2APartCommon {
  url: string;
}

export type A2APart = A2ATextPart | A2ADataPart | A2ARawPart | A2AUrlPart | Record<string, unknown>;

/** `a2a/core.go:196-224` — contextId/taskId/metadata all ride ON the message. */
export interface A2AMessage {
  messageId: string;
  role?: A2AWireRole | string;
  parts?: A2APart[];
  contextId?: string;
  taskId?: string;
  extensions?: string[];
  referenceTaskIds?: string[];
  metadata?: Record<string, unknown>;
}

/** `a2a/core.go:380-388`. */
export interface A2ATaskStatus {
  state: A2AWireTaskState | string;
  message?: Partial<A2AMessage>;
  timestamp?: string;
}

/** `a2a/core.go:340-360`. */
export interface A2ATask {
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  history?: Array<Partial<A2AMessage>>;
  artifacts?: A2AArtifact[];
  metadata?: Record<string, unknown>;
}

/** `a2a/core.go:515-528` — note there is NO `final` field on v2. */
export interface A2ATaskStatusUpdate {
  taskId?: string;
  contextId?: string;
  status: A2ATaskStatus;
  metadata?: Record<string, unknown>;
}

/** `a2a/core.go:417-432`. */
export interface A2AArtifact {
  artifactId?: string;
  name?: string;
  description?: string;
  extensions?: string[];
  parts?: A2APart[];
  metadata?: Record<string, unknown>;
}

/** `a2a/core.go:452-467`. */
export interface A2ATaskArtifactUpdate {
  taskId?: string;
  contextId?: string;
  artifact: A2AArtifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * The stream oneof envelope — exactly one of these four keys is present
 * (`a2a/core.go:93-109`). Unknown keys are logged and skipped by the codec.
 */
export type A2AStreamEvent =
  | { task: A2ATask }
  | { message: A2AMessage }
  | { statusUpdate: A2ATaskStatusUpdate }
  | { artifactUpdate: A2ATaskArtifactUpdate }
  | Record<string, unknown>;

/**
 * v2 agent card — `a2a/agent.go:46-89`. The 0.3 top-level `url`,
 * `preferredTransport` and `protocolVersion` do NOT exist here; the protocol
 * version lives per interface (`a2a/agent.go:124-136`).
 */
export interface NestorAgentCard {
  url?: string;
  protocolVersion?: string;
  preferredTransport?: string;
  capabilities?: {
    streaming?: boolean;
    extensions?: NestorAgentCardExtension[];
    [key: string]: unknown;
  };
  supportedInterfaces?: Array<{
    url?: string;
    transport?: string;
    protocolBinding?: string;
    protocolVersion?: string;
    [key: string]: unknown;
  }>;
  extension?: NestorAgentCardExtension | NestorAgentCardExtension[];
  extensions?: NestorAgentCardExtension[];
  [key: string]: unknown;
}

export interface NestorAgentCardExtension {
  uri?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NestorCloudClientPhase {
  phase:
    | 'checking-credentials'
    | 'fetching-agent-card'
    | 'opening-a2a-stream'
    | 'sending-tool-results'
    | 'canceling-task';
  status?: number;
  requestId?: string;
  taskId?: string;
}

export type NestorCloudClientErrorCode =
  | 'missing-token'
  | 'auth-failed'
  | 'agent-card-fetch-failed'
  | 'agent-card-invalid'
  | 'stream-failed'
  | 'cancel-failed';

export class NestorCloudClientError extends Error {
  constructor(
    public readonly code: NestorCloudClientErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'NestorCloudClientError';
  }
}
