/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  RuntimePendingRequest,
  ToolCall,
  ToolCallConfirmationDetails,
} from '@nestor/nessy-cli-core';
import { ToolConfirmationOutcome } from '@nestor/nessy-cli-core';
import { toPermissionOptions } from '../acp-integration/session/permissionUtils.js';
import { StreamingState } from '../ui/types.js';

/** Max length of the advisory `pending_request.summary` text. */
const MAX_SUMMARY_LENGTH = 200;

export interface SessionPhaseInput {
  streamingState: StreamingState;
  /** Tool calls currently tracked by the scheduler (any status). */
  pendingToolCalls: readonly ToolCall[];
  /** True once the session has run (or blocked on) at least one turn. */
  hasRunTurn: boolean;
  /**
   * Maps a tool call id to the external request id reported in
   * `pending_request.request_id`. Callers pass the same registration the
   * dual-output bridge uses so the id matches `control_request` events on
   * the events channel; the identity default keeps the resolver usable
   * standalone.
   */
  resolveRequestId?: (callId: string) => string;
}

export interface SessionPhaseUpdate {
  phase: 'idle' | 'working' | 'waiting_input' | 'done';
  pendingRequest: RuntimePendingRequest | null;
  hasRunTurn: boolean;
}

/**
 * Pure mapping from TUI state to the runtime.json `state.phase` model.
 *
 * Precedence: an awaiting tool call wins (it carries the pending request
 * details), then WaitingForConfirmation (which also covers subagent
 * confirmations that don't surface as top-level awaiting calls — those
 * report waiting_input without request details), then working, then
 * done (a turn has finished — the answer is ready to read) / idle
 * (no turn has run yet). External consumers clear `done` when the next
 * prompt starts.
 */
export function resolveSessionPhaseUpdate(
  input: SessionPhaseInput,
): SessionPhaseUpdate {
  const waitingTc = input.pendingToolCalls.find(
    (tc): tc is Extract<ToolCall, { status: 'awaiting_approval' }> =>
      tc.status === 'awaiting_approval',
  );
  if (waitingTc) {
    return {
      phase: 'waiting_input',
      pendingRequest: {
        request_id: (input.resolveRequestId ?? ((callId) => callId))(
          waitingTc.request.callId,
        ),
        tool_name: waitingTc.request.name,
        summary: summarizeConfirmation(waitingTc.confirmationDetails),
        options: pendingRequestOptions(waitingTc.confirmationDetails),
        // [nessy-fork] session-status: много-вопросные/multiSelect-опросы
        // неразрешимы одним кнопочным ответом — потребитель обязан
        // рендерить их display-only (см. isUnanswerableQuestionnaire).
        questionnaire: isUnanswerableQuestionnaire(
          waitingTc.confirmationDetails,
        ),
      },
      hasRunTurn: true,
    };
  }
  if (input.streamingState === StreamingState.WaitingForConfirmation) {
    return { phase: 'waiting_input', pendingRequest: null, hasRunTurn: true };
  }
  if (input.streamingState === StreamingState.Responding) {
    return { phase: 'working', pendingRequest: null, hasRunTurn: true };
  }
  // Idle: `done` once a turn has completed (answer ready to read),
  // `idle` before the very first turn.
  return {
    phase: input.hasRunTurn ? 'done' : 'idle',
    pendingRequest: null,
    hasRunTurn: input.hasRunTurn,
  };
}

/**
 * Short human-readable text for the pending dialog, shown in external
 * notifications. Advisory only — never parsed.
 */
export function summarizeConfirmation(
  details: ToolCallConfirmationDetails | undefined,
): string | undefined {
  if (!details) return undefined;
  let summary: string;
  switch (details.type) {
    case 'exec':
      summary = details.command;
      break;
    case 'edit':
      summary = details.filePath || details.fileName;
      break;
    case 'mcp':
      summary = `${details.serverName}.${details.toolDisplayName}`;
      break;
    case 'info':
      summary = details.prompt;
      break;
    case 'plan':
      summary = details.title;
      break;
    case 'ask_user_question':
      summary = details.questions.map((q) => q.question).join(' | ');
      break;
    default:
      return undefined;
  }
  const trimmed = summary.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_SUMMARY_LENGTH
    ? `${trimmed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : trimmed;
}

/**
 * The choices an external consumer may answer with, mirroring the ACP
 * permission options (same option ids, including `q0_opt0`-style ids for
 * ask_user_question choices). `undefined` when the confirmation type has
 * no option model, when the ask is multi-question or multiSelect (one
 * option_id answer maps to a single question — flattened multi-question
 * options would mis-answer, and the in-app dialog joins a multi-choice
 * selection with ", "), or when no option survives filtering.
 *
 * For ask_user_question the `proceed_once` id ("I'll specify my own
 * answer") is dropped: the remote-input resolver rejects custom answers.
 * For exec/edit/mcp/info it IS the plain "Allow once" and stays — the
 * resolver maps it to the ProceedOnce outcome there.
 */
export function pendingRequestOptions(
  details: ToolCallConfirmationDetails | undefined,
): RuntimePendingRequest['options'] {
  if (!details) return undefined;
  if (isUnanswerableQuestionnaire(details)) return undefined;
  const isAsk = details.type === 'ask_user_question';
  try {
    const options = toPermissionOptions(details)
      .filter(
        (option) =>
          !isAsk || option.optionId !== ToolConfirmationOutcome.ProceedOnce,
      )
      .map((option) => ({
        option_id: option.optionId,
        name: option.name,
      }));
    return options.length > 0 ? options : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True for ask_user_question confirmations a single remote option/allow
 * answer cannot honestly resolve (multi-question or multiSelect). Consumers
 * must render these display-only — a binary `allowed:true` maps to the
 * "custom answer" branch that remote input can never fill.
 */
export function isUnanswerableQuestionnaire(
  details: ToolCallConfirmationDetails | undefined,
): boolean {
  if (details?.type !== 'ask_user_question') return false;
  const single = details.questions.length === 1 ? details.questions[0] : null;
  return single === null || single.multiSelect === true;
}
