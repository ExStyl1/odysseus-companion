import { EventEmitter } from 'node:events';
import type { Config } from '../../config/config.js';
import { recordDlhEvent } from './contracts/event.js';
import { recordDlhInference } from './contracts/inference.js';
import { recordDlhMessage } from './contracts/message.js';
import { recordDlhToolCall } from './contracts/tool_call.js';
import { recordDlhRequest } from './contracts/request.js';
import { StartSessionEvent } from '../types.js';
import { getAgentLaunchMode } from '../statistClient.js';
import { getMCPServerStatus } from '../../tools/mcp-client.js';
import {
  runInDlhContext,
  createDlhContext,
  incrementDlhTurn,
  getCurrentDlhContext,
} from './dlh-context.js';

// ─── Event payload types ──────────────────────────────────────────────────────

export interface SlashCommandPayload {
  command: string;
  subcommand?: string;
  extension_name?: string | null;
  extension_source?: string | null;
}

export interface LoopDetectedPayload {
  loop_type: string;
  prompt_id: string;
  config?: Config;
}

export interface ContextCompressedPayload {
  tokens_before: number;
  tokens_after: number;
  config?: Config;
}

export interface UserCancelledPayload {
  prompt_id: string;
  config?: Config;
}

export interface MaxTurnsReachedPayload {
  prompt_id: string;
  max_turns: number;
  config?: Config;
}

export interface TokenLimitExceededPayload {
  prompt_id: string;
  current_tokens: number;
  limit: number;
  config?: Config;
}

export interface MessagePayload {
  session_id: string;
  prompt_id: string;
  role: 'user' | 'agent';
  content: string;
  sensitive_data_filtered: boolean;
  include_content: boolean;
  config?: Config;
}

export interface InferencePayload {
  inference_id: string | null;
  prompt_id: string;
  type: 'base' | 'recall_memory' | 'extract_memory';
  session_id: string;
  prompt_text: string;
  prompt_text_length: number;
  model_response: string | null;
  model_response_length: number | null;
  client_prompt_sent_at: number;
  client_prompt_finished_at: number | null;
  model_id: string;
  generate_params_json: string;
  status: 'success' | 'error' | 'aborted';
  error_status_code: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cached: number | null;
  reasoning_tokens: number | null;
  details_json: string | null;
  sensitive_data_filtered: boolean;
  include_content: boolean;
  config?: Config;
}

export interface AgentRequestPayload {
  prompt_id: string;
  agent_mode: string;
  agent_name: string;
  agent_hash: string;
  nestor_user_id: string;
  parent_tool_call_id: string | null;
  parent_prompt_id: string | null;
  version: string;
  host: string;
  pwd: string;
  os: string;
  agent_params_json: string | null;
  client_created_at: number;
  extension_name?: string | null;
  extension_source?: string | null;
  config?: Config;
}

export interface ToolCallPayload {
  tool_call_id: string;
  prompt_id: string;
  inference_id: string | null;
  function_name: string;
  client_created_at: number;
  client_finished_at: number | null;
  client_approve_sent_at: number | null;
  client_approve_received_at: number | null;
  call_json: string;
  call_json_length: number;
  response: string | null;
  response_length: number | null;
  status: 'success' | 'error' | 'aborted';
  decision: 'approve' | 'reject' | 'auto' | null;
  tool_type: 'native' | 'mcp';
  mcp_server_name: string | null;
  extension_name?: string | null;
  extension_source?: string | null;
  sensitive_data_filtered: boolean;
  include_content: boolean;
  config?: Config;
}

export interface CliConfigPayload {
  model: string;
  approval_mode: string;
  sandbox_enabled: boolean;
  debug_enabled: boolean;
  core_tools_enabled: string | null;
  mcp_servers: string;
  mcp_servers_count: number;
  mcp_tools: string | null;
  mcp_tools_count: number | null;
  skills: string | null;
  subagents: string | null;
  launch_mode: string | null;
  channel: string | null;
  servers_json: string;
}

export interface SessionEndedPayload {
  completed: boolean;
}

/** Map of event name → payload type for type-safe emit/on. */
interface NessyDlhEventMap {
  slash_command: SlashCommandPayload;
  loop_detected: LoopDetectedPayload;
  context_compressed: ContextCompressedPayload;
  user_cancelled: UserCancelledPayload;
  max_turns_reached: MaxTurnsReachedPayload;
  token_limit_exceeded: TokenLimitExceededPayload;
  message: MessagePayload;
  inference: InferencePayload;
  tool_call: ToolCallPayload;
  agent_request: AgentRequestPayload;
  cli_config: CliConfigPayload;
  session_ended: SessionEndedPayload;
}

