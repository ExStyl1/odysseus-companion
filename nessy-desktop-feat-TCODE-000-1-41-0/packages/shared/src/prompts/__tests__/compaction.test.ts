import { describe, expect, it } from 'bun:test';

import {
  COMPACTION_HANDOFF_INSTRUCTIONS,
  COMPACTION_HANDOFF_MARKER,
  COMPACTION_HANDOFF_PROMPT,
  COMPACTION_TRUNCATION_MARKER,
  PROJECT_COMPACT_STEERING_LABEL,
  PROJECT_COMPACT_STEERING_MAX,
  composeProjectCompactSteering,
  extractCompactInstructionsSection,
  withProjectCompactSteering,
} from '../compaction.ts';
import { composePiCompactionInstructions } from '../../agent/pi-harness/prompt-composer.ts';

describe('compaction handoff prompt', () => {
  it('matches the context-checkpoint handoff snapshot', () => {
    // Snapshot the load-bearing handoff contract: checkpoint framing, the
    // progress/decisions/context/next-steps/data structure, concise+structured
    // instruction, no tool calls (summary only).
    expect(COMPACTION_HANDOFF_PROMPT).toMatchSnapshot();
    expect(COMPACTION_HANDOFF_PROMPT).toContain('CONTEXT CHECKPOINT COMPACTION');
    expect(COMPACTION_HANDOFF_PROMPT).toContain('handoff summary for another LLM that will resume');
    expect(COMPACTION_HANDOFF_PROMPT).toContain('Current progress and key decisions');
    expect(COMPACTION_HANDOFF_PROMPT).toContain('constraints, or user preferences');
    expect(COMPACTION_HANDOFF_PROMPT).toContain('What remains to be done');
    expect(COMPACTION_HANDOFF_PROMPT).toContain('critical data, examples, or references');
    expect(COMPACTION_HANDOFF_PROMPT).toContain('Be concise, structured');
  });

  it('marks the produced summary as a prior-model handoff, not user input', () => {
    expect(COMPACTION_HANDOFF_MARKER).toContain('prior-model handoff checkpoint');
    expect(COMPACTION_HANDOFF_MARKER).toContain('not as user input');
    expect(COMPACTION_HANDOFF_INSTRUCTIONS).toBe(
      `${COMPACTION_HANDOFF_PROMPT}\n\n${COMPACTION_HANDOFF_MARKER}`,
    );
  });
});

describe('compaction boundary wiring', () => {
  it('feeds the handoff prompt to the single compaction owner even for a bare manual /compact', () => {
    // SCOPE (K1): this covers the MANUAL `/compact` path only. A bare `/compact`
    // passes no custom instructions and no references, yet the compaction owner
    // must still hand the SDK the checkpoint handoff prompt (marked as a
    // prior-model handoff) rather than nothing. SDK-owned auto-compaction
    // (threshold + overflow) does NOT reach this composer: the Pi SDK hardcodes
    // `customInstructions: undefined` in `_runAutoCompaction` and only honors a
    // full `{compaction}` replacement (never a `{customInstructions}` injection)
    // on `session_before_compact`, so auto-compaction keeps the SDK's own
    // built-in checkpoint summarizer. Recorded limitation, not a wiring gap.
    const instructions = composePiCompactionInstructions(undefined, undefined);
    expect(instructions).toBe(COMPACTION_HANDOFF_INSTRUCTIONS);
    expect(instructions.startsWith('You are performing a CONTEXT CHECKPOINT COMPACTION.')).toBe(true);
    expect(instructions).toContain('prior-model handoff checkpoint');
  });

  it('layers explicit /compact instructions after the handoff prompt', () => {
    const instructions = composePiCompactionInstructions('Focus on the auth refactor', undefined);
    expect(instructions.startsWith(COMPACTION_HANDOFF_INSTRUCTIONS)).toBe(true);
    expect(instructions).toContain('Focus on the auth refactor');
    // Handoff framing precedes the user instructions.
    expect(instructions.indexOf('CONTEXT CHECKPOINT COMPACTION'))
      .toBeLessThan(instructions.indexOf('Focus on the auth refactor'));
  });
});

