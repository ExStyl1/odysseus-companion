/**
 * P3.158 · `/help` is answered from OUR command table, once, with the marks the
 * seam can actually decide.
 *
 * The defect this replaces: `parseSessionCommand` had no `help` kind, so a
 * typed `/help` composed an ordinary turn and asked the MODEL — on every
 * runtime. Offered everywhere, implemented nowhere, and invisible to the
 * per-runtime enumeration that found it, because a check for divergence cannot
 * see a gap that is the same on all three.
 *
 * These tests hold two things the row is about: the listing is COMPLETE
 * (a command missing from it is undocumented), and a mark is written only where
 * the runtime genuinely cannot serve the row. The companion
 * `apps/electron/.../__tests__/slash-command-help-table.test.ts` diffs this
 * table against the composer menu so the two cannot drift.
 */
import { describe, expect, it } from 'bun:test';
import {
  HELP_COMMAND_LABEL,
  PERMISSION_MODE_HELP_LINE,
  SESSION_COMMAND_HELP_ENTRIES,
  SESSION_COMMAND_HELP_UNTOLD_LINE,
  SESSION_COMMAND_TERMINAL_ONLY_PREFIX,
  formatSessionCommandHelp,
} from './help.ts';
import { parseSessionCommand } from './session-command.ts';

const CAN_EVERYTHING = { canForkConversation: true, canCompactContext: true };
const CAN_NOTHING = { canForkConversation: false, canCompactContext: false };

describe('P3.158 · the /help table', () => {
  it('claims /help as a session command, whole-message only', () => {
    // The half that stops the model being asked. Without it every assertion
    // below describes a listing nobody can reach.
    expect(parseSessionCommand('/help')).toEqual({ kind: 'help' });
    expect(parseSessionCommand('  /HELP  ')).toEqual({ kind: 'help' });
    // `/help compact` is a request about compaction, not this command.
    expect(parseSessionCommand('/help compact')).toBeNull();
    expect(parseSessionCommand('what does /help do?')).toBeNull();
  });

  it('lists itself, so the answer names the command that produced it', () => {
    expect(SESSION_COMMAND_HELP_ENTRIES.some(entry => entry.label === HELP_COMMAND_LABEL)).toBe(true);
  });

  it('gives every row a label that starts with a slash and a non-empty summary', () => {
    expect(SESSION_COMMAND_HELP_ENTRIES.length).toBeGreaterThan(0);
    for (const entry of SESSION_COMMAND_HELP_ENTRIES) {
      expect(entry.label.startsWith('/')).toBe(true);
      expect(entry.summary.trim().length).toBeGreaterThan(0);
      expect(entry.summary.endsWith('.')).toBe(true);
    }
  });

  it('has no duplicate label and no duplicate menu id', () => {
    const labels = SESSION_COMMAND_HELP_ENTRIES.map(entry => entry.label);
    expect(new Set(labels).size).toBe(labels.length);
    const ids = SESSION_COMMAND_HELP_ENTRIES.map(entry => entry.id).filter((id): id is string => id !== null);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks nothing on a runtime that can serve every row', () => {
    const listing = formatSessionCommandHelp(CAN_EVERYTHING);
    expect(listing).not.toContain('unavailable on this runtime');
    // Positive control: the rows the mark would attach to are present.
    expect(listing).toContain('/compact');
    expect(listing).toContain('/subtask');
  });

  it('marks exactly the two rows the seam can decide, and no others', () => {
    const marked = formatSessionCommandHelp(CAN_NOTHING)
      .split('\n')
      .filter(line => line.includes('unavailable on this runtime'));

    expect(marked.length).toBe(2);
    expect(marked.some(line => line.includes('/compact'))).toBe(true);
    expect(marked.some(line => line.includes('/subtask'))).toBe(true);
  });

  it('marks each capability independently, so one false does not mark the other row', () => {
    const forkOnly = formatSessionCommandHelp({ canForkConversation: true, canCompactContext: false });
    const compactOnly = formatSessionCommandHelp({ canForkConversation: false, canCompactContext: true });

    const markedIn = (listing: string) => listing
      .split('\n')
      .filter(line => line.includes('unavailable on this runtime'))
      .map(line => line.trim().split(/\s+/)[0]);

    expect(markedIn(forkOnly)).toEqual(['/compact']);
    expect(markedIn(compactOnly)).toEqual(['/subtask']);
  });

  it('separates what the session answers from what the app answers, and says so', () => {
    // The distinction is the question a user asking for help actually has —
    // what happens when I type this — and it is also where the residue lives: a
    // `composer` row typed into a surface that is not the desktop composer
    // reaches the model as prose.
    const listing = formatSessionCommandHelp(CAN_EVERYTHING);
    expect(listing).toContain('never reach the model');
    expect(listing).toContain('reach no runtime');
    expect(listing).toContain(PERMISSION_MODE_HELP_LINE);
  });

  it('is plain text with no unresolved i18n key, on a runtime with no i18n initialised', () => {
    // The seam's answers are deliberate literals: the headless `nessy-server`
    // entry never calls `setupI18n()` and an uninitialised `t()` returns
    // `undefined`, which renders as an empty info line — indistinguishable from
    // a command that did nothing. This asserts the listing cannot have that
    // failure mode.
    const listing = formatSessionCommandHelp(CAN_NOTHING);
    expect(listing).not.toContain('undefined');
    // A dotted i18n key that failed to resolve would read as `chat.help.body`;
    // nothing in the listing may look like one.
    expect(listing).not.toMatch(/[a-z]+\.[a-z]+\.[a-zA-Z]+/);
  });
});

