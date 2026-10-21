/**
 * F1.788 (origin WJ-crit-ff P-WJcritff-2, 2026-09-25) — the host never sent codex's `collaborationMode`, so every
 * codex session ran in codex's Default collaboration mode: `request_user_input` refused, codex's own Plan-mode rules
 * never reached the model, and `plan_mode_reasoning_effort` (P6.368) never applied.
 *
 * Decided (owner rule 2026-10-08, runtime-native): every `turn/start` carries codex's own collaboration mode —
 * `plan` in Plan, `default` otherwise (the field is sticky, so each turn says it again). `developer_instructions` is
 * sent as `null` so codex fills in its own preset text: `normalize_collaboration_mode`
 * (`codex-rs/app-server/src/request_processors/turn_processor.rs`, `rust-v0.159.3`, the bundled binary's version)
 * copies the built-in preset's instructions when the client sends none. A complete collaboration mode "takes
 * precedence over model and effort edits" (`codex-rs/core/src/session/step_settings.rs`), so its `model` and
 * `reasoning_effort` are the turn's model and effort.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { CodexAgent } from '../codex-agent.ts';

function createConfig(): any {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-collab-mode',
      name: 'Codex Collaboration Mode Workspace',
      rootPath: '/tmp/ws-codex-collab-mode',
      workspaceRootPath: '/tmp/ws-codex-collab-mode',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-collab-mode',
    } as any,
    session: {
      id: 'session-codex-collab-mode',
      workspaceRootPath: '/tmp/ws-codex-collab-mode',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/** The F1.373 / F1.482 stub rig: records every request, completes each turn at once. */
function stubTransport(agent: CodexAgent): Array<{ method: string; params: any }> {
  const requests: Array<{ method: string; params: any }> = [];
  const client = {
    request(method: string, params: any) {
      requests.push({ method, params });
      if (method === 'turn/start') queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
      return Promise.resolve({ thread: { id: 'thread-1' } });
    },
    notify() {},
    close() {},
  };
  (agent as any).ensureRuntime = async () => {
    (agent as any).client = client;
    (agent as any).threadId = 'thread-1';
    (agent as any).manager = (agent as any).manager ?? { kill: async () => {} };
  };
  (agent as any).autoReviewSettingOn = () => false;
  (agent as any).debug = () => {};
  return requests;
}

async function lastTurnStart(agent: CodexAgent, requests: Array<{ method: string; params: any }>): Promise<any> {
  for await (const _event of (agent as any).chatImpl('hello')) { /* drain */ }
  const starts = requests.filter(entry => entry.method === 'turn/start');
  return starts[starts.length - 1]?.params;
}

const ENV = 'NESSY_PLAN_MODE_EFFORT';
const savedEnv = process.env[ENV];
afterEach(() => {
  delete process.env[ENV];
  if (savedEnv !== undefined) process.env[ENV] = savedEnv;
});

describe('F1.788 · every codex turn carries codex\'s own collaboration mode', () => {
  it('Plan sends mode "plan" with the turn\'s model and effort and no instructions of ours', async () => {
    delete process.env[ENV];
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent);
      agent.setPermissionMode('plan' as never);
      const params = await lastTurnStart(agent, requests);
      expect(params.collaborationMode).toEqual({
        mode: 'plan',
        settings: { model: params.model, reasoning_effort: params.effort, developer_instructions: null },
      });
    } finally {
      agent.destroy();
    }
  });

  it('every other mode sends mode "default", again on each turn (the field is sticky)', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent);
      for (const mode of ['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk'] as const) {
        agent.setPermissionMode(mode as never);
        const params = await lastTurnStart(agent, requests);
        expect(`${mode}:${params.collaborationMode?.mode}`).toBe(`${mode}:default`);
        expect(params.collaborationMode.settings).toEqual({
          model: params.model, reasoning_effort: params.effort, developer_instructions: null,
        });
      }
    } finally {
      agent.destroy();
    }
  });

  it('the operator\'s plan-phase effort (P6.368) applies to Plan turns only', async () => {
    process.env[ENV] = 'low';
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent);
      agent.setPermissionMode('plan' as never);
      const plan = await lastTurnStart(agent, requests);
      expect(plan.collaborationMode.settings.reasoning_effort).toBe('low');
      agent.setPermissionMode('default' as never);
      const execute = await lastTurnStart(agent, requests);
      expect(execute.collaborationMode.settings.reasoning_effort).toBe(execute.effort);
    } finally {
      agent.destroy();
    }
  });
});
