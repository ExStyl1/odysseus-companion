/**
 * F1.373 (origin the WJ-hh verifier on F1.234; DECIDED by the controller
 * 2026-09-23, fix (i)) — while the mode is `explore` or `plan`, codex's own
 * auto-review reviewer is NOT the one asked: every `turn/start` carries
 * `approvalsReviewer: 'user'`, so the approval reaches this host, where F1.234's
 * read-only refusal and the rule consult run. `default` (and every other mode)
 * keeps `auto_review`.
 *
 * ## Why the turn and not the config file
 *
 * Read at `rust-v0.154.0`, the tag `packages/codex-protocol/manifest.json` pins:
 *
 * - `core/src/tools/approvals.rs` `Session::request_approval` — "Approval
 *   precedence is: 1. Hooks 2. If StrictAutoReview || Guardian enabled, then
 *   Guardian. Else, user." The host is the "user" arm, so with the reviewer on
 *   `handleServerRequest` never sees the call and F1.234's refusal never runs.
 * - `core/src/mcp_tool_call.rs` `maybe_request_mcp_tool_approval` — the MCP
 *   reviewer is `mcp_approvals_reviewer_from_layers(…,
 *   settings.mcp_approvals_reviewer_override.unwrap_or(config.approvals_reviewer), …)`,
 *   which for any server but codex's own apps server returns that default.
 * - `core/src/session/step_settings.rs` — a turn's `approvals_reviewer` update
 *   sets BOTH `selected.approvals_reviewer` (exec / patch, via
 *   `turn_context.rs` `per_turn_config.approvals_reviewer`) AND
 *   `mcp_approvals_reviewer_override`, and the override is sticky
 *   (`update.approvals_reviewer.or(self.mcp_approvals_reviewer_override)`) —
 *   "for this turn and subsequent turns", as `TurnStartParams.approvalsReviewer`
 *   says. So a `default` turn after a `plan` turn must say `auto_review` again,
 *   which is why the value is sent on EVERY turn of a session whose config
 *   carries the reviewer, not only on a mode change.
 *
 * When the written config does NOT carry `approvals_reviewer = "auto_review"`
 * (the shipped default: the toggle is off), the turn carries no reviewer at
 * all — HEAD's wire byte for byte — so nothing changes for a session that never
 * turned the reviewer on.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { codexConfigEmitsAutoReview } from '@nessy-agent/codex-responses-adapter/config-writer';
import { CodexAgent, codexTurnApprovalsReviewer } from '../codex-agent.ts';
import type { AgentEvent } from '../../automations/types.ts';

function createConfig(): any {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-turn-reviewer',
      name: 'Codex Turn Reviewer Workspace',
      rootPath: '/tmp/ws-codex-turn-reviewer',
      workspaceRootPath: '/tmp/ws-codex-turn-reviewer',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-turn-reviewer',
    } as any,
    session: {
      id: 'session-codex-turn-reviewer',
      workspaceRootPath: '/tmp/ws-codex-turn-reviewer',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/project-root',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

interface Recorded { method: string; params: any }

/**
 * The P6.223 rig (`codex-turn-approval-policy.test.ts`): `ensureRuntime` is
 * replaced by a stub client, so `turn/start`'s params are read exactly as
 * `chatImpl` sends them. The config write never runs here, so the reviewer the
 * written config carries is planted on the field the config write sets
 * (`configuredApprovalsReviewer`); the write site's own hop is pinned below.
 */
function stubTransport(agent: CodexAgent, configured: 'auto_review' | undefined): Recorded[] {
  const requests: Recorded[] = [];
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
    (agent as any).configuredApprovalsReviewer = configured;
  };
  // F1.781 — the Settings toggle is re-read per turn; a config carrying the reviewer was written with it on.
  (agent as any).autoReviewSettingOn = () => configured === 'auto_review';
  (agent as any).debug = () => {};
  return requests;
}

async function drain(agent: CodexAgent, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of (agent as any).chatImpl(prompt)) events.push(event as AgentEvent);
  return events;
}

const starts = (requests: Recorded[]) =>
  requests.filter(entry => entry.method === 'turn/start').map(entry => entry.params);

