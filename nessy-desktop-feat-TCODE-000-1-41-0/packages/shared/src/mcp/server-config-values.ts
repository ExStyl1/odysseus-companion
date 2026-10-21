/**
 * Leaf helpers for reading scalar values out of MCP server configuration.
 *
 * Deliberately dependency-free: both `mcp/project-config.ts` and
 * `sources/server-builder.ts` need these, and routing them through either of
 * those modules would have dragged the Claude Agent SDK into `.mcp.json` parsing.
 */

/**
 * Documented floor on a per-server tool timeout: "Values below 1000 are
 * ignored." A sub-second ceiling would abort essentially every call, so it is
 * treated as unset rather than obeyed.
 */
export const MCP_MIN_TOOL_TIMEOUT_MS = 1_000;

/**
 * Fold the documented transport alias at the JSON parse boundary.
 *
 * `mcp.md:83`: "When configuring MCP servers via JSON in `.mcp.json`,
 * `~/.claude.json`, or `claude mcp add-json`, the `type` field accepts
 * `streamable-http` as an alias for `http`. The MCP specification uses the name
 * `streamable-http` for this transport, so configurations copied from server
 * documentation work without modification."
 *
 * One exact literal, no case folding: the doc names `streamable-http` and
 * nothing else. Every JSON reader of an MCP server map calls this so the four
 * sites cannot drift; the programmatic/typed transport unions stay `http`-only
 * (`agent-sdk/mcp.md:378` — "The programmatic `mcpServers` option accepts only
 * `\"http\"`"), which is why this folds the value instead of widening a union.
 */
export function normalizeMcpTransportAlias(value: unknown): unknown {
  return value === 'streamable-http' ? 'http' : value;
}

/** A configured per-server tool timeout, or `undefined` when it is unusable. */
export function mcpToolTimeoutMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= MCP_MIN_TOOL_TIMEOUT_MS
    ? Math.floor(value)
    : undefined;
}

/**
 * `${VAR}` and `${VAR:-default}`. A default may itself contain colons, so only
 * the FIRST `:-` separates the name from the default.
 */
const CONFIG_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * {@link CONFIG_VARIABLE} without `g`, for {@link referencesConfigVariable}.
 *
 * Built from the same `source` rather than written a second time: a predicate
 * that disagreed with the expander about what a reference IS would be worse
 * than no predicate, because it would answer confidently. `.test` on a global
 * regex is stateful (`lastIndex` survives the call), so it needs its own copy
 * rather than a reset every time.
 */
const CONFIG_VARIABLE_ONCE = new RegExp(CONFIG_VARIABLE.source);

/** Whether a configuration string carries at least one `${VAR}` reference. */
export function referencesConfigVariable(value: string): boolean {
  return CONFIG_VARIABLE_ONCE.test(value);
}

/**
 * Replace every `${VAR}` / `${VAR:-default}` reference with one fixed string,
 * consulting no environment at all.
 *
 * For the caller that has to reason about the SPAN a variable occupies rather
 * than the value it would take. The managed MCP denylist is the one we have:
 * `managed-mcp.md#how-policy-entries-expand` says a deny entry whose expansion
 * would change its URL scope "still matches", and the only span the guard may
 * widen is the one the variable owns — every literal character the
 * administrator typed still has to match.
 */
export function replaceConfigVariableReferences(value: string, replacement: string): string {
  return value.replace(CONFIG_VARIABLE, () => replacement);
}

export interface ConfigVariableExpansion {
  value: string;
  /** Names referenced without a default that the environment does not supply. */
  missing: readonly string[];
}

/**
 * Expand environment references in one configuration string.
 *
 * An empty or whitespace-only environment value counts as unset, matching how
 * the plugin runtime already treats a blank host value: a variable that exists
 * but carries nothing cannot satisfy a reference.
 *
 * `unset` decides what an unresolvable reference with no default leaves behind:
 * - `'literal'` keeps the `${VAR}` text, which is what a `.mcp.json` reader wants
 *   — a visible token plus a warning beats a blank auth header that yields a 401.
 * - `'empty'` substitutes the empty string, preserving the plugin branch's
 *   existing behavior, whose own `missingRequiredNames` gate inspects the
 *   RESOLVED environment and would read a literal token as a satisfied value.
 *
 * Either way the missing names are reported, so no caller has to infer them.
 */
