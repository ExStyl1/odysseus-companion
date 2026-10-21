/**
 * F1.712 (WJ-crit-s, 2026-09-25) — EVERY workspace's records bind every
 * permission mode, `bypassPermissions` included, not only the session's own.
 *
 * ## The reading, taken first (host probe `work/wjcrits/probe.ts`; readings in the F1.712 plan note)
 *
 * On the one gate claude's PreToolUse hook and Pi's pre_tool_use bridge both call
 * (`runPreToolUseChecks`), a write to ANOTHER workspace's `permissions.json`,
 * `automations.json`, `automations-history.jsonl` or `hooks.json` under
 * `<CONFIG_DIR>/workspaces/<other>/` answered ALLOW with no card in
 * `bypassPermissions` for 176 of 180 spellings on each config-dir layout, the
 * default `~/.nessy-agent` one included (the four refusals were a `cd` spelling
 * whose bare name was read against the cwd onto a DIFFERENT record), and the
 * protected-path card, approvable once, in `default`/`acceptEdits`/`auto`. The
 * record guard (`getAutomationConfigMutationGuard`, D1.434 / D1.438) knew only the
 * session's OWN workspace root, and F1.677's own suite pinned the other
 * workspace's records as ALLOWED in bypass. A sibling `permissions.json` is
 * ADDITIVE by its own header, so an agent in bypass could grant rules to every
 * session of that other workspace, in every mode.
 *
 * ## The decision (the controller's, 2026-09-25) and what it is not
 *
 * The four records of every `<CONFIG_DIR>/workspaces/<id>/` join the every-mode
 * record refusal F1.701 built (`globalControlRecordWrite`, step 5b), with its
 * resolution (the real `CONFIG_DIR`, as written and by real path, any letter case,
 * every `cd` target, the three scan copies) and its message shape (the file, the
 * reason, the Read tool as the read door). The session's OWN workspace is carved
 * out and keeps its own floors unchanged: the record guard for its three records,
 * F1.123's card for its `hooks.json`. An ORDINARY file in another workspace's
 * folder keeps F1.677's data-folder floor. The shell arm is read/write BLIND, as
 * both record arms already are (F1.124): a `cat` of another workspace's record is
 * refused too.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { CONFIG_DIR } from '../../config/paths.ts'

// F1.764 — the per-case budget, sized to the cold start (an early case under load
// ran past bun's 5 000 ms default). Same value and reason as
// `data-folder-write-floor.test.ts`, whose comment carries the readings; this
// file's zero-case control read 19.17 s at load ~10 (2026-09-26).
const COLD_START_CASE_BUDGET_MS = 120_000
setDefaultTimeout(COLD_START_CASE_BUDGET_MS)

const KEY = { workspaceId: 'ws-f1712', sessionId: 'session-f1712' }
const WS_OWN = join(CONFIG_DIR, 'workspaces', KEY.workspaceId)
const WS_OTHER = join(CONFIG_DIR, 'workspaces', 'ws-f1712-other')
const SIBLING = mkdtempSync(join(tmpdir(), 'f1712-sibling-project-'))
const RECORDS = ['permissions.json', 'automations.json', 'automations-history.jsonl', 'hooks.json', 'host-approvals.json'] // UA1.10 follow-up: + the host-approvals ledger

// Real files in this process's own isolated config dir, so the real-path comparison sees real paths.
for (const d of [WS_OWN, WS_OTHER]) mkdirSync(d, { recursive: true })
for (const f of RECORDS) { writeFileSync(join(WS_OWN, f), '{}'); writeFileSync(join(WS_OTHER, f), '{}') }

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

afterEach(() => { cleanupModeState(KEY) })

function gate(cwd: string, toolName: string, input: Record<string, unknown>, mode: PermissionMode) {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  return runPreToolUseChecks({
    toolName, input, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: mode,
    workspaceRootPath: WS_OWN, workspaceId: KEY.workspaceId, workingDirectory: cwd,
    activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
  })
}

/** The gate's verdict; `record:<name>` for the every-mode record refusal naming `<name>`, `own-record` for the own workspace's record guard. */
function check(cwd: string, toolName: string, input: Record<string, unknown>, mode: PermissionMode): string {
  const r = gate(cwd, toolName, input, mode)
  if (r.type === 'block') {
    const named = /targeting `([^`]+)` are blocked in every permission mode/.exec(r.reason)?.[1]
    if (named) return `record:${named}`
    const folder = /(?:moving or removing|writing into) `([^`]+)` are blocked in every permission mode/.exec(r.reason)?.[1] // F1.722, F1.922
    if (folder) return `folder:${folder}`
    if (/^Direct \w+ operations (?:in|targeting) \S+ are blocked\. /.test(r.reason)) return 'own-record'
    // `dont_ask_would_prompt` marks a denial a PermissionRequest hook may re-open.
    return r.source === 'dont_ask_would_prompt' ? 'block(reopenable)' : /protected path/.test(r.reason) ? 'floor-deny' : 'block'
  }
  if (r.type === 'prompt') return r.nonNegotiable === 'protectedPath' ? 'floor' : `card(${r.promptType})`
  return r.type
}

