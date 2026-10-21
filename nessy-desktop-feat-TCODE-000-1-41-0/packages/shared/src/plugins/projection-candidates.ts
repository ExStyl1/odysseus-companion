/**
 * Activation-free plugin projection CANDIDATES (W7 Step 6).
 *
 * Projection reads exclusively from the immutable normalized bundle: every
 * resource is a `PluginBundleResourceRef` (a validated bundle-relative path plus
 * the content hash), never a fake native `sourcePath`/`targetPath` and never a
 * copy into `CONFIG_DIR/skills`, a Workspace `skills` dir, `.agents/skills`,
 * `.mcp.json` or `.nessy-agent/*`.
 *
 * ALL duplicate plugin/server/skill names are kept as candidates — W8 owns the
 * collision-selection policy. The generic Codex core surface is
 * skill/mcp/hook/app; `setting` comes only from the explicit `nessyExtensions`
 * section; an unrecognized capability kind is retained as `unsupported-runtime`
 * for catalog/provenance rather than dropped.
 *
 * `command` and `asset` are NEVER runnable here, deliberately, and an installed
 * bundle does not even reach the branches below that say so: MEASURED end to end
 * (P2.169, 2026-08-25), `deferUnavailablePluginSurfaces`
 * (`format-adapters/shared.ts`) rewrites both kinds into `kind: 'unsupported'`
 * during `normalizePluginBundle` — the one entry `acquisition.ts` installs
 * through — recording each on `compatibility.deferred` with a warning
 * diagnostic and `state: 'partial'`. So `case 'command'`/`case 'asset'` below are
 * defence in depth for a hand-built manifest, and what a real plugin's command
 * or asset arrives as is `case 'unsupported'`.
 *
 * Promoting them would surface nothing. `view.commands` has exactly three
 * readers — `enabledPluginBundleRoots` (a PATH root), `intersectAgentRuntimeView`
 * (the child-session ceiling) and `harness-manifest.ts` (the manifest digest) —
 * and NONE invokes or lists a command; `NativeCapabilityKind` cannot produce one
 * either, so that array is always empty. What the two kinds owe the user is an
 * honest catalog row, which is what {@link UNSUPPORTED_EXTERNAL_COMPONENT_KINDS}
 * gives them.
 */

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pluginOutputStyleId } from '../prompts/output-styles.ts';
import { isPluginMcpCapabilityPathEnabled } from '../feature-flags.ts';
import { isCommandMonitorDescriptor } from './types.ts';
import type { CapabilityScopeRef } from '../capabilities/types.ts';
import type { PluginInstalledEntryV2 } from './store-v2.ts';
import type {
  PluginAppDescriptor,
  PluginBundleResourceRef,
  PluginCapabilityTrustRequirement,
  PluginConnectorDescriptor,
  PluginInstanceId,
  PluginKey,
  PluginProjectionCandidateKind,
  PluginCapability,
  PluginUserConfigurationDescriptor,
} from './types.ts';

export interface PluginProjectionCandidate {
  key: string;
  pluginKey: PluginKey;
  pluginInstanceId: PluginInstanceId;
  capabilityId: string;
  kind: PluginProjectionCandidateKind;
  /** User-facing kind for an inert retained declaration; never runtime authority. */
  componentKind?: Exclude<PluginProjectionCandidateKind, 'unsupported-runtime'>;
  logicalName: string;
  displayName?: string;
  description?: string;
  selectedScope: CapabilityScopeRef;
  /** Immutable-bundle resource; absent for capabilities with no bundle file. */
  resource?: PluginBundleResourceRef;
  trust: PluginCapabilityTrustRequirement;
  /** Server-only normalized runtime declaration pinned by the bundle hash. */
  runtimeDefinition?: PluginCapability;
  /**
   * The plugin's DECLARED user-option schema (`plugins/manifest-reference.md#user-configuration`'s
   * `userConfig`), carried per candidate so the resolver can substitute
   * `${user_config.KEY}` at `:577`'s sites.
   *
   * The SCHEMA only — keys, types and whether each is sensitive. No value ever
   * rides a candidate: values reach the resolver through the host's
   * `pluginOptionEnvironmentFor` seam, which reads the credential store, and
   * this list is what supplies the original key case that the
   * `CLAUDE_PLUGIN_OPTION_<KEY>` spelling has uppercased away.
   */
  userConfiguration?: readonly PluginUserConfigurationDescriptor[];
  /**
   * For an `app` candidate (K1): the declarative app descriptor plus the
   * resolved connector it routes to. Both come verbatim from the immutable
   * manifest; `connector` is absent when the app names a `connectorId` with no
   * matching connector declaration (routing then binds to no MCP server).
   */
  app?: PluginAppDescriptor;
  connector?: PluginConnectorDescriptor;
}

