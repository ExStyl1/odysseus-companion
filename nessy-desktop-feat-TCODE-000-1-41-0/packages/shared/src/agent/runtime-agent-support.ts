/**
 * Which runtimes actually dispatch our agent definitions.
 *
 * Q7. The acceptance gate (`.superpowers/sdd/q6-agent-invocation-report.md`,
 * Q6-D4) measured the capability catalog reporting all 12 agents `active` while
 * two of the three runtimes registered none of them. `active` is a promise, and
 * this constant is the ONE place that decides who keeps it.
 *
 * It is deliberately a single exported set rather than a condition repeated at
 * each site, because the two readers are in different packages and a drift
 * between them is silent in exactly the direction that hurt: the session path
 * would stop shipping definitions while the catalog kept calling them active.
 *
 * The two readers:
 *
 * - `SessionManager` — gates `materializePiRuntimeAgentDefinitions`, i.e. whether
 *   a session's definitions get built and handed to the backend at all.
 * - `capabilities/resolver.ts` — gates the catalog row, so an agent that cannot
 *   run on the active runtime carries `unavailableReason: 'unsupported-runtime'`
 *   instead of a bare `active`.
 *
 * Membership is by MECHANISM, not by ambition:
 *
 * - `pi` — ours, built to Claude Code's documentation. Proven live.
 * - `anthropic` — the Claude Agent SDK's own `agents` option
 *   (`claude-runtime-agents.ts`). Covers both Claude cards, since
 *   `claude-runtime` collapses onto this provider.
 * - `codex-runtime` — codex's own `[agents.<role>]` config mechanism, written
 *   per session by `codex-responses-adapter/src/config-writer.ts`
 *   (`buildCodexAgentRoles` + one role layer each under
 *   `<CODEX_HOME>/agent-roles/`) and handed the session's definitions by
 *   `CodexAgent.createRuntime`. A definition codex cannot express is denied by
 *   omission and named on the agent's diagnostic channel, never silently — the
 *   builder's docblock carries which fields survive and why a denial is always
 *   a narrowing.
 *
 * And who is absent, with the reason:
 *
 * - `nestor-cloud-agent` — a remote A2A backend that runs no local definitions.
 *
 * ## The reason `codex-runtime` used to be absent, and how it was refuted
 *
 * This docblock said turning codex on "also means enabling Codex's
 * `multi_agent`/`multi_agent_v2` features, which changes what the foreign
 * runtime's model may do". Measured against the pinned `rust-v0.147.0` schema
 * and the SHIPPED binary (`7bf2c84d6`), that is false twice over:
 *
 * - `AgentsToml.enabled` is "Whether multi-agent tools are enabled. Defaults to
 *   true", so `spawn_agent`/`wait_agent`/`close_agent`/`resume_agent` are
 *   already live on every codex session we start. We deliberately never emit
 *   the key — writing a role neither flips it nor needs it flipped.
 * - A role is guidance, not authorization. The binary's own `spawn_agent` text:
 *   "Agent-role guidance below only helps choose which agent to use after
 *   spawning is already authorized; it never authorizes spawning by itself."
 *
 * What a role DOES change is which agent the model picks and what developer
 * instructions that agent runs under — the substance of a definition, and the
 * thing the catalog was calling `unsupported-runtime` while our own writer had
 * nowhere to send it.
 */
import type { AgentProvider } from './backend/types.ts';

/**
 * P2.283 · the decision, one arm per runtime, TOTAL over the vocabulary.
 *
 * This was a three-element `Set` literal, and P2.124 closed claiming its
 * property — *a per-runtime capability site must be total over the vocabulary,
 * so adding a runtime BREAKS THE BUILD* — held everywhere. It did not hold
 * here. Measured on an isolated clone at `f58f66a36`: adding a fifth member to
 * `ModelProvider` broke `runtime-vocabulary.ts`, `composer-capabilities.ts`,
 * nine sites in `factory.ts`, `runtime-switch.ts` and `runtime-switch-costs.ts`
 * — and this file compiled clean, because a `Set<AgentProvider>` is happy with
 * any subset. A new runtime was silently DENIED definitions, with no build
 * error and no diagnostic anywhere.
 *
 * `Record<AgentProvider, boolean>` fixes exactly that and nothing else: a
 * missing arm is a type error, an invented one is an excess-property error, and
 * the exported `Set` below is DERIVED so every reader's `.has()` semantics —
 * including what an off-disk string that is in no union gets — are byte for byte
 * what they were.
 *
 * The `false` arms carry their reason ON THE VALUE LINE deliberately. Two lanes
 * on this plan found a per-runtime claim written as prose beside a value that
 * contradicted it; prose kept in a separate paragraph drifts from the list it
 * describes, and this file's docblock above is where that drift would land.
 */
export const AGENT_DEFINITION_DISPATCH: Record<AgentProvider, boolean> = {
  // Ours, built to Claude Code's documentation. Hands the definitions to the
  // harness itself.
  pi: true,
  // The Claude Agent SDK's own `agents` option (`claude-runtime-agents.ts`).
  anthropic: true,
  // Codex's own `[agents.<role>]` config mechanism, written per session by
  // `codex-responses-adapter/src/config-writer.ts`.
  'codex-runtime': true,
  // A remote A2A backend that runs no local definitions at all.
  'nestor-cloud-agent': false,
};

export const AGENT_DEFINITION_RUNTIMES: ReadonlySet<AgentProvider> = new Set<AgentProvider>(
  (Object.keys(AGENT_DEFINITION_DISPATCH) as AgentProvider[])
    .filter(provider => AGENT_DEFINITION_DISPATCH[provider]),
);