describe('F1.373 · plan routes codex approvals to the host, not to the auto-review reviewer', () => {
  for (const mode of ['plan'] as const) {
    it(`${mode}: the turn carries approvalsReviewer 'user' when the config carries auto_review`, async () => {
      const agent = new CodexAgent(createConfig() as never);
      try {
        const requests = stubTransport(agent, 'auto_review');
        agent.setPermissionMode(mode as never);
        await drain(agent, 'read the repo');
        expect(starts(requests).map(p => p.approvalsReviewer)).toEqual(['user']);
      } finally { agent.destroy(); }
    });
  }

  it('CONTROL: auto keeps auto_review, and says it again after a plan turn (the override is sticky)', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent, 'auto_review');
      agent.setPermissionMode('auto' as never); // F1.1169: Auto is the reviewed mode
      await drain(agent, 'first');
      agent.setPermissionMode('plan' as never);
      await drain(agent, 'second');
      agent.setPermissionMode('auto' as never);
      await drain(agent, 'third');
      expect(starts(requests).map(p => p.approvalsReviewer)).toEqual(['auto_review', 'user', 'auto_review']);
    } finally { agent.destroy(); }
  });

  it('CONTROL: with no reviewer in the config (the toggle off) no turn carries the field, in any mode', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent, undefined);
      for (const mode of ['default', 'plan', 'acceptEdits'] as const) {
        agent.setPermissionMode(mode as never);
        await drain(agent, mode);
      }
      const params = starts(requests);
      expect(params).toHaveLength(3); // F1.1050: four modes before the retired explore's turn left the loop
      for (const p of params) expect('approvalsReviewer' in p).toBe(false);
    } finally { agent.destroy(); }
  });
});

describe('F1.373 · the pure halves', () => {
  it('codexTurnApprovalsReviewer: user in the two read-only modes, auto_review elsewhere, nothing when unconfigured', () => {
    for (const mode of ['plan'] as const) {
      expect(codexTurnApprovalsReviewer(mode, 'auto_review')).toEqual({ approvalsReviewer: 'user' });
    }
    for (const mode of ['auto', 'bypassPermissions'] as const) {
      expect(codexTurnApprovalsReviewer(mode, 'auto_review')).toEqual({ approvalsReviewer: 'auto_review' });
    }
    // F1.1056 — dontAsk is never handed to the reviewer; F1.1169 — nor are Manual and Accept edits (describes below).
    for (const mode of ['dontAsk', 'default', 'acceptEdits'] as const) {
      expect(codexTurnApprovalsReviewer(mode, 'auto_review')).toEqual({ approvalsReviewer: 'user' });
    }
    for (const mode of ['default', 'plan'] as const) {
      expect(codexTurnApprovalsReviewer(mode, undefined)).toEqual({});
    }
  });

  it('codexConfigEmitsAutoReview is the writer\'s gate: the reviewer AND an interactive policy', () => {
    expect(codexConfigEmitsAutoReview('auto_review', 'on-request')).toBe(true);
    expect(codexConfigEmitsAutoReview('auto_review', 'granular')).toBe(true);
    expect(codexConfigEmitsAutoReview('auto_review', 'never')).toBe(false);
    expect(codexConfigEmitsAutoReview(undefined, 'on-request')).toBe(false);
  });

  it('the one config write records what it wrote, through the same gate (source pin: the write cannot run under this rig)', () => {
    const source = readFileSync(new URL('../codex-agent.ts', import.meta.url), 'utf-8');
    expect(source).toContain(
      '...this.noteConfiguredApprovalsReviewer(buildCodexAutoReviewOptions(getCodexAutoReviewEnabled(), getCodexAutoReviewPolicy())),',
    );
    // Positive control on the same read: the bare spread (HEAD's line) is gone,
    // so no second write site can emit the reviewer without recording it.
    expect(source).not.toContain('        ...buildCodexAutoReviewOptions(getCodexAutoReviewEnabled(), getCodexAutoReviewPolicy()),');
    const writer = readFileSync(
      new URL('../../../../codex-responses-adapter/src/config-writer.ts', import.meta.url), 'utf-8');
    expect(writer.match(/const emitAutoReview = codexConfigEmitsAutoReview\(opts\.approvalsReviewer, approvalPolicy\);/g)).toHaveLength(2);
  });
});

