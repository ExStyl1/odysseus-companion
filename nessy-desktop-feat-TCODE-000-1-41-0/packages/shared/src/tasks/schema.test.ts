/**
 * UA3.2 — adapted from craft-agents-oss `v0.13.4:packages/shared/src/tasks/schema.test.ts` (Apache-2.0): every
 * upstream case is kept unchanged; the "Nessy adaptations (UA3.2)" block at the end pins the stated divergences of
 * `schema.ts` (modes through `parsePermissionMode`) and `validate.ts` (beta warnings, gateway aliases).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { parseTaskSpec, nodeDeps, nodeTitle, PERMISSION_MODES, type TaskSpec } from './schema.ts';
import { extractRefs, interpolateRefs } from './refs.ts';
import { validateTaskSpec, validateTaskInput, TASK_CAPS, GATEWAY_MODEL_ALIASES, isKnownTaskModel } from './validate.ts';
import { resolveGatewayCoderModelId, resolveGatewayFastModelId } from '../config/llm-connections.ts';
import type { ModelDefinition } from '../config/models.ts';
import { buildGeneratorPrompt, buildRepairPrompt } from './generator-prompt.ts';
import { GENERATE_ATTEMPT_MAX_MS, GENERATE_CLIENT_GRACE_MS, GENERATE_CLIENT_TIMEOUT_MS, GENERATE_IDLE_TIMEOUT_MS, MAX_GENERATE_ATTEMPTS } from './generate-limits.ts';
import {
  parseTaskYaml,
  serializeTaskYaml,
  saveTaskSpec,
  loadTaskSpec,
  appendRunLog,
  readRunLog,
  writeNodeOutput,
  readNodeOutput,
  listTaskSlugs,
  type RunLogEntry,
} from './storage.ts';

/** A valid 3-node chain: audit → design → impl (the V1 acceptance shape). */
const CHAIN = {
  id: 'demo',
  title: 'Demo chain',
  goal: 'audit then design then implement',
  nodes: [
    { id: 'audit', prompt: 'Audit the code' },
    { id: 'design', depends_on: ['audit'], prompt: 'Design using ${nodes.audit.output}' },
    { id: 'impl', depends_on: ['design'], prompt: 'Implement ${nodes.design.output}' },
  ],
  outputs: { result: '${nodes.impl.output}' },
};

