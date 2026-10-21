// UB6.9 — rebased from craft-agents-oss `v0.15.1:packages/shared/src/automations/semantic-condition.test.ts`
// (Apache-2.0), plus this fork's two arms: the skipped entry carries the "yes"
// probability as a structured field (so the timeline can localise the reason),
// and the deterministic-first control — through the real PromptHandler, a
// matcher whose `conditions` fail produces no prompt at all, so no downstream
// consumer has anything to ask the decision model about.

import { describe, expect, it, jest } from 'bun:test';
import { AutomationMatcherSchema } from './schemas.ts';
import { createPromptHistoryEntry } from './webhook-utils.ts';
import { WorkspaceEventBus } from './event-bus.ts';
import { PromptHandler } from './handlers/prompt-handler.ts';
import type { AutomationsConfigProvider, PromptHandlerOptions } from './handlers/types.ts';
import type { AutomationEvent, AutomationMatcher, PendingPrompt } from './types.ts';

const base = { actions: [{ type: 'prompt', prompt: 'x' }] };

describe('semanticCondition schema', () => {
  it('accepts a question with an optional threshold', () => {
    expect(AutomationMatcherSchema.safeParse({ ...base, semanticCondition: { question: 'Is it a bug?' } }).success).toBe(true);
    expect(AutomationMatcherSchema.safeParse({ ...base, semanticCondition: { question: 'Is it a bug?', threshold: 0.8 } }).success).toBe(true);
  });

  it('rejects empty questions, thresholds outside (0, 1] and unknown keys', () => {
    expect(AutomationMatcherSchema.safeParse({ ...base, semanticCondition: { question: '  ' } }).success).toBe(false);
    expect(AutomationMatcherSchema.safeParse({ ...base, semanticCondition: { question: 'q', threshold: 0 } }).success).toBe(false);
    expect(AutomationMatcherSchema.safeParse({ ...base, semanticCondition: { question: 'q', threshold: 1.5 } }).success).toBe(false);
    expect(AutomationMatcherSchema.safeParse({ ...base, semanticCondition: { question: 'q', pattern: 'x' } }).success).toBe(false);
  });
});

describe('prompt history', () => {
  it('records a skipped run as skipped, not as an error', () => {
    const entry = createPromptHistoryEntry({ matcherId: 'abc123', ok: true, prompt: 'p', skipped: 'condition not met' });
    expect(entry).toMatchObject({ id: 'abc123', ok: true, skipped: 'condition not met' });
    expect(entry.error).toBeUndefined();
  });

  it('carries the semantic-condition probability as a structured field, and omits it otherwise', () => {
    // UB6.9 — the timeline localises the reason from the number instead of
    // parsing the stored English line.
    const semantic = createPromptHistoryEntry({ matcherId: 'abc123', ok: true, prompt: 'p', skipped: 'condition not met ("yes" probability 0.42)', skippedProbability: 0.42 });
    expect(semantic.skippedProbability).toBe(0.42);
    const guard = createPromptHistoryEntry({ matcherId: 'abc123', ok: true, prompt: 'p', skipped: 'the event is about a session this automation created (loop guard)' });
    expect(guard.skippedProbability).toBeUndefined();
  });
});

describe('deterministic conditions gate before any model call', () => {
  async function drive(matcher: AutomationMatcher, payload: { label: string }): Promise<PendingPrompt[]> {
    const bus = new WorkspaceEventBus('test-workspace');
    const configProvider: AutomationsConfigProvider = {
      getConfig: () => ({ automations: { LabelAdd: [matcher] } }),
      getMatchersForEvent: (event: AutomationEvent) => (event === 'LabelAdd' ? [matcher] : []),
    };
    const options: PromptHandlerOptions = { sessionId: 'test-session' };
    const onPromptsReady = jest.fn();
    const handler = new PromptHandler({ ...options, onPromptsReady }, configProvider);
    try {
      handler.subscribe(bus);
      // The bus emission awaits its async subscribers (the same contract the
      // existing prompt-handler tests rely on), so the prompts are built here.
      await bus.emit('LabelAdd', { workspaceId: 'test-workspace', timestamp: Date.now(), ...payload });
      return onPromptsReady.mock.calls[0]?.[0] as PendingPrompt[] ?? [];
    } finally {
      handler.dispose();
      bus.dispose();
    }
  }

  it('a matching deterministic condition yields the prompt, carrying the semantic condition', async () => {
    const prompts = await drive({
      semanticCondition: { question: 'Is it a crash report?', threshold: 0.7 },
      conditions: [{ condition: 'state', field: 'label', value: 'bug' }],
      actions: [{ type: 'prompt', prompt: 'Triage' }],
    }, { label: 'bug' });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.semanticCondition).toEqual({ question: 'Is it a crash report?', threshold: 0.7 });
    expect(prompts[0]!.event).toBe('LabelAdd');
  });

  it('a failing deterministic condition yields no prompt — nothing exists to ask the model about', async () => {
    const prompts = await drive({
      semanticCondition: { question: 'Is it a crash report?' },
      conditions: [{ condition: 'state', field: 'label', value: 'bug' }],
      actions: [{ type: 'prompt', prompt: 'Triage' }],
    }, { label: 'not-bug' });
    expect(prompts).toHaveLength(0);
  });
});