export function expandConfigVariables(
  value: string,
  environment: Record<string, string | undefined>,
  unset: 'literal' | 'empty' = 'literal',
): ConfigVariableExpansion {
  const missing: string[] = [];
  const expanded = value.replace(CONFIG_VARIABLE, (token, name: string, fallback?: string) => {
    const resolved = environment[name];
    if (resolved !== undefined && resolved.trim() !== '') return resolved;
    if (fallback !== undefined) return fallback;
    if (!missing.includes(name)) missing.push(name);
    return unset === 'empty' ? '' : token;
  });
  return { value: expanded, missing };
}

export interface TrackedConfigVariableExpansion {
  values: Record<string, string>;
  /** Keys whose expanded value still carries an unresolvable `${VAR}` token. */
  unresolvedKeys: ReadonlySet<string>;
  /** Names referenced without a default that the environment does not supply. */
  missing: readonly string[];
}

/**
 * {@link expandConfigVariables} over a record, keeping the per-key trace that an
 * availability decision needs.
 *
 * {@link expandConfigVariablesInRecord} reports only the union of missing names,
 * which is enough to warn but not enough to decide whether one specific variable
 * is satisfied: in `'literal'` mode an unresolved reference leaves the non-empty
 * `${VAR}` text behind, so a blank-value test reads it as supplied. Callers that
 * gate on a named requirement must consult {@link TrackedConfigVariableExpansion.unresolvedKeys}
 * as well as the value.
 */
export function expandConfigVariablesTracked(
  values: Record<string, string> | undefined,
  environment: Record<string, string | undefined>,
): TrackedConfigVariableExpansion {
  const missing: string[] = [];
  const unresolvedKeys = new Set<string>();
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    const result = expandConfigVariables(value, environment);
    expanded[key] = result.value;
    if (result.missing.length) unresolvedKeys.add(key);
    for (const name of result.missing) if (!missing.includes(name)) missing.push(name);
  }
  return { values: expanded, unresolvedKeys, missing };
}

export interface McpDescriptorEnvironmentLayers {
  /** Plugin path placeholders (`${NESSY_PLUGIN_ROOT}` and friends). */
  plugin: Record<string, string>;
  /** Host names the descriptor explicitly retained. */
  forwarded: Record<string, string>;
  /** Names bound to a configured credential. */
  configured: Record<string, string>;
}

export interface McpDescriptorEnvironment {
  environment: Record<string, string>;
  /** Declared requirements that no layer satisfies. */
  missingRequiredNames: string[];
  /** Every referenced name with no default that no layer supplies. */
  missingReferenceNames: readonly string[];
}

/**
 * Resolve one MCP descriptor's environment: layer order, expansion, and the
 * requirement verdict.
 *
 * The single authority for that decision. The capability resolver precomputes
 * availability before a turn and `runtime-pool-servers` materializes the same
 * descriptor at connect time; when the two disagreed on either the layer order
 * or the `${VAR}` grammar, the precompute could report a server AVAILABLE that
 * the runtime then withheld — a `${TOKEN:-}` reference did exactly that.
 *
 * A required name is unsatisfied when its value is blank OR still holds an
 * unresolvable token: `mcp.md:477` keeps that token literal, and a literal is
 * non-empty, so the value test alone would read it as supplied.
 */
export function materializeMcpDescriptorEnvironment(
  descriptor: {
    environmentDefaults?: Record<string, string> | undefined;
    env?: Record<string, string> | undefined;
    requiredEnvironmentNames?: readonly string[] | undefined;
  },
  layers: McpDescriptorEnvironmentLayers,
): McpDescriptorEnvironment {
  const defaults = expandConfigVariablesTracked(descriptor.environmentDefaults, {
    ...layers.plugin,
    ...layers.forwarded,
  });
  const baseEnvironment = {
    ...layers.plugin,
    ...defaults.values,
    ...layers.forwarded,
    ...layers.configured,
  };
  const descriptorEnvironment = expandConfigVariablesTracked(descriptor.env, baseEnvironment);
  const environment = { ...baseEnvironment, ...descriptorEnvironment.values };
  // A key is unresolved only when the LAST writer left a token behind: a
  // default carrying `${VAR}` is irrelevant once a forwarded, configured or
  // descriptor value overwrites it.
  const unresolvedKeys = new Set<string>([
    ...[...defaults.unresolvedKeys].filter(key => !(key in layers.forwarded)
      && !(key in layers.configured)
      && !(key in descriptorEnvironment.values)),
    ...descriptorEnvironment.unresolvedKeys,
  ]);
  const missingReferenceNames = [...defaults.missing];
  for (const name of descriptorEnvironment.missing) {
    if (!missingReferenceNames.includes(name)) missingReferenceNames.push(name);
  }
  return {
    environment,
    missingRequiredNames: (descriptor.requiredEnvironmentNames ?? [])
      .filter(name => !environment[name]?.trim() || unresolvedKeys.has(name)),
    missingReferenceNames,
  };
}

