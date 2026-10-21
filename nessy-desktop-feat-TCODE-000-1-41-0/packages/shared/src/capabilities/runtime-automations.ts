import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { AgentProvider } from '../agent/backend/types.ts';
import {
  hookEventEmission,
  hookEventNativeRoute,
  hookEventNeverFires,
  type CodexNativeHookEvent,
  type HookEventEmissionKind,
} from '../automations/runtime-hook-events.ts';
import {
  AGENT_EVENTS,
  createUserDisabledAutomationSystem,
  mergeAutomationsConfigs,
  parseHooksConfigContent,
  resolveImportedHookTimeoutMs,
  type AgentAutomationSystem,
  type AgentEvent,
  type AutomationAction,
  type AutomationMatcher,
  type AutomationsConfig,
  type ComponentHookLayer,
  type HookBindingTier,
  type HookBindingView,
} from '../automations/index.ts';
import {
  areManagedPluginHooksAllowed,
  areVettedPluginHooksAllowed,
  isManagedAllHooksDisabled,
  isManagedHooksOnly,
  isStrictPluginOnlyCustomizationLocked,
  resolveManagedPiPolicyFloor,
  type ManagedPiPolicyV1,
} from '../agent/pi-harness/managed-policy.ts';
import { pluginRuntimeEnvForProfile } from '../plugins/data-paths.ts';
import { isLocalAutomationManagedDisabled } from '../config/managed-local-automation.ts';
import {
  PluginScopedAutomationSystem,
  TOOL_HOOK_EVENTS,
  hookBindingsForMatcher,
  importedHookDialectForProfile,
  type CommandHookRunner,
  type PluginAgentHookRunner,
  type PluginHttpHookRunner,
  type PluginMcpToolHookRunner,
  type PluginAsyncHookNoteEmitter,
  type PluginHookStatusReporter,
  type PluginPromptHookRunner,
} from '../plugins/hooks-automation.ts';
import type { CapabilitySnapshotMaterializer } from './materializer.ts';
import type { NativeResourceRef, RuntimeHookRegistration } from './resolver.ts';
import type { CapabilityScopeRef } from './types.ts';
import type { AgentRuntimeView } from './views.ts';

export type { CommandHookRunner, PluginAgentHookRunner, PluginMcpToolHookRunner, PluginHttpHookRunner, PluginPromptHookRunner, PluginHookStatusReporter, PluginAsyncHookNote, PluginAsyncHookNoteEmitter } from '../plugins/hooks-automation.ts';

const AGENT_EVENT_SET = new Set<string>(AGENT_EVENTS);

export interface PinnedAutomationRuntime {
  view: Pick<AgentRuntimeView, 'hooks' | 'automations'>;
  materializer: CapabilitySnapshotMaterializer;
}

/**
 * P6.5 — the caller's proof that the plugin hook tier reaching
 * {@link buildPinnedAgentAutomationSystem} was ALREADY narrowed to the managed
 * force-enabled set, so `managedHookLock.pluginHooksVetted` may be `true`.
 *
 * `settings-reference.md#what-runs-under-allowmanagedhooksonly`:
 * "**Force-enabled plugin hooks run**: hooks from plugins your managed settings
 * force-enable through `enabledPlugins`". The per-plugin half of that carve-out
 * is not decided here and never was — it is `storage-runtime.ts`'s
 * `pluginCandidates` filter, which drops a plugin hook candidate whose plugin is
 * not force-enabled while the lock is engaged. This predicate answers only "did
 * that filter run over the snapshot we are about to build from", which is the
 * one thing the builder cannot see for itself.
 *
 * **The answer is the filter's own gate, and nothing else.** That gate is
 * `isRuntimeCapabilityTurn` — `context.provider !== undefined` — so the honest
 * proof is that THIS capability turn carried a provider. The call site used to
 * spell it `provider === 'pi'`, which was correct until P2.314 measured that
 * gate to be a Pi-era early return standing where a host-side filter belongs and
 * widened it to every runtime turn. From then on the conjunct was a stale copy
 * of a rule that had moved: on claude and codex it forced `false`, so an
 * administrator's vetted-hook carve-out silently did not apply and the managed
 * lock blocked the very hooks the page says it keeps — the same organisation
 * policy producing different hook sets on either side of a runtime switch.
 *
 * Still fail-closed where it must be: a provider-neutral browse resolve, and the
 * legacy/test turns `CapabilityTurnRuntime.provider` is optional for, answer
 * `false` and lose the carve-out rather than trusting a narrowing that did not
 * happen.
 *
 * **P3.243 — and the SECOND half of that gate, which was missing.** The
 * `pluginCandidates` filter's force-enable arm is conditioned on
 * `isManagedHooksOnly` alone, so under `strictPluginOnlyCustomization: ['hooks']`
 * with `allowManagedHooksOnly` unset it does not run — while the caller's
 * `managedHookLock.enabled` is the OR of the two keys and is `true`. A policy
 * carrying nothing but that one key and any `enabledPlugins: {x: true}` therefore
 * answered `true` here with no narrowing having happened at all, which made the
 * WHOLE plugin tier read as vetted and, through
 * `pluginHooksAreManagedDistributed`, immune to a user's own `disableAllHooks` —
 * `settings-reference.md#disableallhooks` grants that immunity to exactly one
 * set: "managed hooks, Agent SDK hooks, and hooks from plugins force-enabled in
 * managed `enabledPlugins` keep running".
 *
 * The two keys are two controls and the page separates them cleanly.
 * `settings-reference.md#strictpluginonlycustomization-hooks`: "Claude Code stops
 * running hooks from user, project, and local `settings.json`, and keeps running
 * plugin hooks and hooks in managed settings" — ALL plugin hooks, none of them
 * vetted by anybody. `settings-reference.md#what-runs-under-allowmanagedhooksonly`
 * blocks "hooks from other plugins". So this predicate now answers for the
 * `allowManagedHooksOnly` lock only, and the strict-plugin-only lock is answered
 * where the plugin tier is decided, below.
 */
