# Clean runtime usage — Pi mirrors Claude, Claude and Codex run as-is

## Why this plan exists

The owner's target, stated 2026-08-16 and now the yardstick for this plan:

> Pi is our base agent and reproduces Claude Code's documented behaviour as
> closely as possible. Claude and Codex should run **as-is at the runtime
> level**, against our models through our adapters. Our backend, adapters,
> plugins and tools are **suppliers** — they hand the runtime data and settings;
> they do not own its policy or replace its mechanisms. Those runtimes keep
> their full native capability. Where switching a session between runtimes is
> rough, **we** absorb the friction.

The measured picture of how far that is already true lives in
`docs/architecture/runtime-control-boundary.md`. Read it first; this plan fixes
the places where the measurement and the target disagree.

**This plan is written to be extended.** The rows below come from what has been
verified so far. Further analyses land as new rows rather than as edits to
existing ones, so a row's evidence and its date stay together.

## P.1 The rule this plan is measured against

`packages/shared/src/agent/claude-runtime-agents.ts:5-8` carries the rule in
prose already: *"Pi is ours and is built to Claude Code's documentation; Claude
runs \"as-is\" so we do not diverge from its real behaviour."* Every row here
either closes a gap against that sentence or records a deliberate exception to
it with the owner's reason attached.

## P.2 Tasks
## P.2 Tasks

**R1 → R2 → R3 is one chain, in that order.** Each step is safe on its own and
useless out of order; R3 is the step that actually makes the Claude runtime
"clean", and running it first would regress Safe Mode. The dependency is
mechanical, not stylistic — the reason is measured and quoted under R3.

### R1 — our permission decisions must speak the SDK's own vocabulary

**What is wrong.** Our `PreToolUse` hook decides correctly and then reports the
decision in a shape the SDK cannot act on. `claude-agent.ts`'s `continueWith`
returns `{ continue: true }` plus an optional `updatedInput`, and sets
`decision: 'ask'` only for the ask case. On `checkResult.type === 'allow'` it
returns **no `permissionDecision` at all**.

**Why that matters.** `hooks.md`'s PreToolUse field table:

> "`permissionDecision` … `"allow"` skips the permission prompt, except for
> tools that require user interaction and connector tools your organization set
> to `ask`. `"deny"` prevents the tool call. `"ask"` prompts the user to
> confirm. … Deny and ask rules are still evaluated regardless of what the hook
> returns"

So "allow" is not a courtesy — it is the documented instruction that skips the
prompt. Today the omission is invisible because `bypassPermissions` means there
is no prompt to skip. The moment R3 lands it becomes the difference between Safe
Mode working and Safe Mode prompting on every read-only command.

**Scope.** Emit `permissionDecision` for all three outcomes from the same place
the decision is already made. Do not change a single decision — this row is
about how a decision is *expressed*, and any behaviour change in it is a bug.

**Design against these, from the same table rather than from memory:**
precedence among multiple PreToolUse hooks is `deny` > `defer` > `ask` >
`allow`; a hook that blocks by exiting 2 routes the same way as `"deny"`; and
`updatedInput` "replaces the entire input object, so include unchanged fields
alongside modified ones" — our `modify` path must satisfy that.

**Acceptance.** Each of allow / ask / deny produces the documented field with
the documented value, asserted against the SDK's own type rather than a string
literal. A negative control that an allow **without** the field does not skip a
prompt is the row's real proof, and it is what makes R3 safe to land later.

### R2 — route `canUseTool`, so the model can ask the user a question on Claude

**What is wrong.** `AskUserQuestion` sits in `disallowedTools`
(`claude-agent.ts:1431`) with the reason *"no UI for them"* (`:1427-1430`).
**The reason is stale**: the UI exists — option cards, wait timeout, durable
approvals — and our types match the SDK envelope field for field, including
preview and answer grouping. So on Pi the model can ask a structured clarifying
question (`ask_user`) and on Claude it cannot, in the same window, in the same
session.

**The trap, and it is why this is not a one-line change.** The answer arrives
through `canUseTool`, and ours is a stub returning the input unchanged, with the
comment *"the SDK does not call this because bypassPermissions is set"*. Enable
the tool without routing the callback and every question is auto-answered with
nothing, silently.

**This row is required even if R1 were perfect**, because the field table carves
it out explicitly: `"allow"` skips the prompt *"except for tools that require
user interaction"*. `AskUserQuestion` is exactly that. No hook decision can
substitute for the callback here.

**Scope.** Route `canUseTool` into the existing answer bridge for this tool;
keep it disallowed for subagents, which have no surface to ask through.

**Acceptance.** A live case where the model asks and the user's choice reaches
the turn, plus a negative case proving an unrouted call cannot answer itself —
that negative is the one that would have caught the stub.

### R3 — drop `bypassPermissions`: the Claude runtime starts deciding for itself

**DEPENDS ON R1 AND R2. Landing this first is a regression, not a cleanup.**

**What this actually is.** Today we disable Claude's whole permission system
(`claude-agent.ts:1595-1598`) and decide everything ourselves. Codex is already
arranged the way the target describes — its own approval system runs, it asks
us, and we answer in its format (`codex-agent.ts:490-530`), with our policy
expressed through its own config knobs. This row makes Claude match: their
mechanism decides, our decision answers it.

**The recorded reason for the bypass is real and this row must not dismiss it.**
Their rules match command **strings**; ours parses the command into an AST
(`bash-validator.ts:180 validateBashCommand`), which is how Safe Mode can allow
a genuinely read-only command and refuse one that merely starts like an allowed
one. With R1 in place that reason is satisfied without the bypass: our allow
carries `permissionDecision: "allow"` and skips the prompt.

**What lands with it, for free, and is the reason the owner asked:** permission
rules written in Claude's own `.claude/settings.json` start taking effect on the
Claude runtime. Today they are compiled by `claudeSettingsPermissionDsl`
(`permissions-config.ts:511`, tried before our own schema at `:423`, well
covered by `claude-project-settings-permissions.test.ts`) and then consumed
**only** Pi-side — `pi-agent.ts:1914` and `:4649`, `SessionManager.ts:4756`
gated on `provider === 'pi'`, `config/managed-approval.ts:133`,
`pi-harness/managed-policy.ts`; `claude-agent.ts` has no consumer. Measured
2026-08-16 by unbounded `grep -a` over `packages` and `apps`, excluding tests,
`node_modules`, `dist` and `release`. So a rule in Claude's own format is
honoured everywhere except Claude, and this row is what ends that.

**The counter-reading, recorded so the row is scoped honestly.**
`apps/electron/resources/docs/permissions.md:182` says *"`permissionDsl` is the
readable, versioned policy format used by the Pi runtime."* By that sentence
today's behaviour is a documented limit rather than a defect. Both readings
cannot survive this row; whichever way it lands, that sentence gets corrected in
the same commit.

**Behaviour change to state plainly in the release notes.** A user with an `ask`
rule will now be prompted where Safe Mode previously auto-allowed. That is their
own rule doing what they wrote, and it is more correct than silently ignoring
it — but it is a change, and they should read it from us rather than meet it.

**Acceptance.** The same rule produces the same decision on Pi and on Claude for
the same tool call, one case per action so precedence is asserted rather than
assumed; Safe Mode still auto-allows a read-only bash command with no prompt;
and a `deny` rule blocks it. Run the **full** suite, not the affected areas — a
default's blast radius is every test that wrote the old default down as an
assumption, which the neighbouring plan proved the hard way on 2026-08-16.

### R4 — alias map for vendor tool renames (owner decision, not an implementation)

Anthropic has broken this product twice by renaming: `Task` → `Agent`, which
failed every turn while a Claude plugin's agent was active, and `input.lsp` →
`lspServers`, which left official LSP plugins neither imported nor deferred.
`toolAliases` would redirect a renamed call instead of failing it.

**Why this is a decision.** An alias map is a compatibility shim that hides a
contract change we would otherwise notice loudly. It buys uptime and costs the
signal. The owner chooses between "fail loudly and fix" and "survive and
reconcile later"; the row records which and why, and if the answer is the alias
map, it also records how we would still learn that a rename happened.

### R5 — one mode vocabulary, three honest translations

**Owner decision 2026-08-16, taken against the alternative.** The user sees
**one** set of permission modes on every runtime; each runtime translates it.
The rejected alternative was a separate vocabulary per runtime — rejected
because a mode is a statement of **user intent** ("ask me first" / "go ahead"),
which does not depend on which runtime is under it, and because changing the
vocabulary under a user who switches runtime mid-session exports exactly the
friction this plan's target says we absorb. Nestor cloud keeps its own modes and
is out of scope.

**Where we already are.** The vocabulary is Claude's and has been since
2026-07-31: `dontAsk < explore < plan < default < acceptEdits < auto <
bypassPermissions` (`mode-types.ts:27`, ordered at `:63`, with legacy spellings
kept as permanent read-path aliases). Pi is built to it. Codex has a written,
per-case translation (`config-writer.ts:196-220`).

**The weak point this row exists to close.** Four of the seven modes —
`default`, `acceptEdits`, `auto`, `bypassPermissions` — map to the **identical**
Codex pair (`workspace-write` + `on-request`). The comments say why and the
reason is sound: on Codex the difference is carried by **our answer** to its
approval requests, not by its configuration. But nothing asserts that. If the
answer path ever degrades — a headless run auto-approves, an unsupported method
falls back — those four modes become genuinely indistinguishable, and the two
ends of that range are "ask about edits" and "ask about nothing".

