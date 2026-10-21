/**
 * The built-in dp-backed MCP set (A7).
 *
 * `nessy-cli` does not compile a base MCP set into the binary — it ships
 * `deploy/async/.nessy/settings.json` whose `mcpServers` are plain stdio
 * commands `dp ai mcp <subcommand>`. `dp` is installed on the target machines
 * and already holds the user's token, so these servers need **no sign-in at
 * all**: they bypass npm, the marketplace, OAuth and coordinate derivation
 * entirely. This module is the desktop equivalent of that file.
 *
 * Two rules this module exists to keep:
 *
 * - **It never runs `dp`.** Resolution is a filesystem lookup: `dp-binary.ts`
 *   symbol `resolveDpRuntime` walks the four-rung ladder — `NESSY_DP`, the
 *   system `dp` (`PATH`, then `/usr/local/bin/dp`), `<CONFIG_DIR>/dp/bin/dp`,
 *   `<NESSY_HOME>/dp_latest/dp` — with `accessSync(X_OK)` alone (F1.363),
 *   so a machine without dp degrades to a named diagnostic instead of a crash
 *   or a hang, and a test never depends on the host having the binary or on
 *   network. Nothing on that path WRITES since F1.363: with no `DP_WORKDIR`
 *   dp keeps its own `~/.dp`, so the `<CONFIG_DIR>/dp/state` the ladder used
 *   to create is gone (`dp-binary.ts` symbol `resolveManagedWorkdir` says
 *   why).
 * - **It never touches `~/.nessy/dp_auth_creds.json`.** Each dp subprocess
 *   authenticates itself from dp's own session; this module passes no token,
 *   header, or credential of any kind — env carries only dp's own runtime
 *   switches.
 *
 * ## Where the set comes from
 *
 * Two measurements, both on 2026-07-31:
 *
 * 1. `dp ai mcp --help` on Spirit CLI **13.32.4** — the 31 subcommands recorded
 *    in `DP_AI_MCP_SUBCOMMANDS`. A server here must name one of them; anything
 *    else would be a command dp cannot run.
 * 2. `GET https://skills-market.t-tech.team/api/v1/plugins?pageSize=200` — the
 *    four published `nessy-default-extension` rows and their declared
 *    `capabilities.mcpServers`. The canonical row
 *    (`nestor/nessy-cli-extensions`, v1.0.9) declares 14; the other three
 *    declare 7, 10 and 14.
 *
 * The set below is the **union of those four rows, restricted to names that map
 * onto a real `dp ai mcp` subcommand**, and it keeps the catalogue's own wire
 * names so a user moving between nessy-cli and Nessy Desktop sees the same
 * server names.
 *
 * ## What is deliberately NOT here
 *
 * See `BUILTIN_DP_MCP_EXCLUSIONS`. Briefly: `whiteboard` and `meetings` are not
 * `dp ai mcp` subcommands at all — they can only be reached through
 * `dp ai mcp remote --url <URL>`, and we do not know their URLs, so shipping a
 * guessed one would fabricate a contract. `context7` is an `npx` server, which
 * is exactly the sign-in-and-npm path this set exists to bypass.
 */

import type { SdkMcpServerConfig } from '../agent/backend/types.ts';
import { resolveDpBinary, resolveDpRuntime } from '../auth/dp/dp-binary.ts';
import { dpRuntimeEnvironment } from '../auth/dp/dp-runtime.ts';

/**
 * `dp ai mcp --help`, Spirit CLI 13.32.4, verified 2026-07-31 on a machine with
 * `dp` at `/usr/local/bin/dp`. `help` is dropped — it is not a server.
 *
 * This constant is evidence, not configuration: it is what makes
 * "`BUILTIN_DP_MCP_SERVERS` only names subcommands dp actually has" a check a
 * test can run without executing dp. dp grows subcommands (the plan's own brief
 * recorded 20; this release has 31), so re-run the help and extend the list
 * rather than trimming a server to fit it.
 */
