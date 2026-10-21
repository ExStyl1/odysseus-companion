/**
 * Claude `.claude-plugin/plugin.json` bundle adapter (A5).
 *
 * Replaces the detection-only stub (`createClaudeCompatibilityDetectionAdapter`
 * in `format-adapters.ts`, formerly id `claude-compat-detected`), which only
 * detected `.claude/settings.json`/`.claude/hooks.json` (Claude Code's *app*
 * config, never a plugin bundle layout) and always failed normalization with
 * `plugin.format.unsupported_external_format`. This adapter (id
 * `claude-plugin-json`) performs real normalization of the documented Claude
 * plugin bundle surface into Nessy IR:
 *  - skills (`skills/<slug>/SKILL.md`)
 *  - prompt commands (`commands/*.md`, frontmatter + literal `$ARGUMENTS`)
 *  - agents (`agents/*.md`, frontmatter)
 *  - MCP servers (`.mcp.json`'s `mcpServers` map; stdio/http/sse)
 *  - command hooks (`hooks/hooks.json`, `type: "command"` entries only)
 *
 * The `.claude-plugin/plugin.json` manifest itself is OPTIONAL: a bundle with
 * no manifest but unambiguous Claude default-layout directories (manifestless
 * discovery) still normalizes — see `detectClaudePluginBundle`.
 *
 * Every peripheral Claude surface this runtime does not execute (output
 * styles, non-command hook types, themes, monitors, `${user_config.*}`
 * substitution, dependencies, channels) is IMPORTED into the compatibility
 * report as a `deferred` record (externalKind + reasonCode) — never silently
 * dropped, and never given a runtime here (A2 `PluginCompatibilityReport`).
 *
 * Capability ids use the shared A2 `createPluginCapabilityId(kind,
 * providerLocalId)` helper (schema.ts) — now `.`-joined and validator-legal
 * (see the A5 PREREQ FIX in schema.ts) — so a same-named skill/mcp/hook/agent
 * never collide on `NessyPluginManifest.capabilities` id uniqueness. The
 * provider-facing logical name stays bare on the nested descriptor
 * (`skill.slug` / `mcp.serverName` / `hook.id` / `agent.name` /
 * `promptCommand.name`), unaffected by the id namespacing.
 *
 * Token rewriting: Claude's documented `${CLAUDE_PLUGIN_ROOT}`/
 * `${CLAUDE_PLUGIN_DATA}`/`${CLAUDE_PROJECT_DIR}` variables (and their bare
 * `$CLAUDE_*` form) are rewritten to the canonical Nessy aliases
 * (`NESSY_PLUGIN_ROOT`/`NESSY_PLUGIN_DATA`/`NESSY_PROJECT_DIR`) inside parsed
 * command/args/cwd/env values only — the same normalization-time rewriting
 * convention `format-adapters/codex.ts` established for
 * `${CLAUDE_PLUGIN_ROOT}` (Codex's own docs reuse that Claude-shaped token).
 * This never touches arbitrary shell text outside those parsed fields.
 *
 * Path discovery scope (B1a): every manifest component-path field goes through
 * the one shared resolver in `manifest-paths.ts`, which enforces containment
 * BEFORE any `join()` — a plugin manifest is untrusted input, and resolving a
 * declared path is what turns it from an inert string into a real filesystem
 * read primitive.
 *
 * `commands`, `agents` and `workflows` follow `plugins/manifest-reference.md#how-each-key-combines-with-its-default-location`'s
 * REPLACES rule: when the key is present the default folder is not scanned and
 * the declared paths are, each of which may name a directory or a single
 * component file. To keep the default and add more, the manifest lists it
 * explicitly (`"commands": ["./commands/", "./extras/"]`).
 *
 * `skills` follows `:637`'s EXTENDS rule instead: the default `skills/` scan is
 * unconditional and declared paths load alongside it, deduplicated on slug. A
 * declared path pointing at a directory that holds `SKILL.md` directly is
 * `:647`; the automatic root-`SKILL.md` layout with NO manifest field is `:649`.
 * They are different cases and are kept apart in the code.
 *
 * `hooks` and `mcpServers` are two of `:638`'s three "own merge rules" fields
 * and they follow the same rule the LSP reader already implements: a declared
 * path is read, a documented inline object is taken as configuration, and the
 * plugin-root default file still loads alongside both. Each component section
 * names one location pair — "Location: `hooks/hooks.json` in plugin root, or
 * inline in plugin.json" and "Location: `.mcp.json` in plugin root, or inline in
 * plugin.json" — and the manifest's own complete-schema example declares
 * `"hooks": "./config/hooks.json"` and `"mcpServers": "./mcp-config.json"`, so
 * all three shapes describe one surface. Reading only the default file gave a
 * bundle declaring either of the other two ZERO capabilities.
 * `outputStyles` and `experimental.monitors`
 * are named in the same REPLACES sentence and both now resolve into
 * capabilities; `experimental.themes` has no component surface here at all and is
 * REFUSED with a diagnostic below — not silently deferred — because a plugin
 * theme's token vocabulary is a terminal palette with no defined mapping onto
 * Nessy's web theme tokens, and an author is better told at install than left
 * shipping a component that does nothing.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  createPluginCapabilityId,
  isRecord,
  normalizeNessyPluginManifest,
  normalizePluginDependencies,
  pluginDiagnostic,
  readHookArgsVector,
  validatePluginId,
  validatePluginLspWorkspaceFolder,
  validatePluginMcpCwd,
} from '../schema.ts';
import type {
  NessyPluginManifest,
  PluginBundleNormalizationOptions,
  PluginCapability,
  PluginCapabilityKind,
  PluginCompatibilityReport,
  PluginConnectorDescriptor,
  PluginDefaultSettingsDescriptor,
  PluginDependencyDescriptor,
  PluginDiagnostic,
  PluginLspSupervision,
  PluginMarketplaceEntryDefinition,
  PluginNormalizationResult,
  PluginOrigin,
  PluginRuntimeCompatibilityProfile,
  PluginUserConfigurationDescriptor,
} from '../types.ts';
import { UNDECLARED_PLUGIN_VERSION, isCommandMonitorDescriptor } from '../types.ts';
import { mapExternalHookEventName } from '../format-adapters.ts';
import { mcpToolTimeoutMs, normalizeMcpTransportAlias } from '../../mcp/server-config-values.ts';
import { parseWorkflowRecipe } from '../../workflows/workflow-loader.ts';
import { outputStyleNameSlug, readOutputStyleFrontmatter } from '../../prompts/output-styles.ts';
import type { PluginHookEventName } from '../hook-events.ts';
import { RUNTIME_SKILL_CONTEXT_INLINE_PATTERN } from '../../capabilities/runtime-skill-context.ts';
import { capMcpNameSegment, pluginMcpWireName } from '../../capabilities/mcp-wire-name.ts';
import {
  deferUnavailablePluginSurfaces,
  isStringRecord,
  readExternalHookTimeoutMs,
  readRequiredUniqueStringArray,
  readStringArray,
  requireImportedRuntimeTrust,
  splitMarkdownFrontmatter,
  splitToolGrantList,
  stringField,
  type UnknownRecord,
} from './shared.ts';
import {
  hasMaterializablePluginPackageRunner,
  qualifyPluginStdioCommand,
} from '../stdio-command.ts';
import {
  expandManifestComponentDirectory,
  isManifestDirectory,
  isManifestFile,
  manifestPathContainmentError,
  manifestPathEscapesBundle,
  manifestPathIsWithinDefault,
  resolveManifestComponentPaths,
  resolveManifestRelativePath,
  scanManifestSkillDirectory,
  type ManifestComponentPath,
  type ManifestComponentPathResolution,
  type ManifestSkillScan,
} from './manifest-paths.ts';

/** Adapter identity constants; kept in sync with the detector in format-adapters.ts. */
export const CLAUDE_ADAPTER_ID = 'claude-plugin-json';
// '2': headersHelper is carried on remote MCP descriptors (was warn+defer), so
// `migrateOutdatedPluginAdaptersOnStartup` re-normalizes already-installed
// Claude plugins and their persisted manifests pick the field up.
export const CLAUDE_ADAPTER_VERSION = '2';
export const CLAUDE_MANIFEST_RELATIVE_PATH = '.claude-plugin/plugin.json';

/**
 * hooks.md: "SessionStart and Setup support command and mcp_tool hooks. They
 * don't support http, prompt, or agent hooks." Claude never runs the other
 * three types on these events, so they import as report entries only.
 *
 * Only `SessionStart` is listed: `Setup` never reaches this check, because
 * `mapExternalHookEventName` already routes it to a deferral (R73 · f001 —
 * Nessy has no `--init-only` launch mode). Its type restriction is therefore
 * moot here, and adding the name back would give a reader the impression the
 * event imports.
 */
const CLAUDE_RESTRICTED_LIFECYCLE_EVENTS = new Set<PluginHookEventName>(['SessionStart']);

const CLAUDE_DEFAULT_SKILLS_DIR = 'skills';
const CLAUDE_DEFAULT_COMMANDS_DIR = 'commands';
const CLAUDE_DEFAULT_AGENTS_DIR = 'agents';
const CLAUDE_DEFAULT_WORKFLOWS_DIR = 'workflows';
/** `plugins/manifest-reference.md#standard-layout` — the documented default location for output styles. */
const CLAUDE_DEFAULT_OUTPUT_STYLES_DIR = 'output-styles';
const CLAUDE_DEFAULT_HOOKS_FILE = 'hooks/hooks.json';
const CLAUDE_DEFAULT_MCP_FILE = '.mcp.json';
const CLAUDE_DEFAULT_LSP_FILE = '.lsp.json';
/** `plugins/manifest-reference.md#standard-layout` — the documented default monitors location. */
const CLAUDE_DEFAULT_MONITORS_FILE = 'monitors/monitors.json';
/**
 * The folder half of {@link CLAUDE_DEFAULT_MONITORS_FILE}, for the ignored-default
 * warning only — `plugins/manifest-reference.md#path-rules` states its exception
 * in terms of the FOLDER ("Claude Code doesn't warn when the manifest key points
 * into the default folder"), and `monitors` is the only default in this adapter
 * whose documented location is a file inside one. See P2.147 at
 * `normalizeClaudeMonitors`.
 */
const CLAUDE_DEFAULT_MONITORS_DIR = 'monitors';

/**
 * Detects a Claude plugin bundle. `.claude-plugin/plugin.json` is
 * authoritative. Without it (manifestless), detection requires at least one
 * unambiguous Claude default-layout marker (`skills/`, `commands/`, `agents/`,
 * `hooks/hooks.json`, or `.mcp.json`) — a bare directory with none of these is
 * never auto-claimed as Claude. This mirrors A3's repository-install
 * candidate surfacing: detection only reports plausibility, it never resolves
 * a genuinely ambiguous bundle on its own.
 */
export function detectClaudePluginBundle(
  rootDirectory: string,
  marketplaceEntry?: PluginMarketplaceEntryDefinition,
): boolean {
  if (existsSync(join(rootDirectory, CLAUDE_MANIFEST_RELATIVE_PATH))) return true;
  // `plugins/marketplace-reference.md#strict-mode` — with `strict: false` "the plugin doesn't need
  // its own `plugin.json`. The marketplace entry defines everything." Such a
  // bundle is raw files with no Claude marker at all, so layout detection alone
  // refuses it and the install fails as an unsupported format. The entry IS the
  // marker in that case.
  if (marketplaceEntryDeclaresClaudeComponents(marketplaceEntry)) return true;
  return hasClaudeDefaultLayoutMarkers(rootDirectory);
}

/**
 * The entry-level fields that mark a bundle as Claude when it has no layout marker.
 *
 * **The page's SIX, plus `workflows`, `mcpServers` and `lspServers`. Re-read
 * 2026-09-28 (F1.1032).** `plugins/marketplace-reference.md` § "How an entry
 * combines with plugin.json" (`#entry-and-plugin-json`): "Strict mode decides
 * whether the entry's six component fields, `commands`, `agents`, `skills`,
 * `hooks`, `outputStyles`, and `themes`, are combined with it or rejected as a
 * conflict." `outputStyles` and `themes` joined this list then; before, an entry
 * declaring only output styles over a bundle with no layout marker was refused.
 * The catalog parser carries both since the same change, so the widening is live.
 *
 * `mcpServers` and `lspServers` stay although the same section says "Entry `mcpServers`, `lspServers`,
 * `userConfig`, and `channels` don't apply" over a `plugin.json`: as a DETECTION marker this list is
 * read only when there is NO `plugin.json` ({@link detectClaudePluginBundle} returns first on one), where the other
 * bullet governs — "**No `plugin.json`**: the entry is the manifest regardless of
 * `strict`. Every manifest field in the entry applies, including `mcpServers`,
 * `lspServers`, `userConfig`, and `channels`". Which entry fields apply over a
 * `plugin.json` is decided at load by {@link claudeEntryFieldsThatApply}; over one, since F1.1034, the strict-conflict
 * check {@link claudeEntryDeclaresConflictingComponents} reads this list minus `workflows`, `mcpServers`, `lspServers`.
 *
 * `workflows` is the deliberate superset (P2.181, 2026-08-25, kept): the manifest
 * reference documents it as a component path, an entry "accepts every
 * `plugin.json` field", and yet the entry section does not count it among the
 * six. It can only make us ACCEPT an entry, never reject one, and it is honest
 * all the way through: `CLAUDE_CUSTOM_PATH_FIELDS` reads `entryFields.workflows`
 * in `resolveClaudeManifestPaths`, so a declaring entry is detected here, has its
 * paths resolved, and reaches `normalizeClaudeWorkflows` as real capabilities.
 * Deleting it would silently drop every such entry's workflows — the silent-drop
 * family this adapter has already shipped four times.
 *
 * This is the DETECTION marker set, not the set of entry fields the adapter
 * consumes: `normalizeClaudeDependencies` reads `entryFields.dependencies`, which
 * is not a component and stays out. An entry field reaches `fields` at all only
 * if `MARKETPLACE_ENTRY_CARRIED_FIELDS` (`marketplace/external-catalog-adapters.ts`)
 * carries it, so a name added here and not there is inert for a real catalog;
 * `MARKETPLACE_ENTRY_COMPONENT_FIELDS` (`plugins/format-adapters.ts`) holds the
 * same names for the other-adapter warning. Change the three together — and do
 * not "tidy" `workflows` out of any of them.
 */
const CLAUDE_ENTRY_COMPONENT_FIELDS = [
  'skills', 'commands', 'agents', 'workflows', 'hooks', 'outputStyles', 'themes', 'mcpServers', 'lspServers',
] as const;

function marketplaceEntryDeclaresClaudeComponents(
  entry: PluginMarketplaceEntryDefinition | undefined,
): boolean {
  // `fields` is persisted with the installed record, so a record written by an
  // older build can reach here without it.
  if (!entry || !isRecord(entry.fields)) return false;
  return CLAUDE_ENTRY_COMPONENT_FIELDS.some(field => entry.fields[field] !== undefined);
}

function hasClaudeDefaultLayoutMarkers(rootDirectory: string): boolean {
  return existsSync(join(rootDirectory, CLAUDE_DEFAULT_SKILLS_DIR))
    || existsSync(join(rootDirectory, CLAUDE_DEFAULT_COMMANDS_DIR))
    || existsSync(join(rootDirectory, CLAUDE_DEFAULT_AGENTS_DIR))
    || existsSync(join(rootDirectory, CLAUDE_DEFAULT_HOOKS_FILE))
    || existsSync(join(rootDirectory, CLAUDE_DEFAULT_MCP_FILE));
}

export async function normalizeClaudePluginBundle(
  rootDirectory: string,
  origin: PluginOrigin,
  options: PluginBundleNormalizationOptions = {},
): Promise<PluginNormalizationResult> {
  const marketplaceEntry = options.marketplaceEntry;
  const entryFields: UnknownRecord = isRecord(marketplaceEntry?.fields) ? marketplaceEntry.fields : {};
  const manifestPath = join(rootDirectory, CLAUDE_MANIFEST_RELATIVE_PATH);
  const manifestless = !existsSync(manifestPath);
  let input: UnknownRecord = {};
  if (!manifestless) {
    try {
      const raw = JSON.parse(await readFile(manifestPath, 'utf-8'));
      if (!isRecord(raw)) {
        return {
          ok: false,
          diagnostics: [pluginDiagnostic('error', 'plugin.format.claude_manifest_not_object', 'Claude plugin manifest must be an object.')],
        };
      }
      input = raw;
    } catch (error) {
      return {
        ok: false,
        diagnostics: [pluginDiagnostic(
          'error',
          'plugin.format.manifest_unreadable',
          `Claude plugin manifest could not be read: ${error instanceof Error ? error.message : String(error)}`,
          CLAUDE_MANIFEST_RELATIVE_PATH,
        )],
      };
    }
  }

  // F1.1034 — `plugins/marketplace-reference.md#strict-mode`: "With `strict: false`, an entry that declares
  // any component field is a conflict" (the ENTRY's six, over a `plugin.json`); with none it is "as with `true`".
  // F1.1059 — with no `plugin.json` "the entry is the manifest regardless of `strict`", so past here it is moot.
  const strict = marketplaceEntry?.strict !== false;
  const manifestIsAuthority = !manifestless;
  if (!strict && !manifestless && claudeEntryDeclaresConflictingComponents(entryFields)) {
    const pluginName = stringField(input, 'name') ?? basename(rootDirectory);
    return {
      ok: false,
      diagnostics: [pluginDiagnostic(
        'error',
        'plugin.format.claude_conflicting_manifests',
        // The Strict mode table of `plugins/marketplace-reference.md` gives the error verbatim.
        `Plugin ${pluginName} has conflicting manifests: both plugin.json and marketplace entry specify components.`,
        CLAUDE_MANIFEST_RELATIVE_PATH,
        { pluginName },
      )],
    };
  }

  const diagnostics: PluginDiagnostic[] = [];
  const deferred: PluginCompatibilityReport['deferred'] = [];
  // Manifest-level retained surfaces are recorded before the file-backed passes, so
  // their deferred order matches the manifest's (A1 fixture-exact for claude-deferred).
  // An entry's `themes` count too, and without a plugin.json its `userConfig`/`channels`.
  const appliedEntryFields = claudeEntryFieldsThatApply(entryFields, manifestless, diagnostics, deferred);
  addClaudeRetainedSurfaceDeferrals(rootDirectory, claudeRetainedSurfaceInput(appliedEntryFields, input), deferred, diagnostics);
  // Every component-path field is resolved ONCE, before any component read, so the containment gate runs
  // once per declared entry. Entry hooks that replace per event (F1.1035) are read by the hooks reader only.
  const entryHooks = claudeEntryHooksThatReplacePerEvent(appliedEntryFields, manifestless);
  const declaredPaths = await resolveClaudeManifestPaths(rootDirectory, input, entryHooks ? { ...appliedEntryFields, hooks: undefined } : appliedEntryFields, manifestIsAuthority, diagnostics);
  // `plugins/manifest-reference.md#how-each-key-combines-with-its-default-location`'s exception to the `skills` EXTENDS rule: "for a
  // marketplace entry whose `source` resolves to the marketplace root, declaring
  // specific subdirectories replaces the default `skills/` scan".
  //
  // `plugins/marketplace-reference.md#relative-path-plugin-source` supplies the two carve-outs: "Listing
  // `./skills/` itself, or the plugin root, keeps the full scan" — checked here
  // over the whole declared set, since either declaration names the folder
  // explicitly — and "If none of the listed paths exist, the default scan runs
  // instead", which needs the scan results and is checked inside the scanner.
  const skillsReplaceDefaultScan = marketplaceEntry?.sourceIsMarketplaceRoot === true
    && entryFields.skills !== undefined
    && declaredPaths.skills.paths.length > 0
    && !declaredPaths.skills.paths.some(entry =>
      entry.path === CLAUDE_DEFAULT_SKILLS_DIR || entry.path === '');
  // Surfaces whose declared path this adapter still does not follow (`hooks`,
  // `mcpServers`, and any field whose entries were all refused) are never
  // silently ignored: they are recorded as deferred.
  addClaudeCustomPathDeferrals(declaredPaths, deferred);
  // A default folder the manifest overrides is not loaded — by Claude either —
  // so the author gets told which folder went unread (`:640`).
  addClaudeIgnoredDefaultFolderRecords(rootDirectory, declaredPaths, diagnostics, deferred);

  const bundleName = stringField(input, 'name') ?? basename(rootDirectory);
  const pluginLabel = claudePluginLabel(input, origin, rootDirectory);
  // `:540` — `monitors` is accepted at BOTH spellings; `experimental.*` is the documented migration target,
  // so it wins when a bundle carries both. With no plugin.json the entry is the manifest, so ITS monitors apply
  // (F1.1036); over one they do not ({@link claudeEntryFieldsThatApply}), so there is nothing to merge.
  const monitorsSource = manifestless ? appliedEntryFields : input;
  const experimentalSection = isRecord(monitorsSource.experimental) ? monitorsSource.experimental : undefined;
  const declaredMonitors = experimentalSection?.monitors ?? monitorsSource.monitors;
  const declaredDependencies = normalizeClaudeDependencies(input, entryFields, manifestIsAuthority, diagnostics, deferred);
  const mcpSurface = await normalizeClaudeMcpServers(rootDirectory, declaredPaths.mcp, diagnostics, deferred);
  // The manifest id (`id:` below); computed here because an `mcp_tool` hook naming this plugin's own server
  // needs the wire name the resolver will mint from it (UB12.94, {@link resolveClaudeMcpToolHookTarget}).
  const idBase = stringField(input, 'id') ?? stringField(input, 'pluginId') ?? stringField(input, 'name') ?? basename(rootDirectory);
  const entryName = stringField(entryFields, 'name');
  const mcpHookScope: ClaudeMcpToolHookScope = {
    pluginNames: new Set([bundleName, idBase, ...(entryName ? [entryName] : [])]),
    pluginId: idBase,
    serverNames: new Set(mcpSurface.capabilities.flatMap(capability => capability.kind === 'mcp' ? [capability.mcp.serverName] : [])),
  };
  const capabilities: PluginCapability[] = [
    ...await normalizeClaudeSkills(rootDirectory, declaredPaths.skills, diagnostics, {
      fallbackSlug: bundleName,
      replaceDefaultScan: skillsReplaceDefaultScan,
    }),
    ...await normalizeClaudePromptCommands(rootDirectory, declaredPaths.commands, diagnostics, deferred),
    ...await normalizeClaudeAgents(rootDirectory, declaredPaths.agents, diagnostics),
    ...await normalizeClaudeWorkflows(rootDirectory, declaredPaths.workflows, diagnostics, deferred),
    ...await normalizeClaudeOutputStyles(rootDirectory, declaredPaths.outputStyles, diagnostics, deferred),
    ...mcpSurface.capabilities,
    ...await normalizeClaudeHooks(rootDirectory, declaredPaths.hooks, diagnostics, deferred, pluginLabel, mcpHookScope, entryHooks),
    ...await normalizeClaudeMonitors(rootDirectory, declaredMonitors, diagnostics, deferred, pluginLabel),
    // `lspServers` is Claude's documented field; `lsp` is our own earlier
    // spelling and stays accepted. With neither present the plugin-root
    // `.lsp.json` default is read.
    ...await normalizeClaudeLspServers(
      rootDirectory,
      mergeClaudeComponentField(
        input.lspServers ?? input.lsp,
        appliedEntryFields.lspServers,
        'lspServers',
        diagnostics,
      ),
      diagnostics,
      deferred,
      input.lspServers === undefined && input.lsp !== undefined ? 'lsp' : 'lspServers',
    ),
  ];

  // Runs HERE, not with the manifest-level retained surfaces: whether a `bin/`
  // entry is an unrunnable command depends on what the capabilities above
  // already execute by path.
  addClaudeBinSurfaceDeferral(rootDirectory, capabilities, deferred, diagnostics);

  const userConfiguration = normalizeClaudeUserConfig(input.userConfig ?? appliedEntryFields.userConfig, diagnostics);
  // Runs HERE for the same reason `bin` does: `settings.json`'s `agent` names
  // one of the capabilities built above, so it cannot be checked before them.
  const defaultSettings = await normalizeClaudePluginDefaultSettings(
    rootDirectory,
    manifestless ? appliedEntryFields : input, // F1.1036: the entry is the manifest when there is none
    capabilities,
    diagnostics,
    deferred,
  );

  const author = isRecord(input.author) ? input.author : undefined;
  const entryAuthor = isRecord(entryFields.author) ? entryFields.author : undefined;
  // `plugins/marketplace-reference.md#entry-and-plugin-json` and `plugins/manifest-reference.md#marketplace-entries-and-the-manifest` — the entry's
  // `defaultEnabled` "Takes precedence over the same field in the plugin's
  // `plugin.json`". Carried truthfully here; consuming it in activation policy
  // is a separate change.
  const defaultEnabled = typeof entryFields.defaultEnabled === 'boolean'
    ? entryFields.defaultEnabled
    : typeof input.defaultEnabled === 'boolean' ? input.defaultEnabled : undefined;
  const nativeCandidate = {
    schemaVersion: 1,
    kind: 'plugin',
    id: idBase,
    name: stringField(entryFields, 'displayName')
      ?? stringField(input, 'displayName') ?? stringField(input, 'name') ?? idBase,
    // `plugins/manifest-reference.md#marketplace-entries-and-the-manifest` — "If also set in the marketplace entry,
    // `plugin.json` wins", restated at `plugins/marketplace-reference.md#entry-and-plugin-json` as "Claude
    // Code always uses the `plugin.json` value without warning". This is the ONE
    // field where the manifest outranks the entry.
    // `plugins-reference.md` § *Plugin manifest* requires only `name`, so a real
    // bundle may declare no version at all (`playwright`). Our schema requires
    // one and the instance identity embeds it, so absence becomes the named
    // placeholder — which user-facing surfaces omit rather than print (Q10-4).
    version: stringField(input, 'version') ?? stringField(entryFields, 'version') ?? UNDECLARED_PLUGIN_VERSION,
    ...(stringField(entryFields, 'description') ?? stringField(input, 'description') ? {
      description: stringField(entryFields, 'description') ?? stringField(input, 'description'),
    } : {}),
    ...(stringField(entryAuthor ?? {}, 'name') ?? stringField(input, 'publisher') ?? stringField(author ?? {}, 'name') ? {
      publisher: stringField(entryAuthor ?? {}, 'name')
        ?? stringField(input, 'publisher') ?? stringField(author ?? {}, 'name'),
    } : {}),
    ...(stringField(entryFields, 'homepage') ?? stringField(input, 'homepage') ?? stringField(input, 'homepageUrl') ? {
      homepageUrl: stringField(entryFields, 'homepage')
        ?? stringField(input, 'homepage') ?? stringField(input, 'homepageUrl'),
    } : {}),
    capabilities,
    // `plugins/manifest-reference.md#user-configuration` — `userConfig` is declared for the WHOLE
    // plugin, not for one server, so it rides `nessyExtensions` rather than an
    // MCP capability the way MCPB's `user_config` does. The values it describes
    // are collected and stored by the same path (`mcpb-configuration.ts`).
    //
    // `settings.json`'s supported keys ride the same section for the same
    // reason: they are asserted for the WHOLE plugin, not for one capability.
    ...(userConfiguration.length || defaultSettings ? {
      nessyExtensions: {
        ...(userConfiguration.length ? { userConfiguration } : {}),
        ...(defaultSettings ? { defaultSettings } : {}),
      },
    } : {}),
    // `plugins/manifest-reference.md#dependencies` (manifest) and `:96` (marketplace entry). Over a
    // `plugin.json` the two sources merge under either `strict` (F1.1034: with no
    // entry component field, `strict: false` is "as with `true`"). Without one
    // there is no manifest side, so the entry's list is the whole of it.
    //
    // `claudeEntryDeclaresConflictingComponents` deliberately does NOT count
    // `dependencies`: a dependency array is not one of the page's six component
    // fields, so a `strict: false` entry declaring one over a `plugin.json` is not
    // the conflict. Adding it there would refuse bundles Claude loads.
    ...(declaredDependencies !== undefined ? { dependencies: declaredDependencies } : {}),
    // Remote OAuth-declaring `.mcp.json` servers, promoted to connectors so
    // they gain the Source/OAuth path (see `normalizeClaudeMcpServers`).
    ...(mcpSurface.connectors.length > 0 ? { connectors: mcpSurface.connectors } : {}),
  };

  const result = normalizeNessyPluginManifest(nativeCandidate, {
    origin: {
      ...origin,
      adapterId: CLAUDE_ADAPTER_ID,
      adapterVersion: CLAUDE_ADAPTER_VERSION,
    },
  });
  if (!result.value) {
    return {
      ok: result.ok,
      diagnostics: [...diagnostics, ...result.diagnostics],
    };
  }

  const manifest: NessyPluginManifest = {
    ...result.value,
    capabilities: result.value.capabilities.map(requireImportedRuntimeTrust),
    ...(defaultEnabled !== undefined ? { defaultEnabled } : {}),
    compatibility: {
      rawExternalKind: 'claude-plugin',
      adapter: {
        adapterId: CLAUDE_ADAPTER_ID,
        adapterVersion: CLAUDE_ADAPTER_VERSION,
        rawKind: 'claude-plugin',
        ...(manifestless ? {} : { rawManifestPath: CLAUDE_MANIFEST_RELATIVE_PATH }),
        warnings: diagnostics.filter((diagnostic): diagnostic is PluginDiagnostic & { severity: 'warning' } => diagnostic.severity === 'warning'),
      },
    },
  };
  const runtimeProfiles = claudeRuntimeCompatibilityProfiles(capabilities);
  if (runtimeProfiles.length > 0) {
    manifest.runtimeCompatibility = { profiles: runtimeProfiles };
  }

  const finalized = deferUnavailablePluginSurfaces(
    manifest,
    [...diagnostics, ...result.diagnostics],
    buildClaudeCompatibilityReport(capabilities, deferred, result.value.connectors ?? []),
    CLAUDE_ADAPTER_ID,
  );
  return {
    ok: result.ok,
    value: finalized.value,
    compatibility: finalized.compatibility,
    diagnostics: finalized.diagnostics,
  };
}

