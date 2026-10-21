/**
 * Runtime MCP/API pool server materialization (shared authority).
 *
 * The single place that turns a resolved `CapabilityTurnRuntime` (an
 * `AgentRuntimeView` + its snapshot materializer) into the concrete
 * `{ mcpServers, apiServers }` maps `McpClientPool.sync` consumes. Both the
 * per-session agent (`BaseAgent.setSourceServers`) AND the workspace-level
 * browse pool (`WorkspaceMcpPoolRegistry`) call this ONE function, so the wire
 * name → server-config mapping — and therefore all upstream gating baked into
 * the runtime view (enable/disable, trust, credentials, session selection) —
 * stays identical across both callers. There is NO second materialization path.
 *
 * Pure over its inputs with ONE named exception, and it is named here rather
 * than discovered later: the built-in dp fold consults the process-scoped
 * managed MCP policy (`applyManagedMcpPolicy`, P2.368). Everything else reads
 * only `runtime.view` + `runtime.materializer`, and nothing here mutates
 * agent/session state.
 */

import type { FolderSourceConfig, LoadedSource } from '../sources/types.ts';
import type {
  ResolvedRuntimeCredential,
  RuntimeCredentialBinding,
  StoredCredential,
} from '../credentials/types.ts';
import {
  getSourceServerBuilder,
  type SourceWithCredential,
} from '../sources/server-builder.ts';
import type { ApiCredential } from '../sources/credential-manager.ts';
import { parseMcpServersDocument } from './project-config.ts';
import {
  BUILTIN_DP_MCP_SERVERS,
  builtinDpMcpServerIdentity,
  materializeBuiltinDpMcpServers,
  mergeBuiltinDpMcpServers,
  type MaterializeBuiltinDpMcpOptions,
} from './builtin-dp-servers.ts';
import {
  isManagedMcpServerAllowed, type ManagedPiPolicyV1,
  resolveManagedPiPolicyFloor,
  resolveManagedPolicyExpansionEnvironment,
} from '../agent/pi-harness/managed-policy.ts';
import { modelTargetWithholdsMcpServers, partitionMcpServersForModelTarget, recordExternalModelMcpWithholding } from '../agent/backend/internal/drivers/external-model-mcp-whitelist.ts';
import type { ModelTargetVerdict } from '../agent/backend/internal/drivers/upstream-target.ts';
// D1.425 — republished from the classifier unchanged, so the ONE agent-side caller of `materializeRuntimePoolServers` freshens the verdict for its live model in one import.
export { modelTargetForModel, noteModelTargetVerdictEgress } from '../agent/backend/internal/drivers/upstream-target.ts';
import { createLogger } from '../utils/debug.ts';
import {
  expandConfigVariables,
  materializeMcpDescriptorEnvironment,
  type McpDescriptorEnvironment,
} from './server-config-values.ts';
import { parseGuideMarkdown } from '../sources/storage.ts';
import { pluginRuntimeEnvForProfile } from '../plugins/data-paths.ts';
import {
  hasMaterializedPluginPackageRunner,
  parsePluginPackageRunnerArgs,
  pluginNpxRuntimeRoot,
  qualifyPluginStdioCommand,
  type PluginPackageRunnerArgs,
} from '../plugins/stdio-command.ts';
import { ensureFreshPluginMcpToken } from '../plugins/mcp-token-refresh.ts';
import { CapabilityMaterializationError, type CapabilitySnapshotMaterializer } from '../capabilities/materializer.ts';
import type { RuntimeMcpServer } from '../capabilities/resolver.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type {
  CapabilityTurnRuntime,
  PluginHostExecutableBinding,
  PluginNodeRuntimeBinding,
  SdkMcpServerConfig,
} from '../agent/backend/types.ts';

export interface MaterializedPoolServers {
  /** Loaded source records (for SourceManager tracking on the agent path). */
  sources: LoadedSource[];
  /** wireName → MCP server config (native `.mcp.json` + source-transport MCP). */
  mcpServers: Record<string, SdkMcpServerConfig>;
  /** slug → in-process API server config. */
  apiServers: Record<string, unknown>;
}

export interface RuntimeExternalAuthRequirement {
  /**
   * 'dp' is the host-brokered login; 'oauth'/'bearer' (C3, capability-path)
   * are plugin http/sse servers whose GLOBAL plugin credential slot is empty —
   * one uniform "what needs auth" feed for the checklist and the
   * session-start notice (ADR § 4).
   */
  provider: 'dp' | 'oauth' | 'bearer';
  wireNames: string[];
  pluginInstanceIds: string[];
  state: 'ready' | 'needs-login' | 'unavailable';
  /** Per-server plugin-slot targets; present on 'oauth'/'bearer' entries only. */
  servers?: { wireName: string; pluginKey: string; serverName: string }[];
  /**
   * The subset of `wireNames` that came from the BUILT-IN dp set (no plugin
   * binding). Builtins gate on `needs-login` only, so non-ready-but-not-
   * needs-login consumers (session resync, the pending-auth row) must treat
   * these names as CONNECTED, not blocked. Absent = every name is plugin-bound.
   */
  builtinWireNames?: readonly string[];
}

export interface MaterializedRuntimePoolServers extends MaterializedPoolServers {
  mergedMcpServers: Record<string, SdkMcpServerConfig>;
  externalAuthRequirements: RuntimeExternalAuthRequirement[];
}

export interface MaterializePoolServersOptions {
  workspaceRootPath: string;
  workspaceId: string;
  /**
   * Host-validated project root (`BaseAgent.runtimeSkillProjectDirectory()` —
   * the SAME reader the skill path uses; `skills.md:331` calls it "the same
   * path hooks and MCP servers receive"). Drives two things and neither is the
   * `${VAR}` expansion environment: (1) stdio spawn envs gain
   * `NESSY_PROJECT_DIR`/`CLAUDE_PROJECT_DIR` (`whats-new/2026-w20.md:87`,
   * `mcp.md:110`); (2) a non-plugin `headersHelper` runs from this directory.
   * Absent (e.g. the browse pool with only a workspace id), both are withheld
   * rather than fabricated.
   */
  projectDirectory?: string;
  pluginNodeRuntime?: PluginNodeRuntimeBinding;
  /** Value-only result of a non-interactive DP broker probe. */
  dpSessionState?: RuntimeExternalAuthRequirement['state'];
  debug?: (message: string) => void;
  /**
   * A7 — the built-in dp-backed MCP set (`mcp/builtin-dp-servers.ts`).
   *
   * Folded in HERE because this is the one place a wire name becomes a server
   * the pool will connect (see this file's header). Both production callers —
   * `BaseAgent.setSourceServers` and `WorkspaceMcpPoolRegistry` — go through it,
   * so the set reaches a session agent and the browse pool from a single fold
   * and cannot drift between them.
   *
   * **The fold runs by default, and produces nothing until the user opts in.**
   * Owner decision 2026-08-01: the whole set is embedded and EVERY server
   * defaults to disabled, so a default-running fold yields an empty map. That is
   * deliberately different from the earlier default-ON, which folded six servers
   * in before any preference existed to stop them.
   *
   * It also made the branch red in a way CI could not see: the fold injected six
   * names into `mergedMcpServers` and thirteen exact-map assertions across four
   * files failed on any machine that has `dp` — while a CI runner, which has
   * none, went green on the same commit.
   *
   * So: `undefined` FOLDS, reading the stored per-server preferences — and hands
   * back nothing, because every definition defaults to disabled. `false`
   * withholds the whole set outright, which is what the tests that need a bare
   * map pass. A record supplies the switch directly (and `resolveDpPath`, the
   * test seam that keeps this host-independent).
   *
   * The safety here is `defaultEnabled: false` on every entry, NOT the fold being
   * withheld. Turn any definition on by default and this option starts servers
   * nobody asked for again — that is the mutation `builtin-dp-servers.test.ts`
   * pins, and it goes red on a dp-less CI runner too, not only on a dp host.
   */
  builtinDpMcpServers?: false | MaterializeBuiltinDpMcpOptions;
  /**
   * DA2.2 half A — where this session's tool schemas are going: classified at
   * backend construction, freshened by the caller (D1.425 `modelTargetForModel`).
   *
   * Present only on the per-session agent path. The workspace BROWSE pool
   * passes nothing, which withholds nothing — see
   * {@link applyExternalModelMcpWhitelist} for why that asymmetry is the point
   * rather than an omission.
   */
  modelTarget?: ModelTargetVerdict;
  /**
   * E5a (send path) — the caller's own store of the api servers it last handed
   * the pool, so an UNCHANGED api source keeps its live client across turns.
   *
   * Absent, every materialization mints a fresh instance for every api source
   * and the behaviour is byte-identical to before this option existed. The
   * browse pool deliberately passes nothing: it retains at its own layer
   * (`WorkspaceMcpPoolRegistry.retainUnchangedBrowseApiServers`).
   */
  apiServerRetention?: RuntimeApiServerRetention;
}

/**
 * E5a — "When you reload, Claude Code keeps the live connections of plugin
 * servers whose configuration is unchanged" (`plugins-reference.md`).
 *
 * `McpClientPool` already honours that for MCP servers: `mcpConnectionKey` is a
 * sha256 over the server config, so an unchanged one keeps the same identity
 * across syncs and its client is left alone. An api source has no serializable
 * config — it reaches the pool as a live in-process `McpServer`, so
 * `apiConnectionKey` keys on the INSTANCE through a WeakMap. The send path
 * re-materializes on every turn and minted a fresh instance for every api
 * source, so the pool tore down and rebuilt every one of them even when nothing
 * had moved (measured: a resync with three equivalent api sources reconnected
 * 3 of 3, while the same three INSTANCES reconnected 0 of 3 — the pool's diff
 * was already right and the identity was what churned).
 *
 * The pool's keying is deliberately untouched. What is stabilized is what it
 * keys on: this store digests the loaded source record plus the VALUE-ONLY
 * credential binding (`{id, expectedRevision}`, never the secret) and hands
 * back the instance the pool is already holding when the digest matches, so a
 * rotated or expired credential bumps the revision, changes the digest and DOES
 * reconnect.
 *
 * **A retained instance outlives the materialization that built it**, which is
 * why this store also owns the materializer its credential providers resolve
 * through ({@link bindMaterializer}). Retaining an instance whose closures
 * captured the building turn's materializer would pin a released lease — E2's
 * mechanism — and every api tool call on the next turn would fail
 * `capability-snapshot-revoked`. Re-pointing keeps the provider on the live
 * turn, which is exactly where an unretained instance's provider already was.
 *
 * One store per session agent: the retained instance belongs to that agent's
 * pool leaser, and its lifetime is the agent's.
 */