export const DP_AI_MCP_SUBCOMMANDS: readonly string[] = Object.freeze([
  'info', 'cmd', 'git-s', 'merge-request', 'fs', 'remote', 'rtd', 'deploy',
  'kube', 'sage', 'skills', 'cdn', 'jira', 'repo', 'gitlab', 'dbauth',
  'code-interpreter', 'allure', 'wixie', 'code-search', 'qwarium', 'tihon',
  'artifacts', 'tracker', 'mail', 'finedog', 'nezabudka', 's3aas', 'kaas',
  'time',
]);

export interface BuiltinDpMcpServerDefinition {
  /**
   * Wire name, taken from the marketplace `nessy-default-extension` rows rather
   * than invented, so one name means one server across nessy-cli and Nessy
   * Desktop.
   */
  name: string;
  /** The `dp ai mcp <subcommand>` this server runs. */
  subcommand: string;
  /** dp's own one-line description of the subcommand. */
  description: string;
  /**
   * The default when the user has expressed no preference.
   *
   * **Every server is `false`, by owner decision 2026-08-01**: "вшить весь
   * базовый набор но по дефолту выключен, юзер сам решит что ему включать" —
   * embed the whole set, off by default, the user decides what to enable.
   *
   * Six were briefly `true` (the ones every published `nessy-default-extension`
   * row declares). That cost six stdio subprocesses per session pool AND per
   * browse pool, in every workspace, before any preference existed to stop
   * them — and it broke thirteen exact-map assertions on every machine that has
   * `dp` while CI, which has none, stayed green on the same commit.
   *
   * Because nothing is on, the fold may run unconditionally and simply produce
   * an empty set until the user opts in. That is what keeps the rest of the
   * repository green **by construction** rather than by withholding the fold.
   */
  defaultEnabled: boolean;
}

/**
 * The whole set `dp ai mcp` exposes, in stable display order: the six every
 * published `nessy-default-extension` row declares first, then the rest
 * alphabetically by wire name. Built from the live `dp ai mcp --help` output
 * (Spirit CLI 13.32.4), not from the marketplace rows — the catalogue lists
 * twelve, the CLI serves twenty-nine.
 *
 * `info` and `help` are not servers. `remote` is excluded: it is a proxy that
 * requires a `--url` argument, so it cannot stand as a zero-configuration entry
 * — see `BUILTIN_DP_MCP_EXCLUSIONS`.
 */
export const BUILTIN_DP_MCP_SERVERS: readonly BuiltinDpMcpServerDefinition[] = Object.freeze([
  { name: 'codeSearch', subcommand: 'code-search', description: 'Tool for searching code, commits, and groups in GitLab', defaultEnabled: false },
  { name: 'dpGitlab', subcommand: 'gitlab', description: 'Tool for working with repositories, merge-requests, pipelines and jobs', defaultEnabled: false },
  { name: 'dpJira', subcommand: 'jira', description: 'Tool for working with Jira issues', defaultEnabled: false },
  { name: 'dpMR', subcommand: 'merge-request', description: 'Merge request creation MCP tool server', defaultEnabled: false },
  { name: 'dpSage', subcommand: 'sage', description: 'Tool for working with logs and metrics', defaultEnabled: false },
  { name: 'dpWiki', subcommand: 'wixie', description: 'Tool for exporting wiki.tcsbank.ru documents to PDF or Markdown, with recursive page export and CQL search', defaultEnabled: false },
  { name: 'dpAllure', subcommand: 'allure', description: 'Tool for working with Allure TestOps', defaultEnabled: false },
  { name: 'dpArtifacts', subcommand: 'artifacts', description: 'Tool for working with package managers and package/container registries', defaultEnabled: false },
  { name: 'dpCdn', subcommand: 'cdn', description: 'CLI plugin for working with CDNaaS', defaultEnabled: false },
  { name: 'dpCmd', subcommand: 'cmd', description: 'Run commands MCP tool server', defaultEnabled: false },
  { name: 'dpCodeInterpreter', subcommand: 'code-interpreter', description: 'Tool for working with remote code interpreter and sandboxes', defaultEnabled: false },
  { name: 'dpDbAuth', subcommand: 'dbauth', description: 'Tool for get session account from DBaaS', defaultEnabled: false },
  { name: 'dpDeploy', subcommand: 'deploy', description: 'Spirit Deploy helper tool', defaultEnabled: false },
  { name: 'dpFinedog', subcommand: 'finedog', description: 'Tool for working with Finedog incidents, units, teams and post-analyses', defaultEnabled: false },
  { name: 'dpFs', subcommand: 'fs', description: 'File system MCP tool server', defaultEnabled: false },
  { name: 'dpGit', subcommand: 'git-s', description: 'Git MCP tool server', defaultEnabled: false },
  { name: 'dpKaas', subcommand: 'kaas', description: 'Tool for working with KaaS', defaultEnabled: false },
  { name: 'dpMail', subcommand: 'mail', description: 'Tool for working with corporate email', defaultEnabled: false },
  { name: 'dpNezabudka', subcommand: 'nezabudka', description: 'Tool for working with personal and shared notes and arrangements', defaultEnabled: false },
  { name: 'dpQwarium', subcommand: 'qwarium', description: 'Qwarium remote developer environment: manage and connect to your environments', defaultEnabled: false },
  { name: 'dpRepo', subcommand: 'repo', description: 'Tool for creating repositories from templates', defaultEnabled: false },
  { name: 'dpRtd', subcommand: 'rtd', description: 'Runtime diagnostic tools', defaultEnabled: false },
  { name: 'dpS3aas', subcommand: 's3aas', description: 'Tool for working with S3aaS', defaultEnabled: false },
  { name: 'dpSkills', subcommand: 'skills', description: 'Tool for installing skills-market skills', defaultEnabled: false },
  { name: 'dpTihon', subcommand: 'tihon', description: 'Tool for working with Tihon', defaultEnabled: false },
  { name: 'SpiritK8s', subcommand: 'kube', description: 'Tool for working with kubernetes', defaultEnabled: false },
  { name: 't-tracker', subcommand: 'tracker', description: 'Tool for working with T-Tracker', defaultEnabled: false },
  { name: 'time', subcommand: 'time', description: 'Tool for working with Time messenger', defaultEnabled: false },
].map(entry => Object.freeze(entry)));

