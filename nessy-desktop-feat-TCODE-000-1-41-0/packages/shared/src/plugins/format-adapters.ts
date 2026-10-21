import { existsSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  isRecord,
  normalizeNessyPluginManifest,
  pluginDiagnostic,
  readHookArgsVector,
  validatePluginRelativePath,
} from './schema.ts';
import type { PluginHookEventName } from './hook-events.ts';
import type {
  NessyPluginManifest,
  PluginBundleNormalizationOptions,
  PluginCapability,
  PluginConnectorDescriptor,
  PluginCompatibilityReport,
  PluginDiagnostic,
  PluginFormatAdapter,
  PluginMarketplaceEntryDefinition,
  PluginNormalizationResult,
  PluginOrigin,
  PluginValidationResult,
} from './types.ts';
import { normalizeCodexPluginManifest } from './format-adapters/codex.ts';
// From the LEAF, never from the adapter: this binding is read at module-init
// time by `CODEX_ADAPTER_MANIFEST_CANDIDATES` below, and reading it out of
// `codex.ts` put it in a temporal dead zone whenever the graph was entered
// through that file (P6.671). `shared.ts` carries the measurement.
import { CODEX_MANIFEST_RELATIVE_PATH } from './format-adapters/shared.ts';
import { CLAUDE_ADAPTER_ID, detectClaudePluginBundle, normalizeClaudePluginBundle } from './format-adapters/claude.ts';
import { MCPB_ADAPTER_ID, MCPB_ADAPTER_VERSION, detectMcpbBundle, normalizeMcpbBundle } from './format-adapters/mcpb.ts';
import {
  deferUnavailablePluginSurfaces,
  isStringRecord,
  readPluginSkillFrontmatter,
  readStringArray,
  splitMarkdownFrontmatter,
  splitToolGrantList,
  stringField,
} from './format-adapters/shared.ts';
import {
  hasMaterializablePluginPackageRunner,
  parsePluginPackageRunnerArgs,
  qualifyPluginStdioCommand,
} from './stdio-command.ts';
import { normalizeMcpTransportAlias } from '../mcp/server-config-values.ts';

export const LEGACY_NESSY_EXTENSION_ADAPTER_ID = 'nessy-extension-json';
export const LEGACY_NESSY_EXTENSION_ADAPTER_VERSION = '2';

export interface PluginFormatDetectionResult {
  detected: boolean;
  adapterId?: string;
  adapterVersion?: string;
  diagnostics: PluginDiagnostic[];
}

/**
 * Detection-layer normalization result (adapter identity + raw IR).
 *
 * NOTE: this is intentionally a different shape from the plan's canonical
 * `PluginBundleNormalizationResult` (packages/shared/src/plugins/types.ts,
 * `{ manifest?, compatibility, diagnostics }`). That name is reserved in
 * types.ts for the lossless-IR + PluginCompatibilityReport contract; this
 * type keeps its adapter-identity shape here to avoid an `export *` barrel
 * collision in plugins/index.ts. A4/A5 migrate `normalizePluginBundle`
 * callers onto the `compatibility`-shaped result.
 *
 * `compatibility` (A4/A5) is populated when the selected adapter's own
 * normalization result carries a `PluginCompatibilityReport` (Codex, Claude)
 * — read here so acquisition/A7 can consume it without re-deriving
 * format/state from raw diagnostics.
 */
export interface PluginFormatBundleNormalizationResult extends PluginValidationResult<NessyPluginManifest> {
  adapterId?: string;
  adapterVersion?: string;
  compatibility?: PluginCompatibilityReport;
}

export type ExternalHookEventDialect = 'nessy' | 'claude' | 'codex';

export interface ExternalHookEventMappingResult {
  event?: PluginHookEventName;
  diagnostics: PluginDiagnostic[];
  /**
   * Set for a DOCUMENTED event we deliberately do not emit yet. The importer
   * records this as the deferral reason so the author sees why their hook will
   * never fire, instead of an "unknown event" warning that reads like a typo.
   */
  deferredReasonCode?: string;
}

/**
 * The documented hook events we do not emit, each routed to the reason it is
 * not real here.
 *
 * `TeammateIdle` is an agent-team event → R23.
 *
 * `Setup` is a LAUNCH-MODE event → R73 · f001. hooks.md#setup: "Fires only when
 * you launch Claude Code with `--init-only`, or with `--init` or
 * `--maintenance` in non-interactive mode with the `-p` flag. It doesn't fire
 * on normal startup." Nessy has no such launch mode, so there is no occurrence
 * to import a hook against. It used to map through to a Nessy event that fired
 * on every Pi runtime start — the exact case the page excludes — which is worse
 * than not firing: the page tells authors to use `SessionStart` for anything
 * per-session, so a hook written as `Setup` is one written to stay OFF that
 * path. The deferral entry is what an author now sees in the plugin's report.
 *
 * Two events a reader would expect here are NOT deferred, both landed by R32
 * (see `CLAUDE_HOOK_EVENT_MAP` below): `DirectoryAdded`, and `MessageDisplay`.
 * `MessageDisplay` was deferred for a reason about our WIRE rather than about
 * the event — assistant text travelled in one field that was simultaneously the
 * rendered text and the persisted transcript entry, so a hook's replacement had
 * nowhere to land that did not also rewrite the transcript, which hooks.md:1273
 * forbids. The wire now carries a display-only companion pair
 * (`SessionEvent.text_delta.displayDelta` / `text_complete.displayText`) and
 * `SessionManager` emits the event at its delta-batch boundary, so the reason is
 * gone and the deferral with it.
 *
 * A THIRD pair left the deferral table for the same kind of reason:
 * `PreModelSwitch` / `PostModelSwitch`. P3.349 found them in no source file at
 * all — they reached an author as `plugin.format.unknown_hook_event`, the
 * warning this very module calls the one that "reads like a typo in their
 * plugin" — and deferred them honestly: `SessionManager.updateSessionModel` is a
 * real model-switch seam, and we emitted nothing on it. P3.374 built the
 * emitter, so the deferral's own stated reason is gone and the mapping is below.
 * The urgency was the page's default: "A PreModelSwitch hook that doesn't
 * respond before its timeout blocks the switch", so a registered-and-never-fired
 * hook inverted a fail-CLOSED guard. No Codex snake_case sibling is needed:
 * codex's event roster is the eleven of
 * `packages/codex-protocol/generated/v2/HookEventName.ts` and carries no
 * model-switch event to spell — ours is a HOST event that reaches codex sessions
 * through the host seam, not a projection of a native one.
 */
export const DEFERRED_EXTERNAL_HOOK_EVENT_REASONS: Readonly<Record<string, string>> = {
  TeammateIdle: 'plugin.deferred.event_teammate_idle_unsupported',
  Setup: 'plugin.deferred.event_setup_no_launch_mode',
  // The Codex dialect accepts snake_case spellings of every event name, so the
  // deferral has to answer in that spelling too — otherwise a Codex plugin's
  // `setup` hook falls through to the generic unknown-event warning and reads
  // like a typo.
  setup: 'plugin.deferred.event_setup_no_launch_mode',
};

/**
 * The author-facing half of the table above: WHY the event can never fire here,
 * and what to write instead. A reason code alone is a lookup the plugin author
 * cannot perform.
 *
 * Keyed by reason code rather than by event spelling so the Codex `setup`
 * spelling and the `Setup` one cannot drift apart, and so a new deferral is
 * visibly missing its prose right next to the row that introduces it. The
 * generic fallback below is deliberately vague — nothing here may state a
 * reason it does not know.
 */
const DEFERRED_EXTERNAL_HOOK_EVENT_EXPLANATIONS: Readonly<Record<string, string>> = {
  'plugin.deferred.event_setup_no_launch_mode':
    'It is a launch-mode event — documented as firing only under `--init-only`, or `--init` / '
    + '`--maintenance` in non-interactive mode — and Nessy has no such launch mode. Use '
    + '`SessionStart` for work that must run when a session begins.',
  'plugin.deferred.event_teammate_idle_unsupported':
    'It is an agent-team event, and Nessy has no agent-team lifecycle to fire it on.',
};

type UnknownRecord = Record<string, unknown>;

const NATIVE_HOOK_EVENT_MAP: Record<string, PluginHookEventName> = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PermissionRequest: 'PermissionRequest',
  McpServerStart: 'McpServerStart',
  McpToolCall: 'McpToolCall',
  SessionEnd: 'SessionEnd',
};

