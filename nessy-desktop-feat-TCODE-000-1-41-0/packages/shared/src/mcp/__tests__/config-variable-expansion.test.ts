/**
 * `${VAR}` / `${VAR:-default}` expansion in MCP server configuration.
 *
 * Today's behavior, established BEFORE implementing (a fix aimed at the wrong
 * branch is a no-op that still looks green):
 *
 * - Plugin/snapshot MCP servers DO expand, in `runtime-pool-servers.ts`
 *   `resolveRuntimeString`, but only the bare `${VAR}` form — and an unset name
 *   is silently replaced with the EMPTY STRING. `${VAR:-default}` does not match
 *   its regex at all, so the whole token survives literally.
 * - Project `.mcp.json` / `mcp.json` entries expand NOTHING. `parseProjectMcpServer`
 *   copies `command`, `args`, `env`, `url` and `headers` verbatim, and
 *   `materializeSnapshotMcpServers` routes those servers through
 *   `parseMcpServersDocument` and returns before `resolveRuntimeString` is ever
 *   reached. This is the branch AGENTS.md records as "bare `${VAR}` (unexpanded
 *   for `.mcp.json`)", and it is the branch the documented contract is about.
 */

import { CapabilityMaterializationError } from '../../capabilities/materializer.ts';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { expandConfigVariables } from '../server-config-values.ts';
import { parseMcpServersDocument } from '../project-config.ts';
import { materializeRuntimePoolServers } from '../runtime-pool-servers.ts';
import type { CapabilityTurnRuntime } from '../../agent/backend/types.ts';

const OWNED = ['NESSY_TEST_MCP_VAR', 'NESSY_TEST_MCP_BASE'] as const;
afterEach(() => { for (const name of OWNED) delete process.env[name]; });

describe('expandConfigVariables', () => {
  it.each([
    ['bare reference to a set variable', '${NESSY_TEST_MCP_VAR}/mcp', { NESSY_TEST_MCP_VAR: 'v' }, 'v/mcp', []],
    ['default when the variable is unset', '${NESSY_TEST_MCP_VAR:-fallback}', {}, 'fallback', []],
    ['value wins over the default', '${NESSY_TEST_MCP_VAR:-fallback}', { NESSY_TEST_MCP_VAR: 'v' }, 'v', []],
    ['empty default', 'x${NESSY_TEST_MCP_VAR:-}y', {}, 'xy', []],
    ['a default containing a colon', '${NESSY_TEST_MCP_BASE:-https://api.example.test}', {}, 'https://api.example.test', []],
    ['several references in one value', '${A}:${B:-b}', { A: 'a' }, 'a:b', []],
    ['no reference at all', 'plain', {}, 'plain', []],
  ])('expands %s', (_label, input, environment, expected, missing) => {
    expect(expandConfigVariables(input, environment)).toEqual({ value: expected, missing });
  });

  it('reports an unset variable with no default instead of substituting an empty string', () => {
    // A blank auth header yielding a 401 is far harder to diagnose than a
    // refused start, so the token survives and the caller gets a name to report.
    expect(expandConfigVariables('Bearer ${NESSY_TEST_MCP_VAR}', {})).toEqual({
      value: 'Bearer ${NESSY_TEST_MCP_VAR}',
      missing: ['NESSY_TEST_MCP_VAR'],
    });
  });

  it('still reports the name under the empty-substitution policy', () => {
    // The plugin branch keeps substituting '' because its own
    // `missingRequiredNames` gate reads the resolved environment — a literal
    // token there would make an unset required variable look satisfied.
    expect(expandConfigVariables('Bearer ${NESSY_TEST_MCP_VAR}', {}, 'empty')).toEqual({
      value: 'Bearer ',
      missing: ['NESSY_TEST_MCP_VAR'],
    });
  });

  it('treats an empty environment value as unset so a default still applies', () => {
    expect(expandConfigVariables('${NESSY_TEST_MCP_VAR:-fallback}', { NESSY_TEST_MCP_VAR: '' }))
      .toEqual({ value: 'fallback', missing: [] });
  });
});

