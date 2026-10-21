# Owner sitting — 2026-09-04

**Seventeen decisions the runtime-parity plan cannot take for you.** Every one is
MEASURED: a lane drove it, wrote the options and the cost of each, and stopped.
None is a request for permission to do obvious work — each is a place where two
defensible answers exist and the choice changes what the product *is*.

**Addendum 2026-09-05.** The ledger-closure sweep produced **27 further questions** (host 9, codex 11, claude 4,
pi 2, one cross-runtime), deduped against this page — five of them resolve to sections here and are marked so.
They live in `2026-09-05-ledger-closure-owner-questions.md`, grouped by runtime, each with options, buys, costs
and a recommendation; the parity ceiling they gate is in `2026-09-05-parity-ceiling.md`.

**ANSWERED 2026-09-05.** All seventeen were decided in one sitting: every section exactly as its own
*Controller recommendation:* line states, with **two exceptions** — **§1.1**, where the recommendation is
refused and the status quo is kept (the sandbox stays off, the `(allow default)` wildcard stays), and
**§3.3 + §3.4**, taken as recommended but with the codex and SDK lifts explicitly **moved to the plan's
close-out**. Each section carries its answer on a `**DECIDED 2026-09-05 (owner):**` line below its
recommendation; the per-row consequences are in `docs/superpowers/plans/2026-08-22-runtime-parity-closure.md`,
section *Owner decisions 2026-09-05, part 2*.

Grouped by the runtime the decision lands on. Where a row already carries a
controller recommendation under the standing delegation, it is the last line of
the row and is labelled as such.

Reading order, if you have twenty minutes: **§1.1** (a security control that is
switched on and contains nothing), **§2.1** (a capability the SDK withdrew from
under us), **§1.2** (a setting the product declares and refuses).

---

## 1. Host — decisions that land on all three runtimes

### 1.1 The macOS seatbelt wrapper emits `(allow default)`, so an approved Bash command is uncontained

**Measured**, on a real darwin rig, both branches through the shipped
`wrapBashCommandWithMacosSeatbelt`, with a dead control that passes both arms so
the rig is known to discriminate:

| probe | shipped (wildcard) | the flip (strict) |
| --- | --- | --- |
| `printf ok` — dead control | 0 | 0 |
| write inside cwd | 0 | 0 |
| write **outside** cwd | **0, file created** | 1, `Operation not permitted` |
| write to the home directory | **0, file created** | 1, `Operation not permitted` |
| write to the SSH key directory | **0, file created** | 1, `Operation not permitted` |
| `pbpaste` | 0 | **1** (the mach narrowing) |
| `dig`, `dscacheutil`, git over TLS, keychain lookup | 0 | 0 |

The constant is `SEATBELT_TESTING_WILDCARD = true`, a **twice-reaffirmed** owner
decision (2026-07-21, 2026-07-29) taken for a testing period that has since run a
long way.

**The escalation trigger half-fires, and this is the part to read.** The code's own
docblock said writes and the SSH directory are "contained by other machinery".
Driven through the real gate: the SSH directory *does* reproduce — the denied-path
floor refuses it in `default`, `acceptEdits` and `bypassPermissions` alike, so that
claim holds. **A write to the home directory does not.** The
`Operation not permitted` the note credited to elsewhere is produced by the STRICT
branch — by the branch the wildcard replaces. So one half of the reassurance was
circular.

Honest framing, because it changes the severity: this is **not worse than a default
install**, where the wrapper is off and the command is equally uncontained. The cost
is that a control an operator **deliberately switched on** does not control, and
says nothing. It is reachable in a shipped build: a managed policy plus the legacy
key forces the wrapper on.

Three runtimes disagree here, which is its own finding: nothing is contained on Pi
or claude-runtime, session-tools has real containment (`buildDarwinSandboxProfile`
has no wildcard), and codex emits `(deny default)`.

