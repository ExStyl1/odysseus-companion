/**
 * C3.386 — the host half: the v2 file-change approval reaches the FLOOR and the
 * rule matchers with real paths, correlated from the frame's `itemId`.
 *
 * RS-12 on packaged 1.37.0 met a bare `ApplyPatch / Apply file changes / Always
 * Allow` card for a patch writing into a protected directory, with no floor
 * sentence — because `codexApprovalRuleRequests` and `codexApprovalFloorSubjects`
 * implemented `fileChangeV1` and fell through to `default → []` for `fileChange`.
 *
 * The paths were in this process the whole time. `ThreadItem`'s `fileChange`
 * variant carries `changes: Array<FileUpdateChange>` (`{ path, kind, diff }`)
 * and arrives on `item/started`; `checkpointCodexFileChange`'s own comment
 * already records the fact that closes the loop — *"The approval request and the
 * patch-begin event carry the SAME `call_id`"*, which is the frame's `itemId`.
 *
 * ## Two levels, both asserted
 *
 * The PROJECTION is exported and driven directly. The CORRELATION is a private
 * pair on the agent, driven through `(agent as any)` because its whole job is a
 * lifecycle — recorded at `item/started`, released at `item/completed` — and a
 * pure-function test cannot see a lifecycle.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent, codexApprovalRuleRequests } from '../codex-agent.ts';

const CWD = '/tmp/project-root';

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/ws-root',
      workspaceRootPath: '/tmp/ws-root',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/ws-root',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: CWD,
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig;
}

/** The shape `item/started` delivers for a patch codex is about to apply. */
function fileChangeItem(id: string, paths: string[]): unknown {
  return {
    type: 'fileChange',
    id,
    status: 'inProgress',
    changes: paths.map(path => ({ path, kind: 'update', diff: '@@ -1 +1 @@' })),
  };
}

describe('C3.386 — the projection', () => {
  it('POSITIVE — a v2 fileChange with paths emits the same requests v1 does', () => {
    const v2 = codexApprovalRuleRequests('fileChange', { itemId: 'call-1' }, CWD, ['/repo/a.ts']);
    const v1 = codexApprovalRuleRequests('fileChangeV1', { fileChanges: { '/repo/a.ts': {} } }, CWD);

    // P6.644's two spellings, one per path, on BOTH protocol versions — two
    // branches would be two chances for them to answer one user rule differently.
    expect(v2).toEqual(v1);
    expect(v2.map(request => request.toolName)).toEqual(['Write', 'Edit']);
    expect(v2.every(request => (request.input as any).file_path === '/repo/a.ts')).toBe(true);
  });

  it('NEGATIVE — with no paths it still returns [], which is "ask the human"', () => {
    // The pre-C3.386 answer for this kind, preserved exactly. Nothing is
    // inferred from a frame that carries nothing: `grantRoot` is a session
    // write root, not the file being written.
    expect(codexApprovalRuleRequests('fileChange', { itemId: 'call-1', grantRoot: '/repo' }, CWD))
      .toEqual([]);
  });

  it('CONTROL — the other kinds are untouched by the new parameter', () => {
    // The parameter is optional and defaulted, so a caller that does not pass
    // it must see exactly today's behaviour on every other kind.
    expect(codexApprovalRuleRequests('command', { command: 'ls -la' }, CWD, ['/repo/a.ts']))
      .toEqual([{ toolName: 'Bash', semanticId: 'bash', input: { command: 'ls -la' }, cwd: CWD }]);
  });
});

describe('C3.386 — the correlation', () => {
  it('POSITIVE — an item announced on item/started is found by the approval\'s itemId', () => {
    const agent = new CodexAgent(createConfig());
    (agent as any).rememberCodexFileChangePaths(fileChangeItem('call-7', ['/repo/.codex/rules/x.rules']));

    expect((agent as any).codexFileChangeApprovalPaths({ itemId: 'call-7' }))
      .toEqual(['/repo/.codex/rules/x.rules']);

    agent.destroy();
  });

  it('POSITIVE — a relative path is resolved against the working directory', () => {
    // `createFileCheckpoint` refuses a relative target outright, so the two
    // consumers must agree on the absolute form or the card and the checkpoint
    // would name different files.
    const agent = new CodexAgent(createConfig());
    (agent as any).rememberCodexFileChangePaths(fileChangeItem('call-8', ['src/app.ts']));

    expect((agent as any).codexFileChangeApprovalPaths({ itemId: 'call-8' }))
      .toEqual([`${CWD}/src/app.ts`]);

    agent.destroy();
  });

  it('BOUNDARY — an unknown or absent itemId answers [] rather than guessing', () => {
    const agent = new CodexAgent(createConfig());
    (agent as any).rememberCodexFileChangePaths(fileChangeItem('call-9', ['/repo/a.ts']));

    expect((agent as any).codexFileChangeApprovalPaths({ itemId: 'call-other' })).toEqual([]);
    expect((agent as any).codexFileChangeApprovalPaths({})).toEqual([]);
    expect((agent as any).codexFileChangeApprovalPaths(undefined)).toEqual([]);

    agent.destroy();
  });

  it('BOUNDARY — the item is RELEASED at item/completed, so a later approval cannot inherit it', () => {
    // The failure this prevents is the worst one available here: a card naming a
    // file the request is not about, which is a user consenting to the wrong act.
    const agent = new CodexAgent(createConfig());
    (agent as any).rememberCodexFileChangePaths(fileChangeItem('call-10', ['/repo/a.ts']));
    expect((agent as any).codexFileChangeApprovalPaths({ itemId: 'call-10' })).toEqual(['/repo/a.ts']);

    (agent as any).finalizeCodexFileChange(fileChangeItem('call-10', ['/repo/a.ts']));

    expect((agent as any).codexFileChangeApprovalPaths({ itemId: 'call-10' })).toEqual([]);

    agent.destroy();
  });

  it('CONTROL — the FIRST sighting wins, matching the checkpoint\'s own rule', () => {
    // codex may announce one item twice (the approval and the patch-begin share
    // a `call_id`), and the earliest announcement is the one taken before any
    // write — so a later re-announcement must not replace it.
    const agent = new CodexAgent(createConfig());
    (agent as any).rememberCodexFileChangePaths(fileChangeItem('call-11', ['/repo/first.ts']));
    (agent as any).rememberCodexFileChangePaths(fileChangeItem('call-11', ['/repo/second.ts']));

    expect((agent as any).codexFileChangeApprovalPaths({ itemId: 'call-11' })).toEqual(['/repo/first.ts']);

    agent.destroy();
  });

  it('CONTROL — an item carrying no usable path records nothing at all', () => {
    const agent = new CodexAgent(createConfig());
    (agent as any).rememberCodexFileChangePaths({ type: 'fileChange', id: 'call-12', changes: [] });
    (agent as any).rememberCodexFileChangePaths({ type: 'commandExecution', id: 'call-13' });

    expect((agent as any).codexFileChangeApprovalPaths({ itemId: 'call-12' })).toEqual([]);
    expect((agent as any).codexFileChangeApprovalPaths({ itemId: 'call-13' })).toEqual([]);

    agent.destroy();
  });
});
