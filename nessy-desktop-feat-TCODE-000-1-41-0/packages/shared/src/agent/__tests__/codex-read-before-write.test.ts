/**
 * D1.342 — read-before-write on codex: the host READ LEDGER, and the refusal at
 * the one seam that can still withhold the write.
 *
 * ## The measurement these frames come from (2026-09-18)
 *
 * Every notification body below is VERBATIM from a real turn driven against the
 * staged `codex-app-server` (darwin-arm64) over the loopback stub adapter on a
 * fake key, in an isolated `CODEX_HOME` and a temp workspace — never a packaged
 * app and never anybody's session. Only the paths are re-pointed at this
 * suite's own temp directory. What that rig measured, and why each half of the
 * rule is shaped the way it is, is recorded on `CodexAgent.creditCodexFileRead`
 * and `CodexAgent.readBeforeWriteVerdict`. Three readings carry the suite:
 *
 *  - a codex READ is a shell command whose `command` is the LOGIN-SHELL form
 *    (`/bin/zsh -lc 'cat target.txt'`), which `bareFileViewerOperand` cannot
 *    read — so a ledger built on the host `tool_start` input alone credits
 *    nothing and refuses everything, which is why D1.332 declined to ship this;
 *  - the ITEM carries codex's own `commandActions` classification, with the
 *    UNWRAPPED command and an ABSOLUTE path it resolved itself;
 *  - `read-only` / `on-request` really does raise
 *    `item/fileChange/requestApproval`, and `decline` left the file at its
 *    pre-image while `accept` applied the patch — the same rig, the same
 *    minute, only the answer varied.
 *
 * ## How to read the cases
 *
 * The POSITIVE CONTROL is first and is repeated in every arm: a card must still
 * be raised. A gate that refused every file change would satisfy each refusal
 * assertion here on its own, and the control is what stops that passing.
 *
 * Nothing in this file spawns a process or touches a real home directory; the
 * files are `mkdtemp`'d and removed.
 */
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { readBeforeWriteRefusal } from '../core/read-before-write.ts';
import { permissionsConfigCache } from '../permissions-config.ts';

const FILE_CHANGE_METHOD = 'item/fileChange/requestApproval';
const EXEC_METHOD = 'item/commandExecution/requestApproval';
const ITEM_ID = 'call_resp_1';

const ROOT = mkdtempSync(join(tmpdir(), 'codex-rbw-'));
const SEEDED = join(ROOT, 'target.txt');
const ABSENT = join(ROOT, 'never-written.txt');
writeFileSync(SEEDED, 'sable-harbour-41\n');

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-rbw',
      name: 'Codex Read-Before-Write Workspace',
      rootPath: ROOT,
      workspaceRootPath: ROOT,
      sessionRootPath: join(ROOT, '.sessions'),
    } as never,
    session: {
      id: 'session-codex-rbw',
      workspaceRootPath: ROOT,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: ROOT,
    } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

