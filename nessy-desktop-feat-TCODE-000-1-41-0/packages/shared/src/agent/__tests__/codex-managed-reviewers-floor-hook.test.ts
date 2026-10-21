/**
 * F1.514 (origin WJ-ag P-WJ-ag-1, 2026-09-24; DECIDED by the controller) — an
 * administrator's `allowed_approvals_reviewers` that leaves out `user` keeps
 * F1.386's unattended-automation floor, with the Settings toggle OFF.
 *
 * ## The defect, measured on the shipped binary (WJ-an, `work/wjan/`)
 *
 * The MDM rig WJ-ag built for F1.482 (the shipped `codex-app-server` 0.154.0,
 * the requirement `allowed_approvals_reviewers = ["auto_review"]` delivered
 * through codex's own macOS MDM reader, the config written by the product's
 * writer with a real session's options, the workspace under `$HOME`), two
 * sessions in two processes, the toggle off: in BOTH, the product projected no
 * floor hook — `unattendedAutomationFloorHookProjection` keyed on the reviewer
 * the WRITTEN config carries, and the administrator's list is readable only
 * after the app-server is up — so codex's reviewer answered a floored
 * `automation_update` (re-enabling a disabled bypass-mode automation) and the
 * edit LANDED. The second session knew nothing the first had read.
 *
 * ## The fix (native-first + transparent)
 *
 * The list the requirements probe reads is remembered in the F1.101 shape
 * (`config/codex-managed-requirement-cache.ts`): recorded in-process and on disk
 * by every ANSWERED read, restored at bootstrap, and an answered read with no
 * list clears it. The NEXT runtime build projects the floor hook whenever the
 * remembered list leaves out `user`. A session built before any list was known
 * says so in the start notice F1.482 added.
 *
 * WHAT EACH ARM KILLS: the projection arm dies if the hook keys on the written
 * config alone again; the restart arm if the list stops reaching disk or the
 * bootstrap stops reading it; the notice arm if the first session stops naming
 * the gap. The controls: no administrator list projects nothing beyond today; a
 * list that allows `user` projects nothing (every turn asks for `user`, so this
 * host is asked); a withdrawn list clears the cache; a FAILED read changes
 * nothing (P2.137's rule).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODEX_HOOK_PROJECTION_NOTICE } from '@nessy-agent/codex-responses-adapter/config-writer';
import { CodexAgent } from '../codex-agent.ts';
import { codexAutomationFloorHookCommand } from '../backend/codex/automation-floor-hook.ts';
import * as cacheModule from '../../config/codex-managed-requirement-cache.ts';
import { CONFIG_DIR } from '../../config/paths.ts';

type Reviewers = readonly ('user' | 'auto_review')[] | undefined;
const cache = cacheModule as unknown as {
  CODEX_MANAGED_APPROVALS_REVIEWERS_CACHE_FILE?: string;
  recordAndPersistCodexManagedApprovalsReviewers?: (list: Reviewers, configDir?: string) => boolean;
  restoreCodexManagedApprovalsReviewers?: (configDir?: string) => boolean;
  getCodexManagedApprovalsReviewers?: () => Reviewers;
};

/** The `configRequirements/read` result the shipped binary answered under `["auto_review"]` (trimmed). */
const MEASURED_READ_RESULT = {
  requirements: { allowedApprovalPolicies: null, allowedApprovalsReviewers: ['auto_review'], allowedSandboxModes: null },
};
const BOTH_READ_RESULT = { requirements: { allowedApprovalsReviewers: ['auto_review', 'user'] } };
const NO_LIST_READ_RESULT = { requirements: null };

const NODE = '/opt/nessy/bun';
const SERVER = '/opt/nessy/session-mcp-server/index.js';
const ROOT = '/work/space';
const OURS = codexAutomationFloorHookCommand(NODE, SERVER, ROOT);

function agentAt(): CodexAgent {
  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: { id: 'ws-f1514', name: 'F1.514', rootPath: ROOT, workspaceRootPath: ROOT, sessionRootPath: `${ROOT}/sessions` } as any,
    session: { id: 'session-f1514', workspaceRootPath: ROOT, createdAt: Date.now(), lastUsedAt: Date.now() } as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer: SERVER, node: NODE } },
  } as never);
  agent.onDebug = () => {};
  (agent as any).debug = () => {};
  return agent;
}

/** One session: the Settings toggle OFF (the writer's own gate), then the runtime build's hook projection. */
function buildWithToggleOff(agent: CodexAgent): { hooks?: { PermissionRequest?: Array<{ hooks: Array<{ command: string }> }> } } {
  (agent as any).noteConfiguredApprovalsReviewer({});
  return (agent as any).hostAuthoredHookProjection();
}

