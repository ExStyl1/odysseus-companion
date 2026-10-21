/**
 * P6.314 (H34), claude arm — the operator's subagent-prompt append reaches the
 * child on the runtime's OWN flag.
 *
 * The row's native clause said the SDK path composes agent prompts itself, so
 * the host had to be the seam. That is right for Pi and wrong for claude:
 * `Options.extraArgs` is "Additional CLI arguments to pass to Claude Code. Keys
 * are argument names (without --)", and `append-subagent-system-prompt` scores
 * 5 lines / 6 occurrences in the vendored 2.1.247 binary (its own identifier
 * `appendSubagentSystemPrompt` 15/51) against a fabricated control at 0/0 —
 * re-measured 2026-09-12 (C3.252), both instruments named because they disagree
 * on a minified artefact (C3.294); the superseded reading was "7 … 24" at
 * 2.1.233. So this is native-first step 1, not step 2.
 */
import { describe, expect, it } from 'bun:test';

import { buildClaudeSubagentPromptAppendArgs } from '../claude-agent.ts';
import {
  SUBAGENT_PROMPT_APPEND_ENV_VAR,
  resolveSubagentPromptAppend,
} from '../../config/subagent-prompt-append.ts';

describe('P6.314 · the append rides claude\'s own flag', () => {
  it('positive — the operator\'s text becomes the flag the binary publishes', () => {
    expect(buildClaudeSubagentPromptAppendArgs('Prefer small diffs.')).toEqual({
      extraArgs: { 'append-subagent-system-prompt': 'Prefer small diffs.' },
    });
  });

  it('negative — an unset knob leaves the spawn byte-identical', () => {
    // Not `{ extraArgs: {} }`: an empty record is still an option the SDK
    // reads, and "absent" is the state this fork's other builders promise.
    expect(buildClaudeSubagentPromptAppendArgs(undefined)).toEqual({});
    expect(buildClaudeSubagentPromptAppendArgs('')).toEqual({});
  });

  it('reads the SAME host knob the Pi arm does, so one setting drives both', () => {
    // The variable name is ours because the binary publishes no environment
    // spelling; the point of the shared reader is that the two runtimes cannot
    // drift onto two names.
    const env = { [SUBAGENT_PROMPT_APPEND_ENV_VAR]: '  Delegate narrowly.  ' };
    expect(buildClaudeSubagentPromptAppendArgs(resolveSubagentPromptAppend(env))).toEqual({
      extraArgs: { 'append-subagent-system-prompt': 'Delegate narrowly.' },
    });
    // A blank value is an accident, not a request to append nothing.
    expect(buildClaudeSubagentPromptAppendArgs(
      resolveSubagentPromptAppend({ [SUBAGENT_PROMPT_APPEND_ENV_VAR]: '   ' }),
    )).toEqual({});
  });
});