interface Rig {
  notify: (method: string, params: unknown) => void;
  ask: (method: string, params: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>;
  debug: string[];
  surfaced: Array<Parameters<PermissionCallback>[0]>;
  agent: CodexAgent;
}

/**
 * A real `CodexAgent` driven through its own notification and approval entry
 * points. Only `emitAutomationEvent` is stubbed — it is the hook bus, it reads
 * the automation config, and no case here is about a hook.
 */
function rig(): Rig {
  const agent = new CodexAgent(createConfig());
  const debug: string[] = [];
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onDebug = (message) => { debug.push(message); };
  agent.onPermissionRequest = (request) => { surfaced.push(request); };
  const internals = agent as unknown as {
    handleNotification: (method: string, params: unknown) => void;
    handleServerRequest: (method: string, params: unknown) => unknown;
    emitAutomationEvent: (event: string, input: Record<string, unknown>) => Promise<unknown>;
  };
  internals.emitAutomationEvent = async () => undefined;
  return {
    agent,
    debug,
    surfaced,
    notify: (method, params) => { internals.handleNotification(method, params); },
    ask: (method, params) => internals.handleServerRequest(method, params) as never,
  };
}

/** The `fileChange` item codex announces before it writes, verbatim in shape. */
function fileChangeItem(path: string, status: string) {
  return {
    type: 'fileChange',
    id: ITEM_ID,
    changes: [{ path, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }],
    status,
  };
}

/** The `commandExecution` item codex completes a shell command with. */
function commandItem(options: {
  command: string;
  exitCode: number;
  actions: unknown[];
}) {
  return {
    type: 'commandExecution',
    id: 'call_cmd_1',
    pluginId: null,
    scriptPath: null,
    command: options.command,
    cwd: ROOT,
    processId: '32231',
    source: 'unifiedExecStartup',
    status: options.exitCode === 0 ? 'completed' : 'failed',
    commandActions: options.actions,
    aggregatedOutput: 'sable-harbour-41\n',
    exitCode: options.exitCode,
    durationMs: 381,
  };
}

/** Codex's own classification of a whole-file view, as measured. */
const readAction = (command: string, path: string) =>
  ({ type: 'read', command, name: 'target.txt', path });

/** Announce the patch (this is what teaches the approval its paths) and ask. */
function askAboutPatchOf(r: Rig, path: string) {
  r.notify('item/started', { item: fileChangeItem(path, 'inProgress') });
  return r.ask(FILE_CHANGE_METHOD, {
    threadId: 't1',
    turnId: 'u1',
    itemId: ITEM_ID,
    startedAtMs: Date.now(),
    reason: null,
    grantRoot: null,
  });
}

const refusedHere = (debug: string[]) =>
  debug.some(line => line.includes('refused by read-before-write'));

beforeEach(() => {
  permissionsConfigCache.clear();
});

describe('D1.342 — the codex approval bridge refuses a write to a file nobody read', () => {
  /**
   * THE POSITIVE CONTROL, first, and repeated as the second half of every
   * refusal case below. A gate that refused every file change would pass every
   * other assertion in this file; this is the one it cannot pass.
   */
  it('still raises the card for a NEW file — the constraint is not about new files', async () => {
    const r = rig();

    const pending = askAboutPatchOf(r, ABSENT);

    expect(refusedHere(r.debug)).toBe(false);
    expect(r.surfaced).toHaveLength(1);
    r.agent.respondToPermission(r.surfaced[0]!.requestId, true);
    expect(await pending).toEqual({ decision: 'accept' });
  });

  /**
   * KILLS: deleting the `readBeforeWriteVerdict` call from
   * `handleServerRequest`, and any answer that reaches a human. The sentence is
   * asserted by IDENTITY against `readBeforeWriteRefusal`, so a codex-only
   * rewording — the divergence this module exists to prevent — fails here.
   */
  it('declines an unseen existing file without a card, with the shared sentence', async () => {
    const r = rig();

    const result = await askAboutPatchOf(r, SEEDED);

    expect(result).toEqual({ decision: 'decline' });
    expect(r.surfaced).toEqual([]);
    expect(r.debug.some(line => line === `codex approval refused by read-before-write: ${readBeforeWriteRefusal(SEEDED)}`))
      .toBe(true);
  });

  /**
   * KILLS: the credit itself. This is the measured codex read — the login-shell
   * `command` with codex's own single `read` action beside it — and after it the
   * SAME patch that was declined above reaches the card.
   */
  it('allows the write once codex has reported a whole-file read of it', async () => {
    const r = rig();

    r.notify('item/completed', {
      item: commandItem({
        command: `/bin/zsh -lc 'cat ${SEEDED}'`,
        exitCode: 0,
        actions: [readAction(`cat ${SEEDED}`, SEEDED)],
      }),
    });
    const pending = askAboutPatchOf(r, SEEDED);

    expect(refusedHere(r.debug)).toBe(false);
    expect(r.surfaced).toHaveLength(1);
    r.agent.respondToPermission(r.surfaced[0]!.requestId, true);
    expect(await pending).toEqual({ decision: 'accept' });
  });

  /**
   * KILLS: crediting every `type: 'read'` action. Codex calls `head -n 1 f` a
   * `read` and names the file; the conversation saw one line of it. Pi refuses
   * a write after the same command, so crediting it here would make codex
   * looser than Pi on identical input.
   */
  it('does NOT credit a partial read codex still classifies as `read`', async () => {
    const r = rig();

    r.notify('item/completed', {
      item: commandItem({
        command: `/bin/zsh -lc 'head -n 1 ${SEEDED}'`,
        exitCode: 0,
        actions: [readAction(`head -n 1 ${SEEDED}`, SEEDED)],
      }),
    });
    const result = await askAboutPatchOf(r, SEEDED);

    expect(result).toEqual({ decision: 'decline' });
    expect(refusedHere(r.debug)).toBe(true);
  });

  /**
   * KILLS: crediting before the exit code is known. Measured on the rig: a
   * `bat target.txt` with no `bat` installed answers a `read` action and exit
   * **127**, and `cat missing.txt` answers a `read` action and exit 1.
   */
  it('does NOT credit a viewer that failed', async () => {
    const r = rig();

    r.notify('item/completed', {
      item: commandItem({
        command: `/bin/zsh -lc 'bat ${SEEDED}'`,
        exitCode: 127,
        actions: [readAction(`bat ${SEEDED}`, SEEDED)],
      }),
    });
    const result = await askAboutPatchOf(r, SEEDED);

    expect(result).toEqual({ decision: 'decline' });
    expect(refusedHere(r.debug)).toBe(true);
  });

  /**
   * KILLS: reading `commandActions[0]` and ignoring the rest. `cat f | grep x`
   * measures as TWO actions, a clean `read` of `f` followed by a `search` — and
   * the conversation saw only the matching lines.
   */
  it('does NOT credit the read half of a pipeline', async () => {
    const r = rig();

    r.notify('item/completed', {
      item: commandItem({
        command: `/bin/zsh -lc 'cat ${SEEDED} | grep sable'`,
        exitCode: 0,
        actions: [
          readAction(`cat ${SEEDED}`, SEEDED),
          { type: 'search', command: 'grep sable', query: 'sable', path: null },
        ],
      }),
    });
    const result = await askAboutPatchOf(r, SEEDED);

    expect(result).toEqual({ decision: 'decline' });
    expect(refusedHere(r.debug)).toBe(true);
  });

  /**
   * Pi's decision 2, *"a file this session WROTE counts as seen"*: a patch codex
   * has APPLIED credits its own paths, so a second patch of the same file is
   * not refused for a read that could not have happened.
   */
  it('credits a patch codex reports as completed', async () => {
    const r = rig();

    r.notify('item/completed', { item: fileChangeItem(SEEDED, 'completed') });
    const pending = askAboutPatchOf(r, SEEDED);

    expect(refusedHere(r.debug)).toBe(false);
    expect(r.surfaced).toHaveLength(1);
    r.agent.respondToPermission(r.surfaced[0]!.requestId, true);
    expect(await pending).toEqual({ decision: 'accept' });
  });

  /**
   * THE NEGATIVE CONTROL for the case above, and it is codex's own vocabulary:
   * `PatchApplyStatus` is `inProgress | completed | failed | declined`, and the
   * rig measured `"declined"` on the arm whose file stayed at its pre-image. A
   * refused patch wrote nothing, so it must credit nothing.
   */
  it('does NOT credit a patch codex reports as declined', async () => {
    const r = rig();

    r.notify('item/completed', { item: fileChangeItem(SEEDED, 'declined') });
    const result = await askAboutPatchOf(r, SEEDED);

    expect(result).toEqual({ decision: 'decline' });
    expect(refusedHere(r.debug)).toBe(true);
  });

  /**
   * THE SCOPE BOUNDARY. `codexApprovalFloorSubjects` renders a shell approval as
   * `Bash`, which is not in `READ_BEFORE_WRITE_TOOLS` — so a command approval
   * must reach the card even when its words name a file nobody read. Without
   * this, a verdict that ignored the tool name would still pass every case
   * above.
   */
  it('never refuses a COMMAND approval, whatever file its words name', async () => {
    const r = rig();

    const pending = r.ask(EXEC_METHOD, { command: `cat ${SEEDED}`, cwd: ROOT });

    expect(refusedHere(r.debug)).toBe(false);
    expect(r.surfaced).toHaveLength(1);
    r.agent.respondToPermission(r.surfaced[0]!.requestId, true);
    expect(await pending).toEqual({ decision: 'accept' });
  });
});
