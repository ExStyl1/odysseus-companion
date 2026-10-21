/**
 * Codex `.codex-plugin/plugin.json` bundle adapter (A4 extraction).
 *
 * ## This format IS published. Read the contract before changing anything here.
 *
 * This adapter was originally derived EMPIRICALLY, from observed manifests
 * rather than from a specification, because `AGENTS.md` recorded that the Codex
 * help article "is not publicly fetchable". That is true of
 * `help.openai.com/en/articles/20001256-plugins-in-codex/` (HTTP 403, bot-blocked)
 * and false of everything else. Verified 2026-07-29 (R16), all by `curl -s`:
 *
 *  - `developers.openai.com/plugins/build/plugins.md` — the manifest spec:
 *    file layout, a complete example manifest, § *Manifest fields*,
 *    § *Path rules*, § *Bundled MCP servers and lifecycle hooks*.
 *  - `learn.chatgpt.com/docs/hooks.md` — the hook spec: § *Plugin-bundled hooks*
 *    gives the `hooks` field's four shapes, the default file and its precedence;
 *    § *Config shape* gives the handler fields; twelve `### <Event>` sections
 *    give the event schema.
 *  - `developers.openai.com/plugins/deploy/submission-errors.md` — a field-level
 *    validation contract: ~150 named errors covering per-field type,
 *    requiredness, length and format, plus a *Package warnings* table naming
 *    what the loader deliberately IGNORES.
 *  - `github.com/openai/plugins` — 180 real published manifests, plus
 *    `.agents/skills/plugin-creator/references/plugin-json-spec.md`, a second
 *    field guide (the one the official `@plugin-creator` skill reads), plus
 *    `plugins/plugin-eval/src/evaluators/plugin.js`, OpenAI's own manifest
 *    linter and the only executable contract artefact that exists.
 *
 * Every docs page has a Markdown twin at `<url>.md`. Fetch it with `curl`; a
 * summarising fetch tool invented field names twice in this series and both
 * inventions shipped.
 *
 * What is still NOT specified, so that absence is not rediscovered:
 *  - **No JSON Schema for `plugin.json` exists** — not on the docs site, not in
 *    `openai/plugins`, not in any published package.
 *  - `openai/plugins` carries no format docs, schema, or tests of its own.
 *  - Codex CLI is closed source, so there is no source-level contract to read
 *    the way `plugins-reference.md` backs the Claude adapter.
 *
 * Two Nessy surfaces here have NO Codex counterpart and are extensions, not
 * readings of the format — do not "fix" them towards Claude:
 *  - the `prompt`/`agent`/`http`/`mcp` hook branches. `hooks.md` documents
 *    `type: "command"` only, and no real manifest declares anything else.
 *  - the root `commands/` and `agents/` directory scans, and the `lsp` field.
 *
 * Where we knowingly differ from the published contract, the divergence and its
 * reason are in `docs/superpowers/plans/2026-07-29-codex-adapter-spec.md` § 8.
 *
 * Behavior-preserving move of the inline Codex normalization previously in
 * `format-adapters.ts` (`normalizeCodexPluginManifest` and its helpers), plus
 * two additions:
 *  - a `PluginCompatibilityReport` (A2) attached to the normalization result
 *    so callers (acquisition, A7) can read supported/deferred/blocked
 *    surfaces without re-deriving them from raw diagnostics;
 *  - the `codex-plugin-env-v1` runtime compatibility profile (A2), recorded
 *    on the normalized manifest whenever a retained Codex executable
 *    declaration (a command hook or a stdio MCP server) is present. This is
 *    IR-only: no provider runtime is enabled and no env is materialized here
 *    (A6 consumes the recorded profile at materialization).
 *
 * Capability `id` values for Codex-sourced capabilities are built with the
 * local `codexCapabilityId(kind, providerLocalId)` helper below, so
 * same-named capabilities of different kinds never collide on
 * `NessyPluginManifest.capabilities` id uniqueness (schema.ts's duplicate-id
 * check in `normalizeNessyPluginManifest` is kind-agnostic — same string id
 * on two different-kind capabilities is rejected as
 * `plugin.capability.duplicate_id` today). This intentionally does NOT call
 * the A2 `createPluginCapabilityId(kind, providerLocalId)` helper from
 * schema.ts: that helper joins with `:` (`"skill:review"`), which schema.ts's
 * own `validatePluginId` (used for every capability id via
 * `normalizePluginCapability`) rejects — `:` is outside the allowed
 * `[A-Za-z0-9._-]` charset, so every capability using it fails as
 * `plugin.capability.invalid_id`. That is a real, currently-uncaught gap in
 * `createPluginCapabilityId`'s output (A2's own test never round-trips it
 * through the validator); see the A4 report for detail. Using `.` as the
 * kind/name separator here proves the same distinct-id invariant the brief
 * requires while staying inside the validator's accepted charset and without
 * widening the shared validator (out of this phase's file scope). The
 * provider-facing logical name is unaffected either way: `skill.slug` /
 * `mcp.serverName` / `hook.id` / `agent.name` / `promptCommand.name` keep
 * their original bare values, which is what projection
 * (`projection-candidates.ts`) reads for `logicalName`.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import {
  isRecord,
  normalizeNessyPluginManifest,
  pluginDiagnostic,
  readHookArgsVector,
  validatePluginMcpCwd,
} from '../schema.ts';
import type {
  NessyPluginManifest,
  PluginAppDescriptor,
  PluginCapability,
  PluginCompatibilityReport,
  PluginConnectorDescriptor,
  PluginConnectorMcpServerDescriptor,
  PluginDiagnostic,
  PluginOrigin,
  PluginRuntimeCompatibilityProfile,
  PluginValidationResult,
} from '../types.ts';
import { normalizeMcpTransportAlias } from '../../mcp/server-config-values.ts';
import { mapExternalHookEventName } from '../format-adapters.ts';
import {
  CODEX_MANIFEST_RELATIVE_PATH,
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
  declaresManifestDefaultPath,
  isManifestDirectory,
  isManifestFile,
  resolveManifestComponentPaths,
  resolveManifestRelativePath,
  scanManifestSkillDirectory,
} from './manifest-paths.ts';
import {
  hasMaterializablePluginPackageRunner,
  parsePluginPackageRunnerArgs,
  qualifyPluginStdioCommand,
} from '../stdio-command.ts';

/** Adapter identity constants; kept in sync with the detector in format-adapters.ts. */
export const CODEX_ADAPTER_ID = 'codex-plugin-json';
export const CODEX_ADAPTER_VERSION = '1';
// Re-exported, not declared: the barrel reads this one at MODULE-INIT time, and
// a binding declared here was in its temporal dead zone whenever the graph was
// entered through this file. `shared.ts` carries the whole measurement.
export { CODEX_MANIFEST_RELATIVE_PATH };
const CODEX_DEFAULT_SKILLS_DIR = 'skills';
/**
 * A bundled skill's own Codex-facing metadata file, relative to its SKILL.md.
 *
 * `plugins/deploy/submission-errors.md` § *Skill agent metadata errors*,
 * verbatim: "A bundled skill can define its own `interface` in
 * `skills/<skill>/agents/openai.yaml`." — so this sits BESIDE the skill, and is
 * not the plugin-root `agents/` directory `normalizeCodexAgents` scans.
 */
const CODEX_SKILL_AGENT_FILE = join('agents', 'openai.yaml');
const CODEX_DEFAULT_MCP_FILE = '.mcp.json';
const CODEX_DEFAULT_APPS_FILE = '.app.json';
/**
 * `hooks.md` § *Plugin-bundled hooks*: "By default, Codex looks for
 * `hooks/hooks.json` inside the plugin root." That documented default was not
 * checked at all before R16.
 */
const CODEX_DEFAULT_HOOKS_FILE = 'hooks/hooks.json';
/**
 * The root `hooks.json`, which the documentation does not mention as a plugin
 * default — `~/.codex/hooks.json` and `<repo>/.codex/hooks.json` are *config
 * layer* locations, not plugin ones. Kept anyway, and deliberately: it is the
 * only form that occurs in practice. Both real hook files in `openai/plugins`
 * (`plugins/figma/hooks.json`, `plugins/replayio/hooks.json`) sit at the plugin
 * root with no manifest `hooks` entry, and `plugin-creator`'s own field guide
 * samples `"hooks": "./hooks.json"`. Dropping it to match the docs would
 * silently disable the hooks of two real published plugins.
 */
const CODEX_ROOT_HOOKS_FILE = 'hooks.json';
const CODEX_DEFAULT_COMMANDS_DIR = 'commands';
const CODEX_DEFAULT_AGENTS_DIR = 'agents';

/**
 * Kind-namespaced capability id builder, validator-safe (see the module
 * docstring for why this does not call the A2 `createPluginCapabilityId`).
 * `providerLocalId` is the raw Codex-facing name (skill slug, MCP server
 * name, or hook id) and is never itself validated/sanitized here — schema.ts
 * still validates the composed id through `validatePluginId`.
 */
function codexCapabilityId(
  kind: 'skill' | 'mcp' | 'hook' | 'agent' | 'prompt-command' | 'lsp',
  providerLocalId: string,
): string {
  return `${kind}.${providerLocalId}`;
}

function dedupeExact<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * `PluginFormatAdapter.normalize()` is fixed to return
 * `PluginValidationResult<NessyPluginManifest>` (types.ts). This adapter
 * additionally computes a `PluginCompatibilityReport` (A2); it rides along on
 * the same result object as an extra optional field rather than widening the
 * shared interface, so `normalizePluginBundle` (format-adapters.ts) reads it
 * through this type rather than the narrower interface type.
 */
export interface CodexNormalizationResult extends PluginValidationResult<NessyPluginManifest> {
  compatibility?: PluginCompatibilityReport;
}

