# Ledger closure — owner questions (2026-09-05)

Produced by the ledger-closure sweep (Workflow, 21 group slices × 3 adversarial passes, composed 2026-09-05). Source of the plan rows `P6.61`–`P6.188`; every OWNER cell of the 92 non-covered ledger rows is a question here, deduped against `2026-09-04-owner-sitting.md`. The controller presents these to the owner in Russian with options; answers are recorded in the plan's `## Owner decisions` sections.

# Owner questions — one sitting, regrouped by runtime

Every owner question the 21 ledger-closure slices produced, regrouped from ledger sections into the
runtime whose posture the answer changes. Each question keeps its **own options with their buys and
costs verbatim**, its recommendation, its parity direction and its evidence — nothing was summarised.
The bracketed tag is the runtime the decision lands on; `Ledger cells` names what the answer closes.

**30 questions in total: 26 written out in full, 4 already carried by
`docs/superpowers/specs/2026-09-04-owner-sitting.md` and kept here as one-line pointers so nothing is
asked twice.** One merge was applied: section C's two §2.2 entries were the claude arm and the host arm
of a single decision and are now one entry under Claude, keeping both cell ids and the host arm's
constraint. Section D's two reasoning questions are NOT merged — they are one reopening with two
different option sets, and each cell says the other must be answered with it.

- **Host** — 9 questions
- **Claude** — 6 questions (2 already on the sitting page)
- **Codex** — 12 questions (1 already on the sitting page)
- **Pi** — 3 questions (1 already on the sitting page)

Read the ordering inside each section as ledger order, not priority.

## Host

### [host] A restricted safety mode: wait for the native flag, build a host preset now, or decline

*(ledger group A2 — A. The safety floor (A8-A12))*

**Ledger cells closed:** A9-pi, A9-codex. (A9-claude is STRUCTURAL and needs no decision: `--restricted` /
`CLAUDE_CODE_RESTRICTED` requires Claude Code v2.1.248 and the vendored bundle declares 2.1.233 — re-probed
at HEAD, `--restricted` 0 and `CLAUDE_CODE_RESTRICTED` 0 in `sdk.mjs` against live controls `--setting-sources`
1 and `bypassPermissions` 2; `restricted` in `sdk.d.ts` is three false positives, all `unrestricted`. Emitting
the flag today aborts the child with an unknown-option error, and P6.3 `6d2516799` already landed a
machine-pinned tripwire that fails the day the pin makes it reachable.)

**The capability, page verbatim** (`cli-reference.md` §CLI flags, line 121): "Start in restricted mode…
Claude Code removes the built-in tools that run commands or code, and WebFetch… It also confines the
built-in file tools to the working directories, loads only managed settings and `--settings`, refuses
`bypassPermissions`… Requires Claude Code v2.1.248 or later." Three clauses, and no runtime we ship has
all three as one switch today.

**What each runtime already has** (this is the asymmetry that makes the options cost differently):
Pi — `cyclablePermissionModes` defaults to `['explore','plan','default','acceptEdits','auto']`
(`storage.ts:308`), so `bypassPermissions` is already out of the picker, and `explore`/`plan` are
read-only modes enforced by `core/pre-tool-use.ts`; no native restricted mode, and no page defines its
semantics for Pi. Codex — two of the three clauses are native and source-tier at `rust-v0.148.0`:
`sandbox_mode = "read-only"` confines the file tools, and `allowed_sandbox_modes` is compiled into the
`permission_profile` validator (`config/src/config_requirements.rs:1674-1700`), so `danger-full-access`
can be refused outright — the analogue of "`bypassPermissions` refused". The third clause has no
expression anywhere: `disabled_tools`/`enabled_tools`/`disallowed` return zero files under
`packages/codex-protocol/generated/`, and the only non-test occurrence in the tree is the docblock at
`config-writer.ts:1600-1605` — "its per-server `enabled_tools` / `disabled_tools` reach MCP servers only;
neither can express 'this agent may use Read and Grep'".

**Options**

- **A. Wait for the pin, then adopt `--restricted` natively on claude; re-ask for Pi and codex** — buys: native-first with no invented vocabulary, one semantics to match rather than three, and the tripwire already fails the day the flag becomes reachable — costs: no restricted mode at all until the SDK pin moves, and when it lands it "loads only managed settings and `--settings`", so the user's own allow/ask/deny rules stop loading — a behaviour change to accept or refuse at that point.
- **B. Build a host-side restricted preset now, uniform on all three, and map it onto `--restricted` on claude when the pin allows** — buys: one switch on every runtime today, and it is cheapest exactly where the native reading is richest (on codex two of three clauses are configuration, so only tool-removal is host-built there) — costs: a Nessy-invented safety mode whose semantics will differ from Claude's when the native one arrives — a second permission concept beside the seven modes, and a divergence to reconcile later. Most expensive on Pi, which supplies none of the three clauses.
- **C. Decline the capability and record the absence honestly** — buys: nothing to maintain and nothing to reconcile; the seven modes plus deny rules plus the default `cyclablePermissionModes` already reach most of it, uniformly on all three — costs: an operator who wants one locked-down switch has to assemble it from a mode, deny rules and the sandbox settings, and nothing in the product says that is the intended path.

**Recommendation:** A for claude, C as the standing answer for Pi and codex until an operator asks. B
invents a fourth safety vocabulary on the eve of a native one arriving, which is what native-first
forbids.

**DECIDED 2026-09-05 (owner, by recommendation):** A for claude — adopt `--restricted` only when the SDK pin reaches 2.1.248, emitting nothing before it; C for Pi and codex — the uniform absence is the standing answer until an operator asks.

**Parity direction:** the absence is UNIFORM today (all three `absent ʰ`, ledger Switch `UNIFORM`), so no
switch-safety divergence exists to close — this is a *capability* gap, not a *difference* gap. Option **B**
is the only one that closes it on all three at once. Option **A** deliberately OPENS a divergence (claude
gains a mode Pi and codex lack) and therefore owes a switch verdict and an honest surface at the moment the
pin lands, or it becomes exactly the silent divergence the standing rule forbids. Option **C** keeps the
uniform absence and owes only that the product say so where an operator looks.

**Also relevant to this decision, already ruled and not re-asked:** OQ-3 (owner, 2026-08-23) — "bypass
available" counts the install-wide `bypassPermissionsAcknowledged` route, which is the route a restricted
mode would have to refuse.

### [host] A throwaway in-memory fork — build the affordance, or record the clause as declined

*(ledger group F1 — F. Sessions, checkpoints, recovery (F1-F4))*

Closes ledger cells: **F3/pi** and **F3/claude** (one answer settles both), and it also settles why codex's `ephemeral?: boolean` on `thread/fork` is never passed.

F3's title promises "a throwaway in-memory fork". The two other clauses are delivered — Pi forks natively (`FORK_CONVERSATION_SUPPORT` → `pi: true`, `packages/shared/src/agent/runtime-agent-support.ts:295`) and claude branches through the SDK's own `resume` + `forkSession` + `resumeSessionAt` (`packages/shared/src/agent/claude-agent.ts:5416-5425`). The throwaway clause is unmet on every runtime and, more to the point, **unrequested**: the host already owns the flag (`ManagedSession.ephemeral`, `SessionManager.ts:1744` "In-memory only; never writes the session record or metadata to disk", honoured at `packages/shared/src/sessions/storage.ts:220` and `store-v2.ts:292`), and claude even ships its own switch (`persistSession?: boolean`, `sdk.d.ts:1608-1612`, verbatim "When false, disables session persistence to disk … Useful for ephemeral or automated workflows"), but **no caller can ask a fork to be throwaway** — `ephemeral`'s only entry points are `spawn-session-tool.ts:103` (whose schema at :83-108 has no fork field), `handlers/rpc/automations.ts:93` and :275, and `SessionManager.ts:18828`, and none of them forks. No page, source or plan row specifies a requester.

- **A — build it: give the fork path a throwaway request** — buys: the third clause becomes true on the mechanism that already exists, landing the same way on all three runtimes at once (host `ephemeral`, plus `persistSession: false` on claude so neither store is written) — costs: the requester has to be invented (a model-facing `spawn_session` fork mode, or a new UI affordance), plus its interactions with everything that already branches on `ephemeral` — file-checkpoint reporting (`SessionManager.ts:5276`), pending-plan execution (:5253, :5483), persistence (:8187) and the cron retention tier flagged at plan line 1759; on claude such a session "cannot be resumed later", so the switch transcript rebuild (:20027-20038) and the branch anchor lookup (:12631-12657) have nothing to read for it, and it is mutually exclusive with the `sessionStore` mirror (`sdk.d.ts:1618`).
- **B — record the clause as declined and narrow the row** — buys: nothing invented; the two delivered clauses are scored on their merits and codex's unpassed `ephemeral` becomes a stated choice instead of an unexplained gap; one written line per runtime — costs: an in-memory fork stays unavailable everywhere, so a user who wants to try a direction without leaving a session record must delete the child by hand.

Recommendation: **B**, answered once rather than per runtime. Native-first was asked and answers "the host already has the flag"; what neither the host nor any page can supply is a reason to expose it, and building an affordance nobody requested — on a clause whose provenance is one unpassed codex parameter — is exactly what the read-don't-invent ordering puts last.

**DECIDED 2026-09-05 (owner, by recommendation):** B — the throwaway clause is declined and the row narrowed, with codex's never-passed `ephemeral` recorded as a stated choice rather than an unexplained gap.

Parity direction: **A** closes the difference by delivering the capability on all three; **B** closes it by declination — uniform because the answer is "no runtime, by decision", which is honest only if the narrowed row and the codex note are actually written. Independently of the answer, F3/claude's `—` should be filled to `partial ʰ` by branching a claude session from message N and confirming the child's first turn sees history only up to N.

### [host] The session goal is invisible in the app: mount the drafted chip read-only, or add a control affordance too

*(ledger group H2 — H. Subagents, workflows, review (H6-H9))*

Closes ledger cells **H9/pi**, **H9/claude** (and the display half of **H9/codex**) — `partial ʰ` on all
three for one reason, because it is one host surface.

Not blocked by engineering. The display target was ruled 2026-08-22 (plan :2017: the existing
above-composer strip, *"reuse, not a new panel"*) and its blocking data row closed with P2.488
(`f3ddcedda`) — `getPiHarnessRuntimeSnapshot` (`SessionManager.ts:5169`) now emits `goal` past its
`provider !== 'pi'` early return, *"Deliberately provider-BLIND"*. The chip is written and deliberately
unmounted (`apps/electron/src/renderer/components/app-shell/SessionGoalBadge.tsx:2`, :22-25 — *"WIRING IT
LATER IS ONE ELEMENT"*), its only non-test consumer being the playground registry
(`playground/registry/session-goal.tsx:151`). What waits is your playground pass, and two choices inside it.

- **A — take the playground pass and mount the drafted chip read-only, `valueMode: progress`** — buys: exactly the 2026-08-22 call on all three runtimes for roughly the ~30 lines the component's own docblock names, and it closes the actual gap, which is visibility; control stays where an agent product's control belongs, the `Goal` tool already model-visible on Pi, claude and codex (`tool-defs.ts:758-762`, no `visibility`) — costs: setting or cancelling a goal still costs a sentence to the agent rather than a click, and if you count a non-conversational entry point as part of H9 the cell stays `partial` on all three.
- **B — mount as ruled AND add a control entry: a composer command to set a goal, cancel in the chip popover** — buys: a click-path beside the tool path, one host surface serving all three runtimes uniformly — costs: ≈60-100 lines for the command and ≈150-250 for the row on the ledger's own estimate, plus a `SessionManager` edit, a channel and an RPC (P6.51's seven-step shape), and it buys an AFFORDANCE rather than a capability, because the tool path already works. No plan row covers it.

Recommendation: **A**. Settle `valueMode` at the pass — the draft proposes `progress` because it moves while
the user watches, and records that the condition truncates to a few words in a 140px slot and that neither
option is good; you should see that before mounting. Decline B for now.

**DECIDED 2026-09-05 (owner, by recommendation):** A — take the playground pass and mount the drafted chip read-only at `valueMode: progress`; B's control affordance is declined.

Parity direction: this is not a runtime-to-runtime difference — the goal is host-side on all three since P2.2
(`6b05d4c7a`), so **either option closes all three cells at once**. A closes the difference between what the
host knows and what the user can see; only B closes the difference between the tool path and a click path,
and that difference is a preference rather than a capability.

### [host] Website-declared tools (WebMCP / "site tools") in the built-in browser

*(ledger group J2 — J. Tools, MCP, browser (J7-J11))*

Closes: **J7/pi, J7/claude, J7/codex** — one question, three cells. The browser pane is host-owned, so a
split answer would itself be the divergence; do not decide it three times.

Should the built-in browser discover and expose website-declared tools to the agent — a surface where
UNTRUSTED page content supplies tool definitions the model may call?

- **A. Do not build; record the absence as a deliberate posture in `runtime-capability-gaps.md`** — buys: no new injection surface, zero cost; the agent keeps driving pages through the 30 host-owned actuation methods it already has (`packages/shared/src/agent/browser-tools.ts:123-163`), a strictly smaller capability grant — costs: sites that expose only site tools and no usable DOM affordance stay out of reach, and a capability the codex product line advertises stays absent on all three runtimes.
- **B. Build it once in the host pane, with a per-site consent gate and every invocation routed through the existing approval/Guardian path** — buys: one implementation covers Pi, claude and codex because the pane is host-owned, so it cannot become a switch divergence; matches the upstream page's own controls (a safety review before each invocation, an "Enable site tools" toggle) — costs: multi-lane (discovery protocol, tool-name namespacing, per-site consent UI, approval routing, capability descriptor, switch row), and the upstream page itself calls website-provided tool definitions and results untrusted content — we would be adding a channel by which a visited page influences the tool array.
- **C. Build discovery ONLY — list a page's declared tools in the pane and to the user, never register them as callable tools** — buys: the user sees what a site offers with no new model-reachable capability; a cheap honest half (S/M) that closes the observability half and leaves the posture for later — costs: the capability as the ledger states it ("use tools a website offers") stays absent, and a half-built surface can read as done.

Recommendation: **A** for now, **C** if the pane surface is wanted. B is a real product posture — a page supplying tool definitions — and the codex implementation this row points at is NOT available to enable: site tools live in the ChatGPT desktop app's own browser, the shipped `codex-app-server` carries no such string (`site_tools` 0, `webmcp` 0, against controls `workspace_roots` 23 / `zzz_not_a_real_key` 0; `modelContext` scores 16 but every hit is `modelContextWindow`), and the page pins GPT-5.6 Sol/Terra while `buildCodexConfigToml` writes `model_provider = "nessy_gateway"` unconditionally (`config-writer.ts:2675`). So B is a from-scratch host build with an injection surface, not the adoption of a native mechanism.

**DECIDED 2026-09-05 (owner, by recommendation):** A — do not build; the absence is recorded as a deliberate posture in `runtime-capability-gaps.md`, with C reserved should the pane surface ever be wanted.

Parity direction: **no option closes a difference — all three runtimes are equally absent today.** A and C keep parity (A by stating it, C by adding a user-only surface). B would *create* a divergence: J6 already establishes that `browser_tool` does not reach codex, so site tools would be Pi/claude-only even once built. Evidence tier: Claude corpus carries NO page (`grep -c webmcp scripts/claude-doc-pages.tsv` = 0), so for claude any build here is an invented posture; the only page is codex's `learn.chatgpt.com/docs/webmcp.md` (`scripts/codex-doc-pages.tsv:170`), WEAK tier.

### [host] Should the skill listing's budget be a share of the context window, as the page documents, or stay a flat character cap?

*(ledger group L2 — L. Instructions, memory, skills, plugins (L6-L10))*

Ledger cells closed by this answer: **L10/`pi`**, **L10/`claude`**, **L10/`codex`** — one host constant,
`packages/shared/src/agent/core/prompt-builder.ts:183` `SKILL_LISTING_MAX_CHARS = 4_000`, enforced at
`:663`/`:712` for all three runtimes. The vendor page types the documented key as a fraction:
`settings-reference.md#skilllistingbudgetfraction` — *"Type: number, a fraction greater than `0` and at
most `1`. Default: `0.01`, which reserves 1% of the context window."* The constant's own docblock
(`:179-181`) already declares this a product posture: *"That trade — cache stability against a
window-proportional budget — is a product posture, so it is stated here rather than decided in passing"*.

- **A — Keep the flat character budget, and make the unread key HONEST** (a diagnostic / settings-surface line saying `skillListingBudgetFraction` is not read by our listing and `SLASH_COMMAND_TOOL_CHAR_BUDGET` is the channel that is) — buys: a byte-stable listing inside Pi's cached system prefix (#862); no model-metadata plumbing into `PromptBuilder`; one identical answer on all three runtimes, which is the property a runtime switch depends on; the operator stops meeting a silently inert key — costs: stays divergent from the documented contract; a 40,960-token gateway model spends the same 4,000 characters as a million-token one; and A is **not free** — the honest surface is itself a build, plus a settings-reach plumb if the notice is to be keyed off the operator actually setting the key (`base-agent.ts` has no settings reader at all).
- **B — Derive the budget from the window (1 % default, the documented shape), plumbing model metadata into `PromptBuilder`** — buys: matches the vendor contract exactly; proportional on small models and generous on large ones; the documented key acquires its documented meaning; and on codex there is **no** cache cost, since its listing rides the outgoing user turn (`prompt-builder.ts:152-160`) — costs: a mid-session model switch invalidates Pi's cached system prefix and the history behind it (#862); a second thunk plus a model-metadata read in the base builder; the listing stops being byte-stable across turns. The cost is Pi's alone but the change is not.
- **C — Window-derived but CLAMPED and rounded to a coarse step** (e.g. nearest 1,000 chars, floor 4,000) — buys: proportionality on small models with far fewer prefix re-stamps, since most model switches land on the same step — costs: matches neither the page's number nor today's behaviour exactly; the step size is an invented value that must be written down at the site.