/**
 * 29 of the documented Claude hook events; the rest are the four deferrals above
 * (`TeammateIdle`, `Setup`, `PreModelSwitch`, `PostModelSwitch`). `Elicitation`
 * is Claude's name for what we have always called `McpElicitation`: an
 * adapter-level ALIAS, never a contract rename, because stored automations
 * reference the existing name.
 *
 * The denominator is hooks.md's own event roster. **Do not write the size of it
 * here.** This comment said 31 while the page carried 33, and the test below
 * restated the same 31 as a hand-typed literal asserted at `toHaveLength(31)`,
 * so the two new events changed nothing anywhere — the drift guard this repo
 * built after `Task`→`Agent` and `lsp`→`lspServers` had itself stopped being
 * able to fail (P3.349). The roster is now DERIVED, offline, from
 * `scripts/claude-doc-anchors.tsv` — the `hooks` page's slugs that have an
 * `-input` sibling, which is one per event section and matched the live page
 * name-for-name in both directions when measured 2026-09-04 — and
 * `format-adapters.test.ts` checks that derived set against
 * `CLAUDE_ANSWERED_HOOK_EVENT_NAMES` in BOTH directions. A 34th event, or an
 * upstream RENAME, now fails a test instead of reaching a plugin author as
 * `plugin.format.unknown_hook_event`.
 */
const CLAUDE_HOOK_EVENT_MAP: Record<string, PluginHookEventName> = {
  InstructionsLoaded: 'InstructionsLoaded',
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  UserPromptExpansion: 'UserPromptExpansion',
  PreToolUse: 'PreToolUse',
  PermissionRequest: 'PermissionRequest',
  PermissionDenied: 'PermissionDenied',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  PostToolBatch: 'PostToolBatch',
  Notification: 'Notification',
  // R32 (hooks.md:1263: "Runs while an assistant message streams to the screen"),
  // moved here out of DEFERRED_EXTERNAL_HOOK_EVENT_REASONS. Claude-only: no
  // Codex page documents such an event, so it stays out of CODEX_HOOK_EVENT_MAP
  // below.
  MessageDisplay: 'MessageDisplay',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  TaskCreated: 'TaskCreated',
  TaskCompleted: 'TaskCompleted',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  ConfigChange: 'ConfigChange',
  CwdChanged: 'CwdChanged',
  // R32 (changelog.md 2.1.219, July 24 2026: "Added `DirectoryAdded` hook that
  // fires after `/add-dir` or the SDK `register_repo_root` control request
  // registers a new working directory mid-session"). Claude-only: no Codex page
  // documents such an event, so it stays out of CODEX_HOOK_EVENT_MAP below.
  DirectoryAdded: 'DirectoryAdded',
  // P3.374, moved here out of DEFERRED_EXTERNAL_HOOK_EVENT_REASONS once
  // `SessionManager.updateSessionModel` gained the emitter the deferral named as
  // missing. Claude-only in SPELLING — codex documents no model-switch event —
  // but the emission is host-side, so a codex session fires it too.
  PreModelSwitch: 'PreModelSwitch',
  PostModelSwitch: 'PostModelSwitch',
  FileChanged: 'FileChanged',
  WorktreeCreate: 'WorktreeCreate',
  WorktreeRemove: 'WorktreeRemove',
  PreCompact: 'PreCompact',
  PostCompact: 'PostCompact',
  Elicitation: 'McpElicitation',
  ElicitationResult: 'ElicitationResult',
  SessionEnd: 'SessionEnd',
};

/**
 * Every Claude-dialect event spelling this adapter answers for — mapped or
 * deferred — so the roster guard can check BOTH directions against the page
 * without retyping either list. Retyping is what P3.349 was.
 *
 * The lowercase keys of `DEFERRED_EXTERNAL_HOOK_EVENT_REASONS` are excluded on
 * purpose: they are Codex snake_case spellings (`setup`), and the Claude dialect
 * spells every event in PascalCase, so they are not names the Claude roster
 * could carry.
 */
export const CLAUDE_ANSWERED_HOOK_EVENT_NAMES: readonly string[] = Object.freeze(
  Array.from(new Set([
    ...Object.keys(CLAUDE_HOOK_EVENT_MAP),
    ...Object.keys(DEFERRED_EXTERNAL_HOOK_EVENT_REASONS).filter(name => /^[A-Z]/.test(name)),
  ])).sort(),
);

const CODEX_HOOK_EVENT_MAP: Record<string, PluginHookEventName> = {
  InstructionsLoaded: 'InstructionsLoaded',
  UserPromptExpansion: 'UserPromptExpansion',
  PostToolBatch: 'PostToolBatch',
  TaskCreated: 'TaskCreated',
  TaskCompleted: 'TaskCompleted',
  StopFailure: 'StopFailure',
  ConfigChange: 'ConfigChange',
  CwdChanged: 'CwdChanged',
  FileChanged: 'FileChanged',
  WorktreeCreate: 'WorktreeCreate',
  WorktreeRemove: 'WorktreeRemove',
  PostCompact: 'PostCompact',
  Elicitation: 'McpElicitation',
  ElicitationResult: 'ElicitationResult',
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  Notification: 'Notification',
  PermissionRequest: 'PermissionRequest',
  PermissionDenied: 'PermissionDenied',
  McpServerStart: 'McpServerStart',
  McpToolCall: 'McpToolCall',
  Stop: 'Stop',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  PreCompact: 'PreCompact',
  SessionEnd: 'SessionEnd',
  pre_tool_use: 'PreToolUse',
  post_tool_use: 'PostToolUse',
  post_tool_use_failure: 'PostToolUseFailure',
  user_prompt_submit: 'UserPromptSubmit',
  session_start: 'SessionStart',
  session_end: 'SessionEnd',
  notification: 'Notification',
  permission_request: 'PermissionRequest',
  permission_denied: 'PermissionDenied',
  mcp_server_start: 'McpServerStart',
  mcp_tool_call: 'McpToolCall',
  stop: 'Stop',
  subagent_start: 'SubagentStart',
  subagent_stop: 'SubagentStop',
  pre_compact: 'PreCompact',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  userPromptSubmit: 'UserPromptSubmit',
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  permissionRequest: 'PermissionRequest',
  permissionDenied: 'PermissionDenied',
  mcpServerStart: 'McpServerStart',
  mcpToolCall: 'McpToolCall',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  preCompact: 'PreCompact',
};

export function createDefaultPluginFormatAdapters(): PluginFormatAdapter[] {
  return [
    createMcpbAdapter(),
    createCodexCompatibilityDetectionAdapter(),
    createNativePluginJsonAdapter(),
    createLegacyNessyExtensionAdapter(),
    createClaudePluginJsonAdapter(),
  ];
}

function createMcpbAdapter(): PluginFormatAdapter {
  return {
    id: MCPB_ADAPTER_ID,
    version: MCPB_ADAPTER_VERSION,
    detect: detectMcpbBundle,
    normalize: normalizeMcpbBundle,
  };
}

export async function detectPluginFormat(
  rootDirectory: string,
  adapters: PluginFormatAdapter[] = createDefaultPluginFormatAdapters(),
): Promise<PluginFormatDetectionResult> {
  for (const adapter of adapters) {
    if (!await adapter.detect(rootDirectory)) continue;
    return {
      detected: true,
      adapterId: adapter.id,
      ...(adapter.version ? { adapterVersion: adapter.version } : {}),
      diagnostics: [],
    };
  }
  return {
    detected: false,
    diagnostics: [pluginDiagnostic(
      'error',
      'plugin.format.unsupported_format',
      'Plugin bundle does not contain a supported manifest format.',
    )],
  };
}

/**
 * S9: a marketplace entry may declare component fields for a bundle whose own
 * layout no adapter would claim (`strict: false`, where "the plugin doesn't need
 * its own `plugin.json`" — `plugins/marketplace-reference.md#strict-mode`). Only the Claude adapter
 * consumes an entry, because `plugin-marketplaces.md` is the contract that
 * defines one. When another adapter wins detection and the entry declared
 * components, the entry is NOT silently dropped: the caller gets a warning naming
 * the adapter that read the bundle instead.
 */
const MARKETPLACE_ENTRY_COMPONENT_FIELDS = [
  'skills', 'commands', 'agents', 'workflows', 'hooks', 'outputStyles', 'themes', 'mcpServers', 'lspServers',
] as const;

export function marketplaceEntryDeclaresComponents(
  entry: PluginMarketplaceEntryDefinition | undefined,
): boolean {
  // `fields` is persisted with the installed record, so a record written by an
  // older build can reach here without it.
  if (!entry || !isRecord(entry.fields)) return false;
  return MARKETPLACE_ENTRY_COMPONENT_FIELDS.some(field => entry.fields[field] !== undefined);
}

