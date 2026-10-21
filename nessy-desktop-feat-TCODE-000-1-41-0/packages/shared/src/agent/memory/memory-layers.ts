import { basename } from 'node:path';
import { memoryIndexLoadedContent } from '@nessy-agent/session-tools-core';
import { MEMORY_FILE_NAME, isMemoryIndexLayer } from './memory-store.ts';
import {
  expandMemoryImports,
  resolveMemoryImportPath,
  stripBlockHtmlComments,
} from './memory-imports.ts';

/**
 * The shape both live memory deliveries share: a runtime memory layer.
 * Structural on purpose, so this module stays out of the capability-view import
 * graph that `memory-store.ts` also avoids.
 */
export interface MemoryLayerLike {
  format?: 'rule';
  importParentPath?: string;
  /**
   * `contentHash` is not read here. It is in the shape so this stays a normal
   * structural type rather than a WEAK one: with `absolutePath` alone as the
   * only (optional) member, TypeScript's weak-type check rejects a
   * `PluginBundleResourceRef` — which carries no `absolutePath` — and a prompt
   * layer's resource is exactly that union. Both members carry `contentHash`.
   */
  resource: { absolutePath?: string; contentHash?: string };
}

export interface ComposedMemoryLayers<L> {
  /** Each layer's file as stored, read exactly once. */
  raw: Map<L, string>;
  /** The body to DELIVER, for every layer that ships on its own. */
  bodies: Map<L, string>;
  /** Layers whose body was spliced into an importer and must not ship twice. */
  inlined: Set<L>;
  /**
   * Auto-memory TOPIC files, withheld from the startup context (P6.387).
   *
   * `memory.md`, verbatim: *"Claude Code doesn't load topic files such as
   * `user_role.md` or `feedback_testing.md` at startup. Claude reads them on
   * demand using its standard file tools when it needs the information."*
   *
   * Their body is `''` in {@link bodies} rather than absent, which is what makes
   * this backward-compatible at both live deliveries: an empty body is already
   * the "nothing to ship" case both of them handle, and `undefined` would make
   * Pi's `addPinned` fall back to re-reading the file from disk — loading
   * exactly what this withholds.
   */
  deferred: Set<L>;
}

/**
 * The auto-memory topic files in this layer set (P6.387).
 *
 * ## The discriminator, and why it is the IMPORTER's name
 *
 * This fork has no auto-memory DIRECTORY — `session-tools-core/memory-index.ts`
 * says so where it adapts the vendor's over-limit message: *"'topic files'
 * becomes the `@path` import because this fork has no memory DIRECTORY"*. So
 * the local shape of a topic file is a file an auto-memory INDEX imports, and
 * the index is `MEMORY.md`.
 *
 * The page draws exactly this line and draws it twice, in opposite directions:
 *
 * - `memory.md:95` — *"CLAUDE.md files can import additional files using
 *   `@path/to/import` syntax. Imported files are expanded and loaded into
 *   context at launch alongside the CLAUDE.md that references them."*
 * - `memory.md` §*How it works* — *"Claude Code doesn't load topic files such as
 *   `user_role.md` or `feedback_testing.md` at startup."*
 *
 * Two sentences, two families, one mechanism. An `@path` in a CLAUDE.md /
 * AGENTS.md is loaded; an `@path` in a MEMORY.md names a topic file and is not.
 * Before this, both were eager and by TWO routes — inlined into the importer's
 * body, and, when the token did not survive the index cut, shipped on its own by
 * the second pass below.
 *
 * Transitive, because a topic file may import another: reaching a MEMORY.md
 * through a chain of topic files is still reaching a MEMORY.md. A `format:
 * 'rule'` layer is never a topic file — a rule's load semantics are its
 * `paths:` frontmatter's, not the index's.
 */
function deferredTopicFiles<L extends MemoryLayerLike>(
  layers: readonly L[],
  byAbsolutePath: ReadonlyMap<string, L[]>,
): Set<L> {
  const deferred = new Set<L>();
  // Fixed point rather than a recursive walk: the chain is at most
  // `MEMORY_IMPORT_DEPTH_LIMIT` deep and the layer list is small, so repeating
  // until nothing changes costs less than the bookkeeping a walk would need to
  // stay cycle-safe.
  for (let pass = 0; pass < layers.length; pass += 1) {
    let changed = false;
    for (const layer of layers) {
      if (deferred.has(layer) || layer.format === 'rule') continue;
      const importer = layer.importParentPath;
      if (!importer) continue;
      const importerIsIndex = basename(importer) === MEMORY_FILE_NAME
        || (byAbsolutePath.get(importer) ?? []).some(parent => deferred.has(parent));
      if (!importerIsIndex) continue;
      deferred.add(layer);
      changed = true;
    }
    if (!changed) break;
  }
  return deferred;
}

