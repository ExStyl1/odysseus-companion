/* eslint-disable import/no-internal-modules */
/**
 * Nessy CLI Backend (ACP SDK Client)
 *
 * Spawns Nessy CLI in ACP mode and adapts ACP session updates into Craft's
 * provider-agnostic AgentEvent stream.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type ContentBlock,
  type McpServer,
  type ModelInfo,
  // [nessy-fork] acp-elicitation-ask-user-question
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type {
  AgentEvent,
  AskUserQuestionItem,
  AvailableSkillDetail,
  AvailableSlashCommand,
  IntermediateMessageKind,
  Message,
  MessageTextElement,
} from '@craft-agent/core/types';
import { utf16IndexToByteOffset } from '@craft-agent/core/utils';
import type { FileAttachment } from '../utils/files.ts';
import type { ModelDefinition } from '../config/models.ts';
import { getProxyEnvVars } from '../config/proxy-env.ts';
import { getCoAuthorPreference } from '../config/preferences.ts';
import { getSessionPlansPath } from '../sessions/storage.ts';
import { getSystemPrompt } from '../prompts/system.ts';
import type { ModelFetchResult } from '../config/model-fetcher.ts';
import {
  resolveFileMentions,
  resolveSourceMentions,
} from '../mentions/index.ts';
import { isParentTaskTool } from '../utils/toolNames.ts';

import { BaseAgent } from './base-agent.ts';
import type {
  BackendConfig,
  BackendSessionMessagesResult,
  AvailableCommandsSnapshot,
  BackendSessionListOptions,
  BackendSessionListResult,
  BackendRewindResult,
  ChatOptions,
  BackendHostRuntimeContext,
  MidTurnMessageMetadata,
  PermissionRequestType,
  SdkMcpServerConfig,
} from './backend/types.ts';
import { AbortReason } from './backend/types.ts';
import { getBackendRuntime } from './backend/internal/driver-types.ts';
import { withElectronRunAsNodeEnv } from './backend/internal/electron-run-as-node.ts';
import { resolveBackendRuntimePaths } from './backend/internal/runtime-resolver.ts';
import { EventQueue } from './backend/event-queue.ts';
import type { PermissionMode } from './mode-manager.ts';
import {
  LLM_QUERY_TIMEOUT_MS,
  type LLMQueryRequest,
  type LLMQueryResult,
} from './llm-tool.ts';
import type {
  PermissionResponseOptions,
  PermissionRuleType,
  PermissionSettingsScope,
  NessyCoreSettingKey,
  NessyCoreSettingsSnapshot,
  NessyHookDefinition,
  NessyHookEvent,
  NessyMcpServerConfig,
  NessyMcpManageAction,
  NessyMcpManageResult,
  NessyMcpResourcesSnapshot,
  NessyMcpStatusSnapshot,
  NessyMcpToolsSnapshot,
  NessyPermissionSettings,
  NessyProviderCatalog,
  NessyProviderConnectParams,
  NessyProviderConnectResult,
  NessySettingValue,
  NessySettingsScope,
  NessySkillDeleteRequest,
  NessySkillDeleteResult,
  NessySkillInstallRequest,
  NessySkillInstallResult,
  NessySkillSetEnabledRequest,
  NessySkillSetEnabledResult,
} from '../protocol/dto.ts';
import type {
  NessyMemoryPaths,
  NessyMemorySettings,
} from '../config/nessy-settings.ts';
import { normalizeNessyMemorySettings } from '../config/nessy-settings.ts';

type JsonRecord = Record<string, unknown>;

const NESSY_RESPONSE_INTERRUPTED_MESSAGE = 'Response interrupted';
const NESSY_TOOL_RESULT_MISSING_MESSAGE = 'Tool result was not recorded.';
const MAX_MID_TURN_CONTENT_BUILD_FAILURES = 3;
const MID_TURN_ATTACHMENT_PROCESSING_FAILURE_TEXT =
  '[Attachment could not be processed]';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getAcpErrorDetail(data: unknown): string | undefined {
  if (data == null) return undefined;
  if (typeof data === 'string') return data.trim() || undefined;
  if (typeof data !== 'object') return String(data);

  const record = data as JsonRecord;
  for (const key of ['details', 'message', 'error_description']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }

  const nested = getAcpErrorDetail(record.error);
  if (nested) return nested;

  try {
    const serialized = JSON.stringify(data);
    return serialized === '{}' ? undefined : serialized;
  } catch {
    return undefined;
  }
}

export function formatNessyAcpErrorMessage(error: unknown): string {
  const message = getErrorMessage(error);
  const data =
    error && typeof error === 'object'
      ? (error as { data?: unknown }).data
      : undefined;
  const detail = getAcpErrorDetail(data);

  if (!detail || detail === message) return message;
  return `${message}: ${detail}`;
}

// [nessy-fork] desktop-first-run-setup
function offersNessyAuthMethod(error: unknown, methodId: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return false;
  const authMethods = (data as { authMethods?: unknown }).authMethods;
  return (
    Array.isArray(authMethods) &&
    authMethods.some(
      (method) =>
        !!method &&
        typeof method === 'object' &&
        (method as { id?: unknown }).id === methodId,
    )
  );
}

type AcpPermissionOption = {
  optionId?: string;
  name?: string;
  kind?: string;
};

type PendingPermission = {
  resolve: (
    response: RequestPermissionResponse & { answers?: Record<string, string> },
  ) => void;
  options: AcpPermissionOption[];
};

type MiniCollector = {
  chunks: string[];
  inputTokens?: number;
  outputTokens?: number;
};

type ExtractedUsage = {
  inputTokens: number;
  contextTokens: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

type HistoryCollector = {
  updates: JsonRecord[];
};

type SlashCommandInvocation = {
  rawCommand: string;
  timestamp: number;
};

const MID_TURN_QUEUE_DRAIN_METHOD = 'craft/drainMidTurnQueue';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 120_000;
const NESSY_DESKTOP_AUTH_METHOD_ID = 'dp-auth';
const NESSY_AUTH_TIMEOUT_MS = 310_000;
const INCLUDE_CRAFT_CONTEXT_IN_NESSY_PROMPTS = false;
const SHARED_ACP_IDLE_TTL_MS = 5 * 60_000;

type NessyAcpSubscriber = {
  onSessionUpdate(params: unknown): void;
  onPermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>;
  /**
   * Optional handler for ACP `elicitation/create` (form mode) — the standard
   * mechanism the agent uses for `ask_user_question` when this client
   * advertises `clientCapabilities.elicitation.form`. When absent, the agent
   * falls back to the permission `q*_opt*` path.
   */
  // [nessy-fork] acp-elicitation-ask-user-question
  onElicitation?(
    params: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse>;
  onExtMethod(method: string, params: JsonRecord): Promise<JsonRecord>;
  /**
   * Optional handler for ACP ext notifications (fire-and-forget, no response),
   * e.g. `nessy/notify/session/mode-update` and `.../model-update`. Optional
   * because most of this state also arrives via `session/update`.
   */
  onExtNotification?(method: string, params: JsonRecord): void | Promise<void>;
  onProcessExit(code: number | null, signal: NodeJS.Signals | null): void;
  onDebug(message: string): void;
};

type NessyAcpProcessOptions = {
  key: string;
  command: string;
  args: string[];
  cwd: string;
  envOverrides?: Record<string, string>;
};

type NessyAcpLease = {
  connection: ClientSideConnection;
  commandDescription: string;
  recentStderr(): string;
  isActive(): boolean;
  registerSession(sessionId: string): void;
  unregisterSession(sessionId: string): void;
  authenticate(methodId: string): Promise<void>;
  release(): void;
};

const sharedAcpProcesses = new Map<string, SharedNessyAcpProcess>();

function stableStringifyRecord(
  value: Record<string, string | undefined>,
): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce<Record<string, string>>((acc, key) => {
        const item = value[key];
        if (item !== undefined) acc[key] = item;
        return acc;
      }, {}),
  );
}

function buildSharedAcpProcessKey(args: {
  command: string;
  spawnArgs: string[];
  workspaceRootPath: string;
  envOverrides?: Record<string, string>;
}): string {
  return [
    args.command,
    args.spawnArgs.join('\u0000'),
    args.workspaceRootPath,
    stableStringifyRecord(args.envOverrides ?? {}),
  ].join('\u0001');
}

async function acquireSharedNessyAcpProcess(
  options: NessyAcpProcessOptions,
  subscriber: NessyAcpSubscriber,
): Promise<NessyAcpLease> {
  let processEntry = sharedAcpProcesses.get(options.key);
  if (!processEntry) {
    processEntry = new SharedNessyAcpProcess(options);
    sharedAcpProcesses.set(options.key, processEntry);
  }
  return processEntry.acquire(subscriber);
}

class SharedNessyAcpProcess {
  private child: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private startPromise: Promise<void> | null = null;
  private authPromise: Promise<void> | null = null;
  private initialized = false;
  private subscribers = new Set<NessyAcpSubscriber>();
  private sessionOwners = new Map<string, NessyAcpSubscriber>();
  private refCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private stderrBuffer: string[] = [];
  private stderrBufferBytes = 0;
  private readonly commandDescription: string;
  private static readonly STDERR_BUFFER_MAX_BYTES = 8 * 1024;

  constructor(private readonly options: NessyAcpProcessOptions) {
    this.commandDescription = `${options.command} ${options.args.join(' ')}`;
  }

  async acquire(subscriber: NessyAcpSubscriber): Promise<NessyAcpLease> {
    this.refCount += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    this.subscribers.add(subscriber);

    try {
      await this.ensureStarted();
    } catch (error) {
      this.releaseSubscriber(subscriber);
      throw error;
    }

    const lease: NessyAcpLease = {
      connection: this.ensureConnection(),
      commandDescription: this.commandDescription,
      recentStderr: () => this.stderrBuffer.join(''),
      isActive: () => this.isActive(),
      registerSession: (sessionId) => {
        this.sessionOwners.set(sessionId, subscriber);
      },
      unregisterSession: (sessionId) => {
        if (this.sessionOwners.get(sessionId) === subscriber) {
          this.sessionOwners.delete(sessionId);
        }
      },
      authenticate: (methodId) => this.authenticate(methodId),
      release: () => this.releaseSubscriber(subscriber),
    };
    return lease;
  }

  private async authenticate(methodId: string): Promise<void> {
    if (this.authPromise) {
      await this.authPromise;
      return;
    }

    this.authPromise = this.withTimeout(
      this.ensureConnection().authenticate({ methodId }).then(() => undefined),
      'authenticate',
      NESSY_AUTH_TIMEOUT_MS,
    );
    try {
      await this.authPromise;
    } finally {
      this.authPromise = null;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.isActive()) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async start(): Promise<void> {
    this.debug(`Spawning shared Nessy ACP process: ${this.commandDescription}`);
    this.stderrBuffer = [];
    this.stderrBufferBytes = 0;

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.buildEnv(),
      shell: false,
    });

    this.child = child;
    this.initialized = false;

    const connection = new ClientSideConnection(
      () => this.createAcpClient(),
      ndJsonStream(
        Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      ),
    );
    this.connection = connection;

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.recordStderr(text);
      const trimmed = text.trim();
      if (trimmed) this.debug(`[nessy stderr] ${trimmed}`);
    });
    child.on('exit', (code, signal) => this.handleExit(code, signal));
    child.on('error', (error) => {
      this.debug(`Nessy ACP process error: ${error.message}`);
    });

    void connection.closed.then(() => {
      if (this.connection !== connection) return;
      if (this.child === child && !child.killed && child.exitCode === null) {
        child.kill();
      }
    });

    try {
      await this.withTimeout(
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            // The desktop client renders `elicitation/create` (form mode)
            // forms, so agents may use standard elicitation for
            // `ask_user_question` instead of the permission `q*_opt*` hack.
            // [nessy-fork] acp-elicitation-ask-user-question
            elicitation: { form: {} },
          },
        }),
        'initialize',
        nessyInitializeTimeoutMs(),
      );
      this.initialized = true;
    } catch (error) {
      this.kill();
      throw error;
    }
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...getProxyEnvVars(),
      ...this.options.envOverrides,
    };
    delete env.CRAFT_SESSION_DIR;
    // In the packaged app, never leak DEV into the bundled CLI. When DEV=true,
    // Ink calls import.meta.resolve("react-devtools-core"), which triggers Bun's
    // runtime auto-install against the public npm registry — it hangs/crashes
    // behind a corporate proxy and stalls ACP initialize. The bundled CLI has no
    // dev deps, so the devtools resolve can never succeed anyway. Local dev
    // (CRAFT_IS_PACKAGED unset/0/false) keeps DEV so devtools still work there.
    const isPackaged =
      process.env.CRAFT_IS_PACKAGED === '1' ||
      process.env.CRAFT_IS_PACKAGED === 'true';
    if (isPackaged) delete env.DEV;

    return withElectronRunAsNodeEnv(
      env,
      this.options.command,
      this.options.args,
    );
  }

  private createAcpClient(): Client {
    return {
      requestPermission: async (params) => {
        const sessionId = asString(toRecord(params).sessionId);
        const owner = sessionId ? this.sessionOwners.get(sessionId) : undefined;
        if (owner) return owner.onPermissionRequest(params);

        this.debug(
          `Nessy permission request had no owner for session ${sessionId ?? 'unknown'}`,
        );
        return { outcome: { outcome: 'cancelled' } };
      },
      // [nessy-fork] acp-elicitation-ask-user-question
      unstable_createElicitation: async (params) => {
        // Only session-scoped form elicitation is rendered by the desktop
        // client; anything else resolves as dismissed.
        if (params.mode !== 'form' || !('sessionId' in params)) {
          return { action: 'cancel' };
        }
        const owner = this.sessionOwners.get(params.sessionId);
        if (owner?.onElicitation) return owner.onElicitation(params);

        this.debug(
          `Nessy elicitation request had no owner for session ${params.sessionId}`,
        );
        return { action: 'cancel' };
      },
      sessionUpdate: async (params) => {
        for (const subscriber of [...this.subscribers]) {
          subscriber.onSessionUpdate(params);
        }
      },
      extMethod: async (method, params) => {
        const record = toRecord(params);
        const sessionId = asString(record.sessionId);
        const owner = sessionId ? this.sessionOwners.get(sessionId) : undefined;
        if (owner) return owner.onExtMethod(method, record);

        for (const subscriber of [...this.subscribers]) {
          const result = await subscriber.onExtMethod(method, record);
          if (Object.keys(result).length > 0) return result;
        }
        return method === MID_TURN_QUEUE_DRAIN_METHOD ? { messages: [] } : {};
      },
      // Ext notifications are fire-and-forget updates the Nessy CLI emits
      // outside the ACP spec (e.g. nessy/notify/session/mode-update,
      // .../model-update). Route them to the owning subscriber if it cares,
      // otherwise ignore. Without this handler the ACP SDK rejects every ext
      // notification with -32601 ("Method not found"), spamming the logs.
      extNotification: async (method, params) => {
        const record = toRecord(params);
        const sessionId = asString(record.sessionId);
        const owner = sessionId ? this.sessionOwners.get(sessionId) : undefined;
        if (owner?.onExtNotification) {
          await owner.onExtNotification(method, record);
          return;
        }
        let handled = false;
        for (const subscriber of [...this.subscribers]) {
          if (subscriber.onExtNotification) {
            await subscriber.onExtNotification(method, record);
            handled = true;
          }
        }
        if (!handled) {
          // Mirrors the VS Code companion: accept-and-ignore unknown ext
          // notifications (e.g. nessy/notify/session/{mode,model}-update, whose
          // state also arrives via session/update) instead of erroring.
          this.debug(`Unhandled ext notification: ${method}`);
        }
      },
    };
  }

  private ensureConnection(): ClientSideConnection {
    if (
      !this.connection ||
      this.connection.signal.aborted ||
      !this.isActive()
    ) {
      throw new Error('Nessy ACP process is not running');
    }
    return this.connection;
  }

  private isActive(): boolean {
    return !!(
      this.child &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.connection &&
      !this.connection.signal.aborted &&
      this.initialized
    );
  }

  private releaseSubscriber(subscriber: NessyAcpSubscriber): void {
    if (this.subscribers.delete(subscriber)) {
      this.refCount = Math.max(0, this.refCount - 1);
    }
    for (const [sessionId, owner] of [...this.sessionOwners]) {
      if (owner === subscriber) this.sessionOwners.delete(sessionId);
    }
    if (this.refCount === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        if (this.refCount > 0) return;
        sharedAcpProcesses.delete(this.options.key);
        this.kill();
      }, SHARED_ACP_IDLE_TTL_MS);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.debug(
      `Nessy ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
    );
    this.initialized = false;
    this.child = null;
    this.connection = null;
    sharedAcpProcesses.delete(this.options.key);
    for (const subscriber of [...this.subscribers]) {
      subscriber.onProcessExit(code, signal);
    }
  }

  private kill(): void {
    this.connection = null;
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.child = null;
    this.initialized = false;
    this.authPromise = null;
  }

  private recordStderr(chunk: string): void {
    if (!chunk) return;
    const effective =
      chunk.length > SharedNessyAcpProcess.STDERR_BUFFER_MAX_BYTES
        ? chunk.slice(
            chunk.length - SharedNessyAcpProcess.STDERR_BUFFER_MAX_BYTES,
          )
        : chunk;
    this.stderrBuffer.push(effective);
    this.stderrBufferBytes += effective.length;
    while (
      this.stderrBufferBytes > SharedNessyAcpProcess.STDERR_BUFFER_MAX_BYTES &&
      this.stderrBuffer.length > 1
    ) {
      const dropped = this.stderrBuffer.shift()!;
      this.stderrBufferBytes -= dropped.length;
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    method: string,
    timeoutMs: number,
  ): Promise<T> {
    if (timeoutMs <= 0) return promise;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Nessy ACP request timed out: ${method}`));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  private debug(message: string): void {
    for (const subscriber of [...this.subscribers]) {
      subscriber.onDebug(message);
    }
  }
}

type NessySettingsAcpOptions = {
  hostRuntime: BackendHostRuntimeContext;
  cwd?: string;
  processCwd?: string;
  envOverrides?: Record<string, string>;
  timeoutMs?: number;
  debug?: (message: string) => void;
};

function buildNessyAcpSpawnCommand(
  nessyCliPath: string,
  nodePath: string,
): { command: string; args: string[] } {
  const args = [
    '--acp',
    '--channel=desktop',
    // [nessy-fork] dlh-launch-metadata — передаём версию Desktop в DLH
    `--ext-version=${process.env.CRAFT_AGENT_VERSION || 'unknown'}`,
  ];

  if (nessyCliPath.endsWith('.js')) {
    return { command: nodePath, args: [nessyCliPath, ...args] };
  }

  return { command: nessyCliPath, args };
}

function nessySettingsCwd(hostRuntime: BackendHostRuntimeContext): string {
  return hostRuntime.appRootPath || homedir() || process.cwd();
}

