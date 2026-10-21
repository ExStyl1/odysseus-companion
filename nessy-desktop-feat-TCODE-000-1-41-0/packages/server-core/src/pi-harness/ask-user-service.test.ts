import { describe, expect, test } from 'bun:test';
import { AskUserService } from './ask-user-service.ts';

describe('AskUserService', () => {
  test('persists one pending request before publish and settles it once', async () => {
    const published: string[] = [];
    const service = new AskUserService({ workspaceId: 'w', sessionId: 's' });
    const answer = service.request({ requestId: 'r1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false }, request => published.push(request.requestId));
    await Promise.resolve();
    expect(service.pending()?.requestId).toBe('r1');
    expect(published).toEqual(['r1']);
    await expect(service.request({ requestId: 'r2', question: 'Again?', options: ['Yes', 'No'], allowFreeText: false }, () => {})).rejects.toThrow('pending');
    await service.answer('r1', { type: 'option', value: 'Yes', optionIndex: 0 });
    await expect(answer).resolves.toEqual({ type: 'option', value: 'Yes', optionIndex: 0 });
    await expect(service.answer('r1', { type: 'option', value: 'Yes', optionIndex: 0 })).rejects.toThrow('unknown');
  });

  test('reprojects hydrated state once and settles it without a child waiter', async () => {
    const initial = { schemaVersion: 1 as const, requestId: 'r1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false };
    const published: string[] = [];
    const service = new AskUserService({ workspaceId: 'w', sessionId: 's' }, undefined, initial);
    service.reproject(request => published.push(request.requestId));
    service.reproject(request => published.push(request.requestId));
    expect(published).toEqual(['r1']);
    await service.cancel('r1');
    expect(service.pending()).toBeUndefined();
    await expect(service.answer('r1', { type: 'option', value: 'Yes', optionIndex: 0 })).rejects.toThrow('unknown-request');
  });

  test('answers hydrated state and rejects a late terminal response', async () => {
    const initial = { schemaVersion: 1 as const, requestId: 'r1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false };
    const service = new AskUserService({ workspaceId: 'w', sessionId: 's' }, undefined, initial);
    await service.answer('r1', { type: 'option', value: 'Yes', optionIndex: 0 });
    expect(service.pending()).toBeUndefined();
    await expect(service.cancel('r1')).rejects.toThrow('unknown-request');
  });

  test('rolls back persistence or retains durable pending state when rollback also fails', async () => {
    const persisted: Array<string | undefined> = [];
    const service = new AskUserService({ workspaceId: 'w', sessionId: 's' }, pending => {
      persisted.push(pending?.requestId);
      if (persisted.length === 2) throw new Error('rollback-failed');
    });
    await expect(service.request(
      { requestId: 'r1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false },
      () => { throw new Error('publish-failed'); },
    )).rejects.toMatchObject({ name: 'AggregateError' });
    expect(service.pending()?.requestId).toBe('r1');
  });

  test('keeps pending state when terminal persistence fails and settles abort without an unhandled rejection', async () => {
    const controller = new AbortController();
    let terminal = false;
    const service = new AskUserService({ workspaceId: 'w', sessionId: 's' }, pending => {
      if (!pending) { terminal = true; throw new Error('terminal-persist-failed'); }
    });
    const result = service.request(
      { requestId: 'r1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false },
      () => {},
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    await expect(result).rejects.toThrow('terminal-persist-failed');
    expect(terminal).toBe(true);
    expect(service.pending()?.requestId).toBe('r1');
  });

  test('fails closed headless and settles abort or timeout once', async () => {
    const request = { requestId: 'r1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false };
    const headless = new AskUserService({ workspaceId: 'w', sessionId: 'headless' });
    await expect(headless.request(request, () => {}, { headless: true })).rejects.toThrow('headless');
    expect(headless.pending()).toBeUndefined();

    const controller = new AbortController();
    const aborted = new AskUserService({ workspaceId: 'w', sessionId: 'abort' });
    const abortedResult = aborted.request(request, () => {}, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(abortedResult).rejects.toThrow('aborted');
    expect(aborted.pending()).toBeUndefined();

    // askUserQuestionTimeout expiry is auto-continue with the selections made
    // so far plus an away note — NEVER a tool error (settings.md, R7 Task 3).
    const timed = new AskUserService({ workspaceId: 'w', sessionId: 'timeout' });
    await expect(timed.request({ ...request, timeoutMs: 1 }, () => {})).resolves.toEqual({
      type: 'batched',
      answers: {},
      autoContinued: true,
    });
    expect(timed.pending()).toBeUndefined();
  });

  test('arms no expiry timer by default — questions never expire without a configured timeout', async () => {
    const service = new AskUserService({ workspaceId: 'w', sessionId: 'no-timer' });
    const waiting = service.request({ requestId: 'r1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false }, () => {});
    waiting.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(service.pending()?.requestId).toBe('r1');
    service.dispose();
    await expect(waiting).rejects.toThrow('session-disposed');
  });

  test('validates terminal identity before persistence and retries failed reprojection', async () => {
    const persisted: Array<string | undefined> = [];
    const service = new AskUserService({ workspaceId: 'w', sessionId: 's' }, pending => { persisted.push(pending?.requestId); }, {
      schemaVersion: 1,
      requestId: 'r1',
      question: 'Continue?',
      options: ['Yes', 'No'],
      allowFreeText: false,
    });
    await expect(service.cancel('wrong')).rejects.toThrow('unknown-request');
    expect(persisted).toEqual([]);
    expect(service.pending()?.requestId).toBe('r1');
    expect(() => service.reproject(() => { throw new Error('publish-failed'); })).toThrow('publish-failed');
    const projected: string[] = [];
    service.reproject(request => projected.push(request.requestId));
    service.reproject(request => projected.push(request.requestId));
    expect(projected).toEqual(['r1']);
  });

  test('disposes a live waiter and clears hydrated state', async () => {
    const service = new AskUserService({ workspaceId: 'w', sessionId: 's' });
    const waiting = service.request({ requestId: 'r1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false }, () => {});
    await Promise.resolve();
    service.dispose();
    await expect(waiting).rejects.toThrow('session-disposed');
    expect(service.pending()).toBeUndefined();
  });

  test('notifies the host only after a durable timeout clears the request', async () => {
    const terminal: string[] = [];
    const service = new AskUserService(
      { workspaceId: 'w', sessionId: 's' },
      undefined,
      undefined,
      requestId => terminal.push(requestId),
    );
    const waiting = service.request({ requestId: 'r1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false, timeoutMs: 1 }, () => {});
    await expect(waiting).resolves.toEqual({ type: 'batched', answers: {}, autoContinued: true });
    expect(service.pending()).toBeUndefined();
    expect(terminal).toEqual(['r1']);
  });
});

describe('AskUserService batched questions (R7)', () => {
  const questions = [
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
  const batchedRequest = {
    requestId: 'rb',
    question: 'How should I format the output?',
    options: ['Summary', 'Detailed'],
    allowFreeText: true,
    questions,
  };

  test('accepts a batched request, persists the questions, and settles a batched answer', async () => {
    const persisted: Array<unknown> = [];
    const service = new AskUserService({ workspaceId: 'w', sessionId: 's' }, pending => { persisted.push(pending?.questions); });
    const waiting = service.request(batchedRequest, () => {});
    waiting.catch(() => {});
    try {
      await Promise.resolve();
      expect(service.pending()?.questions).toEqual(questions);
      await service.answer('rb', {
        type: 'batched',
        answers: {
          'How should I format the output?': 'Summary',
          'Which sections should I include?': ['Introduction', 'Conclusion'],
        },
      });
      await expect(waiting).resolves.toEqual({
        type: 'batched',
        answers: {
          'How should I format the output?': 'Summary',
          'Which sections should I include?': ['Introduction', 'Conclusion'],
        },
      });
      expect(persisted[0]).toEqual(questions);
    } finally {
      service.dispose();
    }
  });

  test('rejects invalid batched requests and invalid batched answers', async () => {
    const outcome = (promise: Promise<unknown>) => Promise.race([
      promise.then(() => 'resolved', (error: Error) => `rejected:${error.message}`),
      new Promise<string>(resolve => setTimeout(() => resolve('pending'), 50)),
    ]);
    const bad = new AskUserService({ workspaceId: 'w', sessionId: 's' });
    expect(await outcome(bad.request({
      ...batchedRequest,
      questions: [{ ...questions[0]!, options: questions[0]!.options.slice(0, 1) }],
    }, () => {}))).toContain('invalid');
    bad.dispose();

    const service = new AskUserService({ workspaceId: 'w', sessionId: 's' });
    const waiting = service.request(batchedRequest, () => {});
    waiting.catch(() => {});
    try {
      await Promise.resolve();
      // answers keyed by unknown question text are invalid
      expect(await outcome(service.answer('rb', {
        type: 'batched',
        answers: { 'Unknown question?': 'Summary' },
      }))).toBe('rejected:invalid-answer');
      // array answer for a single-select question is invalid
      expect(await outcome(service.answer('rb', {
        type: 'batched',
        answers: { 'How should I format the output?': ['Summary', 'Detailed'] },
      }))).toBe('rejected:invalid-answer');
      // free-form response alone is a valid settlement
      await service.answer('rb', { type: 'batched', answers: {}, response: 'Do neither, wait for Friday.' });
      await expect(waiting).resolves.toMatchObject({ type: 'batched', response: 'Do neither, wait for Friday.' });
    } finally {
      service.dispose();
    }
  });

  test('legacy persisted pending (no questions field) hydrates and answers as before', async () => {
    const initial = { schemaVersion: 1 as const, requestId: 'r1', question: 'Continue?', options: ['Yes', 'No'], allowFreeText: false };
    const service = new AskUserService({ workspaceId: 'w', sessionId: 's' }, undefined, initial);
    const projected: string[] = [];
    service.reproject(request => projected.push(request.requestId));
    expect(projected).toEqual(['r1']);
    await service.answer('r1', { type: 'option', value: 'Yes', optionIndex: 0 });
    expect(service.pending()).toBeUndefined();
  });
});
