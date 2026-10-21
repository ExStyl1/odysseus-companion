/**
 * The merged-config cache key must cover the PINNED LAYERS' CONTENT.
 *
 * `buildCacheKey` hashed the workspace, the source slugs, the pinned
 * *revision*, trust, the managed digest, the session digest and the
 * managed-only lock — but never `pinnedConfigs` themselves. Two consequences,
 * both reproduced below before the fix:
 *
 *  - same workspace + same `pinnedRevision` + DIFFERENT pinned content was
 *    served one cached merged config (identical object);
 *  - with NO `pinnedRevision`, `?? ''` collapsed the revision segment, so every
 *    pinned-config context on one workspace collided.
 *
 * The second shape is what produced a FALSE GREEN in P2.39's first test draft:
 * a `blockedTools` assertion "passed" against a merge built from a different
 * layer entirely.
 */
import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shouldAllowToolInMode } from '../mode-manager.ts'
import {
  permissionsConfigCache,
  type MergedPermissionsConfig,
  type NormalizedPermissionsContext,
  type PermissionsContext,
  type PermissionsCustomConfig,
} from '../permissions-config.ts'

const workspaceRootPath = mkdtempSync(join(tmpdir(), 'nessy-cache-key-'))

/** A complete `PermissionsCustomConfig` with only the named fields varied. */
function layer(overrides: Partial<PermissionsCustomConfig> = {}): PermissionsCustomConfig {
  return {
    allowedBashPatterns: [],
    allowedMcpPatterns: [],
    allowedApiEndpoints: [],
    allowedWritePaths: [],
    deniedPaths: [],
    deniedToolPatterns: [],
    allowedTools: [],
    disallowedTools: [],
    toolRules: [],
    blockedTools: [],
    blockedCommandHints: [],
    ...overrides,
  }
}

function merged(context: Partial<PermissionsContext>) {
  return permissionsConfigCache.getMergedConfig({
    workspaceRootPath,
    ...context,
  } as PermissionsContext)
}

describe('the merged-config cache key covers pinned content', () => {
  it('same revision + different pinned content is not served one entry', () => {
    const base = { workspaceRootPath, pinnedRevision: 'gen-same' }
    const first = merged({
      ...base,
      pinnedConfigs: [{ config: layer({ allowedWritePaths: ['first/**'] }), scope: 'workspace' }],
    })
    const second = merged({
      ...base,
      pinnedConfigs: [{ config: layer({ allowedWritePaths: ['second/**'] }), scope: 'workspace' }],
    })

    expect(second).not.toBe(first)
    expect(first.allowedWritePaths).toContain('first/**')
    expect(second.allowedWritePaths).toContain('second/**')
    expect(second.allowedWritePaths).not.toContain('first/**')
  })

  it('no revision + different pinned content is not served one entry', () => {
    // With `pinnedRevision` absent the revision segment was `''` for every
    // context, so ALL pinned-config contexts on this workspace collided.
    const first = merged({
      pinnedConfigs: [{ config: layer({ allowedWritePaths: ['unpinned-first/**'] }), scope: 'workspace' }],
    })
    const second = merged({
      pinnedConfigs: [{ config: layer({ allowedWritePaths: ['unpinned-second/**'] }), scope: 'workspace' }],
    })

    expect(second).not.toBe(first)
    expect(first.allowedWritePaths).toContain('unpinned-first/**')
    expect(second.allowedWritePaths).toContain('unpinned-second/**')
    expect(second.allowedWritePaths).not.toContain('unpinned-first/**')
  })

  it('the false green P2.39 hit: a declared blockedTools list is not another layer\'s', () => {
    const base = { workspaceRootPath, pinnedRevision: 'gen-blocked' }
    const alpha = merged({
      ...base,
      pinnedConfigs: [{ config: layer({ blockedTools: ['AlphaTool'] }), scope: 'workspace' }],
    })
    const beta = merged({
      ...base,
      pinnedConfigs: [{ config: layer({ blockedTools: ['BetaTool'] }), scope: 'workspace' }],
    })

    expect(alpha.blockedTools.has('AlphaTool')).toBe(true)
    expect(beta.blockedTools.has('BetaTool')).toBe(true)
    // The false green: `beta` was `alpha`, so this read as a pass on the wrong
    // object while the second layer's list had never been applied at all.
    expect(beta.blockedTools.has('AlphaTool')).toBe(false)
  })

  it('the layer slug and scope are part of the identity too', () => {
    const base = { workspaceRootPath, pinnedRevision: 'gen-scope' }
    const config = layer({ allowedWritePaths: ['scoped/**'] })
    const asWorkspace = merged({ ...base, pinnedConfigs: [{ config, scope: 'workspace' }] })
    const asManaged = merged({ ...base, pinnedConfigs: [{ config, scope: 'managed' }] })
    const asPlugin = merged({ ...base, pinnedConfigs: [{ config, sourceSlug: 'linear', scope: 'plugin' }] })

    expect(asManaged).not.toBe(asWorkspace)
    expect(asPlugin).not.toBe(asWorkspace)
  })

  it('an absent pinnedConfigs is not the same identity as an empty one', () => {
    // They take different branches: `[]` short-circuits to the bare merge,
    // `undefined` falls through to the default/workspace/source loaders.
    const base = { workspaceRootPath, pinnedRevision: 'gen-empty' }
    expect(merged({ ...base, pinnedConfigs: [] })).not.toBe(merged({ ...base }))
  })

  it('identical inputs still HIT the cache', () => {
    // A key that never collides is not a fix if it also never hits.
    const context = {
      workspaceRootPath,
      pinnedRevision: 'gen-hit',
      pinnedConfigs: [{ config: layer({ allowedWritePaths: ['hit/**'] }), scope: 'workspace' as const }],
    }
    const first = merged(context)
    const second = merged({
      ...context,
      // A structurally equal but distinct layer object: the key is content, not
      // reference identity, so this must be the SAME cached entry.
      pinnedConfigs: [{ config: layer({ allowedWritePaths: ['hit/**'] }), scope: 'workspace' }],
    })

    expect(second).toBe(first)
  })

  it('a hit survives a different key ORDER in the layer objects', () => {
    // This is why the digest is `canonicalJson` and not `JSON.stringify`:
    // stringify serializes keys in insertion order, so two equal configs built
    // by different code paths would miss forever and the cache would degrade
    // into a leak. `canonicalJson` sorts keys at every level.
    const first = merged({
      pinnedRevision: 'gen-order',
      pinnedConfigs: [{
        config: layer({ allowedWritePaths: ['order/**'], deniedPaths: ['secret/**'] }),
        scope: 'workspace',
      }],
    })
    const reordered: PermissionsCustomConfig = {
      blockedCommandHints: [],
      blockedTools: [],
      toolRules: [],
      disallowedTools: [],
      allowedTools: [],
      deniedToolPatterns: [],
      deniedPaths: ['secret/**'],
      allowedWritePaths: ['order/**'],
      allowedApiEndpoints: [],
      allowedMcpPatterns: [],
      allowedBashPatterns: [],
    }
    const second = merged({
      pinnedRevision: 'gen-order',
      pinnedConfigs: [{ config: reordered, scope: 'workspace' }],
    })

    expect(second).toBe(first)
  })
})