**And R3 adds a translation that does not exist yet.** Today Claude's own
`permissionMode` is pinned to `bypassPermissions` regardless of what the user
chose. Once R3 lands, that pin goes and the user's mode must map onto Claude's
own mode. There is no such mapping in the code today; R3 cannot land without it.

**Scope.** One translation table per runtime, in one place, with a test per mode
per runtime. Where a runtime cannot express a mode faithfully, the row's answer
is to **say so to the user**, not to approximate silently — the target makes
switch friction ours to absorb, and absorbing it honestly includes admitting
when a mode means less than it says.

**Acceptance.** Every mode, on every runtime, has an asserted translation; the
four collapsing Codex modes have a test proving our answer path is what
distinguishes them, and a negative control showing they collapse when it is
removed; and no mode silently widens on any runtime — `PERMISSION_MODE_ORDER`'s
clamp is the invariant to assert, since a wrong position there is a silent
widening.

### R6 — a user's permission rule is not consulted on Codex at all

**Measured 2026-08-16.** `codex-agent.ts` contains no reference to
`runPreToolUseChecks`, `permissionsConfigCache` or `permissionDsl`. Its approval
path (`:490-530`) maps the runtime's request to a UI card and waits for a human.
There is no rule evaluation in it.

**The user-visible consequence, and it is the answer to "will it behave the same
on all three".** After R1–R3 a rule written once is honoured on Pi (our gate
evaluates it) and on Claude (their system plus our hook). On **Codex** the same
rule is ignored and the user is asked every time — including for the calls they
explicitly pre-approved. Same rule, same intent, three runtimes, two outcomes.

**Scope.** Consult the same merged rule set before surfacing a Codex approval:
an `allow` match answers automatically, a `deny` match refuses without asking,
and anything unmatched goes to the human exactly as today. This is our **answer**
becoming rule-aware; it does not add a gate in front of Codex and does not change
what Codex asks about.

**What must NOT change.** The headless auto-approve fallback stays as-is
(`:498-500`), the URL-scheme gate stays where it is — it already runs before
anything is shown and is the same gate as the Pi path — and an unmatched request
must still reach the user. A rule engine that starts answering requests it does
not actually match would be worse than not consulting it at all.

**Acceptance.** One rule, written once, produces the same decision on all three
runtimes for the same tool call — the positive case that makes the three
consistent. Plus a negative control: with the rule removed, Codex asks again. And
an unmatched request still reaches the human on every mode.

**Honest limit to record rather than engineer around.** Codex has no per-tool
permission concept of its own (`enabled_tools`/`disabled_tools` cover MCP
servers, not individual tools), so a rule can only shape **our answer**, never
Codex's own configuration. Where a rule cannot be expressed at all on a runtime,
R5's principle applies: say so, do not approximate.

### R7 — the live session: Claude's session must outlive the turn

**Designed 2026-08-16 by a judged panel of three independent designs. It is no
longer a bare spike — it is a five-step chain with two honest stopping points.**

**The one sentence.** Today we start a fresh Claude process per user message and
it dies with the answer. Everything else follows: no background command, no long
task, no multi-step workflow can exist, because nothing is alive to hold them.

**This is the SDK's own preferred shape, not our invention.** The Agent SDK docs
call streaming input the *"preferred way to use the Claude Agent SDK"* and
describe it as letting the agent *"operate as a long lived process that takes in
user input, handles interruptions, surfaces permission requests, and handles
session management"* — the list of what the one-shot form cannot do matches our
complaints item for item. **Background and long-running work is not unwritten on
our side: the SDK has the levers and they are reachable only from a live
session.** There is no third option — the experimental separate-session object
was removed from the SDK.

**The strongest objection, conceded rather than argued away.** The SDK may
coalesce queued messages into a single turn, so "one message sent = one result"
is false and a naive demultiplexer will one day wait for a result that never
comes. That is *worse* than today, where a hang is impossible because the
process dies regardless. **The answer is not a cleverer matcher: it is one
active turn per session at first**, a watchdog per turn, and unconditional
error-settlement of every waiting turn when the session dies. The native
priority queue arrives later, after coalescing has been watched on a live rig.

**Two further corrections the panel produced, both load-bearing.** There are
**five** SDK call sites in `claude-agent.ts`, not three: title generation and
structured mini-queries carry their own system prompt and must stay one-shot.
And **agent eviction becomes a defect the moment background work exists** —
today we kill the oldest inactive agent and that is safe because "eviction is
hibernation, not loss"; an agent running a background task reads as inactive and
would be killed. The busy predicate has to widen before step 4, not after.

**What the live session does NOT solve, verified by searching the whole type
file:** cwd, system prompt, tool set, subagent set and user hooks still require
a session restart — the SDK exposes no method to change them live. And our
`explore` mode has no SDK equivalent and stays ours on top of theirs, permanently.

**The order, and it confirms the chain this plan already had:**

- **Step 0 = R8.** Full event coverage, ~39 types instead of 7. No lifetime
  change at all. The user starts seeing retries, rate limits, compaction and
  permission refusals where today "nothing happens".
- **Step 1 = R1 + R2 + R3.** Real permissions. Plan mode and clarifying
  questions come back — both are absent today because they are switched off, not
  because they are unbuilt.
- **STOPPING POINT 1.** After steps 0 and 1 the product is meaningfully better,
  the module's shape has not changed, and the risk is near zero. Stopping here is
  a legitimate outcome, not a failure.
- **Step 2 — the live session itself.** One call per agent, strictly one turn at
  a time, recovery logic moves into session start.
- **Step 3 — live settings.** Model, permission mode and MCP server set change
  without a restart; switching model mid-session stops costing the context.
- **STOPPING POINT 2.** Everything except background work is closed here.
- **Step 4 — background and the native queue.**

**The cost, stated including the parts nobody wants to hear.** Step 2 is a
lifecycle rewrite in one large file and **cannot be parallelized** — two agents
in one file cross by construction. Every open chat becomes a live process,
seconds today and hours after, so an idle policy and a reaper are mandatory
rather than optional. Recovery-and-resume logic moves into session start where
it runs far less often, so it gets exercised far less and must be tested
deliberately. Error classification splits in two: today a failure is a process
exit code, and a live session adds "the turn failed, the session lives". State
that is clean today only because the process was new — diagnostic buffers, event
translator state, mode snapshots — starts leaking between turns and every site
must be found and reset. Some code is deleted in exchange: the hook-injected
message workaround and the source-activation controller stop being needed.

**GATE — one live day before this chain is approved, and it is not optional.**
The design is a reading of docs, types and our own code; **no live run happened
at all.** Seven claims need a real check, and one run closes six of them: hold a
single session open, take three turns in it, start a background command, change
model and permission mode mid-flight, and cut the network. The seventh — real
memory cost at N live processes — has no number behind it, only an assumption
that it matters.

The one that most deserves that run: **our process closes the input channel on
the first result**, so the request shape is load-bearing — a single imprecision
leaves "live session" one-shot with nothing in the log to say so.

### R8 — surface the events the SDK already sends us

Our event adapter handles **seven** message types out of roughly forty. So
`task_started`, `background_tasks_changed`, `commands_changed`,
`permission_denied` and the `hook_*` family arrive and are dropped on the floor.

**Do this regardless of R7.** It has no architectural risk, does not depend on
the session-shape decision, and its benefit is immediately visible. This is the
cheapest real win in the plan.

### R9 — the slash-command dispatcher is wired to Pi only

The seam is shared and one of three backends is filled in. On Pi the model can
invoke a custom slash command; on Claude it cannot. The host already resolves
custom commands for the composer, so this is a port, not a design. Check Codex
while there.

### R10 — subagents on Claude have no skills at all

A session-level tool ban removes `Skill` from **every** context including
subagent contexts, and we deliberately do not pass the skills field in an agent
definition. The same agent on Pi has its skills. A user does not experience this
as an architecture decision — they experience their `code-review` agent being
dumber on one runtime. Fix it, or say it in the UI; silently is not an option.

### R11 — tell the user what a runtime switch costs them

Measured differences that are inherent rather than fixable, and today invisible:
a plan is a durable file with revisions on Pi, SDK-internal state on Claude, and
does not exist on Codex (it has a todo list); the model can ask the user a
question on Pi and not on Claude; subagents have skills on Pi and not on Claude;
the model can invoke a slash command on Pi only; the sandbox is our policy on Pi,
off by owner decision on Claude, and a real enforced `sandbox_mode` on Codex.

The target says switch friction is ours to absorb. **Absorbing it honestly
includes naming what cannot be absorbed.** A "what changes if you switch" panel
beats silent degradation — a user moving Pi → Claude loses three capabilities
today and is told nothing.

### REFUTED — do not retry: giving plan mode back to the SDK

