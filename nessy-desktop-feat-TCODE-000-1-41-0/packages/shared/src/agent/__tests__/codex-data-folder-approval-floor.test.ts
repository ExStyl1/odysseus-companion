/**
 * F1.693 (WJ-crit-p, 2026-09-25) — Nessy's DATA FOLDER is a floor on codex's approval
 * bridge in every mode, `bypassPermissions` included.
 *
 * ## What was measured first (the shipped `codex-app-server` rust-v0.156.1, darwin-arm64)
 *
 * `work/wjcritp/f1693-probe.ts`: the product's own config writer in `bypassPermissions`
 * (sandbox master switch off, the credential deny, so the `nessy_runtime` profile is
 * emitted as on every real session), `CODEX_HOME` under `<config>/codex-home` through the
 * product's resolver, a stub Responses upstream, every approval answered with the host's
 * own bypass answer `buildApprovalResponse(kind, params, true)`:
 *
 * - an `apply_patch` (escalated or not) adding `<config>/mcp.json`, the relocated home's
 *   `rules/agent.rules` and another workspace's `hooks.json` raised
 *   `item/fileChange/requestApproval`, was accepted, and **all three files were written**
 *   — codex applies an approved patch itself, outside the profile. That is F1.693: the
 *   relocation F1.652 made, the config dir F1.664 protects and the records F1.659 denies
 *   are all one `accept` away in bypass.
 * - a `require_escalated` shell write to the same three targets was accepted too and was
 *   **refused by the OS** (`operation not permitted`), switch off AND on, the control
 *   outside the data folder included; the positive control (no profile) wrote all four.
 *   So the escalated-command half did not land on a real session then — codex's own
 *   profile held it (native-first) — and the command arm was pinned as a stated residue.
 *   F1.717 (DN-263, 2026-09-28) closes it: since F1.1057 a default session's profile
 *   denies no read, so codex runs an APPROVED escalation outside its sandbox, and the
 *   bypass yes alone stood between a shell command and these records. The command arm
 *   is now judged here with the records guard's own resolver (see the F1.717 block).
 *
 * ## The floor (DECIDED, transparent and simple)
 *
 * A codex fileChange approval (v2 and v1) whose file is under the real `CONFIG_DIR` in
 * one of the control places — `codex-home/`, `permissions/`, the global `hooks.json` /
 * `mcp.json` / `config.json` / `credentials.enc`, or any workspace's four records — and a
 * `permissions` write grant over one of them, is refused in every mode with a named
 * reason. Skills, plans and every other data-folder path stay ordinary work (the control).
 * And an ADDED directory inside the config dir is no longer granted to codex (it would
 * hand agent commands write access over other workspaces' records with no approval).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import type { PermissionMode } from '../mode-types.ts';
import { CONFIG_DIR, STORAGE_LAYOUT_VERSION } from '../../config/paths.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';

const WORKSPACE_ROOT = join(CONFIG_DIR, 'workspaces', 'ws-f1693');
const PROJECT_CWD = '/tmp/nessy-f1693-project';
const PATCH_METHOD = 'item/fileChange/requestApproval';
const PATCH_METHOD_V1 = 'applyPatchApproval';
const EXEC_METHOD = 'item/commandExecution/requestApproval';
const PERMISSIONS_METHOD = 'item/permissions/requestApproval';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-f1693',
      name: 'F1.693 Workspace',
      rootPath: WORKSPACE_ROOT,
      workspaceRootPath: WORKSPACE_ROOT,
      sessionRootPath: join(WORKSPACE_ROOT, 'sessions'),
    } as any,
    session: {
      id: 'session-f1693',
      workspaceRootPath: WORKSPACE_ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: PROJECT_CWD,
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

function agentIn(mode: PermissionMode) {
  const agent = new CodexAgent(createConfig());
  const debug: string[] = [];
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onDebug = (message) => { debug.push(message); };
  agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.getPermissionManager().setCapabilityPermissionLayers([], 'generation-f1693', true);
  agent.setPermissionMode(mode);
  return { agent, debug, surfaced };
}

const ask = (agent: CodexAgent, method: string, params: unknown) =>
  (agent as any).handleServerRequest(method, params) as Promise<Record<string, unknown>> | Record<string, unknown>;

/**
 * F1.59 CI (MR !49 row 4) — the patched file counts as READ, so the read-before-write floor
 * (`readBeforeWriteVerdict`, which answers ABOVE this one for a file that exists and was never
 * read) cannot answer first. CI runs a directory's files in one bun process over one
 * isolate-preload config dir, so `<config>/config.json` can already exist when this file runs
 * (any sibling that saves the config leaves it); then the decline is read-before-write's and this
 * floor's line is absent — the CI red, reproduced here by seeding that one file. With the file
 * seen, the floor under test is the one that must answer, whatever is on disk.
 */