export async function normalizeCodexPluginManifest(
  input: unknown,
  rootDirectory: string,
  origin: PluginOrigin,
): Promise<CodexNormalizationResult> {
  if (!isRecord(input)) {
    return {
      ok: false,
      diagnostics: [pluginDiagnostic('error', 'plugin.format.codex_manifest_not_object', 'Codex plugin manifest must be an object.')],
    };
  }

  const diagnostics: PluginDiagnostic[] = [];
  addCodexFieldDiagnostics(input, diagnostics);
  addCodexCapabilityDiagnostics(input.capabilities, diagnostics);

  const rawMcpInput = input.mcpServers ?? input.mcp_servers ?? input.mcp;
  const apps = dedupeExact([
    ...await normalizeCodexDefaultApps(rootDirectory, diagnostics, input.apps),
    ...await normalizeCodexApps(input.apps, rootDirectory, diagnostics),
  ]);
  const defaultMcp = await normalizeCodexDefaultMcpServers(
    rootDirectory,
    diagnostics,
    new Map(apps.map(app => [app.id, app.connectorId])),
    rawMcpInput,
  );
  const explicitMcp = await normalizeCodexMcpServers(
    rawMcpInput,
    rootDirectory,
    diagnostics,
    new Map(apps.map(app => [app.id, app.connectorId])),
  );
  const mcp = {
    capabilities: dedupeExact([...defaultMcp.capabilities, ...explicitMcp.capabilities]),
    connectors: dedupeExact([...defaultMcp.connectors, ...explicitMcp.connectors]),
  };

  // W7 Step 5: a generic Codex manifest registers only Codex surfaces.
  // Top-level settings/assets blocks never become setting/asset capabilities
  // accidentally; they are
  // retained for catalog/provenance via diagnostics (persisted in adapter
  // warnings), and only an explicit namespaced `nessyExtensions` section
  // activates the Nessy setting/command/asset extensions.
  const capabilities: PluginCapability[] = await applyCodexSkillAgentPolicy(rootDirectory, diagnostics, dedupeExact([
    ...await normalizeCodexDefaultSkills(rootDirectory, diagnostics, input.skills),
    ...await normalizeCodexSkills(input.skills, rootDirectory, diagnostics),
    ...mcp.capabilities,
    ...await normalizeCodexDefaultHooks(rootDirectory, diagnostics, input.hooks),
    ...await normalizeCodexHooks(input.hooks, rootDirectory, diagnostics),
    ...await normalizeCodexPromptCommands(rootDirectory, diagnostics),
    ...await normalizeCodexAgents(rootDirectory, diagnostics),
    ...normalizeCodexLspServers(input.lsp, diagnostics),
  ]));
  addCodexExtensionRetentionDiagnostics(input, diagnostics);
  addCodexDroppedMetadataDiagnostics(input, diagnostics);

  const codexInterface = isRecord(input.interface) ? input.interface : undefined;
  const author = isRecord(input.author) ? input.author : undefined;
  const nativeCandidate = {
    schemaVersion: 1,
    kind: 'plugin',
    id: stringField(input, 'id') ?? stringField(input, 'pluginId') ?? stringField(input, 'name'),
    name: stringField(codexInterface ?? {}, 'displayName') ?? stringField(input, 'displayName') ?? stringField(input, 'name'),
    version: stringField(input, 'version'),
    ...(stringField(input, 'description') ?? stringField(codexInterface ?? {}, 'shortDescription') ? {
      description: stringField(input, 'description') ?? stringField(codexInterface ?? {}, 'shortDescription'),
    } : {}),
    ...(stringField(input, 'publisher') ?? stringField(author ?? {}, 'name') ?? stringField(codexInterface ?? {}, 'developerName') ? {
      publisher: stringField(input, 'publisher') ?? stringField(author ?? {}, 'name') ?? stringField(codexInterface ?? {}, 'developerName'),
    } : {}),
    ...(stringField(input, 'homepage') ?? stringField(input, 'homepageUrl') ?? stringField(codexInterface ?? {}, 'websiteURL') ? {
      homepageUrl: stringField(input, 'homepage') ?? stringField(input, 'homepageUrl') ?? stringField(codexInterface ?? {}, 'websiteURL'),
    } : {}),
    capabilities,
    // K1: pass the declarative `apps`/`connectors` blocks through verbatim; the
    // native normalizer validates each descriptor and drops malformed entries.
    // These are DATA — no capability, no executable, no secret.
    ...(apps.length > 0 ? { apps } : {}),
    ...((Array.isArray(input.connectors) || mcp.connectors.length > 0)
      ? { connectors: [...(Array.isArray(input.connectors) ? input.connectors : []), ...mcp.connectors] }
      : {}),
    // Pass the explicit namespaced section through verbatim; the native
    // normalizer validates it. Never synthesized from top-level blocks.
    ...(isRecord(input.nessyExtensions) ? { nessyExtensions: input.nessyExtensions } : {}),
  };

  if (isRecord(input.install) && (stringField(input.install, 'command') ?? stringField(input.install, 'cmd'))) {
    diagnostics.push(pluginDiagnostic(
      'info',
      'plugin.format.install_command_ignored',
      'Codex plugin install command is metadata only and will not be executed.',
      'install.command',
    ));
  }

  const result = normalizeNessyPluginManifest(nativeCandidate, {
    origin: {
      ...origin,
      adapterId: CODEX_ADAPTER_ID,
      adapterVersion: CODEX_ADAPTER_VERSION,
    },
  });
  if (!result.value) {
    return {
      ok: result.ok,
      diagnostics: [...diagnostics, ...result.diagnostics],
    };
  }

  // K1 losslessness: a present, non-empty `apps`/`connectors` array whose
  // entries were ALL dropped as malformed must not vanish silently. Report it
  // so the compatibility surface still reflects the discarded declaration.
  addCodexDeclarativeDropDiagnostics('apps', input.apps, result.value.apps, diagnostics);
  // T9 (§ 0b-3): a declared stdio connector server is REROUTED to a supervised
  // mcp capability by the native normalizer, not dropped as malformed — the
  // "none were valid" warning would be false for it.
  if (!result.diagnostics.some(diagnostic => diagnostic.code === 'plugin.install.connector_stdio_rerouted')) {
    addCodexDeclarativeDropDiagnostics('connectors', input.connectors, result.value.connectors, diagnostics);
  }
  const connectorIds = new Set((result.value.connectors ?? []).map(connector => connector.id));
  for (const app of result.value.apps ?? []) {
    if (connectorIds.has(app.connectorId)) continue;
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.codex_app_connector_unresolved',
      `Codex app "${app.id}" references connector "${app.connectorId}" without bundled connector metadata and will remain unavailable.`,
      `apps.${app.id}`,
      { appId: app.id, connectorId: app.connectorId },
    ));
  }

  const manifest: NessyPluginManifest = {
    ...result.value,
    capabilities: result.value.capabilities.map(requireImportedRuntimeTrust),
    compatibility: {
      rawExternalKind: 'codex-plugin',
      adapter: {
        adapterId: CODEX_ADAPTER_ID,
        adapterVersion: CODEX_ADAPTER_VERSION,
        rawKind: 'codex-plugin',
        rawManifestPath: CODEX_MANIFEST_RELATIVE_PATH,
        warnings: diagnostics.filter((diagnostic): diagnostic is PluginDiagnostic & { severity: 'warning' } => diagnostic.severity === 'warning'),
      },
    },
  };
  const runtimeProfiles = codexRuntimeCompatibilityProfiles(capabilities);
  if (runtimeProfiles.length > 0) {
    manifest.runtimeCompatibility = { profiles: runtimeProfiles };
  }

  const finalized = deferUnavailablePluginSurfaces(
    manifest,
    [...diagnostics, ...result.diagnostics],
    buildCodexCompatibilityReport(capabilities, manifest, diagnostics),
    CODEX_ADAPTER_ID,
  );
  return {
    ok: result.ok,
    value: finalized.value,
    compatibility: finalized.compatibility,
    diagnostics: finalized.diagnostics,
  };
}

/**
 * `codex-plugin-env-v1` (A2) is recorded whenever the normalized manifest
 * retains a Codex runtime consumer that can reference compatibility variables:
 * skill text, a command hook, or a stdio MCP server. IR-only — no env is
 * materialized here; the pinned runtime expands/materializes the allowlist.
 */
function codexRuntimeCompatibilityProfiles(capabilities: PluginCapability[]): PluginRuntimeCompatibilityProfile[] {
  const hasRuntimeConsumer = capabilities.some(capability => (
    capability.kind === 'skill'
    || capability.kind === 'hook'
    || (capability.kind === 'mcp' && capability.mcp.transport === 'stdio')
  ));
  return hasRuntimeConsumer ? ['codex-plugin-env-v1'] : [];
}

/**
 * The remaining retained Codex surfaces (top-level `commands` metadata and
 * the settings/assets catalog-only blocks) become a `deferred`
 * compatibility record instead of a silently dropped warning (A2
 * `PluginCompatibilityReport`, A4 addition). K1 promotes `apps`/`connectors`
 * from deferred to SUPPORTED: a valid declarative app/connector is now
 * materialized as an MCP-backed source, so its kind joins `supportedKinds` and
 * no longer produces a deferred record. `state` is `'supported'` when nothing
 * was deferred, `'partial'` when a non-core surface was retained/deferred, and
 * `'blocked'` is reserved for a primary executable declaration this adapter
 * cannot safely normalize at all.
 */
function buildCodexCompatibilityReport(
  capabilities: PluginCapability[],
  manifest: NessyPluginManifest,
  diagnostics: PluginDiagnostic[],
): PluginCompatibilityReport {
  const supportedKinds = new Set<PluginCompatibilityReport['supportedKinds'][number]>(
    capabilities
      .filter(capability => capability.kind !== 'unsupported')
      .map(capability => capability.kind),
  );
  // K1: declarative app/connector surfaces are now supported once normalized.
  const connectorIds = new Set((manifest.connectors ?? []).map(connector => connector.id));
  if ((manifest.apps ?? []).some(app => connectorIds.has(app.connectorId))) supportedKinds.add('app');
  if ((manifest.connectors ?? []).length > 0) supportedKinds.add('connector');
  const deferred: PluginCompatibilityReport['deferred'] = [];
  for (const diagnostic of diagnostics) {
    const entry = codexDeferredEntryFor(diagnostic);
    if (entry) deferred.push(entry);
  }
  return {
    format: 'codex',
    state: deferred.length > 0 ? 'partial' : 'supported',
    supportedKinds: [...supportedKinds],
    deferred,
    blocked: [],
  };
}

const CODEX_DEFERRED_REASON_BY_FIELD: Record<string, string> = {
  commands: 'plugin.deferred.codex_command',
};

const CODEX_DEFERRED_REASON_BY_RETAINED_SURFACE: Record<string, string> = {
  settings: 'plugin.deferred.codex_settings',
  assets: 'plugin.deferred.codex_assets',
};

/**
 * Diagnostic `path` here is the top-level manifest field name (e.g. `"apps"`),
 * not a bundle-relative file path, so it is never copied onto the report
 * entry's `sourcePath` — that field is reserved for an actual bundle
 * resource path a future case may supply.
 */
