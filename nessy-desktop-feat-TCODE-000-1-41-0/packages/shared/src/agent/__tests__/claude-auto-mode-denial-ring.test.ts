/**
 * P6.209 (A42) — the denial receipts stop being thrown away one line after they
 * are minted.
 *
 * Both mint sites built a typed `ClaudePermissionDenialReceiptV1` and handed it
 * to `onDebug` and nothing else. In a packaged build that call has no reader at
 * all (electron-log's transports are disabled there), so a session auto mode had
 * silently narrowed could not be inspected: the evidence existed and was
 * discarded. The denominator's own verdict for A42 is claude `partial` for
 * exactly this reason — *"a live feed already exists … but its only sink is
 * `onDebug`, and nothing lists or retries it"*.
 *
 * WHAT THIS SUITE PINS
 *
 * The ring, its bound, and the two refusals. It does NOT pin a retry: re-issuing
 * a call a safety judge refused is a product posture and its own row, and a
 * reader that quietly grew one would be a new permission behaviour smuggled in
 * behind an audit list.
 *
 * The stream channel is the one driven here because it is the one that is not
 * dormant: the `PermissionDenied` hook fires only for auto-mode classifier
 * denials, which our own `permissionDecision` silences, while
 * `system/permission_denied` carries every denial the binary decides for itself.
 * A list fed by the dormant half alone would render empty on exactly the
 * sessions a user opens it for.
 */
import { describe, expect, it } from 'bun:test';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import type { ClaudePermissionDenialReceiptV1 } from '../claude-permission-denial-receipt.ts';

function createConfig(): BackendConfig {
  return {
    provider: 'anthropic',
    workspace: {
      id: 'ws-claude-denial-ring',
      name: 'Claude Denial Ring Workspace',
      rootPath: '/tmp/ws-claude-denial-ring',
      workspaceRootPath: '/tmp/ws-claude-denial-ring',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-claude-denial-ring',
    } as never,
    session: {
      id: 'session-claude-denial-ring',
      workspaceRootPath: '/tmp/ws-claude-denial-ring',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as never,
    model: 'claude-sonnet-4-5',
    isHeadless: true,
  } as BackendConfig;
}

interface Internals {
  debug: (message: string) => void;
  mintStreamPermissionDenialReceipt: (denial: Record<string, unknown>) => void;
}

function harness() {
  const agent = new ClaudeAgent(createConfig());
  const internals = agent as unknown as Internals;
  internals.debug = () => {};
  return { agent, internals, destroy: () => agent.destroy() };
}

function denial(index: number): Record<string, unknown> {
  return {
    tool_name: 'Bash',
    tool_use_id: `toolu_${index}`,
    decision_reason_type: 'classifier',
    decision_reason: 'Blocked by classifier',
    message: `refused call ${index}`,
  };
}

describe('the receipts are retained, not only logged', () => {
  it('a session with no denials answers empty rather than undefined', () => {
    const h = harness();
    try {
      expect(h.agent.getRecentAutoModeDenials()).toEqual([]);
    } finally { h.destroy(); }
  });

  it('keeps a minted receipt, with what was refused still on it', () => {
    const h = harness();
    try {
      h.internals.mintStreamPermissionDenialReceipt(denial(1));
      const kept = h.agent.getRecentAutoModeDenials();
      expect(kept).toHaveLength(1);
      expect(kept[0]!.toolName).toBe('Bash');
      expect(kept[0]!.toolUseId).toBe('toolu_1');
      expect(kept[0]!.decisionReasonType).toBe('classifier');
    } finally { h.destroy(); }
  });

  it('retains nothing for a payload that names no tool — the mint refuses it', () => {
    const h = harness();
    try {
      // A receipt naming no tool identifies nothing while looking like evidence;
      // the mint returns null and the ring must not grow a hole to match.
      h.internals.mintStreamPermissionDenialReceipt({ tool_use_id: 'toolu_orphan' });
      h.internals.mintStreamPermissionDenialReceipt({ tool_name: 'Bash' });
      expect(h.agent.getRecentAutoModeDenials()).toEqual([]);
    } finally { h.destroy(); }
  });

  it('is BOUNDED, and drops the oldest — a long auto-mode session denies often', () => {
    const h = harness();
    try {
      for (let i = 1; i <= 60; i += 1) h.internals.mintStreamPermissionDenialReceipt(denial(i));
      const kept = h.agent.getRecentAutoModeDenials();
      expect(kept).toHaveLength(50);
      expect(kept[0]!.toolUseId).toBe('toolu_11');
      expect(kept.at(-1)!.toolUseId).toBe('toolu_60');
    } finally { h.destroy(); }
  });

  it('hands out a copy, so a reader cannot edit the session\'s own record', () => {
    const h = harness();
    try {
      h.internals.mintStreamPermissionDenialReceipt(denial(1));
      const kept = h.agent.getRecentAutoModeDenials() as ClaudePermissionDenialReceiptV1[];
      kept.length = 0;
      expect(h.agent.getRecentAutoModeDenials()).toHaveLength(1);
    } finally { h.destroy(); }
  });
});