/**
 * `claude-plugin-env-v1` (A2) is recorded whenever the normalized manifest
 * retains a Claude runtime consumer that can read documented CLAUDE_* values:
 * skill text, a command hook, or a stdio MCP server. IR-only — no env is
 * materialized here; the pinned runtime expands/materializes the allowlist.
 */
function claudeRuntimeCompatibilityProfiles(capabilities: PluginCapability[]): PluginRuntimeCompatibilityProfile[] {
  const hasRuntimeConsumer = capabilities.some(capability => (
    capability.kind === 'skill'
    || capability.kind === 'hook'
    || (capability.kind === 'mcp' && capability.mcp.transport === 'stdio')
  ));
  return hasRuntimeConsumer ? ['claude-plugin-env-v1'] : [];
}

/**
 * `supportedKinds` reports `PluginCapabilityKind` values as-is EXCEPT
 * `prompt-command`, which is reported under the external-facing label
 * `"command"` (matching the A1 fixtures' `expected-inventory.json` — Claude's
 * own vocabulary calls these "commands"; the internal capability kind stays
 * `prompt-command` everywhere else, this label is compatibility-report
 * presentation only).
 */
function reportKindLabel(kind: PluginCapability['kind']): PluginCapabilityKind {
  return kind === 'prompt-command' ? 'command' : kind;
}

function buildClaudeCompatibilityReport(
  capabilities: PluginCapability[],
  deferred: PluginCompatibilityReport['deferred'],
  connectors: PluginConnectorDescriptor[] = [],
): PluginCompatibilityReport {
  const supportedKinds: PluginCompatibilityReport['supportedKinds'] = [
    ...new Set(capabilities.map(capability => reportKindLabel(capability.kind))),
  ];
  // A promoted remote OAuth MCP server is a SUPPORTED surface (it runs through
  // the materialized Source path), matching the Codex report's 'connector' kind.
  if (connectors.length > 0) supportedKinds.push('connector');
  return {
    format: 'claude',
    state: deferred.length > 0 ? 'partial' : 'supported',
    supportedKinds,
    deferred,
    blocked: [],
  };
}

// --- skills --------------------------------------------------------------

/**
 * EXTENDS, per `plugins/manifest-reference.md#how-each-key-combines-with-its-default-location`: "**Adds to the default**: `skills`.
 * The default `skills/` directory is always scanned, and directories listed in
 * `skills` are loaded alongside it."
 *
 * So the default scan is unconditional and the declared paths are additional —
 * never a replacement. Duplicates are collapsed on slug (first wins), because a
 * manifest that lists `./skills/` explicitly would otherwise produce two
 * capabilities with the same id and fail the whole bundle as
 * `plugin.capability.duplicate_id`.
 *
 * The marketplace-root exception in the same sentence — "for a marketplace entry
 * whose `source` resolves to the marketplace root, declaring specific
 * subdirectories replaces the default `skills/` scan" — arrives as
 * `replaceDefaultScan`. `plugins/marketplace-reference.md#relative-path-plugin-source` states it from the other
 * side: "With a marketplace-root `source`, the listed paths are the complete set
 * for that entry, and other directories in the shared `skills/` folder don't
 * load. Listing `./skills/` itself, or the plugin root, keeps the full scan. If
 * none of the listed paths exist, the default scan runs instead."
 *
 * The last clause is why the declared paths are scanned FIRST here: the decision
 * to skip the default needs their result, not only their text. The two rules are
 * one flag apart on purpose — the ordinary rule is what runs for every plugin
 * that is not a marketplace-root entry, and it is not conditional on anything.
 */
async function normalizeClaudeSkills(
  rootDirectory: string,
  declared: ManifestComponentPathResolution,
  diagnostics: PluginDiagnostic[],
  options: { fallbackSlug: string; replaceDefaultScan?: boolean },
): Promise<PluginCapability[]> {
  const capabilities: PluginCapability[] = [];
  const seen = new Set<string>();
  const push = (slug: string, path: string): void => {
    if (seen.has(slug)) return;
    seen.add(slug);
    capabilities.push({ kind: 'skill', id: createPluginCapabilityId('skill', slug), skill: { slug, path } });
  };

  const declaredScans: Array<{ entry: ManifestComponentPath; scan: ManifestSkillScan }> = [];
  for (const entry of declared.paths) {
    declaredScans.push({ entry, scan: await scanManifestSkillDirectory(rootDirectory, entry.path) });
  }
  // `:511` — "If none of the listed paths exist, the default scan runs instead."
  const skipDefaultScan = options.replaceDefaultScan === true
    && declaredScans.some(({ scan }) => scan.kind !== 'missing');
  const defaultScan = skipDefaultScan
    ? undefined
    : await scanManifestSkillDirectory(rootDirectory, CLAUDE_DEFAULT_SKILLS_DIR);
  if (defaultScan?.kind === 'nested') {
    for (const skill of defaultScan.skills) push(skill.slug, skill.path);
  }

  for (const { entry, scan } of declaredScans) {
    if (scan.kind === 'missing') {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_path_missing',
        `Claude skills path "${entry.path}" does not exist or cannot be read.`,
        entry.diagnosticPath,
        { kind: 'skill', path: entry.path },
      ));
      continue;
    }
    if (scan.kind === 'root-skill') {
      // `:647`: "When a skill path points to a directory that contains a
      // `SKILL.md` directly, for example `"skills": ["./"]` pointing to the
      // plugin root, the frontmatter `name` field in `SKILL.md` determines the
      // skill's invocation name. … If `name` is not set in the frontmatter, the
      // directory basename is used as a fallback." For the plugin root the
      // basename is the install directory, which the same sentence says must
      // not decide the name ("a stable name regardless of the install
      // directory"), so the bundle's own name is the fallback there.
      push(await claudeSkillInvocationName(rootDirectory, scan.skillPath, entry.path, options.fallbackSlug), scan.skillPath);
      continue;
    }
    if (scan.skills.length === 0) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_capability_incomplete',
        `Claude skills path "${entry.path}" did not contain any SKILL.md files.`,
        entry.diagnosticPath,
        { kind: 'skill', path: entry.path },
      ));
      continue;
    }
    for (const skill of scan.skills) push(skill.slug, skill.path);
  }

  if (capabilities.length === 0) {
    // `:649`, a DIFFERENT case from `:647`: "A plugin that has a `SKILL.md` at
    // its root, no `skills/` subdirectory, and no `skills` manifest field is
    // automatically loaded as a single-skill plugin". The two are kept apart
    // deliberately — collapsing them is what produced the behaviour where a
    // declared `skills` field suppressed the root skill AND resolved nothing.
    if (!declared.declared && defaultScan?.kind === 'missing') {
      return normalizeClaudeSingleRootSkill(rootDirectory, options);
    }
    if (defaultScan !== undefined && defaultScan.kind !== 'missing') {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_capability_incomplete',
        `Claude skills directory "${CLAUDE_DEFAULT_SKILLS_DIR}" did not contain any SKILL.md files.`,
        CLAUDE_DEFAULT_SKILLS_DIR,
        { kind: 'skill', path: CLAUDE_DEFAULT_SKILLS_DIR },
      ));
    }
  }
  return capabilities;
}

/**
 * `:647`'s invocation-name rule for a skill path that points straight at a
 * directory holding `SKILL.md`: frontmatter `name` first, then the directory
 * basename, then — for the plugin root, whose basename is the unstable install
 * directory — the bundle's own name.
 */
async function claudeSkillInvocationName(
  rootDirectory: string,
  skillPath: string,
  directory: string,
  fallbackSlug: string,
): Promise<string> {
  let frontmatterName = '';
  try {
    frontmatterName = splitMarkdownFrontmatter(await readFile(join(rootDirectory, skillPath), 'utf-8')).frontmatter.name ?? '';
  } catch {
    frontmatterName = '';
  }
  return frontmatterName || (directory ? basename(directory) : fallbackSlug);
}

/**
 * `:649`'s automatic single-skill layout: "A plugin that has a `SKILL.md` at its
 * root, no `skills/` subdirectory, and no `skills` manifest field is
 * automatically loaded as a single-skill plugin in Claude Code v2.1.142 and
 * later. You do not need to set `"skills": ["./"]` in `plugin.json` for this
 * layout." The invocation name follows the same rule as `:647`.
 *
 * The "no `skills` manifest field" condition is the docs' own, not an inversion
 * of `:637`: `:637` governs the `skills/` DIRECTORY scan, which is
 * unconditional above. When a manifest declares `skills` and points it at the
 * root, `:647` — not this function — is what loads the root skill.
 */
async function normalizeClaudeSingleRootSkill(
  rootDirectory: string,
  options: { fallbackSlug: string },
): Promise<PluginCapability[]> {
  const skillPath = 'SKILL.md';
  if (!existsSync(join(rootDirectory, skillPath))) return [];
  const slug = await claudeSkillInvocationName(rootDirectory, skillPath, '', options.fallbackSlug);
  return [{
    kind: 'skill',
    id: createPluginCapabilityId('skill', slug),
    skill: { slug, path: skillPath },
  }];
}

// --- prompt commands -------------------------------------------------------

const DYNAMIC_SUBSTITUTION_PATTERNS: Array<{ pattern: RegExp; kind: string }> = [
  { pattern: /\$[1-9]\b/, kind: 'positional-argument' },
  // THE runtime's own recogniser, imported rather than restated: what this
  // detector defers and what the skill-body executor actually runs must not
  // drift. The private copy this replaces had no left-boundary check, so it
  // flagged `` KEY=!`cmd` `` — text `skills.md` says stays literal.
  { pattern: RUNTIME_SKILL_CONTEXT_INLINE_PATTERN, kind: 'bash-execution' },
  { pattern: /(^|[^\w])@[^\s]+/, kind: 'file-reference' },
];

/**
 * REPLACES, per `plugins/manifest-reference.md#how-each-key-combines-with-its-default-location`: "when the manifest specifies
 * `commands`, the default `commands/` directory is not scanned. To keep the
 * default and add more, list it explicitly: `"commands": ["./commands/",
 * "./extras/"]`".
 *
 * So the file set is: the declared paths when the field is declared, and the
 * documented default directory otherwise. A declared field whose every entry was
 * refused by the containment gate still replaces — falling back to the default
 * would re-create exactly the defect this fixes, where we load the folder Claude
 * does not scan.
 *
 * Each declared entry may be a directory to scan or a single component file:
 * `:525`'s own examples are `"./custom/cmd.md"` and `["./cmd1.md"]`, and
 * `:655`'s path example mixes both forms.
 */
/**
 * P6.740 · What each remaining component kind's OWN page says about a
 * subdirectory — and why NONE of the three recurses the way agents do.
 *
 * P6.728 fixed agents and stopped there, deliberately: *"whether a plugin's
 * COMMANDS, workflows or output styles are scanned recursively is a separate
 * question with a separate page and a separate identifier rule"*. Those three
 * pages were read for this row, and the answer they give is the same in
 * substance and different in wording: **the subfolder is not part of the
 * identifier, and no page says these directories are scanned recursively.**
 * Agents are the exception, not the rule — `sub-agents.md` is explicit that a
 * plugin's `agents/` tree is *"scanned recursively"* and that the subfolder
 * *"becomes part of the scoped identifier"*.
 *
 * So recursing here would be the opposite defect from the one P6.728 fixed: it
 * would mint components the runtime never loads, under identifiers no page
 * defines. What the row's premise is right about is the SILENCE — a nested file
 * produced no component and no diagnostic — and silence is what this closes.
 *
 * - **commands** — `skills.md`, verbatim: *"You invoke a command file by its
 *   file name."* (`name` is ignored in a command file.) The path contributes
 *   nothing, and `plugins/manifest-reference.md#standard-layout` calls the
 *   directory *"Skills as flat Markdown files"*. A subdirectory under a
 *   commands path is the SKILL layout, which the page's own error text names:
 *   *"Expected .md files or SKILL.md in subdirectories."*
 * - **workflows** — `workflows.md#distribute-a-workflow-in-a-plugin`, verbatim:
 *   *"Plugin workflows are namespaced by the plugin name. A plugin called
 *   `acme-tools` containing a script whose `meta.name` is `release-audit` runs
 *   as `/acme-tools:release-audit`."* The identifier comes from inside the
 *   script, so a subfolder could not appear in it even if we walked one.
 * - **output styles** — `output-styles.md#frontmatter`, verbatim: the `name`
 *   field is the *"Name of the output style, if not the file name"*, defaulting
 *   to *"Inherits from file name"*. Again the file, never the path.
 */
const CLAUDE_NESTED_COMPONENT_HINTS = {
  commands: 'A command is invoked by its file name, so a subfolder adds nothing to it; '
    + 'put a SKILL.md inside the subdirectory to ship it as a skill instead.',
  workflows: 'A workflow is named by its own meta.name and namespaced by the plugin, '
    + 'so it must sit directly in the declared directory.',
  outputStyles: 'An output style is named by its frontmatter name, or by its file name, '
    + 'so it must sit directly in the declared directory.',
} as const;

/**
 * C3.352 — the one durable row for a component whose FILES are there and whose
 * EXTENSION is not.
 *
 * C5.28 measured the cost of leaving that case to a diagnostic alone: a Claude
 * bundle whose workflow was written as `audit.ts` installed `ok: true`,
 * `state: "supported"`, `deferred: []`, and the SDK's own runtime then answered
 * `Workflow "…" not found. Available: deep-research` — the component was gone
 * and every surface said the bundle was fine.
 *
 * The reasoning is {@link normalizeClaudeWorkflows}'s own, one case wider: a
 * `PluginDiagnostic` is an INSTALL-TIME value that reaches `diagnosticCodes` and
 * is gone, while `compatibility.deferred` is the durable channel with a live
 * reader (`toSafeDeferredCapabilities` → the plugin detail view) and one entry
 * flips `state` to `partial`, which is the honest state for a bundle that lost a
 * component. It applies to all three kinds that share this collector rather than
 * to workflows alone: the mechanism is one, and a rule that fired for `.js` and
 * not for `.md` would be arbitrary where a reader most needs it not to be.
 */
const CLAUDE_UNSUPPORTED_COMPONENT_EXTENSION_REASON =
  'plugin.deferred.claude_component_extension_unsupported';

async function collectClaudeComponentFiles(
  rootDirectory: string,
  declared: ClaudeComponentPathResolution,
  defaultDirectory: string,
  extension: string,
  diagnostics: PluginDiagnostic[],
  nestedHint?: string,
  /**
   * C3.352 — present for every caller that has a `deferred` array, which today
   * is all three. Optional only so the signature does not force a fourth caller
   * with nothing to record into inventing one.
   */
  unsupportedShape?: {
    readonly deferred: PluginCompatibilityReport['deferred'];
    readonly externalKind: string;
  },
): Promise<string[]> {
  const files: string[] = [];
  const add = (discovered: string[]): void => {
    for (const file of discovered) {
      if (!files.includes(file)) files.push(file);
    }
  };
  /**
   * The extensions that WERE there, said once per path. Returns the sentence so
   * the caller can fold it into the diagnostic it was already emitting rather
   * than emitting a second one about the same path.
   */
  const reportUnsupportedExtensions = (
    rejected: readonly string[],
    /**
     * The path the AUTHOR wrote, not the manifest pointer: a `deferred` row
     * crosses the RPC boundary to a badge in the plugin detail view, and
     * `workflows.0` is an anchor for a diagnostic rather than something to show
     * a person. The diagnostic keeps the pointer.
     */
    authoredPath: string,
  ): string => {
    if (rejected.length === 0) return '';
    unsupportedShape?.deferred.push({
      externalKind: unsupportedShape.externalKind,
      reasonCode: CLAUDE_UNSUPPORTED_COMPONENT_EXTENSION_REASON,
      sourcePath: authoredPath,
    });
    return ` It holds ${rejected.join(', ')} instead, and Claude loads this component as ${extension}.`;
  };
  // P6.740 — see {@link CLAUDE_NESTED_COMPONENT_HINTS}: a subdirectory here is
  // NOT scanned, and the author is told rather than left with an absent
  // component and no diagnostic.
  const reportIgnored = (directories: string[], source: string): void => {
    if (!nestedHint) return;
    for (const directory of directories) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_nested_component_ignored',
        `Claude does not scan "${directory}" for ${extension} files. ${nestedHint}`,
        source,
        { path: directory },
      ));
    }
  };

  // The default folder is displaced only by the AUTHORITY's declaration. A
  // supplementing marketplace entry (`:519`) adds to it, so its paths load after
  // the default rather than instead of it. A missing default directory is the
  // ordinary "this plugin ships no commands" case and stays silent.
  if (!declared.authorityDeclared) {
    const expanded = await expandManifestComponentDirectory(
      rootDirectory,
      { path: defaultDirectory, diagnosticPath: defaultDirectory },
      extension,
    );
    if (expanded.kind === 'files') {
      add(expanded.files);
      reportIgnored(expanded.directories, defaultDirectory);
      // C3.352 — an EMPTY default directory is the ordinary "this plugin ships
      // no commands" case and stays silent; one holding files of the wrong
      // extension is the C5.28 defect and is not.
      if (expanded.files.length === 0) {
        const held = reportUnsupportedExtensions(expanded.rejectedExtensions, defaultDirectory);
        if (held) {
          diagnostics.push(pluginDiagnostic(
            'warning',
            'plugin.format.claude_path_missing',
            `Claude's default "${defaultDirectory}" directory contains no ${extension} files.${held}`,
            defaultDirectory,
            { path: defaultDirectory },
          ));
        }
      }
    }
  }

  for (const source of declared.paths) {
    const expanded = await expandManifestComponentDirectory(rootDirectory, source, extension);
    if (expanded.kind === 'missing' || expanded.files.length === 0) {
      // A declared path that resolves to nothing is an authoring error the
      // author needs to see.
      const held = expanded.kind === 'files'
        ? reportUnsupportedExtensions(expanded.rejectedExtensions, source.path)
        : '';
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_path_missing',
        `Claude manifest path "${source.path}" contains no ${extension} files or cannot be read.${held}`,
        source.diagnosticPath,
        { path: source.path },
      ));
      continue;
    }
    add(expanded.files);
    reportIgnored(expanded.directories, source.diagnosticPath);
  }
  return files;
}

async function normalizeClaudePromptCommands(
  rootDirectory: string,
  declared: ClaudeComponentPathResolution,
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
): Promise<PluginCapability[]> {
  const commandFiles = await collectClaudeComponentFiles(
    rootDirectory,
    declared,
    CLAUDE_DEFAULT_COMMANDS_DIR,
    '.md',
    diagnostics,
    CLAUDE_NESTED_COMPONENT_HINTS.commands,
    { deferred, externalKind: 'prompt-command' },
  );
  const capabilities: PluginCapability[] = [];
  for (const relativePath of commandFiles) {
    const name = basename(relativePath, '.md');
    const content = await readFile(join(rootDirectory, relativePath), 'utf-8');
    const { frontmatter, body } = splitMarkdownFrontmatter(content);

    // Never evaluate shell/file expressions — only detect and defer them.
    for (const { pattern, kind } of DYNAMIC_SUBSTITUTION_PATTERNS) {
      if (pattern.test(body)) {
        deferred.push({
          externalKind: `command-dynamic-substitution-${kind}`,
          reasonCode: 'plugin.deferred.claude_command_dynamic_substitution',
          sourcePath: relativePath,
        });
      }
    }

    capabilities.push({
      kind: 'prompt-command',
      id: createPluginCapabilityId('prompt-command', name),
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
      promptCommand: {
        name,
        path: relativePath,
        ...(frontmatter['argument-hint'] ? { argumentHint: frontmatter['argument-hint'] } : {}),
        ...(frontmatter.model ? { model: frontmatter.model } : {}),
      },
    });
  }
  return capabilities;
}

// --- workflows -------------------------------------------------------------

/**
 * Plugin workflows (`plugins-reference.md` §Workflows, `workflows.md`
 * §Distribute a workflow in a plugin).
 *
 * The capability is keyed on `meta.name`, not the file name: a plugin workflow
 * "runs as `/acme-tools:release-audit`" where `release-audit` is `meta.name`.
 * The metadata is read with the SAME pure-literal parser the filesystem loader
 * uses (`parseWorkflowRecipe`) — no evaluation of the script, ever — so a
 * computed `meta` becomes a diagnostic rather than a capability with a guessed
 * name. `.js` is our choice of extension; no Claude page states one.
 *
 * **A refused workflow is recorded as DEFERRED, not only as a diagnostic
 * (P2.146).** This was the one normalizer of the six here never handed
 * `deferred`, and the omission had a measured cost: the official
 * `claude-security` bundle installed reporting `ok: true`, `state: "supported"`,
 * `deferred: []` while the plugin's central pipeline — the recipe two separate
 * `Workflow(claude-security:scan)` grants point at — was missing, and the model
 * that then called it got `Unknown workflow recipe: scan`, indistinguishable
 * from a typo. A `PluginDiagnostic` is an INSTALL-TIME value: it reaches
 * `diagnosticCodes` on the install result and is gone. `compatibility.deferred`
 * is the durable channel with a live reader — `toSafeDeferredCapabilities`
 * (`handlers/rpc/marketplace.ts`) → the plugin detail view's badge and install
 * summary — and one entry flips `state` to `partial`
 * (`buildClaudeCompatibilityReport`), which is the
 * honest state for a bundle that lost a component. Both are emitted: the
 * diagnostic still carries the parser's message and the file path, which a
 * `deferred` entry deliberately does not cross the RPC boundary with.
 */
async function normalizeClaudeWorkflows(
  rootDirectory: string,
  declared: ClaudeComponentPathResolution,
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
): Promise<PluginCapability[]> {
  const workflowFiles = await collectClaudeComponentFiles(
    rootDirectory,
    declared,
    CLAUDE_DEFAULT_WORKFLOWS_DIR,
    '.js',
    diagnostics,
    CLAUDE_NESTED_COMPONENT_HINTS.workflows,
    { deferred, externalKind: 'workflow' },
  );
  const capabilities: PluginCapability[] = [];
  for (const relativePath of workflowFiles) {
    let meta;
    try {
      meta = parseWorkflowRecipe(await readFile(join(rootDirectory, relativePath), 'utf-8')).meta;
    } catch (error) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_workflow_unreadable',
        `Claude plugin workflow could not be read: ${error instanceof Error ? error.message : String(error)}`,
        relativePath,
      ));
      deferred.push({
        externalKind: 'workflow',
        reasonCode: 'plugin.deferred.claude_workflow_unreadable',
        sourcePath: relativePath,
      });
      continue;
    }
    capabilities.push({
      kind: 'workflow',
      id: createPluginCapabilityId('workflow', meta.name),
      ...(meta.description ? { description: meta.description } : {}),
      workflow: { name: meta.name, path: relativePath },
    });
  }
  return capabilities;
}

// --- output styles ---------------------------------------------------------

