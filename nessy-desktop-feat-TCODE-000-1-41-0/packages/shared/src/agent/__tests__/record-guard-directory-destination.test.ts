/**
 * F1.922 (WJ-crit-ggg, 2026-09-25) — the every-mode record refusal (F1.701 for
 * Nessy's global control records, F1.712 for every workspace's, D1.438 for the
 * session's own) must also see a record written by a copy, move, install or link
 * whose DESTINATION is the record's directory.
 *
 * ## The reading, taken first (the delta-review record-guard-dir-dest probe, untracked under `work/review-142/`)
 *
 * On the real `runPreToolUseChecks` (the gate claude's PreToolUse hook and Pi's
 * pre_tool_use bridge both call), in `bypassPermissions`, at HEAD `f4cb8a14f`:
 * `cp <stage>/hooks.json <CONFIG_DIR>/hooks.json` was refused, and every
 * directory-destination form ALLOWED — `cp <stage>/hooks.json <CONFIG_DIR>/`,
 * `cp <stage>/mcp.json <CONFIG_DIR>`, `mv <stage>/config.json <CONFIG_DIR>/`,
 * `cp -t <CONFIG_DIR> <stage>/hooks.json`, `cp <stage>/permissions.json
 * <CONFIG_DIR>/workspaces/<other>/` (`Ran 6 tests across 1 file`, 1 pass / 5
 * fail). Each token was resolved on its own: the destination resolves to the
 * folder, and a folder is not a record. The planted global `hooks.json`'s command
 * hooks then run with no card in every later session (D1.343's operator tier).
 * The same gap held for the session's own workspace records (`cp <stage>/
 * permissions.json .` from the workspace root) and, measured by this lane, for the
 * glued `dd of=<record>` spelling (both guards), a folder's contents, a wildcard or
 * a variable copied into the data folder, and a folder moved onto another
 * workspace's folder — all ALLOW in `bypassPermissions`.
 *
 * ## The fix, and what it is not
 *
 * Each copy/move/install/link (`cp`, `mv`, `install`, `ln`, their GNU `g`-prefixed
 * names, `rsync`, `ditto`) now also yields the name it WRITES, `<dest>/<basename
 * of the source>`, and that name meets the same record check as a token does — so
 * it is refused like the direct path, naming the record. Where the written names
 * cannot be read from the command (a folder, a folder's contents, a wildcard, a
 * variable, a source that is not an existing file) and the destination is the data
 * folder itself, its `workspaces` folder or ANOTHER workspace's folder — or a
 * folder's contents land in a folder that contains the data folder — the command
 * is refused as a whole (fail closed). A non-record FILE copied into those folders
 * is judged as before; so are reads, the session's own `hooks.json`, and every
 * copy between ordinary folders. A tree copied into the session's OWN workspace root
 * (a no-project session's working folder), and a wildcard copied into a folder that
 * contains the data folder, were the STATED residue here; F1.945 (below) now lists
 * their sources at gate time.
 * Archive extraction and downloaders (`tar -C`, `unzip -d`, `wget -P`) are a
 * different command family and are not read here.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { runPreToolUseChecks, type PermissionManagerLike } from '../core/pre-tool-use.ts'
import type { PermissionMode } from '../mode-types.ts'
import { cleanupModeState, initializeModeState } from '../mode-manager.ts'
import { CONFIG_DIR } from '../../config/paths.ts'

const KEY = { workspaceId: 'ws-f1922', sessionId: 'session-f1922' }
const WS_OWN = join(CONFIG_DIR, 'workspaces', KEY.workspaceId)
const WS_OTHER = join(CONFIG_DIR, 'workspaces', 'ws-other')
const STAGE = mkdtempSync(join(tmpdir(), 'f1922-stage-'))
const PROJECT = mkdtempSync(join(tmpdir(), 'f1922-project-'))
// A folder named like the data folder, to be copied onto it from its parent.
const LOOKALIKE = mkdtempSync(join(tmpdir(), 'f1922-lookalike-'))

// Real files and folders, so the gate's `stat` of a source sees what the shell would.
for (const d of [WS_OWN, WS_OTHER, join(CONFIG_DIR, 'permissions'), join(CONFIG_DIR, 'skills'), join(STAGE, 'tree'), join(STAGE, 'ws-other'), join(LOOKALIKE, basename(CONFIG_DIR))]) mkdirSync(d, { recursive: true })
for (const f of ['hooks.json', 'mcp.json', 'config.json', 'permissions.json', 'automations.json', 'notes.txt', 'tree/hooks.json', 'ws-other/permissions.json']) writeFileSync(join(STAGE, f), '{}')

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

afterEach(() => { cleanupModeState(KEY) })

/**
 * The gate's verdict: `record:<name>` for the global/other-workspace refusal naming a record,
 * `folder:<name>` for this row's fail-closed refusal naming the folder, `ws-record:<name>` for
 * the own workspace's record guard, else the plain outcome.
 */