function spellings(cwd: string, abs: string): Array<[string, string, Record<string, unknown>]> {
  const rel = relative(cwd, abs)
  const base = abs.slice(dirname(abs).length + 1)
  const real = join(realpathSync(dirname(abs)), base)
  return [
    ['bash-abs', 'Bash', { command: `printf '{}' > ${abs}` }],
    ['bash-rel', 'Bash', { command: `printf '{}' > ${rel}` }],
    ['bash-cd', 'Bash', { command: `cd -P ${relative(cwd, dirname(abs)) || '.'} && printf '{}' > ${base}` }],
    ['bash-c', 'Bash', { command: `bash -c "printf x > ${abs}"` }],
    ['bash-cp', 'Bash', { command: `cp /etc/hosts ${abs}` }],
    ['bash-sed-i', 'Bash', { command: `sed -i '' 's/a/b/' ${abs}` }],
    ['bash-python', 'Bash', { command: `python3 -c "open('${abs}','w').write('{}')"` }],
    ['bash-upper-case', 'Bash', { command: `printf '{}' > ${dirname(abs).toUpperCase()}/${base.toUpperCase()}` }],
    ['bash-real-path', 'Bash', { command: `printf '{}' > ${real}` }],
    ['write-abs', 'Write', { file_path: abs, content: '{}' }],
    ['write-rel', 'Write', { file_path: rel, content: '{}' }],
    ['write-real-path', 'Write', { file_path: real, content: '{}' }],
    ['edit-abs', 'Edit', { file_path: abs, old_string: '{}', new_string: '{"x":1}' }],
  ]
}

/**
 * Every (record, spelling) NOT refused as a record write — `[]` is the pass. A refusal
 * may name a DIFFERENT record when a `cd` spelling's bare name also resolves against
 * the cwd onto one (the stated over-read, P-WJcrito-3): refused either way.
 */
function misses(cwd: string, mode: PermissionMode): string[] {
  const out: string[] = []
  for (const name of RECORDS) {
    for (const [label, tool, input] of spellings(cwd, join(WS_OTHER, name))) {
      const verdict = check(cwd, tool, input, mode)
      const refused = verdict.startsWith('record:') || verdict === 'own-record'
      // `dontAsk` denies a would-prompt call before step 5b is reached; for a record write that denial must be FINAL.
      if (!refused && !(mode === 'dontAsk' && (verdict === 'block' || verdict === 'floor-deny'))) out.push(`${name} ${label} -> ${verdict}`)
    }
  }
  return out
}

const LAYOUTS: Array<[string, string]> = [
  ['the project folder CONTAINS the data folder', dirname(CONFIG_DIR)],
  ['the project folder IS the data folder', CONFIG_DIR],
  ['the project folder is <data folder>/workspaces', join(CONFIG_DIR, 'workspaces')],
  ['the session\'s OWN workspace root (a no-project session)', WS_OWN],
  ['the OTHER workspace\'s own folder', WS_OTHER],
  ['a sibling project folder', SIBLING],
]
const MODES: PermissionMode[] = ['bypassPermissions', 'default', 'acceptEdits', 'auto']

describe('F1.712 — another workspace\'s records are refused in EVERY mode, bypassPermissions included', () => {
  for (const [name, cwd] of LAYOUTS) {
    for (const mode of [...MODES, 'dontAsk'] as const) {
      it(`${name}, ${mode}: every write spelling is refused as a record write`, () => {
        expect(misses(cwd, mode)).toEqual([])
      })
    }
  }

  it('the refusal names the other workspace\'s file and the reason, and points at the Read tool', () => {
    const otherRel = relative(CONFIG_DIR, WS_OTHER)
    for (const name of RECORDS) {
      for (const [tool, input] of [['Write', { file_path: join(WS_OTHER, name), content: '{}' }], ['Bash', { command: `printf '{}' > ${join(WS_OTHER, name)}` }]] as const) {
        const r = gate(SIBLING, tool, input, 'bypassPermissions')
        const reason = r.type === 'block' ? r.reason : `not refused: ${r.type}`
        expect(reason).toContain(`\`${otherRel}/${name}\``)
        expect(reason).toContain('another workspace')
        expect(reason).toContain('Read tool')
      }
    }
  })
})