/** {@link expandConfigVariables} over every value of a string record. */
export function expandConfigVariablesInRecord(
  values: Record<string, string>,
  environment: Record<string, string | undefined>,
  unset: 'literal' | 'empty' = 'literal',
): { values: Record<string, string>; missing: readonly string[] } {
  const missing: string[] = [];
  const expanded = Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const result = expandConfigVariables(value, environment, unset);
    for (const name of result.missing) if (!missing.includes(name)) missing.push(name);
    return [key, result.value];
  }));
  return { values: expanded, missing };
}

/**
 * The three MCP timeout levers, each under its Nessy spelling and the documented
 * Claude spelling it is an implementation of.
 *
 * All three were built at the documented defaults under `NESSY_` names and read
 * from nowhere else, so an operator following `env-vars.md#variables` set a name
 * this product never looked at and got silence — the exact defect the resolved-to
 * debug lines below were added to stop one level down.
 *
 * ## The exposure the old refusal was really guarding
 *
 * The refusal this block replaces read "one convention per file beats a third
 * spelling nobody can predict". The predictability argument is the weaker half of
 * what it was protecting: these are names a machine may ALSO be running other
 * software under — Claude Code itself reads all three — so accepting them means an
 * INHERITED value starts binding Nessy silently, with no operator intent behind it.
 * That trade is taken here because the two other families in this tree already took
 * it (`config/mcp-output-settings.ts` for `MAX_MCP_OUTPUT_TOKENS`,
 * `config/bash-output-limits.ts` for `BASH_MAX_OUTPUT_LENGTH`), so refusing it here
 * bought no safety while costing the operator three documented names; and because
 * the Nessy spelling WINS whenever both are set, an operator can always take the
 * value back. Each reader says which spelling it resolved from, so an inherited
 * value is legible rather than silent.
 */
export const MCP_STARTUP_TIMEOUT_ENV = 'NESSY_MCP_TIMEOUT';
/** `env-vars.md#variables`: "Timeout in milliseconds for MCP server startup (default: 30000, or 30 seconds)." */
export const MCP_STARTUP_TIMEOUT_COMPAT_ENV = 'MCP_TIMEOUT';

/** The Nessy spelling of the global wall clock on one MCP tool call. */
export const MCP_TOOL_TIMEOUT_ENV = 'NESSY_MCP_TOOL_TIMEOUT';
/** `env-vars.md#variables`: "Timeout in milliseconds for MCP tool execution (default: 100000000, about 28 hours)." */
export const MCP_TOOL_TIMEOUT_COMPAT_ENV = 'MCP_TOOL_TIMEOUT';

/** The Nessy spelling of the idle window on one MCP tool call. */
export const MCP_TOOL_IDLE_TIMEOUT_ENV = 'NESSY_MCP_TOOL_IDLE_TIMEOUT';
/**
 * `env-vars.md#variables`, the `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` row: "Idle
 * timeout in milliseconds for MCP tool calls. When a stdio, HTTP, SSE,
 * WebSocket, or claude.ai connector MCP server sends no response and no progress
 * notification for this long, the tool call aborts with an error instead of
 * waiting for the overall `MCP_TOOL_TIMEOUT`."
 *
 * P6.701 — the Nessy name existed and was read; the documented one was read by
 * NOTHING, which is the whole of what made this lever inert for anyone following
 * the page.
 */
export const MCP_TOOL_IDLE_TIMEOUT_COMPAT_ENV = 'CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT';

/**
 * "Values below 1000 are raised to one second" — the same row.
 *
 * A FLOOR ON THE VALUE, and it is a different rule from the per-server floor in
 * `mcp-pool.ts`: that one raises the window to a server's own wall clock, this
 * one refuses to let any operator value mean "abort almost immediately".
 */
