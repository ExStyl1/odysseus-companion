# Denominator questions — triage under the 2026-09-02 delegation (2026-09-05)

The 75 owner questions of `2026-09-05-denominator-owner-questions.md`, each classified DECIDED (taken as recommended under the standing delegation: parity, less code, documented shape, thinnest host), OWNER (a product posture) or POINTER (already asked). The fifteen OWNER items were put to the owner in Russian with the controller's own recommendation; on 2026-09-05 the owner took every recommendation («по вопросам — давай делать как рекомендуешь»). The decided options are recorded below and in the plan's `## Owner decisions 2026-09-05, part 3`.

## Решения владельца 2026-09-05 (по рекомендации контроллера)

D1 A · D2 A · D3 B · D4 A сейчас (после close-out пересмотреть) · D5 A (согласовано с sitting §1.2 = A) · D6 B, низкий приоритет пока sandbox выключен · D7 c · D8 A · D9 2 (3 позже) · D10 1 сейчас (если понадобится — 2, нативно у codex, с раскрытием) · D11 A · D12 A · D13 B · D14 A · D15 2. Пять оставшихся ⏸-строк: D16 P2.318 B · D17 P2.335 A · D18 P2.357 A · D19 P3.90 A · D20 P6.9 вне плана (подтверждено).

# Denominator owner questions — triaged against the standing delegation (2026-09-05)

Input: `nessy-wf-checkpoints/work/denominator-rows/denominator-questions.md` — 76 headings, **75 new
questions plus one pointer entry**. Each is decided under the owner's standing delegation of 2026-09-02
(«decide in favour of parity, less code, as in the documentation, thinnest host; leave only what genuinely
needs the owner, to be finished together near the end of the plan»), read together with AGENTS.md
§*Native-first, and the host is the smooth seam* and §*Where the documentation is silent: TRANSPARENT and
SIMPLE*, and with the 2026-09-05 precedent that the owner took every recommendation of the previous
twenty-seven questions.

**The rule applied, stated once so the verdicts can be checked.** A question is **DECIDED** — its own
`Recommendation:` taken verbatim, conditionals taken literally — when the recommendation is a parity /
less-code / documented-shape / thinnest-host choice, when it declines and records the null, or when it
keeps the status quo and makes it honest. It is **OWNER** when the recommendation itself *takes* a
posture-changing option: a safety floor loosened, new egress, personal data, money, a large new surface
the user sees and might not want, an operator cost — or when the recommendation refuses to choose. Several
questions carry their own *"Why it is an owner call"* section; that section is about a specific option, so
it decides the verdict only when the recommendation **takes** that option. Where it declines it, the
question is DECIDED.

Checked against `docs/superpowers/specs/2026-09-04-owner-sitting.md` (17 sections) and
`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` §*Owner decisions 2026-09-05* (27 numbered
decisions). One heading resolves to a POINTER; four DECIDED answers are already carried by an unfinished
plan row and get no new row.

Consequence is one of **row** (work follows — the row is staged in `denominator-decision-rows.md`),
**ledger** (a ledger note or one honest-surface sentence only), **none** (status quo confirmed, or the
answer is a pointer).

---

## Host

### 1. [host] What permission mode does a reopened session start in?

