/**
 * UA6.5 — the "## Pages" guidance reaches the model on all three slots exactly when the six page tools are offered
 * there: Pi and Claude through `getSystemPrompt` (the tools are offered there unconditionally), codex through
 * `codexDeveloperInstructions`' `sections.pages` (codex never calls `getSystemPrompt`), only when the spawn has the
 * host-callback bridge — the same predicate that offers the tools (UA6.3).
 *
 * No `mock.module`: the compositions are pure functions, and the codex offer predicate is driven on the prototype with
 * a planted `buildSessionMcpSpec` (the one collaborator it reads), with the un-planted arms (no port, no spec) beside it.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSessionToolNames } from '@nessy-agent/session-tools-core';
import { CodexAgent, codexDeveloperInstructions, type CodexDeveloperSections } from '../codex-agent.ts';
import { getSystemPrompt, pagesPromptSection } from '../../prompts/system.ts';
import { DOC_REFS } from '../../docs/index.ts';

const developerSections = (spec: unknown, port: number | undefined): CodexDeveloperSections | undefined =>
  (CodexAgent.prototype as unknown as { developerSections(this: unknown, port: number | undefined): CodexDeveloperSections | undefined })
    .developerSections.call({ buildSessionMcpSpec: () => spec }, port);

const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const GUIDE = join(REPO, 'apps', 'electron', 'resources', 'docs', 'pages.md');
const ARCHITECTURE = join(REPO, 'docs', 'architecture', 'pages.md');
const PAGE_TOOLS = ['list_pages', 'get_page', 'create_page', 'update_page', 'write_page_data', 'delete_page'];
// Assembled at runtime so this file never carries the Craft host it forbids (UA6.6's guard scans packages/).
const CRAFT_HOST = ['thecraft', 'agents'].join('');

/** The Claude slot: `claude-agent.ts` passes no preset and no backend name. */
const claudeSlot = (): string => getSystemPrompt(undefined, undefined, undefined, undefined, undefined, undefined);
/** The Pi slot: `pi-agent.ts` passes its configured preset (default) and the backend name 'Nessy Backend'. */
const piSlot = (): string => getSystemPrompt(undefined, undefined, undefined, undefined, 'default', 'Nessy Backend');
/** The codex slot for a spawn WITH the host-callback bridge (a port and a session MCP spec). */
const codexSlot = (): string => codexDeveloperInstructions(undefined, developerSections({ command: 'node' }, 4711));

describe('positive — the section is on all three slots when the tools are offered', () => {
  it('Pi and Claude carry the whole section and the Configuration Documentation row; codex (bridged) the whole section', () => {
    const section = pagesPromptSection();
    const row = `| Pages | \`${DOC_REFS.pages}\` | BEFORE creating Pages or authoring page HTML |`;
    for (const [slot, text] of [['claude', claudeSlot()], ['pi', piSlot()], ['codex', codexSlot()]] as const) {
      expect([slot, text.includes(section)]).toEqual([slot, true]);
    }
    for (const [slot, text] of [['claude', claudeSlot()], ['pi', piSlot()]] as const) {
      expect([slot, text.includes(row)]).toEqual([slot, true]);
    }
  });

  it('the section names the six tools, the guide and the bridge protocol, and the tools ARE offered on Pi and Claude', () => {
    const section = pagesPromptSection();
    for (const tool of PAGE_TOOLS) expect([tool, section.includes(`\`${tool}\``)]).toEqual([tool, true]);
    expect(section).toContain(DOC_REFS.pages);
    expect(section).toContain('nessy-pages/v1');
    const pi = getSessionToolNames({ projection: 'pi' });
    const claude = getSessionToolNames({});
    expect(PAGE_TOOLS.filter(tool => !pi.has(tool) || !claude.has(tool))).toEqual([]);
  });

  it('DOC_REFS.pages points at the installed copy of a guide that ships', () => {
    expect(DOC_REFS.pages).toBe(`${DOC_REFS.appRoot}/docs/pages.md`);
    expect(existsSync(GUIDE)).toBe(true);
    expect(readFileSync(GUIDE, 'utf-8')).toContain('nessy-pages/v1');
  });

  it('on codex the section sits with the operating guidance: after the safety block, before the output style', () => {
    const composed = codexDeveloperInstructions('## Output Style: Haiku\nAnswer in haiku.', developerSections({ command: 'node' }, 4711));
    const pages = composed.indexOf('## Pages');
    expect(pages).toBeGreaterThan(-1);
    expect(pages).toBeLessThan(composed.indexOf('## Output Style: Haiku'));
    expect(pages).toBeGreaterThan(composed.indexOf('## Board Tasks'));
  });
});

