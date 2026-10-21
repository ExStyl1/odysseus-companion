import { describe, expect, it } from 'bun:test';

import { createAskUserTool } from './ask-user-tool.ts';
import { textPartAt } from '../__tests__/support/tool-result-text.ts';

describe('ask_user tool', () => {
  it('round-trips a selected option through the injected transport', async () => {
    const seenRequests: unknown[] = [];
    const tool = createAskUserTool({
      makeRequestId: () => 'ask-1',
      askUser: async (request) => {
        seenRequests.push(request);
        return { type: 'option', value: 'Ship it', optionIndex: 0 };
      },
    });

    const result = await tool.execute('call-1', {
      question: 'Continue?',
      options: ['Ship it', 'Stop'],
      allowFreeText: false,
    }, undefined, undefined, {} as any);

    // No subprocess-side expiry by default: questions never expire unless the
    // user configures askUserQuestionTimeout (settings.md, R7 Task 3).
    expect(seenRequests).toEqual([{
      requestId: 'ask-1',
      question: 'Continue?',
      options: ['Ship it', 'Stop'],
      allowFreeText: false,
    }]);
    expect(textPartAt(result.content)).toContain('Ship it');
    expect(result.details?.answer).toEqual({ type: 'option', value: 'Ship it', optionIndex: 0 });
  });

  it('auto-continues with an away note on an explicit timeout — never a tool error', async () => {
    const tool = createAskUserTool({
      timeoutMs: 5,
      askUser: () => new Promise(() => {}),
    });

    const result = await tool.execute('call-1', {
      question: 'Continue?',
      options: ['Yes', 'No'],
      allowFreeText: false,
    }, undefined, undefined, {} as any);

    expect(result.details?.isError).toBeUndefined();
    expect(result.details?.autoContinued).toBe(true);
    expect(textPartAt(result.content)).toContain('away');
    expect(textPartAt(result.content)).not.toContain('timed out');
  });

  it('returns an error result when aborted', async () => {
    const controller = new AbortController();
    const tool = createAskUserTool({
      timeoutMs: 1000,
      askUser: () => new Promise(() => {}),
    });

    setTimeout(() => controller.abort(), 5);
    const result = await tool.execute('call-1', {
      question: 'Continue?',
      options: ['Yes', 'No'],
      allowFreeText: false,
    }, controller.signal, undefined, {} as any);

    expect(result.details?.isError).toBe(true);
    expect(result.details?.aborted).toBe(true);
    expect(textPartAt(result.content)).toContain('aborted');
  });
});

describe('ask_user batched questions (R7)', () => {
  const twoQuestions = [
    {
      question: 'How should I format the output?',
      header: 'Format',
      options: [
        { label: 'Summary', description: 'Brief overview' },
        { label: 'Detailed', description: 'Full explanation' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which sections should I include?',
      header: 'Sections',
      options: [
        { label: 'Introduction', description: 'Opening context' },
        { label: 'Conclusion', description: 'Final summary' },
      ],
      multiSelect: true,
    },
  ];

  function batchedTool(answer: unknown) {
    return createAskUserTool({
      makeRequestId: () => 'ask-b',
      askUser: async () => answer as never,
    });
  }

  it('rejects out-of-bounds batches: 0 questions, >4 questions, <2 or >4 options, header >12 chars', async () => {
    const tool = batchedTool({ type: 'batched', answers: {} });
    const q = twoQuestions[0]!;
    const fiveQuestions = Array.from({ length: 5 }, (_, i) => ({ ...q, question: `Q${i}?` }));

    for (const [name, questions] of [
      ['empty', []],
      ['five', fiveQuestions],
      ['one option', [{ ...q, options: q.options.slice(0, 1) }]],
      ['five options', [{ ...q, options: Array.from({ length: 5 }, (_, i) => ({ label: `O${i}` })) }]],
      ['long header', [{ ...q, header: 'ThirteenChars' }]],
    ] as const) {
      const result = await tool.execute('call-1', { questions }, undefined, undefined, {} as any);
      expect(result.details?.isError, `expected error for ${String(name)}`).toBe(true);
    }
  });

  it('returns the documented envelope for a single-question batch', async () => {
    const questions = [twoQuestions[0]!];
    const tool = batchedTool({
      type: 'batched',
      answers: { 'How should I format the output?': 'Summary' },
    });
    const result = await tool.execute('call-1', { questions }, undefined, undefined, {} as any);

    expect(result.details?.isError).toBeUndefined();
    // questions echoed verbatim + answers keyed by question TEXT → label
    expect(result.details?.questions).toEqual(questions);
    expect(result.details?.answers).toEqual({ 'How should I format the output?': 'Summary' });
    expect(textPartAt(result.content)).toContain('How should I format the output?');
    expect(textPartAt(result.content)).toContain('Summary');
  });

  it('joins multi-select answers with ", " and carries both questions in the envelope', async () => {
    const tool = batchedTool({
      type: 'batched',
      answers: {
        'How should I format the output?': 'Summary',
        'Which sections should I include?': ['Introduction', 'Conclusion'],
      },
    });
    const result = await tool.execute('call-1', { questions: twoQuestions }, undefined, undefined, {} as any);

    expect(result.details?.questions).toEqual(twoQuestions);
    expect(result.details?.answers).toEqual({
      'How should I format the output?': 'Summary',
      'Which sections should I include?': ['Introduction', 'Conclusion'],
    });
    expect(textPartAt(result.content)).toContain('Introduction, Conclusion');
  });

  it('free-text response replaces the per-question list with neutral wording', async () => {
    const tool = batchedTool({
      type: 'batched',
      answers: {},
      response: 'Wait until Friday, then use the short format.',
    });
    const result = await tool.execute('call-1', { questions: twoQuestions }, undefined, undefined, {} as any);

    expect(result.details?.isError).toBeUndefined();
    expect(result.details?.response).toBe('Wait until Friday, then use the short format.');
    expect(textPartAt(result.content)).toBe('The user responded: Wait until Friday, then use the short format.');
  });

  it('legacy single-question input keeps the legacy answer contract', async () => {
    const seen: unknown[] = [];
    const tool = createAskUserTool({
      makeRequestId: () => 'ask-legacy',
      askUser: async (request) => {
        seen.push(request);
        return { type: 'option', value: 'Ship it', optionIndex: 0 };
      },
    });
    const result = await tool.execute('call-1', {
      question: 'Continue?',
      options: ['Ship it', 'Stop'],
      allowFreeText: false,
    }, undefined, undefined, {} as any);

    expect((seen[0] as { questions?: unknown }).questions).toBeUndefined();
    expect(textPartAt(result.content)).toContain('Ship it');
    expect(result.details?.answer).toEqual({ type: 'option', value: 'Ship it', optionIndex: 0 });
  });
});