function parsed(): TaskSpec {
  const r = parseTaskSpec(CHAIN);
  if (!r.success) throw new Error('fixture should parse');
  return r.data;
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

describe('schema', () => {
  it('parses a valid chain and applies defaults', () => {
    const r = parseTaskSpec(CHAIN);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.runner).toBe('conduct');
    expect(r.data.nodes[0]!.kind).toBe('session');
    expect(nodeDeps(r.data.nodes[1]!)).toEqual(['audit']);
    expect(nodeTitle(r.data.nodes[0]!)).toBe('audit'); // title falls back to id
  });

  it('normalizes the legacy `type` alias onto `kind`', () => {
    const r = parseTaskSpec({
      id: 'x',
      title: 'X',
      goal: 'g',
      nodes: [{ id: 'dyn', type: 'orchestrator', prompt: 'expand' }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.nodes[0]!.kind).toBe('orchestrator');
    expect((r.data.nodes[0] as Record<string, unknown>).type).toBeUndefined();
  });

  it('requires a prompt on session nodes', () => {
    const r = parseTaskSpec({ id: 'x', title: 'X', goal: 'g', nodes: [{ id: 'a' }] });
    expect(r.success).toBe(false);
  });

  it('accepts an optional acceptance_criteria rubric', () => {
    const r = parseTaskSpec({ ...CHAIN, acceptance_criteria: 'The implementation must pass all tests.' });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.acceptance_criteria).toBe('The implementation must pass all tests.');
  });

  it('accepts max_iterations at the cap and at zero, rejects above the cap', () => {
    expect(parseTaskSpec({ ...CHAIN, max_iterations: 10 }).success).toBe(true);
    expect(parseTaskSpec({ ...CHAIN, max_iterations: 0 }).success).toBe(true);
    expect(parseTaskSpec({ ...CHAIN, max_iterations: 11 }).success).toBe(false);
  });

  it('accepts optional task-level sources and skills, rejecting empty slugs', () => {
    const r = parseTaskSpec({ ...CHAIN, sources: ['github', 'linear'], skills: ['commit'] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.sources).toEqual(['github', 'linear']);
    expect(r.data.skills).toEqual(['commit']);
    expect(parseTaskSpec({ ...CHAIN, sources: [''] }).success).toBe(false);
  });

  it('rejects duplicate node ids', () => {
    const r = parseTaskSpec({
      id: 'x',
      title: 'X',
      goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'a', prompt: 'q' },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects an invalid slug id', () => {
    const r = parseTaskSpec({ id: 'Bad Id', title: 'X', goal: 'g', nodes: [{ id: 'a', prompt: 'p' }] });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

describe('refs', () => {
  it('extracts node, field, and param references', () => {
    const refs = extractRefs('use ${nodes.audit.output} and ${nodes.design.output.score} with ${params.env}');
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({ kind: 'node', nodeId: 'audit' });
    expect(refs[1]).toMatchObject({ kind: 'node', nodeId: 'design', field: 'score' });
    expect(refs[2]).toMatchObject({ kind: 'param', name: 'env' });
  });

  it('interpolates text, fields, and params; leaves unknown refs raw', () => {
    const out = interpolateRefs(
      'A=${nodes.a.output} B=${nodes.a.output.score} P=${params.env} M=${nodes.missing.output}',
      { nodeOutputs: { a: { text: 'hello', params: { score: 7 } } }, params: { env: 'prod' } },
    );
    expect(out).toBe('A=hello B=7 P=prod M=${nodes.missing.output}');
  });

  it('supports an onMissing fallback', () => {
    const out = interpolateRefs('X=${nodes.ghost.output}', { nodeOutputs: {} }, { onMissing: () => '<none>' });
    expect(out).toBe('X=<none>');
  });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe('validate', () => {
  it('accepts a valid chain with no errors or warnings', () => {
    const res = validateTaskSpec(parsed());
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.warnings).toHaveLength(0);
  });

  it('flags dangling depends_on', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', depends_on: ['ghost'] }],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.message.includes('unknown node "ghost"'))).toBe(true);
  });

  it('flags an unresolved node reference', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'see ${nodes.ghost.output}' }],
    });
    expect(res.errors.some((e) => e.message.includes('unknown node "ghost"'))).toBe(true);
  });

  it('warns when a referenced node is not listed in depends_on', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'b', prompt: 'uses ${nodes.a.output}' }, // no depends_on
      ],
    });
    expect(res.valid).toBe(true);
    expect(res.warnings.some((w) => w.message.includes('does not list it in depends_on'))).toBe(true);
  });

  it('errors on an undeclared param reference but accepts a declared one', () => {
    const bad = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'env is ${params.env}' }],
    });
    expect(bad.errors.some((e) => e.message.includes('undeclared task param "env"'))).toBe(true);

    const ok = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      params: [{ name: 'env' }],
      nodes: [{ id: 'a', prompt: 'env is ${params.env}' }],
    });
    expect(ok.errors).toHaveLength(0);
  });

  it('warns when a reference reads a structured output field (not populated in v1)', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p' },
        { id: 'b', depends_on: ['a'], prompt: 'uses ${nodes.a.output.score}' },
      ],
    });
    expect(res.valid).toBe(true);
    expect(res.warnings.some((w) => w.message.includes('structured output field'))).toBe(true);
  });

  it('detects a dependency cycle', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [
        { id: 'a', prompt: 'p', depends_on: ['b'] },
        { id: 'b', prompt: 'q', depends_on: ['a'] },
      ],
    });
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.message.includes('cycle'))).toBe(true);
  });

  it('rejects a self-dependency', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', depends_on: ['a'] }],
    });
    expect(res.errors.some((e) => e.message.includes('depends on itself'))).toBe(true);
  });

  it('errors when loop.max exceeds the cap', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', loop: { until: 'DONE', max: TASK_CAPS.maxLoopIterations + 1 } }],
    });
    expect(res.errors.some((e) => e.message.includes('exceeds the cap'))).toBe(true);
  });

  it('warns on an unknown model', () => {
    const res = validateTaskInput({
      id: 'x', title: 'X', goal: 'g',
      nodes: [{ id: 'a', prompt: 'p', model: 'gpt-imaginary-9' }],
    });
    expect(res.warnings.some((w) => w.message.includes('not a known built-in model'))).toBe(true);
  });

  it('errors when the node count exceeds the cap', () => {
    const nodes = Array.from({ length: TASK_CAPS.maxNodes + 1 }, (_, i) => ({ id: `n${i}`, prompt: 'p' }));
    const res = validateTaskInput({ id: 'x', title: 'X', goal: 'g', nodes });
    expect(res.errors.some((e) => e.message.includes('exceeding the cap'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

describe('storage', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tasks-test-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a spec through task.yaml', () => {
    const spec = parsed();
    saveTaskSpec(root, spec);

    expect(listTaskSlugs(root)).toEqual(['demo']);

    const loaded = loadTaskSpec(root, 'demo');
    expect(loaded?.valid).toBe(true);
    expect(loaded?.spec?.id).toBe('demo');
    expect(loaded?.spec?.nodes.map((n) => n.id)).toEqual(['audit', 'design', 'impl']);
    expect(nodeDeps(loaded!.spec!.nodes[1]!)).toEqual(['audit']);
  });

  it('serializes to parseable yaml', () => {
    const yaml = serializeTaskYaml(parsed());
    const reparsed = parseTaskYaml(yaml);
    expect(reparsed.valid).toBe(true);
    expect(reparsed.spec?.title).toBe('Demo chain');
  });

  it('reports invalid yaml without throwing', () => {
    const res = parseTaskYaml(':\n  - [unbalanced');
    expect(res.valid).toBe(false);
    expect(res.errors[0]?.message).toContain('Invalid YAML');
  });

  it('appends and reads the run log in order', () => {
    const entries: RunLogEntry[] = [
      { t: '2026-06-07T00:00:00.000Z', kind: 'run-started', taskId: 'demo', runId: 'r1' },
      { t: '2026-06-07T00:00:01.000Z', kind: 'node-scheduled', nodeId: 'audit' },
      { t: '2026-06-07T00:00:02.000Z', kind: 'node-spawned', nodeId: 'audit', sessionId: 's-audit' },
      { t: '2026-06-07T00:00:03.000Z', kind: 'node-finished', nodeId: 'audit', sessionId: 's-audit', state: 'done' },
    ];
    for (const e of entries) appendRunLog(root, 'demo', 'r1', e);
    expect(readRunLog(root, 'demo', 'r1')).toEqual(entries);
  });

  it('writes and reads per-node output', () => {
    writeNodeOutput(root, 'demo', 'r1', 'audit', { text: 'findings', params: { count: 3 } });
    expect(readNodeOutput(root, 'demo', 'r1', 'audit')).toEqual({ text: 'findings', params: { count: 3 } });
    expect(readNodeOutput(root, 'demo', 'r1', 'missing')).toBeNull();
  });
});

describe('generator-prompt', () => {
  it('instructs the model that every reference must resolve to a declared node', () => {
    const prompt = buildGeneratorPrompt('Decompose the goal', 'My task');
    expect(prompt).toContain('${nodes.<id>.output} reference MUST point to an `id` that you actually declare');
    expect(prompt).toContain('Goal: Decompose the goal');
    expect(prompt).toContain('Working title: My task');
  });

  it('repair prompt lists each validation error and re-asserts the YAML-only contract', () => {
    const prompt = buildRepairPrompt([
      { path: 'nodes.design.inputs', message: 'Reference ${nodes.audit-completion-signal.output} points to unknown node "audit-completion-signal"' },
      { path: 'root', message: 'second problem' },
    ]);
    expect(prompt).toContain('- nodes.design.inputs: Reference ${nodes.audit-completion-signal.output} points to unknown node "audit-completion-signal"');
    expect(prompt).toContain('- root: second problem');
    expect(prompt).toContain('Output ONLY the YAML');
  });

  // UB2.9 (B4-14): the authoring and repair turns are bound off tools — the subtasks do the
  // investigating, and the authoring answer has a time limit.
  it('keeps the authoring and repair turns off tools', () => {
    expect(buildGeneratorPrompt('Decompose the goal')).toContain('Do not use tools');
    expect(buildRepairPrompt([{ path: 'root', message: 'x' }])).toContain('Do not use tools');
  });

  // UB2.9 (B4-14): the client fallback re-derives from the CAP — the server's own timeouts and
  // its tasks:generated push always land before the editor gives up locally.
  it('derives the client fallback from the attempt cap plus the grace', () => {
    expect(GENERATE_ATTEMPT_MAX_MS).toBe(300_000);
    expect(GENERATE_IDLE_TIMEOUT_MS).toBe(90_000);
    expect(GENERATE_CLIENT_TIMEOUT_MS).toBe(MAX_GENERATE_ATTEMPTS * GENERATE_ATTEMPT_MAX_MS + GENERATE_CLIENT_GRACE_MS);
    expect(GENERATE_CLIENT_TIMEOUT_MS).toBe(620_000);
  });
});

// ---------------------------------------------------------------------------
// Nessy adaptations (UA3.2)
// ---------------------------------------------------------------------------

describe('Nessy adaptations (UA3.2)', () => {
  const node = (extra: Record<string, unknown>) => ({ id: 'x', title: 'X', goal: 'g', nodes: [{ id: 'a', prompt: 'p', ...extra }] });

  describe('permission modes go through parsePermissionMode', () => {
    it('reads upstream spellings as our canonical modes (node and defaults)', () => {
      const r = parseTaskSpec({ ...node({ permissionMode: 'allow-all' }), defaults: { permissionMode: 'ask' } });
      expect(r.success).toBe(true);
      if (!r.success) return;
      expect(r.data.nodes[0]!.permissionMode).toBe('bypassPermissions');
      expect(r.data.defaults?.permissionMode).toBe('default');
      const safe = parseTaskSpec(node({ permissionMode: 'safe' }));
      expect(safe.success && safe.data.nodes[0]!.permissionMode).toBe('plan');
    });

    it('keeps every canonical mode as itself', () => {
      for (const mode of PERMISSION_MODES) {
        const r = parseTaskSpec(node({ permissionMode: mode }));
        expect(r.success && r.data.nodes[0]!.permissionMode).toBe(mode);
      }
      expect([...PERMISSION_MODES]).toEqual(['dontAsk', 'plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);
    });

    it('refuses an unknown mode as a schema error, never a silent default', () => {
      const r = validateTaskInput(node({ permissionMode: 'yolo' }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.path === 'nodes.0.permissionMode' && e.message.includes('Unknown permission mode "yolo"'))).toBe(true);
      expect(parseTaskSpec({ ...node({}), defaults: { permissionMode: 'yolo' } }).success).toBe(false);
    });
  });

  describe('beta kinds and flags warn (OQ-2)', () => {
    it('warns on a non-session kind and stays valid', () => {
      const res = validateTaskInput(node({ kind: 'route' }));
      expect(res.valid).toBe(true);
      expect(res.warnings.some((w) => w.path === 'nodes.a.kind' && w.message.includes('kind "route"'))).toBe(true);
    });

    it('warns on runner: orchestrate', () => {
      const res = validateTaskInput({ ...CHAIN, runner: 'orchestrate' });
      expect(res.valid).toBe(true);
      expect(res.warnings.map((w) => w.path)).toEqual(['runner']);
    });

    it('warns on summarize: true and not on summarize: false', () => {
      const on = validateTaskInput(node({ inputs: { ctx: { from: 'x', summarize: true } } }));
      expect(on.valid).toBe(true);
      expect(on.warnings.some((w) => w.path === 'nodes.a.inputs.ctx' && w.message.includes('summarize: true'))).toBe(true);
      const off = validateTaskInput(node({ inputs: { ctx: { from: 'x', summarize: false } } }));
      expect(off.warnings).toHaveLength(0);
    });

    it('a session-kind conduct task with plain inputs warns about nothing (control)', () => {
      const res = validateTaskInput({ ...CHAIN, runner: 'conduct', nodes: [{ id: 'a', kind: 'session', prompt: 'p', inputs: { ctx: 'x' } }] });
      expect(res.warnings).toHaveLength(0);
    });
  });

  describe('model lookup knows the gateway aliases', () => {
    it('does not warn on a gateway alias, any case', () => {
      for (const model of ['coder', 'fast', 'CODER']) {
        expect(validateTaskInput(node({ model })).warnings).toHaveLength(0);
      }
      expect(isKnownTaskModel('coder')).toBe(true);
    });

    it('still warns on an unknown id (the upstream arm)', () => {
      expect(isKnownTaskModel('gpt-imaginary-9')).toBe(false);
      expect(validateTaskInput(node({ model: 'gpt-imaginary-9' })).warnings).toHaveLength(1);
    });

    it('the alias set is exactly what the gateway resolvers match', () => {
      const models: ModelDefinition[] = GATEWAY_MODEL_ALIASES.map((alias) => ({
        id: `id-${alias}`, name: alias, shortName: alias, description: '', provider: 'pi', contextWindow: 1,
      }));
      const resolved = [resolveGatewayCoderModelId({ models }), resolveGatewayFastModelId({ models })];
      expect(resolved.sort()).toEqual(GATEWAY_MODEL_ALIASES.map((a) => `id-${a}`).sort());
    });
  });

  it('run-started carries the run params through the log', () => {
    const root = mkdtempSync(join(tmpdir(), 'tasks-params-'));
    try {
      const entry: RunLogEntry = { t: '2026-10-02T00:00:00.000Z', kind: 'run-started', taskId: 'demo', runId: 'r1', params: { env: 'prod' } };
      appendRunLog(root, 'demo', 'r1', entry);
      expect(readRunLog(root, 'demo', 'r1')).toEqual([entry]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
