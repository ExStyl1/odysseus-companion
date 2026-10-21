/**
 * `nessy-general-agent plugin <verb>` — the plugin authoring verbs.
 *
 * `plugins/cli-reference.md#claude-plugin-commands` documents a CLI plugin surface for "non-interactive
 * plugin management, useful for scripting and automation".
 *
 * - `validate <path>` (`:1192`) — "Run `claude plugin validate ./my-plugin` ...
 *   to check `plugin.json`, skill/agent/command frontmatter, and
 *   `hooks/hooks.json` for syntax and schema errors". `:486` — "Pass `--strict`
 *   to treat warnings as errors."
 * - `list` (`:1078`) — "List installed plugins with their version, source
 *   marketplace, and enable status", with `--json` from its option table.
 * - `details <name>` (`:1101`) — "Show a plugin's component inventory and
 *   projected token cost ... grouped as Skills, Agents, Hooks, MCP servers, and
 *   LSP servers ... The Skills group includes both `skills/` and `commands/`
 *   entries."
 *
 * Note that `validate` is NOT in the page's own CLI verb table (`:868`-`:1174`,
 * ten verbs, none of them `validate`). It is specified in § *Unrecognized fields*
 * (`:477`-`:491`), § *Experimental components* (`:540`) and the § *Common issues*
 * table (`:1192`), which is also the only place its arguments appear. A reader who
 * trusts the verb table concludes the verb does not exist.
 *
 * ## Why the CLI, and why no server
 *
 * `validate` is an authoring command: a plugin author runs it on a directory that
 * is not installed anywhere, and `:486` names CI as its use. A verb that needed a
 * running desktop app would be unusable in both settings. `list` and `details`
 * read only the local plugin registry and the local activation policy, so they
 * need no server either. All three are dispatched alongside `doctor`, above the
 * server-URL requirement — the same reasoning `doctor.ts` records for
 * `settings-reference.md#requiredminimumversion`: "`claude update`, `claude
 * install`, and `claude doctor` keep working below the floor so users can
 * recover."
 *
 * ## Not implemented here, deliberately
 *
 * `list --available` (`plugins-reference.md` § *plugin list*) is a marketplace
 * fetch; `plugin init` is covered by `/create-plugin` and the bundled
 * `plugin-creator` skill. Each is a category string in the deviation register
 * rather than a half-built verb.
 *
 * Three OPTIONS are absent by decision too, and each is refused or named rather
 * than silently ignored — see the block above `managementService`: `-s,
 * --scope`, `-y, --yes`, and a `--config` naming a SENSITIVE `userConfig` field.
 *
 * ## The mutating verbs (P6.420)
 *
 * `install`, `uninstall` (+ `remove`/`rm`), `update`, `prune` (+ `autoremove`)
 * and `marketplace add|list|remove|update` are dispatched here since P6.420, so
 * plugins can be provisioned from a script. They drive OUR store through the
 * same `PluginManagementServiceV2` and `createPluginRegistrySource()` the RPC
 * uses — no second code path and no second set of guards.
 *
 * ## The dependency verbs — what this paragraph used to say, and what is true
 *
 * P6.413, re-measured 2026-09-06. This block read "`prune`, transitive `enable`
 * and dependent-blocking `disable` need the `dependencies` graph and an
 * auto-installed provenance bit that do not exist yet". Three quarters of that
 * is stale, and it is cited as EVIDENCE by the tracker row, so it was making a
 * built behaviour look absent:
 *
 * - **Auto-install and transitive install: built.** `marketplace/service.ts`
 *   resolves the declared closure through `marketplace/dependency-acquisition.ts`
 *   and recurses into each installed dependency's own `dependencies`.
 * - **Transitive enable: built.** `plugins/management-service-v2.ts`
 *   `enableUnlocked` resolves the transitive set BEFORE writing anything and
 *   writes an explicit `true` for the plugin and each dependency, per
 *   `plugin-dependencies.md` § *Enable or disable a plugin with dependencies*:
 *   "Enable succeeds and writes `true` for the plugin and each dependency that
 *   was not already enabled at the target scope."
 * - **Dependent-blocking disable: built,** in the same file, with the page's own
 *   chained command. Both are driven by `plugins/__tests__/management-service-v2.test.ts`
 *   § *PluginManagementServiceV2 — plugin dependencies*.
 * - **`prune` and the auto-installed provenance bit: built (P6.557), and NOT
 *   here.** The bit is `PluginInstalledEntryV2.autoInstalled`, written only by
 *   the dependency-acquisition call in `marketplace/service.ts`; the verb is
 *   `PluginManagementServiceV2.pruneDependencies`, reached by every runtime
 *   through `plugin_manage`'s `prune` action. It is named `pruneDependencies`
 *   because `PluginStoreV2.prune()` still means the lease/superseded-version
 *   sweep — a different thing one word apart, which is what this paragraph used
 *   to warn about.
 *   This dispatcher had no `prune` verb and no `uninstall` verb until P6.420,
 *   which is the CLI gap that sentence described; both are dispatched now, and
 *   `uninstall --prune` chains them in the page's own order.
 *
 * ## `enable` and `disable` — the activation verbs (P6.559, P6.622)
 *
 * The refusal `assertNoEnabledDependents` raises hands the user a chained
 * `nessy-general-agent plugin disable <key> && …` remedy — the page's own text
 * (`plugin-dependencies.md` § *Enable or disable a plugin with dependencies*:
 * "The error message includes a chained command that disables every dependent
 * first"). Until P6.559 that remedy named a verb this dispatcher did not have,
 * so following the instruction printed `Unknown plugin verb: disable`.
 *
 * It runs the SAME guard, not a second one: `runDisable` calls
 * `PluginManagementServiceV2.disable`, which is the method `plugin_manage`'s
 * `disable` action calls, so the CLI and the RPC cannot disagree about when a
 * disable is refused. `plugin.test.ts` reads the remedy's verbs back out of
 * `management-service-v2.ts` and asserts each one dispatches, so a reworded
 * remedy naming a verb we do not have turns the suite red instead of shipping.
 *
 * Two documented options are NOT implemented, and the reason is the same one the
 * `enabled` column carries: `-s, --scope <scope>` takes `user`, `project` or
 * `local`, and the CLI carries no workspace or project context, so `user` — this
 * tree's `global` — is the only scope it could ever detect. `-a, --all` is a bulk
 * mutation nothing asks for; the remedy chains explicit keys. Both are absent by
 * decision rather than half-built, and the output names the scope it wrote so a
 * reader is never left guessing which layer moved.
 *
 * `enable` (P6.622) is the inverse, and it exists for the same reason: a CLI
 * that can disable a plugin and cannot re-enable it turns any chained remedy
 * into a one-way door. It calls `PluginManagementServiceV2.enable`, the method
 * `plugin_manage`'s `enable` action calls, so the transitive-dependency
 * resolution documented in `plugin-dependencies.md` § *Enable or disable a
 * plugin with dependencies* is the RPC's own and is never re-derived here. Its
 * one documented option, `-s, --scope <scope>`, is absent for the reason above;
 * the verb has no `-a, --all` to be absent, because § *plugin enable*'s option
 * table has none.
 *
 * ## i18n
 *
 * None of these strings are translated. R30b established that the CLI is
 * English-only: `apps/cli` has no `t()`/`i18n.t()` callsite and no locale
 * loading, and the i18n parity/sorted checks cover `packages/shared`'s locale
 * files, which this module does not touch. The rule that applies here is
 * AGENTS.md's "Code, comments and commit messages in English", not the i18n rule.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { CapabilityPolicyStore } from '@nessy-agent/shared/capabilities/policy-store'
import { CapabilityTrustStore } from '@nessy-agent/shared/capabilities/trust-store'
import { validateMarkdownAgentDefinitionContent } from '@nessy-agent/shared/agents'
import { validatePiRuntimeAgentDefinitionContent } from '@nessy-agent/shared/agent/pi-harness/runtime-agent-definition'
import {
  createPluginBundleValidator,
  describePluginDependencyError,
  PluginManagementServiceV2,
  PluginStoreV2,
  resolvePluginDependencyErrors,
  type PluginBundleValidationOptions,
  type PluginBundleValidationResult,
} from '@nessy-agent/shared/plugins'
import type { PluginDiagnostic, PluginInstallSource } from '@nessy-agent/shared/plugins/types'
import { createPluginRegistrySource } from '@nessy-agent/shared/marketplace/registry-source'
import { createPluginInstallSourceFromMarketplaceItem } from '@nessy-agent/shared/marketplace/install-source'
import type { MarketplaceRegistryController } from '@nessy-agent/shared/marketplace/registry-source'

/** One installed plugin, flattened for rendering. */
export interface PluginInventoryRow {
  pluginKey: string
  pluginId: string
  name: string
  version: string
  /** `:1078`'s "source marketplace". `local` for a directory install. */
  marketplaceId: string
  description?: string
  /**
   * Global-scope activation. The CLI carries no workspace or project context, so
   * only the global layer can be reported; `unset` means no explicit decision at
   * that scope, which is not the same as disabled.
   */
  enabled: 'enabled' | 'disabled' | 'unset'
  components: PluginInventoryComponent[]
  diagnostics: { severity: string; code: string; message: string }[]
  /**
   * Unsatisfied declared plugin dependencies (`plugins/host-marketplace.md#depend-on-and-recommend-other-plugins`):
   * "Plugins with problems include an `errors` field listing them. Plugins that
   * loaded cleanly omit the field." Computed through the SAME
   * `resolvePluginDependencyErrors` the capability resolver uses, so the CLI and
   * the app cannot disagree about whether a plugin's dependencies are satisfied.
   */
  errors?: { code: string; dependency: string; message: string }[]
}

