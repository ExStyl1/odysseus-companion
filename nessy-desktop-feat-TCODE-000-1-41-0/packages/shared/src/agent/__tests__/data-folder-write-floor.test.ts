/**
 * F1.677 (WJ-crit-m, 2026-09-25) — an agent write into Nessy's DATA FOLDER (the
 * real `CONFIG_DIR`, whatever it is named) when the project folder CONTAINS it or
 * IS it, on the one gate claude's PreToolUse hook and Pi's `pre_tool_use` bridge
 * both call (`runPreToolUseChecks`, `workspaceRootPath` = the session's managed
 * workspace root, `workingDirectory` = the session cwd).
 *
 * ## The reading, taken first (host-level probe; the readings are in the F1.677 plan note)
 *
 * The protected-path floor keyed Nessy's data folder on the LITERAL segment
 * `.nessy-agent` (`protected-paths.ts` `PROTECTED_DIRECTORIES`,
 * `session-filesystem-scope.ts` `SHELL_GATED_AGENT_CONFIG_DIRS`). A relocated
 * `NESSY_CONFIG_DIR` — the dev multi-instance `~/.nessy-agent-1`, a sitting's
 * `~/.nessy-agent-sit`, this very test process's temp dir — carries no such
 * segment, so with the project folder containing it (the home directory, the
 * folder holding it) or being it:
 *
 *  - `acceptEdits` and `auto` answered ALLOW, with no card, for a `Write`/`Edit`
 *    of the global `hooks.json`, `mcp.json`, `config.json`,
 *    `permissions/default.json`, a new `skills/<x>/SKILL.md` and another
 *    workspace's records (and `auto` for a `cp` into them). The global
 *    `hooks.json` is the operator's pre-authorised hook tier (D1.343): its command
 *    hooks run with NO card on the next session.
 *  - `default` answered an ordinary, rememberable card where the default layout
 *    answers the non-negotiable `protectedPath` floor.
 *  - With the default name and the project folder = the data folder itself, a
 *    cwd-relative spelling (`hooks.json`) walked past the segment match the same
 *    way.
 *
 * ## The fix, and what it is not
 *
 * The data folder joins the protected-path floor by LOCATION as well as by name:
 * a write target resolved (against the cwd and every `cd` target, with `~` /
 * `$HOME` expanded — F1.660's shell-token resolution) to a path inside the real
 * `CONFIG_DIR`, compared as written and by real path, raises the same floor with
 * the same per-mode table (`protectedPathOutcome`). So a relocated data folder
 * now answers exactly what the default layout answers — including
 * `bypassPermissions`, which ALLOWS on both, by the documented contract
 * (`permission-modes.md#protected-paths`: "never auto-approved, except in
 * `bypassPermissions` mode"). The session's OWN workspace root was carved out (until F1.703, which carves the session's own working folders instead, on both layouts):
 * it is a no-project session's working folder, and its trusted records keep
 * their own floors (the record guard, F1.123's hook-record card).
 *
 * F1.701 (WJ-crit-o, 2026-09-25, DECIDED by the controller) flips the posture for
 * four of the targets below: the global `hooks.json`, `mcp.json`, `config.json`
 * and `permissions/*` are refused by the record guard in EVERY mode, bypass
 * included (`global-control-record-guard.test.ts`), before this floor is asked —
 * so they are pinned here as `block`, and the rest of the data folder keeps the
 * floor's own table. F1.712 (WJ-crit-s, 2026-09-25, DECIDED by the controller)
 * flips two more: ANOTHER workspace's `permissions.json` and `hooks.json`, which
 * this suite pinned as ALLOWED in bypass, are refused in every mode the same way
 * (`other-workspace-record-guard.test.ts`).
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { CONFIG_DIR } from '../../config/paths.ts'

/**
 * F1.764 — the per-case budget, sized to this file's cold start rather than bun's
 * 5 000 ms default. Same value and reason in `global-control-record-guard.test.ts`
 * and `other-workspace-record-guard.test.ts`, which load the same static graph.
 *
 * Every case here is synchronous and warm at 0.03-0.25 s (junit, 2026-09-26), yet
 * under load ONE early case per suite ran past 5 000 ms (F1.725's note, the same
 * at HEAD): the process's cold start lands on whichever case first drives the gate.
 * Bun judges a synchronous case after it returns (probe, 2026-09-26: a 5.6 s
 * synchronous case fails "timed out after 5000ms" by default and passes under
 * `setDefaultTimeout(60_000)`), so the budget is the lever, and a larger one hides
 * no hang — bun cannot interrupt a synchronous case anyway.
 *
 * Readings (bun 1.3.14, this Mac, 2026-09-26): the zero-case control
 * (`-t '<matches nothing>'`) 18.84-19.40 s over the three files at load ~10, under
 * 5 % cpu (I/O, not contention); the largest full run 73.75 s (this file, cold)
 * with 1.06 s of cases. Sized above that largest run total, by
 * `testing/module-graph-budgets.ts`'s sizing rule, as a named constant of its own
 * because none of that module's three numbers is a budget this small.
 */
