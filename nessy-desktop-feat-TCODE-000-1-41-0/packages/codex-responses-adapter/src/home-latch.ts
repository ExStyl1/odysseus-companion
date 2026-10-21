/**
 * The session's home directory, captured once at module import — P3.143/P3.168.
 *
 * **Read `@nessy-agent/shared` `src/config/home-latch.ts` first.** That module
 * re-exports this one and carries the whole argument: what a moved `HOME`
 * relocates, why the fix is a latch rather than a second withhold, which
 * runtimes follow a mid-process `process.env.HOME` (Node and Electron do; Bun
 * does not), and the boundary the latch deliberately stops at.
 *
 * ## Why the implementation is HERE, in a Responses-protocol package
 *
 * Because this package is the dependency ROOT of the pair. `@nessy-agent/shared`
 * depends on `@nessy-agent/codex-responses-adapter`, so the adapter cannot
 * import shared — `nestor-auth.ts` already duplicates `isJwtShaped` for exactly
 * that reason. And `nestor-auth.ts` resolves
 * `~/.nessy/dp_auth_creds.json`, the same file shared's `getCredsPath()`
 * resolves, so it needs the same answer for `~`.
 *
 * ## Why a SECOND latch in this package would have been the wrong fix
 *
 * A latch's correctness is entirely its capture TIME, and two module-scope
 * captures capture at two different moments: whichever module the process
 * reaches later captures later, and "later" can be *after* `applyManagedEnv`
 * releases a confirmed administrator `HOME` when the importing module is
 * reached through a dynamic `import()` rather than the static graph. Two
 * latches that disagree are strictly worse than none: the shared creds file
 * would be written under one home and read under the other, which is the
 * split-brain the single latch exists to prevent. One module, one capture, one
 * value, reachable from every package in the tree.
 */

import { homedir } from 'node:os';

let latchedHome: string = homedir();

/**
 * The home directory this session started with.
 *
 * Never re-reads `$HOME`. Use this anywhere the answer decides where a
 * credential is read from or written to, where a credential's ENCRYPTION KEY is
 * derived from, or where the floor protecting one is anchored; use
 * `os.homedir()` directly everywhere else.
 */
export function latchedHomeDir(): string {
  return latchedHome;
}

/**
 * Test seam — re-latch to `value`, or back to the live `os.homedir()`.
 *
 * Production has no re-latch on purpose: a latch that can be reset from inside
 * the session is not a latch. Tests need one to prove the latch holds, which
 * they cannot do without moving the thing it is holding against — and under
 * `bun test` moving `process.env.HOME` moves nothing at all (P3.169).
 */
export function relatchHomeDirForTests(value?: string): void {
  latchedHome = value ?? homedir();
}
