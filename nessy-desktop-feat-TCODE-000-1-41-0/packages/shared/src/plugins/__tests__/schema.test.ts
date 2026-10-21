import { describe, expect, it } from 'bun:test';
import { createPluginCapabilityId, normalizeNessyPluginManifest, validatePluginId, validatePluginRuntimeCompatibility } from '../schema.ts';

describe('plugin schema guards', () => {
  it('normalizes a Nessy plugin manifest with non-projecting capabilities', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'toolkit',
      name: 'Toolkit',
      version: '1.2.3',
      capabilities: [
        { kind: 'skill', id: 'review', skill: { slug: 'review', path: 'skills/review/SKILL.md' } },
        { kind: 'mcp', id: 'linear', mcp: { serverName: 'linear', transport: 'http', url: 'https://mcp.example.com' } },
        { kind: 'hook', id: 'pretool', hook: { event: 'PreToolUse', type: 'command', command: 'node hooks/pretool.js' } },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.value?.kind).toBe('plugin');
    expect(result.value?.capabilities.map(capability => capability.kind)).toEqual(['skill', 'mcp', 'hook']);
  });

  it('keeps extension vocabulary outside native manifests unless an adapter explicitly allows it', () => {
    const raw = {
      kind: 'nessy-extension',
      id: 'legacy',
      name: 'Legacy',
      version: '0.1.0',
      capabilities: [],
    };

    expect(normalizeNessyPluginManifest(raw).ok).toBe(false);

    const adapted = normalizeNessyPluginManifest(raw, { allowLegacyExtensionKind: true });
    expect(adapted.ok).toBe(true);
    expect(adapted.value?.kind).toBe('plugin');
    expect(adapted.diagnostics.some(diagnostic => diagnostic.code === 'plugin.manifest.legacy_extension_kind')).toBe(true);
  });

  it('rejects plugin capability paths that would escape the bundle', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'bad-path',
      name: 'Bad Path',
      version: '1.0.0',
      capabilities: [
        { kind: 'skill', id: 'escape', skill: { slug: 'escape', path: '../outside/SKILL.md' } },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.skill.invalid_path');
  });

  it("round-trips a skill's author-declared allowed-tools and activation paths", () => {
    // The shape `applyPluginSkillFrontmatter` emits after reading SKILL.md
    // (`format-adapters.ts:601`-`:619`). Normalization runs a SECOND time on
    // install (`management-service-v2.ts:857`), so a field this branch does not
    // copy is stripped from the stored record even though the adapter decoded
    // it — the G6 live gate's finding (2026-08-11), invisible to every test
    // that hand-builds the normalized capability.
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'toolkit',
      name: 'Toolkit',
      version: '1.0.0',
      capabilities: [
        {
          kind: 'skill',
          id: 'tracker-skill',
          skill: {
            slug: 'tracker-skill',
            path: 'skills/tracker-skill/SKILL.md',
            allowedTools: ['mcp__t-tracker__*', 'Read'],
            paths: ['src/**/*.ts'],
          },
        },
        {
          // The hyphenated spelling a manifest author may write directly, the
          // same pair the sibling booleans above already accept.
          kind: 'skill',
          id: 'hyphen-skill',
          skill: { slug: 'hyphen-skill', path: 'skills/hyphen-skill/SKILL.md', 'allowed-tools': ['Read'] },
        },
        // Declares neither: absent must stay ABSENT, never an `undefined`-valued
        // key — `PluginSkillDescriptor` is exact-optional, and "not stated" is
        // what lets the frontmatter pass fill it later.
        { kind: 'skill', id: 'bare-skill', skill: { slug: 'bare-skill', path: 'skills/bare-skill/SKILL.md' } },
      ],
    });

    expect(result.ok).toBe(true);
    const [tracker, hyphen, bare] = result.value?.capabilities ?? [];
    expect(tracker?.kind === 'skill' ? tracker.skill.allowedTools : undefined).toEqual(['mcp__t-tracker__*', 'Read']);
    expect(tracker?.kind === 'skill' ? tracker.skill.paths : undefined).toEqual(['src/**/*.ts']);
    expect(hyphen?.kind === 'skill' ? hyphen.skill.allowedTools : undefined).toEqual(['Read']);
    expect(bare?.kind === 'skill' ? Object.keys(bare.skill) : []).toEqual(['slug', 'path']);
  });

  it('rejects MCP capabilities without transport-specific required fields', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'bad-mcp',
      name: 'Bad MCP',
      version: '1.0.0',
      capabilities: [
        { kind: 'mcp', id: 'stdio-missing-command', mcp: { serverName: 'stdio', transport: 'stdio' } },
        { kind: 'mcp', id: 'http-missing-url', mcp: { serverName: 'http', transport: 'http' } },
        { kind: 'mcp', id: 'sse-invalid-url', mcp: { serverName: 'sse', transport: 'sse', url: 'not-a-url' } },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(expect.arrayContaining([
      'plugin.mcp.missing_command',
      'plugin.mcp.missing_url',
      'plugin.mcp.invalid_url',
    ]));
  });

  it('retains stdio cwd, environment defaults, and name-only requirements', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'configured-mcp',
      name: 'Configured MCP',
      version: '1.0.0',
      capabilities: [{
        kind: 'mcp',
        id: 'server',
        mcp: {
          serverName: 'server',
          transport: 'stdio',
          command: 'node',
          args: ['${NESSY_PLUGIN_ROOT}/server.js'],
          cwd: '${NESSY_PLUGIN_ROOT}',
          env: { STATIC_MODE: 'safe' },
          environmentDefaults: { ENDPOINT: 'https://example.test' },
          requiredEnvironmentNames: ['TOKEN', 'FOLDERS'],
        },
      }],
    });

    expect(result.ok).toBe(true);
    const capability = result.value?.capabilities[0];
    expect(capability?.kind === 'mcp' ? capability.mcp : undefined).toEqual({
      serverName: 'server',
      transport: 'stdio',
      command: 'node',
      args: ['${NESSY_PLUGIN_ROOT}/server.js'],
      cwd: '${NESSY_PLUGIN_ROOT}',
      env: { STATIC_MODE: 'safe' },
      environmentDefaults: { ENDPOINT: 'https://example.test' },
      requiredEnvironmentNames: ['TOKEN', 'FOLDERS'],
    });
  });

  it('rejects MCP cwd traversal and non-bundle runtime variables', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'invalid-mcp-cwd',
      name: 'Invalid MCP cwd',
      version: '1.0.0',
      capabilities: [
        { kind: 'mcp', id: 'traversal', mcp: { serverName: 'traversal', transport: 'stdio', command: 'node', cwd: '../outside' } },
        { kind: 'mcp', id: 'host-env', mcp: { serverName: 'host-env', transport: 'stdio', command: 'node', cwd: '${HOME}' } },
        { kind: 'mcp', id: 'root-traversal', mcp: { serverName: 'root-traversal', transport: 'stdio', command: 'node', cwd: '${NESSY_PLUGIN_ROOT}/../outside' } },
        { kind: 'mcp', id: 'windows-absolute', mcp: { serverName: 'windows-absolute', transport: 'stdio', command: 'node', cwd: 'C:/outside' } },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.filter(diagnostic => diagnostic.code === 'plugin.mcp.invalid_cwd')).toHaveLength(4);
  });

  it('rejects malformed executable hooks (missing required runtime fields)', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'bad-hooks',
      name: 'Bad Hooks',
      version: '1.0.0',
      capabilities: [
        { kind: 'hook', id: 'command-missing-command', hook: { event: 'PreToolUse', type: 'command' } },
        { kind: 'hook', id: 'bad-cwd', hook: { event: 'PreToolUse', type: 'command', command: 'node hook.js', cwd: '../outside' } },
        { kind: 'hook', id: 'http-missing-url', hook: { event: 'Stop', type: 'http' } },
        { kind: 'hook', id: 'mcp-missing-tool', hook: { event: 'PostToolUse', type: 'mcp' } },
        { kind: 'hook', id: 'prompt-missing-body', hook: { event: 'UserPromptSubmit', type: 'prompt' } },
        { kind: 'hook', id: 'agent-missing-name', hook: { event: 'SubagentStart', type: 'agent' } },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(expect.arrayContaining([
      'plugin.hook.missing_command',
      'plugin.hook.invalid_cwd',
      'plugin.hook.missing_http_url',
      'plugin.hook.missing_mcp_tool',
      'plugin.hook.missing_prompt',
      'plugin.hook.missing_agent',
    ]));
  });

  it('normalizes prompt and agent hooks into executable capabilities carrying their runtime data (B1)', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'runtime-hooks',
      name: 'Runtime Hooks',
      version: '1.0.0',
      capabilities: [
        { kind: 'hook', id: 'brief', hook: { event: 'UserPromptSubmit', type: 'prompt', prompt: 'Follow the style guide.' } },
        { kind: 'hook', id: 'review', hook: { event: 'SubagentStart', type: 'agent', agentName: 'hive-reviewer' } },
      ],
    });

    expect(result.ok).toBe(true);
    const hooks = (result.value?.capabilities ?? []).filter((c): c is Extract<typeof c, { kind: 'hook' }> => c.kind === 'hook');
    expect(hooks[0]?.hook).toMatchObject({ type: 'prompt', prompt: 'Follow the style guide.' });
    expect(hooks[1]?.hook).toMatchObject({ type: 'agent', agentName: 'hive-reviewer' });
  });

  it('normalizes mcp and http hooks into executable capabilities carrying their runtime data (B2)', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'net-hooks',
      name: 'Net Hooks',
      version: '1.0.0',
      capabilities: [
        { kind: 'hook', id: 'lint', hook: { event: 'PostToolUse', type: 'mcp', mcpTool: 'mcp__linter__lint_file', mcpArgs: { strict: true } } },
        { kind: 'hook', id: 'notify', hook: { event: 'Stop', type: 'http', http: { url: 'https://example.invalid/webhook', method: 'post', body: { ok: true } } } },
      ],
    });

    expect(result.ok).toBe(true);
    const hooks = (result.value?.capabilities ?? []).filter((c): c is Extract<typeof c, { kind: 'hook' }> => c.kind === 'hook');
    expect(hooks[0]?.hook).toMatchObject({ type: 'mcp', mcpTool: 'mcp__linter__lint_file', mcpArgs: { strict: true } });
    expect(hooks[1]?.hook).toMatchObject({ type: 'http', http: { url: 'https://example.invalid/webhook', method: 'POST', body: { ok: true } } });
  });

  it('normalizes an lsp capability carrying its server launch command (B3)', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'lsp-plugin',
      name: 'LSP Plugin',
      version: '1.0.0',
      capabilities: [
        { kind: 'lsp', id: 'ts', lsp: { id: 'ts', command: 'typescript-language-server', args: ['--stdio'], languages: ['typescript'] } },
      ],
    });
    expect(result.ok).toBe(true);
    const lsp = (result.value?.capabilities ?? []).find((c): c is Extract<typeof c, { kind: 'lsp' }> => c.kind === 'lsp');
    expect(lsp?.lsp).toMatchObject({ id: 'ts', command: 'typescript-language-server', args: ['--stdio'], languages: ['typescript'] });
  });

  it('rejects an lsp capability with no command (B3)', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'bad-lsp',
      name: 'Bad LSP',
      version: '1.0.0',
      capabilities: [{ kind: 'lsp', id: 'ts', lsp: { id: 'ts' } }],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(d => d.code)).toContain('plugin.lsp.missing_command');
  });

  // --- B5: settings/userConfig forbidden-key triage --------------------------

  it('normalizes a safe plugin setting default (B5)', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'settings-ok',
      name: 'Settings OK',
      version: '1.0.0',
      capabilities: [
        { kind: 'setting', id: 'verbosity', setting: { key: 'verbosity', valueType: 'string', defaultValue: 'normal' } },
      ],
    });
    expect(result.ok).toBe(true);
    const setting = (result.value?.capabilities ?? []).find((c): c is Extract<typeof c, { kind: 'setting' }> => c.kind === 'setting');
    expect(setting?.setting).toMatchObject({ key: 'verbosity', valueType: 'string', defaultValue: 'normal' });
  });

  it('rejects a plugin setting that would grant trust/credentials/env/roots under forbidden-key diagnostics (B5)', () => {
    for (const key of [
      'api_key', 'auth_token', 'trusted', 'base_url', 'roots', 'ANTHROPIC_API_KEY',
      // camelCase vectors must not escape the guard (regression for the
      // toLowerCase-before-split bug).
      'authToken', 'secretKey', 'endpointUrl', 'providerUrl', 'tokenSecret', 'apiKey', 'storageDir',
    ]) {
      const result = normalizeNessyPluginManifest({
        kind: 'plugin',
        id: 'settings-bad',
        name: 'Settings Bad',
        version: '1.0.0',
        capabilities: [{ kind: 'setting', id: 's', setting: { key, valueType: 'string' } }],
      });
      expect(result.ok, `key "${key}" must be rejected`).toBe(false);
      expect(result.diagnostics.map(d => d.code)).toContain('plugin.setting.forbidden_key');
    }
  });

  it('rejects a non-primitive setting valueType (B5)', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'secret-ref',
      name: 'Secret Ref',
      version: '1.0.0',
      capabilities: [{ kind: 'setting', id: 'creds', setting: { key: 'creds', valueType: 'secret-ref' } }],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(d => d.code)).toContain('plugin.setting.invalid_value_type');
  });

  it('accepts a trusted explicit five-field monitor and rejects malformed schedules', () => {
    const valid = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'monitor',
      name: 'Monitor',
      version: '1.0.0',
      capabilities: [{
        kind: 'monitor', id: 'hourly',
        monitor: { id: 'hourly', path: 'monitors/hourly.md', cron: '0 * * * *', timezone: 'UTC' },
      }],
    });
    expect(valid.ok).toBe(true);
    expect(valid.value?.capabilities[0]).toMatchObject({ kind: 'monitor', monitor: { cron: '0 * * * *', timezone: 'UTC' } });

    const invalid = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'bad-monitor',
      name: 'Bad monitor',
      version: '1.0.0',
      capabilities: [{
        kind: 'monitor', id: 'bad',
        monitor: { id: 'bad', path: 'monitors/bad.md', cron: '* * *', timezone: 'Mars/Olympus' },
      }],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.diagnostics.map(d => d.code)).toEqual(expect.arrayContaining([
      'plugin.monitor.invalid_cron', 'plugin.monitor.invalid_timezone',
    ]));
  });

  it('drops a forbidden-key nessyExtensions setting instead of activating it (B5)', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'ext-settings',
      name: 'Ext Settings',
      version: '1.0.0',
      capabilities: [],
      nessyExtensions: {
        settings: [
          { key: 'verbosity', valueType: 'string', defaultValue: 'ok' },
          { key: 'auth_token', valueType: 'string' },
        ],
      },
    });
    expect(result.ok).toBe(true);
    const settingKeys = (result.value?.nessyExtensions?.settings ?? []).map(s => s.key);
    expect(settingKeys).toContain('verbosity');
    expect(settingKeys).not.toContain('auth_token');
    expect(result.diagnostics.map(d => d.code)).toContain('plugin.setting.forbidden_key');
  });

  it('rejects an mcp hook whose tool name is not the qualified proxy form (B2)', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'bad-mcp',
      name: 'Bad Mcp',
      version: '1.0.0',
      capabilities: [
        { kind: 'hook', id: 'lint', hook: { event: 'PostToolUse', type: 'mcp', mcpTool: 'lint_file' } },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(d => d.code)).toContain('plugin.hook.invalid_mcp_tool');
  });

  it('normalizes agent, prompt-command and unsupported capabilities into their own typed shapes', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'lossless',
      name: 'Lossless',
      version: '1.0.0',
      capabilities: [
        { kind: 'agent', id: 'reviewer', agent: { name: 'reviewer', path: 'agents/reviewer.md', model: 'sonnet', tools: ['Read', 'Grep'] } },
        { kind: 'prompt-command', id: 'summarize', promptCommand: { name: 'summarize', path: 'commands/summarize.md', argumentHint: '<topic>' } },
        {
          kind: 'unsupported',
          id: 'output-style',
          unsupported: { externalKind: 'output-style', sourcePath: 'output-styles/sample.md', reasonCode: 'plugin.compat.output_style_unsupported', executable: false },
        },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.value?.capabilities.map(capability => capability.kind)).toEqual(['agent', 'prompt-command', 'unsupported']);

    const agent = result.value?.capabilities[0];
    expect(agent?.kind === 'agent' && agent.agent).toEqual({ name: 'reviewer', path: 'agents/reviewer.md', model: 'sonnet', tools: ['Read', 'Grep'] });

    const promptCommand = result.value?.capabilities[1];
    expect(promptCommand?.kind === 'prompt-command' && promptCommand.promptCommand).toEqual({ name: 'summarize', path: 'commands/summarize.md', argumentHint: '<topic>' });

    // Preserve safe provider metadata for `unsupported` — never drop it.
    const unsupported = result.value?.capabilities[2];
    expect(unsupported?.kind === 'unsupported' && unsupported.unsupported).toEqual({
      externalKind: 'output-style',
      sourcePath: 'output-styles/sample.md',
      reasonCode: 'plugin.compat.output_style_unsupported',
      executable: false,
    });
  });

  it('rejects agent/prompt-command capabilities with a bundle-escaping path', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'bad-agent-path',
      name: 'Bad Agent Path',
      version: '1.0.0',
      capabilities: [
        { kind: 'agent', id: 'escape-agent', agent: { name: 'escape-agent', path: '../outside/agent.md' } },
        { kind: 'prompt-command', id: 'escape-command', promptCommand: { name: 'escape-command', path: '../outside/command.md' } },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toEqual(expect.arrayContaining([
      'plugin.agent.invalid_path',
      'plugin.prompt_command.invalid_path',
    ]));
  });
});