export function resolveVettedPluginHookLock(
  policy: ManagedPiPolicyV1,
  capabilityTurnProvider: AgentProvider | undefined,
): boolean {
  return capabilityTurnProvider !== undefined
    && isManagedHooksOnly(policy)
    && areVettedPluginHooksAllowed(policy);
}

/** Build the agent hook system exclusively from one captured capability view. */
export async function buildPinnedAgentAutomationSystem(
  runtime: PinnedAutomationRuntime,
  options: {
    workspaceRootPath: string;
    workingDirectory?: string;
    /**
     * Spawns every effectful command-hook action through the ProcessSupervisor
     * `workspace` isolation profile instead of a direct child-process spawn.
     */
    pluginCommandHookRunner?: CommandHookRunner;
    /** Explicit legacy fallback for non-Pi providers only. */
    allowDirectCommandRunner?: boolean;
    /**
     * Judges prompt hooks with a fast model (R22). Absent = prompt hooks stay
     * observational additionalContext injections.
     */
    pluginPromptHookRunner?: PluginPromptHookRunner;
    /**
     * Spawns plugin/project agent-hook sub-agents through the child-session
     * service (B1). Absent = agent hooks match but stay inert.
     */
    pluginAgentHookRunner?: PluginAgentHookRunner;
    /** Invokes mcp_tool hooks through the MCP pool (B2). Absent = inert. */
    pluginMcpToolHookRunner?: PluginMcpToolHookRunner;
    /**
     * Fires http hooks through the webhook executor under the network
     * permission grant (B2). Absent = the request never fires (denial).
     */
    pluginHttpHookRunner?: PluginHttpHookRunner;
    /**
     * Host spinner channel for a hook's `statusMessage` (hooks.md § Common
     * fields). Absent = the label is carried and never displayed.
     */
    hookStatusReporter?: PluginHookStatusReporter;
    /**
     * C3.301 — the host's out-of-band sink for a finished background (`async`)
     * command hook's output. Absent = the run is discarded, which is what
     * happened on every runtime until that row.
     */
    pluginAsyncHookNoteEmitter?: PluginAsyncHookNoteEmitter;
    /**
     * R87 — the host's live component-scoped (skill frontmatter) hook layer,
     * resolved fresh on each dispatch. When present the system is built even
     * with no native/project/plugin config, because component hooks are its
     * only reason to exist for a session that has just a skill guardrail. It is
     * still subject to the user/project disable switches below: component hooks
     * are author/user-tier, so `managedHooksOnly` and a user/project
     * `disableAllHooks` silence them (only the managed level, handled above,
     * touches managed-distributed hooks).
     */
    componentHookLayer?: () => ComponentHookLayer | undefined;
    /**
     * `settings-reference.md#allowmanagedhooksonly`, resolved by the caller.
     *
     * Two booleans rather than the policy object because the second one is not
     * a policy question. `settings-reference.md#what-runs-under-allowmanagedhooksonly`
     * keeps "hooks from plugins your managed settings force-enable through
     * `enabledPlugins`", and the per-plugin narrowing to that set runs upstream,
     * in `storage-runtime.ts`'s `pluginCandidates` filter. Only the caller knows
     * whether it ran, and a lock that assumes it did would admit an unvetted
     * plugin's hooks.
     *
     * P6.5 corrected the rest of this paragraph, which used to say the narrowing
     * runs "on the Pi capability turn only". It did when this was written;
     * P2.314 moved that filter's gate from `provider === 'pi'` to
     * `isRuntimeCapabilityTurn` (`context.provider !== undefined`) because the
     * filter is host-side over a snapshot all four providers share. The caller's
     * proof is therefore {@link resolveVettedPluginHookLock}, not a provider
     * name.
     */
    /**
     * `hooks.md:614` — the MANAGED level of `disableAllHooks`. `true` turns
     * every hook off, including managed-distributed ones. The user/project level
     * of the same key travels inside the hook settings documents themselves and
     * never reaches managed-distributed hooks.
     *
     * **P2.206 — THIS OPTION IS NO LONGER THE ONLY READ, because as the only
     * read it was DEAD.** Measured: `buildPinnedAgentAutomationSystem` has
     * exactly one production caller
     * (`SessionManager.buildAgentAutomationSystem`), it passes `managedHookLock`
     * and has never passed this, and a test was its only setter repo-wide — so
     * the managed HOOK KILL SWITCH silenced nothing on any provider. The key's
     * other reader is `storage-runtime.ts`'s plugin-candidate filter, which sat
     * behind `provider === 'pi'` at the time and covers plugin hook candidates
     * only (P2.314 has since widened that gate to every runtime turn). An
     * administrator who set it therefore disabled nothing at all on claude,
     * codex or nestor-cloud, and only plugin hooks on Pi.
     *
     * The floor is now read HERE, from `resolveManagedPiPolicyFloor()` — the
     * process-scoped composed-policy reader that exists for exactly this
     * shared-side situation and that `claude-managed-settings.ts` already uses
     * — so the switch is honoured on every provider that builds an automation
     * system, which is every provider.
     *
     * The option survives as a caller override that can only TIGHTEN: it is
     * OR-ed with the floor, never `??`-ed. A kill switch that a caller can turn
     * back OFF is not a kill switch, and the host has no authority to overrule
     * the managed tier.
     */
    managedDisableAllHooks?: boolean;
    /**
     * P6.13 — the session's runtime, so registration can tell a hook that will
     * never fire here from one that will.
     *
     * A plugin's hooks are imported once and are runtime-agnostic; whether the
     * EVENT occurs is a property of the runtime. Passing the provider is what
     * lets the two be compared at the one place both are known. Absent = no
     * comparison is made, which is what every existing caller gets.
     */
    provider?: AgentProvider;
    /**
     * Reports one registered hook event that this runtime is MEASURED never to
     * fire (`runtime-hook-events.ts`). Called once per event key at build time,
     * never per dispatch — the dispatch never happens, which is the defect.
     *
     * The verdict is passed through rather than flattened to a boolean because
     * `unwired` and `unreachable` are different answers to "can this be fixed",
     * and a consumer that collapses them would tell a user a buildable feature
     * is impossible.
     */
    onHookEventNeverFires?: (report: {
      provider: AgentProvider;
      event: AgentEvent;
      kind: HookEventEmissionKind;
      note: string;
      /**
       * P6.14 — the RUNTIME'S OWN key for this moment, when it has one.
       *
       * P6.13 could only say "this never fires here", which reads as "this
       * cannot work here" and is false for five of codex's cells: the binary
       * hooks those moments itself, under the name reported in this field, and
       * what is absent is our projection into codex's `[hooks]` table. Carrying
       * the key rather than a flag is what lets a reader act on it — it names
       * the exact TOML key a fix is written under.
       */
      nativeRoute?: CodexNativeHookEvent;
    }) => void;
    managedHookLock?: {
      /** User, project and non-vetted plugin hook tiers are dropped whole. */
      readonly enabled: boolean;
      /**
       * Whether the plugin hooks in this view are already narrowed to the
       * managed FORCE-ENABLED set — never to `allowedPluginKeys`, which means
       * only "these plugins may be used" and would hand hook execution to an
       * entire organisation allowlist. `false` under an engaged lock drops them
       * all — the fail-closed reading, and the correct one where we cannot tell a
       * vetted plugin from any other.
       */
      readonly pluginHooksVetted: boolean;
    };
  },
): Promise<PinnedAgentAutomationSystem | undefined> {
  runtime.materializer.assertActive();
  // The composed managed policy, read once for this build. `undefined` is every
  // non-managed install (no provider registered) and any run whose policy file
  // cannot be resolved — the reader tolerates a throwing provider rather than
  // taking a session start down with it.
  const managedPolicyFloor = resolveManagedPiPolicyFloor();
  // `hooks.md:614` — "Only `disableAllHooks` set at the managed settings level
  // can disable managed hooks." The managed level turns EVERY tier off, so
  // nothing below needs reading at all. P2.206: the floor is consulted here, not
  // only the caller's option, because no caller ever passed the option.
  // Re-measured LIVE 2026-09-12 (C5.35, R3) on the packaged build at 2.1.247: under
  // a delivered managed policy setting this key every host-registered hook went
  // silent across a two-tool turn while the child's own settings-tier hooks kept
  // firing, and removing the policy restored every host counter; the key still
  // never reaches the runtime (the restrictive filter does not copy it, the live
  // spawn line's `--managed-settings` JSON does not carry it), so `host-gate` is
  // confirmed by measurement rather than by a second code reading.
  const managedDisableAllHooks = options.managedDisableAllHooks === true
    || (managedPolicyFloor !== undefined && isManagedAllHooksDisabled(managedPolicyFloor))
    // D1.205 — the codex tier of the same question. `[features]
    // in_app_local_automation = false` says the desktop app may not run local
    // automations at all, and hooks are half of what
    // `packages/shared/src/automations/` is; the other half is the scheduler,
    // gated at the `AutomationSystem` construction in `SessionManager`. ORed
    // rather than given a gate of its own, because a second kill switch beside
    // a working one is what D1.205's own premise correction refused.
    || isLocalAutomationManagedDisabled();
  if (managedDisableAllHooks) return undefined;
  // `settings-reference.md#what-runs-under-allowmanagedhooksonly` —
  // "**Everything else is blocked**: user, project, and local hooks, hooks from
  // other plugins, and hooks declared in agent frontmatter."
  // Applied here because this is the one place all three tiers exist as named
  // buckets before anything can run; a per-event filter downstream would have to
  // be right on every event forever.
  const managedHooksOnly = options.managedHookLock?.enabled === true;
  // P2.206's neighbour, measured the same way and found the same shape:
  // `allowPluginHooks: false` is the managed PLUGIN-hook kill switch, and
  // `areManagedPluginHooksAllowed` had exactly one production caller — the
  // plugin-candidate filter, then still gated on `provider === 'pi'` — so on
  // claude, codex and nestor-cloud the switch admitted every plugin hook. It is a permanent
  // posture rather than a temporary silence, which is why it narrows the plugin
  // tier here instead of returning `undefined` for the whole system.
  const pluginHooksAllowedByPolicy = managedPolicyFloor === undefined
    || areManagedPluginHooksAllowed(managedPolicyFloor);
  // P3.243 — WHICH of the two locks engaged, because they keep different plugin
  // tiers and the caller hands us only their OR. Read from the floor, the same
  // reader P2.206 established here for `disableAllHooks` and `allowPluginHooks`:
  // an unreadable floor answers `false` and loses the wider tier rather than
  // asserting a narrowing nobody can see.
  //
  // `settings-reference.md#strictpluginonlycustomization-hooks` keeps the WHOLE
  // plugin tier — "keeps running plugin hooks and hooks in managed settings" —
  // where `#what-runs-under-allowmanagedhooksonly` keeps only the force-enabled
  // set and blocks "hooks from other plugins". The stricter key wins where both
  // are set, which is why this arm requires `allowManagedHooksOnly` to be absent.
  const strictPluginOnlyHooksLock = managedPolicyFloor !== undefined
    && !isManagedHooksOnly(managedPolicyFloor)
    && isStrictPluginOnlyCustomizationLocked(managedPolicyFloor, 'hooks');
  const keepPluginHooks = pluginHooksAllowedByPolicy
    && (!managedHooksOnly
      || options.managedHookLock?.pluginHooksVetted === true
      || strictPluginOnlyHooksLock);
  // Plugin hooks that survive the `allowManagedHooksOnly` lock are exactly the
  // managed force-enabled set — administrator-deployed, so the user-level switch
  // below must not reach them (`hooks.md:614`). With no lock, plugin hooks are
  // user-installed and the user-level switch covers them.
  //
  // P3.243 — the plugin hooks kept by `strictPluginOnlyHooksLock` are NOT in that
  // set: nothing narrowed them and no administrator named them, they are simply
  // every installed plugin's hooks. `settings-reference.md#disableallhooks` names
  // what a non-managed `disableAllHooks` spares — "managed hooks, Agent SDK
  // hooks, and hooks from plugins force-enabled in managed `enabledPlugins`" —
  // and they are none of those, so the user's own switch must reach them. The
  // conjunct that keeps them out is `pluginHooksVetted`, which since P3.243
  // requires the `allowManagedHooksOnly` lock itself.
  const pluginHooksAreManagedDistributed = managedHooksOnly
    && options.managedHookLock?.pluginHooksVetted === true;
  const nativeConfigs: AutomationsConfig[] = [];
  // D1.429 — the WORKSPACE scope is its own bucket, not part of `nativeConfigs`.
  // `<workspaceRoot>/automations.json` is written by the model-invocable
  // `automation_create` tool, so this tier cannot ride the `user`
  // pre-authorisation D1.343 granted the operator's own settings file. See
  // {@link CommandHookSource}; the split is here because this is the last place
  // `resource.scope` exists.
  const workspaceConfigs: AutomationsConfig[] = [];
  const projectConfigs: AutomationsConfig[] = [];
  // P6.294 — provenance is captured HERE because it exists only here: the
  // resource ref is in hand for one more line, and `mergeAutomationsConfigs`
  // below keeps the matchers and drops which file each came from.
  const hookBindings: HookBindingView[] = [];
  const pluginHooks: RuntimeHookRegistration[] = [];
  const seenNativeResources = new Set<string>();
  const pluginInstanceIds = new Set<string>();
  // `hooks.md#disable-or-remove-hooks` — the user/project settings level of
  // `disableAllHooks`. Any non-managed settings document declaring it silences
  // the non-managed tiers.
  //
  // ## P2.496 — the vendor's intent, established before deciding what we owe
  //
  // The row asked whether a user-tier switch failing to stop an SDK-REGISTERED
  // hook is the vendor's intent or an artefact. Read 2026-09-03,
  // `settings-reference.md#disableallhooks` answers it in as many words, and the
  // answer is *intent*, stated for both tiers:
  //
  //   "**In managed settings**: Claude Code disables every configured hook,
  //   including managed ones, and keeps running the hooks the Agent SDK
  //   registers in process"
  //   "**In any other settings file**: Claude Code disables user, project,
  //   local, and plugin hooks; managed hooks, Agent SDK hooks, and hooks from
  //   plugins force-enabled in managed `enabledPlugins` keep running"
  //
  // The page and the binary AGREE for the user tier: `SessionManager`'s
  // worktree-port docblock records `yte()` (`registeredHooks`) surviving a
  // user-tier switch, `allowManagedHooksOnly` and `--safe-mode` alike. They
  // DISAGREE for the managed tier, and in the direction `AGENTS.md` names as
  // "the bundle lags the docs": the page says SDK hooks keep running under a
  // MANAGED `disableAllHooks` and adds "Keeping Agent SDK hooks running when
  // managed settings set this key requires Claude Code v2.1.242 or later".
  //
  // **THAT WINDOW HAS CLOSED and this comment described it in the present tense
  // for one bundle too long (C3.252, 2026-09-12).** It said "the bundle we ship
  // is `claudeCodeVersion 2.1.233`, where the managed tier does stop them
  // (`zre()` in `executeHooksOutsideREPL`)". The bundle we ship is
  // `claudeCodeVersion 2.1.247`, PAST v2.1.242, so the page and the binary are
  // no longer one window apart and the 2.1.233 reading is superseded. A re-read
  // of the collection path at 2.1.247 shows the SDK-registered registry still
  // being consulted on the ordinary branch after the file tiers are emptied --
  // the page's own behaviour -- but that is a reading of the code and NOT a live
  // measurement, so it is recorded rather than asserted. Nothing here depends on
  // that arm: the managed level returned `undefined` far above.
  //
  // ## What that leaves, said here rather than implied
  //
  // Below this line the user tier reaches everything it should and stops
  // exactly where the page stops it: the native, project and component tiers go
  // (they are the user's own), plugin hooks go UNLESS they are the managed
  // force-enabled set, which `pluginHooksAreManagedDistributed` spares. That
  // boundary is driven in `__tests__/runtime-automations.test.ts`.
  //
  // The hooks this switch does NOT reach are the ones the host registers into
  // the SDK directly in `agent/claude-agent.ts` — the permission gate, the
  // `PermissionDenied` audit receipt, the subagent debug logging, the
  // task-registry/scheduling enrichment of `Stop`/`SubagentStop`, and the
  // worktree port. They are out of this builder's reach by construction, and
  // two of them must stay that way whatever is decided: `disableAllHooks`
  // governs hooks, a status line and a file-suggestion command, never a
  // permission decision, so routing it into the `PreToolUse` gate would turn a
  // convenience switch into a permission widening. The enrichment is the one
  // the owner's decision names, and it is inert once this builder has returned
  // nothing — it only ever decorates matchers that exist.
  let settingsDisableAllHooks = false;

  for (const registration of [...runtime.view.hooks, ...runtime.view.automations]) {
    const resource = registration.resource;
    if (!isNativeResource(resource) || seenNativeResources.has(resource.resourceId)) continue;
    seenNativeResources.add(resource.resourceId);
    const content = await runtime.materializer.readText(resource);
    const parsed = parseHooksConfigContent(content, registration.key);
    // The settings KEY is not a hook: it is read even under the managed-only
    // lock, where the same document's hooks are blocked.
    if (parsed.disableAllHooks) settingsDisableAllHooks = true;
    if (managedHooksOnly) continue;
    if (!hasAgentMatchers(parsed.config)) continue;
    // Scope still controls trust; the injected runner now contains every
    // effectful command hook regardless of native/plugin provenance.
    //
    // D1.429 — THREE buckets, not two. `builtin` (the administrator's system
    // directory) and `global` (`~/.nessy-agent`) stay `nativeConfigs`: both are
    // written by a person with an account on this machine, which is what the
    // `user` tier's review argument rests on. `workspace` is not — it is the
    // app's own directory and the model can append to it.
    (resource.scope.kind === 'project'
      ? projectConfigs
      : resource.scope.kind === 'workspace' ? workspaceConfigs : nativeConfigs
    ).push(parsed.config);
    // P6.294 — the same matchers, projected for the read-only view. The TIER is
    // the resource's own scope rather than which array it landed in, because
    // those two arrays are a merge convenience (project vs everything else)
    // while `managed` and `user` are different answers to "who may turn this
    // off" — the exact distinction the rest of this function turns on.
    const tier = hookBindingTierForScope(resource.scope.kind);
    const source = safeHookSourcePath(resource.absolutePath, options.workspaceRootPath);
    for (const [event, matchers] of Object.entries(parsed.config.automations) as [AgentEvent, AutomationMatcher[]][]) {
      if (!AGENT_EVENT_SET.has(event)) continue;
      for (const matcher of matchers ?? []) {
        hookBindings.push(...hookBindingsForMatcher(event, matcher, tier, source));
      }
    }
  }

  if (settingsDisableAllHooks) {
    nativeConfigs.length = 0;
    // D1.429 — the workspace tier is a user/author tier for the DISABLE switch
    // exactly as it was before the split; only its command-hook trust changed.
    workspaceConfigs.length = 0;
    projectConfigs.length = 0;
    // P6.294 — the view lists what will RUN, so a tier the user's own switch
    // just silenced leaves it with the tier. Managed-distributed plugin hooks
    // are added below and survive, which is exactly the mixed state P2.496
    // records: the flag is on and something still runs.
    hookBindings.length = 0;
  }
  // The user/project switch stops at the managed boundary: plugin hooks that
  // survive an engaged lock are administrator-deployed and only the managed
  // level of the key (handled above) can silence them.
  const keepPluginTier = keepPluginHooks
    && !(settingsDisableAllHooks && !pluginHooksAreManagedDistributed);

  for (const hook of keepPluginTier ? runtime.view.hooks : []) {
    if (!hook.pluginInstanceId) continue;
    await runtime.materializer.verifyPlugin(hook.pluginInstanceId);
    pluginInstanceIds.add(hook.pluginInstanceId);
    pluginHooks.push(hook);
  }
  // The plugin tier goes through the exported builder rather than repeating its
  // body here, so `buildPluginHookAutomations` really is the only place a plugin
  // hook becomes an automation — see its doc comment.
  //
  // P6.294 — the binding callback is why the projection is not a second walk
  // over `pluginHooks`: a registration can be REFUSED inside `pluginHookConfig`
  // (a non-agent event, an `if` filter on a non-tool event, no buildable
  // action), and a view built from the registrations would list hooks that were
  // dropped. The callback fires only for the ones that became a matcher.
  const pluginTierConfig = buildPluginHookAutomations(pluginHooks, (hook, event, matcher) => {
    hookBindings.push(...hookBindingsForMatcher(
      event,
      matcher,
      'plugin',
      'relativePath' in hook.resource ? hook.resource.relativePath : undefined,
    ));
  });
  // `pluginHookConfig` yields exactly one event key per accepted hook, so an
  // empty merged map means every plugin hook was dropped — the same condition
  // the pre-builder code spelled `pluginConfigs.length === 0`.
  const hasPluginHooks = Object.keys(pluginTierConfig.automations).length > 0;

  reportHookEventsThatNeverFire(options.provider, options.onHookEventNeverFires, [
    ...nativeConfigs,
    ...workspaceConfigs,
    ...projectConfigs,
    pluginTierConfig,
  ]);

  runtime.materializer.assertActive();
  // R87 — component hooks are author/user-tier: a managed-only lock or a
  // user/project `disableAllHooks` silences them, exactly like the native and
  // project tiers above. The managed-level `disableAllHooks` returned undefined
  // long before here, so managed-distributed hooks are unaffected.
  const componentHookLayer = options.componentHookLayer && !managedHooksOnly && !settingsDisableAllHooks
    ? options.componentHookLayer
    : undefined;
  if (nativeConfigs.length === 0 && workspaceConfigs.length === 0 && projectConfigs.length === 0 && !hasPluginHooks && !componentHookLayer) {
    // P2.496 — `undefined` and "the user turned hooks off" used to arrive at the
    // registration site as the same answer, which is why the switch could not
    // reach a single hook the host registers itself. It now answers with an
    // inert system carrying that one bit instead
    // (`createUserDisabledAutomationSystem`, whose header states why it is
    // purpose-built rather than an empty `PluginScopedAutomationSystem`).
    //
    // The `undefined` arm is untouched, and keeping it is the point: it means
    // "nothing is configured", by far the more common state, and every consumer
    // that reads it that way stays correct.
    return settingsDisableAllHooks ? createUserDisabledAutomationSystem() : undefined;
  }
  return new PluginScopedAutomationSystem({
    // P2.496 — the MIXED case: the user's switch is engaged and something still
    // runs, because plugin hooks force-enabled in managed `enabledPlugins`
    // survive it (only the managed level of the key stops those, and that level
    // returned `undefined` long above). The flag reports the user's SETTING, so
    // the host can stand its own additions down while the administrator's hooks
    // keep going. Spread-conditional so absence keeps meaning "not engaged"
    // rather than a `false` that asserts it.
    ...(settingsDisableAllHooks ? { userTierDisableAllHooks: true } : {}),
    ...(nativeConfigs.length > 0 ? { userGlobalHookConfig: mergeAutomationsConfigs(...nativeConfigs) } : {}),
    // D1.429 — the field existed with no production setter and was attributed
    // `user` so that the two could not answer differently "if one ever
    // appears". One has: this is it, and the honest answer is its own tier.
    ...(workspaceConfigs.length > 0 ? { workspaceHookConfig: mergeAutomationsConfigs(...workspaceConfigs) } : {}),
    ...(projectConfigs.length > 0 ? { projectHookConfig: mergeAutomationsConfigs(...projectConfigs) } : {}),
    pluginHookConfig: pluginTierConfig,
    ...(hookBindings.length > 0 ? { hookBindings } : {}),
    workspaceRootPath: options.workspaceRootPath,
    ...(options.workingDirectory ? { workingDir: options.workingDirectory } : {}),
    ...(options.pluginCommandHookRunner ? { pluginCommandRunner: options.pluginCommandHookRunner } : {}),
    ...(options.allowDirectCommandRunner ? { allowDirectCommandRunner: true } : {}),
    ...(options.pluginPromptHookRunner ? { pluginPromptRunner: options.pluginPromptHookRunner } : {}),
    ...(options.pluginAgentHookRunner ? { pluginAgentRunner: options.pluginAgentHookRunner } : {}),
    ...(options.pluginMcpToolHookRunner ? { pluginMcpToolRunner: options.pluginMcpToolHookRunner } : {}),
    ...(options.pluginHttpHookRunner ? { pluginHttpRunner: options.pluginHttpHookRunner } : {}),
    ...(options.hookStatusReporter ? { hookStatusReporter: options.hookStatusReporter } : {}),
    ...(options.pluginAsyncHookNoteEmitter ? { asyncHookNoteEmitter: options.pluginAsyncHookNoteEmitter } : {}),
    ...(componentHookLayer ? { componentHookLayer } : {}),
    assertActive: () => runtime.materializer.assertActive(),
    verifyPluginIntegrity: async () => {
      for (const pluginInstanceId of pluginInstanceIds) {
        await runtime.materializer.verifyPlugin(pluginInstanceId);
      }
    },
  });
}

