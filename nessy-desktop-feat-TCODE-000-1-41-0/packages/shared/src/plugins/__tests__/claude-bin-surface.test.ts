/**
 * C6 (discovery half) — the `bin/` surface of a Claude bundle.
 *
 * `plugins-reference.md` § File locations, `bin/`: "Executables added to the
 * Bash tool's PATH. Files here are invokable as bare commands in any Bash tool
 * call while the plugin is enabled."
 *
 * The PATH half SHIPS (`appendPluginBinPath`, wired at `claude-agent.ts` and
 * `pi-agent.ts`), so this header no longer says Nessy does not extend the Bash
 * tool's PATH — that sentence stood here after C6 made it false, and it is the
 * premise every case below rests on. What the file pins is the three things the
 * adapter gets right about the surface:
 *
 *  1. an executable that genuinely cannot resolve is recorded on the DURABLE
 *     channel and NAMED in a warning, so neither the drop nor the name is
 *     silent (P2.153) — and "cannot resolve" is decided by whether any declared
 *     capability KIND carries the bundle root, not by how many capabilities
 *     there are (P2.162): the count gate reported the bundle nobody ships (zero
 *     capabilities) and stayed silent on the agents-only and workflows-only
 *     bundles that people do;
 *  2. a `bin/` file the bundle's own MCP server executes by path is not
 *     deferred — a spurious deferral makes the report `partial`, and
 *     `management-service-v2.ts:553` purges every durable activation grant of a
 *     partial bundle and demands a re-confirm;
 *  3. the reference match is bounded at BOTH ends, so `bin/local-mcp` never
 *     covers a sibling `bin/local-mcp2`. That boundary is the half a
 *     "does the name appear anywhere" check gets wrong, and getting it wrong
 *     silently drops a real command's warning.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePluginBundle } from '../format-adapters.ts';
import type { PluginOrigin } from '../types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'claude-bin-surface-test-'));
});

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function origin(): PluginOrigin {
  return { source: 'local-path', localPath: tempDir, resolvedAt: 1 };
}

/** A minimal Claude bundle with a manifest and one skill so it is a real plugin. */
function claudeBundle(name: string): string {
  const bundle = join(tempDir, name);
  mkdirSync(join(bundle, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(bundle, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0' }),
  );
  mkdirSync(join(bundle, 'skills', 'demo'), { recursive: true });
  writeFileSync(
    join(bundle, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: A demo skill\n---\nRun `cli.js`.\n',
  );
  return bundle;
}

/** A bundle that declares NOTHING — so no capability carries its root. */
function claudeBundleWithoutCapabilities(name: string): string {
  const bundle = join(tempDir, name);
  mkdirSync(join(bundle, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(bundle, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0' }),
  );
  return bundle;
}

/**
 * The capability kinds the Claude adapter imports, split by whether the kind
 * carries the bundle root into the agent runtime view — measured per kind
 * end-to-end (manifest capability -> `resolvePluginProjectionCandidates` ->
 * resolver -> `toAgentRuntime` -> `enabledPluginBundleRoots`) and recorded at
 * `CLAUDE_BUNDLE_ROOT_BEARING_KINDS`. Every row below is a real combination:
 * the kind is the bundle's ONLY declaration, so the row decides on its own
 * whether the bundle's `bin/` is reachable.
 */
const ROOT_BEARING_KINDS = ['skill', 'mcp', 'hook', 'prompt-command', 'lsp', 'monitor', 'output-style'] as const;
const ROOTLESS_KINDS = ['agent', 'workflow'] as const;

type DeclaredKind = (typeof ROOT_BEARING_KINDS)[number] | (typeof ROOTLESS_KINDS)[number];

/**
 * A Claude bundle whose ONLY declaration is one capability of `kind`, so the
 * deferral decision rests entirely on that kind.
 */
function bundleDeclaringOnly(name: string, kind: DeclaredKind): string {
  const bundle = join(tempDir, name);
  const manifest: Record<string, unknown> = { name, version: '1.0.0' };
  mkdirSync(join(bundle, '.claude-plugin'), { recursive: true });
  const write = (relative: string[], content: string): void => {
    mkdirSync(join(bundle, ...relative.slice(0, -1)), { recursive: true });
    writeFileSync(join(bundle, ...relative), content);
  };
  switch (kind) {
    case 'skill':
      write(['skills', 'demo', 'SKILL.md'], '---\nname: demo\ndescription: A demo skill\n---\nBody.\n');
      break;
    case 'mcp':
      write(['.mcp.json'], JSON.stringify({ mcpServers: { local: { command: 'node', args: ['server.js'] } } }));
      break;
    case 'hook':
      write(['hooks', 'hooks.json'], JSON.stringify({
        hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node audit.js' }] }] },
      }));
      break;
    case 'prompt-command':
      write(['commands', 'review.md'], '---\ndescription: Review the diff\n---\nReview $ARGUMENTS.\n');
      break;
    case 'lsp':
      manifest.lspServers = { go: { command: 'gopls', args: ['serve'], extensionToLanguage: { '.go': 'go' } } };
      break;
    case 'monitor':
      write(['monitors', 'monitors.json'], JSON.stringify([
        { name: 'watch', command: 'node watch.js', description: 'Watches the build' },
      ]));
      break;
    case 'output-style':
      write(['output-styles', 'terse.md'], '---\nname: terse\ndescription: Terse\n---\nBe terse.\n');
      break;
    case 'agent':
      write(['agents', 'reviewer.md'], '---\nname: reviewer\ndescription: Reviews changes\n---\nBody.\n');
      break;
    case 'workflow':
      write(['workflows', 'scan.js'], [
        "export const meta = { name: 'scan', description: 'Scan the tree' }",
        "return agent({ agent: 'scout', task: args.input });",
      ].join('\n'));
      break;
  }
  writeFileSync(join(bundle, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
  return bundle;
}

function writeExecutable(bundle: string, ...segments: string[]): void {
  const target = join(bundle, ...segments);
  mkdirSync(join(bundle, ...segments.slice(0, -1)), { recursive: true });
  writeFileSync(target, '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') chmodSync(target, 0o755);
}

function writeMcpConfig(bundle: string, servers: Record<string, unknown>): void {
  writeFileSync(join(bundle, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
}

function deferredKinds(compatibility: { deferred: Array<{ externalKind: string }> } | undefined): string[] {
  return (compatibility?.deferred ?? []).map(entry => entry.externalKind);
}

describe('claude bin/ surface', () => {
  it('costs a bundle nothing once its bin/ actually resolves', async () => {
    // openai/plugins → `superhuman` is the ONE bundle of 180 that ships a bin/
    // directory. C6 put an enabled plugin's bin/ on the Bash tool's PATH, and
    // this fixture declares a skill — so something carries its bundle root and
    // `cli.js` DOES resolve as a bare command.
    //
    // It must therefore not be recorded as a deferred surface: `deferred` sets
    // `compatibility.state` to `partial`, and `management-service-v2` purges
    // every durable activation grant for a partial bundle on its next repair.
    // That is a real cost, and charging it for a folder that works is the bug
    // this test now pins.
    const bundle = claudeBundle('superhuman');
    writeExecutable(bundle, 'bin', 'cli.js');

    const normalized = await normalizePluginBundle(bundle, origin());

    expect(normalized.ok).toBe(true);
    expect(deferredKinds(normalized.compatibility)).toEqual([]);
    expect(normalized.diagnostics
      ?.find(diagnostic => diagnostic.code === 'plugin.format.claude_bin_path_unsupported')).toBeUndefined();
    // Nothing rides `adapter.warnings` either: there is no unrunnable surface to
    // record when the executables resolve.
    expect(normalized.value?.compatibility?.adapter?.warnings
      ?.some(entry => entry.code === 'plugin.format.claude_bin_path_unsupported')).toBeFalsy();
  });

  it('does not defer a bin/ file the bundle already executes by path', async () => {
    const bundle = claudeBundle('bin-backed-mcp');
    writeExecutable(bundle, 'bin', 'local-mcp');
    writeMcpConfig(bundle, { localTool: { command: './bin/local-mcp', args: ['--stdio'] } });

    const normalized = await normalizePluginBundle(bundle, origin());

    expect(normalized.ok).toBe(true);
    // The consequence, not just the record: a `partial` report costs this
    // bundle every durable activation grant it has plus a confirm click.
    expect(deferredKinds(normalized.compatibility)).toEqual([]);
    expect(normalized.compatibility?.state).toBe('supported');
    expect(normalized.diagnostics
      ?.some(diagnostic => diagnostic.code === 'plugin.format.claude_bin_path_unsupported')).toBe(false);
    // Positive control on the same bundle: the command really did import, so
    // the empty `deferred` is a covered executable, not a broken read.
    expect(normalized.value?.capabilities
      .filter(capability => capability.kind === 'mcp')
      .map(capability => (capability.kind === 'mcp' ? capability.mcp.command : undefined)))
      .toEqual(['${NESSY_PLUGIN_ROOT}/bin/local-mcp']);
  });

  it('matches a referenced command at both ends of the name, never as a substring', async () => {
    const bundle = claudeBundle('bin-name-boundary');
    // TRAILING boundary: the executed command is `bin/local-mcp2`, and the
    // unreferenced sibling `local-mcp` is a strict PREFIX of it. Without the
    // `(?![\w.-])` guard, `local-mcp` reads as covered and loses its warning.
    writeExecutable(bundle, 'bin', 'local-mcp');
    writeExecutable(bundle, 'bin', 'local-mcp2');
    // LEADING boundary: a command elsewhere in the bundle ends `.../mybin/tool`,
    // which is not this bundle's `bin/tool`.
    writeExecutable(bundle, 'bin', 'tool');
    writeExecutable(bundle, 'scripts', 'mybin', 'tool');
    writeMcpConfig(bundle, { localTool: { command: './bin/local-mcp2', args: ['--stdio'] } });
    mkdirSync(join(bundle, 'monitors'), { recursive: true });
    writeFileSync(
      join(bundle, 'monitors', 'monitors.json'),
      JSON.stringify([{ name: 'watch', command: './scripts/mybin/tool --watch' }]),
    );

    const normalized = await normalizePluginBundle(bundle, origin());

    // Same reason as above: this bundle declares an MCP server and a monitor, so
    // it carries a root and every executable under bin/ is reachable. "Covered
    // by an explicit command" is no longer what makes one reachable — being in
    // an enabled bundle is.
    expect(deferredKinds(normalized.compatibility)).toEqual([]);
    const warning = normalized.diagnostics
      ?.find(diagnostic => diagnostic.code === 'plugin.format.claude_bin_path_unsupported');
    expect(warning).toBeUndefined();
    // Positive control that the absence above is the new rule and not a matcher
    // that stopped running: a bundle declaring NOTHING carries no root, so its
    // bin/ genuinely cannot resolve — and that case still warns, by name.
    const orphan = claudeBundleWithoutCapabilities('bin-orphan');
    writeExecutable(orphan, 'bin', 'lonely');
    const orphaned = await normalizePluginBundle(orphan, origin());
    const orphanWarning = orphaned.diagnostics
      ?.find(diagnostic => diagnostic.code === 'plugin.format.claude_bin_path_unsupported');
    expect(orphanWarning?.severity).toBe('warning');
    expect(orphanWarning?.message).toContain('lonely');
    // P2.153: this line used to assert `[]` — the silence, not the rule. An
    // unreachable `bin/` is a lost component, so it rides the durable channel
    // too; the dedicated cases below pin that and its boundary.
    expect(deferredKinds(orphaned.compatibility)).toEqual(['bin']);
  });

  it('does not report an unrunnable surface for a bin/ with no command in it', async () => {
    const bundle = claudeBundle('bin-empty');
    mkdirSync(join(bundle, 'bin', 'helpers'), { recursive: true });

    const normalized = await normalizePluginBundle(bundle, origin());

    expect(deferredKinds(normalized.compatibility)).toEqual([]);
    expect(normalized.compatibility?.state).toBe('supported');
  });

  it('records an unreachable bin/ on the durable channel, not only as a diagnostic', async () => {
    // P2.153. `addClaudeBinSurfaceDeferral` took `deferred` and never pushed to
    // it, so the one case it does warn about shipped as a `PluginDiagnostic`
    // only — an install-time value that reaches `diagnosticCodes` and is gone,
    // leaving the fact in `compatibility.adapter.warnings`, which nothing
    // outside tests reads. A bundle whose `bin/` cannot run therefore installed
    // reporting full success. An unreachable executable is a lost component, so
    // it rides `deferred`: the channel with a live reader, and the one that
    // makes the report say `partial`.
    const bundle = claudeBundleWithoutCapabilities('bin-unreachable');
    writeExecutable(bundle, 'bin', 'lonely');

    const normalized = await normalizePluginBundle(bundle, origin());

    expect(normalized.ok).toBe(true);
    expect(normalized.compatibility?.deferred).toEqual([{
      externalKind: 'bin',
      reasonCode: 'plugin.deferred.claude_bin_unreachable',
      sourcePath: 'bin',
    }]);
    // The consequence, which is the whole point: the install can no longer
    // claim the bundle is fully supported.
    expect(normalized.compatibility?.state).toBe('partial');
    // The diagnostic stays: `toSafeDeferredCapabilities` strips `sourcePath`
    // and carries no command list, so the names live only here.
    expect(normalized.diagnostics
      ?.find(diagnostic => diagnostic.code === 'plugin.format.claude_bin_path_unsupported')
      ?.message).toContain('lonely');
  });

  it('leaves a bundle that carries a runtime root out of the deferred list', async () => {
    // The boundary the record must not cross. This bundle declares a skill, so
    // a capability carries its `pluginRuntime.rootPath`, `appendPluginBinPath`
    // puts `bin/` on PATH, and `unreferenced` resolves as a bare command even
    // though nothing in the bundle names it. Deferring it would set `partial`,
    // and a partial bundle loses every managed activation record on its next
    // repair — the cost the C6 fix removed and this must not reintroduce.
    const bundle = claudeBundle('bin-rooted');
    writeExecutable(bundle, 'bin', 'unreferenced');

    const normalized = await normalizePluginBundle(bundle, origin());

    expect(normalized.ok).toBe(true);
    expect(deferredKinds(normalized.compatibility)).toEqual([]);
    expect(normalized.compatibility?.state).toBe('supported');
    // Positive control that the empty list is a covered surface and not a read
    // that never happened: the skill did import, so the root exists.
    expect(normalized.value?.capabilities.map(capability => capability.kind)).toEqual(['skill']);
  });

  // P2.162. The gate used to be `capabilities.length > 0`, which is not the
  // question: what puts `bin/` on PATH is a capability whose RUNTIME
  // REGISTRATION carries `pluginRuntime.rootPath`, and three kinds the adapter
  // imports carry none. Each row below is its own combination, because the
  // reason this exists is that one combination was tested and the others were
  // not.
  for (const kind of ROOT_BEARING_KINDS) {
    it(`leaves a ${kind}-only bundle's bin/ reachable`, async () => {
      const bundle = bundleDeclaringOnly(`bin-only-${kind}`, kind);
      writeExecutable(bundle, 'bin', 'unreferenced');

      const normalized = await normalizePluginBundle(bundle, origin());

      // Positive control FIRST: the fixture really declares that kind, so an
      // empty `deferred` is a carried root and not a bundle that imported
      // nothing.
      expect(normalized.value?.capabilities.map(capability => capability.kind)).toEqual([kind]);
      expect(deferredKinds(normalized.compatibility)).toEqual([]);
      expect(normalized.compatibility?.state).toBe('supported');
      expect(normalized.diagnostics
        ?.some(diagnostic => diagnostic.code === 'plugin.format.claude_bin_path_unsupported')).toBe(false);
    });
  }

  for (const kind of ROOTLESS_KINDS) {
    it(`reports a ${kind}-only bundle's bin/ as unreachable`, async () => {
      // `agent` reaches `view.agents`, which `enabledPluginBundleRoots` does not
      // read and whose `RuntimeAgentDefinition` has no `pluginRuntime` field
      // anyway; `workflow` carries `pluginRuntime` on its binding and lands in
      // no view array at all. Either way the bundle contributes no root, so its
      // `bin/` is a lost component and rides the durable channel.
      const bundle = bundleDeclaringOnly(`bin-rootless-${kind}`, kind);
      writeExecutable(bundle, 'bin', 'lonely');

      const normalized = await normalizePluginBundle(bundle, origin());

      expect(normalized.value?.capabilities.map(capability => capability.kind)).toEqual([kind]);
      expect(normalized.compatibility?.deferred).toEqual([{
        externalKind: 'bin',
        reasonCode: 'plugin.deferred.claude_bin_unreachable',
        sourcePath: 'bin',
      }]);
      expect(normalized.compatibility?.state).toBe('partial');
      // The warning names the file AND why, because the advice differs from the
      // zero-capability case: this bundle has capabilities and needs a
      // DIFFERENT kind, so "add any capability" would be wrong.
      const warning = normalized.diagnostics
        ?.find(diagnostic => diagnostic.code === 'plugin.format.claude_bin_path_unsupported');
      expect(warning?.severity).toBe('warning');
      expect(warning?.message).toContain('lonely');
      expect(warning?.message).toContain(`declares only ${kind} capabilities`);
    });
  }

  it('keeps a bin/ reachable when a rootless kind ships ALONGSIDE a root-bearing one', async () => {
    // The boundary of the widened gate: the presence of an agent must not defer
    // a bundle whose skill already carries the root. A gate that fired on "any
    // rootless kind" instead of "no root-bearing kind" would make every real
    // Claude bundle `partial`, and a partial bundle loses every managed
    // activation record on its next repair.
    const bundle = bundleDeclaringOnly('bin-agent-plus-skill', 'agent');
    mkdirSync(join(bundle, 'skills', 'demo'), { recursive: true });
    writeFileSync(
      join(bundle, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: A demo skill\n---\nBody.\n',
    );
    writeExecutable(bundle, 'bin', 'unreferenced');

    const normalized = await normalizePluginBundle(bundle, origin());

    expect(normalized.value?.capabilities.map(capability => capability.kind).sort())
      .toEqual(['agent', 'skill']);
    expect(deferredKinds(normalized.compatibility)).toEqual([]);
    expect(normalized.compatibility?.state).toBe('supported');
  });

  it('reports one unreachable bin/ for a bundle whose kinds are ALL rootless', async () => {
    // Both shapes people ship, in one bundle: the record must be ONE `bin`
    // entry naming both declared kinds, not one per capability.
    const bundle = bundleDeclaringOnly('bin-agent-plus-workflow', 'agent');
    mkdirSync(join(bundle, 'workflows'), { recursive: true });
    writeFileSync(join(bundle, 'workflows', 'scan.js'), [
      "export const meta = { name: 'scan', description: 'Scan the tree' }",
      "return agent({ agent: 'scout', task: args.input });",
    ].join('\n'));
    writeExecutable(bundle, 'bin', 'lonely');

    const normalized = await normalizePluginBundle(bundle, origin());

    expect(normalized.value?.capabilities.map(capability => capability.kind).sort())
      .toEqual(['agent', 'workflow']);
    expect(deferredKinds(normalized.compatibility)).toEqual(['bin']);
    expect(normalized.diagnostics
      ?.find(diagnostic => diagnostic.code === 'plugin.format.claude_bin_path_unsupported')
      ?.message).toContain('declares only agent, workflow capabilities');
  });
});