**Not an option, and it is the tempting fourth:** a **per-runtime** budget shape (window-derived where
there is no cached prefix, flat on Pi). It manufactures three different listing sizes across a switch —
the silent-divergence class this fork already has most of. If B is chosen it must be chosen for all three
at once. **Also not available:** re-reading `skillListingBudgetFraction` as a fixed character count — the
page types it as a fraction in (0, 1], so any legal value read as a count yields a one-character budget
and empties the listing.

Per-runtime riders the owner should see before answering:
- `[pi]` the cache argument that anchors A lives here and only here (`#862`).
- `[claude]` both keys are real in the SDK we vendor (`sdk.d.ts:5283`, `:5287`, `0.3.233`) **and our own `settingSources: ['user','project','local']` (`claude-agent.ts:1725`) makes the child load them**, so an operator setting the key today is already answered differently on this arm than on the other two. Whether the child then does anything with it is **unmeasured** — the owed measurement is the `measure:` row in `rows-L2.md`, and it is owed under every option. Sitting §2.3 is the delivery posture that would decide whether the child's own listing ever has a subject.
- `[codex]` nothing native to enable: `codex-rs/core/src/skills.rs` and `codex-rs/skills/src/lib.rs` score zero for `budget`/`truncat`/`max_chars`/`limit` at `rust-v0.148.0` (control: `skill` 60/66), and the schema's only skills key, `skills.include_instructions` (`config/mod.rs:3796-3799`), toggles codex's own `<skills_instructions>` block and is not a budget. The host is the only seam.

**Recommendation:** **A.** The measured cost of B is a cache invalidation on every mid-session model
switch, against a benefit that bites only on small-window models, and the 4,000-character floor is
already generous against a 40,960-token window. If the contract is to be honoured, **C** is the cheaper
honest middle.

**DECIDED 2026-09-05 (owner, by recommendation):** A — the flat 4,000-character budget stays and the unread `skillListingBudgetFraction` is made HONEST.

**Parity direction:** **B closes the difference with the documented contract** (the key acquires its
documented meaning on all three runtimes); **A closes only the operator-facing difference** — the key
stops being silently inert — and leaves the contract divergence standing, on the record, as an HONEST
host verdict; **C closes it approximately**, at the price of one invented constant.

### [host] Should a vendor's own skill-invocation spelling do anything when a user pastes one?

*(ledger group L3 — L. Instructions, memory, skills, plugins (L11-L16))*

Closes ledger cells **L11 [pi], L11 [claude], L11 [codex]** — one host seam, three columns. The host owns the
skill catalog for all three runtimes (`packages/shared/src/agent/claude-agent.ts:5474` `plugins: []`; codex is
told about skills only through our listing, `packages/shared/src/agent/core/prompt-builder.ts:279-281`), so no
runtime's own `$`/`/`/`@` resolver is in the path — the seam is our `[skill:…]` marker
(`prompt-builder.ts:707`) plus `packages/shared/src/mentions/index.ts:13-20`. The site already records the
question and reserves exactly one half of it: `prompt-builder.ts:262-292` — "Accepting the vendors' spellings
as ALIASES is possible and is a product decision (a new user-facing invocation syntax, and `$`/`@`/`/` all
carry existing meanings in a prompt), so it is left open here rather than taken quietly."
Vendor spellings: `/plugin:skill` (Claude, `https://code.claude.com/docs/en/skills.md#control-who-invokes-a-skill`
— "You can type `/skill-name` to invoke it directly"), `$skill-creator` (codex — **weak tier**, a vendor page
only: `developers.openai.com/plugins/build/skills.md`, cited as such at `prompt-builder.ts:275`), `@skill`
(ChatGPT).

- **A — keep one marker, stay silent (today)** — buys: one vocabulary and one parser, UNIFORM across a runtime
  switch, and no new meaning for three sigils that already mean shell variables, mentions and slash commands —
  costs: a user pasting a vendor's own prompt template gets plain text that resolves to nothing, with no
  diagnostic; that dead end is the ledger's stated grievance.
- **B — detect and tell, do not resolve** — buys: the silent failure becomes legible — a vendor spelling that
  matches a known skill produces a hint naming the host marker — while the invocation vocabulary stays single;
  ~S–M, host-only, one scan at prompt build. This is **not** what the site deferred, so it needs no sitting
  slot if you delegate it — costs: a heuristic over prompt text, where `$VAR`, `@user` and paths are false
  positives that must be tuned down.
- **C — accept them as aliases resolving to `[skill:…]`** — buys: a pasted vendor template works as written;
  closest to the vendor pages; this is the option the site explicitly left to you — costs: a new user-facing
  invocation syntax on three overloaded sigils, and a widened invocation surface — quoted file content
  containing `$name` could invoke a skill.

Recommendation: **B** — it removes the dead end without minting a second invocation syntax. If you would
rather not spend a sitting slot on it, delegate B to a lane and rule only on **C**, the half the site actually
reserved for you.

**DECIDED 2026-09-05 (owner, by recommendation):** B — a vendor spelling that matches a known skill is detected and named, never resolved; C stays refused.

Parity direction: **C** closes the difference against all three vendor surfaces (a vendor template works
verbatim on every runtime). **B** closes the *honesty* difference only. **A** leaves the gap open, and it is
uniform across runtimes either way — no answer here creates a switch divergence.

---

### [host] Should a marketplace's `headersHelper` command be executed to mint an archive-download credential?

*(ledger group L3 — L. Instructions, memory, skills, plugins (L11-L16))*

