import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createReviewTool, normalizeReviewRequest } from './review-tool.ts';
// P3.276 — the diff itself is no longer Pi-private. Imported from where it now
// lives so this suite keeps proving the SHARED computation, not a copy of it.
import { computeReviewDiffWithGit } from '../../../shared/src/prompts/review-diff.ts';
import { parseSchemaResult } from './subagent-tool.ts';
import type { ChildSessionResult, SpawnChildSessionArgs } from './spawner.ts';
import { REVIEW_FINDINGS_SCHEMA, REVIEW_RUBRIC_PROMPT, type ReviewResult } from '../../../shared/src/prompts/review.ts';

const VALID_RESULT: ReviewResult = {
  findings: [
    { title: 'Guard against nulls', body: 'Body A cites `a.ts:2`.', priority: 2, confidence: 0.6, file: 'a.ts', line: 2, category: 'correctness' },
    { title: 'Fix off-by-one loop bound', body: 'Body B cites `a.ts:5`.', priority: 0, confidence: 0.95, file: 'a.ts', line: 5, category: 'correctness' },
  ],
  verdict: 'patch is incorrect',
  explanation: 'Introduces an out-of-bounds read.',
};

function spawnReturning(text: string, overrides: Partial<ChildSessionResult> = {}) {
  const calls: SpawnChildSessionArgs[] = [];
  const spawn = async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
    calls.push(args);
    return { agent: args.agentDef.name, status: 'done', text, tokensIn: 1, tokensOut: 1, ...overrides };
  };
  return { calls, spawn };
}

describe('review findings schema', () => {
  it('validates a well-formed result via the existing structured-output mechanism', () => {
    expect(parseSchemaResult(JSON.stringify(VALID_RESULT), REVIEW_FINDINGS_SCHEMA)).toBeNull();
  });

  it('rejects malformed results (bad JSON, missing required, wrong top-level types)', () => {
    // Not JSON.
    expect(parseSchemaResult('{ nope', REVIEW_FINDINGS_SCHEMA)).toContain('not valid JSON');
    // Missing required top-level fields (draft-07 engine wording, R18).
    const missing = parseSchemaResult(JSON.stringify({ findings: [] }), REVIEW_FINDINGS_SCHEMA);
    expect(missing).toContain("must have required property 'verdict'");
    expect(missing).toContain("must have required property 'explanation'");
    // Wrong top-level type: findings must be an array.
    const badShape = { findings: {}, verdict: 'patch is correct', explanation: 'ok' };
    expect(parseSchemaResult(JSON.stringify(badShape), REVIEW_FINDINGS_SCHEMA)).toContain('/findings must be array');
  });

  /**
   * `code-review.md:281` — the local review "reports correctness bugs and reuse,
   * simplification, and efficiency cleanups", and `:315` renders "a category tag
   * such as `correctness`". Category is what separates the two, so it is
   * required, and an invented slug must not pass.
   */
  it('requires a category on every finding and admits only the documented slugs', () => {
    const withoutCategory = {
      ...VALID_RESULT,
      findings: [{ ...VALID_RESULT.findings[0]!, category: undefined }],
    };
    expect(parseSchemaResult(JSON.stringify(withoutCategory), REVIEW_FINDINGS_SCHEMA))
      .toContain("must have required property 'category'");

    for (const category of ['correctness', 'reuse', 'simplification', 'efficiency', 'test-coverage']) {
      const cleanup = { ...VALID_RESULT, findings: [{ ...VALID_RESULT.findings[0]!, category }] };
      expect(parseSchemaResult(JSON.stringify(cleanup), REVIEW_FINDINGS_SCHEMA)).toBeNull();
    }

    const invented = { ...VALID_RESULT, findings: [{ ...VALID_RESULT.findings[0]!, category: 'style' }] };
    expect(parseSchemaResult(JSON.stringify(invented), REVIEW_FINDINGS_SCHEMA)).toContain('category');
  });

  it('the rubric admits cleanups and keeps them out of the verdict', () => {
    expect(REVIEW_RUBRIC_PROMPT).toContain('## Cleanups');
    for (const category of ['reuse', 'simplification', 'efficiency']) {
      expect(REVIEW_RUBRIC_PROMPT).toContain(`\`${category}\``);
    }
    // A cleanup is not a bug: it must not flip the verdict.
    expect(REVIEW_RUBRIC_PROMPT).toContain('only findings are cleanups still returns "patch is correct"');
  });
});

