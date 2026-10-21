/**
 * UA8.1 — `runApprovedScript`, the only way a script action runs (spec §15; plan UA8.1 Tests).
 *
 * Adapted from craft-agents-oss v0.13.4:packages/shared/src/automations/script-executor.test.ts (Apache-2.0): the
 * containment, execution, timeout, abort, page-refresh and history cases, now through the approval ledger. Ours adds
 * the arms the plan names — an unapproved / changed / re-bound script refused, the swap between hash and spawn,
 * SIGKILL after a trapped SIGTERM, the four Nessy secrets absent from the child, the managed policy, and a guard
 * that nothing imports a raw executor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import * as executor from './script-executor.ts';
import {
  runApprovedScript,
  clampScriptTimeout,
  createScriptHistoryEntry,
  scriptApprovalRecord,
  scriptApprovalSubject,
  scriptSha256,
  DEFAULT_SCRIPT_TIMEOUT_MS,
  MAX_SCRIPT_TIMEOUT_MS,
  SCRIPT_APPROVAL_KIND,
  type ApprovedScriptRequest,
} from './script-executor.ts';
import { buildBaseScriptEnv, buildScriptEnv, SCRIPT_ENV_PLATFORM_ESSENTIALS } from './utils.ts';
import { loadPageConfig, savePageConfig } from '../pages/storage.ts';
import { HOST_APPROVALS_FILE, recordHostApproval, type HostApprovalsKeyProvider } from '../approvals/host-approvals.ts';
import {
  describeManagedLocalAutomationRefusal,
  recordCodexLocalAutomationRequirement,
  resetManagedLocalAutomationForTests,
} from '../config/managed-local-automation.ts';
import type { ScriptAction } from './types.ts';

const IS_WINDOWS = process.platform === 'win32';
const KEY = randomBytes(32);
const keyProvider: HostApprovalsKeyProvider = { getKey: async () => KEY };

describe('runApprovedScript (UA8.1)', () => {
  let workspaceDir: string;
  let audits: Array<{ event: string; payload: Record<string, unknown> }>;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'script-executor-test-'));
    audits = [];
    resetManagedLocalAutomationForTests();
  });

  afterEach(() => {
    resetManagedLocalAutomationForTests();
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function action(overrides: Partial<ScriptAction> & Pick<ScriptAction, 'script'>): ScriptAction {
    return { type: 'script', runtime: 'bun', ...overrides };
  }

  function writeScript(rel: string, source: string): void {
    mkdirSync(join(workspaceDir, rel, '..'), { recursive: true });
    writeFileSync(join(workspaceDir, rel), source);
  }

  /** Record the approval the UI would record (UA8.3) for the CURRENT bytes of `a.script`. */
  function approve(a: ScriptAction, bytes?: Buffer): void {
    const sha = scriptSha256(bytes ?? readFileSync(join(workspaceDir, a.script)));
    recordHostApproval(workspaceDir, KEY, {
      kind: SCRIPT_APPROVAL_KIND,
      subject: scriptApprovalSubject(a),
      ...scriptApprovalRecord(a, sha),
    });
  }

  function run(a: ScriptAction, extra: Partial<ApprovedScriptRequest> = {}) {
    return runApprovedScript({
      action: a,
      workspaceRootPath: workspaceDir,
      env: buildBaseScriptEnv({ workspaceRootPath: workspaceDir, page: a.page }),
      trigger: 'automation',
      keyProvider,
      audit: (event, payload) => { audits.push({ event, payload }); },
      ...extra,
    });
  }

  describe('positive', () => {
    it('an approved, contained script runs, and the audit names its digest but never its output', async () => {
      writeScript('ok.ts', 'console.log("hello from script")');
      const a = action({ script: 'ok.ts' });
      approve(a);
      const result = await run(a);
      expect(result.blocked).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello from script');
      expect(audits.map(entry => entry.event)).toEqual(['automation_script_ran']);
      expect(audits[0]!.payload.sha256).toBe(scriptSha256(readFileSync(join(workspaceDir, 'ok.ts'))));
      expect(JSON.stringify(audits)).not.toContain('hello from script');
    });

    it('NESSY_PAGE_DATA_DIR is present for a page, and the outcome is recorded on page.json last', async () => {
      mkdirSync(join(workspaceDir, 'pages', 'dash'), { recursive: true });
      savePageConfig(workspaceDir, {
        schemaVersion: 1,
        id: 'page_test0001',
        slug: 'dash',
        name: 'Dash',
        kind: 'interactive',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      writeScript('refresh.ts', 'console.log(JSON.stringify({ data: process.env.NESSY_PAGE_DATA_DIR ?? null, slug: process.env.NESSY_PAGE_SLUG ?? null }))');
      const a = action({ script: 'refresh.ts', page: 'dash' });
      approve(a);
      const result = await run(a, {
        env: buildScriptEnv('SchedulerTick', { workspaceId: 'ws', timestamp: 1 } as never, { workspaceRootPath: workspaceDir, page: 'dash' }),
      });
      expect(result.success).toBe(true);
      expect(JSON.parse(result.stdout)).toEqual({ data: join(workspaceDir, 'pages', 'dash', 'data'), slug: 'dash' });
      expect(loadPageConfig(workspaceDir, 'dash')?.lastRefresh?.ok).toBe(true);
    });

    it('passes argv and runs with the workspace root as cwd (upstream)', async () => {
      writeScript('scripts/argv.ts', 'console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))');
      const a = action({ script: 'scripts/argv.ts', args: ['--flag', 'value'] });
      approve(a);
      const result = await run(a);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.stdout) as { argv: string[]; cwd: string };
      expect(parsed.argv).toEqual(['--flag', 'value']);
      expect(relative(parsed.cwd, workspaceDir) === '' || parsed.cwd.endsWith(workspaceDir)).toBe(true);
    });
  });

  describe('negative — containment (upstream)', () => {
    it('blocks absolute script paths', async () => {
      const result = await run(action({ script: IS_WINDOWS ? 'C:\\evil.ts' : '/tmp/evil.ts' }));
      expect(result.blocked).toBe(true);
      expect(result.stderr).toContain('relative');
    });

    it('blocks paths escaping the workspace via ..', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'script-executor-escape-'));
      try {
        writeFileSync(join(outsideDir, 'outside.ts'), 'console.log("outside")');
        const escapePath = join('..', relative(tmpdir(), outsideDir), 'outside.ts');
        const result = await run(action({ script: escapePath }));
        expect(result.blocked).toBe(true);
        expect(result.stderr).toContain('escapes the workspace');
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it.skipIf(IS_WINDOWS)('a symlink escape is blocked even when its target bytes are approved', async () => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'script-executor-outside-'));
      try {
        const marker = join(outsideDir, 'ran');
        writeFileSync(join(outsideDir, 'target.ts'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
        symlinkSync(join(outsideDir, 'target.ts'), join(workspaceDir, 'link.ts'));
        const a = action({ script: 'link.ts' });
        approve(a, readFileSync(join(outsideDir, 'target.ts')));
        const result = await run(a);
        expect(result.blocked).toBe(true);
        expect(result.stderr).toContain('escapes the workspace');
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('blocks missing scripts', async () => {
      const result = await run(action({ script: 'nope.ts' }));
      expect(result.blocked).toBe(true);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('negative — approval', () => {
    it('an unapproved script is refused and never runs', async () => {
      writeScript('unapproved.ts', `require('node:fs').writeFileSync(${JSON.stringify(join(workspaceDir, 'ran'))}, 'x')`);
      const result = await run(action({ script: 'unapproved.ts' }));
      expect(result.blocked).toBe(true);
      expect(result.stderr).toContain('not approved');
      expect(existsSync(join(workspaceDir, 'ran'))).toBe(false);
      expect(audits.map(entry => entry.event)).toEqual(['automation_script_refused']);
    });

    it('a changed digest does not run, from Test either', async () => {
      writeScript('edit.ts', 'console.log("v1")');
      const a = action({ script: 'edit.ts' });
      approve(a);
      writeScript('edit.ts', `require('node:fs').writeFileSync(${JSON.stringify(join(workspaceDir, 'ran'))}, 'x'); console.log("v2")`);
      for (const trigger of ['automation', 'test'] as const) {
        const result = await run(a, { trigger });
        expect(result.blocked).toBe(true);
        expect(result.stderr).toContain('changed since it was approved');
      }
      expect(existsSync(join(workspaceDir, 'ran'))).toBe(false);
      expect(audits.map(entry => entry.payload.trigger)).toEqual(['automation', 'test']);
    });

    it('an approval for other arguments or another runtime does not cover the run', async () => {
      writeScript('bound.ts', 'console.log("bound")');
      const approved = action({ script: 'bound.ts', args: ['a'] });
      approve(approved);
      // Same subject (a forged binding inside a host-signed entry is impossible; this is the honest "re-bound" case):
      // the host recorded args ['a'] under the subject of args ['b'] — the binding check still refuses.
      recordHostApproval(workspaceDir, KEY, {
        kind: SCRIPT_APPROVAL_KIND,
        subject: scriptApprovalSubject(action({ script: 'bound.ts', args: ['b'] })),
        ...scriptApprovalRecord(approved, scriptSha256(readFileSync(join(workspaceDir, 'bound.ts')))),
      });
      const otherArgs = await run(action({ script: 'bound.ts', args: ['b'] }));
      expect(otherArgs.blocked).toBe(true);
      expect(otherArgs.stderr).toContain('does not match');
      const otherRuntime = await run(action({ script: 'bound.ts', args: ['a'], runtime: 'node' }));
      expect(otherRuntime.blocked).toBe(true);
      expect(otherRuntime.stderr).toContain('not approved');
    });

    it('a ledger entry edited on disk is not an approval (control: the same entry unedited runs)', async () => {
      writeScript('forged.ts', 'console.log("forged")');
      const a = action({ script: 'forged.ts' });
      approve(a);
      const control = await run(a);
      expect(control.success).toBe(true);
      const ledgerPath = join(workspaceDir, HOST_APPROVALS_FILE);
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { entries: Array<{ createdAt: string }> };
      ledger.entries[0]!.createdAt = '2000-01-01T00:00:00.000Z';
      writeFileSync(ledgerPath, JSON.stringify(ledger));
      const result = await run(a);
      expect(result.blocked).toBe(true);
      expect(result.stderr).toContain('not approved');
    });

    it('a ledger key the host cannot load refuses every run (the closed failure)', async () => {
      writeScript('nokey.ts', 'console.log("x")');
      const a = action({ script: 'nokey.ts' });
      approve(a);
      const result = await run(a, { keyProvider: { getKey: async () => { throw new Error('sealed key unavailable'); } } });
      expect(result.blocked).toBe(true);
      expect(result.stderr).toContain('host-approvals key is unavailable');
    });
  });

  describe('negative — the swap window', () => {
    it('a script replaced between the hash and the spawn runs the approved bytes, never the replacement', async () => {
      const marker = join(workspaceDir, 'replacement-ran');
      writeScript('swap.ts', 'console.log("approved bytes")');
      const a = action({ script: 'swap.ts' });
      approve(a);
      const result = await run(a, {
        testSeams: {
          afterVerify: (scriptPath) => {
            writeFileSync(scriptPath, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); console.log("replacement")`);
          },
        },
      });
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('approved bytes');
      expect(existsSync(marker)).toBe(false);
      // Control: the replacement is really on disk, and it is refused on the next run.
      const next = await run(a);
      expect(next.blocked).toBe(true);
      expect(next.stderr).toContain('changed since it was approved');
    });
  });

  describe('negative — time limits', () => {
    it.skipIf(IS_WINDOWS)('a timeout ends in SIGKILL when the script traps SIGTERM', async () => {
      writeScript('trap.ts', 'process.on("SIGTERM", () => { console.log("trapped") }); setInterval(() => {}, 1000)');
      const a = action({ script: 'trap.ts', timeoutMs: 1_000 });
      approve(a);
      const result = await run(a, { testSeams: { killGraceMs: 300 } });
      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain('Timed out after 1000ms (SIGKILL)');
    }, 15_000);

    it('kills a running script when the abort signal fires (upstream)', async () => {
      writeScript('hang.ts', 'await new Promise(() => {})');
      const a = action({ script: 'hang.ts', timeoutMs: 30_000 });
      approve(a);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const result = await run(a, { signal: controller.signal });
      expect(result.success).toBe(false);
      expect(result.timedOut).toBeUndefined();
      expect(result.stderr).toContain('Aborted');
    }, 15_000);
  });

  describe('negative — the environment is an allowlist', () => {
    const SECRETS = ['NESSY_DP_AUTH_TOKEN', 'NESSY_CLI_DP_AUTH_TOKEN', 'NESSY_SERVER_TOKEN', 'NESSY_WH_API_TOKEN'] as const;

    it('with the four Nessy secrets set in the parent, none reaches a spawned child', async () => {
      const saved = new Map<string, string | undefined>(SECRETS.map(name => [name, process.env[name]]));
      for (const name of SECRETS) {
        // Bun 1.3.14: delete, then assign (AGENTS.md process.env trap).
        delete process.env[name];
        process.env[name] = ['fake', name.toLowerCase(), 'value'].join('-');
      }
      try {
        // Control: the parent really carries them.
        for (const name of SECRETS) expect(process.env[name]).toBe(['fake', name.toLowerCase(), 'value'].join('-'));
        writeScript('env.ts', `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(SECRETS)}.map(k => [k, process.env[k] ?? null]))))`);
        const a = action({ script: 'env.ts' });
        approve(a);
        const env = buildScriptEnv('LabelAdd', { workspaceId: 'ws', timestamp: 1, sessionId: 's1', label: 'x' } as never, { workspaceRootPath: workspaceDir });
        const result = await run(a, { env });
        expect(result.success).toBe(true);
        expect(JSON.parse(result.stdout)).toEqual(Object.fromEntries(SECRETS.map(name => [name, null])));
        for (const name of SECRETS) expect(env[name]).toBeUndefined();
      } finally {
        for (const [name, value] of saved) {
          delete process.env[name];
          if (value !== undefined) process.env[name] = value;
        }
      }
    });

    it('every key is a platform essential or a named NESSY_ context key; no PATH, no prefix pass-through', () => {
      delete process.env.NESSY_UA81_PASSTHROUGH_PROBE;
      process.env.NESSY_UA81_PASSTHROUGH_PROBE = 'should-not-pass';
      try {
        const env = buildScriptEnv(
          'SchedulerTick',
          { workspaceId: 'ws', timestamp: 123, localTime: '10:00', utcTime: 't' } as never,
          { workspaceRootPath: workspaceDir, page: 'dash' },
        );
        expect(env.NESSY_UA81_PASSTHROUGH_PROBE).toBeUndefined();
        expect(env.PATH).toBeUndefined();
        expect(env.NESSY_EVENT).toBe('SchedulerTick');
        expect(env.NESSY_WORKSPACE_PATH).toBe(workspaceDir);
        expect(env.NESSY_PAGE_DIR).toBe(join(workspaceDir, 'pages', 'dash'));
        const essentials = new Set(SCRIPT_ENV_PLATFORM_ESSENTIALS);
        const named = new Set([
          'NESSY_EVENT', 'NESSY_EVENT_DATA', 'NESSY_WORKSPACE_ID', 'NESSY_LOCAL_TIME', 'NESSY_LOCAL_DATE',
          'NESSY_LOCAL_TIME', 'NESSY_UTC_TIME', 'NESSY_WORKSPACE_PATH', 'NESSY_PAGE_SLUG', 'NESSY_PAGE_DIR', 'NESSY_PAGE_DATA_DIR',
        ]);
        for (const key of Object.keys(env)) expect(essentials.has(key) || named.has(key)).toBe(true);
      } finally {
        delete process.env.NESSY_UA81_PASSTHROUGH_PROBE;
      }
    });
  });

  describe('negative — the managed local-automation policy', () => {
    it('managed-disabled refuses by name, before anything is read; off again, the same script runs', async () => {
      writeScript('managed.ts', 'console.log("ran")');
      const a = action({ script: 'managed.ts' });
      approve(a);
      recordCodexLocalAutomationRequirement(true);
      const refused = await run(a);
      expect(refused.blocked).toBe(true);
      expect(refused.stderr).toBe(describeManagedLocalAutomationRefusal());
      recordCodexLocalAutomationRequirement(undefined);
      const control = await run(a);
      expect(control.success).toBe(true);
    });
  });

  describe('guard — the only executing entry', () => {
    it('the module exports runApprovedScript and non-executing helpers only', () => {
      const functions = Object.entries(executor).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort();
      expect(functions).toEqual([
        'clampScriptTimeout',
        'createScriptHistoryEntry',
        'runApprovedScript',
        'scriptApprovalBinding',
        'scriptApprovalRecord',
        'scriptApprovalSubject',
        'scriptSha256',
      ]);
      const source = readFileSync(new URL('./script-executor.ts', import.meta.url), 'utf-8');
      expect(source.match(/\bspawn\(/g)?.length).toBe(1);
      expect(source).not.toMatch(/export\s+(async\s+)?function\s+spawnScript/);
    });

    it('no source file imports or defines a raw executor (upstream name assembled at runtime)', () => {
      const needle = ['execute', 'Script', 'Action'].join('');
      const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
      const grep = Bun.spawnSync(['git', 'grep', '--untracked', '-l', '-e', needle, '--', 'packages', 'apps', 'scripts'], { cwd: repoRoot });
      const hits = new TextDecoder().decode(grep.stdout).split('\n').filter(Boolean);
      // Positive control on the same instrument and scope: a needle we know exists is found.
      const control = Bun.spawnSync(['git', 'grep', '--untracked', '-l', '-e', ['run', 'Approved', 'Script'].join(''), '--', 'packages', 'apps', 'scripts'], { cwd: repoRoot });
      expect(new TextDecoder().decode(control.stdout)).toContain('packages/shared/src/automations/script-executor.ts');
      expect(hits).toEqual([]);
    });
  });

  describe('helpers (upstream)', () => {
    it('clampScriptTimeout defaults and clamps', () => {
      expect(clampScriptTimeout(undefined)).toBe(DEFAULT_SCRIPT_TIMEOUT_MS);
      expect(clampScriptTimeout(1)).toBe(1_000);
      expect(clampScriptTimeout(999_999_999)).toBe(MAX_SCRIPT_TIMEOUT_MS);
      expect(clampScriptTimeout(5_000)).toBe(5_000);
    });

    it('createScriptHistoryEntry builds the automations-history shape with error capping', () => {
      const entry = createScriptHistoryEntry({
        matcherId: 'abc123',
        result: { type: 'script', script: 'x.ts', success: false, exitCode: 1, blocked: true, stdout: '', stderr: 'e'.repeat(5000), durationMs: 42, page: 'dash' },
      });
      expect(entry.id).toBe('abc123');
      expect(entry.ok).toBe(false);
      const script = entry.script as Record<string, unknown>;
      expect(script.script).toBe('x.ts');
      expect(script.blocked).toBe(true);
      expect((script.error as string).length).toBeLessThanOrEqual(2000);
    });
  });
});
