/**
 * F1.1066 — codex's two session children run the bundled Bun in the SESSION's
 * folder, and Bun reads that folder's `.env*` files and `bunfig.toml` (whose
 * `preload` runs a script before the entry point) unless told not to — the
 * F1.1063 class, where the Pi subprocess had the same exposure
 * ({@link bunProjectIsolationArgs} has the Bun citations and the measurement).
 *
 * - `[mcp_servers.session]` ({@link CodexAgent.buildSessionMcpSpec}): the
 *   config writer names no `cwd`, and codex spawns the stdio child in the
 *   THREAD's cwd — measured on the shipped `codex-app-server` 0.156.1
 *   (2026-09-28, scratch `CODEX_HOME`, the real config writer): app-server cwd
 *   elsewhere and thread cwd the project gave the child the project, and the
 *   project's `.env`, `.env.local` and bunfig preload all reached it; the
 *   reverse split gave the other folder. `CodexAgent` starts every thread with
 *   `cwd: this.workingDirectory`.
 * - the unattended-automation floor hook
 *   ({@link codexAutomationFloorHookCommand}): codex runs a command hook with
 *   `current_dir(cwd)`, the request's cwd (`codex-rs/hooks/src/engine/
 *   command_runner.rs` `run_command` and `hooks/src/events/permission_request.rs`
 *   at rust-v0.156.1), through `$SHELL -lc`.
 *
 * Each positive arm runs the REAL spec or the REAL command line the way codex
 * does — the command and argv as given, in the project folder — with a probe
 * standing in for the session server that reports NAME presence and its own
 * argv, never a value. The argv half is the other contract: Bun consumes the
 * two switches, so the session server still parses exactly the argv it did.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { CodexAgent } from '../codex-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import {
  CODEX_AUTOMATION_FLOOR_HOOK_FLAG,
  codexAutomationFloorHookCommand,
} from '../backend/codex/automation-floor-hook.ts'
import { bunProjectIsolationArgs } from '../bun-project-isolation.ts'

const BUNDLED_BUN = fileURLToPath(new URL('../../../../../apps/electron/vendor/bun/bun', import.meta.url))
const BUN = existsSync(BUNDLED_BUN) ? BUNDLED_BUN : process.execPath

const DOTENV_NAME = 'NESSY_F1066_DOTENV_PROBE'
const DOTENV_LOCAL_NAME = 'NESSY_F1066_DOTENV_LOCAL_PROBE'
const PRELOAD_NAME = 'NESSY_F1066_BUNFIG_PRELOAD_RAN'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f1066-'))) // macOS: /var is /private/var, the child's cwd
  roots.push(root)
  const project = join(root, 'project')
  const server = join(root, 'server')
  mkdirSync(project)
  mkdirSync(server)
  writeFileSync(join(project, '.env'), `${DOTENV_NAME}=fabricated-dotenv\n`)
  writeFileSync(join(project, '.env.local'), `${DOTENV_LOCAL_NAME}=fabricated-local\n`)
  writeFileSync(join(project, 'preload.js'), `process.env.${PRELOAD_NAME} = '1'\n`)
  writeFileSync(join(project, 'bunfig.toml'), 'preload = ["./preload.js"]\n')
  const probe = join(server, 'probe.js')
  writeFileSync(probe, [
    `const names = ${JSON.stringify([DOTENV_NAME, DOTENV_LOCAL_NAME, PRELOAD_NAME])};`,
    'const out = Object.fromEntries(names.map(n => [n, typeof process.env[n] === "string"]));',
    'out.cwd = process.cwd();',
    'out.argv = process.argv.slice(1);',
    'process.stdout.write(JSON.stringify(out));',
  ].join('\n'))
  return { root, project, probe }
}

function createAgent(project: string, root: string, node: string, sessionServer: string): any {
  const config: BackendConfig = {
    provider: 'codex-runtime',
    workspace: { id: 'ws-f1066', name: 'ws', rootPath: project, workspaceRootPath: project, sessionRootPath: join(root, 'sessions') } as any,
    session: { id: 'f1066', workspaceRootPath: project, createdAt: 1, lastUsedAt: 1, workingDirectory: project } as any,
    model: 'codex/test-model',
    isHeadless: true,
    runtime: { paths: { sessionServer, node } },
  } as any
  return new CodexAgent(config)
}

/** Runs `command args` in `cwd` as codex does for a stdio MCP child, and parses the probe's report. */
async function runProbe(command: string, args: string[], cwd: string): Promise<Record<string, unknown>> {
  // A cleared env, as codex gives an MCP child, with NODE_ENV off `test` (which
  // `bun test` sets): Bun skips `.env.local` under `test`, and that assertion
  // could not fail.
  const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  const code = await new Promise<number | null>(resolve => child.on('close', resolve))
  expect(code).toBe(0)
  return JSON.parse(stdout) as Record<string, unknown>
}

