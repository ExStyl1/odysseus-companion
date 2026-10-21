/**
 * The WRITE half of the built-in dp MCP set's per-server switch (A7), plus the
 * one payload a settings surface needs to render it.
 *
 * The owner asked for that set "с возможностью включения/отключения". The
 * storage key, its tolerant parser (`builtin-dp-mcp-settings.ts`), the read
 * (`getBuiltinDpMcpServerPreferences` in `storage.ts`) and both runtime folds
 * already existed — and none of them could be reached by a user, because
 * nothing wrote the key. Hand-editing `config.json` was the only way to change
 * it. This module is what an RPC handler calls so a switch in Settings persists.
 *
 * ## The read tolerates unknown names; the write refuses them
 *
 * Not a contradiction — they answer different questions.
 *
 * - READING a map written by a NEWER release must not fail: an unrecognised
 *   name is inert, and a server absent from the map takes its own
 *   `defaultEnabled`. That is `builtin-dp-mcp-settings.ts`'s whole design, and
 *   it is why a built-in added in a later release still arrives at its measured
 *   default for users whose stored map predates it.
 * - WRITING a name no definition claims can only be a bug or a spoofed RPC
 *   payload; accepting it would grow `config.json` with keys that can never do
 *   anything. So `setBuiltinDpMcpServerEnabled` throws, and the tolerant read
 *   stays the only forward-compatibility seam.
 *
 * ## What this module never does
 *
 * It never executes `dp` — availability comes from
 * `materializeBuiltinDpMcpServers`, whose resolver is a filesystem lookup — and
 * it never puts the resolved dp path (or any server command) in the view. A
 * settings page needs to know THAT the set cannot start and why, not where the
 * binary is. It touches no credential file: each dp subprocess authenticates
 * itself, and nothing here reads a token, header or `dp_auth_creds.json`.
 */

import {
  BUILTIN_DP_MCP_SERVERS,
  isBuiltinDpMcpServerEnabled,
  materializeBuiltinDpMcpServers,
  type BuiltinDpMcpDiagnostic,
} from '../mcp/builtin-dp-servers.ts';
import { parseBuiltinDpMcpSettingsV1 } from './builtin-dp-mcp-settings.ts';
import { getBuiltinDpMcpServerPreferences, loadStoredConfig, saveConfig } from './storage.ts';

/** One built-in server as a settings row: what it is, and whether it is on. */
export interface BuiltinDpMcpServerViewV1 {
  /** Wire name — the same name the model sees, and the switch's identity. */
  name: string;
  /** The `dp ai mcp <subcommand>` this server would run. */
  subcommand: string;
  /** dp's own one-line description of the subcommand. */
  description: string;
  /** What this server does when the user has expressed no preference. */
  defaultEnabled: boolean;
  /** The effective state: the stored preference, or `defaultEnabled`. */
  enabled: boolean;
}

/** Everything a settings page renders for the built-in dp set. */
export interface BuiltinDpMcpSettingsViewV1 {
  /**
   * False when `dp` is not installed. The switches still read and write — a
   * preference is a preference — but nothing can start until dp is there, and
   * `diagnostics` says so in words. A surface that hid this would offer a
   * switch that silently does nothing.
   */
  available: boolean;
  /** Operator-facing text. Never a token, header, or path to credentials. */
  diagnostics: BuiltinDpMcpDiagnostic[];
  /** Every built-in, in the set's own stable display order. */
  servers: BuiltinDpMcpServerViewV1[];
}

export interface ReadBuiltinDpMcpSettingsViewOptions {
  /**
   * Where `dp` is, or `null` when it is not installed. Injected by tests; the
   * default is `materializeBuiltinDpMcpServers`' own filesystem lookup, which
   * NEVER executes dp.
   */
  resolveDpPath?: () => string | null;
}

/** True when some definition claims this wire name. */
export function isKnownBuiltinDpMcpServer(name: string): boolean {
  return BUILTIN_DP_MCP_SERVERS.some(definition => definition.name === name);
}

/**
 * The whole set with its effective per-server state and its availability.
 *
 * Deliberately built from `BUILTIN_DP_MCP_SERVERS` rather than from the
 * materialized server map: a disabled server must still appear as a row the
 * user can switch ON, and a machine without dp must still show all 28 rows
 * beside the reason none of them can run.
 */
export function readBuiltinDpMcpSettingsView(
  options: ReadBuiltinDpMcpSettingsViewOptions = {},
): BuiltinDpMcpSettingsViewV1 {
  const enabled = getBuiltinDpMcpServerPreferences();
  const materialized = materializeBuiltinDpMcpServers({
    enabled,
    // Topology-only: the view never carries a server's env, so nothing here
    // needs the dp runtime env, and keeping it empty is what keeps the
    // Bun-child JSON-roundtrip test (`builtin-dp-mcp-settings.test.ts`)
    // host-independent.
    runtimeEnv: {},
    ...(options.resolveDpPath ? { resolveDpPath: options.resolveDpPath } : {}),
  });
  return {
    available: materialized.available,
    diagnostics: materialized.diagnostics,
    servers: BUILTIN_DP_MCP_SERVERS.map(definition => ({
      name: definition.name,
      subcommand: definition.subcommand,
      description: definition.description,
      defaultEnabled: definition.defaultEnabled,
      enabled: isBuiltinDpMcpServerEnabled(definition.name, enabled),
    })),
  };
}

/**
 * Persist one server's switch into `config.json`'s `builtinDpMcpServers.enabled`.
 *
 * Goes through `loadStoredConfig` → `saveConfig` — the same atomic,
 * layout-checked write every other setting uses — never a direct file write.
 * Like every config setter in this codebase it no-ops when there is no
 * `config.json` yet, rather than manufacturing one.
 *
 * Only the named server's entry changes. Names the user has never touched stay
 * ABSENT from the map, which is what keeps them on their own `defaultEnabled`;
 * writing the whole set on every toggle would freeze today's defaults into
 * every user's config and hide every future built-in.
 *
 * Sibling keys inside the `builtinDpMcpServers` block are preserved. Entries
 * whose value is not a literal boolean are dropped, because the loader already
 * reads them as "not set" — normalising them here makes the file say what the
 * app is actually doing.
 *
 * @throws when `name` is not a known built-in, or `enabled` is not a boolean.
 */
export function setBuiltinDpMcpServerEnabled(name: string, enabled: boolean): void {
  if (typeof enabled !== 'boolean') {
    throw new Error('built-in dp MCP server enablement must be a boolean');
  }
  if (!isKnownBuiltinDpMcpServer(name)) {
    throw new Error(`Unknown built-in dp MCP server: ${name}`);
  }
  const config = loadStoredConfig();
  if (!config) return;
  const current = parseBuiltinDpMcpSettingsV1(config.builtinDpMcpServers).enabled ?? {};
  config.builtinDpMcpServers = {
    ...config.builtinDpMcpServers,
    enabled: { ...current, [name]: enabled },
  };
  saveConfig(config);
}
