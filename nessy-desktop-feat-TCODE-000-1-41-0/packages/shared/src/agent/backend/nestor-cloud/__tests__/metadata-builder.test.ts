import { describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildNestorCloudMetadata,
  NESTOR_REQUEST_HEADROOM_BYTES,
  NESTOR_REQUEST_LIMIT_BYTES,
  nestorMetadataByteBudget,
  trimNestorMetadataToByteBudget,
  type NestorCloudMetadata,
} from '../metadata-builder.ts';

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'nestor-cloud-metadata-'));
  const cwd = join(root, 'packages', 'app');
  mkdirSync(cwd, { recursive: true });
  return { root, cwd };
}

describe('buildNestorCloudMetadata', () => {
  it('builds environment_details from cwd, os, shell, and workspace root', () => {
    const { root, cwd } = workspace();
    const metadata = buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
      platform: 'darwin',
      shell: '/bin/zsh',
    });

    expect(metadata.environment_details).toEqual({
      system_info: {
        os: 'darwin',
        shell: '/bin/zsh',
        working_dir: cwd,
        workspace_root: root,
      },
      analytics_request_details: {
        project_name: root.split('/').pop() ?? '',
      },
    });
  });

  it('includes applicable AGENTS.md content as agents_md for a TRUSTED project', () => {
    const { root, cwd } = workspace();
    writeFileSync(join(root, 'AGENTS.md'), 'root rules');
    writeFileSync(join(root, 'packages', 'app', 'AGENTS.md'), 'app rules');

    const metadata = buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
      projectTrusted: true,
    });

    expect(metadata.agents_md?.content).toContain('# AGENTS.md\n\nroot rules');
    expect(metadata.agents_md?.content).toContain('# packages/app/AGENTS.md\n\napp rules');
  });

  it('withholds AGENTS.md content when the project is UNTRUSTED (fail-closed)', () => {
    const { root, cwd } = workspace();
    writeFileSync(join(root, 'AGENTS.md'), 'root rules');
    writeFileSync(join(root, 'packages', 'app', 'AGENTS.md'), 'app rules');

    const metadata = buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
      // projectTrusted omitted -> fail-closed
    });

    expect(metadata.agents_md).toBeUndefined();
  });

  it('sets agent_settings.mode to a native A2A mode id', () => {
    const { root, cwd } = workspace();

    expect(buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
      mode: 'plan',
    }).agent_settings.mode).toBe('plan');

    expect(buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
      mode: 'review',
    }).agent_settings.mode).toBe('review');

    expect(buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
    }).agent_settings.mode).toBe('act');
  });

  it('includes MCP tool definitions and skills metadata in service-compatible shape', () => {
    const { root, cwd } = workspace();
    const metadata = buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
      mcpTools: [{
        name: 'session__read_file',
        description: 'Read a session file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
      skills: [{ name: 'review', description: 'Review code' }],
    });

    expect(metadata.mcp).toEqual([{
      type: 'function',
      name: 'session__read_file',
      description: 'Read a session file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    }]);
    expect(metadata.skills).toEqual([{ name: 'review', description: 'Review code' }]);
  });

  it('builds workspace_tabs as the backend OBJECT, not an array of tab records', () => {
    const { root, cwd } = workspace();
    const metadata = buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
      workspaceTabs: {
        open_tabs: ['src/a.ts', 'src/b.ts'],
        visible_files: ['src/a.ts'],
      },
    });

    // `WorkspaceTabsV1{open_tabs, visible_files}` — anything that is not a JSON
    // object is refused by `GetMetaObjectForKey` (`ErrWrongExtensionType`).
    expect(metadata.workspace_tabs).toEqual({
      open_tabs: ['src/a.ts', 'src/b.ts'],
      visible_files: ['src/a.ts'],
    });
    expect(Array.isArray(metadata.workspace_tabs)).toBe(false);
  });

  it('omits workspace_tabs when there is nothing to report', () => {
    const { root, cwd } = workspace();

    expect(buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
    }).workspace_tabs).toBeUndefined();

    expect(buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
      workspaceTabs: { open_tabs: [], visible_files: [] },
    }).workspace_tabs).toBeUndefined();
  });

  it('does not include token fields', () => {
    const { root, cwd } = workspace();
    const serialized = JSON.stringify(buildNestorCloudMetadata({
      workspaceRootPath: root,
      workingDirectory: cwd,
    }));

    expect(serialized).not.toContain('Nestor-Token');
    expect(serialized).not.toContain('jwt');
    expect(serialized).not.toContain('token');
  });
});

