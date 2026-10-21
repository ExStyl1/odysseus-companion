/**
 * C3.285 (the build C3.12 asked for) — which permission rules codex's OWN
 * approval path can be judged by, and which of the user's rules have no subject
 * there at all.
 *
 * ## The defect this closes
 *
 * `codexApprovalRuleRequests` (`codex-agent.ts`) is the ALLOW path's projection
 * and it is deliberately narrow: exactly three tool names — `Bash`, and
 * `Write`/`Edit` for a v1 patch — carrying exactly two input fields, `command`
 * and `file_path`. Every other approval kind returns `[]` on purpose, and the
 * projector's own docblock gives the reason for each ("FAITHFUL, and nothing
 * else — the three honest limits are deliberate").
 *
 * The narrowness is right. What was wrong is that it was SILENT: the DSL accepts
 * a rule written against any matcher, so a user who wrote `Agent(reviewer)` or a
 * parameter rule on `pattern` got a rule that compiles, loads, shows up in the
 * policy — and is never consulted when codex asks to run a command or change a
 * file. P6.214 measured the consequence as a SILENT-LOOSER switch verdict on
 * ledger A51/A52: the switch onto codex quietly stopped enforcing rules the user
 * believed were in force.
 *
 * ## What this module claims, and what it is careful NOT to claim
 *
 * It classifies a rule against **codex's approval projection only** — the path
 * taken when codex itself asks. It was written making no claim about tools the
 * HOST runs on a codex session, on the belief that those go through the host's
 * own rule gate; C3.298 measured that belief and it is FALSE (see the table
 * below), so the module claimed two more matcher kinds and the sentence
 * {@link describeCodexUnboundPermissionRules} produces no longer promises that
 * the host's own tools consult these rules. F1.272 then made ONE of the two —
 * `mcp` — consulted, and it is no longer claimed (the table's last row).
 *
 * Three classes are named, which are the three C3.12's done-means enumerates:
 *
 * 1. **a `parameter` rule naming any field but `command` or `file_path`** — the
 *    projection carries no other input, so there is nothing for the matcher to
 *    read;
 * 2. **every `Agent(...)` rule** — a codex subagent's turn runs inside the
 *    app-server and its report returns to the parent there, so no host code sits
 *    on that path at all (C3.13, `noteCodexSubagentReportResidue`);
 * 3. **a `tool` rule naming anything but the three projected names.**
 *
 * ## C3.298 — the four matchers C3.285 declined to claim, measured one by one
 *
 * The residue above said *"some of the calls they judge are HOST-run on a codex
 * session"*, and nobody had measured WHICH. Measured 2026-09-12, and **the
 * premise does not survive**: on a codex session no host-run tool reaches the
 * rule gate at all. `codexApprovalRuleRequests` is the whole rule surface there,
 * `runPreToolUseChecks` has zero CALL SITES in `codex-agent.ts` (its four
 * occurrences are the comments recording that zero — count call sites, not the
 * name), and P6.700's reading of
 * `packages/codex-protocol/generated/ServerRequest.ts` shows codex raises no
 * MCP tool-call approval at all. The bridged session tools reach this host
 * through the session MCP server, which evaluates no permission rule.
 *
 * So the four split two and two, and only two of them become claims:
 *
 * | matcher | measured | verdict |
 * | :-- | :-- | :-- |
 * | `powershell` | BOUND. The `command`/`commandV1` projection emits `toolName: 'Bash'`, and `permission-dsl.ts`'s `carriesBashCommand` is `toolName === 'Bash' \|\| semanticId === 'bash' \|\| semanticId === 'monitor'`; the rule then judges any command `looksLikePowerShell` accepts | still unclaimed — it really is consulted |
 * | `cdPath` | NEITHER. `permission-dsl.ts` answers `case 'cdPath': return false` for every tool call on every runtime; its only evaluator is `evaluateCdPermissionDslV1`, for the `/cd` the USER types, which is host-side and runtime-independent | still unclaimed — not a codex question |
 * | `host` | UNBOUND. `hostFromInput` reads `host`, `domain`, `url` or `baseUrl`, and this projection carries only `command` and `file_path`, so the matcher has nothing to read on codex's own path — and no host-run tool reaches it either | CLAIMED below |
 * | `mcp` | BOUND since F1.272. P6.700's "codex asks no MCP tool-call approval" was refuted by measurement (F1.218: it arrives as `mcpServer/elicitation/request` with `_meta.codex_approval_kind = "mcp_tool_call"`), and `codexMcpToolCallRuleRequests` (`codex-agent.ts`) now projects that approval under the host's name — `mcp__<wire>__<tool>` for a source, `mcp__session__<tool>` for a session tool — with the call's own arguments as input. Residue, stated in the sentence: codex asks nothing for a tool annotated `readOnlyHint: true` (`requires_mcp_tool_approval`, F1.218 measured no request), so no rule is consulted for one | no longer claimed |
 *
 * The two that stay unclaimed are unclaimed for OPPOSITE reasons — one is
 * consulted, one is not a tool-call matcher at all — and that is why they are
 * written out rather than left as one line about four names.
 *
 * ## F1.272 — what the MCP projection changes, and what it does not
 *
 * The MCP tool-call request carries the call's OWN arguments, so a `parameter`
 * (deny/ask) or `Host` rule IS consulted when an MCP call's arguments carry its
 * field — on a source's tool and on this app's session tools alike, exactly as
 * Pi's gate reads them. The classes below stay claimed because the sentence is
 * scoped to codex asking to run a COMMAND or change a FILE, whose projection
 * still carries `command` and `file_path` only; the sentence now says where
 * they do come back. {@link CODEX_APPROVAL_RULE_TOOL_NAMES} and
 * {@link CODEX_APPROVAL_RULE_INPUT_FIELDS} are that command/file vocabulary.
 */
