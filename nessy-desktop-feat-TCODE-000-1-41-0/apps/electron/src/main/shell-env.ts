/**
 * Shell Environment Loader
 *
 * When Electron apps are launched from Finder/Dock on macOS, they inherit
 * a minimal launchd environment with PATH=/usr/bin:/bin:/usr/sbin:/sbin.
 *
 * This module loads the user's full shell environment by spawning their
 * login shell and extracting environment variables. This ensures tools
 * like Homebrew (gh, brew), nvm, pyenv, etc. are available to the agent.
 */

import { execSync } from 'child_process'
import { mainLog } from './logger'

/** The login shell's bookkeeping about itself — see the P3.192 table below. */
const SHELL_SELF_DESCRIPTION_KEYS: ReadonlySet<string> = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])

/**
 * Keys the login shell's environment must NOT be allowed to write over
 * `process.env`.
 *
 * `VITE_*` — dev-mode leftovers; a packaged app that inherited them would try
 * to load its renderer from localhost.
 *
 * `HOME` — P3.181, and the reason is longer than the rule.
 *
 * ## What was measured
 *
 * `latchedHomeDir()` (`packages/shared/src/config/home-latch.ts`, re-exported
 * from `@nessy-agent/codex-responses-adapter/home-latch`) captures `homedir()`
 * at MODULE IMPORT, so the session's credential source, the key its credential
 * store is encrypted under, and the `~` anchor of the sandbox floor all stay on
 * the home the process started with. `loadShellEnv()` below runs in the ENTRY
 * BODY, which in a bundle is after every module initializer — so it used to
 * re-import `HOME` over a latch that had already closed.
 *
 * Measured 2026-08-28 in a freshly built bundle: `init_home_latch2()` — the call
 * that runs `latchedHome = homedir()` — is a top-level statement well above the
 * entry body, and `loadShellEnv();` is the second statement OF the entry body,
 * with 406 top-level `init_*()` calls ahead of it (407 in a build without the
 * provider `--define`s, which change what is eliminated; the finder read 401 on
 * the 2026-08-27 bundle). The count and the line numbers move with every build
 * and with the flags — the ORDER is the invariant, and the numbers are only its
 * receipt. A dev run cannot show any of this: `loadShellEnv()` returns early
 * under `VITE_DEV_SERVER_URL`, so this path exists only in a packaged build.
 *
 * The consequence, for a user whose shell profile reassigns `HOME`: the
 * credential source read the launchd home while every other `os.homedir()`
 * caller in the same process read the shell home. The latch did not create that
 * split — it fixed its timing in place, which is what made it visible.
 *
 * ## What depends on `HOME` reaching `process.env`, and why dropping it is safe
 *
 * Three readers, checked rather than assumed:
 *
 *  1. `os.homedir()` — 88 non-test call sites in this tree. Node and Electron
 *     both follow a mid-process `process.env.HOME` (measured table in
 *     `config/home-latch.ts`), so today every one of them followed the shell.
 *  2. Subprocesses. `HOME` is one of the five keys a Pi Bash child is given
 *     under the supervisor's `restricted` profile (`RESTRICTED_HOST_ENVIRONMENT`
 *     in `packages/server-core/src/pi-harness/process-supervisor.ts`), and the
 *     spread-`process.env` spawn sites hand it on too.
 *  3. The hand-rolled `~` expansions in `plugins/source-resolver.ts` and
 *     `utils/files.ts`.
 *
 * None of the three wants the SHELL's `HOME` specifically; each wants a home.
 * For every profile that does not reassign `HOME` — the overwhelming majority —
 * the imported value is byte-identical to the one already in `process.env`, so
 * the skip is a no-op. And it cannot leave the app without a home: the
 * `execSync` below already seeds the child with `HOME: process.env.HOME`, so the
 * shell starts from the same value, and were it ever absent `os.homedir()` falls
 * through to the passwd entry. This removes an assignment, never the variable.
 *
 * Importing it EARLIER is the other way to make the readers agree, and it is
 * both unavailable and worse: module initializers run before the entry body, so
 * there is no bundle position from which the shell import beats the latch — and
 * if there were, it would let a line in a user-writable `.zshrc` relocate the
 * credential source mid-startup, which is the move the latch exists to stop.
 *
 * What genuinely changes: for a user who DOES reassign `HOME` in their profile,
 * the app now reads the account home everywhere, including the agent's Bash
 * children, while their own terminal keeps reading the reassigned one. That
 * divergence is uniform and visible from outside; the one it replaces was
 * internal and silent.
 *
 * `PWD` / `OLDPWD` / `SHLVL` / `_` — P3.192, and the reason is that they describe
 * a process that has exited.
 *
 * ## The eight names the row named, each resolved to a reader or dropped
 *
 * P3.192 recorded eight variables this loader copies wholesale and claimed a
 * grep found ZERO readers for all eight. Re-measured here, that claim is right
 * for four of them and WRONG for the other four — because the readers are
 * indirect and a literal grep for the NAME cannot see them:
 *
 * | Name | Reader | Verdict |
 * | --- | --- | --- |
 * | `USER` | `RESTRICTED_HOST_ENVIRONMENT` (`server-core/src/pi-harness/process-supervisor.ts`) forwards it into the agent's Bash child under the shipped default `restricted` profile | KEEP |
 * | `LOGNAME` | the same allowlist, the same line | KEEP |
 * | `TERM` | the same allowlist | KEEP — see the caveat below |
 * | `TMPDIR` | `os.tmpdir()`, which follows a mid-process `process.env.TMPDIR` on POSIX — DRIVEN, not read: `follows: true` on Bun 1.3.14 and on Node, with 13 non-test `tmpdir()` call sites in this tree | KEEP |
 * | `PWD` | none | DROPPED |
 * | `OLDPWD` | none | DROPPED |
 * | `SHLVL` | none | DROPPED |
 * | `_` | none | DROPPED |
 *
 * The four dropped ones are the login shell's own bookkeeping about ITSELF:
 * `PWD`/`OLDPWD` are the directories that shell was standing in, `SHLVL` is how
 * deeply it was nested, and `_` holds the last command it ran — which, here, is
 * always the `env` this loader asked it for. The shell exits microseconds later.
 * Copying them makes `process.env` describe a dead process, and since every
 * spawn site in this tree builds a child env by spreading `process.env`, that
 * description is then handed to the agent's own subprocesses: a Bash child
 * started in the workspace would inherit a `PWD` naming the login shell's
 * directory instead of its own. Nothing in the tree reads them, so nothing
 * changes today; the drop is what keeps it that way. This removes an
 * assignment, never a variable — anything genuinely needing `PWD` gets the
 * launchd value that was already there, or the one its own spawn sets.
 *
 * **The `TERM` caveat, stated because it looks like a user setting and is not.**
 * `loadShellEnv` spawns the login shell with `TERM: 'xterm-256color'` (below),
 * so the value copied back is this loader's OWN fixture round-tripping, unless a
 * profile reassigns it. It is kept rather than dropped because the supervisor
 * allowlist forwards `TERM` deliberately and a packaged GUI app has no terminal
 * to ask — so dropping it would leave the agent's children with whatever launchd
 * supplies, which is nothing. Driven 2026-09-03 with this loader's exact env:
 * the dump comes back carrying `TERM=xterm-256color` and all seven others.
 */
