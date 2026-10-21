import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function source(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

describe('renderer project handle flow', () => {
  const picker = source('../../../hooks/useDirectoryPicker.ts')
  const browser = source('../../ServerDirectoryBrowser.tsx')
  const settings = source('../../../pages/settings/WorkspaceSettingsPage.tsx')
  const localStorage = source('../../../lib/local-storage.ts')

  it('normalizes local, server browse, and manual selection to one handle callback', () => {
    expect(picker).toContain('pickLocalProjectDirectory(workspaceId)')
    expect(picker).toContain('onSelect(handle)')
    expect(browser).toContain('validateProjectDirectory({')
    expect(browser).toContain('candidatePath,')
    expect(browser).toContain('await onSelect(project)')
  })

  it('sets and clears the Workspace default by opaque handle only', () => {
    expect(settings).toContain('setWorkspaceDefaultProject({')
    expect(settings).toContain('projectHandleId: project.id')
    expect(settings).toContain('projectHandleId: null')
    expect(settings).not.toContain("updateWorkspaceSetting('workingDirectory'")
  })

  /**
   * C3.58 — the standing "projects are local-only" statement, and the notice
   * that deliberately does NOT exist beside it.
   *
   * P6.499 probed the shipped `codex-app-server` for a remote-host surface and
   * found none, then corrected its own done-condition: the absence is identical
   * on Pi, claude and codex, so a runtime-switch line would price a loss that
   * never happens. What was left was a user who cannot tell "not supported"
   * from "I have not found it yet". The statement answers that where the
   * question is asked — the folder picker — and the second assertion is the
   * refusal half, which has no other guard.
   */
  it('states that projects are local-only, and adds no runtime-switch notice for it', () => {
    expect(browser).toContain("t('projects.localOnlyNote')")
    // The refusal: nothing in the switch-cost table claims a project or an SSH
    // host, because switching runtimes loses neither.
    const switchCosts = source('../../app-shell/input/runtime-switch-costs.ts')
    expect(switchCosts).not.toContain("id: 'remoteProjects'")
    expect(switchCosts).not.toContain('projects.localOnlyNote')
  })

  it('does not retain renderer-owned recent project history', () => {
    expect(localStorage).not.toContain(['recent', 'WorkingDirs'].join(''))
    expect(localStorage).not.toContain('recent-working-dirs')
  })
})
