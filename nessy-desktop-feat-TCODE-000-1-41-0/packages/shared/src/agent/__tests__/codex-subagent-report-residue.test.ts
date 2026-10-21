/**
 * C3.13 (QA6, owner answer A, 2026-09-11; ledger A24) — a codex user is told,
 * once, that a delegated agent's report reaches this conversation unscanned.
 *
 * ## What the row asked for, and the half that was already true
 *
 * The row's done-means has two clauses. *"The switch report says subagent output
 * scanning is claude and Pi only"* is TRUE AT HEAD and needed nothing: the
 * `subagentReportScan` row of
 * `apps/electron/src/renderer/components/app-shell/input/runtime-switch-costs.ts`
 * carries `{ pi: true, anthropic: true, 'codex-runtime': false }` and therefore
 * fires on both legs INTO codex. That is recorded rather than rebuilt.
 *
 * What was missing is the other clause: the user who never switches runtimes
 * never sees that dialog, so on codex the residue was silent. These cases pin
 * the statement.
 *
 * ## Why the trigger is the spawn
 *
 * codex's delegation tools are live on every session this host starts
 * (`AgentsToml.enabled` defaults true; the writer emits
 * `[features] multi_agent = true`), so a session-start notice would open every
 * codex session with a sentence about something most of them never do. The item
 * stream names the tool, so the honest trigger is the first delegation actually
 * happening — and the flag makes it one statement per session, not one per spawn.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAgent } from '../codex-agent.ts';
import { createMockBackendConfig } from './test-utils.ts';
import type { BackendConfig } from '../backend/types.ts';
import { bracedRegion } from '../../testing/source-regions.ts';

interface Probe {
  notices: string[];
  note: (event: unknown) => void;
}

function codexProbe(): Probe {
  const agent = new CodexAgent({
    ...createMockBackendConfig(),
    provider: 'codex-runtime',
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig);
  const inner = agent as unknown as {
    pendingServerWarningNotices: string[];
    noteCodexSubagentReportResidue(event: unknown): void;
  };
  return { notices: inner.pendingServerWarningNotices, note: e => inner.noteCodexSubagentReportResidue(e) };
}

const toolStart = (toolName: string): unknown => ({ type: 'tool_start', toolUseId: 'c1', toolName, input: {} });

describe('C3.13 — the unscanned delegated report', () => {
  it('states the residue when codex spawns its own agent', () => {
    const { notices, note } = codexProbe();
    note(toolStart('spawn_agent'));

    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('UNSCANNED');
    // The three things that make it actionable rather than merely alarming:
    // where the report comes from, why nothing can scan it, and which runtimes do.
    expect(notices[0]).toContain('inside the codex app-server');
    expect(notices[0]).toContain('Claude and Pi only');
  });

  it('says it ONCE per agent, not once per spawn', () => {
    const { notices, note } = codexProbe();
    note(toolStart('spawn_agent'));
    note(toolStart('spawn_agent'));
    note(toolStart('resume_agent'));
    expect(notices).toHaveLength(1);
  });

  it('CONTROL: an ordinary tool call says nothing', () => {
    // Without this the notice could be firing on every tool_start, which would
    // be a sentence on every codex turn rather than on every delegation.
    const { notices, note } = codexProbe();
    note(toolStart('exec_command'));
    note(toolStart('wait_agent'));
    note({ type: 'tool_result', toolUseId: 'c1', result: 'ok', isError: false });
    expect(notices).toEqual([]);
  });

  it('is WIRED: the adapter loop calls it beside the hook minter', () => {
    // Every case above drives the method directly, so all of them survive the
    // one mutation that matters most — deleting the CALL. The idiom is
    // `codex-resolved-sandbox-policy.test.ts`'s: read the source.
    const source = readFileSync(join(import.meta.dir, '..', 'codex-agent.ts'), 'utf8');
    const start = source.indexOf('for (const event of this.eventAdapter.adapt(method, params))');
    expect(start).toBeGreaterThan(0);
    // D1.111 — the loop's own braces, not 900 characters of it. The body is
    // 1 442 characters today, so the number was reading 62 % of the thing it
    // named and the last 542 characters of the loop were invisible to the
    // assertions below.
    const window = bracedRegion(source, start);
    expect(window).toContain('this.noteCodexSubagentReportResidue(event)');
    // The positive control on the same window: the sibling minter is still there,
    // so a window that stopped matching for an unrelated reason cannot pass.
    expect(window).toContain('this.noteCodexToolCallForHooks(event)');
    // BOUNDARY CONTROL. `stopThrashingTurn` is called on the line AFTER this
    // loop closes, so a brace scan that ran away includes it — and a scan only
    // runs forward, which is why the anchor has to be something BELOW the
    // region rather than the nearest familiar name.
    expect(window).not.toContain('this.stopThrashingTurn()');
  });
});