/**
 * Plugin-shipped output styles (`plugins/components.md#themes-and-output-styles`'s `outputStyles`,
 * `output-styles.md` § Create a custom output style).
 *
 * REPLACES, per `:636`: a declared `outputStyles` displaces the default
 * `output-styles/` folder, which `collectClaudeComponentFiles` decides from the
 * AUTHORITY's declaration alone.
 *
 * The frontmatter is read with the SAME reader the prompt builder uses for a
 * user-authored style, so `name`/`description`/`keep-coding-instructions` cannot
 * mean one thing at import and another at composition. `keep-coding-instructions`
 * is carried for display only: what the turn honours is the value re-read from
 * the pinned file, so a manifest cannot assert a subtraction the file does not
 * declare — and no value of it can remove safety text, because the split is per
 * bullet (`prompts/system.ts:getSafetyAndEngineeringSections`).
 *
 * `output-styles.md` § Frontmatter's `force-for-plugin` is recorded as a
 * deferral, SAID to the author, and never honoured: it applies a style "without
 * requiring users to select it. Overrides the user's `outputStyle` setting" — a
 * plugin writing the highest-trust text in the turn, unattended and invisibly.
 * The refusal is PERMANENT (P6.513, Q-den 44), which is exactly why it now
 * carries a diagnostic as well as a machine-readable row: a deferral that will
 * never be lifted is a documented difference, and a documented difference nobody
 * is told about is indistinguishable from a defect.
 */
async function normalizeClaudeOutputStyles(
  rootDirectory: string,
  declared: ClaudeComponentPathResolution,
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
): Promise<PluginCapability[]> {
  const styleFiles = await collectClaudeComponentFiles(
    rootDirectory,
    declared,
    CLAUDE_DEFAULT_OUTPUT_STYLES_DIR,
    '.md',
    diagnostics,
    CLAUDE_NESTED_COMPONENT_HINTS.outputStyles,
    { deferred, externalKind: 'output-style' },
  );
  const capabilities: PluginCapability[] = [];
  const seen = new Set<string>();
  // Sorted, because two files can carry the same frontmatter `name` and "the
  // first one wins" must not mean "whatever `readdir` happened to return first".
  // The wider nondeterminism is pre-existing for every other component field —
  // `expandManifestComponentDirectory` returns directory order — and is recorded
  // rather than changed here, since sorting there would reorder the capability
  // lists of existing bundles.
  for (const relativePath of [...styleFiles].sort((a, b) => a.localeCompare(b))) {
    const content = await readFile(join(rootDirectory, relativePath), 'utf-8');
    // `output-styles.md:49` — "The file name becomes the style name unless you set
    // `name` in the frontmatter."
    const parsed = readOutputStyleFrontmatter(content);
    const name = parsed.name?.trim() || basename(relativePath, '.md');
    const slug = outputStyleNameSlug(name);
    if (slug === null) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_output_style_unnameable',
        `Claude output style "${relativePath}" has no name that yields a selectable id.`,
        relativePath,
        { path: relativePath },
      ));
      continue;
    }
    if (seen.has(slug)) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_output_style_duplicate',
        `Claude output style "${relativePath}" repeats the style name "${name}"; the first file wins.`,
        relativePath,
        { path: relativePath },
      ));
      continue;
    }
    seen.add(slug);
    if (parsed.forceForPlugin === true && !deferred.some(entry => entry.externalKind === 'output-style-force')) {
      // Recorded once per bundle: the author asked for automatic application and
      // is not getting it.
      deferred.push({
        externalKind: 'output-style-force',
        reasonCode: 'plugin.deferred.claude_output_style_force_for_plugin',
      });
      // …and SAID so, once per bundle, in the same voice as the `agent` default
      // setting's refusal (P6.513, Q-den 44 = option 1: the deferral is
      // permanent, so it must be surfaced rather than left for a debug reader).
      //
      // Until this diagnostic the record was the `deferred` ROW alone, whose
      // whole vocabulary is an external kind and a reason code — the author saw
      // `output-style-force not supported (code: …)` on the plugin's detail page
      // and nowhere learned WHICH style asked, or that the style still works the
      // moment it is chosen. `settings-agent` has carried a named refusal since
      // R76 and this one had none, which is the asymmetry: the same posture,
      // stated once loudly and once not at all.
      //
      // The two texts now point AT EACH OTHER on purpose. `agent`'s says the
      // refusal is "the same unattended-default move this fork already refuses
      // for output styles"; this one names `agent` back. One rule, written
      // twice, so a reader who meets either learns the whole of it.
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_output_style_force_unsupported',
        `Claude output style "${name}" declares \`force-for-plugin\` and is recorded, not applied.`
          + ' Nessy never applies an output style the user did not select: a plugin changing the'
          + " assistant's voice merely by being enabled is the same unattended-default move this fork"
          + ' refuses for a plugin\'s `agent` default setting. The style is still offered in the picker'
          + ' and takes effect as soon as the user chooses it.',
        relativePath,
        { kind: 'output-style-force', style: name, path: relativePath },
      ));
    }
    capabilities.push({
      kind: 'output-style',
      id: createPluginCapabilityId('output-style', slug),
      displayName: name,
      ...(parsed.description ? { description: parsed.description } : {}),
      outputStyle: {
        name,
        path: relativePath,
        ...(parsed.keepCodingInstructions === undefined
          ? {}
          : { keepCodingInstructions: parsed.keepCodingInstructions }),
        ...(parsed.forceForPlugin === undefined ? {} : { forceForPlugin: parsed.forceForPlugin }),
      },
    });
  }
  return capabilities;
}

// --- agents ----------------------------------------------------------------

/** One discovered agent file, with the subfolder path that scopes its name. */
interface ClaudeAgentFile {
  /** Bundle-relative path to the `.md` file. */
  readonly relativePath: string;
  /**
   * Directory segments between the agents ROOT and the file — `['review']` for
   * `agents/review/security.md`, empty for `agents/security.md`.
   */
  readonly scopeSegments: readonly string[];
}

/**
 * P6.728 · How deep an agents tree is walked.
 *
 * The page says "scanned recursively" and puts no depth on it. A bundle is
 * untrusted input and a walk needs a floor, so this is the one invented value
 * here and it is written down rather than left implicit: 8 levels below the
 * agents root, which is four times the deepest layout the page illustrates
 * (`agents/review/`). A file below it is dropped with a diagnostic rather than
 * silently, because silence is what this row exists to remove.
 */
const CLAUDE_AGENT_SCAN_MAX_DEPTH = 8;

/**
 * Recursively expand one declared agents path.
 *
 * `expandManifestComponentDirectory` — the shared expander every component
 * field uses — reads ONE level (`entries.filter(child => child.isFile())`), so
 * before this row a plugin's `agents/review/security.md` produced no capability
 * at all: not a mis-named agent, an ABSENT one, with no diagnostic. Measured on
 * a fixture bundle carrying `agents/top.md` (found, the positive control) and
 * `agents/review/security.md` (missing, zero diagnostics).
 *
 * `sub-agents.md#choose-the-subagent-scope`, verbatim: *"Plugin `agents/`
 * directories are also scanned recursively. Unlike project and user scopes, a
 * subfolder inside a plugin's `agents/` directory becomes part of the scoped
 * identifier: a file at `agents/review/security.md` in plugin `my-plugin`
 * registers as `my-plugin:review:security`."*
 *
 * Only agents recurse here. The same page's neighbouring sentence is why this
 * is not pushed down into the shared expander: for project and user scopes
 * *"The subdirectory path doesn't affect how a subagent is identified or
 * invoked"*, and whether a plugin's COMMANDS, workflows or output styles are
 * scanned recursively is a separate question with a separate page and a
 * separate identifier rule — answering it here would change three surfaces on
 * the strength of one page's sentence about a fourth.
 *
 * Symlinks are treated exactly as the shared expander treats them: the declared
 * path itself may be one (`isManifestDirectory(…, true)`), and inside the tree
 * only real files and real directories are read, so a symlinked subdirectory
 * cannot re-enter the walk.
 */
async function expandClaudeAgentDirectory(
  rootDirectory: string,
  entry: ManifestComponentPath,
  diagnostics: PluginDiagnostic[],
): Promise<ClaudeAgentFile[]> {
  const absoluteRoot = entry.path ? join(rootDirectory, entry.path) : rootDirectory;
  if (entry.path.toLowerCase().endsWith('.md') && await isManifestFile(absoluteRoot, true)) {
    // A declared path that names the file itself carries no subfolder relative
    // to a root, because it IS the root.
    return [{ relativePath: entry.path, scopeSegments: [] }];
  }
  if (!await isManifestDirectory(absoluteRoot, true)) return [];

  const found: ClaudeAgentFile[] = [];
  const walk = async (segments: readonly string[]): Promise<void> => {
    const relativeDirectory = [entry.path, ...segments].filter(Boolean).join('/');
    const absolute = relativeDirectory ? join(rootDirectory, relativeDirectory) : rootDirectory;
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of entries) {
      if (child.isFile() && child.name.toLowerCase().endsWith('.md')) {
        found.push({
          relativePath: relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name,
          scopeSegments: segments,
        });
        continue;
      }
      if (!child.isDirectory()) continue;
      if (segments.length >= CLAUDE_AGENT_SCAN_MAX_DEPTH) {
        diagnostics.push(pluginDiagnostic(
          'warning',
          'plugin.format.claude_agents_too_deep',
          `Claude agents directory "${relativeDirectory}/${child.name}" is nested deeper than `
            + `${CLAUDE_AGENT_SCAN_MAX_DEPTH} levels and was not scanned.`,
          relativeDirectory,
          { path: relativeDirectory },
        ));
        continue;
      }
      await walk([...segments, child.name]);
    }
  };
  await walk([]);
  return found;
}

/**
 * Every agent file in the bundle, with its scope. Mirrors
 * `collectClaudeComponentFiles` — same default-vs-declared precedence, same
 * `claude_path_missing` diagnostic, same first-wins de-duplication — and
 * differs only in walking subdirectories and reporting where each file sat.
 */
async function collectClaudeAgentFiles(
  rootDirectory: string,
  declared: ClaudeComponentPathResolution,
  diagnostics: PluginDiagnostic[],
): Promise<ClaudeAgentFile[]> {
  const files: ClaudeAgentFile[] = [];
  const add = (discovered: ClaudeAgentFile[]): void => {
    for (const file of discovered) {
      if (!files.some(seen => seen.relativePath === file.relativePath)) files.push(file);
    }
  };

  if (!declared.authorityDeclared) {
    add(await expandClaudeAgentDirectory(
      rootDirectory,
      { path: CLAUDE_DEFAULT_AGENTS_DIR, diagnosticPath: CLAUDE_DEFAULT_AGENTS_DIR },
      diagnostics,
    ));
  }

  for (const source of declared.paths) {
    const expanded = await expandClaudeAgentDirectory(rootDirectory, source, diagnostics);
    if (expanded.length === 0) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_path_missing',
        `Claude manifest path "${source.path}" contains no .md files or cannot be read.`,
        source.diagnosticPath,
        { path: source.path },
      ));
      continue;
    }
    add(expanded);
  }
  return files;
}

async function normalizeClaudeAgents(
  rootDirectory: string,
  declared: ClaudeComponentPathResolution,
  diagnostics: PluginDiagnostic[],
): Promise<PluginCapability[]> {
  const agentFiles = await collectClaudeAgentFiles(rootDirectory, declared, diagnostics);
  const capabilities: PluginCapability[] = [];
  for (const { relativePath, scopeSegments } of agentFiles) {
    const fileBaseName = basename(relativePath, '.md');
    const content = await readFile(join(rootDirectory, relativePath), 'utf-8');
    const { frontmatter } = splitMarkdownFrontmatter(content);
    // `plugins/components.md#agents`: "Claude Code loads a plugin agent even when
    // its frontmatter has no `name` or doesn't parse: … No `name`: Claude Code
    // names the agent after the file … Frontmatter that doesn't parse: Claude
    // Code names the agent after the file, uses `Agent from my-plugin plugin` as
    // its description, and ignores every field in the file."
    //
    // The no-`name` half is the `||` below. The doesn't-parse half is measured
    // (P6.428) and we are NOT conformant: `splitMarkdownFrontmatter` reports no
    // parse failure — on a js-yaml error it falls back to a line scanner — so
    // whatever that scanner salvaged arrives here looking like a declaration.
    // The `frontmatterName` guard closes the SEVERE half of that divergence,
    // which was not a naming bug at all: a salvaged value like `[unclosed` is
    // not a legal capability id, so `agent.[unclosed` failed
    // `plugin.capability.invalid_id` and the WHOLE BUNDLE was refused —
    // `ok: false`, zero capabilities, every unrelated skill/command/hook in that
    // plugin lost to one malformed agent file. The page's rule is the opposite,
    // and it also supplies the remedy: name it after the file.
    //
    // Validated against the id that will actually be built, not against the bare
    // name, so a name this adapter accepts today (a leading `-`, legal once
    // prefixed with `agent.`) keeps working. What is still divergent, and is a
    // contract change rather than a repair: a salvaged name that IS id-legal
    // (`name: a` / `name: b` duplicated — js-yaml refuses, the scanner takes the
    // last) still names the agent `b` rather than after the file, and the
    // documented `Agent from <plugin> plugin` description fallback exists
    // nowhere. Both need `splitMarkdownFrontmatter` to report the failure.
    const frontmatterName = frontmatter.name?.trim();
    const name = frontmatterName
      && validatePluginId(createPluginCapabilityId('agent', frontmatterName)) === null
      ? frontmatterName
      : fileBaseName;
    // P6.728 — the subfolder is part of the identifier, and it is spelled twice
    // because the two spellings have different validators.
    //
    // `sub-agents.md#choose-the-subagent-scope`, verbatim: *"a subfolder inside
    // a plugin's `agents/` directory becomes part of the scoped identifier: a
    // file at `agents/review/security.md` in plugin `my-plugin` registers as
    // `my-plugin:review:security`."* The plugin prefix is minted one layer up
    // (`capabilities/views.ts`'s `agentMentionId`, P6.694) from this name, so
    // `review:security` here is what makes the typeahead read
    // `my-plugin:review:security`.
    //
    // The ID cannot carry that colon: `validatePluginId`'s charset is
    // `[A-Za-z0-9._-]`, which is why `createPluginCapabilityId` joins with `.`
    // and says so in its own docblock. So the id gets `agent.review.security`
    // and the NAME gets `review:security` — the id keeps two same-named agents
    // in different folders apart (before this row they were not merely
    // ambiguous, the nested one did not exist), and the name is the identifier
    // the page defines.
    //
    // A frontmatter `name` that already contains a colon is refused above, by
    // the same charset, and the file falls back to its basename — which is the
    // direction the page's frontmatter table takes: *"Names can't contain `:`,
    // which is reserved for plugin-scoped identifiers"*.
    //
    // If a directory segment makes the id illegal (a space, a leading dash),
    // the scoping is DROPPED for that file rather than the bundle being
    // refused. `plugin.capability.invalid_id` is fatal to the whole bundle —
    // P6.428 measured one malformed agent costing a plugin every unrelated
    // skill, MCP server and hook it shipped — so an unnameable folder costs its
    // own scope and nothing else, and says so.
    const scopedLocalName = [...scopeSegments, name].join(':');
    const scopedId = createPluginCapabilityId('agent', [...scopeSegments, name].join('.'));
    const scopeIsNameable = scopeSegments.length === 0 || validatePluginId(scopedId) === null;
    if (!scopeIsNameable) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_agent_scope_unnameable',
        `Claude agent "${relativePath}" sits in a subfolder that cannot be part of an identifier; `
          + `it is registered as "${name}" without its subfolder scope.`,
        relativePath,
        { path: relativePath },
      ));
    }
    const capabilityName = scopeIsNameable ? scopedLocalName : name;
    const capabilityId = scopeIsNameable ? scopedId : createPluginCapabilityId('agent', name);
    // `splitToolGrantList`, not a comma split: `sub-agents.md` § *Restrict which
    // subagents can be spawned* documents the parenthesized form inside a
    // `tools` list, and the official `claude-security` plugin writes it. Quoted
    // from the shipped artifact rather than paraphrased — re-measured at
    // `claude-security` **0.10.2**, `agents/claude-security.md` line 6 (staged
    // from `anthropics/claude-plugins-official`, fetched 2026-08-24), where the
    // last of that agent's sixteen `tools` entries is one grant carrying five
    // inner commas:
    //
    //   `Agent(claude-security:scan-inventory, claude-security:scan-researcher,
    //   claude-security:scan-verifier, claude-security:patch-generator,
    //   claude-security:patch-verifier, claude-security:explore)`
    //
    // Splitting on the inner comma produced six fragments the Pi runtime
    // resolves to nothing and then denies by omission, so the plugin silently
    // lost the subagent grant its agents are built around. The skill path has
    // tokenized this correctly since R17b; this is the same splitter, so the two
    // cannot disagree again. Verified live on HEAD 2026-08-24: normalizing the
    // staged 0.10.2 bundle yields that entry intact as ONE of sixteen.
    const tools = frontmatter.tools ? splitToolGrantList(frontmatter.tools) : undefined;

    capabilities.push({
      kind: 'agent',
      id: capabilityId,
      // `plugins-reference.md` § Agents — "Plugin agents support `name`,
      // `description`, `model`, `effort`, `maxTurns`, `tools`,
      // `disallowedTools`, `skills`, `memory`, `background`, and `isolation`
      // frontmatter fields", and the structure example annotates the field as
      // "What this agent specializes in and when Claude should invoke it".
      //
      // `description` is the ONE of those eleven that is not re-read from the
      // file at dispatch time: `buildPiRuntimeAgentDescriptor` takes every other
      // field as `agent.X ?? frontmatter.X` but takes `description` from the
      // capability alone (`runtime-agent-definition.ts:644`), and the listing
      // then falls back to `Imported <name> agent.`
      // (`runtime-agent-definitions.ts:155`) — a string that says nothing about
      // task fit, so the model cannot auto-dispatch by it. The Codex adapter
      // already carries it at this exact position (`codex.ts:1666`).
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
      agent: {
        // The scoped name, not the bare one. No separate `scope` field: the
        // segments are already on the descriptor twice over — spelled into this
        // name, and recoverable from `path` — and a third copy is a third thing
        // that can disagree.
        name: capabilityName,
        path: relativePath,
        ...(frontmatter.model ? { model: frontmatter.model } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
      },
    });
  }
  return capabilities;
}

// --- MCP servers -------------------------------------------------------------

async function normalizeClaudeMcpServers(
  rootDirectory: string,
  declared: ClaudeComponentPathResolution,
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
): Promise<{ capabilities: PluginCapability[]; connectors: PluginConnectorDescriptor[] }> {
  const sources = await collectClaudeConfigSources(
    rootDirectory,
    declared,
    CLAUDE_DEFAULT_MCP_FILE,
    { kind: 'mcp', fieldLabel: 'mcpServers', fileLabel: 'MCP servers' },
    diagnostics,
  );
  const capabilities: PluginCapability[] = [];
  const connectors: PluginConnectorDescriptor[] = [];
  // First-registered-wins across sources, the rule the LSP reader already
  // applies (`:268`) and the only one the MCP section leaves room for. Declared
  // and inline sources are collected ahead of the plugin-root default, so an
  // explicit declaration outranks the default file for a same-named server.
  const seenServers = new Set<string>();
  for (const { label: mcpPath, source: parsed } of sources) {
    // `.mcp.json` wraps the map in `mcpServers`; the inline manifest form is the
    // map itself, because the manifest key already names it (`testdino` and
    // `tres-finance-plugin` in Anthropic's community marketplace are both this
    // shape). Both are accepted, exactly as the hooks reader accepts both.
    const serverMap = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
    if (!isRecord(serverMap)) {
      diagnostics.push(incompleteClaudeCapability('mcp', mcpPath, 'Claude .mcp.json requires an mcpServers object.'));
      continue;
    }
    normalizeClaudeMcpServerMap({
      rootDirectory,
      serverMap,
      mcpPath,
      seenServers,
      capabilities,
      connectors,
      diagnostics,
      deferred,
    });
  }
  return { capabilities, connectors };
}

function normalizeClaudeMcpServerMap(options: {
  rootDirectory: string;
  serverMap: UnknownRecord;
  mcpPath: string;
  seenServers: Set<string>;
  capabilities: PluginCapability[];
  connectors: PluginConnectorDescriptor[];
  diagnostics: PluginDiagnostic[];
  deferred: PluginCompatibilityReport['deferred'];
}): void {
  const { rootDirectory, serverMap, mcpPath, seenServers, capabilities, connectors, diagnostics, deferred } = options;
  for (const [serverName, rawServer] of Object.entries(serverMap)) {
    if (seenServers.has(serverName)) continue;
    seenServers.add(serverName);
    if (!isRecord(rawServer)) {
      diagnostics.push(incompleteClaudeCapability('mcp', `${mcpPath}.${serverName}`, 'Claude MCP server descriptor must be an object.'));
      continue;
    }
    const rawTransport = normalizeMcpTransportAlias(stringField(rawServer, 'type') ?? stringField(rawServer, 'transport')
      ?? (stringField(rawServer, 'command') ? 'stdio' : stringField(rawServer, 'url') ? 'http' : undefined));
    // `mcp.md:322`: a plugin's MCP servers "support for stdio, SSE, HTTP, and
    // WebSocket transports", and `mcp.md:147` gives `ws` the same `url`,
    // `headers`, `timeout` and `alwaysLoad` fields as `http`. `mcp.md:83`:
    // JSON configs accept `streamable-http` as an alias for `http` — folded
    // above, because `??` cannot fall through a non-null string, so the alias
    // would otherwise block the `url ? 'http'` fallback and lose the server.
    //
    // The `.mcp.json` reader builds `ws` servers, the pool connects them, and
    // the secret-free projection now carries the transport, so plugin import
    // carries it too. Headers ride the descriptor; the SDK's WebSocket client
    // does not send them yet, which the pool warns about at connect time.
    const transport = rawTransport === 'stdio' || rawTransport === 'http' || rawTransport === 'sse' || rawTransport === 'ws'
      ? rawTransport
      : undefined;
    if (!transport) {
      diagnostics.push(incompleteClaudeCapability('mcp', `${mcpPath}.${serverName}`, 'Claude MCP server requires a command (stdio) or url (http/sse/ws).'));
      continue;
    }
    // `mcp.md:768`: `headersHelper` generates dynamic connection headers.
    // Documented on http/sse (`mcp.md:765-785`) and `ws` (`mcp.md:147`), and
    // now implemented end-to-end: carried on the descriptor, plugin path
    // placeholders substitute into it (`mcp.md:327`), and the pool runs it per
    // connect attempt.
    const rawHeadersHelper = stringField(rawServer, 'headersHelper');
    // `mcp.md:818`: a plugin `headersHelper` may NOT reference
    // `${user_config.*}`, "because the command runs through a shell" — the
    // server is reported as misconfigured with an ERROR and the value is never
    // substituted. Mirrors the shell-form hook refusal
    // (`plugin.format.claude_hook_user_config_shell_form`), and like it, this
    // runs on the command template, before any value is configured.
    if (rawHeadersHelper && CLAUDE_USER_CONFIG_REFERENCE.test(rawHeadersHelper)) {
      diagnostics.push(pluginDiagnostic(
        'error',
        'plugin.format.claude_mcp_headers_helper_user_config',
        `Claude MCP server "${serverName}" references \${user_config.*} in headersHelper, which runs through a shell. `
          + `Put \${user_config.KEY} in the server's headers field instead, which isn't shell-parsed, or have the `
          + 'helper script read the value from its own environment or a config file.',
        `${mcpPath}.${serverName}.headersHelper`,
        { kind: 'mcp', serverName },
      ));
      continue;
    }
    const headersHelper = rawHeadersHelper ? rewriteClaudeTokens(rawHeadersHelper) : undefined;
    const displayName = stringField(rawServer, 'displayName') ?? stringField(rawServer, 'name');
    const description = stringField(rawServer, 'description');
    const command = stringField(rawServer, 'command');
    const normalizedCommand = command ? rewriteClaudeTokens(command) : undefined;
    const args = readStringArray(rawServer.args);
    const cwd = stringField(rawServer, 'cwd') ? rewriteClaudeTokens(stringField(rawServer, 'cwd')!) : undefined;
    if (cwd) {
      const cwdError = validatePluginMcpCwd(cwd);
      if (cwdError) {
        diagnostics.push(incompleteClaudeCapability(
          'mcp',
          `${mcpPath}.${serverName}.cwd`,
          `Claude MCP cwd is invalid: ${cwdError}`,
        ));
        deferred.push({ externalKind: 'mcp', reasonCode: 'plugin.deferred.claude_mcp_invalid_cwd' });
        continue;
      }
    }
    const url = stringField(rawServer, 'url');
    const toolTimeoutMs = mcpToolTimeoutMs(rawServer.timeout);
    const env = isStringRecord(rawServer.env) ? rewriteClaudeTokensInRecord(rawServer.env) : undefined;
    const headers = isStringRecord(rawServer.headers) ? rewriteClaudeTokensInRecord(rawServer.headers) : undefined;
    // The owner's literal complaint (plugin-install plan § 0.5): a Claude
    // plugin's remote MCP server had NO auth path — `kind:'mcp'` passthrough
    // meant a missing credential silently omitted the server from the pool, and
    // hand-creating a Source was the only way to reach the OAuth flow. An
    // http/sse entry that DECLARES OAuth (the documented `.mcp.json` `oauth`
    // object, `mcp.md:715`, or an explicit RFC 8707/9728 `oauthResource`) is
    // therefore promoted to a connector — the same shape `codex.ts` builds from
    // `oauth_resource` — so it materializes as an MCP-backed Source with the
    // existing server-owned OAuth path. Mirrors are deliberate:
    // `ON_FIRST_USE` timing (codex.ts) and no static header/env carve-out — an
    // entry with headers or env keeps its reviewed auth binding and stays a
    // supervised `kind:'mcp'` capability, exactly like a Codex
    // `bearer_token_env_var` server. Zero-auth remote entries (context7-style)
    // are NOT promoted: they serve tools with no credential and no Source.
    const oauthConfig = isRecord(rawServer.oauth) ? rawServer.oauth : undefined;
    const oauthResource = stringField(rawServer, 'oauthResource')
      ?? (oauthConfig ? stringField(oauthConfig, 'oauthResource') : undefined);
    if ((transport === 'http' || transport === 'sse') && url
      && (oauthConfig !== undefined || oauthResource !== undefined)
      // A `headersHelper` entry stays a supervised `kind:'mcp'` capability like
      // a headers/env one: the connector shape carries no helper command, so
      // promotion would silently drop the server's declared auth mechanism.
      && !headers && !env && !headersHelper) {
      const clientId = stringField(rawServer, 'clientId')
        ?? (oauthConfig ? stringField(oauthConfig, 'clientId') : undefined);
      connectors.push({
        id: serverName,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        mcpServers: [{
          serverName,
          transport,
          url: rewriteClaudeTokens(url),
          ...(oauthResource ? { oauthResource: rewriteClaudeTokens(oauthResource) } : {}),
          ...(clientId ? { clientId } : {}),
          ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
        }],
        auth: { type: 'oauth', timing: 'ON_FIRST_USE' },
      });
      continue;
    }
    const commandQualification = transport === 'stdio' && normalizedCommand
      ? qualifyPluginStdioCommand(normalizedCommand, rootDirectory)
      : undefined;
    if (commandQualification && !commandQualification.ok) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_mcp_command_unavailable',
        `Claude MCP server "${serverName}" command is not an approved host runtime or executable bundle file and will remain unavailable.`,
        `${mcpPath}.${serverName}.command`,
        { kind: 'mcp', serverName },
      ));
      deferred.push({ externalKind: 'mcp', reasonCode: 'plugin.deferred.claude_mcp_command_unavailable' });
      continue;
    }
    if (commandQualification?.kind === 'host'
      && (commandQualification.runtime === 'npx' || commandQualification.runtime === 'bunx')
      && !hasMaterializablePluginPackageRunner(rootDirectory, args ?? [])) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_mcp_command_unavailable',
        `Claude MCP server "${serverName}" uses ${commandQualification.runtime} without a bundle-local materialized or locked dependency and will remain unavailable.`,
        `${mcpPath}.${serverName}.command`,
        { kind: 'mcp', serverName },
      ));
      deferred.push({ externalKind: 'mcp', reasonCode: 'plugin.deferred.claude_mcp_command_unavailable' });
      continue;
    }
    capabilities.push({
      kind: 'mcp',
      id: createPluginCapabilityId('mcp', serverName),
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      mcp: {
        serverName,
        transport,
        ...(normalizedCommand
          ? {
              command: commandQualification?.kind === 'bundle'
                ? commandQualification.command
                : normalizedCommand,
            }
          : {}),
        ...(args ? { args: args.map(rewriteClaudeTokens) } : {}),
        ...(cwd ? { cwd } : {}),
        ...(url ? { url: rewriteClaudeTokens(url) } : {}),
        ...(env ? { env } : {}),
        ...(headers ? { headers } : {}),
        // `mcp.md:327` names `headersHelper` beside `url` and `headers` as a
        // plugin path-placeholder substitution location; the Claude tokens were
        // rewritten to Nessy spellings above, exactly like those two.
        ...(headersHelper && transport !== 'stdio' ? { headersHelper } : {}),
        // Documented on every Claude server type: pin this server's tools past
        // tool search. Dropping it let deferral hide a server the plugin author
        // marked as always needed.
        ...(rawServer.alwaysLoad === true ? { alwaysLoad: true } : {}),
        // Documented `.mcp.json` field, and a plugin's MCP config IS a
        // `.mcp.json` in "standard MCP server configuration" format
        // (plugins/manifest-reference.md#mcpservers): "a per-server tool execution timeout
        // by adding a `timeout` field in milliseconds" (mcp.md:238). The floor
        // is documented too — "Values below 1000 are ignored and fall through
        // to `MCP_TOOL_TIMEOUT`" (mcp.md:243) — which `mcpToolTimeoutMs`
        // already applies for the non-plugin reader.
        ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
      },
    });
  }
}

