# The approval path tells the truth — the guardian floor bypass, R2, R15

Three defects in one subsystem: **a prompt that must reach a human either
doesn't, can't be approved, or fires twice with two different payloads.**

## 0. Method rules

1. `curl -s https://code.claude.com/docs/en/hooks.md` and
   `permission-modes.md`; quote whole lines.
2. **Declared ≠ enforced.** Prove on Pi. Reproduce each defect before fixing.
3. **Several source files here contain NUL bytes** (`pi-agent.ts`,
   `usage-metrics.ts` among them) — plain grep silently skips them; ALWAYS
   `grep -a`.
4. **Two git commands** — pathspec on the `commit`. One commit per task.
5. **Run every test from the repository ROOT.** Check no other `bun test` is
   running before recording a new failure (see the known-failing doc's
   concurrent-run note).
6. CDP instance may be on 9223 — do not kill or drive it.

## 1. Task 1 — the guardian cannot override a non-negotiable floor (SECURITY)

**Commit:** `fix(permissions): the auto-mode guardian cannot allow a non-negotiable prompt`

Verified first-hand by the planner: `pi-agent.ts:3925` gates the guardian-judge
consult on `checkResult.type === 'prompt' && guardianMode.permissionMode ===
'auto'` and never consults `promptIsNonNegotiable`
(`agent/core/pre-tool-use.ts:657`, which exists for exactly this). Consequence
(found by S16): in `auto`, the judge can convert ANY non-negotiable prompt into
an allow — `requiresUserInteraction` ("must reach a person on EVERY call"), an
explicit ask-rule, the S4 removal circuit breaker (**`rm -rf ~` is
judge-allowable today**), and the new S16 protected-path floor.

- The consult gate must skip prompts where `promptIsNonNegotiable(checkResult)`
  — those go to the human, period. One condition, at the gate, not scattered.
- Sweep for OTHER consult/auto-resolve sites with the same shape (`grep -a`
  the concept: guardian, judge, consult, autoResolve) — S4's breaker survived
  hooks and allow-rules but not this one; say in the report every site you
  checked and what it does with a non-negotiable prompt.
- Reproduce first: a `nonNegotiable` prompt in `auto` reaching the judge and
  being converted to allow (stub the judge to say yes).

**Gate:** in `auto`, an `rm -rf ~`-class breaker prompt reaches the human even
with a judge stubbed to allow everything; an ordinary borderline prompt still
consults the judge. **Mutation:** drop the nonNegotiable check → the breaker
test goes red.

## 2. Task 2 — the worktree floor prompt can actually be approved (R2)

**Commit:** `fix(permissions): approving the worktree floor prompt works`

The challenger's chain, all production Pi code: the worktree approval floor
emits `promptType: 'admin_approval'` with NO `command`
(`pre-tool-use.ts:1414-1423`). But `admin_approval` is the privileged-execution
type: `SessionManager.handleAgentPermissionRequest:5869` registers with the
broker only `if (request.type === 'admin_approval' && request.command)` — so
the floor prompt is never registered → user clicks Approve →
`respondToPermission:16520` calls `privilegedExecutionBroker.resolveApproval`
unconditionally for every `admin_approval` → broker returns
`{ok:false, reason:'No pending privileged request found'}` → "Broker rejection
fails closed" → **the resolver settles `false`. Approve does nothing.**

- Reproduce through the real prompt→approve chain first.
- Fix by making the floor prompt a type the broker path treats honestly —
  either its own promptType (cleanest: the floor is not privileged execution)
  or a registered broker entry. Do NOT special-case a command-less
  `admin_approval` as "skip the broker" without understanding why the broker
  fails closed — that fail-closed exists for security; the fix is to stop
  minting a privileged type for a non-privileged prompt.
- Check the S16 protected-path floor prompt and any other `nonNegotiable`
  prompt producer for the same trap (which promptType do they emit? can THEY
  be approved?). The sibling workflow-launch prompt was already moved OFF
  `admin_approval` to escape this — that precedent is the pattern.

**Gate:** clicking Approve on the worktree floor prompt approves it (the
operation proceeds); clicking Deny denies; the three real installer
`admin_approval` forms still work. **Mutation:** re-emit the floor as bare
`admin_approval` → the approve test goes red.

## 3. Task 3 — one PermissionRequest per prompt, documented shape (R15)

**Commit:** `fix(hooks): PermissionRequest fires once, with the documented input`

