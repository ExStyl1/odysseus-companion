/**
 * F1.660 (WJ-crit-h, 2026-09-25) — the workspace-record guard's SHELL arm, when
 * the command does not write from the session cwd.
 *
 * `getAutomationConfigMutationGuard` refuses a write to `permissions.json`,
 * `automations.json` and `automations-history.jsonl` in every mode, INCLUDING
 * `bypassPermissions` (D1.434 / D1.438; `workspace-agent-record-write-floor.test.ts`
 * pins the tool spellings). Its shell arm resolved every path-shaped token
 * against the session cwd only, and never expanded the home spellings.
 *
 * ## The reading, taken first (a host-level probe; the readings are in the F1.660 plan note)
 *
 * The real `runPreToolUseChecks`, called the way claude's PreToolUse hook and
 * Pi's pre_tool_use bridge call it (`workspaceRootPath` = the workspace root,
 * `workingDirectory` = the session cwd), over eight layouts and four modes:
 *
 *  - The row's headline — the project folder CONTAINS the workspace root (the
 *    home directory with a relocated `NESSY_CONFIG_DIR`, `<config dir>` itself,
 *    `<config dir>/workspaces`, `/`) — is REFUSED for the absolute path, the
 *    cwd-relative path and every `Write` spelling: this gate resolves against the
 *    session cwd, so the codex twin's defect (F1.653: record names projected as
 *    bare cwd-relative subpaths) has no counterpart here.
 *  - `cd <workspace root> && printf '{}' > permissions.json` walked past on
 *    EVERY layout whose cwd is not the workspace root — each ancestor layout,
 *    the default-install layout and a sibling project — and was caught only
 *    when the cwd IS the root, by coincidence.
 *  - `printf '{}' > ~/<…>/permissions.json` and the `$HOME/<…>` spelling walked
 *    past on EVERY layout, the cwd == root control included: the token was
 *    resolved as a directory literally named `~`.
 *  - What a miss answered: an ordinary, negotiable Bash card in `default`,
 *    `acceptEdits` and `auto`, and ALLOW with no card in `bypassPermissions` —
 *    the one mode this floor exists to bind. A written `permissions.json` is a
 *    self-granted allow rule for every later session in the workspace.
 *
 * ## The fix, and what it is not
 *
 * The shell arm now resolves each candidate against the session cwd AND every
 * `cd`/`pushd` target in the command (each against the one before it), and
 * expands `~`, `$HOME` and `${HOME}` through the shared `expandPath`. A residue
 * measured after that first commit — a nested `bash -c "…"` / `sh -c '…'` was
 * one quoted token, so its path and its `cd` were never resolved — is closed by
 * also scanning a quote-blanked copy of the command. It is not a shell
 * interpreter: a directory reached through a variable other than HOME, or
 * `eval` text, is not followed (`findShellEvalConstruct` stands beside it for
 * `eval`). A subshell's `cd`, or a `cd` into the workspace root AFTER a token
 * that names a record, over-blocks — the read/write blindness F1.124 accepted.
 *
 * No path is created: the gate's shell arm is path arithmetic, so the layouts
 * below are named under the real home directory without touching it, which is
 * what makes the `~` spellings faithful.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'

const KEY = { workspaceId: 'ws-f1660', sessionId: 'session-f1660' }

/** A relocated config dir under the real home — no `.nessy-agent` segment, so no name floor answers instead. */
const HOME = homedir()
const CONFIG_DIR = join(HOME, '.nessy-f1660-never-created')
const ROOT = join(CONFIG_DIR, 'workspaces', KEY.workspaceId)
const FROM_HOME = relative(HOME, ROOT)

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

afterEach(() => { cleanupModeState(KEY) })

/** The gate as both runtimes call it; `record` is true only for THIS guard's refusal. */
function check(cwd: string, command: string, mode: PermissionMode): { type: string; record: boolean } {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName: 'Bash',
    input: { command },
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath: ROOT,
    workspaceId: KEY.workspaceId,
    workingDirectory: cwd,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
  })
  // Read into locals before asserting (an asymmetric matcher in `toMatchObject` overwrites its field).
  return { type: result.type, record: result.type === 'block' && /are blocked/.test(result.reason) }
}