function check(command: string, mode: PermissionMode = 'bypassPermissions', cwd = PROJECT, toolName = 'Bash', input?: Record<string, unknown>): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const r = runPreToolUseChecks({
    toolName, input: input ?? { command }, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: mode,
    workspaceRootPath: WS_OWN, workspaceId: KEY.workspaceId, workingDirectory: cwd,
    activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
  })
  if (r.type === 'block') {
    const record = /targeting `([^`]+)` are blocked in every permission mode/.exec(r.reason)?.[1]
    if (record) return `record:${record}`
    const folder = /writing into `([^`]+)` are blocked in every permission mode/.exec(r.reason)?.[1]
    if (folder) return `folder:${folder}`
    const own = /^Direct \S+ operations (?:targeting `([^`]+)`|in (\S+)) are blocked\. /.exec(r.reason)
    if (own) return `ws-record:${own[1] ?? own[2]}`
    return r.source === 'dont_ask_would_prompt' ? 'block(reopenable)' : 'block'
  }
  if (r.type === 'prompt') return r.nonNegotiable === 'protectedPath' ? 'floor' : `card(${r.promptType})`
  return r.type
}

const S = STAGE
const OTHER_REL = 'workspaces/ws-other'

/** [label, command, expected verdict, cwd]. The record-named source into its directory. */
const RECORD_ARMS: Array<[string, string, string, string?]> = [
  // The reviewer's five.
  ['cp to CONFIG_DIR/', `cp ${S}/hooks.json ${CONFIG_DIR}/`, 'record:hooks.json'],
  ['cp to CONFIG_DIR', `cp ${S}/mcp.json ${CONFIG_DIR}`, 'record:mcp.json'],
  ['mv to CONFIG_DIR/', `mv ${S}/config.json ${CONFIG_DIR}/`, 'record:config.json'],
  ['cp -t CONFIG_DIR', `cp -t ${CONFIG_DIR} ${S}/hooks.json`, 'record:hooks.json'],
  ['cp to another workspace dir', `cp ${S}/permissions.json ${WS_OTHER}/`, `record:${OTHER_REL}/permissions.json`],
  // The same shape, other spellings.
  ['cp --target-directory=', `cp --target-directory=${CONFIG_DIR} ${S}/hooks.json`, 'record:hooks.json'],
  ['cp --target-directory <dir>', `cp --target-directory ${CONFIG_DIR} ${S}/hooks.json`, 'record:hooks.json'],
  ['install -m 644', `install -m 644 ${S}/mcp.json ${CONFIG_DIR}/`, 'record:mcp.json'],
  ['ln -s', `ln -s ${S}/hooks.json ${CONFIG_DIR}/`, 'record:hooks.json'],
  ['cd + a lone ln operand', `cd ${CONFIG_DIR} && ln -s ${S}/hooks.json`, 'record:hooks.json'],
  ['cd + cp to .', `cd ${CONFIG_DIR} && cp ${S}/hooks.json .`, 'record:hooks.json'],
  ['cp to . from the data folder', `cp ${S}/config.json .`, 'record:config.json', CONFIG_DIR],
  ['rsync a file', `rsync -a ${S}/config.json ${CONFIG_DIR}/`, 'record:config.json'],
  ['ditto a file', `ditto ${S}/hooks.json ${CONFIG_DIR}/`, 'record:hooks.json'],
  ['nested sh -c', `sh -c 'cp ${S}/hooks.json ${CONFIG_DIR}/'`, 'record:hooks.json'],
  ['several sources', `cp ${S}/notes.txt ${S}/hooks.json ${CONFIG_DIR}/`, 'record:hooks.json'],
  ['/bin/cp', `/bin/cp ${S}/hooks.json ${CONFIG_DIR}/`, 'record:hooks.json'],
  ['gcp (GNU coreutils)', `gcp ${S}/hooks.json ${CONFIG_DIR}/`, 'record:hooks.json'],
  ['mv to another workspace dir, no slash', `mv ${S}/automations.json ${WS_OTHER}`, `record:${OTHER_REL}/automations.json`],
  ['cp hooks.json to another workspace dir', `cp ${S}/hooks.json ${WS_OTHER}/`, `record:${OTHER_REL}/hooks.json`],
  ['cp a permissions folder file', `cp ${S}/notes.txt ${CONFIG_DIR}/permissions/`, 'record:permissions'],
  // The session's OWN workspace records (D1.438's guard).
  ['own workspace: cp to . from its root', `cp ${S}/permissions.json .`, 'ws-record:permissions.json', WS_OWN],
  ['own workspace: cp to its root', `cp ${S}/automations.json ${WS_OWN}/`, 'ws-record:automations.json'],
  ['own workspace: cd + mv to .', `cd ${WS_OWN} && mv ${S}/permissions.json .`, 'ws-record:permissions.json'],
  // The glued `of=` spelling (measured beside the row): the direct path, both guards.
  ['dd of= a global record', `dd if=${S}/hooks.json of=${CONFIG_DIR}/hooks.json`, 'record:hooks.json'],
  ['dd of= another workspace record', `dd if=${S}/permissions.json of=${WS_OTHER}/permissions.json`, `record:${OTHER_REL}/permissions.json`],
  ['dd of= an own workspace record', `dd if=${S}/permissions.json of=${WS_OWN}/permissions.json`, 'ws-record:permissions.json'],
]

/** Written names the command does not spell, into a folder that holds records: refused as a whole. */
const FOLDER_ARMS: Array<[string, string, string]> = [
  ['cp -R a folder\'s contents', `cp -R ${S}/tree/ ${CONFIG_DIR}`, `folder:${CONFIG_DIR}`],
  ['cp -R <dir>/.', `cp -R ${S}/tree/. ${CONFIG_DIR}/`, `folder:${CONFIG_DIR}`],
  ['rsync a folder\'s contents', `rsync -a ${S}/tree/ ${CONFIG_DIR}/`, `folder:${CONFIG_DIR}`],
  ['ditto a folder', `ditto ${S}/tree ${CONFIG_DIR}`, `folder:${CONFIG_DIR}`],
  ['a wildcard', `cp ${S}/tree/*.json ${CONFIG_DIR}/`, `folder:${CONFIG_DIR}`],
  ['a variable', `cp "$F" ${CONFIG_DIR}/`, `folder:${CONFIG_DIR}`],
  ['a folder moved onto another workspace\'s folder', `mv ${S}/tree ${WS_OTHER}`, `folder:${OTHER_REL}`],
  ['rm then mv onto another workspace\'s folder', `rm -rf ${WS_OTHER} && mv ${S}/tree ${WS_OTHER}`, `folder:${OTHER_REL}`],
  ['a folder copied AS another workspace\'s folder', `cp -R ${S}/ws-other ${CONFIG_DIR}/workspaces/`, 'folder:workspaces'],
  ['a folder\'s contents into the workspaces folder', `cp -R ${S}/tree/ ${CONFIG_DIR}/workspaces/`, 'folder:workspaces'],
  ['a folder copied AS the data folder, from its parent', `cp -R ${LOOKALIKE}/${basename(CONFIG_DIR)} ${dirname(CONFIG_DIR)}/`, `folder:${CONFIG_DIR}`],
  ['a folder\'s contents into a folder that contains the data folder', `cp -R ${S}/tree/ ${dirname(CONFIG_DIR)}/`, `folder:${dirname(CONFIG_DIR)}`],
]

const MODES: PermissionMode[] = ['bypassPermissions', 'default', 'acceptEdits', 'auto']

/** `dontAsk` denies a would-prompt call before the record guard is reached; that denial must be FINAL (not re-openable). */
function expectRefused(verdict: string, expected: string, mode: PermissionMode): void {
  expect(mode === 'dontAsk' && verdict === 'block' ? expected : verdict).toBe(expected)
}

// One `it` per arm and mode: every gate call reads the filesystem, and on a loaded rig one call has measured ~1.3 s.
describe('F1.922 — a copy/move/install/link into a record\'s directory is refused like the direct path, in every mode', () => {
  for (const mode of [...MODES, 'dontAsk'] as const) {
    for (const [label, command, expected, cwd] of RECORD_ARMS) {
      it(`${mode}: ${label} -> ${expected.split(':')[0]}`, () => { expectRefused(check(command, mode, cwd), expected, mode) })
    }
    for (const [label, command, expected] of FOLDER_ARMS) {
      it(`${mode}: fail closed, ${label} -> folder`, () => { expectRefused(check(command, mode), expected, mode) })
    }
  }

  it('the refusal names the record, as the direct path\'s does; the fail-closed one names the folder and why', () => {
    cleanupModeState(KEY)
    initializeModeState(KEY, 'bypassPermissions')
    const reason = (command: string) => {
      const r = runPreToolUseChecks({
        toolName: 'Bash', input: { command }, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: 'bypassPermissions',
        workspaceRootPath: WS_OWN, workspaceId: KEY.workspaceId, workingDirectory: PROJECT,
        activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
      })
      return r.type === 'block' ? r.reason : ''
    }
    expect(reason(`cp ${S}/hooks.json ${CONFIG_DIR}/`)).toContain('every later session')
    const folder = reason(`cp -R ${S}/tree/ ${CONFIG_DIR}`)
    expect(folder).toContain('cannot be named from the command')
    expect(folder).toContain('To read a record, use the Read tool.')
  })
})

describe('F1.922 — CONTROLS', () => {
  it('the direct-path forms still block', () => {
    expect(check(`cp ${S}/hooks.json ${CONFIG_DIR}/hooks.json`)).toBe('record:hooks.json')
    expect(check('', 'bypassPermissions', PROJECT, 'Write', { file_path: join(CONFIG_DIR, 'hooks.json'), content: '{}' })).toBe('record:hooks.json')
    expect(check(`printf '{}' > ${WS_OWN}/permissions.json`)).toBe('ws-record:permissions.json')
  })

  it('a non-record FILE copied into the data folder is judged as before (bypass allows, default asks the floor card)', () => {
    for (const command of [`cp ${S}/notes.txt ${CONFIG_DIR}/`, `mv ${S}/notes.txt ${CONFIG_DIR}`, `install -m 644 ${S}/notes.txt ${CONFIG_DIR}/`, `cp -t ${CONFIG_DIR} ${S}/notes.txt`]) {
      expect(check(command, 'bypassPermissions')).toBe('allow')
      expect(check(command, 'default')).toBe('floor')
    }
  })

  it('a folder copied into the skills folder, and a copy between ordinary folders, are unchanged', () => {
    expect(check(`cp -R ${S}/tree ${CONFIG_DIR}/skills/`)).toBe('allow')
    expect(check(`cp -R ${S}/tree/ ${CONFIG_DIR}/skills/x`)).toBe('allow')
    for (const command of [`cp ${S}/hooks.json ${PROJECT}/`, `mv ${PROJECT}/a ${PROJECT}/b`, `cp -R ${S}/tree/ ${PROJECT}/`, `ditto ${S}/tree ${PROJECT}/x`, `cp ${S}/tree/*.json ${PROJECT}/`, `rsync -a ${S}/tree/ ${PROJECT}/copy/`]) {
      expect(check(command)).toBe('allow')
    }
  })

  it('reads are unchanged: the Read tool, and copies OUT of the data folder', () => {
    expect(check('', 'bypassPermissions', PROJECT, 'Read', { file_path: join(CONFIG_DIR, 'hooks.json') })).toBe('allow')
    expect(check(`cp -R ${CONFIG_DIR}/skills ${PROJECT}/`)).toBe('allow')
    expect(check(`rsync -a ${CONFIG_DIR}/ ${PROJECT}/backup/`)).toBe('allow')
    expect(check(`ls ${CONFIG_DIR}/`)).toBe('allow')
  })

  it('the session\'s OWN workspace hooks.json keeps its card, not a refusal', () => {
    expect(check(`cp ${S}/hooks.json ${WS_OWN}/`, 'bypassPermissions')).toBe('allow')
    // F1.703: the workspace root is no longer carved out of the data-folder floor, so the shell copy
    // takes the protected-path card (as on the default layout and as the file tool below) — still a card.
    expect(check(`cp ${S}/hooks.json ${WS_OWN}/`, 'default')).toBe('floor')
    expect(check('', 'default', PROJECT, 'Write', { file_path: join(WS_OWN, 'hooks.json'), content: '{}' })).toBe('floor')
  })

  it('a tree holding no record copied into the session\'s OWN workspace root, and a wildcard of files into a folder that contains the data folder, still run (F1.945 lists them)', () => {
    // The own root is a no-project session's working folder: a tree copy there is refused only when its listing holds a record.
    expect(check(`cp -R ${S}/tree/ ${WS_OWN}`)).toBe('allow')
    // A wildcard reaches the data folder only through a match named like it; files matched into its parent do not.
    expect(check(`cp ${S}/tree/*.json ${dirname(CONFIG_DIR)}/`)).toBe('allow')
  })
})

process.on('exit', () => {
  for (const dir of [STAGE, PROJECT, LOOKALIKE]) rmSync(dir, { recursive: true, force: true })
})

/**
 * F1.944 (WJ-crit-mmm, 2026-09-25) — the same fail-closed refusal for the ARCHIVE
 * EXTRACTOR and DOWNLOADER family, whose written names no token spells.
 *
 * MEASURED by WJ-crit-ggg at `74033faad` (bypassPermissions, on this gate): `tar -xf
 * x.tar -C <CONFIG_DIR>`, `cd <CONFIG_DIR> && tar -xf x.tar`, `unzip x.zip -d
 * <CONFIG_DIR>`, `wget -P <CONFIG_DIR> <url>/hooks.json` and `curl -O --output-dir
 * <CONFIG_DIR> <url>/hooks.json` all ALLOW, and `tar -C` in `default` asks an ordinary
 * card — so an archive or a download can plant the global `hooks.json` (D1.343's
 * no-card operator tier) or another workspace's `permissions.json`. Nothing is
 * downloaded or extracted here: the gate reads the command.
 *
 * Refused as a whole, naming the folder: an extraction (`tar`/`bsdtar`/`gtar` `-x`,
 * `unzip`, `7z x|e`, `ditto -x`) or a download (`wget` without `-O`, `curl -O`/`-J`)
 * whose target — `-C`/`--directory`, `-d`, `-o<dir>`, the last `ditto` operand, `-P`/
 * `--directory-prefix`, `--output-dir`, else the cwd and every `cd` target — is the
 * data folder, its `workspaces` folder or another workspace's folder; a decompressor
 * (`gunzip`, `gzip -d`, `bunzip2`, `unxz`, `unzstd`, …) whose file sits there; and an
 * extraction (or a tree-shaped download: `wget -r`/`-m`/`-x`/`-p`, `tar -P`, `unzip -:`)
 * into a folder that contains the data folder. A direct output naming a record — `curl
 * -o<record>` glued, `curl --output-dir <dir> -o <name>`, `wget -O<record>`, the name a
 * decompressor writes — names the record.
 */
const U = 'https://example.invalid/f1944'
// Real (empty) archive files, so a `ditto -x` source is an existing regular file, as F1.922's copy check reads it.
for (const f of ['x.tar', 'x.tgz', 'x.zip', 'x.7z']) writeFileSync(join(STAGE, f), '')
const F1944_ARMS: Array<[string, string, string, string?]> = [
  // The five measured shapes.
  ['tar -xf -C CONFIG_DIR', `tar -xf ${S}/x.tar -C ${CONFIG_DIR}`, `folder:${CONFIG_DIR}`],
  ['cd CONFIG_DIR + tar -xf', `cd ${CONFIG_DIR} && tar -xf ${S}/x.tar`, `folder:${CONFIG_DIR}`],
  ['unzip -d CONFIG_DIR', `unzip ${S}/x.zip -d ${CONFIG_DIR}`, `folder:${CONFIG_DIR}`],
  ['wget -P CONFIG_DIR', `wget -P ${CONFIG_DIR} ${U}/hooks.json`, `folder:${CONFIG_DIR}`],
  ['curl -O --output-dir CONFIG_DIR', `curl -O --output-dir ${CONFIG_DIR} ${U}/hooks.json`, `folder:${CONFIG_DIR}`],
  // Other spellings of the same writes.
  ['tar xf from the data folder (old-style bundle)', `tar xf ${S}/x.tar`, `folder:${CONFIG_DIR}`, CONFIG_DIR],
  ['tar -xzvf -C glued', `tar -xzvf ${S}/x.tgz -C${CONFIG_DIR}`, `folder:${CONFIG_DIR}`],
  ['tar --extract --directory=', `tar --extract --file ${S}/x.tar --directory=${CONFIG_DIR}`, `folder:${CONFIG_DIR}`],
  ['bsdtar -x -C another workspace', `bsdtar -x -f ${S}/x.tar -C ${WS_OTHER}`, `folder:${OTHER_REL}`],
  ['a pipe into tar -x -C', `curl -sSL ${U}/x.tar | tar -x -C ${CONFIG_DIR}`, `folder:${CONFIG_DIR}`],
  ['nested sh -c tar', `sh -c 'tar -xf ${S}/x.tar -C ${CONFIG_DIR}'`, `folder:${CONFIG_DIR}`],
  ['unzip -o -d glued', `unzip -o ${S}/x.zip -d${CONFIG_DIR}/workspaces`, 'folder:workspaces'],
  ['cd another workspace + unzip', `cd ${WS_OTHER} && unzip -q ${S}/x.zip`, `folder:${OTHER_REL}`],
  ['7z x -o', `7z x ${S}/x.7z -o${CONFIG_DIR}`, `folder:${CONFIG_DIR}`],
  ['7zz e into the data folder', `7zz e ${S}/x.7z`, `folder:${CONFIG_DIR}`, CONFIG_DIR],
  ['ditto -x -k', `ditto -x -k ${S}/x.zip ${CONFIG_DIR}`, `folder:${CONFIG_DIR}`],
  ['gunzip in the data folder, a record name', `gunzip ${CONFIG_DIR}/hooks.json.gz`, 'record:hooks.json'],
  ['gzip -d in the data folder', `gzip -d ${CONFIG_DIR}/x.gz`, `folder:${CONFIG_DIR}`],
  ['cd + gunzip -N (the stored name)', `cd ${WS_OTHER} && gunzip -N x.gz`, `folder:${OTHER_REL}`],
  ['wget --directory-prefix=', `wget -q --directory-prefix=${CONFIG_DIR} ${U}/hooks.json`, `folder:${CONFIG_DIR}`],
  ['cd + wget', `cd ${CONFIG_DIR} && wget ${U}/hooks.json`, `folder:${CONFIG_DIR}`],
  ['wget -O glued record', `wget -O${CONFIG_DIR}/hooks.json ${U}/x`, 'record:hooks.json'],
  ['curl -sSLO bundle, --output-dir=', `curl -sSLO --output-dir=${CONFIG_DIR} ${U}/hooks.json`, `folder:${CONFIG_DIR}`],
  ['cd + curl -O', `cd ${CONFIG_DIR} && curl -fsSLO ${U}/hooks.json`, `folder:${CONFIG_DIR}`],
  ['curl --remote-name into another workspace', `curl --remote-name --output-dir ${WS_OTHER} ${U}/permissions.json`, `folder:${OTHER_REL}`],
  ['curl -o glued record', `curl -sSo${CONFIG_DIR}/hooks.json ${U}/x`, 'record:hooks.json'],
  ['curl --output-dir + -o a record name', `curl --output-dir ${CONFIG_DIR} -o hooks.json ${U}/x`, 'record:hooks.json'],
  // Into a folder that CONTAINS the data folder: the archive may carry the data folder's own name.
  ['tar -x into a folder that contains the data folder', `tar -xf ${S}/x.tar -C ${dirname(CONFIG_DIR)}`, `folder:${dirname(CONFIG_DIR)}`],
  ['unzip into a folder that contains the data folder', `unzip ${S}/x.zip -d ${dirname(CONFIG_DIR)}/`, `folder:${dirname(CONFIG_DIR)}`],
  ['tar -P (absolute names, anywhere)', `tar -xPf ${S}/x.tar -C ${PROJECT}`, 'folder:/'],
  ['wget -r into a folder that contains the data folder', `wget -r -nH -P ${dirname(CONFIG_DIR)} ${U}/`, `folder:${dirname(CONFIG_DIR)}`],
]

describe('F1.944 — an archive extracted or a file downloaded into a record\'s folder is refused, in every mode', () => {
  for (const mode of [...MODES, 'dontAsk'] as const) {
    for (const [label, command, expected, cwd] of F1944_ARMS) {
      it(`${mode}: ${label} -> ${expected.split(':')[0]}`, () => { expectRefused(check(command, mode, cwd), expected, mode) })
    }
  }

  it('the refusal names the folder and why', () => {
    cleanupModeState(KEY)
    initializeModeState(KEY, 'bypassPermissions')
    const r = runPreToolUseChecks({
      toolName: 'Bash', input: { command: `tar -xf ${S}/x.tar -C ${CONFIG_DIR}` }, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: 'bypassPermissions',
      workspaceRootPath: WS_OWN, workspaceId: KEY.workspaceId, workingDirectory: PROJECT,
      activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
    })
    const reason = r.type === 'block' ? r.reason : ''
    expect(reason).toContain('cannot be named from the command')
    expect(reason).toContain('an archive extracted')
    expect(reason).toContain('To read a record, use the Read tool.')
  })
})

describe('F1.944 — CONTROLS', () => {
  it('extracting or downloading into an ordinary folder, or into skills/, is unchanged', () => {
    for (const command of [
      `tar -xf ${S}/x.tar -C ${PROJECT}`, `cd ${PROJECT} && tar -xzf ${S}/x.tgz`, `unzip ${S}/x.zip -d ${PROJECT}/out`, `7z x ${S}/x.7z -o${PROJECT}`,
      `ditto -x -k ${S}/x.zip ${PROJECT}/out`, `gunzip ${PROJECT}/x.gz`, `wget -P ${PROJECT} ${U}/hooks.json`, `curl -O --output-dir ${PROJECT} ${U}/hooks.json`,
      `curl -o ${PROJECT}/hooks.json ${U}/x`, `tar -xf ${S}/x.tar -C ${CONFIG_DIR}/skills/`, `unzip ${S}/x.zip -d ${CONFIG_DIR}/skills/x`,
      `curl -O --output-dir ${CONFIG_DIR}/skills ${U}/SKILL.md`, `cd ${CONFIG_DIR}/skills && tar -xf ${S}/x.tar`,
    ]) {
      expect([command, check(command)]).toEqual([command, 'allow'])
    }
  })

  it('reads are unchanged: listing, testing, to-stdout, creating an archive FROM the data folder, a download to stdout', () => {
    for (const [command, cwd] of [
      [`tar -tf ${S}/x.tar`, CONFIG_DIR], [`tar -xOf ${S}/x.tar`, CONFIG_DIR], [`tar -cf ${PROJECT}/backup.tar -C ${CONFIG_DIR} skills`, PROJECT],
      [`tar -xf ${CONFIG_DIR}/skills/x.tar -C ${PROJECT}`, PROJECT], [`unzip -l ${S}/x.zip`, CONFIG_DIR], [`unzip -p ${S}/x.zip a.txt`, CONFIG_DIR],
      [`7z l ${S}/x.7z`, CONFIG_DIR], [`gunzip -c ${CONFIG_DIR}/skills/x.gz`, PROJECT], [`curl -sSL ${U}/x`, CONFIG_DIR], [`wget -qO- ${U}/x`, CONFIG_DIR],
      [`wget -O - ${U}/x`, CONFIG_DIR],
    ] as const) {
      expect([command, check(command, 'bypassPermissions', cwd)]).toEqual([command, 'allow'])
    }
  })

  it('a download NAMING a non-record file in the data folder is judged as before (bypass allows, default asks the Bash card — read at 74033faad)', () => {
    for (const command of [`curl -o ${CONFIG_DIR}/notes.txt ${U}/x`, `wget -O ${CONFIG_DIR}/notes.txt ${U}/x`]) {
      expect([command, check(command, 'bypassPermissions')]).toEqual([command, 'allow'])
      expect([command, check(command, 'default')]).toEqual([command, 'card(bash)'])
    }
  })

  it('STATED residue: an interpreter\'s extraction, and an extraction into the session\'s OWN workspace root, are not refused', () => {
    // A static scan cannot read what an interpreter's code writes (F1.713's residue); the path it spells is read only when it names a record.
    expect(check(`python3 -c "import tarfile; tarfile.open('${S}/x.tar').extractall('${CONFIG_DIR}')"`)).toBe('allow')
    // The own root is a no-project session's working folder; F1.945 lists a copied folder or wildcard, but an archive's names are inside it.
    expect(check(`tar -xf ${S}/x.tar -C ${WS_OWN}`)).toBe('allow')
  })
})

/**
 * F1.950 (DN-149, 2026-09-26, the owner's option a) — `scp` joins F1.922's copy family
 * and `aria2c` joins F1.944's downloaders; the rarer extractors (`cpio -i`, `pax -r`,
 * `ar x`, `jar x`), interpreters and options from a config file stay the static scan's
 * stated limit (the OS-level answer, the sandbox, is off by the owner's standing decision).
 *
 * - **scp** (`man scp`, OpenSSH: "source ... target", the value options `-c -D -F -i -J
 *   -l -o -P -S -X`): its pairs are read as `cp`'s are, so a remote file named like a
 *   record is refused naming the record, and any other remote source — never an existing
 *   local file — into the data folder, `workspaces` or another workspace's folder is
 *   refused whole, naming the folder.
 * - **aria2c** (the aria2c manual: `-d, --dir` "The directory to store the downloaded
 *   file", default the cwd; `-o, --out` "always relative to the directory given in
 *   --dir"): a download into such a folder is refused whole; `-o`/`--out` and
 *   `-O`/`--index-out` name a file under the dir, `-l`/`--log`, `--save-session` and
 *   `--save-cookies` name a file as spelled.
 */
for (const f of ['x.torrent', 'uris.txt']) writeFileSync(join(STAGE, f), '')
const F1950_ARMS: Array<[string, string, string, string?]> = [
  // scp — the row's shape, then the same write spelled other ways.
  ['scp a remote record into CONFIG_DIR/', `scp host:x/hooks.json ${CONFIG_DIR}/`, 'record:hooks.json'],
  ['scp -P/-i values skipped, into another workspace', `scp -P 2222 -i ${S}/id_x user@host:/srv/permissions.json ${WS_OTHER}/`, `record:${OTHER_REL}/permissions.json`],
  ['scp -o value, a URI source', `scp -o ProxyJump=bastion scp://host/x/config.json ${CONFIG_DIR}`, 'record:config.json'],
  ['cd CONFIG_DIR + scp to .', `cd ${CONFIG_DIR} && scp host:x/mcp.json .`, 'record:mcp.json'],
  ['scp a local record file', `scp ${S}/hooks.json ${CONFIG_DIR}/`, 'record:hooks.json'],
  ['scp -r a remote folder', `scp -r host:tree ${CONFIG_DIR}`, `folder:${CONFIG_DIR}`],
  ['scp a remote non-record file (never a local file: names unknown)', `scp host:x/notes.txt ${CONFIG_DIR}/`, `folder:${CONFIG_DIR}`],
  ['scp -rp a remote folder into the workspaces folder', `scp -rp host:ws ${CONFIG_DIR}/workspaces/`, 'folder:workspaces'],
  ['nested sh -c scp', `sh -c 'scp -q host:x/hooks.json ${CONFIG_DIR}/'`, 'record:hooks.json'],
  ['own workspace: scp to . from its root', `scp host:x/permissions.json .`, 'ws-record:permissions.json', WS_OWN],
  // aria2c — into -d/--dir, else the cwd.
  ['aria2c -d CONFIG_DIR', `aria2c -d ${CONFIG_DIR} ${U}/hooks.json`, `folder:${CONFIG_DIR}`],
  ['aria2c --dir=', `aria2c --dir=${CONFIG_DIR} ${U}/x`, `folder:${CONFIG_DIR}`],
  ['aria2c --dir <another workspace>', `aria2c --dir ${WS_OTHER} ${U}/permissions.json`, `folder:${OTHER_REL}`],
  ['aria2c -x16 -s 16 values skipped, -d the workspaces folder', `aria2c -x16 -s 16 -d ${CONFIG_DIR}/workspaces ${U}/x`, 'folder:workspaces'],
  ['cd CONFIG_DIR + aria2c', `cd ${CONFIG_DIR} && aria2c -c ${U}/hooks.json`, `folder:${CONFIG_DIR}`],
  ['aria2c from the data folder', `aria2c ${U}/x`, `folder:${CONFIG_DIR}`, CONFIG_DIR],
  ['aria2c -T a torrent, no URI', `aria2c -T ${S}/x.torrent -d ${CONFIG_DIR}`, `folder:${CONFIG_DIR}`],
  ['aria2c -i a URI list into another workspace', `aria2c -i ${S}/uris.txt -d ${WS_OTHER}`, `folder:${OTHER_REL}`],
  ['nested sh -c aria2c', `sh -c 'aria2c -d ${CONFIG_DIR} ${U}/x'`, `folder:${CONFIG_DIR}`],
  ['aria2c -o glued, a record name, from the data folder', `aria2c -ohooks.json ${U}/x`, 'record:hooks.json', CONFIG_DIR],
  ['aria2c --out= under --dir=', `aria2c --out=hooks.json --dir=${CONFIG_DIR} ${U}/x`, 'record:hooks.json'],
  ['aria2c -o under a -d that contains the data folder', `aria2c -d ${dirname(CONFIG_DIR)} -o ${basename(CONFIG_DIR)}/hooks.json ${U}/x`, 'record:hooks.json'],
  ['aria2c -O index=path under -d', `aria2c -T ${S}/x.torrent -d ${dirname(CONFIG_DIR)} -O 1=${basename(CONFIG_DIR)}/mcp.json`, 'record:mcp.json'],
  ['aria2c -l glued, a record as the log file', `aria2c -l${CONFIG_DIR}/hooks.json -d ${PROJECT} ${U}/x`, 'record:hooks.json'],
]

describe('F1.950 — scp and aria2c into a record\'s folder are refused like the copy and download families, in every mode', () => {
  for (const mode of [...MODES, 'dontAsk'] as const) {
    for (const [label, command, expected, cwd] of F1950_ARMS) {
      it(`${mode}: ${label} -> ${expected.split(':')[0]}`, () => { expectRefused(check(command, mode, cwd), expected, mode) })
    }
  }
})

describe('F1.950 — CONTROLS', () => {
  it('scp and aria2c into an ordinary folder or skills/, and scp OUT of the data folder, are unchanged', () => {
    for (const [command, cwd] of [
      [`scp host:x/hooks.json ${PROJECT}/`, PROJECT], [`scp -P 2222 host:x ${PROJECT}`, PROJECT], [`scp -r host:tree ${CONFIG_DIR}/skills/`, PROJECT],
      [`scp -r ${CONFIG_DIR}/skills host:backup/`, PROJECT], [`scp ${PROJECT}/a host:`, CONFIG_DIR],
      [`aria2c -d ${PROJECT} ${U}/hooks.json`, PROJECT], [`cd ${PROJECT} && aria2c ${U}/hooks.json`, PROJECT], [`aria2c --dir=${CONFIG_DIR}/skills ${U}/SKILL.md`, PROJECT],
      [`aria2c -d ${PROJECT} -o hooks.json ${U}/x`, PROJECT], [`aria2c -l - -d ${PROJECT} ${U}/x`, CONFIG_DIR], [`aria2c --version`, CONFIG_DIR], [`aria2c -h`, CONFIG_DIR],
    ] as const) {
      expect([command, check(command, 'bypassPermissions', cwd)]).toEqual([command, 'allow'])
    }
  })

  it('a LOCAL non-record file scp\'d into the data folder is judged as before (bypass allows, default asks the Bash card — read at 3648568f1)', () => {
    expect(check(`scp ${S}/notes.txt ${CONFIG_DIR}/`, 'bypassPermissions')).toBe('allow')
    expect(check(`scp ${S}/notes.txt ${CONFIG_DIR}/`, 'default')).toBe('card(bash)')
  })

  it('STATED residue: the rarer extractors, aria2c\'s config file, and a torrent\'s paths into a folder that contains the data folder are not refused', () => {
    // The owner's option a: `cpio -i`, `pax -r`, `ar x`, `jar x` stay unread, as interpreters do (F1.713).
    expect(check(`cd ${CONFIG_DIR} && cpio -i < ${S}/x.cpio`)).toBe('allow')
    expect(check(`cd ${CONFIG_DIR} && pax -r -f ${S}/x.pax`)).toBe('allow')
    // Options from a config file (`--conf-path`, `~/.aria2/aria2.conf`) are not read, as `~/.curlrc` is not.
    expect(check(`aria2c --conf-path=${S}/aria2.conf ${U}/x`)).toBe('allow')
    // A download is read flat, as `curl -O` is: a torrent's own paths are not assumed to be able to reach the data folder.
    expect(check(`aria2c -T ${S}/x.torrent -d ${dirname(CONFIG_DIR)}`)).toBe('allow')
  })
})

/**
 * F1.945 (DN-169, 2026-09-26, the owner's option a) — a copy into the session's OWN
 * workspace root whose written names the command does not spell: the gate LISTS the
 * source now and refuses only when a listed name is one of the root's records
 * (`permissions.json`, `automations.json`, `automations-history.jsonl`, any letter case).
 *
 * Read at HEAD `63c962185` (bypassPermissions): `cp -R <x>/ <root>` and `cp <x>/* .`
 * from the root, with `<x>` holding `permissions.json`, ALLOWED — F1.922 carves the own
 * root out of its fail-closed refusal, because refusing every tree copy there would
 * refuse ordinary work in a no-project session. The same listing reads a wildcard into
 * a folder that contains the data folder, F1.922's other stated residue.
 */
for (const d of ['plant', 'plantcase', 'plain', 'asown/my-ws']) mkdirSync(join(STAGE, d), { recursive: true })
for (const f of ['plant/permissions.json', 'plant/notes.txt', 'plantcase/AUTOMATIONS.json', 'plain/notes.txt', 'asown/my-ws/permissions.json']) writeFileSync(join(STAGE, f), '{}')
// A workspace whose root lives outside the data folder, for a folder copied in AS that root from its parent.
const OUTER = mkdtempSync(join(tmpdir(), 'f1945-outer-'))
mkdirSync(join(OUTER, 'my-ws'))
process.on('exit', () => { rmSync(OUTER, { recursive: true, force: true }) })

const F1945_ARMS: Array<[string, string, string, string?]> = [
  // The row's two shapes.
  ['a folder\'s contents into the root', `cp -R ${S}/plant/ ${WS_OWN}`, 'ws-record:permissions.json'],
  ['a wildcard into . from the root', `cp ${S}/plant/* .`, 'ws-record:permissions.json', WS_OWN],
  // The same writes spelled other ways.
  ['<x>/. into . from the root', `cp -R ${S}/plant/. .`, 'ws-record:permissions.json', WS_OWN],
  ['rsync a folder\'s contents', `rsync -a ${S}/plant/ ${WS_OWN}/`, 'ws-record:permissions.json'],
  ['ditto a folder (its contents)', `ditto ${S}/plant ${WS_OWN}`, 'ws-record:permissions.json'],
  ['cd + mv a *.json wildcard', `cd ${WS_OWN} && mv ${S}/plant/*.json .`, 'ws-record:permissions.json'],
  ['ln -s a wildcard', `ln -s ${S}/plant/* ${WS_OWN}/`, 'ws-record:permissions.json'],
  ['a brace list', `cp ${S}/plant/{notes.txt,permissions.json} ${WS_OWN}/`, 'ws-record:permissions.json'],
  ['a wildcard folder\'s contents', `cp -R ${S}/plan?/ ${WS_OWN}`, 'ws-record:permissions.json'],
  ['a record name in another letter case', `cp -R ${S}/plantcase/ ${WS_OWN}`, 'ws-record:automations.json'],
  // F1.922's other residue: a wildcard whose match lands AS the data folder, from its parent.
  ['a wildcard into a folder that contains the data folder', `cp -R ${LOOKALIKE}/* ${dirname(CONFIG_DIR)}/`, `folder:${CONFIG_DIR}`],
]

/** `check` with the workspace root elsewhere — a root outside the data folder. */
function checkRoot(command: string, root: string, mode: PermissionMode = 'bypassPermissions'): string {
  cleanupModeState(KEY)
  initializeModeState(KEY, mode)
  const r = runPreToolUseChecks({
    toolName: 'Bash', input: { command }, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: mode,
    workspaceRootPath: root, workspaceId: KEY.workspaceId, workingDirectory: PROJECT,
    activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
  })
  if (r.type !== 'block') return r.type
  return /^Direct \S+ operations targeting `([^`]+)` are blocked\. /.exec(r.reason)?.[1] ?? 'block'
}

describe('F1.945 — a folder\'s contents or a wildcard copied into the session\'s OWN workspace root is refused when its listing holds a record, in every mode', () => {
  for (const mode of [...MODES, 'dontAsk'] as const) {
    for (const [label, command, expected, cwd] of F1945_ARMS) {
      it(`${mode}: ${label} -> ${expected.split(':')[0]}`, () => { expectRefused(check(command, mode, cwd), expected, mode) })
    }
  }

  it('a folder copied in AS a root that lives outside the data folder, from its parent (literal and wildcard)', () => {
    expect(checkRoot(`cp -R ${S}/asown/my-ws ${OUTER}/`, join(OUTER, 'my-ws'))).toBe('permissions.json')
    expect(checkRoot(`cp -R ${S}/asown/* ${OUTER}`, join(OUTER, 'my-ws'))).toBe('permissions.json')
  })

  it('the refusal names the record, the source and the way on', () => {
    cleanupModeState(KEY)
    initializeModeState(KEY, 'bypassPermissions')
    const r = runPreToolUseChecks({
      toolName: 'Bash', input: { command: `cp -R ${S}/plant/ ${WS_OWN}` }, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: 'bypassPermissions',
      workspaceRootPath: WS_OWN, workspaceId: KEY.workspaceId, workingDirectory: PROJECT,
      activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
    })
    const reason = r.type === 'block' ? r.reason : ''
    expect(reason).toContain('Settings > Permissions')
    expect(reason).toContain(`${S}/plant/`)
    expect(reason).toContain('copy the other files by name')
  })
})

describe('F1.945 — CONTROLS', () => {
  it('a tree or wildcard with no record, a folder copied INTO the root, and copies elsewhere still run', () => {
    for (const [command, cwd] of [
      [`cp -R ${S}/plain/ ${WS_OWN}`, PROJECT], [`cp ${S}/plant/*.txt ${WS_OWN}/`, PROJECT], [`cp ${S}/plant/n* .`, WS_OWN],
      [`cp -R ${S}/plant ${WS_OWN}/`, PROJECT], [`cp -R ${S}/plant/ ${WS_OWN}/sub/`, PROJECT], [`cp -R ${S}/plant/ ${PROJECT}/`, PROJECT],
      [`cp ${S}/plant/* ${PROJECT}/`, PROJECT], [`cp ${S}/nothere/* ${WS_OWN}/`, PROJECT], [`cp -R ${S}/plan[!t]/ ${WS_OWN}`, PROJECT],
      [`cp -R ${S}/plain/* ${dirname(CONFIG_DIR)}/`, PROJECT],
    ] as const) {
      expect([command, check(command, 'bypassPermissions', cwd)]).toEqual([command, 'allow'])
    }
    expect(checkRoot(`cp -R ${S}/plain ${OUTER}/`, join(OUTER, 'my-ws'))).toBe('allow')
  })

  it('STATED residue: a source the gate cannot list is not refused (an archive extracted into the root is F1.944\'s residue above)', () => {
    // A folder the command fills first, and a remote scp source, cannot be listed at gate time.
    expect(check(`mkdir ${PROJECT}/made && printf '{}' > ${PROJECT}/made/permissions.json && cp -R ${PROJECT}/made/ ${WS_OWN}`)).toBe('allow')
    expect(check(`scp -r host:x/ ${WS_OWN}`)).toBe('allow')
  })
})

/**
 * F1.1015 (DN-184, 2026-09-26) — a FOLDER copied in AS a folder that contains the data
 * folder (`cp -R /tmp/x/me /Users/`, which lands as the home folder) merges its tree into
 * that folder, so a tree holding the data folder's own path (`me/.nessy-agent/hooks.json`)
 * writes into the data folder. MEASURED at HEAD `539f577fc` in a scratch HOME and data
 * folder: ALLOW in bypassPermissions and auto, an ordinary Bash card in default and
 * acceptEdits, and the planted `hooks.json` landed — F1.922 checked the landing
 * `<dest>/<name>` only against the data folder, `workspaces` and another workspace's
 * folder. The gate now lists the source's tree along the data folder's path (any letter
 * case) and refuses the copy whole, as it refuses a folder landing AS the data folder. The
 * same listing reads a folder (or a folder's contents) landing above a workspace root that
 * lives outside the data folder, where F1.945's records decide.
 */
