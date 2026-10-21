/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallConfirmationDetails } from '@nestor/nessy-cli-core';
import { ToolConfirmationOutcome } from '@nestor/nessy-cli-core';
import { toPermissionOptions } from '../acp-integration/session/permissionUtils.js';

/** ask_user_question choice ids look like `q0_opt1` (see toPermissionOptions). */
const ASK_OPTION_ID_PATTERN = /^q(\d+)_opt(\d+)$/;

export type RemoteOptionDecision =
  | {
      kind: 'selected';
      outcome: ToolConfirmationOutcome;
      /** Present only for ask_user_question choices: {questionIndex: label}. */
      answers?: Record<string, string>;
    }
  | { kind: 'invalid'; reason: string };

/**
 * Translate an externally selected `option_id` (the same ids advertised in
 * the runtime.json `state.pending_request.options` block) into the
 * `onConfirm(outcome, payload)` call the pending tool call expects.
 *
 * Selection is validated against the options actually offered for this
 * confirmation (including `hideAlwaysAllow` filtering), so a stale or
 * replayed id for an option that is no longer offered is rejected rather
 * than blindly dispatched to `onConfirm`.
 */
// [nessy-fork] remote-option-response
export function resolveRemoteOptionResponse(
  optionId: string,
  details: ToolCallConfirmationDetails | undefined,
): RemoteOptionDecision {
  if (!details) {
    return { kind: 'invalid', reason: 'no confirmation details on request' };
  }
  let offered;
  try {
    offered = toPermissionOptions(details);
  } catch {
    return { kind: 'invalid', reason: 'confirmation has no option model' };
  }
  if (!offered.some((option) => option.optionId === optionId)) {
    return {
      kind: 'invalid',
      reason: `unknown option_id "${optionId}" for this request`,
    };
  }

  const askMatch = ASK_OPTION_ID_PATTERN.exec(optionId);
  if (askMatch) {
    if (details.type !== 'ask_user_question') {
      // Unreachable when ids come from toPermissionOptions, but guard
      // against id collisions on other confirmation types.
      return {
        kind: 'invalid',
        reason: 'ask-style option_id on a non-ask confirmation',
      };
    }
    const questionIndex = Number(askMatch[1]);
    const optionIndex = Number(askMatch[2]);
    const question = details.questions[questionIndex];
    const option = question?.options[optionIndex];
    if (!question || !option) {
      return {
        kind: 'invalid',
        reason: `option_id "${optionId}" is out of range`,
      };
    }
    return {
      kind: 'selected',
      outcome: ToolConfirmationOutcome.ProceedOnce,
      answers: { [String(questionIndex)]: option.label },
    };
  }

  const outcome = optionId as ToolConfirmationOutcome;
  if (!Object.values(ToolConfirmationOutcome).includes(outcome)) {
    return { kind: 'invalid', reason: `unknown option_id "${optionId}"` };
  }
  if (
    details.type === 'ask_user_question' &&
    outcome === ToolConfirmationOutcome.ProceedOnce
  ) {
    // ProceedOnce on ask_user_question is "I'll specify my own answer" —
    // there is no text channel for a custom answer over the input file.
    return {
      kind: 'invalid',
      reason:
        'custom answers are not supported over remote input; select a q{n}_opt{m} option instead',
    };
  }
  return { kind: 'selected', outcome };
}