import { CODEX_HOST_WEB_SEARCH_TOOL } from '@nessy-agent/codex-responses-adapter/config-writer';
import { matchesToolPermissionRule } from './mode-manager.ts';
import type { ToolPermissionRule } from './mode-types.ts';

/**
 * The tool names codex's approval projection can produce — kept here so the
 * classifier and the projector cannot drift apart in silence.
 *
 * `codex-permission-rule-subjects.test.ts` drives `codexApprovalRuleRequests`
 * over every approval kind and asserts the union of the names and input fields
 * it emits is EXACTLY these two lists, which is the totality shape this repo
 * uses wherever a constant restates something a function decides.
 */
export const CODEX_APPROVAL_RULE_TOOL_NAMES: readonly string[] = ['Bash', 'Write', 'Edit'];

/** The input fields those requests carry. @see CODEX_APPROVAL_RULE_TOOL_NAMES */
export const CODEX_APPROVAL_RULE_INPUT_FIELDS: readonly string[] = ['command', 'file_path'];

/** Why a rule cannot be consulted when codex asks. */
export type CodexUnboundRuleReason = 'parameter-field' | 'agent-rule' | 'tool-name' | 'matcher-kind';

export interface CodexUnboundPermissionRule {
  readonly ruleId: string;
  readonly reason: CodexUnboundRuleReason;
  /** The rule AS ITS AUTHOR WROTE IT when the layer carried it — display only. */
  readonly text?: string;
  /** The subject the rule names, for a sentence the author can recognise. */
  readonly subject: string;
}

/**
 * The shape this reads out of a compiled program.
 *
 * Structural rather than imported: `CompiledRule` and `CompiledMatcher` are
 * internal to `pi-harness/permission-dsl.ts` and exporting them to let one
 * reader name them would widen that module's surface for nothing. Every member
 * of the compiled matcher union satisfies this, so a caller passes
 * `CompiledPermissionDslV1` straight in.
 */
export interface CodexRuleSubjectInput {
  readonly rules: readonly {
    readonly id: string;
    readonly text?: string;
    readonly matcher: {
      readonly kind: string;
      readonly semanticId?: string;
      readonly name?: string;
      readonly agent?: string;
      /** `Host(...)` — the domain the rule names. */
      readonly host?: string;
      /** `mcp__<server>__<tool>` — the server, and optionally the tool. */
      readonly server?: string;
      readonly tool?: string;
    };
  }[];
}

/**
 * Every rule in the program that codex's approval path cannot consult.
 *
 * Pure, so the classification is testable without a session, and provider
 * neutral: it takes a compiled program and returns a list. Order is the
 * program's own, so the sentence lists rules in the order the user's layers
 * declared them.
 */