describe('createPluginCapabilityId', () => {
  it('produces distinct ids for the same providerLocalId across different kinds, and a stable id for the same kind+id', () => {
    const skillId = createPluginCapabilityId('skill', 'review');
    const mcpId = createPluginCapabilityId('mcp', 'review');
    expect(skillId).not.toBe(mcpId);
    expect(createPluginCapabilityId('skill', 'review')).toBe(skillId);
  });

  it('produces an id that round-trips through validatePluginId (the collision-safe id must itself be a legal capability id)', () => {
    // A2's helper originally joined kind/providerLocalId with ':' (e.g.
    // "skill:review"), which validatePluginId rejects (':' is outside the
    // allowed [A-Za-z0-9._-] charset) — every capability built through it
    // failed as plugin.capability.invalid_id. The collision-safe id must
    // also be a legal id.
    expect(validatePluginId(createPluginCapabilityId('skill', 'x'))).toBeNull();
  });
});

describe('validatePluginId — P2.468, the refusal names the divergence from upstream', () => {
  // The decided posture (owner-delegated controller decision 2026-09-02 §F3):
  // keep the stricter rule, and make an author who validated clean upstream
  // learn WHY we refuse instead of reading a charset error as our defect.
  it('names upstream, the warning it gives, and our reason, for a leading-hyphen id', () => {
    const error = validatePluginId('-my-plugin');
    expect(error).not.toBeNull();
    expect(error).toContain('Claude Code');
    expect(error).toContain('kebab-case warning');
    expect(error).toContain('filesystem path');
    expect(error).toContain('store key');
  });

  it('names the divergence for every misplaced-first-character id, not only the hyphen', () => {
    // `.` and `_` are inside our charset too, so they land in the same band:
    // legal characters, illegal first position.
    for (const id of ['-my-plugin', '.hidden-plugin', '_leading-underscore']) {
      expect(validatePluginId(id)).toContain('Claude Code');
    }
  });

  it('does NOT claim a divergence for a character we reject anywhere', () => {
    // Negative control on the same rig: `$` is outside the charset, so upstream
    // is not accepting it either and there is no divergence to name. A message
    // that claimed one here would be a false statement about their binary.
    const error = validatePluginId('my$plugin');
    expect(error).toBe('Plugin id may only contain letters, numbers, dot, underscore, and dash');
  });

  it('still refuses — the message changed, the rule did not', () => {
    expect(validatePluginId('-my-plugin')).not.toBeNull();
    expect(validatePluginId('my-plugin')).toBeNull();
  });
});

