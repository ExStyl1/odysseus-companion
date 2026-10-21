import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES_ROOT = join(import.meta.dir, 'fixtures');
const FORMAT_ADAPTERS_ROOT = join(FIXTURES_ROOT, 'format-adapters');
const CATALOG_ADAPTERS_ROOT = join(FIXTURES_ROOT, 'catalog-adapters');

const SOURCE_URLS = [
  'https://learn.chatgpt.com/docs/build-plugins',
  'https://help.openai.com/en/articles/20001256-plugins-in-codex/',
  'https://code.claude.com/docs/en/plugins-reference',
  'https://code.claude.com/docs/en/agent-sdk/plugins',
  'https://skills-market.t-tech.team/api',
];

const ABSOLUTE_HOME_PATTERNS: RegExp[] = [
  /\/Users\//,
  /\/home\//,
  /C:\\\\/,
  /(^|[^A-Za-z0-9._-])~\//,
];

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9]/,
  /Bearer [A-Za-z0-9._-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  // JWT-shaped triple: three base64url segments of realistic header/payload/signature
  // length, not e.g. a "1.0.0" semver string.
  /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

const KNOWN_FORMATS = new Set(['codex', 'claude', 'nessy', 'unknown']);
const KNOWN_STATES = new Set(['supported', 'partial', 'blocked']);

/** Recursively collects every regular file path under `root`. */
function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const stat = statSync(current);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) {
        stack.push(join(current, entry));
      }
      continue;
    }
    out.push(current);
  }
  return out;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Recursively collects every string value found anywhere in a parsed JSON value. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
  } else if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) collectStrings(entry, out);
  }
  return out;
}

