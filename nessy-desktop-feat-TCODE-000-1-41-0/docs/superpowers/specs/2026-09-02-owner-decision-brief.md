# Owner decision brief, 2026-09-02 — one sitting, 30 questions

> **Read this first.** Of the 252 open rows in `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`,
> **31 need you** (30 questions — two rows share one) and they name **37 further rows** that move once they
> are answered, three of which are themselves on this list. Everything else is a lane's job or is already
> decided. Each block is self-contained: the question, the options, **what has already been measured — quoted
> from the row, never re-derived**, a recommendation, and what it unblocks. The row classification behind it
> is `docs/superpowers/specs/2026-09-02-open-rows-triage.md`.
>
> **The four that move the most, if the sitting is short:** **§C** the administrator-policy reach — four
> questions, one shape, 6 further rows · **§A4 + §A6** the non-darwin rig, which is one purchase covering 6
> rows and two shipped security defects' shared cause · **§E1** the classifier's real cost — 4 rows, and it
> is 110,519 characters per check · **§I** OQ-14, the fourth runtime — 3 rows, and it exposes a tag pointing
> at the wrong one. A fifth is nearly free: **§A1** decides **§B1** as a side effect.
>
> **A pattern from your own 2026-09-01 answers, used throughout:** where a capability exists on one runtime
> and not the others, you chose **removal or refusal over selective enablement** every time. Each
> recommendation below says whether that pattern applies. It does **not** apply where a capability is absent
> on *all three* — then the question is build-once-in-the-host, which is goal 2.

---

## §A — Permission posture: what refuses, what asks, what a floor can reach

### A1 · `P2.197` — On codex, six of seven permission modes leave the asking to the model

**The question.** On codex, most permission modes tell the runtime *"the model decides when to ask"*. Should
a mode with a non-negotiable floor be allowed to say that?

**Options.**
- **(a) Forbid it** — a mode carrying a non-negotiable floor must not emit `on-request`.
- **(b) Give the floor its own path** that does not depend on the model choosing to ask.
- **(c) Accept it and say so** in the guidance the model reads (see §B1, which becomes a different question).

**Already measured.** *"With the sandbox off, six of seven modes emit `on-request`, and that value's own
schema says «The model decides when to ask». So a command the model simply never raises reaches no gate at
all — the host floor cannot fire on a call it is never told about."* The row also fixes the method: *"drive
it, do not read the schema — this subsystem has been wrong from reading three times today."*

**Recommendation: measure the seven values against the shipped binary, then (a).** On Pi and claude the floor
fires without the model's cooperation; leaving codex dependent on the model's goodwill is a switch-visible
safety difference, which is the one thing that stays IN whatever it looks like. Your removal-over-enablement
pattern applies in its mirror form: make the strictest runtime's behaviour the shared one.

**Unblocks.** `P3.250` (answered for free — see §B1), `P3.236` (browser gate on codex), `P3.77`.

---

### A2 · `P3.214` — A `Read` allow silently grants Edit and Write; a `Read` deny covers more than the page

**The question.** Our permission compiler differs from the documented rule in **both** directions at once.
Does the page govern, or does the safer behaviour?

**Options.**
- **(a) Page governs both** — drop our extra `NotebookEdit` deny too. *Removes a deny from a credential path.*
- **(b) Safer behaviour governs both** — keep the deny, and also keep the allow-widening. *Ships an
  undocumented grant.*
- **(c) Split: remove the widening, keep the extra deny,** and record the reason at the site.

**Already measured.** *"`permissions.md#read-and-edit` states the coupling for **deny** only, and says
«NotebookEdit isn't covered…». We diverge on both sides: **(a)** a `Read` **allow** also grants
Edit/Write/NotebookEdit/Grep/Glob — a **widening we ship**, the loose direction, this fork's recurring class;
**(b)** our Read **deny** covers `NotebookEdit` — the **safe** direction."*

**Recommendation: (c).** The widening is ours and undocumented, so read-don't-invent deletes it; the extra
deny is stricter than a page that explicitly declines to cover the case, so it is a posture we may keep — as
long as it is written down rather than living in a compiler.

---

### A3 · `P2.56` — One of the two permission-mode surfaces ignores the workspace setting

**The question.** A workspace can restrict which permission modes may be cycled. The keyboard honours it; the
click-menu does not. Should the restriction govern both surfaces, or only the keyboard?

**Options.** (a) Make the menu honour it. (b) Record that the setting governs the keyboard path only.

