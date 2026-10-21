/**
 * P2.458 — the host's `WorktreeCreate` / `WorktreeRemove` hooks.
 *
 * The row is a LIVE leak, not a design option: `hooks.md#worktreecreate` says
 * the event *"Runs when a worktree is being created, whether from `claude
 * --worktree`, from a subagent using `isolation: "worktree"`, or for a
 * background session that Claude Code isolates in its own worktree"*, and the
 * last two are routes this fork does not drive. Registering nothing meant those
 * worktrees were created by the binary's own `git worktree` with no lease, no
 * record and no sweep — P2.427's leak from the other side.
 *
 * Every assertion below is written to kill a specific mutant, named in its own
 * comment. The two that matter most are the ones a "looks obviously right"
 * implementation gets wrong:
 *
 *  - **An absent port must register NOTHING.** A hook that is registered and
 *    returns no path does not degrade — it BREAKS creation. Measured in the
 *    vendored binary, and `hooks.md#exit-code-2-behavior-per-event` agrees:
 *    *"The exception is `WorktreeCreate`, where any non-zero exit code aborts
 *    worktree creation."*
 *  - **A user's own `WorktreeCreate` must win outright.** The binary takes the
 *    FIRST succeeded hook with non-empty output
 *    (`r.filter((o)=>o.succeeded).map((o)=>JPb(o.output)).find((o)=>o.length>0)`),
 *    so two path-returning hooks means one worktree gets created and abandoned —
 *    a new leak on either ordering.
 *
 * NOTHING HERE TOUCHES THE FILESYSTEM. The port is a fake, so no test creates
 * or removes a directory; the paths below are strings that never get resolved.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';

import { bracedRegion } from '../../testing/source-regions.ts';
import { createRequire } from 'node:module';

import type { SdkAutomationCallbackMatcher, SdkAutomationInput } from '../../automations/types.ts';
import {
  screenClaudeWorktreePath,
  withClaudeWorktreeHooks,
} from '../backend/claude/worktree-hooks.ts';
import type { ClaudeWorktreeHookContext } from '../backend/claude/worktree-hooks.ts';
import type {
  ClaudeWorktreeCreateRequest,
  ClaudeWorktreePort,
  ClaudeWorktreeRemoveRequest,
} from '../backend/claude/worktree-port.ts';

/** Same resolution `claude-worktree-path-surface.test.ts` uses, same reason. */
function sdkTypings(): string {
  const require_ = createRequire(import.meta.url);
  const entry = require_.resolve('@anthropic-ai/claude-agent-sdk');
  const path = entry.replace(/sdk\.mjs$/, 'sdk.d.ts');
  if (!existsSync(path)) throw new Error(`sdk.d.ts not found beside ${entry}`);
  return readFileSync(path, 'utf8');
}

interface Recorder {
  created: ClaudeWorktreeCreateRequest[];
  removed: ClaudeWorktreeRemoveRequest[];
  debug: string[];
}

function fakePort(
  create: ClaudeWorktreePort['create'],
  remove?: ClaudeWorktreePort['remove'],
): { port: ClaudeWorktreePort; log: Recorder } {
  const log: Recorder = { created: [], removed: [], debug: [] };
  return {
    log,
    port: {
      create: request => { log.created.push(request); return create(request); },
      remove: request => { log.removed.push(request); return remove?.(request); },
    },
  };
}

async function fire(
  matchers: SdkAutomationCallbackMatcher[] | undefined,
  input: Record<string, unknown>,
): Promise<Awaited<ReturnType<SdkAutomationCallbackMatcher['hooks'][number]>>[]> {
  const results = [];
  for (const matcher of matchers ?? []) {
    for (const hook of matcher.hooks) {
      results.push(await hook(input as unknown as SdkAutomationInput, 'tool-use-id', {}));
    }
  }
  return results;
}

const EMPTY: Record<string, SdkAutomationCallbackMatcher[]> = {};

