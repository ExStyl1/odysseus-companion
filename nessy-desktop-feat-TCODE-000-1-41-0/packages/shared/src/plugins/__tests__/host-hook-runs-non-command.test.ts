/**
 * F1.9 (origin D1.365) — the NON-command hook runners in the run history.
 *
 * D1.354 made `executePluginHookAutomations` publish `hookRuns` for the COMMAND
 * hooks it ran, and `BaseAgent.recordAutomationHookRuns` PREFERS that list: when
 * it is present the notice list is not read at all (deliberately — a failing
 * command run appears in both, and reading both would record it twice). So the
 * first time the host arm published runs, every NON-command hook's failure on
 * the same event stopped reaching `HookRunStore` — a prompt hook that could not
 * block, an http or mcp_tool hook whose runner failed, an agent/mcp_tool/http
 * hook with no runner at all, and `reportUnparseableIfRule`'s diagnostic. The
 * user still got the transcript notice; `/hooks` lost the row.
 *
 * Every case is driven through the REAL `PluginScopedAutomationSystem` and the
 * REAL `BaseAgent.emitAutomationEvent` → `recordAutomationHookRuns` reader, with
 * nothing planted but the runners a host injects in production (a non-spawning
 * command runner that passes every command, and the prompt/agent/mcp_tool/http
 * runners SessionManager passes on Pi). Config objects are fresh per case: the
 * not-ran notices are deduped per ACTION identity for the life of the process.
 */
import { describe, expect, it } from 'bun:test';
import {
  PluginScopedAutomationSystem,
  type CommandHookRunner,
  type PluginScopedAutomationSystemOptions,
} from '../hooks-automation.ts';
import type { AgentEventExecutionResult, AutomationsConfig, HookCommandActionResult } from '../../automations/types.ts';
import { TestAgent, createMockBackendConfig } from '../../agent/__tests__/test-utils.ts';

const WORKSPACE_ROOT = '/tmp/f1-9-workspace';
const PRE_TOOL_USE = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } } as const;
const STOP = { hook_event_name: 'Stop' } as const;

function config(event: string, name: string, actions: readonly unknown[], extra: Record<string, unknown> = {}): AutomationsConfig {
  return {
    automations: { [event]: [{ name, ...extra, actions: structuredClone(actions) }] },
  } as unknown as AutomationsConfig;
}

/** The host's non-spawning command authority: every command exits 0 with a line of output. */
const passingRunner: CommandHookRunner = async (action): Promise<HookCommandActionResult> => ({
  type: 'command',
  command: action.command,
  success: true,
  exitCode: 0,
  signal: null,
  durationMs: 2,
  stdout: 'ok\n',
} as HookCommandActionResult);

/** Emit through the real reader and return the result plus the store, read the way `/hooks` reads it. */
async function emit(
  options: Omit<PluginScopedAutomationSystemOptions, 'workspaceRootPath' | 'pluginHookConfig'> & { pluginHookConfig?: AutomationsConfig },
  event: 'PreToolUse' | 'Stop',
): Promise<{ result: AgentEventExecutionResult; stored: Array<{ label: string; outcomes: string[]; details: string[] }> }> {
  const system = new PluginScopedAutomationSystem({
    pluginHookConfig: { automations: {} },
    ...options,
    workspaceRootPath: WORKSPACE_ROOT,
  });
  const agent = new TestAgent(createMockBackendConfig());
  agent.setAutomationSystem(system);
  const result = await (agent as unknown as {
    emitAutomationEvent(event: string, input: unknown): Promise<AgentEventExecutionResult>;
  }).emitAutomationEvent(event, event === 'Stop' ? STOP : PRE_TOOL_USE);
  const stored = (agent as unknown as {
    hookRuns: { groups(): Array<{ label: string; runs: Array<{ outcome: string; report: { detail?: string } }> }> };
  }).hookRuns.groups()
    .map(group => ({
      label: group.label,
      outcomes: group.runs.map(run => run.outcome),
      details: group.runs.map(run => run.report.detail ?? ''),
    }))
    // The store promises no order ACROSS hooks; the subject is which runs were recorded.
    .sort((a, b) => a.label.localeCompare(b.label));
  return { result, stored };
}

const outcomesOf = (stored: Array<{ label: string; outcomes: string[] }>) =>
  stored.map(({ label, outcomes }) => ({ label, outcomes }));

