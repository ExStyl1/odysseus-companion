# 2026-09-18 — measure sitting 5e (WAVE I-7, lane SIT-5e) on the packaged 1.40.0, CLEAN environment

The tail of the `measure:` list from `D1.64` onward — the point measure sitting 5c named as the next start
(`docs/testing/cdp-runs/2026-09-18-measure-sitting-5c.md` §11). A sibling lane (SIT-5d) ran at the same time on
ports 9232–9241 and owns `scripts/cdp/lib/**`; this lane owns **9252–9261** and checklist ids **RS-78…RS-85**, and
touched no lib file.

**Build under test.** `release/mac-arm64/Nessy Desktop.app`, **1.40.0** (`CFBundleShortVersionString` reads
`1.40.0`), built by the controller from `61cfc4659`. Never rebuilt, never removed. The repository tree carried
another lane's uncommitted edits under `packages/**` throughout this sitting; none of them is in the artefact,
which is why every reading here is taken off the packaged app and never off the source.

**Rig.** Port **9252**, proven free with `lsof` before launch (SIT-5c had exited and freed it).
`NESSY_CONFIG_DIR` and `--user-data-dir` under this lane's scratchpad, created for the run and never under `~`.
The owner's profile was never launched; `dp auth login` / `logout` were never run; no token was read, printed or
committed. `NESSY_DEBUG=1` and `NESSY_PROXY_AUTH_DEBUG=1` on every launch. Every launch used the `env -u`
launcher from `scripts/cdp/README.md` with all thirteen names deleted, and the CASE process got the same
treatment.

**The rig precondition.** `RS-32` **PASS 8/8**, 20 256 ms — the one-click Pi card seeding
`tgpt/deepseek-v4-flash-0731` (the `coder` alias), its first turn answering `ready`, and the retired-id control
showing the host substituting the live id before the call with 0 info rows. The codex and claude gateway cards
were then created by pressing the product's own one-click buttons, off-case
(`codex-gateway`, `claude-gateway`, both `isAuthenticated: true`).

**One fixture ran before the cases**, against this lane's own config dir:
`scripts/cdp/fixtures/agent-surfaces.ts --config-dir <rig>/config`, which wrote the marker output style
(`custom:cdp-marker`, marker `CDP-OSTYLE-4521C186E9`), the four named agents and `MEMORY.md`. **Its `hooks.json`
was parked** (`hooks.json` → `hooks.json.parked`) before any case ran: the `UserPromptSubmit` hook it writes
injects a codeword into EVERY prompt, which would have been a second, unstated needle inside every composed
prompt this sitting reads.

---

## 0. The clean-environment control, printed once per run

The derivation re-run at HEAD in its boundary-aware form, never a copied list:

```sh
env | cut -d= -f1 | grep -E '^(CLAUDE|ANTHROPIC|NESSY|CODEX|PI|OTEL|DISABLE|MAX_|BASH_|MCP)' | sort |
  while read -r n; do
    c=$(git grep -aclP "(?<![A-Za-z0-9_])$n(?![A-Za-z0-9_])" -- packages apps | wc -l)
    [ "$c" -ne 0 ] && echo "$n -> $c file(s)"
  done
```

