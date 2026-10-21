# Phase 4, section A — what eight unread contract pages contained

Eight pages read for the first time on 2026-07-29, each compared against our
code, each "we already implement this" claim then handed to an independent agent
told to refute it. Method and page inventory:
`2026-07-29-unread-doc-pages.md`.

**Every one of the eight came back `gaps-found`.** Not one page was already
conformant. Nine refutations succeeded across the eight verify passes, and the
agents preferred running probes to reading code — several findings below are
quoted from an executed probe, not from an inspection.

---

## The one that outranks everything else

**In `allow-all`, `rm -rf ~` runs with no prompt.**

`permissions.md` states the rule twice and `permission-modes.md` a third time:
removals targeting the filesystem root or home directory "still prompt as a
circuit breaker against model error", even under full permission bypass, and
even when the removal hides inside `$(...)`, backticks or `<(...)`. The same page
adds that the breaker outranks plan mode's own suspension of blocks.

We have none of it. `rg` for `rootRemoval|homeRemoval|dangerousRemoval|
destructiveRemoval|removalCircuit` across `packages/` and `apps/` returns
nothing; the `rm -rf /` strings that do exist in `mode-manager.ts` are all
comments explaining why command substitution is dangerous. The file reasons about
the mechanism and never implements the floor.

Planned as **S4** (`2026-07-29-removal-circuit-breaker.md`), dispatched. The
machinery it needs already exists — `worktreeApproval` and the
interaction-required prompt are emitted before every mode branch and carry
`nonNegotiable` with no don't-ask-again, which is exactly the shape a circuit
breaker needs.

---

## Security findings, by page

### `managed-mcp.md` — an admin's denylist denies nothing

The documented allow/deny entries are **objects** discriminated by `serverUrl`,
`serverCommand` or `serverName`. Ours are `readonly string[]` validated by a name
regex. Probed against the real parser: a policy whose `deniedMcpServers` is the
page's own example —
`[{serverName:'dangerous-server'},{serverCommand:['npx','-y','unapproved-package']},{serverUrl:'https://*.untrusted.example.com/*'}]`
— parses to an **empty** denylist. `isManagedMcpServerAllowed` returns `true` for
every one of them. The admin sees an accepted policy file and a single console
warning; the servers they meant to block keep loading. **Fail-open on the deny
path**, which for a bank fork is the wrong direction to fail.

The allowlist example fails the other way: it strips to `[]`, which admits
nothing and blocks MCP fleet-wide.

Worse structurally: name matching is the **only** dimension we have, and the page
says in terms that a server name "is not a security control … To enforce which
servers actually run, add `serverCommand` or `serverUrl` entries." A user who
renames a denied server escapes the denylist; a user who names an arbitrary
server `github` satisfies an allowlist. There is currently no way for a T-Bank
administrator to constrain *which binary or endpoint* runs — only what it is
called.

All three of this page's "implemented" claims were **refuted**.

**Closed 2026-07-29 as S5**: `02942390`, `ffee8442`, `5a89821f`, `5ea04774`,
against `2026-07-29-managed-mcp-entries.md`.

**Verified by me, independently of the executor's tests.** The page's verbatim
denylist example now parses to three entries with **zero drops** (it previously
dropped the whole value), and all three match a real server. Exact-argv semantics
hold in both negative directions — an extra flag and a missing argument each
fail to match. And the case the URL dimension exists for: a server **renamed** to
something innocuous is still blocked by its `serverUrl` entry. That was
unreachable before, because name was the only dimension we had.

Seven corrections came back, and three changed the outcome:

- **`allowManagedMcpServersOnly` is not implementable here and was recorded
  `inapplicable` rather than added.** We have no user/project/local settings
  surface carrying these lists — they exist only on `ManagedPiPolicyV1` — so
  "only the managed allowlist survives" is already our permanent state. Adding
  the key would have declared a lock that enforces nothing, which is the exact
  defect this audit exists to remove. My plan asked for it; the executor was
  right to refuse.
- **Adopting the documented `serverName` charset verbatim would have broken
  deployed administrators.** Our regex permits `.`; the doc's set does not. A
  literal port would silently strip `{"serverName":"my.server"}` and stop that
  server loading fleet-wide. Kept as documented-set ∪ `.`, with the deviation
  stated.
