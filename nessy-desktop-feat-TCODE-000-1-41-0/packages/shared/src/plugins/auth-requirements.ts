import type { PluginConfigurationStatus } from './mcpb-configuration.ts';
import type {
  NessyPluginManifest,
  PluginConnectorAuthTiming,
  PluginConnectorDescriptor,
} from './types.ts';

/**
 * The twin gate (C3/C5): a connector server with a same-serverName mcp
 * capability twin rides the capability path, so only twin-less servers —
 * PERSISTED pre-C3 manifests — still count as connector-shaped requirements.
 * The Source projection this once guarded is deleted; the gate survives here
 * because the auth report must stay shape-stable for old entries.
 */
function twinLessConnectors(
  manifest: Pick<NessyPluginManifest, 'capabilities' | 'connectors'>,
): PluginConnectorDescriptor[] {
  const twins = new Set(manifest.capabilities.flatMap(capability => (
    capability.kind === 'mcp' ? [capability.mcp.serverName] : []
  )));
  const out: PluginConnectorDescriptor[] = [];
  for (const connector of manifest.connectors ?? []) {
    const servers = connector.mcpServers.filter(server => !twins.has(server.serverName));
    if (servers.length === 0) continue;
    out.push(servers.length === connector.mcpServers.length
      ? connector
      : { ...connector, mcpServers: servers });
  }
  return out;
}

export type PluginMcpAuthRequirement =
  | {
      kind: 'dp';
      capabilityIds: string[];
      serverNames: string[];
      sharedProvider: 'dp';
      timing: 'ON_FIRST_USE';
    }
  | {
      kind: 'oauth' | 'bearer';
      connectorIds: string[];
      serverNames: string[];
      timing: PluginConnectorAuthTiming;
    }
  | {
      kind: 'environment';
      capabilityIds: string[];
      serverNames: string[];
      requiredNames: string[];
    }
  | {
      kind: 'unsupported-app';
      appIds: string[];
      connectorIds: string[];
    };

/**
 * Timing by server name, read from the connectors the twin gate above drops.
 *
 * A catalog authentication policy is applied by
 * `management-service-v2.ts:applyCatalogAuthentication`, and the only field it
 * has to write the timing onto is `connectors[].auth.timing` — the `kind:'mcp'`
 * capability twin it rewrites alongside has no timing field at all. So for a
 * twinned server the value lives exclusively on the descriptor `twinLessConnectors`
 * discards, and reading it back is the only way the capability path can report
 * a timing the catalog actually set. Measured on a real record: figma carries
 * `connectors[0].auth.timing = 'ON_INSTALL'` and used to be reported as
 * `ON_FIRST_USE`.
 */
