/**
 * F1.1063 — the Bun switches that stop a host-owned Bun subprocess from reading
 * the PROJECT folder it is started in.
 *
 * Bun reads two kinds of file from its cwd at startup, and Node reads neither:
 *
 * - every `.env` file — `.env`, `.env.<NODE_ENV>`, `.env.local`,
 *   `.env.<NODE_ENV>.local` (bun.com/docs/runtime/environment-variables.md,
 *   "Setting environment variables"). The switch is `--no-env-file` ("Disabling
 *   automatic `.env` loading": "Use `--no-env-file` to disable Bun's automatic
 *   `.env` file loading");
 * - `bunfig.toml` (`bun --help`: "-c, --config=<val> Specify path to Bun config
 *   file. Default $cwd/bunfig.toml"), whose top-level `preload` runs a script
 *   before the entry point and whose `env = false` is the file-side form of the
 *   switch above. Pointing `--config` at the null device reads no file.
 *
 * Measured on the bundled Bun 1.3.9 (`apps/electron/vendor/bun/bun`,
 * 2026-09-28, a scratch project): with no switch a `.env` name and a
 * `.env.local` name reached the child and a `bunfig.toml` preload ran; a `.env`
 * `HTTP_PROXY` sent the child's `fetch` to a loopback sink. With
 * `--no-env-file` neither `.env` name arrived and the sink got nothing, but the
 * preload still ran (a project `bunfig.toml` with `env = true` did not undo the
 * switch). With `--config=<null device>` as well the preload did not run.
 * A name the parent set was never overridden by a `.env` in any arm, and an
 * explicit `--env-file` still loads.
 *
 * The pair is the one the plugin `bunx` launcher already passes
 * (`runtime-resolver.ts`, `resolvePluginNodeRuntime`'s `bunx` executable), for
 * the same reason. It is Bun's own mechanism, so nothing of the host's replaces
 * it; a Node or Electron runtime would refuse both flags as unknown options and
 * reads neither file anyway, so it gets none.
 */

/** Bun's config path that reads no file: the null device, as the `bunx` launcher writes it. */
export function bunNeutralConfigPath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}

/** True for a `bun` / `bun.exe` executable path, on either separator. */
export function isBunExecutable(command: string): boolean {
  const name = command.split(/[\\/]/).pop()?.toLowerCase();
  return name === 'bun' || name === 'bun.exe';
}

/**
 * The argv prefix that keeps a project's `.env` files and `bunfig.toml` out of a
 * Bun subprocess, or none for a runtime that is not Bun.
 */
export function bunProjectIsolationArgs(command: string, platform: NodeJS.Platform = process.platform): string[] {
  if (!isBunExecutable(command)) return [];
  return ['--no-env-file', `--config=${bunNeutralConfigPath(platform)}`];
}