- **The denylist's invalid-entry posture was resolved deliberately**, which was
  the sharp edge I flagged. An entry carrying a good key beside a typo is
  *stripped* on the allowlist (narrowing is safe) and **enforced** on the
  denylist for every valid key it carries, recorded as `tightened`. Every
  outcome is a drop record, so `nessy-general-agent doctor` lists it.

**One residual hole, reported and deliberately not changed.** The managed filter
is guarded by `isPiCapabilityTurn`, which covers every shipped agent turn. But
`WorkspaceMcpPoolRegistry` is provider-neutral by a pinned contract, and it
**connects** what it resolves — so a denied MCP server is still contacted, and
its tools listed, when the Sources UI warms the pool. The agent cannot call it;
the connection still happens. For a bank fork that is a real gap, and widening
the guard breaks a pinned snapshot-identity test, so it is a decision about that
contract rather than a bug to patch. Recorded here so it is not lost.

Also reported, not fixed: `sources.CREATE` never consults the policy, so a user
can create a denied MCP Source and sees only a silent disappearance rather than
the documented refusal. A feedback gap, not a boundary gap.

### `sandbox-environments.md` — the read floor holds, the egress does not

Probed live on macOS by reconstructing the byte-exact shipped profile and running
it under `/usr/bin/sandbox-exec`. The write half is **conformant**: writes inside
the workspace succeed, `~` returns `Operation not permitted`. The credential deny
floor works: `~/.ssh` is blocked.

But the page's default boundary has a second half — a first-use prompt per
network domain — which our foreground shell replaces with `(allow network*)` by
owner decision. Under that same profile the probe read
`~/Library/Application Support/Google/Chrome/Default/Cookies`,
`~/.docker/config.json` and `~/.gitconfig`. Ambient read plus open egress is
precisely the combination the page warns is not a hard control.

And `sandbox.network` (`allowedDomains`/`deniedDomains`/`allowManagedDomainsOnly`)
is fully parsed, length-validated, given careful anti-widening floor semantics —
and consumed **only** by the Monitor websocket guard. The recurring defect,
applied to an admin-facing security key, in the same file whose filesystem half
is fully live.

**Closed 2026-07-29 as S8**: `0860c250`, `1b0a9258`, `dd476220`, `ab1ca721`,
`b9abd1e6`.

