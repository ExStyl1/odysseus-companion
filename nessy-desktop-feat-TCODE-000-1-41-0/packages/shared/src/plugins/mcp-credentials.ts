/**
 * Plugin MCP server credential slots (C2 of the capability-path plan).
 *
 * A plugin-declared MCP server that authenticates (oauth/bearer) owns ONE
 * global credential slot in the encrypted store, keyed
 * `plugin_mcp_{oauth|bearer}::{pluginKey}::{serverName}` — one credential per
 * server, ever, in every workspace (ADR § 1/§ 2, matching the contract's
 * central-credential model). This module is the only place that spells those
 * key shapes; everything else goes through it.
 *
 * It deliberately does NOT run OAuth flows — the source-independent endpoint
 * core (`auth/endpoint-oauth.ts`, C1) does that over an
 * `OAuthEndpointBinding` whose `credentialId` is built here.
 */

import { getCredentialManager } from '../credentials/manager.ts';
import type { CredentialId, StoredCredential } from '../credentials/types.ts';
import { PLUGIN_MCP_CREDENTIAL_TYPES } from '../credentials/types.ts';
import { sourceCredentialScope } from '../sources/credential-manager.ts';
import { loadAllSources } from '../sources/storage.ts';
import type { PluginKey } from './types.ts';

export type PluginMcpCredentialAuthType = 'oauth' | 'bearer';

/** The credential-store slot of one plugin MCP server. */
export function pluginMcpCredentialId(
  authType: PluginMcpCredentialAuthType,
  pluginKey: PluginKey,
  serverName: string,
): CredentialId {
  return {
    type: authType === 'bearer' ? 'plugin_mcp_bearer' : 'plugin_mcp_oauth',
    pluginKey,
    serverName,
  };
}

/**
 * Load a plugin MCP server's credential, trying OAuth first and falling back
 * to bearer — the same fallback order the source MCP loader uses, because a
 * server's declared auth may have been satisfied through either slot.
 */
export async function loadPluginMcpCredential(
  pluginKey: PluginKey,
  serverName: string,
): Promise<StoredCredential | null> {
  const manager = getCredentialManager();
  for (const authType of ['oauth', 'bearer'] as const) {
    const credential = await manager.get(pluginMcpCredentialId(authType, pluginKey, serverName));
    if (credential?.value) return credential;
  }
  return null;
}

/** Save a plugin MCP server's credential into its global slot. */
export async function savePluginMcpCredential(
  authType: PluginMcpCredentialAuthType,
  pluginKey: PluginKey,
  serverName: string,
  credential: StoredCredential,
): Promise<void> {
  await getCredentialManager().set(
    pluginMcpCredentialId(authType, pluginKey, serverName),
    credential,
  );
}

/**
 * Delete BOTH slots of one plugin MCP server. Returns how many rows existed.
 */
export async function deletePluginMcpServerCredentials(
  pluginKey: PluginKey,
  serverName: string,
): Promise<number> {
  const manager = getCredentialManager();
  let deleted = 0;
  for (const authType of ['oauth', 'bearer'] as const) {
    if (await manager.delete(pluginMcpCredentialId(authType, pluginKey, serverName))) {
      deleted += 1;
    }
  }
  return deleted;
}

/**
 * Purge every plugin MCP credential row of one plugin — the uninstall rule
 * (ADR § 2: "uninstall purges the plugin slots"). Enumerates the store rather
 * than trusting a manifest, so rows from older versions of the plugin (renamed
 * or removed servers) die too. Returns how many rows were deleted.
 */
export async function purgePluginMcpCredentials(pluginKey: PluginKey): Promise<number> {
  const manager = getCredentialManager();
  let deleted = 0;
  for (const type of PLUGIN_MCP_CREDENTIAL_TYPES) {
    const rows = await manager.list({ type });
    for (const id of rows) {
      if (id.pluginKey !== pluginKey) continue;
      if (await manager.delete(id)) deleted += 1;
    }
  }
  return deleted;
}

/**
 * One-shot migration to the GLOBAL connector credential slot (T5, owner
 * § 0b-1; moved here from the deleted connector-source-materializer at C5).
 * Existing `source_oauth::{ws}::{slug}` / `source_bearer::{ws}::{slug}` rows
 * written for connectorOrigin sources move to
 * `{type}::@connector-global::{pluginKey}#{connectorId}#{serverName}`.
 *
 * First-writer-wins: when two workspaces each hold a credential for the same
 * server, the first migrated row fills the global slot and the other
 * workspace-scoped rows are deleted — one OAuth per server is the decided end
 * state, and either credential was minted by the same server for the same
 * user. Plain user-created sources are never touched. Idempotent: a second run
 * finds no workspace-scoped rows. It feeds the C4 slot copy that runs right
 * after it at startup.
 */