export class RuntimeApiServerRetention {
  private entries = new Map<string, { digest: string; server: unknown }>();
  private materializer: CapabilitySnapshotMaterializer | undefined;

  /**
   * Point every retained server's credential provider at the CURRENT turn's
   * materializer. Called once per materialization, before the servers build.
   */
  bindMaterializer(materializer: CapabilitySnapshotMaterializer): void {
    this.materializer = materializer;
  }

  /** The materializer a retained server's credential provider resolves through. */
  currentMaterializer(): CapabilitySnapshotMaterializer | undefined {
    return this.materializer;
  }

  /**
   * Swap each freshly built api server for the one already connected when the
   * source has not moved. Returns the map to hand `pool.sync`.
   */
  retainUnchanged(
    apiServers: Record<string, unknown>,
    sources: readonly LoadedSource[],
    credentials: ReadonlyMap<string, RuntimeCredentialBinding | undefined>,
  ): Record<string, unknown> {
    const loaded = new Map(sources.map(source => [source.config.slug, source]));
    const retained: Record<string, unknown> = {};
    const next = new Map<string, { digest: string; server: unknown }>();
    for (const [slug, server] of Object.entries(apiServers)) {
      const digest = apiSourceDigest(loaded.get(slug), credentials.get(slug));
      if (digest === undefined) {
        // Nothing to compare against: fall back to today's behaviour rather
        // than retain an instance we cannot prove is still current.
        retained[slug] = server;
        continue;
      }
      const cached = this.entries.get(slug);
      const reused = cached?.digest === digest ? cached.server : server;
      retained[slug] = reused;
      next.set(slug, { digest, server: reused });
    }
    this.entries = next;
    return retained;
  }

  /** Drop every retained instance and the bound materializer (agent teardown). */
  clear(): void {
    this.entries.clear();
    this.materializer = undefined;
  }
}

/**
 * Content key for an api source: everything that decides what the in-process
 * server DOES, plus the value-only credential binding. Never the secret — a
 * rotation is visible as a revision change, which is what the pinned view
 * carries.
 */
function apiSourceDigest(
  source: LoadedSource | undefined,
  credential: RuntimeCredentialBinding | undefined,
): string | undefined {
  if (!source) return undefined;
  try {
    return createHash('sha256').update(JSON.stringify(stableJson({
      config: source.config,
      guide: source.guide,
      folderPath: source.folderPath,
      workspaceRootPath: source.workspaceRootPath,
      workspaceId: source.workspaceId,
      credential: credential ?? null,
    }))).digest('hex');
  } catch {
    return undefined;
  }
}

/** Key-order-independent JSON projection, mirroring `mcp-pool.ts`'s own. */
function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableJson(child)]),
  );
}

/**
 * Materialize the full desired server set (source-derived + pinned-snapshot MCP
 * + the built-in dp set) for a capability runtime, merged and keyed by wire
 * name — ready for `pool.sync`.
 */
export async function materializeRuntimePoolServers(
  runtime: CapabilityTurnRuntime,
  options: MaterializePoolServersOptions,
): Promise<MaterializedRuntimePoolServers> {
  const debug = options.debug ?? (() => {});
  const snapshot = await materializeSnapshotMcpServers(
    runtime,
    options.pluginNodeRuntime,
    options.dpSessionState ?? 'unavailable',
    debug,
    options.projectDirectory,
  );
  const runtimeSources = await materializeRuntimeSources(runtime, options);
  const configuredMcpServers = mergePinnedMcpServers(runtimeSources.mcpServers, snapshot.mcpServers);
  const dpSessionState = options.dpSessionState ?? 'unavailable';
  const folded = foldBuiltinDpMcpServers(configuredMcpServers, options.builtinDpMcpServers, debug);
  const orgFold = foldManagedOrgMcpServers(folded.servers, folded.builtinWireNames, debug); let mergedMcpServers = orgFold.servers; // F1.593 — the organisation's servers, see the function; F1.635 — it also returns which builtin names survive it
  const externalAuthRequirements = [...snapshot.externalAuthRequirements];
  if (orgFold.builtinWireNames.length > 0) {
    // Withheld ONLY on a positive needs-login verdict (owner decision
    // 2026-08-06): the non-Pi session preflight hardcodes 'unavailable' and a
    // transient probe failure reports it — neither may evict working servers.
    // Plugin dp servers keep their stricter !== 'ready' gate: they materialize
    // credentials, builtins carry none.
    if (dpSessionState === 'needs-login') {
      const blocked = new Set(orgFold.builtinWireNames);
      mergedMcpServers = Object.fromEntries(
        Object.entries(mergedMcpServers).filter(([wireName]) => !blocked.has(wireName)),
      );
      recordPoolPolicyReceipt(debug, `runtime-external-auth-required:dp-builtin:${orgFold.builtinWireNames.length}`);
    }
    // The requirement is emitted in EVERY state (matching the plugin path), so
    // the registry probes the broker, discovers needs-login, and the
    // one-login-unblocks-N row + post-login resync cover builtins for free.
    const dpIndex = externalAuthRequirements.findIndex(requirement => requirement.provider === 'dp');
    if (dpIndex >= 0) {
      const existing = externalAuthRequirements[dpIndex]!;
      externalAuthRequirements[dpIndex] = {
        ...existing,
        wireNames: [...new Set([...existing.wireNames, ...orgFold.builtinWireNames])].sort(),
        builtinWireNames: [...new Set([...(existing.builtinWireNames ?? []), ...orgFold.builtinWireNames])].sort(),
      };
    } else {
      externalAuthRequirements.push({
        provider: 'dp',
        wireNames: [...orgFold.builtinWireNames].sort(),
        pluginInstanceIds: [],
        state: dpSessionState,
        builtinWireNames: [...orgFold.builtinWireNames].sort(),
      });
    }
  }
  // DA2.2 half A — the LAST subtraction, for the reason the built-in fold is
  // where the managed lists are applied: by this point every server the pool
  // will connect is present under its final wire name, and nothing downstream
  // adds one.
  const withheld = applyExternalModelMcpWhitelist(
    {
      mcpServers: runtimeSources.mcpServers,
      apiServers: runtimeSources.apiServers,
      mergedMcpServers,
    },
    options.modelTarget,
    debug,
  );
  return {
    sources: runtimeSources.sources,
    mcpServers: withheld.mcpServers,
    apiServers: withheld.apiServers,
    mergedMcpServers: withheld.mergedMcpServers,
    externalAuthRequirements,
  };
}

/**
 * DA2.2 half A — withhold non-whitelisted MCP servers from an external model
 * target (owner decision DA2.14, 2026-09-17: namespace-only, no BYO exemption).
 *
 * The policy and its seed are in
 * `agent/backend/internal/drivers/external-model-mcp-whitelist.ts`; this
 * function is only the moment it is applied. That moment is HERE, beside
 * {@link applyManagedMcpPolicy}, for the same reason stated in that function's
 * note: this file is the single place a wire name becomes a server the pool will
 * connect, so a gate here cannot lapse the day a third caller appears.
 *
 * **It applies on ALL connection kinds**, which is the whole of DA2.14: a BYO
 * endpoint at a vendor loses the same servers the corporate proxy channel does,
 * because at HEAD those are the same connections (`upstream-target.ts`'s DA2.1
 * reading 2).
 *
 * **The BROWSE pool is unaffected and that is deliberate.** It passes no
 * `modelTarget` — browse is provider-neutral and has no model — so it keeps
 * LISTING every server, exactly as it keeps listing a managed-denylisted one.
 * A catalog that silently lost rows when a model was selected would reproduce
 * what `managed-mcp.md#how-restrictions-appear-to-users` records as the outcome
 * an administrator's users complain about, with no surface left to explain it;
 * the explanation here is DA2.6's disclosure.
 *
 * Three residues, named rather than discovered:
 *
 * 1. `mcp__session__*` is not pool-served, so no filter here can reach it
 *    (ODR-1/DA2.4, and DA2.2's own row says so).
 * 2. `externalAuthRequirements` is deliberately NOT filtered. It answers "does
 *    this workspace still need a login", which stays true of a server this
 *    model happens not to get, and the browse pool computes the same list
 *    without a verdict — filtering one and not the other is how the two would
 *    come to disagree about whether a login is still owed.
 * 3. `sources` (the `LoadedSource` records) is not filtered either: it is the
 *    SourceManager's inventory, and `updateActiveState` is driven by the two
 *    maps this function does filter, so the active set already tells the truth.
 *
 * Withheld names go to `recordExternalModelMcpWithholding` and nothing throws,
 * matching both managed gates: a policy outcome is not a turn failure.
 */
function applyExternalModelMcpWhitelist(
  maps: {
    mcpServers: Record<string, SdkMcpServerConfig>;
    apiServers: Record<string, unknown>;
    mergedMcpServers: Record<string, SdkMcpServerConfig>;
  },
  modelTarget: ModelTargetVerdict | undefined,
  debug: (message: string) => void,
): typeof maps {
  if (!modelTargetWithholdsMcpServers(modelTarget)) return maps;
  const { withheld } = partitionMcpServersForModelTarget(
    // Both maps, because both reach `pool.sync` and both become `mcp__*` tools
    // the model can call. A filter over the MCP half alone would leave every
    // api-transport source in place and read as if the policy had been applied.
    [...Object.keys(maps.mergedMcpServers), ...Object.keys(maps.apiServers)],
    modelTarget,
  );
  if (withheld.length === 0) return maps;
  const blocked = new Set(withheld);
  const keep = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(
    Object.entries(record).filter(([wireName]) => !blocked.has(wireName)),
  );
  recordExternalModelMcpWithholding(modelTarget, withheld, debug);
  return {
    mcpServers: keep(maps.mcpServers),
    apiServers: keep(maps.apiServers),
    mergedMcpServers: keep(maps.mergedMcpServers),
  };
}