/**
 * Names the marketplace rows declare that this set deliberately does not carry.
 *
 * Kept as data rather than prose because the obvious "fix" — adding them — is
 * wrong for a reason that is invisible from the catalogue alone.
 */
export const BUILTIN_DP_MCP_EXCLUSIONS: readonly { name: string; reason: string }[] = Object.freeze([
  Object.freeze({
    name: 'remote',
    reason: '`dp ai mcp remote` is a proxy, not a server: it requires `--url <URL>` for the Streamable HTTP endpoint it fronts, so it cannot be a zero-configuration entry in a set whose whole point is that nothing needs configuring',
  }),
  Object.freeze({
    name: 'whiteboard',
    reason: 'not a `dp ai mcp` subcommand; reachable only through `dp ai mcp remote --url <URL>`, and the URL is not published anywhere we can read',
  }),
  Object.freeze({
    name: 'meetings',
    reason: 'not a `dp ai mcp` subcommand; same remote-proxy situation as whiteboard',
  }),
  Object.freeze({
    name: 'context7',
    reason: 'an npx server, not a dp one — it needs the npm path this dp-backed set exists to bypass, and it already installs through the marketplace',
  }),
]);

export type BuiltinDpMcpDiagnosticCode =
  /** `dp` is not installed, so the whole set is unavailable. */
  | 'builtin_dp_mcp.dp_not_found'
  /** A built-in name is already taken by a user/plugin server; the user's wins. */
  | 'builtin_dp_mcp.wire_name_taken'
  /**
   * Some other server already runs the SAME `dp ai mcp <subcommand>` under a
   * different wire name — an installed `nessy-default-extension` is the case
   * this exists for. The built-in stands down so the identical tools are not
   * served twice.
   */
  | 'builtin_dp_mcp.subcommand_taken';

export interface BuiltinDpMcpDiagnostic {
  code: BuiltinDpMcpDiagnosticCode;
  /** Operator-facing text. Never carries a token, header or path to creds. */
  message: string;
  /** Wire names the diagnostic is about, when it is about specific servers. */
  servers?: string[];
}