/**
 * True when `provider` registers our agent definitions with a real dispatch
 * mechanism.
 *
 * An UNDEFINED provider answers `true`, and that is the load-bearing case rather
 * than a convenience: a WORKSPACE-scoped `{ workspaceId }` capability read
 * resolves before any session exists, so it is provider-blind by construction.
 * Which runtime a future session picks is unknown there, and refusing the row
 * would report a definite unavailability from an indefinite input — the same
 * trap `storage-runtime.ts:1076` records in the other direction for managed
 * activation.
 *
 * It is NOT the case for a session-scoped read, and the distinction is the whole
 * of Q8-D4. This docblock used to say "`resolveCapabilityContext` never sets a
 * provider" as a statement of design; it was a defect. That ingress produces
 * every context a user-readable catalog is built from, so with the field unset
 * there the gate collapsed onto this `undefined` branch on EVERY surface and a
 * Codex session's 15 agents read `active`, byte-identical to Pi's. The ingress
 * now threads the live session's provider
 * (`server-core/src/domain/capabilities/context.ts` — `resolveSessionProvider`,
 * fed by `SessionManager.getSessionProvider`), so `undefined` here means only
 * what it says: no session, therefore no runtime yet.
 */
export function runtimeDispatchesAgentDefinitions(provider: AgentProvider | undefined): boolean {
  return provider === undefined || AGENT_DEFINITION_RUNTIMES.has(provider);
}

/**
 * Which runtimes run a plugin's background MONITORS.
 *
 * Same failure this module's agent constant was built for, one surface over.
 * `getOrCreateAgentUnchecked` wired the monitors and the language servers
 * behind ONE predicate, and the catalog said nothing: a plugin's card stayed
 * enabled with its monitor row `active` while no monitor process existed, on
 * every runtime but Pi. Which is worse than the agent case rather than merely
 * equal to it, because a monitor is the half of a plugin the user never
 * watches.
 *
 * ## P6.175/P6.176 — why this used to say Pi and no longer does
 *
 * The single record's stated reason was: "Monitors deliver by
 * `agent.redirect(text)` mid-turn — a Pi-only steering primitive.
 * `PluginMonitorService`'s whole delivery contract is that call." Measured at
 * HEAD, that clause is FALSE on both other coding runtimes, and it was false on
 * the day it was written:
 *
 * - `ClaudeAgent.redirect` steers mid-stream through the SDK's own
 *   `additionalContext` injection at the next `PreToolUse`, and yields
 *   `steer_undelivered` when no tool call follows so the session layer
 *   re-queues. Its abort fallback is unreachable from this path:
 *   `armPluginPeripherals`'s `canDeliver()` already demands
 *   `agent.isProcessing?.()`, and `ClaudeAgent.isProcessing()` IS
 *   `openSlot !== null && !openSlot.settled` — the very condition `redirect`
 *   tests before falling back — read in the same synchronous expression.
 * - `CodexAgent.redirect` is codex's OWN `turn/steer` primitive (native-first
 *   step 1, already driven), and its `false` is inert by contract
 *   (`redirectFallbackInterruptsTurn(): false`) — so on codex the delivery cannot
 *   abort a turn even in the fallback, which is a stronger guarantee than the
 *   claude arm's.
 *
 * And the gate was BROADER than its reason: a plugin COMMAND monitor
 * (`ensurePluginCommandMonitors`) is a persistent shell process that needs no
 * steering primitive at all, and its output reaches the session through
 * `deliverScheduledMonitorEvent`, whose own runtime set has listed all three
 * coding runtimes since T1.
 *
 * `nestor-cloud-agent` stays out: remote, runs nothing locally, and owns no
 * host tool loop for a delivery to wake.
 *
 * `undefined` answers `true` for exactly the reason
 * {@link runtimeDispatchesAgentDefinitions} gives: a workspace-scoped read
 * happens before any session exists, and reporting a definite unavailability
 * from an indefinite input is the trap in the other direction.
 */
export const PLUGIN_MONITOR_SUPPORT: Record<AgentProvider, boolean> = {
  // Scheduled monitors steer through `PiAgent.steer`; command monitors are
  // ordinary supervised processes.
  pi: true,
  // P6.175 — `ClaudeAgent.redirect` (SDK `additionalContext` injection at the
  // next PreToolUse, `steer_undelivered` when none follows).
  anthropic: true,
  // P6.176 — codex's own `turn/steer`, which `CodexAgent.redirect` already
  // drives, and whose `false` is inert by contract
  // (`redirectFallbackInterruptsTurn(): false`), so this arm cannot abort a
  // turn at all. Re-probed on the shipped `codex-app-server` at HEAD:
  // `turn/steer` present, positive controls `hooks` 139 and `skill` 673.
  'codex-runtime': true,
  // Remote; runs nothing locally.
  'nestor-cloud-agent': false,
};

export const PLUGIN_MONITOR_RUNTIMES: ReadonlySet<AgentProvider> = new Set<AgentProvider>(
  (Object.keys(PLUGIN_MONITOR_SUPPORT) as AgentProvider[])
    .filter(provider => PLUGIN_MONITOR_SUPPORT[provider]),
);

/** True when `provider` actually runs a plugin's scheduled and command monitors. */
export function runtimeRunsPluginMonitors(provider: AgentProvider | undefined): boolean {
  return provider === undefined || PLUGIN_MONITOR_RUNTIMES.has(provider);
}