**Options.**
**(A) Flip to strict.** Real write containment on approved Bash. Cost: `pbpaste`
breaks — one of the four breakages the 2026-07-21 note feared; the other three
(`dig`, git over TLS, keychain) do **not** reproduce. Testers lose clipboard reads
from shell commands.
**(B) Keep the wildcard and say so.** A once-per-session diagnostic on the SUCCESS
path naming the wildcard, plus the docblock correction — both already built, so this
option costs nothing further. The product then has a setting that reads "sandbox on"
and contains nothing, disclosed.

*Controller recommendation:* **(A)**, with `pbpaste` accepted. A security control
whose only remaining justification is a testing period is a control the next reader
will believe.

**DECIDED 2026-09-05 (owner):** **(B)** — **exception, the recommendation is refused and the status quo is kept**: the wildcard stays, the sandbox stays off by default, no flip and therefore no `pbpaste` carve-out; the standing 2026-08-12/13 sandbox-off decision is reaffirmed. Option B's disclosure half was already built and is verified at HEAD, so nothing further is owed → P3.330 ✅.

### 1.2 A user-scope `env` block is declared, loudly rejected, and never applied

`env` is in both settings schemas. Its only non-test reader records a rejected
settings layer. Three premise corrections make the park file's own decision menu
unusable as written, and they are why this is on the page rather than in a lane:

1. Containment is now a **two**-option question, not three — the OS-sandbox route is
   foreclosed by the standing 2026-08-12/13 decision that isolation is off and not
   coming back.
2. The refusal must be stated against **five** withheld categories, not the park's
   four, and the missing one is `execution` — which binary a shell-out resolves to,
   i.e. `PATH`. That is the most load-bearing item in the park's own threat model.
3. The pin meant to catch this being quietly finished had greped to **0** in the
   checklist that actually runs. It is restored (as a unit test, which is stronger).

Two further things nobody has answered: the CA ladder has **no rung** for a user
`env`, so a block written into the process environment could silently outrank the
configured CA path; and LOCAL scope has no recorded refusal while PROJECT scope
errors.

**Options.**
**(A) Refuse permanently**, and disclose the divergence from the documented
behaviour rather than leaving a schema key that reads as supported.
**(B) Apply it behind a name allowlist.** The code is the cheap half —
`parseManagedEnvBlockV1`/`applyManagedEnv` already exist. The allowlist would then
be the ONLY containment, since the sandbox route is closed, and the three questions
above must be answered before it ships.

*Controller recommendation:* **(A)**. Option B's containment is a list somebody has
to keep correct forever, against a threat model whose worst item is `PATH`.

**DECIDED 2026-09-05 (owner):** **(A)** — refuse the user-scope `env` block permanently and disclose the divergence rather than leave a schema key that reads as supported → P3.373 ⬜.

### 1.3 Every runtime hands its whole tool array to whichever model the session points at

**Measured on four paths** — codex, claude-translated, claude-passthrough, and Pi:
all forward `tools[]` verbatim (names, descriptions, JSON schemas), and **nothing
consults which model is on the other end**. Positive controls: injected schema
fields visible on the wire; the translator rewrote `input_schema` → `parameters`
while passthrough did not. Scale: 77 Pi bindings, 55 of them session tools.

Native-first was asked and answers no: all three runtimes have a tool-deferral
mechanism and none is target-conditioned. On codex, tool search is **dead**, not
unset.

A disclosure notice is already built and wired (it names the class, the host and the
tools). What is NOT built is any host control over which schemas leave for which
target.

