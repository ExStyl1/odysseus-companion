# Release sitting — packaged 1.36.0, 2026-09-11 (plan row P7.5)

Driven over CDP by lane W14-sit. One narrative section per case, in the order the cases were run.

## The build under test

`release/mac-arm64/Nessy Desktop.app` — version **1.36.0**, built 2026-09-11 12:12–12:16 from HEAD
`1616bcdb9`, launched directly from a shell as

```
"release/mac-arm64/Nessy Desktop.app/Contents/MacOS/Nessy Desktop" \
  --remote-debugging-port=9223 --disable-backgrounding-occluded-windows
```

CDP answered `NessyDesktop/1.36.0 Chrome/142.0.7444.235 Electron/39.2.7`, one page target, and every case
below reports `app under test: {"kind":"packaged"}` from its own reading of the page target url — the
harness's own check, not this paragraph. The bundle carries HEAD (`resolveGatewayFastModelId` 11,
`classifierContext` 7, `parseSubtaskCommand` 2 in `app/dist/main.cjs`).

The config dir is the operator's live one, `~/.nessy-agent`; the host is the owner's Mac, load average
14–16 throughout from sibling lanes, which is quoted beside any duration below.

## The rig finding that shapes every card-dependent case

**A packaged build cannot open this host's credential store, and says so in words.** The first case to
ask for a BYO card (`RS-02`, which needs the DEFAULT Pi runtime) got this back from the app's own
connection switch, verbatim:

> Your saved keys are still on disk, but they were encrypted on a different machine identity, so this
> installation cannot open them. This happens after moving to a new Mac, a hardware change, or a launch
> where the hardware id could not be read. Enter the key again to continue — that writes a fresh entry
> under this machine and leaves the old file untouched.