// --- hooks -------------------------------------------------------------------

/**
 * UB12.95 — a Claude Code MOD is declared in the hooks file, and no runtime here runs one.
 *
 * Claude's mods pages (the `#### Mods` group of `llms.txt`, read 2026-10-17). `plugins/mods/create`:
 * "When Claude Code loads a plugin, it reads the plugin's `hooks/hooks.json`. The `modules` key in that
 * file gives the path to your code, and having it is what makes the plugin a mod." The mods reference's
 * Files table: "`modules`: an array with one path, relative to this file, to the hooks module, as in
 * `"modules": ["./register.js"]`. Can also hold settings hooks under `hooks`." The hooks module exports
 * `register(on, options)` and runs INSIDE Claude Code, against Claude Code's own mods API.
 *
 * The reader below took `hooks` when present and the whole object otherwise, so a mod's file was misread
 * both ways: `{ "modules": [...] }` alone became an event NAMED `modules` and drew "Claude hook entry must
 * be an object." per path, and beside `hooks` the key vanished with no record, the bundle reporting
 * `supported` while its one component never ran (measured at `4c559c485` with the adapter on both shapes).
 *
 * So it is a recorded deferral on all three runtimes, and the author is told:
 * - Pi and codex: the mods API is Claude Code's own TypeScript surface (the reference names
 *   `mods/types/claude-code.d.ts` as its complete form); neither runtime has a counterpart.
 * - Claude: the overview's "Where mods run" table says a mod's hooks run under `claude -p` and the Agent
 *   SDK (nothing it draws appears there), but this runtime hands the SDK `plugins: []` (`claude-agent.ts`,
 *   the C3.188 note above that option), so no bundle reaches the loader; and the vendored CLI self-reports
 *   2.1.280, below the overview's "Mods are on by default. In the terminal, use Claude Code v2.1.287 or
 *   later". A native route (a lift past 2.1.287 plus C3.188's synthesized plugin directory) is its own row.
 *
 * One `mod` record per bundle. The settings hooks beside `modules` still load: the key is stripped from
 * the event map ({@link withoutClaudeModModules}), never read as an event. The manifest's `types` field
 * (the mod's `.d.ts`) is NOT the marker; the note beside `CLAUDE_RETAINED_SURFACE_FIELDS` says why it is
 * not read.
 */
const CLAUDE_MOD_MODULES_KEY = 'modules';

function addClaudeModDeferral(
  sources: ReadonlyArray<{ label: string; source: unknown }>,
  deferred: PluginCompatibilityReport['deferred'],
  diagnostics: PluginDiagnostic[],
): void {
  const declaring = sources.find(({ source }) => isRecord(source) && source[CLAUDE_MOD_MODULES_KEY] !== undefined);
  if (!declaring || deferred.some(entry => entry.externalKind === 'mod')) return;
  deferred.push({ externalKind: 'mod', reasonCode: 'plugin.deferred.claude_mod', sourcePath: declaring.label });
  // `warning`, as for a refused theme or channel declaration: the rest of the bundle is fine and installs.
  diagnostics.push(pluginDiagnostic(
    'warning',
    'plugin.format.claude_mod_unsupported',
    'Claude Code mods are not loaded. This hooks file names a hooks module under `modules`, which makes the'
      + ' plugin a mod: event handlers that run inside Claude Code against its mods API (Claude\'s mods'
      + ' reference, section "Files"). No Nessy runtime offers that API, so the module never runs; the'
      + " plugin's other components, and any settings hooks under `hooks` in the same file, install as usual.",
    `${declaring.label}.${CLAUDE_MOD_MODULES_KEY}`,
    { kind: 'mod' },
  ));
}

/** The event map without a mod's `modules` key, which is never a hook event name. */
function withoutClaudeModModules(value: unknown): unknown {
  if (!isRecord(value) || value[CLAUDE_MOD_MODULES_KEY] === undefined) return value;
  const { [CLAUDE_MOD_MODULES_KEY]: _modules, ...events } = value;
  return events;
}

async function normalizeClaudeHooks(
  rootDirectory: string,
  declared: ClaudeComponentPathResolution,
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
  pluginLabel: string,
  mcpHookScope: ClaudeMcpToolHookScope,
  entryHooks?: UnknownRecord,
): Promise<PluginCapability[]> {
  const collected = await collectClaudeConfigSources(rootDirectory, declared,
    CLAUDE_DEFAULT_HOOKS_FILE, { kind: 'hook', fieldLabel: 'hooks', fileLabel: 'hooks' }, diagnostics);
  // UB12.95 — read BEFORE the entry replacement below, which rebuilds a source from its `hooks` map alone.
  addClaudeModDeferral(collected, deferred, diagnostics);
  // F1.1035 — an inline `hooks` map on a marketplace entry over a `plugin.json`
  // replaces, event by event, the matchers every other source declared (the
  // default file and the manifest's own); events the entry leaves out keep
  // theirs. See `claudeEntryHooksReplacePerEvent` at the file end.
  const sources = claudeEntryHooksReplacePerEvent(collected, entryHooks);
  const capabilities: PluginCapability[] = [];
  // Group indices run ACROSS sources, so a second source's first `PostToolUse`
  // group cannot generate the default id the first source already used. With a
  // single source (the default file alone) the ids are unchanged.
  const groupIndexByEvent = new Map<string, number>();
  for (const { label: hooksPath, source: parsed } of sources) {
    const hookMap = isRecord(parsed) && isRecord(parsed.hooks) ? parsed.hooks : withoutClaudeModModules(parsed);
    if (!isRecord(hookMap)) {
      diagnostics.push(incompleteClaudeCapability('hook', hooksPath, 'Claude hooks.json must be an object keyed by event name.'));
      continue;
    }
    for (const [eventName, rawEntries] of Object.entries(hookMap)) {
      const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
      entries.forEach(entry => {
        const index = groupIndexByEvent.get(eventName) ?? 0;
        groupIndexByEvent.set(eventName, index + 1);
        const basePath = `${hooksPath}.${eventName}.${index}`;
        if (!isRecord(entry)) {
          diagnostics.push(incompleteClaudeCapability('hook', basePath, 'Claude hook entry must be an object.'));
          return;
        }
        const groupMatcher = stringField(entry, 'matcher');
        const groupedHooks = Array.isArray(entry.hooks) ? entry.hooks : [entry];
        groupedHooks.forEach((hookEntry, hookIndex) => {
          normalizeClaudeHookEntry({
            entry: hookEntry,
            eventName,
            diagnostics,
            deferred,
            capabilities,
            diagnosticPath: `${basePath}.hooks.${hookIndex}`,
            defaultId: `${eventName}-${index}-${hookIndex}`,
            pluginLabel,
            mcpHookScope,
            matcher: groupMatcher,
          });
        });
      });
    }
  }
  return capabilities;
}

/**
 * Collect every configuration source for one of `:638`'s "own merge rules"
 * fields (`hooks`, `mcpServers`, `lspServers`).
 *
 * Nothing in the docs states a REPLACES rule for these three — the component
 * sections give one location pair each ("… in plugin root, or inline in
 * plugin.json") and `:638` defers to them — so a declared path or inline object
 * loads ALONGSIDE the plugin-root default rather than displacing it. The default
 * is skipped only when a declared path already named that same file, which would
 * otherwise read it twice. This is the LSP reader's rule verbatim; it is the
 * positive control that inline reading works on this surface.
 */
async function collectClaudeConfigSources(
  rootDirectory: string,
  declared: ManifestComponentPathResolution,
  defaultPath: string,
  labels: { kind: string; fieldLabel: string; fileLabel: string },
  diagnostics: PluginDiagnostic[],
): Promise<Array<{ label: string; source: unknown }>> {
  const sources: Array<{ label: string; source: unknown }> = [];
  for (const entry of declared.paths) {
    const parsed = await readClaudeJsonConfigFile(rootDirectory, entry.path, labels, diagnostics);
    if (parsed !== undefined) sources.push({ label: entry.path, source: parsed });
  }
  if (declared.inline !== undefined) sources.push({ label: labels.fieldLabel, source: declared.inline });
  if (!declared.paths.some(entry => entry.path === defaultPath)
    && existsSync(join(rootDirectory, defaultPath))) {
    const parsed = await readClaudeJsonConfigFile(rootDirectory, defaultPath, labels, diagnostics);
    if (parsed !== undefined) sources.push({ label: defaultPath, source: parsed });
  }
  return sources;
}

/**
 * UB12.94 — what an `mcp_tool` hook in the bundle being imported can address. `pluginNames` holds the spellings a
 * `plugin:<plugin-name>:<server-name>` reference may use for THIS plugin: Claude's manifest `name`, the marketplace
 * entry's `name`, and our manifest id, which is that same `name` unless the bundle declares an `id` of its own.
 * `pluginId` is the id the resolver mints this plugin's server wire names from; `serverNames` are the servers this
 * adapter imported.
 */
interface ClaudeMcpToolHookScope {
  pluginNames: ReadonlySet<string>;
  pluginId: string;
  serverNames: ReadonlySet<string>;
}

type ClaudeMcpToolHookTarget =
  | { mcpTool: string }
  | { problem: 'missing-tool' }
  | { problem: 'unaddressable'; message: string; server?: string };

/**
 * The only shape the host executor runs an `mcp_tool` action under (`isQualifiedPluginMcpProxyName` in
 * `plugins/hooks-automation.ts`, which drops any other name without a notice), so a name outside it is refused
 * here, at import, where the author is told.
 */
const CLAUDE_MCP_HOOK_PROXY_NAME = /^mcp__[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/;

/**
 * UB12.94 — the proxy name an `mcp_tool` hook calls.
 *
 * hooks.md#mcp-tool-hook-fields defines the target as a PAIR: `server`, "Name of a configured MCP server. For a
 * plugin-bundled server, this is the scoped name `plugin:<plugin-name>:<server-name>`, such as `plugin:my-plugin:db`,
 * not the bare server key", and `tool`, "Name of the tool to call on that server". This adapter used to read only our
 * own qualified `mcpTool` (with `tool` as its alias), so the documented pair reached schema.ts as a bare tool name and
 * its `plugin.hook.invalid_mcp_tool` ERROR refused the whole plugin.
 *
 * The host runs the hook by looking that name up in the session's MCP pool (`pluginMcpToolHookRunner` in
 * `server-core/src/sessions/SessionManager.ts`; an absent name is the page's non-blocking error), so the pair becomes
 * the name the pool registers:
 *  - `plugin:<this plugin>:<server>` → that server's wire name, `pluginMcpWireName(<manifest id>, <server>)`, the one
 *    the resolver mints for it. A `<server>` this plugin did not import is refused here, for this hook only.
 *  - `plugin:<another plugin>:<server>` → the same mint over `<another plugin>` (a Claude plugin's id is its `name`).
 *    Whether that plugin is installed and enabled is known only in the session, where an absent server is the page's
 *    non-blocking error.
 *  - a bare name → itself: a configured server is a source, whose pool name is its slug. The resolver's
 *    compatibility pass (`translatePluginMcpToolName`) still routes a bare name equal to one of this plugin's OWN
 *    server keys to that server, which the page says a bare key never reaches (recorded as a deviation, UB12.94).
 * Without `server`, our own earlier shape stands: an already-qualified `mcpTool`, `tool` and `name` as its aliases.
 */
function resolveClaudeMcpToolHookTarget(entry: UnknownRecord, scope: ClaudeMcpToolHookScope): ClaudeMcpToolHookTarget {
  const server = stringField(entry, 'server');
  if (server === undefined) {
    const mcpTool = stringField(entry, 'mcpTool') ?? stringField(entry, 'tool') ?? stringField(entry, 'name');
    if (!mcpTool) return { problem: 'missing-tool' };
    return CLAUDE_MCP_HOOK_PROXY_NAME.test(mcpTool)
      ? { mcpTool }
      : {
          problem: 'unaddressable',
          message: `Claude mcp_tool hook names "${mcpTool}", which is not a qualified MCP tool name (mcp__<server>__<tool>); declare "server" and "tool" instead.`,
        };
  }
  const tool = stringField(entry, 'tool');
  if (!tool) return { problem: 'missing-tool' };
  let serverWireName: string;
  const scoped = /^plugin:([^:]+):(.+)$/.exec(server);
  if (scoped) {
    const pluginName = scoped[1]!;
    const serverName = scoped[2]!;
    if (scope.pluginNames.has(pluginName)) {
      if (!scope.serverNames.has(serverName)) {
        return {
          problem: 'unaddressable',
          server,
          message: `Claude mcp_tool hook names server "${server}", but this plugin imported no MCP server "${serverName}", so the hook could never run.`,
        };
      }
      serverWireName = pluginMcpWireName(scope.pluginId, serverName);
    } else {
      serverWireName = pluginMcpWireName(pluginName, serverName);
    }
  } else if (server.startsWith('plugin:')) {
    return {
      problem: 'unaddressable',
      server,
      message: `Claude mcp_tool hook server "${server}" is not a scoped plugin server name (plugin:<plugin-name>:<server-name>).`,
    };
  } else {
    serverWireName = server;
  }
  const mcpTool = claudeMcpHookProxyName(serverWireName, tool);
  return CLAUDE_MCP_HOOK_PROXY_NAME.test(mcpTool)
    ? { mcpTool }
    : {
        problem: 'unaddressable',
        server,
        message: `Claude mcp_tool hook server "${server}" is not a name a session MCP server can carry, so the hook could never run.`,
      };
}

/**
 * The pool's proxy spelling of (server wire name, tool): `buildPoolProxyBaseName` in `mcp/mcp-pool.ts`, restated
 * because that module's import graph is the MCP client stack; `claude-mcp-tool-hook-shape.test.ts` pins the two
 * together. The tool segment takes mcp.md's callable-name rule ("any character outside `A-Z`, `a-z`, `0-9`, `_`, and
 * `-` is replaced with `_`") and the pool's 64-character cap. Not modelled: the suffix the pool adds when two tools
 * of one server sanitize to the same name.
 */
function claudeMcpHookProxyName(serverWireName: string, tool: string): string {
  const prefix = `mcp__${serverWireName}__`;
  const toolSegment = tool.replace(/[^A-Za-z0-9_-]/g, '_');
  if (prefix.length + toolSegment.length <= 64) return `${prefix}${toolSegment}`;
  return `${prefix}${capMcpNameSegment(toolSegment, Math.max(8, 64 - prefix.length))}`;
}

/** hooks.md#mcp-tool-hook-fields `input`: a `${path}` placeholder such as `"${tool_input.file_path}"`, at any depth. */
function containsClaudeHookInputPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return /\$\{[^}]+\}/.test(value);
  if (Array.isArray(value)) return value.some(containsClaudeHookInputPlaceholder);
  return isRecord(value) && Object.values(value).some(containsClaudeHookInputPlaceholder);
}

