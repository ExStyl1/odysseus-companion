/**
 * F1.703 (DN-231, 2026-09-28) — the child probe behind `session-working-folder-floor.test.ts`.
 *
 * A CHILD per data-folder layout, as `session-plan-file-probe.ts` does: `CONFIG_DIR`
 * is frozen at import, so the parent exports `NESSY_CONFIG_DIR` (and a scratch
 * `HOME`) before bun starts. It never touches the real data folder; `configDir` is
 * printed so the parent asserts provenance before reading any verdict.
 *
 * It drives the one gate claude's PreToolUse hook and Pi's `pre_tool_use` bridge
 * both call (`runPreToolUseChecks`) with the production plans/data paths and, since
 * UB12.19, the gate inputs each runtime REALLY passes for a session with no project
 * (`CLAUDE` and `PI` below). Until then every case passed the session folder as
 * `workingDirectory`, a value no runtime produces: claude passes none (its child runs
 * in the session folder, D1.141) and Pi passes none (its tools run in the workspace
 * root), so the gate fell back to the workspace root and the F1.1098 lift pinned
 * green here never fired in production (the controller review's
 * w2-bk10-11-correctness finding 1).
 *
 * UB12.60 (CRITICAL) adds the DENY and OPEN arms: a user's `deniedPaths` entry in the
 * workspace's `permissions.json`, judged against a RELATIVE spelling with the same
 * no-project inputs. The secret folder sits beside the scratch data folder, never in a
 * real home.
 *
 * Every side effect is behind `import.meta.main`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { CONFIG_DIR } from '../../../config/paths.ts'
import { ensureConfigDir } from '../../../config/storage.ts'
import { getSessionDataPath, getSessionDirPath, getSessionPlansDir } from '../../../sessions/storage.ts'
import { runPreToolUseChecks, type PermissionManagerLike } from '../../core/pre-tool-use.ts'
import { cleanupModeState, initializeModeState } from '../../mode-manager.ts'
import type { PermissionMode } from '../../mode-types.ts'

const KEY = { workspaceId: 'ws-f1703', sessionId: 'session-f1703' }
const MODES: PermissionMode[] = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

function main(): void {
  ensureConfigDir()
  const workspaceRoot = join(CONFIG_DIR, 'workspaces', KEY.workspaceId)
  const session = getSessionDirPath(KEY.workspaceId, KEY.sessionId)
  const other = getSessionDirPath(KEY.workspaceId, 'session-f1703-other')
  for (const dir of [join(workspaceRoot, 'sources', 'linear'), join(session, 'plans'), join(session, 'data'), join(session, 'job', 'tmp'), join(session, 'attachments'), join(other, 'job', 'tmp')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(session, 'session.jsonl'), '{}\n')
  // UB12.60 — the user's own deny entry, and a folder beside it that no entry names (the OPEN arms).
  const secret = join(dirname(CONFIG_DIR), 'secret-ub1260'), beside = join(dirname(CONFIG_DIR), 'public-ub1260')
  for (const dir of [secret, beside]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'a.txt'), 'x') }
  writeFileSync(join(workspaceRoot, 'permissions.json'), `${JSON.stringify({ deniedPaths: [join(secret, '**')] })}\n`)

  // UB12.19 — the inputs each runtime's gate call passes for this no-project session. claude
  // (`ClaudeAgent`'s PreToolUse hook): no `workingDirectory` (`config.session.workingDirectory` is
  // unset), `runtimeCwd` = its child's spawn cwd (`resolveSpawnCwd`, this session folder) and
  // `shellHasClaudeJobDir`. Pi (`PiAgent`'s pre_tool_use bridge): no `workingDirectory` and no
  // `runtimeCwd` — its tools run in the workspace root (`PiAgent.resolvedCwd`), the gate's own fallback.
  interface Shape { cwd?: string; runtimeCwd?: string; claude?: boolean }
  const CLAUDE: Shape = { runtimeCwd: session, claude: true }
  const PI: Shape = {}
  const gate = (toolName: string, input: Record<string, unknown>, mode: PermissionMode, shape: Shape): string => {
    cleanupModeState(KEY)
    initializeModeState(KEY, mode)
    const r = runPreToolUseChecks({
      toolName, input, sessionId: KEY.sessionId, sessionKey: KEY, permissionMode: mode,
      workspaceRootPath: workspaceRoot, workspaceId: KEY.workspaceId, ...(shape.cwd ? { workingDirectory: shape.cwd } : {}),
      plansFolderPath: getSessionPlansDir(KEY.workspaceId, KEY.sessionId), dataFolderPath: getSessionDataPath(KEY.workspaceId, KEY.sessionId),
      activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager,
      ...(shape.claude ? { shellHasClaudeJobDir: true } : {}), ...(shape.runtimeCwd ? { runtimeCwd: shape.runtimeCwd } : {}),
    })
    cleanupModeState(KEY)
    if (r.type === 'prompt') return r.nonNegotiable === 'protectedPath' ? 'floor' : `card(${r.promptType})`
    if (r.type === 'block') return /protected path/.test(r.reason) ? 'floor-deny' : r.source === 'denied_path' ? 'denied' : 'block' // UB12.60: the deniedPaths floor by its own source
    return r.type
  }
  const write = (path: string) => ['Write', { file_path: path, content: 'x' }] as const
  const cases: Record<string, readonly [string, Record<string, unknown>, Shape]> = {
    'scratch job/tmp': [...write(join(session, 'job', 'tmp', 'x.txt')), CLAUDE],
    'data/': [...write(join(session, 'data', 'x.json')), CLAUDE],
    'downloads/': [...write(join(session, 'downloads', 'x.bin')), CLAUDE],
    'no-project cwd, relative file': [...write('hello.py'), CLAUDE],
    'no-project cwd, relative subfolder': [...write('src/app.py'), CLAUDE],
    'Edit in the session folder': ['Edit', { file_path: join(session, 'data', 'x.json'), old_string: 'x', new_string: 'y' }, CLAUDE],
    'CONTROL session.jsonl': [...write(join(session, 'session.jsonl')), CLAUDE],
    'CONTROL Session.JSONL': [...write(join(session, 'Session.JSONL')), CLAUDE],
    'CONTROL attachments/': [...write(join(session, 'attachments', 'a.txt')), CLAUDE],
    'CONTROL ATTACHMENTS/': [...write(join(session, 'ATTACHMENTS', 'a.txt')), CLAUDE],
    'CONTROL long_responses/': [...write(join(session, 'long_responses', 'r.txt')), CLAUDE],
    // F1.1062 (DN-247) — the two other host files at the folder's top level are records too.
    'CONTROL .pi-carry/': [...write(join(session, '.pi-carry', 'handoff.jsonl')), CLAUDE],
    'CONTROL checkout-move.patch': [...write(join(session, 'checkout-move.patch')), CLAUDE],
    'CONTROL Checkout-Move.PATCH': [...write(join(session, 'Checkout-Move.PATCH')), CLAUDE],
    // F1.1174 (DN-291) — the other host and runtime records in the same folder.
    'CONTROL .pi-sessions/': [...write(join(session, '.pi-sessions', 'zzz.jsonl')), CLAUDE],
    'CONTROL .pi-agent/': [...write(join(session, '.pi-agent', 'settings.json')), CLAUDE],
    'CONTROL .orchestrator/': [...write(join(session, '.orchestrator', 'run.jsonl')), CLAUDE],
    'CONTROL meta/': [...write(join(session, 'meta', 'claude-turn-anchors.json')), CLAUDE],
    'CONTROL hook-env/': [...write(join(session, 'hook-env', 'env.sh')), CLAUDE],
    'CONTROL file_checkpoints/': [...write(join(session, 'file_checkpoints', 'manifest.json')), CLAUDE],
    'CONTROL tool-metadata.json': [...write(join(session, 'tool-metadata.json')), CLAUDE],
    'CONTROL api-error.json': [...write(join(session, 'api-error.json')), CLAUDE],
    'CONTROL relative meta/ in the no-project cwd': [...write('meta/codex-turn-anchors.json'), CLAUDE],
    // F1.1062 — the READ the large-result preview asks for ("Use Read/Grep to access specific content").
    'Read long_responses/': ['Read', { file_path: join(session, 'long_responses', 'r.txt') }, CLAUDE],
    'Grep long_responses/': ['Grep', { pattern: 'x', path: join(session, 'long_responses') }, CLAUDE],
    "CONTROL another session's scratch": [...write(join(other, 'job', 'tmp', 'x.txt')), CLAUDE],
    'CONTROL escape via ..': [...write(join(session, 'job', '..', '..', 'session-f1703-other', 'x.txt')), CLAUDE],
    // F1.1098 (DN-231, DN-056) — the shell arm of the carve-out: every target the shell floors judge must be in the
    // session's own working folder (not a record); one that is not, or one the gate cannot resolve, keeps the floor.
    'SHELL into scratch': ['Bash', { command: `echo x > ${join(session, 'job', 'tmp', 'x.txt')}` }, CLAUDE],
    'SHELL relative file in the no-project cwd': ['Bash', { command: 'echo x > notes.txt' }, CLAUDE],
    'SHELL into data/': ['Bash', { command: `printf x > ${join(session, 'data', 'x.json')}` }, CLAUDE],
    'SHELL mkdir in data/': ['Bash', { command: `mkdir -p ${join(session, 'data', 'sub')}` }, CLAUDE],
    'SHELL unproven command naming the folder': ['Bash', { command: `f1098-unknown-tool ${join(session, 'data')}` }, CLAUDE],
    'SHELL $CLAUDE_JOB_DIR/tmp on claude': ['Bash', { command: 'echo x > $CLAUDE_JOB_DIR/tmp/a' }, CLAUDE],
    // UB12.6 — the positive arm of the glued reading: a value inside the own folder still lifts (the fix reads the
    // value; it does not decline every option), and the scratch exemption reads `data` as a target outside job/tmp.
    'SHELL --target-directory= inside the own folder': ['Bash', { command: 'cp job/tmp/a --target-directory=data' }, CLAUDE],
    'CONTROL shell $CLAUDE_JOB_DIR/tmp on Pi (the shell does not define it)': ['Bash', { command: 'echo x > $CLAUDE_JOB_DIR/tmp/a' }, PI],
    'CONTROL shell another variable': ['Bash', { command: 'echo x > $F1098_DIR/a' }, CLAUDE],
    'CONTROL shell into session.jsonl': ['Bash', { command: 'echo x >> session.jsonl' }, CLAUDE],
    'CONTROL shell into attachments/': ['Bash', { command: `echo x > ${join(session, 'attachments', 'a.txt')}` }, CLAUDE],
    "CONTROL shell into another session's scratch": ['Bash', { command: `echo x > ${join(other, 'job', 'tmp', 'x.txt')}` }, CLAUDE],
    // F1.1098 follow-up (VF-w2f, 2026-10-10) — a brace word. AGENT_CONFIG_SHELL_TOKEN reads `{`/`}` as token
    // separators, so `cp q {a,../session-f1703-other/session.jsonl}` is scanned as ONE token `a,../...` whose
    // resolve keeps the literal segment `a,..` below the session folder, while the shell expands the braces to
    // `a` and `../session-f1703-other/session.jsonl` — one level ABOVE it, another session's records included.
    // The gate resolves no brace expansion, so a brace anywhere in the scanned text keeps the floor, as a glob,
    // a backtick or an unexpanded variable does.
    'CONTROL shell brace word into another session': ['Bash', { command: 'cp q {a,../session-f1703-other/session.jsonl}' }, CLAUDE],
    'CONTROL shell brace word inside the own folder': ['Bash', { command: 'printf x > job/{a,b}.txt' }, CLAUDE],
    // UB12.6 (2026-10-16, the controller review's w2-bk10-11-contract finding 1) — a target GLUED to an option. The
    // lift resolved the whole word, so `--target-directory=..` stayed one literal segment below the session folder
    // and counted as own, while cp/mv/dd write the value: RED before (allow in default, acceptEdits and auto for the
    // first five, a rememberable Bash card for dd) where floor is pinned. Now the value after each `=` and after a
    // short option's letter is read as a target too ({@link shellWordGluedValues}).
    'CONTROL shell --target-directory= into another session': ['Bash', { command: 'cp job/tmp/session.jsonl --target-directory=../session-f1703-other' }, CLAUDE],
    'CONTROL shell mv --target-directory= over another session\'s transcript': ['Bash', { command: 'mv job/tmp/session.jsonl --target-directory=../session-f1703-other' }, CLAUDE],
    'CONTROL shell --target-directory= the workspace root': ['Bash', { command: `cp job/tmp/hooks.json --target-directory=${workspaceRoot}` }, CLAUDE],
    'CONTROL shell glued -t into another session': ['Bash', { command: 'cp -t../session-f1703-other job/tmp/session.jsonl' }, CLAUDE],
    'CONTROL shell --target-directory= the own attachments/': ['Bash', { command: 'mv job/tmp/x --target-directory=attachments' }, CLAUDE],
    'CONTROL shell dd of= into another session': ['Bash', { command: 'dd if=job/tmp/a of=../session-f1703-other/session.jsonl' }, CLAUDE],
    'CONTROL shell own scratch, then the workspace root': ['Bash', { command: `echo x > job/tmp/a.txt; echo y > ${join(workspaceRoot, 'notes.md')}` }, CLAUDE],
    'CONTROL shell own data/, then a cd out of it': ['Bash', { command: `printf x > data/a && cd ${workspaceRoot} && printf y > notes.md` }, CLAUDE],
    // UB12.19 — Pi's inputs. Its tools run in the workspace root, so a redirect-only command that names the session
    // folder by its full path lifts (the lift now reads a command's tokens only where the floors do: a command the
    // classifier cannot prove read-only), while a relative path lands in the workspace root and a write-shaped
    // command's own words resolve there — both keep the floor, the second as the stated residue.
    'SHELL Pi: a redirect into the scratch by full path': ['Bash', { command: `echo x > ${join(session, 'job', 'tmp', 'x.txt')}` }, PI],
    'SHELL Pi: a redirect into data/ by full path': ['Bash', { command: `printf x > ${join(session, 'data', 'x.json')}` }, PI],
    'CONTROL Pi: a relative redirect lands in the workspace root': ['Bash', { command: 'echo x > job/tmp/a.txt' }, PI],
    'CONTROL Pi: a write-shaped command whose words resolve into the workspace root': ['Bash', { command: `mkdir -p ${join(session, 'data', 'sub')}` }, PI],
    // UB12.19 — claude's child runs in the session folder while the acceptEdits/auto roots still resolve against the
    // workspace root, so a word that climbs out with `..` lands elsewhere for the shell: the lift declines it.
    'CONTROL claude: a word that climbs out of the session folder': ['Bash', { command: 'cp job/tmp/a ../../../../f1703-climb' }, CLAUDE],
    // UB12.19 (CRITICAL) — the same base for the control-record refusals: written from the session folder these climb
    // to the workspace's permissions.json and the global hooks.json (config.json answered the same in the row's probe).
    // Resolved against the workspace root (the gate's fallback) they named nothing, and answered a rememberable Bash
    // card, ALLOW in bypassPermissions.
    'RECORD claude: a relative climb to the workspace permissions.json': ['Bash', { command: `echo '{}' > ../../../workspaces/${KEY.workspaceId}/permissions.json` }, CLAUDE],
    'RECORD claude: a relative climb to the global hooks.json': ['Bash', { command: "echo '[]' > ../../../hooks.json" }, CLAUDE],
    'CONTROL workspace root file': [...write(join(workspaceRoot, 'notes.md')), PI],
    // UB12.60 (CRITICAL) — a user's deniedPaths entry against a RELATIVE spelling. The gate handed the deny floor
    // `workingDirectory` as its base (F1.1120), which neither runtime passes for a session with no project, so a
    // relative spelling had no base and the floor never saw the secret: RED before on the three relative arms
    // (allow in bypassPermissions). The two controls already answered denied: the instrument sees the floor.
    'DENY control: the absolute spelling': ['Bash', { command: `cat ${join(secret, 'a.txt')}` }, PI],
    'DENY control: the relative spelling in a project-shaped session (workingDirectory = the workspace root)': ['Bash', { command: `cat ${relative(workspaceRoot, join(secret, 'a.txt'))}` }, { cwd: workspaceRoot }],
    'DENY Pi: cat, relative from the workspace root its tools run in': ['Bash', { command: `cat ${relative(workspaceRoot, join(secret, 'a.txt'))}` }, PI],
    'DENY Pi: Read, relative from the workspace root its tools run in': ['Read', { file_path: relative(workspaceRoot, join(secret, 'a.txt')) }, PI],
    'DENY claude: cat, relative from the session folder its child runs in': ['Bash', { command: `cat ${relative(session, join(secret, 'a.txt'))}` }, CLAUDE],
    // The negative arm: the same climb to a folder no entry names stays open — the fix adds a base, not a refusal.
    'OPEN Pi: cat, relative from the workspace root, a folder beside the denied one': ['Bash', { command: `cat ${relative(workspaceRoot, join(beside, 'a.txt'))}` }, PI],
    'OPEN claude: cat, relative from the session folder, a folder beside the denied one': ['Bash', { command: `cat ${relative(session, join(beside, 'a.txt'))}` }, CLAUDE],
  }
  const verdicts: Record<string, Record<string, string>> = {}
  for (const [label, [tool, input, shape]] of Object.entries(cases)) {
    verdicts[label] = Object.fromEntries(MODES.map(mode => [mode, gate(tool, input, mode, shape)]))
  }
  process.stdout.write(`${JSON.stringify({ configDir: CONFIG_DIR, session, verdicts })}\n`)
}

if (import.meta.main) {
  main()
}