/**
 * P2.52 — `invalidateSource` must reach EVERY active slug.
 *
 * The sources segment of the key was `activeSourceSlugs.sort().join(',')` and
 * the `::revision::trust::…` tail was appended straight onto it, so splitting
 * the whole tail on `,` left the LAST comma-element carrying that tail — it
 * never compared equal to its own slug. Invalidation therefore reached every
 * slug EXCEPT the lexicographically last, and with a SINGLE active source it
 * reached nothing, ever. (It is NOT "only the first slug is invalidated"; that
 * wording was corrected before this row shipped.)
 *
 * Each row below writes REAL `sources/<slug>/permissions.json` files and edits
 * one of them, which is the user-visible bug: `SessionManager.assertCdRulesPermit`
 * builds a context with `activeSourceSlugs` and no `pinnedConfigs`, so a `/cd`
 * gate could answer from a merge built before the edit. The rows that invalidated
 * correctly before the fix are kept as positive controls on the same rig — an
 * "it is stale" row proves nothing if the probe itself cannot observe an edit.
 */
describe('invalidateSource reaches every active slug', () => {
  /** Write `<root>/sources/<slug>/permissions.json` declaring one blocked tool. */
  function writeSourcePermissions(root: string, slug: string, blockedTool: string): void {
    const dir = join(root, 'sources', slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'permissions.json'), `${JSON.stringify({ blockedTools: [blockedTool] })}\n`, 'utf-8')
  }

  const CASES: Array<{ name: string, slugs: string[], edited: string, preFix: 'invalidated' | 'stale' }> = [
    // The total-failure case: one slug is also the LAST slug.
    { name: 'a single active source', slugs: ['solo'], edited: 'solo', preFix: 'stale' },
    { name: 'two sources, the first edited', slugs: ['alpha', 'beta'], edited: 'alpha', preFix: 'invalidated' },
    { name: 'two sources, the last edited', slugs: ['alpha', 'beta'], edited: 'beta', preFix: 'stale' },
    // The sort runs first, so DECLARATION order is not what decides: `zeta` is
    // declared first and is still the lexicographically last element.
    { name: 'unsorted input, the lexicographically first edited', slugs: ['zeta', 'alpha'], edited: 'alpha', preFix: 'invalidated' },
    { name: 'unsorted input, the lexicographically last edited', slugs: ['zeta', 'alpha'], edited: 'zeta', preFix: 'stale' },
  ]

  for (const { name, slugs, edited, preFix } of CASES) {
    it(`${name}: editing "${edited}" is served fresh (was ${preFix} before the fix)`, () => {
      const root = mkdtempSync(join(tmpdir(), 'nessy-invalidate-source-'))
      for (const slug of slugs) writeSourcePermissions(root, slug, `Stale-${slug}`)

      const before = permissionsConfigCache.getMergedConfig({ workspaceRootPath: root, activeSourceSlugs: slugs })
      expect(before.blockedTools.has(`Stale-${edited}`)).toBe(true)

      writeSourcePermissions(root, edited, `Fresh-${edited}`)
      permissionsConfigCache.invalidateSource(root, edited)

      const after = permissionsConfigCache.getMergedConfig({ workspaceRootPath: root, activeSourceSlugs: slugs })
      expect(after.blockedTools.has(`Fresh-${edited}`)).toBe(true)
      expect(after.blockedTools.has(`Stale-${edited}`)).toBe(false)
    })
  }

  it('a slug that only PREFIXES an active one is still not invalidated', () => {
    // The precision the old split did buy: "linear" must not invalidate
    // "linear-triage". Substring matching would pass the rows above and lose this.
    //
    // THE DETECTOR CHANGED WITH P2.80, and keeping the old one would have made
    // this row false. It used to edit the file and then require the STALE
    // answer — but a merged entry now re-checks the identity of every source
    // file it consumed on each hit, so an edited file is rebuilt whether or not
    // anybody invalidated. Staleness was never the invariant this row defends;
    // "an invalidation aimed at another slug did not reach this entry" is, and
    // with nothing changed on disk, entry identity measures exactly that and
    // nothing else.
    const root = mkdtempSync(join(tmpdir(), 'nessy-invalidate-source-prefix-'))
    writeSourcePermissions(root, 'linear-triage', 'Stale-linear-triage')
    const context = { workspaceRootPath: root, activeSourceSlugs: ['linear-triage'] }

    const before = permissionsConfigCache.getMergedConfig(context)
    permissionsConfigCache.invalidateSource(root, 'linear')
    expect(permissionsConfigCache.getMergedConfig(context)).toBe(before)

    // Positive control on the detector: the RIGHT slug DOES reach it. Without
    // this, an `invalidateSource` that had stopped invalidating anything at all
    // would sail through the assertion above.
    permissionsConfigCache.invalidateSource(root, 'linear-triage')
    expect(permissionsConfigCache.getMergedConfig(context)).not.toBe(before)
  })

  it('the caller\'s activeSourceSlugs array is not reordered by the key builder', () => {
    // `SessionManager.assertCdRulesPermit` passes `managed.enabledSourceSlugs`
    // straight in, so an in-place `.sort()` here would permanently reorder a
    // live session's own array.
    const root = mkdtempSync(join(tmpdir(), 'nessy-invalidate-source-order-'))
    const slugs = ['zeta', 'alpha']
    permissionsConfigCache.getMergedConfig({ workspaceRootPath: root, activeSourceSlugs: slugs })

    expect(slugs).toEqual(['zeta', 'alpha'])
  })

  it('a pinned context still short-circuits before any source config loads', () => {
    // The negative that bounds the blast radius: `buildMergedConfig` returns at
    // the end of the `pinnedConfigs` branch, so an on-disk source config is never
    // read for such a context — with or without this fix.
    const root = mkdtempSync(join(tmpdir(), 'nessy-invalidate-source-pinned-'))
    writeSourcePermissions(root, 'pinned-src', 'OnDiskTool')

    const pinned = permissionsConfigCache.getMergedConfig({
      workspaceRootPath: root,
      activeSourceSlugs: ['pinned-src'],
      pinnedRevision: 'gen-pinned',
      pinnedConfigs: [{ config: layer({ blockedTools: ['PinnedTool'] }), sourceSlug: 'pinned-src', scope: 'plugin' }],
    })

    expect(pinned.blockedTools.has('PinnedTool')).toBe(true)
    expect(pinned.blockedTools.has('OnDiskTool')).toBe(false)
  })
})