/**
 * Fold the built-in dp set over the user's/plugins' own servers.
 *
 * Order is the contract, not an implementation detail: the configured map is
 * the LEFT argument, so `mergeBuiltinDpMcpServers` treats every configured wire
 * name (and every configured `dp ai mcp <sub>`) as already taken and stands the
 * built-in down. Swapping the arguments would make an unasked-for built-in
 * shadow a server the user configured by hand, which is the exact outcome that
 * merge exists to prevent.
 *
 * Diagnostics go to `debug` and never throw: this set is not something the user
 * asked for, so nothing it discovers may fail a turn.
 *
 * The managed MCP lists are applied BEFORE the merge, not after
 * ({@link applyManagedMcpPolicy}). Order matters: a denied built-in must never
 * reach `mergeBuiltinDpMcpServers`, because a name it consumed would be reported
 * as `wire_name_taken` against a server that is not going to run.
 *
 * Returns the SURVIVING builtin wire names alongside the merged map: a name
 * already configured by the user/plugins was stood down by the merge above and
 * must not be gated or reported as needing dp auth — it is not a builtin
 * server anymore, it is whatever the user configured under that name.
 */
function foldBuiltinDpMcpServers(
  configured: Record<string, SdkMcpServerConfig>,
  option: MaterializePoolServersOptions['builtinDpMcpServers'],
  debug: (message: string) => void,
): { servers: Record<string, SdkMcpServerConfig>; builtinWireNames: string[] } {
  if (option === false) return { servers: configured, builtinWireNames: [] };
  const builtin = materializeBuiltinDpMcpServers(option ?? {});
  for (const diagnostic of builtin.diagnostics) debug(`${diagnostic.code}: ${diagnostic.message}`);
  if (!builtin.available) return { servers: configured, builtinWireNames: [] };
  const folded = mergeBuiltinDpMcpServers(configured, applyManagedMcpPolicy(builtin.servers, debug));
  for (const diagnostic of folded.diagnostics) debug(`${diagnostic.code}: ${diagnostic.message}`);
  return {
    servers: folded.servers,
    builtinWireNames: Object.keys(folded.servers).filter(name => !(name in configured)),
  };
}

/**
 * P2.410 — the options both managed-MCP gates in this file are handed, built in
 * one place.
 *
 * `managed-mcp.md#how-policy-entries-expand` splits the two sides of a match
 * across two environments: "The server's configured value expands from the live
 * process environment, like the rest of `.mcp.json`. A policy entry expands
 * from a pinned environment instead, so a variable set by a project or user
 * settings file can't change what an allowlist entry means."
 *
 * Only the POLICY ENTRY side is pinned here. The gate's third parameter — the
 * live environment the SERVER's configured value reads — is left at its default
 * (`process.env`) on purpose at both call sites: pinning it too would be the
 * symmetric-looking fix and is a fail-OPEN one, because a `${VAR}` server URL
 * steered mid-session onto a denied host would then be judged on its startup
 * value and slip the deny.
 *
 * Built once for the same reason `storage-runtime.ts` builds its copy once:
 * these are the only two gates in this file, they run on the same fold, and
 * building the options per call site is how one of them ends up pinned and the
 * other does not — which is precisely the state P2.396 left this file in.
 *
 * An ABSENT pin is spelled as an empty object rather than as
 * `{ policyEnvironment: undefined }`, matching the same choice there: the
 * field is optional-by-omission in the gate, and passing the key with
 * `undefined` reads as "pinned to nothing" to anyone skimming.
 */
function managedMcpGateOptions(): { readonly policyEnvironment?: Readonly<Record<string, string | undefined>> } {
  const pinned = resolveManagedPolicyExpansionEnvironment();
  return pinned === undefined ? {} : { policyEnvironment: pinned };
}

/**
 * P2.368 — the managed MCP lists, applied to the built-in dp set at the one
 * moment `managed-mcp.md#how-a-server-is-evaluated` names.
 *
 * "Before loading a server … A server that matches any denylist entry, by URL,
 * command, or name, is blocked. Nothing overrides a denylist match." This is
 * that moment: the fold is the single place a built-in becomes a server the pool
 * will connect (see this file's header), and both production callers — the
 * session agent and the browse pool — reach it.
 *
 * **The gate is HERE rather than at either caller, deliberately.** An option
 * each caller passes is the shape that lapses the day a third caller appears,
 * and "declared on one path, enforced on another" is the defect the sibling row
 * P2.351 was. The capability mirror in `storage-runtime.ts` filters the same set
 * on the same identity, so the row and the server agree; that mirror is a
 * DISPLAY, and this is the enforcement it displays.
 *
 * The policy comes from {@link resolveManagedPiPolicyFloor}, the process-scoped
 * registered reader `packages/shared` already climbs the `server-core` wall
 * with (`claude-managed-settings.ts` and `capabilities/runtime-automations.ts`
 * are its existing enforcement consumers; both hosts register it at boot —
 * `apps/electron/src/main/index.ts` and `bootstrap/headless-start.ts`).
 * Unregistered means "no managed policy", which is every non-managed install and
 * every test that never registers one: the set then folds exactly as before.
 *
 * Withheld servers are named on `debug` rather than thrown: this set is not
 * something the user asked for, so nothing it discovers may fail a turn.
 */
function applyManagedMcpPolicy(
  servers: Record<string, SdkMcpServerConfig>,
  debug: (message: string) => void,
): Record<string, SdkMcpServerConfig> {
  const policy = resolveManagedPiPolicyFloor();
  if (!policy) return servers;
  const permitted: Record<string, SdkMcpServerConfig> = {};
  const withheld: string[] = [];
  for (const [wireName, server] of Object.entries(servers)) {
    const definition = BUILTIN_DP_MCP_SERVERS.find(entry => entry.name === wireName);
    // A name `materializeBuiltinDpMcpServers` produced always has a definition;
    // without one there is no identity to judge, so it fails CLOSED rather than
    // riding through unjudged.
    // P3.217 — the identity carries BOTH spellings of the argv: the logical
    // `dp ai mcp <sub>` the catalog row shows, and the resolved one this fold
    // has already materialized and is about to spawn. Until it did, a deny
    // written as `/usr/local/bin/dp ai mcp gitlab` — the way `which dp` prints
    // it — matched nothing and the server ran. Read from `server`, so the gate
    // judges the argv it is holding rather than resolving a second one that
    // could disagree.
    const spawnCommand = server.type === 'stdio' && typeof server.command === 'string'
      ? [server.command, ...(server.args ?? [])]
      : undefined;
    // P2.410 — `undefined` for the live environment is the gate's own default
    // (`process.env`), which is the environment this server's configured value
    // is documented to read; only the fourth argument is pinned.
    const allowed = definition !== undefined && isManagedMcpServerAllowed(policy, {
      name: wireName,
      ...builtinDpMcpServerIdentity(definition, spawnCommand),
    }, undefined, managedMcpGateOptions());
    if (allowed) permitted[wireName] = server;
    else withheld.push(wireName);
  }
  if (withheld.length) {
    recordPoolPolicyReceipt(debug, `builtin_dp_mcp.managed_policy_denied: ${withheld.join(', ')}`);
  }
  return permitted;
}

/**
 * P3.229 — the managed MCP lists, applied to a PLUGIN stdio server on the argv
 * it is about to be spawned under.
 *
 * A plugin server is already judged once, upstream, on its DECLARED shape
 * (`server-core/bootstrap/storage-runtime.ts:pluginMcpServerIdentity`). That
 * gate cannot judge the spawn argv and must not try: resolving it there means
 * a `dp` PATH lookup on every capability resolve — and every turn resolves —
 * which is the cost `builtinDpMcpCapabilityRecords` reason (2) already refuses
 * to pay. This is the other half, at the one moment the argv exists, which is
 * where P3.217 put the built-in half for the same reason.
 *
 * It can only ever SUBTRACT from the upstream verdict, and that is a property
 * rather than a hope: it is handed the same declared argv the upstream gate
 * used, plus zero or one additional true spelling of it
 * (`resolvePluginStdioExecutable`'s `identityCommand`), and
 * `matchesManagedMcpEntry` is a disjunction over spellings. So a server this
 * withholds is one an administrator named and the upstream gate could not see;
 * nothing this admits was denied upstream.
 *
 * Only the stdio branch calls it. An http/sse plugin server is not rewritten,
 * so it has exactly one spelling and the upstream gate already judges the
 * whole of it; a second identical check here would be a seam with nothing
 * behind it.
 *
 * Withheld servers are named on `debug` rather than thrown, matching
 * {@link applyManagedMcpPolicy}: an administrator's denial is not a turn
 * failure.
 */
function isPluginMcpServerManagedAllowed(
  logicalName: string,
  /**
   * The DECLARED argv, byte for byte what the upstream gate matched on, so the
   * two layers cannot disagree about what this server calls itself.
   */
  declaredCommand: readonly string[],
  identityCommand: readonly string[] | undefined,
): boolean {
  const policy = resolveManagedPiPolicyFloor();
  if (!policy) return true;
  // P2.410 — see {@link managedMcpGateOptions}. The third argument is left at
  // the gate's default so the SERVER side keeps reading the live environment;
  // pinning both sides fails open.
  return isManagedMcpServerAllowed(policy, {
    name: logicalName,
    transport: 'stdio',
    command: declaredCommand,
    ...(identityCommand ? { alternateCommands: [identityCommand] } : {}),
  }, undefined, managedMcpGateOptions());
}

export function mergePinnedMcpServers(
  sourceServers: Record<string, SdkMcpServerConfig>,
  resolvedServers: Record<string, SdkMcpServerConfig>,
): Record<string, SdkMcpServerConfig> {
  const merged = { ...sourceServers };
  for (const [wireName, server] of Object.entries(resolvedServers)) {
    if (wireName in merged) {
      throw new Error(`capability-mcp-wire-name-collision:${wireName}`);
    }
    merged[wireName] = server;
  }
  return merged;
}

