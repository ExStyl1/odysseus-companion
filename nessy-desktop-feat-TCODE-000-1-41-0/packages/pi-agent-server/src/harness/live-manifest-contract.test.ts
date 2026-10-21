/**
 * R10 follow-up (declared-vs-enforced instance fourteen): the live app failed
 * its FIRST turn with `Pi execution manifest model contract mismatch for bash`
 * because the HOST built the manifest from the live source pins while the
 * SUBPROCESS ran a stale built bundle whose schema (and embedded pin table)
 * predated the `run_in_background` change.
 *
 * Two guards close that split:
 *
 * 1. The PRODUCTION manifest build path — `createPiExecutionManifestSeed` +
 *    `finalizePiExecutionManifest` (exactly what `pi-agent.ts` runs) projected
 *    through `projectPiManifestTools` against the live subprocess definitions —
 *    must not throw the mismatch. This is the seam that produced the live
 *    error string, not a fixture compare: it fails whenever the schema and the
 *    pin in `PI_STATIC_MODEL_CONTRACT_HASHES` are updated out of step.
 *
 * 2. Every BUILT subprocess bundle present on disk (the dev bundle
 *    `packages/pi-agent-server/dist/index.js` and the staged Electron copy
 *    `apps/electron/resources/pi-agent-server/index.js`) must embed the
 *    CURRENT pin table. A bundle is a snapshot of the enforcement side; a
 *    stale one is exactly the live failure. Bundles are gitignored, so a
 *    clean checkout (CI) skips this — on a dev machine it fails before a live
 *    run does. Rebuild with `bun run electron:build:servers`.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPiExecutionManifestSeed,
  finalizePiExecutionManifest,
  piStaticModelContractPinKey,
} from '../../../shared/src/agent/pi-harness/harness-manifest.ts';
import {
  PI_STATIC_MODEL_CONTRACT_HASHES,
  PI_TOOL_PRESENTATION_REWRITES,
  getPiStaticModelContractHash,
} from '../../../shared/src/agent/pi-harness/harness-tool-descriptor.ts';
// P2.235 — the live composition lives in its own module now, so a second reader
// (this file is one; `pi-harness-baseline.test.ts` builds the same surface by
// hand) can share ONE construction instead of maintaining a copy of it.
import {
  LIVE_MANIFEST_SNAPSHOT as snapshot,
  LIVE_MANIFEST_VIEW as view,
  buildLiveCompositions,
  liveStaticDefinitions,
} from './live-manifest-compositions.ts';
import { hashProjectedPiToolDefinition, projectPiManifestTools } from './tool-manifest.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

/**
 * P2.235 · the six SOURCE-STATE pins record a reason for being source-state,
 * and this file refutes it.
 *
 * `tool-surface.json` carries, on all six, the `inputCodec`:
 *
 * > source-state parameters declaration; live import excluded because spawner
 * > eager runtime graph retains handles
 *
 * That claim is FALSE in this process. `liveStaticDefinitions` above imports
 * all six factories directly and constructs them with stubbed ports, and the
 * first test in this file then projects the production manifest against the
 * result. So the six are reachable live, their parameters are readable live,
 * and the reason those pins are hashed over SOURCE TEXT instead is not the one
 * recorded.
 *
 * This is pinned rather than written down because it decides the whole of
 * P2.235: if the six become live-derived pins, the "6 of 77" coverage question
 * and the prefix question (`source-state-schema:` vs `/` vs `exact-name:`)
 * dissolve together, and the `--pin` stale-prefix hazard with them. Converting
 * them is NOT done here — it moves the fixture, `pi-harness-baseline.test.ts`
 * and the census in `source-state-contract.ts`, which this lane does not hold.
 */
const SOURCE_STATE_PINNED_TOOL_NAMES = [
  'subagent',
  'review',
  'get_subagent_result',
  'steer_subagent',
  'stopTask',
  'workflow',
] as const;