R15's band ships and is decisive, but on the composed Pi path the SAME prompt
fires `PermissionRequest` a second time from the harness permission service
(`permission-service.ts:83`) with an input violating the documented shape — no
`tool_input`, no `permission_mode`, no `permission_suggestions` — and a
discarded return value. `PermissionDenied` doubles the same way. The two
emissions even carry different tool spellings (pi-agent passes `toolName`;
permission-service passes `request.subject.piName`). `hooks.md:1632`:
"PermissionRequest hooks receive `tool_name` and `tool_input` fields like
PreToolUse hooks, but without `tool_use_id`" — and `hooks.md:342` makes `if`
(permission-rule syntax) evaluable on this event, which needs the input.

- Reproduce: count emissions per prompt on the composed path; diff the two
  payloads.
- ONE emission per prompt, from the site that has the full documented input.
  The second site either forwards to the first or stops emitting — do not
  "fix" by enriching both (two emitters is the defect).
- A side-effecting or `if`-filtered hook must see one event with `tool_name`
  spelled the way rules match (the permission DSL spelling), `tool_input`,
  `permission_mode`, `permission_suggestions`.

**Gate:** exactly one `PermissionRequest` per prompt on the composed Pi path,
payload carries the documented fields, an `if: "Bash(git *)"` hook matches;
`PermissionDenied` likewise single. **Mutation:** re-enable the second emitter
→ the once-per-prompt test goes red.

## 4. Task 4 — category strings

**Commit:** `docs(audit): what the approval path still leaves open`

Anything narrowed; unwrapped, unbolded, backtick-terminated, no inline
backticks in the reason, under 400 chars.

### 4a. What this plan leaves

Four strings, each measured against the code as committed. The first recorded a
narrowing the guardian fix made deliberately and was re-cut to implemented on
2026-08-23, when P2.3 closed it; the second and third are surfaces the three
tasks scoped out; the fourth records a decision taken during R2's consumer sweep
rather than an absence.

- documented, implemented — permission-modes.md:286 has the classifier review and approve or block rm and rmdir removals targeting a critical path, and the :574-580 table sends one to the classifier in auto. Closed 2026-08-23 by row P2.3 of 2026-08-22-runtime-parity-closure.md, commit ced00e45f. Still a breaker: a rule and a hook cannot clear it in any mode, and the only other answerer is the judge auto already delegates to: `rm -rf ~`
- documented, not implemented — hooks.md:1711 makes echoing a received suggestion equivalent to the user picking that always-allow option. Suggestions are offered only for a Bash prefix rule and a bare MCP tool rule; a curl or wget domain whitelist and a file-write tool-plus-path hash have no documented rule spelling, and none is invented: `permission_suggestions`
- documented, not implemented — hooks.md:1904 gives PermissionDenied a tool_use_id alongside tool_name, tool_input and reason. The band fires the event with the other three; the tool call id is not threaded to that site, so a hook correlating a denial to its originating tool call cannot: `tool_use_id`
- documented, implemented — worktrees.md makes the EnterWorktree floor suppressible by nothing but bypassPermissions. It now carries its own prompt type rather than the privileged admin_approval one, and stays excluded from the restart one-shot auto-approve as it was under that type, so the rename cannot widen it: `worktree_approval`

## 5. Gate

Focused suites per changed file; permissions + pi-harness + server-core
aggregates once on the final diff (permission decisions are a named risk
trigger); `bun run typecheck:all`; `bun run lint`; `git diff --check`.
Known-failing: `2026-07-29-known-failing-tests.md`; clean `git worktree` for
reproduction, never stash.

## 6. Constraints

- The tree is quiet — no other agents. You own `pi-agent.ts`,
  `agent/core/pre-tool-use.ts`, `SessionManager.ts`, `permission-service.ts`,
  and their tests. Two sibling executors run elsewhere: pi-agent-server/src
  (subprocess) and plugins/format-adapters + claude-agent.ts — STAY OUT of
  those.
- One commit per task, subjects exactly as given. No `Co-Authored-By`. No
  push/MR/tags/reset/rebase/--amend/`checkout --`/stash of edited files.
  Restore mutations by re-edit or `.orig` copy, never git.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`;
  no version bumps or release notes; never write `~/.nessy/dp_auth_creds.json`;
  never test against the user's real files — temp fixtures only.
- Code, comments and commits in English.

## 7. Report

Commit shas; each defect reproduced (the guardian conversion, the dead
Approve, the double emission with both payloads); every consult site swept and
its non-negotiable behavior; the promptType decision for the floor and why the
broker's fail-closed stays intact; every correction to this plan; mutation
probes with sides.