export const MCP_TOOL_IDLE_TIMEOUT_MIN_MS = 1_000;

/** The Nessy spelling of the cap on a reconcile's whole connect batch. */
export const MCP_CONNECT_BATCH_TIMEOUT_ENV = 'NESSY_MCP_CONNECT_TIMEOUT_MS';
/** `env-vars.md#variables`, the row that is "Distinct from `MCP_TIMEOUT`, which bounds an individual server's connect attempt". */
export const MCP_CONNECT_BATCH_TIMEOUT_COMPAT_ENV = 'MCP_CONNECT_TIMEOUT_MS';

/** One lever's two spellings, and the raw value of whichever the operator set. */
export interface McpTimeoutEnvReading {
  /** The name that supplied the value — the Nessy spelling when both are set. */
  readonly name: string;
  /** The raw, untrimmed value, exactly as the environment carries it. */
  readonly raw: string;
}

/**
 * Read one timeout lever under either spelling, Nessy first.
 *
 * A name that is present but blank after trimming counts as UNSET and falls
 * through to the other spelling, so `NESSY_MCP_TOOL_TIMEOUT=""` beside a real
 * `MCP_TOOL_TIMEOUT` reads the latter rather than resolving to the default —
 * the same shape every reader here already gives a blank value on its own.
 */
export function readMcpTimeoutEnv(
  env: Record<string, string | undefined>,
  nessyName: string,
  compatName: string,
): McpTimeoutEnvReading | undefined {
  for (const name of [nessyName, compatName]) {
    const raw = env[name];
    if (raw !== undefined && raw.trim()) return { name, raw };
  }
  return undefined;
}

/**
 * The documented default ceiling on a RUNNING MCP tool call.
 *
 * `env-vars.md#variables`, the `MCP_TOOL_TIMEOUT` row, verbatim: "Timeout in
 * milliseconds for MCP tool execution (default: 100000000, about 28 hours)."
 *
 * Deliberately enormous, and that is the point: it changes nothing at rest — it
 * sits far above both idle windows (5 min remote / 30 min stdio) — while giving
 * {@link mcpDefaultToolTimeoutMsFromEnv} a name to occupy, so an operator who
 * sets the lever gets a real ceiling instead of silence.
 */
export const MCP_DEFAULT_TOOL_TIMEOUT_MS = 100_000_000;

/**
 * The global wall clock for one MCP tool call, in milliseconds.
 *
 * Spelled `NESSY_MCP_TOOL_TIMEOUT`, following the two levers already read by
 * `mcp-pool.ts` (`NESSY_MCP_TIMEOUT`, `NESSY_MCP_TOOL_IDLE_TIMEOUT`) and the
 * `CLAUDE_* -> NESSY_*` table in `config/background-task-settings.ts`. The
 * documented `MCP_TOOL_TIMEOUT` spelling is accepted as a compat alias and the
 * Nessy name wins when both are set — see {@link MCP_TOOL_TIMEOUT_COMPAT_ENV}
 * for the inherited-value exposure that trade takes on.
 *
 * Floor per `env-vars.md#variables`: "For the env variable, values below 1000
 * are floored to one second; for the per-server field, values below 1000 are
 * ignored." The two halves are different rules on purpose — `mcpToolTimeoutMs`
 * above implements the second, this implements the first — and the per-server
 * field's documented fall-through ("Values below 1000 are ignored and fall
 * through to `MCP_TOOL_TIMEOUT`", `mcp.md#push-messages-with-channels`) is what
 * makes that pair meaningful, since an ignored field now lands on a real value.
 *
 * Empty, malformed, or non-positive falls back to the documented default rather
 * than to "no ceiling", matching `mcpStartupTimeoutMsFromEnv`'s silent-fallback
 * shape.
 */
export function mcpDefaultToolTimeoutMsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const reading = readMcpTimeoutEnv(env, MCP_TOOL_TIMEOUT_ENV, MCP_TOOL_TIMEOUT_COMPAT_ENV);
  if (!reading) return MCP_DEFAULT_TOOL_TIMEOUT_MS;
  const value = Number(reading.raw.trim());
  if (!Number.isFinite(value) || value <= 0) return MCP_DEFAULT_TOOL_TIMEOUT_MS;
  return Math.max(MCP_MIN_TOOL_TIMEOUT_MS, Math.floor(value));
}