export interface MaterializeBuiltinDpMcpOptions {
  /**
   * Per-server switch. A name mapped to `false` is withheld from the
   * materialized set; a name mapped to `true` is included even when its
   * definition is off by default. Names absent from the record keep their
   * definition default, and names that are not in the set are ignored.
   *
   * The user's persisted answer to this is the `builtinDpMcpServers.enabled`
   * block of `config.json`; read it with
   * `getBuiltinDpMcpServerPreferences()` (`config/storage.ts`) and pass it
   * here. This module does NOT read config itself — it is materialized once
   * per pool sync, and a settings read hidden in a default would make every
   * caller's behaviour depend on the host's config file.
   */
  enabled?: Readonly<Record<string, boolean>>;
  /**
   * Where `dp` is, or `null` when it is not installed. Injected by tests; the
   * default is a filesystem lookup that NEVER executes dp.
   */
  resolveDpPath?: () => string | null;
  /**
   * Env attached to every materialized server config. Defaults to
   * `dpRuntimeEnvironment(resolveDpRuntime().workdir)` (DA1.52): HOME + the
   * non-interactive dp switches (DP_NO_WARNINGS — a dp update banner on stdout breaks MCP stdio
   * framing; DP_AI_MCP_SKIP_LOGIN — an unauthorized dp must fail fast, not open
   * a browser) + DP_WORKDIR when the state root resolves. Surfaces that only
   * need topology (the settings view) and host-independent tests pass `{}`.
   * Never a token, a header, or the gateway JWT — the module contract holds.
   */
  runtimeEnv?: Readonly<Record<string, string>>;
}

export interface BuiltinDpMcpMaterialization {
  /** False when `dp` is missing — then `servers` is empty and a diagnostic says why. */
  available: boolean;
  /** wire name → stdio server config, ready to merge into the pool's desired set. */
  servers: Record<string, SdkMcpServerConfig>;
  /** Names withheld by the per-server switch, in set order. */
  disabledServers: string[];
  diagnostics: BuiltinDpMcpDiagnostic[];
}

/** PATH/fallback lookup, never an exec. Absent dp is `null`, never a throw. */
function defaultResolveDpPath(): string | null {
  try {
    return resolveDpBinary();
  } catch {
    return null;
  }
}

/**
 * The state root the dp children must run against, from the SAME record that
 * chose the binary (DA1.6 item 4). `resolveDpPath` above stays the injected
 * seam for `dpPath` itself, so the ladder is asked again here.
 *
 * WHY THE CATCH, and it is a correction to the hand-off rather than defensive
 * noise: `resolveDpStateRoot()` — what this replaces — never throws, while
 * `resolveDpRuntime()` throws `DpNotFound` when no rung is runnable, and the
 * injected `resolveDpPath` seam lets a caller supply a path on a machine where
 * the real ladder finds nothing. This module's own contract, two bullets up, is
 * that such a machine "degrades to a named diagnostic instead of a crash".
 * `undefined` is exactly the answer `resolveDpStateRoot()` gave there — dp uses
 * its own `~/.dp` — so the degrade is the old behaviour and not an
 * approximation of it.
 *
 * NOT A DEFECT TODAY, stated so the next reader knows what changed: with
 * `~/.dp` present the two disagree harmlessly — the old call returned the
 * realpath of `~/.dp` and the record returns `undefined`, and both make dp use
 * `~/.dp`. It matters on a machine with NO `~/.dp`, where the old call returned
 * `undefined` (no `DP_WORKDIR` at all) and the record returns the managed state
 * root the broker's own execs already use.
 */
function resolveDpWorkdir(): string | undefined {
  try {
    return resolveDpRuntime().workdir;
  } catch {
    return undefined;
  }
}

