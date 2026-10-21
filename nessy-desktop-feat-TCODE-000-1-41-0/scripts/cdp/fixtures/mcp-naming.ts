/**
 * Fixture tree for the MCP-W wave (`cases/mcp-w1.ts`…`mcp-w3.ts`).
 *
 * ```bash
 * bun run scripts/cdp/fixtures/mcp-naming.ts          # build/refresh the tree
 * bun run scripts/cdp/fixtures/mcp-naming.ts --print  # just say where it is
 * ```
 *
 * **The harness never builds this for itself.** `scripts/cdp/README.md` states
 * the rule — a case that installs plugins or rewrites config can break the
 * machine it is measuring — and the MCP-W cases keep it: they read the tree,
 * assert against it, and report BLOCKED when it is absent. Building it is an
 * operator step, and this file is that step so it is reproducible rather than
 * an afternoon of `mkdir`.
 *
 * Everything lands under one root (`NESSY_CDP_G6_ROOT`, default `~/nessy-cdp-g6`),
 * the app's `NESSY_CONFIG_DIR` included — written only once the APP has booted it
 * (F1.146, {@link inspectFixtureConfigDir}) — so it is all `rm -rf`-able and the
 * operator's `~/.nessy-agent` is never touched. `~/.nessy/dp_auth_creds.json` is read by the APP, never by this
 * file — it is nessy-cli's contract and read-only to us.
 *
 * ## What each piece exists to make observable
 *
 * | fixture | the mint behaviour it exposes |
 * | --- | --- |
 * | builtin `t-tracker` enabled + `cdp-tracker-probe` bundling a `dp ai mcp tracker` server of the same name | the 2026-08-10 field incident's exact shape: the builtin keeps the bare name, the plugin copy stands down with a reason, and its skill goes inert WITH it |
 * | `cdp-echo-probe` bundling a credential-free stdio server | a real tool call under a real minted plugin wire name — the half no offline check has ever covered |
 * | `<config>/mcp.json` server `my server.v2` | the F3 sanitize: a space and a dot must become `_` |
 * | `<config>/mcp.json` server `мой сервер` | the F3 all-disallowed fallback: an EMPTY wire name would be dropped by the pool, so the mint owes a stable `server-<hash>` |
 * | `cdp-dual-probe` in TWO local-folder registries | two marketplaces serving one `pluginId` — the thing F1 could not reproduce, because `local-path` installs all collapse onto `marketplaceId: "local"` |
 *
 * The two registries are LOCAL FOLDERS, which `registry-source.ts` supports as
 * a first-class registry kind (`isGitRegistry` false → upgrade is a typed
 * no-op, `deriveRegistryPluginSource` returns a durable `local-path` per
 * plugin). Each `add()` mints its own `registry-<uuid>`, and `pluginKey`
 * derives from `marketplaceId + pluginId` — which is exactly the distinctness
 * a `local-path` install cannot produce and the reason F1 left this open.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { capMcpNameSegment, codexModelToolName } from '@nessy-agent/shared/capabilities/mcp-wire-name'
const HERE = dirname(fileURLToPath(import.meta.url))

export function fixtureRoot(): string {
  return process.env.NESSY_CDP_G6_ROOT ?? join(homedir(), 'nessy-cdp-g6')
}

/**
 * Per-run secrets. A model that invents a plausible answer must not be able to
 * score a tool call it never made, so the token is generated at BUILD time and
 * read back from disk by the case — never hardcoded here, never in git.
 */
export interface FixtureTokens {
  pluginEcho: string
  scopedSanitized: string
  scopedCyrillic: string
}

export interface FixturePaths {
  root: string
  configDir: string
  logFile: string
  tokensFile: string
  marketA: string
  marketB: string
}

export function fixturePaths(root = fixtureRoot()): FixturePaths {
  return {
    root,
    configDir: join(root, 'config'),
    logFile: join(root, 'probe-calls.jsonl'),
    tokensFile: join(root, 'tokens.json'),
    marketA: join(root, 'market-a'),
    marketB: join(root, 'market-b'),
  }
}