const seen = (agent: CodexAgent, path: string): void => { (agent as any).readBeforeWriteLedger.add(path); };

let seq = 0;
/** A v2 patch approval for `path`, announced on `item/started` first, as codex does. */
function patchApproval(agent: CodexAgent, path: string): Promise<Record<string, unknown>> | Record<string, unknown> {
  seen(agent, path);
  const itemId = `call-f1693-${++seq}`;
  (agent as any).rememberCodexFileChangePaths({
    type: 'fileChange', id: itemId, status: 'inProgress', changes: [{ path, kind: 'add', diff: '+x' }],
  });
  return ask(agent, PATCH_METHOD, { itemId, threadId: 'thread-f1693', turnId: 'turn-f1693', startedAtMs: 0 });
}

function writeGrant(write: string[]) {
  return {
    itemId: `perm-f1693-${++seq}`, threadId: 'thread-f1693', turnId: 'turn-f1693', startedAtMs: 0,
    environmentId: null, cwd: PROJECT_CWD, reason: null,
    permissions: { network: null, fileSystem: { read: null, write } },
  };
}

const floorLine = (debug: string[]) => debug.some(line => line.includes('data-folder floor (F1.693)'));

beforeEach(() => { permissionsConfigCache.clear(); });

describe('F1.693 — a codex patch into the data folder is refused in bypassPermissions (the measured landing)', () => {
  const targets: Array<[string, string]> = [
    ['the relocated home\'s rules/', join(CONFIG_DIR, 'codex-home', 'nessy-codex-home-AbCd12', 'rules', 'agent.rules')],
    ['the global mcp.json', join(CONFIG_DIR, 'mcp.json')],
    ['the global hooks.json', join(CONFIG_DIR, 'hooks.json')],
    ['the global config.json', join(CONFIG_DIR, 'config.json')],
    ['a permissions/ file', join(CONFIG_DIR, 'permissions', 'default.json')],
    ['ANOTHER workspace\'s hooks.json', join(CONFIG_DIR, 'workspaces', 'other-ws', 'hooks.json')],
    ['another workspace\'s permissions.json, cased differently', join(CONFIG_DIR, 'workspaces', 'other-ws', 'Permissions.json')],
    ['the session\'s own automations.json', join(WORKSPACE_ROOT, 'automations.json')],
    ['the sealed host-approvals key (UA12.23)', join(CONFIG_DIR, 'host-approvals-key.sealed')],
  ];
  for (const [label, target] of targets) {
    it(`refuses ${label}, with no card and a named reason`, async () => {
      const { agent, debug, surfaced } = agentIn('bypassPermissions');
      const answer = await patchApproval(agent, target);
      expect(answer).toEqual({ decision: 'decline' });
      expect(surfaced).toHaveLength(0);
      expect(floorLine(debug)).toBe(true);
    });
  }

  it('refuses the v1 patch family too', async () => {
    const { agent, debug } = agentIn('bypassPermissions');
    seen(agent, join(CONFIG_DIR, 'mcp.json'));
    const answer = await ask(agent, PATCH_METHOD_V1, { fileChanges: { [join(CONFIG_DIR, 'mcp.json')]: { add: { content: '{}' } } } });
    expect(answer.decision).not.toBe('approved');
    expect(floorLine(debug)).toBe(true);
  });
});