function namesSeen(observed: Record<string, unknown>) {
  return { dotenv: observed[DOTENV_NAME], dotenvLocal: observed[DOTENV_LOCAL_NAME], bunfigPreloadRan: observed[PRELOAD_NAME] }
}

describe('F1.1066 · codex session children do not read the project folder\'s Bun files', () => {
  it('the [mcp_servers.session] child keeps a repository .env, .env.local and bunfig preload out, and parses the same argv', async () => {
    const { root, project, probe } = scratch()
    const spec = createAgent(project, root, BUN, probe).buildSessionMcpSpec(undefined)
    expect(spec.command).toBe(BUN)
    const observed = await runProbe(spec.command, spec.args, project)
    expect(observed.cwd).toBe(project)
    expect(namesSeen(observed)).toEqual({ dotenv: false, dotenvLocal: false, bunfigPreloadRan: false })
    // Bun consumed the switches: the session server's argv starts where it did.
    const argv = observed.argv as string[]
    expect(argv[0]).toBe(probe)
    expect(argv[1]).toBe('--session-id')
    expect(argv).toContain('--config-root')
  }, 20_000)

  it.skipIf(process.platform === 'win32')('the floor-hook command line keeps them out too, through a shell in the project folder', async () => {
    const { project, probe } = scratch()
    const command = codexAutomationFloorHookCommand(BUN, probe, project)
    const observed = await runProbe('/bin/sh', ['-c', command], project)
    expect(observed.cwd).toBe(project)
    expect(namesSeen(observed)).toEqual({ dotenv: false, dotenvLocal: false, bunfigPreloadRan: false })
    const argv = observed.argv as string[]
    expect(argv.slice(0, 4)).toEqual([probe, CODEX_AUTOMATION_FLOOR_HOOK_FLAG, '--workspace-root', project])
  }, 20_000)

  it('a runtime that is not Bun gets neither switch on either child (Node or Electron would refuse them)', () => {
    const { root, project } = scratch()
    const node = '/opt/app/bin/node'
    const server = '/opt/app/session-mcp-server.js'
    expect(createAgent(project, root, node, server).buildSessionMcpSpec(undefined).args[0]).toBe(server)
    expect(codexAutomationFloorHookCommand(node, server, '/ws', '/state.json'))
      .toBe(`'${node}' '${server}' '${CODEX_AUTOMATION_FLOOR_HOOK_FLAG}' '--workspace-root' '/ws' '--state-file' '/state.json'`)
    // And a Bun runtime gets exactly the pair F1.1063 defined, in front of the entry point.
    const bun = '/opt/app/vendor/bun/bun'
    expect(createAgent(project, root, bun, server).buildSessionMcpSpec(undefined).args.slice(0, 3))
      .toEqual([...bunProjectIsolationArgs(bun), server])
    expect(codexAutomationFloorHookCommand(bun, server, '/ws').startsWith(
      [bun, ...bunProjectIsolationArgs(bun), server].map(arg => `'${arg}'`).join(' '),
    )).toBe(true)
  })
})
