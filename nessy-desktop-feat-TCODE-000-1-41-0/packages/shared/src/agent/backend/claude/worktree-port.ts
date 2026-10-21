/**
 * P2.458 — the host half of a claude worktree.
 *
 * Same shape as the other host ports on {@link BackendConfig} (`cronPort`,
 * `goalPort`, `hookTaskRegistryPort`): the agent owns WHEN the question is
 * asked, the host owns the answer and the resources. Here the host side is the
 * worktree lease service — `packages/server-core/src/pi-harness/worktree-lease-service.ts`
 * — which already mints the lease, the working-directory record, the cwd anchor
 * and the retention sweep for every Pi worktree, and whose `WorktreeLeaseEmit`
 * already speaks these two event names.
 *
 * ## Why it is declared here and augmented onto the config
 *
 * The field belongs on `BackendConfig` beside its siblings, and `backend/types.ts`
 * is not this lane's file. A module augmentation puts it there without editing
 * it, so the host lane that supplies the implementation gets the same
 * compile-time checking every other port gets — a typo in the field name is an
 * excess-property error on the config literal, not a port that silently never
 * arrives. That silent shape is the failure mode `AGENTS.md` calls this fork's
 * largest defect class, so it is worth the one unusual declaration.
 *
 * ## WHAT WAS NOT DONE HERE IS DONE — three claims below were stale (P6.127)
 *
 * This section read *"Nothing in `packages/server-core` sets this field yet"*
 * and asked the host lane to measure the trust gate before setting it. Both were
 * true when written and both were false from P2.465 onwards, which is the stale
 * hand-off shape this fork keeps finding: a reader arriving here was told the
 * seam was unfed while `SessionManager.ts` had been feeding it for a month.
 *
 * At HEAD, `SessionManager.createClaudeWorktreePort` supplies the port for
 * `provider === 'anthropic'` sessions that have a project handle and are not
 * under a managed `disableAllHooks`, and it lands a session-visible notice on
 * both arms a request reaches — the leased path and branch, or the refusal and
 * the fact that the isolated session was aborted rather than falling back.
 *
 * The measurement this section asked for was made and the answer is NO GATE IS
 * NEEDED: an SDK-registered callback is not subject to the trust arm of the
 * binary's *"hook is configured but did not run (workspace not trusted,
 * disableAllHooks set, or matcher mismatch)"* string, because an SDK session is
 * always non-interactive (`!process.stdout.isTTY` under the SDK's own
 * `stdio: ["pipe","pipe","pipe"]`) and the trust probe returns true there; the
 * matcher arm cannot fire because this hook declares no matcher; and the
 * MANAGED `disableAllHooks` arm is the one asymmetric switch, which is exactly
 * why it is gate 1 on the host side. The full chain, located by CONTENT rather
 * than by minified name after the 0.3.233 bump reassigned every symbol, is in
 * `createClaudeWorktreePort`'s own docblock — kept in one place on purpose, so
 * this file does not become a second copy that ages separately.
 *
 * `claude-worktree-hooks.test.ts` is still what fails if the contract drifts
 * from the SDK.
 *
 * ## I2.6 — `worktree.location` is NOT ours to project, and the field says so
 *
 * The 0.3.247 lift brought a settings key that reads as though the host should
 * fill it in — a worktree ROOT, beside the worktree facts this port supplies.
 * Re-derived at the vendored 0.3.251 (`sdk.d.ts` byte-identical on this key
 * between the two versions), and the answer is in the field's own gloss,
 * verbatim:
 *
 *   "Directory under which **Claude Code Desktop** creates the worktrees of SSH
 *   sessions that run on this machine (an absolute path or one starting with
 *   ~/), instead of `<project>/.claude/worktrees`. Read by the desktop app from
 *   the SSH host user settings; a location chosen in the desktop app's SSH
 *   connection settings takes precedence. **The CLI (--worktree, EnterWorktree,
 *   agent isolation) does not read it yet.**"
 *
 * Two clauses decide it. The key belongs to a DIFFERENT PRODUCT — Claude Code
 * Desktop, for SSH sessions it hosts — and the artefact this fork spawns is the
 * CLI, which the vendor states does not read it. Projecting our worktree root
 * into it would write a key the child cannot act on, and the only thing that
 * would then be true of the session is that a settings file claims a root
 * nothing honours. That is the silent-divergence shape, arrived at by trying to
 * close a gap.
 *
 * So the host supplies the repository facts through this port, as it already
 * does, and the key is left to the operator. `bgIsolation` is unchanged at both
 * versions, so W10-a's P6.839 decision (Option A minus that field) is untouched
 * by any of this. The flip point is the vendor's own "yet": the day the CLI
 * reads it, this becomes one line beside the facts the port already carries.
 *
 * ## THE THIRD RUNTIME: CODEX CANNOT, AND THIS IS WHERE THAT IS RECORDED (P2.497)
 *
 * This family closes a leak — an app quit leaving a worktree nothing recorded —
 * and it closes it per runtime. Pi needed nothing (it already owns the lease
 * service). Claude is closed on the wired path, with every withholding LOGGED
 * (`SessionManager.createClaudeWorktreePort`). Codex was neither closed nor
 * honest, and the honest answer turns out to be that **there is nothing to
 * feed**, which is a real answer here rather than a shortcut — the same shape as
 * P2.463 (codex genuinely lacks a browser mechanism) and P2.454 (its tool-search
 * knobs are session-global with nothing per-server to pass).
 *
 * Measured 2026-09-02 against the STRONG tier — the shipped binary
 * (`apps/electron/resources/bin/codex/darwin-arm64/codex-app-server`, pinned at
 * `rust-v0.148.0` by `packages/codex-protocol/manifest.json`) and the pinned
 * protocol, not a vendor page:
 *
 * | probe                                            | hits |
 * | ------------------------------------------------ | ---- |
 * | `WorktreeCreate` in the binary                    | 0    |
 * | `worktree` in `packages/codex-protocol` (generated + schema) | 0 |
 * | `preToolUse` / `sessionStart` / `subagentStart` (controls) | 3 / 5 / 3 |
 * | `nessyWorktreeCreate` (negative control)          | 0    |
 *
 * The binary's 22 `worktree` strings are all gitoxide's own git implementation
 * (`refs/worktree/`, `worktreeConfig`, `GIX_*`), not a codex feature. Codex's
 * hook surface is ELEVEN events and none of them is worktree-shaped — read them
 * from `packages/codex-protocol/generated/v2/HookEventName.ts`, which
 * `codex-worktree-tier-absence.test.ts` asserts rather than restating.
 *
 * So codex has no `WorktreeCreate` seam to register a port against, and the host
 * tool that would otherwise reach it (`EnterWorktree`) is declared
 * `visibility: 'pi-only'` in `session-tools-core/src/tool-defs.ts`. **The codex
 * tier is CLOSED-BY-ABSENCE, not open**: there is no codex-created worktree for
 * the host to fail to record. What codex's model can still do is shell out to
 * `git worktree` through `Bash`, which is unrecorded on ALL THREE runtimes and
 * is a different question from this one.
 *
 * The RUNTIME-side half this section used to record as owed is landed:
 * `SessionManager.noteAbsentWorktreePort` says the codex tier is closed by
 * absence, beside the claude withholdings. The measurement above is the record;
 * that function is the voice.
 */