function buildCliConfigPayload(config: Config): CliConfigPayload {
  const e = new StartSessionEvent(config);
  const servers = config.getMcpServers() ?? {};
  const serverStates = Object.keys(servers).map((name) => ({
    name,
    status: String(getMCPServerStatus(name)),
    disabled: config.isMcpServerDisabled(name),
    pending_approval: config.isMcpServerPendingApproval(name),
  }));
  return {
    model: e.model,
    approval_mode: e.approval_mode,
    sandbox_enabled: e.sandbox_enabled,
    debug_enabled: e.debug_enabled,
    core_tools_enabled: e.core_tools_enabled ?? null,
    mcp_servers: e.mcp_servers,
    mcp_servers_count: e.mcp_servers_count,
    mcp_tools: e.mcp_tools ?? null,
    mcp_tools_count: e.mcp_tools_count ?? null,
    skills: e.skills ?? null,
    subagents: e.subagents ?? null,
    launch_mode: getAgentLaunchMode(config),
    channel: config.getChannel() ?? null,
    servers_json: JSON.stringify(serverStates),
  };
}

// ─── NessyDlh ─────────────────────────────────────────────────────────────────

/**
 * Event-driven DLH integration hub.
 *
 * External code emits typed events here; handlers inside this class convert
 * them into DLH contract payloads and fire them to the backend.
 *
 * Uses AsyncLocalStorage for automatic context propagation, so callers don't
 * need to pass sessionId/promptId explicitly.
 */
export class NessyDlh {
  private readonly emitter = new EventEmitter();
  private initialized = false;

  constructor(private readonly config: Config) {
    this.registerHandlers();
  }

  /**
   * Returns the config instance for use in event sending
   */
  getConfig(): Config {
    return this.config;
  }

  /**
   * Initialize DLH context for a new session.
   * Should be called when a session starts.
   *
   * @param initialTurn - Initial turn counter (default: 0)
   */
  initializeSession(initialTurn: number = 0): void {
    if (this.initialized) return;

    const sessionId = this.config.getSessionId();
    const context = createDlhContext(sessionId, initialTurn, null, this.config);

    // Run initialization in context
    runInDlhContext(context, () => {
      this.initialized = true;
    });
  }

  /**
   * Increment turn counter for a new user prompt.
   * Should be called at the start of each user prompt.
   *
   * @returns The new turn number, or null if not initialized
   */
  incrementTurn(): number | null {
    return incrementDlhTurn();
  }

  /**
   * Set the current prompt ID in the context.
   * Should be called when starting a new prompt.
   *
   * @param promptId - The prompt ID
   */
  setPromptId(promptId: string): void {
    const context = getCurrentDlhContext();
    if (context) {
      context.promptId = promptId;
    }
  }

  // ─── Public typed API ───────────────────────────────────────────────────────

  emit<K extends keyof NessyDlhEventMap>(
    event: K,
    payload: NessyDlhEventMap[K],
  ): void {
    this.emitter.emit(event, payload);
  }

