/**
 * F1.673 (DN-114, 2026-09-26; option a, decided by the owner) — the shell record
 * guards follow a directory held in a shell variable ASSIGNED IN THE SAME COMMAND,
 * and `$PWD`.
 *
 * `getAutomationConfigMutationGuard` refuses a write to `permissions.json`,
 * `automations.json` and `automations-history.jsonl` in every mode, INCLUDING
 * `bypassPermissions` (D1.434 / D1.438). F1.660 / F1.692 taught its shell arm (and
 * the global-record and data-folder arms that share `shellRecordScanTexts`) to
 * follow `cd`/`pushd`, expand `~` / `$HOME`, and read quote-blanked and
 * quote-removed copies. Read from the code (the analysis in the F1.673 decision),
 * `D=<root>; printf '{}' > $D/permissions.json` still walked past — an ordinary
 * Bash card in `default`, ALLOW with no card in `bypassPermissions` — and so did
 * `$PWD/permissions.json`, read as the relative `<cwd>/$PWD/permissions.json`.
 *
 * The fix: a FOURTH scan copy, the quote-removed one with each `$NAME` / `${NAME}`
 * replaced by the value of a `NAME=…` / `export NAME=…` earlier in the same command,
 * and `$PWD` / `${PWD}` by `.` (so it resolves from the cwd and every `cd` target,
 * the directories the scan already resolves from). Same-command is the documented
 * lifetime: claude's `tools-reference.md` — "Environment variables don't persist.
 * An `export` in one command won't be available in the next." — and Pi spawns a new
 * shell per call.
 *
 * Stated limits, unchanged: a value produced by the shell (`$(…)`, backticks,
 * `read`, a `for` loop), `eval` of text the scan cannot see, interpreters (F1.713)
 * and unlisted writers (F1.950). The OS-level answer is the sandbox, off by the
 * owner's standing decision; codex has its own OS profile.
 *
 * No path is created: the shell arm is path arithmetic, so the layouts are named
 * under the real home directory without touching it.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { CONFIG_DIR } from '../../config/paths.ts'

const KEY = { workspaceId: 'ws-f1673', sessionId: 'session-f1673' }

/** A relocated config dir under the real home — no `.nessy-agent` segment, so no name floor answers instead. */
const HOME = homedir()
const WORKSPACES = join(HOME, '.nessy-f1673-never-created', 'workspaces')
const ROOT = join(WORKSPACES, KEY.workspaceId)
const PROJECT = join(HOME, 'project-f1673-never-created')

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

afterEach(() => { cleanupModeState(KEY) })

