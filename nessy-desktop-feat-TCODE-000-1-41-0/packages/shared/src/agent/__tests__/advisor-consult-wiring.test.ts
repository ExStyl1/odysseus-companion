/**
 * P2.1 — the consult as WIRED, not as a pure function.
 *
 * `advisor.test.ts` proves the packaging and the gate in isolation. This file
 * proves the three things only the wiring can be wrong about:
 *  1. a consult actually reaches the `call_llm` transport (`queryLlm`) with the
 *     conversation, the advisor system prompt and the RESOLVED model;
 *  2. the settings key and the managed allowlist are honoured at the tool seam,
 *     not merely available to it;
 *  3. every refusal is a readable answer rather than a thrown turn.
 *
 * The storage and allowlist modules are mocked with a SPREAD and restored in
 * `afterAll` — a bare `mock.module` amputates the module for every later test
 * file in the process, permanently.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import * as realStorage from '../../config/storage.ts';
import * as realManagedModels from '../../config/managed-models.ts';

/**
 * Capture the four replaced functions BEFORE the mock is installed.
 *
 * `mock.module` mutates the live module namespace, so by the time `afterAll`
 * runs, `realStorage` IS the mocked namespace — restoring by spreading it
 * re-installs the mocks and leaks them into every later test file in the
 * process. Measured: `backend/__tests__/factory.test.ts` fails on a substituted
 * `getLlmConnections` when it runs after this file, and passes alone.
 */
const originals = {
  getAdvisorEnabled: realStorage.getAdvisorEnabled,
  getAdvisorModelId: realStorage.getAdvisorModelId,
  setAdvisorEnabled: realStorage.setAdvisorEnabled,
  getLlmConnections: realStorage.getLlmConnections,
  isManagedModelSelectable: realManagedModels.isManagedModelSelectable,
};

let advisorEnabled = true;
let advisorModel = '';
let allowedModels: string[] | null = null; // null = the allowlist permits everything
let connectionModels: Array<{ id: string }> = [];
let setEnabledCalls: boolean[] = [];

mock.module('../../config/storage.ts', () => ({
  ...realStorage,
  getAdvisorEnabled: () => advisorEnabled,
  getAdvisorModelId: () => advisorModel,
  setAdvisorEnabled: (value: boolean) => { setEnabledCalls.push(value); advisorEnabled = value; },
  getLlmConnections: () => [{ slug: 'test-connection', models: connectionModels }],
}));

mock.module('../../config/managed-models.ts', () => ({
  ...realManagedModels,
  isManagedModelSelectable: (modelId: string) => allowedModels === null || allowedModels.includes(modelId),
}));

afterAll(() => {
  mock.module('../../config/storage.ts', () => ({
    ...realStorage,
    getAdvisorEnabled: originals.getAdvisorEnabled,
    getAdvisorModelId: originals.getAdvisorModelId,
    setAdvisorEnabled: originals.setAdvisorEnabled,
    getLlmConnections: originals.getLlmConnections,
  }));
  mock.module('../../config/managed-models.ts', () => ({
    ...realManagedModels,
    isManagedModelSelectable: originals.isManagedModelSelectable,
  }));
});

const { TestAgent, createMockBackendConfig } = await import('./test-utils.ts');
const { ADVISOR_SYSTEM_PROMPT } = await import('../advisor.ts');
const { parseSessionCommand } = await import('../../slash-commands/session-command.ts');

function agent(overrides: Record<string, unknown> = {}) {
  return new TestAgent(createMockBackendConfig({
    connectionSlug: 'test-connection',
    ...overrides,
  }) as never);
}

const consultArgs = { moment: 'approach', question: 'rewrite the parser or patch it?' };

/**
 * P2.421 — two ids the page's pairing table actually ranks, because the gate
 * binds only where BOTH sides rank. `advisor.md#choose-an-advisor-model` lists
 * Opus 4.7-or-later accepting "Fable, and Opus 4.7 or later", so a Sonnet 4.6
 * advisor under an Opus 5 main is a REFUSED pairing rather than an unranked one.
 */
const WEAK_ADVISOR = 'claude-sonnet-4-6';
const STRONG_SESSION_MODEL = 'claude-opus-5';

beforeEach(() => {
  advisorEnabled = true;
  advisorModel = '';
  allowedModels = null;
  connectionModels = [{ id: 'test-model' }, { id: 'big-model' }];
  setEnabledCalls = [];
});

afterEach(() => {
  // The mocked `setAdvisorEnabled` writes the module-scope flag; reset so a
  // toggling test cannot leak into the next one.
  advisorEnabled = true;
});

