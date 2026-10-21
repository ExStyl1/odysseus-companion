import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { McpOAuthConfig, SdkMcpServerConfig } from '../agent/backend/types.ts';
import {
  expandConfigVariables,
  expandConfigVariablesInRecord,
  mcpToolTimeoutMs,
  normalizeMcpTransportAlias,
} from './server-config-values.ts';

export const PROJECT_MCP_CONFIG_FILE = '.mcp.json';

export type ProjectMcpWarningHandler = (message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return undefined;
  return value;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, entryValue]) => typeof entryValue !== 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * The `oauth` object of one server entry (`mcp.md:715`, `:735`).
 *
 * A malformed field NEVER sinks the server. `parseProjectMcpServer` returns
 * `null` only for an entry it cannot connect at all (unknown `type`, missing
 * `url`/`command`), and dropping a whole working server because an operator
 * mistyped an optional auth hint would be a much worse failure than ignoring
 * the hint and saying so. Unknown keys inside `oauth` are ignored for the same
 * reason: the object is documented with two fields today and will grow.
 *
 * `problems` collects operator-facing reasons; the caller names the server.
 */
function parseOAuthConfig(raw: unknown, problems: string[]): McpOAuthConfig | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    problems.push('"oauth" must be an object; it was ignored');
    return undefined;
  }

  const config: McpOAuthConfig = {};

  const metadataUrl = raw.authServerMetadataUrl;
  if (metadataUrl !== undefined) {
    // `mcp.md:731`: "The URL must use `https://`." Enforced here rather than at
    // the fetch, so an operator learns about it while reading the config file.
    let parsed: URL | null = null;
    if (typeof metadataUrl === 'string') {
      try {
        parsed = new URL(metadataUrl);
      } catch {
        parsed = null;
      }
    }
    if (!parsed) {
      problems.push('"oauth.authServerMetadataUrl" is not a valid URL; it was ignored');
    } else if (parsed.protocol !== 'https:') {
      problems.push('"oauth.authServerMetadataUrl" must use https://; it was ignored');
    } else {
      config.authServerMetadataUrl = parsed.toString();
    }
  }

  const scopes = raw.scopes;
  if (scopes !== undefined) {
    // `mcp.md:735`: "The value is a single space-separated string". An array is
    // the mistake worth naming, because it is what the field looks like it wants.
    if (typeof scopes !== 'string') {
      problems.push('"oauth.scopes" must be a single space-separated string; it was ignored');
    } else if (scopes.trim().length > 0) {
      config.scopes = scopes.trim().split(/\s+/).join(' ');
    }
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * `mcp.md:795-818`: `headersHelper` is a shell command that generates dynamic
 * connection headers. Read as a STRING ONLY (anything else is named in
 * `problems`), and NEVER run through `expand()` — the documented expansion
 * locations (`mcp.md:459-460`) are `command`, `args`, `env`, `url` and
 * `headers`; `headersHelper` is not one of them, and its own `${VAR}`
 * references belong to the shell it runs in.
 */
function parseHeadersHelper(
  raw: unknown,
  problems: string[],
): { headersHelper: { command: string } } | Record<string, never> {
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || raw.length === 0) {
    problems.push('"headersHelper" must be a non-empty shell command string; it was ignored');
    return {};
  }
  return { headersHelper: { command: raw } };
}

