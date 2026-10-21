import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// P6.129 — the codex writer is CALLED by the parity pin below rather than having
// its condition restated here. `@nessy-agent/shared` already depends on this
// package (`CodexAgent` builds the config through it), so this is not a new edge.
import { buildCodexAgentRoles } from '@nessy-agent/codex-responses-adapter/config-writer';
import {
  codexDeclinesAgentToolGrant,
  createCapabilityResolver,
  diagnoseUnusableMcpWireNames,
  withCapabilitySnapshot,
  type CapabilityContext,
  type CapabilityDiagnostic,
  type CapabilityResolutionInputs,
  type InstalledPluginInput,
  type ResolvedCapability,
  type ResolvedCapabilityEntry,
} from '../resolver.ts';
import { toAgentRuntime, toComposerCatalog, toUserCatalog } from '../views.ts';
import { tryParsePiDynamicMcpBindingName } from '../../agent/pi-harness/harness-manifest.ts';
import { normalizeNessyPluginManifest } from '../../plugins/schema.ts';
import { resolvePluginProjectionCandidates, type PluginProjectionCandidate } from '../../plugins/projection-candidates.ts';
import type { NativeCapabilitySourceRecord } from '../types.ts';

const CONTEXT: CapabilityContext = {
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  projectKey: 'p_00000000000000000000000000000000',
  projectTrustState: 'trusted',
  projectTrustRevision: 'trust-r1',
};

function nativeRecord(over: Partial<NativeCapabilitySourceRecord> & Pick<NativeCapabilitySourceRecord, 'key' | 'kind' | 'logicalName'>): NativeCapabilitySourceRecord {
  return {
    scope: { kind: 'workspace', workspaceId: 'ws-1' },
    sourcePath: `/abs/managed/${over.key}`,
    revision: 'r1',
    contentHash: 'a'.repeat(64),
    mutable: true,
    ...over,
  };
}

function pluginCandidate(over: Partial<PluginProjectionCandidate> & Pick<PluginProjectionCandidate, 'key' | 'capabilityId' | 'kind' | 'logicalName'>): PluginProjectionCandidate {
  return {
    pluginKey: 'pk-1',
    pluginInstanceId: 'plugin://m/p@1.0.0#' + 'b'.repeat(64),
    selectedScope: { kind: 'global' },
    trust: { required: false },
    ...over,
  };
}

function installedPlugin(): InstalledPluginInput {
  return {
    pluginInstanceId: 'plugin://m/p@1.0.0#' + 'b'.repeat(64),
    pluginKey: 'pk-1',
    marketplaceId: 'm',
    pluginId: 'p',
    version: '1.0.0',
    bundleHash: 'b'.repeat(64),
    cacheRef: { marketplaceId: 'm', pluginId: 'p', version: '1.0.0', bundleHash: 'b'.repeat(64) },
    manifest: { schemaVersion: 1, kind: 'plugin', id: 'p', name: 'Plugin P', version: '1.0.0', capabilities: [] },
    origin: { source: 'marketplace', resolvedAt: 0 },
    installedAt: 1000,
    diagnostics: [],
  };
}

function makeInputs(over: Partial<CapabilityResolutionInputs> = {}): CapabilityResolutionInputs {
  const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
  return {
    nativeInventory: {
      records: [
        nativeRecord({ key: 'skill:ws:alpha', kind: 'skill', logicalName: 'alpha' }),
        nativeRecord({
          key: 'source:ws:gmail',
          kind: 'source',
          logicalName: 'gmail',
          sourceType: 'api',
          displayName: 'Gmail',
          description: 'Email and calendar',
          iconResource: {
            revision: 'icon-r1',
            contentHash: '9'.repeat(64),
            dataUrl: 'data:image/png;base64,aWNvbi1vbmU=',
          },
          guideResource: {
            sourcePath: '/abs/managed/source:ws:gmail/guide.md',
            revision: 'guide-r1',
            contentHash: 'f'.repeat(64),
          },
        }),
        nativeRecord({ key: 'mcp:ws:fs', kind: 'mcp', logicalName: 'fs' }),
        nativeRecord({
          key: 'permission:ws:gmail',
          kind: 'permission',
          logicalName: 'sources/gmail/permissions.json',
          permissionSourceSlug: 'gmail',
        }),
      ],
      blockedLayers: [],
    },
    installedPlugins: [installedPlugin()],
    activePluginInstances: { 'pk-1': instanceId },
    pluginCandidates: [
      pluginCandidate({
        key: 'plug:skill:alpha',
        capabilityId: 'c-skill',
        kind: 'skill',
        logicalName: 'alpha',
        displayName: 'Plugin Alpha',
        description: 'Plugin-projected alpha skill',
        resource: { pluginInstanceId: instanceId, relativePath: 'skills/alpha/SKILL.md', contentHash: 'c'.repeat(64) },
      }),
    ],
    resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: {} }),
    resolveTrust: () => 'trusted',
    ...over,
  };
}