export function classifyCodexUnboundPermissionRules(
  program: CodexRuleSubjectInput | undefined,
): readonly CodexUnboundPermissionRule[] {
  if (!program) return [];
  const unbound: CodexUnboundPermissionRule[] = [];
  for (const rule of program.rules) {
    const matcher = rule.matcher;
    if (matcher.kind === 'agent') {
      unbound.push({
        ruleId: rule.id,
        reason: 'agent-rule',
        ...(rule.text === undefined ? {} : { text: rule.text }),
        subject: `Agent(${matcher.agent ?? '*'})`,
      });
      continue;
    }
    if (matcher.kind === 'parameter') {
      const name = matcher.name ?? '';
      if (CODEX_APPROVAL_RULE_INPUT_FIELDS.includes(name)) continue;
      unbound.push({
        ruleId: rule.id,
        reason: 'parameter-field',
        ...(rule.text === undefined ? {} : { text: rule.text }),
        subject: name || '(unnamed parameter)',
      });
      continue;
    }
    // C3.298 · the two matcher kinds whose subject codex's projection cannot
    // carry AT ALL — see the table in this module's docblock. Reported by KIND
    // rather than by field, because the rule is not wrong about its field: the
    // field simply never arrives on this runtime.
    if (matcher.kind === 'host') {
      unbound.push({
        ruleId: rule.id,
        reason: 'matcher-kind',
        ...(rule.text === undefined ? {} : { text: rule.text }),
        subject: `Host(${matcher.host ?? '*'})`,
      });
      continue;
    }
    // F1.272 · an `mcp` rule is NOT claimed any more: codex's MCP tool-call
    // approval is projected under the host's name (`codexMcpToolCallRuleRequests`),
    // so the rule is consulted there. See the table's last row.
    if (matcher.kind === 'tool') {
      const semanticId = matcher.semanticId ?? '';
      if (CODEX_APPROVAL_RULE_TOOL_NAMES.some(name => name.toLowerCase() === semanticId)) continue;
      unbound.push({
        ruleId: rule.id,
        reason: 'tool-name',
        ...(rule.text === undefined ? {} : { text: rule.text }),
        subject: semanticId || '(unnamed tool)',
      });
    }
  }
  return unbound;
}

/** How many subjects to name before the sentence stops listing them. */
const NAMED_SUBJECT_LIMIT = 6;

/**
 * The operator-visible sentence, or `undefined` when every rule has a subject.
 *
 * Goes on `CodexAgent`'s session-FACTS channel rather than through `debug()`,
 * for the reason that channel exists: a standing property of the session must
 * answer the same on turn sixty as on turn one, and `debug()` routes through
 * electron-log, whose transports the packaged main process disables. C3.12's
 * done-means asks for "a named diagnostic the user can see rather than a
 * `debug()` line", and this is the channel that satisfies it.
 */
export function describeCodexUnboundPermissionRules(
  unbound: readonly CodexUnboundPermissionRule[],
): string | undefined {
  if (unbound.length === 0) return undefined;
  const subjects = unbound.map(rule => rule.text ?? rule.subject);
  const listed = subjects.slice(0, NAMED_SUBJECT_LIMIT).join(', ');
  const rest = subjects.length > NAMED_SUBJECT_LIMIT ? ` and ${subjects.length - NAMED_SUBJECT_LIMIT} more` : '';
  return 'PERMISSION RULES WITH NO SUBJECT IN CODEX\'S OWN APPROVALS — when codex asks to run a command or change '
    + `a file it can be judged only by ${CODEX_APPROVAL_RULE_TOOL_NAMES.join('/')} rules carrying `
    + `${CODEX_APPROVAL_RULE_INPUT_FIELDS.join(' or ')}, so ${unbound.length} of your rules are never consulted `
    + `on that path: ${listed}${rest}. They still hold on the other runtimes this session can be switched to, `
    + 'and on the `/cd` gate you run yourself. When codex asks to run an MCP tool — a source\'s or one of the '
    + 'session tools this app runs for it — the call IS judged: by mcp__ rules, and by parameter and Host rules '
    + 'against the tool\'s own arguments (F1.272); codex does not ask for a tool its server marks read-only, so '
    + 'no rule is consulted for one of those, and the hand-bound approval closures some session tools raise '
    + 'afterwards consult none (C3.298). An Agent rule has no subject anywhere here, because a codex '
    + 'subagent runs inside the app-server where no host code sits.';
}

