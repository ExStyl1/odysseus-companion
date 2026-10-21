/**
 * R85 · f141 — the hook env-file channel, end to end.
 *
 * hooks.md § SessionStart, "Persist environment variables": "SessionStart hooks
 * have access to the `CLAUDE_ENV_FILE` environment variable, which provides a
 * file path where you can persist environment variables for subsequent Bash
 * commands", and "Any variables written to this file will be available in all
 * subsequent Bash commands that Claude Code executes during the session."
 *
 * The claim is a CONSEQUENCE, not a string, so the decisive arms execute real
 * shells on both halves: a real hook process appends to the file through the env
 * the production builder minted, and the model's Bash command is then run
 * through the exact `args` the production host seam produced. If either half is
 * only carried and never consumed, the `expect` below sees an empty string.
 *
 * The env file lands under the real session storage directory (a test-only
 * workspace id, removed in `afterAll`) rather than behind a `NESSY_CONFIG_DIR`
 * override: `CONFIG_DIR` is a module-scope constant, so overriding it here would
 * change it for every other suite sharing the process — a documented trap in
 * this repo.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildHookCommandEnv,
  ensureHookEnvFile,
  hookEnvFileDirPath,
  hookEnvFilePath,
  resetHookEnvFile,
  resolveHookEnvFileForRead,
  resolveHookEnvFileShellStart,
  HOOK_ENV_FILE_CHILD_ENV_KEY,
  HOOK_ENV_FILE_EVENTS,
  HOOK_ENV_FILE_MAX_BYTES,
} from '../../automations/index.ts';
import { getSessionStoragePath } from '../../workspaces/paths.ts';
import { PiAgent } from '../pi-agent.ts';
import type { BackendConfig } from '../backend/types.ts';

const WORKSPACE_ID = 'ws-r85-hook-env-file'
const SESSION_ID = 'session-r85-hook-env-file'

const workspaceRoot = mkdtempSync(join(tmpdir(), 'nessy-r85-workspace-'));
const envFile = hookEnvFilePath(WORKSPACE_ID, SESSION_ID);
const envDirectory = hookEnvFileDirPath(WORKSPACE_ID, SESSION_ID);

/** No `FOO`, no marker: anything the arms observe came out of the env file. */
const cleanEnvironment = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? tmpdir(),
};

beforeEach(() => {
  resetHookEnvFile(WORKSPACE_ID, SESSION_ID);
});