/**
 * P2.52 fix wave — the KEY and the MERGE must read ONE slug order.
 *
 * The `.sort()` that normalized the cache key used to run IN PLACE on
 * `context.activeSourceSlugs`, so `buildMergedConfig` — which runs after
 * `buildCacheKey` and iterates the same array — always composed sources in
 * lexicographic order. Copying before sorting fixed the caller-array mutation
 * and silently removed that normalization: the key still normalized, the merge
 * no longer did, so `['zeta','alpha']` and `['alpha','zeta']` became ONE cache
 * entry holding TWO different merges.
 *
 * Both harms are pinned below, and both are decisions, not bookkeeping:
 * `matchesToolPermissionRule` is FIRST-MATCH, so the composition order of
 * `merged.toolRules` IS the allow/deny verdict.
 *
 * WHAT MAKES `allowed === true` MEAN ANYTHING HERE. On its own, nothing:
 * `FooTool` is not write-classified, so a merge carrying NO rule for it answers
 * `true` as well — measured, on the fixed tree, under `dontAsk`:
 *
 *     ONLY zeta(deny)                  -> false
 *     ONLY alpha(allow)                -> true
 *     no slugs declared                -> true     <- vacuous
 *     no source files at all           -> true     <- vacuous
 *     wrong filename (permission.json) -> true     <- vacuous, both orders
 *     unruled tool "BarTool"           -> true
 *     unruled tool "Write"             -> false    (the SAFE_MODE floor, not us)
 *
 * An earlier version of this comment claimed the opposite — that `dontAsk`,
 * not being an interactive write mode, drops an unmatched tool through to the
 * read-only allowlist and DENIES. That is true only for write-classified tools;
 * `FooTool` falls through to `true`. Believing it would let a rig typo (wrong
 * path, wrong filename, undeclared slug) turn these rows green while measuring
 * nothing at all.
 *
 * F1.715 (2026-09-28): a source's `toolRules` allow now survives only for that
 * source's OWN tools, so the rows ask `mcp__alpha__foo` (the allowing source's
 * own tool) instead of `FooTool`. The table above is the `FooTool` measurement;
 * with no rule, the MCP tool answers `false` in `dontAsk` (the MCP write floor),
 * so a `true` below is never the fall-through.
 *
 * So each verdict row FIRST asks the same fixture with only `zeta` active and
 * requires `false`. That single assertion is what carries the rest: it proves
 * the source files load on this rig and that the deny side is reachable, and it
 * leaves zeta's deny in the merge for the paired ask — so a subsequent `true`
 * cannot be the fall-through. It can only mean alpha's allow loaded and was
 * composed FIRST.
 */