describe('P3.298 · the connection\'s own withdrawals reach the listing', () => {
  // The defect: `resolveComposerCapabilities` withdraws `/quota` off the Nessy
  // gateway and `/btw`+`/recap` on the remote agent, from a provider+connection
  // pair `chat()` is never handed — so the MENU knew and the listing did not.
  // One resolved field, read by both, is the fix; these hold the listing half.
  const markedIn = (listing: string, mark: string): string[] => listing
    .split('\n')
    .filter(line => line.includes(mark))
    .map(line => line.trim().split(/\s+/)[0] as string);

  it('marks a withdrawn command, and with the CONNECTION sentence, not the runtime one', () => {
    const listing = formatSessionCommandHelp({ ...CAN_EVERYTHING, excludedCommandIds: ['quota'] });

    expect(markedIn(listing, 'unavailable on this connection')).toEqual(['/quota']);
    // The two causes stay distinguishable: switching runtime does not restore
    // a budget the connection does not publish.
    expect(listing).not.toContain('unavailable on this runtime');
  });

  it('marks the remote agent\'s pair, both of which are composer rows', () => {
    const listing = formatSessionCommandHelp({ ...CAN_EVERYTHING, excludedCommandIds: ['btw', 'recap'] });

    expect(markedIn(listing, 'unavailable on this connection').sort()).toEqual(['/btw', '/recap']);
  });

  it('lets a withdrawal outrank the seam predicate on the SAME row', () => {
    // `/compact` is `availability: 'compact'`. A connection that withdraws it
    // must not be reported as a runtime limitation.
    const listing = formatSessionCommandHelp({ ...CAN_EVERYTHING, excludedCommandIds: ['compact'] });

    expect(markedIn(listing, 'unavailable on this connection')).toEqual(['/compact']);
    expect(markedIn(listing, 'unavailable on this runtime')).toEqual([]);
  });

  it('cannot withdraw a row that has no menu id', () => {
    // `/rewind` and `/heapdump` carry `id: null`; an id-keyed array can never
    // name them, and a stray string must not accidentally match.
    const listing = formatSessionCommandHelp({ ...CAN_EVERYTHING, excludedCommandIds: ['rewind', 'heapdump', ''] });

    expect(listing).not.toContain('unavailable on this connection');
  });

  it('says it was not told when the field is absent, and stops saying it when it is present', () => {
    // The honest distinction: `undefined` is "nobody told me", `[]` is
    // "nothing is withdrawn". Conflating them is how a listing goes silently
    // from a caveat to a false claim.
    expect(formatSessionCommandHelp(CAN_EVERYTHING)).toContain(SESSION_COMMAND_HELP_UNTOLD_LINE);
    expect(formatSessionCommandHelp({ ...CAN_EVERYTHING, excludedCommandIds: [] }))
      .not.toContain(SESSION_COMMAND_HELP_UNTOLD_LINE);
    expect(formatSessionCommandHelp({ ...CAN_EVERYTHING, excludedCommandIds: ['quota'] }))
      .not.toContain(SESSION_COMMAND_HELP_UNTOLD_LINE);
  });
});

