/**
 * UA5.6 `[measure]` — agent READ reach to a project's `projects/<slug>/assets/` on the three runtimes, taken 2026-10-02,
 * beside the plan's control `statuses/config.json` (an ordinary workspace file every agent reads by design: the status
 * set). STRUCTURAL readings on the instrument UA1.10 and UA5.12 used:
 *
 * - **Pi and Claude** — the gate both call (`runPreToolUseChecks`), per permission mode, for the read tools `Read`,
 *   `Grep` and `Glob` (path = the assets directory) and a shell read (`cat`, with an empty command allowlist — the stub
 *   permission manager UA1.10's suite uses), for cwd = the workspace root (a folderless project's session) and cwd = a
 *   folder outside the workspace (a foldered project's session).
 * - **codex** — its reads never pass that gate; codex reads with its own built-ins under the profile the host emits,
 *   whose parent (`:read-only` / `:workspace`) reads the whole disk (`codex-agent.ts` `codexApprovalFloorSubjects`
 *   docblock, item 1: projecting a read fence "means denying the whole filesystem", a posture never taken), so what
 *   decides reach is the host's DENY list. Its two producers are read here: `codexConfigDirProjection` (the config dir
 *   denied outright when another writable root contains it, F1.664) and the guarded record lists (exact names only).
 *   The rig is home-anchored, as AGENTS.md asks of codex rigs (`$TMPDIR` is itself a codex writable root).
 *
 * What these readings decide (UA5.6, spec §12 "Assets"): upstream's manifest instruction — "Read a specific file
 * on-demand by its absolute path (<project_assets_path> + filename)" — is one every runtime can follow under its
 * ordinary posture, exactly as it reads `statuses/config.json`; so the asset CRUD, its RPC and the manifest are PORTED,
 * not refused. Residue (stated): with an added directory that contains the config dir (e.g. the home folder), codex is
 * denied the WHOLE config dir (F1.664) — the assets AND the control alike; Pi and Claude are unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GUARDED_WORKSPACE_RECORDS,
  GUARDED_WORKSPACE_RECORD_PATTERNS,
  runPreToolUseChecks,
  type PermissionManagerLike,
} from '../../agent/core/pre-tool-use.ts'
import { codexConfigDirProjection } from '../../agent/codex-agent.ts'
import type { PermissionMode } from '../../agent/mode-types.ts'
import { cleanupModeState, initializeModeState } from '../../agent/mode-manager.ts'

const GATE_KEY = { workspaceId: 'ws-ua56', sessionId: 'session-ua56' }
const stubPermissions: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

let sandbox: string
let ws: string
let outside: string

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-ua56-')))
  ws = join(sandbox, 'nessy-config', 'workspaces', 'ws-a')
  outside = join(sandbox, 'code', 'repo')
  for (const dir of [join(ws, 'projects', 'acme', 'assets'), join(ws, 'statuses'), outside]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(ws, 'projects', 'acme', 'assets', 'spec.pdf'), '%PDF-1.4')
  writeFileSync(join(ws, 'statuses', 'config.json'), '{}')
})

afterAll(() => { rmSync(sandbox, { recursive: true, force: true }) })

function verdict(toolName: string, input: Record<string, unknown>, mode: PermissionMode, cwd: string): string {
  cleanupModeState(GATE_KEY)
  initializeModeState(GATE_KEY, mode)
  try {
    return runPreToolUseChecks({
      toolName, input, sessionId: GATE_KEY.sessionId, sessionKey: GATE_KEY, permissionMode: mode,
      workspaceRootPath: ws, workspaceId: GATE_KEY.workspaceId, workingDirectory: cwd,
      activeSourceSlugs: [], allSourceSlugs: [], hasSourceActivation: false, permissionManager: stubPermissions,
    }).type
  } finally {
    cleanupModeState(GATE_KEY)
  }
}

const MODES: PermissionMode[] = ['plan', 'dontAsk', 'default', 'acceptEdits', 'auto', 'bypassPermissions']

/** Read Grep Glob Bash(cat), per mode, for a file and its directory. */
function readings(file: string, cwd: string): Record<string, string> {
  const target = join(ws, file)
  const dir = join(target, '..')
  return Object.fromEntries(MODES.map(mode => [mode, [
    verdict('Read', { file_path: target }, mode, cwd),
    verdict('Grep', { pattern: 'x', path: dir }, mode, cwd),
    verdict('Glob', { pattern: '*', path: dir }, mode, cwd),
    verdict('Bash', { command: `cat ${target}` }, mode, cwd),
  ].join(' ')]))
}

