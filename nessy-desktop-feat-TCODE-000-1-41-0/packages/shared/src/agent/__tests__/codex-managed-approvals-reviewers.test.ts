/**
 * F1.482 (1) (origin WJ-rr-a's F1.373 residue, 2026-09-24) — an administrator's
 * `allowed_approvals_reviewers` against the reviewer each `turn/start` asks for.
 *
 * ## Measured on the shipped `codex-app-server` 0.154.0 (2026-09-24, WJ-ag)
 *
 * The requirement reached the binary through its OWN macOS MDM reader
 * (`config/src/loader/macos.rs`, `CFPreferencesCopyAppValue("requirements_toml_base64",
 * "com.openai.codex")`), answered inside the child only; the config was the
 * product's own `buildCodexConfigToml`; each arm sent the three `turn/start`
 * shapes this host sends. Three arms, the control first:
 *
 * - no requirement (control): explore `'user'`, default `'auto_review'`, default
 *   with no field — all three turns start.
 * - `["auto_review"]`, toggle on: `configRequirements/read` carries
 *   `allowedApprovalsReviewers: ["auto_review"]` on the wire (so the requirement
 *   IS readable here), and the explore turn is REFUSED, `-32600`:
 *   {@link MEASURED_REFUSAL}. Default turns start.
 * - `["user"]`, toggle on: codex warns at start ("Configured value for
 *   `approvals_reviewer` is disallowed by requirements; falling back to required
 *   value User") and then REFUSES EVERY DEFAULT TURN, because F1.373 sends
 *   `'auto_review'` on it — a session that cannot take a single turn outside
 *   Explore and Plan.
 * - `["auto_review"]`, toggle OFF: no warning, the thread starts with
 *   `approvalsReviewer: "auto_review"`, and since this host sends no field with
 *   the toggle off, Explore and Plan run under the reviewer — the widening
 *   F1.373 closed, back through the administrator's door and silent.
 *
 * So the turn now asks for the reviewer the USER chose (or `'user'` in a read-only
 * mode) whenever the administrator's list allows it, asks for nothing when it
 * does not (the administrator's reviewer stands, and codex's own start-up warning
 * or the host notice below says so), and a read-only mode still asks for `'user'`
 * — codex refuses that turn, and the host says why in the words the user meets.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as codexAgentModule from '../codex-agent.ts';
import { CodexAgent } from '../codex-agent.ts';
import type { AgentEvent } from '@nessy-agent/core/types';
import { recordAndPersistCodexManagedApprovalsReviewers } from '../../config/codex-managed-requirement-cache.ts';

// F1.514 — every read this file drives through the recording channel now also
// REMEMBERS the list for the next runtime build (in-process), which would make
// the floor hook project in a later file of the same bun process. Clear it.
afterEach(() => { recordAndPersistCodexManagedApprovalsReviewers(undefined); });

/** The shipped binary's refusal of the explore turn, verbatim from the measurement above. */
const MEASURED_REFUSAL = 'invalid thread settings override: invalid value for `approvals_reviewer`: '
  + '`User` is not in the allowed set [AutoReview] (set by MDM com.openai.codex:requirements_toml_base64)';

/** The `configRequirements/read` result the shipped binary answered in the `["auto_review"]` arm (fields trimmed to the ones that were set). */
const MEASURED_READ_RESULT = {
  requirements: {
    cliAuthCredentialsStore: null,
    allowedApprovalPolicies: null,
    allowedApprovalsReviewers: ['auto_review'],
    allowedSandboxModes: null,
    featureRequirements: null,
  },
};

type Reviewer = { approvalsReviewer?: 'user' | 'auto_review' };
const mod = codexAgentModule as unknown as {
  codexTurnApprovalsReviewer: (mode: string, configured: 'auto_review' | undefined, allowed?: readonly string[]) => Reviewer;
  codexManagedApprovalsReviewers?: (result: unknown) => readonly string[] | undefined;
};