// ---------------------------------------------------------------------------
// F1.378 — the MCP deny/ask rules, projected into codex's OWN per-server levers
// ---------------------------------------------------------------------------

/** The two `[mcp_servers.*]` entries codex is given — see `buildCodexConfigToml`. */
export type CodexMcpServerEntry = 'session' | 'sources';

/** What one `[mcp_servers.<entry>]` table carries for the user's MCP rules. */
export interface CodexMcpToolLevers {
  /** `disabled_tools` — the raw tool names a `deny` rule names exactly. */
  readonly disabledTools: readonly string[];
  /** `[mcp_servers.<entry>.tools."<name>"] approval_mode = "prompt"` — an `ask` rule. */
  readonly promptTools: readonly string[];
  /**
   * F1.1061 — `session` entry only, and present only when true: a whole-tool
   * deny of the search itself ({@link CODEX_WEB_SEARCH_RULE_NAMES}). The writer
   * turns it into codex's own switch, `web_search = "disabled"`, on the one card
   * whose search is codex's (`codexConfigFollowsCodexWebSearch`); the app's
   * `web_search` is in {@link disabledTools} beside it on every card.
   */
  readonly webSearchDenied?: true;
}

/** The projection, plus every MCP deny/ask rule no lever can express. */
export interface CodexMcpRuleProjection {
  readonly session: CodexMcpToolLevers;
  readonly sources: CodexMcpToolLevers;
  readonly unexpressible: readonly CodexUnboundPermissionRule[];
  /**
   * F1.482 (2) — present only when a {@link CodexMcpToolCatalogue} was given:
   * the whole-server and pattern rules that were enumerated over it (each one
   * carried by the levers for every catalogue tool it matches).
   */
  readonly enumerated?: readonly CodexUnboundPermissionRule[];
}

/**
 * F1.482 (2) — the tools codex will be handed, by the name the host records a
 * call under (the name an `mcp__` rule is written against), so a whole-server or
 * pattern rule can be turned into codex's exact-name lists.
 */
export interface CodexMcpToolCatalogue {
  /**
   * `mcp__session__<tool>` for EVERY session tool the registry defines. A
   * superset of what one session's server advertises, deliberately: a name in
   * `disabled_tools` or `tools.<name>` that codex was never handed is inert.
   */
  readonly session: readonly string[];
  /** `mcp__<wire>__<tool>` for every tool the pool listed for this session when the runtime was built. */
  readonly sources: readonly string[];
  /**
   * The pool was still connecting a source when the wait for it ran out, so a
   * tool that source adds can reach codex outside the lists. See
   * {@link describeCodexMcpRuleCatalogueGap}.
   */
  readonly incomplete?: boolean;
}

/** {@link CodexRuleSubjectInput} plus the one field the projection reads beside it. */
export interface CodexMcpRuleProjectionInput {
  readonly rules: readonly {
    readonly id: string;
    readonly action: string;
    readonly text?: string;
    readonly matcher: { readonly kind: string; readonly server?: string; readonly tool?: string; readonly semanticId?: string };
  }[];
}

/**
 * F1.1061 — the tool names a whole-tool deny of web search is written under:
 * claude's `WebSearch` (tools-reference.md; also the `permissionName` Pi's gate
 * judges its own `web_search` by) and Pi's `web_search` (that binding's name, and
 * the name the app's search tool answers to under F1.379's alias). Compared with
 * the DSL's `*` wildcard, as the DSL's own whole-tool removal compares them
 * (`permission-dsl.ts`, the `tool` arm of `isWholeToolDenyForIdentity`).
 */
export const CODEX_WEB_SEARCH_RULE_NAMES: readonly string[] = ['WebSearch', 'web_search'];