describe('F1.693 — in EVERY mode, not only bypass', () => {
  for (const mode of ['default', 'acceptEdits', 'auto'] as const) {
    it(`${mode}: refuses a patch of the global hooks.json without asking`, () => {
      const { agent, debug, surfaced } = agentIn(mode);
      // Not awaited: a card is a promise nobody answers here, and the refusal is synchronous.
      const answer = patchApproval(agent, join(CONFIG_DIR, 'hooks.json'));
      expect(surfaced).toHaveLength(0);
      expect(answer).toEqual({ decision: 'decline' });
      expect(floorLine(debug)).toBe(true);
    });
  }
});

describe('F1.693 — a permissions write grant over the data folder grants nothing', () => {
  for (const write of [[CONFIG_DIR], [join(CONFIG_DIR, 'workspaces')], [join(CONFIG_DIR, 'codex-home')]]) {
    it(`refuses write ${write[0]!.replace(CONFIG_DIR, '<config>')}`, async () => {
      const { agent, debug } = agentIn('bypassPermissions');
      const answer = await ask(agent, PERMISSIONS_METHOD, writeGrant(write));
      expect(answer).toEqual({ permissions: {}, scope: 'turn' });
      expect(floorLine(debug)).toBe(true);
    });
  }
});

describe('F1.693 — CONTROLS: bypass keeps its promise outside the control places', () => {
  it('a skill write in the data folder is still auto-approved', async () => {
    const { agent, debug, surfaced } = agentIn('bypassPermissions');
    const answer = await patchApproval(agent, join(CONFIG_DIR, 'skills', 'my-skill', 'SKILL.md'));
    expect(answer).toEqual({ decision: 'accept' });
    expect(surfaced).toHaveLength(0);
    expect(floorLine(debug)).toBe(false);
  });

  it('a patch outside the data folder is still auto-approved', async () => {
    const { agent, debug } = agentIn('bypassPermissions');
    expect(await patchApproval(agent, '/tmp/nessy-f1693-elsewhere/notes.txt')).toEqual({ decision: 'accept' });
    expect(floorLine(debug)).toBe(false);
  });

  it('a permissions write grant outside the data folder is still echoed', async () => {
    const { agent } = agentIn('bypassPermissions');
    const answer = await ask(agent, PERMISSIONS_METHOD, writeGrant(['/tmp/nessy-f1693-elsewhere']));
    expect(answer).toEqual({ permissions: { fileSystem: { read: null, write: ['/tmp/nessy-f1693-elsewhere'] } }, scope: 'turn' });
  });

  it('default still cards a patch outside the data folder', () => {
    const { agent, surfaced } = agentIn('default');
    void patchApproval(agent, '/tmp/nessy-f1693-elsewhere/notes.txt');
    expect(surfaced).toHaveLength(1);
  });
});

/**
 * F1.717 (DN-263, 2026-09-28) — the command arm. The F1.693 case that pinned it as a residue
 * (an escalated `printf x > <config>/hooks.json` answered `accept` in bypass) is the first case
 * here, flipped. Resolution is the records guard's (`core/pre-tool-use.ts`): every `cd` target,
 * the quote-blanked and quote-joined copies, and the names a copy writes into a folder.
 */