That is `packages/shared/src/credentials/backends/secure-storage.ts` speaking, and the first reading of it
was the obvious one and it was **WRONG**. The obvious reading is that this packaged build cannot open a
store written under a different code signature — `credentials.enc` is machine-bound by design, the 1.27.1
release notes say so (*"the credential store is the only thing in your configuration tied to a specific
machine"*), and this dmg is ad-hoc signed (`CSC_IDENTITY_AUTO_DISCOVERY=false`). Every BYO card would then
be unusable for the whole sitting.

**It is not a standing incapacity. It is TRANSIENT, and the same card works minutes later.** The app was
launched at 13:25:24. Three switches onto the same `pi-api-key` card:

| time | since launch | result |
| --- | --- | --- |
| ~13:26 | ~1 min | `{"ok":false,"error":"HANDLER_ERROR", …}` — the message above |
| 13:33 | ~8 min | `{"ok":true, kind:"connection-same-runtime", model:"tgpt/deepseek-v4-flash-0731"}`, and the session then ran a real Pi turn with a `Bash` tool call |
| 14:11 | ~46 min (after a relaunch) | `{"ok":true, …}`, and the case's own file-tool control passed |

So what the sitting actually measured is a **first-access failure shortly after launch**, and its shape is
the dangerous one: the user is told their saved keys cannot be opened and that they should *enter the key
again*, when nothing is wrong with the keys at all. A user who follows that instruction re-enters a
credential they did not need to. Recorded as a **proposed row** with the three readings above; the cause was
not established here, and the honest next step is to reproduce it deliberately against a cold launch rather
than to name a mechanism.

The gateway cards were never affected: their auth is the shared `dp` JWT in `~/.nessy/dp_auth_creds.json`,
which is valid on this host until 2028-08-20, not `credentials.enc`.

## Three harness defects the sitting found before it measured a single product row

The first pass over the drives produced no product verdicts at all, and every one of its results was about
the harness. They are recorded here first because each of them reads, in the run output, as a statement
about the HOST — which is exactly how a sitting banks a wrong answer.

### 1. A family name where a `providerType` belongs — eight sites, six cases, every host

`RS-03` blocked with

```
cards: {"pi":["pi-api-key", … five], "claude":[]}
```

printed two lines above its own inventory of the same host, which lists `claude-gateway(claude-runtime)`,
`claude-custom(claude-runtime)` and `claude-custom-2(claude-runtime)`. The selector was
`connections.filter(row => row.providerType === 'claude')`, and no connection is ever stamped with the bare
family name: the values are `claude-runtime` / `anthropic` and `codex-runtime`. `lib/sitting.ts` says so in
its own words about the vocabulary it owns — *"`runtimes` carries the runtime FAMILY and nothing else …
never a providerType"* — and the Pi selector one line above each broken one was already written correctly as
`runtimeOf(row.providerType) === 'pi'`.

Eight sites over six files (`rs-03`, `rs-04`, `rs-07`, `rs-11`, `rs-12`, `rs-13`), plus a ninth in `rs-05`
spelled `pick(type => type === 'claude')` inside a lambda, which is why the first grep missed it. Fixed in
`a70944334` and `5b0b62729`. After the fix the same run prints
`cards: {"pi":"pi-api-key","claude":"claude-gateway","codex":"codex-gateway"}`.

**None of this would ever have failed loudly.** A case that blocks for want of a card looks exactly like a
host that has none, which is precisely what the sitting was about to write down.

### 2. A session the driver creates is bound to no card — seven cases

Measured directly, and it is worth stating as a fact about the product rather than about the harness: a
session created through the app's own New Chat path — which is what `freshSession()` drives — carries

```
+0ms    activeConnection=undefined model=undefined workingDirectory=undefined
+3000ms activeConnection=undefined model=undefined workingDirectory=undefined
+8000ms activeConnection=undefined model=undefined workingDirectory=undefined
```

It is not *unbound*: the resolution order is `session.llmConnection > workspace defaultLlmConnection >
global default` (`agent/backend/factory.ts`), so the session would run — the field simply is not stamped
until a card is picked or a turn runs. Seven sitting cases open with `const slug = await
activeConnection(...)` and BLOCK on **"this session is on no connection"**: RS-15, RS-20, RS-22, RS-27,
RS-28, RS-29, RS-30.

`5b0b62729` adds `boundCard()` and `NESSY_CDP_CARD=<slug>`: the card is named for one run, the case switches
the session onto it and reads the binding back through `waitForConnection`, so the case still records which
card **answered** rather than trusting the variable. Unset, behaviour is unchanged. That keeps the sitting's
own rule — *one card at a time, the operator's choice, named in the run notes*.

### 3. `/var` against `/private/var` — seven scratch repositories

With the card named, `RS-27` got as far as its own working-directory check and FAILED with

> the session is working in the scratch repository — it reports
> `/private/var/folders/…/nessy-rs27-repo-RXSzly` — **a worktree cut from the wrong tree would be measured
> here**

on a session that was working in exactly the right tree. `tmpdir()` answers `/var/folders/…` on macOS,
`/var` is a symlink to `/private/var`, and the app resolves the path before recording it. Fixed at creation
rather than at comparison in `ffcb484d7`, across all seven scratch roots, because these cases also compare
that path against transcripts and tool results.

## The fourth thing, which is not a defect and cannot be fixed from inside the harness

`Runtime.evaluate` is answered by the **renderer**, so its latency is the renderer's. On this box it
round-trips in ~160 ms when idle. The sitting ran at load averages between **11 and 52** — sibling lanes on
the same machine — and four cases died with

```
cdp-timeout: Runtime.evaluate did not answer in 30000ms
```

**after their own checks had passed**: RS-03 (98 s), RS-11 (50 s), RS-13 (39 s), RS-09. In each the last
thing recorded before the timeout was a live Pi turn — RS-09 got as far as
`steer: tools seen before the correction: {"names":["Bash"],"settled":1}` — so what timed out was a poll
issued while a turn was streaming.

`5b0b62729` adds `NESSY_CDP_TIMEOUT_MS`, defaulting to the same 30 s and refusing `0`, `-1`, `abc` and
`Infinity` rather than falling back to the default, because a knob that reads as set and behaves as unset
makes the next timeout unexplainable. **Every run below says which ceiling it used.** A raised ceiling does
not make the box quiet: it only stops the box being recorded as a product verdict.

## RS-03 (P6.91) half 1 — a measured verdict, and the only one a census can give

`RS-03`'s first half is a census of the operator's own persisted corpus, and it does not need a card. Run
twice on the packaged 1.36.0, 2026-09-11, minutes apart, against `~/.nessy-agent`:

| run | files read | bytes | `isThinking` rows | files with them | `isIntermediate` rows (control) |
| --- | --- | --- | --- | --- | --- |
| 13:32 | 844 | 15 076 469 | **23** | **15** | 2 320 |
| 13:50 | 853 | 15 087 536 | **23** | **15** | 2 323 |

Corpus dates 2026-07-27 → 2026-09-11. The case's own control passed — *the census reader parses the same
rows the corpus claim was made over* — and its verdict line is:

> **23 persisted reasoning rows across 15 files — the ledger `absent` is REFUTED and D3 moves to partial.**

The control matters because a reader that parsed nothing would report zero and look identical: 2 320
`isIntermediate` rows in 491 files is the proof the reader reads.

Half 2 (the Pi → claude crossing) is a separate reading and did not complete; see the case table.

## RS-31 (P6.1064) — the precondition re-derived, and it is still false

`RS-31` is a recipe whose own `runOnlyIf` says a run can only re-prove what the source already says, and
whose `doneMeans` allows exactly this outcome: *"the precondition re-checked at the then-pinned tag and
recorded as still false — which closes P6.1064 as a standing order with a dated reading, not as a pass"*.

Re-derived on 2026-09-11 against a fresh tarball of `openai/codex` at the tag
`packages/codex-protocol/manifest.json` pins, `rust-v0.150.1`:

```
grep -rn 'ExecApprovalKind::WriteStdin' codex-rs        →  0 occurrences, tests included
grep -rn 'ExecApprovalKind'             codex-rs        →  4, all of them below
```

```
codex-rs/protocol/src/approvals.rs:236   pub enum ExecApprovalKind {
codex-rs/protocol/src/approvals.rs:246       pub kind: ExecApprovalKind,
codex-rs/core/src/session/mod.rs:321     use codex_protocol::approvals::ExecApprovalKind;
codex-rs/core/src/session/mod.rs:2500        kind: ExecApprovalKind::Command,
```

and the declaration itself, verbatim:

```rust
/// Distinguishes a command approval from input sent to an existing terminal.
pub enum ExecApprovalKind {
    #[default]
    Command,
    WriteStdin,
}
```

So: the enum member is in the wire contract, the single production site that builds an
`ExecApprovalRequestEvent` writes `Command` as a literal, and `WriteStdin` is constructed nowhere in the
tree. `4ea562c6e` remains a forward guard for a field upstream tells clients to read, and RS-31 remains a
standing measurement order rather than a run to schedule. **Verdict: BLOCKED — precondition false at
`rust-v0.150.1`, re-derived 2026-09-11.** The other three `WriteStdin` families in the tree
(`ToolCallKind`, `TerminalOperationKind`, `TerminalRequest`, all under `rollout-trace/`) are a different
enum and are not this guard.

## The ten recipes

All ten printed their sheet on the packaged build, 2026-09-11 — `bun run scripts/cdp/cases/rs-<nn>.ts`,
exit 0 each, 3 392–5 277 bytes of JSON:

`RS-14` `RS-17` `RS-18` `RS-19` `RS-21` `RS-23` `RS-24` `RS-25` `RS-26` `RS-31`

A recipe printing its sheet is not a verdict, and the sheets say so themselves: each names a detector, a
positive control, and what `doneMeans`. Seven of the ten need a rig no single driver can stand up inside one
sitting — a logging egress proxy in front of the packaged build (`RS-21`, `RS-24`), a loopback recorder
(`RS-24`), a stub upstream that drops mid-response (`RS-19`), a fake `HOME` the app is launched with
(`RS-25`, `RS-26`), a credential the owner revokes and restores in its own system (`RS-14`'s sibling
`RS-06`), and a hundred-checkpoint retention run against a scratch repository (`RS-18`). `RS-31` is answered
above by its own precondition.

## RS-27 (P6.854) — PASS: claude's native `EnterWorktree` is offered, is called, and the host's cwd does not move

Packaged 1.36.0, 2026-09-11 14:03:34–14:05:34 (117 s), load average 18.65,
`NESSY_CDP_TIMEOUT_MS=180000`, `NESSY_CDP_CARD=claude-gateway`. **5/5 checks, PASS.**

| reading | value |
| --- | --- |
| card | `claude-gateway` — "Claude Code (Nessy Gateway)", `claude-runtime` |
| scratch repository | `/private/var/folders/…/nessy-rs27-repo-aEOyEP`, git-initialised by the case |
| trust gate | `not-shown` |
| cwd before | the scratch repository |
| **control** | a plain read request drew `["Read"]` — so an absent `EnterWorktree` below would have meant something |
| **probe** | `[{"tool":"EnterWorktree","status":"completed"}]` |
| cwd after | **unchanged** — still the scratch repository |

What the tool itself answered, verbatim from the transcript entry:

> Created worktree at `/private/var/folders/…/.nessy-worktrees/nessy-rs27-repo-aeoyep/worktree-mighty-gliding-galaxy`.
> The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be
> prompted.

So the answer to P6.854's question is **yes on a real session**: the SDK's own `EnterWorktree` is in the tool
set of a `claude-runtime` session on the shipped gateway card, the model reaches it, and it succeeds. The
second half is the one worth reading twice — **the host's recorded `workingDirectory` did not move.** The SDK
is working in the worktree and the session row still reports the repository it started in. The case records
that as `p2-108-retirement: not refuted by this run: the working directory did not move` rather than as a
failure, which is the right shape: it is a divergence between two views of "where is this session working",
and whether it matters is the owner's call, not a check's.

## RS-22 (P6.304) on claude — the question is ANSWERED, and the case still timed out

`RS-22` asks which producer draws the todo card on each runtime: the host's `TodoWrite`, or a runtime-native
one. On `claude-gateway`, packaged 1.36.0, 13:56:48–14:03:04 (372 s), the case ended
`FAIL (wait-timeout: a turn to complete (had 4 messages) still false after 300000ms; last value
{"count":13,"processing":true})` — but the transcript it left behind answers the row outright. Read back
from `getSessionMessages` afterwards, last eight rows:

```
assistant  "The user wants me to plan a three-step task … a running checklist of …"
tool       mcp__session__TodoWrite    Running mcp__session__TodoWrite…
tool       Bash                       Running Bash…
assistant  "I'll set up a running checklist, then execute each step and mark it off as I go."
assistant  "The folder was created. Let me mark step 1 as done and move to step 2."
tool       mcp__session__TodoWrite    Running mcp__session__TodoWrite…
assistant  "Step 1 done — folder created. Marking it off and adding the file."
tool       Write                      Running Write…
```

**The producer on claude is `mcp__session__TodoWrite` — the HOST's own session tool, reached through the
session MCP server**, called twice, interleaved with the work exactly as a checklist should be. There is no
runtime-native plan tool in the chain. The case's own control had already passed: a turn that asks for no
checklist drew `control-tools: []`, so nothing above can be attributed to anything but the checklist request.

### Why it timed out, which is a finding about the harness and not about the runtime

The last row is `Write`, *"Running Write…"*, and it never resolved. The screenshot the case saved at the
moment of the timeout shows the reason on screen: **two session rows in the sidebar are carrying an inline
`✓ Allow once   ✗ Deny` pair.** The turn was waiting on an approval nobody answered.

Six of the sitting cases DO set a posture — `grep -l setPermissionMode scripts/cdp/cases/rs-*.ts` answers
`rs-05`, `rs-11`, `rs-13`, `rs-14`, `rs-26`, `rs-30` — and six do not: **`rs-15`, `rs-20`, `rs-22`, `rs-27`,
`rs-28`, `rs-29`**. `agent-install.ts`, the one non-sitting case that drives mutating tools, opens with
`setPermissionMode(session, key.sessionId, 'bypassPermissions')`. `RS-27` survives only because its probe is
read-shaped (`compliance-tools: ["Read"]`); the first mutating tool in any of the other five stalls the turn
for the full wait and the case reports a timeout.

That is a **proposed row**, not a fix taken here: the posture a case runs under is part of what it measures,
and three cases changing posture mid-sitting would make this run incomparable with the next one.

## RS-28 (P6.839) — arm A measured, then the app's own 30 s IPC ceiling

Packaged 1.36.0, 14:05:36–14:08:06 (148 s), `claude-gateway`. Arm A completed and its control passed:

```
arm-a-repository: { attempted: true, hostSentence: false,
                    toolNames: ["EnterWorktree", "EnterWorktree"],
                    results: ["Created worktree at …/.nessy-worktrees/nessy-rs28-repo-sxicop/
                               worktree-glistening-painting-snowflake. The session is now working in the
                               worktree. …"] }
ok  THE CONTROL — against a real repository the host floor sentence does NOT appear
```

The case then died on `cdp-eval-threw: Error: Request timeout: sessions:command (30000ms)`, thrown by the
RENDERER (`app/dist/renderer/assets/main-*.js`) — the app's own RPC ceiling, not the harness's.

**This is P3.326's mechanism, alive on the packaged 1.36.0.** That row's own regression test states it in as
many words: *"the sessions projection was O(all sessions) with a per-session disk read, and a main process
spending seconds inside `getSessions()` cannot reply to `sessions:command` either"*. This host carries **853
session files** (RS-03's census read them all) and **50 rows in the sidebar**, and the sitting hit the same
30 s timeout **three times** — RS-28 and RS-29 on a connection switch at 13:55 and 13:56, RS-28 again here —
at load averages of 11 to 18, minutes after RS-27 had made the identical switch onto the identical card in
time. A user meets this as a card picker, or a session command, that fails with a timeout.

## CDX-150 — the integrity check PASSES, the turn never started

Packaged 1.36.0, 2026-09-11 14:10:39–14:11:14 (33 s), load 20.81. The first and most important check —
the one the 1.25.0 sev-1 exists for — passed against the shipped artifact:

```
codex-manifest:  { path: packages/codex-protocol/manifest.json, tag: "rust-v0.150.1" }
codex-binaries:  Contents/Resources/app/resources/bin/codex/darwin-arm64/codex-app-server
                 sha256 = 99ed12a1db8f479388178bd308e3411ed9c6b38b0ce2fafaee5a9390f5f9a1e9
                 pinned = 99ed12a1db8f479388178bd308e3411ed9c6b38b0ce2fafaee5a9390f5f9a1e9
ok  the shipped codex-app-server is the pinned rust-v0.150.1 binary
```

So **the binary a user installs is byte-for-byte the pinned `rust-v0.150.1`** — asked of the file inside the
packaged `.app`, not of the repo, which is the only form of that claim worth having.

The case then created its session and died on
`cdp-eval-threw: Error: Request timeout: sessions:command (30000ms)`, thrown by the renderer, before the turn
or the MCP call. **Verdict: FAIL on the rig, integrity check PASS; the turn and the
`mcp__sources__<wire>__<tool>` half are UNMEASURED and are owed a re-run on a quiet box.**

## The one reading that shaped the whole sitting: `sessions:command` times out at the app's own 30 s

Five occurrences on the packaged 1.36.0 in seventy-five minutes, every one of them on a connection switch or
a session command, at load averages of 11 to 21:

| time | case | where |
| --- | --- | --- |
| 13:55:52 | RS-28 | the switch onto `claude-gateway` |
| 13:56:46 | RS-29 | the switch onto `claude-gateway` |
| 14:08:06 | RS-28 | a session command after arm A had completed |
| 14:10:37 | RS-29 | the switch onto `claude-gateway` — and `boundCard` had waited a further 60 s for the binding to appear anyway |
| 14:11:14 | CDX-150 | before the first turn |

Against RS-27, which made the identical switch onto the identical card at 13:54 and again at 14:03, both
times in time. So it is intermittent rather than broken, and it is the app's own ceiling
(`packages/server-core/src/transport/client.ts` — *"Request timeout in ms. Default: 30_000"*) rather than the
harness's.

**P3.326 already named this mechanism**, and its regression test says so in as many words: *"the sessions
projection was O(all sessions) with a per-session disk read, and a main process spending seconds inside
`getSessions()` cannot reply to `sessions:command` either"*. This profile is a plausible worst case for it —
**853 session files** (RS-03's census read every one) and **50 rows in the sidebar** — and the sitting itself
added to that count, one session per case, which is the harness's documented habit
(`CDP <case> <time>`, *"so the operator can find the litter afterwards"*).

What a user meets is not a harness message: it is a card picker, or a command, that fails with a timeout on a
profile that has accumulated sessions. That is a **proposed row**, and the sharpest thing this sitting found
about the shipped build.

## RS-02 (P6.66) — the file tool IS refused; the Bash route was never attempted

Packaged 1.36.0, 14:11:16–14:14:32 (195 s), load 19.83, card `pi-api-key` (the switch succeeded this time —
see the credential note above). **6/8 checks, FAIL**, and the two failures are the same fact:

| probe | path | tool calls | refused |
| --- | --- | --- | --- |
| control — file tool | `~/.nessy-agent/config.json` | `Bash` completed | no ✔ (control) |
| control — shell | `~/.nessy-agent/config.json` | `Bash` completed | no ✔ (control) |
| control — shell on the ssh key | `~/.ssh/id_rsa` | **none** | — ✗ |
| **subject — file tool** | `~/.nessy-agent/credentials.enc` | `Read` → `error` | **YES** ✔ |
| subject — shell | `~/.nessy-agent/credentials.enc` | **none** | — ✗ |

**The positive half of P6.66 is measured and holds: the file tool is refused on the credential store** on the
shipped default, on a packaged build, with both "same directory" controls passing so the refusal is about the
FILE and not about the directory.

**The negative half was never attempted.** The model declined to issue `cat` for both the ssh control and the
subject — `toolCalls: []` in each — so no command reached the floor in either direction. The case's own
control said the run was uninterpretable, and then its verdict line said *"a route to the credential store
was not refused on a shipped default"*, which is a different and much more alarming claim about the same
zero. That gap is now closed in the case itself (`250e1bceb`): the leak verdict fires only when a route was
ATTEMPTED and came back unrefused, an unattempted probe gets `UNMEASURED — not a leak`, and the ssh control
names the model declining as its third outcome.

**So this run is NOT evidence of an open route.** It is one measured refusal, one unmeasured route, and a
detector that has been taught the difference.

## RS-22 (P6.304) — **PASS on codex**, and two of the three runtimes are now answered from one build

Packaged 1.36.0, 14:24:26–14:25:36 (68 s), load 10.10, `NESSY_CDP_CARD=codex-gateway`. **5/5 checks, PASS.**

```
runtime:       { card: "Codex (Nessy Gateway)", slug: "codex-gateway", providerType: "codex-runtime" }
control-tools: []
probe-tools:   [ update_plan(completed), Bash(completed), update_plan(completed), Bash(completed) ]
producers:     ["codex-update_plan"]
```

So the row's question — *the host `TodoWrite`, or codex's synthesised `update_plan`* — is answered for two
runtimes on one build, each with its own control turn drawing nothing:

| runtime | card | producer | evidence |
| --- | --- | --- | --- |
| claude | `claude-gateway` | **`mcp__session__TodoWrite`** — the host session tool | two calls, interleaved with `Bash` and `Write` |
| codex | `codex-gateway` | **`codex-update_plan`** — codex's own synthesised plan tool | two calls, interleaved with `Bash` |
| pi | — | unmeasured | the pi arm did not run in this sitting |

The codex arm also passed the case's own "drawn, not merely opened" check — the checklist was updated more
than once — while noting honestly that two calls is the floor for that reading.

## RS-20 (P6.284) — 5/5 checks, then a modal covered the send button

Packaged 1.36.0, 14:21:37–14:23:47 (126 s), `claude-gateway`. Five checks passed and the case then ended

```
FAIL  click refused: button[data-tutorial="send-button"] at (1342,827) is covered by
      DIV.fixed inset-0 z-modal flex items-center justify-center bg-black/45
```

That is `lib/viewport.ts` doing exactly what it exists for — the README records the run that clicked a
palette row at y=1006 in a 900 px window, where CDP dispatched the click happily and it landed nowhere. Here
the guard named the element on top. **A modal was open over the composer at the moment the case tried to send
its second turn**, which on this sitting's evidence is most likely the approval dialog family (see RS-22's
sidebar `Allow once / Deny` pair); the case does not identify it and neither does this narrative. The
interrupt half of P6.284 is therefore **unmeasured**, and the re-run wants a permission posture set first.

## RS-15 (P6.226) — BLOCKED on the same missing field, one layer further in

`claude-gateway`, 14:23:49 (34 s): `the session reports no working directory, so "inside" and "outside" have
no meaning on this rig`. `boundCard` had given the session its card, but a session created through New Chat
also carries `workingDirectory: undefined` (measured above), and RS-15 is entirely about inside-vs-outside a
workspace. It needs `setWorkingDirectory` the way RS-27 and RS-28 already call it — a **proposed row**, not a
change taken mid-sitting, for the same reason as the permission posture.

## QL9 — **PASS**: a plugin installed through the product's own path reaches a claude session AND a codex session

The owner answered QL9 on 2026-09-11 with *installing a plugin must work on both*. Driven on the packaged
1.36.0 at 14:52–15:05 by the new case `scripts/cdp/cases/plugin-install-runtimes.ts`, through
`marketplace.addRegistry` → `marketplace.install` — the exact calls the Plugins page makes, not the agent's
`plugin_plan_install` tools (that channel is `AGENT-INSTALL`, and it exists because the two diverged twice).
**7/7 checks, PASS.**

### What the user sees when the install succeeds

```json
{ "ok": true,
  "pluginKey": "cmVnaXN0cnktZjljYWQxMzEt….Y2RwLWVjaG8tcHJvYmU",
  "diagnosticCodes": [],
  "state": "supported",
  "deferred": [],
  "runtimeRefresh": "deferred" }
```

No diagnostics, nothing deferred, compatibility `supported`, and the plugin on disk immediately:
`installed = cdp-echo-probe, claude-security, figma, linear`. The record carries one capability, `mcp`, whose
server name is the **logical** `echo` rather than any minted wire name.

### The reach, per runtime — the half QL9 is actually about

| runtime | card | the name the model saw | called | the server's own nonce back |
| --- | --- | --- | --- | --- |
| **claude** | `claude-gateway` | `mcp__plugin_cdp-echo-probe_echo__whoami` | **yes** | **yes** |
| **codex** | `codex-gateway` | `mcp__sources__plugin_cdp-echo-probe_echo__whoami` | **yes** | **yes** |

Two different model-facing names for one tool, each correct for its runtime — codex consumes the whole pool
through one `[mcp_servers.sources]` bridge, so its name carries the extra `sources` segment. Both sessions
found the tool and called it, and the reply carried the probe's own per-call nonce, which exists in no file.

### And it put the profile back

`plugins claude-security,figma,linear → claude-security,figma,linear; registries 5 → 5`. The uninstall keys
on the `pluginKey` the product itself wrote, never a reconstructed one, and the whole teardown runs in a
`finally` so a failed assertion still restores the operator's profile.

### Two detector bugs on the way, both diagnosed by the product's own error text

The case failed twice before this, and neither failure was the product's:

1. `marketplace.list({ kind: 'plugins' })` without `page`/`pageSize` returns an empty `items`, and the case
   announced *"an EMPTY catalog means the registry root has no marketplace.json"* about a fixture that was
   fine.
2. A registry listing id is `<marketplaceId>:<name>`, and the bare name came back with

   > Marketplace listing "cdp-echo-probe" is not in the catalog of marketplace "registry-…". Registry listing
   > ids are `"<marketplaceId>:<name>"`; if this id has no prefix it did not come from that catalog.

That second message is worth keeping as a product note in its own right: **an error that names the shape it
wanted turned an afternoon into one run.** Both fixes are in `8a428a1b3`, with the quote at the call site.

## One number beside the `sessions:command` finding, and what it does NOT prove

Taken at the end of the sitting with the app idle, load average 9.83, five consecutive readings from inside
the renderer:

| call | ms |
| --- | --- |
| `electronAPI.getSessions()` | **541, 508, 546, 528, 516** |
| `electronAPI.listLlmConnections()` (the comparable projection) | 5, 3, 2, 6, 15 |

So on this profile — **853 session files**, 50 sidebar rows — the sessions projection costs about **half a
second per call at rest**, against single-digit milliseconds for a projection of the same shape. That is the
cost P3.326 named, still being paid.

**It does not by itself explain a 30 s timeout**, and saying so is the point: half a second is not thirty
seconds, and a run that quoted this number as the cause would be inventing a mechanism. What it establishes
is that the expensive call is expensive here and that the switch path awaits several of them; the causal
claim needs the timeout reproduced against a profile with few sessions, which is a **proposed row** rather
than a reading this sitting took.


---

# Pass 2 — the same build, a profile created for the run (lane W14-sit2)

Pass 1 measured a handful of rows and spent the rest of itself on four harness defects and on this host's
own profile. Pass 2 changes exactly two things, and both of them are the reason it got further.

## What is different

**The build is the THIRD 1.36.0 dmg**, built 2026-09-11 15:09–15:12 at HEAD `152f4035e`, carrying P6.1107:
`grep -c UV_NATIVE_TLS "release/mac-arm64/Nessy Desktop.app/Contents/Resources/app/dist/main.cjs"` → **2**.
The three commits between that HEAD and the tree this pass ran from are documentation only (the checklist
and the plan), so the artefact is current for every code claim below. CDP answered
`NessyDesktop/1.36.0 Chrome/142.0.7444.235 Electron/39.2.7`, one page target.

**The profile is FRESH** — `NESSY_CONFIG_DIR` pointed at a directory created for the run under the lane's
scratchpad, never under `~`. That is what pass 1's PR-1 asked for: `getSessions()` costs half a second on a
profile with 853 session files, and five `sessions:command` replies exceeded the app's own 30 s ceiling.
**On this profile not one call timed out.** The dp credential lives outside the config dir
(`~/.nessy/dp_auth_creds.json`) and was neither read, copied nor written by anything here.

Per-command CDP ceiling: `NESSY_CDP_TIMEOUT_MS=90000` (default 30 000), stated because pass 1's F3 measured
four cases dying at 30 s **after their own checks had passed**. Load average 6.7–8.6 throughout, quoted per
case in the run index.

## What a FRESH profile costs, which nobody had measured

A profile created for the run is not the same app with fewer files in it. Four things are different on the
first boot, and three of them stopped a case dead before any of them stopped a measurement:

1. **There are no connections at all.** The app opens on *"Welcome to Nessy Desktop — How would you like to
   connect?"* with five buttons, and `listLlmConnections()` answers `[]`. That is the surface RS-32 is about.
2. **The new-user path does not end at the card.** After the one-click sign-in the app stays on the
   onboarding until *"Get Started"* is pressed, and while it is there the chat shell does not exist:
   `freshSession()` dispatched its navigate event into a renderer with no shell to hear it, created nothing,
   and fell through to `activeSession()`, which threw `no-sessions` — on a profile that by definition has
   none. The case died reporting a missing precondition it was in the middle of creating.
3. **There are no sessions**, so there is no composer and no session row to wait for. The first version of
   RS-32's shell check asserted both and scored FAIL on a run whose every later step worked.
4. **The trust gate fires for every directory.** Binding a session to a scratch directory holding one
   `README.md` raises *"Trust this project?"*, the modal owns the screen, and the next keystroke dies with
   `composer-not-focusable` — a message that says nothing about a dialog. RS-15 failed that way three times
   in a row, the first run's stale modal blocking the two after it. On the operator's long-lived profile the
   gate is usually silent because a decision already exists, which is exactly why this had never been seen.

All four are harness-side and all four are fixed in this pass (`f8cce4b11`, `4d65c0f57`, `6d7f52595`).
`trustScratchProject(session, dir)` is the one worth reading twice: it answers the gate only for a directory
the case itself minted, under two guards that are refused loudly — the directory must be under the OS temp
dir realpathed, and the DIALOG's own path must equal it. It can never become a "make the dialog go away"
helper pointed at one of the owner's repositories.

## The three cards, created through the product's own path

The sitting needs one card per runtime and a fresh profile has none. They were created by clicking, not by
writing config: the onboarding's own *"Nessy · Pi agent"* button, then Settings → AI → **+ Add Connection**
→ *"Nessy · Claude Code agent"*, then the same for *"Nessy · Codex agent"*.

| slug | providerType | seeded defaultModel |
| --- | --- | --- |
| `pi-api-key` | `pi_compat` | `tgpt/deepseek-v4-flash-0731` |
| `claude-gateway` | `claude-runtime` | `tgpt/deepseek-v4-flash-0731` |
| `codex-gateway` | `codex-runtime` | `tgpt/deepseek-v4-flash-0731` |

All three seed the id behind the `coder` alias. None seeds the retired `tgpt/qwen35-397b-a17b-fp8`.

## RS-32 (P6.1080) — PASS, 8/8. The one-click card a new user gets, and its first turn

Written in this pass, because P6.1080's release-critical defect is a **seed** and no unit test can reach it:
`ModelRefreshService._doRefresh` has already repaired every existing profile on every machine, so the claim
*a user who clicks the card today gets a model the gateway still serves* is only visible on a profile that
has never been repaired.

The run pressed the onboarding's own *"Nessy · Pi agent"* button and then read the app's own record of what
it had seeded:

```
card: {"slug":"pi-api-key","name":"Nessy Backend (API Key)","providerType":"pi_compat",
       "defaultModel":"tgpt/deepseek-v4-flash-0731",
       "models":["tgpt/deepseek-v4-flash-0731","tgpt/qwen36-35b-a3b-fp8"]}
first-turn: {"added":2,"answer":"ready"}
```

**The seed is the id behind the `coder` alias, and the first turn answers.** P6.1080's defect 1 is fixed in
the shipped artefact, measured on the only kind of profile that can see it.

### The negative control, and the third outcome it found

"A turn answered" is worthless alone — it is equally true of a rig that cannot see a failing turn. So a
second session on the same card was pointed at the retired id and asked the same question. It answered
`ready`, normally. That is **not** the gateway serving a retired model, and the first draft of this case
scored it FAIL for exactly that misreading. The runtime's own session file settles it:

| source | what it says |
| --- | --- |
| the app's session record (`session.jsonl`) | `"model":"tgpt/qwen35-397b-a17b-fp8"` |
| the Pi SDK's own sidecar (`.pi-sessions/*.jsonl`), first line | `{"type":"model_change",…,"modelId":"tgpt/deepseek-v4-flash-0731"}` |
| the transcript | **0** info rows about it |

The two disagree **by design**: `resolveModelForProvider` clears a session model the refreshed catalogue no
longer lists. So the retired id never reaches the wire, the 404 is unreachable from the product's own
surface, and the fallback P6.1080 built is working.

**And it is silent, at a scope P6.1080's notice does not cover.** `announceModelDefaultSubstitution` fires
for a substituted CONNECTION default; a substituted SESSION model is a different path and says nothing, which
its own docblock states: *"`resolveModelForProvider` then CLEARS the session's own stale model … so by the
time `warnIfModelIdUnrecognized` reads `resolvedModel` it is holding the NEW id, which is in the catalogue,
and P6.362's diagnostic correctly says nothing."* The user-visible consequence was on screen throughout: the
composer footer read **`Tgpt/qwen35 397b.a17b.fp8`** while `deepseek-v4-flash-0731` was answering. A user
reopening a session created before a model rotation is told nothing and shown the wrong name. Proposed row
**PR-8** below.

## RS-15 (P6.226) — MEASURED on all three. The answer is the same on all three, and it is not "refused"

The row's denominator cell A70 stood at `pi unknown / claude unknown / codex unknown`. Three runs, one per
card, each in a session bound through `NESSY_CDP_CARD` and working in a scratch directory the case minted:

| card | control (write INSIDE) | probe (write OUTSIDE) | cards raised | file landed |
| --- | --- | --- | --- | --- |
| `pi-api-key` | `Write` completed, no card | `Write` completed | **1** | yes |
| `claude-gateway` | `Write` completed, no card | `Write` completed | **1** | yes |
| `codex-gateway` | `Edit` completed, no card | `Edit` completed | **1** | yes |

**On every runtime the out-of-workspace write is not refused — the user is ASKED, and an approval is
enough.** Under `acceptEdits` the control write inside the session roots is silent, which is what makes the
single card on the probe meaningful: it is raised by the path being outside, not by the write being a write.

The verbatim text, which is what the row asked for:

- **pi** — `Successfully wrote 19 bytes to /private/var/folders/…/nessy-rs15-outside-….txt`, no info rows.
- **claude** — `File created successfully at: …`. The only info row is unrelated
  (`claude-webfetch-preflight-disabled`).
- **codex** — the tool answered `Exit code: 0 … Success. Updated the following files: A /private/var/…`, and
  the session's own info rows say the sandbox is NOT what the config asked for:

  > Codex IS NOT RUNNING UNDER THE SANDBOX MODE THIS APP ASKED FOR. The config written for this session says
  > `sandbox_mode = "danger-full-access"`, and codex resolved a sandbox policy of `"workspaceWrite"` instead
  > — the resolved policy is the one being enforced.

  So the row's premise (*"our codex profile parent is `:workspace` … so an out-of-workspace write is
  correctly refused"*) is **refuted on the shipped build**: codex resolves `workspaceWrite` and the write
  outside the workspace still lands, once the user approves. The approval is the escalation.

A fourth reading came free: the codex session also reports
`Codex: Model metadata for `tgpt/deepseek-v4-flash-0731` not found. Defaulting to fallback metadata`, for
the model the fresh one-click card seeds — and the next info row says that warning is a known constant here.

## RS-20 (P6.284) — pi PASS, codex PASS on the half it has an instrument for, claude re-run after a detector fix

The row is `have` on all three by code read and was unmeasured live.

**pi — PASS, the whole chain.** The interrupt row rendered (`Response interrupted`), the marked processes
went **1 → 0**, and the SUCCESSOR's own runtime session file gained an interrupted-reminder **0 → 1**. Both
controls held: two ordinary turns stamped nothing, and with no turn in flight the composer offers no Stop
affordance to press.

**codex — PASS on what it can be asked.** Interrupt row rendered, marked processes 1 → 0. The successor half
is recorded UNMEASURED with its reason in the case's own words — *"the decoration rides the effective model
message and is deliberately not stored in our transcript, and this harness has a runtime session reader for
pi and claude only"* — never as absent.

**claude — the first run's FAIL was the DETECTOR, not the product**, and the miss is worth recording because
it is the shape this harness exists to prevent. `readClaudeSessionLog`'s docblock says the SDK's
`projects/<slug>` directory ENDS with the session id, and on a `~/.nessy-agent` profile it does. Under a long
config path it does not — the slug is CUT mid-session-id and a short suffix appended:

```
…-sessions-e8e9c3d1-…-fb7b739fb291-45c4e24a-3567-4730-b-is5c1n     for session 45c4e24a-3567-4730-b…
```

so `endsWith` could never match, the narrowed read returned nothing, and the case reported *"on anthropic the
successor is not told"* against a transcript that was on disk the whole time. `directoryIsFor` now takes the
exact suffix first and otherwise a prefix of at least 12 characters, and says which rule matched. Verified on
this run's own profile: 44 and 31 entries for the two claude sessions, 0 for a session id that exists nowhere.

## RS-27 (P6.854) — PASS, 5/5, and P2.108's retirement stands

Re-confirmed on the fresh profile with a posture and with zero permission cards raised:

> Created worktree at …/.nessy-worktrees/nessy-rs27-repo-slccam/worktree-pure-booping-wozniak. **The session
> is now working in the worktree.** Use ExitWorktree to leave mid-session…

and `cwd-after` equals `cwd-before` — the host session's recorded working directory did **not** move. That is
pass 1's PR-5 reproduced on a second rig and a second profile: two views of "where is this session working"
that disagree, one of them the user's.

## RS-28 (P6.839's residual) — the first run's verdict was WRONG, and the cause is RS-27's finding

Arm A behaved: `EnterWorktree` against a real repository, no host floor sentence, control green. Arm B, which
is the discriminator, re-pointed the SAME session at a directory that is not a repository — and the tool
succeeded, creating `worktree-plain-worktree` **inside arm A's own repository namespace**
(`.nessy-worktrees/nessy-rs28-repo-…/`) while the host session's working directory reported the plain dir.

Re-pointing a session does not take its repository away, because the worktree moved the SDK's working
directory and not the host's — RS-27's finding, met from the other side. The run scored *"the host floor
never saw the call, so the SDK owns this tool end to end"* against a call the floor would have **allowed**.
Arm B now runs in a session of its own, with `fresh` and `same card` as required checks rather than
assumptions.

## RS-29 (P6.851) — MEASURED: this build creates no file checkpoints on a claude session

```
rewind-result: { success: true, fileCheckpointsTracked: false, restoredCheckpoints: 0 }
```

The field that decides what the count MEANS was read first, which is why this is a reading and not a bug
report: `fileCheckpointsTracked=false` means *nothing COULD be restored*, not *nothing needed restoring*. Both
turns had landed — the agent created `probe.txt` and then edited it — and the rewind reported success with
nothing to restore. Record the cell as **the producer being off on this build** (P6.851 enables it behind
`fileCheckpointingEnabled`), never as a broken restore.

### RS-28, second run — the verdict survives, and the host is in the path by a DIFFERENT road

With arm B in a session of its own, in a directory that is not a repository, `EnterWorktree` was attempted
and refused — and the refusal is **not** our floor's sentence:

> `WorktreeCreate hook failed: hook succeeded but returned no worktree path (command: echo the path to
> stdout; http/callback: return hookSpecificOutput.worktreePath)`

So the answer to P6.839's residual is **NOT routed**: the SDK does not put its native `EnterWorktree` through
our `canUseTool`, and the words the user meets are the runtime's. What the run adds is that the host is in
this path anyway, through a **`WorktreeCreate` hook** rather than through the permission floor — and the
sentence the user is left with when that hook cannot answer is a hook-authoring instruction addressed to
nobody in the product. Proposed row **PR-9**.

## RS-22 (P6.304) — MEASURED on all three, and the row's map is WRONG for pi

| card | producer | tool names seen | calls | surface |
| --- | --- | --- | --- | --- |
| `pi-api-key` | **`task-tools`** | `TaskCreate` ×3, `TaskUpdate` ×6 | 9 | `TaskChecklistPanel` (`extractChecklistFromActivities`) |
| `claude-gateway` | `todo-write` | `mcp__session__TodoWrite` | 4 | `TodoListCard` (`isPlanWritingTool`) |
| `codex-gateway` | `codex-update_plan` | `update_plan` | 2 | `TodoListCard` (`isPlanWritingTool`) |

Every control held: a turn that asks for no checklist drew no plan-writing tool on any card.

**The row's native-mechanism clause says *"Pi — host registry `TodoWrite`"*, and on the shipped build pi does
not call `TodoWrite` at all.** It reaches for the Task tools, which `isPlanWritingTool` does not match — so
the case scored "no producer on pi" twice before it learned the fourth vocabulary, once for the described
task and once when the capability was named outright. There are **FOUR producers and TWO cards**, not three
and one: `TodoListCard` mounts on `isPlanWritingTool`, and `TaskCreate`/`TaskUpdate` feed `TaskChecklistPanel`
through `extractChecklistFromActivities`. The cell has to name the producer AND the surface.

## RS-02 (P6.66) — the Bash route is MEASURED now, and it is refused

Pass 1 recorded `toolCalls: []` — the model issued no command at all — and the case declared every reading
below it uninterpretable. On the fresh profile, with the same prompts, the routes ran:

| arm | path | tool | outcome |
| --- | --- | --- | --- |
| THE CONTROL | `<config>/config.json` | `Bash` | completed — the shell route works on this rig |
| subject | `<config>/credentials.enc` | `Read` | **refused** by the floor |
| subject | `<config>/credentials.enc` | `Bash` | **refused** by the floor |

So on pi both routes to the credential store are closed, and the control proves the shell route is open for
an ordinary file in the same directory — which is what makes the two refusals mean something.

**One control is still not established**, and the case says so rather than banking it: asked to read
`~/.ssh/id_rsa` through a shell command, the model issued no command at all. That is *"a reading about the
MODEL declining, never about a route being open"*, and the ssh arm stays unmeasured.

## RS-03 (P6.121) — PASS. The Pi → claude crossing, the half pass 1 never reached

```
previewRuntimeSwitch pi → claude-gateway: { kind: "connection-cross-runtime",
  hasHistory: true, historyCarry: "native", historyCarryReason: "fits" }
switch result:                            { contextCarried: "handoff", from: "pi", to: "anthropic" }
```

The server chose the **native** tier, the control held — an ordinary assistant line crossed and the model
quoted it back — and the reasoning carried. The `text` tier is deliberately not reachable here (it needs a
history that does not fit, which is the case's own `manual` arm).

## CDX-150 — BLOCKED on a precondition a fresh profile cannot have

The turn half needs the `elicit-probe` MCP source installed through the app's own marketplace flow, and a
profile created for the run has no sources at all. The app said so itself, which is the honest half:

> The tool `mcp__sources__elicit-probe__whoami` is not available — no source with slug `elicit-probe` is
> configured (**Active sources: none**), and the tool is not present in the current toolset.

The case scores that FAIL rather than BLOCKED, which is a case defect and not a product one — recorded as a
proposed row rather than fixed here, because the precondition is a plugin install and the harness's standing
rule keeps those out of a case. The integrity half of CDX-150 was already PASS in pass 1 against the same
artefact (`codex-app-server` darwin-arm64 sha256 matching the `rust-v0.150.1` pin).

## RS-05 (P6.226 sitting) — the pi arm is measured; the claude arm still cannot type

The precondition that blocked this case in pass 1 — three runtimes in one run — is satisfied on this profile.
The pi arm ran end to end:

```
pi — /rewind:                       open, 3 prompt options listed
pi — Esc Esc (empty composer):      open        (the menu is reachable both ways)
pi — Esc Esc (composer holds text): menu opened, composer still holds "A draft nobody sent"
pi — restore-files button:          not offered on this anchor
pi — toast:                         []
```

The claude arm dies with `composer-not-focusable` immediately after `the session reports claude-gateway`,
twice. The first time the cause was this case's own `closeMenu` leaving the rewind dialog up — fixed, and the
pi arm now records `menu at the end of the arm: closed` — and the second time it is something else. Recorded
as a proposed row rather than guessed at: the screen has to be read at that moment before a cause is named.

## RS-30 (P6.1052) — PASS. The classifier note arrives, and it arrives FRAMED

The precondition was created by the fixture against the run's own config dir —
`bun run scripts/cdp/fixtures/agent-surfaces.ts --config-dir <the run's dir>` — which printed the note to
export. The reading, off the Agent SDK's own transcript:

```
framing: { hostFrame: 1, note: 1, framedTogether: 1 }
classifier-verdict: no permission card — the classifier decided the call by itself, with the framed note in its context
```

Both halves hold: the note reached the runtime **inside the host's frame**, and there is **no bare copy of
the operator's sentence** beside it. P7.14's last hop — the one that runs inside the vendored `claude` binary
and no unit test can reach — is measured on a live session.

The hook was then removed with the teardown this pass added:

```
$ bun run scripts/cdp/fixtures/agent-surfaces.ts --remove-hooks --config-dir <the run's dir>
Removed 3 CDP hook(s) … RS-30's PostToolUse hook carries no matcher, so this is the end of the sitting for it.
```

## RS-11 (P6.194) — the control is alive now, and the case died on a vanished session

The fix landed and is visible in the run's own observations: every arm now reports
`the session posture this arm starts from: {"asked":"default","outcome":"set"}` and
`the app's own resolved permission mode: default`, where the first run reported `auto` in all nine.

The run then died in the third pi arm with `session-not-found: 989cad44-…` — the app had deleted the session
between `setPermissionMode` and the resolved-mode read (that arm's resolved mode reads `(none reported)`).
The README already names the mechanism for a session leaving the visible set while
`!lastFinalMessageId && !name && !isProcessing`, and `freshSession()` names its sessions precisely to be
ineligible for it, so this is a second route into the same sweep rather than the documented one. Recorded as
a proposed row with the evidence; the row's own verdict is still unmeasured on all three runtimes.
