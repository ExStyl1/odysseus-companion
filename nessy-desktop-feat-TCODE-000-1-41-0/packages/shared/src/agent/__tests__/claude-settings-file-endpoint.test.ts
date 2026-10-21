/**
 * F1.981 — a Claude settings file's `env.ANTHROPIC_BASE_URL` cannot move a
 * session's endpoint: the host pins the connection's value on the flag-settings
 * tier, which the child ranks above the user, project and local files.
 *
 * Asserted at the `query()` seam (the pattern `claude-runtime-agents-seam.test.ts`
 * records): a real `chatImpl` turn against a faked SDK `query`, so the test fails
 * if the pin stops reaching the options, not only if the builder changes. That
 * the child HONOURS the tier is measured against the vendored binary in
 * `claude-settings-file-endpoint-e2e.test.ts`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as sdkPackage from '@anthropic-ai/claude-agent-sdk';
import type { BackendConfig } from '../backend/types.ts';
import { collectRejectedUserSettingsLayers } from '../../config/storage.ts';
import { buildConfigDoctorReport } from '../../config/config-doctor.ts';
import { CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS } from '../../config/claude-provider-routing-env.ts';

// Snapshot BEFORE mocking, restored in `afterAll` (AGENTS.md §Traps, `mock.module`).
const realSdk = { ...sdkPackage };
const capturedOptions: Record<string, unknown>[] = [];
const capturedEvents: { type: string; message?: string }[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...realSdk,
  query: (input: { options: Record<string, unknown> }) => {
    capturedOptions.push(input.options);
    return (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } as never;
    })();
  },
}));

afterAll(() => {
  mock.module('@anthropic-ai/claude-agent-sdk', () => realSdk);
});

const { ClaudeAgent } = await import('../claude-agent.ts');

const LOOPBACK = 'http://127.0.0.1:65531';
/** Fabricated; never contacted — the SDK is faked. */
const PROJECT_ENDPOINT = 'http://127.0.0.1:65532';
const FLAG_ENV_VAR = 'NESSY_CLAUDE_SETTINGS';
/** F1.1006 — every provider toggle pinned off (`''`), beside the endpoint. */
const TOGGLES_OFF = Object.fromEntries(CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS.map(key => [key, '']));

let project: string;

function agentConfig(envOverrides: Record<string, string> | undefined, projectTrusted = true): BackendConfig {
  return {
    provider: 'anthropic',
    providerType: 'anthropic',
    model: 'claude-sonnet-4-6',
    isHeadless: true,
    skipConfigWatcher: true,
    projectTrusted,
    // F1.1008 — the pin now reads the user tier too, so it is a scratch directory here, never the developer's own.
    ...(envOverrides ? { envOverrides: { CLAUDE_CONFIG_DIR: join(project, 'claude-config'), ...envOverrides } } : {}),
    workspace: {
      id: 'ws-f1981',
      name: 'F1.981 Workspace',
      rootPath: project,
      workspaceRootPath: project,
      sessionRootPath: join(project, 'sessions'),
    } as never,
    session: {
      id: 'session-f1981',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      workingDirectory: project,
    } as never,
  } as BackendConfig;
}

async function runTurn(config: BackendConfig): Promise<{ env?: Record<string, unknown> } & Record<string, unknown>> {
  const agent = new ClaudeAgent(config);
  const chatImpl = (agent as unknown as { chatImpl: (m: string) => AsyncGenerator<unknown> }).chatImpl.bind(agent);
  for await (const event of chatImpl('hi')) capturedEvents.push(event as { type: string; message?: string });
  expect(capturedOptions.length).toBe(1);
  return capturedOptions[0]!.settings as { env?: Record<string, unknown> } & Record<string, unknown>;
}

function endpointNotices(): string[] {
  return capturedEvents
    .filter(event => event.type === 'info')
    .map(event => event.message ?? '')
    .filter(message => message.includes('endpoint-ignored:'));
}

function toggleNotices(): string[] {
  return capturedEvents
    .filter(event => event.type === 'info')
    .map(event => event.message ?? '')
    .filter(message => message.includes('provider-toggle-ignored:'));
}

