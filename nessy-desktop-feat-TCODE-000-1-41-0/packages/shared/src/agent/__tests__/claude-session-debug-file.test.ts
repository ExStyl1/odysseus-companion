/**
 * C3.215 — the claude child's per-session diagnostic file.
 *
 * The capability (M17) is a readable plaintext log when a runtime or an MCP
 * server fails, per session, in a place the product owns. claude writes one
 * natively; what this fork adds is the PATH and the enable switch, and the two
 * choices worth pinning are the ones a later edit would flip without noticing:
 *
 * - the log exists only while the HOST is in debug mode (a plaintext runtime log
 *   can carry prompt text, so it follows the switch a user already turns on to
 *   produce a report);
 * - an operator who set the vendor's own `CLAUDE_CODE_DEBUG_LOGS_DIR` keeps it.
 *
 * The reader half is the same function, so writer and reader cannot disagree
 * about which file exists — including in the case this fork makes common and the
 * vendor's docs never describe, a per-workspace `CLAUDE_CONFIG_DIR`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildClaudeSubprocessEnv } from '../options.ts'
import {
  CLAUDE_DEBUG_ENABLE_ENV,
  CLAUDE_DEBUG_LOG_PATH_ENV,
  claudeDefaultDebugLogPath,
  claudeSessionDebugLogCandidates,
  claudeSessionDebugLogPath,
  sessionRuntimeDebugLogDir,
  sessionRuntimeDebugLogPath,
} from '../session-debug-log.ts'

const NAMES = [
  'NESSY_DEBUG',
  'NESSY_SESSION_ID',
  CLAUDE_DEBUG_ENABLE_ENV,
  CLAUDE_DEBUG_LOG_PATH_ENV,
] as const

const prior = new Map(NAMES.map(name => [name, process.env[name]]))

/** `delete` before assigning, and on the restore path too (AGENTS.md §Traps). */
function setEnv(name: string, value: string | undefined): void {
  delete process.env[name]
  if (value !== undefined) process.env[name] = value
}

beforeEach(() => { for (const name of NAMES) setEnv(name, undefined) })
afterEach(() => { for (const name of NAMES) setEnv(name, prior.get(name)) })

describe('C3.215 — the host names the file, the binary writes it', () => {
  it('a debug-mode session gets a host-owned per-session path and the enable switch', () => {
    // POSITIVE. `NESSY_DEBUG` is resolved inside the builder from argv or the
    // ambient name, so setting it here is the same input a `--debug` launch gives.
    setEnv('NESSY_DEBUG', '1')
    setEnv('NESSY_SESSION_ID', 'sess-c3215-positive')
    const env = buildClaudeSubprocessEnv()
    expect(env[CLAUDE_DEBUG_ENABLE_ENV]).toBe('1')
    expect(env[CLAUDE_DEBUG_LOG_PATH_ENV])
      .toBe(sessionRuntimeDebugLogPath('claude', 'sess-c3215-positive'))
    // The directory is CREATED before it is named: a path nothing can write to
    // turns the vendor's own fallback into a silent loss.
    expect(existsSync(sessionRuntimeDebugLogDir())).toBe(true)
    // Enumerable, or the spread that builds the child's environment drops it.
    expect(Object.keys({ ...env })).toContain(CLAUDE_DEBUG_LOG_PATH_ENV)
  })

  it('an ordinary session gets no debug log at all', () => {
    // NEGATIVE, and the one that matters for privacy: a session nobody asked to
    // debug must not write a plaintext runtime log.
    setEnv('NESSY_SESSION_ID', 'sess-c3215-negative')
    const env = buildClaudeSubprocessEnv()
    expect(env[CLAUDE_DEBUG_ENABLE_ENV]).toBeUndefined()
    expect(env[CLAUDE_DEBUG_LOG_PATH_ENV]).toBeUndefined()
  })

  it('an operator\'s own path is honoured, not overwritten', () => {
    setEnv('NESSY_DEBUG', '1')
    setEnv('NESSY_SESSION_ID', 'sess-c3215-operator')
    setEnv(CLAUDE_DEBUG_LOG_PATH_ENV, '/tmp/an-operator-chose-this.txt')
    const env = buildClaudeSubprocessEnv()
    expect(env[CLAUDE_DEBUG_LOG_PATH_ENV]).toBe('/tmp/an-operator-chose-this.txt')
    // Still enabled: their path only works once debug mode is on, which is the
    // pairing `env-vars.md` spells out ("setting this variable alone does not
    // enable logging").
    expect(env[CLAUDE_DEBUG_ENABLE_ENV]).toBe('1')
  })

  it('a session with no identity names no file', () => {
    setEnv('NESSY_DEBUG', '1')
    const env = buildClaudeSubprocessEnv()
    expect(env[CLAUDE_DEBUG_LOG_PATH_ENV]).toBeUndefined()
    expect(env[CLAUDE_DEBUG_ENABLE_ENV]).toBeUndefined()
  })
})

