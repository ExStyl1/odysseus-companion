/**
 * UB12.102 — a `PreModelSwitch` / `PostModelSwitch` matcher is compared with the
 * canonical name derived from `to_model`.
 *
 * hooks.md § Matcher patterns (curl'd 2026-10-17): "For `PreModelSwitch` and
 * `PostModelSwitch`, Claude Code evaluates the matcher against the canonical
 * name it derives from `to_model`". hooks.md#premodelswitch: "Claude Code
 * compares the matcher against the canonical name of the model the session is
 * switching to, ignoring any `[1m]` suffix", and "When Claude Code can't
 * determine a canonical name for the target … it runs every PreModelSwitch hook
 * regardless of matcher." #postmodelswitch: "The matcher follows the same rules".
 *
 * Before the fix `getMatchValueForSdkInput` had no arm for either event, so every
 * matcher-bearing hook was compared with `''` and never ran (L-CRIT3's
 * measurement: `.*opus.*` and `claude-opus-5` both gave matchedCount 0 on
 * to_model `claude-opus-5`). The end-to-end arms below drive the real executor
 * with a spawned `echo`, so they fail on that tree.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginScopedAutomationSystem } from '../plugins/hooks-automation.ts';
import { isBlockingHookDecision } from './hook-decision-contract.ts';
import { parseHooksConfigContent } from './hooks-config.ts';
import type { AgentEvent, AutomationMatcher, SdkAutomationInput } from './types.ts';
import { getMatchValueForSdkInput, matcherMatchesSdk, modelSwitchCanonicalName } from './utils.ts';

const EVENTS: AgentEvent[] = ['PreModelSwitch', 'PostModelSwitch'];

const claude = (matcher: string): AutomationMatcher => ({
  matcher,
  matchMode: 'claude',
  actions: [{ type: 'prompt', prompt: 'test' }],
});

const native = (matcher: string): AutomationMatcher => ({
  matcher,
  actions: [{ type: 'prompt', prompt: 'test' }],
});

const switchTo = (event: AgentEvent, toModel?: string): SdkAutomationInput => ({
  hook_event_name: event,
  from_model: 'claude-sonnet-5',
  ...(toModel !== undefined ? { to_model: toModel } : {}),
  requested_model: toModel ?? null,
  source: 'sdk',
} as SdkAutomationInput);

describe('modelSwitchCanonicalName — every spelling reduces to one name', () => {
  const spellings: Array<[string, string]> = [
    ['claude-opus-5', 'claude-opus-5'],
    // "ignoring any `[1m]` suffix"
    ['claude-opus-4-6[1m]', 'claude-opus-4-6'],
    ['Claude-Opus-5[1M]', 'claude-opus-5'],
    // "a dated model ID"
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['claude-3-5-sonnet-20241022', 'claude-3-5-sonnet'],
    ['claude-3-5-sonnet-latest', 'claude-3-5-sonnet'],
    // "a provider-specific ID such as an Amazon Bedrock model ID"
    ['us.anthropic.claude-opus-4-6-v1:0', 'claude-opus-4-6'],
    ['anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5'],
    ['arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-6-v1:0', 'claude-opus-4-6'],
    // Vertex, and provider / runtime prefixes a Nessy session holds
    ['claude-opus-4-1@20250805', 'claude-opus-4-1'],
    ['anthropic/claude-opus-4.6', 'claude-opus-4-6'],
    ['pi/claude-opus-5', 'claude-opus-5'],
    ['tgpt/claude-opus-5-5', 'claude-opus-5-5'],
  ];

  it.each(spellings)('%s → %s', (spelled, canonical) => {
    expect(modelSwitchCanonicalName(spelled)).toBe(canonical);
  });

  it('has no canonical name for a non-Claude id, an alias, a lookalike or an absent target', () => {
    for (const spelled of ['tgpt/qwen35-397b-a17b-fp8', 'gpt-5.3-codex', 'coder', 'opus', 'my-claude-proxy-7', 'claude-code', '', undefined]) {
      expect(modelSwitchCanonicalName(spelled)).toBeUndefined();
    }
  });
});

describe('the model-switch matcher (hooks.md#premodelswitch)', () => {
  it.each(EVENTS)('%s: `.*opus.*` fires on to_model claude-opus-5 and not on claude-sonnet-5', (event) => {
    expect(getMatchValueForSdkInput(event, switchTo(event, 'claude-opus-5'))).toBe('claude-opus-5');
    expect(matcherMatchesSdk(claude('.*opus.*'), event, switchTo(event, 'claude-opus-5'))).toBe(true);
    expect(matcherMatchesSdk(claude('.*opus.*'), event, switchTo(event, 'claude-sonnet-5'))).toBe(false);
  });

  it.each(EVENTS)('%s: the exact-name and `|`-list matchers compare the canonical name', (event) => {
    // "`claude-opus-5` covers every spelling of Opus 5"
    expect(matcherMatchesSdk(claude('claude-opus-5'), event, switchTo(event, 'claude-opus-5[1m]'))).toBe(true);
    expect(matcherMatchesSdk(claude('claude-opus-4-6|claude-opus-5'), event,
      switchTo(event, 'us.anthropic.claude-opus-4-6-v1:0'))).toBe(true);
    // An exact name is exact: Opus 4.6 is not Opus 5.
    expect(matcherMatchesSdk(claude('claude-opus-5'), event, switchTo(event, 'claude-opus-4-6'))).toBe(false);
  });

  it.each(EVENTS)('%s: a native (unanchored-regex) matcher reads the same canonical name', (event) => {
    expect(matcherMatchesSdk(native('opus'), event, switchTo(event, 'claude-opus-5-20260101'))).toBe(true);
    expect(matcherMatchesSdk(native('opus'), event, switchTo(event, 'claude-sonnet-5'))).toBe(false);
  });

  it.each(EVENTS)('%s: a target with no canonical name runs every hook regardless of matcher', (event) => {
    // "it runs every PreModelSwitch hook regardless of matcher" — a gateway id,
    // an unresolved alias, and a cleared session model (no `to_model`).
    for (const toModel of ['tgpt/qwen35-397b-a17b-fp8', 'opus', undefined]) {
      expect(getMatchValueForSdkInput(event, switchTo(event, toModel))).toBe('');
      expect(matcherMatchesSdk(claude('claude-opus-4-6'), event, switchTo(event, toModel))).toBe(true);
      expect(matcherMatchesSdk(native('^claude-opus-4-6$'), event, switchTo(event, toModel))).toBe(true);
    }
    // The matcher is what is ignored, not `enabled: false`.
    expect(matcherMatchesSdk({ ...claude('claude-opus-4-6'), enabled: false }, event,
      switchTo(event, 'tgpt/qwen35-397b-a17b-fp8'))).toBe(false);
  });
});

describe('the documented model-switch hooks through the real executor', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ub12-102-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** A hooks file in Claude's settings shape, loaded the way every native door loads it. */
  function systemFor(document: unknown): PluginScopedAutomationSystem {
    const parsed = parseHooksConfigContent(JSON.stringify(document), 'ub12-102 fixture');
    expect(parsed.errors).toEqual([]);
    return new PluginScopedAutomationSystem({
      userGlobalHookConfig: parsed.config,
      pluginHookConfig: { automations: {} },
      workspaceRootPath: tempDir,
      workingDir: tempDir,
      allowDirectCommandRunner: true,
    });
  }

  it('hooks.md#postmodelswitch\'s own example: `.*opus.*` runs on an Opus target and not on Sonnet', async () => {
    const guidance = 'On Opus, delegate implementation work to subagents and keep this conversation for planning and review.';
    const system = systemFor({
      hooks: {
        PostModelSwitch: [{ matcher: '.*opus.*', hooks: [{ type: 'command', command: `echo '${guidance}'` }] }],
      },
    });

    const opus = await system.executeAgentEvent('PostModelSwitch', switchTo('PostModelSwitch', 'claude-opus-5'));
    expect(opus.matchedCount).toBe(1);
    expect(opus.decision?.additionalContext).toBe(guidance);

    const sonnet = await system.executeAgentEvent('PostModelSwitch', switchTo('PostModelSwitch', 'claude-sonnet-5'));
    expect(sonnet.matchedCount).toBe(0);
    expect(sonnet.decision?.additionalContext).toBeUndefined();
  });

  it('a PreModelSwitch veto named `claude-opus-4-6` blocks a Bedrock-spelled Opus 4.6 and lets Opus 5 through', async () => {
    const system = systemFor({
      hooks: {
        PreModelSwitch: [{
          matcher: 'claude-opus-4-6',
          hooks: [{ type: 'command', command: "echo 'Opus 4.6 is retired for this project. Use a newer model.' >&2; exit 2" }],
        }],
      },
    });

    const retired = await system.executeAgentEvent('PreModelSwitch', switchTo('PreModelSwitch', 'us.anthropic.claude-opus-4-6-v1:0'));
    expect(retired.matchedCount).toBe(1);
    expect(isBlockingHookDecision(retired.decision)).toBe(true);

    const newer = await system.executeAgentEvent('PreModelSwitch', switchTo('PreModelSwitch', 'claude-opus-5'));
    expect(newer.matchedCount).toBe(0);
    expect(isBlockingHookDecision(newer.decision)).toBe(false);
  });
});