function baseMetadata(overrides: Partial<NestorCloudMetadata> = {}): NestorCloudMetadata {
  return {
    environment_details: {
      system_info: { os: 'darwin', shell: '/bin/zsh', working_dir: '/w/app', workspace_root: '/w' },
      analytics_request_details: { project_name: 'w' },
    },
    agent_settings: { mode: 'act' },
    ...overrides,
  } as NestorCloudMetadata;
}

function serializedBytes(metadata: NestorCloudMetadata): number {
  return Buffer.byteLength(JSON.stringify(metadata), 'utf8');
}

describe('nestorMetadataByteBudget', () => {
  it('is the gateway cap minus the SERIALIZED message minus the envelope headroom', () => {
    // The metadata half is measured serialized (`JSON.stringify`), so the message
    // half must be too — the gateway weighs one body, not two raw blocks.
    expect(nestorMetadataByteBudget('hello')).toBe(
      NESTOR_REQUEST_LIMIT_BYTES - 7 - NESTOR_REQUEST_HEADROOM_BYTES,
    );
    expect(NESTOR_REQUEST_LIMIT_BYTES).toBe(500_000);
    expect(NESTOR_REQUEST_HEADROOM_BYTES).toBe(8_192);
  });

  it('counts the message in BYTES, not UTF-16 code units (Cyrillic)', () => {
    // 100 Cyrillic characters — 100 code units, 200 UTF-8 bytes, +2 for the
    // quotes `JSON.stringify` adds.
    const message = 'я'.repeat(100);
    expect(message.length).toBe(100);
    expect(nestorMetadataByteBudget(message)).toBe(
      NESTOR_REQUEST_LIMIT_BYTES - 202 - NESTOR_REQUEST_HEADROOM_BYTES,
    );
  });

  it('counts the escaping JSON adds to the message, so a newline-heavy prompt still fits', () => {
    // A prompt that is mostly newlines DOUBLES on the wire (`\n` → `\` + `n`),
    // and the raw byte count does not see it: 100,000 raw bytes ship as 200,002.
    // Budgeting off the raw count spent the whole 8,192-byte headroom and then
    // ~92KB more, so the trimmed metadata plus the message went over the cap.
    const message = '\n'.repeat(100_000);
    const metadata = baseMetadata({ agents_md: { content: 'A'.repeat(450_000) } });

    const result = trimNestorMetadataToByteBudget(metadata, nestorMetadataByteBudget(message));

    expect(result.withinBudget).toBe(true);
    expect(result.trims.map(trim => trim.field)).toEqual(['agents_md']);
    const wireBytes = Buffer.byteLength(JSON.stringify(message), 'utf8') + result.bytes;
    expect(Buffer.byteLength(message, 'utf8')).toBe(100_000);
    expect(wireBytes).toBeLessThanOrEqual(NESTOR_REQUEST_LIMIT_BYTES);
  });
});