describe('negative — absent where the tools are not offered; no Craft host; no withheld range promised', () => {
  it('a codex spawn WITHOUT the host-callback bridge (or with no session MCP server) gets no Pages section', () => {
    expect(developerSections({ command: 'node' }, undefined)).toBeUndefined();
    expect(developerSections(undefined, 4711)).toBeUndefined();
    const bare = codexDeveloperInstructions(undefined, developerSections({ command: 'node' }, undefined));
    expect(bare).not.toContain('## Pages');
    expect(bare).not.toContain('write_page_data');
    // The same predicate withholds the tools themselves from that spawn (UA6.3).
    const unbridged = getSessionToolNames({ externalStandaloneOnly: true });
    expect(PAGE_TOOLS.filter(tool => unbridged.has(tool))).toEqual([]);
  });

  it('no Craft host and no craft bridge protocol in the section, the guide or the architecture record', () => {
    for (const [name, text] of [
      ['section', pagesPromptSection()],
      ['guide', readFileSync(GUIDE, 'utf-8')],
      ['architecture', readFileSync(ARCHITECTURE, 'utf-8')],
    ] as const) {
      expect([name, text.includes(CRAFT_HOST), text.includes('craft-pages/v1')]).toEqual([name, false, false]);
    }
  });

  it('CONTROL — the needles fire on text that carries them', () => {
    const planted = `See https://${CRAFT_HOST}.com/docs and listen for craft-pages/v1.`;
    expect([planted.includes(CRAFT_HOST), planted.includes('craft-pages/v1')]).toEqual([true, true]);
  });

  it('UA6.7: publishing is the user\'s Share button — the section and the guide say so, and promise no password or agent publish', () => {
    for (const [name, text] of [['section', pagesPromptSection()], ['guide', readFileSync(GUIDE, 'utf-8')]] as const) {
      expect([name, /password/i.test(text) && !/a password field/.test(text)]).toEqual([name, false]);
      expect([name, text.includes('cannot be published yet')]).toEqual([name, false]);
      expect([name, text.includes('Share')]).toEqual([name, true]);
    }
    expect(pagesPromptSection()).toContain("Publishing a page is the user's action (its Share button); do not publish page files yourself.");
    const guide = readFileSync(GUIDE, 'utf-8');
    for (const needle of ['## Publishing', '`view-only:`', 'script approval is never published', 'deleting a published page takes its copy down first']) {
      expect([needle, guide.includes(needle)]).toEqual([needle, true]);
    }
    // UA9.4 turned the guide's grant needles into the presence arm below; the prompt section still points at the guide.
    expect(/grant-request|\bgrantId\b/.test(pagesPromptSection())).toBe(false);
  });

  it('UA9.4: the guide documents source actions — click-bound requests and actions, the ledger grant, 30 days, script pinning, the audit', () => {
    const guide = readFileSync(GUIDE, 'utf-8');
    for (const needle of ['## Source actions', 'grant-request', 'grantId', 'frame-focus-required', 'user-activation-required', 'expires after 30 days', 'grant-stale', 'grant-script-changed', 'It pins the', 'Approved actions', 'logs/page-actions.jsonl', 'logs/privileged-actions.jsonl', 'a grant written into `page.json`']) {
      expect([needle, guide.includes(needle)]).toEqual([needle, true]);
    }
    // NEGATIVE: upstream's model is not taught — grants persisted in the page config, a script env of CRAFT_* names,
    // and a request fired on load (`After init: request anything still missing`).
    for (const stale of ['persisted in the page config', 'After init: request', 'PAGE_SHARE_SCRIPT_GRANT']) {
      expect([stale, guide.includes(stale)]).toEqual([stale, false]);
    }
    expect(/\bCRAFT_[A-Z_]+/.test(guide)).toBe(false);
    expect(/\bCRAFT_[A-Z_]+/.test('a `CRAFT_PAGE_DIR` variable')).toBe(true);
  });

  it('UA8.4: the guide documents the landed refresh — script content not a path, the approval, and its residues', () => {
    const guide = readFileSync(GUIDE, 'utf-8');
    for (const needle of ['## Scheduled refresh', 'scriptContent', 'pages/{slug}/refresh.ts', 'does not run until the user approves', 'needs a new approval', 'One self-contained file', 'Network: allowed', 'No secrets in its environment', 'every 5 minutes']) {
      expect([needle, guide.includes(needle)]).toEqual([needle, true]);
    }
    // NEGATIVE: the upstream script-PATH spec is not taught (a `script:` key inside a `refresh:` example).
    expect(/refresh:\s*\{[^}]*\bscript:/.test(guide)).toBe(false);
    expect(/refresh:\s*\{[^}]*\bscript:/.test('refresh: { cron: "*/15 * * * *", script: "scripts/x.ts" }')).toBe(true);
  });

  it('UA9.4 follow-up: the guide\'s grantFor matches a script grant on script, runtime (default bun) and ordered args', () => {
    const guide = readFileSync(GUIDE, 'utf-8');
    // The guide's own helper, run as written: the page's `missing` filter and its grantId both come from it.
    const snippet = /^function grantFor\(action\) \{[\s\S]*?^\}$/m.exec(guide)?.[0] ?? '';
    expect(snippet.length > 0).toBe(true);
    type Action = Record<string, unknown>;
    const grantFor = (grants: { id: string; action: Action }[], action: Action): string | undefined =>
      (new Function('grants', `${snippet}\nreturn grantFor;`)(grants) as (a: Action) => { id: string } | undefined)(action)?.id;
    const build = { kind: 'script', script: 'scripts/build.ts' };
    const deploy = { kind: 'script', script: 'scripts/deploy.ts' };
    const scripts = [{ id: 'g-build', action: build }];
    expect(grantFor(scripts, build)).toBe('g-build');
    expect(grantFor(scripts, { ...build, runtime: 'bun', args: [] })).toBe('g-build');
    // NEGATIVE: another script, another runtime, other or reordered args is not the approved command.
    expect(grantFor(scripts, deploy)).toBeUndefined();
    expect(grantFor(scripts, { ...build, runtime: 'node' })).toBeUndefined();
    const withArgs = [{ id: 'g-args', action: { ...build, args: ['a', 'b'] } }];
    expect(grantFor(withArgs, { ...build, args: ['a', 'b'] })).toBe('g-args');
    expect(grantFor(withArgs, { ...build, args: ['b', 'a'] })).toBeUndefined();
    expect(grantFor(withArgs, build)).toBeUndefined();
    // CONTROL: the mcp and api arms still match on their own fields, and a kind never matches another kind.
    const mcp = { kind: 'mcp', sourceSlug: 'ci', toolName: 'list_builds' };
    const api = { kind: 'api', sourceSlug: 'ci', method: 'GET', pathPattern: '^/builds$' };
    const both = [{ id: 'g-mcp', action: mcp }, { id: 'g-api', action: api }];
    expect(grantFor(both, mcp)).toBe('g-mcp');
    expect(grantFor(both, api)).toBe('g-api');
    expect(grantFor(both, { ...mcp, toolName: 'delete_build' })).toBeUndefined();
    expect(grantFor(both, { ...mcp, sourceSlug: 'other' })).toBeUndefined();
    expect(grantFor(both, { ...api, method: 'POST' })).toBeUndefined();
    expect(grantFor(both, build)).toBeUndefined();
    expect(grantFor(scripts, mcp)).toBeUndefined();
  });

  it('UA12.98: the section names scheduled refresh — scriptContent, not a path — and that it waits for the user\'s approval', () => {
    const section = pagesPromptSection();
    // POSITIVE: the refresh key on both tools, the content field, the floor, and the approval (first run and every script change).
    for (const needle of ['`refresh`', '`create_page`', '`update_page`', '`scriptContent`', 'every 5 minutes', 'does not run until the user approves', 'needs a new approval', 'waiting for their approval']) {
      expect([needle, section.includes(needle)]).toEqual([needle, true]);
    }
    // NEGATIVE: no upstream script PATH, and no promise that the agent approves or runs it itself.
    expect(/\bscript:|scripts\//.test(section)).toBe(false);
    expect(/approve it yourself|you can approve|run it yourself/i.test(section)).toBe(false);
    // CONTROL: the needles fire on text that carries them.
    expect(/\bscript:|scripts\//.test('refresh: { cron: "*/15 * * * *", script: "scripts/x.ts" }')).toBe(true);
    expect(/approve it yourself|you can approve|run it yourself/i.test('You can approve the refresh.')).toBe(true);
  });
});
