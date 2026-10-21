/**
 * P6.694 — a plugin subagent carries its SCOPED identity into the `@` typeahead.
 *
 * The row's defect was in the protocol, not the renderer:
 * `SafeCapabilitySummary['mention'].type` was `'source' | 'skill'`, so no agent
 * row could legally carry the record, and `agentMentionInvocationId` fell
 * through to `logicalName` — the agent's frontmatter `name` — for every plugin
 * agent. `sub-agents.md#invoke-subagents-explicitly`: *"Subagents provided by an
 * enabled plugin appear in the typeahead under their scoped name, such as
 * `my-plugin:code-reviewer`"*, and the same page states the consequence of
 * getting it wrong: *"If multiple plugins provide agents with the same name,
 * pass the scoped name to disambiguate"*.
 *
 * The control is the arm that must NOT change: a project or user agent keeps
 * its bare name, which is what the page documents for it — *"`@agent-<name>`
 * for local subagents"*.
 */

import { describe, expect, it } from 'bun:test';
import { toSafeSummary } from '../views.ts';
import type { ResolvedCapability } from '../resolver.ts';

const BASE = {
  description: 'Reviews a diff for security defects',
  scope: { kind: 'workspace', workspaceId: 'ws-1' },
  enabled: true,
  selectedAsUnqualifiedAlias: true,
  readOnly: false,
  trustState: 'trusted',
  credentialState: 'not-required',
  diagnostics: [],
} as unknown as ResolvedCapability;

const projectAgent: ResolvedCapability = {
  ...BASE,
  key: 'agent::project::ws-1::proj::security',
  kind: 'agent',
  logicalName: 'security',
  origin: 'native',
};

const pluginAgent: ResolvedCapability = {
  ...BASE,
  key: 'inst#agent.security@ws-1',
  kind: 'agent',
  logicalName: 'security',
  origin: 'plugin',
  pluginKey: 'bWFya2V0.bXktcGx1Z2lu',
  pluginInstanceId: 'plugin://acme/my-plugin@1.2.0#' + 'a'.repeat(64),
};

describe('P6.694 — the agent mention record', () => {
  it('a plugin subagent is scoped by its plugin id', () => {
    const mention = toSafeSummary(pluginAgent).mention;
    expect(mention).toBeDefined();
    expect(mention!.type).toBe('agent');
    expect(mention!.id).toBe('my-plugin:security');
    // The exact key stays available for disambiguation and actions; only the
    // MENTION identity is scoped.
    expect(mention!.qualifiedId).toBe('inst#agent.security@ws-1');
  });

  it('control — a project agent still inserts the bare name', () => {
    const mention = toSafeSummary(projectAgent).mention;
    expect(mention).toBeDefined();
    expect(mention!.type).toBe('agent');
    expect(mention!.id).toBe('security');
  });

  it('the two are distinguishable, which is the whole point of the row', () => {
    expect(toSafeSummary(pluginAgent).mention!.id)
      .not.toBe(toSafeSummary(projectAgent).mention!.id);
  });

  it('the id comes from the INSTANCE id, never from the base64url plugin key', () => {
    // `pluginKey` is `enc(marketplaceId).enc(pluginId)`; if it ever leaked into
    // the mention the user would be asked to type base64url at the `@` menu.
    expect(toSafeSummary(pluginAgent).mention!.id).not.toContain('bXktcGx1Z2lu');
  });

  it('boundary — a plugin row with an unparseable instance id falls back to the bare name', () => {
    const malformed: ResolvedCapability = {
      ...pluginAgent,
      pluginInstanceId: 'not-a-plugin-instance-id',
    };
    // Never a half-built `undefined:security`, and never a throw: the typeahead
    // keeps working with the identity it can prove.
    expect(toSafeSummary(malformed).mention!.id).toBe('security');
  });

  it('carries no path — the record is path-free by contract', () => {
    const mention = toSafeSummary(pluginAgent).mention!;
    for (const value of [mention.id, mention.qualifiedId, mention.label]) {
      expect(value).not.toContain('/');
      expect(value).not.toContain('\\');
    }
  });
});

describe('P6.694 — the widened union does not disturb the two kinds that had it', () => {
  it('a source is unchanged', () => {
    const source = toSafeSummary({
      ...BASE,
      key: 'source:ws:gmail',
      kind: 'source',
      logicalName: 'gmail',
      origin: 'native',
    } as ResolvedCapability);
    expect(source.mention).toMatchObject({ type: 'source', id: 'gmail', qualifiedId: 'source:ws:gmail' });
  });

  it('a plugin SKILL keeps its bare logical name — scoping is an agent rule', () => {
    // Deliberate asymmetry, and the reason is `skillMentionInvocationId`: a
    // skill already disambiguates through `qualifiedId` when the short alias is
    // not selected. Scoping its `mention.id` too would change the skill
    // identity the composer emits, which this row does not touch.
    const skill = toSafeSummary({
      ...BASE,
      key: 'inst#skill.review@ws-1',
      kind: 'skill',
      logicalName: 'review',
      origin: 'plugin',
      pluginInstanceId: 'plugin://acme/my-plugin@1.2.0#' + 'a'.repeat(64),
    } as ResolvedCapability);
    expect(skill.mention!.id).toBe('review');
  });

  it('a kind with no mention record still has none', () => {
    const hook = toSafeSummary({
      ...BASE,
      key: 'hook::project::ws-1::proj::PreToolUse',
      kind: 'hook',
      logicalName: 'PreToolUse',
      origin: 'native',
    } as ResolvedCapability);
    expect(hook.mention).toBeUndefined();
  });
});
