/**
 * F1.493 (2) (3/3) (origin WJ-yy P-WJ-yy-3) — the codex agent names the SUBAGENT a bridged session-tool call came
 * from, and tells the host when that subagent ended, so a host card a codex subagent raised lives and dies with it
 * (F1.475's claude shape: `raisingOriginOf` stamps `raisingAgent`, `onSubagentEnded` declines it).
 *
 * Measured on the shipped `codex-app-server` 0.156.1 (the lane's probe, `work/wjbp/`): a `spawn_agent` child's MCP
 * `tools/call` carries `_meta.threadId` = the CHILD thread (the parent's collab item's `receiverThreadIds[0]`),
 * a main-thread call carries the main thread's id, and the child ran and called the tool AFTER the parent's turn had
 * completed. The child's turn then streamed `turn/completed` on the same connection with the child's `threadId`.
 * The bridge carries `threadId` to the host scope (F1.493 (2) (1/3)); this agent answers from it.
 *
 * THE DEFECT — a child thread's call named no subagent, so its card was stamped with the running parent turn.
 * CONTROL — a main-thread call and a call naming no thread name none (F1.401's turn stamp stays), and the main
 * thread's own `turn/completed` ends no subagent. BOUNDARY — a child's new turn (a `send_input`) re-opens it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { CodexAgent } from '../codex-agent.ts';
import { cleanupModeState } from '../mode-manager.ts';
import type { BackendConfig } from '../backend/types.ts';
import type { SessionKey } from '../../sessions/session-key.ts';

const WS = 'ws-f1493';
const SESS = 'session-f1493';
const KEY: SessionKey = { workspaceId: WS, sessionId: SESS };
const MAIN = '01a0d437-6061-7311-bcb2-e6d5d734223a';
const CHILD = '01a0d437-8ba3-76b3-a621-403e22a71ffa';

afterEach(() => cleanupModeState(KEY));

function makeAgent() {
  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: { id: WS, name: 'F1.493', rootPath: '/tmp/ws-f1493', workspaceRootPath: '/tmp/ws-f1493', sessionRootPath: '/tmp/ws-f1493/sessions' } as never,
    session: { id: SESS, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: '/tmp/ws-f1493' } as never,
    model: 'codex/test-model',
    isHeadless: true,
  } as BackendConfig);
  (agent as unknown as { threadId: string | null }).threadId = MAIN;
  const structural = agent as unknown as {
    subagentOfToolUse?: (toolUseId: string, threadId?: string) => string | undefined;
    subagentEnded?: (agentId: string) => boolean;
    onSubagentEnded?: (agentId: string) => void;
    raisingTurnEnded?: (turnId: string) => boolean;
    handleNotification: (method: string, params: unknown) => void;
  };
  const ended: string[] = [];
  structural.onSubagentEnded = id => { ended.push(id); };
  return { agent, structural, ended };
}

describe('F1.493 (2) — a codex subagent\'s bridged call is named, and its end is reported', () => {
  it('THE DEFECT — a child thread\'s call names that child as the subagent', () => {
    const { structural } = makeAgent();
    expect(typeof structural.subagentOfToolUse).toBe('function');
    expect(structural.subagentOfToolUse?.('call_child_4', CHILD)).toBe(CHILD);
  });

  it('CONTROL — a main-thread call, and a call naming no thread, name no subagent', () => {
    const { structural } = makeAgent();
    expect(structural.subagentOfToolUse?.('call_parent_1', MAIN)).toBeUndefined();
    expect(structural.subagentOfToolUse?.('call_parent_1')).toBeUndefined();
  });

  it('THE END — the child\'s turn/completed reports that subagent ended; the main thread\'s own does not', () => {
    const { structural, ended } = makeAgent();
    structural.handleNotification('turn/started', { threadId: CHILD, turn: { id: 'turn-child-1', status: 'inProgress' } });
    expect(structural.subagentEnded?.(CHILD)).toBe(false);
    structural.handleNotification('turn/completed', { threadId: MAIN, turn: { id: 'turn-main-1', status: 'completed' } });
    expect(ended).toEqual([]);
    structural.handleNotification('turn/completed', { threadId: CHILD, turn: { id: 'turn-child-1', status: 'completed' } });
    expect(ended).toEqual([CHILD]);
    expect(structural.subagentEnded?.(CHILD)).toBe(true);
  });

  it('BOUNDARY — a child\'s later turn re-opens it, and a closed child thread ends it', () => {
    const { structural, ended } = makeAgent();
    structural.handleNotification('turn/completed', { threadId: CHILD, turn: { id: 'turn-child-1', status: 'completed' } });
    structural.handleNotification('turn/started', { threadId: CHILD, turn: { id: 'turn-child-2', status: 'inProgress' } });
    expect(structural.subagentEnded?.(CHILD)).toBe(false);
    structural.handleNotification('thread/closed', { threadId: CHILD });
    expect(ended).toEqual([CHILD, CHILD]);
    expect(structural.subagentEnded?.(CHILD)).toBe(true);
  });

  it('F1.631 — raisingTurnEnded answers whether the named turn is still activeTurnId', () => {
    const { structural } = makeAgent();
    expect(typeof structural.raisingTurnEnded).toBe('function');
    // No turn seen yet: any named turn is over (a tool call always runs inside a turn).
    expect(structural.raisingTurnEnded?.('turn-main-1')).toBe(true);
    structural.handleNotification('turn/started', { threadId: MAIN, turn: { id: 'turn-main-1', status: 'inProgress' } });
    expect(structural.raisingTurnEnded?.('turn-main-1')).toBe(false);
    structural.handleNotification('turn/completed', { threadId: MAIN, turn: { id: 'turn-main-1', status: 'completed' } });
    expect(structural.raisingTurnEnded?.('turn-main-1')).toBe(true);
    // A NEWER turn does not revive the old id.
    structural.handleNotification('turn/started', { threadId: MAIN, turn: { id: 'turn-main-2', status: 'inProgress' } });
    expect(structural.raisingTurnEnded?.('turn-main-1')).toBe(true);
    expect(structural.raisingTurnEnded?.('turn-main-2')).toBe(false);
  });
});
