/**
 * F1.609 (MEDIUM, a regression of F1.532) — the codex floor hook must not trust a state file the
 * sandboxed agent can write.
 *
 * Found by the 1.41.0 delta review (A-permissions-safety-1, CONFIRMED). F1.532 told F1.386's
 * `PermissionRequest` hook the session's mode through a state file in the runtime's `CODEX_HOME`,
 * and the hook gives no verdict when that file says `bypassPermissions`. But `CODEX_HOME` is a
 * `mkdtemp` under `$TMPDIR`, and the session's codex profile extends `:workspace`, which lets an
 * agent command write the cwd, `$TMPDIR` and `/tmp` with no card. Measured on the shipped
 * `codex-app-server` (`rust-v0.156.1`, `work/wjcrita/f1609-probe.ts`, host-shaped `default` config,
 * sandbox master switch off, every escalation refused): `printf <forged> > <CODEX_HOME>/nessy-
 * automation-floor-state.json` exits 0 and the file changes, while an overwrite, a new file, an
 * unlink and a rename of the parent in a host directory outside those roots each fail with
 * "Operation not permitted" (a read still works).
 *
 * So the host now names the state file in a per-build directory under its OWN config directory, and
 * only when no root the session's codex profile lets an agent command write covers that directory;
 * otherwise it names none, the hook keeps the floor in every mode (F1.386's posture) and the session
 * says so. These arms run the host's exact hook command line through a shell, as codex does, against
 * the real `session-mcp-server` entry.
 *
 * F1.704 — the host now also names it where F1.664's config-dir projection keeps agent commands out
 * of the config dir (F1.680's shield). The isolate preload's `CONFIG_DIR` is under `$TMPDIR`, so the
 * FAILING arms' default state root is such a place: the projection denies the config dir outright and
 * the build writes that deny into the profile. {@link agentCanWrite} models it; measured on the
 * shipped binary (`work/dn018/f1704-probe.ts` arm T, every approval accepted), the agent's overwrite,
 * new file, unlink and renames there all leave the state file intact while a cwd write works.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import * as codexAgentModule from '../codex-agent.ts';
import { codexAutomationFloorHookCommand } from '../backend/codex/automation-floor-hook.ts';

const { CodexAgent } = codexAgentModule;
const NODE = process.execPath;
const SERVER = resolve(import.meta.dir, '../../../../session-mcp-server/src/index.ts');
const RIG = mkdtempSync(join(tmpdir(), 'wjcrita-f1609-'));
const WS = join(RIG, 'ws');
mkdirSync(WS, { recursive: true });
writeFileSync(join(WS, 'automations.json'), JSON.stringify({
  version: 2,
  automations: {
    SchedulerTick: [
      { id: 'dormant-bypass', name: 'Weekly purge', cron: '0 5 * * 0', permissionMode: 'bypassPermissions', enabled: false, actions: [{ type: 'prompt', prompt: 'old' }] },
    ],
  },
}));
afterAll(() => { rmSync(RIG, { recursive: true, force: true }); });

/** codex's `PermissionRequestRequest`: a change that re-enables an unattended bypass automation. */
const REENABLE = {
  session_id: 's', turn_id: 't', cwd: WS, model: 'm', permission_mode: 'default',
  hook_event_name: 'PermissionRequest', tool_name: 'mcp__session__automation_update',
  tool_input: { automationId: 'dormant-bypass', patch: { enabled: true } },
};

/** The review's trigger, byte for byte. */
const FORGED = JSON.stringify({ v: 1, permissionMode: 'bypassPermissions', reviewerRequiredByPolicy: false });

/** Budget per case that runs the hook's real entry: ~1.1 s warm on this rig (2026-09-25), far more cold. */
const HOOK_CASE_BUDGET_MS = 120_000;

let homes = 0;
/** The product's `$TMPDIR` CODEX_HOME shape (F1.652's fallback), a `nessy-codex-home-` mkdtemp (the rig is under `$TMPDIR`). */
function codexHome(): string {
  return mkdtempSync(join(RIG, `nessy-codex-home-${homes++}-`));
}

