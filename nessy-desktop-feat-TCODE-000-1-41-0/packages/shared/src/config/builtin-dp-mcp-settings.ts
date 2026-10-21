/**
 * Per-server on/off for the built-in dp-backed MCP set (A7).
 *
 * The owner asked for that set "с возможностью включения/отключения" — with the
 * ability to enable and disable. This is the persisted half of that switch: the
 * `builtinDpMcpServers.enabled` block of `config.json`, read into
 * `MaterializeBuiltinDpMcpOptions.enabled` by
 * `getBuiltinDpMcpServerPreferences()` in `config/storage.ts`.
 *
 * ```json
 * { "builtinDpMcpServers": { "enabled": { "dpSage": false, "dpMail": true } } }
 * ```
 *
 * ## Why this layer knows nothing about the server set
 *
 * It deliberately does NOT import `BUILTIN_DP_MCP_SERVERS`, and it validates no
 * name. Two forward-compatibility rules depend on that, and both point the same
 * way — a stored map is a record of what the user TOUCHED, never a census of
 * what exists:
 *
 * 1. **An unknown name is ignored, not an error.** A map written by a newer
 *    release (or a hand-edit with a typo) must not reject the layer, take the
 *    config loader down, or silently lose the entries around it. Names that no
 *    definition claims simply never get looked up —
 *    `isBuiltinDpMcpServerEnabled` resolves against the definition list, so an
 *    unrecognised key cannot conjure a server.
 * 2. **A server absent from the map takes its own `defaultEnabled`.** A
 *    built-in added in a later release must arrive at its measured default for
 *    users whose stored map predates it. Treating "absent" as "off" would mean
 *    every existing user silently misses every future built-in — the failure
 *    mode is invisible, because a map that was complete when it was written
 *    still looks complete.
 *
 * So the only judgement here is on VALUES: an entry is honoured when it is a
 * literal JSON boolean, and dropped otherwise, which lands a `"false"` string
 * on the definition default instead of on the truthiness of a non-empty string.
 *
 * The parse is tolerant like the `sources`/`worktree`/`workflow` layers: a
 * malformed block yields an empty layer, so a bad edit falls back to the
 * per-definition defaults rather than wedging startup.
 */

/** The `builtinDpMcpServers` block of `config.json` — the USER layer. */
export interface BuiltinDpMcpSettingsV1 {
  /**
   * Wire name → on/off, for servers the user has explicitly switched. Names
   * absent here keep their definition's `defaultEnabled`; names no definition
   * claims are inert.
   */
  readonly enabled?: Readonly<Record<string, boolean>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Tolerant parse of the user `builtinDpMcpServers` layer.
 *
 * Only literal booleans survive; every other value is read as "not set" so the
 * server falls back to its `defaultEnabled`. Names are passed through
 * unexamined — see this module's header for why.
 */
export function parseBuiltinDpMcpSettingsV1(value: unknown): BuiltinDpMcpSettingsV1 {
  if (!isPlainObject(value)) return {};
  const rawEnabled = value.enabled;
  if (!isPlainObject(rawEnabled)) return {};
  const enabled: Record<string, boolean> = {};
  for (const [name, flag] of Object.entries(rawEnabled)) {
    if (name === '__proto__') continue;
    if (typeof flag === 'boolean') enabled[name] = flag;
  }
  return { enabled };
}
