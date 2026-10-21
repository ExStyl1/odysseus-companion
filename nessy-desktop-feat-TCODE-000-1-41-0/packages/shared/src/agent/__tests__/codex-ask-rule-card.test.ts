/**
 * F1.870 (origin WJ-crit-tt P-2) — a readable ASK rule holds on codex: F1.830's
 * codex twin.
 *
 * ## What was measured first (WJ-crit-xx, 2026-09-25, HEAD `123de1bcd`)
 *
 * The REAL `CodexAgent` approval bridge (`handleServerRequest`, fed the frames the
 * shipped binary sends — `codex-mcp-tool-approval-modes.test.ts`'s measured MCP
 * frame, R6's command frame) into the REAL `SessionManager` card path
 * (`handleAgentPermissionRequest` → `respondToPermission`), with an ask rule for
 * `npm publish` and for `mcp__linear__save_issue`, spelt both ways (a readable
 * DSL rule in the workspace `permissions.json`, and a `.claude/settings.json`
 * `ask` entry):
 *
 * - `bypassPermissions`: NO card for either — `handleServerRequest`'s P6.61
 *   branch answered `accept` because no FLOOR fired, and `consultPermissionRules`
 *   returned `null` for an ask exactly as for "no rule matched". So the ask
 *   rule's own `decision="prompt"` projection (P6.1) made codex ask, and our side
 *   said yes for the user.
 * - `default`, MCP: a card carrying F1.372's remember window (`commandHash` +
 *   `rememberForMinutes: 10`, `noAlwaysAllow: false`) that did not name the rule;
 *   after "Always allow" the next identical call was answered by the host's window
 *   with NO card.
 * - `default`, shell: a card that did not name the rule, whose "Always allow"
 *   answered codex `acceptForSession` — and codex skips its own prompt for a
 *   session-approved key (`openai/codex@rust-v0.156.1`,
 *   `codex-rs/core/src/tools/sandboxing.rs` `with_cached_approval`: "If all keys
 *   are already approved for session, we skip prompting") — and persists a
 *   durable allow grant when codex proposed an amendment (`persistExecpolicyGrant`).
 * - Controls: a deny rule refused in both modes and named itself; a no-rule MCP
 *   card kept its window.
 *
 * ## The fix this file pins (`CodexAgent`, the approval bridge, by symbol)
 *
 * `consultPermissionRules` carries a matched ask (never answers with it), and a
 * call it matches is carded in every mode that can ask — `bypassPermissions`
 * included — naming the rule, with no remember window: no F1.372 hash, Always
 * Allow hidden, and an Always answer honoured as a one-shot yes (no
 * `acceptForSession`, no persisted grant). Where nobody can be asked — `dontAsk`,
 * or an unattended turn even with the operator's escape hatch open — the call is
 * refused naming the rule (`dontAsk` since F1.886, pinned at the end of this file).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_ELICITATION_METHOD } from '@nessy-agent/codex-agent-server';
import type { BackendConfig, PermissionCallback } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';
import { UNATTENDED_APPROVAL_FALLBACK_ENV_VAR } from '../../config/unattended-approval.ts';
import { collectExecpolicyAllowPrefixes, loadRawWorkspacePermissions, permissionsConfigCache } from '../permissions-config.ts';
import type { PermissionMode } from '../mode-types.ts';

const EXEC_METHOD = 'item/commandExecution/requestApproval';
const ROOT = mkdtempSync(join(tmpdir(), 'f1870-codex-ask-'));
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }); });
beforeEach(() => { permissionsConfigCache.clear(); delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]; });
afterEach(() => { delete process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR]; });

type Subject = 'shell' | 'mcp';
type Rules = 'dsl-ask' | 'claude-ask' | 'dsl-deny' | 'none';
const DSL_ID: Record<Subject, string> = { shell: 'ask-npm-publish', mcp: 'ask-linear-save' };
let n = 0;

function rig(subject: Subject, rules: Rules, mode: PermissionMode, attended = true) {
  n += 1;
  const ws = join(ROOT, `ws-${n}`);
  mkdirSync(ws, { recursive: true });
  const matcher = subject === 'shell'
    ? { kind: 'bash', executable: 'npm', args: ['publish'] }
    : { kind: 'mcp', server: 'linear', tool: 'save_issue' };
  if (rules === 'dsl-ask' || rules === 'dsl-deny') {
    writeFileSync(join(ws, 'permissions.json'), JSON.stringify({
      permissionDsl: { version: 1, rules: [{ id: DSL_ID[subject], action: rules === 'dsl-deny' ? 'deny' : 'ask', match: matcher }] },
    }));
  }
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: { id: `ws-f1870-${n}`, name: 'F1.870', rootPath: ws, workspaceRootPath: ws, sessionRootPath: join(ws, 'sessions') } as never,
    session: { id: `session-f1870-${n}`, workspaceRootPath: ws, createdAt: Date.now(), lastUsedAt: Date.now(), workingDirectory: ws } as never,
    model: 'codex/test-model',
    isHeadless: true,
  };
  const agent = new CodexAgent(config);
  // F1.780 — while a deny entry reaches codex, Always Allow mints no durable rule whatever the ask
  // rule says (`codex-sandbox-retained-approval.test.ts`). Since F1.1057 a default session denies
  // nothing; the stub only undoes this suite's `$TMPDIR` config dir (F1.664), so the ask rule's own
  // refusal is the only thing that can stop the write.
  (agent as never as { codexDeniedReadPaths: () => string[] }).codexDeniedReadPaths = () => [];
  const surfaced: Array<Parameters<PermissionCallback>[0]> = [];
  agent.onDebug = () => {};
  if (attended) agent.onPermissionRequest = (request) => { surfaced.push(request); };
  agent.setPermissionMode(mode);
  if (rules === 'claude-ask') {
    agent.getPermissionManager().setCapabilityPermissionLayers(
      [{ content: JSON.stringify({ permissions: { ask: [subject === 'shell' ? 'Bash(npm publish:*)' : 'mcp__linear__save_issue'] } }), scope: 'workspace' }],
      'generation-f1870', true,
    );
  }
  const frame = subject === 'shell'
    ? { command: 'npm publish', cwd: ws, proposedExecpolicyAmendment: ['npm', 'publish'] }
    : {
      threadId: 'thread-f1870', turnId: 'turn-f1870', serverName: 'sources', mode: 'form',
      message: 'Allow the sources MCP server to run tool "linear__save_issue"?',
      _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params: { title: 'x' }, tool_params_display: [] },
      requestedSchema: { type: 'object', properties: {} },
    };
  const ask = () => (agent as never as { handleServerRequest(m: string, p: unknown): unknown })
    .handleServerRequest(subject === 'shell' ? EXEC_METHOD : MCP_ELICITATION_METHOD, frame) as Record<string, unknown> | Promise<Record<string, unknown>>;
  return { agent, ws, surfaced, ask };
}

const card = (surfaced: Array<Parameters<PermissionCallback>[0]>) => surfaced[0] as unknown as Record<string, unknown>;

describe('F1.870 · a readable ask rule cards on codex in every mode that can ask, naming the rule, with no remember window', () => {
  for (const subject of ['shell', 'mcp'] as const) {
    for (const rules of ['dsl-ask', 'claude-ask'] as const) {
      for (const mode of ['default', 'bypassPermissions'] as const) {
        it(`${subject} · ${rules} · ${mode}: a card that names the rule and offers no Always Allow`, () => {
          const { agent, surfaced, ask } = rig(subject, rules, mode);
          try {
            expect(ask()).toBeInstanceOf(Promise);
            expect(surfaced).toHaveLength(1);
            const shown = card(surfaced);
            expect(String(shown.description)).toContain('requires approval by readable permission policy rule');
            if (rules === 'dsl-ask') expect(String(shown.description)).toContain(DSL_ID[subject]);
            expect(shown.noAlwaysAllow).toBe(true);
            expect(shown.commandHash).toBeUndefined();
            expect(shown.rememberForMinutes).toBeUndefined();
          } finally { agent.destroy(); }
        });
      }
    }
  }

  it('shell · an Always answer on the ask-rule card is a ONE-SHOT yes: accept (never acceptForSession), and no durable grant', async () => {
    const { agent, ws, surfaced, ask } = rig('shell', 'dsl-ask', 'default');
    try {
      const answer = ask();
      agent.respondToPermission(surfaced[0]!.requestId, true, true);
      expect(await answer).toEqual({ decision: 'accept' });
      expect(collectExecpolicyAllowPrefixes(loadRawWorkspacePermissions(ws))).toEqual([]);
    } finally { agent.destroy(); }
  });

  it('dontAsk still refuses an ask-rule call with no card (F1.886 pins the sentence it names the rule in)', async () => {
    const { agent, surfaced, ask } = rig('mcp', 'dsl-ask', 'dontAsk');
    try {
      expect(await ask()).toEqual({ action: 'decline', content: null });
      expect(surfaced).toEqual([]);
    } finally { agent.destroy(); }
  });

  it('an unattended turn refuses an ask-rule call even with the operator escape hatch open', async () => {
    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    const { agent, ask } = rig('shell', 'dsl-ask', 'default', false);
    try {
      expect(await ask()).toEqual({ decision: 'decline' });
    } finally { agent.destroy(); }
  });
});

describe('F1.870 · CONTROLS — what the ask fix must not move', () => {
  it('a no-rule MCP card keeps F1.372\'s remember window (commandHash + 10 minutes, Always Allow offered)', () => {
    const { agent, surfaced, ask } = rig('mcp', 'none', 'default');
    try {
      void ask();
      const shown = card(surfaced);
      expect(shown.noAlwaysAllow).toBe(false);
      expect(shown.commandHash).toBe(createHash('sha256').update('mcp__linear__save_issue', 'utf8').digest('hex'));
      expect(shown.rememberForMinutes).toBe(10);
      expect(String(shown.description)).not.toContain('readable permission policy');
    } finally { agent.destroy(); }
  });

  it('a no-rule shell Always Allow still answers acceptForSession and persists the grant', async () => {
    const { agent, ws, surfaced, ask } = rig('shell', 'none', 'default');
    try {
      const answer = ask();
      agent.respondToPermission(surfaced[0]!.requestId, true, true);
      expect(await answer).toEqual({ decision: 'acceptForSession' });
      expect(collectExecpolicyAllowPrefixes(loadRawWorkspacePermissions(ws))).toEqual([['npm', 'publish']]);
    } finally { agent.destroy(); }
  });

  for (const subject of ['shell', 'mcp'] as const) {
    it(`${subject} · bypassPermissions with no rule still answers yes with no card`, async () => {
      const { agent, surfaced, ask } = rig(subject, 'none', 'bypassPermissions');
      try {
        const answer = ask();
        expect(answer).not.toBeInstanceOf(Promise);
        expect(await answer).toEqual(subject === 'shell' ? { decision: 'accept' } : { action: 'accept', content: {} });
        expect(surfaced).toEqual([]);
      } finally { agent.destroy(); }
    });

    for (const mode of ['default', 'bypassPermissions'] as const) {
      it(`${subject} · a deny rule still refuses with no card in ${mode}`, async () => {
        const { agent, surfaced, ask } = rig(subject, 'dsl-deny', mode);
        try {
          expect(await ask()).toEqual(subject === 'shell' ? { decision: 'decline' } : { action: 'decline', content: null });
          expect(surfaced).toEqual([]);
        } finally { agent.destroy(); }
      });
    }
  }

  it('an unattended turn with the escape hatch open still answers yes when no rule covers the call', async () => {
    process.env[UNATTENDED_APPROVAL_FALLBACK_ENV_VAR] = 'allow';
    const { agent, ask } = rig('shell', 'none', 'default', false);
    try {
      expect(await ask()).toEqual({ decision: 'accept' });
    } finally { agent.destroy(); }
  });
});

/**
 * F1.887 (origin WJ-crit-xx P-3) — the ask-rule card's lead sentence names the HOST tool the rule
 * matched (the rule consult's subject: `Bash` for a command, the host MCP name for a source tool), as
 * claude's and Pi's cards do, not codex's own card name (`shell`, `mcp__sources__…`).
 */