Closes ledger cell **L12 [host]** (the `headersHelper` residue; the header-plumbing residue of the same page
sentence is BUILDABLE and carries its own row in `rows-L3.md`). Today the app refuses at parse time and says
so: `packages/shared/src/plugins/archive-headers.ts:156-172`,
`marketplaceEntryHeadersHelperDiagnostic` — "declares a \"headersHelper\" command, which this app does not
run; its archive download is sent with only the headers listed in \"headers\"" (called from
`external-catalog-adapters.ts`). **The operator off-switch and the vendor's executor both already exist; only
ours does not**: in the extracted native binary at `claudeCodeVersion 2.1.233`,
`disableCommandPluginSources` scores 14 occurrences and `headersHelper` 70 (7 and 3 in `sdk.mjs`, 0 and 0 in
`sdk.d.ts` — name the target when repeating this probe), and the managed key is already a real tri-state in
the restrictive-only filter's copy list, pinned by `claude-managed-settings.test.ts` and landed deliberately
*before* any helper execution (**P3.220**, `0d0f8e336`: "Building the `url` header support without it would
ship command execution on a marketplace's say-so with no operator off-switch"). Page read 2026-09-04
(`plugin-marketplaces.md`): the acceptance flow is **entry-only** — "A user accepts a plugin entry's command
each time they install or update that one plugin by itself" — while a marketplace `url` source's command "is
declared in a settings file … so Claude Code doesn't ask the user to accept it on each install or update" and
runs "Without asking, including during a background marketplace refresh"; `"strict": false` is required of the
**entry** only; and the managed block carves itself out — "Under either block, Claude Code still runs the
command for a marketplace that managed settings themselves declare."

- **A — keep refusing, named at parse time (today)** — buys: no shell line runs on a catalog's say-so, and the
  failure is legible before the 401 instead of after it — costs: a registry whose credential rotates (the
  ordinary corporate artifact-server case) cannot be installed from at all; `headers` alone cannot carry an
  expiring token.
- **B — execute it behind the documented gates, both places** — buys: contract parity with the page —
  `disableCommandPluginSources` honoured, the 500-char/10-second/JSON-object rules enforced, the env-scrub for
  project-declared commands applied, per-install acceptance for an entry command with its `"strict": false`
  requirement — costs: a marketplace can run a shell line on the user's machine, and for a marketplace `url`
  source declared in user or managed settings the page grants **no acceptance prompt at all** — it runs
  "Without asking, including during a background marketplace refresh". Operators must set the managed key to
  stop it, and the entry half needs an acceptance flow built and supported.
- **C — execute only where managed settings declare the marketplace, never a user-added or catalog-declared
  one** — buys: the corporate case works, the execution surface is bounded to what the operator already
  delivers by policy, and it follows the vendor's own carve-out; no acceptance UI is needed, because that tier
  has none in the page either — costs: one documented field with two behaviours, and a user-added private
  registry still cannot use it — an asymmetry that must be said in the refusal text.

Recommendation: **C** — it buys the case this row was opened for while keeping shell execution inside the
trust boundary the operator already owns, and it is the smallest slice the page itself distinguishes; **A**
stays correct until an operator asks.

**DECIDED 2026-09-05 (owner, by recommendation):** C — the helper runs only for a marketplace that managed settings themselves declare, with the asymmetry stated in the refusal text.

Parity direction: **B** closes the difference with the page completely; **C** closes it for the managed tier
and states the residue; **A** leaves us narrower than the contract. All three are UNIFORM across runtimes —
the host owns the install path for all of them (`claude-agent.ts:5474` `plugins: []`).

---

### [host] Should the app gain a route for git repositories on hosts other than github.com and `*gitlab*`?

*(ledger group L3 — L. Instructions, memory, skills, plugins (L11-L16))*

Closes ledger cells **L13 [pi], L13 [claude], L13 [codex]** — again one host resolver, three columns. Bitbucket,
Azure DevOps, CodeCommit, a self-hosted forge such as `git.tcsbank.ru`. The posture is written at the site and
the options are read off it, not invented: `packages/shared/src/plugins/source-resolver.ts:22-79` — "a clone
route brings the git binary, credential-helper/SSH authentication, egress policy and sandboxing with it. That
is a decision about what this app executes on a user's machine, not a parser change, so it is written down here
rather than taken quietly inside a lane" — and the same docblock names both routes by their old ids ("C4b,
extending the archive route; C4c, a `git clone` fallback"). Existing routes are per-host archive endpoints
(`:23-25`: "GitHub is fetched through codeload and GitLab through
`/api/v4/projects/:id/repository/archive`"), allowlist at `:80`, refusal at `:256-271` with
`supportedAlternatives: ['archive','npm']`. The `#ref` half is already closed (`parseGitUrlRefPin`, `:646-651`,
**P6.40** `21664a82b`), and the page and the bundle AGREE that `url`/`git-subdir` are host-agnostic — we are
narrower than the contract (**P3.219** `5087d9ecd`). **Native-first, asked on all three:** claude *can* clone,
but only via `Settings.extraKnownMarketplaces` into the CLI's own plugin cache — the per-runtime regression
`plugins: []` exists to avoid; the host's `acquisition.ts` is fetch-only by construction, with no child-process
spawn at all; and **codex already clones, measured on the shipped binary** — `git clone marketplace source`,
`git checkout marketplace ref`, `--filter=blob:none`, `sparse-checkout set`, `ls-remote`, `rev-parse`, hardened
with `GIT_TERMINAL_PROMPT=0` and `safe.bareRepository=explicit`, from `core-plugins/src/marketplace_policy.rs`
— and exposes it as `marketplace/add` with `MarketplaceAddParams = { source, refName?, sparsePaths? }`
(`packages/codex-protocol/generated/v2/MarketplaceAddParams.ts`). That last finding is what makes option C
cheaper on one runtime and riskier overall.

- **A — stay fetch-only; the refusal names archive and npm (today)** — buys: no git binary, no
  credential-helper/SSH authentication, no new egress or sandboxing surface; the refusal is actionable rather
  than a dead end, and all three runtimes behave identically — costs: we stay narrower than the documented
  contract, and a corporate deployment on a self-hosted forge must republish its plugins as an archive or an
  npm package.
- **B — keep fetch-only, extend the EXISTING per-host archive route to an operator-configured host list (the
  site's C4b)** — buys: most self-hosted forges (Bitbucket, Azure DevOps, Gitea) work with no process spawn,
  reusing the guarded fetch, the digest pin and the `headers` credential already in place — the same mechanism
  GitHub and GitLab already use, not a new one — costs: per-forge archive-URL templates the host must maintain
  and keep true; authentication limited to what `headers` can carry; one new operator setting.
- **C — build the `git clone` route (the site's C4c)** — buys: full parity with the page on any host, including
  `git-subdir`'s sparse clone; and it is cheaper than it looks on one runtime, because the codex binary we
  already ship clones with ref and sparse-path support and exposes it over the protocol we drive, so codex needs
  enabling rather than building — costs: on Pi and claude it is still a git binary dependency,
  credential-helper/SSH authentication, egress policy and sandboxing for a spawned process. And taking the
  cheap codex half **alone** would make a plugin installable on one runtime and refused on the other two — the
  switch divergence the owner declined in the same shape at **Dev-9** (plan:2082). Either all three or none.

Recommendation: **A** until a customer forge is actually named; then **B**, because it buys the named host
without the execution class C introduces — and if C is ever taken, take it for all three, not for codex
because it is free there.

**DECIDED 2026-09-05 (owner, by recommendation):** A now — fetch-only, the refusal keeps naming `archive` and `npm`; B once a customer forge is actually named; C only ever for all three runtimes at once.

Parity direction: **C** closes the difference with the page fully (and is the only option that reaches
`git-subdir`); **B** closes it for the forges an operator names; **A** leaves it open and honest. The one
answer that would create a NEW divergence is C-on-codex-only.

---

### [host] A one-message override for the steer-vs-queue default

*(ledger group O — O. Notifications, UI, accessibility)*

**Ledger cells closed:** O5-host-override (host). Note that the ledger's own O5 row (`docs/superpowers/specs/2026-08-28-capability-ledger.md:1443`) states the capability as "Choose the follow-up behaviour (steer vs queue) as **one global default**", switch verdict `UNIFORM` — that default IS delivered. This question is the separate affordance codex's page describes beside it.

**The clause.** `learn.chatgpt.com/docs/prompting.md:158-160`, re-fetched HTTP 200, verbatim: "The setting also shows the shortcut for using the other behavior for one message without changing your default". Weak tier, and it describes the ChatGPT desktop app's setting rather than a spec for ours.

**Why it is not a lane call.** At HEAD `SessionManager.ts:22861-22879` computes `effectiveBehavior` from `resolveMidStreamBehavior(connection)` plus two host-forced `'queue'` cases and accepts no per-send argument; `AiSettingsPage.tsx:1130-1137` `handleSetMidStreamBehavior` writes only the persistent per-connection value through `saveLlmConnection`. So adopting the clause is a shared-wire change (renderer → `sessions:send` IPC → RPC → `SessionManager.sendMessage`), not a local edit. And the obvious modifier is already spent: `FreeFormInput.tsx:1772-1792` binds Cmd/Ctrl+Enter to SEND in BOTH `sendMessageKey` modes — in `enter` mode as an explicit "power user shortcut" (`:1781-1783`), in `cmd-enter` mode as the send key itself (`:1787-1789`) — so which chord to spend, and whether to spend one at all, is user-visible policy. No runtime has a per-message mechanism to enable: codex does it with Enter-vs-Tab inside its own TUI, which our renderer does not use; Pi and the Claude SDK expose no per-send hint. Step (2) of native-first is therefore the layer, and `effectiveBehavior` is the seam.

**Question.** Codex's page says the follow-up setting also shows a shortcut for using the other behaviour for ONE message. Ours has only the per-connection default. Do we add a one-message override, and how is it invoked?

- **A — Do not build it; record the clause as a deliberate non-adoption beside `defaultMidStreamBehavior`'s docblock (`llm-connections.ts:634-660`) and in the ledger's O5 note** — buys: no send-wire change and no new chord in a composer whose send key is user-configurable; the `UNIFORM` verdict stays literally true; zero risk to a habitual key; the residue becomes visible instead of silent. — costs: changing follow-up behaviour for one message means opening Settings → AI; the one documented clause of O5 we do not meet stays unmet.
- **B — Build it on Alt/Option+Enter, shown beside the follow-up setting and registered as a 28th rebindable action** — buys: the documented affordance, identical on all three runtimes with no provider branch; discoverable exactly where the page says it is; rebindable and collision-checked by the registry O2 just finished. The chord is measured free in both send-key modes and in the action registry: `grep -an altKey FreeFormInput.tsx` returns one hit, the ArrowUp guard at `:1799`, and `grep -an Enter apps/electron/src/renderer/actions/registry.tsx` returns 0. — costs: a per-send argument on the send path — renderer, `sessions:send` IPC, RPC handler, `SessionManager.sendMessage` — i.e. a shared-wire change; both locales; a 28th action plus its collision copy; a live case; and a chord users must learn.
- **C — Build it without a chord: a per-message control on the send affordance or on the queued-message strip O4 just shipped** — buys: no keyboard collision with a configurable send key, no registry action, same host seam. — costs: pays the whole wire cost for a control the page does not describe; less discoverable than "shows the shortcut"; a new composer control to design and sweep through every playground state.

**Recommendation:** B, and the only part that needs the owner is the chord — Alt/Option+Enter is measured free in both send-key modes and in the action registry, so B is buildable the moment it is blessed. If a chord is not to be spent, prefer A over C: C pays the full wire cost for an affordance the page never describes, while A at least makes the gap legible.

**DECIDED 2026-09-05 (owner, by recommendation):** B — the one-message override is built on Alt/Option+Enter, and the chord is blessed.

**Closes the difference (parity direction):** B. It is the only option that meets the one documented clause of O5 we do not meet, and it meets it identically on Pi, claude and codex — a host affordance over `effectiveBehavior`, no provider branch, so it adds no new switch divergence. `done_means`: with a connection defaulting to `'queue'`, the override-send steers into the running turn and the stored setting is unchanged after the send; with a connection defaulting to `'steer'`, the same gesture queues instead; the affordance is shown beside the setting, and both locales carry the label. A and C both leave the parity gap open — A honestly, C by building something else.

### Cross-reference

The WebFetch preflight's **host arm** — the residual disclosure — is merged into the Claude
section's single §2.2 entry, per section C's own instruction. It is a host cost; it is filed there
only so the one decision is read once.

## Claude

### [claude] Reopen G4: does a reasoning chain cross a switch, now that reasoning is persisted?

*(ledger group D — D. Switching correctly)*

> **Stitch note — this question is half of a pair.** Its twin is the Codex section's
> reasoning-carry question. Both cells say the two must be answered TOGETHER: answering one
> alone inverts the parity the reopening exists to buy. The regrouping split them by runtime,
> so where the text below says *above* or *below* it means the Codex section.

**Closes ledger cell:** D3/Claude (`absent ᵗ`). Coupled to D3/Codex below; the two should be answered
together, and answering only one inverts the parity the reopening exists to buy.

**Why it is being asked again.** G4 (2026-08-20, `docs/superpowers/plans/2026-08-20-cross-runtime-history-carry.md:3417`)
answered *«да, цепочку пока не переносим»* — reasoning is not carried — and `:1156-1159` put the
persistence work it would need out of that plan's scope. The written premise was that nothing in Nessy had
ever persisted thinking content (0 rows in 5,332) and that the stored message had no field for it. **That
premise no longer holds:** P4.4 (`a6d56aabc`) persists `isThinking` at `packages/core/src/types/message.ts:465`.
And the replay shape the runtime accepts is observable: 5,324 `~/.claude/projects/**/*.jsonl` transcripts,
149 of the first 200 containing `"type":"thinking"` beside a `"signature":"CAISmQIKiAEIEBgC…"`. The SDK
declares the block (`sdk.d.ts:3030-3032`); we take it on the wire and drop the attestation deliberately at
`packages/shared/src/agent/backend/claude/event-adapter.ts:652-653` ("*a cryptographic attestation over the
reasoning, not content, and it has no reader downstream*"), and there is no reader at
`claude-transcript-rebuild.ts:493`. So the remaining obstacle is the ruling, not the runtime.

- **(a) Keep G4 — reasoning still does not cross; say so once at the switch** — buys: no new persisted
  attestation, no new 400 class, no schema movement, and the gap becomes HONEST rather than silent (that
  sentence is a row in `rows-D.md` and is owed under every option here) — costs: a claude→claude switch
  keeps losing a chain the runtime would accept back verbatim; the cell stays `absent` by decision.
- **(b) Carry claude-origin reasoning only, signature included** — buys: a resumed claude session keeps its
  own reasoning prefix; the drop at `event-adapter.ts:652` becomes a carry with a reader at
  `claude-transcript-rebuild.ts:493`; uses the runtime's own documented replay format, so nothing is
  invented — costs: an opaque attestation is persisted to disk and onto `RuntimeHandoffRow`
  (`packages/server-core/src/sessions/runtime-handoff.ts:24-40`, the shared M prerequisite for all three D3
  cells); a signature-less or foreign block 400s (plan `2026-08-04:729`), so the rebuild needs a
  strip-on-mismatch arm plus a negative control that must 400.
- **(c) Carry reasoning everywhere as unlabelled text** — buys: uniform on all three runtimes, no
  attestation stored, no new wire shape — costs: another model's reasoning enters the target's context as if
  it were its own prose; on claude it is strictly worse than (b), since the native slot exists and is
  refused.

**Recommendation:** (b) for claude→claude, with (a)'s sentence kept for every foreign-origin arm — the
runtime's own format is the nearest documented solution, and the residue (foreign reasoning carries no
Anthropic attestation) is stated once instead of built around.

**DECIDED 2026-09-05 (owner, by recommendation):** (b) — claude-origin reasoning is carried with its signature, and (a)'s sentence is kept for every foreign-origin arm.

**Parity direction:** (b) closes the claude→claude difference and leaves the cross-runtime one named;
(c) is the only option that makes all three runtimes behave identically, and it does so by laundering
foreign reasoning as prose; (a) closes no difference and converts a silence into an honest sentence.

---

### [claude] Claude's own session store is readable, and our own sessions are written into it — do we surface it?

*(ledger group F1 — F. Sessions, checkpoints, recovery (F1-F4))*

Closes ledger cell: **F4/claude**.

The SDK ships the reader half complete and this tree already pins it: `getSessionMessages`, `listSessions`, `getSessionInfo` are asserted to exist by `packages/shared/src/agent/__tests__/claude-sdk-session-read-agreement.test.ts:133-135`, with `writeSessionMessages` asserted ABSENT as the negative control (:132) and the reason written at :129-131 ("the store APIs are `@alpha` and require a `SessionStore` this host does not implement"); confirmed in the typings at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:956`, :761, :731 (plus `deleteSession` :532, `forkSession` :702). Our claude sessions land in that store two ways — the SDK persists there by default (`persistSession` defaults true, :1612) and the switch rebuild writes one itself (`SessionManager.ts:20027-20038`, minting an sdk session id and writing `claudeTranscriptPath({ configDir, cwd, sdkSessionId })`). Archive has **no** native equivalent either way: the mutators are rename/tag/delete only, so archive stays ours whatever is decided.

- **A — keep the host store as the single source, and write the decision down** — buys: one list, one search, one archive semantics across three runtimes, and no session appears that Nessy cannot open, resume or archive; one sentence at `claudeTranscriptPath`'s site and one line in the switch report closes it (S, documentary) — costs: a user who has also used the Claude Code CLI in the same directory cannot see or resume those conversations from Nessy.
- **B — read claude's store and offer its sessions, marked as foreign** — buys: real recovery — a CLI session, or a Nessy session whose own record was lost, becomes re-openable, through the runtime's documented reader rather than anything invented — costs: two classes of session in one list with different capabilities (foreign ones cannot be archived and carry no Nessy metadata), plus reading transcripts the user created in another product, which is a privacy posture rather than a feature toggle; M at least, and it makes the ledger's own "single source across all three" claim false.

Recommendation: **A**. The ledger already calls this cell "coherent; unwritten" — the entire residue is that it is unwritten, and B introduces a second class of session to fix a case A can also fix by never losing our own record.

**DECIDED 2026-09-05 (owner, by recommendation):** A — the host store stays the single source on all three runtimes and the decision is written down.

Parity direction: **A** closes the difference by making the host store the uniform answer on all three runtimes and saying so; **B** would close a recovery gap on claude only and re-open the divergence it fixes, since Pi's own store (F4/pi) and codex's (F4/codex, ephemeral by ruling) cannot be surfaced the same way.

### [claude] Does a `supportsImages` flag LEARNED from the endpoint's own refusal count as a declaration?

*(ledger group J2 — J. Tools, MCP, browser (J7-J11))*

Closes: **J8/claude** (domain: BYO endpoints only — gateway models are already seeded `supportsImages: false`).

Already ruled, and this question asks to amend that ruling narrowly: Owner 2026-08-28
(`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md:1011-1014`) — *"prefer the endpoint's
refusal to our prediction of it, and keep a local capability flag only where an explicit per-model
declaration exists to honour"* — and `:1029-1032`, which downgrades grey-out-and-explain to *"UX
improvements, not correctness gaps … neither is owed for the behaviour to be right."*

The ruling says keep a local flag ONLY where an explicit per-model declaration exists. Does a flag
LEARNED from the endpoint's own named refusal count as such a declaration — or is it the capability
oracle the ruling deleted, wearing the endpoint's words?

- **A. Keep the ruling as written — no learned writes; the endpoint refuses each time and the named 400 is the whole surface** — buys: the ruling stays whole and no local oracle can ever be wrong about a model; zero work, since the three legibility arms (P3.125/P3.127/P3.138) already landed and the ruling itself says grey-out is not owed — costs: on a BYO text-only endpoint every image turn fails after the fact, repeatedly, and the composer never greys out; the user pays a whole turn to relearn what the last turn already said.
- **B. Amend narrowly: a flag may be written when the endpoint returns its exact named image refusal, labelled LEARNED and reversible through the existing P3.136 toggle** — buys: grey-out-and-explain on BYO endpoints quoting the endpoint's own sentence, the UX the ruling itself calls better; one runtime-agnostic writer serves Pi, claude and codex, so it cannot become a switch divergence — costs: a local capability oracle re-enters by the back door — a one-off, model-side or proxy-injected 400 silently disables a capability the endpoint may serve, and `modelSupportsImages` consults the flag BEFORE ever asking the endpoint again; learned and declared must be distinguishable wherever the flag is shown, or the next reader inherits a guess that looks like a fact.

Recommendation: **B, narrowly** — written only on the verbatim named refusal (never a generic 400), stamped as learned rather than declared, reversible in one click. It is the one shape that keeps the ruling's purpose (we do not guess) while buying the UX the ruling itself called better. If the owner prefers the letter of the ruling, A costs nothing and loses nothing correctness-shaped.

**DECIDED 2026-09-05 (owner, by recommendation):** B, narrowly — a LEARNED flag written only on the endpoint's verbatim named refusal, stamped as learned and reversible in one click.

Parity direction: **B closes it identically on all three runtimes** (one host writer; no switch divergence). A leaves all three equally lossy, which is parity without the capability. Mechanism verified at HEAD: `llm-connections.ts:699` `setModelSupportsImages`, `:891-913` `modelSupportsImages` honours the explicit declaration FIRST, `handlers/rpc/llm-connections.ts:540-544` already pushes the change to live sessions, and the override survives a BYO catalogue refresh at `model-fetchers/openai-compat.ts:197` (only `id`/`name`/`description`/`contextWindow` are written after the spread). Residue the answer must not assume away: only `openai-compat.ts` and `nestor.ts` build that overrides map — `anthropic.ts`, `bedrock-vertex.ts` and `pi.ts` preserve nothing. The two candidate pre-send oracles were asked and both answered negative: the gateway's `/cli/models` publishes no modality field (P3.114) and codex's `model/list.inputModalities` describes OpenAI's catalogue, never our model (P3.115, `3c81a5d38`, refuted and deliberately not built).

### [claude] One telemetry opt-out, two meanings — do we override the runtime we vendor?

*(ledger group M — M. Observability and diagnostics)*

Closes ledger cell **M1 [claude]** (the opt-out half; the opt-in alias half is a plan row and needs no ruling).

`DO_NOT_TRACK` / `DISABLE_TELEMETRY` silence Pi's event stream, the host metrics exporter and codex's `[otel]`. They do **not** silence the claude SDK's own OTLP export. Measured in the binary we ship (0.3.233 / `claudeCodeVersion 2.1.233`): the child reads all three opt-out names and routes them to `CFe()`, which gates **only Anthropic's own 300 s first-party reader**; the operator's OTLP metrics and logs hang off the opt-in alone (`function Jmf(){return Ln(process.env.CLAUDE_CODE_ENABLE_TELEMETRY)}`). `monitoring-usage.md` names none of the three opt-out variables (0 hits, control `CLAUDE_CODE_ENABLE_TELEMETRY` → 9 lines). So this is a posture choice about overriding the vendor, not a defect.

- **Match the vendor (status quo), and say so** — buys: no divergence from the runtime we ship; an operator's collector keeps receiving what they configured; zero risk of silencing a working stream. — costs: one env var with two outcomes across three runtimes stays open, the exact divergence class this ledger exists to close; a privacy-conscious user's `DO_NOT_TRACK` is weaker on claude than on Pi and nothing says so.
- **Override with the shared predicate — strip the opt-in from the claude child whenever `telemetryOptedOut` fires** — buys: one meaning for the opt-out on all three runtimes, through the one predicate that already serves the other two. — costs: we silence a stream the vendor deliberately keeps running, so the fork behaves unlike Claude Code for an operator reading Anthropic's page; and it must read the AMBIENT env, never the merged child env, because the host itself writes `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'` on the gateway path (`claude-agent.ts:3896`) while `usage-metrics.ts:427` treats any non-empty value of that name as an opt-out — the naive version silences every gateway session.
- **Override only the two vendor-neutral names (`DO_NOT_TRACK`, `DISABLE_TELEMETRY`), never `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`** — buys: a uniform user-facing opt-out with the self-inflicted regression excluded by construction, since the only name the host writes itself is the one left out. — costs: our opt-out vocabulary then differs by one name between the claude path and the other two — a difference to document and keep documented.

Recommendation: **option 3.** Parity direction: options 2 and 3 close the difference (3 without the gateway regression); option 1 keeps it and must be paid for by writing the asymmetry where a user can read it.

**DECIDED 2026-09-05 (owner, by recommendation):** Option 3 — `DO_NOT_TRACK` and `DISABLE_TELEMETRY` are honoured on the claude child; `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` never is.

### Already on the sitting page — pointers, not re-asks

**[claude + host] WebFetch sends every requested hostname to a hardcoded vendor endpoint before fetching — and the residual disclosure once the preflight is decided**

*(ledger group C — C. What leaves the machine)*

**Ledger cells:** C2/claude (the preflight) and C2/host (the residual disclosure). **One decision,
two arms** — merged here from what section C filed as two questions, on that group's own instruction:
*"The two §2.2 references are the claude arm and the host arm of one decision, not two decisions; if the
stitch de-duplicates by section, collapse them and keep the host arm's constraint."*

→ sitting §2.2

**The host arm's constraint, carried forward:** the disclosure sitting §2.2 asks for already exists as the
gaps-document row at `docs/architecture/runtime-capability-gaps.md:96`, which **refuses a switch-cost row
in writing** — *"the switch table's admission rule is a capability the SOURCE has and the TARGET lacks,
and this is the inverse — moving ONTO claude acquires an egress, it does not lose one"*. So option (C)
needs no new switch row, and `honest_surface` for C2/host is **present**, not missing.

**[claude] Skills reach claude as host-rendered prompt text, not as filesystem artifacts**

*(ledger group L3 — L. Instructions, memory, skills, plugins (L11-L16))*

→ sitting §2.3

## Codex

### [codex] Codex ships its own model-backed approval reviewer, we already wired it, and it is default-OFF

*(ledger group A1 — A. The safety floor (A1, A2, A4, A5, A7))*

**Closes:** ledger cell A1-codex (`absent ᵗ`) — and, whichever way it goes, it decides the wording of the
A1-host switch-cost sentence in the host-honesty row.

Codex's own `approvals_reviewer = "auto_review"` guardian subagent, plus `[auto_review].policy`, is
**fully built and wired at HEAD** (P3.2, `384e2fb38`+`7736e32a9`) and shipped **opt-in, default false** —
a lane default set at three sites, not an owner ruling. The ledger's `Why absent` narrative never
mentions that the mechanism exists. So this is a default, not a gap. Two prior claims are refuted by
measurement and should not weigh on the answer: the reviewer **is** eligible in Allow-all (with the
sandbox off no mode resolves to `never`, so the `approvalPolicy !== 'never'` emit gate never fires —
`config-writer.ts:2623`, `:3300`, `sandbox-settings.ts:403`, `config-writer.ts:873`, `:975-976`), and
gating this on P3.139 is self-refuting because P3.139 is already answered OFF.

**Options.**

- **A — leave opt-in (status quo), and spend the honesty instead** — buys: no added per-approval latency
  or token cost; no vendor judge influencing permission outcomes without an audit receipt; the posture
  stays symmetric with the claude classifier the owner already ruled OFF in P3.139. — costs: A1 stays
  `absent` on codex for every default install, a shipped capability nobody meets; the honesty is copy,
  not protection.
- **B — default ON for the interactive modes** — buys: a second, native, opt-out-able safety judge on
  codex wherever an approval is raised, and it is eligible in Allow-all at HEAD, the mode this ledger
  row scopes itself to. — costs: latency and token cost on every escalated approval, both **unmeasured
  on codex** — the exact evidence P3.139 demanded before enabling the claude twin; its verdicts reach us
  only as three guardian notifications, with no receipt equivalent to `ClaudePermissionDenialReceiptV1`,
  so it is an unauditable influence on permission outcomes; the denial breaker (3-consecutive /
  10-of-50) becomes reachable by default; and P3.2 deferred *does auto_review alone route approvals* to
  P5.4's live smoke, still 🟨, so the mechanism is live-unproven.
- **C — default ON and ship a `[auto_review].policy` describing this deployment** — buys: B, plus the
  codex judge learns the same T-Bank hosts and credential rules the claude classifier was given in
  P3.94 — the symmetric move. — costs: B's costs, plus a second policy text to keep true; the policy is
  emitted only alongside the reviewer, so it inherits B's enablement question rather than softening it.

**Recommendation:** **A**, until two things exist — P5.4's live smoke proving `auto_review` alone routes
approvals, and one reading of its latency, token cost and verdict visibility. Then re-ask B (and C only
together with B). Enabling a judge on codex on evidence P3.139 refused on claude would be the clever
complete answer to a question nobody has finished asking.

**DECIDED 2026-09-05 (owner, by recommendation):** A — the reviewer stays opt-in until P5.4's live smoke and one reading of its latency, token cost and verdict visibility; the honesty is spent instead.

**Parity direction.** **B closes the difference** — it is the only option that makes A1 non-`absent` on
codex, and it does so by enabling the runtime's OWN mechanism (native-first, tier 1). **C closes it and
also makes it symmetric with the claude arm's policy configuration.** **A does not close it**; it
converts a silent divergence into an honest one, which is the host's job under the native-first rule but
is not parity. Note the asymmetry either way: on claude the same class of judge is deliberately OFF, so
B/C makes codex *stricter* than claude by default and owes a switch-cost sentence in both directions.

**Evidence:** `config-defaults-schema.ts:54-60` verbatim — *"OPT-IN (default false): only meaningful on
the codex runtime, and only when the approval policy is interactive"* → `codexAutoReviewEnabled: boolean;`
at `:61`; `codex-agent.ts:7160-7167` `buildCodexAutoReviewOptions` (`if (!enabled) return {};`), call
site `:2803`; plan `:3171` (P3.2), P5.4 at `:3558` (🟨); `runtime-switch-costs.ts:486-500`, whose
`guardianJudge` docblock already knows codex has its own auto-review.

### [codex] An administrator's `models.newThread` is reported and never applied

*(ledger group B — B. What an organisation can enforce)*

**Ledger cells closed:** `B5-codex` (ledger `partial ᵗ`, row B5 "the machine-wide requirement channel"). Also moves the last
`'client'` row of `CODEX_REQUIREMENT_ENFORCEMENT` off `unhonoured`, which is what keeps the B5 codex cell at `partial`.

An administrator deploys `requirements.toml` carrying `models.newThread`. Codex enforces **20 of its 25 requirements itself**
(`Constrained<T>` + `apply_to_config` replaces a disallowed value and announces the substitution as a `configWarning`), 3 are
`inapplicable`, and exactly **one** — `models` — codex delegates to its *client*: `tui/src/managed_new_thread_defaults.rs:7-47`,
fed at `tui/src/app_server_session.rs:439`, applied at `tui/src/app/startup.rs:127` and `tui/src/app/session_lifecycle.rs:662`.
We are the same kind of client, holding the same answer. Codex's own posture is stated in source, verbatim: *"Managed values are
defaults rather than enforcement. Preserve explicit launch choices"* — it fills `config.model` **only** when the invocation
carried no `-m` and no `-c model=`. That branch has no counterpart here: `BaseAgent` resolves
`this._model = config.model || defaultModel` (`base-agent.ts:1140`), so a Nessy codex thread **always** starts with a resolved
model and there is no unset slot to fill. Today the value is only *surfaced* (`managedNewThreadDefaults`, read at
`codex-config-requirements.ts:629`/`:654`). What should a Nessy codex thread do with it?

- **(a) Keep reporting only** — the administrator's value is shown beside what the session actually ran. — buys: zero new code; no
  session is ever moved off the model the picker shows; the honest-surface property P6.7 built stays intact. — costs: an
  administrator who restricts models gets **no restriction**; the one requirement of 25 this build *could* have honoured stays
  unhonoured, and the ledger cell stays `partial` permanently.
- **(b) Apply it exactly as codex's client does** — fill the model only when the connection **defaulted** (no explicit user pick),
  leave an explicit pick alone. — buys: parity with the reference implementation rule for rule; the administrator's default takes
  effect on fresh threads; the last `'client'` row closes and the cell moves to `covered`. — costs: the connection layer must
  distinguish "the user picked this model" from "the connection defaulted to it", a distinction `BaseAgent` does not carry today
  (`base-agent.ts:1140` collapses both into one `||`); a lane-day plus a wire change on the connection record.
- **(c) Apply it always, and mark the picker with the administrator's constraint** — buys: the strongest enforcement, and the
  control that lies stops lying — the picker itself shows the clamp instead of a transcript sentence after the fact (which is
  A11's residue too). — costs: strictly **stronger than codex itself**, which the source explicitly declines; moves a session off
  the model the user chose, the exact defect P6.7 had just finished making audible; touches the picker, its i18n in all locales,
  and the switch dialog.

**Recommendation:** (b). It is the nearest documented solution — codex's own client, read at `rust-v0.148.0`, the tag the shipped
binary is built from — and the only option that neither invents a posture (c) nor leaves an administrator's control inert (a). The
connection-layer distinction it needs is worth having on its own: several other rows want to know whether a model was *chosen* or
*inherited*.

**DECIDED 2026-09-05 (owner, by recommendation):** (b) — the administrator's value is applied exactly as codex's own client applies it: only where the connection defaulted.

**Closes the difference:** (b). It is the parity option — it makes the codex arm behave as codex's own client behaves, so the
requirement stops being a runtime-specific null. (a) leaves the divergence open and only keeps it honest; (c) would create a
*new* divergence in the other direction, since neither Pi nor claude-runtime has a machine-wide model-restriction channel to
match and codex's own source refuses that strength.

**Evidence:** `packages/shared/src/agent/codex-config-requirements.ts:381` (`models: 'client'`, the single non-`codex`,
non-`inapplicable` entry; neighbours at `:378-384` — `enforceResidency`, `network`, `autoReview`, `sqliteHome`, `logDir`,
`modelCatalogJson` — are all `'codex'`), posture quoted at `:299-318`, value surfaced at `:629`/`:654`;
`packages/shared/src/agent/base-agent.ts:1140`; codex source at `rust-v0.148.0` as cited above (**strong** — source, not page).
`featureRequirements` is resolved per key by `CODEX_HOST_FACING_FEATURE_KEYS`, where two keys now read `'nessy'`
(`in_app_updates`, `in_app_browser`, since P2.463) — so `models` is the **last** unhonoured requirement, not one of four.
Prior rows read: P6.6 (plan line 3564, ✅ `0d6923116`), P3.239 (line 3405, ✅ `ae98536a0`), P2.517 (line 3158, ✅),
P2.508 (line 3149, ✅ `b6bd28848`), O7 + O18 (`docs/superpowers/specs/2026-08-28-out-of-scope-register.md`; O7 promoted as P2.420).

**Not part of this question** — the second B5-codex residue is a BUILDABLE S and has its own tracker row in `rows-B.md`: three
`#[experimental]` wire fields (`allowedApprovalsReviewers`, `hooks`, `network`) exist in the shipped binary and are dropped by
ts-rs, so our generated bindings see 22 of 25 (`codex-config-requirements.ts:320-330`). It needs no owner input — we already send
`experimentalApi: true`.

---

### [codex] Same reopening, codex arm: inject reasoning as a typed item, or keep the exclusion?

*(ledger group D — D. Switching correctly)*

> **Stitch note — this question is half of a pair.** Its twin is the Claude section's
> reasoning-carry question. Both cells say the two must be answered TOGETHER: answering one
> alone inverts the parity the reopening exists to buy. The regrouping split them by runtime,
> so where the text below says *above* or *below* it means the Claude section.

**Closes ledger cell:** D3/Codex (`absent ᵗ`). Answer with the claude arm above.

**Why it is being asked again.** Two rulings cover it: the same G4 of 2026-08-20 (not scoped to Claude;
restated as a payload exclusion at `:730-733`) and a code-level exclusion carrying its own reason at
`packages/shared/src/agent/codex-handoff-items.ts:51-54` — "***Reasoning items are deliberately not
carried*** — *documented, not implemented*: the app-server accepts them and writes `encrypted_content:
null`". **That reason turns out to be about the wrong field.** Read from the schema rather than the note:
`packages/codex-protocol/schema/ClientRequest.json`'s `ReasoningResponseItem` is `"required": ["summary",
"type"]` with `"encrypted_content": {"type": ["string","null"]}` — the attestation is the OPTIONAL field
and the reasoning TEXT is required plaintext (`generated/ReasoningItemContent.ts:5`,
`ReasoningItemReasoningSummary` = `{ "type": "summary_text", text }`). So the STRUCTURAL premise is
refuted: codex's own `thread/inject_items` at `rust-v0.148.0` would take it, with nothing to enable.

- **(a) Keep the exclusion; say at the switch that reasoning does not cross** — buys: no new request class
  on the BYO Responses leg, and none at all on the gateway leg, which drops it anyway (`to-chat.ts:292-293`,
  "reasoning items and other input types are not replayed to the chat API"); one honest line — costs: codex
  loses the chain even on the leg where its own schema would accept it.
- **(b) Inject `{type:'reasoning', summary:[…], encrypted_content:null}` on the Responses leg only, and say
  the gateway leg drops it** — buys: reasoning crosses where the runtime's own schema accepts it, and the
  divergence is named rather than silent — costs: two legs of one connection now behave differently, so the
  switch line must become per-model rather than per-runtime — the same shape P3.280 already had to adopt for
  images.

**Recommendation:** (a) unless the claude arm is reopened to (b); carrying reasoning on codex while claude
still drops it would invert the parity the reopening exists to buy.

**DECIDED 2026-09-05 (owner, by recommendation):** (b), because the condition fired — the claude arm IS reopened to (b), so reasoning is injected on the Responses leg only and the gateway leg's drop is stated, per-model.

**Parity direction:** (b) closes the codex difference on the Responses leg and makes the gateway leg's
residue explicit; (a) closes none of it and buys one honest sentence.

---

### [codex] Declare the bundled `reviewer` role on codex, or keep denying it?

*(ledger group H1 — H. Subagents, workflows, review (H1-H5))*

Closes ledger cell **H1 [codex]** (`partial ᵗ`, size M).

Codex cannot express the bundled `reviewer`'s read-only tool list, so today the role is not declared on
codex at all and `/code-review` delegates to an unnamed generic agent that inherits the parent's full
tools — `spawn_agent`'s own tool text in the bundled binary: "The spawned agent will have the same tools
as you" (`shell` and `apply_patch` included). Declare the role anyway with the restriction carried as
prose, or keep denying it?

- **(a) Keep denying — status quo** — buys: the writer's stated posture holds, never ship a half-honoured
  restriction; no new mechanism and no new surface to maintain. — costs: the reviewer the skill is written
  around does not exist on codex; the model spawns a full-tools agent regardless, so the restriction is
  lost either way while the named agent is lost too.
- **(b) Declare `reviewer` on codex with the read-only obligation in `developer_instructions`** — buys: one
  agent name on all three runtimes; the rubric and the read-only obligation reach the spawned agent through
  codex's own documented role field (`AgentRoleToml.description` plus the role file's
  `developer_instructions`, both already written at `config-writer.ts:3013-3016`). Strictly better than
  (a), which already loses the restriction. — costs: read-only becomes prose rather than policy; it needs a
  narrow exception to the tools-deny rule at `config-writer.ts:1674` and an operator notice saying the tool
  grant was not honoured — otherwise it is a silent divergence, the class this fork is trying to shrink.
- **(c) Give the role its own `config_file` layer carrying a `[permissions.<role>]` profile** — buys: a
  reviewer that genuinely cannot WRITE. The mechanism is real, not invented, and partly built:
  `permissions` is a top-level codex config key with a `PermissionProfileToml` definition,
  `AgentRoleToml.config_file` is documented in the same schema as "Path to a role-specific config layer",
  the writer already emits `config_file` (`config-writer.ts:3016`) and already emits `[permissions.*]`
  profiles (`config-writer-permissions.ts`, P3.273). — costs: it does NOT deliver a tool allowlist —
  measured, `PermissionProfileToml` is `additionalProperties: false` over `description`, `extends`,
  `filesystem`, `network`, `workspace_roots` with no tool field anywhere, so `shell` stays in the role's
  hands and only writes and egress are constrained. Multi-lane: our session write policy lives in a named
  `[permissions.nessy_runtime]` profile whose `extends` parent is derived from the session sandbox mode, so
  a role that only lowers `sandbox_mode` stays workspace-write (`config-writer.ts:1606-1614`).

Recommendation: **(b)** now, **(c)** only if a later row proves a non-writing codex reviewer is
load-bearing. (a) is the option that preserves a restriction nobody is currently enforcing.

**DECIDED 2026-09-05 (owner, by recommendation):** (b) — `reviewer` is declared on codex with the read-only obligation in `developer_instructions`, plus the operator notice that the tool grant was not honoured.

Parity direction: **(b)** closes the NAMING difference — one `reviewer` on all three runtimes, with the
obligation delivered as prose. **(c)** additionally closes the WRITE difference as far as codex's format
allows. No option closes the tool-allowlist difference: `AgentRoleToml` is three fields
(`description`, `config_file`, `nickname_candidates`, `additionalProperties: false`) and no `Tool*`
definition exists in the `*PermissionToml` family, so that residue is STRUCTURAL and belongs on the honest
surface whichever option is picked.

### [codex] Align the unset-case subagent ceilings, or leave codex's own?

*(ledger group H1 — H. Subagents, workflows, review (H1-H5))*

Closes ledger cell **H4 [codex]** (`partial ʰ`).

Codex now receives both subagent ceilings, but only when the operator set them explicitly. Unconfigured, a
codex session nests ONE level (`DEFAULT_AGENT_MAX_DEPTH = 1`) where an unconfigured Pi or claude session
nests three, and runs 6 threads against their 20. Align the unset defaults, or leave codex's own?

- **(a) Leave codex's defaults — status quo** — buys: native-first in its purest form; an operator who set
  nothing gets the runtime's own behaviour, and no host number is written for a user who asked for nothing.
  — costs: a subagent-nesting workflow that works on Pi and claude fails on codex after a switch, with
  nothing saying why; the cell stays `partial`.
- **(b) Always emit both host defaults for codex (depth 3, concurrency 20 / RAM-narrowed)** — buys: one
  unset-case behaviour across all three runtimes. — costs: writes our numbers for every user who asked for
  nothing — the posture the writer's own docblock declines — and the RAM narrowing prices a Pi SUBPROCESS,
  which a codex thread is not (`subagent-limits.ts:25-32`, the same measurement that settles H4/claude).
- **(c) Emit `max_depth = 3` always, leave `max_concurrent_threads_per_session` to codex** — buys: closes
  the difference that actually breaks work — 1 vs 3 nesting levels — with one line, while leaving the
  concurrency number, where codex's 6 threads is a plausible resource choice and the host's 20 is not a cost
  codex pays. — costs: an asymmetric rule needing its reason written at the site; still writes a host number
  for an unconfigured user.

Recommendation: **(c)**. Nesting depth is the arm with a user-visible failure; thread count is not.

**DECIDED 2026-09-05 (owner, by recommendation):** (c) — `max_depth = 3` is emitted always and `max_concurrent_threads_per_session` is left to codex.

Parity direction: **(b)** closes both arms of the difference, **(c)** closes the nesting arm only, **(a)**
closes neither. Under every option the H4 host row in `rows-H1.md` is still owed — the difference must be
named on the switch-cost dialog and in `runtime-capability-gaps.md`, since today the only place it is
stated is a `this.debug` line a packaged build never writes (`codex-agent.ts:2527-2532`).

Evidence (strong tier, source not page): `config-writer.ts:3000-3010` emits `[agents]` only when at least
one ceiling is set; `codex-agent.ts:2509-2535` forwards only an explicit env value and its docblock at
:2498-2507 defers the choice in its own words — aligning defaults "would mean writing our numbers for every
user who asked for nothing, which is a product posture rather than a knob repair; it is stated here and left
to the owner"; codex's defaults (`DEFAULT_AGENT_MAX_THREADS = Some(6)`, `DEFAULT_AGENT_MAX_DEPTH = 1`, V1 in
force) are recorded at `config-writer.ts:261-266` against `rust-v0.148.0`. P3.347 (`d93109114`) closed the
knob-repair half. Distinct from H4/claude, where the page publishes the answer and the cell is BUILDABLE.

### [codex] Codex ships a USD readback of its own: wire it, or hold the ruled explicit null?

*(ledger group H2 — H. Subagents, workflows, review (H6-H9))*

Closes ledger cell **H6/codex** — `absent ᵗ`.

The 2026-08-24 budgets ruling already accepts `unavailable` on codex and forbids manufacturing a gateway
price, and the honesty notice it demands fires at HEAD (`base-agent.ts:1037` → :1065 `chat.budget.notMetered`,
yielded at :5104-5105). What the ruling did not know: codex ships a cost READBACK, `account/usage/read` →
`ThreadUsage.estimatedUsageUsdMicros`, present in the shipped binary with zero callers here. Does
requirement 2 (*"the logic exists and is exercised on every runtime"*) oblige wiring it now?

- **A — hold `absent` as the ruled explicit null; probe first, build only on a non-null** — buys: costs nothing today and keeps requirement 4 intact; the probe is one RPC against a live gateway session, and a `null` records the measurement and closes the question permanently, replacing today's inference with a fact — costs: H6 stays `absent` on codex and the `maxBudgetUsd` cap stays inert there, so a user who sets a ceiling on a codex session is told it is unenforceable rather than having it enforced.
- **B — wire the readback now, on the delta, and delete `reportsCostUsd`'s override as its docblock instructs** — buys: re-arms the host cap and the `child-session-max-budget-usd-exhausted` spawn refusal on codex, closing H6 by inheritance from H6/claude's shared gate — costs: if the figure is non-null it is an OpenAI-side estimate for tokens Nestor billed, a number requirement 4's spirit forbids, shown to the user as their spend; it needs delta accounting against a cumulative source (`base-agent.ts:825-826`: *"`usage.costUsd` IS AN INCREMENT, NOT A RUNNING TOTAL"*) or the cap fires early every turn; and if it is null the whole build is inert with the `notMetered` notice now firing beside live plumbing.

Recommendation: **A**. Run the probe against a `nessy_gateway` codex session and read
`threadUsage.estimatedUsageUsdMicros`. On `null` — which is what the generated type predicts, since it is
documented as *"Estimated usage when a thread was requested and its billing route is available"* and every
codex session here runs on loopback (`config-writer.ts:2675`, :2898-2901) — record the measurement and leave
the cell `absent` under the existing ruling, no lane. On a non-null, come back: showing an OpenAI estimate for
Nestor-billed traffic is a fresh posture question the 2026-08-24 ruling did not answer.

**DECIDED 2026-09-05 (owner, by recommendation):** A — the probe runs first; the ruled explicit null stands unless it returns a non-null, which returns the posture question to the owner.

Parity direction: **B** is the option that closes the difference with claude, where the cap and the spawn
refusal are live (H6/claude). **A** leaves the difference open and HONEST, which is what the existing ruling
chose; codex has no USD ceiling of its own to enable — `config-schema.json`'s 152 top-level defs carry no
`usd`/`cost`/`spend` key and every budget knob is token-denominated.

### [codex] Codex's native goal engine keeps running beside the host goal — leave it, or switch it off?

*(ledger group H2 — H. Subagents, workflows, review (H6-H9))*

Closes the unruled half of ledger cell **H9/codex** — `partial ʰ`.

P2.2 ruled the goal HOST-SIDE on every runtime and plan :1836 records *"Codex-native `thread/goal/*` is NOT
called (deviation Dev-9)"*. Defensible — but the binary's engine is not disabled and `[features] goals` is
never written either way, so a thread can carry a host goal and a codex goal at once with nothing
reconciling or reporting them. Probed on the shipped binary: `thread/goal/set` 1, `thread/goal/get` 1,
`thread/goal/clear` 4, `thread/goal/updated` 3, `max_goal_token_budget` 13, nonsense control 0; all three
RPCs declared at `packages/codex-protocol/generated/ClientRequest.ts:100`; we know only the two notification
names (`codex-notification-families.ts:231-232`) and write no `goals` key (`config-writer.ts:2742` writes
only `[features] multi_agent = true`).

- **A — leave it, today's behaviour** — buys: no config change, and no risk of switching off something the binary uses internally — costs: the hazard the switch cell names stands, and it is unmeasured: nobody has checked whether `features.goals` defaults on, or whether the model can reach `thread/goal/set` on our sessions.
- **B — write `[features] goals = false` and keep the host goal as the single source** — buys: one goal per thread by construction, consistent with P2.2's ruling and with the `[features] multi_agent` precedent already in the same writer — costs: a codex feature is switched off on the user's behalf, and if the binary uses goals internally that loss is ours.

Recommendation: **B, but only after the probe** — run `experimentalFeature/list` (declared in
`ClientRequest.ts:100`, scores 1 on the binary; the same instrument P3.116 used for `view_image`), read
`goals`' `defaultEnabled`/`enabled`, then write the key. If the probe shows goals off by default, record the
null and change nothing.

**DECIDED 2026-09-05 (owner, by recommendation):** B, but only after the probe — `experimentalFeature/list` is read first, and `[features] goals = false` is written only if goals are on by default.

Parity direction: **B** closes the difference — Pi and claude have exactly one goal engine per session, and B
makes codex match by construction. A keeps codex the only runtime where two engines can hold a goal for one
thread, and today that difference is neither reported nor measured.

### [codex] Deferred MCP tool loading on codex, when the only live route is a hand-authored catalogue

*(ledger group J1 — J. Tools, MCP, browser (J1, J2, J4, J5, J6))*

**Closes ledger cell:** J2/Codex (`absent ᵗ`). Adjacent, not the same: sitting §1.3 (which decides
scheduling of target-conditioning, and states the same measurement — "On codex, tool search is **dead**,
not unset").

Both config keys are dead: `tool_search` and `tool_search_always_defer_mcp_tools` are `Stage::Removed` at
`rust-v0.148.0` with zero readers, skipped by `apply_map` (P2.456, pinned by
`codex-responses-adapter/src/__tests__/config-writer-tool-search.test.ts:16-101`). The real gate is
`model_info.supports_search_tool && provider.capabilities().namespace_tools`. The out-of-scope register
hands this to the owner in as many words — `2026-08-28-out-of-scope-register.md:54` (O20): "it is the same
posture question — `supports_search_tool: true` defers every MCP tool — so it needs an owner call, not a
lane's." O20's own header records the refutation that kills the cheap route: codex never fetches `/models`
under `env_key` (P3.201 `63d9c32e6` measured `should_refresh_models = uses_codex_backend() || has_command_auth()`
and the mutual exclusion of `env_key` and `[model_providers.<key>.auth]`).

**Question.** Should a codex session get deferred MCP tool loading, given that the only reachable route is
`model_catalog_json` — a hand-authored, process-wide catalogue replacement?

- **Decline, and record the null** — buys: no hand-authored catalogue, no risk of a parse error killing every codex session, codex keeps its own 20,751-char prompt, and the divergence stays a stated one. — costs: a codex session loads every MCP tool upfront forever; on a large source set that is context an operator cannot reclaim on this runtime.
- **Write `model_catalog_json` with `supports_search_tool: true`** — buys: deferral on codex, and the same file could carry the context window llm-proxy publishes. — costs: replaces codex's whole catalogue process-wide; 14 `ModelInfo` fields have no default; a parse error is fatal; an entry without `instructions` is rejected silently to stderr, and with them it overwrites codex's system prompt (measured in P3.201).
- **Swap `env_key` for the `[model_providers.<key>.auth]` table and serve `/models` from the host catalogue** — buys: one seam answers this row, P3.115's modality question and the catalogue gap at once, passing through only what llm-proxy publishes. — costs: changes the credential shape for every codex session (the two forms are mutually exclusive), so the whole gateway auth path is re-risked to enable one context optimisation.

Recommendation: **decline and record the null.** The measured cost of both enabling routes exceeds the
context saved; O20 already frames it as an owner call; and the owner's own 2026-09-01 pass chose "removal
or refusal over selective enablement every time" on three of four rows (plan `:44`), which is this shape
exactly.

**DECIDED 2026-09-05 (owner, by recommendation):** Decline and record the null — neither `model_catalog_json` nor the `env_key` swap is taken.

*Parity direction:* only option 2 or 3 closes the difference (Pi and claude both have a deferral
mechanism; codex would gain one). Option 1 leaves it permanently open but HONEST — and the honesty surface
it needs is already a row in `rows-J1.md` (the tool-search disposition report currently runs on the claude
path only).

### [codex] May a codex turn drive the built-in browser, and who pays for the gate

*(ledger group J1 — J. Tools, MCP, browser (J1, J2, J4, J5, J6))*

**Closes ledger cell:** J6/Codex (`absent ʰ`). Not on the sitting page (`browser` occurs in none of its 17
sections). The host half is already honest and is a promotion, not a question: J6/host is
CLOSED_AT_HEAD — the `appActions` switch-cost row names the browser-pane loss to the user
(`runtime-switch-costs.ts:583-588`, `en.json:421`, `ru.json:431`).

`browser_tool` is excluded by TWO independent rules — `executionMode: 'backend'`
(`session-tools-core/src/tool-defs.ts:1222`) and membership in `SESSION_TOOLS_REQUIRING_HOST_CALLBACK`
(`:1455`) — and `SESSION_BACKEND_TOOLS_BRIDGED_BY_HOST_CALLBACK` (`:1595`) holds `advisor_consult` alone,
so a lone entry would switch the browser on and off with the advisor setting (P6.27 `0e328a029`). The live
blocker is recorded at `server-core/src/sessions/SessionManager.ts:18352-18375` (P3.236 `07e047eaa`),
verbatim: "**Wiring the codex bridge without a gate first would ship arbitrary in-pane JavaScript
(`evaluate`) with no mode check and no prompt.**" and "`BrowserPaneFns` is 31 separate closures with no
dispatch function, so a chokepoint means wrapping the assembled object — which makes new permission
prompts appear on a live feature for ALL THREE runtimes. **That is a product posture** … Owner/controller
decision". Native-first was asked: codex's own `in_app_browser` flag is read by nobody
(`codex-rs/features/src/lib.rs:1207-1218`, P2.373) and `ApprovalKind` in
`codex-agent-server/src/approval-bridge.ts` carries no MCP member.

**Question.** May a codex turn drive the shared built-in browser, and if so, may the chokepoint that makes
it safe add permission prompts to Pi and claude — where the browser works today with no such prompt?

- **No — codex stays without the browser (the standing state)** — buys: nothing changes for Pi and claude users; no arbitrary in-pane `evaluate` from a runtime with no PreToolUse path; the loss is already named to the user by the `appActions` switch-cost row. — costs: a capability difference at the switch that never closes; a codex session cannot do browser work at all, and the administrator gate P2.399/P2.463 built stays the only browser story codex has.
- **Yes, behind a host chokepoint that gates all three runtimes uniformly** — buys: one decision site every path lands on, in the shape `SessionManager.authorizeMonitor` already proved; codex gets the browser under the same mode check and prompt Pi and claude get. — costs: ≈120-180 lines for the bridge plus wrapping 31 `BrowserPaneFns` closures that have no dispatch function; new permission prompts appear on a live feature for Pi and claude users who have never seen one — a user-visible regression paid by two runtimes to unblock a third.
- **Yes, gated for codex only — the chokepoint applies to bridged codex calls and Pi/claude keep today's path** — buys: codex gets the browser; no new prompts for existing users; the smallest honest thing, and it becomes strictly cheaper if the J1/Codex hook measurement shows codex's own `preToolUse` can `stop` an MCP-shaped call, since the gate would then be codex's own mechanism rather than a second host one. — costs: as things stand today, two decision sites for one capability — a permission posture that differs by runtime for the same tool, which is the silent-divergence shape this fork's rules exist to prevent, and a second site to keep in sync forever.

Recommendation: **option 2 if the browser on codex is wanted at all.** Option 3 is the exact defect class
the native-first rule names — *unless* the J1/Codex measurement lands positive, which would convert it
from a second host site into codex's own gate; **measure before pricing it** (that measurement is already
a row in `rows-J1.md`, and `ConfiguredHookMatcherGroup.matcher` plus `HookOutputEntryKind` `"stop"` are
what make it plausible). If new prompts on Pi/claude are unacceptable, option 1 is the honest answer and
should be recorded as a decision rather than left as a gap.

**DECIDED 2026-09-05 (owner, by recommendation):** Option 2 if the browser on codex is wanted at all — so nothing is built now, and only a uniform host chokepoint is admissible if it ever is.

*Parity direction:* options 2 and 3 close the difference; option 3 closes it for the model while opening a
new one in the permission posture. Option 1 leaves the capability gap permanently open, already REPORTED.

### [codex] Shell network egress on codex — deny legibly, open with the isolation switch, or allowlist domains?

*(ledger group J2 — J. Tools, MCP, browser (J7-J11))*

Closes: **J11/codex**. Sitting overlap: **→ sitting §3.1** decides the SANDBOX-MODE half only
(`danger-full-access` resolving to workspace-write because our credential floor supersedes it); the
NETWORK half asked here is plan **OQ-11** (heading line 2303, still OPEN) and appears nowhere on the
sitting page. Already ruled, partly: OQ-11's option 3 — *"a denied network call should look denied …
independent of 1 and 2"* — already carries the controller recommendation *"option 2 plus option 3"*
(plan ~line 2337).

Should a codex session's shell reach the network — and if so, everywhere or only to a declared domain
allowlist — now that `[permissions.nessy_runtime.network]` is a live, in-shipped-binary mechanism our
config writer has never written?

- **A. Keep egress denied and make the denial LEGIBLE in the shipped default — this IS OQ-11's option 3, already recommended by the controller, not a new option** — buys: no posture change and no new egress; closes the half OQ-11 calls non-optional whichever of its 1 or 2 is chosen, since a model that believes a host does not exist will not retry, ask or report; small work, because the diagnostic exists and is simply dead in this state (the J11/host row) — costs: `npm install`, `git fetch` and every package manager stay unreachable on codex while they work on Pi and claude, so the switch keeps costing a real capability — now stated instead of silent.
- **B. Write `[permissions.nessy_runtime.network] enabled = true` for the sandbox-OFF state only** — buys: makes the isolation switch mean something on codex for the first time and restores parity with Pi and claude for an operator who deliberately turned isolation off; uses codex's own mechanism at native-first step 1, in the config layer measured to WIN (P3.315), and the identical table is already driven in production by our Windows arm — costs: widens a session that today is contained, through a table nobody has driven on DARWIN (the Windows precedent proves the spelling, not the seatbelt enforcement); the switch copy P2.331 already found false on codex must move with it; and it collides with sitting §3.1 — under §3.1's recommended (A) the sandbox-off state is not really off, so "sandbox-off only" names a state the product no longer has.
- **C. Write the table with `mode = "limited"` plus a `domains` allowlist, in every configuration** — buys: package managers and git work while arbitrary egress does not — the narrowest answer that unblocks the real complaint, and the only one that survives the sandbox being ON — costs: a new product surface, because someone must own the allowlist and a registry the user needs but we did not list fails in a new way; unmeasured on darwin seatbelt, and codex ties domain filtering to the managed proxy, which P2.384 measured as gated on network already being enabled.

Recommendation: **A now** — and note it is already the controller's standing recommendation in OQ-11, separable from §3.1, so it can be taken whichever way §3.1 goes. B only if §3.1 resolves to (B); under §3.1's recommended (A) its own trigger condition barely exists. C is the answer people will ask for and must not be taken on the schema alone: drive one `curl` under `enabled = true` on the shipped darwin binary first, because its enforcement path is exactly the managed proxy P2.384 measured as not running in this state.

**DECIDED 2026-09-05 (owner, by recommendation):** A now — egress stays denied and the denial is made LEGIBLE; B stays conditional on sitting §3.1, and C is not taken on the schema alone.

Parity direction: **B closes the Pi/claude↔codex difference for the sandbox-off state** (conditional on the `measure:` row confirming Pi and claude are in fact open there — if they are not, there is no difference to close). **C closes it partially in every configuration.** A keeps the difference and makes it HONEST, which is the host's job under native-first. Mechanism, re-derived from the generated schema: `config-schema.json`'s `PermissionProfileToml` properties are exactly `['description','extends','filesystem','network','workspace_roots']` and `NetworkToml` carries thirteen keys (`enabled`, `mode`, `domains`, `proxy_url`, `allow_upstream_proxy`, `mitm`, `enable_socks5`, …), live in the shipped binary (`allow_upstream_proxy` 10, `dangerously_allow_all_unix_sockets` 10; controls `workspace_roots` 23 / `zzz_not_a_real_key` 0); we emit `[permissions.nessy_runtime.filesystem]` and never the `network` sibling (`grep 'network' config-writer-permissions.ts` = 0), while `pi-harness/isolation/windows.ts:130-131` already writes `[permissions.nessy-supervised-process.network] enabled = <bool>` in production against codex's own Windows binaries. This is NOT the legacy `sandbox_workspace_write.network_access` and NOT `[features] network_proxy`, which P2.384 measured as inert here. Egress denial is driven, not inferred: `docs/superpowers/specs/2026-08-28-codex-sandbox-enforcement.md:86-88` (`185172b05`) — in the SHIPPED DEFAULT column loopback HTTP and `https://1.1.1.1/` both `refused (curl: (7))` and `dscacheutil -q host` exits 0 empty, against a control column returning 200/301/resolves; it holds at HEAD because `config-writer-permissions.ts:711` ships a `:workspace`-extending profile for every real session and the credential floor is unconditional (P3.327). P3.45's contrary reading is superseded by the Profiles-over-Legacy precedence measured in P3.315 with two controls.

### [codex] Codex accepts OTLP auth headers only as literals on disk — write it, or keep refusing?

*(ledger group M — M. Observability and diagnostics)*

Closes ledger cell **M1 [codex]**.

An operator whose OTLP collector authenticates by header gets a full event stream from Pi and claude and **nothing** from codex: `OtlpHttp.headers` is a literal map in codex's `config/src/types.rs` (source tier, `rust-v0.148.0`, resting on P2.450 — no `openai/codex` checkout in this tree), and `buildCodexOtelToml` (`packages/codex-responses-adapter/src/config-writer.ts:2590`) refuses to write a credential to disk, stating the residue at `:2555-2563`. The writer's standing invariant is that `config.toml` holds env-var NAMES only (`env_key`, `bearer_token_env_var`).

- **Keep refusing (status quo)** — buys: no credential ever reaches disk; the names-not-values invariant holds. — costs: header-authenticated collectors, the common enterprise shape, get zero codex audit events, and the refusal reaches only a debug channel a packaged build does not write, so the operator reads the silence as "nothing happened".
- **Write it as a literal into the process-owned `mkdtemp` `CODEX_HOME`, 0600, deleted on teardown** — buys: codex reaches parity with Pi and claude on every collector shape; no new user-visible switch. — costs: breaks the names-not-values invariant and puts a collector credential in a temp file for the session's lifetime, readable by anything running as the user, including tools the model launches.
- **Write it only behind a named opt-in (e.g. `NESSY_CODEX_OTLP_HEADERS_ON_DISK=1`)** — buys: the operator who needs it chooses the trade explicitly, the default stays safe, and the invariant is broken only where someone asked. — costs: a knob that exists on one runtime — the shape of silent divergence native-first exists to prevent — plus a name to document and keep.

Recommendation: **option 3.** Parity direction: options 2 and 3 close the difference (3 on request). Note: the honesty fix — promoting the two refusal notices off `this.debug` onto the durable operator channel — is **M1 [host]**, one call site, needed under every option including option 1; do not price it into this answer twice. One correction is owed to the notice text either way: its "Pi and claude are unaffected" holds for claude only if the operator used the Claude spelling — see M1 [claude].

**DECIDED 2026-09-05 (owner, by recommendation):** Option 3 — the headers are written only behind a named opt-in, with the default still refusing.

### Already on the sitting page — pointers, not re-asks

**[codex] Native skill roots for codex (`skills/extraRoots/set`)**

*(ledger group L1 — L. Instructions, memory, skills, plugins (L1-L4))*

→ sitting §1.4 + §2.3

## Pi

### [pi] Standing `Compact Instructions` are skipped on the auto-compaction turns where our summary replacement is off

*(ledger group E — E. The context window)*

Closes: **ledger E3:pi** (ledger `partial ʰ`).

On a Pi auto-compaction turn where no per-turn compaction instructions were queued, should a project's
standing `## Compact Instructions` section still steer the summary? It can only do so by switching the
host's summary REPLACEMENT on for a turn where the absence of instructions is precisely the signal that
the replacement is off (`pi-agent-server/src/index.ts:1755` — `if (event.reason === 'manual' || !instructions) return;`).
Pi has no native lever here: the installed `@earendil-works/pi-coding-agent@0.84.2` declares
`CompactionSettings { enabled; reserveTokens; keepRecentTokens }` (`dist/core/compaction/compaction.d.ts:28-32`)
and its auto path emits `customInstructions: undefined`, so the host's `session_before_compact` replacement
is the only seam — and the replacement is what the question is about.

Reachability, measured so the frequency is on the record: the state is rare, not routine. The ONLY sender of
the subprocess `prompt` message is `pi-agent.ts:9386-9393`, and it always sets
`autoCompactionInstructions: composePiCompactionInstructions(...)`, which returns at minimum
`COMPACTION_HANDOFF_INSTRUCTIONS` (`pi-harness/prompt-composer.ts:153-160`); the queue drains only on a
user-role `message_start` (`index.ts:1734-1740`) and tool results carry `role: "toolResult"`, so a tool loop
does not drain it.

- **Keep the guard as landed; make the skip visible** — buys: no behaviour change, so sessions whose
  replacement is off keep Pi's own summarizer and never meet the host summarizer's `{ cancel: true }` auth
  arm, which today aborts a compaction outright when the model's API key cannot be resolved
  (`pi-agent-server/src/index.ts:1761-1765`); adds a diagnostic naming that the standing section was not
  applied this turn, which is HONEST rather than uniform — the standing host rule — costs: a project that
  authored a `Compact Instructions` section gets no steering on those turns, and E3's Pi cell stays `partial`.
- **Activate the replacement whenever a standing section exists — pass the steering alone as `instructions`**
  — buys: the section is honoured on every auto-compaction, closing E3's Pi cell to `covered` and making Pi
  match codex, where `compact_prompt` is written unconditionally — costs: newly activates the host's
  summarizer for sessions that had it disabled, a different summary path whose auth arm can cancel a
  compaction Pi would otherwise have run natively; this is the exact change `withProjectCompactSteering`'s
  docblock (`packages/shared/src/prompts/compaction.ts:211-218`) and P6.54's closing note (✅ `413354e4b`)
  were written to refuse by name.

Recommendation: **option 1.** The guard is a deliberate, documented decision; the residue is narrow (the sole
subprocess `prompt` sender always supplies non-empty instructions), and the missing half is the SURFACE, not
the steering — `honest_surface` is `missing` today, which is the only part a lane should close without a ruling.

**DECIDED 2026-09-05 (owner, by recommendation):** Option 1 — the guard stays as landed and the skip is made visible.

Parity direction: **option 2** is the one that closes the difference (Pi steers on every compaction, like
codex); option 1 keeps the divergence and makes it honest, which is the native-first/host-is-the-seam posture.

### [pi] Do the 32 Claude policy/security switches owe Pi a knob, or only a behaviour?

*(ledger group L1 — L. Instructions, memory, skills, plugins (L1-L4))*

Closes ledger cell **L1-pi** (`partial ʰ`, size L).

The vendored 2.1.233 binary honours a documented tier of policy/security keys that Pi ignores. The tiered table is `docs/superpowers/specs/2026-08-28-runtime-capability-gaps.md:381-382`: tier 1 is "Ceilings, timeouts and budgets … | 29 | Close by consequence, Bash pair first. **ONE of the 29 is NOT a gap**"; tier 2 is "Policy and security switches … | 32 | … Decide per key whether we owe the *knob* or only the *behaviour* — and per behaviour, not per key." Pi is our own harness, so there is no vendor mechanism to enable; `buildPiSubprocessEnv` already spreads `process.env` (P2.313 measured Pi 69 / claude 70 / host 67 keys carrying `BASH_MAX_TIMEOUT_MS` and an invented control identically), so a one-line env fix is a no-op and each key needs its own reader. The tier-1 pattern is already proven: `pi-harness/process-supervisor-port.ts:202/:214/:270/:283` with the production clamp at `pi-agent.ts:7248` (`3e66f5fbb`, `bab575dd2`).

**Options.**

- **A. Knob parity for the tier-2 list, key by key** — buys: one settings model across the runtime cards, so a documented key an operator sets works everywhere — costs: ~32 readers to write and keep true, and several would LOOSEN Pi: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` has five behaviours and "we are already stricter" holds for exactly one (P3.310, quoted at gaps:382), so honouring the knob can weaken `RESTRICTED_HOST_ENVIRONMENT`.
- **B. Behaviour-only: close tier 1 as lanes, declare tier 2 a counted divergence with one honest surface** — buys: the ceilings an administrator actually sets bind on both runtimes, and no key silently loosens Pi — costs: a documented key an operator writes still does nothing on Pi (honest, not parity), and the honest surface is its own M-sized row (ledger L1-host).
- **C. Per-key triage decided once, from the tier-2 list** — buys: each of the 32 gets a recorded ruling rather than a class ruling, and the several we satisfy more strictly close as "behaviour owed, knob not" — costs: 32 owner decisions in one sitting.

**Recommendation:** B, plus C for the handful an operator plausibly sets (`CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `CLAUDE_CODE_SHELL` / `_SHELL_PREFIX`, `DISABLE_TELEMETRY` / `DO_NOT_TRACK`). A is the only option that can silently loosen Pi. B is consistent with the controller's recommendation at sitting §1.2 (refuse-and-disclose for user-scope `env`) — note that §1.2 is OPEN, not ruled.

**DECIDED 2026-09-05 (owner, by recommendation):** B plus C for the named handful — tier 1 closes as lanes, tier 2 becomes a counted divergence with one honest surface, and `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `CLAUDE_CODE_SHELL` / `_SHELL_PREFIX` and `DISABLE_TELEMETRY` / `DO_NOT_TRACK` get per-key rulings.

**Closes the difference:** A closes it as parity (and pays with a possible loosening); B and C close it as an HONEST, counted divergence — the difference stops being silent, which is what the ledger's `SILENT` verdict is scoring.

### Already on the sitting page — pointers, not re-asks

**[pi] The inert `additionalDirectories` Pi arm**

*(ledger group L1 — L. Instructions, memory, skills, plugins (L1-L4))*

→ sitting §1.4

## Already ruled — no question

Merged across all 21 slices. These cells carry a standing owner ruling or an out-of-scope entry, so
they are recorded rather than asked. Where a ruling settles only PART of a cell, the residue appears
as a question above and the ruling appears here — the two never restate each other.

### A1 — A. The safety floor (A1, A2, A4, A5, A7)

- **A1-claude [claude] — the auto-mode classifier stays OFF.** Ruled in **P3.139, 2026-09-01**, under the
  standing 2026-08-28 delegation: the classifier fall-through stays off, one flag away, with the numbers
  recorded (median 7.5 s, ~24.2k input tokens per hop, invisible in `modelUsage`). Claude's own
  classifier (`permissionMode: 'auto'`) is already enabled and already policy-configured (P3.94/P3.95,
  `claude-auto-mode-policy.ts:74-75` — *"In the shipped configuration the classifier is therefore
  consulted on approximately nothing."*); the only thing silencing it is our own PreToolUse `allow`. The
  receipt half is P3.142 (`dd6945dae`), written at the flag that arms it. **Revisit hook: P3.141 (⬜,
  live-owed)** — a realistic-transcript measurement is the only thing that reopens it. Do not re-ask.
- **A5-claude [claude] — the two credential paths stay outside `deniedPaths`.** Ruled in **P3.76,
  2026-08-28**, owner direction *"let's do it according to Claude's documentation"*, resolved as reading
  (ii): the documentation specifies a configurable mechanism Claude ships EMPTY (`settings-reference.md#exclude-sensitive-files`,
  *"Default: unset"*), our nineteen hardcoded entries are already stricter than the documented default,
  and *"appending five more strings is precisely what the documented mechanism says not to do"* (plan
  `:3245`). The five still-readable paths — `~/.nessy/dp_auth_creds.json` named among them — are the
  user's or an administrator's to cover through `deniedPaths`, a first-class schema key readable from
  four layers with managed scope weighted highest. The deliverable was P3.107 (*"nobody is told it
  exists"*), CLOSED `300a6e0b6`. Nothing remains buildable on this cell; what remains is the switch
  honesty, carried by the A5-host measure row (codex is stricter than the ruled posture, so the
  divergence must be disclosed, not fixed).

### A2 — A. The safety floor (A8-A12)

None. No cell in this group has an existing owner ruling in the plan's `## Owner decisions` blocks or in the
out-of-scope register. The two owner rulings that touch group A govern adjacent routes rather than the cells
themselves and are cited in place: OQ-1 and OQ-3 (2026-08-23) on the `useAutoModeDuringPlan` classifier route
(A8, and a lower-scope `false` only TIGHTENS, so neither collides), and OQ-3 again on the acknowledged-bypass
route (A9, quoted above).

### B — B. What an organisation can enforce

- **`B3-pi` [pi] — an administrator-placed `policyHelper` (a helper program that computes the managed policy at startup).**
  Ruling: **DROPPED by owner decision 2026-08-08** — R50 `managed-policy-sources`,
  `docs/superpowers/plans/2026-08-04-doc-sweep-parity-wave.md:2853`, verbatim *"Not deferred — out of scope for this product"*,
  reason *"there are no third-party administrators"*. P3.63 (plan line 3232, ✅ `e3e6c0376`) was dispatched against B3+B4 and
  **refused B3** with that citation; P3.65 (line 3234, ✅) restated the rationale: the managed policy in this product has exactly
  **one** auditable source — the gateway payload through `managed-policy-loader.ts`'s containment (root-ownership, symlink, size,
  `__proto__`) — and a locally spawned executable whose stdout becomes the whole policy would be a second, unauditable source
  bypassing every one of those checks. Scope stays `out`.
  One correction recorded by the verification pass, worth knowing before anyone reopens this: **rung 1 of native-first was never
  satisfied on Pi.** Pi's own runtime has no policy-helper hook to decline — `grep -rla policyHelper` over
  `node_modules/@earendil-works/*` returns **zero** files (positive control on the same tree: `grep -rlac settings` over
  `pi-coding-agent` is non-zero across 146 files). The 23 `policyHelpers` hits in `packages/pi-agent-server/dist/index.js` are the
  **Anthropic SDK's own zod schema text**, dragged into that untracked build artifact by `pi-agent-server/src/index.ts`'s direct
  `../../shared/src/…` imports; `packages/pi-agent-server/package.json` declares no anthropic dependency. Tracked source:
  `git grep -acn policyHelper -- packages apps` → 6 files, **every hit a comment**; `policyHelpers` → 0.
- **`B3-codex` [codex] — the same capability on codex.** Ruling: **same as `B3-pi`** — R50, 2026-08-08, reason restated by P3.65.
  Here it is additionally **absent by construction**: `grep -rlai 'policy_helper|policyHelper'` over `packages/codex-protocol/`
  → 0 files, with a positive control on the same tree (`packages/codex-protocol/generated/v2/ConfigRequirements.ts` exists and is
  read by `packages/shared/src/agent/codex-config-requirements.ts`, so the directory is greppable and populated). Codex layers
  configuration from static files (`requirements.toml` plus its config layers, at `rust-v0.148.0`); there is no helper-program
  hook to enable. Nothing to suppress, no divergence risk. Scope stays `out`.

**The residue the ruling did not consider — and it is not an owner question, it is a measurement.** R50 is a ruling about what
**we build**, not about what the **shipped SDK executes**. `policyHelper` is fully implemented in the vendored Claude Agent SDK —
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` and the darwin-arm64 native binary are the only two files in `node_modules`
matching `policyHelpers` — and we neither configure it nor suppress it, so an administrator-placed helper would be honoured on
claude-runtime and ignored on Pi and codex. That is why `B3-claude` is classified **MEASURE**, not OWNER: the question "does our
spawn suppress it?" is answerable on a rig with no owner input, and there is nothing to decide until the answer is *yes, it
fires*. The rig, its four controls and the conditional honest-surface follow-up are the `policyHelper` row in `rows-B.md`.

### C — C. What leaves the machine

- **C4/pi [pi]** — corporate-launcher seam. **DEFERRED TO LAST by owner ruling 2026-08-28**, in the owner's own words: «этого не будет, я бы не стал сейчас это делать» / «я бы сместил это аж в самую последнюю очередь». The plan defines that state at :678 — *"the owner has ruled on PRIORITY, not on the finding. The measurement stands."* Row P6.9 (`⏸`, plan :3567). Pi has no launcher counterpart, so the seam is host-owned by construction. Do not spend on it and do not close it as done.
- **C4/codex [codex]** — same capability, same 2026-08-28 ruling, same row P6.9. No native codex counterpart: no argv-prefix or launcher key in the codex config surface, and the child inherits the whole environment unfiltered (`packages/codex-agent-server/src/runtime-manager.ts:388-391`). The three unwrapped host spawn classes are shared with Pi and claude (`SessionManager.ts:24295`, `automations/hook-command.ts:806/:808/:814/:815`, `mcp/client.ts:514`).
- **C4/claude [claude]** — whether to restore the withdrawn `CLAUDE_CODE_SHELL_PREFIX` / `CLAUDE_CODE_PROCESS_WRAPPER` pass-through (`packages/shared/src/config/claude-provider-routing-env.ts:272-277`, withdrawn by P3.300 `e858e1437`). **Ruled twice, in the same direction.** (1) 2026-08-28: the corporate launcher is the capability and restoring a claude-only fragment of it is having part of what the owner parked (P6.9). (2) 2026-09-01, plan :36-50: where a capability exists on one runtime and not the others the owner chose **removal or refusal over selective enablement** three times of four — P4.7 *"It is Pi-only by construction, so building it manufactures a divergence in the wave meant to close them. An honest zero beats a Pi-only one"*; P2.381 *"Explicitly disable — Pi and claude have no such transport, so disabling makes all three identical"*; P3.242 *"Refuse, naming the override"*. P3.300 is that posture applied, landed after the ruling. Asking again would spend owner attention on a settled direction — the exact controller error the plan records at :29. The one residual cost — that the announcement of the drop reaches nobody — is **not** an owner question: it is cell C4/claude-notice and the first row in `rows-C.md`.

### D — D. Switching correctly

- **D4/Pi** — `[pi]` Owner refused BOTH alternatives (2026-08-28, P3.57, plan:3226, `09bba9c53`): no bulk
  re-attachment on the first post-switch message, and no transcript embedding of an image block. On the
  record: *«does this not affect the history? will the user see all the session's images in one new
  message?»* — "Yes to both, and I did not think it through." An image attached to message 3 of 20 would
  reappear on message 21, images pile onto one message, and the UI then renders attachments the user never
  made or renders nothing while the model sees them. The on-demand named-path pointer ships instead
  (`runtime-handoff.ts:138-142` `HANDOFF_IMAGE_NOTE`, `:203-224` `handoffAttachmentBlock`), and Pi's own
  `read` returns an image as visual content, so recovery is the runtime's mechanism. Nothing owed;
  `absent` is by decision and the degradation is HONEST.
- **D4/Claude** — `[claude]` The same P3.57 ruling, plus P2.125 (`cbf2e46ef`) pinning the refusal to
  synthesize an image block at the seam on three grounds. Claude's recovery route is the page's own
  contract (`tools-reference.md#read-tool-behavior`: "**Images**: PNG, JPG, and other image formats are
  returned as visual content that Claude can see, not as raw bytes"), quoted at `runtime-handoff.ts:100-103`.
  P3.103's per-turn image bound is withdrawn with the build it bounded. The Claude-specific reason not to
  embed a block also still holds: 0 image blocks in 217 vendor transcripts, and `verifyClaudeTranscript`
  catches only a malformed file, never an SDK-side rejection — a fabricated anchor would be a silent empty
  resume. Nothing owed.
- **D4/Codex** — `[codex]` The same P3.57 ruling, and P2.125's transcript-block alternative is additionally
  refused on codex's own ground: the default upstream answers an image content part with `400 Invalid Chat
  Message Part: Model Does Not Support Image Inputs` where a text-part array answers 200 — so on the leg
  that exists to BE the fallback, a block would fail the handoff rather than degrade it. The last named
  residue is closed (P3.280 `823bf4f6c`, conditional note at `runtime-handoff.ts:108-142`). What remains is
  a measurement, not a decision — it is a `measure:` row in `rows-D.md`.

**Note on the two re-asks above.** D3/Claude and D3/Codex also carry a standing ruling (G4), so they could
have been filed here. They are not, because the cells establish that the ruling is provisional («пока»)
and that its written premise is refuted at HEAD — which is exactly the condition under which a re-ask is
owed rather than a restatement. The corrected footing is itself a row in `rows-D.md`.

### E — E. The context window

None. No plan owner-decision entry and no out-of-scope register item (O19 `:53`, O32 `:88-101` both read)
rules on any E-group cell.

### F1 — F. Sessions, checkpoints, recovery (F1-F4)

- **F1/claude** — plan `## Owner decisions` item 3 (`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md:1097-1104`): "**Rewind — keep ours; do NOT adopt the SDK's semantics.** … Adopting it would be a **downgrade** … **What follows: gate the affordance where it cannot restore**." So `enableFileCheckpointing` + `rewindFiles` is REFUSED, and the ruled follow-through is the gate, carried by the per-anchor `hasTrackedChanges` row in `rows-F1.md` — not a host-side producer. (A host-side producer at `claude-agent.ts:5039` remains buildable in principle, but its precondition — that the `PreToolUse` matcher fires before EVERY file-mutating tool, including SDK-internal and subagent edits — is unmeasured, and a partial producer would replace an honest "not tracked" with a silently incomplete manifest.)
- **F1/codex** — the same item 3 applies by its own terms ("gate the affordance where it cannot restore" is runtime-general), and codex is the runtime whose own contract hands file revert to the client: `packages/codex-protocol/generated/v2/ThreadRollbackParams.ts`, "This only modifies the thread's history and does not revert local file changes … Clients are responsible for reverting these changes", in a file additionally headed "DEPRECATED: `thread/rollback` will be removed soon". So: declined, gated, `fileCheckpointsTracked: false` already tells the user. **Correction owed either way:** closed row `P3.59` (plan line 3228) states "a pre-execution hook — **unavailable**: codex emits four hook events and no `PreToolUse`", which `packages/codex-protocol/generated/v2/HookEventName.ts` refutes — eleven events, `preToolUse` first.
- **F4/codex** — owner, 2026-09-02, on `P2.371` (plan line 3012): the per-session `CODEX_HOME` stays per-session for isolation, and only `state/plugins` was to persist; W2-j's measurement then made even that moot (the runtime "never touched `state/`"), and `P3.296` (`f717d95d3`) seeded a host-stable `installation_id` while recording the sqlite and `skills/.system` re-extraction as declined with the cost measured. Codex's `sessions/` rollouts are ephemeral **by ruling**; the residue is the missing honest surface, which is a row in `rows-F1.md`.

### F2 — F. Sessions, checkpoints, recovery (F5-F8)

- **[pi] F6/pi — the running-work command may be built; the running-work VIEW may not.**
  Ruling: the FORM of every new surface is the owner's, taken in the playground first — Phase-4 process
  decision (owner 2026-08-23, plan line 1142): *"the four new surfaces are DRAWN IN THE PLAYGROUND LAST …
  the owner looks at it there and corrects, and only then does it move into the app"* (P4.1/P4.3/P4.10 sit ⬜
  under it) — reinforced by P4.7 (line 3550, owner 2026-09-01): *"DO NOT BUILD … a panel absent on two
  runtimes of three reads to a user as claude is worse"*, and the declined panel is the one over this same
  harness snapshot. Consequence for the row: `/tasks` and `/workflows` answer IN THE TRANSCRIPT (the P3.158
  `/help` precedent, `e527674c0`); `listPiAgentView` (`SessionManager.ts:4868`) reaches the preload
  (`apps/electron/src/preload/bootstrap.ts:215`) with zero renderer consumers and stays that way.

- **[claude] F6/claude — same ruling, same boundary.** Command and host answer are free; a panel is not
  (plan line 1142; P4.7 at line 3550). The claude-specific residue — a feed carrying task names — is the
  F8/claude row's build, not a decision.

- **[codex] F6/codex — same ruling, same boundary** (plan line 1142; P4.7 at line 3550). The codex-specific
  residue — one on-demand `thread/backgroundTerminals/list` so a between-turns answer is not one turn old —
  is a lane's, not the owner's.

- **[host] F7/host — O6 already ruled the stream-idle claude route out of scope, and the row RE-ENTERS on
  measurement rather than by re-asking.** Ruling as written, `docs/superpowers/specs/2026-08-28-out-of-scope-register.md:40`:
  *"It is safe only because the client is the Claude Agent SDK, whose own byte watchdog fires at
  `Math.max(CLAUDE_STREAM_IDLE_TIMEOUT_MS || 0, 300000)` **for a non-first-party base URL** … with the
  watchdog at its default the route behaves like the other two relays."* Neither of its two literal re-entry
  triggers has fired (`git grep -an CLAUDE_ENABLE_BYTE_WATCHDOG -- packages apps scripts docs` → two hits,
  both comments). What died is the ruling's GROUND: the bundle's predicate is the exact complement —
  `s0a(e){return e==="firstParty"&&Mf()||e==="anthropicAws"&&!process.env.ANTHROPIC_AWS_BASE_URL}`, with
  `Mf()`→`Mit()`→`Vxe(e){…["api.anthropic.com"].includes(t)}` — first-party ONLY, while our route sets
  `ANTHROPIC_BASE_URL: http://127.0.0.1:${handle.port}` (`claude-agent.ts:3791`). No new question: the
  unconditional deliverable is a record correction, and the only branch that could add code is gated on the
  F7/claude measurement, so the owner is asked nothing until a run exists to be asked about.

### G — G. Hooks and automation

- **G5 [codex] — projecting hooks into codex's own `[hooks]` table.** Ruled **P2.414, 2026-08-29, option 2:
  project ONLY hooks the host itself authored. Authorship, not trust, is the boundary; do not widen without a
  new decision.** Implemented in `8d7b4f399` (`mintHostAuthoredCodexHooks`, the only producer of the branded
  plan type; the writer refuses an unminted plan whole) with the notice half in `e2707e0c2` (P2.428). The
  ruling is empty in practice today and the source says so: `codex-agent.ts:2004-2012` — "The host writes no
  `command` hook of its own on any runtime, so there is nothing here to hand codex" — with
  `hostAuthoredHookProjection()` at `:2035-2039` recording `CODEX_HOOK_PROJECTION_NOTICE` and returning `{}`.
  The cell's stated reason (a translation table between our event names and codex's config keys) is **refuted
  at the source**: `runtime-hook-events.ts:267-315` `CODEX_NATIVE_HOOK_EVENTS` is eleven config keys
  `as const satisfies readonly AgentEvent[]` — the same strings as our event names, so there is only a
  membership test. Two costs fall due the day the host authors its first hook, both measured under P6.14
  (`cef00cd4e`) and owed with it, not now: the TOML key is `timeout`, not the wire spelling `timeoutSec`
  (which silently reverts to codex's 600 s default), and an entry stays INERT until `[hooks.state."<key>"]`
  names it with a hash codex publishes through `hooks/list` and which is not re-derivable — so trust is a
  two-pass write → boot → read → write, plus a true `CodexHostHookRevocation`. **Parity direction:** the cell
  reaches `covered` for the host-authored class on that day; it stays deliberately below Pi for user- and
  plugin-authored hooks, which is what the ruling bought.

### H1 — H. Subagents, workflows, review (H1-H5)

- **H3 [claude]** (`partial ʰ` → `CLOSED_AT_HEAD`) — plan line 13, `## Owner decisions`, verbatim:
  "Advisor: TAKE, host-side; upstream advisor is an Anthropic server-side tool + feature-flag-gated →
  unusable via our gateway. Advisor model = the user's selected model, optionally another model from the
  user's llm-proxy entitlement." Native-first re-asked and answered the same way: the SDK's own
  `advisorModel` (`sdk.d.ts:7214`) drives a server-side tool behind the `advisor-tool-2026-03-01` beta,
  unreachable through the gateway loopback — not forwarding it is correct.
- **H3 [host]** (`SILENT`, BUILDABLE M) — same ruling. The picker IS the ruled design, so the row in
  `rows-H1.md` DELIVERS plan line 13 rather than reopening it. Recorded here so a later reader does not
  re-open a settled posture as a fresh question.

### H2 — H. Subagents, workflows, review (H6-H9)

- **H6/codex** — Ruled 2026-08-24, plan :285 `## Owner ruling on budgets: show the truth, do not fake the number` — *"showing 0 (or \"unavailable\") is fine; what matters is that the logic and the code exist"*; requirement 1 *"An unavailable cost reads as unavailable … never as a satisfied budget check"*; requirement 4 *"Do NOT invent a price table for gateway models to manufacture a number."* All three are satisfied at HEAD (`codex-agent.ts:4066` `reportsCostUsd(): boolean { return false }` short-circuiting `base-agent.ts:1210`; notice at :1037→:1065), so `absent` is the ruled-correct state — an explicit null, not a gap. The question above is only whether the newly-found readback changes that.
- **H9/pi** — Two rulings. Display: plan :2017 (owner call 2026-08-22) — the target is the existing above-composer strip, a goal chip in `ActiveOptionBadges`, *"reuse, not a new panel"*; plan :2007 exempts it from the new-surface design gate and :1142 states the parked rows *"are NOT waiting on a sketch from the owner"*. Control: plan :1836 / P2.2 (`6b05d4c7a`) — *"drop `pi-only` from the two tools; add them to the host-callback set; extend the T5 bridge with `goal/get|set|clear`"*, landed. Unruled residue only: the chip's `valueMode` and whether a non-conversational affordance ships.
- **H9/claude** — The same two rulings; one decision covers all three runtimes because it is one host surface. Not an independent cell: `partial` for exactly the reason Pi is, and it moves the day the Pi cell moves (`SessionManager.ts:18076-18078` records the host goal service already running for `provider === 'anthropic'`). No separate claude decision exists.
- **H9/codex** — Display half ruled with H9/pi (plan :2017). Control half ruled by P2.2 (`6b05d4c7a`): the goal is host-side on every runtime, with plan :1836's Dev-9 deviation recording that codex-native `thread/goal/*` is deliberately not called. Unruled residue only: whether the binary's own goal engine is left running beside the host one — the question above.

### I — I. Isolation and worktrees

### [pi + claude + codex] Sharing a worktree `setupScript` through the repository — I5/pi, I5/claude, I5/codex

**Ruling (standing, partial).** The owner's 2026-08-22 decision map took the capability — *"Codex decision map: default-take list stands (execpolicy, manage-app-updates, worktree setup scripts, …)"* (plan:22) — and the build spec approved under it states the remaining refusal as settled: *"NOT the project `.nessy-agent/config.toml`: its parser is an allowlist … and its recorded invariant forbids shell commands from a project file (:19-25); **the invariant stays**"* (plan:1957, P3.6). So the answer is on record in both directions: the per-platform half is TAKEN and BUILT (P6.60, `a5c4e225e` — `setupScript` accepts a string or `{ windows, posix }`, unknown buckets refused by name), and the repo-sharing half is REFUSED, with the reason written where the shape is defined: *"a repository you clone must not be able to run a command by being opened"* (`packages/shared/src/config/worktree-settings.ts:9-24`).

Why the three cells stay `partial` rather than `covered`, and why that is not a gap a lane can close: no runtime has a native mechanism to adopt. `worktrees.md#set-up-the-worktree-environment` documents no setup-script setting at all — *"A worktree is a fresh checkout, so initialize your development environment there: ask Claude to install dependencies, or run your project's setup yourself in the worktree directory under `.claude/worktrees/`."* — with `.worktreeinclude` on the same page as the positive control that the page does document adjacent machinery; `settings-reference.md` documents four `worktree.*` keys and no fifth (`bgIsolation`, `sparsePaths`, `symlinkDirectories` at index `:809-811`, plus `baseRef`); codex's own setup scripts are a single Bash script in a Linux container, so there is no per-platform form to copy and no repo-sharing model that survives outside a container (weak tier — read from the page, not the source). Codex is the runtime the ruling was written about (plan:22 is the codex decision map), and `partial` rather than `n/a` is right on codex because P3.87 showed the capability has a subject there: codex has no worktree surface of its own but still reaches this mechanism through the host automation seam.

**Reopen options — recorded, NOT asked.** Read these only if team-shared worktree setup is wanted; otherwise nothing is owed and choosing the standing answer costs zero lane time.

- **A — the standing refusal holds (no reopen).** Buys: a repository you clone can never put a command in front of you, on any runtime; the project-config allowlist keeps its recorded invariant that a project file grants no trust, credentials, environment, filesystem roots or shell commands; zero lane cost. Costs: a team cannot ship its worktree setup with the repo, every member re-declares the script by hand, and the row stays `partial` on all three runtimes permanently.
- **B — reopen: allow a repo-declared script behind the existing digest consent card.** Buys: the sharing half with no new trust primitive — the card shows the exact command and keys the remember on a digest of the exact string, so editing the script never inherits the previous approval. Costs: a clone can put a plausible command in front of the user, and the card is explicitly NOT a floor — its own source says it is *"a normal, remember-able approval, not the `EnterWorktree` floor"* — so a remember-able card becomes the sole barrier, and it punches the first shell-command hole in the project-config allowlist.
- **C — reopen behind an explicit project-trust step, then the card.** Buys: two barriers, matching the vendor's own model — `worktrees.md#start-claude-in-a-worktree`: *"Interactive runs require workspace trust … run `claude` once there to accept the trust dialog."* Costs: this fork has no workspace-trust dialog to hang it on (project permission files are read today without one), so C is a new concept rather than a gate — L rather than M.

**Recommendation:** **A**, which is already the standing state and costs nothing to confirm. Parity direction: A closes the difference by DECLARING it closed — the capability is uniform across all three runtimes at the half that is built, and the missing half is missing identically everywhere, so there is no switch divergence to make honest. If the sharing half is wanted, prefer **C** over **B**: B makes a remember-able digest card the sole barrier against a hostile clone, which is the exact load its own source says it was not designed to carry.

**DECIDED 2026-09-05 (owner, by recommendation):** A — the standing refusal holds and is not reopened; C over B if the sharing half is ever wanted.

**Evidence:** `packages/shared/src/config/worktree-settings.ts:9-24` (the tier decision and the refusal), `:26-52` (the read-came-back-empty record — `worktrees.md`, `settings-reference.md` and codex all probed), `:157-201`, `:257-308` (the `{ windows, posix }` parser and `WORKTREE_SETTING_KEYS`); `packages/shared/src/sessions/worktree-setup-consent.ts:20-37`; `packages/shared/src/plugins/project-config.ts:22-26` (the invariant sentence); `packages/server-core/src/sessions/SessionManager.ts:14384` (`setup: this.createWorktreeSetupPort(...)` passed on EVERY construction, no provider term), `:14615`, `:14664` (`createClaudeWorktreePort`), `:14653-14662` (`noteAbsentWorktreePort`, codex); plan:22 (owner decision map), plan:1957 + plan:3175 (P3.6, *"the invariant stays"*); commits `a5c4e225e` (P6.60), `22d71972b` (P3.36 — port supplied and driven live), `721b7374e` (P3.6), `fbb24366c` (P3.87, `ˢ` → `ʰ`, and the no-subject hypothesis refuted); `https://code.claude.com/docs/en/worktrees.md#set-up-the-worktree-environment` and `#start-claude-in-a-worktree`, both fetched (200).

### J1 — J. Tools, MCP, browser (J1, J2, J4, J5, J6)

*(none — no cell in this slice carries an `already_ruled` from the plan's `## Owner decisions` sections or
from the out-of-scope register. O20 is the closest, and it is a hand-off TO the owner, not a ruling.)*

### J2 — J. Tools, MCP, browser (J7-J11)

- **J8/pi** [pi] — Owner 2026-08-28 (plan:999): *carry the modality faithfully, let the endpoint refuse* — valid only while the refusal stays legible, which the three arms now pin (`composer-capabilities.ts:317` → `modelSupportsImages` pre-send; `base-agent.ts:4757-4765` and `errors.ts:575` post-send, P3.138 `a0f377646`). STRUCTURAL, `honest_surface: present`, nothing to build on Pi: nothing in Pi can make a text-only gateway model see an image. The ledger's residue for this cell is stale since 2026-09-03.

### K — K. Models, effort, streaming

- **K4-host [host]** — the mini/preferred model table for the ChatGPT Plus/Pro OAuth card (`openai-codex`).
  Ruling: owner, 2026-08-29, on the subscription/provider surfaces — *«пока что у нас это вроде как сделано, но
  закрыто флагом… менять ничего тут не нужно»* — **do not build, do not delete, do not "clean up"**
  (`docs/superpowers/plans/2026-08-22-runtime-parity-closure.md` lines 718-724). P2.318 is PARKED as GATED under
  that ruling (plan line 2959: "No decision needed"), and it is the open row that already covers this cell.
  The ledger's own K4 host cell should record the ruling with the plan line, drop the stale `previousModel`
  sentence, and swap the row's Pi/Codex verdicts to match `e3f0a485c` (see `rows-K.md` §Promote).

### L1 — L. Instructions, memory, skills, plugins (L1-L4)

*(none — every gating section for this group is still open: §1.2, §1.4 and §2.3 all carry options and a controller recommendation, and no ruling.)*

### L2 — L. Instructions, memory, skills, plugins (L6-L10)

- (none) — the plan's `## Owner decisions` sections (lines 11–1148) were grepped for `skill listing`,
  `skill-listing`, `SLASH_COMMAND_TOOL_CHAR_BUDGET` and `budgetFraction`: zero hits. No cell in this
  slice carries an existing ruling.

### L3 — L. Instructions, memory, skills, plugins (L11-L16)

- **L16 [claude] — keep host-rendered skill delivery on claude.** Standing controller recommendation under the
  delegation rule: **(A)** keep host rendering until a plugin-route measurement says otherwise. This is a
  *recommendation*, not yet an owner ruling — plan row **P3.297** (`df32458af`) is still ⬜ and the decision sits
  at sitting **§2.3** with its packaged 9/9 measurement ("nothing native sees a directory-delivered skill", so
  the thin-host reading would REMOVE the skill surface rather than nativize it) and its two options. Evidence at
  HEAD: `packages/shared/src/agent/claude-agent.ts:750-775` (`CLAUDE_SESSION_DISALLOWED_TOOLS` includes
  `'Skill'` — "skills are host-handled through read-before-execute" — and `'Monitor'` since T3) and `:5474`
  `plugins: []`; the canonical register row `docs/architecture/runtime-control-boundary.md:126`. **Measured
  aside that removes one claimed consequence:** the model-callable slash allowlist is `compact | help` on BOTH
  Pi and claude (`claude-agent.ts:4157-4172`), so the ledger's "custom command" consequence of this posture is
  **uniform, not a switch divergence**. Nothing to answer here beyond §2.3.

### M — M. Observability and diagnostics

*(none — no standing owner ruling in the plan, the sitting page or the out-of-scope register touches M1, M2 or M3.)*

### N — N. Cross-session messaging

_None in this section._ (The nearest ruling is R23 — Pi's `MailboxService` agent-teams mailbox, owner-declined,
recorded at `packages/server-core/src/sessions/cross-session-inbound.ts:44-47` — but it rules out a *mechanism*
the N2 row does not propose using, not the N2 capability itself. Registered as context, not as a ruling on a
cell of this section. Likewise O26, out-of-scope register line 60, records `crossSessionInbound` as read by
nobody — a record of the defect, explicitly not a scope-out.)

### O — O. Notifications, UI, accessibility

(none in this slice — no owner ruling exists for any O2/O3/O4/O5/O6 cell: the plan's `## Owner decisions` sections carry no `midStreamBehavior` mention, the sitting page has no section on steering, notifications, the composer or shortcuts, and the out-of-scope register carries no O-numbered exclusion for these cells.)

## Also recorded — not questions, kept so they are not re-opened

### C — C. What leaves the machine (Notes for the stitch)

- The two §2.2 references are the **claude arm and the host arm of one decision**, not two decisions; if the stitch de-duplicates by section, collapse them and keep the host arm's constraint: the disclosure sitting §2.2 asks for already exists as the gaps-document row at `docs/architecture/runtime-capability-gaps.md:96`, which **refuses a switch-cost row in writing** — *"the switch table's admission rule is a capability the SOURCE has and the TARGET lacks, and this is the inverse — moving ONTO claude acquires an egress, it does not lose one"*. So option (C) needs no new switch row, and `honest_surface` for C2/host is **present**, not missing.
- No C5 cell is an owner question: all three (C5/pi, C5/codex, C5/host) are MEASURE, and the host arm is gated on the other two. Do not put a C5 disclosure choice to the owner before a measurement says there is a difference to disclose.

### L3 — L. Instructions, memory, skills, plugins (L11-L16) (Not questions, recorded so they are not re-opened)

- **L16 [pi]** — `n/a` verified with a positive control: the Pi harness declares no `Skill` built-in at all
  (`packages/pi-agent-server/src/__tests__/harness-contract/fixtures/tool-surface.json`, `grep -aoc '"Skill"'`
  → 0 while the same file lists `"Bash"`, `"Task"`, `"SlashCommand"`, `"AskUserQuestion"` and 35+ others; the
  only skill-named entries are our own session tools `skill_validate` / `read_skill_resource`). Nothing is
  withheld, so there is no posture to rule on.
- **L16 [codex]** — Claude's mechanism has no subject on codex, because we materialise no skill into
  `CODEX_HOME` (`prompt-builder.ts:279-281`). Codex's *own* skills path is real but unfed — **P3.296**
  (`f717d95d3`) measured the shipped binary re-extracting `skills/.system` every session — and the question
  "materialise skills into `CODEX_HOME`" belongs to ledger **L9** / P3.296, not to this row. It is not being
  silently dropped.

## Provenance and dedupe evidence

Each slice's own preamble, verbatim. These carry the dedupe measurements — the greps over the sitting
page, the plan's `## Owner decisions` region and the out-of-scope register that establish a question is
new rather than a restatement — and under the brief's citation rule they are the evidence for every
"this is new" claim above. A null here is checkable, not assumed.

### A1 — A. The safety floor (A1, A2, A4, A5, A7)

Deduped against `docs/superpowers/specs/2026-09-04-owner-sitting.md` (17 decisions). One new question;
two cells are already ruled and are listed at the end with the ruling, so they are not re-asked.

### A2 — A. The safety floor (A8-A12)

Deduped against `docs/superpowers/specs/2026-09-04-owner-sitting.md`. Its section list was read in
full (§1.1–1.9, §2.1–2.3, §3.1–3.4, §4.1, plus the appendix): none of the seventeen decisions is a
restricted safety mode, and §3.4 governs the SDK pin CADENCE, not this capability. Both registers were
re-checked: `docs/superpowers/specs/2026-08-28-out-of-scope-register.md` scores 0 for `restricted`, and
the plan's `## Owner decisions` blocks (lines 11–1148) carry no restricted-mode ruling — the `restricted`
hits there are `registry-restricted` in OQ-5 and unrelated prose. So this is one new question.

### B — B. What an organisation can enforce

Input: `wf_90ac3bfc-7c5/refute-additions_B.json` (15 non-covered cells). Repo HEAD `34be43fde`, branch `feat/TCODE-000`.
Three OWNER cells in this slice: `B3-pi`, `B3-codex` (both already ruled — see the last section) and `B5-codex` (one new question).
Deduped against `docs/superpowers/specs/2026-09-04-owner-sitting.md`: none of the 17 written decisions touches a section-B
capability — `newThread`, `requirements.toml`, `policyHelper` and `managedNewThreadDefaults` score **0** across that page, and
§1.3 ("every runtime hands its whole tool array to whichever model the session points at") is the tool array, not the model
restriction. So there is **one** new question here and **zero** sitting references.

---

### C — C. What leaves the machine

Five OWNER cells in this slice. **No new question is owed by any of them**: two are the two arms of a decision the sitting page already carries with options and a recommendation, and three are already ruled.

### D — D. Switching correctly

Five of the nine cells in this slice are `OWNER`. **Three of the five are already ruled and owe no
question** (the D4 trio — listed at the end). **Two owe a re-ask**, because the ruling that covers them is
provisional in the owner's own word («пока») and its written premise is measurably false at HEAD. Nothing
in this slice is on `docs/superpowers/specs/2026-09-04-owner-sitting.md` — greped for reasoning, thinking,
hook event, image, attachment, capability delta: zero matches, and the page's §1–§4 carry none of them —
so there is no section to defer to and both questions are new.

---

### E — E. The context window

One OWNER cell in this slice. Checked against `docs/superpowers/specs/2026-09-04-owner-sitting.md`
(17 decisions, §1.1–§4.1): none of them touches compaction steering, so this is new.
Checked against the plan's `## Owner decisions` region (lines 11–1148): compaction appears only at
`:526-527`, listing E2/E3 as cells to MEASURE, with no ruling — so there is no `already_ruled` entry.

### F1 — F. Sessions, checkpoints, recovery (F1-F4)

Not on the sitting page: none of §1–§4 of `docs/superpowers/specs/2026-09-04-owner-sitting.md` touches rewind, fork, checkpoints or the runtimes' own session stores (`grep -ain 'rewind|fork|checkpoint|ephemeral|session store|listSessions|persistSession|archive'` returns only two hits, both inside §2.3 about skill forking). So both questions below are new.

### F2 — F. Sessions, checkpoints, recovery (F5-F8)

Input: `wf_90ac3bfc-7c5/refute-additions_F2.json` — 10 non-covered cells at HEAD `34be43fde`.

**No new owner question comes out of this slice, and none of its cells maps onto an existing sitting section.**
All 10 cells classify BUILDABLE (8) or MEASURE (2): every one of them is closable by a lane with no product
posture at stake, and the two places where a posture WAS at stake are already ruled — listed below. Checked
against `docs/superpowers/specs/2026-09-04-owner-sitting.md`: its 17 decisions (§1.1–1.9, §2.1–2.3, §3.1–3.4,
§4.1) name the seatbelt wrapper, user-scope `env`, tool arrays, `additionalDirectories`, heredocs, the removal
corpus, background auto-commit, output styles, the iOS pipeline, the SDK's model gates, WebFetch, skills-as-text,
`danger-full-access`, codex teardown, the two upstream pins and the Pi LSP fallback — none of them touches
session background work, the running-work commands, the idle reaper or the stream-idle route. So there is
nothing to dedupe and nothing to add.

### G — G. Hooks and automation

Input: `wf_90ac3bfc-7c5/refute-additions_G.json`. Deduped against
`docs/superpowers/specs/2026-09-04-owner-sitting.md` (`grep -an -i hook` over that page returns exactly one
hit, line 297 — §2.3, which is about skills, not hooks) and against the plan's `## Owner decisions` sections.

**No new question is owed by this section.** The one OWNER cell in G is already ruled, and it is listed below.
Every other non-covered cell in G is BUILDABLE, MEASURE, or already delivered at HEAD — see `rows-G.md`.

One adjacency worth the owner's eye but **not** a question of this section: `rows-G.md`'s first row records that
the SDK's native plugin route (`Options.plugins` with `skipMcpDiscovery`) exists for claude hooks and was
declined for containment; adopting it is already in front of the owner as **sitting §2.3**, and the host route
this section proposes is compatible with either §2.3 answer.

### H1 — H. Subagents, workflows, review (H1-H5)

Two `OWNER` cells out of twelve, both codex. Deduped against the sitting page
`docs/superpowers/specs/2026-09-04-owner-sitting.md`: its 17 decisions cover neither — the whole page
mentions a subagent once (line 136, about documentation scores) and mentions `reviewer`, `spawn_agent`,
`max_depth` and `max_concurrent` zero times — so both are NEW, with no `sitting §x.y` reference to make.

### H2 — H. Subagents, workflows, review (H6-H9)

Four OWNER cells: H6/codex, H9/pi, H9/claude, H9/codex. All four carry an existing ruling, and the
rulings are listed at the end. Three questions remain — the residues those rulings do not reach.
Deduped against `docs/superpowers/specs/2026-09-04-owner-sitting.md`: none of these appears there
(`goal`, `worktree`, `isolation` as subagent isolation, `account/usage`, `estimatedUsage`, `features`
all score zero across its 17 decisions), so every question below is written out in full.

### I — I. Isolation and worktrees

Input: `wf_90ac3bfc-7c5/refute-additions_I.json`. Three of fifteen cells classified `OWNER`: **I5/pi, I5/claude, I5/codex** — and all three carry an `already_ruled`, one ruling that settles all three. The sitting page `docs/superpowers/specs/2026-09-04-owner-sitting.md` was checked at HEAD (`grep -an 'worktree\|bgIsolation\|setupScript'` → **0 hits**; its headings are §1.1–1.9, §2.1–2.3, §3.1–3.4, §4.1 plus the appendix), so nothing here is a duplicate of it and nothing here needs a `→ sitting §x.y` stub.

**New questions for the owner: none.** Every other non-covered cell in I1–I5 is BUILDABLE or MEASURE and is carried by `rows-I.md`. The only posture-bearing choice inside those rows is stated and EXCLUDED rather than taken quietly: the keep-or-remove row declines the vendor's *"for an unnamed session, Claude removes the worktree and its branch automatically"* arm, because silent deletion of a directory and a branch at session close is a destructive user-visible posture. If the owner wants that arm, it becomes a question; the row is finishable without it.

### J1 — J. Tools, MCP, browser (J1, J2, J4, J5, J6)

Two OWNER cells in this slice: **J2/Codex** and **J6/Codex**. Neither is on the sitting page
(`docs/superpowers/specs/2026-09-04-owner-sitting.md`, 17 numbered sections at HEAD): §1.3 carries the
adjacent MEASUREMENT for tool search but decides a different question (whether to pull the
target-conditioning plan into this plan), and the string `browser` appears in **zero** of the 17 sections.
No cell in this slice carries an existing owner ruling.

### J2 — J. Tools, MCP, browser (J7-J11)

Deduped against `docs/superpowers/specs/2026-09-04-owner-sitting.md` (17 decisions): none of its four
sections carries a J7–J11 question. §3.1 touches the adjacent half of one question below and is
cross-referenced there rather than restated.

### K — K. Models, effort, streaming

Source: `wf_90ac3bfc-7c5/refute-additions_K.json` (18 input cells, 1 of them `OWNER`). Deduped against
`docs/superpowers/specs/2026-09-04-owner-sitting.md` — read section by section: no section of that page mentions
aliases, tiers, mini/utility models or 1M context, so nothing in this slice is a sitting duplicate and nothing
in this slice is new either.

**No new questions in this section.** The one `OWNER` cell is already ruled; every other non-covered cell is
BUILDABLE, STRUCTURAL-with-a-buildable-surface, or a MEASURE, and all of them are in `rows-K.md`.

Two adjacent owner-shaped questions were found and deliberately NOT raised here, so a later pass does not read
their absence as an omission:

- **Stabilising the utility model across a runtime switch.** Its own docblock says doing so "inverts a stated
  posture, so it is an owner call" (`packages/server-core/src/sessions/SessionManager.ts:8800-8813`). It is a
  different capability from K4 and is already reported at switch time by P3.70 (`cdbb0851c`, `448f83685`,
  `reportUtilityModelChange` at `SessionManager.ts:8814-8829`). Not smuggled into a K row.
- **Mapping claude's `opus`/`sonnet`/`fable` aliases onto "the catalogue's coder model".** Rejected inside
  K6-claude rather than asked, because it would change which model a pinned agent talks to — the exact test the
  owner used to make P2.318 an owner call. The K6-claude row maps the aliases to the SESSION model instead, which
  is behaviour-preserving by construction and therefore needs no decision.

### L1 — L. Instructions, memory, skills, plugins (L1-L4)

Three OWNER cells: L1-pi (new), L4-pi (on the sitting page), L4-codex (on the sitting page, twice).

### L2 — L. Instructions, memory, skills, plugins (L6-L10)

Deduped against `docs/superpowers/specs/2026-09-04-owner-sitting.md` (17 decisions). That page carries
**nothing** about the skill-listing budget — `skill listing` / `skillListing` / `listing` / `budget`
grepped over it returns only §2.3 (skill DELIVERY on claude) and two unrelated score lines — so the
question below is new. §2.3 is cited inside it only as the neighbouring posture, not as the answer.

### L3 — L. Instructions, memory, skills, plugins (L11-L16)

Input: `wf_90ac3bfc-7c5/refute-additions_L3.json`. Deduped against
`docs/superpowers/specs/2026-09-04-owner-sitting.md` — measured, not assumed: over that page
`grep -aci` gives `headersHelper` **0**, `marketplace` **0**, `git clone` **0**, `Bitbucket` **0**,
`alias` **0**, against positive controls `skill` **9** and `plugin` **6**, whose only decision-bearing
hit is **§2.3** (native skill *delivery* on claude — a different subject from every question below).
Also deduped against the plan's `## Owner decisions` sections (plan:11-1148) and against
`docs/superpowers/specs/2026-08-28-out-of-scope-register.md`.

**Three new questions, all landing on the host**, because in this slice one host code path is scored across
three ledger columns: the skill marker (L11 pi+claude+codex), the marketplace credential command
(L12 host), and the marketplace source route (L13 pi+claude+codex). Answer each once, not three times.

---

### M — M. Observability and diagnostics

Checked against `docs/superpowers/specs/2026-09-04-owner-sitting.md` (§1.1–1.9, §2.1–2.3, §3.1–3.4, §4.1 + appendix): **no section concerns telemetry**, so both questions below are new. Checked against the plan's `## Owner decisions` (lines 11–1148): three hits for `telemetr|otlp|otel|DO_NOT_TRACK`, all unrelated. Checked against `docs/superpowers/specs/2026-08-28-out-of-scope-register.md`: one hit, O41, about interceptor packaging.

### N — N. Cross-session messaging

Input: `wf_90ac3bfc-7c5/refute-additions_N.json`. Cells: N2-pi, N2-claude, N2-codex, N3-codex (all BUILDABLE),
N3-host (CLOSED_AT_HEAD). **No cell in this section is class OWNER, so there is no question to put to the sitting.**

Why, stated so the null is checkable rather than assumed:

- **N2 (hold/refuse an inbound cross-session message)** is documented end to end by the runtime that owns the
  surface — `https://code.claude.com/docs/en/cross-session-messaging.md#control-inbound-messages`, both arms
  (lines 221 and 222), the detached-client rule (line 228), the session-end expiry report (line 247) and the
  `/config` row's constraints (line 217) — and the vendored SDK already declares the setting and the
  `dialogExpiry` enum (`sdk.d.ts:7243`). The read-don't-invent ordering therefore stops at tier 1: it is
  build-not-ask. The one product posture inside it — the default when no value is set — is **stated by the
  page, not chosen by us**, and the ordering constraint in the row (default and card land together) is what
  keeps it from becoming a posture change by accident.
- **N3-codex** is a resilience defect in a host-owned bridge with a measurement prerequisite, not a posture.
  Its one posture-shaped neighbour — whether to enable codex's `multi_agent_v2` for its native
  `list_agents`/`send_message` — is answered by native-first as **do-not-adopt** and needs no owner: those
  tools enumerate codex-spawned collaborators inside one process, not the host's other sessions, so adopting
  them would put a second, differently-scoped roster and send tool in front of the model beside the host's.
  Recorded in the P6.\_\_\_ row rather than asked.
- **N3-host** is a stale ledger verdict (SILENT → REPORTED) with a promotion line, not a decision.

Dedupe check against the sitting page: `grep -ain 'cross-session|send_agent_message|crossSessionInbound|dialogExpiry|inbound'`
over `docs/superpowers/specs/2026-09-04-owner-sitting.md` → **0 hits**; its 22 headings (`§1.1`–`§4.1` plus the
appendix) carry no cross-session decision. So there is nothing here to fold into an existing `§`, and nothing
here to add.

### O — O. Notifications, UI, accessibility

One OWNER cell in this slice. Checked against `docs/superpowers/specs/2026-09-04-owner-sitting.md` (all 20 sections plus the appendix read): nothing there covers steering, follow-up behaviour or the composer send key, so this is new rather than a `→ sitting §x.y` pointer. `grep -ac 'midStreamBehavior'` over the plan is 0 and no row names a per-message override, so there is no prior ruling either.
