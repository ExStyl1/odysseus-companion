/**
 * F1.981 — a Claude SETTINGS FILE cannot move a session's endpoint either.
 *
 * Owner rule, 2026-09-25, extended to settings files on 2026-09-26: the
 * integration decides the endpoint. F1.966 made the child's ENVIRONMENT follow
 * it (`buildClaudeSubprocessEnv`, `dropAmbientAnthropicBaseUrl`), but Claude Code
 * writes a settings file's `env` block over that environment
 * (`settings-reference.md#how-env-values-interact-with-your-shell`: *"A value
 * here overwrites the same variable exported in your shell, and when more than
 * one settings file sets a variable, the highest-precedence one applies."*), and
 * `ANTHROPIC_BASE_URL` is not on `#variables-claude-code-ignores-in-env`.
 *
 * ## Measured through the host first (DN-108, 2026-09-26, vendored 2.1.267)
 *
 * The host's own `buildClaudeSubprocessEnv`, the SDK's `query()` and the vendored
 * binary, `settingSources: ['user','project','local']`, loopback stubs only and a
 * fabricated key. A claude-runtime session whose connection names a loopback
 * adapter sent its model call to the address a trusted project's
 * `.claude/settings.json` `env` named, and likewise to the Workspace's user-tier
 * `settings.json`; a direct connection without a base URL sent its KEY there.
 * With `env.ANTHROPIC_BASE_URL` on the flag tier below, every call went to the
 * connection's address, or, pinned `''` (F1.981's first spelling), to the vendor default only.
 * `__tests__/claude-settings-file-endpoint-e2e.test.ts` keeps the arms.
 *
 * ## Native-first
 *
 * The runtime's own precedence does it: the SDK's `Options.settings` is the
 * `--settings` tier, *"which has the highest priority among user-controlled
 * settings"* (`sdk.d.ts`), above local, project and user. So the host writes the
 * connection's value there and the child's own merge keeps it. The other native
 * closer, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, was declined by the owner on
 * 2026-09-11 (C4.30/QX1) because it also drops managed `model` pins.
 *
 * - A connection with an endpoint (the claude-runtime loopback adapter, or a
 *   direct connection's own base URL) pins exactly the value the child's
 *   environment already carries, so nothing else changes.
 * - A connection without one pins the VENDOR DEFAULT, `https://api.anthropic.com`
 *   (F1.1005). F1.981 first pinned the documented cancel spelling `''`, but
 *   *"subprocesses inherit the empty value"* (`#how-env-values-interact-with-your-shell`):
 *   every Bash tool, hook and stdio MCP server of the session saw an EMPTY
 *   `ANTHROPIC_BASE_URL`, and the Anthropic Python SDK takes `''` as its base URL
 *   (0.89.0, measured: `client.base_url == ''`, a call fails `UnsupportedProtocol`) where unset means the
 *   vendor's. Measured on the vendored 2.1.267 (DN-125): the binary's first-party
 *   test reads unset and an `api.anthropic.com` host alike (unset, or `new
 *   URL(v).host` in `["api.anthropic.com"]`), every `!== undefined` reader sees
 *   `''` and the URL alike, and the arm pinned to the URL made its model call to
 *   `api.anthropic.com` only, with the same key source, while its tool
 *   subprocesses saw the URL. RESIDUE: a subprocess that asks only WHETHER the
 *   name is set sees it set; the child's own `/status` prints the line.
 * - Managed settings still outrank this tier: an administrator's own
 *   `managed-settings.json` `env` is organisation policy and is left alone.
 *
 * ## F1.1006 — nor can one switch the PROVIDER
 *
 * The host strips every provider toggle from the child's environment
 * (`CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS`, `config/claude-provider-routing-env.ts`),
 * but a settings file's `env` is written over that environment, and no toggle is
 * on `#variables-claude-code-ignores-in-env`. Measured through the host (DN-147,
 * 2026-09-26, vendored 2.1.267, the rig above plus a stub that records which
 * credential reached it): under the endpoint-only pin a trusted project's
 * `CLAUDE_CODE_USE_VERTEX` with `ANTHROPIC_VERTEX_BASE_URL` sent the model call
 * AND the connection's key (`x-api-key`) to the file's address; its
 * `CLAUDE_CODE_USE_BEDROCK` with `ANTHROPIC_BEDROCK_BASE_URL` sent the call there
 * with the file's own bearer token, from the project and from the Workspace user
 * tier alike. So every toggle is pinned OFF on this tier, with the documented
 * cancel value (`#how-env-values-interact-with-your-shell`: *"Claude Code treats
 * an empty value as unset for provider selection"*): with it every arm's call
 * went to the connection's address, or the vendor default, with the connection's
 * key only. `''` is safe here where F1.1005 made it unsafe for the endpoint: a
 * toggle is a switch, and the page documents `''` as off, not as a value.
 *
 * - The provider COMPANIONS (`ANTHROPIC_VERTEX_BASE_URL`, `AWS_BEARER_TOKEN_BEDROCK`,
 *   …) are not pinned: with every toggle off no provider client is built, the
 *   routing constant's own membership rule, and pinning `''` would hand the
 *   session's subprocesses an empty base URL (the F1.1005 class).
 * - A settings file's `ANTHROPIC_AUTH_TOKEN` is F1.1043's, below. The session's
 *   subprocesses now see each toggle set and empty rather than absent.
 *
 * ## F1.1043 — the project's own CREDENTIAL is used; the first-party assumption is not
 *
 * Owner decision 2026-09-28, one principle for all three runtimes: the integration
 * decides WHERE requests go (endpoint and provider, above), and a trusted
 * project's or workspace's own configuration decides WHICH credential signs them,
 * exactly as the runtime natively allows; the app always names the file. Claude
 * Code's own rule (`authentication.md#authentication-precedence`): tier 2
 * `ANTHROPIC_AUTH_TOKEN` is *"Sent as the `Authorization: Bearer` header"*, tier 3
 * `ANTHROPIC_API_KEY` *"In non-interactive mode (`-p`), the key is always used when
 * present"*. So a file's `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are NOT
 * pinned here (F1.1008's cancel of the token, `fbdd42edf`, is reverted): the child
 * uses them, and the pin names each file on the transcript and records it for the
 * configuration doctor as IN USE (`recordClaudeSettingsFileCredentialsInUse`,
 * `config/storage.ts`), names only, never a value. Measured (DN-165, 2026-09-26,
 * vendored 2.1.267, a loopback CONNECTION stub recording headers by label): the
 * file's token arrives as a bearer BESIDE the connection's key, the file's key
 * arrives INSTEAD of it; `__tests__/claude-settings-file-endpoint-e2e.test.ts` keeps
 * both arms. On a connection through the app's local adapter (Nessy Gateway, or
 * Claude Code with a custom endpoint) they reach only that adapter, which forwards
 * no inbound credential and signs upstream with the connection's own
 * (`INBOUND_AGENT_ATTRIBUTION_HEADERS`, `codex-responses-adapter/src/server.ts`).
 *
 * `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` stays cancelled when named: it shapes
 * the requests, not the identity (a name the host strips from the child's
 * environment, P3.113). Measured (DN-165): a trusted project's `=1` reached the
 * child and the model request carried the eight `anthropic-beta` values of the
 * positive control instead of the control arm's five; pinned `''` on this tier, the
 * five. Cancelled ONLY when a file this child loads (or the operator's
 * `--settings`) names it: a blanket `''` would reach every subprocess. So the files
 * are read BEFORE the options exist ({@link claudeSpawnSettingsFiles}), and the pin
 * itself names and records (F1.1017, `recordIgnoredClaudeSettingsFileCredentials`)
 * each file whose flag it cancelled, so the doctor never claims a cancel the pin
 * did not make. The operator's `--settings` is told on the transcript only, as its
 * endpoint and toggles are; its credentials apply like a file's.
 *
 * - F1.1064: `apiKeyHelper` (tier 4, a TOP-LEVEL key) and `env.CLAUDE_CODE_OAUTH_TOKEN`
 *   (tier 5) are the project's credential too, applied by the same precedence and
 *   named the same way (`claude-settings-file-credential-in-use`, recorded IN USE),
 *   in words that say they rank below the token and the key. Measured (DN-259,
 *   2026-09-28, vendored 2.1.267, a loopback stub recording headers by label, this
 *   pin on the flag tier): with an OAuth-shaped connection (`ANTHROPIC_API_KEY`
 *   `''`, `CLAUDE_CODE_OAUTH_TOKEN` set) a project's `CLAUDE_CODE_OAUTH_TOKEN`
 *   replaced the connection's bearer, and a project's `apiKeyHelper` ran and its
 *   output replaced it (`apiKeySource: 'apiKeyHelper'`); with an API-key connection
 *   the file's OAuth token was not sent, while the helper STILL ran and its output
 *   rode as a bearer beside the connection's key (`apiKeySource: 'ANTHROPIC_API_KEY'`).
 * - RESIDUE: the file list is derived before the options exist, the way C3.273
 *   re-derives `CLAUDE_CONFIG_DIR`; a plugin environment naming
 *   `NESSY_WORKSPACE_ID` or `CLAUDE_CONFIG_DIR` would not be seen by it.
 *
 * ## The operator's `--settings` keeps its `env`
 *
 * `composeClaudeSpawnSettings` merges by TOP-LEVEL key and keeps the first
 * writer, so a host contributor owning `env` would drop an operator's whole
 * `NESSY_CLAUDE_SETTINGS` `env` block. Its entries are folded in here instead,
 * with the endpoint pinned over them — an operator's own `ANTHROPIC_BASE_URL`
 * there is ignored like any other, and said so.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeFlagSettings } from '../config/claude-flag-settings.ts';
import {
  recordClaudeSettingsFileCredentialsInUse,
  recordIgnoredClaudeSettingsFileCredentials,
  recordIgnoredClaudeSettingsFileEndpoint,
  recordIgnoredClaudeSettingsFileProviderToggles,
} from '../config/storage.ts';
import {
  CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS,
  CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS,
} from '../config/claude-provider-routing-env.ts';
import { workspaceClaudeConfigDirPath } from './options.ts';

const ENDPOINT = 'ANTHROPIC_BASE_URL';
/** F1.1005 — the vendor's own default (the binary's `BASE_API_URL`), what a connection without a base URL means. */
const CLAUDE_VENDOR_DEFAULT_BASE_URL = 'https://api.anthropic.com';
/** F1.1006 — every provider toggle pinned off, the documented cancel value. */
const PROVIDER_TOGGLES_OFF: Readonly<Record<string, string>> = Object.fromEntries(
  CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS.map(key => [key, '']),
);