const ABOVE = basename(dirname(CONFIG_DIR)) // the data folder's parent's name
const GRAND = dirname(dirname(CONFIG_DIR)) // a folder of that name copied in here lands AS the parent
for (const d of [`lift/${ABOVE}/${basename(CONFIG_DIR)}`, `liftcase/${ABOVE}/${basename(CONFIG_DIR).toUpperCase()}`, `lift2/${basename(GRAND)}/${ABOVE}/${basename(CONFIG_DIR)}`, `liftplain/${ABOVE}/other`, `asup/${basename(OUTER)}/my-ws`]) mkdirSync(join(STAGE, d), { recursive: true })
for (const f of [`lift/${ABOVE}/${basename(CONFIG_DIR)}/hooks.json`, `lift2/${basename(GRAND)}/${ABOVE}/${basename(CONFIG_DIR)}/hooks.json`, `liftplain/${ABOVE}/other/hooks.json`, `asup/${basename(OUTER)}/my-ws/permissions.json`]) writeFileSync(join(STAGE, f), '{}')

const F1015_ARMS: Array<[string, string, string, string?]> = [
  // The row's shape: a folder named like the data folder's parent, copied in from above it.
  ['a folder landing AS the data folder\'s parent', `cp -R ${S}/lift/${ABOVE} ${GRAND}/`, `folder:${CONFIG_DIR}`],
  // The same write spelled other ways.
  ['rsync, no slash', `rsync -a ${S}/lift/${ABOVE} ${GRAND}`, `folder:${CONFIG_DIR}`],
  ['mv', `mv ${S}/lift/${ABOVE} ${GRAND}/`, `folder:${CONFIG_DIR}`],
  ['cd + cp to .', `cd ${GRAND} && cp -R ${S}/lift/${ABOVE} .`, `folder:${CONFIG_DIR}`],
  ['the data folder\'s name in another letter case', `cp -R ${S}/liftcase/${ABOVE} ${GRAND}/`, `folder:${CONFIG_DIR}`],
  // The shape needs a NAMED grandparent. On the Linux CI runner (`TMPDIR` unset) the preload's data folder is
  // `/tmp/nessy-shared-tests-config-…`, its grandparent is `/`, and the command collapses to the tree's CONTENTS poured
  // into `/` (`cp -R <stage>/lift2/ //`) — F1.922's contents-into-a-containing-folder refusal, which names `/`. That
  // layout gets that arm, asserted by its own name, instead of a label and an expectation that do not apply to it.
  dirname(GRAND) !== GRAND
    ? ['two levels above', `cp -R ${S}/lift2/${basename(GRAND)} ${dirname(GRAND)}/`, `folder:${CONFIG_DIR}`]
    : ['two levels above, a two-deep data folder: the tree poured into /', `cp -R ${S}/lift2/ /`, 'folder:/'],
  ['a wildcard whose match lands AS the parent', `cp -R ${S}/lift/* ${GRAND}/`, `folder:${CONFIG_DIR}`],
  // Fail closed, as F1.922 refuses a non-file landing AS the data folder: a source that does not exist yet cannot be listed.
  ['a folder the command makes first', `mkdir -p ${PROJECT}/made2/${ABOVE}/${basename(CONFIG_DIR)} && cp -R ${PROJECT}/made2/${ABOVE} ${GRAND}/`, `folder:${CONFIG_DIR}`],
]

