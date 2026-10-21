# R14 — Nestor Cloud, end-to-end

Parity row **R14**. Not a parity mechanism — a verification pass that guards the
whole series. It ships, and one path in it is untested.

**I located the gap before writing this.** The row names "the extracted tool-call
path that drives a remote agent, which no test exercises end to end". That path
is `agent/backend/nestor-cloud/local-tool-adapter.ts`, 173 lines. Its sibling
directory has tests for `agent-card-modes`, `cancel`, `client`, `context-store`
and `event-adapter` — **and none for `local-tool-adapter`.** The row is precise
and the gap is real.

---

## 0. Method rules

1. **Declared ≠ enforced, and this row is the inverse**: the code is enforced and
   the *test* is missing. Do not "fix" behaviour you cannot show is wrong. If a
   test you write goes red, that is a finding — report it before changing
   production code, and say what you changed and why.
2. **Never call the live gateway from a test.** Nestor Cloud is a real remote
   service. Drive the adapter against a stub. The known-failing list already
   carries two `conformance — live gateway` rows that need credentials; do not add
   a third dependency of that kind.
3. **Never log a token, a JWT, a credentialed URL, or a delivered payload.** This
   backend authenticates against the T-Bank gateway.
4. **Never write to `~/.nessy/dp_auth_creds.json`** — `auth/dp` is its only
   writer and the file's shape is nessy-cli's contract.
5. **Two git commands** — pathspec on the `commit`.
6. Expected pre-existing failures:
   `docs/superpowers/specs/2026-07-29-known-failing-tests.md`; short three times,
   wrong once the other way. Reproduce on a clean `git worktree`, never
   `git stash`, and say which you observed.
7. **`rg` skips NUL-containing files silently; eight of ours have one** — tracker
   note 11a; use `grep -a`.

---

## 1. Tasks

### Task 1 — the tool-call path, end to end

**Commit:** `test(nestor-cloud): the local tool-call path, end to end`

Read `local-tool-adapter.ts` and the five existing sibling tests first — match
their harness rather than inventing one.

What "end to end" has to mean here, or the test is theatre: a **remote agent
asks for a local tool, the adapter runs it, and the result gets back**. A test
that calls the adapter's exported function with a hand-built request and asserts
the return value proves the function, not the path. Drive it from whatever the
client actually hands the adapter.

Cover at least:

- the happy path, with the result reaching the remote side;
- a tool that **fails** — an error has to travel, not vanish;
- a tool that is **not permitted**, because this path crosses a permission
  boundary and a remote agent must not get more than a local one;
- cancellation mid-call, since `cancel.test.ts` exists and this path can be
  in-flight when it fires.

**Gate:** the suite passes, and a **mutation probe** proves each case bites —
break the result plumbing and the happy path must go red; break the error
plumbing and the failure case must go red. A suite that stays green under a
broken adapter is the thing this row exists to prevent.

---

### Task 2 — what the pass found

**Commit:** `docs(nestor-cloud): what the end-to-end pass established`

Write down what is now covered and what still is not. This row's value is the
statement, not just the tests: the next person needs to know which parts of the
shipped remote runtime have evidence behind them.

If the pass found a **real defect**, that is the most valuable outcome — report
it prominently, fix it in its own commit, and say so.

Category strings for anything you deliberately leave uncovered — in particular
anything that genuinely needs the live service, which should be named as such
rather than left as a silent hole.

**Unwrapped, unbolded, backtick-terminated**, then confirm:
`python3 scripts/regenerate-deviation-register.py | grep -i nestor`.

---

## 2. Gate

Focused suites for `agent/backend/nestor-cloud` plus the agent-backend
aggregate; `bun run typecheck:all`; `bun run lint`; `git diff --check`.

**Run every test from the repository ROOT.** A package-directory run bypasses the
config-dir isolation preload and destroys the user's real
`~/.nessy-agent/config.json`.

---

## 3. Constraints

- One commit per task, subjects exactly as given. **No `Co-Authored-By` trailers.**
  A defect fix is a third commit, and welcome.
- No push, MR or tags. No `reset`, `rebase`, `--amend`. Never `git checkout --`
  or `git stash` a file you are editing.
- Pathspec on the commit itself.
- **Two other agents are working concurrently**: one on telemetry (server-core
  bootstrap, `agent/backend/*/event-adapter.ts` — **including this backend's
  event adapter**, so coordinate by staying in `local-tool-adapter.ts` and its
  test), one in the isolation/sandbox code. Stay out of both.
- Do not touch `docs/superpowers/specs/` or `docs/testing/cdp-live-checklist.md`
  (planner-owned), nor `~/.nessy-agent/skills/r17-*` or
  `~/.nessy-agent/mcp/elicit-server.mjs` (CDP fixtures).
- No version bumps, no release notes.
- Code, comments and commits in English.

## 4. Report

Commit shas; **every correction to this plan** — including whether the gap I
located is the one the row meant; what each case covers and its mutation-probe
result; any real defect found; what remains uncovered and why; the category
strings with proof they appear in the register.