**Already measured.** *"SHIFT+TAB honors the workspace `cyclablePermissionModes`, while the picker ignores it
because `FreeFormInput`'s `enabledModes` prop is declared and never read. So route 1 is INERT on the click
path."*

**Recommendation: (a).** A control that silently stops controlling is the fork's largest defect class, and
two surfaces disagreeing about a permission mode is that class in its purest form. (b) is defensible only if
the setting was always meant to be a keyboard convenience, which nothing says.

---

### A4 · `P2.188` — Our removal floor has never been tested against GNU `rm`

**The question.** Every long-option claim about the command that deletes files is untested on this machine.
Does a Linux runner or container join the verification kit?

**Options.** (a) Yes — one GNU coreutils path in the kit. (b) No — state that long-option coverage is
unverified.

**Already measured.** *"`--dir` alone, unmeasurable on this host for the same reason `--recursive` was: BSD
`rm` rejects long options with `illegal option -- -`, exit 64. **That third item is the interesting one: our
floor cannot be measured against GNU `rm` on this machine at all.**"* Two smaller items in the same row are
measured harmless: a flagless `rm ~` that one matcher misses is non-destructive as written, and an `-i`
over-fire blocks a command that would have asked.

**Recommendation: (a), bundled with the Windows probe of §A6.** Both are the same purchase — one non-darwin
rig — and this plan has already shipped two security defects whose only shared cause was *every probe ran on
darwin*.

**Unblocks.** Reads with `P3.7`, `P3.62`, `P3.129`, `P3.169`, `P3.183`, `P3.191`.

---

### A5 · `P2.267` — A managed lock withholds our permission rules, and its residue can still deny everything

**The question.** When an administrator says *only managed permission rules apply*, we withhold our own
`allow` list. Keep withholding?

**Options.** (a) Keep withholding, write the reason at the site. (b) Carry our `allow` through the filter.

**Already measured.** *"Unlike the two `P2.136` fixed, **its fail-closed outcome is prompting, not a hard
deny** — so withholding is defensible… **What makes it a row anyway:** its `WebFetch(domain:...)` residue can
reproduce the same **deny-all** through the network allowlist, which is exactly the inversion `P2.136` was
about, arriving by a different door."*

**Recommendation: (a) for the lock, and fix the `WebFetch` inversion regardless.** Prompting is the safe pole
and the withholding is now visible where it used to be invisible; the deny-all through the network allowlist
is a separate bug and does not need this answer.

---

### A6 · `P3.128` — Write grants do not work at all under a Windows home

**The question.** Every path the user granted for writing is missed on Windows, including drive-letter
grants. Fixing it widens a grant. Do we fix it now, or with the Windows build?

**Options.** (a) Fix now on darwin evidence. (b) Fix together with a real Windows probe. (c) Leave and record.

**Already measured.** *"Every write grant misses under a Windows home, **including drive-letter grants**:
`C:/ws/**` does not match `C:\\ws\\a.ts` on case alone. **Direction is fail-CLOSED, so this is a usability
defect and not a hole** — a Windows user is prompted for writes they granted… **widening a GRANT is an owner
call, not something to slip into a security patch.**"*

**Recommendation: (b).** You already deferred Windows evidence on 2026-09-01 as a posture; this is the row
that should ride it, because a grant widened on darwin evidence is exactly the shape that hid the two
defects `P3.129` exists to remember.

**Unblocks.** The platform group: `P3.7`, `P3.62`, `P3.129`, `P3.169`, `P3.183`, `P3.191`, and `P2.188`'s
third item.

---

### A7 · `P2.483` — A wildcard in the marketplace **allow**list would admit every marketplace under one owner

**The question.** Our blocklist accepts `owner/*`. Should the allowlist?

**Options.** (a) No — keep dropping it, visibly. (b) Yes — accept it and state that one entry grants an owner.

**Already measured.** *"The blocklist accepts owner wildcards, because a wildcard there **narrows** what is
permitted. Accepting the same spelling in `strictKnownMarketplaces` would **widen a grant**… **Today the
behaviour is honest rather than silent: a wildcard in the allowlist is dropped visibly.** … **Check what the
page actually says about wildcards on the allowlist key before deciding** — `P2.467` measured three rules on
the blocklist that postdate the vendored bundle, so the contract here may be newer than the code."*

**Recommendation: read the page first; absent a documented answer, (a).** Ambiguity resolves toward firing is
this plan's standing rule, and the current behaviour is already honest rather than silent.

---

## §B — What the model is told

### B1 · `P3.250` — Our guidance promises codex a prompt codex does not give