/** The requirements read this runtime build makes, through the product's recording channel. */
async function readRequirements(agent: CodexAgent, result: unknown): Promise<void> {
  await (agent as any).recordManagedApprovalsReviewers({ request: async () => result }).request('configRequirements/read');
}

const commandOfProjection = (projected: { hooks?: unknown }) =>
  (projected.hooks as { PermissionRequest?: Array<{ hooks: Array<{ command: string }> }> } | undefined)?.PermissionRequest?.[0]?.hooks[0]?.command;

const cacheFile = () => join(CONFIG_DIR, cache.CODEX_MANAGED_APPROVALS_REVIEWERS_CACHE_FILE ?? 'codex-managed-approvals-reviewers.json');

afterEach(() => { cache.recordAndPersistCodexManagedApprovalsReviewers?.(undefined); });

describe('F1.514 · the administrator reviewer list keeps the automation floor, toggle off', () => {
  it('the first session reads ["auto_review"]; the NEXT session projects the floor hook although auto-review is off in Settings', async () => {
    const first = agentAt();
    try {
      expect(buildWithToggleOff(first)).toEqual({});
      await readRequirements(first, MEASURED_READ_RESULT);
    } finally { first.destroy(); }
    const next = agentAt();
    try {
      const projected = buildWithToggleOff(next);
      expect((next as any).configuredApprovalsReviewer).toBeUndefined();
      expect(projected.hooks?.PermissionRequest?.[0]?.hooks[0]?.command).toBe(OURS);
      expect((next as any).sessionFacts.get('codex-hooks-projection')).toContain('F1.386');
    } finally { next.destroy(); }
  });

  it('the list survives a restart: written to disk by the answered read, restored by the bootstrap call', async () => {
    const first = agentAt();
    try { await readRequirements(first, MEASURED_READ_RESULT); } finally { first.destroy(); }
    expect(JSON.parse(readFileSync(cacheFile(), 'utf8'))).toEqual({ v: 1, allowedApprovalsReviewers: ['auto_review'] });
    // A new process starts with nothing in memory: stand one up by clearing the
    // tier through a scratch directory, then run the bootstrap's own restore.
    cache.recordAndPersistCodexManagedApprovalsReviewers!(undefined, mkdtempSync(join(tmpdir(), 'f1514-other-')));
    expect(cache.getCodexManagedApprovalsReviewers!()).toBeUndefined();
    expect(cache.restoreCodexManagedApprovalsReviewers!()).toBe(true);
    expect(cache.getCodexManagedApprovalsReviewers!()).toEqual(['auto_review']);
    const next = agentAt();
    try {
      expect(buildWithToggleOff(next).hooks?.PermissionRequest?.[0]?.hooks[0]?.command).toBe(OURS);
    } finally { next.destroy(); }
  });

  it('a session built before the list was known says, in its start notice, that the floor does not hold there', async () => {
    const agent = agentAt();
    try {
      expect(buildWithToggleOff(agent)).toEqual({});
      await readRequirements(agent, MEASURED_READ_RESULT);
      const notices: string[] = (agent as any).pendingServerWarningNotices;
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('auto-review is off in Settings');
      expect(notices[0]).toContain('unattended-automation floor does not hold in this session');
      expect(notices[0]).toContain('Codex sessions started from now on');
    } finally { agent.destroy(); }
  });

  it('CONTROL: a session that projected the hook names no gap in the same notice', async () => {
    cache.recordAndPersistCodexManagedApprovalsReviewers!(['auto_review']);
    const agent = agentAt();
    try {
      expect(buildWithToggleOff(agent).hooks).toBeDefined();
      await readRequirements(agent, MEASURED_READ_RESULT);
      const notices: string[] = (agent as any).pendingServerWarningNotices;
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('auto-review is off in Settings');
      expect(notices[0]).not.toContain('does not hold');
    } finally { agent.destroy(); }
  });
});

/**
 * F1.611 (origin the 1.41.0 delta review, 2026-09-24) — the mirror of F1.514's
 * stale-cache residue. The toggle ON, and the list remembered at the build is an
 * older `["user"]` that kept the reviewer out, so F1.532's "who answers" arm
 * projects no floor hook. When the live read then lets the reviewer answer (the
 * policy withdrawn, widened to allow `auto_review`, or now requiring it), codex's
 * reviewer answers a floored `automation_update` for this whole session. Before
 * this row nothing said so; the answered read already refreshed the cache.
 */
