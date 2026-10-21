import { describe, expect, it } from 'bun:test';
import type {
  PermissionRequest,
  PetSessionUpdate,
} from '@craft-agent/shared/protocol';
import {
  canReplaceCardKind,
  mapPhaseToPetNotification,
  mapPhaseToPetState,
  permissionRequestToNotification,
  terminalAnswerStyle,
} from './pet-session-mapping';

describe('mapPhaseToPetState', () => {
  it('maps external phases onto pet animation states', () => {
    expect(mapPhaseToPetState('working')).toBe('running');
    expect(mapPhaseToPetState('waiting_input')).toBe('waiting');
    expect(mapPhaseToPetState('done')).toBe('jumping');
  });

  it('animates nothing for idle and gone', () => {
    expect(mapPhaseToPetState('idle')).toBeNull();
    expect(mapPhaseToPetState('gone')).toBeNull();
  });
});

describe('mapPhaseToPetNotification', () => {
  it('maps phases to card kinds with terminal title keys', () => {
    expect(mapPhaseToPetNotification('working')).toEqual({
      kind: 'running',
      titleKey: 'pet.notify.terminalRunning',
    });
    expect(mapPhaseToPetNotification('waiting_input')).toEqual({
      kind: 'permission',
      titleKey: 'pet.notify.terminalApproval',
    });
    expect(mapPhaseToPetNotification('done')).toEqual({
      kind: 'success',
      titleKey: 'pet.notify.terminalDone',
    });
  });

  it('drops the card for idle and gone', () => {
    expect(mapPhaseToPetNotification('idle')).toBeNull();
    expect(mapPhaseToPetNotification('gone')).toBeNull();
  });
});