describe('F1.1015 — a folder copied in AS a folder above the data folder is refused when its tree holds the data folder, in every mode', () => {
  for (const mode of [...MODES, 'dontAsk'] as const) {
    for (const [label, command, expected, cwd] of F1015_ARMS) {
      it(`${mode}: ${label} -> ${expected.split(':')[0]}`, () => { expectRefused(check(command, mode, cwd), expected, mode) })
    }
  }

  it('a folder, or a folder\'s contents, landing above a root that lives outside the data folder is refused when the root\'s part of its tree holds a record', () => {
    expect(checkRoot(`cp -R ${S}/asup/${basename(OUTER)} ${dirname(OUTER)}/`, join(OUTER, 'my-ws'))).toBe('permissions.json')
    expect(checkRoot(`cp -R ${S}/asown/ ${OUTER}`, join(OUTER, 'my-ws'))).toBe('permissions.json')
  })
})

describe('F1.1015 — CONTROLS', () => {
  it('a tree that does not hold the data folder\'s path, and a folder that lands beside it, still run', () => {
    for (const command of [`cp -R ${S}/liftplain/${ABOVE} ${GRAND}/`, `cp -R ${S}/liftplain/* ${GRAND}/`, `cp -R ${S}/tree ${GRAND}/`, `rsync -a ${S}/lift/${ABOVE} ${PROJECT}/`]) {
      expect([command, check(command)]).toEqual([command, 'allow'])
    }
    expect(checkRoot(`cp -R ${S}/plain/ ${OUTER}`, join(OUTER, 'my-ws'))).toBe('allow')
  })

  it('STATED residue: an existing tree the command fills first is not refused', () => {
    expect(check(`mkdir -p ${S}/liftplain/${ABOVE}/${basename(CONFIG_DIR)} && cp -R ${S}/liftplain/${ABOVE} ${GRAND}/`)).toBe('allow')
  })
})