describe('P2.458 · the absent-port state is byte-identical to before the row', () => {
  /**
   * KILLS: registering the hook unconditionally. That is the mutant that turns
   * a working `git worktree` into "WorktreeCreate hook failed: hook succeeded
   * but returned no worktree path" on every subagent that isolates itself.
   */
  test('no port registers neither event', () => {
    const before = { PreToolUse: [{ hooks: [] }] };
    const after = withClaudeWorktreeHooks(before, undefined);
    expect(after).toBe(before);
    expect(Object.keys(after)).toEqual(['PreToolUse']);
  });

  /** KILLS: mutating the caller's map in place instead of copying it. */
  test('a present port does not mutate the input map', () => {
    const before: Record<string, SdkAutomationCallbackMatcher[]> = { PreToolUse: [{ hooks: [] }] };
    const { port } = fakePort(() => ({ worktreePath: '/repo/.worktrees/a' }));
    const after = withClaudeWorktreeHooks(before, port);
    expect(Object.keys(before)).toEqual(['PreToolUse']);
    expect(Object.keys(after).sort()).toEqual(['PreToolUse', 'WorktreeCreate', 'WorktreeRemove']);
  });
});

describe('P2.458 · the path travels back on the callback route', () => {
  /**
   * KILLS: returning the path anywhere the binary does not read it — a bare
   * `{ worktreePath }`, a `systemMessage`, or a `hookSpecificOutput` whose
   * `hookEventName` is wrong. The measured branch is gated on that name
   * (`L.hookSpecificOutput?.hookEventName==="WorktreeCreate"`) and falls
   * through to `systemMessage||""` without it, which reads as no path at all.
   */
  test('WorktreeCreate answers with hookSpecificOutput.worktreePath', async () => {
    const { port, log } = fakePort(() => ({ worktreePath: '/repo/.worktrees/bold-oak-a3f2' }));
    const hooks = withClaudeWorktreeHooks(EMPTY, port, { sessionId: 'sess-1' });
    const [result] = await fire(hooks.WorktreeCreate, {
      hook_event_name: 'WorktreeCreate',
      name: 'bold-oak-a3f2',
      cwd: '/repo',
    });
    // Compared SERIALIZED, and not to dodge a type error: `worktreePath` is not
    // on the shared mirror's callback-result type (it lives on the host-side
    // `PreToolUseDecision`), and what actually reaches the subprocess is the
    // JSON of this object. So the assertion is made against the same bytes the
    // control channel carries.
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      continue: true,
      hookSpecificOutput: { hookEventName: 'WorktreeCreate', worktreePath: '/repo/.worktrees/bold-oak-a3f2' },
    });
    // The lease has to be nameable and scopable, or the sweep that closes
    // P2.427 has nothing to act on.
    expect(log.created).toEqual([{ name: 'bold-oak-a3f2', sessionId: 'sess-1', cwd: '/repo' }]);
  });

  /**
   * KILLS: passing the whole hook input, or a hard-coded session id. `sessionId`
   * absent must not appear as `undefined` — the host's other ports read
   * absence, and `{ sessionId: undefined }` is not absence to a `in`-style
   * check.
   */
  test('an unknown session and cwd are omitted rather than sent as undefined', async () => {
    const { port, log } = fakePort(() => ({ worktreePath: '/repo/wt' }));
    const hooks = withClaudeWorktreeHooks(EMPTY, port);
    await fire(hooks.WorktreeCreate, { hook_event_name: 'WorktreeCreate', name: 'n' });
    expect(Object.keys(log.created[0]!)).toEqual(['name']);
  });

  /** KILLS: dropping `worktree_path` on the way to the port. */
  test('WorktreeRemove hands the path back to the port', async () => {
    const { port, log } = fakePort(() => ({ worktreePath: '/repo/wt' }));
    const hooks = withClaudeWorktreeHooks(EMPTY, port, { sessionId: 'sess-2' });
    const [result] = await fire(hooks.WorktreeRemove, {
      hook_event_name: 'WorktreeRemove',
      worktree_path: '/repo/.worktrees/feature-auth',
    });
    expect(log.removed).toEqual([{ worktreePath: '/repo/.worktrees/feature-auth', sessionId: 'sess-2' }]);
    // `hooks.md#worktreeremove`: "WorktreeRemove hooks have no decision
    // control." So there is nothing to return but a continue.
    expect(result).toEqual({ continue: true });
  });
});

