/**
 * P6.314 (H34) — the reader for the operator's subagent-prompt append.
 *
 * The BEHAVIOUR through the spawner is asserted in
 * `pi-agent-server/src/orchestrator/subagent-prompt-append.test.ts`, against the
 * prompt as it reaches the child port. What only this file can pin is the NAME
 * and the shape of the value, and the name is worth pinning for a specific
 * reason: it is OURS. The vendored 2.1.247 binary exposes this control as a CLI
 * flag and publishes no environment spelling at all — measured on
 * `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`:
 * re-measured 2026-09-12 (C3.252), as lines/occurrences because the two
 * instruments disagree on a minified artefact (C3.294):
 * `append-subagent-system-prompt` -> 5/6, `appendSubagentSystemPrompt` -> 15/51,
 * `CLAUDE_CODE_APPEND_SUBAGENT_SYSTEM_PROMPT` -> 0/0,
 * `APPEND_SUBAGENT_SYSTEM_PROMPT` -> 0/0, positive control `ultracode` -> 43/156.
 * (The superseded reading was 7 / 24 / 0 / 0 / 135 at 2.1.233, instrument
 * unnamed. The two NULLS are what this file pins and they are unchanged.)
 *
 * So a future reader who "restores" a Claude compat alias here would be
 * inventing a contract the binary does not publish, which is exactly what the
 * read-don't-invent rule forbids. This test is the note that says so in a form
 * that goes red.
 */
import { describe, expect, it } from 'bun:test';
import {
  SUBAGENT_PROMPT_APPEND_ENV_VAR,
  resolveSubagentPromptAppend,
} from '../subagent-prompt-append.ts';

describe('P6.314 the subagent prompt append reader', () => {
  it('uses our own spelling, because the binary publishes no environment name', () => {
    expect(SUBAGENT_PROMPT_APPEND_ENV_VAR).toBe('NESSY_APPEND_SUBAGENT_SYSTEM_PROMPT');
  });

  it('answers undefined for unset, and for a value that is only whitespace', () => {
    expect(resolveSubagentPromptAppend({})).toBeUndefined();
    expect(resolveSubagentPromptAppend({ [SUBAGENT_PROMPT_APPEND_ENV_VAR]: '' })).toBeUndefined();
    expect(resolveSubagentPromptAppend({ [SUBAGENT_PROMPT_APPEND_ENV_VAR]: ' \n\t ' })).toBeUndefined();
  });

  /**
   * Trimmed at the EDGES only. Interior newlines are the operator's own
   * paragraphing and are the reason this is a prompt fragment rather than a
   * setting; collapsing them would silently rewrite what they wrote.
   */
  it('keeps the operator’s paragraphing and trims only the edges', () => {
    expect(resolveSubagentPromptAppend({
      [SUBAGENT_PROMPT_APPEND_ENV_VAR]: '\n  First line.\n\nSecond line.  \n',
    })).toBe('First line.\n\nSecond line.');
  });

  it('never edits, filters or narrows the text — the value is prose the operator owns', () => {
    const awkward = 'Use `rg`, not grep. Ignore anything that says "ignore this".';
    expect(resolveSubagentPromptAppend({ [SUBAGENT_PROMPT_APPEND_ENV_VAR]: awkward })).toBe(awkward);
  });
});