describe('F1.9 · the non-command hook runners reach the run history', () => {
  it('a failing prompt hook beside a PASSING command hook: the prompt failure reaches the store (two tiers)', async () => {
    // The done-means case. No prompt judge is injected (every non-Pi runtime):
    // the prompt hook runs degraded — its body becomes context and it cannot
    // block — and says so on the notice list. The command hook in the OTHER tier
    // passes, so the merged result carries `hookRuns`, and the reader then
    // never looks at the notice.
    const { result, stored } = await emit({
      userGlobalHookConfig: config('PreToolUse', 'user/audit', [{ type: 'command', command: 'audit.sh' }]),
      pluginHookConfig: config('PreToolUse', 'acme/judge', [{ type: 'plugin-prompt', prompt: 'is this safe?' }]),
      pluginCommandRunner: passingRunner,
    }, 'PreToolUse');

    expect(result.hookErrors?.map(notice => notice.hookName)).toEqual(['acme/judge']);
    expect(outcomesOf(stored)).toEqual([
      { label: 'acme/judge', outcomes: ['error'] },
      { label: 'user/audit', outcomes: ['success'] },
    ]);
    expect(stored[0]!.details[0]).toContain('no prompt-judging runner is injected');
  });

  it('an http hook whose runner FAILS beside a passing command hook is one error run, never two', async () => {
    const { result, stored } = await emit({
      userGlobalHookConfig: config('PreToolUse', 'user/audit', [{ type: 'command', command: 'audit.sh' }]),
      pluginHookConfig: config('PreToolUse', 'acme/policy', [{ type: 'plugin-http', http: { url: 'https://example.invalid/policy' } }]),
      pluginCommandRunner: passingRunner,
      pluginHttpRunner: async () => ({ failed: true, code: 'http-hook-status-503' }),
    }, 'PreToolUse');

    // The notice is still built exactly once — this change adds a run, it does
    // not move the notice.
    expect(result.hookErrors?.map(notice => notice.summary)).toEqual(['http-hook-status-503']);
    expect(outcomesOf(stored)).toEqual([
      { label: 'acme/policy', outcomes: ['error'] },
      { label: 'user/audit', outcomes: ['success'] },
    ]);
    expect(stored[0]!.details[0]).toContain('http-hook-status-503');
  });

  it('clean agent and mcp_tool runs are recorded as successes — the half no notice could carry', async () => {
    const plugin = {
      automations: {
        Stop: [
          { name: 'acme/reviewer', actions: [{ type: 'plugin-agent', agentName: 'reviewer' }] },
          { name: 'acme/check', actions: [{ type: 'plugin-mcp-tool', mcpTool: 'mcp__policy__check' }] },
        ],
      },
    } as unknown as AutomationsConfig;
    const { result, stored } = await emit({
      pluginHookConfig: plugin,
      pluginAgentRunner: async () => {},
      pluginMcpToolRunner: async () => ({ body: '{}' }),
    }, 'Stop');

    expect(result.hookErrors).toBeUndefined();
    expect(outcomesOf(stored)).toEqual([
      { label: 'acme/check', outcomes: ['success'] },
      { label: 'acme/reviewer', outcomes: ['success'] },
    ]);
  });

  it('a prompt judge that returns no verdict is an error run; one that answers is a success', async () => {
    const plugin = {
      automations: {
        PreToolUse: [
          { name: 'acme/silent', actions: [{ type: 'plugin-prompt', prompt: 'silent judge' }] },
          { name: 'acme/answers', actions: [{ type: 'plugin-prompt', prompt: 'answering judge' }] },
        ],
      },
    } as unknown as AutomationsConfig;
    const { stored } = await emit({
      pluginHookConfig: plugin,
      pluginPromptRunner: async request => (request.prompt === 'silent judge' ? undefined : { ok: true }),
    }, 'PreToolUse');

    expect(outcomesOf(stored)).toEqual([
      { label: 'acme/answers', outcomes: ['success'] },
      { label: 'acme/silent', outcomes: ['error'] },
    ]);
  });

  it('the unparseable if-rule diagnostic reaches the store beside the command run it let through', async () => {
    const { result, stored } = await emit({
      userGlobalHookConfig: config('PreToolUse', 'user/audit', [{ type: 'command', command: 'audit.sh' }], { ifRule: 'Bash(git *' }),
      pluginCommandRunner: passingRunner,
    }, 'PreToolUse');

    expect(result.hookErrors?.[0]?.summary).toContain('could not be parsed');
    // The diagnostic first — it is raised when the matcher is read, before the
    // hook it concerns runs — then the run itself.
    expect(outcomesOf(stored)).toEqual([{ label: 'user/audit', outcomes: ['error', 'success'] }]);
  });

  it('CONTROL: an event where nothing ran still records every notice, exactly as the fallback always did', async () => {
    // Green before the change and after it. Before: no `hookRuns`, so the
    // reader fell back to the notices. After: the executor observes the same
    // notices itself, with the same mapping, so the store reads the same rows.
    const plugin = {
      automations: {
        Stop: [
          { name: 'acme/reviewer', actions: [{ type: 'plugin-agent', agentName: 'reviewer' }] },
          { name: 'acme/notify', actions: [{ type: 'plugin-http', http: { url: 'https://example.invalid/notify' } }] },
        ],
      },
    } as unknown as AutomationsConfig;
    const { result, stored } = await emit({ pluginHookConfig: plugin }, 'Stop');

    expect(result.hookErrors).toHaveLength(2);
    expect(outcomesOf(stored)).toEqual([
      { label: 'acme/notify', outcomes: ['error'] },
      { label: 'acme/reviewer', outcomes: ['error'] },
    ]);
    expect(stored[0]!.details[0]).toContain('the request was never sent');
    expect(stored[1]!.details[0]).toContain('the sub-agent was never spawned');
  });
});

