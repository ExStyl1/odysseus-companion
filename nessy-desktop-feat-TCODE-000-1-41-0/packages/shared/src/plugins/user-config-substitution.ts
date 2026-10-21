/**
 * `${user_config.KEY}` — substituted at every site the contract names.
 *
 * `plugins/manifest-reference.md#environment-variables`, whole line:
 *
 * > Each value is available for substitution as `${user_config.KEY}` in MCP and
 * > LSP server configs and hook commands. Non-sensitive values can also be
 * > substituted in skill and agent content. All values are exported to hook
 * > processes as `CLAUDE_PLUGIN_OPTION_<KEY>` environment variables, where
 * > `<KEY>` is the option key uppercased.
 *
 * Read carefully, that sentence has two halves and they are not the same rule:
 *
 * * MCP configs, LSP configs and hook commands take EVERY value, sensitive
 *   included. That is how a plugin authenticates to an internal service.
 * * Skill and agent content takes NON-SENSITIVE values ONLY. The body of a
 *   skill is prose that reaches the model, the transcript and everything that
 *   reads a transcript, so a sensitive value is refused there rather than
 *   redacted afterwards. Refusing at the substitution site is the only handling
 *   that holds: once the secret is in the body there is no boundary left to
 *   redact it at.
 *
 * `:579` carves out the shell: "Fields that run in a shell reject
 * `${user_config.*}` … so the component fails with an error instead", for
 * shell-form hook commands, monitor commands and MCP `headersHelper`. Those
 * refusals live at import time in the format adapters and are NOT undone here.
 * Nothing in this module ever substitutes into a string that reaches a shell:
 * an exec-form `args` entry becomes one argument with no shell in between
 * (`errors.md:1390`), and `headersHelper` — which Nessy now executes through a
 * shell at connect time (`mcp/headers-helper.ts`) — is refused a
 * `${user_config.*}` reference at import by the Claude adapter
 * (`plugin.format.claude_mcp_headers_helper_user_config`, `mcp.md:818`) and is
 * deliberately never a substitution site in {@link substituteMcp}. The refusal
 * IS the contract; `errors.md:1392` names `headers` as the safe alternative.
 *
 * ## What is deliberately NOT here
 *
 * A value never enters the capability generation hash, a diagnostic, a receipt
 * or a log line. Every diagnostic this module produces names KEYS. The trust
 * hash is computed over the UNSUBSTITUTED declaration in
 * `projection-candidates.ts` and this module runs strictly after it, which is
 * load-bearing twice over: a trust grant must not break when a token is
 * rotated, and a hash over a substituted definition would be an oracle for the
 * secret it contains.
 */
import { isSensitivePluginConfigurationField } from './mcpb-configuration.ts';
import type {
  PluginCapability,
  PluginLspCapability,
  PluginMcpCapability,
  PluginUserConfigurationDescriptor,
} from './types.ts';

/** Any `${user_config.KEY}` reference. Global — a config may carry several. */
const USER_CONFIG_REFERENCE = /\$\{user_config\.([A-Za-z0-9._-]+)\}/g;

/** True when the text mentions the placeholder at all (cheap pre-check). */
export function referencesPluginUserConfig(text: string): boolean {
  return text.includes('${user_config.');
}

interface ResolvedConfigValue {
  value: string;
  sensitive: boolean;
}

/**
 * One plugin instance's configured values, keyed as the placeholder spells them.
 *
 * Built from the `CLAUDE_PLUGIN_OPTION_<KEY>` map the host already resolves from
 * the credential store and the user-scoped option file — the documented carrier
 * of ALL values (`:577`), so no second read path to a secret is introduced here.
 * The declared descriptors supply the original key case, which the environment
 * map has lost.
 */
export class PluginUserConfigValues {
  private readonly byKey = new Map<string, ResolvedConfigValue>();
  /** Keys whose value cannot be recovered unambiguously — see the constructor. */
  private readonly ambiguous = new Set<string>();

  constructor(
    fields: readonly PluginUserConfigurationDescriptor[],
    optionEnvironment: Record<string, string> | undefined,
  ) {
    if (!optionEnvironment) return;
    // Two declared keys that uppercase to the same environment name share one
    // slot, so neither value can be told from the other. Both are marked
    // ambiguous and left literal rather than substituted with a coin flip —
    // a wrong token is worse than an unsubstituted one, and the placeholder is
    // at least diagnosable.
    const byEnvironmentName = new Map<string, string[]>();
    for (const field of fields) {
      const name = `CLAUDE_PLUGIN_OPTION_${field.key.toUpperCase()}`;
      byEnvironmentName.set(name, [...(byEnvironmentName.get(name) ?? []), field.key]);
    }
    for (const field of fields) {
      const name = `CLAUDE_PLUGIN_OPTION_${field.key.toUpperCase()}`;
      if ((byEnvironmentName.get(name)?.length ?? 0) > 1) {
        this.ambiguous.add(field.key);
        continue;
      }
      const value = optionEnvironment[name];
      if (value === undefined) continue;
      this.byKey.set(field.key, { value, sensitive: isSensitivePluginConfigurationField(field) });
    }
  }