function codexDeferredEntryFor(diagnostic: PluginDiagnostic): PluginCompatibilityReport['deferred'][number] | undefined {
  if (diagnostic.code === 'plugin.format.codex_app_connector_unresolved') {
    return { externalKind: 'app-connector', reasonCode: 'plugin.deferred.codex_app_connector_unresolved' };
  }
  if (diagnostic.code === 'plugin.format.codex_capability_incomplete'
    && diagnostic.path?.endsWith('.tool_timeout_sec')) {
    return { externalKind: 'mcp', reasonCode: 'plugin.deferred.codex_mcp_invalid_tool_timeout' };
  }
  if (diagnostic.code === 'plugin.format.codex_capability_incomplete'
    && diagnostic.path?.endsWith('.cwd')) {
    return { externalKind: 'mcp', reasonCode: 'plugin.deferred.codex_mcp_invalid_cwd' };
  }
  if (diagnostic.code === 'plugin.format.codex_mcp_npx_unmaterialized') {
    return {
      externalKind: 'mcp',
      reasonCode: 'plugin.deferred.codex_mcp_npx_unmaterialized',
      ...(diagnostic.path ? { sourcePath: diagnostic.path } : {}),
    };
  }
  if (diagnostic.code === 'plugin.format.codex_mcp_command_unavailable') {
    return { externalKind: 'mcp', reasonCode: 'plugin.deferred.codex_mcp_command_unavailable' };
  }
  if (diagnostic.code === 'plugin.format.codex_hook_event_deferred') {
    const reasonCode = typeof diagnostic.details?.reasonCode === 'string' ? diagnostic.details.reasonCode : undefined;
    if (reasonCode) return { externalKind: `hook-event-${diagnostic.path ?? 'unknown'}`, reasonCode };
  }
  if (diagnostic.code === 'plugin.format.codex_hook_field_unread') {
    const field = typeof diagnostic.details?.field === 'string' ? diagnostic.details.field : 'unknown';
    return { externalKind: `hook-${field}`, reasonCode: 'plugin.deferred.codex_hook_field_unread' };
  }
  if (diagnostic.code === 'plugin.format.codex_hook_handler_skipped') {
    const hookType = typeof diagnostic.details?.hookType === 'string' ? diagnostic.details.hookType : 'unknown';
    return { externalKind: `hook-${hookType}`, reasonCode: 'plugin.deferred.codex_hook_handler_skipped' };
  }
  if (diagnostic.code === 'plugin.format.codex_field_unsupported' && diagnostic.path) {
    const reasonCode = CODEX_DEFERRED_REASON_BY_FIELD[diagnostic.path];
    if (reasonCode) return { externalKind: diagnostic.path, reasonCode };
  }
  if (diagnostic.code === 'plugin.format.codex_extension_not_capability' && diagnostic.path) {
    const reasonCode = CODEX_DEFERRED_REASON_BY_RETAINED_SURFACE[diagnostic.path];
    if (reasonCode) return { externalKind: diagnostic.path, reasonCode };
  }
  return undefined;
}

const CODEX_KNOWN_FIELDS = new Set([
  '$schema',
  'apps',
  'assets',
  'author',
  'capabilities',
  'commands',
  'connectors',
  'description',
  'displayName',
  'homepage',
  'homepageUrl',
  'hooks',
  'id',
  'install',
  'interface',
  'keywords',
  'license',
  'lsp',
  'mcp',
  'mcp_servers',
  'mcpServers',
  'name',
  'nessyExtensions',
  'pluginId',
  'repository',
  'settings',
  'skills',
  'version',
]);

const CODEX_UNSUPPORTED_FIELDS = new Set([
  'commands',
]);

/**
 * K1: `connectors` is an inline array. `apps` additionally supports the official
 * Codex path-form declaration handled by `normalizeCodexApps`.
 */
const CODEX_DECLARATIVE_ARRAY_FIELDS = new Set([
  'apps',
  'connectors',
]);

/**
 * K1: warn when a present, non-empty declarative array (`apps`/`connectors`)
 * survived normalization with ZERO valid descriptors — every entry was
 * malformed and dropped. Losslessness: the discarded declaration is reported,
 * never silently swallowed.
 */
function addCodexDeclarativeDropDiagnostics(
  field: 'apps' | 'connectors',
  raw: unknown,
  normalized: unknown[] | undefined,
  diagnostics: PluginDiagnostic[],
): void {
  if (Array.isArray(raw) && raw.length > 0 && (normalized?.length ?? 0) === 0) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.codex_declarative_dropped',
      `Codex plugin field "${field}" had ${raw.length} entr${raw.length === 1 ? 'y' : 'ies'} but none were valid; the declaration was dropped.`,
      field,
      { field },
    ));
  }
}

function addCodexFieldDiagnostics(input: UnknownRecord, diagnostics: PluginDiagnostic[]): void {
  for (const key of Object.keys(input)) {
    if (CODEX_UNSUPPORTED_FIELDS.has(key)) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_field_unsupported',
        `Codex plugin field "${key}" is detected but not normalized by this adapter.`,
        key,
        { field: key },
      ));
      continue;
    }
    if (CODEX_DECLARATIVE_ARRAY_FIELDS.has(key)
      && !Array.isArray(input[key])
      && !(key === 'apps' && typeof input[key] === 'string')) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_declarative_malformed',
        `Codex plugin field "${key}" must be an array of declarative descriptors; ignoring a non-array value.`,
        key,
        { field: key },
      ));
      continue;
    }
    if (!CODEX_KNOWN_FIELDS.has(key)) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_field_unknown',
        `Codex plugin field "${key}" is not recognized by this adapter.`,
        key,
        { field: key },
      ));
    }
  }
}

/**
 * P3.372 · the root-`.app.json` / root-`.mcp.json` question, settled against the
 * SOURCE rather than against the two pages that contradict each other.
 *
 * Read at `github.com/openai/codex`, `rust-v0.148.0`,
 * `codex-rs/core-plugins/src/loader.rs`:
 *
 *   `plugin_app_config_paths` — `if let Some(path) = &manifest_paths.apps { return
 *   vec![path.clone()]; } default_app_config_paths(plugin_root)`
 *   `plugin_mcp_config_paths` — the same shape for
 *   `PluginManifestMcpServers::Path`, with the `::Object` arm in
 *   `load_plugin_mcp_servers_from_manifest_with_format` reading the inline object
 *   and never reaching the default at all.
 *
 * Two facts fall out, and they point in OPPOSITE directions:
 *
 *  1. **An UNDECLARED root file IS loaded by the CLI.** `default_*_config_paths`
 *     is the fallback whenever the manifest declares nothing, and it takes the
 *     root file if it exists. So `submission-errors.md`'s
 *     `undeclared_mcp_manifest_ignored` ("A root `.mcp.json` is imported only
 *     when the plugin-manifest `mcpServers` field is set to `./.mcp.json`") does
 *     not describe the loader; on the evidence it is a PUBLISHING-side warning.
 *     Per AGENTS.md §"the two runtimes need different evidence" — for codex the
 *     source outranks the page — we keep importing it, and this docblock is the
 *     record the row asked for. Narrowing here would have disabled MCP servers
 *     that work on codex today.
 *  2. **A DECLARED entry REPLACES the default; it does not extend it.** So
 *     `plugin-json-spec.md:94` ("`skills`, `hooks`, and `mcpServers` are
 *     supplemented on top of default component discovery; they do not replace
 *     defaults") is wrong for this field too, and our adapter's own behaviour —
 *     importing the root file ALONGSIDE a manifest that declares some other path
 *     or an inline object — is a real widening over an EXECUTABLE declaration.
 *
 * We do not silently narrow (2) either: a bundle installed here today would lose
 * servers with no word said, which is the same defect from the other side. The
 * import stays and `codexUndeclaredRootImport` names it, through the ordinary
 * warning channel that already reaches the install summary as
 * `compatibility.adapter.warnings`.
 */
function codexUndeclaredRootImport(field: 'apps' | 'mcpServers', file: string): PluginDiagnostic {
  return pluginDiagnostic(
    'warning',
    'plugin.format.codex_undeclared_root_import',
    `Codex plugin declares "${field}" and also ships a root "${file}" that the manifest does not name; `
    + `both are imported. Codex loads a root "${file}" only when the manifest declares no "${field}" of its own.`,
    field,
    { file },
  );
}

async function normalizeCodexDefaultApps(
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
  explicitInput: unknown,
): Promise<PluginAppDescriptor[]> {
  if (declaresManifestDefaultPath(explicitInput, CODEX_DEFAULT_APPS_FILE)
    || !await isManifestFile(join(rootDirectory, CODEX_DEFAULT_APPS_FILE))) return [];
  if (explicitInput !== undefined) diagnostics.push(codexUndeclaredRootImport('apps', CODEX_DEFAULT_APPS_FILE));
  return normalizeCodexApps(CODEX_DEFAULT_APPS_FILE, rootDirectory, diagnostics);
}

async function normalizeCodexApps(
  input: unknown,
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
): Promise<PluginAppDescriptor[]> {
  if (input === undefined) return [];
  if (typeof input === 'string') {
    const appPath = normalizeCodexRelativePath(input, diagnostics, 'apps');
    if (!appPath) return [];
    try {
      const parsed = JSON.parse(await readFile(join(rootDirectory, appPath), 'utf-8'));
      return normalizeCodexAppObject(parsed, diagnostics, appPath);
    } catch (error) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_json_unreadable',
        `Codex apps file could not be read: ${error instanceof Error ? error.message : String(error)}`,
        'apps',
        { path: appPath },
      ));
      return [];
    }
  }
  if (Array.isArray(input)) {
    return input.flatMap((entry, index) => {
      if (!isRecord(entry)) {
        diagnostics.push(incompleteCodexCapability('app', `apps.${index}`, 'Codex app descriptor must be an object.'));
        return [];
      }
      const id = stringField(entry, 'id');
      const connectorId = stringField(entry, 'connectorId');
      if (!id || !connectorId) {
        diagnostics.push(incompleteCodexCapability('app', `apps.${index}`, 'Codex app requires id and connectorId.'));
        return [];
      }
      return [{
        id,
        connectorId,
        ...(stringField(entry, 'displayName') ? { displayName: stringField(entry, 'displayName') } : {}),
        ...(isStringRecord(entry.routing) ? { routing: entry.routing } : {}),
      }];
    });
  }
  diagnostics.push(incompleteCodexCapability('app', 'apps', 'Codex apps must be an array or JSON file path.'));
  return [];
}

function normalizeCodexAppObject(
  input: unknown,
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
): PluginAppDescriptor[] {
  if (!isRecord(input)) {
    diagnostics.push(incompleteCodexCapability('app', diagnosticPath, 'Codex apps file must contain an apps object.'));
    return [];
  }
  const appMap = isRecord(input.apps) ? input.apps : input;
  const apps: PluginAppDescriptor[] = [];
  for (const [appId, rawApp] of Object.entries(appMap)) {
    if (!isRecord(rawApp)) {
      diagnostics.push(incompleteCodexCapability('app', `${diagnosticPath}.${appId}`, 'Codex app descriptor must be an object.'));
      continue;
    }
    const connectorId = stringField(rawApp, 'connectorId') ?? stringField(rawApp, 'id');
    if (!connectorId) {
      diagnostics.push(incompleteCodexCapability('app', `${diagnosticPath}.${appId}`, 'Codex app requires a connector id.'));
      continue;
    }
    apps.push({
      id: appId,
      connectorId,
      ...(stringField(rawApp, 'displayName') ? { displayName: stringField(rawApp, 'displayName') } : {}),
      ...(isStringRecord(rawApp.routing) ? { routing: rawApp.routing } : {}),
    });
  }
  return apps;
}

