/**
 * Agent-driven plugin management tools (A8).
 *
 * Implements the host-callback boundary for `plugin_plan_install`,
 * `plugin_install`, `plugin_status`, and `plugin_manage`: the 4 tools are
 * registered as thin dispatchers in `@nessy-agent/session-tools-core`
 * (`ctx.pluginManagement`); the real logic — invoking MarketplaceService and
 * PluginManagementService — lives here so session-tools-core never depends
 * on `@nessy-agent/shared`.
 *
 * Hard rules (A8 brief):
 * - Never run shell commands, never expose credentials, never accept a raw
 *   managed path — only opaque `MarketplaceProposalRegistry` proposal IDs
 *   cross from `plugin_plan_install` to `plugin_install`.
 * - `plugin_install` activates the supported subset of a partial-compatibility
 *   package immediately; deprecated `allowPartial` input is a compatibility
 *   no-op.
 * - A completed install records consent for supported plugin runtime
 *   capabilities. Activation remains scope/per-capability controlled, and
 *   missing authentication or required configuration still fails closed.
 * - Every committed mutation calls the caller-supplied `afterMutation` hook,
 *   including a fail-closed revoke whose later cleanup reports an error (bound
 *   by SessionManager to `refreshPluginRuntime` + the renderer push).
 */

import type { ToolResult } from '@nessy-agent/session-tools-core';
import { errorResponse, successResponse } from '@nessy-agent/session-tools-core';
import type { PluginManagementToolsInterface } from '@nessy-agent/session-tools-core';
import {
  MarketplaceProposalRegistry,
  MarketplaceProposalError,
  attachMarketplaceListingMetadata,
  createPluginInstallSourceFromMarketplaceItem,
  normalizeRepositoryDisplaySource,
  resolveInstalledUpdateOptions,
  resolveMarketplaceListingItem,
  splitListingId,
  type CachedMarketplaceCatalogReader,
  type MarketplaceListKind,
  type MarketplaceService,
} from '../marketplace/index.ts';
import {
  isPluginMutationCommittedError,
  summarizePluginInstallSetup,
  type PluginActivationTarget,
  type PluginManagementApi,
  type PluginKey,
} from '../plugins/index.ts';
import type { ProjectKey } from '../projects/project-identity.ts';
import type { CapabilityInvalidationEffect } from '../capabilities/invalidation.ts';

export type PluginManagementToolScopeKind = 'global' | 'workspace' | 'project';

/** Server-owned scope identity for the calling session — never client-supplied. */
export interface PluginManagementSessionScope {
  workspaceId: string;
  projectKey?: ProjectKey;
}

/** Narrowed to the two read-only marketplace operations these tools need (matches the RPC-layer `MarketplaceHandlerService` pattern). */
export type PluginManagementMarketplaceApi = Pick<MarketplaceService, 'proposeInstall' | 'inspect' | 'install'>;

export interface PluginManagementToolsDeps {
  /** Verified-v2 plugin mutation boundary (install/enable/disable/repair/update/uninstall/status). */
  pluginManagement: PluginManagementApi;
  /** Marketplace list/inspect/propose-install façade. */
  marketplaceService: PluginManagementMarketplaceApi;
  /**
   * Cached-only catalog read, for the one question `marketplaceService` cannot
   * answer: which version an `update` should actually fetch (R88b).
   *
   * Narrower than the registry controller on purpose — the agent-facing tools
   * must not be able to mutate a registry, kick a clone onto the turn, or spend
   * a failed registry's retry budget through this. Omitted (tests, or a host
   * that never wired one) means "no catalog", which makes `update` refuse
   * honestly rather than silently re-install the installed version.
   */
  marketplaceCatalogReader?: CachedMarketplaceCatalogReader;
  /** Server-only opaque proposal registry — the ONLY channel between plan and install. */
  proposalRegistry: MarketplaceProposalRegistry;
  /** Stable per-session client identity the proposal registry binds proposals to. */
  clientId: string;
  /** Resolve the caller's own server-owned scope (never trust client input for identity). */
  resolveScope: () => PluginManagementSessionScope;
  /** Called after every committed mutation, including a revoke with failed cleanup; `pluginKey` names its subject (F1.582). */
  afterMutation: (
    reason: string,
    target?: PluginActivationTarget,
    effect?: CapabilityInvalidationEffect, pluginKey?: string, // F1.582 — the plugin acted on; absent for `prune` (no single subject). The reason stays the bare action: the host derives effect and scope from it
  ) => void | Promise<void>;
}