afterAll(() => {
  rmSync(getSessionStoragePath(WORKSPACE_ID, SESSION_ID), { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

/** Run a real hook process against the env the production builder minted. */
function runHook(event: Parameters<typeof buildHookCommandEnv>[0], script: string): Record<string, string> {
  const env = buildHookCommandEnv(
    event,
    { hook_event_name: event },
    {},
    HOOK_ENV_FILE_EVENTS.has(event) ? ensureHookEnvFile(WORKSPACE_ID, SESSION_ID) : undefined,
  );
  execFileSync('/bin/sh', ['-c', script], { env, encoding: 'utf8' });
  return env;
}

/**
 * `globMatches` from `config/sandbox-settings.ts`, restated here rather than
 * imported: it is a private helper, and the assertion needs the EXACT semantics
 * the supervisor's exclusion check uses.
 */
function globMatches(pattern: string, value: string): boolean {
  const expression = pattern.replace(/[.*+?^${}()|[\]\\]/g, match => (
    match === '*' ? '.*' : match === '?' ? '.' : `\\${match}`
  ));
  return new RegExp(`^${expression}$`).test(value);
}

const supervisorResult = {
  handle: 'process_0123456789abcdef0123456789abcdef',
  output: '', nextCursor: 0, isRunning: false, exitCode: 0, signal: null,
  isolationProfile: 'workspace:test',
  environmentProfile: 'restricted' as const,
  environmentDigest: 'a'.repeat(64),
};

function piConfig(port: unknown): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: WORKSPACE_ID,
      name: 'R85',
      rootPath: workspaceRoot,
      workspaceRootPath: workspaceRoot,
      sessionRootPath: join(tmpdir(), 'nessy-r85-sessions'),
    } as any,
    session: {
      id: SESSION_ID,
      workspaceRootPath: workspaceRoot,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    processSupervisorPort: port,
  } as unknown as BackendConfig;
}

/**
 * Drive the REAL host seam (`handleProcessStartRequest`) and return the start
 * request the supervisor would have received.
 */
async function hostStart(request: Record<string, unknown>): Promise<any> {
  const starts: any[] = [];
  const port = {
    start: async (input: any) => { starts.push(input); return supervisorResult; },
    write: async () => {},
    read: async () => { throw new Error('unused'); },
    stop: async () => {},
    drainSession: async () => [],
  };
  const agent = new PiAgent(piConfig(port));
  (agent as any).subprocess = { stdin: { writable: true, write: () => {} } };
  try {
    await (agent as any).handleProcessStartRequest({
      requestId: 'r85',
      request: {
        executionId: 'execution-r85',
        cwd: workspaceRoot,
        profile: 'networked',
        background: false,
        timeoutMs: 1_000,
        ...request,
      },
    });
  } finally {
    (agent as any).subprocess = null;
    agent.destroy();
  }
  expect(starts).toHaveLength(1);
  return starts[0];
}

/**
 * Run a captured start the way `ProcessSupervisor` does: its `env` merged over
 * the host environment (`{ ...hostEnvironment(profile), ...request.env }`). The
 * base carries no `FOO` and no marker, so anything an arm observes came out of
 * the env file.
 */
function runCapturedStart(start: any): string {
  return execFileSync(start.command, start.args, {
    env: { ...cleanEnvironment, ...(start.env ?? {}) },
    encoding: 'utf8',
  });
}

/** The model's Bash command, exactly as the host would have run it. */
function runModelBash(command: string): Promise<string> {
  return hostStart({ semanticId: 'bash', command: '/bin/sh', args: ['-lc', command] })
    .then(runCapturedStart);
}

describe('a hook export reaches subsequent Bash commands', () => {
  it('carries `export FOO=bar` from a SessionStart hook into the model\'s next Bash command', async () => {
    // The documented recipe, guard and all.
    runHook('SessionStart', 'if [ -n "$CLAUDE_ENV_FILE" ]; then echo \'export FOO=bar\' >> "$CLAUDE_ENV_FILE"; fi');

    expect(await runModelBash('printf %s "$FOO"')).toBe('bar');
  });

  it('evaluates the file as SHELL, so the documented `export PATH="$PATH:…"` recipe works', async () => {
    runHook('SessionStart', 'echo \'export PATH="$PATH:/nessy-r85-marker"\' >> "$CLAUDE_ENV_FILE"');

    const path = await runModelBash('printf %s "$PATH"');
    // Both halves matter: the suffix proves the line ran, and the surviving
    // prefix proves `$PATH` EXPANDED — a key/value env merge would have set the
    // literal string `$PATH:/nessy-r85-marker` instead.
    expect(path.endsWith(':/nessy-r85-marker')).toBe(true);
    expect(path.slice(0, -'/nessy-r85-marker'.length - 1).length).toBeGreaterThan(0);
    expect(path).not.toContain('$PATH');
  });

  it('lets a second hook append without erasing the first', async () => {
    runHook('SessionStart', 'echo \'export FIRST=1\' >> "$CLAUDE_ENV_FILE"');
    runHook('CwdChanged', 'echo \'export SECOND=2\' >> "$CLAUDE_ENV_FILE"');

    expect(await runModelBash('printf %s "$FIRST$SECOND"')).toBe('12');
  });

  it('reaches a background shell too, and no other tool runtime', async () => {
    runHook('SessionStart', 'echo \'export FOO=bar\' >> "$CLAUDE_ENV_FILE"');

    const background = await hostStart({
      semanticId: 'bash_background', command: '/bin/sh', args: ['-lc', 'printf %s "$FOO"'],
    });
    expect(runCapturedStart(background)).toBe('bar');

    // hooks.md says "Bash commands". The read-only helper runtimes ride the same
    // supervised-process seam and are deliberately left byte-identical.
    const grep = await hostStart({ semanticId: 'grep', command: '/bin/sh', args: ['-lc', 'printf %s "$FOO"'] });
    expect(grep.args).toEqual(['-lc', 'printf %s "$FOO"']);
  });
});

describe('the variable is minted only where the page says', () => {
  it('emits both spellings on each in-scope event', () => {
    for (const event of ['SessionStart', 'CwdChanged', 'FileChanged'] as const) {
      const env = buildHookCommandEnv(event, { hook_event_name: event }, {}, envFile);
      expect(env.CLAUDE_ENV_FILE).toBe(envFile);
      expect(env.NESSY_ENV_FILE).toBe(envFile);
    }
  });

  it('emits neither on an out-of-scope event, even when handed a path', () => {
    const env = buildHookCommandEnv('PreToolUse', { hook_event_name: 'PreToolUse' }, {}, envFile);
    expect(env).not.toHaveProperty('CLAUDE_ENV_FILE');
    expect(env).not.toHaveProperty('NESSY_ENV_FILE');
  });

  it('never invents a path when the authority supplies none', () => {
    const env = buildHookCommandEnv('SessionStart', { hook_event_name: 'SessionStart' });
    expect(env).not.toHaveProperty('CLAUDE_ENV_FILE');
    expect(env).not.toHaveProperty('NESSY_ENV_FILE');
  });

  it('emits the path RAW — `sanitizeForShell` would corrupt it into a file that does not exist', () => {
    const awkward = '/tmp/nessy $home/hook-env/env.sh';
    const env = buildHookCommandEnv('SessionStart', { hook_event_name: 'SessionStart' }, {}, awkward);
    expect(env.CLAUDE_ENV_FILE).toBe(awkward);
  });

  it('lets a hook action reference it, and does not let one shadow it', () => {
    const env = buildHookCommandEnv(
      'SessionStart',
      { hook_event_name: 'SessionStart' },
      { MIRROR: '${CLAUDE_ENV_FILE}' },
      envFile,
    );
    expect(env.MIRROR).toBe(envFile);
  });

  it('is a REAL, writable, 0600 file the hook can append to', () => {
    const env = runHook('SessionStart', 'echo \'export FOO=bar\' >> "$CLAUDE_ENV_FILE"');
    expect(env.CLAUDE_ENV_FILE).toBe(envFile);
    expect(execFileSync('/bin/sh', ['-c', `cat '${envFile}'`], { encoding: 'utf8' })).toBe('export FOO=bar\n');
  });
});

describe('the file sits where the model cannot write it', () => {
  it('lives under the session storage directory, in its own subdirectory', () => {
    expect(dirname(envFile)).toBe(envDirectory);
    expect(dirname(envDirectory)).toBe(getSessionStoragePath(WORKSPACE_ID, SESSION_ID));
    // The grant handed to the hook spawn is the subdirectory, so `session.jsonl`
    // stays outside it.
    expect(envDirectory).not.toBe(getSessionStoragePath(WORKSPACE_ID, SESSION_ID));
  });

  it('refuses the read-back when the file falls inside a model-writable root', () => {
    ensureHookEnvFile(WORKSPACE_ID, SESSION_ID);
    appendFileSync(envFile, 'export FOO=bar\n');

    expect(resolveHookEnvFileForRead(WORKSPACE_ID, SESSION_ID)).toBe(envFile);
    expect(resolveHookEnvFileForRead(WORKSPACE_ID, SESSION_ID, {
      modelWritableRoots: [dirname(getSessionStoragePath(WORKSPACE_ID, SESSION_ID))],
    })).toBeUndefined();
  });
});

describe('the guards refuse what they claim to refuse', () => {
  it('refuses a SYMLINK rather than following it', async () => {
    const planted = join(workspaceRoot, 'planted.sh');
    writeFileSync(planted, 'export EVIL=owned\n');
    rmSync(envFile, { force: true });
    symlinkSync(planted, envFile);

    expect(resolveHookEnvFileForRead(WORKSPACE_ID, SESSION_ID)).toBeUndefined();
    const start = await hostStart({ semanticId: 'bash', command: '/bin/sh', args: ['-lc', 'printf %s "$EVIL"'] });
    expect(start.args).toEqual(['-lc', 'printf %s "$EVIL"']);
    expect(runCapturedStart(start)).toBe('');

    // Positive control on the same rig: a REGULAR file with the same bytes at
    // the same path IS sourced, so the refusal above is the symlink and not a
    // broken fixture.
    rmSync(envFile, { force: true });
    writeFileSync(envFile, 'export EVIL=owned\n', { mode: 0o600 });
    expect(await runModelBash('printf %s "$EVIL"')).toBe('owned');
  });

  it('refuses a file past the size cap', async () => {
    ensureHookEnvFile(WORKSPACE_ID, SESSION_ID);
    writeFileSync(envFile, `export FOO=bar\n#${'x'.repeat(HOOK_ENV_FILE_MAX_BYTES)}\n`);

    expect(resolveHookEnvFileForRead(WORKSPACE_ID, SESSION_ID)).toBeUndefined();
    expect(await runModelBash('printf %s "$FOO"')).toBe('');
  });

  it('refuses an empty file, so an untouched session pays nothing', async () => {
    expect(resolveHookEnvFileForRead(WORKSPACE_ID, SESSION_ID)).toBeUndefined();
    const start = await hostStart({ semanticId: 'bash', command: '/bin/sh', args: ['-lc', 'echo hi'] });
    expect(start.args).toEqual(['-lc', 'echo hi']);
  });

  it('leaves a non-shell start byte-identical, whatever its semanticId', async () => {
    ensureHookEnvFile(WORKSPACE_ID, SESSION_ID);
    appendFileSync(envFile, 'export FOO=bar\n');

    // A plugin-MCP / LSP style start: same seam, not a shell.
    const mcp = await hostStart({ semanticId: 'bash', command: '/usr/bin/node', args: ['server.js', '--stdio'] });
    expect(mcp.command).toBe('/usr/bin/node');
    expect(mcp.args).toEqual(['server.js', '--stdio']);
    // A start that is not rewritten must not learn the path either — an unused
    // variable in an MCP server's environment is disclosure for nothing.
    expect(mcp.env ?? {}).not.toHaveProperty(HOOK_ENV_FILE_CHILD_ENV_KEY);

    // The right command, the WRONG flag vector.
    const wrongFlags = await hostStart({ semanticId: 'bash', command: '/bin/sh', args: ['-c', 'echo hi'] });
    expect(wrongFlags.args).toEqual(['-c', 'echo hi']);

    // An out-of-scope semanticId on the exact shell shape.
    const plugin = await hostStart({ semanticId: 'plugin-hook', command: '/bin/sh', args: ['-lc', 'echo hi'] });
    expect(plugin.args).toEqual(['-lc', 'echo hi']);
  });

  it('keeps the PATH out of the rewritten line, so a user exclusion glob still matches', async () => {
    runHook('SessionStart', 'echo \'export FOO=bar\' >> "$CLAUDE_ENV_FILE"');
    const start = await hostStart({ semanticId: 'bash', command: '/bin/sh', args: ['-lc', 'docker ps'] });

    // `ProcessSupervisor.resolveIsolationDowngrade` matches
    // `sandbox.excludedCommands` against this joined line, and `globMatches`
    // compiles `*` to `.*`, which does not cross a newline. Both halves of the
    // fix are asserted here: no newline, and no session-specific path.
    const line = [start.command, ...start.args].join(' ');
    expect(line).not.toContain('\n');
    expect(line).not.toContain(envFile);
    expect(globMatches('*docker*', line)).toBe(true);
    // The path travels as a host-owned child env value instead.
    expect(start.env[HOOK_ENV_FILE_CHILD_ENV_KEY]).toBe(envFile);
    // And not under the hook's own spelling: the model is not being invited to
    // write there.
    expect(start.env).not.toHaveProperty('CLAUDE_ENV_FILE');
  });

  it('refuses an empty model command, whose exit status the preamble would otherwise own', () => {
    ensureHookEnvFile(WORKSPACE_ID, SESSION_ID);
    appendFileSync(envFile, 'export FOO=bar\n');

    expect(resolveHookEnvFileShellStart(
      { semanticId: 'bash', command: '/bin/sh', args: ['-lc', '   '] },
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID },
    )).toBeUndefined();
  });

  it('leaves the model command parseable, comment line and here-doc included', async () => {
    runHook('SessionStart', 'echo \'export FOO=bar\' >> "$CLAUDE_ENV_FILE"');

    // The `;` join puts the preamble ahead of the model's first line, so a
    // leading comment ends at the model's own newline rather than eating the
    // command, and a here-doc still opens on the line it was written on.
    expect(await runModelBash('# a comment the model wrote\nprintf %s "$FOO"')).toBe('bar');
    expect(await runModelBash('cat <<EOF\n$FOO\nEOF')).toBe('bar\n');
  });
});

describe('the file is reset once per runtime, not per event', () => {
  it('drops the previous run\'s exports so a resume does not accumulate them', () => {
    ensureHookEnvFile(WORKSPACE_ID, SESSION_ID);
    appendFileSync(envFile, 'export FOO=stale\n');

    resetHookEnvFile(WORKSPACE_ID, SESSION_ID);

    expect(resolveHookEnvFileForRead(WORKSPACE_ID, SESSION_ID)).toBeUndefined();
    expect(execFileSync('/bin/sh', ['-c', `cat '${envFile}'`], { encoding: 'utf8' })).toBe('');
  });

  it('replaces a planted symlink instead of truncating whatever it points at', () => {
    const victim = join(workspaceRoot, 'victim.txt');
    writeFileSync(victim, 'precious\n');
    rmSync(envFile, { force: true });
    mkdirSync(envDirectory, { recursive: true });
    symlinkSync(victim, envFile);

    resetHookEnvFile(WORKSPACE_ID, SESSION_ID);

    expect(execFileSync('/bin/sh', ['-c', `cat '${victim}'`], { encoding: 'utf8' })).toBe('precious\n');
  });
});