/**
 * The names this wave asserts, written out LITERALLY.
 *
 * Deliberately not computed with `pluginMcpWireName`/`sanitizeMcpNameSegment`:
 * a case that derives its expectation from the function under test passes
 * whatever that function does, including a regression. These strings are read
 * off `mcp.md:357`/`:365` and the F3 rules by hand, and a mint change has to
 * come and edit them.
 */
export const EXPECTED = {
  /** Builtin keeps its bare logical name — invariant N1, first half. */
  builtinTracker: 't-tracker',
  /** `plugin_<pluginId>_<serverName>` — invariant N1, second half. */
  pluginEchoWire: 'plugin_cdp-echo-probe_echo',
  pluginTrackerWire: 'plugin_cdp-tracker-probe_t-tracker',
  pluginDualWire: 'plugin_cdp-dual-probe_dual',
  /** F3: `[^A-Za-z0-9_-]` runs collapse to one `_`; the raw name is not kept. */
  scopedSanitizedWire: 'my_server_v2',
  /** F3: an all-disallowed name mints `server-<10 hex>`; the hash is per-key. */
  scopedCyrillicWirePrefix: 'server-',
} as const

export const FIXTURE = {
  pluginEchoId: 'cdp-echo-probe',
  pluginTrackerId: 'cdp-tracker-probe',
  pluginDualId: 'cdp-dual-probe',
  echoServerName: 'echo',
  trackerServerName: 't-tracker',
  dualServerName: 'dual',
  scopedSanitizedName: 'my server.v2',
  scopedCyrillicName: 'мой сервер',
  /** The one tool every fixture server exposes. */
  toolName: 'whoami',
  /** The builtin whose bare name the plugin copy must not take. */
  builtinName: 't-tracker',
  /** `dp ai mcp <subcommand>` — the argv tail the builtin-identity dedup matches. */
  builtinSubcommand: 'tracker',
} as const

/**
 * The tool name the HOST records for a pool server's tool (the transcript
 * row's `toolName`), per runtime. Pi and the Claude runtime consume the pool
 * per-server, so the pool's own `mcp__<wire>__<tool>` is both the row and the
 * name the model calls. The Codex runtime consumes the WHOLE pool through one
 * aggregating HTTP bridge declared in its config.toml as `[mcp_servers.sources]`,
 * and the host records the row as `mcp__sources__<wire>__<tool>` (SIT-11 C4).
 * **That is NOT the name the codex MODEL calls** — measured three times on
 * packaged 1.40.0 it calls `<wire>__<tool>` with hyphens as underscores and
 * reports the prefixed name absent (F1.155; the comment this line used to
 * carry, and `pool-server.ts`'s, said the model sees the prefixed name). The
 * model's spelling is {@link modelToolName}; asking a codex model for THIS
 * name is what failed MCP-W2's codex arm on a working pool (F1.153).
 */
export function proxyToolName(wireName: string, runtime: 'pi' | 'claude' | 'codex' = 'pi'): string {
  const poolName = `mcp__${wireName}__${FIXTURE.toolName}`
  return runtime === 'codex' ? `mcp__sources__${poolName.slice('mcp__'.length)}` : poolName
}

