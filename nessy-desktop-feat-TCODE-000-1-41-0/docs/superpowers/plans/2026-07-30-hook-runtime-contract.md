# The hook runtime contract — R9/R22 gaps, dedup, parallelism, the kill switch, the worktree gate, the shell field

From the completed 2026-07-30 re-verification. One subsystem, six defects. The
shared shape: **the hook runtime accepts more than the docs allow in one place
and enforces less than they require in another.**

## 0. Method rules

1. `curl -s https://code.claude.com/docs/en/hooks.md` (and `hooks-guide.md`);
   for Codex hooks `https://learn.chatgpt.com/docs/hooks.md`. Never a
   summarising fetch; quote whole lines. **Read the WHOLE line** — two of these
   defects hide in the second sentence of a two-sentence line.
2. **Declared ≠ enforced.** Prove on Pi. Reproduce each defect before fixing.
3. `grep -a` for absence claims; search the concept.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.**
6. A CDP dev instance may be on port 9223 — do not kill or drive it.

## 1. Task 1 — the support matrix and the decision table agree (R22 + R9)

**Commit:** `fix(hooks): hook types execute only on events that support them`

- `hooks.md:2835`: 13 events support all five hook types; the rest support only
  `command`/`http`/`mcp_tool`. Ours imports and executes `prompt` and `agent`
  hooks on 14 events where they are unsupported; only SessionStart/Setup is
  refused. Build the per-event type-support table beside the existing
  `AGENT_EVENT_CONTRACTS_V1` (one module owns event facts), refuse at
  REGISTRATION with a diagnostic (the R22 pattern: tell the author, don't
  silently skip), and enforce at dispatch.
- R9's gap: the per-event decision table is enforced on the command-hook and
  stored-decision branches but **bypassed by the prompt-hook branch**
  (`hooks-automation.ts:920-925`) — a prompt hook can mint a `block` on events
  whose documented surface carries no decision. Route the prompt branch through
  the same decision-contract check the command branch uses. One gate, all
  branches — a second copy is how this broke.

**Gate:** a `prompt` hook on a no-decision event is refused at registration and
inert at dispatch; on a decision event it still blocks. **Mutation:** re-open
the prompt-branch bypass → the no-decision test goes red.

## 2. Task 2 — dedup and parallel execution (unowned)

**Commit:** `fix(hooks): matched hooks run in parallel and duplicates run once`

`hooks.md:331` whole line: "All matching hooks run in parallel, and identical
handlers are deduplicated automatically. Command hooks are deduplicated by
command string and `args`, and HTTP hooks are deduplicated by URL." Ours: no
dedup anywhere (`grep -n dedup` in `hooks-automation.ts` and
`automations/automation-system.ts` = 0), and both the command loop
(`hooks-automation.ts:1017-1035`) and the prompt loop (`:915`) are
`for … await` — N matched hooks serialise timeouts of up to 600 s each.

- Dedup by the documented keys, per event dispatch, BEFORE execution. Same
  plugin hook under two marketplace ids = one run.
- Parallelise the non-decision execution; **decision merging must stay
  deterministic** — read how the current sequential code combines decisions
  (first-block-wins? all collected?) and preserve that observable order for
  decision events (e.g. run parallel, reduce in registration order). Say in the
  report what the merge rule is and where it is now written down.
