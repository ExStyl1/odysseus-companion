/**
 * P2.1 — the joins between the advisor's three separately-maintained spellings.
 *
 * `session-tools-core` deliberately has no dependency on `shared`, so the
 * `moment` enum exists in three places: `ADVISOR_MOMENTS` (the vocabulary),
 * `AdvisorConsultSchema` (what Pi and the MCP wire advertise), and the Claude
 * SDK tool's own zod shape. Two of the three could drift silently; this file is
 * where they cannot.
 */
import { describe, expect, it } from 'bun:test';
import {
  SESSION_BACKEND_TOOL_NAMES,
  SESSION_TOOL_REGISTRY,
  AdvisorConsultSchema,
} from '@nessy-agent/session-tools-core';
import { ADVISOR_MOMENTS } from '../advisor.ts';
import { CLAUDE_BACKEND_SESSION_TOOL_NAMES } from '../session-scoped-tools.ts';
import { createAdvisorConsultTool } from '../advisor-consult-tool.ts';

describe('the moment vocabulary is one vocabulary', () => {
  it('the tool schema offers exactly ADVISOR_MOMENTS', () => {
    const schemaMoments = AdvisorConsultSchema.shape.moment.options as readonly string[];
    expect([...schemaMoments].sort()).toEqual([...ADVISOR_MOMENTS].sort());
  });

  it('all three are the documented decision points', () => {
    expect([...ADVISOR_MOMENTS]).toEqual(['approach', 'recurring-error', 'before-done']);
  });

  it('the schema rejects a moment outside the vocabulary', () => {
    expect(AdvisorConsultSchema.safeParse({ moment: 'whenever', question: 'q' }).success).toBe(false);
    expect(AdvisorConsultSchema.safeParse({ moment: 'approach', question: 'q' }).success).toBe(true);
  });

  it('the schema rejects an empty question — a consult with no question is a wasted call', () => {
    expect(AdvisorConsultSchema.safeParse({ moment: 'approach', question: '' }).success).toBe(false);
  });
});

describe('the projection decision', () => {
  it('advisor_consult is a backend tool, allowed by the read-only allowlist (Plan, Don\'t ask), and read-only', () => {
    const def = SESSION_TOOL_REGISTRY.get('advisor_consult');
    expect(def).toBeDefined();
    expect(def!.executionMode).toBe('backend');
    expect(def!.safeMode).toBe('allow');
    expect(def!.readOnly).toBe(true);
    // NOT pi-only: the consult is bound in BaseAgent, so Claude answers it too.
    expect(def!.visibility).toBeUndefined();
  });

  it('the Claude adapter carries every backend tool, advisor_consult included', () => {
    expect(CLAUDE_BACKEND_SESSION_TOOL_NAMES.has('advisor_consult')).toBe(true);
    // The parity assertion the setup-time guardrail makes, made here too so it
    // fails in CI rather than at a user's first Claude turn.
    expect([...SESSION_BACKEND_TOOL_NAMES].filter(name => !CLAUDE_BACKEND_SESSION_TOOL_NAMES.has(name))).toEqual([]);
  });
});

describe('the Claude SDK tool', () => {
  it('answers without a bound consult instead of throwing', async () => {
    const tool = createAdvisorConsultTool({ getConsultFn: () => undefined }) as unknown as {
      handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    const result = await tool.handler({ moment: 'approach', question: 'q' }, {});
    expect(result.content[0]!.text).toContain('not available');
  });

  it('delegates to the bound consult and returns its text verbatim', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = createAdvisorConsultTool({
      getConsultFn: () => async (args) => { calls.push(args); return 'Advisor (m):\n\nadvice'; },
    }) as unknown as {
      handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };
    const result = await tool.handler({ moment: 'before-done', question: 'is it done?' }, {});
    expect(calls).toEqual([{ moment: 'before-done', question: 'is it done?' }]);
    expect(result.content[0]!.text).toBe('Advisor (m):\n\nadvice');
  });
});
