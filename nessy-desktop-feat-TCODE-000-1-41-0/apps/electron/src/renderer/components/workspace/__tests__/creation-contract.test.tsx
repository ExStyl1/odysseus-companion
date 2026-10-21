import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function source(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8')
}

describe('Workspace creation contract', () => {
  const screen = source('WorkspaceCreationScreen.tsx')
  const choice = source('AddWorkspaceStep_Choice.tsx')
  const local = source('AddWorkspaceStep_CreateNew.tsx')
  const remote = source('AddWorkspaceStep_ConnectRemote.tsx')
  const exports = source('index.ts')
  const implementation = [screen, choice, local, remote, exports].join('\n')

  it('creates local Workspaces by name only', () => {
    expect(screen).toContain('window.electronAPI.createWorkspace(name)')
    expect(local).toContain('onCreate(name.trim())')
    expect(choice).not.toContain('onOpenFolder')
    expect(choice).not.toContain('FolderOpen')
  })

  it('uses narrow remote create, connect, and update actions', () => {
    expect(screen).toContain('window.electronAPI.connectRemoteWorkspace(input)')
    expect(screen).toContain('window.electronAPI.createWorkspaceOnRemote(input)')
    expect(remote).toContain('onConnect({')
    expect(remote).toContain('onCreateRemote({')
    expect(remote).toContain('onUpdate({')
  })

  it('never prefills a saved reconnect token', () => {
    expect(remote).toContain("const [token, setToken] = useState('')")
    expect(remote).not.toContain('initialToken')
    expect(remote).toContain('...(token.trim() ? { token: token.trim() } : {})')
  })

  it('contains no renderer-owned Workspace storage logic or generic server tunnel', () => {
    for (const forbidden of [
      'getHomeDir(',
      'checkWorkspaceSlug',
      'slugify',
      'ServerDirectoryBrowser',
      'invokeOnServer',
      'folderPath',
      'AddWorkspaceStep_OpenFolder',
      'AddWorkspace_RadioOption',
    ]) {
      expect(implementation).not.toContain(forbidden)
    }
  })
})
