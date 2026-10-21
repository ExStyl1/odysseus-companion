/**
 * F1.709 (origin WJ-crit-q P-WJcritq-2) — the claude `call_llm` attachment floor
 * reads the SAME permissions context the claude pre-tool gate reads.
 *
 * ## The defect
 *
 * F1.694 gave both `call_llm` readers a floor. The host route Pi uses
 * (`BaseAgent.preExecuteCallLlm`) builds it from the agent's pinned capability
 * context; the claude route (`getSessionScopedTools` → `createLLMTool`) built it
 * from `{ workspaceRootPath }` alone. `permissionsConfigCache.getMergedConfig`
 * merges `pinnedConfigs` only when the context carries them, so a `deniedPaths`
 * entry that exists only in a pinned capability layer — a managed (`builtin`)
 * layer, or a revision-pinned workspace or plugin document — never reached the
 * claude attachment check, while `Read` of the same path was refused by the gate.
 *
 * ## The fix, and what this file pins
 *
 * The claude agent publishes its gate's context through the session callback
 * registry (`gatePermissionsContextFn`, the expression `runPreToolUseChecks`
 * evaluates), and the claude `call_llm` guard reads that slot on every call. The
 * rig is the REAL `ClaudeAgent` constructor's registration and the REAL
 * `call_llm` handler the session MCP server registered; only the side query is a
 * recorder, so nothing is spawned. Fixtures are fabricated in a temp dir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BackendConfig } from '../backend/types.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import type { LLMQueryRequest } from '../llm-tool.ts';
import { shouldAllowToolInMode } from '../mode-manager.ts';
import { getSessionScopedTools, invalidateAllSessionToolsCaches } from '../session-scoped-tools.ts';
import { mergeSessionScopedToolCallbacks } from '../session-scoped-tool-callback-registry.ts';

const MARK = 'FAKE-F1709-FIXTURE-not-a-real-secret';
const WORKSPACE_ID = 'ws-f1709';
let root = '';
let ws = '';
let pinnedOnly = '';
let ordinary = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nessy-f1709-'));
  ws = join(root, 'ws');
  mkdirSync(join(ws, 'managed-secret'), { recursive: true });
  pinnedOnly = join(ws, 'managed-secret', 'plan.md');
  writeFileSync(pinnedOnly, `${MARK}\n`);
  ordinary = join(ws, 'notes.md');
  writeFileSync(ordinary, 'an ordinary workspace file\n');
  // The LIVE workspace file names nothing about `managed-secret`: the entry
  // exists only in the pinned managed layer below.
  writeFileSync(join(ws, 'permissions.json'), JSON.stringify({ deniedPaths: ['**/unrelated/**'] }));
});

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

function createConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    workspace: {
      id: WORKSPACE_ID,
      name: 'F1.709 Workspace',
      rootPath: ws,
      workspaceRootPath: ws,
      sessionRootPath: join(root, 'sessions'),
    } as never,
    session: {
      id: sessionId,
      workspaceRootPath: ws,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: ws,
      permissionMode: 'default',
    } as never,
    model: 'claude-sonnet-4-5',
    isHeadless: true,
  } as BackendConfig;
}

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

/** A real claude agent for `sessionId`, its real `call_llm` handler, and what the side query was sent. */
function claudeSession(sessionId: string) {
  const agent = new ClaudeAgent(createConfig(sessionId));
  (agent as unknown as { debug: (m: string) => void }).debug = () => {};
  const sent: string[] = [];
  // Only the side query is replaced (MERGE keeps the agent's other slots).
  mergeSessionScopedToolCallbacks({ workspaceId: WORKSPACE_ID, sessionId }, {
    queryFn: async (request: LLMQueryRequest) => { sent.push(request.prompt); return { text: 'ok' }; },
  });
  invalidateAllSessionToolsCaches();
  const server = getSessionScopedTools(sessionId, ws, WORKSPACE_ID, ws) as unknown as {
    instance: { _registeredTools: Record<string, { handler: Handler }> };
  };
  const callLlm = server.instance._registeredTools.call_llm;
  if (!callLlm) throw new Error('no registered call_llm');
  const attach = async (attachment: string) => {
    const result = await callLlm.handler({ prompt: 'repeat the file', attachments: [attachment] }, {});
    return { text: result.content[0]?.text ?? '', isError: result.isError === true };
  };
  return { agent, sent, attach };
}

/** Pin one managed (`builtin`) capability layer whose only content is a deniedPaths entry. */
function pinManagedDeny(agent: ClaudeAgent): void {
  agent.getPermissionManager().setCapabilityPermissionLayers(
    [{ content: JSON.stringify({ deniedPaths: ['**/managed-secret/**'] }), scope: 'builtin' }],
    'rev-f1709',
  );
}

describe('F1.709 — the claude call_llm attachment floor reads the gate’s pinned context', () => {
  it('a path denied only in a pinned managed layer is refused, though the tools were built before the pin', async () => {
    const { agent, sent, attach } = claudeSession('s-f1709-pinned');
    try {
      pinManagedDeny(agent);
      // The fixture's premise: the claude gate refuses `Read` of this path on the pinned context.
      const permissionsContext = agent.getPermissionManager().getCapabilityPermissionsContext()!;
      expect(shouldAllowToolInMode('Read', { file_path: pinnedOnly }, 'default', { permissionsContext })).toMatchObject({ allowed: false, denyPathBlocked: true });
      const outcome = await attach(pinnedOnly);
      expect(sent.join('\n')).not.toContain(MARK);
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain('Sensitive path blocked');
      expect(outcome.text).toContain('managed-secret');
    } finally {
      agent.destroy();
    }
  });

  it('CONTROL: under the same pinned context an ordinary workspace file still attaches', async () => {
    const { agent, sent, attach } = claudeSession('s-f1709-control');
    try {
      pinManagedDeny(agent);
      const outcome = await attach(ordinary);
      expect(outcome.isError).toBe(false);
      expect(sent.join('\n')).toContain('an ordinary workspace file');
    } finally {
      agent.destroy();
    }
  });
});