describe('F1.611 · a stale remembered list without auto_review, toggle on', () => {
  const USER_ONLY_READ_RESULT = { requirements: { allowedApprovalsReviewers: ['user'] } };

  function buildWithToggleOn(agent: CodexAgent): { hooks?: unknown } {
    (agent as any).autoReviewSettingOn = () => true;
    (agent as any).noteConfiguredApprovalsReviewer({ approvalsReviewer: 'auto_review' });
    return (agent as any).hostAuthoredHookProjection();
  }

  it('the live read lets the reviewer answer: the session says the floor does not hold, and the next build projects the hook', async () => {
    for (const live of [NO_LIST_READ_RESULT, BOTH_READ_RESULT, MEASURED_READ_RESULT]) {
      cache.recordAndPersistCodexManagedApprovalsReviewers!(['user']);
      const stale = agentAt();
      try {
        expect((stale as any).configuredApprovalsReviewer).toBeUndefined();
        expect(buildWithToggleOn(stale).hooks).toBeUndefined();
        expect((stale as any).configuredApprovalsReviewer).toBe('auto_review');
        await readRequirements(stale, live);
        const notices: string[] = (stale as any).pendingServerWarningNotices;
        // F1.1198 — a live list that leaves out `user` adds its own reviewer-only notice beside this one.
        const expected = live === MEASURED_READ_RESULT ? 2 : 1;
        expect(notices).toHaveLength(expected);
        const floor = notices.find((n) => n.includes('allowed_approvals_reviewers: user')) ?? '';
        expect(floor).toContain('unattended-automation floor does not hold in this session');
        expect(floor).toContain('Codex sessions started from now on');
        // Said once per build: a second answered read in the same build adds nothing.
        await readRequirements(stale, live);
        expect((stale as any).pendingServerWarningNotices).toHaveLength(expected);
      } finally { stale.destroy(); }
      const next = agentAt();
      try {
        expect(commandOfProjection(buildWithToggleOn(next))).toBe(OURS);
      } finally { next.destroy(); }
    }
  });

  it('CONTROL: the live list still leaves out auto_review — codex falls back to the user, this host is asked, nothing is said', async () => {
    cache.recordAndPersistCodexManagedApprovalsReviewers!(['user']);
    const agent = agentAt();
    try {
      expect(buildWithToggleOn(agent).hooks).toBeUndefined();
      await readRequirements(agent, USER_ONLY_READ_RESULT);
      expect((agent as any).pendingServerWarningNotices).toHaveLength(0);
    } finally { agent.destroy(); }
  });

  it('CONTROL: the fresh-cache path is unchanged — no list remembered, the hook is projected, the read adds no notice', async () => {
    const agent = agentAt();
    try {
      expect(commandOfProjection(buildWithToggleOn(agent))).toBe(OURS);
      await readRequirements(agent, NO_LIST_READ_RESULT);
      expect((agent as any).pendingServerWarningNotices).toHaveLength(0);
    } finally { agent.destroy(); }
  });
});

/**
 * F1.1198 (the do-now second review pass, 2026-10-01) — the toggle ON under a list that leaves out `user`.
 * Manual, Accept edits and Don't ask want `'user'` since F1.1169/F1.1056, the list forbids it, so the turn
 * asks for nothing and the thread's reviewer keeps answering (native-first: the administrator's list is
 * codex's own and wins). The notice above fired only with the toggle OFF, so nothing said so.
 */
describe('F1.1198 · a reviewer-only list with the toggle on is said once', () => {
  function buildWithToggleOn(agent: CodexAgent): void {
    (agent as any).autoReviewSettingOn = () => true;
    (agent as any).noteConfiguredApprovalsReviewer({ approvalsReviewer: 'auto_review' });
    (agent as any).hostAuthoredHookProjection();
  }

  it('the list allows only auto_review: one notice names Manual, Accept edits and Don\'t ask, and no floor gap', async () => {
    const agent = agentAt();
    try {
      buildWithToggleOn(agent);
      await readRequirements(agent, MEASURED_READ_RESULT);
      const notices: string[] = (agent as any).pendingServerWarningNotices;
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('allowed_approvals_reviewers: auto_review');
      expect(notices[0]).toContain('in Manual, Accept edits and Don\'t ask too');
      expect(notices[0]).toContain('Plan cannot run on Codex under this policy');
      expect(notices[0]).not.toContain('auto-review is off in Settings');
      expect(notices[0]).not.toContain('does not hold');
    } finally { agent.destroy(); }
  });

  it('BOUNDARY: a list that also allows user says nothing — every mode gets the reviewer it wants', async () => {
    const agent = agentAt();
    try {
      buildWithToggleOn(agent);
      await readRequirements(agent, BOTH_READ_RESULT);
      expect((agent as any).pendingServerWarningNotices).toHaveLength(0);
    } finally { agent.destroy(); }
  });
});