/**
 * Whether a connect the documented first-turn table exempts may run in the
 * background instead of holding the reconcile open.
 *
 * `agent-sdk/mcp.md#connection-timing` states the mechanism as a
 * per-server-type table, not an on/off switch: a stdio server, or an HTTP/SSE
 * server without a cached tool list, delays the first turn "until it connects";
 * a "Remote server with a cached tool list, saved by Claude Code from a previous
 * connection" does not, because "the cached tools are available from the first
 * turn". Our durable descriptor store IS that cached tool list, hydrated into
 * the tool cache before `sync`'s first await.
 *
 * CLAUDE'S DEFAULT IS THE NON-BLOCKING ONE AND THIS DEFAULT IS NOT, which is a
 * deliberate deviation and the reason is measured, not assumed. This pool's
 * connect result is read SYNCHRONOUSLY by two surfaces that have no change
 * notification: `McpClientPool.authNeededSlugs` — the H1 sign-in verdict that
 * `SessionManager`'s session-start pending-auth notice reads immediately after
 * its sync — and `health().failed`, which the browse registry uses to decide a
 * pool is stale. Exempting a cached server's connect makes a revoked
 * credential's 401 land AFTER the notice was computed, so the one prompt that
 * would fix it silently never appears: a control that stops controlling, which
 * is worse than the latency it would save. Claude's binary can default the
 * other way because its init message reports per-server status and its statuses
 * update after it.
 *
 * So the exemption is an operator's to take — `NESSY_MCP_CONNECTION_NONBLOCKING=1`
 * — and until they do, nothing changes.
 *
 * THE PRECONDITION THIS PARAGRAPH USED TO SET IS NOW MET, AND THE DEFAULT STILL
 * DOES NOT MOVE — for a different reason, so the sentence is replaced rather
 * than deleted (W2-p, 2026-09-03, P3.246/P3.247). It said "closing that gap
 * properly means giving the two verdict surfaces a change notification first;
 * recorded here rather than half-built". P3.246 built exactly that: the pool
 * publishes `subscribeConnectionVerdictChanged`, and
 * `workspace-mcp-pool-registry.ts` subscribes AT POOL CREATION rather than at
 * first sync, precisely so a verdict that moves on a path which never
 * reconciles (a 401 on a tool call, a dropped transport) still reaches the
 * host. Reading this paragraph today and concluding the work is unstarted is
 * the error it now exists to prevent.
 *
 * What replaces it: P3.247 removed both sites that actually PAID the block —
 * the codex-only session-setup await and the Pi-only DP preflight — and moved
 * the wait to the point of need on `McpPoolServer`, capped at Claude's
 * documented 5000. Every remaining `await sync()` is a background warm, so the
 * exemption would now buy latency nobody is waiting on while still changing
 * when a connect verdict lands relative to the two synchronous readers. The
 * flip's cost lands where its benefit does not.
 *
 * Measured on packaged 1.33.0 rather than argued: the artefact was driven with
 * `PKG-1`/`PKG-2`/`PKG-3` and the flip was NOT taken, because the run that
 * would justify it needs an MCP server whose credential is revoked mid-session
 * — the one case the notification exists for — and this rig has no such
 * fixture. Moving a default on an unexercised path is the product posture this
 * file refuses to decide quietly. The lever stays opt-in and the divergence
 * from Claude's documented default stays stated.
 *
 * Spelled `NESSY_` for the reason the file's other MCP levers are: one
 * convention per file.
 */
export function mcpConnectionNonBlockingFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.NESSY_MCP_CONNECTION_NONBLOCKING ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

/**
 * Claude's cap on its blocking startup batch, in milliseconds.
 *
 * `env-vars.md#variables`, the `MCP_CONNECT_TIMEOUT_MS` row, verbatim: "How long
 * blocking MCP startup waits, in milliseconds, for the connection batch before
 * snapshotting the tool list (default: 5000)."
 *
 * Recorded but deliberately NOT this pool's default — see
 * {@link mcpConnectBatchTimeoutMsFromEnv}.
 */
export const MCP_DOCUMENTED_CONNECT_BATCH_TIMEOUT_MS = 5_000;

