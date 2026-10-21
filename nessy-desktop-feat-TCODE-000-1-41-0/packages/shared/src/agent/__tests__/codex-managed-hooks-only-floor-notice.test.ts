/**
 * F1.516 (1) (origin WJ-an P-WJ-an-1, 2026-09-24) — an administrator's
 * `allow_managed_hooks_only` keeps codex from running the host-written F1.386
 * floor hook, and the session now says THAT is why.
 *
 * ## Measured on the shipped binary (WJ-az, `work/wjaz/f1516-probe.ts`)
 *
 * WJ-ag's MDM rig (the requirement delivered through codex's own macOS MDM
 * reader, answered inside the child only; extended for `rust-v0.156.1`, whose
 * reader first asks `CFPreferencesAppValueIsForced`), the config written by the
 * product's own `buildCodexConfigToml` with the product's own floor-hook plan
 * and a real session's `deniedReadPaths`, and the product's own trust pass
 * (`trustCodexHostAuthoredHooks`). On BOTH `rust-v0.154.0` and `rust-v0.156.1`:
 *
 * - `allowed_approvals_reviewers = ["auto_review"]` alone (control):
 *   `hooks/list` reports the hook (`source: "user"`), the trust pass trusts 1.
 * - the same plus `allow_managed_hooks_only = true`:
 *   `configRequirements/read` answers `allowManagedHooksOnly: true`, `hooks/list`
 *   reports NO hook and no warning, and the trust pass trusts 0.
 *
 * The source agrees (`hooks/src/engine/discovery.rs` at `rust-v0.156.1`:
 * `HookDiscoveryPolicy::allows` is `!allow_managed_hooks_only || source.is_managed`,
 * and a disallowed layer is skipped with a bare `continue`). The config this
 * product writes is codex's USER layer, never a managed one — so under that
 * requirement the floor hook never runs, and codex's reviewer answers a change
 * to an unattended automation.
 *
 * ## What was already said, and what was wrong with it
 *
 * The trust pass could not find the hook and recorded
 * `CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE` — the consequence right, the
 * cause wrong ("could not be trusted"). The trust pass runs before the
 * requirements probe, so it cannot know the cause; the probe's answer, read
 * through the same recording channel F1.514 reads the reviewer list from,
 * replaces that sentence with one naming the administrator's requirement.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { CODEX_HOOK_PROJECTION_NOTICE } from '@nessy-agent/codex-responses-adapter/config-writer';
import { CodexAgent } from '../codex-agent.ts';
import * as floorHook from '../backend/codex/automation-floor-hook.ts';
import { recordAndPersistCodexManagedApprovalsReviewers } from '../../config/codex-managed-requirement-cache.ts';

const MANAGED_ONLY_NOTICE = (floorHook as unknown as Record<string, unknown>).CODEX_AUTOMATION_FLOOR_HOOK_MANAGED_ONLY_NOTICE;

/** The `configRequirements/read` answers the rig measured (trimmed to the fields that were set). */
const MANAGED_ONLY_READ = { requirements: { allowedApprovalsReviewers: ['auto_review'], allowManagedHooksOnly: true } };
const REVIEWER_ONLY_READ = { requirements: { allowedApprovalsReviewers: ['auto_review'], allowManagedHooksOnly: null } };
const MANAGED_ONLY_FALSE_READ = { requirements: { allowedApprovalsReviewers: ['auto_review'], allowManagedHooksOnly: false } };

const ROOT = '/work/space-f1516';

afterEach(() => { recordAndPersistCodexManagedApprovalsReviewers(undefined); });

function agentAt(): CodexAgent {
  const agent = new CodexAgent({
    provider: 'codex-runtime',
    workspace: { id: 'ws-f1516', name: 'F1.516', rootPath: ROOT, workspaceRootPath: ROOT, sessionRootPath: `${ROOT}/sessions` } as any,
    session: { id: 'session-f1516', workspaceRootPath: ROOT, createdAt: Date.now(), lastUsedAt: Date.now() } as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer: '/opt/nessy/session-mcp-server/index.js', node: '/opt/nessy/bun' } },
  } as never);
  agent.onDebug = () => {};
  (agent as any).debug = () => {};
  return agent;
}

/** One runtime build: the Settings toggle as given, the hook projection, then the trust pass codex answers. */
async function build(agent: CodexAgent, toggleOn: boolean, listedHooks: 'none' | 'ours'): Promise<void> {
  (agent as any).noteConfiguredApprovalsReviewer(toggleOn ? { approvalsReviewer: 'auto_review' } : {});
  (agent as any).hostAuthoredHookProjection();
  const commands: string[] = (agent as any).projectedHostHookCommands;
  const listed = listedHooks === 'none' ? [] : commands.map(command => ({
    key: 'user:ours', eventName: 'permissionRequest', handlerType: 'command', command,
    currentHash: 'h', trustStatus: 'trusted',
  }));
  await (agent as any).trustProjectedHostHooks({ request: async () => ({ data: [{ hooks: listed }] }) });
}