export const shouldSkipEnvVar = (key: string): boolean => {
  return key.startsWith('VITE_') || key === 'HOME' || SHELL_SELF_DESCRIPTION_KEYS.has(key)
}

/**
 * The variables an `env` dump is allowed to contribute, in the order the shell
 * printed them.
 *
 * Split out from {@link loadShellEnv} so the filter is reachable from a test:
 * the loader itself spawns a login shell and mutates `process.env`, and under
 * `bun test` a mutated `process.env.HOME` does not move `os.homedir()` at all
 * (Bun latches it at startup — measured table in `config/home-latch.ts`), so an
 * end-to-end assertion there would pass whatever this function did. The
 * end-to-end claim belongs to a Node-hosted or packaged check.
 */
export function selectShellEnvVars(output: string): Record<string, string> {
  const envSection = output.split('__ENV_START__')[1] || ''
  const selected: Record<string, string> = {}
  for (const line of envSection.trim().split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) {
      const key = line.substring(0, eq)
      if (shouldSkipEnvVar(key)) continue
      selected[key] = line.substring(eq + 1)
    }
  }
  return selected
}

/**
 * Load the user's shell environment and merge it into process.env
 *
 * This should be called early in app startup, before creating any agents.
 * It spawns the user's login shell to get the full environment including
 * PATH modifications from .zshrc, .bashrc, .zprofile, etc.
 */
export function loadShellEnv(): void {
  // Only needed on macOS where GUI apps have minimal environment
  if (process.platform !== 'darwin') {
    return
  }

  // Skip in dev mode - terminal launches already have full environment
  if (process.env.VITE_DEV_SERVER_URL) {
    mainLog.info('[shell-env] Skipping in dev mode (already have shell environment)')
    return
  }

  const shell = process.env.SHELL || '/bin/zsh'
  mainLog.info(`[shell-env] Loading environment from ${shell}`)

  try {
    // Run login shell to get full environment
    // -l = login shell (sources profile files like .zprofile)
    // -i = interactive shell (sources rc files like .zshrc)
    // We use a marker to separate shell startup output from env output
    const output = execSync(`${shell} -l -i -c 'echo __ENV_START__ && env'`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: {
        HOME: process.env.HOME,
        USER: process.env.USER,
        SHELL: shell,
        TERM: 'xterm-256color',
        TMPDIR: process.env.TMPDIR,
        // Prevent macOS from showing "Install Command Line Developer Tools" dialog
        // when the shell hits the /usr/bin/git shim on systems without Xcode CLT
        APPLE_SUPPRESS_DEVELOPER_TOOL_POPUP: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Parse environment after marker and set variables (excluding blocked ones)
    const selected = selectShellEnvVars(output)
    for (const [key, value] of Object.entries(selected)) {
      process.env[key] = value
    }

    mainLog.info(`[shell-env] Loaded ${Object.keys(selected).length} environment variables`)

    // Log PATH for debugging
    if (process.env.PATH) {
      const pathCount = process.env.PATH.split(':').length
      mainLog.info(`[shell-env] PATH has ${pathCount} entries`)
    }
  } catch (error) {
    // Don't fail app startup if shell env loading fails
    mainLog.warn(`[shell-env] Failed to load shell environment: ${error}`)
    mainLog.warn('[shell-env] Adding common paths as fallback')

    // Fallback: add common paths that are likely to be needed
    const fallbackPaths = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.bun/bin`,
      `${process.env.HOME}/.cargo/bin`,
    ]

    const currentPath = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'
    const newPath = [...fallbackPaths, ...currentPath.split(':')]
      .filter((p, i, arr) => arr.indexOf(p) === i) // dedupe
      .join(':')

    process.env.PATH = newPath
  }
}
