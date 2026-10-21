/**
 * UA5.12 `[measure]` — agent read and write reach to a folderless project's `projects/<slug>/MEMORY.md`, on the
 * three runtimes, taken 2026-10-02 (OQ-9). These are STRUCTURAL readings on the instrument UA1.10 used for the five
 * guarded records: the gate Pi and Claude both call (`runPreToolUseChecks`), per permission mode, for the Read, Write
 * and Edit tools and a shell redirect (shell verdicts with an empty command allowlist — the stub permission manager
 * UA1.10's suite uses); codex never reaches that gate, so its reading is the record lists its profile is
 * built from plus F1.200's measurement on the vendored binary (`codex-workspace-record-floor.test.ts`, 2026-09-23:
 * with cwd = the workspace root — a session with no folder — a write inside the workspace exits 0, UNASKED, and the
 * only read-only subpaths are the exact guarded records).
 *
 * Two session shapes, because a folderless project's session has no folder of its own:
 * - **cwd = the workspace root** — `BaseAgent` falls back to it when the session has no working directory, so this is
 *   the folderless project's ordinary session. `MEMORY.md` is INSIDE the cwd.
 * - **cwd = a folder outside the workspace** — a session that took a workspace default folder (or a foldered project's,
 *   where OQ-9 keeps project memory off). `MEMORY.md` is OUTSIDE the cwd.
 *
 * The negative control is `projects/<slug>/config.json`, which the UA1.10 pattern guard refuses in every mode.
 * What these readings decide (UA5.12): the instruction upstream's block gave then — "record it in MEMORY.md at
 * <project_memory_path> via Write/Edit" (rewritten 2026-10-14, UB1.12: the block now names the append-only
 * `project_memory_append` tool; the WRITE reach these readings measured is unchanged) — is one every runtime can follow for a folderless project under the session's
 * ordinary posture (a card where the mode asks, none where it does not), and the file is readable everywhere. So
 * upstream's project memory is PORTED for folderless projects (spec §12 "Memory"), not recorded as KNOWN.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GUARDED_WORKSPACE_RECORDS,
  GUARDED_WORKSPACE_RECORD_PATTERNS,
  runPreToolUseChecks,
  type PermissionManagerLike,
} from '../../agent/core/pre-tool-use.ts'
import type { PermissionMode } from '../../agent/mode-types.ts'
import { cleanupModeState, initializeModeState } from '../../agent/mode-manager.ts'

const GATE_KEY = { workspaceId: 'ws-ua512', sessionId: 'session-ua512' }
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
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-ua512-')))
  ws = join(sandbox, 'nessy-config', 'workspaces', 'ws-a')
  outside = join(sandbox, 'code', 'repo')
  for (const dir of [join(ws, 'projects', 'acme'), outside]) mkdirSync(dir, { recursive: true })
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

function readings(rel: string, cwd: string): Record<string, string> {
  const target = join(ws, rel)
  return Object.fromEntries(MODES.map(mode => [mode, [
    verdict('Read', { file_path: target }, mode, cwd),
    verdict('Write', { file_path: target, content: '- note' }, mode, cwd),
    verdict('Edit', { file_path: target, old_string: 'a', new_string: 'b' }, mode, cwd),
    verdict('Bash', { command: `printf x >> ${target}` }, mode, cwd),
  ].join(' ')]))
}

/** Read Write Edit Bash, per mode — the verdict `runPreToolUseChecks` returns (`prompt` = the card). Read 2026-10-02. */
const MEMORY_READING: Record<PermissionMode, string> = {
  plan: 'allow block block prompt',
  dontAsk: 'allow block block block',
  default: 'allow prompt prompt prompt',
  acceptEdits: 'allow allow allow prompt',
  auto: 'allow allow allow prompt',
  bypassPermissions: 'allow allow allow allow',
}

describe('UA5.12 · reach to projects/<slug>/MEMORY.md (Read Write Edit Bash), Pi and Claude, per mode', () => {
  it('READING — cwd = the workspace root (a folderless project session): readable everywhere, written as any workspace file is', () => {
    expect(readings('projects/acme/MEMORY.md', ws)).toEqual(MEMORY_READING)
  })

  it('READING — cwd = a folder outside the workspace (a default-folder session): the same verdicts', () => {
    expect(readings('projects/acme/MEMORY.md', outside)).toEqual(MEMORY_READING)
  })

  it('CONTROL — the guarded config.json beside it: readable, and every write refused in every mode, on the same instrument', () => {
    const config = readings('projects/acme/config.json', ws)
    expect(config).toEqual(Object.fromEntries(MODES.map(mode => [mode, 'allow block block block'])))
  })
})

describe('UA5.12 · codex', () => {
  it('READING — MEMORY.md is in neither guarded list, so codex receives no read-only subpath for it (F1.200: writes inside a cwd = workspace root land unasked)', () => {
    const names = [...GUARDED_WORKSPACE_RECORDS.keys(), ...GUARDED_WORKSPACE_RECORD_PATTERNS.keys()]
    expect(names.some(name => name.endsWith('MEMORY.md'))).toBe(false)
    // Positive control on the same list: the project config IS guarded (as a pattern codex does not receive).
    expect(names.some(name => name.endsWith('config.json') && name.startsWith('projects/'))).toBe(true)
  })
})