describe('the merge and the cache key share one slug order', () => {
  /** Write `<root>/sources/<slug>/permissions.json` declaring one tool rule. */
  function writeSourceToolRule(
    root: string,
    slug: string,
    pattern: string,
    action: 'allow' | 'deny',
  ): void {
    const dir = join(root, 'sources', slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'permissions.json'), `${JSON.stringify({ toolRules: [{ pattern, action }] })}\n`, 'utf-8')
  }

  /** A workspace where `alpha` ALLOWS its own `mcp__alpha__foo` and `zeta` DENIES it. */
  function conflictingWorkspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'nessy-slug-order-'))
    writeSourceToolRule(root, 'alpha', 'mcp__alpha__foo', 'allow')
    writeSourceToolRule(root, 'zeta', 'mcp__alpha__foo', 'deny')
    return root
  }

  function fooToolAllowed(root: string, activeSourceSlugs: string[]): boolean {
    return shouldAllowToolInMode('mcp__alpha__foo', {}, 'dontAsk', {
      permissionsContext: { workspaceRootPath: root, activeSourceSlugs },
    }).allowed
  }

  // Each order gets its OWN workspace, so each is measured against a cache that
  // has never seen the other — the collision in the next test is excluded here
  // by construction, leaving the merge order as the only variable.
  for (const declared of [['zeta', 'alpha'], ['alpha', 'zeta']]) {
    it(`a clean cache answers the same for declaration order [${declared.join(', ')}]`, () => {
      const root = conflictingWorkspace()
      // The control, on THIS fixture, before anything is claimed from it: with
      // only `zeta` active its deny is the only rule that can match, so a rig
      // that loads its files at all must answer `false`.
      expect(fooToolAllowed(root, ['zeta'])).toBe(false)
      // Now `true` is load-bearing. Lexicographic composition puts `alpha`'s
      // allow first and first-match makes that the verdict; zeta's deny is still
      // in this merge, so `true` cannot be "no rule matched". Before the fix the
      // `zeta`-first declaration composed `zeta` first and answered `false`.
      expect(fooToolAllowed(root, declared)).toBe(true)
    })
  }

  it('one cache entry cannot hold two different merges', () => {
    // The P2.45 family: the two orders build the SAME key, so whichever context
    // asks first decides for the other. `assertCdRulesPermit`, `pi-agent` and
    // `codex-agent` all build `activeSourceSlugs` from set-iteration order, so
    // which one asks first differs per session inside one workspace.
    //
    // The single-slug ask is a DIFFERENT key from the pair, so it controls the
    // fixture without seeding the entry under test.
    const zetaFirst = conflictingWorkspace()
    expect(fooToolAllowed(zetaFirst, ['zeta'])).toBe(false)
    expect(fooToolAllowed(zetaFirst, ['zeta', 'alpha'])).toBe(true)
    expect(fooToolAllowed(zetaFirst, ['alpha', 'zeta'])).toBe(true)

    const alphaFirst = conflictingWorkspace()
    expect(fooToolAllowed(alphaFirst, ['zeta'])).toBe(false)
    expect(fooToolAllowed(alphaFirst, ['alpha', 'zeta'])).toBe(true)
    expect(fooToolAllowed(alphaFirst, ['zeta', 'alpha'])).toBe(true)
  })

  it('the merge composes sources in lexicographic slug order', () => {
    // The structural half of the same fact, independent of any gate: distinct
    // patterns make the composition order directly observable.
    const root = mkdtempSync(join(tmpdir(), 'nessy-slug-order-compose-'))
    writeSourceToolRule(root, 'alpha', 'AlphaOnly', 'deny')
    writeSourceToolRule(root, 'zeta', 'ZetaOnly', 'deny')

    const composed = permissionsConfigCache
      .getMergedConfig({ workspaceRootPath: root, activeSourceSlugs: ['zeta', 'alpha'] })
      .toolRules
      .map(rule => rule.pattern)
      .filter(pattern => pattern === 'AlphaOnly' || pattern === 'ZetaOnly')

    expect(composed).toEqual(['AlphaOnly', 'ZetaOnly'])
  })

  it('the permission-DSL layer order is normalized too', () => {
    // The SECOND order consumer inside the merge: the same loop feeds
    // `addPermissionDsl`, and layer order decides which layer wins at compile.
    // It rides the same normalization because it rides the same loop — asserted
    // rather than assumed.
    const write = (root: string, slug: string, path: string) => {
      const dir = join(root, 'sources', slug)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'permissions.json'),
        `${JSON.stringify({ permissions: { deny: [`Read(${path})`] } })}\n`,
        'utf-8',
      )
    }
    // `sourceDigest`, not `id` and not `match`: a `CompiledRule` carries
    // `{id, action, scope, sourceDigest, matcher, order}` and has NO `match`
    // field at all — mapping one would compare `undefined` to `undefined` and
    // pass in every world. Both layers' ids are `deny-0`, so those collide too.
    // The digest is a hash of the file's own text, so it names the layer.
    const digestsFor = (declared: string[]) => {
      const root = mkdtempSync(join(tmpdir(), 'nessy-slug-order-dsl-'))
      write(root, 'alpha', './alpha-secret/**')
      write(root, 'zeta', './zeta-secret/**')
      const compiled = permissionsConfigCache
        .getMergedConfig({ workspaceRootPath: root, activeSourceSlugs: declared })
        .permissionDsl
      const digests = (compiled?.rules ?? []).map(rule => rule.sourceDigest)
      // Positive control on the detector: two DISTINCT layers must have
      // compiled, or an equality between the two orders proves nothing.
      expect(new Set(digests).size).toBe(2)
      return digests
    }

    expect(digestsFor(['zeta', 'alpha'])).toEqual(digestsFor(['alpha', 'zeta']))
  })
})

/**
 * P2.79 — THE CACHE KEY IS INJECTIVE.
 *
 * The invariant is not "the separator is escaped", it is that no two DIFFERENT
 * contexts can produce one key. The old key joined unescaped free text with
 * `::` and unescaped slugs with `,`, so three independent families of contexts
 * collapsed onto one entry — and a shared entry is not a stale read, it is a
 * permissions verdict decided by whichever context asked first.
 *
 * The property below is stated against a THIRD thing rather than against a list
 * of known-bad pairs: every generated context is identified by
 * `JSON.stringify([root, sortedSlugs, revision])`, which is injective on that
 * triple and owes nothing to the key builder. Then the map from identity to
 * cache entry must be a bijection, both directions asserted:
 *
 *   - same identity  -> the SAME merged object (`toBe`), which is what makes the
 *     declaration-order normalization a requirement rather than a nicety;
 *   - different identity -> an object never seen before, which is injectivity.
 *
 * Object identity is an exact proxy for key equality: two contexts that share a
 * key are served one cached object, and two that do not each get their own from
 * a fresh `buildMergedConfig`. So the property is measured through the
 * production entry point, with no reach into the private builder.
 *
 * The generator's own arithmetic is asserted before the property is claimed. A
 * property test over an empty or accidentally-collapsed sample passes while
 * measuring nothing — the same match-anything family as `Object.isFrozen(undefined)`.
 */
