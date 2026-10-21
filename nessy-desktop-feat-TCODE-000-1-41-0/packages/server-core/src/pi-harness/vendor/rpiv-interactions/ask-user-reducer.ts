import type { AskUserAnswer, AskUserPermissionRequest } from '@nessy-agent/core/types';
import { validateAskUserQuestions, validateBatchedAskUserAnswer } from '@nessy-agent/core/utils';
import type { PiPendingAskUserV1 } from '@nessy-agent/shared/sessions/types';

export type PendingAskUser = PiPendingAskUserV1;
export type PendingAskUserInput = Omit<PiPendingAskUserV1, 'schemaVersion'> & AskUserPermissionRequest;

/**
 * `minOptions` defaults to the `ask_user` TOOL's documented floor of 2, which is
 * every caller but one: an MCP elicitation ACKNOWLEDGEMENT (`declineVisibly` in
 * `mcp/elicitation.ts`) is a single `OK`, and it passes 1 explicitly. Held to 2
 * it threw here, before `AskUserService.request` published anything, so Pi's
 * user saw no card at all and the MCP server got `cancel` — the silent drop the
 * "tell the user why, then decline it" rule exists to prevent. The allowance is
 * a per-request argument rather than a lowered bound so nothing else moves.
 */
export function validateAskUser(request: PendingAskUserInput | PendingAskUser, options: { minOptions?: number } = {}): void {
  const minOptions = options.minOptions ?? 2;
  if (!request.requestId) throw new Error('invalid-request');
  if (request.questions !== undefined) {
    // Batched superset (R7): the documented 1-4 x 2-4 bounds + 12-char header.
    validateAskUserQuestions(request.questions);
    return;
  }
  if (!request.question.trim()) throw new Error('invalid-request');
  if (request.options.length < minOptions || request.options.length > 4) throw new Error('invalid-options');
  if (request.options.some(option => !option.trim()) || new Set(request.options).size !== request.options.length) throw new Error('invalid-options');
}

export function validateAskUserAnswer(request: PendingAskUser, answer: AskUserAnswer): void {
  if (answer.type === 'batched') {
    validateBatchedAskUserAnswer(request.questions, answer);
    return;
  }
  if (answer.type === 'option' && request.options.includes(answer.value) && request.options[answer.optionIndex] === answer.value) return;
  if (answer.type === 'free_text' && request.allowFreeText && answer.value.trim()) return;
  throw new Error('invalid-answer');
}