function credentialNotices(): string[] {
  return capturedEvents
    .filter(event => event.type === 'info')
    .map(event => event.message ?? '')
    .filter(message => message.includes('credential-ignored:') || message.includes('credential-in-use:'));
}

function firstPartyNotices(): string[] {
  return capturedEvents
    .filter(event => event.type === 'info')
    .map(event => event.message ?? '')
    .filter(message => message.includes('first-party-ignored:'));
}

beforeEach(() => {
  capturedOptions.length = 0;
  capturedEvents.length = 0;
  project = realpathSync(mkdtempSync(join(tmpdir(), 'nessy-f1981-')));
  delete process.env[FLAG_ENV_VAR];
});

afterEach(() => {
  delete process.env[FLAG_ENV_VAR];
  rmSync(project, { recursive: true, force: true });
});

describe('F1.981 — the connection endpoint is pinned on the flag-settings tier', () => {
  it('a connection with an endpoint pins exactly that value', async () => {
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1981-fabricated', ANTHROPIC_BASE_URL: LOOPBACK }));
    expect(settings.env).toEqual({ ...TOGGLES_OFF, ANTHROPIC_BASE_URL: LOOPBACK });
    // The rig: the child's environment carries the same value, so the pin changes nothing else.
    expect((capturedOptions[0]!.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe(LOOPBACK);
  });

  it('a connection without one pins the vendor default, never nothing and never the empty value (F1.1005)', async () => {
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1981-fabricated' }));
    // `''` would reach every tool subprocess as an empty base URL (the Anthropic Python SDK takes it literally).
    expect(settings.env).toEqual({ ...TOGGLES_OFF, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
  });

  it('the operator --settings keeps its other env entries, and its own endpoint is ignored and said so', async () => {
    process.env[FLAG_ENV_VAR] = JSON.stringify({ env: { F1981_KEEP: '1', ANTHROPIC_BASE_URL: PROJECT_ENDPOINT }, verbose: true });
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1981-fabricated', ANTHROPIC_BASE_URL: LOOPBACK }));
    expect(settings.env).toEqual({ F1981_KEEP: '1', ...TOGGLES_OFF, ANTHROPIC_BASE_URL: LOOPBACK });
    expect(settings.verbose).toBe(true);
    expect(endpointNotices().some(notice => notice.startsWith('claude-settings-flag-endpoint-ignored:'))).toBe(true);
  });

  it('a trusted project file naming the endpoint is told on the transcript and in the doctor, by path only', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    const file = join(project, '.claude', 'settings.json');
    writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: PROJECT_ENDPOINT } }));
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1981-fabricated', ANTHROPIC_BASE_URL: LOOPBACK }));
    expect(settings.env).toEqual({ ...TOGGLES_OFF, ANTHROPIC_BASE_URL: LOOPBACK });
    const notices = endpointNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(file);
    expect(notices[0]).not.toContain(PROJECT_ENDPOINT);
    const record = collectRejectedUserSettingsLayers().find(layer => layer.source === file);
    expect(record?.key).toBe('env.ANTHROPIC_BASE_URL');
    expect(record?.reason).toContain('IGNORED');
    expect(record?.reason).not.toContain(PROJECT_ENDPOINT);
  });

  it('CONTROL: without such a file there is no notice and no doctor record for it', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ env: { F1981_OTHER: '1' } }));
    await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1981-fabricated' }));
    expect(endpointNotices()).toEqual([]);
    expect(toggleNotices()).toEqual([]);
    expect(credentialNotices()).toEqual([]);
    expect(firstPartyNotices()).toEqual([]);
    expect(collectRejectedUserSettingsLayers().some(layer => layer.source.startsWith(project))).toBe(false);
  });
});

