/**
 * P6.795 — the `remember` tool must not write memory for a chat that closed its
 * write axis.
 *
 * `SessionToolContext.memoryEnabled` has exactly one reader,
 * `session-tools-core/src/handlers/remember.ts` (`if (ctx.memoryEnabled ===
 * false)`), and it is the WRITE axis. Before this row `claude-context.ts` fed it
 * from `getMemoryEnabled()` alone, so a per-chat override was invisible to the
 * tool while every other memory seam already resolved it.
 *
 * The cases below are written against the CONTEXT rather than the handler on
 * purpose: the staleness the row names is a property of the context object, not
 * of the handler, because the tools built around it are cached per session.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClaudeContext } from '../claude-context.ts';
import { getMemoryEnabled } from '../../config/storage.ts';
import type { SessionMemoryScopeOverride } from '../memory/session-memory-scope.ts';

function makeContext(getMemoryScopeOverride?: () => SessionMemoryScopeOverride | undefined) {
  return createClaudeContext({
    sessionId: 'memory-scope-session',
    workspacePath: '/tmp/memory-scope-ws',
    workspaceId: 'memory-scope-ws',
    sessionPath: '/tmp/memory-scope-ws/sessions/memory-scope-session',
    onPlanSubmitted: () => {},
    onAuthRequest: () => {},
    ...(getMemoryScopeOverride ? { getMemoryScopeOverride } : {}),
  });
}

describe('claude context memory scope (P6.795)', () => {
  it('closes the tool\'s write axis for a chat that closed its own', () => {
    // Control: without it the assertion below would pass for the wrong reason,
    // because an app-wide switch that is already off makes every answer false.
    expect(getMemoryEnabled()).toBe(true);

    expect(makeContext(() => ({ write: false })).memoryEnabled).toBe(false);
  });

  it('leaves the write axis alone for a chat that only closed READING', () => {
    // The two axes are independent, and `memoryEnabled` is the write one. A
    // chat that asked not to be TOLD past memories has not asked to stop
    // producing them, and collapsing the two would take a decision the user did
    // not make. The read axis is honoured elsewhere
    // (`memory/agent-memory.ts` takes `options.memoryScope`).
    expect(makeContext(() => ({ read: false })).memoryEnabled).toBe(true);
    // And a caller that wires no accessor at all is byte-identical to the
    // behaviour before this row: the app-wide switch, and nothing else.
    expect(makeContext().memoryEnabled).toBe(getMemoryEnabled());
  });

  it('follows a mid-session change without the tools being rebuilt', () => {
    // This is the row's second clause. The tools are cached per session
    // (`session-scoped-tools.ts`'s `sessionToolsCache`), so a value captured at
    // construction would freeze here; resolving on READ means the SAME context
    // object — the one the cached tools already closed over — answers the new
    // way, with no invalidation hook and no cache touched.
    let override: SessionMemoryScopeOverride | undefined;
    const ctx = makeContext(() => override);

    expect(ctx.memoryEnabled).toBe(true);
    override = { write: false };
    expect(ctx.memoryEnabled).toBe(false);
    override = undefined;
    expect(ctx.memoryEnabled).toBe(true);
  });

  it('is actually WIRED on the claude path, as an accessor and not a value', () => {
    // The chain P6.795 left open (W9-ac -> W9-m). Everything above is a property
    // of the context object; with no caller threading the accessor a claude
    // chat's `remember` still follows the app-wide switch alone, and no test of
    // the context can see that. Read as source because the two links are a
    // parameter and an argument -- neither is observable from outside
    // `getSessionScopedTools`, whose per-session cache is the whole reason the
    // accessor form is mandatory.
    const chain = readFileSync(join(import.meta.dir, '..', 'session-scoped-tools.ts'), 'utf8');
    const agent = readFileSync(join(import.meta.dir, '..', 'claude-agent.ts'), 'utf8');
    // Positive controls: both files loaded and carry the sibling this rides beside.
    expect(chain).toContain('onRemoveSource');
    expect(agent).toContain('getSessionScopedTools(');
    // Link 1 -- the parameter, declared as a function type, and spread into the
    // context beside the other callbacks.
    expect(chain).toContain('getMemoryScopeOverride?: () => SessionMemoryScopeOverride | undefined');
    expect(chain).toContain('...(getMemoryScopeOverride ? { getMemoryScopeOverride } : {})');
    // Link 2 -- the argument, and the shape that matters. A captured
    // `this.config.session?.memoryScopeOverride` would typecheck at neither end,
    // but an intermediate `const` would, and it is exactly the "simplification"
    // that re-freezes the bug one layer up.
    const callSite = agent.slice(agent.indexOf('session: getSessionScopedTools(')).slice(0, 260);
    expect(callSite).toContain('() => this.config.session?.memoryScopeOverride');
  });
});