/** The `name` slug `hooks.md#worktreecreate-input` hands the hook. */
export interface ClaudeWorktreeCreateRequest {
  /** e.g. `bold-oak-a3f2` — "either specified by the user or auto-generated". */
  name: string
  /** The SDK session the isolated session belongs to, when known. */
  sessionId?: string
  /** The hook input's `cwd`: the repository the worktree is being cut from. */
  cwd?: string
}

/**
 * Either an absolute path the host has created and leased, or a refusal.
 *
 * A refusal is a real outcome, not an error: `hooks.md#exit-code-2-behavior-per-event`
 * gives this event *"Any non-zero exit code causes worktree creation to fail"*,
 * so a host that will not lease (consent withheld, retention cap reached, the
 * repository is dirty) says so and creation aborts with its reason — which is
 * strictly better than creating a worktree nothing recorded.
 */
export type ClaudeWorktreeCreateOutcome =
  | { worktreePath: string }
  | { refusedReason: string }

export interface ClaudeWorktreeRemoveRequest {
  /** The path `WorktreeCreate` returned, screened absolute before it arrives. */
  worktreePath: string
  sessionId?: string
}

export interface ClaudeWorktreePort {
  create(request: ClaudeWorktreeCreateRequest): Promise<ClaudeWorktreeCreateOutcome> | ClaudeWorktreeCreateOutcome
  /**
   * Release a worktree the runtime is tearing down. May be a path this host
   * never leased — `WorktreeRemove` also fires for worktrees a user's own
   * `WorktreeCreate` hook made — so an unknown path is a no-op, never a throw.
   */
  remove(request: ClaudeWorktreeRemoveRequest): Promise<void> | void
}

declare module '../types.ts' {
  /**
   * P2.465 corrected the AUGMENTED INTERFACE, and the correction is the point of
   * declaring the field this way rather than a nit.
   *
   * P2.458 augmented `BackendConfig` and said the field sits "beside its
   * siblings" `cronPort` / `goalPort` / `hookTaskRegistryPort`. Those three are
   * declared on `CoreBackendConfig`, not on `BackendConfig`, and the difference
   * is load-bearing: the host writes a `CoreBackendConfig` literal
   * (`factory.ts`'s `coreConfig`, which `createBackendFromResolvedContext`
   * spreads into the resolved config), while `BackendConfig extends
   * CoreBackendConfig` adds what the FACTORY resolves — provider, model,
   * runtime. So a field declared only on `BackendConfig` is readable by every
   * agent and UNWRITABLE by the host: `claudeWorktreePort` on the host literal
   * was `error TS2353: Object literal may only specify known properties`.
   *
   * That error is exactly the check the module augmentation exists to buy —
   * P2.458's docblock says so — and it fired on the first attempt to feed the
   * port, which is the whole reason the field was declared with a compile-time
   * check instead of a cast. On `CoreBackendConfig` it is writable at the host
   * literal and still visible through `BackendConfig`, so no reader changes.
   */
  interface CoreBackendConfig {
    /**
     * P2.458. Absent means the runtime's own `git worktree` creates isolated
     * working copies and the host records none of them — the state before this
     * row, and the state every non-claude backend is in.
     *
     * P2.465 supplies it, for `provider === 'anthropic'` sessions that have a
     * project handle and are not under a managed `disableAllHooks`
     * (`SessionManager.createClaudeWorktreePort` records why each of those is a
     * gate and not caution).
     */
    claudeWorktreePort?: ClaudeWorktreePort
  }
}