/**
 * D4 — the third manifest location the Codex loader accepts, and the only
 * FORMAT-NEUTRAL one. `submission-errors.md:155` (`plugin_manifest_missing`):
 * "ZIP must contain `.codex-plugin/plugin.json`, `.agent-plugin/plugin.json`,
 * or `.claude-plugin/plugin.json` at the root or in its single top-level
 * directory."
 *
 * We recognised two of the three; a bundle carrying only `.agent-plugin` was
 * `unsupported_format` and would not install at all. It is read by the Codex
 * compatibility adapter because that adapter already owns the other sibling of
 * the same sentence and the manifest inside is the same `plugin.json` schema —
 * the directory name carries no separate schema.
 *
 * The "or in its single top-level directory" half of that sentence is NOT
 * implemented here: the bundle root is chosen before any adapter sees it, so
 * that half belongs to the staging/extraction layer, not to detection.
 */
const AGENT_MANIFEST_RELATIVE_PATH = '.agent-plugin/plugin.json';

/**
 * T6 (plugin-install plan): the concrete manifest files a bundle may carry,
 * with the label each format is known by. A DUAL-format repo (the honey plugin
 * ships both a Codex and a Claude manifest) normalizes under whichever adapter
 * detects first, and until T6 nothing said which one won — the info diagnostic
 * below names the choice. Deliberately keyed on manifest FILES, not on
 * `adapter.detect` (Claude's manifestless discovery claims any bundle with a
 * `skills/` folder, which would flag nearly every install as dual-format).
 */
const BUNDLE_MANIFEST_CANDIDATES: ReadonlyArray<{ path: string; label: string }> = [
  { path: 'manifest.json', label: 'mcpb' },
  { path: '.codex-plugin/plugin.json', label: 'codex' },
  { path: AGENT_MANIFEST_RELATIVE_PATH, label: 'agent' },
  { path: 'plugin.json', label: 'nessy-plugin' },
  { path: 'nessy-extension.json', label: 'nessy-extension' },
  { path: '.claude-plugin/plugin.json', label: 'claude' },
];

function manifestFormatSelectedDiagnostic(
  rootDirectory: string,
  adapterId: string,
): PluginDiagnostic | undefined {
  const present = BUNDLE_MANIFEST_CANDIDATES
    .filter(candidate => existsSync(join(rootDirectory, candidate.path)))
    .map(candidate => candidate.label);
  if (present.length < 2) return undefined;
  return pluginDiagnostic(
    'info',
    'plugin.install.manifest_format_selected',
    `Plugin bundle carries multiple manifest formats (${present.join(', ')}); normalized as "${adapterId}".`,
    undefined,
    { adapterId, present },
  );
}

export async function normalizePluginBundle(
  rootDirectory: string,
  origin: PluginOrigin,
  adapters: PluginFormatAdapter[] = createDefaultPluginFormatAdapters(),
  options: PluginBundleNormalizationOptions = {},
): Promise<PluginFormatBundleNormalizationResult> {
  for (const adapter of adapters) {
    if (!await adapter.detect(rootDirectory, options)) continue;
    const adapterOrigin: PluginOrigin = {
      ...origin,
      adapterId: adapter.id,
      ...(adapter.version ? { adapterVersion: adapter.version } : {}),
    };
    const normalized = await adapter.normalize(rootDirectory, adapterOrigin, options);
    const result: PluginNormalizationResult = adapter.id !== CLAUDE_ADAPTER_ID
      && marketplaceEntryDeclaresComponents(options.marketplaceEntry)
      ? {
          ...normalized,
          diagnostics: [...normalized.diagnostics, pluginDiagnostic(
            'warning',
            'plugin.format.marketplace_entry_components_unread',
            `Marketplace entry declares component fields, but this bundle normalized as "${adapter.id}", whose format does not define marketplace-entry components. The entry's component fields were not read.`,
            undefined,
            { adapterId: adapter.id },
          )],
        }
      : normalized;
    const withSkillControls = result.value
      ? await applyPluginSkillFrontmatter(result.value, rootDirectory, result.diagnostics)
      : { value: undefined, diagnostics: result.diagnostics };
    const qualified = withSkillControls.value
      ? qualifyNormalizedPluginStdioCommands(withSkillControls.value, rootDirectory, withSkillControls.diagnostics)
      : { value: undefined, diagnostics: withSkillControls.diagnostics };
    const executableSurfaces = qualified.value
      ? deferUnavailablePluginSurfaces(
          qualified.value,
          qualified.diagnostics,
          result.compatibility,
          adapter.id,
        )
      : { value: undefined, diagnostics: qualified.diagnostics, compatibility: result.compatibility };
    const frontmatterHooks = executableSurfaces.value
      ? await reportFrontmatterHookDeclarations(
          executableSurfaces.value,
          rootDirectory,
          executableSurfaces.diagnostics,
          executableSurfaces.compatibility,
        )
      : { diagnostics: executableSurfaces.diagnostics, compatibility: executableSurfaces.compatibility };
    // `PluginFormatAdapter.normalize()` returns `PluginNormalizationResult`
    // (types.ts), which already carries an optional `compatibility` report
    // (A2 `PluginCompatibilityReport`) type-safely — no cast needed (A4/A5
    // CARRY #1).
    const formatChoice = manifestFormatSelectedDiagnostic(rootDirectory, adapter.id);
    return {
      ok: result.ok,
      ...(executableSurfaces.value ? { value: executableSurfaces.value } : {}),
      adapterId: adapter.id,
      ...(adapter.version ? { adapterVersion: adapter.version } : {}),
      ...(frontmatterHooks.compatibility ? { compatibility: frontmatterHooks.compatibility } : {}),
      diagnostics: formatChoice
        ? [...frontmatterHooks.diagnostics, formatChoice]
        : frontmatterHooks.diagnostics,
    };
  }
  return {
    ok: false,
    diagnostics: [pluginDiagnostic(
      'error',
      'plugin.format.unsupported_format',
      'Plugin bundle does not contain a supported manifest format.',
    )],
  };
}

/**
 * Refuse a frontmatter-declared component hook out loud (D9).
 *
 * hooks.md § Hooks in skills and agents: "In addition to settings files and
 * plugins, hooks can be defined directly in skills and subagents using
 * frontmatter. These hooks are scoped to the component's lifecycle and only run
 * when that component is active." and "All hook events are supported. For
 * subagents, `Stop` hooks are automatically converted to `SubagentStop` since
 * that is the event that fires when a subagent completes."
 *
 * R87 landed the SKILL half: `materializeRuntimeSkillInvocation` parses a skill's
 * `hooks` block and `BaseAgent.getComponentHookLayer` dispatches it scoped to the
 * invocation's lifetime, so a skill declaring hooks is no longer warned here —
 * doing so would be a false "will not run". The SUBAGENT half is not yet wired:
 * a subagent's `Stop` hook converts to `SubagentStop`, which fires parent-side
 * when the child returns, and that cross-session emission needs the spawner seam.
 * Until then a subagent declaring frontmatter hooks would import as FULLY
 * SUPPORTED while nothing runs, so the declaration becomes a warning plus a
 * deferral: the bundle reports `partial` rather than `supported`,
 * `claude plugin validate --strict` fails on it (`plugins/cli-reference.md#plugin-validate`), and
 * the Sources surface shows the deferred row.
 *
 * Format-agnostic on purpose, exactly like `applyPluginSkillFrontmatter` beside
 * it: the same YAML is equally inert in a Codex or native bundle, and four
 * per-adapter copies would drift.
 *
 * `splitMarkdownFrontmatter` keeps nested mappings opaque — a `hooks:` block
 * lands as the key with an empty value — so PRESENCE of the key is the whole
 * test, and no part of the declaration is interpreted here.
 */