Recorded so nobody spends a second week on it. `permissionMode` is a single
scalar: a session cannot be in `plan` and `bypassPermissions` at once, so this is
not adding an option, it is swapping the permission engine mid-flight. Claude
Code's own documentation states that in sessions where bypass is available it
does not enforce plan-mode blocking — the model is merely told to plan, and an
edit it attempts still runs. So we would trade a hard block for prompt text. And
if the bypass is removed to make plan real, the plan-approval request arrives
through `canUseTool`, which unconditionally allows — the plan would
self-approve and the plan card would never render. Finally, `plan` is our
no-write floor when switching runtimes, and Codex has no native plan mode at
all; making `plan` mean three different things breaks the switch guarantee.

**The generalizable lesson, worth more than the row:** the dead `canUseTool` is
not one gap among many. It is the root that kills several apparently cheap
restorations, and any "let us give Claude back feature X" discussion ends there
until R1–R3 land.

## P.3 Rows to be added

These are known-pending and will be written as rows when their analysis lands,
so nothing is silently dropped:

- The clean-runtime gap analysis (in flight 2026-08-16): where we exceed the
  supplier role, what is inertia versus necessity, and what could be simplified
  or deleted under a committed as-is posture.
- Runtime-switch friction that should be **surfaced** to the user rather than
  hidden — the 26 session tools absent on Codex are the known example.
- Anything the boundary record lists under *"honest uncertainty"* that turns out
  to matter, notably the two stale in-code comments it found (`codex-agent.ts`
  claiming the approvals bridge is future work when it exists; `claude-agent.ts`
  claiming file tools are disabled when `disallowedTools` does not list them).


## P.4 Execution schedule — measured, not assumed

Produced 2026-08-16 by taking a file-level footprint of every row and scheduling
waves that cannot collide. **Zoning is by FILE, never by subsystem** — this
repo's own trap list is explicit that two agents editing one file cross by
construction and each lands under the other's subject, and partial staging is
unavailable here.

**The bottleneck is one file: `packages/shared/src/agent/claude-agent.ts`.**
R1, R2, R3, R7 and R10 all edit it (measured), and R8, R9 and possibly R5 reach
into it too — five confirmed, up to eight of eleven. Worse, the key edits sit
inside a **single object literal** (`const options: Options = {`, ~415 lines):
`disallowedTools`, `permissionMode`/`allowDangerouslySkipPermissions`,
`continueWith`, the `switch (checkResult.type)`, and `canUseTool`. **The core
chain R1 → R2 → R3 → R9/R10 → R7 does not parallelize at all.** Everything that
can genuinely shorten this plan lives outside that file: R4, R6, R8, R11 and
half of R5.

**Four secondary serializers, each able to ruin a wave on its own:**

| File | Rows | Rule |
| --- | --- | --- |
| this plan file | **all eleven** — the repo rule flips a tracker row in the task's own commit | commits inside a wave queue: the second agent waits for the first, re-reads, then commits |
| `i18n/locales/{en,ru}.json` | R11 certainly; R5 and R8 likely | exactly one row per wave may add locale keys |
| `agent/claude-runtime-agents.ts` | R2, R3, R10 | separated across waves below |
| `agent/index.ts` (barrel) and `docs/architecture/runtime-control-boundary.md` | any row exporting a new helper; R2/R3/R11 for the doc | treat the barrel as part of the `claude-agent.ts` zone; name one owner per wave for the doc |

**Waves.** W1: R8 ∥ R6 ∥ R4 ∥ the R7 live-day gate (four different owners, and
the gate writes nothing). W2: R1 alone. W3: R2 alone. W4: R3 alone **and no
other agent runs tests in that wave** — it needs the full suite, with
`rm -rf release` first. W5: R5 ∥ R10, **conditionally** — safe only if R3 puts
the Claude mode table in a new module rather than in `claude-runtime-agents.ts`.
W6: R9 alone. W7: R7 step 2 ∥ R11 (agent code vs renderer; R11 owns the locales
and the architecture doc that wave). W8: R7 steps 3–4 alone.

**Verification serializes even where edits do not.** Two concurrent `bun test`
runs manufacture failures here — several session suites mutate
`process.env.NESSY_CONFIG_DIR` at module scope. Edits may overlap; runs take
turns, on the same token as commits.

**Critical path: R1 → R2 → R3 → R5 → R7 (step 2 → 3 → 4).** Six sequential
waves, none compressible: R3 without R1 regresses Safe Mode, R3 without R2 gives
a self-approving `canUseTool`, and R7 step 3 changes permission mode live and
rests on R5's table. The other six rows fit entirely in the shadow of that path
and add nothing to it — **provided R8 lands in W1 rather than later**, since it
is also R7's step 0.

**Cheap insurance, to be prescribed rather than discovered: R3 must put the mode
translation table in its own new module.** If it lands in
`claude-runtime-agents.ts`, W5 collapses and R5/R10 serialize, costing a wave.

**Explicit prohibition: R2 must not edit `core/pre-tool-use.ts`.** That file
serves Pi as well, and `requiresUserInteraction` is a documented floor there; a
fix for the double prompt belongs inside `claude-agent.ts`. Entering it collides
with R6 and with any Pi work.

**Where this schedule rests on inference rather than measurement** — each is a
potential collision, and a collision costs more than running the row alone:
whether R3's table lands in a new module (medium confidence, and the insurance
above removes it); whether R2 reaches into the shared gate (low confidence,
prohibited above); whether R1's helper extraction pulls in the barrel (medium —
the executor's choice, and it changes the zone); and R8/R9/R10/R11/R5/R6, whose
footprints came from the plan's prose rather than from a measured pass — **R9 is
the most dangerous of those**, since whether it sits in `claude-agent.ts` or only
in the session-tools handler decides whether it needs a wave of its own.

## Execution protocol

Repo standing rules bind here and are restated because they have each caught a
defect on the neighbouring plan: per-task re-verification of anchors before
starting a task, with corrections landing in the same commit; a rule-8 stop when
a correction changes a task's **approach** rather than its coordinates; tracker
rows flipped in the commit that lands the task; nothing committed behind a red
check; `grep -a` for every absence claim, and no bounded search used as evidence
of absence.

**One trap this plan inherits, measured on the neighbouring plan 2026-08-16:** a
default's blast radius is every test that wrote the old default down as an
assumption, which is **not** the same set as the tests near the code. "Green
across the affected areas" missed a red test two packages away. Any row here
that changes a default runs the full suite before claiming green.

## Close-out

Version bump in both `package.json` files in lockstep, one **new**
`apps/electron/resources/release-notes/<version>.md` (never edit an existing
one), affected `docs-site/` pages, regenerate the parity report and the
deviation register if any tracker string moved, and update
`docs/architecture/runtime-control-boundary.md` where a row changes what it
records. **Do not delete this plan** — it is where these decisions' reasons live.

## Tracker

