/**
 * P6.644 — codex's two approval projections spelled the same act `Edit` and
 * `Write`, so an `Edit(...)` deny and a `Write(...)` allow each silently missed
 * half the gate.
 *
 * Found twice independently (W7-s2 beyond its rows, then W8-doc1 while recording
 * P6.199/P6.610), and reasoned nowhere in the source.
 *
 * ## The deviation from the row's "one spelling", asserted rather than only
 * argued
 *
 * Picking a winner closes the asymmetry and silently breaks every rule written
 * with the loser — the same class of defect, moved rather than removed. And the
 * host's own vocabulary never had one spelling: `mode-manager.ts` treats
 * `Write`, `Edit`, `MultiEdit` and `NotebookEdit` as ONE class for the write act,
 * while `permission-dsl.ts:1237` matches a rule against `semanticId` or the
 * literal `toolName` and does NOT expand that class. So both names are emitted,
 * by both projections, from one constant.
 *
 * WHAT EACH TEST KILLS:
 *  - the agreement arm dies the day the two projections diverge again by ANY
 *    name, because it compares the two sets rather than two literals.
 *  - the per-name arms die if either spelling is dropped — which is what a
 *    "one spelling" fix would do.
 *  - the `semanticId` arm dies if the id stops tracking the name, which is the
 *    other half `permission-dsl` matches on.
 *  - the untouched-kinds arms are the POSITIVE CONTROLS: without them, "both
 *    names appear" is equally satisfied by a projection that emits them for
 *    everything, including a shell command.
 */
import { describe, expect, it } from 'bun:test';
import { codexApprovalRuleRequests, codexFileChangePaths } from '../codex-agent.ts';

const CWD = '/tmp/p6644-project';
const PATCH = { fileChanges: { [`${CWD}/src/a.ts`]: {}, [`${CWD}/src/b.ts`]: {} } };

describe('P6.644 · the rule projection carries BOTH names for a file change', () => {
  it('emits one request per path per name', () => {
    const requests = codexApprovalRuleRequests('fileChangeV1', PATCH, CWD);
    expect(requests).toHaveLength(4);
    const byPath = new Map<string, string[]>();
    for (const request of requests) {
      const path = String((request.input as { file_path?: unknown }).file_path);
      byPath.set(path, [...(byPath.get(path) ?? []), request.toolName]);
    }
    expect([...byPath.keys()].sort()).toEqual([`${CWD}/src/a.ts`, `${CWD}/src/b.ts`]);
    for (const names of byPath.values()) expect([...names].sort()).toEqual(['Edit', 'Write']);
  });

  it('keeps `semanticId` tracking the name — the other half the DSL matches on', () => {
    const requests = codexApprovalRuleRequests('fileChangeV1', { fileChanges: { '/w/a.ts': {} } }, CWD);
    expect(requests.map(request => [request.toolName, request.semanticId]).sort())
      .toEqual([['Edit', 'edit'], ['Write', 'write']]);
  });

  it('carries the cwd onto every request, not just the first', () => {
    for (const request of codexApprovalRuleRequests('fileChangeV1', PATCH, CWD)) {
      expect(request.cwd).toBe(CWD);
    }
  });

  it('POSITIVE CONTROL — a shell command still projects Bash and nothing else', () => {
    const requests = codexApprovalRuleRequests('command', { command: 'git status', cwd: CWD }, CWD);
    expect(requests.map(request => request.toolName)).toEqual(['Bash']);
  });

  it('POSITIVE CONTROL — a v2 file change still names no path, so it projects nothing', () => {
    // `fileChange` (v2) carries `{threadId, turnId, itemId, startedAtMs, …}` and
    // no path at all; only the v1 `applyPatchApproval` names its files.
    expect(codexApprovalRuleRequests('fileChange', { itemId: 'i' }, CWD)).toEqual([]);
  });

  it('an empty or whitespace path is still dropped, once rather than twice', () => {
    expect(codexApprovalRuleRequests('fileChangeV1', { fileChanges: { '   ': {} } }, CWD)).toEqual([]);
  });
});

describe('P6.644 · the two projections agree, by construction', () => {
  it('both read the same constant, so neither can drift to one name again', async () => {
    const source = await import('node:fs').then(fs => fs.readFileSync(
      new URL('../codex-agent.ts', import.meta.url), 'utf8',
    ));
    // The constant exists and both projections use it. Compared as call sites
    // rather than as literals: a future third projection that hard-codes a name
    // is what this is meant to catch.
    expect(source).toContain("const CODEX_FILE_CHANGE_TOOL_NAMES = ['Write', 'Edit'] as const;");
    expect(source.split('CODEX_FILE_CHANGE_TOOL_NAMES').length - 1).toBeGreaterThanOrEqual(3);
    // And no bare spelling survives in either fileChangeV1 branch.
    expect(source).not.toContain("toolName: 'Edit',");
    expect(source).not.toContain("toolName: 'Write', input: { file_path: filePath }");
  });
});

/**
 * C3.67 · the CHECKPOINT projection of the same item, which is a different
 * question from the approval one above and must not be confused with it.
 *
 * The approval projection answers *"which of the user's rules judge this?"* and
 * therefore emits both host spellings per path. This one answers *"which bytes
 * do we have to snapshot before codex writes?"* and therefore emits paths only,
 * absolute, deduplicated — one checkpoint per file, whatever the rules say.
 *
 * WHAT EACH TEST KILLS:
 *  - the absolute arm dies if the extraction starts dropping codex's own paths.
 *  - the relative arm dies if the resolution against the session cwd is removed:
 *    `createFileCheckpoint` throws on a relative authorized target and returns
 *    nothing for an unresolvable one, so a dropped path is a SILENT
 *    non-checkpoint — the exact defect the producer record exists for.
 *  - the negative arms are the controls: a non-`fileChange` item, a change with
 *    no readable path, and a relative path with no cwd to resolve against must
 *    all yield nothing rather than a guess.
 */
describe('C3.67 · the paths a codex fileChange item is about to write', () => {
  it('returns codex\'s own absolute paths, deduplicated, in wire order', () => {
    const item = {
      type: 'fileChange',
      id: 'call_1',
      changes: [
        { path: `${CWD}/src/a.ts`, kind: { type: 'update' }, diff: '' },
        { path: `${CWD}/src/b.ts`, kind: { type: 'add' }, diff: '' },
        { path: `${CWD}/src/a.ts`, kind: { type: 'update' }, diff: '' },
      ],
    };
    expect(codexFileChangePaths(item, CWD)).toEqual([`${CWD}/src/a.ts`, `${CWD}/src/b.ts`]);
  });

  it('resolves a relative path against the session working directory', () => {
    const item = { type: 'fileChange', id: 'call_2', changes: [{ path: 'src/c.ts' }] };
    expect(codexFileChangePaths(item, CWD)).toEqual([`${CWD}/src/c.ts`]);
  });

  it('NEGATIVE CONTROLS — nothing to snapshot is nothing, never a guess', () => {
    expect(codexFileChangePaths({ type: 'commandExecution', id: 'c', command: 'ls' }, CWD)).toEqual([]);
    expect(codexFileChangePaths({ type: 'fileChange', id: 'c', changes: [{ path: '  ' }] }, CWD)).toEqual([]);
    expect(codexFileChangePaths({ type: 'fileChange', id: 'c', changes: [{ path: 'src/c.ts' }] }, undefined)).toEqual([]);
    expect(codexFileChangePaths(undefined, CWD)).toEqual([]);
  });
});