/**
 * P6.13 — the honest half of "a hook registered for an event this runtime never
 * emits."
 *
 * The codex import registers a `PostToolUse` hook and reports the plugin
 * installed and enabled while `codex-agent.ts` emits four events, `PostToolUse`
 * not among them. This is the one place where the registered event vocabulary
 * and the session's runtime are both in hand, so it is where the two are
 * compared.
 *
 * Deliberately NOT a filter: the hook stays registered. Withholding it would be
 * indistinguishable from the plugin not being installed, and the event may gain
 * an emitter tomorrow (`unwired` says exactly that), at which point a filtered
 * registration would have to be un-filtered somewhere else. Reporting keeps the
 * shipped behaviour and removes only the silence.
 *
 * The component-hook layer is not walked HERE: it is resolved fresh per
 * dispatch, so it has no event set at build time. Its events are a subset of a
 * skill's or subagent's frontmatter and are reported by whoever gains that
 * surface — and P6.120 is whoever gained it.
 * `SessionManager.describeCapabilityDelta` asks the LIVE layer
 * (`ComponentHookLayer.hasMatchers`) at the one moment it can be asked
 * honestly: the switch report, computed before the drain, while the outgoing
 * agent's `activeSkillInvocations` are still the ones about to be lost. So the
 * sentence above is still true about THIS function and no longer describes a
 * hole in the product.
 */