/**
 * Which runtimes PROVISION a plugin's language servers — the other half of what
 * one record used to decide, and the half whose reason still holds.
 *
 * LSP servers are provisioned by the trusted-project LSP owner through the Pi
 * harness's tool surface. Neither the Claude SDK nor codex has a seam that
 * accepts one, measured on the strongest tier available to each:
 *
 * - claude — `lsp` has 0 occurrences in the vendored `sdk.d.ts`; the native
 *   binary's `lspServers` occurrences all sit under the plugin MANIFEST schema,
 *   so native plugin delivery is the only route and it is owner-sitting §2.3 /
 *   P3.297.
 * - codex — on the shipped `codex-app-server` binary `lsp_servers`,
 *   `lspServers` and `language_server` are all 0 against a positive control of
 *   `hooks` at 95; the codex plugin `lsp` field our adapter normalizes has no
 *   runtime consumer (P6.176).
 *
 * So this record is STRUCTURAL, not a wiring gap, and the honest surface for it
 * is `CapabilityDelta.lostLsp` rather than a widening.
 *
 * ## C3.188 / C3.189 — the owner asked for the PRICE of handing the claude
 * SDK's own plugin loader this half, and the price was measured (2026-09-11)
 *
 * Owner answer QL8 (2026-09-11) overrode the flat refusal: *where a runtime has
 * its own plugin loader, measure the cost and name how the double delivery is
 * avoided.* Measured against the vendored binary, which self-reports
 * `2.1.247 (Claude Code)` beside the SDK manifest's `"claudeCodeVersion":
 * "2.1.247"` (package `0.3.247`), driven through `--plugin-dir` — the CLI
 * spelling of `Options.plugins` — under an isolated HOME and an API base on a
 * closed loopback port, reading the `system/init` inventory.
 *
 * **The route EXISTS, and the double delivery is avoided by CONSTRUCTION rather
 * than by a flag.** Three arms, one negative control:
 *   - a bundle whose manifest names ONLY `lspServers` and whose directory holds
 *     no default component directories → `init.plugins` carries it
 *     (`split@inline`) and `slash_commands`, `agents` and `mcp_servers` gain
 *     NOTHING from it;
 *   - the SAME manifest in a directory that also holds `commands/`, `agents/`
 *     and `skills/` → `hazard:hazcmd` and `hazard:demo` appear in
 *     `slash_commands` and `hazard:hazagent` in `agents`, none of them named by
 *     the manifest. That is `plugins/manifest-reference.md#component-path-forms`'s
 *     "Replaces the default" rule read from the other side: a field the manifest
 *     omits means the default directory IS scanned. So a split must be a
 *     SYNTHESIZED directory — pointing the loader at the installed plugin
 *     double-delivers;
 *   - no `--plugin-dir` at all → neither appears, which is what makes the first
 *     two a reading rather than a tautology.
 *   `SdkPluginConfig.skipMcpDiscovery` (`sdk.d.ts`, 0.3.247) is the narrower
 *   second answer for the MCP third: *"the engine loads skills/hooks/agents/
 *   commands from this plugin but does NOT read its `.mcp.json` or manifest
 *   mcpServers. Use when the SDK host owns this plugin's MCP connections."* So
 *   `ClaudeAgent.mcpReconciliationSucceeded`'s standing condition — *"if plugins
 *   ever start contributing MCP servers on this runtime, this check has to learn
 *   about that exemption first"* — is NOT tripped by a split bundle.
 *
 * **And it is REFUSED anyway, for a reason the route cannot fix.** Two numbers:
 *   1. `lspServers`, `lspServer` and `'lsp'` each occur **0** times in the
 *      vendored `sdk.d.ts` (`workflow` scores 17 and `skipMcpDiscovery` 1 in the
 *      same file, so the probe reads it). There is no option, no event and no
 *      `Query` method about a language server, so a plugin LSP server that never
 *      starts, crashes, or is missing from `$PATH` would be invisible to us.
 *      Today's answer is the opposite of invisible: `announcePluginLspUnavailable`
 *      sends a session event on Pi (P6.417, `28ee8b40c`/`fe9843077`/`6a260d552`),
 *      and a switch onto claude reports the loss as `CapabilityDelta.lostLsp`.
 *      AGENTS.md §Native-first: *an unauditable influence on permission outcomes
 *      is worse than an absent one* — the same holds for a supervisor whose
 *      failures never reach the user. Shipping it would trade a named loss for a
 *      silent one, which is this fork's largest defect class.
 *   2. No spawn was OBSERVED: an `lspServers` entry whose command writes a marker
 *      file left no marker after a 30 s dwell past `init`, in a non-interactive
 *      `-p` session with a matching `.go` file in the cwd. Stated at its real
 *      strength — the rig cannot reach a first file READ without credentials, so
 *      this refutes an EAGER spawn at session start and does not prove the server
 *      never starts.
 *
 * **C3.189, permanently:** this fork builds no language-server supervisor of its
 * own. The user-facing answer to an unavailable or crashed server is already
 * `announcePluginLspUnavailable`, and the eight supervision knobs a plugin may
 * declare (`startupTimeout`, `restartOnCrash`, `maxRestarts`, `shutdownTimeout`,
 * `env`, `args`, `initializationOptions`, `extensionToLanguage`) are honoured on
 * Pi only.
 *
 * **What would flip this record**, so the next lane has a test rather than a
 * re-argument: an SDK surface that REPORTS a plugin language server's state —
 * any of those three names becoming non-zero in `sdk.d.ts` — or a documented
 * statement that plugin LSP runs in SDK sessions. Until then the value below
 * stays `false` and the loss stays named.
 */
export const PLUGIN_LSP_SUPPORT: Record<AgentProvider, boolean> = {
  // Through the Pi harness's tool surface, under the trusted-project gate.
  pi: true,
  // No SDK seam accepts a provisioned language server.
  anthropic: false,
  // Measured absent in the shipped binary, not merely unwired.
  'codex-runtime': false,
  // Remote; runs nothing locally.
  'nestor-cloud-agent': false,
};

