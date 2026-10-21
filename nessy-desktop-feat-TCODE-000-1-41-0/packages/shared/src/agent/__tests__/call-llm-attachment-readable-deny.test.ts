/**
 * F1.1116 (origin DN-093, 2026-09-26) — a `call_llm` attachment is refused when
 * a readable permission rule denies `Read` of it.
 *
 * ## The defect, measured first (DN-280, 2026-09-29)
 *
 * F1.694 gave both `call_llm` readers the `deniedPaths` floor (plus the relocated
 * credential roots) that refuses `Read`. A `deny Read(...)` rule — a Claude-form
 * rule in the workspace `permissions.json`, or a managed `claudeRules` deny —
 * lives in the readable permission policy (`permissionDsl`), which the claude
 * gate asks for every `Read` (`claudeReadablePermissionDeny`) and Pi's gate asks
 * too, and which the attachment floor never read. So at HEAD `Read` of each file
 * below was refused by its rule while `call_llm` with the same file attached put
 * its content into the side prompt, on the host route Pi uses
 * (`BaseAgent.preExecuteCallLlm`) and on the claude route (the real
 * `ClaudeAgent` registration and the real `call_llm` handler).
 *
 * ## The fix, and what this file pins
 *
 * The guard asks the SAME merged policy the same way the claude gate asks it for
 * a `Read` of that path (`readablePermissionDenyOfAttachment`), anchored at the
 * session's working directory as `Read` is — so a RELATIVE rule
 * (`Read(./secret.txt)`, with a working directory that is not the workspace
 * root) binds too. CONTROL: an unruled file in the same folder is still read on
 * both routes. Fixtures are fabricated in a temp dir.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BackendConfig } from '../backend/types.ts';
import { BaseAgent } from '../base-agent.ts';
import { ClaudeAgent } from '../claude-agent.ts';
import { claudeReadablePermissionDeny } from '../claude-readable-permission-deny.ts';
import type { LLMQueryRequest } from '../llm-tool.ts';
import { getAttachmentReadFloorViolation } from '../mode-manager.ts';
import { permissionsConfigCache } from '../permissions-config.ts';
import { parseManagedPiPolicyV1, registerManagedPiPolicyProvider, resolveManagedPiPolicyFloor } from '../pi-harness/managed-policy.ts';
import { getSessionScopedTools, invalidateAllSessionToolsCaches } from '../session-scoped-tools.ts';
import { mergeSessionScopedToolCallbacks } from '../session-scoped-tool-callback-registry.ts';

const MARK = 'FAKE-F1116-FIXTURE-not-a-real-secret';
const WORKSPACE_ID = 'ws-f1116';
let root = '';
let ws = '';
let project = '';
let relativeDenied = '';
let absoluteDenied = '';
let managedDenied = '';
let ordinary = '';

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1116-')));
  ws = join(root, 'ws');
  project = join(root, 'project');
  mkdirSync(ws, { recursive: true });
  mkdirSync(project, { recursive: true });
  relativeDenied = join(project, 'secret.txt');
  absoluteDenied = join(project, 'absolute-secret.txt');
  managedDenied = join(project, 'managed-secret.txt');
  ordinary = join(project, 'notes.md');
  writeFileSync(relativeDenied, `${MARK}-relative\n`);
  writeFileSync(absoluteDenied, `${MARK}-absolute\n`);
  writeFileSync(managedDenied, `${MARK}-managed\n`);
  writeFileSync(ordinary, 'an ordinary project file\n');
  // The workspace's own readable rules, Claude-form: one anchored at the working
  // directory (`./`), one absolute (`//`). No `deniedPaths` entry names either.
  writeFileSync(join(ws, 'permissions.json'), JSON.stringify({
    permissions: { deny: ['Read(./secret.txt)', `Read(/${absoluteDenied})`] },
  }));
  const managed = parseManagedPiPolicyV1({ schemaVersion: 1, claudeRules: { deny: [`Read(/${managedDenied})`] } });
  registerManagedPiPolicyProvider(() => managed);
  permissionsConfigCache.clear();
});

afterAll(() => {
  registerManagedPiPolicyProvider(undefined);
  permissionsConfigCache.clear();
  if (root) rmSync(root, { recursive: true, force: true });
});

const DENIED: Array<[string, () => string]> = [
  ["the workspace's relative deny Read(./secret.txt)", () => relativeDenied],
  ["the workspace's absolute deny Read(//…)", () => absoluteDenied],
  ['a managed claudeRules deny Read(//…)', () => managedDenied],
];

/** Pi's host route: the REAL `BaseAgent.preExecuteCallLlm`, on a stand-in agent whose working directory is the project. */
async function hostRoute(attachment: string): Promise<{ sent: string; error?: string }> {
  let sent = '';
  const fakeAgent = {
    config: {
      workspace: { id: WORKSPACE_ID, workspaceRootPath: ws },
      session: { workingDirectory: project },
    },
    _sessionId: 's-f1116-host',
    backendName: 'Pi',
    permissionManager: { getCapabilityPermissionsContext: () => undefined },
    queryLlm: async (request: LLMQueryRequest) => { sent = request.prompt; return { text: 'ok' }; },
  };
  try {
    await (BaseAgent.prototype as unknown as {
      preExecuteCallLlm: (this: unknown, input: Record<string, unknown>) => Promise<unknown>;
    }).preExecuteCallLlm.call(fakeAgent, { prompt: 'repeat the file', attachments: [attachment] });
    return { sent };
  } catch (error) {
    return { sent, error: (error as Error).message };
  }
}

