/**
 * P6.156 — the bundled agents' MODEL TIER, and the sentence a session owes when
 * it resolves to nothing.
 *
 * ## The gap, and the half of it that closed while this row was open
 *
 * `BUILTIN_AGENT_DEFINITIONS` declares a `tier` per bundled agent — `scout`
 * small, `reviewer` and `planner` medium, `worker` big — and the host resolves
 * it from the CONNECTION, not from the runtime: `resolveGatewayFastModelId`
 * answers the `small` tier when the catalogue publishes a `fast` alias, and
 * nothing answers `medium` or `big` on ANY of the three. So a bundled agent
 * whose tier does not resolve runs on the SESSION's model, and until P6.154 no
 * runtime said so.
 *
 * P6.154 (W6-b) closed the claude arm with a hardcoded English sentence scoped
 * to `small`. This row is the rest of it, and it is deliberately host-side —
 * case 2 of native-first: the host owns the definitions, the tier map and both
 * diagnostic channels, and no runtime publishes a tier mechanism to enable, so
 * ONE builder serves all three rather than three sentences drifting apart.
 *
 * ## Two decisions taken here rather than left implicit
 *
 * **`medium` and `big` ARE named**, where P6.154's claude-only line named only
 * `small`. Its stated reason — that announcing them would claim a divergence
 * measurement does not support, and "a banner that cries wolf is a banner people
 * learn to ignore" — is correct about DIVERGENCE and does not carry to the
 * capability. The user's question is *why is `worker` not on a bigger model*,
 * and the honest answer is *nothing resolves that tier here*, on every runtime.
 * The sentence therefore says so IN ITSELF: it names the uniformity, so it can
 * never be read as a per-runtime loss and never becomes a switch cost.
 *
 * **The grade stays P6.154's**, which is a MEASURED decision and not a default:
 * the line is latched once per session and sent to the log channel rather than
 * the transcript banner, because routed to the banner it fires on most
 * connections and contradicts an existing named control. Reporting the two
 * always-inert tiers makes that grade more important, not less.
 *
 * The runtime arms that mount this are, per runtime: claude through
 * `claudeBuiltinAgentTierDiagnostics`, and Pi and codex through their own
 * session diagnostics — both of those are the residue this row hands on, since
 * their emission sites are agent files.
 */
import { BUILTIN_AGENT_DEFINITIONS, type AgentTier } from './definitions.ts';
import { i18n, setupI18n } from '../i18n/index.ts';

/**
 * The tiers the host could resolve for this session's connection.
 *
 * Deliberately the same shape Pi's own `tierModelMap` takes, because the two
 * runtimes reading differently-shaped answers to one question is how they drift.
 * Only `small` is ever populated today, on all three.
 */
export type BuiltinAgentTierModelMap = Readonly<Partial<Record<AgentTier, string>>>;

/** One bundled agent whose declared tier resolved to no distinct model. */
export interface InertBuiltinAgentTier {
  agent: string;
  tier: AgentTier;
}

/**
 * The bundled agents whose tier resolves to nothing on this connection.
 *
 * Separated from the sentence so a caller can act on the fact — a test, a
 * structural record — without parsing prose back out of a line, which is the
 * shape P3.337 recorded as the thing not to do.
 */
export function inertBuiltinAgentTiers(
  tierModelMap?: BuiltinAgentTierModelMap,
): InertBuiltinAgentTier[] {
  const inert: InertBuiltinAgentTier[] = [];
  for (const definition of BUILTIN_AGENT_DEFINITIONS) {
    const resolved = tierModelMap?.[definition.tier];
    if (typeof resolved === 'string' && resolved.length > 0) continue;
    inert.push({ agent: definition.name, tier: definition.tier });
  }
  return inert;
}

/**
 * ONE aggregated line naming every bundled agent whose tier is inert, or `[]`
 * when every tier this session's bundled agents declare resolves.
 *
 * One line for all of them rather than one each: the claude notice channel is
 * capped at eight lines a session (`CLAUDE_SWITCH_VISIBLE_DEGRADATION_LIMIT`),
 * and four lines saying the same thing would crowd out other facts. The names
 * are listed so the user can see which agents are affected, and the tiers
 * because they are what did not resolve.
 */
export function buildBuiltinAgentTierNotice(
  tierModelMap?: BuiltinAgentTierModelMap,
): string[] {
  const inert = inertBuiltinAgentTiers(tierModelMap);
  if (inert.length === 0) return [];
  const tiers = [...new Set(inert.map(entry => entry.tier))];
  // The guard every other diagnostic on these paths carries, and it is not
  // ceremony: MEASURED 2026-08-25, an uninitialised i18next returns `undefined`
  // from `t()`, and the headless `nessy-server` entry never calls `setupI18n()`.
  if (!i18n.isInitialized) setupI18n();
  return [
    i18n.t('chat.builtinAgentTier.inert', {
      agents: inert.map(entry => entry.agent).join(', '),
      tiers: tiers.join(', '),
      count: inert.length,
    }),
  ];
}