export const PLUGIN_LSP_RUNTIMES: ReadonlySet<AgentProvider> = new Set<AgentProvider>(
  (Object.keys(PLUGIN_LSP_SUPPORT) as AgentProvider[])
    .filter(provider => PLUGIN_LSP_SUPPORT[provider]),
);

/** True when `provider` actually provisions a plugin's language servers. */
export function runtimeProvisionsPluginLsp(provider: AgentProvider | undefined): boolean {
  return provider === undefined || PLUGIN_LSP_RUNTIMES.has(provider);
}

/**
 * The THIRD rider on the record that was split, found while splitting it
 * (P6.175): MCP channel push.
 *
 * `armPluginPeripherals` also calls `setChannelPolicy(resolveChannelPolicy())`
 * and `ensureSessionChannelSubscription`, and those two lines rode the same
 * `provider === 'pi'` gate the monitors did — by adjacency, never by a decision.
 * Widening them with the monitors would have been silent: P6.74 measured
 * `channelsEnabled` and `allowedChannelServers` as `unmeasured` rather than
 * `not-enforced` precisely BECAUSE no dispatcher is installed on claude
 * (`McpClientPool` defaults to `CHANNEL_PUSH_OFF`), so "the restriction the key
 * asks for holds by construction". Arming channel push on the other runtimes
 * would flip both verdicts on a row that never asked to.
 *
 * So the answer is preserved exactly and given a name of its own. Whether it
 * SHOULD widen is a separate question with a managed-policy surface attached,
 * and it is proposed as its own row rather than decided here.
 *
 * ## P6.341 — that row arrived, and the answer is YES, with the missing
 * precondition supplied first
 *
 * Two facts settled it. (1) Everything under the arming call is already
 * host-side and runtime-blind: the pool, `applyChannelPolicy`, the subscription
 * and the sink (`deliverMonitorEvent`) carry no provider term, and the pool is
 * constructed for EVERY provider — P6.175 moved the gate inside precisely so
 * the three peripherals could answer separately. Leaving this one Pi-only made
 * a channel a property of the runtime the user happened to be on, which is the
 * switch-safety problem in its purest form: the same enabled source pushes on
 * Pi and is silently inert on claude and codex.
 *
 * (2) The reason it was UNSAFE to widen has been removed. The dispatcher used
 * to be armed on POLICY alone, so widening would have let any enabled MCP
 * source push into a claude turn. `McpClientPool.declaresChannel` now requires
 * the server's own handshake declaration — `channels-reference.md#server-options`
 * makes `capabilities.experimental['claude/channel']` "Required. Always `{}`.
 * Presence registers the notification listener." — so the set that can push is
 * the set that asked to, on every runtime.
 *
 * P6.74's `unmeasured` verdicts on `channelsEnabled` / `allowedChannelServers`
 * move WITH this flip, not after it: `claude-managed-settings.ts` carries both
 * as `host-gate` now, because `resolveManagedChannelPolicy` is read on a claude
 * session. Changing one without the other is what would have made the
 * administrator's report false.
 *
 * `nestor-cloud-agent` stays false and the reason is unchanged: it runs no
 * local pool at all.
 */
export const MCP_CHANNEL_PUSH_SUPPORT: Record<AgentProvider, boolean> = {
  pi: true,
  // P6.341 — armed on the same host path as Pi, behind the server's own
  // `claude/channel` declaration. Not a claim about the vendored binary's
  // channels: OUR pool is the one that installs the dispatcher, on every
  // runtime, because every MCP source reaches the SDK through it.
  anthropic: true,
  'codex-runtime': true,
  // Remote; runs nothing locally.
  'nestor-cloud-agent': false,
};

export const MCP_CHANNEL_PUSH_RUNTIMES: ReadonlySet<AgentProvider> = new Set<AgentProvider>(
  (Object.keys(MCP_CHANNEL_PUSH_SUPPORT) as AgentProvider[])
    .filter(provider => MCP_CHANNEL_PUSH_SUPPORT[provider]),
);

/** True when `provider`'s session arms MCP channel push. */
export function runtimeReceivesMcpChannelPush(provider: AgentProvider | undefined): boolean {
  return provider === undefined || MCP_CHANNEL_PUSH_RUNTIMES.has(provider);
}

/** The plugin hook ACTION kinds that need a host-supplied runner. */
export type PluginHookActionKind = 'prompt' | 'agent' | 'mcp' | 'http';

/** All four, in the order `RuntimeHookRegistration['type']` lists them. */
export const PLUGIN_HOOK_ACTION_KINDS: readonly PluginHookActionKind[] = ['http', 'mcp', 'prompt', 'agent'];

