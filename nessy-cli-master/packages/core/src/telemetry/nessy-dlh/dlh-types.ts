/**
 * DLH (Data Lake House) API contract types.
 * Each `DlhEvent` variant corresponds to one backend contract type.
 * Only the `event` contract is implemented so far.
 */

export interface DlhAgentEvent {
  event_id: string;
  session_id: string;
  prompt_id: string | null;
  type: string;
  payload_json: string;
  payload_json_length: number;
  client_created_at: number;
  sensitive_data_filtered: boolean;
}

export interface DlhAgentMessage {
  message_id: string;
  session_id: string;
  prompt_id: string;
  role: 'user' | 'agent';
  client_created_at: number;
  type: 'text' | 'command' | 'error' | 'canceled';
  content: string;
  content_length: number;
  truncated: boolean;
  sensitive_data_filtered: boolean;
  has_attachments: boolean;
  include_content: boolean;
}

export interface DlhAgentInference {
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
}

export interface DlhAgentToolCall {
  tool_call_id: string;
  session_id: string;
  prompt_id: string;
  inference_id: string | null;
  function_name: string;
  client_created_at: number;
  client_finished_at: number | null;
  /** Момент, когда вызов перешёл в `awaiting_approval` (UI показал диалог). */
  client_approve_sent_at: number | null;
  /** Момент, когда вызов вышел из `awaiting_approval` (пользователь решил). */
  client_approve_received_at: number | null;
  call_json: string;
  call_json_length: number;
  response: string | null;
  response_length: number | null;
  status: 'success' | 'error' | 'aborted';
  decision: 'approve' | 'reject' | 'auto' | null;
  tool_type: 'native' | 'mcp';
  mcp_server_name: string | null;
  /** Name of the providing extension, when this tool comes from one. */
  extension_name: string | null;
  /** Install source of the providing extension (ExtensionInstallMetadata.source). */
  extension_source: string | null;
  sensitive_data_filtered: boolean;
  include_content: boolean;
}

export interface DlhAgentRequest {
  prompt_id: string;
  session_id: string;
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
  /**
   * JSON string with agent launch metadata:
   * - model: model ID
   * - approval_mode: approval mode setting
   * - sandbox_enabled: whether sandbox is enabled
   * - debug_enabled: whether debug mode is enabled
   * - launch_mode: launch mode (vscode, acp, sdk, ci, jetbrains, nessycowork, desktop, tui, nonInteractive)
   * - channel: channel identifier (VSCode, ACP, SDK, CI, JetBrains, NessyCoWork, desktop, qwarium)
   * - ext_version: client extension version (optional, from --ext-version flag)
   */
  agent_params_json: string | null;
  client_created_at: number;
  /** Name of the providing extension, when this agent comes from one. */
  extension_name: string | null;
  /** Install source of the providing extension (ExtensionInstallMetadata.source). */
  extension_source: string | null;
}

/** Discriminated union — extend with more contract types over time. */
export type DlhEvent =
  | { type: 'event'; data: DlhAgentEvent }
  | { type: 'message'; data: DlhAgentMessage }
  | { type: 'inference'; data: DlhAgentInference }
  | { type: 'tool_call'; data: DlhAgentToolCall }
  | { type: 'request'; data: DlhAgentRequest };