/** The gate as both runtimes call it; `record` is true only for a record guard's refusal. */
function bash(cwd: string, command: string, mode: PermissionMode): { type: string; record: boolean } {
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
const REFUSED = { type: 'block', record: true }
const ALLOWED = { type: 'allow', record: false }

describe('F1.673 · a record path held in a same-command variable, or $PWD', () => {
  const cases: Array<[string, string, string]> = [
    ["the row's spelling, D=<root>; … > $D/permissions.json", PROJECT, `D=${ROOT}; printf '{}' > $D/permissions.json`],
    ['export D="<root>" && … > $D/automations.json', PROJECT, `export D="${ROOT}" && printf '{}' > $D/automations.json`],
    ['a chained value, W=$C/<id>; … > $W/permissions.json', PROJECT, `C=${WORKSPACES}; W=$C/${KEY.workspaceId}; printf '{}' > $W/permissions.json`],
    ['cd $D && … > permissions.json', PROJECT, `D=${ROOT}; cd $D && printf '{}' > permissions.json`],
    ['a braced reference, … > ${D}/permissions.json', PROJECT, `D=${ROOT}; printf '{}' > \${D}/permissions.json`],
    ['$PWD/permissions.json from the root', ROOT, `printf '{}' > $PWD/permissions.json`],
    ['cd <root> && … > $PWD/automations.json', PROJECT, `cd ${ROOT} && printf '{}' > $PWD/automations.json`],
  ]
  for (const mode of MODES) {
    for (const [label, cwd, command] of cases) {
      it(`refuses ${label} (${mode})`, () => {
        expect(bash(cwd, command, mode)).toEqual(REFUSED)
      })
    }
  }

  // A QUOTED variable word (`"$D"/…`, `"${PWD}"/…`) is substituted too, but the deniedPaths
  // floor already refuses it first, at HEAD as after (it reads that word as a possible `.env`),
  // so these pin only that the quoted spelling is no way round.
  for (const mode of MODES) {
    it(`a quoted reference stays refused (${mode})`, () => {
      const verdicts = [
        bash(PROJECT, `D=${ROOT}; printf '{}' > "$D"/automations.json`, mode).type,
        bash(PROJECT, `cd ${ROOT} && printf '{}' > "\${PWD}"/automations.json`, mode).type,
      ]
      expect(verdicts).toEqual(['block', 'block'])
    })
  }

  it('the global-record arm reads the same copy: D=<CONFIG_DIR>; … > $D/mcp.json (bypassPermissions)', () => {
    expect(bash(PROJECT, `D=${CONFIG_DIR}; printf '{}' > $D/mcp.json`, 'bypassPermissions')).toEqual(REFUSED)
  })
})

describe('F1.673 · CONTROLS — what the substitution must keep', () => {
  it('lets a sibling file be written through the same variable (bypassPermissions allows)', () => {
    expect(bash(PROJECT, `D=${ROOT}; printf x > $D/notes.txt`, 'bypassPermissions')).toEqual(ALLOWED)
  })

  it("leaves a project's OWN permissions.json alone through $PWD", () => {
    expect(bash(PROJECT, `printf '{}' > $PWD/permissions.json`, 'bypassPermissions')).toEqual(ALLOWED)
  })

  it('reads the LATEST assignment before the use, as the shell does (the project copy stays allowed)', () => {
    // The verdict-level pin of the latest-assignment reading: at the PROJECT cwd the
    // substituted path is the project's OWN permissions.json, so ALLOW here is proof the
    // use read the SECOND value — had the scan kept the first (ROOT), the workspace-record
    // guard would answer block.
    expect(bash(PROJECT, `D=${ROOT}; D=${PROJECT}; printf '{}' > $D/permissions.json`, 'bypassPermissions')).toEqual(ALLOWED)
  })

  it('STATED since F1.1120: from the home cwd the raw $D word is refused by the deniedPaths floor first (every mode)', () => {
    // The arm above used to expect ALLOWED from the home cwd too. F1.1120 (155054b9c)
    // taught getDeniedPathViolation to judge a RELATIVE Bash token at the SESSION working
    // directory, and P6.673's fail-closed heuristic (mode-manager.ts matchesDeniedPath)
    // reads the unresolvable `$D` segment as possibly `~/.ssh` there — a mode-independent
    // refusal that runs ahead of the record guard and of bypassPermissions' early return.
    // The record guard's substitution is unchanged (the arm above proves it); this is the
    // credential floor's own verdict, re-derived 2026-10-10.
    expect(bash(HOME, `D=${ROOT}; D=${PROJECT}; printf '{}' > $D/permissions.json`, 'bypassPermissions')).toEqual({ type: 'block', record: false })
    expect(bash(HOME, `D=${ROOT}; D=${PROJECT}; printf '{}' > $D/permissions.json`, 'default')).toEqual({ type: 'block', record: false })
  })

  it('STATED limit: a value the shell produces ($(…)) is not followed (bypassPermissions allows)', () => {
    expect(bash(PROJECT, `D=$(printf %s ${ROOT}); printf '{}' > $D/permissions.json`, 'bypassPermissions')).toEqual(ALLOWED)
  })
})