const MODES = ['default', 'bypassPermissions'] as const

describe('F1.660 · CONTROLS — refused at HEAD, and must stay refused', () => {
  for (const mode of MODES) {
    it(`refuses the bare redirect when the cwd IS the workspace root (${mode})`, () => {
      expect(check(ROOT, `printf '{}' > permissions.json`, mode)).toEqual({ type: 'block', record: true })
    })

    it(`refuses the absolute and the cwd-relative path from an ANCESTOR cwd — the row's headline (${mode})`, () => {
      const verdicts = [
        check(HOME, `printf '{}' > ${join(ROOT, 'permissions.json')}`, mode),
        check(HOME, `printf '{}' > ${join(FROM_HOME, 'automations.json')}`, mode),
        check(join(CONFIG_DIR, 'workspaces'), `printf '{}' > ${KEY.workspaceId}/permissions.json`, mode),
        check('/', `printf '{}' > "${relative('/', join(ROOT, 'permissions.json'))}"`, mode),
      ]
      expect(verdicts).toEqual(Array(4).fill({ type: 'block', record: true }))
    })
  }
})

describe('F1.660 · the spellings that walked past the guard', () => {
  const cases: Array<[string, string, string]> = [
    ['cd <absolute root> from the home directory', HOME, `cd ${ROOT} && printf '{}' > permissions.json`],
    ['cd <relative root> from the home directory', HOME, `cd ${FROM_HOME} && printf '{}' > automations.json`],
    ['cd <id> from <config dir>/workspaces', join(CONFIG_DIR, 'workspaces'), `cd ${KEY.workspaceId}; printf '{}' > permissions.json`],
    ['two chained cds from the config dir', CONFIG_DIR, `cd workspaces && cd ${KEY.workspaceId} && printf '{}' > permissions.json`],
    ['pushd "$HOME/<…>" from a sibling project', join(HOME, 'project'), `pushd "$HOME/${FROM_HOME}" && printf '{}' > permissions.json`],
    ['~/<…> from the home directory', HOME, `printf '{}' > ~/${FROM_HOME}/permissions.json`],
    ['$HOME/<…> from the home directory', HOME, `printf '{}' > $HOME/${FROM_HOME}/automations.json`],
    ['"${HOME}/<…>" from the home directory', HOME, `printf '{}' > "\${HOME}/${FROM_HOME}/automations-history.jsonl"`],
    ['~/<…> when the cwd IS the workspace root', ROOT, `printf '{}' > ~/${FROM_HOME}/permissions.json`],
    // The residue measured after the first commit: a nested shell wrapper's quoted
    // script was ONE token, so neither its path nor its `cd` was ever resolved.
    ['an absolute path inside bash -c "…"', HOME, `bash -c "printf '{}' > ${join(ROOT, 'permissions.json')}"`],
    ["a cd inside sh -c '…'", HOME, `sh -c 'cd ${ROOT} && printf x > automations.json'`],
  ]
  for (const mode of MODES) {
    for (const [label, cwd, command] of cases) {
      it(`refuses ${label} (${mode})`, () => {
        expect(check(cwd, command, mode)).toEqual({ type: 'block', record: true })
      })
    }
  }
})

describe('F1.660 · BOUNDARY — what the widened resolution must not refuse', () => {
  it('lets a sibling file in the workspace be written after a cd into it (bypassPermissions allows)', () => {
    expect(check(HOME, `cd ${ROOT} && printf 'x' > notes.txt`, 'bypassPermissions')).toEqual({ type: 'allow', record: false })
  })

  it("leaves a project's OWN permissions.json alone after a cd into the project", () => {
    expect(check(HOME, `cd project && printf '{}' > permissions.json`, 'bypassPermissions')).toEqual({ type: 'allow', record: false })
  })

  it('does not refuse a wrapper that only NAMES a project file of the same name', () => {
    expect(check(HOME, `bash -c "cd project && printf '{}' > permissions.json"`, 'bypassPermissions')).toEqual({ type: 'allow', record: false })
  })

  it('does not read `cd` inside another word as a directory change', () => {
    expect(check(HOME, `abcd ${ROOT} && printf '{}' > permissions.json`, 'bypassPermissions')).toEqual({ type: 'allow', record: false })
  })
})