describe('.mcp.json variable expansion', () => {
  const parse = (server: Record<string, unknown>, warn?: (message: string) => void) =>
    parseMcpServersDocument({ mcpServers: { docs: server } }, warn).docs;

  it('expands the documented locations: command, args, env, url and headers', () => {
    process.env.NESSY_TEST_MCP_VAR = 'secret';
    expect(parse({
      type: 'http',
      url: '${NESSY_TEST_MCP_BASE:-https://api.example.test}/mcp',
      headers: { Authorization: 'Bearer ${NESSY_TEST_MCP_VAR}' },
    })).toEqual({
      type: 'http',
      url: 'https://api.example.test/mcp',
      headers: { Authorization: 'Bearer secret' },
    });
    expect(parse({
      command: '${NESSY_TEST_MCP_BASE:-/usr/bin}/server',
      args: ['--token', '${NESSY_TEST_MCP_VAR}'],
      env: { TOKEN: '${NESSY_TEST_MCP_VAR}' },
    })).toEqual({
      type: 'stdio',
      command: '/usr/bin/server',
      args: ['--token', 'secret'],
      env: { TOKEN: 'secret' },
    });
  });

  it('warns and leaves the token literal when a variable is unset with no default', () => {
    const warnings: string[] = [];
    const config = parse({
      type: 'http',
      url: 'https://api.example.test/mcp',
      headers: { Authorization: 'Bearer ${NESSY_TEST_MCP_VAR}' },
    }, message => warnings.push(message));

    expect(config).toMatchObject({ headers: { Authorization: 'Bearer ${NESSY_TEST_MCP_VAR}' } });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('NESSY_TEST_MCP_VAR');
    expect(warnings[0]).toContain('docs');
  });

  it('leaves a config without references byte-identical', () => {
    expect(parse({ command: '/bin/true', args: ['--x'], env: { A: 'b' } })).toEqual({
      type: 'stdio', command: '/bin/true', args: ['--x'], env: { A: 'b' },
    });
  });
});

/**
 * `mcp.md:115`, whole line: "This variable is set in the server's environment,
 * not in Claude Code's own environment, so referencing it via `${VAR}`
 * expansion in the `command` or `args` of a project-scoped `.mcp.json` entry …
 * requires a default such as `${CLAUDE_PROJECT_DIR:-.}`." The host project
 * directory therefore seeds the stdio SPAWN env only — never the expansion
 * environment.
 */