---

## 5. What the end-to-end pass established

Executed 2026-07-30 at base `c217f5e9`.
Task 1: `499c378f`. New file:
`packages/shared/src/agent/backend/nestor-cloud/__tests__/local-tool-adapter.test.ts`.

### The row is right; § 0's justification for it was wrong

The header claims the sibling directory "has tests for `agent-card-modes`,
`cancel`, `client`, `context-store` and `event-adapter` — and none for
`local-tool-adapter`". It has **twelve** test files, not five, and one of them —
`tool-executor.test.ts` — imports `createNestorToolExecutionPorts` from
`local-tool-adapter.ts` directly and asserts the permission subject that the
adapter derives for all seven builtins plus MCP. **The module was not untested.**

Inside that directory the two halves genuinely do not meet. `turn.test.ts` drives
a wire stream into `NestorCloudTurn` but stubs `executeTool` — nothing runs.
`tool-executor.test.ts` drives a real executor, permission gate and local tool
runtime but hands them a hand-built `NestorToolCall` and asserts the returned
object — nothing arrives from, or returns to, a remote agent. The seam is the
eleven lines of `turn.ts:consumeStream` `case 'tool_call'` plus the
`sendToolResultsStream` payload.

### And the seam was half-covered, not uncovered — a second correction, to my own first one

**Correcting the paragraph above, and the sibling-file survey the row rests on:
one prior case already crossed that seam.**
`packages/shared/src/agent/__tests__/nestor-cloud-e2e.test.ts` →
*"enforces PreToolUse changes and observes the actual PostToolUse result"* drives
the real `NestorCloudAgent` through `agent.chat()`, so the executor, the adapter,
the gate and the runtime are all real, it reads a real file from a tmpdir, and it
asserts `client.toolResultCalls[0].results` — the payload bound for the remote
side. That is the happy path, once, for `list_files`.

Two reasons it was missed, both worth recording because both will recur. It lives
in `agent/__tests__/`, not in the backend's own `__tests__/`, so a survey of
sibling files cannot see it. And it never names `NestorCloudToolExecutor` — it
reaches the executor through `NestorCloudAgent`, so a grep for the class does not
find it either. **A sibling-directory census is not a coverage census.**

What was actually missing, and is what the five new cases add:

- **every failure mode.** No case anywhere drove a failing tool, a permission
  denial, a scope refusal or a cancellation through the path. Only the success
  path had ever been crossed, and only once.
- **the real client.** Every prior case swaps `NestorCloudClient` for a fixture
  double, so nothing had proven that a remote tool request parses out of real SSE
  framing or that a result reaches the actual JSON-RPC POST body. The new cases
  run the real client on a stubbed `fetchImpl`.

So R14 is a real row and `local-tool-adapter.ts` is the right file — but neither
"it has no test" nor "the path is unproven end to end" was accurate. The accurate
statement is narrower and still worth a row: **the path was proven only when
everything worked, and only with the transport removed.**

There is also already a live gate on this path — `NESSY_NESTOR_CLOUD_E2E=1` plus
valid creds, `describe.skip` otherwise, in the same file — so R14's live hole is
parameterized rather than absent, and no new live dependency was added.

### What the five cases cover, and the proof each one bites

Every case starts at an A2A `input-required` frame on a stubbed SSE stream and
ends at the JSON-RPC body of the follow-up POST, with the real
`NestorCloudClient`, `NestorCloudEventAdapter`, `NestorCloudTurn`,
`NestorCloudToolExecutor`, `local-tool-adapter`, `LocalToolPermissionGate` and
`LocalToolRuntime` in between, wired as `nestor-cloud-agent.ts` wires them.

| Case | What it proves | Probe that turns it red |
| :-- | :-- | :-- |
| Two tools in one remote frame (`read_file`, `write_to_file`) | the local half really ran (the write lands on the real filesystem) and both results reach the remote side in request order, and the remote's reply after the continuation reaches the UI | P1 |
| `replace_in_file` on a missing file | a tool failure travels as `error` with empty `content` rather than vanishing | P2 |
| `execute_command` denied by the mode | the gate is asked about `Bash` and the remote-supplied name `execute_command` never reaches it; the command never runs; the refusal is delivered | P2, P3 |
| `read_file` on an absolute path outside the workspace, mode allowing | the session filesystem scope still refuses, and out-of-scope bytes never appear anywhere in the delivered payload | P2, P5 |
| Abort while `execute_command` is in flight | the abort reaches the in-flight local tool, the turn completes, and **nothing** is delivered to the remote task | P4 |

Probes. Each was applied, run, and reverted; `git diff --stat` confirmed a clean
tree after each.

