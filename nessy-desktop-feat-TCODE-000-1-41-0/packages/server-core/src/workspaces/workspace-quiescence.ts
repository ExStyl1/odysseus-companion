import type {
  WorkspaceQuiescence,
  WorkspaceQuiescenceLease,
} from '@nessy-agent/shared/workspaces'

export interface WorkspaceQuiescenceResidual {
  participantId: string
  phase: 'drain' | 'release'
  message: string
  resources?: readonly WorkspaceQuiescenceResourceResidual[]
}

export interface WorkspaceQuiescenceResourceResidual {
  resourceType: string
  resourceId: string
  code: string
}

export class WorkspaceQuiescenceParticipantError extends Error {
  constructor(
    message: string,
    readonly resources: readonly WorkspaceQuiescenceResourceResidual[],
  ) {
    super(message)
    this.name = 'WorkspaceQuiescenceParticipantError'
  }
}

export class WorkspaceQuiescenceError extends Error {
  constructor(
    readonly code:
      | 'workspace-already-draining'
      | 'workspace-quiescence-acquire-failed'
      | 'workspace-quiescence-release-failed',
    readonly workspaceId: string,
    readonly residuals: WorkspaceQuiescenceResidual[] = [],
  ) {
    super(code)
    this.name = 'WorkspaceQuiescenceError'
  }
}

export interface WorkspaceParticipantDrainLease {
  release(): Promise<void>
}

export interface WorkspaceQuiescenceParticipant {
  id: string
  drain(workspaceId: string): Promise<WorkspaceParticipantDrainLease>
}

export interface WorkspaceAdmissionLease {
  release(): void
}

export interface WorkspaceParticipantRegistration {
  dispose(): void
}

interface DrainState {
  phase: 'draining' | 'held' | 'releasing'
}

export class WorkspaceQuiescenceCoordinator implements WorkspaceQuiescence {
  private readonly participants = new Map<string, WorkspaceQuiescenceParticipant>()
  private readonly drains = new Map<string, DrainState>()
  private readonly admissions = new Map<string, number>()
  private readonly participantAdmissions = new Map<string, number>()
  private readonly admissionWaiters = new Map<string, Set<() => void>>()

  registerParticipant(participant: WorkspaceQuiescenceParticipant): WorkspaceParticipantRegistration {
    const id = participant.id
    if (!id || id.trim() !== id) throw new Error('participant-id-invalid')
    this.assertRegistryMutable()
    if (this.participants.has(id)) throw new Error('participant-already-registered')
    this.participants.set(id, participant)
    let disposed = false
    return {
      dispose: () => {
        if (disposed) return
        this.assertRegistryMutable()
        if ((this.participantAdmissions.get(id) ?? 0) > 0) throw new Error('participant-admissions-active')
        this.participants.delete(id)
        disposed = true
      },
    }
  }

  admit(participantId: string, workspaceId: string): WorkspaceAdmissionLease {
    if (!this.participants.has(participantId)) throw new Error('participant-not-registered')
    if (this.drains.has(workspaceId)) throw new Error('workspace-draining')
    this.admissions.set(workspaceId, (this.admissions.get(workspaceId) ?? 0) + 1)
    this.participantAdmissions.set(participantId, (this.participantAdmissions.get(participantId) ?? 0) + 1)
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.decrement(this.participantAdmissions, participantId)
        if (this.decrement(this.admissions, workspaceId) === 0) {
          const waiters = this.admissionWaiters.get(workspaceId)
          this.admissionWaiters.delete(workspaceId)
          for (const resolve of waiters ?? []) resolve()
        }
      },
    }
  }

  async acquire(workspaceId: string): Promise<WorkspaceQuiescenceLease> {
    if (this.drains.has(workspaceId)) {
      throw new WorkspaceQuiescenceError('workspace-already-draining', workspaceId)
    }
    const state: DrainState = { phase: 'draining' }
    this.drains.set(workspaceId, state)
    const participants = [...this.participants.values()]
    const accepted: Array<{ participantId: string; lease: WorkspaceParticipantDrainLease }> = []

    try {
      await this.waitForAdmissions(workspaceId)
      for (const participant of participants) {
        accepted.push({ participantId: participant.id, lease: await participant.drain(workspaceId) })
      }
    } catch (error) {
      const failedParticipant = participants[accepted.length]
      const residuals: WorkspaceQuiescenceResidual[] = [{
        participantId: failedParticipant?.id ?? 'admission',
        phase: 'drain',
        message: errorMessage(error),
        ...errorResources(error),
      }]
      await releaseAccepted(accepted, residuals)
      this.drains.delete(workspaceId)
      throw new WorkspaceQuiescenceError('workspace-quiescence-acquire-failed', workspaceId, residuals)
    }

    state.phase = 'held'
    let releasePromise: Promise<void> | undefined
    return {
      release: () => releasePromise ??= this.release(workspaceId, state, accepted),
    }
  }

  private async release(
    workspaceId: string,
    state: DrainState,
    accepted: Array<{ participantId: string; lease: WorkspaceParticipantDrainLease }>,
  ): Promise<void> {
    state.phase = 'releasing'
    const residuals: WorkspaceQuiescenceResidual[] = []
    try {
      await releaseAccepted(accepted, residuals)
    } finally {
      this.drains.delete(workspaceId)
    }
    if (residuals.length > 0) {
      throw new WorkspaceQuiescenceError('workspace-quiescence-release-failed', workspaceId, residuals)
    }
  }

  private waitForAdmissions(workspaceId: string): Promise<void> {
    if ((this.admissions.get(workspaceId) ?? 0) === 0) return Promise.resolve()
    return new Promise(resolve => {
      const waiters = this.admissionWaiters.get(workspaceId) ?? new Set()
      waiters.add(resolve)
      this.admissionWaiters.set(workspaceId, waiters)
    })
  }

  private assertRegistryMutable(): void {
    if (this.drains.size > 0) throw new Error('participant-registry-locked')
  }

  private decrement(map: Map<string, number>, key: string): number {
    const next = Math.max(0, (map.get(key) ?? 0) - 1)
    if (next === 0) map.delete(key)
    else map.set(key, next)
    return next
  }
}

async function releaseAccepted(
  accepted: Array<{ participantId: string; lease: WorkspaceParticipantDrainLease }>,
  residuals: WorkspaceQuiescenceResidual[],
): Promise<void> {
  for (const acceptedParticipant of [...accepted].reverse()) {
    try {
      await acceptedParticipant.lease.release()
    } catch (error) {
      residuals.push({
        participantId: acceptedParticipant.participantId,
        phase: 'release',
        message: errorMessage(error),
        ...errorResources(error),
      })
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorResources(error: unknown): Pick<WorkspaceQuiescenceResidual, 'resources'> {
  return error instanceof WorkspaceQuiescenceParticipantError
    ? { resources: error.resources }
    : {}
}
