/**
 * Fixture tree for the RTS wave (`cases/rts-1.ts` … `rts-12.ts`), the live
 * verification of session runtime switching.
 *
 * ```bash
 * bun run scripts/cdp/fixtures/runtime-switch.ts          # build/refresh
 * bun run scripts/cdp/fixtures/runtime-switch.ts --print  # just say where it is
 * ```
 *
 * ## Why this wave cannot use the operator's real config dir
 *
 * Every other live wave on this machine runs against `~/.nessy-agent`. This one
 * must not, and the reason is measured rather than stylistic
 * (`docs/testing/cdp-runs/2026-07-30--2026-08-17-run-narratives.md`, the `/usr/sbin` INERT rig fact, 2026-08-15, packaged 1.26.0):
 *
 * `apps/electron/src/main/shell-env.ts` `loadShellEnv()` runs at startup on
 * macOS and skips **only when `VITE_DEV_SERVER_URL` is set** — i.e. only in dev.
 * On the packaged `.app` it spawns `$SHELL -l -i -c env` and copies the login
 * shell's whole environment over `process.env`, PATH included, before
 * `getStableMachineId()` is ever called. So `ioreg` always resolves and the
 * v2-stable key is always derived, whatever the launch supplied. The operator's
 * `~/.nessy-agent/credentials.enc` decrypts under the `username:homedir`
 * FALLBACK id and under neither key the packaged app tries; forward migration
 * covers v1→v2 only. All 11 entries are intact — nothing is damaged — but a
 * packaged launch reads none of them and reports the store corrupt.
 *
 * That is a real defect and it has its own home: lane K of
 * `docs/superpowers/plans/2026-08-15-base-context-diet.md`. It is not fixed
 * here, and this wave is designed so it does not need to be.
 *
 * ## What makes the run REAL anyway
 *
 * The three cards this wave drives need no credential store. They authenticate
 * from `~/.nessy/dp_auth_creds.json` — nessy-cli's file, outside the config dir,
 * **read by the APP and never by this fixture or any case**. And they carry no
 * secret in config at all: `slug`, `name`, `providerType`, `authType`,
 * `baseUrl`, `models`, `defaultModel` and nothing else, which is why seeding
 * them by copy is safe to do and safe to read.
 *
 * They are also, not by coincidence, exactly the three runtimes this plan
 * switches between:
 *
 * | slug | providerType | runtime |
 * | --- | --- | --- |
 * | `pi-api-key` | `pi_compat` | Pi |
 * | `claude-gateway` | `claude-runtime` | Claude Agent SDK via the gateway adapter |
 * | `codex-gateway` | `codex-runtime` | Codex app-server |
 *
 * So the core claim — a live session moves between all three and its history
 * survives — is provable on a packaged build against the real gateway with the
 * owner's real JWT, even though most BYO connections on this machine are not
 * readable. The connections are COPIED FROM the operator's own config rather
 * than invented, so they are the owner's real cards pointed at the real gateway.
 *
 * ## What is deliberately NOT provable here
 *
 * - Any BYO/`pi_compat` endpoint on `llm-proxy.t-tech.team` — needs the store.
 * - The same-runtime anchor path through a Claude Pro/Max subscription. Owner
 *   decision 2026-08-15 hides that card and disables it visually, **retaining
 *   the code**, so `RTS-4` reports BLOCKED naming a precondition that can be
 *   met again rather than a case that can never apply. The same-runtime tier is
 *   still exercised — `classifyRuntimeSwitch` and the anchor resume are covered
 *   by unit rows — but not against a second anthropic ENDPOINT.
 *
 * ## The project
 *
 * `<root>/project` is a real git repo with real files, created here and
 * `rm -rf`-able. The plan's precondition is "a real project that has a git repo
 * and uncommitted-safe scratch space", and RTS-2 asks the agent to EDIT files:
 * pointing that at one of the owner's actual repositories would put agent edits
 * in their working tree. This is the scratch space that precondition asks for.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export interface RuntimeSwitchFixturePaths {
  root: string
  /** `NESSY_CONFIG_DIR` for the packaged launch. */
  configDir: string
  /** The git repo the wave's sessions are bound to. */
  projectDir: string
  /** The credential-free MCP probe server RTS-10 calls. */
  probeServer: string
  /** The probe server's OWN request log — ground truth the app does not write. */
  probeLog: string
}

export function fixturePaths(): RuntimeSwitchFixturePaths {
  const root = process.env.NESSY_CDP_RTS_ROOT ?? join(homedir(), 'nessy-cdp-rts')
  return {
    root,
    configDir: join(root, 'config'),
    projectDir: join(root, 'project'),
    probeServer: join(root, 'probe', 'echo.mjs'),
    probeLog: join(root, 'probe', 'requests.jsonl'),
  }
}