async function reportFrontmatterHookDeclarations(
  manifest: NessyPluginManifest,
  rootDirectory: string,
  inputDiagnostics: PluginDiagnostic[],
  inputCompatibility: PluginCompatibilityReport | undefined,
): Promise<{ diagnostics: PluginDiagnostic[]; compatibility?: PluginCompatibilityReport }> {
  const components = manifest.capabilities.flatMap((capability): Array<{ kind: 'skill' | 'agent'; path: string }> => {
    if (capability.kind === 'skill') return [{ kind: 'skill', path: capability.skill.path }];
    if (capability.kind === 'agent') return [{ kind: 'agent', path: capability.agent.path }];
    return [];
  });
  if (components.length === 0) return { diagnostics: inputDiagnostics, ...(inputCompatibility ? { compatibility: inputCompatibility } : {}) };

  const diagnostics = [...inputDiagnostics];
  const deferredEntries: PluginCompatibilityReport['deferred'] = [];
  for (const component of components) {
    // R87 — SKILL frontmatter hooks now run: `materializeRuntimeSkillInvocation`
    // parses them and `BaseAgent.getComponentHookLayer` dispatches them, scoped
    // to the invocation's lifetime, on every direct-dispatch backend. Warning on
    // a skill would now be a FALSE "will not run".
    //
    // R87b — SUBAGENT frontmatter hooks now run too, but NOT from a plugin, and
    // this reporter only ever sees plugin-bundled components (its input is a
    // plugin manifest). `sub-agents.md`: "For security reasons, plugin subagents
    // don't support the `hooks`, `mcpServers`, or `permissionMode` frontmatter
    // fields. These fields are ignored when loading agents from a plugin." So the
    // warning is still true here — but its REASON changed, and the old wording
    // ("Nessy does not register subagent-scoped hooks") became false the moment a
    // native subagent's hooks started running.
    if (component.kind !== 'agent') continue;
    let declaresHooks = false;
    try {
      const content = await readFile(join(rootDirectory, component.path), 'utf-8');
      declaresHooks = 'hooks' in splitMarkdownFrontmatter(content).frontmatter;
    } catch {
      // An unreadable component file is already reported by the adapter that
      // produced the capability; silence here, never a false accusation.
      continue;
    }
    if (!declaresHooks) continue;
    const sourcePath = component.path;
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.frontmatter_hooks_unregistered',
      `Subagent "${sourcePath}" declares frontmatter hooks. Plugin subagents do not support the "hooks" frontmatter field, so they are ignored — move them to the plugin's hooks file to have them execute, or copy the agent file into your own agents directory where frontmatter hooks do run.`,
      sourcePath,
      { kind: 'hook', path: sourcePath },
    ));
    deferredEntries.push({
      externalKind: 'hook',
      reasonCode: 'plugin.deferred.frontmatter_hooks_unregistered',
      sourcePath,
    });
  }
  if (deferredEntries.length === 0) {
    return { diagnostics, ...(inputCompatibility ? { compatibility: inputCompatibility } : {}) };
  }
  if (!inputCompatibility) return { diagnostics };
  return {
    diagnostics,
    compatibility: {
      ...inputCompatibility,
      state: inputCompatibility.state === 'blocked' ? 'blocked' : 'partial',
      deferred: [
        ...inputCompatibility.deferred,
        ...deferredEntries.filter(entry => !inputCompatibility.deferred.some(existing => (
          existing.externalKind === entry.externalKind
          && existing.reasonCode === entry.reasonCode
          && existing.sourcePath === entry.sourcePath
        ))),
      ],
    },
  };
}

/**
 * Final format-agnostic pass that lets a bundled skill's own `SKILL.md`
 * frontmatter reach the capability.
 *
 * Placed here rather than in each adapter's skills branch for two reasons.
 * First, FOUR adapters produce skill capabilities (claude, codex,
 * `nessy-plugin-json` via `schema.ts`, and the legacy Nessy extension) and one
 * of them — `schema.ts normalizeCapability` — is a pure synchronous function
 * over the manifest record with no bundle root, so it cannot read the file at
 * all without restructuring its file access. Second, four hand-written copies
 * would drift and a fifth adapter added later would silently regress: the same
 * failure mode this fix exists to close. `qualifyNormalizedPluginStdioCommands`
 * below is the established precedent for a pass of exactly this shape.
 *
 * Strictly additive. A value an adapter already decoded from the manifest wins,
 * because an explicit declaration in `plugin.json` is the more specific
 * statement; frontmatter only fills what is absent. Nothing here grants a skill
 * a capability — only the restrictions its own author wrote down.
 */
async function applyPluginSkillFrontmatter(
  manifest: NessyPluginManifest,
  rootDirectory: string,
  inputDiagnostics: PluginDiagnostic[],
): Promise<{ value: NessyPluginManifest; diagnostics: PluginDiagnostic[] }> {
  const diagnostics = [...inputDiagnostics];
  if (!manifest.capabilities.some(capability => capability.kind === 'skill')) {
    return { value: manifest, diagnostics };
  }
  let changed = false;
  const capabilities = await Promise.all(manifest.capabilities.map(async (capability): Promise<PluginCapability> => {
    if (capability.kind !== 'skill') return capability;
    const declared = await readPluginSkillFrontmatter(rootDirectory, capability.skill.path);
    // P2.149/F8 — the refusal a malformed grant list owes the author. The
    // capability keeps the EMPTY grant `readPluginSkillFrontmatter` returned
    // (declared, pre-approves nothing) rather than the plausible-looking
    // tokenization of JSON text, and the author is told which field it was.
    for (const field of declared.malformedGrantFields ?? []) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.skill_grant_list_malformed',
        `Skill "${capability.skill.slug}" declares "${field}" as a list with an item that is not a tool name, `
        + 'so the list cannot be read as tool grants. It is treated as declared-and-empty (nothing is pre-approved) '
        + 'rather than guessed at. Write every entry as a string.',
        capability.skill.path,
        { kind: 'skill', slug: capability.skill.slug, field },
      ));
    }
    const description = capability.description ?? declared.description;
    const disableModelInvocation = capability.skill.disableModelInvocation
      ?? declared.disableModelInvocation;
    const userInvocable = capability.skill.userInvocable ?? declared.userInvocable;
    const allowedTools = capability.skill.allowedTools ?? declared.allowedTools;
    const paths = capability.skill.paths ?? declared.paths;
    if (description === capability.description
      && disableModelInvocation === capability.skill.disableModelInvocation
      && userInvocable === capability.skill.userInvocable
      && allowedTools === capability.skill.allowedTools
      && paths === capability.skill.paths) {
      return capability;
    }
    changed = true;
    return {
      ...capability,
      ...(description ? { description } : {}),
      skill: {
        ...capability.skill,
        ...(disableModelInvocation === undefined ? {} : { disableModelInvocation }),
        ...(userInvocable === undefined ? {} : { userInvocable }),
        ...(allowedTools ? { allowedTools } : {}),
        ...(paths ? { paths } : {}),
      },
    };
  }));
  return { value: changed ? { ...manifest, capabilities } : manifest, diagnostics };
}

/**
 * Final format-agnostic executable qualification. External adapters already
 * use the same policy while decoding their dialects; this pass is the native
 * Nessy/legacy safety net and prevents any future adapter from publishing a
 * stdio MCP that the runtime will later omit. Unsupported declarations remain
 * losslessly visible as inert capabilities so install compatibility is partial,
 * never falsely supported.
 */
function qualifyNormalizedPluginStdioCommands(
  manifest: NessyPluginManifest,
  rootDirectory: string,
  inputDiagnostics: PluginDiagnostic[],
): { value: NessyPluginManifest; diagnostics: PluginDiagnostic[] } {
  const diagnostics = [...inputDiagnostics];
  let changed = false;
  const capabilities = manifest.capabilities.map((capability): PluginCapability => {
    if (capability.kind !== 'mcp'
      || capability.mcp.transport !== 'stdio'
      || !capability.mcp.command) return capability;

    const qualification = qualifyPluginStdioCommand(capability.mcp.command, rootDirectory);
    const packageRunnerUnavailable = qualification.ok
      && qualification.kind === 'host'
      && (
        (qualification.runtime === 'npx'
          && !parsePluginPackageRunnerArgs(capability.mcp.args ?? []).ok)
        || (qualification.runtime === 'bunx'
          && !hasMaterializablePluginPackageRunner(rootDirectory, capability.mcp.args ?? []))
      );
    if (!qualification.ok || packageRunnerUnavailable) {
      changed = true;
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.nessy_mcp_command_unavailable',
        `MCP server "${capability.mcp.serverName}" command is not an approved managed runtime or executable bundle file and will remain unavailable.`,
        `capabilities.${capability.id}.mcp.command`,
        { kind: 'mcp', serverName: capability.mcp.serverName },
      ));
      return {
        id: capability.id,
        kind: 'unsupported',
        ...(capability.displayName ? { displayName: capability.displayName } : {}),
        ...(capability.description ? { description: capability.description } : {}),
        unsupported: {
          externalKind: 'mcp',
          reasonCode: 'plugin.deferred.nessy_mcp_command_unavailable',
          executable: true,
        },
      };
    }

    if (qualification.kind === 'bundle' && qualification.command !== capability.mcp.command) {
      changed = true;
      return {
        ...capability,
        mcp: { ...capability.mcp, command: qualification.command },
      };
    }
    return capability;
  });

  return {
    value: changed ? { ...manifest, capabilities } : manifest,
    diagnostics,
  };
}