describe('validatePluginRuntimeCompatibility', () => {
  it('round-trips a validated runtime profile through manifest normalization', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'codex-compatible',
      name: 'Codex Compatible',
      version: '1.0.0',
      capabilities: [],
      runtimeCompatibility: { profiles: ['codex-plugin-env-v1'] },
    });

    expect(result.ok).toBe(true);
    expect(result.value?.runtimeCompatibility).toEqual({ profiles: ['codex-plugin-env-v1'] });
  });

  it('rejects an invalid runtime profile during manifest normalization', () => {
    const result = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'invalid-compatible',
      name: 'Invalid Compatible',
      version: '1.0.0',
      capabilities: [],
      runtimeCompatibility: { profiles: ['made-up-profile'] },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.runtime_compatibility.unknown_profile',
    );
  });

  it('accepts one known profile', () => {
    const result = validatePluginRuntimeCompatibility({ profiles: ['codex-plugin-env-v1'] });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ profiles: ['codex-plugin-env-v1'] });
  });

  it('rejects an empty profile declaration directly and during manifest normalization', () => {
    const direct = validatePluginRuntimeCompatibility({ profiles: [] });
    expect(direct.ok).toBe(false);
    expect(direct.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.runtime_compatibility.missing_profile',
    );

    const normalized = normalizeNessyPluginManifest({
      kind: 'plugin',
      id: 'empty-compatible',
      name: 'Empty Compatible',
      version: '1.0.0',
      capabilities: [],
      runtimeCompatibility: { profiles: [] },
    });
    expect(normalized.ok).toBe(false);
    expect(normalized.diagnostics.map(diagnostic => diagnostic.code)).toContain(
      'plugin.runtime_compatibility.missing_profile',
    );
  });

  it('rejects unknown, duplicate, and conflicting profile declarations', () => {
    const unknown = validatePluginRuntimeCompatibility({ profiles: ['generic-plugin-env-v1', 'made-up-profile'] });
    expect(unknown.ok).toBe(false);
    expect(unknown.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.runtime_compatibility.unknown_profile');

    const duplicate = validatePluginRuntimeCompatibility({ profiles: ['claude-plugin-env-v1', 'claude-plugin-env-v1'] });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.runtime_compatibility.duplicate_profile');

    const conflicting = validatePluginRuntimeCompatibility({ profiles: ['generic-plugin-env-v1', 'codex-plugin-env-v1'] });
    expect(conflicting.ok).toBe(false);
    expect(conflicting.diagnostics.map(diagnostic => diagnostic.code)).toContain('plugin.runtime_compatibility.profile_conflict');
  });
});

