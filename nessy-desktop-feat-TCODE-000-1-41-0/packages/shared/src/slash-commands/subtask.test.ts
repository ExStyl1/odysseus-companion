/**
 * R29b Task 1 — the command NAME, pinned.
 *
 * `sub-agents.md:895` splits `/fork` and `/subtask` into two different
 * features: "An in-session fork you start yourself with `/subtask` counts too …
 * A session you create with `/fork` doesn't count; it runs as a separate
 * background session with its own budget. Before v2.1.212, the in-session fork
 * was named `/fork`." Our fork engine is the in-session one, so `/fork` must
 * NOT parse here — accepting it would let the opposite feature's name start
 * this one.
 */
import { describe, expect, it } from 'bun:test';
import { parseSubtaskCommand, SUBTASK_COMMAND_LABEL, SUBTASK_COMMAND_NAME } from './subtask.ts';

describe('parseSubtaskCommand', () => {
  it('is named /subtask, not /fork', () => {
    expect(SUBTASK_COMMAND_NAME).toBe('subtask');
    expect(SUBTASK_COMMAND_LABEL).toBe('/subtask');
    expect(parseSubtaskCommand('/fork draft the tests')).toBeNull();
  });

  it('takes the task text after the command', () => {
    expect(parseSubtaskCommand('/subtask draft unit tests for the parser changes so far'))
      .toEqual({ task: 'draft unit tests for the parser changes so far' });
    expect(parseSubtaskCommand('  /SubTask   try the other approach  '))
      .toEqual({ task: 'try the other approach' });
  });

  it('parses the bare command with an empty task so the caller can say why', () => {
    expect(parseSubtaskCommand('/subtask')).toEqual({ task: '' });
    expect(parseSubtaskCommand('/subtask   ')).toEqual({ task: '' });
  });

  it('does not claim a message that merely mentions the command', () => {
    expect(parseSubtaskCommand('please run /subtask later')).toBeNull();
    expect(parseSubtaskCommand('/subtasks are great')).toBeNull();
  });
});