/** Read Grep Glob Bash(cat), per mode — the verdict `runPreToolUseChecks` returns (`prompt` = the card). Read 2026-10-02. */
const READ_REACH: Record<PermissionMode, string> = {
  plan: 'allow allow allow prompt',
  dontAsk: 'allow allow allow block',
  default: 'allow allow allow prompt',
  acceptEdits: 'allow allow allow prompt',
  auto: 'allow allow allow allow',
  bypassPermissions: 'allow allow allow allow',
}

describe('UA5.6 · read reach to projects/<slug>/assets/ (Read Grep Glob Bash(cat)), Pi and Claude, per mode', () => {
  it('READING — cwd = the workspace root (a folderless project session): every read tool allowed in every mode', () => {
    expect(readings('projects/acme/assets/spec.pdf', ws)).toEqual(READ_REACH)
  })

  it('READING — cwd = a folder outside the workspace (a foldered project session): the same verdicts', () => {
    expect(readings('projects/acme/assets/spec.pdf', outside)).toEqual(READ_REACH)
  })

  it('CONTROL — statuses/config.json, on the same instrument and both cwds: the same verdicts as the assets', () => {
    expect(readings('statuses/config.json', ws)).toEqual(READ_REACH)
    expect(readings('statuses/config.json', outside)).toEqual(READ_REACH)
  })

  it('CONTROL (can fail) — a guarded record beside them is told apart by the same instrument: its WRITE is refused', () => {
    const config = join(ws, 'projects', 'acme', 'config.json')
    expect(verdict('Write', { file_path: config, content: '{}' }, 'bypassPermissions', ws)).toBe('block')
    expect(verdict('Write', { file_path: join(ws, 'projects', 'acme', 'assets', 'spec.pdf'), content: 'x' }, 'bypassPermissions', ws)).toBe('allow')
  })
})

describe('UA5.6 · codex: the host deny list is what decides read reach', () => {
  // Home-anchored and never created: the projection only compares paths (realpath falls back to the literal).
  const probeRoot = join(homedir(), '.nessy-ua56-probe')
  const configDir = join(probeRoot, 'nessy-config')
  const workspaceRoot = join(configDir, 'workspaces', 'ws-a')
  const repo = join(probeRoot, 'code', 'repo')
  const roots = [tmpdir(), '/tmp']

  it('READING — default layout: nothing denied for cwd = the workspace root or an outside folder, so assets/ is readable like the control', () => {
    expect(codexConfigDirProjection(workspaceRoot, configDir, workspaceRoot, roots)).toEqual({ subpaths: [], deny: [] })
    expect(codexConfigDirProjection(repo, configDir, workspaceRoot, roots)).toEqual({ subpaths: [], deny: [] })
    const names = [...GUARDED_WORKSPACE_RECORDS.keys(), ...GUARDED_WORKSPACE_RECORD_PATTERNS.keys()]
    expect(names.some(name => name.includes('assets') || name.startsWith('statuses'))).toBe(false)
    // Positive control on the same list: the project config IS named.
    expect(names).toContain('projects/*/config.json')
  })

  it('RESIDUE — an added directory containing the config dir (home) denies the whole config dir: assets AND control alike', () => {
    const projection = codexConfigDirProjection(repo, configDir, workspaceRoot, [...roots, homedir()])
    expect(projection.deny).toEqual([configDir])
    for (const file of ['projects/acme/assets/spec.pdf', 'statuses/config.json']) {
      expect(join(workspaceRoot, file).startsWith(`${projection.deny[0]}/`)).toBe(true)
    }
  })
})
