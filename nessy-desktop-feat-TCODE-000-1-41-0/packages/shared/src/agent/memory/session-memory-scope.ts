/**
 * **P6.390(1) — the per-CHAT memory scope, and the two runtimes that can only
 * express half of it.**
 *
 * Before this module the fork had exactly one memory control:
 * `getMemoryEnabled()` in `config/storage.ts`, a single global boolean read by
 * `memory-store.ts` (the prompt block) and `agent-memory.ts` (the per-agent
 * directories). A user who wanted ONE conversation kept out of memory — a
 * throwaway debugging chat, a chat about someone else's repository — had to
 * turn memory off for everything and remember to turn it back on.
 *
 * ## Native-first: what each runtime already has, measured
 *
 * **codex — a real per-thread control, and it is on the wire.**
 * `codex-rs/app-server-protocol/src/protocol/common.rs` at `rust-v0.150.1`
 * declares the method verbatim:
 *
 * ```rust
 * #[experimental("thread/memoryMode/set")]
 * ThreadMemoryModeSet => "thread/memoryMode/set" {
 *     params: v2::ThreadMemoryModeSetParams,
 *     serialization: thread_id(params.thread_id),
 *     response: v2::ThreadMemoryModeSetResponse,
 * },
 * ```
 *
 * with `ThreadMemoryModeSetParams { thread_id: String, mode: ThreadMemoryMode }`
 * and `ThreadMemoryMode` a two-arm lowercase enum, `enabled | disabled`
 * (`protocol/v2/thread.rs`). The app-server suite
 * (`app-server/tests/suite/v2/thread_memory_mode_set.rs`) drives it on both a
 * loaded and a stored thread and reads the result back out of the state DB
 * (`state_db.get_thread_memory_mode(...) == Some("disabled")`), so the mode is
 * PERSISTED per thread rather than being a turn-local flag.
 *
 * Two things about that method are load-bearing and neither is obvious:
 *
 * 1. It is `#[experimental(...)]`, so it is reachable only for a client that
 *    declared the capability. **We already do** — `codex-agent.ts` sends
 *    `capabilities: { experimentalApi: true }` on `initialize`. Without it the
 *    server answers with `experimental_required_message`, *"thread/memoryMode/set
 *    requires experimentalApi capability"*.
 * 2. It is **absent from the vendored protocol artefacts** even though those are
 *    pinned at the same `0.148.0`: `ThreadMemoryMode` is declared in
 *    `packages/codex-protocol/schema/ClientRequest.json` and referenced by
 *    NOTHING (`$ref` count 0 across all three schema files), there is no
 *    `generated/v2/ThreadMemoryModeSetParams.ts`, and `thread/memoryMode/set` is
 *    in none of the method lists. That is the experimental generator arm
 *    (`generate_json` vs `generate_json_with_experimental`), not a version skew
 *    — so the params type is spelled out here rather than imported, and this
 *    module is where it gets fixed the day the generated file appears.
 *
 * **claude — a per-SESSION off switch, already wired.** P6.33 landed
 * `applyAutoMemoryOffSwitch` in `agent/options.ts`: memory off ⇒
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` on the child, memory on ⇒ write NOTHING,
 * because `'0'` does not mean "permitted" — it FORCES memory on over the user's
 * own `autoMemoryEnabled: false`, `--bare` and safe mode. Every claude-runtime
 * session spawns its own child, so that variable is already a per-chat control;
 * what was missing is a per-chat INPUT for it.
 *
 * **Pi — nothing native.** The host owns the prompt block and the `remember`
 * tool, so the host is the mechanism.
 *
 * ## The residue, stated rather than hidden: TWO axes host-side, ONE on the wire
 *
 * The row asks for two independent axes — may this chat READ existing memories,
 * and may it BECOME an input for future ones. The host can honour both (the
 * load and the write are separate code paths). **Neither runtime can.**
 * `ThreadMemoryMode` is one enum with two arms and
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is one boolean; each governs reading and
 * writing together.
 *
 * So the projection is the CONJUNCTION — the runtime's own memory store is left
 * enabled only when both axes are on — and the direction is chosen, not
 * defaulted: enabling the native store when the user turned one axis off would
 * grant the axis they refused, while disabling it when they turned one axis off
 * costs only the runtime's private store while the host still honours the axis
 * they kept. {@link describeSessionMemoryScopeResidue} is the sentence a user
 * sees when that lossy half applies, because an undocumented choice nobody can
 * see is indistinguishable from a defect.
 */

/** Whether this chat may READ existing memories, and whether it may FEED them. */
export interface SessionMemoryScope {
  /** Existing memories are loaded into this chat's context. */
  readonly read: boolean;
  /** This chat may write memories that later chats will read. */
  readonly write: boolean;
}