export function mapExternalHookEventName(
  eventName: string,
  dialect: ExternalHookEventDialect = 'nessy',
): ExternalHookEventMappingResult {
  const table = dialect === 'claude'
    ? CLAUDE_HOOK_EVENT_MAP
    : dialect === 'codex'
      ? CODEX_HOOK_EVENT_MAP
      : NATIVE_HOOK_EVENT_MAP;
  const event = table[eventName];
  if (event) return { event, diagnostics: [] };
  const deferredReasonCode = DEFERRED_EXTERNAL_HOOK_EVENT_REASONS[eventName];
  // A documented-but-unemitted event is a deferral, not an unknown name: no
  // warning, and a reason code that names the work item.
  if (deferredReasonCode) return { diagnostics: [], deferredReasonCode };
  return {
    diagnostics: [pluginDiagnostic(
      'warning',
      'plugin.format.unknown_hook_event',
      `External hook event "${eventName}" is not mapped for ${dialect} compatibility.`,
      undefined,
      { dialect, eventName },
    )],
  };
}

function createNativePluginJsonAdapter(): PluginFormatAdapter {
  return {
    id: 'nessy-plugin-json',
    version: '1',
    detect(rootDirectory) {
      return existsSync(join(rootDirectory, 'plugin.json'));
    },
    normalize(rootDirectory, origin) {
      return readAndNormalizeManifest(join(rootDirectory, 'plugin.json'), origin);
    },
  };
}

function createLegacyNessyExtensionAdapter(): PluginFormatAdapter {
  return {
    id: LEGACY_NESSY_EXTENSION_ADAPTER_ID,
    version: LEGACY_NESSY_EXTENSION_ADAPTER_VERSION,
    detect(rootDirectory) {
      return existsSync(join(rootDirectory, 'nessy-extension.json'));
    },
    async normalize(rootDirectory, origin) {
      try {
        const raw = JSON.parse(await readFile(join(rootDirectory, 'nessy-extension.json'), 'utf-8'));
        return await normalizeLegacyNessyExtensionManifest(raw, rootDirectory, origin);
      } catch (error) {
        return {
          ok: false,
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.format.manifest_unreadable',
            `Legacy Nessy extension manifest could not be read: ${error instanceof Error ? error.message : String(error)}`,
            'nessy-extension.json',
          )],
        };
      }
    },
  };
}

function createClaudePluginJsonAdapter(): PluginFormatAdapter {
  return {
    id: CLAUDE_ADAPTER_ID,
    version: '1',
    detect(rootDirectory, options) {
      return detectClaudePluginBundle(rootDirectory, options?.marketplaceEntry);
    },
    async normalize(rootDirectory, origin, options) {
      return normalizeClaudePluginBundle(rootDirectory, origin, options);
    },
  };
}

/**
 * The manifest locations this adapter claims, in precedence order. A bundle
 * that ships both keeps the format-specific file as the one that is read; the
 * neutral `.agent-plugin` name is the fallback, never an override.
 */
const CODEX_ADAPTER_MANIFEST_CANDIDATES: readonly string[] = [
  CODEX_MANIFEST_RELATIVE_PATH,
  AGENT_MANIFEST_RELATIVE_PATH,
];

function resolveCodexAdapterManifestPath(rootDirectory: string): string | undefined {
  return CODEX_ADAPTER_MANIFEST_CANDIDATES.find(candidate => existsSync(join(rootDirectory, candidate)));
}

function createCodexCompatibilityDetectionAdapter(): PluginFormatAdapter {
  return {
    id: 'codex-plugin-json',
    version: '1',
    detect(rootDirectory) {
      return resolveCodexAdapterManifestPath(rootDirectory) !== undefined;
    },
    async normalize(rootDirectory, origin) {
      const manifestPath = resolveCodexAdapterManifestPath(rootDirectory) ?? CODEX_MANIFEST_RELATIVE_PATH;
      try {
        const raw = JSON.parse(await readFile(join(rootDirectory, manifestPath), 'utf-8'));
        return await normalizeCodexPluginManifest(raw, rootDirectory, origin);
      } catch (error) {
        return {
          ok: false,
          diagnostics: [pluginDiagnostic(
            'error',
            'plugin.format.manifest_unreadable',
            `Codex plugin manifest could not be read: ${error instanceof Error ? error.message : String(error)}`,
            manifestPath,
          )],
        };
      }
    },
  };
}

async function readAndNormalizeManifest(
  manifestPath: string,
  origin: PluginOrigin,
): Promise<PluginValidationResult<NessyPluginManifest>> {
  try {
    const raw = JSON.parse(await readFile(manifestPath, 'utf-8'));
    // Native Nessy manifests declare setting/command/asset first-class; the
    // adapter records that explicit provenance in nessyExtensions (W7 Step 5).
    return normalizeNessyPluginManifest(raw, { origin, deriveNessyExtensionsFromCapabilities: true });
  } catch (error) {
    return {
      ok: false,
      diagnostics: [pluginDiagnostic(
        'error',
        'plugin.format.manifest_unreadable',
        `Plugin manifest could not be read: ${error instanceof Error ? error.message : String(error)}`,
        manifestPath,
      )],
    };
  }
}

async function normalizeLegacyNessyExtensionManifest(
  input: unknown,
  rootDirectory: string,
  origin: PluginOrigin,
): Promise<PluginValidationResult<NessyPluginManifest>> {
  if (!isRecord(input)) {
    return {
      ok: false,
      diagnostics: [pluginDiagnostic('error', 'plugin.format.legacy_manifest_not_object', 'Legacy Nessy extension manifest must be an object.')],
    };
  }

  const diagnostics: PluginDiagnostic[] = [];
  const legacy = await normalizeLegacyCapabilities(input, rootDirectory, diagnostics);
  const nativeCandidate = {
    schemaVersion: 1,
    kind: 'plugin',
    id: stringField(input, 'id') ?? stringField(input, 'pluginId') ?? stringField(input, 'slug') ?? stringField(input, 'name'),
    name: stringField(input, 'name') ?? stringField(input, 'title') ?? stringField(input, 'id') ?? stringField(input, 'slug'),
    version: stringField(input, 'version'),
    ...(stringField(input, 'description') ? { description: stringField(input, 'description') } : {}),
    ...(stringField(input, 'publisher') ? { publisher: stringField(input, 'publisher') } : {}),
    capabilities: legacy.capabilities,
    ...(legacy.connectors.length > 0 ? { connectors: legacy.connectors } : {}),
  };
  if (isRecord(input.install) && (stringField(input.install, 'command') ?? stringField(input.install, 'cmd'))) {
    diagnostics.push(pluginDiagnostic(
      'info',
      'plugin.format.install_command_ignored',
      'Legacy Nessy extension install command is metadata only and will not be executed.',
      'install.command',
    ));
  }

  const result = normalizeNessyPluginManifest(nativeCandidate, {
    origin: {
      ...origin,
      adapterId: LEGACY_NESSY_EXTENSION_ADAPTER_ID,
      adapterVersion: LEGACY_NESSY_EXTENSION_ADAPTER_VERSION,
    },
    // Legacy Nessy extensions are a Nessy-owned format: their declared
    // setting/command/asset capabilities carry explicit provenance.
    deriveNessyExtensionsFromCapabilities: true,
  });
  return {
    ok: result.ok,
    ...(result.value ? { value: {
      ...result.value,
      compatibility: {
        rawExternalKind: stringField(input, 'kind') ?? 'nessy-extension',
        adapter: {
          adapterId: LEGACY_NESSY_EXTENSION_ADAPTER_ID,
          adapterVersion: LEGACY_NESSY_EXTENSION_ADAPTER_VERSION,
          rawKind: stringField(input, 'kind') ?? 'nessy-extension',
          warnings: diagnostics.filter((diagnostic): diagnostic is PluginDiagnostic & { severity: 'warning' } => diagnostic.severity === 'warning'),
        },
      },
    } } : {}),
    diagnostics: [...diagnostics, ...result.diagnostics],
  };
}