const COLD_START_CASE_BUDGET_MS = 120_000
setDefaultTimeout(COLD_START_CASE_BUDGET_MS)

const KEY = { workspaceId: 'ws-own', sessionId: 'session-f1677' }
const WS_OWN = join(CONFIG_DIR, 'workspaces', KEY.workspaceId)
const WS_OTHER = join(CONFIG_DIR, 'workspaces', 'ws-other')
const SIBLING = mkdtempSync(join(tmpdir(), 'f1677-sibling-project-'))

// Real files, so the real-path comparison sees real paths (the process's own isolated config dir).
for (const d of [WS_OWN, WS_OTHER, join(CONFIG_DIR, 'permissions'), join(CONFIG_DIR, 'skills')]) mkdirSync(d, { recursive: true })
for (const f of [join(CONFIG_DIR, 'hooks.json'), join(CONFIG_DIR, 'mcp.json'), join(CONFIG_DIR, 'permissions', 'default.json'), join(WS_OTHER, 'permissions.json')]) writeFileSync(f, '{}')

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

afterEach(() => { cleanupModeState(KEY) })

function check(cwd: string, toolName: string, input: Record<string, unknown>, mode: PermissionMode): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const r = runPreToolUseChecks({
    toolName, input, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: mode,
    workspaceRootPath: WS_OWN, workspaceId: KEY.workspaceId, workingDirectory: cwd,
    activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
  })
  if (r.type === 'prompt') return r.nonNegotiable === 'protectedPath' ? 'floor' : `card(${r.promptType})`
  if (r.type === 'block') {
    // `dont_ask_would_prompt` marks a denial a PermissionRequest hook may re-open;
    // the floor's own denial must never carry it.
    if (r.source === 'dont_ask_would_prompt') return 'block(reopenable)'
    return /protected path/.test(r.reason) ? 'floor-deny' : 'block'
  }
  return r.type
}

/** F1.701 — refused by the record guard in every mode (in `dontAsk` the floor's own final denial may answer first); F1.712 — another workspace's records too. */
const GLOBAL_CONTROL_RECORDS = new Set([join(CONFIG_DIR, 'hooks.json'), join(CONFIG_DIR, 'mcp.json'), join(CONFIG_DIR, 'config.json'), join(CONFIG_DIR, 'permissions', 'default.json'), join(WS_OTHER, 'permissions.json'), join(WS_OTHER, 'hooks.json')])

const TARGETS = [
  join(CONFIG_DIR, 'hooks.json'),
  join(CONFIG_DIR, 'mcp.json'),
  join(CONFIG_DIR, 'config.json'),
  join(CONFIG_DIR, 'permissions', 'default.json'),
  join(CONFIG_DIR, 'skills', 'evil', 'SKILL.md'),
  join(WS_OTHER, 'permissions.json'),
  join(WS_OTHER, 'hooks.json'),
]