/**
 * Compose every pinned layer's delivered body for one capability generation —
 * instruction layers (`view.promptLayers`) and memory layers (`view.memory`)
 * TOGETHER, in one call, which is what R77 needs and R55 did not have.
 *
 * THE seam both live deliveries call — `BaseAgent.composePinnedCapabilityContext`
 * and `materializePiContextResources`. R33 put the 200-line / 25 KB caps on both
 * because capping one "would ship two different bodies for one file"; import
 * expansion and comment stripping are the same invariant, and before this the
 * two disagreed outright: the pinned block DELETED every line an import was
 * recognised on, and Pi's curated resource shipped the literal `@path` as prose.
 * Neither expanded anything.
 *
 * ## The dedupe-and-order rule (R77), which is the whole unit
 *
 * `memory.md:95` is about the CLAUDE.md family, and the page's own flagship
 * shape is a `CLAUDE.md` whose body is `@AGENTS.md` — this repo's
 * `packages/shared/CLAUDE.md` is literally that file. But `AGENTS.md` is
 * discovered as its OWN root instruction record, before `CLAUDE.md` is walked,
 * so the one-file-one-record `seen` set gives that token no child to resolve
 * against. Resolving only against DECLARED children — the R55 rule — therefore
 * ships the literal `@AGENTS.md` and closes nothing, with every test green.
 *
 * So a token resolves in three steps, and step 2 is the new one:
 * 1. a declared child of this importer at the target path (R55, unchanged);
 * 2. otherwise ADOPT a root layer already in this view at that path — it is the
 *    same file, discovered by another pass, and the import is what decides
 *    WHERE it is delivered. The adopted layer is marked inlined, so it ships
 *    exactly once, inside its importer, instead of twice;
 * 3. otherwise, if the layer at that path was already inlined by someone else,
 *    the token resolves to an EMPTY body: the bytes are already in this
 *    generation's prompt, and leaving the raw `@path` behind would tell the
 *    model about a file while showing it nothing.
 * A token with no layer at all behind it is left exactly as written (R55: a
 * user's Sources-level disable is not reached around by re-reading disk).
 *
 * Two narrowings, recorded rather than silent:
 * - a `format: 'rule'` layer is never ADOPTED. Its body needs `unscopedRuleBody`
 *   and its `paths:` frontmatter decides whether it loads at all; splicing one
 *   into a CLAUDE.md would promote a path-scoped rule to an unconditional one.
 *   A declared child is unaffected — the walker never registers a rule file as
 *   an instruction import (`native-sources.ts`).
 * - adoption moves the adopted body to the IMPORTER's position in the layer
 *   order. For the flagship that is one slot inside the same tier
 *   (`AGENTS.md` → `CLAUDE.md`), and `memory.md:95` puts an imported file
 *   "alongside the CLAUDE.md that references them", so the importer's position
 *   is the documented one.
 *
 * Order is deliberate and load-bearing:
 * 1. strip YAML frontmatter and block-level HTML comments — `memory.md:388`
 *    puts BOTH before the measurement ("YAML frontmatter and block-level HTML
 *    comments are stripped before the index is loaded, so they don't count
 *    toward the limits");
 * 2. apply the index caps — measured on the file AS WRITTEN;
 * 3. expand imports LAST. Measuring after expansion would let one `@path` line
 *    silently spend the whole 200-line / 25 KB budget on a file the cap was
 *    never sized for.
 *
 * The FRONTMATTER strip is the index's alone (`isMemoryIndexLayer`), and that
 * gate is not cosmetic: a `.agents/rules` file carries its `paths:` globs in
 * frontmatter, and stripping it there would promote every path-scoped rule to an
 * unconditional one. It also has a second, load-bearing effect the write side
 * depends on — the `modified` timestamp `stampMemoryModified` refreshes on every
 * write (`memory.md:398`) never reaches the pinned block, so it cannot be the
 * changing line that invalidates a cached prefix on each memory write.
 *
 * Expansion here reads the VIEW, never the disk. An imported file is already its
 * own capability record (`native-sources.ts` walks imports, `resolver.ts` carries
 * `importParentPath` onto the layer), so it already has a Sources entry the user
 * can disable and an `InstructionsLoaded` payload naming its importer. Resolving
 * against the view keeps all of that true: a disabled import is absent from the
 * view, so its token stays unresolved instead of being re-read from disk behind
 * the user's decision. It is also why an inlined child must be suppressed as a
 * standalone layer — otherwise its body ships twice in one prompt.
 */