describe('permissionRequestToNotification', () => {
  it('a running card never evicts a pending DESKTOP question card', () => {
    // Activity events trail the question push out of order (observed live:
    // a late text_complete wiped a just-created card) — desktop cards are
    // cleared by *_resolved events instead.
    expect(
      canReplaceCardKind({ kind: 'permission', source: 'desktop' }, 'running'),
    ).toBe(false);
    // External (terminal/ACP) cards have no resolution event — the phase
    // push itself must replace the card.
    expect(
      canReplaceCardKind({ kind: 'permission', source: 'terminal' }, 'running'),
    ).toBe(true);
    expect(canReplaceCardKind({ kind: 'permission' }, 'running')).toBe(true);
    // Everything else replaces freely: terminals, newer questions, churn.
    expect(
      canReplaceCardKind({ kind: 'permission', source: 'desktop' }, 'success'),
    ).toBe(true);
    expect(
      canReplaceCardKind(
        { kind: 'permission', source: 'desktop' },
        'permission',
      ),
    ).toBe(true);
    expect(canReplaceCardKind({ kind: 'running' }, 'permission')).toBe(true);
  });

  // Free-text elicitation form (no enum options): the pet card cannot
  // collect text — a misleading Answer button would decline the question.
  it('degrades an option-less elicitation question to open-in-app', () => {
    const card = permissionRequestToNotification({
      requestId: 'el-2',
      description: 'Name the release?',
      elicitation: true,
      questions: [{ question: 'Name the release?', header: 'Release', options: [] }],
    });
    expect(card.answerStyle).toBe('none');
    expect(card.options).toBeUndefined();
  });

  const base = {
    requestId: 'req-1',
    toolName: 'AskUserQuestion',
    description: 'fallback description',
  } as PermissionRequest;

  it('renders a single non-multiSelect question as inline options', () => {
    const card = permissionRequestToNotification({
      ...base,
      questions: [
        {
          question: 'Which DB?',
          header: 'database',
          options: [
            { label: 'Postgres', description: 'battle-tested' },
            { label: 'SQLite', description: '' },
          ],
        },
      ],
    });

    expect(card).toEqual({
      requestId: 'req-1',
      toolName: 'AskUserQuestion',
      summary: 'Which DB?',
      // Answers are keyed by question INDEX, not header — the chat UI and
      // resolveAskUserQuestionOptionId both expect '0' for the first question.
      answerKey: '0',
      options: [
        { optionId: 'Postgres', name: 'Postgres', description: 'battle-tested' },
        { optionId: 'SQLite', name: 'SQLite', description: undefined },
      ],
      answerStyle: 'options',
    });
  });

  it('degrades to allow/deny when the single question has no usable options', () => {
    const card = permissionRequestToNotification({
      ...base,
      questions: [{ question: 'Proceed?', header: 'h', options: [] }],
    });

    expect(card.answerStyle).toBe('allow_deny');
    expect(card.options).toBeUndefined();
    expect(card.summary).toBe('Proceed?');
  });

  it('treats a plain tool approval (no questions) as allow/deny', () => {
    const card = permissionRequestToNotification(base);

    expect(card).toEqual({
      requestId: 'req-1',
      toolName: 'AskUserQuestion',
      summary: 'fallback description',
      answerStyle: 'allow_deny',
    });
  });

  // [nessy-fork] acp-elicitation-ask-user-question: the same question arrives
  // as an ElicitationRequest (AIDT-8203) — same questions shape, no toolName.
  it('maps an elicitation-shaped question to inline options', () => {
    const card = permissionRequestToNotification({
      requestId: 'el-1',
      description: 'Unsafe parameter in ref example',
      questions: [
        {
          question: 'Unsafe parameter in ref example',
          header: 'Ref',
          options: [
            { label: '[Email18]', description: '' },
            { label: '[Email19]', description: '' },
          ],
        },
      ],
    });

    expect(card.answerStyle).toBe('options');
    expect(card.answerKey).toBe('0');
    expect(card.options?.map((o) => o.optionId)).toEqual([
      '[Email18]',
      '[Email19]',
    ]);
  });

  it('refuses inline buttons for multiSelect questionnaires', () => {
    const card = permissionRequestToNotification({
      ...base,
      questions: [
        {
          question: 'Pick many',
          header: 'h',
          multiSelect: true,
          options: [{ label: 'a', description: '' }, { label: 'b', description: '' }],
        },
      ],
    });

    expect(card.answerStyle).toBe('none');
    expect(card.options).toBeUndefined();
  });

  it('refuses inline buttons for multi-question forms', () => {
    const card = permissionRequestToNotification({
      ...base,
      questions: [
        { question: 'q1', header: 'h1', options: [{ label: 'x', description: '' }] },
        { question: 'q2', header: 'h2', options: [{ label: 'y', description: '' }] },
      ],
    });

    expect(card.answerStyle).toBe('none');
    expect(card.summary).toBe('q1');
  });
});

describe('terminalAnswerStyle', () => {
  const update = (over: Partial<PetSessionUpdate>): PetSessionUpdate =>
    ({
      sessionId: 'terminal:s',
      source: 'terminal',
      phase: 'waiting_input',
      controlInputFile: '~/.nessy/ctl/s/input.jsonl',
      ...over,
    }) as PetSessionUpdate;

  it('uses option buttons for terminal pending requests with options', () => {
    expect(
      terminalAnswerStyle(
        update({ options: [{ optionId: 'q0_opt0', name: 'Yes' }] }),
      ),
    ).toBe('options');
  });

  it('falls back to allow/deny for terminal requests without options', () => {
    expect(terminalAnswerStyle(update({}))).toBe('allow_deny');
  });

  it('renders open-in-app when no input channel is advertised', () => {
    // Buttons would silently no-op in answer() — the sidecar predates MR2
    // or the CLI advertised no ctl channel.
    expect(
      terminalAnswerStyle(update({ controlInputFile: undefined })),
    ).toBe('none');
  });

  it('keeps ACP cards display-only even with options', () => {
    expect(
      terminalAnswerStyle(
        update({
          source: 'acp',
          options: [{ optionId: 'q0_opt0', name: 'Yes' }],
        }),
      ),
    ).toBe('none');
  });
});
