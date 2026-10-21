# P3.28 + P3.29 — the advisor on codex

**P3.28 decision: NOT "document the restart" — the restart is not required.** A codex-native
mechanism exists, was measured end to end against the bundled binary, and is now wired: the flip
takes effect on the next turn of the **same thread**, no runtime restart, no lost conversation.

---

## 1. P3.28 — premise correction (the measurement wins)

The row's premise, inherited from P3.13's scope flag:

> the codex subprocess's tool list is fixed at spawn, so flipping the advisor mid-session does not
> change the surface until the next runtime start

**Half of that is true, and the half that matters is false.** Our `session-mcp-server` parses argv
once, so *that subprocess's* list is fixed for its own lifetime. But a fixed subprocess is not a
fixed **surface**: the app-server re-spawns its MCP children on demand, and a new child is a new
argv. "Next runtime start" was an inference from our own code, not a property of codex.

### What was measured (2026-08-27, bundled `codex-app-server`, `rust-v0.148.0`)

Rig: real binary, real `writeCodexConfig` output, `startStubAdapter` as a loopback Responses
provider, and a hand-rolled stdio MCP server standing in for `session-mcp-server` in its one
relevant respect — it decides its tool list from argv, once, at its own startup. `--extra` plays
the part `--advisor-consult` plays in the real spec.