describe('F1.887 · the ask-rule card leads with the host tool name the rule matched', () => {
  const HOST_NAME: Record<Subject, string> = { shell: 'Bash', mcp: 'mcp__linear__save_issue' };
  for (const subject of ['shell', 'mcp'] as const) {
    it(`${subject} · the lead sentence names ${HOST_NAME[subject]}, and the rest of the card is the no-rule card's`, () => {
      const asked = rig(subject, 'dsl-ask', 'default');
      const plain = rig(subject, 'none', 'default');
      try {
        void asked.ask(); void plain.ask();
        const shown = card(asked.surfaced), control = card(plain.surfaced);
        expect(String(shown.description)).toBe(
          `${HOST_NAME[subject]} requires approval by readable permission policy rule \`${DSL_ID[subject]}\` (workspace scope).\n\n${String(control.description)}`,
        );
        expect(shown.toolName).toBe(control.toolName);
      } finally { asked.agent.destroy(); plain.agent.destroy(); }
    });
  }

  it('BOUNDARY: a claude-settings ask rule names the host tool too, never codex\'s card name', () => {
    const { agent, surfaced, ask } = rig('shell', 'claude-ask', 'bypassPermissions');
    try {
      void ask();
      const shown = card(surfaced);
      expect(String(shown.description)).toStartWith('Bash requires approval by readable permission policy rule');
      expect(String(shown.description)).not.toStartWith(`${String(shown.toolName)} requires`);
    } finally { agent.destroy(); }
  });
});