/**
 * The managed-MCP identity of a built-in — the shape `isManagedMcpServerAllowed`
 * matches on, minus the wire name its caller already holds.
 *
 * `command` is the LOGICAL `dp ai mcp <sub>` argv, and it stays the primary
 * spelling rather than the resolved one, for the reason it always did: the
 * catalog mirror (`storage-runtime.ts:builtinDpMcpCapabilityRecords`) may never
 * resolve dp — a PATH scan on every capability resolve, and every turn resolves
 * — so the logical argv is the only spelling BOTH the mirror and the runtime
 * fold can produce. One definition, used by both, so `managed-mcp.md`'s
 * enforceable command dimension means the same thing on the display path and on
 * the spawn path.
 *
 * P3.217 adds the OTHER true spelling where a caller has it. A built-in is
 * configured as `dp ai mcp <sub>` and SPAWNED as `<resolved dp> ai mcp <sub>`,
 * so a denylist entry written the way `which dp` prints it matched nothing at
 * all: a rule that looked correct, read correct in the UI, and did not control.
 * `spawnCommand` is that argv, and the fold passes the one it just materialized,
 * so the gate judges what will actually run without resolving anything itself.
 *
 * The mirror deliberately passes none. Resolving dp there would make a DISPLAY
 * projection depend on machine state — green on a developer's laptop, different
 * on CI, which has no dp (see this file's header) — and the direction it errs in
 * is the safe one: the row over-reports availability while the fold withholds
 * the server. `managedMcpEntryNames` already states that disposition for the
 * consumers that hold less than the whole identity.
 */
export function builtinDpMcpServerIdentity(
  definition: BuiltinDpMcpServerDefinition,
  spawnCommand?: readonly string[],
): { transport: 'stdio'; command: string[]; alternateCommands?: readonly string[][] } {
  const command = ['dp', 'ai', 'mcp', definition.subcommand];
  // P3.217 — the SPAWNED argv is a second true spelling of the same server, and
  // an administrator who writes the deny the way `which dp` prints it means this
  // one. Added only when the caller already holds it (the fold does; the mirror
  // does not), and only when it actually differs, so the common case allocates
  // no extra spelling and the identity stays the one shape both paths compare.
  const alternate = spawnCommand === undefined || spawnCommand.length === 0
    ? undefined
    : [...spawnCommand];
  return alternate === undefined || alternate.join('\u0000') === command.join('\u0000')
    ? { transport: 'stdio', command }
    : { transport: 'stdio', command, alternateCommands: [alternate] };
}

/** The effective on/off state of one built-in server. */
export function isBuiltinDpMcpServerEnabled(
  name: string,
  overrides?: Readonly<Record<string, boolean>>,
): boolean {
  const definition = BUILTIN_DP_MCP_SERVERS.find(entry => entry.name === name);
  if (!definition) return false;
  const override = overrides?.[name];
  return typeof override === 'boolean' ? override : definition.defaultEnabled;
}

/**
 * Build the desired built-in dp server set.
 *
 * The command is the RESOLVED absolute dp path rather than the bare word `dp`,
 * because an agent subprocess does not necessarily inherit the PATH that found
 * it. dp authenticates itself: no token, header, or credential of any kind is
 * ever passed — env carries only dp's own runtime switches.
 */
export function materializeBuiltinDpMcpServers(
  options: MaterializeBuiltinDpMcpOptions = {},
): BuiltinDpMcpMaterialization {
  const disabledServers = BUILTIN_DP_MCP_SERVERS
    .filter(definition => !isBuiltinDpMcpServerEnabled(definition.name, options.enabled))
    .map(definition => definition.name);

  const dpPath = (options.resolveDpPath ?? defaultResolveDpPath)();
  if (!dpPath) {
    return {
      available: false,
      servers: {},
      disabledServers,
      diagnostics: [{
        code: 'builtin_dp_mcp.dp_not_found',
        message: 'The built-in Nessy MCP servers need the `dp` CLI, which was not found in any of the four '
          + 'places Nessy looks: the path in NESSY_DP, the system `dp` (PATH, then /usr/local/bin/dp), '
          + '<CONFIG_DIR>/dp/bin/dp and <NESSY_HOME>/dp_latest/dp. Install Spirit CLI (`dp`), or point '
          + 'NESSY_DP at the copy you want, and reopen the workspace; nothing else in the app is affected.',
      }],
    };
  }

  // DA1.6 item 4, landed by DA1.52 · ONE record, so the binary above and this
  // state root can never come from different rungs of the ladder.
  const runtimeEnv = options.runtimeEnv ?? dpRuntimeEnvironment(resolveDpWorkdir());
  const servers: Record<string, SdkMcpServerConfig> = {};
  for (const definition of BUILTIN_DP_MCP_SERVERS) {
    if (!isBuiltinDpMcpServerEnabled(definition.name, options.enabled)) continue;
    servers[definition.name] = {
      type: 'stdio',
      command: dpPath,
      args: ['ai', 'mcp', definition.subcommand],
      ...(Object.keys(runtimeEnv).length ? { env: { ...runtimeEnv } } : {}),
    };
  }

  return { available: true, servers, disabledServers, diagnostics: [] };
}