**The question.** We tell the model that edits and mutations *"prompt for approval before running"*. On codex
they do not. Do we correct the sentence, or the behaviour?

**Options.**
- **(a) Fix the behaviour** (§A1) and keep the sentence true.
- **(b) Correct the sentence** — which tells the model, on every codex turn, that our gates are advisory.
- **(c) Leave it.**

**Already measured.** *"On codex with the shipped sandbox-off default all four of those modes emit an
identical `danger-full-access`/`on-request` pair … under which `assess_patch_safety` at `rust-v0.148.0`
returns `AutoApprove` — so an edit runs with no prompt from codex and none from us. … the correction would
tell the model on every codex turn that our gates are advisory, which is a **product posture**, not a string
repair."*

**Recommendation: (a).** Answer §A1 and this row becomes a no-op. (b) is the honest answer to a question you
should not have to answer honestly — telling a model our gates are advisory invites it to act accordingly.

---

### B2 · `P3.158` — `/help` is offered on every runtime and implemented on none

**The question.** Typing `/help` sends an ordinary turn to the model. Do we implement it against our own
command table, or withdraw the command?

**Options.** (a) Implement host-side, once, for all three. (b) Withdraw it.

**Already measured.** *"`parseSessionCommand` has **no `help` kind** … So a user typing `/help` **composes an
ordinary turn and asks the model** — it burns tokens, it can hallucinate, and on a fork of Claude Code the
answer will describe a product that is not this one. **Offered everywhere, implemented nowhere.**"*

**Recommendation: (a).** Your removal pattern does not apply — this is absent on *all three*, so it is
exactly the case where the host supplies it once (goal 2). A model describing Claude Code to a Nessy user is
a support cost, not a feature.

---

### B3 · `P2.322` — Some commands are offered by runtimes that refuse them, and we treat two such commands differently

**The question.** Does a command a runtime cannot perform show as unavailable, or stay silently typeable?

**Options.** (a) Show it as unavailable everywhere. (b) Keep it typeable everywhere. (c) Leave the two
treatments as they are.

**Already measured.** *"`PREFILL_COMMANDS.subtask` prefills `/subtask ` on every runtime, including the three
that now decline it. **Strictly this is correct** per the upstream sentence … **The gap is the middle option
nobody has costed:** `/compact` already marks itself unavailable in the menu on the runtime that cannot do
it, and `/subtask` does not. So we have two different treatments of the same situation, one file apart, and
neither is written down as a decision."*

**Recommendation: (a).** It is the switch-visible-difference rule applied to the composer, and it costs one
renderer rule rather than two divergent ones.

---

### B4 · `P2.320` — `/compact` with a file attached silently becomes a chat message on Claude

**The question.** What should happen when a user attaches a file to a command that cannot take one?

**Options.** (a) Drop the attachment and run the command. (b) Refuse, naming the reason. (c) Do not offer the
command while an attachment is present.

**Already measured.** *"`isSlashCommand` requires `!attachments?.length`, and the seam forwards attachments,
so on Claude a `/compact` **carrying an attachment** still goes through `buildTextPrompt` and reaches the
model as prose. … both plausible answers … are **behaviour changes to a working path**, and picking one
silently is how a user loses an attachment they meant to send."*

**Recommendation: (b), the same shape you chose for `P3.242` on 2026-09-01** — decline and say why, rather
than silently redefining what the user asked for. (a) loses a file the user meant to send.

---

## §C — Administrator and managed policy

*C1–C3 share a single underlying question: **does an organisation's policy bind everywhere, or only where we
happened to wire it?** Answering that once answers all three, and it is the largest single unblock in this
brief. C4 is the related operator-visible question, and it comes with a measured trade rather than a choice
of principle.*

### C1 · `P3.64` — The headless server applies no administrator environment policy at all

**The question.** Our desktop app enforces an administrator's environment policy; our headless server does
not. Should it?

**Options.** (a) Yes — same policy, both binaries. (b) No — a server deployment is legitimately different,
recorded as a decision.

**Already measured.** *"The desktop host applies managed `env`; the headless one does not — so an
administrator's environment policy is enforced or not depending on which binary the user runs, with nothing
saying so."*

**Recommendation: (a) unless `managed-settings.md` says otherwise.** A policy whose reach depends on which
binary the user launches is the silent-divergence class with an administrator as the victim.

**Unblocks.** `P3.53` (managed `immediate` cannot arm a bootstrap exporter), `P3.85` / `P3.261` (a codex-only
fleet gets a weaker guarantee), `P3.66`.

---