function agentAt(): InstanceType<typeof CodexAgent> {
  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: { id: 'ws-f1609', name: 'F1.609', rootPath: WS, workspaceRootPath: WS, sessionRootPath: `${WS}/sessions` } as any,
    session: { id: `session-f1609-${homes}`, workspaceRootPath: WS, createdAt: Date.now(), lastUsedAt: Date.now() } as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer: SERVER, node: NODE } },
  } as never);
  agent.onDebug = () => {};
  (agent as any).debug = () => {};
  (agent as any).configuredApprovalsReviewer = 'auto_review';
  (agent as any).autoReviewSettingOn = () => true; // F1.781 — the toggle that wrote the reviewer, still on
  return agent;
}

type Projection = { hooks?: { PermissionRequest?: Array<{ hooks: Array<{ command: string }> }> } };
const commandOf = (projected: Projection) => projected.hooks?.PermissionRequest?.[0]?.hooks[0]?.command;

/** The `--state-file` path the projected command line names, or undefined. */
function stateFileOf(command: string | undefined): string | undefined {
  const flag = "'--state-file' '";
  const at = command?.indexOf(flag) ?? -1;
  if (!command || at < 0) return undefined;
  return command.slice(at + flag.length, command.indexOf("'", at + flag.length));
}

const realOr = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
/** Is `path` at or below one of `roots`, compared by real path? */
function insideAny(path: string, roots: readonly string[]): boolean {
  const real = realOr(path);
  return roots.some(root => {
    const base = realOr(root);
    return real === base || real.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
  });
}
/** What the session's codex profile lets an agent command write with no card: the cwd, `$TMPDIR`, `/tmp`. */
const AGENT_WRITABLE = [WS, tmpdir(), '/tmp'];

/**
 * F1.704 — `path` is inside a root the agent can write (or `home`), and not under a path the agent's
 * config-dir projection denies outright — unless a writable root lies inside that denied path (the more
 * specific entry wins, F1.664 E1). See the header.
 */
function agentCanWrite(agent: InstanceType<typeof CodexAgent>, path: string, home: string): boolean {
  const roots = [...AGENT_WRITABLE, home];
  if (!insideAny(path, roots)) return false;
  const deny: string[] = (agent as any).configDirProjection().deny;
  return !deny.some(denied => insideAny(path, [denied]) && !roots.some(root => insideAny(root, [denied])));
}

/** Run the host's command line the way codex does (`$SHELL -lc`, here `/bin/sh -c`), payload on stdin. */
function runHookCommand(command: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: WS, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', fail);
    child.on('close', code => done({ code, stderr }));
    child.stdin.end(JSON.stringify(REENABLE));
  });
}

describe('F1.609 · a state file the agent can forge does not turn the floor off', () => {
  it('FAILING ARM — the review\'s trigger: a forged bypass file wherever the agent can write it, and the hook still refuses', async () => {
    const agent = agentAt();
    try {
      agent.setPermissionMode('auto'); // F1.1169: a mode the reviewer answers, where the hook holds the floor
      const home = codexHome();
      const command = commandOf((agent as any).hostAuthoredHookProjection(home));
      expect(command).toBeDefined();
      // The agent side: into CODEX_HOME (the review's command), and into the file the host named
      // whenever the session's sandbox would let an agent command write it.
      writeFileSync(join(home, 'nessy-automation-floor-state.json'), FORGED);
      expect(agentCanWrite(agent, join(home, 'nessy-automation-floor-state.json'), home)).toBe(true); // non-vacuity
      const named = stateFileOf(command);
      const forgeable = named !== undefined && agentCanWrite(agent, named, home);
      if (forgeable) writeFileSync(named!, FORGED);
      const { code, stderr } = await runHookCommand(command!);
      expect({ forgeable, code }).toEqual({ forgeable: false, code: 2 });
      expect(stderr).toContain('refused rather than reviewed');
    } finally { agent.destroy(); }
  }, HOOK_CASE_BUDGET_MS);

  it('FAILING ARM — the host never names a state file inside a root the session\'s codex profile lets the agent write (no seam)', () => {
    const agent = agentAt();
    try {
      agent.setPermissionMode('default');
      const home = codexHome();
      const named = stateFileOf(commandOf((agent as any).hostAuthoredHookProjection(home)));
      expect({ named, agentWritable: named !== undefined && agentCanWrite(agent, named, home) })
        .toEqual({ named, agentWritable: false });
    } finally { agent.destroy(); }
  });

  it('with its state directory inside an agent-writable root the host names NO state file, the hook keeps the floor in every mode, and the session says so', () => {
    const agent = agentAt();
    try {
      (agent as any).floorHookStateRoot = join(RIG, 'config-under-tmpdir', 'codex-floor-hook-state');
      agent.setPermissionMode('bypassPermissions');
      const command = commandOf((agent as any).hostAuthoredHookProjection(codexHome()));
      expect(command).toBe(codexAutomationFloorHookCommand(NODE, SERVER, WS));
      const fact = String((agent as any).sessionFacts.get('codex-floor-hook-state') ?? '');
      expect(fact).toContain('not told this session\'s permission mode');
      expect(fact).toContain('bypassPermissions included');
    } finally { agent.destroy(); }
  });
});

