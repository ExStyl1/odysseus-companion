/**
 * MCP client using official @modelcontextprotocol/sdk
 * Supports both HTTP and stdio transports for remote and local MCP servers
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  ErrorCode,
  ListRootsRequestSchema,
  McpError,
  NotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  ToolSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ElicitRequest, ElicitResult, JSONRPCMessage, Tool } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { z } from 'zod';
import { BLOCKED_ENV_VARS as SHARED_BLOCKED_ENV_VARS } from '@nessy-agent/session-tools-core';
import type { PluginMcpRuntimeAuthority } from '../agent/backend/types.ts';
import type { ProcessSupervisorPort } from '../agent/pi-harness/process-supervisor-port.ts';
import type { SessionKey } from '../sessions/session-key.ts';
import { computeNormalizedBundleHash } from '../plugins/bundle-hash.ts';
import { getPluginNetworkEnvVars, getProxyEnvVars } from '../config/proxy-env.ts';
import { isChannelMetaKey } from './channel-tag.ts';
import { createManagedStdioTransport } from './managed-stdio-transport.ts';

/**
 * HTTP transport config for remote MCP servers
 */
export interface HttpMcpClientConfig {
  transport: 'http';
  url: string;
  headers?: Record<string, string>;
}

/**
 * SSE transport config for remote MCP servers using the legacy SSE transport.
 */
export interface SseMcpClientConfig {
  transport: 'sse';
  url: string;
  headers?: Record<string, string>;
}

/**
 * WebSocket transport config for remote MCP servers (`mcp.md:136`-`:147`).
 *
 * "WebSocket servers hold a persistent bidirectional connection, which suits
 * remote MCP servers that push events to Claude unprompted" (`:138`).
 *
 * `headers` is documented on the entry and is parsed, but the vendored SDK's
 * `WebSocketClientTransport` constructor accepts a URL only — it passes the
 * `mcp` subprotocol to the global `WebSocket` and has no header seam. The value
 * is therefore carried, not transmitted, and the pool says so out loud.
 */
export interface WsMcpClientConfig {
  transport: 'ws';
  url: string;
  headers?: Record<string, string>;
}

/**
 * Stdio transport config for local MCP servers (spawns subprocess)
 */
export interface StdioMcpClientConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  inheritProcessEnv?: boolean;
  pluginRuntime?: PluginMcpRuntimeAuthority;
}

/**
 * Unified config supporting both transport types
 */
export type McpClientConfig =
  | HttpMcpClientConfig
  | SseMcpClientConfig
  | WsMcpClientConfig
  | StdioMcpClientConfig;

/** Identity the elicitation handler needs; `server` is the documented hook matcher. */
export interface McpElicitationContext {
  /** MCP server slug. Absent only for clients built without one (tests). */
  server?: string;
}

export type McpElicitationHandler = (
  request: ElicitRequest,
  signal: AbortSignal,
  context: McpElicitationContext,
) => Promise<ElicitResult>;
export type McpCapabilityKind = 'tools' | 'resources' | 'prompts';
export interface McpChannelMessage {
  server: string;
  text: string;
  /**
   * Attributes for the emitted `<channel …>` tag (`channels-reference.md:230`).
   *
   * The WIRE key is `params.meta`; the in-process body stays named `text` even
   * though the wire key for it is `content`, because the doc constrains the wire
   * and renaming the field would touch every pool caller for no contract gain.
   *
   * Already filtered and sanitized when it comes from {@link NessyMcpClient}:
   * non-identifier keys are silently dropped at parse per `:230`, control
   * characters are stripped, and both the entry count and per-value length are
   * bounded. Attribute-context escaping is NOT applied here — that belongs to
   * the single renderer (`channel-tag.ts`), so nothing is escaped twice.
   */
  meta?: Readonly<Record<string, string>>;
}

export interface PluginMcpProcessAuthority {
  processSupervisor: ProcessSupervisorPort;
  sessionKey: SessionKey;
}

/**
 * `channels-reference.md:48`, `:221` — a channel server pushes events with the
 * JSON-RPC method `notifications/claude/channel`. The bare `claude/channel` we
 * used to register is a DIFFERENT thing on that page: it is the capability key
 * `capabilities.experimental['claude/channel']` (`:198`, `:212`), whose presence
 * is what registers the listener. Every sibling notification in this constructor
 * carries the `notifications/` prefix, which is what marked the old literal as a
 * rename miss rather than a house style.
 *
 * No legacy alias is registered: the SDK dispatches notifications through an
 * exact method map with no fallback handler here, and nothing in this repo or in
 * any shipped server ever emitted the un-prefixed form, so there is no producer
 * to stay compatible with.
 */
const ClaudeChannelNotificationSchema = NotificationSchema.extend({
  method: z.literal('notifications/claude/channel'),
});

/**
 * How long a `-32042` retry waits for `notifications/elicitation/complete`.
 *
 * The interaction it waits on happens in the user's browser, so minutes is the
 * right order. `elicitation.md:392` is why we wait at all rather than retrying on
 * the user's `accept`: "The response with `action: \"accept\"` indicates that the
 * user has consented to the interaction. It does not mean that the interaction is
 * complete." And the notification is a server MAY, so the wait must be bounded —
 * `:408` asks for manual controls "if the notification never arrives", which for
 * us means the original error surfaces and the model or the user retries the tool.
 */
const URL_ELICITATION_COMPLETION_TIMEOUT_MS = 5 * 60 * 1000;
/** A hostile server must not be able to open an unbounded number of dialogs. */
const MAX_REQUIRED_URL_ELICITATIONS = 8;
/** Bound on remembered completed ids, so the already-completed guard cannot grow. */
const MAX_COMPLETED_ELICITATIONS = 256;

/** One URL-mode elicitation named by a `-32042` error, after validation. */
interface RequiredUrlElicitation {
  elicitationId: string;
  params: Record<string, unknown>;
}

/**
 * The elicitations a `-32042` response says must complete first, or `undefined`
 * when this is not that error — or when its payload does not satisfy the spec.
 *
 * `elicitation.md:426` — "The error **MUST** include a list of elicitations that
 * are required to complete before the original can be retried." `:428` — "Any
 * elicitations returned in the error **MUST** be URL mode elicitations and have
 * an `elicitationId` property." A payload that breaks either is not retried:
 * asking the user to approve an elicitation we cannot render, or retrying with
 * nothing resolved, are both worse than surfacing the server's error.
 */