  on<K extends keyof NessyDlhEventMap>(
    event: K,
    handler: (payload: NessyDlhEventMap[K]) => void,
  ): void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
  }

  /**
   * Emit a snapshot of the currently connected/configured tool inventory
   * (`cli_config`) through the DLH event channel. Called at session start
   * and whenever the MCP client set changes so later-connected or disabled
   * tools are captured as well.
   */
  // [nessy-fork] dlh-cli-config-snapshot
  logToolsSnapshot(): void {
    this.emit('cli_config', buildCliConfigPayload(this.config));
  }

  /**
   * Emit a `session_ended` DLH event for the current session. Called on
   * normal shutdown; abrupt exits do not run it, so analytics can treat a
   * missing `session_ended` as a session that did not complete.
   */
  logSessionEnd(completed = true): void {
    this.emit('session_ended', { completed });
  }

  // ─── Internal handlers ──────────────────────────────────────────────────────

  private registerHandlers(): void {
    this.on('slash_command', (payload) => {
      recordDlhEvent(
        'slash_command',
        {
          command: payload.command,
          subcommand: payload.subcommand ?? null,
          extension_name: payload.extension_name ?? null,
          extension_source: payload.extension_source ?? null,
        },
        undefined,
        this.config,
      );
    });

    this.on('loop_detected', (payload) => {
      recordDlhEvent(
        'loop_detected',
        { loop_type: payload.loop_type },
        payload.prompt_id,
        payload.config ?? this.config,
      );
    });

    this.on('context_compressed', (payload) => {
      recordDlhEvent(
        'context_compressed',
        {
          tokens_before: payload.tokens_before,
          tokens_after: payload.tokens_after,
        },
        undefined,
        payload.config ?? this.config,
      );
    });

    this.on('user_cancelled', (payload) => {
      recordDlhEvent(
        'user_cancelled',
        {},
        payload.prompt_id,
        payload.config ?? this.config,
      );
    });

    this.on('max_turns_reached', (payload) => {
      recordDlhEvent(
        'max_turns_reached',
        { max_turns: payload.max_turns },
        payload.prompt_id,
        payload.config ?? this.config,
      );
    });

    this.on('token_limit_exceeded', (payload) => {
      recordDlhEvent(
        'token_limit_exceeded',
        { current_tokens: payload.current_tokens, limit: payload.limit },
        payload.prompt_id,
        payload.config ?? this.config,
      );
    });

    this.on('cli_config', (payload) => {
      recordDlhEvent(
        'cli_config',
        {
          model: payload.model,
          approval_mode: payload.approval_mode,
          sandbox_enabled: payload.sandbox_enabled,
          debug_enabled: payload.debug_enabled,
          core_tools_enabled: payload.core_tools_enabled,
          mcp_servers: payload.mcp_servers,
          mcp_servers_count: payload.mcp_servers_count,
          mcp_tools: payload.mcp_tools,
          mcp_tools_count: payload.mcp_tools_count,
          skills: payload.skills,
          subagents: payload.subagents,
          launch_mode: payload.launch_mode,
          channel: payload.channel,
          servers_json: payload.servers_json,
        },
        undefined,
        this.config,
      );
    });

    this.on('session_ended', (payload) => {
      recordDlhEvent(
        'session_ended',
        { completed: payload.completed },
        undefined,
        this.config,
      );
    });

    this.on('message', (payload) => {
      recordDlhMessage({
        session_id: payload.session_id,
        prompt_id: payload.prompt_id,
        role: payload.role,
        type: 'text',
        content: payload.content,
        include_content: payload.include_content,
        sensitive_data_filtered: payload.sensitive_data_filtered,
        config: payload.config ?? this.config,
      });
    });

    this.on('inference', (payload) => {
      recordDlhInference({
        inference_id: payload.inference_id || undefined,
        prompt_id: payload.prompt_id,
        type: payload.type,
        session_id: payload.session_id,
        prompt_text: payload.include_content ? payload.prompt_text : '',
        prompt_text_length: payload.prompt_text_length,
        model_response: payload.include_content ? payload.model_response : null,
        model_response_length: payload.model_response_length,
        client_prompt_sent_at: payload.client_prompt_sent_at,
        client_prompt_finished_at: payload.client_prompt_finished_at,
        model_id: payload.model_id,
        generate_params_json: payload.generate_params_json,
        status: payload.status,
        error_status_code: payload.error_status_code,
        tokens_input: payload.tokens_input,
        tokens_output: payload.tokens_output,
        tokens_cached: payload.tokens_cached,
        reasoning_tokens: payload.reasoning_tokens,
        details_json: payload.include_content ? payload.details_json : null,
        sensitive_data_filtered: payload.sensitive_data_filtered,
        include_content: payload.include_content,
        config: payload.config ?? this.config,
      });
    });

    this.on('agent_request', (payload) => {
      recordDlhRequest(
        {
          prompt_id: payload.prompt_id,
          agent_mode: payload.agent_mode,
          agent_name: payload.agent_name,
          agent_hash: payload.agent_hash,
          nestor_user_id: payload.nestor_user_id,
          parent_tool_call_id: payload.parent_tool_call_id,
          parent_prompt_id: payload.parent_prompt_id,
          version: payload.version,
          host: payload.host,
          pwd: payload.pwd,
          os: payload.os,
          agent_params_json: payload.agent_params_json,
          client_created_at: payload.client_created_at,
          extension_name: payload.extension_name ?? null,
          extension_source: payload.extension_source ?? null,
        },
        payload.config ?? this.config,
      );
    });

    this.on('tool_call', (payload) => {
      recordDlhToolCall({
        tool_call_id: payload.tool_call_id,
        prompt_id: payload.prompt_id,
        inference_id: payload.inference_id,
        function_name: payload.function_name,
        client_created_at: payload.client_created_at,
        client_finished_at: payload.client_finished_at,
        client_approve_sent_at: payload.client_approve_sent_at,
        client_approve_received_at: payload.client_approve_received_at,
        call_json: payload.include_content ? payload.call_json : '',
        call_json_length: payload.call_json_length,
        response: payload.include_content ? payload.response : null,
        response_length: payload.response_length,
        status: payload.status,
        decision: payload.decision,
        tool_type: payload.tool_type,
        mcp_server_name: payload.mcp_server_name,
        extension_name: payload.extension_name ?? null,
        extension_source: payload.extension_source ?? null,
        sensitive_data_filtered: !payload.include_content,
        include_content: payload.include_content,
        config: payload.config ?? this.config,
      });
    });
  }
}