function addCodexCapabilityDiagnostics(input: unknown, diagnostics: PluginDiagnostic[]): void {
  if (input === undefined) return;
  const entries = Array.isArray(input)
    ? input.map((entry, index) => [String(index), entry] as const)
    : isRecord(input)
      ? Object.entries(input)
      : undefined;
  if (!entries) {
    diagnostics.push(incompleteCodexCapability('capability', 'capabilities', 'Codex capabilities must be an object or array.'));
    return;
  }

  for (const [key, entry] of entries) {
    if (!isRecord(entry)) {
      diagnostics.push(incompleteCodexCapability('capability', `capabilities.${key}`, 'Codex capability entry must be an object.'));
      continue;
    }
    const capabilityKind = stringField(entry, 'kind') ?? stringField(entry, 'type') ?? stringField(entry, 'capability') ?? key;
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.codex_capability_unknown',
      `Codex capability "${capabilityKind}" is not supported by this adapter and was not normalized.`,
      `capabilities.${key}`,
      { kind: capabilityKind },
    ));
  }
}

async function normalizeCodexDefaultSkills(
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
  explicitInput: unknown,
): Promise<PluginCapability[]> {
  if (declaresManifestDefaultPath(explicitInput, CODEX_DEFAULT_SKILLS_DIR, true)) return [];
  if (!await isManifestDirectory(join(rootDirectory, CODEX_DEFAULT_SKILLS_DIR))) return [];
  return normalizeCodexSkills(CODEX_DEFAULT_SKILLS_DIR, rootDirectory, diagnostics);
}

async function normalizeCodexSkills(
  input: unknown,
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
): Promise<PluginCapability[]> {
  if (input === undefined) return [];
  const capabilities: PluginCapability[] = [];
  if (typeof input === 'string') {
    capabilities.push(...await scanCodexSkillDirectory(input, rootDirectory, diagnostics, 'skills'));
    return capabilities;
  }
  if (Array.isArray(input)) {
    for (const [index, entry] of input.entries()) {
      if (typeof entry === 'string') {
        capabilities.push(...await scanCodexSkillDirectory(entry, rootDirectory, diagnostics, `skills.${index}`));
        continue;
      }
      if (isRecord(entry)) {
        const capability = normalizeCodexSkillRecord(entry, diagnostics, `skills.${index}`);
        if (capability) capabilities.push(capability);
        continue;
      }
      diagnostics.push(incompleteCodexCapability('skill', `skills.${index}`, 'Codex skill entries require a path string or object.'));
    }
    return capabilities;
  }
  if (isRecord(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === 'string') {
        const capability = normalizeCodexSkillRecord({ id: key, slug: key, path: value }, diagnostics, `skills.${key}`);
        if (capability) capabilities.push(capability);
        continue;
      }
      if (isRecord(value)) {
        const capability = normalizeCodexSkillRecord({ id: key, slug: key, ...value }, diagnostics, `skills.${key}`);
        if (capability) capabilities.push(capability);
      }
    }
    return capabilities;
  }
  diagnostics.push(pluginDiagnostic(
    'warning',
    'plugin.format.codex_capability_incomplete',
    'Codex skills must be a path string, array, or object.',
    'skills',
    { kind: 'skill' },
  ));
  return capabilities;
}

async function scanCodexSkillDirectory(
  rawPath: string,
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
): Promise<PluginCapability[]> {
  const directory = normalizeCodexRelativePath(rawPath, diagnostics, diagnosticPath, { allowDirectory: true });
  if (!directory) return [];
  const scan = await scanManifestSkillDirectory(rootDirectory, directory);
  if (scan.kind === 'missing') {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.codex_path_missing',
      `Codex skills path "${directory}" does not exist or cannot be read.`,
      diagnosticPath,
      { kind: 'skill', path: directory },
    ));
    return [];
  }
  if (scan.kind === 'root-skill') {
    const slug = basename(directory);
    return [{
      kind: 'skill',
      id: codexCapabilityId('skill', slug),
      skill: { slug, path: scan.skillPath },
    }];
  }

  const capabilities: PluginCapability[] = scan.skills.map(skill => ({
    kind: 'skill' as const,
    id: codexCapabilityId('skill', skill.slug),
    skill: { slug: skill.slug, path: skill.path },
  }));
  if (capabilities.length === 0) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.codex_capability_incomplete',
      `Codex skills path "${directory}" did not contain any SKILL.md files.`,
      diagnosticPath,
      { kind: 'skill', path: directory },
    ));
  }
  return capabilities;
}

function normalizeCodexSkillRecord(
  record: UnknownRecord,
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
): PluginCapability | undefined {
  const id = stringField(record, 'id') ?? stringField(record, 'slug') ?? stringField(record, 'name');
  const slug = stringField(record, 'slug') ?? id;
  const rawPath = stringField(record, 'path') ?? stringField(record, 'skillPath');
  if (!id || !slug || !rawPath) {
    diagnostics.push(incompleteCodexCapability('skill', diagnosticPath, 'Codex skill object requires id/slug and path.'));
    return undefined;
  }
  const normalizedPath = normalizeCodexRelativePath(rawPath, diagnostics, `${diagnosticPath}.path`);
  if (!normalizedPath) return undefined;
  const skillPath = normalizedPath.endsWith('/SKILL.md') ? normalizedPath : `${normalizedPath}/SKILL.md`;
  return {
    kind: 'skill',
    id: codexCapabilityId('skill', id),
    ...(stringField(record, 'displayName') ?? stringField(record, 'name') ? {
      displayName: stringField(record, 'displayName') ?? stringField(record, 'name'),
    } : {}),
    skill: {
      slug,
      path: skillPath,
    },
  };
}

async function normalizeCodexDefaultMcpServers(
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
  appConnectorIds: ReadonlyMap<string, string>,
  explicitInput: unknown,
): Promise<{ capabilities: PluginCapability[]; connectors: PluginConnectorDescriptor[] }> {
  if (declaresManifestDefaultPath(explicitInput, CODEX_DEFAULT_MCP_FILE)
    || !await isManifestFile(join(rootDirectory, CODEX_DEFAULT_MCP_FILE))) {
    return { capabilities: [], connectors: [] };
  }
  // See `codexUndeclaredRootImport` for the source reading behind both arms: an
  // undeclared root file matches the CLI and is imported silently; a root file
  // imported ALONGSIDE some other declaration is a widening the CLI does not do,
  // and it is imported WITH a named warning rather than dropped.
  if (explicitInput !== undefined) diagnostics.push(codexUndeclaredRootImport('mcpServers', CODEX_DEFAULT_MCP_FILE));
  return normalizeCodexMcpServers(
    CODEX_DEFAULT_MCP_FILE,
    rootDirectory,
    diagnostics,
    appConnectorIds,
  );
}

async function normalizeCodexMcpServers(
  input: unknown,
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
  appConnectorIds: ReadonlyMap<string, string>,
): Promise<{ capabilities: PluginCapability[]; connectors: PluginConnectorDescriptor[] }> {
  if (input === undefined) return { capabilities: [], connectors: [] };
  if (typeof input === 'string') {
    const mcpPath = normalizeCodexRelativePath(input, diagnostics, 'mcpServers');
    if (!mcpPath) return { capabilities: [], connectors: [] };
    try {
      const parsed = JSON.parse(await readFile(join(rootDirectory, mcpPath), 'utf-8'));
      return normalizeCodexMcpServerObject(parsed, rootDirectory, diagnostics, mcpPath, appConnectorIds);
    } catch (error) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_json_unreadable',
        `Codex MCP servers file could not be read: ${error instanceof Error ? error.message : String(error)}`,
        'mcpServers',
        { path: mcpPath },
      ));
      return { capabilities: [], connectors: [] };
    }
  }
  return normalizeCodexMcpServerObject(input, rootDirectory, diagnostics, 'mcpServers', appConnectorIds);
}

