/**
 * F1.701 (WJ-crit-o, 2026-09-25) — Nessy's GLOBAL control records bind every
 * permission mode, `bypassPermissions` included, as the workspace records do.
 *
 * ## The reading, taken first (host probe; the readings are in the F1.701 plan note)
 *
 * On the one gate claude's PreToolUse hook and Pi's pre_tool_use bridge both call
 * (`runPreToolUseChecks`), a write to `<CONFIG_DIR>/hooks.json`, `mcp.json`,
 * `config.json` or anything under `permissions/` answered the protected-path card
 * in `default`/`acceptEdits`/`auto` (an ordinary Bash card, and ALLOW in `auto`,
 * for `sed -i` and `python3 -c` spellings the floor's write test missed with an
 * unloaded read-only list) and ALLOW with no card in `bypassPermissions` — on
 * every layout, the default `~/.nessy-agent` one included, by the documented
 * protected-path table. An agent in bypass could therefore grant ITSELF, for every
 * later session in any mode: a no-card command hook (the global `hooks.json` is the
 * operator's pre-authorised tier, D1.343), an MCP server, permission rules, or a
 * connection. That is the self-granting class D1.434 / D1.438 made bind bypass for
 * the WORKSPACE records.
 *
 * ## The decision (the controller's, 2026-09-25) and what it is not
 *
 * The four records join the record guard (`getAutomationConfigMutationGuard`,
 * step 5b), resolved by the REAL `CONFIG_DIR` with F1.660/F1.692's resolution, and
 * refused in every mode with a message naming the file and the reason. Skills and
 * plans stay writable (ordinary agent work); the workspace records keep their own
 * guard; reads through the Read tool are unaffected. The shell arm is read/write
 * BLIND, as the workspace records' arm is by F1.124's decision (a read/write split
 * is a write-detector, and a gap in one is a gap in a floor that binds bypass):
 * a `cat` of one of these files is refused too, and the message names the Read tool.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { CONFIG_DIR } from '../../config/paths.ts'
import { HOST_APPROVALS_SEALED_KEY_FILE } from '../../approvals/host-approvals.ts'

// F1.764 — the per-case budget, sized to the cold start (an early case under load
// ran past bun's 5 000 ms default). Same value and reason as
// `data-folder-write-floor.test.ts`, whose comment carries the readings; this
// file's zero-case control read 18.84 s at load ~10 (2026-09-26).
const COLD_START_CASE_BUDGET_MS = 120_000
setDefaultTimeout(COLD_START_CASE_BUDGET_MS)

const KEY = { workspaceId: 'ws-f1701', sessionId: 'session-f1701' }
const WS_OWN = join(CONFIG_DIR, 'workspaces', KEY.workspaceId)
const SIBLING = mkdtempSync(join(tmpdir(), 'f1701-sibling-project-'))

// Real files in this process's own isolated config dir, so the real-path comparison sees real paths.
for (const d of [WS_OWN, join(CONFIG_DIR, 'permissions'), join(CONFIG_DIR, 'skills')]) mkdirSync(d, { recursive: true })
for (const f of [join(CONFIG_DIR, 'hooks.json'), join(CONFIG_DIR, 'mcp.json'), join(CONFIG_DIR, 'permissions', 'default.json')]) writeFileSync(f, '{}')

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

afterEach(() => { cleanupModeState(KEY) })

/** The gate's verdict; `record:<name>` only for THIS guard's refusal naming `<name>`. */
function check(cwd: string, toolName: string, input: Record<string, unknown>, mode: PermissionMode): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const r = runPreToolUseChecks({
    toolName, input, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: mode,
    workspaceRootPath: WS_OWN, workspaceId: KEY.workspaceId, workingDirectory: cwd,
    activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
  })
  if (r.type === 'block') {
    const named = /targeting `([^`]+)` are blocked in every permission mode/.exec(r.reason)?.[1]
    // `dont_ask_would_prompt` marks a denial a PermissionRequest hook may re-open.
    return named ? `record:${named}` : r.source === 'dont_ask_would_prompt' ? 'block(reopenable)' : 'block'
  }
  if (r.type === 'prompt') return r.nonNegotiable === 'protectedPath' ? 'floor' : `card(${r.promptType})`
  return r.type
}

const RECORDS: Array<[string, string]> = [
  ['hooks.json', join(CONFIG_DIR, 'hooks.json')],
  ['mcp.json', join(CONFIG_DIR, 'mcp.json')],
  ['config.json', join(CONFIG_DIR, 'config.json')],
  ['permissions/default.json', join(CONFIG_DIR, 'permissions', 'default.json')],
  ['permissions/extra.json', join(CONFIG_DIR, 'permissions', 'extra.json')],
]

function spellings(cwd: string, abs: string): Array<[string, string, Record<string, unknown>]> {
  const rel = relative(cwd, abs)
  const base = abs.slice(dirname(abs).length + 1)
  return [
    ['bash-abs', 'Bash', { command: `printf '{}' > ${abs}` }],
    ['bash-rel', 'Bash', { command: `printf '{}' > ${rel}` }],
    ['bash-cd', 'Bash', { command: `cd -P ${relative(cwd, dirname(abs)) || '.'} && printf '{}' > ${base}` }],
    ['bash-c', 'Bash', { command: `bash -c "printf x > ${abs}"` }],
    ['bash-cp', 'Bash', { command: `cp /etc/hosts ${abs}` }],
    ['bash-sed-i', 'Bash', { command: `sed -i '' 's/a/b/' ${abs}` }],
    ['bash-python', 'Bash', { command: `python3 -c "open('${abs}','w').write('{}')"` }],
    ['bash-upper-case', 'Bash', { command: `printf '{}' > ${dirname(abs)}/${base.toUpperCase()}` }],
    ['write-abs', 'Write', { file_path: abs, content: '{}' }],
    ['write-rel', 'Write', { file_path: rel, content: '{}' }],
    ['edit-abs', 'Edit', { file_path: abs, old_string: '{}', new_string: '{"x":1}' }],
  ]
}

/** Every (record, spelling) NOT refused by this guard with the record named (or, in `dontAsk`, by the floor's own final denial) — `[]` is the pass. */
function misses(cwd: string, mode: PermissionMode): string[] {
  const out: string[] = []
  for (const [name, abs] of RECORDS) {
    for (const [label, tool, input] of spellings(cwd, abs)) {
      const verdict = check(cwd, tool, input, mode)
      // A `cd` into the permissions folder is itself refused, naming the folder.
      const refused = verdict === `record:${name}` || (name.startsWith('permissions/') && verdict === 'record:permissions')
      // `dontAsk` denies a would-prompt call before step 5b is reached; for a record write that denial must be FINAL.
      if (!refused && !(mode === 'dontAsk' && verdict === 'block')) out.push(`${name} ${label} -> ${verdict}`)
    }
  }
  return out
}

const LAYOUTS: Array<[string, string]> = [
  ['the project folder CONTAINS the data folder', dirname(CONFIG_DIR)],
  ['the project folder IS the data folder', CONFIG_DIR],
  ['a sibling project folder', SIBLING],
]
const MODES: PermissionMode[] = ['bypassPermissions', 'default', 'acceptEdits', 'auto']

describe('F1.701 — the global control records are refused in EVERY mode, bypassPermissions included', () => {
  for (const [name, cwd] of LAYOUTS) {
    for (const mode of [...MODES, 'dontAsk'] as const) {
      it(`${name}, ${mode}: every write spelling is refused, naming the record`, () => {
        expect(misses(cwd, mode)).toEqual([])
      })
    }
  }

  it('the permissions FOLDER itself is covered (a move or removal of it)', () => {
    const dir = join(CONFIG_DIR, 'permissions')
    expect(check(SIBLING, 'Bash', { command: `mv ${dir} ${dir}.bak` }, 'bypassPermissions')).toBe('record:permissions')
    expect(check(SIBLING, 'Bash', { command: `rm -rf ${dir}` }, 'bypassPermissions')).toBe('record:permissions')
  })

  it('the refusal names the file and the reason', () => {
    cleanupModeState(KEY)
    initializeModeState(KEY, 'bypassPermissions')
    const r = runPreToolUseChecks({
      toolName: 'Write', input: { file_path: join(CONFIG_DIR, 'hooks.json'), content: '{}' },
      sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: 'bypassPermissions',
      workspaceRootPath: WS_OWN, workspaceId: KEY.workspaceId, workingDirectory: SIBLING,
      activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
    })
    const reason = r.type === 'block' ? r.reason : ''
    expect(reason).toContain('`hooks.json`')
    expect(reason).toContain('every later session')
  })
})

describe('F1.701 — CONTROLS', () => {
  it('a skill write and a plan write in bypassPermissions still land', () => {
    expect(check(SIBLING, 'Write', { file_path: join(CONFIG_DIR, 'skills', 'x', 'SKILL.md'), content: '# x' }, 'bypassPermissions')).toBe('allow')
    expect(check(SIBLING, 'Bash', { command: `printf x > ${join(CONFIG_DIR, 'plans', 'p.md')}` }, 'bypassPermissions')).toBe('allow')
  })

  it('a write inside a sibling project is allowed, its own mcp.json and config.json included', () => {
    expect(check(SIBLING, 'Write', { file_path: join(SIBLING, 'notes.txt'), content: 'x' }, 'bypassPermissions')).toBe('allow')
    expect(check(SIBLING, 'Bash', { command: `printf '{}' > mcp.json && printf '{}' > config.json` }, 'bypassPermissions')).toBe('allow')
  })

  it('the Read tool reads every global record in every mode', () => {
    for (const mode of MODES) {
      for (const [, abs] of RECORDS) expect(check(SIBLING, 'Read', { file_path: abs }, mode)).toBe('allow')
    }
  })

  it('the workspace records keep their own guard and message; the workspace hooks.json is unchanged (writable in bypass)', () => {
    expect(check(WS_OWN, 'Write', { file_path: join(WS_OWN, 'permissions.json'), content: '{}' }, 'bypassPermissions')).toBe('block')
    expect(check(WS_OWN, 'Write', { file_path: join(WS_OWN, 'hooks.json'), content: '{}' }, 'bypassPermissions')).toBe('allow')
  })

  it('a path that merely SHARES the data folder\'s name as a prefix is not a record', () => {
    expect(check(SIBLING, 'Write', { file_path: `${CONFIG_DIR}-other/hooks.json`, content: '{}' }, 'bypassPermissions')).toBe('allow')
  })

  it('STATED (F1.124, uniform with the workspace records): a shell READ of a global record is refused too; the Read tool is the read door', () => {
    expect(check(SIBLING, 'Bash', { command: `cat ${join(CONFIG_DIR, 'hooks.json')}` }, 'bypassPermissions')).toBe('record:hooks.json')
  })
})

/**
 * UA12.23 (LF-1, 2026-10-09) — the desktop's sealed host-approvals key, `<CONFIG_DIR>/host-approvals-key.sealed`
 * (`approvals/host-approvals.ts` HOST_APPROVALS_SEALED_KEY_FILE), joins the global control records: an agent that
 * deletes it makes the host mint a fresh key, so every page grant, script, refresh and task confirmation is asked
 * again; one that alters it fails every approval closed. Denial of service only — the blob is ciphertext to an
 * agent, so neither spelling forges an approval. RED at `d1da7a083`: ALLOW in bypassPermissions, the protected-path
 * card elsewhere. Every write AND delete spelling is refused in every mode on Pi and Claude; the Read tool stays the
 * read door (the shell arm is read/write blind, F1.124).
 */
const SEALED_KEY = 'host-approvals-key.sealed'
writeFileSync(join(CONFIG_DIR, SEALED_KEY), 'c2VhbGVk\n')

function sealedKeyMisses(cwd: string, mode: PermissionMode): string[] {
  const abs = join(CONFIG_DIR, SEALED_KEY)
  const deletes: Array<[string, string, Record<string, unknown>]> = [
    ['rm-abs', 'Bash', { command: `rm -f ${abs}` }],
    ['rm-rel', 'Bash', { command: `rm -f ${relative(cwd, abs)}` }],
    ['cd-rm-bare-name', 'Bash', { command: `cd ${CONFIG_DIR} && rm ${SEALED_KEY}` }],
    ['mv-away', 'Bash', { command: `mv ${abs} ${join(SIBLING, 'k')}` }],
    ['unlink', 'Bash', { command: `unlink ${abs}` }],
    ['truncate', 'Bash', { command: `: > ${abs}` }],
  ]
  return [...spellings(cwd, abs), ...deletes].flatMap(([label, tool, input]) => {
    const verdict = check(cwd, tool, input, mode)
    return verdict === `record:${SEALED_KEY}` || (mode === 'dontAsk' && verdict === 'block') ? [] : [`${label} -> ${verdict}`]
  })
}

describe('UA12.23 — the sealed host-approvals key is refused to agent writes and deletes in EVERY mode, bypassPermissions included', () => {
  for (const [name, cwd] of LAYOUTS) {
    for (const mode of [...MODES, 'dontAsk'] as const) {
      it(`${name}, ${mode}: every write and delete spelling is refused, naming the key file`, () => {
        expect(sealedKeyMisses(cwd, mode)).toEqual([])
      })
    }
  }

  it('a bare name from the data folder itself is read as the key (the token filter knows a global record\'s own name)', () => {
    expect(check(CONFIG_DIR, 'Bash', { command: `rm -f ${SEALED_KEY}` }, 'bypassPermissions')).toBe(`record:${SEALED_KEY}`)
  })

  it('the refusal names the key, the denial of service, and no Settings door that does not exist', () => {
    cleanupModeState(KEY)
    initializeModeState(KEY, 'bypassPermissions')
    const r = runPreToolUseChecks({
      toolName: 'Bash', input: { command: `rm -f ${join(CONFIG_DIR, SEALED_KEY)}` },
      sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: 'bypassPermissions',
      workspaceRootPath: WS_OWN, workspaceId: KEY.workspaceId, workingDirectory: SIBLING,
      activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
    })
    const reason = r.type === 'block' ? r.reason : `not refused: ${r.type}`
    expect(reason).toContain(`\`${SEALED_KEY}\``)
    expect(reason).toContain('approved again')
    expect(reason).not.toContain('Settings')
  })
})

describe('UA12.23 — CONTROLS', () => {
  it('PIN: the guarded name is the one the desktop key provider writes (approvals/host-approvals.ts)', () => {
    expect(SEALED_KEY).toBe(HOST_APPROVALS_SEALED_KEY_FILE)
  })

  it('the Read tool reads the key file in every mode', () => {
    for (const mode of MODES) expect(check(SIBLING, 'Read', { file_path: join(CONFIG_DIR, SEALED_KEY) }, mode)).toBe('allow')
  })

  it('a look-alike name is not the key: another suffix in the data folder, and the same name inside a workspace', () => {
    expect(check(SIBLING, 'Write', { file_path: join(CONFIG_DIR, `${SEALED_KEY}.bak`), content: 'x' }, 'bypassPermissions')).toBe('allow')
    expect(check(SIBLING, 'Write', { file_path: join(WS_OWN, SEALED_KEY), content: 'x' }, 'bypassPermissions')).toBe('allow')
  })
})

process.on('exit', () => { rmSync(SIBLING, { recursive: true, force: true }) })