**I misdiagnosed one of the three findings, and the executor's correction is
sharper than the finding was.** We do not reject `type: "agent"` outright — the
type is accepted. What we rejected was the **documented shape**: the adapter
demanded an `agent`/`agentName`/`name` key that exists nowhere in `hooks.md`, so
the reference's own example hook died on `Claude agent hook requires an agent
name` — a diagnostic naming a field its author could not have supplied. Worse, it
read `name`, which is the hook's own **id**, so `{type:"agent", name:"verify-tests"}`
imported as *spawn the subagent `verify-tests`*. A silent misinterpretation, not
a refusal.

**My Task 1 gate would not have proven the channel on the shipped backend.**
`AutomationSystem.executeAgentEvent` is the non-Pi path; on Pi every hook —
native `hooks.json` included — runs through `executePluginHookAutomations`. Both
are now wired and tested, with the recipe test driving the Pi class.

Finding (b) was also understated: **three** documented `SessionStart` sources
were missing, not one — `clear` and `fork` besides `compact`. `clear` and
`compact` now fire; `fork` is recorded. And the event's frozen contract row was
already wrong before this unit, describing it as `once-per-session` and owned by
the lifecycle bridge when the host has emitted it for a long time.

The three-event stdout list was derived from `hooks.md:674` — "The exceptions are
`UserPromptSubmit`, `UserPromptExpansion`, and `SessionStart`" — rather than from
my plan, which is the right order. The JSON-versus-text discriminator is shared
by the parser and the context channel so they cannot disagree, and the
post-compaction re-injection rides the **volatile user tail**, with a test
asserting it is not in the system prompt (issue #862).

**A fifth commit carried four review findings** the executor found in its own
work: queued post-compaction context leaking across a workspace switch, the same
reminder delivered N times after repeated compactions, the queue dropped on a
runtime restart, and an emission promise overwritten in a way that was correct
only by accident. One commit per task would have meant shipping known bugs.

Two more reported and not fixed, both worth their own rows: `hooks.md:325` says
command hooks receive their JSON on stdin, and the direct fallback
`runHookCommand` spawns with `stdio: ['ignore', …]`, so on the Claude and Codex
backends every documented `input=$(cat)` script reads empty. And the Codex
adapter carries the identical agent-hook defect — deliberately left alone,
because that adapter's format is empirical rather than doc-backed, and guessing
at it is precisely how the invented-field bug started.

**Closed 2026-07-29 as S12 — and with it the whole phase-4 sweep, 10 of 10.**
`c563aae8`, `31154607`, `813fd3fe`.

**The executor measured what the platform can express instead of assuming it**,
by running `sandbox-exec` against its own compiler:

```
(remote ip "github.com:443")   → host must be * or localhost in network address
(remote ip "140.82.121.4:443") → host must be * or localhost in network address
(remote host "github.com")     → unbound variable: host
```

**Domain filtering is not expressible in Seatbelt, and neither is an IP
literal.** That is the finding, and it kills the obvious fallback — resolve the
domain, pin the address — which would have been *exactly* the rule-that-does-
nothing this unit existed to remove, silently voided by CDN rotation and DNS TTL.

So the honest implementation is the one bit that is expressible, made loud:
`allowManagedDomainsOnly` becomes a total egress deny on all three platforms, and
`deniedDomains` alone **cannot bind** — open egress plus a per-entry diagnostic
in the log, on the isolation receipt, and in `doctor`, which exits non-zero.
Denying everything in answer to a three-entry deny list would have been worse
than useless. Per-platform the setting binds on macOS, Linux and Windows, to the
same single bit on each; there is no platform where it silently no-ops.

**My Task 1 gate was not achievable as written.** I asked for "a denied
destination refused and an allowed one permitted", which cannot be a *destination*
test when destinations are inexpressible. The executor ran the real gate with the
policy as the variable instead: permitted without the lock, `Operation not
permitted` with it, against a local listener it started. No external host touched.

**The default is untouched** and byte-identical with no `sandbox.network` key,
asserted in both directions. One judgement call surfaced rather than taken:
`allowManagedDomainsOnly: true` **with a non-empty allowlist** is enforced as
deny-all, which is tighter than the administrator asked; the alternatives were
open egress or refuse-to-start. Nothing can depend on today's behaviour because
the key binds nothing today.

**Two new findings out of scope, both worth acting on:**

- **`sandbox.network` wildcards are documented and never match.** `settings.md`
  gives both `allowedDomains` and `deniedDomains` wildcard syntax, and
  `matchesDomain` in `network-address-guard.ts` does exact-or-subdomain matching
  only — `*.evil.example` matches nothing. On the **deny** side that is
  under-enforcement in the one consumer that does enforce.
- **`resolveProcessIsolation({ platform: 'linux' })` does not simulate Linux.**
  The isolation appliers dispatch on the real `process.platform`, so on a macOS
  host the Linux path lands on `sandbox-exec` and double-wraps. Pre-existing, and
  worth knowing before anyone writes another cross-platform isolation test.

And a consequence of the seatbelt wildcard the owner reaffirmed today: the
**Claude backend's** Bash wrapper returns `(allow default)` before any profile is
composed, so `sandbox.network` reaches the Pi supervised-process path and nothing
else. The executor recorded that rather than wiring inert code into a wildcarded
profile.

The ambient-read finding was **re-probed rather than copied**: Chrome cookies,
`~/.docker/config.json` and `~/.gitconfig` readable; `~/.ssh`, `~/.aws` and
`~/.nessy` blocked. A credible read floor would need an allowlist posture —
browser profile stores, container and cloud CLI configs, shell history and
token-bearing dotfiles are unbounded as a deny list.

**First run in the series where the known-failing list was neither short nor
long**: four observed, four reproduced at base, none extra.

### `plugin-marketplaces.md` — no source policy, and a silent directory substitution

Two controls absent. There is no `strictKnownMarketplaces`/`blockedMarketplaces`
analogue: `RegistrySourceService.add` performs no policy check before staging, so
on a managed fleet a user can add any marketplace source and we clone and browse
it. `allowedPluginKeys` gates plugin **keys** at use time, not marketplace
**sources** at add time — an admin cannot express "only our internal GitLab".
Claude checks its allowlist "before any network or filesystem operation" and
re-checks on install, update and refresh.

Second, `metadata.pluginRoot` is unsupported, which is a directory-substitution
vector *inside* a marketplace repo: with `pluginRoot: "./plugins"` and
`source: "formatter"`, Claude installs `<root>/plugins/formatter` and we install
`<root>/formatter`. Anyone who can land a top-level directory in the marketplace
repo — a pull request to a public marketplace — shadows the intended plugin, and
we emit no diagnostic at all.

Beyond security, the headline finding: we implement only the **source** half of
the entry contract. `strict`, the six component fields, `version`, `description`,
`metadata.pluginRoot` and `renames` are all dropped before any consumer, so a
`strict: false` entry — where the doc says the marketplace entry **is** the
plugin definition — installs a plugin with zero capabilities and zero
diagnostics.

**Closed 2026-07-29 as S9**: `d3052d97`, `2db6da7a`, `81d7fef0`, `833cd91f`,
`750a482e`, plus `2e809923`.

**The executor's API stream died after its last edits and before it could commit
or report them.** The work was finished; the reporting was not. I verified the
uncommitted tree myself rather than discarding it — `typecheck:all` clean, `lint`
0 errors, plugins and marketplace suites 672 pass / 1 skip / 0 fail,
`git diff --check` clean — and committed it as `2e809923` with that provenance in
the message. Two of the diagnostics that looked like a broken tree (a syntax
error past the end of a file, three type errors in `claude.ts`) were snapshots
taken mid-write and did not survive a real typecheck. **A stalled agent is not
the same as a broken tree, and the difference is one command.**

The substance of that last commit is a distinction the plan did not draw: only an
**authority's** declaration displaces a default component directory, while a
marketplace entry that merely *supplements* the manifest adds its paths after the
default rather than instead of it. That is the difference between `strict` and
non-`strict` expressed in the resolver, and getting it backwards would have made
every supplementing entry silently drop a plugin's own components.

Also carried: two readers of a persisted entry's `fields` are now guarded,
because an installed record written by an older build reaches them without it.
Back-compat on a persisted shape is the kind of thing a plan written against the
current schema does not think to ask for.

### `modifying-system-prompts.md` / `output-styles.md` — an opened repo edits your system prompt

`outputStyleId` is stored app-globally but resolved by a **working-directory-first**
search. Proven by execution: opening a repository that ships an output style with
the same id substitutes its prose for the one the user chose elsewhere, and that
prose lands in the system prompt.

Separately, `keep-coding-instructions` has zero readers, so an output style can
never drop the engineering guidance `getSafetyAndEngineeringSections` composes
unconditionally — which makes the page's core use, being something other than a
software engineer, unreachable. Our preset/append composition on the Claude path
is otherwise fully conformant.

**A correction to my own tracker**: the R29 fork row's premise that we have no
output-style concept is **factually wrong**. We have a real, live one on Pi. The
fork question is therefore not "do we have styles" but "does a fork inherit the
style while a named subagent does not", and that is one gated read at
`pi-agent.ts:6123`.

**Closed 2026-07-29 as S11**: `6a2ea544`, `1346c781`, `282a10b4`.

**My plan had the order of its own two tasks backwards in a way that mattered.**
It presented the frontmatter fix and the trusted-root fix as independent. They
compound: the mutation probe's own failure output shows that with the trust gate
removed, an untrusted repository's style rendered `## Safety` — meaning Task 1
shipped *without* Task 2 would have let a merely-opened repository **subtract the
engineering guidance** as well as substitute prose. Task 1 before Task 2 is
strictly worse than the status quo. The plan should have said the order is
load-bearing; it did not.