function normalizeCodexMcpServerObject(
  input: unknown,
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
  appConnectorIds: ReadonlyMap<string, string>,
): { capabilities: PluginCapability[]; connectors: PluginConnectorDescriptor[] } {
  if (!isRecord(input)) {
    diagnostics.push(incompleteCodexCapability('mcp', diagnosticPath, 'Codex MCP servers must be an object or JSON file path.'));
    return { capabilities: [], connectors: [] };
  }
  // `plugins/build/plugins.md` § *Bundled MCP servers and lifecycle hooks*:
  // "`mcpServers` can point to an `.mcp.json` file that contains either a direct
  // server map or a wrapped `mcp_servers` object." The wrapper is spelled
  // `mcp_servers` there — snake_case — while all eight real `.mcp.json` files in
  // `openai/plugins` use `mcpServers`. Both are accepted: reading only the
  // camelCase one treated a spec-conformant wrapped file as a direct map, so its
  // single "server" was the literal key `mcp_servers` (no transport → dropped as
  // incomplete) and every real server inside it was lost.
  const serverMap = isRecord(input.mcpServers)
    ? input.mcpServers
    : isRecord(input.mcp_servers)
      ? input.mcp_servers
      : input;
  const capabilities: PluginCapability[] = [];
  const connectors = new Map<string, PluginConnectorDescriptor>();
  for (const [serverName, rawServer] of Object.entries(serverMap)) {
    if (!isRecord(rawServer)) {
      diagnostics.push(incompleteCodexCapability('mcp', `${diagnosticPath}.${serverName}`, 'Codex MCP server descriptor must be an object.'));
      continue;
    }
    const id = stringField(rawServer, 'id') ?? stringField(rawServer, 'name') ?? serverName;
    // `streamable-http` folds to `http` as OUR consistency choice, NOT a Codex
    // contract — no Codex page specifies the alias (developers.openai.com/
    // plugins/build/plugins does not mention it). It is the MCP specification's
    // own name for the transport, so a bundled `.mcp.json` copied from an MCP
    // server's docs hits the same spelling the Claude readers now accept.
    const rawTransport = normalizeMcpTransportAlias(stringField(rawServer, 'transport') ?? stringField(rawServer, 'type') ?? (stringField(rawServer, 'command') ? 'stdio' : stringField(rawServer, 'url') ? 'http' : undefined));
    const transport = rawTransport === 'stdio' || rawTransport === 'http' || rawTransport === 'sse'
      ? rawTransport
      : undefined;
    if (!id || !transport) {
      diagnostics.push(incompleteCodexCapability('mcp', `${diagnosticPath}.${serverName}`, 'Codex MCP server requires id/server name and transport details.'));
      continue;
    }
    const displayName = stringField(rawServer, 'displayName') ?? stringField(rawServer, 'name');
    const description = stringField(rawServer, 'description');
    const command = stringField(rawServer, 'command');
    const normalizedCommand = command ? normalizeCodexHookCommand(command) : undefined;
    const args = readStringArray(rawServer.args)?.map(normalizeCodexHookCommand);
    const cwd = stringField(rawServer, 'cwd')
      ? normalizeCodexHookCommand(stringField(rawServer, 'cwd')!)
      : undefined;
    if (cwd) {
      const cwdError = validatePluginMcpCwd(cwd);
      if (cwdError) {
        diagnostics.push(incompleteCodexCapability(
          'mcp',
          `${diagnosticPath}.${serverName}.cwd`,
          `Codex MCP cwd is invalid: ${cwdError}`,
        ));
        continue;
      }
    }
    const env = isStringRecord(rawServer.env)
      ? normalizeCodexRuntimeRecord(rawServer.env)
      : undefined;
    const headers = isStringRecord(rawServer.headers)
      ? normalizeCodexRuntimeRecord(rawServer.headers)
      : undefined;
    const environmentSources = normalizeCodexMcpEnvironmentSources(
      rawServer.env_vars,
      diagnostics,
      `${diagnosticPath}.${serverName}.env_vars`,
    );
    const commandQualification = transport === 'stdio' && normalizedCommand
      ? qualifyPluginStdioCommand(normalizedCommand, rootDirectory)
      : undefined;
    if (commandQualification && !commandQualification.ok) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_mcp_command_unavailable',
        `Codex MCP server "${serverName}" command is not an approved host runtime or executable bundle file and will remain unavailable.`,
        `${diagnosticPath}.${serverName}.command`,
        { kind: 'mcp', serverName },
      ));
      continue;
    }
    if (transport === 'stdio'
      && commandQualification?.kind === 'host'
      && commandQualification.runtime === 'npx'
      && !parsePluginPackageRunnerArgs(args ?? []).ok) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_mcp_command_unavailable',
        `Codex MCP server "${serverName}" uses an invalid npx package spec or unsupported runner arguments and will remain unavailable.`,
        `${diagnosticPath}.${serverName}`,
        { kind: 'mcp', serverName },
      ));
      continue;
    }
    if (transport === 'stdio'
      && commandQualification?.kind === 'host'
      && commandQualification.runtime === 'bunx'
      && !hasMaterializablePluginPackageRunner(rootDirectory, args ?? [])) {
      const runner = commandQualification.runtime;
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_mcp_command_unavailable',
        `Codex MCP server "${serverName}" uses ${runner} without a bundle-local materialized or locked dependency and will remain unavailable.`,
        `${diagnosticPath}.${serverName}`,
        { kind: 'mcp', serverName },
      ));
      continue;
    }
    const hasBearerTokenEnvVar = Object.prototype.hasOwnProperty.call(rawServer, 'bearer_token_env_var');
    const bearerTokenEnvVar = stringField(rawServer, 'bearer_token_env_var');
    if (hasBearerTokenEnvVar && (
      (transport !== 'http' && transport !== 'sse')
      || !stringField(rawServer, 'url')
      || !bearerTokenEnvVar
      || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(bearerTokenEnvVar)
    )) {
      diagnostics.push(incompleteCodexCapability(
        'mcp',
        `${diagnosticPath}.${serverName}`,
        'Codex bearer MCP server requires an http/sse URL and a valid bearer_token_env_var name.',
      ));
      continue;
    }
    const rawToolTimeoutSeconds = rawServer.tool_timeout_sec;
    const required = rawServer.required;
    if (required !== undefined && typeof required !== 'boolean') {
      diagnostics.push(incompleteCodexCapability(
        'mcp',
        `${diagnosticPath}.${serverName}.required`,
        'Codex MCP required must be a boolean.',
      ));
      continue;
    }
    // F1.819: codex's own bound, not an invented one — see {@link codexToolTimeoutMs}.
    if (rawToolTimeoutSeconds !== undefined
      && (typeof rawToolTimeoutSeconds !== 'number'
        || !Number.isFinite(rawToolTimeoutSeconds)
        || rawToolTimeoutSeconds <= 0)) {
      diagnostics.push(incompleteCodexCapability(
        'mcp',
        `${diagnosticPath}.${serverName}.tool_timeout_sec`,
        'Codex MCP tool_timeout_sec must be a positive number of seconds.',
      ));
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(rawServer, 'oauth_resource')) {
      const url = stringField(rawServer, 'url');
      const oauthResource = stringField(rawServer, 'oauth_resource');
      if ((transport !== 'http' && transport !== 'sse') || !url || !oauthResource) {
        diagnostics.push(incompleteCodexCapability(
          'mcp',
          `${diagnosticPath}.${serverName}`,
          'Codex OAuth MCP server requires an http/sse URL and oauth_resource.',
        ));
        continue;
      }
      const connectorId = appConnectorIds.get(serverName) ?? appConnectorIds.get(id) ?? id;
      const existing = connectors.get(connectorId);
      const server: PluginConnectorMcpServerDescriptor = {
        serverName,
        transport,
        url: normalizeCodexHookCommand(url),
        oauthResource: normalizeCodexHookCommand(oauthResource),
        ...(stringField(rawServer, 'clientId') ?? stringField(rawServer, 'client_id')
          ? { clientId: stringField(rawServer, 'clientId') ?? stringField(rawServer, 'client_id') }
          : {}),
      };
      if (existing) {
        existing.mcpServers.push(server);
      } else {
        connectors.set(connectorId, {
          id: connectorId,
          ...(displayName ? { displayName } : {}),
          ...(description ? { description } : {}),
          mcpServers: [server],
          auth: { type: 'oauth', timing: 'ON_FIRST_USE' },
        });
      }
      continue;
    }
    capabilities.push({
      kind: 'mcp',
      id: codexCapabilityId('mcp', id),
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
        ...(args ? { args } : {}),
        ...(cwd ? { cwd } : {}),
        ...(stringField(rawServer, 'url') ? { url: normalizeCodexHookCommand(stringField(rawServer, 'url')!) } : {}),
        ...(env ? { env } : {}),
        ...((environmentSources || bearerTokenEnvVar)
          ? {
              environmentSources: {
                ...(environmentSources ?? {}),
                ...(bearerTokenEnvVar ? { [bearerTokenEnvVar]: bearerTokenEnvVar } : {}),
              },
            }
          : {}),
        ...(bearerTokenEnvVar ? { requiredEnvironmentNames: [bearerTokenEnvVar] } : {}),
        ...(typeof rawToolTimeoutSeconds === 'number'
          ? { toolTimeoutMs: codexToolTimeoutMs(rawToolTimeoutSeconds) }
          : {}),
        ...(typeof required === 'boolean' ? { required } : {}),
        ...((headers || bearerTokenEnvVar)
          ? {
              headers: {
                ...(headers ?? {}),
                ...(bearerTokenEnvVar
                  ? { Authorization: `Bearer \${${bearerTokenEnvVar}}` }
                  : {}),
              },
            }
          : {}),
      },
    });
  }
  return { capabilities, connectors: [...connectors.values()] };
}

function normalizeCodexMcpEnvironmentSources(
  input: unknown,
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    diagnostics.push(incompleteCodexCapability(
      'mcp',
      diagnosticPath,
      'Codex MCP env_vars must be an array of names or { name, source } descriptors.',
    ));
    return undefined;
  }
  const sources = new Map<string, string>();
  for (const [index, entry] of input.entries()) {
    const name = typeof entry === 'string' && entry.trim()
      ? entry.trim()
      : isRecord(entry)
        ? stringField(entry, 'name')
        : undefined;
    const source = isRecord(entry) && entry.source !== undefined
      ? stringField(entry, 'source')
      : name;
    if (!name || !source) {
      diagnostics.push(incompleteCodexCapability(
        'mcp',
        `${diagnosticPath}.${index}`,
        'Codex MCP env_vars entry requires a non-empty name and optional non-empty source.',
      ));
      continue;
    }
    const existing = sources.get(name);
    if (existing && existing !== source) {
      diagnostics.push(incompleteCodexCapability(
        'mcp',
        `${diagnosticPath}.${index}`,
        `Codex MCP env_vars declares conflicting sources for ${name}.`,
      ));
      continue;
    }
    sources.set(name, source);
  }
  return sources.size > 0
    ? Object.fromEntries([...sources.entries()].sort(([left], [right]) => left.localeCompare(right)))
    : undefined;
}

/**
 * The id budget one manifest's hook sources share (R16 collision fix).
 *
 * The synthesized default ids (`${event}-${index}[-${hookIndex}]`) restart at
 * 0 for every SOURCE — each element of an array-shaped manifest `hooks` entry,
 * and each default hooks file — so two sources declaring the same event used
 * to emit the identical id, `plugin.capability.duplicate_id` fired, and the
 * whole manifest was rejected, skills and MCP servers included.
 *
 * `usedIds` carries every id an emitted hook capability already occupies,
 * across all sources of the manifest. `slot` names the source: the array
 * element index (composed with `-` when arrays nest) or the default-file slot.
 * A synthesized default only switches to its slotted form
 * (`${event}-s${slot}-${index}[-${hookIndex}]`) on a REAL collision, so every
 * id an accepted pre-fix bundle produced — single-source bundles above all —
 * stays byte-identical, and the trust/executable-hash records keyed on hook
 * ids (`pluginInstanceId#capabilityId#hookId`) survive the
 * upgrade without a re-prompt. The `s` marker keeps the slotted namespace
 * disjoint from the all-numeric default shapes, so a slotted id cannot in turn
 * collide with another source's default. Explicit `id`/`name` fields are never
 * rewritten: an explicit duplicate is a real authoring error and still rejects.
 */
interface CodexHookIdBudget {
  usedIds: Set<string>;
  slot?: string;
}

/**
 * `hooks.md` § *Plugin-bundled hooks*: "If a manifest defines `hooks`, Codex
 * uses those manifest entries instead of the default `hooks/hooks.json`." So a
 * declared `hooks` field of ANY shape suppresses both defaults — not only one
 * that happens to name the default path, which is the rule the other component
 * fields use. (`plugin-json-spec.md:94` states the opposite, "supplemented on
 * top of default component discovery"; `hooks.md` is the specific page and
 * suppressing is the narrower behaviour, so it wins. Recorded in the plan's § 8.)
 *
 * "Defines" is the shared resolver's `declared`, so an empty declaration —
 * `hooks: {}`, `hooks: []`, `hooks: ""` — defines nothing and leaves the
 * defaults in place, exactly as it did before R16.
 */
async function normalizeCodexDefaultHooks(
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
  explicitInput: unknown,
): Promise<PluginCapability[]> {
  if (resolveManifestComponentPaths(explicitInput, { field: 'hooks' }).declared) return [];
  // One id budget across both default files: the adapter's own two-file read
  // is itself a multi-source shape, and was one of the R16 collision triggers.
  const usedIds = new Set<string>();
  const capabilities: PluginCapability[] = [];
  for (const [slot, defaultPath] of [CODEX_DEFAULT_HOOKS_FILE, CODEX_ROOT_HOOKS_FILE].entries()) {
    if (!await isManifestFile(join(rootDirectory, defaultPath))) continue;
    capabilities.push(...await normalizeCodexHooks(defaultPath, rootDirectory, diagnostics, 'hooks', {
      usedIds,
      slot: String(slot),
    }));
  }
  return capabilities;
}

/**
 * `hooks.md` § *Plugin-bundled hooks*: the manifest `hooks` entry "can be a
 * `./`-prefixed path, an array of `./`-prefixed paths, an inline hooks object,
 * or an array of inline hooks objects". Before R16 only the first and third were
 * read; either array form produced one warning and zero hooks.
 */
