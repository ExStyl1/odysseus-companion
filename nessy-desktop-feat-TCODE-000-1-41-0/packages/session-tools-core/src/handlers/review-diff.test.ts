/**
 * P3.276 · `ReviewDiff` — one host-computed diff, offered on claude and codex.
 *
 * The row: the delegated reviewer has no host-computed diff outside Pi's review
 * tool, so on the other two runtimes it reviews whatever diff the model chose
 * to run for itself. What matters here is not the happy path but the three
 * things a thin dispatcher gets wrong: an unbound port, a thrown port, and an
 * EMPTY diff — which is a real answer and not a failure.
 */
import { describe, expect, it } from 'bun:test';
import { handleReviewDiff } from './review-diff.ts';
import { getSessionSafeAllowedToolNames, getSessionToolDefs, getSessionToolNames, getToolDefsAsJsonSchema } from '../tool-defs.ts';
import type { SessionToolContext, SessionReviewDiffAnswer, SessionReviewDiffRequest } from '../context.ts';

function answer(overrides: Partial<SessionReviewDiffAnswer> = {}): SessionReviewDiffAnswer {
  return {
    target: "this branch's commits ahead of its upstream plus any uncommitted changes",
    diff: 'diff --git a/x b/x\n+one line\n',
    task: 'Review the following changes.\n\nDiff under review:\n```diff\n+one line\n```',
    rubric: 'RUBRIC: report correctness bugs first.',
    reviewerAgent: 'reviewer',
    ...overrides,
  };
}

function context(port?: SessionToolContext['reviewDiff']): SessionToolContext {
  return { ...(port ? { reviewDiff: port } : {}) } as SessionToolContext;
}

const textOf = (result: { content: { text: string }[] }): string =>
  result.content.map(part => part.text).join('\n');

describe('P3.276 · ReviewDiff', () => {
  it('passes the five target keys through verbatim and drops everything else', async () => {
    // The host normalizer is the SINGLE normalizer: pre-normalizing here would
    // be the second spelling this row exists to remove. What this asserts is
    // that the keys arrive unchanged and that a stray key does not.
    let seen: SessionReviewDiffRequest | undefined;
    const ctx = context({ compute: async request => { seen = request; return answer(); } });

    await handleReviewDiff(ctx, {
      base: '  main  ',
      range: 'a...b',
      commit: 'abc123',
      paths: ['src/a.ts', '   ', 'src/b.ts'],
      scope: 'uncommitted',
      instructions: 'focus on the parser',
      subagent_type: 'something-else',
    });

    expect(seen).toEqual({
      base: 'main',
      range: 'a...b',
      commit: 'abc123',
      paths: ['src/a.ts', 'src/b.ts'],
      scope: 'uncommitted',
      instructions: 'focus on the parser',
    });
  });

  it('hands back the rubric AND the task, naming the agent to delegate to', async () => {
    // This is the substitution Pi does per call as `reviewerDefWithRubric`.
    // claude cannot swap a subagent's system prompt — `AgentDefinition.prompt`
    // is a construction-time field with no per-call override — so the rubric
    // has to ride the task, and the reply must carry both or the reviewer runs
    // with the generic prompt.
    const ctx = context({ compute: async () => answer() });

    const text = textOf(await handleReviewDiff(ctx, {}) as never);
    expect(text).toContain('RUBRIC: report correctness bugs first.');
    expect(text).toContain('Diff under review:');
    expect(text).toContain('reviewer');
  });

  it('reports an EMPTY diff as an answer, not an error', async () => {
    // An empty diff means the target has no changes. Calling that an error
    // pushes the model into inventing a second target, which is the scope drift
    // the row is about.
    const ctx = context({ compute: async () => answer({ diff: '   \n' }) });

    const result = await handleReviewDiff(ctx, {});
    expect(result.isError).toBe(false);
    expect(textOf(result as never)).toContain('No changes to review for');
  });

  it('says what is missing when no host port is bound', async () => {
    const result = await handleReviewDiff(context(), {});

    expect(result.isError).toBe(true);
    // Named, not vague: a model told which service is absent can fall back to
    // reading the change itself instead of reporting an empty review.
    expect(textOf(result as never)).toContain('no host diff service is bound');
  });

  it('turns a thrown port into a refusal that carries the reason', async () => {
    const ctx = context({ compute: async () => { throw new Error('not a git repository'); } });

    const result = await handleReviewDiff(ctx, {});
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toContain('not a git repository');
  });
});