function reportHookEventsThatNeverFire(
  provider: AgentProvider | undefined,
  report: ((report: { provider: AgentProvider; event: AgentEvent; kind: HookEventEmissionKind; note: string; nativeRoute?: CodexNativeHookEvent }) => void) | undefined,
  configs: readonly AutomationsConfig[],
): void {
  if (!provider || !report) return;
  const seen = new Set<AgentEvent>();
  for (const config of configs) {
    for (const [event, matchers] of Object.entries(config.automations) as [AgentEvent, AutomationMatcher[]][]) {
      if (!matchers?.length || !AGENT_EVENT_SET.has(event) || seen.has(event)) continue;
      seen.add(event);
      if (!hookEventNeverFires(provider, event)) continue;
      const emission = hookEventEmission(provider, event);
      // P6.14 — spread rather than always-present, so a runtime with no native
      // counterpart reports the field ABSENT instead of `undefined`. A consumer
      // reading "there is a route" off the key's presence cannot then be
      // misled by a runtime that has none.
      const nativeRoute = hookEventNativeRoute(provider, event);
      report({
        provider,
        event,
        kind: emission.kind,
        note: emission.note,
        ...(nativeRoute ? { nativeRoute } : {}),
      });
    }
  }
}

function isNativeResource(resource: RuntimeHookRegistration['resource']): resource is NativeResourceRef {
  return 'absolutePath' in resource;
}