async function materializeRuntimeSources(
  runtime: CapabilityTurnRuntime,
  options: MaterializePoolServersOptions,
): Promise<MaterializedPoolServers> {
  const sources: LoadedSource[] = [];
  const withCredentials: SourceWithCredential[] = [];
  const handles = new Map(runtime.view.sources.map(source => [source.logicalName, source]));

  for (const handle of runtime.view.sources) {
    runtime.materializer.assertActive();
    let config: FolderSourceConfig;
    try {
      const parsed = JSON.parse(await runtime.materializer.readText(handle.resource)) as unknown;
      if (!isRuntimeSourceConfig(parsed)) continue;
      config = parsed;
    } catch (error) {
      if (error instanceof CapabilityMaterializationError) throw error;
      continue;
    }
    const folderPath = await runtime.materializer.resolvePath(handle.resource);
    const guide = handle.guideResource
      ? parseGuideMarkdown(await runtime.materializer.readText(handle.guideResource))
      : null;
    const source: LoadedSource = {
      config,
      guide,
      folderPath,
      workspaceRootPath: options.workspaceRootPath,
      workspaceId: options.workspaceId,
    };
    sources.push(source);
    const resolved = handle.credential
      ? resolveCredentialOnce(runtime.materializer, handle.credential)
      : undefined;
    withCredentials.push({
      source,
      ...(resolved?.value ? { token: resolved.value } : {}),
      ...(resolved?.credential
        ? { credential: runtimeApiCredential(config, resolved.credential) }
        : {}),
    });
  }

  // E5a — these two providers are the ONLY things the in-process api server
  // keeps a closure over, and a RETAINED server keeps the ones it was built
  // with. Resolve through the store's current materializer so a retained
  // instance follows the live turn instead of pinning the released lease of the
  // turn that built it (E2's mechanism). With no store this is
  // `runtime.materializer`, exactly as before.
  const retention = options.apiServerRetention;
  retention?.bindMaterializer(runtime.materializer);
  const activeMaterializer = (): CapabilitySnapshotMaterializer =>
    retention?.currentMaterializer() ?? runtime.materializer;

  const resolveBoundCredential = (source: LoadedSource): StoredCredential | undefined => {
    const handle = handles.get(source.config.slug);
    if (!handle?.credential) return undefined;
    return resolveCredentialOnce(activeMaterializer(), handle.credential).credential;
  };
  const built = await getSourceServerBuilder().buildAll(
    withCredentials,
    source => {
      const handle = handles.get(source.config.slug);
      if (!handle?.credential) return undefined;
      return async () => resolveCredentialOnce(activeMaterializer(), handle.credential!).value ?? '';
    },
    undefined,
    undefined,
    source => {
      const handle = handles.get(source.config.slug);
      if (!handle?.credential) return undefined;
      return async () => {
        const credential = resolveBoundCredential(source);
        return credential ? runtimeApiCredential(source.config, credential) : null;
      };
    },
  );
  const mcpServers: Record<string, SdkMcpServerConfig> = {};
  for (const handle of runtime.view.sources) {
    if (!handle.mcpWireName) continue;
    const server = built.mcpServers[handle.logicalName];
    if (!server) continue;
    if (mcpServers[handle.mcpWireName]) {
      throw new Error(`capability-mcp-wire-name-collision:${handle.mcpWireName}`);
    }
    mcpServers[handle.mcpWireName] = server;
  }
  runtime.materializer.assertActive();
  const apiServers = retention
    ? retention.retainUnchanged(
        built.apiServers,
        sources,
        new Map([...handles].map(([slug, handle]) => [slug, handle.credential])),
      )
    : built.apiServers;
  return { sources, mcpServers, apiServers };
}