describe('P3.276 · ReviewDiff is offered only where it can answer', () => {
  const claude = (reviewDiffPort = false) => getSessionToolNames({ reviewDiffPort });
  const pi = (reviewDiffPort = false) => getSessionToolNames({ projection: 'pi', reviewDiffPort });
  const codex = (reviewDiffPort = false) => getSessionToolNames({
    externalStandaloneOnly: true,
    hostCallbackBridge: true,
    reviewDiffPort,
  });

  it('stays in the DEFINITIONS, so plan can classify it and dispatch can reach it', () => {
    // P3.276 residue. The port gate lived inside `getSessionToolDefs` for one
    // commit, and that function also feeds `getSessionSafeAllowedToolNames` —
    // which `mode-manager.ts` calls WITHOUT any per-session host binding,
    // because it has none. `ReviewDiff` was therefore missing from the Explore
    // allow set on every runtime, including the two it was added for, and a
    // session that HAD been offered it was refused with "Session configuration
    // changes are blocked in Explore": false twice over for a read-only diff.
    expect(getSessionToolDefs().some(def => def.name === 'ReviewDiff')).toBe(true);
    expect(getSessionSafeAllowedToolNames({ prefix: 'mcp__session__' }).has('mcp__session__ReviewDiff'))
      .toBe(true);
    // Its own classification is what decides that, and nothing else: a
    // `safeMode: 'block'` sibling is still blocked.
    expect(getSessionSafeAllowedToolNames({ prefix: 'mcp__session__' }).has('mcp__session__source_manage'))
      .toBe(false);
  });

  it('is absent from every surface until a host binds the port', () => {
    // A tool advertised without its port can only answer "not available in
    // this context" — the exact dishonesty P3.222 measured for the roster pair.
    // The flag therefore gates the OFFER, not the answer.
    expect(claude().has('ReviewDiff')).toBe(false);
    expect(pi().has('ReviewDiff')).toBe(false);
    expect(codex().has('ReviewDiff')).toBe(false);
    // Positive control on the same rig: the filter still returns a surface.
    expect(claude().size).toBeGreaterThan(0);
  });

  it('appears on claude and on a bridged codex once the port is bound', () => {
    expect(claude(true).has('ReviewDiff')).toBe(true);
    expect(codex(true).has('ReviewDiff')).toBe(true);
  });

  it('never appears on Pi, whose own review tool does strictly more', () => {
    // Pi's `review` computes the same diff AND spawns the reviewer in one call.
    // Two tools for one job in front of one model is how the weaker one gets
    // picked, which is why the visibility is `not-pi` rather than a flag.
    expect(pi(true).has('ReviewDiff')).toBe(false);
    expect(pi(true).has('review')).toBe(false); // `review` is a Pi ORCHESTRATOR tool, not a session tool
  });

  it('is withheld from an UNBRIDGED external subprocess even with the port flag', () => {
    // The port is a host callback like `cronPort`; a standalone subprocess with
    // no bridge has nothing to resolve it against.
    expect(getSessionToolNames({ externalStandaloneOnly: true, reviewDiffPort: true }).has('ReviewDiff'))
      .toBe(false);
  });
});