function hasAgentMatchers(config: AutomationsConfig): boolean {
  return Object.entries(config.automations)
    .some(([event, matchers]) => AGENT_EVENT_SET.has(event) && (matchers?.length ?? 0) > 0);
}

/**
 * Turn plugin hook REGISTRATIONS into the automations config
 * `PluginScopedAutomationSystem` executes.
 *
 * This is the ONLY builder, and `buildPinnedAgentAutomationSystem` above CALLS
 * it. That claim used to stand here while that function still assembled the
 * plugin tier inline from `pluginHookConfig` — which is precisely the second
 * builder the claim denied. F4 deleted the projection-path twin
 * (`buildTrustedPluginHookAutomations`), which read a V1 `PluginProjectionPlan`
 * and had no production caller; a second builder is how a pass ends up attached
 * to a road nobody drives. `hooks-automation.test.ts` builds its plugin-hook
 * fixtures from here, so those tests now describe the config production really
 * runs rather than a faithful copy of it.
 */
export function buildPluginHookAutomations(
  hooks: readonly RuntimeHookRegistration[],
  /**
   * P6.294 — called once per hook that really became a matcher, with the
   * matcher this builder produced. Optional so the existing callers and the
   * fixtures are unchanged; the point of the seam is that acceptance is decided
   * in `pluginHookConfig` and nowhere else, so a caller wanting to LIST the
   * accepted hooks must be told by the decider rather than re-deriving the
   * three refusal conditions.
   */
  onAccepted?: (hook: RuntimeHookRegistration, event: AgentEvent, matcher: AutomationMatcher) => void,
): AutomationsConfig {
  const configs = hooks.flatMap(hook => {
    const config = pluginHookConfig(hook);
    if (!config) return [];
    if (onAccepted) {
      for (const [event, matchers] of Object.entries(config.automations) as [AgentEvent, AutomationMatcher[]][]) {
        for (const matcher of matchers ?? []) onAccepted(hook, event, matcher);
      }
    }
    return [config];
  });
  return configs.length > 0 ? mergeAutomationsConfigs(...configs) : { automations: {} };
}

