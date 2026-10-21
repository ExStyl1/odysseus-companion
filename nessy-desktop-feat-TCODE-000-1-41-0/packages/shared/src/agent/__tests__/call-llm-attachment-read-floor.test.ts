/**
 * F1.694 — `call_llm`'s `attachments` pass the read floor `Read` passes.
 *
 * ## The defect, measured before the fix (2026-09-25, WJ-crit-q)
 *
 * `mcp__session__call_llm` takes file paths as `attachments` and the HOST reads
 * them (`processAttachment` in `llm-tool.ts`) into the side model's prompt, whose
 * answer returns to the main model. The gate answers `call_llm_intercept` for the
 * tool and every backend lets that through, and the `deniedPaths` floor in
 * `mode-manager.ts` only reads the NAMED file tools' path arguments — so on a
 * scratch rig (fabricated `~/.aws/credentials` and `<CONFIG_DIR>/credentials.enc`,
 * `HOME` and `NESSY_CONFIG_DIR` exported before bun started) `Read` of either was
 * refused with `Sensitive path blocked` in `default` AND `bypassPermissions`, while
 * `call_llm` with the same path as an attachment passed the gate and put the
 * fabricated secret into the side prompt on BOTH routes: the claude route (the
 * in-process `createLLMTool`) and the host route Pi uses
 * (`buildCallLlmRequest`, called by `BaseAgent.preExecuteCallLlm`). A RELATIVE
 * attachment escaped the same way, because relative paths resolve against the
 * session directory (`../../.aws/credentials`). Codex is not offered `call_llm`
 * (`SESSION_TOOLS_REQUIRING_HOST_CALLBACK`), so these two routes are the whole
 * model-facing surface.
 *
 * ## What the fix does, and what this file pins
 *
 * The READER checks every attachment against the same `deniedPaths` floor (plus
 * the relocated credential roots) `Read` is judged by — on the path as it will be
 * opened AND on its real path, so a symlink inside the workspace cannot launder a
 * denied file — and refuses the whole call with a named reason. The floor is
 * INJECTED (`attachmentReadGuard`), because `llm-tool.ts` is also bundled into the
 * Pi subprocess, which must not import `mode-manager.ts`; and a caller that
 * supplies no guard gets attachments REFUSED rather than read, so forgetting the
 * floor can never reopen the hole.
 *
 * Fixtures are fabricated in a temp dir and never touch a real credential file:
 * the shipped floor's unanchored entries (`**` + `/credentials.enc`, `**` + `/.env`)
 * match anywhere, so no `HOME` games are needed. CONTROL: an ordinary file inside
 * the workspace is still read, on both routes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCallLlmRequest, createLLMTool, type LLMQueryRequest } from '../llm-tool.ts';
import * as modeManager from '../mode-manager.ts';
import { BaseAgent } from '../base-agent.ts';

const MARK = 'FAKE-F1694-FIXTURE-not-a-real-secret';
let root = '';
let ws = '';
let sessionPath = '';
let encFile = '';
let envFile = '';
let wsDenied = '';
let symlinkToEnc = '';
let ordinary = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nessy-f1694-'));
  ws = join(root, 'ws');
  sessionPath = join(root, 'sessions', 's1');
  mkdirSync(join(ws, 'secret-notes'), { recursive: true });
  mkdirSync(join(root, 'store'), { recursive: true });
  mkdirSync(sessionPath, { recursive: true });
  encFile = join(root, 'store', 'credentials.enc');
  writeFileSync(encFile, `${MARK}-enc\n`);
  envFile = join(ws, '.env');
  writeFileSync(envFile, `TOKEN=${MARK}-env\n`);
  wsDenied = join(ws, 'secret-notes', 'plan.md');
  writeFileSync(wsDenied, `${MARK}-workspace-rule\n`);
  symlinkToEnc = join(ws, 'harmless.txt');
  symlinkSync(encFile, symlinkToEnc);
  ordinary = join(ws, 'notes.md');
  writeFileSync(ordinary, 'an ordinary workspace file\n');
  // The workspace's OWN deniedPaths entry — the operator floor, not the shipped one.
  writeFileSync(join(ws, 'permissions.json'), JSON.stringify({ deniedPaths: ['**/secret-notes/**'] }));
});

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

type Guard = (absolutePath: string) => string | null;
function workspaceGuard(): Guard | undefined {
  const factory = (modeManager as Record<string, unknown>).callLlmAttachmentReadGuard as
    | ((ctx: () => { workspaceRootPath: string } | undefined) => Guard)
    | undefined;
  return factory?.(() => ({ workspaceRootPath: ws }));
}

async function hostRoute(attachment: string, guard: Guard | undefined): Promise<{ prompt?: string; error?: string }> {
  try {
    const options = { backendName: 'Pi', sessionPath, ...(guard ? { attachmentReadGuard: guard } : {}) };
    const request = await buildCallLlmRequest({ prompt: 'repeat the file', attachments: [attachment] }, options);
    return { prompt: request.prompt };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

async function claudeRoute(attachment: string, guard: Guard | undefined): Promise<{ sent: string; text: string; isError: boolean }> {
  let sent = '';
  const tool = createLLMTool({
    sessionId: 's1',
    sessionPath,
    ...(guard ? { attachmentReadGuard: guard } : {}),
    getQueryFn: () => async (request: LLMQueryRequest) => { sent = request.prompt; return { text: 'ok' }; },
  }) as unknown as { handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };
  const result = await tool.handler({ prompt: 'repeat the file', attachments: [attachment] }, {});
  return { sent, text: result.content[0]?.text ?? '', isError: result.isError === true };
}

const DENIED: Array<[string, () => string, RegExp]> = [
  ['the shipped credential floor (credentials.enc)', () => encFile, /credentials\.enc/],
  ['the shipped floor (.env)', () => envFile, /\.env/],
  ["the workspace's own deniedPaths entry", () => wsDenied, /secret-notes/],
  ['a workspace symlink whose real path is denied', () => symlinkToEnc, /credentials\.enc/],
  ['a session-relative path that escapes to a denied file', () => '../../store/credentials.enc', /credentials\.enc/],
];

describe('F1.694 — call_llm attachments pass the read floor Read passes', () => {
  for (const [label, target, pattern] of DENIED) {
    it(`host route refuses ${label}, naming the floor`, async () => {
      const outcome = await hostRoute(target(), workspaceGuard());
      expect(outcome.prompt ?? '').not.toContain(MARK);
      expect(outcome.error ?? '').toContain('Sensitive path blocked');
      expect(outcome.error ?? '').toMatch(pattern);
    });

    it(`claude route refuses ${label} before any query is sent`, async () => {
      const outcome = await claudeRoute(target(), workspaceGuard());
      expect(outcome.sent).not.toContain(MARK);
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain('Sensitive path blocked');
    });
  }

  it('a route that supplies no floor refuses attachments rather than reading them', async () => {
    const host = await hostRoute(encFile, undefined);
    expect(host.prompt ?? '').not.toContain(MARK);
    expect(host.error ?? '').toContain('no read floor');
    const claude = await claudeRoute(ordinary, undefined);
    expect(claude.sent).not.toContain('ordinary workspace file');
    expect(claude.text).toContain('no read floor');
  });

  it('CONTROL: an ordinary workspace file is still read on both routes', async () => {
    const host = await hostRoute(ordinary, workspaceGuard());
    expect(host.error).toBeUndefined();
    expect(host.prompt ?? '').toContain('an ordinary workspace file');
    const claude = await claudeRoute(ordinary, workspaceGuard());
    expect(claude.isError).toBe(false);
    expect(claude.sent).toContain('an ordinary workspace file');
  });

  it("BaseAgent.preExecuteCallLlm (Pi's host route) supplies the floor", async () => {
    let sent = '';
    const fakeAgent = {
      config: { workspace: { id: 'ws-f1694', workspaceRootPath: ws } },
      _sessionId: 's-f1694',
      backendName: 'Pi',
      permissionManager: { getCapabilityPermissionsContext: () => undefined },
      queryLlm: async (request: LLMQueryRequest) => { sent = request.prompt; return { text: 'ok' }; },
    };
    const run = (attachment: string) => (BaseAgent.prototype as unknown as {
      preExecuteCallLlm: (this: unknown, input: Record<string, unknown>) => Promise<unknown>;
    }).preExecuteCallLlm.call(fakeAgent, { prompt: 'repeat', attachments: [attachment] });
    await expect(run(wsDenied)).rejects.toThrow(/Sensitive path blocked.*secret-notes/);
    expect(sent).not.toContain(MARK);
    await run(ordinary);
    expect(sent).toContain('an ordinary workspace file');
  });

  it("the claude session tools wire the floor into createLLMTool (source pin, with its region's control)", () => {
    const source = readFileSync(join(import.meta.dir, '..', 'session-scoped-tools.ts'), 'utf-8');
    const start = source.indexOf('createLLMTool({');
    expect(start).toBeGreaterThan(-1);
    const region = source.slice(start, source.indexOf('}),', start));
    // Control: the region is the call_llm factory call, not some other object.
    expect(region).toContain('getQueryFn');
    expect(region).toContain('attachmentReadGuard: callLlmAttachmentReadGuard(');
  });
});