/**
 * C3.289 — the two halves C4.13 left in this package, plus the schema line that
 * makes them reachable.
 *
 * The host half shipped with C4.13: codex's own `review/start` with
 * `delivery: "detached"` runs the review on a thread of its own, and the bridge
 * route reports it back as `backgroundReview`. Nothing here read the flag or the
 * answer, so the arm was reachable only by a caller that set the field itself.
 */
describe('C3.289 · ReviewDiff — the background flag', () => {
  it('C4.42 · narrows both BOOLEANS through, and nothing else', async () => {
    // This arm read "narrows only a literal true through to the host" and
    // expected `[true, undefined, undefined, undefined]`. C4.42 (owner
    // 2026-09-13) flipped codex's default to detached — the bridge predicate is
    // `background !== false` — so an explicit `false` that stops here would make
    // `code-review.md#run-in-the-foreground`'s foreground case UNREACHABLE.
    // Forwarding it is the half that keeps the row a parity fix instead of a
    // removed escape.
    //
    // The C4.13 narrowing is intact and is what the third and fourth cases pin:
    // a truthy STRING is not a boolean and passes nothing, so the host sink's
    // spread still cannot be talked into a thread by a non-boolean.
    const seen: SessionReviewDiffRequest[] = [];
    const ctx = context({ compute: async request => { seen.push(request); return answer(); } });

    await handleReviewDiff(ctx, { background: true });
    await handleReviewDiff(ctx, { background: false });
    await handleReviewDiff(ctx, { background: 'yes' });
    await handleReviewDiff(ctx, { background: 0 });
    await handleReviewDiff(ctx, {});

    expect(seen.map(request => request.background)).toEqual([true, false, undefined, undefined, undefined]);
  });

  it('hands back the started review INSTEAD of the delegate-this template', async () => {
    // A review already running on its own thread must not be delegated a second
    // time, which is why this replaces the template rather than riding beside it.
    const ctx = context({
      compute: async () => answer({ backgroundReview: 'Review 42 is running in the background.' }),
    });

    const result = await handleReviewDiff(ctx, { background: true });
    expect(result.isError).toBe(false);
    const text = textOf(result as never);
    expect(text).toBe('Review 42 is running in the background.');
    expect(text).not.toContain('Delegate this to the');
  });

  it('is byte-identical to the inline answer when the host started nothing', async () => {
    // NEGATIVE. Every fallback the host has — an older app-server, a refusal, an
    // inline delivery — arrives here as an absent field, and must cost the user
    // nothing.
    const asked = textOf(await handleReviewDiff(
      context({ compute: async () => answer() }),
      { background: true },
    ) as never);
    const plain = textOf(await handleReviewDiff(
      context({ compute: async () => answer() }),
      {},
    ) as never);

    expect(asked).toBe(plain);
    expect(asked).toContain('Delegate this to the reviewer agent');
    // An empty string is not a started review either.
    expect(textOf(await handleReviewDiff(
      context({ compute: async () => answer({ backgroundReview: '' }) }),
      { background: true },
    ) as never)).toBe(plain);
  });

  it('is DESCRIBABLE: the emitted schema carries the field a model must send', () => {
    // P6.619's defect verbatim — a field with a reader and no schema that no
    // model could ever send. Asserted on the EMITTED JSON Schema, because that
    // is the only document a model and a strict-schema provider see.
    // `reviewDiffPort` because this emitter also applies the OFFER gate: without
    // a bound port the tool is in no emitted list at all, and a `find` that
    // returns undefined would make this assertion pass for the wrong reason.
    const emitted = getToolDefsAsJsonSchema({ reviewDiffPort: true }).find(def => def.name === 'ReviewDiff');
    expect(emitted).toBeDefined();
    const properties = (emitted?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    expect(properties?.scope).toBeDefined();
    expect(properties?.background).toBeDefined();
    // Negative control on the same read: a field nobody declared is absent.
    expect(properties?.zzzNoSuchReviewField).toBeUndefined();
  });
});