- **P1** — result plumbing: `turn.ts` `content: result.content ?? ''` → `content: ''`. 1 fail: the happy path only.
- **P2** — error plumbing: `turn.ts` `...(result.error ? { error: result.error } : {})` → `...({})`. 3 fail: the failure, denial and scope cases; happy path and cancellation stay green.
- **P3** — permission identity: `local-tool-adapter.ts` bash subject `toolName: 'Bash'` → `'execute_command'`. 1 fail: the denial case only.
- **P4** — dispatch signal: `local-tool-adapter.ts` `{ ...localCall, abortSignal: signal }` → `{ ...localCall }`. 1 fail: the cancellation case only.
- **P5** — positive control for containment (test-side, no production edit): the outside directory added to `additionalRoots`. The scope case fails with `Received: "bytes the remote agent must never receive"`, so the empty `content` in that case is caused by the scope refusing and not by the assertion being vacuous.

### No defect found

All five cases passed on the first run and the path behaves correctly under each.
Two properties worth recording, because a reader of this path would otherwise have
to re-derive them:

- **The permission subject is the local identity, and the input is re-validated on
  both sides of the decision.** `createToolExecutionPorts.canonicalize` runs
  before the permission bridge and again on the approved input, and each run goes
  back through `normalizeNestorToolCall` against the *original* remote tool name,
  so `validateBuiltinArgs`' strict-key check applies twice. A `PreToolUse` hook
  cannot widen the argument set past the gate, and a semantic-identity change is
  rejected outright.
- **Containment is the scope's job, not the gate's.** The subject carries the
  remote agent's own path spelling (`{ file_path: '../x' }`), not the canonical
  resolved target, so a `deniedPaths` pattern anchored on an absolute path is not
  matched by a relative spelling. This is repo-wide — every backend hands
  `evaluateToolCall` the model's raw path — not something this adapter introduces,
  and the escape it would otherwise allow is what the scope case now proves is
  refused. Flagged rather than filed as a deviation, because verifying it as one
  means auditing `deniedPaths` defaults across all backends, which is not this row.

`search_files` reaches a shell while holding only a `Read` subject; the quoting
that makes that safe is a lower-level contract already covered by
`local-tools/__tests__/runtime.test.ts` (`rg --line-number --fixed-strings
'needle' '<path>'`), so it is not re-covered here.

### Deliberately uncovered

Three ways to lose half a category string, all hit while writing these four. An
inline backtick truncates the reason, because the register's reason group stops at
the first one. A reason over 400 characters is dropped past that point. And a
double underscore is stripped, so a test-directory path spelled with one comes out
mangled — name the file, not the directory.

documented, impossible on a hermetic suite — the real Nestor gateway transport for a tool result (TLS, the Nestor-Token header, a 401 or 5xx on the tool-result POST, and the SSE framing the live service emits) needs live credentials, so the end-to-end cases stop at the JSON-RPC body handed to a stubbed fetch; nestor-cloud-e2e.test.ts already gates a live case on NESSY_NESTOR_CLOUD_E2E and it stays skipped`

documented, impossible on a hermetic suite — whether the remote Nestor agent honours a delivered error, a denial, or an empty content field is the remote model's behaviour and not ours; the cases prove the result leaves this process in the documented tool_call_id plus content plus error shape, and nothing beyond that is provable without the live agent`

documented, not implemented — no end-to-end case drives a remote Nestor MCP tool call through McpClientPool, so the pool-backed leg of the path is proven only from the executor down by tool-executor.test.ts (proxy-name resolution, permission subject, abort propagation) while the turn and client plumbing above it is proven only by the builtin cases`

documented, not implemented — the two terminal Nestor tools ask_followup_question and plan_mode_respond are not driven end to end, so the composition of the adapter's terminal flag with the turn suppressing local tool cards is proven only in halves, by turn.test.ts with a stubbed executor and by tool-executor.test.ts with a hand-built call`

### Gate

| Check | Result |
| :-- | :-- |
| `bun test packages/shared/src/agent/backend/nestor-cloud/` | 79 pass, 0 fail (74 before) |
| `bun test packages/shared/src/agent/backend/` | 191 pass, 1 skip, 0 fail (186 before) |
| `bun test packages/shared/src/agent/__tests__/nestor-cloud-e2e.test.ts` | 5 pass, 1 skip, 0 fail — the skip is the live gate, still off |
| `bun run typecheck:shared` | clean |
| `npx eslint src/agent/backend/nestor-cloud/` | clean |
| `bun run lint:shared` | 0 errors, 4 pre-existing warnings in untouched files |
| `git diff --check` | clean |
| `bun run typecheck:all` | **fails in `packages/server-core/src/pi-harness/isolation.ts`** — not pre-existing and not ours: the concurrent isolation unit has that file uncommitted mid-edit (`git diff --stat`: 74 insertions), having moved `canonicalDenyRoot`/`canonicalDeniedReadRoot` out to a new untracked `isolation/self-config-deny.ts` without re-importing them. `git show HEAD:…/isolation.ts` still defines both at lines 50 and 63, so a clean tree at `c217f5e9` typechecks and no worktree reproduction was needed. |

Nothing on `docs/superpowers/specs/2026-07-29-known-failing-tests.md` was
observed: every suite in this row's scope is green.
