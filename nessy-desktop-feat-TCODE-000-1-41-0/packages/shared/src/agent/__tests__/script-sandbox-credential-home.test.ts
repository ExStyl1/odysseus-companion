/**
 * F1.191 (origin WJ-k P-WJk-1, MEDIUM) — the host half: `createClaudeContext`,
 * the one factory the claude and Pi runtimes build their session-tool context
 * from, hands `script_sandbox` the LATCHED home for its credential floor.
 *
 * `session-tools-core` depends on nothing in `@nessy-agent/shared`, so the
 * handler cannot call `latchedHomeDir()` itself; it reads
 * `SessionToolContext.credentialHomeDir` and falls back to the live
 * `os.homedir()` only when a context supplies nothing. The handler half is
 * `session-tools-core/src/handlers/script-sandbox-read-floor.test.ts`, which
 * drives a real sandboxed child against a fake creds file.
 *
 * ## The instrument: the LATCH moves, not `HOME`
 *
 * Under `bun test` writing `process.env.HOME` moves `os.homedir()` not at all
 * (P3.169), so the two resolvers are made to disagree through the latch's own
 * test seam — exactly as `credential-floor-latched-home.test.ts` does for
 * F1.105 — and the rig control asserts they really differ, because an arm in
 * which the two are the same string cannot fail.
 *
 * SAFETY: nothing here opens, creates or deletes a file under either home.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClaudeContext } from '../claude-context.ts';
import { relatchHomeDirForTests } from '../../config/home-latch.ts';

const LAUNCH_HOME = join(tmpdir(), 'wjl-f1191-launch-home');

afterEach(() => {
  relatchHomeDirForTests();
});

function context() {
  return createClaudeContext({
    sessionId: 'f1191-session',
    workspacePath: '/tmp/f1191-ws',
    workspaceId: 'f1191-ws',
    sessionPath: '/tmp/f1191-ws/sessions/f1191-session',
    onPlanSubmitted: () => {},
    onAuthRequest: () => {},
  });
}

describe('F1.191 · the claude/Pi session-tool context carries the latched home', () => {
  it('answers the latched home after it moves away from the live one', () => {
    const ctx = context();
    relatchHomeDirForTests(LAUNCH_HOME);
    // Rig control: the two resolvers really disagree, or the next line is vacuous.
    expect(homedir()).not.toBe(LAUNCH_HOME);
    // An ACCESSOR, read at call time: the context above was built BEFORE the
    // latch moved, which is the cached-per-session shape production has.
    expect(ctx.credentialHomeDir?.()).toBe(LAUNCH_HOME);
  });

  it('CONTROL — with the latch untouched it answers exactly what the handler fell back to', () => {
    expect(context().credentialHomeDir?.()).toBe(homedir());
  });
});