/** The requirements read this build makes, through the product's recording channel. */
async function readRequirements(agent: CodexAgent, result: unknown): Promise<void> {
  await (agent as any).recordManagedApprovalsReviewers({ request: async () => result }).request('configRequirements/read');
}

const fact = (agent: CodexAgent) => (agent as any).sessionFacts.get('codex-hooks-projection');

describe('F1.516 (1) · allow_managed_hooks_only is named as the reason the floor hook does not run', () => {
  it('toggle on, codex lists no hook, the requirement reads true: the session names the administrator requirement', async () => {
    const agent = agentAt();
    await build(agent, true, 'none');
    expect(fact(agent)).toBe(floorHook.CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE);
    await readRequirements(agent, MANAGED_ONLY_READ);
    expect(typeof MANAGED_ONLY_NOTICE).toBe('string');
    expect(fact(agent)).toBe(MANAGED_ONLY_NOTICE);
    expect(fact(agent)).toContain('allow_managed_hooks_only');
  });

  it('CONTROL: the requirement absent or false leaves the trust pass\'s own sentence', async () => {
    for (const read of [REVIEWER_ONLY_READ, MANAGED_ONLY_FALSE_READ]) {
      const agent = agentAt();
      await build(agent, true, 'none');
      await readRequirements(agent, read);
      expect(fact(agent)).toBe(floorHook.CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE);
    }
  });

  it('CONTROL: a trusted hook keeps the projection notice when the requirement is absent', async () => {
    const agent = agentAt();
    await build(agent, true, 'ours');
    await readRequirements(agent, REVIEWER_ONLY_READ);
    expect(fact(agent)).toBe(floorHook.CODEX_AUTOMATION_FLOOR_HOOK_NOTICE);
  });

  it('CONTROL: with no hook projected there is nothing of ours to skip — the requirement adds no floor sentence', async () => {
    const agent = agentAt();
    await build(agent, false, 'none');
    expect(fact(agent)).toBe(CODEX_HOOK_PROJECTION_NOTICE);
    await readRequirements(agent, { requirements: { allowManagedHooksOnly: true } });
    expect(fact(agent)).toBe(CODEX_HOOK_PROJECTION_NOTICE);
  });
});

/**
 * F1.553 (origin WJ-az P-WJaz-1, DECIDED by the controller 2026-09-24 under the TRANSPARENT and SIMPLE
 * rule) — the trust pass cannot tell WHY the hook is not live: `trustCodexHostAuthoredHooks` returns 0
 * when `hooks/list` does not report it (codex did not load it — `allow_managed_hooks_only` is the measured
 * case), when it is still untrusted after `config/batchWrite`, and when the pass itself throws. Only a
 * requirements read that ANSWERS can name the policy, and one that FAILS (a timeout, a refusal) replaces
 * nothing — so the trust pass's own sentence is what the session keeps, and it must claim no cause.
 */
describe('F1.553 · with the requirements read FAILED, the trust pass\'s sentence claims no cause', () => {
  const TIMEOUT = new Error('configRequirements/read timed out after 15000ms');

  async function readRequirementsFails(agent: CodexAgent): Promise<void> {
    const recorded = (agent as any).recordManagedApprovalsReviewers({ request: async () => { throw TIMEOUT; } });
    await expect(recorded.request('configRequirements/read')).rejects.toBe(TIMEOUT);
  }

  it('codex lists no hook and the read times out: the sentence names both possibilities, neither as THE cause', async () => {
    const agent = agentAt();
    await build(agent, true, 'none');
    await readRequirementsFails(agent);
    expect(fact(agent)).toBe(floorHook.CODEX_AUTOMATION_FLOOR_HOOK_UNTRUSTED_NOTICE);
    expect(fact(agent)).toContain('was not found or could not be trusted');
    // The consequence is still said: the reviewer answers what the floor would have refused.
    expect(fact(agent)).toContain('its reviewer answers changes');
  });

  it('the trust pass itself throws and the read is refused: the same cause-neutral sentence', async () => {
    const agent = agentAt();
    (agent as any).noteConfiguredApprovalsReviewer({ approvalsReviewer: 'auto_review' });
    (agent as any).hostAuthoredHookProjection();
    await (agent as any).trustProjectedHostHooks({ request: async () => { throw new Error('hooks/list refused'); } });
    await readRequirementsFails(agent);
    expect(fact(agent)).toContain('was not found or could not be trusted');
  });

  it('CONTROL: a read that ANSWERS with the policy still names it (F1.516 (1)\'s sentence, no "was not found")', async () => {
    const agent = agentAt();
    await build(agent, true, 'none');
    await readRequirements(agent, MANAGED_ONLY_READ);
    expect(fact(agent)).toBe(MANAGED_ONLY_NOTICE);
    expect(fact(agent)).not.toContain('was not found or could not be trusted');
  });
});