describe('P2.235 · the source-state pins are live-reachable in this process', () => {
  it('constructs every source-state-pinned tool and reads its parameters live', () => {
    const definitions = liveStaticDefinitions(repoRoot);
    const byName = new Map(definitions.map(definition => [definition.name, definition]));

    for (const name of SOURCE_STATE_PINNED_TOOL_NAMES) {
      const definition = byName.get(name);
      // Absence here is the interesting failure: it would mean the recorded
      // rationale had become true, and the next reader must know which way it
      // moved before deciding the row.
      expect(definition, `${name} is not constructible in-process`).toBeDefined();
      expect(definition!.parameters, `${name} has no live parameters`).toBeDefined();
      expect(typeof definition!.parameters, name).toBe('object');
    }

    // Positive control on the same rig: a tool that IS pinned live-derived is
    // present too, so the loop above is not passing on an empty map.
    expect(byName.get('bash')).toBeDefined();
  });
});

describe('live manifest model contract', () => {
  it('the production host manifest projects against the live subprocess definitions', () => {
    // The HOST path pi-agent.ts runs: production seed builder + finalize.
    const manifest = finalizePiExecutionManifest(
      createPiExecutionManifestSeed({
        snapshot,
        view,
        sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      }),
      [],
    );
    const definitions = liveStaticDefinitions(repoRoot);
    // The SUBPROCESS seam that produced the live error string. A schema/pin
    // split throws `Pi execution manifest model contract mismatch for <tool>`.
    expect(() => projectPiManifestTools({
      manifest,
      definitions,
      expectedGeneration: manifest.snapshotGeneration,
      expectedManifestHash: manifest.manifestHash,
    })).not.toThrow();

    // And the bash pin specifically agrees with the live projected schema.
    const bashTool = manifest.tools.find(tool => tool.binding.piName === 'bash');
    const bashDefinition = definitions.find(definition => definition.name === 'bash');
    expect(bashTool).toBeDefined();
    expect(bashDefinition).toBeDefined();
    expect(hashProjectedPiToolDefinition(manifest, bashTool!, bashDefinition!))
      .toBe(getPiStaticModelContractHash('bash'));

    // sub-agents.md:783 gives the `subagent` tool a SECOND model-visible shape
    // under fork mode (the `background` parameter is removed), so the host pins
    // a second hash and both sides pick the variant from the same manifest
    // field. Without this the first turn of a fork-mode session would die with
    // "Pi execution manifest model contract mismatch for subagent".
    const forkManifest = finalizePiExecutionManifest(
      createPiExecutionManifestSeed({
        snapshot,
        view,
        sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
        orchestrator: { forkSubagent: true },
      }),
      [],
    );
    expect(forkManifest.orchestrator.forkSubagent).toBe(true);
    expect(() => projectPiManifestTools({
      manifest: forkManifest,
      definitions: liveStaticDefinitions(repoRoot, true),
      expectedGeneration: forkManifest.snapshotGeneration,
      expectedManifestHash: forkManifest.manifestHash,
    })).not.toThrow();
  });

  /**
   * Q10-3 — the rewrite replaced a tool name as a SUBSTRING, so `Ls` was
   * rewritten inside the English word `URLs`.
   *
   * `binding('ls', 'ls', 'ls', 'ls', 'Ls')` puts `Ls` in
   * `PI_TOOL_PRESENTATION_REWRITES`, and `rewriteText` used `String.replaceAll`,
   * which has no notion of a word. `web_search`'s description ("Returns titles,
   * URLs, and snippets") and `workflow`'s guidance ("paths, URLs, and inline
   * source are rejected") both reached the model as `URls` — corrupted English
   * in text whose whole purpose is to tell the model how to call the tool.
   *
   * The constant's own note already says the rewritable spellings "include
   * ordinary English words (`Read`, `Write`, `Edit`, `Find`, `Task`, `Ls`)" and
   * that keeping them out of pinned text "cannot be kept by inspection". A word
   * boundary is the rule that makes that true rather than aspirational: `\b`
   * runs on `[A-Za-z0-9_]`, so `Ls` in `URLs` has a word character on its left
   * and does not match, while a real `Ls` mention still does.
   *
   * Both texts belong to PINNED tools, so the two hashes move with this fix and
   * are regenerated in the same commit — the pin loop below is what proves it.
   */
  it('rewrites a tool name as a WORD, never inside another word', () => {
    const manifest = finalizePiExecutionManifest(
      createPiExecutionManifestSeed({
        snapshot,
        view,
        sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
      }),
      [],
    );
    const projected = projectPiManifestTools({
      manifest,
      definitions: liveStaticDefinitions(repoRoot),
      expectedGeneration: manifest.snapshotGeneration,
      expectedManifestHash: manifest.manifestHash,
    });
    const textOf = (piName: string) => {
      const tool = projected.find(candidate => candidate.name === piName);
      expect(tool, `${piName} missing from the live projection`).toBeDefined();
      return [
        tool!.description ?? '',
        tool!.promptSnippet ?? '',
        ...((tool as { promptGuidelines?: readonly string[] }).promptGuidelines ?? []),
        JSON.stringify(tool!.parameters ?? {}),
      ].join('\n');
    };

    // The defect, in both texts that carry the word.
    expect(textOf('web_search')).toContain('URLs');
    expect(textOf('web_search')).not.toContain('URls');
    expect(textOf('workflow')).toContain('URLs');
    expect(textOf('workflow')).not.toContain('URls');

    // The positive control the fix must not break: a real mention of a
    // rewritable name is STILL rewritten to the piName the model can call.
    // `subagent`'s guidance names `stopTask`, which is Q6-D1's own case.
    expect(textOf('subagent')).toContain('stop_task');
    expect(textOf('subagent')).not.toContain('stopTask');
  });

  /**
   * UB12.5 (2026-10-16) — a spelling that is also lowercase PROSE is never a
   * rewrite. UB6.11's `decide` session tool put the bare verb `decide` in
   * `PI_TOOL_PRESENTATION_REWRITES`; `ask_user`'s pinned snippet ("you need the
   * user to decide before continuing") then projected as "… to
   * mcp__session__decide …", its hash left the pin, and the production manifest
   * refused every Pi session carrying `ask_user` (the first arm of this describe
   * read red at `00755e14f`). `remember` had done the same to session-tool
   * prose since it landed. The word boundary (Q10-3) cannot help: the word IS a
   * whole word. Runs on the `live+session` composition, so the session tools'
   * own texts are projected exactly as the subprocess projects them.
   */
  it('never rewrites a spelling that is also a lowercase prose word (decide, remember)', () => {
    const spellings = PI_TOOL_PRESENTATION_REWRITES.map(entry => entry.name);
    expect(spellings.filter(name => /^[a-z]+$/.test(name))).toEqual([]);
    // Boundary control: the spellings a text MEANS to name still rewrite — a
    // capital (`Task`, `stopTask`) or an underscore (`call_llm`) marks them.
    expect(spellings).toContain('Task');
    expect(spellings).toContain('stopTask');
    expect(spellings).toContain('call_llm');

    const { manifest, definitions } = buildLiveCompositions(repoRoot)
      .find(entry => entry.label === 'live+session')!;
    // The session tools' subprocess definitions are built from the manifest's
    // own wire fields, the shape `validatePiManifestWireDefinitions` accepts.
    const staticNames = new Set(definitions.map(definition => definition.name));
    const sessionDefinitions = manifest.tools
      .filter(tool => tool.description !== undefined && !staticNames.has(tool.binding.bindingName))
      .map(tool => ({
        name: tool.binding.bindingName,
        label: tool.binding.bindingName,
        description: tool.description!,
        parameters: tool.modelSchema as any,
        promptSnippet: tool.promptSnippet,
        promptGuidelines: tool.promptGuidelines,
        execute: async () => ({ content: [], details: {} }),
      }));
    const projected = projectPiManifestTools({
      manifest,
      definitions: [...definitions, ...sessionDefinitions] as any,
      expectedGeneration: manifest.snapshotGeneration,
      expectedManifestHash: manifest.manifestHash,
    });
    const textOf = (piName: string) => {
      const tool = projected.find(candidate => candidate.name === piName);
      expect(tool, `${piName} missing from the live projection`).toBeDefined();
      return [
        tool!.description ?? '',
        tool!.promptSnippet ?? '',
        ...((tool as { promptGuidelines?: readonly string[] }).promptGuidelines ?? []),
        JSON.stringify(tool!.parameters ?? {}),
      ].join('\n');
    };
    // The CRITICAL symptom: the pinned snippet keeps its English verb.
    expect(textOf('ask_user')).toContain('the user to decide before continuing');
    expect(textOf('ask_user')).not.toContain('mcp__session__decide');
    // The session-tool prose the same two rewrites reached.
    expect(textOf('mcp__session__SendUserFile')).toContain('let the client decide');
    expect(textOf('mcp__session__SendUserFile')).not.toContain('mcp__session__decide');
    expect(textOf('mcp__session__update_user_preferences')).toContain('helpful to remember');
    expect(textOf('mcp__session__update_user_preferences')).not.toContain('mcp__session__remember');
  });

  it('static pins are stable in the LIVE composition (session tools registered, off switch on or off)', () => {
    // The live app never runs the static-only manifest my first test builds:
    // the host registers every session tool (`buildCurrentProxyToolDefinitions`
    // -> mcp__session__* dynamic tools with known piBuiltin bindings), and
    // `projectPiToolDefinition` rewrites tool-name mentions per composition
    // (`presentationReplacements`). A pinned static hash must therefore be
    // COMPOSITION-INDEPENDENT: if a schema/description mentions another tool by
    // a rewritable name, the live projection hashes differently than the pin
    // and the first turn dies with
    // `Pi execution manifest model contract mismatch for <tool>` (CDP pass 12,
    // session 022b8e0b: `BashOutput` inside the run_in_background description).
    // P2.235 — the four compositions come from `live-manifest-compositions.ts`
    // so this file and `pi-harness-baseline.test.ts` can share ONE construction
    // of the live surface rather than each keeping a copy that can drift.
    const compositions = buildLiveCompositions(repoRoot);
    const deferredManifest = compositions.find(entry => entry.label === 'deferred-mcp+session')!.manifest;
    expect(deferredManifest.deferredMcp.enabled).toBe(true);
    // Guard the guard: a composition that stopped carrying the discovery tools
    // would make this loop silently skip them again, which is exactly how their
    // pins went unchecked in the first place.
    expect(deferredManifest.tools.map(tool => tool.binding.piName))
      .toContain('mcp__tool_search');
    expect(deferredManifest.tools.map(tool => tool.binding.piName))
      .toContain('mcp__tool_load');
    for (const { label, manifest, definitions } of compositions) {
      for (const tool of manifest.tools) {
        const pin = PI_STATIC_MODEL_CONTRACT_HASHES[
          piStaticModelContractPinKey(tool.binding.bindingName, manifest.orchestrator)
        ];
        if (!pin) continue;
        const definition = definitions.find(candidate => candidate.name === tool.binding.bindingName);
        if (!definition) continue;
        // The EXACT comparison projectPiManifestTools makes before throwing
        // `Pi execution manifest model contract mismatch for <piName>`.
        expect(
          hashProjectedPiToolDefinition(manifest, tool, definition),
          `${label}: ${tool.binding.piName} model-contract pin is composition-dependent - the live `
            + 'first turn would fail with "Pi execution manifest model contract mismatch". '
            + 'Keep rewritable tool names (e.g. BashOutput, ambiguous Bash) out of its schema/description text.',
        ).toBe(pin);
      }
    }
  });

  it('static pins survive a NARROWED CHILD composition (an agent whose `tools:` grants Agent)', () => {
    // Q6-D1, measured live on the packaged 1.25.1: a subagent whose own
    // frontmatter carries `tools: Read, Grep, Agent` died on its FIRST turn with
    // `Pi execution manifest model contract mismatch for subagent`, while the
    // same agent without the `Agent` entry ran normally. The parent was told
    // `done ... (no output)`.
    //
    // The composition is the variable. A child's declared `tools:` becomes
    // `piChildRestrictions.tools` -> `piAllowedTools` -> `allowedBindingNames`,
    // which `finalizePiExecutionManifest` applies to the STATIC tools too, so a
    // child manifest is a composition the four above never build: `subagent`
    // present while its companions (`stopTask` in particular) are not.
    // `presentationReplacements` is derived from the manifest's own tools, so a
    // rewritable name inside a pinned description resolves in the parent and
    // does not in the child - the same composition-dependence the test above
    // pins, one composition further down.
    const seed = createPiExecutionManifestSeed({
      snapshot,
      view,
      sessionKey: { workspaceId: 'workspace-1', sessionId: 'session-1' },
    });
    const definitions = liveStaticDefinitions(repoRoot);
    // A child's pool is an ARBITRARY SUBSET of the parent's - its author writes
    // it - so the invariant is per-subset, not per-example. Every pinned tool
    // ALONE (the narrowest pool that still carries it, and the pool an agent
    // declaring `tools: Agent` really gets), each of them beside `read`, plus
    // the three real shapes from the live run.
    const pinnedBindings = finalizePiExecutionManifest(seed, [])
      .tools.map(tool => tool.binding.bindingName)
      .filter(name => PI_STATIC_MODEL_CONTRACT_HASHES[name]);
    expect(pinnedBindings).toContain('subagent');
    const childPools: Array<readonly string[]> = [
      ...pinnedBindings.map(name => [name]),
      ...pinnedBindings.map(name => [...new Set(['read', name])]),
      ['read', 'grep', 'subagent'],
      ['read', 'subagent', 'get_subagent_result'],
      ['read', 'write', 'edit', 'bash', 'subagent', 'review', 'workflow'],
    ];
    for (const pool of childPools) {
      const manifest = finalizePiExecutionManifest(seed, [], { allowedBindingNames: pool });
      expect(manifest.tools.map(tool => tool.binding.bindingName).sort()).toEqual([...pool].sort());
      for (const tool of manifest.tools) {
        const pin = PI_STATIC_MODEL_CONTRACT_HASHES[
          piStaticModelContractPinKey(tool.binding.bindingName, manifest.orchestrator)
        ];
        if (!pin) continue;
        const definition = definitions.find(candidate => candidate.name === tool.binding.bindingName);
        if (!definition) continue;
        expect(
          hashProjectedPiToolDefinition(manifest, tool, definition),
          `child pool [${pool.join(', ')}]: ${tool.binding.piName} model-contract pin is `
            + 'composition-dependent - this child\'s FIRST turn dies with '
            + '"Pi execution manifest model contract mismatch" and the parent is told it completed. '
            + 'Keep rewritable tool names (bindingName/handlerName/permissionName spellings such as '
            + 'stopTask, BashOutput, Monitor) out of every pinned schema/description text.',
        ).toBe(pin);
      }
    }
    // And the whole subprocess seam, which is what actually threw live.
    const agentGrantChild = finalizePiExecutionManifest(seed, [], {
      allowedBindingNames: ['read', 'grep', 'subagent'],
    });
    expect(() => projectPiManifestTools({
      manifest: agentGrantChild,
      definitions,
      expectedGeneration: agentGrantChild.snapshotGeneration,
      expectedManifestHash: agentGrantChild.manifestHash,
    })).not.toThrow();
  });

  it('every built subprocess bundle embeds the current model-contract pins', () => {
    const bundles = [
      join(repoRoot, 'packages', 'pi-agent-server', 'dist', 'index.js'),
      join(repoRoot, 'apps', 'electron', 'resources', 'pi-agent-server', 'index.js'),
    ].filter(path => existsSync(path));
    for (const bundlePath of bundles) {
      const bundle = readFileSync(bundlePath, 'utf8');
      for (const [bindingName, hash] of Object.entries(PI_STATIC_MODEL_CONTRACT_HASHES)) {
        expect(
          bundle.includes(hash),
          `${bundlePath} does not embed the current ${bindingName} model-contract pin ${hash} - `
            + 'the bundle is STALE and a live session will fail with '
            + '"Pi execution manifest model contract mismatch". '
            + 'Rebuild it: bun run electron:build:servers',
        ).toBe(true);
      }
    }
  });
});