/**
 * F1.378 (DECIDED 2026-09-23, native-first) — the user's `mcp__` DENY and ASK
 * rules, as codex's own per-server levers.
 *
 * ## Why a projection, and not only the consult F1.272 built
 *
 * F1.272 made codex's MCP tool-call approval consult these rules — but only
 * when codex ASKS. Read at `rust-v0.154.0` (`core/src/mcp_tool_call.rs`
 * `requires_mcp_tool_approval_for_mode`), a tool its server annotates
 * `readOnlyHint: true` is never asked about in the default `auto` mode, and with
 * auto-review on (`core/src/tools/approvals.rs`, "1. Hooks 2. … Guardian …
 * Else, user") the reviewer answers before this host is asked. So `deny:
 * ['mcp__x__y']` on a read-only-annotated tool was consulted nowhere on codex
 * while Pi refuses it, and nothing said so. The levers exist in the pinned
 * `config-schema.json` (`RawMcpServerConfig`): `disabled_tools` and
 * `tools.<name>.approval_mode` (`AppToolApproval`: `auto` | `prompt` | `writes` |
 * `approve`).
 *
 * - `deny` → `disabled_tools`. `codex-mcp/src/tools.rs` `ToolFilter::allows`
 *   compares the RAW tool name exactly (a `HashSet`), and `filter_tools` drops
 *   the tool from the catalogue — the analogue of a whole-tool deny removing
 *   the tool from the model's context on the other runtimes
 *   (`permission-dsl.ts`, the removal evaluator's `mcp` arm).
 * - `ask` → `approval_mode = "prompt"`, which `requires_mcp_tool_approval_for_mode`
 *   answers `true` whatever the annotation, so codex asks and the host's rule
 *   consult puts the card up. A deny on the same tool wins, as it does in the
 *   DSL. With auto-review on, the reviewer still answers the ask — the reach
 *   F1.387 states on the toggle.
 * - `allow` projects nothing: `approve` would pre-approve past this host's
 *   floors.
 *
 * ## The raw name, per entry
 *
 * The rule names a call as the host records it: `mcp__session__<tool>` for a
 * session tool and `mcp__<wire>__<tool>` for a source
 * (`capabilities/mcp-wire-name.ts` `hostMcpToolNameForCodexRow`). The DSL reads
 * the second `__` segment as the server and the rest as the tool
 * (`permission-dsl.ts`, the `mcp` evaluator). So `session` rules land on
 * `[mcp_servers.session]` under `<tool>`, and every other server's rules on the
 * aggregated pool entry `[mcp_servers.sources]` under `<wire>__<tool>`, which is
 * the pool's own tool name (codex's row for the same call is
 * `mcp__sources__<wire>__<tool>`).
 *
 * ## A whole server or a pattern — enumerated over a catalogue (F1.482 (2))
 *
 * A rule with no tool (`mcp__<server>`, a whole server) or with `*` in either
 * half names tools codex's exact-name lists cannot spell. Given a
 * {@link CodexMcpToolCatalogue} — the tools codex will be handed, which
 * `CodexAgent.codexMcpRuleCatalogue` reads off the session tool registry and
 * the pool at runtime build — such a rule is carried for every catalogue tool
 * it matches, by the DSL's own reading of the name
 * ({@link codexMcpRuleMatchesHostToolName}), and listed in
 * {@link CodexMcpRuleProjection.enumerated}. Without one it comes back as
 * {@link CodexMcpRuleProjection.unexpressible}, for the facts sentence
 * ({@link describeCodexUnprojectedMcpRules}) — F1.378's wire, unchanged.
 */
