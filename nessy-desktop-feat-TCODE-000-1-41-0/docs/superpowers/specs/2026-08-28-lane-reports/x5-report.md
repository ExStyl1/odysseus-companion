# P2.313 — half the documented configuration surface is inert on Pi

**Status:** DONE (triage + divergence record landed; the named-victim FIX is out of zone and reported, not applied)
**Base SHA recorded before starting:** `09b77d44903d0695afb278515ea9d51260f91e5b`
**Commit:** `3e66f5fbb`
**Files touched:** `docs/architecture/runtime-capability-gaps.md`, `packages/shared/src/agent/__tests__/claude-operator-ceiling-env.test.ts` (new). `packages/shared/src/agent/options.ts` was **not changed** — see §4.

---

## 1. The headline: the row's stated mechanism is REFUTED

The row says the mechanism is one line — *"`options.ts` spreads `process.env` into the SDK
subprocess, which is exactly what Pi does not do."*

**Pi does exactly that too.** `buildPiSubprocessEnv` (`packages/shared/src/agent/pi-agent.ts:242`)
opens `{ ...parts.processEnv, ...parts.proxyEnv, ...parts.envOverrides, ...parts.awsEnv, … }`, and
`pi-agent.ts:2218` calls it with `processEnv: process.env`.

Measured on one rig, both builders imported, one host environment:

```
BASH_MAX_TIMEOUT_MS      pi=60000 claude=60000
BASH_DEFAULT_TIMEOUT_MS  pi=30000 claude=30000
ZZZ_CONTROL              pi=1     claude=1        # invented name, carried by both
counts pi=69 claude=70 host=67
```

**So the one-line fix is a no-op.** The variables reach Pi's subprocess today and are never read.
The gap is a *reader* gap in the tool layer, not an *environment* gap in either spawn path.