function spellings(cwd: string, abs: string): Array<[string, string, Record<string, unknown>]> {
  const rel = relative(cwd, abs)
  const base = abs.slice(dirname(abs).length + 1)
  return [
    ['bash-abs', 'Bash', { command: `printf '{}' > ${abs}` }],
    ['bash-rel', 'Bash', { command: `printf '{}' > ${rel}` }],
    ['bash-cd', 'Bash', { command: `cd ${relative(cwd, dirname(abs)) || '.'} && printf '{}' > ${base}` }],
    ['bash-c', 'Bash', { command: `bash -c "printf x > ${abs}"` }],
    ['bash-cp', 'Bash', { command: `cp /etc/hosts ${abs}` }],
    ['write-abs', 'Write', { file_path: abs, content: '{}' }],
    ['write-rel', 'Write', { file_path: rel, content: '{}' }],
    ['edit-abs', 'Edit', { file_path: abs, old_string: '{}', new_string: '{"x":1}' }],
  ]
}

/** Every (target, spelling) whose verdict is not `expected`, labelled — `[]` is the pass. */
function misses(cwd: string, mode: PermissionMode, expected: string | ((verdict: string) => boolean)): string[] {
  const accept = typeof expected === 'string' ? (verdict: string) => verdict === expected : expected
  const out: string[] = []
  for (const abs of TARGETS) {
    for (const [label, tool, input] of spellings(cwd, abs)) {
      const verdict = check(cwd, tool, input, mode)
      // F1.701 STATED over-read: from the data folder itself, `cd workspaces/ws-other && … > hooks.json` is also read against the cwd, onto the global hooks.json (since F1.712 the real target is refused too; only the named file differs).
      const statedOverBlock = cwd === CONFIG_DIR && label === 'bash-cd' && abs === join(WS_OTHER, 'hooks.json') && verdict === 'block'
      const ok = GLOBAL_CONTROL_RECORDS.has(abs) && mode !== 'dontAsk' ? verdict === 'block' : accept(verdict) || statedOverBlock
      if (!ok) out.push(`${relative(CONFIG_DIR, abs)} ${label} -> ${verdict}`)
    }
  }
  return out
}

const LAYOUTS: Array<[string, string]> = [
  ['the project folder CONTAINS the data folder', dirname(CONFIG_DIR)],
  ['the project folder IS the data folder', CONFIG_DIR],
  ['the project folder is <data folder>/workspaces', join(CONFIG_DIR, 'workspaces')],
  ['a sibling project folder (the data folder outside the project)', SIBLING],
]

describe('F1.677 — a relocated data folder raises the protected-path floor, as the default layout does', () => {
  it('the test process runs on a RELOCATED data folder (no `.nessy-agent` segment answers instead)', () => {
    expect(CONFIG_DIR.split(/[/\\]/)).not.toContain('.nessy-agent')
  })

  for (const [name, cwd] of LAYOUTS) {
    for (const mode of ['default', 'acceptEdits', 'auto'] as const) {
      it(`${name}, ${mode}: every write spelling raises the non-negotiable floor`, () => {
        expect(misses(cwd, mode, 'floor')).toEqual([])
      })
    }
    it(`${name}, dontAsk: every write spelling is denied, and no PermissionRequest hook may re-open the denial`, () => {
      expect(misses(cwd, 'dontAsk', verdict => verdict === 'floor-deny' || verdict === 'block')).toEqual([])
    })
  }

  it('bypassPermissions ALLOWS the rest of the data folder, as the default layout does (the documented protected-path table), and REFUSES the four global control records (F1.701) and another workspace\'s records (F1.712) — the posture pin', () => {
    expect(misses(dirname(CONFIG_DIR), 'bypassPermissions', 'allow')).toEqual([])
  })
})