/**
 * F1.781 (origin the SIT-l release sitting, 2026-09-25) — turning Codex auto-review OFF in Settings did not
 * reach a LIVE codex session: after `setCodexAutoReviewEnabled(false)` the next source call still went to the
 * Guardian, because the toggle was read only at the config write and a turn that asks for nothing inherits
 * the sticky override. Now every turn re-reads the toggle (`CodexAgent.autoReviewSettingOn`) and says `'user'`.
 * Turning it ON after a build without the reviewer stays next-session: the floor hook is projected at the build.
 */
describe('F1.781 · the Settings toggle reaches a live codex session when turned off', () => {
  it('turned off mid-session: the next auto and dontAsk turns say user; turned back on: auto_review again', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent, 'auto_review');
      let settingOn = true;
      (agent as any).autoReviewSettingOn = () => settingOn;
      agent.setPermissionMode('auto' as never); // F1.1169: Auto is the reviewed mode
      await drain(agent, 'first');
      settingOn = false;
      await drain(agent, 'second');
      agent.setPermissionMode('dontAsk' as never);
      await drain(agent, 'third');
      agent.setPermissionMode('auto' as never);
      settingOn = true;
      await drain(agent, 'fourth');
      expect(starts(requests).map(p => p.approvalsReviewer)).toEqual(['auto_review', 'user', 'user', 'auto_review']);
    } finally { agent.destroy(); }
  });

  it('CONTROL — turned ON in a session built with it off: no turn asks for the reviewer (the next session does)', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent, undefined);
      let settingOn = false;
      (agent as any).autoReviewSettingOn = () => settingOn;
      await drain(agent, 'first');
      settingOn = true;
      await drain(agent, 'second');
      const params = starts(requests);
      expect(params).toHaveLength(2);
      for (const p of params) expect('approvalsReviewer' in p).toBe(false);
    } finally { agent.destroy(); }
  });

  it('the pure half: settingOn=false says user wherever the reviewer was configured; an administrator list still decides', () => {
    for (const mode of ['default', 'acceptEdits', 'dontAsk', 'plan'] as const) {
      expect(codexTurnApprovalsReviewer(mode, 'auto_review', undefined, false)).toEqual({ approvalsReviewer: 'user' });
    }
    expect(codexTurnApprovalsReviewer('default', undefined, undefined, true)).toEqual({});
    expect(codexTurnApprovalsReviewer('default', 'auto_review', ['auto_review', 'user'], false)).toEqual({ approvalsReviewer: 'user' });
    // A list that leaves out `user` keeps the administrator's reviewer: asking for `'user'` would refuse the turn.
    expect(codexTurnApprovalsReviewer('default', 'auto_review', ['auto_review'], false)).toEqual({});
  });
});

/**
 * F1.1056 — `dontAsk` is Claude's "anything that would prompt is denied" (permission-modes.md,
 * "Available modes"), and on codex that denial is this host's: `handleServerRequest` refuses what no
 * permission rule pre-approves. Codex asks its reviewer BEFORE this host (F1.373's source read of
 * `Session::request_approval`), so a turn that kept `auto_review` let the reviewer APPROVE what the mode
 * denies — a widening, and the one mode where the reviewer can only widen. So a dontAsk turn asks for
 * `'user'`; under an administrator list that leaves `user` out it asks for nothing, as Manual does there.
 */