describe('CapabilityResolver — one snapshot, three views', () => {
  it('produces the same generation and capability keys across all three views', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginRuntimeContextFor: () => ({
          rootPath: '/private/plugin-cache/demo',
          dataPath: '/private/plugin-data/demo',
          profile: 'generic-plugin-env-v1' as const,
        }),
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);

    const runtime = toAgentRuntime(snapshot);
    const composer = toComposerCatalog(snapshot);
    const user = toUserCatalog(snapshot);

    expect(runtime.generation).toBe(snapshot.generation);
    expect(runtime.skills.find(skill => skill.key === 'plug:skill:alpha')?.pluginRuntime).toEqual({
      rootPath: '/private/plugin-cache/demo',
      dataPath: '/private/plugin-data/demo',
      profile: 'generic-plugin-env-v1',
    });
    expect(composer.generation).toBe(snapshot.generation);
    expect(user.generation).toBe(snapshot.generation);

    const composerKeys = composer.items.map(i => i.key).sort();
    const userKeys = user.capabilities.map(i => i.key).sort();
    expect(composerKeys).toEqual(userKeys);
    // All resolved entries appear in the catalogs.
    expect(composerKeys).toEqual(snapshot.entries.map(e => e.summary.key).sort());
    expect(composer.items.find(item => item.key === 'source:ws:gmail')).toMatchObject({
      displayName: 'Gmail',
      description: 'Email and calendar',
      sourceType: 'api',
      iconUrl: 'data:image/png;base64,aWNvbi1vbmU=',
      mention: {
        type: 'source',
        id: 'gmail',
        qualifiedId: 'source:ws:gmail',
        selectedAsShortAlias: true,
        label: 'Gmail',
      },
    });
    expect(composer.items.find(item => item.key === 'plug:skill:alpha')).toMatchObject({
      displayName: 'Plugin Alpha',
      description: 'Plugin-projected alpha skill',
      mention: { label: 'Plugin Alpha' },
    });
    expect(runtime.sources.find(source => source.key === 'source:ws:gmail')!.guideResource).toMatchObject({
      resourceId: 'source:ws:gmail:guide',
      revision: 'guide-r1',
      contentHash: 'f'.repeat(64),
    });
    expect(runtime.permissionLayers.find(layer => layer.key === 'permission:ws:gmail')).toMatchObject({
      sourceSlug: 'gmail',
    });
    expect(snapshot.installedPlugins[0]!.bundleRootPath).toBe('/private/plugin-cache/demo');
    expect(JSON.stringify(composer)).not.toContain('guide.md');
    expect(JSON.stringify(user)).not.toContain('guide.md');
    expect(JSON.stringify(user)).not.toContain('/private/plugin-cache/demo');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('attaches CLAUDE_PLUGIN_OPTION env to hooks only, keeps values out of every view, and regenerates on a change', async () => {
    const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
    let optionEnvironment: Record<string, string> = {
      CLAUDE_PLUGIN_OPTION_API_TOKEN: 'SENSITIVE_OPTION_CANARY',
    };
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [
          pluginCandidate({
            key: 'plug:hook:pre',
            capabilityId: 'c-hook',
            kind: 'hook',
            logicalName: 'PreToolUse',
            runtimeDefinition: {
              id: 'c-hook',
              kind: 'hook',
              hook: { id: 'pre', event: 'PreToolUse', type: 'command', command: './notify.sh' },
            },
            resource: { pluginInstanceId: instanceId, relativePath: 'hooks/hooks.json', contentHash: 'c'.repeat(64) },
          }),
          pluginCandidate({
            key: 'plug:skill:alpha',
            capabilityId: 'c-skill',
            kind: 'skill',
            logicalName: 'alpha',
            resource: { pluginInstanceId: instanceId, relativePath: 'skills/alpha/SKILL.md', contentHash: 'c'.repeat(64) },
          }),
        ],
        pluginOptionEnvironmentFor: () => optionEnvironment,
      }),
    });

    const snapshot = await resolver.resolve(CONTEXT);
    const runtime = toAgentRuntime(snapshot);
    expect(runtime.hooks.find(hook => hook.key === 'plug:hook:pre')?.optionEnvironment)
      .toEqual({ CLAUDE_PLUGIN_OPTION_API_TOKEN: 'SENSITIVE_OPTION_CANARY' });
    // `:577` exports to HOOK processes; the skill binding for the same plugin
    // instance must not carry the values.
    expect(JSON.stringify(runtime.skills)).not.toContain('SENSITIVE_OPTION_CANARY');
    // No renderer-facing view ever sees a configured value.
    expect(JSON.stringify(toComposerCatalog(snapshot))).not.toContain('SENSITIVE_OPTION_CANARY');
    expect(JSON.stringify(toUserCatalog(snapshot))).not.toContain('SENSITIVE_OPTION_CANARY');
    // The generation is a digest, so it carries no value either.
    expect(snapshot.generation).not.toContain('SENSITIVE_OPTION_CANARY');
    resolver.releaseSnapshot(snapshot.leaseId);

    // A reconfigured option moves the generation; without that, a pinned
    // snapshot would keep exporting the old value.
    optionEnvironment = { CLAUDE_PLUGIN_OPTION_API_TOKEN: 'ROTATED_OPTION_CANARY' };
    const rotated = await resolver.resolve(CONTEXT);
    expect(rotated.generation).not.toBe(snapshot.generation);
    resolver.releaseSnapshot(rotated.leaseId);
  });

  it('persists path-free partial compatibility in the user catalog across reloads', async () => {
    const installed = installedPlugin();
    installed.compatibility = {
      format: 'codex',
      state: 'partial',
      supportedKinds: ['skill'],
      deferred: [{
        externalKind: 'lsp',
        reasonCode: 'plugin.deferred.codex_lsp',
        sourcePath: '/private/plugin-cache/demo/.codex/plugin.json',
      }],
      blocked: [],
    };
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({ installedPlugins: [installed] }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const safe = toUserCatalog(snapshot).installedPlugins[0];
    expect(safe?.compatibility).toEqual({
      state: 'partial',
      deferred: [{ externalKind: 'lsp', reasonCode: 'plugin.deferred.codex_lsp' }],
    });
    expect(JSON.stringify(safe)).not.toContain('/private/plugin-cache');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('keeps duplicate same-name skills as distinct qualified keys; picks one unqualified alias by nearest scope then native>plugin', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);
    const alphas = snapshot.entries.filter(e => e.summary.logicalName === 'alpha');
    expect(alphas).toHaveLength(2); // native workspace skill + plugin skill both retained
    const winners = alphas.filter(e => e.summary.selectedAsUnqualifiedAlias);
    expect(winners).toHaveLength(1);
    // native workspace (specificity 2, native) beats plugin (global, plugin)
    expect(winners[0]!.summary.origin).toBe('native');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('gives a skill\'s unqualified alias to the PERSONAL level over the project level', async () => {
    // `features-overview.md:193` — "**Skills and subagents** override by name:
    // when the same name exists at multiple levels, one definition wins based on
    // priority (managed > user > project for skills; managed > CLI flag >
    // project > user > plugin for subagents)." `skills.md:122` states it
    // independently: "When skills share the same name across levels, enterprise
    // overrides personal, and personal overrides project."
    //
    // Skills are the ONLY kind that inverts the scope chain, so each of the
    // three other arms is pinned as a negative control below.
    const inputs = makeInputs();
    inputs.nativeInventory.records.push(
      nativeRecord({ key: 'skill:global:deploy', kind: 'skill', logicalName: 'deploy', scope: { kind: 'global' } }),
      nativeRecord({
        key: 'skill:project:deploy',
        kind: 'skill',
        logicalName: 'deploy',
        scope: { kind: 'project', workspaceId: 'ws-1', projectKey: CONTEXT.projectKey! },
      }),
    );
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);
    const deploys = snapshot.entries.filter(e => e.summary.kind === 'skill' && e.summary.logicalName === 'deploy');
    expect(deploys).toHaveLength(2); // both retained, unlike MCP
    const global = deploys.find(e => e.summary.key === 'skill:global:deploy')!;
    const project = deploys.find(e => e.summary.key === 'skill:project:deploy')!;
    expect(global.summary.selectedAsUnqualifiedAlias).toBe(true);
    expect(project.summary.selectedAsUnqualifiedAlias).toBe(false);
    // The loser is qualified, never shadowed: it stays enabled under its own key.
    expect(project.summary.enabled).toBe(true);
    expect(project.summary.unavailableReason).toBeUndefined();
    expect(snapshot.diagnostics.some(d => d.code === 'capability.collision.unqualified-alias')).toBe(true);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('puts the administrator tier above every authored level, and keeps the subagent chain project-first', async () => {
    // P2.449. `skills.md:122` — "When skills share the same name across levels,
    // enterprise overrides personal" — and `features-overview.md:193`'s
    // "managed > user > project for skills". `builtin` is the machine-wide
    // administrator scope (`native-sources.ts`'s admin roots), so it takes the
    // bare name from a personal skill of the same slug.
    //
    // This assertion is what keeps the two loaders agreeing: `loadAllSkills`
    // (`skills/storage.ts`) writes the admin tier LAST into its slug map, so
    // admin wins there too. Inverting either one alone re-opens P6.8's
    // divergence on the same directories.
    //
    // The bundled clause of that same sentence is a DIFFERENT claim with a
    // different representation (`skillTier: 'bundled'`) and is asserted in the
    // test directly below — `builtin` is no longer the bundle's stand-in.
    //
    // Negative control in the same table: `sub-agents.md` and the subagent arm
    // of `features-overview.md:193` keep "project > user", so a global
    // inversion applied to every kind cannot pass this file.
    const inputs = makeInputs();
    inputs.nativeInventory.records.push(
      nativeRecord({ key: 'skill:builtin:review', kind: 'skill', logicalName: 'review', scope: { kind: 'builtin' } }),
      nativeRecord({ key: 'skill:global:review', kind: 'skill', logicalName: 'review', scope: { kind: 'global' } }),
      nativeRecord({ key: 'agent:global:triage', kind: 'agent', logicalName: 'triage', scope: { kind: 'global' } }),
      nativeRecord({
        key: 'agent:project:triage',
        kind: 'agent',
        logicalName: 'triage',
        scope: { kind: 'project', workspaceId: 'ws-1', projectKey: CONTEXT.projectKey! },
      }),
    );
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);
    const skillWinner = snapshot.entries
      .filter(e => e.summary.kind === 'skill' && e.summary.logicalName === 'review')
      .find(e => e.summary.selectedAsUnqualifiedAlias);
    expect(skillWinner?.summary.key).toBe('skill:builtin:review');
    const agentWinner = snapshot.entries
      .filter(e => e.summary.kind === 'agent' && e.summary.logicalName === 'triage')
      .find(e => e.summary.selectedAsUnqualifiedAlias);
    expect(agentWinner?.summary.key).toBe('agent:project:triage');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('ranks a SEEDED BUNDLED skill below project and above plugin, and below the administrator tier', async () => {
    // `skills.md:122` — "A skill at any of these levels also overrides a bundled
    // skill with the same name", worked example: "a `code-review` skill in your
    // project's `.claude/skills/` replaces the bundled `/code-review`".
    //
    // Scope alone cannot express that here: this fork SEEDS its bundled skills
    // into the personal root (`skills/seed.ts:ensureBundledSkills`), which is
    // pushed at `global` scope, so the personal-over-project inversion above
    // would hand the bundle the name. `skillTier: 'bundled'` is the tag
    // `storage-runtime.ts` stamps on exactly those records (R78); the test
    // directly above is the in-file control that an UNTAGGED global skill still
    // beats a project one, so it is the tag doing the work here, not the scope.
    const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
    const inputs = makeInputs({
      pluginCandidates: [
        pluginCandidate({
          key: 'plug:skill:loop',
          capabilityId: 'c-skill-loop',
          kind: 'skill',
          logicalName: 'loop',
          selectedScope: { kind: 'project', workspaceId: 'ws-1', projectKey: CONTEXT.projectKey! },
          resource: { pluginInstanceId: instanceId, relativePath: 'skills/loop/SKILL.md', contentHash: 'c'.repeat(64) },
        }),
      ],
    });
    const bundled = (logicalName: string) => nativeRecord({
      key: `skill:global:${logicalName}`,
      kind: 'skill',
      logicalName,
      scope: { kind: 'global' },
      skillTier: 'bundled',
    });
    inputs.nativeInventory.records.push(
      // The doc's own worked example.
      bundled('code-review'),
      nativeRecord({
        key: 'skill:project:code-review',
        kind: 'skill',
        logicalName: 'code-review',
        scope: { kind: 'project', workspaceId: 'ws-1', projectKey: CONTEXT.projectKey! },
      }),
      // Below the administrator tier: `builtin` is the machine-wide managed
      // scope since P2.449, and `skills.md:122`'s "enterprise overrides
      // personal" outranks a bundle seeded into the personal root. This is the
      // one direction the tag does NOT win, and it is asserted rather than
      // assumed because the tag is consulted BEFORE the scope.
      bundled('skill-creator'),
      nativeRecord({
        key: 'skill:builtin:skill-creator', kind: 'skill', logicalName: 'skill-creator', scope: { kind: 'builtin' },
      }),
      // ...and still above a plugin skill, which is out of contention entirely.
      bundled('loop'),
      // Uncontested: a bundled skill keeps its own short name.
      bundled('plugin-creator'),
    );
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);
    const winnerFor = (logicalName: string) => snapshot.entries
      .filter(e => e.summary.kind === 'skill' && e.summary.logicalName === logicalName)
      .find(e => e.summary.selectedAsUnqualifiedAlias)?.summary.key;
    expect(winnerFor('code-review')).toBe('skill:project:code-review');
    expect(winnerFor('skill-creator')).toBe('skill:builtin:skill-creator');
    expect(winnerFor('loop')).toBe('skill:global:loop');
    expect(winnerFor('plugin-creator')).toBe('skill:global:plugin-creator');
    // The displaced bundle stays enabled under its qualified key, never shadowed.
    const displaced = snapshot.entries.find(e => e.summary.key === 'skill:global:code-review')!;
    expect(displaced.summary.enabled).toBe(true);
    expect(displaced.summary.unavailableReason).toBeUndefined();
    expect(displaced.summary.skillTier).toBe('bundled');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('never lets a plugin skill take the unqualified alias from an authored level, at any scope', async () => {
    // THE HOLE the kind gate does not close. `skills.md:122` — "Plugin skills
    // use a `plugin-name:skill-name` namespace, so they cannot conflict with
    // other levels"; `features-overview.md:193` — "Plugin skills are namespaced
    // to avoid conflicts." Our plugin skill candidates carry the BARE slug as
    // `logicalName` (`plugins/projection-candidates.ts:200` pushes
    // `capability.skill.slug`), so they land in the very same
    // `${kind}\0${logicalName}` bucket as the native ones and DO contend.
    //
    // In production the contended scope is `project`, not `global`:
    // `storage-runtime.ts:1069 selectedCapabilityScope` hands
    // `resolvePluginProjectionCandidates` a `project` scope whenever the context
    // has a projectKey. Under the pre-fix ranking that made a plugin skill
    // outrank a PERSONAL skill of the same slug; under a `kind`-gated inversion
    // alone a `global`-scope plugin skill would outrank a project one. Both
    // directions are pinned here.
    const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
    const inputs = makeInputs({
      pluginCandidates: [
        pluginCandidate({
          key: 'plug:skill:deploy@project',
          capabilityId: 'c-skill-deploy',
          kind: 'skill',
          logicalName: 'deploy',
          selectedScope: { kind: 'project', workspaceId: 'ws-1', projectKey: CONTEXT.projectKey! },
          resource: { pluginInstanceId: instanceId, relativePath: 'skills/deploy/SKILL.md', contentHash: 'c'.repeat(64) },
        }),
        pluginCandidate({
          key: 'plug:skill:audit@global',
          capabilityId: 'c-skill-audit',
          kind: 'skill',
          logicalName: 'audit',
          selectedScope: { kind: 'global' },
          resource: { pluginInstanceId: instanceId, relativePath: 'skills/audit/SKILL.md', contentHash: 'c'.repeat(64) },
        }),
      ],
    });
    inputs.nativeInventory.records.push(
      nativeRecord({ key: 'skill:global:deploy', kind: 'skill', logicalName: 'deploy', scope: { kind: 'global' } }),
      nativeRecord({
        key: 'skill:project:audit',
        kind: 'skill',
        logicalName: 'audit',
        scope: { kind: 'project', workspaceId: 'ws-1', projectKey: CONTEXT.projectKey! },
      }),
    );
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);
    const winnerFor = (logicalName: string) => snapshot.entries
      .filter(e => e.summary.kind === 'skill' && e.summary.logicalName === logicalName)
      .find(e => e.summary.selectedAsUnqualifiedAlias);
    // project-scope plugin skill vs personal native skill → the personal one.
    expect(winnerFor('deploy')?.summary.key).toBe('skill:global:deploy');
    // global-scope plugin skill vs project native skill → the native one.
    expect(winnerFor('audit')?.summary.key).toBe('skill:project:audit');
    // The plugin entries are qualified, never suppressed.
    for (const key of ['plug:skill:deploy@project', 'plug:skill:audit@global']) {
      const plugin = snapshot.entries.find(e => e.summary.key === key)!;
      expect(plugin.summary.selectedAsUnqualifiedAlias).toBe(false);
      expect(plugin.summary.enabled).toBe(true);
    }
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('still gives a plugin skill the unqualified alias when no level claims the name', async () => {
    // The namespace exemption removes plugin skills from CONTENTION, not from
    // the short name: an uncontested plugin skill must keep being advertised as
    // `logicalName` (`prompt-builder.ts` falls back to the raw capability key
    // otherwise). The default fixture's `alpha` pair is the contested control.
    const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
    const inputs = makeInputs({
      pluginCandidates: [
        pluginCandidate({
          key: 'plug:skill:lonely',
          capabilityId: 'c-skill-lonely',
          kind: 'skill',
          logicalName: 'lonely',
          selectedScope: { kind: 'project', workspaceId: 'ws-1', projectKey: CONTEXT.projectKey! },
          resource: { pluginInstanceId: instanceId, relativePath: 'skills/lonely/SKILL.md', contentHash: 'c'.repeat(64) },
        }),
      ],
    });
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);
    const lonely = snapshot.entries.find(e => e.summary.key === 'plug:skill:lonely')!;
    expect(lonely.summary.selectedAsUnqualifiedAlias).toBe(true);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('prefers the same-scope nessy-native tier over portable for the unqualified alias', async () => {
    const inputs = makeInputs();
    inputs.nativeInventory.records.push(
      nativeRecord({
        key: 'skill:ws:dup:na', kind: 'skill', logicalName: 'dup', sourceTier: 'nessy',
      }),
      nativeRecord({
        key: 'skill:ws:dup:portable', kind: 'skill', logicalName: 'dup', sourceTier: 'portable',
      }),
    );
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);
    const dups = snapshot.entries.filter(e => e.summary.logicalName === 'dup');
    expect(dups).toHaveLength(2); // both stay addressable
    const winner = dups.find(e => e.summary.selectedAsUnqualifiedAlias);
    expect(winner?.summary.sourceTier).toBe('nessy');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('connects a cross-scope MCP duplicate once, from the nearest scope', async () => {
    // `mcp.md:431`: "When the same server is defined in more than one place,
    // Claude Code connects to it once, using the definition from the
    // highest-precedence source. The entire server entry from that source is
    // used; fields are not merged across scopes." Matched by name across the
    // scope tiers (`mcp.md:439`). Both used to be qualified and BOTH connected.
    const uniqueResolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const uniqueSnap = await uniqueResolver.resolve(CONTEXT);
    const fs = uniqueSnap.entries.find(e => e.summary.kind === 'mcp' && e.summary.logicalName === 'fs');
    expect(fs!.summary.selectedAsUnqualifiedAlias).toBe(true);
    uniqueResolver.releaseSnapshot(uniqueSnap.leaseId);

    const collide = makeInputs();
    collide.nativeInventory.records.push(
      nativeRecord({ key: 'mcp:global:fs', kind: 'mcp', logicalName: 'fs', scope: { kind: 'global' } }),
    );
    const collideResolver = createCapabilityResolver({ inputs: () => collide });
    const collideSnap = await collideResolver.resolve(CONTEXT);
    const mcps = collideSnap.entries.filter(e => e.summary.kind === 'mcp' && e.summary.logicalName === 'fs');
    // Both stay addressable in the catalog; only one reaches the runtime.
    expect(mcps).toHaveLength(2);
    const winner = mcps.find(e => e.summary.key === 'mcp:ws:fs')!;
    const shadowed = mcps.find(e => e.summary.key === 'mcp:global:fs')!;
    expect(winner.summary.enabled).toBe(true);
    expect(winner.summary.selectedAsUnqualifiedAlias).toBe(true);
    expect(shadowed.summary).toMatchObject({
      enabled: false,
      unavailableReason: 'shadowed-by-mcp-precedence',
    });
    expect(toAgentRuntime(collideSnap).mcpServers.map(server => server.wireName)).toEqual(['fs']);
    expect(collideSnap.diagnostics.some(d => d.code === 'capability.collision.mcp-scope-precedence')).toBe(true);
    expect(collideSnap.diagnostics.some(d => d.code === 'capability.collision.mcp-wire-alias')).toBe(false);
    collideResolver.releaseSnapshot(collideSnap.leaseId);
  });

  it('never lets a plugin MCP take a scoped server\'s bare name (`mcp.md:365`)', async () => {
    // Claude registers a plugin server as `plugin:<plugin-name>:<server-name>`
    // (`mcp.md:365`) ALWAYS, contested or not — so it can never take, move, or
    // break a scoped server's bare name. The scoped `fs` keeps its bare alias;
    // the plugin keeps its stable plugin-qualified wire name. Neither is
    // shadowed/disabled — this is the root-cause fix for the field incident
    // where a colliding plugin server stripped the BUILTIN's bare name too.
    const inputs = makeInputs({
      pluginCandidates: [pluginCandidate({
        key: 'plug:mcp:fs',
        capabilityId: 'fs',
        kind: 'mcp',
        logicalName: 'fs',
        runtimeDefinition: {
          kind: 'mcp',
          id: 'fs',
          mcp: { serverName: 'fs', transport: 'http', url: 'https://mcp.test/plugin-fs' },
        },
      })],
    });
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);
    const runtime = toAgentRuntime(snapshot);

    expect(runtime.mcpServers).toHaveLength(2);
    expect(new Set(runtime.mcpServers.map(server => server.wireName)))
      .toEqual(new Set(['fs', 'plugin_p_fs']));
    const scoped = snapshot.entries.find(e => e.summary.key === 'mcp:ws:fs')!;
    expect(scoped.summary.enabled).toBe(true);
    expect(scoped.summary.selectedAsUnqualifiedAlias).toBe(true);
    const plugin = snapshot.entries.find(e => e.summary.key === 'plug:mcp:fs')!;
    expect(plugin.summary.enabled).toBe(true);
    expect(plugin.summary.selectedAsUnqualifiedAlias).toBe(false);
    expect(snapshot.entries.filter(e => e.summary.logicalName === 'fs'
      && e.summary.unavailableReason === 'shadowed-by-mcp-precedence')).toHaveLength(0);
    expect(snapshot.diagnostics.some(d => d.code === 'capability.collision.mcp-wire-alias')).toBe(true);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('field-incident repro: an enabled builtin keeps its bare name; the colliding plugin copy gets a qualified one', async () => {
    // 2026-08-10 incident: a marketplace plugin declared an MCP server named
    // like a built-in dp server (`t-tracker`). The OLD collision policy
    // stripped the bare name from EVERY contender in the bucket — including
    // the builtin — while the builtin fold still materialized it under the
    // bare name regardless, so the pool and the manifest seed disagreed and
    // every chat turn threw. This pins the fix: the builtin is untouched by
    // plugin contention.
    const inputs = makeInputs({
      pluginCandidates: [pluginCandidate({
        key: 'plug:mcp:t-tracker',
        capabilityId: 't-tracker',
        kind: 'mcp',
        logicalName: 't-tracker',
        runtimeDefinition: {
          kind: 'mcp',
          id: 't-tracker',
          mcp: { serverName: 't-tracker', transport: 'http', url: 'https://mcp.test/plugin-t-tracker' },
        },
      })],
    });
    inputs.nativeInventory.records.push(
      nativeRecord({
        key: 'mcp:builtin:t-tracker', kind: 'mcp', logicalName: 't-tracker', scope: { kind: 'builtin' },
      }),
    );
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);
    const runtime = toAgentRuntime(snapshot);

    const wireNames = new Set(
      runtime.mcpServers
        .filter(server => server.key === 'mcp:builtin:t-tracker' || server.key === 'plug:mcp:t-tracker')
        .map(server => server.wireName),
    );
    expect(wireNames).toEqual(new Set(['t-tracker', 'plugin_p_t-tracker']));
    const builtin = snapshot.entries.find(e => e.summary.key === 'mcp:builtin:t-tracker')!;
    expect(builtin.summary.enabled).toBe(true);
    expect(builtin.summary.selectedAsUnqualifiedAlias).toBe(true);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  describe('T4: builtin-identity dedup (`mcp.md:457`)', () => {
    // `storage-runtime.ts:646` pins the real pairing this repro is built on:
    // capability `t-tracker` IS the `dp ai mcp tracker` subcommand.
    const builtinTTracker = (over: Partial<NativeCapabilitySourceRecord> = {}) => nativeRecord({
      key: 'mcp:builtin:t-tracker', kind: 'mcp', logicalName: 't-tracker', scope: { kind: 'builtin' },
      mcpServerIdentity: { transport: 'stdio', command: ['dp', 'ai', 'mcp', 'tracker'] },
      ...over,
    });
    const stdioClone = (args: string[]) => pluginCandidate({
      key: 'plug:mcp:tracker-clone',
      capabilityId: 'tracker-clone',
      kind: 'mcp',
      logicalName: 'tracker-clone',
      runtimeDefinition: {
        kind: 'mcp',
        id: 'tracker-clone',
        mcp: { serverName: 'tracker-clone', transport: 'stdio', command: 'dp', args },
      },
    });

    it("an ENABLED builtin force-disables a plugin's declared stdio duplicate of its `dp ai mcp <sub>` identity", async () => {
      // `mcp.md:457`: "Plugins and connectors match by endpoint." Bundles are
      // immutable and hash-verified, so this is an ACTIVATION decision
      // (`enabled: false` + a reason), never a bundle mutation — the plugin's
      // own declared definition is untouched.
      const inputs = makeInputs({ pluginCandidates: [stdioClone(['ai', 'mcp', 'tracker'])] });
      inputs.nativeInventory.records.push(builtinTTracker());
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const plugin = snapshot.entries.find(e => e.summary.key === 'plug:mcp:tracker-clone')!;
      expect(plugin.summary.enabled).toBe(false);
      expect(plugin.summary.unavailableReason).toBe('duplicates-builtin');
      expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
        code: 'capability.dedup.builtin-identity',
        capabilityKey: 'plug:mcp:tracker-clone',
      }));
      // The builtin itself is never a party to the plugin's activation decision.
      const builtin = snapshot.entries.find(e => e.summary.key === 'mcp:builtin:t-tracker')!;
      expect(builtin.summary.enabled).toBe(true);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('a DISABLED builtin does NOT force-disable the plugin copy — the user turned it off so the plugin can serve', async () => {
      const inputs = makeInputs({ pluginCandidates: [stdioClone(['ai', 'mcp', 'tracker'])] });
      inputs.nativeInventory.records.push(builtinTTracker({ sourceEnabled: false }));
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const plugin = snapshot.entries.find(e => e.summary.key === 'plug:mcp:tracker-clone')!;
      expect(plugin.summary.enabled).toBe(true);
      expect(plugin.summary.unavailableReason).toBeUndefined();
      expect(snapshot.diagnostics.some(d => d.code === 'capability.dedup.builtin-identity')).toBe(false);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('a plugin declaring a DIFFERENT dp subcommand than any enabled builtin is untouched', async () => {
      const inputs = makeInputs({ pluginCandidates: [stdioClone(['ai', 'mcp', 'other'])] });
      inputs.nativeInventory.records.push(builtinTTracker());
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const plugin = snapshot.entries.find(e => e.summary.key === 'plug:mcp:tracker-clone')!;
      expect(plugin.summary.enabled).toBe(true);
      expect(plugin.summary.unavailableReason).toBeUndefined();
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('matching by NAME alone never triggers this pass — a non-stdio same-name plugin stays `mcp.md:365`\'s territory', async () => {
      // Same shape as the T2 field-incident repro (http transport, same
      // logical name as the builtin) — proves T4 leaves it alone: no declared
      // stdio argv, so no identity to compare. Name collisions are
      // `shadowed-by-mcp-precedence`'s job (and plugins are exempt from that
      // one too, per `mcp.md:365`), never this pass's.
      const inputs = makeInputs({
        pluginCandidates: [pluginCandidate({
          key: 'plug:mcp:t-tracker',
          capabilityId: 't-tracker',
          kind: 'mcp',
          logicalName: 't-tracker',
          runtimeDefinition: {
            kind: 'mcp',
            id: 't-tracker',
            mcp: { serverName: 't-tracker', transport: 'http', url: 'https://mcp.test/plugin-t-tracker' },
          },
        })],
      });
      inputs.nativeInventory.records.push(builtinTTracker());
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const plugin = snapshot.entries.find(e => e.summary.key === 'plug:mcp:t-tracker')!;
      expect(plugin.summary.enabled).toBe(true);
      expect(plugin.summary.unavailableReason).not.toBe('duplicates-builtin');
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it("F2: names the plugin's own hook and skill that reference the now-inert server, and leaves a different-server reference off the list", async () => {
      // Same trigger as the first T4 case above, plus content FROM THE SAME
      // PLUGIN that references its own (now-disabled) t-tracker server: a
      // hook by exact `mcpTool` and a skill by wildcard `allowed-tools`. Both
      // must be named on the diagnostic; a hook referencing a DIFFERENT
      // server (the negative arm) must not be.
      const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
      const inputs = makeInputs({
        pluginCandidates: [
          pluginCandidate({
            key: 'plug:mcp:t-tracker',
            capabilityId: 't-tracker',
            kind: 'mcp',
            logicalName: 't-tracker',
            runtimeDefinition: {
              kind: 'mcp',
              id: 't-tracker',
              mcp: { serverName: 't-tracker', transport: 'stdio', command: 'dp', args: ['ai', 'mcp', 'tracker'] },
            },
          }),
          pluginCandidate({
            key: 'plug:hook:t-tracker-list',
            capabilityId: 'c-hook-list',
            kind: 'hook',
            logicalName: 'PreToolUse',
            runtimeDefinition: {
              id: 'c-hook-list',
              kind: 'hook',
              hook: { id: 'list', event: 'PreToolUse', type: 'mcp', mcpTool: 'mcp__t-tracker__list' },
            },
            resource: { pluginInstanceId: instanceId, relativePath: 'hooks/hooks.json', contentHash: 'c'.repeat(64) },
          }),
          pluginCandidate({
            key: 'plug:skill:tracker-skill',
            capabilityId: 'c-skill-tracker',
            kind: 'skill',
            logicalName: 'tracker-skill',
            resource: { pluginInstanceId: instanceId, relativePath: 'skills/tracker-skill/SKILL.md', contentHash: 'c'.repeat(64) },
            runtimeDefinition: {
              id: 'c-skill-tracker',
              kind: 'skill',
              skill: { slug: 'tracker-skill', path: 'skills/tracker-skill/SKILL.md', allowedTools: ['mcp__t-tracker__*'] },
            },
          }),
          // The other accepted shape: content that already carries the
          // fully-qualified minted wire form rather than the bare name. A
          // correctly-written Claude plugin references its own server this
          // way, and T3's translation pass rewrites bare references into it,
          // so a resolved snapshot legitimately contains both spellings.
          pluginCandidate({
            key: 'plug:hook:t-tracker-wire',
            capabilityId: 'c-hook-wire',
            kind: 'hook',
            logicalName: 'Stop',
            runtimeDefinition: {
              id: 'c-hook-wire',
              kind: 'hook',
              hook: { id: 'wire', event: 'Stop', type: 'mcp', mcpTool: 'mcp__plugin_p_t-tracker__list' },
            },
            resource: { pluginInstanceId: instanceId, relativePath: 'hooks/hooks.json', contentHash: 'e'.repeat(64) },
          }),
          // Negative arm: the same plugin's hook references a DIFFERENT
          // server and must not appear in the inert list.
          pluginCandidate({
            key: 'plug:hook:foreign',
            capabilityId: 'c-hook-foreign',
            kind: 'hook',
            logicalName: 'PostToolUse',
            runtimeDefinition: {
              id: 'c-hook-foreign',
              kind: 'hook',
              hook: { id: 'foreign', event: 'PostToolUse', type: 'mcp', mcpTool: 'mcp__dpJira__search' },
            },
            resource: { pluginInstanceId: instanceId, relativePath: 'hooks/hooks.json', contentHash: 'd'.repeat(64) },
          }),
        ],
      });
      inputs.nativeInventory.records.push(builtinTTracker());
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const plugin = snapshot.entries.find(e => e.summary.key === 'plug:mcp:t-tracker')!;
      expect(plugin.summary.enabled).toBe(false);
      expect(plugin.summary.unavailableReason).toBe('duplicates-builtin');
      const diagnostic = snapshot.diagnostics.find(d => d.code === 'capability.dedup.builtin-identity')!;
      expect(diagnostic.safeArgs?.inertComponents).toBe('hook:PreToolUse, hook:Stop, skill:tracker-skill');
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it("F2 on the INSTALLED road: a skill's `allowed-tools` survives the install-path normalizer, so the stood-down server still names it", async () => {
      // The arm above hand-builds `runtimeDefinition`, and that is exactly how
      // the install-path normalizer's silent drop of `skill.allowedTools` and
      // `skill.paths` stayed invisible until the G6 live gate drove a real
      // bundle through a real install (2026-08-11 — the F2–F4 plan's Deviations
      // log). This one starts from the raw manifest an adapter emits and
      // crosses BOTH production steps before the resolver sees anything:
      // `normalizeNessyPluginManifest` (the same call `management-service-v2.ts:857`
      // makes on install) then `resolvePluginProjectionCandidates`.
      const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
      const normalized = normalizeNessyPluginManifest({
        kind: 'plugin',
        id: 'p',
        name: 'Plugin P',
        version: '1.0.0',
        capabilities: [
          {
            kind: 'mcp',
            id: 't-tracker',
            mcp: { serverName: 't-tracker', transport: 'stdio', command: 'dp', args: ['ai', 'mcp', 'tracker'] },
          },
          {
            kind: 'skill',
            id: 'c-skill-tracker',
            skill: {
              slug: 'tracker-skill',
              path: 'skills/tracker-skill/SKILL.md',
              allowedTools: ['mcp__t-tracker__*'],
              paths: ['src/**/*.ts'],
            },
          },
        ],
      });
      expect(normalized.ok).toBe(true);
      const candidates = resolvePluginProjectionCandidates([{
        pluginInstanceId: instanceId,
        pluginKey: 'pk-1',
        marketplaceId: 'm',
        pluginId: 'p',
        version: '1.0.0',
        bundleHash: 'b'.repeat(64),
        cacheRef: { marketplaceId: 'm', pluginId: 'p', version: '1.0.0', bundleHash: 'b'.repeat(64) },
        manifest: normalized.value!,
        origin: { source: 'marketplace', resolvedAt: 0 },
        installedAt: 1000,
        diagnostics: [],
      }], { kind: 'global' });

      const inputs = makeInputs({ pluginCandidates: candidates });
      inputs.nativeInventory.records.push(builtinTTracker());
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const skill = snapshot.entries.find(e => e.summary.kind === 'skill' && e.summary.logicalName === 'tracker-skill')!;
      // T3's bare→wire translation rides this same field, so a surviving value
      // proves that pass is alive on the installed-plugin road too.
      expect(skill.summary.skillAllowedTools).toEqual(['mcp__plugin_p_t-tracker__*']);
      expect(skill.summary.skillPaths).toEqual(['src/**/*.ts']);
      const diagnostic = snapshot.diagnostics.find(d => d.code === 'capability.dedup.builtin-identity')!;
      expect(diagnostic.safeArgs?.inertComponents).toBe('skill:tracker-skill');
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    /**
     * P6.556 — the THIRD accepted shape. `sub-agents.md` § *Available tools*:
     * "Both fields accept MCP server-level patterns in addition to exact tool
     * names: `mcp__<server>` or `mcp__<server>__*` grants or removes every tool
     * from the named server."
     *
     * Both resolver passes that read this field are asserted in one test on
     * purpose: the T3 translation (which mints the wire name) and
     * `inertPluginComponentNames` (which says what went quiet with a stood-down
     * server). They had TWO shapes each and drifting them apart is the exact bug
     * the second pass's comment warns about.
     */
    const trackerSkillWithAllowedTools = (allowedTools: string[]) => {
      const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
      const normalized = normalizeNessyPluginManifest({
        kind: 'plugin',
        id: 'p',
        name: 'Plugin P',
        version: '1.0.0',
        capabilities: [
          {
            kind: 'mcp',
            id: 't-tracker',
            mcp: { serverName: 't-tracker', transport: 'stdio', command: 'dp', args: ['ai', 'mcp', 'tracker'] },
          },
          {
            kind: 'skill',
            id: 'c-skill-tracker',
            skill: { slug: 'tracker-skill', path: 'skills/tracker-skill/SKILL.md', allowedTools },
          },
        ],
      });
      expect(normalized.ok).toBe(true);
      return resolvePluginProjectionCandidates([{
        pluginInstanceId: instanceId,
        pluginKey: 'pk-1',
        marketplaceId: 'm',
        pluginId: 'p',
        version: '1.0.0',
        bundleHash: 'b'.repeat(64),
        cacheRef: { marketplaceId: 'm', pluginId: 'p', version: '1.0.0', bundleHash: 'b'.repeat(64) },
        manifest: normalized.value!,
        origin: { source: 'marketplace', resolvedAt: 0 },
        installedAt: 1000,
        diagnostics: [],
      }], { kind: 'global' });
    };

    it('P6.556: the BARE server-level form `mcp__<server>` is qualified to the minted wire name, and names the skill when that server stands down', async () => {
      const inputs = makeInputs({ pluginCandidates: trackerSkillWithAllowedTools(['mcp__t-tracker']) });
      inputs.nativeInventory.records.push(builtinTTracker());
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const skill = snapshot.entries.find(e => e.summary.kind === 'skill' && e.summary.logicalName === 'tracker-skill')!;
      expect(skill.summary.skillAllowedTools).toEqual(['mcp__plugin_p_t-tracker']);
      const diagnostic = snapshot.diagnostics.find(d => d.code === 'capability.dedup.builtin-identity')!;
      expect(diagnostic.safeArgs?.inertComponents).toBe('skill:tracker-skill');
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('P6.556 control: a bare reference to a server this plugin does NOT bundle is left as written and never named as inert', async () => {
      const inputs = makeInputs({ pluginCandidates: trackerSkillWithAllowedTools(['mcp__dpJira']) });
      inputs.nativeInventory.records.push(builtinTTracker());
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const skill = snapshot.entries.find(e => e.summary.kind === 'skill' && e.summary.logicalName === 'tracker-skill')!;
      expect(skill.summary.skillAllowedTools).toEqual(['mcp__dpJira']);
      const diagnostic = snapshot.diagnostics.find(d => d.code === 'capability.dedup.builtin-identity')!;
      expect(diagnostic.safeArgs?.inertComponents).toBeUndefined();
      resolver.releaseSnapshot(snapshot.leaseId);
    });
  });

  describe('T4b: endpoint dedup for plugin pairs (`mcp.md:457`, second half)', () => {
    // Builtin identity is T4's territory (just above); T4b settles the other
    // half of `mcp.md:457` — plugin-vs-plugin ONLY (Fix 3, review pass,
    // 2026-08-10: scoped/native entries are excluded outright — see (d) below
    // and the comment on `declaredEndpointIdentity`). Identity is DECLARED
    // values only (never the materialized/rewritten command), so a false
    // positive can never kill a working server for a reason the user cannot
    // see coming.
    const remoteCandidate = (
      key: string,
      url: string,
      env?: Record<string, string>,
      environmentDefaults?: Record<string, string>,
      headersHelper?: string,
    ) => pluginCandidate({
      key,
      capabilityId: key,
      kind: 'mcp',
      logicalName: key,
      runtimeDefinition: {
        kind: 'mcp',
        id: key,
        mcp: {
          serverName: key,
          transport: 'http',
          url,
          ...(env ? { env } : {}),
          ...(environmentDefaults ? { environmentDefaults } : {}),
          ...(headersHelper ? { headersHelper } : {}),
        },
      },
    });
    const stdioCandidate = (
      key: string,
      args: string[],
      env?: Record<string, string>,
      environmentDefaults?: Record<string, string>,
    ) => pluginCandidate({
      key,
      capabilityId: key,
      kind: 'mcp',
      logicalName: key,
      runtimeDefinition: {
        kind: 'mcp',
        id: key,
        mcp: {
          serverName: key,
          transport: 'stdio',
          command: 'node',
          args,
          ...(env ? { env } : {}),
          ...(environmentDefaults ? { environmentDefaults } : {}),
        },
      },
    });

    it('(a) two plugins declaring the same URL: the lexically-smaller key wins, the other is `duplicates-endpoint`', async () => {
      // Declared out of lexical order (`b-server` first, `a-server` second) to
      // prove the winner is picked by stable key comparison, never by which
      // one happened to resolve first in `entries`.
      const inputs = makeInputs({
        pluginCandidates: [
          remoteCandidate('plug:mcp:b-server', 'https://mcp.test/shared-endpoint'),
          remoteCandidate('plug:mcp:a-server', 'https://mcp.test/shared-endpoint'),
        ],
      });
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const winner = snapshot.entries.find(e => e.summary.key === 'plug:mcp:a-server')!;
      const loser = snapshot.entries.find(e => e.summary.key === 'plug:mcp:b-server')!;
      expect(winner.summary.enabled).toBe(true);
      expect(winner.summary.unavailableReason).toBeUndefined();
      expect(loser.summary.enabled).toBe(false);
      expect(loser.summary.unavailableReason).toBe('duplicates-endpoint');
      expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
        code: 'capability.dedup.endpoint-identity',
        capabilityKey: 'plug:mcp:b-server',
      }));
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('(b) two plugins declaring the same stdio command+args: the lexically-smaller key wins', async () => {
      const inputs = makeInputs({
        pluginCandidates: [
          stdioCandidate('plug:mcp:d-stdio', ['server.js', '--flag']),
          stdioCandidate('plug:mcp:c-stdio', ['server.js', '--flag']),
        ],
      });
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const winner = snapshot.entries.find(e => e.summary.key === 'plug:mcp:c-stdio')!;
      const loser = snapshot.entries.find(e => e.summary.key === 'plug:mcp:d-stdio')!;
      expect(winner.summary.enabled).toBe(true);
      expect(loser.summary.enabled).toBe(false);
      expect(loser.summary.unavailableReason).toBe('duplicates-endpoint');
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('(b2) two plugins whose stdio command/args split differently but used to space-join identically: JSON encoding keeps them distinct', async () => {
      // Fix 2 (review pass, 2026-08-10): the old identity was
      // `stdio:${command} ${args.join(' ')}` — a command containing a space
      // (a Windows `Program Files` path) could collide with an unrelated
      // (command, args) split that happens to space-join to the same string.
      // Both entries below space-join to `C:\Program Files\node.exe server.js`
      // but declare genuinely different commands; `JSON.stringify([command,
      // ...args])` keeps them distinct.
      const inputs = makeInputs({
        pluginCandidates: [
          pluginCandidate({
            key: 'plug:mcp:win-split-a',
            capabilityId: 'plug:mcp:win-split-a',
            kind: 'mcp',
            logicalName: 'plug:mcp:win-split-a',
            runtimeDefinition: {
              kind: 'mcp',
              id: 'plug:mcp:win-split-a',
              mcp: { serverName: 'plug:mcp:win-split-a', transport: 'stdio', command: 'C:\\Program Files\\node.exe', args: ['server.js'] },
            },
          }),
          pluginCandidate({
            key: 'plug:mcp:win-split-b',
            capabilityId: 'plug:mcp:win-split-b',
            kind: 'mcp',
            logicalName: 'plug:mcp:win-split-b',
            runtimeDefinition: {
              kind: 'mcp',
              id: 'plug:mcp:win-split-b',
              mcp: { serverName: 'plug:mcp:win-split-b', transport: 'stdio', command: 'C:\\Program', args: ['Files\\node.exe', 'server.js'] },
            },
          }),
        ],
      });
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const a = snapshot.entries.find(e => e.summary.key === 'plug:mcp:win-split-a')!;
      const b = snapshot.entries.find(e => e.summary.key === 'plug:mcp:win-split-b')!;
      expect(a.summary.enabled).toBe(true);
      expect(a.summary.unavailableReason).toBeUndefined();
      expect(b.summary.enabled).toBe(true);
      expect(b.summary.unavailableReason).toBeUndefined();
      expect(snapshot.diagnostics.some(d => d.code === 'capability.dedup.endpoint-identity')).toBe(false);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('(c) same stdio argv but different declared env: BOTH stay enabled — credentialed twins are never deduped', async () => {
      const inputs = makeInputs({
        pluginCandidates: [
          stdioCandidate('plug:mcp:tenant-a', ['server.js'], { TOKEN: 'tenant-a-secret' }),
          stdioCandidate('plug:mcp:tenant-b', ['server.js'], { TOKEN: 'tenant-b-secret' }),
        ],
      });
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const a = snapshot.entries.find(e => e.summary.key === 'plug:mcp:tenant-a')!;
      const b = snapshot.entries.find(e => e.summary.key === 'plug:mcp:tenant-b')!;
      expect(a.summary.enabled).toBe(true);
      expect(a.summary.unavailableReason).toBeUndefined();
      expect(b.summary.enabled).toBe(true);
      expect(b.summary.unavailableReason).toBeUndefined();
      expect(snapshot.diagnostics.some(d => d.code === 'capability.dedup.endpoint-identity')).toBe(false);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('(c2) same URL and same env/headers but different declared environmentDefaults: BOTH stay enabled', async () => {
      // Fix 1 (review pass, 2026-08-10): `descriptorEnvironmentDefaults` is
      // merged into the spawn environment by `materializeMcpDescriptorEnvironment`
      // (`mcp/server-config-values.ts`) — a key present only in the defaults
      // still reaches the child process, so a difference here is a real
      // declared-credential difference the fingerprint must not erase.
      const inputs = makeInputs({
        pluginCandidates: [
          remoteCandidate('plug:mcp:default-a', 'https://mcp.test/defaults-endpoint', undefined, { REGION: 'us' }),
          remoteCandidate('plug:mcp:default-b', 'https://mcp.test/defaults-endpoint', undefined, { REGION: 'eu' }),
        ],
      });
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const a = snapshot.entries.find(e => e.summary.key === 'plug:mcp:default-a')!;
      const b = snapshot.entries.find(e => e.summary.key === 'plug:mcp:default-b')!;
      expect(a.summary.enabled).toBe(true);
      expect(a.summary.unavailableReason).toBeUndefined();
      expect(b.summary.enabled).toBe(true);
      expect(b.summary.unavailableReason).toBeUndefined();
      expect(snapshot.diagnostics.some(d => d.code === 'capability.dedup.endpoint-identity')).toBe(false);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('(c3) same URL and same env/headers but different declared headersHelper: BOTH stay enabled', async () => {
      // Fix 1 (review pass, 2026-08-10): `descriptorHeadersHelper` is the
      // declared dynamic-header shell command run by `resolveMcpDynamicHeaders`
      // (`mcp/headers-helper.ts`) and merged into connection headers — a
      // first-class per-server credential mechanism, not a value to skip.
      const inputs = makeInputs({
        pluginCandidates: [
          remoteCandidate('plug:mcp:helper-a', 'https://mcp.test/helper-endpoint', undefined, undefined, 'print-token --tenant a'),
          remoteCandidate('plug:mcp:helper-b', 'https://mcp.test/helper-endpoint', undefined, undefined, 'print-token --tenant b'),
        ],
      });
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const a = snapshot.entries.find(e => e.summary.key === 'plug:mcp:helper-a')!;
      const b = snapshot.entries.find(e => e.summary.key === 'plug:mcp:helper-b')!;
      expect(a.summary.enabled).toBe(true);
      expect(a.summary.unavailableReason).toBeUndefined();
      expect(b.summary.enabled).toBe(true);
      expect(b.summary.unavailableReason).toBeUndefined();
      expect(snapshot.diagnostics.some(d => d.code === 'capability.dedup.endpoint-identity')).toBe(false);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('(c4) two plugins with identical URL and no literal env/headers/defaults/helper, differing only in endpointAuth: BOTH stay enabled — different OAuth/bearer credential slots are never deduped', async () => {
      // Review finding (task 4b, fix pass 2, 2026-08-10): `endpointAuth`
      // names the GLOBAL plugin credential slot
      // (`pluginMcpCredentialId(authType, pluginKey, serverName)`,
      // `plugins/mcp-credentials.ts`) an oauth/bearer server binds to — and an
      // oauth/bearer server declares NO literal env, headers,
      // environmentDefaults or headersHelper at all (the secret lives
      // entirely in that slot). Two DIFFERENT plugins (different marketplace
      // publishers, different `pluginKey`) each bundling a connector to the
      // same well-known third-party API used to fingerprint identically and
      // get deduped — silently merging two different users' OAuth grants
      // into one server. `serverName` is held IDENTICAL between the two
      // entries so the only declared difference is `endpointAuth.pluginKey`.
      const inputs = makeInputs({
        pluginCandidates: [
          pluginCandidate({
            key: 'plug:mcp:oauth-vendor-a',
            capabilityId: 'plug:mcp:oauth-vendor-a',
            kind: 'mcp',
            logicalName: 'plug:mcp:oauth-vendor-a',
            pluginKey: 'pk-vendor-a',
            pluginInstanceId: 'plugin://m/vendor-a@1.0.0#' + 'a'.repeat(64),
            runtimeDefinition: {
              kind: 'mcp',
              id: 'plug:mcp:oauth-vendor-a',
              mcp: { serverName: 'shared-api', transport: 'http', url: 'https://mcp.test/oauth-endpoint', authType: 'oauth' },
            },
          }),
          pluginCandidate({
            key: 'plug:mcp:oauth-vendor-b',
            capabilityId: 'plug:mcp:oauth-vendor-b',
            kind: 'mcp',
            logicalName: 'plug:mcp:oauth-vendor-b',
            pluginKey: 'pk-vendor-b',
            pluginInstanceId: 'plugin://m/vendor-b@1.0.0#' + 'c'.repeat(64),
            runtimeDefinition: {
              kind: 'mcp',
              id: 'plug:mcp:oauth-vendor-b',
              mcp: { serverName: 'shared-api', transport: 'http', url: 'https://mcp.test/oauth-endpoint', authType: 'oauth' },
            },
          }),
        ],
      });
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const a = snapshot.entries.find(e => e.summary.key === 'plug:mcp:oauth-vendor-a')!;
      const b = snapshot.entries.find(e => e.summary.key === 'plug:mcp:oauth-vendor-b')!;
      expect(a.summary.enabled).toBe(true);
      expect(a.summary.unavailableReason).toBeUndefined();
      expect(b.summary.enabled).toBe(true);
      expect(b.summary.unavailableReason).toBeUndefined();
      expect(snapshot.diagnostics.some(d => d.code === 'capability.dedup.endpoint-identity')).toBe(false);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('(c5) two plugins identical in every folded field including endpointAuth: still deduped to exactly one enabled', async () => {
      // Guards against a too-broad fix: proves widening the identity to
      // include `endpointAuth`/`credentialEnvironment` did not accidentally
      // make every plugin pair distinct (which would silently disable T4b
      // entirely). Same pluginKey, same serverName, same URL, same authType,
      // no oauthResource/clientId, no env/headers/defaults/helper on either —
      // a genuine same-endpoint duplicate must still collapse to one. Declared
      // out of lexical order, like (a), to prove the winner is picked by
      // stable key comparison rather than array order.
      const inputs = makeInputs({
        pluginCandidates: [
          pluginCandidate({
            key: 'plug:mcp:oauth-twin-b',
            capabilityId: 'plug:mcp:oauth-twin-b',
            kind: 'mcp',
            logicalName: 'plug:mcp:oauth-twin-b',
            runtimeDefinition: {
              kind: 'mcp',
              id: 'plug:mcp:oauth-twin-b',
              mcp: { serverName: 'twin-api', transport: 'http', url: 'https://mcp.test/oauth-twin-endpoint', authType: 'oauth' },
            },
          }),
          pluginCandidate({
            key: 'plug:mcp:oauth-twin-a',
            capabilityId: 'plug:mcp:oauth-twin-a',
            kind: 'mcp',
            logicalName: 'plug:mcp:oauth-twin-a',
            runtimeDefinition: {
              kind: 'mcp',
              id: 'plug:mcp:oauth-twin-a',
              mcp: { serverName: 'twin-api', transport: 'http', url: 'https://mcp.test/oauth-twin-endpoint', authType: 'oauth' },
            },
          }),
        ],
      });
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const winner = snapshot.entries.find(e => e.summary.key === 'plug:mcp:oauth-twin-a')!;
      const loser = snapshot.entries.find(e => e.summary.key === 'plug:mcp:oauth-twin-b')!;
      expect(winner.summary.enabled).toBe(true);
      expect(winner.summary.unavailableReason).toBeUndefined();
      expect(loser.summary.enabled).toBe(false);
      expect(loser.summary.unavailableReason).toBe('duplicates-endpoint');
      expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({
        code: 'capability.dedup.endpoint-identity',
        capabilityKey: 'plug:mcp:oauth-twin-b',
      }));
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('(c6) two plugins with identical URL and no literal env/headers/defaults/helper/endpointAuth, differing only in credentialEnvironment key set: BOTH stay enabled', async () => {
      // The smaller instance of the same root cause (task 4b, fix pass 2,
      // 2026-08-10): `RuntimeMcpServer.credentialEnvironment` — the MCPB
      // named credential-slot bindings (declared child-env-name → config-key
      // map, `PluginMcpDescriptor.credentialEnvironment`) — was likewise
      // never read by the identity. Two plugins whose only declared
      // difference is WHICH credential slot they each bind must never be
      // treated as one server.
      const candidateA = pluginCandidate({
        key: 'plug:mcp:cred-slot-a',
        capabilityId: 'plug:mcp:cred-slot-a',
        kind: 'mcp',
        logicalName: 'plug:mcp:cred-slot-a',
        runtimeDefinition: {
          kind: 'mcp',
          id: 'plug:mcp:cred-slot-a',
          mcp: {
            serverName: 'credentialed-api',
            transport: 'http',
            url: 'https://mcp.test/credentialed-endpoint',
            credentialEnvironment: { API_KEY: 'api_key' },
            requiredEnvironmentNames: ['API_KEY'],
          },
        },
      });
      const candidateB = pluginCandidate({
        key: 'plug:mcp:cred-slot-b',
        capabilityId: 'plug:mcp:cred-slot-b',
        kind: 'mcp',
        logicalName: 'plug:mcp:cred-slot-b',
        runtimeDefinition: {
          kind: 'mcp',
          id: 'plug:mcp:cred-slot-b',
          mcp: {
            serverName: 'credentialed-api',
            transport: 'http',
            url: 'https://mcp.test/credentialed-endpoint',
            credentialEnvironment: { OTHER_TOKEN: 'other_token' },
            requiredEnvironmentNames: ['OTHER_TOKEN'],
          },
        },
      });
      const inputs = makeInputs({
        pluginCandidates: [candidateA, candidateB],
        credentialRefsFor: (key: string): Record<string, string> =>
          (key === candidateA.key ? { API_KEY: 'ref-a' } : { OTHER_TOKEN: 'ref-b' }),
        resolveCredentialStatus: () => ({ state: 'ready', revision: '1' }),
        bindCredential: () => ({
          id: { type: 'source_apikey', workspaceId: 'ws-1', sourceId: 'credentialed-api' },
          expectedRevision: 1,
        }),
      });
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const a = snapshot.entries.find(e => e.summary.key === 'plug:mcp:cred-slot-a')!;
      const b = snapshot.entries.find(e => e.summary.key === 'plug:mcp:cred-slot-b')!;
      expect(a.summary.enabled).toBe(true);
      expect(a.summary.unavailableReason).toBeUndefined();
      expect(b.summary.enabled).toBe(true);
      expect(b.summary.unavailableReason).toBeUndefined();
      expect(snapshot.diagnostics.some(d => d.code === 'capability.dedup.endpoint-identity')).toBe(false);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('(c7) two plugin entries, same url, nothing else declared, differing only in forwardedEnvironmentSources: BOTH stay enabled', async () => {
      // Disclosed residual, closed (task 4b, fix pass 3, 2026-08-10):
      // `SdkMcpServerConfigWithoutSecrets.forwardedEnvironmentSources` — a
      // plugin-declared `{ childEnvName: hostEnvVarName }` forwarding map
      // (`PluginMcpDescriptor.environmentSources`, `plugins/types.ts`: "Child
      // environment name to optional host source name forwarding map") — is a
      // live credential mechanism: `materializePluginMcpForwardedEnvironment`
      // (`mcp/runtime-pool-servers.ts`) resolves each pair through
      // `process.env[hostEnvVarName]`, forwarding a differently-named AMBIENT
      // HOST credential into the child process. Two plugins at the same URL,
      // declaring no env/headers/environmentDefaults/headersHelper/authType/
      // credentialEnvironment, but forwarding `TOKEN` from a different host
      // variable each (`VENDOR_A_KEY` vs `VENDOR_B_KEY`), used to fingerprint
      // identically and get one silently disabled.
      const inputs = makeInputs({
        pluginCandidates: [
          pluginCandidate({
            key: 'plug:mcp:forwarded-env-a',
            capabilityId: 'plug:mcp:forwarded-env-a',
            kind: 'mcp',
            logicalName: 'plug:mcp:forwarded-env-a',
            runtimeDefinition: {
              kind: 'mcp',
              id: 'plug:mcp:forwarded-env-a',
              mcp: {
                serverName: 'forwarded-env-api',
                transport: 'http',
                url: 'https://mcp.test/forwarded-env-endpoint',
                environmentSources: { TOKEN: 'VENDOR_A_KEY' },
              },
            },
          }),
          pluginCandidate({
            key: 'plug:mcp:forwarded-env-b',
            capabilityId: 'plug:mcp:forwarded-env-b',
            kind: 'mcp',
            logicalName: 'plug:mcp:forwarded-env-b',
            runtimeDefinition: {
              kind: 'mcp',
              id: 'plug:mcp:forwarded-env-b',
              mcp: {
                serverName: 'forwarded-env-api',
                transport: 'http',
                url: 'https://mcp.test/forwarded-env-endpoint',
                environmentSources: { TOKEN: 'VENDOR_B_KEY' },
              },
            },
          }),
        ],
      });
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const a = snapshot.entries.find(e => e.summary.key === 'plug:mcp:forwarded-env-a')!;
      const b = snapshot.entries.find(e => e.summary.key === 'plug:mcp:forwarded-env-b')!;
      expect(a.summary.enabled).toBe(true);
      expect(a.summary.unavailableReason).toBeUndefined();
      expect(b.summary.enabled).toBe(true);
      expect(b.summary.unavailableReason).toBeUndefined();
      expect(snapshot.diagnostics.some(d => d.code === 'capability.dedup.endpoint-identity')).toBe(false);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('(c8) two plugin entries, same url, nothing else declared, differing only in requiredEnvironmentNames: BOTH stay enabled', async () => {
      // Disclosed residual, closed (task 4b, fix pass 3, 2026-08-10):
      // `requiredEnvironmentNames` — a declared list of required child env
      // names (never values) — can likewise differ between two otherwise-
      // identical declarations and was never read by the identity either.
      // `isEnvironmentVariableAvailable` always answers true so the ONLY
      // thing under test is whether the differing required-name list reaches
      // T4b's identity, never an unrelated `environment-missing` disablement
      // (`missingRequiredEnvironmentNames`, above) racing it.
      const inputs = makeInputs({
        pluginCandidates: [
          pluginCandidate({
            key: 'plug:mcp:required-env-a',
            capabilityId: 'plug:mcp:required-env-a',
            kind: 'mcp',
            logicalName: 'plug:mcp:required-env-a',
            runtimeDefinition: {
              kind: 'mcp',
              id: 'plug:mcp:required-env-a',
              mcp: {
                serverName: 'required-env-api',
                transport: 'http',
                url: 'https://mcp.test/required-env-endpoint',
                requiredEnvironmentNames: ['TOKEN_A'],
              },
            },
          }),
          pluginCandidate({
            key: 'plug:mcp:required-env-b',
            capabilityId: 'plug:mcp:required-env-b',
            kind: 'mcp',
            logicalName: 'plug:mcp:required-env-b',
            runtimeDefinition: {
              kind: 'mcp',
              id: 'plug:mcp:required-env-b',
              mcp: {
                serverName: 'required-env-api',
                transport: 'http',
                url: 'https://mcp.test/required-env-endpoint',
                requiredEnvironmentNames: ['TOKEN_B'],
              },
            },
          }),
        ],
        isEnvironmentVariableAvailable: () => true,
      });
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const a = snapshot.entries.find(e => e.summary.key === 'plug:mcp:required-env-a')!;
      const b = snapshot.entries.find(e => e.summary.key === 'plug:mcp:required-env-b')!;
      expect(a.summary.enabled).toBe(true);
      expect(a.summary.unavailableReason).toBeUndefined();
      expect(b.summary.enabled).toBe(true);
      expect(b.summary.unavailableReason).toBeUndefined();
      expect(snapshot.diagnostics.some(d => d.code === 'capability.dedup.endpoint-identity')).toBe(false);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('(d) a scoped MCP entry and a plugin declaring the same URL: scoped entries do not participate — both stay enabled', async () => {
      // Fix 3 (review pass, 2026-08-10): `summary.mcpServerIdentity` can never
      // carry declared env/headers for a scoped/native entry — its producer
      // (`native-sources.ts:mcpTransportIdentity`) reads only
      // transport/url/command/args, and its type (`ManagedMcpServerIdentityV1`,
      // shared with the managed-MCP denylist) has no field for either. A
      // scoped entry that DOES declare credentials would therefore always
      // fingerprint as "declares nothing" and could wrongly match a genuinely
      // credential-free plugin twin at the same URL. There is no other pinned
      // signal to prove a scoped entry declares nothing, so T4b excludes
      // scoped entries outright — plugin-vs-plugin only, matching its own
      // title. (Previously: "the scoped entry wins, the plugin is
      // `duplicates-endpoint`" — that was the false positive this fix removes.)
      const inputs = makeInputs({
        pluginCandidates: [remoteCandidate('plug:mcp:scoped-twin', 'https://mcp.test/scoped-endpoint')],
      });
      inputs.nativeInventory.records.push(nativeRecord({
        key: 'mcp:ws:scoped-twin-native',
        kind: 'mcp',
        logicalName: 'scoped-twin-native',
        mcpServerIdentity: { transport: 'http', url: 'https://mcp.test/scoped-endpoint' },
      }));
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const scoped = snapshot.entries.find(e => e.summary.key === 'mcp:ws:scoped-twin-native')!;
      const plugin = snapshot.entries.find(e => e.summary.key === 'plug:mcp:scoped-twin')!;
      expect(scoped.summary.enabled).toBe(true);
      expect(scoped.summary.unavailableReason).toBeUndefined();
      expect(plugin.summary.enabled).toBe(true);
      expect(plugin.summary.unavailableReason).toBeUndefined();
      expect(snapshot.diagnostics.some(d => d.code === 'capability.dedup.endpoint-identity')).toBe(false);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('(d, stdio variant) a scoped MCP entry and a plugin declaring the same stdio command+args also do not dedup', async () => {
      // Same rationale as (d): scoped entries are excluded from T4b entirely,
      // regardless of transport. `mcpServerIdentity.command` is the FULL argv
      // (`[command, ...args]`), unlike the plugin side's split `command`/
      // `args` — kept to prove the two shapes are STILL never compared,
      // rather than merely no longer sharing a fingerprint by accident.
      const inputs = makeInputs({
        pluginCandidates: [stdioCandidate('plug:mcp:scoped-stdio-twin', ['server.js', '--flag'])],
      });
      inputs.nativeInventory.records.push(nativeRecord({
        key: 'mcp:ws:scoped-stdio-twin-native',
        kind: 'mcp',
        logicalName: 'scoped-stdio-twin-native',
        mcpServerIdentity: { transport: 'stdio', command: ['node', 'server.js', '--flag'] },
      }));
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const scoped = snapshot.entries.find(e => e.summary.key === 'mcp:ws:scoped-stdio-twin-native')!;
      const plugin = snapshot.entries.find(e => e.summary.key === 'plug:mcp:scoped-stdio-twin')!;
      expect(scoped.summary.enabled).toBe(true);
      expect(plugin.summary.enabled).toBe(true);
      expect(plugin.summary.unavailableReason).toBeUndefined();
      expect(snapshot.diagnostics.some(d => d.code === 'capability.dedup.endpoint-identity')).toBe(false);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('never re-disables or overwrites a reason T4 already set (builtin-identity duplicate stays that way)', async () => {
      // Same shape as T4's own repro: a plugin whose stdio argv duplicates an
      // ENABLED builtin. T4 disables it first; T4b must never touch it again
      // even though its declared identity (if it had one comparable) would
      // otherwise be eligible — the entry is gone from grouping the moment
      // `enabled` goes false.
      const builtinTTracker = nativeRecord({
        key: 'mcp:builtin:t-tracker', kind: 'mcp', logicalName: 't-tracker', scope: { kind: 'builtin' },
        mcpServerIdentity: { transport: 'stdio', command: ['dp', 'ai', 'mcp', 'tracker'] },
      });
      const inputs = makeInputs({
        pluginCandidates: [stdioCandidate('plug:mcp:tracker-clone', ['ai', 'mcp', 'tracker'])],
      });
      inputs.nativeInventory.records.push(builtinTTracker);
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const plugin = snapshot.entries.find(e => e.summary.key === 'plug:mcp:tracker-clone')!;
      expect(plugin.summary.enabled).toBe(false);
      expect(plugin.summary.unavailableReason).toBe('duplicates-builtin');
      expect(snapshot.diagnostics.some(d => d.code === 'capability.dedup.endpoint-identity')).toBe(false);
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it("F2: names the losing plugin's own hook on the endpoint-identity diagnostic, not the winner's", async () => {
      // Two plugin servers share one declared stdio endpoint identity (T4b's
      // own trigger, case (b) above); the loser's own hook references its
      // OWN server by bare name and must be named on ITS diagnostic. The
      // winner carries no diagnostic at all, so there is nothing to check
      // there — this is the second dedup pass's wiring, not a repeat of the
      // T4 case above.
      const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
      const mcpCandidate = (key: string, logicalName: string) => pluginCandidate({
        key,
        capabilityId: key,
        kind: 'mcp',
        logicalName,
        runtimeDefinition: {
          kind: 'mcp',
          id: key,
          mcp: { serverName: logicalName, transport: 'stdio', command: 'node', args: ['server.js', '--flag'] },
        },
      });
      const inputs = makeInputs({
        pluginCandidates: [
          mcpCandidate('plug:mcp:d-stdio', 'd-stdio'),
          mcpCandidate('plug:mcp:c-stdio', 'c-stdio'),
          pluginCandidate({
            key: 'plug:hook:d-stdio-run',
            capabilityId: 'c-hook-d',
            kind: 'hook',
            logicalName: 'PreToolUse',
            runtimeDefinition: {
              id: 'c-hook-d',
              kind: 'hook',
              hook: { id: 'run', event: 'PreToolUse', type: 'mcp', mcpTool: 'mcp__d-stdio__run' },
            },
            resource: { pluginInstanceId: instanceId, relativePath: 'hooks/hooks.json', contentHash: 'c'.repeat(64) },
          }),
        ],
      });
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);

      const winner = snapshot.entries.find(e => e.summary.key === 'plug:mcp:c-stdio')!;
      const loser = snapshot.entries.find(e => e.summary.key === 'plug:mcp:d-stdio')!;
      expect(winner.summary.enabled).toBe(true);
      expect(loser.summary.enabled).toBe(false);
      expect(loser.summary.unavailableReason).toBe('duplicates-endpoint');
      const diagnostic = snapshot.diagnostics.find(d => d.code === 'capability.dedup.endpoint-identity')!;
      expect(diagnostic.capabilityKey).toBe('plug:mcp:d-stdio');
      expect(diagnostic.safeArgs?.inertComponents).toBe('hook:PreToolUse');
      resolver.releaseSnapshot(snapshot.leaseId);
    });
  });

  it('caps a scoped MCP wire name at 40 chars, disambiguating a shared 40-char prefix with a hash tail', async () => {
    // Review finding (task 2, stable-plugin-mcp-wire-names, 2026-08-10): the
    // scoped/native winner path used to set `wireName = logicalName` verbatim
    // with nothing capping it. `buildPoolProxyBaseName` truncates only the TOOL
    // segment in the pool, so an uncapped 45+ char wire name could still push
    // `mcp__<wireName>__<tool>` past the 64-char OpenAI-compatible endpoint
    // cap. The fix caps every wire name at the MINT (`capMcpNameSegment`, 40
    // chars) instead — this pins that the resolver actually applies it, and
    // that two logical names sharing a 40-char prefix still resolve to
    // DIFFERENT wire names via the hash tail.
    const longA = 'x'.repeat(45);
    const longB = `${'x'.repeat(40)}yyyyy`; // shares the first 40 chars with longA
    const inputs = makeInputs();
    inputs.nativeInventory.records.push(
      nativeRecord({ key: 'mcp:ws:long-a', kind: 'mcp', logicalName: longA }),
      nativeRecord({ key: 'mcp:ws:long-b', kind: 'mcp', logicalName: longB }),
    );
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);
    const runtime = toAgentRuntime(snapshot);

    const wireA = runtime.mcpServers.find(server => server.key === 'mcp:ws:long-a')!.wireName;
    const wireB = runtime.mcpServers.find(server => server.key === 'mcp:ws:long-b')!.wireName;
    expect(wireA).toHaveLength(40);
    expect(wireB).toHaveLength(40);
    expect(wireA).not.toBe(wireB);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('keeps a plugin MCP out of runtime until all name-only environment requirements are available', async () => {
    const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
    const candidate = pluginCandidate({
      key: 'plug:mcp:grafana',
      capabilityId: 'grafana',
      kind: 'mcp',
      logicalName: 'grafana',
      runtimeDefinition: {
        kind: 'mcp',
        id: 'grafana',
        mcp: {
          serverName: 'grafana',
          transport: 'stdio',
          command: 'node',
          requiredEnvironmentNames: ['GRAFANA_EDITABLE_FOLDERS', 'GRAFANA_TOKEN'],
        },
      },
    });
    const missingResolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [candidate],
        isEnvironmentVariableAvailable: name => name === 'GRAFANA_TOKEN',
      }),
    });
    const missing = await missingResolver.resolve(CONTEXT);
    expect(missing.entries.find(entry => entry.summary.key === candidate.key)?.summary).toMatchObject({
      enabled: false,
      unavailableReason: 'environment-missing',
    });
    expect(toAgentRuntime(missing).mcpServers.map(server => server.wireName)).not.toContain('grafana');
    expect(toUserCatalog(missing).diagnostics).toContainEqual(expect.objectContaining({
      code: 'plugin.mcp.required_environment_missing',
      safeArgs: { names: 'GRAFANA_EDITABLE_FOLDERS' },
      capabilityKey: candidate.key,
    }));
    expect(JSON.stringify(toUserCatalog(missing))).not.toContain('host-token-secret');
    missingResolver.releaseSnapshot(missing.leaseId);

    const readyResolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [{ ...candidate, pluginInstanceId: instanceId }],
        isEnvironmentVariableAvailable: () => true,
      }),
    });
    const ready = await readyResolver.resolve(CONTEXT);
    expect(ready.entries.find(entry => entry.summary.key === candidate.key)?.summary.enabled).toBe(true);
    // A plugin MCP server NEVER owns the bare name (`mcp.md:365`), contested
    // or not — the wire name is the stable plugin-qualified form.
    expect(toAgentRuntime(ready).mcpServers.map(server => server.wireName)).toContain('plugin_p_grafana');
    readyResolver.releaseSnapshot(ready.leaseId);
  });

  it("translates a plugin skill's bare-name MCP references in allowed-tools to the wire-qualified form", async () => {
    // T3: a plugin skill's `allowed-tools` may still name the plugin's own
    // bundled server by its bare short name, but T2 made that server's ACTUAL
    // wire name the qualified `plugin_<id>_<server>` form — so the enforced
    // grant (`toAgentRuntime(...).skills[].allowedTools`, R17b) must be
    // rewritten the same way the runtime tool name is, or the pinned
    // restriction silently stops matching any real proxy tool. Both the exact
    // and wildcard `allowed-tools` shapes are covered; a foreign server and a
    // non-MCP tool name must pass through untouched.
    const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
    const inputs = makeInputs({
      pluginCandidates: [
        pluginCandidate({
          key: 'plug:mcp:t-tracker',
          capabilityId: 't-tracker',
          kind: 'mcp',
          logicalName: 't-tracker',
          runtimeDefinition: {
            id: 't-tracker',
            kind: 'mcp',
            mcp: { serverName: 't-tracker', transport: 'http', url: 'https://mcp.test/t-tracker' },
          },
        }),
        pluginCandidate({
          key: 'plug:skill:alpha',
          capabilityId: 'c-skill',
          kind: 'skill',
          logicalName: 'alpha',
          resource: { pluginInstanceId: instanceId, relativePath: 'skills/alpha/SKILL.md', contentHash: 'c'.repeat(64) },
          runtimeDefinition: {
            id: 'c-skill',
            kind: 'skill',
            skill: {
              slug: 'alpha',
              path: 'skills/alpha/SKILL.md',
              allowedTools: ['mcp__t-tracker__list', 'mcp__t-tracker__*', 'mcp__dpJira__search', 'Bash'],
            },
          },
        }),
      ],
    });
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);

    expect(toAgentRuntime(snapshot).skills.find(skill => skill.key === 'plug:skill:alpha')?.allowedTools).toEqual([
      'mcp__plugin_p_t-tracker__list',
      'mcp__plugin_p_t-tracker__*',
      'mcp__dpJira__search',
      'Bash',
    ]);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it("translates a plugin hook's bare-name MCP tool reference to the wire-qualified form", async () => {
    // F1 live verification (2026-08-10/11, `.superpowers/sdd/f1-live-verification-report.md`)
    // found the T3 hook translation wired to the WRONG path: it lived in
    // `projection.ts`'s `resolvePluginProjectionPlan`, the legacy V1
    // projection whose only production caller was `install-service.ts` (F4 has
    // since deleted both). The real pipeline never called it — production builds entries
    // through `resolvePluginProjectionCandidates` and THIS resolver
    // (`storage-runtime.ts:885` onward), exactly like the T3 skill test
    // above. This test goes through that same real path so it cannot pass
    // for the wrong reason the way a V1-projection test did.
    const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
    const inputs = makeInputs({
      pluginCandidates: [
        pluginCandidate({
          key: 'plug:mcp:t-tracker',
          capabilityId: 't-tracker',
          kind: 'mcp',
          logicalName: 't-tracker',
          runtimeDefinition: {
            id: 't-tracker',
            kind: 'mcp',
            mcp: { serverName: 't-tracker', transport: 'http', url: 'https://mcp.test/t-tracker' },
          },
        }),
        // Own-server reference: bare `mcpTool` naming this plugin's OWN
        // bundled `t-tracker` server must come out qualified.
        pluginCandidate({
          key: 'plug:hook:own-mcp',
          capabilityId: 'c-hook-own',
          kind: 'hook',
          logicalName: 'PreToolUse',
          runtimeDefinition: {
            id: 'c-hook-own',
            kind: 'hook',
            hook: { id: 'own', event: 'PreToolUse', type: 'mcp', mcpTool: 'mcp__t-tracker__list' },
          },
          resource: { pluginInstanceId: instanceId, relativePath: 'hooks/hooks.json', contentHash: 'c'.repeat(64) },
        }),
        // Foreign reference: a builtin the plugin does NOT own must pass
        // through untouched (same negative shape as the skill test's
        // `mcp__dpJira__search` entry above).
        pluginCandidate({
          key: 'plug:hook:foreign-mcp',
          capabilityId: 'c-hook-foreign',
          kind: 'hook',
          logicalName: 'PostToolUse',
          runtimeDefinition: {
            id: 'c-hook-foreign',
            kind: 'hook',
            hook: { id: 'foreign', event: 'PostToolUse', type: 'mcp', mcpTool: 'mcp__dpJira__search' },
          },
          resource: { pluginInstanceId: instanceId, relativePath: 'hooks/hooks.json', contentHash: 'd'.repeat(64) },
        }),
      ],
    });
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);

    const hooks = toAgentRuntime(snapshot).hooks;
    expect(hooks.find(hook => hook.key === 'plug:hook:own-mcp')?.mcpTool).toBe('mcp__plugin_p_t-tracker__list');
    expect(hooks.find(hook => hook.key === 'plug:hook:foreign-mcp')?.mcpTool).toBe('mcp__dpJira__search');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('precomputes availability over the same expansion the runtime materializes', async () => {
    // The precompute used a `${VAR}`-only pattern, so `${TOKEN:-}` never
    // matched, stayed non-empty and reported AVAILABLE — while the runtime,
    // reading `${VAR:-default}` (`mcp.md:450`), resolved it to the empty
    // default and withheld the server. Both now run one expander.
    const candidate = pluginCandidate({
      key: 'plug:mcp:defaulted',
      capabilityId: 'defaulted',
      kind: 'mcp',
      logicalName: 'defaulted',
      runtimeDefinition: {
        kind: 'mcp',
        id: 'defaulted',
        mcp: {
          serverName: 'defaulted',
          transport: 'stdio',
          command: 'node',
          env: { API_TOKEN: '${TOKEN:-}' },
          requiredEnvironmentNames: ['API_TOKEN'],
        },
      },
    });
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [candidate],
        isEnvironmentVariableAvailable: () => false,
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    expect(snapshot.entries.find(entry => entry.summary.key === candidate.key)?.summary).toMatchObject({
      enabled: false,
      unavailableReason: 'environment-missing',
    });
    expect(toAgentRuntime(snapshot).mcpServers.map(server => server.wireName)).not.toContain('defaulted');
    resolver.releaseSnapshot(snapshot.leaseId);

    // A non-empty default satisfies the same requirement in both halves.
    const suppliedCandidate = pluginCandidate({
      key: 'plug:mcp:defaulted',
      capabilityId: 'defaulted',
      kind: 'mcp',
      logicalName: 'defaulted',
      runtimeDefinition: {
        kind: 'mcp',
        id: 'defaulted',
        mcp: {
          serverName: 'defaulted',
          transport: 'stdio',
          command: 'node',
          env: { API_TOKEN: '${TOKEN:-fallback}' },
          requiredEnvironmentNames: ['API_TOKEN'],
        },
      },
    });
    const suppliedResolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [suppliedCandidate],
        isEnvironmentVariableAvailable: () => false,
      }),
    });
    const supplied = await suppliedResolver.resolve(CONTEXT);
    expect(supplied.entries.find(entry => entry.summary.key === candidate.key)?.summary.enabled).toBe(true);
    suppliedResolver.releaseSnapshot(supplied.leaseId);
  });

  it('projects missing imported configuration as needs_configuration and admits it after an opaque binding exists', async () => {
    const candidate = pluginCandidate({
      key: 'plug:mcp:configured',
      capabilityId: 'configured',
      kind: 'mcp',
      logicalName: 'configured',
      runtimeDefinition: {
        kind: 'mcp',
        id: 'configured',
        mcp: {
          serverName: 'configured',
          transport: 'stdio',
          command: 'node',
          credentialEnvironment: { API_KEY: 'api_key' },
          requiredEnvironmentNames: ['API_KEY'],
        },
      },
    });
    const missingResolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [candidate],
        configurationMissingFor: () => ['api_key'],
      }),
    });
    const missing = await missingResolver.resolve(CONTEXT);
    expect(missing.entries.find(entry => entry.summary.key === candidate.key)?.summary).toMatchObject({
      enabled: false,
      credentialState: 'missing',
      unavailableReason: 'needs_configuration',
    });
    expect(toAgentRuntime(missing).mcpServers.some(server => server.wireName === 'configured')).toBe(false);
    missingResolver.releaseSnapshot(missing.leaseId);

    const ref = 'source_apikey::ws-1::configured';
    const readyResolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [candidate],
        configurationMissingFor: () => [],
        credentialRefsFor: () => ({ API_KEY: ref }),
        resolveCredentialStatus: () => ({ state: 'ready', revision: '7' }),
        bindCredential: () => ({
          id: { type: 'source_apikey', workspaceId: 'ws-1', sourceId: 'configured' },
          expectedRevision: 7,
        }),
      }),
    });
    const ready = await readyResolver.resolve(CONTEXT);
    expect(ready.entries.find(entry => entry.summary.key === candidate.key)?.summary).toMatchObject({
      enabled: true,
      credentialState: 'ready',
    });
    // A plugin MCP server NEVER owns the bare name (`mcp.md:365`), contested
    // or not — the wire name is the stable plugin-qualified form.
    expect(toAgentRuntime(ready).mcpServers.some(server => server.wireName === 'plugin_p_configured')).toBe(true);
    expect(JSON.stringify(toUserCatalog(ready))).not.toContain('api-key-value');
    readyResolver.releaseSnapshot(ready.leaseId);
  });

  it('accepts required child env supplied by mapped host names, descriptor defaults, literals, or plugin aliases', async () => {
    const candidate = pluginCandidate({
      key: 'plug:mcp:descriptor-env',
      capabilityId: 'descriptor-env',
      kind: 'mcp',
      logicalName: 'descriptor-env',
      runtimeDefinition: {
        kind: 'mcp',
        id: 'descriptor-env',
        mcp: {
          serverName: 'descriptor-env',
          transport: 'stdio',
          command: 'node',
          env: {
            LITERAL_TOKEN: 'literal-value',
            ROOT_COPY: '${PLUGIN_ROOT}',
          },
          environmentDefaults: { DEFAULT_URL: 'https://example.test' },
          environmentSources: { MAPPED_TOKEN: 'HOST_TOKEN' },
          requiredEnvironmentNames: [
            'DEFAULT_URL',
            'LITERAL_TOKEN',
            'MAPPED_TOKEN',
            'ROOT_COPY',
          ],
        },
      },
    });
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [candidate],
        isEnvironmentVariableAvailable: name => name === 'HOST_TOKEN',
        pluginRuntimeContextFor: () => ({
          rootPath: '/private/plugin-cache/demo',
          dataPath: '/private/plugin-data/demo',
          profile: 'generic-plugin-env-v1',
        }),
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const summary = snapshot.entries.find(entry => entry.summary.key === candidate.key)?.summary;
    expect(summary?.enabled).toBe(true);
    expect(summary?.unavailableReason).toBeUndefined();
    // A plugin MCP server NEVER owns the bare name (`mcp.md:365`), contested
    // or not — the wire name is the stable plugin-qualified form.
    expect(toAgentRuntime(snapshot).mcpServers.map(server => server.wireName)).toContain('plugin_p_descriptor-env');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('pins the reviewed remote MCP environment-name allowlist into its runtime definition', async () => {
    const candidate = pluginCandidate({
      key: 'plug:mcp:remote',
      capabilityId: 'remote',
      kind: 'mcp',
      logicalName: 'remote',
      runtimeDefinition: {
        kind: 'mcp',
        id: 'remote',
        mcp: {
          serverName: 'remote',
          transport: 'http',
          url: 'https://${REMOTE_HOST}/mcp',
          env: { REMOTE_HOST: '${REMOTE_HOST}' },
          environmentSources: { OPTIONAL_CHILD: 'OPTIONAL_HOST' },
          requiredEnvironmentNames: ['CODEX_HOME'],
          toolTimeoutMs: 900_000,
        },
      },
    });
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [candidate],
        isEnvironmentVariableAvailable: () => true,
      }),
    });

    const snapshot = await resolver.resolve(CONTEXT);
    const entry = snapshot.entries.find(item => item.summary.key === candidate.key)!;
    expect(entry.runtimeBinding).toMatchObject({
      kind: 'mcp',
      server: {
        definition: {
          type: 'http',
          forwardedEnvironmentNames: ['CODEX_HOME', 'REMOTE_HOST'],
          forwardedEnvironmentSources: { OPTIONAL_CHILD: 'OPTIONAL_HOST' },
          requiredEnvironmentNames: ['CODEX_HOME'],
          toolTimeoutMs: 900_000,
        },
      },
    });
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  // R3 composer-selection contract (B2): folder/API sources honor session
  // selection; MCP (`kind === 'mcp'`) is EXEMPT and governed by activation
  // alone. This pins the final availability matrix so the exemption can't
  // silently regress into `kind === 'mcp'` session-gating.
  describe('session-selection availability matrix (R3 A+C)', () => {
    // fixture: source:ws:gmail (kind source, api) + mcp:ws:fs (kind mcp).
    async function resolveEnabled(over: Partial<CapabilityResolutionInputs>) {
      const resolver = createCapabilityResolver({ inputs: () => makeInputs(over) });
      const snapshot = await resolver.resolve(CONTEXT);
      const byKey = (key: string) => snapshot.entries.find(e => e.summary.key === key)!.summary;
      const result = {
        source: byKey('source:ws:gmail'),
        mcp: byKey('mcp:ws:fs'),
      };
      resolver.releaseSnapshot(snapshot.leaseId);
      return result;
    }

    // NON-SESSION resolve path (`sessionSelection === undefined`): there is no
    // session selection to apply, so folder/API sources are NOT session-gated.
    // NOTE: production NEVER emits `undefined` for a LIVE session — a live
    // session always hands the resolver an ARRAY `enabledSourceKeys` (empty for
    // "nothing selected"), so an empty LIVE selection gates folder/API sources
    // OFF (`session-not-selected`). That production shape is pinned by the
    // `storage-runtime-policy.test.ts` "empty selection" case (which builds the
    // real `buildCapabilityResolutionInputsV2` inputs with `sessionId` set).
    // This test only covers the complementary resolver-layer `undefined` branch.
    it('no session selection (undefined — non-session resolve): folder/API source and MCP both stay available', async () => {
      const { source, mcp } = await resolveEnabled({});
      expect(source.enabled).toBe(true);
      expect(mcp.enabled).toBe(true);
    });

    it('non-empty selection including the folder/API source: source enabled, MCP still available (exempt)', async () => {
      const { source, mcp } = await resolveEnabled({
        sessionSelection: { enabledSourceKeys: ['source:ws:gmail'], revision: 'sel-1' },
      });
      expect(source.enabled).toBe(true);
      expect(mcp.enabled).toBe(true);
    });

    it('non-empty selection NOT including the folder/API source: source session-gated off', async () => {
      const { source } = await resolveEnabled({
        sessionSelection: { enabledSourceKeys: ['source:ws:other'], revision: 'sel-2' },
      });
      expect(source.enabled).toBe(false);
      expect(source.unavailableReason).toBe('session-not-selected');
    });

    it('source-transport MCP config (kind source, sourceType mcp) omitted from the selection: stays AVAILABLE — activation-governed like kind mcp (live-audit fix 2026-07-20)', async () => {
      // The composer picker never offers MCP-transport source configs
      // (isComposerSelectableSourceRow), so every session selection set omits
      // them. Before the `sourceType !== 'mcp'` carve-out that made such a
      // source permanently 'session-not-selected' — impossible to activate.
      const inputs = makeInputs({
        sessionSelection: { enabledSourceKeys: ['source:ws:gmail'], revision: 'sel-mcp-src' },
      });
      inputs.nativeInventory.records.push(
        nativeRecord({ key: 'source:ws:echo', kind: 'source', logicalName: 'echo', sourceType: 'mcp' }),
      );
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);
      const echo = snapshot.entries.find(e => e.summary.key === 'source:ws:echo')!.summary;
      expect(echo.enabled).toBe(true);
      expect(echo.unavailableReason).toBeUndefined();
      resolver.releaseSnapshot(snapshot.leaseId);
    });

    it('activated MCP + non-empty selection that omits it: MCP stays AVAILABLE — activation governs, never session-gated (the decided contract; no UX trap post picker-restriction)', async () => {
      const { mcp } = await resolveEnabled({
        // A selection set that contains only a folder/API source, never the MCP
        // key — mirrors the post-R3-C reality where MCP has no picker entry.
        sessionSelection: { enabledSourceKeys: ['source:ws:gmail'], revision: 'sel-3' },
      });
      expect(mcp.enabled).toBe(true);
      expect(mcp.unavailableReason).toBeUndefined();
    });

    it('config-disabled MCP is unavailable regardless of selection (activation still governs)', async () => {
      const inputs = makeInputs({
        sessionSelection: { enabledSourceKeys: ['source:ws:gmail'], revision: 'sel-4' },
      });
      inputs.nativeInventory.records.find(r => r.key === 'mcp:ws:fs')!.sourceEnabled = false;
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);
      const mcp = snapshot.entries.find(e => e.summary.key === 'mcp:ws:fs')!.summary;
      expect(mcp.enabled).toBe(false);
      expect(mcp.unavailableReason).toBe('source-disabled');
      resolver.releaseSnapshot(snapshot.leaseId);
    });
  });

  it('uses one collision namespace for Source MCP and native/plugin MCP servers', async () => {
    const collide = makeInputs();
    collide.nativeInventory.records.push(
      nativeRecord({
        key: 'source:ws:fs',
        kind: 'source',
        logicalName: 'fs',
        sourceType: 'mcp',
      }),
    );
    const resolver = createCapabilityResolver({ inputs: () => collide });
    const snapshot = await resolver.resolve(CONTEXT);
    const runtime = toAgentRuntime(snapshot);

    // One namespace, and now one winner in it: the source-transport MCP and the
    // native MCP record define the same server name at the same scope, so
    // `mcp.md:431` allows exactly one connection. Lexical key breaks the tie.
    expect(runtime.mcpServers.map(item => item.wireName)).toEqual(['fs']);
    expect(runtime.mcpServers.find(item => item.key === 'mcp:ws:fs')).toBeDefined();
    expect(runtime.sources.find(item => item.key === 'source:ws:fs')).toBeUndefined();
    expect(snapshot.entries.find(e => e.summary.key === 'source:ws:fs')?.summary).toMatchObject({
      enabled: false,
      unavailableReason: 'shadowed-by-mcp-precedence',
    });
    expect(snapshot.diagnostics.some(d => d.code === 'capability.collision.mcp-scope-precedence')).toBe(true);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('carries the skill control fields onto the runtime handle', async () => {
    const inputs = makeInputs();
    inputs.nativeInventory.records.push(nativeRecord({
      key: 'skill:ws:review',
      kind: 'skill',
      logicalName: 'review',
      description: 'Reviews code',
      skillDisableModelInvocation: true,
      skillUserInvocable: false,
      skillAllowedTools: ['Read', 'Grep'],
    }));
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);

    const handle = toAgentRuntime(snapshot).skills.find(skill => skill.key === 'skill:ws:review')!;
    expect(handle.disableModelInvocation).toBe(true);
    expect(handle.userInvocable).toBe(false);
    expect(handle.allowedTools).toEqual(['Read', 'Grep']);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('carries a skillOverrides state onto the native handle and never onto a plugin skill of the same name', async () => {
    // `skills.md:689` — "Plugin skills are not affected by `skillOverrides`."
    // Asserted rather than assumed: the default fixture already carries a native
    // `alpha` and a plugin-projected `alpha`, so this is the collision case the
    // exemption exists for. The plugin branch (`pluginSkillInvocationControls`)
    // does not carry the field at all, which is what makes the exemption
    // structural instead of a check someone can forget.
    const inputs = makeInputs();
    const native = inputs.nativeInventory.records.find(record => record.key === 'skill:ws:alpha')!;
    (native as { skillOverrideState?: 'off' }).skillOverrideState = 'off';
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);

    const skills = toAgentRuntime(snapshot).skills;
    expect(skills.find(skill => skill.key === 'skill:ws:alpha')!.overrideState).toBe('off');
    expect('overrideState' in skills.find(skill => skill.key === 'plug:skill:alpha')!).toBe(false);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('moves the capability generation when a skillOverrides state changes, and only then', async () => {
    // The state comes from a SETTINGS file, so it moves neither the record's
    // `contentHash` nor its `revision`. Without it in the generation material a
    // session that has already pinned a snapshot keeps serving the pre-change
    // listing. The unchanged pair also pins the shape-stability half: an
    // unoverridden catalog must not have its generations invalidated.
    const generationFor = async (state?: 'off'): Promise<string> => {
      const inputs = makeInputs();
      const native = inputs.nativeInventory.records.find(record => record.key === 'skill:ws:alpha')!;
      if (state) (native as { skillOverrideState?: 'off' }).skillOverrideState = state;
      const resolver = createCapabilityResolver({ inputs: () => inputs });
      const snapshot = await resolver.resolve(CONTEXT);
      resolver.releaseSnapshot(snapshot.leaseId);
      return snapshot.generation;
    };

    expect(await generationFor()).toBe(await generationFor());
    expect(await generationFor('off')).not.toBe(await generationFor());
  });

  it('omits overrideState when no override names the skill (absent means "on")', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);

    const handle = toAgentRuntime(snapshot).skills.find(skill => skill.key === 'skill:ws:alpha')!;
    expect('overrideState' in handle).toBe(false);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('carries a PLUGIN skill\'s control fields onto the runtime handle', async () => {
    // The native branch above already did this; the plugin branch did not, so
    // `disableModelInvocation` read `undefined` for every plugin skill and the
    // model-invocation refusal never fired on third-party content.
    const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
    const inputs = makeInputs({
      pluginCandidates: [
        pluginCandidate({
          key: 'plug:skill:danger',
          capabilityId: 'c-skill-danger',
          kind: 'skill',
          logicalName: 'danger',
          description: 'Deploys to production',
          resource: { pluginInstanceId: instanceId, relativePath: 'skills/danger/SKILL.md', contentHash: 'c'.repeat(64) },
          runtimeDefinition: {
            kind: 'skill',
            id: 'c-skill-danger',
            skill: {
              slug: 'danger',
              path: 'skills/danger/SKILL.md',
              disableModelInvocation: true,
              userInvocable: false,
            },
          },
        }),
      ],
    });
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);

    const handle = toAgentRuntime(snapshot).skills.find(skill => skill.key === 'plug:skill:danger')!;
    expect(handle.description).toBe('Deploys to production');
    expect(handle.disableModelInvocation).toBe(true);
    expect(handle.userInvocable).toBe(false);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('omits a plugin skill\'s control fields when its author states none', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);

    const handle = toAgentRuntime(snapshot).skills.find(skill => skill.key === 'plug:skill:alpha')!;
    expect('disableModelInvocation' in handle).toBe(false);
    expect('userInvocable' in handle).toBe(false);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('omits the skill control fields when the skill does not set them', async () => {
    // Absent, not false: `userInvocable` defaults to true and a stored `false`
    // must stay distinguishable from "not stated".
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);

    const handle = toAgentRuntime(snapshot).skills.find(skill => skill.key === 'skill:ws:alpha')!;
    expect('disableModelInvocation' in handle).toBe(false);
    expect('userInvocable' in handle).toBe(false);
    expect('allowedTools' in handle).toBe(false);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('applies explicit policy disable as a terminal deny (visible but not runnable)', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({ resolveActivation: () => ({ enabled: false, suppressed: true, capabilities: {} }) }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const plug = snapshot.entries.find(e => e.summary.origin === 'plugin')!;
    expect(plug.summary.enabled).toBe(false);
    // Still present in the catalog.
    expect(toComposerCatalog(snapshot).items.some(i => i.key === plug.summary.key)).toBe(true);
    // Excluded from the runtime skill set.
    expect(toAgentRuntime(snapshot).skills.some(s => s.key === plug.summary.key)).toBe(false);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('disables ONLY the capability a per-capability policy false targets; siblings and the plugin stay', async () => {
    const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
    const inputs = makeInputs({
      pluginCandidates: [
        pluginCandidate({ key: 'plug:mcp:one', capabilityId: 'c-mcp-one', kind: 'mcp', logicalName: 'one', runtimeDefinition: { kind: 'mcp', id: 'c-mcp-one', mcp: { serverName: 'one', command: 'x' } } as never }),
        pluginCandidate({ key: 'plug:mcp:two', capabilityId: 'c-mcp-two', kind: 'mcp', logicalName: 'two', runtimeDefinition: { kind: 'mcp', id: 'c-mcp-two', mcp: { serverName: 'two', command: 'x' } } as never }),
      ],
      resolveActivation: () => ({ enabled: true, suppressed: false, capabilities: { 'c-mcp-one': false } }),
    });
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);

    const one = snapshot.entries.find(e => e.summary.capabilityId === 'c-mcp-one')!;
    const two = snapshot.entries.find(e => e.summary.capabilityId === 'c-mcp-two')!;
    expect(one.summary.enabled).toBe(false);
    expect(one.summary.unavailableReason).toBe('capability-disabled');
    expect(two.summary.enabled).toBe(true);
    expect(two.summary.unavailableReason).toBeUndefined();
    // The disabled MCP server leaves the runtime view (→ leaves the desired pool set).
    const runtime = toAgentRuntime(snapshot);
    expect(runtime.mcpServers.some(s => s.key === 'plug:mcp:one')).toBe(false);
    expect(runtime.mcpServers.some(s => s.key === 'plug:mcp:two')).toBe(true);
    // Safe view: disabled state + the distinct reason string.
    const safe = toComposerCatalog(snapshot).items.find(i => i.key === 'plug:mcp:one')!;
    expect(safe.state).toBe('disabled');
    expect(safe.unavailableReason).toBe('capability-disabled');
    expect(instanceId).toContain('plugin://');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('keeps plugin-level suppression terminal over per-capability values (never resurrects)', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        // Plugin suppressed AND the capability explicitly re-enabled in the map.
        resolveActivation: () => ({ enabled: false, suppressed: true, capabilities: { 'c-skill': true } }),
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const plug = snapshot.entries.find(e => e.summary.origin === 'plugin')!;
    expect(plug.summary.enabled).toBe(false);
    expect(plug.summary.unavailableReason).toBe('policy-disabled');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('does not require a second trust grant for an installed plugin capability', async () => {
    let trustCalls = 0;
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [
          pluginCandidate({ key: 'plug:hook:pre', capabilityId: 'c-hook', kind: 'hook', logicalName: 'pre', trust: { required: true, executableHash: 'd'.repeat(64) } }),
        ],
        resolveTrust: () => {
          trustCalls += 1;
          return 'review-required';
        },
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const hook = snapshot.entries.find(e => e.summary.kind === 'hook')!;
    expect(trustCalls).toBe(0);
    expect(hook.summary.trustState).toBe('not-required');
    expect(hook.summary.enabled).toBe(true);
    expect(toAgentRuntime(snapshot).hooks).toHaveLength(1);
    const safe = toComposerCatalog(snapshot).items.find(i => i.key === hook.summary.key)!;
    expect(safe.state).toBe('active');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('requires the exact host-derived trust grant for an installed workflow', async () => {
    const trustRequests: unknown[] = [];
    const workflow = pluginCandidate({
      key: 'plug:workflow:release',
      capabilityId: 'c-workflow',
      kind: 'workflow',
      logicalName: 'release',
      trust: { required: true, executableHash: 'e'.repeat(64) },
      resource: {
        pluginInstanceId: installedPlugin().pluginInstanceId,
        relativePath: 'workflows/release.js',
        contentHash: 'b'.repeat(64),
      },
    });
    let trusted = false;
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [workflow],
        resolveTrust: key => {
          trustRequests.push(key);
          return trusted ? 'trusted' : 'review-required';
        },
      }),
    });

    const untrusted = await resolver.resolve(CONTEXT);
    const untrustedWorkflow = untrusted.entries.find(entry => entry.summary.key === workflow.key)!;
    expect(untrustedWorkflow.summary).toMatchObject({
      enabled: false,
      trustState: 'review-required',
      unavailableReason: 'review-required',
    });
    expect(toComposerCatalog(untrusted).items.find(item => item.key === workflow.key)?.state)
      .toBe('review-required');
    resolver.releaseSnapshot(untrusted.leaseId);

    trusted = true;
    const allowed = await resolver.resolve(CONTEXT);
    const allowedWorkflow = allowed.entries.find(entry => entry.summary.key === workflow.key)!;
    expect(allowedWorkflow.summary).toMatchObject({
      enabled: true,
      trustState: 'trusted',
    });
    expect(toComposerCatalog(allowed).items.find(item => item.key === workflow.key)?.state)
      .toBe('active');
    expect(trustRequests).toEqual([
      {
        pluginInstanceId: installedPlugin().pluginInstanceId,
        capabilityId: 'c-workflow',
        executableHash: 'e'.repeat(64),
        scope: { kind: 'global' },
      },
      {
        pluginInstanceId: installedPlugin().pluginInstanceId,
        capabilityId: 'c-workflow',
        executableHash: 'e'.repeat(64),
        scope: { kind: 'global' },
      },
    ]);
    resolver.releaseSnapshot(allowed.leaseId);
  });

  it('gates project native hooks by exact hash while managed hooks and automations need no grant', async () => {
    const projectScope = {
      kind: 'project' as const,
      workspaceId: CONTEXT.workspaceId,
      projectKey: CONTEXT.projectKey,
    };
    const projectHook = nativeRecord({
      key: `hook::project::${CONTEXT.workspaceId}::${CONTEXT.projectKey}::.nessy-agent/hooks.json`,
      kind: 'hook',
      logicalName: '.nessy-agent/hooks.json',
      scope: projectScope,
      sourcePath: '/disposable/project/.nessy-agent/hooks.json',
      contentHash: 'e'.repeat(64),
    });
    const trustRequests: unknown[] = [];
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        nativeInventory: {
          records: [
            nativeRecord({
              key: 'hook::global::hooks.json',
              kind: 'hook',
              logicalName: 'hooks.json',
              scope: { kind: 'global' },
            }),
            nativeRecord({ key: 'hook::workspace::hooks.json', kind: 'hook', logicalName: 'hooks.json' }),
            nativeRecord({ key: 'automation::workspace::automations.json', kind: 'automation', logicalName: 'automations.json' }),
            projectHook,
          ],
          blockedLayers: [],
        },
        installedPlugins: [],
        activePluginInstances: {},
        pluginCandidates: [],
        resolveTrust: key => {
          trustRequests.push(key);
          return 'review-required';
        },
      }),
    });

    const snapshot = await resolver.resolve(CONTEXT);
    const resolvedProjectHook = snapshot.entries.find(entry => entry.summary.key === projectHook.key)!;
    expect(trustRequests).toEqual([{
      capabilityId: projectHook.key,
      executableHash: projectHook.contentHash,
      scope: projectScope,
    }]);
    expect(resolvedProjectHook.summary).toMatchObject({
      enabled: false,
      trustState: 'review-required',
      unavailableReason: 'review-required',
    });
    expect(toComposerCatalog(snapshot).items.find(item => item.key === projectHook.key)?.state).toBe('review-required');
    expect(toAgentRuntime(snapshot).hooks.map(hook => hook.key).sort()).toEqual([
      'hook::global::hooks.json',
      'hook::workspace::hooks.json',
    ]);
    expect(toAgentRuntime(snapshot).automations.map(automation => automation.key)).toEqual([
      'automation::workspace::automations.json',
    ]);
    for (const key of [
      'hook::global::hooks.json',
      'hook::workspace::hooks.json',
      'automation::workspace::automations.json',
    ]) {
      expect(snapshot.entries.find(entry => entry.summary.key === key)?.summary.trustState).toBe('not-required');
    }
    resolver.releaseSnapshot(snapshot.leaseId);
  });
});

describe('CapabilityResolver — generation determinism and inputs', () => {
  it('is deterministic for identical inputs', async () => {
    const r1 = createCapabilityResolver({ inputs: () => makeInputs() });
    const r2 = createCapabilityResolver({ inputs: () => makeInputs() });
    const s1 = await r1.resolve(CONTEXT);
    const s2 = await r2.resolve(CONTEXT);
    expect(s1.generation).toBe(s2.generation);
  });

  it('changes generation on project-trust revision change', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const s1 = await resolver.resolve(CONTEXT);
    const s2 = await resolver.resolve({ ...CONTEXT, projectTrustRevision: 'trust-r2' });
    expect(s1.generation).not.toBe(s2.generation);
  });

  it('changes generation on credential status revision change but NOT on secret bytes', async () => {
    const withRev = (revision: string) => makeInputs({
      credentialRefFor: key => (key === 'source:ws:gmail' ? 'cred:gmail' : undefined),
      resolveCredentialStatus: () => ({ state: 'ready', revision }),
    });
    const resolver = createCapabilityResolver({ inputs: () => withRev('cred-r1') });
    const s1 = await resolver.resolve(CONTEXT);
    const same = createCapabilityResolver({ inputs: () => withRev('cred-r1') });
    const sSame = await same.resolve(CONTEXT);
    const changed = createCapabilityResolver({ inputs: () => withRev('cred-r2') });
    const sChanged = await changed.resolve(CONTEXT);
    // Same revision (secret rotation that keeps revision would be a bug elsewhere,
    // but here: identical non-secret revision => identical generation).
    expect(s1.generation).toBe(sSame.generation);
    expect(s1.generation).not.toBe(sChanged.generation);
  });

  it('changes generation on session selection change and provider capability revision change', async () => {
    const base = createCapabilityResolver({ inputs: () => makeInputs() });
    const sBase = await base.resolve(CONTEXT);

    const sel = createCapabilityResolver({
      inputs: () => makeInputs({ sessionSelection: { enabledSourceKeys: ['source:ws:gmail'], revision: 'sel-1' } }),
    });
    const sSel = await sel.resolve(CONTEXT);
    expect(sBase.generation).not.toBe(sSel.generation);

    const prov = createCapabilityResolver({ inputs: () => makeInputs({ providerCapabilityRevision: 'prov-2' }) });
    const sProv = await prov.resolve(CONTEXT);
    expect(sBase.generation).not.toBe(sProv.generation);
  });

  it('changes generation when the pinned native icon changes', async () => {
    const first = createCapabilityResolver({ inputs: () => makeInputs() });
    const firstSnapshot = await first.resolve(CONTEXT);
    const changedInputs = makeInputs();
    const source = changedInputs.nativeInventory.records.find(record => record.key === 'source:ws:gmail')!;
    source.iconResource = {
      revision: 'icon-r2',
      contentHash: '8'.repeat(64),
      dataUrl: 'data:image/png;base64,aWNvbi10d28=',
    };
    const changed = createCapabilityResolver({ inputs: () => changedInputs });
    const changedSnapshot = await changed.resolve(CONTEXT);

    expect(firstSnapshot.generation).not.toBe(changedSnapshot.generation);
  });

  it('resolves agent and prompt-command plugin candidates to the same generation and runtime binding regardless of adapter provenance (no origin branch)', async () => {
    const instanceId = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);
    const agentCandidate = pluginCandidate({
      key: 'plug:agent:reviewer',
      capabilityId: 'c-agent',
      kind: 'agent',
      logicalName: 'reviewer',
      resource: { pluginInstanceId: instanceId, relativePath: 'agents/reviewer.md', contentHash: 'e'.repeat(64) },
    });
    const promptCandidate = pluginCandidate({
      key: 'plug:prompt-command:summarize',
      capabilityId: 'c-prompt',
      kind: 'prompt-command',
      logicalName: 'summarize',
      resource: { pluginInstanceId: instanceId, relativePath: 'commands/summarize.md', contentHash: 'f'.repeat(64) },
    });

    const withAdapter = (adapterId: string) => makeInputs({
      installedPlugins: [{
        ...installedPlugin(),
        manifest: {
          ...installedPlugin().manifest,
          compatibility: { rawExternalKind: 'codex-plugin', adapter: { adapterId, adapterVersion: '1' } },
        },
      }],
      pluginCandidates: [agentCandidate, promptCandidate],
    });

    const codexAdapter = createCapabilityResolver({ inputs: () => withAdapter('codex-plugin-json') });
    const claudeAdapter = createCapabilityResolver({ inputs: () => withAdapter('claude-compat-detected') });
    const sCodex = await codexAdapter.resolve(CONTEXT);
    const sClaude = await claudeAdapter.resolve(CONTEXT);

    // Manifests differ ONLY in adapter provenance (adapterId) -> identical
    // generation and identical runtime bindings for every entry.
    expect(sCodex.generation).toBe(sClaude.generation);
    const codexEntries = sCodex.entries.map(e => ({ key: e.summary.key, kind: e.summary.kind, binding: e.runtimeBinding }));
    const claudeEntries = sClaude.entries.map(e => ({ key: e.summary.key, kind: e.summary.kind, binding: e.runtimeBinding }));
    expect(codexEntries).toEqual(claudeEntries);

    const agentEntry = sCodex.entries.find(e => e.summary.key === agentCandidate.key)!;
    expect(agentEntry.summary.kind).toBe('agent');
    expect(agentEntry.runtimeBinding.kind).toBe('agent');
    expect(JSON.stringify(agentEntry)).not.toContain('codex-plugin');
    expect(JSON.stringify(agentEntry)).not.toContain('claude-compat-detected');

    const promptEntry = sCodex.entries.find(e => e.summary.key === promptCandidate.key)!;
    expect(promptEntry.summary.kind).toBe('prompt-command');
    expect(promptEntry.runtimeBinding.kind).toBe('prompt-command');
    if (promptEntry.runtimeBinding.kind === 'prompt-command') {
      expect(promptEntry.runtimeBinding.promptCommand).not.toHaveProperty('executableHash');
    }
    expect(JSON.stringify(promptEntry)).not.toContain('codex-plugin');
    expect(JSON.stringify(promptEntry)).not.toContain('claude-compat-detected');

    codexAdapter.releaseSnapshot(sCodex.leaseId);
    claudeAdapter.releaseSnapshot(sClaude.leaseId);
  });

  it('resolves an app candidate to a RuntimeAppRegistration whose mcpServerKeys are its connector declared keys (K1)', async () => {
    const appCandidate = pluginCandidate({
      key: 'plug:app:gmail',
      capabilityId: 'gmail-app',
      kind: 'app',
      logicalName: 'gmail-app',
      app: { id: 'gmail-app', connectorId: 'gmail' },
      connector: {
        id: 'gmail',
        mcpServers: [
          { serverName: 'gmail-mcp', transport: 'http', url: 'https://example.invalid/mcp' },
          { serverName: 'gmail-admin', transport: 'http', url: 'https://example.invalid/admin' },
        ],
        auth: { type: 'oauth', timing: 'ON_FIRST_USE' },
      },
    });
    const resolver = createCapabilityResolver({ inputs: () => makeInputs({ pluginCandidates: [appCandidate] }) });
    const snapshot = await resolver.resolve(CONTEXT);
    const entry = snapshot.entries.find(e => e.summary.key === appCandidate.key)!;
    expect(entry.summary.kind).toBe('app');
    expect(entry.runtimeBinding.kind).toBe('app');
    if (entry.runtimeBinding.kind === 'app') {
      expect(entry.runtimeBinding.app.mcpServerKeys).toEqual(['gmail-mcp', 'gmail-admin']);
    }
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('restricts app routing to keys the connector actually declares — never beyond (K1)', async () => {
    const appCandidate = pluginCandidate({
      key: 'plug:app:gmail',
      capabilityId: 'gmail-app',
      kind: 'app',
      logicalName: 'gmail-app',
      app: { id: 'gmail-app', connectorId: 'gmail', routing: { compose: 'gmail-mcp', escalate: 'not-declared' } },
      connector: {
        id: 'gmail',
        mcpServers: [{ serverName: 'gmail-mcp', transport: 'http', url: 'https://example.invalid/mcp' }],
      },
    });
    const resolver = createCapabilityResolver({ inputs: () => makeInputs({ pluginCandidates: [appCandidate] }) });
    const snapshot = await resolver.resolve(CONTEXT);
    const entry = snapshot.entries.find(e => e.summary.key === appCandidate.key)!;
    // Unconditional first, as the sibling case above already does: the narrowing
    // below is the routing claim itself, so on its own it cannot fail. A
    // candidate that stops resolving to an app skips the block and the case
    // reports green having asserted nothing at all.
    expect(entry.summary.kind).toBe('app');
    expect(entry.runtimeBinding.kind).toBe('app');
    if (entry.runtimeBinding.kind === 'app') {
      // 'escalate' targets 'not-declared' which is not a connector server → dropped.
      expect(entry.runtimeBinding.app.mcpServerKeys).toEqual(['gmail-mcp']);
    }
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('keeps an app without matching connector metadata visible but unavailable', async () => {
    const appCandidate = pluginCandidate({
      key: 'plug:app:orphan',
      capabilityId: 'orphan-app',
      kind: 'app',
      logicalName: 'orphan-app',
      app: { id: 'orphan-app', connectorId: 'missing' },
    });
    const resolver = createCapabilityResolver({ inputs: () => makeInputs({ pluginCandidates: [appCandidate] }) });
    const snapshot = await resolver.resolve(CONTEXT);
    const entry = snapshot.entries.find(item => item.summary.key === appCandidate.key)!;
    expect(entry.summary.enabled).toBe(false);
    expect(entry.summary.unavailableReason).toBe('unsupported-runtime');
    expect(entry.summary.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.app.connector_unresolved');
    expect(toAgentRuntime(snapshot).apps).toEqual([]);
    resolver.releaseSnapshot(snapshot.leaseId);
  });
});

describe('CapabilityResolver — safe views strip paths and secrets', () => {
  it('never serializes absolute paths, content hashes or executable hashes', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [
          pluginCandidate({ key: 'plug:hook:pre', capabilityId: 'c-hook', kind: 'hook', logicalName: 'pre', trust: { required: true, executableHash: 'deadbeef'.repeat(8) } }),
        ],
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const composerJson = JSON.stringify(toComposerCatalog(snapshot));
    const userJson = JSON.stringify(toUserCatalog(snapshot));
    for (const json of [composerJson, userJson]) {
      expect(json).not.toContain('/abs/managed/');
      expect(json).not.toContain('a'.repeat(64)); // native contentHash
      expect(json).not.toContain('deadbeef'.repeat(8)); // executableHash
      expect(json).not.toContain('SKILL.md'); // bundle relative path
    }
    // But the server-only runtime view DOES keep the pinned resource.
    const runtimeJson = JSON.stringify(toAgentRuntime(snapshot));
    expect(runtimeJson).toContain('/abs/managed/');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

});

describe('CapabilityResolver — lease lifecycle', () => {
  it('withCapabilitySnapshot releases the lease on success and on projection error', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    await withCapabilitySnapshot(resolver, CONTEXT, snap => toComposerCatalog(snap));
    expect(resolver.leaseCount()).toBe(0);

    await expect(
      withCapabilitySnapshot(resolver, CONTEXT, () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(resolver.leaseCount()).toBe(0);
    expect(resolver.referencedInstances().size).toBe(0);
  });

  it('tracks referenced plugin instances until the lease is released', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);
    expect(resolver.referencedInstances().size).toBe(1);
    resolver.releaseSnapshot(snapshot.leaseId);
    expect(resolver.referencedInstances().size).toBe(0);
  });

  it('holds and releases the backing immutable plugin-instance lease once', async () => {
    let held = 0;
    let released = 0;
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        acquirePluginInstanceLease: () => {
          held += 1;
          return () => { released += 1; };
        },
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    expect(held).toBe(1);
    expect(released).toBe(0);
    resolver.releaseSnapshot(snapshot.leaseId);
    resolver.releaseSnapshot(snapshot.leaseId);
    expect(released).toBe(1);
  });

  it('revoke-active-snapshot marks the matching lease inactive (fail-closed)', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);
    expect(resolver.isLeaseActive(snapshot.leaseId)).toBe(true);
    resolver.invalidate({ kind: 'workspace', workspaceId: 'ws-1' }, 'plugin-uninstall', 'revoke-active-snapshot');
    expect(resolver.isLeaseActive(snapshot.leaseId)).toBe(false);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('refresh-before-next-turn does not revoke an in-flight lease', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);
    resolver.invalidate({ kind: 'workspace', workspaceId: 'ws-1' }, 'metadata-add', 'refresh-before-next-turn');
    expect(resolver.isLeaseActive(snapshot.leaseId)).toBe(true);
    resolver.releaseSnapshot(snapshot.leaseId);
  });
});

// plugin-dependencies.md § Resolve dependency errors (`:206`-`:217`).
describe('CapabilityResolver — plugin dependencies', () => {
  const GUARD_INSTANCE = 'plugin://m/vault@2.1.4#' + 'a'.repeat(64);
  const KIT_INSTANCE = 'plugin://m/deploy-kit@3.1.0#' + 'b'.repeat(64);

  function plugin(over: Partial<InstalledPluginInput> & { pluginId: string; version: string }): InstalledPluginInput {
    const instanceId = over.pluginInstanceId ?? (`plugin://m/${over.pluginId}@${over.version}#` + 'b'.repeat(64));
    return {
      pluginInstanceId: instanceId,
      pluginKey: `m/${over.pluginId}`,
      marketplaceId: 'm',
      bundleHash: 'b'.repeat(64),
      cacheRef: { marketplaceId: 'm', pluginId: over.pluginId, version: over.version, bundleHash: 'b'.repeat(64) },
      manifest: {
        schemaVersion: 1,
        kind: 'plugin',
        id: over.pluginId,
        name: over.pluginId,
        version: over.version,
        capabilities: [],
      },
      origin: { source: 'marketplace', resolvedAt: 0 },
      installedAt: 1000,
      diagnostics: [],
      ...over,
    };
  }

  /** `deploy-kit`'s only PreToolUse guard hook lives in the `vault` dependency. */
  function dependencyInputs(over: {
    dependencies?: NonNullable<InstalledPluginInput['manifest']['dependencies']>;
    installGuard?: boolean;
    guardVersion?: string;
    guardEnabled?: boolean;
  } = {}): CapabilityResolutionInputs {
    const guard = plugin({ pluginId: 'vault', version: over.guardVersion ?? '2.1.4', pluginInstanceId: GUARD_INSTANCE });
    const kit = plugin({ pluginId: 'deploy-kit', version: '3.1.0', pluginInstanceId: KIT_INSTANCE });
    kit.manifest = { ...kit.manifest, dependencies: over.dependencies ?? [{ name: 'vault' }] };
    const installedPlugins = over.installGuard === false ? [kit] : [guard, kit];
    return makeInputs({
      installedPlugins,
      activePluginInstances: Object.fromEntries(installedPlugins.map(entry => [entry.pluginKey, entry.pluginInstanceId])),
      pluginCandidates: [pluginCandidate({
        key: 'plug:hook:pre-tool-use',
        capabilityId: 'hook.guard',
        kind: 'hook',
        logicalName: 'guard',
        pluginKey: 'm/deploy-kit',
        pluginInstanceId: KIT_INSTANCE,
        runtimeDefinition: {
          kind: 'hook',
          id: 'hook.guard',
          hook: { id: 'guard', event: 'PreToolUse', type: 'command', command: './guard.sh' },
        },
      })],
      resolveActivation: target => (
        over.guardEnabled === false && target.pluginKey === 'm/vault'
          ? { enabled: false, suppressed: true, capabilities: {} }
          : { enabled: true, suppressed: false, capabilities: {} }
      ),
    });
  }

  // `:208` — "Claude Code disables the affected plugin until you resolve the
  // error." The inverse exposure this whole slice exists for: without it the
  // dependent activates its own components while the dependency holding its
  // guard is absent.
  it.each([
    ['the dependency is not installed', { installGuard: false }],
    ['the dependency is installed but disabled', { guardEnabled: false }],
  ] as const)('disables every capability of the dependent when %s', async (_label, over) => {
    const resolver = createCapabilityResolver({ inputs: () => dependencyInputs(over) });
    const snapshot = await resolver.resolve(CONTEXT);

    const entry = snapshot.entries.find(candidate => candidate.summary.key === 'plug:hook:pre-tool-use');
    expect(entry?.summary.enabled).toBe(false);
    expect(entry?.summary.unavailableReason).toBe('dependency-unsatisfied');
    // The runtime view is what a turn arms from: the guard hook is simply absent,
    // and so is everything else the dependent ships.
    expect(toAgentRuntime(snapshot).hooks).toEqual([]);

    const installed = snapshot.installedPlugins.find(candidate => candidate.pluginKey === 'm/deploy-kit');
    expect(installed?.activationEnabled).toBe(false);
    expect(installed?.dependencyErrors).toEqual([{ code: 'dependency-unsatisfied', dependency: 'vault' }]);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('loads the dependent once the dependency is installed and enabled', async () => {
    const resolver = createCapabilityResolver({ inputs: () => dependencyInputs() });
    const snapshot = await resolver.resolve(CONTEXT);

    expect(toAgentRuntime(snapshot).hooks).toHaveLength(1);
    const installed = snapshot.installedPlugins.find(candidate => candidate.pluginKey === 'm/deploy-kit');
    expect(installed?.activationEnabled).toBe(true);
    // `:217` — "Plugins that loaded cleanly omit the field."
    expect(installed?.dependencyErrors).toBeUndefined();
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  // `:137` and `:214` — the range is checked at LOAD time even where tag-based
  // fetching does not apply.
  it('disables the dependent when the installed dependency falls outside the declared range', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => dependencyInputs({
        dependencies: [{ name: 'vault', version: '~2.1.0', versionRangeValid: true }],
        guardVersion: '3.0.0',
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);

    const installed = snapshot.installedPlugins.find(candidate => candidate.pluginKey === 'm/deploy-kit');
    expect(installed?.dependencyErrors).toEqual([{
      code: 'dependency-version-unsatisfied',
      dependency: 'vault',
      range: '~2.1.0',
      installedVersion: '3.0.0',
    }]);
    expect(toUserCatalog(snapshot).installedPlugins.find(entry => entry.pluginKey === 'm/deploy-kit'))
      .toMatchObject({
        activation: { effective: 'inactive' },
        dependencyErrors: [{ code: 'dependency-version-unsatisfied', message: expect.stringContaining('version 3.0.0 is installed') }],
      });
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('satisfies a declared range the installed version matches', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => dependencyInputs({
        dependencies: [{ name: 'vault', version: '~2.1.0', versionRangeValid: true }],
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    expect(toAgentRuntime(snapshot).hooks).toHaveLength(1);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  // `:213` — an unparseable range is a `range-conflict` that disables the plugin,
  // never "no constraint".
  it('disables the dependent when a declared range is not valid semver', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => dependencyInputs({
        dependencies: [{ name: 'vault', version: 'not-a-range', versionRangeValid: false }],
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    expect(snapshot.installedPlugins.find(candidate => candidate.pluginKey === 'm/deploy-kit')?.dependencyErrors)
      .toEqual([{ code: 'range-conflict', dependency: 'vault', range: 'not-a-range' }]);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  // `:46` — a dependency resolves within the DECLARING plugin's marketplace unless
  // it names another one.
  it('does not satisfy a dependency from a different marketplace', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => dependencyInputs({ dependencies: [{ name: 'vault', marketplace: 'other' }] }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    expect(snapshot.installedPlugins.find(candidate => candidate.pluginKey === 'm/deploy-kit')?.dependencyErrors)
      .toEqual([{ code: 'dependency-unsatisfied', dependency: 'vault', marketplace: 'other' }]);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  // `:212` counts "installed but disabled" as unsatisfied, and a plugin disabled
  // for its OWN missing dependency is disabled — so the chain has to settle.
  it('propagates a missing dependency up a three-deep chain', async () => {
    const head = plugin({ pluginId: 'head', version: '1.0.0', pluginInstanceId: 'plugin://m/head@1.0.0#' + 'c'.repeat(64) });
    head.manifest = { ...head.manifest, dependencies: [{ name: 'middle' }] };
    const middle = plugin({ pluginId: 'middle', version: '1.0.0', pluginInstanceId: 'plugin://m/middle@1.0.0#' + 'd'.repeat(64) });
    middle.manifest = { ...middle.manifest, dependencies: [{ name: 'absent-tail' }] };
    const installedPlugins = [head, middle];
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        installedPlugins,
        activePluginInstances: Object.fromEntries(installedPlugins.map(entry => [entry.pluginKey, entry.pluginInstanceId])),
        pluginCandidates: [],
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);

    const byKey = new Map(snapshot.installedPlugins.map(entry => [entry.pluginKey, entry]));
    expect(byKey.get('m/middle')?.dependencyErrors)
      .toEqual([{ code: 'dependency-unsatisfied', dependency: 'absent-tail' }]);
    expect(byKey.get('m/head')?.dependencyErrors)
      .toEqual([{ code: 'dependency-unsatisfied', dependency: 'middle' }]);
    expect(byKey.get('m/head')?.activationEnabled).toBe(false);
    resolver.releaseSnapshot(snapshot.leaseId);
  });
});

// plugins/components.md#monitors (was lines 288-336 and 396 of the retired plugins-reference page).
describe('CapabilityResolver — plugin command monitors', () => {
  const INSTANCE = 'plugin://m/p@1.0.0#' + 'b'.repeat(64);

  const commandMonitorCandidate = (): PluginProjectionCandidate => pluginCandidate({
    key: 'plug:monitor:deploy',
    capabilityId: 'monitor.deploy-status',
    kind: 'monitor',
    logicalName: 'deploy-status',
    trust: { required: true, executableHash: 'e'.repeat(64) },
    runtimeDefinition: {
      kind: 'monitor',
      id: 'monitor.deploy-status',
      monitor: {
        form: 'command',
        id: 'deploy-status',
        command: 'tail -F ./deploy.log',
        description: 'Deployment status changes',
        when: 'always',
      },
    },
  });

  const scheduledMonitorCandidate = (): PluginProjectionCandidate => pluginCandidate({
    key: 'plug:monitor:remind',
    capabilityId: 'monitor.remind',
    kind: 'monitor',
    logicalName: 'remind',
    resource: { pluginInstanceId: INSTANCE, relativePath: 'monitors/remind.md', contentHash: 'd'.repeat(64) },
    runtimeDefinition: {
      kind: 'monitor',
      id: 'monitor.remind',
      monitor: { id: 'remind', path: 'monitors/remind.md', cron: '0 * * * *' },
    },
  });

  const scopes = (over: Partial<{ global: string; workspace: string; project: string; managed: string }>) => () => ({
    global: 'unset',
    workspace: 'unset',
    project: 'unset',
    ...over,
  }) as ReturnType<NonNullable<CapabilityResolutionInputs['resolvePluginScopeActivation']>>;

  it('binds a command monitor with its command, description, when and stable plugin key', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({ pluginCandidates: [commandMonitorCandidate()] }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const runtime = toAgentRuntime(snapshot);

    expect(runtime.monitors).toEqual([{
      key: 'plug:monitor:deploy',
      monitorId: 'deploy-status',
      executableHash: 'e'.repeat(64),
      pluginInstanceId: INSTANCE,
      form: 'command',
      command: 'tail -F ./deploy.log',
      description: 'Deployment status changes',
      when: 'always',
      pluginKey: 'pk-1',
    }]);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  // `:396` — for a project-scope plugin, "Background monitors do not load".
  it('refuses a command monitor whose plugin is enabled only at project scope', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [commandMonitorCandidate()],
        resolvePluginScopeActivation: scopes({ project: 'enabled' }),
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);

    const entry = snapshot.entries.find(candidate => candidate.summary.key === 'plug:monitor:deploy');
    expect(entry?.summary.enabled).toBe(false);
    expect(entry?.summary.unavailableReason).toBe('project-scope-monitor');
    // The runtime view is what the host arms from, so nothing can start it.
    expect(toAgentRuntime(snapshot).monitors).toEqual([]);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it.each([
    ['a global enable', { global: 'enabled', project: 'enabled' }],
    ['a workspace enable', { workspace: 'enabled', project: 'enabled' }],
    ['a managed force-enable', { managed: 'enabled', project: 'enabled' }],
  ] as const)('still loads a command monitor when the user or an administrator also owns %s', async (_label, over) => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [commandMonitorCandidate()],
        resolvePluginScopeActivation: scopes(over),
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);

    expect(toAgentRuntime(snapshot).monitors).toHaveLength(1);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  // A scheduled monitor reads a pinned bundle text resource and spawns nothing,
  // so `:396`'s refusal does not reach it.
  it('leaves a scheduled monitor untouched at project scope', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [scheduledMonitorCandidate()],
        resolvePluginScopeActivation: scopes({ project: 'enabled' }),
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);

    expect(toAgentRuntime(snapshot).monitors).toMatchObject([{ monitorId: 'remind', cron: '0 * * * *' }]);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  // An absent reader means the context has no project policy layer at all, so
  // nothing there can be project-scoped. Treating absence as project scope would
  // refuse every monitor in every non-policy context.
  it('does not refuse a command monitor when no scope-activation reader is supplied', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({ pluginCandidates: [commandMonitorCandidate()] }),
    });
    const snapshot = await resolver.resolve(CONTEXT);
    expect(toAgentRuntime(snapshot).monitors).toHaveLength(1);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  // `:334` — "Monitor processes don't receive `CLAUDE_PLUGIN_OPTION_<KEY>`
  // environment variables". B1b routed that map onto hook registrations only;
  // this pins that a monitor binding never grows a field for it.
  it('never carries a plugin option environment onto a monitor binding', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => makeInputs({
        pluginCandidates: [commandMonitorCandidate()],
        pluginOptionEnvironmentFor: () => ({ CLAUDE_PLUGIN_OPTION_TOKEN: 'secret-value' }),
      }),
    });
    const snapshot = await resolver.resolve(CONTEXT);

    expect(JSON.stringify(toAgentRuntime(snapshot).monitors)).not.toContain('CLAUDE_PLUGIN_OPTION');
    expect(JSON.stringify(toAgentRuntime(snapshot).monitors)).not.toContain('secret-value');
    resolver.releaseSnapshot(snapshot.leaseId);
  });
});

describe('F3: sanitize every minted MCP wire name (2026-08-11 follow-up)', () => {
  // `capMcpNameSegment` truncates but never sanitizes, and until this fix the
  // sanitizer ran only inside `pluginMcpWireName` — a scoped/native `.mcp.json`
  // server whose name carried a space or a dot kept it straight into the wire
  // name, and `tryParsePiDynamicMcpBindingName`'s `[A-Za-z0-9_-]` regex then
  // rejected every one of its proxy tool names (silently, since T1 made that a
  // drop rather than a throw).
  it('sanitizes a scoped/native MCP name before minting its wire name, so its tool names parse', async () => {
    const inputs = makeInputs();
    inputs.nativeInventory.records.push(
      nativeRecord({ key: 'mcp:ws:dirty', kind: 'mcp', logicalName: 'my server.v2' }),
    );
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);

    const entry = snapshot.entries.find(e => e.summary.key === 'mcp:ws:dirty')!;
    const wireName = entry.runtimeBinding.kind === 'mcp' ? entry.runtimeBinding.server.wireName : undefined;
    expect(wireName).toBe('my_server_v2');
    expect(wireName).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tryParsePiDynamicMcpBindingName(`mcp__${wireName}__list`)).toEqual({ wireName: 'my_server_v2', toolName: 'list' });
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  // The review finding this pair closes: the sanitizer maps every character
  // outside `[A-Za-z0-9_-]` to `_` and then trims the edges, so a name built
  // ENTIRELY of rejected characters sanitizes to the empty string. `мой сервер`
  // is not a hypothetical in this product — a Cyrillic-named scoped
  // `.mcp.json` server is ordinary — and an empty wire name is dropped from
  // the runtime pool rather than merely mangled. Before the `server-<hash>`
  // fallback the mint really could produce it, which is why the F3 net's own
  // comment claiming this was unreachable through `resolve()` was wrong.
  it('mints a stable fallback wire name for a name with no usable character at all, rather than an empty one', async () => {
    const inputs = makeInputs();
    inputs.nativeInventory.records.push(
      nativeRecord({ key: 'mcp:ws:cyrillic', kind: 'mcp', logicalName: 'мой сервер' }),
    );
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);

    const entry = snapshot.entries.find(e => e.summary.key === 'mcp:ws:cyrillic')!;
    const wireName = entry.runtimeBinding.kind === 'mcp' ? entry.runtimeBinding.server.wireName : undefined;
    expect(wireName).toMatch(/^server-[0-9a-f]{10}$/);
    expect(wireName).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tryParsePiDynamicMcpBindingName(`mcp__${wireName}__list`)).toEqual({ wireName: wireName!, toolName: 'list' });
    // The net stays silent, which is the point of the fallback: the entry is
    // runnable and its wire name is usable, so nothing is warned about.
    expect(snapshot.diagnostics.map(d => d.code)).not.toContain('capability.mcp.unusable-wire-name');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('gives two differently-named all-disallowed servers DISTINCT fallback wire names in one resolve', async () => {
    // A constant fallback (`|| 'server'`, the shape `pluginMcpWireName` uses
    // where its inputs are already namespaced) would collapse both of these
    // onto one wire name and hand one server's tools to the other. Keying the
    // fallback on `summary.key` is what prevents it.
    const inputs = makeInputs();
    inputs.nativeInventory.records.push(
      nativeRecord({ key: 'mcp:ws:cyrillic-a', kind: 'mcp', logicalName: 'мой сервер' }),
      nativeRecord({ key: 'mcp:ws:cyrillic-b', kind: 'mcp', logicalName: '日本語' }),
    );
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);

    const wireNameOf = (key: string) => {
      const entry = snapshot.entries.find(e => e.summary.key === key)!;
      return entry.runtimeBinding.kind === 'mcp' ? entry.runtimeBinding.server.wireName : undefined;
    };
    const first = wireNameOf('mcp:ws:cyrillic-a');
    const second = wireNameOf('mcp:ws:cyrillic-b');
    expect(first).toMatch(/^server-[0-9a-f]{10}$/);
    expect(second).toMatch(/^server-[0-9a-f]{10}$/);
    expect(first).not.toBe(second);
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('leaves a clean builtin dp wire name byte-unchanged (regression guard: the sanitizer must never rename a builtin)', async () => {
    const inputs = makeInputs();
    inputs.nativeInventory.records.push(
      nativeRecord({ key: 'mcp:builtin:t-tracker', kind: 'mcp', logicalName: 't-tracker', scope: { kind: 'builtin' } }),
    );
    const resolver = createCapabilityResolver({ inputs: () => inputs });
    const snapshot = await resolver.resolve(CONTEXT);

    const entry = snapshot.entries.find(e => e.summary.key === 'mcp:builtin:t-tracker')!;
    const wireName = entry.runtimeBinding.kind === 'mcp' ? entry.runtimeBinding.server.wireName : undefined;
    expect(wireName).toBe('t-tracker');
    resolver.releaseSnapshot(snapshot.leaseId);
  });

  it('the net: diagnoses a runnable MCP entry whose wire name cannot parse, constructed directly rather than via the mint', () => {
    // After the sanitize-then-cap fix above, `resolve()` cannot itself produce
    // an unusable wire name — the two cases above are the proof. So this
    // exercises `diagnoseUnusableMcpWireNames` in isolation, on a hand-built
    // entry whose wire name the mint never touched, per the brief's
    // "construct the condition directly, not by weakening the sanitizer".
    const makeEntry = (wireName: string, over: Partial<ResolvedCapability> = {}): ResolvedCapabilityEntry => ({
      summary: {
        key: 'mcp:forced:bad',
        kind: 'mcp',
        logicalName: 'forced bad name',
        origin: 'native',
        scope: { kind: 'workspace', workspaceId: 'ws-1' },
        enabled: true,
        selectedAsUnqualifiedAlias: true,
        readOnly: true,
        trustState: 'not-required',
        credentialState: 'not-required',
        diagnostics: [],
        ...over,
      },
      runtimeBinding: {
        kind: 'mcp',
        server: {
          key: 'mcp:forced:bad',
          wireName,
          logicalName: 'forced bad name',
          definition: { type: 'stdio', command: '' },
        },
      },
    });

    const bad = makeEntry('forced bad name!');
    const diagnostics: CapabilityDiagnostic[] = [];
    diagnoseUnusableMcpWireNames([bad], diagnostics);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'capability.mcp.unusable-wire-name',
      capabilityKey: 'mcp:forced:bad',
      safeArgs: { server: 'forced bad name' },
    }));

    // Negative: a clean wire name on an equally-runnable entry stays silent.
    const clean = makeEntry('forced_bad_name');
    const cleanDiagnostics: CapabilityDiagnostic[] = [];
    diagnoseUnusableMcpWireNames([clean], cleanDiagnostics);
    expect(cleanDiagnostics).toEqual([]);

    // Boundary: the same bad wire name on a non-runnable (disabled) entry also
    // stays silent — an entry that never reaches the pool has nothing this net
    // needs to warn about.
    const badButDisabled = makeEntry('forced bad name!', { enabled: false, unavailableReason: 'source-disabled' });
    const disabledDiagnostics: CapabilityDiagnostic[] = [];
    diagnoseUnusableMcpWireNames([badButDisabled], disabledDiagnostics);
    expect(disabledDiagnostics).toEqual([]);
  });
});

describe('an agent row says where it can actually run (Q7 / Q6-D4)', () => {
  // The gate measured all 12 agents reading `state: active` while the Codex
  // runtime registered none of them
  // (`.superpowers/sdd/q6-agent-invocation-report.md`, Q6-D4): "Active is a
  // claim the runtime does not honour."
  //
  // The Codex row USED to be the refusal, and it was a wiring gap on our side
  // rather than a missing feature on theirs: `config-schema.json` carries
  // `AgentsToml.additionalProperties -> AgentRoleToml`, i.e. `[agents.<role>]`
  // blocks whose `config_file` points at a role-specific config layer — the
  // substance of a definition — and `config-writer.ts` simply emitted none.
  //
  // That gap is closed. `buildCodexAgentRoles` writes the blocks and one role
  // layer each, `CodexAgent.createRuntime` passes the session's definitions in,
  // and `AGENT_DEFINITION_RUNTIMES` admits `codex-runtime`, so the honest row on
  // a Codex session is now `active`. The gate itself is unchanged and still
  // refuses `nestor-cloud-agent`, which is what the negative row below measures.
  //
  // The principle has not moved: the catalog must not lie about what the active
  // runtime supports. Only the answer for one runtime has.
  function agentInputs(): CapabilityResolutionInputs {
    const base = makeInputs();
    return {
      ...base,
      nativeInventory: {
        ...base.nativeInventory,
        records: [
          ...base.nativeInventory.records,
          nativeRecord({ key: 'agent:ws:reviewer', kind: 'agent', logicalName: 'reviewer' }),
        ],
      },
      pluginCandidates: [
        ...(base.pluginCandidates ?? []),
        pluginCandidate({
          key: 'plug:agent:scan',
          capabilityId: 'c-agent-scan',
          kind: 'agent',
          logicalName: 'scan',
          resource: {
            pluginInstanceId: 'plugin://m/p@1.0.0#' + 'b'.repeat(64),
            relativePath: 'agents/scan.md',
            contentHash: 'e'.repeat(64),
          },
        }),
      ],
    };
  }

  async function agentRows(provider?: CapabilityContext['provider']) {
    const resolver = createCapabilityResolver({ inputs: agentInputs });
    const snapshot = await resolver.resolve({ ...CONTEXT, ...(provider ? { provider } : {}) });
    const rows = toUserCatalog(snapshot).capabilities.filter(entry => entry.kind === 'agent');
    const runtime = toAgentRuntime(snapshot);
    resolver.releaseSnapshot(snapshot.leaseId);
    return { rows, runtimeAgentKeys: runtime.agents.map(agent => agent.key).sort() };
  }

  it('refuses an agent with a readable reason on a runtime that dispatches none', async () => {
    // `nestor-cloud-agent` is a remote A2A backend that runs no local
    // definitions, and since Codex was wired it is the only provider left that
    // the gate refuses — which makes it the row that keeps the gate honest.
    const { rows, runtimeAgentKeys } = await agentRows('nestor-cloud-agent');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.state).toBe('unsupported-runtime');
      expect(row.unavailableReason).toBe('unsupported-runtime');
    }
    // `isRunnable`/`mayReachRuntimePool` both exclude `unsupported-runtime`, so
    // the refusal is not merely cosmetic — the definitions never reach the turn.
    expect(runtimeAgentKeys).toEqual([]);
  });

  it('keeps agents active on the three runtimes that really run them', async () => {
    // The positive control. An absence claim on the refused row is worth nothing
    // unless the same rig shows the row going active elsewhere — Pi, the Claude
    // SDK's `agents` option and codex's `[agents.<role>]` all dispatch these
    // definitions for real.
    for (const provider of ['pi', 'anthropic', 'codex-runtime'] as const) {
      const { rows, runtimeAgentKeys } = await agentRows(provider);
      expect(rows.length).toBe(2);
      for (const row of rows) expect(row.state).toBe('active');
      expect(runtimeAgentKeys).toEqual(['agent:ws:reviewer', 'plug:agent:scan']);
    }
  });

  it('leaves the provider-neutral catalog untouched', async () => {
    // A WORKSPACE-scoped `{ workspaceId }` read has no session, so it resolves
    // provider-blind. It must NOT read "unavailable" there: which runtime a
    // future session picks is unknown, and the same trap
    // `storage-runtime.ts:1076` records for managed activation ("would make the
    // plugin run for the agent and read as inactive in the UI") applies in the
    // other direction here.
    //
    // These three cases are resolver-level and hand-build their context, which
    // is exactly why they could not catch Q8-D4: production's context came from
    // `resolveCapabilityContext`, which set `provider` on no branch, so the gate
    // was dead on every user-readable surface while all three stayed green. The
    // seam test that CAN fail that way lives at the RPC handler —
    // `server-core/src/handlers/rpc/__tests__/capabilities.test.ts`, describe
    // "Q8-D4". Keep both: these prove the rule, that one proves it is reached.
    const { rows, runtimeAgentKeys } = await agentRows(undefined);
    for (const row of rows) expect(row.state).toBe('active');
    expect(runtimeAgentKeys).toEqual(['agent:ws:reviewer', 'plug:agent:scan']);
  });
});

/**
 * P6.129 — the catalog and the codex drop notice stop contradicting each other.
 *
 * `buildCodexAgentRoles` denies a role that declares a tool grant and
 * `formatCodexAgentRoleDropDiagnostics` tells the user it "cannot be spawned in
 * this session", while the catalog said `active` about the same definition.
 *
 * ## What each test kills
 *
 *  - "refuses a plugin agent whose tool grant codex cannot honour" dies if the
 *    gate is removed. It carries its own POSITIVE CONTROL in the same run — a
 *    grant-less plugin agent and a native agent stay `active` on the same
 *    resolve — so a formatter that disabled every agent on codex cannot pass it.
 *  - "keeps the same definition active on the runtimes that can express it" is
 *    the runtime axis: the refusal is codex's, not a global narrowing.
 *  - "agrees with `buildCodexAgentRoles` on every arm, including `tools: []`" is
 *    the anti-drift pin, and it calls the WRITER rather than restating its
 *    condition. The empty-array arm is the one a `.length` test gets wrong.
 */
describe('P6.129 — a codex agent role denied for its tool grant does not read active', () => {
  const CODEX_HOME = join(tmpdir(), 'nessy-p6129-unused');

  function toolGrantInputs(tools?: string[]): CapabilityResolutionInputs {
    const base = makeInputs();
    return {
      ...base,
      nativeInventory: {
        ...base.nativeInventory,
        // Control 1: a native agent that declares NO grant. It must stay
        // `active` on every runtime — P6.551 gave this gate a native arm, and
        // the arm must refuse a grant rather than refuse agents.
        records: [
          ...base.nativeInventory.records,
          nativeRecord({ key: 'agent:ws:reviewer', kind: 'agent', logicalName: 'reviewer' }),
          // P6.551's subject: a FILE-based agent whose frontmatter declares one.
          // `agentDeclaresToolGrant` is what the inventory scan stamps, and it is
          // presence rather than content — `tools: []` denies exactly as
          // `tools: Read` does, because codex has no per-role tool policy.
          nativeRecord({
            key: 'agent:ws:granted',
            kind: 'agent',
            logicalName: 'granted',
            agentDeclaresToolGrant: true,
          }),
        ],
      },
      pluginCandidates: [
        ...(base.pluginCandidates ?? []),
        // Control 2: a plugin agent with NO grant, on the same resolve.
        pluginCandidate({
          key: 'plug:agent:plain',
          capabilityId: 'c-agent-plain',
          kind: 'agent',
          logicalName: 'plain',
          runtimeDefinition: { id: 'c-agent-plain', kind: 'agent', agent: { name: 'plain', path: 'agents/plain.md' } },
        }),
        // The subject.
        pluginCandidate({
          key: 'plug:agent:granted',
          capabilityId: 'c-agent-granted',
          kind: 'agent',
          logicalName: 'granted',
          runtimeDefinition: {
            id: 'c-agent-granted',
            kind: 'agent',
            agent: { name: 'granted', path: 'agents/granted.md', ...(tools ? { tools } : {}) },
          },
        }),
      ],
    };
  }

  async function rowsFor(provider: CapabilityContext['provider'], tools?: string[]) {
    const resolver = createCapabilityResolver({ inputs: () => toolGrantInputs(tools) });
    const snapshot = await resolver.resolve({ ...CONTEXT, ...(provider ? { provider } : {}) });
    const rows = new Map(
      toUserCatalog(snapshot).capabilities.filter(entry => entry.kind === 'agent').map(entry => [entry.key, entry]),
    );
    const runtimeAgentKeys = toAgentRuntime(snapshot).agents.map(agent => agent.key).sort();
    resolver.releaseSnapshot(snapshot.leaseId);
    return { rows, runtimeAgentKeys };
  }

  it('refuses a plugin agent whose tool grant codex cannot honour', async () => {
    const { rows, runtimeAgentKeys } = await rowsFor('codex-runtime', ['Read', 'Grep']);
    expect(rows.get('plug:agent:granted')?.state).toBe('unsupported-runtime');
    expect(rows.get('plug:agent:granted')?.unavailableReason).toBe('unsupported-runtime');
    // Positive controls in the same run: the gate is about the GRANT, not about
    // codex, and not about agents.
    expect(rows.get('plug:agent:plain')?.state).toBe('active');
    expect(rows.get('agent:ws:reviewer')?.state).toBe('active');
    // Not cosmetic: `isRunnable`/`mayReachRuntimePool` exclude the reason, so the
    // definition never reaches the turn either — which is what makes the catalog
    // row and the drop notice say the same thing.
    expect(runtimeAgentKeys).toEqual(['agent:ws:reviewer', 'plug:agent:plain']);
  });

  it('P6.551 — refuses a FILE-based agent whose frontmatter declares one, with the plugin arm as the control', async () => {
    const { rows, runtimeAgentKeys } = await rowsFor('codex-runtime', ['Read', 'Grep']);
    // The row's own `done_means`: a native agent declaring `tools:` reads
    // `unsupported-runtime` on codex.
    expect(rows.get('agent:ws:granted')?.state).toBe('unsupported-runtime');
    expect(rows.get('agent:ws:granted')?.unavailableReason).toBe('unsupported-runtime');
    // And it never reaches the turn either, which is what makes the catalog row
    // and codex's own drop diagnostic say the same thing about one definition.
    expect(runtimeAgentKeys).not.toContain('agent:ws:granted');
    // The plugin arm UNCHANGED as the control, in the same resolve.
    expect(rows.get('plug:agent:granted')?.state).toBe('unsupported-runtime');
    expect(rows.get('plug:agent:plain')?.state).toBe('active');
  });

  it('P6.551 — the native arm is codex-only: the same declaration stays active on pi and claude', async () => {
    // The negative control the row needs, and the one a "disable every agent
    // declaring tools" mistake would fail: the refusal is codex's.
    for (const provider of ['pi', 'anthropic'] as const) {
      const { rows, runtimeAgentKeys } = await rowsFor(provider, ['Read', 'Grep']);
      expect(rows.get('agent:ws:granted')?.state, `native grant refused on ${provider}`).toBe('active');
      expect(runtimeAgentKeys).toContain('agent:ws:granted');
    }
  });

  it('keeps the same definition active on the runtimes that can express it', async () => {
    for (const provider of ['pi', 'anthropic'] as const) {
      const { rows } = await rowsFor(provider, ['Read', 'Grep']);
      expect(rows.get('plug:agent:granted')?.state).toBe('active');
    }
    // And provider-blind, where which runtime a future session picks is unknown.
    const { rows } = await rowsFor(undefined, ['Read', 'Grep']);
    expect(rows.get('plug:agent:granted')?.state).toBe('active');
  });

  it('agrees with buildCodexAgentRoles on every arm, including tools: []', async () => {
    // The writer is CALLED rather than restated. `buildCodexAgentRoles` denies on
    // `if (descriptor.tools || descriptor.disallowedTools)`, so an empty array
    // denies — an author who wrote `tools: []` granted nothing, and codex refuses
    // rather than widening the role to the session's whole surface.
    const arms: Array<{ tools?: string[]; disallowedTools?: string[] }> = [
      {},
      { tools: [] },
      { tools: ['Read'] },
      { disallowedTools: [] },
      { disallowedTools: ['Bash'] },
    ];
    for (const arm of arms) {
      const plan = buildCodexAgentRoles({
        codexHome: CODEX_HOME,
        sessionModel: 'tgpt/qwen35-397b-a17b-fp8',
        definitions: [{
          key: 'granted',
          name: 'granted',
          selectedAsUnqualifiedAlias: true,
          description: 'granted',
          systemPrompt: 'body',
          ...arm,
        }],
      });
      const writerDenied = plan.denied.some(entry => entry.reason.includes('tool grant'));
      expect(codexDeclinesAgentToolGrant('codex-runtime', arm)).toBe(writerDenied);
      // And the same predicate is inert off codex, on every arm.
      expect(codexDeclinesAgentToolGrant('pi', arm)).toBe(false);
    }
    // The pin is only worth something if the writer really denied somewhere:
    // without this, an arms table that stopped tripping the writer would make
    // every equality above vacuously true.
    expect(arms.filter(arm => codexDeclinesAgentToolGrant('codex-runtime', arm))).toHaveLength(4);
  });
});

describe('a plugin peripheral says where it can actually run (T17)', () => {
  // Same promise the agent gate above enforces, one surface over. Plugin LSP
  // servers and monitors are wired behind `provider === 'pi'` in
  // `getOrCreateAgentUnchecked`; off Pi neither process exists, and both rows
  // read `active` regardless — a plugin whose card looks healthy while the half
  // of it the user never watches is dead.
  function peripheralInputs(): CapabilityResolutionInputs {
    const base = makeInputs();
    return {
      ...base,
      pluginCandidates: [
        ...(base.pluginCandidates ?? []),
        pluginCandidate({
          key: 'plug:lsp:tsserver',
          capabilityId: 'c-lsp',
          kind: 'lsp',
          logicalName: 'tsserver',
        }),
        pluginCandidate({
          key: 'plug:monitor:dev-server',
          capabilityId: 'c-monitor',
          kind: 'monitor',
          logicalName: 'dev-server',
        }),
      ],
    };
  }

  async function peripheralRows(provider?: CapabilityContext['provider']) {
    const resolver = createCapabilityResolver({ inputs: peripheralInputs });
    const snapshot = await resolver.resolve({ ...CONTEXT, ...(provider ? { provider } : {}) });
    const rows = toUserCatalog(snapshot).capabilities
      .filter(entry => entry.key === 'plug:lsp:tsserver' || entry.key === 'plug:monitor:dev-server');
    const runtime = toAgentRuntime(snapshot);
    resolver.releaseSnapshot(snapshot.leaseId);
    return {
      rows,
      lspIds: (runtime.lspServers ?? []).map(lsp => lsp.lspId).sort(),
      monitorIds: (runtime.monitors ?? []).map(monitor => monitor.monitorId).sort(),
    };
  }

  /**
   * P6.175/P6.176 — this row used to refuse BOTH peripherals on both runtimes,
   * off one predicate. The monitor half of that refusal was wrong: a scheduled
   * plugin monitor steers through `ClaudeAgent.redirect` and codex's own
   * `turn/steer`, and a plugin COMMAND monitor is a supervised process needing
   * no steering primitive at all. The LSP half is right and structural — no SDK
   * seam accepts a provisioned language server, and the shipped codex binary
   * carries no `lsp_servers` at all.
   *
   * So the catalogue now says two different things about two rows on the same
   * runtime, which is what the split records exist to make sayable.
   */
  it('refuses the language server and keeps the monitor on claude', async () => {
    const { rows, lspIds, monitorIds } = await peripheralRows('anthropic');
    expect(rows.length).toBe(2);
    const lspRow = rows.find(row => row.key === 'plug:lsp:tsserver');
    const monitorRow = rows.find(row => row.key === 'plug:monitor:dev-server');
    expect(lspRow?.unavailableReason).toBe('unsupported-runtime');
    expect(monitorRow?.unavailableReason).toBeUndefined();
    // `isRunnable` excludes `unsupported-runtime`, so neither verdict is
    // cosmetic: the LSP registration does not reach the turn and the monitor
    // does.
    expect(lspIds).toEqual([]);
    expect(monitorIds).toEqual(['dev-server']);
  });

  it('refuses the language server and keeps the monitor on codex', async () => {
    // P6.176. Codex's own `turn/steer` is the delivery primitive and we already
    // drive it; the LSP half is measured absent in the shipped binary rather
    // than merely unwired, so the two rows keep different verdicts.
    const { rows, lspIds, monitorIds } = await peripheralRows('codex-runtime');
    expect(rows.length).toBe(2);
    const lspRow = rows.find(row => row.key === 'plug:lsp:tsserver');
    const monitorRow = rows.find(row => row.key === 'plug:monitor:dev-server');
    expect(lspRow?.unavailableReason).toBe('unsupported-runtime');
    expect(monitorRow?.unavailableReason).toBeUndefined();
    expect(lspIds).toEqual([]);
    expect(monitorIds).toEqual(['dev-server']);
  });

  it('keeps both active on Pi, which really runs them', async () => {
    // The positive control. Without it the row above passes on a resolver that
    // simply disables every peripheral everywhere.
    const { rows, lspIds, monitorIds } = await peripheralRows('pi');
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.unavailableReason).toBeUndefined();
    expect(lspIds).toEqual(['tsserver']);
    expect(monitorIds).toEqual(['dev-server']);
  });

  it('leaves the provider-neutral catalog untouched', async () => {
    // A workspace-scoped read has no session and therefore no runtime yet;
    // reporting a definite unavailability from an indefinite input is the trap
    // the agent gate records in the other direction.
    const { rows, lspIds, monitorIds } = await peripheralRows(undefined);
    for (const row of rows) expect(row.unavailableReason).toBeUndefined();
    expect(lspIds).toEqual(['tsserver']);
    expect(monitorIds).toEqual(['dev-server']);
  });

  it('does not gate a plugin hook, whose command form runs everywhere', async () => {
    // The negative subject that keeps the widening honest. Command hooks are
    // supplied a runner on every provider (`buildPinnedAgentAutomationSystem`
    // passes `pluginCommandHookRunner` unconditionally); only four ACTION kinds
    // go unwired, so a whole-row gate on `hook` would lie in the other direction.
    const resolver = createCapabilityResolver({
      inputs: () => {
        const base = makeInputs();
        return {
          ...base,
          pluginCandidates: [
            ...(base.pluginCandidates ?? []),
            pluginCandidate({
              key: 'plug:hook:pre',
              capabilityId: 'c-hook',
              kind: 'hook',
              logicalName: 'PreToolUse',
              resource: {
                pluginInstanceId: 'plugin://m/p@1.0.0#' + 'b'.repeat(64),
                relativePath: 'hooks/pre.sh',
                contentHash: 'f'.repeat(64),
              },
            }),
          ],
        };
      },
    });
    const snapshot = await resolver.resolve({ ...CONTEXT, provider: 'anthropic' });
    const row = toUserCatalog(snapshot).capabilities.find(entry => entry.key === 'plug:hook:pre');
    resolver.releaseSnapshot(snapshot.leaseId);
    expect(row?.unavailableReason).toBeUndefined();
  });
});

describe('a plugin workflow says where it can actually run (P3.34)', () => {
  // The third of the same promise, and the one the capability ledger calls its
  // clearest ADVERTISED anti-pattern: the `workflow` tool and its orchestrator
  // live in the Pi subprocess alone, `BaseAgent.chat` REFUSES a
  // `workflowInvocation` on every other runtime — and the command went on
  // appearing in the menu, so the user picked a command whose only possible
  // outcome was `settings.ai.workflows.dispatchUnavailable`.
  //
  // The gate is worth more than a menu row. `SessionManager`'s
  // `pluginPromptCommandEntries` filters on `entry.summary.enabled`, so a
  // disabled entry leaves the slash registry as well as the catalog — one
  // predicate, both surfaces, and they cannot drift apart.
  function workflowInputs(): CapabilityResolutionInputs {
    const base = makeInputs();
    return {
      ...base,
      // `TRUST_GATED_PLUGIN_CAPABILITY_KINDS` includes `workflow`, so an
      // untrusted one is already refused for a DIFFERENT reason. Trusting it
      // here is what makes the runtime gate the only thing under test.
      resolveTrust: () => 'trusted',
      pluginCandidates: [
        ...(base.pluginCandidates ?? []),
        pluginCandidate({
          key: 'plug:workflow:release',
          capabilityId: 'c-workflow-runtime',
          kind: 'workflow',
          logicalName: 'release',
          trust: { required: true, executableHash: 'e'.repeat(64) },
          resource: {
            pluginInstanceId: 'plugin://m/p@1.0.0#' + 'b'.repeat(64),
            relativePath: 'workflows/release.js',
            contentHash: 'c'.repeat(64),
          },
        }),
      ],
    };
  }

  async function workflowRow(provider?: CapabilityContext['provider']) {
    const resolver = createCapabilityResolver({ inputs: workflowInputs });
    const snapshot = await resolver.resolve({ ...CONTEXT, ...(provider ? { provider } : {}) });
    const row = toUserCatalog(snapshot).capabilities.find(entry => entry.key === 'plug:workflow:release');
    const composer = toComposerCatalog(snapshot).items.find(item => item.key === 'plug:workflow:release');
    // What `pluginPromptCommandEntries` reads to decide whether the command
    // exists at all — the half a catalog-only assertion would miss.
    const entry = snapshot.entries.find(candidate => candidate.summary.key === 'plug:workflow:release');
    resolver.releaseSnapshot(snapshot.leaseId);
    return { row, composer, enabled: entry?.summary.enabled };
  }

  it('refuses the workflow on a runtime with no orchestrator to run it', async () => {
    for (const provider of ['anthropic', 'codex-runtime', 'nestor-cloud-agent'] as const) {
      const { row, composer, enabled } = await workflowRow(provider);
      expect(row, `${provider} lost the row entirely`).toBeDefined();
      expect(row!.unavailableReason, `${provider} still advertises the workflow`)
        .toBe('unsupported-runtime');
      expect(composer?.state).toBe('unsupported-runtime');
      // Not cosmetic: the slash registry's own filter is this flag.
      expect(enabled).toBe(false);
    }
  });

  it('POSITIVE CONTROL — keeps it active on Pi, which really runs it', async () => {
    // Without this the row above passes on a resolver that simply disabled
    // every workflow everywhere, which is a different bug wearing the fix.
    const { row, composer, enabled } = await workflowRow('pi');
    expect(row?.unavailableReason).toBeUndefined();
    expect(composer?.state).toBe('active');
    expect(enabled).toBe(true);
  });

  it('leaves the provider-neutral catalog untouched', async () => {
    // A workspace-scoped read resolves before any session exists, so there is
    // no runtime yet; reporting a definite unavailability from an indefinite
    // input is the trap the agent and peripheral gates both record.
    const { row, composer, enabled } = await workflowRow(undefined);
    expect(row?.unavailableReason).toBeUndefined();
    expect(composer?.state).toBe('active');
    expect(enabled).toBe(true);
  });

  it('does not gate a plugin PROMPT-command, which expands host-side on every runtime', async () => {
    // The negative subject that keeps the widening honest, in the shape the
    // peripheral block uses for `hook`. A prompt-command is expanded by the
    // host and sent as ordinary prose, so it needs no orchestrator and a
    // whole-plugin gate would lie in the other direction.
    const resolver = createCapabilityResolver({
      inputs: () => {
        const base = makeInputs();
        return {
          ...base,
          pluginCandidates: [
            ...(base.pluginCandidates ?? []),
            pluginCandidate({
              key: 'plug:prompt-command:ship',
              capabilityId: 'c-prompt-command',
              kind: 'prompt-command',
              logicalName: 'ship',
              resource: {
                pluginInstanceId: 'plugin://m/p@1.0.0#' + 'b'.repeat(64),
                relativePath: 'commands/ship.md',
                contentHash: 'd'.repeat(64),
              },
            }),
          ],
        };
      },
    });
    const snapshot = await resolver.resolve({ ...CONTEXT, provider: 'anthropic' });
    const row = toUserCatalog(snapshot).capabilities.find(entry => entry.key === 'plug:prompt-command:ship');
    resolver.releaseSnapshot(snapshot.leaseId);
    expect(row?.unavailableReason).toBeUndefined();
  });
});

describe('P6.388 — the ancestor instruction layers the cap dropped', () => {
  it('rides the user catalog as ONE counted, path-free warning', async () => {
    const dropped = [
      { path: '/abs/deep/l9/AGENTS.md', reason: 'ancestor-layer-cap' as const, limit: 8 },
      { path: '/abs/deep/l10/AGENTS.md', reason: 'ancestor-layer-cap' as const, limit: 8 },
    ];
    const resolver = createCapabilityResolver({
      inputs: () => {
        const base = makeInputs();
        return { ...base, nativeInventory: { ...base.nativeInventory, droppedInstructionLayers: dropped } };
      },
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const catalog = toUserCatalog(snapshot);
    resolver.releaseSnapshot(snapshot.leaseId);

    // ONE diagnostic for the whole set, not one per file: a deep monorepo can
    // drop a dozen and twelve identical warnings are noise.
    const notices = catalog.diagnostics.filter(
      diagnostic => diagnostic.code === 'capability.instruction.ancestorLayerCap',
    );
    expect(notices).toEqual([{
      severity: 'warning',
      code: 'capability.instruction.ancestorLayerCap',
      messageKey: 'capability.instruction.ancestorLayerCap',
      safeArgs: { droppedCount: '2', limit: '8' },
    }]);
    // Path-free by contract — the absolute paths stay on the inventory, which
    // is why the count and the cap are the only things that travel.
    expect(JSON.stringify(catalog)).not.toContain('/abs/deep/l9');
  });

  it('says nothing when the cap dropped nothing', async () => {
    // The negative control: a cap that reports on a tree it did not truncate
    // would be worse than one that reports nothing.
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);
    const catalog = toUserCatalog(snapshot);
    resolver.releaseSnapshot(snapshot.leaseId);
    expect(catalog.diagnostics.map(diagnostic => diagnostic.code))
      .not.toContain('capability.instruction.ancestorLayerCap');
  });

  it('the code is sayable in EVERY locale — it is also the message key', async () => {
    // `toSafeDiagnostic` sets `messageKey = code`, and the detail template
    // renders `t(messageKey, { defaultValue: messageKey, ...safeArgs })`. A
    // missing key does not throw — it prints the bare code — so nothing but
    // this pin stops the sentence regressing to `capability.instruction.…`.
    const locales = await import('../../i18n/registry.ts');
    const codes = Object.entries(locales.LOCALE_REGISTRY);
    expect(codes.length).toBeGreaterThan(0);
    for (const [code, entry] of codes) {
      const messages = entry.messages as Record<string, string>;
      const sentence = messages['capability.instruction.ancestorLayerCap'];
      expect(sentence, `${code} is missing the ancestor-layer-cap sentence`).toBeString();
      expect(sentence).toContain('{{droppedCount}}');
      expect(sentence).toContain('{{limit}}');
    }
  });
});

describe('P6.387 — the @path imports the project boundary refused', () => {
  const refused = [
    { path: '/abs/outside/notes.md', importerPath: '/abs/project/CLAUDE.md', reason: 'outside-containment-root' as const },
    { path: '/abs/outside/more.md', importerPath: '/abs/project/CLAUDE.md', reason: 'outside-containment-root' as const },
  ];

  it('rides the user catalog as ONE counted, path-free warning', async () => {
    const resolver = createCapabilityResolver({
      inputs: () => {
        const base = makeInputs();
        return { ...base, nativeInventory: { ...base.nativeInventory, refusedProjectImports: refused } };
      },
    });
    const snapshot = await resolver.resolve(CONTEXT);
    const catalog = toUserCatalog(snapshot);
    resolver.releaseSnapshot(snapshot.leaseId);

    expect(catalog.diagnostics.filter(d => d.code === 'capability.instruction.importOutsideProject')).toEqual([{
      severity: 'warning',
      code: 'capability.instruction.importOutsideProject',
      messageKey: 'capability.instruction.importOutsideProject',
      safeArgs: { refusedCount: '2' },
    }]);
    // Neither the refused file nor the importer may travel on this channel.
    expect(JSON.stringify(catalog)).not.toContain('/abs/outside');
    expect(JSON.stringify(catalog)).not.toContain('/abs/project');
  });

  it('says nothing when the walk refused nothing', async () => {
    const resolver = createCapabilityResolver({ inputs: () => makeInputs() });
    const snapshot = await resolver.resolve(CONTEXT);
    const catalog = toUserCatalog(snapshot);
    resolver.releaseSnapshot(snapshot.leaseId);
    expect(catalog.diagnostics.map(d => d.code))
      .not.toContain('capability.instruction.importOutsideProject');
  });

  it('the code is sayable in EVERY locale — it is also the message key', async () => {
    const locales = await import('../../i18n/registry.ts');
    for (const [code, entry] of Object.entries(locales.LOCALE_REGISTRY)) {
      const sentence = (entry.messages as Record<string, string>)['capability.instruction.importOutsideProject'];
      expect(sentence, `${code} is missing the outside-project-import sentence`).toBeString();
      expect(sentence).toContain('{{refusedCount}}');
    }
  });
});

// F1.766 (origin SIT-b, owner decision 2026-09-26 option A) — a revoke that names a plugin stops only the turns whose
// snapshot holds an instance of that plugin. Before it, an uninstall revoked EVERY lease in its scope, so a busy codex
// session whose install refresh had been deferred (the plugin never reached its snapshot) lost its turn for nothing.
describe('F1.766 — a plugin-named revoke reaches only the leases holding that plugin', () => {
  const OTHER_WORKSPACE: CapabilityContext = { ...CONTEXT, workspaceId: 'ws-2', sessionId: 'sess-2' };
  // `sess-plain` resolves a snapshot that never loaded plugin `pk-1`; every other session holds it.
  const resolverWithAndWithoutPlugin = () => createCapabilityResolver({
    inputs: context => context.sessionId === 'sess-plain'
      ? makeInputs({ installedPlugins: [], activePluginInstances: {}, pluginCandidates: [] })
      : makeInputs(),
  });

  it('THE DEFECT — a lease that never held the plugin keeps its turn; the one that held it is revoked', async () => {
    const resolver = resolverWithAndWithoutPlugin();
    const holding = await resolver.resolve(CONTEXT);
    const plain = await resolver.resolve({ ...CONTEXT, sessionId: 'sess-plain' });
    resolver.invalidate({ kind: 'workspace', workspaceId: 'ws-1' }, 'plugin uninstall (pk-1)', 'revoke-active-snapshot', 'pk-1');
    expect(resolver.isLeaseActive(holding.leaseId)).toBe(false);
    expect(resolver.isLeaseActive(plain.leaseId)).toBe(true);
    // BOUNDARY — the key narrows the scope and never widens it: another workspace's lease holding the plugin is spared.
    const elsewhere = await resolver.resolve(OTHER_WORKSPACE);
    resolver.invalidate({ kind: 'workspace', workspaceId: 'ws-1' }, 'plugin uninstall (pk-1)', 'revoke-active-snapshot', 'pk-1');
    expect(resolver.isLeaseActive(elsewhere.leaseId)).toBe(true);
    for (const lease of [holding, plain, elsewhere]) resolver.releaseSnapshot(lease.leaseId);
  });

  it('CONTROL — a revoke that names no plugin still revokes every lease in its scope (fail-closed default)', async () => {
    const resolver = resolverWithAndWithoutPlugin();
    const holding = await resolver.resolve(CONTEXT);
    const plain = await resolver.resolve({ ...CONTEXT, sessionId: 'sess-plain' });
    resolver.invalidate({ kind: 'workspace', workspaceId: 'ws-1' }, 'source remove', 'revoke-active-snapshot');
    expect(resolver.isLeaseActive(holding.leaseId)).toBe(false);
    expect(resolver.isLeaseActive(plain.leaseId)).toBe(false);
    for (const lease of [holding, plain]) resolver.releaseSnapshot(lease.leaseId);
  });
});