describe('the merged-config cache key is injective', () => {
  // Every element is a REACHABLE hostile input, not a stress string:
  // `loadSourceConfig` is an unchecked cast and `loadWorkspaceSources`
  // enumerates directory names, so an externally-authored source folder carries
  // its slug verbatim into `activeSourceSlugs`; and a workspace path containing
  // `::` is merely a legal directory name the user chose.
  const ROOTS = ['/ws', '/ws::a', '/ws,a', '/ws::a::b']
  const SLUG_LISTS: Array<string[] | undefined> = [
    undefined,      // no slugs declared
    [],             // an empty declaration
    [''],           // an AUTHORED empty slug — the merge reads <root>/sources/permissions.json for it
    ['a'],
    ['b'],
    ['a', 'b'],
    ['b', 'a'],     // the same identity as ['a','b'] after normalization
    ['a,b'],        // collided with ['a','b'] on the `,` join
    ['a::b'],       // collided with root `/ws::a` + ['b'] across workspaces
    ['a', 'a'],     // a repeated slug is visited twice by the merge
  ]
  const REVISIONS: Array<string | undefined> = [undefined, '', 'r', 'r::x']

  /**
   * The identity of a context, computed WITHOUT the key builder.
   *
   * `.sort()` is the one equivalence the cache is entitled to: `getMergedConfig`
   * normalizes declaration order because the merge's composition order is a
   * policy decision. Nothing else here is normalized, so an absent slug list, an
   * empty one and one holding an empty string are three different identities.
   */
  function identityOf(root: string, slugs: string[] | undefined, revision: string | undefined): string {
    return JSON.stringify([root, slugs ? [...slugs].sort() : null, revision ?? null])
  }

  it('distinct contexts are never served one entry, and equivalent ones always are', () => {
    const entryByIdentity = new Map<string, MergedPermissionsConfig>()
    const identityByEntry = new Map<MergedPermissionsConfig, string>()
    let asks = 0
    let hits = 0

    for (const workspaceRootPath of ROOTS) {
      for (const activeSourceSlugs of SLUG_LISTS) {
        for (const pinnedRevision of REVISIONS) {
          asks += 1
          const identity = identityOf(workspaceRootPath, activeSourceSlugs, pinnedRevision)
          const entry = permissionsConfigCache.getMergedConfig({
            workspaceRootPath,
            ...(activeSourceSlugs === undefined ? {} : { activeSourceSlugs: [...activeSourceSlugs] }),
            ...(pinnedRevision === undefined ? {} : { pinnedRevision }),
          })

          const seen = entryByIdentity.get(identity)
          if (seen !== undefined) {
            // Same identity: the cache MUST hand back the very same object. This
            // half is what dies if the slug sort is removed from `getMergedConfig`.
            hits += 1
            expect(entry).toBe(seen)
            continue
          }
          // New identity: this object must never have belonged to another one.
          // This half is the collision assertion, and it names the offender.
          expect(identityByEntry.get(entry) ?? null).toBe(null)
          entryByIdentity.set(identity, entry)
          identityByEntry.set(entry, identity)
        }
      }
    }

    // The generator's arithmetic, asserted so the property cannot pass vacuously:
    // 4 roots x 10 slug lists x 4 revisions, of which ['b','a'] normalizes onto
    // ['a','b'] — 9 distinct slug identities, so 4 x 9 x 4 distinct entries and
    // 4 x 4 repeat asks.
    expect(asks).toBe(160)
    expect(entryByIdentity.size).toBe(144)
    expect(hits).toBe(16)
    // And the bijection's other side, counted rather than inferred.
    expect(identityByEntry.size).toBe(entryByIdentity.size)
  })

  it('the key is a function: the same context asked twice is one entry', () => {
    // Injectivity alone is satisfied by a key that never repeats — which would
    // be a cache that never hits and a slow leak. Both properties are needed and
    // this is the cheap half.
    const context: PermissionsContext = {
      workspaceRootPath: '/ws-determinism',
      activeSourceSlugs: ['a,b', ''],
      pinnedRevision: 'r::x',
    }
    const first = permissionsConfigCache.getMergedConfig({ ...context, activeSourceSlugs: ['a,b', ''] })
    const second = permissionsConfigCache.getMergedConfig({ ...context, activeSourceSlugs: ['a,b', ''] })
    expect(second).toBe(first)
  })
})

/**
 * P2.79 — THE TWO COLLISIONS THAT WERE MEASURED, each in BOTH arrival directions.
 *
 * The property above proves no collision survives. These two rows are what the
 * property is FOR: they are the exact pairs measured on the old key, and they
 * are the reason the consequence is described as a wrong answer rather than a
 * stale one. Each is asked in both arrival directions, because a row that only
 * ever asks one order cannot tell "the second context got the first's answer"
 * from "this fixture simply answers that way".
 */