/**
 * F1.1136 (origin DN-184, 2026-09-26) — GNU `-T` / `--no-target-directory` (cp, mv, install, ln and their `g`
 * spellings) makes the destination the copy itself, so a folder source lands its CONTENTS there with no trailing
 * slash: `gcp -rT x/me ~` is `cp -R x/me/ ~`. F1.1015's listing read only the slash spelling, so the `-T` one ran
 * (DN-184's pinned residue, `allow` in bypassPermissions); {@link shellCopyPairs} now reads `-T` as the contents form.
 */
describe('F1.1136 — GNU cp -T is read as a folder\'s contents', () => {
  for (const mode of [...MODES, 'dontAsk'] as const) {
    for (const command of [`gcp -rT ${S}/lift/${ABOVE} ${dirname(CONFIG_DIR)}`, `cp -R --no-target-directory ${S}/lift/${ABOVE} ${dirname(CONFIG_DIR)}`, `gmv -T ${S}/lift/${ABOVE} ${dirname(CONFIG_DIR)}`]) {
      it(`${mode}: ${command.split(' ')[0]} ${command.split(' ')[1]} -> folder`, () => { expectRefused(check(command, mode), `folder:${dirname(CONFIG_DIR)}`, mode) })
    }
  }

  it('CONTROL — the same -T copy into a folder beside the data folder, and an rsync -T (a temp dir there), still run', () => {
    for (const command of [`gcp -rT ${S}/lift/${ABOVE} ${PROJECT}/t1136`, `rsync -a -T ${PROJECT}/tmp1136 ${S}/liftplain/${ABOVE} ${PROJECT}/r1136`]) {
      expect([command, check(command)]).toEqual([command, 'allow'])
    }
  })
})