describe('a consult reaches the transport with the conversation', () => {
  it('sends the transcript, the advisor system prompt and the session model', async () => {
    const instance = agent({
      getAdvisorTranscript: () => [
        { kind: 'user', content: 'fix the flaky test' },
        { kind: 'tool', name: 'Bash', input: '{"command":"bun test"}', result: 'FAIL a.test.ts', isError: true },
      ],
    });
    instance.queryLlmOutcome = { text: 'Check the shared fixture before rewriting.' };

    const reply = await instance.executeAdvisorConsultForTest(consultArgs);

    expect(instance.queryLlmCalls).toHaveLength(1);
    const request = instance.queryLlmCalls[0]!;
    expect(request.systemPrompt).toBe(ADVISOR_SYSTEM_PROMPT);
    expect(request.model).toBe('test-model');
    expect(request.prompt).toContain('User: fix the flaky test');
    expect(request.prompt).toContain('Tool Bash');
    expect(request.prompt).toContain('error: FAIL a.test.ts');
    expect(request.prompt).toContain('rewrite the parser or patch it?');
    expect(reply).toContain('Check the shared fixture before rewriting.');
  });

  it('degrades to the recovery messages when no host bound a transcript', async () => {
    const instance = agent({
      getRecoveryMessages: () => [{ type: 'user', content: 'only prose here' }],
    });
    await instance.executeAdvisorConsultForTest(consultArgs);
    expect(instance.queryLlmCalls[0]!.prompt).toContain('User: only prose here');
  });

  it('uses the configured advisor model instead of the session model', async () => {
    advisorModel = 'big-model';
    const instance = agent();
    await instance.executeAdvisorConsultForTest(consultArgs);
    expect(instance.queryLlmCalls[0]!.model).toBe('big-model');
  });
});

describe('the gates are honoured at the tool seam', () => {
  it('a disabled advisor never reaches the transport', async () => {
    advisorEnabled = false;
    const instance = agent();
    const reply = await instance.executeAdvisorConsultForTest(consultArgs);
    expect(instance.queryLlmCalls).toHaveLength(0);
    expect(reply).toContain('turned off');
  });

  it('an allowlist that forbids the configured model never reaches the transport', async () => {
    advisorModel = 'big-model';
    allowedModels = ['test-model'];
    const instance = agent();
    const reply = await instance.executeAdvisorConsultForTest(consultArgs);
    expect(instance.queryLlmCalls).toHaveLength(0);
    expect(reply).toContain('managed model allowlist');
  });

  it('a configured model outside the connection catalog never reaches the transport', async () => {
    advisorModel = 'absent-model';
    const instance = agent();
    const reply = await instance.executeAdvisorConsultForTest(consultArgs);
    expect(instance.queryLlmCalls).toHaveLength(0);
    expect(reply).toContain('not available on this connection');
  });

  it('an advisor weaker than the session model is refused IN ITS OWN WORDS, not as "no model"', async () => {
    advisorModel = WEAK_ADVISOR;
    connectionModels = [{ id: WEAK_ADVISOR }, { id: STRONG_SESSION_MODEL }];
    const instance = agent();
    instance.setModel(STRONG_SESSION_MODEL);

    const reply = await instance.executeAdvisorConsultForTest(consultArgs);

    expect(instance.queryLlmCalls).toHaveLength(0);
    // The STRING a model reads, asserted whole — the enum is an implementation
    // detail and pinning it would survive the exact regression this guards:
    // mapping `refused-capability` back onto `no-model` binds identically and
    // misexplains identically.
    expect(reply).toBe(
      "The configured advisor model is not as capable as this session's model, so the advisor is unavailable. Continue on your own.",
    );
    expect(reply).not.toContain('No advisor model is available');
  });

  it('still says NO MODEL when there really is none — the two refusals stay distinguishable', async () => {
    // The negative control for the row above. Nothing configured and no session
    // model to fall back to, so this is the case `no-model` is FOR.
    const instance = agent();
    instance.setModel('');
    const reply = await instance.executeAdvisorConsultForTest(consultArgs);
    expect(instance.queryLlmCalls).toHaveLength(0);
    expect(reply).toContain('No advisor model is available');
    expect(reply).not.toContain('not as capable');
  });

  // Positive control for the five rows above: with the same fixtures and no
  // refusal, the transport IS reached — so "0 calls" is the gate working.
  it('an enabled, permitted, entitled model does reach the transport', async () => {
    advisorModel = 'big-model';
    allowedModels = ['big-model'];
    const instance = agent();
    await instance.executeAdvisorConsultForTest(consultArgs);
    expect(instance.queryLlmCalls).toHaveLength(1);
  });
});