function activationTargetFor(
  scopeKind: PluginManagementToolScopeKind | undefined,
  scope: PluginManagementSessionScope,
): PluginActivationTarget {
  const kind = scopeKind ?? 'global';
  if (kind === 'global') return { kind: 'global' };
  if (kind === 'workspace') return { kind: 'workspace', workspaceId: scope.workspaceId };
  if (!scope.projectKey) {
    throw new Error('plugin-management-tools: project scope requested but the current session has no bound project');
  }
  return { kind: 'project', workspaceId: scope.workspaceId, projectKey: scope.projectKey };
}

/** Build the per-session `ctx.pluginManagement` implementation. */
export function createPluginManagementTools(
  deps: PluginManagementToolsDeps,
): PluginManagementToolsInterface {
  return {
    planInstall: (args) => planInstall(deps, args as Record<string, unknown>),
    install: (args) => install(deps, args as Record<string, unknown>),
    status: (args) => status(deps, args as Record<string, unknown>),
    manage: (args) => manage(deps, args as Record<string, unknown>),
  };
}

async function planInstall(deps: PluginManagementToolsDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const marketplaceItemId = typeof args.marketplaceItemId === 'string' ? args.marketplaceItemId : undefined;
  const repositoryUrl = typeof args.repositoryUrl === 'string' ? args.repositoryUrl : undefined;
  const listingKind: MarketplaceListKind = args.listingKind === 'skills' ? 'skills' : 'plugins';

  if (marketplaceItemId && repositoryUrl) {
    return errorResponse('Pass exactly one of marketplaceItemId or repositoryUrl, not both.');
  }
  if (!marketplaceItemId && !repositoryUrl) {
    return errorResponse('Pass either marketplaceItemId (internal marketplace item) or repositoryUrl (repository to inspect).');
  }

  try {
    if (repositoryUrl) {
      const raw = deps.marketplaceService.proposeInstall({
        url: repositoryUrl,
        ...(typeof args.ref === 'string' ? { ref: args.ref } : {}),
        ...(typeof args.subdirectory === 'string' ? { subdirectory: args.subdirectory } : {}),
      });
      const displaySource = normalizeRepositoryDisplaySource(raw.sourceUrl, raw.repositoryUrl);
      const diagnosticCodes = raw.diagnostics.map(diagnostic => diagnostic.code);
      if (raw.status !== 'installable' || !raw.source) {
        return successResponse(JSON.stringify({
          status: 'unsupported',
          displaySource,
          diagnosticCodes,
        }));
      }
      const proposal = deps.proposalRegistry.issue({
        clientId: deps.clientId,
        source: raw.source,
        displaySource,
        detectedFormat: raw.detectedFormat,
        diagnosticCodes,
      });
      return successResponse(JSON.stringify(proposal));
    }

    // A `<registryId>:<name>` id belongs to a bring-your-own registry, whose
    // catalog is local — asking the Skills Market client for one 404s. Same
    // resolver the UI channel uses.
    let item;
    try {
      item = await resolveMarketplaceListingItem(
        { itemId: marketplaceItemId!, kind: listingKind },
        {
          inspect: request => deps.marketplaceService.inspect(request),
          ...(deps.marketplaceCatalogReader ? { catalogReader: deps.marketplaceCatalogReader } : {}),
        },
      );
    } catch (error) {
      // A registry-shaped id that no local catalog holds falls through to the
      // Skills Market, whose failure says nothing useful about the id SHAPE —
      // which is the half a caller usually got wrong. Name both halves.
      if (!splitListingId(marketplaceItemId!)) throw error;
      item = undefined;
    }
    if (!item) {
      return errorResponse(
        `plugin_plan_install failed: no listing "${marketplaceItemId}" in any configured marketplace. `
        + 'A bring-your-own registry listing id has the shape <registryId>:<pluginName>.',
      );
    }
    // A REGISTRY row carries the parser's typed source on
    // `structuredInstallSource` and no DTO `install.source` at all — so
    // deriving from the descriptor answers `unsupported_source` for every
    // bring-your-own listing. `MarketplaceService.resolveInstallSource` has
    // always preferred the typed source; the agent path did not, which made
    // D2's resolution reach a row it then could not install. Measured live
    // 2026-08-14 against a local-folder registry.
    const displaySource = item.name;
    if (item.structuredInstallSource) {
      const proposal = deps.proposalRegistry.issue({
        clientId: deps.clientId,
        source: attachMarketplaceListingMetadata(item.structuredInstallSource, item),
        displaySource,
        detectedFormat: 'unknown',
        diagnosticCodes: [],
        ...(item.connectorAuthTiming ? { connectorAuthTiming: item.connectorAuthTiming } : {}),
        ...(item.catalogAuthenticationPolicy
          ? { catalogAuthenticationPolicy: item.catalogAuthenticationPolicy }
          : {}),
      });
      return successResponse(JSON.stringify(proposal));
    }
    const result = createPluginInstallSourceFromMarketplaceItem(item);
    if (!result.ok || !result.source) {
      return successResponse(JSON.stringify({
        status: 'unsupported',
        displaySource,
        diagnosticCodes: result.diagnostics.map(diagnostic => diagnostic.code),
      }));
    }
    const proposal = deps.proposalRegistry.issue({
      clientId: deps.clientId,
      source: result.source,
      displaySource,
      detectedFormat: 'unknown',
      diagnosticCodes: result.diagnostics.map(diagnostic => diagnostic.code),
      // The proposal is the only channel to the install, so the catalog hints
      // the UI path reads off the item have to travel with it.
      ...(item.connectorAuthTiming ? { connectorAuthTiming: item.connectorAuthTiming } : {}),
      ...(item.catalogAuthenticationPolicy
        ? { catalogAuthenticationPolicy: item.catalogAuthenticationPolicy }
        : {}),
    });
    return successResponse(JSON.stringify(proposal));
  } catch (error) {
    return errorResponse(`plugin_plan_install failed: ${message(error)}`);
  }
}