describe('F1.609 · CONTROL — where the host CAN place the file, the mode still reaches the hook', () => {
  it('a genuine bypassPermissions session gets no verdict; back in auto the edit is refused', async () => {
    const agent = agentAt();
    const stateRoot = join(RIG, 'host-config', 'codex-floor-hook-state');
    try {
      // The rig's stand-in for a config directory outside the cwd, $TMPDIR and /tmp: the roots are
      // declared as the cwd alone, so the rig directory (under $TMPDIR) plays "outside".
      (agent as any).floorHookStateRoot = stateRoot;
      (agent as any).codexAgentWritableRoots = () => [WS];
      agent.setPermissionMode('auto'); // F1.1169: a mode the reviewer answers, where the hook holds the floor
      const home = codexHome();
      const command = commandOf((agent as any).hostAuthoredHookProjection(home))!;
      agent.setPermissionMode('bypassPermissions');
      expect(await runHookCommand(command)).toEqual({ code: 0, stderr: '' });
      agent.setPermissionMode('auto');
      const refused = await runHookCommand(command);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('refused rather than reviewed');
    } finally { agent.destroy(); }
  }, HOOK_CASE_BUDGET_MS * 2);

  it('teardown removes the build\'s state directory, and the next build names a fresh one', async () => {
    const agent = agentAt();
    try {
      (agent as any).floorHookStateRoot = join(RIG, 'host-config-2', 'codex-floor-hook-state');
      (agent as any).codexAgentWritableRoots = () => [WS];
      agent.setPermissionMode('default');
      const first = stateFileOf(commandOf((agent as any).hostAuthoredHookProjection(codexHome())));
      await (agent as any).teardownRuntime();
      const second = stateFileOf(commandOf((agent as any).hostAuthoredHookProjection(codexHome())));
      expect({
        firstNamed: first !== undefined, firstGone: first !== undefined && !existsSync(first),
        secondFresh: second !== undefined && second !== first && existsSync(second),
      }).toEqual({ firstNamed: true, firstGone: true, secondFresh: true });
    } finally { agent.destroy(); }
  });
});

describe('F1.609 · resolveCodexFloorHookStateDirectory', () => {
  const resolveDir = (codexAgentModule as Record<string, unknown>).resolveCodexFloorHookStateDirectory as
    (candidate: string, agentWritableRoots: readonly string[]) => { dir: string } | { withheld: string };
  const base = mkdtempSync(join(RIG, 'resolver-'));
  const ws = join(base, 'ws');
  mkdirSync(ws, { recursive: true });

  it('a directory outside every root is created 0700 and returned by its real path', () => {
    const result = resolveDir(join(base, 'cfg', 'state'), [ws, join(base, 'tmp')]);
    expect(result).toEqual({ dir: realpathSync(join(base, 'cfg', 'state')) });
    expect(statSync(join(base, 'cfg', 'state')).mode & 0o777).toBe(0o700);
  });

  it('BOUNDARY — at a root, below a root, or reached through a symlink into a root: withheld, naming the root', () => {
    symlinkSync(ws, join(base, 'link'));
    for (const candidate of [ws, join(ws, 'deep', 'state'), join(base, 'link', 'state')]) {
      const result = resolveDir(candidate, [join(base, 'elsewhere'), ws]);
      expect('withheld' in result && result.withheld).toContain(ws);
    }
  });

  it('BOUNDARY — a sibling that merely shares a prefix is not inside; a directory that cannot be made is withheld', () => {
    expect(resolveDir(`${ws}2${sep}state`, [ws])).toEqual({ dir: realpathSync(`${ws}2${sep}state`) });
    writeFileSync(join(base, 'a-file'), 'x');
    const blocked = resolveDir(join(base, 'a-file', 'state'), [ws]);
    expect('withheld' in blocked && blocked.withheld).toContain('could not be created');
    expect(readFileSync(join(base, 'a-file'), 'utf-8')).toBe('x');
  });
});