function createConfig(sessionId: string): BackendConfig {
  return {
    provider: 'anthropic',
    workspace: {
      id: WORKSPACE_ID,
      name: 'F1.1116 Workspace',
      rootPath: ws,
      workspaceRootPath: ws,
      sessionRootPath: join(root, 'sessions'),
    } as never,
    session: {
      id: sessionId,
      workspaceRootPath: ws,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: project,
      permissionMode: 'default',
    } as never,
    model: 'claude-sonnet-4-5',
    isHeadless: true,
  } as BackendConfig;
}

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;

/** The claude route: a real claude agent, its real `call_llm` handler, and what the side query was sent. */
async function claudeRoute(attachment: string): Promise<{ sent: string; text: string; isError: boolean }> {
  const sessionId = `s-f1116-claude-${Math.random().toString(36).slice(2)}`;
  const agent = new ClaudeAgent(createConfig(sessionId));
  (agent as unknown as { debug: (m: string) => void }).debug = () => {};
  try {
    const sent: string[] = [];
    mergeSessionScopedToolCallbacks({ workspaceId: WORKSPACE_ID, sessionId }, {
      queryFn: async (request: LLMQueryRequest) => { sent.push(request.prompt); return { text: 'ok' }; },
    });
    invalidateAllSessionToolsCaches();
    const server = getSessionScopedTools(sessionId, ws, WORKSPACE_ID, project) as unknown as {
      instance: { _registeredTools: Record<string, { handler: Handler }> };
    };
    const callLlm = server.instance._registeredTools.call_llm;
    if (!callLlm) throw new Error('no registered call_llm');
    const result = await callLlm.handler({ prompt: 'repeat the file', attachments: [attachment] }, {});
    return { sent: sent.join('\n'), text: result.content[0]?.text ?? '', isError: result.isError === true };
  } finally {
    agent.destroy();
  }
}

describe('F1.1116 — a call_llm attachment is refused by the readable rule that refuses Read of it', () => {
  it('PREMISE: Read of each fixture is denied by its readable rule, and the deniedPaths floor names none of them', () => {
    for (const [label, target] of DENIED) {
      const verdict = claudeReadablePermissionDeny({
        toolName: 'Read',
        inputs: [{ file_path: target() }],
        cwd: project,
        permissionsContext: { workspaceRootPath: ws },
        managedPolicy: resolveManagedPiPolicyFloor(),
      });
      expect({ label, kind: verdict?.kind }).toEqual({ label, kind: 'deny' });
      expect({ label, floor: getAttachmentReadFloorViolation(target(), { workspaceRootPath: ws }) }).toEqual({ label, floor: null });
    }
  });

  for (const [label, target] of DENIED) {
    it(`host route (Pi) refuses an attachment under ${label}, naming the rule`, async () => {
      const outcome = await hostRoute(target());
      expect(outcome.sent).not.toContain(MARK);
      expect(outcome.error ?? '').toContain('call_llm attachment');
      expect(outcome.error ?? '').toContain('Denied by readable permission policy');
    });

    it(`claude route refuses an attachment under ${label} before any query is sent`, async () => {
      const outcome = await claudeRoute(target());
      expect(outcome.sent).not.toContain(MARK);
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain('Denied by readable permission policy');
    });
  }

  it('CONTROL: an unruled file in the same folder is still read on both routes', async () => {
    const host = await hostRoute(ordinary);
    expect(host.error).toBeUndefined();
    expect(host.sent).toContain('an ordinary project file');
    const claude = await claudeRoute(ordinary);
    expect(claude.isError).toBe(false);
    expect(claude.sent).toContain('an ordinary project file');
  });
});
