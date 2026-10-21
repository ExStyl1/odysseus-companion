/**
 * The spelling an administrator writes for a plugin in managed settings, and
 * the one we store.
 *
 * `settings-reference.md#enabledplugins` documents ONE spelling and it is not
 * ours: "Turn individual plugins on or off, keyed by
 * `plugin-name@marketplace-name`", with the type line repeating it — "object
 * mapping `plugin-name@marketplace-name` to a Boolean". Our `PluginKey` is
 * `enc(marketplaceId).enc(pluginId)` (`workspaces/paths.ts`'s `pluginKeyFor`):
 * base64url segments joined by `.`, in the OTHER order, and not something a
 * human writes into a settings file at all.
 *
 * P3.244, measured 2026-09-02 on the tolerant parse: a managed document whose
 * `enabledPlugins` carries the page's own example
 * (`"code-formatter@team-tools": true`, `"experimental-features@personal":
 * false`) parses to `{}` with two `stripped` drops, while the base64url
 * spelling parses with zero. Both directions of the key are lost that way, and
 * the `false` direction is the one that fails OPEN — `settings-reference.md#enabledplugins`
 * gives it teeth ("A plugin set to `false` here is blocked from installation at
 * every scope and hidden from the marketplace") and a stripped entry blocks
 * nothing.
 *
 * So this module accepts BOTH spellings and normalizes to the stored one. It is
 * additive: every key the previous rule accepted still parses to itself, which
 * is what keeps already-deployed policies (and the `allowedPluginKeys` /
 * `deniedPluginKeys` vocabulary the same document uses) working unchanged.
 *
 * The encoding is deliberately NOT imported from `workspaces/paths.ts`: that
 * module reads `CONFIG_DIR` at module scope, and this one is pulled into the
 * managed-policy parser, which runs before a config dir is settled. The two
 * halves are pinned against each other by a test that imports both
 * (`__tests__/managed-plugin-key.test.ts`) rather than by a shared import.
 */

/**
 * Our stored `PluginKey`: two base64url segments joined by a `.` that base64url
 * itself never produces. Unchanged from the rule this module replaces, so a key
 * that parsed before still parses.
 */
const STORED_PLUGIN_KEY = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * The documented spelling. Exactly one `@`, because neither a plugin name nor a
 * marketplace name may contain one: `plugins/manifest-reference.md#fields` calls
 * `name` a "Unique identifier in kebab-case, with no spaces, control characters,
 * or bidirectional-formatting characters", and the page's own examples are
 * `code-formatter@team-tools` and `experimental-features@personal`.
 *
 * The character class is deliberately WIDER than kebab-case — the same page says
 * "Claude Code accepts other forms, but the claude.ai marketplace sync rejects
 * them", so refusing an accepted-but-unfashionable name here would be a
 * narrowing the page does not authorise. What is excluded is what cannot appear
 * in an identifier we then encode into a path segment: whitespace, control
 * characters, path separators, and `@` itself.
 */
const DOCUMENTED_SEGMENT = /^[^\s@/\\\x00-\x1f\x7f]+$/;

/** base64url, matching `pluginKeyFor`'s `encodeSegment`. */
function encodeSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * The stored `PluginKey` for one managed `enabledPlugins` key, or `undefined`
 * when the key is in neither accepted spelling.
 *
 * Length is checked by the CALLER on the key as written, because the caller is
 * what reports the drop and its budget is about the document it read, not about
 * what this function makes of it.
 */
export function normalizeManagedEnabledPluginKey(key: string): string | undefined {
  if (typeof key !== 'string' || key.length === 0) return undefined;
  if (STORED_PLUGIN_KEY.test(key)) return key;
  const at = key.indexOf('@');
  if (at <= 0 || at !== key.lastIndexOf('@')) return undefined;
  const pluginId = key.slice(0, at);
  const marketplaceId = key.slice(at + 1);
  if (!DOCUMENTED_SEGMENT.test(pluginId) || !DOCUMENTED_SEGMENT.test(marketplaceId)) {
    return undefined;
  }
  return `${encodeSegment(marketplaceId)}.${encodeSegment(pluginId)}`;
}

/**
 * Whether a key was written in the documented spelling rather than the stored
 * one. Used only to say so in a diagnostic; the parse itself does not care.
 */
export function isDocumentedPluginKeySpelling(key: string): boolean {
  return typeof key === 'string'
    && !STORED_PLUGIN_KEY.test(key)
    && normalizeManagedEnabledPluginKey(key) !== undefined;
}