function token(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * Write a copy of the probe server with its identity BAKED IN.
 *
 * Not passed as `env`, and the reason is a measurement: an MCP server's `env`
 * values are credentials to the runtime, which scrubs them from tool OUTPUT —
 * the first live Pi turn came back `[REDACTED] [REDACTED]` instead of the
 * probe's answer. Correct product behaviour, fatal to a detector that reads the
 * token out of the reply. Baking it into the script keeps the value out of the
 * credential path entirely.
 */
async function writeProbeServer(path: string, identity: { label: string; token: string; log: string }): Promise<void> {
  const source = await Bun.file(join(HERE, 'echo-server.mjs')).text()
  // The hashbang has to STAY on line 1. Node strips `#!` only at byte 0; one
  // line lower it is a SyntaxError, and the copy dies before it can speak MCP —
  // which surfaces as every fixture server reporting `refused: failed`, i.e.
  // exactly like a product-side connect bug.
  const hashbang = source.startsWith('#!') ? source.slice(0, source.indexOf('\n') + 1) : ''
  const body = source.slice(hashbang.length)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${hashbang}globalThis.G6_BAKED = ${JSON.stringify(identity)}\n${body}`, 'utf8')
}

/** One Claude-format plugin bundle: `.claude-plugin/plugin.json` + `.mcp.json`. */
async function writeClaudePlugin(options: {
  dir: string
  id: string
  description: string
  mcpServers: Record<string, unknown>
  /** A skill whose `allowed-tools` names the bundled server by BARE name. */
  skill?: { name: string; server: string }
  /** Identity baked into the bundle's own copy of the probe server. */
  probeIdentity?: { label: string; token: string; log: string }
  /** F1.148: prompt commands, `commands/<name>.md` - each file's WHOLE text, frontmatter included. */
  commands?: Record<string, string>
  /** F1.148: `hooks/hooks.json`, written verbatim. */
  hooks?: unknown
}): Promise<void> {
  await writeJson(join(options.dir, '.claude-plugin', 'plugin.json'), {
    name: options.id,
    version: '1.0.0',
    description: options.description,
    author: { name: 'Nessy CDP fixtures' },
  })
  if (Object.keys(options.mcpServers).length > 0) {
    await writeJson(join(options.dir, '.mcp.json'), { mcpServers: options.mcpServers })
  }
  for (const [name, text] of Object.entries(options.commands ?? {})) {
    await mkdir(join(options.dir, 'commands'), { recursive: true })
    await writeFile(join(options.dir, 'commands', `${name}.md`), text, 'utf8')
  }
  if (options.hooks !== undefined) await writeJson(join(options.dir, 'hooks', 'hooks.json'), options.hooks)
  if (options.probeIdentity) {
    await writeProbeServer(join(options.dir, 'server', 'echo-server.mjs'), options.probeIdentity)
  }
  if (options.skill) {
    const dir = join(options.dir, 'skills', options.skill.name)
    await mkdir(dir, { recursive: true })
    // `allowed-tools` carrying the BARE server name is the shape the resolver's
    // T3 pass translates and the shape G1's inert-component scan matches. A
    // fixture written with the qualified name would exercise neither.
    await writeFile(
      join(dir, 'SKILL.md'),
      [
        '---',
        `name: ${options.skill.name}`,
        `description: Fixture skill for the CDP MCP naming wave; references the bundled ${options.skill.server} server.`,
        `allowed-tools: mcp__${options.skill.server}__*`,
        '---',
        '',
        `This skill exists only so a stood-down \`${options.skill.server}\` server has something to report as inert.`,
        '',
      ].join('\n'),
      'utf8',
    )
  }
}

/**
 * The tool name a MODEL is handed for a pool server's tool, per runtime — the
 * name a prompt may ask for, where {@link proxyToolName} is the name the host
 * RECORDS and the one a dispatch assertion keys on.
 *
 * On Pi the model is handed the POOL's proxy name ({@link piPoolToolName}, F1.550),
 * and the host records that same name — {@link proxyToolName} spells it for the
 * fixture's own `[A-Za-z0-9_-]` tool. On the Claude runtime they are one name for every
 * wire the resolver mints and every `[A-Za-z0-9_-]` tool: Claude Code builds the
 * model's name as `mcp__${ln(server)}__${ln(tool)}`, and its `ln` turns every
 * character outside `[a-zA-Z0-9_-]` into `_`, per UTF-16 unit, keeping hyphens
 * (vendored claude 2.1.251, read in its own bytes; F1.390 — its `claude.ai `
 * collapse branch is not modelled, no wire starts that way). On codex they are not,
 * and the spelling here is MEASURED, not derived from a comment (F1.153, read
 * beside F1.155): SIT-11's codex driver, packaged 1.40.0, three readings — the
 * model listed and called `plugin_cdp_echo_probe_echo__whoami` (C4, a per-call
 * nonce came back) and `dpGitlab__dp_gitlab_whoami` (A3), and answered that
 * `mcp__sources__…` "does not exist in my available tools". So: no `mcp__`
 * prefix, no bridge key, hyphens as underscores. F1.277: the rule is now the
 * product's own `codexModelToolName` (read at the pinned tag, F1.155), so every
 * non-`[A-Za-z0-9_]` character maps, not only the one hyphen measured.
 *
 * If F1.155 changes the projection, `codexModelToolName` changes with it and
 * this function FOLLOWS — it cannot go red on its own (F1.392). What goes red is
 * the literal pins, which spell the measured names by hand on purpose:
 * `harness.test.ts`'s MCP-W2 arm 1 and the literals in
 * `mcp-naming-codex-model-name.test.ts`. A change to what the runtime can see
 * must fail THERE, never be accepted in either spelling.
 */
