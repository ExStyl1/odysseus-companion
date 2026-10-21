/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  type ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
} from '@nestor/nessy-cli-core';
import { resolveRemoteOptionResponse } from './remote-option-response.js';

const execDetails = {
  type: 'exec',
  command: 'rm -rf build/',
} as unknown as ToolCallConfirmationDetails;

const execHideAlwaysDetails = {
  type: 'exec',
  command: 'rm -rf build/',
  hideAlwaysAllow: true,
} as unknown as ToolCallConfirmationDetails;

const askDetails = {
  type: 'ask_user_question',
  questions: [
    {
      question: 'Deploy to staging?',
      header: 'Deploy',
      multiSelect: false,
      options: [
        { label: 'Yes, deploy', description: 'Deploy now' },
        { label: 'Not yet', description: 'Wait' },
      ],
    },
    {
      question: 'Notify the team?',
      header: 'Notify',
      multiSelect: false,
      options: [
        { label: 'Post in channel', description: '' },
        { label: 'Silent', description: '' },
        { label: 'Email only', description: '' },
      ],
    },
  ],
} as unknown as ToolCallConfirmationDetails;

describe('resolveRemoteOptionResponse', () => {
  it('maps an ask choice id to ProceedOnce with answers keyed by question index', () => {
    const decision = resolveRemoteOptionResponse('q0_opt1', askDetails);
    expect(decision.kind).toBe('selected');
    if (decision.kind !== 'selected') return;
    expect(decision.outcome).toBe(ToolConfirmationOutcome.ProceedOnce);
    expect(decision.answers).toEqual({ '0': 'Not yet' });
  });

  it('maps a second-question choice to that question index', () => {
    // GIVEN: ask confirmation with two questions, second has three options
    // WHEN: selecting the third option of the second question
    // THEN: answers are keyed by '1' with that option's label
    const decision = resolveRemoteOptionResponse('q1_opt2', askDetails);
    expect(decision.kind).toBe('selected');
    if (decision.kind !== 'selected') return;
    expect(decision.answers).toEqual({ '1': 'Email only' });
  });

  it('maps an enum-valued option id to the outcome without answers', () => {
    const decision = resolveRemoteOptionResponse(
      ToolConfirmationOutcome.ProceedAlwaysProject,
      execDetails,
    );
    expect(decision.kind).toBe('selected');
    if (decision.kind !== 'selected') return;
    expect(decision.outcome).toBe(ToolConfirmationOutcome.ProceedAlwaysProject);
    expect(decision.answers).toBeUndefined();
  });

  it('accepts cancel on an exec confirmation', () => {
    const decision = resolveRemoteOptionResponse(
      ToolConfirmationOutcome.Cancel,
      execDetails,
    );
    expect(decision.kind).toBe('selected');
  });

  it('rejects ProceedOnce on ask_user_question (custom answers have no text channel)', () => {
    // GIVEN: ask confirmation where ProceedOnce means "I'll specify my own answer"
    // WHEN: a remote consumer selects it
    // THEN: rejected with a reason pointing at the q{n}_opt{m} ids
    const decision = resolveRemoteOptionResponse(
      ToolConfirmationOutcome.ProceedOnce,
      askDetails,
    );
    expect(decision.kind).toBe('invalid');
    if (decision.kind !== 'invalid') return;
    expect(decision.reason).toContain('q{n}_opt{m}');
  });

  it('rejects an allow_always id that hideAlwaysAllow filtered out of the offered set', () => {
    // GIVEN: exec confirmation with hideAlwaysAllow — proceed_always_* not offered
    // WHEN: replaying a stale proceed_always_project id
    // THEN: rejected as unknown rather than dispatched to onConfirm
    const decision = resolveRemoteOptionResponse(
      ToolConfirmationOutcome.ProceedAlwaysProject,
      execHideAlwaysDetails,
    );
    expect(decision.kind).toBe('invalid');
    if (decision.kind !== 'invalid') return;
    expect(decision.reason).toContain('proceed_always_project');
  });

  it('rejects an option id from a different confirmation', () => {
    // GIVEN: exec confirmation (offers only enum ids)
    // WHEN: sending an ask-style id
    // THEN: rejected as unknown
    const decision = resolveRemoteOptionResponse('q0_opt0', execDetails);
    expect(decision.kind).toBe('invalid');
  });

  it('is invalid when the request has no confirmation details', () => {
    const decision = resolveRemoteOptionResponse(
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
    );
    expect(decision.kind).toBe('invalid');
  });
});