async function normalizeCodexHooks(
  input: unknown,
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
  diagnosticPath = 'hooks',
  idBudget?: CodexHookIdBudget,
): Promise<PluginCapability[]> {
  if (input === undefined) return [];
  const budget = idBudget ?? { usedIds: new Set<string>() };
  if (typeof input === 'string') {
    const hooksPath = normalizeCodexRelativePath(input, diagnostics, diagnosticPath);
    if (!hooksPath) return [];
    try {
      const parsed = JSON.parse(await readFile(join(rootDirectory, hooksPath), 'utf-8'));
      return normalizeCodexHookObject(parsed, diagnostics, hooksPath, budget);
    } catch (error) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_json_unreadable',
        `Codex hooks file could not be read: ${error instanceof Error ? error.message : String(error)}`,
        diagnosticPath,
        { path: hooksPath },
      ));
      return [];
    }
  }
  if (Array.isArray(input)) {
    const capabilities: PluginCapability[] = [];
    for (const [index, entry] of input.entries()) {
      // Each element is independently either a path or an inline hooks object,
      // so the two documented array forms need no separate branch — and a mixed
      // array, which the wording does not forbid, works too. Every element is a
      // distinct SOURCE whose synthesized ids restart at 0, so each one carries
      // its element index as the id-budget slot (R16).
      capabilities.push(...await normalizeCodexHooks(entry, rootDirectory, diagnostics, `${diagnosticPath}.${index}`, {
        usedIds: budget.usedIds,
        slot: budget.slot === undefined ? String(index) : `${budget.slot}-${index}`,
      }));
    }
    return capabilities;
  }
  return normalizeCodexHookObject(input, diagnostics, diagnosticPath, budget);
}

function normalizeCodexHookObject(
  input: unknown,
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
  idBudget: CodexHookIdBudget,
): PluginCapability[] {
  if (!isRecord(input)) {
    diagnostics.push(incompleteCodexCapability('hook', diagnosticPath, 'Codex hooks must be an object keyed by event name.'));
    return [];
  }
  // Every hooks document in `hooks.md` is wrapped in a top-level `hooks` key,
  // and the file reader has always unwrapped it. Applying the same tolerance to
  // an inline object means a manifest that inlines the documented file body
  // verbatim behaves like the file it was copied from. `hooks` is not a Codex
  // event name, so the unwrap cannot shadow a real event.
  const hookMap = isRecord(input.hooks) ? input.hooks : input;
  const capabilities: PluginCapability[] = [];
  const slottedId = (defaultId: string, eventName: string) => (idBudget.slot === undefined
    ? undefined
    : `${eventName}-s${idBudget.slot}${defaultId.slice(eventName.length)}`);
  for (const [eventName, rawEntries] of Object.entries(hookMap)) {
    const entries = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
    entries.forEach((entry, index) => {
      const basePath = `${diagnosticPath}.${eventName}.${index}`;
      if (!isRecord(entry)) {
        diagnostics.push(incompleteCodexCapability('hook', basePath, 'Codex hook entry must be an object.'));
        return;
      }
      const groupedHooks = Array.isArray(entry.hooks) ? entry.hooks : undefined;
      if (groupedHooks) {
        const groupMatcher = stringField(entry, 'matcher');
        groupedHooks.forEach((hookEntry, hookIndex) => {
          const defaultId = `${eventName}-${index}-${hookIndex}`;
          normalizeCodexHookEntry({
            entry: hookEntry,
            eventName,
            diagnostics,
            capabilities,
            diagnosticPath: `${basePath}.hooks.${hookIndex}`,
            defaultId,
            slottedDefaultId: slottedId(defaultId, eventName),
            usedIds: idBudget.usedIds,
            defaultMatcher: groupMatcher,
          });
        });
        return;
      }
      const defaultId = `${eventName}-${index}`;
      normalizeCodexHookEntry({
        entry,
        eventName,
        diagnostics,
        capabilities,
        diagnosticPath: basePath,
        defaultId,
        slottedDefaultId: slottedId(defaultId, eventName),
        usedIds: idBudget.usedIds,
      });
    });
  }
  return capabilities;
}

function normalizeCodexHookEntry(options: {
  entry: unknown;
  eventName: string;
  diagnostics: PluginDiagnostic[];
  capabilities: PluginCapability[];
  diagnosticPath: string;
  defaultId: string;
  /** The source-slotted fallback id; undefined for a sole top-level source. */
  slottedDefaultId?: string;
  /** Ids already occupied by emitted hook capabilities across all sources. */
  usedIds: Set<string>;
  defaultMatcher?: string;
}): void {
  const { entry, eventName, diagnostics, capabilities, diagnosticPath, defaultId, slottedDefaultId, usedIds, defaultMatcher } = options;
  if (!isRecord(entry)) {
    diagnostics.push(incompleteCodexCapability('hook', diagnosticPath, 'Codex hook entry must be an object.'));
    return;
  }
  const mapped = mapExternalHookEventName(eventName, 'codex');
  diagnostics.push(...mapped.diagnostics);
  if (!mapped.event) {
    // Same routing as the Claude adapter: a documented-but-unemitted event is a
    // named deferral, never a silent drop. Codex builds its deferred list from
    // diagnostics, so the reason travels as one.
    if (mapped.deferredReasonCode) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_hook_event_deferred',
        `Codex hook event "${eventName}" is documented but not emitted by Nessy; the hook is reported and never registered.`,
        eventName,
        { eventName, reasonCode: mapped.deferredReasonCode },
      ));
    }
    return;
  }
  const declaredType = stringField(entry, 'type') ?? (readCodexHookCommand(entry) ? 'command' : undefined);
  // Codex's `mcp_tool` hook type maps onto the Nessy `mcp` runtime kind.
  const rawType = declaredType === 'mcp_tool' ? 'mcp' : declaredType;
  // R16: only a REAL collision switches the synthesized default to its slotted
  // form, so every id an accepted pre-fix bundle produced stays byte-identical
  // and trust records keyed on hook ids never re-prompt. An explicit id is
  // never rewritten — an explicit duplicate is an authoring error and still
  // rejects through `plugin.capability.duplicate_id`.
  const synthesizedId = usedIds.has(defaultId) && slottedDefaultId !== undefined ? slottedDefaultId : defaultId;
  const id = stringField(entry, 'id') ?? stringField(entry, 'name') ?? synthesizedId;
  // Only an EMITTED capability occupies its id: an entry a later branch drops
  // with a diagnostic never reaches the schema's duplicate check, so charging
  // the budget for it would slot ids in bundles that have no collision at all.
  const emit = (capability: PluginCapability): void => {
    usedIds.add(id);
    capabilities.push(capability);
  };
  const matcher = stringField(entry, 'matcher') ?? defaultMatcher;
  // Codex spells the field `timeoutSec` (`ConfiguredHookHandler`,
  // `HookMetadata`), hooks.md spells it `timeout`; both are SECONDS and both
  // apply to every hook type. The command branch used to read `timeoutMs` — a
  // key neither contract defines — so no Codex hook ever carried its timeout.
  const timeoutMs = readExternalHookTimeoutMs(entry);
  // Codex carries `statusMessage` on `ConfiguredHookHandler` and `HookMetadata`
  // alike; like `timeoutSec` it is a common field, not a command-hook one.
  const statusMessage = stringField(entry, 'statusMessage');
  const commonFields = {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(statusMessage ? { statusMessage } : {}),
  };

  // B2: Codex mcp_tool hooks invoke a qualified MCP proxy tool; http hooks fire
  // a bounded request under the network permission contract.
  if (rawType === 'mcp') {
    const mcpTool = stringField(entry, 'mcpTool') ?? stringField(entry, 'tool');
    if (!mcpTool) {
      diagnostics.push(incompleteCodexCapability('hook', diagnosticPath, 'Codex mcp_tool hook requires a tool name.'));
      return;
    }
    const mcpArgs = isRecord(entry.args) ? entry.args as Record<string, unknown> : (isRecord(entry.input) ? entry.input as Record<string, unknown> : undefined);
    emit({
      kind: 'hook',
      id: codexCapabilityId('hook', id),
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
  if (rawType === 'http') {
    const httpRecord = isRecord(entry.http) ? entry.http : entry;
    const url = stringField(httpRecord, 'url');
    if (!url) {
      diagnostics.push(incompleteCodexCapability('hook', diagnosticPath, 'Codex http hook requires an http url.'));
      return;
    }
    const rawMethod = stringField(httpRecord, 'method')?.toUpperCase();
    const method = rawMethod === 'GET' || rawMethod === 'POST' || rawMethod === 'PUT' || rawMethod === 'PATCH' || rawMethod === 'DELETE' ? rawMethod : undefined;
    const headers = isStringRecord(httpRecord.headers) ? httpRecord.headers : undefined;
    emit({
      kind: 'hook',
      id: codexCapabilityId('hook', id),
      hook: {
        id,
        event: mapped.event,
        type: 'http',
        ...(matcher ? { matcher } : {}),
        http: {
          url: normalizeCodexHookCommand(url),
          ...(method ? { method } : {}),
          ...(headers ? { headers } : {}),
          ...(httpRecord.body !== undefined ? { body: httpRecord.body } : {}),
        },
        ...commonFields,
      },
    });
    return;
  }

  // `hooks.md` § *Config shape*, last note before the TOML example: "Only
  // `type: \"command\"` handlers run today. `prompt` and `agent` handlers are
  // parsed but skipped."
  //
  // So these two ARE Codex handler types — this corrects the R16 reading that
  // "Codex has no agent hooks, no prompt hooks" — and Codex declines to run
  // them. We used to normalize both into executable capabilities, which the
  // trusted automation bridge then registers and dispatches
  // (`hooks-automation.ts:635`, no dialect filter): a third-party Codex plugin
  // got a prompt injected into our turns, or a sub-agent spawned, where its own
  // platform runs nothing. Parsing stays — an author still learns their handler
  // is malformed — and the parsed handler is reported instead of registered.
  if (rawType === 'prompt' || rawType === 'agent') {
    const payload = rawType === 'prompt'
      ? stringField(entry, 'prompt') ?? stringField(entry, 'body')
      : stringField(entry, 'agent') ?? stringField(entry, 'agentName') ?? stringField(entry, 'name');
    if (!payload) {
      diagnostics.push(incompleteCodexCapability(
        'hook',
        diagnosticPath,
        rawType === 'prompt' ? 'Codex prompt hook requires prompt text.' : 'Codex agent hook requires an agent name.',
      ));
      return;
    }
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.codex_hook_handler_skipped',
      `Codex ${rawType} hook "${id}" is parsed but never registered: hooks.md runs only type "command" handlers, and prompt and agent handlers are parsed but skipped.`,
      `${diagnosticPath}.type`,
      { kind: 'hook', hookType: rawType },
    ));
    return;
  }
  if (rawType && rawType !== 'command') {
    // http/mcp hook runtimes are B2/B3 scope — detected but not executable here.
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.codex_capability_incomplete',
      `Codex hook type "${rawType}" is detected but is not executable by this adapter.`,
      `${diagnosticPath}.type`,
      { kind: 'hook', hookType: rawType },
    ));
    return;
  }
  const command = readCodexHookCommand(entry);
  if (!command) {
    diagnostics.push(incompleteCodexCapability('hook', diagnosticPath, 'Codex command hook requires command.'));
    return;
  }
  addCodexHookFieldDiagnostics(entry, diagnosticPath, diagnostics);
  const cwd = stringField(entry, 'cwd');
  const normalizedCwd = cwd
    ? normalizeCodexRelativePath(cwd, diagnostics, `${diagnosticPath}.cwd`, { allowDirectory: true })
    : undefined;
  if (cwd && !normalizedCwd) return;
  const argsVector = readHookArgsVector(entry.args);
  if (argsVector.invalid) {
    diagnostics.push(incompleteCodexCapability('hook', `${diagnosticPath}.args`, 'Codex command hook args must be a list of strings.'));
    return;
  }
  // Codex's published hooks page defines no `shell` field (`commandWindows` is
  // its Windows mechanism), but a hook file that carries one gets the same
  // two-value validation as the Claude path rather than a silent drop.
  const shell = entry.shell;
  if (shell !== undefined && shell !== 'bash' && shell !== 'powershell') {
    diagnostics.push(incompleteCodexCapability('hook', `${diagnosticPath}.shell`, `Codex command hook shell must be "bash" or "powershell", not ${JSON.stringify(shell)}.`));
    return;
  }
  emit({
    kind: 'hook',
    id: codexCapabilityId('hook', id),
    hook: {
      id,
      event: mapped.event,
      type: 'command',
      ...(matcher ? { matcher } : {}),
      ...(shell ? { shell } : {}),
      command: normalizeCodexHookCommand(command),
      ...(argsVector.args ? { args: argsVector.args.map(normalizeCodexHookCommand) } : {}),
      ...(normalizedCwd ? { cwd: normalizedCwd } : {}),
      ...commonFields,
    },
  });
}