**And the contract is stronger than I wrote it.** The documented default for
`keep-coding-instructions` is **`false`** — silence subtracts. So conforming is
not additive: every custom style a user already has loses the built-in
engineering guidance on upgrade. My §1 read as though only an explicit `false`
mattered.

**Safety and engineering were not separable at section granularity**, which is
what my plan assumed. `### Writing Code` mixes coding bullets with "Never log,
print, commit, or paste secrets, tokens, private keys, or user credentials", so a
section-level partition would have dropped the secrets rule along with the coding
rules — the exact failure the plan's gate was written to catch, arriving through
the fix rather than the bug. Split at **bullet** granularity instead, five
bullets tagged, `### Git` untagged in full because every bullet there bounds an
irreversible or externally visible action. Default rendering verified
byte-identical against the pre-change template.

The trusted-root rule is three roots, later wins: user `CONFIG_DIR/output-styles`
(**new** — and its absence is the sharper statement of the original defect, since
an app-global selection had no app-global directory to resolve from, which is
*why* the working directory was load-bearing), then workspace, then project
**only when `projectTrusted`**. That gate is the same one project agent
definitions already use, so a trusted project still outranks the workspace
exactly as its agents do.

**Two doors this unit does not close, both recorded rather than faked:** on the
Claude backend our whole prompt is an `append` to the `claude_code` preset, and
an append cannot subtract the preset's own coding guidance — so
`keep-coding-instructions: false` is partial there. And we pass
`settingSources: ['user','project','local']` to that SDK, so an opened
repository's own `.claude/settings.local.json` can set `outputStyle` and the SDK
honours it inside the preset, whatever our resolver decides.