describe('a permissions verdict is not decided by cache arrival order', () => {
  /** Write `<root>/sources/<slug>/permissions.json` declaring one tool rule. */
  function writeRule(root: string, slug: string, pattern: string, action: 'allow' | 'deny'): void {
    const dir = join(root, 'sources', slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'permissions.json'), `${JSON.stringify({ toolRules: [{ pattern, action }] })}\n`, 'utf-8')
  }

  /**
   * `a,b` DENIES `mcp__a__foo`; `a` ALLOWS it (its own tool — F1.715 keeps a
   * source's allow only for those); `b` DENIES it.
   *
   * `b`'s deny is the CONTROL's subject and it is deliberately not inert: asking
   * `['b']` alone is a different cache key from both contexts under test, so it
   * proves this fixture's files load and that the deny side is reachable without
   * seeding either entry. It also stays in the `['a','b']` merge, so the `true`
   * that follows cannot be the unmatched fall-through — a merge holding NO rule
   * for this MCP tool answers `false` in `dontAsk` (the MCP write floor).
   */
  function commaSlugWorkspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'nessy-comma-slug-'))
    writeRule(root, 'a,b', 'mcp__a__foo', 'deny')
    writeRule(root, 'a', 'mcp__a__foo', 'allow')
    writeRule(root, 'b', 'mcp__a__foo', 'deny')
    return root
  }

  function fooToolAllowed(root: string, activeSourceSlugs: string[]): boolean {
    return shouldAllowToolInMode('mcp__a__foo', {}, 'dontAsk', {
      permissionsContext: { workspaceRootPath: root, activeSourceSlugs },
    }).allowed
  }

  it("C1: ['a,b'] asking first does not decide for ['a','b']", () => {
    const root = commaSlugWorkspace()
    expect(fooToolAllowed(root, ['b'])).toBe(false)      // control: files load, deny reachable
    expect(fooToolAllowed(root, ['a,b'])).toBe(false)    // the one-slug context, on its own merge
    // Before the fix this was served the entry above and answered `false`. It is
    // `true` because `a` sorts first and first-match-wins makes its allow the
    // verdict, while `b`'s deny sits in the same merge.
    expect(fooToolAllowed(root, ['a', 'b'])).toBe(true)
  })

  it("C1, reversed: ['a','b'] asking first does not decide for ['a,b']", () => {
    const root = commaSlugWorkspace()
    expect(fooToolAllowed(root, ['b'])).toBe(false)      // the same control, same fixture
    expect(fooToolAllowed(root, ['a', 'b'])).toBe(true)
    // Before the fix this was served the entry above and answered `true` — a
    // context whose ONLY declared source denies the tool was told it may run it.
    expect(fooToolAllowed(root, ['a,b'])).toBe(false)
  })

  /**
   * C2 — the cross-workspace twin, via `::` in a workspace PATH.
   *
   *   W1 = <base>/w      slugs ['a::b']   ->  "<base>/w"    :: "a::b" :: …
   *   W2 = <base>/w::a   slugs ['b']      ->  "<base>/w::a" :: "b"    :: …
   *
   * Both concatenated to `<base>/w::a::b::…`. No slug weirdness is required for
   * the W2 side — only a directory name the user is free to choose.
   */
  function crossWorkspacePair(): { w1: string, w2: string } {
    const base = mkdtempSync(join(tmpdir(), 'nessy-cross-ws-'))
    const w1 = join(base, 'w')
    const w2 = join(base, 'w::a')
    const write = (root: string, slug: string, tool: string) => {
      const dir = join(root, 'sources', slug)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'permissions.json'), `${JSON.stringify({ blockedTools: [tool] })}\n`, 'utf-8')
    }
    write(w1, 'a::b', 'Tool-W1')
    write(w2, 'b', 'Tool-W2')
    return { w1, w2 }
  }

  const w1Context = (w1: string): PermissionsContext => ({ workspaceRootPath: w1, activeSourceSlugs: ['a::b'] })
  const w2Context = (w2: string): PermissionsContext => ({ workspaceRootPath: w2, activeSourceSlugs: ['b'] })

  it('C2: W1 asking first is not served to W2', () => {
    const { w1, w2 } = crossWorkspacePair()
    const first = permissionsConfigCache.getMergedConfig(w1Context(w1))
    expect(first.blockedTools.has('Tool-W1')).toBe(true)   // control: W1's own file loaded

    const second = permissionsConfigCache.getMergedConfig(w2Context(w2))
    expect(second).not.toBe(first)
    expect(second.blockedTools.has('Tool-W2')).toBe(true)
    expect(second.blockedTools.has('Tool-W1')).toBe(false)
    // The compounding harm, and the sharpest tell: the entry carried the FIRST
    // arriving context's identity, so W2 was handed W1's permission FILE PATH —
    // every "edit this file to fix it" message pointed at another workspace.
    expect(second.permissionPaths?.workspacePath).toBe(join(w2, 'permissions.json'))
  })

  it('C2, reversed: W2 asking first is not served to W1', () => {
    const { w1, w2 } = crossWorkspacePair()
    const first = permissionsConfigCache.getMergedConfig(w2Context(w2))
    expect(first.blockedTools.has('Tool-W2')).toBe(true)   // control: W2's own file loaded

    const second = permissionsConfigCache.getMergedConfig(w1Context(w1))
    expect(second).not.toBe(first)
    expect(second.blockedTools.has('Tool-W1')).toBe(true)
    expect(second.blockedTools.has('Tool-W2')).toBe(false)
    expect(second.permissionPaths?.workspacePath).toBe(join(w1, 'permissions.json'))
  })

  it('C2: each workspace can invalidate its own entry, and only its own', () => {
    // The half the row called out separately: post-P2.52 the entry records the
    // first arriving context's workspace, so while the two shared a key
    // `invalidateWorkspace(W2)` could not drop it and W2's own edits stayed
    // unreachable until W1 happened to edit.
    const { w1, w2 } = crossWorkspacePair()
    permissionsConfigCache.getMergedConfig(w1Context(w1))
    const w2Entry = permissionsConfigCache.getMergedConfig(w2Context(w2))

    // Control: an untouched cache HITS, so the `not.toBe` below is caused by the
    // invalidation rather than by a cache that never hits at all.
    expect(permissionsConfigCache.getMergedConfig(w2Context(w2))).toBe(w2Entry)
    permissionsConfigCache.invalidateWorkspace(w1)
    expect(permissionsConfigCache.getMergedConfig(w2Context(w2))).toBe(w2Entry)  // W1's sweep must not reach W2
    permissionsConfigCache.invalidateWorkspace(w2)
    expect(permissionsConfigCache.getMergedConfig(w2Context(w2))).not.toBe(w2Entry)
  })
})

