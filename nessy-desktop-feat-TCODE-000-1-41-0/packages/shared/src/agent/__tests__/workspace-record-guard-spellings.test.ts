/**
 * F1.692 (WJ-crit-o, 2026-09-25) — the workspace-record guard's shell arm misread
 * common spellings of a record path, found by verification round 2 of F1.660.
 *
 * `getAutomationConfigMutationGuard` refuses a write to `permissions.json`,
 * `automations.json` and `automations-history.jsonl` in every mode, INCLUDING
 * `bypassPermissions` (D1.434 / D1.438). F1.660 taught its shell arm to follow
 * `cd`/`pushd`, expand `~`/`$HOME`, and scan a copy of the command with every
 * quote BLANKED to a space. Measured on the real `runPreToolUseChecks` (the one
 * gate claude's PreToolUse hook and Pi's pre_tool_use bridge both call; the host
 * probe readings are in the F1.692 plan note), these still walked past it —
 * an ordinary Bash card in `default`, ALLOW with no card in `bypassPermissions`:
 *
 *  - quote-JOINED words: the shell concatenates `"$HOME"/…`, `~/"<dir>"/…`,
 *    `<root>/"permissions.json"` and `perm''issions.json` into one word, while the
 *    blanked copy split them in two, and neither half named the record;
 *  - a backslash escape, `permissions\.json`;
 *  - an option word read as the `cd` target: `cd -P`, `cd -L`, `cd --`, `pushd -n`;
 *  - a bare `cd` (to HOME) not followed, so a later relative `cd` chained from the
 *    wrong directory;
 *  - a record name in another CASE: the default macOS volume (APFS) is
 *    case-insensitive, so `Permissions.json` writes `permissions.json`.
 *
 * Stated limits (F1.673, unchanged here; F1.673 later followed `$PWD` and a variable
 * assigned in the same command — `workspace-record-guard-shell-variables.test.ts`):
 * a directory held in a variable other than HOME, `eval` text and globs
 * (`permission?.json`) are not followed; the guard is
 * a token scan, not a shell interpreter. Quoted PROSE that names a record
 * (`git commit -m "fix permissions.json"`) is refused when the cwd is (or a `cd`
 * reaches) the workspace root — an over-block F1.660's blanked copy already made,
 * pinned below as stated rather than hidden.
 *
 * No path is created: the shell arm is path arithmetic, so the layouts are named
 * under the real home directory without touching it (the `~` spellings stay faithful).
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'

const KEY = { workspaceId: 'ws-f1692', sessionId: 'session-f1692' }

/** A relocated config dir under the real home — no `.nessy-agent` segment, so no name floor answers instead. */
const HOME = homedir()
const CONFIG_SEGMENT = '.nessy-f1692-never-created'
const CONFIG_DIR = join(HOME, CONFIG_SEGMENT)
const ROOT = join(CONFIG_DIR, 'workspaces', KEY.workspaceId)
const FROM_HOME = relative(HOME, ROOT)
const PROJECT = join(HOME, 'project-f1692-never-created')

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

afterEach(() => { cleanupModeState(KEY) })