function normalizeClaudeHookEntry(options: {
  entry: unknown;
  eventName: string;
  diagnostics: PluginDiagnostic[];
  deferred: PluginCompatibilityReport['deferred'];
  capabilities: PluginCapability[];
  diagnosticPath: string;
  defaultId: string;
  matcher?: string;
  pluginLabel: string;
  mcpHookScope: ClaudeMcpToolHookScope;
}): void {
  const { entry, eventName, diagnostics, deferred, capabilities, diagnosticPath, defaultId, matcher, pluginLabel, mcpHookScope } = options;
  if (!isRecord(entry)) {
    diagnostics.push(incompleteClaudeCapability('hook', diagnosticPath, 'Claude hook entry must be an object.'));
    return;
  }
  const rawHookType = stringField(entry, 'type') ?? (stringField(entry, 'command') ? 'command' : undefined);
  // Claude's `mcp_tool` hook type maps onto the Nessy `mcp` runtime kind.
  const hookType = rawHookType === 'mcp_tool' ? 'mcp' : rawHookType;
  if (!hookType) {
    diagnostics.push(incompleteClaudeCapability('hook', diagnosticPath, 'Claude hook entry requires a type.'));
    return;
  }
  if (hookType !== 'command' && hookType !== 'prompt' && hookType !== 'agent'
    && hookType !== 'mcp' && hookType !== 'http') {
    // An unknown hook type is imported as a deferred report entry only
    // (no sourcePath), never an executable capability.
    deferred.push({
      externalKind: `hook-type-${rawHookType}`,
      reasonCode: `plugin.deferred.claude_hook_type_${rawHookType}`,
    });
    return;
  }
  const mapped = mapExternalHookEventName(eventName, 'claude');
  diagnostics.push(...mapped.diagnostics);
  if (!mapped.event) {
    const externalKind = `hook-event-${eventName}`;
    // A documented event we deliberately do not emit carries its own routed
    // reason code (`TeammateIdle` → R23, `Setup` → R73) so the author sees WHY
    // it will never fire; anything else is the generic unsupported report.
    const reasonCode = mapped.deferredReasonCode ?? 'plugin.deferred.claude_hook_event_unsupported';
    if (!deferred.some(entry => entry.externalKind === externalKind && entry.reasonCode === reasonCode)) {
      deferred.push({ externalKind, reasonCode });
    }
    return;
  }
  // hooks.md: "SessionStart and Setup support command and mcp_tool hooks. They
  // don't support http, prompt, or agent hooks." Claude never runs these; import
  // them as report entries only so the author sees why nothing fired.
  if (CLAUDE_RESTRICTED_LIFECYCLE_EVENTS.has(mapped.event) && hookType !== 'command' && hookType !== 'mcp') {
    deferred.push({
      externalKind: `hook-type-${hookType}-on-${mapped.event}`,
      reasonCode: 'plugin.deferred.claude_hook_type_unsupported_event',
    });
    return;
  }
  const id = stringField(entry, 'id') ?? stringField(entry, 'name') ?? defaultId;

  // R22 common fields (hooks.md): `asyncRewake` implies `async` (background,
  // never decision-bearing; command hooks only). `once` and `if` are stored on
  // every type; their runtime halves are recorded as deferral diagnostics.
  const asyncRewake = entry.asyncRewake === true;
  const asyncFlag = entry.async === true || asyncRewake;
  const once = entry.once === true;
  const ifRule = stringField(entry, 'if');
  // hooks.md § Common fields: `timeout` is in SECONDS and applies to all five
  // hook types, not just `command`. The reader used to be `entry.timeoutMs`
  // inside the command branch alone — a key hooks.md never names, in the wrong
  // unit — so every imported hook silently fell back to a default.
  const timeoutMs = readExternalHookTimeoutMs(entry);
  // `statusMessage` is a common field too — it was read in the command branch
  // only, so a prompt/agent/mcp/http hook could never label the spinner.
  const statusMessage = stringField(entry, 'statusMessage');
  const commonFields = {
    ...(once ? { once: true } : {}),
    ...(ifRule ? { ifRule } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(statusMessage ? { statusMessage } : {}),
  };

  // B1: prompt hooks inject a one-shot body; agent hooks name a sub-agent.
  if (hookType === 'prompt') {
    const prompt = stringField(entry, 'prompt') ?? stringField(entry, 'body');
    if (!prompt) {
      diagnostics.push(incompleteClaudeCapability('hook', diagnosticPath, 'Claude prompt hook requires prompt text.'));
      return;
    }
    // hooks.md prompt-hook fields: `model` (fast Claude model, Haiku default)
    // and `continueOnBlock` (maps to continue:true on the resulting block).
    const promptModel = stringField(entry, 'model');
    const continueOnBlock = entry.continueOnBlock === true;
    capabilities.push({
      kind: 'hook',
      id: createPluginCapabilityId('hook', id),
      hook: {
        id,
        event: mapped.event,
        type: 'prompt',
        ...(matcher ? { matcher } : {}),
        prompt: rewriteClaudeTokens(prompt),
        ...(promptModel ? { model: promptModel } : {}),
        ...(continueOnBlock ? { continueOnBlock: true } : {}),
        ...commonFields,
      },
    });
    return;
  }
  if (hookType === 'agent') {
    // hooks.md § Prompt and agent hook fields: an agent hook's ONE required
    // field is `prompt`, the same as a prompt hook — "Set `type` to `"agent"`
    // and provide a `prompt` string". There is no `agent` or `agentName` key
    // anywhere in the format. Demanding one rejected every conformant agent hook
    // at import with a diagnostic naming a key its author could not supply.
    //
    // `name` is deliberately NOT consulted here: it is read above as the hook's
    // ID, so an agent hook that merely names itself would have been imported as
    // a request to spawn a subagent by that name.
    const agentName = stringField(entry, 'agent') ?? stringField(entry, 'agentName');
    if (!agentName) {
      // hooks.md § Agent-based hooks: the type "spawns a subagent that can read
      // files, search code, and inspect the codebase to verify conditions", and
      // is "useful when verification requires inspecting actual files or test
      // output, not just evaluating the hook input data alone". Nessy has no
      // decision-bearing tool-using verifier to map that onto. Routing the
      // prompt through the single-turn prompt-hook judge would decide from the
      // hook input alone — the one thing the page says an agent hook exists NOT
      // to do — and a wrong `ok: true` from a degraded verifier is worse than no
      // verifier at all. So the documented shape is a RECORDED deferral carrying
      // a reason the author can act on, not an import failure.
      const externalKind = `hook-type-agent-on-${mapped.event}`;
      const reasonCode = 'plugin.deferred.claude_hook_type_agent_experimental';
      if (!deferred.some(record => record.externalKind === externalKind && record.reasonCode === reasonCode)) {
        deferred.push({ externalKind, reasonCode });
      }
      return;
    }
    capabilities.push({
      kind: 'hook',
      id: createPluginCapabilityId('hook', id),
      hook: {
        id,
        event: mapped.event,
        type: 'agent',
        ...(matcher ? { matcher } : {}),
        agentName,
        ...commonFields,
      },
    });
    return;
  }

  // B2: mcp_tool hooks invoke a qualified MCP proxy tool; http hooks fire a
  // bounded request under the network permission contract.
  if (hookType === 'mcp') {
    const target = resolveClaudeMcpToolHookTarget(entry, mcpHookScope);
    if ('problem' in target) {
      // UB12.94 — ONE hook is refused, never the plugin: the same warning tier as every other hook this adapter
      // cannot carry. An unaddressable name used to reach schema.ts, whose ERROR refused the whole bundle.
      diagnostics.push(target.problem === 'missing-tool'
        ? incompleteClaudeCapability('hook', diagnosticPath, 'Claude mcp_tool hook requires a tool name.')
        : pluginDiagnostic(
            'warning',
            'plugin.format.claude_hook_mcp_tool_unaddressable',
            target.message,
            diagnosticPath,
            { kind: 'hook', ...(target.server ? { server: target.server } : {}) },
          ));
      return;
    }
    const { mcpTool } = target;
    // hooks.md#mcp-tool-hook-fields `input`: "Arguments passed to the tool". `args` is our earlier spelling and stays
    // an alias; the documented field wins when a hook carries both.
    const mcpArgs = isRecord(entry.input) ? entry.input as Record<string, unknown> : (isRecord(entry.args) ? entry.args as Record<string, unknown> : undefined);
    // The same row continues: "String values support `${path}` substitution from the hook's JSON input". The host
    // executor sends `mcpArgs` verbatim, so a placeholder would reach the tool as literal text — a call made with
    // arguments known to be wrong. Recorded as a deferral with its reason instead (UB12.94), the shape the agent hook
    // above takes for the same reason; a hook with plain arguments imports and runs.
    if (mcpArgs && containsClaudeHookInputPlaceholder(mcpArgs)) {
      const externalKind = `hook-mcp_tool-input-substitution-on-${mapped.event}`;
      const reasonCode = 'plugin.deferred.claude_hook_mcp_tool_input_substitution';
      if (!deferred.some(record => record.externalKind === externalKind && record.reasonCode === reasonCode)) {
        deferred.push({ externalKind, reasonCode });
      }
      return;
    }
    capabilities.push({
      kind: 'hook',
      id: createPluginCapabilityId('hook', id),
      hook: {
        id,
        event: mapped.event,
        type: 'mcp',
        ...(matcher ? { matcher } : {}),
        mcpTool,
        ...(mcpArgs ? { mcpArgs } : {}),
        ...commonFields,
      },
    });
    return;
  }
  if (hookType === 'http') {
    const httpRecord = isRecord(entry.http) ? entry.http : entry;
    const url = stringField(httpRecord, 'url');
    if (!url) {
      diagnostics.push(incompleteClaudeCapability('hook', diagnosticPath, 'Claude http hook requires an http url.'));
      return;
    }
    const rawMethod = stringField(httpRecord, 'method')?.toUpperCase();
    const method = rawMethod === 'GET' || rawMethod === 'POST' || rawMethod === 'PUT' || rawMethod === 'PATCH' || rawMethod === 'DELETE' ? rawMethod : undefined;
    const headers = isStringRecord(httpRecord.headers) ? rewriteClaudeTokensInRecord(httpRecord.headers) : undefined;
    // hooks.md http field `allowedEnvVars`: header env-interpolation allowlist.
    const allowedEnvVars = readStringArray(httpRecord.allowedEnvVars);
    const onFailure = readClaudeHookOnFailure(entry, 'http', diagnostics, diagnosticPath);
    if (onFailure === null) return;
    capabilities.push({
      kind: 'hook',
      id: createPluginCapabilityId('hook', id),
      hook: {
        id,
        event: mapped.event,
        type: 'http',
        ...(matcher ? { matcher } : {}),
        http: {
          url: rewriteClaudeTokens(url),
          ...(method ? { method } : {}),
          ...(headers ? { headers } : {}),
          ...(httpRecord.body !== undefined ? { body: httpRecord.body } : {}),
          ...(allowedEnvVars && allowedEnvVars.length > 0 ? { allowedEnvVars } : {}),
        },
        ...(onFailure ? { onFailure } : {}),
        ...commonFields,
      },
    });
    return;
  }

  const command = stringField(entry, 'command');
  if (!command) {
    diagnostics.push(incompleteClaudeCapability('hook', diagnosticPath, 'Claude command hook requires command.'));
    return;
  }
  const cwd = stringField(entry, 'cwd');
  const normalizedCwd = cwd ? normalizeClaudeRelativePath(cwd, diagnostics, `${diagnosticPath}.cwd`, { allowDirectory: true }) : undefined;
  if (cwd && !normalizedCwd) return;
  const argsVector = readHookArgsVector(entry.args);
  if (argsVector.invalid) {
    diagnostics.push(incompleteClaudeCapability('hook', `${diagnosticPath}.args`, 'Claude command hook args must be a list of strings.'));
    return;
  }
  // `plugins/manifest-reference.md#environment-variables` and `errors.md:1367`: a shell-form command
  // that references `${user_config.*}` is REFUSED rather than substituted,
  // because "a configured value containing `$(...)`, backticks, or `;` would run
  // as code there". `:1367` also settles when the check runs — "The check runs on
  // the command template, so the error appears even when no value is configured
  // yet" — which makes it a parse-time check, and it lands before any
  // substitution engine exists rather than after.
  //
  // Exec form (`args` present) is exempt by the same sentence: `:583`'s
  // alternative IS exec form, where each reference becomes one argument with no
  // shell in between.
  if (!argsVector.args && CLAUDE_USER_CONFIG_REFERENCE.test(command)) {
    diagnostics.push(pluginDiagnostic(
      'error',
      'plugin.format.claude_hook_user_config_shell_form',
      // `errors.md:1372` gives the wording verbatim.
      `Hook from plugin ${pluginLabel} references \${user_config.*} in a shell-form command. `
        + 'The substituted value would be re-parsed by the shell. Use exec form instead — '
        + '{"command": "<executable>", "args": ["${user_config.KEY}", ...]} — or read '
        + `$CLAUDE_PLUGIN_OPTION_<KEY> from the hook's environment. Command: ${command}`,
      diagnosticPath,
    ));
    return;
  }
  // hooks.md § Command hook fields, `shell`: "Shell to use for this hook.
  // Accepts `"bash"` or `"powershell"`. Defaults to `"bash"`, or to
  // `"powershell"` on Windows when Git Bash isn't installed. ... Ignored when
  // `args` is set". Anything outside the two documented values is refused with
  // a diagnostic — a silent platform default would run the command under a
  // shell the author never chose.
  const shell = entry.shell;
  if (shell !== undefined && shell !== 'bash' && shell !== 'powershell') {
    diagnostics.push(incompleteClaudeCapability('hook', `${diagnosticPath}.shell`, `Claude command hook shell must be "bash" or "powershell", not ${JSON.stringify(shell)}.`));
    return;
  }
  const onFailure = readClaudeHookOnFailure(entry, 'command', diagnostics, diagnosticPath);
  if (onFailure === null) return;
  capabilities.push({
    kind: 'hook',
    id: createPluginCapabilityId('hook', id),
    hook: {
      id,
      event: mapped.event,
      type: 'command',
      ...(matcher ? { matcher } : {}),
      ...(shell ? { shell } : {}),
      command: rewriteClaudeTokens(command),
      // hooks.md: path placeholders "are substituted into `command` and into
      // each `args` element as plain strings" in exec form.
      ...(argsVector.args ? { args: argsVector.args.map(rewriteClaudeTokens) } : {}),
      ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
      // `async`/`asyncRewake` are command-only (hooks.md: "Background execution
      // is command-only"); the other four type branches carry once/ifRule only.
      ...(asyncFlag ? { async: true } : {}),
      ...(asyncRewake ? { asyncRewake: true } : {}),
      // hooks.md § Exit code output is a CLAUDE contract: a hook authored
      // against it uses exit 2 to block and treats every other non-zero as a
      // non-blocking error. Only hooks imported from a Claude bundle carry it —
      // Codex and native `nessy-plugin.json` command hooks keep the Nessy
      // default where ANY non-zero blocks. Exit codes exist only for command
      // hooks, so no other type branch declares it.
      exitCodeContract: 'claude-three-way' as const,
      ...(onFailure ? { onFailure } : {}),
      ...commonFields,
    },
  });
}

/**
 * UB12.67 — `hooks.md#command-hook-fields` and `#http-hook-fields`, the
 * `onFailure` row (curl'd 2026-10-16), verbatim: "What happens to the action
 * when the hook fails: `"continue"`, the default, or `"block"`." Read on those
 * two types only, the two the page gives it to.
 *
 * Another value is refused with a diagnostic, as `shell`'s is: the author of a
 * policy hook who typed `"Block"` meant to fail closed, and reading the typo as
 * the default would fail open with nothing said. `null` = refused; `undefined`
 * = the default, which is not stored.
 */
function readClaudeHookOnFailure(
  entry: Record<string, unknown>,
  hookType: 'command' | 'http',
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
): 'block' | undefined | null {
  const value = entry.onFailure;
  if (value === undefined || value === 'continue') return undefined;
  if (value === 'block') return 'block';
  diagnostics.push(incompleteClaudeCapability('hook', `${diagnosticPath}.onFailure`, `Claude ${hookType} hook onFailure must be "continue" or "block", not ${JSON.stringify(value)}.`));
  return null;
}

// --- dependencies (B1e) ------------------------------------------------------

/**
 * `plugin-dependencies.md` — the `dependencies` array from `plugin.json` (`:25`)
 * merged with the marketplace entry's own (`:96`).
 *
 * Merged by NAME rather than concatenated, because the two sources describe the
 * same dependency set for the same plugin and the manifest is the authority
 * whenever there is one: F1.1034 made a conflict-free `strict: false` over a
 * `plugin.json` "as with `true`", so `manifestIsAuthority` is the only switch.
 *
 * Auto-install (`:11`, `:70`) and tag-based version resolution (`:108`-`:127`)
 * used to be recorded here as absent. They exist now —
 * `plugins/version-tags.ts` selects the `{plugin-name}--v{version}` tag,
 * `marketplace/dependency-acquisition.ts` decides, and
 * `MarketplaceService.install` drives it. The deferred record below SURVIVES
 * that, because two limits remain and both are user-visible:
 *
 * - **Acquisition runs on the marketplace install route only.** A bundle
 *   installed by a direct source (a repository proposal, a local path, the CLI)
 *   still installs exactly one plugin. Its declared dependencies are then a
 *   load-time verdict, not a fetch, so the plugin is disabled with
 *   `dependency-unsatisfied` until they are installed by hand — which is `:104`'s
 *   own blessed escape hatch, but it is not `:11`'s promise.
 * - **Cross-marketplace dependencies are refused unconditionally.** `:81`'s
 *   refusal is enforced in full; `:83`'s WIDENING half is not, because the root
 *   marketplace's `allowCrossMarketplaceDependenciesOn`
 *   (`plugins/host-marketplace.md#depend-on-and-recommend-other-plugins`) is still dropped at catalog parse and the
 *   parsed catalog is persisted, so carrying it is a cache-schema change. Being
 *   more conservative than the page is the safe direction here: the field exists
 *   to let a marketplace pull plugins from another source, and we decline.
 */
function normalizeClaudeDependencies(
  input: UnknownRecord,
  entryFields: UnknownRecord,
  manifestIsAuthority: boolean,
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
): PluginDependencyDescriptor[] | undefined {
  const manifestValue = manifestIsAuthority ? input.dependencies : undefined;
  const entryValue = entryFields.dependencies;
  if (manifestValue === undefined && entryValue === undefined) return undefined;
  const manifestDependencies = normalizePluginDependencies(manifestValue, diagnostics, 'dependencies');
  const entryDependencies = normalizePluginDependencies(entryValue, diagnostics, 'marketplaceEntry.dependencies');
  const merged = new Map<string, PluginDependencyDescriptor>();
  for (const dependency of [...entryDependencies, ...manifestDependencies]) {
    merged.set(dependency.name, dependency);
  }
  const dependencies = [...merged.values()];
  if (dependencies.length > 0 && !deferred.some(record => record.externalKind === 'dependency-auto-install')) {
    deferred.push({
      externalKind: 'dependency-auto-install',
      reasonCode: 'plugin.deferred.claude_dependency_auto_install',
    });
  }
  return dependencies;
}

// --- monitors (B1e) ----------------------------------------------------------

/**
 * Claude's `experimental.monitors` (`plugins/components.md#monitors`).
 *
 * "Each monitor runs a shell command for the lifetime of the session and
 * delivers every stdout line to Claude as a notification" (`:290`), and monitors
 * "use the same mechanism as the Monitor tool" (`:292`) — which is why these
 * become `form: 'command'` monitor capabilities the host starts through the
 * existing `SessionMonitorService`, not a second process owner.
 *
 * **Two documented shapes for the same key, and they disagree.** `:316` says an
 * ARRAY is the inline entry list ("set `experimental.monitors` … to the same
 * array") and a STRING is a path ("a relative path string such as
 * `"./config/monitors.json"`"). `:636`'s REPLACES sentence names
 * `experimental.monitors` alongside `commands`, whose array form is a list of
 * PATHS. Neither reading is wrong, so the element type decides: records are
 * inline entries, strings are paths. Guessing one and refusing the other would
 * silently drop a conforming bundle — the defect this series keeps finding.
 *
 * `:540` — the surface is accepted at both the top level and under
 * `experimental.*`: "the top level still works, `claude plugin validate` warns".
 *
 * A monitor command is NEVER substituted with `${user_config.*}`; see
 * `normalizeClaudeMonitorEntry`.
 */
async function normalizeClaudeMonitors(
  rootDirectory: string,
  declaredValue: unknown,
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
  pluginLabel: string,
): Promise<PluginCapability[]> {
  const inlineEntries: Array<{ entry: unknown; diagnosticPath: string }> = [];
  const files: string[] = [];
  const declaredPaths: string[] = [];
  if (declaredValue === undefined) {
    if (existsSync(join(rootDirectory, CLAUDE_DEFAULT_MONITORS_FILE))) {
      files.push(CLAUDE_DEFAULT_MONITORS_FILE);
    }
  } else {
    const declaredList = Array.isArray(declaredValue) ? declaredValue : [declaredValue];
    const pathCandidates: unknown[] = [];
    declaredList.forEach((element, index) => {
      if (isRecord(element)) {
        inlineEntries.push({ entry: element, diagnosticPath: `experimental.monitors.${index}` });
        return;
      }
      pathCandidates.push(element);
    });
    if (pathCandidates.length > 0) {
      const resolution = await resolveClaudeComponentPaths(
        rootDirectory,
        'experimental.monitors',
        pathCandidates,
        diagnostics,
      );
      for (const entry of resolution.paths) {
        declaredPaths.push(entry.path);
        if (!existsSync(join(rootDirectory, entry.path))) {
          diagnostics.push(pluginDiagnostic(
            'warning',
            'plugin.format.claude_path_missing',
            `Claude monitors file "${entry.path}" does not exist.`,
            entry.diagnosticPath,
            { path: entry.path },
          ));
          continue;
        }
        files.push(entry.path);
      }
    }
    // P2.147 — the ignored-default warning `addClaudeIgnoredDefaultFolderRecords`
    // raises for the other REPLACES fields, raised here because monitors cannot
    // go through that loop: it is typed over `keyof ClaudeManifestPaths` and
    // `experimental.monitors` is not one of those keys — it has a normalizer of
    // its own and no path resolution on that record. (That is why the row's
    // "two lists that must agree" premise does not hold: the four-entry constant
    // is not a stale copy of the page's six, it is scoped to a narrower type.)
    //
    // `plugins/manifest-reference.md#path-rules` lists `experimental.monitors`
    // among the fields that REPLACE the default — "when the manifest specifies
    // `commands`, the default `commands/` directory is not scanned" — and the
    // branch above does exactly that: the default file is read ONLY when the key
    // is absent. Without this the displacement was silent, and monitors is the
    // half of P2.147 that has a live reader (B1e made them runnable), so the
    // author loses running monitors with nothing said.
    //
    // Same documented exception as the shared loop: a declared path that names
    // the default folder or something inside it "names the folder explicitly" and
    // is not an override of it.
    if (existsSync(join(rootDirectory, CLAUDE_DEFAULT_MONITORS_FILE))
      && !declaredPaths.some(path => manifestPathIsWithinDefault(path, CLAUDE_DEFAULT_MONITORS_DIR))) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_default_folder_ignored',
        `Claude plugin declares "experimental.monitors", so the default "${CLAUDE_DEFAULT_MONITORS_FILE}" is not read. The plugin still loads using the manifest paths.`,
        CLAUDE_DEFAULT_MONITORS_FILE,
        { field: 'monitors', path: CLAUDE_DEFAULT_MONITORS_FILE },
      ));
      deferred.push({
        externalKind: 'ignored-default-monitors-folder',
        reasonCode: 'plugin.deferred.claude_default_folder_ignored',
      });
    }
  }

  for (const relativePath of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(rootDirectory, relativePath), 'utf-8'));
    } catch (error) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_json_unreadable',
        `Claude monitors file could not be read: ${error instanceof Error ? error.message : String(error)}`,
        relativePath,
      ));
      continue;
    }
    // `:296` — "**Format**: JSON array of monitor entries".
    if (!Array.isArray(parsed)) {
      diagnostics.push(incompleteClaudeCapability('monitor', relativePath, 'Claude monitors.json must be an array of monitor entries.'));
      continue;
    }
    parsed.forEach((entry, index) => {
      inlineEntries.push({ entry, diagnosticPath: `${relativePath}.${index}` });
    });
  }

  const capabilities: PluginCapability[] = [];
  const seen = new Set<string>();
  for (const { entry, diagnosticPath } of inlineEntries) {
    normalizeClaudeMonitorEntry({ entry, diagnosticPath, diagnostics, deferred, capabilities, seen, pluginLabel });
  }
  // Declared, and nothing runnable came out of it. Recorded rather than
  // vanishing, which is what `deferred` exists for.
  if ((declaredValue !== undefined || files.length > 0) && capabilities.length === 0
    && !deferred.some(record => record.externalKind === 'monitor')) {
    deferred.push({ externalKind: 'monitor', reasonCode: 'plugin.deferred.claude_monitor' });
  }
  return capabilities;
}

function normalizeClaudeMonitorEntry(options: {
  entry: unknown;
  diagnosticPath: string;
  diagnostics: PluginDiagnostic[];
  deferred: PluginCompatibilityReport['deferred'];
  capabilities: PluginCapability[];
  seen: Set<string>;
  pluginLabel: string;
}): void {
  const { entry, diagnosticPath, diagnostics, deferred, capabilities, seen, pluginLabel } = options;
  if (!isRecord(entry)) {
    diagnostics.push(incompleteClaudeCapability('monitor', diagnosticPath, 'Claude monitor entry must be an object.'));
    return;
  }
  const name = stringField(entry, 'name');
  const command = stringField(entry, 'command');
  const description = stringField(entry, 'description');
  const when = stringField(entry, 'when') ?? 'always';
  if (!name) {
    diagnostics.push(incompleteClaudeCapability('monitor', `${diagnosticPath}.name`, 'Claude monitor requires a name.'));
    return;
  }
  if (!command) {
    diagnostics.push(incompleteClaudeCapability('monitor', `${diagnosticPath}.command`, 'Claude monitor requires a command.'));
    return;
  }
  // `:334` and `errors.md:1368` — the monitor is REFUSED rather than substituted,
  // because the command "runs through a shell" and "A configured value containing
  // `$(...)`, backticks, or `;` would run as code there". `errors.md:1368` also
  // settles when: "The check runs on the command template, so the error appears
  // even when no value is configured yet." Same parse-time check B1b landed for
  // shell-form hooks — and unlike a hook there is no exec-form escape here,
  // because a monitor has no `args`: every monitor command reaches a shell.
  if (CLAUDE_USER_CONFIG_REFERENCE.test(command)) {
    diagnostics.push(pluginDiagnostic(
      'error',
      'plugin.format.claude_monitor_user_config_shell',
      // `errors.md:1379` gives the wording verbatim.
      `Monitor "${name}" from plugin ${pluginLabel} references \${user_config.*} in its command. `
        + 'The substituted value would be passed to a shell. Monitor commands cannot safely reference '
        + '${user_config.*}; have the monitor script read the value from a config file or prompt instead.',
      diagnosticPath,
      { kind: 'monitor', name },
    ));
    return;
  }
  // `:330` gives exactly two `when` forms. An unrecognized one is refused rather
  // than defaulted to `always`, which would START a monitor whose author asked
  // for a trigger we did not understand.
  if (when !== 'always' && !/^on-skill-invoke:.+$/.test(when)) {
    diagnostics.push(incompleteClaudeCapability('monitor', `${diagnosticPath}.when`, `Claude monitor "when" must be "always" or "on-skill-invoke:<skill-name>", got "${when}".`));
    return;
  }
  // `:322` — "Identifier unique within the plugin. Prevents duplicate processes
  // when the plugin reloads or a skill is invoked again."
  if (seen.has(name)) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.claude_monitor_duplicate',
      `Claude monitor "${name}" is declared more than once in this plugin; the first declaration wins.`,
      diagnosticPath,
      { kind: 'monitor', name },
    ));
    return;
  }
  seen.add(name);
  // P6.416 — the `on-skill-invoke:<skill-name>` trigger USED to be recorded here
  // as a deferral, because the monitor imported and never started: there was no
  // skill-dispatch seam. There is now — `SessionManager`'s Pi continuation
  // boundary reads `state.invokedSkills` and starts the matching monitor inside
  // the turn that invoked the skill — so this format no longer defers the
  // trigger, and the record is REMOVED rather than reworded.
  //
  // What remains is a RUNTIME question, not a format one, and it is already
  // answered by its own record: `PLUGIN_PERIPHERAL_SUPPORT`
  // (`agent/runtime-agent-support.ts`) runs no plugin monitor at all on claude or
  // codex, with a per-runtime reason. Reporting a format-level deferral beside
  // that would tell an author their trigger was dropped by the IMPORT when it is
  // the runtime that declines — two different repairs.
  capabilities.push({
    kind: 'monitor',
    id: createPluginCapabilityId('monitor', name),
    displayName: name,
    ...(description ? { description } : {}),
    monitor: {
      form: 'command',
      id: name,
      // `:332` — `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`/
      // `${CLAUDE_PROJECT_DIR}` are supported in a monitor command, so it goes
      // through the SAME rewrite every other parsed command field uses.
      command: rewriteClaudeTokens(command),
      // `:324`'s description is task-panel/notification label text; an absent one
      // costs a caption, not the monitor.
      description: description ?? name,
      when: when as 'always' | `on-skill-invoke:${string}`,
    },
  });
}

// --- user configuration (B1b) ------------------------------------------------

/**
 * `plugins/manifest-reference.md#user-configuration` — the `userConfig` option schema.
 *
 * The manifest declares an object keyed by option name; each option carries
 * `type` (`:568`), `title` (`:569`), `description` (`:570`), and optionally
 * `sensitive` (`:571`), `required` (`:572`), `default` (`:573`), `multiple`
 * (`:574`) and `min`/`max` (`:575`). The IR spelling is the shared
 * `PluginUserConfigurationDescriptor`, so MCPB's `user_config` and Claude's
 * `userConfig` reach ONE storage path rather than two.
 *
 * A malformed option is refused with a diagnostic and dropped; the rest of the
 * bundle still imports, which is how every other Claude component behaves here.
 *
 * `title`/`description` are documented as required, but they are label text: a
 * bundle that omits them is imported with a WARNING rather than losing the
 * option, because refusing costs the user a working option to enforce a caption.
 */
const CLAUDE_USER_CONFIG_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Any `${user_config.*}` reference. Non-global on purpose: a global regex keeps
 * `lastIndex` between `.test()` calls and would skip every other hook.
 */
const CLAUDE_USER_CONFIG_REFERENCE = /\$\{user_config\.[A-Za-z0-9._-]+\}/;

/**
 * `errors.md:1372`'s `formatter@acme-tools` — the plugin name and the
 * marketplace it came from. Falls back to the name alone when the bundle has no
 * marketplace, which is every local-path install.
 */
function claudePluginLabel(input: UnknownRecord, origin: PluginOrigin, rootDirectory: string): string {
  const name = stringField(input, 'name') ?? basename(rootDirectory);
  return origin.marketplaceId ? `${name}@${origin.marketplaceId}` : name;
}

function normalizeClaudeUserConfig(
  input: unknown,
  diagnostics: PluginDiagnostic[],
  path = 'userConfig',
): PluginUserConfigurationDescriptor[] {
  if (input === undefined) return [];
  if (!isRecord(input)) {
    diagnostics.push(pluginDiagnostic('error', 'plugin.format.claude_user_config_invalid', 'Claude userConfig must be an object keyed by option name.', path));
    return [];
  }
  const descriptors: PluginUserConfigurationDescriptor[] = [];
  for (const [key, raw] of Object.entries(input)) {
    const optionPath = `${path}.${key}`;
    // `:564` — "Keys must be valid identifiers". Enforced as an identifier and
    // not as the looser MCPB key shape because `:577` uppercases the key into
    // an environment variable name, and `a.b`/`a-b` cannot be one.
    if (!CLAUDE_USER_CONFIG_KEY.test(key) || key === 'constructor' || key === 'prototype') {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.claude_user_config_invalid', `Claude userConfig key "${key}" must be a valid identifier.`, optionPath));
      continue;
    }
    if (!isRecord(raw)) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.claude_user_config_invalid', `Claude userConfig option "${key}" must be an object.`, optionPath));
      continue;
    }
    const type = stringField(raw, 'type');
    if (type !== 'string' && type !== 'number' && type !== 'boolean'
      && type !== 'directory' && type !== 'file') {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.claude_user_config_type_unsupported', `Unsupported Claude userConfig type "${type ?? 'missing'}" for option "${key}".`, `${optionPath}.type`));
      continue;
    }
    const multiple = raw.multiple === true;
    if (multiple && type !== 'string') {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.claude_user_config_invalid', `Claude userConfig option "${key}" declares multiple on a non-string type.`, `${optionPath}.multiple`));
      continue;
    }
    if ((raw.min !== undefined || raw.max !== undefined) && type !== 'number') {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.claude_user_config_invalid', `Claude userConfig option "${key}" declares min/max on a non-number type.`, `${optionPath}.min`));
      continue;
    }
    const min = typeof raw.min === 'number' && Number.isFinite(raw.min) ? raw.min : undefined;
    const max = typeof raw.max === 'number' && Number.isFinite(raw.max) ? raw.max : undefined;
    if ((raw.min !== undefined && min === undefined) || (raw.max !== undefined && max === undefined)
      || (min !== undefined && max !== undefined && min > max)) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.claude_user_config_invalid', `Claude userConfig option "${key}" declares invalid min/max bounds.`, `${optionPath}.min`));
      continue;
    }
    const sensitive = raw.sensitive === true;
    const defaultValue = raw.default;
    // `:571` stores a sensitive value in secure storage; a manifest-declared
    // default for one would put that value in a plaintext manifest instead.
    if (sensitive && defaultValue !== undefined) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.claude_user_config_invalid', `Sensitive Claude userConfig option "${key}" must not declare a default.`, `${optionPath}.default`));
      continue;
    }
    if (defaultValue !== undefined && !claudeUserConfigDefaultMatches(type, multiple, defaultValue)) {
      diagnostics.push(pluginDiagnostic('error', 'plugin.format.claude_user_config_invalid', `Claude userConfig option "${key}" default does not match its declared type.`, `${optionPath}.default`));
      continue;
    }
    // A `directory`/`file` DEFAULT is a path the plugin author chose, not one
    // the user typed, so it goes through B1a's containment gate like every other
    // manifest-declared path. A user-supplied value is the user's own consent
    // and is validated at configure time instead.
    if ((type === 'directory' || type === 'file') && typeof defaultValue === 'string') {
      const containmentError = manifestPathContainmentError(defaultValue);
      if (containmentError) {
        diagnostics.push(pluginDiagnostic('error', 'plugin.format.claude_user_config_path_uncontained', `Claude userConfig option "${key}" default path is not contained in the bundle: ${containmentError}`, `${optionPath}.default`));
        continue;
      }
    }
    const title = stringField(raw, 'title');
    const description = stringField(raw, 'description');
    if (!title || !description) {
      diagnostics.push(pluginDiagnostic('warning', 'plugin.format.claude_user_config_incomplete', `Claude userConfig option "${key}" is missing its documented title/description.`, optionPath));
    }
    descriptors.push({
      key,
      valueType: type,
      ...(raw.required === true ? { required: true } : {}),
      ...(defaultValue !== undefined ? { defaultValue: defaultValue as string | number | boolean | string[] } : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(sensitive ? { sensitive: true } : {}),
      ...(multiple ? { multiple: true } : {}),
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
    });
  }
  return descriptors;
}