/**
 * P2.80 — A DELETED SOURCE MUST NOT POLICE THE ONE THAT REPLACES IT.
 *
 * `invalidateWorkspace` cleared `workspaceConfigs` and the merged entries and
 * never `sourceConfigs`, so a merged entry was dropped and immediately rebuilt
 * FROM THE CACHED SOURCE PARSE — a byte-identical stale answer that looked
 * invalidated and logged nothing.
 *
 * The live defect is next door and worse: nothing invalidates on source DELETE
 * or ADD at all. `deleteSource` is a bare `rmSync`, `removeSourceEverywhere`
 * never touches this cache, and the watcher's source-DIRECTORY route reloads the
 * source list and stops. `generateSourceSlug` hands a freed slug to the next
 * source that asks for it, so deleting a source and adding another gave the new
 * one the deleted one's permission file — an ordinary user action producing the
 * wrong policy.
 *
 * The fix is the entry validating its own inputs rather than waiting to be told;
 * the eager invalidators remain and are pinned separately below, because a cache
 * that self-heals would otherwise let them be deleted with the suite still green.
 */
describe('a source that was replaced no longer polices its slug', () => {
  function writeBlocked(root: string, slug: string, tool: string): void {
    const dir = join(root, 'sources', slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'permissions.json'), `${JSON.stringify({ blockedTools: [tool] })}\n`, 'utf-8')
  }
  const blockedTools = (root: string, slugs: string[]) =>
    permissionsConfigCache.getMergedConfig({ workspaceRootPath: root, activeSourceSlugs: slugs }).blockedTools

  const permissionsFile = (root: string, slug: string) => join(root, 'sources', slug, 'permissions.json')

  /**
   * D1.440 — the two arms below DECIDE the file's timestamp instead of asking
   * the clock, and what forced it is worth carrying.
   *
   * `sourcePermissionsStamp` is `ino/size/mtimeMs`. An in-place rewrite keeps
   * the inode; these rule names are the same LENGTH on purpose, so the size
   * matches too; and on the CI runner both writes landed in the SAME
   * millisecond. All three components equal means the stamp is unchanged and
   * the cached entry is served — `an in-place edit of a source file is seen
   * even when nobody invalidates` failed there while passing on a Mac, so the
   * case was measuring the clock rather than the guard.
   *
   * The residue is a real, narrow limit of an mtime stamp and it is PINNED
   * below rather than hidden: a same-inode, same-size rewrite inside one
   * millisecond is invisible to it.
   */
  const ageFile = (path: string, secondsAgo: number): void => {
    const when = new Date(Date.now() - secondsAgo * 1000)
    utimesSync(path, when, when)
  }

  it('delete a source, add another on the freed slug, and the new file is what applies', () => {
    const root = mkdtempSync(join(tmpdir(), 'nessy-source-replace-'))
    // The two rule names are the SAME LENGTH on purpose: the two files are
    // byte-for-byte the same size, so a stamp that only watched size would not
    // see this and the row would pass for the wrong reason.
    writeBlocked(root, 'linear', 'OldSourceRule')
    expect(blockedTools(root, ['linear']).has('OldSourceRule')).toBe(true)   // baseline: the rig loads files

    // Exactly what `deleteSource` does.
    rmSync(join(root, 'sources', 'linear'), { recursive: true, force: true })
    expect(blockedTools(root, ['linear']).has('OldSourceRule')).toBe(false)  // the delete alone is already visible

    // A NEW source is created and `generateSourceSlug` reuses the freed slug.
    writeBlocked(root, 'linear', 'NewSourceRule')
    const after = blockedTools(root, ['linear'])
    expect(after.has('NewSourceRule')).toBe(true)
    expect(after.has('OldSourceRule')).toBe(false)
  })

  it('an in-place edit of a source file is seen even when nobody invalidates', () => {
    // The same guard on the shape that keeps the inode: an ordinary rewrite.
    const root = mkdtempSync(join(tmpdir(), 'nessy-source-edit-'))
    writeBlocked(root, 'solo', 'StaleRule')
    // Age the FIRST write, so the rewrite's own `mtimeMs` cannot tie with it on
    // any filesystem. See `ageFile`: without this the row is decided by the
    // machine's timestamp resolution and not by the guard.
    ageFile(permissionsFile(root, 'solo'), 300)
    expect(blockedTools(root, ['solo']).has('StaleRule')).toBe(true)

    writeBlocked(root, 'solo', 'FreshRule')
    const after = blockedTools(root, ['solo'])
    expect(after.has('FreshRule')).toBe(true)
    expect(after.has('StaleRule')).toBe(false)
  })

  it('...and the one shape it CANNOT see: same inode, same size, same millisecond', () => {
    // The residue the CI runner produced by accident, pinned on purpose so it
    // is a known limit rather than a flake somebody meets again. An `ino/size/
    // mtimeMs` stamp has nothing left to compare when all three match, so the
    // cached entry is served. It is a cache over a file the user edits by hand;
    // the cost is one stale read until anything else invalidates, and the
    // eager `invalidateSource` path (pinned below) is unaffected.
    const root = mkdtempSync(join(tmpdir(), 'nessy-source-tie-'))
    const file = permissionsFile(root, 'solo')
    // A FIXED instant on both sides. Restoring `statSync`'s own `mtime` is not
    // enough and the first draft of this arm proved it: a `Date` carries
    // milliseconds while this filesystem's `mtimeMs` carries a fraction of one
    // (…068.646 became …068), so the stamp moved and the guard correctly saw
    // the edit. An exact whole-millisecond value on both writes is the tie.
    const TIE = new Date(Date.UTC(2020, 0, 1, 12, 0, 0))

    writeBlocked(root, 'solo', 'StaleRule')
    utimesSync(file, TIE, TIE)
    const before = statSync(file)
    expect(blockedTools(root, ['solo']).has('StaleRule')).toBe(true)

    // The same-length rewrite, then the timestamp put back exactly — which is
    // what a coarse-granularity filesystem does on its own.
    writeBlocked(root, 'solo', 'FreshRule')
    utimesSync(file, TIE, TIE)
    // The tie is REAL and is asserted, so this case cannot pass because the
    // rewrite failed or the sizes differed.
    const after = statSync(file)
    expect(after.size).toBe(before.size)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(after.ino).toBe(before.ino)

    expect(blockedTools(root, ['solo']).has('StaleRule')).toBe(true)
    expect(blockedTools(root, ['solo']).has('FreshRule')).toBe(false)

    // ...and the eager path still corrects it, which is why this is a limit and
    // not a hole.
    permissionsConfigCache.invalidateSource(root, 'solo')
    expect(blockedTools(root, ['solo']).has('FreshRule')).toBe(true)
  })

  it('an unchanged source file still HITS — the guard is not a cache bypass', () => {
    // Without this, "always rebuild" would pass every row above while turning
    // the merged cache off entirely.
    const root = mkdtempSync(join(tmpdir(), 'nessy-source-hit-'))
    writeBlocked(root, 'solo', 'SomeRule')
    const first = permissionsConfigCache.getMergedConfig({ workspaceRootPath: root, activeSourceSlugs: ['solo'] })
    const second = permissionsConfigCache.getMergedConfig({ workspaceRootPath: root, activeSourceSlugs: ['solo'] })
    expect(second).toBe(first)
  })

  it('invalidateSource still drops the merged entry EAGERLY', () => {
    // The self-validating entry makes freshness correct without this call, which
    // would let the whole merged sweep in `invalidateSource` be deleted with the
    // suite green. Nothing on disk changes here, so the only thing that can
    // produce a new object is the eager drop itself.
    const root = mkdtempSync(join(tmpdir(), 'nessy-eager-source-'))
    writeBlocked(root, 'solo', 'SomeRule')
    const context: PermissionsContext = { workspaceRootPath: root, activeSourceSlugs: ['solo'] }
    const first = permissionsConfigCache.getMergedConfig(context)
    expect(permissionsConfigCache.getMergedConfig(context)).toBe(first)   // control: it hits when untouched

    permissionsConfigCache.invalidateSource(root, 'solo')
    const rebuilt = permissionsConfigCache.getMergedConfig(context)
    expect(rebuilt).not.toBe(first)
    expect(rebuilt.blockedTools.has('SomeRule')).toBe(true)
  })

  it('invalidateWorkspace RELEASES the workspace parsed source configs', () => {
    // The row's literal fix, and the one consequence a freshness assertion can
    // no longer see now that entries validate themselves: eviction. Without it
    // this map only ever grew, holding every source ever parsed for a workspace
    // the user has closed.
    const root = mkdtempSync(join(tmpdir(), 'nessy-source-evict-'))
    writeBlocked(root, 'one', 'RuleOne')
    writeBlocked(root, 'two', 'RuleTwo')
    const internals = permissionsConfigCache as unknown as {
      sourceConfigs: Map<string, Map<string, unknown>>
    }

    blockedTools(root, ['one', 'two'])
    expect(internals.sourceConfigs.get(root)?.size).toBe(2)   // control: they were cached at all

    permissionsConfigCache.invalidateWorkspace(root)
    expect(internals.sourceConfigs.has(root)).toBe(false)
  })
})