describe('F1.712 — CONTROLS', () => {
  it('the OWN workspace is unchanged: its three records keep the record guard\'s own message, its hooks.json keeps F1.123 (writable in bypass, the card elsewhere)', () => {
    for (const name of ['permissions.json', 'automations.json', 'automations-history.jsonl']) {
      expect(check(WS_OWN, 'Write', { file_path: join(WS_OWN, name), content: '{}' }, 'bypassPermissions')).toBe('own-record')
      expect(check(SIBLING, 'Bash', { command: `printf '{}' > ${join(WS_OWN, name)}` }, 'bypassPermissions')).toBe('own-record')
    }
    expect(check(WS_OWN, 'Write', { file_path: join(WS_OWN, 'hooks.json'), content: '{}' }, 'bypassPermissions')).toBe('allow')
    expect(check(SIBLING, 'Bash', { command: `printf '{}' > ${join(WS_OWN, 'hooks.json')}` }, 'bypassPermissions')).toBe('allow')
    expect(check(WS_OWN, 'Write', { file_path: join(WS_OWN, 'hooks.json'), content: '{}' }, 'acceptEdits')).toBe('floor')
    expect(check(WS_OWN, 'Write', { file_path: join(WS_OWN.toUpperCase(), 'HOOKS.JSON'), content: '{}' }, 'bypassPermissions')).toBe('allow')
  })

  it('an ORDINARY file in another workspace\'s folder follows the data-folder floor as before (allowed in bypass, the floor elsewhere), a nested record name included', () => {
    for (const abs of [join(WS_OTHER, 'notes.md'), join(WS_OTHER, 'config.json'), join(WS_OTHER, 'sessions', 's1', 'permissions.json')]) {
      expect(check(SIBLING, 'Write', { file_path: abs, content: '{}' }, 'bypassPermissions')).toBe('allow')
      expect(check(SIBLING, 'Bash', { command: `printf '{}' > ${abs}` }, 'bypassPermissions')).toBe('allow')
      expect(check(SIBLING, 'Write', { file_path: abs, content: '{}' }, 'acceptEdits')).toBe('floor')
    }
  })

  it('a path that is not <data folder>/workspaces/<id>/<record> is not a record', () => {
    for (const abs of [
      `${CONFIG_DIR}-other/workspaces/ws-x/permissions.json`,
      join(CONFIG_DIR, 'workspaces-x', 'ws-x', 'permissions.json'),
      join(CONFIG_DIR, 'workspaces', 'permissions.json'),
      join(SIBLING, 'workspaces', 'ws-x', 'permissions.json'),
    ]) expect(check(SIBLING, 'Write', { file_path: abs, content: '{}' }, 'bypassPermissions')).toBe('allow')
  })

  it('the Read tool reads another workspace\'s records in every mode', () => {
    for (const mode of MODES) {
      for (const name of RECORDS) expect(check(SIBLING, 'Read', { file_path: join(WS_OTHER, name) }, mode)).toBe('allow')
    }
  })

  it('STATED (F1.124, uniform with both record arms): a shell READ of another workspace\'s record is refused too; the Read tool is the read door', () => {
    expect(check(SIBLING, 'Bash', { command: `cat ${join(WS_OTHER, 'permissions.json')}` }, 'bypassPermissions')).toBe(`record:${relative(CONFIG_DIR, WS_OTHER)}/permissions.json`)
  })
})

/**
 * F1.722 (DN-253, 2026-09-28) — a whole workspace FOLDER, and the two folders above it.
 *
 * The row's round trip — move another workspace's folder out, write its `permissions.json`, move it back — is
 * refused at HEAD since F1.922 (`74033faad`): the move BACK lands a folder whose names the command cannot read in
 * another workspace's folder (measured before this row: `mv`, `cp -R`, `rsync`, `ln -s` back and the whole chain
 * all refused in bypass and default). What still ran, measured with the same rig at `f5dfc6835`: the move or removal
 * of the folder ITSELF — `mv <other> /tmp/x`, `rm -rf <other>`, the `workspaces` folder, the data folder — ALLOW in
 * bypassPermissions and the data-folder floor's card elsewhere; so an agent could take away another workspace's
 * permission rules (its deny rules included) and automations. Now refused like its records, in every mode.
 *
 * And the message half (P-WJcrits-3): a `cd` spelling whose bare name ALSO resolves against the cwd onto a
 * different record named that other record; the record at the token's own directory is named now. F1.714's
 * over-block (a path read against a `cd` written after it) is not changed here: it still refuses.
 */