/**
 * P6.294 — the scope a hook's own file was found at, in the page's tier names.
 *
 * `builtin` is this codebase's spelling for the ADMINISTRATOR tier — the same
 * scope `native-sources.ts` emits an admin root at and `resolver.ts` ranks
 * highest (P6.239) — so it projects as `managed`, the name
 * `features-overview.md#understand-how-features-layer` uses. Everything that is
 * not project- or managed-scoped is the user's own: `global` is
 * `~/.nessy-agent`, `workspace` is a workspace the user made.
 */
function hookBindingTierForScope(kind: CapabilityScopeRef['kind']): HookBindingTier {
  if (kind === 'project') return 'project';
  if (kind === 'builtin') return 'managed';
  return 'user';
}

/**
 * P6.294 — a source path a user view may carry.
 *
 * `NativeResourceRef.absolutePath` is marked *"Server-only; stripped from
 * Composer/user views"*, and this is a user view, so the absolute path never
 * leaves this function. Inside the workspace it relativizes to something a
 * reader can open. OUTSIDE it — a user-global `~/.nessy-agent/hooks.json`, the
 * common case — `relative()` would produce a `../../..` chain that spells out
 * where the workspace sits relative to the home directory, so the file name
 * alone is returned instead: enough to find the declaration next to the tier
 * that is already reported, and not a path.
 */