/** The slugs the wave drives, in the order the cases name them. */
export const RTS_CONNECTION_SLUGS = ['pi-api-key', 'claude-gateway', 'codex-gateway'] as const

/**
 * The operator's own config, read-only.
 *
 * Never written. The only thing taken from it is the three gateway cards, and
 * the copy is asserted secret-free before it is written anywhere (`seedConfig`).
 */
function operatorConfigPath(): string {
  return process.env.NESSY_CDP_OPERATOR_CONFIG ?? join(homedir(), '.nessy-agent', 'config.json')
}

/**
 * Fields a connection may carry into the fixture.
 *
 * An allow-list, not a deny-list. A deny-list on key NAMES is how a secret in a
 * field nobody thought of gets copied: the gateway cards are secret-free today,
 * and this is what keeps that true if a future field is added upstream.
 */
const COPYABLE_CONNECTION_FIELDS = [
  'slug', 'name', 'providerType', 'authType', 'baseUrl', 'models', 'defaultModel',
  'modelSelectionMode', 'piAuthProvider', 'customEndpoint', 'midStreamBehavior', 'createdAt',
] as const

export interface SeedReport {
  configExisted: boolean
  copied: string[]
  skipped: string[]
  droppedFields: string[]
}

/**
 * Merge the three gateway cards into the fixture config dir.
 *
 * Requires the app to have booted against the dir once already: the first boot
 * is what writes `config.json`, the workspace and the storage layout, and
 * hand-authoring those is how a fixture ends up testing its own guesses. The
 * checklist's recipe says the same.
 */
export async function seedConfig(): Promise<SeedReport> {
  const { configDir } = fixturePaths()
  const configPath = join(configDir, 'config.json')
  if (!existsSync(configPath)) {
    return { configExisted: false, copied: [], skipped: [], droppedFields: [] }
  }

  const operator = JSON.parse(readFileSync(operatorConfigPath(), 'utf8')) as {
    llmConnections?: Array<Record<string, unknown>>
  }
  const fixture = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>

  const copied: string[] = []
  const skipped: string[] = []
  const droppedFields = new Set<string>()
  const connections: Array<Record<string, unknown>> = []

  for (const slug of RTS_CONNECTION_SLUGS) {
    const source = (operator.llmConnections ?? []).find(c => c.slug === slug)
    if (!source) {
      skipped.push(slug)
      continue
    }
    const copy: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(source)) {
      if ((COPYABLE_CONNECTION_FIELDS as readonly string[]).includes(key)) copy[key] = value
      else droppedFields.add(key)
    }
    connections.push(copy)
    copied.push(slug)
  }

  fixture.llmConnections = connections
  if (copied.includes('pi-api-key')) fixture.defaultLlmConnection = 'pi-api-key'

  // Enable the builtin `time` MCP server, and ONLY that one.
  //
  // RTS-10 needs a tool it can actually call — an "always allow" cannot be
  // granted on a runtime and tested on another without one. Every other builtin
  // in this catalogue is a `dp*` server that authenticates against internal
  // infrastructure; `time` needs no credential, no OAuth and no network, which
  // is exactly why it is the one chosen. `builtin-dp-mcp-settings.ts` documents
  // this block as the USER layer of `config.json`.
  //
  // This is a config write, which a CASE may not do (`scripts/cdp/README.md`:
  // a case that arranges its own environment can break the machine it
  // measures). A fixture may — that is what a fixture is — and it happens here,
  // in one reviewable place, against a scratch config dir, rather than inside a
  // case where a later reader would not expect it.
  const builtins = (fixture.builtinDpMcpServers ?? {}) as { enabled?: Record<string, boolean> }
  fixture.builtinDpMcpServers = { ...builtins, enabled: { ...(builtins.enabled ?? {}), time: true } }

  await writeFile(configPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
  return { configExisted: true, copied, skipped, droppedFields: [...droppedFields] }
}

/** A real git repo with real files, safe for an agent to edit. */
export async function seedProject(): Promise<void> {
  const { projectDir } = fixturePaths()
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(projectDir, 'README.md'), '# rts-fixture\n\nScratch project for the runtime-switch live wave.\n', 'utf8')
  await writeFile(
    join(projectDir, 'greeting.ts'),
    'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n',
    'utf8',
  )
  await writeFile(
    join(projectDir, 'counter.ts'),
    'export function count(items: readonly unknown[]): number {\n  return items.length\n}\n',
    'utf8',
  )
  if (!existsSync(join(projectDir, '.git'))) {
    for (const args of [
      ['init', '-q'],
      ['add', '.'],
      ['-c', 'user.email=rts@fixture.local', '-c', 'user.name=RTS Fixture', 'commit', '-q', '-m', 'fixture: initial'],
    ]) {
      const proc = Bun.spawn(['git', ...args], { cwd: projectDir, stdout: 'ignore', stderr: 'ignore' })
      await proc.exited
    }
  }
}

