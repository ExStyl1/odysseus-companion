/**
 * GRANT-GLOB-NEWLINE — the separator in the hook env-file preamble is a
 * PERMISSION control, and nothing at the join used to say so.
 *
 * The coupling spans three files and no two of them are neighbours:
 *
 * 1. `config/sandbox-settings.ts` `globMatches` compiles `*` to `.*` with no `s`
 *    flag, so a pattern cannot cross a line terminator.
 * 2. `server-core/src/pi-harness/process-supervisor.ts`
 *    `resolveIsolationDowngrade` matches the user's `sandbox.excludedCommands`
 *    globs against `[command, ...args].join(' ')`.
 * 3. `automations/hook-env-file.ts` `withHookEnvFileShellSource` mints that
 *    string, and joins the preamble with `;`/space rather than a newline
 *    SPECIFICALLY so (1) keeps matching.
 *
 * So a tidy-up nobody would question — "why semicolons? a newline reads better"
 * — silently turns off every `*docker*`-style sandbox exclusion, for exactly the
 * users who bothered to configure one. This file is the thing that stops it.
 *
 * Two deliberate choices, both of which the sibling suite got wrong in ways that
 * would have gone green either way:
 *
 * - The compiler is IMPORTED, never copied. `agent/__tests__/hook-env-file-channel.test.ts`
 *   restates `globMatches` locally, which makes it a test double that stays green
 *   whatever the real compiler does. Here `matchExcludedCommand` is the shipped
 *   function, so this suite tracks the decision instead of a snapshot of it.
 * - Every terminator is a LITERAL character. A test written with `'\n'` in a
 *   normal string is testing the two-character escape, which matched all along
 *   and therefore proves nothing; the first assertion below nails that down.
 */
import { describe, expect, it } from 'bun:test';
import { matchExcludedCommand } from '../config/sandbox-settings.ts';
import {
  HOOK_ENV_FILE_CHILD_ENV_KEY,
  HOOK_ENV_FILE_SOURCE_PREAMBLE,
  withHookEnvFileShellSource,
} from './hook-env-file.ts';

/** The four terminators `.` refuses without the `s` flag. */
const LF = String.fromCharCode(0x0a);
const CR = String.fromCharCode(0x0d);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const TERMINATORS = [LF, CR, LINE_SEPARATOR, PARAGRAPH_SEPARATOR];

const FILE_PATH = '/tmp/nessy-hook-env/env.sh';

/** Exactly what `ProcessSupervisor.resolveIsolationDowngrade` judges. */
function supervisorCommandLine(modelCommand: string): string {
  const start = withHookEnvFileShellSource(
    { semanticId: 'bash', command: '/bin/sh', args: ['-lc', modelCommand] },
    FILE_PATH,
  );
  if (!start) throw new Error('the production seam refused a start it must rewrite');
  return ['/bin/sh', ...start.args].join(' ').trim();
}

describe('GRANT-GLOB-NEWLINE: the preamble separator keeps sandbox exclusions matching', () => {
  it('tests literal terminators, not the two-character escape that matched all along', () => {
    expect(LF).toHaveLength(1);
    expect(LF).not.toBe(String.raw`\n`);
    // The escape has always matched, so a suite written with it is green on a
    // broken compiler. This is the positive control for every case below.
    expect(matchExcludedCommand(String.raw`docker run\nx`, ['*docker*'])).toBe('*docker*');
  });

  it('mints a preamble with no line terminator in it', () => {
    for (const terminator of TERMINATORS) {
      expect(HOOK_ENV_FILE_SOURCE_PREAMBLE).not.toContain(terminator);
    }
    // The `;` is the workaround. If it ever becomes a newline the assertion above
    // fires here rather than as a silently disabled sandbox exclusion in the field.
    expect(HOOK_ENV_FILE_SOURCE_PREAMBLE).toContain(';');
  });

  it('joins the preamble to the model command without a line terminator', () => {
    const line = supervisorCommandLine('docker ps');
    for (const terminator of TERMINATORS) {
      expect(line).not.toContain(terminator);
    }
    // The path travels as a child env value, so the judged string carries no
    // per-session variation either.
    expect(line).not.toContain(FILE_PATH);
    const start = withHookEnvFileShellSource(
      { semanticId: 'bash', command: '/bin/sh', args: ['-lc', 'docker ps'] },
      FILE_PATH,
    );
    expect(start?.env[HOOK_ENV_FILE_CHILD_ENV_KEY]).toBe(FILE_PATH);
  });

  it('keeps a `*docker*` exclusion matching through the REAL compiler', () => {
    expect(matchExcludedCommand(supervisorCommandLine('docker ps'), ['*docker*'])).toBe('*docker*');
    expect(matchExcludedCommand(supervisorCommandLine('docker compose up -d'), ['*docker*'])).toBe('*docker*');
  });

  it('shows the failure the separator is dodging, so the pin above is not vacuous', () => {
    // The SAME line with the space swapped for each terminator. Every one of these
    // stops matching, which is precisely the silent breakage a tidy-up would ship.
    for (const terminator of TERMINATORS) {
      const tidied = ['/bin/sh', '-lc', `${HOOK_ENV_FILE_SOURCE_PREAMBLE}${terminator}docker ps`].join(' ');
      expect(matchExcludedCommand(tidied, ['*docker*'])).toBeUndefined();
    }
  });

  it('is unaffected when the channel is off, so an unconfigured session pays nothing', () => {
    // No file path: the seam refuses the rewrite and the model's line is judged raw.
    expect(withHookEnvFileShellSource(
      { semanticId: 'bash', command: '/bin/sh', args: ['-lc', 'docker ps'] },
      undefined,
    )).toBeUndefined();
    expect(matchExcludedCommand('/bin/sh -lc docker ps', ['*docker*'])).toBe('*docker*');
  });
});