function safeHookSourcePath(absolutePath: string, workspaceRootPath: string): string {
  const relativePath = relative(workspaceRootPath, absolutePath);
  return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)
    ? relativePath
    : basename(absolutePath);
}

function pluginHookConfig(hook: RuntimeHookRegistration): AutomationsConfig | null {
  if (!AGENT_EVENT_SET.has(hook.event)) return null;
  // hooks.md#common-fields — the page's OWN link target for the `if` field.
  // This line said "hooks.md § if" until P2.290, and no such section exists:
  // measured against the rendered page's ids, a bare `id="if"` scores 0.
  // The filter is only evaluated on tool events; "On other
  // events, a hook with `if` set never runs" — so it must not produce an
  // action at all. The deleted projection path dropped these at registration
  // with a `plugin.hooks.if_non_tool_event` diagnostic and this was its
  // live-runtime mirror; F4 left only the mirror, which is the half that decides
  // (CDP pass 2, 2026-07-26: a SessionStart hook with `if` executed live while
  // projection stayed clean — the mirror is why it does not now).
  if (hook.ifRule && !TOOL_HOOK_EVENTS.has(hook.event as AgentEvent)) return null;
  const action = pluginHookAction(hook);
  if (!action) return null;
  const matcher: AutomationMatcher = {
    name: hook.key,
    // Imported hook matchers were authored against the external two-mode
    // contract (exact name list, else unanchored regex, `*` matches all).
    // Native automations parsed above never carry this and keep the
    // unanchored-regex behaviour they were written against.
    ...(hook.matcher ? { matcher: hook.matcher, matchMode: 'claude' as const } : {}),
    // The `if` filter gates per invocation at execution time
    // (executePluginHookAutomations → hookIfFilterRuns): any-subcommand match,
    // and TWO fail-opens that are not the same provenance (P2.290 — this line
    // used to cite one sentence for both, and an over-citation is worse than
    // none because the next reader stops checking).
    //
    // UPSTREAM, hooks.md#bash-if-matching: "The filter also fails open, running
    // your hook regardless of pattern, when the Bash command can't be parsed."
    // That is the unparseable COMMAND, and only that.
    //
    // OURS: an `if` RULE that will not compile also runs the hook. The page says
    // nothing about that case — its posture is inferred from the second half of
    // the same sentence ("Because the `if` filter is best-effort, use the
    // permission system rather than a hook to enforce a hard allow or deny")
    // plus the hazard of the alternative, which P2.270 measured one file over:
    // a source-anchored rule with no root reaches `claude-permission-rules.ts`'s
    // `invalid-policy` branch on perfectly ordinary configs, so failing closed
    // would silently stop ordinary hooks running. Not silent since P2.277 —
    // `hooks-automation.ts`'s `reportUnparseableIfRule` puts it on `hookErrors`.
    // (The registration-time report this line used to name retired with the V1
    // bridge in F4. P2.288 restored it one file over, as
    // `plugin.hook.if_unparseable_fail_open` in `plugins/schema.ts` — the reader
    // every format's manifest funnels through — and only for the STRING-level
    // failure, which is the half decidable before a call exists. The
    // `invalid-policy` cause below needs `call.sourceRoot`, so it is still
    // reportable only here.)
    ...(hook.ifRule ? { ifRule: hook.ifRule } : {}),
    // A source-anchored `/x` path rule in the filter resolves against the
    // plugin's own installed bundle (owner decision 2026-07-29) — the anchor the
    // deleted projection path called `executionRoot`.
    ...(hook.pluginRuntime?.rootPath ? { ifSourceRoot: hook.pluginRuntime.rootPath } : {}),
    actions: [action],
  };
  return {
    automations: { [hook.event as AgentEvent]: [matcher] },
  };
}

/**
 * Builds the single runtime action for a trusted plugin hook registration.
 * Command hooks keep the host-run subprocess action; prompt hooks become an
 * observational `plugin-prompt` injection. Agent, MCP-tool and HTTP hooks are
 * normalized into typed actions, but stay inert unless the host explicitly
 * injects their corresponding runner authority.
 */