async function install(deps: PluginManagementToolsDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const proposalId = typeof args.proposalId === 'string' ? args.proposalId : undefined;
  if (!proposalId) return errorResponse('proposalId is required (from plugin_plan_install). Raw paths/URLs/commands are never accepted.');

  const scope = deps.resolveScope();
  let target: PluginActivationTarget;
  try {
    target = activationTargetFor(args.scope as PluginManagementToolScopeKind | undefined, scope);
  } catch (error) {
    return errorResponse(message(error));
  }

  let consumed;
  try {
    consumed = deps.proposalRegistry.consume(deps.clientId, proposalId);
  } catch (error) {
    if (error instanceof MarketplaceProposalError) {
      return errorResponse(`plugin_install failed: proposal ${error.code}.`);
    }
    return errorResponse(`plugin_install failed: ${message(error)}`);
  }

  try {
    // Through `MarketplaceService.install`, NOT the mutation boundary beneath
    // it: entering below this is what left a plugin with declared dependencies
    // installed-but-inert, and dropped the catalog's auth hints. The request
    // takes a bare `source`, so the proposal-consume contract is unchanged.
    const result = await deps.marketplaceService.install({
      source: consumed.source,
      activateIn: target,
      ...(consumed.connectorAuthTiming ? { connectorAuthTiming: consumed.connectorAuthTiming } : {}),
      ...(consumed.catalogAuthenticationPolicy
        ? { catalogAuthenticationPolicy: consumed.catalogAuthenticationPolicy }
        : {}),
    });
    if (!result.ok) {
      return errorResponse(`plugin_install failed: ${result.diagnostics.map(d => d.message).join('; ') || 'install rejected'}`);
    }

    const refresh = await refreshAfterCommit(deps, 'plugin_install', target, undefined, result.installed?.pluginKey); // F1.211 — the install LANDED; F1.582 — naming it
    // T2 (plugin-install plan, owner 2026-07-31): the agent-driven install
    // path gets the same truth as the RPC result. `setup` is derived from the
    // SAME `authRequirements`/`configuration` the RPC carries and is phrased
    // for the model to relay: what is ready, what one dp sign-in unblocks
    // (with the count), which servers will ask to connect at first use, which
    // need userConfig. Without it the model reports "installed" and the user
    // hits the same dead servers with no checklist.
    const setup = summarizePluginInstallSetup({
      ...(result.installed?.authRequirements ? { authRequirements: result.installed.authRequirements } : {}),
      ...(result.installed?.configuration ? { configuration: result.installed.configuration } : {}),
    });
    return successResponse(JSON.stringify({
      ok: true,
      pluginKey: result.installed?.pluginKey,
      compatibility: result.compatibility,
      diagnosticCodes: result.diagnostics.map(d => d.code),
      setup,
      ...(result.installed?.authRequirements?.length
        ? { authRequirements: result.installed.authRequirements }
        : {}),
      ...refresh,
    }));
  } catch (error) {
    if (isPluginMutationCommittedError(error)) {
      try {
        await deps.afterMutation('plugin_install', target, error.effect, error.pluginKey); // F1.582
      } catch (invalidationError) {
        return errorResponse(
          `plugin_install failed: ${message(error)}; runtime invalidation failed: ${message(invalidationError)}${refreshSessionsSuffix(invalidationError)}`,
        );
      }
    }
    return errorResponse(`plugin_install failed: ${message(error)}`);
  }
}

