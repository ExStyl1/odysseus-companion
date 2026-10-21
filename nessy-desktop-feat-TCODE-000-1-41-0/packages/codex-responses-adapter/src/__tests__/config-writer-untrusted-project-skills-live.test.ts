/**
 * F1.845 (WJ-crit-jjj, 2026-09-25) — codex loads a RESTRICTED project's skills. A PIN of a
 * measured residue, not a fix: codex has no switch that keeps project skill roots out.
 *
 * SOURCE (github.com/openai/codex at rust-v0.156.1, the tag `codex-protocol/manifest.json` pins;
 * read only — strong tier):
 *
 * - `codex-rs/ext/skills/src/host_roots.rs` `roots_from_layer_stack` walks
 *   `config_layer_stack.all_layers_high_to_low()`, which `codex-rs/config/src/state.rs` documents
 *   as "including disabled layers", and turns every `Project` layer's folder into a `.codex/skills`
 *   root of scope `Repo`. An untrusted project's layer is loaded DISABLED, so its skills root stays.
 * - `repo_agents_skill_roots` probes `.agents/skills` in every directory from the project root down
 *   to the cwd with no trust check at all.
 * - The only skill keys in `codex-rs/config/src/skills_config.rs` are `skills.bundled.enabled` (the
 *   system skills), `skills.include_instructions` (the whole catalog), `skills.max_context_tokens`
 *   and `skills.config` — per-skill `{ path | name, enabled }` rules read from the User and
 *   SessionFlags layers only. No key excludes a ROOT or a scope.
 * - The binary says so itself: at thread start it logs "Project-local config, hooks, and exec
 *   policies are disabled in the following folders until the project is trusted, but skills
 *   still load."
 *
 * MEASURED on the shipped 0.156.1 (rig `work/wjcritjjj/f1845-probe.ts`, config from the product's
 * `writeCodexConfig` + `codexProjectTrustOptionsFor`, the F1.723 security layer on `thread/start`,
 * a stub Responses upstream): a project kept restricted gets its `.codex/skills/<x>` and every
 * `.agents/skills/<y>` from the project root to the cwd listed `enabled: true`, their descriptions
 * in the model's available-skills catalog on the first turn, and a `$name` mention injects the
 * SKILL.md body; a trusted project is identical; a project with no skills lists none. A per-path
 * `[[skills.config]] enabled = false` — in the user layer this host writes, or in the request
 * `config` map — takes each one out of the listing, the catalog and the mention.
 *
 * So this file pins, on the shipped binary: (1) the residue the 1.41.0 KNOWN sentence states,
 * against its two controls, and (2) the native per-path mechanism a follow-up fix would configure.
 * If (1) goes red after a codex lift, codex has started gating project skills on trust: re-read the
 * KNOWN sentence and the working-directory page and retire them.
 *
 * (3) THE FIX (F1.845, WJ-crit-lll): the product now does exactly what the third case below does —
 * codex's own `skills/list { cwds: [cwd], forceReload: true }` before the open, then one
 * `{ path, enabled: false }` per `scope: 'repo'` skill in the `thread/start` request `config` map
 * (`CodexAgent.refreshCodexRestrictedRepoSkills` + `codexRestrictedRepoSkillsOff` in
 * `packages/shared/src/agent/codex-agent.ts`; the request shape is pinned there by
 * `codex-restricted-project-skills-off.test.ts`). The filter is restated here rather than imported,
 * because this package must not import the agent. The case proves, on the shipped binary, that the
 * map keeps both project skills out of the first turn's catalog and a `$name` mention, while the
 * user's own skill still reaches the catalog (the positive control on the same instrument) — and it
 * pins the residue that codex's process-level `skills/list`, which reads no thread's `SessionFlags`
 * layer, still reports the two `enabled: true`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexConfigToml } from '../config-writer.ts';
import { AppServer } from './app-server-rig.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const BIN = join(
  REPO_ROOT, 'apps', 'electron', 'resources', 'bin', 'codex',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
);
const HAVE_BIN = existsSync(BIN);
/** A ~185 MB binary booted four times; generous because lanes share this machine. */
const BUDGET_MS = 240_000;

interface ListedSkill { name: string; scope: string; enabled: boolean; path: string }