/**
 * F1.886 (origin WJ-crit-xx P-2) — `dontAsk` refuses an ask-rule call naming the rule, as the
 * unattended refusal above does (`codexAskRuleRefusal`), in the answer the model reads and in the
 * PermissionDenied hook payload. A call no rule covers keeps R13's own sentence (the control).
 */
describe('F1.886 · dontAsk refuses an ask-rule call naming the rule', () => {
  const R13 = 'Denied by the dontAsk permission mode: no permission rule pre-approves this, and the mode never prompts.';
  const named = (subject: Subject) => `Refused: this call requires approval by readable permission policy rule "${DSL_ID[subject]}" (workspace scope), and the dontAsk permission mode never prompts.`;
  const deniedErrors = (agent: CodexAgent) => {
    const errors: unknown[] = [];
    (agent as never as { emitAutomationEvent(event: string, input: Record<string, unknown>): Promise<unknown> })
      .emitAutomationEvent = async (event, input) => { if (event === 'PermissionDenied') errors.push(input.error); return undefined; };
    return errors;
  };
  for (const subject of ['shell', 'mcp'] as const) {
    it(`${subject} · the PermissionDenied payload names the rule, with no card`, async () => {
      const { agent, surfaced, ask } = rig(subject, 'dsl-ask', 'dontAsk');
      const errors = deniedErrors(agent);
      try {
        expect(await ask()).toEqual(subject === 'shell' ? { decision: 'decline' } : { action: 'decline', content: null });
        expect(errors).toEqual([named(subject)]);
        expect(surfaced).toEqual([]);
      } finally { agent.destroy(); }
    });
  }

  it('the model reads the same sentence on a v1 exec approval', async () => {
    const { agent, ws, surfaced } = rig('shell', 'dsl-ask', 'dontAsk');
    try {
      const answer = await (agent as never as { handleServerRequest(m: string, p: unknown): unknown })
        .handleServerRequest('execCommandApproval', { command: ['npm', 'publish'], cwd: ws });
      expect(answer).toEqual({ decision: { denied: { rejection: named('shell') } } });
      expect(surfaced).toEqual([]);
    } finally { agent.destroy(); }
  });

  it('CONTROL: a dontAsk refusal no rule covers keeps R13\'s sentence, in the payload and the v1 answer', async () => {
    const { agent, ws, ask } = rig('shell', 'none', 'dontAsk');
    const errors = deniedErrors(agent);
    try {
      expect(await ask()).toEqual({ decision: 'decline' });
      expect(errors).toEqual([R13]);
      expect(await (agent as never as { handleServerRequest(m: string, p: unknown): unknown })
        .handleServerRequest('execCommandApproval', { command: ['npm', 'publish'], cwd: ws }))
        .toEqual({ decision: { denied: { rejection: R13 } } });
    } finally { agent.destroy(); }
  });
});
