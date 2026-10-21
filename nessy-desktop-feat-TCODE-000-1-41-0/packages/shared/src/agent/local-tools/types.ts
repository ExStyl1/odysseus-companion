import type { ScopedPathAccess, SessionFilesystemScope, SessionFilesystemScopeRoot } from '../session-filesystem-scope.ts';
import type { DeniedResultPathFilter } from './denied-result-filter.ts';

export type LocalToolOperation =
  | { kind: 'read_file'; path: string; offset?: number; limit?: number }
  | { kind: 'list_files'; path?: string; recursive?: boolean }
  | { kind: 'search_files'; pattern: string; path?: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'replace_in_file'; path: string; oldString: string; newString: string }
  | { kind: 'edit_file'; path: string; edits: LocalToolTextEdit[] }
  | { kind: 'grep'; pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }
  | { kind: 'find'; pattern: string; path?: string; limit?: number }
  | { kind: 'ls'; path?: string; limit?: number }
  | { kind: 'bash'; command: string; cwd?: string; timeout?: number; runInBackground?: boolean }
  | { kind: 'mcp'; proxyName: string; args: Record<string, unknown> };

export interface LocalToolTextEdit {
  oldText: string;
  newText: string;
}

export interface LocalToolPermissionSubject {
  toolName: string;
  input: Record<string, unknown>;
  type?: 'bash' | 'file_write' | 'mcp_mutation' | 'ask_user';
  command?: string;
}

export interface LocalToolCall {
  id: string;
  displayName: string;
  operation: LocalToolOperation;
  permission: LocalToolPermissionSubject;
  permissionRequestId?: string;
  terminal?: boolean;
  abortSignal?: AbortSignal;
}

export interface LocalToolExecutionResult {
  content: string;
  isError: boolean;
  error?: string;
  structuredContent?: Record<string, unknown>;
  isolationProfile?: string;
  environmentProfile?: string;
  environmentDigest?: string;
}

export interface AuthorizedLocalToolRuntime {
  executeAuthorized(call: LocalToolCall): Promise<LocalToolExecutionResult>;
}

export interface LocalToolRuntimeOptions {
  /** Captured session filesystem authority (primary root, cwd, approved roots). */
  filesystemScope: SessionFilesystemScope;
  /**
   * Runs after the existing filesystem scope admits a write target and before
   * the runtime reads or mutates it. The supplied path is the exact canonical
   * target returned by that admission.
   */
  onFileMutationAuthorized?: (context: {
    call: LocalToolCall;
    canonicalPath: string;
  }) => Promise<void> | void;
  /**
   * Structured outside-root approval seam. Returns an approved root (added to
   * the live scope for `expires: 'session'`, used once for `'request'`) or
   * null on denial. Denial has no side effect; one that names the host's reason REJECTS with it instead (F1.959), and the call fails with that sentence.
   */
  requestOutsideRootApproval?: (
    canonicalTarget: string,
    access: ScopedPathAccess, signal?: AbortSignal, // F1.957 — the asking call's own signal: when the call ends first (its deadline, an abort) the request is withdrawn with it
  ) => Promise<SessionFilesystemScopeRoot | null>;
  /**
   * P3.105 — the RESULTS half of the `deniedPaths` floor. Given the distinct
   * absolute paths a result set is about to name, returns the subset to
   * withhold; see `denied-result-filter.ts` for why the decision is asked for
   * rather than made here, and for what the answer must NOT be.
   *
   * Absent, the search and discovery tools behave exactly as before and
   * withhold nothing — the honest status quo, not a silent partial filter.
   */
  filterDeniedResultPaths?: DeniedResultPathFilter;
  permissionManager: {
    evaluateToolCall(toolName: string, input: Record<string, unknown>): {
      allowed: boolean;
      reason?: string;
      requiresPermission?: boolean;
      description?: string;
    };
  };
  mcpPool?: {
    callTool(proxyName: string, args: Record<string, unknown>, signal?: AbortSignal, context?: {
      sessionPath?: string;
      summarize?: (prompt: string) => Promise<string | null>;
      leaserId?: string;
    }): Promise<{
      content?: string;
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    }>;
    isProxyTool(proxyName: string, leaserId?: string): boolean;
  };
  /**
   * Leaser identity for a SHARED workspace pool — scopes the MCP proxy guard +
   * call-authz to this session's leased slugs. Absent (per-session private
   * pool) the pool calls stay pool-wide, byte-equivalent to before sharing.
   */
  mcpLeaserId?: string;
  onPermissionRequest?: (request: {
    requestId: string;
    toolName: string;
    command?: string;
    description: string;
    type?: 'bash' | 'file_write' | 'mcp_mutation' | 'ask_user';
  }) => void;
  runCommand?: (command: string, cwd: string, options?: {
    timeout?: number;
    signal?: AbortSignal;
    semanticId?: string;
    isolationProfile?: 'read-only' | 'workspace' | 'networked';
    /** Start as a background task and return the handle immediately (R10 `run_in_background`). */
    background?: boolean;
    /** Tool-call id, threaded so the seam can attribute background events to the call. */
    executionId?: string;
  }) => Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    isolationProfile?: string;
    /** Present only when the command ran outside isolation by policy. */
    isolationDowngrade?: { reason: string; pattern?: string; decisionId?: string };
    environmentProfile?: string;
    environmentDigest?: string;
    /**
     * Present when the command is now a background task — either a timeout
     * transition (`timedOut: true`) or a `run_in_background` start. Carries the
     * documented handle: task id + output-file path + the applied timeout.
     */
    backgrounded?: {
      taskId: string;
      outputFile: string;
      timedOut: boolean;
      timeoutMs: number;
    };
  }>;
  sessionPath?: string;
  summarizeLargeResult?: (prompt: string) => Promise<string | null>;
  contextWindow?: number;
  guardLargeResults?: boolean;
  onDebug?: (message: string) => void;
}
