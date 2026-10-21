import { describe, expect, it, spyOn } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildManagedEditRequest, reportManagedEditFailure } from '../managed-capability-edit'

describe('EditPopover W9 managed resources', () => {
  it('builds global and workspace configs without a managed path', () => {
    const session = { workspaceId: 'ws-1', sessionId: 'session-1' }
    const global = buildManagedEditRequest({
      label: 'Preferences notes', contextKey: 'preferences-notes',
      resource: { scope: 'global', kind: 'preferences-notes' },
    }, session, 'Make notes concise')
    const workspace = buildManagedEditRequest({
      label: 'Labels', contextKey: 'edit-labels',
      resource: { scope: 'workspace', workspaceId: 'ws-1', kind: 'labels' },
    }, session, 'Add a bug label')

    const json = JSON.stringify({ global, workspace })
    expect(json).not.toMatch(/filePath|rootPath|\.nessy-agent/)
    expect(global.contextKey).toBe('preferences-notes')
    expect(workspace.contextKey).toBe('edit-labels')
  })

  it('keeps a project skill bound to the exact edit session', () => {
    const target = {
      label: 'Project skill',
      contextKey: 'skill-instructions' as const,
      resource: {
        scope: 'skill' as const,
        tier: 'project' as const,
        session: { workspaceId: 'ws-1', sessionId: 'session-1' },
        skillId: 'review',
        file: 'instructions' as const,
      },
    }
    const request = buildManagedEditRequest(
      target,
      { workspaceId: 'ws-1', sessionId: 'session-1' },
      'Tighten the checklist',
    )

    expect(request.session).toEqual(target.resource.session)
    expect(JSON.stringify(request)).not.toMatch(/filePath|rootPath|storedPath/)
  })

  it('keeps managed inline sessions open so their result remains visible', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'EditPopover.tsx'),
      'utf8',
    )
    const managedBranch = source.match(
      /if \(managedResource\) \{\s+await submitManagedEdit\(message\)([\s\S]*?)return\s+\}/,
    )?.[1]

    expect(managedBranch).toBeDefined()
    expect(managedBranch).not.toContain('setOpen(false)')
    expect(source).toContain('hidden: true')
  })

  // F1.754 — both send paths used to drop the request's promise, so any
  // rejection (a 30 s client timeout under load, or a real refusal) reached the
  // renderer as an UNHANDLED error.
  it('catches the managed edit request on both send paths', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'EditPopover.tsx'),
      'utf8',
    )
    const calls = source.match(/(?:await|void) submitManagedEdit\(message\)[^\n]*/g) ?? []

    expect(calls).toHaveLength(2)
    for (const call of calls) expect(call).toContain('.catch(reportManagedEditFailure)')
  })

  it('shows a refused managed edit to the user', () => {
    const shown: string[] = []
    const logSpy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      reportManagedEditFailure(new Error('capability-context-workspace-mismatch'), message => shown.push(message))
    } finally {
      logSpy.mockRestore()
    }
    expect(shown).toEqual(['capability-context-workspace-mismatch'])
  })

  it('logs a request timeout without telling the user the edit failed', () => {
    const shown: string[] = []
    const warned: unknown[][] = []
    const warnSpy = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args) })
    try {
      reportManagedEditFailure(
        new Error('Request timeout: capabilities:submitManagedEdit (30000ms)'),
        message => shown.push(message),
      )
    } finally {
      warnSpy.mockRestore()
    }
    expect(shown).toEqual([])
    expect(warned).toHaveLength(1)
    expect(String(warned[0]![0])).toContain('Request timeout: capabilities:submitManagedEdit')
  })
})
