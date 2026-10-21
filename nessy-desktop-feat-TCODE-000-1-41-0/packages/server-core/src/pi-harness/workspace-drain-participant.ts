import type {
  ProcessSupervisorPort,
  SupervisedProcessResult,
  SupervisedProcessStartRequest,
} from '@nessy-agent/shared/agent/pi-harness/process-supervisor-port'
import { encodeSessionKey, type SessionKey } from '@nessy-agent/shared/sessions/session-key'
import {
  WorkspaceQuiescenceCoordinator,
  WorkspaceQuiescenceParticipantError,
  type WorkspaceParticipantRegistration,
  type WorkspaceQuiescenceResourceResidual,
} from '../workspaces/workspace-quiescence.ts'
import { ProcessSessionDrainError } from './process-supervisor.ts'

const DEFAULT_PI_WORKSPACE_DRAIN_TIMEOUT_MS = 5_000

type RegisteredSupervisor = ProcessSupervisorPort & {
  start(
    request: SupervisedProcessStartRequest,
    onRegistered?: () => void,
  ): Promise<SupervisedProcessResult>
}

interface DrainResource {
  sessionKey: SessionKey
  resourceType: string
  resourceId: string
  drain(): Promise<void>
}

export interface AdmittedRuntimeRegistration<T> {
  resource: T
  dispose(): void
}

export class PiWorkspaceDrainParticipant {
  readonly processSupervisorPort: ProcessSupervisorPort
  private readonly resources = new Map<string, DrainResource>()
  private readonly pendingResourceKeys = new Set<string>()
  private readonly processSessionKeys = new Map<string, SessionKey>()
  private readonly registration: WorkspaceParticipantRegistration
  private disposed = false

  constructor(private readonly options: {
    quiescence: WorkspaceQuiescenceCoordinator
    supervisor: RegisteredSupervisor
    timeoutMs?: number
  }) {
    this.registration = options.quiescence.registerParticipant({
      id: 'pi-harness',
      drain: workspaceId => this.drainWorkspace(workspaceId),
    })
    this.processSupervisorPort = {
      start: request => this.startProcess(request),
      write: request => options.supervisor.write(request),
      read: request => options.supervisor.read(request),
      stop: request => options.supervisor.stop(request),
      // Threaded rather than dropped: the port's `drainSession` takes drain
      // options now (`keepSemanticIds`), and a wrapper that silently discarded
      // them would make an exempted teardown behave one way through the
      // supervisor and another way through this port.
      drainSession: (sessionKey, drainOptions) => options.supervisor.drainSession(sessionKey, drainOptions),
    }
  }

  async admitRuntime<T>(input: {
    sessionKey: SessionKey
    resourceType: string
    resourceId: string
    create(): Promise<T>
    publish(resource: T, registration: AdmittedRuntimeRegistration<T>): void
    drain(resource: T): Promise<void>
    disposeOnFailure(resource: T): Promise<void>
  }): Promise<AdmittedRuntimeRegistration<T>> {
    this.assertActive()
    const admission = this.options.quiescence.admit('pi-harness', input.sessionKey.workspaceId)
    const key = resourceKey(input.sessionKey, input.resourceType, input.resourceId)
    let resource: T | undefined
    let registration: AdmittedRuntimeRegistration<T> | undefined
    try {
      if (this.resources.has(key) || this.pendingResourceKeys.has(key)) {
        throw new Error('pi-drain-resource-already-registered')
      }
      this.pendingResourceKeys.add(key)
      resource = await input.create()
      const entry: DrainResource = {
        sessionKey: input.sessionKey,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        drain: onceAsync(() => input.drain(resource as T)),
      }
      let disposed = false
      registration = {
        resource,
        dispose: () => {
          if (disposed) return
          disposed = true
          if (this.resources.get(key) === entry) this.resources.delete(key)
        },
      }
      this.resources.set(key, entry)
      input.publish(resource, registration)
      return registration
    } catch (error) {
      registration?.dispose()
      if (resource !== undefined) {
        try {
          await input.disposeOnFailure(resource)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'pi-runtime-publication-cleanup-failed')
        }
      }
      throw error
    } finally {
      this.pendingResourceKeys.delete(key)
      admission.release()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.registration.dispose()
    this.disposed = true
  }