describe('C3.215 — the reader finds the same file the child writes', () => {
  it('follows a per-workspace CLAUDE_CONFIG_DIR, which a hard-coded ~/.claude misses', () => {
    // The binary's own default is `join(configHomeDir(), "debug", "<id>.txt")`
    // and `configHomeDir()` follows `CLAUDE_CONFIG_DIR`, which this fork sets per
    // Workspace. A reader hard-coding the home path looks in the wrong place.
    const workspaceConfig = '/tmp/w16f-workspace-claude-config'
    expect(claudeDefaultDebugLogPath({ CLAUDE_CONFIG_DIR: workspaceConfig }, 'sess-x'))
      .toBe(join(workspaceConfig, 'debug', 'sess-x.txt'))
    expect(claudeDefaultDebugLogPath({}, 'sess-x'))
      .toBe(join(homedir(), '.claude', 'debug', 'sess-x.txt'))
  })

  it('prefers the path the host pointed the child at', () => {
    const hostPath = sessionRuntimeDebugLogPath('claude', 'sess-y')
    expect(claudeSessionDebugLogPath({ [CLAUDE_DEBUG_LOG_PATH_ENV]: hostPath }, 'sess-y'))
      .toBe(hostPath)
    // …and falls back to the vendor's own default when nothing pointed it.
    expect(claudeSessionDebugLogPath({}, 'sess-y'))
      .toBe(join(homedir(), '.claude', 'debug', 'sess-y.txt'))
  })
})

describe('C3.273 — the reader tries every file the writer can have used', () => {
  it('offers the host-owned file too, because the two halves are keyed by different ids', () => {
    // POSITIVE. The host names its file with the HOST session id
    // (`applySessionDiagnosticLog` reads `NESSY_SESSION_ID`); a reader inside the
    // backend holds the SDK's session id. A single path cannot name both, so the
    // candidate list carries both and the caller picks the one that exists.
    const candidates = claudeSessionDebugLogCandidates(
      { NESSY_SESSION_ID: 'host-sess-1', CLAUDE_CONFIG_DIR: '/tmp/w16l2-workspace-claude-config' },
      'sdk-sess-1',
    )
    expect(candidates).toEqual([
      join('/tmp/w16l2-workspace-claude-config', 'debug', 'sdk-sess-1.txt'),
      sessionRuntimeDebugLogPath('claude', 'host-sess-1'),
    ])
    // The old hard-coded path is in NEITHER, which is the defect this row closes.
    expect(candidates).not.toContain(join(homedir(), '.claude', 'debug', 'sdk-sess-1.txt'))
  })

  it('an operator override comes first, and a session with no host id yields one candidate', () => {
    // NEGATIVE/BOUNDARY. Order mirrors the writer's own precedence: the host path
    // is written only when the operator wrote none.
    const operatorPath = '/tmp/w16l2-an-operator-chose-this.txt'
    expect(
      claudeSessionDebugLogCandidates(
        { [CLAUDE_DEBUG_LOG_PATH_ENV]: operatorPath, NESSY_SESSION_ID: 'host-sess-2' },
        'sdk-sess-2',
      )[0],
    ).toBe(operatorPath)
    expect(claudeSessionDebugLogCandidates({}, 'sdk-sess-3'))
      .toEqual([join(homedir(), '.claude', 'debug', 'sdk-sess-3.txt')])
    // A blank host id is not an id: no second candidate, and no path ending in `-claude.txt`.
    expect(claudeSessionDebugLogCandidates({ NESSY_SESSION_ID: '   ' }, 'sdk-sess-4')).toHaveLength(1)
  })
})