describe('project `Compact Instructions` steering (P6.54)', () => {
  const instructionResource = (content: string, provenance = 'CLAUDE.md@gen-1') => ({
    kind: 'agent-instruction',
    content,
    provenance,
  });

  it('reads the section the page names, at any level and any casing', () => {
    // `how-claude-code-works.md#when-context-fills-up`: "To control what's
    // preserved during compaction, add a "Compact Instructions" section to
    // CLAUDE.md". The page fixes the NAME and nothing else, so a reader that
    // demanded `##` or exact capitalisation would ignore a correct file.
    expect(extractCompactInstructionsSection('# Compact Instructions\nKeep the migration plan.'))
      .toBe('Keep the migration plan.');
    expect(extractCompactInstructionsSection('#### compact instructions\nKeep the diff.'))
      .toBe('Keep the diff.');
    expect(extractCompactInstructionsSection('## **Compact Instructions** ##\nKeep the plan.'))
      .toBe('Keep the plan.');
  });

  it('ends the section at the next heading of the same or higher level, and keeps its own subsections', () => {
    const body = extractCompactInstructionsSection([
      '# Project',
      '## Compact Instructions',
      'Keep the plan.',
      '### Always',
      'Keep open questions.',
      '## Commands',
      'bun test',
    ].join('\n'));
    expect(body).toBe('Keep the plan.\n### Always\nKeep open questions.');
    expect(body).not.toContain('bun test');
  });

  it('does not read a heading inside a fenced code block', () => {
    // The negative control that matters for an instruction file: these files are
    // full of markdown and shell samples, and a `#` in a fence is not a heading.
    expect(extractCompactInstructionsSection([
      '## Style',
      '```md',
      '## Compact Instructions',
      'this is a sample, not a section',
      '```',
      'prose',
    ].join('\n'))).toBeUndefined();

    // ... and the same fence must not cut a REAL section short.
    expect(extractCompactInstructionsSection([
      '## Compact Instructions',
      'Keep the plan.',
      '```sh',
      '# not a heading',
      'bun test',
      '```',
      'Keep the diff.',
    ].join('\n'))).toContain('Keep the diff.');
  });

  it('returns nothing for a file without the section, or with an empty one', () => {
    expect(extractCompactInstructionsSection('# Project\nSome prose.')).toBeUndefined();
    expect(extractCompactInstructionsSection('## Compact Instructions\n\n## Next')).toBeUndefined();
  });

  it('composes only from instruction files, never from memory or an MCP server', () => {
    const steering = composeProjectCompactSteering([
      instructionResource('## Compact Instructions\nKeep the plan.'),
      { kind: 'context', content: '## Compact Instructions\nfrom a memory file', provenance: 'MEMORY.md@gen-1' },
      { kind: 'prompt', content: '## Compact Instructions\nfrom a server', provenance: 'mcp:evil:prompt:aa@gen-1' },
      { kind: 'agent-instruction', content: '## Compact Instructions\nalso from a server', provenance: 'mcp:evil:prompt:bb@gen-1' },
    ]);
    expect(steering).toContain('Keep the plan.');
    expect(steering).not.toContain('from a memory file');
    expect(steering).not.toContain('from a server');
    expect(steering).toContain(PROJECT_COMPACT_STEERING_LABEL);
  });

  it('joins every instruction file that carries a section, and bounds the total', () => {
    expect(composeProjectCompactSteering([
      instructionResource('## Compact Instructions\nroot rule'),
      instructionResource('## Compact Instructions\nnested rule', 'packages/x/AGENTS.md@gen-1'),
    ])).toContain('root rule\n\nnested rule');

    const oversized = composeProjectCompactSteering([
      instructionResource(`## Compact Instructions\n${'x'.repeat(PROJECT_COMPACT_STEERING_MAX * 2)}`),
    ]);
    expect(oversized).toContain(COMPACTION_TRUNCATION_MARKER);
    expect((oversized ?? '').length)
      .toBeLessThanOrEqual(PROJECT_COMPACT_STEERING_LABEL.length + 2 + PROJECT_COMPACT_STEERING_MAX);
  });

  it('adds the steering to composed instructions and puts standing policy last', () => {
    const composed = composePiCompactionInstructions('Focus on the auth refactor', undefined);
    const steered = withProjectCompactSteering(
      composed,
      [instructionResource('## Compact Instructions\nKeep the migration plan.')],
    ) ?? '';
    expect(steered.startsWith(composed)).toBe(true);
    expect(steered).toContain('Keep the migration plan.');
    // The one-shot focus stays next to the task description; standing policy follows.
    expect(steered.indexOf('Focus on the auth refactor'))
      .toBeLessThan(steered.indexOf('Keep the migration plan.'));
  });

  it('is an ADDITION and never a replacement — absent instructions stay absent', () => {
    // The guard that keeps this row from switching the auto-compaction summary
    // replacement ON for a session that had it off, and from replacing the SDK's
    // default compaction prompt with steering alone on the manual path.
    const resources = [instructionResource('## Compact Instructions\nKeep the plan.')];
    expect(withProjectCompactSteering(undefined, resources)).toBeUndefined();
    expect(withProjectCompactSteering('', resources)).toBe('');
    // Positive control on the same rig: a present base DOES get steered.
    expect(withProjectCompactSteering('base', resources)).toContain('Keep the plan.');
  });

  it('leaves instructions untouched when no instruction file carries the section', () => {
    const composed = composePiCompactionInstructions(undefined, undefined);
    expect(withProjectCompactSteering(composed, [instructionResource('# Project\nprose')])).toBe(composed);
    expect(withProjectCompactSteering(composed, undefined)).toBe(composed);
  });
});