**DECIDED — C** (bypass and `auto` follow the page's resume table, `plan` is restored). · **why:** the
documented contract on the two modes that can widen a session, the recorded intent on the one that cannot,
at the price of one stated divergence — parity where it protects, less change where it does not.
· **consequence: row** (ledger A17).

### 2. [host] May a developer widen the judge's trust boundary on their own machine?

**DECIDED — C** (user scope for `hard_deny`/`soft_deny` only; `allow`/`environment` stay managed-only).
· **why:** the only option that cannot loosen a safety judge, and it reuses the direction-of-strictness
rule the fork already applies to managed settings (ledger A8) rather than inventing one.
· **consequence: row** (ledger A33).

### 3. [host] Accept Edits: four filesystem commands, or the page's six?

**DECIDED — A** (keep `mkdir`/`touch`/`mv`/`cp`, and settle the record in the same pass). · **why:** keep
the status quo and make it honest — two live documents currently give opposite answers, and `rm` under
Accept Edits is unattended deletion. · **consequence: row** (ledger A37).

### 4. [host] Adopt the vendor's confirmation-suppression switches, or refuse them by name?

**DECIDED — B for the project and local scopes** (C only if an operator case is real; none is, so not
now). · **why:** the reachable path today is the repository one, and a repository suppressing a
dangerous-mode confirmation is a control removed by a file — refusing by name is less code and the safe
direction. · **consequence: row** (ledger A38).

### 5. [host] A subagent's declared permission mode: clamp it (ours) or ignore it (the page)

**DECIDED — A** (record the deviation, pin it with a test, say so in the agent-definition docs).
· **why:** conformance is not worth loosening a permission floor, and the page's own narrower twin shows
the contract is unsettled upstream. · **consequence: row** (ledger A58).

### 6. [host] May an untrusted MCP server's `readOnlyHint` let its tool skip our gate?

**OWNER — D1.** · **why:** the recommendation (B) reverses a test-pinned invariant — *"ADVISORY ONLY … must
never become an authorization signal"* — in the loosening direction, and the question says in terms that
this is an owner call, not a lane's. · **consequence: owner sitting.**

### 7. [host] A second permission authority: approving a tool prompt from a phone over a channel

**DECIDED — A** (decline the channel route; `RESPOND_TO_PERMISSION` stays the single remote authority).
· **why:** decline and record the null — one authority over one safety decision, and the page pins the
masking behaviour to CLI 2.1.234 while the bundle declares 2.1.233. · **consequence: ledger** (the null,
plus the re-ask trigger at bundle 2.1.234).

### 8. [host] Do we ship an environment-drafting assistant at all (`/auto-mode-setup`)?

**OWNER — D2.** · **why:** the recommendation (B) builds a **new writer of permission rules** — a product
surface whose weakest part is draft quality, and whose failure mode is a broad allow rule with a friendly
provenance. C (shell history) is declined either way. · **consequence: owner sitting.**

### 9. [host] A per-session scratch directory whose writes never raise a permission prompt

**OWNER — D3.** · **why:** the recommendation (B) creates a standing carve-out from the permission gate —
a directory the model may write without ever being asked. Documented and native on claude
(`CLAUDE_JOB_DIR`), but a gate exemption is a safety posture the delegation does not cover.
· **consequence: owner sitting.**

### 10. [host] Does the Windows build owe a WSL2 agent mode?

**DECIDED — A** (Windows-native only, stated beside the `unelevated` decision; unpark P3.7 only when a
Windows rig exists). · **why:** keep the status quo and make it honest; B cannot be costed without the rig
P3.7 is parked for, and a decision taken without it would be invented. · **consequence: ledger.**

### 11. [host] Deploy a fixed MCP server set users cannot add to — or restate the 2026-07-29 ruling that we will not

**DECIDED — option 1** (confirm the ruling and restate it in the out-of-scope register). · **why:** keep the
status quo and make it honest — the alternative imports a second config format for a fleet that does not
deploy one. · **consequence: ledger** (B12; restate `2026-07-29-deviation-audit.md:193` in the register so
the sweep stops re-finding it).

### 12. [host] Should a managed plugin mandate ACQUIRE the plugin, or stay the report-only no-op it is today?

**DECIDED — (a) report-only** (with the S residue: carry the doctor's "Force-enabled plugins" verdict onto a
desktop-reachable surface). · **why:** (b) is unattended execution from policy — the host fetching and
installing code at boot because a file said so. · **consequence: row** (ledger B13, the residue only).

### 13. [host] Does the built-in browser owe an administrator a graduated policy, or stay the all-or-nothing switch?

**DECIDED — (b) now** (an admin key feeding the existing tools-off gate); (c) origin allow/deny only if the
origin concept is wanted, and it is the same trust store question 36 puts to the owner. · **why:** the
recommendation taken literally is *"take (b) now and (c) next"*, and (b) reuses a gate that already works on
all three runtimes. · **consequence: none — already carried** by unfinished plan row **P6.338** (denominator
J15), whose three documented keys include `browserExternalPageTools` and which names this exact question.

### 14. [host] Reopen R50's delivery channels — MDM plist and HKLM — or document file-plus-drop-in as the only channel?

**DECIDED — (a) confirm R50** (file + drop-in are the only channels; (c) HKLM only if a Windows fleet becomes
real). · **why:** keep the status quo and make it honest — the 2026-08-08 owner ruling stands and has never
been restated where sweeps read it. · **consequence: ledger** (B17).

### 15. [host] May an operator forbid personal-key and BYO authentication and require the gateway sign-in?

**DECIDED — A** (host-side enforcement, with B's disclosure line as its refusal text; C only as a belt on
top, never alone). · **why:** one seam enforcing on all three is the thinnest host answer, and C alone
enforces on claude only — manufacturing the silent divergence the host exists to prevent. The key is
managed-scope and off by default, so nothing changes for a deployment that does not set it.
· **consequence: row** (ledger C10).

### 16. [host] Should Nessy Desktop offer projects on remote SSH hosts at all?

**DECIDED — A** (stay local-only and record the divergence; probe the shipped codex binary before B is ever
costed). · **why:** decline and record the null — codex's SSH story is page-only, WEAK tier, absent from
`rust-v0.148.0`, and B is a plan, not a lane. · **consequence: row** (ledger C17 — the recorded divergence
plus the binary probe).

### 17. [host] Reopening a long, stale conversation: load it as-is, always compact, or ask once and remember

**DECIDED — C** (ask once and remember, as the page does). · **why:** as in the documentation; A and B both
take a cost decision silently on the user's behalf, and C is the only option whose residual host choice (the
staleness trigger) is visible where the cost is incurred. · **consequence: row** (ledger E8).

### 18. [host] Deleting all local state for a project — ours only, ours and the runtime's, or neither

**DECIDED — A** (purge our own state and say codex's `~/.codex` history is untouched). · **why:** deleting a
sibling tool's data is a posture we decline; A is the uniform command with the residue named on screen.
· **consequence: row** (ledger F17).

### 19. [host] Never persisting a transcript at all, or leaving the retention cap as the whole answer

**DECIDED — A** (a never-persist mode as a first-class setting, stating its cost when entered). · **why:** it
rides the ephemeral machine that already exists, and C is a false never-persist — the transcript is written
and then deleted, which is the shape of this fork's largest defect class. · **consequence: row** (ledger
F18; the env half is P6.267).