describe('F1.1006 — a settings file cannot switch the provider either', () => {
  it('a trusted project file setting a provider toggle is pinned off on the flag tier and told, by path and name only', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    const file = join(project, '.claude', 'settings.json');
    writeFileSync(file, JSON.stringify({ env: { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_BASE_URL: PROJECT_ENDPOINT } }));
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1006-fabricated', ANTHROPIC_BASE_URL: LOOPBACK }));
    // The pin outranks the file (measured against the vendored binary in the e2e twin); the file's
    // companion is left to the file — with every toggle off, no provider client reads it.
    expect(settings.env).toEqual({ ...TOGGLES_OFF, ANTHROPIC_BASE_URL: LOOPBACK });
    const notices = toggleNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(file);
    expect(notices[0]).toContain('CLAUDE_CODE_USE_VERTEX');
    expect(notices[0]).not.toContain(PROJECT_ENDPOINT);
    // The endpoint notice stays the endpoint's: this file names no ANTHROPIC_BASE_URL.
    expect(endpointNotices()).toEqual([]);
    // F1.1009 — the doctor lists the toggle-only file too, by path and name only, and only under the toggle's name.
    const records = collectRejectedUserSettingsLayers().filter(layer => layer.source === file);
    expect(records.map(layer => layer.key)).toEqual(['env.CLAUDE_CODE_USE_VERTEX']);
    expect(records[0]!.reason).toContain('IGNORED');
    expect(records[0]!.reason).toContain('provider');
    expect(records[0]!.reason).not.toContain(PROJECT_ENDPOINT);
  });

  it('BOUNDARY: an untrusted project\'s toggle file is not loaded by the child, so neither the chat nor the doctor names it', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    const file = join(project, '.claude', 'settings.json');
    writeFileSync(file, JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
    await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1009-fabricated', ANTHROPIC_BASE_URL: LOOPBACK }, false));
    expect(capturedOptions[0]!.settingSources).toEqual(['user']);
    expect(toggleNotices()).toEqual([]);
    expect(collectRejectedUserSettingsLayers().some(layer => layer.source === file)).toBe(false);
  });

  it('the operator --settings keeps its env, and its own provider toggle is ignored and said so', async () => {
    process.env[FLAG_ENV_VAR] = JSON.stringify({ env: { F1006_KEEP: '1', CLAUDE_CODE_USE_BEDROCK: '1' } });
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1006-fabricated' }));
    expect(settings.env).toEqual({ F1006_KEEP: '1', ...TOGGLES_OFF, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
    expect(toggleNotices()).toEqual([expect.stringContaining('CLAUDE_CODE_USE_BEDROCK')]);
    expect(toggleNotices()[0]!.startsWith('claude-settings-flag-provider-toggle-ignored:')).toBe(true);
  });
});

describe('F1.1043 — a trusted project\'s own credential is USED and named; the first-party assumption is not', () => {
  const FIRST_PARTY = '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL';
  /** Fabricated; a project's own bearer token and key. */
  const REPO_TOKEN = 'repo-f1043-fabricated';
  const REPO_KEY = 'sk-ant-repo-f1043-fabricated';

  it('a trusted project file naming ANTHROPIC_AUTH_TOKEN keeps it (not pinned), the first-party flag is cancelled, and both are told by path and name only', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    const file = join(project, '.claude', 'settings.json');
    writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: REPO_TOKEN, [FIRST_PARTY]: '1' } }));
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1043-fabricated', ANTHROPIC_BASE_URL: LOOPBACK }));
    // F1.1008's cancel of the token is reverted: the flag tier leaves it to the file, so the child uses it.
    expect(settings.env).toEqual({ ...TOGGLES_OFF, ANTHROPIC_BASE_URL: LOOPBACK, [FIRST_PARTY]: '' });
    const notices = credentialNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.startsWith('claude-settings-file-credential-in-use:')).toBe(true);
    expect(notices[0]).toContain(file);
    expect(notices[0]).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(notices[0]).toContain('Claude Code uses it');
    expect(notices[0]).not.toContain(FIRST_PARTY);
    expect(notices[0]).not.toContain(REPO_TOKEN);
    expect(firstPartyNotices()).toEqual([expect.stringContaining(FIRST_PARTY)]);
    expect(firstPartyNotices()[0]).toContain(file);
    // The doctor: the flag stays a rejected record (IGNORED); the token is listed apart as IN USE, never a finding.
    const records = collectRejectedUserSettingsLayers().filter(layer => layer.source === file);
    expect(records.map(layer => [layer.key, layer.inUse === true])).toEqual([[`env.${FIRST_PARTY}`, false], ['env.ANTHROPIC_AUTH_TOKEN', true]]);
    expect(records[0]!.reason).toContain('IGNORED');
    expect(records[1]!.reason).toContain('IN USE');
    for (const record of records) expect(record.reason).not.toContain(REPO_TOKEN);
    const report = buildConfigDoctorReport({ drops: [], winner: 'none', fileCarriesSettings: false, rejectedLayers: records });
    expect(report.text).toContain('Settings-file credentials in use (1):');
    expect(report.text).toContain('Rejected settings layers (1):');
    expect(report.text).not.toContain(REPO_TOKEN);
  });

  it('a trusted project file naming ANTHROPIC_API_KEY keeps it (not refused, not pinned), and it is told and listed as in use', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    const file = join(project, '.claude', 'settings.json');
    writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_API_KEY: REPO_KEY } }));
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1043-fabricated' }));
    expect(settings.env).toEqual({ ...TOGGLES_OFF, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
    expect(capturedEvents.some(event => event.type === 'error')).toBe(false);
    expect(credentialNotices()).toEqual([expect.stringContaining('ANTHROPIC_API_KEY')]);
    expect(credentialNotices()[0]).toContain(file);
    expect(credentialNotices()[0]).not.toContain(REPO_KEY);
    const records = collectRejectedUserSettingsLayers().filter(layer => layer.source === file);
    expect(records.map(layer => [layer.key, layer.inUse])).toEqual([['env.ANTHROPIC_API_KEY', true]]);
    // Not a finding: the doctor's verdict comes from the rejected layers only.
    const report = buildConfigDoctorReport({ drops: [], winner: 'none', fileCarriesSettings: false, rejectedLayers: records });
    expect(report.hasFindings).toBe(false);
    expect(report.text).toContain('Rejected settings layers:');
    expect(report.text).not.toContain(REPO_KEY);
  });

  it('the Workspace user-tier file is read before the options exist, at the CLAUDE_CONFIG_DIR the child is given', async () => {
    const userDir = join(project, 'claude-config');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: REPO_TOKEN } }));
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1043-fabricated' }));
    // The rig: the directory the pin read is the one the child loads its user tier from.
    expect((capturedOptions[0]!.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(userDir);
    expect(settings.env).toEqual({ ...TOGGLES_OFF, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' });
    expect(credentialNotices()).toEqual([expect.stringContaining(join(userDir, 'settings.json'))]);
  });

  it('F1.1064: a trusted project file\'s apiKeyHelper and CLAUDE_CODE_OAUTH_TOKEN are left to Claude Code, told as ranking below the token and the key, and listed in use', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    const file = join(project, '.claude', 'settings.json');
    const helper = `printf %s ${REPO_KEY}`;
    writeFileSync(file, JSON.stringify({ apiKeyHelper: helper, env: { CLAUDE_CODE_OAUTH_TOKEN: REPO_TOKEN } }));
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1064-fabricated', ANTHROPIC_BASE_URL: LOOPBACK }));
    // Nothing pinned or cancelled for either: the child applies them by its own precedence.
    expect(settings.env).toEqual({ ...TOGGLES_OFF, ANTHROPIC_BASE_URL: LOOPBACK });
    expect(settings.apiKeyHelper).toBeUndefined();
    const notices = credentialNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.startsWith('claude-settings-file-credential-in-use:')).toBe(true);
    expect(notices[0]).toContain(`${file} sets apiKeyHelper and CLAUDE_CODE_OAUTH_TOKEN in env`);
    expect(notices[0]).toContain('below ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY');
    expect(notices[0]).toContain('The apiKeyHelper command runs when the session starts');
    for (const secret of [REPO_TOKEN, REPO_KEY, helper]) expect(notices[0]).not.toContain(secret);
    const records = collectRejectedUserSettingsLayers().filter(layer => layer.source === file);
    expect(records.map(layer => [layer.key, layer.inUse])).toEqual([['apiKeyHelper', true], ['env.CLAUDE_CODE_OAUTH_TOKEN', true]]);
    for (const record of records) {
      expect(record.reason).toContain('IN USE by Claude Code\'s own authentication precedence');
      // Not truncated by the record's length cap: the remedy is the last sentence.
      expect(record.reason.endsWith('Remove it here to use the connection\'s.')).toBe(true);
      for (const secret of [REPO_TOKEN, REPO_KEY, helper]) expect(record.reason).not.toContain(secret);
    }
    const report = buildConfigDoctorReport({ drops: [], winner: 'none', fileCarriesSettings: false, rejectedLayers: records });
    expect(report.hasFindings).toBe(false);
    expect(report.text).toContain('Settings-file credentials in use (2):');
  });

  it('BOUNDARY: an untrusted project\'s file is not loaded by the child, so nothing is named or cancelled for it', async () => {
    mkdirSync(join(project, '.claude'), { recursive: true });
    // F1.1064 — its apiKeyHelper and CLAUDE_CODE_OAUTH_TOKEN included.
    writeFileSync(join(project, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'printf x', env: { ANTHROPIC_AUTH_TOKEN: REPO_TOKEN, ANTHROPIC_API_KEY: REPO_KEY, CLAUDE_CODE_OAUTH_TOKEN: REPO_TOKEN, [FIRST_PARTY]: '1' } }));
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1043-fabricated', ANTHROPIC_BASE_URL: LOOPBACK }, false));
    expect(capturedOptions[0]!.settingSources).toEqual(['user']);
    expect(settings.env).toEqual({ ...TOGGLES_OFF, ANTHROPIC_BASE_URL: LOOPBACK });
    expect(credentialNotices()).toEqual([]);
    expect(firstPartyNotices()).toEqual([]);
    // F1.1017 / F1.1043 — and the doctor lists nothing the child does not load.
    expect(collectRejectedUserSettingsLayers().some(layer => layer.source.startsWith(project))).toBe(false);
  });

  it('the operator --settings naming ANTHROPIC_AUTH_TOKEN keeps it and says so; its first-party flag is cancelled', async () => {
    process.env[FLAG_ENV_VAR] = JSON.stringify({ env: { F1043_KEEP: '1', ANTHROPIC_AUTH_TOKEN: REPO_TOKEN, [FIRST_PARTY]: '1' } });
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1043-fabricated', ANTHROPIC_BASE_URL: LOOPBACK }));
    expect(settings.env).toEqual({ F1043_KEEP: '1', ANTHROPIC_AUTH_TOKEN: REPO_TOKEN, ...TOGGLES_OFF, ANTHROPIC_BASE_URL: LOOPBACK, [FIRST_PARTY]: '' });
    const notices = credentialNotices();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.startsWith('claude-settings-flag-credential-in-use:')).toBe(true);
    expect(notices[0]).not.toContain(REPO_TOKEN);
    expect(firstPartyNotices()).toEqual([expect.stringMatching(/^claude-settings-flag-first-party-ignored:/)]);
  });

  it('F1.1064: the operator --settings apiKeyHelper, with no env at all, reaches the child and is named', async () => {
    process.env[FLAG_ENV_VAR] = JSON.stringify({ apiKeyHelper: 'printf f1064-operator' });
    const settings = await runTurn(agentConfig({ ANTHROPIC_API_KEY: 'sk-ant-f1064-fabricated', ANTHROPIC_BASE_URL: LOOPBACK }));
    expect(settings.apiKeyHelper).toBe('printf f1064-operator');
    const notices = credentialNotices();
    expect(notices).toEqual([expect.stringMatching(/^claude-settings-flag-credential-in-use: the --settings value sets apiKeyHelper, /)]);
    expect(notices[0]).not.toContain('f1064-operator');
  });
});