export function projectCodexMcpPermissionRules(
  program: CodexMcpRuleProjectionInput | undefined,
  catalogue?: CodexMcpToolCatalogue,
): CodexMcpRuleProjection {
  const disabled: Record<CodexMcpServerEntry, string[]> = { session: [], sources: [] };
  const prompt: Record<CodexMcpServerEntry, string[]> = { session: [], sources: [] };
  const unexpressible: CodexUnboundPermissionRule[] = [];
  const enumerated: CodexUnboundPermissionRule[] = [];
  let webSearchDenied = false;
  for (const rule of program?.rules ?? []) {
    const { matcher } = rule;
    // F1.1061 · a whole-tool deny of web search removes BOTH searches codex can
    // be handed: the app's (`web_search` on the session entry — codex never asks
    // about it, its server marks it read-only, so only the lever holds) and
    // codex's own hosted one (`webSearchDenied`). The deny carries to the app's
    // stand-in the way permissions.md's MCP section says Claude Code carries a
    // whole `Bash` or `WebFetch` deny to Cowork's stand-in tools; an allow or an
    // ask does not (codex's hosted search has no approval to ask through).
    if (matcher.kind === 'tool' && rule.action === 'deny'
      && CODEX_WEB_SEARCH_RULE_NAMES.some(name => dslWildcard(matcher.semanticId ?? '', name))) {
      webSearchDenied = true;
      if (!disabled.session.includes(CODEX_HOST_WEB_SEARCH_TOOL)) disabled.session.push(CODEX_HOST_WEB_SEARCH_TOOL);
      continue;
    }
    if (matcher.kind !== 'mcp' || (rule.action !== 'deny' && rule.action !== 'ask')) continue;
    const server = matcher.server ?? '';
    const tool = matcher.tool ?? '';
    if (!server || !tool || server.includes('*') || tool.includes('*')) {
      const named: CodexUnboundPermissionRule = {
        ruleId: rule.id,
        reason: 'matcher-kind',
        ...(rule.text === undefined ? {} : { text: rule.text }),
        subject: `mcp__${server || '*'}${tool ? `__${tool}` : ''}`,
      };
      if (!server || !catalogue) {
        unexpressible.push(named);
        continue;
      }
      enumerated.push(named);
      for (const entry of ['session', 'sources'] as const) {
        for (const hostName of catalogue[entry]) {
          if (!codexMcpRuleMatchesHostToolName({ server, ...(tool ? { tool } : {}) }, hostName)) continue;
          const raw = hostName.slice(entry === 'session' ? 'mcp__session__'.length : 'mcp__'.length);
          const list = rule.action === 'deny' ? disabled[entry] : prompt[entry];
          if (raw && !list.includes(raw)) list.push(raw);
        }
      }
      continue;
    }
    const entry: CodexMcpServerEntry = server === 'session' ? 'session' : 'sources';
    const raw = entry === 'session' ? tool : `${server}__${tool}`;
    const list = rule.action === 'deny' ? disabled[entry] : prompt[entry];
    if (!list.includes(raw)) list.push(raw);
  }
  const levers = (entry: CodexMcpServerEntry): CodexMcpToolLevers => ({
    disabledTools: disabled[entry],
    // A deny wins over an ask on the same tool, as in the DSL: a disabled tool
    // is never called, so a prompt entry for it would be dead text.
    promptTools: prompt[entry].filter(name => !disabled[entry].includes(name)),
  });
  return {
    session: webSearchDenied ? { ...levers('session'), webSearchDenied: true } : levers('session'),
    sources: levers('sources'),
    unexpressible,
    ...(catalogue ? { enumerated } : {}),
  };
}

/**
 * F1.1175 (origin the do-now adversarial review, 2026-09-29) — the program
 * {@link projectCodexMcpPermissionRules} reads, plus a web-search deny written
 * in the host's `toolRules` instead of the readable policy.
 *
 * `toolRules` never enter the readable program, so `{ pattern: 'WebSearch',
 * action: 'deny' }` refused Claude's own search and Pi's `web_search` at the host
 * gate while on codex both the app's `web_search` (never asked about, its server
 * marks it read-only) and codex's own hosted search stayed on. When the gate's
 * own first-match reading of the list (`matchesToolPermissionRule`) DENIES
 * `WebSearch`, the name that deny refuses the built-in under on the other two
 * runtimes, one whole-tool deny rule is appended, so the projection's F1.1061
 * arm carries it to both levers exactly as it carries the readable one. An allow
 * or an ask projects nothing, as there. Only this one name: any other `toolRules`
 * entry for a tool codex never asks about is still not projected (stated in the
 * F1.1175 note as the wider residue).
 */
export function withToolRulesWebSearchDeny(merged: {
  readonly permissionDsl?: CodexMcpRuleProjectionInput;
  readonly toolRules: ToolPermissionRule[];
}): CodexMcpRuleProjectionInput | undefined {
  const rule = matchesToolPermissionRule('WebSearch', merged.toolRules);
  if (rule?.action !== 'deny') return merged.permissionDsl;
  return {
    rules: [...(merged.permissionDsl?.rules ?? []), {
      id: `toolRules:${rule.pattern}`,
      action: 'deny',
      ...(rule.comment ? { text: rule.comment } : {}),
      matcher: { kind: 'tool', semanticId: 'WebSearch' },
    }],
  };
}