function claudeUserConfigDefaultMatches(
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file',
  multiple: boolean,
  value: unknown,
): boolean {
  if (multiple) return Array.isArray(value) && value.every(item => typeof item === 'string');
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string';
}

// --- LSP servers (B3) --------------------------------------------------------

/**
 * Normalizes Claude's documented `lspServers` manifest field — or, when no
 * manifest field is declared, the documented plugin-root `.lsp.json` default —
 * into `lsp` capabilities (B3). The value is an array of
 * `{ id?, command, args?, extensionToLanguage?, languages? }` descriptors or an
 * object keyed by server id. Our own earlier `lsp` spelling stays accepted at
 * the call site. A malformed descriptor (no command, no language source) is
 * SKIPPED with a per-entry diagnostic while the plugin's other servers still
 * normalize — Claude documents exactly that behavior. Commands/args are
 * token-rewritten like other executable fields.
 */
async function normalizeClaudeLspServers(
  rootDirectory: string,
  input: unknown,
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
  manifestFieldLabel = 'lspServers',
): Promise<PluginCapability[]> {
  // `:531` types the field `string|array|object` and gives `"./.lsp.json"` as
  // its example, so the value may be a PATH to the config file rather than the
  // config itself. That form used to fall through every branch below and produce
  // `claude_capability_incomplete`, zero capabilities, AND suppression of the
  // `.lsp.json` default — absent and undeclared at once.
  const declared = await resolveClaudeComponentPaths(rootDirectory, manifestFieldLabel, input, diagnostics);
  // `:638` gives LSP its "own merge rules" and the LSP section states only that
  // configuration lives in "`.lsp.json` in plugin root, or inline in
  // `plugin.json`", with first-registered-wins when two servers claim the same
  // extension (`:268`). `collectClaudeConfigSources` is that rule, now shared
  // with the `hooks` and `mcpServers` readers.
  const sources = await collectClaudeConfigSources(
    rootDirectory,
    declared,
    CLAUDE_DEFAULT_LSP_FILE,
    { kind: 'lsp', fieldLabel: manifestFieldLabel, fileLabel: 'LSP servers' },
    diagnostics,
  );
  if (sources.length === 0) {
    if (declared.declared && declared.paths.length === 0 && declared.inline === undefined) {
      diagnostics.push(incompleteClaudeCapability('lsp', manifestFieldLabel, 'Claude lspServers must be a config path, an array, or an object of server descriptors.'));
    }
    return [];
  }
  const capabilities: PluginCapability[] = [];
  const seen = new Set<string>();
  for (const { label, source } of sources) {
    for (const capability of normalizeClaudeLspSource(source, label, diagnostics, deferred)) {
      // `:268`: "the first server registered handles files with that extension
      // and the others never start."
      if (seen.has(capability.id)) continue;
      seen.add(capability.id);
      capabilities.push(capability);
    }
  }
  return capabilities;
}

/**
 * Read one JSON component-config file (`.lsp.json`, `.mcp.json`,
 * `hooks/hooks.json`, or whatever path the manifest declared in their place).
 * A missing declared path and an unparseable file are both per-file warnings so
 * the bundle's other sources still normalize.
 */
async function readClaudeJsonConfigFile(
  rootDirectory: string,
  relativePath: string,
  labels: { kind: string; fileLabel: string },
  diagnostics: PluginDiagnostic[],
): Promise<unknown> {
  const absolutePath = join(rootDirectory, relativePath);
  if (!existsSync(absolutePath)) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.claude_path_missing',
      `Claude ${labels.fileLabel} file "${relativePath}" does not exist.`,
      relativePath,
      { kind: labels.kind, path: relativePath },
    ));
    return undefined;
  }
  try {
    return JSON.parse(await readFile(absolutePath, 'utf-8'));
  } catch (error) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.claude_json_unreadable',
      `Claude ${labels.fileLabel} file could not be read: ${error instanceof Error ? error.message : String(error)}`,
      relativePath,
    ));
    return undefined;
  }
}

/**
 * P6.417 — the documented LSP fields this adapter STILL reads nothing from.
 *
 * ONE, and it is the one the page says nothing reads: `transport`. *"`stdio`
 * (default) or `socket`. Claude Code accepts `socket` but runs every server
 * over stdio, so the stdout protocol rules apply to all servers."* So there is
 * no behaviour to honour — accepting both values and running stdio IS honouring
 * it — and carrying the field would imply a choice nothing makes. What IS
 * enforced is the page's other sentence, *"Claude Code skips a server whose
 * configuration is invalid"*: a third value is refused by
 * {@link CLAUDE_LSP_TRANSPORTS} below, because a server declared for a
 * transport nobody recognises is a configuration this host cannot judge.
 *
 * The other SEVEN were on this list until P6.417 and are now honoured by a
 * supervisor ({@link PluginLspSupervision}). The list is kept — not emptied and
 * deleted — because the WARNING it drives is still the right channel for a
 * declaration we carry no further, and because a ninth optional field arriving
 * on the page lands here rather than vanishing.
 *
 * The record is a WARNING DIAGNOSTIC and deliberately not a `deferred` row —
 * the same channel D3 measured for Codex's dropped manifest fields. A
 * `deferred` row flips `compatibility.state` to `'partial'`
 * (`buildClaudeCompatibilityReport`), which is what
 * `management-service-v2.ts:572` turns into `requiresConfirmation` and a policy
 * purge, i.e. a confirm-enable step in front of the install. That step is worth
 * it when the user loses a COMPONENT — a whole server skipped, a theme we will
 * never load — and it is not worth it for a knob on a server that starts and
 * works.
 */
const CLAUDE_UNREAD_LSP_FIELDS = [
  'transport',
] as const;

/**
 * P6.417 — the two values `transport` may take, from the page's own table.
 *
 * Both are ACCEPTED and both run over stdio, which is the page's stated
 * behaviour rather than a simplification of ours. Anything else is an invalid
 * configuration and the server is skipped, per *"Claude Code skips a server
 * whose configuration is invalid, for example one missing `command` or
 * `extensionToLanguage`, and the other configured servers still start."*
 */
const CLAUDE_LSP_TRANSPORTS = new Set(['stdio', 'socket']);

function normalizeClaudeLspSource(
  source: unknown,
  sourceLabel: string,
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
): PluginCapability[] {
  const entries: Array<[string | undefined, unknown]> = Array.isArray(source)
    ? source.map(entry => [undefined, entry] as [string | undefined, unknown])
    : isRecord(source)
      ? Object.entries(source)
      : [];
  if (entries.length === 0 && !Array.isArray(source) && !isRecord(source)) {
    diagnostics.push(incompleteClaudeCapability('lsp', sourceLabel, 'Claude lspServers must be an array or object of server descriptors.'));
    return [];
  }
  const capabilities: PluginCapability[] = [];
  entries.forEach(([key, entry], index) => {
    if (!isRecord(entry)) {
      diagnostics.push(incompleteClaudeCapability('lsp', `${sourceLabel}.${key ?? index}`, 'Claude lspServers entry must be an object.'));
      return;
    }
    const command = stringField(entry, 'command');
    const lspId = key ?? stringField(entry, 'id') ?? stringField(entry, 'name') ?? `lsp-${index}`;
    if (!command) {
      diagnostics.push(incompleteClaudeCapability('lsp', `${sourceLabel}.${lspId}`, 'Claude LSP server requires a command.'));
      return;
    }
    const args = readStringArray(entry.args)?.map(rewriteClaudeTokens);
    // Claude's documented language source is `extensionToLanguage`, a map of
    // file extension to language id; `languages` is our own earlier spelling
    // and stays accepted. F1.1025: the map itself is carried too, at the push.
    const extensionToLanguage = isRecord(entry.extensionToLanguage)
      ? [...new Set(Object.values(entry.extensionToLanguage).filter((value): value is string => typeof value === 'string' && value.length > 0))]
      : undefined;
    const languages = readRequiredUniqueStringArray(entry.languages)
      ?? (extensionToLanguage?.length ? extensionToLanguage : undefined);
    if (!languages) {
      diagnostics.push(incompleteClaudeCapability('lsp', `${sourceLabel}.${lspId}.languages`, 'Claude LSP server requires extensionToLanguage or unique non-empty languages.'));
      return;
    }
    // `plugins-reference.md` § Environment variables: "| LSP servers |
    // `command`, `args`, `env`, `workspaceFolder` |" — the four fields the
    // documented path placeholders resolve in, so all four are token-rewritten
    // here exactly like the MCP reader's executable fields.
    const env = isStringRecord(entry.env) ? rewriteClaudeTokensInRecord(entry.env) : undefined;
    const workspaceFolder = stringField(entry, 'workspaceFolder')
      ? rewriteClaudeTokens(stringField(entry, 'workspaceFolder')!)
      : undefined;
    if (workspaceFolder) {
      const workspaceFolderError = validatePluginLspWorkspaceFolder(workspaceFolder);
      if (workspaceFolderError) {
        // `:270` — "Claude Code skips a server whose configuration is invalid
        // […] and the other configured servers still start." Refused here as a
        // per-server warning rather than left to the schema's error branch,
        // which would fail the whole bundle to normalize.
        diagnostics.push(incompleteClaudeCapability(
          'lsp',
          `${sourceLabel}.${lspId}.workspaceFolder`,
          `Claude LSP workspaceFolder is invalid: ${workspaceFolderError}`,
        ));
        deferred.push({ externalKind: 'lsp', reasonCode: 'plugin.deferred.claude_lsp_invalid_workspace_folder' });
        return;
      }
    }
    // P6.417 — the page's own skip rule, applied to the one field with a closed
    // value set. `stdio` and `socket` both run over stdio; a third value is a
    // configuration this host cannot judge, and the page says such a server is
    // skipped while "the other configured servers still start" — which is what
    // returning here does, since the loop continues.
    const transport = stringField(entry, 'transport');
    if (transport !== undefined && !CLAUDE_LSP_TRANSPORTS.has(transport)) {
      diagnostics.push(incompleteClaudeCapability(
        'lsp',
        `${sourceLabel}.${lspId}.transport`,
        `Claude LSP transport must be "stdio" or "socket", got "${transport}".`,
      ));
      deferred.push({ externalKind: 'lsp', reasonCode: 'plugin.deferred.claude_lsp_unknown_transport' });
      return;
    }
    const supervision = readClaudeLspSupervision(entry, `${sourceLabel}.${lspId}`, lspId, diagnostics);
    const unread = CLAUDE_UNREAD_LSP_FIELDS.filter(field => entry[field] !== undefined);
    if (unread.length > 0) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_lsp_fields_unread',
        `Claude LSP server "${lspId}" declares ${unread.join(', ')}, which Nessy does not apply to a language server; the server still starts with its command, args, env and workspace folder.`,
        `${sourceLabel}.${lspId}`,
        { kind: 'lsp', serverName: lspId },
      ));
    }
    capabilities.push({
      kind: 'lsp',
      id: createPluginCapabilityId('lsp', lspId),
      lsp: {
        id: lspId,
        command: rewriteClaudeTokens(command),
        ...(args ? { args } : {}),
        languages, ...claudeLspExtensionMapField(entry.extensionToLanguage, languages, `${sourceLabel}.${lspId}`, lspId, diagnostics),
        ...(env ? { env } : {}),
        ...(workspaceFolder ? { workspaceFolder } : {}),
        ...(supervision ? { supervision } : {}),
      },
    });
  });
  return capabilities;
}

/**
 * P6.417 — the seven supervision fields, read with the page's own defaults.
 *
 * A malformed value is REFUSED BY NAME rather than coerced or ignored. Both
 * alternatives are worse in the same direction: coercing invents a policy the
 * author did not write, and ignoring leaves them believing a knob is honoured
 * when it is not — which is the exact failure this row exists to close, one
 * layer in.
 *
 * `initializationOptions` and `settings` are opaque JSON by contract (they are
 * handed to the SERVER, not read here), so the only shape check is that they
 * are objects: a scalar would be sent as a body the LSP spec has no slot for.
 */
function readClaudeLspSupervision(
  entry: Record<string, unknown>,
  diagnosticPath: string,
  lspId: string,
  diagnostics: PluginDiagnostic[],
): PluginLspSupervision | undefined {
  const supervision: PluginLspSupervision = {};
  const refuse = (field: string, expected: string): void => {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.claude_lsp_field_invalid',
      `Claude LSP server "${lspId}" declares ${field} with a value that is not ${expected}; it is ignored and the server starts with the default.`,
      `${diagnosticPath}.${field}`,
      { kind: 'lsp', serverName: lspId },
    ));
  };
  for (const field of ['initializationOptions', 'settings'] as const) {
    const value = entry[field];
    if (value === undefined) continue;
    if (!isRecord(value)) { refuse(field, 'a JSON object'); continue }
    supervision[field] = value;
  }
  for (const field of ['startupTimeout', 'shutdownTimeout', 'maxRestarts'] as const) {
    const value = entry[field];
    if (value === undefined) continue;
    // A non-integer or negative bound is not a bound. `0` is admitted for
    // `maxRestarts` — "give up immediately" is a real answer — and refused for
    // the two timeouts, where it would mean "time out before starting".
    const floor = field === 'maxRestarts' ? 0 : 1;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < floor) {
      refuse(field, `an integer of at least ${floor}`);
      continue;
    }
    supervision[field] = value;
  }
  for (const field of ['restartOnCrash', 'diagnostics'] as const) {
    const value = entry[field];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') { refuse(field, 'a boolean'); continue }
    supervision[field] = value;
  }
  return Object.keys(supervision).length > 0 ? supervision : undefined;
}

// --- retained peripheral surfaces (deferred, never dropped) -----------------

/**
 * Claude surfaces this adapter never turns into a capability, mapped to their
 * `deferred` report externalKind + reasonCode (item 10). `outputStyles` uses
 * the singular externalKind `"output-style"` (A1 fixture-exact); every other
 * surface uses its field name as-is, singularized where the existing report
 * vocabulary already did.
 *
 * Each row is deferred from ANY of three signals: the top-level manifest field,
 * the documented `experimental.*` field, or the documented default path on disk.
 * A field-only check let a bundle that simply used the default layout disappear
 * with no capability and no record — the one thing
 * `PluginCompatibilityReport.deferred` exists to prevent. At most one record is
 * emitted per `externalKind`, so a bundle declaring both a field and the default
 * folder still reports the surface once.
 *
 * `themes` is accepted at BOTH the top level and under `experimental.*`: the
 * docs say the top level still works and `claude plugin validate` only warns, so
 * a bundle using either spelling must be recorded.
 */
const CLAUDE_RETAINED_SURFACE_FIELDS: ReadonlyArray<{
  externalKind: string;
  field?: string;
  experimentalField?: string;
  defaultPath?: string;
  reasonCode?: string;
  /**
   * A diagnostic emitted at normalization for a surface Nessy REFUSES rather
   * than defers.
   *
   * The difference is who is told. A `deferred` row is a machine-readable record
   * on the compatibility report; a diagnostic is the message an author sees when
   * they install the bundle. A surface we will never build has to produce the
   * second, or the author ships a component that silently does nothing.
   */
  refusal?: { code: string; message: string };
}> = [
  {
    externalKind: 'theme',
    field: 'themes',
    experimentalField: 'themes',
    defaultPath: 'themes',
    // REFUSED, deliberately, rather than loaded.
    //
    // `plugins/components.md#themes-and-output-styles` — "A theme is a JSON file in `themes/` with a
    // `base` preset and a sparse `overrides` map of color tokens", and `:342`'s
    // own example keys those overrides on `claude`, `error` and `success`: a
    // TERMINAL palette, for a TUI. Nessy's theming is a web token set
    // (`config/theme.ts` — background, foreground, accent, info, success,
    // destructive, plus paper/navigator/input/popover surfaces, a solid/scenic
    // mode and a background image), and `base` has no counterpart at all: our
    // presets are files under `~/.nessy-agent/themes/`, while light/dark is a
    // mode within one theme rather than a base to override.
    //
    // Nothing in the format defines a mapping between the two vocabularies, so
    // loading one would mean inventing it — and a guessed mapping renders the
    // author's theme as something they never authored, on a surface whose entire
    // purpose is looking the way they specified. `:354`'s
    // `custom:<plugin-name>:<slug>` selection format and its read-only
    // copy-to-edit behaviour are Claude config we also do not implement.
    //
    // So the author is told at install instead. If Nessy ever grows a
    // token-mapping contract for plugin themes, this becomes a loader and the
    // refusal goes away with it.
    refusal: {
      code: 'plugin.format.claude_theme_unsupported',
      message: 'Claude plugin themes are not loaded. A plugin theme declares a `base` preset and'
        + ' terminal color tokens (plugins/components.md#themes-and-output-styles), which have no defined mapping onto'
        + " Nessy's web theme tokens; the declaration is recorded and ignored rather than guessed at.",
    },
  },
  // `monitors` used to sit here. B1e made it runnable, so its record is now
  // emitted by `normalizeClaudeMonitors` ONLY when nothing loadable came out of
  // the declaration — a blanket row here would report every working monitor as
  // deferred.
  // B1b imports the option SCHEMA, collects values and exports them as
  // `CLAUDE_PLUGIN_OPTION_<KEY>`. What stays unbuilt is `:577`'s substitution of
  // `${user_config.KEY}` into MCP/LSP configs and skill/agent content, so the
  // record keeps the surface visible under a reason that names what is missing
  // rather than claiming the whole field is inert.
  {
    externalKind: 'user-config',
    field: 'userConfig',
    reasonCode: 'plugin.deferred.claude_user_config_substitution',
  },
  // `dependencies` used to sit here as a blanket record. B1e carries the field
  // into the IR and gates activation on it; what is still deferred is
  // auto-install, recorded by `normalizeClaudeDependencies` under its own kind.
  {
    externalKind: 'channel',
    field: 'channels',
    // C3.140 (QJ5 = A, owner 2026-09-11) — the declaration is deferred, and the
    // author is told which HALF of it is, because the other half already works.
    //
    // The row carried no `refusal` until now, so a bundle shipping `channels`
    // lost the component with nothing but a machine-readable `deferred` entry to
    // show for it. Measured at HEAD while writing this, and it narrows the
    // message a great deal: the channel MECHANISM is built. An MCP server that
    // declares the `claude/channel` capability is armed by
    // `SessionManager.announceChannelSources` once `mcpChannelPushEnabled` is on
    // (`packages/shared/src/config/storage.ts` symbol `getMcpChannelPushEnabled`,
    // default false, forceable off by managed policy and never on), and the
    // session says which sources are armed and which are quiet.
    //
    // What is NOT read is the manifest field: arming keys on the server's own
    // capability declaration, never on this list, so the field's two documented
    // jobs — binding a named `server` (`plugins/manifest-reference.md#channels`: "The
    // `server` field is required and must match a key in the plugin's
    // `mcpServers`") and its per-channel prompt ("The optional per-channel
    // `userConfig` uses the same schema as the top-level field, letting the
    // plugin prompt for bot tokens or owner IDs when the plugin is enabled") —
    // are both unbuilt. The second is the one an author must work around, which
    // is why the message names it rather than stopping at "not supported".
    refusal: {
      code: 'plugin.format.claude_channel_declaration_ignored',
      message: "A plugin's `channels` declaration is not read. The channel itself is not lost:"
        + ' the MCP server it names installs like any other, and it is armed by its own'
        + ' `claude/channel` capability once the "MCP channel push" setting is on — the session'
        + ' announces which sources are armed. What is deferred is the declaration'
        + ' (plugins/manifest-reference.md#channels), including its per-channel `userConfig` prompt, so a'
        + " channel needing a bot token must take it from the MCP server's own configuration"
        + ' instead.',
    },
  },
  // `bin` used to sit here as a blanket "the directory exists" record. It moved
  // to `addClaudeBinSurfaceDeferral`, which runs after the capabilities are
  // built because whether a bin/ entry is unrunnable depends on them.
  //
  // `settings` used to sit here as `{ externalKind: 'settings', field:
  // 'settings', defaultPath: 'settings.json' }` — a row fired by the file's mere
  // EXISTENCE, which never opened it. It moved to
  // `normalizeClaudePluginDefaultSettings`, which runs after the capabilities are
  // built (the `agent` key names one of them) and records one row per
  // unhonoured SUPPORTED key that the bundle actually set. The blanket row cost
  // more than it recorded: a `settings.json` carrying only keys the docs
  // themselves say are ignored still forced `compatibility.state: 'partial'`,
  // and a partial bundle has every durable activation grant purged on its next
  // repair.
  //
  // `experimental.evals` is DELIBERATELY NOT HERE, and this note is the answer
  // to the reading that would otherwise put it here (I2.2, measured 2026-09-17).
  // AGENTS.md's component diff (docs/agents/upstream-docs.md) reads the
  // `## Fields` table of plugins/manifest-reference.md, and one of its rows is
  // `experimental.evals` — "Directory that holds the plugin's eval cases
  // when it isn't the default `evals/`" (read 2026-10-01). It scores
  // zero in every constant that diff reads, and unlike `experimental.monitors`
  // (the other path row in no constant) it has no normalizer: repo-wide it has zero
  // readers across `packages` and `apps`. By the letter of that rule it is "the
  // real thing this rule exists to catch", so it is worth saying why it is not.
  //
  // It is not a COMPONENT. The directory holds eval cases for `claude plugin
  // eval`, a developer command; a plugin behaves identically with it, without
  // it, and with it pointed somewhere else, so nothing an author declared is
  // lost by not reading it. Adding a row here would do real damage rather than
  // nothing: `defaultPath` fires on the mere existence of an `evals/` folder —
  // the exact shape the `settings` note above records as having cost more than
  // it recorded — and every deferral forces `compatibility.state: 'partial'`,
  // which purges a bundle's durable activation grants on its next repair. A
  // plugin would lose its grants for shipping its own tests.
  //
  // So the honest surface is this note rather than a row, and the pin is in
  // `__tests__/format-adapters.test.ts` ("a plugin that ships eval cases is not
  // a partial bundle"), with `experimental.themes` as the control that proves
  // the same probe does see a peripheral surface at the same spelling level.
  //
  // UB12.95 (2026-10-17) — eight more `## Fields` rows score zero in every
  // constant and have no reader, and none of them belongs here either:
  //
  //  - `$schema`, `metadata` and the five directory-listing fields (`icon`,
  //    `documentationUrl`, `supportUrl`, `privacyPolicyUrl`,
  //    `termsOfServiceUrl`). The page says Claude Code does not read them:
  //    `$schema` — "Claude Code ignores it at load time"; `metadata` — "Claude
  //    Code doesn't read it" (plugins/manifest-reference.md#metadata); the five —
  //    "Anthropic's directory reads the `icon`, `documentationUrl`,
  //    `supportUrl`, `privacyPolicyUrl`, and `termsOfServiceUrl` fields … Claude
  //    Code ignores them at load time" (plugins/manifest-reference.md#directory-listing-fields).
  //    We do the same: accepted, ignored, no diagnostic, no deferral (nothing a
  //    session runs is lost, so a deferral would only cost the bundle its
  //    grants, as for `evals`). Not carried to the plugin card either: Claude
  //    Code's own UI shows none of them, and our IR carries only the one link
  //    the page has Claude Code validate, `homepage` ("Must parse as a URL, or
  //    the plugin fails to load"), as `homepageUrl` — which no renderer shows
  //    today (0 readers under `apps/electron/src/renderer`, 2026-10-17). A link
  //    on the card is a product posture (an author-supplied external URL in
  //    the UI), so it stays an owner question rather than a guess here.
  //  - `types` — "A `.d.ts` file that declares the `$.state` values and `$`
  //    nouns of a mod". It is a developer-time file like `evals`: the mods
  //    interface page adds it "To let `claude plugin validate` check your code
  //    against that file", and a TypeScript declaration file runs nothing. What
  //    makes a plugin a mod is the `modules` key of its hooks file, and THAT is
  //    deferred, with an author diagnostic, by `addClaudeModDeferral`.
  //
  // Pinned in `__tests__/format-adapters.test.ts` ("UB12.95"): each field
  // imports as a no-op, with `homepage` as the control that proves the probe
  // sees a field we do read.
];

function addClaudeRetainedSurfaceDeferrals(
  rootDirectory: string,
  input: UnknownRecord,
  deferred: PluginCompatibilityReport['deferred'],
  diagnostics: PluginDiagnostic[],
): void {
  const experimental = isRecord(input.experimental) ? input.experimental : undefined;
  for (const row of CLAUDE_RETAINED_SURFACE_FIELDS) {
    const { externalKind, field, experimentalField, defaultPath, reasonCode } = row;
    // the retired plugins-reference page's experimental-components section (no successor page publishes it) — an `experimental.*` component "still works" at
    // the top level, so BOTH spellings count as declared, as does the documented
    // default directory.
    const declaredPath = experimentalField !== undefined && experimental?.[experimentalField] !== undefined
      ? `experimental.${experimentalField}`
      : field !== undefined && input[field] !== undefined
        ? field
        : defaultPath;
    const declared = (field !== undefined && input[field] !== undefined)
      || (experimentalField !== undefined && experimental?.[experimentalField] !== undefined)
      || (defaultPath !== undefined && existsSync(join(rootDirectory, defaultPath)));
    if (!declared) continue;
    if (deferred.some(entry => entry.externalKind === externalKind)) continue;
    deferred.push({
      externalKind,
      reasonCode: reasonCode ?? `plugin.deferred.claude_${externalKind.replace(/-/g, '_')}`,
    });
    // A refused surface says so to the author, at install, once per bundle —
    // `warning` rather than `error` because the rest of the bundle is fine and
    // must still install.
    if (row.refusal) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        row.refusal.code,
        row.refusal.message,
        declaredPath,
        { kind: externalKind },
      ));
    }
  }
}

// --- plugin-shipped default settings ---------------------------------------

/**
 * `plugins-reference.md` § File locations reference — "**Settings** |
 * `settings.json` | Default configuration applied when the plugin is enabled.
 * Only the `agent` and `subagentStatusLine` keys are supported" (re-read
 * 2026-09-06; the word "currently" this quote used to carry is `plugins.md`'s,
 * not this table's).
 */
const CLAUDE_DEFAULT_SETTINGS_FILE = 'settings.json';