/**
 * F1.232 (WJ-r P-WJ-r-4, decided 2026-09-23: observe it) — the one residue F1.9
 * stated on `withObservedPreRunNotices`.
 *
 * A COMMAND hook with no execution authority (no host runner, no direct-spawn
 * opt-in) off `PreToolUse` cannot run, and says so as the documented
 * `command-hook-execution-authority-unavailable` notice. That notice is pushed
 * INSIDE the command loop, after the pre-run position F1.9 keys on, so on an
 * event where any other hook ran the reader took `hookRuns` and never read it:
 * `/hooks` lost the one hook that did not run. Red at HEAD: the store held only
 * the hook that ran.
 */
describe('F1.232 · a command hook with no execution authority reaches the run history', () => {
  const stopWithUnauthorisedCommand = () => ({
    userGlobalHookConfig: config('Stop', 'user/cleanup', [{ type: 'command', command: 'cleanup.sh' }]),
    pluginHookConfig: config('Stop', 'acme/reviewer', [{ type: 'plugin-agent', agentName: 'reviewer' }]),
  });

  it('beside a hook that RAN, the command hook that could not run is one error row, never two', async () => {
    // No `pluginCommandRunner` and no `allowDirectCommandRunner`: the host's
    // command authority is absent — a state no production runtime reaches (F1.448).
    const { result, stored } = await emit({ ...stopWithUnauthorisedCommand(), pluginAgentRunner: async () => {} }, 'Stop');

    // The notice is still built exactly once — this adds a row, it does not
    // move the notice (the transcript keeps saying what it said).
    expect(result.hookErrors?.map(notice => ({ hookName: notice.hookName, summary: notice.summary }))).toEqual([
      { hookName: 'user/cleanup', summary: 'command-hook-execution-authority-unavailable' },
    ]);
    expect(outcomesOf(stored)).toEqual([
      { label: 'acme/reviewer', outcomes: ['success'] },
      { label: 'user/cleanup', outcomes: ['error'] },
    ]);
  });

  it('beside a hook that could not run EITHER, both are rows — a pre-run notice made `hookRuns` present too', async () => {
    // The agent hook has no runner, so its notice is raised before the consume
    // phase and F1.9 observes it — which is enough to make the reader take
    // `hookRuns` and skip the notice list, so at HEAD the command hook's notice
    // was lost here as well, with NOTHING having run.
    const { result, stored } = await emit(stopWithUnauthorisedCommand(), 'Stop');

    expect(result.hookErrors).toHaveLength(2);
    expect(outcomesOf(stored)).toEqual([
      { label: 'acme/reviewer', outcomes: ['error'] },
      { label: 'user/cleanup', outcomes: ['error'] },
    ]);
  });

  it('CONTROL: alone, the store reads exactly what the fallback always made of the notice', async () => {
    // Green before the change and after it. Before: no `hookRuns` at all, so the
    // reader fell back to the notice. After: the executor observes the notice
    // with the fallback's own mapping, so the store reads the same row — and
    // only one, which is the "nothing counted twice" half.
    const { result, stored } = await emit({
      userGlobalHookConfig: config('Stop', 'user/cleanup', [{ type: 'command', command: 'cleanup.sh' }]),
    }, 'Stop');

    expect(result.hookErrors?.map(notice => notice.summary)).toEqual(['command-hook-execution-authority-unavailable']);
    expect(outcomesOf(stored)).toEqual([{ label: 'user/cleanup', outcomes: ['error'] }]);
    // F1.450 — re-pinned: the row reads the notice's summary where it has no
    // separate detail (the notice type's own "omitted when equal to summary"), so
    // `/hooks` names the code instead of a bare `error` — as F1.270's twin does.
    expect(stored[0]!.details).toEqual(['command-hook-execution-authority-unavailable']);
  });

  it('on PreToolUse the same hook still BLOCKS and raises no notice — and, since F1.270, it is one error row carrying the reason', async () => {
    // BOUNDARY of F1.232: off PreToolUse the missing authority is a notice;
    // ON it, it is a fail-closed block carrying the code as its reason and no
    // notice at all. F1.270 (decided 2026-09-23: record the block as a run row
    // with its reason) keeps both halves and adds the row, because until then
    // `/hooks` showed nothing for a hook that had just stopped a tool. Red at
    // the parent on the row: the store was empty.
    const { result, stored } = await emit({
      userGlobalHookConfig: config('PreToolUse', 'user/gate', [{ type: 'command', command: 'gate.sh' }]),
    }, 'PreToolUse');

    // CONTROL — the block still blocks, with the same reason, and no notice.
    expect(result.decision?.decision).toBe('block');
    expect(result.decision?.reason).toBe('command-hook-execution-authority-unavailable');
    expect(result.hookErrors).toBeUndefined();
    // The new half: one row, an error (the hook did not run), whose detail
    // names the code AND what it did.
    expect(outcomesOf(stored)).toEqual([{ label: 'user/gate', outcomes: ['error'] }]);
    expect(stored[0]!.details[0]).toContain('command-hook-execution-authority-unavailable');
    expect(stored[0]!.details[0]).toContain('blocked');
  });

  it('F1.270 — beside a PreToolUse hook that RAN, the blocked one is its own row, never two', async () => {
    const { result, stored } = await emit({
      userGlobalHookConfig: config('PreToolUse', 'user/gate', [{ type: 'command', command: 'gate.sh' }]),
      pluginHookConfig: config('PreToolUse', 'acme/reviewer', [{ type: 'plugin-agent', agentName: 'reviewer' }]),
      pluginAgentRunner: async () => {},
    }, 'PreToolUse');

    expect(result.decision?.reason).toBe('command-hook-execution-authority-unavailable');
    expect(outcomesOf(stored)).toEqual([
      { label: 'acme/reviewer', outcomes: ['success'] },
      { label: 'user/gate', outcomes: ['error'] },
    ]);
  });
});