async function status(deps: PluginManagementToolsDeps, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const result = await deps.pluginManagement.status();
    const pluginKey = typeof args.pluginKey === 'string' ? args.pluginKey : undefined;
    const installed = pluginKey
      ? result.installed.filter(entry => entry.pluginKey === pluginKey)
      : result.installed;
    return successResponse(JSON.stringify({
      installed: installed.map(entry => ({
        pluginKey: entry.pluginKey,
        name: entry.name,
        version: entry.version,
        capabilityKinds: entry.capabilityKinds,
        installedAt: entry.installedAt,
        compatibility: entry.compatibility,
        diagnosticCodes: entry.diagnostics.map(d => d.code),
      })),
      diagnosticCodes: result.diagnostics.map(d => d.code),
    }));
  } catch (error) {
    return errorResponse(`plugin_status failed: ${message(error)}`);
  }
}

async function manage(deps: PluginManagementToolsDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const pluginKey = typeof args.pluginKey === 'string' ? args.pluginKey as PluginKey : undefined;
  const action = args.action;
  if (
    action !== 'enable' && action !== 'disable' && action !== 'update'
    && action !== 'repair' && action !== 'uninstall' && action !== 'prune'
  ) {
    return errorResponse(`Unknown action: ${String(action)}`);
  }
  if (action === 'prune') {
    // `plugins/cli-reference.md#plugin-prune`: "Remove auto-installed plugin
    // dependencies that are no longer required by any installed plugin …
    // plugins you installed directly are never touched." The page's confirmation
    // prompt is a TTY affordance; a tool call is already an explicit request, so
    // `dryRun` is the preview and the call itself is the confirmation.
    const dryRun = args.dryRun === true;
    const outcome = await deps.pluginManagement.pruneDependencies({ dryRun });
    const refresh = !dryRun && outcome.removed.length > 0
      ? await refreshAfterCommit(deps, 'plugin_manage:prune', undefined, 'remove')
      : undefined;
    return successResponse(JSON.stringify({ ok: true, action, ...outcome, ...refresh }));
  }

  // P6.557 — `prune` is the one action with no subject
  // (`plugins/cli-reference.md#plugin-prune` takes only `--scope`, `--dry-run` and
  // `--yes`), and it has already returned above. Every other action still
  // requires the key, so this check moved DOWN rather than being loosened.
  if (!pluginKey) return errorResponse('pluginKey is required.');

  const scope = deps.resolveScope();
  let mutationTarget: PluginActivationTarget | undefined;

  try {
    if (action === 'enable' || action === 'disable') {
      let target: PluginActivationTarget;
      try {
        target = activationTargetFor(args.scope as PluginManagementToolScopeKind | undefined, scope);
      } catch (error) {
        return errorResponse(message(error));
      }
      mutationTarget = target;
      // Installation is the consent boundary. enable()/disable() only flip an
      // activation record; missing auth/config still gate dependent capabilities.
      const summary = await deps.pluginManagement[action](pluginKey, target);
      const refresh = await refreshAfterCommit(deps, `plugin_manage:${action}`, target, undefined, summary.pluginKey ?? pluginKey); // F1.582
      // P6.628 — `plugin-dependencies.md` § *Enable or disable a plugin with
      // dependencies*: "The success message lists what else was enabled along
      // with the plugin you named." The set is the service's
      // (`enableUnlocked`), reported on the summary since P6.628; absent means
      // nothing else moved, and `disable` never carries it.
      return successResponse(JSON.stringify({
        ok: true,
        pluginKey: summary.pluginKey,
        action,
        ...(summary.enabledDependencies?.length
          ? { enabledDependencies: summary.enabledDependencies }
          : {}),
        ...refresh,
      }));
    }

    if (action === 'uninstall') {
      // P6.437 — `plugins/components.md#path-variables-and-persistent-data`: "The CLI
      // deletes by default; pass `--keep-data` to preserve it." The default is
      // the page's, so an ABSENT `keepData` deletes exactly as before; only an
      // explicit `true` retains, and the retained root is named by absolute path
      // because the page's stated reason for the flag is finding the data again
      // ("when reinstalling after testing a new version").
      const keepData = args.keepData === true;
      const outcome = await deps.pluginManagement.uninstall(pluginKey, { keepData });
      const refresh = await refreshAfterCommit(deps, 'plugin_manage:uninstall', undefined, undefined, pluginKey); // F1.582
      return successResponse(JSON.stringify({
        ok: true,
        pluginKey,
        action,
        ...(outcome.keptDataPath ? { keptDataPath: outcome.keptDataPath } : {}),
        ...refresh,
      }));
    }

    // R88b — `repair` re-materializes the PINNED origin and takes no source;
    // `update` must resolve the catalog source first, or refuse. Calling
    // `update(pluginKey)` with nothing IS `repair`, so the agent reported a
    // successful update while re-installing the version already on disk — the
    // same lie R88 closed on the user-clicked RPC path, decided here by the
    // same shared resolver so the two cannot drift.
    const result = action === 'update'
      ? await deps.pluginManagement.update(
        pluginKey,
        await resolveInstalledUpdateOptions(deps.marketplaceCatalogReader, deps.pluginManagement, pluginKey),
      )
      : await deps.pluginManagement.repair(pluginKey);
    if (!result.ok) {
      return errorResponse(`plugin_manage:${action} failed: ${result.diagnostics.map(d => d.message).join('; ') || 'rejected'}`);
    }
    const refresh = await refreshAfterCommit(
      deps,
      `plugin_manage:${action}`,
      undefined,
      result.compatibility?.state === 'partial' ? 'remove' : 'add-or-refresh',
      result.installed?.pluginKey ?? pluginKey, // F1.582
    );
    return successResponse(JSON.stringify({
      ok: true,
      pluginKey: result.installed?.pluginKey ?? pluginKey,
      action,
      compatibility: result.compatibility,
      requiresConfirmation: result.requiresConfirmation === true,
      diagnosticCodes: result.diagnostics.map(d => d.code),
      ...refresh,
    }));
  } catch (error) {
    if (isPluginMutationCommittedError(error)) {
      try {
        await deps.afterMutation(
          `plugin_manage:${error.action}`,
          error.action === 'disable' ? mutationTarget : undefined,
          error.effect,
          error.pluginKey, // F1.582
        );
      } catch (invalidationError) {
        return errorResponse(
          `plugin_manage:${action} failed: ${message(error)}; runtime invalidation failed: ${message(invalidationError)}${refreshSessionsSuffix(invalidationError)}`,
        );
      }
    }
    return errorResponse(`plugin_manage:${action} failed: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/** F1.211 — what a SUCCESS answer adds when the runtime refresh after it failed. */
interface RuntimeRefreshFailure {
  runtimeRefresh: 'failed';
  runtimeRefreshError: string;
  /**
   * F1.265 — what EVERY affected session's refresh did, when the host says (`SessionManager.refreshPluginRuntime`'s
   * summary, carried on the error): the sessions that applied or reloaded ARE live, the `failedSessionIds` are not.
   */
  runtimeRefreshSessions?: {
    applied: number;
    reloaded: number;
    deferred: number;
    untouched: number;
    failed: number;
    failedSessionIds: string[];
    /** F1.407 — other workspaces' sessions the same global refresh touched, as bare counts (never their ids). */
    otherWorkspaceSessions?: number;
    otherWorkspaceFailed?: number;
  };
  runtimeRefreshNote: string;
}

/** F1.265 — the host's refresh summary, read structurally off the error (this package cannot import the host). */
function refreshSessionsOf(error: unknown): RuntimeRefreshFailure['runtimeRefreshSessions'] {
  const summary = (error as { summary?: unknown } | null)?.summary as {
    applied?: number; reloaded?: number; deferred?: number; untouched?: number; failed?: number;
    failures?: Array<{ sessionId?: string }>; otherWorkspaces?: { sessions?: number; failed?: number };
  } | undefined;
  if (!summary || typeof summary.failed !== 'number') return undefined;
  return {
    applied: summary.applied ?? 0,
    reloaded: summary.reloaded ?? 0,
    deferred: summary.deferred ?? 0,
    untouched: summary.untouched ?? 0,
    failed: summary.failed,
    failedSessionIds: (summary.failures ?? []).map(failure => String(failure.sessionId)),
    ...(summary.otherWorkspaces
      ? { otherWorkspaceSessions: summary.otherWorkspaces.sessions ?? 0, otherWorkspaceFailed: summary.otherWorkspaces.failed ?? 0 }
      : {}),
  };
}

/**
 * F1.211 (origin WJ-n P-WJ-n-1) — refresh the live runtimes after a COMMITTED
 * mutation, and never let the refresh's failure rewrite the mutation's answer.
 *
 * `afterMutation` is bound by `SessionManager` to `afterAgentPluginMutation`,
 * which awaits `refreshPluginRuntime`; that tears every idle affected session's
 * runtime down with a STRICT dispose, and a strict dispose that fails rejects
 * with `<provider>-session-disposal-failed` (measured live on packaged 1.40.0:
 * a codex session in the workspace, `codex-runtime-session-disposal-failed`).
 * Awaited inside the mutation's own `try`, that rejection used to reach the
 * catch that reports a FAILED install, so the model was told
 * `plugin_install failed: codex-runtime-session-disposal-failed` for a plugin
 * `installed.json` already carried.
 *
 * The mutation is on disk by the time this runs, so the answer stays a success
 * and carries the refresh's failure beside it, in words the model can relay:
 * the change is saved, a session that was already running may not see it until
 * its runtime restarts. That is the same fact the UI channel states by leaving
 * `runtimeRefresh` off its result (`afterPluginMutation` fails soft into "cannot
 * say", which the install summary reads as needs-refresh). A refresh that
 * succeeds adds nothing, so every such answer is byte-identical to before.
 *
 * Only the success paths route through here. A mutation that itself threw after
 * committing (`PluginMutationCommittedError`) keeps its own branch, which
 * already reports both failures.
 */
async function refreshAfterCommit(
  deps: PluginManagementToolsDeps,
  reason: string,
  target?: PluginActivationTarget,
  effect?: CapabilityInvalidationEffect,
  pluginKey?: string,
): Promise<RuntimeRefreshFailure | undefined> {
  try {
    await deps.afterMutation(reason, target, effect, pluginKey); // F1.582 — the subject rides beside the reason
    return undefined;
  } catch (error) {
    const sessions = refreshSessionsOf(error);
    return {
      runtimeRefresh: 'failed',
      runtimeRefreshError: message(error),
      ...(sessions ? { runtimeRefreshSessions: sessions } : {}),
      runtimeRefreshNote: 'The change itself is saved. Refreshing the sessions that were already running failed, '
        + 'so a session that was open during the change may not see it until its runtime restarts.',
    };
  }
}

/**
 * F1.410 (origin: the WJ-ff verifier on F1.265) — the two `PluginMutationCommittedError` catches call
 * `deps.afterMutation` themselves, outside {@link refreshAfterCommit}, so they read the host's refresh summary through
 * the SAME reader ({@link refreshSessionsOf}) and append it to their `runtime invalidation failed` line as the
 * `runtimeRefreshSessions` a clean commit's answer carries. An invalidation error with no summary adds nothing, so
 * that answer stays byte-identical to before.
 */
function refreshSessionsSuffix(invalidationError: unknown): string {
  const sessions = refreshSessionsOf(invalidationError);
  return sessions ? ` ${JSON.stringify({ runtimeRefreshSessions: sessions })}` : '';
}
