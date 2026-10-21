import { afterEach, describe, expect, it } from 'bun:test';

import { setDeferredToolSummaryNames, withDeferredToolSummary } from './deferred-tool-summary.ts';
import { setSubagentCatalogue } from './subagent-catalogue.ts';

// F1.1262 — the host prompt the Pi model reads names the agents the subagent tool can run, as Claude's Agent tool
// lists its agent types. Driven through `withDeferredToolSummary`, the one seam index.ts applies the prompt through.

afterEach(() => {
  setSubagentCatalogue([]);
  setDeferredToolSummaryNames([]);
});

describe('F1.1262: the subagent catalogue reaches the model', () => {
  it('lists each agent by name and one-line description, sorted, beside the deferred-tool summary', () => {
    setDeferredToolSummaryNames(['review']);
    setSubagentCatalogue([
      { name: 'one-turn', description: 'Answers in\n  exactly one turn.' },
      { name: 'auditor', description: 'Reviews security.' },
      { name: 'fork', description: 'reserved', fork: true },
    ]);
    const prompt = withDeferredToolSummary('HOST PROMPT');
    expect(prompt.startsWith('HOST PROMPT\n\n<deferred-tools>')).toBe(true);
    expect(prompt).toContain([
      '<available-subagents>',
      'Besides its built-in agents, the subagent tool can run these agents; pass the name as `agent`.',
      '- auditor: Reviews security.',
      '- one-turn: Answers in exactly one turn.',
      '</available-subagents>',
    ].join('\n'));
  });

  it('is bounded: 30 agents, 200-character descriptions, and a count of the rest', () => {
    setSubagentCatalogue(Array.from({ length: 33 }, (_, index) => ({
      name: `agent-${String(index).padStart(2, '0')}`,
      description: 'x'.repeat(500),
    })));
    const prompt = withDeferredToolSummary('P');
    expect(prompt.match(/^- agent-/gm)).toHaveLength(30);
    expect(prompt).toContain(`- agent-00: ${'x'.repeat(199)}…\n`);
    expect(prompt).toContain('(3 more not listed.)');
  });

  it('CONTROL: no agent (or no subagent tool) leaves the prompt exactly as before', () => {
    expect(withDeferredToolSummary('HOST PROMPT')).toBe('HOST PROMPT');
    setSubagentCatalogue([{ name: 'fork', description: 'reserved', fork: true }]);
    expect(withDeferredToolSummary('HOST PROMPT')).toBe('HOST PROMPT');
  });
});