describe('trimNestorMetadataToByteBudget', () => {
  it('returns the metadata untouched when it already fits', () => {
    const metadata = baseMetadata({
      agents_md: { content: 'short' },
      skills: [{ name: 'review', description: 'Review code' }],
    });

    const result = trimNestorMetadataToByteBudget(metadata, 100_000);

    expect(result.withinBudget).toBe(true);
    expect(result.trims).toEqual([]);
    expect(result.metadata).toEqual(metadata);
    expect(result.bytes).toBe(serializedBytes(metadata));
  });

  it('trims agents_md FIRST and leaves the MCP schemas and skills intact', () => {
    const metadata = baseMetadata({
      agents_md: { content: 'A'.repeat(40_000) },
      mcp: [{
        type: 'function',
        name: 'session__read_file',
        description: 'Read a session file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
      skills: [{ name: 'review', description: 'Review code' }],
    });

    const result = trimNestorMetadataToByteBudget(metadata, 20_000);

    expect(result.withinBudget).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(20_000);
    expect(result.trims.map(trim => trim.field)).toEqual(['agents_md']);
    expect(result.trims[0]?.droppedBytes).toBeGreaterThan(0);
    expect(result.metadata.agents_md?.content.length).toBeLessThan(40_000);
    expect(result.metadata.mcp).toEqual(metadata.mcp);
    expect(result.metadata.skills).toEqual(metadata.skills);
    // The input is not mutated.
    expect(metadata.agents_md?.content.length).toBe(40_000);
  });

  it('measures BYTES, not UTF-16 code units — a Cyrillic agents_md that "fits" by length does not fit by bytes', () => {
    // 12,000 Cyrillic characters: 12,000 code units, 24,000 UTF-8 bytes.
    const content = 'я'.repeat(12_000);
    const metadata = baseMetadata({ agents_md: { content } });
    const budget = 20_000;

    expect(JSON.stringify(metadata).length).toBeLessThan(budget);
    expect(serializedBytes(metadata)).toBeGreaterThan(budget);

    const result = trimNestorMetadataToByteBudget(metadata, budget);

    expect(result.trims.map(trim => trim.field)).toEqual(['agents_md']);
    expect(result.bytes).toBeLessThanOrEqual(budget);
    expect(result.withinBudget).toBe(true);
    // Truncation never splits a multi-byte character.
    expect(result.metadata.agents_md?.content).not.toContain('�');
  });

  it('escalates to the MCP parameters and then the skills when agents_md is not enough', () => {
    const metadata = baseMetadata({
      agents_md: { content: 'A'.repeat(4_000) },
      mcp: Array.from({ length: 20 }, (_unused, index) => ({
        type: 'function' as const,
        name: `server|tool_${index}`,
        description: 'A tool',
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 20 }, (_p, property) => [`prop_${property}`, { type: 'string', description: 'B'.repeat(100) }]),
          ),
        },
      })),
      skills: Array.from({ length: 40 }, (_unused, index) => ({
        name: `skill-${index}`,
        description: 'C'.repeat(200),
      })),
    });

    const result = trimNestorMetadataToByteBudget(metadata, 3_000);

    expect(result.trims.map(trim => trim.field)).toEqual(['agents_md', 'mcp_parameters', 'skills']);
    expect(result.withinBudget).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual(3_000);
    expect(result.metadata.agents_md).toBeUndefined();
    expect(result.metadata.skills).toBeUndefined();
    // The tool NAMES survive — only the schemas are emptied.
    expect(result.metadata.mcp?.length).toBe(20);
    expect(result.metadata.mcp?.[0]?.name).toBe('server|tool_0');
    expect(result.metadata.mcp?.[0]?.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('reports withinBudget FALSE when even the stripped metadata is over the cap', () => {
    const metadata = baseMetadata({
      agents_md: { content: 'A'.repeat(1_000) },
      mcp: [{ type: 'function', name: 'a', description: '', parameters: { type: 'object', properties: {} } }],
      skills: [{ name: 'review', description: 'Review code' }],
    });

    const result = trimNestorMetadataToByteBudget(metadata, 10);

    expect(result.withinBudget).toBe(false);
    expect(result.trims.map(trim => trim.field)).toEqual(['agents_md', 'mcp_parameters', 'skills']);
    expect(result.metadata.environment_details).toEqual(metadata.environment_details);
    expect(result.bytes).toBe(serializedBytes(result.metadata));
  });
});