describe('a consult never breaks the turn', () => {
  it('a thrown transport becomes a readable answer, not an exception', async () => {
    const instance = agent();
    instance.queryLlmOutcome = new Error('gateway 429');
    const reply = await instance.executeAdvisorConsultForTest(consultArgs);
    expect(reply).toContain('could not answer');
    expect(reply).toContain('gateway 429');
  });

  it('an empty advisor reply is reported rather than passed through', async () => {
    const instance = agent();
    instance.queryLlmOutcome = { text: '   ' };
    const reply = await instance.executeAdvisorConsultForTest(consultArgs);
    expect(reply).toContain('could not answer');
  });

  it('a malformed tool call is refused before any transport call', async () => {
    const instance = agent();
    // Empty question, missing moment, and a moment outside the vocabulary —
    // the last would otherwise render the literal "undefined" as the decision
    // point in the prompt.
    expect(await instance.executeAdvisorConsultForTest({ moment: 'approach', question: '  ' }))
      .toContain('needs a non-empty');
    expect(await instance.executeAdvisorConsultForTest({ question: 'q' }))
      .toContain('needs a non-empty');
    expect(await instance.executeAdvisorConsultForTest({ moment: 'whenever', question: 'q' }))
      .toContain('needs a non-empty');
    expect(instance.queryLlmCalls).toHaveLength(0);
  });
});

describe('the /advisor session command', () => {
  it('parses the three accepted forms and nothing else', () => {
    expect(parseSessionCommand('/advisor')).toEqual({ kind: 'advisor', action: 'status' });
    expect(parseSessionCommand('/advisor on')).toEqual({ kind: 'advisor', action: 'on' });
    expect(parseSessionCommand('/advisor OFF')).toEqual({ kind: 'advisor', action: 'off' });
    // Prose, not a command — the model owns it.
    expect(parseSessionCommand('/advisor use opus')).toBeNull();
    expect(parseSessionCommand('tell me about /advisor')).toBeNull();
  });

  it('the bare form reports without toggling', async () => {
    const instance = agent();
    const events = [];
    for await (const event of instance.describeAdvisorForTest('status')) events.push(event);
    expect(setEnabledCalls).toEqual([]);
    expect(events[0]).toMatchObject({ type: 'info' });
  });

  it('off then on writes the setting both ways', async () => {
    const instance = agent();
    for await (const _ of instance.describeAdvisorForTest('off')) { /* drain */ }
    expect(setEnabledCalls).toEqual([false]);
    for await (const _ of instance.describeAdvisorForTest('on')) { /* drain */ }
    expect(setEnabledCalls).toEqual([false, true]);
  });

  it('reports a refused model as a warning rather than as "on"', async () => {
    advisorModel = 'big-model';
    allowedModels = ['test-model'];
    const instance = agent();
    const events = [];
    for await (const event of instance.describeAdvisorForTest('status')) events.push(event);
    expect(events[0]).toMatchObject({ type: 'info', level: 'warning' });
  });

  /**
   * P2.421 · `advisor.md#choose-an-advisor-model`: "If the advisor is less
   * capable than the main model, the advisor is not attached to the main
   * model's requests. The `/advisor` command output and a notification show
   * this." So the page names THIS surface, and the arm that was missing let it
   * fall through to `statusNoModel`.
   *
   * The two rendered lines are compared against EACH OTHER rather than against
   * an English sentence: `describeAdvisor` is i18n'd, the process-wide i18next
   * singleton may already have been initialized in another language by an
   * earlier file, and the invariant that matters — a refusal does not read as
   * "nothing is configured" — holds in every locale.
   */
  it('names the capability refusal in /advisor output instead of borrowing the no-model line', async () => {
    advisorModel = WEAK_ADVISOR;
    connectionModels = [{ id: WEAK_ADVISOR }, { id: STRONG_SESSION_MODEL }];
    const refused = agent();
    refused.setModel(STRONG_SESSION_MODEL);
    const refusedEvents = [];
    for await (const event of refused.describeAdvisorForTest('status')) refusedEvents.push(event);

    advisorModel = '';
    const none = agent();
    none.setModel('');
    const noModelEvents = [];
    for await (const event of none.describeAdvisorForTest('status')) noModelEvents.push(event);

    expect(refusedEvents[0]).toMatchObject({ type: 'info', level: 'warning' });
    const refusedMessage = (refusedEvents[0] as { message: string }).message;
    const noModelMessage = (noModelEvents[0] as { message: string }).message;
    expect(refusedMessage).not.toBe(noModelMessage);
    // The refusal names the model that was refused; the no-model line cannot.
    expect(refusedMessage).toContain(WEAK_ADVISOR);
    expect(noModelMessage).not.toContain(WEAK_ADVISOR);
  });
});
