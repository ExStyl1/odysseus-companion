/**
 * L2 — THE LIVE SESSION'S INPUT CHANNEL, AND THE ONE THING THAT MAY END IT.
 *
 * A `query()` whose `prompt` is a STRING is single-turn: the SDK sets
 * `isSingleUserTurn` and its reader calls `transport.endInput()` at the first
 * `result`, which is EOF to the child and therefore the child's exit. That one
 * line is the whole reason today's Claude backend is one process per user
 * message (pinned by `claude-turn-cancel-contract.test.ts`, "a STRING prompt
 * makes the SDK close the child stdin at the first result").
 *
 * An async-iterable prompt does not do that. `ClaudeInputChannel` is that
 * iterable: it yields the messages we write and only ends when we END it, so the
 * process outlives the turn.
 */
import type {
  Options,
  SDKControlReloadPluginsResponse,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * A hand-fed `AsyncIterable<SDKUserMessage>`.
 *
 * `write` is synchronous and unbounded on purpose: a turn must never be blocked
 * on the SDK draining the channel, and the queue only ever holds the handful of
 * messages one turn writes.
 */
export class ClaudeInputChannel {
  private readonly pending: SDKUserMessage[] = [];
  private notify: (() => void) | null = null;
  private ended = false;

  get isEnded(): boolean {
    return this.ended;
  }

  write(message: SDKUserMessage): void {
    if (this.ended) return;
    this.pending.push(message);
    this.wake();
  }

  /** EOF. The child sees stdin close and exits — this is the reaper's lever. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.wake();
  }

  async *stream(): AsyncIterable<SDKUserMessage> {
    for (;;) {
      while (this.pending.length > 0) {
        yield this.pending.shift()!;
      }
      if (this.ended) return;
      await new Promise<void>(resolve => {
        this.notify = resolve;
      });
      this.notify = null;
    }
  }

  private wake(): void {
    const notify = this.notify;
    this.notify = null;
    notify?.();
  }
}

/**
 * THE OPTIONS A LIVE QUERY CANNOT CHANGE.
 *
 * ## L4 corrected the premise this file was written on
 *
 * L2 recorded — and this comment used to assert — that "the SDK exposes exactly
 * three live setters (`setModel`, `setPermissionMode`, `supportedCommands`) and
 * nothing else; verified against the whole `sdk.d.ts`". **That is false for the
 * SDK we ship.** `@anthropic-ai/claude-agent-sdk@0.3.218`'s `Query` interface
 * declares 27 methods, and the mutating ones are `interrupt`,
 * `setPermissionMode`, `setMcpPermissionModeOverride`, `setModel`,
 * `setMaxThinkingTokens` (deprecated), `applyFlagSettings`, `reloadPlugins`,
 * `reloadSkills`, `reconnectMcpServer`, `toggleMcpServer`, **`setMcpServers`**,
 * `rewindFiles`, `seedReadState`, `stopTask`, `backgroundTasks` and `close`.
 * `supportedCommands` is not a setter at all — it is a getter.
 *
 * The correction that matters here is `setMcpServers`, because "the MCP server
 * set is a construction option with no live equivalent" was the stated reason
 * source activation had to respawn. It has one. See {@link claudeLiveSettings}.
 *
 * ## What still has no setter, re-verified the same way
 *
 * `cwd`, `systemPrompt`, `tools`, `agents` and our SDK-callback `hooks`. No
 * method on `Query` takes any of them: `reloadPlugins` / `reloadSkills` reload
 * from DISK and cannot see `options.agents`, and `applyFlagSettings` merges the
 * settings-file `Settings` shape, whose 137 keys include `model`, `permissions`
 * and `hooks` but no system prompt. (The CLI's own `set_model` control request
 * does accept a `system_prompt` field — the SDK's `setModel(model?: string)`
 * gives no way to send it, so it is unreachable from here and is not promised.)
 *
 * So a session that outlives the turn is only correct while the option set it
 * was built with is still the one this turn wants, MINUS the fields a setter can
 * move. When it is not, the honest move is to respawn, and this signature is
 * what detects that.
 *
 * It is a WHITELIST rather than a `JSON.stringify(options)` for two reasons that
 * both produce wrong answers: the option object carries live callbacks (`hooks`,
 * `canUseTool`, `stderr`) whose identity changes every turn while their MEANING
 * does not — they read `this.*` at call time — and it carries MCP server
 * instances that are neither stable nor serializable. Hashing either would
 * respawn on every turn and leave the shape one-shot with nothing in the log to
 * say so.
 *
 * `resume` / `forkSession` / `resumeSessionAt` are deliberately ABSENT: the
 * resume anchor is satisfied by the live process itself once it is running, and
 * hashing it here would respawn on turn two of every session. `ClaudeAgent`
 * checks the anchor separately against the session id the live stream reported.
 *
 * `model`, `permissionMode` and `mcpServers` are ABSENT since L4, and
 * `disallowedTools` since P6.221, for the opposite reason: each has a live
 * setter — the first three their own, the fourth the general
 * `applyFlagSettings` — so hashing them would respawn for a change the running
 * child can take. They are reconciled by
 * {@link claudeLiveSettings} instead, and a reconciliation that FAILS falls back
 * to the respawn this signature would have forced — so the safety floor is
 * unchanged and only the happy path got cheaper.
 *
 * `allowDangerouslySkipPermissions` STAYS, and it is the reason the permission
 * mode is not fully live. It is a spawn-time CLI flag
 * (`sdk.mjs`: `if(b)H.push("--allow-dangerously-skip-permissions")`), and the
 * shipped CLI refuses a live switch into the mode that needs it, in its own
 * words: *"Cannot set permission mode to bypassPermissions because the session
 * was not launched with --dangerously-skip-permissions"*. So crossing the bypass
 * boundary in either direction is a real construction-option drift and respawns.
 *
 * ## P3.48 — `enableFileCheckpointing` was absent; P6.272 gave it a writer, so
 * ## it is hashed (this section is kept as the reason, not as a prediction)
 *
 * It is a real construction option (`sdk.d.ts:1510`) and it gates
 * `Query.rewindFiles()`, whose own doc line says so: *"Requires file
 * checkpointing to be enabled via the `enableFileCheckpointing` option."* It is
 * not hashed here, and today that is harmless for a reason worth stating rather
 * than assuming: **nothing in this tree sets it at all.** Measured 2026-09-03
 * with positive controls on the identical command (`git grep -a -l` over
 * `:(glob)packages/**` and `:(glob)apps/**`): `enableFileCheckpointing` **0
 * files**, against `rewindFiles` 4, `resumeSessionAt` 6 and `maxBudgetUsd` 25 —
 * a reading with a date, not a constant (a sibling lane counted 3/6/22 on the
 * same names hours earlier, because lanes kept committing).
 *
 * That was true while it had no writer. **P6.272 gave it one, and P6.851 (owner
 * decision 2026-09-10) made it UNCONDITIONAL**: `claude-agent.ts` passes
 * `enableFileCheckpointing: getFileCheckpointingEnabled()`, so the child now
 * receives `true` or `false` and never nothing. The option is hashed below.
 * Unlike `model`/`permissionMode`/`mcpServers` above there is no live setter to
 * reconcile it with, so respawn is the only route — which is what hashing it
 * buys: flipping the setting mid-session rebuilds the child instead of leaving
 * one that was constructed under the old answer.
 */
export function claudeLiveSessionSignature(options: Options): string {
  const raw = options as unknown as Record<string, unknown>;
  const sortedKeys = (value: unknown): string[] =>
    value && typeof value === 'object' ? Object.keys(value as object).sort() : [];

  const parts: Record<string, unknown> = {
    // `model` — NOT hashed. `Query.setModel` moves it on a live session.
    cwd: raw.cwd ?? null,
    // P6.272 + P6.851 — see the P3.48 section above. `null` is the unset case,
    // which since P6.851 only a child built by an OLDER BUILD can be in: `true`
    // and `false` are both real answers now and hash apart from it and from each
    // other, so the first turn after an upgrade respawns once. Folding unset
    // into `true` would hide a real construction difference instead.
    enableFileCheckpointing: raw.enableFileCheckpointing ?? null,
    executable: raw.pathToClaudeCodeExecutable ?? null,
    // Composition, not identity: `{ type:'preset', preset, append }` or a plain
    // string. A changed append is a changed system prompt and the SDK has no
    // setter for it.
    //
    // UB12.21 — STAYS, although under the recorded prompt (UB2.13's
    // `snapshot: true`) the resumed child ignores the new append. The vendored
    // `sdk.d.ts` (`Options.systemPrompt`, the `snapshot` paragraph) says a
    // different append on a later launch "is ignored until compaction or a new
    // session", so the append compaction renders from is the running child's.
    // Without this respawn, a mid-session output-style switch would outlive
    // compaction too. The same paragraph says recording "is rolling out", and
    // where it is not enabled the respawn is the only way the new append
    // reaches the model. The switch itself reaches the model as a one-shot
    // notice (`core/output-style-switch.ts`).
    systemPrompt: raw.systemPrompt ?? null,
    // P6.221 — STAYS. `settingSources` is an `Options` field with no `Settings`
    // key behind it: `applyFlagSettings` merges the settings-file `Settings`
    // shape, and that shape has no such member (measured against the vendored
    // `sdk.d.ts`'s `interface Settings`). So there is no live route for it, and
    // the row's "three flags" is two.
    //
    // It CAN drift now, and that is what the hash is for: P6.930 clause (2) gave
    // the list an operator flag (`--setting-sources`, carried by
    // `NESSY_CLAUDE_SETTING_SOURCES`), so a session whose operator narrows or
    // widens it must be rebuilt rather than left running on the list it was
    // launched with. This line used to say the option could not drift on this
    // fork because `claude-agent.ts` passed a constant; it no longer does.
    settingSources: raw.settingSources ?? null,
    // P6.439 clause (1) — the `--settings` flag-settings tier. A CONSTRUCTION
    // option: `Query` has no member that touches it (the same `sdk.d.ts` method
    // scan that guards the setter-less options below), and the SDK spends it
    // once in its argv builder. So an operator who changes the flag and
    // restarts the CLI must get a new child — a live one would keep applying
    // the tier it launched with, and a settings TIER is exactly the kind of
    // stale value nothing else in the session would contradict.
    //
    // Hashed as the VALUE, not a digest: it is a small settings object and
    // `JSON.stringify` below already normalises it.
    //
    // P6.1009 CORRECTS what this value IS. The two sentences above described it
    // as the flag's own value — *"either a path string or a small settings
    // object"* — and it never was: `claude-agent.ts` builds `Options.settings`
    // from `composeClaudeSpawnSettings`, whose merge overwrote the flag in the
    // same object literal. Since P6.1009 the flag is the LAST contributor to
    // that same merge, so what is hashed here is the COMPOSED value — the
    // credential floor, the auto-mode policy, the WebFetch preflight, the user's
    // `worktree.bgIsolation` and whichever of the flag's keys survived them.
    // That is the right thing to hash either way: every one of those is a
    // construction input with no live setter, and a change in any of them has to
    // rebuild the child. `null` is unreachable on the real spawn path (the
    // `worktree` contributor is unconditional) and is kept for a child built by
    // an older build, and for the unit tests that compose a subset.
    settings: raw.settings ?? null,
    // P6.931 — the tier ABOVE `settings`, and the one with a security meaning.
    //
    // `managedSettings` was in no signature and in no live setter: `Query`
    // exposes nothing that touches it (the same `sdk.d.ts` method scan that
    // guards the setter-less options below), and it was not among the
    // deliberate absences this module's header enumerates either — it was
    // simply missing. Meanwhile it is COMPOSED PER TURN, by
    // `buildClaudeManagedSettingsOptions` from four contributors, two of which
    // are re-read from disk or from preferences on every turn
    // (`resolveManagedPiPolicyFloor()`, `resolveGitAttribution()`). So an
    // administrator tightening a managed policy mid-session was met by a live
    // child still enforcing the policy it launched with, and nothing said so.
    //
    // The shape P6.439 (1) closed for `settings`, one tier up: hashed as the
    // VALUE, `null` when the option is absent — which is what an unmanaged
    // install gets, since the builder returns `{}` with nothing to say — so an
    // install without a managed policy keeps the signature it had before this
    // row.
    managedSettings: raw.managedSettings ?? null,
    maxTurns: raw.maxTurns ?? null,
    tools: raw.tools ?? null,
    // `disallowedTools` — NOT hashed since P6.221. A GROWN deny list is applied
    // to the running child through `Query.applyFlagSettings({permissions:{deny}})`;
    // a NARROWED one still respawns, because the launch-time `--disallowedTools`
    // flag cannot be unsaid from the flag-settings layer. See
    // {@link claudeDenyListDrift} for the verdict and its reason.
    // P6.221 — STAYS, and for a measured reason rather than caution:
    // `allowedTools` is never passed by this fork at all (`claude-agent.ts`
    // builds `disallowedTools` only), so it cannot drift, and a value that
    // cannot drift costs nothing to hash. The day something starts passing it
    // CONDITIONALLY, the same asymmetry as the deny list applies — a widened
    // allow list is live, a narrowed one is a respawn — and this line must move
    // to `claudeLiveSettings` with that rule, not simply be deleted.
    allowedTools: Array.isArray(raw.allowedTools) ? [...raw.allowedTools].sort() : null,
    // `mcpServers` — NOT hashed. `Query.setMcpServers` moves the NAME SET on a
    // live session; the reconciliation is by name on the SDK side too, so this
    // was already the only part of it that could ever have been compared here.
    // Definitions, because an agent's prompt or tool list changing is a changed
    // option set even when the names are identical.
    agents: raw.agents ?? null,
    // P6.312 — WHICH of those definitions the main thread runs as. A
    // construction option: `Query` exposes nothing that re-points the main
    // thread, and the SDK spends it once at spawn, so a changed pin has to
    // respawn or the live child keeps running as the agent it launched as.
    //
    // Hashed SEPARATELY from `agents` above and not implied by it: two agents
    // that declare no model register identically, so a pin moving from one to
    // the other leaves `agents` byte-identical and would otherwise be invisible
    // here. `null` when unpinned, which is every session that has not set the
    // host key.
    agent: raw.agent ?? null,
    // `permissionMode` — NOT hashed. `Query.setPermissionMode` moves it.
    allowDangerouslySkipPermissions: raw.allowDangerouslySkipPermissions ?? null,
    thinking: sdkThinkingConfig(raw), // F1.802 — the SDK's own fold of `thinking` + `maxThinkingTokens`; see the file end
    effort: raw.effort ?? null,
    // `maxThinkingTokens` — never hashed on its own since F1.802: it is folded into `thinking` above, as `query()` folds it.
    includePartialMessages: raw.includePartialMessages ?? null,
    // P3.336 — hashed for the same reason its neighbour is: the flag is spent
    // once, at launch (`setAllHookEventsEnabled` in the child, from the init
    // payload), and no `Query` member moves it. It is a literal `true` on every
    // turn today, so this changes no signature by itself; it is here so that a
    // later row making it conditional cannot leave a live child running on the
    // launch-time value with nothing to say so.
    includeHookEvents: raw.includeHookEvents ?? null,
    outputFormat: raw.outputFormat ?? null,
    // P2.28 — the USD ceiling. `Query` has no setter for it — asserted by the
    // same `sdk.d.ts` method scan that guards the five setter-less options
    // named above (`claude-live-settings.test.ts`, "nothing sets the USD
    // ceiling either") — so it is a construction option and a changed ceiling
    // has to respawn: the host-side
    // loop re-reads its own ceiling every turn, and a live child still running
    // yesterday's number would cap at a figure the user has already changed.
    // Absent when the cap is off, so an uncapped session's signature is
    // unchanged from before this row.
    maxBudgetUsd: raw.maxBudgetUsd ?? null,
    // P3.264 — the fallback CHAIN. A construction option for the same reason
    // the ceiling above is one: the SDK spends it once, in the argv builder
    // (`sdk.mjs`: `Y.push("--fallback-model",h)`), and no `Query` member moves
    // it. A user editing the chain mid-session would otherwise keep running on
    // the child's launch-time value with nothing in the log to say so — and
    // `model-config.md#fallback-model-chains` records that the chain is
    // invisible from the other side too (*"Claude Code doesn't confirm the
    // chain at startup and `/status` doesn't display it"*), so a stale one has
    // no second reporter. Absent when unconfigured, so an install with no chain
    // has the signature it had before this row.
    fallbackModel: raw.fallbackModel ?? null,
    // P6.34 — the `--add-dir` roots. A construction option, asserted the same
    // way the five setter-less options above are: `Query` in `sdk.d.ts` exposes
    // `setModel`, `setPermissionMode` and `setMcpServers` and NOTHING that moves
    // a directory root, and the SDK spends this option once, in its argv builder
    // (`sdk.mjs`: `for(let W of e)B.push("--add-dir",W)`), before the child
    // starts. So a user editing `additionalDirectories` mid-session has to
    // respawn to get the skills, commands and subagents of the new root — which
    // is exactly what hashing it here buys.
    //
    // UNSORTED, unlike `allowedTools`/`disallowedTools` a few lines up, and the
    // difference is not an oversight: those are sets, these are ordered. Two
    // added roots defining the same command name are resolved by order, so a
    // reorder is a real change of what the child would load and must respawn.
    additionalDirectories: Array.isArray(raw.additionalDirectories)
      ? [...(raw.additionalDirectories as unknown[])]
      : null,
    env: withoutSdkSelfWrittenEnv(raw.env), // F1.512 — see the file end
    plugins: raw.plugins ?? null,
    // Shape only — the handlers are closures over `this`, but a hook EVENT
    // appearing or disappearing (a user editing automations.json) is a real
    // change the live query cannot take.
    hookEvents: Object.entries((raw.hooks ?? {}) as Record<string, unknown[]>)
      .map(([event, matchers]) => `${event}:${Array.isArray(matchers) ? matchers.length : 0}`)
      .sort(),
  };

  return JSON.stringify(parts, (_key, value) =>
    typeof value === 'function' ? '[fn]' : value,
  );
}

/**
 * L4 — THE THREE OPTIONS A RUNNING CHILD CAN BE TOLD ABOUT.
 *
 * The complement of {@link claudeLiveSessionSignature}: what the signature stops
 * hashing, this carries, so that a drift here becomes a control request instead
 * of a new process.
 *
 * - `model` → `Query.setModel(model?)`
 * - `permissionMode` → `Query.setPermissionMode(mode)`, ALREADY TRANSLATED
 *   through `toClaudeSdkPermissionMode` by `buildClaudePermissionModeOptions`,
 *   which is what puts it in `options` in the first place. Reading it back off
 *   the options is deliberate: it is the one mapping, and `explore` — which has
 *   no SDK member — must not acquire a second spelling on the live path.
 * - `mcpServerNames` → `Query.setMcpServers(servers)`
 * - `disallowedTools` → `Query.applyFlagSettings({permissions:{deny}})` — P6.221,
 *   and the one entry here with a DIRECTION: see {@link claudeDenyListDrift}.
 *   The row that opened this called it three flags. Measured at HEAD it is one:
 *   `allowedTools` is never passed by this fork and `settingSources` is a
 *   constant with no `Settings` key behind it, so neither can drift.
 *
 * NAMES, not instances, for the MCP set — and that is the SDK's own granularity
 * rather than a shortcut of ours. `Query.setMcpServers` diffs the payload
 * against `sdkMcpServerInstances` BY KEY: a name already present is not
 * reconnected and keeps its original instance. So a same-name-different-instance
 * change is invisible to the live path — exactly as it was invisible to the
 * signature, which only ever hashed the keys.
 */
export interface ClaudeLiveSettings {
  /** `undefined` means "the CLI's default model", which is what `setModel()` with no argument asks for. */
  readonly model: string | undefined;
  /** Already in the SDK's vocabulary. `undefined` when the options carry none. */
  readonly permissionMode: string | undefined;
  /** Sorted, so a rebuilt option object with a different key order is not a drift. */
  readonly mcpServerNames: readonly string[];
  /**
   * P6.221 — the session's banned tool names, sorted.
   *
   * Carried here rather than hashed into the signature because
   * `Query.applyFlagSettings` can move them on a running child, and
   * `agent-sdk/typescript.md#applyflagsettings` names this exact use:
   * *"Use it when a setting that has no dedicated setter needs to change
   * mid-session, such as tightening `permissions` after the agent reads
   * untrusted input."* The page also fixes WHEN it lands: `permissions` is in
   * the *"Applied on the next turn"* group, which is the turn this
   * reconciliation runs for.
   */
  readonly disallowedTools: readonly string[];
}

/**
 * P6.221 — what changed about the deny list, and whether the running child can
 * be told.
 *
 * The asymmetry is the SDK's, not ours. `disallowedTools` is spent ONCE, in the
 * argv builder (measured in the vendored `sdk.mjs`:
 * `if(U.length>0)Y.push("--disallowedTools",U.join(","))`), so a name given at
 * launch is a CLI flag the flag-settings layer cannot retract. What
 * `applyFlagSettings` can do is ADD, because a deny rule wins wherever it is
 * declared:
 *
 * - `same` — nothing to do.
 * - `grown` — every current entry is still there and there are new ones. The
 *   new bans are written to the flag layer and take effect next turn.
 * - `narrowed` — an entry was removed. Unreachable through the flag layer, so
 *   the honest answer is the respawn this file's signature used to force for
 *   every change. Reporting it as applied would leave the model without a tool
 *   the user just re-enabled, with nothing anywhere to say so.
 *
 * One behavioural difference belongs in the open, because it is real and it is
 * small: `--disallowedTools` REMOVES a tool from the model's context
 * (`sdk.d.ts`: *"These tools will be removed from the model's context and cannot
 * be used"*), whereas a live-added `permissions.deny` rule leaves it visible and
 * refuses the call. A tool banned mid-session is therefore enforced either way,
 * but on the live path the model can still spend a call discovering it. The
 * alternative is a whole new process per ban, which costs the user the session.
 */
export function claudeDenyListDrift(
  current: readonly string[],
  wanted: readonly string[],
): 'same' | 'grown' | 'narrowed' {
  const wantedSet = new Set(wanted);
  for (const name of current) {
    if (!wantedSet.has(name)) return 'narrowed';
  }
  return wantedSet.size === new Set(current).size ? 'same' : 'grown';
}

export function claudeLiveSettings(options: Options): ClaudeLiveSettings {
  const raw = options as unknown as Record<string, unknown>;
  const servers = raw.mcpServers;
  return {
    model: typeof raw.model === 'string' ? raw.model : undefined,
    permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode : undefined,
    mcpServerNames: servers && typeof servers === 'object'
      ? Object.keys(servers as object).sort()
      : [],
    disallowedTools: Array.isArray(raw.disallowedTools)
      ? [...(raw.disallowedTools as string[])].sort()
      : [],
  };
}

/** Same set, order-insensitively — the comparison `mcpServerNames` is sorted for. */
export function sameMcpServerNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/**
 * P6.412 — THE NATIVE PLUGIN RELOAD, WHICH THIS FORK SHIPPED AND NEVER CALLED.
 *
 * The vendored SDK declares it — `sdk.d.ts:2544`
 * `reloadPlugins(): Promise<SDKControlReloadPluginsResponse>;`, documented one
 * line above as *"Reload plugins from disk and return the refreshed commands,
 * agents, plugins, and MCP server status."* — and `git grep -a '\.reloadPlugins('`
 * scored **0** call sites at HEAD, against two doc-comment mentions in this very
 * file. Our activation model is turn-boundary based instead: `afterPluginMutation`
 * refreshes an idle session and defers a busy one.
 *
 * This is the tier-1 answer the owner rule asks for first — the runtime already
 * has the mechanism, so it is enabled rather than rebuilt beside.
 *
 * ## The cost, verbatim, because it is the user's to accept
 *
 * `plugins/loading.md#check-which-stage-a-plugin-reached`: *"Reloading has
 * a token cost on the next request: newly loaded components announce themselves
 * in content appended to the conversation, while the existing history still
 * reads from the prompt cache. A plugin that provides MCP servers costs more
 * when its tools aren't deferred by tool search: the change invalidates the
 * cache and the next request re-reads the entire conversation."*
 *
 * ## There is NO force flag on this seam, and that is a measurement
 *
 * The same page says the CLI's own command *"warns and skips until you rerun it
 * with `--force`"* when the reload would invalidate the prompt cache. That
 * warn-and-skip is the SLASH COMMAND's, not the control request's:
 * `SDKControlReloadPluginsRequest` is `{ subtype: 'reload_plugins' }` and nothing
 * else (`sdk.d.ts:3932`), and `Query.reloadPlugins()` takes no arguments. So a
 * call through this seam is UNCONDITIONAL — it is already the `--force`
 * behaviour, and there is no warn-and-skip to offer.
 *
 * The consequence for the surface is stated rather than papered over: the host
 * cannot ask before the SDK reloads, so the honest affordance names the cost
 * that was paid, and re-implementing warn-and-skip host-side would be building
 * beside a native mechanism rather than enabling it.
 *
 * ## Shape
 *
 * A structural single-method parameter rather than the SDK's whole `Query`, so a
 * caller (and a test) needs nothing but the method this uses, and never throws:
 * a mutation is already committed by the time anybody reloads, so a failed
 * reload must degrade to the turn-boundary path — which is exactly what the
 * caller does with `applied: false`.
 */
export interface ClaudePluginReloadQuery {
  reloadPlugins(): Promise<SDKControlReloadPluginsResponse>;
}

/**
 * What a native reload did. `applied: false` is "the running child kept the
 * paths it had", which is the turn-boundary path this fork already has — never
 * an error the caller must handle.
 */
export type ClaudePluginReloadOutcome =
  | {
    readonly applied: true;
    /** The refreshed counts the SDK returns, for the line that reports it. */
    readonly plugins: number;
    readonly commands: number;
    readonly agents: number;
    readonly mcpServers: number;
    /** `SDKControlReloadPluginsResponse.error_count` — reloaded, but not cleanly. */
    readonly errorCount: number;
  }
  | { readonly applied: false; readonly reason: string };

export async function reloadClaudePlugins(
  query: ClaudePluginReloadQuery | null | undefined,
): Promise<ClaudePluginReloadOutcome> {
  // No live child: there is no runtime holding stale paths, so there is nothing
  // to reload and nothing to report as reloaded.
  if (!query) return { applied: false, reason: 'no live session' };
  try {
    const refreshed = await query.reloadPlugins();
    return {
      applied: true,
      plugins: refreshed.plugins.length,
      commands: refreshed.commands.length,
      agents: refreshed.agents.length,
      mcpServers: refreshed.mcpServers.length,
      errorCount: refreshed.error_count,
    };
  } catch (error) {
    return { applied: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * F1.512 (origin WJ-af P-WJ-af-4) — THE NAMES THE VENDORED SDK WRITES ONTO THE
 * HOST'S OWN `process.env`, which {@link claudeLiveSessionSignature} must not
 * read as a construction drift.
 *
 * Every turn head builds `options.env` from `{ ...process.env, … }`
 * (`buildClaudeSubprocessEnv`, `agent/options.ts`), and the signature hashes the
 * whole of it — rightly: an env drift is a real change the running child cannot
 * be told about. But the SDK's `query()` writes
 * `process.env.CLAUDE_AGENT_SDK_VERSION` on EVERY call, before it spawns. So the
 * first turn of an app run hashed an env without the name, the second hashed an
 * env with it, and `ensureLiveSession` respawned the child at turn 2 — ending
 * every background task turn 1 had started (`endLiveSession`; L5). Measured by
 * WJ-af on the vendored claude 2.1.251 driven through `ClaudeAgent`: exactly one
 * name differed between the two turns' `options.env`, this one.
 *
 * ## The census, and its instrument (0.3.251, 2026-09-24)
 *
 * A regex over the vendored `sdk.mjs` — `process.env.<NAME>=` not followed by a
 * second `=` — finds three named writes and one computed one:
 *
 * - `CLAUDE_AGENT_SDK_VERSION = "<version>"` — inside `query()`, every call.
 * - `NoDefaultCurrentDirectoryInExePath = "1"` — at module evaluation, so it is
 *   present before the first turn head and cannot drift today; excluded anyway
 *   because it is the SDK's value, not the operator's.
 * - `DEBUG` — the `debug` library's `save(load())` at init writes back the value
 *   it just read, and its only other writer (`disable()`) has no caller; it can
 *   never move the hash, so it is NOT excluded.
 * - `process.env[r] = …` — an env-config object's `set`, whose three instances
 *   have no `.set(` caller in the bundle.
 *
 * So the rule is "the SDK originates a value" — a string literal on the right —
 * and `claude-sdk-self-written-env.test.ts` re-derives that set from the bundle,
 * so a lift that adds or drops a writer fails there instead of drifting here.
 *
 * ## Out of the HASH, not out of the child
 *
 * The child still receives both names: the SDK re-adds its own stamp for the
 * child when the env lacks one, and `NoDefaultCurrentDirectoryInExePath` is the
 * SDK's Windows executable-search hardening, which stripping would remove. What
 * the exclusion costs is stated rather than hidden: a stamp INHERITED from the
 * shell that launched the app reaches a turn-1 child and stays with it for its
 * life (the vendored binary reads it only into its `agent-sdk/<version>`
 * user-agent and a telemetry field), where it used to be corrected by the
 * respawn this row removes. That is why the name is also on
 * `scripts/cdp/lib/app-env.ts`'s `CONTAMINATING_ENV_NAMES`.
 */
export const CLAUDE_SDK_SELF_WRITTEN_ENV_NAMES: readonly string[] = [
  'CLAUDE_AGENT_SDK_VERSION',
  'NoDefaultCurrentDirectoryInExePath',
];

/** `options.env` as the signature hashes it: without the SDK's own writes. */
function withoutSdkSelfWrittenEnv(env: unknown): unknown {
  if (env === undefined || env === null) return null;
  if (typeof env !== 'object') return env;
  const hashed: Record<string, unknown> = { ...(env as Record<string, unknown>) };
  for (const name of CLAUDE_SDK_SELF_WRITTEN_ENV_NAMES) delete hashed[name];
  return hashed;
}

/**
 * F1.802 — THE THINKING CONFIG AS THE SDK SPENDS IT, which is what the signature
 * hashes.
 *
 * ## The respawn this closes
 *
 * `resolveClaudeThinkingOptions` spells "thinking off" two ways — `{ thinking:
 * { type: 'disabled' } }` when the model supports adaptive thinking, `{
 * maxThinkingTokens: 0 }` when it does not — and since P3.268 the RUNTIME answers
 * that question once it has spoken: `captureModelCapabilities` fills a
 * process-scoped record from the child's `initialize` response during turn 1.
 * So the first session of an app run on a given model builds turn 1 from the id
 * heuristic and turn 2 from the runtime's row. For a gateway id the two disagree
 * (`tgpt/…` is no Claude id, while the vendored 2.1.267 CLI lists the session's
 * own `--model` with `supportsAdaptiveThinking: true` — measured with a
 * `Query.supportedModels()` probe, 2026-09-25), and hashing both keys separately
 * turned the same "off" into a drift: release sitting SIT-p (packaged
 * `5896a66d2`) logged `tokens=0` then `disabled`, respawned the child on turn 2
 * and ended the background task turn 1 had started. F1.512 had already taken the
 * env half of the same respawn.
 *
 * ## Why the fold is the SDK's rule and not ours
 *
 * `query()` in the vendored `sdk.mjs` folds the two options into ONE value before
 * the transport sees either — `thinking` when set (`adaptive` → `{type, display}`,
 * `enabled` → `{type, budgetTokens, display}`, `disabled` → `{type}`), else
 * `maxThinkingTokens === 0 ? {type:"disabled"} : {type:"enabled",budgetTokens}` —
 * and its argv builder reads only that value, so both spellings of "off" launch
 * the same `--thinking disabled` child. Hashing the fold hashes what the child
 * receives. A `thinking` whose `type` the fold does not know makes the SDK send
 * NOTHING (the `else` never runs), and it is hashed raw, so it can only ever
 * produce a respawn, never hide one.
 *
 * ## What still respawns
 *
 * Every change the fold does not erase: off ↔ adaptive, a different budget, a
 * crossing into Haiku (adaptive+effort → a token budget), `effort` itself (bar
 * F1.821's clamp, file end). `claude-first-turn-thinking-drift.test.ts` pins both halves.
 */
function sdkThinkingConfig(raw: Record<string, unknown>): unknown {
  const thinking = raw.thinking;
  if (thinking && typeof thinking === 'object') {
    const config = thinking as { type?: unknown; budgetTokens?: unknown; display?: unknown };
    switch (config.type) {
      case 'adaptive': return { type: 'adaptive', display: config.display ?? null };
      case 'enabled': return { type: 'enabled', budgetTokens: config.budgetTokens ?? null, display: config.display ?? null };
      case 'disabled': return { type: 'disabled' };
      default: return { unrecognized: thinking };
    }
  }
  if (thinking !== undefined && thinking !== null) return { unrecognized: thinking };
  const budget = raw.maxThinkingTokens;
  if (budget === undefined || budget === null) return null;
  return budget === 0 ? { type: 'disabled' } : { type: 'enabled', budgetTokens: budget, display: null };
}

/**
 * F1.802 — WHY `ensureLiveSession` IS ABOUT TO RESPAWN, in names and never values.
 *
 * The drift line said only "drifted", so a sitting that met a respawn could not
 * tell which option moved — SIT-p had to infer `thinking` from two neighbouring
 * `[chat] Thinking:` lines. This names it:
 *
 * - the SIGNATURE KEYS whose hashed value changed (`thinking`, `effort`, …), and
 *   for `env` the changed variable NAMES as `env.<NAME>` — added, removed or
 *   changed — because the env is one key holding the whole child environment and
 *   "env" alone would say nothing. Values never leave this function: an env value
 *   can be a credential, and a signature value can carry a path or a prompt.
 * - when the signature did NOT move, the other causes `ensureLiveSession` checks,
 *   in its own order: a changed resume anchor, a fork, an ended input channel,
 *   and otherwise a live setter that could not apply the change (L4's
 *   fall-through).
 *
 * Both signatures are this module's own `JSON.stringify` output; an unparseable
 * one (unreachable here) says so rather than guessing.
 */
export function describeClaudeLiveRespawn(args: {
  previousSignature: string | null;
  signature: string;
  anchorMatches: boolean;
  forking: boolean;
  inputEnded: boolean;
}): string {
  const causes: string[] = [];
  if (args.previousSignature !== args.signature) {
    let before: Record<string, unknown>;
    let after: Record<string, unknown>;
    try {
      before = args.previousSignature === null ? {} : JSON.parse(args.previousSignature) as Record<string, unknown>;
      after = JSON.parse(args.signature) as Record<string, unknown>;
    } catch {
      return 'signature changed (unparseable, keys not named)';
    }
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const moved: string[] = [];
    for (const key of keys) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      if (key !== 'env') { moved.push(key); continue; }
      const envBefore = (before.env && typeof before.env === 'object' ? before.env : {}) as Record<string, unknown>;
      const envAfter = (after.env && typeof after.env === 'object' ? after.env : {}) as Record<string, unknown>;
      const names = [...new Set([...Object.keys(envBefore), ...Object.keys(envAfter)])].sort()
        .filter(name => JSON.stringify(envBefore[name]) !== JSON.stringify(envAfter[name]));
      // Capped: a wholesale env change would otherwise print every name the child has.
      const shown = names.slice(0, 24).map(name => `env.${name}`);
      if (names.length > shown.length) shown.push(`env (+${names.length - shown.length} more)`);
      moved.push(...(shown.length > 0 ? shown : ['env']));
    }
    causes.push(`changed: ${moved.join(', ') || 'none named'}`);
  }
  if (!args.anchorMatches) causes.push('resume anchor changed');
  if (args.forking) causes.push('fork requested');
  if (args.inputEnded) causes.push('input channel ended');
  return causes.length > 0 ? causes.join('; ') : 'a live setter could not apply the change';
}

// F1.821 — appended so no cited line of this file moves; imports are hoisted.
import { clampClaudeEffortLevel, type ClaudeModelCapabilityRow } from '../../claude-model-capabilities.ts';
import { THINKING_LEVEL_IDS } from '../../thinking-levels.ts';

/** The rank order `resolveClaudeThinkingOptions` clamps with — the same expression. */
const CLAUDE_EFFORT_ORDER: readonly string[] = THINKING_LEVEL_IDS.filter(id => id !== 'off');

/**
 * F1.821 (origin WJ-crit-ii P-WJcritii-1) — AN EFFORT THAT MOVED ONLY BECAUSE THE
 * HOST LEARNED THE MODEL'S LEVELS, which must not respawn the child.
 *
 * ## The respawn this closes
 *
 * F1.802's sibling. P3.268 fills the capability record from the child's
 * `initialize` response DURING turn 1, so turn 1 of the first session on a model
 * builds `effort` with no `supportedEffortLevels` to clamp against, and turn 2
 * clamps (`resolveClaudeThinkingOptions` → `clampClaudeEffortLevel`). On
 * `claude-sonnet-4-6` at `xhigh` that is `xhigh` then `high`; `effort` is hashed,
 * so turn 2 respawned and ended every background task turn 1 had started.
 *
 * ## Why the child needs no respawn: it was already there
 *
 * `model-config.md#adjust-effort-level`: *"If you set a level the active model
 * does not support, Claude Code falls back to the highest supported level at or
 * below the one you set."* That is `clampClaudeEffortLevel`'s own rule. Measured
 * on the vendored 0.3.267 / 2.1.267 child (DN-058 probe, dead loopback URL, no
 * network, 2026-09-26): it lists `claude-sonnet-4-6` with levels
 * `low/medium/high/max`; launched with `effort: 'xhigh'` its `get_settings`
 * reports `applied.effort: "high"`, and still `"high"` after
 * `applyFlagSettings({ effortLevel: 'high' })`.
 *
 * So the caller does not respawn. It tells the child through the SDK's own
 * setter for this key — `agent-sdk/typescript.md#applyflagsettings` lists
 * `effortLevel` under *"Applied on the next turn"* — and records the new
 * signature. When the setter is missing, refused or silent, L4's fall-through
 * respawns exactly as before.
 *
 * ## Deliberately narrow — what still respawns (F1.821's own clause)
 *
 * This returned the new level only when the two signatures differ in `effort`
 * ALONE, and the new level is exactly that documented fallback of the old one
 * under the row the runtime reported: a supported level ranked BELOW it. Every
 * other effort change returned `null` and kept respawning:
 *
 * - a user's own change (`high` → `low`) — live since F1.1099, below;
 * - a clamp to NO effort (`supportsEffort: false`) or UP to the lowest level a
 *   model offers — neither is the fallback the page documents;
 * - any change with no row reported yet, or alongside another hashed key.
 *
 * F1.1099 (origin DN-058) TOOK THAT RESIDUE: the same probe measured that the
 * setter moves ANY level (`applyFlagSettings({ effortLevel: 'low' })` on that
 * child gave `applied.effort: "low"`), so a user's own change between two levels
 * is told to the child too, and the background tasks turn 1 started survive it.
 * Read before widening (`prompt-caching.md#changing-effort-level`): on most
 * models a new effort level reads the whole history uncached, but a respawn that
 * resumes the conversation at the new level pays the same, so the live path
 * costs nothing extra; running subagents keep the level they started with either
 * way (a respawn ends them). What STILL respawns: a change to or from `max` —
 * `model-config.md#adjust-effort-level` makes `max` session-only and the
 * settings `effortLevel` key refuses it, and the DN-058 probe never moved a child
 * into or out of it, so the measured path is the only live one — except F1.821's
 * clamp of `max` above; a change from or to NO effort (a thinking/support change
 * — `effortLevel: null` resets to the model default, not to "none"); and any
 * change alongside another hashed key, `thinking` included.
 */
export function claudeEffortClampDrift(args: {
  previousSignature: string | null;
  signature: string;
  capabilities: ClaudeModelCapabilityRow | undefined;
}): string | null {
  if (args.previousSignature === null || args.previousSignature === args.signature) return null;
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  try {
    before = JSON.parse(args.previousSignature) as Record<string, unknown>;
    after = JSON.parse(args.signature) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key !== 'effort' && JSON.stringify(before[key]) !== JSON.stringify(after[key])) return null;
  }
  const from = before.effort;
  const to = after.effort;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const fromRank = CLAUDE_EFFORT_ORDER.indexOf(from);
  const toRank = CLAUDE_EFFORT_ORDER.indexOf(to);
  if (fromRank < 0 || toRank < 0) return null;
  if (from !== 'max' && to !== 'max') return to; // F1.1099 — a user's own change between two levels
  if (!args.capabilities?.supportedEffortLevels?.includes(to) || toRank >= fromRank) return null;
  return clampClaudeEffortLevel(from, args.capabilities, CLAUDE_EFFORT_ORDER) === to ? to : null;
}

/**
 * **UA1.20 follow-up — the deny list a LIVE `applyFlagSettings` may carry: the
 * wanted list less every `toolAliases` key, or `null` (respawn).**
 *
 * An alias key in a settings-layer deny rule denies its TARGET too. Read in the
 * vendored 2.1.274 bundle, not on a docs page and not measured live: the CLI
 * copies `Options.toolAliases` into `toolPermissionContext.toolAliases`, and a
 * deny rule whose source is anything but `cliArg`/`toolsNarrowing` is matched
 * with proxy expansion (`function Hi(e){return
 * e.source!=="cliArg"&&e.source!=="toolsNarrowing"}`) over `Vhe(rule,
 * toolAliases)` = `[rule, alias]`. So `Artifact` sent through the flag layer
 * would remove `mcp__session__publish_artifact` — the one sanctioned publish
 * path — and `Monitor`/`ScheduleWakeup` their session twins.
 *
 * Dropping them loses no ban: the launch-time `--disallowedTools` is `cliArg`
 * (never expanded, never retracted by the flag layer) and still names them. The
 * one case that would lose a ban — the list GROWING by an alias key the launch
 * flag lacks — answers `null`, and the caller respawns so the key rides the new
 * child's `--disallowedTools` instead.
 */
export function claudeFlagLayerDeny(
  current: readonly string[],
  wanted: readonly string[],
  toolAliases: Readonly<Record<string, string>>,
): string[] | null {
  const isAliasKey = (name: string) => Object.prototype.hasOwnProperty.call(toolAliases, name);
  if (wanted.some((name) => isAliasKey(name) && !current.includes(name))) return null;
  return wanted.filter((name) => !isAliasKey(name));
}
