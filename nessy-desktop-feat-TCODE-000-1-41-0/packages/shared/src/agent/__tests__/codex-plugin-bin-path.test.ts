/**
 * P6.415 — an enabled plugin's `bin/` reaches the codex shell's PATH.
 *
 * `plugins-reference.md` § File locations, `bin/`, verbatim: *"Executables added
 * to the Bash tool PATH. Files here are invokable as bare commands in any Bash
 * tool call while the plugin is enabled."* Pi and claude both build that PATH
 * (`enabledPluginBundleRoots` + `appendPluginBinPath`, `data-paths.ts`);
 * `CodexAgent.resolveSelectedPluginSkillRuntimePolicy` — the SAME-NAMED method —
 * called neither, so the grant landed on two runtimes out of three and nothing
 * said so. Measured before the fix: `appendPluginBinPath` scored 3 hits in
 * `claude-agent.ts`, 2 in `pi-agent.ts` and **0** in `codex-agent.ts`;
 * `enabledPluginBundleRoots` 2 / 2 / **0**.
 *
 * ## What each case kills
 *
 * - the pinned-skill arm and the NO-skill arm are separate cases because the
 *   method has two exits and the bug was in both: the early return was `{}` and
 *   the tail built the shim PATH without the bundles. A test through one exit
 *   passes over a fix to the other.
 * - the no-`bin/` case is the POSITIVE CONTROL: without it, "PATH gains the
 *   directory" is equally satisfied by appending a path that does not exist,
 *   which is the thing `pluginBinDirectories`' `existsSync` is there to prevent
 *   and which would put a phantom entry on every session's PATH.
 * - the ORDER case is the safety property, not a formatting detail: appended and
 *   never prepended, so a bundle shipping a file called `git` or `sh` cannot
 *   shadow the system binary of that name.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BackendConfig } from '../backend/types.ts';
import { CodexAgent } from '../codex-agent.ts';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A bundle root on disk, with a real `bin/` unless `withBin` says otherwise. */
function bundle(withBin: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-p6415-'));
  roots.push(root);
  if (withBin) {
    mkdirSync(join(root, 'bin'), { recursive: true });
    const executable = join(root, 'bin', 'demo-cli');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
  }
  return root;
}

function createConfig(): BackendConfig {
  return {
    provider: 'codex-runtime',
    workspace: {
      id: 'ws-p6415',
      name: 'Plugin Bin Workspace',
      rootPath: '/tmp/nessy-p6415-ws',
      workspaceRootPath: '/tmp/nessy-p6415-ws',
      sessionRootPath: '/tmp/nessy-p6415-sessions/ws-p6415',
    } as any,
    session: {
      id: 'session-p6415',
      workspaceRootPath: '/tmp/nessy-p6415-ws',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: '/tmp/nessy-p6415-project',
    } as any,
    model: 'codex/test-model',
    isHeadless: true,
  };
}

/**
 * A session whose runnable capability view carries `bundleRoots`.
 *
 * The view is the ENABLEMENT boundary (`toAgentRuntime` admits an entry only
 * when it is enabled, trusted and supported), which is why the policy reads it
 * rather than the selected skills — the page's condition is enablement.
 * `skills` is one of the eight groups `enabledPluginBundleRoots` walks; any
 * would do.
 */
function policyFor(bundleRoots: readonly string[], options: { pinSkillRuntime?: string } = {}) {
  const agent = new CodexAgent(createConfig());
  (agent as any).capabilityTurnRuntime = {
    view: { skills: bundleRoots.map(rootPath => ({ pluginRuntime: { rootPath } })) },
  };
  if (options.pinSkillRuntime !== undefined) {
    const root = options.pinSkillRuntime;
    (agent as any).activePluginSkillRuntimes = [{
      runtime: {
        profile: 'generic-plugin-env-v1',
        rootPath: root,
        dataPath: join(root, 'data'),
      },
    }];
    (agent as any).config.pluginNodeRuntime = {
      command: '/opt/nessy/bun',
      nodeShimDirectory: '/opt/nessy/shim',
      environment: {},
    };
  }
  return (agent as any).resolveSelectedPluginSkillRuntimePolicy() as {
    environment: Record<string, string>;
    writablePaths: string[];
  };
}

describe('P6.415 — an enabled plugin bin/ on the codex shell PATH', () => {
  it('adds it on a turn that pins NO skill runtime — the early-return exit', () => {
    const root = bundle(true);

    const { environment } = policyFor([root]);

    expect(environment.PATH?.split(delimiter)).toContain(join(root, 'bin'));
  });

  it('adds it on a turn that DOES pin one — the shim exit', () => {
    const root = bundle(true);

    const { environment } = policyFor([root], { pinSkillRuntime: root });

    const entries = environment.PATH?.split(delimiter) ?? [];
    expect(entries).toContain(join(root, 'bin'));
    // The host's own runtime redirect is still first on this exit.
    expect(entries[0]).toBe('/opt/nessy/shim');
  });

  it('APPENDS it, so a plugin cannot shadow a system binary of the same name', () => {
    const root = bundle(true);

    const entries = policyFor([root]).environment.PATH?.split(delimiter) ?? [];

    expect(entries[entries.length - 1]).toBe(join(root, 'bin'));
    // …and the host PATH the child would have had is untouched in front of it.
    for (const entry of (process.env.PATH ?? '').split(delimiter)) {
      if (entry.length > 0) expect(entries).toContain(entry);
    }
  });

  it('leaves a bundle with NO bin/ byte-identical — the POSITIVE CONTROL', () => {
    // `pluginBinDirectories` checks the directory EXISTS. Without this case the
    // assertions above are equally satisfied by appending a phantom path to
    // every session's PATH.
    //
    // C4.11 · the map is no longer EMPTY on this exit — the effort pair rides it
    // now (`codex-shell-effort-env.test.ts` owns that claim) — so the control is
    // stated as "no PATH", which is what this case was always measuring.
    expect(policyFor([bundle(false)]).environment).not.toHaveProperty('PATH');
  });

  it('contributes nothing when no plugin is enabled at all', () => {
    expect(policyFor([]).environment).not.toHaveProperty('PATH');
  });
});