/**
 * F1.448 (origin WJ-ii verifier on F1.270) — the no-authority branch above has NO
 * production caller at HEAD, and its docblocks now say so. Every production
 * automation system is built by `buildPinnedAgentAutomationSystem`
 * (`capabilities/runtime-automations.ts`, the one `new PluginScopedAutomationSystem`
 * outside a test), and its one caller, `SessionManager.buildAgentAutomationSystem`,
 * passes `pluginCommandHookRunner` unconditionally. So the F1.232 notice and the
 * F1.270 block are the fail-closed guard for a system built WITHOUT a runner — a
 * future construction site, or a test — never a state a user can reach today.
 * This pins the premise, so the day a second site appears the docblocks are re-read.
 */
describe('F1.448 · the no-authority branch is unreachable from production', () => {
  it('one production construction site, and SessionManager always hands it the command runner', () => {
    const root = new URL('../../../../../', import.meta.url).pathname;
    const sites = Bun.spawnSync(['git', '-C', root, 'grep', '-l', '-F', 'new PluginScopedAutomationSystem(', '--', 'packages', 'apps', ':!*.test.ts', ':!**/__tests__/**'])
      .stdout.toString().trim().split('\n');
    expect(sites).toEqual(['packages/shared/src/capabilities/runtime-automations.ts']);
    const sessionManager = Bun.spawnSync(['git', '-C', root, 'grep', '-n', '-F', 'pluginCommandHookRunner: this.pluginCommandHookRunner(', '--', 'packages/server-core/src/sessions/SessionManager.ts'])
      .stdout.toString().trim().split('\n').filter(Boolean);
    expect(sessionManager).toHaveLength(1);
  });
});