describe('F1.722 — moving or removing a folder that holds another workspace\'s records is refused in every mode', () => {
  const W = join(CONFIG_DIR, 'workspaces')
  const X = join(tmpdir(), 'f1722-away')
  const OTHER = relative(CONFIG_DIR, WS_OTHER)
  const refused: Array<[string, string, string]> = [
    ['mv the folder out', `mv ${WS_OTHER} ${X}`, `folder:${OTHER}`],
    ['rm -rf the folder', `rm -rf ${WS_OTHER}`, `folder:${OTHER}`],
    ['rm by a cd and a bare name', `cd ${W} && rm -rf ws-f1712-other`, `folder:${OTHER}`],
    ['rm by a wildcard', `rm -rf ${join(W, 'ws-f1712-oth*')}`, `folder:${OTHER}`],
    ['rm the folder\'s records by a wildcard', `rm -f ${WS_OTHER}/perm*.json`, `folder:${OTHER}/permissions.json`],
    ['/bin/rm, upper case, after --', `/bin/rm -r -- ${WS_OTHER.toUpperCase()}`, `folder:${OTHER}`],
    ['mv -t (the source is the operand)', `mv -t ${X} ${WS_OTHER}`, `folder:${OTHER}`],
    ['mv the workspaces folder', `mv ${W} ${X}`, 'folder:workspaces'],
    ['rm -rf the data folder', `rm -rf ${CONFIG_DIR}`, `folder:${CONFIG_DIR}`],
    ['the row\'s round trip (F1.922 refuses the move back)', `mv ${WS_OTHER} ${X} && printf '{}' > ${X}/permissions.json && mv ${X} ${WS_OTHER}`, `folder:${OTHER}`],
  ]
  for (const mode of MODES) {
    it(`${mode}: each spelling is refused, naming the folder`, () => {
      // RED at f5dfc6835: `allow` in bypassPermissions and `floor` in the asking modes, the round trip excepted.
      expect(refused.map(([label, command]) => `${label} -> ${check(SIBLING, 'Bash', { command }, mode)}`))
        .toEqual(refused.map(([label, , verdict]) => `${label} -> ${verdict}`))
    })
  }

  it('the refusal says why and names the way out', () => {
    const r = gate(SIBLING, 'Bash', { command: `rm -rf ${WS_OTHER}` }, 'bypassPermissions')
    const reason = r.type === 'block' ? r.reason : `not refused: ${r.type}`
    expect(reason).toContain(`\`${OTHER}\``)
    expect(reason).toContain('another workspace')
    expect(reason).toContain('ask the user')
  })

  it('CONTROLS: the OWN workspace folder, an ordinary folder inside another workspace\'s, other data-folder folders and look-alikes are judged as before', () => {
    const inside = join(WS_OTHER, 'sessions', 's1')
    const bypass: Array<[string, string]> = [
      ['rm -rf the own workspace folder', `rm -rf ${WS_OWN}`],
      ['mv the own workspace folder', `mv ${WS_OWN} ${X}`],
      ['rm -rf a folder inside another workspace\'s', `rm -rf ${inside}`],
      ['rm -rf the data folder\'s sessions', `rm -rf ${join(CONFIG_DIR, 'sessions')}`],
      ['rm -rf a look-alike data folder', `rm -rf ${CONFIG_DIR}-other/workspaces/ws-x`],
      ['rm -rf a look-alike workspaces folder', `rm -rf ${join(CONFIG_DIR, 'workspaces-x')}`],
      ['rm -rf a folder elsewhere', `rm -rf ${join(tmpdir(), 'f1722-elsewhere')}`],
      ['rm -rf a project folder\'s contents by a wildcard', `rm -rf ${SIBLING}/*`],
      ['mv a file into the home folder', `mv ${join(SIBLING, 'a.txt')} ${X}`],
    ]
    expect(bypass.map(([label, command]) => `${label} -> ${check(SIBLING, 'Bash', { command }, 'bypassPermissions')}`))
      .toEqual(bypass.map(([label]) => `${label} -> allow`))
    expect(check(SIBLING, 'Bash', { command: `rm -rf ${inside}` }, 'default')).toBe('floor')
  })

  it('the message half: a `cd` spelling names the record at the token\'s own directory, not a same-named one at the cwd', () => {
    // RED at f5dfc6835: `own-record` (the own permissions.json) and `record:hooks.json` (the global one).
    expect(check(WS_OWN, 'Bash', { command: `cd ../ws-f1712-other && printf '{}' > permissions.json` }, 'bypassPermissions')).toBe(`record:${OTHER}/permissions.json`)
    expect(check(CONFIG_DIR, 'Bash', { command: `cd ${relative(CONFIG_DIR, WS_OTHER)} && printf '{}' > hooks.json` }, 'bypassPermissions')).toBe(`record:${OTHER}/hooks.json`)
  })

  it('CONTROL: a write BEFORE the `cd` names the cwd\'s record, and a path read against a later `cd` is still refused (F1.714 unchanged)', () => {
    expect(check(WS_OWN, 'Bash', { command: `printf '{}' > permissions.json && cd ../ws-f1712-other` }, 'bypassPermissions')).toBe('own-record')
    expect(check(CONFIG_DIR, 'Bash', { command: `printf '{}' > hooks.json && cd ${relative(CONFIG_DIR, WS_OTHER)}` }, 'bypassPermissions')).toBe('record:hooks.json')
    expect(check(CONFIG_DIR, 'Bash', { command: `cd ${SIBLING} && printf '{}' > hooks.json` }, 'bypassPermissions')).toBe('record:hooks.json')
  })
})