function requiredUrlElicitations(error: unknown): RequiredUrlElicitation[] | undefined {
  if (!(error instanceof McpError) || error.code !== ErrorCode.UrlElicitationRequired) return undefined;
  const data = error.data;
  if (!data || typeof data !== 'object') return undefined;
  const entries = (data as { elicitations?: unknown }).elicitations;
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  if (entries.length > MAX_REQUIRED_URL_ELICITATIONS) return undefined;
  const required: RequiredUrlElicitation[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const params = entry as Record<string, unknown>;
    const elicitationId = params.elicitationId;
    if (typeof elicitationId !== 'string' || elicitationId.length === 0) return undefined;
    if (params.mode !== 'url' || typeof params.url !== 'string') return undefined;
    // A duplicated id would make the completion wait ambiguous.
    if (seen.has(elicitationId)) return undefined;
    seen.add(elicitationId);
    required.push({ elicitationId, params });
  }
  return required;
}
const INVALID_CHANNEL_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
export const MCP_CHANNEL_MAX_TEXT_BYTES = 32 * 1024;

function boundedChannelText(text: string): string {
  const sanitized = text.replace(INVALID_CHANNEL_CONTROL, '');
  if (Buffer.byteLength(sanitized, 'utf8') <= MCP_CHANNEL_MAX_TEXT_BYTES) return sanitized;

  let bytes = 0;
  let end = 0;
  for (const character of sanitized) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > MCP_CHANNEL_MAX_TEXT_BYTES) break;
    bytes += size;
    end += character.length;
  }
  return sanitized.slice(0, end);
}

/**
 * Bounds on the attribute payload. The page names no number, so these are Nessy
 * safety choices, recorded as such: without them a hostile server routes an
 * arbitrary amount of text past {@link MCP_CHANNEL_MAX_TEXT_BYTES} through
 * attributes instead of the body.
 */
export const MCP_CHANNEL_MAX_META_ENTRIES = 32;
export const MCP_CHANNEL_MAX_META_VALUE_BYTES = 1024;

/**
 * The surviving `meta` entries for one pushed event, or `undefined` when none
 * survive.
 *
 * Drops are SILENT by contract (`:230`), so a non-identifier key, a non-string
 * value and an over-budget entry all leave without a warning and without
 * rejecting the event. `source` is dropped too: it is ours to set from the
 * connection slug, and a server that sends one must not be able to relabel
 * itself as another source in the rendered tag.
 */
function boundedChannelMeta(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const meta: Record<string, string> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MCP_CHANNEL_MAX_META_ENTRIES) break;
    if (!isChannelMetaKey(key) || key === 'source') continue;
    if (typeof raw !== 'string') continue;
    // Same control-character strip the body gets; attribute-context escaping is
    // the renderer's job, so a value is never escaped twice.
    const sanitized = raw.replace(INVALID_CHANNEL_CONTROL, '');
    if (Buffer.byteLength(sanitized, 'utf8') > MCP_CHANNEL_MAX_META_VALUE_BYTES) continue;
    meta[key] = sanitized;
    count += 1;
  }
  return count === 0 ? undefined : meta;
}

/**
 * Sensitive environment variables that are NOT passed to MCP subprocesses.
 *
 * `DA2.22` — this WAS a second copy of `session-tools-core`'s list, kept in step
 * by a comment in each file pointing at the other. It is now the same array: the
 * names live beside the script-runtime sanitizer that also strips them, which is
 * the side of the dependency edge that can be imported (`@nessy-agent/shared`
 * depends on `@nessy-agent/session-tools-core`, never the reverse). Read the
 * constant's docblock there for what belongs in it.
 *
 * `readonly string[]` because the source declares the names `as const`, and the
 * membership test below asks it about an arbitrary environment key.
 */
const BLOCKED_ENV_VARS: readonly string[] = SHARED_BLOCKED_ENV_VARS;

/**
 * F1.644 / F1.643 — one tool a server listed that the host did NOT keep, and why.
 *
 * `mcp.md#tools-with-invalid-input-schemas`: Claude Code "excludes each tool that
 * would fail them, so the server's other tools keep working", and "records the
 * reason in the server's log and tells Claude which tools it excluded and why".
 * The pool reads these back ({@link PoolClient.getSkippedTools}) for the `/mcp`
 * status line and the model notice, so the skip is never only a log line.
 */
export interface McpSkippedTool {
  /** The name as the server sent it (bounded), or `(unnamed)` when it sent none. */
  name: string;
  /** One bounded line from the check that refused the tool. */
  reason: string;
}

/** A server controls both strings, and both are echoed to the user and the model. */
const SKIPPED_TOOL_NAME_MAX = 64;
const SKIPPED_TOOL_REASON_MAX = 200;

function boundedSkipText(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * F1.644 — the error Pi would hit compiling this input schema, or `undefined`.
 *
 * Pi's `createPiToolExecutionPorts` compiles EVERY tool's parameters with the MCP
 * SDK's `AjvJsonSchemaValidator` when a session is built, and one throw there
 * fails every prompt of the session — measured by WJ-bu as `Prompt failed: anyOf
 * value must be ["array"]` for a root `anyOf` that was an object. So the host
 * makes Pi's OWN call, on the schema as Pi receives it (`$schema` stripped, as
 * `McpClientPool.getProxyToolDefs` does): a fresh `AjvJsonSchemaValidator` per
 * tool, default instance, `getValidator` — the `tool-executor.ts` line. F1.665:
 * this was a hand copy of the SDK's Ajv options without `ajv-formats`, and that
 * was not neutral — ajv-formats adds the `formatMaximum`/`formatMinimum`/
 * `formatExclusive*` KEYWORDS, so a non-string `formatMaximum` passed here and
 * still killed every Pi prompt. Reused, not copied, so an SDK lift moves both.
 * Ajv's logger is silenced (F1.699; the compile is the same). Applied on every runtime,
 * like `McpClientPool.malformedToolProperties`: codex and claude-runtime (F1.557) drop a
 * root-shape error too; for a misused format-limit keyword their verdict is untraced (F1.699),
 * so that skip may be host-only — uniform and named, never a Pi-wide prompt failure.
 */
