/**
 * @license
 * Copyright 2026 Nessy Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  type ToolCall,
  type ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
} from '@nestor/nessy-cli-core';
import { StreamingState } from '../ui/types.js';
import {
  pendingRequestOptions,
  resolveSessionPhaseUpdate,
  summarizeConfirmation,
} from './session-phase-resolver.js';

const waitingCall = (
  callId: string,
  name: string,
  confirmationDetails: ToolCallConfirmationDetails,
): ToolCall =>
  ({
    status: 'awaiting_approval',
    request: {
      callId,
      name,
      args: {},
      isClientInitiated: false,
      prompt_id: 'p1',
    },
    tool: {},
    invocation: {},
    confirmationDetails,
  }) as unknown as ToolCall;

const execDetails = {
  type: 'exec',
  command: 'rm -rf build/',
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
  ],
} as unknown as ToolCallConfirmationDetails;

describe('resolveSessionPhaseUpdate', () => {
  it('maps an awaiting tool call to waiting_input with full details', () => {
    const update = resolveSessionPhaseUpdate({
      streamingState: StreamingState.WaitingForConfirmation,
      pendingToolCalls: [
        waitingCall('call-1', 'run_shell_command', execDetails),
      ],
      hasRunTurn: false,
    });
    expect(update.phase).toBe('waiting_input');
    expect(update.hasRunTurn).toBe(true);
    expect(update.pendingRequest).toMatchObject({
      request_id: 'call-1',
      tool_name: 'run_shell_command',
      summary: 'rm -rf build/',
    });
    expect(
      update.pendingRequest?.options?.some(
        (o) => o.option_id === ToolConfirmationOutcome.ProceedOnce,
      ),
    ).toBe(true); // exec: proceed_once IS the Allow button (remote-answerable)
    expect(
      update.pendingRequest?.options?.every(
        (o) => typeof o.option_id === 'string' && typeof o.name === 'string',
      ),
    ).toBe(true);
  });

  it('resolves request ids through the caller-provided registry', () => {
    const update = resolveSessionPhaseUpdate({
      streamingState: StreamingState.WaitingForConfirmation,
      pendingToolCalls: [waitingCall('call-1', 'edit', execDetails)],
      hasRunTurn: true,
      resolveRequestId: (callId) => `uuid-for-${callId}`,
    });
    expect(update.pendingRequest?.request_id).toBe('uuid-for-call-1');
  });

  it('prefers the awaiting call over other states', () => {
    const update = resolveSessionPhaseUpdate({
      streamingState: StreamingState.Responding,
      pendingToolCalls: [waitingCall('call-1', 'edit', execDetails)],
      hasRunTurn: true,
    });
    expect(update.phase).toBe('waiting_input');
    expect(update.pendingRequest?.tool_name).toBe('edit');
  });

  it('maps WaitingForConfirmation without an awaiting call to bare waiting_input', () => {
    // e.g. a subagent pendingConfirmation: blocked, but no top-level
    // awaiting call to derive request details from.
    const update = resolveSessionPhaseUpdate({
      streamingState: StreamingState.WaitingForConfirmation,
      pendingToolCalls: [],
      hasRunTurn: true,
    });
    expect(update.phase).toBe('waiting_input');
    expect(update.pendingRequest).toBeNull();
    expect(update.hasRunTurn).toBe(true);
  });

  it('maps Responding to working and clears the pending request', () => {
    const update = resolveSessionPhaseUpdate({
      streamingState: StreamingState.Responding,
      pendingToolCalls: [],
      hasRunTurn: true,
    });
    expect(update.phase).toBe('working');
    expect(update.pendingRequest).toBeNull();
    expect(update.hasRunTurn).toBe(true);
  });

  it('maps Idle after a turn to done', () => {
    const update = resolveSessionPhaseUpdate({
      streamingState: StreamingState.Idle,
      pendingToolCalls: [],
      hasRunTurn: true,
    });
    expect(update.phase).toBe('done');
    expect(update.hasRunTurn).toBe(true);
  });

  it('maps Idle before any turn to idle', () => {
    const update = resolveSessionPhaseUpdate({
      streamingState: StreamingState.Idle,
      pendingToolCalls: [],
      hasRunTurn: false,
    });
    expect(update.phase).toBe('idle');
    expect(update.hasRunTurn).toBe(false);
  });

  it('keeps hasRunTurn sticky once a turn has run', () => {
    const first = resolveSessionPhaseUpdate({
      streamingState: StreamingState.Responding,
      pendingToolCalls: [],
      hasRunTurn: false,
    });
    expect(first.hasRunTurn).toBe(true);
    const then = resolveSessionPhaseUpdate({
      streamingState: StreamingState.Idle,
      pendingToolCalls: [],
      hasRunTurn: first.hasRunTurn,
    });
    expect(then.phase).toBe('done');
  });
});

describe('summarizeConfirmation', () => {
  it('extracts the command for exec', () => {
    expect(summarizeConfirmation(execDetails)).toBe('rm -rf build/');
  });

  it('joins question texts for ask_user_question', () => {
    expect(summarizeConfirmation(askDetails)).toBe('Deploy to staging?');
  });

  it('truncates long summaries with an ellipsis', () => {
    const long = {
      type: 'exec',
      command: 'x'.repeat(500),
    } as unknown as ToolCallConfirmationDetails;
    const summary = summarizeConfirmation(long);
    expect(summary).toHaveLength(200);
    expect(summary?.endsWith('…')).toBe(true);
  });

  it('returns undefined for missing or empty summaries', () => {
    expect(summarizeConfirmation(undefined)).toBeUndefined();
    const blank = {
      type: 'exec',
      command: '   ',
    } as unknown as ToolCallConfirmationDetails;
    expect(summarizeConfirmation(blank)).toBeUndefined();
  });
});

describe('pendingRequestOptions', () => {
  it('maps ask_user_question choices to q{n}_opt{m} ids, dropping proceed_once', () => {
    const options = pendingRequestOptions(askDetails);
    // proceed_once on ask = "custom answer", rejected by the remote
    // resolver — advertising it would render a dead button.
    expect(options?.map((o) => o.option_id)).toEqual(['q0_opt0', 'q0_opt1']);
    expect(options?.[0].name).toBe('Yes, deploy');
  });

  it('KEEPS proceed_once for non-ask confirmations — it is the Allow button', () => {
    // The remote resolver only rejects proceed_once for ask_user_question;
    // for exec/edit it maps to the ProceedOnce outcome = plain Allow.
    // (The universal filter was the headline finding of the focused review.)
    const options = pendingRequestOptions({
      type: 'edit',
      filePath: 'src/x.ts',
      originalText: 'a',
      newText: 'b',
      onConfirm: async () => undefined,
    } as unknown as ToolCallConfirmationDetails);
    expect(options?.some((o) => o.option_id === 'proceed_once')).toBe(true);
  });

  it('returns undefined when there are no details', () => {
    expect(pendingRequestOptions(undefined)).toBeUndefined();
  });

  it('publishes no options for multiSelect questions', () => {
    // A single-button answer cannot honestly express a multi-choice
    // selection — the consumer must not be offered per-option buttons.
    const firstQuestion = (
      askDetails as unknown as {
        questions: Array<Record<string, unknown>>;
      }
    ).questions[0]!;
    const options = pendingRequestOptions({
      ...askDetails,
      questions: [{ ...firstQuestion, multiSelect: true }],
    } as unknown as ToolCallConfirmationDetails);
    expect(options).toBeUndefined();
  });

  it('publishes no options for multi-question asks', () => {
    // One option_id answer maps to a single question — flattened
    // q0_opt*/q1_opt* lists would mis-answer the questionnaire.
    const firstQuestion = (
      askDetails as unknown as {
        questions: Array<Record<string, unknown>>;
      }
    ).questions[0]!;
    const options = pendingRequestOptions({
      ...askDetails,
      questions: [firstQuestion, firstQuestion],
    } as unknown as ToolCallConfirmationDetails);
    expect(options).toBeUndefined();
  });
});