### 20. [host] Waiting out a usage limit: wait where a reset is published, retry on a fixed interval, or surface it and stop

**DECIDED — A** (wait only where a reset timestamp is published; say plainly where it is not). · **why:** B
invents a reset the server never promised, which is the failure the read-don't-invent rule exists for.
· **consequence: row** (ledger F21 — the timestamp-driven half; the resume-vs-stop SETTING is P6.373 and the
codex readback is P6.444).

### 21. [host] A runtime-blind multi-session screen — build it, or keep the divergence

**OWNER — D4.** · **why:** the recommendation (B) funds an **L build with its own i18n, playground states and
a Phase-4 design pass** — a new product surface, not a parity repair; the smallest honest piece is already
rowed as P6.270. · **consequence: owner sitting.**

### 22. [host] One-line session summaries — derive them free, or spend a model turn

**DECIDED — A** (derive the row from the session's own output, no extra model call). · **why:** free, uniform
and honest; B is an invisible recurring charge that lands on the MAIN model on our default gateway by the
page's own fallback rule. · **consequence: row** (ledger F29).

### 23. [host] Background auto-commit before an unattended session finishes

**POINTER → `docs/superpowers/specs/2026-09-04-owner-sitting.md` §1.7** (and plan row P2.11).
· **why:** the slice itself is written as a pointer; what it ADDS is evidence, not a new question —
`agent-view.md:501` is a second published place for the preserve-before-finish clause, and ledger **I4**
(host-side, age-based cleanup without snapshotting, data-loss-adjacent) is the adjacent row to close in the
same pass. · **consequence: none.**

### 24. [host] A user-typed background shell job, outside any session

**DECIDED — A** (commands stay gated tool calls), unless J9 (an interactive terminal) is taken, in which case
the gate question is answered there. · **why:** decline and record the reason — B is a second shell-execution
route the permission gate was not designed to see. · **consequence: ledger** (F31; the reason recorded so the
next sweep does not re-open it, and the J9 conditional named).

### 25. [host] Prompt history across sessions — reverse a recorded privacy choice, or document the divergence

**DECIDED — C first** (document the divergence, leave the behaviour); B only after P6.267 makes
`NESSY_SKIP_PROMPT_HISTORY` real. · **why:** persisting prompts reverses a privacy choice recorded at the
site, and B shipped first would be a persistence with a broken off switch. · **consequence: ledger** (F36).

### 26. [host] How does a user's own environment reach a host-run command hook?

**OWNER — D5.** · **why:** the question is explicitly coupled to an **undecided** sitting item — §1.2, whose
controller recommendation is (A)-refuse on the same containment argument — and says *"answer them together"*;
its own recommendation (B) inverts under that answer. Every secret in a user's shell reaching every hook
command a plugin ships is the trade. · **consequence: owner sitting** (answer with §1.2).

### 27. [host] Should a session watch a merge request's CI, and may an agent act on what it sees?

**DECIDED — A** (status and notification only; no Auto-fix, no Auto-merge). · **why:** an agent that merges is
a posture the ledger has no receipt mechanism for, and Auto-fix's unattended pushes want the same receipt.
· **consequence: row** (ledger H20; the forge integration itself was routed to Dev-4 by DR-2, plan `:1145` —
the row must say so).

### 28. [host] Fork mode's default: match both halves of the documentation, or keep one constant and rewrite the reason?

**DECIDED — A** (Pi defaults ON in interactive sessions, claude stays OFF, with the switch-cost row in the same
commit). · **why:** as in the documentation — the page now states two defaults for two shapes, and matching
each is cheaper than defending one constant against a page that contradicts it. · **consequence: row**
(ledger H28).

### 29. [host] Should the product ship a bundled workflow command out of the box?

**DECIDED — A** (none; workflows stay user-authored). · **why:** decline and record the null, consistent with
the owner's 2026-09-01 rulings against shipping content the user did not ask for; B would be a Pi-only
capability refused by name on two runtimes. · **consequence: ledger** (H42).

### 30. [host] A budget a long task paces itself against: USD, tokens, or both?

**DECIDED — A** (keep the USD cap where a price exists, add a token budget every runtime can honour).
· **why:** tokens are the only unit codex can denominate in and its own `ThreadGoal` already carries
`tokenBudget`/`tokensUsed`, so the visible half is a readback; A closes the runtime difference without
retiring a control that works. Decision 19 (hold codex's USD null) already settled that codex has no USD
subject. · **consequence: row** (ledger H47).

### 31. [host] May one request fan out into 5–30 worktree-isolated agents that each open a merge request?

**DECIDED — A** (MR-less batch: worktrees and branches, a human opens the merge requests). · **why:** DR-2
already routed forge work to Dev-4, and A is the half that does not need it; the worktree machinery already
exists, so this is assembly rather than construction. · **consequence: row** (ledger H51).

### 32. [host] `/cd` — may a live session move directory, and if it does, whose configuration governs it afterwards?

**DECIDED — B** (move the working directory only, re-resolve nothing, and say so in the result); C only if an
operator asks. · **why:** the smallest honest thing — it makes the `Cd` rules mean something without moving a
live session's trust boundary. · **consequence: row** (ledger I20; the Pi-only `CwdChanged` emitter must not
become the mechanism).

### 33. [host] Does the product ship per-dimension sandbox escape valves, or stay with one coarse valve?

**OWNER — D6.** · **why:** the recommendation (B) **adds three keys that weaken the sandbox** — a MITM-proxy
CA, an unprivileged nested container, all Unix sockets — and refuses a fourth by name; the question carries
its own *"Why it is an owner call"* and the recommendation takes it. · **consequence: owner sitting.**
Adjacent rows already open: P6.233 (seven documented sandbox keys rejected by our parser) and P6.253 (the
eight network-transport keys).

### 34. [host] Is containerised execution a direction for this product at all?

**OWNER — D7.** · **why:** the recommendation **does not choose** — *"a or c, never b"* — and containerised
execution is one of the postures the denominator sweep itself named as owner-shaped: an image to build, ship
and keep current, plus a different debugging story for every live case. · **consequence: owner sitting.**

### 35. [host] Windows: keep the weaker `unelevated` sandbox, or spawn codex's own setup binary for `elevated`?

**OWNER — D8.** · **why:** the recommendation (B) takes a posture the question names as the owner's —
provisioning creates **local sandbox users and a secrets store on the user's machine**, a first-run experience
and an operator cost. · **consequence: owner sitting.** The codex `[windows]`-block measurement is owed under
every option and is already P6.227.

### 36. [host] Governing the built-in browser — per-site approval and the CDP grant

**OWNER — D9.** · **why:** the recommendation (option 2 first, option 3 as destination) adds a **new approval
surface to a live feature** — existing Pi and claude users would meet prompts they have never seen — and makes
full Chrome-DevTools attach a grant of its own; option 3's classifier is a model call per click. Today's state
is the one this group calls *not honest*. · **consequence: owner sitting.** The operator half is already rowed
as P6.338.

### 37. [host] Channel opt-in: a per-session arming set, or the app-wide preference we have?

**DECIDED — option 2** (a per-session arming set seeded from the persistent preference). · **why:** as the page
specifies, while keeping `CHANNEL_PUSH_OFF` fail-closed and the managed `allowedChannelServers` intact; option 3
taxes the user every session. · **consequence: row** (ledger J20; P6.341 must land first or a session grant
exists on Pi alone).

### 38. [host] Plugin-shipped message channels — allow third-party text injection into a turn?

**DECIDED — option 1** (leave it deferred, write the deviation). · **why:** decline and record the null — the
deferral is already honest per plugin, no user has asked, and option 3 would CREATE a divergence to close a gap
that does not exist. · **consequence: ledger** (J30).

### 39. [host] Image generation — leave codex's items rendered and unreachable, or give them an upstream?

**DECIDED — option 1 now** (record the deviation, keep the named warning); option 2 (BYO image model) later if a
user asks; option 3 is a question for the gateway team, not this plan's answer. · **why:** decline and record the
null — no new upstream, no new spend path, no new content-policy surface, and the failure is already named to the
user. · **consequence: ledger** (J32).

### 40. [host] Should `ultracode` be selectable as an effort posture, or stay keyword-only?

**DECIDED — keyword-only** (status quo). · **why:** the spend stays opt-in per turn and the non-adoption is already
recorded at three sites with a test-pinned rejection; a toggle beside the effort picker would read as a seventh
effort level, which those three rejections exist to prevent. · **consequence: ledger** (K17 — record that the
page's settings key and flag are deliberately unwritten).

### 41. [host] Ultra: should picking it change the run's SHAPE, and who decides the fan-out?

**DECIDED — (A)** (leave the fan-out to the model). · **why:** decline and record the null — a ceiling is
permission, not instruction, so (B) cannot deliver what the label promises, and (C) exists on codex alone.
· **consequence: ledger** (K18).

### 42. [host] A plugin marketplace whose source is a local command

**DECIDED — option 2** (refuse `command` uniformly and close the claude leak by emitting
`disableCommandPluginSources` at its restrictive pole for this source kind); option 3 only together with the
`headersHelper` decision, which landed on managed-only execution (2026-09-05 decision 7). · **why:** today's
refusal is true of our catalog and false of the product — a user's `command` marketplace runs inside the claude
child and our plugin policy never sees it. · **consequence: row** (ledger L20).

### 43. [host] One-click plugin install from a link

**DECIDED — option 2** (accept an install deep link that only PRE-FILLS the install dialog). · **why:** it closes
the ergonomic gap without giving an external origin a mutating verb, keeping `deep-link-policy.ts`'s invariant —
*"A link Nessy did not produce is inert"* — literally true. · **consequence: row** (ledger L21).

### 44. [host] Should a plugin's output style apply itself?

**DECIDED — option 1** (keep the deferral permanently and surface it). · **why:** the same unattended-default
refusal the fork already applies to a plugin's `agent` key; one posture stated once for both fields.
· **consequence: row** (ledger L25 — the surfacing).

### 45. [host] Should a plugin ship default settings, including the `agent` key?

**DECIDED — option 1** (keep refusing `agent`; honour the rest of a plugin's default settings). · **why:** it
preserves the refusal the code already argues for at the site, and a plugin owning the main thread's system
prompt, tool restrictions and model is the move this fork refuses elsewhere. · **consequence: row** (ledger L26).

### 46. [host] Replacing or appending the model's base system prompt

**DECIDED — option 2** (append only, on all three; no replace anywhere). · **why:** native-first with no new host
machinery — every runtime already has an additive channel (`appendSystemPrompt`, `PromptBuilder`,
`developerInstructions`) — and replacement both deletes codex's 20 751-char base prompt and can strip the safety
floor. · **consequence: row** (ledger L30; sequence after P6.171).

### 47. [host] Relative paths in `additionalDirectories`

**DECIDED — option 3** (resolve relative entries against the settings FILE's own directory, with the difference
written down). · **why:** it gives the user the documented shape while removing the launch-directory dependence
the function header refuses — the header's objection is to option 2 specifically, not to relative paths.
· **consequence: row** (ledger L40).

### 48. [host] Background distillation of finished chats into durable memories

**OWNER — D10.** · **why:** the recommendation (option 3) buys **a host background model call per finished chat**
— a recurring invisible spend, which is the posture question 22's own answer refused an hour earlier — plus
durable memories written from conversations with no model in the loop. · **consequence: owner sitting.** P6.166
(codex's two native auto-memory off keys) is the precondition either way.

### 49. [host] Should `openai/skills`, the vendor's own catalog of reusable skills, be known to the product?

**DECIDED — B** (a built-in entry that is present but disabled, one click to enable). · **why:** discoverability
without a second default-on remote catalog in an internal fork; the reserved-name protections (L14) still apply.
· **consequence: row** (ledger L63; P6.404 sequences after this answer).

### 50. [host] Is plugin INSTALL scope a user choice, or does one store plus enablement scope stand in for it?

**DECIDED — A** (offer the choice at install time — for me / for this repository / for me in this repository only).
· **why:** the page's four-scope model, host-owned and provider-blind, so one build moves all three columns.
· **consequence: none — already carried** by unfinished plan row **P6.414** (denominator L78), which states in
terms *"Sequence after the `[host]` install-scope question (L79) — that answer fixes the scope SET this row
implements"*. This decision IS that answer.

### 51. [host] Should the official Anthropic marketplace be delivered by default?

**DECIDED — B** (delivered present but disabled, one click to enable). · **why:** presence and discoverability
without a default-on outbound trust from a T-Bank-internal fork; the delivery mechanism already exists
(`ensureDeliveredMarketplaces`), so this is configuration, not construction. · **consequence: row** (ledger L90;
distinct from L19 / P6.385, the runtime's own auto-install opt-out).

### 52. [host] Should plugin suggestions read the session's own history — commands run, hosts fetched, files read?

**DECIDED — B** (add only the manifest-dependency signal, which needs no history). · **why:** it declines a new
per-session behavioural record of commands, hostnames and file reads — a privacy and retention posture this fork
has never taken — and gives a second live matcher read from a file the host already opens.
· **consequence: row** (ledger L93; P6.424 depends on this answer for what it may say).

### 53. [host] Should Nessy accept Claude Code's own settings vocabulary for the interactive-mode keys?

**DECIDED — option 2** (accept only the names we already implement, diagnose the rest). · **why:** transparent —
every accepted name does something and every unaccepted one produces an honest line; accepting a name without the
behaviour manufactures the silent divergence this fork keeps closing. · **consequence: row** (ledger L126).

### 54. [host] Does importing a setup include the conversation history and the project memories?

**DECIDED — option 2** (import memories, not chats; the dry run gains a per-file preview). · **why:** it closes the
arm that changes what the model is told, with a mechanism we already have, and leaves the chat-store migration
honestly unowned instead of half-built. · **consequence: row** (ledger L131).

### 55. [host] Is the importer a one-shot converter, or a standing link to the other agent?

**DECIDED — option 2** (one-shot plus a re-run that diffs), with the needs-authorisation card built as its own
surface. · **why:** option 3 makes an external directory a live input to our permission posture, which is the
direction this plan has spent itself closing. · **consequence: row** (ledger L132).

### 56. [host] Which agents may Nessy import from, beyond Claude Code?

**DECIDED — option 2** (add `~/.codex` only; Cursor and Gemini stay on Dev-13's deferral, with the reason restated
at the call site). · **why:** codex is the one foreign format we can verify against open source and a shipped
binary rather than a page — strong tier against weak. · **consequence: row** (ledger L133).

### 57. [host] Should an operator be able to supply the model price table this app costs sessions against?

**OWNER — D11.** · **why:** **the price table is one of the postures the denominator sweep itself named**, and the
recommendation (A) takes it: an operator-maintained price list whose wrong entry produces a confidently wrong cost
figure and a USD cap that fires at the wrong moment. · **consequence: owner sitting.**

### 58. [host] Should the configuration checkup be allowed to change anything after you confirm, or stay a report?

**OWNER — D12.** · **why:** the recommendation (B) turns a read-only checkup into **a thing that edits the user's
files**, and the question says in terms that all options are uniform across runtimes, *"so this is a product-posture
question and not a parity one"*. · **consequence: owner sitting.** One of B's two finding classes is already rowed
as P6.398.

### 59. [host] May host telemetry name a person and a session?

**OWNER — D13.** · **why:** **telemetry personal data**, named by the sweep as owner-shaped. The recommendation (B)
lets a real per-user identifier leave the machine once an administrator enables it, and gives Pi's HMAC scheme a
second, non-anonymous mode. · **consequence: owner sitting.**

### 60. [host] May an ambient shell variable make a session export its whole conversation?

**OWNER — D14.** · **why:** **export content volume**, named by the sweep as owner-shaped — and the status quo is
the one thing no option keeps: today an ambient `OTEL_LOG_RAW_API_BODIES=1` exports the whole conversation with no
host decision anywhere. The recommendation (A, strip) removes a working vendor capability; either answer is a
posture. · **consequence: owner sitting.**

### 61. [host] May a desktop app open a metrics scrape socket?

**DECIDED — A** (implement `console`, refuse `prometheus` by name; B on demand). · **why:** decline the inbound
listening socket and make the refusal legible — the same split the record already made in
`2026-07-29-observability-and-cost.md:186`. · **consequence: row** (ledger M40; lands in the same two files as
P6.452, so it sequences with that lane rather than beside it).

### 62. [host] Let a hook or a Bash command post a message into its OWN session?

**DECIDED — (b)** (an RPC endpoint on the EXISTING session token, own-child only, routed through
`admitAgentMessage`). · **why:** the smallest honest thing — no new transport, no new secret, and the existing
admission ladder plus P6.45/P6.46's loop, rate and size guards are the audit surface; (c) would build a socket for
a variable the runtime we vendor does not export. · **consequence: row** (ledger N10, proposed; P6.182 carries N2's
hold/refuse ladder).

### 63. [host] Build host-relayed cross-machine session messaging, or say same-machine only in writing?

**DECIDED — (a)** (same-machine only, said plainly in the capability descriptor and the switch report).
· **why:** decline and record the null — (b) is a new egress path carrying session TEXT and an account dimension
`sessionId` does not carry; the page excludes our case explicitly. · **consequence: row** (ledger N11, proposed —
(a) carries a `BUILDABLE S` surface obligation, so it is a row and not a note).

---

## Claude

### 64. [claude] Should a claude session that ships our own agent definitions still expose the SDK's built-in `general-purpose` agent?

**DECIDED — B** (set `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` when we supply definitions, gated on the condition
the code already computes). · **why:** every reachable agent then has passed our checks, matching Pi and codex;
`general-purpose` is otherwise an unvetted full-tool agent reachable on one runtime only.
· **consequence: row** (ledger H32; the env plumbing is P6.313 / denominator H31 — the two land together).

### 65. [claude] May a claude session reach MCP servers the app never configured?

**DECIDED — option 2** (leave `strictMcpConfig` unset and REPORT what the CLI discovered; correct
`managed-mcp-access.md:203` in the same commit). · **why:** it neither breaks a working user setup nor leaves a
false guarantee standing, and it is a precondition for option 1 — you cannot judge what strict mode costs until
you can see what the CLI connects to. · **consequence: row** (ledger J17; P6.72 measures the adjacent
managed-denial question).

### 66. [claude] Tool search through our own loopback adapter — leave it off, teach the adapter, or honour the choice only where it can work?

**DECIDED — option 3** (honour the operator's `true`/`auto:N` only where the base URL IS first-party; keep the
forced OFF on the loopback). Option 2 only if P6.141 shows the loopback survives. · **why:** it costs a predicate
and a report line and removes a control that has stopped controlling, without buying a silent-failure mode on the
default connection. · **consequence: row** (ledger J26/claude; the codex arm was decided on 2026-09-05 as decline —
do not re-answer it. P6.145 must land under any option).

### 67. [claude] PowerShell as a first-class tool — enable it, refuse it, or leave it half-reachable?

**DECIDED — option 2** (strip `CLAUDE_CODE_USE_POWERSHELL_TOOL` in `buildClaudeSubprocessEnv` and say so); option 3
only if Windows becomes a supported deployment. · **why:** the status quo is a control that has stopped
controlling — a `Bash`-scoped denial silently does not bind to a tool an environment variable we forward can switch
on — and one predicate closes it. · **consequence: row** (ledger J31).

---

## Codex

### 68. [codex] What should an unattended codex turn do with a call no rule covers?

**DECIDED — A as the behaviour plus C as the escape hatch** (deny by default, wired to codex's own
`AskForApproval` granular rejection, with an operator setting defaulting to deny). · **why:** native-first — the
runtime already has the switch and we have never written it — and it removes the switch report's only
SILENT-LOOSER row. · **consequence: row** (ledger A26).

### 69. [codex] "Approve for me": a selectable mode, a codex-only setting, or folded into `auto`

**DECIDED — A** (a codex-only setting, named in the settings page and in the switch report). · **why:** the
recommendation is conditional — *"B, but sequenced after the default-ON/OFF question; if that question answers A
(stay opt-in), take A here too"* — and 2026-09-05 decision 14 answered **A**, so the condition fires.
· **consequence: none — already carried** by unfinished plan row **P6.225** (denominator A66), whose done_means is
exactly a toggle plus a policy textarea in all locales plus one switch-report line, and which states it is
independent of this naming question.

### 70. [codex] Seven fused permission modes, or codex's own two axes and its named profiles

**DECIDED — A for both A67 and A68** (keep the seven fused modes; spend the effort on making their descriptions
true per runtime). · **why:** the mode picker is the one control that must mean the same thing after a runtime
switch; B and C close the difference with codex by opening one between runtimes.
· **consequence: ledger** — the description work is already carried by P6.69, P6.70 and P6.71 (ledger A11), so what
is owed here is the switch-cost sentence the option itself names.

### 71. [codex] An unbounded `**` deny-read glob: bound the scan, or keep the honest warning

**DECIDED — A** (leave `glob_scan_max_depth` unset and keep the warning). · **why:** keep the status quo — writing
it converts a loud partial failure into a silent partial success, and this tree measures 43 matches against a
ceiling of 8192, so the warning does not fire in our own configuration. · **consequence: ledger** (A69; the reason
is already written at `config-writer-permissions.ts:200-213` — record the null and the revisit trigger).

### 72. [codex] May a codex connection use the operator's own AWS Bedrock account, and leave the Nestor gateway to do it?

**DECIDED — b** (an explicit BYO Bedrock card only; the ambient AWS chain never decides). · **why:** parity — Pi and
claude both `have` it — through codex's own documented mechanism, under an explicit user act, while C5's guarantee
that an ambient credential cannot reroute a pinned session survives. · **consequence: row** (ledger C15).

### 73. [codex] The service tier is a first-class codex wire field we send nowhere — user control, managed requirement, or an honest null?

**DECIDED — (b)** (apply the MANAGED requirement, closing B5's `'client'` field; (a) only after, never alone).
· **why:** it closes a measured enforcement hole rather than adding a knob with no receiver.
· **consequence: none — already carried** by unfinished plan row **P6.484** (ledger B5-codex, 2026-09-05 decision
15), which moves the last `'client'` row of `CODEX_REQUIREMENT_ENFORCEMENT` off `unhonoured` and owns the same file
and lane; `newThread.serviceTier` folds into it as a second field rather than a second row.

### 74. [codex] Codex's own `[features]` table has 124 keys and we write two

**DECIDED — option 2** (write the stable user-facing subset explicitly, each with a stated reason at the site).
· **why:** it matches the discipline already in the file (two keys written, two refused with reasons), needs no new
UI, and stops seven user-facing capabilities being decided by a vendor default nobody has read; option 3 would mint
seven single-runtime settings. · **consequence: row** (ledger L18; `features.codex_git_commit` is sitting §1.7 /
P2.11 and is excluded).

### 75. [codex] A repository's checked-in `.codex/` layer, and codex's own trust model

**OWNER — D15.** · **why:** the recommendation (option 2) gives **a repository's checked-in `.codex/` real effect** —
including config keys we do not audit — and codex's own rule seeds `sandbox_mode` from the same trust decision. A
repository influencing the sandbox is a supply-chain posture, not a lane's call. · **consequence: owner sitting.**
Adjacent and already rowed: P6.195 (`.codex` missing from both protected-directory lists) and P6.196 (can a
repository's `.codex/rules/` widen what runs outside the sandbox).

### 76. [codex] Codex's bundled skill tree, which the host's off switch cannot reach

**DECIDED — option 1** (project `disableBundledSkills` onto codex's own `bundled.enabled`), with option 3 as the
finished shape once `skills/list` is wired. · **why:** native-first, one key, no host machinery — and option 2
leaves a documented off switch half-true, which is this fork's largest defect class.
· **consequence: row** (ledger L56; the `$skill-installer` consequence is named at the site and is P6.404's
subject).

---

## For the owner (Russian)

Пятнадцать вопросов, которые делегирование не покрывает. Остальные шестьдесят решены по рекомендации;
один — указатель на уже заданный вопрос.

**D1. MCP-подсказка `readOnlyHint` — можно ли ей пропускать наш гейт?**
Варианты: A — оставить инвариант («подсказка сервера НИКОГДА не авторизует»), записать отклонение; B —
доверять подсказке только для серверов из списка оператора. *Рекомендация: B, список пустой по умолчанию;
если не финансируем — A.*

**D2. Ассистент-черновик правил auto-mode (`/auto-mode-setup`) — строим ли вообще?**
Варианты: A — нет, блок пишет администратор; B — да, только по данным проекта, с подтверждением каждой строки
и managed-выключателем; C — плюс личные источники (история shell). *Рекомендация: B, C отклонить до письменного
запроса оператора.*

**D3. Служебная папка сессии, запись в которую никогда не спрашивает разрешения.**
Варианты: A — нет, каждая запись проходит гейт; B — да, одна host-папка на сессию, названная в гейте, вне
рабочей директории, удаляется с сессией (на claude это его же `CLAUDE_JOB_DIR`). *Рекомендация: B, с тестом на
удаление и на «никогда не читается обратно в контекст».*

**D4. Экран многих сессий, одинаковый для всех трёх рантаймов.**
Варианты: A — не строить, зафиксировать расхождение; B — построить host-side поверх наших же записей сессий
(диспетчеризация, кто чего ждёт, peek/attach/stop). *Рекомендация: B — размер L, со своим i18n, playground и
дизайн-проходом Phase-4.*

**D5. Как окружение пользователя попадает в hook-команду (решать вместе с sitting §1.2).**
Варианты: A — оставить белый список из шести имён (плагин настраивается только на claude); B — настраиваемый
оператором список ИМЁН для всех трёх; C — наследовать всё окружение. *Рекомендация: B — но если §1.2 решается в
пользу отказа, последовательный ответ здесь A с раскрытием расхождения.*

**D6. Точечные «клапаны» песочницы вместо одного грубого.**
Варианты: A — оставить `excludedCommands` как единственный клапан и раскрыть, что расширение возможно только
целиком по команде; B — добавить ключи контейнера и прокси, а `allowAppleEvents` отказать поимённо навсегда.
*Рекомендация: B — A слабее по безопасности, потому что удаляет границу вместо расширения одного измерения.*

**D7. Запуск в контейнере — направление продукта или нет?**
Варианты: a — построить один раз в host-спавнере для всех трёх; b — использовать claude-хук
`spawnClaudeCodeProcess` и оставить Pi и codex снаружи; c — не сейчас, зафиксировать равномерное отсутствие.
*Рекомендация: a или c, никогда b — рекомендация сознательно НЕ выбирает между a и c.*

**D8. Windows: слабая песочница `unelevated` или провижининг codex-овской `elevated`.**
Варианты: A — оставить `unelevated` и честно записать; B — запускать поставляемый нами бинарь настройки в
режиме opt-in `elevated` с откатом и явной диагностикой; C — всегда пытаться `elevated` с тихим откатом.
*Рекомендация: B — но это локальные sandbox-пользователи и файл секретов на машине пользователя, то есть
first-run опыт и стоимость для оператора.*

**D9. Управление встроенным браузером: разрешение по сайтам и грант на полный CDP.**
Варианты: 1 — ничего сверх нынешнего managed-выключателя, CDP остаётся неявным; 2 — host-хранилище доверия по
origin (Разрешить один раз / Всегда / Запретить), гейт и на первую навигацию, и на первый CDP-attach, плюс
managed-замок; 3 — плюс классификатор над write-действиями на внешних origin и выбор сохранения сессии браузера.
*Рекомендация: 3 как цель, 2 как то, что строим первым; вариант 1 — единственный, который НЕ честен.*

**D10. Фоновая дистилляция завершённых чатов в долговременную память.**
Варианты: 1 — остаться на памяти «только по вызову модели» на всех трёх; 2 — включить родную подсистему codex, а
Pi и claude оставить как есть; 3 — один host-дистиллятор для всех трёх, родной у codex выключить.
*Рекомендация: 3, после P6.166 — ценой фонового вызова модели на каждый завершённый чат.*

**D11. Может ли оператор задать таблицу цен, по которой приложение считает стоимость сессий?**
Варианты: A — host-side managed-таблица цен, читаемая всеми тремя (тогда USD-лимиты становятся реальными для
gateway и BYO); B — оставить «Стоимость не сообщается» и лимитировать в токенах. *Рекомендация: A, таблицу
поставляет оператор, никогда не мы, и каждая цифра несёт метку основания.*

**D12. Может ли проверка конфигурации что-то менять после подтверждения, или остаётся отчётом?**
Варианты: A — только чтение, и сказать об этом; B — предлагать и применять после явного подтверждения для двух
безопасных классов находок (сокращение CLAUDE.md и медленный hook); C — плюс удаление неиспользуемых скиллов,
MCP и плагинов. *Рекомендация: B, с превью диффа, undo и без удаления.*

**D13. Может ли наша телеметрия называть человека и сессию?**
Варианты: A — только счётчики, зафиксировать нынешнее отклонение как позицию продукта; B — идентичность за
документированными тумблерами, по умолчанию выключено; C — полный паритет, включая содержимое.
*Рекомендация: B — это уже записанная рекомендация в `2026-07-29-observability-and-cost.md:183`.*

**D14. Может ли переменная окружения заставить сессию выгрузить всю переписку?**
Варианты: A — вырезать четыре `OTEL_LOG_*` из claude-ребёнка и держать codex приколоченным; B — честно
поддержать их на всех трёх за одной host-настройкой (с реализацией лимита длины). *Рекомендация: A — сегодня
внешний `OTEL_LOG_RAW_API_BODIES=1` выгружает всю переписку без единого решения хоста, и статус-кво — тот
вариант, которого нет ни в одном из ответов.*

**D15. Слой `.codex/`, закоммиченный в репозиторий, и модель доверия codex.**
Варианты: 1 — все проекты недоверенные, и сказать об этом; 2 — спроецировать наш `projectTrusted` на
codex-овский `trust_level`; 3 — доверять, но грузить только именованное подмножество слоя.
*Рекомендация: 2 — но тогда закоммиченный `.codex/` доверенного проекта получает реальный эффект, включая ключи,
которые мы не аудируем, и то же решение у codex засеивает `sandbox_mode`.*

---

## Counts

| Verdict | Count |
| --- | --- |
| DECIDED | 60 |
| — of which consequence `row` | 43 |
| — of which consequence `ledger` | 13 |
| — of which already carried by an open row (no new row) | 4 |
| OWNER | 15 |
| POINTER | 1 |
| **Total headings** | **76** |

New questions: 75 (60 DECIDED + 15 OWNER). The 76th heading is the `F30` pointer to owner sitting §1.7.

Rows staged in `denominator-decision-rows.md`: **43**, plus **4** entries under its `## Already carried`.