describe('review tool', () => {
  /**
   * `code-review.md:293` — "It reviews your branch's commits ahead of its
   * upstream plus any uncommitted changes … To review something else, pass a
   * target: a file path, a PR number, a branch name, or a ref range such as
   * `main...my-feature`."
   */
  it('normalizes the documented targets: upstream default, branch, range, paths, commit', () => {
    expect(normalizeReviewRequest({})).toEqual({ mode: 'upstream' });
    expect(normalizeReviewRequest({ scope: 'uncommitted' })).toEqual({ mode: 'uncommitted' });
    expect(normalizeReviewRequest({ base: 'main' })).toEqual({ mode: 'base', ref: 'main' });
    expect(normalizeReviewRequest({ commit: 'abc123' })).toEqual({ mode: 'commit', ref: 'abc123' });
    expect(normalizeReviewRequest({ range: 'main...my-feature' }))
      .toEqual({ mode: 'range', ref: 'main...my-feature' });
    expect(normalizeReviewRequest({ range: 'main..my-feature' }))
      .toEqual({ mode: 'range', ref: 'main..my-feature' });
    expect(normalizeReviewRequest({ paths: ['src/a.ts', 'src/b.ts'] }))
      .toEqual({ mode: 'paths', paths: ['src/a.ts', 'src/b.ts'] });
    // A single path may arrive as a bare string.
    expect(normalizeReviewRequest({ paths: 'src/a.ts' })).toEqual({ mode: 'paths', paths: ['src/a.ts'] });
    // Per-run effort rides along with any target.
    expect(normalizeReviewRequest({ effort: 'high' })).toEqual({ mode: 'upstream', effort: 'high' });
  });

  it('refuses conflicting or malformed targets rather than picking one', () => {
    expect(() => normalizeReviewRequest({ base: 'main', commit: 'abc123' })).toThrow('at most one target');
    expect(() => normalizeReviewRequest({ range: 'a...b', paths: ['x.ts'] })).toThrow('at most one target');
    // `scope` chooses between the two no-target diffs, so it cannot carry one.
    expect(() => normalizeReviewRequest({ scope: 'upstream', base: 'main' })).toThrow('only without a target');
    expect(() => normalizeReviewRequest({ scope: 'everything' })).toThrow('must be "upstream" or "uncommitted"');
    // A branch name is not a range: a lone ref must not be read as one.
    expect(() => normalizeReviewRequest({ range: 'main' })).toThrow('main...my-feature');
    expect(() => normalizeReviewRequest({ range: 'main...' })).toThrow('main...my-feature');
    expect(() => normalizeReviewRequest({ effort: 'maximum' })).toThrow('effort level');
    expect(() => normalizeReviewRequest('nope')).toThrow('must be an object');
  });

  /**
   * `assertSafeRef` is the argument-injection seatbelt. Every new mode routes
   * through it, so a ref or path that could smuggle a git option is refused
   * before git ever runs.
   */
  it('keeps the ref seatbelt on every new target mode', async () => {
    for (const request of [
      { mode: 'range' as const, ref: '--output=/tmp/pwn' },
      { mode: 'paths' as const, paths: ['ok.ts', '--upload-pack=touch /tmp/pwn'] },
    ]) {
      await expect(computeReviewDiffWithGit(request as any, '/tmp/ws')).rejects.toThrow('invalid git ref');
    }
  });

  /**
   * The default scope is the behaviour change, so it is measured against real
   * git rather than a stub: a commit that is ahead of the upstream AND an
   * uncommitted edit must BOTH appear, where the old `uncommitted` default saw
   * only the second. The no-upstream case is the positive control's negative
   * half — the commit disappears, the working tree does not.
   */
  it('the default scope is commits ahead of upstream plus the working tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'review-upstream-'));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    try {
      const origin = join(root, 'origin.git');
      const work = join(root, 'work');
      git(root, 'init', '--bare', '--initial-branch=main', origin);
      git(root, 'clone', origin, work);
      git(work, 'config', 'user.email', 'r@example.com');
      git(work, 'config', 'user.name', 'Reviewer');
      writeFileSync(join(work, 'base.ts'), 'export const base = 1;\n');
      git(work, 'add', '.');
      git(work, 'commit', '-m', 'base');
      git(work, 'push', '-u', 'origin', 'main');

      // One commit ahead of the upstream, plus one uncommitted edit.
      writeFileSync(join(work, 'ahead.ts'), 'export const ahead = 2;\n');
      git(work, 'add', '.');
      git(work, 'commit', '-m', 'ahead');
      writeFileSync(join(work, 'base.ts'), 'export const base = 99;\n');

      const upstream = await computeReviewDiffWithGit({ mode: 'upstream' }, work);
      expect(upstream).toContain('ahead.ts');
      expect(upstream).toContain('base = 99');
      // The old default is still addressable and still sees only the tree.
      const uncommitted = await computeReviewDiffWithGit({ mode: 'uncommitted' }, work);
      expect(uncommitted).not.toContain('ahead.ts');
      expect(uncommitted).toContain('base = 99');
      // A path target narrows to those files.
      const paths = await computeReviewDiffWithGit({ mode: 'paths', paths: ['base.ts'] }, work);
      expect(paths).toContain('base = 99');
      expect(paths).not.toContain('ahead.ts');

      // No upstream: the ahead-half is empty, the working tree still reviews.
      git(work, 'checkout', '-b', 'detached-feature');
      const orphan = await computeReviewDiffWithGit({ mode: 'upstream' }, work);
      expect(orphan).not.toContain('ahead.ts');
      expect(orphan).toContain('base = 99');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('spawns the reviewer def with read-only restrictions and the rubric as its prompt', async () => {
    const { calls, spawn } = spawnReturning(JSON.stringify(VALID_RESULT));
    const tool = createReviewTool({ getCwd: () => '/tmp/ws', spawn, computeDiff: async () => 'diff --git a/a.ts b/a.ts\n+bug' });

    await tool.execute('r1', {}, undefined);

    expect(calls).toHaveLength(1);
    const def = calls[0]!.agentDef;
    expect(def.name).toBe('reviewer');
    // Read-only child: reviewer toolset and tools are read-only, no shell.
    expect(def.toolset).toBe('read-only');
    expect(def.tools).toEqual(['read', 'grep', 'find', 'ls']);
    expect(def.tools).not.toContain('bash');
    // The rubric is the child's system prompt.
    expect(def.systemPrompt).toBe(REVIEW_RUBRIC_PROMPT);
    // No background-task channel is wired on this tool, and the caller did not
    // ask for one, so P6.798's default falls back to the page's own foreground
    // case and the findings return in the same tool result.
    expect(calls[0]!.background).toBe(false);
    // The host-computed diff is embedded in the task; the child does not gather it.
    expect(calls[0]!.task).toContain('diff --git a/a.ts');
  });

  it('parses fixture findings and renders them most-severe-first in the parent result', async () => {
    const { spawn } = spawnReturning(JSON.stringify(VALID_RESULT));
    const tool = createReviewTool({ getCwd: () => '/tmp/ws', spawn, computeDiff: async () => 'some diff' });

    const result = await tool.execute('r2', { base: 'main' }, undefined);

    // Findings sorted P0 before P2.
    expect(result.details?.findings?.map(f => f.priority)).toEqual([0, 2]);
    expect(result.details?.verdict).toBe('patch is incorrect');
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text.indexOf('[P0]')).toBeLessThan(text.indexOf('[P2]'));
    // `code-review.md:315` places the category next to the file location.
    expect(text).toContain('a.ts:5 [correctness]');
    expect(result.details?.isError).toBeUndefined();
  });

  it('forwards a per-run effort level to the reviewer child', async () => {
    const { calls, spawn } = spawnReturning(JSON.stringify(VALID_RESULT));
    const tool = createReviewTool({ getCwd: () => '/tmp/ws', spawn, computeDiff: async () => 'some diff' });

    await tool.execute('r5', { effort: 'high' }, undefined);
    expect(calls[0]!.effort).toBe('high');

    // Omitted, the spawner inherits the session's level — `code-review.md:327`'s
    // never-typed fallback — so nothing is pinned here.
    await tool.execute('r6', {}, undefined);
    expect(calls[1]!.effort).toBeUndefined();
  });

  it('rejects a malformed result after a retry', async () => {
    let attempts = 0;
    const spawn = async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
      attempts += 1;
      return { agent: args.agentDef.name, status: 'done', text: '{ not json', tokensIn: 0, tokensOut: 0 };
    };
    const tool = createReviewTool({ getCwd: () => '/tmp/ws', spawn, computeDiff: async () => 'diff' });

    const result = await tool.execute('r3', {}, undefined);
    expect(attempts).toBe(2);
    expect(result.details?.isError).toBe(true);
    expect(result.details?.error).toContain('did not match the findings schema');
  });

  it('short-circuits when there is no diff to review', async () => {
    const { calls, spawn } = spawnReturning(JSON.stringify(VALID_RESULT));
    const tool = createReviewTool({ getCwd: () => '/tmp/ws', spawn, computeDiff: async () => '   ' });

    const result = await tool.execute('r4', {}, undefined);
    expect(calls).toHaveLength(0);
    expect(result.details?.verdict).toBe('patch is correct');
    expect(result.details?.findings).toEqual([]);
  });
});