describe('P2.458 · a user hook owns creation and ours stands down', () => {
  const userMatcher: SdkAutomationCallbackMatcher = {
    hooks: [async () => ({ continue: true })],
  };

  /**
   * KILLS: appending ours beside theirs (either order). The binary takes the
   * first non-empty output, so the loser still RAN — it created a worktree the
   * session never enters, which is the leak this row exists to close.
   */
  test('a declared WorktreeCreate is left alone and never joined', async () => {
    const { port, log } = fakePort(() => ({ worktreePath: '/repo/ours' }));
    const hooks = withClaudeWorktreeHooks({ WorktreeCreate: [userMatcher] }, port, {
      debug: line => log.debug.push(line),
    });
    expect(hooks.WorktreeCreate).toEqual([userMatcher]);
    await fire(hooks.WorktreeCreate, { hook_event_name: 'WorktreeCreate', name: 'n' });
    expect(log.created).toEqual([]);
    // Standing down silently is the same shape as a wiring bug. The row's own
    // rule: an undocumented choice nobody can see is indistinguishable from a
    // defect.
    expect(log.debug.join('\n')).toContain('stands down');
  });

  /**
   * KILLS: standing down on REMOVAL too. Removal has no decision control, so an
   * extra matcher cannot change the outcome — and being told about a teardown
   * the host did not initiate is exactly the record the sweep is missing.
   */
  test('removal is still registered, appended after the user\'s', async () => {
    const userRemove: SdkAutomationCallbackMatcher = { hooks: [async () => ({ continue: true })] };
    const { port, log } = fakePort(() => ({ worktreePath: '/repo/ours' }));
    const hooks = withClaudeWorktreeHooks(
      { WorktreeCreate: [userMatcher], WorktreeRemove: [userRemove] },
      port,
    );
    expect(hooks.WorktreeRemove).toHaveLength(2);
    expect(hooks.WorktreeRemove?.[0]).toBe(userRemove);
    await fire(hooks.WorktreeRemove, { hook_event_name: 'WorktreeRemove', worktree_path: '/repo/theirs' });
    expect(log.removed).toEqual([{ worktreePath: '/repo/theirs' }]);
  });
});

describe('P2.458 · a refusal aborts creation instead of leaking one', () => {
  /** KILLS: turning a refusal into a missing path, i.e. the binary's generic error. */
  test('a port refusal blocks with the port\'s own reason', async () => {
    const { port } = fakePort(() => ({ refusedReason: 'retention cap reached' }));
    const hooks = withClaudeWorktreeHooks(EMPTY, port);
    const [result] = await fire(hooks.WorktreeCreate, { hook_event_name: 'WorktreeCreate', name: 'n' });
    expect(result).toEqual({ decision: 'block', reason: 'retention cap reached' });
  });

  /** KILLS: letting the port's throw escape the hook and take the turn down. */
  test('a throwing port becomes a block, not an unhandled rejection', async () => {
    const { port } = fakePort(() => { throw new Error('git worktree add failed'); });
    const hooks = withClaudeWorktreeHooks(EMPTY, port);
    const [result] = await fire(hooks.WorktreeCreate, { hook_event_name: 'WorktreeCreate', name: 'n' });
    expect(result).toEqual({ decision: 'block', reason: 'worktree lease failed: git worktree add failed' });
  });

  /**
   * KILLS: leasing a worktree nobody can name. Without a slug the host's record
   * cannot be joined to anything, so the sweep it exists for cannot act.
   */
  test('a nameless WorktreeCreate is refused before the port is asked', async () => {
    const { port, log } = fakePort(() => ({ worktreePath: '/repo/wt' }));
    const hooks = withClaudeWorktreeHooks(EMPTY, port);
    const [result] = await fire(hooks.WorktreeCreate, { hook_event_name: 'WorktreeCreate' });
    expect(log.created).toEqual([]);
    expect(result).toMatchObject({ decision: 'block' });
  });
});