function createConfig(): any {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-codex-managed-reviewers',
      name: 'Codex Managed Reviewers Workspace',
      rootPath: '/tmp/ws-codex-managed-reviewers',
      workspaceRootPath: '/tmp/ws-codex-managed-reviewers',
      sessionRootPath: '/tmp/nessy-general-agent-test-sessions/ws-codex-managed-reviewers',
    } as any,
    session: {
      id: 'session-codex-managed-reviewers',
      workspaceRootPath: '/tmp/ws-codex-managed-reviewers',
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
 * F1.373's rig (`codex-turn-approvals-reviewer.test.ts`), plus the
 * administrator's list planted beside the configured reviewer, and a
 * `turn/start` that the stub can REFUSE with the shipped binary's error.
 */
function stubTransport(
  agent: CodexAgent,
  configured: 'auto_review' | undefined,
  managed: readonly string[] | undefined,
  refuseTurnWith?: string,
): Recorded[] {
  const requests: Recorded[] = [];
  const client = {
    request(method: string, params: any) {
      requests.push({ method, params });
      if (method === 'turn/start') {
        if (refuseTurnWith) return Promise.reject(Object.assign(new Error(refuseTurnWith), { code: -32600 }));
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
    (agent as any).managedApprovalsReviewers = managed;
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

describe('F1.482 (1) · the turn asks only for a reviewer the administrator allows', () => {
  it('["user"], toggle on: a default turn asks for NO reviewer (codex refused every default turn that asked for auto_review)', () => {
    // F1.1169: only Auto and Bypass want the reviewer, so only they are left asking for nothing here.
    for (const mode of ['auto', 'bypassPermissions'] as const) {
      expect(mod.codexTurnApprovalsReviewer(mode, 'auto_review', ['user'])).toEqual({});
    }
    // A read-only mode is untouched: 'user' is allowed and is what it asks for — and so is every mode that
    // never wants the reviewer: dontAsk (F1.1056), Manual and Accept edits (F1.1169).
    for (const mode of ['plan', 'dontAsk', 'default', 'acceptEdits'] as const) {
      expect(mod.codexTurnApprovalsReviewer(mode, 'auto_review', ['user'])).toEqual({ approvalsReviewer: 'user' });
    }
  });

  it('["auto_review"], toggle OFF: Plan still asks for user (codex refuses — never a silent review); default asks for nothing', () => {
    for (const mode of ['plan'] as const) {
      expect(mod.codexTurnApprovalsReviewer(mode, undefined, ['auto_review'])).toEqual({ approvalsReviewer: 'user' });
    }
    expect(mod.codexTurnApprovalsReviewer('default', undefined, ['auto_review'])).toEqual({});
  });

  it('["auto_review","user"], toggle OFF: every turn asks for user explicitly — codex would otherwise take the FIRST allowed value', () => {
    for (const mode of ['default', 'plan', 'acceptEdits'] as const) {
      expect(mod.codexTurnApprovalsReviewer(mode, undefined, ['auto_review', 'user'])).toEqual({ approvalsReviewer: 'user' });
    }
  });

  it('CONTROL: with no administrator list F1.373 is unchanged, byte for byte', () => {
    expect(mod.codexTurnApprovalsReviewer('plan', 'auto_review', undefined)).toEqual({ approvalsReviewer: 'user' });
    expect(mod.codexTurnApprovalsReviewer('auto', 'auto_review', undefined)).toEqual({ approvalsReviewer: 'auto_review' }); // F1.1169: Auto is the reviewed mode
    for (const mode of ['default', 'plan'] as const) {
      expect(mod.codexTurnApprovalsReviewer(mode, undefined, undefined)).toEqual({});
    }
    // …and a list that allows both, with the toggle on, is F1.373 too.
    expect(mod.codexTurnApprovalsReviewer('auto', 'auto_review', ['user', 'auto_review'])).toEqual({ approvalsReviewer: 'auto_review' });
    expect(mod.codexTurnApprovalsReviewer('plan', 'auto_review', ['user', 'auto_review'])).toEqual({ approvalsReviewer: 'user' });
  });
});

describe('F1.482 (1) · the administrator list is read off configRequirements/read', () => {
  it('reads the measured wire shape; null, absent and malformed read as no list; the legacy spelling is auto_review', () => {
    expect(typeof mod.codexManagedApprovalsReviewers).toBe('function');
    const read = mod.codexManagedApprovalsReviewers!;
    expect(read(MEASURED_READ_RESULT)).toEqual(['auto_review']);
    expect(read({ requirements: null })).toBeUndefined();
    expect(read({ requirements: { allowedApprovalsReviewers: null } })).toBeUndefined();
    expect(read({ requirements: { allowedApprovalsReviewers: [] } })).toBeUndefined();
    expect(read({ requirements: { allowedApprovalsReviewers: 'auto_review' } })).toBeUndefined();
    expect(read(undefined)).toBeUndefined();
    expect(read({ requirements: { allowedApprovalsReviewers: ['guardian_subagent', 'user'] } })).toEqual(['auto_review', 'user']);
  });

  it('the runtime build asks through a channel that records it, and a failed read records no list', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      (agent as any).debug = () => {};
      (agent as any).managedApprovalsReviewers = ['stale'];
      const channel = (agent as any).recordManagedApprovalsReviewers({
        request: async () => MEASURED_READ_RESULT,
      });
      expect(await channel.request('configRequirements/read')).toBe(MEASURED_READ_RESULT);
      expect((agent as any).managedApprovalsReviewers).toEqual(['auto_review']);
      const failing = (agent as any).recordManagedApprovalsReviewers({
        request: async () => { throw new Error('unknown variant `configRequirements/read`'); },
      });
      await expect(failing.request('configRequirements/read')).rejects.toThrow('unknown variant');
      expect((agent as any).managedApprovalsReviewers).toBeUndefined();
    } finally { agent.destroy(); }
    const source = readFileSync(new URL('../codex-agent.ts', import.meta.url), 'utf-8');
    expect(source).toContain('await probeCodexConfigRequirements(this.recordManagedApprovalsReviewers(client), {');
    expect(source).not.toContain('await probeCodexConfigRequirements(client, {');
  });

  it('toggle OFF under an administrator list that excludes user: one notice says the reviewer answers and Plan cannot run', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      (agent as any).debug = () => {};
      (agent as any).configuredApprovalsReviewer = undefined;
      await (agent as any).recordManagedApprovalsReviewers({ request: async () => MEASURED_READ_RESULT })
        .request('configRequirements/read');
      const notices: string[] = (agent as any).pendingServerWarningNotices;
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('auto-review is off in Settings');
      expect(notices[0]).toContain('Plan cannot run on Codex');
    } finally { agent.destroy(); }
  });

  // F1.1198 — the toggle ON under a list without `user` is no longer silent: Manual, Accept edits and Don't ask want
  // 'user', the list forbids it, so the thread's reviewer answers them. The wording is pinned in full by
  // codex-managed-reviewers-floor-hook.test.ts; here only the parts that tell the two notices apart.
  it('toggle ON under ["auto_review"]: one notice says the reviewer answers in Manual, Accept edits and Don\'t ask too, and Plan cannot run', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      (agent as any).debug = () => {};
      (agent as any).configuredApprovalsReviewer = 'auto_review';
      await (agent as any).recordManagedApprovalsReviewers({ request: async () => MEASURED_READ_RESULT })
        .request('configRequirements/read');
      const notices: string[] = (agent as any).pendingServerWarningNotices;
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('allowed_approvals_reviewers: auto_review');
      expect(notices[0]).toContain('in Manual, Accept edits and Don\'t ask too');
      expect(notices[0]).toContain('Plan cannot run on Codex');
      expect(notices[0]).not.toContain('auto-review is off in Settings');
    } finally { agent.destroy(); }
  });

  it('CONTROL: no notice when the list allows user (["auto_review","user"], toggle on or off), or when nothing is managed', async () => {
    const allowsUser = {
      requirements: { ...MEASURED_READ_RESULT.requirements, allowedApprovalsReviewers: ['auto_review', 'user'] },
    };
    for (const [configured, result] of [
      ['auto_review', allowsUser],
      [undefined, allowsUser],
      ['auto_review', { requirements: null }],
      [undefined, { requirements: null }],
    ] as const) {
      const agent = new CodexAgent(createConfig() as never);
      try {
        (agent as any).debug = () => {};
        (agent as any).configuredApprovalsReviewer = configured;
        await (agent as any).recordManagedApprovalsReviewers({ request: async () => result }).request('configRequirements/read');
        expect((agent as any).pendingServerWarningNotices).toEqual([]);
      } finally { agent.destroy(); }
    }
  });
});

