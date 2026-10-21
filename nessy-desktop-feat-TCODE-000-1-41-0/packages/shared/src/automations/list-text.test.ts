/**
 * F1.1265 (the final sitting's D-21) — `automation_list` tells the model WHICH automations exist.
 *
 * All three copies of the tool answered with one line, "Found N automation(s).", and the list only in
 * `structuredContent`, which a model reading the text content does not see; this release points the
 * model at the tool instead of a shell read of `automations.json`, so the answer has to carry the list.
 * Each copy now adds one compact line per automation: id, name, event, mode, enabled.
 *
 * The three copies: the claude in-process manager (`claude-context.ts`, driven here through the shared
 * handler), the session MCP server's manager (`session-mcp-server/src/index.ts`, pinned by source — it
 * starts a stdio server on import), and the session-tools-core fallback (its own suite).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleAutomationCreate, handleAutomationList, handleAutomationUpdate } from '@nessy-agent/session-tools-core';
import { createClaudeContext } from '../agent/claude-context.ts';
import { bracedRegion } from '../testing/source-regions.ts';

let workspaceRoot: string;
beforeEach(() => { workspaceRoot = mkdtempSync(join(tmpdir(), 'f1265-list-')); });
afterEach(() => { rmSync(workspaceRoot, { recursive: true, force: true }); });

function context() {
  return createClaudeContext({
    sessionId: 'session-1',
    workspacePath: workspaceRoot,
    workspaceId: 'ws-1',
    sessionPath: join(workspaceRoot, 'sessions', 'session-1'),
    onPlanSubmitted: () => {},
    onAuthRequest: () => {},
  });
}

const text = (result: { content?: Array<{ type: string; text?: string }> }): string =>
  (result.content ?? []).map(part => part.text ?? '').join('\n');

describe('F1.1265 · automation_list text content carries the compact list', () => {
  it('claude: one line per automation with id, name, event, mode and enabled', async () => {
    const nightly = await handleAutomationCreate(context(), {
      kind: 'scheduled', name: 'Nightly sweep', cron: '0 3 * * *', permissionMode: 'plan', actions: [{ type: 'prompt', prompt: 'sweep' }],
    });
    const label = await handleAutomationCreate(context(), {
      kind: 'event', event: 'LabelAdd', matcher: 'urgent', actions: [{ type: 'prompt', prompt: 'triage' }],
    });
    const labelId = String(label.structuredContent?.automationId);
    await handleAutomationUpdate(context(), { automationId: labelId, patch: { enabled: false } });

    const listed = text(await handleAutomationList(context(), { includeDisabled: true }));
    expect(listed).toContain('Found 2 automation(s).');
    expect(listed).toContain(`${String(nightly.structuredContent?.automationId)} · Nightly sweep · SchedulerTick · mode plan · enabled`);
    expect(listed).toContain(`${labelId} · (no name) · LabelAdd · mode default · disabled`);
  });

  it('NEGATIVE — an empty list is the one sentence, with no list lines', async () => {
    expect(text(await handleAutomationList(context(), {}))).toBe('Found 0 automation(s).');
  });

  it('the session MCP server\'s copy builds its text from the same formatter', () => {
    const src = readFileSync(join(import.meta.dir, '..', '..', '..', 'session-mcp-server', 'src', 'index.ts'), 'utf8');
    const at = src.indexOf('function createAutomationManager(');
    expect(at).toBeGreaterThan(-1);
    const body = bracedRegion(src, at);
    // BOUNDARY CONTROL: the region ends at the function, before the helper below it.
    expect(body).not.toContain('function automationToolResult(');
    expect(body).toContain('formatAutomationListText(automations)');
  });
});