export function modelToolName(
  wireName: string,
  runtime: 'pi' | 'claude' | 'codex' = 'pi',
  tool: string = FIXTURE.toolName,
): string {
  if (runtime === 'codex') return codexModelToolName(wireName, tool) // F1.277 — the product's helper
  if (runtime === 'pi') return piPoolToolName(wireName, tool) // F1.550 — the pool's own proxy name
  const ln = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_') // F1.390 — Claude Code's `ln`
  return `mcp__${ln(wireName)}__${ln(tool)}`
}

/**
 * The name the POOL publishes for a server's tool — what a Pi model is handed
 * (F1.550, origin WJ-aw proposed row 1). A MIRROR of `buildPoolProxyBaseName`
 * (`packages/shared/src/mcp/mcp-pool.ts`), not an import of it: that module cost
 * 51.5 s to import from `scripts/cdp` on 2026-09-24 (`bun -e`, user 0.56 s — the
 * filesystem, not the code), and every case loads this file. What it mirrors:
 * the wire stays as minted; the TOOL segment has every character outside
 * `[A-Za-z0-9_-]` turned into `_`, one per UTF-16 unit (the pool's
 * `sanitizeMcpToolNameSegment`); a name over 64 characters has its tool segment
 * cut to `max(8, 64 - prefix)` by the product's own `capMcpNameSegment`, which is
 * imported (its module is cheap). Not modelled: the pool's `_2` suffix for two
 * tools of ONE server that sanitize to one name. `mcp-naming-pi-model-name.test.ts`
 * runs the real helper beside this on fixed inputs, so the two cannot part
 * company without going red there.
 */
function piPoolToolName(wireName: string, tool: string): string {
  const prefix = `mcp__${wireName}__`
  const segment = tool.replace(/[^A-Za-z0-9_-]/g, '_')
  if (prefix.length + segment.length <= 64) return `${prefix}${segment}`
  return `${prefix}${capMcpNameSegment(segment, Math.max(8, 64 - prefix.length))}`
}

/**
 * The fixture's config dir, as the APP's storage readiness will judge it.
 *
 * **F1.146 (SIT-11 `P-SIT11-2`): this file used to write into the config dir
 * BEFORE the app had ever booted it, and that made the whole MCP-W wave a dead
 * gate.** It `mkdir`ed the dir and wrote `mcp.json` plus a `config.json` holding
 * nothing but `builtinDpMcpServers`. A NON-default config root that already
 * holds files is exactly what `ensureStorageLayoutV2` refuses
 * (`packages/shared/src/workspaces/storage-readiness.ts`: a `config.json` with no
 * `storageLayoutVersion` reads as `legacy`, a non-empty dir with no `config.json`
 * cannot be removed as empty, and both answer `custom-root-reset-required`). So
 * the documented precondition — build this tree, then launch on its config dir —
 * never rendered a window: all three SIT-11 drivers measured the boot log's
 * `"code":"custom-root-reset-required"` and `RS-32` answering `renderer-gone`,
 * and each built the precondition by hand on a config dir the app booted first.
 * `rs-43.ts` had recorded the same refusal for its own rig.
 *
 * So the rule is the product's own discriminator, read the way the product reads
 * it — a `config.json` carrying a numeric `storageLayoutVersion` is a root the
 * app wrote — and nothing is ever written into any other state:
 *
 * - `absent` / `empty` — the app has not booted it yet. Boot once, quit, re-run.
 * - `booted` — safe to seed: `config.json` is MERGED (its layout version and
 *   every key the app wrote survive), `mcp.json` is written beside it.
 * - `refused` — files without a layout version: the dead gate itself, usually
 *   left by this file's OLD shape. The app will refuse it; remove the dir.
 */