async function materializeSnapshotMcpServers(
  runtime: CapabilityTurnRuntime,
  pluginNodeRuntime: PluginNodeRuntimeBinding | undefined,
  dpSessionState: RuntimeExternalAuthRequirement['state'],
  debug: (message: string) => void,
  projectDirectory?: string,
): Promise<{
  mcpServers: Record<string, SdkMcpServerConfig>;
  externalAuthRequirements: RuntimeExternalAuthRequirement[];
}> {
  const result: Record<string, SdkMcpServerConfig> = {};
  // `whats-new/2026-w20.md:87`: stdio MCP servers receive `CLAUDE_PROJECT_DIR`
  // "matching hooks" — a SPAWN-environment value, never the `${VAR}` expansion
  // environment (`mcp.md:115`). Withheld entirely when the host has no project
  // directory, so the literal-plus-warning path is unchanged for those.
  const projectDirEnv: Record<string, string> = projectDirectory
    ? { NESSY_PROJECT_DIR: projectDirectory, CLAUDE_PROJECT_DIR: projectDirectory }
    : {};
  const dpWireNames = new Set<string>();
  const dpPluginInstanceIds = new Set<string>();
  // C3 (capability-path): plugin http/sse servers whose global credential slot
  // is empty — skipped from the pool and surfaced as needs-auth, dp-style.
  const endpointAuthPending = new Map<'oauth' | 'bearer', {
    wireNames: Set<string>;
    pluginInstanceIds: Set<string>;
    servers: { wireName: string; pluginKey: string; serverName: string }[];
  }>();
  for (const server of runtime.view.mcpServers) {
    runtime.materializer.assertActive();
    try {
      if (server.resource && server.sourceName) {
        const document = await runtime.materializer.readText(server.resource);
        let parsed: unknown;
        try {
          parsed = JSON.parse(document) as unknown;
        } catch {
          continue;
        }
        const config = parseMcpServersDocument(
          parsed,
          message => debug(message),
          server.resource.absolutePath.endsWith('.mcp.json') ? '.mcp.json' : 'mcp.json',
          // Seeds the stdio SPAWN env only — `parseProjectMcpServer` keeps the
          // `${VAR}` expansion environment at `process.env` (`mcp.md:115`).
          { ...(projectDirectory ? { projectDirectory } : {}) },
        )[server.sourceName];
        if (config) {
          // `mcp.md:797`: a `.mcp.json` `headersHelper` runs "from the
          // session's current working directory" — the host-validated project
          // directory at this seam. The parser emitted the bare command; only
          // this layer knows where the session lives.
          result[server.wireName] = config.type !== 'stdio' && config.headersHelper && !config.headersHelper.cwd && projectDirectory
            ? { ...config, headersHelper: { ...config.headersHelper, cwd: projectDirectory } }
            : config;
        }
        continue;
      }
      if (server.pluginInstanceId) {
        await runtime.materializer.verifyPlugin(server.pluginInstanceId);
      }
      const pluginEnvironment = server.pluginRuntime
        ? pluginRuntimeEnvForProfile(server.pluginRuntime.profile, {
            bundleRoot: server.pluginRuntime.rootPath,
            dataPath: server.pluginRuntime.dataPath,
            ...(server.pluginRuntime.projectPath ? { projectPath: server.pluginRuntime.projectPath } : {}),
          })
        : {};
      const dpExternalAuthBinding = !!server.pluginInstanceId
        && !!server.pluginRuntime
        && server.definition.type === 'stdio'
        && server.definition.command === 'dp'
        && pluginNodeRuntime?.executables?.dp?.externalAuthProvider === 'dp';
      const credentialEnvironment = dpExternalAuthBinding
        ? { environment: {}, missingNames: [] }
        : materializePluginMcpCredentialEnvironment(server, runtime.materializer);
      if (credentialEnvironment.missingNames.length) {
        debug(`Plugin MCP ${server.wireName} is unavailable; missing credential configuration: ${credentialEnvironment.missingNames.join(', ')}`);
        continue;
      }
      const forwardedEnvironment = dpExternalAuthBinding
        ? {}
        : materializePluginMcpForwardedEnvironment(server);
      const pluginDescriptorEnvironment = server.pluginInstanceId
        ? materializePluginMcpEnvironment(
            server,
            pluginEnvironment,
            forwardedEnvironment,
            credentialEnvironment.environment,
          )
        : undefined;
      if (pluginDescriptorEnvironment?.missingRequiredNames.length) {
        debug(`Plugin MCP ${server.wireName} is unavailable; missing environment: ${pluginDescriptorEnvironment.missingRequiredNames.join(', ')}`);
        continue;
      }
      if (server.definition.type === 'stdio') {
        if (!server.definition.command) continue;
        const descriptorEnvironment = pluginDescriptorEnvironment ?? materializePluginMcpEnvironment(
          server,
          pluginEnvironment,
          forwardedEnvironment,
          credentialEnvironment.environment,
        );
        const environment = {
          ...descriptorEnvironment.environment,
          ...credentialEnvironment.environment,
        };
        warnUnresolvedReferences(
          server,
          [...new Set([
            ...descriptorEnvironment.missingReferenceNames,
            ...unresolvedDefinitionReferences(server, environment),
          ])],
          debug,
        );
        const resolvedCommand = resolveRuntimeString(server.definition.command, environment);
        let args = server.definition.args;
        let commandEnvironment: Record<string, string> = {};
        let hostWritableRoots: readonly string[] = [];
        let externalAuthProvider: 'dp' | undefined;
        let identityCommand: readonly string[] | undefined;
        let command = resolvedCommand;
        if (server.pluginInstanceId) {
          if (!server.pluginRuntime?.bundleHash) {
            debug(`Plugin MCP ${server.wireName} is unavailable; supervised runtime authority is incomplete.`);
            continue;
          }
          const executable = resolvePluginStdioExecutable(
            server.definition.command,
            args ?? [],
            server.pluginRuntime.rootPath,
            pluginNodeRuntime,
            environment,
          );
          if (!executable.ok) {
            debug(`Plugin MCP ${server.wireName} is unavailable; ${executable.reason}`);
            continue;
          }
          command = executable.command;
          args = executable.args;
          commandEnvironment = executable.environment;
          hostWritableRoots = executable.hostWritableRoots;
          externalAuthProvider = executable.externalAuthProvider;
          identityCommand = executable.identityCommand;
        }
        if (server.pluginInstanceId && !isAbsolute(command)) {
          debug(`Plugin MCP ${server.wireName} is unavailable; supervised runtime authority is incomplete.`);
          continue;
        }
        if (server.pluginInstanceId && !isPluginMcpServerManagedAllowed(
          server.logicalName,
          [server.definition.command, ...(server.definition.args ?? [])],
          identityCommand,
        )) {
          recordPoolPolicyReceipt(debug, `plugin_mcp.managed_policy_denied: ${server.wireName}`);
          continue;
        }
        if (externalAuthProvider === 'dp') {
          dpWireNames.add(server.wireName);
          dpPluginInstanceIds.add(server.pluginInstanceId!);
          if (dpSessionState !== 'ready') continue;
        }
        const subprocessEnvironment = {
          // Native (non-plugin) stdio servers receive the project-dir pair at
          // the HEAD of the spawn env, so an entry's own values win. The plugin
          // branch is untouched: `pluginRuntimeEnvForProfile` already supplies
          // both spellings inside `environment`.
          ...(server.pluginInstanceId ? {} : projectDirEnv),
          ...environment,
          ...commandEnvironment,
        };
        result[server.wireName] = {
          type: 'stdio',
          command,
          ...(args ? { args } : {}),
          ...(server.definition.cwd
            ? {
                cwd: server.pluginRuntime
                  ? resolve(server.pluginRuntime.rootPath, resolveRuntimeString(server.definition.cwd, environment))
                  : resolveRuntimeString(server.definition.cwd, environment),
              }
            : server.pluginRuntime ? { cwd: server.pluginRuntime.rootPath } : {}),
          env: {
            ...subprocessEnvironment,
          },
          ...(server.pluginInstanceId ? { inheritProcessEnv: false } : {}),
          ...(server.definition.toolTimeoutMs ? { toolTimeoutMs: server.definition.toolTimeoutMs } : {}),
          ...(server.definition.required !== undefined ? { required: server.definition.required } : {}),
          ...(server.definition.alwaysLoad === true ? { alwaysLoad: true } : {}),
          ...(server.pluginRuntime
            ? {
                pluginRuntime: {
                  bundleRootPath: server.pluginRuntime.rootPath,
                  expectedBundleHash: server.pluginRuntime.bundleHash!,
                  dataPath: server.pluginRuntime.dataPath,
                  ...(server.pluginRuntime.projectPath ? { projectPath: server.pluginRuntime.projectPath } : {}),
                  ...(hostWritableRoots.length
                    ? { hostWritableRoots }
                    : {}),
                },
              }
            : {}),
        };
      } else {
        if (!server.definition.url) continue;
        let credential = server.credential
          ? server.endpointAuth
            ? resolvePluginSlotCredential(runtime.materializer, server.credential)
            : resolveCredentialOnce(runtime.materializer, server.credential).value
          : undefined;
        if (server.endpointAuth) {
          // C4: read-through refresh of the GLOBAL plugin slot at the point of
          // consumption — a token refreshed here is used immediately, so the
          // snapshot binding's revision pinning never serves a stale token. When
          // the slot module cannot help (no initialized store in focused tests),
          // the binding-resolved value above stands.
          credential = (await ensureFreshPluginMcpToken(server.endpointAuth, server.definition.url))
            ?? credential;
        }
        if (server.endpointAuth && !credential) {
          // Declared endpoint auth with an empty/expired plugin slot: never
          // start the server unauthenticated — surface it instead.
          const pending = endpointAuthPending.get(server.endpointAuth.authType)
            ?? { wireNames: new Set<string>(), pluginInstanceIds: new Set<string>(), servers: [] };
          pending.wireNames.add(server.wireName);
          if (server.pluginInstanceId) pending.pluginInstanceIds.add(server.pluginInstanceId);
          pending.servers.push({
            wireName: server.wireName,
            pluginKey: server.endpointAuth.pluginKey,
            serverName: server.endpointAuth.serverName,
          });
          endpointAuthPending.set(server.endpointAuth.authType, pending);
          debug(`Plugin MCP ${server.wireName} awaits ${server.endpointAuth.authType} authentication; its credential slot is empty.`);
          continue;
        }
        // Native/project MCP keeps its existing host interpolation semantics.
        // Imported plugins get only the names explicitly retained in their
        // reviewed descriptor; an undeclared host secret can never reach URL or
        // header interpolation.
        const interpolationEnvironment = pluginDescriptorEnvironment?.environment
          ?? { ...runtimeProcessEnvironment(), ...pluginEnvironment };
        warnUnresolvedReferences(
          server,
          [...new Set([
            ...(pluginDescriptorEnvironment?.missingReferenceNames ?? []),
            ...unresolvedDefinitionReferences(server, interpolationEnvironment),
          ])],
          debug,
        );
        result[server.wireName] = {
          type: server.definition.type,
          url: resolveRuntimeString(server.definition.url, interpolationEnvironment),
          ...((server.descriptorHeaders || credential)
            ? {
                headers: {
                  ...resolveRuntimeStringRecord(server.descriptorHeaders, interpolationEnvironment),
                  ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
                },
              }
            : {}),
          ...(server.descriptorHeadersHelper
            ? {
                headersHelper: {
                  // `mcp.md:327`: PLUGIN path placeholders substitute into
                  // `headersHelper` exactly like `url` and `headers` — resolved
                  // for plugin servers only. A non-plugin command is passed
                  // verbatim: `headersHelper` is not one of the documented
                  // `${VAR}` expansion locations (`mcp.md:459-460`); its own
                  // references belong to the shell it runs in.
                  command: server.pluginRuntime
                    ? resolveRuntimeString(server.descriptorHeadersHelper, interpolationEnvironment)
                    : server.descriptorHeadersHelper,
                  // `mcp.md:816`: a plugin-provided helper runs from the plugin
                  // root (which also sets `CLAUDE_PLUGIN_ROOT`, `mcp.md:813`);
                  // otherwise the host-validated project directory stands in
                  // for the session cwd, and absent both the helper inherits
                  // the host process cwd.
                  ...(server.pluginRuntime
                    ? { cwd: server.pluginRuntime.rootPath, pluginRoot: server.pluginRuntime.rootPath }
                    : projectDirectory ? { cwd: projectDirectory } : {}),
                },
              }
            : {}),
          ...(server.definition.toolTimeoutMs ? { toolTimeoutMs: server.definition.toolTimeoutMs } : {}),
          ...(server.definition.required !== undefined ? { required: server.definition.required } : {}),
          ...(server.definition.alwaysLoad === true ? { alwaysLoad: true } : {}),
        };
      }
    } catch (error) {
      // E1: the unit of degradation is a SERVER, never the batch. One plugin
      // whose credential, bundle or pinned resource cannot materialize used to
      // abort the whole loop, so unrelated, unchanged servers died with it.
      // `revoked` is exempt: a dead lease is a security verdict about the
      // snapshot itself, and nothing pinned to it may be materialized.
      if (!isCapabilityMaterializationError(error) || error.code === 'revoked') throw error;
      debug(`MCP server ${server.wireName} is unavailable; its capability snapshot reports ${error.code}.`);
    }
  }
  const externalAuthRequirements: RuntimeExternalAuthRequirement[] = dpWireNames.size
    ? [{
        provider: 'dp' as const,
        wireNames: [...dpWireNames].sort(),
        pluginInstanceIds: [...dpPluginInstanceIds].sort(),
        state: dpSessionState,
      }]
    : [];
  if (externalAuthRequirements.length && dpSessionState !== 'ready') {
    debug(`runtime-external-auth-required:dp:${dpSessionState}`);
  }
  for (const provider of ['oauth', 'bearer'] as const) {
    const pending = endpointAuthPending.get(provider);
    if (!pending) continue;
    externalAuthRequirements.push({
      provider,
      wireNames: [...pending.wireNames].sort(),
      pluginInstanceIds: [...pending.pluginInstanceIds].sort(),
      state: 'needs-login',
      servers: [...pending.servers].sort((left, right) => left.wireName.localeCompare(right.wireName)),
    });
    debug(`runtime-external-auth-required:${provider}:needs-login`);
  }
  return { mcpServers: result, externalAuthRequirements };
}

/**
 * Read the GLOBAL plugin credential slot behind an endpoint-auth server without
 * letting an EMPTY slot take down the whole materialization.
 *
 * C3 deliberately keeps such a server enabled while its slot is empty so the
 * `endpointAuthPending` branch below can name it in `externalAuthRequirements`
 * — but `resolveCredential` reports "not ready" by THROWING
 * `capability-snapshot-revoked`, so that branch was unreachable and one
 * un-authenticated plugin (an installed-but-not-logged-in Figma) failed every
 * materialization in the workspace: browse resync, the pending-auth summary and,
 * through `preflightDpAuth`, every send until the app restarted.
 *
 * The correctness floor is untouched, and since the two verdicts no longer
 * share a code the softening is exact: ONLY `credential-not-ready` degrades to
 * `undefined`, which is the state the caller already knows how to surface. A
 * `revoked` or `stale` snapshot still throws from here exactly as before, and
 * `assertActive` is called first so a dead lease is refused even by a
 * materializer that reports the two the old way. Servers WITHOUT declared
 * endpoint auth keep the hard failure — starting one of those without its
 * Authorization header would be an unauthenticated request.
 */
function resolvePluginSlotCredential(
  materializer: CapabilitySnapshotMaterializer,
  binding: RuntimeCredentialBinding,
): string | undefined {
  materializer.assertActive();
  try {
    return materializer.resolveCredential(binding).value;
  } catch (error) {
    if (
      !isCapabilityMaterializationError(error)
      || error.code !== 'credential-not-ready'
    ) throw error;
    return undefined;
  }
}