### C2 · `P2.496` — A user who turns hooks off does not turn our hooks off

**The question.** The all-hooks-off switch is read at the administrator level only, so a **user** setting it
does not stop the hooks we register — task registry and scheduling projection included. Do we owe the user
tier?

**Options.** (a) Honour the user tier for the hooks we register. (b) Say plainly in the setting that it
governs one tier and not the other.

**Already measured.** *"SDK-registered hooks live on a different tier than agent-frontmatter ones, and the
all-hooks-off switch this fork relies on is read at the **managed** level only… **This is a user-facing
safety expectation, not an internals detail: a user who turns hooks off reasonably believes hooks are off.**
… The second is cheaper and may be correct; the first may be what a user assumes."*

**Recommendation: establish the vendor's intent from the page and the binary first, then (a) for the hooks we
ourselves register.** We chose to register them; a user's off switch should reach our own choices even if it
cannot reach the SDK's. (b) alone leaves the product doing something the user believes it is not doing.

**Unblocks.** `P3.243`, `P3.231`.

---

### C3 · `P3.210` — We apply a telemetry endpoint variable with no approval dialog; the page says it always needs one

**The question.** An endpoint variable is an egress control. Ours is on the looser side of the documentation.
Align, or keep our allowlist?

**Options.** (a) Align with the page — require the dialog. (b) Keep it in the safe allowlist and record why.

**Already measured.** *"The variable is in our known-safe allowlist, so it is applied without the approval
dialog; the page states it always requires one. An endpoint variable is an egress control, so the direction
of the error matters: our allowlist is the **looser** side. Needs a behavioural decision, not a doc edit."*

**Recommendation: (a).** For Claude the documentation *is* the contract for behaviour, and this is the one
category where being laxer than the vendor is hard to defend to an operator.

---

### C4 · `P2.517` — On codex, marking a server as critical and seeing it fail are mutually exclusive

**The question.** An operator's MCP servers all reach codex behind one aggregated endpoint, so we cannot mark
theirs — only ours. Is per-server criticality worth an architectural change?

**Options.** (a) Expose pool members as individual entries (a different subsystem, real design work).
(b) Keep the aggregate, record the limit, keep the soft half that already works.

**Already measured.** *"The runtime's criticality key is **per-server**, and every operator MCP server reaches
codex **behind one aggregated loopback endpoint**… **Marking them marks our infrastructure, not the
operator's server** — whichever posture anyone picks. … the same lane measured that **setting the key
SUPPRESSES the failure notification entirely**, so per-server criticality and per-server observability are
mutually exclusive on this runtime. **Two facts to carry in: the soft half already landed** (the failure
reaches the operator queue today), and **the key still has zero readers on the other two runtimes**."*

**Recommendation: (b).** The key buys nothing on two runtimes of three and costs observability on the third;
record it in the ledger as a measured codex limit. Revisit only if an operator asks for criticality by name.

---

## §D — Switching semantics: what a switch costs and what survives it

### D1 · `P3.70` — A user's cheap side model does not survive a switch, and nothing says so

**The question.** Only the main model is reported when switching runtimes; the small utility model is
silently re-resolved. Do we report it, or make it stable?

**Options.** (a) Add it to what the switch dialog reports. (b) Make the resolution stable across a switch.
(c) Both.

**Already measured.** *"Only the **main** model is reported at switch time; the utility/mini model is a
per-connection field that a switch **silently re-resolves** to something else. Same family as D1's
under-reporting and directly on the owner's *switches correctly* goal — a user who chose a cheap side model
does not keep it and is not told."*

**Recommendation: (a) now, (b) only if it is cheap.** *Make the residual difference uniform or honest* — (a)
is the honest half and costs one line in a dialog that already exists; (b) is a resolution change with its
own blast radius.

**Unblocks.** `P2.485`, `P2.486`, `P2.522` — the switch-cost surface, which currently carries six stale
claims and has never been visually reviewed.

---

### D2 · `P2.175` — Should a watch survive an authentication retry?

**The question.** When a session re-authenticates, its `Monitor` watches are torn down and the session is
told. Should they survive instead?

**Options.** (a) No — leave it as it is (uniform on all three runtimes, and the user is told).
(b) Yes — exempt the auth-retry path.

**Already measured.** *"That path is two of the eleven reachable teardown sites… so it is exempt on all three
runtimes or none; exempting two of three would re-create the divergence `P2.23` removed. The lane recommends
**leaving it un-exempted**… **The hazard must be settled either way, and BEFORE any further exemption:**
`strictDrainPiSession` coalesces by session key **with no notion of the keep set** … `agent view stop` … can
join a drain that is honouring a keep set, and leave a watch alive **while reporting success**."*