/**
 * P2.78 — THE SORTED-INPUT PRECONDITION, ENFORCED RATHER THAN DESCRIBED.
 *
 * It used to be a docblock sentence: "the caller sorted for me". That is the
 * exact contract shape that had already decayed once here — the key builder's
 * in-place `.sort()` was silently load-bearing for the MERGE, so replacing it
 * with a sorted copy left one cache entry holding two different merges and an
 * allow/deny verdict that followed declaration order.
 *
 * `NormalizedPermissionsContext` is a type-only brand minted in exactly one
 * place, next to the `.sort()` that earns it, and taken by BOTH consumers — the
 * key builder and the merge builder. The merge is the half that actually broke,
 * so branding only the key would have re-enforced the wrong end.
 *
 * This row is a COMPILE-TIME assertion and is checked by `bun run
 * typecheck:shared`, which was confirmed to cover files under `src/**` including
 * this one. Remove the brand and the `@ts-expect-error` below becomes an unused
 * directive, which is itself an error — the guard cannot pass in a world where
 * the precondition is only a comment again.
 */
describe('the normalized-context precondition is a type, not a comment', () => {
  it('a raw context cannot be passed off as a normalized one, but a normalized one is still a context', () => {
    const raw: PermissionsContext = { workspaceRootPath: '/ws-brand', activeSourceSlugs: ['b', 'a'] }
    // @ts-expect-error the brand is minted only by `normalizePermissionsContext`,
    // immediately after the sort — an unsorted context cannot reach either builder.
    const forged: NormalizedPermissionsContext = raw
    // The other direction MUST still compile: the brand narrows the type, it does
    // not make it unrelated. Without this, a brand that had accidentally become
    // `never` would satisfy the line above while breaking every real caller.
    const widened: PermissionsContext = forged
    expect(widened.activeSourceSlugs).toEqual(['b', 'a'])
  })
})