export interface PluginInventoryComponent {
  capabilityId: string
  kind: string
  name: string
  description?: string
}

/**
 * What `enable` hands back — the one field this verb reads out of
 * `PluginManagementInstalledSummary` (P6.628). Structurally typed rather than
 * imported whole, so an injected test double states the transitive set and
 * nothing else.
 */
export interface PluginEnableOutcome {
  readonly enabledDependencies?: readonly string[]
}

export interface PluginCommandOptions {
  /** Raw JSON for scripting, matching the CLI's global `--json`. */
  readonly json?: boolean
  /** Injected for tests; production reads the real store and activation policy. */
  readonly collect?: () => Promise<PluginInventoryRow[]>
  /** Injected for tests; production composes the shared bundle validator. */
  readonly validate?: (
    source: PluginInstallSource,
    options?: PluginBundleValidationOptions,
  ) => Promise<PluginBundleValidationResult>
  /**
   * Injected for tests; production enables through the shared management
   * service, so the transitive-dependency resolution is the RPC's own. A
   * rejection is the refusal — this verb never resolves the graph itself.
   */
  readonly enable?: (pluginKey: string) => Promise<PluginEnableOutcome>
  /**
   * Injected for tests; production disables through the shared management
   * service, so the dependent-blocking guard is the RPC's own. A rejection is
   * the refusal — this verb never inspects the dependency graph itself.
   */
  readonly disable?: (pluginKey: string) => Promise<unknown>
  /**
   * Injected for tests; production builds the same `PluginManagementServiceV2`
   * `disable` uses, so the mutating verbs share one mutation lock and one set of
   * guards with the RPC.
   */
  readonly management?: () => PluginMutationApi
  /**
   * Injected for tests; production builds the shared registry controller
   * (`createPluginRegistrySource()` takes no arguments and needs no server).
   */
  readonly registry?: () => MarketplaceRegistryApi
}

/**
 * The four mutating methods these verbs need, named as a structural type rather
 * than taken as `PluginManagementServiceV2` — a CLI verb must not be able to
 * reach `setCapabilityEnabled` or `clearConfiguration` by accident, and a test
 * double should not have to implement twenty methods to assert one.
 */
export interface PluginMutationApi {
  install(source: PluginInstallSource, options?: { activateIn?: unknown }): Promise<unknown>
  update(pluginKey: string): Promise<unknown>
  uninstall(pluginKey: string, options?: { keepData?: boolean }): Promise<unknown>
  configure(pluginKey: string, workspaceId: string, values: Record<string, unknown>): Promise<unknown>
  pruneDependencies(options?: { dryRun?: boolean }): Promise<unknown>
}

/** The registry mutations `plugin marketplace` drives, same reasoning. */
export interface MarketplaceRegistryApi {
  add(request: {
    source: string
    refName?: string
    sparsePaths?: string[]
    displayName?: string
  }): Promise<{ marketplaceId: string; displayName?: string }>
  remove(request: { marketplaceId: string }): Promise<unknown>
  list(): Promise<{ registries: Array<{ marketplaceId: string; displayName: string; refName?: string; autoUpdate: boolean; autoUpdateManaged: boolean }> }>
  upgrade(request: { marketplaceId: string }): Promise<{ upgraded: boolean; reason?: string }>
  refreshForInstall(request: { marketplaceId: string }): Promise<unknown>
  peekCachedItems(): Promise<Array<{
    id: string
    name: string
    marketplaceRegistryId?: string
    marketplaceRegistryLabel?: string
    install: unknown
  }>>
}

export interface PluginCommandResult {
  readonly text: string
  /** Non-zero when the verb failed or the validation did not pass. */
  readonly exitCode: number
}

const USAGE = `Usage: nessy-general-agent plugin <verb> [args]

  validate <path> [--strict]  Validate a plugin bundle without installing it.
                              --strict treats warnings as errors (for CI).
                              Agent frontmatter is checked in the path itself
                              and in an 'agents' folder under it, with or
                              without a manifest. Skills and commands are not.
  list                        Installed plugins: version, source marketplace,
                              global enable status.
  details <name>              Component inventory and projected token cost for
                              one installed plugin, by name, id or pluginKey.
  enable <name>               Turn one installed plugin on at the global (user)
                              scope, with its dependencies. Refuses when a
                              dependency cannot be enabled.
  disable <name>              Turn one installed plugin off at the global (user)
                              scope, without uninstalling it. Refuses while
                              another enabled plugin still depends on it.
  install <plugin>            Install by catalog name, or name@marketplace.
                              --config <key=value>  set a userConfig option
                                                    (repeatable; needs --workspace)
                              --workspace <id>      the workspace --config writes for
  uninstall <name>            Uninstall one plugin. Aliases: remove, rm.
                              --keep-data  preserve the plugin's data directory
                              --prune      also drop orphaned auto-installed deps
  update <name>               Reinstall one plugin from its recorded source.
  prune                       Drop auto-installed dependencies nothing needs.
                              --dry-run  list them without removing anything
  marketplace add <source>    Register a marketplace. --ref, --sparse, --name
  marketplace list            Registered marketplaces and their auto-update state.
  marketplace remove <id>     Unregister one. Alias: rm.
  marketplace update [id]     Re-fetch one catalog, or every one when omitted.

Global --json applies to every verb.`

