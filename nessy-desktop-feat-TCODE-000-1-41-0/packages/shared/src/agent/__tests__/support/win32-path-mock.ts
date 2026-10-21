/**
 * The one check every file that fakes a win32 `path` owes on its way out.
 *
 * P6.582. Two files in this directory install `mock.module('node:path', …)` to
 * drive win32 semantics on a POSIX host. Both are correct to do so, and both
 * are dangerous for the same reason: `mock.module` MUTATES the already-imported
 * namespace object in place, so a restore that reads the LIVE namespace hands
 * the mock back and win32 `join` leaks into every later file in the same
 * `bun test` invocation.
 *
 * The leak is not the leaker's own symptom, which is what made it survive: a
 * later file's `join(tmpdir(), 'nessy-codex-home-')` (CODEX_HOME's `$TMPDIR` fallback since F1.652) becomes
 * `\var\folders\…\nessy-codex-home-`, which on POSIX is ONE relative file name,
 * and the directory lands under the process's cwd. The controller removed 30+
 * such entries from the repository root on 2026-09-06 — twice in two days.
 *
 * ## Two halves, and they live in different places on purpose
 *
 * - **The MECHANISM** is here: after the restore, does `node:path` behave like
 *   POSIX again and does `os.homedir()` stop answering the Windows home? That
 *   is a property of the file that installed the mock, so the file asserts it.
 * - **The SYMPTOM** — backslash-named entries in the repository root — is in
 *   `packages/shared/tests/setup/isolate-shared-config-dir.ts`, the `bun test`
 *   preload, because a leaked mock is written to disk by whichever unrelated
 *   file runs next. It baselines at preload time and blames a run only for what
 *   that run created, which matters in a tree a dozen lanes run tests against.
 *   A per-file `readdirSync` check cannot make that distinction and would go red
 *   for another process's litter.
 *
 * Called from an `afterAll`, so it THROWS rather than using `expect` — a failed
 * expectation inside a hook is not always attributed to the hook.
 */
export function assertWin32PathMockRestored(options: {
  /** The file that installed the mock, named in the failure. */
  readonly file: string
  /** The LIVE `node:path` namespace — deliberately, since that is what leaks. */
  readonly livePath: { join: (...parts: string[]) => string }
  /** The LIVE `node:os` namespace. */
  readonly liveOs: { homedir: () => string }
  /** The Windows home the mock answered with. */
  readonly winHome: string
}): void {
  // `mock.module` mutates the live namespace in place, so reading it here is
  // reading exactly what every later file in this invocation will get.
  const restored = options.livePath.join('/a', 'b')
  if (restored !== '/a/b') {
    throw new Error(
      `${options.file} leaked its win32 path mock: node:path.join('/a','b') is `
      + `${JSON.stringify(restored)} after restore, not '/a/b'. Every later file in this `
      + `bun test invocation now has win32 path semantics, and the next one that joins a `
      + `temp path will write a backslash-named directory into the repository root. `
      + `Restore from a SPREAD taken before the mock, never from the live namespace.`,
    )
  }
  if (options.liveOs.homedir() === options.winHome) {
    throw new Error(`${options.file} leaked its win32 os.homedir mock`)
  }
}
