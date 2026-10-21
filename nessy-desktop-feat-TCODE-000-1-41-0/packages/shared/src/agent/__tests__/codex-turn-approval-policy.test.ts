/**
 * P6.223 — a codex permission-mode change used to respawn the app-server, while
 * codex's own `turn/start` declares the override.
 *
 * `config.toml` carries `approval_policy`/`sandbox_mode` and the app-server reads
 * it only at START, so `setPermissionMode` set `pendingModeRestart` and
 * `ensureRuntime` tore the runtime down. Pi and claude apply the same call live.
 *
 * The mode now reaches codex by two roads that need no restart: the approval half
 * on `turn/start`'s declared `approvalPolicy`, and the sandbox half on the
 * per-turn config-drift re-fork, whose emitted profile `extends`
 * `:read-only`/`:workspace` off the mode.
 *
 * WHAT EACH TEST KILLS:
 *  - "carries the policy … and the NEW one after a change" dies if the field is
 *    dropped: the mode change would then reach codex only on the next runtime
 *    build, which is the shipped defect.
 *  - "does not tear the runtime down" dies if the respawn is restored — the
 *    whole point of the row, and the thing a reader cannot see from the wire.
 *  - "still re-forks for the sandbox half" dies if someone 'simplifies' the
 *    drift walk away on the grounds that the turn now carries the mode: the
 *    profile is what codex actually resolves, and it rides the fork.
 *  - "degrades exactly as the config writer would" dies if the table is restated
 *    here instead of derived — the unbounded `never`/`on-request` degradations
 *    (R13, P2.197) are the case where a second spelling is a security change.
 */
import { describe, expect, it } from 'bun:test';
import { CodexAgent } from '../codex-agent.ts';
import type { AgentEvent } from '../../automations/types.ts';

function createConfig(): any {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-turn-approval',
      name: 'Codex Turn Approval Workspace',
      rootPath: '/tmp/ws-codex-turn-approval',
      workspaceRootPath: '/tmp/ws-codex-turn-approval',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-turn-approval',
    } as any,
    session: {
      id: 'session-codex-turn-approval',
      workspaceRootPath: '/tmp/ws-codex-turn-approval',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

interface Recorded { method: string; params: any }

function stubTransport(agent: CodexAgent): { requests: Recorded[]; teardowns: number[] } {
  const requests: Recorded[] = [];
  const teardowns: number[] = [];
  const client = {
    request(method: string, params: any) {
      requests.push({ method, params });
      if (method === 'turn/start') {
        queueMicrotask(() => (agent as any).handleNotification('turn/completed', {}));
      }
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
  const realTeardown = (agent as any).teardownRuntime.bind(agent);
  (agent as any).teardownRuntime = async () => {
    teardowns.push(requests.length);
    await realTeardown();
  };
  (agent as any).debug = () => {};
  return { requests, teardowns };
}

async function drain(agent: CodexAgent, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of (agent as any).chatImpl(prompt)) events.push(event as AgentEvent);
  return events;
}

const starts = (requests: Recorded[]) =>
  requests.filter(entry => entry.method === 'turn/start').map(entry => entry.params);

describe('P6.223 · a codex mode change lands on the next turn, not on a respawn', () => {
  it('carries the approval policy, and the NEW one after a mid-session change', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const { requests } = stubTransport(agent);
      // Master switch ON. It is NOT the shipped default (owner decision
      // 2026-08-12 turned it off), and the off arm is its own case below —
      // without the switch every mode degrades to `untrusted` and this case
      // would be measuring the degradation rather than the mode.
      (agent as any).sandboxGloballyEnabled = () => true;
      agent.setPermissionMode('default' as never);
      await drain(agent, 'first');
      expect(starts(requests).map(p => p.approvalPolicy)).toEqual(['on-request']);

      agent.setPermissionMode('dontAsk' as never);
      await drain(agent, 'second');
      expect(starts(requests).map(p => p.approvalPolicy)).toEqual(['on-request', 'never']);
    } finally { agent.destroy(); }
  });

  it('does not tear the runtime down for the change', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const { requests, teardowns } = stubTransport(agent);
      agent.setPermissionMode('default' as never);
      await drain(agent, 'first');
      const mark = requests.length;
      agent.setPermissionMode('plan' as never);
      await drain(agent, 'second');
      expect(teardowns.filter(at => at >= mark)).toHaveLength(0);
      // Positive control on the same rig: the second turn really did run.
      expect(starts(requests)).toHaveLength(2);
    } finally { agent.destroy(); }
  });

  it('still re-forks the thread, because the sandbox half rides the profile', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const { requests } = stubTransport(agent);
      (agent as any).sandboxGloballyEnabled = () => true;
      agent.setPermissionMode('default' as never);
      await drain(agent, 'first');
      const mark = requests.length;
      // `default` is workspace-write and `plan` is read-only, so the emitted
      // profile's `extends` parent moves and the drift walk must fork.
      agent.setPermissionMode('plan' as never);
      await drain(agent, 'second');
      const after = requests.slice(mark);
      expect(after.filter(r => r.method === 'thread/fork')).toHaveLength(1);
    } finally { agent.destroy(); }
  });

  it('degrades exactly as the config writer would when the sandbox switch is off', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const { requests } = stubTransport(agent);
      // The SHIPPED DEFAULT, and it is the arm that matters most: with no
      // sandbox, `codexSandboxConfigForMode` answers `danger-full-access` for
      // every mode, so the profile parent does NOT move on a mode change and the
      // approval policy is the only thing a mode change alters at all — which is
      // exactly what `turn/start` now carries.
      (agent as any).sandboxGloballyEnabled = () => false;
      // R13 + P2.197: with no sandbox, `never` and `on-request` are both "no gate
      // at all" and the writer DEGRADES them. The turn must carry the pair the
      // file would have written, never the raw table row — that is the invariant
      // this case exists for, and it is unchanged.
      //
      // What changed is the degraded VALUE. It was `untrusted` until the codex
      // lift to `rust-v0.150.1`, where the release `config-schema.json`'s
      // `AskForApproval` dropped that member and `Config::load` raises
      // `UnsupportedUntrustedApprovalPolicyError` — measured on the shipped
      // binary, the app-server EXITS 1 before answering `initialize`, so every
      // codex session with the sandbox switch off would have failed to start.
      // `9375093b4` removed `untrusted` from `CodexApprovalPolicy` entirely and
      // degrades to `on-request`, the value codex's own error tells an operator
      // to fall back to; the loss is reported once per config write rather than
      // left silent. That commit repaired the writer's own suites and this one
      // was missed, which is why it reached the wave gate.
      agent.setPermissionMode('dontAsk' as never);
      await drain(agent, 'first');
      expect(starts(requests).map(p => p.approvalPolicy)).toEqual(['on-request']);
      // The retired value asserted ABSENT beside the successor: a regression that
      // re-introduced it would otherwise show up only as a session that will not
      // start, on a machine running the default settings.
      expect(starts(requests).map(p => p.approvalPolicy)).not.toContain('untrusted');
    } finally { agent.destroy(); }
  });
});
