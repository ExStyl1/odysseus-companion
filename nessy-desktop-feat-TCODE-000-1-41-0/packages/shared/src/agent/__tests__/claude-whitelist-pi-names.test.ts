/**
 * F1.669 (origin: the adversarial verification of the 1.41.0 critical fixes, 2026-09-25) — one
 * `sessionAllowedTools` list serves Pi and Claude Code, and Pi spells its built-in tools in lower case
 * (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` — `agents/definitions.ts`'s `FULL_TOOLS`). Since F1.638
 * the list reaches claude as the SDK's `tools` option, and the child drops a name it does not know without a word,
 * so a Pi-spelled whitelist left claude with NO built-in tool but `ToolSearch`. The decided fix (owner rule
 * 2026-10-08, simplest and native): translate the Pi spellings to Claude's names before the SDK's own `tools`
 * option, and the doctor stops warning about a name the app translates.
 */
import { describe, expect, it } from 'bun:test';
import { buildClaudeSessionToolsOption } from '../claude-agent.ts';
import { claudeWhitelistEntryWarnings } from '../../config/doctor-collectors.ts';

describe('F1.669 · a Pi-spelled whitelist narrows claude to the same tools', () => {
  it('translates Pi built-in names to Claude names (ToolSearch kept)', () => {
    expect(buildClaudeSessionToolsOption({ sessionAllowedTools: ['read', 'bash', 'edit', 'write', 'grep'] }))
      .toEqual(['Read', 'Bash', 'Edit', 'Write', 'Grep', 'ToolSearch']);
  });

  it('find and ls both become Glob, once', () => {
    expect(buildClaudeSessionToolsOption({ sessionAllowedTools: ['find', 'ls'] })).toEqual(['Glob', 'ToolSearch']);
  });

  it('a list naming the same tool in both spellings keeps it once', () => {
    expect(buildClaudeSessionToolsOption({ sessionAllowedTools: ['Read', 'read'] })).toEqual(['Read', 'ToolSearch']);
  });

  it('the mini agent list is intersected with the translated whitelist', () => {
    expect(buildClaudeSessionToolsOption({ miniTools: ['Read', 'Edit'], sessionAllowedTools: ['read'] }))
      .toEqual(['Read']);
  });

  it('CONTROL: Claude names, unknown names and MCP names pass as written', () => {
    expect(buildClaudeSessionToolsOption({ sessionAllowedTools: ['Bash', 'webfetch', 'mcp__s__t'] }))
      .toEqual(['Bash', 'webfetch', 'mcp__s__t', 'ToolSearch']);
    expect(buildClaudeSessionToolsOption({ sessionAllowedTools: [] })).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('the doctor does not warn about a Pi spelling the app translates, and still warns about an unknown name', () => {
    expect(claudeWhitelistEntryWarnings(['read', 'ls'])).toEqual([]);
    expect(claudeWhitelistEntryWarnings(['webfetch'])).toHaveLength(1);
  });
});