function nessyAcpWithTimeout<T>(
  promise: Promise<T>,
  method: string,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return promise;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Nessy ACP request timed out: ${method}`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

async function callNessySettingsAcpMethod(
  options: NessySettingsAcpOptions,
  method: string,
  params: JsonRecord = {},
): Promise<JsonRecord> {
  const resolvedPaths = resolveBackendRuntimePaths(options.hostRuntime);
  const nessyCliPath = resolvedPaths.nessyCliPath;
  if (!nessyCliPath) {
    throw new Error(
      'Nessy CLI not found. Build the current nessy-cli checkout with npm run build && npm run bundle, or set NESSY_CLI to a dist/cli.js path.',
    );
  }

  const nodePath = resolvedPaths.nodeRuntimePath || process.execPath;
  const { command, args } = buildNessyAcpSpawnCommand(nessyCliPath, nodePath);
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const processCwd = options.processCwd || cwd;
  const key = buildSharedAcpProcessKey({
    command,
    spawnArgs: args,
    workspaceRootPath: processCwd,
    envOverrides: options.envOverrides,
  });

  const lease = await acquireSharedNessyAcpProcess(
    {
      key,
      command,
      args,
      cwd: processCwd,
      envOverrides: options.envOverrides,
    },
    {
      onSessionUpdate: () => {},
      onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
      onExtMethod: async (extMethod) =>
        extMethod === MID_TURN_QUEUE_DRAIN_METHOD ? { messages: [] } : {},
      onProcessExit: () => {},
      onDebug: options.debug ?? (() => {}),
    },
  );

  try {
    return toRecord(
      await nessyAcpWithTimeout(
        lease.connection.extMethod(method, params),
        method,
        options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ),
    );
  } finally {
    lease.release();
  }
}

// [nessy-fork] desktop-first-run-setup
export async function authenticateNessyViaSharedAcp(
  options: NessySettingsAcpOptions,
): Promise<void> {
  const resolvedPaths = resolveBackendRuntimePaths(options.hostRuntime);
  const nessyCliPath = resolvedPaths.nessyCliPath;
  if (!nessyCliPath) {
    throw new Error('Nessy CLI not found.');
  }

  const nodePath = resolvedPaths.nodeRuntimePath || process.execPath;
  const { command, args } = buildNessyAcpSpawnCommand(nessyCliPath, nodePath);
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const processCwd = options.processCwd || cwd;
  const lease = await acquireSharedNessyAcpProcess(
    {
      key: buildSharedAcpProcessKey({
        command,
        spawnArgs: args,
        workspaceRootPath: processCwd,
        envOverrides: options.envOverrides,
      }),
      command,
      args,
      cwd: processCwd,
      envOverrides: options.envOverrides,
    },
    {
      onSessionUpdate: () => {},
      onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
      onExtMethod: async (extMethod) =>
        extMethod === MID_TURN_QUEUE_DRAIN_METHOD ? { messages: [] } : {},
      onProcessExit: () => {},
      onDebug: options.debug ?? (() => {}),
    },
  );

  try {
    await lease.authenticate(NESSY_DESKTOP_AUTH_METHOD_ID);
  } finally {
    lease.release();
  }
}

export async function getNessyMemorySettingsViaAcp(
  options: NessySettingsAcpOptions,
): Promise<NessyMemorySettings> {
  const response = await callNessySettingsAcpMethod(
    options,
    'nessy/settings/getMemory',
  );
  return normalizeNessyMemorySettings(response.settings);
}

export async function setNessyMemorySettingsViaAcp(
  options: NessySettingsAcpOptions,
  updates: Partial<NessyMemorySettings>,
): Promise<NessyMemorySettings> {
  const response = await callNessySettingsAcpMethod(
    options,
    'nessy/settings/setMemory',
    { updates },
  );
  return normalizeNessyMemorySettings(response.settings);
}

export async function getNessySettingsPathViaAcp(
  options: NessySettingsAcpOptions,
): Promise<string> {
  const response = await callNessySettingsAcpMethod(
    options,
    'nessy/settings/getPath',
  );
  const settingsPath = asString(response.path);
  if (!settingsPath) throw new Error('Nessy ACP did not return settings path');
  return settingsPath;
}

export async function getNessyCoreSettingsViaAcp(
  options: NessySettingsAcpOptions,
): Promise<NessyCoreSettingsSnapshot> {
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const response = await callNessySettingsAcpMethod(
    { ...options, cwd },
    'nessy/settings/getCore',
    { cwd },
  );
  return response as unknown as NessyCoreSettingsSnapshot;
}

// [nessy-fork] desktop-mcp-management
export async function getNessyMcpStatusViaAcp(
  options: NessySettingsAcpOptions,
): Promise<NessyMcpStatusSnapshot> {
  const response = await callNessySettingsAcpMethod(
    { ...options, timeoutMs: options.timeoutMs ?? 45_000 },
    'nessy/status/workspace/mcp',
    { waitForMcpReady: true },
  );
  return response as unknown as NessyMcpStatusSnapshot;
}

export async function getNessyMcpToolsViaAcp(
  options: NessySettingsAcpOptions,
  serverName: string,
): Promise<NessyMcpToolsSnapshot> {
  const response = await callNessySettingsAcpMethod(
    options,
    'nessy/status/workspace/mcp/tools',
    {
      serverName,
    },
  );
  return response as unknown as NessyMcpToolsSnapshot;
}

export async function getNessyMcpResourcesViaAcp(
  options: NessySettingsAcpOptions,
  serverName: string,
): Promise<NessyMcpResourcesSnapshot> {
  const response = await callNessySettingsAcpMethod(
    options,
    'nessy/status/workspace/mcp/resources',
    { serverName },
  );
  return response as unknown as NessyMcpResourcesSnapshot;
}

export async function restartNessyMcpServerViaAcp(
  options: NessySettingsAcpOptions,
  serverName: string,
): Promise<Record<string, unknown>> {
  return callNessySettingsAcpMethod(
    options,
    'nessy/control/workspace/mcp/restart',
    { serverName },
  );
}

export async function manageNessyMcpServerViaAcp(
  options: NessySettingsAcpOptions,
  serverName: string,
  action: NessyMcpManageAction,
): Promise<NessyMcpManageResult> {
  const response = await callNessySettingsAcpMethod(
    action === 'authenticate' ? { ...options, timeoutMs: 310_000 } : options,
    'nessy/control/workspace/mcp/manage',
    { serverName, action },
  );
  return response as unknown as NessyMcpManageResult;
}

export async function setNessyCoreSettingViaAcp(
  options: NessySettingsAcpOptions,
  scope: NessySettingsScope,
  key: NessyCoreSettingKey,
  value: NessySettingValue,
): Promise<NessyCoreSettingsSnapshot> {
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const response = await callNessySettingsAcpMethod(
    { ...options, cwd },
    'nessy/settings/setCoreValue',
    { cwd, scope, key, value },
  );
  return response as unknown as NessyCoreSettingsSnapshot;
}

export async function setNessyMcpServerViaAcp(
  options: NessySettingsAcpOptions,
  scope: NessySettingsScope,
  name: string,
  server: NessyMcpServerConfig,
): Promise<NessyCoreSettingsSnapshot> {
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const response = await callNessySettingsAcpMethod(
    { ...options, cwd },
    'nessy/settings/setMcpServer',
    { cwd, scope, name, server },
  );
  return response as unknown as NessyCoreSettingsSnapshot;
}

export async function removeNessyMcpServerViaAcp(
  options: NessySettingsAcpOptions,
  scope: NessySettingsScope,
  name: string,
): Promise<NessyCoreSettingsSnapshot> {
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const response = await callNessySettingsAcpMethod(
    { ...options, cwd },
    'nessy/settings/removeMcpServer',
    { cwd, scope, name },
  );
  return response as unknown as NessyCoreSettingsSnapshot;
}

export async function setNessyHookViaAcp(
  options: NessySettingsAcpOptions,
  scope: NessySettingsScope,
  event: NessyHookEvent,
  index: number | undefined,
  hook: NessyHookDefinition,
): Promise<NessyCoreSettingsSnapshot> {
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const response = await callNessySettingsAcpMethod(
    { ...options, cwd },
    'nessy/settings/setHook',
    { cwd, scope, event, index, hook },
  );
  return response as unknown as NessyCoreSettingsSnapshot;
}

export async function removeNessyHookViaAcp(
  options: NessySettingsAcpOptions,
  scope: NessySettingsScope,
  event: NessyHookEvent,
  index: number,
): Promise<NessyCoreSettingsSnapshot> {
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const response = await callNessySettingsAcpMethod(
    { ...options, cwd },
    'nessy/settings/removeHook',
    { cwd, scope, event, index },
  );
  return response as unknown as NessyCoreSettingsSnapshot;
}

export async function setNessyExtensionSettingViaAcp(
  options: NessySettingsAcpOptions,
  extensionId: string,
  settingKey: string,
  scope: NessySettingsScope,
  value: NessySettingValue,
): Promise<NessyCoreSettingsSnapshot> {
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const response = await callNessySettingsAcpMethod(
    { ...options, cwd },
    'nessy/settings/setExtensionSetting',
    { cwd, extensionId, settingKey, scope, value },
  );
  return response as unknown as NessyCoreSettingsSnapshot;
}

export async function getNessyPermissionSettingsViaAcp(
  options: NessySettingsAcpOptions,
): Promise<NessyPermissionSettings> {
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const response = await callNessySettingsAcpMethod(
    { ...options, cwd },
    'nessy/permissions/getSettings',
    { cwd },
  );
  return response as unknown as NessyPermissionSettings;
}

export async function setNessyPermissionRulesViaAcp(
  options: NessySettingsAcpOptions,
  scope: PermissionSettingsScope,
  ruleType: PermissionRuleType,
  rules: string[],
): Promise<NessyPermissionSettings> {
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const response = await callNessySettingsAcpMethod(
    { ...options, cwd },
    'nessy/permissions/setRules',
    { cwd, scope, ruleType, rules },
  );
  return response as unknown as NessyPermissionSettings;
}

export async function getNessyMemoryPathsViaAcp(
  options: NessySettingsAcpOptions & { projectRoot?: string },
): Promise<NessyMemoryPaths> {
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const response = await callNessySettingsAcpMethod(
    { ...options, cwd },
    'nessy/settings/getMemoryPaths',
    { cwd, projectRoot: options.projectRoot ?? cwd },
  );
  const paths = toRecord(response.paths);
  const userMemoryFile = asString(paths.userMemoryFile);
  const projectMemoryFile = asString(paths.projectMemoryFile);
  const autoMemoryDir = asString(paths.autoMemoryDir);
  if (!userMemoryFile || !projectMemoryFile || !autoMemoryDir) {
    throw new Error('Nessy ACP did not return memory paths');
  }
  return { userMemoryFile, projectMemoryFile, autoMemoryDir };
}

export async function listNessyProvidersViaAcp(
  options: NessySettingsAcpOptions,
): Promise<NessyProviderCatalog> {
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const response = await callNessySettingsAcpMethod(
    { ...options, cwd },
    'nessy/providers/list',
    { cwd },
  );
  return normalizeNessyProviderCatalog(response);
}

export async function getNessyWorkspacePreflightViaAcp(
  options: NessySettingsAcpOptions,
): Promise<Record<string, unknown>> {
  return callNessySettingsAcpMethod(options, 'nessy/status/workspace/preflight');
}

export async function fetchNessyModelsViaSharedAcp(
  options: NessySettingsAcpOptions,
): Promise<ModelFetchResult> {
  const response = await callNessySettingsAcpMethod(
    options,
    'nessy/status/workspace/providers',
  );
  const current = toRecord(response.current);
  let serverDefault = asString(current.modelId);
  const providers = Array.isArray(response.providers)
    ? response.providers.filter(isRecord)
    : [];
  const models: ModelDefinition[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    const providerModels = Array.isArray(provider.models)
      ? provider.models
      : [];
    for (const value of providerModels) {
      const model = toNessyModelDefinition(value);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
      if (!serverDefault && toRecord(value).isCurrent === true) {
        serverDefault = model.id;
      }
    }
  }

  if (models.length === 0) {
    throw new Error('Nessy ACP workspace providers did not return models');
  }

  return { models, serverDefault };
}

function normalizeNessyProviderCatalog(
  response: JsonRecord,
): NessyProviderCatalog {
  return {
    providers: Array.isArray(response.providers)
      ? (response.providers as NessyProviderCatalog['providers'])
      : [],
  };
}

export async function connectNessyProviderViaAcp(
  options: NessySettingsAcpOptions,
  params: NessyProviderConnectParams,
): Promise<NessyProviderConnectResult> {
  const cwd = options.cwd || nessySettingsCwd(options.hostRuntime);
  const response = await callNessySettingsAcpMethod(
    { ...options, cwd },
    'nessy/providers/connect',
    { cwd, ...(params as unknown as JsonRecord) },
  );
  return normalizeNessyProviderConnectResult(response);
}

function normalizeNessyProviderConnectResult(
  response: JsonRecord,
): NessyProviderConnectResult {
  const error = asString(response.error);
  const providerId = asString(response.providerId);
  const providerLabel = asString(response.providerLabel);
  const authType = asString(response.authType);
  const modelId = asString(response.modelId);
  return {
    success: response.success === true,
    ...(error ? { error } : {}),
    ...(providerId ? { providerId } : {}),
    ...(providerLabel ? { providerLabel } : {}),
    ...(authType ? { authType } : {}),
    ...(modelId ? { modelId } : {}),
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function extractNessyParentToolUseId(
  update: Record<string, unknown>,
): string | undefined {
  const meta = toRecord(update._meta);
  return (
    asString(update.parentToolCallId) ||
    asString(update.parentToolUseId) ||
    asString(update.parent_tool_use_id) ||
    asString(meta.parentToolCallId) ||
    asString(meta.parentToolUseId) ||
    asString(meta.parent_tool_use_id)
  );
}

export function resolveNessyParentToolUseId(args: {
  update: Record<string, unknown>;
  toolUseId?: string;
  activeParentToolUseIds?: ReadonlySet<string>;
}): string | undefined {
  const explicitParentToolUseId = extractNessyParentToolUseId(args.update);
  if (explicitParentToolUseId && explicitParentToolUseId !== args.toolUseId) {
    return explicitParentToolUseId;
  }

  const activeParentToolUseIds = args.activeParentToolUseIds;
  if (activeParentToolUseIds?.size === 1) {
    const [activeParentToolUseId] = activeParentToolUseIds;
    if (activeParentToolUseId !== args.toolUseId) {
      return activeParentToolUseId;
    }
  }

  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseAskUserQuestions(
  value: unknown,
): AskUserQuestionItem[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const questions = value
    .filter(isRecord)
    .map((question) => {
      const options = Array.isArray(question.options)
        ? question.options
            .filter(isRecord)
            .map((option) => ({
              label: asString(option.label) || '',
              description: asString(option.description) || '',
            }))
            .filter((option) => option.label)
        : [];

      return {
        question: asString(question.question) || '',
        header: asString(question.header) || '',
        options,
        ...(asBoolean(question.multiSelect) !== undefined
          ? { multiSelect: asBoolean(question.multiSelect) }
          : {}),
      };
    })
    .filter(
      (question) =>
        question.question && question.header && question.options.length > 0,
    );

  return questions.length > 0 ? questions : undefined;
}

/**
 * Inverse of the CLI's `buildElicitationRequestedSchema`: converts an ACP
 * form-mode `requestedSchema` back into the `{ question, header, options,
 * multiSelect }` shape the existing ask_user_question UI renders.
 */
// [nessy-fork] acp-elicitation-ask-user-question
function requestedSchemaToQuestions(
  schema: Record<string, unknown>,
): AskUserQuestionItem[] {
  const properties = toRecord(schema.properties);
  const questions: AskUserQuestionItem[] = [];
  for (const [key, rawProperty] of Object.entries(properties)) {
    const property = toRecord(rawProperty);
    const type = asString(property.type);
    const title = asString(property.title) || key;
    const description = asString(property.description) || title;
    const options = collectSchemaOptions(property);
    questions.push({
      question: description,
      header: title,
      options,
      ...(type === 'array' ? { multiSelect: true } : {}),
    });
  }
  return questions;
}

/**
 * Collects selectable options from an elicitation property schema. The enum
 * may live in three places depending on the variant the agent chose:
 * - single-select plain enum → `property.enum`
 * - multi-select → `property.items.enum` (the `buildElicitationRequestedSchema`
 *   in the CLI emits `{ type: 'array', items: { enum } }`)
 * - single-select titled enum → `property.oneOf` (array of `{ const, title }`)
 */
// [nessy-fork] acp-elicitation-ask-user-question
function collectSchemaOptions(
  property: Record<string, unknown>,
): Array<{ label: string; description: string }> {
  const items = toRecord(property.items);
  const enumLabels = [
    ...(Array.isArray(property.enum)
      ? property.enum.filter(
          (item): item is string => typeof item === 'string',
        )
      : []),
    ...(Array.isArray(items.enum)
      ? items.enum.filter((item): item is string => typeof item === 'string')
      : []),
  ];
  const oneOfOptions = Array.isArray(property.oneOf)
    ? property.oneOf
        .map((item) => {
          const rec = toRecord(item);
          const constValue = asString(rec.const) || asString(rec.title) || '';
          if (!constValue) return null;
          return {
            label: asString(rec.title) || constValue,
            description: constValue,
          };
        })
        .filter(
          (
            option,
          ): option is { label: string; description: string } =>
            option !== null,
        )
    : [];
  if (oneOfOptions.length > 0) return oneOfOptions;
  return enumLabels.map((label) => ({ label, description: label }));
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = asNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    const bool = asBoolean(value);
    if (bool !== undefined) return bool;
  }
  return undefined;
}

function firstRecord(...values: unknown[]): JsonRecord {
  for (const value of values) {
    const record = toRecord(value);
    if (Object.keys(record).length > 0) return record;
  }
  return {};
}

function toNessyModelDefinition(value: unknown): ModelDefinition | null {
  const model = toRecord(value as ModelInfo);
  const id = asString(model.modelId);
  if (!id) return null;
  const name = asString(model.name) || id;
  const meta = toRecord(model._meta);
  const generationConfig = toRecord(model.generationConfig);
  const metaGenerationConfig = toRecord(meta.generationConfig);
  const extraBody = toRecord(generationConfig.extra_body);
  const metaExtraBody = toRecord(metaGenerationConfig.extra_body);
  const capabilities = toRecord(model.capabilities);
  const limits = toRecord(capabilities.limits);
  const metaCapabilities = toRecord(meta.capabilities);
  const metaLimits = toRecord(metaCapabilities.limits);
  const contextWindow = firstNumber(
    meta.contextLimit,
    meta.contextWindowSize,
    meta.contextWindow,
    model.contextLimit,
    model.contextWindowSize,
    model.contextWindow,
    model.maxContextWindowTokens,
    metaGenerationConfig.contextWindowSize,
    metaGenerationConfig.contextWindow,
    generationConfig.contextWindowSize,
    generationConfig.contextWindow,
    metaLimits.max_context_window_tokens,
    limits.max_context_window_tokens,
  );
  const supportsThinking = firstBoolean(
    meta.supportsThinking,
    meta.supportsReasoning,
    meta.enableThinking,
    meta.enable_thinking,
    model.supportsThinking,
    model.supportsReasoning,
    model.enableThinking,
    model.enable_thinking,
    metaGenerationConfig.enableThinking,
    metaGenerationConfig.enable_thinking,
    metaExtraBody.enableThinking,
    metaExtraBody.enable_thinking,
    generationConfig.enableThinking,
    generationConfig.enable_thinking,
    extraBody.enableThinking,
    extraBody.enable_thinking,
  );

  return {
    id,
    name,
    shortName: name,
    description: asString(model.description) || '',
    provider: 'nessy',
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(supportsThinking !== undefined ? { supportsThinking } : {}),
  };
}

function toRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function toAvailableSlashCommands(value: unknown): AvailableSlashCommand[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const commands: AvailableSlashCommand[] = [];

  for (const item of value) {
    const record = toRecord(item);
    const rawName = asString(record.name)?.trim().replace(/^\/+/, '');
    if (!rawName || seen.has(rawName)) continue;

    seen.add(rawName);
    const input =
      record.input === null || isRecord(record.input)
        ? record.input
        : undefined;

    commands.push({
      name: rawName,
      description: asString(record.description),
      ...(input !== undefined && { input }),
    });
  }

  return commands;
}

function toAvailableSkills(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const seen = new Set<string>();
  const skills: string[] = [];

  for (const item of value) {
    const name = asString(item)?.trim().replace(/^\/+/, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    skills.push(name);
  }

  return skills.length > 0 ? skills : undefined;
}

// [nessy-fork] desktop-skill-scope-management
function toAvailableSkillDetails(
  value: unknown,
  preserveScopes = false,
): AvailableSkillDetail[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const seen = new Set<string>();
  const details: AvailableSkillDetail[] = [];

  for (const item of value) {
    const record = toRecord(item);
    const name = asString(record.name)?.trim().replace(/^\/+/, '');
    if (!name) continue;
    const level = asString(record.level);
    const key = preserveScopes ? `${level ?? ''}:${name}` : name;
    if (seen.has(key)) continue;
    seen.add(key);

    const description = asString(record.description);
    const body = asString(record.body);
    const filePath = asString(record.filePath);
    const modelInvocable = asBoolean(record.modelInvocable);
    // [nessy-fork] desktop-skill-parse-error-display
    const parseError = asString(record.parseError);

    details.push({
      name,
      ...(description !== undefined && { description }),
      ...(body !== undefined && { body }),
      ...(filePath !== undefined && { filePath }),
      ...(level !== undefined && { level }),
      ...(modelInvocable !== undefined && { modelInvocable }),
      ...(parseError !== undefined && { parseError }),
    });
  }

  return details.length > 0 ? details : undefined;
}

function formatDebugNames(values: string[] | undefined, max = 40): string {
  if (!values || values.length === 0) return 'none';
  const visible = values.slice(0, max).join(', ');
  return values.length > max
    ? `${visible}, ... +${values.length - max} more`
    : visible;
}

function parseNessyTimestamp(value: unknown): number | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function sanitizeNessyCwd(cwd: string): string {
  const normalizedCwd = platform() === 'win32' ? cwd.toLowerCase() : cwd;
  return normalizedCwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function resolveNessyRuntimeDir(dir: string): string {
  if (dir === '~') return homedir();
  if (dir.startsWith('~/') || dir.startsWith('~\\')) {
    return join(
      homedir(),
      ...dir
        .slice(2)
        .split(/[/\\]+/)
        .filter(Boolean),
    );
  }
  return isAbsolute(dir) ? dir : resolve(dir);
}

function getNessyRuntimeDir(): string {
  const envDir = process.env.NESSY_RUNTIME_DIR;
  if (envDir) return resolveNessyRuntimeDir(envDir);

  const homeDir = homedir();
  return homeDir ? join(homeDir, '.nessy') : join(tmpdir(), '.nessy');
}

function getNessyTranscriptPath(sessionId: string, cwd: string): string {
  const projectId = sanitizeNessyCwd(resolve(cwd));
  return join(
    getNessyRuntimeDir(),
    'projects',
    projectId,
    'chats',
    `${sessionId}.jsonl`,
  );
}

function nessySkillNameFromTextElement(
  element: MessageTextElement,
): string | undefined {
  const raw = (
    element.target ||
    element.label ||
    element.placeholder ||
    ''
  ).trim();
  if (!raw) return undefined;

  const bracketMatch = /^\[skill:([^\]]+)\]$/.exec(raw);
  const normalized = (bracketMatch?.[1] ?? raw).trim();
  const withoutPlugin = normalized.startsWith('.agents:')
    ? normalized.slice('.agents:'.length).trim()
    : normalized;
  return withoutPlugin.split(':').pop()?.trim() || withoutPlugin;
}

function rangesOverlapBytes(
  a: MessageTextElement,
  b: MessageTextElement,
): boolean {
  return (
    a.byte_range.start < b.byte_range.end &&
    b.byte_range.start < a.byte_range.end
  );
}

function nessyTranscriptPlaceholderFromSourceElement(
  sourceElement: MessageTextElement,
): string | undefined {
  if (sourceElement.type === 'skill') {
    const skillName = nessySkillNameFromTextElement(sourceElement);
    return skillName ? `@${skillName}` : undefined;
  }

  return sourceElement.placeholder || undefined;
}

function findNonOverlappingPlaceholderStart(
  content: string,
  placeholder: string,
  elements: MessageTextElement[],
): number {
  let start = content.indexOf(placeholder);
  while (start >= 0) {
    const candidate: MessageTextElement = {
      type: 'context',
      byte_range: {
        start: utf16IndexToByteOffset(content, start),
        end: utf16IndexToByteOffset(content, start + placeholder.length),
      },
      placeholder,
    };
    if (!elements.some((existing) => rangesOverlapBytes(existing, candidate)))
      return start;
    start = content.indexOf(placeholder, start + placeholder.length);
  }
  return -1;
}

function buildNessyTranscriptTextElements(
  content: string,
  sourceElements?: MessageTextElement[],
): MessageTextElement[] | undefined {
  const elements: MessageTextElement[] = [];

  for (const sourceElement of sourceElements ?? []) {
    const placeholder =
      nessyTranscriptPlaceholderFromSourceElement(sourceElement);
    if (!placeholder) continue;

    const start = findNonOverlappingPlaceholderStart(
      content,
      placeholder,
      elements,
    );
    if (start < 0) continue;

    const element: MessageTextElement = {
      type: sourceElement.type,
      byte_range: {
        start: utf16IndexToByteOffset(content, start),
        end: utf16IndexToByteOffset(content, start + placeholder.length),
      },
      placeholder,
      ...(sourceElement.label ? { label: sourceElement.label } : {}),
      ...(sourceElement.target ? { target: sourceElement.target } : {}),
      ...(sourceElement.metadata ? { metadata: sourceElement.metadata } : {}),
    };

    if (sourceElement.type === 'skill') {
      const skillName = nessySkillNameFromTextElement(sourceElement);
      if (skillName) {
        element.target = skillName;
        element.label = sourceElement.label || skillName;
      }
    }

    elements.push(element);
  }

  elements.sort((a, b) => a.byte_range.start - b.byte_range.start);
  return elements.length > 0 ? elements : undefined;
}

function toNessyTranscriptTextElements(
  value: unknown,
): MessageTextElement[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const byteOffset = (offset: unknown): number | undefined => {
    if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0)
      return offset;
    if (typeof offset !== 'string') return undefined;
    const parsed = Number(offset);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };

  const elements = value
    .filter(isRecord)
    .map((element): MessageTextElement | null => {
      const type = asString(element.type) as
        | MessageTextElement['type']
        | undefined;
      const byteRange = toRecord(element.byte_range);
      const start = byteOffset(byteRange.start);
      const end = byteOffset(byteRange.end);
      const placeholder = asString(element.placeholder);
      if (!type || start == null || end == null || !placeholder) return null;
      if (
        ![
          'source',
          'skill',
          'context',
          'slash_command',
          'file',
          'folder',
        ].includes(type)
      )
        return null;
      return {
        type,
        byte_range: { start, end },
        placeholder,
        ...(asString(element.label) ? { label: asString(element.label) } : {}),
        ...(asString(element.target)
          ? { target: asString(element.target) }
          : {}),
        ...(isRecord(element.metadata) ? { metadata: element.metadata } : {}),
      };
    })
    .filter((element): element is MessageTextElement => !!element);

  return elements.length > 0 ? elements : undefined;
}

function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isNessyUserInterruptText(value: string | undefined): boolean {
  if (!value) return false;
  const text = value.toLowerCase();
  return (
    text.includes('request was aborted') ||
    text.includes('apiuseraborterror') ||
    text.includes('cancelled by user') ||
    text.includes('canceled by user') ||
    text.includes('user abort')
  );
}

function isNessyUserInterruptStatus(value: string | undefined): boolean {
  return (
    value === 'cancelled' ||
    value === 'canceled' ||
    isNessyUserInterruptText(value)
  );
}

function isNessyToolFailureStatus(status: string | undefined): boolean {
  return status === 'failed' || status === 'error';
}

function firstStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function nessyFunctionResponseText(response: JsonRecord): string | undefined {
  const direct = firstStringValue(
    response.output,
    response.content,
    response.error,
    response.result,
  );
  if (direct) return direct;
  return Object.keys(response).length > 0 ? jsonStringify(response) : undefined;
}

function parseJsonText(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isJsonCodeFence(value: string): boolean {
  return /^```(?:json|JSON)?\s*\r?\n/.test(value.trim());
}