describe('F1.514 · controls', () => {
  it('no administrator list: nothing is projected beyond today, and the cache records the answered "none"', async () => {
    const first = agentAt();
    try { await readRequirements(first, NO_LIST_READ_RESULT); } finally { first.destroy(); }
    expect(JSON.parse(readFileSync(cacheFile(), 'utf8'))).toEqual({ v: 1, allowedApprovalsReviewers: null });
    const next = agentAt();
    try {
      expect(buildWithToggleOff(next)).toEqual({});
      expect((next as any).sessionFacts.get('codex-hooks-projection')).toBe(CODEX_HOOK_PROJECTION_NOTICE);
    } finally { next.destroy(); }
  });

  it('a list that allows user projects nothing: every turn asks for user, so this host is asked and its own floor answers', async () => {
    const first = agentAt();
    try { await readRequirements(first, BOTH_READ_RESULT); } finally { first.destroy(); }
    const next = agentAt();
    try { expect(buildWithToggleOff(next)).toEqual({}); } finally { next.destroy(); }
  });

  it('the list withdrawn: the next answered read clears the cache, on disk too, and the next session projects nothing', async () => {
    const first = agentAt();
    try { await readRequirements(first, MEASURED_READ_RESULT); } finally { first.destroy(); }
    const second = agentAt();
    try {
      expect(buildWithToggleOff(second).hooks).toBeDefined();
      await readRequirements(second, NO_LIST_READ_RESULT);
    } finally { second.destroy(); }
    expect(cache.getCodexManagedApprovalsReviewers!()).toBeUndefined();
    expect(JSON.parse(readFileSync(cacheFile(), 'utf8'))).toEqual({ v: 1, allowedApprovalsReviewers: null });
    // …and a restart reads the clear, not the old list.
    cache.recordAndPersistCodexManagedApprovalsReviewers!(['auto_review'], mkdtempSync(join(tmpdir(), 'f1514-other-')));
    expect(cache.restoreCodexManagedApprovalsReviewers!()).toBe(true);
    expect(cache.getCodexManagedApprovalsReviewers!()).toBeUndefined();
    const third = agentAt();
    try { expect(buildWithToggleOff(third)).toEqual({}); } finally { third.destroy(); }
  });

  it('a FAILED read changes nothing — neither the tier nor the file (P2.137: only an answer may write)', async () => {
    const first = agentAt();
    try { await readRequirements(first, MEASURED_READ_RESULT); } finally { first.destroy(); }
    const before = readFileSync(cacheFile(), 'utf8');
    const agent = agentAt();
    try {
      const failing = (agent as any).recordManagedApprovalsReviewers({ request: async () => { throw new Error('timed out'); } });
      await expect(failing.request('configRequirements/read')).rejects.toThrow('timed out');
    } finally { agent.destroy(); }
    expect(cache.getCodexManagedApprovalsReviewers!()).toEqual(['auto_review']);
    expect(readFileSync(cacheFile(), 'utf8')).toBe(before);
  });

  it('an unreadable cache is "we do not know": the restore reports false and leaves the tier alone', () => {
    cache.recordAndPersistCodexManagedApprovalsReviewers!(['auto_review'], mkdtempSync(join(tmpdir(), 'f1514-other-')));
    for (const body of ['not json', '{"v":2,"allowedApprovalsReviewers":["auto_review"]}', '{"v":1,"allowedApprovalsReviewers":"auto_review"}', '{"v":1,"allowedApprovalsReviewers":["nobody"]}']) {
      const dir = mkdtempSync(join(tmpdir(), 'f1514-bad-'));
      writeFileSync(join(dir, cache.CODEX_MANAGED_APPROVALS_REVIEWERS_CACHE_FILE!), body);
      expect(cache.restoreCodexManagedApprovalsReviewers!(dir)).toBe(false);
      expect(cache.getCodexManagedApprovalsReviewers!()).toEqual(['auto_review']);
    }
    expect(cache.restoreCodexManagedApprovalsReviewers!(mkdtempSync(join(tmpdir(), 'f1514-empty-')))).toBe(false);
  });

  it('BOTH hosts restore it: bootstrapServer’s config-artifacts step, beside the F1.101 twin and ahead of the config dir', () => {
    const source = readFileSync(new URL('../../../../server-core/src/bootstrap/headless-start.ts', import.meta.url), 'utf8');
    const step = source.indexOf('function bootstrapConfigArtifacts(');
    const restore = source.indexOf('\n  restoreCodexManagedApprovalsReviewers()', step);
    const configDir = source.indexOf('\n  ensureConfigDir()\n', step);
    expect(step).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(step);
    expect(restore).toBeLessThan(configDir);
  });
});
