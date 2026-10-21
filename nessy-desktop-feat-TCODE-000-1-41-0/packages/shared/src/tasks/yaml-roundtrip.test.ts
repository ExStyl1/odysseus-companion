/**
 * UA3.2 — `task.yaml` round-trips through `js-yaml` (the reader that replaces upstream's `yaml`, `storage.ts`
 * divergence 1) and permission modes parse through `parsePermissionMode` (`schema.ts`).
 *
 * Positive: the upstream example — the one `buildGeneratorPrompt` shows the model, read out of the prompt itself —
 * parses, serializes and parses back to the same spec. Negative: `allow-all` parses to `bypassPermissions` (and is
 * written back canonical); a bogus mode is an error.
 */
import { describe, expect, it } from 'bun:test';
import { load as loadYaml } from 'js-yaml';
import { buildGeneratorPrompt } from './generator-prompt.ts';
import { parseTaskYaml, serializeTaskYaml } from './storage.ts';

/** The `Example:` block of the generator prompt, dedented — the upstream example task.yaml. */
function upstreamExampleYaml(): string {
  const lines = buildGeneratorPrompt('unused goal').split('\n');
  const start = lines.indexOf('Example:');
  expect(start).toBeGreaterThan(-1);
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    block.push(line.slice(2));
  }
  return block.join('\n');
}

describe('task.yaml round-trip through js-yaml', () => {
  it('the upstream example parses, serializes and parses back to the same spec', () => {
    const yaml = upstreamExampleYaml();
    expect(yaml).toContain('id: migrate-auth');
    const first = parseTaskYaml(yaml);
    expect(first.errors).toEqual([]);
    expect(first.valid).toBe(true);
    expect(first.spec?.nodes.map((n) => n.id)).toEqual(['audit', 'design']);
    expect(first.spec?.nodes[1]?.prompt).toBe('Design the new session-based auth using the audit: ${nodes.audit.output}');

    const second = parseTaskYaml(serializeTaskYaml(first.spec!));
    expect(second.valid).toBe(true);
    expect(second.spec).toEqual(first.spec);
  });

  it('keeps a date-shaped scalar a string (CORE_SCHEMA, as upstream yaml parses) and emits no anchors', () => {
    const yaml = ['id: dated', 'title: Dated', 'goal: 2026-10-02', 'nodes:', '  - id: a', '    prompt: p'].join('\n');
    const parsed = parseTaskYaml(yaml);
    expect(parsed.valid).toBe(true);
    expect(parsed.spec?.goal).toBe('2026-10-02');
    const out = serializeTaskYaml(parsed.spec!);
    expect(out).not.toMatch(/[&*]ref_/);
    expect(parseTaskYaml(out).spec).toEqual(parsed.spec);
  });

  it('allow-all parses to bypassPermissions and is written back canonical', () => {
    const yaml = [
      'id: modes',
      'title: Modes',
      'goal: g',
      'defaults:',
      '  permissionMode: ask',
      'nodes:',
      '  - id: a',
      '    prompt: p',
      '    permissionMode: allow-all',
    ].join('\n');
    const parsed = parseTaskYaml(yaml);
    expect(parsed.valid).toBe(true);
    expect(parsed.spec?.nodes[0]?.permissionMode).toBe('bypassPermissions');
    expect(parsed.spec?.defaults?.permissionMode).toBe('default');

    const out = serializeTaskYaml(parsed.spec!);
    const raw = loadYaml(out) as { defaults: { permissionMode: string }; nodes: { permissionMode: string }[] };
    expect(raw.nodes[0]?.permissionMode).toBe('bypassPermissions');
    expect(raw.defaults.permissionMode).toBe('default');
    expect(parseTaskYaml(out).spec).toEqual(parsed.spec);
  });

  it('a bogus mode is an error, not a default', () => {
    const yaml = ['id: bogus', 'title: Bogus', 'goal: g', 'nodes:', '  - id: a', '    prompt: p', '    permissionMode: yolo'].join('\n');
    const parsed = parseTaskYaml(yaml);
    expect(parsed.valid).toBe(false);
    expect(parsed.spec).toBeUndefined();
    expect(parsed.errors.some((e) => e.message.includes('Unknown permission mode "yolo"'))).toBe(true);
  });
});