/**
 * The FOURTH consumer of the split record, and the one that must NOT read the
 * peripheral answer: which plugin hook ACTION runners the host supplies per
 * runtime.
 *
 * `SessionManager.buildPinnedAgentAutomationSystem` decides this, and
 * `describeCapabilityDelta`'s `inertHookKinds` reports it — two sites, one
 * package apart, and until P6.175 the reporter borrowed the PERIPHERAL
 * predicate because the two happened to answer the same thing. That is the
 * accidental agreement this module exists to end, so the builder now spreads its
 * runners FROM this record and the delta subtracts FROM it.
 *
 * A command hook is deliberately not a member: `pluginCommandHookRunner` is
 * supplied unconditionally on every runtime, which is why a whole-row gate would
 * lie in the other direction (`resolver.ts`'s own carve-out says the same).
 *
 * P6.117 — the three cheap runners are host work end to end and needed no
 * runtime seam, only a wider gate. Each body was read before widening:
 * `pluginMcpToolHookRunner` needs the shared MCP pool lease (leased for every
 * backend), `pluginHttpHookRunner` needs `executeWebhookRequest` plus the
 * managed policy, and `pluginPromptHookRunner` needs `agent.runMiniCompletion`,
 * which is ABSTRACT on `BaseAgent` and implemented by all four backends. All
 * three route permission through the provider-neutral
 * `isPluginHookEffectAllowed` and mint their receipt through
 * `appendPiExecutionReceipt`, whose only provider-gated step is telemetry.
 *
 * Native-first, asked on both runtimes and answered on both. Claude has TWO
 * native routes and neither replaces this one: the SETTINGS tier already runs
 * all five handler types inside the SDK child, which is a different tier of
 * hook (`settingSources: ['user','project','local']`, not a plugin's own), and
 * the PLUGIN tier — `Options.plugins` with `skipMcpDiscovery` — would load a
 * plugin's hooks natively but outside our ProcessSupervisor, plugin-integrity
 * verification and managed kill switches, which is P2.414's trade and is
 * owner-sitting §2.3. Codex admits four handler kinds in its own `[hooks]`
 * table, but the shipped binary says mcp-tool/prompt/agent hooks are "not
 * supported yet", and P2.414 forbids projecting a hook the host did not author.
 * So the host route is the only one on codex and is compatible with either §2.3
 * answer on claude — no owner input is owed.
 *
 * P6.590 — `agent` reaches claude and codex too, and the reason it did not is
 * worth keeping: it was a HOST port, never a runtime limit. An agent hook spawns
 * a host CHILD SESSION through `managed.piChildSessionPort`, which was assigned
 * only where `piPermissionService` — the Pi tool-approval band's service —
 * exists. Every step of the spawn (`createSession`, `runPiChildTurn`, the
 * worktree lease service, the permission layers) is host work the other runtimes
 * reach as readily as Pi does, so the port is now assigned on every runtime with
 * its own admission-only permission service, and this record follows.
 *
 * Native mechanism, asked for the fourth kind as for the other three: none.
 * Neither claude nor codex offers to run a plugin's `agent` hook action itself
 * — claude's plugin tier would load a plugin's hooks natively but outside our
 * supervisor and integrity checks (§2.3), and codex's shipped binary reports
 * agent hooks "not supported yet". Host case (2): one implementation, all three.
 */
export const PLUGIN_HOOK_ACTION_RUNNERS: Record<AgentProvider, readonly PluginHookActionKind[]> = {
  pi: ['http', 'mcp', 'prompt', 'agent'],
  // P6.117 gave these three; P6.590 added `agent` once the child-session port
  // stopped being Pi-only.
  anthropic: ['http', 'mcp', 'prompt', 'agent'],
  'codex-runtime': ['http', 'mcp', 'prompt', 'agent'],
  // Remote; runs no host-side hook actions at all.
  'nestor-cloud-agent': [],
};

/**
 * The plugin hook action runners `provider` is given.
 *
 * `undefined` answers ALL FOUR for the same fail-open reason the predicates
 * above give: an indefinite input must not report a definite unavailability.
 */
export function pluginHookActionRunnersFor(
  provider: AgentProvider | undefined,
): readonly PluginHookActionKind[] {
  return provider === undefined ? PLUGIN_HOOK_ACTION_KINDS : PLUGIN_HOOK_ACTION_RUNNERS[provider];
}

/**
 * Which runtimes can DISPATCH a workflow — the third record, and the one the
 * capability ledger calls its clearest `ADVERTISED` anti-pattern.
 *
 * `workflows.md#ask-for-a-workflow-in-your-prompt` describes the capability as
 * *"Claude Code highlights the keyword in your input and Claude writes a
 * workflow script for the task instead of working through it turn by turn."*
 * The script is run by the `workflow` tool, which lives in
 * `pi-agent-server/src/orchestrator/` and nowhere else, so on any other runtime
 * there is no "instead" — only a refusal.
 *
 * ## Why this record and not a fourth condition
 *
 * The refusal already existed and was already correct: `BaseAgent.chat` claims
 * `ChatOptions.workflowInvocation` behind `canDispatchWorkflowCommands()` and
 * yields `settings.ai.workflows.dispatchUnavailable` (P2.212), and the keyword
 * route was closed the same way (P2.315,
 * `workflows/workflow-keyword.ts:WORKFLOW_KEYWORD_DISPATCH_RUNTIMES`). What
 * neither reached is the CATALOG: the command kept appearing in the menu and in
 * the plugin's card, so the user picked a command whose only possible outcome
 * was that refusal. `PLUGIN_MONITOR_SUPPORT` above exists because of exactly
 * that asymmetry one surface over — a plugin card that stays enabled while the
 * thing it advertises cannot run.
 *
 * The gate is not cosmetic. `SessionManager.pluginPromptCommandEntries` filters
 * on `entry.summary.enabled`, so a row this record disables leaves the SLASH
 * REGISTRY as well as the catalog — one predicate, both surfaces, and no way
 * for them to drift apart in the direction that hurt before.
 *
 * Total over the vocabulary for {@link AGENT_DEFINITION_DISPATCH}'s reason: a
 * new runtime must WRITE its answer, with a reason, before the build passes.
 * The `true` set must equal the set of backends that override
 * `canDispatchWorkflowCommands()`; `__tests__/runtime-capability-drift.test.ts`
 * asserts exactly that against the backend sources, in the same describe that
 * already holds the tie for the slash-command arm — and
 * `workflow-keyword.test.ts` holds it for the keyword arm. All three claims,
 * one mechanism.
 *
 * `undefined` answers `true` for the reason
 * {@link runtimeDispatchesAgentDefinitions} gives at length: a workspace-scoped
 * read happens before any session exists, and reporting a definite
 * unavailability from an indefinite input is the trap in the other direction.
 */