/**
 * P6.308 (Pi arm) — `/code-review` can hand the composer back.
 *
 * The row's premise was corrected twice before this landed, and the second
 * correction is made here: W7-q's hand-off says the composer is freed in
 * `spawner.ts` by returning the admitted id instead of awaiting the monitor.
 * It is freed at the TOOL instead, the way `subagent-tool.ts` already frees it
 * — the whole run is detached through `registerBackgroundChildTask` and the
 * ADMISSION is raced against it — and the spawner is untouched. Its await of
 * `monitorWithAbort` is what makes the detached run deliver a COMPLETED result
 * to the notification path, so removing it would have been the weaker design.
 *
 * The cases below pin the three things that can silently go wrong:
 * the default must not move; a detached run must not claim a start it did not
 * observe (P2.114/P2.115, one door along); and the flag must be refused by name
 * rather than ignored where the channel is absent.
 */
describe('P6.308 — the review can be detached, and says so honestly', () => {
  type Emitted = { type: string; taskId?: string; status?: string; summary?: string };

  function detachedTool(spawn: (args: SpawnChildSessionArgs) => Promise<ChildSessionResult>) {
    const events: Emitted[] = [];
    const tool = createReviewTool({
      getCwd: () => '/tmp/ws',
      spawn,
      computeDiff: async () => 'some diff',
      makeRunId: () => 'run-bg',
      emitEvent: event => { events.push(event as Emitted); },
    });
    return { tool, events };
  }

  it('P6.798 — with NO flag at all the review now BACKGROUNDS, which is what the page says', async () => {
    // `code-review.md#run-in-the-foreground`: *"The review runs in the
    // background by default."* This case read `background: false` until the
    // owner's 2026-09-10 ruling, when the page's direction became ours.
    let release: ((value: ChildSessionResult) => void) | undefined;
    const calls: SpawnChildSessionArgs[] = [];
    const spawn = (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
      calls.push(args);
      args.onAdmitted?.('agent-bg-default');
      return new Promise<ChildSessionResult>(resolve => { release = resolve; });
    };
    const { tool, events } = detachedTool(spawn);

    const result = await tool.execute('bg0', {}, undefined);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('task_id: task-run-bg');
    expect(calls[0]!.background).toBe(true);
    expect(calls[0]!.backgroundTaskId).toBe('task-run-bg');
    expect(events[0]).toMatchObject({ type: 'task_backgrounded', taskId: 'task-run-bg' });
    release!({ agent: 'reviewer', status: 'done', text: JSON.stringify(VALID_RESULT), tokensIn: 1, tokensOut: 1 });
  });

  it('CONTROL — `background: false` is the page\'s own escape and still runs in the foreground', async () => {
    // The switch P6.798 kept. The page names three cases where the review "runs
    // in the foreground instead", so this is a documented state rather than a
    // hold-out, and it is the only way a caller gets the findings in the result.
    const { calls, spawn } = spawnReturning(JSON.stringify(VALID_RESULT));
    const { tool, events } = detachedTool(spawn);

    const result = await tool.execute('bg0', { background: false }, undefined);
    expect(result.details?.verdict).toBe('patch is incorrect');
    expect(calls[0]!.background).toBe(false);
    expect(calls[0]!.backgroundTaskId).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('CONTROL — an UNSET flag with no channel wired falls back to the foreground, never a refusal', async () => {
    // The caller did not ask for the background, so refusing would take the
    // review away rather than move it. An explicit `true` in the same session
    // still refuses by name — the case below.
    const { calls, spawn } = spawnReturning(JSON.stringify(VALID_RESULT));
    const tool = createReviewTool({ getCwd: () => '/tmp/ws', spawn, computeDiff: async () => 'some diff' });

    const result = await tool.execute('bg0b', {}, undefined);
    expect(result.details?.isError).toBeFalsy();
    expect(result.details?.verdict).toBe('patch is incorrect');
    expect(calls[0]!.background).toBe(false);
  });

  it('returns immediately with the task id, and the findings arrive on the completion notice', async () => {
    let release: ((value: ChildSessionResult) => void) | undefined;
    const calls: SpawnChildSessionArgs[] = [];
    const spawn = (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => {
      calls.push(args);
      // Admitted, then held open: this is the whole point — the tool must come
      // back while the child is still running.
      args.onAdmitted?.('agent-bg-1');
      return new Promise<ChildSessionResult>(resolve => { release = resolve; });
    };
    const { tool, events } = detachedTool(spawn);

    const result = await tool.execute('bg1', { background: true }, undefined);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('task_id: task-run-bg');
    expect(text).toContain('agent_id: agent-bg-1');
    // Durability and detachment land TOGETHER: the host refuses a background
    // child that carries no `backgroundTaskId`.
    expect(calls[0]!.background).toBe(true);
    expect(calls[0]!.backgroundTaskId).toBe('task-run-bg');
    expect(events[0]).toMatchObject({ type: 'task_backgrounded', taskId: 'task-run-bg' });

    release!({ agent: 'reviewer', status: 'done', text: JSON.stringify(VALID_RESULT), tokensIn: 1, tokensOut: 1 });
    // The completion notice carries the rendered findings — read into a local
    // first, because `toMatchObject` with an asymmetric matcher REWRITES the
    // object it is given (AGENTS.md §Traps).
    for (let i = 0; i < 50 && events.length < 2; i += 1) await new Promise(r => setTimeout(r, 5));
    const completed = events.find(event => event.type === 'task_completed');
    expect(completed?.status).toBe('completed');
    expect(completed?.summary ?? '').toContain('[P0]');
  });

  it('NEGATIVE — a run that admitted NOTHING reports its own reason in this turn, not a start', async () => {
    // Every refusal in `spawner.ts` returns before `onAdmitted` fires, so a
    // finished run with no admission is the signature of a call with nothing
    // running. Claiming "Started" for it is the P2.114 lie.
    const spawn = async (args: SpawnChildSessionArgs): Promise<ChildSessionResult> => ({
      agent: args.agentDef.name, status: 'error', text: '', tokensIn: 0, tokensOut: 0, error: 'subagent budget exhausted',
    });
    const { tool } = detachedTool(spawn);

    const result = await tool.execute('bg2', { background: true }, undefined);
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).not.toContain('Started background review');
    expect(result.details?.isError).toBe(true);
  });

  it('NEGATIVE — with no background-task channel the flag is REFUSED BY NAME, never silently ignored', async () => {
    const { calls, spawn } = spawnReturning(JSON.stringify(VALID_RESULT));
    const tool = createReviewTool({ getCwd: () => '/tmp/ws', spawn, computeDiff: async () => 'some diff' });

    const result = await tool.execute('bg3', { background: true }, undefined);
    expect(result.details?.isError).toBe(true);
    expect(result.details?.error).toContain('cannot run in the background');
    expect(result.details?.error).toContain('background: false');
    // And it did not quietly run it in the foreground instead.
    expect(calls).toHaveLength(0);
  });
});