export async function runPluginCommand(
  argv: readonly string[],
  options: PluginCommandOptions = {},
): Promise<PluginCommandResult> {
  const verb = argv[0]
  const rest = argv.slice(1)
  switch (verb) {
    case 'validate':
      return runValidate(rest, options)
    case 'list':
    // `:1097` — "`ls` as a shorthand for `list`".
    case 'ls':
      return runList(options)
    case 'details':
      return runDetails(rest, options)
    case 'enable':
      return runEnable(rest, options)
    case 'disable':
      return runDisable(rest, options)
    case 'install':
      return runInstall(rest, options)
    // `plugins-reference.md` § *plugin uninstall*: "**Aliases:** `remove`, `rm`".
    case 'uninstall':
    case 'remove':
    case 'rm':
      return runUninstall(rest, options)
    case 'update':
      return runUpdate(rest, options)
    // § *plugin prune*: "**Aliases:** `autoremove`".
    case 'prune':
    case 'autoremove':
      return runPrune(rest, options)
    case 'marketplace':
      return runMarketplace(rest, options)
    case undefined:
      return { text: USAGE, exitCode: 1 }
    case 'help':
    case '--help':
    case '-h':
      return { text: USAGE, exitCode: 0 }
    default:
      return { text: `Unknown plugin verb: ${verb}\n\n${USAGE}`, exitCode: 1 }
  }
}

/**
 * `AGENTS.md`, `CLAUDE.md` and `CLAUDE.local.md` are instruction files kept
 * beside agent definitions, never definitions themselves. Same set, same
 * reason, as the doctor's agent checkup — kept local rather than imported so
 * this verb does not depend on the doctor module.
 */
const AGENT_INSTRUCTION_FILE_NAMES = new Set(['agents.md', 'claude.md', 'claude.local.md'])

function agentMarkdownFilesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile()
        && entry.name.toLowerCase().endsWith('.md')
        && !AGENT_INSTRUCTION_FILE_NAMES.has(entry.name.toLowerCase()))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * `plugin validate <dir>` reads the agent files under the directory it is given
 * — P6.317, `done_means` (1).
 *
 * `sub-agents.md` § *Check an `agents` directory before a session*, verbatim:
 * "To find files in an `agents` directory whose frontmatter doesn't parse, run
 * `claude plugin validate` against the directory, for example `.claude/agents`
 * or `~/.claude/agents`. Claude Code checks only the directory you name, and
 * doesn't flag a file whose frontmatter parses but has no `name`."
 * `plugin-marketplaces.md` § *Validate a plugin or a directory without a
 * manifest* carries the directory table this implements the agent rows of: the
 * named directory IS the agents directory ("One directory of skills, agents, or
 * commands, such as a plugin that has no `plugin.json` yet"), or it HOLDS one
 * ("A plugin that has a `plugin.json`" and "A project's three directories at
 * once"). Both shapes are the same scan, which is why there is one.
 *
 * NATIVE-FIRST: nothing to enable in any runtime — `plugin validate` is a host
 * CLI verb and the pages specify its SHAPE, not a component we could switch on.
 * So the host supplies it once, for all three runtimes, out of the validators
 * the session's own loaders already use: a file this reports and a file a
 * session skips cannot disagree, because the parse is the same one.
 *
 * MEASURED at HEAD before building, and the second half was not in the row:
 * a directory holding `agents/` and no manifest already validated as a `raw`
 * bundle and PASSED with `Capability kinds: agent` while one of its two agent
 * files had unparseable YAML. So the gap is not only "a bare agents directory
 * is refused" — it is also "an accepted bundle never reads the agent files".
 * One scan closes both.
 *
 * DELIBERATELY NARROWER than the page, and said out loud in the output rather
 * than left to be discovered: skill and command frontmatter is not checked.
 * Those are separate loaders; half-building them would be the looks-complete
 * shape this row exists to remove. Component paths set through `plugin.json`
 * are not followed either, which is the page's own rule: "For paths you set
 * through the component path fields in `plugin.json`, Claude Code checks that
 * each path exists but doesn't read the files there."
 */
function scanAgentDirectories(path: string): {
  diagnostics: PluginDiagnostic[]
  scanned: { dir: string; files: number }[]
} {
  const scanned: { dir: string; files: number }[] = []
  const diagnostics: PluginDiagnostic[] = []

  for (const dir of [path, join(path, 'agents')]) {
    const files = agentMarkdownFilesIn(dir)
    if (files.length === 0) continue
    scanned.push({ dir, files: files.length })
    for (const file of files) {
      const agentName = file.replace(/\.md$/i, '')
      let content: string
      try {
        content = readFileSync(join(dir, file), 'utf-8')
      } catch (error) {
        diagnostics.push({
          severity: 'error',
          code: 'plugin.validate.agent_file_unreadable',
          message: `Agent file could not be read: ${error instanceof Error ? error.message : String(error)}`,
          path: join(dir, file),
        })
        continue
      }
      // Both loaders, exactly as the session-free doctor checkup runs them: the
      // capability pipeline's parse and the markdown fallback loader's parse are
      // not identical, and a file that either one skips is a file some session
      // skips.
      const primary = validatePiRuntimeAgentDefinitionContent({ name: agentName, content })
      if (!primary.ok) {
        diagnostics.push({
          severity: 'error',
          code: 'plugin.validate.agent_frontmatter_invalid',
          message: primary.reason,
          path: join(dir, file),
        })
        continue
      }
      const fallback = validateMarkdownAgentDefinitionContent(file, content)
      if (!fallback.ok) {
        diagnostics.push({
          severity: 'error',
          code: 'plugin.validate.agent_frontmatter_invalid',
          message: `${fallback.reason} (markdown fallback loader)`,
          path: join(dir, file),
        })
      }
    }
  }

  return { diagnostics, scanned }
}

/**
 * Fold the agent scan into the bundle verdict.
 *
 * The missing-manifest error is DROPPED when agent files were found, which is
 * the page's own definition of that error: "`No manifest found in directory`
 * means Claude Code found no `plugin.json` or `marketplace.json` there, and no
 * skill, agent, or command file in the directories it probes under it."
 */
function withAgentScan(
  bundle: PluginBundleValidationResult,
  agentDiagnostics: readonly PluginDiagnostic[],
  strict: boolean,
): PluginBundleValidationResult {
  const diagnostics = [
    ...bundle.diagnostics.filter(diagnostic => diagnostic.code !== 'plugin.format.unsupported_format'),
    ...agentDiagnostics,
  ]
  const errorCount = diagnostics.filter(diagnostic => diagnostic.severity === 'error').length
  const warningCount = diagnostics.filter(diagnostic => diagnostic.severity === 'warning').length
  return {
    ...bundle,
    ok: errorCount === 0 && (!strict || warningCount === 0),
    diagnostics,
    errorCount,
    warningCount,
  }
}

async function runValidate(
  argv: readonly string[],
  options: PluginCommandOptions,
): Promise<PluginCommandResult> {
  const strict = argv.includes('--strict')
  const path = argv.find(arg => !arg.startsWith('-'))
  if (!path) {
    return { text: `plugin validate needs a bundle path.\n\n${USAGE}`, exitCode: 1 }
  }

  const validate = options.validate ?? createPluginBundleValidator().validate
  const bundleResult = await validate({ kind: 'local-path', path }, { strict })
  const agentScan = scanAgentDirectories(path)
  const result = agentScan.scanned.length === 0
    ? bundleResult
    : withAgentScan(bundleResult, agentScan.diagnostics, strict)

  if (options.json) {
    return { text: JSON.stringify(result, null, 2), exitCode: result.ok ? 0 : 1 }
  }

  const lines: string[] = []
  if (result.plugin) {
    lines.push(`${result.plugin.name} ${result.plugin.version} (${result.plugin.pluginId})`)
    lines.push(`  Capability kinds: ${result.plugin.capabilityKinds.join(', ') || 'none'}`)
  }
  if (result.compatibility) {
    lines.push(`  Format: ${result.compatibility.format} — ${result.compatibility.state}`)
  }
  if (result.diagnostics.length === 0) {
    lines.push('No diagnostics.')
  } else {
    lines.push('')
    for (const diagnostic of result.diagnostics) {
      const where = diagnostic.path ? ` [${diagnostic.path}]` : ''
      lines.push(`  ${diagnostic.severity}: ${diagnostic.code}${where}`)
      lines.push(`    ${diagnostic.message}`)
    }
  }
  lines.push('')
  lines.push(result.ok
    ? `PASS — ${result.errorCount} error(s), ${result.warningCount} warning(s)${strict ? ' (strict)' : ''}`
    // Name the rule that produced the verdict: a strict failure with zero errors
    // is otherwise indistinguishable from a broken manifest.
    : `FAIL — ${result.errorCount} error(s), ${result.warningCount} warning(s)${
      strict && result.errorCount === 0 ? ' (strict: warnings treated as errors)' : ''}`)
  for (const entry of agentScan.scanned) {
    lines.push(`  Checked ${entry.files} agent file(s) in ${entry.dir}.`)
  }
  if (agentScan.scanned.length > 0) {
    lines.push('  Skill and command frontmatter was not checked.')
  }
  lines.push(agentScan.scanned.length > 0 && !result.plugin
    ? '  No plugin manifest here — nothing was installed.'
    : '  This bundle was not installed.')
  return { text: lines.join('\n'), exitCode: result.ok ? 0 : 1 }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(options: PluginCommandOptions): Promise<PluginCommandResult> {
  const rows = await (options.collect ?? collectInventory)()

  if (options.json) {
    return {
      text: JSON.stringify(rows.map(row => ({
        pluginKey: row.pluginKey,
        pluginId: row.pluginId,
        name: row.name,
        version: row.version,
        marketplaceId: row.marketplaceId,
        enabled: row.enabled,
        ...(row.description ? { description: row.description } : {}),
        componentCount: row.components.length,
        diagnosticCount: row.diagnostics.length,
        ...(row.errors?.length ? { errors: row.errors } : {}),
      })), null, 2),
      exitCode: 0,
    }
  }

  if (rows.length === 0) return { text: 'No plugins installed.', exitCode: 0 }

  return {
    text: renderTable(
      ['NAME', 'VERSION', 'MARKETPLACE', 'ENABLED (GLOBAL)'],
      rows.map(row => [row.name, row.version, row.marketplaceId, row.enabled]),
    ),
    exitCode: 0,
  }
}

// ---------------------------------------------------------------------------
// details
// ---------------------------------------------------------------------------

/**
 * `:1101` groups the inventory as Skills, Agents, Hooks, MCP servers and LSP
 * servers, and states in the same line that "The Skills group includes both `skills/` and
 * `commands/` entries" — which is why `prompt-command` and `command` land in
 * Skills here rather than in a group of their own. The desktop inventory page
 * (`plugin-components-groups.ts`) deliberately splits them into a `command`
 * group instead; that is a UI affordance, not this verb's documented shape.
 */
const DETAIL_GROUPS: readonly { label: string; kinds: readonly string[] }[] = [
  { label: 'Skills', kinds: ['skill', 'prompt-command', 'command'] },
  { label: 'Agents', kinds: ['agent'] },
  { label: 'Hooks', kinds: ['hook'] },
  { label: 'MCP servers', kinds: ['mcp'] },
  { label: 'LSP servers', kinds: ['lsp'] },
]

async function runDetails(
  argv: readonly string[],
  options: PluginCommandOptions,
): Promise<PluginCommandResult> {
  const wanted = argv.find(arg => !arg.startsWith('-'))
  if (!wanted) {
    return { text: `plugin details needs a plugin name.\n\n${USAGE}`, exitCode: 1 }
  }
  const rows = await (options.collect ?? collectInventory)()
  const row = findInstalled(rows, wanted)
  if (!row) return { text: `No installed plugin named: ${wanted}`, exitCode: 1 }

  const groups = DETAIL_GROUPS.map(group => ({
    label: group.label,
    components: row.components.filter(component => group.kinds.includes(component.kind)),
  }))
  // Everything the documented five groups do not cover — workflows, settings,
  // assets, monitors, and `unsupported` (a deferred capability). Reporting them
  // under "Other" rather than dropping them keeps the inventory total honest.
  const other = row.components.filter(
    component => !DETAIL_GROUPS.some(group => group.kinds.includes(component.kind)),
  )
  const alwaysOnTokens = estimateAlwaysOnTokens(row)

  if (options.json) {
    return {
      text: JSON.stringify({
        pluginKey: row.pluginKey,
        pluginId: row.pluginId,
        name: row.name,
        version: row.version,
        marketplaceId: row.marketplaceId,
        enabled: row.enabled,
        ...(row.description ? { description: row.description } : {}),
        components: groups.map(group => ({
          group: group.label,
          items: group.components.map(component => ({
            capabilityId: component.capabilityId,
            kind: component.kind,
            name: component.name,
            ...(component.description ? { description: component.description } : {}),
            alwaysOnTokens: estimateComponentTokens(component),
          })),
        })),
        otherComponents: other.map(component => ({
          capabilityId: component.capabilityId,
          kind: component.kind,
          name: component.name,
        })),
        tokenCost: {
          alwaysOnTokens,
          // Naming the method is the point: a consumer must be able to tell a
          // measured count from an estimate, and an absent figure from a zero.
          method: 'character-estimate',
          onInvokeTokens: null,
        },
        diagnostics: row.diagnostics,
      }, null, 2),
      exitCode: 0,
    }
  }

  const lines: string[] = []
  lines.push(`${row.name} ${row.version}`)
  if (row.description) lines.push(`  ${row.description}`)
  lines.push(`  Source: ${row.pluginId}@${row.marketplaceId}`)
  lines.push(`  Enabled (global): ${row.enabled}`)
  lines.push('')
  lines.push('Component inventory')
  for (const group of groups) {
    const names = group.components.map(component => component.name).join(', ')
    lines.push(`  ${group.label} (${group.components.length})${names ? `  ${names}` : ''}`)
  }
  if (other.length > 0) {
    lines.push(`  Other (${other.length})  ${
      other.map(component => `${component.name} [${component.kind}]`).join(', ')}`)
  }
  lines.push('')
  lines.push('Projected token cost')
  lines.push(`  Always-on:   ~${alwaysOnTokens} tok   added to every session`)
  lines.push('')
  lines.push('Per-component (rounded)')
  lines.push(`  ${'component'.padEnd(28)}always-on`)
  for (const group of groups) {
    for (const component of group.components) {
      lines.push(`  ${component.name.padEnd(28)}~${estimateComponentTokens(component)}`)
    }
  }
  lines.push('')
  lines.push('  Token counts are a character-based estimate, not a count_tokens result.')
  lines.push('  On-invoke cost is not computed: it needs each component body read from')
  lines.push('  the installed bundle. See the deviation register.')
  if (row.diagnostics.length > 0) {
    lines.push('')
    lines.push('Diagnostics')
    for (const diagnostic of row.diagnostics) {
      lines.push(`  ${diagnostic.severity}: ${diagnostic.code} — ${diagnostic.message}`)
    }
  }
  return { text: lines.join('\n'), exitCode: 0 }
}

/**
 * `:1148` — "The always-on total is computed via the `count_tokens` API for your
 * active model ... If the API is unreachable, the command falls back to a
 * character-based estimate." This is that fallback, and it is the only path
 * implemented: the CLI has no active model connection, and this repository has no
 * `count_tokens` caller anywhere. The output labels the method so a reader is
 * never told an estimate is a measurement.
 *
 * Always-on is the plugin's LISTING text — `:1119`, "tokens added to every
 * session by the plugin's listing text, such as skill descriptions, agent
 * descriptions, and command names" — so this counts names and descriptions and
 * never a component body. On-invoke (`:1120`) needs those bodies and is deferred.
 */
function estimateComponentTokens(component: PluginInventoryComponent): number {
  return charactersToTokens(component.name.length + (component.description?.length ?? 0))
}

function estimateAlwaysOnTokens(row: PluginInventoryRow): number {
  return charactersToTokens(
    row.name.length
    + (row.description?.length ?? 0)
    + row.components.reduce(
      (total, component) => total + component.name.length + (component.description?.length ?? 0),
      0,
    ),
  )
}

/** Four characters per token, the conventional English ratio. */
function charactersToTokens(characters: number): number {
  return Math.ceil(characters / 4)
}

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

/**
 * `plugins-reference.md` § *plugin enable* — "Enable a disabled plugin. When the
 * target is installed from a marketplace and declares dependencies, Claude Code
 * enables them transitively at the same scope. The command fails under the
 * conditions that Enable or disable a plugin with dependencies lists."
 *
 * The same shape as `disable` for the same reason: `PluginManagementServiceV2`
 * `enableUnlocked` resolves the transitive set BEFORE writing anything and
 * refuses as a whole, so this verb resolves the name, asks the service, and
 * prints what came back. The four conditions in
 * `plugin-dependencies.md` § *Enable or disable a plugin with dependencies* are
 * the service's to decide, and its rejection is printed verbatim.
 *
 * ## The clause of the page this used NOT to satisfy — closed by P6.628
 *
 * "The success message lists what else was enabled along with the plugin you
 * named." It could not, at P6.622: `enable` returned a
 * `PluginManagementInstalledSummary` that described only the plugin that was
 * named. Diffing two inventory reads here would have been the second derivation
 * of a fact the service knows precisely that this file's neighbours warn
 * against, so the row widened the SUMMARY instead —
 * `enabledDependencies` — and this verb and `plugin_manage`'s `enable` action
 * both print the same list from the same source. Absent means nothing else
 * moved, and the line is omitted rather than printed empty.
 *
 * `-s, --scope <scope>` is absent for the reason recorded at the top of this
 * file: the CLI carries no workspace or project context, so `user` — this tree's
 * `global` — is the only scope it could ever detect. The output names the scope
 * it wrote.
 */
async function runEnable(
  argv: readonly string[],
  options: PluginCommandOptions,
): Promise<PluginCommandResult> {
  const wanted = argv.find(arg => !arg.startsWith('-'))
  if (!wanted) {
    return { text: `plugin enable needs a plugin name.\n\n${USAGE}`, exitCode: 1 }
  }
  const rows = await (options.collect ?? collectInventory)()
  const row = findInstalled(rows, wanted)
  if (!row) return { text: `No installed plugin named: ${wanted}`, exitCode: 1 }

  let outcome: PluginEnableOutcome
  try {
    outcome = await (options.enable ?? enableGlobally)(row.pluginKey)
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }
  const alsoEnabled = outcome?.enabledDependencies ?? []

  if (options.json) {
    return {
      text: JSON.stringify({
        pluginKey: row.pluginKey,
        pluginId: row.pluginId,
        name: row.name,
        scope: 'global',
        enabled: 'enabled',
        ...(alsoEnabled.length > 0 ? { enabledDependencies: [...alsoEnabled] } : {}),
      }, null, 2),
      exitCode: 0,
    }
  }
  const lines = [`Enabled (global): ${row.name}`]
  if (alsoEnabled.length > 0) {
    lines.push(`  Also enabled: ${alsoEnabled.join(', ')}`)
  }
  return { text: lines.join('\n'), exitCode: 0 }
}

/**
 * The production enable: the same `PluginManagementServiceV2.enable` that
 * `plugin_manage`'s `enable` action calls, at the only scope this CLI can
 * detect.
 */
async function enableGlobally(pluginKey: string): Promise<PluginEnableOutcome> {
  const service = new PluginManagementServiceV2({
    store: new PluginStoreV2(),
    policyStore: new CapabilityPolicyStore(),
    trustStore: new CapabilityTrustStore(),
  })
  return service.enable(pluginKey, { kind: 'global' })
}

/**
 * `plugins-reference.md` § *plugin disable* — "Disable a plugin without
 * uninstalling it. When the target is installed from a marketplace, the command
 * fails if another enabled plugin depends on it."
 *
 * The failure is the service's to raise, so the whole of this verb is: resolve
 * the name the same three ways `details` does, ask the service, and print what
 * came back. A rejection is printed as-is with a non-zero exit — the guard's
 * message already carries the page's chained remedy, and rewording it here would
 * put a second copy of the page's text in the tree.
 */
async function runDisable(
  argv: readonly string[],
  options: PluginCommandOptions,
): Promise<PluginCommandResult> {
  const wanted = argv.find(arg => !arg.startsWith('-'))
  if (!wanted) {
    return { text: `plugin disable needs a plugin name.\n\n${USAGE}`, exitCode: 1 }
  }
  const rows = await (options.collect ?? collectInventory)()
  const row = findInstalled(rows, wanted)
  if (!row) return { text: `No installed plugin named: ${wanted}`, exitCode: 1 }

  try {
    await (options.disable ?? disableGlobally)(row.pluginKey)
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }

  if (options.json) {
    return {
      text: JSON.stringify({
        pluginKey: row.pluginKey,
        pluginId: row.pluginId,
        name: row.name,
        scope: 'global',
        enabled: 'disabled',
      }, null, 2),
      exitCode: 0,
    }
  }
  return { text: `Disabled (global): ${row.name}`, exitCode: 0 }
}

/**
 * The production disable: the same `PluginManagementServiceV2.disable` that
 * `plugin_manage`'s `disable` action calls, at the only scope this CLI can
 * detect. Constructing the stores resolves paths and writes nothing; the write
 * happens inside the service's own mutation lock.
 */
async function disableGlobally(pluginKey: string): Promise<unknown> {
  const service = new PluginManagementServiceV2({
    store: new PluginStoreV2(),
    policyStore: new CapabilityPolicyStore(),
    trustStore: new CapabilityTrustStore(),
  })
  return service.disable(pluginKey, { kind: 'global' })
}

// ---------------------------------------------------------------------------
// install / uninstall / update / prune / marketplace  (P6.420)
// ---------------------------------------------------------------------------

/**
 * P6.420 — the mutating verbs, so a plugin can be provisioned from a script.
 *
 * ## What was missing, and what was not
 *
 * Nothing here is a new mechanism. `PluginManagementServiceV2` already owns
 * install, update, uninstall, configure and prune, and
 * `createPluginRegistrySource()` already owns the marketplace registry's
 * add/list/remove/upgrade — both reachable with no server and no workspace,
 * which is why the existing `disable` verb can construct its service in four
 * lines. The gap was the ENTRY POINT: this dispatcher had three read verbs and
 * one mutation, so `plugins-reference.md`'s § *Manage marketplaces from the CLI*
 * ("non-interactive … subcommands for scripting and automation") had no
 * counterpart here at all.
 *
 * ## Why `marketplace` nests under `plugin`
 *
 * Because that is the documented shape: `claude plugin marketplace add <source>`
 * (`plugin-marketplaces.md` § *Plugin marketplace add*), not a top-level
 * `marketplace` command. It also means the whole surface lands in this file and
 * `index.ts`'s argument parsing is untouched.
 *
 * ## The three documented options this fork cannot honour, named rather than faked
 *
 * - **`-s, --scope <scope>`** on every verb. The CLI carries no workspace or
 *   project context, so `user` — this tree's `global` — is the only scope it
 *   could ever detect. Same reason the `enabled` column is global-only, recorded
 *   at the top of this file.
 * - **`-y, --yes`** for a marketplace-declared `command` source or a
 *   `headersHelper`. Those confirmations live in the install stager, not here;
 *   a `--yes` accepted at this layer would be a promise this layer cannot keep.
 * - **A SENSITIVE `userConfig` field.** `configure` reads and writes those
 *   through a `CredentialManager`, which this process has none of, so a
 *   `--config` naming one is refused with the reason instead of being written
 *   somewhere weaker. Plain fields go to the same `PluginUserConfigStore` the
 *   desktop uses.
 */
function managementService(options: PluginCommandOptions): PluginMutationApi {
  if (options.management) return options.management()
  return new PluginManagementServiceV2({
    store: new PluginStoreV2(),
    policyStore: new CapabilityPolicyStore(),
    trustStore: new CapabilityTrustStore(),
  }) as unknown as PluginMutationApi
}

function registryController(options: PluginCommandOptions): MarketplaceRegistryApi {
  if (options.registry) return options.registry()
  return createPluginRegistrySource() as unknown as MarketplaceRegistryApi
}

/** `--flag value`, or `--flag=value`. Absent returns undefined. */
function flagValue(argv: readonly string[], name: string): string | undefined {
  const inline = argv.find(arg => arg.startsWith(`--${name}=`))
  if (inline) return inline.slice(name.length + 3)
  const at = argv.indexOf(`--${name}`)
  if (at === -1) return undefined
  const next = argv[at + 1]
  return next && !next.startsWith('-') ? next : undefined
}

/** Every `--config key=value`, in order. The page: "Repeat the flag to set multiple options". */
function configPairs(argv: readonly string[]): { values: Record<string, string>; malformed: string[] } {
  const values: Record<string, string> = {}
  const malformed: string[] = []
  argv.forEach((arg, index) => {
    const raw = arg.startsWith('--config=')
      ? arg.slice('--config='.length)
      : arg === '--config'
        ? argv[index + 1]
        : undefined
    if (raw === undefined) return
    const at = raw.indexOf('=')
    if (at <= 0) {
      malformed.push(raw)
      return
    }
    values[raw.slice(0, at)] = raw.slice(at + 1)
  })
  return { values, malformed }
}

/** The first argument that is not a flag and not a flag's value. */
function positional(argv: readonly string[], valueFlags: readonly string[]): string | undefined {
  const consumed = new Set<number>()
  argv.forEach((arg, index) => {
    if (arg.startsWith('--') && !arg.includes('=') && valueFlags.includes(arg.slice(2))) {
      consumed.add(index + 1)
    }
  })
  return argv.find((arg, index) => !arg.startsWith('-') && !consumed.has(index))
}

/**
 * `plugins-reference.md` § *plugin install*: "`<plugin>`: Plugin name or
 * `plugin-name@marketplace-name` for a specific marketplace".
 *
 * The pre-install refresh is the page's own ordering
 * (`plugins/install.md#install-a-plugin`, quoted at `refreshForInstall`'s
 * docstring): refresh that marketplace, then look the name up. A refresh failure
 * is not an error — the same paragraph says the cached catalog is used anyway —
 * so it is awaited and its outcome ignored.
 */
async function resolveCatalogItem(
  registry: MarketplaceRegistryApi,
  wanted: string,
): Promise<{ item: Awaited<ReturnType<MarketplaceRegistryApi['peekCachedItems']>>[number] } | { error: string }> {
  const at = wanted.lastIndexOf('@')
  const name = at > 0 ? wanted.slice(0, at) : wanted
  const marketplaceId = at > 0 ? wanted.slice(at + 1) : undefined

  if (marketplaceId) {
    try {
      await registry.refreshForInstall({ marketplaceId })
    } catch {
      // Offline, or a marketplace this registry does not know: the lookup below
      // reports the real problem in the user's own vocabulary.
    }
  }

  const items = await registry.peekCachedItems()
  const matches = items.filter(item =>
    (item.name === name || item.id === name || item.id === wanted)
    && (marketplaceId === undefined
      || item.marketplaceRegistryId === marketplaceId
      || item.marketplaceRegistryLabel === marketplaceId))
  if (matches.length === 0) {
    return {
      error: `No plugin named "${wanted}" in any registered marketplace's catalog.\n`
        + 'Run `nessy-general-agent plugin marketplace list` to see what is registered, '
        + 'or `plugin marketplace add <source>` first.',
    }
  }
  if (matches.length > 1 && marketplaceId === undefined) {
    // The page's own disambiguation rule, applied to install as well as
    // uninstall: name the qualified form rather than picking one.
    const where = matches
      .map(item => `${item.name}@${item.marketplaceRegistryId ?? 'unknown'}`)
      .sort()
      .join(', ')
    return { error: `"${name}" is offered by more than one marketplace. Name one: ${where}` }
  }
  return { item: matches[0]! }
}

async function runInstall(
  argv: readonly string[],
  options: PluginCommandOptions,
): Promise<PluginCommandResult> {
  const wanted = positional(argv, ['config', 'workspace'])
  if (!wanted) {
    return { text: `plugin install needs a plugin name.\n\n${USAGE}`, exitCode: 1 }
  }
  const { values: config, malformed } = configPairs(argv)
  if (malformed.length > 0) {
    return {
      text: `--config takes key=value; could not read: ${malformed.join(', ')}`,
      exitCode: 1,
    }
  }
  const workspaceId = flagValue(argv, 'workspace')
  if (Object.keys(config).length > 0 && !workspaceId) {
    return {
      text: 'A plugin\'s userConfig values are stored per workspace, and this CLI carries no '
        + 'workspace context, so --config needs --workspace <id>.',
      exitCode: 1,
    }
  }

  const registry = registryController(options)
  const resolved = await resolveCatalogItem(registry, wanted)
  if ('error' in resolved) return { text: resolved.error, exitCode: 1 }

  const built = createPluginInstallSourceFromMarketplaceItem(resolved.item as never)
  if (!built.ok || !built.source) {
    const why = built.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join('; ')
    return { text: `Cannot install "${wanted}": ${why || 'unsupported install source'}`, exitCode: 1 }
  }

  const service = managementService(options)
  let result: unknown
  try {
    result = await service.install(built.source)
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }

  const installedKey = installedPluginKey(result)
  const configured: string[] = []
  const configErrors: string[] = []
  if (Object.keys(config).length > 0) {
    if (!installedKey) {
      configErrors.push('the install reported no plugin key, so --config was not applied')
    } else {
      try {
        await service.configure(installedKey, workspaceId!, config)
        configured.push(...Object.keys(config).sort())
      } catch (error) {
        configErrors.push(error instanceof Error ? error.message : String(error))
      }
    }
  }

  if (options.json) {
    return {
      text: JSON.stringify({ plugin: wanted, pluginKey: installedKey, configured, errors: configErrors, result }, null, 2),
      exitCode: configErrors.length > 0 ? 1 : 0,
    }
  }
  const lines = [`Installed: ${resolved.item.name}${
    resolved.item.marketplaceRegistryId ? `@${resolved.item.marketplaceRegistryId}` : ''}`]
  if (configured.length > 0) lines.push(`  Configured: ${configured.join(', ')}`)
  for (const error of configErrors) lines.push(`  --config failed: ${error}`)
  return { text: lines.join('\n'), exitCode: configErrors.length > 0 ? 1 : 0 }
}

/** The `pluginKey` an install result reports, whatever shape it came back in. */
function installedPluginKey(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const direct = (result as { pluginKey?: unknown }).pluginKey
  if (typeof direct === 'string') return direct
  const installed = (result as { installed?: unknown }).installed
  if (installed && typeof installed === 'object') {
    const key = (installed as { pluginKey?: unknown }).pluginKey
    if (typeof key === 'string') return key
  }
  return undefined
}

async function runUninstall(
  argv: readonly string[],
  options: PluginCommandOptions,
): Promise<PluginCommandResult> {
  const wanted = positional(argv, [])
  if (!wanted) {
    return { text: `plugin uninstall needs a plugin name.\n\n${USAGE}`, exitCode: 1 }
  }
  const rows = await (options.collect ?? collectInventory)()
  const row = findInstalled(rows, wanted)
  if (!row) return { text: `No installed plugin named: ${wanted}`, exitCode: 1 }

  const keepData = argv.includes('--keep-data')
  const service = managementService(options)
  try {
    await service.uninstall(row.pluginKey, keepData ? { keepData: true } : {})
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }

  // § *plugin uninstall*, the `--prune` row: "Also remove auto-installed
  // dependencies that no other plugin requires." Run AFTER the uninstall, so
  // the dependency that just became orphaned is one of the candidates.
  let pruned: unknown
  if (argv.includes('--prune')) {
    try {
      pruned = await service.pruneDependencies({})
    } catch (error) {
      return {
        text: `Uninstalled ${row.name}, but --prune failed: ${
          error instanceof Error ? error.message : String(error)}`,
        exitCode: 1,
      }
    }
  }

  if (options.json) {
    return {
      text: JSON.stringify({ pluginKey: row.pluginKey, name: row.name, keepData, pruned }, null, 2),
      exitCode: 0,
    }
  }
  const lines = [`Uninstalled: ${row.name}${keepData ? ' (data directory preserved)' : ''}`]
  if (pruned !== undefined) lines.push('  Pruned orphaned auto-installed dependencies.')
  return { text: lines.join('\n'), exitCode: 0 }
}

async function runUpdate(
  argv: readonly string[],
  options: PluginCommandOptions,
): Promise<PluginCommandResult> {
  const wanted = positional(argv, [])
  if (!wanted) {
    return { text: `plugin update needs a plugin name.\n\n${USAGE}`, exitCode: 1 }
  }
  const rows = await (options.collect ?? collectInventory)()
  const row = findInstalled(rows, wanted)
  if (!row) return { text: `No installed plugin named: ${wanted}`, exitCode: 1 }

  const service = managementService(options)
  let result: unknown
  try {
    result = await service.update(row.pluginKey)
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }
  if (options.json) {
    return { text: JSON.stringify({ pluginKey: row.pluginKey, name: row.name, result }, null, 2), exitCode: 0 }
  }
  return { text: `Updated: ${row.name}`, exitCode: 0 }
}

async function runPrune(
  argv: readonly string[],
  options: PluginCommandOptions,
): Promise<PluginCommandResult> {
  const dryRun = argv.includes('--dry-run')
  const service = managementService(options)
  let result: unknown
  try {
    result = await service.pruneDependencies(dryRun ? { dryRun: true } : {})
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }
  if (options.json) return { text: JSON.stringify({ dryRun, result }, null, 2), exitCode: 0 }
  const removed = Array.isArray((result as { removed?: unknown } | undefined)?.removed)
    ? (result as { removed: unknown[] }).removed
    : []
  if (removed.length === 0) {
    return { text: 'Nothing to prune: no auto-installed dependency is orphaned.', exitCode: 0 }
  }
  const names = removed
    .map(entry => (entry && typeof entry === 'object' && typeof (entry as { pluginKey?: unknown }).pluginKey === 'string'
      ? (entry as { pluginKey: string }).pluginKey
      : String(entry)))
    .sort()
  return {
    text: `${dryRun ? 'Would prune' : 'Pruned'} ${names.length}: ${names.join(', ')}`,
    exitCode: 0,
  }
}

const MARKETPLACE_USAGE = `Usage: nessy-general-agent plugin marketplace <verb>

  add <source> [--ref <r>] [--sparse <a,b>] [--name <n>]
  list
  remove <id>        Alias: rm
  update [id]        Every registered marketplace when the id is omitted.`

async function runMarketplace(
  argv: readonly string[],
  options: PluginCommandOptions,
): Promise<PluginCommandResult> {
  const verb = argv[0]
  const rest = argv.slice(1)
  const registry = registryController(options)
  try {
    switch (verb) {
      case 'add': {
        const source = positional(rest, ['ref', 'sparse', 'name'])
        if (!source) return { text: `plugin marketplace add needs a source.\n\n${MARKETPLACE_USAGE}`, exitCode: 1 }
        const refName = flagValue(rest, 'ref')
        const sparse = flagValue(rest, 'sparse')
        const displayName = flagValue(rest, 'name')
        const added = await registry.add({
          source,
          ...(refName ? { refName } : {}),
          ...(sparse ? { sparsePaths: sparse.split(',').map(part => part.trim()).filter(Boolean) } : {}),
          ...(displayName ? { displayName } : {}),
        })
        if (options.json) return { text: JSON.stringify(added, null, 2), exitCode: 0 }
        return { text: `Added marketplace: ${added.displayName ?? added.marketplaceId} (${added.marketplaceId})`, exitCode: 0 }
      }
      case 'list':
      case 'ls': {
        const summary = await registry.list()
        if (options.json) return { text: JSON.stringify(summary, null, 2), exitCode: 0 }
        if (summary.registries.length === 0) return { text: 'No marketplaces registered.', exitCode: 0 }
        const lines = [`${'id'.padEnd(28)}${'name'.padEnd(28)}${'ref'.padEnd(16)}auto-update`]
        for (const row of summary.registries) {
          lines.push(
            row.marketplaceId.padEnd(28)
            + row.displayName.padEnd(28)
            + (row.refName ?? '-').padEnd(16)
            // The managed marker matters: an operator who sees `on` and cannot
            // change it should be told which layer decided.
            + (row.autoUpdate ? 'on' : 'off') + (row.autoUpdateManaged ? ' (managed)' : ''),
          )
        }
        return { text: lines.join('\n'), exitCode: 0 }
      }
      case 'remove':
      case 'rm': {
        const marketplaceId = positional(rest, [])
        if (!marketplaceId) return { text: `plugin marketplace remove needs an id.\n\n${MARKETPLACE_USAGE}`, exitCode: 1 }
        const removed = await registry.remove({ marketplaceId })
        if (options.json) return { text: JSON.stringify(removed, null, 2), exitCode: 0 }
        return { text: `Removed marketplace: ${marketplaceId}`, exitCode: 0 }
      }
      case 'update': {
        // "Updates all marketplaces if omitted" — `plugin-marketplaces.md`
        // § *Plugin marketplace update*.
        const marketplaceId = positional(rest, [])
        const targets = marketplaceId
          ? [marketplaceId]
          : (await registry.list()).registries.map(row => row.marketplaceId)
        if (targets.length === 0) return { text: 'No marketplaces registered.', exitCode: 0 }
        const outcomes: Array<{ marketplaceId: string; upgraded: boolean; reason?: string }> = []
        for (const target of targets) {
          const outcome = await registry.upgrade({ marketplaceId: target })
          outcomes.push({ marketplaceId: target, upgraded: outcome.upgraded, ...(outcome.reason ? { reason: outcome.reason } : {}) })
        }
        if (options.json) return { text: JSON.stringify({ outcomes }, null, 2), exitCode: 0 }
        return {
          text: outcomes
            .map(outcome => `${outcome.marketplaceId}: ${outcome.upgraded ? 'updated' : `unchanged${outcome.reason ? ` (${outcome.reason})` : ''}`}`)
            .join('\n'),
          exitCode: 0,
        }
      }
      case undefined:
        return { text: MARKETPLACE_USAGE, exitCode: 1 }
      case 'help':
      case '--help':
      case '-h':
        return { text: MARKETPLACE_USAGE, exitCode: 0 }
      default:
        return { text: `Unknown marketplace verb: ${verb}\n\n${MARKETPLACE_USAGE}`, exitCode: 1 }
    }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), exitCode: 1 }
  }
}

/** One installed row by pluginKey, pluginId or display name — `details`' rule. */
function findInstalled(
  rows: readonly PluginInventoryRow[],
  wanted: string,
): PluginInventoryRow | undefined {
  return rows.find(candidate => (
    candidate.pluginKey === wanted || candidate.pluginId === wanted || candidate.name === wanted
  ))
}

// ---------------------------------------------------------------------------
// Production inventory
// ---------------------------------------------------------------------------

/**
 * Read the installed inventory through the EXISTING status API rather than a
 * second reader: `PluginManagementServiceV2.status()` owns the summary shape the
 * desktop inventory page already renders, and `CapabilityPolicyStore` owns
 * activation. The registry read supplies the per-capability rows `status()` folds
 * down to kinds. All three are pure reads; none of them writes, and constructing
 * the stores only resolves paths.
 */
async function collectInventory(): Promise<PluginInventoryRow[]> {
  const store = new PluginStoreV2()
  const policyStore = new CapabilityPolicyStore()
  const service = new PluginManagementServiceV2({
    store,
    policyStore,
    trustStore: new CapabilityTrustStore(),
  })
  const status = await service.status()
  const registry = await store.readInstalledRegistry()
  // `plugins/host-marketplace.md#depend-on-and-recommend-other-plugins` — a plugin with an unresolved dependency is
  // disabled until the error is resolved, and `:217` puts the list in
  // `plugin list --json`. The CLI carries no workspace or project context, so
  // "enabled" here is the global layer only, matching the `enabled` column.
  const dependencySubjects = Object.entries(registry.active)
    .map(([pluginKey, instanceId]) => registry.plugins.find(
      candidate => candidate.pluginKey === pluginKey && candidate.pluginInstanceId === instanceId,
    ))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  const dependencyErrors = resolvePluginDependencyErrors(
    dependencySubjects,
    subject => policyStore.resolveScopes({ pluginKey: subject.pluginKey }).global !== 'disabled',
  )

  return status.installed.map(summary => {
    const entry = registry.plugins.find(
      candidate => candidate.pluginInstanceId === summary.activeInstanceId,
    )
    return {
      pluginKey: summary.pluginKey,
      pluginId: summary.pluginId,
      name: summary.name,
      version: summary.version,
      marketplaceId: summary.marketplaceId,
      ...(summary.description ? { description: summary.description } : {}),
      enabled: policyStore.resolveScopes({ pluginKey: summary.pluginKey }).global,
      components: (entry?.manifest.capabilities ?? []).map(capability => ({
        capabilityId: capability.id,
        kind: capability.kind,
        name: capability.displayName ?? capability.id,
        ...(capability.description ? { description: capability.description } : {}),
      })),
      diagnostics: summary.diagnostics.map(diagnostic => ({
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
      })),
      ...((dependencyErrors.get(summary.pluginKey)?.length ?? 0) > 0
        ? {
            errors: dependencyErrors.get(summary.pluginKey)!.map(error => ({
              code: error.code,
              dependency: error.dependency,
              message: describePluginDependencyError(error),
            })),
          }
        : {}),
    }
  })
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((cell, column) => Math.max(
    cell.length,
    ...rows.map(row => (row[column] ?? '').length),
  ))
  const line = (cells: readonly string[]) => cells
    .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
    .join('  ')
    .trimEnd()
  return [line(header), ...rows.map(line)].join('\n')
}
