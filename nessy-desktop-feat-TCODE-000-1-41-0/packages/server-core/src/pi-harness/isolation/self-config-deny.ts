import { win32 } from 'node:path'

/**
 * Paths a sandboxed command must never WRITE, whatever profile it was granted.
 *
 * ## C3.379 — the condition, stated here because three readers had to discover it
 *
 * Read the first line as *"a SANDBOXED command"*, literally. In the shipped
 * posture there are none, so nothing this function returns binds on anything.
 * Two steps, each already pinned by a test that exists:
 *
 *  1. `packages/shared/src/config/sandbox-settings.ts` symbol
 *     `SANDBOX_ENABLED_DEFAULT` is `false` — the standing owner decision of
 *     2026-08-12 — so `sandboxEnabled` is false unless a managed floor or a user
 *     layer sets it. Pinned in
 *     `packages/shared/src/config/__tests__/sandbox-settings.test.ts`.
 *  2. `packages/server-core/src/pi-harness/process-supervisor.ts` symbol
 *     `resolveIsolationDowngrade` then returns `{ reason: 'sandboxDisabled' }`
 *     FIRST and unconditionally — ahead of the strict-mode and
 *     `excludedCommands` branches — so `resolveProcessIsolation` is never
 *     called. Pinned in
 *     `packages/server-core/src/pi-harness/process-supervisor.test.ts`, which
 *     asserts the injected resolver is called ZERO times on that arm.
 *
 * This is live code, not dead code: turning `sandbox.enabled` on is exactly the
 * case it exists for, and composing it in the one funnel is what makes that case
 * safe. What it is NOT is a boundary a default install has — so a docstring
 * elsewhere that routes a reader here for *"what governs a shell write"* is
 * wrong unless it says *when the sandbox is on*. Two did (F2 measured it,
 * 2026-09-12); `packages/shared/src/agent/pi-harness/protected-paths.ts`
 * § "Known limits" now carries the same condition, and
 * `packages/shared/src/config/storage.ts` already carried its own.
 *
 * Every `sandboxing.md` citation in THIS FILE names the page's own SECTION
 * ANCHOR, not a line number, and every quote was re-measured verbatim against
 * the 2026-08-25 fetch (`curl -s https://code.claude.com/docs/en/sandboxing.md`,
 * HTTP 200, 677 lines, md5 `3538c3dd04b83d8bbaa35d0fad0ccb88`). Numbers are gone
 * because this page's have moved on three consecutive fetches — the whole
 * "Protected paths" section shifted up 14 lines between the 2026-08-23 and
 * 2026-08-25 fetches — so a number is stale before the next reader opens the
 * file, while a section anchor is part of the page's own link contract. No claim
 * is made here about citations to any OTHER page.
 *
 * `sandboxing.md#protected-paths` — "Inside the directories that sandboxed
 * commands can write to, the sandbox still denies writes to the files Claude Code
 * loads configuration and code from. A command that could edit those files could
 * grant itself permissions, or add a hook or MCP server that Claude Code runs
 * outside the sandbox." The first of the four groups it then lists is "In your
 * working directory and the directories above it: the `.claude` settings files,
 * the `.claude/skills`, `.claude/agents`, `.claude/commands`, and `.claude/hooks`
 * directories, `.mcp.json`, and the files Claude Code runs on its own"; the
 * fourth is "In `~/.claude`, or the directory `CLAUDE_CONFIG_DIR` points to".
 *
 * (The wording this comment used to quote — "denies write access to Claude Code's
 * `settings.json` files at every scope … so a sandboxed command can't modify its
 * own policy", hung on `sandboxing.md:478` — is on NO revision this repo can
 * fetch: `grep -F` finds neither "can't modify its own policy" nor "at every
 * scope" on the 2026-08-25 page, and `:478` is now "Network access is controlled
 * through a proxy server running outside the sandbox:", a different layer. It was
 * a paraphrase in quotation marks. The claim survives; the quote did not.)
 *
 * Note the page covers EVERY scope. The user and managed scopes are already
 * unwritable because
 * `(deny file-write*)` is the floor and only the workspace root and the scratch
 * dir are opened, but the PROJECT scope lives INSIDE the workspace root, which is
 * exactly the tree the `workspace` and `networked` profiles make writable. A
 * command that edits `<workspace>/.claude/settings.json` widens the next
 * command's permission rules, and today nothing stops it.
 *
 * The permission layer already draws this line and the OS boundary did not:
 * `session-filesystem-scope.ts` refuses a FILE TOOL write to `.nessy-agent` and
 * `.agents` ("an agent must not rewrite its own trusted config, hooks or
 * skills"), so `Edit` is refused while `bash -c 'echo … > .agents/…'` succeeds.
 * This closes that gap rather than inventing a new policy, and adds `.claude`,
 * which the file-tool list omits even though we read project settings and
 * `enabledPlugins` out of it.
 *
 * NOT here, deliberately:
 *
 * - `<workspace>/.git`. Writing it is how `git commit` updates refs, and the
 *   shell's git is the intended writer (the same `session-filesystem-scope.ts`
 *   comment says so). `.git/hooks` and `.git/config` are the two exceptions
 *   the page names — `sandboxing.md#filesystem-isolation`: "when the working
 *   directory is a linked git worktree, the sandbox also allows writes to the main
 *   repository's shared `.git` directory so commands such as `git commit` can
 *   update refs and the index. Writes to `hooks/` and `config` inside that
 *   directory remain denied." They are denied by the worktree layer that also
 *   grants the shared directory.
 * - The whole config dir. `SESSIONS_DIR` — and therefore every supervised
 *   process's scratch/`TMPDIR` root — is `<configDir>/sessions`, and the darwin
 *   profile emits write denies AFTER the write allows, so denying the config dir
 *   wholesale would revoke the scratch grant and break every command.
 * - `<configDir>/plugins`. `PLUGIN_DATA_DIR` lives under it and a sandboxed
 *   plugin process is supposed to write its own data bucket there.
 *
 * Per-platform: every entry binds on all three backends, because all three take
 * `deniedWriteRoots` (darwin `(deny file-write* (subpath …))`, linux
 * `--ro-bind-try`, win32 `"<path>" = "read"`). The win32 SYSTEM set is the only
 * platform-conditional part, and it is additive:
 * `sandboxing.md#security-limitations` names "directories containing executables
 * in `$PATH`, system configuration directories" as the privilege-escalation
 * route, which on POSIX is already
 * covered by the deny-by-default floor and on win32 by `":root" = "read"` — the
 * entries bind only when a grant overlaps them, which is the case that matters.
 */