describe('D1.128 · a refusal says something to the USER, beside what the runtime says', () => {
  /**
   * The runtime's own sentence for every one of these refusals is
   * `WorktreeCreate hook failed: hook succeeded but returned no worktree path
   * (command: echo the path to stdout; http/callback: return
   * hookSpecificOutput.worktreePath)` — measured at the 1.36.0 sitting as what
   * the session shows. It is addressed to a hook AUTHOR and the reader is not
   * one. It also cannot be replaced: the binary reads our path back out of the
   * same shape it would print, so anything we put in its way is taken FOR a
   * path. What is owed is a sentence beside it, and these cases pin that every
   * refusal has one, that each names its own cause, and that the block result
   * is unchanged by the addition.
   */
  function noticing(): { notices: string[]; context: ClaudeWorktreeHookContext } {
    const notices: string[] = [];
    return { notices, context: { notice: sentence => notices.push(sentence) } };
  }

  test('a port refusal, a throw, an unusable path and a missing name each say why', async () => {
    const cases: Array<{ port: ClaudeWorktreePort; input: Record<string, unknown>; says: string }> = [
      {
        port: fakePort(() => ({ refusedReason: 'retention cap reached' })).port,
        input: { hook_event_name: 'WorktreeCreate', name: 'n' },
        says: 'retention cap reached',
      },
      {
        port: fakePort(() => { throw new Error('not a git repository'); }).port,
        input: { hook_event_name: 'WorktreeCreate', name: 'n' },
        says: 'not a git repository',
      },
      {
        port: fakePort(() => ({ worktreePath: 'relative/path' })).port,
        input: { hook_event_name: 'WorktreeCreate', name: 'n' },
        says: 'not absolute',
      },
      {
        port: fakePort(() => ({ worktreePath: '/repo/wt' })).port,
        input: { hook_event_name: 'WorktreeCreate' },
        says: 'without a name',
      },
    ];

    for (const testCase of cases) {
      const { notices, context } = noticing();
      const hooks = withClaudeWorktreeHooks(EMPTY, testCase.port, context);
      const [result] = await fire(hooks.WorktreeCreate, testCase.input as never);

      expect(result).toMatchObject({ decision: 'block' });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(testCase.says);
      // The tail that connects the two messages, on every one of them.
      expect(notices[0]).toContain('returned no worktree path');
      expect(notices[0]).toContain('not a second problem');
    }
  });

  /**
   * KILLS: making the notice mandatory. A host that has not wired it must
   * behave exactly as it did before this row — the refusal is still a block
   * with the same reason, and nothing throws on the missing callback.
   */
  test('NEGATIVE — a SUCCESS says nothing, and an absent callback changes no outcome', async () => {
    const { notices, context } = noticing();
    const { port } = fakePort(() => ({ worktreePath: '/repo/.worktrees/ok' }));

    const [good] = await fire(
      withClaudeWorktreeHooks(EMPTY, port, context).WorktreeCreate,
      { hook_event_name: 'WorktreeCreate', name: 'n' },
    );
    expect(good).toMatchObject({ continue: true });
    expect(notices).toEqual([]);

    const { port: refusing } = fakePort(() => ({ refusedReason: 'retention cap reached' }));
    const [blocked] = await fire(
      withClaudeWorktreeHooks(EMPTY, refusing).WorktreeCreate,
      { hook_event_name: 'WorktreeCreate', name: 'n' },
    );
    expect(blocked).toEqual({ decision: 'block', reason: 'retention cap reached' });
  });

  /** KILLS: wiring the callback to nothing at the call site. */
  test('claude-agent.ts feeds the notice to its own degradation queue', () => {
    const agent = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    const at = agent.indexOf('return withClaudeWorktreeHooks(');
    expect(at).toBeGreaterThan(-1);
    // D1.111 — the call's own OPTIONS object bounds it: the first `{` at or
    // after this anchor is that object, and the callback under test is one of
    // its members. No character count to maintain.
    const window = bracedRegion(agent, at);
    expect(window).toContain('notice: sentence => this.queueDegradationNotice(sentence)');
    // BOUNDARY CONTROL: the next record below the call.
    expect(window).not.toContain('resumed_from_incomplete_thinking');
  });
});

