import type { PermissionMode } from '@nessy-agent/shared/agent/mode-types';
import type { PiPlanModeStateV1 } from '@nessy-agent/shared/sessions/types';
import { encodeSessionKey, type SessionKey } from '@nessy-agent/shared/sessions/session-key';

export type PlanModeState = PiPlanModeStateV1;

interface PlanModeServiceOptions {
  sessionKey: SessionKey;
  initialMode: PermissionMode;
  previousMode?: PermissionMode;
  getMode?: () => PermissionMode;
  getPreviousMode?: () => PermissionMode | undefined;
  setMode: (mode: PermissionMode) => Promise<void>;
  persist?: (state: PlanModeState) => void | Promise<void>;
  onSubmit?: (planPath: string, submissionId: string) => void | Promise<void>;
  initial?: PlanModeState;
}

export class PlanModeService {
  private current: PlanModeState;

  constructor(private readonly options: PlanModeServiceOptions) {
    this.current = structuredClone(options.initial ?? (options.initialMode === 'plan'
      ? { schemaVersion: 1, kind: 'planning', revision: 1, previousMode: options.previousMode ?? 'default' }
      : { schemaVersion: 1, kind: 'inactive', revision: 0 }));
  }

  state(): PlanModeState { return structuredClone(this.current); }

  private async commit(candidate: PlanModeState): Promise<void> {
    await this.options.persist?.(structuredClone(candidate));
    this.current = structuredClone(candidate);
  }

  private submissionId(revision: number): string {
    return `pi-plan:${encodeSessionKey(this.options.sessionKey)}:${revision}`;
  }

  async enter(): Promise<void> {
    if (this.current.kind !== 'inactive') throw new Error('plan-already-active');
    const previousMode = this.options.getMode?.() ?? this.options.initialMode;
    const revision = this.current.revision + 1;
    await this.options.setMode('plan');
    try {
      await this.commit({ schemaVersion: 1, kind: 'planning', revision, previousMode });
    } catch (error) {
      await this.options.setMode(previousMode);
      throw error;
    }
  }

  async refine(revision = this.current.kind === 'inactive' ? -1 : this.current.revision): Promise<void> {
    if (this.current.kind === 'inactive') throw new Error('plan-inactive');
    if (revision !== this.current.revision) throw new Error('stale-revision');
    await this.commit({ schemaVersion: 1, kind: 'planning', revision: this.current.revision + 1, previousMode: this.current.previousMode });
  }

  async submit(planPath: string, revision = this.current.kind === 'planning' ? this.current.revision : -1): Promise<void> {
    if (this.current.kind === 'inactive' && isPlanSubmittingMode(this.options.getMode?.())) {
      await this.commit({ schemaVersion: 1, kind: 'planning', revision: this.current.revision + 1, previousMode: this.submissionReturnMode() });
      revision = this.current.revision;
    } else if (this.current.kind === 'awaiting_user') {
      // F1.1079 — a revised plan after the user's feedback supersedes the pending one (Claude's "No, keep planning",
      // permission-modes.md "Review and approve a plan"): planning at the next revision, then submitted below as its own.
      await this.refine(this.current.revision);
      revision = this.current.revision;
    }
    if (this.current.kind !== 'planning') throw new Error('plan-not-ready');
    if (revision !== this.current.revision) throw new Error('stale-revision');
    const pending: PlanModeState = {
      schemaVersion: 1,
      kind: 'awaiting_user',
      revision: this.current.revision,
      previousMode: this.current.previousMode,
      planPath,
      submissionId: this.submissionId(this.current.revision),
      notificationDispatched: false,
    };
    await this.commit(pending);
    await this.project(pending);
  }

  async reprojectPendingSubmission(): Promise<void> {
    if (this.current.kind !== 'awaiting_user' || this.current.notificationDispatched) return;
    await this.project(this.current);
  }

  private async project(pending: Extract<PlanModeState, { kind: 'awaiting_user' }>): Promise<void> {
    await this.options.onSubmit?.(pending.planPath, pending.submissionId);
    await this.commit({ ...pending, notificationDispatched: true });
  }

  async synchronizeExternalMode(mode: PermissionMode, previousMode: PermissionMode): Promise<void> {
    if (mode === 'plan') {
      if (this.current.kind === 'inactive') {
        await this.commit({ schemaVersion: 1, kind: 'planning', revision: this.current.revision + 1, previousMode });
      }
      return;
    }
    if (this.current.kind !== 'inactive') {
      await this.commit({ schemaVersion: 1, kind: 'inactive', revision: this.current.revision });
    }
  }

  async approve(): Promise<void> {
    if (this.current.kind !== 'awaiting_user') throw new Error('plan-not-awaiting-user');
    const previous = this.current, rollbackMode = this.options.getMode?.() ?? 'plan';
    await this.options.setMode(planApprovalLanding(previous.previousMode));
    try {
      await this.commit({ schemaVersion: 1, kind: 'inactive', revision: previous.revision });
    } catch (error) {
      await this.options.setMode(rollbackMode);
      throw error;
    }
  }

  async exit(): Promise<void> {
    if (this.current.kind === 'inactive') return;
    const previous = this.current, rollbackMode = this.options.getMode?.() ?? 'plan';
    await this.options.setMode(previous.previousMode);
    try {
      await this.commit({ schemaVersion: 1, kind: 'inactive', revision: previous.revision });
    } catch (error) {
      await this.options.setMode(rollbackMode);
      throw error;
    }
  }

  /**
   * F1.760 / F1.1051 — the mode `exit()` returns to after a submission opened while the service was inactive:
   * `plan` ITSELF. Such a session was already in Plan when this service started tracking it (a former Explore
   * session, read as plan since F1.1050, is the common one), so whatever the host recorded before it is not
   * where leaving the plan goes: Claude's "No, keep planning" stays in plan mode (permission-modes.md "Review
   * and approve a plan"), and the mode picker is the way out. `approve()` then lands in `default`.
   */
  private submissionReturnMode(): PermissionMode {
    return 'plan';
  }
}

/**
 * F1.760 — the mode a SubmitPlan may open a submission from while the service is inactive: `plan` (the
 * retired `explore` reaches here only as `plan`, F1.1050). claude/codex accept SubmitPlan in any mode
 * (`submit-plan.ts` calls `onPlanSubmitted`); Pi has no plan mode of its own to defer to. Every other
 * mode still answers `plan-not-ready`.
 */
function isPlanSubmittingMode(mode: PermissionMode | undefined): boolean {
  return mode === 'plan';
}

/**
 * F1.760 / F1.1051 — where `approve()` (the agent view's `approve_plan`) lands: the plan card's Accept rule,
 * `planApprovalLandingMode` in `apps/electron/src/renderer/components/app-shell/plan-approval-message.ts`
 * (F1.106/F1.201), applied to the stored return mode — `plan` lands in `default` (Claude's "Yes, manually
 * approve edits"); any other mode, the one the session entered Plan from, is restored as it was. Repeated
 * because server-core cannot import the renderer; that function's docblock points back here: change both.
 */
function planApprovalLanding(previousMode: PermissionMode): PermissionMode {
  return previousMode === 'plan' ? 'default' : previousMode;
}
