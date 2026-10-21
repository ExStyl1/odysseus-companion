/**
 * P6.515 — one operator append, three runtimes, three slots, append only.
 *
 * The cases below are written against the SECTION BUILDER and the three call
 * sites' source, and that split is deliberate. The builder is where "absent
 * means byte-identical" and "the block is fenced and says it does not replace"
 * are decidable; whether the block actually REACHES each runtime is a property
 * of three different files, and a unit test of the builder cannot see a missing
 * call — which is the exact failure two other rows in this wave were reopened
 * for.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SYSTEM_PROMPT_APPEND_HEADING,
  SYSTEM_PROMPT_APPEND_PREAMBLE,
  resolveSystemPromptAppend,
  systemPromptAppendSection,
} from '../system-prompt-append.ts';
import { getSystemPromptAppend } from '../../config/storage.ts';
import { bracedRegion } from '../../testing/source-regions.ts';

describe('systemPromptAppendSection (P6.515)', () => {
  it('fences the operator text and says, to the model, that it does not replace', () => {
    const section = systemPromptAppendSection('Always cite the file you changed.');
    expect(section).toContain(SYSTEM_PROMPT_APPEND_HEADING);
    expect(section).toContain('Always cite the file you changed.');
    // The preamble is part of the block rather than documentation: it is the
    // only thing that makes "append, not replace" legible to the model reading
    // it, and the owner decision (Q-den 46, option 2) is append only.
    expect(section).toContain(SYSTEM_PROMPT_APPEND_PREAMBLE);
    expect(SYSTEM_PROMPT_APPEND_PREAMBLE).toContain('do not replace');
    // The heading precedes the text, so an operator cannot hide their block by
    // writing their own heading first.
    expect(section.indexOf(SYSTEM_PROMPT_APPEND_HEADING))
      .toBeLessThan(section.indexOf('Always cite the file you changed.'));
  });

  it('is EMPTY for every shape of nothing, so an unset install composes the same bytes', () => {
    // The boundary. An install that never set this must produce byte-identical
    // prompt bytes to one built before the row, and an all-whitespace value is
    // an empty heading with nothing under it — worse than no heading at all.
    for (const value of ['', '   ', '\n\t\n']) {
      expect(systemPromptAppendSection(value)).toBe('');
      expect(resolveSystemPromptAppend(value)).toBeUndefined();
    }
    // ...and the stored value on a test rig is unset, so the production default
    // is the same empty string. This is also the control for the case above:
    // without it a passing assertion could mean "the setting happened to be
    // empty" rather than "an empty value produces nothing".
    expect(getSystemPromptAppend()).toBeUndefined();
    expect(systemPromptAppendSection()).toBe('');
  });

  it('trims, so surrounding blank lines cannot push the block apart', () => {
    expect(resolveSystemPromptAppend('  house rules  ')).toBe('house rules');
    expect(systemPromptAppendSection('\n\nhouse rules\n\n')).toContain('\n\nhouse rules\n');
  });
});

describe('the three slots exist — a builder with no call site reaches no model', () => {
  const read = (...parts: string[]) => readFileSync(join(import.meta.dir, '..', '..', ...parts), 'utf8');

  it('is composed into the Pi + claude prompt, LAST', () => {
    // One site serves two runtimes: `getSystemPrompt` IS Pi's base system
    // prompt (`pi-agent.ts`) and IS the `append` claude hands the `claude_code`
    // preset (`claude-agent.ts`), so a single call reaches both with no
    // call-site change on either.
    const source = read('prompts', 'system.ts');
    expect(source).toContain('systemPromptAppendSection()');
    // LAST is the precedence rule, not layout: a later block cannot delete an
    // earlier one, so the safety and engineering sections are always earlier.
    // Asserted on the template's own order rather than on prose.
    expect(source).toContain('${debugContext}${systemPromptAppendSection()}`');
  });

  it('is composed into codex\'s developerInstructions, LAST', () => {
    // Codex never calls `getSystemPrompt` at all, so it needs its own line —
    // and `developerInstructions` is its one additive channel to the main model.
    const source = read('agent', 'codex-agent.ts');
    const at = source.indexOf('export function codexDeveloperInstructions(');
    expect(at).toBeGreaterThan(-1);
    // D1.111 — the function's own braces rather than 3 000 characters.
    const body = bracedRegion(source, at);
    // BOUNDARY CONTROL: the region is this function and nothing after it, so
    // the ORDER assertion below is about one body. (`endsWith('}')` would be a
    // tautology here — a brace-matched region always does.)
    expect(body).not.toContain('\nexport function buildCodexContextWindowWarning(');
    expect(body).toContain('systemPromptAppendSection()');
    // After the output style, which is itself last among the pre-existing
    // parts — so the operator block is the final push before the join.
    expect(body.indexOf('if (style) parts.push(style)'))
      .toBeLessThan(body.indexOf('parts.push(operatorAppend)'));
  });

  it('offers the appending flags and refuses the replacing pair BY NAME', () => {
    // The row's own words: the refusal must be named where a reader looks for
    // `cli-reference`'s flag. All four flag names are in the module header, with
    // the page's own one-line descriptions, so a reader who came for
    // `--system-prompt` finds an answer rather than an absence to interpret.
    const source = read('prompts', 'system-prompt-append.ts');
    for (const flag of [
      '--system-prompt',
      '--system-prompt-file',
      '--append-system-prompt',
      '--append-system-prompt-file',
    ]) {
      expect(source).toContain(flag);
    }
    expect(source).toContain('Replaces the entire default prompt');
    expect(source).toContain('refuses the top half by name');
    // The negative control that gives the assertion its meaning: no replacing
    // key exists to read anywhere. `systemPromptAppend` is the only setting, and
    // a `systemPromptReplace` would be the thing this row refused to build.
    const storage = read('config', 'storage.ts');
    expect(storage).toContain('getSystemPromptAppend');
    expect(storage).not.toContain('systemPromptReplace');
    expect(source).not.toContain('systemPromptReplace');
  });
});
