import { describe, expect, it } from 'bun:test';
import { delimiter } from 'node:path';
import type { SdkAutomationCallbackMatcher } from '../../automations/types.ts';
import {
  ClaudeAgent,
  mergeClaudeSdkHooks,
  runClaudePreToolUseHookPipeline,
} from '../claude-agent.ts';

describe('ClaudeAgent selected plugin runtime', () => {
  it('builds a child-only runtime env and writable data roots', () => {
    const agent = Object.create(ClaudeAgent.prototype) as any;
    agent.config = {
      pluginNodeRuntime: {
        command: '/private/nessy/runtime/bun',
        nodeShimDirectory: '/private/nessy/runtime/bin',
        environment: { ELECTRON_RUN_AS_NODE: '1' },
      },
    };
    agent.activePluginSkillRuntimes = [{
      pluginInstanceId: 'plugin://honey@1.1.0',
      runtime: {
        profile: 'claude-plugin-env-v1',
        rootPath: '/private/nessy/plugins/honey',
        dataPath: '/private/nessy/plugin-data/honey',
        projectPath: '/private/nessy/project',
      },
    }];

    expect(agent.resolveSelectedPluginSkillRuntimePolicy()).toEqual({
      environment: {
        NESSY_PLUGIN_ROOT: '/private/nessy/plugins/honey',
        PLUGIN_ROOT: '/private/nessy/plugins/honey',
        NESSY_PLUGIN_DATA: '/private/nessy/plugin-data/honey',
        PLUGIN_DATA: '/private/nessy/plugin-data/honey',
        NESSY_PROJECT_DIR: '/private/nessy/project',
        CLAUDE_PLUGIN_ROOT: '/private/nessy/plugins/honey',
        CLAUDE_PLUGIN_DATA: '/private/nessy/plugin-data/honey',
        CLAUDE_CONFIG_DIR: '/private/nessy/plugin-data/honey',
        CLAUDE_PROJECT_DIR: '/private/nessy/project',
        ELECTRON_RUN_AS_NODE: '1',
        NESSY_BUN: '/private/nessy/runtime/bun',
        PATH: `/private/nessy/runtime/bin${delimiter}${process.env.PATH ?? ''}`,
      },
      writablePaths: ['/private/nessy/plugin-data/honey'],
    });
  });

  it('keeps one host-owned PreToolUse callback while preserving other trusted SDK hooks', async () => {
    const calls: string[] = [];
    const matcher = (name: string): SdkAutomationCallbackMatcher => ({
      hooks: [async () => {
        calls.push(name);
        return { continue: true };
      }],
    });
    const merged = mergeClaudeSdkHooks(
      { PreToolUse: [matcher('internal')] },
      { PreToolUse: [matcher('trusted')], PostToolUse: [matcher('post')] },
    );
    expect(merged.PreToolUse).toHaveLength(1);
    expect(merged.PostToolUse).toHaveLength(1);
    await merged.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse' }, 'tool-1', {});
    await merged.PostToolUse![0]!.hooks[0]!({ hook_event_name: 'PostToolUse' }, 'tool-1', {});
    expect(calls).toEqual(['internal', 'post']);
  });

  it('revalidates the exact trusted-hook rewrite and preserves deny/ask floors', async () => {
    const seen: Record<string, unknown>[] = [];
    const automationSystem = {
      async executeAgentEvent() {
        return {
          matchedCount: 1,
          decision: {
            decision: 'ask' as const,
            updatedInput: { file_path: '/private/nessy/credentials.enc' },
            reason: 'review rewritten input',
          },
        };
      },
    };
    const rewritten = await runClaudePreToolUseHookPipeline({
      automationSystem,
      hookInput: {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/workspace/README.md', limit: 20 },
      },
      revalidate(input) {
        seen.push(input);
        return input.file_path === '/private/nessy/credentials.enc' ? 'blocked' : 'allowed';
      },
    });
    expect(rewritten).toMatchObject({
      kind: 'validated',
      hookDecision: 'ask',
      hookReason: 'review rewritten input',
      validation: 'blocked',
      input: { file_path: '/private/nessy/credentials.enc', limit: 20 },
    });
    expect(seen).toEqual([{ file_path: '/private/nessy/credentials.enc', limit: 20 }]);

    let denyRevalidated = false;
    const denied = await runClaudePreToolUseHookPipeline({
      automationSystem: {
        async executeAgentEvent() {
          return { matchedCount: 1, decision: { decision: 'deny' as const, reason: 'denied' } };
        },
      },
      hookInput: { hook_event_name: 'PreToolUse', tool_input: { command: 'pwd' } },
      revalidate() {
        denyRevalidated = true;
      },
    });
    expect(denied).toEqual({ kind: 'blocked', reason: 'denied' });
    expect(denyRevalidated).toBe(false);
  });
});