**Recommendation: (a), and fix the coalescing hazard regardless of your answer.** The hazard is a live defect
the moment any keep set exists, and one does; it does not need this decision.

---

### D3 · `P2.164` — A background workflow that never spawns an agent now blocks for its whole duration

**The question.** You accepted a trade on 2026-08-31 described as *"the background launch no longer returns
immediately"*. The real cost is wider. Do you still accept it?

**Options.** (a) Accept — an agent-less "background" workflow is arguably not a background workflow, and
blocking is honest. (b) Bound it — settle the turn once no admission can follow. *(Not an option: a timer —
that is what the decision removed.)*

**Already measured.** *"a backgrounded workflow script that **never calls `agent()` at all** is now **fully
blocking** for its entire duration, because there is no spawn outcome to wait for and the arm that settles is
the script finishing. That is the widest reach of the cost and it was not stated."*

**Recommendation: (a), unless agent-less background scripts are a use case you expect.** Only you know that;
a lane cannot. If they are, (b) is small and well-defined.

**Unblocks.** `P2.163`, and it reads with `P2.115`.

---

## §E — Cost, and what the operator pays

### E1 · `P3.98` + `P3.122` — Auto mode spends 110,519 characters per check on our bill and reports none of it

**The question.** The permission classifier's own tokens are billed to our gateway and excluded from the
usage we report. What does the operator see?

**Options.** (a) Fold classifier tokens into reported usage. (b) Report them as a separate host-overhead
line. (c) Leave the gap and document it.

**Already measured.** *"**110,519 characters of system prompt per check, ×2 on the first auto-mode action**,
billed to our gateway and **excluded from `modelUsage`**. So an operator reading our cost attribution sees
less than they are charged, and the gap scales with exactly the sessions we encourage."* And: *"**This
changes `P3.121`'s arithmetic too:** if the fall-through ships, every borderline call in auto mode carries
that cost."*

**Recommendation: (b).** A T-Bank operator seeing less than they are charged is a compliance-visible defect;
a separate line keeps per-turn model usage meaning what it says. Note this is now also a standing argument
for keeping the classifier fall-through off, which is where you left it on 2026-09-01.

**Unblocks.** `P3.97`, `P3.141`, `P3.142`, `P3.187`.

---

### E2 · `P2.258` — A spending ceiling on codex can never fire

**The question.** A user who sets a USD ceiling on codex gets a warning and a cap that is silently inert,
because codex reports no cost. What should the product do?

**Options.** (a) Refuse to set a ceiling that cannot be enforced. (b) Accept it and mark it visibly inert.
(c) Find a cost source first.

**Already measured.** *"`config-writer.ts:901-905` runs the `maxBudgetUsd` cap for codex, but it accumulates
`usage.costUsd` — **which codex emits nowhere** (0 producers repo-wide). … a user who sets a spending ceiling
on codex gets a warning and a cap that will never fire."* A candidate source exists —
*"`ThreadUsage.estimatedUsageUsdMicros` … is a real USD figure … with **zero callers here**"*.

**Recommendation: (a), with the cross-reference honoured.** Your 2026-09-01 pattern exactly: a control that
cannot control should not be offered. If a cost source is wired later, *"its `reportsCostUsd` override must be
deleted"* in the same commit, or the app keeps saying it cannot price a runtime that now can.

**Unblocks.** Reads with `P2.238`, `P2.239`, `P2.227` — the cost-reporting family.

---

### E3 · `P3.52` — One environment variable turns off telemetry, auto-updates, release notes and model discovery — on one path only

**The question.** We set `DISABLE_NONESSENTIAL_TRAFFIC` on the gateway path and not the subscription path,
with no recorded reason. Which is it?

**Options.** (a) Set it on both. (b) Unset it on the gateway path. (c) Keep the asymmetry and record why.

**Already measured.** *"per `env-vars.md#variables` it does far more than suppress telemetry: it also kills
**auto-updates, release notes, gateway model discovery and feature-flag fetching — taking Remote Control with
it.** So the asymmetry is a deliberate-looking posture choice on one path with no recorded decision, and
«fixing» it either way changes what the product can do, not just what it reports."*

**Recommendation: (c).** The subscription path is `GATED` and you have said not to touch it, so (a) is off
the table today and (b) opens egress we deliberately closed. Write the reason at the site; revisit when the
subscription flags lift.

---

## §F — Capability posture: build it, refuse it, or remove it