export async function composeMemoryLayerBodies<L extends MemoryLayerLike>(
  layers: readonly L[],
  readText: (layer: L) => Promise<string>,
): Promise<ComposedMemoryLayers<L>> {
  const raw = new Map<L, string>();
  for (const layer of layers) raw.set(layer, await readText(layer));

  const prepared = new Map<L, string>();
  for (const layer of layers) {
    const body = raw.get(layer) ?? '';
    prepared.set(
      layer,
      isMemoryIndexLayer(layer) ? memoryIndexLoadedContent(body) : stripBlockHtmlComments(body),
    );
  }

  const childrenByImporter = new Map<string, L[]>();
  for (const layer of layers) {
    const importer = layer.importParentPath;
    if (!importer || !layer.resource.absolutePath) continue;
    const bucket = childrenByImporter.get(importer);
    if (bucket) bucket.push(layer);
    else childrenByImporter.set(importer, [layer]);
  }

  // Every layer by the file it IS, so a token can find a sibling that no
  // importer declared — see step 2 of the resolution rule above.
  const byAbsolutePath = new Map<string, L[]>();
  for (const layer of layers) {
    const path = layer.resource.absolutePath;
    if (!path) continue;
    const bucket = byAbsolutePath.get(path);
    if (bucket) bucket.push(layer);
    else byAbsolutePath.set(path, [layer]);
  }

  const deferred = deferredTopicFiles(layers, byAbsolutePath);

  const inlined = new Set<L>();
  const bodies = new Map<L, string>();
  const inProgress = new Set<L>();
  /**
   * Memoized because a layer can now be expanded twice: once for its own
   * delivery and once as an adopted import. Without this the second pass sees
   * its own children already inlined and would compose the SAME file with its
   * imports resolved to empty — the body that ships would silently lose them.
   */
  const expansions = new Map<L, string>();

  const expand = (layer: L): string => {
    const cached = expansions.get(layer);
    if (cached !== undefined) return cached;
    const text = prepared.get(layer) ?? '';
    const own = layer.resource.absolutePath;
    // No path means nothing can name it as an importer, and re-entry means the
    // record walker handed us a cycle it normally dedupes — stop either way.
    if (!own || inProgress.has(layer)) return text;
    inProgress.add(layer);
    const children = childrenByImporter.get(own) ?? [];
    const expanded = expandMemoryImports(text, own, (importerFilePath, token) => {
      const target = resolveMemoryImportPath(importerFilePath, token.path);
      const candidate = children.find(child => child.resource.absolutePath === target)
        ?? (byAbsolutePath.get(target) ?? []).find(sibling => (
          sibling !== layer
          && sibling.importParentPath === undefined
          && sibling.format !== 'rule'
        ));
      if (!candidate) return null;
      // A topic file is NOT spliced in. `null` leaves the `@path` line exactly
      // as the author wrote it, which is the affordance the page describes —
      // the model can see the file's name and read it with its standard file
      // tools when it needs the information. Dropping the token instead would
      // withhold the file AND hide that it exists.
      if (deferred.has(candidate)) return null;
      // Already delivered inside some importer this generation: drop the token
      // rather than ship the bytes twice or leave the literal `@path` behind.
      if (inlined.has(candidate)) return { path: target, body: '' };
      inlined.add(candidate);
      return { path: target, body: expand(candidate) };
    });
    inProgress.delete(layer);
    expansions.set(layer, expanded);
    return expanded;
  };

  for (const layer of layers) {
    if (layer.importParentPath) continue;
    bodies.set(layer, expand(layer).trim());
  }
  // An imported layer whose token did not survive into the composed body — the
  // recorded case is a `@path` line sitting past the 25 KB cut, which still
  // produces a record (discovery is deliberately uncapped, `native-sources.ts`)
  // — ships on its own rather than vanishing.
  for (const layer of layers) {
    if (bodies.has(layer) || inlined.has(layer)) continue;
    // The SECOND eager route, and the one nobody had noticed: a topic file
    // whose token did not survive the index cut used to ship on its own here.
    // An empty body, never a missing entry — see `deferred`'s docblock.
    bodies.set(layer, deferred.has(layer) ? '' : expand(layer).trim());
  }

  return { raw, bodies, inlined, deferred };
}