export function selfConfigDenyWriteRoots(input: {
  platform: NodeJS.Platform
  /** Already-canonical workspace root; project-scope entries hang off it. */
  workspaceRoot: string
  home: string
  configDir: string
  /** `process.env` on win32; only the four system-root variables are read. */
  windowsEnvironment?: Readonly<Record<string, string | undefined>>
  /** Host path join, so a win32 plan resolved on a POSIX host stays testable. */
  join: (...parts: string[]) => string
}): string[] {
  const { join, platform, workspaceRoot, home, configDir } = input
  const roots = [
    // Project scope — the only scope inside a writable root.
    join(workspaceRoot, '.claude'),
    join(workspaceRoot, '.nessy-agent'),
    join(workspaceRoot, '.agents'),
    // User scope. Named file-by-file rather than as the config dir: see above.
    join(configDir, 'config.json'),
    join(configDir, 'config-defaults.json'),
    join(configDir, 'permissions'),
    join(configDir, 'capabilities.json'),
    join(configDir, 'capability-trust.json'),
    join(configDir, 'project-trust.json'),
    join(home, '.claude'),
    join(home, '.claude.json'),
  ]
  const managed = managedSettingsDirectory(platform, input.windowsEnvironment?.ProgramData)
  if (managed) roots.push(managed)
  if (platform === 'win32') roots.push(...windowsSystemRoots(input.windowsEnvironment ?? {}))
  return roots
}

/**
 * The directory holding `managed-policy.json` and its `managed-policy.d/`
 * fragments — `managedPiPolicyPathForPlatform`'s parent, restated here rather
 * than imported because that function THROWS for a platform it does not know and
 * for win32 without `ProgramData`, and a deny-set builder must never be the
 * reason a process fails to start.
 */
function managedSettingsDirectory(platform: NodeJS.Platform, programData?: string): string | undefined {
  if (platform === 'darwin') return '/Library/Application Support/Nessy'
  if (platform === 'linux') return '/etc/nessy'
  if (platform === 'win32' && programData) return win32.join(programData, 'Nessy')
  return undefined
}

/**
 * The win32 system set. Read from the environment rather than hardcoded to
 * `C:\`, because a host with a non-default `SystemDrive` would otherwise get
 * three deny entries that name a directory it does not have — and a deny that
 * names nothing is the defect S12 was written to remove.
 */
function windowsSystemRoots(environment: Readonly<Record<string, string | undefined>>): string[] {
  return ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']
    .map(name => environment[name])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}