const NO_TRUST: PluginCapabilityTrustRequirement = { required: false };

function hostDerivedPluginTrust(
  bundleHash: string,
  definition: unknown,
  declaredTrust?: PluginCapabilityTrustRequirement,
): PluginCapabilityTrustRequirement {
  return {
    required: true,
    reason: declaredTrust?.reason ?? 'Installed plugin executable or network capability requires explicit trust.',
    ...(declaredTrust?.executablePath ? { executablePath: declaredTrust.executablePath } : {}),
    executableHash: createHash('sha256')
      .update(bundleHash)
      .update('\0')
      .update(JSON.stringify({ definition, executablePath: declaredTrust?.executablePath ?? null }))
      .digest('hex'),
  };
}

/**
 * `output-style` is deliberately absent from the trust-required set below. A
 * style is DATA that reaches the system prompt only when the user selects it, and
 * it cannot subtract safety text — the split `getSafetyAndEngineeringSections`
 * applies is per bullet, and only `coding: true` bullets are subtractable. That
 * puts it with skills-without-an-entrypoint rather than with agents, whose
 * definitions grant tools. The install-time trust for the bundle as a whole still
 * applies; what is not required is a second per-capability grant.
 */
function effectivePluginTrust(bundleHash: string, capability: PluginCapability): PluginCapabilityTrustRequirement {
  const requiresTrust = capability.kind === 'mcp'
    || capability.kind === 'hook'
    || capability.kind === 'agent'
    || capability.kind === 'workflow'
    || capability.kind === 'lsp'
    || capability.kind === 'monitor'
    || capability.kind === 'command'
    || (capability.kind === 'skill' && !!capability.skill.entrypoint);
  if (!requiresTrust) return capability.trust ?? NO_TRUST;
  const { trust: declaredTrust, ...definition } = capability;
  return hostDerivedPluginTrust(bundleHash, definition, declaredTrust);
}

/**
 * `unsupported.externalKind` values that name a real component kind, so an inert
 * retained declaration can still say WHAT it was.
 *
 * `componentKind` is presentation only — "never runtime authority", as its own
 * field doc says — and it is the channel this needs: a deferred command is
 * already charged for on `compatibility.deferred`, which flips the report to
 * `partial`, so it must not be recorded a second time on a gating channel.
 *
 * MEASURED (P2.169, 2026-08-25). Without a mapping, `pluginKindToResolved`
 * collapses `unsupported-runtime` to `asset`, so a plugin's deferred command
 * reached the user's component list as an `asset` named `"command"` — the literal
 * kind word — while its `nessyExtensions` twin arrived as a SECOND `asset` row
 * carrying the real name. Three declarations produced five rows.
 *
 * **Why this is a RULE and no longer a three-entry table (P2.182, measured
 * 2026-08-26).** The table named `mcp`, `command` and `asset`, and the whole rest
 * of the branch stayed generic — the same "one kind handled, the rest generic"
 * shape that produced the P2.169 defect in the first place. Probed through
 * projection → resolver → `toUserCatalog` over all 32 `externalKind` spellings
 * this tree emits, 29 of them arrived as an `asset` named after the refusal
 * reason. For one of those the label was not cosmetic: `buildHeadlessInitView`'s
 * PRODUCER 2 keys on `componentKind === 'mcp'`, so
 * `catalog-authenticated-mcp` — an MCP server refused because its auth binding
 * is ambiguous — reached `mcp_server_errors` NOT AT ALL, on the one surface
 * (headless) that has no UI to notice.
 *
 * The rule: an `externalKind` names a component when it IS a candidate-kind name
 * or begins with `<kind>-`, the tail being the refusal's own detail
 * (`hook-event-Setup`, `hook-type-agent-on-Stop`, `output-style-force`,
 * `monitor-skill-trigger`, `command-dynamic-substitution-bash`, `app-connector`).
 * `catalog-authenticated-mcp` is the ONE alias, because it names its kind last.
 *
 * It is still not a catch-all, and that boundary is what the unmapped column of
 * the table test pins: `bin`, `dependency-auto-install`, `theme`, `user-config`,
 * `channel`, `settings`, `settings-agent`, `custom-hooks-path`,
 * `ignored-default-agents-folder` and `inline-mcp-config` name no component kind
 * and stay unlabelled. Note `settings` in that list — the plural is not the
 * `setting` kind, and the `<kind>-` form is what keeps it out.
 */