/**
 * UA12.2 (2026-10-05) — the own-root listing knows the PATTERN records. UA1.10 made
 * `tasks/<slug>/task.yaml`, `pages/<slug>/page.json`, `projects/<slug>/config.json`
 * and `projects/<slug>/context.md` records of the session's OWN workspace, but
 * {@link shellCopyOwnRootRecord} judged only the listed TOP-level names, so a tree
 * copy into the root could land the record one or two levels down with no refusal
 * (`cp -R <x>/ <root>` with `<x>/tasks/<slug>/task.yaml`: ALLOW in bypassPermissions
 * at the RED run of this suite, where the same path written directly is refused). The
 * listing now descends exactly where a pattern's first segment says a record can sit:
 * the merged contents of a source, a wildcard match, a folder landing AS the root, the
 * root's part of a tree landing above it — and, new, a folder NAMED like a pattern's
 * first segment copied INTO the root, which writes the record one level down (for the
 * exact records that spelling was harmless; for the patterns it IS the record).
 */
for (const d of ['pt/tasks/spec-7', 'pp/pages/mypage', 'pj/projects/prj', 'pc/tasks/spec-7', 'wp/pages/mypage', 'ip/pages/mypage', 'ap/my-ws/tasks/spec-7', 'ha']) mkdirSync(join(STAGE, d), { recursive: true })
for (const f of ['pt/tasks/spec-7/task.yaml', 'pp/pages/mypage/page.json', 'pj/projects/prj/config.json', 'pj/projects/prj/context.md', 'pc/tasks/spec-7/notes.md', 'wp/pages/mypage/page.json', 'ip/pages/mypage/page.json', 'ap/my-ws/tasks/spec-7/task.yaml', 'ha/host-approvals.json']) writeFileSync(join(STAGE, f), '{}')