export const WORKFLOW_DISPATCH_SUPPORT: Record<AgentProvider, boolean> = {
  // The `workflow` tool and its orchestrator ARE the Pi subprocess
  // (`orchestrator/workflow-tool.ts`); `PiAgent` is the only override of
  // `canDispatchWorkflowCommands()`.
  pi: true,
  // `session-tools-core` — the tool surface a claude-runtime session gets —
  // carries no `workflow` tool, and the SDK has no orchestration seam to hand a
  // recipe to.
  anthropic: false,
  // Codex has its own multi-agent primitives (`spawn_agent`/`wait_agent`) but
  // nothing that executes a Nessy workflow SCRIPT — `agent()`, `parallel()`,
  // `pipeline()`, `phase()` are the Pi orchestrator's vocabulary.
  'codex-runtime': false,
  // Remote; runs no local orchestrator at all.
  'nestor-cloud-agent': false,
};

export const WORKFLOW_DISPATCH_RUNTIMES: ReadonlySet<AgentProvider> = new Set<AgentProvider>(
  (Object.keys(WORKFLOW_DISPATCH_SUPPORT) as AgentProvider[])
    .filter(provider => WORKFLOW_DISPATCH_SUPPORT[provider]),
);

/** True when `provider` can actually execute a workflow recipe. */
export function runtimeDispatchesWorkflows(provider: AgentProvider | undefined): boolean {
  return provider === undefined || WORKFLOW_DISPATCH_RUNTIMES.has(provider);
}

/**
 * Which runtimes can FORK the current conversation — the fourth record, and the
 * one that closes `ADVERTISED`'s second live instance (P3.71).
 *
 * `sub-agents.md#fork-the-current-conversation` describes the affordance as
 * *"You can start a fork yourself with `/subtask` followed by a task, whether or
 * not fork mode is on."* — and, one paragraph up, it also describes the
 * WITHDRAWAL: *"When [agent view is turned off](/docs/en/agent-view#turn-off-agent-view),
 * `/subtask` isn't available and `/fork` starts the forked subagent instead"*.
 * Upstream itself takes the row out of the menu when the mechanism behind it is
 * off; it does not leave it there to refuse.
 *
 * ## Why this record and not a fourth condition
 *
 * The refusal already existed and was already right: `BaseAgent.chat` answers a
 * `subtask` session command with "not available on this runtime" behind
 * `canForkConversation()` (P2.298).
 * What it never reached is the COMPOSER MENU, which offered `/subtask`
 * on all four runtimes — so a user could pick a command whose only possible
 * outcome was that refusal. Identical shape, identical remedy, one record over:
 * {@link WORKFLOW_DISPATCH_SUPPORT}.
 *
 * The typed affordance the doc names is deliberately UNTOUCHED. The menu row is
 * a PREFILL (`PREFILL_COMMANDS.subtask`) — it types `/subtask ` for you and
 * submits nothing — so withdrawing it removes no capability: typing
 * `/subtask <task>` still forks on Pi and still meets the honest refusal
 * elsewhere. Only the advertisement moves.
 *
 * Total over the vocabulary for {@link AGENT_DEFINITION_DISPATCH}'s reason: a
 * new runtime must WRITE its answer, with a reason, before the build passes.
 * The `true` set must equal the set of backends that override
 * `canForkConversation()`, which must in turn equal the set that holds the
 * `subtask_start` mechanism; `__tests__/session-command-runtime-capability-seam.test.ts`
 * holds both ties in one describe.
 *
 * `undefined` answers `true` for {@link runtimeDispatchesAgentDefinitions}'s
 * reason: a read that happens before any session exists must not report a
 * definite unavailability from an indefinite input.
 */
export const FORK_CONVERSATION_SUPPORT: Record<AgentProvider, boolean> = {
  // `PiAgent.requestSubtaskFork` → `subtask_start`; the only fork mechanism in
  // the product, and `PiAgent` is the only override of `canForkConversation()`.
  pi: true,
  // The Claude Agent SDK exposes no in-session fork seam to us; a
  // claude-runtime session has no way to start a subagent that inherits the
  // conversation.
  anthropic: false,
  // Codex has `thread/fork`, but for a different job — it re-forks the thread
  // when the plugin/skill config drifts and CONTINUES in it, producing no
  // background subagent with its own transcript and controls.
  'codex-runtime': false,
  // Remote; the fork would have to happen on the other side of the A2A wire.
  'nestor-cloud-agent': false,
};

export const FORK_CONVERSATION_RUNTIMES: ReadonlySet<AgentProvider> = new Set<AgentProvider>(
  (Object.keys(FORK_CONVERSATION_SUPPORT) as AgentProvider[])
    .filter(provider => FORK_CONVERSATION_SUPPORT[provider]),
);

/** True when `provider` can actually fork the current conversation. */
export function runtimeForksConversations(provider: AgentProvider | undefined): boolean {
  return provider === undefined || FORK_CONVERSATION_RUNTIMES.has(provider);
}