async function normalizeLegacyCapabilities(
  input: UnknownRecord,
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
): Promise<{ capabilities: PluginCapability[]; connectors: PluginConnectorDescriptor[] }> {
  const capabilitiesInput = input.capabilities;
  if (capabilitiesInput !== undefined && !isRecord(capabilitiesInput)) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.legacy_capabilities_ignored',
      'Legacy capabilities must be an object with skills, mcpServers, and hooks arrays.',
      'capabilities',
    ));
  }
  const capabilitySource = isRecord(capabilitiesInput) ? capabilitiesInput : input;
  const mcp = normalizeLegacyMcpServers(
    capabilitySource.mcpServers ?? capabilitySource.mcp_servers ?? capabilitySource.mcp,
    diagnostics,
  );
  return {
    capabilities: [
      ...await normalizeLegacySkills(capabilitySource.skills, rootDirectory, diagnostics),
      ...await normalizeLegacyPromptCommands(capabilitySource.commands, rootDirectory, diagnostics),
      ...await normalizeLegacyAgents(capabilitySource.agents, rootDirectory, diagnostics),
      ...mcp.capabilities,
      ...normalizeLegacyHooks(capabilitySource.hooks, diagnostics),
    ],
    connectors: mcp.connectors,
  };
}

async function normalizeLegacySkills(
  input: unknown,
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
): Promise<PluginCapability[]> {
  if (input === undefined) return inferConventionalLegacySkills(rootDirectory);
  const entries = typeof input === 'string'
    ? [input]
    : Array.isArray(input)
      ? input
      : isRecord(input)
        ? Object.values(input)
        : undefined;
  if (!entries) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.legacy_capabilities_ignored',
      'Legacy skills must be a path string, array, or object map.',
      'skills',
    ));
    return [];
  }
  const capabilities: PluginCapability[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry === 'string') {
      capabilities.push(...await scanLegacySkillPath(entry, rootDirectory, diagnostics, `capabilities.skill.${index}`));
      continue;
    }
    const record = isRecord(entry) ? entry : undefined;
    if (!record) {
      diagnostics.push(incompleteLegacyCapability('skill', index, 'Skill capability requires an object with id/slug and path.'));
      continue;
    }
    const id = stringField(record, 'id') ?? stringField(record, 'slug') ?? stringField(record, 'name');
    const path = stringField(record, 'path') ?? stringField(record, 'skillPath');
    const slug = stringField(record, 'slug') ?? id;
    if (!id || !path || !slug) {
      diagnostics.push(incompleteLegacyCapability('skill', index, 'Skill capability requires id/slug and path.'));
      continue;
    }
    capabilities.push({
      kind: 'skill',
      id,
      ...(stringField(record, 'displayName') ?? stringField(record, 'name') ? {
        displayName: stringField(record, 'displayName') ?? stringField(record, 'name'),
      } : {}),
      skill: {
        slug,
        path,
      },
    });
  }
  return capabilities;
}

async function inferConventionalLegacySkills(rootDirectory: string): Promise<PluginCapability[]> {
  const skillsDirectory = join(rootDirectory, 'skills');
  try {
    const skillsDirectoryStat = await lstat(skillsDirectory);
    if (!skillsDirectoryStat.isDirectory() || skillsDirectoryStat.isSymbolicLink()) return [];

    const children = (await readdir(skillsDirectory, { withFileTypes: true }))
      .filter(child => child.isDirectory() && !child.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name));
    const capabilities: PluginCapability[] = [];
    for (const child of children) {
      const childDirectory = join(skillsDirectory, child.name);
      const skillFile = join(childDirectory, 'SKILL.md');
      try {
        const [childStat, skillStat] = await Promise.all([lstat(childDirectory), lstat(skillFile)]);
        if (!childStat.isDirectory() || childStat.isSymbolicLink()
          || !skillStat.isFile() || skillStat.isSymbolicLink()) continue;
      } catch {
        continue;
      }
      capabilities.push({
        kind: 'skill',
        id: child.name,
        skill: { slug: child.name, path: `skills/${child.name}/SKILL.md` },
      });
    }
    return capabilities;
  } catch {
    return [];
  }
}

interface LegacyMarkdownCapabilitySource {
  path: string;
  name?: string;
  description?: string;
  argumentHint?: string;
  model?: string;
  tools?: string[];
}

