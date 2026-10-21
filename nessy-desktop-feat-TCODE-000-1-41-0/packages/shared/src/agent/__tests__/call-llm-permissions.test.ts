/**
 * Tests for call_llm tool permission handling across permission modes.
 *
 * call_llm is a session-scoped MCP tool (mcp__session__call_llm) that should
 * be allowed in ALL permission modes including safe/Explore, since it's a
 * read-only operation (secondary LLM call, no side effects).
 *
 * P2.189 measured which of these rows can bite, because all four used to be a
 * bare `expect(result.allowed).toBe(true)`. `shouldAllowToolInMode` answers
 * `allowed: true` for EVERY tool in `default` and `bypassPermissions` — `Write`
 * included, and a tool name that exists nowhere in the codebase included — so a
 * row asserting `allowed === true` in either of those modes is satisfied by any
 * string at all and says nothing about call_llm. Only `explore` discriminates:
 * there an `mcp__session__*` name with no grant is DENIED. The explore row is
 * therefore the load-bearing one and carries an ungranted sibling as its
 * same-mode control; the permissive-mode rows are relabelled for what they
 * actually check rather than deleted, since a future DENY rule would show up
 * there.
 */
import { describe, it, expect } from 'bun:test';
import { shouldAllowToolInMode } from '../../agent/mode-manager.ts';

describe('call_llm permission mode handling', () => {
  const toolName = 'mcp__session__call_llm';
  const input = { prompt: 'Summarize this file', model: 'haiku' };

  it('is allowed in plan mode BECAUSE it is granted there — an ungranted session tool is denied in the same mode', () => {
    expect(shouldAllowToolInMode(toolName, input, 'plan').allowed).toBe(true);
    // The control that makes the line above evidence: same namespace, same
    // shape, no grant.
    expect(shouldAllowToolInMode('mcp__session__call_llm_that_does_not_exist', input, 'plan').allowed).toBe(false);
    // ...and a one-character typo of the name under test takes the same branch,
    // so this row cannot pass while naming the wrong tool.
    expect(shouldAllowToolInMode('mcp__session__call_llmm', input, 'plan').allowed).toBe(false);
  });

  it('is on no deny path in ask or allow-all mode — a smoke check, NOT evidence of a grant: both modes allow every non-denied tool', () => {
    for (const mode of ['default', 'bypassPermissions'] as const) {
      expect(shouldAllowToolInMode(toolName, input, mode).allowed).toBe(true);
      // Named so the next reader does not mistake the row above for a grant:
      // an invented tool name answers identically in this mode.
      expect(shouldAllowToolInMode('mcp__session__call_llm_that_does_not_exist', input, mode).allowed).toBe(true);
    }
  });

  it('does not require a permission prompt in ask mode (unprompted is this mode\'s default for every tool, so this too is a smoke check)', () => {
    const result = shouldAllowToolInMode(toolName, input, 'default');
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.requiresPermission).toBeFalsy();
    }
  });
});