/**
 * The command a Codex hook runs on this host.
 *
 * `hooks.md` § *Config shape*: "`commandWindows` is an optional Windows-only
 * command override. In TOML, use `command_windows` or `commandWindows`." Both
 * spellings are accepted because the same hook file is read on both hosts.
 *
 * The platform is resolved at normalization, which is where `mcpb.ts` already
 * applies its `platform_overrides` — a bundle is normalized on the machine that
 * will run it. `platform` is a parameter so both arms are testable without
 * mutating `process`.
 */
export function readCodexHookCommand(
  entry: UnknownRecord,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === 'win32') {
    const windowsCommand = stringField(entry, 'commandWindows') ?? stringField(entry, 'command_windows');
    if (windowsCommand) return windowsCommand;
  }
  return stringField(entry, 'command');
}

/**
 * Command-hook fields `hooks.md` specifies and our runtime has no consumer for.
 * Both are recorded rather than implemented, and for different reasons:
 *
 *  - `additionalContextLimit` — "Omit `additionalContextLimit` to use the
 *    default `2500`-token threshold." Our spilling threshold is the host's, so
 *    a hook declaring one silently gets a different budget than it asked for.
 *  - `async` — "The `async` option is parsed, but asynchronous command hooks
 *    aren't supported yet." `PluginHookDescriptor.async` exists and the Claude
 *    adapter sets it, but setting it HERE would run a Codex hook in the
 *    background that Codex itself runs synchronously. Parsed, reported, not set.
 */
const CODEX_UNREAD_HOOK_FIELDS = ['additionalContextLimit', 'async'] as const;

function addCodexHookFieldDiagnostics(
  entry: UnknownRecord,
  diagnosticPath: string,
  diagnostics: PluginDiagnostic[],
): void {
  for (const field of CODEX_UNREAD_HOOK_FIELDS) {
    if (entry[field] === undefined) continue;
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.codex_hook_field_unread',
      `Codex command hook declares "${field}", which this adapter parses but does not apply.`,
      `${diagnosticPath}.${field}`,
      { kind: 'hook', field },
    ));
  }
}

async function normalizeCodexPromptCommands(
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
): Promise<PluginCapability[]> {
  const directory = join(rootDirectory, CODEX_DEFAULT_COMMANDS_DIR);
  if (!await isManifestDirectory(directory)) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const capabilities: PluginCapability[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.name.startsWith('_') || !entry.name.toLowerCase().endsWith('.md')) continue;
    const name = basename(entry.name, '.md');
    const path = `${CODEX_DEFAULT_COMMANDS_DIR}/${entry.name}`;
    let content: string;
    try {
      content = await readFile(join(directory, entry.name), 'utf-8');
    } catch (error) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_path_missing',
        `Codex command "${path}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
        path,
        { kind: 'prompt-command', path },
      ));
      continue;
    }
    const { frontmatter } = splitMarkdownFrontmatter(content);
    capabilities.push({
      kind: 'prompt-command',
      id: codexCapabilityId('prompt-command', name),
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
      promptCommand: {
        name,
        path,
        ...(frontmatter['argument-hint'] ? { argumentHint: frontmatter['argument-hint'] } : {}),
        ...(frontmatter.model ? { model: frontmatter.model } : {}),
      },
    });
  }
  return capabilities;
}

/**
 * Codex's OWN spelling of "keep this skill out of the model's listing".
 *
 * A bundled Codex skill may carry `agents/openai.yaml` beside its `SKILL.md`,
 * and that file's `policy` block is where codex expresses implicit invocation.
 * `plugins/deploy/submission-errors.md` § *Skill agent metadata errors* is the
 * closest thing codex publishes to a schema for it, verbatim:
 *
 * > `policy` may contain only `products` and `allow_implicit_invocation`.
 * > `products` must contain `CHAT`, `CODEX`, or both, and
 * > `allow_implicit_invocation` must be `true` or `false`.
 *
 * with the file's location given by the same section: "A bundled skill can
 * define its own `interface` in `skills/<skill>/agents/openai.yaml`."
 *
 * **Evidence tier: STRONG — measured in the shipped binary**, not page-only
 * (AGENTS.md's two codex tiers, where for codex the source outranks the page).
 * All three shipped app-server binaries under
 * `apps/electron/resources/bin/codex` carry the name 13 times — the two darwin
 * directories as `codex-app-server`, win32-x64 as `codex-app-server.exe` — each
 * with a `RawAgentRoleFileToml` struct whose fields are
 * `interface`/`dependencies`/`policy`, a validator emitting
 * "`policy.allow_implicit_invocation` must be a boolean", a generator script
 * resolving the file as `skill_root / "agents" / "openai.yaml"`, and its own
 * bundled `skill-creator` skill, whose `references/openai_yaml.md` states the
 * SEMANTICS and the DEFAULT in one sentence, verbatim:
 *
 * > `policy.allow_implicit_invocation`: When false, the skill is not injected
 * > into the model context by default, but can still be invoked explicitly via
 * > `$skill`. Defaults to true.
 *
 * "Not injected into the model context, still invocable explicitly" IS
 * `disableModelInvocation`, so the mapping is the binary's own semantics rather
 * than our reading of a page. The two behaviours this module depends on — the
 * permissive DEFAULT and the boolean-only refusal — are that sentence and that
 * validator respectively.
 *
 * ## Only the restrictive direction is mapped, deliberately
 *
 * `allow_implicit_invocation: false` sets `disableModelInvocation: true`, which
 * `buildSkillListingPart` (`agent/core/prompt-builder.ts`) already filters and
 * `BaseAgent` already refuses a model-origin dispatch against — so this closes
 * the gap with no reader to build. `true`, absent, or any other value sets
 * NOTHING, so a `SKILL.md` that declared `disable-model-invocation: true` keeps
 * its restriction: codex's default must never silently WIDEN what the skill's
 * own frontmatter narrowed. The merge in `applyPluginSkillFrontmatter` reads
 * `capability.skill.disableModelInvocation ?? declared.…`, so the value set
 * here wins over the frontmatter, which is the right precedence for a Codex
 * bundle and only ever in the safe direction.
 *
 * An unreadable, malformed or uncontained file is not a declaration: it is
 * skipped with a warning naming the path, never guessed at.
 */
async function applyCodexSkillAgentPolicy(
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
  capabilities: PluginCapability[],
): Promise<PluginCapability[]> {
  const containRoot = resolve(rootDirectory);
  return Promise.all(capabilities.map(async (capability): Promise<PluginCapability> => {
    if (capability.kind !== 'skill') return capability;
    if (capability.skill.disableModelInvocation !== undefined) return capability;
    const relativePath = join(dirname(capability.skill.path), CODEX_SKILL_AGENT_FILE);
    const absolutePath = resolve(rootDirectory, relativePath);
    if (!absolutePath.startsWith(containRoot + sep)) return capability;
    if (!await isManifestFile(absolutePath)) return capability;
    let document: unknown;
    try {
      document = loadYaml(await readFile(absolutePath, 'utf-8'));
    } catch (error) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_skill_agent_unreadable',
        `Codex skill agent file "${relativePath}" is not valid YAML and was ignored: `
        + `${error instanceof Error ? error.message : String(error)}`,
        relativePath,
        { kind: 'skill', slug: capability.skill.slug, path: relativePath },
      ));
      return capability;
    }
    if (!isRecord(document)) return capability;
    const policy = document.policy;
    if (policy === undefined) return capability;
    if (!isRecord(policy)) {
      // `skill_agent_policy_wrong_type` — "`policy` must be a YAML mapping when
      // provided." Refused rather than coerced.
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_skill_agent_policy_invalid',
        `Codex skill "${capability.skill.slug}" declares a "policy" in "${relativePath}" that is not a mapping, `
        + 'so its implicit-invocation setting could not be read and the skill stays model-invocable.',
        relativePath,
        { kind: 'skill', slug: capability.skill.slug, path: relativePath },
      ));
      return capability;
    }
    const allow = policy.allow_implicit_invocation;
    if (allow === undefined) return capability;
    if (typeof allow !== 'boolean') {
      // `skill_agent_allow_implicit_invocation_wrong_type` — "must be `true` or
      // `false`". A string "false" is NOT false here: guessing is how a control
      // silently stops controlling in the opposite direction.
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_skill_agent_policy_invalid',
        `Codex skill "${capability.skill.slug}" declares "policy.allow_implicit_invocation" in "${relativePath}" `
        + 'as something other than true or false, so it was ignored and the skill stays model-invocable. '
        + 'Write it as a YAML boolean.',
        relativePath,
        { kind: 'skill', slug: capability.skill.slug, path: relativePath },
      ));
      return capability;
    }
    if (allow) return capability;
    return { ...capability, skill: { ...capability.skill, disableModelInvocation: true } };
  }));
}

async function normalizeCodexAgents(
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
): Promise<PluginCapability[]> {
  const directory = join(rootDirectory, CODEX_DEFAULT_AGENTS_DIR);
  if (!await isManifestDirectory(directory)) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const capabilities: PluginCapability[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.name.startsWith('_') || !entry.name.toLowerCase().endsWith('.md')) continue;
    const fileName = basename(entry.name, '.md');
    const path = `${CODEX_DEFAULT_AGENTS_DIR}/${entry.name}`;
    let content: string;
    try {
      content = await readFile(join(directory, entry.name), 'utf-8');
    } catch (error) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.codex_path_missing',
        `Codex agent "${path}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
        path,
        { kind: 'agent', path },
      ));
      continue;
    }
    const { frontmatter } = splitMarkdownFrontmatter(content);
    const name = frontmatter.name || fileName;
    // `splitToolGrantList`, the one tokenizer — this was the LAST bare comma
    // split on a tool list after P6b replaced the other three.
    //
    // The Codex contract does not specify agent frontmatter at all: this root
    // `agents/` scan is a Nessy extension grounded in practice, not in
    // `developers.openai.com/plugins/build/plugins.md` § *Plugin structure*
    // (`docs/superpowers/plans/2026-07-29-codex-adapter-spec.md` § 8.3 records
    // it as such). So there is no rival Codex semantics for a comma here, and
    // one thing settles the split: `buildPiRuntimeAgentDescriptor` re-reads the
    // same file as `agent.tools ?? frontmatter.tools`, so the CAPABILITY's list
    // wins and whatever this produces is what the runtime grants. Splitting
    // `Agent(a, b)` yielded two names no runtime resolves, which the Pi side
    // then denies by omission — the 1.25.0 defect P6b measured on the Claude
    // path, reachable from a Codex bundle by the same route.
    const tools = frontmatter.tools ? splitToolGrantList(frontmatter.tools) : undefined;
    capabilities.push({
      kind: 'agent',
      id: codexCapabilityId('agent', name),
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
      agent: {
        name,
        path,
        ...(frontmatter.model ? { model: frontmatter.model } : {}),
        ...(tools?.length ? { tools } : {}),
      },
    });
  }
  return capabilities;
}