/**
 * `materializer.resolveCredential` with ONE re-resolve at the revision the
 * credential store reports now.
 *
 * > When a request to an OAuth server you already signed in to returns `401
 * > Unauthorized`, Claude Code refreshes the stored token, reconnects, and
 * > retries the request once. (`mcp.md`)
 *
 * What goes stale is the PIN, not the credential: a rotation advances the store
 * past the revision this snapshot captured, and every consumer of that binding
 * then failed hard for the rest of the turn even though a perfectly usable
 * record was sitting there. An expiry that a refresher has already replaced
 * arrives the same way — `secure-storage.ts:resolveRuntimeCredential` reports
 * the revision mismatch BEFORE it looks at `expiresAt`. Look again, once, at
 * the revision the store just named.
 *
 * Nothing is widened. `revoked` and `stale` propagate untouched — E3's code
 * split is what makes this safe to do at all — the lease is re-checked by the
 * second `resolveCredential`, and a record that is absent or genuinely expired
 * AT THE CURRENT revision still throws, because re-reading the same revision
 * returns the same record.
 */
function resolveCredentialOnce(
  materializer: CapabilitySnapshotMaterializer,
  binding: RuntimeCredentialBinding,
): ResolvedRuntimeCredential {
  try {
    return materializer.resolveCredential(binding);
  } catch (error) {
    if (
      !isCapabilityMaterializationError(error)
      || error.code !== 'credential-not-ready'
      || error.currentRevision === undefined
      || error.currentRevision === binding.expectedRevision
    ) throw error;
    return materializer.resolveCredential({ ...binding, expectedRevision: error.currentRevision });
  }
}

/**
 * `instanceof` plus the class's own `name`, mirroring the registry seam
 * (`workspace-mcp-pool-registry.ts`): the shared package is bundled more than
 * once across the electron main bundle and the headless server, and a
 * cross-realm instance would otherwise read as an unrelated error. Both the
 * endpoint-auth softening and the per-server degradation classify through this
 * one predicate so a cross-realm failure cannot take two different paths.
 */
function isCapabilityMaterializationError(
  error: unknown,
): error is CapabilityMaterializationError {
  return error instanceof CapabilityMaterializationError
    || (error instanceof Error && error.name === 'CapabilityMaterializationError');
}

function materializePluginMcpCredentialEnvironment(
  server: RuntimeMcpServer,
  materializer: CapabilitySnapshotMaterializer,
): { environment: Record<string, string>; missingNames: string[] } {
  const entries = Object.entries(server.credentialEnvironment ?? {});
  if (entries.length === 0) return { environment: {}, missingNames: [] };
  const environment: Record<string, string> = {};
  const missingNames: string[] = [];
  for (const [name, descriptor] of entries) {
    const resolved = resolveCredentialOnce(materializer, descriptor.credential);
    if (!resolved.value) {
      missingNames.push(name);
      continue;
    }
    let value: string | undefined;
    try {
      const parsed = JSON.parse(resolved.value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const candidate = (parsed as Record<string, unknown>)[descriptor.configKey];
        if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
          value = String(candidate);
        }
      }
    } catch {
      if (entries.length === 1) value = resolved.value;
    }
    if (value === undefined) missingNames.push(name);
    else environment[name] = value;
  }
  return { environment, missingNames: missingNames.sort() };
}

function materializePluginMcpEnvironment(
  server: RuntimeMcpServer,
  pluginEnvironment: Record<string, string>,
  forwardedEnvironment: Record<string, string>,
  configuredEnvironment: Record<string, string> = {},
): McpDescriptorEnvironment {
  return materializeMcpDescriptorEnvironment(
    {
      ...(server.descriptorEnvironmentDefaults
        ? { environmentDefaults: server.descriptorEnvironmentDefaults }
        : {}),
      ...(server.descriptorEnvironment ? { env: server.descriptorEnvironment } : {}),
      ...(server.definition.requiredEnvironmentNames
        ? { requiredEnvironmentNames: server.definition.requiredEnvironmentNames }
        : {}),
    },
    {
      plugin: pluginEnvironment,
      forwarded: forwardedEnvironment,
      configured: configuredEnvironment,
    },
  );
}

function materializePluginMcpForwardedEnvironment(
  server: RuntimeMcpServer,
): Record<string, string> {
  return Object.fromEntries(
    [
      ...(server.definition.forwardedEnvironmentNames ?? []).map(name => [name, name] as const),
      ...Object.entries(server.definition.forwardedEnvironmentSources ?? {}),
    ]
      .flatMap(([name, sourceName]) => {
        const value = process.env[sourceName];
        // Match capability resolution exactly: an empty/whitespace host value
        // is unavailable and must not overwrite a reviewed descriptor default.
        return value?.trim() ? [[name, value] as const] : [];
      }),
  );
}

/**
 * Resolves a plugin-declared stdio command without searching PATH. Bundle
 * commands stay bundle-contained; host commands must map to an explicit,
 * host-owned runtime binding.
 *
 * ### P3.229 — which rewrites join the server's managed-MCP identity
 *
 * Every branch below replaces the declared command, and until P3.229 no gate
 * saw the replacement: the only managed-MCP check a plugin server passed
 * (`server-core/bootstrap/storage-runtime.ts:pluginMcpServerIdentity`) reads
 * the DECLARED shape and runs upstream of this function. So a deny an
 * administrator wrote from what the process actually runs matched nothing.
 * `managed-mcp.md#how-a-server-is-evaluated` is pre-load and unconditional —
 * "Before loading a server ... A server that matches any denylist entry, by
 * URL, command, or name, is blocked. Nothing overrides a denylist match."
 *
 * The fix is P3.217's, one level over: the identity admits every OTHER TRUE
 * SPELLING of the same argv (`alternateCommands`), and `:175`'s "Commands
 * match exactly. Every argument, in order" still governs each comparison. The
 * precedent for widening an IDENTITY rather than a MATCHER is
 * `permissions.md#cd` — "Deny rules check every spelling of the target,
 * including each symlink hop it resolves through, so a rule written for one
 * path also blocks targets that resolve to it."
 *
 * Not all five rewrites qualify, and adding them all would have been the wrong
 * answer. The test is whether the resolved argv is a spelling an administrator
 * can write down and rely on: does it name a binary somebody other than this
 * app provisioned, at a path that survives an app update?
 *
 * **`bundle` joins.** The declared spelling is `${NESSY_PLUGIN_ROOT}/…`, and
 * `#how-policy-entries-expand` expands a policy entry from the process
 * environment — where `NESSY_PLUGIN_ROOT` never appears, because it is a
 * per-plugin value `pluginRuntimeEnvForProfile` mints here at materialization.
 * So the page's own promise that "an entry written as `["${HOME}/bin/server"]`
 * matches a server config that uses either the same reference or the expanded
 * path" was unreachable from BOTH sides for this branch. Carrying the resolved
 * path restores exactly what the page already specifies rather than widening
 * past it, and the path itself is inside the plugin install root — user data,
 * stable across app updates.
 *
 * **`dp` joins.** Identical in kind to P3.217, which measured the built-in set:
 * `dp` is host-provisioned, `which dp` prints the resolved spelling, and that
 * spelling is the one an administrator naturally writes. It is also the branch
 * that carries the user's corporate session, which is the thing a deny is for.
 *
 * **`node`, `uvx` and `python` do NOT join.** Their resolved argv0 is this
 * app's OWN bundled runtime (`resolvePluginNodeRuntime` →
 * `resolveBundledRuntimeFile`, or `process.execPath`): the same binary for
 * every plugin on the machine, at a path that moves with the next app update.
 * A `serverCommand` rule pinned to it would stop matching on upgrade — a
 * control that silently stops controlling, which is a worse failure than the
 * one being fixed. The declared spelling stays the stable handle: an entry
 * written literally as `["node", "${NESSY_PLUGIN_ROOT}/server.js"]` matches,
 * because `expandConfigVariables` leaves an unresolvable reference literal on
 * both sides.
 *
 * **`npx` and `bunx` do NOT join**, for a second and independent reason: the
 * package-runner branch does not re-SPELL the argv, it re-WRITES it. The
 * package spec — the one token `managed-mcp.md`'s own example configuration
 * denies on (`{ "serverCommand": ["npx", "-y", "@modelcontextprotocol/…"] }`)
 * — is gone, replaced by a resolved path into the bundle. Admitting that as
 * "another spelling of the same command" would widen `:175` rather than
 * honour it.
 *
 * The gate that consumes this is in {@link materializeRuntimePoolServers}'s
 * stdio branch, which is where the argv has just been materialized — the same
 * placement, and the same reason, as the built-in half in
 * {@link applyManagedMcpPolicy}.
 */
export type PluginExecutableResolution =
  | {
      ok: true;
      command: string;
      args: string[];
      environment: Record<string, string>;
      hostWritableRoots: readonly string[];
      externalAuthProvider?: 'dp';
      /**
       * P3.229 — the resolved argv, when it is ANOTHER TRUE SPELLING of the
       * declared one and therefore joins the server's managed-MCP identity
       * (`ManagedMcpServerIdentityV1.alternateCommands`, P3.217). Absent when
       * this resolution rewrote the command into something an administrator
       * cannot durably name; see {@link resolvePluginStdioExecutable} for which
       * of the five rewrites join and why the other three do not.
       */
      identityCommand?: readonly string[];
    }
  | { ok: false; reason: string };

/** The successful pole of {@link PluginExecutableResolution}. */
type ResolvedPluginExecutable = Extract<PluginExecutableResolution, { ok: true }>;

