import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ProjectDirectoryError } from '@nessy-agent/shared/projects/project-handle-service'
import { rehydrateRpcError, toRpcErrorEnvelope } from '../../../../shared/rpc-error'
import { classifyProjectTrustFailure, projectTrustRequest } from '../ProjectTrustDialog'

const dialogSource = readFileSync(
  fileURLToPath(new URL('../ProjectTrustDialog.tsx', import.meta.url)),
  'utf8',
)

describe('ProjectTrustDialog', () => {
  const project = {
    id: 'project-handle-1',
    workspaceId: 'workspace-1',
    displayPath: '/external/project',
    trustState: 'unknown' as const,
    expiresAt: Date.now() + 60_000,
  }

  it('sends only the opaque Workspace-bound handle reference', () => {
    const request = projectTrustRequest(project, 'trusted')

    expect(request).toEqual({
      workspaceId: 'workspace-1',
      projectHandleId: 'project-handle-1',
      state: 'trusted',
    })
    expect(JSON.stringify(request)).not.toContain(project.displayPath)
  })

  it('keeps unknown trust unchanged until an explicit decision', () => {
    expect(dialogSource).toContain("decide('trusted')")
    expect(dialogSource).toContain("decide('untrusted')")
    expect(dialogSource).toContain('window.electronAPI.setProjectTrust')
    expect(dialogSource).not.toMatch(/canonicalPath|projectKey|identityFingerprint|rootPath/)
  })

  /**
   * D1.363 — a trust answer for a folder that is GONE closes this dialog with a
   * sentence, instead of an error the user cannot click past.
   *
   * Measured on the packaged 1.40.0 (measure sitting 5e, case `RS-80`): the
   * folder this dialog named was deleted while it was up, and every click from
   * then on answered "Could not update project trust". Nothing in the dialog
   * could tell that from a transient failure, so it kept offering the retry.
   *
   * The classification is driven through the REAL bridge seam rather than a
   * hand-built Error, because that seam is the reason it reads the MESSAGE:
   * `toRpcErrorEnvelope` forwards a `code` only when it matches `/^[A-Z0-9_]+$/`,
   * which this lower-case code never does. The envelope round trip is the
   * evidence for that sentence, and the CONTROL beside it is the ordinary
   * failure, which must still read as retryable or the dialog would close on
   * every hiccup.
   */
  it('classifies a gone folder as terminal through the real bridge envelope, and nothing else', () => {
    const terminal = rehydrateRpcError(toRpcErrorEnvelope(
      new ProjectDirectoryError('project-directory-missing'),
    ))
    expect(classifyProjectTrustFailure(terminal)).toBe('project-missing')
    // The `code` channel is NOT why: the envelope dropped the lower-case code.
    expect(toRpcErrorEnvelope(new ProjectDirectoryError('project-directory-missing')).code)
      .toBeUndefined()
    // ...and a real RPC rejection arrives carrying the generic wire code, which
    // is the same for every handler throw.
    expect(classifyProjectTrustFailure(rehydrateRpcError({
      __nessyRpcError__: true, code: 'HANDLER_ERROR', message: 'project-directory-missing',
    }))).toBe('project-missing')

    // CONTROLS: everything else stays retryable.
    for (const retryable of [
      new Error('project-handle-invalid'),
      new Error('project-workspace-mismatch'),
      new Error('Not connected (channel: projects:setTrust)'),
      'a string nobody typed',
      undefined,
    ]) {
      expect(classifyProjectTrustFailure(retryable)).toBe('retryable')
    }
  })

  it('closes on the terminal answer and keeps the retry message for every other failure', () => {
    // The terminal branch: a sentence the user can act on, then the dialog goes.
    expect(dialogSource).toContain("classifyProjectTrustFailure(error) === 'project-missing'")
    expect(dialogSource).toContain("toast.error(t('projectTrust.projectMissing'")
    expect(dialogSource).toContain('path: project.displayPath')
    // The retry branch is still there for a failure a retry could fix.
    expect(dialogSource).toContain('setFailed(true)')
    expect(dialogSource).toContain("t('projectTrust.updateFailed'")
  })
})