/**
 * UA12.2 (2026-10-05) — the PATTERN records join the other-workspace refusal. UA1.10
 * taught the OWN-workspace guard (`guardedWorkspaceRecordGuidance`) a task spec, a page
 * config, a project config and a project context, one folder below their parent; the
 * other-workspace guard kept knowing exact names only, so in `bypassPermissions` a
 * write to `<other>/tasks/<slug>/task.yaml` (and the page/project records) answered
 * ALLOW while the same path in the OWN workspace was refused. Now
 * `OTHER_WORKSPACE_RECORD_PATTERNS` carries the same four shapes
 * (`workspaces/<id>/` + pattern, a `*` = exactly ONE folder name), and the session's
 * OWN workspace stays carved out BELOW the exact names too — a nested own record is
 * named by the own guard's message, never by the other-workspace one.
 */
const PATTERN_RECORDS = ['tasks/spec-7/task.yaml', 'pages/p-1/page.json', 'projects/prj/config.json', 'projects/prj/context.md']
for (const name of PATTERN_RECORDS) {
  mkdirSync(dirname(join(WS_OTHER, name)), { recursive: true })
  writeFileSync(join(WS_OTHER, name), '{}')
}
mkdirSync(join(WS_OWN, 'tasks', 'spec-7'), { recursive: true })
writeFileSync(join(WS_OWN, 'tasks', 'spec-7', 'task.yaml'), '{}') // UA12.2's carve-out control: an OWN nested pattern record
writeFileSync(join(WS_OTHER, 'tasks', 'spec-7', 'notes.md'), '{}') // an ordinary file where a record would sit

describe('UA12.2 — another workspace\'s pattern records are refused in EVERY mode, bypassPermissions included', () => {
  const otherRel = relative(CONFIG_DIR, WS_OTHER)
  // [record, spelling label, tool, input, cwd]
  const arms: Array<[string, string, string, Record<string, unknown>, string]> = PATTERN_RECORDS.flatMap(name => [
    [name, 'write-abs', 'Write', { file_path: join(WS_OTHER, name), content: '{}' }, SIBLING],
    [name, 'bash-abs', 'Bash', { command: `printf '{}' > ${join(WS_OTHER, name)}` }, SIBLING],
    [name, 'write-upper-case', 'Write', { file_path: join(WS_OTHER, name).toUpperCase(), content: '{}' }, SIBLING],
    [name, 'bash-cd-bare-name', 'Bash', { command: `cd ${relative(CONFIG_DIR, dirname(join(WS_OTHER, name)))} && printf '{}' > ${name.split('/').pop()}` }, CONFIG_DIR],
    [name, 'bash-sed-i', 'Bash', { command: `sed -i '' 's/a/b/' ${join(WS_OTHER, name)}` }, SIBLING],
    [name, 'bash-rm', 'Bash', { command: `rm -f ${join(WS_OTHER, name)}` }, SIBLING], // LF-1: a delete is refused like a write (the shell arm is read/write blind, F1.124)
  ] as Array<[string, string, string, Record<string, unknown>, string]>)

  for (const mode of [...MODES, 'dontAsk'] as const) {
    it(`${mode}: every write spelling is refused as a record write naming the nested path`, () => {
      const missed = arms.filter(([name, label, tool, input, cwd]) => {
        const verdict = check(cwd, tool, input, mode)
        const refused = verdict === `record:${otherRel}/${name}`
        return !refused && !(mode === 'dontAsk' && (verdict === 'block' || verdict === 'floor-deny' || verdict.startsWith('record:')))
      })
      expect(missed.map(([name, label]) => `${name} ${label}`)).toEqual([])
    })
  }

  it('the refusal names the record, the pattern guidance and the way out, and points at the Read tool', () => {
    const r = gate(SIBLING, 'Write', { file_path: join(WS_OTHER, 'tasks/spec-7/task.yaml'), content: '{}' }, 'bypassPermissions')
    const reason = r.type === 'block' ? r.reason : `not refused: ${r.type}`
    expect(reason).toContain(`\`${otherRel}/tasks/spec-7/task.yaml\``)
    expect(reason).toContain("another workspace's task spec")
    expect(reason).toContain('Read tool')
  })
})