/**
 * A per-chat override. Each axis is independently unset — an unset axis follows
 * the global switch, which is what "without touching the global setting" means:
 * a chat that says nothing is a chat that behaves exactly as it does today.
 */
export interface SessionMemoryScopeOverride {
  readonly read?: boolean | undefined;
  readonly write?: boolean | undefined;
}

export const SESSION_MEMORY_SCOPE_FULL: SessionMemoryScope = Object.freeze({ read: true, write: true });
export const SESSION_MEMORY_SCOPE_NONE: SessionMemoryScope = Object.freeze({ read: false, write: false });

/**
 * Resolve one chat's effective memory scope.
 *
 * The per-chat override wins over the global switch **in either direction**, and
 * that is not an invention: `settings-reference.md#automemoryenabled` says the
 * per-session override "takes precedence over this key for one session, in
 * either direction", and the shipped binary agrees — its gate reads the env var
 * before it reads `autoMemoryEnabled`. An axis the chat left unset falls through
 * to the global switch.
 */
export function resolveSessionMemoryScope(input: {
  readonly globalEnabled: boolean;
  readonly override?: SessionMemoryScopeOverride | undefined;
}): SessionMemoryScope {
  const base = input.globalEnabled;
  const override = input.override;
  return Object.freeze({
    read: override?.read ?? base,
    write: override?.write ?? base,
  });
}

/** `ThreadMemoryMode`, `protocol/v2/thread.rs` — `#[serde(rename_all = "lowercase")]`. */
export type CodexThreadMemoryMode = 'enabled' | 'disabled';

/** The JSON-RPC method name, verbatim from `protocol/common.rs`. */
export const CODEX_THREAD_MEMORY_MODE_SET_METHOD = 'thread/memoryMode/set';

/**
 * `ThreadMemoryModeSetParams`, `#[serde(rename_all = "camelCase")]` — so
 * `thread_id` is `threadId` on the wire.
 *
 * Declared here rather than imported because the experimental generator arm
 * emits no `generated/v2/ThreadMemoryModeSetParams.ts`; see this module's
 * header.
 */
export interface CodexThreadMemoryModeSetParams {
  readonly threadId: string;
  readonly mode: CodexThreadMemoryMode;
}

/**
 * The conjunction, in codex's own vocabulary. One enum, two axes: `enabled`
 * only when the chat may both read and feed.
 */
export function projectSessionMemoryScopeToCodex(scope: SessionMemoryScope): CodexThreadMemoryMode {
  return scope.read && scope.write ? 'enabled' : 'disabled';
}

export function buildCodexThreadMemoryModeSetParams(
  threadId: string,
  scope: SessionMemoryScope,
): CodexThreadMemoryModeSetParams {
  return { threadId, mode: projectSessionMemoryScopeToCodex(scope) };
}

/**
 * The claude child's environment fragment, under exactly P6.33's rule: `'1'`
 * closes memory, and the ON case writes NOTHING rather than `'0'`, because `'0'`
 * would force memory on over the user's own `autoMemoryEnabled: false`, over
 * `--bare` and over safe mode.
 *
 * Spread AFTER the caller's own overrides, like `applyAutoMemoryOffSwitch`
 * already is, so an ambient `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0` in the host's
 * login shell cannot re-arm the child's memory and defeat the in-app control.
 */
export function buildClaudeSessionMemoryEnv(
  scope: SessionMemoryScope,
): Readonly<Record<string, string>> {
  return scope.read && scope.write ? Object.freeze({}) : Object.freeze({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
}

/**
 * The sentence for the half the runtime cannot express. Empty whenever the
 * projection is lossless — both axes agree, so one enum says exactly what the
 * chat asked for — because a line that always prints is a line nobody reads.
 */
export function describeSessionMemoryScopeResidue(
  scope: SessionMemoryScope,
  runtime: 'claude' | 'codex' | 'pi',
): string[] {
  if (scope.read === scope.write) return [];
  if (runtime === 'pi') return [];
  const kept = scope.read ? 'reads existing memories' : 'may write new memories';
  const dropped = scope.read ? 'writing new ones' : 'reading existing ones';
  const native = runtime === 'codex'
    ? "codex's per-thread memory mode (thread/memoryMode/set) is one switch over both"
    : "the claude child's auto memory (CLAUDE_CODE_DISABLE_AUTO_MEMORY) is one switch over both";
  return [
    `This chat ${kept} but not ${dropped}, and ${native}: its own memory store is left OFF for this `
    + `chat so the axis you turned off stays off. The host still honours the axis you kept.`,
  ];
}