**Thirteen** names over a 31-name candidate set, membership and counts identical to sittings 4 and 5c's:
`ANTHROPIC_BASE_URL` 51, `CLAUDE_EFFORT` 19, `CLAUDE_CODE_DISABLE_CRON` 12, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`
11, `CLAUDE_CODE_SUBAGENT_MODEL` 10, `DISABLE_AUTOUPDATER` 5, `CLAUDE_CODE_EXECPATH` 4,
`CLAUDE_CODE_OAUTH_SCOPES` 2, `CLAUDECODE` 2, `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` 1,
`CLAUDE_CODE_MESSAGING_SOCKET` 1, `CLAUDE_CODE_MESSAGING_TOKEN` 1, `MCP_CONNECTION_NONBLOCKING` 1 (the entry
`app-env.ts` records at `files: 0` and deliberately does not block on).

**The app's own read-back**, through `ps eww` on the RUNNING app, taken both ways because SIT-5c's hand-off says
`appProcessPids()` is over-wide while more than one sitting runs:

| scope | reading |
| --- | --- |
| every `MacOS/Nessy Desktop` process on the machine (12 pids) | `{"pids":12,"present":{},"controlSeen":true}` |
| scoped to this lane's own `--user-data-dir` (4 pids) | `{"pids":4,"present":{},"controlSeen":true}` |

Clean either way, with `NESSY_CONFIG_DIR` seen in the same read as the positive control. Every case in this
sitting printed the wide reading itself; by the time the cases ran the other sittings had exited and it answered
4 pids.

---

## 1. D1.64, the OUTPUT-STYLE half (L46) — a fork inherits the session style, a named subagent does not, and on two runtimes there is no fork to ask (case `RS-78`)

### Where the row stood

Measure sitting 5c left D1.64 with its L48 (prompt-cache) half measured as having no subject on a gateway claude
card, and its L46 half *"drivable and not reached"*. L46's verdicts are pi `have` / claude **`partial`** / codex
`have`; the rule under test is one shared host function,
`resolveChildOutputStyleId(childKind, sessionStyleId)` (`packages/shared/src/agent/child-session-scope.ts`) —
`named` → `undefined`, `fork` and top-level → the session's style — pinned by a unit test on all three arms and
never driven against an artefact.

### The detector, and why it is a file and not an answer

A child is a SESSION of its own here: spawning one creates
`<config>/sessions/<workspace>/<child sessionId>/`, and the runtime writes that session's own composed prompt
into `.pi-sessions/*.jsonl` there (claude's lands in the SDK's own transcript under
`<workspace>/claude-config/projects/…`, which `readClaudeSessionLog` keys by session id). Two needles, different
strengths: the host's own per-turn restatement `… output style is active` (`PromptBuilder
.buildOutputStyleReminder`, fed from the SAME child-kind-guarded resolution) and the fixture style body's own
random token, which proves the style PROSE reached the prompt rather than only a label. The positive control is
the session preamble (`session_state`) in the same file — without it, "no reminder" and "an unwritten file" are
one reading.

### What the first drive found instead, and why the case was rewritten twice

**`lib/fork.ts`'s `startFork` cannot be used on a packaged build beside a non-pi card.** Its baseline read goes
through `getPiHarnessRuntime`, which throws `pi-harness-runtime-invalid` once a session has run a turn — RS-56
(D1.260) is the case that measured it, and `requireReadablePiRuntime` correctly refuses to read the throw as an
empty child list. The pi arm had already answered when the codex arm hit that guard and BLOCKED the whole case.
So the spawn detector became the appearance of the CHILD'S OWN SESSION DIRECTORY, one layer below the snapshot,
and `piRuntime()` is now read as an observation only. It answered `read-threw: pi-harness-runtime-invalid` on
both non-pi arms of the final run, which is that defect reproducing.

**`/subtask` is a PI-ONLY palette entry on this build.** The second drive threw `palette-did-not-open` on codex
and on claude. Probed directly in the product's own palette, in sessions that had each already run a turn:

| card | palette entries | `subtask` offered | other differences in the same read |
| --- | --- | --- | --- |
| `pi-api-key` | **113** | **yes** — *"Subtask — Fork this conversation into a background agent that inherits it"* | has `Quota` |
| `claude-gateway` | 111 | no | no `Quota`, no `Approve` |
| `codex-gateway` | 111 | no | has `Approve — Overrule a Codex auto-review guardian denial` |

The `Quota`/`Approve` differences in the same read are what make this a runtime-scoped palette rather than a
mis-read. So the case now ASKS the palette before typing, and where no fork is offered the fork clause of L46 is
a measured NULL with that sentence.

### The reading — `RS-78` **PASS 11/11**, 482 127 ms at load 8.48

| arm | parent's own prompt | fork | named subagent |
| --- | --- | --- | --- |
| **pi** (`pi-api-key`) | reminder **1**, marker **3**, preamble 2 | its own session, reminder **2**, marker **5**, preamble 4 | its own session, reminder **0**, marker **0**, preamble present |
| **claude** (`claude-gateway`) | reminder **2**, marker **4**, preamble 4, over 25 042 bytes of the SDK's own transcript | **no fork offered** | ran (`Agent`) and minted **no host session** — 0 files |
| **codex** (`codex-gateway`) | **no composed prompt on disk** — 1 file, 3 989 bytes, preamble **0** | **no fork offered** | ran (`spawn_agent`, `wait_agent`) and minted no host session |
| **control, no style** (pi) | reminder 0, marker 0 | reminder **0**, marker **0**, preamble 4 | — |

**What L46 now has, per runtime.** On **pi** both halves are driven and the discrimination is complete: the
fork's prompt carries the style and the named subagent's does not, with the row's own no-style control clearing
both needles. On **claude** the style demonstrably reaches a top-level session's composed prompt — which is new,
and it is the half the `partial` verdict was about — while the fork clause has no subject (no `/subtask`) and the
named clause has no readable subject (the SDK's `Agent` tool mints no host session, so there is no child prompt
store). On **codex** neither clause has a subject on the artefact: no fork, and no composed prompt written
anywhere this rig can read.

**The style-marker hits on the codex parent are the MODEL'S REPLIES, not a prompt.** The fourth drive read
`marker: 2` there with `preamble: 0` — the only file under a codex session directory is the HOST's own
`session.jsonl`, and the token in it is the assistant obeying the style. The case says so in its own observation
rather than banking it: it is a weaker and different fact, and scoring it as the row's observable would have
turned "the runtime writes no prompt here" into "the style reached the prompt".

---

## 2. D1.81 — Stop does not stop a claude turn while a message is queued behind it (case `RS-81`, **FAIL 14 of 16**, 238 864 ms at load 12.93 — and the two FAILs are the product)

### What the artefact says before anything is driven

Both halves of the seam ship, and both were read off the packaged app rather than off the source tree
(`grep -aoF`, occurrences, with `contextWindow` → **1 501** in the host bundle as the reader's positive control):

| fact | where | reading |
| --- | --- | --- |
| the child ADVERTISES the receipt | vendored `claude`, self-reporting **2.1.251** | `interrupt_receipt_v1` = *"the interrupt control_response success payload carries still_queued (uuids of async user messages that survive the interrupt)"*; `still_queued` **18**, `cancel_queued` **23** |
| the child also advertises the FIX | the same binary | `interrupt_cancel_queued_v1` = the request honours `cancel_queued: true`, and `still_queued` is then empty |
| the host READS the advertisement | `dist/main.cjs` | `childAdvertisesInterruptReceipt()`, whose own shipped comment says *"nothing in this tree consumes `still_queued` yet, so a branch here would be invented rather than read"* |
| the host never SENDS the fix | `dist/main.cjs` | `cancel_queued` → **0**, `interrupt_cancel_queued_v1` → **0** |
| the host DISCARDS the receipt | `dist/main.cjs` | `void live.interrupt().catch(...)`, with the seam line beside it |

So D1.81's premise is confirmed in the shipped bundle. What the bundle cannot say is what happens when the
button is actually pressed.

### The two arms, and the second one is why the first is a finding

Same card, same `queue` setting written through the app's own save route, same prompt (three sequential
`sleep 20 && echo STEP-n` shell calls), the same wait for a real tool call, the same click on the composer's
Stop — differing in one thing:

| arm | interrupt rows | settled after | tool calls AFTER the Stop |
| --- | --- | --- | --- |
| **a message QUEUED behind the turn** | **0** | **135 839 ms** | **2** |
| **nothing queued** (THE CONTROL) | 1 — `Response interrupted` | 16 081 ms | 0 |

With nothing queued, Stop works: one interrupt row, sixteen seconds, no further tool calls. With a message
queued, the same click produces **no interrupt row at all**, the remaining two shell calls run to completion,
the assistant delivers its full summary — the session transcript carries *"All three steps ran, one at a time,
none skipped"* — and only then is the queued message delivered and answered.

**That is D1.81's "Stop lied", one level stronger than the row expected.** The row asks whether the receipt
NAMES messages the interrupt did not cancel; what the artefact does is let the interrupted TURN itself survive.
A user who presses Stop because a command is going wrong gets the remaining commands anyway.

The composer's own reads are in the record on both arms: `{"type":"submit","label":"Queue"}` with text typed
mid-turn (so the message really was queued and not steered — the first drive of this case measured `Steer` and
was corrected by setting the connection's `midStreamBehavior` through `AiSettingsPage`'s own route), and
`{"type":"button","label":"Stop","disabled":false}` at the moment of the click.

### The second FAIL: the seam line is unobservable on a packaged build

The host writes, on every interrupt,
`Claude turn interrupt (<reason>); child advertises|does NOT advertise interrupt_receipt_v1 (capabilities: …)`.
It goes through `this.debug(...)`. Over both arms, in each session's OWN diagnostic
(`<config>/logs/runtime/<that session id>-claude.txt`, 214 → **319** lines on arm A and 214 → **246** on arm B,
so the files were being written throughout), the seam line appears **0** times. So the capability read P6.263
added — the one that exists so *"the next reader of a Stop that behaved oddly can tell 'the child promised a
receipt' from 'we assumed one'"* — cannot be read on the build a user runs, which is exactly the Stop that
behaved oddly.

### The reader bug this case had to fix first, and it is worth carrying

The first drive picked *"the richest `*-claude.txt` in the directory"* and read a PREVIOUS session's 266 lines
**twice** — an identical before and after, which reads exactly like a host that wrote nothing. The host names the
file after the session, so the reader is keyed by session id now, and a missing file is reported as missing
rather than substituted for. A before/after pair over the wrong file is the quietest possible zero.

### What stays unanswerable

The receipt's CONTENT. `void live.interrupt().catch(...)` throws the promise away, so `still_queued` has no
reader anywhere and no amount of driving makes one appear — `still_queued` and `cancel_queued` score **0** in
both arms' diagnostics, and that zero is an absence of a READER, not evidence that nothing survived. The row's
own stated fix (`cancel_queued: true`) is absent from the shipped host bundle while the vendored child
advertises the capability that would honour it.

---

## 3. D1.65 — the memory-index notices reach the model on pi, and the `remember` tool never returns on claude or codex (case `RS-79`, fixture `memory-index-limits.ts`)

### The rig, and why one arm per run

`memoryIndexWriteNotice` measures the file a write LEFT BEHIND, and a write only ever grows the index, so
`ok` → `near` → `over` is one-way and each level is its own seed plus its own run.
`scripts/cdp/fixtures/memory-index-limits.ts` owns the write — a case may not write configuration and a fixture
may, per `scripts/cdp/README.md` — and the case BLOCKS when the profile is seeded for a different arm than the
one it was told to measure. The two seeds used here: **206 lines / 15 647 bytes** for `over` and
**21 lines / 1 402 bytes** for `ok`.

### The pi arm answers the row, both branches

`over` — one `remember` call, `toolStatus: "error"`, and the result the model was handed reads, verbatim:

> `[ERROR] this write left the memory index at …/MEMORY.md at 207 lines, over its 200-line read limit. The write
> succeeded, but everything past the limit is silently dropped each time the index is loaded — entries at the end
> are already invisible to readers. Rewrite it to under 140 lines now: …`

So the branch fires, it names the overflow, and it is SELF-DESCRIBING — it says the write succeeded and carries
the remedy on its own, which is exactly what the wording exists for on a transport that drops `isError`. The
index measured **208 lines / 15 703 bytes** afterwards, so the write really did land. And the same wording is in
the conversation the RUNTIME carried, not only in the envelope: the session's own runtime files carry the
over-limit wording **3** times and the remedy **3** times over 25 885 bytes, with the tool named 9 times as the
reader's control. `ok` — a small write (21 lines / 1 402 bytes seeded) produces NEITHER branch and no remedy
sentence, which is the row's own control.

### The claude and codex arms cannot be measured, and the reason is a product defect

On both runtimes the turn never settles. The transcript shows the call opened and never closed:
`mcp__session__remember` sits at `toolStatus: "executing"` with an empty result while the session stays
`processing: true`, through a 240 s ceiling, on BOTH the `over` seed and the `ok` seed — so it is not the
over-limit error path.

**The control that makes this a finding rather than a slow rig** is inside the case now: when a `remember` turn
does not settle, it drives a DIFFERENT session tool on the SAME card.

| runtime | `mcp__session__remember` | `mcp__session__get_session_info`, same card, minutes later |
| --- | --- | --- |
| claude (`claude-gateway`) | `executing`, empty result, turn never settles | **completed in 15 658 ms**, 381 chars of result |
| codex (`codex-gateway`) | `executing`, empty result, turn never settles | **completed in 9 342 ms**, 293 chars of result |

So the session-MCP transport works on both; `remember` specifically does not return. Scope is not the
discriminator either — a hand probe with `scope: "session"` hung exactly as `scope: "user"` did. On **pi** the
same tool is the native local `remember` (not `mcp__session__remember`) and returns immediately with the notice
in it.

**So D1.65's claude and codex arms are a measured NULL with a cause**: the notice cannot reach the model on those
runtimes because the call it rides never returns. Ledger L55 is `have` on all three by propagation from one host
function; the function is fine and the transport is not. Recorded as proposed row **P-5e-1**.

### The two runs, and what each answered

| run | seed | verdict | what it settled |
| --- | --- | --- | --- |
| `NESSY_CDP_MEMORY_ARM=over` | 206 lines / 15 647 bytes | **8 of 10**, 583 902 ms | pi's over branch, both the envelope and the runtime-carried clause; the claude and codex hangs WITH their control |
| `NESSY_CDP_MEMORY_ARM=ok` | 21 lines / 1 402 bytes | **4 of 5**, 97 023 ms | the row's own control on pi — `Saved memory to …`, no notice, over/near/remedy all **0** in the runtime file with the tool named **11** times as the reader's control |

The `ok` run's codex arm stopped on its own required check for a different reason and it is worth separating from
the hang: that model made **no `remember` call at all** (0 calls, 0 chars), which is a model declining rather than
a tool not returning. A case that scored the two as one reading would have reported a hang it did not see.

---

## 4. D1.67 — NOT closed, and the three reasons are readings rather than guesses (case `RS-80`, four drives)

D1.67 asks for *"one session per runtime with a nested `.claude/skills` root plus a same-named skill at the
project root, touching a file in the subtree"*, and for the qualified `<dir>:<name>` to appear in the roster.
`RS-80` mints exactly that project — a root `.agents/skills/cdp-deploy`, a same-named
`pkg/web/.agents/skills/cdp-deploy`, a `pkg/web/.claude/skills/cdp-deploy-c` for the page's own directory name,
and a trigger file under `pkg/web/` — and drives three turns per runtime. It did not reach a verdict, and each
obstacle is recorded because each is a fact the next attempt needs.

**1. The row's `.claude/skills` is the PAGE's spelling, not this fork's.** `nestedSkillDirectories`
(`capabilities/native-sources.ts`) returns `<dir>/.agents/skills` and `<dir>/.nessy-agent/skills`, from
`PROJECT_AGENT_SKILLS_DIR` and `NESSY_AGENT_PROJECT_DIR`. So a rig built to the row's own title would find
nothing and report it as the mechanism failing. The case plants all three directories for that reason.

**2. `mkdtempSync(join(tmpdir(), …))` answers `/var/folders/…` while the real path is `/private/var/folders/…`,
and `trustScratchProject` compares them BY STRING** — the first drive lost all three arms to
`refusing-to-trust: /var/folders/… is not under /private/var/folders/…`. `realpathSync` around the mint fixes
it; this is the same de-canonicalisation family AGENTS.md records for sandbox write grants.

**3. A case that deletes its scratch project while the app's trust modal still points at it poisons the whole
profile.** The second drive threw with the modal up, the `finally` removed the directory under it, and the modal
then answered `Could not update project trust` to every click — `trust-dialog-did-not-close` on every arm of the
NEXT drive, and it would have blocked every later case in this profile, not just this one. `RS-80` now dismisses
any dialog it left behind BEFORE deleting. The stale one was cleared by hand with the app's own Cancel button.

**What was measured anyway, and it is half the row.** The trust dialog itself enumerates what the project
provides, and at bind time it reads, verbatim:

> `Trust this project? Project instructions, skills, agents, MCP servers, hooks, and memory can run from this
> folder. … THIS PROJECT PROVIDES 1 skill — cdp-deploy .agents/skills`

**One** skill: the project-ROOT variant, named with the directory it came from. The same-named nested variant
under `pkg/web/.agents/skills` is not counted — which is `skills.md:154`'s *"Skills in nested directories below
the working directory are not loaded at startup"* visible on the product's own surface, before any prompt is
read.

**Why the prompt-side arm stayed at zero.** After the modal had been cancelled once, `trustScratchProject`
answered `not-shown` on every later arm — the gate does not re-raise — so the project stayed untrusted and no
project skill was listed. The case's own control caught it: the ROOT skill's token answered **0** on all three
runtimes, and the case refuses to read the nested zeros beside it, which is what the control is for. Two
corrections were made on the way and both hold: the marker belongs in the skill's `description:` (the body is
loaded on ACTIVATION, while what rides the listing is name plus description), and claude's and codex's composed
prompts are not in the session directory at all — §1 measured that already.

**What the next attempt needs:** a profile whose trust modal has not been cancelled, or a rig that answers the
gate before the first arm and never deletes a project while a dialog names it. Nothing about the nested
mechanism itself was refuted here.

---

## 5. D1.176 — the rewind menu's item set IS identical on claude and codex; the toast clause stays owed, and now for a reason all three share (case `RS-05`, **15 of 19**, 231 604 ms)

The existing `RS-05` was driven as written — no new case — on this lane's own profile, dark theme already in
force, with a pi arm in the SAME run as the control the row demands.

### What is now driven

| clause | pi (control) | claude | codex |
| --- | --- | --- | --- |
| `/rewind` opens the menu | yes | **yes** | **yes** |
| the item set, code-restore buttons set aside | the reference | **matches Pi** | **matches Pi** |
| the menu offers code restore on its anchors | — | **true** | **true** |
| the `does not track file edits` warning | absent | **absent** | **absent** |
| `Esc Esc` on an empty composer opens it | **no** | no | no |
| a toast after the restore-files press | none | none | none |
| mid-turn `/rewind` | — | — | **opens and says it is busy**; `Esc Esc` yields to the interrupt, as P2.447 states |

So the row's central clause — *"item set byte-identical to Pi"* — holds on both runtimes, driven, with the Pi
control in the same run. The `fileCheckpointsTracked: false` warning the done_means expected to be the only
difference is absent on all three, so there is no divergence to record there either.

### Two clauses stay owed, and the CONTROL is what says they are the instrument

`Esc Esc` opened the menu on **none** of the three — including the Pi control. A route that fails on the control
is not a per-runtime divergence, and the case scored it as a control failure rather than as a claude/codex
finding, which is exactly the discrimination the row needs. (The composer after the with-text arm holds a bare
`"\n"` on all three, the same signature C3.363 recorded.)

The toast clause is unanswered for a reason that is also identical on all three: the restore-files button
**`"vanished between the read and the press"`** on pi, claude and codex alike, so no arm produced a toast and
there is nothing to compare. The server's own tracked-anchor answer came back `success: true` on every arm
(with `messageIds` non-empty only on pi), so the rewind path itself is live; what is missing is a press that
lands. That is a harness timing question on a shared surface, not a runtime difference.

### The cell this moves

F2/claude and F2/codex were `partial ʰ` — a propagated claim. The item-set half is now a driven reading with its
control; the toast half is owed with a named, shared cause. Proposed as `partial ʳ` on both, with the toast
clause stated rather than implied.

---

## 6. D1.77 — codex's rate-limit family, read off the two shipped binaries (a READING, not a case)

The row forbids its own strongest arm (*"Do not take the codex USD arm here"* — `account/usage/read` is an
already-asked owner question), and sitting 5c recorded that a gateway card has no published rate-limit window to
read. What the ARTEFACT can still answer is the row's other half — *"codex publishes … and we read none of
them"* — and it answers it on both sides of the seam. Every count below is `grep -aoF` OCCURRENCES over the
shipped file, with `contextWindow` → **1 501** in the host bundle as the reader's positive control.

**What the shipped `codex-app-server` publishes** (`Contents/Resources/app/resources/bin/codex/darwin-arm64/`,
163 MB): a `RateLimitSnapshot` **struct with 10 elements** and a `RateLimitWindow` beside it, whose field names
read out of the bytes at the hits: `limit_name`, `normal_model_slug`, `primary`, `secondary`, `credits`,
`spend_control_reached`, `plan_type`, `rate_limit_reached_type`, `resets_at`, `rate_limits`. `rate_limit` scores
117, `rate_limits` 23, `RateLimitSnapshot` 4, `account/usage` 1.

**What the host bundle does with them** (`dist/main.cjs`, 44 MB):

| needle | occurrences | what they are |
| --- | --- | --- |
| `limit_name`, `spend_control_reached`, `rate_limit_reached_type`, `used_percent`, `window_minutes` | **0** each | nothing reads them |
| `rate_limits` | 5 | **all five are the vendored OpenAI SDK's ADMIN organization API** (`/organization/projects/{id}/rate_limits`, bundled through pi-ai) — unrelated to codex's snapshot |
| `plan_type`, `resets_at` | 4 / 2 | a **429 error-body** path: `err.plan_type` and `err.resets_at` turned into *"You have hit your ChatGPT usage limit (<plan> plan). Try again in ~N min."* — not `RateLimitSnapshot` |
| `account/usage` | 3 | the host's own docblock and its user-facing NULL |

So the row's premise holds on the artefact: **none of codex's rate-limit fields is read.** And the host says so
itself, in the shipped bundle, with the measurement already taken:

> *"codex publishes the usage window natively on three RPCs and one notification — `account/rateLimits/read`,
> `account/usage/read`, `account/rateLimitResetCredit/consume` and `account/rateLimits/updated` carrying
> `RateLimitWindow { usedPercent, windowDurationMins, resetsAt }`"*

…beside a table of what each one answers on a gateway session — `account/rateLimits/read` →
`-32600 "codex account authentication required to read rate limits"`, `account/usage/read` → the same for token
usage, `account/read` → `{ account: null, requiresOpenaiAuth: false }` — and a typed user-visible null:

> *"Quota is not available on this runtime. Codex does publish a usage window (account/rateLimits/read,
> account/usage/read and the account/rateLimits/updated notification), but every member of that family requires
> a Codex ACCOUNT — a ChatGPT login — and this session authenticates against the Nessy Gateway through …"*

**The live half, taken in this sitting's own palette probe:** the `Quota` entry is offered on **pi only** — 113
entries on `pi-api-key` including it, 111 on `claude-gateway` and 111 on `codex-gateway` without it (with
`Approve` present on codex alone in the same read, the control that the palette is runtime-scoped). So on a
codex gateway card the operator has no slash route to that null at all.

**Verdict for the row.** The "we read none of them" clause is CONFIRMED on the artefact, and it is not a silent
gap: the product carries a stated, user-visible refusal naming the exact RPCs and the reason. What stays
rig-day is the arm the row wants — a codex account with published windows — because a gateway card has none.

---

## 7. D1.71 — installing a plugin does NOT turn its bundled MCP server on (case `RS-82`, **PASS 5/5**, 7 347 ms)

### The precondition that was never a product fact

Every sitting so far recorded D1.71 as *"operator precondition — the same plugin install"*, because
`scripts/cdp/README.md` reserves plugin installation for the operator. That rule is about the OPERATOR's live
config dir; this lane was told it may install one into its own fresh profile, and the install then goes through
the app's own `marketplace.install` RPC — the path a user takes. The row became drivable the moment the
precondition was read correctly rather than inherited.

**And the rig is cheaper than the row thinks, which is worth carrying forward for D1.68/D1.70/D1.72/D1.73.** A
fresh profile lists **no** registries and offers two to add (`anthropics/claude-plugins-official`,
`openai/skills`); `marketplace.addRegistry({ source })` added one in a single call. But no registry is even
needed for this row: `marketplace.list({ kind: 'plugins', pageSize: … })` already answers **168** listings from
the `skills-market` marketplace on a clean profile.

### The reading

`figma-api-mcp` (`skills-market`, `kind: 'mcp'`, one declared capability `figma-api`, no skills, no agents, no
hooks), resolved by NAME through the same `marketplace.list` the Plugins page calls:

| moment | `installedPlugins` | catalog `generation` | capability entries |
| --- | --- | --- | --- |
| before | `[]` | `7b397fc2…` | 117 |
| after the install, **no user action** | the plugin | `768a8765…` (moved) | 118, one of them the plugin's |
| after the uninstall | `[]` | — | — |

**The bundled server's post-install state, verbatim from the catalog:**

```
key:         plugin://skills-market/figma-api-mcp@1.8.0#…#figma-api@workspace:…
kind:        mcp
logicalName: figma-api
state:       disabled
trust:       not-required
```

**So installing a plugin does NOT turn its bundled MCP server on.** The install itself reports
`state: 'supported'`, `runtimeRefresh: 'reloaded'`, and an `authRequirements` entry naming exactly what the
server would need — `{ kind: 'environment', capabilityIds: ['figma-api'], serverNames: ['figma-api'],
requiredNames: ['FIGMA_TOKEN'] }` — so the product knows the server is unusable and files it as `disabled`
rather than enabling something that would fail on first call.

### What this does NOT answer, and the case says so

D1.71 asks about *"every bundled capability kind"* — an MCP server, a CONNECTOR and a connected service. This
plugin bundles an MCP server and nothing else, so the connector clause is owed and is not generalised from one
kind. The explicit-enable control the row names is owed with it: the reading above is the DEFAULT, and the
second state (the same plugin after a user enables it) needs the enable route, which this case does not drive.

### One teardown fact worth carrying

The first drive passed the plugin's NAME to `plugin.manage({ action: 'uninstall' })` and got
`plugin.manage.invalid-plugin-key` — leaving the plugin installed, which would have made this case's own first
control refuse every later run in the profile. The key is the one the CATALOG reports
(`installedPlugins[].pluginKey`, a base64-ish pair), and with it the uninstall answers `{ ok: true }` and
`installedPlugins` returns to `[]`. The case asserts that last fact now.

---

## 8. D1.76 half (a) — a live session DOES re-read a settings file edited under it (case `RS-83`, **PASS 6/6**)

Half (b) was answered by sitting 5c as a reading; half (a) — *"editing a settings file with a session live"* —
was the owed half and is the reason the row is 🟨. Driven on a session that had already run a turn, with the
edit made by a fixture (`scripts/cdp/fixtures/live-settings-edit.ts`, a merge-preserving write into the run's own
`config.json`, restored in a `finally`), three surfaces answered the same moment:

| surface | before | after, with NO relaunch |
| --- | --- | --- |
| `getSettingsProvenance`, the `instructionExcludes` family's entry for `<config>/config.json` | `present-no-keys` | **`supplies`** |
| the app's own output | — | `[ConfigWatcher] config.json changed` |
| the claude child's per-session diagnostic, across the NEXT turn in the SAME session | 214 lines | **231 lines**, settings paths re-listed |

So the answer is yes on all three: the host re-reads the file, says so in its own watcher output, and the
session that was already open re-opens its settings on its next turn. No relaunch anywhere.

**The controls.** The session ran a turn BEFORE the edit (so it is genuinely live across it, not a fresh session
reading a new file); the fixture's own round trip reports `4 148 → 4 206` bytes with the complete top-level key
set unchanged (6 keys, merge-preserving), so "the host did not re-read it" cannot be a write that never landed;
and the restore put the previous value back — `absent`, which is a different state from "present and empty".

**One byte of honesty about the restore:** the file came back at **4 149** bytes against 4 148 before, with the
same six keys. That is the JSON round trip's own formatting, not a lost key, and it is recorded rather than
rounded away.

---

## 9. D1.70 — the worktree reading is UNINTERPRETABLE, and the negative control is what says so (case `RS-84`, **8 of 9**, and the one FAIL is the control)

`RS-84` builds the rig the row asks for: a git repository under the OS temp dir, a `git worktree add` sibling of
it (`git worktree list` names both and the worktree's `.git` is a FILE, so it is a worktree and not a second
clone), and a plugin installed with
`activateIn: { kind: 'project', context: { workspaceId, sessionId } }` from a session whose working directory is
the MAIN checkout. Each session's own catalog is then read with a SESSION ref, so each answer is that session's
own project scope.

### The first drive looked like a clean answer

| session | working directory | carries the plugin |
| --- | --- | --- |
| A — the main checkout (the positive control) | `…/main` | `installedPlugins` 1, `capabilities` 1 |
| B — the worktree | `…/wt` | `installedPlugins` 1, `capabilities` 1 |

Eight of eight, and the obvious write-up is *"a project-scope plugin loads in a worktree of the same repo"*.

### The negative control refutes it

A third session was added in an **unrelated git repository** under the same temp root — a different repo
entirely, nothing to do with the checkout or its worktree:

| session | working directory | carries the plugin |
| --- | --- | --- |
| C — an unrelated repository | `…/elsewhere` | **`installedPlugins` 1, `capabilities` 1** |

So the plugin is visible from a directory the project-scope install never named, and the worktree reading
measures nothing about worktrees. Either the `project` activation target is not scoping the install on this
build, or `capabilities.getCatalog({ workspaceId, sessionId })` does not report project scope — this case cannot
tell those two apart from outside, and it says so rather than naming one.

**All three sessions' trust gate answered `not-shown`** (the profile's modal had been cancelled earlier in this
sitting, §4), so none of the three projects was trusted and the plugin was visible from all three anyway. That
is recorded beside the verdict because "absent because untrusted" and "present because unscoped" are different
findings.

**D1.70 is therefore a measured NULL with a cause, not a verdict** — and the cause is a proposed row
(`P-5e-2`). Without the third session this sitting would have recorded a confident false positive; the arm cost
about a minute and it is the whole difference.

---

## 10. The rows NOT driven, each with the reason and the premise re-taken

One line per row, in the order this lane's brief set them. A reason is a READING wherever this sitting took
one; nothing here is a guess about the product. **The plugin family's reasons have all changed**, because the
precondition every earlier sitting recorded is gone (§7): this lane installed and uninstalled a marketplace
plugin twice, through the app's own RPC, in a profile it created.

| row | subject, short | why not driven here |
| --- | --- | --- |
| D1.66 | user-invocable skill dispatch when the model-invocation list omits it | Not reached. Needs two skill fixtures (with and without `disableModelInvocation`) and a MALFORMED entry, on claude and codex — and §3's reading is the new obstacle: a model-driven arm on those two runtimes has to avoid `mcp__session__remember`, which never returns. The listing side is readable without a model: §4 measured that a skill's DESCRIPTION is what rides the prompt, so an absence there is checkable off the composed prompt on pi. |
| D1.68 | one uninterrupted codex plugin prompt workflow | **The row's named plugin does not exist in either catalogue reachable from a fresh profile.** `marketplace.list({ kind: 'plugins', query: 'codex-security' })` answers **0** on this build, against 13 for `lsp` and 26 for `security` in the same read (the positive control). So the row needs either a different plugin named by the owner or a registry nobody here has — not an operator's hands. |
| D1.70 | a project-scope plugin in a worktree | **Driven and UNINTERPRETABLE — see §9.** The rig works; the negative control refutes the reading. |
| D1.72 | a codex plugin has no durable home | Not driven. §7 and sitting 5c between them leave one gap: `CODEX_HOME` is a per-SESSION `mkdtemp` (5c §8, six distinct values across six sessions) and a plugin install is visible per profile (§7), but nothing in the 168 listings reachable here writes its own config into the codex home, so the survival arm has no subject. Naming such a plugin is an owner step now, not an install. |
| D1.73 | the plugin suggestion pin | Cheaper than the row thinks and still two rigs. **A fresh profile lists NO registries and offers two to add**; `marketplace.addRegistry({ source: 'anthropics/claude-plugins-official' })` added one in a single call and it answered 13 `*-lsp` listings afterwards. What is still missing is the second registry plus a DELIVERED managed policy carrying the suggestions allowlist — `fixtures/agent-surfaces.ts --managed` writes that form, and the app reads the cache at startup, so it is a fixture plus a relaunch. |
| D1.75 | which settings keys wait for workspace trust | Not reached, and §4 is the new premise: **once the app's trust modal has been cancelled, `trustScratchProject` answers `not-shown` for every later project in that profile** — all three sessions in §9 reported it. So an untrusted-workspace rig is easy to get into and a trusted one is not, on a profile where the gate has been answered once. Drive this row FIRST in a fresh profile, before anything cancels the modal. |
| D1.77 | codex rate-limit windows and account usage | **ANSWERED as a reading — see §6.** The remaining arm (a codex account with published windows) is rig-day. |
| D1.82 | two askUserQuestion expiry timers | Not reached. Needs a card left idle for the full expiry twice, plus a permission prompt idled beside it as the control — the only row in this list whose cost is wall-clock rather than setup. |
| D1.131 | the Guardian's fourth precedence tier | Not reached; needs the soft_deny/hard_deny rig the row spells out, on Pi and claude. |
| D1.132 | the three standing MEASURE rows | Not reached; three separate rigs (A16's project-file `bypassPermissions`, A19's `.codex/rules/` probe, A22's two non-rule floors). |
| D1.133 | A57 and A70 | Not reached. A57 needs a background subagent tripping an ask rule per runtime — and §1 measured that only pi mints a child SESSION, so the claude/codex arms need a different observable than a child's own files. |
| D1.134 | the per-event hook matrix on claude | Not reached. `fixtures/agent-surfaces.ts` writes hooks and this sitting PARKED its `hooks.json` deliberately (see the rig section) because its `UserPromptSubmit` entry injects a codeword into every prompt — which is exactly the instrument this row needs, and exactly what would have contaminated §1 and §4. Restore it first, then drive this row alone. |
| D1.135 | the three forwarded subagent fields | Not reached. §1 gives it two facts to start from: a pi named subagent becomes a SESSION with its own prompt on disk, while claude delegates through the SDK's `Agent` tool and codex through `spawn_agent`/`wait_agent`, neither of which mints one — so the per-field read needs a different surface on two of the three runtimes. |
| D1.136 | J5's Pi and codex cells from RS-06 | Not driven; it is a restamp that waits on RS-06/P6.144, which this lane did not run. |
| D1.137 | Pi's LSP tool with an official `*-lsp` plugin in a TRUSTED project | **Half the precondition is now measured as present**: the official registry offers **13** `*-lsp` plugins (`typescript-lsp`, `rust-analyzer-lsp`, `pyright-lsp`, …) and this lane added that registry in one call. The other half is the blocker named in D1.75's row above — a TRUSTED project, on a profile whose modal has not been cancelled. |
| D1.138 | `thinking_delta` / `toolcall_delta` frames | Not reached; needs the adapter-level frame capture the row names. |
| D1.175 | `view_image` on a switched codex session | **Rig-day**, unchanged: needs a vision-capable BYO `openai-compatible` upstream, and this host's only codex card is the gateway. |
| D1.178 | what a runtime keeps when the connection drops mid-response | **Rig-day**, unchanged: needs a stub upstream that streams a partial response and then drops. |
| D1.179 | a Bash command whose OUTPUT carries denied content | **Rig-day**, unchanged: needs a FAKE `HOME` with a seeded denied file, which makes both gateway cards answer `auth-request`. |
| D1.180 | the two live codex arms W6-a could not drive | **Rig-day**, same fake-`HOME` blocker (C4.48, an owner question). |

---

## 11. What ran, and where this sitting stopped

| case | row | verdict | file |
| --- | --- | --- | --- |
| RS-32 (rig precondition) | P6.1080 | **PASS 8/8**, 20 256 ms | `scripts/cdp/cases/rs-32.ts` |
| RS-78 | D1.64 | **PASS 11/11**, 482 127 ms | `scripts/cdp/cases/rs-78.ts` |
| RS-79 (`over`) | D1.65 | **8 of 10**, 583 902 ms — the two FAILs are the `remember` hang, both controls green | `scripts/cdp/cases/rs-79.ts` |
| RS-79 (`ok`) | D1.65 | **4 of 5**, 97 023 ms — pi's control clean | same |
| RS-80 | D1.67 | **not closed**, four drives; three rig obstacles measured and half the row answered off the trust dialog | `scripts/cdp/cases/rs-80.ts` |
| RS-81 | D1.81 | **14 of 16**, 238 864 ms — and the two FAILs are the product | `scripts/cdp/cases/rs-81.ts` |
| RS-82 | D1.71 | **PASS 5/5**, 7 347 ms | `scripts/cdp/cases/rs-82.ts` |
| RS-83 | D1.76(a) | **PASS 6/6** | `scripts/cdp/cases/rs-83.ts` |
| RS-84 | D1.70 | **8 of 9** — the one FAIL is the negative control, and it refutes the positive reading | `scripts/cdp/cases/rs-84.ts` |
| RS-05 (existing) | D1.176 | **15 of 19**, 231 604 ms | `scripts/cdp/cases/rs-05.ts` |
| *(readings, no case)* | D1.77 | answered in §6 | — |

**Where it stopped.** The lane's list was `D1.64` onward. Driven or answered: `D1.64`, `D1.65`, `D1.70`,
`D1.71`, `D1.76(a)`, `D1.77`, `D1.81`, `D1.176`, plus `D1.67` left open with its obstacles measured. **The next
sitting starts at `D1.66`**, then `D1.73` and `D1.75` — and §10 says for each remaining row what it needs, with
four reasons re-taken here rather than inherited (D1.68's missing plugin, D1.73's and D1.137's registry,
D1.75's trust-modal state, D1.135's per-runtime child shape).

### Rig facts this sitting adds

* **A plugin install is a lane action now, not an operator one.** `marketplace.list({ kind: 'plugins' })` answers
  168 listings on a FRESH profile with no registry added at all; `marketplace.addRegistry({ source })` adds one
  of the two the app offers in a single call; `marketplace.install({ source: { kind: 'listing', … } })` installs;
  and `plugin.manage({ action: 'uninstall', pluginKey })` removes it — **with the key the CATALOG reports**, not
  the listing's name, which answers `plugin.manage.invalid-plugin-key` and leaves the plugin installed.
* **A case that deletes a scratch project while the app's trust modal names it poisons the whole profile** —
  the modal then answers `Could not update project trust` to every click, and `trust-dialog-did-not-close`
  becomes every later case's first failure. Dismiss, then delete.
* **After that modal has been CANCELLED once, the trust gate answers `not-shown` for every later project in the
  profile.** Four sessions across §4 and §9 reported it. Any row needing a TRUSTED project must run before
  anything cancels the gate.
* **`mkdtempSync(join(tmpdir(), …))` is not canonical on macOS** — `/var/folders/…` where the real path is
  `/private/var/folders/…` — and `trustScratchProject` compares by STRING. `realpathSync` around the mint.
* **`this.debug(...)` does not reach the per-session runtime diagnostic on a packaged build** (§2), so a host
  seam line is not automatically observable just because the file beside it is.