export type FixtureConfigDirState = 'absent' | 'empty' | 'booted' | 'refused'

export function inspectFixtureConfigDir(configDir: string): { state: FixtureConfigDirState; detail: string } {
  if (!existsSync(configDir)) return { state: 'absent', detail: `${configDir} does not exist yet` }
  const entries = readdirSync(configDir)
  if (entries.length === 0) return { state: 'empty', detail: `${configDir} is empty` }
  const configPath = join(configDir, 'config.json')
  if (!existsSync(configPath)) {
    return {
      state: 'refused',
      detail: `${configDir} holds ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} (${entries.slice(0, 4).join(', ')}) `
        + 'and no config.json — the app answers custom-root-reset-required for such a root',
    }
  }
  let version: unknown
  try {
    version = (JSON.parse(readFileSync(configPath, 'utf8')) as { storageLayoutVersion?: unknown }).storageLayoutVersion
  } catch {
    return { state: 'refused', detail: `${configPath} is not JSON — the app answers invalid-marker for such a root` }
  }
  if (typeof version !== 'number') {
    return {
      state: 'refused',
      detail: `${configPath} carries no storageLayoutVersion — a config.json the rig wrote before the app booted, `
        + 'which the app answers with custom-root-reset-required',
    }
  }
  return { state: 'booted', detail: `${configPath} carries storageLayoutVersion ${String(version)}` }
}

/** What {@link buildFixtures} did to the config dir, and the reason when it did nothing. */
export interface FixtureConfigSeed {
  state: FixtureConfigDirState
  seeded: boolean
  detail: string
}

/**
 * Build the fixture tree. `seedConfigDir: false` builds the registries, probe
 * servers and tokens and never touches the config dir — what a CASE wants when
 * it only needs a registry path (`agent-install.ts`, `plugin-install-runtimes.ts`):
 * the only config dir this function will write is a BOOTED one, which during a
 * case is the running app's own, and a case never rewrites config (README).
 */
