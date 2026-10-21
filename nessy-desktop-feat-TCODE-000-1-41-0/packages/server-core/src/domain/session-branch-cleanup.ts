export interface BranchRollbackManagedSession<TAgent> {
  agent?: TAgent | null
}

interface RollbackParams<TAgent> {
  managed: BranchRollbackManagedSession<TAgent>
  preflightError: unknown
  /** Immutable Workspace ID (ID-first global session storage). */
  workspaceId: string
  sessionId: string
  disposeRuntime: (expectedAgent: TAgent | null | undefined) => Promise<void>
  deleteFromRuntimeSessions: (sessionId: string) => void
  deleteStoredSession: (workspaceId: string, sessionId: string) => void | boolean | Promise<void | boolean>
}

/**
 * Roll back a branch only after its complete runtime has been disposed.
 * A disposal failure retains every owner reference and the stored session so
 * the caller can retry or diagnose cleanup without losing authority.
 */
export async function rollbackFailedBranchCreation<TAgent>(params: RollbackParams<TAgent>): Promise<never> {
  const {
    managed,
    preflightError,
    workspaceId,
    sessionId,
    disposeRuntime,
    deleteFromRuntimeSessions,
    deleteStoredSession,
  } = params
  const expectedAgent = managed.agent
  const preflightMessage = preflightError instanceof Error
    ? preflightError.message
    : String(preflightError)

  try {
    await disposeRuntime(expectedAgent)
    await deleteStoredSession(workspaceId, sessionId)
    deleteFromRuntimeSessions(sessionId)
  } catch (rollbackError) {
    const rollbackMessage = rollbackError instanceof Error
      ? rollbackError.message
      : String(rollbackError)
    throw new AggregateError(
      [preflightError, rollbackError],
      `Could not create branch: ${preflightMessage}; rollback failed: ${rollbackMessage}`,
    )
  }

  throw new Error(`Could not create branch: ${preflightMessage}`)
}
