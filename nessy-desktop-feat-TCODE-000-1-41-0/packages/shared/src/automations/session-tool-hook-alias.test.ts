/**
 * F1.1131 (origin DN-161, 2026-09-26) — a hook matcher written for one runtime
 * missed the same session tool on the other. The host's hook payload carries
 * the runtime's own name for it: Claude (and codex) hand a session tool over as
 * `mcp__session__<name>`, Pi's PreToolUse payload carries the binding's bare
 * `permissionName`. So `^mcp__session__script_sandbox$` never fired on Pi and
 * `script_sandbox` (an exact Claude-mode matcher) never fired on Claude.
 *
 * The matcher now reads both names as one subject, in F1.478's shape for
 * permission rules: only for a session tool that both runtimes are handed (no
 * `visibility`), never for a `pi-only` tool (Claude runs its own built-in of
 * that name) or a `not-pi` one (on Pi the bare name is Pi's own built-in).
 */
import { describe, expect, it } from 'bun:test';
import { matcherMatchesSdk } from './utils.ts';
import type { AgentEvent, AutomationMatcher } from './types.ts';

const ACTIONS: AutomationMatcher['actions'] = [{ type: 'prompt', prompt: 'guard' }];
const claudeMode = (matcher: string): AutomationMatcher => ({ matcher, matchMode: 'claude', actions: ACTIONS });
const regex = (matcher: string): AutomationMatcher => ({ matcher, actions: ACTIONS });
const fires = (matcher: AutomationMatcher, toolName: string, event: AgentEvent = 'PreToolUse') =>
  matcherMatchesSdk(matcher, event, { hook_event_name: event, tool_name: toolName, tool_input: {} });

describe('F1.1131 — a session tool matches its hook under either runtime\'s name', () => {
  it('a Claude-spelled matcher fires for Pi\'s bare session-tool name', () => {
    expect(fires(claudeMode('mcp__session__script_sandbox'), 'script_sandbox')).toBe(true);
    expect(fires(regex('^mcp__session__script_sandbox$'), 'script_sandbox')).toBe(true);
    expect(fires(claudeMode('Bash|mcp__session__transform_data'), 'transform_data', 'PostToolUse')).toBe(true);
  });

  it('a Pi-spelled matcher fires for Claude\'s mcp__session__ name', () => {
    expect(fires(claudeMode('script_sandbox'), 'mcp__session__script_sandbox')).toBe(true);
    expect(fires(regex('^script_sandbox$'), 'mcp__session__script_sandbox')).toBe(true);
    expect(fires(claudeMode('TodoWrite'), 'mcp__session__TodoWrite', 'PermissionRequest')).toBe(true);
  });

  it('CONTROL — each runtime\'s own spelling still matches', () => {
    expect(fires(claudeMode('script_sandbox'), 'script_sandbox')).toBe(true);
    expect(fires(claudeMode('mcp__session__script_sandbox'), 'mcp__session__script_sandbox')).toBe(true);
  });

  it('NEGATIVE — no alias for a built-in, a pi-only or not-pi tool, another server, or another tool', () => {
    // Pi's own built-ins are not session tools.
    expect(fires(claudeMode('mcp__session__Bash'), 'Bash')).toBe(false);
    // pi-only: Claude runs its own built-in `TaskList`, never ours.
    expect(fires(claudeMode('mcp__session__TaskList'), 'TaskList')).toBe(false);
    expect(fires(claudeMode('TaskList'), 'mcp__session__TaskList')).toBe(false);
    // not-pi: on Pi the bare `web_search` is Pi's own built-in.
    expect(fires(claudeMode('mcp__session__web_search'), 'web_search')).toBe(false);
    expect(fires(claudeMode('web_search'), 'mcp__session__web_search')).toBe(false);
    // Another MCP server's tool of the same name is not the session tool.
    expect(fires(claudeMode('script_sandbox'), 'mcp__other__script_sandbox')).toBe(false);
    // Another tool.
    expect(fires(claudeMode('mcp__session__script_sandbox'), 'transform_data')).toBe(false);
  });
});