export async function buildFixtures(
  root = fixtureRoot(),
  options: { seedConfigDir?: boolean } = {},
): Promise<{ paths: FixturePaths; tokens: FixtureTokens; config: FixtureConfigSeed }> {
  const paths = fixturePaths(root)
  // Everything EXCEPT the config dir is rebuilt from scratch: the config dir
  // accumulates the app's own state (installed plugins, connections, sessions)
  // across a wave and wiping it would throw away the install the cases measure.
  for (const dir of [paths.marketA, paths.marketB, join(root, 'probe')]) {
    await rm(dir, { recursive: true, force: true })
  }
  // NOT the config dir: creating it is harmless (an empty root is replaced) but
  // writing into it before the app boots it is the dead gate (F1.146).
  await mkdir(join(root, 'probe'), { recursive: true })

  const tokens: FixtureTokens = {
    pluginEcho: token('G6PLUGIN'),
    scopedSanitized: token('G6SANITIZED'),
    scopedCyrillic: token('G6CYRILLIC'),
  }
  await writeJson(paths.tokensFile, tokens)

  const identity = (label: string, tok: string) => ({ label, token: tok, log: paths.logFile })

  // ---- market A ----------------------------------------------------------
  await writeClaudePlugin({
    dir: join(paths.marketA, FIXTURE.pluginEchoId),
    id: FIXTURE.pluginEchoId,
    description: 'CDP fixture: a credential-free stdio MCP server, so a live turn can actually call a tool.',
    probeIdentity: identity('plugin-echo', tokens.pluginEcho),
    mcpServers: {
      [FIXTURE.echoServerName]: {
        command: 'node',
        // `${CLAUDE_PLUGIN_ROOT}` is the documented plugin-root variable and it
        // is what makes the bundle relocatable into the plugin cache — an
        // absolute path baked here would point back at this fixture tree and
        // stop proving anything about a real install.
        //
        // The trailing `--server echo` is NOT decoration. `declaredEndpointIdentity`
        // is `stdio:[command, ...args]:<env fingerprint>`, and once the identity
        // moved out of `env` and into the script, this bundle and the dual
        // bundles declared the same command with the same args — so T4b
        // deduped THEM against each other and the echo server went inert with
        // `duplicates-endpoint`. Measured, not theorised.
        args: ['${CLAUDE_PLUGIN_ROOT}/server/echo-server.mjs', '--server', 'echo'],
      },
    },
  })
  await writeClaudePlugin({
    dir: join(paths.marketA, FIXTURE.pluginTrackerId),
    id: FIXTURE.pluginTrackerId,
    description: 'CDP fixture: bundles an MCP server named exactly like the enabled built-in dp server.',
    skill: { name: 'cdp-tracker-helper', server: FIXTURE.trackerServerName },
    mcpServers: {
      // The argv tail `ai mcp tracker` is the endpoint identity the
      // builtin-vs-plugin dedup matches on — the literal shape of the
      // 2026-08-10 field incident, where marketplace plugins wrapped the same
      // `dp ai mcp <sub>` the built-in set already runs.
      [FIXTURE.trackerServerName]: { command: 'dp', args: ['ai', 'mcp', FIXTURE.builtinSubcommand] },
    },
  })
  const dual = (market: 'a' | 'b') => ({
    dir: join(market === 'a' ? paths.marketA : paths.marketB, FIXTURE.pluginDualId),
    id: FIXTURE.pluginDualId,
    description: `CDP fixture: the SAME pluginId served from local registry ${market.toUpperCase()}.`,
    probeIdentity: identity('plugin-dual', tokens.pluginEcho),
    mcpServers: {
      // Byte-identical between the two registries on purpose: two marketplaces
      // mirroring one plugin is the realistic shape, and an identical DECLARED
      // endpoint is what T4b's plugin-vs-plugin dedup keys on. A deliberately
      // different endpoint would dodge that pass and measure another question.
      [FIXTURE.dualServerName]: {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/server/echo-server.mjs', '--server', 'dual'],
      },
    },
  })
  await writeClaudePlugin(dual('a'))
  await writeClaudePlugin(dual('b'))

  // ---- registry catalog manifests -----------------------------------------
  // A registry is only consumable if its ROOT carries one of
  // `REGISTRY_CATALOG_MANIFEST_FILES` (`plugins/registry-catalog-fetcher.ts`:
  // marketplace.json, plugins.json, .agents/plugins/marketplace.json,
  // .claude-plugin/marketplace.json). Without one, `addRegistry()` accepts the
  // folder and its catalog stays EMPTY — measured live 2026-08-14: the row
  // never reaches `marketplace.list`, `plugin_plan_install` answers "no listing
  // in any configured marketplace", and `upgradeRegistry` refuses `not-git`.
  // The `{name, description, plugins:[{name, source}]}` shape is
  // `ExternalPluginCatalogDto` as `parseExternalPluginCatalog` already accepts
  // it; `source` is the plugin's directory RELATIVE to this manifest.
  await writeJson(join(paths.marketA, 'marketplace.json'), {
    name: 'market-a',
    description: 'CDP fixture registry A.',
    plugins: [
      { name: FIXTURE.pluginEchoId, source: `./${FIXTURE.pluginEchoId}` },
      { name: FIXTURE.pluginTrackerId, source: `./${FIXTURE.pluginTrackerId}` },
      { name: FIXTURE.pluginDualId, source: `./${FIXTURE.pluginDualId}` },
    ],
  })
  await writeJson(join(paths.marketB, 'marketplace.json'), {
    name: 'market-b',
    description: 'CDP fixture registry B.',
    plugins: [
      { name: FIXTURE.pluginDualId, source: `./${FIXTURE.pluginDualId}` },
    ],
  })

  // ---- global-scope MCP config in the fixture config dir ------------------
  // `<configDir>/mcp.json` is the GLOBAL native scope
  // (`native-sources.ts:1507`), so these two servers need no project and no
  // project-trust grant — the trust gate is a variable this wave does not want.
  await writeProbeServer(join(root, 'probe', 'scoped-sanitized.mjs'), identity('scoped-sanitized', tokens.scopedSanitized))
  await writeProbeServer(join(root, 'probe', 'scoped-cyrillic.mjs'), identity('scoped-cyrillic', tokens.scopedCyrillic))
  await writeFile(paths.logFile, '', 'utf8')

  // Everything below writes INTO the app's config dir, so it runs only on a root
  // the app has booted (F1.146 — {@link inspectFixtureConfigDir}).
  const inspected = inspectFixtureConfigDir(paths.configDir)
  if (inspected.state !== 'booted' || options.seedConfigDir === false) {
    return {
      paths, tokens,
      config: options.seedConfigDir === false
        ? { ...inspected, seeded: false, detail: `not asked to seed (${inspected.detail})` }
        : { ...inspected, seeded: false },
    }
  }
  await writeJson(join(paths.configDir, 'mcp.json'), {
    mcpServers: {
      [FIXTURE.scopedSanitizedName]: { command: 'node', args: [join(root, 'probe', 'scoped-sanitized.mjs')] },
      [FIXTURE.scopedCyrillicName]: { command: 'node', args: [join(root, 'probe', 'scoped-cyrillic.mjs')] },
    },
  })

  // ---- the built-in the plugin copy must not displace ---------------------
  // `t-tracker` is `defaultEnabled: false`, and the dedup pass only fires
  // against an ENABLED built-in, so the fixture has to turn it on. Merged into
  // whatever config the app has already written rather than overwriting it.
  const configPath = join(paths.configDir, 'config.json')
  const existing = existsSync(configPath)
    ? JSON.parse(await Bun.file(configPath).text()) as Record<string, unknown>
    : {}
  const builtins = (existing.builtinDpMcpServers ?? {}) as { enabled?: Record<string, boolean> }
  await writeJson(configPath, {
    ...existing,
    builtinDpMcpServers: { ...builtins, enabled: { ...(builtins.enabled ?? {}), [FIXTURE.builtinName]: true } },
  })

  return { paths, tokens, config: { ...inspected, seeded: true } }
}

