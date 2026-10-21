/**
 * UA3.4 — copied from craft-agents-oss `v0.13.4:packages/server-core/src/tasks/index.ts` (Apache-2.0), rebranded.
 * UA4.1 — the Conductor (`TaskRunner` and its types) and our `SessionConductorHost` (`conductor-host.ts`).
 */
/**
 * The Conductor — the in-process DAG runner for Tasks. Builds on the spec, validation, and storage primitives in
 * @nessy-agent/shared/tasks and the SessionManager completion/output seams.
 */
export {
  assertTaskSlugFree,
  claimTaskSlug,
  createTaskFromSpec,
  finishTaskOrchestrator,
  resolveCreateTaskProjectId,
  resolveTaskFolderHandle,
  takenTaskSlugs,
} from './create-task'
export type { CreateTaskFromSpecResult, TaskOrchestratorSetupResult } from './create-task'
export { assertNodesHostable } from './node-hostability'
export type { HostabilitySpec, NodeHostabilityDeps, NodeUnhostableDetail, NodeUnhostableReason } from './node-hostability'
export { TaskRunner } from './TaskRunner'
export type {
  ConductorSessionHost,
  NodeRunStatus,
  RunOptions,
  RunSnapshot,
  RunStatus,
  TaskRunnerDeps,
} from './TaskRunner'
export {
  createConductorPreflight,
  createSessionConductorHost,
  getConductorRunner,
  PROMPT_NOT_DELIVERED,
} from './conductor-host'
export type {
  ConductorPreflightOptions,
  ConductorRunnerOptions,
  ConductorSessionManager,
  SessionConductorHostOptions,
} from './conductor-host'