export function toolSchemaCompileError(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const { $schema: _dialect, ...compiled } = schema as Record<string, unknown>;
  try {
    quietAjvJsonSchemaValidator().getValidator(compiled as never);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * F1.644 + F1.643 — split a `tools/list` answer into the tools the host keeps and
 * the ones it skips, in the server's order.
 *
 * F1.643 — each entry is first checked against the MCP SDK's own `ToolSchema`,
 * ONE tool at a time. The SDK's `Client.listTools` checks the whole answer at
 * once, so a single tool whose `inputSchema` root is not `type: "object"` (the MCP
 * `Tool` shape) failed the list and, with it, the connect health check — the host
 * refused the WHOLE server on every runtime (WJ-bu, F1.595's `pick`/`both`).
 * F1.644 — a tool that has the shape is then compiled (input and output schema)
 * as {@link toolSchemaCompileError} says.
 * F1.695 — and its name must not repeat one already KEPT: the pool's proxy name
 * for both would be one `mcp__<slug>__<name>`, and Pi's manifest build throws on
 * a duplicate (every prompt fails). The MCP spec says names "SHOULD be unique
 * within a server" (server/tools, 2025-11-25) and, like `mcp.md`, not what a client
 * does with a repeat: the first kept wins, in the server's order, the rest skip.
 */
export function partitionListedTools(tools: readonly unknown[]): { tools: Tool[]; skipped: McpSkippedTool[] } {
  const kept: Tool[] = [];
  const keptNames = new Set<string>();
  const skipped: McpSkippedTool[] = [];
  for (const raw of tools) {
    const rawName = raw && typeof raw === 'object' ? (raw as { name?: unknown }).name : undefined;
    const name = typeof rawName === 'string' && rawName.length > 0 ? boundedSkipText(rawName, SKIPPED_TOOL_NAME_MAX) : '(unnamed)';
    const skip = (reason: string) => skipped.push({ name, reason: boundedSkipText(reason, SKIPPED_TOOL_REASON_MAX) });
    const shaped = ToolSchema.safeParse(raw);
    if (!shaped.success) {
      const issue = shaped.error.issues[0];
      skip(`it does not have the MCP tool shape (${issue ? `${issue.path.join('.') || 'tool'}: ${issue.message}` : 'invalid'})`);
      continue;
    }
    const tool = shaped.data as Tool;
    const inputError = toolSchemaCompileError(tool.inputSchema);
    if (inputError !== undefined) {
      skip(`its input schema is not a valid JSON Schema (${inputError})`);
      continue;
    }
    const outputError = toolSchemaCompileError(tool.outputSchema);
    if (outputError !== undefined) {
      skip(`its output schema is not a valid JSON Schema (${outputError})`);
      continue;
    }
    if (keptNames.has(tool.name)) {
      skip('another tool with the same name was listed before it (the first one is kept)');
      continue;
    }
    keptNames.add(tool.name);
    kept.push(tool);
  }
  return { tools: kept, skipped };
}

/**
 * F1.643 — the `tools/list` envelope, with each tool left unparsed for
 * {@link partitionListedTools}. Loose, as the SDK's own result schemas are.
 */
const LenientListToolsResultSchema = z.looseObject({ tools: z.array(z.unknown()) });

/**
 * Interface for clients managed by McpClientPool.
 * Both NessyMcpClient (remote MCP sources) and ApiSourcePoolClient (API sources) implement this.
 */
/** Per-call transport options a pool can impose on one tool invocation. */
export interface McpToolCallOptions {
  /**
   * Abort the call after this long WITHOUT a response and WITHOUT a progress
   * notification. Distinct from the per-server wall clock
   * (`SdkMcpServerConfig.toolTimeoutMs`), which a live long-running call cannot
   * extend: progress notifications reset this one, so a tool that is
   * demonstrably alive is never killed for taking a long time. Omit to leave the
   * call bounded only by the wall clock, which is the behavior for in-process
   * API servers — they have no transport that can go silent.
   */
  idleTimeoutMs?: number;
  /**
   * The agent's stated intent: steers large-result handling; API tools also
   * receive it as `_intent` (UB3.9, upstream v0.15.1 `PoolCallToolOptions.intent`).
   * `ApiSourcePoolClient` merges it into the arguments only when the agent's own
   * `_intent` is absent, so the model's copy never loses to the transported one.
   */
  intent?: string;
}

export interface PoolClient {
  listTools(): Promise<Tool[]>;
  /**
   * F1.644 — the tools the LAST `listTools` skipped, each with its reason. Optional
   * because an in-process API source builds its schemas itself; absent reads as none.
   */
  getSkippedTools?(): readonly McpSkippedTool[];
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    options?: McpToolCallOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
  setUnexpectedCloseHandler?(handler: () => void): void;
  setCapabilitiesChangedHandler?(handler: (kind: McpCapabilityKind) => void): void;
  /** Pass `undefined` to revoke an installed handler without closing the transport. */
  setChannelHandler?(handler: ((message: McpChannelMessage) => void) | undefined): void;
  /**
   * Send `notifications/roots/list_changed` (`mcp.md:108`). OPTIONAL because
   * `ApiSourcePoolClient` runs in process, has no MCP handshake and therefore
   * no roots capability to change — it stays conformant unchanged.
   */
  notifyRootsChanged?(): Promise<void>;
  /**
   * UB7.10 — one page of the server's resource listing (upstream v0.15.1's
   * `PoolClient.listResources(cursor?, options?)` shape, cursor only; the
   * parameterless reading keeps its old callers on page one).
   */
  listResources?(cursor?: string): Promise<McpResourceListPage>;
  /**
   * UB7.10 — one page of the server's resource TEMPLATES. Optional twice over:
   * templates live inside the resources capability, and servers without any
   * often answer "method not found" — the pool degrades those to no templates.
   */
  listResourceTemplates?(cursor?: string): Promise<McpResourceTemplatesPage>;
  /**
   * UB7.11 — one page of the server's prompt listing (upstream v0.15.1's
   * `PoolClient.listPrompts(cursor?, options?)` shape, cursor only: our pool's
   * page walker passes the previous page's `nextCursor` until it repeats or the
   * page cap stops it). The parameterless reading keeps its old callers (the
   * connection surface) on page one.
   */
  listPrompts?(cursor?: string): Promise<McpPromptListPage>;
  /** Read one resource's contents by URI. Present only on clients whose server advertises resources. */
  readResource?(uri: string): Promise<McpResourceReadResult>;
  /** Render a prompt to messages, mapping args onto its declared parameters. Present only when the server advertises prompts. */
  getPrompt?(name: string, args?: Record<string, string>): Promise<McpPromptGetResult>;
  /** Capabilities the server declared at the MCP handshake. Available after connect; drives capability-conditional tool projection. */
  getServerCapabilities?(): McpDeclaredServerCapabilities | undefined;
  /**
   * The server's own `instructions`, returned in its `initialize` result.
   *
   * OPTIONAL on the interface for the same reason `notifyRootsChanged` is, but
   * for the opposite outcome: both pool clients wrap an MCP SDK `Client`, which
   * always exposes `getInstructions()`, so BOTH implement it — including
   * `ApiSourcePoolClient`, whose in-memory transport still carries a real
   * `initialize`. The optionality is for third-party/test doubles only, so a
   * source is never silently exempt from what the model is told about it.
   */
  getInstructions?(): string | undefined;
}

/** The subset of the MCP server capability handshake the pool reasons about. */
export interface McpDeclaredServerCapabilities {
  resources?: unknown;
  prompts?: unknown;
  tools?: unknown;
  /**
   * P6.341 — the channel declaration lives here, and it is the ONE thing that
   * makes a server a channel.
   *
   * `channels-reference.md#server-options`:
   * "`capabilities.experimental['claude/channel']` | `object` | Required.
   * Always `{}`. Presence registers the notification listener."
   *
   * Deliberately an open record rather than a named field: `experimental` is the
   * MCP handshake's extension bag, `claude/channel/permission` already shares it
   * (same table), and the pool reads exactly the key it needs.
   */
  experimental?: Record<string, unknown>;
}

export interface McpResourceReadResult {
  contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
}

export interface McpPromptGetResult {
  messages: Array<{ role: string; content: unknown }>;
  /** The server's own description of the prompt, from the `prompts/get` result. */
  description?: string;
}

/**
 * UB7.11 — one page of a prompt listing (upstream v0.15.1 reads the SDK's
 * `ListPromptsResult` directly; ours is the same shape under our own name, like
 * `McpPromptGetResult` beside it).
 */
export interface McpPromptListPage {
  prompts: unknown[];
  /** Present while the server still has pages; the pool's walker follows it. */
  nextCursor?: string;
}

/**
 * UB7.10 — one page of a resource listing (the SDK's `ListResourcesResult`
 * under our own name, like `McpPromptListPage` beside it).
 */
export interface McpResourceListPage {
  resources: unknown[];
  /** Present while the server still has pages; the pool's walker follows it. */
  nextCursor?: string;
}

/**
 * UB7.10 — one page of resource templates (the SDK's
 * `ListResourceTemplatesResult` under our own name).
 */
export interface McpResourceTemplatesPage {
  resourceTemplates: unknown[];
  nextCursor?: string;
}

export class NessyMcpClient {
  private client: Client;
  private transport: Transport;
  private connected = false;
  private closeRequested = false;
  private unexpectedCloseHandler?: () => void;
  private capabilitiesChangedHandler?: (kind: McpCapabilityKind) => void;
  private channelHandler?: (message: McpChannelMessage) => void;
  private readonly channelServer?: string;
  /** Present exactly when the `roots` capability was declared. See the constructor. */
  private readonly rootsProvider?: () => readonly string[] | Promise<readonly string[]>;
  private readonly elicitationHandler?: McpElicitationHandler;
  private readonly completionTimeoutMs: number;
  /**
   * URL-mode elicitation ids this client itself put in flight — from a server's
   * `elicitation/create` and from a `-32042` error's required list.
   *
   * `elicitation.md:406` makes the guard a MUST: "Clients … **MUST** ignore
   * notifications referencing unknown or already-completed IDs." A server that
   * has not asked us anything can therefore not drive this client's state by
   * inventing ids, which is the threat the MUST exists for.
   */
  private readonly knownElicitations = new Set<string>();
  /** Ids already completed once. Insertion-ordered and bounded. */
  private readonly completedElicitations = new Set<string>();
  /** Resolvers for retries currently waiting on a completion notification. */
  private readonly elicitationWaiters = new Map<string, () => void>();
  /** F1.644 — what the last `tools/list` skipped; see {@link getSkippedTools}. */
  private skippedTools: readonly McpSkippedTool[] = [];

  constructor(config: McpClientConfig, options?: {
    elicitationHandler?: McpElicitationHandler;
    pluginProcessAuthority?: PluginMcpProcessAuthority;
    channelServer?: string;
    /**
     * The filesystem roots this client answers `roots/list` with (`mcp.md:108`).
     * Injected rather than read here, because the client has no settings layer.
     * Supplying it is what declares the capability at the handshake.
     */
    rootsProvider?: () => readonly string[] | Promise<readonly string[]>;
    /** In-memory transport injection for protocol integration tests. */
    transport?: Transport;
    /** Override the `-32042` completion wait. Tests only; production uses the constant. */
    elicitationCompletionTimeoutMs?: number;
  }) {
    this.channelServer = options?.channelServer;
    this.elicitationHandler = options?.elicitationHandler;
    this.rootsProvider = options?.rootsProvider;
    this.completionTimeoutMs = options?.elicitationCompletionTimeoutMs ?? URL_ELICITATION_COMPLETION_TIMEOUT_MS;
    this.client = new Client({
      name: 'nessy-agent',
      version: '1.0.0',
    }, { jsonSchemaValidator: FRESH_AJV_PER_OUTPUT_SCHEMA, // F1.683 — see the const at the file end
      // ACCUMULATED, not an either/or ternary: appending a key to the old
      // ternary would have dropped elicitation in one branch.
      capabilities: {
        ...(options?.elicitationHandler
          // R24 decision 3 — advertise only what we honour. Both modes are now
          // implemented, and `url` is the SDK's own key: `types.js`
          // `ElicitationCapabilitySchema` is `{ form?, url? }`, so this is
          // verified against the spec rather than guessed. Advertising it is what
          // makes URL mode reachable at all — a server that checks
          // `elicitation.url` before sending `mode: "url"` would otherwise never
          // send one.
          ? { elicitation: { form: {}, url: {} } }
          : {}),
        // `mcp.md:108` — we answer `roots/list` and we "send
        // `notifications/roots/list_changed` when that set changes", so both
        // halves are advertised together. Declared only with a provider: the SDK
        // throws on `sendRootsListChanged()` without `roots.listChanged`
        // (`client/index.js:394`), and advertising a capability we cannot serve
        // would make a roots-scoping server ask and get nothing.
        ...(options?.rootsProvider ? { roots: { listChanged: true } } : {}),
      },
    });

    if (options?.rootsProvider) {
      const provider = options.rootsProvider;
      this.client.setRequestHandler(ListRootsRequestSchema, async () => ({
        // MCP `Root.uri` must be a `file://` URI, never a bare path.
        roots: (await provider()).map(path => ({ uri: pathToFileURL(path).href, name: basename(path) })),
      }));
    }

    if (options?.elicitationHandler) {
      this.client.setRequestHandler(ElicitRequestSchema, (request, extra) => {
        // A URL-mode request establishes the id the server may later report
        // complete — `elicitation.md:402`, the server "MUST include the
        // `elicitationId` established in the original `elicitation/create`
        // request". Recording it here is what makes that later notification
        // KNOWN rather than ignored.
        this.rememberElicitationId((request as ElicitRequest).params);
        // `channelServer` is the pool's slug for this connection; it is the
        // server NAME the `Elicitation` hooks match on (hooks.md §Elicitation
        // "Matches against MCP server name").
        return options.elicitationHandler!(request as ElicitRequest, extra.signal, {
          server: this.channelServer,
        });
      });
    }
    // `notifications/elicitation/complete`. The SDK has shipped the schema since
    // 1.29.0 and nothing consumed it, so an out-of-band interaction finishing was
    // invisible to this client and a `-32042` retry had nothing to wait for.
    this.client.setNotificationHandler(ElicitationCompleteNotificationSchema, notification => {
      this.onElicitationComplete(notification.params?.elicitationId);
    });
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.capabilitiesChangedHandler?.('tools');
    });
    this.client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
      this.capabilitiesChangedHandler?.('resources');
    });
    this.client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
      this.capabilitiesChangedHandler?.('prompts');
    });
    this.client.setNotificationHandler(ClaudeChannelNotificationSchema, notification => {
      // `channels-reference.md:229` — the body is `params.content`. The SDK's
      // `NotificationSchema` keeps `params` loose, so both keys pass the parse
      // and the read is what selects the contract's one.
      const params = notification.params as { content?: unknown; meta?: unknown } | undefined;
      const content = params?.content;
      if (typeof content !== 'string' || !this.channelServer) return;
      const meta = boundedChannelMeta(params?.meta);
      this.channelHandler?.({
        server: this.channelServer,
        text: boundedChannelText(content),
        ...(meta ? { meta } : {}),
      });
    });

    const pluginProcessAuthority = options?.pluginProcessAuthority;
    // Plugin runtimes must retain process supervision even when a caller injects
    // a transport for protocol integration.
    if (config.transport === 'stdio' && config.pluginRuntime && !pluginProcessAuthority) {
      throw new Error('plugin-mcp-process-supervisor-required');
    }

    // Create transport based on config type.
    if (options?.transport) {
      this.transport = options.transport;
    } else if (config.transport === 'stdio') {
      if (config.pluginRuntime) {
        this.transport = new SupervisedStdioClientTransport(
          { ...config, pluginRuntime: config.pluginRuntime },
          pluginProcessAuthority!,
        );
      } else {
        // Native/project servers retain legacy sanitized inheritance. Plugin
        // servers opt out and receive only their materialized allowlisted env.
        const processEnv: Record<string, string> = config.inheritProcessEnv === false
          ? getDefaultEnvironment()
          : {};
        if (config.inheritProcessEnv !== false) {
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined && !BLOCKED_ENV_VARS.includes(key)) {
              processEnv[key] = value;
            }
          }
        }
        // `createManagedStdioTransport` is the SDK's stdio transport with ONE
        // difference: teardown signals the child's whole process GROUP. A
        // native/project/user entry is routinely a wrapper (`npx`, `uvx`,
        // `pipx`, a shell) that forks the real server, and the SDK's own close
        // reaches the direct child only. See that module's docblock for the
        // reading that ruled out adding it to the SDK transport from outside.
        this.transport = createManagedStdioTransport({
          command: config.command,
          args: config.args,
          // The settings-derived network trust chain (proxy, CA path, mTLS
          // client identity) is projected so a native stdio server talking to
          // the same TLS-inspected endpoints behaves like the main process.
          env: { ...processEnv, ...getProxyEnvVars(), ...config.env },
          cwd: config.cwd,
        });
      }
    } else if (config.transport === 'http') {
      // HTTP transport for remote MCP servers
      this.transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        {
          requestInit: {
            headers: config.headers,
          },
        }
      );
    } else if (config.transport === 'ws') {
      // The SDK's own WebSocket client. It negotiates the `mcp` subprotocol and
      // owns the socket lifecycle; hand-rolling one here would be a second,
      // untested framing implementation of the same wire protocol.
      this.transport = new WebSocketClientTransport(new URL(config.url));
    } else {
      this.transport = new SSEClientTransport(
        new URL(config.url),
        {
          requestInit: {
            headers: config.headers,
          },
        }
      );
    }
    // The SDK owns transport.onclose after connect(), so bridge from the
    // protocol client instead of one transport implementation. Native/project
    // stdio and remote transports now evict from the pool on unexpected close
    // exactly like supervised plugin stdio.
    this.client.onclose = () => {
      this.connected = false;
      if (!this.closeRequested) this.unexpectedCloseHandler?.();
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    await this.client.connect(this.transport);

    // Verify connection works by listing tools — tolerantly (F1.643): one tool the
    // MCP shape refuses is skipped, never a reason to refuse the server.
    try {
      await this.requestTools();
    } catch (error) {
      await this.client.close();
      // `cause` is load-bearing, not decoration: a server that accepts
      // `initialize` and then rejects `tools/list` with 401/403 carries its
      // status ONLY on the transport error, and the pool's needs-sign-in
      // attribution (`authFailureStatusOf`) walks the cause chain to find it.
      // Without this the rejection reached the user as a broken server.
      throw new Error(
        `MCP connection failed health check: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    this.connected = true;
  }

  async listTools(): Promise<Tool[]> {
    if (!this.connected) {
      await this.connect();
    }

    return this.requestTools();
  }

  /**
   * F1.643 — `tools/list` through the SDK's `request` with a loose envelope, each
   * tool kept or skipped by {@link partitionListedTools}.
   *
   * What the SDK's `Client.listTools` did besides validating is kept: it hands the
   * listing to its private `cacheToolMetadata`, which compiles each `outputSchema`
   * (so `callTool` validates structured content) and records task support. That
   * method is private in the typings and public at runtime; the test file pins
   * both that it exists and that output validation still happens, so an SDK lift
   * that renames it goes red instead of silently dropping the check.
   */
  private async requestTools(): Promise<Tool[]> {
    // F1.665 — the one tolerant list path, shared with the stdio `source_test`
    // validator; `cacheToolMetadata` rides inside it (see {@link listToolsTolerantly}).
    const { tools, skipped } = await listToolsTolerantly(this.client);
    this.skippedTools = skipped;
    return tools;
  }

  /** F1.644 — the tools the last {@link listTools} skipped, each with its reason. */
  getSkippedTools(): readonly McpSkippedTool[] {
    return this.skippedTools;
  }

  /**
   * Returns server name/version reported during the MCP handshake.
   * Available after `connect()` resolves; undefined otherwise.
   */
  getServerInfo(): { name: string; version: string } | undefined {
    const info = this.client.getServerVersion();
    if (!info) return undefined;
    return { name: info.name, version: info.version };
  }

  getServerCapabilities(): McpDeclaredServerCapabilities | undefined {
    return this.client.getServerCapabilities();
  }

  /**
   * The `instructions` the server returned from `initialize`.
   *
   * `mcp.md#scale-with-mcp-tool-search`: "Only tool names and server
   * instructions load at session start" — so this is half of what the model
   * knows about a server before it searches for a tool.
   */
  getInstructions(): string | undefined {
    return this.client.getInstructions();
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    options?: McpToolCallOptions,
  ): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }

    const idleTimeoutMs = options?.idleTimeoutMs;
    return this.withUrlElicitationRetry(() => this.client.callTool({ name, arguments: args }, undefined, {
      signal,
      ...(idleTimeoutMs && idleTimeoutMs > 0
        ? {
            timeout: idleTimeoutMs,
            resetTimeoutOnProgress: true,
            // The reset only happens for a request that carries a progressToken,
            // and the SDK attaches one ONLY when a progress handler is
            // registered. Without this callback `timeout` above silently
            // degrades into a plain deadline that kills healthy long calls.
            onprogress: () => {},
          }
        : {}),
    }), signal);
  }

  async listResources(cursor?: string): Promise<McpResourceListPage> {
    if (!this.connected) await this.connect()
    const page = await this.withUrlElicitationRetry(
      async () => await this.client.listResources(cursor ? { cursor } : undefined),
    )
    return { resources: page.resources, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }

  /**
   * UB7.10 — one page of the server's resource templates. Optional on the
   * server: the SDK surfaces a "method not found" failure, which the pool's
   * listing degrades to no templates.
   */
  async listResourceTemplates(cursor?: string): Promise<McpResourceTemplatesPage> {
    if (!this.connected) await this.connect()
    const page = await this.withUrlElicitationRetry(
      async () => await this.client.listResourceTemplates(cursor ? { cursor } : undefined),
    )
    return { resourceTemplates: page.resourceTemplates, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }

  /**
   * UB7.11 — one page of the prompt listing, cursor-followable (upstream
   * v0.15.1's `listPrompts(cursor?, options?)`; the options plumbing is
   * UB7.10's resource half, which lands the shared request-options shape).
   */
  async listPrompts(cursor?: string): Promise<McpPromptListPage> {
    if (!this.connected) await this.connect()
    const page = await this.withUrlElicitationRetry(
      async () => await this.client.listPrompts(cursor ? { cursor } : undefined),
    )
    return { prompts: page.prompts, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    if (!this.connected) await this.connect()
    return await this.withUrlElicitationRetry(
      async () => (await this.client.readResource({ uri })) as McpResourceReadResult,
    )
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptGetResult> {
    if (!this.connected) await this.connect()
    return await this.withUrlElicitationRetry(
      async () => (await this.client.getPrompt({ name, ...(args ? { arguments: args } : {}) })) as McpPromptGetResult,
    )
  }

  // --- URL-mode elicitation: the client half of R24 ------------------------

  /** Record a URL-mode request's id so its completion notification is not ignored. */
  private rememberElicitationId(params: unknown): void {
    if (!params || typeof params !== 'object') return;
    const record = params as Record<string, unknown>;
    if (record.mode !== 'url') return;
    const id = record.elicitationId;
    if (typeof id !== 'string' || id.length === 0) return;
    if (this.completedElicitations.has(id)) return;
    this.knownElicitations.add(id);
  }

  /**
   * `notifications/elicitation/complete`.
   *
   * `elicitation.md:406` — "Clients: **MUST** ignore notifications referencing
   * unknown or already-completed IDs." Both halves are the FIRST thing this does,
   * because a malicious or confused server sending arbitrary ids is exactly the
   * case that MUST exists for: without the guard, an id we never issued would
   * satisfy a pending retry's wait, and a replayed id would satisfy a second one.
   */
  private onElicitationComplete(elicitationId: unknown): void {
    if (typeof elicitationId !== 'string' || elicitationId.length === 0) return;
    if (!this.knownElicitations.has(elicitationId)) return;
    if (this.completedElicitations.has(elicitationId)) return;
    this.knownElicitations.delete(elicitationId);
    this.completedElicitations.add(elicitationId);
    if (this.completedElicitations.size > MAX_COMPLETED_ELICITATIONS) {
      const oldest = this.completedElicitations.values().next();
      if (!oldest.done) this.completedElicitations.delete(oldest.value);
    }
    const waiter = this.elicitationWaiters.get(elicitationId);
    if (waiter) {
      this.elicitationWaiters.delete(elicitationId);
      waiter();
    }
  }

  /**
   * Run a request; if it comes back `-32042`, resolve what it names and retry ONCE.
   *
   * `elicitation.md:424` — "When a request cannot be processed until an
   * elicitation is completed, the server **MAY** return a
   * `URLElicitationRequiredError` (code `-32042`)". `:407` makes the retry a
   * client MAY, not a MUST, which is why every failure mode here degrades to
   * rethrowing the server's own error rather than looping: no elicitation handler
   * to ask the user with, a payload that does not satisfy `:428`, a user who
   * refused, or a completion that never arrives.
   *
   * The retry calls the operation directly, so a second `-32042` propagates —
   * once per requirement set, never a loop.
   */
  private async withUrlElicitationRetry<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const required = requiredUrlElicitations(error);
      // No handler means no way to obtain consent, and `:725` forbids opening the
      // URL without it. Surface the server's error instead.
      if (!required || !this.elicitationHandler) throw error;

      // Registered BEFORE the first dialog opens: a completion notification that
      // arrives while the user is still in the browser must not be ignored as
      // unknown, which is the race a resolve-then-register order loses.
      const waits = required.map(entry => this.trackCompletion(entry.elicitationId));
      const accepted = await this.resolveRequiredElicitations(required, signal);
      if (!accepted) {
        // A refused elicitation is a decision, not a transient failure. Never
        // retry it, and never keep waiting on it.
        for (const entry of required) this.elicitationWaiters.delete(entry.elicitationId);
        throw error;
      }
      if (!await this.awaitCompletions(waits)) {
        for (const entry of required) this.elicitationWaiters.delete(entry.elicitationId);
        throw error;
      }
      return await operation();
    }
  }

  /** A promise that settles when this id is reported complete, or the id is already complete. */
  private trackCompletion(elicitationId: string): Promise<void> {
    if (this.completedElicitations.has(elicitationId)) return Promise.resolve();
    this.knownElicitations.add(elicitationId);
    return new Promise<void>(resolve => {
      this.elicitationWaiters.set(elicitationId, resolve);
    });
  }

  /**
   * Ask the user about each required elicitation, in order.
   *
   * Reuses the SAME handler a server-initiated `elicitation/create` goes through,
   * so the URL-mode consent rules (`:724`-`:727`: no pre-fetch, no opening
   * without consent, the full URL shown) apply here without a second
   * implementation. Returns false on the first non-accept.
   */
  private async resolveRequiredElicitations(
    required: readonly RequiredUrlElicitation[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (const entry of required) {
      const request = {
        method: 'elicitation/create',
        params: entry.params,
      } as unknown as ElicitRequest;
      const result = await this.elicitationHandler!(
        request,
        signal ?? new AbortController().signal,
        { server: this.channelServer },
      );
      if (result.action !== 'accept') return false;
    }
    return true;
  }

  /** Wait for every tracked completion, bounded. False when the wait ran out. */
  private async awaitCompletions(waits: readonly Promise<void>[]): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), this.completionTimeoutMs);
    });
    try {
      const outcome = await Promise.race([Promise.all(waits).then(() => 'complete' as const), expiry]);
      return outcome === 'complete';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  setUnexpectedCloseHandler(handler: () => void): void {
    this.unexpectedCloseHandler = handler;
  }

  setCapabilitiesChangedHandler(handler: (kind: McpCapabilityKind) => void): void {
    this.capabilitiesChangedHandler = handler;
  }

  setChannelHandler(handler: ((message: McpChannelMessage) => void) | undefined): void {
    this.channelHandler = handler;
  }

  /**
   * `mcp.md:108` — "Claude Code sends `notifications/roots/list_changed` when
   * that set changes."
   *
   * A no-op without the capability or before connect, rather than a throw: the
   * SDK throws in both cases (`client/index.js:394`, and an unconnected
   * transport has nowhere to write), and one client without roots must not be
   * able to fail a fan-out across every other connection.
   */
  async notifyRootsChanged(): Promise<void> {
    if (!this.rootsProvider || !this.connected) return;
    await this.client.sendRootsListChanged();
  }

  async close(): Promise<void> {
    this.closeRequested = true;
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }
}