const UNSUPPORTED_EXTERNAL_COMPONENT_KIND_NAMES: readonly Exclude<
  PluginProjectionCandidateKind, 'unsupported-runtime'
>[] = [
  'skill', 'mcp', 'hook', 'app', 'agent', 'prompt-command', 'workflow',
  'setting', 'command', 'asset', 'lsp', 'monitor', 'output-style',
];

/**
 * `externalKind` spellings that name a component kind without leading with it.
 *
 * Exactly one today, and it is the one with the headless consequence. A second
 * entry needs the same evidence this one has: a producer that creates an
 * `unsupported` CAPABILITY (`management-service-v2.ts`'s
 * `applyCatalogAuthentication`), not merely a `compatibility.deferred` record.
 */
const UNSUPPORTED_EXTERNAL_COMPONENT_KIND_ALIASES: Readonly<
  Record<string, Exclude<PluginProjectionCandidateKind, 'unsupported-runtime'>>
> = {
  'catalog-authenticated-mcp': 'mcp',
};

/**
 * The component kind an `unsupported.externalKind` names, or `undefined`.
 *
 * The LONGEST match wins. No kind name is another's `<name>-` prefix today, so
 * no input can match twice — the rule is what keeps that true if a kind named
 * `hook-x` is ever added, instead of letting array order decide silently.
 */
function unsupportedComponentKind(
  externalKind: string,
): Exclude<PluginProjectionCandidateKind, 'unsupported-runtime'> | undefined {
  const alias = UNSUPPORTED_EXTERNAL_COMPONENT_KIND_ALIASES[externalKind];
  if (alias) return alias;
  let matched: Exclude<PluginProjectionCandidateKind, 'unsupported-runtime'> | undefined;
  for (const name of UNSUPPORTED_EXTERNAL_COMPONENT_KIND_NAMES) {
    if (externalKind !== name && !externalKind.startsWith(`${name}-`)) continue;
    if (!matched || name.length > matched.length) matched = name;
  }
  return matched;
}

/**
 * The author's own name inside a deferred surface's `sourcePath`.
 *
 * `deferUnavailablePluginSurfaces` writes `${externalKind}.${logicalName}`, and
 * `schema.ts` round-trips that string verbatim, so the declared name survives the
 * rewrite to `unsupported` even though the descriptor does not. Anything else —
 * a `bin` row whose path is just `bin`, or a persisted capability with no
 * `sourcePath` at all — yields `undefined`, and the caller keeps its previous
 * kind-word fallback rather than inventing a name.
 */
function deferredDeclarationName(externalKind: string, sourcePath: string | undefined): string | undefined {
  const prefix = `${externalKind}.`;
  if (!sourcePath || !sourcePath.startsWith(prefix)) return undefined;
  const name = sourcePath.slice(prefix.length);
  return name.length > 0 ? name : undefined;
}

function scopeToken(scope: CapabilityScopeRef): string {
  return `${scope.kind}:${scope.workspaceId ?? ''}:${scope.projectKey ?? ''}`;
}

/** A bundle-relative path is safe only if it is relative and never traverses up. */
function isContainedRelative(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.split(/[\\/]/).includes('..');
}

function bundleResource(
  pluginInstanceId: PluginInstanceId,
  relativePath: string,
  contentHash: string,
): PluginBundleResourceRef | undefined {
  if (!isContainedRelative(relativePath)) return undefined;
  return { pluginInstanceId, relativePath, contentHash };
}

/**
 * Build the projection candidates for the given installed instances at a scope.
 * Duplicates are intentionally preserved; nothing is copied to disk.
 */
