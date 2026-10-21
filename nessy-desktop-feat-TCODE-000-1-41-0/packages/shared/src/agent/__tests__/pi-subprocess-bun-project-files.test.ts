/**
 * F1.1063 — the Pi subprocess runs under Bun with the SESSION's working
 * directory as its cwd, and Bun reads two kinds of file from that folder at
 * startup unless told not to: every `.env*` file (bun.com/docs/runtime/
 * environment-variables.md, "Setting environment variables") and `bunfig.toml`
 * (`bun --help`: "--config … Default $cwd/bunfig.toml"), whose `preload` runs a
 * script before the entry point. A repository could therefore set the Pi
 * server's proxy, keys or provider switches, or run code in it, before any
 * tool call or approval. Upstream Pi runs under Node, which does neither.
 *
 * This drives the REAL `PiAgent.spawnSubprocess` with the REAL `spawn`, the
 * bundled Bun when the tree has it (else the Bun running the test), and a probe
 * standing in for the Pi server that reports only NAME presence, never a value.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import type { BackendConfig, CapabilityTurnRuntime } from '../backend/types.ts'
import { PiAgent } from '../pi-agent.ts'
import type { PiExecutionManifestSeedV2 } from '../pi-harness/harness-manifest.ts'
import { bunProjectIsolationArgs } from '../bun-project-isolation.ts'

const BUNDLED_BUN = fileURLToPath(new URL('../../../../../apps/electron/vendor/bun/bun', import.meta.url))
const BUN = existsSync(BUNDLED_BUN) ? BUNDLED_BUN : process.execPath

const DOTENV_NAME = 'NESSY_F1063_DOTENV_PROBE'
const DOTENV_LOCAL_NAME = 'NESSY_F1063_DOTENV_LOCAL_PROBE'
const PRELOAD_NAME = 'NESSY_F1063_BUNFIG_PRELOAD_RAN'
const CONNECTION_NAME = 'NESSY_F1063_CONNECTION_PROBE'
const CONNECTION_VALUE = 'fabricated-connection-value'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f1063-'))) // macOS: /var is /private/var, the child's cwd
  roots.push(root)
  const project = join(root, 'project')
  const server = join(root, 'server')
  mkdirSync(project)
  mkdirSync(server)
  // The repository's files: a `.env`, a `.env.local`, and a `bunfig.toml` whose
  // preload marks the process. The `.env` also names the connection's variable
  // with another value, so the arm below proves which one the child keeps.
  writeFileSync(join(project, '.env'), `${DOTENV_NAME}=fabricated-dotenv\n${CONNECTION_NAME}=fabricated-dotenv\n`)
  writeFileSync(join(project, '.env.local'), `${DOTENV_LOCAL_NAME}=fabricated-local\n`)
  writeFileSync(join(project, 'preload.js'), `process.env.${PRELOAD_NAME} = '1'\n`)
  writeFileSync(join(project, 'bunfig.toml'), 'preload = ["./preload.js"]\n')
  const result = join(root, 'result.json')
  const probe = join(server, 'probe.js')
  writeFileSync(probe, [
    `const names = ${JSON.stringify([DOTENV_NAME, DOTENV_LOCAL_NAME, PRELOAD_NAME])};`,
    'const out = Object.fromEntries(names.map(n => [n, n in process.env]));',
    `out.connection = process.env.${CONNECTION_NAME} === ${JSON.stringify(CONNECTION_VALUE)} ? 'connection' : 'other';`,
    'out.cwd = process.cwd();',
    `require('node:fs').writeFileSync(${JSON.stringify(result)}, JSON.stringify(out));`,
    'process.stdin.resume();',
  ].join('\n'))
  return { root, project, probe, result }
}

async function spawnPiProbe(project: string, probe: string, result: string, root: string) {
  const cfg: BackendConfig = {
    provider: 'pi', isHeadless: true, skipConfigWatcher: true,
    workspace: { id: 'ws', name: 'ws', rootPath: project, workspaceRootPath: project, sessionRootPath: join(root, 'sessions') } as any,
    session: { id: 'f1063', workspaceId: 'ws', createdAt: 1, lastUsedAt: 1, workingDirectory: project } as any,
    // NODE_ENV off `test` (which `bun test` sets and the child inherits): Bun skips `.env.local` under `test`.
    envOverrides: { [CONNECTION_NAME]: CONNECTION_VALUE, NODE_ENV: 'development' },
    // No piAuthProvider and a custom endpoint: no credential lookup (as the
    // Finding 3 test in pi-agent-mcp-pattern-alias.test.ts).
    runtime: { paths: { piServer: probe, node: BUN }, customEndpoint: { api: 'openai-completions' } },
  }
  const agent = new PiAgent(cfg)
  const state = agent as any
  const seed: PiExecutionManifestSeedV2 = {
    surfaceVersion: 2, snapshotGeneration: 'g1', sessionKey: { workspaceId: 'ws', sessionId: 'f1063' },
    provenance: [], mcpSources: [], staticTools: [],
    orchestrator: { concurrency: 4, depth: 2, maxParallelTasks: 8, maxAgents: 100, tierModelMap: null, tokenBudget: null },
  }
  agent.setCapabilityTurnRuntime({
    view: {
      generation: 'g1', sources: [], skills: [], mcpServers: [], hooks: [], automations: [], agents: [],
      promptLayers: [], memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [],
    },
    materializer: {
      assertActive() {}, async verifyPlugin() {}, async resolvePath() { return '' },
      async readText() { return '' }, resolveCredential() { throw new Error('unused') },
    },
    piExecutionManifestSeed: seed,
  } as CapabilityTurnRuntime)

  let child: ChildProcess | undefined
  let argv: string[] = []
  state.spawnProcess = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    argv = args
    child = spawn(command, args, options)
    return child
  }
  const attempt = state.beginSubprocessAttempt()
  state.send = (message: Record<string, unknown>) => { if (message.type === 'init') attempt.resolveReady() }
  state.publishExecutionManifest = async () => {}
  state.requestSetAutoCompaction = async () => true
  try {
    await state.spawnSubprocess(attempt)
    const deadline = Date.now() + 10_000
    while (!existsSync(result) && Date.now() < deadline) await Bun.sleep(25)
    return { argv, observed: JSON.parse(readFileSync(result, 'utf8')) as Record<string, unknown> }
  } finally {
    state.subprocess = null
    state.readline = null
    child?.kill('SIGKILL')
    agent.destroy()
  }
}

describe('F1.1063 · the Pi subprocess does not read the project folder\'s Bun files', () => {
  it('keeps a repository .env, .env.local and bunfig.toml preload out of the Pi server; the connection env still arrives', async () => {
    const { root, project, probe, result } = scratch()
    const { argv, observed } = await spawnPiProbe(project, probe, result, root)
    // The child really ran in the project folder, so Bun had the files to read.
    expect(observed.cwd).toBe(project)
    expect({
      dotenv: observed[DOTENV_NAME],
      dotenvLocal: observed[DOTENV_LOCAL_NAME],
      bunfigPreloadRan: observed[PRELOAD_NAME],
      connectionVariable: observed.connection,
    }).toEqual({ dotenv: false, dotenvLocal: false, bunfigPreloadRan: false, connectionVariable: 'connection' })
    expect(argv.at(-1)).toBe(probe)
  }, 20_000)

  it('adds the flags only for a Bun executable (a Node or Electron runtime would refuse them)', () => {
    expect(bunProjectIsolationArgs('/opt/app/vendor/bun/bun', 'darwin')).toEqual(['--no-env-file', '--config=/dev/null'])
    expect(bunProjectIsolationArgs('C:\\app\\vendor\\bun\\bun.exe', 'win32')).toEqual(['--no-env-file', '--config=NUL'])
    expect(bunProjectIsolationArgs('/usr/local/bin/node', 'darwin')).toEqual([])
    expect(bunProjectIsolationArgs('/Applications/Nessy.app/Contents/MacOS/Nessy', 'darwin')).toEqual([])
  })
})
