/**
 * D2 — what a listing/manifest DECLARES, and what a declaration is not.
 *
 * The fixture is the real `openai/plugins` `figma` manifest fetched 2026-08-01
 * from `raw.githubusercontent.com/openai/plugins/main/plugins/figma/.codex-plugin/plugin.json`:
 * it declares `skills`, `apps` and `mcpServers` as PATHS and names no component,
 * which is exactly the shape the browse row has to report kinds from.
 */
import { describe, expect, it } from 'bun:test';
import {
  declaredPluginComponentKinds,
  pluginDeclaredComponentKindsFrom,
} from '../declared-components.ts';

const FIGMA_CODEX_MANIFEST = {
  name: 'figma',
  version: '2.0.13',
  description: 'Figma workflows for design implementation.',
  keywords: ['figma', 'design-to-code'],
  skills: './skills/',
  apps: './.app.json',
  mcpServers: './.mcp.json',
  interface: { displayName: 'Figma', capabilities: ['Interactive', 'Read', 'Write'] },
};

describe('declaredPluginComponentKinds', () => {
  it('reports the kinds a Codex manifest declares, in order, and nothing else', () => {
    // `interface.capabilities` (["Interactive","Read","Write"]) is a different
    // vocabulary entirely and must not leak in as component kinds.
    expect(declaredPluginComponentKinds(FIGMA_CODEX_MANIFEST)).toEqual(['skill', 'mcp', 'app']);
  });

  it('reports the Claude marketplace-entry component fields, including the `lsp` alias', () => {
    // `clangd-lsp`'s real entry shape: an inline `lspServers` object, no manifest
    // anywhere in its plugin directory. Entry-declared is its only evidence.
    expect(declaredPluginComponentKinds({
      lspServers: { clangd: { command: 'clangd' } },
    })).toEqual(['lsp']);
    expect(declaredPluginComponentKinds({ lsp: './.lsp.json' })).toEqual(['lsp']);
    expect(declaredPluginComponentKinds({
      skills: ['./a', './b'],
      commands: './commands',
      agents: ['./agents/x.md'],
      workflows: './workflows',
      hooks: { PreToolUse: [] },
    })).toEqual(['skill', 'command', 'agent', 'workflow', 'hook']);
  });

  it('reports the kind for a CUSTOM component path, not only the default one (P6.740)', () => {
    // `plugins/manifest-reference.md#path-rules`: a custom `agents` path
    // REPLACES the default directory ("when the manifest specifies `commands`,
    // the default `commands/` directory is not scanned"). This reader must not
    // be fooled by that into reporting nothing: a browse row for an entry
    // declaring `agents: './custom'` still ships agents. The SCOPE half of the
    // same page's rule — "Components from custom paths use the same naming and
    // namespacing rules" — is behaviour rather than a declaration, so it is
    // pinned where the walker lives (`format-adapters.test.ts`, P6.740).
    expect(declaredPluginComponentKinds({ agents: './custom' })).toEqual(['agent']);
    expect(declaredPluginComponentKinds({ agents: ['./custom/', './extras/'] })).toEqual(['agent']);
  });

  it('treats a present-but-empty field as no declaration', () => {
    expect(declaredPluginComponentKinds({
      skills: '',
      commands: [],
      agents: null,
      hooks: {},
      mcpServers: undefined,
    })).toEqual([]);
    expect(declaredPluginComponentKinds({})).toEqual([]);
    expect(declaredPluginComponentKinds(undefined)).toEqual([]);
    expect(declaredPluginComponentKinds(['skills'])).toEqual([]);
  });
});

describe('pluginDeclaredComponentKindsFrom', () => {
  it('keeps kind tokens and drops the other things `capabilities` carries', () => {
    // Skills Market rows put MCP server names and hook ids in the same field.
    expect(pluginDeclaredComponentKindsFrom(['linear', 'mcp', 'pretool', 'skill']))
      .toEqual(['skill', 'mcp']);
    expect(pluginDeclaredComponentKindsFrom(['linear', 'pretool'])).toEqual([]);
    expect(pluginDeclaredComponentKindsFrom([])).toEqual([]);
    expect(pluginDeclaredComponentKindsFrom(undefined)).toEqual([]);
  });
});