/**
 * The DEFENDED key list (P6.514, Q-den 45 = option 1: keep refusing `agent`,
 * honour the rest). The owner's own cost line for that option is *"the split
 * needs a defended key list"* — this is it, and the split is defended here
 * rather than implied by the shape of the two branches below.
 *
 * ## The list, and why it is exactly two names
 *
 * `plugins.md` § Ship default settings with your plugin: *"Currently, only the
 * `agent` and `subagentStatusLine` keys are supported."* … *"Unknown keys are
 * silently ignored."* So the documented supported set is exactly these two, and
 * **everything else is not ours to refuse** — an author who parks foreign
 * metadata in `settings.json` gets the page's silence, deliberately, and gets it
 * without costing the bundle a `deferred` row.
 *
 * ## Why the honoured half is EMPTY today, which is the honest answer and not
 * an oversight
 *
 * `honoured: false` on both, for two DIFFERENT reasons, and the difference is
 * the point:
 *
 * - **`agent` — refused by POSTURE, permanently.** claude could carry it
 *   (`buildClaudeRuntimeAgentOptions` is the seam), so this is a decision, not a
 *   missing mechanism: a plugin that replaces the main thread's system prompt,
 *   tool restrictions and model merely by being enabled is the unattended
 *   default this fork refuses for `force-for-plugin` output styles too. One
 *   rule, two fields. Reversing it needs the owner (f053 Step 2), not a lane.
 * - **`subagentStatusLine` — refused for want of a SURFACE.** This fork renders
 *   no status line of any kind (f206 owns that gap), so the declared command has
 *   no runner and no trust gate. This one is a not-yet, and it becomes honourable
 *   the day a statusline exists — which is why it is a separate row here rather
 *   than folded into the posture above.
 *
 * So "honour the rest" resolves to the empty set at HEAD, and the list says so
 * out loud instead of leaving a reader to infer it from two `if` blocks. A key
 * that flips to `honoured: true` is applied through the host's own settings
 * composition and stops emitting a `deferred` row — which also stops costing the
 * bundle `compatibility.state: 'partial'`, and with it the durable activation
 * grants a partial bundle has purged on its next repair.
 */
const CLAUDE_SUPPORTED_PLUGIN_DEFAULT_SETTINGS = {
  agent: {
    honoured: false,
    externalKind: 'settings-agent',
    reasonCode: 'plugin.deferred.claude_settings_agent',
  },
  subagentStatusLine: {
    honoured: false,
    externalKind: 'settings-subagent-status-line',
    reasonCode: 'plugin.deferred.claude_settings_subagent_status_line',
  },
} as const satisfies Record<string, { honoured: boolean; externalKind: string; reasonCode: string }>;

/**
 * Read a plugin's declared default settings from BOTH documented spellings and
 * record what is not honoured.
 *
 * `plugins.md` § Ship default settings with your plugin: "Plugins can include a
 * `settings.json` file at the plugin root to apply default configuration when
 * the plugin is enabled. Currently, only the `agent` and `subagentStatusLine`
 * keys are supported." … "Settings from `settings.json` take priority over
 * `settings` declared in `plugin.json`. Unknown keys are silently ignored."
 *
 * Three of those four sentences are implemented here literally — the file is
 * read, the merge is file-over-manifest, and every key outside the supported
 * pair is dropped without a diagnostic, because "silently ignored" is the
 * contract for an unknown key and an author who parks foreign metadata in
 * `settings.json` must not be warned for it.
 *
 * The fourth — APPLYING the keys — is not implemented for EITHER supported key,
 * so each supported key the bundle actually set becomes its own `deferred` row
 * plus a refusal diagnostic naming it. Which keys those are, and why each is
 * refused, is {@link CLAUDE_SUPPORTED_PLUGIN_DEFAULT_SETTINGS} — read it before
 * changing anything here: the two reasons are DIFFERENT (a permanent posture
 * against replacing the main thread, and a surface this fork does not have), and
 * treating them as one is how the honourable one would get refused forever. One row per key rather than one row for the file is what makes the
 * documented priority rule representable at all: the `externalKind` dedupe in
 * `addClaudeRetainedSurfaceDeferrals` collapsed `plugin.json`'s `settings` block
 * and the root `settings.json` into a single record.
 *
 * Consequence, and it is the point: a `settings.json` that sets neither
 * supported key now produces NO record, so it no longer forces
 * `compatibility.state: 'partial'` and no longer costs the bundle its durable
 * activation grants on the next repair.
 */
async function normalizeClaudePluginDefaultSettings(
  rootDirectory: string,
  input: UnknownRecord,
  capabilities: PluginCapability[],
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
): Promise<PluginDefaultSettingsDescriptor | undefined> {
  const manifestSettings = claudeSettingsRecord(input.settings, 'settings', diagnostics);
  const fileSettings = existsSync(join(rootDirectory, CLAUDE_DEFAULT_SETTINGS_FILE))
    ? claudeSettingsRecord(
      await readClaudeJsonConfigFile(
        rootDirectory,
        CLAUDE_DEFAULT_SETTINGS_FILE,
        { kind: 'settings', fileLabel: 'settings' },
        diagnostics,
      ),
      CLAUDE_DEFAULT_SETTINGS_FILE,
      diagnostics,
    )
    : undefined;
  if (manifestSettings === undefined && fileSettings === undefined) return undefined;

  // "Settings from `settings.json` take priority over `settings` declared in
  // `plugin.json`" — a per-KEY priority, so the two objects merge rather than
  // one replacing the other.
  const merged: UnknownRecord = { ...manifestSettings, ...fileSettings };
  const declaringPath = (key: string): string => (
    fileSettings?.[key] !== undefined ? CLAUDE_DEFAULT_SETTINGS_FILE : 'settings'
  );

  let descriptor: PluginDefaultSettingsDescriptor | undefined;

  if (merged.agent !== undefined) {
    const path = declaringPath('agent');
    const agent = typeof merged.agent === 'string' ? merged.agent.trim() : '';
    if (agent === '') {
      // NOT the "unknown keys" case: `agent` is a supported key whose value is
      // unusable, and silence there would read as "applied".
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_settings_agent_invalid',
        'Claude plugin default setting `agent` must name one of the plugin\'s own agents as a non-empty string.',
        path,
        { kind: 'settings-agent' },
      ));
    } else {
      descriptor = { agent };
      // `plugins.md` — "Setting `agent` activates one of the plugin's custom
      // agents as the main thread". The name is keyed exactly as
      // `normalizeClaudeAgents` keys it (frontmatter `name`, else the file
      // basename). A dangling name is an authoring error, never a silent no-op:
      // the "silently ignored" sentence covers unknown KEYS.
      if (!capabilities.some(capability => capability.kind === 'agent' && capability.agent.name === agent)) {
        diagnostics.push(pluginDiagnostic(
          'warning',
          'plugin.format.claude_settings_agent_unknown',
          `Claude plugin default setting \`agent\` names "${agent}", which this plugin does not define.`,
          path,
          { kind: 'settings-agent', agent },
        ));
      }
      // From the defended list, never re-typed here: a key whose disposition
      // flips there must not keep a refusal spelled out at the call site.
      deferred.push({
        externalKind: CLAUDE_SUPPORTED_PLUGIN_DEFAULT_SETTINGS.agent.externalKind,
        reasonCode: CLAUDE_SUPPORTED_PLUGIN_DEFAULT_SETTINGS.agent.reasonCode,
      });
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_settings_agent_unsupported',
        `Claude plugin default setting \`agent\` ("${agent}") is recorded and not applied. Nessy has no`
          + " main-thread agent override, and a plugin silently replacing the main thread's system prompt,"
          + ' tool restrictions and model is the same unattended-default move this fork already refuses for'
          + ' output styles; the plugin\'s agents are still importable and dispatchable as subagents.',
        path,
        { kind: 'settings-agent', agent },
      ));
    }
  }

  if (merged.subagentStatusLine !== undefined) {
    // `statusline.md` § Subagent status lines — the value is
    // `{ "type": "command", "command": "…" }`, i.e. an executable declaration.
    // Its VALUE is deliberately not carried into the IR: this fork has no
    // statusline surface of any kind (f206 owns it), and an executable string
    // recorded with no runner and no trust gate is a declaration nothing can
    // honour and nothing can audit. The record says the surface was declared.
    deferred.push({
      externalKind: CLAUDE_SUPPORTED_PLUGIN_DEFAULT_SETTINGS.subagentStatusLine.externalKind,
      reasonCode: CLAUDE_SUPPORTED_PLUGIN_DEFAULT_SETTINGS.subagentStatusLine.reasonCode,
    });
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.claude_settings_subagent_status_line_unsupported',
      'Claude plugin default setting `subagentStatusLine` is recorded and not applied. Nessy renders no'
        + ' status line, so the declared command is never run.',
      declaringPath('subagentStatusLine'),
      { kind: 'settings-subagent-status-line' },
    ));
  }

  return descriptor;
}

/**
 * A settings block from either documented spelling, or `undefined` when it is
 * absent or not an object. A non-object IS reported: unlike an unknown key, a
 * malformed block means the author's whole declaration went unread.
 */
function claudeSettingsRecord(
  value: unknown,
  path: string,
  diagnostics: PluginDiagnostic[],
): UnknownRecord | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.claude_settings_not_object',
      `Claude plugin default settings at "${path}" must be a JSON object; the declaration was ignored.`,
      path,
      { kind: 'settings' },
    ));
    return undefined;
  }
  return value;
}

/** `plugins-reference.md` § File locations — the documented `bin/` folder. */
const CLAUDE_DEFAULT_BIN_DIR = 'bin';

/**
 * Command-bearing capability fields, i.e. every place this bundle already
 * executes a file of its own by path. `cwd`/`workingDirectory` are deliberately
 * NOT read: naming a directory is not executing what is inside it.
 */
function claudeExecutedCommandStrings(capabilities: PluginCapability[]): string[] {
  const values: string[] = [];
  const push = (command?: string, args?: string[]): void => {
    if (command !== undefined) values.push(command);
    if (args) values.push(...args);
  };
  for (const capability of capabilities) {
    if (capability.kind === 'mcp') push(capability.mcp.command, capability.mcp.args);
    else if (capability.kind === 'hook') push(capability.hook.command, capability.hook.args);
    else if (capability.kind === 'lsp') push(capability.lsp.command, capability.lsp.args);
    else if (capability.kind === 'monitor' && isCommandMonitorDescriptor(capability.monitor)) {
      push(capability.monitor.command);
    }
  }
  return values;
}

/**
 * Does any executed command string name `bin/<fileName>` of this bundle?
 *
 * The trailing `(?![\w.-])` is load-bearing and is the half a name-only check
 * gets wrong: without it `bin/local-mcp` is reported as covering a sibling file
 * `bin/local-mcp2`, and that file then loses its deferral and its warning. The
 * leading `(?:^|[^\w.-])` is the same guard at the other end, so a path ending
 * `.../mybin/tool` never counts as this bundle's `bin/tool`.
 */
function claudeCommandReferencesBinFile(values: string[], fileName: string): boolean {
  const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[^\\w.-])${CLAUDE_DEFAULT_BIN_DIR}[/\\\\]${escaped}(?![\\w.-])`);
  return values.some(value => pattern.test(value));
}

/**
 * The capability kinds whose runtime registration carries the bundle's
 * `pluginRuntime.rootPath` into the agent runtime view — the roots
 * `enabledPluginBundleRoots` (`data-paths.ts`) collects and
 * `appendPluginBinPath` turns into PATH entries. A bundle declaring only kinds
 * OUTSIDE this set contributes no root, so its `bin/` is unreachable however
 * many capabilities it has.
 *
 * MEASURED end-to-end per kind rather than read off the view's field list
 * (P2.162, 2026-08-25): one manifest capability of each kind through
 * `resolvePluginProjectionCandidates` -> `createCapabilityResolver().resolve`
 * -> `toAgentRuntime` -> `enabledPluginBundleRoots`, everything else enabled and
 * trusted. Seven kinds yielded one root; six yielded zero, each for its own
 * reason, and a field list would have got three of them wrong:
 *
 *  - `agent` reaches `view.agents`, but that group is not one of the eight
 *    `enabledPluginBundleRoots` reads AND `RuntimeAgentDefinition`
 *    (`resolver.ts:612`) has no `pluginRuntime` field for it to read — two
 *    independent reasons, so adding the group alone would not fix it;
 *  - `workflow` carries `pluginRuntime` on its binding and still lands in no
 *    view array at all (`views.ts` `case 'workflow'` pushes nothing);
 *  - `command` and `asset` never even reach their own candidate kind:
 *    `projection-candidates.ts` projects both as `unsupported-runtime`, which
 *    `isRunnable` then excludes, so `view.commands` carries no plugin entry;
 *  - `setting` (either with or without its `nessyExtensions` declaration) and
 *    `unsupported` are not executable and reach no group.
 *
 * The measurement's own positive control: a skill-only bundle produced exactly
 * one root, so a zero is a real absence and not a harness that resolved nothing.
 *
 * `monitor` bears a root in BOTH descriptor forms (schedule and command). The one
 * kind here with a residual escape is `output-style`: `pluginOutputStyleId`
 * returning `null` demotes it to `unsupported-runtime`, and that depends on the
 * installed plugin key, which no adapter can see.
 */
const CLAUDE_BUNDLE_ROOT_BEARING_KINDS: ReadonlySet<PluginCapabilityKind> = new Set([
  'skill',
  'mcp',
  'hook',
  'prompt-command',
  'lsp',
  'monitor',
  'output-style',
]);

/** Does any declared capability carry this bundle's root into the runtime view? */
function claudeBundleCarriesRuntimeRoot(capabilities: PluginCapability[]): boolean {
  return capabilities.some(capability => CLAUDE_BUNDLE_ROOT_BEARING_KINDS.has(capability.kind));
}

/**
 * `plugins-reference.md` § File locations, `bin/`: "Executables added to the
 * Bash tool's PATH. Files here are invokable as bare commands in any Bash tool
 * call while the plugin is enabled."
 *
 * Nessy DOES extend the Bash tool's PATH from a bundle (see below), so an
 * executable nothing else reaches is unrunnable only when no capability carries
 * the bundle root. That sentence used to read the other way round and was the
 * premise of the two exemptions below, which survive it. Two shapes were
 * reported as unrunnable and are not:
 *
 *  - an EMPTY `bin/`, or one holding only subdirectories — there is no command;
 *  - a `bin/` file this same bundle already executes by path. `{"command":
 *    "./bin/local-mcp"}` normalizes to `${NESSY_PLUGIN_ROOT}/bin/local-mcp` and
 *    runs; the folder name was the only thing wrong with it.
 *
 * Both used to push a `bin` record, and one deferral makes the whole report
 * `partial` — which `management-service-v2.ts:553` answers by PURGING every
 * durable activation grant for the plugin and demanding an explicit re-confirm.
 * A bundle that ships its own MCP server under `bin/` paid that price for a
 * directory name.
 *
 * **The PATH half IS built** (`appendPluginBinPath`, wired at
 * `claude-agent.ts` and `pi-agent.ts`), so on both shipping backends a `bin/`
 * executable of an ENABLED plugin does resolve as a bare command. This function
 * therefore no longer records the surface as deferred: doing so set
 * `compatibility.state` to `partial`, and `management-service-v2.ts` purges
 * every durable activation grant for a partial bundle on repair — a real cost
 * charged for a surface that works.
 *
 * One residual class remains, and it is a LOST COMPONENT rather than a cosmetic
 * one: the PATH entry is derived from the bundle roots the RUNTIME VIEW carries
 * (`enabledPluginBundleRoots`), so a bundle none of whose capabilities carries a
 * root contributes none and its `bin/` is unreachable — executables the page
 * above promises are "invokable as bare commands" that no call can reach. That
 * is NOT only the bundle declaring nothing: an agents-only or a workflows-only
 * bundle is in it too, which is why the gate reads
 * {@link CLAUDE_BUNDLE_ROOT_BEARING_KINDS} rather than a capability COUNT.
 *
 * It therefore rides BOTH channels, by the routing rule stated at
 * {@link addClaudeIgnoredDefaultFolderRecords}. A `PluginDiagnostic` is an
 * install-time value: it reaches `diagnosticCodes` on the install result and is
 * gone, so on its own it left the fact living only in
 * `compatibility.adapter.warnings` — the persisted channel whose only reader
 * (P2.155) is a one-shot install-success notice, deliberately non-gating and off
 * the screen with the toast. `deferred` is the durable channel with a live reader
 * (`toSafeDeferredCapabilities` -> the plugin detail view's badge), and one
 * entry makes the report `partial`, which is the honest state for a bundle that
 * lost a component. The `partial` cost the two exempt shapes above could not
 * afford does not fall on this one, and the reason is measured rather than
 * assumed: `management-service-v2.ts:553` charges it on REPAIR by purging the
 * plugin's managed activation records, and a bundle in this class has no
 * capability whose purged record could have put anything on PATH — what gets
 * re-confirmed is the bundle whose `bin/` cannot run. A first install is not
 * gated at all; `requiresConfirmation` is set only on the repair path (`:572`).
 *
 * The diagnostic stays alongside it: `toSafeDeferredCapabilities` strips
 * `sourcePath` and carries no command list, and the names are the actionable
 * half of the report.
 */
function addClaudeBinSurfaceDeferral(
  rootDirectory: string,
  capabilities: PluginCapability[],
  deferred: PluginCompatibilityReport['deferred'],
  diagnostics: PluginDiagnostic[],
): void {
  let entries;
  try {
    entries = readdirSync(join(rootDirectory, CLAUDE_DEFAULT_BIN_DIR), { withFileTypes: true });
  } catch {
    // No bin/ at all, or unreadable — nothing to promise and nothing to warn about.
    return;
  }
  // A symlink counts: it is still a command an author expected to be invokable,
  // and refusing to name it would be the silent drop this record exists to stop.
  const executables = entries
    .filter(entry => entry.isFile() || entry.isSymbolicLink())
    .map(entry => entry.name)
    .sort();
  const executed = claudeExecutedCommandStrings(capabilities);
  const unreachable = executables.filter(name => !claudeCommandReferencesBinFile(executed, name));
  // The one gate for both "bin/ holds no command at all" and "every command in
  // it already runs": neither is an unrunnable surface, so neither is recorded.
  if (unreachable.length === 0) return;

  // A capability carrying a `pluginRuntime.rootPath` is what puts `bin/` on
  // PATH, so the gate is what CARRIES a root, never how many capabilities there
  // are: a count reported the bundle nobody ships (zero capabilities) and stayed
  // silent on two that people do (agents-only, workflows-only). The kinds are
  // measured, not inferred — see {@link CLAUDE_BUNDLE_ROOT_BEARING_KINDS}.
  if (claudeBundleCarriesRuntimeRoot(capabilities)) return;
  const named = unreachable.length > 10
    ? `${unreachable.slice(0, 10).join(', ')} (+${unreachable.length - 10} more)`
    : unreachable.join(', ');
  // Name the cause, because the two members of the class need different advice:
  // a bundle declaring nothing needs any root-bearing capability, and an
  // agents-only bundle already declares capabilities and needs a DIFFERENT kind.
  // "Add any capability" was the old advice and was measurably wrong.
  const declaredKinds = [...new Set(capabilities.map(capability => capability.kind))].sort();
  const cause = declaredKinds.length === 0
    ? 'This plugin declares no capability'
    : `This plugin declares only ${declaredKinds.join(', ')} capabilities`;
  const rootBearing = [...CLAUDE_BUNDLE_ROOT_BEARING_KINDS].join(', ');
  // The durable half. Ordered before the diagnostic so the two are read as one
  // record: the deferral is what survives the install, the diagnostic is what
  // names the files.
  deferred.push({
    externalKind: 'bin',
    reasonCode: 'plugin.deferred.claude_bin_unreachable',
    sourcePath: CLAUDE_DEFAULT_BIN_DIR,
  });
  diagnostics.push(pluginDiagnostic(
    'warning',
    'plugin.format.claude_bin_path_unsupported',
    `${cause}, so nothing carries its bundle root and ${named} will not resolve`
      + ' as bare commands in a Bash tool call. Declare a capability that carries one'
      + ` (${rootBearing}), or reference them by bundle-relative path`
      + ' (${NESSY_PLUGIN_ROOT}/bin/<name>).',
    CLAUDE_DEFAULT_BIN_DIR,
    { kind: 'bin', commands: unreachable },
  ));
}

/**
 * Core-surface manifest fields whose value can override the documented
 * default directory/file for that surface (`skills`/`commands`/`agents` as a
 * string dir or array of paths; `hooks`/`mcpServers`/`mcp` as a string path).
 * `field` is the manifest key read; `reasonField` is the label used to build
 * both the `deferred` externalKind (`custom-<reasonField>-path`) and its
 * reasonCode (`plugin.deferred.claude_custom_path_<reasonField>`) — kept
 * distinct from `field` so `mcpServers`/`mcp` (either manifest spelling) both
 * report under the single `mcp` label.
 */
const CLAUDE_CUSTOM_PATH_FIELDS: Array<{ field: string; reasonField: string }> = [
  { field: 'skills', reasonField: 'skills' },
  { field: 'commands', reasonField: 'commands' },
  { field: 'agents', reasonField: 'agents' },
  { field: 'workflows', reasonField: 'workflows' },
  { field: 'outputStyles', reasonField: 'outputStyles' },
  { field: 'hooks', reasonField: 'hooks' },
  { field: 'mcpServers', reasonField: 'mcp' },
  { field: 'mcp', reasonField: 'mcp' },
];

/**
 * One component-path field's resolution, plus who declared it.
 *
 * `authorityDeclared` is what `plugins/manifest-reference.md#how-each-key-combines-with-its-default-location`'s REPLACES rule turns
 * on: "when the manifest specifies `commands`, the default `commands/` directory
 * is not scanned". The authority is `plugin.json` whenever the bundle has one
 * (F1.1034: `strict: false` over it is a conflict or "as with `true`"), and the
 * marketplace entry, under either `strict`, when it has none (F1.1059: "the
 * entry is the manifest regardless of `strict`"; `manifestIsAuthority` is false).
 *
 * An entry over a `plugin.json` is therefore NOT an authority: the Strict mode
 * table says "Claude Code appends the entry's component fields to it", so its
 * paths load ALONGSIDE the default folder rather than displacing it. Keying
 * REPLACES off "either side declared" silently deleted a plugin's own
 * `commands/` the moment a marketplace entry added one command to it. The
 * vendored 2.1.267 loader keeps that folder in this case too.
 */
export interface ClaudeComponentPathResolution extends ManifestComponentPathResolution {
  authorityDeclared: boolean;
}

/** Every component-path field's resolution, keyed by its report label. */
export interface ClaudeManifestPaths {
  skills: ClaudeComponentPathResolution;
  commands: ClaudeComponentPathResolution;
  agents: ClaudeComponentPathResolution;
  workflows: ClaudeComponentPathResolution;
  outputStyles: ClaudeComponentPathResolution;
  hooks: ClaudeComponentPathResolution;
  /** `mcpServers` is the documented spelling; `mcp` is our earlier one. */
  mcp: ClaudeComponentPathResolution;
}

/**
 * Fields whose declared path AND documented inline configuration object are both
 * read — `:638`'s "own merge rules" fields, whose merge semantics this adapter
 * now implements (`collectClaudeConfigSources`). They are listed here so the
 * deferral reader stops recording as unread what it is now reading; every other
 * component field is path-only, and an inline object there still has no reader.
 */
const CLAUDE_FOLLOWED_CONFIG_FIELDS: ReadonlyArray<keyof ClaudeManifestPaths> = ['hooks', 'mcp'];

/**
 * Combine a `plugin.json` component field with the same field on the plugin's
 * marketplace entry.
 *
 * `plugins/marketplace-reference.md#strict-mode` — with `strict: true` (the default) "`plugin.json`
 * is the authority. The marketplace entry can supplement it with additional
 * components, and both sources are merged." So neither side displaces the other:
 * path lists concatenate (manifest first, since it is the authority) and inline
 * config objects merge key-wise.
 *
 * Two shapes that cannot be combined — a path on one side and an inline config
 * object on the other — is the one case with no merge. The entry wins there,
 * because a marketplace operator who wrote a config object meant to configure
 * this plugin, and the caller is told which declaration went unread.
 */
function mergeClaudeComponentField(
  manifestValue: unknown,
  entryValue: unknown,
  field: string,
  diagnostics: PluginDiagnostic[],
): unknown {
  if (entryValue === undefined) return manifestValue;
  if (manifestValue === undefined) return entryValue;
  const manifestPaths = claudePathList(manifestValue);
  const entryPaths = claudePathList(entryValue);
  if (manifestPaths && entryPaths) return [...manifestPaths, ...entryPaths];
  if (isRecord(manifestValue) && isRecord(entryValue)) return { ...manifestValue, ...entryValue };
  diagnostics.push(pluginDiagnostic(
    'warning',
    'plugin.format.claude_marketplace_entry_shape_conflict',
    `Marketplace entry and plugin.json declare "${field}" in shapes that cannot be merged; the marketplace entry's declaration is used.`,
    field,
    { field },
  ));
  return entryValue;
}

/** A component value in its path-list form, or undefined when it is inline config. */
function claudePathList(value: unknown): unknown[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return undefined;
}

async function resolveClaudeManifestPaths(
  rootDirectory: string,
  input: UnknownRecord,
  entryFields: UnknownRecord,
  manifestIsAuthority: boolean,
  diagnostics: PluginDiagnostic[],
): Promise<ClaudeManifestPaths> {
  const resolved = {} as Record<string, ClaudeComponentPathResolution>;
  for (const { field, reasonField } of CLAUDE_CUSTOM_PATH_FIELDS) {
    // The entry has no second spelling: `mcp` is our own legacy manifest key and
    // a marketplace entry only ever writes the documented `mcpServers`.
    const entryValue = field === 'mcp' ? undefined : entryFields[field];
    // With NO `plugin.json` the entry is the authority under either `strict`
    // (F1.1059), and `input` is empty. Over a `plugin.json` the entry is a
    // supplement under either `strict` (F1.1034): a `strict: false` entry that
    // declares one of the six component fields never gets here (the gate above).
    const value = manifestIsAuthority
      ? mergeClaudeComponentField(input[field], entryValue, field, diagnostics)
      : entryValue;
    const resolution = await resolveClaudeComponentPaths(rootDirectory, field, value, diagnostics);
    const authorityDeclared = (manifestIsAuthority ? input[field] : entryValue) !== undefined;
    // `mcpServers` and `mcp` share one label; the documented spelling wins.
    if (resolved[reasonField]?.declared) continue;
    resolved[reasonField] = { ...resolution, authorityDeclared };
  }
  return resolved as unknown as ClaudeManifestPaths;
}

/**
 * The REPLACES fields this adapter follows, with the default folder each one
 * displaces. `skills` is absent by design: `:637` makes its default scan
 * unconditional, so nothing is ever ignored there. `hooks` and `mcpServers` are
 * absent too — `:638` gives them their own merge rules, and this adapter merges
 * their declared/inline sources WITH the default file rather than replacing it,
 * so nothing goes unread.
 *
 * ## The page names SIX and this list holds FOUR — P2.147, confirmed and split
 *
 * `plugins/manifest-reference.md#path-rules` (re-pointed 2026-10-01, F1.1033; quote
 * as read on the old reference page, 2026-09-03): *"**Replaces the default**: `commands`, `agents`,
 * `workflows`, `outputStyles`, `experimental.themes`, `experimental.monitors`."*
 * The two missing names are NOT a stale copy of a sibling list — the failure
 * shape the row expected. This constant is typed `keyof ClaudeManifestPaths`,
 * and neither `experimental.themes` nor `experimental.monitors` is one of those
 * keys: both are retained/normalized surfaces with readers of their own, so the
 * compiler could not accept them here and the two lists were never candidates to
 * drift. Each half resolves at its own reader instead:
 *
 *  - **`experimental.monitors` — REAL, and now warned.** `normalizeClaudeMonitors`
 *    reads the default `monitors/monitors.json` only when the key is absent, so a
 *    declaring plugin displaced it silently. The same diagnostic code and
 *    deferred record this loop emits are now raised there.
 *  - **`experimental.themes` — REFUTED, and deliberately left alone.** There is
 *    no default scan to displace: plugin themes are not loaded at all, and the
 *    surface already carries a louder, unconditional record saying so ("Claude
 *    plugin themes are not loaded"). An ignored-default warning beside it would
 *    add a second, weaker sentence about a folder nothing was going to read.
 */
const CLAUDE_REPLACED_DEFAULT_FOLDERS: ReadonlyArray<{
  field: keyof ClaudeManifestPaths;
  defaultFolder: string;
}> = [
  { field: 'commands', defaultFolder: CLAUDE_DEFAULT_COMMANDS_DIR },
  { field: 'agents', defaultFolder: CLAUDE_DEFAULT_AGENTS_DIR },
  { field: 'workflows', defaultFolder: CLAUDE_DEFAULT_WORKFLOWS_DIR },
  { field: 'outputStyles', defaultFolder: CLAUDE_DEFAULT_OUTPUT_STYLES_DIR },
];

/**
 * `:640` — "When a plugin has both a default folder and the matching manifest
 * key, Claude Code v2.1.140 and later warns about the ignored folder in `claude
 * plugin list` and the `/plugin` detail view. The plugin still loads using the
 * manifest paths. Claude Code doesn't warn when the manifest key points into the
 * default folder, for example `"commands": ["./commands/deploy.md"]`, because
 * that path names the folder explicitly."
 *
 * Routed to `compatibility.deferred` because that is the only surface with a
 * live reader — `toSafeDeferredCapabilities` (`handlers/rpc/marketplace.ts`) →
 * `SafeMarketplacePluginDeferredCapability` → the plugin detail view's badge and
 * install summary, which is the `/plugin` detail view `:640` names.
 * `config/config-doctor.ts` scopes itself in its own header to the settings half
 * of `/doctor` ("A diagnostics surface that shows everything shows nothing") and
 * runs session-free from the CLI, which is not where a plugin's component layout
 * belongs. A warning diagnostic carrying the folder name is emitted alongside,
 * since `deferred` entries are deliberately path-free.
 *
 * **The third channel, and the rule for it (P2.146).**
 * `compatibility.adapter.warnings` — written at five sites (`schema.ts`,
 * `format-adapters.ts`, `format-adapters/shared.ts`, `codex.ts`, and
 * `normalizeClaudePluginBundle`'s manifest build here), each of them the same `diagnostics.filter(severity === 'warning')` — is
 * NOT an alternative to either of the two above, and routing an author-visible
 * finding there alone is the mistake this comment exists to prevent: it is
 * persisted into the installed `plugin.json`. It had zero readers outside tests
 * until P2.155 built the one its contract specified: `summarizeInstalled` reads
 * the codes off the STORED manifest, the install RPC crosses them as
 * `adapterWarnings`, and `plugin-install-state.ts`'s `installNotesNotice` raises
 * them as a notice AFTER the success toast. That reader is one-shot and
 * non-gating BY DESIGN, so it is still not where a finding an author must act on
 * belongs. It is kept rather than deleted because it is the deliberate
 * NON-GATING record: a
 * `deferred` entry flips `state` to `partial` (`buildClaudeCompatibilityReport`)
 * and gates the install
 * behind a confirmation, which is right for a lost component and wrong for
 * dropped listing metadata — the split `codex-contract-fields.test.ts` states
 * and pins. Its reader is the install-SUCCESS notice named above. Anything an
 * author must ACT on still rides `deferred` (durable, read, and the thing that
 * makes the report honest about a lost component) or `diagnostics` (install-time,
 * read as `diagnosticCodes`); a finding that rides only this field is told to the
 * user exactly once, at install, and is unrecoverable afterwards.
 */
function addClaudeIgnoredDefaultFolderRecords(
  rootDirectory: string,
  declaredPaths: ClaudeManifestPaths,
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
): void {
  for (const { field, defaultFolder } of CLAUDE_REPLACED_DEFAULT_FOLDERS) {
    const resolution = declaredPaths[field];
    // Only the AUTHORITY's declaration displaces the folder, so only that can
    // leave it unread. A supplementing marketplace entry does not.
    if (!resolution.authorityDeclared || resolution.paths.length === 0) continue;
    if (!existsSync(join(rootDirectory, defaultFolder))) continue;
    // The documented exception: a declared path naming the default folder, or
    // anything inside it, names the folder explicitly and is not an override of
    // it.
    if (resolution.paths.some(entry => manifestPathIsWithinDefault(entry.path, defaultFolder))) continue;
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.claude_default_folder_ignored',
      `Claude plugin declares "${field}", so the default "${defaultFolder}/" folder is not scanned. The plugin still loads using the manifest paths.`,
      defaultFolder,
      { field, path: defaultFolder },
    ));
    deferred.push({
      externalKind: `ignored-default-${field}-folder`,
      reasonCode: 'plugin.deferred.claude_default_folder_ignored',
    });
  }
}