function isDoctorOutput(value: unknown): boolean {
  const record = toRecord(value);
  return Array.isArray(record.checks) && isRecord(record.summary);
}

function formatJsonMarkdown(value: unknown): string {
  return `\`\`\`json\n${jsonStringify(value)}\n\`\`\``;
}

function normalizeNessyAssistantText(
  text: string,
  options: { forceJsonFence?: boolean } = {},
): string {
  const trimmed = text.trim();
  if (!trimmed || isJsonCodeFence(trimmed)) return text;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;

  const parsed = parseJsonText(text);
  if (!parsed) return text;
  if (!options.forceJsonFence && !isDoctorOutput(parsed)) return text;

  return formatJsonMarkdown(parsed);
}

function formatNessySlashOutputHistoryItem(
  item: JsonRecord,
): string | undefined {
  const text = asString(item.text);
  if (text?.trim()) {
    return normalizeNessyAssistantText(text, { forceJsonFence: true });
  }

  if (item.type === 'doctor') {
    return formatJsonMarkdown({
      checks: Array.isArray(item.checks) ? item.checks : [],
      summary: toRecord(item.summary),
    });
  }

  return undefined;
}

function isSlashCommandPrompt(
  message: string,
  attachments?: FileAttachment[],
): boolean {
  if (attachments && attachments.length > 0) return false;
  return /^\/[A-Za-z][\w-]*(?:\s|$)/.test(message.trim());
}

function nessyInitializeTimeoutMs(): number {
  const raw =
    process.env.NESSY_ACP_INITIALIZE_TIMEOUT_MS ||
    process.env.NESSY_INITIALIZE_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_INITIALIZE_TIMEOUT_MS;
}

function mapPermissionModeToNessy(mode: PermissionMode): string {
  switch (mode) {
    case 'allow-all':
      return 'auto';
    case 'safe':
      return 'plan';
    case 'auto-edit':
      return 'auto-edit';
    case 'ask':
    default:
      return 'default';
  }
}

function mapNessyModeToPermissionMode(
  mode: string | undefined,
): PermissionMode | undefined {
  switch (mode) {
    case 'plan':
      return 'safe';
    case 'auto':
    case 'yolo':
      return 'allow-all';
    case 'auto-edit':
      return 'auto-edit';
    case 'default':
      return 'ask';
    default:
      return undefined;
  }
}

