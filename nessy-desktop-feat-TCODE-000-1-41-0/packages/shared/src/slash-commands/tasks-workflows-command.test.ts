/**
 * D1.14 / D1.37 · `/tasks` and `/workflows` are classified, and prose that
 * merely starts with either token still belongs to the model.
 *
 * ## Why the negative is the case that matters
 *
 * `RS-46` measured both tokens on the packaged 1.39.0 reaching the MODEL as
 * prose — no palette row, no dispatch — so the ABSENCE these rows close is
 * real. The hazard of closing it is the opposite one: a parser row written as a
 * prefix test would swallow every question that begins with the word, which is
 * the failure `session-command-out-of-band-seam.test.ts` pins for the older
 * kinds. `/tasks now` is the exact sentence `RS-46` drove as its control, so the
 * negative here is a measured sentence rather than an invented one.
 *
 * ## And the eighteen that were already there
 *
 * The third case is not decoration. Adding a kind to a classifier whose arms are
 * ordered `if` tests can shadow a sibling — `/tasks` sits between `/branch` and
 * `/help` — and a suite that only asserted the two new kinds would be green over
 * a table that had lost one. It asserts the kind of every token the parser
 * answered before these two, derived from the union rather than from a count in
 * prose (AGENTS.md §Traps: a number beside a list ages silently; this repo has
 * already recorded "eight" for a table that returns eighteen).
 */
import { describe, expect, it } from 'bun:test';
import { parseSessionCommand, type ParsedSessionCommand } from './session-command.ts';

describe('D1.14 · /tasks and /workflows are session commands', () => {
  it('classifies the bare token, on its own, for both', () => {
    expect(parseSessionCommand('/tasks')).toEqual({ kind: 'tasks' });
    // D1.247 — the bare token is the LISTING, which is upstream's own sense of
    // the name. The default matters more than the spelling: a user who meant
    // `stop` and got a listing presses again, where the reverse cannot be undone.
    expect(parseSessionCommand('/workflows')).toEqual({ kind: 'workflows', action: 'list' });
    // Trimmed and case-insensitive like every sibling row, so a composer that
    // sends a trailing newline and a user who shouts are the same command.
    expect(parseSessionCommand('  /TASKS  ')).toEqual({ kind: 'tasks' });
    expect(parseSessionCommand('/Workflows\n')).toEqual({ kind: 'workflows', action: 'list' });
  });

  it('D1.247 · only the literal `stop` selects the all-stop', () => {
    expect(parseSessionCommand('/workflows stop')).toEqual({ kind: 'workflows', action: 'stop' });
    expect(parseSessionCommand('  /WORKFLOWS   STOP  ')).toEqual({ kind: 'workflows', action: 'stop' });
    // The boundary, and it is the one that matters: every near miss falls back
    // to the LISTING or to the model, never to the aggregate. `/workflows
    // stopped` is a word that merely begins with the verb; `/workflows please
    // stop` is prose; `/workflows stop now` carries a trailing word, which is
    // this classifier's whole-message rule.
    expect(parseSessionCommand('/workflows stopped')).toBeNull();
    expect(parseSessionCommand('/workflows please stop')).toBeNull();
    expect(parseSessionCommand('/workflows stop now')).toBeNull();
  });

  it('leaves a token with a trailing word to the model, both ways round', () => {
    // `RS-46`'s own control sentence.
    expect(parseSessionCommand('/tasks now')).toBeNull();
    expect(parseSessionCommand('/workflows for the release')).toBeNull();
    // And the prefix direction: a longer command name must not be eaten by the
    // shorter row sitting above it.
    expect(parseSessionCommand('/tasksomething')).toBeNull();
    expect(parseSessionCommand('/workflowsomething')).toBeNull();
    // Prose that merely MENTIONS them is a prompt, which is the whole-message
    // rule this classifier is built on.
    expect(parseSessionCommand('remind me what /tasks and /workflows do')).toBeNull();
  });

  it('answers every token it answered before, unchanged', () => {
    // The kinds that existed before D1.14, each with the shortest input that
    // produces it. A row shadowed by one of the two new tests fails HERE rather
    // than in whichever feature notices months later.
    type Kind = ParsedSessionCommand['kind'];
    const before: ReadonlyArray<readonly [string, Kind]> = [
      ['/compact', 'compact'],
      ['/subtask draft the tests', 'subtask'],
      ['/clear', 'clear'],
      ['/btw', 'btw'],
      ['/recap', 'recap'],
      ['/heapdump', 'heapdump'],
      ['/quota', 'quota'],
      ['/advisor', 'advisor'],
      ['/approve', 'approve'],
      ['/branch', 'branch'],
      ['/help', 'help'],
      ['/mcp', 'mcp'],
      ['/diff', 'diff'],
      ['/hooks', 'hooks'],
      ['/status', 'status'],
      ['/config', 'config'],
      ['/resume', 'resume'],
      ['/cd /tmp', 'cd'],
    ];
    expect(before.map(([input]) => parseSessionCommand(input)?.kind ?? null))
      .toEqual(before.map(([, kind]) => kind));
    // Positive control for the two directions above: the set really does carry
    // eighteen DISTINCT kinds, so a table that collapsed two rows onto one kind
    // cannot pass by having the right length.
    expect(new Set(before.map(([, kind]) => kind)).size).toBe(before.length);
  });
});
