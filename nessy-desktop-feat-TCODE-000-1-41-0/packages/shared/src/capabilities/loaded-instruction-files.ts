/**
 * P6.397 — which instruction and memory files actually loaded, composed ONCE
 * for every runtime.
 *
 * `debug-your-config.md#see-what-loaded-into-context` makes `/context` the
 * surface for what loaded, and until this module only a Pi session could answer:
 * `ContextUsageSnapshot` had exactly one producer then
 * (`pi-agent-server/src/context-categories.ts`) — claude writes one too since, on `/context`
 * and at a compaction boundary (F1.460 (13)), with no `loadedFiles` — and codex reports a
 * window through `thread/tokenUsage/updated` and nothing per-category. So the
 * denominator's L53 read `pi have / claude absent / codex absent` for a fact
 * that is not per-runtime at all: the instruction and memory LAYERS are resolved
 * by the host's capability walk and are identical on all three.
 *
 * ## Why this is a composer and not a second derivation
 *
 * The list Pi shows is `view.promptLayers` + `view.memory`, run through
 * {@link composeMemoryLayerBodies} — which owns the 200-line/25 KB memory-index
 * cap, the block-HTML-comment strip and `@path` expansion — with the layer KEY
 * as the name and `estimateTokens` over the DELIVERED body as the size. Every
 * one of those is repeated here by CALLING the same functions, never by
 * restating them: a second spelling of the inlining rule would make claude's
 * `/context` disagree with Pi's about the same workspace, which is exactly the
 * silent divergence this row exists to remove.
 *
 * ## Why its own module rather than `instruction-files.ts`
 *
 * That module's header states a load-bearing weight constraint — a leaf whose
 * only imports are `node:fs` and `node:path`, because
 * `pi-agent-server/src/orchestrator/*` reaches it through `agents/index.ts`.
 * This composer needs the memory composer and the token estimator, so putting it
 * there would drag both into that graph. Separate file, same neighbourhood.
 */

import type { ContextUsageLoadedFile } from '@nessy-agent/core/types';
import { composeMemoryLayerBodies, type MemoryLayerLike } from '../agent/memory/memory-layers.ts';
import { estimateTokens } from '../utils/large-response.ts';

/** The half of a runtime layer this composer reads: its identity and its file. */
export interface LoadedInstructionLayer extends MemoryLayerLike {
  /**
   * The layer identity Pi reports as the file's NAME. Pi derives it from a
   * descriptor `provenance` of `` `${key}@${generation}` `` and slices the
   * generation back off; this side has the key itself, which is the same string
   * by construction.
   */
  key: string;
}

/**
 * Compose the `/context` loaded-files group from a runtime view's instruction
 * and memory layers.
 *
 * `promptLayers` are the INSTRUCTION kind and `memory` the MEMORY kind, matching
 * the Pi producer's own mapping (`agent-instruction` → `instruction`, everything
 * else → `memory`), and the two lists are composed TOGETHER in one call for the
 * reason `materializePiContextResources` records: an instruction file's `@path`
 * import can name a sibling the inventory already discovered, and only a pass
 * that sees both lists can decide once which delivery carries that body.
 *
 * A layer whose body was spliced into an importer is DROPPED, not listed with
 * zero tokens: it does not ship on its own, and a row for it would double-count
 * the same bytes the importer's row already carries.
 *
 * `readText` is the caller's materializer. A read that throws is the caller's to
 * handle — this composer has no way to tell a missing file from a revoked lease,
 * and inventing a zero-token row for either would report a file as loaded that
 * is not.
 */
export async function composeLoadedInstructionFiles<
  // TWO parameters, not one: a runtime view's instruction layers and its memory
  // handles are different shapes (only the first carries `order`), and unifying
  // them here would make the caller's own two lists fail to infer.
  Instruction extends LoadedInstructionLayer,
  Memory extends LoadedInstructionLayer,
>(input: {
  readonly promptLayers: readonly Instruction[];
  readonly memory: readonly Memory[];
  readonly readText: (layer: Instruction | Memory) => Promise<string>;
}): Promise<ContextUsageLoadedFile[]> {
  const layers: (Instruction | Memory)[] = [...input.promptLayers, ...input.memory];
  if (layers.length === 0) return [];
  const composed = await composeMemoryLayerBodies(layers, input.readText);
  const instruction = new Set<Instruction | Memory>(input.promptLayers);
  const files: ContextUsageLoadedFile[] = [];
  for (const layer of layers) {
    if (composed.inlined.has(layer)) continue;
    files.push({
      name: layer.key,
      kind: instruction.has(layer) ? 'instruction' : 'memory',
      tokens: estimateTokens(composed.bodies.get(layer) ?? ''),
    });
  }
  return files;
}