function parseProjectMcpServer(
  raw: unknown,
  missing: string[],
  problems: string[],
  options: { projectDirectory?: string } = {},
): SdkMcpServerConfig | null {
  if (!isRecord(raw)) return null;

  // Documented `.mcp.json` field: a per-server wall clock for one tool call, in
  // milliseconds. Surfaces as the pool's own `toolTimeoutMs`.
  const toolTimeoutMs = mcpToolTimeoutMs(raw.timeout);
  const timeout = toolTimeoutMs !== undefined ? { toolTimeoutMs } : {};
  // Documented `.mcp.json` field: pin this server's tools past tool search.
  const pinned = raw.alwaysLoad === true ? { alwaysLoad: true as const } : {};

  // Documented expansion locations: `command`, `args`, `env`, `url`, `headers`.
  // An unresolvable reference keeps its `${VAR}` text and is reported, so a
  // missing variable refuses visibly instead of becoming a blank auth header.
  const environment = process.env;
  const expand = (value: string): string => {
    const result = expandConfigVariables(value, environment);
    for (const name of result.missing) if (!missing.includes(name)) missing.push(name);
    return result.value;
  };
  const expandRecord = (values: Record<string, string>): Record<string, string> => {
    const result = expandConfigVariablesInRecord(values, environment);
    for (const name of result.missing) if (!missing.includes(name)) missing.push(name);
    return result.values;
  };

  // `mcp.md:83` / `agent-sdk/mcp.md:378`: JSON configs accept `streamable-http`
  // as an alias for `http`; folded here so the emitted value is one the
  // `SdkMcpServerConfig` union already allows.
  const type = normalizeMcpTransportAlias(raw.type);
  if (type === 'http' || type === 'sse') {
    if (typeof raw.url !== 'string') return null;
    const headers = readStringRecord(raw.headers);
    // Documented `.mcp.json` field: OAuth discovery override and pinned scopes.
    // `mcp.md:707` scopes the OAuth flags to HTTP and SSE — "They have no effect
    // on stdio servers" — and `:138` says WebSocket "supports neither".
    const oauth = parseOAuthConfig(raw.oauth, problems);
    return {
      type,
      url: expand(raw.url),
      ...(headers ? { headers: expandRecord(headers) } : {}),
      ...parseHeadersHelper(raw.headersHelper, problems),
      ...(oauth ? { oauth } : {}),
      ...timeout,
      ...pinned,
    };
  }

  // `mcp.md:147`: "The `type: \"ws\"` entry accepts the same `url`, `headers`,
  // `headersHelper`, `timeout`, and `alwaysLoad` fields as `http`."
  if (type === 'ws') {
    if (typeof raw.url !== 'string') return null;
    const headers = readStringRecord(raw.headers);
    if (raw.oauth !== undefined) {
      // `mcp.md:138`: WebSocket "supports neither" OAuth nor `--transport`.
      problems.push('"oauth" has no effect on a ws server (authentication is header-only); it was ignored');
    }
    return {
      type: 'ws',
      url: expand(raw.url),
      ...(headers ? { headers: expandRecord(headers) } : {}),
      ...parseHeadersHelper(raw.headersHelper, problems),
      ...timeout,
      ...pinned,
    };
  }

  if (type === undefined || type === 'stdio') {
    if (typeof raw.command !== 'string' || raw.command.length === 0) return null;
    const args = readStringArray(raw.args);
    const env = readStringRecord(raw.env);
    // `whats-new/2026-w20.md:87` / `mcp.md:110`: every stdio server receives
    // `CLAUDE_PROJECT_DIR` (and the Nessy spelling) IN ITS SPAWN ENVIRONMENT.
    // Deliberately NOT in the `${VAR}` expansion environment above: `mcp.md:115`
    // — "This variable is set in the server's environment, not in Claude Code's
    // own environment, so referencing it via `${VAR}` expansion in the
    // `command` or `args` of a project-scoped `.mcp.json` entry … requires a
    // default such as `${CLAUDE_PROJECT_DIR:-.}`." A bare token therefore stays
    // literal-with-warning; only the spawned process sees the value. The
    // entry's own `env` spreads LAST so its values win.
    const projectDirEnv = options.projectDirectory
      ? {
          NESSY_PROJECT_DIR: options.projectDirectory,
          CLAUDE_PROJECT_DIR: options.projectDirectory,
        }
      : undefined;
    const mergedEnv = projectDirEnv || env
      ? { ...projectDirEnv, ...(env ? expandRecord(env) : {}) }
      : undefined;
    return {
      type: 'stdio',
      command: expand(raw.command),
      ...(args ? { args: args.map(expand) } : {}),
      ...(mergedEnv ? { env: mergedEnv } : {}),
      ...timeout,
      ...pinned,
    };
  }

  return null;
}

/**
 * The five server names Claude reserves for its own built-ins
 * (`mcp.md#configuration-warnings`, verbatim): "Claude Code reserves the names
 * of its built-in servers, including `workspace`, `claude-in-chrome`,
 * `computer-use`, `Claude Preview`, and `Claude Browser`. If your configuration
 * defines a server with a reserved name, Claude Code skips it at load time and
 * shows a warning asking you to rename it."
 *
 * ## We WARN and keep loading; claude's own child SKIPS. That is deliberate.
 *
 * The reservation exists to protect a runtime's OWN built-in servers, and ours
 * are the `dp` family (`builtin-dp-servers.ts`) — not one of these five. Copying
 * the skip would refuse a perfectly good server named `workspace` to protect a
 * built-in this fork does not have, and our own name collisions already have a
 * mechanism that yields the BUILT-IN rather than the configured entry
 * (`builtin_dp_mcp.wire_name_taken`).
 *
 * But the divergence is real and it is not ours to erase: on the
 * `claude-runtime` the SDK child enforces this list itself, and its warning is
 * rendered in the CLI's own surface, which we do not host. So a server named
 * one of these five loads on Pi and codex and silently does not on claude —
 * which is exactly the silent divergence the native-first rule says to make
 * HONEST when it cannot be made uniform. Hence: named warning, no skip.
 *
 * Matched EXACTLY, case included. The page gives mixed-case spellings
 * (`workspace` lowercase beside `Claude Preview`) and says nothing about
 * folding, so folding would be invention.
 */
export const CLAUDE_RESERVED_MCP_SERVER_NAMES: readonly string[] = Object.freeze([
  'workspace',
  'claude-in-chrome',
  'computer-use',
  'Claude Preview',
  'Claude Browser',
]);

/** The reserved name a slug collides with, or `undefined`. */
export function reservedMcpServerName(slug: string): string | undefined {
  return CLAUDE_RESERVED_MCP_SERVER_NAMES.find(name => name === slug);
}