### F1 · `P3.255` — The codex binary can manage background terminals we do not list, gate or observe

**The question.** Do we want background terminals at all?

**Options.** (a) Adopt them — regenerate the bindings and build a gate and an observation path.
(b) Decline them, and record the decline where a future lane will meet it.

**Already measured.** *"Three background-terminal methods are present in the binary we ship and appear
**nowhere** in the generated tree… **whether background terminals are a capability we want** — a runtime
managing terminals we do not list, do not gate and cannot observe is the shape of every isolation row this
plan has opened. Answer the capability question first; regeneration is mechanical once it is settled."*

**Recommendation: (b) for now.** Your 2026-09-01 reasoning on `P4.7` applies unchanged: a capability on one
runtime that the other two cannot match, with no gate and no observability, manufactures a divergence in the
wave meant to close them. Record it as *declined, not missing*.

**Unblocks.** `P3.258`, and it reads with `P3.224`.

---

### F2 · `P2.371` — A plugin that follows codex's own documented layout loses its data every session

**The question.** codex publishes a per-plugin state directory; we rebuild that home every session for
isolation, so such a plugin silently starts empty every time. Which do we keep?

**Options.** (a) Persist the plugin-state subtree across sessions. (b) Keep the rebuild and refuse or warn a
plugin that uses the documented layout. (c) Measure first whether the binary itself creates or reads it.

**Already measured.** *"`security/cli/reference` publishes `$CODEX_HOME/state/plugins/<name>/` as a plugin's
own state directory, `workbench.sqlite3` included. Our `CODEX_HOME` is rebuilt per session, so a plugin that
follows the documented layout finds an empty directory every time — **its state is not corrupted, it silently
never existed. This is a data-loss shape, not a capability gap** … If the honest answer is that we cannot both
rebuild and persist, that is an owner trade to state, not a bug to hide."*

**Recommendation: (c) then (a), scoped to `state/plugins` alone.** The isolation reason for rebuilding the
home does not obviously extend to a plugin's own declared state directory, and silent data loss is the worse
failure. If (a) is refused, (b) — never silence.

---

### F3 · `P2.468` — A plugin id that is a warning upstream is a hard error here

**The question.** We reject plugin ids upstream merely warns about. Keep the stricter rule?

**Options.** (a) Keep it, state the reason at the site, and make the refusal name the divergence.
(b) Align with upstream and warn.

**Already measured.** *"A leading-hyphen id is a **non-blocking warning** upstream and a **hard
`plugin.manifest.invalid_id` error** in this fork. **The fork is defensible on its face** — our ids reach
filesystem paths and store keys, where upstream's reach a manifest — so this is not a bug to align away; it
is a **product posture nobody has stated.** … an author whose plugin validates clean upstream and is refused
here learns nothing from an id error."*

**Recommendation: (a).** The reason is sound; only its silence is the defect.

**Unblocks.** Reads with `P2.482` and `P2.464` — the same *a refusal that reads as a failure* family.

---

### F4 · `P2.524` — What does "ephemeral" promise?

**The question.** A session marked ephemeral writes checkpoints to disk anyway. Does *ephemeral* mean nothing
is written, or that everything written is removed on exit?

**Options.** (a) Nothing is written — the user loses in-session revert. (b) Everything is removed on exit — a
crash can leave behind what was promised not to persist.

**Already measured.** *"The checkpoint creator makes its directory **unconditionally** and never consults the
ephemeral flag, so a session the user was told leaves nothing behind **writes checkpoints to disk anyway.**
… The two have different failure modes — the first loses a user's ability to revert inside the session, the
second leaves a window where a crash preserves what was promised not to persist."*

**Recommendation: (b), after checking what the flag already promises elsewhere.** It keeps a working
capability and matches what a user hears at the end of a session; the crash window is worth one sentence in
the setting's own text rather than the loss of revert.

---

### F5 · `P2.504` — Should an exported document follow the app's language?

**The question.** Two headings in the markdown export are English literals. Should exported documents follow
the UI language or always be English?

**Options.** (a) Follow the UI language. (b) Always English.

**Already measured.** *"an exported document is not the UI. A transcript exported to markdown may be read by
someone who does not share the exporter's locale, pasted into an English-language issue, or diffed against an
earlier export — so *follow the UI language* is a defensible answer and so is *always English*, and picking
silently means the choice gets made by whoever writes the import statement."*

**Recommendation: (b), stated at the site.** Exports leave the machine; the six on-screen strings that landed
set no precedent. This is the smallest question in the brief — thirty seconds.

