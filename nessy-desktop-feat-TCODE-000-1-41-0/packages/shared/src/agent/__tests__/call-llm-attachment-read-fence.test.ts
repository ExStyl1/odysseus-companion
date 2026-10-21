/**
 * F1.708 (origin WJ-crit-q P-WJcritq-1, 2026-09-25) — a `call_llm` attachment is a READ the host
 * performs (`processAttachment`, `llm-tool.ts`), so the gate judges each attachment as a `Read` of
 * that path for the two P6.202 checks that depend on the session's working directories:
 *
 * - the operator's read fence, `permissions.blockReadsOutsideWorkingDirectories`, which refuses a
 *   read outside the working and added directories in every mode (bypassPermissions included);
 * - auto mode's FIRST read outside them, which asks (`permission-modes.md#first-read-outside-the-working-directories`).
 *
 * Before this row both passed `call_llm` straight through (`call_llm_intercept`): F1.694 and F1.1116
 * gave the reader the `deniedPaths` floor and the readable deny rules, which need no directories,
 * and the reader is not handed the session's directories. An attachment is resolved as the reader
 * opens it — a relative path against the session directory (`dirname(dataFolderPath)`), which lives
 * under the config dir and is therefore inside the page's own carve-out. Driven through the real
 * gate on both spellings (claude's `mcp__session__call_llm`, Pi's bare `call_llm`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR } from '../../config/paths.ts';
import { runPreToolUseChecks, type PermissionManagerLike, type PreToolUseInput } from '../core/pre-tool-use.ts';
import { cleanupModeState, initializeModeState, type PermissionMode } from '../mode-manager.ts';

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const KEY = { workspaceId: 'ws-f1708', sessionId: 'session-f1708' };
const SESSION_DIR = join(CONFIG_DIR, 'workspaces', 'ws-f1708', 'sessions', 'session-f1708');

let sandbox = '';
let cwd = '';
let outside = '';
let previousConfig: string | null = null;

const permissionManager: PermissionManagerLike = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: () => false,
  getBaseCommand: command => command.split(/\s+/)[0] || command,
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
};

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1708-')));
  cwd = join(sandbox, 'project');
  outside = join(sandbox, 'elsewhere');
  for (const dir of [cwd, outside]) mkdirSync(dir, { recursive: true });
  previousConfig = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, 'utf-8') : null;
});

afterAll(() => {
  if (previousConfig === null) rmSync(CONFIG_FILE, { force: true });
  else writeFileSync(CONFIG_FILE, previousConfig, 'utf-8');
  cleanupModeState(KEY);
  rmSync(sandbox, { recursive: true, force: true });
});

function setFence(on: boolean): void {
  const base = previousConfig
    ? JSON.parse(previousConfig)
    : { storageLayoutVersion: 2, workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null };
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...base, additionalDirectories: [], blockReadsOutsideWorkingDirectories: on }), 'utf-8');
}

function check(mode: PermissionMode, attachments: unknown[], toolName = 'mcp__session__call_llm') {
  cleanupModeState(KEY);
  initializeModeState(KEY, mode);
  const ctx: PreToolUseInput = {
    toolName,
    input: { prompt: 'summarise', attachments },
    sessionId: KEY.sessionId,
    sessionKey: KEY,
    permissionMode: mode,
    workspaceRootPath: join(CONFIG_DIR, 'workspaces', 'ws-f1708'),
    workspaceId: KEY.workspaceId,
    workingDirectory: cwd,
    dataFolderPath: join(SESSION_DIR, 'data'),
    interactive: true,
    activeSourceSlugs: [],
    allSourceSlugs: [],
    hasSourceActivation: false,
    permissionManager,
  };
  return runPreToolUseChecks(ctx);
}

describe('F1.708 — the operator read fence judges each call_llm attachment as a Read', () => {
  it('fence on: an attachment outside the working directories is refused, in default and in bypassPermissions', () => {
    setFence(true);
    for (const mode of ['default', 'bypassPermissions'] as const) {
      const result = check(mode, [join(cwd, 'notes.md'), { path: join(outside, 'secret.md'), startLine: 1 }]);
      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('permissions.blockReadsOutsideWorkingDirectories');
        expect(result.reason).toContain(join(outside, 'secret.md'));
      }
    }
  });

  it('fence on: a RELATIVE attachment that climbs out of the session directory is refused (resolved as the reader opens it)', () => {
    setFence(true);
    const climbing = `${'../'.repeat(SESSION_DIR.split('/').length)}${outside.slice(1)}/secret.md`;
    const result = check('default', [climbing], 'call_llm');
    expect(result.type).toBe('block');
  });

  it('CONTROL — fence on: attachments in the working directory, or relative inside the session directory, still pass', () => {
    setFence(true);
    expect(check('default', [join(cwd, 'notes.md'), 'data/out.json']).type).toBe('call_llm_intercept');
  });

  it('CONTROL — fence off, default mode: an attachment outside still passes (a read outside is ordinary there)', () => {
    setFence(false);
    expect(check('default', [join(outside, 'secret.md')]).type).toBe('call_llm_intercept');
  });
});

describe('F1.708 — auto mode asks about the FIRST call_llm attachment outside the working directories', () => {
  it('an outside attachment raises the outside_root card naming it, on both spellings', () => {
    setFence(false);
    for (const toolName of ['mcp__session__call_llm', 'call_llm']) {
      const result = check('auto', [join(cwd, 'notes.md'), join(outside, 'secret.md')], toolName);
      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('outside_root');
        expect(result.outsideWorkingDirectoryRead?.path).toBe(join(outside, 'secret.md'));
      }
    }
  });

  it('CONTROL — auto mode: attachments inside the working directory raise no card', () => {
    setFence(false);
    expect(check('auto', [join(cwd, 'notes.md')]).type).toBe('call_llm_intercept');
  });
});
