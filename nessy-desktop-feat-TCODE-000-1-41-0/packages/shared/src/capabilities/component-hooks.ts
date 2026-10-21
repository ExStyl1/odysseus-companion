/**
 * R87b — SUBAGENT frontmatter hooks (`sub-agents.md` § *Hooks in subagent
 * frontmatter*).
 *
 * The mechanism is R87's, not a second one: the same parser
 * ({@link partitionFrontmatterHooks}), the same `ComponentHookLayer` contract,
 * the same `executePluginHookAutomations` executor. What is new here is where a
 * subagent's hooks RUN, which the page splits in two:
 *
 * - "`PreToolUse` — Before the subagent uses a tool", "`PostToolUse` — After the
 *   subagent uses a tool". Those fire inside the child's own session, so they
 *   travel to it on `PiChildRestrictionsV1.componentHooks.child`.
 * - "`Stop` — When the subagent finishes (converted to `SubagentStop` at
 *   runtime)". `SubagentStop` is emitted PARENT-side when the child returns
 *   (`SessionManager.executePiChildTerminalAutomation`), so that tier travels on
 *   `.parent` and is consulted by the parent's automation system for exactly the
 *   dispatch that names this child.
 */
import type {
  AgentEvent as AutomationAgentEvent,
  AutomationsConfig,
  ComponentHookLayer,
  SdkAutomationInput,
} from '../automations/types.ts';
import { mergeAutomationsConfigs } from '../automations/hooks-config.ts';
import { partitionFrontmatterHooks } from './runtime-skill-content.ts';

/**
 * A subagent's frontmatter hooks, partitioned by WHICH SESSION dispatches them.
 *
 * WIRE + PERSISTENCE: embedded verbatim in `PiChildRestrictionsV1.componentHooks`
 * and in `PiRuntimeAgentDefinitionDescriptor.componentHooks`, whose digest is
 * `sha256(JSON.stringify(...))`. Key order is therefore load-bearing: `child`
 * before `parent`, in every producer and in the restore-path validator, or the
 * two sides hash differently.
 */
export interface SubagentComponentHooks {
  /** Events dispatched inside the subagent's OWN session (`PreToolUse`, …). */
  readonly child?: AutomationsConfig;
  /** `SubagentStop` — dispatched PARENT-side when the child returns. */
  readonly parent?: AutomationsConfig;
}

/**
 * The events a subagent's frontmatter can only ever be dispatched for by the
 * PARENT session. `Stop` is renamed to `SubagentStop` at parse
 * (`sub-agents.md`: "`Stop` hooks in frontmatter are automatically converted to
 * `SubagentStop` events"), and a definition that spells `SubagentStop` out lands
 * in the same tier rather than being sent to a child session that never emits
 * it.
 */
const SUBAGENT_PARENT_EVENTS: ReadonlySet<string> = new Set(['SubagentStop']);

function splitByEvent(config: AutomationsConfig | undefined): { child?: AutomationsConfig; parent?: AutomationsConfig } {
  if (!config) return {};
  const childAutomations: AutomationsConfig['automations'] = {};
  const parentAutomations: AutomationsConfig['automations'] = {};
  for (const [event, matchers] of Object.entries(config.automations)) {
    if (!matchers || matchers.length === 0) continue;
    const target = SUBAGENT_PARENT_EVENTS.has(event) ? parentAutomations : childAutomations;
    target[event as AutomationAgentEvent] = matchers;
  }
  return {
    ...(Object.keys(childAutomations).length > 0 ? { child: { automations: childAutomations } } : {}),
    ...(Object.keys(parentAutomations).length > 0 ? { parent: { automations: parentAutomations } } : {}),
  };
}

/**
 * Parse a subagent definition's frontmatter `hooks` block.
 *
 * Two documented differences from the skill parser, both expressed as options on
 * the shared partitioner rather than as a second reader:
 * - `Stop` → `SubagentStop` (`sub-agents.md`, the frontmatter event table).
 * - `once` is NOT honoured (`hooks.md`, the `once` field: "Only honored for
 *   hooks declared in skill frontmatter; ignored in settings files and agent
 *   frontmatter") — so a hook carrying it still runs, on every match.
 *
 * Fails soft: a malformed block yields `undefined` and the subagent runs without
 * frontmatter hooks rather than failing to load.
 */
export function parseSubagentFrontmatterHooks(content: string): SubagentComponentHooks | undefined {
  const tiers = partitionFrontmatterHooks(content, {
    honourOnce: false,
    label: 'subagent frontmatter hooks',
    renameEvents: { Stop: 'SubagentStop' },
  });
  const split = splitByEvent(tiers?.always);
  if (!split.child && !split.parent) return undefined;
  return Object.freeze({
    ...(split.child ? { child: split.child } : {}),
    ...(split.parent ? { parent: split.parent } : {}),
  });
}

/**
 * The restore/wire half of {@link parseSubagentFrontmatterHooks}: structurally
 * accept an already-parsed block WITHOUT re-parsing it, so the JSON the
 * definition digest is computed over round-trips byte for byte. Same shape as
 * `runtime-skill-content.ts`'s `staticComponentHooks`, and for the same reason —
 * the digest is the integrity check; this only rejects a block whose SHAPE could
 * crash the dispatcher.
 */