/**
 * P2.288. The `if` filter's fail-open is deliberate and documented
 * (hooks.md#bash-if-matching — "Because the `if` filter is best-effort, use the
 * permission system rather than a hook to enforce a hard allow or deny"), and
 * P2.277 already made the RUNTIME say when it fires. What was missing is the
 * earlier moment: registration, where the author is present and the hook has not
 * run yet. These pin that the warning exists, names the rule, carries the
 * parser's own remedy — and does NOT refuse the capability, because refusing
 * would make registration a second enforcement point over a filter the runtime
 * deliberately runs.
 */
describe('plugin hook `if` rule — validated at registration, P2.288', () => {
  const manifestWithIfRule = (hook: Record<string, unknown>) => normalizeNessyPluginManifest({
    kind: 'plugin',
    id: 'toolkit',
    name: 'Toolkit',
    version: '1.0.0',
    capabilities: [{ kind: 'hook', id: 'guard', hook: { event: 'PreToolUse', type: 'command', command: 'node guard.js', ...hook } }],
  });
  const ifDiagnostics = (result: ReturnType<typeof manifestWithIfRule>) =>
    result.diagnostics.filter(diagnostic => diagnostic.code === 'plugin.hook.if_unparseable_fail_open');
  const storedIfRule = (result: ReturnType<typeof manifestWithIfRule>) => {
    const capability = result.value?.capabilities[0];
    return capability?.kind === 'hook' ? capability.hook.ifRule : undefined;
  };

  it('says nothing about a rule that parses — the positive control for every absence below', () => {
    const ok = manifestWithIfRule({ ifRule: 'Bash(git *)' });
    expect(ok.ok).toBe(true);
    expect(ifDiagnostics(ok)).toHaveLength(0);
    expect(storedIfRule(ok)).toBe('Bash(git *)');
  });

  it('warns on a rule that will not parse, names it, and still registers the hook', () => {
    const broken = manifestWithIfRule({ ifRule: 'not a rule ((((' });
    // The whole point: the capability is ACCEPTED. A refusal here would stop a
    // hook the runtime deliberately runs.
    expect(broken.ok).toBe(true);
    expect(storedIfRule(broken)).toBe('not a rule ((((');

    const warnings = ifDiagnostics(broken);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.severity).toBe('warning');
    // Named, not merely counted — a plugin may declare many hooks and the
    // diagnostic path points at the capability, not at the condition.
    expect(warnings[0]?.message).toContain('not a rule ((((');
    expect(warnings[0]?.details?.ifRule).toBe('not a rule ((((');
    expect(warnings[0]?.path).toBe('capabilities.0.hook.if');
    // And it says what the consequence is, because "does not parse" alone does
    // not tell the author the hook will now run on everything.
    expect(warnings[0]?.message).toContain('runs on every matching tool call');
  });

  it('carries the parser\'s own remedy for a documented inert form', () => {
    // `Write(...)` is accepted rule syntax that file permission checks never
    // match; the parser answers with the replacement to use. That message is
    // the actionable half, so it must reach the author rather than being
    // flattened into "does not parse".
    const inert = manifestWithIfRule({ ifRule: 'Write(src/**)' });
    expect(inert.ok).toBe(true);
    const warnings = ifDiagnostics(inert);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('Edit(src/**)');
    expect(warnings[0]?.details?.parserCode).toBe('claude_rule.unmatched_form');
  });

  it('reads the imported spelling too — one site, both field names', () => {
    // The Claude and Codex adapters write `if` (hooks.md#common-fields spells it
    // `if`); native manifests write `ifRule`. Both round-trip through this
    // reader, so both must be validated by it or the imported half is silent.
    const imported = manifestWithIfRule({ if: 'Write(src/**)' });
    expect(imported.ok).toBe(true);
    expect(ifDiagnostics(imported)).toHaveLength(1);
    expect(storedIfRule(imported)).toBe('Write(src/**)');
  });

  it('never promotes the warning to an error, on any unparseable form', () => {
    // The guard against the one change that would break the documented
    // fail-open: `normalizePluginCapability` refuses a capability the moment a
    // diagnostic is an error.
    for (const rule of ['not a rule ((((', 'Write(src/**)', '   ', 'Glob(**/*.ts)', '*'.repeat(3000)]) {
      const result = manifestWithIfRule({ ifRule: rule });
      expect(result.ok, `if rule ${JSON.stringify(rule.slice(0, 24))} was refused at registration`).toBe(true);
      expect(result.diagnostics.filter(d => d.code === 'plugin.hook.if_unparseable_fail_open' && d.severity === 'error')).toHaveLength(0);
    }
  });
});