(The sweep document itself already said this — `2026-08-28-claude-sweep-triage.md`, F127 preamble:
"The Pi subprocess spreads `process.env` too (`pi-agent.ts:2218`), so the variables *arrive* and are
never *read*". The row inverted it on the way into the plan.)

### …and the other place the one-liner could be aimed is worse than a no-op

Pi's Bash **children** do not get the host environment. They run under the supervisor's `restricted`
profile — `RESTRICTED_HOST_ENVIRONMENT` in `packages/server-core/src/pi-harness/process-supervisor.ts:791`,
a 29-name allowlist plus `LC_*`. Measured against this host: **5 of 64 keys admitted**
(`HOME`, `LOGNAME`, `PATH`, `SHELL`, `USER`), 59 dropped.

That is **stricter than Claude's default**, and it is exactly what a Claude operator opts into with
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` ("strip Anthropic and cloud provider credentials from subprocess
environments (Bash tool, hooks, MCP stdio servers)") or `CLAUDE_CODE_MCP_ALLOWLIST_ENV` ("spawn stdio
MCP servers with only a safe baseline environment … instead of inheriting your shell environment").

**Blast radius of "spread the host env for Pi", applied there: 5 keys → 64.** On packaged macOS
builds `loadShellEnv` copies the user's whole login shell in wholesale, so that is every API key,
token and cloud credential in their profile, handed to every model-issued shell command. It would
delete a working security control in order to close a documentation gap. Do not do it.

---

## 2. The one with a named victim — CONFIRMED, with one correction

`[doc:claude]` · **bug** (a control we built that does not bound what an operator was told it bounds)

`env-vars.md#variables`, verbatim:

> `BASH_DEFAULT_TIMEOUT_MS` | Default timeout for long-running bash commands (default: 120000, or 2 minutes)

> `BASH_MAX_TIMEOUT_MS` | Maximum timeout the model can set for long-running bash commands (default: 600000, or 10 minutes). The effective ceiling is the larger of this and `BASH_DEFAULT_TIMEOUT_MS`

> `BASH_MAX_OUTPUT_LENGTH` | Maximum number of characters of bash output that Claude Code reads back into a command's result (default: 30000; maximum: 150000).

(Anchor verified against the rendered page's own `id=` attributes, not derived from a slug rule.
Note the URL correction the brief flagged: `https://code.claude.com/docs/en/env-vars.md`.)

**Honoured on claude-runtime:** occurrences in `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`
(Claude Code 2.1.223, 272 MB) — 5, 5, 10. Zero controls: `NESSY_BASH_DEFAULT_TIMEOUT_MS` → 0,
`ZZZ_NOT_A_VAR_XYZ` → 0.

**Inert on Pi:** `git grep -a -F` over `packages apps` → **0 files each**. Positive control
`CLAUDE_CODE_MAX_RETRIES` → 4 files. `NESSY_BASH*` → 0, so there is no renamed equivalent either.

**The unbounded path, end to end:**

1. `packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts:363` — the model's `timeout` is
   the only input; `millisecondTimeout` raises anything below 1000 to 1000 and applies **no maximum**.
2. `packages/shared/src/agent/pi-harness/process-supervisor-port.ts` — `pickSupervisedChildStartFields`
   is the host's allowlist rebuild and passes `timeoutMs: request.timeoutMs` **unmodified**.
3. `packages/server-core/src/pi-harness/process-supervisor.ts:231` —
   `const deadlineAt = request.persistent ? Number.MAX_SAFE_INTEGER : Date.now() + request.timeoutMs`.
   **There is no `Math.min` anywhere in that file.**

So: an administrator who sets `BASH_MAX_TIMEOUT_MS` bounds a claude-runtime session and does not
bound a Pi one. Confirmed as described.

### The correction: it is a TRIO in the row and a PAIR in reality

`BASH_MAX_OUTPUT_LENGTH` is a **knob** gap, not a **ceiling** gap. Pi does cap Bash output:
`ProcessSupervisor.MAX_FOREGROUND_STREAM_BYTES = 64 * 1024`, hard-coded
(`process-supervisor.ts:29`, consumed by `appendBoundedStream`). What is missing is the operator's
ability to change it, not the bound. **Two of the three are unbounded; one is fixed-and-unconfigurable.**
The row's "no operator ceiling at all" is right about the timeouts and wrong about output length.

---

## 3. What I did NOT close, and why — the zone

The fix needs files outside my zone, so I stopped and reported rather than reaching:

- `packages/pi-agent-server/src/local-tools/runtime-backed-tools.ts` (the child that proposes a timeout)
- `packages/shared/src/agent/pi-agent.ts` — `handleProcessStartRequest`, **the right site**
- `packages/shared/src/agent/pi-harness/process-supervisor-port.ts` (`pickSupervisedChildStartFields`)

`pi-agent.ts` is additionally modified in the working tree by another lane right now, so touching it
would have been a collision as well as a zone breach.

**The exact patch shape, ready to apply.** Put the clamp on the **host** side, in
`PiAgent.handleProcessStartRequest`, right where `pickSupervisedChildStartFields` produces
`childStartFields` — that is the allowlist rebuild a subprocess provably cannot smuggle past, and it
already exists for exactly this class of reason:

```ts
// env-vars.md#variables — "BASH_MAX_TIMEOUT_MS | Maximum timeout the model can
// set for long-running bash commands (default: 600000, or 10 minutes). The
// effective ceiling is the larger of this and BASH_DEFAULT_TIMEOUT_MS"
const ceiling = Math.max(
  numericEnv(process.env.BASH_MAX_TIMEOUT_MS) ?? 600_000,
  numericEnv(process.env.BASH_DEFAULT_TIMEOUT_MS) ?? 120_000,
);
const childStartFields = {
  ...pickSupervisedChildStartFields(request),
  timeoutMs: Math.min(request.timeoutMs, ceiling),
};
```

Three things the implementer must not get wrong, each measured or cited:

1. **The ceiling is `max(BASH_MAX_TIMEOUT_MS, BASH_DEFAULT_TIMEOUT_MS)`**, not `BASH_MAX_TIMEOUT_MS`
   — the page says so in the row itself.
2. **`persistent` requests must stay exempt.** The supervisor already gives them
   `Number.MAX_SAFE_INTEGER`; a clamp applied before that branch would kill long-lived MCP/LSP children.
3. **`env-vars.md#variables` documents numeric spellings**: "Claude Code reads `2e3` as 2000 and
   `64_000` as 64000." A naive `parseInt` reads `64_000` as 64 — the exact class of bug the page says
   they shipped and fixed in v2.1.211 ("`1e6` setting a timeout to 1"). Use `Number(raw.replace(/_/g,''))`
   and reject non-finite/non-positive.
4. `BASH_DEFAULT_TIMEOUT_MS` also needs to become the **default** when the model sends no `timeout` —
   that half lives in `runtime-backed-tools.ts`, whose current default comes from the Pi SDK (its tool
   description says 120000, which happens to match the documented default, so the default arm is
   cosmetic today and the ceiling arm is the load-bearing one).

I did not write this because I could not test it in zone, and an untested clamp on the process-spawn
path is worse than a recorded defect.

---

## 4. Why `options.ts` was not changed

The zone named it because the row believed the mechanism lived there. It does not. Adding a Bash
ceiling to `buildClaudeSubprocessEnv` would be wrong twice over: claude-runtime already honours these
variables through the spread, and a *default* ceiling we invent is a product decision nobody asked
for. `[doc:none]` on that sub-question — no page tells us to impose one.

What I did add there is the missing **test** for the half that works, because the pass-through turns
out to be a load-bearing contract with no assertion behind it, and the change that would break it is
a plausible, well-intentioned one (scrub the child env — which is precisely what
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` exists to opt into).

`packages/shared/src/agent/__tests__/claude-operator-ceiling-env.test.ts`, 5 cases:

- the Bash trio survives the builder from the host env;
- the wider ceiling set survives (restricted to names verified *present* in the vendored 2.1.223 binary);
- an `envOverrides` value beats the ambient one;
- **negative/boundary:** unset stays unset, so a builder that hard-coded ceilings could not pass the
  first case by accident;
- **positive control on the discrimination:** the same builder still strips
  `CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS` set in the same environment — without this, "it carries
  things" would prove nothing about intent.

**Proved by breaking it**, against the recorded base SHA, not `HEAD~1`: replacing `...process.env` at
`options.ts:245` with a comment gives **3 fail / 2 pass** (`Ran 5 tests across 1 file`). Restored and
md5-verified identical to the pre-probe file (`8091f27dfad87942da4039988d9e0153`), `git diff` empty.

---

## 5. The triage — the rest, ranked by what its absence costs

I re-derived the numbers rather than inheriting them.

**Denominators.** `env-vars.md` §Variables table, first column: **345** unique variable names.
`settings-reference.md` `###`/`####` backticked headings: 217 keys → **216** unique leaf names
(the row's "216" reproduces exactly).

**Membership** (`git grep -a -F -f <names>` over `packages apps`, i.e. name appears *anywhere*
including comments):

| | present | absent |
| --- | --- | --- |
| env vars (of 345) | 73 | **272** |
| settings keys (of 216) | 112 | **104** |

The row said 279/361 and 105/216. Same measurement, different scrape of the denominator (they took
every backticked ALL-CAPS name on the page, I took the table's key column). **Premise confirmed.**

**Both "present" figures are upper bounds on *honoured*.** A leaf name like `env`, `model` or `hooks`
collides with our own identifiers, and a name in a comment is not a name read. Spot-check of five
"absent" settings keys (`autoCompactWindow`, `disableBypassPermissionsMode`,
`disableSkillShellExecution`, `respectGitignore`, `skipAutoPermissionPrompt`) → 0 files each, so the
absent side has no obvious false positives.

### Ranking of the 272 absent env vars

| Rank | Bucket | Count | Verdict |
| --- | --- | --- | --- |
| **1** | **Ceilings, timeouts, budgets** | **29** | **Close by consequence. Bash timeout pair first.** Then `CLAUDE_CODE_MAX_TURNS`, `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `MAX_THINKING_TOKENS`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_GLOB_TIMEOUT_SECONDS`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, `SLASH_COMMAND_TOOL_CHAR_BUDGET`; then the idle/TTL tail. |
| **2** | **Policy and security switches** | **32** | Row each, but decide per key whether we owe the *knob* or only the *behaviour*. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` / `CLAUDE_CODE_MCP_ALLOWLIST_ENV` are already satisfied *more strictly* by our default. `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`, `CLAUDE_CODE_GLOB_HIDDEN`/`_NO_IGNORE`, `CLAUDE_CODE_SHELL`/`_SHELL_PREFIX`, `DISABLE_TELEMETRY`, `DO_NOT_TRACK` are the real ones. |
| **3** | **Not our surface** | **112** | **Recorded divergence, no rows.** Bedrock/Vertex/Foundry/Mantle routing (deliberately stripped by `CLAUDE_CLOUD_PROVIDER_ROUTING_ENV_KEYS`), OTEL, IDE integration, remote control, artifacts, updater, feedback surveys, MCP client internals. |
| **4** | **Cosmetic / terminal chrome** | **21** | **Recorded divergence. Never.** Mouse, alternate screen, syntax highlight, cursor, scroll speed, TTY accessibility. Nessy is not a terminal. |
| **5** | **Residual behaviour flags** | **78** | **Recorded divergence.** Fast-mode, prompt-caching spellings, plugin/skill sync, experimental agent teams, session-resume internals. Individually cheap, collectively a phase nobody has asked for. Re-open per key when one has a user. |

### Three exclusions a blanket sweep would get wrong

Each looks like a gap and is not — this is why the row was right to forbid attempting all 384:

- **`CLAUDE_CODE_TOOL_MEMORY_LIMIT`** (rank 1) — **0 occurrences** in the vendored 2.1.223 binary. The
  page dates it "on v2.1.246 or later", Linux/WSL only. Inert on *both* runtimes → no asymmetry.
- **`CLAUDE_CODE_RESTRICTED`** (rank 2) — **0 occurrences**, same reason: "Requires Claude Code
  v2.1.248 or later".
- **`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`** (rank 1) — 8 occurrences in the pinned binary, but the
  page says "Removed in v2.1.224 and now a no-op". Implementing it implements a withdrawn contract.

### Settings half — the 104 absent, notable entries

Not bucketed to the same depth (the ceilings live on the env side), but worth naming:
`disableBypassPermissionsMode`, `disableSkillShellExecution`, `skipAutoPermissionPrompt`,
`skipDangerousModePermissionPrompt`, `ignoreViolations`, `respectGitignore`, `disabledMcpjsonServers`
/ `enabledMcpjsonServers` / `enableAllProjectMcpServers`, `autoCompactWindow`, `promptCacheTtl`.
The sandbox family (`enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `isolatePeerMachines`,
`allowAllUnixSockets`, `allowAppleEvents`, `allowMachLookup`, `allowPlaintextInject`) is **not our
surface** — isolation is off by standing owner decision.

### Where it is recorded

`docs/architecture/runtime-capability-gaps.md` gains a §*Documented configuration Pi does not read*
carrying every number above, the refuted mechanism, the blast-radius measurement, the three
exclusions, and a **re-measurement recipe** so the next sweep confirms rather than re-derives (and is
warned that `grep` without `-a` skips this tree's NUL-carrying files silently). Two rows are added to
the Pi table pointing at it: the Bash-ceiling defect (open) and the counted divergence.

---

## 6. Findings, tagged and classified

| # | Finding | Tag | Kind |
| --- | --- | --- | --- |
| F1 | **Pi's Bash tool has no operator timeout ceiling.** `BASH_MAX_TIMEOUT_MS`/`BASH_DEFAULT_TIMEOUT_MS` honoured on claude-runtime, unread on Pi; the model's own value becomes the deadline unclamped. | `[doc:claude]` | **bug** |
| F2 | **The row's mechanism is wrong.** Pi already spreads `process.env`; the one-line fix is a no-op. Measured both builders side by side. | `[doc:none]` | **bug** (in the row, not the code) |
| F3 | **The plausible mis-aimed fix would remove a working security control.** Pi's Bash children get a 29-name allowlist (5 of 64 keys here); "spread the host env" there widens to 64 and hands every shell command the user's login-shell secrets. | `[doc:claude]` (Claude documents the opt-in; we do it by default) | **never looked at** |
| F4 | **`BASH_MAX_OUTPUT_LENGTH` is not a missing ceiling.** Pi caps Bash output at a hard-coded 64 KiB; the gap is configurability. Row said "trio", reality is a pair plus a knob. | `[doc:claude]` | **forgotten vs doc-parity** |
| F5 | **272/345 env vars and 104/216 settings keys unread**, ranked 29/32/112/21/78, both figures upper bounds on honouring. | `[doc:claude]` | **forgotten vs doc-parity** |
| F6 | **Three "gaps" are not gaps** — two variables absent from the pinned binary (post-2.1.223 features) and one withdrawn contract. A blanket implementation would ship all three. | `[doc:claude]` | **never looked at** |
| F7 | **`options.ts`'s `process.env` spread had no test** despite being the only reason any operator ceiling binds a claude-runtime session. Now covered; break-probe 3/5 fail. | `[doc:none]` | **never looked at** |

---

## 7. Gates — each with proof of work, no pipes

| Gate | Result | Proof |
| --- | --- | --- |
| `bun test` on zone, through the mutex | **PASS** | `bun scripts/bun-test-lock.ts run --label x5-final -- bun test .../claude-operator-ceiling-env.test.ts` → `5 pass / 0 fail / 25 expect() calls`, `Ran 5 tests across 1 file. [1345.00ms]`, exit 0. Redirected to a file, not piped. |
| Break-probe (prove the test discriminates) | **PASS** | Spread removed at `options.ts:245` → `2 pass / 3 fail`, `Ran 5 tests across 1 file.`, exit 1. Restored; md5 `8091f27dfad87942da4039988d9e0153` matches pre-probe, `git diff` empty. |
| `tsc --noEmit` in `packages/shared` | **1 error, NOT MINE** | The only line is `src/agent/__tests__/fixtures/floating-emission-probe.ts(421,7): error TS2683`. That file is another lane's in-flight edit — 272 lines at HEAD, 456 in the tree, and their own comment discusses TS2683. Zero errors mention either of my files. |
| `eslint --format json` from `packages/shared` | **PASS** | 2 files linted, `errorCount=0 warningCount=0` on both. `--format json` per the trap note; `--format unix` would have written a clean-looking empty file. |
| `git diff --check` on my paths | **PASS** | exit 0, no whitespace errors. |
| Commit isolation | **PASS** | `git show --stat --oneline HEAD` → exactly 2 files, 242 insertions. `git diff --cached --name-only` empty after commit and after amend. Other lanes' 8 modified files untouched. |
| Full repo `bun test` / `typecheck:all` / build / packaging | **NOT-RUN** | Implementation-first budget: nothing here touches a shared wire, schema, auth path, lock or build input. The one code file added is a test. |
| Live/CDP | **NOT-RUN** | No runtime behaviour changed. The Pi defect is proven by source path + absent clamp, not by a live run; a live demonstration would be worth having when the fix lands. |

---

## 8. Concerns

1. **The named victim is still open.** F1 is confirmed and unfixed because its three candidate files
   are all outside the zone. The patch shape in §3 is complete enough to apply directly; it needs a
   lane that owns `pi-agent.ts` (currently held by another lane).
2. **Zoning mismatch.** This row was zoned to `options.ts` on a premise that measurement refutes. Any
   follow-up row must be zoned to the Pi tool/supervisor path instead, or it will reproduce this.
3. **Rank 2 needs an owner call, not an engineer's.** Several of the 32 policy switches are things we
   already do *more strictly* than Claude. "Honour the knob" and "match the behaviour" are different
   products; implementing `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0` would mean building an opt-*out* of a
   control we currently apply unconditionally.
4. **Membership-by-grep is an upper bound both ways.** 73 and 112 count *mentions*, not *readers*.
   The true honoured counts are lower. If anyone wants exact numbers, the measurement is per-key and
   costs a day; the ranked buckets are what a decision actually needs.
5. **The corpus moves under this record.** Two of the three exclusions exist only because the pinned
   binary is 2.1.223 and the docs describe 2.1.246/2.1.248. An SDK bump turns both into real
   asymmetries. The re-measurement recipe in the doc is there for that reason.
6. **`git grep` vs the wrapped `grep`.** Every absence claim here used `git grep -a` or
   `/usr/bin/grep -a` with a fabricated-name zero control. The wrapped `grep` on this host is
   `ugrep -G --ignore-files -I` and would have skipped this tree's NUL-carrying files at exit 0.
