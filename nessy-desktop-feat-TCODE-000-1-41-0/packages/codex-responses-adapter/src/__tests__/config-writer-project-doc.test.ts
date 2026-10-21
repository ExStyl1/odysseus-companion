/**
 * P6.392 — the three instruction-discovery keys codex publishes and this fork
 * wrote none of, plus the truncation sentence codex will not say for us.
 *
 * Everything asserted here is measured at `openai/codex` `rust-v0.148.0`
 * (`codex-rs/core/src/agents_md.rs`) and against the pinned schema, never from
 * the page — for codex the source outranks the page.
 */
import { describe, expect, it } from 'bun:test';

import { buildCodexConfigToml } from '../config-writer.ts';
import {
  CODEX_PROJECT_DOC_FALLBACK_FILENAMES,
  CODEX_PROJECT_DOC_MAX_BYTES_DEFAULT,
  CODEX_PROJECT_ROOT_MARKERS,
  buildCodexProjectDocTomlLines,
  formatCodexProjectDocTruncationDiagnostics,
} from '../config-writer-permissions.ts';

describe('buildCodexProjectDocTomlLines', () => {
  it('writes the two candidate names codex does not know, and the marker set', () => {
    // `candidate_filenames` is `[AGENTS.override.md, AGENTS.md, …fallbacks]`, so
    // the projection is the DIFFERENCE — restating the first two would only make
    // codex skip them again (`if !names.contains(&candidate)`).
    expect(buildCodexProjectDocTomlLines()).toEqual([
      'project_doc_fallback_filenames = ["CLAUDE.md", "CLAUDE.local.md"]',
      'project_root_markers = [".git"]',
    ]);
    expect(CODEX_PROJECT_DOC_FALLBACK_FILENAMES).toEqual(['CLAUDE.md', 'CLAUDE.local.md']);
    expect(CODEX_PROJECT_ROOT_MARKERS).toEqual(['.git']);
  });

  it('omits the byte budget unless a caller set one', () => {
    // The control. An install that configured nothing must keep codex's own
    // default rather than have ours pinned on top of it — the same rule
    // `tool_output_token_limit` records one block above in the emitted file.
    expect(buildCodexProjectDocTomlLines().some(line => line.startsWith('project_doc_max_bytes')))
      .toBe(false);
    expect(buildCodexProjectDocTomlLines({ projectDocMaxBytes: 65_536 }))
      .toContain('project_doc_max_bytes = 65536');
    // A non-integer or negative value is not written at all: a wrong-TYPED
    // top-level scalar makes codex discard the whole config.
    expect(buildCodexProjectDocTomlLines({ projectDocMaxBytes: -1 }))
      .not.toContain('project_doc_max_bytes = -1');
    expect(buildCodexProjectDocTomlLines({ projectDocMaxBytes: 1.5 }).length).toBe(2);
  });

  it('never writes an EMPTY marker list, because that means something else', () => {
    // `agents_md.rs`, module doc: "An empty marker list disables parent
    // traversal." Emitting `[]` by accident would silently confine discovery to
    // the working directory — a stricter behaviour than the default, arrived at
    // by writing nothing on purpose.
    expect(buildCodexProjectDocTomlLines({ projectRootMarkers: [], projectDocFallbackFilenames: [] }))
      .toEqual([]);
    expect(buildCodexProjectDocTomlLines({ projectRootMarkers: ['  ', ''] }))
      .not.toContain('project_root_markers = []');
  });

  it('escapes the names it writes', () => {
    expect(buildCodexProjectDocTomlLines({ projectDocFallbackFilenames: ['TEAM"GUIDE.md'] })[0])
      .toBe('project_doc_fallback_filenames = ["TEAM\\"GUIDE.md"]');
  });
});

describe('formatCodexProjectDocTruncationDiagnostics', () => {
  it('says the chain is being cut, because codex says it only to its own tracing log', () => {
    const lines = formatCodexProjectDocTruncationDiagnostics(40_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('40000 bytes');
    expect(lines[0]).toContain(String(CODEX_PROJECT_DOC_MAX_BYTES_DEFAULT));
    expect(lines[0]).toContain('project_doc_max_bytes');
  });

  it('says nothing for a chain that fits, or for a host that did not measure', () => {
    // The control the row asks for by name: "a chain under it producing no line."
    expect(formatCodexProjectDocTruncationDiagnostics(CODEX_PROJECT_DOC_MAX_BYTES_DEFAULT)).toEqual([]);
    expect(formatCodexProjectDocTruncationDiagnostics(0)).toEqual([]);
    expect(formatCodexProjectDocTruncationDiagnostics(undefined)).toEqual([]);
    // A raised cap moves the line with it, which is what "settable" has to mean.
    expect(formatCodexProjectDocTruncationDiagnostics(40_000, 65_536)).toEqual([]);
  });
});

describe('the emitted config.toml', () => {
  // The wiring half of P6.392(2)/(3): a builder nobody calls writes nothing, and
  // the two keys are BARE, so where they land in the file is the whole risk.
  const toml = buildCodexConfigToml({
    codexHome: '/tmp/codex-home',
    model: 'gpt-5-codex',
    adapterPort: 54321,
    mode: 'default',
  });

  it('carries both keys, before the first table header', () => {
    const lines = toml.split('\n');
    const firstTable = lines.findIndex(line => line.startsWith('['));
    expect(firstTable).toBeGreaterThan(0);
    const names = lines.indexOf('project_doc_fallback_filenames = ["CLAUDE.md", "CLAUDE.local.md"]');
    const markers = lines.indexOf('project_root_markers = [".git"]');
    expect(names).toBeGreaterThan(-1);
    expect(markers).toBeGreaterThan(-1);
    // A bare key after a table header is swallowed by that table — the trap
    // `compact_prompt` and `approvals_reviewer` both record in this file.
    expect(names).toBeLessThan(firstTable);
    expect(markers).toBeLessThan(firstTable);
  });

  it('leaves the byte cap to codex, so an unconfigured install keeps its own default', () => {
    // The negative arm: writing `project_doc_max_bytes` unasked would pin our
    // number over codex's and make its next default change invisible.
    expect(toml).not.toContain('project_doc_max_bytes');
  });
});
