/**
 * P6.411 — a session could not say which plugins actually loaded and which
 * silently did not, on any runtime.
 *
 * `toAgentRuntime` is the single projection all three runtimes consume, and it
 * used to drop a non-runnable entry with a bare `continue`. These tests pin the
 * two halves of the fix that can drift apart:
 *
 * 1. the reason recorded for a withheld entry, per rejection cause, and
 * 2. that `withheld` and the runnable lists are COMPLEMENTS — every entry the
 *    snapshot carried appears in exactly one of them.
 *
 * (2) is the one worth having. A reason list that quietly disagrees with the
 * runnable test is worse than no list at all: it would report a plugin as loaded
 * while the view withholds it.
 */

import { describe, expect, it } from 'bun:test';
import type {
  CapabilityContext,
  EffectiveCapabilitySnapshot,
  ResolvedCapability,
  ResolvedCapabilityEntry,
} from '../resolver.ts';
import { toAgentRuntime } from '../views.ts';

const CONTEXT: CapabilityContext = {
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  projectKey: 'p_00000000000000000000000000000000',
  projectTrustState: 'trusted',
  projectTrustRevision: 'trust-r1',
};

function skillEntry(over: Partial<ResolvedCapability> = {}): ResolvedCapabilityEntry {
  const summary: ResolvedCapability = {
    key: over.key ?? 'skill:demo',
    kind: 'skill',
    logicalName: over.logicalName ?? 'demo',
    origin: 'plugin',
    scope: { kind: 'global' },
    pluginKey: 'pk-1',
    pluginInstanceId: `plugin://m/p@1.0.0#${'b'.repeat(64)}`,
    enabled: true,
    selectedAsUnqualifiedAlias: true,
    readOnly: false,
    ...over,
  } as ResolvedCapability;
  return {
    summary,
    runtimeBinding: {
      kind: 'skill',
      resource: {
        source: 'managed-global',
        scope: { kind: 'global' },
        resourceId: summary.key,
        absolutePath: `/managed/skills/${summary.logicalName}/SKILL.md`,
        revision: 'r1',
        contentHash: 'c'.repeat(64),
      },
    },
  };
}

function snapshotOf(entries: ResolvedCapabilityEntry[]): EffectiveCapabilitySnapshot {
  return {
    context: CONTEXT,
    generation: 'gen-1',
    leaseId: 'lease-1',
    entries,
    installedPlugins: [],
    diagnostics: [],
  };
}

describe('toAgentRuntime withheld inventory', () => {
  it('records a reason for each way a capability can be withheld, and names its plugin', () => {
    const view = toAgentRuntime(snapshotOf([
      skillEntry({ key: 'skill:off', logicalName: 'off', enabled: false }),
      skillEntry({ key: 'skill:review', logicalName: 'review', trustState: 'review-required' }),
      skillEntry({ key: 'skill:blocked', logicalName: 'blocked', trustState: 'blocked' }),
      skillEntry({ key: 'skill:runtime', logicalName: 'runtime', unavailableReason: 'unsupported-runtime' }),
    ]));

    expect(view.withheld?.map(w => [w.key, w.reason])).toEqual([
      ['skill:off', 'disabled'],
      ['skill:review', 'review-required'],
      ['skill:blocked', 'blocked'],
      ['skill:runtime', 'unsupported-runtime'],
    ]);
    // Every row names the plugin it came from, which is what makes the list an
    // answer to "which plugins did not load" rather than a list of keys.
    expect(view.withheld?.every(w => w.pluginKey === 'pk-1')).toBe(true);
    expect(view.skills).toEqual([]);
  });

  it('reports `disabled` ahead of a trust verdict — the one the user can act on alone', () => {
    const view = toAgentRuntime(snapshotOf([
      skillEntry({ enabled: false, trustState: 'review-required' }),
    ]));
    expect(view.withheld?.[0]?.reason).toBe('disabled');
  });

  it('withholds nothing for a runnable capability, and says so with an empty list', () => {
    const view = toAgentRuntime(snapshotOf([skillEntry()]));
    expect(view.withheld).toEqual([]);
    expect(view.skills).toHaveLength(1);
  });

  it('is a COMPLEMENT of what the view exposes: every entry lands in exactly one side', () => {
    const entries = [
      skillEntry({ key: 'skill:a', logicalName: 'a' }),
      skillEntry({ key: 'skill:b', logicalName: 'b', enabled: false }),
      skillEntry({ key: 'skill:c', logicalName: 'c', trustState: 'blocked' }),
      skillEntry({ key: 'skill:d', logicalName: 'd' }),
    ];
    const view = toAgentRuntime(snapshotOf(entries));
    const exposed = view.skills.map(s => s.key);
    const held = (view.withheld ?? []).map(w => w.key);
    expect([...exposed, ...held].sort()).toEqual(entries.map(e => e.summary.key).sort());
    expect(exposed.filter(k => held.includes(k))).toEqual([]);
  });

  it('omits the plugin fields for a capability that belongs to no plugin', () => {
    const view = toAgentRuntime(snapshotOf([
      skillEntry({
        key: 'skill:native',
        logicalName: 'native',
        origin: 'builtin',
        pluginKey: undefined,
        pluginInstanceId: undefined,
        enabled: false,
      }),
    ]));
    expect(view.withheld?.[0]).toEqual({
      key: 'skill:native',
      kind: 'skill',
      logicalName: 'native',
      reason: 'disabled',
    });
  });
});
