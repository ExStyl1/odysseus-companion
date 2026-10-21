import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadProjectNessyAgentConfig,
  parseProjectNessyAgentConfigToml,
} from '../project-config.ts';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('.nessy-agent project config', () => {
  it('parses plugin toggles and capability overrides from Nessy-owned TOML', () => {
    const parsed = parseProjectNessyAgentConfigToml(`
[plugins]
enabled = ["toolkit"]
disabled = ["disabled-plugin"]

[plugins."plugin://internal/codex-bundle@2.0.0"]
enabled = true
enabled_capabilities = ["review"]
disabled_capabilities = ["dangerous-hook"]
`);

    expect(parsed).toEqual([
      { selector: 'toolkit', pluginId: 'toolkit', enabled: true },
      { selector: 'disabled-plugin', pluginId: 'disabled-plugin', enabled: false },
      {
        selector: 'plugin://internal/codex-bundle@2.0.0',
        pluginInstanceId: 'plugin://internal/codex-bundle@2.0.0',
        enabled: true,
        capabilities: {
          review: true,
          'dangerous-hook': false,
        },
      },
    ]);
  });

  it('loads .nessy-agent/config.toml and .nessy-agent/hooks.json without consulting project .codex', () => {
    const projectRoot = makeTempProject();
    mkdirSync(join(projectRoot, '.nessy-agent'), { recursive: true });
    mkdirSync(join(projectRoot, '.codex'), { recursive: true });
    writeFileSync(join(projectRoot, '.nessy-agent', 'config.toml'), `
[plugins]
enabled = ["toolkit"]

[plugins.toolkit]
disabled_capabilities = ["pretool"]
`);
    writeFileSync(join(projectRoot, '.nessy-agent', 'hooks.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            name: 'project prompt hook',
            actions: [{ type: 'command', command: 'node hook.js', cwd: 'hooks' }],
          },
        ],
      },
    }));
    writeFileSync(join(projectRoot, '.codex', 'config.toml'), `
[plugins]
disabled = ["toolkit"]
`);

    // Fail-closed: an untrusted/unknown repository contributes no overlay.
    expect(loadProjectNessyAgentConfig(projectRoot)).toBeUndefined();

    const config = loadProjectNessyAgentConfig(projectRoot, { projectTrusted: true });

    expect(config?.plugins.map(plugin => plugin.selector)).toEqual(['toolkit', 'toolkit']);
    expect(config?.hooks.automations.UserPromptSubmit?.[0]?.actions[0]).toEqual({
      type: 'command',
      command: 'node hook.js',
      cwd: 'hooks',
    });
    expect(config?.sources).toEqual([
      join(projectRoot, '.nessy-agent', 'config.toml'),
      join(projectRoot, '.nessy-agent', 'hooks.json'),
    ]);
    expect(config?.diagnostics).toEqual([]);
  });

  it('parses the typed [defaults] allowlist as project config values', () => {
    const projectRoot = makeTempProject();
    mkdirSync(join(projectRoot, '.nessy-agent'), { recursive: true });
    writeFileSync(join(projectRoot, '.nessy-agent', 'config.toml'), `
[defaults]
model = "tgpt/qwen35-397b-a17b-fp8"
thinking_level = "high"
permission_mode = "ask"
`);

    const config = loadProjectNessyAgentConfig(projectRoot, { projectTrusted: true });

    expect(config?.defaults).toEqual({
      model: 'tgpt/qwen35-397b-a17b-fp8',
      thinkingLevel: 'high',
      permissionMode: 'ask',
    });
    expect(config?.diagnostics).toEqual([]);
  });

  it('diagnoses forbidden and unknown keys without applying them', () => {
    const projectRoot = makeTempProject();
    mkdirSync(join(projectRoot, '.nessy-agent'), { recursive: true });
    writeFileSync(join(projectRoot, '.nessy-agent', 'config.toml'), `
[defaults]
model = "safe-model"
api_key = "sk-forbidden"
mystery = "who knows"

[env]
PATH = "/evil"

[trust]
trusted = true
`);

    const config = loadProjectNessyAgentConfig(projectRoot, { projectTrusted: true });

    expect(config?.defaults).toEqual({ model: 'safe-model' });
    const codes = config?.diagnostics.map(d => `${d.severity}:${d.code}`) ?? [];
    expect(codes).toContain('error:plugin.project_config.forbidden_key');
    expect(codes.filter(c => c === 'error:plugin.project_config.forbidden_section')).toHaveLength(2);
    expect(codes).toContain('warning:plugin.project_config.unknown_keys');
    expect(JSON.stringify(config?.defaults)).not.toContain('sk-forbidden');
  });

  it('never reads a populated legacy .nessy directory, even when trusted', () => {
    const projectRoot = makeTempProject();
    mkdirSync(join(projectRoot, '.nessy'), { recursive: true });
    writeFileSync(join(projectRoot, '.nessy', 'config.toml'), '[plugins]\nenabled = ["must-never-load"]\n');
    writeFileSync(join(projectRoot, '.nessy', 'hooks.json'), JSON.stringify({
      hooks: { UserPromptSubmit: [{ name: 'never', actions: [{ type: 'command', command: 'x' }] }] },
    }));

    const config = loadProjectNessyAgentConfig(projectRoot, { projectTrusted: true });

    expect(config?.plugins).toEqual([]);
    expect(config?.hooks).toEqual({ automations: {} });
    expect(config?.sources).toEqual([]);
    expect(config?.diagnostics).toEqual([]);
  });

  // "applies project scope overlays in memory without rewriting installed
  // registry entries" retired with `applyProjectNessyAgentConfigToRegistry`
  // (F4), whose only production caller was the deleted V1 projection. What this
  // file still pins is the parse and the trust gate; where the parsed toggles
  // reach activation is `capabilities/policy-store.ts`'s ground.
});

function makeTempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'nessy-project-config-'));
  tempRoots.push(root);
  return root;
}