/**
 * Which runtimes get the host's POST-EDIT DIAGNOSTICS and the `format` tool —
 * the fifth record, and the first one whose subject is not a plugin.
 *
 * CI2 runs the project's own linter/typechecker on a file an agent edit just
 * changed and folds bounded diagnostics back as observational context; CI1
 * detects the project's own formatter and exposes it as the agent-facing
 * `format` op. Both are HOST-side runners built by `SessionManager` and handed
 * to the backend, both default ON (`AGENT_FLAGS`), and both are MODEL-FACING —
 * `format` is a projected tool the model can call, and the diagnostics ride the
 * next PreToolUse `additionalContext`, the one channel that reaches the Pi model
 * with context it did not ask for.
 *
 * Until this record they were two `provider === 'pi'` literals in
 * `getOrCreateAgentUnchecked` and nothing else. That is the same shape
 * {@link PLUGIN_MONITOR_SUPPORT} exists for, one surface over, with one
 * difference that makes it worse rather than equal: a plugin at least has a
 * card. These two have no catalogue row at all — `capabilities/resolver.ts`
 * resolves plugin-derived capabilities, and neither of these is one — so before
 * this record the ONLY statement anywhere that they are Pi-only was the literal
 * itself, and the only runtime notice was `sessionLog.debug`, which reaches
 * nobody on a packaged build. The user-visible half is now the runtime-switch
 * delta (`SessionManager.describeCapabilityDelta` →
 * `chat.runtimeSwitch.capabilityEditTooling`).
 *
 * ## The native-first question, asked before either `false` was written
 *
 * Neither `false` below means *cannot*. Both mean **never wired**, and the
 * distinction is the whole point of writing them here instead of leaving a
 * provider test:
 *
 * - **anthropic** — the seam EXISTS and is deliberately unused. `claude-agent.ts`
 *   says so at the `buildSdkHooks` site: "PostToolUse is intentionally supplied
 *   only by trusted projected automation hooks. The installed SDK observes it
 *   and supports `updatedToolOutput`; Nessy does not synthesize a false internal
 *   hook." A post-edit runner would be exactly such a synthesis, so adopting it
 *   is a posture change to take deliberately, not a gap to close quietly.
 * - **codex-runtime** — `postToolUse` is one of codex's own eleven hook events
 *   (`packages/codex-protocol/generated/v2/HookEventName.ts`), so the moment is
 *   reachable there through codex's own `[hooks]` table. What is missing is our
 *   emitter, which is `runtime-hook-events.ts`'s `unwired` verdict for
 *   `PostToolUse` on codex, recorded there with its note.
 *
 * ## The belt this record is NOT
 *
 * `acceptsEditFeedbackRunner` / `acceptsFormatRunner` in `SessionManager`
 * duck-type on fields only `PiAgent` declares, so deleting the provider test
 * alone would change no behaviour — which is precisely why the literal was
 * invisible and why a record is the right repair. The duck-type stays; it
 * guards the ASSIGNMENT. This record carries the CLAIM, and the claim is what a
 * user, a switch dialog and the next reader can see.
 *
 * Total over the vocabulary for {@link AGENT_DEFINITION_DISPATCH}'s reason: a
 * new runtime must WRITE its answer, with a reason, before the build passes.
 * `__tests__/runtime-capability-drift.test.ts` ties the `true` set to the
 * backends that actually declare the two runner fields.
 *
 * `undefined` answers `true` for {@link runtimeDispatchesAgentDefinitions}'s
 * reason. It cannot arrive at either production caller — both read a bound
 * session's provider — and if it ever did, the duck-type above is what refuses
 * the assignment.
 */
export const HOST_EDIT_TOOLING_SUPPORT: Record<AgentProvider, boolean> = {
  // `PiAgent` declares `editFeedbackRunner` and `formatRunner`; the harness
  // projects `format` as a tool and carries the diagnostics on the next
  // PreToolUse `additionalContext`.
  pi: true,
  // Never wired, NOT impossible: the SDK observes PostToolUse and supports
  // `updatedToolOutput`, and `claude-agent.ts` declines to synthesize an
  // internal hook on purpose.
  anthropic: false,
  // Never wired, NOT impossible: `postToolUse` is in codex's own eleven, and
  // `runtime-hook-events.ts` records our absent emitter as `unwired`.
  'codex-runtime': false,
  // Remote; there is no local file for a local linter to read.
  'nestor-cloud-agent': false,
};

export const HOST_EDIT_TOOLING_RUNTIMES: ReadonlySet<AgentProvider> = new Set<AgentProvider>(
  (Object.keys(HOST_EDIT_TOOLING_SUPPORT) as AgentProvider[])
    .filter(provider => HOST_EDIT_TOOLING_SUPPORT[provider]),
);

/** True when `provider` gets the host's post-edit diagnostics and `format` tool. */
export function runtimeRunsHostEditTooling(provider: AgentProvider | undefined): boolean {
  return provider === undefined || HOST_EDIT_TOOLING_RUNTIMES.has(provider);
}

/**
 * Which runtimes can BRANCH A SESSION — the sixth record, and the first whose
 * absence was visible in the session list rather than in a menu (P6.101,
 * ledger F3/codex).
 *
 * ## The defect this repairs, and it is not only codex's
 *
 * `supportsBranching` had two answers and no record behind either. Live, it was
 * the agent instance's `_supportsBranching`; COLD — no live agent — it was the
 * literal `true`, "default: branching enabled for all backends". So a cold
 * session offered Branch on every backend in the vocabulary, including
 * `nestor-cloud-agent`, whose own instance has said `false` since it was
 * written. The instance override could not gate the session list, because the
 * session list never asks an instance.
 *
 * That is why this is a RECORD and not a fourth `_supportsBranching` override:
 * the two readers — the instance getter and the no-live-agent fallback in
 * `SessionManager.resolveSupportsBranching` — must give the same answer for the
 * same provider, and a per-instance field can only speak for a session that is
 * already running.
 *
 * ## Native mechanism, asked and answered
 *
 * None is needed for the GATE, and the gate is all this record is. What each
 * runtime offers for the branch itself is the next row's subject: Pi has turn
 * anchors, claude has `resume` + `resumeSessionAt`, codex has `thread/fork`
 * with `lastTurnId` (`v2/ThreadForkParams.ts`) — reachable and, at the commit
 * that introduces this record, not yet wired. A gate that says `false` while
 * the runtime has a native mechanism is a statement about US, and it is
 * withdrawn by wiring the mechanism, not by widening the record.
 *
 * Total over the vocabulary for {@link AGENT_DEFINITION_DISPATCH}'s reason: a
 * new runtime must WRITE its answer, with a reason, before the build passes.
 *
 * `undefined` answers `true` for {@link runtimeDispatchesAgentDefinitions}'s
 * reason, which is also exactly the behaviour this record replaces.
 */