describe('F1.1056 · dontAsk routes codex approvals to the host, never to the auto-review reviewer', () => {
  it('dontAsk: the turn carries approvalsReviewer user when the config carries auto_review', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent, 'auto_review');
      agent.setPermissionMode('dontAsk' as never);
      await drain(agent, 'run the nightly report');
      expect(starts(requests).map(p => p.approvalsReviewer)).toEqual(['user']);
    } finally { agent.destroy(); }
  });

  it('CONTROL: auto keeps auto_review before and after a dontAsk turn (the override is sticky)', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent, 'auto_review');
      agent.setPermissionMode('auto' as never);
      await drain(agent, 'first');
      agent.setPermissionMode('dontAsk' as never);
      await drain(agent, 'second');
      agent.setPermissionMode('auto' as never);
      await drain(agent, 'third');
      expect(starts(requests).map(p => p.approvalsReviewer)).toEqual(['auto_review', 'user', 'auto_review']);
    } finally { agent.destroy(); }
  });

  it('the pure half under an administrator list: user where it is allowed, nothing where it is not', () => {
    expect(codexTurnApprovalsReviewer('dontAsk', 'auto_review', ['auto_review', 'user'])).toEqual({ approvalsReviewer: 'user' });
    expect(codexTurnApprovalsReviewer('dontAsk', 'auto_review', ['auto_review'])).toEqual({});
    expect(codexTurnApprovalsReviewer('auto', 'auto_review', ['auto_review'])).toEqual({ approvalsReviewer: 'auto_review' });
  });
});

/**
 * F1.1169 (controller decision 2026-09-29, donow/DECISIONS-2.md; MODES-SPEC "approvals_reviewer=auto_review for
 * Auto where the operator enabled it") — with Codex auto-review on, the reviewer answers only in Auto (Claude's
 * "Everything, with background safety checks") and, as the operator's safety net, in Bypass permissions. In Manual
 * and Accept edits what codex raises comes to this host and cards the user, as Claude's Manual ("Reads only" run
 * without asking) means — Pi's Guardian never consults there either (`core/guardian-consult.ts`).
 */
describe('F1.1169 · with auto-review on, the reviewer answers only in Auto and Bypass permissions', () => {
  it('Manual and Accept edits: every turn asks for user, and what codex raises cards the user', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent, 'auto_review');
      const cards: unknown[] = [];
      agent.onPermissionRequest = (request) => { cards.push(request); };
      agent.setPermissionMode('default' as never);
      await drain(agent, 'first');
      agent.setPermissionMode('acceptEdits' as never);
      await drain(agent, 'second');
      expect(starts(requests).map(p => p.approvalsReviewer)).toEqual(['user', 'user']);
      // The 'user' arm is this host: a raised command reaches `handleServerRequest`, which puts it to the user.
      agent.setPermissionMode('default' as never);
      void (agent as any).handleServerRequest('item/commandExecution/requestApproval', { command: 'git log --oneline -1', cwd: '/tmp/project-root' });
      expect(cards).toHaveLength(1);
    } finally { agent.destroy(); }
  });

  it('BOUNDARY: Auto and Bypass permissions keep auto_review, and Manual after Auto says user again (the override is sticky)', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent, 'auto_review');
      for (const mode of ['auto', 'bypassPermissions', 'default'] as const) {
        agent.setPermissionMode(mode as never);
        await drain(agent, mode);
      }
      expect(starts(requests).map(p => p.approvalsReviewer)).toEqual(['auto_review', 'auto_review', 'user']);
    } finally { agent.destroy(); }
  });

  it('the pure half, with and without an administrator list', () => {
    for (const mode of ['default', 'acceptEdits'] as const) {
      expect(codexTurnApprovalsReviewer(mode, 'auto_review')).toEqual({ approvalsReviewer: 'user' });
      expect(codexTurnApprovalsReviewer(mode, 'auto_review', ['auto_review', 'user'])).toEqual({ approvalsReviewer: 'user' });
      // A list that leaves out `user` keeps the administrator's reviewer: asking for 'user' would refuse the turn.
      expect(codexTurnApprovalsReviewer(mode, 'auto_review', ['auto_review'])).toEqual({});
    }
    for (const mode of ['auto', 'bypassPermissions'] as const) {
      expect(codexTurnApprovalsReviewer(mode, 'auto_review')).toEqual({ approvalsReviewer: 'auto_review' });
      expect(codexTurnApprovalsReviewer(mode, 'auto_review', ['user', 'auto_review'])).toEqual({ approvalsReviewer: 'auto_review' });
    }
  });
});