function mapPlanStatus(
  status: unknown,
): 'pending' | 'in_progress' | 'completed' {
  switch (status) {
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'in_progress':
    case 'in-progress':
    case 'running':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function normalizeToolName(
  toolName: string | undefined,
  kind?: string,
): string {
  const raw = (toolName || kind || 'tool').trim();
  const lower = raw.toLowerCase();

  const mappings: Record<string, string> = {
    read_file: 'Read',
    read_many_files: 'Read',
    write_file: 'Write',
    edit: 'Edit',
    replace: 'Edit',
    list_directory: 'LS',
    glob: 'Glob',
    file_search: 'Glob',
    search_file_content: 'Grep',
    grep: 'Grep',
    content_search: 'Grep',
    run_shell_command: 'Bash',
    shell: 'Bash',
    web_fetch: 'WebFetch',
    todo_write: 'TodoWrite',
    exit_plan_mode: 'ExitPlanMode',
  };

  if (mappings[lower]) return mappings[lower];

  switch (kind) {
    case 'read':
      return 'Read';
    case 'edit':
    case 'delete':
    case 'move':
      return 'Edit';
    case 'search':
      return 'Grep';
    case 'execute':
      return 'Bash';
    case 'fetch':
      return 'WebFetch';
    case 'switch_mode':
      return 'ExitPlanMode';
    default:
      return raw;
  }
}

function displayNameForTool(toolName: string, kind?: string): string {
  if (toolName === 'Bash') return 'Run Command';
  if (toolName === 'Read') return 'Read File';
  if (toolName === 'Write') return 'Write File';
  if (toolName === 'Edit') return 'Edit File';
  if (toolName === 'LS') return 'List Directory';
  if (toolName === 'Glob') return 'Search Files';
  if (toolName === 'Grep') return 'Search Content';
  if (toolName === 'WebFetch') return 'Fetch URL';
  if (toolName === 'ExitPlanMode') return 'Switch Mode';
  if (kind === 'think') return 'Think';
  return toolName;
}

function permissionTypeForKind(
  kind?: string,
): PermissionRequestType | undefined {
  switch (kind) {
    case 'execute':
      return 'bash';
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_write';
    case 'fetch':
      return 'api_mutation';
    case 'switch_mode':
      return 'mcp_mutation';
    default:
      return 'mcp_mutation';
  }
}

interface QueuedMidTurnMessage extends MidTurnMessageMetadata {
  message: string;
  attachments?: FileAttachment[];
  buildFailureCount?: number;
}

export class NessyAgent extends BaseAgent {
  protected backendName = 'Nessy CLI';

  private acpLease: NessyAcpLease | null = null;
  private connection: ClientSideConnection | null = null;

  private nessySessionId: string | null = null;
  private ensureNessySessionPromise: Promise<void> | null = null;
  private eventQueue = new EventQueue();
  private _isProcessing = false;
  private abortReason?: AbortReason;
  private persistedNessySessionId: string | null = null;
  private activePromptRunId: number | null = null;
  private promptRunCounter = 0;
  private permissionRequestCounter = 0;
  // [nessy-fork] acp-elicitation-ask-user-question
  private elicitationRequestCounter = 0;
  private toolIdCounter = 0;
  private planUpdateCounter = 0;
  private hasInitialModeOverride = false;
  private pendingModeOverride: PermissionMode | null = null;

  private pendingPermissions = new Map<string, PendingPermission>();
  // [nessy-fork] acp-elicitation-ask-user-question
  private pendingElicitations = new Map<
    string,
    (response: CreateElicitationResponse) => void
  >();
  private miniCollectors = new Map<string, MiniCollector>();
  private historyCollectors = new Map<string, HistoryCollector>();
  private ensureProcessPromise: Promise<void> | null = null;
  private suppressedSessionUpdates = new Set<string>();
  private pendingAvailableCommandsUpdates = new Map<string, JsonRecord>();
  private latestAvailableCommandsSnapshot: AvailableCommandsSnapshot | null =
    null;
  private availableCommandsWaiters: Array<
    (snapshot: AvailableCommandsSnapshot | null) => void
  > = [];
  private availableModelIds: Set<string> | null = null;
  private availableModelsById = new Map<string, ModelDefinition>();
  private firstAvailableModelId: string | undefined;

  private sourceMcpServers: Record<string, SdkMcpServerConfig> = {};
  private currentTurnId: string | undefined;
  private currentAssistantText = '';
  private currentThoughtText = '';
  private currentAssistantParentToolUseId: string | undefined;
  private currentThoughtParentToolUseId: string | undefined;
  private currentIsSlashCommand = false;
  private capturedUsageInCurrentTurn = false;
  private usageWaiters: Array<() => void> = [];
  private toolNames = new Map<string, string>();
  private toolInputs = new Map<string, Record<string, unknown>>();
  private activeParentToolUseIds = new Set<string>();
  private midTurnMessageQueue: QueuedMidTurnMessage[] = [];

  constructor(config: BackendConfig) {
    super(config, config.model || '');
    this._supportsBranching = false;
    this.persistedNessySessionId = config.session?.sdkSessionId || null;
    this.pendingModeOverride =
      config.session?.permissionMode && !config.session?.sdkSessionId
        ? config.session.permissionMode
        : null;
    this.hasInitialModeOverride = this.pendingModeOverride !== null;

    if (!config.isHeadless) {
      this.startConfigWatcher();
    }
  }

  getRecentStderr(): string {
    return this.acpLease?.recentStderr() ?? '';
  }

  override getSessionId(): string | null {
    return (
      this.nessySessionId ??
      this.persistedNessySessionId ??
      this.config.session?.sdkSessionId ??
      null
    );
  }

  override setSessionId(sessionId: string | null): void {
    super.setSessionId(sessionId);
    if (this.nessySessionId) this.unregisterAcpSession(this.nessySessionId);
    this.nessySessionId = sessionId;
    this.persistedNessySessionId = sessionId;
    if (sessionId) this.registerAcpSession(sessionId);
  }

  override clearHistory(): void {
    super.clearHistory();
    if (this.nessySessionId) this.unregisterAcpSession(this.nessySessionId);
    this.nessySessionId = null;
    this.persistedNessySessionId = null;
    this.pendingAvailableCommandsUpdates.clear();
    this.latestAvailableCommandsSnapshot = null;
    this.resolveAvailableCommandsWaiters(null);
    this.config.onSdkSessionIdCleared?.();
  }

  protected override extractSkillPaths(message: string): {
    skillPaths: Map<string, string>;
    cleanMessage: string;
    missingSkills: string[];
  } {
    const withNessySkills = message.replace(
      /\[skill:([^\]]+)\]/g,
      (_match, rawSkill: string) => {
        const normalized = rawSkill.trim();
        const skillName = normalized.startsWith('.agents:')
          ? normalized.slice('.agents:'.length).trim()
          : normalized;
        return skillName ? `@${skillName}` : '';
      },
    );
    const withSources = resolveSourceMentions(withNessySkills);
    const workDir =
      this.config.session?.workingDirectory ?? this.workingDirectory;
    const cleanMessage = resolveFileMentions(withSources, workDir).trim();

    if (withNessySkills !== message) {
      this.debug(
        '[extractSkillPaths] Nessy skill mentions are passed to ACP as @skill references',
      );
    }

    return {
      skillPaths: new Map(),
      cleanMessage: cleanMessage || message.trim(),
      missingSkills: [],
    };
  }

  override updateWorkingDirectory(path: string): void {
    super.updateWorkingDirectory(path);
    if (this.nessySessionId) {
      this.unregisterAcpSession(this.nessySessionId);
      this.nessySessionId = null;
      this.persistedNessySessionId = null;
      this.pendingAvailableCommandsUpdates.clear();
      this.latestAvailableCommandsSnapshot = null;
      this.resolveAvailableCommandsWaiters(null);
      this.config.onSdkSessionIdCleared?.();
      this.debug('Nessy ACP session cleared after working directory change');
    }
  }

  private invalidateAvailableCommandsSnapshot(reason: string): void {
    if (this.latestAvailableCommandsSnapshot) {
      this.debug(`Nessy slash command snapshot invalidated: ${reason}`);
    }
    this.latestAvailableCommandsSnapshot = null;
  }

  protected async *chatImpl(
    messageParam: string,
    attachments?: FileAttachment[],
    options?: ChatOptions,
  ): AsyncGenerator<AgentEvent> {
    let message = messageParam;
    const promptRunId = ++this.promptRunCounter;
    this.activePromptRunId = promptRunId;
    this._isProcessing = true;
    this.abortReason = undefined;
    this.eventQueue.reset();
    this.currentAssistantText = '';
    this.currentThoughtText = '';
    this.currentAssistantParentToolUseId = undefined;
    this.currentThoughtParentToolUseId = undefined;
    this.currentIsSlashCommand = isSlashCommandPrompt(message, attachments);
    this.capturedUsageInCurrentTurn = false;
    this.currentTurnId = `nessy-turn-${promptRunId}`;
    this.toolNames.clear();
    this.toolInputs.clear();
    this.activeParentToolUseIds.clear();
    this.midTurnMessageQueue = [];

    this.emitAutomationEvent('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: message,
    });

    try {
      await this.ensureProcess();

      try {
        await this.ensureNessySession();
      } catch (error) {
        if (this.persistedNessySessionId || this.config.session?.sdkSessionId) {
          this.debug(
            `Nessy resume failed, starting a fresh session: ${error instanceof Error ? error.message : String(error)}`,
          );
          this.nessySessionId = null;
          this.persistedNessySessionId = null;
          this.config.onSdkSessionIdCleared?.();
          const recoveryContext = this.buildRecoveryContext();
          if (recoveryContext && !isSlashCommandPrompt(message, attachments)) {
            message = recoveryContext + message;
          }
          await this.ensureNessySession();
        } else {
          throw error;
        }
      }

      const sessionId = this.nessySessionId;
      if (!sessionId) throw new Error('Nessy ACP session was not created');

      const prompt = this.buildPromptBlocks(message, attachments);
      let transcriptTextElementsPersisted = false;
      const persistTranscriptTextElements = () => {
        if (transcriptTextElementsPersisted) return;
        transcriptTextElementsPersisted = true;
        this.persistNessyTranscriptTextElements(
          sessionId,
          this.resolvedCwd(),
          options?.textElements,
        );
      };
      const promptPromise = this.callAcp(
        'session/prompt',
        (connection) => connection.prompt({ sessionId, prompt }),
        0,
      );

      promptPromise
        .then(async (result) => {
          if (this.activePromptRunId !== promptRunId) return;
          const stopReason = asString(toRecord(result).stopReason);
          await this.waitForCurrentTurnUsage();
          if (this.activePromptRunId !== promptRunId) return;
          persistTranscriptTextElements();
          this.flushThoughtText();
          this.flushAssistantText();
          this.eventQueue.enqueue({ type: 'complete' });
          this.eventQueue.complete();
          this.debug(
            `Nessy prompt complete${stopReason ? ` (${stopReason})` : ''}`,
          );
        })
        .catch((error) => {
          if (this.activePromptRunId !== promptRunId) return;
          if (this.abortReason) {
            persistTranscriptTextElements();
            this.eventQueue.complete();
            return;
          }
          const message = formatNessyAcpErrorMessage(error);
          persistTranscriptTextElements();
          this.eventQueue.enqueue({ type: 'error', message });
          this.eventQueue.enqueue({ type: 'complete' });
          this.eventQueue.complete();
        });

      for await (const event of this.eventQueue.drain()) {
        yield event;
        if (event.type === 'tool_result') {
          const pendingRestart = this.consumePendingSourceActivationRestart();
          if (pendingRestart) {
            yield {
              type: 'source_activated',
              sourceSlug: pendingRestart.sourceSlug,
              originalMessage: pendingRestart.userMessage,
            };
            this.forceAbort(AbortReason.SourceActivated);
            return;
          }
        }
      }
    } catch (error) {
      const message = formatNessyAcpErrorMessage(error);
      yield { type: 'error', message };
      yield { type: 'complete' };
    } finally {
      if (this.activePromptRunId === promptRunId) {
        this.activePromptRunId = null;
      }
      this._isProcessing = false;
      this.currentTurnId = undefined;
      this.currentAssistantText = '';
      this.currentThoughtText = '';
      this.currentIsSlashCommand = false;
      this.resolveUsageWaiters();
      this.midTurnMessageQueue = [];
    }
  }

  isProcessing(): boolean {
    return this._isProcessing;
  }

  private waitForCurrentTurnUsage(timeoutMs = 50): Promise<void> {
    if (this.capturedUsageInCurrentTurn) return Promise.resolve();

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        this.usageWaiters = this.usageWaiters.filter(
          (waiter) => waiter !== finish,
        );
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      this.usageWaiters.push(finish);
    });
  }

  private resolveUsageWaiters(): void {
    const waiters = this.usageWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  enqueueMidTurnMessage(
    message: string,
    attachments?: FileAttachment[],
    metadata?: MidTurnMessageMetadata,
  ): boolean {
    const trimmed = message.trim();
    if (
      (!trimmed && !attachments?.length) ||
      !this._isProcessing ||
      this.abortReason
    ) {
      return false;
    }

    this.midTurnMessageQueue.push({
      message: trimmed,
      attachments,
      messageId: metadata?.messageId,
      optimisticMessageId: metadata?.optimisticMessageId,
    });
    this.debug(
      `Queued mid-turn user message for Nessy ACP injection (${this.midTurnMessageQueue.length} pending)`,
    );
    return true;
  }

  async abort(reason?: string): Promise<void> {
    this.debug(`Nessy abort requested${reason ? `: ${reason}` : ''}`);
    this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' });
    this.abortReason = AbortReason.UserStop;
    this._isProcessing = false;
    this.activePromptRunId = null;
    this.midTurnMessageQueue = [];
    this.cancelPendingPermissions();

    const sessionId = this.nessySessionId;
    if (sessionId && this.connection) {
      await this.callAcp(
        'session/cancel',
        (connection) => connection.cancel({ sessionId }),
        5_000,
      ).catch((error) => {
        this.debug(
          `Nessy cancel failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }

    this.eventQueue.complete();
  }

  forceAbort(reason: AbortReason): void {
    this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' });
    this.abortReason = reason;
    this._isProcessing = false;
    this.activePromptRunId = null;
    this.midTurnMessageQueue = [];
    this.cancelPendingPermissions();
    this.eventQueue.complete();

    const sessionId = this.nessySessionId;
    if (sessionId && this.connection) {
      void this.callAcp(
        'session/cancel',
        (connection) => connection.cancel({ sessionId }),
        5_000,
      ).catch((error) => {
        this.debug(
          `Nessy force cancel failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  respondToPermission(
    requestId: string,
    allowed: boolean,
    alwaysAllow?: boolean,
    options?: PermissionResponseOptions,
  ): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;

    this.pendingPermissions.delete(requestId);
    pending.resolve(
      this.createPermissionResponse(
        pending.options,
        allowed,
        !!alwaysAllow,
        options?.answers,
      ),
    );
  }

  override setPermissionMode(mode: PermissionMode): void {
    this.hasInitialModeOverride = true;
    this.pendingModeOverride = mode;
    super.setPermissionMode(mode);
    void this.forwardPermissionMode(mode);
  }

  override cyclePermissionMode(): PermissionMode {
    this.hasInitialModeOverride = true;
    const mode = super.cyclePermissionMode();
    this.pendingModeOverride = mode;
    void this.forwardPermissionMode(mode);
    return mode;
  }

  async getPermissionSettings(): Promise<NessyPermissionSettings> {
    await this.ensureProcess();
    const result = await this.callAcp(
      'nessy/permissions/getSettings',
      (connection) =>
        connection.extMethod('nessy/permissions/getSettings', {
          cwd: this.resolvedCwd(),
        }),
      10_000,
    );
    return result as unknown as NessyPermissionSettings;
  }

  async setPermissionRules(
    scope: PermissionSettingsScope,
    ruleType: PermissionRuleType,
    rules: string[],
  ): Promise<NessyPermissionSettings> {
    await this.ensureProcess();
    const result = await this.callAcp(
      'nessy/permissions/setRules',
      (connection) =>
        connection.extMethod('nessy/permissions/setRules', {
          cwd: this.resolvedCwd(),
          scope,
          ruleType,
          rules,
        }),
      10_000,
    );
    return result as unknown as NessyPermissionSettings;
  }

  async getCoreSettings(): Promise<NessyCoreSettingsSnapshot> {
    await this.ensureProcess();
    const result = await this.callAcp(
      'nessy/settings/getCore',
      (connection) =>
        connection.extMethod('nessy/settings/getCore', {
          cwd: this.resolvedCwd(),
        }),
      10_000,
    );
    return result as unknown as NessyCoreSettingsSnapshot;
  }

  async listProviders(): Promise<NessyProviderCatalog> {
    await this.ensureProcess();
    const result = await this.callAcp(
      'nessy/providers/list',
      (connection) =>
        connection.extMethod('nessy/providers/list', {
          cwd: this.resolvedCwd(),
        }),
      10_000,
    );
    return normalizeNessyProviderCatalog(toRecord(result));
  }

  async connectProvider(
    params: NessyProviderConnectParams,
  ): Promise<NessyProviderConnectResult> {
    await this.ensureProcess();
    const result = await this.callAcp(
      'nessy/providers/connect',
      (connection) =>
        connection.extMethod('nessy/providers/connect', {
          cwd: this.resolvedCwd(),
          ...params,
        } as unknown as JsonRecord),
      30_000,
    );
    return normalizeNessyProviderConnectResult(toRecord(result));
  }

  async setCoreSetting(
    scope: NessySettingsScope,
    key: NessyCoreSettingKey,
    value: NessySettingValue,
  ): Promise<NessyCoreSettingsSnapshot> {
    await this.ensureProcess();
    const result = await this.callAcp(
      'nessy/settings/setCoreValue',
      (connection) =>
        connection.extMethod('nessy/settings/setCoreValue', {
          cwd: this.resolvedCwd(),
          scope,
          key,
          value,
        }),
      10_000,
    );
    return result as unknown as NessyCoreSettingsSnapshot;
  }

  async setMcpServer(
    scope: NessySettingsScope,
    name: string,
    server: NessyMcpServerConfig,
  ): Promise<NessyCoreSettingsSnapshot> {
    await this.ensureProcess();
    const result = await this.callAcp(
      'nessy/settings/setMcpServer',
      (connection) =>
        connection.extMethod('nessy/settings/setMcpServer', {
          cwd: this.resolvedCwd(),
          scope,
          name,
          server,
        }),
      10_000,
    );
    return result as unknown as NessyCoreSettingsSnapshot;
  }

  async removeMcpServer(
    scope: NessySettingsScope,
    name: string,
  ): Promise<NessyCoreSettingsSnapshot> {
    await this.ensureProcess();
    const result = await this.callAcp(
      'nessy/settings/removeMcpServer',
      (connection) =>
        connection.extMethod('nessy/settings/removeMcpServer', {
          cwd: this.resolvedCwd(),
          scope,
          name,
        }),
      10_000,
    );
    return result as unknown as NessyCoreSettingsSnapshot;
  }

  async setHook(
    scope: NessySettingsScope,
    event: NessyHookEvent,
    index: number | undefined,
    hook: NessyHookDefinition,
  ): Promise<NessyCoreSettingsSnapshot> {
    await this.ensureProcess();
    const result = await this.callAcp(
      'nessy/settings/setHook',
      (connection) =>
        connection.extMethod('nessy/settings/setHook', {
          cwd: this.resolvedCwd(),
          scope,
          event,
          index,
          hook,
        }),
      10_000,
    );
    return result as unknown as NessyCoreSettingsSnapshot;
  }

  async removeHook(
    scope: NessySettingsScope,
    event: NessyHookEvent,
    index: number,
  ): Promise<NessyCoreSettingsSnapshot> {
    await this.ensureProcess();
    const result = await this.callAcp(
      'nessy/settings/removeHook',
      (connection) =>
        connection.extMethod('nessy/settings/removeHook', {
          cwd: this.resolvedCwd(),
          scope,
          event,
          index,
        }),
      10_000,
    );
    return result as unknown as NessyCoreSettingsSnapshot;
  }

  async setExtensionSetting(
    extensionId: string,
    settingKey: string,
    scope: NessySettingsScope,
    value: NessySettingValue,
  ): Promise<NessyCoreSettingsSnapshot> {
    await this.ensureProcess();
    const result = await this.callAcp(
      'nessy/settings/setExtensionSetting',
      (connection) =>
        connection.extMethod('nessy/settings/setExtensionSetting', {
          cwd: this.resolvedCwd(),
          extensionId,
          settingKey,
          scope,
          value,
        }),
      10_000,
    );
    return result as unknown as NessyCoreSettingsSnapshot;
  }

  async installSkill(
    request: NessySkillInstallRequest,
  ): Promise<NessySkillInstallResult> {
    await this.ensureProcess();
    this.invalidateAvailableCommandsSnapshot('skill install');
    const result = await this.callAcp(
      'nessy/skills/install',
      (connection) =>
        connection.extMethod('nessy/skills/install', {
          cwd: this.resolvedCwd(),
          skill: {
            ...request,
            scope: request.scope ?? 'global',
          },
        }),
      120_000,
    );
    const record = toRecord(result);
    const installedSkill = toRecord(record.skill);
    return {
      id: asString(record.id) ?? asString(installedSkill.id) ?? request.id,
      slug:
        asString(record.slug) ?? asString(installedSkill.slug) ?? request.slug,
      installed: asBoolean(record.installed) ?? true,
      installedPath:
        asString(record.installedPath) ??
        asString(record.installed_path) ??
        asString(installedSkill.installedPath) ??
        asString(installedSkill.installed_path),
      message: asString(record.message),
    };
  }

  async deleteSkill(
    request: NessySkillDeleteRequest,
  ): Promise<NessySkillDeleteResult> {
    await this.ensureProcess();
    this.invalidateAvailableCommandsSnapshot('skill delete');
    const result = await this.callAcp(
      'nessy/skills/delete',
      (connection) =>
        connection.extMethod('nessy/skills/delete', {
          cwd: this.resolvedCwd(),
          skill: {
            ...request,
            scope: request.scope ?? 'global',
          },
        }),
      10_000,
    );
    const record = toRecord(result);
    const deletedSkill = toRecord(record.skill);
    return {
      slug:
        asString(record.slug) ?? asString(deletedSkill.slug) ?? request.slug,
      deleted: asBoolean(record.deleted) ?? true,
      message: asString(record.message),
    };
  }

  async setSkillEnabled(
    request: NessySkillSetEnabledRequest,
  ): Promise<NessySkillSetEnabledResult> {
    await this.ensureProcess();
    this.invalidateAvailableCommandsSnapshot('skill enabled state change');
    const result = await this.callAcp(
      'nessy/skills/setEnabled',
      (connection) =>
        connection.extMethod('nessy/skills/setEnabled', {
          cwd: this.resolvedCwd(),
          skill: {
            ...request,
            scope: request.scope ?? 'global',
          },
        }),
      10_000,
    );
    const record = toRecord(result);
    const updatedSkill = toRecord(record.skill);
    return {
      slug:
        asString(record.slug) ?? asString(updatedSkill.slug) ?? request.slug,
      enabled: asBoolean(record.enabled) ?? request.enabled,
      installedPath:
        asString(record.installedPath) ??
        asString(record.installed_path) ??
        asString(updatedSkill.installedPath) ??
        asString(updatedSkill.installed_path),
      message: asString(record.message),
    };
  }

  override setModel(model: string): void {
    if (!this.isKnownAvailableModel(model)) {
      this.debug(`Ignoring Nessy model switch for unavailable model: ${model}`);
      return;
    }
    super.setModel(model);
    this.applyCurrentModelContextWindow(model);
    void this.forwardModel(model);
  }

  override async setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[],
  ): Promise<void> {
    this.sourceMcpServers = mcpServers;
    await super.setSourceServers(mcpServers, apiServers, intendedSlugs);
  }

  async runMiniCompletion(prompt: string): Promise<string | null> {
    const result = await this.queryLlm({ prompt });
    return result.text.trim() || null;
  }

  async listSessions(
    options: BackendSessionListOptions = {},
  ): Promise<BackendSessionListResult> {
    await this.ensureProcess();
    const response = await this.callAcp(
      'session/list',
      (connection) =>
        connection.listSessions({
          cwd: options.cwd || this.resolvedCwd(),
          cursor: options.cursor,
          _meta:
            options.size && options.size > 0
              ? { size: Math.floor(options.size) }
              : undefined,
        }),
      60_000,
    );

    return {
      nextCursor: response.nextCursor ?? undefined,
      sessions: response.sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title,
        createdAt:
          typeof session._meta?.createdAt === 'string'
            ? session._meta.createdAt
            : null,
        updatedAt: session.updatedAt,
        startTime:
          typeof session._meta?.['startTime'] === 'string'
            ? session._meta['startTime']
            : undefined,
        preview:
          typeof session._meta?.['preview'] === 'string'
            ? session._meta['preview']
            : undefined,
        messageCount:
          typeof session._meta?.['messageCount'] === 'number'
            ? session._meta['messageCount']
            : undefined,
        gitBranch:
          typeof session._meta?.['gitBranch'] === 'string'
            ? session._meta['gitBranch']
            : undefined,
        titleSource:
          session._meta?.['titleSource'] === 'manual' ||
          session._meta?.['titleSource'] === 'auto'
            ? session._meta['titleSource']
            : undefined,
      })),
    };
  }

  async deleteBackendSession(
    sessionId: string,
    options: { cwd?: string } = {},
  ): Promise<boolean> {
    await this.ensureProcess();
    const result = toRecord(
      await this.callAcp(
        'ext/deleteSession',
        (connection) =>
          connection.extMethod('deleteSession', {
            sessionId,
            cwd: options.cwd || this.resolvedCwd(),
          }),
        30_000,
      ),
    );
    return result.success !== false;
  }

  async rewindToUserTurn(
    targetTurnIndex: number,
  ): Promise<BackendRewindResult> {
    if (!Number.isInteger(targetTurnIndex) || targetTurnIndex < 0) {
      throw new Error('targetTurnIndex must be a non-negative integer');
    }

    await this.ensureProcess();
    await this.ensureNessySession();

    const sessionId = this.nessySessionId;
    if (!sessionId) throw new Error('Nessy ACP session was not created');

    const result = toRecord(
      await this.callAcp(
        'ext/rewindSession',
        (connection) =>
          connection.extMethod('rewindSession', {
            sessionId,
            targetTurnIndex,
            cwd: this.resolvedCwd(),
          }),
        30_000,
      ),
    );

    if (result.success !== true) {
      throw new Error('Nessy ACP rewindSession did not report success');
    }

    const resultTargetTurnIndex = Number.isInteger(result.targetTurnIndex)
      ? (result.targetTurnIndex as number)
      : undefined;
    const resultApiTruncateIndex = Number.isInteger(result.apiTruncateIndex)
      ? (result.apiTruncateIndex as number)
      : undefined;

    return {
      historyBeforeRewind: Array.isArray(result.historyBeforeRewind)
        ? result.historyBeforeRewind
        : undefined,
      targetTurnIndex: resultTargetTurnIndex,
      apiTruncateIndex: resultApiTruncateIndex,
    };
  }

  async renameBackendSession(
    sessionId: string,
    title: string,
    options: { cwd?: string } = {},
  ): Promise<boolean> {
    await this.ensureProcess();
    const result = toRecord(
      await this.callAcp(
        'ext/renameSession',
        (connection) =>
          connection.extMethod('renameSession', {
            sessionId,
            title,
            cwd: options.cwd || this.resolvedCwd(),
          }),
        30_000,
      ),
    );
    return result.success !== false;
  }

  async loadSessionMessages(
    sessionId: string,
    options: { cwd?: string } = {},
  ): Promise<BackendSessionMessagesResult> {
    const cwd = options.cwd || this.resolvedCwd();
    await this.ensureProcess();

    const buildResultFromUpdates = (
      updates: JsonRecord[],
    ): BackendSessionMessagesResult => {
      const messages = this.buildHistoryMessages(sessionId, updates, cwd);
      const availableCommandsSnapshot =
        this.extractAvailableCommandsSnapshot(updates);
      const tokenUsage = this.extractLatestTokenUsage(updates);
      const mergedMessages = this.mergeSlashCommandInvocationMessages(
        sessionId,
        messages,
        cwd,
      );
      const messagesWithTranscriptTelemetry =
        this.mergeNessyTranscriptTelemetryMessages(
          sessionId,
          mergedMessages,
          cwd,
        );
      const messagesWithTextElements = this.applyNessyTranscriptTextElements(
        messagesWithTranscriptTelemetry,
        sessionId,
        cwd,
      );
      return {
        messages: messagesWithTextElements,
        ...(availableCommandsSnapshot ?? {}),
        ...(tokenUsage ? { tokenUsage } : {}),
      };
    };

    try {
      const response = toRecord(
        await this.callAcp(
          'ext/nessy/session/loadUpdates',
          (connection) =>
            connection.extMethod('nessy/session/loadUpdates', {
              sessionId,
              cwd,
            }),
          30_000,
        ),
      );
      const updates = Array.isArray(response.updates)
        ? response.updates.filter(isRecord)
        : undefined;
      if (updates) {
        return buildResultFromUpdates(updates);
      }
    } catch (error) {
      this.debug(
        `Nessy loadSessionMessages extension unavailable; falling back to session/load for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const collector: HistoryCollector = { updates: [] };
    this.historyCollectors.set(sessionId, collector);

    try {
      await this.callAcp(
        'session/load',
        (connection) =>
          connection.loadSession({
            sessionId,
            cwd,
            mcpServers: this.buildAcpMcpServers(),
          }),
        60_000,
      );

      return buildResultFromUpdates(collector.updates);
    } finally {
      this.historyCollectors.delete(sessionId);
    }
  }

  async refreshAvailableCommands(): Promise<AvailableCommandsSnapshot | null> {
    this.debug(
      `Nessy slash command refresh requested (session=${this.nessySessionId ?? this.persistedNessySessionId ?? 'none'}, cwd=${this.resolvedCwd()})`,
    );
    const hadLiveSessionBeforeRefresh = !!this.nessySessionId;
    await this.ensureProcess();
    await this.ensureNessySession();

    if (this.latestAvailableCommandsSnapshot) {
      this.debug(
        `Nessy slash command refresh using latest snapshot: commands=${this.latestAvailableCommandsSnapshot.availableCommands.length} ` +
          `skills=${this.latestAvailableCommandsSnapshot.availableSkills?.length ?? 0} ` +
          `names=${formatDebugNames(this.latestAvailableCommandsSnapshot.availableCommands.map((command) => command.name))}`,
      );
      return this.latestAvailableCommandsSnapshot;
    }

    if (hadLiveSessionBeforeRefresh) {
      const reloadedSnapshot =
        await this.reloadCurrentSessionForAvailableCommands();
      if (reloadedSnapshot) {
        this.debug(
          `Nessy slash command refresh reused current session after reload: commands=${reloadedSnapshot.availableCommands.length} ` +
            `skills=${reloadedSnapshot.availableSkills?.length ?? 0} ` +
            `names=${formatDebugNames(reloadedSnapshot.availableCommands.map((command) => command.name))}`,
        );
        return reloadedSnapshot;
      }
    }

    this.debug(
      'Nessy slash command refresh waiting for available_commands_update',
    );
    const snapshot = await this.waitForAvailableCommandsSnapshot();
    this.debug(
      snapshot
        ? `Nessy slash command refresh received after wait: commands=${snapshot.availableCommands.length} skills=${snapshot.availableSkills?.length ?? 0} names=${formatDebugNames(snapshot.availableCommands.map((command) => command.name))}`
        : 'Nessy slash command refresh timed out waiting for available_commands_update',
    );
    return snapshot;
  }

  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    await this.ensureProcess();
    const sessionId = await this.createEphemeralSession();
    const collector: MiniCollector = { chunks: [] };
    this.miniCollectors.set(sessionId, collector);

    try {
      const model = request.model;
      if (model) {
        await this.callAcp(
          'session/set_config_option',
          (connection) =>
            connection.setSessionConfigOption({
              sessionId,
              configId: 'model',
              value: model,
            }),
          10_000,
        ).catch((error) => {
          this.debug(
            `Nessy mini model switch failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }

      const prompt = this.buildQueryPrompt(request);
      await this.callAcp(
        'session/prompt',
        (connection) =>
          connection.prompt({
            sessionId,
            prompt: [{ type: 'text', text: prompt }],
          }),
        LLM_QUERY_TIMEOUT_MS,
      );

      return {
        text: collector.chunks.join('').trim(),
        model: request.model || this._model || undefined,
        inputTokens: collector.inputTokens,
        outputTokens: collector.outputTokens,
      };
    } finally {
      this.miniCollectors.delete(sessionId);
      await this.deleteBackendSession(sessionId).catch((error) => {
        this.debug(
          `Nessy mini session cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      this.unregisterAcpSession(sessionId);
    }
  }

  override destroy(): void {
    super.destroy();
    this.killSubprocess();
    this.pendingPermissions.clear();
    this.miniCollectors.clear();
    this.historyCollectors.clear();
    this.ensureProcessPromise = null;
  }

  // ============================================================
  // ACP process and SDK connection
  // ============================================================

  private async ensureProcess(): Promise<void> {
    if (
      this.acpLease?.isActive() &&
      this.connection &&
      !this.connection.signal.aborted
    )
      return;

    if (this.ensureProcessPromise) {
      await this.ensureProcessPromise;
      return;
    }

    this.ensureProcessPromise = this.startProcess();
    try {
      await this.ensureProcessPromise;
    } finally {
      this.ensureProcessPromise = null;
    }
  }

  private async startProcess(): Promise<void> {
    this.connection = null;
    this.acpLease?.release();
    this.acpLease = null;

    const runtime = getBackendRuntime(this.config);
    const nessyCliPath = runtime.paths?.nessyCli;
    if (!nessyCliPath) {
      throw new Error(
        'Nessy CLI not found. Build the current nessy-cli checkout with npm run build && npm run bundle, or set NESSY_CLI to a dist/cli.js path.',
      );
    }

    const nodePath = runtime.paths?.node || process.execPath;
    const { command, args } = this.buildSpawnCommand(nessyCliPath, nodePath);
    const cwd = this.config.workspace.rootPath || this.resolvedCwd();
    const commandDescription = `${command} ${args.join(' ')}`;
    const key = buildSharedAcpProcessKey({
      command,
      spawnArgs: args,
      workspaceRootPath: cwd,
      envOverrides: this.config.envOverrides,
    });

    try {
      this.acpLease = await acquireSharedNessyAcpProcess(
        {
          key,
          command,
          args,
          cwd,
          envOverrides: this.config.envOverrides,
        },
        {
          onSessionUpdate: (params) => this.handleSessionUpdate(params),
          onPermissionRequest: (params) => this.handlePermissionRequest(params),
          // [nessy-fork] acp-elicitation-ask-user-question
          onElicitation: (params) => this.handleElicitation(params),
          onExtMethod: (method, params) => this.handleExtMethod(method, params),
          onProcessExit: (code, signal) => this.handleProcessExit(code, signal),
          onDebug: (message) => this.debug(message),
        },
      );
      this.connection = this.acpLease.connection;
    } catch (error) {
      const originalMessage = formatNessyAcpErrorMessage(error);
      const recentStderr = this.getRecentStderr().trim();
      const message = [
        originalMessage,
        `Nessy command: ${commandDescription}`,
        recentStderr ? `Recent Nessy stderr:\n${recentStderr}` : undefined,
      ]
        .filter(Boolean)
        .join('\n');
      const wrapped = new Error(message);
      (wrapped as Error & { cause?: unknown }).cause = error;
      throw wrapped;
    }
  }

  private buildSpawnCommand(
    nessyCliPath: string,
    nodePath: string,
  ): { command: string; args: string[] } {
    const args = [
      '--acp',
      '--channel=desktop',
      // [nessy-fork] dlh-launch-metadata — передаём версию Desktop в DLH
      `--ext-version=${process.env.CRAFT_AGENT_VERSION || 'unknown'}`,
    ];

    if (nessyCliPath.endsWith('.js')) {
      return { command: nodePath, args: [nessyCliPath, ...args] };
    }

    return { command: nessyCliPath, args };
  }

  private async handleExtMethod(
    method: string,
    params: JsonRecord,
  ): Promise<JsonRecord> {
    if (method !== MID_TURN_QUEUE_DRAIN_METHOD) {
      return {};
    }

    const sessionId = asString(params.sessionId);
    const managedSessionId = this.config.session?.id;
    const isCurrentSession =
      !!sessionId &&
      (sessionId === this.nessySessionId || sessionId === managedSessionId);
    if (!isCurrentSession) {
      if (sessionId) {
        this.debug(
          `Ignored mid-turn queue drain for non-current session ${sessionId}`,
        );
      }
      return {};
    }

    const entries = this.midTurnMessageQueue.splice(0);

    const hasAttachments = entries.some(
      (entry) => entry.attachments && entry.attachments.length > 0,
    );
    if (!hasAttachments) {
      if (entries.length > 0) {
        this.debug(
          `Drained ${entries.length} mid-turn user message(s) to Nessy ACP`,
        );
        this.config.onMidTurnMessagesDrained?.(
          entries.map(
            (entry) =>
              entry.messageId ?? entry.optimisticMessageId ?? entry.message,
          ),
        );
      }
      return { messages: entries.map((entry) => entry.message) };
    }

    const items: Array<{ content: ContentBlock[]; displayText: string }> = [];
    const messageIds: string[] = [];
    const failedEntries: QueuedMidTurnMessage[] = [];
    for (const entry of entries) {
      const displayText = entry.message || '[User message with attachments]';
      try {
        items.push({
          content: this.buildPromptBlocks(entry.message, entry.attachments, {
            includeContext: false,
          }),
          displayText,
        });
        messageIds.push(
          entry.messageId ?? entry.optimisticMessageId ?? entry.message,
        );
      } catch (error) {
        const buildFailureCount = (entry.buildFailureCount ?? 0) + 1;
        this.debug(
          `Failed to build mid-turn content blocks (${buildFailureCount}/${MAX_MID_TURN_CONTENT_BUILD_FAILURES}): ${getErrorMessage(error)}`,
        );
        if (buildFailureCount >= MAX_MID_TURN_CONTENT_BUILD_FAILURES) {
          items.push({
            content: [
              { type: 'text', text: displayText },
              { type: 'text', text: MID_TURN_ATTACHMENT_PROCESSING_FAILURE_TEXT },
            ],
            displayText,
          });
          messageIds.push(
            entry.messageId ?? entry.optimisticMessageId ?? entry.message,
          );
        } else {
          failedEntries.push({ ...entry, buildFailureCount });
        }
      }
    }

    if (failedEntries.length > 0) {
      this.midTurnMessageQueue.unshift(...failedEntries);
    }
    if (messageIds.length > 0) {
      this.debug(
        `Drained ${messageIds.length} mid-turn user message(s) to Nessy ACP`,
      );
      this.config.onMidTurnMessagesDrained?.(messageIds);
    }

    return {
      items,
    };
  }

  private getAcpConnection(): ClientSideConnection {
    if (
      !this.connection ||
      this.connection.signal.aborted ||
      !this.acpLease?.isActive()
    ) {
      throw new Error('Nessy ACP process is not running');
    }
    return this.connection;
  }

  // [nessy-fork] desktop-first-run-setup
  private async callAcp<T>(
    method: string,
    execute: (connection: ClientSideConnection) => Promise<T>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    try {
      return await this.withTimeout(
        execute(this.getAcpConnection()),
        method,
        timeoutMs,
      );
    } catch (error) {
      if (
        !method.startsWith('session/') ||
        !offersNessyAuthMethod(error, NESSY_DESKTOP_AUTH_METHOD_ID)
      ) {
        throw error;
      }

      this.debug(
        `Nessy ACP ${method} requires authentication; starting ${NESSY_DESKTOP_AUTH_METHOD_ID}`,
      );
      const lease = this.acpLease;
      if (!lease) throw error;
      await lease.authenticate(NESSY_DESKTOP_AUTH_METHOD_ID);
      return this.withTimeout(
        execute(this.getAcpConnection()),
        method,
        timeoutMs,
      );
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    method: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (timeoutMs <= 0) return promise;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Nessy ACP request timed out: ${method}`));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  private handleProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const message = `Nessy ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
    this.debug(message);
    this.acpLease = null;
    this.connection = null;

    this.cancelPendingPermissions();

    if (this._isProcessing && !this.abortReason) {
      this.eventQueue.enqueue({ type: 'error', message });
      this.eventQueue.enqueue({ type: 'complete' });
      this.eventQueue.complete();
    }
  }

  private killSubprocess(): void {
    for (const sessionId of [
      this.nessySessionId,
      ...this.miniCollectors.keys(),
      ...this.historyCollectors.keys(),
    ]) {
      if (sessionId) this.unregisterAcpSession(sessionId);
    }
    this.connection = null;
    this.acpLease?.release();
    this.acpLease = null;
  }

  private registerAcpSession(sessionId: string): void {
    this.acpLease?.registerSession(sessionId);
  }

  private unregisterAcpSession(sessionId: string): void {
    this.acpLease?.unregisterSession(sessionId);
  }

  // ============================================================
  // Session management
  // ============================================================

  private async ensureNessySession(): Promise<void> {
    if (this.nessySessionId) {
      this.debug(
        `Nessy ACP session reuse: using live session ${this.nessySessionId}`,
      );
      this.registerAcpSession(this.nessySessionId);
      await this.applySessionSettings(this.nessySessionId);
      this.flushPendingAvailableCommandsUpdate(this.nessySessionId);
      return;
    }

    if (this.ensureNessySessionPromise) {
      this.debug('Nessy ACP session reuse: waiting for in-flight session setup');
      await this.ensureNessySessionPromise;
      return;
    }

    this.ensureNessySessionPromise = this.createOrLoadNessySession();
    try {
      await this.ensureNessySessionPromise;
    } finally {
      this.ensureNessySessionPromise = null;
    }
  }

  private async createOrLoadNessySession(): Promise<void> {
    if (this.nessySessionId) {
      this.debug(
        `Nessy ACP session reuse: using live session ${this.nessySessionId}`,
      );
      this.registerAcpSession(this.nessySessionId);
      await this.applySessionSettings(this.nessySessionId);
      this.flushPendingAvailableCommandsUpdate(this.nessySessionId);
      return;
    }

    const cwd = this.resolvedCwd();
    const mcpServers = this.buildAcpMcpServers();
    const existingSessionId =
      this.persistedNessySessionId ?? this.config.session?.sdkSessionId;

    if (existingSessionId) {
      this.debug(
        `Nessy ACP session reuse: loading persisted session ${existingSessionId}`,
      );
      this.suppressedSessionUpdates.add(existingSessionId);
      try {
        const result = toRecord(
          await this.callAcp(
            'session/load',
            (connection) =>
              connection.loadSession({
                sessionId: existingSessionId,
                cwd,
                mcpServers,
              }),
            60_000,
          ),
        );
        this.nessySessionId = existingSessionId;
        this.persistedNessySessionId = existingSessionId;
        this.registerAcpSession(existingSessionId);
        this.recordSessionModels(result);
        this.recordSessionModes(result);
        this.config.onSdkSessionIdUpdate?.(existingSessionId);
        await this.applySessionSettings(existingSessionId);
        this.flushPendingAvailableCommandsUpdate(existingSessionId);
        return;
      } finally {
        this.suppressedSessionUpdates.delete(existingSessionId);
      }
    }

    this.debug(
      'Nessy ACP session reuse: no existing session id, creating a new ACP session',
    );
    const result = toRecord(
      await this.callAcp(
        'session/new',
        (connection) =>
          connection.newSession({
            cwd,
            mcpServers,
          }),
        60_000,
      ),
    );

    const sessionId = asString(result.sessionId);
    if (!sessionId) {
      throw new Error('Nessy ACP did not return a sessionId');
    }

    this.nessySessionId = sessionId;
    this.persistedNessySessionId = sessionId;
    this.registerAcpSession(sessionId);
    this.recordSessionModels(result);
    this.recordSessionModes(result);
    this.config.onSdkSessionIdUpdate?.(sessionId);
    await this.applySessionSettings(sessionId);
    this.flushPendingAvailableCommandsUpdate(sessionId);
  }

  private async reloadCurrentSessionForAvailableCommands(): Promise<AvailableCommandsSnapshot | null> {
    const sessionId = this.nessySessionId;
    if (!sessionId) return null;

    if (this._isProcessing) {
      this.debug(
        `Nessy slash command refresh did not reload session ${sessionId} because a prompt is active`,
      );
      return null;
    }

    this.debug(
      `Nessy slash command refresh reloading existing ACP session ${sessionId} to request available_commands_update`,
    );
    this.suppressedSessionUpdates.add(sessionId);
    try {
      const result = toRecord(
        await this.callAcp(
          'session/load',
          (connection) =>
            connection.loadSession({
              sessionId,
              cwd: this.resolvedCwd(),
              mcpServers: this.buildAcpMcpServers(),
            }),
          60_000,
        ),
      );
      this.recordSessionModels(result);
      this.recordSessionModes(result);
      await this.applySessionSettings(sessionId);
    } finally {
      this.suppressedSessionUpdates.delete(sessionId);
      this.flushPendingAvailableCommandsUpdate(sessionId);
    }
    return this.latestAvailableCommandsSnapshot;
  }

  private async createEphemeralSession(): Promise<string> {
    const result = toRecord(
      await this.callAcp(
        'session/new',
        (connection) =>
          connection.newSession({
            cwd: this.resolvedCwd(),
            mcpServers: [],
          }),
        60_000,
      ),
    );
    const sessionId = asString(result.sessionId);
    if (!sessionId) {
      throw new Error(
        'Nessy ACP did not return a sessionId for mini completion',
      );
    }
    this.registerAcpSession(sessionId);
    this.recordSessionModels(result);
    return sessionId;
  }

  private recordSessionModels(result: JsonRecord): void {
    const modelState = toRecord(result.models);
    const availableModels = Array.isArray(modelState.availableModels)
      ? modelState.availableModels
          .map(toNessyModelDefinition)
          .filter((model): model is ModelDefinition => !!model)
      : [];
    const currentModelId = asString(modelState.currentModelId);
    this.availableModelIds = new Set(availableModels.map((model) => model.id));
    this.availableModelsById = new Map(
      availableModels.map((model) => [model.id, model]),
    );
    this.firstAvailableModelId = availableModels[0]?.id;
    const selectableCurrentModelId =
      currentModelId && this.availableModelIds.has(currentModelId)
        ? currentModelId
        : undefined;

    if (
      (!this._model || !this.isKnownAvailableModel(this._model)) &&
      (selectableCurrentModelId || this.firstAvailableModelId)
    ) {
      super.setModel(
        selectableCurrentModelId || this.firstAvailableModelId || '',
      );
    }

    this.applyCurrentModelContextWindow();

    if (availableModels.length > 0) {
      this.config.onAvailableModelsUpdate?.(availableModels, currentModelId);
    }
  }

  private isKnownAvailableModel(model: string): boolean {
    return (
      !this.availableModelIds ||
      this.availableModelIds.size === 0 ||
      this.availableModelIds.has(model)
    );
  }

  private getCurrentModelContextWindow(
    model = this._model,
  ): number | undefined {
    return model
      ? this.availableModelsById.get(model)?.contextWindow
      : undefined;
  }

  private applyCurrentModelContextWindow(model = this._model): void {
    const contextWindow = this.getCurrentModelContextWindow(model);
    if (contextWindow) {
      this.usageTracker.setContextWindow(contextWindow);
    }
  }

  private recordSessionModes(result: JsonRecord): void {
    if (this.pendingModeOverride) return;

    const modeState = toRecord(result.modes);
    const currentModeId = asString(modeState.currentModeId);
    const mode = mapNessyModeToPermissionMode(currentModeId);

    if (!mode || mode === this.getPermissionMode()) return;

    this.applyAcpPermissionMode(mode);
  }

  private async forwardModel(
    model: string,
    sessionId = this.nessySessionId,
    options: { persistDefault?: boolean } = {},
  ): Promise<void> {
    if (!model || !sessionId) return;
    if (!this.isKnownAvailableModel(model)) {
      this.debug(`Skipping Nessy model forward for unavailable model: ${model}`);
      return;
    }

    try {
      if (options.persistDefault ?? true) {
        await this.callAcp(
          'session/set_model',
          (connection) =>
            connection.unstable_setSessionModel({
              sessionId,
              modelId: model,
            }),
          10_000,
        );
      } else {
        await this.callAcp(
          'session/set_config_option',
          (connection) =>
            connection.setSessionConfigOption({
              sessionId,
              configId: 'model',
              value: model,
            }),
          10_000,
        );
      }
    } catch (error) {
      this.debug(
        `Nessy session/set_model failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.callAcp(
        'session/set_config_option',
        (connection) =>
          connection.setSessionConfigOption({
            sessionId,
            configId: 'model',
            value: model,
          }),
        10_000,
      ).catch((fallbackError) => {
        this.debug(
          `Nessy model config fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
      });
    }
  }

  private async applySessionSettings(sessionId: string): Promise<void> {
    if (this.hasInitialModeOverride) {
      await this.forwardPermissionMode(this.getPermissionMode(), sessionId);
    }

    if (this._model) {
      await this.forwardModel(this._model, sessionId);
    }
  }

  private async forwardPermissionMode(
    mode: PermissionMode,
    sessionId = this.nessySessionId,
  ): Promise<void> {
    if (!sessionId || !this.connection || this.connection.signal.aborted)
      return;
    try {
      await this.callAcp(
        'session/set_mode',
        (connection) =>
          connection.setSessionMode({
            sessionId,
            modeId: mapPermissionModeToNessy(mode),
          }),
        10_000,
      );
      if (this.pendingModeOverride === mode) {
        this.pendingModeOverride = null;
      }
    } catch (error) {
      this.debug(
        `Nessy mode switch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (this.pendingModeOverride === mode) {
        this.pendingModeOverride = null;
      }
    }
  }

  private resolvedCwd(): string {
    return (
      this.config.session?.workingDirectory ||
      this.workingDirectory ||
      this.config.workspace.rootPath ||
      process.cwd()
    );
  }

  private extractNessyRecordText(record: JsonRecord): string {
    const message = toRecord(record.message);
    const parts = Array.isArray(message.parts)
      ? message.parts.filter(isRecord)
      : [];
    return parts
      .map((part) => asString(part.text))
      .filter((text): text is string => !!text)
      .join('\n\n');
  }

  private getNessyTranscriptPatchContent(record: JsonRecord): string {
    if (record.type === 'system' && record.subtype === 'slash_command') {
      const payload = toRecord(record.systemPayload);
      if (payload.phase === 'invocation') {
        return asString(payload.rawCommand) || '';
      }
    }
    return this.extractNessyRecordText(record);
  }

  private isPatchableNessyUserRecord(
    record: JsonRecord,
    sessionId: string,
  ): boolean {
    if (record.sessionId !== sessionId) return false;
    if (record.type === 'user') return true;
    if (record.type !== 'system' || record.subtype !== 'slash_command')
      return false;
    return toRecord(record.systemPayload).phase === 'invocation';
  }

  private persistNessyTranscriptTextElements(
    sessionId: string,
    cwd: string,
    sourceElements?: MessageTextElement[],
  ): void {
    const transcriptPath = getNessyTranscriptPath(sessionId, cwd);
    if (!existsSync(transcriptPath)) return;

    let fileContent: string;
    try {
      fileContent = readFileSync(transcriptPath, 'utf8');
    } catch (error) {
      this.debug(
        `Failed to read Nessy transcript for text elements: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const hadTrailingNewline = fileContent.endsWith('\n');
    const lines = fileContent.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line?.trim()) continue;

      let record: JsonRecord;
      try {
        record = JSON.parse(line) as JsonRecord;
      } catch {
        continue;
      }

      if (!this.isPatchableNessyUserRecord(record, sessionId)) continue;

      const content = this.getNessyTranscriptPatchContent(record);
      const textElements = buildNessyTranscriptTextElements(
        content,
        sourceElements,
      );
      if (!textElements) return;

      const existing = JSON.stringify(record.textElements ?? null);
      const next = JSON.stringify(textElements);
      if (existing === next) return;

      record.textElements = textElements;
      lines[index] = JSON.stringify(record);

      const tmpPath = `${transcriptPath}.craft-text-elements-${process.pid}-${Date.now()}.tmp`;
      try {
        writeFileSync(
          tmpPath,
          lines.join('\n') + (hadTrailingNewline ? '\n' : ''),
          'utf8',
        );
        renameSync(tmpPath, transcriptPath);
        this.debug(
          `Wrote ${textElements.length} text element(s) into Nessy transcript ${transcriptPath}`,
        );
      } catch (error) {
        this.debug(
          `Failed to write Nessy transcript text elements: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
  }

  private readNessyTranscriptTextElements(
    sessionId: string,
    cwd: string,
  ): Array<{ content: string; textElements: MessageTextElement[] }> {
    const transcriptPath = getNessyTranscriptPath(sessionId, cwd);
    if (!existsSync(transcriptPath)) return [];

    let fileContent: string;
    try {
      fileContent = readFileSync(transcriptPath, 'utf8');
    } catch {
      return [];
    }

    const records: Array<{
      content: string;
      textElements: MessageTextElement[];
    }> = [];
    for (const line of fileContent.split(/\r?\n/)) {
      if (!line.trim()) continue;

      let record: JsonRecord;
      try {
        record = JSON.parse(line) as JsonRecord;
      } catch {
        continue;
      }

      if (!this.isPatchableNessyUserRecord(record, sessionId)) continue;
      const textElements = toNessyTranscriptTextElements(record.textElements);
      if (!textElements) continue;

      const content = this.getNessyTranscriptPatchContent(record);
      if (!content) continue;
      records.push({ content, textElements });
    }

    return records;
  }

  private applyNessyTranscriptTextElements(
    messages: Message[],
    sessionId: string,
    cwd: string,
  ): Message[] {
    const records = this.readNessyTranscriptTextElements(sessionId, cwd);
    if (records.length === 0) return messages;

    const remaining = [...records];
    for (const message of messages) {
      if (message.role !== 'user' || message.textElements?.length) continue;

      const index = remaining.findIndex(
        (record) => record.content === message.content,
      );
      if (index < 0) continue;

      message.textElements = remaining[index]!.textElements;
      remaining.splice(index, 1);
    }

    return messages;
  }

  private buildAcpMcpServers(): McpServer[] {
    const hostedServers: McpServer[] = [];
    if (this.config.poolServerUrl) {
      hostedServers.push({
        type: 'http',
        name: 'craft_sources',
        url: this.config.poolServerUrl,
        headers: [],
      });
    }
    if (this.config.sessionServerUrl) {
      hostedServers.push({
        type: 'http',
        name: 'session',
        url: this.config.sessionServerUrl,
        headers: [],
      });
    }
    if (hostedServers.length > 0) return hostedServers;

    return Object.entries(this.sourceMcpServers).map(([name, config]) => {
      if (config.type === 'stdio') {
        const env = new Map<string, string>();
        for (const [key, value] of Object.entries(config.env ?? {})) {
          env.set(key, value);
        }
        for (const key of config.envVars ?? []) {
          const value = process.env[key];
          if (value !== undefined) env.set(key, value);
        }
        return {
          name,
          command: config.command,
          args: config.args ?? [],
          env: [...env.entries()].map(([envName, value]) => ({
            name: envName,
            value,
          })),
        };
      }

      const headers = new Map<string, string>();
      for (const [key, value] of Object.entries(config.headers ?? {})) {
        headers.set(key, value);
      }
      if (config.bearerTokenEnvVar && process.env[config.bearerTokenEnvVar]) {
        headers.set(
          'Authorization',
          `Bearer ${process.env[config.bearerTokenEnvVar]}`,
        );
      }

      return {
        type: config.type,
        name,
        url: config.url,
        headers: [...headers.entries()].map(([headerName, value]) => ({
          name: headerName,
          value,
        })),
      };
    });
  }

  // ============================================================
  // Prompt construction
  // ============================================================

  private buildPromptBlocks(
    message: string,
    attachments?: FileAttachment[],
    options?: { includeContext?: boolean },
  ): ContentBlock[] {
    const includeContext = options?.includeContext ?? true;
    if (includeContext && isSlashCommandPrompt(message, attachments)) {
      return [{ type: 'text', text: message.trim() }];
    }

    const textParts: string[] = [];
    const context = includeContext && INCLUDE_CRAFT_CONTEXT_IN_NESSY_PROMPTS
      ? this.buildCraftContext()
      : '';

    for (const attachment of attachments ?? []) {
      if (attachment.mimeType?.startsWith('image/') && attachment.base64) {
        continue;
      }
      const filePath =
        attachment.storedPath || attachment.markdownPath || attachment.path;
      if (filePath) {
        textParts.push(
          `[Attached file: ${attachment.name}]\n[Stored at: ${filePath}]`,
        );
      } else if (attachment.text) {
        textParts.push(
          `[Attached text: ${attachment.name}]\n${attachment.text}`,
        );
      } else {
        this.debug(
          `Skipping attachment ${attachment.name} while building prompt blocks: no readable content`,
        );
      }
    }

    textParts.push(message);
    const text = textParts.filter(Boolean).join('\n\n');
    const blocks: ContentBlock[] = [];
    if (text || context) {
      blocks.push({
        type: 'text',
        text: context ? `${text}\n\n` : text,
      });
    }

    if (context) {
      blocks.push({
        type: 'resource',
        resource: {
          uri: `craft://agent-context/${encodeURIComponent(this._sessionId)}`,
          mimeType: 'text/plain',
          text: `<craft_agent_context>\n${context}\n</craft_agent_context>`,
        },
        _meta: {
          source: 'craft-agent',
          hiddenFromPromptDisplay: true,
        },
      });
    }

    for (const attachment of attachments ?? []) {
      if (attachment.mimeType?.startsWith('image/') && attachment.base64) {
        blocks.push({
          type: 'image',
          data: attachment.base64,
          mimeType: attachment.mimeType,
        });
      }
    }

    return blocks;
  }

  private buildCraftContext(): string {
    const systemPrompt = getSystemPrompt(
      undefined,
      this.config.debugMode,
      this.config.workspace.rootPath,
      this.config.session?.workingDirectory,
      this.config.systemPromptPreset,
      this.backendName,
      getCoAuthorPreference(),
    );

    const sourceContext = this.sourceManager.formatSourceState();
    const contextParts = this.promptBuilder.buildContextParts(
      {
        plansFolderPath: getSessionPlansPath(
          this.config.workspace.rootPath,
          this._sessionId,
        ),
      },
      sourceContext,
    );

    return [systemPrompt, ...contextParts].filter(Boolean).join('\n\n');
  }

  private buildQueryPrompt(request: LLMQueryRequest): string {
    const parts: string[] = [];
    if (request.systemPrompt) {
      parts.push(`System instructions:\n${request.systemPrompt}`);
    }
    if (request.outputSchema) {
      parts.push(
        `Return a JSON value that conforms to this schema:\n${jsonStringify(request.outputSchema)}`,
      );
    }
    parts.push(request.prompt);
    return parts.join('\n\n');
  }

  // ============================================================
  // Update adaptation
  // ============================================================

  private handleSessionUpdate(params: unknown): void {
    const record = toRecord(params);
    const sessionId = asString(record.sessionId);
    const update = toRecord(record.update);
    if (!sessionId || !update.sessionUpdate) return;

    const collector = this.miniCollectors.get(sessionId);
    if (collector) {
      this.collectMiniUpdate(collector, update);
      return;
    }

    const historyCollector = this.historyCollectors.get(sessionId);
    if (historyCollector) {
      historyCollector.updates.push(update);
      return;
    }

    if (update.sessionUpdate === 'available_commands_update') {
      this.handleOrStoreAvailableCommandsUpdate(sessionId, update);
      return;
    }

    if (this.suppressedSessionUpdates.has(sessionId)) return;
    if (sessionId !== this.nessySessionId || !this._isProcessing) return;

    this.captureUsage(update);

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.flushThoughtText();
        this.handleAgentMessageChunk(update);
        break;
      case 'agent_thought_chunk':
        this.flushAssistantText(true);
        this.handleAgentThoughtChunk(update);
        break;
      case 'tool_call':
        this.flushPendingTextAsIntermediate();
        this.handleToolCall(update);
        break;
      case 'tool_call_update':
        this.flushPendingTextAsIntermediate();
        this.handleToolCallUpdate(update);
        break;
      case 'plan':
        this.flushPendingTextAsIntermediate();
        this.handlePlanUpdate(update);
        break;
      case 'current_mode_update':
        this.handleModeUpdate(update);
        break;
      default:
        break;
    }
  }

  private collectMiniUpdate(
    collector: MiniCollector,
    update: JsonRecord,
  ): void {
    this.captureUsageInto(collector, update);
    if (update.sessionUpdate !== 'agent_message_chunk') return;
    const content = toRecord(update.content);
    if (content.type !== 'text') return;
    const text = asString(content.text);
    if (text) collector.chunks.push(text);
  }

  private buildHistoryMessages(
    sessionId: string,
    updates: JsonRecord[],
    _cwd: string,
  ): Message[] {
    const messages: Message[] = [];
    const toolMessages = new Map<string, Message>();
    const activeParentToolUseIds = new Set<string>();
    let idCounter = 0;
    let fallbackTimestamp = Date.now();
    let interruptionMessageAdded = false;

    const nextId = () => `nessy-${sessionId}-${++idCounter}`;
    const timestampFor = (update: JsonRecord): number => {
      const meta = toRecord(update._meta);
      const timestamp = asNumber(meta.timestamp) ?? asNumber(update.timestamp);
      if (timestamp != null) return timestamp;
      fallbackTimestamp += 1;
      return fallbackTimestamp;
    };

    const appendTextMessage = (
      role: 'user' | 'assistant',
      text: string,
      timestamp: number,
      isIntermediate?: boolean,
      intermediateKind?: IntermediateMessageKind,
      parentToolUseId?: string,
    ) => {
      if (!text) return;
      const messageText =
        role === 'assistant' ? normalizeNessyAssistantText(text) : text;
      const previous = messages[messages.length - 1];
      if (
        previous &&
        previous.role === role &&
        previous.timestamp === timestamp &&
        !previous.toolUseId &&
        previous.isIntermediate === isIntermediate &&
        previous.intermediateKind === intermediateKind &&
        previous.parentToolUseId === parentToolUseId
      ) {
        const nextContent = previous.content + text;
        previous.content =
          role === 'assistant'
            ? normalizeNessyAssistantText(nextContent)
            : nextContent;
        return;
      }

      const content = messageText;
      messages.push({
        id: nextId(),
        role,
        content,
        timestamp,
        isIntermediate,
        intermediateKind,
        parentToolUseId,
      });
    };

    const appendInterruptionMessage = (timestamp: number) => {
      if (interruptionMessageAdded) return;
      interruptionMessageAdded = true;
      messages.push({
        id: nextId(),
        role: 'info',
        content: NESSY_RESPONSE_INTERRUPTED_MESSAGE,
        timestamp,
      });
    };

    const markTrailingAssistantAsCommentary = () => {
      const previous = messages[messages.length - 1];
      if (
        previous &&
        previous.role === 'assistant' &&
        !previous.toolUseId &&
        !previous.isIntermediate
      ) {
        previous.isIntermediate = true;
        previous.intermediateKind = 'commentary';
      }
    };

    for (const update of updates) {
      const timestamp = timestampFor(update);
      const content = toRecord(update.content);
      const text = content.type === 'text' ? asString(content.text) : undefined;
      const parentToolUseId = resolveNessyParentToolUseId({
        update,
        activeParentToolUseIds,
      });

      switch (update.sessionUpdate) {
        case 'user_message_chunk':
          appendTextMessage('user', text || '', timestamp);
          break;

        case 'agent_message_chunk':
          appendTextMessage(
            'assistant',
            text || '',
            timestamp,
            undefined,
            undefined,
            parentToolUseId,
          );
          break;

        case 'agent_thought_chunk':
          appendTextMessage(
            'assistant',
            text || '',
            timestamp,
            true,
            'thought',
            parentToolUseId,
          );
          break;

        case 'tool_call': {
          markTrailingAssistantAsCommentary();
          const toolUseId =
            asString(update.toolCallId) || `nessy-history-tool-${++idCounter}`;
          const rawInput = toRecord(update.rawInput);
          const meta = toRecord(update._meta);
          const kind = asString(update.kind);
          const toolName = normalizeToolName(
            asString(meta.toolName) || asString(update.title),
            kind,
          );
          const toolParentUseId = resolveNessyParentToolUseId({
            update,
            toolUseId,
            activeParentToolUseIds,
          });
          const toolMessage: Message = {
            id: nextId(),
            role: 'tool',
            content: `Running ${toolName}...`,
            timestamp,
            toolName,
            toolUseId,
            toolInput: rawInput,
            toolStatus: 'executing',
            toolIntent: asString(update.title),
            toolDisplayName: displayNameForTool(toolName, kind),
            parentToolUseId: toolParentUseId,
          };
          messages.push(toolMessage);
          toolMessages.set(toolUseId, toolMessage);
          if (isParentTaskTool(toolName)) {
            activeParentToolUseIds.add(toolUseId);
          }
          break;
        }

        case 'tool_call_update': {
          markTrailingAssistantAsCommentary();
          const toolUseId =
            asString(update.toolCallId) || `nessy-history-tool-${++idCounter}`;
          const existing = toolMessages.get(toolUseId);
          const meta = toRecord(update._meta);
          const toolName = normalizeToolName(
            asString(meta.toolName) || existing?.toolName,
            asString(update.kind),
          );
          const toolParentUseId = resolveNessyParentToolUseId({
            update,
            toolUseId,
            activeParentToolUseIds,
          });
          const result = this.formatToolResult(update);
          const status = asString(update.status);
          const isInterrupted =
            isNessyUserInterruptText(result) ||
            isNessyUserInterruptStatus(status);
          const isError = isNessyToolFailureStatus(status) || isInterrupted;
          const toolResult = isInterrupted ? 'Interrupted' : result;

          if (existing) {
            existing.toolName = existing.toolName || toolName;
            existing.toolResult = toolResult;
            existing.toolStatus = isError ? 'error' : 'completed';
            existing.isError = isError;
            existing.parentToolUseId =
              existing.parentToolUseId || toolParentUseId;
          } else {
            const toolMessage: Message = {
              id: nextId(),
              role: 'tool',
              content: '',
              timestamp,
              toolName,
              toolUseId,
              toolResult,
              toolStatus: isError ? 'error' : 'completed',
              isError,
              parentToolUseId: toolParentUseId,
            };
            messages.push(toolMessage);
            toolMessages.set(toolUseId, toolMessage);
          }
          if (isParentTaskTool(toolName)) {
            activeParentToolUseIds.delete(toolUseId);
          }
          if (isInterrupted) {
            appendInterruptionMessage(timestamp);
          }
          break;
        }

        case 'plan': {
          markTrailingAssistantAsCommentary();
          const entries = Array.isArray(update.entries) ? update.entries : [];
          const todos = entries
            .filter(isRecord)
            .map((entry) => ({
              content: asString(entry.content) || '',
              status: mapPlanStatus(entry.status),
              activeForm: asString(entry.content) || '',
            }))
            .filter((todo) => todo.content);
          messages.push({
            id: nextId(),
            role: 'tool',
            content: 'Todo list updated',
            timestamp,
            toolName: 'TodoWrite',
            toolUseId: `nessy-history-plan-${idCounter}`,
            toolInput: { todos },
            toolResult: 'Todo list updated',
            toolStatus: 'completed',
            toolDisplayName: 'Todo List Updated',
          });
          break;
        }

        default:
          break;
      }
    }

    return messages;
  }

  private mergeNessyTranscriptTelemetryMessages(
    sessionId: string,
    messages: Message[],
    cwd: string,
  ): Message[] {
    const transcriptMessages = this.loadNessyTranscriptTelemetryMessages(
      sessionId,
      cwd,
    );
    if (transcriptMessages.length === 0) return messages;

    const messagesByToolUseId = new Map(
      messages
        .filter(
          (message): message is Message & { toolUseId: string } =>
            !!message.toolUseId,
        )
        .map((message) => [message.toolUseId, message]),
    );

    const additions = transcriptMessages.filter((candidate) => {
      const existingTool = candidate.toolUseId
        ? messagesByToolUseId.get(candidate.toolUseId)
        : undefined;
      if (existingTool) {
        existingTool.toolName = candidate.toolName || existingTool.toolName;
        existingTool.toolResult =
          candidate.toolResult ?? existingTool.toolResult;
        existingTool.toolStatus =
          candidate.toolStatus ?? existingTool.toolStatus;
        existingTool.isError = candidate.isError ?? existingTool.isError;
        existingTool.toolDisplayName =
          candidate.toolDisplayName || existingTool.toolDisplayName;
        return false;
      }
      if (
        candidate.role !== 'tool' &&
        messages.some(
          (message) =>
            message.role === candidate.role &&
            message.content === candidate.content &&
            Math.abs(message.timestamp - candidate.timestamp) <= 1_000,
        )
      ) {
        return false;
      }
      return true;
    });
    if (additions.length === 0) return messages;

    return [...messages, ...additions]
      .map((message, index) => ({ message, index }))
      .sort((a, b) => {
        const timestampDelta = a.message.timestamp - b.message.timestamp;
        return timestampDelta !== 0 ? timestampDelta : a.index - b.index;
      })
      .map(({ message }) => message);
  }

  private loadNessyTranscriptTelemetryMessages(
    sessionId: string,
    cwd: string,
  ): Message[] {
    const transcriptPath = getNessyTranscriptPath(sessionId, cwd);
    if (!existsSync(transcriptPath)) return [];

    let fileContent: string;
    try {
      fileContent = readFileSync(transcriptPath, 'utf8');
    } catch (error) {
      this.debug(
        `Failed to read Nessy transcript telemetry from ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }

    const messages: Message[] = [];
    const toolMessages = new Map<string, Message>();
    const parentToolUseIdsBySubagent = new Map<string, string>();
    const parentToolMessages = new Map<string, Message>();
    let fallbackParentToolUseId: string | undefined;
    let idCounter = 0;
    let interruptionMessageAdded = false;

    const nextId = () => `nessy-${sessionId}-transcript-${++idCounter}`;
    const appendInterruptionMessage = (timestamp: number) => {
      if (interruptionMessageAdded) return;
      interruptionMessageAdded = true;
      messages.push({
        id: nextId(),
        role: 'info',
        content: NESSY_RESPONSE_INTERRUPTED_MESSAGE,
        timestamp,
      });
    };
    const completeOpenParentTools = () => {
      for (const parent of parentToolMessages.values()) {
        if (parent.toolStatus !== 'executing') continue;
        parent.toolStatus = 'completed';
        parent.toolResult = parent.toolResult ?? 'Completed';
      }
    };
    const failOpenNonParentTools = () => {
      for (const toolMessage of toolMessages.values()) {
        if (toolMessage.toolStatus !== 'executing') continue;
        if (toolMessage.toolName && isParentTaskTool(toolMessage.toolName)) {
          continue;
        }
        toolMessage.toolStatus = 'error';
        toolMessage.toolResult = NESSY_TOOL_RESULT_MISSING_MESSAGE;
        toolMessage.isError = true;
      }
    };

    for (const line of fileContent.split(/\r?\n/)) {
      if (!line.trim()) continue;

      let record: JsonRecord;
      try {
        record = JSON.parse(line) as JsonRecord;
      } catch {
        continue;
      }

      if (record.sessionId !== sessionId) continue;
      const timestamp = parseNessyTimestamp(record.timestamp) ?? Date.now();

      if (record.type === 'user') {
        completeOpenParentTools();
        const content = this.extractNessyRecordText(record);
        if (!content) continue;
        messages.push({
          id: nextId(),
          role: 'user',
          content,
          timestamp,
        });
        continue;
      }

      if (record.type === 'assistant') {
        const message = toRecord(record.message);
        const parts = Array.isArray(message.parts)
          ? message.parts.filter(isRecord)
          : [];

        for (const part of parts) {
          const text = asString(part.text);
          if (text) {
            const isThought = part.thought === true;
            messages.push({
              id: nextId(),
              role: 'assistant',
              content: isThought ? text : normalizeNessyAssistantText(text),
              timestamp,
              ...(isThought
                ? {
                    isIntermediate: true,
                    intermediateKind: 'thought' as const,
                  }
                : {}),
            });
          }

          const functionCall = toRecord(part.functionCall);
          const functionName = asString(functionCall.name);
          if (!functionName) continue;

          const toolName = normalizeToolName(functionName);
          const toolUseId =
            asString(functionCall.id) || `nessy-transcript-tool-${++idCounter}`;
          const rawInput = toRecord(functionCall.args);
          const toolMessage: Message = {
            id: nextId(),
            role: 'tool',
            content: `Running ${toolName}...`,
            timestamp,
            toolName,
            toolUseId,
            toolInput: rawInput,
            toolStatus: 'executing',
            toolIntent: asString(rawInput.description),
            toolDisplayName: displayNameForTool(toolName),
          };
          messages.push(toolMessage);
          toolMessages.set(toolUseId, toolMessage);

          if (isParentTaskTool(toolName)) {
            fallbackParentToolUseId = toolUseId;
            parentToolMessages.set(toolUseId, toolMessage);
            const subagentType = asString(rawInput.subagent_type);
            if (subagentType) {
              parentToolUseIdsBySubagent.set(subagentType, toolUseId);
            }
          }
        }
        continue;
      }

      if (record.type === 'tool_result') {
        const result = this.extractNessyTranscriptToolResult(record);
        if (!result) continue;

        const existing = result.callId
          ? toolMessages.get(result.callId)
          : undefined;
        const toolResult = result.isInterrupted
          ? 'Interrupted'
          : result.text || (result.isError ? 'Tool failed' : 'Tool completed');

        if (existing) {
          existing.toolResult = toolResult;
          existing.toolStatus = result.isError ? 'error' : 'completed';
          existing.isError = result.isError;
        } else if (result.callId || result.toolName) {
          const toolUseId =
            result.callId || `nessy-transcript-tool-${++idCounter}`;
          const toolMessage: Message = {
            id: nextId(),
            role: 'tool',
            content: '',
            timestamp,
            toolName: result.toolName || 'tool',
            toolUseId,
            toolResult,
            toolStatus: result.isError ? 'error' : 'completed',
            toolDisplayName: displayNameForTool(result.toolName || 'tool'),
            ...(result.isError ? { isError: true } : {}),
          };
          messages.push(toolMessage);
          toolMessages.set(toolUseId, toolMessage);
        }

        if (result.isInterrupted) {
          appendInterruptionMessage(timestamp);
        }
        continue;
      }

      if (record.type === 'system' && record.subtype === 'ui_telemetry') {
        const payload = toRecord(record.systemPayload);
        const uiEvent = toRecord(payload.uiEvent);
        if (
          uiEvent['event.name'] === 'nessy-cli.api_error' &&
          (isNessyUserInterruptText(asString(uiEvent.error_message)) ||
            isNessyUserInterruptText(asString(uiEvent.error_type)))
        ) {
          appendInterruptionMessage(timestamp);
          continue;
        }
      }

      const telemetryMessage = this.buildNessyTranscriptTelemetryMessage({
        record,
        timestamp,
        nextId,
        parentToolUseIdsBySubagent,
        fallbackParentToolUseId,
      });
      if (telemetryMessage) {
        const matchingTool = messages.findLast(
          (message) =>
            message.role === 'tool' &&
            message.toolStatus === 'executing' &&
            message.toolName === telemetryMessage.toolName &&
            jsonStringify(message.toolInput ?? {}) ===
              jsonStringify(telemetryMessage.toolInput ?? {}),
        );

        if (matchingTool) {
          matchingTool.toolResult = telemetryMessage.toolResult;
          matchingTool.toolStatus = telemetryMessage.toolStatus;
          matchingTool.isError = telemetryMessage.isError;
        } else {
          messages.push(telemetryMessage);
          if (telemetryMessage.toolUseId) {
            toolMessages.set(telemetryMessage.toolUseId, telemetryMessage);
          }
        }
      }
    }

    if (!(this._isProcessing && sessionId === this.nessySessionId)) {
      completeOpenParentTools();
      failOpenNonParentTools();
    }

    return messages;
  }

  private extractNessyTranscriptToolResult(record: JsonRecord):
    | {
        callId?: string;
        toolName?: string;
        text?: string;
        isError: boolean;
        isInterrupted: boolean;
      }
    | undefined {
    const result = toRecord(record.toolCallResult);
    const message = toRecord(record.message);
    const parts = Array.isArray(message.parts)
      ? message.parts.filter(isRecord)
      : [];

    for (const part of parts) {
      const functionResponse = toRecord(part.functionResponse);
      if (Object.keys(functionResponse).length === 0) continue;

      const response = toRecord(functionResponse.response);
      const text =
        asString(result.resultDisplay) || nessyFunctionResponseText(response);
      const status = asString(result.status);
      const responseError = asString(response.error);
      const isInterrupted =
        isNessyUserInterruptText(text) ||
        isNessyUserInterruptStatus(status) ||
        isNessyUserInterruptText(responseError);
      const isError =
        isInterrupted ||
        isNessyToolFailureStatus(status) ||
        responseError !== undefined;

      const callId = asString(functionResponse.id) || asString(result.callId);
      return {
        ...(callId ? { callId } : {}),
        toolName: normalizeToolName(asString(functionResponse.name)),
        ...(text ? { text } : {}),
        isError,
        isInterrupted,
      };
    }

    return undefined;
  }

  private buildNessyTranscriptTelemetryMessage(args: {
    record: JsonRecord;
    timestamp: number;
    nextId: () => string;
    parentToolUseIdsBySubagent: ReadonlyMap<string, string>;
    fallbackParentToolUseId?: string;
  }): Message | undefined {
    const { record, timestamp, nextId, parentToolUseIdsBySubagent } = args;
    if (record.type !== 'system' || record.subtype !== 'ui_telemetry') {
      return undefined;
    }

    const payload = toRecord(record.systemPayload);
    const uiEvent = toRecord(payload.uiEvent);
    if (uiEvent['event.name'] !== 'nessy-cli.tool_call') return undefined;

    const toolName = normalizeToolName(asString(uiEvent.function_name));
    const toolUseId =
      asString(record.uuid) || `nessy-transcript-tool-${nextId()}`;
    const input = toRecord(uiEvent.function_args);
    const isError = uiEvent.success === false || uiEvent.status === 'error';
    const error = asString(uiEvent.error);
    const contentLength = asNumber(uiEvent.content_length);
    const toolResult = isError
      ? error || 'Tool failed'
      : contentLength != null
        ? `Completed (${contentLength} bytes)`
        : 'Completed';

    return {
      id: nextId(),
      role: 'tool',
      content: '',
      timestamp,
      toolName,
      toolUseId,
      toolInput: input,
      toolResult,
      toolStatus: isError ? 'error' : 'completed',
      toolDisplayName: displayNameForTool(toolName),
      parentToolUseId: this.resolveNessyTranscriptTelemetryParent(
        uiEvent,
        parentToolUseIdsBySubagent,
        args.fallbackParentToolUseId,
      ),
      ...(isError ? { isError } : {}),
    };
  }

  private resolveNessyTranscriptTelemetryParent(
    uiEvent: JsonRecord,
    parentToolUseIdsBySubagent: ReadonlyMap<string, string>,
    fallbackParentToolUseId?: string,
  ): string | undefined {
    const subagentName = asString(uiEvent.subagent_name);
    if (subagentName) {
      const parentToolUseId = parentToolUseIdsBySubagent.get(subagentName);
      if (parentToolUseId) return parentToolUseId;
    }

    const promptId = asString(uiEvent.prompt_id);
    const promptSubagentName = promptId?.match(/#([^#]+?)-[^#]+#/)?.[1];
    if (promptSubagentName) {
      const parentToolUseId =
        parentToolUseIdsBySubagent.get(promptSubagentName);
      if (parentToolUseId) return parentToolUseId;
    }

    return parentToolUseIdsBySubagent.size === 1
      ? [...parentToolUseIdsBySubagent.values()][0]
      : fallbackParentToolUseId;
  }

  private mergeSlashCommandInvocationMessages(
    sessionId: string,
    messages: Message[],
    cwd: string,
  ): Message[] {
    const slashMessages = this.loadSlashCommandInvocationMessages(
      sessionId,
      cwd,
    );
    if (slashMessages.length === 0) return messages;

    const additions = slashMessages.filter(
      (slashMessage) =>
        !messages.some((message) =>
          this.isSameSlashCommandInvocationMessage(message, slashMessage),
        ),
    );
    if (additions.length === 0) return messages;

    return [...messages, ...additions]
      .map((message, index) => ({ message, index }))
      .sort((a, b) => {
        const timestampDelta = a.message.timestamp - b.message.timestamp;
        if (timestampDelta !== 0) return timestampDelta;
        if (a.message.role === 'user' && b.message.role !== 'user') return -1;
        if (a.message.role !== 'user' && b.message.role === 'user') return 1;
        return a.index - b.index;
      })
      .map(({ message }) => message);
  }

  private isSameSlashCommandInvocationMessage(
    message: Message,
    slashMessage: Message,
  ): boolean {
    const messageContent =
      message.role === 'assistant'
        ? normalizeNessyAssistantText(message.content).trim()
        : message.content.trim();

    return (
      message.role === slashMessage.role &&
      messageContent === slashMessage.content.trim() &&
      Math.abs(message.timestamp - slashMessage.timestamp) <= 10_000
    );
  }

  private loadSlashCommandInvocationMessages(
    sessionId: string,
    cwd: string,
  ): Message[] {
    const transcriptPath = getNessyTranscriptPath(sessionId, cwd);
    if (!existsSync(transcriptPath)) return [];

    const invocations = new Map<string, SlashCommandInvocation>();
    const seenResults = new Set<string>();
    const messages: Message[] = [];
    let idCounter = 0;

    try {
      const lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let record: JsonRecord;
        try {
          record = toRecord(JSON.parse(trimmed));
        } catch {
          continue;
        }

        if (record.type !== 'system' || record.subtype !== 'slash_command')
          continue;

        const payload = toRecord(record.systemPayload);
        const rawCommand = asString(payload.rawCommand)?.trim();
        if (!rawCommand) continue;

        const phase = asString(payload.phase);
        const timestamp = parseNessyTimestamp(record.timestamp) ?? Date.now();
        if (phase === 'invocation') {
          const uuid = asString(record.uuid);
          if (uuid) invocations.set(uuid, { rawCommand, timestamp });
          continue;
        }

        if (phase !== 'result') continue;

        const outputItems = Array.isArray(payload.outputHistoryItems)
          ? payload.outputHistoryItems
          : [];
        const outputTexts = outputItems
          .filter(isRecord)
          .map(formatNessySlashOutputHistoryItem)
          .filter((text): text is string => !!text?.trim());
        if (outputTexts.length === 0) continue;

        const parentUuid = asString(record.parentUuid);
        const resultKey = parentUuid || `${rawCommand}:${timestamp}`;
        if (seenResults.has(resultKey)) continue;
        seenResults.add(resultKey);

        const invocation = parentUuid ? invocations.get(parentUuid) : undefined;
        const userContent = invocation?.rawCommand || rawCommand;
        messages.push({
          id: `nessy-${sessionId}-slash-${++idCounter}`,
          role: 'user',
          content: userContent,
          timestamp: invocation?.timestamp ?? timestamp,
        });
        messages.push({
          id: `nessy-${sessionId}-slash-${++idCounter}`,
          role: 'assistant',
          content: outputTexts.join('\n\n'),
          timestamp,
        });
      }
    } catch (error) {
      this.debug(
        `Failed to read Nessy slash command history from ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }

    return messages;
  }

  private handleAgentMessageChunk(update: JsonRecord): void {
    const content = toRecord(update.content);
    if (content.type !== 'text') return;
    const text = asString(content.text);
    if (!text) return;
    const parentToolUseId = resolveNessyParentToolUseId({
      update,
      activeParentToolUseIds: this.activeParentToolUseIds,
    });
    if (
      this.currentAssistantText &&
      this.currentAssistantParentToolUseId !== parentToolUseId
    ) {
      this.flushAssistantText(true);
    }
    this.currentAssistantParentToolUseId = parentToolUseId;
    this.currentAssistantText += text;
    this.eventQueue.enqueue({
      type: 'text_delta',
      text,
      turnId: this.currentTurnId,
      parentToolUseId,
    });
  }

  private handleAgentThoughtChunk(update: JsonRecord): void {
    const content = toRecord(update.content);
    if (content.type !== 'text') return;
    const text = asString(content.text);
    if (!text) return;
    const parentToolUseId = resolveNessyParentToolUseId({
      update,
      activeParentToolUseIds: this.activeParentToolUseIds,
    });
    if (
      this.currentThoughtText &&
      this.currentThoughtParentToolUseId !== parentToolUseId
    ) {
      this.flushThoughtText();
    }
    this.currentThoughtParentToolUseId = parentToolUseId;
    this.currentThoughtText += text;
    this.eventQueue.enqueue({
      type: 'text_delta',
      text,
      turnId: this.currentTurnId,
      parentToolUseId,
    });
  }

  private flushPendingTextAsIntermediate(): void {
    this.flushThoughtText();
    this.flushAssistantText(true);
  }

  private flushThoughtText(): void {
    if (!this.currentThoughtText) return;
    this.eventQueue.enqueue({
      type: 'text_complete',
      text: this.currentThoughtText,
      isIntermediate: true,
      intermediateKind: 'thought',
      turnId: this.currentTurnId,
      parentToolUseId: this.currentThoughtParentToolUseId,
    });
    this.currentThoughtText = '';
    this.currentThoughtParentToolUseId = undefined;
  }

  private flushAssistantText(isIntermediate?: boolean): void {
    if (!this.currentAssistantText) return;
    const text = normalizeNessyAssistantText(this.currentAssistantText, {
      forceJsonFence: this.currentIsSlashCommand,
    });
    this.eventQueue.enqueue({
      type: 'text_complete',
      text,
      ...(isIntermediate !== undefined ? { isIntermediate } : {}),
      ...(isIntermediate ? { intermediateKind: 'commentary' as const } : {}),
      turnId: this.currentTurnId,
      parentToolUseId: this.currentAssistantParentToolUseId,
    });
    this.currentAssistantText = '';
    this.currentAssistantParentToolUseId = undefined;
  }

  private handleToolCall(update: JsonRecord): void {
    const toolUseId =
      asString(update.toolCallId) || `nessy-tool-${++this.toolIdCounter}`;
    const rawInput = toRecord(update.rawInput);
    const meta = toRecord(update._meta);
    const kind = asString(update.kind);
    const toolName = normalizeToolName(
      asString(meta.toolName) || asString(update.title),
      kind,
    );
    const title = asString(update.title);
    const parentToolUseId = resolveNessyParentToolUseId({
      update,
      toolUseId,
      activeParentToolUseIds: this.activeParentToolUseIds,
    });

    this.toolNames.set(toolUseId, toolName);
    this.toolInputs.set(toolUseId, rawInput);

    this.eventQueue.enqueue({
      type: 'tool_start',
      toolName,
      toolUseId,
      input: rawInput,
      intent: title,
      displayName: displayNameForTool(toolName, kind),
      turnId: this.currentTurnId,
      parentToolUseId,
    });

    if (isParentTaskTool(toolName)) {
      this.activeParentToolUseIds.add(toolUseId);
    }
  }

  private handleToolCallUpdate(update: JsonRecord): void {
    const toolUseId =
      asString(update.toolCallId) || `nessy-tool-${++this.toolIdCounter}`;
    const meta = toRecord(update._meta);
    const toolName =
      this.toolNames.get(toolUseId) ||
      normalizeToolName(asString(meta.toolName), asString(update.kind));
    const parentToolUseId = resolveNessyParentToolUseId({
      update,
      toolUseId,
      activeParentToolUseIds: this.activeParentToolUseIds,
    });
    const result = this.formatToolResult(update);
    const isError = update.status === 'failed';

    this.eventQueue.enqueue({
      type: 'tool_result',
      toolUseId,
      toolName,
      result,
      isError,
      input: this.toolInputs.get(toolUseId),
      turnId: this.currentTurnId,
      parentToolUseId,
    });

    if (isParentTaskTool(toolName)) {
      this.activeParentToolUseIds.delete(toolUseId);
    }
  }

  private handlePlanUpdate(update: JsonRecord): void {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    const todos = entries
      .filter(isRecord)
      .map((entry) => ({
        content: asString(entry.content) || '',
        status: mapPlanStatus(entry.status),
        activeForm: asString(entry.content) || '',
      }))
      .filter((todo) => todo.content);

    const toolUseId = `nessy-plan-${++this.planUpdateCounter}`;
    const input = { todos };
    this.eventQueue.enqueue({
      type: 'tool_start',
      toolName: 'TodoWrite',
      toolUseId,
      input,
      displayName: 'Todo List Updated',
      turnId: this.currentTurnId,
    });
    this.eventQueue.enqueue({
      type: 'tool_result',
      toolUseId,
      toolName: 'TodoWrite',
      result: 'Todo list updated',
      isError: false,
      input,
      turnId: this.currentTurnId,
    });
  }

  private handleModeUpdate(update: JsonRecord): void {
    const modeId = asString(update.modeId) || asString(update.currentModeId);
    const mode = mapNessyModeToPermissionMode(modeId);
    if (!mode || mode === this.getPermissionMode()) return;
    this.applyAcpPermissionMode(mode);
  }

  private applyAcpPermissionMode(mode: PermissionMode): void {
    if (this.pendingModeOverride) {
      if (mode !== this.pendingModeOverride) return;
      this.pendingModeOverride = null;
    }

    if (mode === this.getPermissionMode()) return;
    this.permissionManager.setPermissionMode(mode);
    this.onPermissionModeChange?.(mode);
  }

  private parseAvailableCommandsUpdate(
    update: JsonRecord,
  ): AvailableCommandsSnapshot | null {
    const availableCommands = toAvailableSlashCommands(
      update.availableCommands,
    );
    const meta = toRecord(update._meta);
    const availableSkillDetails = toAvailableSkillDetails(
      meta.availableSkillDetails,
    );
    const scopedSkillDetails = toAvailableSkillDetails(
      meta.scopedSkillDetails,
      true,
    );
    const availableSkills =
      toAvailableSkills(meta.availableSkills) ??
      availableSkillDetails?.map((skill) => skill.name);

    if (
      availableCommands.length === 0 &&
      (!availableSkills || availableSkills.length === 0)
    ) {
      return null;
    }

    return {
      availableCommands,
      ...(availableSkills ? { availableSkills } : {}),
      ...(availableSkillDetails ? { availableSkillDetails } : {}),
      ...(scopedSkillDetails ? { scopedSkillDetails } : {}),
    };
  }

  private extractAvailableCommandsSnapshot(
    updates: JsonRecord[],
  ): AvailableCommandsSnapshot | null {
    let latest: AvailableCommandsSnapshot | null = null;
    for (const update of updates) {
      if (update.sessionUpdate !== 'available_commands_update') continue;
      const snapshot = this.parseAvailableCommandsUpdate(update);
      if (snapshot) latest = snapshot;
    }

    if (latest) {
      this.latestAvailableCommandsSnapshot = latest;
      this.resolveAvailableCommandsWaiters(latest);
      this.debug(
        `Nessy loadSessionMessages captured available commands: commands=${latest.availableCommands.length} ` +
          `skills=${latest.availableSkills?.length ?? 0} ` +
          `skillDetails=${latest.availableSkillDetails?.length ?? 0} ` +
          `names=${formatDebugNames(latest.availableCommands.map((command) => command.name))} ` +
          `skillNames=${formatDebugNames(latest.availableSkills)}`,
      );
    }

    return latest;
  }

  private extractLatestTokenUsage(
    updates: JsonRecord[],
  ): BackendSessionMessagesResult['tokenUsage'] {
    let latest: ExtractedUsage | null = null;
    for (const update of updates) {
      const usage = this.extractUsage(update);
      if (usage) latest = usage;
    }
    if (!latest) return undefined;

    const outputTokens = latest.outputTokens ?? 0;
    const totalTokens = Math.max(
      latest.contextTokens,
      latest.inputTokens + outputTokens,
    );
    const contextWindow = this.getCurrentModelContextWindow();

    return {
      inputTokens: latest.contextTokens,
      outputTokens,
      totalTokens,
      contextTokens: latest.contextTokens,
      costUsd: 0,
      ...(latest.cacheReadTokens !== undefined
        ? { cacheReadTokens: latest.cacheReadTokens }
        : {}),
      ...(latest.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: latest.cacheCreationTokens }
        : {}),
      ...(contextWindow ? { contextWindow } : {}),
    };
  }

  private handleAvailableCommandsUpdate(update: JsonRecord): void {
    const snapshot = this.parseAvailableCommandsUpdate(update);

    if (!snapshot) {
      this.debug(
        'Nessy available_commands_update ignored because it contained no commands or skills',
      );
      return;
    }

    this.debug(
      `Nessy available_commands_update parsed: commands=${snapshot.availableCommands.length} ` +
        `skills=${snapshot.availableSkills?.length ?? 0} ` +
        `skillDetails=${snapshot.availableSkillDetails?.length ?? 0} ` +
        `names=${formatDebugNames(snapshot.availableCommands.map((command) => command.name))} ` +
        `skillNames=${formatDebugNames(snapshot.availableSkills)}`,
    );

    this.latestAvailableCommandsSnapshot = snapshot;
    this.resolveAvailableCommandsWaiters(snapshot);

    this.eventQueue.enqueue({
      type: 'available_commands_update',
      availableCommands: snapshot.availableCommands,
      availableSkills: snapshot.availableSkills,
      ...(snapshot.availableSkillDetails
        ? { availableSkillDetails: snapshot.availableSkillDetails }
        : {}),
      ...(snapshot.scopedSkillDetails
        ? { scopedSkillDetails: snapshot.scopedSkillDetails }
        : {}),
    });
  }

  private handleOrStoreAvailableCommandsUpdate(
    sessionId: string,
    update: JsonRecord,
  ): void {
    if (
      sessionId === this.nessySessionId &&
      !this.suppressedSessionUpdates.has(sessionId)
    ) {
      this.debug(
        `Nessy available_commands_update received for active session ${sessionId}`,
      );
      this.handleAvailableCommandsUpdate(update);
      return;
    }

    this.debug(
      `Nessy available_commands_update buffered: updateSession=${sessionId} ` +
        `currentSession=${this.nessySessionId ?? 'none'} ` +
        `suppressed=${this.suppressedSessionUpdates.has(sessionId)}`,
    );
    this.pendingAvailableCommandsUpdates.set(sessionId, update);
  }

  private flushPendingAvailableCommandsUpdate(sessionId: string): void {
    const update = this.pendingAvailableCommandsUpdates.get(sessionId);
    if (!update) return;
    this.pendingAvailableCommandsUpdates.delete(sessionId);
    this.debug(
      `Nessy available_commands_update flushing buffered update for session ${sessionId}`,
    );
    this.handleAvailableCommandsUpdate(update);
  }

  private waitForAvailableCommandsSnapshot(
    timeoutMs = 2_000,
  ): Promise<AvailableCommandsSnapshot | null> {
    if (this.latestAvailableCommandsSnapshot) {
      return Promise.resolve(this.latestAvailableCommandsSnapshot);
    }

    return new Promise((resolve) => {
      let settled = false;
      const waiter = (snapshot: AvailableCommandsSnapshot | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.availableCommandsWaiters = this.availableCommandsWaiters.filter(
          (item) => item !== waiter,
        );
        resolve(snapshot);
      };
      const timeout = setTimeout(() => {
        this.debug(
          `Nessy slash command refresh wait timed out after ${timeoutMs}ms`,
        );
        waiter(null);
      }, timeoutMs);
      this.availableCommandsWaiters.push(waiter);
    });
  }

  private resolveAvailableCommandsWaiters(
    snapshot: AvailableCommandsSnapshot | null,
  ): void {
    const waiters = this.availableCommandsWaiters.splice(0);
    if (waiters.length > 0) {
      this.debug(
        `Nessy resolving ${waiters.length} slash command refresh waiter(s)`,
      );
    }
    for (const resolve of waiters) {
      resolve(snapshot);
    }
  }

  private formatToolResult(update: JsonRecord): string {
    const content = Array.isArray(update.content) ? update.content : [];
    const parts: string[] = [];

    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === 'content') {
        const inner = toRecord(item.content);
        if (inner.type === 'text' && typeof inner.text === 'string') {
          parts.push(inner.text);
        } else {
          parts.push(jsonStringify(inner));
        }
      } else if (item.type === 'diff') {
        const path = asString(item.path) || 'file';
        parts.push(`Updated ${path}`);
      } else if (item.type === 'terminal') {
        parts.push(jsonStringify(item));
      }
    }

    if (parts.length > 0) return parts.join('\n\n');
    if ('rawOutput' in update)
      return typeof update.rawOutput === 'string'
        ? update.rawOutput
        : jsonStringify(update.rawOutput);
    return update.status === 'failed' ? 'Tool failed' : 'Tool completed';
  }

  private captureUsage(update: JsonRecord): void {
    const usage = this.extractUsage(update);
    if (!usage) return;
    const contextWindow = this.getCurrentModelContextWindow();
    this.capturedUsageInCurrentTurn = true;
    this.resolveUsageWaiters();
    this.eventQueue.enqueue({
      type: 'usage_update',
      usage: {
        inputTokens: usage.contextTokens,
        ...(contextWindow ? { contextWindow } : {}),
      },
    });
  }

  private captureUsageInto(collector: MiniCollector, update: JsonRecord): void {
    const usage = this.extractUsage(update);
    if (!usage) return;
    collector.inputTokens = usage.inputTokens;
    collector.outputTokens = usage.outputTokens;
  }

  private extractUsage(update: JsonRecord): ExtractedUsage | null {
    const meta = toRecord(update._meta);
    const usage = firstRecord(
      meta.usage,
      meta.usageMetadata,
      update.usage,
      update.usageMetadata,
    );
    if (Object.keys(usage).length === 0) return null;

    const inputTokens =
      asNumber(usage.inputTokens) ??
      asNumber(usage.promptTokens) ??
      asNumber(usage.promptTokenCount);
    const outputTokens =
      asNumber(usage.outputTokens) ??
      asNumber(usage.completionTokens) ??
      asNumber(usage.candidatesTokenCount);
    const totalTokens =
      asNumber(usage.totalTokens) ?? asNumber(usage.totalTokenCount);
    const contextTokens = totalTokens ?? inputTokens;

    if (contextTokens === undefined) return null;
    const cacheReadTokens =
      asNumber(usage.cacheReadTokens) ??
      asNumber(usage.cachedReadTokens) ??
      asNumber(usage.cachedContentTokenCount);
    const cacheCreationTokens =
      asNumber(usage.cacheCreationTokens) ??
      asNumber(usage.cachedCreationTokens);

    return {
      inputTokens: inputTokens ?? contextTokens,
      contextTokens,
      outputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    };
  }

  // ============================================================
  // Permissions
  // ============================================================

  private handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const record = toRecord(params);
    const toolCall = toRecord(record.toolCall);
    const options = Array.isArray(record.options)
      ? (record.options.filter(isRecord) as AcpPermissionOption[])
      : [];

    const kind = asString(toolCall.kind);
    const rawInput = toRecord(toolCall.rawInput);
    const title = asString(toolCall.title) || 'Nessy CLI requests permission';
    const toolName = normalizeToolName(
      asString(toRecord(toolCall._meta).toolName) || title,
      kind,
    );
    const command = asString(rawInput.command) || asString(rawInput.cmd);
    const questions = parseAskUserQuestions(rawInput.questions);
    const isAskUserQuestion = toolName === 'ask_user_question' || !!questions;
    // [nessy-fork] desktop-plan-permission-flow
    const impact = this.permissionImpact(toolCall);
    const description =
      toolName === 'ExitPlanMode' && impact ? `Plan:\n${impact}` : title;
    const metadata = isRecord(rawInput.metadata)
      ? { source: asString(rawInput.metadata.source) }
      : undefined;
    // [nessy-fork] desktop-permission-request-ui
    const { diff, filePath, oldText, newText } = this.extractDiff(toolCall);

    if (!this.onPermissionRequest) {
      const autoAllow = this.getPermissionMode() === 'allow-all';
      return Promise.resolve(
        this.createPermissionResponse(options, autoAllow, autoAllow),
      );
    }

    return new Promise<RequestPermissionResponse>((resolve) => {
      const requestId = `nessy-permission-${++this.permissionRequestCounter}`;
      this.pendingPermissions.set(requestId, { resolve, options });

      try {
        this.onPermissionRequest?.({
          requestId,
          toolName,
          command,
          description,
          type: isAskUserQuestion
            ? 'ask_user_question'
            : diff || newText !== undefined
              ? 'file_write'
              : permissionTypeForKind(kind),
          reason: asString(rawInput.reason),
          impact,
          questions,
          metadata,
          diff,
          filePath,
          oldText,
          newText,
        });
      } catch (error) {
        this.debug(
          `Nessy permission callback failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.pendingPermissions.delete(requestId);
        resolve(this.createPermissionResponse(options, false, false));
      }
    });
  }

  // [nessy-fork] acp-elicitation-ask-user-question
  private handleElicitation(
    params: CreateElicitationRequest,
  ): Promise<CreateElicitationResponse> {
    // Only session-scoped form elicitation is rendered by the desktop client.
    if (params.mode !== 'form' || !('sessionId' in params)) {
      return Promise.resolve({ action: 'cancel' });
    }
    const schema = toRecord(params.requestedSchema);
    const questions = requestedSchemaToQuestions(schema);
    // A form with no renderable questions would surface as a dead
    // cancel-only screen; resolve as cancelled instead.
    if (questions.length === 0) {
      this.debug('Nessy elicitation had no renderable questions');
      return Promise.resolve({ action: 'cancel' });
    }
    const onElicitation = this.onElicitation;
    if (!onElicitation) {
      return Promise.resolve({ action: 'cancel' });
    }
    const title =
      asString(schema.title) || 'Please answer the following question(s)';
    return new Promise<CreateElicitationResponse>((resolve) => {
      const requestId = `nessy-elicitation-${++this.elicitationRequestCounter}`;
      this.pendingElicitations.set(requestId, resolve);
      try {
        onElicitation({
          requestId,
          sessionId: params.sessionId,
          questions,
          description: title,
        });
      } catch (error) {
        this.debug(
          `Nessy elicitation callback failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.pendingElicitations.delete(requestId);
        resolve({ action: 'cancel' });
      }
    });
  }

  /**
   * Resolves a pending elicitation with the user's form response. Called by
   * the server-core `SessionManager` after the renderer answers an
   * `elicitation_request`.
   */
  // [nessy-fork] acp-elicitation-ask-user-question
  respondToElicitation(
    requestId: string,
    response: CreateElicitationResponse,
  ): void {
    const resolve = this.pendingElicitations.get(requestId);
    if (!resolve) return;
    this.pendingElicitations.delete(requestId);
    resolve(response);
  }

  private extractDiff(toolCall: JsonRecord): {
    diff?: string;
    filePath?: string;
    oldText?: string;
    newText?: string;
  } {
    const content = Array.isArray(toolCall.content) ? toolCall.content : [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === 'diff') {
        const path = asString(item.path);
        const newText = asString(item.newText);
        if (newText !== undefined) {
          return {
            filePath: path,
            oldText: asString(item.oldText),
            newText,
          };
        }
        const unifiedDiff = asString(item.unified_diff) || asString(item.diff);
        if (unifiedDiff) {
          return { diff: unifiedDiff, filePath: path || undefined };
        }
      }
    }
    return {};
  }

  private permissionImpact(toolCall: JsonRecord): string | undefined {
    const content = Array.isArray(toolCall.content) ? toolCall.content : [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === 'diff') {
        return `Will modify ${asString(item.path) || 'a file'}`;
      }
      if (item.type === 'content') {
        const inner = toRecord(item.content);
        const text = asString(inner.text);
        if (text) return text;
      }
    }
    return undefined;
  }

  private selectPermissionOption(
    options: AcpPermissionOption[],
    alwaysAllow: boolean,
  ): string | undefined {
    if (alwaysAllow) {
      const always = options.find(
        (option) =>
          option.kind === 'allow_always' || option.optionId?.includes('always'),
      );
      if (always?.optionId) return always.optionId;
    }

    const restorePrevious = options.find(
      (option) => option.optionId === 'restore_previous',
    );
    if (restorePrevious?.optionId) return restorePrevious.optionId;

    const once = options.find((option) => option.optionId === 'proceed_once');
    if (once?.optionId) return once.optionId;

    const firstAllowOnce = options.find(
      (option) => option.kind === 'allow_once' && option.optionId,
    );
    if (firstAllowOnce?.optionId) return firstAllowOnce.optionId;

    const firstAllow = options.find(
      (option) => option.kind !== 'reject_once' && option.optionId,
    );
    return firstAllow?.optionId;
  }

  private createPermissionResponse(
    options: AcpPermissionOption[],
    allowed: boolean,
    alwaysAllow: boolean,
    answers?: Record<string, string>,
  ): RequestPermissionResponse & { answers?: Record<string, string> } {
    if (!allowed) {
      return { outcome: { outcome: 'cancelled' } };
    }

    const optionId = this.selectPermissionOption(options, alwaysAllow);
    if (!optionId) {
      return { outcome: { outcome: 'cancelled' } };
    }

    return {
      outcome: {
        outcome: 'selected',
        optionId,
      },
      ...(answers ? { answers } : {}),
    };
  }

  private cancelPendingPermissions(): void {
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(
        this.createPermissionResponse(pending.options, false, false),
      );
    }
    this.pendingPermissions.clear();
  }

  protected override debug(message: string): void {
    this.onDebug?.(`[NessyAgent] ${message}`);
  }
}

export { NessyAgent as NessyBackend };