describe('F1.717 — a codex SHELL command aimed at the data folder is refused in every mode', () => {
  const exec = (agent: CodexAgent, command: string, cwd = PROJECT_CWD) => ask(agent, EXEC_METHOD, { command, cwd });
  const shellLine = (debug: string[]) => debug.some(line => line.includes('data-folder floor (F1.693)') && line.includes('F1.717'));
  const refused: Array<[string, string]> = [
    ['an escalated write of the global hooks.json (the flipped F1.693 residue)', `/bin/zsh -lc "printf x > '${join(CONFIG_DIR, 'hooks.json')}'"`],
    ['a cd into the data folder, then a bare record name', `/bin/zsh -lc 'cd ${CONFIG_DIR} && printf {} > mcp.json'`],
    ['a codex home\'s rules/ file', `/bin/zsh -lc "echo 'prefix_rule(pattern=[\\"rm\\"], decision=\\"allow\\")' >> ${join(CONFIG_DIR, 'codex-home', 'h1', 'rules', 'agent.rules')}"`],
    ['a copy INTO the data folder under the source\'s name', `/bin/zsh -lc 'cp /tmp/nessy-f1717/hooks.json ${CONFIG_DIR}/'`],
    ['another workspace\'s permissions.json, cased differently', `/bin/zsh -lc 'printf {} > ${join(CONFIG_DIR, 'workspaces', 'other-ws', 'PERMISSIONS.json')}'`],
    ['a delete of the sealed host-approvals key (UA12.23)', `/bin/zsh -lc 'rm -f ${join(CONFIG_DIR, 'host-approvals-key.sealed')}'`],
  ];
  for (const [label, command] of refused) {
    it(`bypassPermissions: refuses ${label}, with no card and a named reason`, () => {
      const { agent, debug, surfaced } = agentIn('bypassPermissions');
      expect(exec(agent, command)).toEqual({ decision: 'decline' });
      expect(surfaced).toHaveLength(0);
      expect(shellLine(debug)).toBe(true);
    });
  }

  it('default: refuses it without asking', () => {
    const { agent, debug, surfaced } = agentIn('default');
    expect(exec(agent, `/bin/zsh -lc "printf x > '${join(CONFIG_DIR, 'config.json')}'"`)).toEqual({ decision: 'decline' });
    expect(surfaced).toHaveLength(0);
    expect(shellLine(debug)).toBe(true);
  });

  it('refuses the v1 execCommandApproval argv too', () => {
    const { agent, debug } = agentIn('bypassPermissions');
    const answer = ask(agent, 'execCommandApproval', {
      conversationId: 'thread-f1693', callId: 'exec-f1717', command: ['bash', '-lc', `cd ${CONFIG_DIR}/permissions && printf x > default.json`], cwd: PROJECT_CWD,
    }) as Record<string, unknown>;
    expect(answer.decision).not.toBe('approved');
    expect(shellLine(debug)).toBe(true);
  });

  it('refuses a record reached through a symlink to the data folder, by real path', () => {
    const link = `/tmp/nessy-f1717-link-${process.pid}`;
    mkdirSync(CONFIG_DIR, { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(CONFIG_DIR, link);
    try {
      const { agent, debug } = agentIn('bypassPermissions');
      expect(exec(agent, `/bin/zsh -lc 'printf {} > ${link}/mcp.json'`)).toEqual({ decision: 'decline' });
      expect(shellLine(debug)).toBe(true);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('CONTROL — an escalated write outside the data folder is still auto-approved in bypass', () => {
    const { agent, debug } = agentIn('bypassPermissions');
    expect(exec(agent, '/bin/zsh -lc "printf x > /tmp/nessy-f1717-elsewhere/hooks.json"')).toEqual({ decision: 'accept' });
    expect(floorLine(debug)).toBe(false);
  });

  it('CONTROL — a command on a skill in the data folder is still auto-approved in bypass', () => {
    const { agent, debug } = agentIn('bypassPermissions');
    expect(exec(agent, `/bin/zsh -lc "printf x > '${join(CONFIG_DIR, 'skills', 'my-skill', 'SKILL.md')}'"`)).toEqual({ decision: 'accept' });
    expect(floorLine(debug)).toBe(false);
  });
});

/**
 * F1.1160 (origin DN-263's proposed row, 2026-09-28) — the FOLDER half of the command arm. DN-263's
 * record arm reads files one by one; a `rm -rf` of the data folder or of a whole workspace folder
 * names no record and passed. Pi and claude refuse the folder cases since F1.722/F1.922
 * (`shellMovedRecordFolder` / `shellCopyFolderWrite`), with the session's OWN workspace carved out;
 * codex's floor carves nothing out (its record arm already guards the own workspace's five records,
 * `codexDataFolderControlTarget`), so the helpers run here with an EMPTY carve-out.
 *
 * Native-first, MEASURED first on the shipped `codex-app-server` 0.159.3 (sha = the manifest pin;
 * the lane's probe, workspace-write / on-request — the product's config): `rm -rf <workspace>/sub`
 * EXECUTED (no refusal, one approval ask that ran once accepted) and so did
 * `mv <workspace>/sub2 <tmpdir>`; a copy into a workspace folder is inside the granted writable
 * root by design; codex's execpolicy rules match command prefixes, with no path scope, and an
 * approved escalation runs outside the sandbox (the F1.693 probe). So the host floor is the only
 * place this can be judged — the same conclusion DN-263 reached for the records.
 */
describe('F1.1160 — a whole-folder move, removal or unspelled copy through the codex floor', () => {
  const exec = (agent: CodexAgent, command: string, cwd = PROJECT_CWD) => ask(agent, EXEC_METHOD, { command, cwd });
  const folderLine = (debug: string[]) => debug.some(line => line.includes('data-folder floor (F1.693)') && line.includes('F1.1160'));
  // A spelled-file copy control needs its source to EXIST: a missing source reads as a
  // folder-copy candidate (fail closed, F1.922's shape), which is a refused case above.
  const spelledSource = '/tmp/nessy-f1160/src/a.txt';
  beforeAll(() => { mkdirSync(dirname(spelledSource), { recursive: true }); writeFileSync(spelledSource, 'x'); });
  afterAll(() => { rmSync('/tmp/nessy-f1160', { recursive: true, force: true }); });
  const refused: Array<[string, string]> = [
    ['the removal of the data folder itself', `rm -rf ${CONFIG_DIR}`],
    ['the removal of the workspaces folder', `rm -rf ${join(CONFIG_DIR, 'workspaces')}`],
    ['the move away of another workspace\'s folder', `mv ${join(CONFIG_DIR, 'workspaces', 'other-ws')} /tmp/nessy-f1160/`],
    ['the removal of THIS session\'s own workspace folder (no own-workspace carve-out on codex)', `rm -rf ${WORKSPACE_ROOT}`],
    ['a copy INTO the data folder under names it does not spell', `cp -R /tmp/nessy-f1160/src/ ${CONFIG_DIR}/`],
    ['a copy INTO another workspace\'s folder under names it does not spell', `cp -R /tmp/nessy-f1160/src/ ${join(CONFIG_DIR, 'workspaces', 'other-ws')}/`],
  ];
  for (const [label, command] of refused) {
    it(`bypassPermissions: refuses ${label}, with no card and a named reason`, () => {
      const { agent, debug, surfaced } = agentIn('bypassPermissions');
      expect(exec(agent, command)).toEqual({ decision: 'decline' });
      expect(surfaced).toHaveLength(0);
      expect(folderLine(debug)).toBe(true);
    });
  }

  it('default: refuses the data folder\'s removal without asking', () => {
    const { agent, debug, surfaced } = agentIn('default');
    expect(exec(agent, `rm -rf ${CONFIG_DIR}`)).toEqual({ decision: 'decline' });
    expect(surfaced).toHaveLength(0);
    expect(folderLine(debug)).toBe(true);
  });

  it('CONTROL — an ordinary folder inside the data folder is still removable in bypass', () => {
    const { agent, debug } = agentIn('bypassPermissions');
    expect(exec(agent, `rm -rf ${join(CONFIG_DIR, 'skills', 'my-skill')}`)).toEqual({ decision: 'accept' });
    expect(folderLine(debug)).toBe(false);
  });

  it('CONTROL — an ordinary subfolder of the own workspace is still movable in bypass', () => {
    const { agent, debug } = agentIn('bypassPermissions');
    expect(exec(agent, `mv ${join(WORKSPACE_ROOT, 'sessions')} /tmp/nessy-f1160/`)).toEqual({ decision: 'accept' });
    expect(folderLine(debug)).toBe(false);
  });

  it('CONTROL — a copy whose files are named one by one still lands in the own workspace in bypass', () => {
    const { agent, debug } = agentIn('bypassPermissions');
    expect(exec(agent, `cp /tmp/nessy-f1160/src/a.txt ${WORKSPACE_ROOT}/`)).toEqual({ decision: 'accept' });
    expect(folderLine(debug)).toBe(false);
  });

  it('CONTROL — a removal outside the data folder is still auto-approved in bypass', () => {
    const { agent, debug } = agentIn('bypassPermissions');
    expect(exec(agent, 'rm -rf /tmp/nessy-f1160-elsewhere/x')).toEqual({ decision: 'accept' });
    expect(floorLine(debug)).toBe(false);
  });
});

describe('F1.693 — an added directory INSIDE the config dir is not granted to codex', () => {
  const made: string[] = [];
  const configFile = join(CONFIG_DIR, 'config.json');
  const withAdded = (entries: string[]) => {
    for (const entry of entries) {
      const dir = entry.startsWith('/') ? entry : join(CONFIG_DIR, entry);
      mkdirSync(dir, { recursive: true });
      made.push(dir);
    }
    writeFileSync(configFile, JSON.stringify({
      storageLayoutVersion: STORAGE_LAYOUT_VERSION, workspaceRefs: [], activeWorkspaceId: null, activeSessionId: null,
      additionalDirectories: entries,
    }));
  };
  afterEach(() => { rmSync(configFile, { force: true }); });
  afterAll(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('refuses <config>/workspaces and a relative "codex-home", naming the reason', () => {
    withAdded([join(CONFIG_DIR, 'workspaces'), 'codex-home']);
    const { agent, debug } = agentIn('bypassPermissions');
    const roots: string[] = (agent as any).codexAdditionalWritableRoots();
    expect(roots).toEqual([]);
    expect(debug.filter(line => line.includes('inside Nessy\'s data folder'))).toHaveLength(2);
  });

  it('CONTROL — an added directory outside the config dir is still granted', () => {
    const outside = `/tmp/nessy-f1693-added-${process.pid}`;
    withAdded([outside]);
    const { agent, debug } = agentIn('bypassPermissions');
    const roots: string[] = (agent as any).codexAdditionalWritableRoots();
    expect(roots.length).toBe(1);
    expect(roots[0]!.endsWith(`nessy-f1693-added-${process.pid}`)).toBe(true);
    expect(debug.some(line => line.includes('inside Nessy\'s data folder'))).toBe(false);
  });
});

/**
 * F1.719 (owner decision 2026-09-26, option B) — a v2 patch whose files codex has not announced
 * on `item/started` yet (`[]`, C3.386) cannot be judged by the floor above, nor by the deny-path
 * and read-before-write refusals, so nothing on the bridge may answer YES for the user: bypass
 * raises the ordinary card (no Always Allow, C3.386), an unattended turn refuses even with the
 * operator's escape hatch open, dontAsk refuses. The shipped 0.156.1 always announces first
 * (`apply_patch.rs` runs `emitter.begin` before the orchestrator), so today this never fires.
 */
describe('F1.719 — a patch codex has not named yet is asked about, never auto-answered', () => {
  const unnamedPatch = (agent: CodexAgent) =>
    ask(agent, PATCH_METHOD, { itemId: `call-f1719-${++seq}`, threadId: 'thread-f1693', turnId: 'turn-f1693', startedAtMs: 0 });
  const unattended = (agent: CodexAgent) => { agent.onPermissionRequest = null; return agent; };
  const namedLine = (debug: string[]) => debug.some(line => line.includes('(F1.719)'));
  beforeEach(() => { delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]; });
  afterEach(() => { delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]; });

  it('bypassPermissions raises the ordinary card, without Always Allow, instead of the mode yes', () => {
    const { agent, debug, surfaced } = agentIn('bypassPermissions');
    const answer = unnamedPatch(agent);
    expect(answer).toBeInstanceOf(Promise);
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.noAlwaysAllow).toBe(true);
    expect(namedLine(debug)).toBe(true);
  });

  it('unattended, it is refused even with the operator escape hatch open', async () => {
    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    const { agent, debug } = agentIn('bypassPermissions');
    expect(await unnamedPatch(unattended(agent))).toEqual({ decision: 'decline' });
    expect(namedLine(debug)).toBe(true);
  });

  it('dontAsk refuses it without a card', () => {
    const { agent, surfaced } = agentIn('dontAsk');
    expect(unnamedPatch(agent)).toEqual({ decision: 'decline' });
    expect(surfaced).toHaveLength(0);
  });

  it('CONTROL — the same patch once announced keeps both yeses (bypass, and the open escape hatch)', async () => {
    const outside = '/tmp/nessy-f1719-elsewhere/notes.txt';
    const attended = agentIn('bypassPermissions');
    expect(await patchApproval(attended.agent, outside)).toEqual({ decision: 'accept' });
    expect(namedLine(attended.debug)).toBe(false);
    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    const headless = agentIn('bypassPermissions');
    expect(await patchApproval(unattended(headless.agent), outside)).toEqual({ decision: 'accept' });
    expect(namedLine(headless.debug)).toBe(false);
  });
});