describe('F1.677 — CONTROLS', () => {
  it('a write inside a sibling project is unchanged: allowed in acceptEdits and bypass, an ordinary card in default', () => {
    const notes = join(SIBLING, 'notes.txt')
    expect(check(SIBLING, 'Write', { file_path: notes, content: 'x' }, 'acceptEdits')).toBe('allow')
    expect(check(SIBLING, 'Bash', { command: `printf x > ${notes}` }, 'bypassPermissions')).toBe('allow')
    expect(check(SIBLING, 'Write', { file_path: notes, content: 'x' }, 'default')).toBe('card(file_write)')
  })

  it('a write inside the session\'s OWN workspace root takes the floor, as the default layout does (F1.703)', () => {
    // F1.703 (owner's option a): this root was carved out here until 2026-09-28, which left its
    // `sources/` open on a relocated install only; the carve-out is now the session's own working
    // folders, on both layouts (`session-working-folder-floor.test.ts`).
    const notes = join(WS_OWN, 'notes.txt')
    expect(check(WS_OWN, 'Write', { file_path: notes, content: 'x' }, 'acceptEdits')).toBe('floor')
    expect(check(WS_OWN, 'Bash', { command: `printf x > notes.txt` }, 'default')).toBe('floor')
    // its records keep their own floors: the record guard refuses permissions.json in every mode
    expect(check(WS_OWN, 'Write', { file_path: join(WS_OWN, 'permissions.json'), content: '{}' }, 'bypassPermissions')).toBe('block')
  })

  it('a READ of the data folder raises no floor (only writes are protected)', () => {
    // F1.701: a SHELL read of the four global control records is refused (read/write blind, F1.124) — pinned in global-control-record-guard.test.ts.
    expect(check(dirname(CONFIG_DIR), 'Bash', { command: `cat ${join(CONFIG_DIR, 'skills', 'evil', 'SKILL.md')}` }, 'bypassPermissions')).toBe('allow')
    expect(check(dirname(CONFIG_DIR), 'Read', { file_path: join(CONFIG_DIR, 'hooks.json') }, 'acceptEdits')).toBe('allow')
  })

  it('a path that merely SHARES the data folder\'s name as a prefix is not inside it', () => {
    const lookalike = `${CONFIG_DIR}-other/hooks.json`
    expect(check(dirname(CONFIG_DIR), 'Write', { file_path: lookalike, content: '{}' }, 'acceptEdits')).toBe('allow')
  })
})

/**
 * F1.737 (DN-023, 2026-09-26) — the floor's card offers no Always Allow. SIT-v
 * (packaged `5896a66d2`, pi and claude-gateway) saw this very card say "never
 * approved automatically" above an Always Allow that "remembers this for the
 * session": nothing a click saves is read before this floor. The gate now marks
 * the prompt `noAlwaysAllow` (the field the renderer's `canRemember` reads); the
 * two card builders forward it (`protected-path-card-no-always-allow.test.ts`).
 */
describe('F1.737 — the protected-path prompt offers no Always Allow', () => {
  function prompt(cwd: string, toolName: string, input: Record<string, unknown>, mode: PermissionMode) {
    cleanupModeState(KEY)
    initializeModeState(KEY, mode)
    const r = runPreToolUseChecks({
      toolName, input, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: mode,
      workspaceRootPath: WS_OWN, workspaceId: KEY.workspaceId, workingDirectory: cwd,
      activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
    })
    return r.type === 'prompt' ? { nonNegotiable: r.nonNegotiable, noAlwaysAllow: r.noAlwaysAllow } : { type: r.type }
  }
  const skill = join(CONFIG_DIR, 'skills', 'evil', 'SKILL.md')

  for (const mode of ['default', 'acceptEdits', 'auto'] as const) {
    it(`${mode}: the floor's file-tool and shell prompts both carry noAlwaysAllow`, () => {
      expect(prompt(dirname(CONFIG_DIR), 'Write', { file_path: skill, content: 'x' }, mode)).toEqual({ nonNegotiable: 'protectedPath', noAlwaysAllow: true })
      expect(prompt(dirname(CONFIG_DIR), 'Bash', { command: `printf x > ${skill}` }, mode)).toEqual({ nonNegotiable: 'protectedPath', noAlwaysAllow: true })
    })
  }

  it('CONTROL: an ordinary write card in a sibling project keeps its Always Allow (no noAlwaysAllow)', () => {
    const notes = join(SIBLING, 'notes.txt')
    expect(prompt(SIBLING, 'Write', { file_path: notes, content: 'x' }, 'default')).toEqual({ nonNegotiable: undefined, noAlwaysAllow: undefined })
    // UA12.70 — a redirect mints no Always Allow key (upstream v0.14.0), so the shell control is a keyed command.
    expect(prompt(SIBLING, 'Bash', { command: `touch ${notes}` }, 'default')).toEqual({ nonNegotiable: undefined, noAlwaysAllow: undefined })
  })
})

process.on('exit', () => { rmSync(SIBLING, { recursive: true, force: true }) })
