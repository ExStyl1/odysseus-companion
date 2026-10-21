/**
 * The Claude SDK wrapper for `advisor_consult` (P2.1).
 *
 * A thin adapter, exactly like `llm-tool.ts`'s: the schema, the description and
 * the projection decision all live in `session-tools-core/tool-defs.ts`, and the
 * behaviour lives in `BaseAgent.executeAdvisorConsult`. This file exists only
 * because `advisor_consult` is `executionMode: 'backend'` — it needs the
 * agent's own tool-less `queryLlm` route, which no registry handler can reach —
 * and Claude's session tools are in-process SDK tools rather than registry
 * dispatches.
 *
 * The lazy `getConsultFn` mirrors `createLLMTool`'s `getQueryFn`: the tool array
 * is cached per session while the callback registry is rebound per agent
 * lifetime, so resolving at CALL time is what keeps a cached tool pointing at
 * the live agent.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOL_DESCRIPTIONS } from '@nessy-agent/session-tools-core';
import { ADVISOR_MOMENTS, ADVISOR_UNBOUND_REPLY } from './advisor.ts';

export interface AdvisorConsultToolOptions {
  /**
   * Resolved at execution time from the per-session callback registry.
   * Absent means no backend bound the consult — the tool then says so rather
   * than failing, which is the contract its description promises the model.
   */
  getConsultFn: () => ((args: Record<string, unknown>) => Promise<string>) | undefined;
}

export function createAdvisorConsultTool(options: AdvisorConsultToolOptions) {
  return tool(
    'advisor_consult',
    TOOL_DESCRIPTIONS.advisor_consult,
    {
      // The SDK adapter needs the zod v3 shape rather than the canonical
      // schema object; the values are the same three fields, and
      // `advisor-tool-projection.test.ts` pins the moment vocabulary against
      // `ADVISOR_MOMENTS` so the two spellings cannot drift.
      moment: z.enum(ADVISOR_MOMENTS)
        .describe('Which decision point you are at: approach, recurring-error, or before-done'),
      question: z.string().min(1).describe('What you want advice on, stated plainly'),
      context: z.string().optional().describe('Optional extra context: your planned approach, the error, or what you believe is finished'),
    },
    async (args) => {
      const consult = options.getConsultFn();
      if (!consult) {
        return {
          content: [{ type: 'text' as const, text: ADVISOR_UNBOUND_REPLY }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: await consult(args as Record<string, unknown>) }],
      };
    },
    { annotations: { readOnlyHint: true } },
  );
}