**The same defect is live in a sibling the plan did not scope.**
`slash-commands/custom-commands.ts` carries a byte-for-byte copy of the old
working-directory-first search, so an opened repository can shadow a user's
`/command` body. Same attack, different surface.

Correction to the sweep's own arithmetic: `modifying-system-prompts.md` yields
**6** real rows, not the 14 the sweep counted — the rest is already conformant or
informational. The preset/append composition was re-confirmed conformant by
reading `buildClaudeTurnShapeOptions` rather than by trusting the earlier pass.

### `model-config.md` — a managed model allowlist that enforces nothing

`availableModels` and `enforceAvailableModels` are parsed, validated,
fail-closed-on-invalid and unit-tested. Their two resolvers,
`isManagedModelAllowed` and `resolveManagedDefaultModel`, have **zero production
callers** — only the policy's own test file invokes them. An enterprise
administrator restricting which models T-Bank users may run gets a policy that
loads without error, emits no drop diagnostic, and enforces nothing. Every model
stays selectable and every model reaches the gateway.

That is worse than an unimplemented setting, because the admin has positive
evidence the restriction took. Already tracked at
`2026-07-29-inert-worklist.md:69` with the owner's rejected-fix note — this pass
raises its severity rather than discovering it.

The page's headline finding is separate: `model-config.md` defines skill and
subagent frontmatter `effort` as an **override** of the session level, and our Pi
subagent path implements it as a downward-only **clamp** — a subagent can never
think harder than its parent, and inherits `off` outright when the parent level
is unset. The skill half of that same sentence is implemented correctly, so the
two halves of one rule disagree inside our own codebase, with the skill path
(`base-agent.ts:2281`) available as the reference implementation.

**Closed 2026-07-29 as S6**: `46cf2374`, `50357500`, `7d2bd2db`, `8a6db44d`.

Eighteen enforcement points moved, from the session model authority down through
subagents, skills, the guardian judge, the mini and summarization tiers and the
gateway `fast` alias. The mutation probe — forcing the allowlist predicate to
`true` — fails **18 tests** across every one of those tiers.

**Three of the executor's seven corrections were to my plan's core advice, and
two of them would have shipped a bug.**

1. **"Filter at the read boundary" was not a safe enough rule, and I thought it
   was the whole safety argument.** `getLlmConnections()` *is* a read boundary,
   and filtering there still destroys data — the round trip is not through a
   writer but through the **renderer**: `LIST_WITH_STATUS` hands out whole
   records, and a vision toggle strips three status fields and posts the rest
   back to `SAVE`. One vision toggle under a narrowed list would permanently
   delete the excluded models. The genuinely safe boundary is
   `resolveSessionConnection`/`createBackendFromConnection`, which nothing writes
   back.
2. **`models.filter(isManagedModelAllowed)` bricks the client, and my "follow
   whatever the parse side decided" would have produced exactly that.** An
   invalid `availableModels` parses to `[]`, so the predicate returns `false` for
   every model — while `settings.md:196` and `model-config.md:205`/`:207` all
   require the Default to survive. One typo in a fleet-wide push would have left
   every client with zero models.