/**
 * Normalizes a Codex `lsp` manifest field into `lsp` capabilities (B3). Same
 * shape rules as the Claude adapter: an array of descriptors or an object
 * keyed by id, each requiring a command.
 */
function normalizeCodexLspServers(input: unknown, diagnostics: PluginDiagnostic[]): PluginCapability[] {
  if (input === undefined) return [];
  // Only a non-array/non-object value is malformed; an empty array/object is a
  // valid "no LSP servers" declaration and yields no capabilities silently.
  if (!Array.isArray(input) && !isRecord(input)) {
    diagnostics.push(incompleteCodexCapability('lsp', 'lsp', 'Codex lsp must be an array or object of server descriptors.'));
    return [];
  }
  const entries: Array<[string | undefined, unknown]> = Array.isArray(input)
    ? input.map(entry => [undefined, entry] as [string | undefined, unknown])
    : Object.entries(input);
  const capabilities: PluginCapability[] = [];
  entries.forEach(([key, entry], index) => {
    if (!isRecord(entry)) {
      diagnostics.push(incompleteCodexCapability('lsp', `lsp.${key ?? index}`, 'Codex lsp entry must be an object.'));
      return;
    }
    const command = stringField(entry, 'command');
    const lspId = key ?? stringField(entry, 'id') ?? stringField(entry, 'name') ?? `lsp-${index}`;
    if (!command) {
      diagnostics.push(incompleteCodexCapability('lsp', `lsp.${lspId}`, 'Codex lsp server requires a command.'));
      return;
    }
    const args = readStringArray(entry.args)?.map(normalizeCodexHookCommand);
    const languages = readRequiredUniqueStringArray(entry.languages);
    if (!languages) {
      diagnostics.push(incompleteCodexCapability('lsp', `lsp.${lspId}.languages`, 'Codex lsp server requires unique non-empty languages.'));
      return;
    }
    capabilities.push({
      kind: 'lsp',
      id: codexCapabilityId('lsp', lspId),
      lsp: {
        id: lspId,
        command: normalizeCodexHookCommand(command),
        ...(args ? { args } : {}),
        languages,
      },
    });
  });
  return capabilities;
}

function normalizeCodexHookCommand(command: string): string {
  return command
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, '${NESSY_PLUGIN_ROOT}')
    .replace(/\$CLAUDE_PLUGIN_ROOT\b/g, '$NESSY_PLUGIN_ROOT');
}

function normalizeCodexRuntimeRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, normalizeCodexHookCommand(value)]));
}

/**
 * W7 Step 5 retention: generic Codex top-level `settings`/`assets` blocks are
 * NOT part of the core surface and never become capabilities. One warning per
 * surface records the retained block for
 * catalog/provenance (persisted in the adapter warnings); the v2 candidate
 * resolver additionally retains any unprovenanced capability entries as
 * `unsupported-runtime`.
 */
function addCodexExtensionRetentionDiagnostics(input: UnknownRecord, diagnostics: PluginDiagnostic[]): void {
  const retained: string[] = [];
  if (input.settings !== undefined) retained.push('settings');
  if (input.assets !== undefined) retained.push('assets');
  for (const surface of retained) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.codex_extension_not_capability',
      `Codex top-level "${surface}" is not part of the generic core surface (skills/mcpServers/apps/hooks) and was retained for catalog only. Declare it under "nessyExtensions" to activate the Nessy extension.`,
      surface,
    ));
  }
}

/**
 * Listing and publisher fields `submission-errors.md` validates and this
 * adapter has no consumer for.
 *
 * § *Manifest fields*: "`author`, `homepage`, `repository`, `license`, and
 * `keywords` provide publisher and discovery metadata." We read `homepage` and
 * `author.name`; the rest is dropped. § *Listing and interface errors* specifies
 * twelve more `interface` fields beyond the four we read (`displayName`,
 * `shortDescription`, `developerName`, `websiteURL`).
 *
 * `logoDark` is in the list without being documented — 42 of the 180 published
 * manifests ship it, so a reader looking for what was dropped needs it named.
 *
 * Carrying the values is NOT what this fixes: they have no consumer in our IR.
 * What it fixes is the silence — every one of the 180 real Codex plugins drops
 * its whole listing block and nothing recorded it. The warning is persisted in
 * `compatibility.adapter.warnings`.
 *
 * Deliberately NOT a `deferred` entry, unlike the dropped `settings`/`assets`
 * surfaces below. A deferred entry makes `compatibility.state` `partial`, which
 * `plugin-install-state.ts:43` turns into `needsConfirmEnable` — an extra
 * confirmation step on install. Measured over the 180 published manifests, that
 * would move 29 more plugins behind that step for listing metadata with no
 * runtime effect at all.
 */
const CODEX_UNREAD_MANIFEST_FIELDS = ['repository', 'license', 'keywords'] as const;
const CODEX_UNREAD_AUTHOR_FIELDS = ['email', 'url'] as const;
const CODEX_UNREAD_INTERFACE_FIELDS = [
  'longDescription',
  'category',
  'capabilities',
  'defaultPrompt',
  'brandColor',
  'brandColorDark',
  'composerIcon',
  'logo',
  'logoDark',
  'privacyPolicyURL',
  'termsOfServiceURL',
  'supportURL',
] as const;

function addCodexDroppedMetadataDiagnostics(input: UnknownRecord, diagnostics: PluginDiagnostic[]): void {
  const dropped: string[] = CODEX_UNREAD_MANIFEST_FIELDS.filter(field => input[field] !== undefined);
  const author = isRecord(input.author) ? input.author : undefined;
  if (author) {
    dropped.push(...CODEX_UNREAD_AUTHOR_FIELDS.filter(field => author[field] !== undefined).map(field => `author.${field}`));
  }
  const codexInterface = isRecord(input.interface) ? input.interface : undefined;
  if (codexInterface) {
    dropped.push(...CODEX_UNREAD_INTERFACE_FIELDS
      .filter(field => codexInterface[field] !== undefined)
      .map(field => `interface.${field}`));
  }
  if (!dropped.length) return;
  // One diagnostic per bundle, not one per field: a published manifest drops
  // fifteen of these at once and fifteen warnings would bury the rest.
  diagnostics.push(pluginDiagnostic(
    'warning',
    'plugin.format.codex_listing_metadata_dropped',
    `Codex plugin declares listing metadata this adapter does not carry: ${dropped.join(', ')}.`,
    undefined,
    { fields: dropped },
  ));
}

/**
 * Thin wrapper over the shared manifest-path resolver so the Codex reason code
 * is preserved. The normalization and containment rules themselves are the
 * shared ones (`manifest-paths.ts`) — this used to be a byte-identical copy of
 * the Claude adapter's version, which is how the two formats drifted.
 */
function normalizeCodexRelativePath(
  rawPath: string,
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
  options: { allowDirectory?: boolean } = {},
): string | undefined {
  return resolveManifestRelativePath(rawPath, diagnostics, diagnosticPath, {
    reasonCode: 'plugin.format.codex_path_invalid',
    ...options,
  });
}

function incompleteCodexCapability(kind: string, path: string, message: string): PluginDiagnostic {
  return pluginDiagnostic(
    'warning',
    'plugin.format.codex_capability_incomplete',
    message,
    path,
    { kind },
  );
}

/**
 * F1.819 — a codex plugin's `tool_timeout_sec` (seconds) as the host pool's
 * per-server wall clock (`toolTimeoutMs`). Appended at the end of the file so
 * the line numbers the docs cite above stay put.
 *
 * ## The bound is codex's, read at the pinned tag
 *
 * `packages/codex-protocol/manifest.json` pins `openai/codex` `rust-v0.156.1`.
 * There `codex-rs/codex-mcp/src/plugin_config.rs` parses a plugin's MCP
 * declaration with `serde_json::from_value::<McpServerConfig>`, and
 * `codex-rs/config/src/mcp_types.rs` reads `tool_timeout_sec` through its
 * `option_duration_secs` module: an `f64` handed to
 * `Duration::try_from_secs_f64`, which refuses only a negative, non-finite or
 * overflowing value. The vendored `packages/codex-protocol/schema/config-schema.json`
 * agrees (`number`, `format: double`, no `maximum`), and
 * `plugins/deploy/submission-errors.md` does not mention the field. So a
 * fraction is legal and there is no ceiling. The integer `1..86 400` rule this
 * replaces had no source, and it deferred the MCP server of OpenAI's own
 * `codex-security` plugin, which declared `tool_timeout_sec: 349200` when the
 * 2026-09-25 release sitting installed it.
 *
 * ## Two host residues, both named
 *
 * - `0` stays refused by the caller although codex loads it: codex applies its
 *   `DEFAULT_TOOL_TIMEOUT` only when the key is ABSENT, so `0` is a zero
 *   deadline on every call. A server deferred with a reason is more honest than
 *   one that can never answer, and that refusal predates this change.
 * - The host enforces the clock with `setTimeout`, whose delay is a signed
 *   32-bit millisecond count: above 2 147 483 647 ms (about 24.8 days) it is
 *   replaced with 1 ms (measured on this repo's Bun: a `TimeoutOverflowWarning`
 *   and the timer firing after 1 ms). A plugin asking for longer gets the
 *   longest clock the host can keep, never the 1 ms one.
 *
 * Rounded to the nearest whole millisecond (the plugin schema keeps only a
 * positive safe integer) and never below 1.
 */
function codexToolTimeoutMs(seconds: number): number {
  const maxTimerMs = 2_147_483_647;
  return Math.min(maxTimerMs, Math.max(1, Math.round(seconds * 1000)));
}