describe('F1.482 (1) · through chatImpl', () => {
  it('["user"], toggle on: the auto turn carries no reviewer, so codex starts it', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      const requests = stubTransport(agent, 'auto_review', ['user']);
      agent.setPermissionMode('auto' as never); // F1.1169: Auto is the mode that wants the reviewer
      await drain(agent, 'edit the file');
      const params = starts(requests);
      expect(params).toHaveLength(1);
      expect('approvalsReviewer' in params[0]).toBe(false);
    } finally { agent.destroy(); }
  });

  for (const configured of ['auto_review', undefined] as const) {
    it(`["auto_review"], toggle ${configured ? 'on' : 'off'}: codex refuses the Plan turn, and the error says why in the user's words`, async () => {
      const agent = new CodexAgent(createConfig() as never);
      try {
        const requests = stubTransport(agent, configured, ['auto_review'], MEASURED_REFUSAL);
        agent.setPermissionMode('plan' as never);
        const events = await drain(agent, 'read the repo');
        expect(starts(requests).map(p => p.approvalsReviewer)).toEqual(['user']);
        const errors = events.filter(e => e.type === 'error').map(e => (e as { message: string }).message);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('Codex refused this Plan turn');
        expect(errors[0]).toContain("organisation's Codex policy");
        expect(errors[0]).toContain('allowed_approvals_reviewers: auto_review');
        // codex's own sentence rides beside it, naming where the requirement came from.
        expect(errors[0]).toContain('(set by MDM com.openai.codex:requirements_toml_base64)');
      } finally { agent.destroy(); }
    });
  }

  it('CONTROL: an unrelated turn/start refusal is passed through untouched', async () => {
    const agent = new CodexAgent(createConfig() as never);
    try {
      stubTransport(agent, 'auto_review', undefined, 'unknown variant `localImage`');
      agent.setPermissionMode('plan' as never);
      const events = await drain(agent, 'read the repo');
      const errors = events.filter(e => e.type === 'error').map(e => (e as { message: string }).message);
      expect(errors).toEqual(['unknown variant `localImage`']);
    } finally { agent.destroy(); }
  });
});