3. **My mid-session premise was simply wrong.** I posed a dilemma about a policy
   arriving mid-session through R25b's delivery path. It can arrive but cannot
   take effect: `resolveEnforcedManagedPolicy()` runs exactly once, in
   `createStorageRuntime`, and nothing recomposes it. The real split, which the
   docs settle, is `/model` (refuse) versus an inherited override (substitute).

Two more worth keeping: `resolveManagedDefaultModel` returning `undefined` means
"enforcement skipped", not "no model" — a caller reading it as absence locks the
user out of everything; and the resolver matched with `includes`, so an
administrator writing `claude-sonnet-4-5` matched **nothing** against the shipped
`claude-sonnet-4-5-20250929`. Version-prefix matching at a `-` boundary was
added; family aliases (`sonnet`) were deliberately left out and costed, because
half of `model-config.md:256`'s rule *widens* an allowlist, and widening is the
one direction an allowlist must never move by accident.

**The executor caught itself committing this audit's own defect.** Its Task 1–2
diff shipped `getManagedModelPolicy` with no caller at all and
`hasManagedModelAllowlist` with only test callers, plus a re-export barrel
nothing reached through. It removed them in a fourth commit — deviating from
one-commit-per-task and saying so. A zero-caller export in the unit named after
zero-caller code is the kind of thing that gets rationalised; it was not.

Proof against the named hazard is a subprocess test that drives the **actual
destruction path**: with the policy active, take what `getLlmConnections()`
returns, push it through `updateLlmConnection` exactly as the renderer does, then
withdraw the policy. All three models survive on disk. Both withdrawal tests go
red under the mutation, so neither is a tautology.