async function normalizeLegacyPromptCommands(
  input: unknown,
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
): Promise<PluginCapability[]> {
  const sources = await resolveLegacyMarkdownCapabilitySources(
    input,
    'commands',
    rootDirectory,
    diagnostics,
    'prompt-command',
  );
  const capabilities: PluginCapability[] = [];
  const seenNames = new Set<string>();
  for (const source of sources) {
    let content: string;
    try {
      content = await readFile(join(rootDirectory, ...source.path.split('/')), 'utf-8');
    } catch (error) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.legacy_capability_incomplete',
        `Legacy prompt command "${source.path}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
        source.path,
        { kind: 'prompt-command', path: source.path },
      ));
      continue;
    }
    const { frontmatter } = splitMarkdownFrontmatter(content);
    const inferredName = legacyMarkdownLogicalName(source.path, 'commands');
    const name = source.name ?? frontmatter.name ?? inferredName;
    if (!name) continue;
    if (seenNames.has(name)) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.legacy_capability_duplicate',
        `Legacy prompt command name "${name}" is duplicated; the later declaration was ignored.`,
        source.path,
      ));
      continue;
    }
    seenNames.add(name);
    capabilities.push({
      kind: 'prompt-command',
      id: legacyMarkdownCapabilityId('prompt-command', name),
      ...(source.description ?? frontmatter.description
        ? { description: source.description ?? frontmatter.description }
        : {}),
      promptCommand: {
        name,
        path: source.path,
        ...(source.argumentHint ?? frontmatter['argument-hint']
          ? { argumentHint: source.argumentHint ?? frontmatter['argument-hint'] }
          : {}),
        ...(source.model ?? frontmatter.model ? { model: source.model ?? frontmatter.model } : {}),
      },
    });
  }
  return capabilities;
}

async function normalizeLegacyAgents(
  input: unknown,
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
): Promise<PluginCapability[]> {
  const sources = await resolveLegacyMarkdownCapabilitySources(
    input,
    'agents',
    rootDirectory,
    diagnostics,
    'agent',
  );
  const capabilities: PluginCapability[] = [];
  const seenNames = new Set<string>();
  for (const source of sources) {
    let content: string;
    try {
      content = await readFile(join(rootDirectory, ...source.path.split('/')), 'utf-8');
    } catch (error) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.legacy_capability_incomplete',
        `Legacy agent "${source.path}" could not be read: ${error instanceof Error ? error.message : String(error)}`,
        source.path,
        { kind: 'agent', path: source.path },
      ));
      continue;
    }
    const { frontmatter } = splitMarkdownFrontmatter(content);
    const name = source.name ?? frontmatter.name ?? legacyMarkdownLogicalName(source.path, 'agents');
    if (!name) continue;
    if (seenNames.has(name)) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.legacy_capability_duplicate',
        `Legacy agent name "${name}" is duplicated; the later declaration was ignored.`,
        source.path,
      ));
      continue;
    }
    seenNames.add(name);
    // `splitToolGrantList`, the one tokenizer — this was the FIFTH and last bare
    // comma split on a tool list, after P6b replaced three and P9 the fourth. It
    // outlived those sweeps only because `?.split(',')` sat on its own wrapped
    // line, so a single-line grep for the pattern never reached it.
    //
    // The legacy Nessy-extension format is Nessy-owned, so no rival semantics
    // claims the comma, and one thing settles the split: the same `agents/*.md`
    // file is re-read at dispatch by `buildPiRuntimeAgentDescriptor` as
    // `agent.tools ?? frontmatter.tools`, so the CAPABILITY's list wins and
    // whatever this produces is what the runtime grants. Splitting
    // `Agent(scan-inventory, scan-researcher)` yielded two names no runtime
    // resolves, which the Pi side then denies by omission — the 1.25.0 defect P6b
    // measured on the Claude path, reachable from a legacy bundle by the same
    // route. A manifest-declared `tools` array still wins over the frontmatter;
    // it arrives through `readStringArray` and was never split.
    const frontmatterTools = frontmatter.tools ? splitToolGrantList(frontmatter.tools) : undefined;
    const tools = source.tools?.length ? source.tools : frontmatterTools;
    capabilities.push({
      kind: 'agent',
      id: legacyMarkdownCapabilityId('agent', name),
      ...(source.description ?? frontmatter.description
        ? { description: source.description ?? frontmatter.description }
        : {}),
      agent: {
        name,
        path: source.path,
        ...(source.model ?? frontmatter.model ? { model: source.model ?? frontmatter.model } : {}),
        ...(tools?.length ? { tools } : {}),
      },
    });
  }
  return capabilities;
}

async function resolveLegacyMarkdownCapabilitySources(
  input: unknown,
  conventionalDirectory: 'commands' | 'agents',
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
  kind: 'prompt-command' | 'agent',
): Promise<LegacyMarkdownCapabilitySource[]> {
  if (input === undefined) {
    return (await scanLegacyMarkdownPath(conventionalDirectory, rootDirectory, diagnostics, conventionalDirectory))
      .map(path => ({ path }));
  }

  const entries: Array<{ key?: string; value: unknown }> = typeof input === 'string'
    ? [{ value: input }]
    : Array.isArray(input)
      ? input.map(value => ({ value }))
      : isRecord(input)
        ? Object.entries(input).map(([key, value]) => ({ key, value }))
        : [];
  if (entries.length === 0) {
    if (!Array.isArray(input) || input.length > 0) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.legacy_capabilities_ignored',
        `Legacy ${conventionalDirectory} must be a path string, array, or object map.`,
        conventionalDirectory,
      ));
    }
    return [];
  }

  const sources: LegacyMarkdownCapabilitySource[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry.value === 'string') {
      const paths = await scanLegacyMarkdownPath(
        entry.value,
        rootDirectory,
        diagnostics,
        `${conventionalDirectory}.${entry.key ?? index}`,
        true,
      );
      sources.push(...paths.map(path => ({
        path,
        ...(entry.key && paths.length === 1 ? { name: entry.key } : {}),
      })));
      continue;
    }
    if (!isRecord(entry.value)) {
      diagnostics.push(incompleteLegacyCapability(kind, index, `Legacy ${kind} capability requires a Markdown path.`));
      continue;
    }
    const path = stringField(entry.value, 'path');
    if (!path) {
      diagnostics.push(incompleteLegacyCapability(kind, index, `Legacy ${kind} capability requires path.`));
      continue;
    }
    const paths = await scanLegacyMarkdownPath(
      path,
      rootDirectory,
      diagnostics,
      `${conventionalDirectory}.${entry.key ?? index}.path`,
      true,
    );
    if (paths.length !== 1) {
      sources.push(...paths.map(discoveredPath => ({ path: discoveredPath })));
      continue;
    }
    sources.push({
      path: paths[0]!,
      ...(stringField(entry.value, 'name') ?? stringField(entry.value, 'id') ?? entry.key
        ? { name: stringField(entry.value, 'name') ?? stringField(entry.value, 'id') ?? entry.key }
        : {}),
      ...(stringField(entry.value, 'description') ? { description: stringField(entry.value, 'description') } : {}),
      ...(stringField(entry.value, 'argumentHint') ?? stringField(entry.value, 'argument-hint')
        ? { argumentHint: stringField(entry.value, 'argumentHint') ?? stringField(entry.value, 'argument-hint') }
        : {}),
      ...(stringField(entry.value, 'model') ? { model: stringField(entry.value, 'model') } : {}),
      ...(readStringArray(entry.value.tools) ? { tools: readStringArray(entry.value.tools) } : {}),
    });
  }
  return sources.sort((left, right) => left.path.localeCompare(right.path));
}

async function scanLegacyMarkdownPath(
  rawPath: string,
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
  reportMissing = false,
): Promise<string[]> {
  const path = rawPath.replace(/^\.\//, '').replace(/\/$/, '');
  const pathError = validatePluginRelativePath(path);
  if (pathError) {
    diagnostics.push(pluginDiagnostic('warning', 'plugin.prompt_command.invalid_path', pathError, diagnosticPath));
    return [];
  }

  const parts = path.split('/');
  let absolutePath = rootDirectory;
  try {
    for (const part of parts) {
      absolutePath = join(absolutePath, part);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        diagnostics.push(pluginDiagnostic(
          'warning',
          'plugin.prompt_command.invalid_path',
          `Legacy Markdown path "${rawPath}" contains a symbolic link.`,
          diagnosticPath,
        ));
        return [];
      }
    }
  } catch {
    if (reportMissing) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.legacy_capability_incomplete',
        `Legacy Markdown path "${rawPath}" does not exist.`,
        diagnosticPath,
      ));
    }
    return [];
  }

  const discovered: string[] = [];
  const walk = async (relativePath: string, depth: number): Promise<void> => {
    if (depth > 16) return;
    const absolute = join(rootDirectory, ...relativePath.split('/'));
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) return;
    if (stats.isFile()) {
      if (relativePath.toLowerCase().endsWith('.md')) discovered.push(relativePath);
      return;
    }
    if (!stats.isDirectory()) return;
    const children = (await readdir(absolute, { withFileTypes: true }))
      .filter(child => !child.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      await walk(`${relativePath}/${child.name}`, depth + 1);
    }
  };
  try {
    await walk(path, 0);
  } catch {
    return [];
  }
  return discovered;
}

function legacyMarkdownLogicalName(path: string, conventionalDirectory: string): string {
  const prefix = `${conventionalDirectory}/`;
  const relativePath = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return relativePath.slice(0, -extname(relativePath).length);
}

function legacyMarkdownCapabilityId(kind: 'prompt-command' | 'agent', name: string): string {
  const normalized = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '') || kind;
  return `${kind}.${normalized}`;
}

async function scanLegacySkillPath(
  rawPath: string,
  rootDirectory: string,
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
): Promise<PluginCapability[]> {
  const path = rawPath.replace(/^\.\//, '').replace(/\/$/, '');
  const pathError = validatePluginRelativePath(path);
  if (pathError) {
    diagnostics.push(pluginDiagnostic('warning', 'plugin.skill.invalid_path', pathError, diagnosticPath));
    return [];
  }
  const absolutePath = join(rootDirectory, path);
  if (path.endsWith('/SKILL.md') && existsSync(absolutePath)) {
    const slug = basename(dirname(path));
    return [{ kind: 'skill', id: slug, skill: { slug, path } }];
  }
  if (existsSync(join(absolutePath, 'SKILL.md'))) {
    const slug = basename(path);
    return [{ kind: 'skill', id: slug, skill: { slug, path: `${path}/SKILL.md` } }];
  }
  try {
    const children = (await readdir(absolutePath, { withFileTypes: true }))
      .filter(child => child.isDirectory() && existsSync(join(absolutePath, child.name, 'SKILL.md')))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (children.length > 0) {
      return children.map(child => ({
        kind: 'skill' as const,
        id: child.name,
        skill: { slug: child.name, path: `${path}/${child.name}/SKILL.md` },
      }));
    }
  } catch {}
  diagnostics.push(pluginDiagnostic(
    'warning',
    'plugin.format.legacy_capability_incomplete',
    `Legacy skills path "${rawPath}" did not contain any SKILL.md files.`,
    diagnosticPath,
    { kind: 'skill', path: rawPath },
  ));
  return [];
}

function normalizeLegacyMcpServers(
  input: unknown,
  diagnostics: PluginDiagnostic[],
): { capabilities: PluginCapability[]; connectors: PluginConnectorDescriptor[] } {
  if (input === undefined) return { capabilities: [], connectors: [] };
  const entries = Array.isArray(input)
    ? input.map((entry, index) => ({ key: String(index), value: entry, useKeyAsName: false }))
    : isRecord(input)
      ? Object.entries(input).map(([key, value]) => ({ key, value, useKeyAsName: true }))
      : undefined;
  if (!entries) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.legacy_capabilities_ignored',
      'Legacy mcpServers must be an array or object map.',
      'mcpServers',
    ));
    return { capabilities: [], connectors: [] };
  }
  const capabilities: PluginCapability[] = [];
  const connectors: PluginConnectorDescriptor[] = [];
  entries.forEach((entry, index) => {
    const record = isRecord(entry.value) ? entry.value : undefined;
    if (!record) {
      diagnostics.push(incompleteLegacyCapability('mcp', index, 'MCP capability requires an object with id/serverName and transport details.'));
      return;
    }
    const id = stringField(record, 'id') ?? stringField(record, 'serverName') ?? stringField(record, 'name') ?? (entry.useKeyAsName ? entry.key : undefined);
    const serverName = stringField(record, 'serverName') ?? stringField(record, 'name') ?? (entry.useKeyAsName ? entry.key : undefined) ?? id;
    const legacyHttpUrl = stringField(record, 'httpUrl');
    const url = stringField(record, 'url') ?? legacyHttpUrl;
    // `mcp.md:83` names `streamable-http` as an alias for `http`; folded here
    // so a legacy manifest map behaves like the Claude reader.
    const rawTransport = normalizeMcpTransportAlias(stringField(record, 'transport') ?? stringField(record, 'type')
      ?? (stringField(record, 'command') ? 'stdio' : url ? 'http' : undefined));
    const transport = rawTransport === 'stdio' || rawTransport === 'http' || rawTransport === 'sse'
      ? rawTransport
      : undefined;
    if (!id || !serverName || !transport) {
      diagnostics.push(incompleteLegacyCapability('mcp', index, 'MCP capability requires id/serverName and transport details.'));
      return;
    }
    const displayName = stringField(record, 'displayName') ?? stringField(record, 'name');
    const description = stringField(record, 'description');
    if (legacyHttpUrl) {
      const oauth = isRecord(record.oauth) ? record.oauth : undefined;
      const clientId = oauth ? stringField(oauth, 'clientId') : undefined;
      connectors.push({
        id,
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        mcpServers: [{
          serverName,
          transport: transport === 'sse' ? 'sse' : 'http',
          url: rewriteLegacyRuntimeTokens(legacyHttpUrl),
          ...(clientId ? { clientId } : {}),
        }],
        auth: oauth
          ? { type: 'oauth', timing: 'ON_FIRST_USE' }
          : { type: 'none' },
      });
      return;
    }
    const environment = normalizeLegacyMcpEnvironment(record.env, diagnostics, `mcpServers.${entry.key}.env`);
    if (environment.requiredNames.length > 0) {
      diagnostics.push(pluginDiagnostic(
        'info',
        'plugin.format.legacy_mcp_environment_required',
        `MCP server "${serverName}" requires environment variables: ${environment.requiredNames.join(', ')}.`,
        `mcpServers.${entry.key}.env`,
        { serverName, names: environment.requiredNames },
      ));
    }
    const args = readStringArray(record.args)?.map(rewriteLegacyRuntimeTokens);
    const headers = isStringRecord(record.headers)
      ? rewriteLegacyRuntimeTokensInRecord(record.headers)
      : undefined;
    capabilities.push({
      kind: 'mcp',
      id,
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      mcp: {
        serverName,
        transport,
        ...(stringField(record, 'command') ? { command: rewriteLegacyRuntimeTokens(stringField(record, 'command')!) } : {}),
        ...(args ? { args } : {}),
        ...(stringField(record, 'cwd') ? { cwd: rewriteLegacyRuntimeTokens(stringField(record, 'cwd')!) } : {}),
        ...(url ? { url: rewriteLegacyRuntimeTokens(url) } : {}),
        ...(Object.keys(environment.values).length > 0 ? { env: environment.values } : {}),
        ...(Object.keys(environment.defaults).length > 0 ? { environmentDefaults: environment.defaults } : {}),
        ...(environment.requiredNames.length > 0 ? { requiredEnvironmentNames: environment.requiredNames } : {}),
        ...(headers ? { headers } : {}),
      },
    });
  });
  return { capabilities, connectors };
}

function normalizeLegacyMcpEnvironment(
  input: unknown,
  diagnostics: PluginDiagnostic[],
  diagnosticPath: string,
): { values: Record<string, string>; defaults: Record<string, string>; requiredNames: string[] } {
  if (input === undefined) return { values: {}, defaults: {}, requiredNames: [] };
  if (!isRecord(input)) {
    diagnostics.push(pluginDiagnostic(
      'warning',
      'plugin.format.legacy_capabilities_ignored',
      'Legacy MCP env must be an object map.',
      diagnosticPath,
    ));
    return { values: {}, defaults: {}, requiredNames: [] };
  }
  const values: Record<string, string> = {};
  const defaults: Record<string, string> = {};
  const requiredNames: string[] = [];
  for (const [name, rawValue] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      diagnostics.push(pluginDiagnostic('warning', 'plugin.format.legacy_mcp_env_name_invalid', `Invalid environment variable name "${name}".`, `${diagnosticPath}.${name}`));
      continue;
    }
    if (typeof rawValue === 'string') {
      values[name] = rewriteLegacyRuntimeTokens(rawValue);
      continue;
    }
    if (!isRecord(rawValue)) {
      diagnostics.push(pluginDiagnostic('warning', 'plugin.format.legacy_mcp_env_descriptor_invalid', `Environment variable "${name}" must be a string or descriptor object.`, `${diagnosticPath}.${name}`));
      continue;
    }
    const defaultValue = typeof rawValue.default === 'string' ? rawValue.default : undefined;
    if (defaultValue !== undefined) defaults[name] = rewriteLegacyRuntimeTokens(defaultValue);
    if (rawValue.required === true && defaultValue === undefined) {
      requiredNames.push(name);
    }
  }
  requiredNames.sort();
  return { values, defaults, requiredNames };
}

function rewriteLegacyRuntimeTokens(value: string): string {
  return value
    .replace(/\$\{extensionPath\}/g, '${NESSY_PLUGIN_ROOT}')
    .replace(/\$extensionPath\b/g, '$NESSY_PLUGIN_ROOT');
}

function rewriteLegacyRuntimeTokensInRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, rewriteLegacyRuntimeTokens(value)]));
}

function normalizeLegacyHooks(input: unknown, diagnostics: PluginDiagnostic[]): PluginCapability[] {
  if (!Array.isArray(input)) return [];
  const capabilities: PluginCapability[] = [];
  input.forEach((entry, index) => {
    const record = isRecord(entry) ? entry : undefined;
    if (!record) {
      diagnostics.push(incompleteLegacyCapability('hook', index, 'Hook capability requires an object with id, event, type, and command.'));
      return;
    }
    const id = stringField(record, 'id') ?? stringField(record, 'name');
    const eventName = stringField(record, 'event');
    const mapped: ExternalHookEventMappingResult = eventName
      ? mapExternalHookEventName(eventName, 'nessy')
      : { diagnostics: [incompleteLegacyCapability('hook', index, 'Hook capability requires event.')] };
    diagnostics.push(...mapped.diagnostics);
    const rawType = stringField(record, 'type') ?? (stringField(record, 'command') ? 'command' : undefined);
    const type = rawType === 'command' ? rawType : undefined;
    // R73 · R88 — a DEFERRED event is not an incomplete declaration, and saying
    // so was a regression: this used to fall through to "requires id, event, and
    // command hook type" for an entry that supplied all three, which is both
    // false and unactionable. Pre-R73 the author at least got
    // `unknown_hook_event` naming the event. Carry the routed reason instead —
    // as a warning the author reads, AND as an `unsupported` capability so
    // `nativeCompatibilityReport` reports the bundle `partial` with the same
    // deferral row the Claude and Codex adapters produce for the same hook.
    if (mapped.deferredReasonCode && eventName) {
      diagnostics.push(pluginDiagnostic(
        'warning',
        'plugin.format.deferred_hook_event',
        `Hook event "${eventName}" is not emitted by Nessy, so this hook would never run. `
        + (DEFERRED_EXTERNAL_HOOK_EVENT_EXPLANATIONS[mapped.deferredReasonCode]
          ?? `It is deferred (${mapped.deferredReasonCode}).`),
        `capabilities.hook.${index}`,
        { kind: 'hook', index, eventName },
      ));
      capabilities.push({
        id: id ?? `hook-event-${eventName}-${index}`,
        kind: 'unsupported',
        unsupported: {
          externalKind: `hook-event-${eventName}`,
          reasonCode: mapped.deferredReasonCode,
          // Same rule `format-adapters/shared.ts` applies: a deferral that would
          // have SPAWNED something stays marked as such.
          executable: type === 'command',
        },
      });
      return;
    }
    if (!id || !mapped.event || !type) {
      diagnostics.push(incompleteLegacyCapability('hook', index, 'Hook capability requires id, event, and command hook type.'));
      return;
    }
    capabilities.push({
      kind: 'hook',
      id,
      hook: {
        id,
        event: mapped.event,
        type,
        ...(stringField(record, 'command') ? { command: stringField(record, 'command') } : {}),
        // Presence, not length, selects exec form (hooks.md), so the empty
        // vector survives here too.
        ...(readHookArgsVector(record.args).args ? { args: readHookArgsVector(record.args).args } : {}),
        ...(typeof record.timeoutMs === 'number' && Number.isFinite(record.timeoutMs) ? { timeoutMs: record.timeoutMs } : {}),
        ...(stringField(record, 'statusMessage') ? { statusMessage: stringField(record, 'statusMessage') } : {}),
        ...(stringField(record, 'cwd') ? { cwd: stringField(record, 'cwd') } : {}),
      },
    });
  });
  return capabilities;
}

function incompleteLegacyCapability(kind: string, index: number, message: string): PluginDiagnostic {
  return pluginDiagnostic(
    'warning',
    'plugin.format.legacy_capability_incomplete',
    message,
    `capabilities.${kind}.${index}`,
    { kind, index },
  );
}