describe('P2.458 · the path screen', () => {
  /**
   * KILLS: dropping the absolute check. The binary resolves a relative return
   * against its OWN root (`if(isAbsolute(n)) …; return {worktreePath:resolve(await ZYo(),n)}`),
   * so a relative path can leave the lease record and the session's real cwd
   * pointing at two directories — this row's leak, one layer up.
   */
  test.each([
    ['worktrees/a', 'not absolute'],
    ['', 'empty'],
    ['/repo/../escape', "'.' or '..'"],
    ['/repo/./here', "'.' or '..'"],
  ])('%s is refused', (candidate, fragment) => {
    const screened = screenClaudeWorktreePath(candidate);
    expect(screened).not.toHaveProperty('path');
    expect((screened as { refusedReason: string }).refusedReason).toContain(fragment);
  });

  test.each(['/repo/.worktrees/a', 'C:\\repo\\wt'])('%s passes', candidate => {
    expect(screenClaudeWorktreePath(candidate)).toEqual({ path: candidate });
  });

  /** KILLS: screening the port's answer but not the runtime's remove payload. */
  test('a remove payload that fails the screen is never handed to the port', async () => {
    const { port, log } = fakePort(() => ({ worktreePath: '/repo/wt' }));
    const hooks = withClaudeWorktreeHooks(EMPTY, port);
    for (const worktree_path of ['relative/path', '/repo/../etc', '']) {
      await fire(hooks.WorktreeRemove, { hook_event_name: 'WorktreeRemove', worktree_path });
    }
    expect(log.removed).toEqual([]);
  });

  /** KILLS: screening the input but not the port's own answer. */
  test('a port that answers with a relative path is blocked', async () => {
    const { port } = fakePort(() => ({ worktreePath: 'wt/relative' }));
    const hooks = withClaudeWorktreeHooks(EMPTY, port);
    const [result] = await fire(hooks.WorktreeCreate, { hook_event_name: 'WorktreeCreate', name: 'n' });
    expect(result).toMatchObject({ decision: 'block' });
    expect((result as { reason: string }).reason).toContain('unusable path');
  });
});

describe('P2.458 · the surfaces this wiring assumes still exist', () => {
  const dts = sdkTypings();

  /** POSITIVE CONTROL: a read that found nothing would be instrument failure. */
  test('the declaration file is the one we think it is', () => {
    expect(dts.length).toBeGreaterThan(10_000);
    expect(dts).toContain("'PreToolUse'");
    expect(dts).not.toContain('ZZThisEventDoesNotExistZZ');
  });

  /**
   * KILLS: the cast in `worktreeCreateResult` rotting. The shared mirror has no
   * `worktreePath` on its callback result, so the field is written through a
   * named widening; this is what proves the SDK still declares the shape the
   * widening claims.
   */
  test('WorktreeCreateHookSpecificOutput still carries worktreePath', () => {
    const start = dts.indexOf('declare type WorktreeCreateHookSpecificOutput =');
    expect(start).toBeGreaterThan(-1);
    const body = dts.slice(start, dts.indexOf('};', start));
    expect(body).toContain("hookEventName: 'WorktreeCreate'");
    expect(body).toContain('worktreePath: string');
  });

  /**
   * KILLS: the urgency claim going stale. The row's whole case is that
   * background sessions isolate themselves by DEFAULT, so the hook fires on a
   * route nobody asked for. If the bundle stops saying so, the case is weaker
   * and should be re-read rather than assumed.
   */
  test('background-session isolation still defaults to a worktree', () => {
    expect(dts).toContain("bgIsolation?: 'worktree' | 'none'");
    expect(dts).toContain("'worktree' (default)");
  });

  /**
   * KILLS: someone reverting the call site. The hooks can be perfect and
   * unreachable; this is the only assertion that the merged map actually
   * receives them, and that it is fed the config's port rather than a literal.
   */
  test('claude-agent.ts wraps the merged hook map with the worktree hooks', () => {
    const agent = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    // A WINDOW, not the whole file: `toMatch` on 7000 lines prints all 7000 on
    // failure, which buries the one line the reader needs. Anchored on the call
    // rather than on the file so a moved call site is still found.
    const at = agent.indexOf('return withClaudeWorktreeHooks(');
    expect(at).toBeGreaterThan(-1);
    // D1.111 — the same region as the sibling case above, bounded by the call's
    // own options object instead of by 400 characters. The shape this `toMatch`
    // needs (the wrapped map, then the port) all sits ahead of that object.
    const window = bracedRegion(agent, at);
    // BOUNDARY CONTROL: the next record below the call, so a runaway scan cannot
    // satisfy the match from somewhere else in a 12 000-line file.
    expect(window).not.toContain('resumed_from_incomplete_thinking');
    expect(window).toMatch(
      /withClaudeWorktreeHooks\(\s*withClaudeHostTaskRegistry\([\s\S]{0,200}?\),\s*this\.config\.claudeWorktreePort,/,
    );
  });
});
