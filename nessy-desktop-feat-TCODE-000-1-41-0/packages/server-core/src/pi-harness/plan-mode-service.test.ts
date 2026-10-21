import { describe, expect, test } from 'bun:test';
import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types';
import { PlanModeService } from './plan-mode-service.ts';

describe('PlanModeService', () => {
  test('runs the revisioned plan lifecycle and restores the previous mode', async () => {
    const modes: string[] = [];
    const persisted: string[] = [];
    const submitted: string[] = [];
    let currentMode: PermissionMode = 'default';
    const service = new PlanModeService({
      sessionKey: { workspaceId: 'w', sessionId: 's' },
      initialMode: 'default',
      getMode: () => currentMode,
      setMode: async mode => { currentMode = mode; modes.push(mode); },
      persist: async state => { persisted.push(state.kind); },
      onSubmit: async path => { submitted.push(path); expect(persisted.at(-1)).toBe('awaiting_user'); },
    });
    await service.enter();
    await service.refine();
    await expect(service.refine(1)).rejects.toThrow('stale-revision');
    await service.submit('plan.md');
    // F1.1079 — was refused as `plan-not-ready`: a revised plan now supersedes the pending one (see the F1.1079 test).
    await service.submit('revised.md');
    await service.approve();
    expect(service.state().kind).toBe('inactive');
    currentMode = 'plan';
    await service.submit('second.md');
    expect(modes).toEqual(['plan', 'default']);
    expect(submitted).toEqual(['plan.md', 'revised.md', 'second.md']);
    expect(persisted).toEqual(['planning', 'planning', 'awaiting_user', 'awaiting_user', 'planning', 'awaiting_user', 'awaiting_user', 'inactive', 'planning', 'awaiting_user', 'awaiting_user']);
  });

  test('hydrates plan mode and reprojects one undispatched submission exactly once', async () => {
    const submitted: string[] = [];
    const persisted: string[] = [];
    const service = new PlanModeService({
      sessionKey: { workspaceId: 'w', sessionId: 's' },
      initialMode: 'plan',
      previousMode: 'acceptEdits',
      setMode: async () => {},
      persist: state => { persisted.push(state.kind); },
      onSubmit: path => { submitted.push(path); },
      initial: { schemaVersion: 1, kind: 'awaiting_user', revision: 3, previousMode: 'acceptEdits', planPath: 'persisted.md', submissionId: 'pi-plan:w/s:3', notificationDispatched: false },
    });
    await service.reprojectPendingSubmission();
    await service.reprojectPendingSubmission();
    expect(submitted).toEqual(['persisted.md']);
    expect(persisted).toEqual(['awaiting_user']);
    expect(service.state()).toMatchObject({ kind: 'awaiting_user', notificationDispatched: true });
  });

  test('rolls mode ownership back when entering cannot be persisted', async () => {
    const modes: string[] = [];
    const service = new PlanModeService({
      sessionKey: { workspaceId: 'w', sessionId: 's' },
      initialMode: 'default',
      setMode: async mode => { modes.push(mode); },
      persist: async () => { throw new Error('persist-failed'); },
    });
    await expect(service.enter()).rejects.toThrow('persist-failed');
    expect(service.state()).toEqual({ schemaVersion: 1, kind: 'inactive', revision: 0 });
    expect(modes).toEqual(['plan', 'default']);
  });

  test('keeps an undispatched outbox on projection failure and retries by stable identity', async () => {
    const submissions: string[] = [];
    let fail = true;
    let mode: PermissionMode = 'plan';
    const service = new PlanModeService({
      sessionKey: { workspaceId: 'w', sessionId: 's' },
      initialMode: 'plan',
      getMode: () => mode,
      setMode: async next => { mode = next; },
      onSubmit: async (_path, id) => { submissions.push(id); if (fail) throw new Error('projection-failed'); },
    });
    await expect(service.submit('plan.md')).rejects.toThrow('projection-failed');
    expect(service.state()).toMatchObject({ kind: 'awaiting_user', notificationDispatched: false });
    fail = false;
    await service.reprojectPendingSubmission();
    await service.reprojectPendingSubmission();
    expect(submissions).toEqual([submissions[0]!, submissions[0]!]);
    expect(service.state()).toMatchObject({ kind: 'awaiting_user', notificationDispatched: true });
    await service.approve();
    await service.synchronizeExternalMode('plan', 'default');
    expect(service.state()).toMatchObject({ kind: 'planning', revision: 2 });
  });

  // F1.760 (owner 2026-09-26, option A) accepted a plan submitted from Explore and kept the session in Explore on
  // exit. F1.1050 (DN-272) retired Explore — a stored one is read as plan — so that explore-only test was deleted
  // with the mode; the writing-mode refusal and the rollback below now run from plan.
  test('F1.760 — NEGATIVE: a submission from a writing mode is still refused, and a failed exit rolls back to plan', async () => {
    for (const writing of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
      const submitted: string[] = [];
      const service = new PlanModeService({
        sessionKey: { workspaceId: 'w', sessionId: 's' },
        initialMode: writing,
        getMode: () => writing,
        setMode: async () => {},
        onSubmit: path => { submitted.push(path); },
      });
      await expect(service.submit('plan.md')).rejects.toThrow('plan-not-ready');
      expect(submitted).toEqual([]);
      expect(service.state()).toEqual({ schemaVersion: 1, kind: 'inactive', revision: 0 });
    }
    let mode = 'plan' as PermissionMode; // `as`: the closures below reassign it, so do not narrow
    let failPersist = false;
    const service = new PlanModeService({
      sessionKey: { workspaceId: 'w', sessionId: 's' },
      initialMode: 'plan',
      getMode: () => mode,
      setMode: async next => { mode = next; },
      persist: () => { if (failPersist) throw new Error('persist-failed'); },
    });
    await service.submit('plan.md');
    failPersist = true;
    await expect(service.approve()).rejects.toThrow('persist-failed');
    expect(mode).toBe('plan');
    await expect(service.exit()).rejects.toThrow('persist-failed');
    expect(mode).toBe('plan');
    expect(service.state()).toMatchObject({ kind: 'awaiting_user', previousMode: 'default' });
  });

  // F1.1051 — Claude's plan mode (permission-modes.md "Review and approve a plan"): "No, keep planning: stay in
  // plan mode", and "Approving a plan exits plan mode and switches the session to the permission mode each approve
  // option describes" (the card's single Accept is "Yes, manually approve edits"). A session already in Plan whose
  // entry this service never saw — a former Explore session (read as plan since F1.1050) is the common one — keeps
  // Plan when its plan is left, whatever the host recorded before it; Accept lands in Manual.
  const inactiveInPlan = (modes: PermissionMode[]) => {
    let mode: PermissionMode = 'plan';
    const service = new PlanModeService({
      sessionKey: { workspaceId: 'w', sessionId: 's' },
      initialMode: 'plan',
      previousMode: 'bypassPermissions',
      getMode: () => mode,
      getPreviousMode: () => 'bypassPermissions',
      setMode: async next => { mode = next; modes.push(next); },
      initial: { schemaVersion: 1, kind: 'inactive', revision: 0 },
    });
    return { service, mode: () => mode };
  };

  test('F1.1051 — a session already in Plan stays in Plan when its plan is left, and Accept lands in Manual', async () => {
    const leftModes: PermissionMode[] = [];
    const left = inactiveInPlan(leftModes);
    await left.service.submit('plan.md');
    expect(left.service.state()).toMatchObject({ kind: 'awaiting_user', previousMode: 'plan' });
    await left.service.exit();
    expect(left.mode()).toBe('plan');
    expect(leftModes).toEqual(['plan']);
    expect(left.service.state()).toEqual({ schemaVersion: 1, kind: 'inactive', revision: 1 });

    const acceptedModes: PermissionMode[] = [];
    const accepted = inactiveInPlan(acceptedModes);
    await accepted.service.submit('plan.md');
    await accepted.service.approve();
    expect(accepted.mode()).toBe('default');
    expect(acceptedModes).toEqual(['default']);
  });

  test('F1.1051 — BOUNDARY: a session that entered Plan through the service still leaves to the mode before it', async () => {
    let mode = 'acceptEdits' as PermissionMode; // `as`: the closures below reassign it, so do not narrow
    const service = new PlanModeService({
      sessionKey: { workspaceId: 'w', sessionId: 's' },
      initialMode: 'acceptEdits',
      getMode: () => mode,
      getPreviousMode: () => 'bypassPermissions',
      setMode: async next => { mode = next; },
    });
    await service.enter();
    expect(mode).toBe('plan');
    await service.submit('plan.md');
    expect(service.state()).toMatchObject({ kind: 'awaiting_user', previousMode: 'acceptEdits' });
    await service.exit();
    expect(mode).toBe('acceptEdits');
    await service.synchronizeExternalMode('plan', 'auto');
    mode = 'plan' as PermissionMode; // the host's own switch (synchronizeExternalMode above)
    await service.submit('second.md');
    await service.approve();
    expect(mode).toBe('auto');
  });

  // F1.1079 (origin DN-281, read from code; measured here) — Claude's plan mode (permission-modes.md "Review and approve
  // a plan"): "No, keep planning: stay in plan mode and tell Claude what to change", and Claude presents the revised
  // plan the same way. On Pi the user's feedback is an ordinary next message and nothing calls this service for it (the
  // host port's `refine` has no caller; pi-agent wires only `submit`), so the agent's second SubmitPlan reaches `submit`
  // while the first is still `awaiting_user` — and it answered `plan-not-ready`.
  test('F1.1079 — a revised plan submitted after the user\'s feedback supersedes the pending one and keeps the way out', async () => {
    let mode = 'acceptEdits' as PermissionMode; // `as`: the closures below reassign it, so do not narrow
    const projected: Array<[string, string]> = [];
    const service = new PlanModeService({
      sessionKey: { workspaceId: 'w', sessionId: 's' },
      initialMode: 'acceptEdits',
      getMode: () => mode,
      setMode: async next => { mode = next; },
      onSubmit: (path, id) => { projected.push([path, id]); },
    });
    await service.enter();
    await service.submit('plan.md');
    // The user's feedback: a new message. The host calls nothing on the service for it.
    await service.submit('plan-v2.md');
    expect(projected.map(([path]) => path)).toEqual(['plan.md', 'plan-v2.md']);
    // Its own submission id (a new plan card), not the pending one's.
    expect(new Set(projected.map(([, id]) => id)).size).toBe(2);
    expect(service.state()).toMatchObject({ kind: 'awaiting_user', revision: 2, planPath: 'plan-v2.md', previousMode: 'acceptEdits', notificationDispatched: true });
    expect(mode).toBe('plan');
    await service.approve();
    expect(mode).toBe('acceptEdits');
  });

  test('F1.1079 — BOUNDARY: once the plan is approved, a later submission from the writing mode is still refused', async () => {
    let mode = 'default' as PermissionMode; // `as`: the closures below reassign it, so do not narrow
    const projected: string[] = [];
    const service = new PlanModeService({
      sessionKey: { workspaceId: 'w', sessionId: 's' },
      initialMode: 'default',
      getMode: () => mode,
      setMode: async next => { mode = next; },
      onSubmit: path => { projected.push(path); },
    });
    await service.enter();
    await service.submit('plan.md');
    await service.approve();
    await expect(service.submit('late.md')).rejects.toThrow('plan-not-ready');
    expect(projected).toEqual(['plan.md']);
    expect(service.state()).toMatchObject({ kind: 'inactive', revision: 1 });
  });
});