/**
 * The `dp ai mcp <subcommand>` an already-materialized server runs, or null.
 *
 * Matched on the ARGV TAIL alone, never on the command: a plugin-declared dp
 * server reaches materialization with its command rewritten to the supervised
 * host executable (`resolvePluginStdioExecutable` → `pluginNodeRuntime
 * .executables.dp.command`), so a `basename(command) === 'dp'` test would miss
 * exactly the servers this check exists to see.
 */
function dpAiMcpSubcommandOf(server: SdkMcpServerConfig): string | null {
  if (server.type !== 'stdio') return null;
  const args = server.args;
  if (!args || args.length < 3) return null;
  if (args[args.length - 3] !== 'ai' || args[args.length - 2] !== 'mcp') return null;
  return args[args.length - 1] ?? null;
}

/**
 * Fold the built-in set into an already-materialized server map.
 *
 * Two ways a built-in stands down, both YIELDING rather than throwing. This is
 * deliberately unlike `mergePinnedMcpServers`, which THROWS
 * `capability-mcp-wire-name-collision` — that is the right answer for two
 * configured servers fighting over one name, and the wrong one for a set the
 * user never asked for: `dpGitlab`, `dpJira` and `dpMR` are exactly the names an
 * existing user already has configured by hand, and a set that ships enabled by
 * default must not brick their workspace to announce itself.
 *
 * 1. **The wire name is taken.** The user's own source, project `.mcp.json`
 *    entry or plugin server keeps the name; the built-in is dropped.
 * 2. **The subcommand is already served** under some other wire name. An
 *    installed `nessy-default-extension` declares `dp ai mcp jira` as `jira`;
 *    folding `dpJira` in beside it would start a second identical subprocess and
 *    put the same tools in the model's budget twice, with two names for one
 *    thing. The extension is the user's explicit choice, so it wins.
 */
export function mergeBuiltinDpMcpServers(
  existing: Readonly<Record<string, SdkMcpServerConfig>>,
  builtin: Readonly<Record<string, SdkMcpServerConfig>>,
): { servers: Record<string, SdkMcpServerConfig>; diagnostics: BuiltinDpMcpDiagnostic[] } {
  const servers: Record<string, SdkMcpServerConfig> = { ...existing };
  const servedSubcommands = new Map<string, string>();
  for (const [wireName, server] of Object.entries(existing)) {
    const subcommand = dpAiMcpSubcommandOf(server);
    if (subcommand && !servedSubcommands.has(subcommand)) servedSubcommands.set(subcommand, wireName);
  }
  const nameTaken: string[] = [];
  const subcommandTaken: string[] = [];
  for (const [wireName, server] of Object.entries(builtin)) {
    if (wireName in servers) {
      nameTaken.push(wireName);
      continue;
    }
    const subcommand = dpAiMcpSubcommandOf(server);
    if (subcommand && servedSubcommands.has(subcommand)) {
      subcommandTaken.push(wireName);
      continue;
    }
    servers[wireName] = server;
  }
  const diagnostics: BuiltinDpMcpDiagnostic[] = [];
  if (nameTaken.length) {
    diagnostics.push({
      code: 'builtin_dp_mcp.wire_name_taken',
      message: `Your own MCP configuration already uses ${nameTaken.join(', ')}, so the built-in dp server of that name was not added. Rename yours, or switch the built-in one off, to remove this notice.`,
      servers: nameTaken,
    });
  }
  if (subcommandTaken.length) {
    const pairs = subcommandTaken
      .map(wireName => {
        const subcommand = dpAiMcpSubcommandOf(builtin[wireName]!);
        return `${wireName} (already served as ${servedSubcommands.get(subcommand!)})`;
      })
      .join(', ');
    diagnostics.push({
      code: 'builtin_dp_mcp.subcommand_taken',
      message: `These built-in dp servers were not added because an installed extension already runs the same dp command: ${pairs}.`,
      servers: subcommandTaken,
    });
  }
  return { servers, diagnostics };
}