---

## §G — Supply chain, CI and evidence

### G1 · `P3.224` — We ship a codex build the registry does not serve as stable

**The question.** Our binary self-reports `0.148.0`; Artifactory's stable is `0.147.0` and `0.148.0` exists
there only as per-platform alphas. Where does our binary come from, and should the pin move?

**Options.** (a) Establish provenance and record it. (b) Pin back to `0.147.0` (reproducible from the
registry). (c) Wait for `0.148.0` to land non-alpha.

**Already measured.** *"So the runtime we ship is **ahead of the registry's stable**, and its provenance is
not the registry. Not necessarily wrong — but it is a supply-chain fact nobody had written down, it means an
Artifactory-only rebuild cannot reproduce our binary, and every codex measurement in this plan is pinned to a
version the registry does not serve as stable."*

**Recommendation: (a) first — it is a fact, not a choice.** For a bank fork with a compliance pipeline, an
artefact that cannot be rebuilt from the approved registry is the kind of thing that is cheaper to answer now
than during a review.

**Unblocks.** Reads with `P3.223` (the owed SDK upgrade) and `P3.258`.

---

### G2 · `P3.258` — The only check that could catch a bad codex regeneration is switched off

**The question.** A script regenerates the 655 generated codex files from the pinned binary and diffs them
all. It needs the network and is commented out of CI. Re-enable it?

**Options.** (a) Re-enable in the main pipeline. (b) Run it as a scheduled or manual job outside the hermetic
pipeline. (c) Leave it off and state that the bindings are hand-verified.

**Already measured.** *"it is the only thing that could catch a bad regeneration wholesale, and it is
**disabled in `.gitlab-ci.yml`** because it needs the network. … **Re-enabling is a CI and owner decision,
not a lane's**, and the trade is explicit: a networked step in a pipeline that is otherwise hermetic, against
a generated artefact that a reader consults *as* the wire contract. **Do not substitute a weaker check to
make this row closeable.**"*

**Recommendation: (b).** It keeps the pipeline hermetic and still gives the artefact a real check. (c) is
honest but leaves the wire contract unguarded.

---

### G3 · `P2.389` — The only corpus that could weight our removal-floor claims is a place no agent may read

**The question.** The 18,272-command corpus lives under a real home directory, and our own safety rule
forbids executing any string that names one. A human must take one copy. Will you?

**Options.** (a) You (or another human) copy it once into the repo or scratch tree, contents treated as
untrusted data. (b) We stop making coverage claims about real traffic and say so.

**Already measured.** *"the corpus cannot be read by the lane that needs it — and the lane correctly routed
around it, building a refusal guard (self-tested 9 refused / 5 permitted) and measuring a designed
adversarial slice instead. **The result is honest but unweighted: we know the breaker's behaviour on
constructed cases and not its coverage on real traffic.** … Until then every coverage claim about the removal
breaker is a claim about the adversarial set."*

**Recommendation: (a).** It is one copy and it converts every future removal-floor claim from *"on our
adversarial set"* to *"on real traffic"* — including the 13.78 % slice where the breaker is the only floor.

**Unblocks.** `P2.312`, `P2.388`.

---

### G4 · `P3.65` — One sentence only you can write

**The question.** Your 2026-08-08 decision dropping `policyHelper` records a reason that reads as a
truncation. What was the reason?

**Already measured.** *"the next reader cannot tell a deliberate drop from an editing accident — and `P3.63`
had to reconstruct the rationale from the documentation rather than read it. One sentence restating WHY, in
the owner's terms. Cheap, and it protects a decision that has now been re-litigated once."*

**Recommendation.** Answer in one line; a lane will transcribe it.

---

## §H — GATED, and out of scope: three things that look like decisions and are not

- **`P2.318` — no decision needed.** The stale model list it refreshes is keyed on `openai-codex`, which
  `llm-connections.ts:935` describes in its own docblock as *"the ChatGPT Plus/Pro OAuth path"* — the
  subscription card that is flag-off. Your 2026-08-29 ruling covers it: *"do not build, do not delete, do not
  «clean up»."* It is filed `GATED`. Its measurement (*"of the seven entries only `gpt-5.5` exists in the
  codex catalogue"*) stays on the row for the day the flags lift.
- **`P2.370(b)` — outside the three-runtime goal.** A 116-file iOS client sits in the repo with no CI gate.
  Whether a Swift gate is owed is a real question, but it is not agent-loop work; answer it whenever it is
  convenient, or say the client is out of the desktop release train and let the row close.