/**
 * How long {@link McpPoolServer} waits for an in-flight reconcile before it
 * answers a subprocess anyway, in milliseconds.
 *
 * THE NUMBER IS CLAUDE'S, AND THE PHASE FINALLY MATCHES. The docblock below
 * declines 5000 as the pool's batch default on the grounds that it "belongs to a
 * phase we do not have" — the page puts it on blocking "startup itself at a
 * separate, earlier phase than the first-turn wait, before the init message is
 * sent". That was true of the reconcile. It is NOT true here: the HTTP pool
 * server answers a subprocess runtime's MCP `initialize` and its first
 * `tools/list`, which happen inside exactly that startup phase, before the
 * subprocess sends its own init. So this site is the one place in this repo
 * where adopting the documented 5000 IS parity rather than a six-fold shortening
 * of something else.
 *
 * A SECOND, INDEPENDENT REASON MAKES A BOUND MANDATORY RATHER THAN TIDY, and it
 * is what turned this from a constant into a hard requirement. Read from
 * `openai/codex@rust-v0.148.0`: `DEFAULT_STARTUP_TIMEOUT` is
 * `Duration::from_secs(30)` (`codex-rs/codex-mcp/src/rmcp_client.rs`), and for a
 * streamable-HTTP transport it is a DEADLINE SHARED ACROSS RETRY ATTEMPTS
 * (`streamable_http_retry.rs`: `let mut retry_deadline = timeout.map(...)`),
 * applied to the `initialize` round trip. Our own per-server connect deadline is
 * also 30 s, so an unbounded wait here would land ON that wall and codex would
 * drop the pool server entirely — "MCP client for `sources` timed out after 30
 * seconds" — losing EVERY source rather than the slow one. That is strictly
 * worse than the latency the wait was moved off session setup to save.
 *
 * Not an operator lever, deliberately: the two numbers it sits between are both
 * fixed by other people's software, so a knob here would only let an operator
 * choose to be dropped by codex.
 */
export const MCP_POOL_SERVER_STARTUP_WAIT_MS = MCP_DOCUMENTED_CONNECT_BATCH_TIMEOUT_MS;

/**
 * A cap on how long a reconcile waits for its connect batch, in milliseconds.
 *
 * UNSET MEANS NO SEPARATE CAP, and that is the resting state rather than an
 * omission: every connect is already bounded by the pool's per-server deadline
 * (`NESSY_MCP_TIMEOUT`, 30 s — `MCP_TIMEOUT`'s documented value, and the same
 * number `agent-sdk/mcp.md#connection-timing` puts in the first-turn-wait column
 * for a stdio server), so the batch has always terminated. Claude's documented
 * 5000 belongs to a phase we do not have — the page describes it as blocking
 * "startup itself at a separate, earlier phase than the first-turn wait, before
 * the init message is sent", and this pool has one phase, not two. Adopting 5000
 * as OUR default would therefore not be parity; it would shorten the documented
 * first-turn wait by six times under a name that means something else.
 *
 * **CORRECTED IN PLACE 2026-09-02 (P3.247/P3.248):** "this pool has one phase,
 * not two" was true of the POOL and is not true of the product. `McpPoolServer`
 * answers a subprocess runtime's MCP `initialize` and its first `tools/list`,
 * which is the earlier phase exactly — so the documented 5000 does have a site
 * here after all. It is {@link MCP_POOL_SERVER_STARTUP_WAIT_MS}, and the reason
 * it is not THIS lever is the one this docblock already gives: the two phases
 * want different numbers, and giving them one name is what would break parity.
 *
 * So the number is an operator's to pick, and it changes nothing until they do —
 * `MCP_DOCUMENTED_CONNECT_BATCH_TIMEOUT_MS` is what to write for Claude's.
 * Servers still pending when the cap fires keep connecting in the background,
 * as the same row promises: "Servers still pending at the deadline keep
 * connecting in the background."
 *
 * Empty, malformed, or non-positive returns `undefined` (no cap), matching
 * `mcpStartupTimeoutMsFromEnv`'s silent-fallback shape. The documented
 * `MCP_CONNECT_TIMEOUT_MS` spelling is read as a compat alias, the Nessy name
 * winning when both are set.
 */
export function mcpConnectBatchTimeoutMsFromEnv(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const reading = readMcpTimeoutEnv(env, MCP_CONNECT_BATCH_TIMEOUT_ENV, MCP_CONNECT_BATCH_TIMEOUT_COMPAT_ENV);
  if (!reading) return undefined;
  const value = Number(reading.raw.trim());
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}