/**
 * Field labels of one raw server entry whose text carries hidden leading or
 * trailing whitespace (`mcp.md#configuration-warnings`, verbatim): "Claude Code
 * warns when an MCP config value carries hidden leading or trailing whitespace,
 * which often comes from pasting a token with a trailing newline. Claude Code
 * checks `command`, `url`, each `args` entry, and the values and key names under
 * `env` and `headers` … naming the affected fields without echoing their values
 * … Claude Code doesn't trim the whitespace and uses the values exactly as
 * written."
 *
 * Three properties of that sentence are load-bearing and each is easy to get
 * wrong in the direction that looks helpful:
 *
 *  - **The RAW entry, before `${VAR}` expansion.** Whitespace the operator can
 *    edit is whitespace in the file; whitespace that arrives inside an expanded
 *    variable is not a configuration mistake and its value is frequently a
 *    secret.
 *  - **Names, never values.** The label is the field path. A whitespace-bearing
 *    KEY is the one case where the offending text must appear — there is no
 *    other way to point at it — so it is quoted and marked as a key.
 *  - **No trimming.** Reporting and repairing are different acts; repairing
 *    silently would make the next 401 unexplainable.
 *
 * `String.prototype.trim` is the right comparator rather than a `\s` regex: it
 * removes the Unicode whitespace set plus `U+FEFF`, which is precisely the
 * "hidden" part — a byte-order mark pasted ahead of a token is invisible in
 * every editor this file is edited in.
 */
export function whitespaceBearingMcpFields(rawServer: unknown): string[] {
  if (!isRecord(rawServer)) return [];
  const fields: string[] = [];
  const carries = (value: unknown): value is string =>
    typeof value === 'string' && value !== value.trim();

  for (const key of ['command', 'url'] as const) {
    if (carries(rawServer[key])) fields.push(key);
  }
  if (Array.isArray(rawServer.args)) {
    rawServer.args.forEach((entry, index) => {
      if (carries(entry)) fields.push(`args[${index}]`);
    });
  }
  for (const section of ['env', 'headers'] as const) {
    const record = rawServer[section];
    if (!isRecord(record)) continue;
    for (const [key, value] of Object.entries(record)) {
      if (key !== key.trim()) fields.push(`${section} key "${key}"`);
      if (carries(value)) fields.push(`${section}.${key}`);
    }
  }
  return fields;
}

export function parseMcpServersDocument(
  parsed: unknown,
  warn?: ProjectMcpWarningHandler,
  label = PROJECT_MCP_CONFIG_FILE,
  options: { projectDirectory?: string } = {},
): Record<string, SdkMcpServerConfig> {
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    warn?.(`Ignoring ${label}: expected a top-level mcpServers object`);
    return {};
  }

  const servers: Record<string, SdkMcpServerConfig> = {};
  for (const [slug, rawServer] of Object.entries(parsed.mcpServers)) {
    if (!slug) continue;
    // Both checks read the NAME and the RAW entry, so they are independent of
    // whether the entry parses — an operator who mistyped `type` still wants to
    // hear that the token below it has a trailing newline.
    const reserved = reservedMcpServerName(slug);
    if (reserved) {
      warn?.(`${label} server "${slug}" uses a name reserved for a built-in server. It still loads here, but a Claude Code session skips a server with this name — rename it to be safe on every runtime.`);
    }
    const whitespaceFields = whitespaceBearingMcpFields(rawServer);
    if (whitespaceFields.length) {
      warn?.(`${label} server "${slug}": leading or trailing whitespace in: ${whitespaceFields.join(', ')}. The values are used exactly as written — edit the configuration to remove it.`);
    }
    const missing: string[] = [];
    const problems: string[] = [];
    const config = parseProjectMcpServer(rawServer, missing, problems, options);
    if (config) {
      servers[slug] = config;
      // The server still loads, matching the documented behavior: the operator
      // gets a named warning and the unexpanded token, rather than a silently
      // blank value that only shows up later as a 401.
      if (missing.length) {
        warn?.(`${label} server "${slug}" references unset environment variables with no default: ${missing.join(', ')}. Set them or add a \${VAR:-default} fallback.`);
      }
      // An optional field the parser could not use is named rather than dropped
      // in silence — an ignored `oauth.scopes` is otherwise indistinguishable
      // from an unrestricted grant.
      for (const problem of problems) {
        warn?.(`${label} server "${slug}": ${problem}.`);
      }
    } else {
      warn?.(`Ignoring ${label} server "${slug}": unsupported MCP server config`);
    }
  }

  return servers;
}

export function loadProjectMcpServers(
  workspaceRootPath: string | undefined,
  warn?: ProjectMcpWarningHandler
): Record<string, SdkMcpServerConfig> {
  if (!workspaceRootPath) return {};

  const configPath = join(workspaceRootPath, PROJECT_MCP_CONFIG_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
    if (code !== 'ENOENT') {
      warn?.(`Failed to load ${PROJECT_MCP_CONFIG_FILE}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {};
  }
  // The workspace root doubles as the project directory for the stdio spawn-env
  // seeding (symmetry with the runtime materializer; this loader has no
  // production caller left).
  return parseMcpServersDocument(parsed, warn, PROJECT_MCP_CONFIG_FILE, {
    ...(workspaceRootPath ? { projectDirectory: workspaceRootPath } : {}),
  });
}