- **`P5.3` — a housekeeping unblock.** Three files have been untracked in the working tree since 2026-08-23
  and belong to no lane; the register generator reads the plans directory as a glob, so they contaminate its
  output. They need to be committed by their owner, moved, or excluded before the registers can be
  regenerated. Not a product decision — but nobody but you can say whose they are.

---

## §I — OQ-14: the fourth runtime, and a tag that points at the wrong row

**The question.** The goal names three runtimes; the product ships four `AgentProvider` values. What happens
to the rows about the remote cloud agent?

**Options, from the plan.**
- **(a) IN** — add a fourth ledger column and author the definition of *covered* for it. *"Cost: a measure
  with no external anchor, written by the people it measures."*
- **(b) OUT of this plan** — the rows move to the out-of-scope register with their measurements intact,
  promotable later at no re-measurement; the cloud agent stays shipped, non-switchable, owned by its own
  plan. *No code changes.*
- **(c) DEFERRED-LAST** — the rows stay in the tracker and are never dispatched.

**Already measured.** Your own 2026-08-29 answer: *«это удалённый агент, локального рантайма нет»* — so it
*"sits outside the three-runtime switch grid by nature, not by exclusion: there is no local session to switch
into or out of, which is what goal 1 is about."* And the stopping rule records that the remote agent has no
external documentation corpus, so *covered* for it *"must be defined by us because it cannot be measured."*

**Recommendation: (b)**, which is also the plan's own recommendation — with one correction that must land
first.

**The correction, measured today at `f3a2b5f4d`.** OQ-14 says *"Two open rows carry the `[remote]` tag:
`P2.335` (⏸) and `P2.58` (⬜)."* Parsed from the tracker with the cell-index parser, the only open row whose
note carries `[remote]` is **`P3.184`** — whose subject is codex's OS-enforced deny stopping `ssh`,
`git push` and the cloud CLIs inside a codex shell, and which is **not a remote-agent row at all**. `P2.58`,
which *is* about the cloud agent's hook fence, carries **no tag**. So resolving OQ-14 as (b) and moving *"the
`[remote]` rows"* by their tag would move a codex permission row out of the plan and leave the actual
remote-agent row in it. **Fix the tag first; then (b) moves `P2.335` and `P2.58`.**

**Unblocks.** `P2.335` (the only `⏸` row waiting on you rather than on its own data), `P2.58`, and it
prevents `P3.184` — already decided, keep the deny and make the refusal legible — from being swept out by
mistake.

---

## Appendix — already decided, do not re-ask

The previous decision queue presented three settled questions of eight as open, because it was *"a regex over
row text, not a reading."* These were checked against the owner-ruling sections and each row's own note, and
are **closed**:

| Row | Settled | Where |
| --- | --- | --- |
| `P2.306` | **Refuted** — the deny *is* honoured live; the fix its own row proposed would have removed a working credential control. | Owner decisions 2026-09-01 |
| `P3.139` | **Decided** — the classifier fall-through stays off, one flag away, numbers recorded. | 2026-08-28 delegation; re-affirmed 2026-09-01 |
| `P6.9` | **Deferred to last**, in your own words. | Owner ruling 2026-08-28 |
| `P4.7` | **Do not build** — a Pi-only inspector manufactures a divergence; three recording items remain. | Owner decisions 2026-09-01 |
| `P3.242` | **Refuse, naming the override** (~5 lines). | Owner decisions 2026-09-01 |
| `P2.381` | **Explicitly disable** the codex remote-control transport, and measure the binary's default as part of the work. | Owner decisions 2026-09-01 |
| `P3.129` | **Defer Windows until a build ships, and record that as a posture** — retitled, now a small recording task. | Owner decisions 2026-09-01 |
| `P3.88` | **Dissolved** — a personal llm-proxy key is a BYO connection, never a product credential; the gateway pool already publishes the window. | Owner ruling 2026-08-28 |
| `P3.184` | **Keep the deny, make the refusal legible**; an exception list for `ssh`/`git`/`aws` explicitly declined. | Controller under the 2026-08-28 delegation |
| `P2.357`, `P3.90` | **OUT** on the authorization exclusion. | Owner answers 2026-08-29 |
| `P2.11` | **Commit half only** (background sessions, not background shell commands). | DR-2, 2026-08-22 |
| `P3.8` | **Supported install path, not bundled.** | DR-4, 2026-08-22 |
| `P4.1`, `P4.3`, `P4.10` | **Playground last** — waiting on their own data, not on you. | Phase-4 process decision, 2026-08-23 |
