/**
 * The honesty half of a plugin mandate.
 *
 * `settings-reference.md#enabledplugins` — "Turn individual plugins on or off,
 * keyed by `plugin-name@marketplace-name`" — and the same entry's Scope bullet
 * makes the managed tier "**Managed settings**: organization-wide policy. A
 * plugin set to `false` here is blocked from installation at every scope and
 * hidden from the marketplace". A managed `true` is therefore a MANDATE: the
 * administrator is stating that this plugin runs on this fleet.
 *
 * Nothing installs it. `enabledPlugins` is read by the activation overlay, which
 * decides whether an INSTALLED plugin is on; a key naming a plugin that is not
 * installed matches nothing and changes nothing. The mandate is a silent no-op,
 * and the administrator has no surface that says so — the same defect class as a
 * policy key with no reader, which is exactly what
 * `server-managed-settings.md#invalid-entries-in-delivered-settings` ("Validate
 * a payload change with `claude doctor` on a test machine before rolling it out
 * to the organization.") exists to catch.
 *
 * So this module answers one question: for each plugin the policy force-enables,
 * is it actually here, and if not, is the marketplace it would come from even
 * registered. Pure — the caller reads the two registries and passes them in.
 */

/** One force-enabled plugin key, and what the machine can actually do about it. */
export interface MandatedPluginFindingV1 {
  /** OUR `PluginKey` — `enc(marketplaceId).enc(pluginId)`. */
  readonly pluginKey: string;
  /**
   * `'installed'` — the mandate has something to act on.
   * `'not-installed'` — the mandate does nothing at all today.
   */
  readonly state: 'installed' | 'not-installed';
  /**
   * For a `not-installed` mandate: whether ANY marketplace is registered on this
   * machine. Told apart because the two states need different fixes — with no
   * marketplace the administrator must deliver one (`extraKnownMarketplaces`);
   * with one registered the plugin is simply not installed from it yet.
   *
   * Never present for an `installed` row: there is nothing to diagnose.
   */
  readonly marketplacesRegistered?: number;
}

export interface MandatedPluginInput {
  /** The enforced managed `enabledPlugins` map, when the policy carries one. */
  readonly enabledPlugins?: Readonly<Record<string, boolean>> | undefined;
  /** Plugin keys with an active installed instance. */
  readonly installedPluginKeys: readonly string[];
  /** How many marketplace registries exist on this machine. */
  readonly marketplacesRegistered: number;
}

/**
 * The findings, sorted by key so a report and a scripted diff are stable.
 *
 * Only `true` entries are considered. A managed `false` is a BLOCK — `:793`'s
 * "block installation at all scopes and hide the plugin from the marketplace" —
 * and a block naming a plugin nobody installed is doing precisely its job, so it
 * is not a finding in either state.
 */
export function resolveMandatedPluginFindings(
  input: MandatedPluginInput,
): MandatedPluginFindingV1[] {
  const installed = new Set(input.installedPluginKeys);
  const mandated = Object.entries(input.enabledPlugins ?? {})
    .filter(([, enabled]) => enabled === true)
    .map(([pluginKey]) => pluginKey)
    .sort((left, right) => left.localeCompare(right));
  return mandated.map(pluginKey => (installed.has(pluginKey)
    ? { pluginKey, state: 'installed' as const }
    : {
        pluginKey,
        state: 'not-installed' as const,
        marketplacesRegistered: input.marketplacesRegistered,
      }));
}

/** True when at least one mandate does nothing — the state a fleet check fails on. */
export function hasUnfulfilledPluginMandate(
  findings: readonly MandatedPluginFindingV1[],
): boolean {
  return findings.some(finding => finding.state === 'not-installed');
}