| Measurement | Result |
| --- | --- |
| `config/mcpServer/reload` after rewriting the whole `config.toml` | MCP child re-spawned with the new argv; `mcpServerStatus/list` shows the new tool |
| `config/value/write` on `mcp_servers.session.args` + `config/mcpServer/reload` | same, without us regenerating the file |
| **Model-visible surface, turn N+1, SAME thread** | `mcp__session` tool schema gains `extra_tool`; reversing the write removes it again |
| Config fidelity across 20 write+reload cycles | **zero** lines of our generated `config.toml` lost (only addition: the app-server's own `[projects.<ws>] trust_level`) |
| Latency of the write+reload pair, n=20, with a deliberately slow (3 s/response) second MCP server also configured | min 7.2 ms / p50 14.1 ms / **max 31.8 ms** — `reload` triggers re-initialization rather than awaiting it |

The stub stands in for `session-mcp-server` in its one relevant respect (argv read once, at its own
startup). The remaining link — that `--advisor-consult` is what puts `advisor_consult` on that
server's list — is not re-measured here because it is already pinned:
`packages/session-mcp-server/src/host-callback-bridge.test.ts` drives the real server's spawn args
and dispatch under both states. So the chain is: our gate (unit-tested) → the flag (bridge test) →
the re-spawn and the model's view of it (this measurement).

**The detector had to be corrected once, and this is the trap the row would otherwise have fallen
into.** The first cut read the Responses request body's top-level `tools[]` looking for
`extra_tool` and found nothing — which reads exactly like "the mechanism does not work". codex
projects an MCP server to the model as **one aggregated `mcp__<server>` tool** whose schema
enumerates the server's tools. `mcpServerStatus/list` (a status surface) had already said the
tool was there; only the wire body proves the *model* sees it, and it does.

### Share-vs-split

This is a **SPLIT with the codex-native mechanism named and measured**, not a shared mechanism and
not an open gap. pi rebuilds its proxy tool defs per turn; claude clears a per-session tool cache
(`setAdvisorEnabled` already calls `invalidateAllSessionToolsCaches`). Neither needs anything.
Only codex has a child process holding a frozen argv, and only codex gets the two extra RPCs.

### What was implemented, and the trigger choice

`CodexAgent.refreshSessionMcpAdvisorAdvertisement()` — a **turn-head drift check**, not a hook on
the toggle's own call site.

- `sessionMcpAdvisorAdvertised: boolean | null` records what the live app-server's
  `[mcp_servers.session]` argv advertises. Recorded in `createRuntime` **from the spec that was
  actually written** (a session with no spec stays `null`, so the check never claims a surface
  nothing serves); cleared in `teardownRuntime`.
- At the head of every turn, immediately before `applySelectedPluginSkillRuntimePolicy` (so a
  thread forked for a drifted model/policy starts with the corrected inventory), the agent compares
  that record against the argv `buildSessionMcpSpec` would emit **now**. Same method, so the spawn
  rule and the refresh rule are one rule; a new `CODEX_ADVISOR_CONSULT_FLAG` const means the writer
  and the reader cannot use two different literals.
- On drift: `config/value/write` (`mcp_servers.session.args`, `replace`, the whole argv) then
  `config/mcpServer/reload`. Only an **answered pair** records the new surface.
- Every failure — no client, no spec, refusal, deadline — leaves the record alone, so the next turn
  retries, and degrades to exactly the pre-P3.28 behaviour with one debug line.

**Why the turn head and not `BaseAgent.describeAdvisor`** — two reasons, and the second is a
finding in its own right (§2). First, the slash command is not the setting's only possible writer
(a hand-edited `config.json`, a managed push). Second, `describeAdvisor` is **unreachable in
production today**, so hanging this off it would have shipped a path no turn can take — the exact
"dead sentinel ships green" shape this plan has already been burned by.

### The timeout was measured, not inherited

`CODEX_MCP_ADVERTISEMENT_REFRESH_TIMEOUT_MS = 5_000`, per call. The sibling
`CODEX_THREAD_REFORK_TIMEOUT_MS` (30 s) was **not** reused: a fork carries the conversation and was
measured in the hundreds of ms; this pair is a config-key edit and a re-spawn trigger measured at
7–32 ms. 5 s is ~157× the slowest of 20 samples — the same order of headroom the re-fork bound
took, sized against this call's own resting state. Deliberately not smaller: a bound near the
resting state manufactures its own failures on a busy laptop.

---

## 2. Confirmed defect found while measuring P3.28 — `/advisor` never dispatches

**This is not a codex issue. It is every runtime, and it is on the branch at HEAD.**

`BaseAgent.chat()`'s session-command block has arms for `clear`, `quota` and `approve` and **none
for `advisor`**, so `parseSessionCommand`'s `{ kind: 'advisor' }` falls through to `chatImpl` and
the literal text is sent to the model as a prompt. The comment that *should* introduce the missing
arm is still there, orphaned above the `/approve` one:

> `/advisor` executes HERE for `/quota`'s reason: it reports and sets a SESSION-level fact, so one
> arm covers Pi, Claude, Codex and Nestor Cloud, and `chatImpl` is never entered.

The consequence is spelled out three lines below it, about the sibling command:
"a registered kind with no arm would send the bare `/approve` to the MODEL on every runtime —
which is what shipped while the classifier did not know the command at all (P3.25)."

**Reproduced, with a positive control** (drove `BaseAgent.chat` through `TestAgent`):

```
"/quota"       -> reached chatImpl: false | events: ["info","complete"]
"/approve"     -> reached chatImpl: false | events: ["info","complete"]
"/advisor"     -> reached chatImpl: true  with "/advisor"     | events: ["complete"]
"/advisor on"  -> reached chatImpl: true  with "/advisor on"  | events: ["complete"]
"/advisor off" -> reached chatImpl: true  with "/advisor off" | events: ["complete"]
```

`parseSessionCommand` classifies all three forms correctly — the classifier is fine, the arm is
missing. Corroborating grep: `describeAdvisor` has **no production caller** anywhere
(`base-agent.ts` defines it, `test-utils.ts` exposes it for tests, `pi-agent.ts` mentions it in a
comment); `setAdvisorEnabled` has exactly one caller, `describeAdvisor` itself.

So today `advisorEnabled` can only be changed by editing config on disk. The advisor is opt-in and
ships OFF, which means **`/advisor on` cannot turn it on**, on any runtime.

**Not fixed here, deliberately.** The fix is one arm in `packages/shared/src/agent/base-agent.ts`:

```ts
if (sessionCommand.kind === 'advisor') {
  yield* this.describeAdvisor(sessionCommand.action);
  yield { type: 'complete' };
  return;
}
```

`base-agent.ts` is outside my zone **and** is modified in the working tree by another lane, so
committing it by pathspec would take their state. Per the lane rules I stopped and am reporting it
rather than reaching across. It wants its own tracker row (owner rule: findings become plan rows at
confirmation) — and it should probably carry a test at the `chat()` seam covering *every*
`SessionCommand` kind against the arms present, since this is the second time a registered kind
shipped with no arm.

P3.28's work is not wasted by this: the drift check is trigger-independent and closes on the next
turn however the setting moves, so it goes live the moment the arm lands, and it already covers the
config-on-disk route.

---

## 3. P3.29 — the agreement test now covers codex

**Premise confirmed.** `getSystemPrompt` has exactly two production importers, `pi-agent.ts` and
`claude-agent.ts`. `codex-agent.ts` imports no prompt builder — codex composes its own system
prompt in the app-server and takes project guidance from `AGENTS.md`. The only reference to a
system prompt in `codex-agent.ts` is inside `queryLlm`'s own request path, not the session prompt.
So the `## Advisor` block genuinely never reaches codex, and `TOOL_DESCRIPTIONS.advisor_consult` is
the **whole carrier** of the advisor's triggering guidance there.

**Extended, not exempted.** A new describe in `advisor-gate-projection.test.ts` —
`codex reads the tool description, so the two texts must agree`. Its header states, for a future
editor, why the codex arm is shaped differently from the pi/claude one (the existing arm compares a
*state*: block present ⇔ tool advertised; codex cannot be measured that way because it never
receives the block — that is a reason, not an exemption), and where the piece it does *not* pin
lives.

What it pins:

- the tool description names **every** `ADVISOR_MOMENTS` id, and its moment bullet list has
  **exactly** `ADVISOR_MOMENTS.length` entries — a fourth moment added to the schema and the prompt
  but not here would leave codex unable to ask for it;
- the prompt block's bullet list has the same count;
- five guidance clauses present verbatim in **both** texts: `not routinely`,
  `do not consult twice for the same question`, `advice, not an instruction`,
  `has no tools and cannot act`, `has come back after you already tried to fix it`.

The `before-done` moment is worded differently on purpose in the two texts (the prompt addresses
the model mid-task; the description addresses a tool caller), which is why the moment bullets are
pinned by count and id rather than by wording — that is written into the test so nobody "fixes" it
by forcing the two sentences to match.

**Deliberately not pinned here, and where it is instead:** the codex *gate*
(`advisorEnabled` ⇔ the `--advisor-consult` spawn flag) is not measurable from a file that mocks
host storage without dragging the codex runtime stack into it. It is covered in
`codex-advisor-advertisement.test.ts`, whose first two tests drive `buildSessionMcpSpec` under both
settings. The new describe says so by name.

### Behavioural smoke, run mutex-free while the shared `bun test` lock was held

The lock was held by another lane (`P2.85-attrib2`) for the whole implementation window, so every
branch of the new seam was exercised as a plain `bun` script (not `bun test`, so no contention),
driving the real `CodexAgent` with doubled channels and the **real** `getAdvisorEnabled()` — which
ships `false`, so the OFF direction is a real-path exercise with no module mocking at all:

```
real getAdvisorEnabled() = false
A drift OFF (record=true, setting=false)
   methods=["config/value/write","config/mcpServer/reload"] timeouts=[5050,5050] record=false 2ms
   keyPath=mcp_servers.session.args merge=replace hasFlag=false argvLen=12 standalone=true bridge=true
B no drift (record=false)          methods=[] record=false
C no record (null)                 methods=[] record=null
D no client                        methods=[] record=true
E no session-server path           methods=[] record=true
F wedged (option dropped)          methods=["config/value/write"] record=true 302ms
G wedged (option honoured)         methods=["config/value/write"] record=true 301ms
H refused reload                   afterRefusal=true afterRetry=false
```

`timeouts=[5050,5050]` is the production constant plus `CODEX_DEADLINE_CHANNEL_MARGIN_MS`, i.e. the
bound really reaches the channel; `argvLen=12` with `--external-standalone-only` and
`--host-callback-port` present is the whole spawn argv, so `replace` cannot truncate the surface.

**Incidental finding while building that rig, pre-existing and NOT caused by this change:**
`packages/shared/src/agent/codex-agent.ts` cannot be loaded as an entry module outside `bun test` —
it dies with `Cannot access 'AUTO_MEMORY_MARKER_REGEX_SOURCE' before initialization`
(`agent/memory/memory-cleanup.ts:41`), a module cycle. Verified against **HEAD's** copy of the file
(extracted with `git show` and imported from the same directory): it fails identically, so it is not
mine. `codex-refork-deadline.test.ts`'s exact static import order reproduces it too, while the
namespace-import-then-dynamic-import order the new test file uses does not. `bun test` evidently
tolerates the cycle; a plain script does not. Worth a row on its own — a cycle that only the test
runner survives is a trap for the next person who writes a script against this module.

---

## 4. Files changed

Committed as **`d9e5bb112`** — `fix(codex): the advisor flip needs a new MCP child, not a new
runtime`. `git show --stat` confirms exactly these four files and nothing else.

| File | Change |
| --- | --- |
| `packages/shared/src/agent/codex-agent.ts` | `CODEX_ADVISOR_CONSULT_FLAG`, `CODEX_MCP_ADVERTISEMENT_REFRESH_TIMEOUT_MS`, `sessionMcpAdvisorAdvertised`, `refreshSessionMcpAdvisorAdvertisement()`, the turn-head call, spawn-time record, teardown clear, corrected `buildSessionMcpSpec` doc |
| `packages/shared/src/agent/__tests__/codex-advisor-advertisement.test.ts` | NEW — 7 tests over our wiring |
| `packages/shared/src/agent/__tests__/codex-advisor-advertisement-e2e.test.ts` | NEW — gated on `NESSY_CODEX_E2E=1`, pins the upstream mechanism against the real binary |
| `packages/shared/src/agent/__tests__/advisor-gate-projection.test.ts` | P3.29 — new describe, 7 cases |

No i18n keys added (none needed — the base status line becomes *true* on codex rather than needing
a "takes effect after restart" caveat). No files outside the zone touched.

### Why the e2e file exists

The unit tests drive a channel *we* write, so they are green whether or not the app-server does
anything with the two requests — on their own they are precisely the "test double that drops the
argument under test" blind spot. The load-bearing claim is upstream and one codex bump from
changing, so it is pinned against the real binary, following the existing
`codex-inject-items-e2e.test.ts` pattern (gated, no network, no credentials). It carries a positive
control (`always_tool` must stay visible) so "extra_tool absent" means the flag and not a rig that
stopped seeing tools.

---

## 4b. Gate output (real, under the mutex)

```
bun scripts/bun-test-lock.ts run --label P3.28-P3.29 --wait 5400 -- bun test \
  codex-advisor-advertisement.test.ts codex-advisor-advertisement-e2e.test.ts \
  advisor-gate-projection.test.ts advisor-tool-projection.test.ts advisor.test.ts \
  advisor-consult-wiring.test.ts codex-callback-bridge-host.test.ts

 104 pass
 3 skip
 0 fail
 309 expect() calls
Ran 107 tests across 7 files. [20.07s]
```

The 3 skips include the `NESSY_CODEX_E2E`-gated block, so it was then run with the gate open —
**against the real `codex-app-server`**:

```
NESSY_CODEX_E2E=1 bun scripts/bun-test-lock.ts run --label P3.28-e2e --lease 600 -- bun test \
  codex-advisor-advertisement-e2e.test.ts codex-advisor-advertisement.test.ts \
  advisor-gate-projection.test.ts

 28 pass
 0 fail
 103 expect() calls
Ran 28 tests across 3 files. [48.31s]
```

**Zero skips**, so the e2e executed: the real binary re-spawned its MCP child on
`config/value/write` + `config/mcpServer/reload`, and the model-visible `mcp__session` tool schema
gained and then lost the tool across turns 2 and 3 of the **same thread**. P3.28's upstream claim is
therefore proven by the committed test, not only by a scratch probe.

`codex-callback-bridge-host.test.ts` (server-core)
is in the batch deliberately — it asserts `codex-agent.ts` as source text, so it is the file my
change was most likely to break, and it passes; see concern 3 for how that shaped the change.

Other gates: `bun run typecheck:shared` clean; `npx eslint` clean on all four files;
`git diff --check` clean on the two modified files. No full-repo suite, per the
implementation-first budget.

The wait was real: the shared lock was held continuously by `P2.85-attrib2` from 17:06 to 17:40,
then by `P2.212-rebreak` and `P2.211-pins2`. Nothing was run outside the mutex except the plain-`bun`
smoke above, which is not a `bun test` process.

---

## 5. Documentation classification

- **P3.28 is category (b)** in part, and the citation is upstream behaviour I could not settle from
  a doc page alone. `learn.chatgpt.com/docs/extend/mcp.md` is the governing page (row `extend/mcp`
  in `scripts/codex-doc-pages.tsv`); it documents the *user-facing* answer for changing MCP
  configuration — "Save the server, then select **Restart**" (desktop app) and "Save the server,
  then select **Restart extension**" (IDE) — and lists the per-server config keys, but it says
  nothing about the app-server protocol's `config/mcpServer/reload`. The protocol methods are in
  the generated contract we vendor: `packages/codex-protocol/generated/ClientRequest.ts` declares
  `{ "method": "config/mcpServer/reload", id: RequestId, params: undefined }` and
  `config/value/write` / `config/batchWrite`, and `ConfigBatchWriteParams.reloadUserConfig` is
  documented in that generated type as *"When true, hot-reload updated runtime settings into loaded
  threads after writing"*. So: **the docs do not contradict P3.28's answer, they simply do not
  cover the protocol surface**, and the behaviour was therefore established by measurement against
  the pinned binary rather than asserted from prose. That is recorded in the code comment.
- **P3.29 is category (a)** — our own implementation. The agreement between our system-prompt block
  and our tool description is governed by no upstream page. (`advisor.md` names the three moments,
  and `advisor.ts`'s header already cites it; nothing there speaks to which of our texts carries
  them to which runtime.)

---

## 6. Concerns / open items for the controller

1. **The `/advisor` dispatch arm (§2) needs a row and an owner.** Until it lands, the toggle is
   only reachable by editing config on disk. My work is live on that route and goes live on the
   command route the moment the arm exists.
2. **`config/mcpServer/reload` reloads *every* configured MCP server, not just `session`.** For a
   Nessy codex session that is `session` plus the `sources` pool entry. Measured cost is 7–32 ms
   and the reload does not block on slow servers, but a source server holding in-flight state (an
   OAuth handshake, a browser session) is re-initialized by an advisor flip. Judged acceptable —
   flips are rare, opt-in, and user-initiated — but it is a real coupling and should be named if
   another row ever wants to reuse this seam for something that flips often.
3. **`codex-callback-bridge-host.test.ts` reads `codex-agent.ts` as source text, and my first cut
   broke it — twice.** It asserts two exact substrings: the whole `--advisor-consult` spread
   expression, and `sessionMcp: this.buildSessionMcpSpec(callbackBridge?.port)`. My first version
   substituted `CODEX_ADVISOR_CONSULT_FLAG` into the former and hoisted the latter into a `const`.
   Both are outside my zone (`packages/server-core`), so rather than edit them I **reshaped my own
   change** to leave both expressions byte-identical: `buildSessionMcpSpec` keeps the bare literal
   (with a comment saying why), and the spawn-time record is taken from a second, adjacent,
   synchronous call to the same method rather than from a hoisted binding. What binds the literal to
   the constant is now mechanical instead of lexical — the new unit test asserts, with the advisor
   ON, that the argv `buildSessionMcpSpec` produces contains the constant's value, so a rename in
   one place and not the other fails immediately. That file is in the verified batch and passes.

   Worth a row regardless: a test that pins another package's source as a string will keep taxing
   refactors of that file, and it has now cost one. It is doing a real job (the method cannot be
   called without spawning an app-server), so the answer is probably a narrower assertion — the
   condition, not the whole expression — rather than deleting it.
4. The `describe.if(NESSY_CODEX_E2E === '1')` e2e never runs in CI by construction — the binary is
   untracked and ~180 MB. It **was** run here with the gate open and passes (§4b), but that means
   nothing protects the upstream claim on a codex version bump unless someone runs it. Worth
   naming in whatever checklist covers `scripts/fetch-codex.mjs` bumps:
   `NESSY_CODEX_E2E=1 bun test packages/shared/src/agent/__tests__/codex-advisor-advertisement-e2e.test.ts`
   (no network, no credentials).
5. **Housekeeping, in case another lane notices:** I ran `rm -rf release` before the test batch, per
   the standing rule that a packaged tree adds phantom failures. It is gitignored build output and
   rebuildable, but if a lane was mid-package it will need to re-run its build.
6. `refreshSessionMcpAdvisorAdvertisement` takes an overridable `timeoutMs` (default = the constant),
   the same shape `applySelectedPluginSkillRuntimePolicy` uses so a test can pick a bound it can wait
   out. Production passes nothing, and one test asserts the constant reaches the channel — without
   that row every other assertion in the file passes with the bound deleted.