export function resolvePluginStdioExecutable(
  command: string,
  args: string[],
  bundleRoot: string,
  runtime: PluginNodeRuntimeBinding | undefined,
  environment: Record<string, string>,
): PluginExecutableResolution {
  const qualification = qualifyPluginStdioCommand(command, bundleRoot);
  if (!qualification.ok) {
    return {
      ok: false,
      reason: qualification.reason === 'outside-bundle'
        ? 'executable must be contained by the immutable plugin bundle.'
        : `bare executable "${command}" is not host-approved or bundle-contained.`,
    };
  }
  const resolvedArgs = args.map(value => resolveRuntimeString(value, environment));
  if (qualification.kind === 'bundle') {
    return {
      ok: true,
      command: qualification.executablePath,
      args: resolvedArgs,
      environment: {},
      hostWritableRoots: [],
      // Joins the identity: the same file the declared `${NESSY_PLUGIN_ROOT}/…`
      // names, spelled as the path it resolves to. See the type's doc comment.
      identityCommand: [qualification.executablePath, ...resolvedArgs],
    };
  }
  if (qualification.runtime === 'node') {
    if (!isUsablePluginNodeRuntime(runtime)) {
      return { ok: false, reason: 'managed Node runtime is missing. Reinstall or update Nessy Desktop.' };
    }
    return resolvedHostExecutable({
      command: runtime.command,
      environment: runtime.environment,
    }, resolvedArgs, environment);
  }
  if (qualification.runtime === 'dp') {
    const binding = runtime?.executables?.dp;
    if (!isUsableHostExecutable(binding)) {
      return { ok: false, reason: 'host-owned dp executable is missing.' };
    }
    const finalArgs = [...(binding.args ?? []), ...resolvedArgs];
    if (
      binding.externalAuthProvider === 'dp'
      && (finalArgs[0] !== 'ai' || finalArgs[1] !== 'mcp' || !finalArgs[2]?.trim())
    ) {
      return { ok: false, reason: 'host-owned dp executable only supports ai mcp.' };
    }
    const resolved = resolvedHostExecutable(binding, resolvedArgs, environment, binding.externalAuthProvider);
    // Joins the identity: the same host-provisioned `dp` the declared bare word
    // names, spelled the way `which dp` prints it. P3.217 measured this exact
    // asymmetry on the built-in dp set; see the type's doc comment.
    return { ...resolved, identityCommand: [resolved.command, ...resolved.args] };
  }
  if (qualification.runtime === 'npx') {
    const parsed = parsePluginPackageRunnerArgs(resolvedArgs);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: parsed.reason === 'unsupported-arguments'
          ? 'npx invocation uses unsupported runner arguments.'
          : 'npx package spec is invalid.',
      };
    }
    const binding = runtime?.executables?.bunx;
    if (isUsableHostExecutable(binding)) {
      const generatedRoot = pluginNpxRuntimeRoot(bundleRoot);
      const generated = resolveMaterializedPackageExecutable(
        parsed,
        generatedRoot,
        binding,
        environment,
        'npx',
      );
      if (generated.ok) return generated;
      if (existsSync(join(generatedRoot, 'node_modules', ...parsed.packageName.split('/'), 'package.json'))) {
        return generated;
      }
    }
    const bundleBinding = isUsableHostExecutable(binding)
      ? binding
      : isUsablePluginNodeRuntime(runtime)
        ? { command: runtime.command, environment: runtime.environment }
        : undefined;
    if (bundleBinding) {
      const bundled = resolveMaterializedPackageExecutable(
        parsed,
        bundleRoot,
        bundleBinding,
        environment,
        'npx',
      );
      if (bundled.ok) return bundled;
      if (existsSync(join(bundleRoot, 'node_modules', ...parsed.packageName.split('/'), 'package.json'))) {
        return bundled;
      }
    }
    return bundleBinding
      ? { ok: false, reason: 'npx dependency is not materialized in the immutable bundle.' }
      : { ok: false, reason: 'host-owned Bun runtime is missing. Reinstall or update Nessy Desktop.' };
  }
  if (qualification.runtime === 'bunx') {
    const binding = runtime?.executables?.bunx;
    const parsed = parsePluginPackageRunnerArgs(resolvedArgs);
    if (!parsed.ok) {
      return {
        ok: false,
        reason: parsed.reason === 'unsupported-arguments'
          ? 'bunx invocation uses unsupported runner arguments.'
          : 'bunx package spec is invalid.',
      };
    }
    return isUsableHostExecutable(binding)
      ? resolveMaterializedPackageExecutable(parsed, bundleRoot, binding, environment, 'bunx')
      : { ok: false, reason: 'host-owned Bun runtime is missing. Reinstall or update Nessy Desktop.' };
  }
  const binding = runtime?.executables?.[qualification.runtime];
  return isUsableHostExecutable(binding)
    ? resolvedHostExecutable(binding, resolvedArgs, environment)
    : { ok: false, reason: `host-owned ${qualification.runtime} runtime is missing. Reinstall or update Nessy Desktop.` };
}

function resolveMaterializedPackageExecutable(
  parsed: Extract<PluginPackageRunnerArgs, { ok: true }>,
  bundleRoot: string,
  binding: PluginHostExecutableBinding,
  environment: Record<string, string>,
  runner: 'npx' | 'bunx',
): PluginExecutableResolution {
  const { packageName } = parsed;
  const packageRoot = join(bundleRoot, 'node_modules', ...packageName.split('/'));
  const packageJsonPath = join(packageRoot, 'package.json');
  try {
    if (!hasMaterializedPluginPackageRunner(bundleRoot, [parsed.packageSpec])) {
      throw new Error('package version mismatch');
    }
    const canonicalBundleRoot = realpathSync(bundleRoot);
    const canonicalPackageRoot = realpathSync(packageRoot);
    if (!isPathInside(canonicalBundleRoot, canonicalPackageRoot)) throw new Error('package escaped bundle');
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown; bin?: unknown };
    if (manifest.name !== packageName) throw new Error('name mismatch');
    const defaultBin = packageName.split('/').pop()!;
    const bin = typeof manifest.bin === 'string'
      ? manifest.bin
      : manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)
        ? ((manifest.bin as Record<string, unknown>)[defaultBin]
          ?? (Object.keys(manifest.bin).length === 1 ? Object.values(manifest.bin)[0] : undefined))
        : undefined;
    if (typeof bin !== 'string' || isAbsolute(bin) || bin.split(/[\\/]/).includes('..')) throw new Error('invalid bin');
    const executable = realpathSync(join(packageRoot, bin));
    if (!isPathInside(canonicalPackageRoot, executable) || !statSync(executable).isFile()) {
      throw new Error('bin escaped package');
    }
    return {
      ok: true,
      command: binding.command,
      args: [...(binding.args ?? []), executable, ...parsed.packageArgs],
      environment: resolveRuntimeStringRecord(binding.environment, environment),
      hostWritableRoots: (binding.writableRoots ?? []).map(root => resolveRuntimeString(root, environment)),
    };
  } catch {
    return { ok: false, reason: `${runner} dependency is not materialized in the immutable bundle.` };
  }
}

function resolvedHostExecutable(
  binding: PluginHostExecutableBinding,
  args: string[],
  environment: Record<string, string>,
  externalAuthProvider?: 'dp',
): ResolvedPluginExecutable {
  return {
    ok: true,
    command: binding.command,
    args: [...(binding.args ?? []), ...args],
    environment: resolveRuntimeStringRecord(binding.environment, environment),
    hostWritableRoots: (binding.writableRoots ?? []).map(root => resolveRuntimeString(root, environment)),
    ...(externalAuthProvider ? { externalAuthProvider } : {}),
  };
}

function isUsableHostExecutable(
  binding: NonNullable<PluginNodeRuntimeBinding['executables']>[string] | undefined,
): binding is NonNullable<PluginNodeRuntimeBinding['executables']>[string] {
  return !!binding && isAbsolute(binding.command) && existsSync(binding.command);
}

function isPathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function isUsablePluginNodeRuntime(
  runtime: PluginNodeRuntimeBinding | undefined,
): runtime is PluginNodeRuntimeBinding {
  return !!runtime && isAbsolute(runtime.command) && existsSync(runtime.command);
}

function isRuntimeSourceConfig(value: unknown): value is FolderSourceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const config = value as Partial<FolderSourceConfig>;
  return typeof config.id === 'string'
    && typeof config.name === 'string'
    && typeof config.slug === 'string'
    && typeof config.enabled === 'boolean'
    && typeof config.provider === 'string'
    && (config.type === 'mcp' || config.type === 'api' || config.type === 'local');
}

function runtimeApiCredential(
  config: FolderSourceConfig,
  credential: StoredCredential,
): ApiCredential {
  const headerNames = config.api?.headerNames ?? config.mcp?.headerNames;
  if (headerNames?.length) {
    try {
      const parsed = JSON.parse(credential.value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (headerNames.every(name => typeof record[name] === 'string')) {
          return Object.fromEntries(headerNames.map(name => [name, record[name] as string]));
        }
      }
    } catch {}
  }
  if (config.api?.authType === 'basic') {
    try {
      const parsed = JSON.parse(credential.value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const value = parsed as { username?: unknown; password?: unknown };
        if (typeof value.username === 'string' && typeof value.password === 'string') {
          return { username: value.username, password: value.password };
        }
      }
    } catch {}
  }
  return credential.value;
}

function resolveRuntimeStringRecord(
  values: Record<string, string> | undefined,
  environment: Record<string, string> = runtimeProcessEnvironment(),
): Record<string, string> {
  if (!values) return {};
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    resolveRuntimeString(value, environment),
  ]));
}

/**
 * Interpolate a plugin/snapshot MCP descriptor value.
 *
 * Both documented forms are supported (`mcp.md:449-450`), and an unresolvable
 * reference with no default keeps its literal `${VAR}` text, exactly as the
 * `.mcp.json` reader does — "the config still loads … and uses the unexpanded
 * `${VAR}` text as-is" (`mcp.md:477`). Plugin-provided servers get "access to
 * the same environment variables as manually configured servers"
 * (`mcp.md:321`), so the two halves of this feature must agree.
 *
 * The empty-string substitution this used to perform existed only so that
 * `materializePluginMcpEnvironment` could decide availability with
 * `!environment[name]?.trim()`; that gate now consults the expansion's own
 * unresolved-key set instead, so a literal token no longer reads as satisfied.
 */
function resolveRuntimeString(value: string, environment: Record<string, string>): string {
  return expandConfigVariables(value, environment).value;
}

/**
 * Names a server definition references with no `:-default` that the resolved
 * environment cannot supply, over the documented expansion locations
 * (`mcp.md:453-457`, plus `cwd`, which our descriptor also interpolates).
 *
 * `env` is excluded here because its expansion runs against the base
 * environment inside {@link materializePluginMcpEnvironment}, which reports its
 * own missing names; re-scanning resolved values against the final environment
 * would miss a descriptor variable that shadows an unset base one.
 */