/** Heuristic: does this string look like a bundle-relative filesystem path? */
function looksLikePath(value: string): boolean {
  if (!value.includes('/') && !value.includes('\\')) return false;
  if (/^https?:\/\//.test(value)) return false;
  return true;
}

function isAbsoluteLikePath(value: string): boolean {
  if (value.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  return false;
}

describe('format-adapter and catalog-adapter fixtures', () => {
  describe('SOURCE.md', () => {
    const sourcePath = join(FORMAT_ADAPTERS_ROOT, 'SOURCE.md');

    it('exists and is non-empty', () => {
      expect(existsSync(sourcePath)).toBe(true);
      const content = readFileSync(sourcePath, 'utf-8');
      expect(content.trim().length).toBeGreaterThan(0);
    });

    it('names every documented source URL', () => {
      const content = readFileSync(sourcePath, 'utf-8');
      for (const url of SOURCE_URLS) {
        expect(content).toContain(url);
      }
    });

    it('states fixtures are authored, not copied, with no secrets and no absolute user paths', () => {
      const content = readFileSync(sourcePath, 'utf-8').toLowerCase();
      expect(content).toMatch(/authored/);
      expect(content).toMatch(/copied from any real/);
      expect(content).toMatch(/no secrets/);
      expect(content).toMatch(/no absolute/);
    });
  });

  describe('required fixture layouts', () => {
    it('codex-core has the manifest, skill, hooks file, and referenced scripts', () => {
      const root = join(FORMAT_ADAPTERS_ROOT, 'codex-core');
      expect(existsSync(join(root, '.codex-plugin', 'plugin.json'))).toBe(true);
      expect(existsSync(join(root, 'skills', 'hello-skill', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(root, 'hooks', 'hooks.json'))).toBe(true);
      expect(existsSync(join(root, 'scripts', 'hook.js'))).toBe(true);
      expect(existsSync(join(root, 'scripts', 'mcp-server.js'))).toBe(true);
      expect(existsSync(join(root, 'expected-inventory.json'))).toBe(true);
    });

    it('codex-deferred has the manifest with an apps entry plus the core skill', () => {
      const root = join(FORMAT_ADAPTERS_ROOT, 'codex-deferred');
      expect(existsSync(join(root, '.codex-plugin', 'plugin.json'))).toBe(true);
      expect(existsSync(join(root, 'skills', 'hello-skill', 'SKILL.md'))).toBe(true);
      const manifest = readJson(join(root, '.codex-plugin', 'plugin.json')) as Record<string, unknown>;
      expect(Array.isArray(manifest.apps)).toBe(true);
      expect((manifest.apps as unknown[]).length).toBeGreaterThan(0);
      expect(existsSync(join(root, 'expected-inventory.json'))).toBe(true);
    });

    it('claude-core has the optional manifest plus the default Claude directories', () => {
      const root = join(FORMAT_ADAPTERS_ROOT, 'claude-core');
      expect(existsSync(join(root, '.claude-plugin', 'plugin.json'))).toBe(true);
      expect(existsSync(join(root, 'skills', 'sample-skill', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(root, 'commands', 'sample-command.md'))).toBe(true);
      expect(existsSync(join(root, 'agents', 'sample-agent.md'))).toBe(true);
      expect(existsSync(join(root, 'hooks', 'hooks.json'))).toBe(true);
      expect(existsSync(join(root, '.mcp.json'))).toBe(true);
      expect(existsSync(join(root, 'expected-inventory.json'))).toBe(true);
    });

    it('claude-manifestless has NO .claude-plugin/plugin.json but has the default dirs', () => {
      const root = join(FORMAT_ADAPTERS_ROOT, 'claude-manifestless');
      expect(existsSync(join(root, '.claude-plugin', 'plugin.json'))).toBe(false);
      expect(existsSync(join(root, 'skills', 'sample-skill', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(root, 'commands', 'sample-command.md'))).toBe(true);
      expect(existsSync(join(root, 'agents', 'sample-agent.md'))).toBe(true);
      expect(existsSync(join(root, 'hooks', 'hooks.json'))).toBe(true);
      expect(existsSync(join(root, '.mcp.json'))).toBe(true);
      expect(existsSync(join(root, 'expected-inventory.json'))).toBe(true);
    });

    it('claude-deferred declares a non-command hook type and a plugin-shipped output style', () => {
      const root = join(FORMAT_ADAPTERS_ROOT, 'claude-deferred');
      expect(existsSync(join(root, 'skills', 'sample-skill', 'SKILL.md'))).toBe(true);
      const hooks = readJson(join(root, 'hooks', 'hooks.json')) as Record<string, unknown>;
      const hooksMap = hooks.hooks as Record<string, unknown[]>;
      const matcherGroup = hooksMap.UserPromptSubmit?.[0] as Record<string, unknown> | undefined;
      expect(matcherGroup).toBeDefined();
      const hookEntry = (matcherGroup!.hooks as Record<string, unknown>[])[0] as Record<string, unknown> | undefined;
      expect(hookEntry).toBeDefined();
      expect(hookEntry!.type).toBe('prompt');
      const manifest = readJson(join(root, '.claude-plugin', 'plugin.json')) as Record<string, unknown>;
      expect(Array.isArray(manifest.outputStyles)).toBe(true);
      expect(existsSync(join(root, 'output-styles', 'sample-style.md'))).toBe(true);
      expect(existsSync(join(root, 'expected-inventory.json'))).toBe(true);
    });

    it('catalog-adapters/codex has the marketplace file and its referenced local plugin', () => {
      const root = join(CATALOG_ADAPTERS_ROOT, 'codex');
      expect(existsSync(join(root, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
      expect(existsSync(join(root, 'local-plugins', 'sample-plugin', '.codex-plugin', 'plugin.json'))).toBe(true);
      expect(existsSync(join(root, 'expected-inventory.json'))).toBe(true);
    });

    it('catalog-adapters/claude has the marketplace file', () => {
      const root = join(CATALOG_ADAPTERS_ROOT, 'claude');
      expect(existsSync(join(root, '.claude-plugin', 'marketplace.json'))).toBe(true);
      expect(existsSync(join(root, 'expected-inventory.json'))).toBe(true);
    });

    it('catalog-adapters/nessy-internal has meta/skills/plugins catalog files', () => {
      const root = join(CATALOG_ADAPTERS_ROOT, 'nessy-internal');
      expect(existsSync(join(root, 'meta.json'))).toBe(true);
      expect(existsSync(join(root, 'skills.json'))).toBe(true);
      expect(existsSync(join(root, 'plugins.json'))).toBe(true);
      expect(existsSync(join(root, 'expected-inventory.json'))).toBe(true);
    });
  });

  describe('path portability', () => {
    const allFiles = [...walkFiles(FORMAT_ADAPTERS_ROOT), ...walkFiles(CATALOG_ADAPTERS_ROOT)];

    it('found fixture files to scan', () => {
      expect(allFiles.length).toBeGreaterThan(0);
    });

    it('no fixture file content contains an absolute user home path', () => {
      for (const file of allFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const pattern of ABSOLUTE_HOME_PATTERNS) {
          expect(pattern.test(content), `${file} matched forbidden pattern ${pattern}`).toBe(false);
        }
      }
    });

    it('every path-like string field in manifest/catalog JSON is relative', () => {
      const jsonFiles = allFiles.filter(file =>
        /(^|\/)(plugin|marketplace|hooks|meta|skills|plugins)\.json$/.test(file)
        || file.endsWith('.mcp.json'));
      expect(jsonFiles.length).toBeGreaterThan(0);
      for (const file of jsonFiles) {
        const parsed = readJson(file);
        const strings = collectStrings(parsed);
        for (const value of strings) {
          if (!looksLikePath(value)) continue;
          expect(isAbsoluteLikePath(value), `${file} contains absolute-like path "${value}"`).toBe(false);
        }
      }
    });
  });

  describe('no secrets or real hosts', () => {
    const allFiles = [...walkFiles(FORMAT_ADAPTERS_ROOT), ...walkFiles(CATALOG_ADAPTERS_ROOT)];
    // SOURCE.md intentionally documents the real upstream doc URLs the fixtures
    // are modeled on (see deliverable spec); it is not fixture payload content
    // an adapter ever parses, so it is exempt from the example.invalid-only rule.
    const sourceMdPath = join(FORMAT_ADAPTERS_ROOT, 'SOURCE.md');
    const scannedFiles = allFiles.filter(file => file !== sourceMdPath);

    it('no fixture file content matches a known secret pattern', () => {
      for (const file of allFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const pattern of SECRET_PATTERNS) {
          const matches = content.match(pattern);
          expect(matches, `${file} matched forbidden secret pattern ${pattern}: ${matches?.[0]}`).toBeNull();
        }
      }
    });

    it('every http(s) URL in fixture payload content uses host example.invalid', () => {
      const urlPattern = /https?:\/\/([^\s"'/\\]+)/g;
      let sawAnyUrl = false;
      for (const file of scannedFiles) {
        const content = readFileSync(file, 'utf-8');
        for (const match of content.matchAll(urlPattern)) {
          sawAnyUrl = true;
          expect(match[1], `${file} contains a URL with a non-example.invalid host: ${match[0]}`).toBe('example.invalid');
        }
      }
      expect(sawAnyUrl).toBe(true);
    });
  });

  describe('expected-inventory.json shape', () => {
    const inventoryFiles = [...walkFiles(FORMAT_ADAPTERS_ROOT), ...walkFiles(CATALOG_ADAPTERS_ROOT)]
      .filter(file => file.endsWith('expected-inventory.json'));

    it('found at least one expected-inventory.json per fixture root', () => {
      // 6 format-adapter fixtures (codex-core, codex-deferred,
      // codex-default-surfaces, claude-core, claude-manifestless,
      // claude-deferred) + 3 catalog-adapter fixtures (codex, claude,
      // nessy-internal).
      expect(inventoryFiles.length).toBe(9);
    });

    it('every expected-inventory.json parses and matches the required shape', () => {
      for (const file of inventoryFiles) {
        const parsed = readJson(file) as Record<string, unknown>;

        expect(typeof parsed.format).toBe('string');
        expect(KNOWN_FORMATS.has(parsed.format as string), `${file} has unknown format "${parsed.format}"`).toBe(true);

        expect(typeof parsed.state).toBe('string');
        expect(KNOWN_STATES.has(parsed.state as string), `${file} has unknown state "${parsed.state}"`).toBe(true);

        expect(Array.isArray(parsed.supportedKinds)).toBe(true);
        for (const kind of parsed.supportedKinds as unknown[]) {
          expect(typeof kind).toBe('string');
        }

        for (const key of ['deferred', 'blocked'] as const) {
          expect(Array.isArray(parsed[key]), `${file}.${key} must be an array`).toBe(true);
          for (const entry of parsed[key] as unknown[]) {
            expect(entry && typeof entry === 'object').toBe(true);
            const record = entry as Record<string, unknown>;
            expect(typeof record.externalKind).toBe('string');
            expect(typeof record.reasonCode).toBe('string');
          }
        }
      }
    });

    it('marks every fixture with retained unavailable runtime surfaces as partial', () => {
      for (const file of inventoryFiles) {
        const parsed = readJson(file) as Record<string, unknown>;
        const deferredCount = (parsed.deferred as unknown[]).length;
        expect(parsed.state === 'partial').toBe(deferredCount > 0);
      }
    });
  });

  // Measured deferred-capability corpus re-score. Each row records the
  // evidence-backed state per capability. Codex apps/connectors are now
  // SUPPORTED (materialized as MCP-backed sources with server-owned credentials
  // and interactive OAuth), and so are plugin-shipped output styles (B1c), which
  // reach the picker and the system prompt. Both fixture directories keep their
  // `-deferred` names as the record of what they used to prove.
  describe('deferred-capability corpus re-score (Q1)', () => {
    const claudeDeferred = () => readJson(join(FORMAT_ADAPTERS_ROOT, 'claude-deferred', 'expected-inventory.json')) as Record<string, unknown>;
    const codexDeferred = () => readJson(join(FORMAT_ADAPTERS_ROOT, 'codex-deferred', 'expected-inventory.json')) as Record<string, unknown>;

    it('claude-deferred: the prompt hook (B1) and the output style (B1c) are SUPPORTED, nothing left deferred', () => {
      const inv = claudeDeferred();
      expect(inv.supportedKinds).toEqual(expect.arrayContaining(['skill', 'hook', 'output-style']));
      const reasonCodes = (inv.deferred as Array<{ reasonCode: string }>).map(d => d.reasonCode);
      expect(reasonCodes).toEqual([]);
      expect(inv.state).toBe('supported');
    });

    it('codex-deferred: apps/connectors are now SUPPORTED (K1 — MCP-backed source), nothing left deferred', () => {
      const inv = codexDeferred();
      const deferred = inv.deferred as Array<{ externalKind: string; reasonCode: string }>;
      expect(deferred).toEqual([]);
      expect(inv.supportedKinds).toEqual(expect.arrayContaining(['app', 'connector']));
      expect(inv.state).toBe('supported');
    });
  });

  describe('optional dev convenience: installed Codex fixture root inspection', () => {
    const fixtureRoot = process.env.NESSY_CODEX_FIXTURE_ROOT;

    it.skipIf(!fixtureRoot)('the env-supplied directory exists and is readable', () => {
      if (!fixtureRoot) return;
      expect(existsSync(fixtureRoot)).toBe(true);
      const stat = statSync(fixtureRoot);
      expect(stat.isDirectory()).toBe(true);
      // Minimal dev convenience check only — never a CI dependency.
      expect(() => readdirSync(fixtureRoot)).not.toThrow();
    });
  });
});