describe('.mcp.json project-directory contract (mcp.md:115)', () => {
  const PROJECT_NAMES = ['CLAUDE_PROJECT_DIR', 'NESSY_PROJECT_DIR'] as const;
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const name of PROJECT_NAMES) {
      saved.set(name, process.env[name]);
      // The suite itself runs under an agent that may export these; the tests
      // below are about a host that does NOT have them ambiently.
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of PROJECT_NAMES) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const parse = (server: Record<string, unknown>, projectDirectory?: string, warn?: (message: string) => void) =>
    parseMcpServersDocument(
      { mcpServers: { docs: server } },
      warn,
      '.mcp.json',
      projectDirectory ? { projectDirectory } : {},
    ).docs;

  it('keeps a bare ${CLAUDE_PROJECT_DIR} literal (and warns) even when the host supplies the directory', () => {
    const warnings: string[] = [];
    const config = parse(
      { command: '${CLAUDE_PROJECT_DIR}/bin/server' },
      '/workspace/project',
      message => warnings.push(message),
    );

    expect(config).toMatchObject({ command: '${CLAUDE_PROJECT_DIR}/bin/server' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('CLAUDE_PROJECT_DIR');
  });

  it('resolves ${CLAUDE_PROJECT_DIR:-.} through the ordinary default, as the doc instructs', () => {
    const warnings: string[] = [];
    const config = parse(
      { command: '${CLAUDE_PROJECT_DIR:-.}/bin/server' },
      '/workspace/project',
      message => warnings.push(message),
    );

    expect(config).toMatchObject({ command: './bin/server' });
    expect(warnings).toEqual([]);
  });

  it('seeds both project-dir names into the stdio spawn env, with the entry\'s own values winning', () => {
    const config = parse(
      { command: '/bin/server', env: { CLAUDE_PROJECT_DIR: '/entry-wins', OTHER: 'x' } },
      '/workspace/project',
    );

    expect(config).toMatchObject({
      env: {
        NESSY_PROJECT_DIR: '/workspace/project',
        CLAUDE_PROJECT_DIR: '/entry-wins',
        OTHER: 'x',
      },
    });
  });

  it('withholds both names for a project-less parse, byte-identical to before', () => {
    const config = parse({ command: '/bin/server' });

    expect(config).toEqual({ type: 'stdio', command: '/bin/server' });
  });
});

describe('plugin/snapshot MCP variable expansion', () => {
  it('resolves ${VAR:-default} in a remote descriptor instead of shipping the token', async () => {
    // The other branch. Its regex matched only the bare form, so a descriptor
    // using a default sent the literal `${VAR:-...}` text into the URL.
    const runtime = {
      view: {
        generation: 'g',
        sources: [], skills: [], hooks: [], automations: [], agents: [], promptLayers: [],
        memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [],
        mcpServers: [{
          key: 'plugin#api',
          wireName: 'api',
          definition: { type: 'http', url: '${NESSY_TEST_MCP_BASE:-https://api.example.test}/mcp' },
        }],
      },
      materializer: {
        assertActive: () => {},
        verifyPlugin: async () => {},
        resolvePath: async () => '/abs',
        readText: async () => '{}',
        resolveCredential: () => { throw new CapabilityMaterializationError('credential-not-ready') },
      },
    } as unknown as CapabilityTurnRuntime;

    const out = await materializeRuntimePoolServers(runtime, {
      workspaceRootPath: '/ws',
      workspaceId: 'ws-1',
    });

    expect(out.mergedMcpServers.api).toMatchObject({ url: 'https://api.example.test/mcp' });
  });

  // f221 clause 2: an imported Claude manifest's `${CLAUDE_PROJECT_DIR}` is
  // rewritten to `${NESSY_PROJECT_DIR}` at import (`claude.ts`), and
  // `pluginRuntimeEnv` now EMITS that name when a validated project path is
  // present — so the rewritten token expands instead of surviving literally.
  it('expands a plugin descriptor\'s rewritten ${NESSY_PROJECT_DIR}', async () => {
    const runtime = {
      view: {
        generation: 'g',
        sources: [], skills: [], hooks: [], automations: [], agents: [], promptLayers: [],
        memory: [], permissionLayers: [], commands: [], promptCommands: [], apps: [], lspServers: [],
        mcpServers: [{
          key: 'plugin#api',
          wireName: 'api',
          definition: { type: 'http', url: 'https://api.example.test/${NESSY_PROJECT_DIR}/mcp' },
          pluginRuntime: {
            rootPath: '/cache/bundle',
            dataPath: '/data/ws',
            projectPath: '/workspace/project',
            profile: 'claude-plugin-env-v1',
          },
        }],
      },
      materializer: {
        assertActive: () => {},
        verifyPlugin: async () => {},
        resolvePath: async () => '/abs',
        readText: async () => '{}',
        resolveCredential: () => { throw new CapabilityMaterializationError('credential-not-ready') },
      },
    } as unknown as CapabilityTurnRuntime;

    const out = await materializeRuntimePoolServers(runtime, {
      workspaceRootPath: '/ws',
      workspaceId: 'ws-1',
    });

    expect(out.mergedMcpServers.api).toMatchObject({
      url: 'https://api.example.test//workspace/project/mcp',
    });
  });
});