function unresolvedDefinitionReferences(
  server: RuntimeMcpServer,
  environment: Record<string, string>,
): string[] {
  const missing: string[] = [];
  const scan = (value: string | undefined): void => {
    if (value === undefined) return;
    for (const name of expandConfigVariables(value, environment).missing) {
      if (!missing.includes(name)) missing.push(name);
    }
  };
  if (server.definition.type === 'stdio') {
    scan(server.definition.command);
    for (const arg of server.definition.args ?? []) scan(arg);
    scan(server.definition.cwd);
  } else {
    scan(server.definition.url);
  }
  for (const header of Object.values(server.descriptorHeaders ?? {})) scan(header);
  // Scanned for the WARNING only — the helper command itself is never expanded
  // (`mcp.md:459-460`); a plugin placeholder it names is substituted at the
  // materializer, so an unresolvable one deserves the same named report as a
  // header's.
  scan(server.descriptorHeadersHelper);
  return missing;
}

/**
 * One documented missing-variable warning per server: "Claude Code reports a
 * missing-variable warning for that server … Set the variable or add a
 * `:-default` fallback" (`mcp.md:477`). Mirrors the wording the `.mcp.json`
 * reader already emits on the same `debug` channel.
 */
function warnUnresolvedReferences(
  server: RuntimeMcpServer,
  names: readonly string[],
  debug: (message: string) => void,
): void {
  if (!names.length) return;
  debug(`MCP server "${server.wireName}" references unset environment variables with no default: ${[...names].sort().join(', ')}. The unexpanded \${VAR} text is used as-is; set them or add a \${VAR:-default} fallback.`);
}

function runtimeProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * F1.178 (origin WJ-i, P-WJ-i-2) — the pool's POLICY receipts, on a channel a
 * packaged build carries.
 *
 * ## Why these three and not the other two
 *
 * The `debug` option this module is handed is, on the session path,
 * `message => this.debug(message)` (`BaseAgent.setSourceServers`), which reaches
 * `SessionManager`'s `sessionLog` — `platform.logger` scoped, and
 * `apps/electron/src/main/logger.ts` sets both electron-log transports to
 * `level = false` outside debug mode. A packaged build is always outside it, so
 * every line written here has been invisible in every build it was written for.
 * SIT-10 measured exactly that: a full `NESSY_DEBUG=1` run of dmg #4 carried the
 * run's own `[PERF]` lines and ZERO pool lines. F1.143 moved the model-target
 * withholding receipt off that chain; these are its siblings.
 *
 * The three routed here are the ones where a server SILENTLY DISAPPEARS from a
 * session and the log line is the only record that it was a decision rather than
 * a fault:
 *
 *  - `runtime-external-auth-required:dp-builtin:<n>` — builtin dp servers
 *    withheld because dp reports `needs-login`;
 *  - `builtin_dp_mcp.managed_policy_denied: <names>` — builtin dp servers an
 *    ADMINISTRATOR's managed policy denied;
 *  - `plugin_mcp.managed_policy_denied: <wireName>` — the same managed policy,
 *    on a plugin server. NOT named by the row, and swept with the other two on
 *    purpose: leaving it would mean the same administrator decision is readable
 *    for a builtin server and invisible for a plugin one, which is a worse state
 *    than either uniform answer.
 *
 * TWO receipts in this module are deliberately NOT routed, and the reason is the
 * same for both: they record a REQUIREMENT being raised, not a withholding, and
 * the requirement has a surface of its own that the user sees — it is returned
 * as `externalAuthRequirements` and becomes the sign-in card.
 *
 *  - `runtime-external-auth-required:dp:<state>` and
 *    `runtime-external-auth-required:<provider>:needs-login` fire on EVERY
 *    materialization while a provider is unauthenticated, so on the operator
 *    channel they would be per-turn noise standing in front of the lines that
 *    are not. If a future row needs them, the seam is this function and the
 *    change is one word at the call site.
 *
 * ## Why a function rather than two lines at each site
 *
 * Two channels written at three call sites is three chances for them to drift,
 * and the drift is silent in exactly the direction that matters (the operator
 * copy is the one nobody re-reads). It also keeps every site LINE-NEUTRAL, which
 * this file needs: it carries 103 doc line-citations up to line 1548.
 *
 * The dev/headless channel is UNCHANGED — this ADDS a sink, it does not move
 * one, so `electron:dev`, the headless host and this module's existing `debug`
 * assertions all read exactly what they read before. Two copies in a dev build
 * is the named cost; one silent audience traded for another would not have been.
 */
const poolOperatorLog = createLogger('mcp-pool');

function recordPoolPolicyReceipt(debug: (message: string) => void, message: string): void {
  debug(message);
  poolOperatorLog.warn(message);
}

/**
 * F1.593 (C4.4, owner answer QB2 = C) — the organisation's `managedMcpServers`,
 * folded into the set `pool.sync` receives, so every session on every runtime
 * gets them the way it gets any pool server: claude through
 * `createSourceProxyServers`, Pi through the pool's proxy tools, codex through
 * `[mcp_servers.sources]`. HERE, beside the built-in dp fold, for that fold's
 * reason: this is the one place a wire name becomes a server the pool connects,
 * and both production callers (the session agent and the browse pool) reach it.
 *
 * WHY THE HOST AND NOT CLAUDE'S OWN KEY — measured, not assumed. C4.4 decided to
 * project the key into claude's managed settings; driven on the vendored 2.1.267,
 * `Options.managedSettings.managedMcpServers` connected NOTHING (no JSON-RPC
 * request reached the MCP stub) against `Options.mcpServers` connecting the same
 * server as the positive control. The parent tier an embedding host owns is
 * filtered restrictive-only, and an additive key does not survive the filter; the
 * vendor reads the key from a real admin tier, which this host cannot write. So
 * native-first's step 1 is absent for claude and step 2 — the host, once,
 * uniformly — is what this is. No switch cost: all three runtimes read this set.
 *
 * The documented rules, applied here:
 *  - "Users keep the servers they add themselves and can't edit or remove the ones
 *    you provide" — the org entry WINS a wire name a user or plugin server also
 *    takes (the built-in dp fold gives way instead; a built-in is ours, this is the
 *    administrator's), and the displaced name is receipted.
 *  - "deniedMcpServers still applies, and they need no allowedMcpServers entry" —
 *    judged on the deny list alone, by the same gate and pinned policy environment
 *    as every other managed MCP decision in this file.
 *  - DA2.14's external-model whitelist still runs after this, so an external model
 *    target loses them exactly as it loses any other server.
 *
 * Residue, said aloud: the servers carry no source record, so they have no row in
 * the Sources list and no credential slot — static `headers` are the only
 * authentication the key can express, which is the documented shape. (F1.635's
 * catalog half closes the no-row half; the no-credential-slot half is the key's
 * own documented shape, not a defect.) The OTHER residue this function used to
 * name — an org server named like a built-in dp server still counted among the
 * built-in names, so a dp needs-login state withheld it too — is closed: the
 * caller hands in the built-in fold's wire names and gets back only the ones
 * this fold did NOT take over.
 */
export function foldManagedOrgMcpServers(
  servers: Record<string, SdkMcpServerConfig>,
  builtinWireNames: readonly string[],
  debug: (message: string) => void,
): { servers: Record<string, SdkMcpServerConfig>; builtinWireNames: string[] } {
  const policy = resolveManagedPiPolicyFloor()
  const delivered = policy?.managedMcpServers
  if (!policy || !delivered || Object.keys(delivered).length === 0) return { servers, builtinWireNames: [...builtinWireNames] }
  const denyOnly = managedOrgMcpDenyOnlyPolicy(policy)
  const merged: Record<string, SdkMcpServerConfig> = { ...servers }
  const denied: string[] = []
  const displaced: string[] = []
  for (const [name, entry] of Object.entries(delivered)) {
    const allowed = isManagedMcpServerAllowed(denyOnly, { name, transport: entry.type, url: entry.url }, undefined, managedMcpGateOptions())
    if (!allowed) {
      denied.push(name)
      continue
    }
    if (Object.prototype.hasOwnProperty.call(merged, name)) displaced.push(name)
    merged[name] = { type: entry.type, url: entry.url, ...(entry.headers === undefined ? {} : { headers: { ...entry.headers } }) }
  }
  if (denied.length > 0) recordPoolPolicyReceipt(debug, `managed_org_mcp.denied: ${denied.join(', ')}`)
  if (displaced.length > 0) recordPoolPolicyReceipt(debug, `managed_org_mcp.displaced_configured_server: ${displaced.join(', ')}`)
  const takenOver = new Set(displaced)
  return {
    servers: merged,
    // F1.635 — a name this fold took over is the ORG's server now: it needs no
    // dp login, so it must be neither gated by a needs-login state nor reported
    // as a dp auth requirement. A name the organisation's policy DENIED never
    // displaces anything (the entry above is skipped), so the built-in it would
    // have displaced stays in this list and keeps its own gating.
    builtinWireNames: builtinWireNames.filter(name => !takenOver.has(name)),
  }
}

/**
 * F1.635 — the policy the org entries are judged on: the DENY LIST ALONE, never
 * the allowlist. `managed-mcp.md` (verbatim in the SDK's `sdk.d.ts`): "deniedMcpServers
 * still applies, and they need no allowedMcpServers entry" — so an allowlist
 * that does not name an org server admits it anyway, and judging the entries on
 * the full policy would hide a row for a server the pool actually starts.
 *
 * ONE definition, two readers: this fold (the enforcement half) and the catalog
 * mirror in `bootstrap/storage-runtime.ts` (the display half, F1.635), so the
 * row and the pool cannot disagree about whether an org server is on.
 */
export function managedOrgMcpDenyOnlyPolicy(policy: ManagedPiPolicyV1): ManagedPiPolicyV1 {
  return {
    schemaVersion: 1,
    disabledPermissionModes: [],
    ...(policy.deniedMcpServers === undefined ? {} : { deniedMcpServers: policy.deniedMcpServers }),
  }
}
