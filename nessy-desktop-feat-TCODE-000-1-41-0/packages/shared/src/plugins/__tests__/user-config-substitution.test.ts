/**
 * D14 unit half — the substitution rule itself, and the three shell sites
 * `plugins/manifest-reference.md#environment-variables` refuses rather than substitutes.
 *
 * `:579`, whole line:
 *
 * > Fields that run in a shell reject `${user_config.*}`: substituting a
 * > configured value into a shell command would let the shell run whatever that
 * > value contains, so the component fails with an [error](/docs/en/errors#plugin-command-references-user-config) instead. Each rejected field has an alternative way to pass the value:
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  PluginUserConfigValues,
  pluginUserConfigContentValues,
  referencesPluginUserConfig,
  substitutePluginCapabilityUserConfig,
  substitutePluginUserConfigText,
} from '../user-config-substitution.ts';
import { normalizeClaudePluginBundle } from '../format-adapters/claude.ts';
import type { PluginOrigin } from '../types.ts';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginUserConfigurationDescriptor } from '../types.ts';

const FIELDS: PluginUserConfigurationDescriptor[] = [
  { key: 'TOKEN', valueType: 'string', required: true, sensitive: true },
  { key: 'ENDPOINT', valueType: 'string', required: true },
];

const VALUES = new PluginUserConfigValues(FIELDS, {
  CLAUDE_PLUGIN_OPTION_TOKEN: 'TOKEN_CANARY',
  CLAUDE_PLUGIN_OPTION_ENDPOINT: 'https://internal.example.invalid',
});

describe('substitutePluginUserConfigText', () => {
  it('substitutes every reference in one string', () => {
    const { text, report } = substitutePluginUserConfigText(
      '${user_config.ENDPOINT}/v1?token=${user_config.TOKEN}',
      VALUES,
      { allowSensitive: true },
    );
    expect(text).toBe('https://internal.example.invalid/v1?token=TOKEN_CANARY');
    expect(report).toEqual({ unresolved: [], refusedSensitive: [], sensitiveUnredacted: [] });
  });

  it('leaves an unset key LITERAL rather than expanding it to empty', () => {
    // An empty substitution turns `Bearer ${user_config.TOKEN}` into `Bearer `,
    // a syntactically valid request that authenticates as nobody.
    const { text, report } = substitutePluginUserConfigText(
      'Bearer ${user_config.MISSING}',
      VALUES,
      { allowSensitive: true },
    );
    expect(text).toBe('Bearer ${user_config.MISSING}');
    expect(report.unresolved).toEqual(['MISSING']);
  });

  it('refuses a sensitive value at a site that takes non-sensitive values only', () => {
    const { text, report } = substitutePluginUserConfigText(
      'token=${user_config.TOKEN} endpoint=${user_config.ENDPOINT}',
      VALUES,
      { allowSensitive: false },
    );
    expect(text).toBe('token=${user_config.TOKEN} endpoint=https://internal.example.invalid');
    expect(report.refusedSensitive).toEqual(['TOKEN']);
    expect(text).not.toContain('TOKEN_CANARY');
  });

  it('leaves text with no reference untouched, by identity', () => {
    const plain = 'nothing to see here';
    expect(substitutePluginUserConfigText(plain, VALUES, { allowSensitive: true }).text).toBe(plain);
    expect(referencesPluginUserConfig(plain)).toBe(false);
  });

  it('never re-scans a substituted value for further placeholders', () => {
    // A configured value that itself contains the placeholder syntax must not
    // be expanded a second time — one pass, left to right.
    const values = new PluginUserConfigValues(
      [{ key: 'A', valueType: 'string' }, { key: 'B', valueType: 'string' }],
      { CLAUDE_PLUGIN_OPTION_A: '${user_config.B}', CLAUDE_PLUGIN_OPTION_B: 'INNER_CANARY' },
    );
    const { text } = substitutePluginUserConfigText('${user_config.A}', values, { allowSensitive: true });
    expect(text).toBe('${user_config.B}');
    expect(text).not.toContain('INNER_CANARY');
  });

  it('leaves both keys literal when two declared keys collide on the uppercased env name', () => {
    // `:577` uppercases the key for the environment export, so `token` and
    // `TOKEN` share one slot and neither value can be told from the other. A
    // wrong token is worse than an unsubstituted one.
    const values = new PluginUserConfigValues(
      [{ key: 'token', valueType: 'string' }, { key: 'TOKEN', valueType: 'string' }],
      { CLAUDE_PLUGIN_OPTION_TOKEN: 'AMBIGUOUS_CANARY' },
    );
    const { text, report } = substitutePluginUserConfigText(
      '${user_config.token}/${user_config.TOKEN}',
      values,
      { allowSensitive: true },
    );
    expect(text).toBe('${user_config.token}/${user_config.TOKEN}');
    expect(report.unresolved).toEqual(['token', 'TOKEN']);
  });
});

describe('pluginUserConfigContentValues', () => {
  it('carries the non-sensitive values only, so the content pass cannot reach a secret', () => {
    expect(pluginUserConfigContentValues(FIELDS, {
      CLAUDE_PLUGIN_OPTION_TOKEN: 'TOKEN_CANARY',
      CLAUDE_PLUGIN_OPTION_ENDPOINT: 'https://internal.example.invalid',
    })).toEqual({ ENDPOINT: 'https://internal.example.invalid' });
  });

  it('is undefined when nothing non-sensitive is configured', () => {
    expect(pluginUserConfigContentValues(FIELDS, { CLAUDE_PLUGIN_OPTION_TOKEN: 'TOKEN_CANARY' }))
      .toBeUndefined();
  });
});

describe('substitutePluginCapabilityUserConfig', () => {
  it('covers every stdio field a transport reads', () => {
    const { capability } = substitutePluginCapabilityUserConfig({
      id: 'c',
      kind: 'mcp',
      mcp: {
        serverName: 's',
        transport: 'stdio',
        command: '${user_config.ENDPOINT}/bin/server',
        args: ['--token', '${user_config.TOKEN}'],
        cwd: '${user_config.ENDPOINT}',
        env: { API_TOKEN: '${user_config.TOKEN}' },
      },
    }, VALUES);
    expect(capability.kind === 'mcp' && capability.mcp).toMatchObject({
      command: 'https://internal.example.invalid/bin/server',
      args: ['--token', 'TOKEN_CANARY'],
      cwd: 'https://internal.example.invalid',
      env: { API_TOKEN: 'TOKEN_CANARY' },
    });
  });

  it('leaves a hook capability alone — hooks receive values through the environment', () => {
    const hook = {
      id: 'c',
      kind: 'hook' as const,
      hook: { id: 'h', event: 'PreToolUse', type: 'command' as const, command: './notify.sh ${user_config.TOKEN}' },
    };
    const { capability } = substitutePluginCapabilityUserConfig(hook, VALUES);
    expect(capability).toBe(hook);
    expect(JSON.stringify(capability)).not.toContain('TOKEN_CANARY');
  });
});

/**
 * `:579`'s refusal table. Shell-form hook commands and monitor commands are
 * refused at import by the Claude adapter and covered by their own suites;
 * `headersHelper` is the row this file answers, because the question "does that
 * refusal apply here" has an answer specific to this product.
 */