/** F1.1008 — cancelled (`''`) only when a loaded settings file or the operator's `--settings` names them. */
const CANCELLED_WHEN_NAMED: readonly string[] = [...CLAUDE_FIRST_PARTY_ASSUMPTION_ENV_KEYS];
/** F1.1043 — used by the child as Claude Code allows (tiers 2 and 3 of its precedence), never pinned; named only. */
const CREDENTIALS_USED_WHEN_NAMED: readonly string[] = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'];
/** F1.1064 — tier 4, a TOP-LEVEL settings key (its value is a command), and tier 5, in `env`; never pinned, named only. */
const HELPER_KEY = 'apiKeyHelper';
const LOWER_TIER_ENV_CREDENTIALS: readonly string[] = ['CLAUDE_CODE_OAUTH_TOKEN'];

function pinnedEnv(baseUrl: string, cancelled: readonly string[] = []): Record<string, string> {
  return { ...PROVIDER_TOGGLES_OFF, [ENDPOINT]: baseUrl, ...Object.fromEntries(cancelled.map(key => [key, ''])) };
}

function namedCancelled(env: Record<string, unknown>): string[] {
  return CANCELLED_WHEN_NAMED.filter(key => Object.hasOwn(env, key));
}

function namedCredentials(env: Record<string, unknown>): string[] {
  return CREDENTIALS_USED_WHEN_NAMED.filter(key => Object.hasOwn(env, key));
}