export function staticSubagentComponentHooks(value: unknown): SubagentComponentHooks | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid subagent component hooks');
  }
  const input = value as { child?: unknown; parent?: unknown };
  const tier = (config: unknown, field: string): AutomationsConfig | undefined => {
    if (config === undefined) return undefined;
    const automations = config && typeof config === 'object' && !Array.isArray(config)
      ? (config as { automations?: unknown }).automations
      : undefined;
    if (!automations || typeof automations !== 'object' || Array.isArray(automations)) {
      throw new Error(`Invalid subagent component hooks ${field}`);
    }
    return config as AutomationsConfig;
  };
  const child = tier(input.child, 'child');
  const parent = tier(input.parent, 'parent');
  if (!child && !parent) return undefined;
  // `child` before `parent` — see the interface's key-order note.
  return Object.freeze({ ...(child ? { child } : {}), ...(parent ? { parent } : {}) });
}

/**
 * A {@link ComponentHookLayer} over ONE config read live from a getter — the
 * shape a session-scoped component (a subagent's own session) needs, where the
 * "active set" is a single entry that is present for the component's lifetime
 * and gone afterwards.
 *
 * No `once` tier: `once` is honoured for skill frontmatter only, so the layers
 * built from this factory report none and consume nothing.
 */
export function createConfigComponentHookLayer(
  config: () => AutomationsConfig | undefined,
): ComponentHookLayer {
  const matchers = (event: AutomationAgentEvent): AutomationsConfig | undefined => {
    const entries = config()?.automations[event];
    return entries && entries.length > 0 ? { automations: { [event]: entries } } : undefined;
  };
  return {
    matchersFor: event => matchers(event),
    onceMatchersFor: () => undefined,
    consumeOnce: () => {},
    hasMatchers: event => matchers(event) !== undefined,
  };
}

/**
 * A {@link ComponentHookLayer} over the parent session's LIVE set of running
 * children, scoped per dispatch by `agent_id`.
 *
 * `sub-agents.md`: frontmatter hooks "only run while that specific subagent is
 * active and are cleaned up when it finishes". Both halves are properties of
 * reading `runningChildren()` at dispatch: an entry appears when the child
 * starts and is gone when its terminal event has been dispatched. The
 * `agent_id` filter is what makes "that specific subagent" exact — a parent can
 * hold several live children and their terminal events are not serialized with
 * one another, so without it a sibling's completion would run this child's
 * `Stop` hook.
 */
export function createSubagentParentComponentHookLayer(
  runningChildren: () => Iterable<readonly [string, AutomationsConfig]>,
): ComponentHookLayer {
  const matchers = (
    event: AutomationAgentEvent,
    input: SdkAutomationInput | undefined,
  ): AutomationsConfig | undefined => {
    const dispatchedAgentId = typeof (input as { agent_id?: unknown } | undefined)?.agent_id === 'string'
      ? (input as { agent_id: string }).agent_id
      : undefined;
    const configs: AutomationsConfig[] = [];
    for (const [agentId, config] of runningChildren()) {
      // No input (the `hasMatchers` perf gate) => "could match", so every live
      // child counts. With an input, only the child the event names.
      if (dispatchedAgentId !== undefined && agentId !== dispatchedAgentId) continue;
      const entries = config.automations[event];
      if (entries && entries.length > 0) configs.push({ automations: { [event]: entries } });
    }
    if (configs.length === 0) return undefined;
    return configs.length === 1 ? configs[0]! : mergeAutomationsConfigs(...configs);
  };
  return {
    matchersFor: (event, input) => matchers(event, input),
    onceMatchersFor: () => undefined,
    consumeOnce: () => {},
    hasMatchers: event => matchers(event, undefined) !== undefined,
  };
}

/**
 * Fold several component layers into one, so the single
 * `PluginScopedAutomationSystem.componentHookLayer` seam can carry a session's
 * skill layer AND its subagent layers without the automation system learning
 * about either. `undefined` in, and `undefined` out when nothing is left, so a
 * caller with no layers still builds no system.
 */
export function combineComponentHookLayers(
  ...layers: readonly (ComponentHookLayer | undefined)[]
): ComponentHookLayer | undefined {
  const present = layers.filter((layer): layer is ComponentHookLayer => layer !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0]!;
  const fold = (
    read: (layer: ComponentHookLayer) => AutomationsConfig | undefined,
  ): AutomationsConfig | undefined => {
    const configs = present.map(read).filter((config): config is AutomationsConfig => config !== undefined);
    if (configs.length === 0) return undefined;
    return configs.length === 1 ? configs[0]! : mergeAutomationsConfigs(...configs);
  };
  return {
    matchersFor: (event, input) => fold(layer => layer.matchersFor(event, input)),
    onceMatchersFor: (event, input) => fold(layer => layer.onceMatchersFor(event, input)),
    consumeOnce: event => { for (const layer of present) layer.consumeOnce(event); },
    hasMatchers: event => present.some(layer => layer.hasMatchers(event)),
  };
}