describe('UA12.2 — CONTROLS', () => {
  it('the OWN workspace is unchanged: its nested pattern records keep the OWN guard\'s refusal, never the other-workspace message', () => {
    for (const mode of MODES) {
      expect(check(WS_OWN, 'Write', { file_path: join(WS_OWN, 'tasks/spec-7/task.yaml'), content: '{}' }, mode)).toBe('own-record')
      expect(check(SIBLING, 'Bash', { command: `printf '{}' > ${join(WS_OWN, 'tasks/spec-7/task.yaml')}` }, mode)).toBe('own-record')
    }
  })

  it('an ordinary file two folders deep in another workspace, and a shape no pattern matches, are not records', () => {
    for (const abs of [join(WS_OTHER, 'tasks/spec-7/notes.md'), join(WS_OTHER, 'tasks/task.yaml'), join(WS_OTHER, 'tasks/spec-7/deeper/task.yaml'), join(WS_OTHER, 'tasks/x/y/task.yaml')]) {
      expect(check(SIBLING, 'Write', { file_path: abs, content: '{}' }, 'bypassPermissions')).toBe('allow')
      expect(check(SIBLING, 'Write', { file_path: abs, content: '{}' }, 'acceptEdits')).toBe('floor')
    }
  })

  it('the Read tool reads another workspace\'s pattern records in every mode', () => {
    for (const mode of MODES) {
      for (const name of PATTERN_RECORDS) expect(check(SIBLING, 'Read', { file_path: join(WS_OTHER, name) }, mode)).toBe('allow')
    }
  })
})

/**
 * UA12.188 (LG-6, 2026-10-09; P-LF-1-2) — a copy whose written names the command does not spell, landing in a
 * folder BELOW another workspace's folder (`cp -R <x>/ <other>/tasks/`, `cp <x>/* <other>/pages/<p>/`). F1.922 refuses
 * such a copy into the workspace folder itself only, and UA12.2's pattern records are named one by one, so the copy
 * ran. MEASURED before (this describe at `1e7fee778`): ALLOW in bypassPermissions for every refusal arm below. Now the
 * source is LISTED at check time, as F1.945's `shellCopyOwnRootRecord` lists it for the own root, and the copy is
 * refused naming the pattern record it would land; an archive extracted into such a folder (its names unknowable) is
 * refused whole. A tree that lands no record shape still runs.
 */
const STAGE = mkdtempSync(join(tmpdir(), 'ua12188-stage-'))
for (const [file, body] of [
  ['tasktree/spec-9/task.yaml', 'title: x'], ['specdir/task.yaml', 'title: x'], ['pagefiles/page.json', '{}'],
  ['projtree/prj-2/context.md', '# x'], ['plain/spec-0/notes.md', '# x'], ['plain/readme.md', '# x'],
  // UA12.188 follow-up 2: ONE folder in bash's eyes, two in the gate's (a dotfile; another letter case), measured ALLOW at 694024ed9
  ['dotted/specdir/task.yaml', 'title: x'], ['dotted/.DS_Store', ''], ['cased/specdir/task.yaml', 'title: x'], ['cased/SPECS.md', '# x'],
  ['rootpages/pages/p-1/page.json', '{}'], // UA12.198: a folder named as a pattern's first segment, moved into the own root
] as const) {
  mkdirSync(dirname(join(STAGE, file)), { recursive: true })
  writeFileSync(join(STAGE, file), body)
}
mkdirSync(join(WS_OTHER, 'tasks', 'spec-9'), { recursive: true })