const UA122_ARMS: Array<[string, string, string, string?]> = [
  // The row's shapes: a tree whose contents merge into the root one or two levels down.
  ['a folder\'s contents holding a task spec into the root', `cp -R ${S}/pt/ ${WS_OWN}`, 'ws-record:tasks/spec-7/task.yaml'],
  ['a wildcard whose match is a pages folder into . from the root', `cp ${S}/wp/* .`, 'ws-record:pages/mypage/page.json', WS_OWN],
  ['rsync a project tree\'s contents', `rsync -a ${S}/pj/ ${WS_OWN}/`, 'ws-record:projects/prj/config.json'],
  // A folder NAMED like a pattern's first segment, copied INTO the root.
  ['a pages folder copied INTO the root', `cp -R ${S}/ip/pages ${WS_OWN}/`, 'ws-record:pages/mypage/page.json'],
  // LF-1: the exact host-approvals ledger was read by the own-root listing since UA1.10 (GUARDED_WORKSPACE_RECORDS); pinned here.
  ['a folder\'s contents holding the host-approvals ledger into the root', `cp -R ${S}/ha/ ${WS_OWN}`, 'ws-record:host-approvals.json'],
]

describe('UA12.2 — a copy into the session\'s OWN workspace root is refused when the tree it merges holds a pattern record, in every mode', () => {
  for (const mode of [...MODES, 'dontAsk'] as const) {
    for (const [label, command, expected, cwd] of UA122_ARMS) {
      it(`${mode}: ${label} -> ${expected.split(':')[0]}`, () => { expectRefused(check(command, mode, cwd), expected, mode) })
    }
  }

  it('a folder landing AS a root that lives outside the data folder, from its parent', () => {
    expect(checkRoot(`cp -R ${S}/ap/my-ws ${OUTER}/`, join(OUTER, 'my-ws'))).toBe('tasks/spec-7/task.yaml')
  })
})

describe('UA12.2 — CONTROLS', () => {
  it('a tree holding no pattern record, a match that is not a pattern folder, and landings that are not the root\'s records still run', () => {
    for (const [command, cwd] of [
      [`cp -R ${S}/pc/ ${WS_OWN}`, PROJECT],
      [`cp ${S}/pc/tasks/* ${WS_OWN}/`, PROJECT],
      [`cp -R ${S}/ip ${WS_OWN}/`, PROJECT],
      [`cp -R ${S}/ip/pages ${WS_OWN}/sub/`, PROJECT],
      [`cp -R ${S}/pt/tasks ${WS_OWN}/deeper/`, PROJECT],
      [`cp -R ${S}/pt/ ${PROJECT}/`, PROJECT],
    ] as const) {
      expect([command, check(command, 'bypassPermissions', cwd)]).toEqual([command, 'allow'])
    }
  })
})