const MAX_STDIO_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_STDIO_STARTUP_PREAMBLE_BYTES = 64 * 1024;
const MAX_STDIO_STARTUP_PREAMBLE_LINES = 32;

class SupervisedStdioClientTransport implements Transport {
  private buffer = Buffer.alloc(0);
  private protocolStarted = false;
  private startupPreambleBytes = 0;
  private startupPreambleLines = 0;
  private handle: string | undefined;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private processClosed = false;
  private closed = false;
  private closeEmitted = false;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  constructor(
    private readonly config: StdioMcpClientConfig & { pluginRuntime: PluginMcpRuntimeAuthority },
    private readonly authority: PluginMcpProcessAuthority,
  ) {}

  async start(): Promise<void> {
    if (this.starting || this.handle) throw new Error('SupervisedStdioClientTransport already started');
    if (this.closed) throw new Error('SupervisedStdioClientTransport is closed');
    this.starting = this.startProcess();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async startProcess(): Promise<void> {
    const runtime = this.config.pluginRuntime;
    assertPluginRuntimeAuthority(runtime, this.config.command);
    const cwd = resolve(this.config.cwd ?? runtime.bundleRootPath);
    const workspaceRoot = authorizedWorkingRoot(cwd, runtime);
    const result = await this.authority.processSupervisor.start({
      sessionKey: this.authority.sessionKey,
      executionId: `plugin-mcp:${randomUUID()}`,
      semanticId: 'plugin-mcp-stdio',
      command: this.config.command,
      args: this.config.args,
      cwd,
      workspaceRoot,
      profile: 'plugin-mcp',
      background: true,
      persistent: true,
      persistOutput: false,
      timeoutMs: 0,
      maxStdinWriteBytes: MAX_STDIO_FRAME_BYTES + 1,
      stdin: 'pipe',
      environmentProfile: 'explicit',
      // Keep the SDK's deliberately small, non-secret host baseline (HOME,
      // PATH, locale/user shell fields) so real CLIs can locate their own
      // config and shebang runtimes. Do not inherit the ambient process env:
      // provider/API credentials remain outside the plugin process unless the
      // normalized manifest explicitly materialized them into config.env.
      // The settings-derived proxy and CA path ARE added (a plugin server
      // must still traverse the corporate network), but the mTLS client
      // identity is deliberately withheld: untrusted plugin code must not be
      // handed the app's TLS credential.
      env: { ...getDefaultEnvironment(), ...getPluginNetworkEnvVars(), ...this.config.env },
      additionalWritableRoots: [...new Set([
        runtime.dataPath,
        ...(runtime.hostWritableRoots ?? []),
      ])],
      beforeStart: async () => {
        const actual = await computeNormalizedBundleHash(runtime.bundleRootPath);
        if (actual !== runtime.expectedBundleHash) throw new Error('plugin-mcp-bundle-hash-mismatch');
      },
      onStdout: chunk => this.receive(chunk),
      onClose: () => {
        this.processClosed = true;
        this.handle = undefined;
        this.emitClose();
      },
    });
    if (!result.isRunning || this.processClosed) throw new Error('plugin-mcp-process-exited-during-start');
    this.handle = result.handle;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.handle || this.closed) throw new Error('Not connected');
    await this.authority.processSupervisor.write({
      sessionKey: this.authority.sessionKey,
      handle: this.handle,
      data: serializeMessage(message),
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.processClosed) {
      this.buffer = Buffer.alloc(0);
      this.emitClose();
      return;
    }
    if (this.closing) return this.closing;

    const closeAttempt = (async () => {
      await this.starting?.catch(() => undefined);
      const handle = this.handle;
      if (handle) {
        // ProcessSupervisor.stop resolves only after the child has reached a
        // terminal state. Preserve the handle and propagate a stop failure so
        // the pool retains authority and can retry instead of claiming closure.
        await this.authority.processSupervisor.stop({
          sessionKey: this.authority.sessionKey,
          handle,
        });
        if (this.handle === handle) this.handle = undefined;
      }
      this.processClosed = true;
      this.buffer = Buffer.alloc(0);
      this.emitClose();
    })();
    this.closing = closeAttempt;
    try {
      await closeAttempt;
    } finally {
      if (this.closing === closeAttempt) this.closing = undefined;
    }
  }

  private receive(chunk: Uint8Array): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) break;
      if (newline > MAX_STDIO_FRAME_BYTES) return this.fail(new Error('plugin-mcp-stdio-frame-too-large'));
      const line = this.buffer.toString('utf8', 0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.subarray(newline + 1);
      // Some otherwise valid MCP CLIs print a short update/banner message to
      // stdout before their first JSON-RPC frame. Accept only bounded, plainly
      // non-JSON startup text; once the protocol starts, framing stays strict.
      if (!this.protocolStarted && !line.trimStart().startsWith('{')) {
        this.startupPreambleBytes += newline + 1;
        this.startupPreambleLines += 1;
        if (
          this.startupPreambleBytes > MAX_STDIO_STARTUP_PREAMBLE_BYTES
          || this.startupPreambleLines > MAX_STDIO_STARTUP_PREAMBLE_LINES
        ) {
          return this.fail(new Error('plugin-mcp-stdio-startup-preamble-too-large'));
        }
        continue;
      }
      try {
        const message = deserializeMessage(line) as JSONRPCMessage;
        this.protocolStarted = true;
        this.onmessage?.(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    if (this.buffer.length > MAX_STDIO_FRAME_BYTES) this.fail(new Error('plugin-mcp-stdio-frame-too-large'));
  }

  private fail(error: Error): void {
    this.onerror?.(error);
    void this.close().catch(closeError => {
      this.onerror?.(new AggregateError(
        [error, closeError],
        'plugin-mcp-transport-close-failed',
      ));
    });
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.onclose?.();
  }
}

function assertPluginRuntimeAuthority(runtime: PluginMcpRuntimeAuthority, command: string): void {
  if (!isAbsolute(command)) throw new Error('plugin-mcp-command-not-absolute');
  if (!isAbsolute(runtime.bundleRootPath) || !isAbsolute(runtime.dataPath)) {
    throw new Error('plugin-mcp-runtime-path-not-absolute');
  }
  if (!/^[a-f0-9]{64}$/i.test(runtime.expectedBundleHash)) throw new Error('plugin-mcp-bundle-hash-invalid');
  if (runtime.projectPath && !isAbsolute(runtime.projectPath)) throw new Error('plugin-mcp-project-path-not-absolute');
  for (const root of runtime.hostWritableRoots ?? []) {
    if (!isAbsolute(root) || dirname(resolve(root)) === resolve(root)) {
      throw new Error('plugin-mcp-host-writable-root-invalid');
    }
  }
}

function authorizedWorkingRoot(cwd: string, runtime: PluginMcpRuntimeAuthority): string {
  for (const root of [runtime.bundleRootPath, runtime.projectPath]) {
    if (!root) continue;
    const rel = relative(resolve(root), cwd);
    if (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)) {
      return resolve(root);
    }
  }
  throw new Error('plugin-mcp-working-directory-outside-authorized-roots');
}

/**
 * F1.665 (c) — `tools/list` the tolerant way on any SDK `Client`: the one path
 * {@link NessyMcpClient} and the stdio `source_test` validator (`validation.ts`)
 * share. The envelope is loose, each tool is kept or skipped by
 * {@link partitionListedTools}, and the kept tools go to the SDK's private
 * `cacheToolMetadata` — what `Client.listTools` does besides validating (output
 * validation for `callTool`, task support). Private in the typings and public at
 * runtime; `mcp-invalid-tool-schema.test.ts` pins that it still exists.
 */
export async function listToolsTolerantly(client: Client): Promise<{ tools: Tool[]; skipped: McpSkippedTool[] }> {
  const result = await client.request({ method: 'tools/list' }, LenientListToolsResultSchema);
  const partitioned = partitionListedTools(result.tools);
  (client as unknown as { cacheToolMetadata(tools: Tool[]): void }).cacheToolMetadata(partitioned.tools);
  return partitioned;
}

/** F1.665 (c) — skipped tools as one line (`N tools skipped: "name" (reason); …`), or `undefined`. */
export function skippedToolsSummary(skipped: readonly McpSkippedTool[]): string | undefined {
  if (skipped.length === 0) return undefined;
  const listed = skipped.map(entry => `"${entry.name}" (${entry.reason})`).join('; ');
  return `${skipped.length === 1 ? '1 tool' : `${skipped.length} tools`} skipped: ${listed}`;
}

/**
 * F1.683 — the `jsonSchemaValidator` every SDK `Client` here is built with: each
 * tool's `outputSchema` is compiled in its OWN Ajv.
 *
 * The SDK default is one `AjvJsonSchemaValidator` per `Client`, and its
 * `getValidator` returns the schema Ajv already holds under a schema's `$id`
 * instead of compiling the new one (`validation/ajv-provider.js`:
 * `this._ajv.getSchema(schema.$id) ?? this._ajv.compile(schema)`). So two tools
 * whose output schemas share a top-level `$id` were both validated against the
 * first one's schema, and a tool listed again after `tools/list_changed` with a
 * changed schema under the same `$id` kept the old one: a correct answer was
 * refused, a wrong one let through. Nothing in the MCP spec makes `$id` unique
 * across a server's tools. A fresh instance per schema is the exact instance
 * {@link toolSchemaCompileError} already compiles every listed schema with, so
 * nothing the host check accepted can fail to compile here.
 * The cost: one Ajv per output schema per listing (about 0.17 ms per tool,
 * measured for the host check by F1.665).
 */
export const FRESH_AJV_PER_OUTPUT_SCHEMA: jsonSchemaValidator = {
  getValidator: schema => quietAjvJsonSchemaValidator().getValidator(schema),
};
import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation'; // F1.683 — appended, hoisted

/**
 * F1.699 — the SDK's default `AjvJsonSchemaValidator` (formats included, as
 * F1.665 requires) with its Ajv instance's logger silenced. The host compiles
 * each schema in a fresh validator ({@link toolSchemaCompileError},
 * {@link FRESH_AJV_PER_OUTPUT_SCHEMA}), so Ajv's "unknown format ... ignored"
 * warning went to the console once per such tool on every listing, refresh and
 * hydration. Silencing it changes no compile outcome: an unknown format is
 * ignored either way (`strict: false`) and a schema Ajv cannot compile still
 * throws. The SDK keeps the instance in a private `_ajv`; if a lift renames it
 * the warnings come back, which `mcp-schema-residues.test.ts` would report.
 */
function quietAjvJsonSchemaValidator(): AjvJsonSchemaValidator {
  const validator = new AjvJsonSchemaValidator();
  const ajv = (validator as unknown as { _ajv?: { logger?: unknown } })._ajv;
  if (ajv && typeof ajv === 'object') ajv.logger = SILENT_AJV_LOGGER;
  return validator;
}

const SILENT_AJV_LOGGER = { log: () => {}, warn: () => {}, error: () => {} };