/** F1.1064 — the lower-tier names a settings object sets, in precedence order: `apiKeyHelper`, then `env` names. */
function namedLowerTierCredentials(settings: Record<string, unknown>, env: Record<string, unknown>): string[] {
  return [...(Object.hasOwn(settings, HELPER_KEY) ? [HELPER_KEY] : []), ...LOWER_TIER_ENV_CREDENTIALS.filter(key => Object.hasOwn(env, key))];
}

function firstPartyNotice(where: string, names: readonly string[], rest: string): string {
  return `${where} sets ${names.join(', ')} in ${rest}, and it is ignored: the connection decides every session's `
    + 'endpoint, and this flag would make Claude Code treat that endpoint as Anthropic\'s own. ';
}

/** F1.1043 — says the file's credential IS in use, by name only; the value is never read out. */
function credentialInUseNotice(where: string, names: readonly string[], rest: string): string {
  return `${where} sets ${names.join(', ')} in ${rest}, and Claude Code uses ${names.length === 1 ? 'it' : 'them'} `
    + 'for this session: a trusted project\'s or workspace\'s own settings decide which credential signs the requests, '
    + 'as Claude Code allows; the connection still decides the endpoint and the provider. Through the app\'s local '
    + 'adapter (Nessy Gateway, or Claude Code with a custom endpoint) it reaches only that adapter, which signs with '
    + 'the connection\'s credential. To use the connection\'s credential, remove it there.';
}