describe('P6.410 · the runtime\'s own terminal-bound commands', () => {
  // The SDK publishes `terminal_slash_commands` — *"Subset of slash_commands
  // whose UX is bound to the local terminal (e.g. exit, statusline)"* — and it
  // was read by nothing. The names are NOT this product's commands, so they can
  // never be marks on the rows above; they are counter-examples to the listing's
  // own closing sentence, which invites the user to type anything else.

  it('names them, slashed, after the sentence they qualify', () => {
    const listing = formatSessionCommandHelp({
      ...CAN_EVERYTHING,
      excludedCommandIds: [],
      // Five that the vendored bundle actually tags `terminalOriented:!0`, used
      // as a REALISTIC fixture only — the module hard-codes no list. Re-read at
      // the vendored 2.1.247 on 2026-09-12 (C3.252): all five are still tagged,
      // and the tag now scores 8 lines / 15 occurrences there, so "the five" is
      // no longer the whole set and this comment no longer says it is.
      runtimeTerminalCommandNames: ['color', 'exit', 'reload-plugins', 'statusline', 'doctor'],
    });

    expect(listing).toContain(SESSION_COMMAND_TERMINAL_ONLY_PREFIX);
    expect(listing).toContain('/color, /exit, /reload-plugins, /statusline, /doctor.');
    // Last line, immediately after the "anything else beginning with /" claim
    // it exists to qualify — a warning printed before its subject is noise.
    const lines = listing.split('\n');
    expect(lines[lines.length - 1]?.startsWith(SESSION_COMMAND_TERMINAL_ONLY_PREFIX)).toBe(true);
    expect(lines[lines.length - 2]).toContain('Anything else beginning with "/"');
  });

  it('stays silent on a runtime that publishes no such class, and on an empty one', () => {
    // Pi and codex set nothing; the SDK sends the field only when non-empty, so
    // absent and empty are ONE upstream state and must print one thing here.
    // A line printed for either would be a warning about nothing.
    expect(formatSessionCommandHelp(CAN_EVERYTHING)).not.toContain(SESSION_COMMAND_TERMINAL_ONLY_PREFIX);
    expect(formatSessionCommandHelp({ ...CAN_EVERYTHING, runtimeTerminalCommandNames: [] }))
      .not.toContain(SESSION_COMMAND_TERMINAL_ONLY_PREFIX);
  });

  it('does not turn a runtime command into a mark on one of ours', () => {
    // The failure this guards is the tempting one: `exit`/`doctor` reaching the
    // `excludedCommandIds` path and marking a row of OUR table as withdrawn.
    const listing = formatSessionCommandHelp({
      ...CAN_EVERYTHING,
      excludedCommandIds: [],
      runtimeTerminalCommandNames: ['help', 'clear', 'config'],
    });

    expect(listing).not.toContain('unavailable on this connection');
    expect(listing).not.toContain('unavailable on this runtime');
    expect(listing).toContain('/help, /clear, /config.');
  });
});