/**
 * F1.148 - the plugin bundle SIT-11's claude and codex lanes minted for C6/C7 and
 * threw away, as a fixture: ONE prompt command and TWO command hooks, served from
 * its own local registry `market-c`.
 *
 * - The command's body carries a per-build token that is in NO description, no
 *   manifest and no palette string, so a reply carrying it proves the command's
 *   BODY reached the model and not merely its name (the SIT-11 control).
 * - `PreToolUse` (matcher `Bash`) and `PostToolUse` (no matcher) each append their
 *   own marker to their own hit file. Both, because codex leaves `PreToolUse`
 *   unwired by design (`noteCodexToolCallForHooks`'s docblock) - one bundle then
 *   carries a hook that should fire and the documented null beside it, on the
 *   same tool call (SIT-11's codex lane needed a second plugin for that).
 * - Everything lands under `<root>/market-c` and `<root>/cmdhook`; the config dir
 *   is never written - the case installs through the app's own marketplace RPC.
 */
export const CMDHOOK = {
  pluginId: 'cdp-cmdhook-probe',
  commandName: 'cdp-probe-cmd',
  commandDescription: 'CDP fixture command - asks the model to echo one fixed token.',
  marketName: 'market-c',
  preMatcher: 'Bash',
} as const

export interface CmdHookFixture {
  market: string
  /** In the command BODY only. */
  commandToken: string
  preMarker: string
  postMarker: string
  preHitFile: string
  postHitFile: string
}