| Task | Lane | Status | Commit | Note |
| --- | --- | --- | --- | --- |
| R1 speak the SDK's permission vocabulary | R | ✅ | | Reviewed by a second agent: **accept, zero blocking findings.** **A SECOND defect was found that the row did not know about, and it is bigger than the one it was written for:** ASK was expressed as a TOP-LEVEL `decision: 'ask'`, but `hooks.md` says PreToolUse "returns its decision inside a `hookSpecificOutput` object" and the SDK's own `SyncHookJSONOutput.decision` admits only `'approve' \| 'block'` — so **the trusted-hook ask floor reached the runtime as silence.** It never asked. Now `permissionDecision: 'ask'` with the text in `permissionDecisionReason`. The row's original subject — allow carrying no decision at all — is closed alongside it. DENY was already correct (`mode-manager.ts`, outside the zone) and was left alone. **Typed against the SDK's own `HookPermissionDecision`, not string literals**, so a rename fails at compile time; plus a run-time guard that re-parses the union out of the installed `sdk.d.ts`. **Three mutation controls, each reverted byte-identical:** removing the field → 7 fail; forcing `'ask'` always (a real decision change, the exact bug the row warns about) → 5 fail; re-adding the deprecated top-level field → 1 fail. I re-ran the first myself: 17/0 green, 10/7 red with the field commented out. **The honest limit, stated by the implementer rather than glossed:** the SDK's interpretation of a hook payload lives in a 255 MB native binary, not in JS, so no unit test can execute it — what is proven is that our payload means "skip the prompt" under the DOCUMENTED reading and that the old one did not. The behavioural half belongs to R3's live Safe-Mode case. \| Measured: `hooks.md` says `permissionDecision: "allow"` is what skips a prompt; our hook returns `continue: true` with no such field on the allow path. Invisible today because `bypassPermissions` means there is no prompt. PREREQUISITE OF R3 — without it, dropping the bypass makes Safe Mode prompt on every read-only command. |
| R2 route `canUseTool` for `AskUserQuestion` | R | ✅ | | Reviewed by a second agent: accept, zero blocking. **The stub's "yes" was NOT latent — it was already live, and that is the row's biggest finding.** Its comment claimed the SDK never calls `canUseTool` under `bypassPermissions`; `permissions.md` puts three routes AHEAD of the permission-mode step, each qualified *"even in `bypassPermissions` mode"* — an `ask` rule from settings, a tool requiring user interaction, and an org-`ask` connector tool. We pass `settingSources: ['user','project','local']`, so **a user's own `ask` rule was loaded, reached the callback, and was auto-approved on their behalf.** R3 does not make this live; it only widens it. **A double prompt was caught before it shipped:** the shared gate classes `AskUserQuestion` as interaction-required — correct for Pi, where that gate IS the ask surface — so on Claude the user would have answered a permission card and then the question. Suppressed inside `claude-agent.ts` only, narrow to this tool and this floor, with the gate's classification asserted rather than assumed so a future move fails here instead of producing a second card. **Two defects the SDK's typings caught that no page mentions:** multi-select answers are a comma-joined string in the type while the page shows an array, and `afkTimeoutMs` is the SDK's own away channel — the prose-only route would have borrowed `response`, which REPLACES the answer list and would have discarded real selections. **Six mutation controls, file restored byte-identical each time**; the strongest is that disabling the subagent guard makes a subagent's question HANG on a card nobody can answer rather than deny. **MUST-FIX HANDED TO R3, and it is a live behaviour change created by the R1+R2 PAIR:** the non-question branch now hard-DENIES with no prompt, so (a) a user's `ask` rule turns `git push` into an impossibility they are never asked about, and (b) a trusted automation's `ask` decision does the same — case (b) was named nowhere before the review. Before R2 both were silently auto-approved; now both are silently refused. Neither is acceptable and R3 must replace the refusal with a real card. \| Landed. **The hazard was not latent — the stub's "yes" was already live.** Its comment said the SDK never calls it under `bypassPermissions`; `permissions.md` puts three routes AHEAD of the permission-mode step — an `ask` rule from settings.json, an org-`ask` connector tool, and interaction-required tools — each "even in `bypassPermissions` mode", and we pass `settingSources: ['user','project','local']`, so a user's own `ask` rule was reaching the callback and being auto-approved on their behalf. **Decision on the non-question kinds, taken from the two the row allowed: they REFUSE, they do not route.** Fail-closed, and it does not pre-empt R3 (which replaces the refusal with a real prompt) or R5 (which owns the mode table). Returning `null` was checked and is not a third option — the SDK types it as "the tool stays blocked indefinitely — permission prompts have no park deadline". **A double prompt would have shipped and was caught before it did:** the shared gate marks `AskUserQuestion` interaction-required (correct for Pi, where that gate IS the ask surface), so the user would have answered a yes/no permission card and *then* the question, since the SDK routes the call onward regardless. Fixed inside `claude-agent.ts` per the plan's prohibition, via a narrow predicate — only this tool, only the interaction floor; `dontAsk` still lands in the gate's `block`, which is the documented outcome. **Two defects the SDK's own `sdk-tools.d.ts` caught that no page mentions:** `AskUserQuestionOutput.answers` is typed `{ [k: string]: string }` ("multi-select answers are comma-separated") while `user-input.md` says "pass an array of labels" and its Python sample does — so multi-select is joined, not passed as an array; and `afkTimeoutMs` exists ("Set when the dialog auto-resolved after this many milliseconds of idle"), which is the SDK's own away channel, so an auto-continue now keeps BOTH its selections and its away signal instead of borrowing `response`, which REPLACES the answer list. **Six mutation controls, file restored byte-identical each time (sha verified):** restoring the stub → 17 of 32 red; re-banning the tool → 1; disabling the subagent guard → the subagent case hangs to timeout rather than denying; dropping the multi-select join → 2; disabling the double-prompt deferral → 2; dropping `afkTimeoutMs` → 2. Subagents are excluded at the one enforcement point we own (`agentID`), because `user-input.md` says "`AskUserQuestion` is not currently available in subagents spawned via the Agent tool" and a vendor change must not be able to put a card on screen from a context the user has no frame for. **Honest limits:** the SDK's consumption of the envelope runs in the native binary and no unit test can execute it, so the field names are re-parsed from the installed typings at run time and the behavioural half belongs to a live case; and this bridge is in-memory per agent — Pi's durable `askUserPort` is created only for `provider === 'pi'` in `SessionManager`, so a question does not survive a restart here, the same limit the MCP elicitation path already accepted. \| The disallow reason at `claude-agent.ts:1427-1430` is stale — the UI exists and our types match the SDK envelope. Required even with R1 perfect: the field table carves out "tools that require user interaction" from `"allow"`. PREREQUISITE OF R3. Enabling without routing auto-answers every question with nothing, silently. |
| R3 drop `bypassPermissions` | R | ✅ | | **The Claude runtime now decides for itself: their mechanism runs, our decision answers it** — the shape Codex already had. Landed in the order the row demanded. **(1) The must-fix R2 handed it:** the non-question branch no longer hard-denies; it raises the SAME permission card the gate's prompt branch raises, so an `ask` rule and a trusted automation's `ask` both reach a human instead of being refused. Both before-states are kept verbatim as negative controls — the auto-approving stub R2 removed and the blanket refusal R2 introduced — and the test asserts they decide in OPPOSITE directions and that neither ever put a card on screen. **(2) The mode**, in its own new module so W5 does not serialize. Two non-obvious calls: `explore` maps to `default` because the SDK has no member for it and it stays ours layered on top; and `plan` maps to `default`, NOT to SDK `plan`, because SDK plan routes file-edit and shell-write tools to the callback regardless of allow rules — the plan and session files the agent writes in exactly that mode would each raise a card they do not raise today — and because handing plan mode to the SDK is this plan's own REFUTED row. Nothing is lost: the no-write floor is our hook's deny, which applies even under bypass. Monotonicity asserted over the whole table (a stricter Nessy mode never maps to a looser SDK mode) with a live mutation control. **(3) The bypass itself** is gone, and `allowDangerouslySkipPermissions` now rides only with the one mode the SDK types it for. **BLOCKING FINDING FROM THE REVIEW, fixed before commit: a DOUBLE CARD for exactly the users this row targets.** Our hook is step 1 and the ask-rule check is step 6, and `permissions.md` says a hook's `allow` "does not skip the deny and ask rules below" — so a `git push` we prompted for and the user approved was re-routed and asked AGAIN, indistinguishably. Measured against the shipped default policy: it returns `prompt` in `default`, `acceptEdits` and `auto`. Fixed with the same principle the gate already states one line above its own return — one Nessy approval satisfies both — by recording the approved `tool_use_id` and consulting it before raising a second card. Negative control: disabling the suppression makes the double-card test hang on a card that should not exist; restoring it returns 19/0. **Also corrected in the same change:** `resources/docs/permissions.md`'s false sentence calling `permissionDsl` the Pi runtime's format. **Release note owed:** a user with an `ask` rule is now prompted where the bypass previously ran the call — their own rule doing what they wrote. Full repository run: 13 944 pass, 19 skip, 0 fail. \| **The must-fix came first and it is the bigger half.** R2's blanket `deny` on the non-question branch is replaced by the SAME card the PreToolUse `prompt` branch raises and the Codex path uses, so both victims are fixed: a user's own `ask` rule now asks (it made `git push` impossible before, unasked) and a trusted automation's `ask` now asks (case (b), named nowhere before R2's review). Both before-states are kept verbatim in `claude-can-use-tool-approval.test.ts` as negative controls — approving is what R2 removed, refusing is what R2 introduced, and the fix is neither. **The mode table is a NEW module** (`claude-permission-mode.ts`), per the schedule's cheap-insurance rule, so W5 does not collapse. Five of seven modes are identity; `explore` and `plan` map to `default` — **not to SDK `plan`**, because SDK plan "routes file-edit and shell-write tools to your `canUseTool` callback regardless of allow rules", which would put a card in front of the plan file the agent writes in exactly that mode, and because handing plan mode to the SDK is the REFUTED row. Neither loses anything: `default` auto-approves nothing, and the no-write floor is our hook's deny, which "applies even in `bypassPermissions` mode". `allowDangerouslySkipPermissions` now rides with the one mode the SDK types it for instead of with all seven. **Two corrections to the row's own framing, measured:** deny and ask rules from `.claude/settings.json` were ALREADY reaching the SDK under the bypass (its own table exempts them) — what suppressed them was the stub `canUseTool`, not the mode — and the compiled `permissionDsl` stays Pi/Codex-only, because the SDK reads the settings files itself under our `settingSources`. Both are now written down instead of implied. **Six mutation controls, both files restored byte-identically (sha verified):** the pin back → 1 red; R2's refusal back → 10; no `dontAsk` guard → the card hangs to timeout rather than denying; `toolUseID` as the card key → 1; `plan: 'acceptEdits'` → 2; R1's `permissionDecision` removed → 11, which is what proves the Safe-Mode end-to-end case is not vacuous. **Honest limit:** the binary interprets `permissionMode` and the hook payload, so no unit test executes it — the behavioural half (no card on `git status`, a card on `git push` under an ask rule) is a live case. **RELEASE NOTE, do not lose at close-out: a user with an `ask` rule will now be prompted where Safe Mode previously auto-allowed.** \| DEPENDS ON R1 + R2. The row that actually makes Claude "clean": their mechanism decides, our decision answers it — the shape Codex already runs. Lands the P1 defect with it: Claude-format rules are compiled (`permissions-config.ts:511/:423`) and consumed only Pi-side, so today they are honoured everywhere except Claude. Corrects `resources/docs/permissions.md:182` either way. Full suite, not affected areas. |
| R4 alias map for vendor tool renames | R | ❌ | | **REFUTED — owner decision 2026-08-17, taken after the row's justification was found wrong and rewritten. Recorded so it is not raised again.** The mechanism is `toolAliases`, and the SDK types it in one sentence: the alias applies "when the model emits a `tool_use` whose name is a key in this map", and it "only affects name-based lookup of model-emitted `tool_use` blocks". Its documented PURPOSE is the reverse of ours — the example is a host that runs Bash in a remote sandbox setting `{ Bash: 'mcp__workspace__bash' }` so a model told by a skill document to call `Bash` is routed to the host's own tool "instead of failing as unknown". **Neither historical break is caught.** `input.lsp` → `lspServers` is a plugin-manifest FIELD name, not a tool name — a tool-name map could not reach it in principle. `Task` → `Agent` runs the other way: the vendor renames, the model emits the NEW name, and what fails to recognise it is OUR OWN string comparisons (`PARENT_TASK_TOOLS`, the display table, the ban lists). The SDK's lookup is not where our break lives. **The residual value I expected does not exist either, and this is what settled it.** I assumed we could at least pin names where we substitute our own tools for built-ins. We do not substitute: a Claude session is handed `tools: { type: 'preset', preset: 'claude_code' }` — the whole built-in set — and `CLAUDE_SESSION_DISALLOWED_TOOLS` removes exactly three (`EnterPlanMode`, `ExitPlanMode`, `Skill`), none of which we re-serve. So the built-in `Read`/`Write`/`Bash` the model calls are the SDK's own, and there is nothing to redirect them to. **Gain: zero today. Cost if built: a layer with no live reason, which the next executor reads as a working defence against vendor renames and builds on.** That false confidence is the actual harm — we would not survive such a rename, and the map would suggest we would. **When it becomes applicable:** the day we do start serving our own tools in place of built-ins, this is a NEW row with a real reason, not this one revived. **Side finding, filed separately:** the comment beside the tool configuration in `claude-agent.ts` claims "file tools are disabled (use MCP)". Measured false — only the three above are disallowed. The comment misleads its next reader and is fixed on its own row. \| **THE ROW'S JUSTIFICATION IS WRONG, and it was about to be put to the owner as the basis for a decision — verified 2026-08-16 before that happened.** The claim was that `toolAliases` would have absorbed both production breaks. The SDK's own typing states the scope in one sentence: the alias "only affects name-based lookup of model-emitted `tool_use` blocks", applied "when the model emits a `tool_use` whose name is a key in this map". Against that: **(1) `input.lsp` → `lspServers` is a plugin-manifest FIELD name, not a tool name — a tool-name map could not have caught it in principle.** Answer final. **(2) `Task` → `Agent` runs the wrong way.** The map redirects a name the model emits to a tool we resolve; our failure mode is the reverse — the vendor renames, the model emits the NEW name, and our own string comparisons (`PARENT_TASK_TOOLS`, the display table, ban lists) do not recognise it. An alias map cannot repair our comparisons, because they are not the SDK's lookup. **What it would genuinely buy, stated at the right size:** it can PIN the name for tools we serve ourselves, so a vendor rename does not change the name our code sees. For SDK built-ins the SDK owns both sides and no protection follows. **So the decision the owner should be given is not "buy uptime at the cost of a signal" but "pin our own tool names against vendor drift, worth roughly one of the two historical breaks and neither one fully".** Re-scope the row before asking. |
| R5 one mode vocabulary, three honest translations | R | ✅ | 53a2303eb | **The review returned CHANGES REQUESTED and the finding was real, which makes it the most valuable thing this row produced.** Landed as built: the codex seven-way switch becomes a frozen table (behaviour byte-identical, proven by the adapter's own pre-existing pin over all seven modes); the adapter's hand-copied duplicates of `PERMISSION_MODE_ORDER` and the clamp — whose own comment has always said "a reordered entry here is a silent widening with no type error" — are exported and asserted element-for-element and over all 49 (requested, parent) pairs; one `it.each` row asserts all three runtimes per mode from a hand-written table. **The blocking half: the row's named invariant, "no mode silently widens on any runtime", was passing GREEN over the one real widening, and it is the shipped default.** `dontAsk` + sandbox-off emits `danger-full-access`/`never` — no sandbox, no approval channel, R6's answer never consulted. The test ranked `never` as unconditionally stricter, which is true only while a sandbox bounds it; `config-writer.ts` says so in its own comment and the ranking contradicted it. Ranking is now sandbox-conditional, the one affected pair is excluded BY NAME, and the defect is asserted in `R5-KNOWN-WIDENING`, a characterization test that states it is wrong and **goes red when it is fixed**. The fix belongs on the codex answer path — **new row R13**. **Four mutation controls, `config-writer.ts` restored to sha `ac728414…` each time:** swapping `plan`/`default` in the order — a genuine silent widening — left the entire pre-existing adapter suite green (243 pass) and turns the new one red on 2; deleting the incomparable-pair line, 40 pass before, 2 red after; widening `plan`, 3 red; inverting `explore`, 4 red. **A defect in my own test was found by control 3:** the no-widening loop's negative control originally demonstrated a failure that invariant structurally cannot produce; the loop's honest limit is now written into the file. **Two recorded bounds corrected:** a grep note claimed five hits for a command returning seven, and a production comment asserted codex writes "without ever raising an approval" — an absence nothing here executes codex to prove, contradicted by a live record showing a card under the same policy. **Deliberately NOT done, with reasons:** the user-facing strings are still runtime-independent and false on Codex (`mode.dontAskFullDesc` is the exact inverse there) — that is R11's subject and it is now R11's most concrete case; and the four-mode collapse could not be fixed here because with the sandbox off every config-side narrowing is inert. Suites: 28 new + 32 claude-mode + 60 shared-mode + 40 adapter, 0 fail; `typecheck:shared` and the adapter's typecheck both exit 0. \| Owner decision 2026-08-16: one user-facing set, translated per runtime; a per-runtime vocabulary was rejected because a mode states user intent and switching runtime must not change the words under the user. Weak point to close: four of seven modes map to the identical Codex pair, distinguished only by our answer, with nothing asserting it. R3 also needs a mapping onto Claude's own `permissionMode`, which does not exist yet. |
| R6 permission rules are not consulted on Codex | R | ✅ | | Implemented, then **the review caught TWO PERMISSION WIDENINGS, both measured on the real seam, and both are why this row nearly shipped worse than it started.** (1) The answer read `permissionDsl` alone and ignored the unconditional floors, so an ordinary allow rule auto-approved a write to a private-key path that `mode-types.ts` documents as "must not be read or written in any permission mode" — no card. (2) It never consulted the session's permission MODE, so in `plan` an allow rule auto-approved a write command. That one matters most here: with sandbox off by standing decision, `config-writer.ts` emits `danger-full-access` for every mode, so **the card was the only thing carrying a read-only mode's intent to codex**. Fixed by checking the rule's allow against `shouldAllowToolInMode` — the same call Pi's answer path makes. **The first guard was too STRICT and that is worth recording:** refusing whenever the mode would not allow made the row inert, because a rule exists precisely to pre-approve what the runtime would otherwise ask about. The line that works is Pi's own: a rule may answer where the runtime would ASK, never where it REFUSES — floors (`denyPathBlocked`, `askRuleDenied`) and read-only modes block the answer; `dontAsk` deliberately does not, since its contract is "never prompt; run what the rules pre-approve". A rule `deny` needs no such check — refusing never widens. **Negative control on the fix itself:** disabling the guard turns exactly the two widening tests red (17/2), restoring it returns 19/0. **A leak in my own tests was found the same way:** permission mode is stored per session key and every agent in the file shares one, so the read-only case leaked into the positive control until it set its mode explicitly. \| Measured: `codex-agent.ts` has no reference to `runPreToolUseChecks`, `permissionsConfigCache` or `permissionDsl`; approvals go straight to the human. So after R1–R3 one rule behaves the same on Pi and Claude and differently on Codex. Make our ANSWER rule-aware; do not add a gate in front of Codex. Honest limit: Codex has no per-tool permission concept, so a rule can shape our answer and never its config. |
| R16 anything a backend yields after `complete` is discarded | R | ✅ | e4b387a49 | **FIXED AND PROVEN LIVE, `e4b387a49`.** Both halves now run at the `complete` yield itself, which is the last point the session is still reading. **R9's half:** the drain runs there, so the model's `/compact` is actually honoured instead of being promised. It also puts the banner BEFORE the completion, matching the user-typed path — an ordering an earlier row had recorded as a known residual and named as the cause of the badge defect. It was never the cause; it is now incidentally correct because the fix for the real one required it. **R14's half:** the corrected size rides a NEW optional `contextTokens`, not `inputTokens`, and a test caught why that distinction is load-bearing after my first draft claimed the opposite. `inputTokens` is what the usage metrics export as real consumption, and on a compaction turn that consumption IS the whole pre-compaction conversation — the model was sent all of it to summarize — so overwriting it would have understated spend by everything the compaction dropped. The new field answers the other question: how much context the session is left holding. A backend that omits it behaves exactly as before. **A second correction from the same suite:** the drain reads the nested turn's `contextTokens` and not its input, because the nested turn's own input is the pre-compaction conversation — the very number this row exists to stop showing. **And the discard-on-error case was sharpened:** its fixture used to yield a result and THEN throw, which is not a failed turn — the SDK had reported its result and the stream died afterwards, and that turn has earned its compaction. It now throws before any result, so no completion is emitted, the drain is never reached, and the parked request dies with the turn. **Live proof from the case that found the defect:** badge 62 660 → 2 782, matching the runtime's own recorded post-compaction figure. Suites: 15 on the seam, 51 across the Claude agent files, 385 in the session layer, `typecheck:all` clean. \| **MEASURED LIVE 2026-08-17 by CRU-2, and it makes TWO rows that passed their unit tests inert in production.** `SessionManager.sendMessage` processes a `complete` event and then `return`s out of the whole function — the comment on the line says so ("Exit function, skip finally block") — and its `finally` calls `chatIterator.return?.()`, which unwinds the backend generator at its current yield. **Code placed after the `complete` yield in `chatImpl` therefore never runs.** **Consequence 1 — R14's reassert is dead.** The live event sequence, read from the app's own log, is `usage_update`(post_tokens) → `info: Compacted Conversation` → `complete`, and then nothing: the second `usage_update` never appears. So after a compaction the context badge keeps whatever `complete` assigned, which on a compaction turn is 0 — the badge reads EMPTY beside a banner saying the conversation was compacted. Measured three times: runtime recorded 63 600 → 2 789, badge `null`. **Consequence 2 — R9's deferred compaction is dead, and this is the worse half.** `drainPendingModelCompaction` sits in the same unreachable region, so the model's `/compact` on Claude parks a request that never runs while the tool answers "Queued: the session context will be compacted as soon as this turn ends." **A promise that is never kept is worse than the error it replaced.** **Why both suites were green:** a unit test drives the generator to exhaustion; the real consumer stops at `complete`. This is the exact shape the repo's own trap list warns about — verify the CONSEQUENCE, not the identifier — and neither row's mutation controls could see it, because they exercised the generator, not the session. **The fix is a design decision, not a move.** For R9 the work must happen BEFORE `complete` is yielded (drain at the point the SDK's result arrives, then let the turn finish). For R14 that is not enough on its own: `complete` ASSIGNS `inputTokens`, so an earlier `usage_update` is overwritten by the very event that ends the stream — the choice is between rewriting the `complete`'s own `inputTokens` (which is also what `recordUsageMetrics` exports as OTLP consumption buckets) and giving the consumer a reason to read one trailing event. Decide with the accounting in front of you. **Do not close R9 or R14 until this lands** — both are currently recorded as done and are not. |
| R7 the live session — Claude's session outlives the turn | R | ⏸ | | **DEFERRED TO ITS OWN PLAN 2026-08-17, and the deferral is the honest call rather than a convenience.** This row is not a task, it is a design: five steps with two stopping points, a judged panel behind it, and a gate of its own. Carrying it as one line of another plan's tracker understates it. **Its gate is now PARTLY satisfied and that is worth recording precisely.** The live day happened (see the 2026-08-17 run in `docs/testing/cdp-live-checklist.md`) and closed several of the plan's unverified claims — but not this row's. What was measured live: permission decisions and a user's own `ask` rule on Claude, the compaction badge, per-direction switch costs, runtime-aware mode notes, a subagent's declared skills, and runtime switching itself on live sessions. What was NOT: a session held open across three turns, a background command inside one, a live model or mode change through streaming input, or a network cut. Those four are this row's own subject and none of them was exercised. **What the day DID settle for it, and it changes step 1.** R16 measured that `SessionManager.sendMessage` returns on `complete` and unwinds the backend generator — so a live session that outlives the turn has to answer a question this row never asked: what consumes its stream between turns, given the current consumer stops at the first completion. That is a design input the panel did not have. **Also settled:** the row was once recorded as blocking R9. It does not — R9 shipped without it, because the SDK's own note admits a resumed session, which is what our turns already are. Start the new plan from the design in this row plus those two findings; do not re-derive it. \| DESIGNED 2026-08-16 by a judged panel; no longer a bare spike. Streaming input is the SDK's own *"preferred way"* and background/long work is reachable only from a live session — the levers exist, nothing is alive to call them. Five steps with two stopping points; step 0 is R8 and step 1 is R1+R2+R3, so this plan's chain is confirmed rather than replaced. Strongest objection conceded: the SDK may coalesce queued messages, so one active turn per session + watchdog + error-settle on session death, native queue later. **GATE: one live day first** — the whole design is documentation and type reading with zero live runs, and one session held open across three turns, a background command, a live model/mode change and a network cut closes six of its seven unverified claims. |
| R8 surface the events the SDK already sends | R | ✅ | | **The enumeration was the deliverable and it was done properly:** `SDKMessage` is 39 members over 11 top-level types, 28 of them `system` subtypes; **12** reached a handler before, **21** more now do. **Seven are dropped DELIBERATELY, each with its reason in the code** — e.g. hook progress is unbounded per-chunk output whose settled `hook_response` follows immediately, so surfacing both prints every hook twice, once in fragments. **A separate defect fell out:** the old chain matched `subtype === 'status' && status === 'compacting'`, so a `compact_result: 'failed'` message — which arrives here and nowhere else — fell through to the unhandled trace and **a failed compaction said nothing at all**. **Two tempting mappings were REFUSED and the refusal is the valuable part:** `task_updated` was not mapped to our `task_completed` and `background_tasks_changed` not to `task_backgrounded`, because those are the Pi background-task bookkeeping seam and `task_completed` can call `deliverMonitorEvent`, which STARTS A TURN — a status patch is not a settled result. A test asserts it. Retry/rate-limit strings reuse the exact keyword vocabulary SessionManager already sniffs, so one renderer chip serves Pi and Claude with no wire change and no new i18n keys — which also keeps this row off the locale files the schedule flags as a wave collision. Drift guard added: a test re-parses the union from the installed `sdk.d.ts` at run time, so a NEW SDK message type fails by name rather than arriving and being dropped. Baseline measured before the change (51 pass) and after (72 pass, +21). \| Our adapter handles 7 of ~40 message types; `task_started`, `background_tasks_changed`, `commands_changed`, `permission_denied`, `hook_*` are dropped. No architectural risk, independent of R7, immediately visible. Cheapest real win here. |
| R9 slash-command dispatcher is Pi-only | R | ✅ | 48edd610f | **The row's premise was half refuted, and the executor stopped rather than invent the missing half — that refusal was reviewed, accepted, and is the reason this row is right rather than merely done.** What the row got wrong, measured: the model-callable list is `compact\|help` on EVERY runtime by a decision recorded in prose (`pi-agent.ts`), so "on Pi the model can invoke a CUSTOM slash command" is false everywhere; the composer's custom-command path is a USER-submission expansion with no model-side consumer; and `/help` already resolved byte-identically on Claude because the shared handler answers it before touching the seam. **`/compact` could not be ported at all** — the SDK's `SDKControlRequestInner` has 36 members and none compacts, `Query` has no `compact()`, and the documented Claude route is a follow-up PROMPT. **It left a live defect inside the row's own scope:** the tool was advertised to Claude's model, our own `/help` text told it `/compact` worked, and every call returned an error. **The design that closed it: the adapter already existed, at the TURN BOUNDARY.** A user typing `/compact` gets it on all three runtimes through three different mechanisms (Pi an RPC, Claude a follow-up prompt, Codex a `thread/compact/start` request). What diverges is not the mapping but the TIMING — a tool handler runs mid-turn and only Pi can compact mid-turn — so the model's request is parked, answered truthfully, and replayed at the boundary through the SAME path the user-typed command uses. No second mechanism, no second command list. **The brief's own premise was checked before building on it, and it held:** the SDK note says the pattern needs prior turns "in streaming input mode **or when resuming a session**", and our Claude turns are resumed one-shots — so R7 was NOT a blocker, correcting the first reviewer, who had recorded this row as deferred behind it. **BLOCKING FINDING, fixed before commit: the change destroyed user input.** The drain nests a whole `chat()` inside `chatImpl`, whose first statement clears `pendingSteerMessage` — so a message the USER typed mid-turn was wiped before the outer `finally` could emit `steer_undelivered`, and SessionManager never re-queued it. No error, no queue entry. Proven by the reviewer with a positive control, now two committed tests; disabling the guard reddens exactly the regression test, file restored byte-identical (sha `fa7cbe15…`). **Known residual → R14.** Suites: 10 pass on the new file, 27 across the four slash-command suites, `typecheck:shared` exit 0. **Codex is a THIRD shape, not a third backend:** `SlashCommand` is in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK` and CodexAgent spawns the session MCP server `--external-standalone-only`, so the tool is never advertised there and a call is refused server-side too — structural, and the only runtime of the three that is currently honest with its model. **Cross-row fact, recorded not acted on:** Claude folded slash commands into Skills (the standalone `SlashCommand` tool is gone from `tools-reference.md` and its page is out of the 174-page index), so model-invoked CUSTOM commands on Claude are gated by the `Skill` ban, which stays for R10's recorded security reason. \| Shared seam, one of three backends filled in. The host already resolves custom commands for the composer, so this is a port rather than a design. Check Codex while there. |
| R14 the compaction lands after the turn it belongs to | R | ✅ | 5c37ebd73 | **Three of the row's four premises were refuted by measurement before any code moved, and the fix was a fourth shape.** (1) The ORDERING was not the cause: both the outer and the nested `complete` carry pre-compaction numbers, so no position of the drain yields a correct badge — shape (b) refuted by measurement, not argument. (2) **The user-typed `/compact` was NOT a correct reference.** The row treats it as the behaviour to match; it carries the identical stale number, on the commoner path — a fix that only reordered to match it would have shipped the defect TWICE. (3) `complete` is not the only place the context size is assigned: `usage_update` assigns it, recomputes the total, updates the window and applies the snapshot, while accumulating no usage, recording no metrics and writing no goal turn. **The surgical instrument the row assumed did not exist was already on the wire.** Also found: the badge that contradicts the banner is pushed by the BANNER'S OWN handler, which is why it is visible instantly. The fix reads `compact_metadata.post_tokens` off the raw boundary message — the only place a post-compaction size exists in the SDK's output, and something with ZERO production consumers before this — typed against the SDK's own message type so a rename fails at compile time. **Two BLOCKING review findings fixed before commit, both measured.** The reassert was unconditional and REGRESSED the SDK's own auto-compaction — the one path that fires without anyone asking and the one this repo has live evidence of: there the boundary arrives mid-turn and the turn CONTINUES, so pinning the badge to the boundary under-reported by up to 72%, replacing a stale-HIGH number with a stale-LOW one. `compact_metadata.trigger` is the discriminator. And both events sourced `contextWindow` from the STATIC model registry, which nothing on the Claude path ever sets and which the gateway's model ids are absent from — so a 200 000 fallback rode while the stream carried a different figure, silently re-sizing the meter's denominator on every compaction. **The auto shape had no fixture at all**, which is why a green suite saw neither; it has one now, and restoring the unconditional reassert reddens exactly it. \| **Found by R9's review, disclosed rather than accepted quietly, and it is a display-honesty defect of exactly the kind this plan exists to remove.** The model's deferred `/compact` is drained after the SDK's result has already been yielded, so the stream is `complete` → `info: Compacted Conversation`; on the USER-typed path the order is the other way round. `SessionManager`'s `complete` case is the ONLY place `tokenUsage.inputTokens` (the current context size) and `applyContextUsageSnapshot` are updated, and the nested turn's `complete` is deliberately dropped to avoid double-billing usage, usage metrics and a goal turn. Net effect: **the banner says the conversation was compacted while every context and usage surface still shows the pre-compaction number**, and the compaction's own cost is never billed. It self-heals on the next turn and cannot loop (auto-compaction is Pi-gated), which is why it is not blocking. **The fix is a judgement call, which is why it is its own row:** either forward the nested `complete` (a compaction IS a real second API call, so billing it may be correct — the question is the goal-turn record), or drain before the outer `complete` is yielded, or emit a usage-only refresh. Decide with the accounting in front of you, not under time pressure. Pinned meanwhile by an order assertion in `claude-slash-command-seam.test.ts` that forces whoever fixes it to update the record. |
| R10 subagents on Claude have no skills | R | ✅ | 1e89d224f | **Landed as the owner decided — bodies inlined, `AgentDefinition.skills` refused — and the review found TWO defects, one meaning the row had not actually shipped.** (1) BLOCKING: the refusal on an emptied tool grant OVERSHOT — it withheld, on Claude only, an agent BOTH runtimes admit. `errors.md`, one sentence past the paragraph it was built on: "Omitting the `tools` field never triggers this refusal. If you leave the `tools` list empty, or `disallowedTools` removes every entry in it, Claude Code also skips the refusal and launches the subagent without tools." And Pi's contrasting `empty intersection` throw sits UPSTREAM of the skill removal with `invocations` voided inside it, so a skill cannot reach it — verified independently. A row written to close a Claude-only gap had opened a different one. (2) HIGH, and why 23 green tests could not have closed this row: **the composition had no production caller** — `buildClaudeRuntimeAgentOptions` was invoked without the payload, so a real turn still sent a bare `systemPrompt`. A tested, unreachable library. That was a ZONING consequence (the executor was fenced out of `claude-agent.ts` while R9 was live there) and the orchestrator finished it: materialization now runs in `chatImpl` from the session's pinned capability view, and the seam suite asserts it end to end — **removing the one wiring line turns the new test red**, restored byte-identical, sha verified. All four restrictions ride along, each separately load-bearing: per-skill `disallowed-tools` written to BOTH the grant filter and `disallowedTools` (an omitted `tools` inherits everything, so the filter alone cannot reach it), the model ceiling compared against the EFFECTIVE model, the agent ceiling by key/name/inherit, and the per-body cap plus the aggregate budget. Prompt composition is asserted against Pi's own renderer rather than a hand-written string. **Two corrections to my brief:** Pi's spawner inlines nothing — it forwards `skillKeys`, and the inlining is host-side in `SessionManager`'s child-session admission, which is what was ported; and `parseRuntimeSkillContextCommands` is not the entry point. \| **OWNER DECISION 2026-08-16, taken on an analysis rather than on the binary the row was written as: do what Pi already does — inline the skill bodies ourselves, before the agent definition goes to the SDK.** The machinery exists and lives in the shared package, not the Pi-specific one. **The obvious fix was REFUTED and it is dangerous, which is why this row is not "pass the skills field":** the SDK reads its own directories, and the only one a live session actually has is `.claude/skills` inside the user's repository — so a name match would substitute an arbitrary unvetted file from the open repo for our vetted skill, silently. Preloading also carries none of our per-skill tool restrictions, model/effort ceilings or token budget, so "restored" would have meant "downgraded, invisibly". **History, because it changes how this should be described:** the `Skill` ban was a real architectural decision imported wholesale from the upstream fork in February — one commit that removed the SDK's skills wiring AND added the ban, with the reason recorded beside it. **The subagent consequence could not have been noticed then: we did not pass the SDK an `agents` option at all until 2026-08-13.** So this is a new consequence of an old decision, three days old, not an oversight. Worth knowing: the same ban list already held one entry surviving on inertia — `AskUserQuestion`, banned for "no UI" long after the UI existed, removed by R2 today. **Gives:** the subagent gets exactly the Pi content, with our substitutions, our execution permission and our budget, and no dependence on which folders the SDK scans. **Gives up:** we do not use the SDK's native field, so its changes must be tracked by hand. \| A session-level `Skill` ban removes it from subagent contexts too, and we do not pass the agent definition's skills field. Same agent, fewer abilities, one runtime. Fix it or say it in the UI — not silently. |
| R13 `dontAsk` on Codex is the loosest mode we ship | R | ✅ | 7b4f8e1fd | **Both halves, because neither alone is a fix.** Config: with the sandbox lifted a `never` row degrades to a policy that still routes to us — keyed off the POLICY, not off `dontAsk`'s name, because the defect is "no sandbox and no approval channel", not one mode. Answer: `dontAsk` is answered and never shown — the rule consult may still allow, everything else is refused without a card. **The executor DEVIATED from my brief and was right.** I prescribed `on-request`; the release schema says it means "The model decides when to ask the user for approval", so a fix resting on it would be inert for every call the model chose not to raise. `untrusted` is the only value stating a routing GUARANTEE. **Its bound is stated rather than hidden:** `untrusted` still auto-approves `is_safe_command()` read-only commands inside codex, so those never reach our answer — a reads-only residual, where the before-state was everything. The deny sits in `handleServerRequest` rather than inside `consultPermissionRules` as the row prescribed, which preserves that function's "null means the rules do not answer" contract. **Review: ACCEPT-WITH-FIXES, nothing blocking; three recorded claims were wider than measured and are corrected.** The biggest: the deny is NOT switch-off-scoped — `mcpServer/elicitation/request` is not a command approval and is not gated by `approval_policy` at all, so it reached us in both switch positions and is declined in both (measured: 1 card before, 0 after). Also a test named for a before-state it did not hold, and an inference about codex's runtime behaviour placed beside three verbatim schema quotes. \| **Found by R5's review, confirmed independently, and it is a permission widening in the SHIPPED default.** `SANDBOX_ENABLED_DEFAULT` is `false` by the standing owner decision of 2026-08-12/13; with the switch off, `codexSandboxConfigForMode` lifts the sandbox to `danger-full-access` and carries `approval_policy` through unchanged. For `dontAsk` that policy is `never` — **the only mode on any runtime with no sandbox AND no approval channel.** Codex raises no request, so `CodexAgent.handleServerRequest` never fires and **R6's rule-aware answer never runs**: the row we just landed is dead in exactly this mode. `dontAsk` means "never prompt; run what the rules pre-approve, deny the rest" on Pi and Claude; on Codex it means allow-everything, while `mode.dontAskFullDesc` still tells the user it "denies everything else". **Not introduced by R5** — R5 turned a switch into a table, byte-identically — and `config-writer.ts`'s own comment already stated the dependency ("`never` is only safe because `read-only` bounds it") before shipping it anyway. **The fix is on the answer path, not in the config:** emit `on-request` for `dontAsk` when the sandbox is off so the request reaches us, and have `consultPermissionRules` DENY by default under `dontAsk` instead of prompting — which is what the mode already means everywhere else. The config alone cannot fix it: any config-side narrowing is inert while the master switch is off. Guarded meanwhile by `R5-KNOWN-WIDENING` in `permission-mode-runtime-translations.test.ts`, a characterization test that asserts the defect and **goes red when it is fixed**, so this row cannot be closed without updating the record. |
| R12 an agent's isolation and hooks are dropped in silence | R | ✅ | 0b937acb2 | **The row's shared premise — that the SDK cannot express these — is FALSE, and the published typings are what is incomplete.** `AgentDefinition` in `sdk.d.ts` declares neither field, but `sub-agents.md` lists both among the fields the agents JSON accepts, the pinned native binary's own schema carries `isolation: enum(["worktree","remote"])` and its converter forwards it, and the SDK's `agents` option reaches that same schema — `sdk.mjs` puts our object on the wire with no field whitelist. **The consumption site settles it:** the binary creates the worktree and refuses to launch outside git, which a decorative field could not do. Two fields, two verdicts, because being found together is all they have in common. **ISOLATION — CARRIED.** Only the author's declaration; Pi's extra rule (isolate any agent whose tools are not read-only) deliberately not mirrored, since Claude's documented baseline is the parent's directory and this file's rule is "Claude runs as-is". Typed through our own one-member union so `'remote'` can never be sent. **HOOKS — ANNOUNCED, not carried, not refused.** What we hold is Nessy's NORMALIZED automations config, not the author's block: a status message vanishes, a timeout changes units, `if`/`async`/`once` are stripped by name — so rebuilding it would either run a command the author did not write or fail the CLI's all-or-nothing parse and **delete every agent in the session**. Refusing was rejected on the trap R10 had just paid for: `SessionManager` builds the component-hook layer for every provider EXCEPT anthropic, so Pi runs the agent AND dispatches its hooks, and refusing here would withhold an agent every other runtime admits. **The announcement reaches a channel the user sees** — the diagnostic channel ends at a log file and is `undefined` outright without a debug sink, so the notice is a separate TYPE routed to an `info`/`warning` event the session persists, de-duplicated on the definition digest. Review: **ACCEPT, nothing blocking.** Three findings folded in: the header now records that the Agent tool's own input ALSO carries `isolation` and **outranks** the definition (`j = s ?? U.isolation`) — load-bearing for a later row; the banner no longer says "around its tool calls" for a stop-only block; and the ordering keeping a refused agent from also raising a hooks banner is now a test — hoisting the notice above the refusal turns it red. **RELEASE NOTE OWED, and the reviewer warned against 'fixing' it by reverting:** an agent declaring worktree isolation now FAILS TO LAUNCH in a non-git workspace and its shell commands are subject to worktree containment. Both are Claude's own documented behaviour, and both are the author's declaration finally being honoured. \| Found by R10's analysis and **heavier than the row that found it.** Translating an agent definition to the SDK's format passes ten fields and drops five: skills, MCP servers, initial prompt, **worktree isolation** and **agent hooks**. The first three have a reason recorded in code; **the last two have a reason recorded nowhere.** So an imported agent that declares it must run in an isolated copy of the repository runs **directly in the user's working directory** on Claude, and nobody is told. That is not a quality-of-answer gap like skills — it decides where files get written. Establish for each of the two whether the SDK can carry it at all; where it can, carry it; where it cannot, refuse the agent or say so at the point of use rather than degrading quietly. Do not batch this with R10 — same discovery, different severity, and a silent isolation drop deserves its own evidence. |
| R15 the permission-mode descriptions are runtime-independent, and false on Codex | R | ✅ | 2e836a1d9 | **The executor widened the diagnosis and the widening is the correct read: this is ONE fact with seven consequences, not three strings.** `runPreToolUseChecks` has no call site in `codex-agent.ts` (control: 10 in `pi-agent.ts`), so nothing of ours inspects a Codex tool call before it runs — every mode's enforcement half is Codex's judgement there, and `dontAsk` is the single exception because we answer it. Hence one general note applied to six modes rather than three bespoke rewrites. **The split, decided before anything was written:** a mode states INTENT, and R5's owner decision says intent does not change with the runtime — so the general string keeps the intent and is true everywhere, and what a runtime can ENFORCE becomes a note rendered only where a runtime is known. **Workspace Settings keeps ONE string, honestly:** it sets a default for a workspace whose sessions pick their own integration and can switch mid-session, so intent is the only thing it can state; both its surfaces now route through the same function with no runtime, making the decision visible rather than implied. **A real bug fell out:** the slash menu re-resolved every mode id from the description keys, discarding what the display carried in — the picker and the menu would have said different things about the same mode in one Codex session. **THREE HIGH review findings, all fixed.** Of the two absolutes, the rewrite had removed the BENIGN one and kept the DANGEROUS one — "never prompts" going means reality has MORE prompts than stated; "no file changes" surviving means reality may have MORE writes, and with the sandbox switch off nothing holds a write back on Codex at all. The note now discharges the write half. The note also roughly DOUBLED the longest description while the composer's dropdown renders one non-wrapping line inside a `w-fit` popover with `overflow-x-hidden` — the tail, which IS the note, was clipped with no ellipsis; it wraps within a bounded width now. And the slash menu truncates by design with the note at the END, so it is recovered on hover: **the two surfaces agreed as strings and disagreed as RENDERED TEXT**, this repo's own recorded trap. Two smaller: the `dontAsk` note described only the sandbox-off default (with the switch ON, Codex raises no command approval at all and runs everything the read-only sandbox permits — wider), and the guard against a copy edit walking the absolutes back in read English only. **One consequence recorded rather than fixed, in the code where it lands:** the menu now honours a backend-supplied description, and the one backend that sends one hardcodes English — right content in the wrong language, in place of wrong content in the right one. Localizing those overrides is a separate change. \| **Found by R5's review, confirmed by R11's, and left deliberately unsurfaced by R11 because it is not a line in a dialog.** The mode descriptions the app renders are one runtime-independent string per mode, and at least three are false on Codex: `mode.exploreFullDesc` says "never prompts" while the emitted `on-request` lets Codex raise a card; `mode.bypassPermissionsFullDesc` says "no prompts" with a live record from 2026-08-11 showing a card under exactly that pairing; `mode.planFullDesc` says "produce a plan" where there is no `SubmitPlan` at all. `mode.dontAskFullDesc` is true after R13 EXCEPT for the `is_safe_command()` reads Codex auto-approves without asking us — the bound R13 recorded. **The row splits in two, and that is the whole difficulty.** The composer's picker CAN be made runtime-aware: `ComposerCapabilities.connection.activeRuntime` is already on the wire and `ComposerPermissionModeOption.description` is already an override seam (Nestor cloud uses it). **Workspace Settings → Permissions cannot** — it renders all seven from `PERMISSION_MODE_ORDER` and a workspace has no runtime, so there is nothing to be aware of; making it honest needs a different design, not a different string. Decide the second half before writing the first, or the two surfaces will disagree about the same mode. |
| R11 tell the user what a runtime switch costs | R | ✅ | 30214a9b6 | **The row's own list of examples was four-fifths false by the time it ran, and that is the finding.** Working from it would have shipped: "the model can ask a question on Pi and not Claude" (false since R2), "subagents have skills on Pi and not Claude" (false since R10), "the model can invoke a slash command on Pi only" (false and never true — R9 measured the model-callable list as `compact\|help` everywhere), and a plan difference framed as durability when the user-visible half is that Codex has no `SubmitPlan` at all. Only the sandbox item survived, reshaped. **The design decision: a cost is a capability the SOURCE runtime has and the TARGET does not — a set difference, not a property of the target.** That makes the list per-direction BY CONSTRUCTION rather than by hand, and every return leg onto Pi correctly lists nothing. Five capabilities, ranked so what happens to FILES is read before what the model can do. **The surface is the pre-switch dialog the user already answers** — the moment they are deciding — not a log line and not a third post-switch toast; the two that exist own what only the server learns while switching. **The rejections are half the work:** a raw tool-count diff would have claimed sixteen losses Pi→Claude, but the task-list tools are replaced by `TodoWrite` in the same projection, so nothing perceivable goes missing — that number would have been a confident lie. MCP resources are a real gap with no UI anywhere, so a user could not connect the loss to the switch. Codex `web_search` is disabled for a measured reason, but whether Claude's own executes through our gateway has never been tested — refused rather than guessed. Agent hooks are already announced per agent by R12. **Two review findings fixed:** the pre-tool-check row claimed Explore and Plan no longer hold back writes, true only while the sandbox switch is off — clause dropped; and `Monitor` had been rejected as "bookkeeping the post-switch toast covers", which is neither (it is *"watch an event source and get interrupted"*, and the toast names plugin monitors that STOPPED, not the ability to START one) — the scheduling copy now covers it. **`runtime-capability-gaps.md` was stale within a day of being written** and is corrected, including three rows whose ARGUMENT decayed rather than whose fact did. \| Inherent differences, invisible today: plan durability, the model's ability to ask a question, subagent skills, model-invoked slash commands, sandbox enforcement. The target makes switch friction ours to absorb; absorbing it honestly includes naming what cannot be. |
| REFUTED — plan mode back to the SDK | R | ❌ | | Recorded so it is not retried. `permissionMode` is one scalar, so this swaps the permission engine rather than adding an option; Claude Code does not enforce plan blocking where bypass is available, so we would trade a hard block for prompt text; removing bypass routes plan approval through the unconditionally-allowing `canUseTool`, so the plan self-approves and its card never renders; and `plan` is our no-write floor on runtime switch while Codex has no native plan mode. |
