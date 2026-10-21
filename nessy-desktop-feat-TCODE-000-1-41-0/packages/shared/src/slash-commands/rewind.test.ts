/**
 * `/rewind` — the documented OPENER (P2.425).
 *
 * `checkpointing.md#rewind-and-summarize`: "Run `/rewind`, or press `Esc` twice
 * when the prompt input is empty, to open the rewind menu."
 *
 * The negative arm is the load-bearing one. This command has no argument, so
 * every extra word is prose: a parser that accepted `/rewind that last edit`
 * would silently swallow a real prompt and open a menu instead of answering it.
 */
import { describe, expect, it } from 'bun:test';
import { REWIND_COMMAND_LABEL, parseRewindCommand } from './rewind.ts';
import { parseSessionCommand } from './session-command.ts';

describe('parseRewindCommand', () => {
  it('parses the bare command, with surrounding whitespace and in any case', () => {
    expect(parseRewindCommand('/rewind')).toEqual({ kind: 'rewind' });
    expect(parseRewindCommand('  /rewind  ')).toEqual({ kind: 'rewind' });
    expect(parseRewindCommand('/REWIND')).toEqual({ kind: 'rewind' });
    expect(parseRewindCommand(REWIND_COMMAND_LABEL)).toEqual({ kind: 'rewind' });
  });

  it('refuses anything that is not the whole message', () => {
    // Arguments: the menu takes its target by SELECTION, not by argument, so
    // trailing words are a prompt the user wants answered.
    expect(parseRewindCommand('/rewind that last edit')).toBeNull();
    expect(parseRewindCommand('/rewind 3')).toBeNull();
    // A mention inside a sentence is prose.
    expect(parseRewindCommand('can I use /rewind here?')).toBeNull();
    expect(parseRewindCommand('tell me about /rewind')).toBeNull();
    // Near-misses that must not open a menu.
    expect(parseRewindCommand('/rewinds')).toBeNull();
    expect(parseRewindCommand('rewind')).toBeNull();
    expect(parseRewindCommand('')).toBeNull();
  });

  it('stays OUT of the session-command classifier', () => {
    // `/rewind` is answered in the renderer and reaches no backend. Every
    // consumer of `parseSessionCommand` is a send-path seam with no arm for it,
    // so a hit here would be a silent behaviour change in files this command
    // does not own. Positive control on the same call: `/clear` IS one.
    expect(parseSessionCommand('/rewind')).toBeNull();
    expect(parseSessionCommand('/clear')).toEqual({ kind: 'clear' });
  });
});