export async function buildCmdHookFixture(root = fixtureRoot()): Promise<CmdHookFixture> {
  if (root.includes("'")) throw new Error(`the fixture root ${root} carries a single quote, which the hook commands cannot quote`)
  const market = join(root, CMDHOOK.marketName)
  const hits = join(root, 'cmdhook')
  for (const dir of [market, hits]) await rm(dir, { recursive: true, force: true })
  await mkdir(hits, { recursive: true })
  const fixture: CmdHookFixture = {
    market,
    commandToken: token('CMDHOOK-COMMAND-REACHED'),
    preMarker: token('CMDHOOK-PRE'),
    postMarker: token('CMDHOOK-POST'),
    preHitFile: join(hits, 'pre-hit.txt'),
    postHitFile: join(hits, 'post-hit.txt'),
  }
  const append = (marker: string, file: string): string => `printf '%s\\n' '${marker}' >> '${file}'`
  await writeClaudePlugin({
    dir: join(market, CMDHOOK.pluginId),
    id: CMDHOOK.pluginId,
    description: 'CDP fixture: a plugin that ships one prompt command and two command hooks.',
    mcpServers: {},
    commands: {
      [CMDHOOK.commandName]: [
        '---',
        `description: ${CMDHOOK.commandDescription}`,
        '---',
        `Reply with exactly this token and nothing else: ${fixture.commandToken}`,
        '',
      ].join('\n'),
    },
    hooks: {
      hooks: {
        PreToolUse: [{ matcher: CMDHOOK.preMatcher, hooks: [{ type: 'command', command: append(fixture.preMarker, fixture.preHitFile) }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: append(fixture.postMarker, fixture.postHitFile) }] }],
      },
    },
  })
  await writeJson(join(market, 'marketplace.json'), {
    name: CMDHOOK.marketName,
    description: 'CDP fixture registry C (F1.148).',
    plugins: [{ name: CMDHOOK.pluginId, source: `./${CMDHOOK.pluginId}` }],
  })
  await writeJson(join(root, 'cmdhook-tokens.json'), fixture)
  return fixture
}

export async function readTokens(root = fixtureRoot()): Promise<FixtureTokens | undefined> {
  const path = fixturePaths(root).tokensFile
  if (!existsSync(path)) return undefined
  return JSON.parse(await Bun.file(path).text()) as FixtureTokens
}

if (import.meta.main) {
  const paths = fixturePaths()
  if (process.argv.includes('--print')) {
    console.log(JSON.stringify({ paths, expected: EXPECTED, fixture: FIXTURE }, null, 2))
  } else {
    const { tokens, config } = await buildFixtures()
    console.log(JSON.stringify({ paths, tokens, expected: EXPECTED, config }, null, 2))
    if (config.state === 'refused') {
      console.error(`\nThe config dir is one the app REFUSES to boot (${config.detail}).\n`
        + `Nothing was written into it. Remove it (rm -rf ${paths.configDir}) and start again from a fresh one.\n`)
      process.exitCode = 1
    } else if (!config.seeded) {
      console.error(`\nThe app has not booted ${paths.configDir} yet (${config.state}), so nothing was written into it.\n`
        + 'Launch the app ONCE against it so it writes its own root, quit, then re-run this script:\n'
        + `  NESSY_CONFIG_DIR=${paths.configDir} <the app>   # boot once, then quit\n`
        + '  bun run scripts/cdp/fixtures/mcp-naming.ts        # seeds mcp.json + enables t-tracker\n')
    } else {
      console.error(`\nSeeded ${paths.configDir}. Launch the app against it, then install the probe plugins through\n`
        + `the app's own marketplace RPC (market-a: ${paths.marketA}, market-b: ${paths.marketB}):\n`
        + `  NESSY_CONFIG_DIR=${paths.configDir} <the app> --remote-debugging-port=<your port>\n`)
    }
  }
}