export function resolvePluginProjectionCandidates(
  entries: PluginInstalledEntryV2[],
  selectedScope: CapabilityScopeRef,
  options: {
    /**
     * C4: serve PERSISTED pre-C3 remote connector servers as auth-carrying
     * mcp candidates. Defaults to NESSY_FEATURE_PLUGIN_MCP_CAPABILITY_PATH.
     */
    projectLegacyConnectorServers?: boolean;
  } = {},
): PluginProjectionCandidate[] {
  const projectLegacyConnectorServers = options.projectLegacyConnectorServers
    ?? isPluginMcpCapabilityPathEnabled();
  const candidates: PluginProjectionCandidate[] = [];

  for (const entry of entries) {
    // Plugin-LEVEL options, declared once for the bundle and shared by every
    // capability it projects — the same list `resolvePluginUserConfiguration`
    // reads when the host resolves the values themselves.
    const userConfiguration = entry.manifest.nessyExtensions?.userConfiguration ?? [];
    const push = (
      kind: PluginProjectionCandidateKind,
      capabilityId: string,
      logicalName: string,
      resource?: PluginBundleResourceRef,
      trust: PluginCapabilityTrustRequirement = NO_TRUST,
      runtimeDefinition?: PluginCapability,
      componentKind?: Exclude<PluginProjectionCandidateKind, 'unsupported-runtime'>,
    ) => {
      candidates.push({
        key: `${entry.pluginInstanceId}#${capabilityId}@${scopeToken(selectedScope)}`,
        pluginKey: entry.pluginKey,
        pluginInstanceId: entry.pluginInstanceId,
        capabilityId,
        kind,
        ...(componentKind ? { componentKind } : {}),
        logicalName,
        ...(runtimeDefinition?.displayName ? { displayName: runtimeDefinition.displayName } : {}),
        ...(runtimeDefinition?.description ? { description: runtimeDefinition.description } : {}),
        selectedScope,
        ...(resource ? { resource } : {}),
        trust,
        ...(runtimeDefinition ? { runtimeDefinition } : {}),
        ...(userConfiguration.length > 0 ? { userConfiguration } : {}),
      });
    };

    // Retain Nessy extension declarations for catalog/provenance, but keep
    // them unavailable until settings, commands, and generic assets have
    // complete product consumers. This also fails closed for old registries.
    const ext = entry.manifest.nessyExtensions;
    const extSettingKeys = new Set((ext?.settings ?? []).map(setting => setting.key));
    const extCommands = new Set((ext?.commands ?? []).map(command => command.command));
    const extAssetPaths = new Set((ext?.assets ?? []).map(asset => asset.path));
    const consumedSettings = new Set<string>();
    const consumedCommands = new Set<string>();
    const consumedAssets = new Set<string>();

    for (const capability of entry.manifest.capabilities) {
      const trust = effectivePluginTrust(entry.bundleHash, capability);
      switch (capability.kind) {
        case 'skill':
          push('skill', capability.id, capability.skill.slug, bundleResource(entry.pluginInstanceId, capability.skill.path, entry.bundleHash), trust, capability);
          break;
        case 'mcp':
          push('mcp', capability.id, capability.mcp.serverName, undefined, trust, capability);
          break;
        case 'hook':
          push(
            'hook',
            capability.id,
            capability.hook.id,
            trust.executablePath
              ? bundleResource(entry.pluginInstanceId, trust.executablePath, entry.bundleHash)
              : undefined,
            trust,
            capability,
          );
          break;
        case 'agent':
          push(
            'agent',
            capability.id,
            capability.agent.name,
            bundleResource(entry.pluginInstanceId, capability.agent.path, entry.bundleHash),
            trust,
            capability,
          );
          break;
        case 'lsp':
          push('lsp', capability.id, capability.lsp.id, undefined, trust, capability);
          break;
        case 'monitor':
          push(
            'monitor',
            capability.id,
            capability.monitor.id,
            // A command monitor has no bundle file: its runtime input is the
            // command string pinned in `runtimeDefinition`, not a resource read.
            isCommandMonitorDescriptor(capability.monitor)
              ? undefined
              : bundleResource(entry.pluginInstanceId, capability.monitor.path, entry.bundleHash),
            trust,
            capability,
          );
          break;
        case 'prompt-command':
          push('prompt-command', capability.id, capability.promptCommand.name, bundleResource(entry.pluginInstanceId, capability.promptCommand.path, entry.bundleHash), trust, capability);
          break;
        case 'workflow':
          push('workflow', capability.id, capability.workflow.name, bundleResource(entry.pluginInstanceId, capability.workflow.path, entry.bundleHash), trust, capability);
          break;
        case 'output-style': {
          // The SELECTABLE id is composed HERE, from the installed plugin key,
          // because that key is only authoritative once the store has assigned it
          // — a manifest-time copy could disagree with it and strand the
          // selection. `null` means the key or the name cannot produce an id, so
          // the style is retained as an unavailable catalog row instead of being
          // offered in a picker that could never resolve it.
          const styleId = pluginOutputStyleId(entry.pluginKey, capability.outputStyle.name);
          if (styleId === null) {
            push('unsupported-runtime', capability.id, capability.outputStyle.name, undefined, NO_TRUST, capability);
            break;
          }
          push(
            'output-style',
            capability.id,
            styleId,
            bundleResource(entry.pluginInstanceId, capability.outputStyle.path, entry.bundleHash),
            trust,
            capability,
          );
          break;
        }
        case 'unsupported': {
          // Retained as an UNAVAILABLE catalog entry — never a generic asset.
          //
          // This is where an installed bundle's `command`/`asset` actually
          // arrives (see the file header), so the row has to name the kind the
          // author declared and the name they gave it.
          const externalKind = capability.unsupported.externalKind;
          const componentKind = unsupportedComponentKind(externalKind);
          const declaredName = componentKind
            ? deferredDeclarationName(externalKind, capability.unsupported.sourcePath)
            : undefined;
          // The rewritten capability and the `nessyExtensions` declaration below
          // are ONE declaration: the adapter derives that section from these very
          // capabilities. Mark it consumed so one surface yields one row — the
          // marking in `case 'command'`/`case 'asset'` can no longer do it,
          // because those branches no longer see an installed bundle.
          if (declaredName && externalKind === 'command') consumedCommands.add(declaredName);
          if (declaredName && externalKind === 'asset') consumedAssets.add(declaredName);
          // An MCP refusal's row name is the SERVER name, because that is what a
          // headless `mcp_server_errors` entry has to be greppable by. It is
          // recovered from `sourcePath` when the producer wrote one (the catalog
          // auth path does), and otherwise falls back to the same
          // displayName/id pair the `mcp` refusal has always used. Every other
          // family keeps the kind-word fallback: a `hook-event-*` deferral
          // carries no name to recover, and inventing one from the capability id
          // would rename rows this branch already prints.
          push(
            'unsupported-runtime',
            capability.id,
            declaredName
              ?? (componentKind === 'mcp' ? capability.displayName ?? capability.id : externalKind),
            undefined,
            NO_TRUST,
            capability,
            componentKind,
          );
          break;
        }
        case 'setting':
          if (extSettingKeys.has(capability.setting.key)) {
            consumedSettings.add(capability.setting.key);
            push('setting', capability.id, capability.setting.key, undefined, trust, capability);
          } else {
            push('unsupported-runtime', capability.id, capability.setting.key);
          }
          break;
        case 'command':
          if (extCommands.has(capability.command.command)) {
            consumedCommands.add(capability.command.command);
          }
          // Extension commands have no invocation/listing consumer yet — and no
          // installed bundle reaches this branch, because the adapter chain
          // already rewrote the kind (file header). Kept for a hand-built
          // manifest, which still deserves a row that says "command".
          push('unsupported-runtime', capability.id, capability.command.command, undefined, NO_TRUST, undefined, 'command');
          break;
        case 'asset':
          if (extAssetPaths.has(capability.asset.path)) {
            consumedAssets.add(capability.asset.path);
          }
          push('unsupported-runtime', capability.id, capability.asset.path, undefined, NO_TRUST, undefined, 'asset');
          break;
        default:
          // Retain a capability Pi cannot run for catalog/provenance.
          push('unsupported-runtime', (capability as { id: string }).id, String((capability as { kind: string }).kind));
      }
    }

    // C4 (capability-path, behind NESSY_FEATURE_PLUGIN_MCP_CAPABILITY_PATH):
    // a PERSISTED pre-C3 manifest's twin-less remote connector servers project
    // as auth-carrying mcp candidates — the same shape the C3 normalization
    // funnel mints for new installs — reading the migrated GLOBAL plugin
    // slots. The Source projection then receives nothing (its gate reads the
    // same flag). The persisted manifest itself is NEVER rewritten: flag off
    // restores the Source projection byte-identically, and an ordinary
    // repair/update converts the manifest for real through the funnel.
    if (projectLegacyConnectorServers) {
      const idSegment = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '-');
      const usedIds = new Set(entry.manifest.capabilities.map(capability => capability.id));
      const twinnedServerNames = new Set(entry.manifest.capabilities.flatMap(capability => (
        capability.kind === 'mcp' ? [capability.mcp.serverName] : []
      )));
      for (const connector of entry.manifest.connectors ?? []) {
        const authType = connector.auth?.type ?? 'none';
        for (const server of connector.mcpServers) {
          if (server.transport === 'stdio' || !server.url) continue;
          if (twinnedServerNames.has(server.serverName)) continue;
          twinnedServerNames.add(server.serverName);
          let id = `mcp.${idSegment(connector.id)}.${idSegment(server.serverName)}`;
          for (let suffix = 2; usedIds.has(id); suffix += 1) {
            id = `mcp.${idSegment(connector.id)}.${idSegment(server.serverName)}.${suffix}`;
          }
          usedIds.add(id);
          const capability: PluginCapability = {
            kind: 'mcp',
            id,
            ...(connector.displayName ? { displayName: connector.displayName } : {}),
            ...(connector.description ? { description: connector.description } : {}),
            mcp: {
              serverName: server.serverName,
              transport: server.transport,
              url: server.url,
              ...(authType !== 'none' ? { authType } : {}),
              ...(server.oauthResource ? { oauthResource: server.oauthResource } : {}),
              ...(server.clientId ? { clientId: server.clientId } : {}),
              ...(server.toolTimeoutMs !== undefined ? { toolTimeoutMs: server.toolTimeoutMs } : {}),
            },
          };
          push('mcp', id, server.serverName, undefined, effectivePluginTrust(entry.bundleHash, capability), capability);
        }
      }
    }

    // K1: an app projects with its declarative descriptor and the resolved
    // connector it routes to. Apps route ONLY to their connector's declared MCP
    // servers — the connector is looked up by `connectorId`; a missing connector
    // yields an app candidate with no MCP backing (never a fabricated one).
    const connectorsById = new Map<string, PluginConnectorDescriptor>(
      (entry.manifest.connectors ?? []).map(connector => [connector.id, connector]),
    );
    for (const app of entry.manifest.apps ?? []) {
      const connector = connectorsById.get(app.connectorId);
      candidates.push({
        key: `${entry.pluginInstanceId}#${app.id}@${scopeToken(selectedScope)}`,
        pluginKey: entry.pluginKey,
        pluginInstanceId: entry.pluginInstanceId,
        capabilityId: app.id,
        kind: 'app',
        logicalName: app.id,
        ...(app.displayName ? { displayName: app.displayName } : {}),
        ...(connector?.description ? { description: connector.description } : {}),
        selectedScope,
        // The app is declarative routing only. Its connector Source owns the
        // one network trust decision (`connector:<id>:<server>`).
        trust: NO_TRUST,
        app,
        ...(connector ? { connector } : {}),
      });
    }

    // nessyExtensions declarations without a matching capability entry still
    // project (pure-namespaced declarations); matched ones were pushed above.
    for (const setting of ext?.settings ?? []) {
      if (!consumedSettings.has(setting.key)) {
        push('setting', setting.key, setting.key, undefined, NO_TRUST, {
          kind: 'setting', id: setting.key, setting,
        });
      }
    }
    for (const command of ext?.commands ?? []) {
      if (!consumedCommands.has(command.command)) {
        push('unsupported-runtime', command.command, command.command, undefined, NO_TRUST, undefined, 'command');
      }
    }
    for (const asset of ext?.assets ?? []) {
      if (!consumedAssets.has(asset.path)) {
        push('unsupported-runtime', asset.path, asset.path, undefined, NO_TRUST, undefined, 'asset');
      }
    }
  }

  return candidates;
}