/** The gate as both runtimes call it; `record` is true only for THIS guard's refusal. */
function check(cwd: string, toolName: string, input: Record<string, unknown>, mode: PermissionMode): { type: string; record: boolean } {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const result = runPreToolUseChecks({
    toolName,
    input,
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

const bash = (cwd: string, command: string, mode: PermissionMode) => check(cwd, 'Bash', { command }, mode)
const MODES = ['default', 'bypassPermissions'] as const
const REFUSED = { type: 'block', record: true }

describe('F1.692 · the spellings that walked past the record guard', () => {
  const cases: Array<[string, string, string]> = [
    // quote-joined words — the verifier's exact spellings
    ['"$HOME"/<…>/permissions.json', PROJECT, `printf '{}' > "$HOME"/${FROM_HOME}/permissions.json`],
    ['~/"<config dir>"/<…>/permissions.json', PROJECT, `printf '{}' > ~/"${CONFIG_SEGMENT}"/workspaces/${KEY.workspaceId}/permissions.json`],
    ['cd "$HOME"/<…> && … > permissions.json', PROJECT, `cd "$HOME"/${FROM_HOME} && printf '{}' > permissions.json`],
    ['<root>/"permissions.json"', PROJECT, `printf '{}' > ${ROOT}/"permissions.json"`],
    ["<root>/perm''issions.json", PROJECT, `printf '{}' > ${ROOT}/perm''issions.json`],
    ['"permissions".json from the root', ROOT, `printf '{}' > "permissions".json`],
    ["permissions.js'o'n from the root", ROOT, `printf '{}' > permissions.js'o'n`],
    ['a backslash escape, permissions\\.json, from the root', ROOT, `printf '{}' > permissions\\.json`],
    // option words read as the cd target
    ['cd -P <root> &&', PROJECT, `cd -P ${ROOT} && printf '{}' > permissions.json`],
    ['cd -L <root> &&', PROJECT, `cd -L ${ROOT} && printf '{}' > automations.json`],
    ['cd -- <root> &&', PROJECT, `cd -- ${ROOT} && printf '{}' > permissions.json`],
    ['pushd -n <root> &&', PROJECT, `pushd -n ${ROOT} && printf '{}' > permissions.json`],
    // a bare cd goes HOME
    ['cd; cd <relative from home>;', PROJECT, `cd; cd ${FROM_HOME}; printf '{}' > permissions.json`],
    ['cd && cd <relative from home> &&', PROJECT, `cd && cd ${FROM_HOME} && printf '{}' > automations.json`],
    // case (APFS)
    ['<root>/Permissions.json', PROJECT, `printf '{}' > ${ROOT}/Permissions.json`],
    ['PERMISSIONS.JSON from the root', ROOT, `printf '{}' > PERMISSIONS.JSON`],
    ['<ROOT IN UPPER CASE>/permissions.json', PROJECT, `printf '{}' > ${ROOT.toUpperCase()}/permissions.json`],
  ]
  for (const mode of MODES) {
    for (const [label, cwd, command] of cases) {
      it(`refuses ${label} (${mode})`, () => {
        expect(bash(cwd, command, mode)).toEqual(REFUSED)
      })
    }
    it(`refuses a Write of <root>/Permissions.json and of the root in upper case (${mode})`, () => {
      const verdicts = [
        check(PROJECT, 'Write', { file_path: join(ROOT, 'Permissions.json'), content: '{}' }, mode),
        check(PROJECT, 'Write', { file_path: join(ROOT.toUpperCase(), 'automations.json'), content: '{}' }, mode),
      ]
      expect(verdicts).toEqual([REFUSED, REFUSED])
    })
  }
})

describe('F1.692 · CONTROLS — what the widened reading must keep', () => {
  it('still refuses an interpreter string literal, which only the quote-BLANKED copy separates (bypassPermissions)', () => {
    expect(bash(PROJECT, `python3 -c "open('${join(ROOT, 'permissions.json')}','w').write('{}')"`, 'bypassPermissions')).toEqual(REFUSED)
  })

  it('lets a sibling file in the workspace be written after cd -P into it (bypassPermissions allows)', () => {
    expect(bash(PROJECT, `cd -P ${ROOT} && printf x > notes.txt`, 'bypassPermissions')).toEqual({ type: 'allow', record: false })
  })

  it("leaves a project's OWN permissions.json alone after cd -- into the project", () => {
    expect(bash(HOME, `cd -- ${PROJECT} && printf '{}' > permissions.json`, 'bypassPermissions')).toEqual({ type: 'allow', record: false })
  })

  it('does not follow `cd -` (the previous directory is unknown), and does not read it as HOME', () => {
    expect(bash(PROJECT, `cd - && printf '{}' > permissions.json`, 'bypassPermissions')).toEqual({ type: 'allow', record: false })
  })

  it('does not read `cd` inside another word as a directory change', () => {
    expect(bash(PROJECT, `cdrecord ${ROOT} && printf '{}' > permissions.json`, 'bypassPermissions')).toEqual({ type: 'allow', record: false })
  })

  it('allows quoted prose naming a record from a cwd that is not the workspace root', () => {
    expect(bash(PROJECT, `git commit -m "fix permissions.json note"`, 'bypassPermissions')).toEqual({ type: 'allow', record: false })
  })

  it('STATED over-block: the same prose is refused when the cwd IS the workspace root', () => {
    expect(bash(ROOT, `git commit -m "fix permissions.json note"`, 'bypassPermissions')).toEqual(REFUSED)
  })
})