describe('the shell sites are still refused, not substituted', () => {
  const ORIGIN: PluginOrigin = { source: 'local-path', marketplaceId: 'test-marketplace', resolvedAt: 0 };
  const created: string[] = [];

  function bundle(manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
    const root = mkdtempSync(join(tmpdir(), 'user-config-shell-'));
    created.push(root);
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(root, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: 'shell-sites', version: '1.0.0', ...manifest }),
    );
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), contents);
    }
    return root;
  }

  afterEach(() => {
    while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
  });

  // The shell-form hook refusal itself is already pinned verbatim, down to
  // `errors.md:1372`'s wording, by `format-adapters.test.ts` — "refuses a
  // shell-form hook command that references ${user_config.*} and keeps the
  // exec-form one". Not duplicated here; what IS asserted here is that the
  // substitution engine added by D14 never touches a hook capability at all
  // (see the `substitutePluginCapabilityUserConfig` case above).

  /**
   * `errors.md:1385` gives `headersHelper` its own refusal wording, and Nessy
   * now EXECUTES `headersHelper` through a shell at connect time
   * (`mcp/headers-helper.ts`) — so the refusal is no longer satisfied by the
   * field having no runtime. It is enforced where `mcp.md:818` puts it: the
   * adapter reports the server as misconfigured with an ERROR
   * (`plugin.format.claude_mcp_headers_helper_user_config`), never substitutes
   * the value, and the server does not import. `substituteMcp` additionally
   * never lists `headersHelper` as a substitution site.
   */
  it('refuses a headersHelper that references ${user_config.*} with an error', async () => {
    const directory = bundle({
      userConfig: { TOKEN: { type: 'string', title: 'Token', description: 'A token', sensitive: true } },
    }, {
      '.mcp.json': JSON.stringify({
        mcpServers: {
          internal: {
            type: 'http',
            url: 'https://internal.example.invalid/mcp',
            headersHelper: './scripts/token.sh ${user_config.TOKEN}',
          },
        },
      }),
    });
    const result = await normalizeClaudePluginBundle(directory, ORIGIN);
    const refusal = result.diagnostics?.find(
      d => d.code === 'plugin.format.claude_mcp_headers_helper_user_config',
    );
    expect(refusal?.severity).toBe('error');
    expect(refusal?.message).toContain('headersHelper');
    expect(JSON.stringify(result.value?.capabilities ?? [])).not.toContain('headersHelper');
    expect(JSON.stringify(result.value?.capabilities ?? [])).not.toContain('token.sh');
  });
});
