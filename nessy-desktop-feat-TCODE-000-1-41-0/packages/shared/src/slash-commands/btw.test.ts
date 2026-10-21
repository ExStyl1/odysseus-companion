/**
 * R36 — the `/btw` name and its one behavioural difference from `/subtask`.
 *
 * `interactive-mode.md:374`: "To return to the overlay after dismissing it, run
 * `/btw` with no question. The overlay reopens on your most recent exchange."
 * The bare form is a documented REOPEN, not a usage error — the exact opposite
 * of `/subtask`'s empty-arg handling — so the bare-command case here asserts a
 * successful parse, and a caller that reports usage for it is wrong.
 */
import { describe, expect, it } from 'bun:test';
import { BTW_COMMAND_LABEL, BTW_COMMAND_NAME, parseBtwCommand } from './btw.ts';

describe('parseBtwCommand', () => {
  it('is named /btw', () => {
    expect(BTW_COMMAND_NAME).toBe('btw');
    expect(BTW_COMMAND_LABEL).toBe('/btw');
  });

  it('takes the question text after the command', () => {
    expect(parseBtwCommand('/btw what was the name of that config file again?'))
      .toEqual({ question: 'what was the name of that config file again?' });
    expect(parseBtwCommand('  /BTW   which port does the gateway use  '))
      .toEqual({ question: 'which port does the gateway use' });
  });

  it('parses the bare command with an empty question (reopen, not a usage error)', () => {
    expect(parseBtwCommand('/btw')).toEqual({ question: '' });
    expect(parseBtwCommand('/btw   ')).toEqual({ question: '' });
  });

  it('does not claim a message that merely mentions the command', () => {
    expect(parseBtwCommand('please use /btw for quick questions')).toBeNull();
    expect(parseBtwCommand('/btwhat')).toBeNull();
  });
});
