/**
 * F1.1262 (origin SIT2-e D-18) — the model is TOLD which workspace, project and plugin agents the `subagent` tool can
 * run, by name and description, as Claude's `Agent` tool lists its agent types. Measured at the final sitting: a
 * project agent's name and description never reached the Pi model, so "Run the one-turn subagent" picked `fork`;
 * running it by its name worked (F1.730), so this is discoverability, not access.
 *
 * Where it rides: the host prompt's appendix, beside the deferred-tool summary (`withDeferredToolSummary`,
 * `deferred-tool-summary.ts`), and for the same reason F1.197 gives there: the `subagent` tool's model contract is
 * hash-pinned (`PI_STATIC_MODEL_CONTRACT_HASHES`), so a per-session list inside its description would fail
 * `projectPiManifestTools` on every session. Bounded: at most {@link MAX_LISTED} agents, each description cut at
 * {@link MAX_DESCRIPTION} characters, with a line saying how many more exist. Set when the session's definition is
 * built, from the same runtime definitions the tool resolves `agent` names against; empty (no block) when the
 * session offers no `subagent` tool.
 */

const MAX_LISTED = 30;
const MAX_DESCRIPTION = 200;

let catalogue: ReadonlyArray<{ name: string; description: string }> = [];

/** Record the agents of the session just built; `[]` when it offers no `subagent` tool. */
export function setSubagentCatalogue(definitions: ReadonlyArray<{ name: string; description?: string; fork?: true }>): void {
  const byName = new Map<string, string>();
  for (const definition of definitions) {
    if (definition.fork || typeof definition.name !== 'string' || !definition.name) continue;
    if (!byName.has(definition.name)) byName.set(definition.name, oneLine(definition.description ?? ''));
  }
  catalogue = [...byName].sort(([a], [b]) => a.localeCompare(b)).map(([name, description]) => ({ name, description }));
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1)}…` : flat;
}

/** The block itself, or `''` when there is no agent to list. */
export function renderSubagentCatalogue(): string {
  if (catalogue.length === 0) return '';
  const listed = catalogue.slice(0, MAX_LISTED);
  return [
    '<available-subagents>',
    'Besides its built-in agents, the subagent tool can run these agents; pass the name as `agent`.',
    ...listed.map(entry => (entry.description ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`)),
    ...(catalogue.length > listed.length ? [`(${catalogue.length - listed.length} more not listed.)`] : []),
    '</available-subagents>',
  ].join('\n');
}