Left costed, not built: hiding excluded models from the picker
(`model-config.md:171`) — ours still lists them and refuses on selection with a
translated message, which `model-config.md:201` explicitly blesses as an interim
state ("the picker state is a convenience for users; enforcement happens in the
session").

**Closed 2026-07-29 as S10**: `aebf72db`, `b9aef019`, `cd132544`.

All four sites reproduced. The resolved table now has a child asking for `max`
under a `low` parent getting `max` (it got `low`), and an unset parent no longer
forcing `off`. Skill path, subagent spawner, fork path and the plugin-hook runner
share **one** resolver; the per-model clamp is a separate function applied after,
never folded in — which matters, because folding them is how "override" became
"clamp" in the first place. Mutation probe: restoring the `Math.min` fails 15
tests.

**The sharpest correction is one I had settled too easily.** My plan treated
"override in both directions" as decided by a single sentence. It is decided by
*choosing between two*: `sub-agents.md` says thinking on/off **inherits** and
"There is no per-subagent thinking setting", while the frontmatter row says
`effort` **overrides**. In Claude those are two axes and `off` is not on the
effort scale at all; in Nessy `off` is a level below `low`, so the two sentences
cannot both hold here. The executor followed the override sentence, matching the
reference skill path, and recorded the conflation as a register row rather than
pretending the conflict away.

**One of its corrections was itself wrong, and I checked.** It reported that
`sub-agents.md:1052`'s "A fork can't spawn further forks" had been **removed**
from the page, which would mean our unconditional no-nested-fork rule rests on a
sentence that no longer exists — a change worth making. It has not been removed.
It is the **last sentence of that same line 1052**, whose first half is the
`CLAUDE_CODE_FORK_SUBAGENT` text the executor quoted as replacing it. Verified by
re-fetching. The rule stands as cited.

That is the first executor correction in this series that verification overturned,
and it is the argument for the rule that produced it: the highest-consequence
claim gets checked first-hand, in both directions. Nine reports in a row were
right about my errors; this one was wrong about the docs, and only re-fetching
told them apart.

**Citation drift, measured.** `skills.md` gained six lines above its frontmatter
table: `effort` moved `:262` → `:268` and `paths` `:267` → `:273`. We cite the
old numbers **16 and 13 times** across the repo — 29 stale line references. Not
load-bearing while each carries its quotation, which is exactly why the standing
rule makes the quotation the identifier; but any citation that carries only a
number is now wrong. Folded into the `docs/` audit rather than mass-edited, since
a mass re-citation decays again on the next upstream edit.

### `file-checkpointing.md` — rewind writes through hard links

Our Pi checkpoint/rewind conforms to the core contract: tracked tool set,
pre-image backup, create-delete and modify-restore, conversation untouched,
subagent and bash exclusions. It is missing the entire v2.1.216 link-safety
layer, and a probe confirmed rewind writes the pre-image **straight through a
hard link**, mutating inode aliases the filesystem scope cannot see.
`readFileState` uses `stat` + `isFile()`, which follows symlinks and cannot see
hard links; there is no `lstat`, no `nlink` check, and no parent-directory
re-resolution — we do the opposite, recreating a missing parent with `mkdir`.

**Closed 2026-07-29 as S7**: `395efafb`, `b2f183c1`, `534d677b`.

The pre-fix probe is the whole finding in three lines: alias BEFORE
`"post-image"` → rewind returns `{"success":true,"restored":true}` → alias AFTER
`"pre-image"`. A corrupted inode, reported as a successful restore. After: the
rewind refuses, `skippedLinks: 1`, and the alias is byte-identical on both sides.

**My plan had a real design error and the executor caught it.** I named `lstat`
as the guard. `lstat` alone is a time-of-check-to-time-of-use race and would have
shipped one. The fix is two layers: the `lstat` pre-check, plus opening with
`O_WRONLY|O_CREAT|O_NOFOLLOW` and re-checking `nlink` with `fstat` on the
descriptor actually held. The old `copyFile` had neither — it opened the
destination with `O_TRUNC` and rewrote whatever inode the name resolved to. The
mutation probe proves the layers are independent: neutralising only the `lstat`
guard leaves the restore hazards caught at open time, and only the delete branch
goes red.

**The sharpest correction is about testing, not code.** Built naively, the hazard
matrix produces green tests that prove nothing: for the symlink-at-tracked-path
and parent-replaced-by-symlink cases, the decoy's content must equal the
**post-image**, or the pre-existing digest-conflict check refuses first and the
test passes without ever exercising link safety. That is a false-green that would
have survived review — the assertion is right, the fixture never reaches the code
under test.

Two more that my plan missed outright: `packages/shared/src/protocol/dto.ts`
carries a **second, independent** `FileCheckpointRevertResult` that must be
widened by hand or the new fields are silently dropped at the IPC boundary; and
the documented shape is **not on the page my plan named** — `file-checkpointing.md`
only names `skippedLinks` and links out, while the reason taxonomy and the
`dryRun` carve-out live in `agent-sdk/typescript.md`'s `RewindFilesResult`.
Fetching only my named page would have left both unseen.

Skip semantics resolved deliberately: at a single checkpoint a skip **is** whole
refusal (`success: false`, nothing written), because reporting success would be
the lie the unit exists to remove; across a multi-file rewind it is partial with
a report, because aborting every remaining file lets one planted link block
recovery entirely, and `skippedLinks` being a *count* in the documented shape
only makes sense if the rewind proceeds past the first skip. `skippedPaths`
carries file and reason beside the count, since a bare count says "1 file
untouched" without saying which or why.

**Routed to R29:** a Pi child — fork included — is its own session with its own
`sessionPath`, so a parent's rewind never reaches it. That is the right outcome
for a named subagent and the wrong one for a fork, which by contract shares the
parent's conversation. R29b should decide it.

### `hooks-guide.md` — two canonical recipes are dead on Pi

Against a hook layer this series has now audited four times, the companion page
found three holes no prior unit recorded: raw non-JSON stdout does not become
model context on `UserPromptSubmit`/`SessionStart`, `SessionStart` never fires
with `source: "compact"` after compaction, and the documented `type: "agent"`
hook shape is rejected outright at import. The guide's two canonical
context-injection recipes are therefore both dead on our shipped backend.

The layer is otherwise unusually conformant — the whole `if`-filter truth table
reproduces 5 of 5.

One divergence worth naming because it runs the other way: `additionalContext` at
the **top level** of a hook's JSON output is documented as ignored, and we read
it (`hook-command.ts:266`, `?? parsed.additionalContext`). Probe-executed. We are
more permissive than the contract, which is a smaller problem than being less
permissive, but it is still a divergence and it exists only because this sentence
appears on the companion page and nowhere in the reference.

---

## A third instance of the same lesson, from R16 (2026-07-29)

R16 was written expecting the answer "the Codex plugin format has no published
specification, so our adapter is empirical." **That premise was false**, and our
own `AGENTS.md` is why nobody had looked. It said the Codex help article "is not
publicly fetchable, so `github.com/openai/plugins` and real manifests are the
practical contract."

Half of that is true and it poisoned the other half. I verified both halves
myself: `help.openai.com/.../plugins-in-codex/` really does return **403**, and
`developers.openai.com/plugins/build/plugins.md` returns **200 with 23 KB of
manifest specification**, `learn.chatgpt.com/docs/hooks.md` **200 with 39 KB of
hook specification**. One dead URL had been generalised into "no spec exists",
written into our own contract file, and believed for months.

Three documented shapes were silently broken as a result, and I confirmed the
fix by driving the real adapter: a `.mcp.json` wrapped as `mcp_servers` — **the
doc's own example** — produced zero servers and a bogus warning; `hooks` as an
array of paths produced zero hooks and a warning; the default `hooks/hooks.json`
produced zero hooks **silently**. All three now read correctly.

**The pattern is now three-for-three**: this audit's blind spots have not been
hard problems, they have been *unasked questions*. The row list was not a
complete index of the contract; the pages nobody cited held a missing safety
floor and two fail-open locks; and a sentence in our own guide turned one
HTTP 403 into a year of "there is nothing to conform to."

The executor also closed a row I had left open as unfalsifiable — the Codex
agent-hook defect S8 deliberately did not copy Claude's fix onto. There is no
field name to get wrong: the hook spec documents exactly one handler type,
`command`, and **zero** of the 180 real manifests declare any hook at all. Our
`prompt`/`agent`/`http`/`mcp_tool` branches are Nessy extensions, so they cannot
diverge from a Codex contract. Copying Claude's fallback would have invented a
field — precisely the failure S8 feared.

And a practice-versus-spec conflict was resolved deliberately rather than
silently: the docs put plugin hooks at `hooks/hooks.json`, and **no plugin in
`openai/plugins` has that file** — the only two real hook files sit at the plugin
root, undeclared, so under the documented rule neither would ever load. Both are
now read, with the reason recorded at the constant.

---

## What this says about the audit

Eight pages, eight `gaps-found`, several of them security-severity, on subjects
where we had already shipped code and in two cases already closed parity rows.
The pages were not obscure: `AGENTS.md` names three of them in its own contract
table.

The lesson is the same one the weekly-changelog pass produced this morning and it
is now confirmed twice. This audit's method — take a row, read the page it names,
compare to code — is sound but **the row list was never a complete index of the
contract**. Coverage was bounded by what someone had already thought to write a
row about. Reading the pages nobody had cited found, in one pass, a missing
safety floor, a fail-open managed denylist, and a managed model allowlist that
enforces nothing.

---

## New rows and their order

Recommended, highest consequence first:

1. **S4 — removal circuit breaker.** Dispatched.
2. **Managed MCP entry schema.** Replace the name-only string lists with the
   documented discriminated entries; thread transport/URL/command into
   `isManagedMcpServerAllowed`, which today receives only a name; keep a
   compatibility read for the bare-string form.
3. **Sandbox network half.** `sandbox.network` has correct floor semantics and
   one consumer that is not the shell. Either wire it or state the owner
   decision as a category string — the current state claims a control we do not
   apply.
4. **Managed model allowlist enforcement.** Two resolvers, zero callers, and an
   owner note already on file; this pass argues the note should be revisited.
5. **Marketplace entry as component authority.** Split from the existing
   "Marketplace schema and lifecycle" row: `strict`, the six component fields,
   `metadata.pluginRoot`, entry `version`/`description`.
6. **Marketplace source policy.** The `strictKnownMarketplaces` analogue, checked
   before the clone.
7. **Hook context-injection channel.** Raw stdout as context, `SessionStart`
   after compaction, `type: "agent"` hooks.
8. **Output-style frontmatter and resolution.** `keep-coding-instructions`, the
   trusted-root fix for the shadowing, and the fork/named-subagent gate — the
   last of which must land with R29's fork work, not independently of it.
9. **Rewind link safety.** `lstat`, `nlink > 1`, parent re-resolution, and a
   `skippedLinks` count surfaced to the user.
10. **Effort precedence on Pi.** Four sites that must move together, with the
    conformant skill path as the reference.