describe.if(HAVE_BIN)('F1.845 · the shipped codex-app-server and a restricted project\'s skills', () => {
  const ROOT = HAVE_BIN ? realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1845-live-'))) : '';
  afterAll(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

  function skill(dir: string, name: string): string {
    mkdirSync(join(dir, name), { recursive: true });
    const file = join(dir, name, 'SKILL.md');
    writeFileSync(file, `---\nname: ${name}\ndescription: F1845 probe skill ${name}\n---\n\n# ${name}\n`);
    return file;
  }

  /** One project, one codex home written by the product's writer, one `skills/list`. */
  async function listRepoSkills(
    name: string,
    opts: { trusted: boolean; skills: boolean; extraToml?: (project: string) => string },
  ): Promise<{ skills: ListedSkill[]; files: string[] }> {
    const project = join(ROOT, name, 'proj');
    const home = join(ROOT, name, 'codex-home');
    // HOME is NOT the project, so a project `.agents/skills` is never also the user-level one.
    const userHome = join(ROOT, name, 'home');
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(home, { recursive: true });
    mkdirSync(userHome, { recursive: true });
    const files = opts.skills
      ? [skill(join(project, '.codex', 'skills'), 'f1845codex'), skill(join(project, '.agents', 'skills'), 'f1845agents')]
      : [];
    // The F1.750 entry exactly as the host writes it: the realpath, `untrusted` unless trusted.
    writeFileSync(join(home, 'config.toml'), buildCodexConfigToml({
      codexHome: home, model: 'tgpt/deepseek-v4-flash-0731', adapterPort: 1,
      projectRoot: project, projectTrusted: opts.trusted,
    }));
    if (opts.extraToml) appendFileSync(join(home, 'config.toml'), `\n${opts.extraToml(project)}\n`);
    const child = spawn(BIN, [], {
      cwd: project,
      env: { ...process.env, HOME: userHome, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const server = new AppServer(child);
    try {
      await server.request('initialize', {
        clientInfo: { name: 'nessy-f1845', title: null, version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      server.notify('initialized');
      const answer = await server.request('skills/list', { cwds: [project], forceReload: true }) as {
        data: Array<{ cwd: string; skills: ListedSkill[] }>;
      };
      const skills = answer.data.flatMap(entry => entry.skills)
        .filter(s => s.scope === 'repo')
        .map(s => ({ name: s.name, scope: s.scope, enabled: s.enabled, path: s.path }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { skills, files };
    } finally {
      server.kill();
    }
  }

  test('RESIDUE: a project kept restricted still has its .codex/skills and .agents/skills listed enabled — as a trusted one does; a project with none lists none', async () => {
    const restricted = await listRepoSkills('restricted', { trusted: false, skills: true });
    expect(restricted.skills.map(s => [s.name, s.enabled])).toEqual([['f1845agents', true], ['f1845codex', true]]);
    expect(restricted.skills.map(s => s.path).sort()).toEqual([...restricted.files].sort());
    // CONTROL 1: the trusted twin lists the same two, so trust is not what decides it.
    const trusted = await listRepoSkills('trusted', { trusted: true, skills: true });
    expect(trusted.skills.map(s => [s.name, s.enabled])).toEqual([['f1845agents', true], ['f1845codex', true]]);
    // CONTROL 2: the instrument reads the project — a restricted project with no skills lists none.
    const none = await listRepoSkills('none', { trusted: false, skills: false });
    expect(none.skills).toEqual([]);
  }, BUDGET_MS);

  test('NATIVE MECHANISM: codex\'s own per-path [[skills.config]] enabled = false, in the user layer this host writes, disables both', async () => {
    const off = await listRepoSkills('restricted-off', {
      trusted: false,
      skills: true,
      extraToml: project => [
        '[[skills.config]]', `path = ${JSON.stringify(join(project, '.codex', 'skills', 'f1845codex', 'SKILL.md'))}`, 'enabled = false', '',
        '[[skills.config]]', `path = ${JSON.stringify(join(project, '.agents', 'skills', 'f1845agents', 'SKILL.md'))}`, 'enabled = false',
      ].join('\n'),
    });
    expect(off.skills.map(s => [s.name, s.enabled])).toEqual([['f1845agents', false], ['f1845codex', false]]);
  }, BUDGET_MS);

  test('THE FIX: codex\'s own list, repo scope → enabled = false in the thread/start config map — no project skill reaches the catalog or a mention; the user\'s own still does', async () => {
    const SENT = { f1845codex: 'SENTINEL-F1845-FIX-CODEX', f1845agents: 'SENTINEL-F1845-FIX-AGENTS', f1845mine: 'SENTINEL-F1845-FIX-USER' } as const;
    const bodies: string[] = [];
    const stub = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (req.method !== 'POST' || !(req.url ?? '').replace(/\?.*$/, '').endsWith('/responses')) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{"error":"stub"}');
          return;
        }
        bodies.push(body);
        const id = `resp_${bodies.length}`;
        const msg = { type: 'message', id: `msg_${id}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
        const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sse('response.created', { type: 'response.created', response: { id, object: 'response', status: 'in_progress', model: 'm', output: [] } }));
        res.write(sse('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...msg, status: 'in_progress', content: [] } }));
        res.write(sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: msg.id, output_index: 0, content_index: 0, delta: 'done' }));
        res.write(sse('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: msg }));
        res.end(sse('response.completed', { type: 'response.completed', response: { id, object: 'response', status: 'completed', model: 'm', output: [msg], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }));
      });
    });
    await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', () => resolve()));
    const port = (stub.address() as AddressInfo).port;
    const project = join(ROOT, 'fix', 'proj');
    const home = join(ROOT, 'fix', 'codex-home');
    const userHome = join(ROOT, 'fix', 'home');
    mkdirSync(join(project, '.git'), { recursive: true });
    writeFileSync(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(home, { recursive: true });
    const withSentinel = (dir: string, name: keyof typeof SENT): void => {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${SENT[name]} use this skill for the F1845 probe\n---\n\n# ${name}\n\nBody ${SENT[name]}-BODY\n`);
    };
    withSentinel(join(project, '.codex', 'skills'), 'f1845codex');
    withSentinel(join(project, '.agents', 'skills'), 'f1845agents');
    withSentinel(join(userHome, '.agents', 'skills'), 'f1845mine');
    writeFileSync(join(home, 'config.toml'), buildCodexConfigToml({
      codexHome: home, model: 'tgpt/deepseek-v4-flash-0731', adapterPort: port,
      projectRoot: project, projectTrusted: false,
    }));
    const child = spawn(BIN, [], {
      cwd: project,
      env: { ...process.env, HOME: userHome, CODEX_HOME: home, COMPANY_LLM_API_KEY: 'loopback' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const server = new AppServer(child);
    try {
      await server.request('initialize', {
        clientInfo: { name: 'nessy-f1845-fix', title: null, version: '0.0.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      server.notify('initialized');
      type Listed = { data: Array<{ skills: ListedSkill[] }> };
      const before = await server.request('skills/list', { cwds: [project], forceReload: true }) as Listed;
      // The product's filter, restated: codex's own scope decides, codex's own path is handed back.
      const disable = before.data.flatMap(entry => entry.skills).filter(s => s.scope === 'repo').map(s => ({ path: s.path, enabled: false }));
      expect(disable.map(d => d.path).sort()).toEqual([
        join(project, '.agents', 'skills', 'f1845agents', 'SKILL.md'),
        join(project, '.codex', 'skills', 'f1845codex', 'SKILL.md'),
      ].sort());
      const started = await server.request('thread/start', {
        cwd: project, model: 'tgpt/deepseek-v4-flash-0731', config: { skills: { config: disable } },
      }) as { thread?: { id?: string } };
      const threadId = String(started.thread?.id);
      const turn = async (text: string): Promise<void> => {
        const seen = server.notifications.length;
        await server.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
        expect(await server.waitFor((n) => n.method === 'turn/completed' || n.method === 'turn/failed', 120_000)).toBe(true);
        expect(server.notifications.slice(seen).some(n => n.method === 'turn/failed')).toBe(false);
      };
      await turn('hello F1845 fix probe');
      const catalog = bodies.join('\n');
      // POSITIVE CONTROL on the same instrument: the user's own skill is in the model's catalog.
      expect(catalog).toContain(SENT.f1845mine);
      expect(catalog).not.toContain(SENT.f1845codex);
      expect(catalog).not.toContain(SENT.f1845agents);
      await turn('please use $f1845codex and $f1845agents now');
      const all = bodies.join('\n');
      expect(all).not.toContain(`${SENT.f1845codex}-BODY`);
      expect(all).not.toContain(`${SENT.f1845agents}-BODY`);
      // RESIDUE: the process-level list reads no thread's SessionFlags layer, so it still says enabled.
      const after = await server.request('skills/list', { cwds: [project], forceReload: true }) as Listed;
      expect(after.data.flatMap(entry => entry.skills).filter(s => s.scope === 'repo').map(s => [s.name, s.enabled]).sort())
        .toEqual([['f1845agents', true], ['f1845codex', true]]);
    } finally {
      server.kill();
      stub.close();
    }
  }, BUDGET_MS);
});