/** The MCP server name RTS-10 drives, and the tool it calls on it. */
export const PROBE_SERVER_NAME = 'rts-echo'
export const PROBE_TOOL_NAME = 'whoami'

/**
 * Write the credential-free MCP probe server and register it GLOBALLY.
 *
 * `<configDir>/mcp.json` is the global native scope (`native-sources.ts:1507`),
 * so this server needs no project and no project-trust grant — the trust gate
 * is a variable RTS-10 does not want in its measurement.
 *
 * The server is `echo-server.mjs`, the one the MCP-W wave already uses: real
 * newline-delimited JSON-RPC over stdio, no network, no credential, and it
 * appends every request to its OWN log before replying. That log is what makes
 * "the call reached the server" a measurement rather than a reading of the
 * app's account of itself.
 *
 * The identity is BAKED into a copy rather than passed as `env`, and that is
 * not a style choice: a value in an MCP server's `env` block is a credential to
 * the runtime, which scrubs such values out of tool OUTPUT — the first sitting
 * that tried it got `[REDACTED]` where the probe had answered, i.e. the product
 * behaving correctly and the detector destroying itself.
 *
 * The hashbang must stay at byte 0; Node strips `#!` only there, and one line
 * lower it is a SyntaxError that surfaces as the server merely failing to
 * connect — indistinguishable from a product-side connect bug.
 */
export async function seedProbeServer(): Promise<void> {
  const { configDir, probeServer, probeLog } = fixturePaths()
  const source = await Bun.file(join(HERE, 'echo-server.mjs')).text()
  const hashbang = source.startsWith('#!') ? source.slice(0, source.indexOf('\n') + 1) : ''
  const body = source.slice(hashbang.length)
  const identity = { label: 'rts-echo', token: `RTS-${Math.abs(hashOf(probeServer))}`, log: probeLog }

  await mkdir(dirname(probeServer), { recursive: true })
  await writeFile(
    probeServer,
    `${hashbang}globalThis.G6_BAKED = ${JSON.stringify(identity)}\n${body}`,
    'utf8',
  )

  const mcpPath = join(configDir, 'mcp.json')
  const existing = existsSync(mcpPath)
    ? JSON.parse(readFileSync(mcpPath, 'utf8')) as { mcpServers?: Record<string, unknown> }
    : {}
  await writeFile(mcpPath, `${JSON.stringify({
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      [PROBE_SERVER_NAME]: { command: 'node', args: [probeServer] },
    },
  }, null, 2)}\n`, 'utf8')
}

/** Stable per-path token, so a re-seed keeps the same identity. */
function hashOf(value: string): number {
  let h = 0
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0
  return h
}

export function launchRecipe(): string {
  const { configDir, projectDir } = fixturePaths()
  return [
    'Launch the PACKAGED app against the fixture (never `electron:dev` — the',
    'interceptor path and `isPackaged` differ, and this wave is about both):',
    '',
    '```bash',
    `NESSY_CONFIG_DIR=${configDir} \\`,
    '  "release/mac-arm64/Nessy Desktop.app/Contents/MacOS/Nessy Desktop" \\',
    '  --remote-debugging-port=9223 --disable-backgrounding-occluded-windows &',
    '```',
    '',
    `Then bind a project to ${projectDir} and run the wave:`,
    '',
    '```bash',
    'bun run scripts/cdp/run.ts RTS-1 RTS-2 RTS-3',
    '```',
    '',
    'Append `-- --debug` after the switches (before the `&`) ONLY when a case needs the application log (F1.767,',
    '`DEBUG_LEVER`); a bare `--debug` exits at start, and `NESSY_IS_PACKAGED=false`, the fallback, loaded no session',
    'on the 1.41.0 RC. Neither makes the app a dev build — `isPackaged` still governs the interceptor path.',
  ].join('\n')
}

if (import.meta.main) {
  const paths = fixturePaths()
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify(paths, null, 2))
    console.log(launchRecipe())
  } else {
    await mkdir(paths.configDir, { recursive: true })
    await seedProject()
    const report = await seedConfig()
    if (report.configExisted) await seedProbeServer()
    console.log(JSON.stringify({ paths, report }, null, 2))
    if (!report.configExisted) {
      console.log(
        `\nNo config.json yet at ${paths.configDir}.\n`
        + 'Boot the packaged app once against it so the app writes its own config and workspace,\n'
        + 'quit, then re-run this fixture to merge the three gateway cards in.\n',
      )
    }
    console.log(`\n${launchRecipe()}`)
  }
}