  /** No configured value at all — the caller can skip every site. */
  get isEmpty(): boolean {
    return this.byKey.size === 0 && this.ambiguous.size === 0;
  }

  lookup(key: string): ResolvedConfigValue | undefined {
    return this.ambiguous.has(key) ? undefined : this.byKey.get(key);
  }
}

export interface UserConfigSubstitutionReport {
  /**
   * Keys referenced with no configured value. The placeholder is left LITERAL;
   * what happens next is the SITE's decision, not this module's.
   */
  unresolved: string[];
  /**
   * Sensitive keys referenced at a site that takes non-sensitive values only.
   * The placeholder is left literal and the value never enters the text.
   */
  refusedSensitive: string[];
  /**
   * Sensitive keys substituted into an MCP/LSP field that result redaction does
   * NOT cover.
   *
   * `mcp-pool.ts:1454` builds its per-connection redaction set from the final
   * `headers` and `env` values only, so a token that lands in one of those is
   * stripped out of every tool result and channel message. A token substituted
   * into `command`, `args`, `cwd` or `url` is not — and it is also the form the
   * docs steer away from twice (`errors.md:1392`, "move `${user_config.KEY}`
   * into the server's `headers` field"; `:1385`, "an env var set in the
   * server's `env` block").
   *
   * The value is still substituted: `:577` places no such restriction and
   * refusing would break a language server that legitimately takes `--token`.
   * What this list buys is that the author is TOLD, by key and by field, rather
   * than finding out from a tool result.
   */
  sensitiveUnredacted: string[];
}

function emptyReport(): UserConfigSubstitutionReport {
  return { unresolved: [], refusedSensitive: [], sensitiveUnredacted: [] };
}

function mergeReport(into: UserConfigSubstitutionReport, from: UserConfigSubstitutionReport): void {
  for (const key of from.unresolved) if (!into.unresolved.includes(key)) into.unresolved.push(key);
  for (const key of from.refusedSensitive) {
    if (!into.refusedSensitive.includes(key)) into.refusedSensitive.push(key);
  }
  for (const key of from.sensitiveUnredacted) {
    if (!into.sensitiveUnredacted.includes(key)) into.sensitiveUnredacted.push(key);
  }
}

/**
 * Substitute one string.
 *
 * An unset key is left LITERAL rather than expanded to the empty string. That
 * choice is the whole point of the site: an empty substitution turns
 * `Authorization: Bearer ${user_config.TOKEN}` into `Bearer `, which is a
 * syntactically valid request that authenticates as nobody — a 401 at the first
 * tool call with no hint of the cause. A surviving placeholder is at least
 * self-describing, and the MCP/LSP sites refuse to start on it (see
 * {@link substitutePluginCapabilityUserConfig}'s callers) so it never reaches a
 * server at all.
 */
export function substitutePluginUserConfigText(
  text: string,
  values: PluginUserConfigValues,
  options: { allowSensitive: boolean; redactedSink?: boolean },
): { text: string; report: UserConfigSubstitutionReport } {
  const report = emptyReport();
  if (!referencesPluginUserConfig(text)) return { text, report };
  const substituted = text.replace(USER_CONFIG_REFERENCE, (placeholder, key: string) => {
    const resolved = values.lookup(key);
    if (!resolved) {
      if (!report.unresolved.includes(key)) report.unresolved.push(key);
      return placeholder;
    }
    if (resolved.sensitive && !options.allowSensitive) {
      if (!report.refusedSensitive.includes(key)) report.refusedSensitive.push(key);
      return placeholder;
    }
    if (resolved.sensitive && options.redactedSink === false && !report.sensitiveUnredacted.includes(key)) {
      report.sensitiveUnredacted.push(key);
    }
    return resolved.value;
  });
  return { text: substituted, report };
}

/** `env` / `headers` — the two fields the pool's result redaction covers. */
function substituteRecord(
  record: Record<string, string> | undefined,
  values: PluginUserConfigValues,
  report: UserConfigSubstitutionReport,
): Record<string, string> | undefined {
  if (!record) return record;
  let changed = false;
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
    const result = substitutePluginUserConfigText(value, values, { allowSensitive: true, redactedSink: true });
    mergeReport(report, result.report);
    if (result.text !== value) changed = true;
    next[name] = result.text;
  }
  return changed ? next : record;
}

function substituteList(
  list: string[] | undefined,
  values: PluginUserConfigValues,
  report: UserConfigSubstitutionReport,
): string[] | undefined {
  if (!list) return list;
  let changed = false;
  const next = list.map(entry => {
    const result = substitutePluginUserConfigText(entry, values, { allowSensitive: true, redactedSink: false });
    mergeReport(report, result.report);
    if (result.text !== entry) changed = true;
    return result.text;
  });
  return changed ? next : list;
}

function substituteOne(
  value: string | undefined,
  values: PluginUserConfigValues,
  report: UserConfigSubstitutionReport,
): string | undefined {
  if (value === undefined) return undefined;
  const result = substitutePluginUserConfigText(value, values, { allowSensitive: true, redactedSink: false });
  mergeReport(report, result.report);
  return result.text;
}