export async function migrateConnectorSourceCredentialsToGlobal(args: {
  workspaceRootPaths: readonly string[];
}): Promise<{ migrated: number; deleted: number }> {
  const credentialManager = getCredentialManager();
  let migrated = 0;
  let deleted = 0;
  for (const workspaceRootPath of args.workspaceRootPaths) {
    for (const source of loadAllSources(workspaceRootPath)) {
      const origin = source.config.connectorOrigin;
      if (!origin) continue;
      for (const type of ['source_oauth', 'source_bearer'] as const) {
        const legacyId: CredentialId = {
          type,
          workspaceId: source.workspaceId,
          sourceId: source.config.slug,
        };
        const legacy = await credentialManager.get(legacyId);
        if (!legacy) continue;
        const globalId: CredentialId = { type, ...sourceCredentialScope(source) };
        const existing = await credentialManager.get(globalId);
        if (!existing) {
          await credentialManager.set(globalId, legacy);
          migrated += 1;
        }
        await credentialManager.delete(legacyId);
        deleted += 1;
      }
    }
  }
  return { migrated, deleted };
}

export interface ConnectorCredentialMigrationResult {
  /** Rows copied into a plugin slot on this run. */
  copied: number;
  /** Rows skipped: slot already filled, malformed key, or no active install. */
  skipped: number;
  /** Rows whose copy FAILED — left for the next launch; old rows authoritative. */
  failed: number;
}

/**
 * C4 (capability-path plan, ADR § 2): the one-shot COPY of T5's global
 * connector-source credential rows into the plugin MCP slots.
 *
 * `source_{oauth|bearer}::@connector-global::{pluginKey}#{connectorId}#{serverName}`
 * → `plugin_mcp_{oauth|bearer}::{pluginKey}::{serverName}`
 *
 * Iron rules (§ 8, enforced by construction):
 *  - COPY, never move: no source row is deleted or overwritten, ever — a
 *    downgrade finds them intact.
 *  - Copy only into an EMPTY slot: a token refreshed under C is never
 *    clobbered by a later run. Copy-if-absent also makes the migration
 *    idempotent with no marker file.
 *  - NEVER throws: any per-row failure is counted and retried next launch.
 *  - Rows whose pluginKey has no active install are SKIPPED, not purged —
 *    stricter than ADR § 2's stale-row purge sentence (recorded deviation:
 *    the execution plan's iron rule "never deletes a source_oauth/source_bearer
 *    row" wins; the stale purge belongs to the later flag-removal release).
 */
export async function migrateConnectorCredentialsToPluginSlots(args: {
  /** Version-less plugin keys with an ACTIVE install. */
  activePluginKeys: ReadonlySet<string>;
  log?: (message: string) => void;
}): Promise<ConnectorCredentialMigrationResult> {
  const log = args.log ?? (() => {});
  const result: ConnectorCredentialMigrationResult = { copied: 0, skipped: 0, failed: 0 };
  let manager: ReturnType<typeof getCredentialManager>;
  try {
    manager = getCredentialManager();
  } catch {
    return result;
  }
  for (const [sourceType, authType] of [
    ['source_oauth', 'oauth'],
    ['source_bearer', 'bearer'],
  ] as const) {
    let rows: CredentialId[];
    try {
      rows = await manager.list({ type: sourceType, workspaceId: '@connector-global' });
    } catch (error) {
      log(`[plugin-mcp-migration] listing ${sourceType} rows failed: ${error instanceof Error ? error.message : String(error)}`);
      result.failed += 1;
      continue;
    }
    for (const id of rows) {
      if (id.workspaceId !== '@connector-global' || !id.sourceId) continue;
      const parts = id.sourceId.split('#');
      if (parts.length < 3) {
        result.skipped += 1;
        continue;
      }
      const pluginKey = parts[0]!;
      const serverName = parts[parts.length - 1]!;
      if (!pluginKey || !serverName || !args.activePluginKeys.has(pluginKey)) {
        result.skipped += 1;
        continue;
      }
      try {
        const target = pluginMcpCredentialId(authType, pluginKey, serverName);
        const existing = await manager.get(target);
        if (existing) {
          result.skipped += 1;
          continue;
        }
        const legacy = await manager.get(id);
        if (!legacy) {
          result.skipped += 1;
          continue;
        }
        await manager.set(target, legacy);
        result.copied += 1;
      } catch (error) {
        result.failed += 1;
        log(`[plugin-mcp-migration] copy failed for a ${sourceType} row: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (result.copied || result.failed) {
    log(`[plugin-mcp-migration] copied=${result.copied} skipped=${result.skipped} failed=${result.failed}`);
  }
  return result;
}
