/**
 * P6.264 · claude's structured context report reaches `/context`.
 *
 * The row's `done_means` (a): a claude session's `/context` renders per-category
 * rows with the `mcp_tools` / `memory_files` / `agents` / `skills` per-item
 * token counts drawn from `SDKContextUsage`, not the `tokenUsage` fallback. The
 * negative control is a Pi session, unchanged — asserted here as the composer
 * capability the resolver hands each runtime, because that is the value that
 * gates the fallback.
 */
import { describe, expect, it } from 'bun:test';

import { claudeContextAfterCompaction, claudeContextUsageSnapshot } from '../sdk-context-usage.ts';
import { resolveComposerCapabilities } from '../../composer-capabilities.ts';

/** A reply shaped exactly as `SDKContextUsage` declares it. */
const REPLY = {
  model: 'claude-sonnet-4-5-20250929',
  total_tokens: 50_000,
  raw_max_tokens: 200_000,
  percentage: 25,
  categories: [
    { name: 'System prompt', tokens: 3_000, kind: 'used' },
    { name: 'System tools', tokens: 12_000, kind: 'used' },
    { name: 'Messages', tokens: 30_000, kind: 'used' },
    { name: 'Free space', tokens: 150_000, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 20_000, kind: 'buffer' },
    { name: 'MCP tools (deferred)', tokens: 9_000, kind: 'deferred' },
  ],
  mcp_tools: [{ name: 'mcp__linear__create_issue', server_name: 'linear', tokens: 900 }],
  memory_files: [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 2_100 }],
  agents: [{ agent_type: 'reviewer', source: 'projectSettings', tokens: 1_400 }],
  skills: [{ name: 'brainstorming', source: 'plugin', plugin_name: 'superpowers', tokens: 600 }],
};

describe('P6.264 · the SDK report becomes a snapshot the overlay can draw', () => {
  it('positive — the four itemised collections land with their per-item token counts', () => {
    const snapshot = claudeContextUsageSnapshot(REPLY)!;
    expect(snapshot.source).toBe('sdk_usage');
    expect(snapshot.inputTokens).toBe(50_000);
    expect(snapshot.contextWindow).toBe(200_000);
    expect(snapshot.contextWindowSource).toBe('runtime');
    expect(snapshot.remainingWindow).toBe(150_000);

    const byId = new Map(snapshot.categories?.map(c => [c.id, c]));
    expect(byId.get('mcp_tools')?.items)
      .toEqual([{ name: 'mcp__linear__create_issue', tokens: 900, source: 'linear' }]);
    expect(byId.get('memory_files')?.items)
      .toEqual([{ name: '/repo/CLAUDE.md', tokens: 2_100, source: 'Project' }]);
    expect(byId.get('custom_subagents')?.items)
      .toEqual([{ name: 'reviewer', tokens: 1_400, source: 'projectSettings' }]);
    // A plugin skill is labelled by its plugin, which is the identity a user
    // recognises; `source` is the fallback for one that has no plugin.
    expect(byId.get('skills')?.items)
      .toEqual([{ name: 'brainstorming', tokens: 600, source: 'superpowers' }]);

    // The three nameable `used` rows land; `free`, `buffer` and `deferred` do
    // not — they are window arithmetic and out-of-window schemas, and the SDK's
    // own doc excludes `deferred` from usage math.
    expect(byId.get('system_prompt')?.tokens).toBe(3_000);
    expect(byId.get('conversation_messages')?.tokens).toBe(30_000);
    // `free` is not even in our category vocabulary — the type says so, which
    // is the stronger statement; the runtime row is dropped by tokens below.
    expect(snapshot.categories?.some(c => c.tokens === 150_000)).toBe(false);

    // What the categories do not account for is REPORTED, not hidden.
    expect(snapshot.unattributedTokens).toBe(50_000 - (3_000 + 12_000 + 30_000 + 900 + 2_100 + 1_400 + 600));
  });

  it('negative — an older reply with only totals produces the totals-only overlay', () => {
    const snapshot = claudeContextUsageSnapshot({ model: 'm', total_tokens: 10, raw_max_tokens: 100 })!;
    expect(snapshot.inputTokens).toBe(10);
    // The wire field is OPTIONAL precisely so this renders as it always did.
    expect(snapshot.categories).toBeUndefined();
    expect(snapshot.unattributedTokens).toBeUndefined();
  });

  it('an unusable payload is undefined rather than a fabricated zero', () => {
    for (const payload of [undefined, null, 'x', {}, { categories: [] }]) {
      expect(claudeContextUsageSnapshot(payload)).toBeUndefined();
    }
  });

  it('the composer offers the report on claude, and Pi is unchanged', () => {
    const claude = resolveComposerCapabilities({ provider: 'anthropic' }).contextUsage!;
    expect(claude.kind).toBe('fresh-local');
    expect(claude.refresh).toBe(true);
    // The threshold still says where it comes from: derived, not reported.
    expect(claude.thresholdKind).toBe('formula-claude');

    const pi = resolveComposerCapabilities({ provider: 'pi' }).contextUsage!;
    expect(pi.kind).toBe('fresh-local');
    expect(pi.thresholdKind).toBe('real');

    // (b) landed already and must stay: codex has no snapshot to draw.
    expect(resolveComposerCapabilities({ provider: 'codex-runtime' }).contextUsage?.kind).toBe('unavailable');
  });
});

/**
 * F1.240 — the snapshot a compaction boundary leaves, as upstream v0.13.4's
 * `contextAfterCompaction` shapes it, in this snapshot's own fields.
 */
describe('F1.240 · claudeContextAfterCompaction', () => {
  const boundary = (meta: Record<string, unknown>) => ({ type: 'system', subtype: 'compact_boundary', compact_metadata: meta });

  it('positive — post_tokens becomes the count, marked an after-compaction estimate over the reported window', () => {
    expect(claudeContextAfterCompaction(boundary({ trigger: 'auto', pre_tokens: 180_000, post_tokens: 24_000 }), 200_000)).toEqual({
      inputTokens: 24_000,
      contextWindow: 200_000,
      contextWindowSource: 'runtime',
      remainingWindow: 176_000,
      source: 'estimated_after_compact',
      lastCompaction: { tokensBefore: 180_000, estimatedTokensAfter: 24_000 },
    });
  });

  it('negative — no post_tokens: the count is UNKNOWN and the snapshot stale; pre_tokens is never the count', () => {
    const snapshot = claudeContextAfterCompaction(boundary({ trigger: 'manual', pre_tokens: 1_842 }), undefined);
    expect(snapshot).toEqual({
      inputTokens: null,
      contextWindow: null,
      contextWindowSource: 'unavailable',
      remainingWindow: null,
      source: 'unavailable',
      stale: true,
      lastCompaction: { tokensBefore: 1_842 },
    });
    // A zero or garbage post_tokens is "absent", exactly as R14's reader treats it.
    expect(claudeContextAfterCompaction(boundary({ trigger: 'auto', pre_tokens: 5, post_tokens: 0 }), 200_000)?.stale).toBe(true);
  });

  it('anything that is not a compact_boundary is undefined — the caller emits nothing', () => {
    expect(claudeContextAfterCompaction({ type: 'system', subtype: 'init' }, 200_000)).toBeUndefined();
    expect(claudeContextAfterCompaction({ type: 'result' }, 200_000)).toBeUndefined();
    expect(claudeContextAfterCompaction(null, 200_000)).toBeUndefined();
  });
});