/**
 * The MCP fields `:577` covers: every part of the server config a transport
 * reads. `command`/`args`/`cwd`/`env` for stdio, `url`/`headers` for the network
 * transports.
 *
 * `headers` is named explicitly by `errors.md:1392` as the SAFE place to put a
 * `${user_config.KEY}` a `headersHelper` may not carry — "move
 * `${user_config.KEY}` into the server's `headers` field, which isn't
 * shell-parsed" — so it is exactly the field this must cover.
 *
 * `headersHelper` rides the `...mcp` spread UNTOUCHED, on purpose: it is
 * shell-parsed, so substituting a configured value into it would run that
 * value as code. The adapter already refused any `${user_config.*}` reference
 * inside it at import (`mcp.md:818`).
 */
function substituteMcp(
  capability: PluginMcpCapability,
  values: PluginUserConfigValues,
  report: UserConfigSubstitutionReport,
): PluginMcpCapability {
  const mcp = capability.mcp;
  const next = {
    ...mcp,
    ...(mcp.command === undefined ? {} : { command: substituteOne(mcp.command, values, report)! }),
    ...(mcp.args === undefined ? {} : { args: substituteList(mcp.args, values, report)! }),
    ...(mcp.cwd === undefined ? {} : { cwd: substituteOne(mcp.cwd, values, report)! }),
    ...(mcp.env === undefined ? {} : { env: substituteRecord(mcp.env, values, report)! }),
    ...(mcp.url === undefined ? {} : { url: substituteOne(mcp.url, values, report)! }),
    ...(mcp.headers === undefined ? {} : { headers: substituteRecord(mcp.headers, values, report)! }),
  };
  return { ...capability, mcp: next };
}

/**
 * The LSP fields `:577` covers — the launch command, its environment, and where
 * it runs.
 *
 * `plugins-reference.md` § Environment variables names the same four fields for
 * the path placeholders — "| LSP servers | `command`, `args`, `env`,
 * `workspaceFolder` |" — so a config value that reaches the server has to pass
 * through here too, or an internal language server ships the literal
 * `${user_config.TOKEN}` in its environment and fails to authenticate exactly
 * the way an MCP server did before this module existed.
 */
function substituteLsp(
  capability: PluginLspCapability,
  values: PluginUserConfigValues,
  report: UserConfigSubstitutionReport,
): PluginLspCapability {
  const lsp = capability.lsp;
  return {
    ...capability,
    lsp: {
      ...lsp,
      command: substituteOne(lsp.command, values, report)!,
      ...(lsp.args === undefined ? {} : { args: substituteList(lsp.args, values, report)! }),
      ...(lsp.workingDirectory === undefined
        ? {}
        : { workingDirectory: substituteOne(lsp.workingDirectory, values, report)! }),
      ...(lsp.env === undefined ? {} : { env: substituteRecord(lsp.env, values, report)! }),
      ...(lsp.workspaceFolder === undefined
        ? {}
        : { workspaceFolder: substituteOne(lsp.workspaceFolder, values, report)! }),
    },
  };
}

/**
 * Substitute a capability's runtime declaration.
 *
 * Only `mcp` and `lsp` — the two `:577` names whose config is DATA the host
 * hands to a transport or a language server. A hook command is handled where
 * hooks are: the exec-form/shell-form split is an import-time decision the
 * adapter already makes, and every hook process receives the values through
 * `CLAUDE_PLUGIN_OPTION_<KEY>` regardless.
 *
 * Returns the capability unchanged (by identity) when nothing referenced a
 * placeholder, so the common case allocates nothing and the runtime view is
 * byte-identical to what it was before this existed.
 */
export function substitutePluginCapabilityUserConfig(
  capability: PluginCapability,
  values: PluginUserConfigValues,
): { capability: PluginCapability; report: UserConfigSubstitutionReport } {
  const report = emptyReport();
  if (values.isEmpty && capability.kind !== 'mcp' && capability.kind !== 'lsp') {
    return { capability, report };
  }
  if (capability.kind === 'mcp') {
    return { capability: substituteMcp(capability, values, report), report };
  }
  if (capability.kind === 'lsp') {
    return { capability: substituteLsp(capability, values, report), report };
  }
  return { capability, report };
}

/**
 * The non-sensitive subset, as a plain map, for the skill/agent content site.
 *
 * Sensitive values are absent from the returned map by construction rather than
 * filtered by the consumer: the content pass must not be able to reach one even
 * by mistake, and a map that never held the secret cannot leak it into a body,
 * a persisted invocation record or a transcript.
 */
export function pluginUserConfigContentValues(
  fields: readonly PluginUserConfigurationDescriptor[],
  optionEnvironment: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!optionEnvironment) return undefined;
  const values = new PluginUserConfigValues(fields, optionEnvironment);
  const content: Record<string, string> = {};
  for (const field of fields) {
    if (isSensitivePluginConfigurationField(field)) continue;
    const resolved = values.lookup(field.key);
    if (resolved) content[field.key] = resolved.value;
  }
  return Object.keys(content).length > 0 ? content : undefined;
}