function addClaudeCustomPathDeferrals(
  declaredPaths: ClaudeManifestPaths,
  deferred: PluginCompatibilityReport['deferred'],
): void {
  for (const [reasonField, resolution] of Object.entries(declaredPaths)) {
    // An empty collection declares nothing, exactly like an absent field, so it
    // is a valid no-op rather than a surface to report (same rule the LSP
    // collection already follows).
    if (!resolution.declared) continue;
    const followed = CLAUDE_FOLLOWED_CONFIG_FIELDS.includes(reasonField as keyof ClaudeManifestPaths);
    if (resolution.inline) {
      // Present but not a path. `hooks` and `mcpServers` accept a documented
      // INLINE config object and now have a reader for it, so only the
      // path-only fields still record one here rather than vanishing with no
      // capability and no record.
      if (!followed) {
        deferred.push({
          externalKind: `inline-${reasonField}-config`,
          reasonCode: 'plugin.deferred.claude_inline_config',
        });
      }
      continue;
    }
    if (resolution.paths.length === 0) {
      // Declared, but every entry was refused by the containment gate. The
      // per-entry diagnostics already say why; recording it as a deferred
      // surface keeps the "nothing is dropped without a record" invariant.
      deferred.push({
        externalKind: `custom-${reasonField}-path`,
        reasonCode: 'plugin.deferred.claude_custom_path_uncontained',
      });
      continue;
    }
  }
}

// --- token rewriting ---------------------------------------------------------

/**
 * Rewrites Claude's documented plugin-runtime variables to the canonical
 * Nessy aliases inside parsed command/args/cwd/env/header/url text only
 * (item 8). Follows the same normalization-time rewriting convention
 * `format-adapters/codex.ts` established for `${CLAUDE_PLUGIN_ROOT}` — this
 * is not a second rewriting path, it extends that one with the Claude-only
 * `CLAUDE_PLUGIN_DATA`/`CLAUDE_PROJECT_DIR` aliases Codex manifests never
 * declare. Never evaluates or rewrites arbitrary shell text.
 */
const CLAUDE_TOKEN_REWRITES: Array<[string, string]> = [
  ['CLAUDE_PLUGIN_ROOT', 'NESSY_PLUGIN_ROOT'],
  ['CLAUDE_PLUGIN_DATA', 'NESSY_PLUGIN_DATA'],
  ['CLAUDE_PROJECT_DIR', 'NESSY_PROJECT_DIR'],
];

function rewriteClaudeTokens(value: string): string {
  let rewritten = value;
  for (const [claudeName, nessyName] of CLAUDE_TOKEN_REWRITES) {
    rewritten = rewritten
      .replace(new RegExp(`\\$\\{${claudeName}\\}`, 'g'), `\${${nessyName}}`)
      .replace(new RegExp(`\\$${claudeName}\\b`, 'g'), `$${nessyName}`);
  }
  return rewritten;
}

function rewriteClaudeTokensInRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, rewriteClaudeTokens(value)]));
}

// --- path helpers -------------------------------------------------------------

/**
 * Thin wrapper over the shared manifest-path resolver so the Claude reason code
 * is preserved. The normalization and containment rules are the shared ones
 * (`manifest-paths.ts`) — this used to be a byte-identical copy of the Codex
 * adapter's version.
 */
function normalizeClaudeRelativePath(
  rawPath: string,
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
  options: { allowDirectory?: boolean } = {},
): string | undefined {
  return resolveManifestRelativePath(rawPath, diagnostics, diagnosticPath, {
    reasonCode: 'plugin.format.claude_path_invalid',
    ...options,
  });
}

/**
 * Resolve one manifest component-path field through the shared resolver,
 * reporting every refused entry as a Claude path diagnostic and dropping it from
 * the accepted set. Escaping entries are also dropped from `declared`'s meaning:
 * a field that declared nothing but escapes resolves to no paths at all, so a
 * caller can never build an absolute path out of one.
 *
 * Symlink containment (`:781`) is a second, filesystem-aware pass — the pure
 * string gate cannot see through a link — and runs before any component read.
 */
async function resolveClaudeComponentPaths(
  rootDirectory: string,
  field: string,
  value: unknown,
  diagnostics: PluginDiagnostic[],
): Promise<ManifestComponentPathResolution> {
  const resolution = resolveManifestComponentPaths(value, { field });
  for (const rejection of resolution.rejected) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.claude_path_invalid',
      rejection.reason,
      rejection.diagnosticPath,
      { path: rejection.raw },
    ));
  }
  const contained: ManifestComponentPath[] = [];
  for (const entry of resolution.paths) {
    if (await manifestPathEscapesBundle(rootDirectory, entry.path)) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.claude_path_invalid',
        `Path resolves outside the plugin bundle: ${entry.path}`,
        entry.diagnosticPath,
        { path: entry.path },
      ));
      continue;
    }
    contained.push(entry);
  }
  return { ...resolution, paths: contained };
}

function incompleteClaudeCapability(kind: string, path: string, message: string): PluginDiagnostic {
  return pluginDiagnostic(
    'warning',
    'plugin.format.claude_capability_incomplete',
    message,
    path,
    { kind },
  );
}

/**
 * F1.1025 — `plugins-reference.md` § `lspServers`: `extensionToLanguage` is the
 * "Map of file extension to LSP language ID, at least one entry. Keys start with
 * a dot, such as `".go"`". This adapter used to keep only the map's VALUES (as
 * `languages`), so nothing past it could tell a document's language from its
 * extension. The map is now carried, entry by entry, as declared:
 *   - with its case: the official `clangd-lsp` maps `.c` to `c` and `.C` to
 *     `cpp`, so folding case would change a file's language;
 *   - an entry whose key does not start with a dot, whose value is not a
 *     string, or whose language the server does not own (possible only beside
 *     our own `languages` spelling) is NOT carried, and is refused BY NAME on
 *     the same code as a malformed supervision knob. The server still starts,
 *     and a request that names its language still reaches it — only routing by
 *     that extension is lost, which the diagnostic says.
 * `languages` is deliberately left as it was computed above (every string
 * value), so no server that started before this change stops starting.
 * Returns a spreadable field: `{}` when nothing is left to carry.
 */
function claudeLspExtensionMapField(
  value: unknown,
  languages: readonly string[],
  diagnosticPath: string,
  lspId: string,
  diagnostics: PluginDiagnostic[],
): { extensionToLanguage?: Record<string, string> } {
  if (!isRecord(value)) return {};
  const carried: Record<string, string> = {};
  for (const [extension, languageId] of Object.entries(value)) {
    // The dot check also keeps `__proto__` and its kin out of `carried`.
    if (extension.length > 1 && extension.startsWith('.') && typeof languageId === 'string' && languages.includes(languageId)) {
      carried[extension] = languageId;
      continue;
    }
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.claude_lsp_field_invalid',
      `Claude LSP server "${lspId}" maps "${extension}" in extensionToLanguage to something that is not a dotted extension and one of its language ids; files with that extension are not routed to it by extension, and a request must name the language.`,
      `${diagnosticPath}.extensionToLanguage`,
      { kind: 'lsp', serverName: lspId, extension },
    ));
  }
  return Object.keys(carried).length > 0 ? { extensionToLanguage: carried } : {};
}

// --- marketplace entry fields over a plugin.json (F1.1032) -------------------

/**
 * The entry fields that do NOT apply once the bundle has its own `plugin.json`.
 *
 * `plugins/marketplace-reference.md` § "How an entry combines with plugin.json"
 * (`#entry-and-plugin-json`, read 2026-09-28): "**`plugin.json` present**:
 * `plugin.json` is the manifest. [...] Entry `mcpServers`, `lspServers`,
 * `userConfig`, and `channels` don't apply. Declare them in `plugin.json`." Its
 * other bullet is the manifestless case: "**No `plugin.json`**: the entry is the
 * manifest regardless of `strict`. Every manifest field in the entry applies,
 * including `mcpServers`, `lspServers`, `userConfig`, and `channels`".
 *
 * Before this, entry `mcpServers` merged into a `plugin.json`'s under
 * `strict: true` (and replaced it under `strict: false`), and entry `lspServers`
 * merged under both, so a catalog row could add servers the plugin's own
 * manifest never declared. The entry's `userConfig` and `channels` were never
 * read at all, which was right over a `plugin.json` and a silent drop without one.
 *
 * The page does not say whether Claude Code tells anyone. We warn, once per
 * field, because an entry declaration that silently does nothing looks exactly
 * like a defect (AGENTS.md, "transparent and simple"). A warning and not a
 * `deferred` record: nothing the PLUGIN declared is lost, and a deferral would
 * mark the bundle partial, which purges its durable grants on the next repair.
 *
 * `settings` and `monitors` (and `experimental.monitors`) join them (F1.1036):
 * they are manifest fields and not among the six component fields, and with a
 * `plugin.json` present "`plugin.json` is the manifest". The vendored Claude Code
 * 2.1.267 loader agrees: over a `plugin.json` it takes only the entry's display
 * fields and component fields. `experimental.themes` is the page's `themes`
 * component field, so it stays and combines like the other five.
 */
const CLAUDE_ENTRY_FIELDS_NOT_APPLIED_OVER_MANIFEST = [
  'mcpServers', 'lspServers', 'userConfig', 'channels', 'settings', 'monitors',
] as const;

function claudeEntryFieldsThatApply(
  entryFields: UnknownRecord,
  manifestless: boolean,
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
): UnknownRecord {
  const applied: UnknownRecord = { ...entryFields };
  // With or without a plugin.json (F1.1058, see the function at the file end).
  dropClaudeEntryHooksInPathOrArrayForm(applied, diagnostics, deferred);
  if (manifestless) return applied;
  const notApplied = (field: string): void => {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.claude_marketplace_entry_field_not_applied',
      `The marketplace entry declares "${field}", which does not apply because the plugin has its own`
        + ' plugin.json; declare it in plugin.json instead (Claude Code docs, plugins/marketplace-reference: "How an entry combines with plugin.json").',
      field,
      { field },
    ));
  };
  for (const field of CLAUDE_ENTRY_FIELDS_NOT_APPLIED_OVER_MANIFEST) {
    if (applied[field] === undefined) continue;
    delete applied[field];
    notApplied(field);
  }
  if (isRecord(applied.experimental) && applied.experimental.monitors !== undefined) {
    const { monitors: _monitors, ...kept } = applied.experimental;
    applied.experimental = kept;
    notApplied('experimental.monitors');
  }
  return applied;
}

// --- the strict: false conflict is asked of the ENTRY (F1.1034) --------------

/**
 * Whether a `strict: false` entry over a bundle WITH its own `plugin.json` is the
 * conflict that stops the plugin loading.
 *
 * `plugins/marketplace-reference.md` § Strict mode (`#strict-mode`, read
 * 2026-09-28): "With `strict: false`, an entry that declares any component field
 * is a conflict, and the plugin fails to load." Its table: "`false` | present |
 * none | `plugin.json` is the manifest, as with `true`" and "`false` | present |
 * one or more | Conflict." The component fields are the six named by § "How an
 * entry combines with plugin.json" (`#entry-and-plugin-json`): "`commands`,
 * `agents`, `skills`, `hooks`, `outputStyles`, and `themes`".
 *
 * This used to ask whether `plugin.json` declared components, which is the
 * opposite test: an entry setting `headersHelper` (which "must also set
 * `"strict": false`") over a plugin whose own `plugin.json` lists its commands
 * was refused, while Claude loads it, and a component-declaring entry over a
 * metadata-only `plugin.json` loaded, while Claude refuses it.
 *
 * The six are the detection set minus the three it holds beyond them:
 * `workflows` (the superset that "can only make us ACCEPT an entry, never reject
 * one", see `CLAUDE_ENTRY_COMPONENT_FIELDS`) and the two server maps, which
 * "don't apply" over a `plugin.json` ({@link claudeEntryFieldsThatApply}) and are
 * not a conflict. `experimental.themes` counts as `themes` does; the vendored
 * Claude Code 2.1.267 loader tests that spelling beside the six in the check
 * that logs "has both plugin.json and marketplace manifest entries for" them.
 *
 * WITHOUT a `plugin.json` the page says "the entry is the manifest regardless of
 * `strict`", so since F1.1059 a `strict: true` entry there displaces a default
 * `commands/` folder as a manifest's `commands` does (`manifestIsAuthority`).
 * The vendored 2.1.267 loader still loads that folder beside the entry's paths;
 * the page is the contract and is ahead of that bundle (it names later versions).
 */
function claudeEntryDeclaresConflictingComponents(entryFields: UnknownRecord): boolean {
  if (isRecord(entryFields.experimental) && entryFields.experimental.themes !== undefined) return true;
  return CLAUDE_ENTRY_COMPONENT_FIELDS.some(field => field !== 'workflows'
    && field !== 'mcpServers' && field !== 'lspServers' && entryFields[field] !== undefined);
}

// --- entry hooks over a plugin.json replace per event (F1.1035) ---------------

/**
 * The marketplace entry's `hooks` when they REPLACE the plugin's matchers per
 * event, or `undefined` when the older merge still applies.
 *
 * `plugins/manifest-reference.md` § "How entry fields combine with
 * `plugin.json`" (`#how-entry-fields-combine-with-plugin-json`, read
 * 2026-09-28): "**`plugin.json` present, `strict` unset or `true`**: [...] For
 * `hooks`, the entry's matchers for an event replace the manifest's matchers for
 * that same event, and events only the manifest declares keep theirs". The
 * marketplace reference's Strict mode table says the same ("except `hooks`,
 * whose matchers replace the manifest's per event"). A `strict: false` entry
 * that declares hooks over a `plugin.json` never gets here: it is the conflict
 * (`claudeEntryDeclaresConflictingComponents`).
 *
 * Before, the entry's hooks went through `mergeClaudeComponentField` like a
 * path list: an inline entry map over a manifest `hooks` PATH was a shape clash
 * the entry won WHOLESALE, so every event of the manifest's hooks file was
 * dropped, and the default `hooks/hooks.json` still loaded in full beside the
 * entry's matchers for the same event.
 *
 * Which matchers are "the manifest's": the page does not say whether the default
 * `hooks/hooks.json` counts. The vendored Claude Code 2.1.267 loader answers it:
 * it builds the plugin's hooks from the standard hooks file plus every manifest
 * source first (its duplicate message says "The standard hooks/hooks.json is
 * loaded automatically"), then spreads the entry's map over that whole object,
 * so the default file's matchers for an entry event are replaced too. We follow
 * the loader.
 *
 * Scope, stated: only the inline event map the page documents ("Write entry
 * `hooks` as an inline object that maps hook event names to matcher arrays"),
 * and only over a `plugin.json`. Without one the entry IS the manifest and its
 * map merges with the default file like a manifest's. A path or array form never
 * gets here: the page says those "never run" in an entry, so
 * {@link dropClaudeEntryHooksInPathOrArrayForm} has already removed it (F1.1058).
 */
function claudeEntryHooksThatReplacePerEvent(entryFields: UnknownRecord, manifestless: boolean): UnknownRecord | undefined {
  const value = entryFields.hooks;
  // A record of path strings (the multi-path shape) was dropped with the other path forms (F1.1189).
  return manifestless || !isRecord(value) ? undefined : value;
}

/**
 * Drop, from every collected hooks source, the events the entry's map declares,
 * then add the entry's map as the last source. A source that is not an event map
 * is passed through whole, so the reader still reports it as malformed.
 */
function claudeEntryHooksReplacePerEvent(
  sources: Array<{ label: string; source: unknown }>,
  entryHooks: UnknownRecord | undefined,
): Array<{ label: string; source: unknown }> {
  if (!entryHooks) return sources;
  const entryMap = isRecord(entryHooks.hooks) ? entryHooks.hooks : entryHooks;
  const replaced = new Set(Object.keys(entryMap));
  const kept = sources.map(({ label, source }) => {
    const hookMap = isRecord(source) && isRecord(source.hooks) ? source.hooks : source;
    if (!isRecord(hookMap)) return { label, source };
    return { label, source: Object.fromEntries(Object.entries(hookMap).filter(([event]) => !replaced.has(event))) };
  });
  return [...kept, { label: 'marketplaceEntry.hooks', source: entryMap }];
}

// --- entry hooks load only as an inline event map (F1.1058) -------------------

/**
 * Remove the marketplace entry's `hooks` when they are written as a file path or
 * an array, and say so: those hooks do not load, with or without a `plugin.json`.
 *
 * `plugins/marketplace-reference.md` § "Hooks in an entry" (`#hooks-in-an-entry`,
 * read 2026-09-28): "Write entry `hooks` as an inline object that maps hook event
 * names to matcher arrays. If you write a file path or an array instead, `claude
 * plugin validate` passes it. Those hooks never run, and Claude Code reports a
 * `not yet supported in a marketplace entry` error for the plugin."
 * `plugins/manifest-reference.md` says the same for the manifest-less case: "Entry
 * `hooks` loads only in the inline object form". The vendored Claude Code 2.1.267
 * loader agrees and applies it whether or not the plugin has a `plugin.json`.
 *
 * Before, a path entry resolved like a manifest's `hooks` path (no `plugin.json`)
 * or merged into the manifest's (with one), so hooks Claude Code never runs ran here.
 *
 * Two choices, stated. (1) Claude Code "reports a ... error for the plugin" and
 * still loads its other components; an `error` diagnostic here would refuse the
 * whole install, so this is a warning plus a `deferred` record (the channel for a
 * component that does not load, shown on the plugin's detail view). (2) The
 * 2.1.267 loader goes further for an array that holds an inline object and refuses
 * the plugin; the page does not say that, so every path or array form is treated
 * the same way. A `strict: false` entry declaring `hooks` over a `plugin.json` never
 * gets here: in any form it is the conflict ({@link claudeEntryDeclaresConflictingComponents}).
 *
 * F1.1189 — a record whose values are all strings (`{ "main": "./extra-hooks.json" }`)
 * is the multi-path shape `resolveManifestComponentPaths` reads as file paths, not
 * the page's event map, so it is a file-path form too and is dropped the same way.
 * Before, it slipped past the string/array test and its files ran.
 */
function dropClaudeEntryHooksInPathOrArrayForm(
  applied: UnknownRecord,
  diagnostics: PluginDiagnostic[],
  deferred: PluginCompatibilityReport['deferred'],
): void {
  const value = applied.hooks;
  const asPaths = isRecord(value) ? resolveManifestComponentPaths(value, { field: 'hooks' }) : undefined;
  const pathRecord = asPaths !== undefined && (asPaths.paths.length > 0 || asPaths.rejected.length > 0);
  if (typeof value !== 'string' && !Array.isArray(value) && !pathRecord) return;
  delete applied.hooks;
  diagnostics.push(pluginDiagnostic(
    'warning',
    'plugin.format.claude_marketplace_entry_hooks_form_unsupported',
    'The marketplace entry declares "hooks" as a file path, an array or a record of file paths, which is not yet supported in a marketplace'
      + ' entry, so these hooks do not run. Write them in the entry as an inline object mapping hook event names to'
      + ' matcher arrays, or put file-based hooks in the plugin\'s own hooks/hooks.json or plugin.json.',
    'hooks',
    { field: 'hooks' },
  ));
  deferred.push({
    externalKind: 'marketplace-entry-hooks-path-or-array',
    reasonCode: 'plugin.deferred.claude_marketplace_entry_hooks_form_unsupported',
  });
}

// --- an entry's experimental members beside plugin.json's (F1.1190) ----------

/**
 * The fields {@link addClaudeRetainedSurfaceDeferrals} reads: the entry's that
 * apply, then `plugin.json`'s over them, with the two `experimental` objects
 * merged member by member rather than the manifest's replacing the entry's whole.
 *
 * `experimental.themes` is the page's `themes` component field, one of the six
 * that combine over a `plugin.json` (`plugins/marketplace-reference.md`
 * § "How an entry combines with plugin.json"), and since F1.1036 the catalog
 * carries the entry's `experimental`. A plain spread let a manifest that declares
 * `experimental: { monitors: ... }` hide the entry's `experimental.themes`, so the
 * refused `theme` surface got no deferral and no notice and the plugin read as
 * fully compatible. The manifest still wins a member both declare.
 */
function claudeRetainedSurfaceInput(appliedEntryFields: UnknownRecord, input: UnknownRecord): UnknownRecord {
  const merged: UnknownRecord = { ...appliedEntryFields, ...input };
  if (isRecord(appliedEntryFields.experimental) && isRecord(input.experimental)) {
    merged.experimental = { ...appliedEntryFields.experimental, ...input.experimental };
  }
  return merged;
}