- The deny-loop cap, secret redaction and re-gating (the 🛡 "hook runtime
  hardening" row) must survive — those tests exist; run them.

**Gate:** two identical command hooks run once (probe with a side-effect
counter); three hooks with distinct sleeps complete in ~max, not ~sum; decision
outcomes byte-identical to before on the existing suites. **Mutation:** remove
dedup → the counter test goes red.

## 3. Task 3 — the kill switch (unowned)

**Commit:** `feat(hooks): disableAllHooks turns every hook off, managed hooks only from managed level`

`hooks.md:612`: "To temporarily disable all hooks without removing them, set
`\"disableAllHooks\": true` in your settings file. There is no way to disable an
individual hook while keeping it in the configuration." `:197`/`:614`: only
`disableAllHooks` at the MANAGED level can disable managed hooks. Nessy has the
inverse of the documented pair (a per-automation `enabled` flag, no global
switch).

- Settings key in the user layer AND the managed policy schema (mind
  `managed-policy.ts` — it was just fixed for drop-on-omission; guard the new
  key on `undefined` like every neighbour, and extend the per-key omission
  sweep test).
- Precedence: user-level `true` disables user/project hooks but NOT managed
  hooks; managed-level `true` disables everything. Do not collapse the two.
- Keep the per-automation `enabled` flag working (ours-ahead, documented as a
  deviation already) — the doc pair and our flag compose, not replace.

**Gate:** user-level flag silences a user hook and not a managed one;
managed-level silences both; omission = no drop, no behavior change.
**Mutation:** invert the managed-precedence check → the managed-survives test
goes red.

## 4. Task 4 — the worktree gate can refuse (unowned; SECURITY-adjacent)

**Commit:** `fix(hooks): a failing WorktreeCreate hook fails worktree creation`

`chooks.md:699` — the Warning's LAST sentence: "The exception is
`WorktreeCreate`, where any non-zero exit code aborts worktree creation." `:733`
restates it. Ours: `WorktreeLeaseEmit` has **no abort channel in its signature**
(`packages/server-core/src/pi-harness/worktree-lease-service.ts:14-17`), and
`applyWorktreeCreateHookPath` (`:230-255`) has three `return selected` exits —
thrown emit, missing path, refused path — each proceeding with the policy's own
selection. A hook written as a gate is silently a no-op on failure.

- Extend the emit result so refusal is expressible; make all three exits
  distinguish "hook offered nothing" (proceed — a hook that returns no path and
  exits 0 is NOT a refusal) from "hook failed / non-zero exit / block decision"
  (ABORT creation with a stated reason).
- Per-hook `blockOnNonZero` currently comes uniformly from `exitCodeContract`
  with no per-event exception — an imported Claude hook on WorktreeCreate gets
  three-way semantics on an event the docs exempt. Add the per-event exception
  where the contract is computed.
- **The consumer at `SessionManager.ts:9948-9951` is LOCKED to another agent**
  (it reads `result?.decision?.worktreePath` and discards the rest). Land the
  service-side channel and the contract fix; if the SessionManager read site
  must change to complete the wire, DO NOT edit it — write exactly what change
  it needs in your report as a residual, and make the service-side behavior
  correct for every caller that does adopt the channel.

**Gate:** in the lease service, a non-zero-exit hook aborts creation with a
readable reason; a hook that exits 0 with no path proceeds; the escape screen
still refuses `.`/`..`/symlinks. **Mutation:** restore one `return selected` on
the failure path → the abort test goes red.

## 5. Task 5 — the shell field (P3 remainder)

**Commit:** `feat(hooks): a hook's shell field picks bash or powershell`

`chooks.md:343-373`: per-hook `shell` — accepts `"bash"` or `"powershell"`,
platform default otherwise. Currently parsed by nothing and read by nothing.
Carry it through the adapter (Claude AND Codex import paths), validate the two
values (unknown → diagnostic, not silent default), and use it at spawn in the
hook command runner. On darwin/linux `powershell` that is not installed =
stated execution error, not a silent bash fallback.

**Gate:** a hook declaring each value spawns through the right shell (probe
with a shell-identifying command); unknown value → registration diagnostic.
**Mutation:** drop the field at the adapter → the spawn test goes red.

## 6. Task 6 — category strings

**Commit:** `docs(hooks): what the hook runtime still does not cover`

At minimum: the `ConfigChange` settings-source producer (accepted by all three
adapters, emitted only with runtime session keys — the documented
tamper-detection mechanism has no settings-file producer; its own plan comes
next), async/background hooks if untouched, and anything from Tasks 1-5 you
narrowed. Unwrapped, unbolded, backtick-terminated, no inline backticks in the
reason, under 400 chars.

## 6a. What this plan leaves

Six strings, each measured against the code as committed. Two are surfaces this
plan never touched (the ConfigChange producer and the asyncRewake wake half);
three are the residual halves of Tasks 3-5 whose consumer sits in a locked
file; one is a deliberate narrowing of the Task 2 dedup rule to the imported
hook types.

- documented, not implemented — hooks.md filters ConfigChange on the settings source that changed and exit 2 blocks the change; all three adapters accept the event, but Nessy emits it only with runtime session-config keys, so no settings-file edit ever produces an occurrence and the documented tamper-detection mechanism has no settings-file producer; its own plan comes next: `ConfigChange`
- documented, not implemented — hooks.md gives asyncRewake a wake half: the background command hook runs and the field is recorded, but the wake-on-exit-2 idle-session mechanism is still deferred, so a long-running background failure never re-enters the loop: `asyncRewake`
- documented, not implemented — the managed level of the hook kill switch is parsed, enforced on plugin hook candidates and accepted by the pinned automation builder, but the live session assembly does not yet pass it, so on a running session the managed switch silences plugin hooks and not the native tiers until the locked call site adopts the option: `disableAllHooks`
- documented, not implemented — the lease service now aborts creation on a thrown, blocked or refused WorktreeCreate emit and a non-zero exit projects as a block, but the live Pi emit implementation still returns only the worktree path and discards the block, so a failing hook aborts nothing on a live session until the locked read site adopts the blocked channel: `WorktreeCreate`
- documented, not implemented — hooks.md defaults shell form to bash, or to powershell on Windows without Git Bash, and honors a bash choice through Git Bash; Nessy keeps its platform default spawn when the field is absent, refuses a bash declaration on the PowerShell-only Windows runner, and the Pi host runner does not yet pass the field to the process builder: `shell`
- documented, not implemented — hooks.md deduplicates HTTP hooks by URL; the imported http hook type now gets that key, while native webhook automation actions keep their authored delivery — two identical webhook actions still fire twice, an ours-ahead surface the documented rule was not stretched over: `webhook`

## 7. Gate

Focused suites per changed file; hooks/automations aggregates;
`bun run typecheck:all`; `bun run lint`; i18n parity+sorted if strings added;
`git diff --check`. Hook execution is a named risk trigger — expanded set once
on the final diff. Known-failing list: `2026-07-29-known-failing-tests.md`;
reproduce on a clean `git worktree`, never stash.

## 8. Constraints

- **LOCKED FILES (other agents, do not touch):**
  `packages/server-core/src/sessions/SessionManager.ts`,
  `packages/shared/src/agent/pi-agent.ts`, `packages/shared/src/agent/base-agent.ts`,
  `apps/electron/src/renderer/**` (all of it, this run),
  `packages/session-tools-core/src/runtime/filesystem-isolation.ts`, seatbelt
  tests, `agent/core/pre-tool-use.ts`,
  `packages/shared/src/config/storage.ts`,
  `packages/shared/src/telemetry/usage-metrics.ts`,
  `packages/server-core/src/bootstrap/headless-start.ts`.
  `managed-policy.ts` is SHARED with a just-landed fix — `git pull` is not a
  thing here (no remote); just check `git status`/`git log -1` on it before
  editing and build on HEAD.
- One commit per task, subjects exactly as given. No `Co-Authored-By`. No push,
  MR, tags, reset, rebase, `--amend`, `checkout --`, or stash of edited files.
- Do not touch `docs/superpowers/specs/`, `docs/testing/cdp-live-checklist.md`,
  `~/.nessy-agent/skills/r17-*`, `~/.nessy-agent/mcp/elicit-server.mjs`.
- No version bumps or release notes. Never write `~/.nessy/dp_auth_creds.json`.
  Loopback probes only. Code/comments/commits in English.

## 9. Report

Commit shas; each defect's reproduction; the decision-merge rule and where it
now lives; the dedup keys; the worktree residual for the locked consumer, word
for word; the shell-field spawn evidence per platform you could test; every
correction to this plan; mutation probes with which side went red.