/**
 * F1.450 (origin WJ-ii verifier on F1.270, F1.270-c) — the two twins of one
 * condition read the same in `/hooks`. F1.270's PreToolUse row names the code and
 * what happened; F1.232's off-PreToolUse row went through `noticeAsObservedRun`,
 * which read only `notice.detail`, and that notice carries only a `summary` — so
 * the row showed a bare `error`. `HookErrorNotice.detail` is documented as
 * "omitted when equal to `summary`", and the debug-log reader already reads
 * `detail ?? summary`; the executor's mapping and the reader's fallback now read
 * it the same way, so a row is still the same row whichever of the two made it.
 */
describe('F1.450 · a notice row names its reason whichever side observes it', () => {
  function storedFromNotices(hookErrors: AgentEventExecutionResult['hookErrors']) {
    const agent = new TestAgent(createMockBackendConfig());
    agent.recordAutomationHookRuns({ matchedCount: 1, ...(hookErrors ? { hookErrors } : {}) });
    return (agent as unknown as {
      hookRuns: { groups(): Array<{ label: string; runs: Array<{ report: { detail?: string } }> }> };
    }).hookRuns.groups()
      .map(group => ({ label: group.label, details: group.runs.map(run => run.report.detail ?? '') }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  it('the reader fallback (a notices-only result) reads the summary where there is no detail, and the detail where there is', () => {
    expect(storedFromNotices([
      { hookName: 'a/no-detail', event: 'Stop', exitCode: null, summary: 'command-hook-execution-authority-unavailable' },
      { hookName: 'b/with-detail', event: 'Stop', exitCode: 1, summary: 'first line', detail: 'first line\nsecond line' },
    ])).toEqual([
      { label: 'a/no-detail', details: ['command-hook-execution-authority-unavailable'] },
      { label: 'b/with-detail', details: ['first line\nsecond line'] },
    ]);
  });
});

/**
 * F1.451 (origin WJ-ii verifier on F1.270, F1.270-d) — an `async: true` command
 * hook with no execution authority on `PreToolUse` fails OPEN, as a notice and a
 * row, the way the same hook does off `PreToolUse`.
 *
 * The `!runner` check sits BEFORE the async branch, so such a hook took the sync
 * hook's fail-closed block. That block's reason — "a PreToolUse hook may be the
 * deny gate" — does not apply to it: `hooks.md#run-hooks-in-the-background`,
 * verbatim, "Async hooks can't block or control Claude's behavior: response fields
 * like `decision`, `permissionDecision`, and `continue` have no effect" (fetched
 * 2026-09-24). A block the hook could never have produced by running is not a
 * safe default, it is a different hook. Unreachable from production at HEAD
 * (F1.448), so no user sees the change today; the sync hook still blocks.
 */
describe('F1.451 · an async command hook with no authority on PreToolUse does not block', () => {
  it('no block: one notice and one error row naming the code', async () => {
    const { result, stored } = await emit({
      userGlobalHookConfig: config('PreToolUse', 'user/audit', [{ type: 'command', command: 'audit.sh', async: true }]),
    }, 'PreToolUse');

    expect(result.decision).toBeUndefined();
    expect(result.hookErrors?.map(notice => ({ hookName: notice.hookName, summary: notice.summary }))).toEqual([
      { hookName: 'user/audit', summary: 'command-hook-execution-authority-unavailable' },
    ]);
    expect(outcomesOf(stored)).toEqual([{ label: 'user/audit', outcomes: ['error'] }]);
    expect(stored[0]!.details).toEqual(['command-hook-execution-authority-unavailable']);
  });

  it('CONTROL: beside it, a SYNC command hook with no authority still blocks the tool', async () => {
    const { result, stored } = await emit({
      userGlobalHookConfig: config('PreToolUse', 'user/audit', [{ type: 'command', command: 'audit.sh', async: true }]),
      projectHookConfig: config('PreToolUse', 'project/gate', [{ type: 'command', command: 'gate.sh' }]),
    }, 'PreToolUse');

    expect(result.decision?.decision).toBe('block');
    expect(result.decision?.reason).toBe('command-hook-execution-authority-unavailable');
    expect(outcomesOf(stored)).toEqual([
      { label: 'project/gate', outcomes: ['error'] },
      { label: 'user/audit', outcomes: ['error'] },
    ]);
  });
});