export const SESSION_BRANCHING_SUPPORT: Record<AgentProvider, boolean> = {
  // Pi turn anchors: `getPiTurnAnchor` reads the parent's sidecar and the
  // harness forks at `anchorEntryId`.
  pi: true,
  // The Claude Agent SDK's `resume` + `resumeSessionAt`, keyed on the parent
  // SDK session id, with a lineage check before the anchor is trusted.
  anthropic: true,
  // P6.277 — TRUE since P6.102 built it, and this cell said `false` for the
  // whole time in between, which is the finding rather than the fix.
  //
  // The sentence it carried — "`codex-agent.ts` never reads
  // `config.session.branchFrom` — 0 hits" — was a real measurement and P6.102
  // (`2ea351566`) refuted it: `codex-agent.ts` reads
  // `this.config.session?.branchFrom` and opens the parent thread with
  // `thread/fork` + `lastTurnId`, codex's own branch-from-a-turn primitive
  // ("Optional last turn id to fork through, inclusive. When specified, turns
  // after `last_turn_id` are omitted from the fork" —
  // `codex-protocol/generated/v2/ThreadForkParams.ts`). The host writes the
  // codex turn anchor to a sidecar, checks its lineage, and degrades to the
  // documented full-history fork when it is missing or mismatched.
  //
  // ONE predicate gates the offer AND the dispatch (`runtimeBranchesSessions`,
  // read by `resolveSupportsBranching` and by `createSession`'s branch
  // validation), so leaving it `false` did not merely hide a button: it refused
  // the whole capability by name, and every line P6.102 landed was unreachable
  // by any user. Pinned against the source itself in
  // `sessions/__tests__/cold-session-branching.test.ts`, so this cell cannot
  // outlive its reason a second time.
  'codex-runtime': true,
  // Remote: the fork would have to happen on the other side of the A2A wire.
  // `NestorCloudAgent` has said this on its instance since it was written; this
  // is the first place a COLD session can read it.
  'nestor-cloud-agent': false,
};

export const SESSION_BRANCHING_RUNTIMES: ReadonlySet<AgentProvider> = new Set<AgentProvider>(
  (Object.keys(SESSION_BRANCHING_SUPPORT) as AgentProvider[])
    .filter(provider => SESSION_BRANCHING_SUPPORT[provider]),
);

/** True when a session on `provider` can be branched from one of its messages. */
export function runtimeBranchesSessions(provider: AgentProvider | undefined): boolean {
  return provider === undefined || SESSION_BRANCHING_RUNTIMES.has(provider);
}

/**
 * P6.721 — which runtimes MINT auto-mode denial receipts at all.
 *
 * The defect this closes is an EMPTY LIST that means two different things. The
 * denials channel handed every client a bare array, and only one client — the
 * settings section — carried a static sentence saying it was claude-only. A
 * second client reading the same channel would have reported *"the safety judge
 * refused nothing"* for a Pi or codex session, which has no denial history at
 * all.
 *
 * A record rather than a condition at the read, for this file's own reason: the
 * two readers (`SessionManager.getRecentAutoModeDenials` and the RPC verb's
 * marker) sit in different layers, and a drift between them is silent in the
 * direction that hurts.
 *
 * ## Native mechanism, asked and answered
 *
 * None on any runtime. No runtime exposes a denial history we could enable —
 * the denominator's own verdict is A42 pi `absent`, codex `absent` — and
 * claude's ring is OURS, minted by `ClaudeAgent` from the `PermissionDenied`
 * hook and the SDK's `system/permission_denied` message. This is host case (2):
 * the host cannot supply the receipt uniformly, so its job is to make the
 * residual difference HONEST, which is exactly what this record is for.
 *
 * Total over the vocabulary for {@link AGENT_DEFINITION_DISPATCH}'s reason: a
 * new runtime must WRITE its answer before the build passes.
 */
export const AUTO_MODE_DENIAL_SUPPORT: Record<AgentProvider, boolean> = {
  // `ClaudeAgent` retains a bounded ring of receipts, minted at both sites: the
  // `PermissionDenied` hook and `system/permission_denied`.
  anthropic: true,
  // Pi's Guardian refuses, and keeps no receipt a host can read.
  pi: false,
  // codex's reviewer likewise; A42 codex `absent` in the denominator.
  'codex-runtime': false,
  // Remote; mints nothing locally.
  'nestor-cloud-agent': false,
};

/**
 * True when `provider` can produce a denial receipt, so an empty list from it
 * means "none yet" rather than "no such mechanism".
 *
 * Note the deliberate asymmetry with {@link runtimeDispatchesWorkflows}, which
 * treats `undefined` as permissive: an UNKNOWN runtime must not claim support
 * here, because the whole point of the record is that "no receipts" and "no
 * mechanism" stop being the same answer. Claiming support for a runtime we
 * cannot name would re-create the defect on the one path where we know least.
 */
export function runtimeMintsAutoModeDenials(provider: AgentProvider | undefined): boolean {
  return provider !== undefined && AUTO_MODE_DENIAL_SUPPORT[provider];
}
