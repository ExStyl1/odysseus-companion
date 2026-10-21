/**
 * Plugin-shipped output styles, read from the pinned bundle.
 *
 * `output-styles.md:83` — "Plugins can also ship output styles in an
 * `output-styles/` directory". The file is read HERE rather than in
 * `prompts/output-styles.ts` because reading a plugin file belongs behind the
 * snapshot lease that proved the bundle hash: `readText` verifies the bundle and
 * re-asserts the lease, so a style cannot be swapped under a live turn. The
 * prompt module stays a pure parser over content it is handed.
 *
 * Nothing here APPLIES a style. It produces the candidate list the picker offers
 * and the prompt builder resolves a user selection against; `force-for-plugin`
 * (`output-styles.md` § Frontmatter) is recorded by the adapter, refused to the
 * author by name (`plugin.format.claude_output_style_force_unsupported`) and
 * never honoured — a PERMANENT refusal since P6.513, not a not-yet. A style that
 * declared it still arrives here as an ordinary candidate, which is the whole of
 * what the refusal costs the plugin: one selection by the user.
 */

import type { PluginOutputStyleSource } from '../prompts/output-styles.ts';
import type { CapabilitySnapshotMaterializer } from './materializer.ts';
import type { EffectiveCapabilitySnapshot, RuntimeOutputStyleDefinition } from './resolver.ts';

/** Plugin display names keyed by active instance id, for the picker's provenance line. */
export function pluginNamesByInstanceId(
  snapshot: EffectiveCapabilitySnapshot,
): ReadonlyMap<string, string> {
  return new Map(snapshot.installedPlugins.map(plugin => [plugin.activeInstanceId, plugin.name]));
}

/**
 * Read every runnable plugin style in this snapshot. A style whose file cannot be
 * read is SKIPPED rather than failing the turn: an unreadable style is one
 * missing option, while an exception here would take down prompt composition for
 * every session that has the plugin installed.
 */
export async function readPluginOutputStyleSources(
  styles: readonly RuntimeOutputStyleDefinition[],
  materializer: CapabilitySnapshotMaterializer,
  pluginNames?: ReadonlyMap<string, string>,
): Promise<PluginOutputStyleSource[]> {
  const sources: PluginOutputStyleSource[] = [];
  for (const style of styles) {
    let content: string;
    try {
      content = await materializer.readText(style.resource);
    } catch {
      continue;
    }
    const pluginName = pluginNames?.get(style.pluginInstanceId);
    sources.push({
      id: style.styleId,
      content,
      fallbackLabel: style.name,
      ...(pluginName ? { pluginName } : {}),
    });
  }
  return sources;
}