describe('UA12.188 — a copy into a folder BELOW another workspace\'s folder is refused when its listed source lands a pattern record', () => {
  const OTHER = relative(CONFIG_DIR, WS_OTHER)
  const T = join(WS_OTHER, 'tasks')
  const refused: Array<[string, string, string]> = [
    ['a tree\'s contents into tasks/', `cp -R ${STAGE}/tasktree/ ${T}/`, `record:${OTHER}/tasks/spec-9/task.yaml`],
    ['a tree\'s contents by /. into tasks', `cp -R ${STAGE}/tasktree/. ${T}`, `record:${OTHER}/tasks/spec-9/task.yaml`],
    ['a wildcard into tasks/', `cp -R ${STAGE}/tasktree/* ${T}/`, `record:${OTHER}/tasks/spec-9/task.yaml`],
    ['a wildcard of files into pages/<p>/', `cp ${STAGE}/pagefiles/* ${join(WS_OTHER, 'pages', 'p-2')}/`, `record:${OTHER}/pages/p-2/page.json`],
    ['a spec folder copied INTO tasks/', `cp -R ${STAGE}/specdir ${T}/`, `record:${OTHER}/tasks/specdir/task.yaml`],
    ['a spec folder landing AS tasks/<new>', `cp -R ${STAGE}/specdir ${T}/spec-new`, `record:${OTHER}/tasks/spec-new/task.yaml`],
    // UA12.188 follow-up (LG-6-fix, 2026-10-09): a wildcard with ONE match lands AS a destination that does not exist yet, as its spelled-out name does (measured ALLOW before)
    ['a one-match wildcard landing AS tasks/<new>', `cp -R ${STAGE}/spec* ${T}/spec-new`, `record:${OTHER}/tasks/spec-new/task.yaml`],
    ['a one-match ? wildcard landing AS tasks/<new>', `cp -R ${STAGE}/specdi? ${T}/spec-new`, `record:${OTHER}/tasks/spec-new/task.yaml`],
    ['mv a one-match wildcard AS tasks/<new>', `mv ${STAGE}/spec* ${T}/spec-new2`, `record:${OTHER}/tasks/spec-new2/task.yaml`],
    // UA12.188 follow-up 2: bash's `*` skips a dotfile and its matching keeps letter case, so these are ONE source landing AS the missing destination
    ['a * beside a .DS_Store landing AS tasks/<new>', `cp -R ${STAGE}/dotted/* ${T}/spec-new`, `record:${OTHER}/tasks/spec-new/task.yaml`],
    ['a spec* beside a SPECS.md landing AS tasks/<new>', `cp -R ${STAGE}/cased/spec* ${T}/spec-new`, `record:${OTHER}/tasks/spec-new/task.yaml`],
    ['rsync a tree\'s contents into projects/', `rsync -a ${STAGE}/projtree/ ${join(WS_OTHER, 'projects')}/`, `record:${OTHER}/projects/prj-2/context.md`],
    ['ditto a folder into tasks', `ditto ${STAGE}/tasktree ${T}`, `record:${OTHER}/tasks/spec-9/task.yaml`],
    ['mv a wildcard into tasks/', `mv ${STAGE}/tasktree/* ${T}/`, `record:${OTHER}/tasks/spec-9/task.yaml`],
    ['another letter case', `cp -R ${STAGE}/tasktree/ ${WS_OTHER.toUpperCase()}/TASKS/`, `record:${OTHER}/tasks/spec-9/task.yaml`],
    ['cd into tasks and copy to .', `cd ${T} && cp -R ${STAGE}/tasktree/ .`, `record:${OTHER}/tasks/spec-9/task.yaml`],
    ['an archive extracted into tasks/', `tar -xf ${STAGE}/a.tar -C ${T}/`, `folder:${OTHER}/tasks`],
    // UA12.198 (LG-7, 2026-10-09): `mv`, `ln` and GNU `cp` land a trailing-`/` folder ITSELF (BSD `cp` its contents), so these land `tasks/specdir/task.yaml` — measured ALLOW in bypassPermissions at a3338957e
    ['mv a trailing-/ spec folder into tasks/', `mv ${STAGE}/specdir/ ${T}/`, `record:${OTHER}/tasks/specdir/task.yaml`],
    ['ln -s a trailing-/ spec folder into tasks/', `ln -s ${STAGE}/specdir/ ${T}/`, `record:${OTHER}/tasks/specdir/task.yaml`],
    ['cp -R a trailing-/ spec folder into tasks/ (GNU cp)', `cp -R ${STAGE}/specdir/ ${T}/`, `record:${OTHER}/tasks/specdir/task.yaml`],
    ['cd into tasks and ln -s a trailing-/ spec folder', `cd ${T} && ln -s ${STAGE}/specdir/`, `record:${OTHER}/tasks/specdir/task.yaml`],
    ['mv a one-match trailing-/ wildcard into tasks/', `mv ${STAGE}/spec*/ ${T}/`, `record:${OTHER}/tasks/specdir/task.yaml`],
    ['mv a */ beside a .DS_Store into tasks/', `mv ${STAGE}/dotted/*/ ${T}/`, `record:${OTHER}/tasks/specdir/task.yaml`],
  ]
  for (const mode of MODES) {
    it(`${mode}: each copy is refused, naming the record it would land`, () => {
      expect(refused.map(([label, command]) => `${label} -> ${check(SIBLING, 'Bash', { command }, mode)}`))
        .toEqual(refused.map(([label, , verdict]) => `${label} -> ${verdict}`))
    })
  }

  it('the refusal names the record and another workspace\'s reason', () => {
    const r = gate(SIBLING, 'Bash', { command: `cp -R ${STAGE}/tasktree/ ${T}/` }, 'bypassPermissions')
    const reason = r.type === 'block' ? r.reason : `not refused: ${r.type}`
    expect(reason).toContain(`\`${OTHER}/tasks/spec-9/task.yaml\``)
    expect(reason).toContain("another workspace's task spec")
  })

  it('CONTROLS: a tree that lands no record shape, a folder no pattern starts with, and a folder outside the data folder still run in bypassPermissions', () => {
    const runs: Array<[string, string]> = [
      ['the record tree into <other>/notes/', `cp -R ${STAGE}/tasktree/ ${join(WS_OTHER, 'notes')}/`],
      ['a tree without a spec into tasks/', `cp -R ${STAGE}/plain/ ${T}/`],
      ['a wildcard without a spec into tasks/', `cp -R ${STAGE}/plain/* ${T}/`],
      ['the record tree one level too deep', `cp -R ${STAGE}/tasktree/ ${T}/spec-9/`],
      ['the record tree into a sibling project\'s tasks/', `cp -R ${STAGE}/tasktree/ ${join(SIBLING, 'tasks')}/`],
      ['an archive into <other>/notes/', `tar -xf ${STAGE}/a.tar -C ${join(WS_OTHER, 'notes')}/`],
      ['a tree without a spec into the OWN tasks/', `cp -R ${STAGE}/plain/ ${join(WS_OWN, 'tasks')}/`],
      // UA12.188 follow-up: a wildcard with TWO matches (plain, specdir) lands INTO an existing folder, never AS it — `tasks/spec-9/specdir/task.yaml` is no record
      ['a two-match wildcard into an existing tasks/<slug>', `cp -R ${STAGE}/[ps][lp]* ${T}/spec-9`],
      // UA12.188 follow-up 2 BOUNDARY: the same dotfile layout into an EXISTING tasks/<slug> lands INTO it (`tasks/spec-9/specdir/task.yaml` is no record)
      ['a * beside a .DS_Store into an existing tasks/<slug>', `cp -R ${STAGE}/dotted/* ${T}/spec-9`],
      // UA12.198 BOUNDARIES: a trailing-/ spec folder into a folder no pattern starts with; rsync lands a trailing-/ folder's CONTENTS (`tasks/task.yaml` is no record); a spec-free folder moved into tasks/
      ['a trailing-/ spec folder into <other>/notes/', `cp -R ${STAGE}/specdir/ ${join(WS_OTHER, 'notes')}/`],
      ['mv a trailing-/ spec folder into <other>/notes/', `mv ${STAGE}/specdir/ ${join(WS_OTHER, 'notes')}/`],
      ['rsync a trailing-/ spec folder into tasks/', `rsync -a ${STAGE}/specdir/ ${T}/`],
      ['mv a trailing-/ spec-free folder into tasks/', `mv ${STAGE}/plain/ ${T}/`],
    ]
    expect(runs.map(([label, command]) => `${label} -> ${check(SIBLING, 'Bash', { command }, 'bypassPermissions')}`))
      .toEqual(runs.map(([label]) => `${label} -> allow`))
  })

  // The OWN workspace had the same gap (measured with this rig at `1e7fee778`: ALLOW in bypassPermissions); its refusal keeps the own guard's message.
  it('the OWN workspace too: a copy into its tasks/ whose listed source lands a task spec is refused by the own guard, in every mode', () => {
    for (const mode of MODES) {
      expect(check(SIBLING, 'Bash', { command: `cp -R ${STAGE}/tasktree/ ${join(WS_OWN, 'tasks')}/` }, mode)).toBe('own-record')
      expect(check(WS_OWN, 'Bash', { command: `cp -R ${STAGE}/tasktree/* tasks/` }, mode)).toBe('own-record')
      expect(check(SIBLING, 'Bash', { command: `cp -R ${STAGE}/spec* ${join(WS_OWN, 'tasks')}/spec-new` }, mode)).toBe('own-record') // UA12.188 follow-up: a one-match wildcard landing AS a new task folder
      expect(check(SIBLING, 'Bash', { command: `cp -R ${STAGE}/dotted/* ${join(WS_OWN, 'tasks')}/spec-new` }, mode)).toBe('own-record') // follow-up 2: one match in bash, two in the gate
      expect(check(SIBLING, 'Bash', { command: `cp -R ${STAGE}/cased/spec* ${join(WS_OWN, 'tasks')}/spec-new` }, mode)).toBe('own-record')
      expect(check(SIBLING, 'Bash', { command: `mv ${STAGE}/specdir/ ${join(WS_OWN, 'tasks')}/` }, mode)).toBe('own-record') // UA12.198: a trailing-/ folder lands ITSELF (measured ALLOW in bypass at a3338957e)
      expect(check(SIBLING, 'Bash', { command: `mv ${STAGE}/rootpages/pages/ ${WS_OWN}/` }, mode)).toBe('own-record') // UA12.198, F1.945's own-root reader: `pages/p-1/page.json` lands in the root
    }
    const r = gate(SIBLING, 'Bash', { command: `cp -R ${STAGE}/tasktree/ ${join(WS_OWN, 'tasks')}/` }, 'bypassPermissions')
    const reason = r.type === 'block' ? r.reason : `not refused: ${r.type}`
    expect(reason).toContain('`tasks/spec-9/task.yaml`')
    expect(reason).toContain("A task's spec is a host record")
  })
})

process.on('exit', () => { rmSync(SIBLING, { recursive: true, force: true }); rmSync(STAGE, { recursive: true, force: true }) })