/**
 * F1.1064 — the same notice for the tiers BELOW the token and the key, in words true on every connection: the pin
 * does not know which credential the connection gives the child, so it states the precedence, not a verdict.
 */
function lowerTierCredentialNotice(where: string, names: readonly string[], envWord: string): string {
  const envNames = names.filter(name => name !== HELPER_KEY);
  const what = [...(names.includes(HELPER_KEY) ? [HELPER_KEY] : []), ...(envNames.length > 0 ? [`${envNames.join(', ')} in ${envWord}`] : [])];
  const one = names.length === 1;
  return `${where} sets ${what.join(' and ')}, and Claude Code applies ${one ? 'it' : 'them'} by its own authentication `
    + `precedence, below ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY: on a Claude Pro/Max connection ${one ? 'it replaces' : 'they replace'} `
    + 'the connection\'s sign-in. '
    + (names.includes(HELPER_KEY) ? 'The apiKeyHelper command runs when the session starts, and beside an API key its output is still sent as a bearer token. ' : '')
    + (envNames.length > 0 ? `Beside an API key (the connection's or a file's), ${envNames.join(', ')} is not used. ` : '')
    + 'The connection still decides the endpoint and the provider. Through the app\'s local adapter (Nessy Gateway, '
    + 'or Claude Code with a custom endpoint) it reaches only that adapter, which signs with the connection\'s '
    + 'credential. To use the connection\'s credential, remove it there.';
}