  private async startProcess(request: SupervisedProcessStartRequest): Promise<SupervisedProcessResult> {
    this.assertActive()
    const admission = this.options.quiescence.admit('pi-harness', request.sessionKey.workspaceId)
    const sessionKeyId = encodeSessionKey(request.sessionKey)
    let registered = false
    try {
      return await this.options.supervisor.start(request, () => {
        if (registered) return
        registered = true
        this.processSessionKeys.set(sessionKeyId, request.sessionKey)
        admission.release()
      })
    } finally {
      admission.release()
    }
  }

  private async drainWorkspace(workspaceId: string): Promise<{ release(): Promise<void> }> {
    const resources = [...this.resources.entries()]
      .filter(([, resource]) => resource.sessionKey.workspaceId === workspaceId)
      .sort((left, right) => left[0].localeCompare(right[0]))
    const sessionKeys = uniqueSessionKeys([
      ...resources.map(([, resource]) => resource.sessionKey),
      ...[...this.processSessionKeys.values()].filter(sessionKey => sessionKey.workspaceId === workspaceId),
    ])
    const residuals: WorkspaceQuiescenceResourceResidual[] = []
    const pendingResources = new Map(resources)
    const pendingSessions = new Map(sessionKeys.map(sessionKey => [encodeSessionKey(sessionKey), sessionKey]))
    const work = (async () => {
      const drainResources = async () => {
        const settledResources = await Promise.allSettled(resources.map(([key, resource]) =>
          resource.drain().finally(() => { pendingResources.delete(key) }),
        ))
        settledResources.forEach((result, index) => {
          const [key, resource] = resources[index]!
          if (result.status === 'rejected') {
            residuals.push({ resourceType: resource.resourceType, resourceId: resource.resourceId, code: 'resource-drain-failed' })
          } else if (this.resources.get(key) === resource) {
            this.resources.delete(key)
          }
        })
      }
      const drainProcesses = async () => Promise.all(sessionKeys.map(async sessionKey => {
        const sessionKeyId = encodeSessionKey(sessionKey)
        try {
          await this.options.supervisor.drainSession(sessionKey)
          if (this.processSessionKeys.get(sessionKeyId) === sessionKey) this.processSessionKeys.delete(sessionKeyId)
        } catch (error) {
          if (error instanceof ProcessSessionDrainError) {
            residuals.push(...error.failedHandles.map(resourceId => ({
              resourceType: 'process', resourceId, code: 'process-drain-failed',
            })))
          } else {
            residuals.push({
              resourceType: 'session', resourceId: encodeSessionKey(sessionKey), code: 'process-drain-failed',
            })
          }
        } finally {
          pendingSessions.delete(sessionKeyId)
        }
      }))
      await Promise.all([drainResources(), drainProcesses()])
    })()
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_PI_WORKSPACE_DRAIN_TIMEOUT_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    const completed = await Promise.race([work.then(() => true), new Promise<false>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs)
      timer.unref()
    })])
    if (timer) clearTimeout(timer)
    if (!completed) {
      residuals.push(...[...pendingResources.values()].map(resource => ({
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
        code: 'drain-timeout',
      })))
      residuals.push(...[...pendingSessions.entries()].map(([resourceId]) => ({
        resourceType: 'process-session', resourceId, code: 'drain-timeout',
      })))
    }
    if (residuals.length > 0) {
      throw new WorkspaceQuiescenceParticipantError('pi-workspace-drain-failed', dedupeResiduals(residuals))
    }
    return { async release() {} }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('pi-workspace-drain-participant-disposed')
  }
}

function onceAsync(action: () => Promise<void>): () => Promise<void> {
  let promise: Promise<void> | undefined
  return () => promise ??= action()
}

function resourceKey(sessionKey: SessionKey, resourceType: string, resourceId: string): string {
  return `${encodeSessionKey(sessionKey)}\0${resourceType}\0${resourceId}`
}

function uniqueSessionKeys(sessionKeys: readonly SessionKey[]): SessionKey[] {
  const result = new Map<string, SessionKey>()
  for (const sessionKey of sessionKeys) result.set(encodeSessionKey(sessionKey), sessionKey)
  return [...result.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value)
}

function dedupeResiduals(
  residuals: readonly WorkspaceQuiescenceResourceResidual[],
): WorkspaceQuiescenceResourceResidual[] {
  const unique = new Map<string, WorkspaceQuiescenceResourceResidual>()
  for (const residual of residuals) {
    unique.set(`${residual.resourceType}\0${residual.resourceId}\0${residual.code}`, residual)
  }
  return [...unique.values()]
}