/**
 * F1.482 (2) — does an `mcp` rule's matcher name this call? The DSL's own
 * reading (`pi-harness/permission-dsl.ts`, the `mcp` arm of both the gate's
 * matcher and the whole-tool removal filter): the name splits on `__`, the
 * second segment is the server and the rest is the tool, each half compared
 * with the DSL's `*` wildcard. Spelled again here because the DSL's `wildcard`
 * is private to that module; `codex-mcp-pattern-rule-catalogue.test.ts` holds
 * the two readings to agreement with `evaluatePermissionDslV1` as the oracle.
 */
export function codexMcpRuleMatchesHostToolName(
  matcher: { readonly server: string; readonly tool?: string },
  hostToolName: string,
): boolean {
  if (!hostToolName.startsWith('mcp__')) return false;
  const [, server, ...toolParts] = hostToolName.split('__');
  return !!server && dslWildcard(matcher.server, server)
    && (!matcher.tool || dslWildcard(matcher.tool, toolParts.join('__')));
}

function dslWildcard(pattern: string, value: string): boolean {
  const escaped = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`, 'us').test(value);
}

/**
 * F1.482 (2) — the facts sentence for the one reach the enumeration leaves: a
 * source the pool was still connecting when the wait for it ran out. codex
 * lists a server's tools once, when it starts (`notifications/tools/list_changed`
 * is logged and acted on by nothing — `mcp/pool-server.ts`), so a tool such a
 * source adds can reach codex without the rule. `undefined` when no rule was
 * enumerated or the catalogue was complete.
 */
export function describeCodexMcpRuleCatalogueGap(
  enumerated: readonly CodexUnboundPermissionRule[],
  catalogue: CodexMcpToolCatalogue | undefined,
): string | undefined {
  if (enumerated.length === 0 || !catalogue?.incomplete) return undefined;
  const subjects = enumerated.map(rule => rule.text ?? rule.subject);
  const listed = subjects.slice(0, NAMED_SUBJECT_LIMIT).join(', ');
  const rest = subjects.length > NAMED_SUBJECT_LIMIT ? ` and ${subjects.length - NAMED_SUBJECT_LIMIT} more` : '';
  return `MCP RULES APPLIED TO THE TOOLS LISTED AT START — ${enumerated.length} of your whole-server or pattern `
    + `mcp__ deny/ask rules (${listed}${rest}) were applied to the tools your sources had listed when this Codex `
    + 'runtime started, but a source was still connecting then. A tool it adds reaches Codex without those rules '
    + '— codex does not ask about a tool its server marks read-only, and with Codex auto-review on its reviewer '
    + 'answers first — until the runtime restarts (a new session or a permission-mode change).';
}

/**
 * F1.378 — the facts sentence for the MCP deny/ask rules codex's levers cannot
 * carry, or `undefined` when every such rule was projected. Same channel and
 * the same naming limit as {@link describeCodexUnboundPermissionRules}.
 */
export function describeCodexUnprojectedMcpRules(
  unexpressible: readonly CodexUnboundPermissionRule[],
): string | undefined {
  if (unexpressible.length === 0) return undefined;
  const subjects = unexpressible.map(rule => rule.text ?? rule.subject);
  const listed = subjects.slice(0, NAMED_SUBJECT_LIMIT).join(', ');
  const rest = subjects.length > NAMED_SUBJECT_LIMIT ? ` and ${subjects.length - NAMED_SUBJECT_LIMIT} more` : '';
  return `MCP RULES CODEX CANNOT CARRY ITSELF — ${unexpressible.length} of your mcp__ deny/ask rules name a whole `
    + `server or a pattern (${listed}${rest}), and codex's own per-tool lists take exact tool names only. They `
    + 'are judged whenever codex asks about a tool they match, but codex does not ask about a tool its server '
    + 'marks read-only, and with Codex auto-review on its reviewer answers first — so on codex those rules do '
    + 'not hold for such calls. Name the tool (mcp__<server>__<tool>) to have codex remove it (deny) or always '
    + 'ask (ask) itself.';
}