function namedToggles(env: Record<string, unknown>): string[] {
  return CLAUDE_PROVIDER_SELECTION_TOGGLE_ENV_KEYS.filter(key => Object.hasOwn(env, key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The `endpoint` contributor to `composeClaudeSpawnSettings`, and the operator flag with its `env` folded in. */
export function buildClaudeEndpointFlagSettings(input: {
  /** The session's `envOverrides.ANTHROPIC_BASE_URL` — the only source F1.966 keeps. */
  connectionBaseUrl: string | undefined;
  operatorFlag: ClaudeFlagSettings | undefined;
  /** F1.1008 — the settings files this spawn's child loads ({@link claudeSpawnSettingsFiles}); read for names only. */
  loadedSettingsFiles?: readonly string[];
}): { settings: { env: Record<string, string> }; operatorFlag: ClaudeFlagSettings | undefined; notices: string[] } {
  const pinned = input.connectionBaseUrl ?? CLAUDE_VENDOR_DEFAULT_BASE_URL;
  const fileEnvs = (input.loadedSettingsFiles ?? []).map(file => {
    const settings = fileSettings(file) ?? {};
    return { file, settings, env: isPlainObject(settings.env) ? settings.env : {} };
  });
  const fileNamed = fileEnvs.map(({ file, env }) => ({ file, names: namedCancelled(env) })).filter(entry => entry.names.length > 0);
  const fileCredentials = fileEnvs.map(({ file, env }) => ({ file, names: namedCredentials(env) })).filter(entry => entry.names.length > 0);
  const fileLowerTier = fileEnvs.map(({ file, settings, env }) => ({ file, names: namedLowerTierCredentials(settings, env) }))
    .filter(entry => entry.names.length > 0);
  // F1.1017 — each file whose names are cancelled below, for the doctor; names only, never a value.
  for (const { file, names } of fileNamed) recordIgnoredClaudeSettingsFileCredentials(file, names);
  // F1.1043 — and each file whose credential the child USES, listed apart as in use (F1.1064: the lower tiers too).
  for (const { file, names } of [...fileCredentials, ...fileLowerTier]) recordClaudeSettingsFileCredentialsInUse(file, names);
  const fileNotices = [
    ...fileNamed.map(({ file, names }) => `claude-settings-file-first-party-ignored: ${firstPartyNotice(file, names, 'env')}`
      + 'To use a different endpoint, set the base URL on the connection itself.'),
    ...fileCredentials.map(({ file, names }) => `claude-settings-file-credential-in-use: ${credentialInUseNotice(file, names, 'env')}`),
    ...fileLowerTier.map(({ file, names }) => `claude-settings-file-credential-in-use: ${lowerTierCredentialNotice(file, names, 'env')}`),
  ];
  const flag = input.operatorFlag;
  // F1.1064 — the operator's own `apiKeyHelper` rides the flag's top level, so it is named even without an `env`.
  const operatorLowerTier = flag !== undefined && typeof flag !== 'string' && isPlainObject(flag)
    ? namedLowerTierCredentials(flag, isPlainObject(flag.env) ? flag.env : {})
    : [];
  const operatorLowerTierNotices = operatorLowerTier.length > 0
    ? [`claude-settings-flag-credential-in-use: ${lowerTierCredentialNotice('the --settings value', operatorLowerTier, 'its env')}`]
    : [];
  if (flag === undefined || typeof flag === 'string' || !isPlainObject(flag.env)) {
    const cancelled = [...new Set(fileNamed.flatMap(entry => entry.names))];
    return { settings: { env: pinnedEnv(pinned, cancelled) }, operatorFlag: flag, notices: [...fileNotices, ...operatorLowerTierNotices] };
  }
  const { env: operatorEnv, ...rest } = flag as Record<string, unknown> & { env: Record<string, unknown> };
  const toggles = namedToggles(operatorEnv);
  const operatorNamed = namedCancelled(operatorEnv);
  const operatorCredentials = namedCredentials(operatorEnv);
  const cancelled = [...new Set([...operatorNamed, ...fileNamed.flatMap(entry => entry.names)])];
  return {
    // Typed as the SDK's string map; the operator's values reach the child as they always did, which validates them.
    settings: { env: { ...(operatorEnv as Record<string, string>), ...pinnedEnv(pinned, cancelled) } },
    operatorFlag: rest,
    notices: [
      ...fileNotices,
      ...(operatorNamed.length > 0
        ? [`claude-settings-flag-first-party-ignored: ${firstPartyNotice('the --settings value', operatorNamed, 'its env')}`
          + 'Its other env entries apply.']
        : []),
      ...(operatorCredentials.length > 0
        ? [`claude-settings-flag-credential-in-use: ${credentialInUseNotice('the --settings value', operatorCredentials, 'its env')}`]
        : []),
      ...operatorLowerTierNotices,
      ...(Object.hasOwn(operatorEnv, ENDPOINT)
        ? ['claude-settings-flag-endpoint-ignored: the --settings value sets ANTHROPIC_BASE_URL in its env, '
          + 'and it is ignored: the connection decides every session\'s endpoint. Its other env entries apply. '
          + 'To use a different endpoint, set the base URL on the connection itself.']
        : []),
      ...(toggles.length > 0
        ? [`claude-settings-flag-provider-toggle-ignored: the --settings value sets ${toggles.join(', ')} in its env, `
          + 'and it is ignored: the connection decides every session\'s provider. Its other env entries apply. '
          + 'To use a different provider, choose it on the connection itself.']
        : []),
    ],
  };
}

/** A settings file's top-level object, or `undefined` — callers test names for presence only; a value is never read out. */
function fileSettings(file: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A settings file's `env` object, or `undefined`; presence only, as above. */
function fileEnv(file: string): Record<string, unknown> | undefined {
  const settings = fileSettings(file);
  return settings && isPlainObject(settings.env) ? settings.env : undefined;
}

/** The pinned names a settings file's `env` sets — presence only, a value is never read out. */
function filePinnedNames(file: string): { endpoint: boolean; toggles: string[] } {
  const env = fileEnv(file);
  return env ? { endpoint: Object.hasOwn(env, ENDPOINT), toggles: namedToggles(env) } : { endpoint: false, toggles: [] };
}

/**
 * The settings files a child given these options loads: user = `<CLAUDE_CONFIG_DIR>/settings.json`
 * (the Workspace's; `~/.claude` without one), project and local = `<cwd>/.claude/settings(.local).json`,
 * each only when `settingSources` includes it (unset = all three, the SDK's default).
 */
function claudeLoadedSettingsFiles(options: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  settingSources?: readonly string[];
}): string[] {
  const sources = options.settingSources ?? ['user', 'project', 'local'];
  const home = options.env?.HOME;
  const userDir = options.env?.CLAUDE_CONFIG_DIR ?? (home ? join(home, '.claude') : undefined);
  const files: string[] = [];
  if (sources.includes('user') && userDir) files.push(join(userDir, 'settings.json'));
  if (options.cwd && sources.includes('project')) files.push(join(options.cwd, '.claude', 'settings.json'));
  if (options.cwd && sources.includes('local')) files.push(join(options.cwd, '.claude', 'settings.local.json'));
  return files;
}

/**
 * F1.1008 — the same files, known BEFORE the spawn's options exist, so the pin above can read them:
 * `CLAUDE_CONFIG_DIR` re-derived from the merged environment the way `buildClaudeSubprocessEnv` derives it
 * (C3.273 does the same for the debug log), with the non-creating {@link workspaceClaudeConfigDirPath}.
 */
export function claudeSpawnSettingsFiles(input: {
  cwd: string | undefined;
  settingSources: readonly string[] | undefined;
  envOverrides: Record<string, string> | undefined;
}): string[] {
  const env: Record<string, string | undefined> = { ...process.env, ...input.envOverrides };
  const workspaceConfigDir = workspaceClaudeConfigDirPath(env.NESSY_WORKSPACE_ID);
  if (workspaceConfigDir) env.CLAUDE_CONFIG_DIR = workspaceConfigDir;
  return claudeLoadedSettingsFiles({ cwd: input.cwd, env, settingSources: input.settingSources });
}

/**
 * The settings files THIS spawn's child loads that set `env.ANTHROPIC_BASE_URL`,
 * each named once on the transcript and recorded for the configuration doctor
 * beside F1.966's launch-environment record (`config/storage.ts`); and those that
 * set a provider toggle (F1.1006), named on the transcript with the toggle names
 * and listed for the doctor by path and toggle name (F1.1009).
 *
 * Read from the finished options ({@link claudeLoadedSettingsFiles}), so the
 * files are the ones the child is told to load. Informational only — the pin
 * above holds whether or not this finds a file. (The first-party and credential notices and their
 * doctor records, F1.1017 and F1.1043, come from the pin itself, which reads the files for it.)
 */
export function claudeSettingsFileEndpointNotices(
  options: Pick<Options, 'cwd' | 'env' | 'settingSources'>,
): string[] {
  const found = claudeLoadedSettingsFiles(options).map(file => ({ file, ...filePinnedNames(file) }));
  const naming = found.filter(entry => entry.endpoint).map(entry => entry.file);
  const notices: string[] = [];
  if (naming.length > 0) {
    recordIgnoredClaudeSettingsFileEndpoint(naming);
    notices.push(
      `claude-settings-file-endpoint-ignored: ${naming.join(', ')} ${naming.length === 1 ? 'sets' : 'set'} `
      + 'ANTHROPIC_BASE_URL in env, and it is ignored: the connection decides every session\'s endpoint. '
      + 'To use a different endpoint, set the base URL on the connection itself.',
    );
  }
  // F1.1006 — told on the transcript; F1.1009 — and listed for the doctor under each toggle's own name.
  for (const { file, toggles } of found) {
    if (toggles.length === 0) continue;
    recordIgnoredClaudeSettingsFileProviderToggles(file, toggles);
    notices.push(
      `claude-settings-file-provider-toggle-ignored: ${file} sets ${toggles.join(', ')} in env, and it is ignored: `
      + 'the connection decides every session\'s provider. To use a different provider, choose it on the connection itself.',
    );
  }
  return notices;
}
