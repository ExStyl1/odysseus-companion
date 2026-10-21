/**
 * P6.449 / denominator M18 — what a hook run actually did, read once for all
 * three runtimes.
 *
 * The page states the whole subject, `hooks.md#debug-hooks`, verbatim: *"Hook
 * execution details, including which hooks matched, their exit codes, and full
 * stdout and stderr, are written to the debug log file."* This suite pins the
 * host's reading of those three facts, and the three ways the claude arm was
 * losing them — each measured against `SDKHookResponseMessage`'s own declared
 * fields rather than against prose.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { ClaudeEventAdapter, type ClaudeAdapterCallbacks } from '../backend/claude/event-adapter.ts';
import {
  HOOK_RUN_DETAIL_MAX_CHARS,
  hookRunLabel,
  reportHookRun,
} from '../hook-run-report.ts';

function callbacks(overrides?: Partial<ClaudeAdapterCallbacks>): ClaudeAdapterCallbacks {
  return {
    onDebug: undefined,
    mapSDKError: async () => ({
      type: 'typed_error' as const,
      error: {
        code: 'unknown_error', title: 't', message: 'm', details: [], actions: [], canRetry: false,
      },
    }),
    ...overrides,
  };
}

async function hookResponse(patch: Record<string, unknown>) {
  const adapter = new ClaudeEventAdapter(callbacks());
  return adapter.adapt({
    type: 'system',
    subtype: 'hook_response',
    hook_id: 'h1',
    hook_name: 'guard',
    hook_event: 'PreToolUse',
    output: '',
    stdout: '',
    stderr: '',
    outcome: 'error',
    uuid: 'u',
    session_id: 's',
    ...patch,
  } as never);
}

describe('P6.449 · reportHookRun is the one reading', () => {
  it('names the hook by its own name, and by the event when it has none', () => {
    const base = { runtime: 'claude', event: 'PreToolUse', outcome: 'error' } as const;
    expect(hookRunLabel({ ...base, name: 'project-guard' })).toBe('project-guard');
    expect(hookRunLabel(base)).toBe('PreToolUse');
    // A blank name is not a name: it must not produce `Hook  failed`.
    expect(hookRunLabel({ ...base, name: '   ' })).toBe('PreToolUse');
  });

  it('reads STDOUT, which the claude arm declared and never read', () => {
    // `sdk.d.ts` declares `stdout` as a required field of the hook response and
    // the old line took `stderr || output`, so a hook that failed while writing
    // only to stdout produced a failure notice with no text in it at all.
    const report = reportHookRun({
      runtime: 'claude', event: 'PreToolUse', name: 'guard',
      outcome: 'error', exitCode: 2, stdout: 'refused: policy X', stderr: '',
    });
    expect(report.message).toBe('Hook guard failed (exit 2): refused: policy X');
    expect(report.level).toBe('warning');
  });

  it('labels both streams when both spoke, so neither can be mistaken for the other', () => {
    const report = reportHookRun({
      runtime: 'pi', event: 'PostToolUse', name: 'lint',
      outcome: 'error', exitCode: 1, stdout: 'checked 3 files', stderr: 'one failure',
    });
    expect(report.detail).toBe('stderr: one failure\nstdout: checked 3 files');
  });

  it('falls back to the runtime-reduced stream only when both are empty', () => {
    // claude sends `output` beside the two streams; reading it eagerly would
    // make the detail say everything twice.
    expect(reportHookRun({
      runtime: 'claude', event: 'Stop', outcome: 'error',
      stdout: '', stderr: '', output: 'only this',
    }).detail).toBe('only this')
    expect(reportHookRun({
      runtime: 'claude', event: 'Stop', outcome: 'error',
      stderr: 'the real reason', output: 'the real reason',
    }).detail).toBe('the real reason')
  });

  it('bounds the detail and SAYS it cut it', () => {
    // A hook is an arbitrary user program. Before this, its stderr went into a
    // PERSISTED transcript line with no bound at all.
    const huge = 'x'.repeat(HOOK_RUN_DETAIL_MAX_CHARS * 3);
    const report = reportHookRun({
      runtime: 'codex', event: 'PreToolUse', name: 'big', outcome: 'error', stderr: huge,
    });
    expect(report.truncated).toBe(true);
    expect(report.detail).toContain(`cut at ${HOOK_RUN_DETAIL_MAX_CHARS} characters`);
    expect(report.detail!.length).toBeLessThan(HOOK_RUN_DETAIL_MAX_CHARS + 100);
    // Control: text under the cap is untouched and says nothing about cutting.
    const small = reportHookRun({
      runtime: 'codex', event: 'PreToolUse', name: 'small', outcome: 'error', stderr: 'short',
    });
    expect(small.truncated).toBe(false);
    expect(small.detail).toBe('short');
  });

  it('keeps the page rule for a hook that succeeded: detail travels, the transcript stays quiet', () => {
    // `hooks.md#exit-code-0`, verbatim: "Stderr from a hook that exits 0 goes to
    // the debug log only, never the transcript, and Claude never sees it."
    const report = reportHookRun({
      runtime: 'claude', event: 'PostToolUse', name: 'fmt',
      outcome: 'success', exitCode: 0, stdout: 'formatted 2 files',
    });
    expect(report.message).toBeUndefined();
    expect(report.detail).toBe('formatted 2 files');
    expect(report.level).toBe('info');
  });

  it('says a cancelled hook was cancelled, without persisting it', () => {
    // Not a failure and not a success. An interrupt cancels every hook in flight
    // at once, so `info` (transient) rather than `warning` (persisted).
    const report = reportHookRun({
      runtime: 'claude', event: 'PreToolUse', name: 'guard', outcome: 'cancelled',
    });
    expect(report.message).toBe('Hook guard was cancelled');
    expect(report.level).toBe('info');
  });

  it('a timeout says timed out, not failed', () => {
    expect(reportHookRun({
      runtime: 'pi', event: 'Stop', name: 'slow', outcome: 'timeout', exitCode: 124,
    }).message).toBe('Hook slow timed out (exit 124)');
  });

  it('omits the exit code rather than inventing one', () => {
    expect(reportHookRun({
      runtime: 'codex', event: 'Stop', name: 'x', outcome: 'error', stderr: 'why',
    }).message).toBe('Hook x failed: why');
  });

  it('F1.515 · a hook that REFUSED says it blocked the action — persisted, with its reason — and never that it failed', () => {
    const report = reportHookRun({
      runtime: 'codex', event: 'permissionRequest', name: 'config.toml', outcome: 'blocked' as never,
      output: 'Checking the unattended-automation floor\n[feedback] refused rather than reviewed',
    });
    expect(report.message).toBe(
      'Hook config.toml blocked the action: Checking the unattended-automation floor\n[feedback] refused rather than reviewed',
    );
    expect(report.message).not.toContain('failed');
    expect(report.level).toBe('warning');
    // An exit code, when a runner reports one, is kept exactly as a failure keeps it.
    expect(reportHookRun({
      runtime: 'codex', event: 'PreToolUse', name: 'guard', outcome: 'blocked' as never, exitCode: 2, stderr: 'no',
    }).message).toBe('Hook guard blocked the action (exit 2): no');
  });
});

describe('P6.449 · the claude arm produces those readings', () => {
  it('a stdout-only failure is legible, where it used to be a bare exit code', async () => {
    const events = await hookResponse({ stdout: 'refused: policy X', exit_code: 2 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'info', level: 'warning' });
    expect((events[0] as { message: string }).message).toContain('refused: policy X');
  });

  it('a cancelled hook is said out loud instead of going to the debug channel', async () => {
    const events = await hookResponse({ outcome: 'cancelled' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'info', level: 'info' });
    expect((events[0] as { message: string }).message).toContain('cancelled');
  });

  it('a successful hook still costs the transcript nothing, and its output reaches debug', async () => {
    const lines: string[] = [];
    const adapter = new ClaudeEventAdapter(callbacks({ onDebug: line => { lines.push(line) } }));
    const events = await adapter.adapt({
      type: 'system', subtype: 'hook_response', hook_id: 'h1', hook_name: 'fmt',
      hook_event: 'PostToolUse', output: '', stdout: 'formatted 2 files', stderr: '',
      exit_code: 0, outcome: 'success', uuid: 'u', session_id: 's',
    } as never);
    expect(events).toHaveLength(0);
    expect(lines.join('\n')).toContain('formatted 2 files');
  });

  it('the stream these readings depend on is still switched on', () => {
    // Same pair P3.336 pinned: the option exists and this build asks for it.
    // Either half alone goes green while the pair is broken, which is how the
    // handler sat live for two events and dead for the whole tool-call path.
    const agent = readFileSync(new URL('../claude-agent.ts', import.meta.url), 'utf8');
    expect(agent).toContain('includeHookEvents: true,');
  }, 60_000);

  it('the SDK still declares both streams separately, which is why both are read', () => {
    const entry = Bun.resolveSync('@anthropic-ai/claude-agent-sdk', import.meta.dir);
    const typings = readFileSync(`${entry.slice(0, entry.lastIndexOf('/'))}/sdk.d.ts`, 'utf8');
    const shape = typings.slice(typings.indexOf('SDKHookResponseMessage = '));
    const body = shape.slice(0, shape.indexOf('};'));
    for (const field of ['stdout: string;', 'stderr: string;', 'exit_code?: number;']) {
      expect({ field, present: body.includes(field) }).toEqual({ field, present: true });
    }
  });
});
