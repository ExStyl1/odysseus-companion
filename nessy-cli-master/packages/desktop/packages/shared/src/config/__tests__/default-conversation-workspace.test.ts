import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

function setupConfigDir() {
  const configDir = join(tmpdir(), `nessy-default-conversation-${crypto.randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, 'config-defaults.json'),
    JSON.stringify({
      version: 'test',
      description: 'test defaults',
      defaults: {
        notificationsEnabled: true,
        colorTheme: 'default',
        autoCapitalisation: true,
        sendMessageKey: 'enter',
        spellCheck: false,
        keepAwakeWhileRunning: false,
        richToolDescriptions: true,
      },
      workspaceDefaults: {
        permissionMode: 'safe',
        cyclablePermissionModes: ['safe', 'allow-all'],
        localMcpServers: { enabled: true },
      },
    }, null, 2),
    'utf-8',
  )
  return configDir
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function runEval(configDir: string, defaultWorkspaceDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { ensureDefaultConversationWorkspace, ensureDefaultNessyConnection, getWorkspaces, hasStoredConfig, isNessyFirstRunPreparationPending, loadStoredConfig, removeWorkspace, reorderWorkspaces, saveConfig, setNessyFirstRunPreparationPending } from '${STORAGE_MODULE_PATH}'; ${code}`,
  ], {
    env: {
      ...process.env,
      CRAFT_CONFIG_DIR: configDir,
      NESSY_DEFAULT_WORKSPACE_DIR: defaultWorkspaceDir,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstdout:\n${run.stdout.toString()}\nstderr:\n${run.stderr.toString()}`)
  }

  return run.stdout.toString().trim()
}

describe('default conversation workspace', () => {
  it('creates the default Nessy connection in an empty profile only once', () => {
    const configDir = setupConfigDir()
    const defaultWorkspaceDir = join(tmpdir(), `nessy-documents-${crypto.randomUUID()}`, 'Nessy')

    const output = runEval(
      configDir,
      defaultWorkspaceDir,
      `const first = ensureDefaultNessyConnection(); const second = ensureDefaultNessyConnection(); console.log(JSON.stringify({ first, second, config: loadStoredConfig() }));`,
    )
    const result = JSON.parse(output)

    expect(result.first).toBe(true)
    expect(result.second).toBe(false)
    expect(result.config.defaultLlmConnection).toBe('nessy-cli')
    expect(result.config.llmConnections).toEqual([
      expect.objectContaining({
        slug: 'nessy-cli',
        providerType: 'nessy',
        authType: 'none',
      }),
    ])
  })

  it('creates a protected Nessy conversation workspace outside managed project storage', () => {
    const configDir = setupConfigDir()
    const defaultWorkspaceDir = join(tmpdir(), `nessy-documents-${crypto.randomUUID()}`, 'Nessy')

    const output = runEval(
      configDir,
      defaultWorkspaceDir,
      `const ws = ensureDefaultConversationWorkspace(); console.log(JSON.stringify({ ws, all: getWorkspaces() }));`,
    )
    const { ws, all } = JSON.parse(output)

    expect(ws.rootPath).toBe(defaultWorkspaceDir)
    expect(ws.kind).toBe('conversation')
    expect(ws.isProtected).toBe(true)
    expect(all).toHaveLength(1)

    const rootConfig = readJson(join(configDir, 'config.json'))
    expect(rootConfig.activeWorkspaceId).toBe(ws.id)
    expect(rootConfig.workspaces[0].rootPath).toBe(defaultWorkspaceDir)

    const workspaceConfig = readJson(join(defaultWorkspaceDir, 'config.json'))
    expect(workspaceConfig.name).toBe('Nessy')
    expect(workspaceConfig.kind).toBe('conversation')
    expect(workspaceConfig.isProtected).toBe(true)
    expect(workspaceConfig.defaults.workingDirectory).toBe(defaultWorkspaceDir)
    expect(existsSync(join(configDir, 'workspaces', 'my-workspace'))).toBe(false)
  })

  it('does not remove or reorder protected conversation workspaces', () => {
    const configDir = setupConfigDir()
    const defaultWorkspaceDir = join(tmpdir(), `nessy-documents-${crypto.randomUUID()}`, 'Nessy')

    const output = runEval(
      configDir,
      defaultWorkspaceDir,
      `const ws = ensureDefaultConversationWorkspace(); const removed = await removeWorkspace(ws.id); const reordered = reorderWorkspaces([ws.id]); console.log(JSON.stringify({ removed, reordered, all: getWorkspaces() }));`,
    )
    const result = JSON.parse(output)

    expect(result.removed).toBe(false)
    expect(result.reordered).toBe(true)
    expect(result.all).toHaveLength(1)
    expect(result.all[0].kind).toBe('conversation')
  })

  it('persists first-run Nessy preparation only while it is pending', () => {
    const configDir = setupConfigDir()
    const defaultWorkspaceDir = join(tmpdir(), `nessy-documents-${crypto.randomUUID()}`, 'Nessy')

    const output = runEval(
      configDir,
      defaultWorkspaceDir,
      `ensureDefaultConversationWorkspace(); const initial = isNessyFirstRunPreparationPending(); setNessyFirstRunPreparationPending(true); const pending = isNessyFirstRunPreparationPending(); setNessyFirstRunPreparationPending(false); const complete = isNessyFirstRunPreparationPending(); console.log(JSON.stringify({ initial, pending, complete, config: loadStoredConfig() }));`,
    )
    const result = JSON.parse(output)

    expect(result.initial).toBe(false)
    expect(result.pending).toBe(true)
    expect(result.complete).toBe(false)
    expect(result.config.nessyFirstRunPreparationPending).toBeUndefined()
  })

  it('distinguishes a fresh profile from an existing profile without workspaces', () => {
    const configDir = setupConfigDir()
    const defaultWorkspaceDir = join(tmpdir(), `nessy-documents-${crypto.randomUUID()}`, 'Nessy')

    const output = runEval(
      configDir,
      defaultWorkspaceDir,
      `const fresh = !hasStoredConfig(); saveConfig({ workspaces: [], activeWorkspaceId: null, activeSessionId: null }); console.log(JSON.stringify({ fresh, existing: hasStoredConfig(), workspaces: getWorkspaces() }));`,
    )
    const result = JSON.parse(output)

    expect(result.fresh).toBe(true)
    expect(result.existing).toBe(true)
    expect(result.workspaces).toHaveLength(0)
  })
})