function pluginHookAction(hook: RuntimeHookRegistration): AutomationAction | null {
  // hooks.md's per-type/per-event `timeout` defaults and ceilings, including the
  // dialect (D6) — the compatibility profile rides the registration itself, so
  // no plan lookup is needed (the deleted projection path had to build one).
  const timeoutMs = resolveImportedHookTimeoutMs(
    hook.event as AgentEvent,
    hook.type ?? 'command',
    hook.timeoutMs,
    importedHookDialectForProfile(hook.pluginRuntime?.profile),
  );
  // hooks.md § Common fields: the spinner label rides every hook type.
  const statusFields = hook.statusMessage ? { statusMessage: hook.statusMessage } : {};
  if (hook.type === 'prompt') {
    return hook.prompt?.trim()
      ? {
          type: 'plugin-prompt',
          prompt: hook.prompt,
          ...(hook.model ? { model: hook.model } : {}),
          ...(hook.continueOnBlock ? { continueOnBlock: true } : {}),
          timeoutMs,
          ...statusFields,
        }
      : null;
  }
  if (hook.type === 'agent') {
    return hook.agentName?.trim() ? { type: 'plugin-agent', agentName: hook.agentName, timeoutMs, ...statusFields } : null;
  }
  if (hook.type === 'mcp') {
    return hook.mcpTool?.trim()
      ? { type: 'plugin-mcp-tool', mcpTool: hook.mcpTool, ...(hook.mcpArgs ? { mcpArgs: hook.mcpArgs } : {}), timeoutMs, ...statusFields }
      : null;
  }
  // UB12.67 — hooks.md `onFailure` rides the two types the page gives it to;
  // the executor reads it (`executePluginHookAutomations`).
  const onFailureFields = hook.onFailure === 'block' ? { onFailure: 'block' as const } : {};
  if (hook.type === 'http') {
    return hook.http?.url?.trim() ? { type: 'plugin-http', http: hook.http, timeoutMs, ...statusFields, ...onFailureFields } : null;
  }
  if (hook.type !== 'command' || !hook.command?.trim()) return null;
  const cwd = resolvePluginCwd(hook);
  if (cwd === null) return null;
  return {
    type: 'command' as const,
    command: hook.command,
    // hooks.md § Exec form and shell form: present `args` is what makes the
    // spawn exec form, so the vector has to survive to the action.
    ...(hook.args ? { args: [...hook.args] } : {}),
    // The three-way exit-code contract (0 = parse stdout, 2 = blocking error
    // with stderr fed back, any other non-zero = non-blocking error) belongs to
    // the format the hook was AUTHORED in, so it follows the registration's
    // `exitCodeContract` rather than "was imported". Codex and native
    // `nessy-plugin.json` command hooks keep the Nessy contract where ANY
    // non-zero exit blocks. hooks.md:699 exempts `WorktreeCreate` from the
    // three-way contract — any non-zero exit aborts creation.
    ...(hook.exitCodeContract === 'claude-three-way' && hook.event !== 'WorktreeCreate' ? { blockOnNonZero: false } : {}),
    // hooks.md `shell`: picks the interpreter a shell-form command runs under;
    // the runner ignores it in exec form ("Ignored when `args` is set").
    ...(hook.shell ? { shell: hook.shell } : {}),
    ...(hook.async ? { async: true } : {}),
    // C3.301 — `asyncRewake` was stored on the registration and dropped HERE,
    // which is the first of the three places the flag used to die. It changes
    // only which sink the background run's output reaches
    // (`hooks.md#limitations`: an idle session waits for the next user
    // interaction, *"Exception: an `asyncRewake` hook that exits with code 2
    // wakes Claude immediately even when the session is idle"*), so it has to
    // survive onto the action the executor sees. `async` is already true beside
    // it — the import path stores both, because the page's field implies it.
    ...(hook.asyncRewake ? { asyncRewake: true } : {}),
    ...(cwd ? { cwd } : {}),
    timeoutMs,
    ...statusFields,
    ...onFailureFields,
    // `plugins/manifest-reference.md#environment-variables` — "All values are exported to hook processes as
    // `CLAUDE_PLUGIN_OPTION_<KEY>` environment variables". The option names are
    // namespaced and cannot collide with the plugin path aliases, but they are
    // merged after them so a bundle can never shadow `NESSY_PLUGIN_ROOT`.
    ...(hook.pluginRuntime || hook.optionEnvironment
      ? {
          env: {
            ...(hook.pluginRuntime
              ? pluginRuntimeEnvForProfile(hook.pluginRuntime.profile, {
                  bundleRoot: hook.pluginRuntime.rootPath,
                  dataPath: hook.pluginRuntime.dataPath,
                  ...(hook.pluginRuntime.projectPath ? { projectPath: hook.pluginRuntime.projectPath } : {}),
                })
              : {}),
            ...(hook.optionEnvironment ?? {}),
          },
        }
      : {}),
  };
}

function resolvePluginCwd(hook: RuntimeHookRegistration): string | null | undefined {
  const root = hook.pluginRuntime?.rootPath;
  if (!root) return hook.cwd;
  const target = hook.cwd
    ? (isAbsolute(hook.cwd) ? resolve(hook.cwd) : resolve(root, hook.cwd))
    : root;
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    return null;
  }
  return target;
}

/** Refuses, at compile time, a listed system that is not an {@link AgentAutomationSystem}. */
type EveryListedSystemIsAnAgentAutomationSystem<T extends AgentAutomationSystem> = T;

/**
 * F1.278 — EVERY concrete system {@link buildPinnedAgentAutomationSystem} can
 * return, as a closed list rather than the interface. The builder's declared
 * return type is this list, so a `return` of any other implementation stops
 * compiling until it is added here — and the wrapper-forwarding guard
 * (`automation-wrapper-forwarding.test.ts`) derives its member table from this
 * very type, so the new implementation's duck-typed members (the way
 * `setSessionDirectiveSink` sat on `PluginScopedAutomationSystem` outside the
 * interface) must then each be given a disposition before `typecheck:server-core`
 * passes. Residue, stated: TypeScript is structural, so a SUBCLASS of a listed
 * class, or an object literal carrying `userTierDisableAllHooks: true`, is
 * already assignable and would not be forced; the guard's runtime arm still
 * reads the members such a system actually carries.
 */
export type PinnedAgentAutomationSystem = EveryListedSystemIsAnAgentAutomationSystem<
  PluginScopedAutomationSystem | ReturnType<typeof createUserDisabledAutomationSystem>
>;