**This is a SCHEDULING decision, not a discovery.** The work has its own plan, every
row of which is ⏳ and which states it executes *after* the parity plan closes, with
a mandatory re-anchor pass. Two things to know before saying yes: one of its own
design collisions (a restricted host versus the BYO card's default endpoint) must be
settled before the predicate can be written, and its live-network probe series
cannot run offline.

**Options.** **(A)** Pull it into this plan. **(B)** Leave it to its own plan after
close-out.

*Controller recommendation:* **(B)**. The disclosure notice makes the current state
honest, which was the urgent half.

**DECIDED 2026-09-05 (owner):** **(B)** — left to its own plan after this one closes; the disclosure notice already made the current state honest → P3.363 stays ✅.

### 1.4 One `additionalDirectories` setting, three treatments, and the Pi arm is inert

- **claude-runtime** — the key reaches the child as `--add-dir`, and the
  documentation scores that flag "Yes" for loading skills, commands and subagents
  from those roots.
- **codex** — the setting appears in **zero** lines (controls on the same file:
  `skill` 18, `sandbox` 63).
- **Pi** — worse than the spec says. The block that would honour it iterates a
  context field whose **only production producer never sets it**, so the documented
  opt-in cannot take effect at all.

A diagnostic naming which of the three answers a session got is built. The one-line
wiring that would make Pi honour it is written and deliberately **not landed**: it
widens what Pi may write.

**Options.** **(A)** Wire the Pi arm (behind the existing off-by-default opt-in) so
the setting means one thing. **(B)** Delete the Pi seam and state that
`additionalDirectories` is a claude-only setting.

*Controller recommendation:* **(A)**. The opt-in is off by default, so the blast
radius is an operator who asked for it.

**DECIDED 2026-09-05 (owner):** **(A)** — wire the Pi arm behind the existing off-by-default opt-in so the setting means one thing → P3.339 re-opened 🟨 → ⬜.

### 1.5 A heredoc body is read as a command by the compound-command splitter

`["cat <<EOF", "rm -rf ~", "EOF"]` — the non-negotiable removal breaker fires on a
heredoc that removes nothing, and the deny/ask rule engine shares the splitter, so
the same shape can **over**-block (a heredoc writing a script) and, mirrored,
**under**-block (a heredoc whose body is executed later reads as data). Always in
the path: every Bash call passes through the splitter.

Reproduced with controls, then **stopped**, for three reasons that are the decision:

1. The named instrument — an 18 272-command corpus — lives under a real home
   directory and cannot be executed against under the standing safety rule (§1.6).
   The available fuzz asserts an allow-side invariant only (2 000 cases, 238
   governed, 0 violations).
2. The scanner's own docblock records a **standing owner ruling against** a heredoc
   model in this scanner.
3. The fix runs against the module's *refuse more, never approve more* rule.

**Options.** **(A)** Lift the standing ruling and build a heredoc-aware split, with
§1.6 resolved first so it can be weighted. **(B)** Keep the ruling and accept the
over-block, documenting the mirrored under-block as a known shape.

*Controller recommendation:* decide §1.6 first; this is downstream of it.

**DECIDED 2026-09-05 (owner):** **(A)**, because §1.6 resolved to (A) and that is the precondition option A names — lift the standing ruling and build a heredoc-aware split, **sequenced after §1.6's corpus copy lands** → P3.329 ⬜.

### 1.6 The corpus that would weight the removal breaker lives where no lane may execute

The command corpus comes from session transcripts under a real home directory. The
standing safety rule after this project's own `rm -rf ~` incident forbids executing
any string that names a real home or root, so the lane that needed it **correctly
routed around it** and measured a designed adversarial slice instead.

The result is honest but **unweighted**: we know the breaker's behaviour on
constructed cases and not its coverage on real traffic. Every coverage claim about
the removal breaker is currently a claim about the adversarial set.

**Options.** **(A)** Take a one-time copy into the repo or a scratch tree, by a
human or under an explicit approval, with the transcripts treated as untrusted data.
**(B)** Leave the claim scoped to the adversarial set, permanently and in writing.

*Controller recommendation:* **(A)**, one copy, read-only, treated as untrusted.

**DECIDED 2026-09-05 (owner):** **(A)** — one copy, read-only, treated as untrusted → P2.389 ⬜, and it gates §1.5.

### 1.7 Background auto-commit: the host mechanism, or the documented shape

Not built, and the native-first answer changes the question. Both vendors' documented
shape for an unattended commit is **the model committing under an explicit grant**,
and one vendor's own session-recovery mechanism explicitly declines the job. Codex's
own prompt refuses to commit unless explicitly asked — once per file in five static
prompt files, none templated — and the codex flag that looked like the documented
route is `Stage::Removed`, a key nothing reads.

Whichever shape is chosen, one thing is owed first: the branch guard the plan's own
clause names is **declared, read, and set by no production site** — only a test
fixture — so today the judge adjudicates on a permanently undefined field.

**Options.** **(A)** Keep the host-side on-completion mechanism. **(B)** Adopt the
documented shape — a grant to the model — and drop the host mechanism.

*Controller recommendation:* **(B)**: less host code, and three runtimes do it the
same way. Either way, the branch guard needs a producer before it guards anything.

**DECIDED 2026-09-05 (owner):** **(B)** — adopt the documented shape (a grant to the model) and drop the host mechanism; the branch guard needs a producer either way → P2.11 ⬜ and P6.64 ⬜.

### 1.8 Output-style changes take effect at different times on different runtimes

The documentation says: output style is part of the system prompt, read once at
session start, and changes take effect after `/clear` or a new session. **Codex
conforms. Pi and claude-runtime diverge** — both apply a style change mid-session.

Converging on the page would REMOVE a behaviour users have today, and it lands in
two foreign files. So the divergence was made **honest instead**: a switch-cost row
derived per run from the agent sources, plus the capability-gaps row.

**Options.** **(A)** Converge on the documented behaviour and lose mid-session style
changes on two runtimes. **(B)** Keep the divergence, disclosed at the switch.

*Controller recommendation:* **(B)**, already shipped. This is here so the choice is
recorded as yours rather than as an omission.

**DECIDED 2026-09-05 (owner):** **(B)** — keep the divergence, disclosed at the switch; already shipped → P3.227 stays ✅.

### 1.9 Should the iOS build run on every pipeline?

The gate exists — `swift build` / `swift test` / `xcodebuild` — and the earlier
claim that iOS was ungated is **refuted**. What is real is narrower: it runs only on
changes under the iOS directory. Cost of changing it is macOS runner minutes.

**Options.** **(A)** Every pipeline. **(B)** Keep the path filter.

*Controller recommendation:* **(B)** until a cross-cutting change breaks it once.

**DECIDED 2026-09-05 (owner):** **(B)** — keep the `apps/ios/**` path filter → P2.370 stays ✅.

---

## 2. Claude Code

### 2.1 The SDK we ship model-gates the Task and TodoWrite tools, and our default model is an exact threshold match

Read out of the shipped binary, not inferred. All four Task tools and `TodoWrite`
are withheld unless an opt-in is taken, for models at or above a published
threshold. **Our default model is an exact match.** The remote escape hatch is
closed by our own non-essential-traffic setting, so on a listed model the withdrawal
is **deterministic**.

**FOUR opt-ins exist, not the three first counted** — the fourth is a launch option
fed from the allowed-tools list, so opting in costs **no environment variable**.

Either way, one thing must change: the switch-cost rejection that hides this is
built on a type declaration, and a declaration cannot express a runtime predicate.
The same half-sight is written in two other places.

**Options.** **(A) Opt in.** The tools stay, the switch cost stays zero, at the
stated context price. **(B) Accept the withdrawal** — then it is a real cost row and
a user-visible statement that these tools are gone on this runtime.

*Controller recommendation:* **(A)**, via the launch option rather than the
environment variable, since it needs no deployment change.

**DECIDED 2026-09-05 (owner):** **(A)** — opt in via the launch option `todoToolsOptIn`, which costs no environment variable and so no deployment change → P3.338 ⬜.

### 2.2 WebFetch sends every requested hostname to a hardcoded vendor endpoint before fetching

Read from the shipped binary: the call site is guarded only by a
`skipWebFetchPreflight` setting; the endpoint is **hardcoded**, so our loopback
adapter cannot intercept it; the hostname travels as a **query parameter**; the
cache is allow-only, five minutes, 128 entries. The vendor's own page agrees the
check runs **regardless of provider** and is **not** affected by the
non-essential-traffic switch. The claim that this "cannot be proven from this tree"
was false, and is now pinned by a marker test against the binary.

Pi and codex run no such preflight, so whichever way this goes, the residual
difference needs one disclosure row.

**Native-first gives THREE options, not two** — the runtime ships both a
`WebFetch(domain:…)` permission rule and a network allowed-domains setting, both of
which this repo already parses, and the page itself prescribes pairing them.

**Options.** **(A) Leave it.** Hostnames a user asks for leave to a third party
before the fetch. **(B) Disable it.** Any domain is fetched with no vendor check.
**(C) Disable it paired with a host-supplied domain allowlist.** Our own control
replaces theirs.

*Controller recommendation:* **(C)**. It is the only one that removes the egress
without removing the control.

**DECIDED 2026-09-05 (owner):** **(C)** — disable the preflight paired with a host-supplied domain allowlist, the only option that removes the egress without removing the control → P3.352 re-opened 🟨 → ⬜.

### 2.3 Skills reach claude as host-rendered prompt text, not as the filesystem artifacts the runtime loads

Two rows met the same wall from opposite sides: the host passes an empty plugin list
and renders skills into the prompt, and the vendor page says skills are **filesystem
artifacts** with no registration API — so every native skill feature (the fork
route, frontmatter hooks, the listing command) is unreachable.

**Measured on a packaged build (PASS 9/9): nothing native sees a
directory-delivered skill.** In the project the SDK itself treated as cwd there was
no skill call, a no-tool enumeration listed the 32 host-rendered skills and neither
probe skill, and the fork route produced nothing. **So the thin-host reading would
REMOVE the skill surface, not nativize it** — unless the delivery is the plugin
route rather than a bare directory, which that measurement did not drive.

**Options.** **(A)** Keep host rendering (today's behaviour). **(B)** Drive the
plugin-route measurement first, then decide.

*Controller recommendation:* **(A)** until a plugin-route measurement says
otherwise.

**DECIDED 2026-09-05 (owner):** **(A)** — keep host rendering; the plugin-route measurement stays admissible and is not owed → P3.297 ✅.

---

## 3. Codex

### 3.1 `danger-full-access` resolves to workspace-write, because our credential floor supersedes it

**Measured both ways** — from the open source at the pinned tag and from six driven
arms with two controls. A permission profile supersedes the sandbox mode in one
layer, and our unconditional credential-floor profile extends the workspace scope,
so the sandbox-off switch **does not turn the sandbox off on codex**. Exactly one of
seven modes diverges. The host now reads codex's own reported sandbox and names
which one is in force, so the user is no longer told the wrong thing.

Four candidate respellings are recorded at the site. Two are product postures, and
one of those is **fatal** — the whole config is discarded. A fourth was measured but
not framed and is the only one that might satisfy both halves; it redefines what
*sandbox off* means.

**Options.** **(A)** Keep the credential floor and accept that sandbox-off resolves
to workspace-write, honestly reported. **(B)** Adopt the fourth spelling and accept
the new meaning of *sandbox off*.

*Controller recommendation:* **(A)**. A credential floor that a user-facing switch
can remove is not a floor.

**DECIDED 2026-09-05 (owner):** **(A)** — keep the credential floor and accept that sandbox-off resolves to workspace-write, honestly reported → P3.315 stays ✅.

### 3.2 A codex teardown failure refuses the runtime switch — keep it, or make it non-fatal?

The teardown throws after five per-step catches, and the caller re-codes only one
error and rethrows, so the state clear and the marker write are skipped.

**Narrowed by code, which may make a live day unnecessary.** Of the five steps,
three are **structurally unable** to reject in ordinary operation; the honest prior
is the removal of the per-session codex home (its retry policy covers only some
errno classes, and a 1.6 MB write-ahead log was measured still being written there).
One row premise is corrected: the kill step **can** reject, narrowly. Step
attribution now ships, so the next occurrence names its own leaf.

Its sibling — an **unbounded** kill, a hang rather than a rejection — was found
while measuring this and is **fixed** in 1.34.0.

**Options.** **(A)** Keep the throw. The code states the rejection is the contract.
**(B)** Downgrade to a warning, and let the switch proceed over a possibly-leaked
child process and a possibly-undeleted per-session home.

*Controller recommendation:* **(A)**. The hang, which was the genuinely bad
outcome, is gone.

**DECIDED 2026-09-05 (owner):** **(A)** — keep the throw; the hang, which was the genuinely bad outcome, is already gone → P3.341 ✅.

### 3.3 Codex upstream is four minors ahead of the tag every codex claim rests on

Artifactory-latest is what we ship. The only "latest" left is **upstream**, four
minors ahead — and moving there invalidates **140 evidence citations across 69
tracked files**, because every codex measurement in this plan is pinned to the
current tag.

**Options.** **(A)** Stay on the shipped tag until the plan closes. **(B)** Move,
and fund a re-measurement wave.

*Controller recommendation:* **(A)**. Moving mid-plan turns every codex cell back
into a hypothesis.

**DECIDED 2026-09-05 (owner):** **(A)**, and **deferred to close-out** — finish the plan on the shipped tag, then lift all three runtimes together and cover the difference as its own measured step → P3.283 stays ⬜.

### 3.4 What "Artifactory-latest" means for the Claude SDK pin

The wave brief named a version as *Artifactory-latest*, measured one day earlier. At
the start of that lane the registry's `latest` was already two releases ahead, and
`bun install` announced a third minutes later. The lane installed the **pinned**
number as instructed, because chasing a moving `latest` mid-lane makes every
before/after figure unreproducible.

A planning fact, not a product one — nothing in the tree is wrong. Only you can say
which of the two governs.

**Options.** **(A)** The number in the brief governs. **(B)** The tag at execution
time governs — in which case the next bump is a second lane of the same shape, and
that lane's method (diff the type surface, re-measure every bundle-derived guard,
re-run the gated end-to-end arms) is the whole cost.

*Controller recommendation:* **(A)** during a plan, **(B)** at each plan boundary.

**DECIDED 2026-09-05 (owner):** **(A)** now, **(B)** at the boundary — **deferred to close-out**: the number in the brief governs until the plan closes, then all three SDKs lift together → no open row (P3.223 is ✅).

---

## 4. Pi

### 4.1 The native LSP fallback has no producer, in production or in any test

The resolver has four code hits, all declarations. Both hosts pass explicit
dependency literals without it, and the shared test helper — which forwards eight
other optional seams by name — omits it too, so the fallback branch has **never
run**. Correction to the row as filed: **no test pins the dead branch**, so deleting
it turns nothing red.

The model loses exactly two things: the `lsp` tool (absent, degrading honestly — no
inert tool to fix) and the LSP half of the post-edit payload.

Three readings make this yours rather than a lane's: claude has **no native LSP
mechanism to mirror** (probed in the vendored SDK — plugin manifest only), so
supplying one is a Nessy posture reached at native-first step 3; the plugin route is
thin but real (12 of 2583 catalogue entries); and a host-supplied producer would
**bypass the safe-mode funnel entirely**, while the suppressed-surfaces list already
names LSP servers.

**Options.** **(A) Supply the producer** under detect-and-use-never-install, with an
explicit safe-mode gate and a setting. This is a new product posture — spawning a
language server the user did not install, in a trusted project. **(B) Delete the
branch** and stop advertising a path this tree never had.

*Controller recommendation:* **(B)**. Option A is a posture, and the honest
degradation already exists.

**DECIDED 2026-09-05 (owner):** **(B)** — delete the branch and stop advertising a path this tree never had → P3.366 ⬜.

---

## Appendix — what is NOT on this page

- **Anything a lane could decide.** Where the documentation ran out and the choice
  was small and reversible, lanes decided and wrote the reason at the site, under the
  standing transparent-and-simple rule. Those are in the commits, not here.
- **Anything still being measured.** A decision needs a measurement; a hypothesis
  needs another lane.
- **The live evidence still owed.** That is the live checklist's job, not this
  page's: it carries its own owed rows with their preconditions named.