function twinConnectorTimings(
  manifest: Pick<NessyPluginManifest, 'connectors'>,
): Map<string, PluginConnectorAuthTiming> {
  const timings = new Map<string, PluginConnectorAuthTiming>();
  for (const connector of manifest.connectors ?? []) {
    const timing = connector.auth?.timing;
    if (!timing) continue;
    for (const server of connector.mcpServers) timings.set(server.serverName, timing);
  }
  return timings;
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const isRemoteServer = (server: { transport: string; url?: string }): boolean => (
  (server.transport === 'http' || server.transport === 'sse') && !!server.url
);
const isDeclaredMaterializableServer = (server: { transport: string; url?: string; command?: string }): boolean => (
  server.transport === 'stdio' ? !!server.command?.trim() : isRemoteServer(server)
);

export function derivePluginMcpAuthRequirements(manifest: NessyPluginManifest): PluginMcpAuthRequirement[] {
  const dpCapabilityIds: string[] = [];
  const dpServerNames: string[] = [];
  const environmentCapabilityIds: string[] = [];
  const environmentServerNames: string[] = [];
  const requiredNames: string[] = [];

  for (const capability of manifest.capabilities) {
    if (capability.kind !== 'mcp') continue;
    const { mcp } = capability;
    if (mcp.command === 'dp' && mcp.args?.[0] === 'ai' && mcp.args[1] === 'mcp' && mcp.args[2]?.trim()) {
      dpCapabilityIds.push(capability.id);
      dpServerNames.push(mcp.serverName);
    }
    const required = [...(mcp.requiredEnvironmentNames ?? []), ...Object.keys(mcp.credentialEnvironment ?? {})];
    if (required.length > 0) {
      environmentCapabilityIds.push(capability.id);
      environmentServerNames.push(mcp.serverName);
      requiredNames.push(...required);
    }
  }

  const requirements: PluginMcpAuthRequirement[] = [];
  if (dpCapabilityIds.length > 0) {
    requirements.push({
      kind: 'dp', capabilityIds: sorted(dpCapabilityIds), serverNames: sorted(dpServerNames),
      sharedProvider: 'dp', timing: 'ON_FIRST_USE',
    });
  }

  const twinTimings = twinConnectorTimings(manifest);
  for (const kind of ['oauth', 'bearer'] as const) {
    const groups = new Map<PluginConnectorAuthTiming, { connectorIds: string[]; serverNames: string[] }>();
    // Pre-C3 persisted manifests only: capability-twinned servers are reported
    // through the capability loop below, never double-counted here.
    for (const connector of twinLessConnectors(manifest)) {
      const servers = connector.mcpServers.filter(isRemoteServer);
      if (connector.auth?.type !== kind || servers.length === 0) continue;
      const timing = connector.auth.timing ?? 'ON_FIRST_USE';
      const group = groups.get(timing) ?? { connectorIds: [], serverNames: [] };
      group.connectorIds.push(connector.id);
      group.serverNames.push(...servers.map(server => server.serverName));
      groups.set(timing, group);
    }
    // C3 (capability-path): auth-carrying `kind:'mcp'` capabilities are the
    // post-C3 shape of the same requirement. The capability itself is
    // state-based (empty slot ⇒ pending) and has no timing field, so the timing
    // comes from its twin connector when one set it — a catalog policy writes
    // ON_INSTALL there and nowhere else. Both adapters declare ON_FIRST_USE, so
    // that stays the default for everything a policy did not touch.
    // `connectorIds` carries the capability id; the RPC shape is unchanged.
    for (const capability of manifest.capabilities) {
      if (capability.kind !== 'mcp') continue;
      const { mcp } = capability;
      if (mcp.authType !== kind || !isRemoteServer(mcp)) continue;
      const timing = twinTimings.get(mcp.serverName) ?? 'ON_FIRST_USE';
      const group = groups.get(timing) ?? { connectorIds: [], serverNames: [] };
      group.connectorIds.push(capability.id);
      group.serverNames.push(mcp.serverName);
      groups.set(timing, group);
    }
    for (const timing of ['ON_FIRST_USE', 'ON_INSTALL'] as const) {
      const group = groups.get(timing);
      if (group) requirements.push({
        kind, timing, connectorIds: sorted(group.connectorIds), serverNames: sorted(group.serverNames),
      });
    }
  }

  if (environmentCapabilityIds.length > 0) {
    requirements.push({
      kind: 'environment', capabilityIds: sorted(environmentCapabilityIds),
      serverNames: sorted(environmentServerNames), requiredNames: sorted(requiredNames),
    });
  }

  const appIds: string[] = [];
  const connectorIds: string[] = [];
  for (const app of manifest.apps ?? []) {
    const connector = manifest.connectors?.find(candidate => candidate.id === app.connectorId);
    if (connector?.mcpServers.some(isDeclaredMaterializableServer)) continue;
    appIds.push(app.id);
    connectorIds.push(app.connectorId);
  }
  if (appIds.length > 0) {
    requirements.push({ kind: 'unsupported-app', appIds: sorted(appIds), connectorIds: sorted(connectorIds) });
  }
  return requirements;
}

/**
 * Model-relayable install setup summary (T2, plugin-install plan — the
 * agent-driven install path gets the same truth as the RPC result).
 *
 * Derived purely from the SAME inputs the RPC result carries — the
 * manifest-derived `authRequirements` and the value-free enable-time
 * `configuration` status — so the tool path and the RPC path can never
 * disagree about what a fresh install still needs. `notes` are short English
 * sentences a model relays to the user verbatim; the structured fields are for
 * assertions and machine consumers. Never carries a secret, a path or a value.
 */
export interface PluginInstallSetupSummary {
  /** True when nothing further is needed — every declared server is usable now. */
  ready: boolean;
  /** One sentence per outstanding requirement, for the model to relay. */
  notes: string[];
  /** One Developer Platform sign-in unblocks all of these servers at once. */
  dp?: { count: number; serverNames: string[] };
  /** OAuth/bearer connector servers that will ask to connect when first used. */
  connectOnFirstUse?: { serverNames: string[] };
  /** OAuth/bearer connector servers whose sign-in is offered at install time. */
  connectOnInstall?: { serverNames: string[] };
  /** Servers needing environment/credential values before they can start. */
  environment?: { serverNames: string[]; requiredNames: string[] };
  /** Declared user-configuration keys still missing a value. */
  userConfig?: { missingKeys: string[] };
}

export function summarizePluginInstallSetup(input: {
  authRequirements?: readonly PluginMcpAuthRequirement[];
  configuration?: Pick<PluginConfigurationStatus, 'state' | 'fields'>;
}): PluginInstallSetupSummary {
  const summary: PluginInstallSetupSummary = { ready: true, notes: [] };
  const firstUseServerNames: string[] = [];
  const onInstallServerNames: string[] = [];
  for (const requirement of input.authRequirements ?? []) {
    if (requirement.kind === 'dp') {
      summary.dp = { count: requirement.serverNames.length, serverNames: requirement.serverNames };
    } else if (requirement.kind === 'oauth' || requirement.kind === 'bearer') {
      (requirement.timing === 'ON_INSTALL' ? onInstallServerNames : firstUseServerNames)
        .push(...requirement.serverNames);
    } else if (requirement.kind === 'environment') {
      summary.environment = {
        serverNames: requirement.serverNames,
        requiredNames: requirement.requiredNames,
      };
    }
  }
  if (firstUseServerNames.length > 0) summary.connectOnFirstUse = { serverNames: sorted(firstUseServerNames) };
  if (onInstallServerNames.length > 0) summary.connectOnInstall = { serverNames: sorted(onInstallServerNames) };
  const missingKeys = (input.configuration?.fields ?? [])
    .filter(field => field.missing)
    .map(field => field.key);
  if (missingKeys.length > 0) summary.userConfig = { missingKeys: sorted(missingKeys) };

  if (summary.dp) {
    summary.notes.push(
      `One Developer Platform sign-in unblocks ${summary.dp.count} server(s): ${summary.dp.serverNames.join(', ')}.`,
    );
  }
  if (summary.connectOnInstall) {
    // The catalog asks for this one at install time; we have no install-time
    // OAuth chain, so the sign-in is offered from the same three surfaces as
    // ON_FIRST_USE. Saying "asks the user to connect now" would tell the model
    // an authorisation happened that never did.
    summary.notes.push(
      `These servers need a sign-in the catalog marks as install-time; the user is offered it from the chat notice, the plugin page or the MCP list: ${summary.connectOnInstall.serverNames.join(', ')}.`,
    );
  }
  if (summary.connectOnFirstUse) {
    summary.notes.push(
      `These servers will ask the user to connect when first used: ${summary.connectOnFirstUse.serverNames.join(', ')}.`,
    );
  }
  if (summary.environment) {
    summary.notes.push(
      `These servers need configuration values before use (${summary.environment.requiredNames.join(', ')}): ${summary.environment.serverNames.join(', ')}.`,
    );
  }
  if (summary.userConfig) {
    summary.notes.push(
      `Plugin configuration still needs values for: ${summary.userConfig.missingKeys.join(', ')}.`,
    );
  }
  summary.ready = summary.notes.length === 0;
  if (summary.ready) summary.notes.push('All installed servers are ready to use.');
  return summary;
}
