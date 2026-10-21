/**
 * UA12.11 — pins UA1.8's invariant: no session tool is both `safeMode: 'block'` and `readOnly: true`.
 *
 * Why it matters on codex alone. The session MCP server advertises `readOnly` as
 * `annotations.readOnlyHint` (`session-mcp-server/src/index.ts`, P6.345), and codex decides from that
 * hint whether to ask before an MCP call: `requires_mcp_tool_approval` returns false for a
 * read-only hint (`codex-rs/core/src/mcp_tool_call.rs` at the shipped `rust-v0.159.3`). UA1.8 measured
 * that a bridged `block` tool is refused in Plan and Don't ask only because codex DOES ask
 * (`maybe_request_mcp_tool_approval` → an elicitation the host declines through
 * `CodexAgent.readOnlyModeSessionToolRefusal` / `shouldAllowToolInMode`). A def carrying both flags
 * would be advertised with the hint, codex would never ask, and the tool would run in Plan on codex
 * while Pi and Claude refuse it by `safeMode`.
 *
 * The pin reads the whole canonical list (`SESSION_TOOL_DEFS`), a superset of every projection codex is
 * handed, so a new def or a flag flip anywhere is caught. Positive: the codex-shaped projection holds
 * both kinds (read-only tools AND block tools), so the empty intersection is not vacuous. Negative: a
 * planted block + read-only def is reported by the same predicate, by name.
 */
import { describe, expect, it } from 'bun:test';
import { SESSION_TOOL_DEFS, getSessionToolRegistry, type SessionToolDef } from './tool-defs.ts';

/** Names of the defs that would reach codex with `readOnlyHint` while the read-only allowlist blocks them. */
export function blockedButReadOnlyToolNames(defs: readonly SessionToolDef[]): string[] {
  return defs.filter(def => def.safeMode === 'block' && def.readOnly === true).map(def => def.name);
}

describe('UA12.11 — no session tool is both safeMode block and readOnly', () => {
  it('the canonical list carries none (the set is empty)', () => {
    expect(blockedButReadOnlyToolNames(SESSION_TOOL_DEFS)).toEqual([]);
  });

  it('POSITIVE: the codex-shaped projection holds read-only tools and block tools, so the pin is not vacuous', () => {
    // The flags the session MCP server sets for a bridged (codex) session.
    const codex = [...getSessionToolRegistry({
      externalStandaloneOnly: true,
      hostCallbackBridge: true,
      notificationPort: true,
      worktreePort: true,
      reviewDiffPort: true,
    }).values()];
    expect(codex.filter(def => def.readOnly === true).length).toBeGreaterThan(0);
    expect(codex.filter(def => def.safeMode === 'block').length).toBeGreaterThan(0);
    expect(blockedButReadOnlyToolNames(codex)).toEqual([]);
  });

  it('NEGATIVE: a planted block + read-only def fails the pin by name, and a block def without the hint does not', () => {
    const template = SESSION_TOOL_DEFS.find(def => def.safeMode === 'block')!;
    const planted = { ...template, name: 'ua12_11_planted', readOnly: true } as SessionToolDef;
    const blockOnly = { ...template, name: 'ua12_11_block_only', readOnly: false } as SessionToolDef;
    expect(blockedButReadOnlyToolNames([...SESSION_TOOL_DEFS, planted, blockOnly])).toEqual(['ua12_11_planted']);
  });
});
