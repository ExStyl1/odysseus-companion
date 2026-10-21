/**
 * What a plugin's LISTING or MANIFEST *declares* it contains — never what it
 * ships.
 *
 * The distinction is the whole point of this module, and both upstream
 * contracts state it in one sentence each:
 *
 * `plugins-reference.md` § Plugin manifest schema — "The manifest is optional.
 * If omitted, Claude Code auto-discovers components in default locations and
 * derives the plugin name from the directory name. Use a manifest when you need
 * to provide metadata or custom component paths."
 * (https://code.claude.com/docs/en/plugins-reference.md)
 *
 * `plugins/build/plugins.md` § Path rules — "If your plugin stores hooks at
 * `./hooks/hooks.json`, you don't need a `hooks` entry in
 * `.codex-plugin/plugin.json`; Codex checks that default file automatically."
 * (https://developers.openai.com/plugins/build/plugins.md)
 *
 * So an ABSENT component field is not an absent component: both loaders fall
 * back to default directories. A declaration is therefore a FLOOR — "at least
 * these kinds" — and a caller may never render it as a complete inventory, nor
 * turn its absence into "this plugin ships nothing".
 *
 * The values are PATHS, not components: `"skills": "./skills/"` names a
 * directory whose contents nobody has read. Kinds are all that can be reported
 * honestly from a declaration; a count never can.
 */

/**
 * A component kind a declaration can name.
 *
 * Claude's marketplace-entry set is `plugin-marketplaces.md` § Optional plugin
 * fields, "Component configuration fields": `skills`, `commands`, `agents`,
 * `hooks`, `mcpServers`, `lspServers`. `workflows` rides on `:195`'s "any field
 * from the plugin manifest schema" (the same terms
 * `MARKETPLACE_ENTRY_PATH_FIELDS` already carries it on). Codex adds `apps`:
 * `plugins/build/plugins.md` § Manifest fields — "`skills`, `mcpServers`, and
 * `hooks` point to bundled components relative to the plugin root. The
 * compatibility `apps` field points to registered MCP server mappings."
 *
 * Claude's manifest schema also has `outputStyles` and `experimental.themes` /
 * `experimental.monitors`. They are deliberately absent: zero of the 2 583
 * catalogued entries and zero of the 59 official manifests sampled 2026-08-01
 * declare one, and a kind we cannot show a label for honestly is worse than a
 * kind we omit.
 */
export type PluginDeclaredComponentKind =
  | 'skill' | 'command' | 'agent' | 'workflow' | 'hook' | 'mcp' | 'lsp' | 'app';

/** Display/serialization order; also the order this module returns kinds in. */
export const PLUGIN_DECLARED_COMPONENT_KINDS: readonly PluginDeclaredComponentKind[] = [
  'skill', 'command', 'agent', 'workflow', 'hook', 'mcp', 'lsp', 'app',
];

/**
 * Declaration field → kind, in report order.
 *
 * `lsp` is accepted alongside `lspServers` for the same reason
 * `format-adapters/claude.ts:315` reads `input.lspServers ?? input.lsp`: the
 * older spelling exists in the wild, and a false "declares nothing" is exactly
 * the defect this module exists to stop.
 */
const DECLARATION_FIELDS: ReadonlyArray<readonly [string, PluginDeclaredComponentKind]> = [
  ['skills', 'skill'],
  ['commands', 'command'],
  ['agents', 'agent'],
  ['workflows', 'workflow'],
  ['hooks', 'hook'],
  ['mcpServers', 'mcp'],
  ['lspServers', 'lsp'],
  ['lsp', 'lsp'],
  ['apps', 'app'],
];

const KIND_VALUES: ReadonlySet<string> = new Set(PLUGIN_DECLARED_COMPONENT_KINDS);

/**
 * A field DECLARES its kind only when it carries something. `null`, `""`, `[]`
 * and `{}` are all "the author wrote the key and put nothing in it" — reporting
 * a kind for those would manufacture the same false claim from the other side.
 */
function isDeclared(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(entry => entry !== undefined && entry !== null);
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return false;
}

/**
 * The component kinds a manifest-shaped record declares, deduplicated and in
 * {@link PLUGIN_DECLARED_COMPONENT_KINDS} order. Anything that is not a plain
 * object declares nothing.
 */
export function declaredPluginComponentKinds(fields: unknown): PluginDeclaredComponentKind[] {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return [];
  const record = fields as Record<string, unknown>;
  const found = new Set<PluginDeclaredComponentKind>();
  for (const [field, kind] of DECLARATION_FIELDS) {
    if (isDeclared(record[field])) found.add(kind);
  }
  return PLUGIN_DECLARED_COMPONENT_KINDS.filter(kind => found.has(kind));
}

/**
 * Keep only real declared-kind tokens from a free-form capability list, in
 * report order. `MarketplaceCatalogItem.capabilities` is a mixed bag by design
 * — Skills Market rows put MCP server names (`linear`) and hook ids (`pretool`)
 * there — so a consumer that wants KINDS has to filter rather than assume.
 */
export function pluginDeclaredComponentKindsFrom(
  capabilities: readonly string[] | undefined,
): PluginDeclaredComponentKind[] {
  if (!capabilities?.length) return [];
  const present = new Set(capabilities.filter(value => KIND_VALUES.has(value)));
  return PLUGIN_DECLARED_COMPONENT_KINDS.filter(kind => present.has(kind));
}
